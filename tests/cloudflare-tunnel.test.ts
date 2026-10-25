import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  accessAllowedInputError,
  accessIncludeRules,
  CloudflareApiError,
  credentialsFromTunnelToken,
  parseAccessAllowed,
  preflightCloudflareTunnel,
  provisionCloudflareTunnel,
  tunnelNameForCluster,
  zoneCandidates,
  type FetchFn,
} from "../src/core/cloudflare-tunnel.js";
import {
  includeOptInComponents,
  pruneDisabledComponents,
  renderCloudflaredConfig,
  useLetsencryptStaging,
} from "../src/core/bootstrap-runner.js";
import { isCodespaces, isHeadless, useK3d } from "../src/utils/platform.js";
import { LETSENCRYPT_STAGING_SERVER, TUNNEL_COMPONENT_ID } from "../src/schemas.js";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const ZONE_ID = "fedcba9876543210fedcba9876543210";
const TUNNEL_ID = "c1744f8b-faa1-48a4-9e5c-02ac921467fa";
const AUD = "a".repeat(64);
const TUNNEL_SECRET = Buffer.alloc(32, 7).toString("base64");

function tunnelToken(tunnelId = TUNNEL_ID): string {
  return Buffer.from(JSON.stringify({ a: ACCOUNT_ID, t: tunnelId, s: TUNNEL_SECRET })).toString("base64");
}

// ---------------------------------------------------------------------------
// Mock Cloudflare API
// ---------------------------------------------------------------------------

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
  authorization: string | null;
}

interface MockState {
  zones: { id: string; name: string; account: { id: string } }[];
  accessOrg: { auth_domain: string } | null;
  /** Path prefixes answered with 403, as for a token without that permission. */
  denied?: string[];
  tunnels: { id: string; name: string }[];
  accessApps: { id: string; name: string; domain: string; aud: string }[];
  dnsRecords: { id: string; type: string; name: string; content: string }[];
}

function defaultState(): MockState {
  return {
    zones: [{ id: ZONE_ID, name: "example.com", account: { id: ACCOUNT_ID } }],
    accessOrg: { auth_domain: "myteam.cloudflareaccess.com" },
    tunnels: [],
    accessApps: [],
    dnsRecords: [],
  };
}

function mockCloudflare(state: MockState) {
  const calls: Call[] = [];

  const json = (status: number, payload: unknown) =>
    new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  const ok = (result: unknown) => json(200, { success: true, errors: [], result });
  const fail = (status: number, code: number, message: string) =>
    json(status, { success: false, errors: [{ code, message }], result: null });

  const fetchFn: FetchFn = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.cloudflare.com");
    const path = url.pathname.replace(/^\/client\/v4/, "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const headers = new Headers(init?.headers);
    calls.push({ method, path, query: url.searchParams, body, authorization: headers.get("authorization") });

    const acct = `/accounts/${ACCOUNT_ID}`;
    const route = `${method} ${path}`;

    if (state.denied?.some((prefix) => path.startsWith(prefix))) {
      return fail(403, 10000, "Authentication error");
    }
    if (route === "GET /zones") {
      return ok(state.zones.filter((z) => z.name === url.searchParams.get("name")));
    }
    if (route === `GET ${acct}/access/organizations`) {
      return state.accessOrg
        ? ok(state.accessOrg)
        : fail(400, 9999, "access.api.error.not_enabled: Access is not enabled.");
    }
    if (method === "GET" && path.startsWith(`${acct}/access/`) && !state.accessOrg) {
      return fail(400, 9999, "access.api.error.not_enabled: Access is not enabled.");
    }
    if (route === `GET ${acct}/cfd_tunnel`) {
      return ok(state.tunnels.filter((t) => t.name === url.searchParams.get("name")));
    }
    if (route === `POST ${acct}/cfd_tunnel`) {
      const tunnel = { id: TUNNEL_ID, name: body.name };
      state.tunnels.push(tunnel);
      return ok(tunnel);
    }
    if (method === "GET" && path.startsWith(`${acct}/cfd_tunnel/`) && path.endsWith("/token")) {
      return ok(tunnelToken(path.split("/")[4]));
    }
    if (route === `GET ${acct}/access/apps`) return ok(state.accessApps);
    if (route === `POST ${acct}/access/apps`) {
      const app = { id: "app-1", name: body.name, domain: body.domain, aud: AUD };
      state.accessApps.push(app);
      return ok(app);
    }
    if (method === "PUT" && path.startsWith(`${acct}/access/apps/`)) {
      const app = state.accessApps.find((a) => a.id === path.split("/").at(-1));
      if (!app) return fail(404, 9999, "not found");
      Object.assign(app, { name: body.name, domain: body.domain });
      return ok(app);
    }
    if (route === `GET /zones/${ZONE_ID}/dns_records`) {
      return ok(state.dnsRecords.filter((r) => r.name === url.searchParams.get("name")));
    }
    if (route === `POST /zones/${ZONE_ID}/dns_records`) {
      const rec = { id: `rec-${state.dnsRecords.length + 1}`, type: body.type, name: body.name, content: body.content };
      state.dnsRecords.push(rec);
      return ok(rec);
    }
    if (method === "PUT" && path.startsWith(`/zones/${ZONE_ID}/dns_records/`)) {
      const rec = state.dnsRecords.find((r) => r.id === path.split("/").at(-1));
      if (!rec) return fail(404, 81044, "Record does not exist.");
      Object.assign(rec, { type: body.type, content: body.content });
      return ok(rec);
    }
    return fail(404, 7003, `No route for ${route}`);
  };

  return { fetchFn, calls };
}

const baseInput = {
  apiToken: "setup-token",
  clusterName: "homelab",
  clusterDomain: "example.com",
  accessAllowed: ["admin@example.com", "@corp.example"],
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("cloudflare-tunnel helpers", () => {
  it("names the tunnel after the cluster", () => {
    assert.equal(tunnelNameForCluster("homelab"), "gitops-ai-homelab");
  });

  it("lists zone candidates from the most to the least specific", () => {
    assert.deepEqual(zoneCandidates("A.b.Example.com."), ["a.b.example.com", "b.example.com", "example.com"]);
    assert.deepEqual(zoneCandidates("example.com"), ["example.com"]);
  });

  it("parses, normalises and de-duplicates allowed entries", () => {
    assert.deepEqual(parseAccessAllowed(" Admin@Example.com, @corp.example,,admin@example.com "), [
      "admin@example.com",
      "@corp.example",
    ]);
  });

  it("validates allowed entries", () => {
    assert.equal(accessAllowedInputError("admin@example.com, @corp.example"), undefined);
    assert.match(accessAllowedInputError("") ?? "", /At least one/);
    assert.match(accessAllowedInputError("admin@example.com, nobody, @bad") ?? "", /nobody, @bad/);
  });

  it("maps entries to Access include rules", () => {
    assert.deepEqual(accessIncludeRules(["a@example.com", "@corp.example"]), [
      { email: { email: "a@example.com" } },
      { email_domain: { domain: "corp.example" } },
    ]);
  });

  it("builds cloudflared credentials from the tunnel token", () => {
    assert.deepEqual(JSON.parse(credentialsFromTunnelToken(tunnelToken(), TUNNEL_ID)), {
      AccountTag: ACCOUNT_ID,
      TunnelSecret: TUNNEL_SECRET,
      TunnelID: TUNNEL_ID,
    });
  });

  it("rejects tokens for another tunnel or malformed tokens", () => {
    assert.throws(
      () => credentialsFromTunnelToken(tunnelToken("00000000-0000-0000-0000-000000000000"), TUNNEL_ID),
      /does not match/,
    );
    assert.throws(() => credentialsFromTunnelToken("%%%not-base64%%%", TUNNEL_ID), /not valid base64 JSON/);
  });
});

// ---------------------------------------------------------------------------
// Provisioning flow
// ---------------------------------------------------------------------------

describe("provisionCloudflareTunnel", () => {
  it("creates tunnel, Access app and wildcard CNAME on a fresh account", async () => {
    const state = defaultState();
    const { fetchFn, calls } = mockCloudflare(state);

    const result = await provisionCloudflareTunnel({ ...baseInput, fetchFn });

    assert.equal(result.tunnelId, TUNNEL_ID);
    assert.equal(result.tunnelName, "gitops-ai-homelab");
    assert.equal(result.tunnelCreated, true);
    assert.equal(result.accessTeam, "myteam");
    assert.equal(result.accessAud, AUD);
    assert.equal(result.zoneName, "example.com");
    assert.deepEqual(result.warnings, []);
    assert.equal(JSON.parse(result.credentialsJson).TunnelID, TUNNEL_ID);

    assert.ok(calls.every((c) => c.authorization === "Bearer setup-token"));

    const createTunnel = calls.find((c) => c.method === "POST" && c.path.endsWith("/cfd_tunnel"));
    assert.equal(createTunnel?.body.config_src, "local");
    assert.equal(Buffer.from(createTunnel?.body.tunnel_secret, "base64").length, 32);

    const appCall = calls.find((c) => c.method === "POST" && c.path.endsWith("/access/apps"));
    assert.equal(appCall?.body.domain, "*.example.com");
    assert.equal(appCall?.body.type, "self_hosted");
    assert.equal(appCall?.body.http_only_cookie_attribute, true);
    assert.deepEqual(appCall?.body.policies[0].include, [
      { email: { email: "admin@example.com" } },
      { email_domain: { domain: "corp.example" } },
    ]);

    assert.deepEqual(state.dnsRecords, [
      { id: "rec-1", type: "CNAME", name: "*.example.com", content: `${TUNNEL_ID}.cfargotunnel.com` },
    ]);
    const dnsCall = calls.find((c) => c.method === "POST" && c.path.endsWith("/dns_records"));
    assert.equal(dnsCall?.body.proxied, true);
  });

  it("creates the Access app before any DNS record", async () => {
    const { fetchFn, calls } = mockCloudflare(defaultState());
    await provisionCloudflareTunnel({ ...baseInput, fetchFn });

    const accessIdx = calls.findIndex((c) => c.method === "POST" && c.path.endsWith("/access/apps"));
    const firstDnsWrite = calls.findIndex(
      (c) => c.method !== "GET" && c.path.includes("/dns_records"),
    );
    assert.ok(accessIdx >= 0 && firstDnsWrite > accessIdx);
  });

  it("is idempotent: reuses the tunnel, updates the Access app and the CNAME", async () => {
    const state = defaultState();
    const first = mockCloudflare(state);
    await provisionCloudflareTunnel({ ...baseInput, fetchFn: first.fetchFn });

    const second = mockCloudflare(state);
    const result = await provisionCloudflareTunnel({ ...baseInput, fetchFn: second.fetchFn });

    assert.equal(result.tunnelCreated, false);
    assert.equal(result.tunnelId, TUNNEL_ID);
    assert.equal(state.tunnels.length, 1);
    assert.equal(state.accessApps.length, 1);
    assert.equal(state.dnsRecords.length, 1);
    assert.ok(!second.calls.some((c) => c.method === "POST"));
    assert.ok(second.calls.some((c) => c.method === "PUT" && c.path.includes("/access/apps/app-1")));
    assert.ok(second.calls.some((c) => c.method === "PUT" && c.path.includes("/dns_records/rec-1")));
  });

  it("refuses to replace a non-CNAME wildcard record", async () => {
    const state = defaultState();
    state.dnsRecords.push({ id: "rec-a", type: "A", name: "*.example.com", content: "203.0.113.10" });
    const { fetchFn } = mockCloudflare(state);

    await assert.rejects(provisionCloudflareTunnel({ ...baseInput, fetchFn }), /A \*\.example\.com already exist/);
    assert.equal(state.dnsRecords.length, 1);
    assert.equal(state.dnsRecords[0].type, "A");
  });

  it("warns about records that shadow the wildcard and about sub-zone domains", async () => {
    const state = defaultState();
    state.dnsRecords.push({ id: "rec-g", type: "A", name: "grafana.lab.example.com", content: "203.0.113.10" });
    const { fetchFn } = mockCloudflare(state);

    const result = await provisionCloudflareTunnel({
      ...baseInput,
      clusterDomain: "lab.example.com",
      componentSubdomains: ["grafana", "flux"],
      fetchFn,
    });

    assert.equal(result.zoneName, "example.com");
    assert.equal(result.warnings.length, 2);
    assert.match(result.warnings[0], /Universal SSL/);
    assert.match(result.warnings[1], /A grafana\.lab\.example\.com/);
  });

  it("explains how to enable Zero Trust when the organization is missing", async () => {
    const state = defaultState();
    state.accessOrg = null;
    const { fetchFn, calls } = mockCloudflare(state);

    await assert.rejects(provisionCloudflareTunnel({ ...baseInput, fetchFn }), /Zero Trust is not enabled.*one\.dash\.cloudflare\.com/);
    assert.ok(!calls.some((c) => c.method !== "GET"));
  });

  it("fails without a zone or without allowed users", async () => {
    const state = defaultState();
    state.zones = [];
    const { fetchFn } = mockCloudflare(state);
    await assert.rejects(provisionCloudflareTunnel({ ...baseInput, fetchFn }), /No active Cloudflare zone/);
    await assert.rejects(
      provisionCloudflareTunnel({ ...baseInput, accessAllowed: [], fetchFn }),
      /at least one allowed/,
    );
  });

  it("surfaces Cloudflare API errors with status and without the query string", async () => {
    const fetchFn: FetchFn = async () =>
      new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), {
        status: 403,
      });

    await assert.rejects(provisionCloudflareTunnel({ ...baseInput, fetchFn }), (err: unknown) => {
      assert.ok(err instanceof CloudflareApiError);
      assert.equal(err.status, 403);
      assert.match(err.message, /GET \/zones failed — 10000: Authentication error/);
      assert.doesNotMatch(err.message, /\?/);
      return true;
    });
  });
});

describe("preflightCloudflareTunnel", () => {
  const preflightInput = { apiToken: "setup-token", clusterDomain: "example.com" };

  it("passes on a ready account using only GET requests", async () => {
    const { fetchFn, calls } = mockCloudflare(defaultState());
    const result = await preflightCloudflareTunnel({ ...preflightInput, fetchFn });

    assert.deepEqual(result, { zoneName: "example.com", accessTeam: "myteam", problems: [], warnings: [] });
    assert.ok(calls.length > 0 && calls.every((c) => c.method === "GET"));
    assert.ok(calls.some((c) => c.path.endsWith("/cfd_tunnel")));
    assert.ok(calls.some((c) => c.path.endsWith("/access/apps")));
    assert.ok(calls.some((c) => c.path.endsWith("/dns_records")));
  });

  it("reports a disabled Zero Trust with the dashboard link", async () => {
    const state = defaultState();
    state.accessOrg = null;
    const { fetchFn, calls } = mockCloudflare(state);
    const result = await preflightCloudflareTunnel({ ...preflightInput, fetchFn });

    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /Zero Trust is not enabled.*one\.dash\.cloudflare\.com.*Free plan/);
    assert.ok(!calls.some((c) => c.path.endsWith("/access/apps")));
  });

  it("names every missing token permission", async () => {
    const state = defaultState();
    state.denied = [`/zones/${ZONE_ID}/dns_records`, `/accounts/${ACCOUNT_ID}/cfd_tunnel`];
    const { fetchFn } = mockCloudflare(state);
    const result = await preflightCloudflareTunnel({ ...preflightInput, fetchFn });

    assert.equal(result.problems.length, 2);
    assert.match(result.problems.join("\n"), /missing "Account → Cloudflare Tunnel: Edit"/);
    assert.match(result.problems.join("\n"), /missing "Zone → DNS: Edit"/);
  });

  it("reports a missing Access organization read permission", async () => {
    const state = defaultState();
    state.denied = [`/accounts/${ACCOUNT_ID}/access/organizations`];
    const { fetchFn } = mockCloudflare(state);
    const result = await preflightCloudflareTunnel({ ...preflightInput, fetchFn });

    assert.match(result.problems.join("\n"), /missing "Account → Access: Organizations, Identity Providers, and Groups: Read"/);
  });

  it("stops at the zone when it cannot be found or read", async () => {
    const missing = defaultState();
    missing.zones = [];
    let result = await preflightCloudflareTunnel({ ...preflightInput, fetchFn: mockCloudflare(missing).fetchFn });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /No active Cloudflare zone/);

    const denied = defaultState();
    denied.denied = ["/zones"];
    result = await preflightCloudflareTunnel({ ...preflightInput, fetchFn: mockCloudflare(denied).fetchFn });
    assert.deepEqual(result.problems.length, 1);
    assert.match(result.problems[0], /missing "Zone → Zone: Read"/);
  });

  it("keeps the sub-zone certificate warning non-blocking", async () => {
    const { fetchFn } = mockCloudflare(defaultState());
    const result = await preflightCloudflareTunnel({ apiToken: "t", clusterDomain: "lab.example.com", fetchFn });
    assert.deepEqual(result.problems, []);
    assert.match(result.warnings[0], /Universal SSL/);
  });

  it("tells an invalid token apart from a missing permission", async () => {
    const fetchFn: FetchFn = async () =>
      new Response(JSON.stringify({ success: false, errors: [{ code: 9109, message: "Invalid access token" }] }), {
        status: 403,
      });
    const result = await preflightCloudflareTunnel({ ...preflightInput, fetchFn });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /invalid, expired or revoked/);
    assert.doesNotMatch(result.problems[0], /missing/);
  });

  it("treats 9109 Unauthorized on a valid token as a missing permission", async () => {
    const state = defaultState();
    const { fetchFn: base } = mockCloudflare(state);
    const fetchFn: FetchFn = async (input, init) =>
      String(input).includes("/dns_records")
        ? new Response(
            JSON.stringify({ success: false, errors: [{ code: 9109, message: "Unauthorized to access requested resource" }] }),
            { status: 403 },
          )
        : base(input, init);
    const result = await preflightCloudflareTunnel({ ...preflightInput, fetchFn });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /missing "Zone → DNS: Edit"/);
  });

  it("turns network failures into a problem instead of throwing", async () => {
    const fetchFn: FetchFn = async () => {
      throw new TypeError("fetch failed");
    };
    const result = await preflightCloudflareTunnel({ ...preflightInput, fetchFn });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /Cannot reach the Cloudflare API.*fetch failed/);
  });
});

// ---------------------------------------------------------------------------
// Repo rendering helpers
// ---------------------------------------------------------------------------

const CLOUDFLARED_TEMPLATE = `tunnel: \${CLOUDFLARE_TUNNEL_ID}
ingress:
  - hostname: "*.\${cluster_domain}"
    originRequest:
      noTLSVerify: \${CLOUDFLARE_ORIGIN_NO_TLS_VERIFY}
      access:
        required: true
        teamName: \${CLOUDFLARE_ACCESS_TEAM}
        audTag:
          - \${CLOUDFLARE_ACCESS_AUD}
`;

describe("renderCloudflaredConfig", () => {
  const values = { tunnelId: TUNNEL_ID, accessTeam: "myteam", accessAud: AUD, noTlsVerify: false };

  it("substitutes bootstrap values and leaves Flux variables alone", () => {
    const out = renderCloudflaredConfig(CLOUDFLARED_TEMPLATE, values);
    assert.match(out, new RegExp(`^tunnel: ${TUNNEL_ID}$`, "m"));
    assert.match(out, /noTLSVerify: false$/m);
    assert.match(out, /teamName: myteam$/m);
    assert.match(out, new RegExp(`- ${AUD}$`, "m"));
    assert.match(out, /"\*\.\$\{cluster_domain\}"/);
  });

  it("renders noTLSVerify as a YAML boolean", () => {
    assert.match(renderCloudflaredConfig(CLOUDFLARED_TEMPLATE, { ...values, noTlsVerify: true }), /noTLSVerify: true$/m);
  });

  it("rejects values that could inject YAML", () => {
    assert.throws(() => renderCloudflaredConfig(CLOUDFLARED_TEMPLATE, { ...values, accessTeam: "x\nfoo: bar" }), /Access team/);
    assert.throws(() => renderCloudflaredConfig(CLOUDFLARED_TEMPLATE, { ...values, accessAud: "not-hex" }), /Access AUD/);
    assert.throws(() => renderCloudflaredConfig(CLOUDFLARED_TEMPLATE, { ...values, tunnelId: "abc" }), /tunnel id/);
  });

  it("fails on unknown upper-case placeholders", () => {
    assert.throws(
      () => renderCloudflaredConfig(`${CLOUDFLARED_TEMPLATE}extra: \${CLOUDFLARE_NEW_KEY}\n`, values),
      /CLOUDFLARE_NEW_KEY/,
    );
  });
});

describe("cluster directory helpers", () => {
  let dir: string;
  const kustomization = [
    "apiVersion: kustomize.config.k8s.io/v1beta1",
    "kind: Kustomization",
    "resources:",
    "  - helm-repositories",
    "  - cert-manager",
    "  - enwoy-gateway",
    "  - external-dns",
    "  - flux-web",
    "",
  ].join("\n");
  const read = () => readFileSync(join(dir, "components/kustomization.yaml"), "utf-8");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gitops-ai-tunnel-test-"));
    for (const id of ["helm-repositories", "cert-manager", "enwoy-gateway", "external-dns", "flux-web", TUNNEL_COMPONENT_ID]) {
      mkdirSync(join(dir, "components", id), { recursive: true });
    }
    writeFileSync(join(dir, "components/kustomization.yaml"), kustomization);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("adds the tunnel right after the Gateway, once", () => {
    includeOptInComponents(dir, ["enwoy-gateway", TUNNEL_COMPONENT_ID]);
    includeOptInComponents(dir, ["enwoy-gateway", TUNNEL_COMPONENT_ID]);
    const lines = read().split("\n");
    assert.equal(lines.filter((l) => l === `  - ${TUNNEL_COMPONENT_ID}`).length, 1);
    assert.equal(lines[lines.indexOf("  - enwoy-gateway") + 1], `  - ${TUNNEL_COMPONENT_ID}`);
  });

  it("appends after the last entry when the Gateway is not listed", () => {
    writeFileSync(join(dir, "components/kustomization.yaml"), kustomization.replace("  - enwoy-gateway\n", ""));
    includeOptInComponents(dir, [TUNNEL_COMPONENT_ID]);
    assert.match(read(), /  - flux-web\n  - cloudflare-tunnel\n/);
  });

  it("leaves the list unchanged when the tunnel is not selected", () => {
    includeOptInComponents(dir, ["enwoy-gateway"]);
    assert.equal(read(), kustomization);
  });

  it("asks for a template sync when the component directory is missing", () => {
    rmSync(join(dir, "components", TUNNEL_COMPONENT_ID), { recursive: true });
    assert.throws(() => includeOptInComponents(dir, [TUNNEL_COMPONENT_ID]), /template sync/);
  });

  it("prunes the tunnel directory when it is not selected", () => {
    pruneDisabledComponents(dir, ["helm-repositories", "cert-manager", "enwoy-gateway", "external-dns", "flux-web"]);
    assert.equal(existsSync(join(dir, "components", TUNNEL_COMPONENT_ID)), false);
    assert.equal(existsSync(join(dir, "components", "flux-web")), true);
  });

  it("adds the staging ACME server next to letsencrypt_email, once", () => {
    const syncFile = join(dir, "cluster-sync.yaml");
    writeFileSync(syncFile, '    substitute:\n      letsencrypt_email: "admin@example.com"\n      cluster_name: "homelab"\n');
    useLetsencryptStaging(syncFile);
    useLetsencryptStaging(syncFile);
    assert.equal(
      readFileSync(syncFile, "utf-8"),
      '    substitute:\n      letsencrypt_email: "admin@example.com"\n' +
        `      letsencrypt_server: "${LETSENCRYPT_STAGING_SERVER}"\n      cluster_name: "homelab"\n`,
    );
  });

  it("fails when there is no letsencrypt_email to anchor on", () => {
    const syncFile = join(dir, "cluster-sync.yaml");
    writeFileSync(syncFile, "    substitute:\n      cluster_name: homelab\n");
    assert.throws(() => useLetsencryptStaging(syncFile), /no letsencrypt_email/);
  });
});

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

describe("platform detection", () => {
  const saved = { CODESPACES: process.env.CODESPACES, CI: process.env.CI };

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("treats Codespaces as headless k3d", () => {
    process.env.CODESPACES = "true";
    delete process.env.CI;
    assert.equal(isCodespaces(), true);
    assert.equal(isHeadless(), true);
    assert.equal(useK3d(), true);
  });

  it("ignores CODESPACES values other than true", () => {
    process.env.CODESPACES = "false";
    delete process.env.CI;
    assert.equal(isCodespaces(), false);
    assert.equal(isHeadless(), false);
    assert.equal(useK3d(), process.platform === "darwin");
  });
});
