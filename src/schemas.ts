import { z } from "zod";

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

export const ClusterConfigSchema = z.object({
  clusterName: z.string().min(1),
  clusterDomain: z
    .string()
    .min(1)
    .refine((v) => v.includes("."), "Must be a valid domain"),
  clusterPublicIp: z.string().min(1),
  letsencryptEmail: z.string().optional(),
  ingressAllowedIps: z.string().min(1),
});

export const GitLabConfigSchema = z.object({
  gitlabPat: z.string().min(1, "GitLab PAT is required"),
  repoName: z.string().min(1),
  repoOwner: z.string().min(1),
  repoBranch: z.string().min(1),
});

export const SecretsConfigSchema = z.object({
  cloudflareApiToken: z.string().optional(),
  openaiApiKey: z.string().optional(),
  openclawGatewayToken: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ClusterConfig = z.infer<typeof ClusterConfigSchema>;
export type GitLabConfig = z.infer<typeof GitLabConfigSchema>;
export type SecretsConfig = z.infer<typeof SecretsConfigSchema>;
export type BootstrapConfig = ClusterConfig &
  GitLabConfig &
  SecretsConfig & {
    selectedComponents: string[];
  };

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
  { id: "flux-web", label: "Flux Web UI", hint: "Web dashboard for Flux status", required: false, subdomain: "flux" },
  { id: "openclaw", label: "OpenClaw", hint: "AI assistant gateway (requires OpenAI key)", required: false, secrets: ["secret-openclaw-envs.yaml"], subdomain: "openclaw" },
];

export const REQUIRED_COMPONENT_IDS = COMPONENTS.filter((c) => c.required).map((c) => c.id);
export const DNS_TLS_COMPONENT_IDS = ["cert-manager", "external-dns"];
export const OPTIONAL_COMPONENTS = COMPONENTS.filter(
  (c) => !c.required && !DNS_TLS_COMPONENT_IDS.includes(c.id),
);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const KUBERNETES_VERSION = "1.35.1";
export const SOURCE_GITLAB_HOST = "gitlab.com";
export const SOURCE_PROJECT_PATH =
  "everythings-gonna-be-alright/fluxcd_ai_template";
export const INSTALL_PLAN_PATH = "/tmp/installplan.json";

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
