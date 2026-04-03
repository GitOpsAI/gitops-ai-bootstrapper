import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { URL } from "node:url";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { isMacOS } from "../utils/platform.js";

// Wrangler's public OAuth client (PKCE, no secret required)
const WRANGLER_CLIENT_ID = "54d11594-84e4-41aa-b438-e81b8fa78ee7";

const AUTH_URL = "https://dash.cloudflare.com/oauth2/auth";
const TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
const API_BASE = "https://api.cloudflare.com/client/v4";

// Cloudflare's OAuth provider requires this exact callback
const CALLBACK_PORT = 8976;
const CALLBACK_PATH = "/oauth/callback";
const CALLBACK_URL = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;

const OAUTH_SCOPES = "account:read user:read zone:read offline_access";
const LOGIN_TIMEOUT_MS = 120_000;

// Well-known permission group IDs (stable across all accounts)
const PERM_DNS_WRITE = "4755a26eedb94da69e1066d98aa820be";
const PERM_ZONE_READ = "c8fed203ed3043cba015a93ad1616f1f";

// ---------------------------------------------------------------------------
// PKCE helpers (RFC 7636)
// ---------------------------------------------------------------------------

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function generateVerifier(): string {
  return base64url(randomBytes(32));
}

function computeChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

// ---------------------------------------------------------------------------
// Browser opener
// ---------------------------------------------------------------------------

function openUrl(url: string): void {
  const cmd = isMacOS() ? "open" : "xdg-open";
  try {
    execSync(`${cmd} '${url}'`, { stdio: "ignore" });
  } catch {
    /* user will see the manual URL in the terminal */
  }
}

// ---------------------------------------------------------------------------
// Resolve client_id
// ---------------------------------------------------------------------------

function getClientId(): string {
  return process.env.CLOUDFLARE_OAUTH_CLIENT_ID ?? WRANGLER_CLIENT_ID;
}

// ---------------------------------------------------------------------------
// OAuth Authorization Code + PKCE flow
// ---------------------------------------------------------------------------

async function oauthLogin(): Promise<string> {
  const clientId = getClientId();
  const verifier = generateVerifier();
  const challenge = computeChallenge(verifier);
  const state = base64url(randomBytes(16));

  return new Promise<string>((resolve, reject) => {
    let timer: NodeJS.Timeout;

    const server = createServer(
      async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? "/", `http://localhost:${CALLBACK_PORT}`);
        if (url.pathname !== CALLBACK_PATH) {
          res.writeHead(404);
          res.end();
          return;
        }

        const error = url.searchParams.get("error");
        if (error) {
          const desc = url.searchParams.get("error_description") ?? error;
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(htmlPage("Authentication Failed", escapeHtml(desc), true));
          finish(new Error(`Cloudflare OAuth: ${desc}`));
          return;
        }

        if (url.searchParams.get("state") !== state) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            htmlPage("Security Error", "State mismatch — possible CSRF.", true),
          );
          finish(new Error("OAuth state mismatch"));
          return;
        }

        const code = url.searchParams.get("code");
        if (!code) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(htmlPage("Error", "No authorization code received.", true));
          finish(new Error("Missing authorization code"));
          return;
        }

        try {
          const tokenRes = await fetch(TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code,
              redirect_uri: CALLBACK_URL,
              client_id: clientId,
              code_verifier: verifier,
            }),
          });

          if (!tokenRes.ok) {
            const body = await tokenRes.text();
            throw new Error(
              `Token exchange failed (${tokenRes.status}): ${body}`,
            );
          }

          const { access_token } = (await tokenRes.json()) as {
            access_token: string;
          };
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            htmlPage(
              "Authenticated",
              "You can close this tab and return to the terminal.",
              false,
            ),
          );
          finish(null, access_token);
        } catch (err) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            htmlPage(
              "Error",
              "Token exchange failed. Check the terminal.",
              true,
            ),
          );
          finish(err as Error);
        }
      },
    );

    function finish(err: Error | null, token?: string) {
      clearTimeout(timer);
      server.close();
      if (err) reject(err);
      else resolve(token!);
    }

    server.listen(CALLBACK_PORT, "localhost", () => {
      const authUrl = new URL(AUTH_URL);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("redirect_uri", CALLBACK_URL);
      authUrl.searchParams.set("scope", OAUTH_SCOPES);
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("code_challenge", challenge);
      authUrl.searchParams.set("code_challenge_method", "S256");

      const urlStr = authUrl.toString();
      p.log.info(
        pc.dim(`If the browser doesn't open, visit:\n${pc.cyan(urlStr)}`),
      );
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(`Press \x1b[1m\x1b[33mEnter\x1b[0m to open browser for Cloudflare authorization… `, () => {
        rl.close();
        openUrl(urlStr);
      });
    });

    timer = setTimeout(() => {
      finish(new Error("Login timed out — no response within 2 minutes"));
    }, LOGIN_TIMEOUT_MS);

    server.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        finish(
          new Error(
            `Port ${CALLBACK_PORT} is already in use. ` +
              `Close any running wrangler process and try again.`,
          ),
        );
        return;
      }
      finish(new Error(`Local OAuth server failed: ${err.message}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Cloudflare API helpers
// ---------------------------------------------------------------------------

interface CloudflareZone {
  id: string;
  name: string;
  status: string;
  account: { id: string; name: string };
}

interface CloudflareApiResponse<T> {
  success: boolean;
  errors: { code: number; message: string }[];
  result: T;
}

async function cfApi<T>(
  path: string,
  oauthToken: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${oauthToken}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  const data = (await res.json()) as CloudflareApiResponse<T>;

  if (!data.success) {
    const msgs = data.errors.map((e) => e.message).join("; ");
    throw new Error(`Cloudflare API error: ${msgs}`);
  }

  return data.result;
}

async function fetchZones(oauthToken: string): Promise<CloudflareZone[]> {
  return cfApi<CloudflareZone[]>("/zones?per_page=50&status=active", oauthToken);
}

function findMatchingZone(
  zones: CloudflareZone[],
  domain: string,
): CloudflareZone | undefined {
  const exact = zones.find((z) => z.name === domain);
  if (exact) return exact;
  return zones.find((z) => domain.endsWith(`.${z.name}`));
}

interface CreatedToken {
  id: string;
  value: string;
}

async function createScopedApiToken(
  oauthToken: string,
  zoneName: string,
  zoneId: string,
): Promise<string> {
  const payload = {
    name: `gitops-ai-dns-${zoneName}`,
    policies: [
      {
        effect: "allow",
        resources: {
          [`com.cloudflare.api.account.zone.${zoneId}`]: "*",
        },
        permission_groups: [
          { id: PERM_DNS_WRITE, name: "DNS Write" },
          { id: PERM_ZONE_READ, name: "Zone Read" },
        ],
      },
    ],
  };

  const token = await cfApi<CreatedToken>("/user/tokens", oauthToken, {
    method: "POST",
    body: JSON.stringify(payload),
  });

  return token.value;
}

// ---------------------------------------------------------------------------
// Dashboard fallback
//
// Cloudflare OAuth tokens cannot create API tokens (requires the
// "Create additional tokens" dashboard template). When the API call
// fails we open the dashboard to a pre-filled "Edit zone DNS" template
// and ask the user to paste the resulting token.
// ---------------------------------------------------------------------------

function tokenTemplateUrl(zoneName: string): string {
  const perms = JSON.stringify([
    { key: "zone_dns", type: "edit" },
    { key: "zone", type: "read" },
  ]);
  const base = "https://dash.cloudflare.com/profile/api-tokens/create";
  const params = new URLSearchParams({
    name: `gitops-ai-dns-${zoneName}`,
    permissionGroupKeys: perms,
  });
  return `${base}?${params}`;
}

async function promptForDashboardToken(zoneName: string): Promise<string> {
  const url = tokenTemplateUrl(zoneName);

  p.log.info("Opening the Cloudflare dashboard to create an API token...");
  p.log.info(
    pc.dim(
      `If the browser doesn't open, visit:\n${pc.cyan(url)}`,
    ),
  );
  p.note(
    `${pc.bold("Create the token with these settings:")}\n\n` +
      `  Template:     ${pc.cyan("Edit zone DNS")}\n` +
      `  Zone:         ${pc.cyan(zoneName)}\n` +
      `  Permissions:  ${pc.cyan("DNS Edit")} + ${pc.cyan("Zone Read")}\n\n` +
      pc.dim("Click 'Continue to summary' → 'Create Token' → copy the value."),
    "Cloudflare API Token",
  );
  openUrl(url);

  const token = await p.password({
    message: pc.bold("Paste the API token from the dashboard"),
    validate: (v) => {
      if (!v) return "Required";
    },
  });
  if (p.isCancel(token)) {
    throw new Error("Token entry cancelled");
  }
  return token as string;
}

// ---------------------------------------------------------------------------
// Public entry point
//
// 1. OAuth login  → short-lived access_token
// 2. List zones   → match to clusterDomain
// 3. Try POST /user/tokens → scoped long-lived API token
// 4. If 3 fails   → guided dashboard token creation
// ---------------------------------------------------------------------------

export async function loginAndCreateCloudflareToken(
  clusterDomain: string,
): Promise<string> {
  const oauthToken = await oauthLogin();
  p.log.success("Authenticated with Cloudflare");

  const zones = await fetchZones(oauthToken);
  if (zones.length === 0) {
    throw new Error("No active DNS zones found in your Cloudflare account");
  }

  let zone = findMatchingZone(zones, clusterDomain);

  if (!zone) {
    p.log.warn(
      `No zone matching '${clusterDomain}' found. Select the zone manually:`,
    );
    const picked = await p.select({
      message: pc.bold("Which Cloudflare zone should the token have access to?"),
      options: zones.map((z) => ({
        value: z.id,
        label: z.name,
        hint: z.account.name,
      })),
    });
    if (p.isCancel(picked)) {
      throw new Error("Zone selection cancelled");
    }
    zone = zones.find((z) => z.id === picked)!;
  }

  // Wrangler's OAuth client only grants read scopes, so we cannot call
  // POST /user/tokens.  If a custom client_id is set and the caller
  // wants to try the API path, they can extend this function.
  return promptForDashboardToken(zone.name);
}

// ---------------------------------------------------------------------------
// Callback HTML pages
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function htmlPage(title: string, message: string, isError: boolean): string {
  const accent = isError ? "#f85149" : "#f6821f";
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>GitOps AI — ${escapeHtml(title)}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
display:flex;align-items:center;justify-content:center;min-height:100vh;
margin:0;background:#0d1117;color:#e6edf3}
.c{text-align:center;padding:3rem;border-radius:12px;background:#161b22;
border:1px solid #30363d;max-width:420px}
h1{color:${accent};margin-bottom:.5rem}
p{color:#8b949e;line-height:1.6}
</style></head><body><div class="c">
<h1>${escapeHtml(title)}</h1><p>${message}</p>
</div></body></html>`;
}
