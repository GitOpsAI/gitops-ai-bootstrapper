import { readFileSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { exec, execSafe } from "../utils/shell.js";
import { log } from "../utils/log.js";
import { loginWithGitHubDevice } from "./github-oauth.js";
import type {
  GitProvider,
  GitUser,
  GitOrganization,
  GitProjectSummary,
  ProjectInfo,
} from "./git-provider.js";

// ---------------------------------------------------------------------------
// REST helpers
// ---------------------------------------------------------------------------

async function apiFetch<T>(
  path: string,
  token: string,
  host: string,
): Promise<T> {
  const apiBase =
    host === "github.com"
      ? "https://api.github.com"
      : `https://${host}/api/v3`;

  const url = `${apiBase}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!res.ok) {
    throw new Error(`GitHub API ${path}: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

async function apiPost<T>(
  path: string,
  token: string,
  host: string,
  body: Record<string, unknown>,
): Promise<T> {
  const apiBase =
    host === "github.com"
      ? "https://api.github.com"
      : `https://${host}/api/v3`;

  const url = `${apiBase}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API POST ${path}: ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// GitHub API response shapes
// ---------------------------------------------------------------------------

interface GHUser {
  login: string;
  name: string | null;
}

interface GHOrg {
  login: string;
  description: string | null;
}

interface GHRepo {
  id: number;
  name: string;
  full_name: string;
  clone_url: string;
  description: string | null;
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export interface GitHubProvider extends GitProvider {
  readonly type: "github";
}

export function createGitHubProvider(): GitHubProvider {
  return {
    type: "github",
    defaultHost: "github.com",
    cliTool: "gh",
    tokenLabel: "GitHub Personal Access Token (repo, read:org)",

    async fetchCurrentUser(token, host): Promise<GitUser> {
      const u = await apiFetch<GHUser>("/user", token, host);
      return { username: u.login, name: u.name ?? u.login };
    },

    async fetchOrganizations(token, host): Promise<GitOrganization[]> {
      const orgs = await apiFetch<GHOrg[]>(
        "/user/orgs?per_page=100",
        token,
        host,
      );
      return orgs.map((o) => ({
        name: o.login,
        path: o.login,
        fullPath: o.login,
      }));
    },

    async fetchNamespaceProjects(token, host, namespace): Promise<GitProjectSummary[]> {
      // Try as an org first, then fall back to user repos
      let repos: GHRepo[];
      try {
        repos = await apiFetch<GHRepo[]>(
          `/orgs/${encodeURIComponent(namespace)}/repos?per_page=100&sort=updated&direction=desc`,
          token,
          host,
        );
      } catch {
        repos = await apiFetch<GHRepo[]>(
          `/users/${encodeURIComponent(namespace)}/repos?per_page=100&sort=updated&direction=desc`,
          token,
          host,
        );
      }
      return repos.map((r) => ({
        name: r.name,
        description: r.description,
        pathWithNamespace: r.full_name,
        httpUrl: r.clone_url,
      }));
    },

    async authenticate(token, host): Promise<string> {
      const user = await this.fetchCurrentUser(token, host);
      log.success(`Authenticated as: ${user.username}`);
      return user.username;
    },

    async resolveNamespaceId(namespace, host, token): Promise<string> {
      // GitHub doesn't use numeric namespace IDs. We return the namespace
      // string itself so `createProject` can decide org vs user.
      try {
        await apiFetch<GHOrg>(`/orgs/${encodeURIComponent(namespace)}`, token, host);
        return namespace;
      } catch {
        // Not an org — treat as personal user namespace
        return namespace;
      }
    },

    async getProject(namespace, name, host, token): Promise<ProjectInfo | null> {
      try {
        const r = await apiFetch<GHRepo>(
          `/repos/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`,
          token,
          host,
        );
        return {
          id: String(r.id),
          httpUrl: r.clone_url,
          pathWithNamespace: r.full_name,
        };
      } catch {
        return null;
      }
    },

    async createProject(name, namespaceId, host, token): Promise<ProjectInfo> {
      // Determine if namespace is an org or the authenticated user
      const user = await this.fetchCurrentUser(token, host);
      const isOrg = namespaceId !== user.username;

      let repo: GHRepo;
      if (isOrg) {
        repo = await apiPost<GHRepo>(
          `/orgs/${encodeURIComponent(namespaceId)}/repos`,
          token,
          host,
          { name, private: true, auto_init: false },
        );
      } else {
        repo = await apiPost<GHRepo>(
          "/user/repos",
          token,
          host,
          { name, private: true, auto_init: false },
        );
      }

      return {
        id: String(repo.id),
        httpUrl: repo.clone_url,
        pathWithNamespace: repo.full_name,
      };
    },

    configureGitCredentials(token, cwd): void {
      const { exitCode, stdout } = execSafe(
        "git remote get-url origin 2>/dev/null",
      );
      let host = "github.com";
      if (exitCode === 0 && stdout) {
        const match = stdout.match(/https:\/\/([^/]+)\//);
        if (match) host = match[1];
      }

      exec(
        `git config --local --replace-all credential.helper '!f() { echo "username=x-access-token"; echo "password=${token}"; }; f'`,
        { cwd },
      );
      log.success(`git credentials configured for ${host}`);
    },

    getAuthRemoteUrl(host, pathWithNamespace, token): string {
      return `https://x-access-token:${token}@${host}/${pathWithNamespace}.git`;
    },

    async loginWithBrowser(host): Promise<string> {
      return loginWithGitHubDevice(host);
    },
  };
}

// ---------------------------------------------------------------------------
// Deploy key management (SSH-based auth for Flux)
// ---------------------------------------------------------------------------

const GITHUB_COM_KNOWN_HOSTS = [
  "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
  "github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=",
].join("\n");

export function getKnownHosts(host: string): string {
  if (host === "github.com") return GITHUB_COM_KNOWN_HOSTS;

  const { stdout } = execSafe(`ssh-keyscan ${host} 2>/dev/null`);
  if (stdout?.trim()) return stdout.trim();

  throw new Error(
    `Could not retrieve SSH host keys for ${host}. ` +
      `Ensure ssh-keyscan is installed and the host is reachable.`,
  );
}

export interface DeployKeyResult {
  privateKey: string;
  publicKey: string;
  knownHosts: string;
}

export async function createGitHubDeployKey(
  owner: string,
  repo: string,
  host: string,
  token: string,
): Promise<DeployKeyResult> {
  const keyPath = "/tmp/flux-deploy-key";

  try {
    execSync(`rm -f "${keyPath}" "${keyPath}.pub"`, { stdio: "ignore" });
  } catch { /* ignore */ }

  execSync(
    `ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q -C "flux-system"`,
    { stdio: "ignore" },
  );

  const privateKey = readFileSync(keyPath, "utf-8");
  const publicKey = readFileSync(`${keyPath}.pub`, "utf-8").trim();

  try { unlinkSync(keyPath); } catch { /* ignore */ }
  try { unlinkSync(`${keyPath}.pub`); } catch { /* ignore */ }

  await apiPost(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/keys`,
    token,
    host,
    {
      title: "flux-system (GitOps AI Bootstrapper)",
      key: publicKey,
      read_only: false,
    },
  );

  log.success(`Deploy key added to ${owner}/${repo}`);

  return { privateKey, publicKey, knownHosts: getKnownHosts(host) };
}
