import { exec } from "../utils/shell.js";
import { log } from "../utils/log.js";

// ---------------------------------------------------------------------------
// GitLab REST API helpers (pure TS — no glab/jq dependency)
// ---------------------------------------------------------------------------

interface ApiFetchOptions {
  method?: string;
  body?: Record<string, unknown>;
}

async function apiFetch<T>(
  path: string,
  token: string,
  host: string,
  options?: ApiFetchOptions,
): Promise<T> {
  const url = `https://${host}/api/v4${path}`;
  const method = options?.method ?? "GET";
  const bodyStr = options?.body ? JSON.stringify(options.body) : undefined;

  const makeHeaders = (authHeader: Record<string, string>) => ({
    ...authHeader,
    ...(bodyStr ? { "Content-Type": "application/json" } : {}),
  });

  let res = await fetch(url, {
    method,
    headers: makeHeaders({ Authorization: `Bearer ${token}` }),
    body: bodyStr,
  });

  // Fall back to PRIVATE-TOKEN header (PATs on older GitLab versions)
  if (res.status === 401) {
    res = await fetch(url, {
      method,
      headers: makeHeaders({ "PRIVATE-TOKEN": token }),
      body: bodyStr,
    });
  }

  if (!res.ok) {
    throw new Error(`GitLab API ${path}: ${res.status} ${res.statusText}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitLabUser {
  id: number;
  username: string;
  name: string;
}

export interface GitLabGroup {
  id: number;
  name: string;
  path: string;
  full_path: string;
}

export interface GitLabProjectSummary {
  id: number;
  name: string;
  path: string;
  path_with_namespace: string;
  http_url_to_repo: string;
  description: string | null;
}

export interface ProjectInfo {
  id: string;
  httpUrl: string;
  pathWithNamespace: string;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function fetchCurrentUser(
  token: string,
  host: string,
): Promise<GitLabUser> {
  return apiFetch<GitLabUser>("/user", token, host);
}

export async function fetchGroups(
  token: string,
  host: string,
): Promise<GitLabGroup[]> {
  return apiFetch<GitLabGroup[]>(
    "/groups?per_page=100&min_access_level=30&top_level_only=true&order_by=name&sort=asc",
    token,
    host,
  );
}

export async function fetchNamespaceProjects(
  token: string,
  host: string,
  namespace: string,
): Promise<GitLabProjectSummary[]> {
  const encoded = encodeURIComponent(namespace);
  try {
    return await apiFetch<GitLabProjectSummary[]>(
      `/groups/${encoded}/projects?per_page=100&order_by=updated_at&sort=desc&include_subgroups=false`,
      token,
      host,
    );
  } catch {
    return apiFetch<GitLabProjectSummary[]>(
      `/users/${encoded}/projects?per_page=100&order_by=updated_at&sort=desc`,
      token,
      host,
    );
  }
}

export async function authenticate(
  token: string,
  host: string,
): Promise<string> {
  const user = await fetchCurrentUser(token, host);
  log.success(`Authenticated as: ${user.username}`);
  return user.username;
}

export async function resolveNamespaceId(
  namespace: string,
  host: string,
  token: string,
): Promise<string> {
  const data = await apiFetch<{ id: number }>(
    `/namespaces/${encodeURIComponent(namespace)}`,
    token,
    host,
  );
  if (!data?.id) {
    throw new Error(
      `Namespace '${namespace}' not found. Check the group or username.`,
    );
  }
  log.success(`Namespace ID: ${data.id}`);
  return String(data.id);
}

export async function getProject(
  namespace: string,
  name: string,
  host: string,
  token: string,
): Promise<ProjectInfo | null> {
  const encoded = encodeURIComponent(`${namespace}/${name}`);
  try {
    const data = await apiFetch<{
      id: number;
      http_url_to_repo: string;
      path_with_namespace: string;
    }>(`/projects/${encoded}`, token, host);
    if (!data?.id) return null;
    return {
      id: String(data.id),
      httpUrl: data.http_url_to_repo,
      pathWithNamespace: data.path_with_namespace,
    };
  } catch {
    return null;
  }
}

export async function createProject(
  name: string,
  namespaceId: string,
  host: string,
  token: string,
): Promise<ProjectInfo> {
  const data = await apiFetch<{
    id: number;
    http_url_to_repo: string;
    path_with_namespace: string;
  }>(
    "/projects",
    token,
    host,
    {
      method: "POST",
      body: {
        name,
        path: name,
        namespace_id: namespaceId,
        visibility: "private",
        initialize_with_readme: false,
      },
    },
  );
  return {
    id: String(data.id),
    httpUrl: data.http_url_to_repo,
    pathWithNamespace: data.path_with_namespace,
  };
}

// ---------------------------------------------------------------------------
// Project Access Tokens (long-lived, scoped to a single repo)
// ---------------------------------------------------------------------------

export interface ProjectAccessToken {
  id: number;
  token: string;
  name: string;
  expires_at: string;
}

export async function createProjectAccessToken(
  projectId: string,
  token: string,
  host: string,
  name = "flux-gitops",
): Promise<ProjectAccessToken> {
  const expiresAt = new Date();
  expiresAt.setFullYear(expiresAt.getFullYear() + 1);
  const expiresStr = expiresAt.toISOString().split("T")[0];

  return apiFetch<ProjectAccessToken>(
    `/projects/${projectId}/access_tokens`,
    token,
    host,
    {
      method: "POST",
      body: {
        name,
        scopes: ["read_repository", "write_repository"],
        access_level: 30, // Developer
        expires_at: expiresStr,
      },
    },
  );
}

export async function revokeProjectAccessTokens(
  projectId: string,
  token: string,
  host: string,
  tokenName: string,
): Promise<void> {
  try {
    const tokens = await apiFetch<{ id: number; name: string }[]>(
      `/projects/${projectId}/access_tokens`,
      token,
      host,
    );
    for (const t of tokens) {
      if (t.name === tokenName) {
        await apiFetch(
          `/projects/${projectId}/access_tokens/${t.id}`,
          token,
          host,
          { method: "DELETE" },
        );
      }
    }
  } catch {
    /* best-effort cleanup */
  }
}

export function configureGitCredentials(
  token: string,
  host: string,
  cwd: string,
): void {
  exec(
    `git config --local --replace-all credential.helper '!f() { echo "username=oauth2"; echo "password=${token}"; }; f'`,
    { cwd },
  );
  log.success(`git credentials configured for ${host}`);
}
