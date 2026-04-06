import { execSync } from "node:child_process";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { isMacOS } from "../utils/platform.js";

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
// Dashboard: pre-filled "Edit zone DNS" API token
//
// Cloudflare's OAuth (localhost callback) does not work on remote SSH hosts or
// when the browser runs on another machine. We use the dashboard flow only.
// ---------------------------------------------------------------------------

/** DNS + zone read permissions for External DNS / cert-manager (matches "Edit zone DNS"). */
const TOKEN_PERMISSIONS = JSON.stringify([
  { key: "zone_dns", type: "edit" },
  { key: "zone", type: "read" },
]);

/**
 * User API token template URL (pre-fills Zone Resources + Permissions).
 * @see https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/
 */
function tokenTemplateUrl(zoneOrDomainHint: string): string {
  const base = "https://dash.cloudflare.com/profile/api-tokens";
  const params = new URLSearchParams();
  params.set("permissionGroupKeys", TOKEN_PERMISSIONS);
  params.set("accountId", "*");
  params.set("zoneId", "all");
  params.set("name", `gitops-ai-dns-${zoneOrDomainHint}`);
  return `${base}?${params.toString()}`;
}

/** Pre-filled "Edit zone DNS" API token creation URL in the Cloudflare dashboard. */
export function getCloudflareApiTokenCreateUrl(zoneOrDomainHint: string): string {
  return tokenTemplateUrl(zoneOrDomainHint);
}

async function promptForDashboardToken(clusterDomain: string): Promise<string> {
  const url = tokenTemplateUrl(clusterDomain);

  p.log.info("Open this URL in your browser to create an API token:");
  p.log.info(pc.cyan(url));
  p.note(
    `${pc.bold("Permissions")}\n` +
      `  ${pc.cyan("Zone")} → ${pc.cyan("DNS")}: Edit\n` +
      `  ${pc.cyan("Zone")} → ${pc.cyan("Zone")}: Read\n\n` +
      `${pc.bold("Account Resources")}\n` +
      `  ${pc.cyan("Include")} → All accounts (or your account only)\n\n` +
      `${pc.bold("Zone Resources")}\n` +
      `  ${pc.cyan("Include")} → All zones — then narrow to the zone for ${pc.cyan(clusterDomain)} (recommended)\n\n` +
      pc.dim("Continue to summary → Create Token → copy the value."),
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
// ---------------------------------------------------------------------------

export async function loginAndCreateCloudflareToken(
  clusterDomain: string,
): Promise<string> {
  return promptForDashboardToken(clusterDomain);
}
