import { z } from "zod";
import type { ProviderType } from "./core/git-provider.js";

// ---------------------------------------------------------------------------
// Kubernetes DNS label (RFC 1123 segment)
// ---------------------------------------------------------------------------

/** Max length of a single DNS label (Kubernetes names, paths, label values). */
export const K8S_DNS_LABEL_MAX_LEN = 63;

/**
 * A single DNS label: lowercase `[a-z0-9]`, digits, `-`, must start/end with alphanumeric.
 * Matches how Kubernetes names DNS_LABEL segments (repo paths, k3d, labels).
 */
export const K8S_DNS_LABEL_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

const CLUSTER_NAME_INVALID =
  "Must be a Kubernetes DNS label: lowercase letters, digits, hyphen only; start and end with a letter or digit; at most 63 characters (uppercase is not accepted)";

/** Zod field for cluster names: trims whitespace; validates as a DNS label without changing letter case. */
export const clusterNameFieldSchema = z
  .string()
  .trim()
  .min(1, "Cluster name is required")
  .max(K8S_DNS_LABEL_MAX_LEN, `Must be at most ${K8S_DNS_LABEL_MAX_LEN} characters`)
  .regex(K8S_DNS_LABEL_RE, CLUSTER_NAME_INVALID);

/** Error message for invalid cluster name input, or undefined if valid. */
export function clusterNameInputError(raw: string | undefined): string | undefined {
  const r = clusterNameFieldSchema.safeParse(raw ?? "");
  if (r.success) return undefined;
  return r.error.issues[0]?.message ?? CLUSTER_NAME_INVALID;
}

/** Validate and return trimmed name (use after interactive validation already passed). */
export function parseClusterName(raw: string | undefined): string {
  return clusterNameFieldSchema.parse(raw ?? "");
}

/** Recover a saved install-plan value, or fallback if it is not a valid DNS label. */
export function clusterNameFromSavedPlan(raw: string | undefined, fallback = "homelab"): string {
  const r = clusterNameFieldSchema.safeParse(raw ?? fallback);
  return r.success ? r.data : fallback;
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

export const ClusterConfigSchema = z.object({
  clusterName: clusterNameFieldSchema,
  clusterDomain: z
    .string()
    .min(1)
    .refine((v) => v.includes("."), "Must be a valid domain"),
  clusterPublicIp: z.string().min(1),
  letsencryptEmail: z.string().optional(),
  ingressAllowedIps: z.string().min(1),
});

export const GitConfigSchema = z.object({
  gitProvider: z.enum(["gitlab", "github"]).default("gitlab"),
  gitToken: z.string().min(1, "Git token is required"),
  gitFluxToken: z.string().optional(),
  gitHost: z.string().min(1).optional(),
  repoName: z.string().min(1),
  repoOwner: z.string().min(1),
  repoBranch: z.string().min(1),
});

export const OPENCLAW_AUTH_MODES = ["openai_api_key", "openai_codex_oauth"] as const;
export type OpenclawAuthMode = (typeof OPENCLAW_AUTH_MODES)[number];

export const SecretsConfigSchema = z.object({
  cloudflareApiToken: z.string().optional(),
  openaiApiKey: z.string().optional(),
  openclawGatewayToken: z.string().optional(),
  /** OpenClaw: platform API key in Git (SOPS) vs Codex subscription via OAuth after install */
  openclawAuthMode: z.enum(OPENCLAW_AUTH_MODES).optional(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ClusterConfig = z.infer<typeof ClusterConfigSchema>;
export type GitConfig = z.infer<typeof GitConfigSchema>;
export type SecretsConfig = z.infer<typeof SecretsConfigSchema>;
export type BootstrapConfig = ClusterConfig &
  GitConfig &
  SecretsConfig & {
    selectedComponents: string[];
    /** Tag or branch used for the template clone */
    templateRef?: string;
  };

// Re-export for convenience
export type { ProviderType };

export interface SopsConfig {
  keyDir: string;
  keyFile: string;
  namespace: string;
  secretName: string;
  configFile: string;
  backupDir: string;
}

// ---------------------------------------------------------------------------
// Component registry
// ---------------------------------------------------------------------------

export interface ComponentDef {
  id: string;
  label: string;
  hint: string;
  required: boolean;
  secrets?: string[];
  subdomain?: string;
}

export const COMPONENTS: ComponentDef[] = [
  { id: "helm-repos", label: "Helm Repositories", hint: "Shared Helm chart repos", required: true },
  { id: "ingress-nginx-external", label: "Ingress Nginx (external)", hint: "External HTTP/HTTPS ingress controller", required: true },
  { id: "cert-manager", label: "Cert Manager", hint: "Automatic TLS certificates via Let's Encrypt", required: false, secrets: ["secret-cloudflare.yaml"] },
  { id: "external-dns", label: "External DNS", hint: "Automatic DNS records in Cloudflare", required: false, secrets: ["secret-cloudflare.yaml"] },
  { id: "prometheus-operator-crds", label: "Prometheus CRDs", hint: "Monitoring custom resource definitions", required: true },
  { id: "grafana-operator", label: "Grafana Operator", hint: "Grafana dashboards and datasources via CRDs", required: false, subdomain: "grafana" },
  { id: "victoria-metrics-k8s-stack", label: "Victoria Metrics Stack", hint: "Metrics collection, alerting and long-term storage", required: false, subdomain: "victoria" },
  { id: "flux-web", label: "Flux Web UI", hint: "Web dashboard for Flux status", required: false, subdomain: "flux" },
  { id: "openclaw", label: "OpenClaw", hint: "AI gateway — OpenAI API key or Codex (OAuth) after install", required: false, secrets: ["secret-openclaw-envs.yaml"], subdomain: "openclaw" },
];

export const REQUIRED_COMPONENT_IDS = COMPONENTS.filter((c) => c.required).map((c) => c.id);
export const DNS_TLS_COMPONENT_IDS = ["cert-manager", "external-dns"];
export const MONITORING_COMPONENT_IDS = ["grafana-operator", "victoria-metrics-k8s-stack"];
export const OPTIONAL_COMPONENTS = COMPONENTS.filter(
  (c) => !c.required && !DNS_TLS_COMPONENT_IDS.includes(c.id) && !MONITORING_COMPONENT_IDS.includes(c.id),
);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const KUBERNETES_VERSION = "1.35.1";
/** Host for the canonical GitOps template repository (clone + template sync upstream). */
export const SOURCE_TEMPLATE_HOST = "github.com";
/** owner/repo for the template (used in HTTPS URL and GitHub API paths). */
export const SOURCE_PROJECT_PATH = "GitOpsAI/gitops-ai-template";
export const INSTALL_PLAN_PATH = "/tmp/installplan.json";

export function isShortLivedGitHubToken(token: string): boolean {
  return token.startsWith("gho_") || token.startsWith("ghu_");
}

export function shouldUseSshDeployKey(config: BootstrapConfig): boolean {
  return (
    config.gitProvider === "github" &&
    isShortLivedGitHubToken(config.gitToken) &&
    !config.gitFluxToken
  );
}

/**
 * Username for the Flux GitRepository HTTPS secret (`username` / `password` keys).
 * GitHub rejects generic usernames with PATs in many clients — use `x-access-token`.
 * GitLab expects `oauth2` for HTTPS + token.
 */
export function httpsGitCredentialUsername(
  config: Pick<BootstrapConfig, "gitProvider">,
): string {
  return config.gitProvider === "github" ? "x-access-token" : "oauth2";
}

export function defaultSopsConfig(repoRoot: string): SopsConfig {
  const keyDir = process.env.SOPS_AGE_KEY_DIR ?? `${process.env.HOME}/.sops`;
  return {
    keyDir,
    keyFile: `${keyDir}/age.agekey`,
    namespace: process.env.SOPS_NAMESPACE ?? "flux-system",
    secretName: process.env.SOPS_SECRET_NAME ?? "sops-age",
    configFile: `${repoRoot}/.sops.yaml`,
    backupDir: `${keyDir}/backups`,
  };
}
