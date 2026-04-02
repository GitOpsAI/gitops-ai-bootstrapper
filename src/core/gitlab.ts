import { exec, execSafe } from "../utils/shell.js";
import { log } from "../utils/log.js";
import { loginWithBrowser } from "./gitlab-oauth.js";
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
  const url = `https://${host}/api/v4${path}`;

  let res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  // Fall back to PRIVATE-TOKEN header (PATs on older GitLab versions)
  if (res.status === 401) {
    res = await fetch(url, {
      headers: { "PRIVATE-TOKEN": token },
    });
  }

  if (!res.ok) {
    throw new Error(`GitLab API ${path}: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

async function apiPost<T>(
  path: string,
  token: string,
  host: string,
  body: Record<string, unknown>,
): Promise<T> {
  const url = `https://${host}/api/v4${path}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitLab API POST ${path}: ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// GitLab API response shapes (internal)
// ---------------------------------------------------------------------------

interface GLUser {
  id: number;
  username: string;
  name: string;
}

interface GLGroup {
  id: number;
  name: string;
  path: string;
  full_path: string;
}

interface GLNamespace {
  id: number;
  name: string;
  path: string;
  kind: string;
}

interface GLProject {
  id: number;
  name: string;
  path: string;
  path_with_namespace: string;
  http_url_to_repo: string;
  description: string | null;
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export interface GitLabProvider extends GitProvider {
  readonly type: "gitlab";
}

export function createGitLabProvider(): GitLabProvider {
  return {
    type: "gitlab",
    defaultHost: "gitlab.com",
    cliTool: "glab",
    tokenLabel: "GitLab Personal Access Token (api, read_repository, write_repository)",

    async fetchCurrentUser(token, host): Promise<GitUser> {
      const u = await apiFetch<GLUser>("/user", token, host);
      return { username: u.username, name: u.name };
    },

    async fetchOrganizations(token, host): Promise<GitOrganization[]> {
      const groups = await apiFetch<GLGroup[]>(
        "/groups?per_page=100&min_access_level=30&top_level_only=true&order_by=name&sort=asc",
        token,
        host,
      );
      return groups.map((g) => ({
        name: g.name,
        path: g.path,
        fullPath: g.full_path,
      }));
    },

    async fetchNamespaceProjects(token, host, namespace): Promise<GitProjectSummary[]> {
      const encoded = encodeURIComponent(namespace);
      let projects: GLProject[];
      try {
        projects = await apiFetch<GLProject[]>(
          `/groups/${encoded}/projects?per_page=100&order_by=updated_at&sort=desc&include_subgroups=false`,
          token,
          host,
        );
      } catch {
        projects = await apiFetch<GLProject[]>(
          `/users/${encoded}/projects?per_page=100&order_by=updated_at&sort=desc`,
          token,
          host,
        );
      }
      return projects.map((p) => ({
        name: p.name,
        description: p.description,
        pathWithNamespace: p.path_with_namespace,
        httpUrl: p.http_url_to_repo,
      }));
    },

    async authenticate(token, host): Promise<string> {
      const user = await this.fetchCurrentUser(token, host);
      log.success(`Authenticated as: ${user.username}`);
      return user.username;
    },

    async resolveNamespaceId(namespace, host, token): Promise<string> {
      const encoded = encodeURIComponent(namespace);
      try {
        const ns = await apiFetch<GLNamespace>(
          `/namespaces/${encoded}`,
          token,
          host,
        );
        log.success(`Namespace ID: ${ns.id}`);
        return String(ns.id);
      } catch {
        throw new Error(
          `Namespace '${namespace}' not found. Check the group or username.`,
        );
      }
    },

    async getProject(namespace, name, host, token): Promise<ProjectInfo | null> {
      const encoded = encodeURIComponent(`${namespace}/${name}`);
      try {
        const p = await apiFetch<GLProject>(
          `/projects/${encoded}`,
          token,
          host,
        );
        return {
          id: String(p.id),
          httpUrl: p.http_url_to_repo,
          pathWithNamespace: p.path_with_namespace,
        };
      } catch {
        return null;
      }
    },

    async createProject(name, namespaceId, host, token): Promise<ProjectInfo> {
      const p = await apiPost<GLProject>(
        "/projects",
        token,
        host,
        {
          name,
          path: name,
          namespace_id: Number(namespaceId),
          visibility: "private",
          initialize_with_readme: false,
        },
      );
      return {
        id: String(p.id),
        httpUrl: p.http_url_to_repo,
        pathWithNamespace: p.path_with_namespace,
      };
    },

    configureGitCredentials(token, cwd): void {
      const { exitCode, stdout } = execSafe(
        "git remote get-url origin 2>/dev/null",
      );
      let host = "gitlab.com";
      if (exitCode === 0 && stdout) {
        const match = stdout.match(/https:\/\/([^/]+)\//);
        if (match) host = match[1];
      }

      exec(
        `git config --local --replace-all credential.helper '!f() { echo "username=oauth2"; echo "password=${token}"; }; f'`,
        { cwd },
      );
      log.success(`git credentials configured for ${host}`);
    },

    getAuthRemoteUrl(host, pathWithNamespace, token): string {
      return `https://oauth2:${token}@${host}/${pathWithNamespace}.git`;
    },

    async loginWithBrowser(host): Promise<string> {
      return loginWithBrowser(host);
    },
  };
}
