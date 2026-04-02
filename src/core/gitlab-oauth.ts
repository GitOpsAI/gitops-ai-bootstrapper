import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { URL } from "node:url";
import { execSync } from "node:child_process";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { isMacOS } from "../utils/platform.js";

const OAUTH_SCOPES = "api read_repository write_repository";
const CALLBACK_PATH = "/callback";
const LOGIN_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Pre-registered OAuth application per host (like Vercel, gh CLI).
// Register once at: https://<host>/-/user_settings/applications
//   Name:         gitops-ai
//   Redirect URI: http://127.0.0.1/callback
//   Confidential: No
//   Scopes:       api
// ---------------------------------------------------------------------------

const BUILTIN_CLIENT_IDS: Record<string, string> = {
  "gitlab.com": "0e183a7a911ca9b4e078a42bdc9e9ea6a2e821cd5303c3ceca6ce9be51f7e627",
};

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
// Resolve client_id — built-in or env var, nothing else needed.
// ---------------------------------------------------------------------------

function getClientId(host: string): string {
  const fromEnv = process.env.GITLAB_OAUTH_APP_ID;
  if (fromEnv) return fromEnv;

  const builtIn = BUILTIN_CLIENT_IDS[host];
  if (builtIn) return builtIn;

  throw new Error(
    `No OAuth application configured for ${host}. ` +
      `Set GITLAB_OAUTH_APP_ID env var or add the host to BUILTIN_CLIENT_IDS.`,
  );
}

// ---------------------------------------------------------------------------
// Main browser-login flow
// ---------------------------------------------------------------------------

export async function loginWithBrowser(host: string): Promise<string> {
  const clientId = getClientId(host);
  const verifier = generateVerifier();
  const challenge = computeChallenge(verifier);
  const state = base64url(randomBytes(16));

  return new Promise<string>((resolve, reject) => {
    let timer: NodeJS.Timeout;

    const server = createServer(
      async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
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
          finish(new Error(`GitLab OAuth: ${desc}`));
          return;
        }

        if (url.searchParams.get("state") !== state) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            htmlPage(
              "Security Error",
              "State mismatch — possible CSRF.",
              true,
            ),
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
          const addr = server.address();
          const port = typeof addr === "object" && addr ? addr.port : 0;
          const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;

          const tokenRes = await fetch(`https://${host}/oauth/token`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              client_id: clientId,
              code,
              grant_type: "authorization_code",
              redirect_uri: redirectUri,
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

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;

      const authUrl = new URL(`https://${host}/oauth/authorize`);
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", OAUTH_SCOPES);
      authUrl.searchParams.set("code_challenge", challenge);
      authUrl.searchParams.set("code_challenge_method", "S256");
      authUrl.searchParams.set("state", state);

      const urlStr = authUrl.toString();
      p.log.info("Opening browser for GitLab authorization...");
      p.log.info(
        pc.dim(`If the browser doesn't open, visit:\n${pc.cyan(urlStr)}`),
      );
      openUrl(urlStr);
    });

    timer = setTimeout(() => {
      finish(new Error("Login timed out — no response within 2 minutes"));
    }, LOGIN_TIMEOUT_MS);

    server.on("error", (err) => {
      finish(new Error(`Local OAuth server failed: ${err.message}`));
    });
  });
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
  const accent = isError ? "#f85149" : "#58a6ff";
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
