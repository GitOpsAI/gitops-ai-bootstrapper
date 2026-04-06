import { execSync } from "node:child_process";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { isMacOS } from "../utils/platform.js";

const GITHUB_CLIENT_ID = "Ov23lig0eFrzARzjfqy6";
const OAUTH_SCOPES = "repo read:org";
const POLL_TIMEOUT_MS = 120_000;

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
// Helpers
// ---------------------------------------------------------------------------

function authBaseUrl(host: string): string {
  return host === "github.com" ? "https://github.com" : `https://${host}`;
}

function getClientId(host: string): string {
  const fromEnv = process.env.GITHUB_OAUTH_CLIENT_ID;
  if (fromEnv) return fromEnv;

  if (host === "github.com") return GITHUB_CLIENT_ID;

  throw new Error(
    `No OAuth application configured for ${host}. ` +
      `Set GITHUB_OAUTH_CLIENT_ID env var for GitHub Enterprise hosts.`,
  );
}

// ---------------------------------------------------------------------------
// GitHub Device Flow (RFC 8628)
//
// 1. POST /login/device/code  → device_code, user_code, verification_uri
// 2. Display user_code, open browser to verification_uri
// 3. Poll POST /login/oauth/access_token until granted
//
// No client_secret required — this is the standard flow for GitHub Apps.
// ---------------------------------------------------------------------------

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface TokenPollResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function requestDeviceCode(
  host: string,
  clientId: string,
): Promise<DeviceCodeResponse> {
  const res = await fetch(`${authBaseUrl(host)}/login/device/code`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      scope: OAUTH_SCOPES,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub device code request failed (${res.status}): ${body}`);
  }

  return res.json() as Promise<DeviceCodeResponse>;
}

async function pollForToken(
  host: string,
  clientId: string,
  deviceCode: string,
  intervalSec: number,
): Promise<string> {
  const start = Date.now();
  let interval = intervalSec * 1000;

  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, interval));

    const res = await fetch(
      `${authBaseUrl(host)}/login/oauth/access_token`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: clientId,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      },
    );

    if (!res.ok) continue;

    const data = (await res.json()) as TokenPollResponse;

    if (data.access_token) {
      return data.access_token;
    }

    switch (data.error) {
      case "authorization_pending":
        break;
      case "slow_down":
        interval += 5000;
        break;
      case "expired_token":
        throw new Error("Device code expired — please try again");
      case "access_denied":
        throw new Error("Authorization denied by user");
      default:
        if (data.error) {
          throw new Error(
            `GitHub OAuth error: ${data.error_description ?? data.error}`,
          );
        }
    }
  }

  throw new Error("Login timed out — no response within 2 minutes");
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function loginWithGitHubDevice(host: string): Promise<string> {
  const clientId = getClientId(host);
  const dc = await requestDeviceCode(host, clientId);

  p.log.info(
    `Enter code ${pc.bold(pc.cyan(dc.user_code))} at ${pc.cyan(dc.verification_uri)}`,
  );
  p.log.info(
    pc.dim(
      "If your default browser does not open automatically, visit the URL above and enter the code manually.",
    ),
  );

  await p.text({
    message:
      pc.dim("Press ") +
      pc.bold(pc.yellow("Enter")) +
      pc.dim(" to try opening your default browser…"),
    defaultValue: "",
  });
  openUrl(dc.verification_uri);

  const token = await pollForToken(host, clientId, dc.device_code, dc.interval);
  return token;
}
