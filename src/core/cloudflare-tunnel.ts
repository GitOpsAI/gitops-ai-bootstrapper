import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Cloudflare Tunnel + Access provisioning (bootstrap-only API token)
//
// Required token permissions:
//   Account → Cloudflare Tunnel: Edit
//   Account → Access: Apps and Policies: Edit
//   Account → Access: Organizations, Identity Providers, and Groups: Read
//   Zone    → Zone: Read, DNS: Edit
// The token is used once from the operator's machine and never stored in the cluster.
// ---------------------------------------------------------------------------

const API_BASE = "https://api.cloudflare.com/client/v4";
const REQUEST_TIMEOUT_MS = 30_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_DOMAIN_RE = /^@[a-z0-9.-]+\.[a-z]{2,}$/i;

export type FetchFn = typeof fetch;

export const CLOUDFLARE_SETUP_TOKEN_PERMISSIONS = [
  "Account → Cloudflare Tunnel: Edit",
  "Account → Access: Apps and Policies: Edit",
  "Account → Access: Organizations, Identity Providers, and Groups: Read",
  "Zone → Zone: Read",
  "Zone → DNS: Edit",
];

export class CloudflareApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CloudflareApiError";
  }
}

interface CfEnvelope<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
}

interface CfZone {
  id: string;
  name: string;
  account: { id: string };
}

interface CfTunnel {
  id: string;
  name: string;
}

interface CfDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
}

interface CfAccessApp {
  id: string;
  name: string;
  domain: string;
  aud: string;
}

interface CfAccessOrganization {
  auth_domain: string;
}

interface TunnelTokenPayload {
  a: string;
  t: string;
  s: string;
}

export interface TunnelProvisionInput {
  apiToken: string;
  clusterName: string;
  clusterDomain: string;
  /** Emails (`user@example.com`) or whole email domains (`@example.com`) allowed through Access. */
  accessAllowed: string[];
  /** App subdomains whose explicit DNS records would shadow the wildcard (checked, not changed). */
  componentSubdomains?: string[];
  fetchFn?: FetchFn;
}

export interface TunnelProvisionResult {
  tunnelId: string;
  tunnelName: string;
  /** cloudflared `credentials-file` content: `{AccountTag, TunnelSecret, TunnelID}`. */
  credentialsJson: string;
  accessTeam: string;
  accessAud: string;
  zoneName: string;
  tunnelCreated: boolean;
  warnings: string[];
}

function client(token: string, fetchFn: FetchFn) {
  return async function request<T>(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetchFn(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    let payload: CfEnvelope<T> | undefined;
    try {
      payload = (await res.json()) as CfEnvelope<T>;
    } catch {
      /* non-JSON error page */
    }

    if (!res.ok || !payload?.success) {
      const detail =
        payload?.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") ||
        `HTTP ${res.status}`;
      throw new CloudflareApiError(
        `Cloudflare API ${method} ${path.split("?")[0]} failed — ${detail}`,
        res.status,
      );
    }
    return payload.result;
  };
}

type Request = ReturnType<typeof client>;

export function tunnelNameForCluster(clusterName: string): string {
  return `gitops-ai-${clusterName}`;
}

/** `a.b.example.com` → `["a.b.example.com", "b.example.com", "example.com"]`. */
export function zoneCandidates(domain: string): string[] {
  const labels = domain.toLowerCase().replace(/\.$/, "").split(".");
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) {
    out.push(labels.slice(i).join("."));
  }
  return out;
}

export function parseAccessAllowed(raw: string): string[] {
  return [...new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  )];
}

export function accessAllowedInputError(raw: string): string | undefined {
  const entries = parseAccessAllowed(raw);
  if (entries.length === 0) return "At least one email or @domain is required";
  const invalid = entries.filter((e) => !EMAIL_RE.test(e) && !EMAIL_DOMAIN_RE.test(e));
  if (invalid.length > 0) return `Invalid entries: ${invalid.join(", ")}`;
  return undefined;
}

export function accessIncludeRules(
  allowed: string[],
): ({ email: { email: string } } | { email_domain: { domain: string } })[] {
  return allowed.map((entry) =>
    entry.startsWith("@")
      ? { email_domain: { domain: entry.slice(1) } }
      : { email: { email: entry } },
  );
}

/** Decodes the `cloudflared tunnel token` (base64 JSON `{a, t, s}`) into a credentials file. */
export function credentialsFromTunnelToken(token: string, expectedTunnelId: string): string {
  let payload: TunnelTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(token, "base64").toString("utf-8")) as TunnelTokenPayload;
  } catch {
    throw new Error("Cloudflare returned a tunnel token that is not valid base64 JSON");
  }
  if (!payload.a || !payload.s || payload.t !== expectedTunnelId) {
    throw new Error("Cloudflare tunnel token does not match the requested tunnel");
  }
  return JSON.stringify({
    AccountTag: payload.a,
    TunnelSecret: payload.s,
    TunnelID: payload.t,
  });
}

async function resolveZone(request: Request, domain: string): Promise<CfZone> {
  for (const name of zoneCandidates(domain)) {
    const zones = await request<CfZone[]>(
      "GET",
      `/zones?${new URLSearchParams({ name, status: "active" })}`,
    );
    if (zones.length > 0) return zones[0];
  }
  throw new Error(
    `No active Cloudflare zone found for ${domain}. ` +
      "Add the domain to Cloudflare and make sure the token has Zone:Read on it.",
  );
}

async function resolveAccessTeam(request: Request, accountId: string): Promise<string> {
  let org: CfAccessOrganization;
  try {
    org = await request<CfAccessOrganization>(
      "GET",
      `/accounts/${accountId}/access/organizations`,
    );
  } catch (err) {
    throw new Error(
      "Cloudflare Zero Trust is not set up for this account (or the token lacks Access read). " +
        "Open https://one.dash.cloudflare.com, pick a team name and the Free plan, then re-run bootstrap.\n" +
        (err as Error).message,
    );
  }
  const team = org.auth_domain?.replace(/\.cloudflareaccess\.com$/i, "");
  if (!team) throw new Error("Cloudflare Zero Trust organization has no team domain");
  return team;
}

async function ensureTunnel(
  request: Request,
  accountId: string,
  tunnelName: string,
): Promise<{ tunnel: CfTunnel; created: boolean }> {
  const existing = await request<CfTunnel[]>(
    "GET",
    `/accounts/${accountId}/cfd_tunnel?${new URLSearchParams({ name: tunnelName, is_deleted: "false" })}`,
  );
  if (existing.length > 0) return { tunnel: existing[0], created: false };

  const tunnel = await request<CfTunnel>("POST", `/accounts/${accountId}/cfd_tunnel`, {
    name: tunnelName,
    config_src: "local",
    tunnel_secret: randomBytes(32).toString("base64"),
  });
  return { tunnel, created: true };
}

async function ensureWildcardRecord(
  request: Request,
  zoneId: string,
  clusterDomain: string,
  tunnelId: string,
  clusterName: string,
): Promise<void> {
  const name = `*.${clusterDomain}`;
  const records = await request<CfDnsRecord[]>(
    "GET",
    `/zones/${zoneId}/dns_records?${new URLSearchParams({ name })}`,
  );
  const conflicting = records.filter((r) => r.type !== "CNAME");
  if (conflicting.length > 0) {
    throw new Error(
      `DNS record(s) ${conflicting.map((r) => `${r.type} ${r.name}`).join(", ")} already exist. ` +
        "Delete them in the Cloudflare dashboard so the wildcard can point to the tunnel.",
    );
  }

  const body = {
    type: "CNAME",
    name,
    content: `${tunnelId}.cfargotunnel.com`,
    proxied: true,
    ttl: 1,
    comment: `gitops-ai cloudflare-tunnel (${clusterName})`,
  };
  const cname = records.find((r) => r.type === "CNAME");
  if (cname) {
    await request("PUT", `/zones/${zoneId}/dns_records/${cname.id}`, body);
  } else {
    await request("POST", `/zones/${zoneId}/dns_records`, body);
  }
}

async function shadowingRecords(
  request: Request,
  zoneId: string,
  clusterDomain: string,
  subdomains: string[],
): Promise<string[]> {
  const found: string[] = [];
  for (const sub of subdomains) {
    const records = await request<CfDnsRecord[]>(
      "GET",
      `/zones/${zoneId}/dns_records?${new URLSearchParams({ name: `${sub}.${clusterDomain}` })}`,
    );
    for (const r of records) found.push(`${r.type} ${r.name} → ${r.content}`);
  }
  return found;
}

async function ensureAccessApp(
  request: Request,
  accountId: string,
  clusterName: string,
  clusterDomain: string,
  allowed: string[],
): Promise<string> {
  const domain = `*.${clusterDomain}`;
  const body = {
    name: tunnelNameForCluster(clusterName),
    domain,
    type: "self_hosted",
    session_duration: "24h",
    app_launcher_visible: false,
    http_only_cookie_attribute: true,
    same_site_cookie_attribute: "lax",
    policies: [
      {
        name: "gitops-ai-allowed-users",
        decision: "allow",
        precedence: 1,
        include: accessIncludeRules(allowed),
      },
    ],
  };

  const apps = await request<CfAccessApp[]>("GET", `/accounts/${accountId}/access/apps`);
  const existing = apps.find((a) => a.domain?.toLowerCase() === domain.toLowerCase());
  const app = existing
    ? await request<CfAccessApp>("PUT", `/accounts/${accountId}/access/apps/${existing.id}`, body)
    : await request<CfAccessApp>("POST", `/accounts/${accountId}/access/apps`, body);

  if (!app.aud) throw new Error("Cloudflare Access application has no AUD tag");
  return app.aud;
}

/**
 * Idempotent: reuses the tunnel named `gitops-ai-<cluster>` and the Access app for
 * `*.<domain>`, and re-derives credentials from the tunnel token on every run.
 */
export async function provisionCloudflareTunnel(
  input: TunnelProvisionInput,
): Promise<TunnelProvisionResult> {
  const fetchFn = input.fetchFn ?? fetch;
  const request = client(input.apiToken, fetchFn);
  const tunnelName = tunnelNameForCluster(input.clusterName);
  const warnings: string[] = [];

  if (input.accessAllowed.length === 0) {
    throw new Error("Cloudflare Access needs at least one allowed email or @domain");
  }

  const zone = await resolveZone(request, input.clusterDomain);
  const accountId = zone.account.id;

  if (zone.name.toLowerCase() !== input.clusterDomain.toLowerCase()) {
    warnings.push(
      `${input.clusterDomain} is a subdomain of zone ${zone.name}. Cloudflare Universal SSL only covers ` +
        `*.${zone.name}, so *.${input.clusterDomain} needs an Advanced Certificate (paid) or the zone apex as cluster domain.`,
    );
  }

  const accessTeam = await resolveAccessTeam(request, accountId);
  const { tunnel, created } = await ensureTunnel(request, accountId, tunnelName);
  if (!UUID_RE.test(tunnel.id)) {
    throw new Error(`Unexpected tunnel id from Cloudflare: ${tunnel.id}`);
  }

  const token = await request<string>(
    "GET",
    `/accounts/${accountId}/cfd_tunnel/${tunnel.id}/token`,
  );
  const credentialsJson = credentialsFromTunnelToken(token, tunnel.id);

  // Access must guard *.<domain> before DNS routes anything to the tunnel.
  const accessAud = await ensureAccessApp(
    request,
    accountId,
    input.clusterName,
    input.clusterDomain,
    input.accessAllowed,
  );

  await ensureWildcardRecord(request, zone.id, input.clusterDomain, tunnel.id, input.clusterName);

  const shadows = await shadowingRecords(
    request,
    zone.id,
    input.clusterDomain,
    input.componentSubdomains ?? [],
  );
  if (shadows.length > 0) {
    warnings.push(
      `These records take precedence over the tunnel wildcard; delete them to route through the tunnel: ${shadows.join(", ")}`,
    );
  }

  return {
    tunnelId: tunnel.id,
    tunnelName,
    credentialsJson,
    accessTeam,
    accessAud,
    zoneName: zone.name,
    tunnelCreated: created,
    warnings,
  };
}
