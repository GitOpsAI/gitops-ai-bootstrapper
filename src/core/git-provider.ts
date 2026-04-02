// ---------------------------------------------------------------------------
// Provider type
// ---------------------------------------------------------------------------

export type ProviderType = "gitlab" | "github";

// ---------------------------------------------------------------------------
// Shared domain types
// ---------------------------------------------------------------------------

export interface GitUser {
  username: string;
  name: string;
}

export interface GitOrganization {
  name: string;
  path: string;
  fullPath: string;
}

export interface GitProjectSummary {
  name: string;
  description: string | null;
  pathWithNamespace: string;
  httpUrl: string;
}

export interface ProjectInfo {
  id: string;
  httpUrl: string;
  pathWithNamespace: string;
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface GitProvider {
  readonly type: ProviderType;
  readonly defaultHost: string;
  readonly cliTool: string;
  readonly tokenLabel: string;

  fetchCurrentUser(token: string, host: string): Promise<GitUser>;
  fetchOrganizations(token: string, host: string): Promise<GitOrganization[]>;
  fetchNamespaceProjects(
    token: string,
    host: string,
    namespace: string,
  ): Promise<GitProjectSummary[]>;

  authenticate(token: string, host: string): Promise<string>;
  resolveNamespaceId(
    namespace: string,
    host: string,
    token: string,
  ): Promise<string>;
  getProject(
    namespace: string,
    name: string,
    host: string,
    token: string,
  ): Promise<ProjectInfo | null>;
  createProject(
    name: string,
    namespaceId: string,
    host: string,
    token: string,
  ): Promise<ProjectInfo>;

  configureGitCredentials(token: string, cwd: string): void;
  getAuthRemoteUrl(
    host: string,
    pathWithNamespace: string,
    token: string,
  ): string;

  loginWithBrowser(host: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Factory (dynamic imports to avoid circular module references)
// ---------------------------------------------------------------------------

const providerCache = new Map<ProviderType, GitProvider>();

export async function getProvider(type: ProviderType): Promise<GitProvider> {
  const cached = providerCache.get(type);
  if (cached) return cached;

  let provider: GitProvider;
  switch (type) {
    case "gitlab": {
      const { createGitLabProvider } = await import("./gitlab.js");
      provider = createGitLabProvider();
      break;
    }
    case "github": {
      const { createGitHubProvider } = await import("./github.js");
      provider = createGitHubProvider();
      break;
    }
    default:
      throw new Error(`Unknown git provider: ${type as string}`);
  }

  providerCache.set(type, provider);
  return provider;
}
