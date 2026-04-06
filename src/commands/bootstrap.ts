import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  header,
  log,
  summary,
  nextSteps,
  finish,
  handleCancel,
  withSpinner,
  runStep,
  formatError,
} from "../utils/log.js";
import { saveInstallPlan, loadInstallPlan, clearInstallPlan } from "../utils/config.js";
import { execAsync, exec, execSafe, commandExists } from "../utils/shell.js";
import { isMacOS, isCI } from "../utils/platform.js";
import { ensureAll, ensureDockerDaemonReady } from "../core/dependencies.js";
import { runBootstrap, stripTemplateGitHubDirectory } from "../core/bootstrap-runner.js";
import * as k8s from "../core/kubernetes.js";
import * as k8sApi from "../core/k8s-api.js";
import * as flux from "../core/flux.js";
import {
  getProvider,
  type GitProvider,
  type ProviderType,
} from "../core/git-provider.js";
import {
  COMPONENTS,
  REQUIRED_COMPONENT_IDS,
  DNS_TLS_COMPONENT_IDS,
  MONITORING_COMPONENT_IDS,
  OPTIONAL_COMPONENTS,
  SOURCE_TEMPLATE_HOST,
  SOURCE_PROJECT_PATH,
  type BootstrapConfig,
  type ComponentDef,
} from "../schemas.js";
import { fetchTemplateTags, readPackageVersion } from "../core/template-sync.js";
import {
  stepWizard,
  back,
  maskSecret,
  type WizardField,
} from "../utils/wizard.js";
import { loginAndCreateCloudflareToken } from "../core/cloudflare-oauth.js";

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

const OPENAI_API_KEYS_URL = "https://platform.openai.com/api-keys";

// ---------------------------------------------------------------------------
// Wizard state
// ---------------------------------------------------------------------------

interface WizardState {
  gitProvider: ProviderType;
  setupMode: "new" | "existing";
  manageDnsAndTls: boolean;
  selectedComponents: string[];
  clusterName: string;
  clusterDomain: string;
  repoName: string;
  repoLocalPath: string;
  repoOwner: string;
  repoBranch: string;
  templateTag: string;
  letsencryptEmail: string;
  gitToken: string;
  gitFluxToken: string;
  cloudflareApiToken: string;
  openaiApiKey: string;
  openclawGatewayToken: string;
  ingressAllowedIps: string;
  clusterPublicIp: string;
  /** When true, show Git branch + template tag prompts; otherwise use main/main defaults. */
  enableAdditionalSettings: boolean;
}

function isNewRepo(state: WizardState): boolean {
  return state.setupMode === "new";
}

function dnsAndTlsEnabled(state: WizardState): boolean {
  return state.manageDnsAndTls;
}

function openclawEnabled(state: WizardState): boolean {
  return state.selectedComponents.includes("openclaw");
}

function componentLabel(id: string): string {
  return COMPONENTS.find((c) => c.id === id)?.label ?? id;
}

// fetchTemplateTags is imported from core/template-sync.ts

function providerLabel(type: ProviderType): string {
  return type === "gitlab" ? "GitLab" : "GitHub";
}

async function enrichWithUser(
  state: WizardState,
  token: string,
  provider: GitProvider,
): Promise<WizardState> {
  try {
    const user = await provider.fetchCurrentUser(token, provider.defaultHost);
    log.success(`Logged in as ${user.username}`);
    return {
      ...state,
      gitToken: token,
      repoOwner: state.repoOwner || user.username,
    };
  } catch (err) {
    log.warn(`Could not detect ${providerLabel(state.gitProvider)} user: ${(err as Error).message}`);
    return { ...state, gitToken: token };
  }
}

// ---------------------------------------------------------------------------
// Wizard field definitions (Esc / Ctrl+C = go back one field)
// ---------------------------------------------------------------------------

function buildFields(
  detectedIp: string,
  hasSavedPlan: boolean,
  savedPlanRaw: Record<string, string> | null,
): WizardField<WizardState>[] {
  const saved = (state: WizardState, key: keyof WizardState) =>
    hasSavedPlan && !!state[key];
  const skipAdditionalSettingsToggle =
    hasSavedPlan &&
    savedPlanRaw != null &&
    savedPlanRaw.enableAdditionalSettings !== undefined;

  return [
    // ── Setup Mode ──────────────────────────────────────────────────────
    {
      id: "setupMode",
      section: "Setup Mode",
      skip: (state) => saved(state, "setupMode"),
      run: async (state) => {
        const v = await p.select({
          message: pc.bold("How would you like to setup your cluster?"),
          options: [
            {
              value: "new",
              label: ("Init a new gitops repo"),
              hint: "clone, push, and bootstrap",
            },
            {
              value: "existing",
              label: "I already have a repo",
              hint: "bootstrap from existing gitops repo",
            },
          ],
          initialValue: state.setupMode,
        });
        if (p.isCancel(v)) return back();
        return { ...state, setupMode: v as "new" | "existing" };
      },
      review: (state) => [
        "Mode",
        state.setupMode === "new"
          ? "Create new repo from template"
          : "Use existing repo",
      ],
    },

    // ── Git Provider ────────────────────────────────────────────────────
    {
      id: "gitProvider",
      section: "Git Provider",
      skip: (state) => saved(state, "gitProvider"),
      run: async (state) => {
        const v = await p.select({
          message: pc.bold("Which Git provider do you want to use?"),
          options: [
            {
              value: "github",
              label: "GitHub",
              hint: "github.com or GitHub Enterprise",
            },
            {
              value: "gitlab",
              label: "GitLab",
              hint: "gitlab.com or self-hosted",
            },
          ],
          initialValue: state.gitProvider,
        });
        if (p.isCancel(v)) return back();
        return { ...state, gitProvider: v as ProviderType };
      },
      review: (state) => ["Provider", providerLabel(state.gitProvider)],
    },

    // ── Git Repository ──────────────────────────────────────────────────
    {
      id: "gitToken",
      section: "Git Repository",
      skip: (state) => !!state.gitToken,
      run: async (state) => {
        const provider = await getProvider(state.gitProvider);

        if (isCI()) {
          const v = await p.password({
            message: pc.bold(provider.tokenLabel),
            validate: (v) => { if (!v) return "Required"; },
          });
          if (p.isCancel(v)) return back();
          return { ...state, gitToken: v as string };
        }

        const method = await p.select({
          message: pc.bold(`How would you like to authenticate with ${providerLabel(state.gitProvider)}?`),
          options: [
            {
              value: "browser",
              label: "Login with browser",
              hint: `opens ${providerLabel(state.gitProvider)} in your browser — recommended`,
            },
            {
              value: "pat",
              label: "Paste a Personal Access Token",
              hint: "manual token entry",
            },
          ],
        });
        if (p.isCancel(method)) return back();

        if (method === "browser") {
          try {
            const token = await provider.loginWithBrowser(provider.defaultHost);
            log.success("Authenticated via browser");
            return await enrichWithUser(state, token, provider);
          } catch (err) {
            log.warn(`Browser login failed: ${(err as Error).message}`);
            log.warn("Falling back to manual token entry");
          }
        }

        const v = await p.password({
          message: pc.bold(provider.tokenLabel),
          validate: (v) => { if (!v) return "Required"; },
        });
        if (p.isCancel(v)) return back();
        return await enrichWithUser(state, v as string, provider);
      },
      review: (state) => ["Token", maskSecret(state.gitToken)],
    },
    {
      id: "repoOwner",
      section: "Git Repository",
      skip: (state) => !!state.repoOwner,
      run: async (state) => {
        const provider = await getProvider(state.gitProvider);
        const label = providerLabel(state.gitProvider);
        const orgLabel = state.gitProvider === "gitlab" ? "group" : "org";

        try {
          const user = await provider.fetchCurrentUser(
            state.gitToken,
            provider.defaultHost,
          );

          let orgs: { fullPath: string; name: string }[] = [];
          try {
            orgs = await provider.fetchOrganizations(
              state.gitToken,
              provider.defaultHost,
            );
          } catch {
            /* no orgs or insufficient permissions — continue with personal only */
          }

          const options: { value: string; label: string; hint?: string }[] = [
            {
              value: user.username,
              label: user.username,
              hint: `personal · ${user.name}`,
            },
            ...orgs.map((g) => ({
              value: g.fullPath,
              label: g.fullPath,
              hint: orgLabel,
            })),
            {
              value: "__manual__",
              label: "Enter manually…",
              hint: "type a namespace",
            },
          ];

          const v = await p.select({
            message: pc.bold(`${label} namespace for the repository`),
            options,
            initialValue: state.repoOwner || user.username,
          });
          if (p.isCancel(v)) return back();

          if (v !== "__manual__") {
            return { ...state, repoOwner: v as string };
          }
        } catch {
          /* API unavailable — fall through to manual input */
        }

        const v = await p.text({
          message: pc.bold(`${label} repo owner / namespace`),
          placeholder: "my-username-or-group",
          initialValue: state.repoOwner || undefined,
          validate: (v) => {
            if (!v) return "Required";
          },
        });
        if (p.isCancel(v)) return back();
        return { ...state, repoOwner: v as string };
      },
      review: (state) => ["Repo owner", state.repoOwner],
    },
    {
      id: "repoName",
      section: "Git Repository",
      skip: (state) => saved(state, "repoName"),
      run: async (state) => {
        if (isNewRepo(state)) {
          const v = await p.text({
            message: pc.bold("New repository name"),
            placeholder: "fluxcd_ai",
            defaultValue: state.repoName,
          });
          if (p.isCancel(v)) return back();
          return { ...state, repoName: v as string };
        }

        const provider = await getProvider(state.gitProvider);
        try {
          const projects = await provider.fetchNamespaceProjects(
            state.gitToken,
            provider.defaultHost,
            state.repoOwner,
          );
          if (projects.length > 0) {
            const options: { value: string; label: string; hint?: string }[] = [
              ...projects.map((proj) => ({
                value: proj.name,
                label: proj.name,
                hint: proj.description
                  ? proj.description.slice(0, 60)
                  : undefined,
              })),
              {
                value: "__manual__",
                label: "Enter manually…",
                hint: "type a repo name",
              },
            ];

            const v = await p.select({
              message: pc.bold("Select repository"),
              options,
              initialValue: state.repoName || undefined,
            });
            if (p.isCancel(v)) return back();

            if (v !== "__manual__") {
              return { ...state, repoName: v as string };
            }
          }
        } catch {
          /* fall through to manual input */
        }

        const v = await p.text({
          message: pc.bold("Flux repo name"),
          placeholder: "fluxcd_ai",
          defaultValue: state.repoName,
        });
        if (p.isCancel(v)) return back();
        return { ...state, repoName: v as string };
      },
      review: (state) => ["Repo name", state.repoName],
    },
    {
      id: "repoLocalPath",
      section: "Git Repository",
      skip: (state) => saved(state, "repoLocalPath"),
      run: async (state) => {
        if (isNewRepo(state)) {
          const v = await p.text({
            message: pc.bold("Local directory to clone into"),
            placeholder: `./${state.repoName}  (relative to current directory)`,
            defaultValue: state.repoLocalPath || state.repoName,
          });
          if (p.isCancel(v)) return back();
          return { ...state, repoLocalPath: v as string };
        }
        const v = await p.text({
          message: pc.bold("Path to your local repo checkout"),
          placeholder: `./${state.repoName}  (relative or absolute path)`,
          defaultValue: state.repoLocalPath || ".",
          validate: (val) => {
            const target = resolve(val || ".");
            if (!existsSync(target)) return "Directory does not exist";
            const gitCheck = execSafe("git rev-parse --is-inside-work-tree", { cwd: target });
            if (gitCheck.exitCode !== 0) return "Not a git repository — run git init or clone first";
            return undefined;
          },
        });
        if (p.isCancel(v)) return back();
        return { ...state, repoLocalPath: v as string };
      },
      review: (state) =>
        isNewRepo(state)
          ? ["Local path", `./${state.repoLocalPath}`]
          : ["Local repo path", resolve(state.repoLocalPath || ".")],
    },

    // ── DNS & TLS ─────────────────────────────────────────────────────────
    {
      id: "manageDnsAndTls",
      section: "DNS & TLS",
      skip: (state) => saved(state, "manageDnsAndTls"),
      run: async (state) => {
        const v = await p.confirm({
          message:
            pc.bold("Do you want to manage DNS and TLS (HTTPS) certificates automatically?") +
            `\n${pc.dim("Existing DNS domain on Cloudflare required")}`,
          initialValue: state.manageDnsAndTls,
        });
        if (p.isCancel(v)) return back();
        return { ...state, manageDnsAndTls: v as boolean };
      },
      review: (state) => [
        "Auto DNS & TLS",
        state.manageDnsAndTls
          ? "Yes — Cert Manager + External DNS (Cloudflare)"
          : "No — manual DNS & certificates",
      ],
    },

    // ── Components ───────────────────────────────────────────────────────
    {
      id: "selectedComponents",
      section: "Components",
      skip: (state) => saved(state, "selectedComponents"),
      run: async (state) => {
        const MONITORING_GROUP_ID = "__monitoring__";
        const monitoringOption = {
          value: MONITORING_GROUP_ID,
          label: "Monitoring Stack",
          hint: "Victoria Metrics + Grafana Operator (dashboards, alerting, metrics)",
        };

        const hasMonitoring = MONITORING_COMPONENT_IDS.every((id) =>
          state.selectedComponents.includes(id),
        );
        const monitoringExplicitlyRemoved = !hasMonitoring
          && state.selectedComponents.some((id) => !REQUIRED_COMPONENT_IDS.includes(id));

        const selected = await p.multiselect({
          message: pc.bold("Optional components to install"),
          options: [
            monitoringOption,
            ...OPTIONAL_COMPONENTS.map((c) => ({
              value: c.id,
              label: c.label,
              hint: c.hint,
            })),
          ],
          initialValues: [
            ...((hasMonitoring || !monitoringExplicitlyRemoved) ? [MONITORING_GROUP_ID] : []),
            ...state.selectedComponents.filter((id) =>
              OPTIONAL_COMPONENTS.some((c) => c.id === id),
            ),
          ],
          required: false,
        });
        if (p.isCancel(selected)) return back();

        const picks = selected as string[];
        const monitoringIds = picks.includes(MONITORING_GROUP_ID) ? MONITORING_COMPONENT_IDS : [];
        const otherIds = picks.filter((id) => id !== MONITORING_GROUP_ID);
        const dnsTlsIds = state.manageDnsAndTls ? DNS_TLS_COMPONENT_IDS : [];

        return {
          ...state,
          selectedComponents: [
            ...REQUIRED_COMPONENT_IDS,
            ...dnsTlsIds,
            ...monitoringIds,
            ...otherIds,
          ],
        };
      },
      review: (state) => [
        "Enabled",
        state.selectedComponents.map(componentLabel).join(", "),
      ],
    },

    // ── Cluster ──────────────────────────────────────────────────────────
    {
      id: "clusterName",
      section: "Cluster",
      skip: (state) => saved(state, "clusterName"),
      run: async (state) => {
        const v = await p.text({
          message: pc.bold("Kubernetes cluster name"),
          placeholder: "homelab",
          defaultValue: state.clusterName,
        });
        if (p.isCancel(v)) return back();
        return { ...state, clusterName: v as string };
      },
      review: (state) => ["Name", state.clusterName],
    },
    {
      id: "clusterDomain",
      section: "Cluster",
      skip: (state) => saved(state, "clusterDomain"),
      run: async (state) => {
        const v = await p.text({
          message:
          pc.bold("DNS domain for your cluster"),
          placeholder: "homelab.click",
          defaultValue: state.clusterDomain,
          validate: (v) => {
            if (v && !v.includes(".")) return "Must be a valid domain";
          },
        });
        if (p.isCancel(v)) return back();
        return { ...state, clusterDomain: v as string };
      },
      review: (state) => ["Domain", state.clusterDomain],
    },

    // ── Credentials & Secrets ────────────────────────────────────────────
    {
      id: "letsencryptEmail",
      section: "Credentials & Secrets",
      hidden: (state) => !dnsAndTlsEnabled(state),
      skip: (state) => saved(state, "letsencryptEmail"),
      run: async (state) => {
        const v = await p.text({
          message: pc.bold("Your email for Let's Encrypt certificate issuance"),
          defaultValue: state.letsencryptEmail,
          validate: (v) => {
            if (!v || !v.includes("@")) return "Must be a valid email";
          },
        });
        if (p.isCancel(v)) return back();
        return { ...state, letsencryptEmail: v as string };
      },
      review: (state) => ["Let's Encrypt email", state.letsencryptEmail],
    },
    {
      id: "cloudflareApiToken",
      section: "Credentials & Secrets",
      hidden: (state) => !dnsAndTlsEnabled(state),
      skip: (state) => !!state.cloudflareApiToken,
      run: async (state) => {
        if (isCI()) {
          const v = await p.password({
            message: pc.bold("Cloudflare API Token (DNS zone edit access)"),
            validate: (v) => { if (!v) return "Required"; },
          });
          if (p.isCancel(v)) return back();
          return { ...state, cloudflareApiToken: v as string };
        }

        const method = await p.select({
          message: pc.bold("How would you like to authenticate with Cloudflare?"),
          options: [
            {
              value: "browser",
              label: "Open dashboard (recommended)",
              hint: "pre-filled Edit zone DNS token — works over SSH / remote",
            },
            {
              value: "pat",
              label: "Paste an API Token",
              hint: "you already have a token",
            },
          ],
        });
        if (p.isCancel(method)) return back();

        if (method === "browser") {
          try {
            const token = await loginAndCreateCloudflareToken(state.clusterDomain);
            return { ...state, cloudflareApiToken: token };
          } catch (err) {
            log.warn(`Cloudflare token step failed: ${(err as Error).message}`);
            log.warn("Paste an API token manually below, or restart and choose that option.");
          }
        }

        const v = await p.password({
          message: pc.bold("Cloudflare API Token (DNS zone edit access)"),
          validate: (v) => { if (!v) return "Required"; },
        });
        if (p.isCancel(v)) return back();
        return { ...state, cloudflareApiToken: v as string };
      },
      review: (state) => [
        "Cloudflare token",
        maskSecret(state.cloudflareApiToken),
      ],
    },
    {
      id: "openaiApiKey",
      section: "Credentials & Secrets",
      hidden: (state) => !openclawEnabled(state),
      skip: (state) => !!state.openaiApiKey,
      run: async (state) => {
        if (isCI()) {
          const v = await p.password({
            message: pc.bold("OpenAI API Key"),
            validate: (v) => { if (!v) return "Required"; },
          });
          if (p.isCancel(v)) return back();
          const openclawGatewayToken =
            state.openclawGatewayToken || exec("openssl rand -hex 32");
          return { ...state, openaiApiKey: v as string, openclawGatewayToken };
        }

        const method = await p.select({
          message: pc.bold("How would you like to provide your OpenAI API key?"),
          options: [
            {
              value: "browser",
              label: "Open dashboard in browser",
              hint: "opens platform.openai.com to create a key — recommended",
            },
            {
              value: "paste",
              label: "Paste an API Key",
              hint: "manual key entry",
            },
          ],
        });
        if (p.isCancel(method)) return back();

        if (method === "browser") {
          p.note(
            `${pc.bold("Create an API key with these steps:")}\n\n` +
              `  1. Log in to ${pc.cyan("platform.openai.com")}\n` +
              `  2. Click ${pc.cyan("+ Create new secret key")}\n` +
              `  3. Name it (e.g. ${pc.cyan("gitops-ai")})\n` +
              `  4. Copy the key value\n\n` +
              pc.dim("The key starts with sk-… and is only shown once."),
            "OpenAI API Key",
          );
          await p.text({
            message: pc.dim("Press ") + pc.bold(pc.yellow("Enter")) + pc.dim(" to open browser…"),
            defaultValue: "",
          });
          openUrl(OPENAI_API_KEYS_URL);
        }

        const v = await p.password({
          message: pc.bold("Paste the OpenAI API key"),
          validate: (v) => { if (!v) return "Required"; },
        });
        if (p.isCancel(v)) return back();
        const openclawGatewayToken =
          state.openclawGatewayToken || exec("openssl rand -hex 32");
        return {
          ...state,
          openaiApiKey: v as string,
          openclawGatewayToken,
        };
      },
      review: (state) => ["OpenAI key", maskSecret(state.openaiApiKey)],
    },

    // ── Network ──────────────────────────────────────────────────────────
    {
      id: "networkAccessMode",
      section: "Network",
      skip: (state) => saved(state, "ingressAllowedIps") && saved(state, "clusterPublicIp"),
      run: async (state) => {
        const mode = await p.select({
          message: pc.bold("How will you access the cluster?"),
          options: [
            {
              value: "public",
              label: "Public",
              hint: "auto-detects your public IP",
            },
            {
              value: "local",
              label: "Local only (localhost / LAN)",
              hint: "uses 127.0.0.1 or a private IP",
            },
          ],
        });
        if (p.isCancel(mode)) return back();

        const m = mode as string;

        async function resolvePublicIp(): Promise<string> {
          if (detectedIp) return detectedIp;
          const services = ["ifconfig.me", "api.ipify.org", "icanhazip.com"];
          await withSpinner("Detecting public IP", async () => {
            for (const svc of services) {
              try {
                const ip = (await execAsync(`curl -s --max-time 4 ${svc}`)).trim();
                if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) { detectedIp = ip; return; }
              } catch { /* try next */ }
            }
          });
          return detectedIp;
        }

        if (m === "public") {
          const publicIp = await resolvePublicIp();
          const confirmIp = await p.text({
            message: pc.bold("Public IP of your cluster"),
            ...(publicIp
              ? { initialValue: publicIp }
              : { placeholder: "x.x.x.x" }),
            validate: (v) => { if (!v) return "Required"; },
          });
          if (p.isCancel(confirmIp)) return back();

          const restriction = await p.select({
            message: pc.bold("Restrict ingress access?"),
            options: [
              {
                value: "open",
                label: "Open to everyone (0.0.0.0/0)",
                hint: "any IP can reach the cluster",
              },
              {
                value: "restrict",
                label: "Restrict to specific IPs",
                hint: "only listed CIDRs can reach the cluster",
              },
            ],
          });
          if (p.isCancel(restriction)) return back();

          if (restriction === "open") {
            return { ...state, clusterPublicIp: confirmIp as string, ingressAllowedIps: "0.0.0.0/0" };
          }

          const allowedCidrs = await p.text({
            message: pc.bold("Allowed CIDRs (comma-separated)"),
            placeholder: "203.0.113.0/24,198.51.100.5/32",
            validate: (v) => { if (!v) return "At least one CIDR is required"; },
          });
          if (p.isCancel(allowedCidrs)) return back();
          return { ...state, clusterPublicIp: confirmIp as string, ingressAllowedIps: allowedCidrs as string };
        }

        // local — detect LAN IPs from network interfaces
        const lanIps: { ip: string; iface: string }[] = [];
        const ifaces = networkInterfaces();
        for (const [name, addrs] of Object.entries(ifaces)) {
          for (const addr of addrs ?? []) {
            if (addr.family === "IPv4" && !addr.internal) {
              lanIps.push({ ip: addr.address, iface: name });
            }
          }
        }

        let localIp: string | symbol;
        if (lanIps.length > 0) {
          localIp = await p.select({
            message: pc.bold("Cluster IP"),
            options: [
              ...lanIps.map((l) => ({
                value: l.ip,
                label: l.ip,
                hint: l.iface,
              })),
              { value: "127.0.0.1", label: "127.0.0.1", hint: "localhost" },
              { value: "__custom__", label: "Enter manually" },
            ],
          });
          if (p.isCancel(localIp)) return back();
          if (localIp === "__custom__") {
            localIp = await p.text({
              message: pc.bold("Cluster IP"),
              placeholder: "192.168.x.x",
              validate: (v) => { if (!v) return "Required"; },
            });
            if (p.isCancel(localIp)) return back();
          }
        } else {
          localIp = await p.text({
            message: pc.bold("Cluster IP") + pc.dim("  (127.0.0.1 for localhost, or your LAN IP)"),
            defaultValue: "127.0.0.1",
          });
        }
        if (p.isCancel(localIp)) return back();

        const allowedIps = await p.text({
          message: pc.bold("IPs allowed to access the cluster (CIDR)"),
          defaultValue: "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16",
          placeholder: "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16",
        });
        if (p.isCancel(allowedIps)) return back();
        return { ...state, clusterPublicIp: localIp as string, ingressAllowedIps: allowedIps as string };
      },
      review: (state) => ["Network", `${state.clusterPublicIp}  allowed: ${state.ingressAllowedIps}`],
    },

    // ── Additional settings (last — rarely needed) ─────────────────────────
    {
      id: "enableAdditionalSettings",
      section: "Additional settings",
      skip: () => skipAdditionalSettingsToggle,
      run: async (state) => {
        const v = await p.confirm({
          message:
            pc.bold("Setup additional settings?") +
            `\n${pc.dim("Regularly not needed")}`,
          initialValue: state.enableAdditionalSettings,
        });
        if (p.isCancel(v)) return back();
        return { ...state, enableAdditionalSettings: v as boolean };
      },
      review: (state) => [
        "Customize branch & template",
        state.enableAdditionalSettings
          ? "Yes"
          : "No — defaults (main / main)",
      ],
    },
    {
      id: "repoBranch",
      section: "Additional settings",
      hidden: (state) => !state.enableAdditionalSettings,
      skip: (state) => saved(state, "repoBranch"),
      run: async (state) => {
        const v = await p.text({
          message: pc.bold("Git branch for Flux"),
          placeholder: "main",
          defaultValue: state.repoBranch,
        });
        if (p.isCancel(v)) return back();
        return { ...state, repoBranch: v as string };
      },
      review: (state) => ["Flux Git branch", state.repoBranch],
    },
    {
      id: "templateTag",
      section: "Additional settings",
      hidden: (state) =>
        !isNewRepo(state) || !state.enableAdditionalSettings,
      skip: (state) => saved(state, "templateTag"),
      run: async (state) => {
        const tags = await fetchTemplateTags();

        if (tags.length > 0) {
          const options: { value: string; label: string; hint?: string }[] = [
            ...tags.map((tag, i) => ({
              value: tag,
              label: tag,
              hint: i === 0 ? "latest" : undefined,
            })),
            {
              value: "__manual__",
              label: "Enter manually…",
              hint: "type a tag or branch name",
            },
          ];

          const v = await p.select({
            message: pc.bold("Template version (tag) to clone"),
            options,
            initialValue: state.templateTag || tags[0],
          });
          if (p.isCancel(v)) return back();

          if (v !== "__manual__") {
            return { ...state, templateTag: v as string };
          }
        }

        const v = await p.text({
          message: pc.bold("Template tag or branch to clone"),
          placeholder: "main",
          defaultValue: state.templateTag || "main",
        });
        if (p.isCancel(v)) return back();
        return { ...state, templateTag: v as string };
      },
      review: (state) => ["Template tag", state.templateTag],
    },
  ];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Repo creation phase (only for "new" mode)
// ---------------------------------------------------------------------------

async function createAndCloneRepo(wizard: WizardState): Promise<string> {
  const provider = await getProvider(wizard.gitProvider);
  const label = providerLabel(wizard.gitProvider);
  const host = provider.defaultHost;

  log.step(`Authenticating with ${label}`);
  await provider.authenticate(wizard.gitToken, host);

  log.step(`Resolving namespace '${wizard.repoOwner}'`);
  const namespaceId = await provider.resolveNamespaceId(
    wizard.repoOwner,
    host,
    wizard.gitToken,
  );

  log.step(`Creating project ${wizard.repoOwner}/${wizard.repoName}`);
  const existing = await provider.getProject(
    wizard.repoOwner,
    wizard.repoName,
    host,
    wizard.gitToken,
  );

  let httpUrl: string;
  let pathWithNs: string;
  let repoExisted = false;

  if (existing) {
    log.warn(
      `Project '${wizard.repoOwner}/${wizard.repoName}' already exists (ID: ${existing.id})`,
    );
    const useExisting = await p.confirm({
      message: "Use existing repository?",
      initialValue: false,
    });
    if (p.isCancel(useExisting) || !useExisting) {
      log.error(
        "Aborting. Choose a different repo name or remove the existing project.",
      );
      return process.exit(1) as never;
    }
    repoExisted = true;
    httpUrl = existing.httpUrl;
    pathWithNs = existing.pathWithNamespace;
    log.success(`Using existing: ${pathWithNs}`);
  } else {
    const created = await withSpinner(`Creating ${label} project`, () =>
      provider.createProject(wizard.repoName, namespaceId, host, wizard.gitToken),
    );
    httpUrl = created.httpUrl;
    pathWithNs = created.pathWithNamespace;
    log.success(`Created: ${pathWithNs}`);
  }

  const cloneDir = wizard.repoLocalPath || wizard.repoName;
  /** Set when we `git clone` the template; full clone includes `.github` — strip before push (OAuth lacks `workflow` scope). */
  let clonedTemplateFromUpstream = false;

  if (existsSync(cloneDir)) {
    log.warn(`Directory './${cloneDir}' already exists locally`);
    const useDir = await p.confirm({
      message: "Use existing directory?",
      initialValue: false,
    });
    if (p.isCancel(useDir) || !useDir) {
      log.error(
        "Aborting. Remove or rename the existing directory and try again.",
      );
      return process.exit(1) as never;
    }
    try {
      exec(`git remote set-url origin "${httpUrl}"`, { cwd: cloneDir });
    } catch {
      exec(`git remote add origin "${httpUrl}"`, { cwd: cloneDir });
    }
  } else {
    clonedTemplateFromUpstream = true;
    const cloneRef = wizard.templateTag || "main";
    let clonedRef = cloneRef;
    try {
      await withSpinner(`Cloning template (${cloneRef})`, () =>
        execAsync(
          `git clone --quiet --branch "${cloneRef}" "https://${SOURCE_TEMPLATE_HOST}/${SOURCE_PROJECT_PATH}.git" "${cloneDir}"`,
        ),
      );
    } catch {
      log.warn(`Tag/branch '${cloneRef}' not found — falling back to 'main'`);
      clonedRef = "main";
      await withSpinner("Cloning template (main)", () =>
        execAsync(
          `git clone --quiet --branch "main" "https://${SOURCE_TEMPLATE_HOST}/${SOURCE_PROJECT_PATH}.git" "${cloneDir}"`,
        ),
      );
    }

    if (clonedRef !== wizard.repoBranch) {
      exec(`git checkout -B "${wizard.repoBranch}"`, { cwd: cloneDir });
    }

    exec(`git remote set-url origin "${httpUrl}"`, { cwd: cloneDir });
  }

  const authRemote = provider.getAuthRemoteUrl(host, pathWithNs, wizard.gitToken);

  await withSpinner(`Pushing to ${pathWithNs}`, async () => {
    if (clonedTemplateFromUpstream) {
      await stripTemplateGitHubDirectory(cloneDir);
    }
    const forceFlag = repoExisted ? " --force" : "";
    return execAsync(
      `git push -u "${authRemote}" "${wizard.repoBranch}"${forceFlag} --quiet`,
      { cwd: cloneDir },
    );
  });

  exec(`git remote set-url origin "${httpUrl}"`, { cwd: cloneDir });

  summary("Repository Created", {
    Repository: pathWithNs,
    Directory: cloneDir,
  });

  process.chdir(cloneDir);
  return process.cwd();
}

// ---------------------------------------------------------------------------
// Openclaw device pairing (sub-command)
// ---------------------------------------------------------------------------

export async function openclawPair(): Promise<void> {
  header("OpenClaw Device Pairing");

  p.log.info("1. Open Claude UI in your browser");
  p.log.info("2. Enter your Gateway Token and click Connect");

  const ready = await p.confirm({
    message: "Have you submitted the pairing request?",
  });
  if (p.isCancel(ready) || !ready) handleCancel();

  log.step("Listing pending device requests");
  try {
    const kc = k8sApi.kubeConfigFromDefault();
    const code = await k8sApi.execInDeploymentContainerTty(
      kc,
      "openclaw",
      "openclaw",
      "main",
      ["node", "dist/index.js", "devices", "list"],
    );
    if (code !== 0) {
      log.error("devices list failed");
      return process.exit(1) as never;
    }
  } catch {
    log.error("Failed to list device requests");
    return process.exit(1) as never;
  }

  const requestId = await p.text({
    message: "Enter REQUEST_ID to approve",
    validate: (v) => {
      if (!v) return "REQUEST_ID must not be empty";
    },
  });
  if (p.isCancel(requestId)) handleCancel();

  log.step(`Approving device ${requestId}`);
  const kcApprove = k8sApi.kubeConfigFromDefault();
  const approve = await k8sApi.execInDeploymentContainer(
    kcApprove,
    "openclaw",
    "openclaw",
    "main",
    ["node", "dist/index.js", "devices", "approve", requestId as string],
  );
  if (approve.exitCode !== 0) {
    log.error(approve.stderr || "approve failed");
    return process.exit(1) as never;
  }
  log.success("Device paired successfully");
}

// ---------------------------------------------------------------------------
// Main bootstrap flow
// ---------------------------------------------------------------------------

export async function bootstrap(): Promise<void> {
  // Ctrl+C exits immediately; Escape goes back one wizard step
  (p.settings?.aliases as Map<string, string>)?.delete("\x03");
  process.stdin.on("data", (data: Buffer) => {
    if (data[0] === 0x03) {
      console.log();
      p.cancel("Operation cancelled.");
      process.exit(0);
    }
  });

  console.log();
  const version = readPackageVersion();

  const logo = [
    " ▄█████▄ ",
    " ██ ◆ ██ ",
    " ██   ██ ",
    " ▀██ ██▀ ",
    "   ▀█▀   ",
  ];
  const taglines = [
    "💅 Secure, isolated & flexible GitOps infrastructure",
    "🤖 Manage it yourself — or delegate to AI",
    "🔐 Encrypted secrets, hardened containers, continuous delivery",
    "",
    pc.dim(`v${version}`),
  ];
  const banner = logo
    .map((l, i) => pc.cyan(l) + "  " + (taglines[i] ?? ""))
    .join("\n");

  p.box(banner, pc.bold("Welcome to GitOps AI Bootstrapper"), {
    contentAlign: "left",
    titleAlign: "center",
    width: "auto",
    rounded: false,
    formatBorder: (text) => pc.cyan(text),
  });

  // ── Load saved state ─────────────────────────────────────────────────
  const saved = loadInstallPlan();
  if (saved) {
    log.warn("Loading saved inputs from previous run");
  }
  const prev = (saved ?? {}) as Record<string, string>;

  // Backward compat: migrate gitlabPat → gitToken
  if (prev.gitlabPat && !prev.gitToken) {
    prev.gitToken = prev.gitlabPat;
  }

  // ── Check for existing cluster ──────────────────────────────────────
  const existing = k8s.detectExistingClusters();
  if (existing) {
    const clusterList = existing.names
      .map((n) => `  ${pc.cyan(n)}`)
      .join("\n");
    const deleteHint =
      existing.type === "k3d"
        ? `  ${pc.cyan(`k3d cluster delete ${existing.names[0]}`)}`
        : `  ${pc.cyan("sudo /usr/local/bin/k3s-uninstall.sh")}`;

    p.log.warn(
      pc.yellow(`Existing ${existing.type} cluster(s) detected:`),
    );
    p.note(
      `${pc.bold("Clusters found:")}\n${clusterList}\n\n` +
      `Re-bootstrapping may overwrite existing resources.\n` +
      `To start fresh, delete the cluster first:\n` +
      deleteHint + `\n\n` +
      pc.dim("Choose Continue to proceed anyway."),
      "Cluster Already Exists",
    );
    const shouldContinue = await p.confirm({
      message: pc.bold("Continue with the existing cluster?"),
      initialValue: false,
    });
    if (p.isCancel(shouldContinue) || !shouldContinue) {
      finish("Bootstrap cancelled — existing cluster left untouched");
      return;
    }
  }

  // ── Detect public IP (silent, try multiple services) ─────────────────
  let detectedIp = "";
  if (!prev.clusterPublicIp) {
    for (const svc of ["ifconfig.me", "api.ipify.org", "icanhazip.com"]) {
      try {
        const ip = (await execAsync(`curl -s --max-time 4 ${svc}`)).trim();
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) { detectedIp = ip; break; }
      } catch { /* try next */ }
    }
  }

  // ── Run interactive wizard ───────────────────────────────────────────
  const savedDnsTls = prev.manageDnsAndTls !== undefined
    ? prev.manageDnsAndTls === "true"
    : true;

  const savedComponents = prev.selectedComponents
    ? (prev.selectedComponents as string).split(",")
    : [
        ...REQUIRED_COMPONENT_IDS,
        ...(savedDnsTls ? DNS_TLS_COMPONENT_IDS : []),
        ...MONITORING_COMPONENT_IDS,
        ...OPTIONAL_COMPONENTS.map((c) => c.id),
      ];

  const enableAdditionalFromPlan =
    prev.enableAdditionalSettings === "true" ||
    (saved != null &&
      prev.enableAdditionalSettings === undefined &&
      ((prev.repoBranch != null && prev.repoBranch !== "" && prev.repoBranch !== "main") ||
        (prev.templateTag != null &&
          prev.templateTag !== "" &&
          prev.templateTag !== "main")));

  const initialState: WizardState = {
    gitProvider: (prev.gitProvider as ProviderType) ?? "github",
    setupMode: (prev.setupMode as "new" | "existing") ?? "new",
    manageDnsAndTls: savedDnsTls,
    selectedComponents: savedComponents,
    clusterName: prev.clusterName ?? "homelab",
    clusterDomain: prev.clusterDomain ?? "homelab.click",
    repoName: prev.repoName ?? "fluxcd_ai",
    repoLocalPath: prev.repoLocalPath ?? "",
    repoOwner: prev.repoOwner ?? "",
    enableAdditionalSettings: enableAdditionalFromPlan,
    repoBranch: prev.repoBranch ?? "main",
    templateTag: prev.templateTag ?? "",
    letsencryptEmail: prev.letsencryptEmail ?? "",
    gitToken: prev.gitToken ?? "",
    gitFluxToken: prev.gitFluxToken ?? "",
    cloudflareApiToken: prev.cloudflareApiToken ?? "",
    openaiApiKey: prev.openaiApiKey ?? "",
    openclawGatewayToken: prev.openclawGatewayToken ?? "",
    ingressAllowedIps: prev.ingressAllowedIps ?? "0.0.0.0/0",
    clusterPublicIp: prev.clusterPublicIp ?? detectedIp,
  };

  const wizard = await stepWizard(
    buildFields(detectedIp, !!saved, saved),
    initialState,
  );

  // ── Save config ─────────────────────────────────────────────────────
  saveInstallPlan({
    gitProvider: wizard.gitProvider,
    setupMode: wizard.setupMode,
    manageDnsAndTls: String(wizard.manageDnsAndTls),
    clusterName: wizard.clusterName,
    clusterDomain: wizard.clusterDomain,
    clusterPublicIp: wizard.clusterPublicIp,
    letsencryptEmail: wizard.letsencryptEmail,
    ingressAllowedIps: wizard.ingressAllowedIps,
    gitToken: wizard.gitToken,
    gitFluxToken: wizard.gitFluxToken,
    repoName: wizard.repoName,
    repoLocalPath: wizard.repoLocalPath,
    repoOwner: wizard.repoOwner,
    enableAdditionalSettings: String(wizard.enableAdditionalSettings),
    repoBranch: wizard.repoBranch,
    templateTag: wizard.templateTag,
    cloudflareApiToken: wizard.cloudflareApiToken,
    openaiApiKey: wizard.openaiApiKey ?? "",
    openclawGatewayToken: wizard.openclawGatewayToken ?? "",
    selectedComponents: wizard.selectedComponents.join(","),
  });
  log.success("Configuration saved");

  // ── CLI tools: explain + confirm + install only when something is missing ──
  const toolDescriptions: [string, string][] = [
    ["git",            "Version control (repo operations)"],
    ["flux-operator",  "FluxCD Operator CLI (installs Flux into the cluster)"],
    ["sops",           "Mozilla SOPS (secret encryption)"],
    ["age",            "Age encryption (SOPS key backend)"],
  ];
  if (isMacOS()) {
    toolDescriptions.push([
      "docker",
      "Docker-compatible runtime for k3d",
    ]);
  }
  if (isMacOS() || isCI()) {
    toolDescriptions.push(["k3d", "Lightweight K3s in Docker (local cluster)"]);
  }

  const missingToolNames = toolDescriptions
    .filter(([name]) => !commandExists(name))
    .map(([name]) => name);

  if (missingToolNames.length > 0) {
    const toolListFormatted = toolDescriptions
      .map(([name, desc]) => {
        const status = commandExists(name)
          ? pc.green("installed")
          : pc.yellow("will install");
        return `  ${pc.bold(name.padEnd(16))} ${pc.dim(desc)}  [${status}]`;
      })
      .join("\n");

    const uninstallMacFormulae = toolDescriptions
      .map(([name]) => name)
      .filter((n) => n !== "docker")
      .join(" ");
    const uninstallMac =
      isMacOS() && toolDescriptions.some(([n]) => n === "docker")
        ? `brew uninstall ${uninstallMacFormulae} && brew uninstall --cask docker`
        : `brew uninstall ${uninstallMacFormulae}`;

    p.note(
      `${pc.bold("The following CLI tools are required and will be installed if missing:")}\n\n` +
      toolListFormatted +
      "\n\n" +
      pc.dim("─".repeat(60)) + "\n\n" +
      pc.bold("Why are these needed?\n") +
      pc.dim("These tools are used to create and manage your Kubernetes cluster,\n") +
      pc.dim(`install Flux via flux-operator, encrypt secrets, and interact with ${providerLabel(wizard.gitProvider)}.\n`) +
      pc.bold("How to uninstall later:\n") +
      (isMacOS()
        ? `  ${pc.cyan(`brew uninstall ${uninstallMac}`)}\n`
        : `  ${pc.cyan("sudo rm -f /usr/local/bin/{flux-operator,sops,age,age-keygen}")}\n` +
          `  ${pc.cyan(`sudo apt remove -y git`)}  ${pc.dim("(if installed via apt)")}\n`
      ) +
      pc.dim("\nAlready-installed tools will be skipped. No system tools will be modified."),
      "Required CLI Tools",
    );

    const proceed = await p.confirm({
      message: pc.bold(
        `Install ${missingToolNames.length} missing tool(s) and continue?`,
      ),
      initialValue: true,
    });
    if (p.isCancel(proceed) || !proceed) {
      log.error("Aborted.");
      return process.exit(1) as never;
    }

    log.step("Installing CLI tools");
    await ensureAll(missingToolNames);
  }

  if (isMacOS()) {
    await ensureDockerDaemonReady();
  }

  // ── Repo creation phase (new mode only) ─────────────────────────────
  let repoRoot: string;

  if (isNewRepo(wizard)) {
    try {
      repoRoot = await createAndCloneRepo(wizard);
    } catch (err) {
      log.error(`Repository setup failed\n${formatError(err)}`);
      return process.exit(1) as never;
    }
  } else {
    repoRoot = resolve(wizard.repoLocalPath || ".");
  }

  // ── Build final config ───────────────────────────────────────────────
  const selectedComponents = wizard.selectedComponents;
  const isOpenclawEnabled = openclawEnabled(wizard);

  const fullConfig: BootstrapConfig = {
    gitProvider: wizard.gitProvider,
    clusterName: wizard.clusterName,
    clusterDomain: wizard.clusterDomain,
    clusterPublicIp: wizard.clusterPublicIp,
    letsencryptEmail: wizard.letsencryptEmail,
    ingressAllowedIps: wizard.ingressAllowedIps,
    gitToken: wizard.gitToken,
    gitFluxToken: wizard.gitFluxToken || undefined,
    repoName: wizard.repoName,
    repoOwner: wizard.repoOwner,
    repoBranch: wizard.repoBranch,
    cloudflareApiToken: wizard.cloudflareApiToken,
    openaiApiKey: isOpenclawEnabled ? wizard.openaiApiKey : undefined,
    openclawGatewayToken: isOpenclawEnabled
      ? wizard.openclawGatewayToken
      : undefined,
    selectedComponents,
    templateRef:
      wizard.templateTag?.trim() ||
      (isNewRepo(wizard) ? "main" : undefined),
  };

  // ── Check macOS prerequisites ────────────────────────────────────────
  if (isMacOS() && !commandExists("brew")) {
    log.error("Homebrew is required on macOS. Install from https://brew.sh");
    return process.exit(1) as never;
  }

  // ── Run bootstrap (cluster + flux + template + sops + git push) ─────
  try {
    await runBootstrap(fullConfig, repoRoot);
  } catch (err) {
    log.error(`Bootstrap failed\n${formatError(err)}`);
    return process.exit(1) as never;
  }

  // ── /etc/hosts suggestion (local IP or no DNS management) ───────────
  const isLocalIp = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(fullConfig.clusterPublicIp)
    || fullConfig.clusterPublicIp === "localhost";
  if (isLocalIp || !wizard.manageDnsAndTls) {
    const hostsEntries = selectedComponents
      .map((id) => COMPONENTS.find((c) => c.id === id))
      .filter((c): c is ComponentDef => !!c?.subdomain)
      .map((c) => `${fullConfig.clusterPublicIp}  ${c.subdomain}.${fullConfig.clusterDomain}`);

    if (hostsEntries.length > 0) {
      const hostsBlock = hostsEntries.join("\n");
      const reason = isLocalIp
        ? "Your cluster uses a local/private IP, so DNS won't resolve publicly."
        : "Automatic DNS is disabled.";
      p.note(
        `${pc.dim(reason + " Add these to")} ${pc.bold("/etc/hosts")}${pc.dim(":")}\n\n` +
        hostsEntries.map((e) => pc.cyan(e)).join("\n"),
        "Local DNS",
      );

      const addHosts = await p.confirm({
        message: pc.bold("Append these entries to /etc/hosts now?") +
          pc.dim("  (requires sudo — macOS will prompt for your password)"),
        initialValue: true,
      });

      if (!p.isCancel(addHosts) && addHosts) {
        try {
          await execAsync(
            `echo '\n# GitOps AI Cluster — ${fullConfig.clusterName}\n${hostsBlock}' | sudo tee -a /etc/hosts > /dev/null`,
          );
          log.success("Entries added to /etc/hosts");
        } catch (err) {
          log.warn("Could not update /etc/hosts — add the entries manually");
          log.detail(formatError(err));
        }
      }
    }
  }

  // ── Status & summary ─────────────────────────────────────────────────
  const status = flux.getStatus();
  if (status) p.log.message(status);

  const summaryEntries: Record<string, string> = {
    "Cluster": fullConfig.clusterName,
    "Domain": fullConfig.clusterDomain,
    "Public IP": fullConfig.clusterPublicIp,
    "Components": selectedComponents.length.toString(),
  };
  if (isOpenclawEnabled && fullConfig.openclawGatewayToken) {
    summaryEntries["OpenClaw Gateway Token"] = fullConfig.openclawGatewayToken;
  }
  summary("Bootstrap Complete", summaryEntries);

  const finalSteps = [
    `All HelmReleases may take ${pc.yellow("~5 minutes")} to become ready.`,
  ];
  if (commandExists("kubectl")) {
    finalSteps.push(
      `Check HelmRelease status: ${pc.cyan("kubectl get helmreleases -A")}`,
    );
  } else {
    finalSteps.push(
      `Install ${pc.bold("kubectl")} to check HelmRelease status: ${
        isMacOS()
          ? pc.cyan("brew install kubectl")
          : pc.cyan("https://kubernetes.io/docs/tasks/tools/")
      }`,
    );
  }
  if (!commandExists("k9s")) {
    finalSteps.push(
      `Install ${pc.bold("k9s")} for a terminal UI to monitor your cluster: ${
        isMacOS()
          ? pc.cyan("brew install derailed/k9s/k9s")
          : pc.cyan("https://k9scli.io/topics/install/")
      }`,
    );
  } else {
    finalSteps.push(`Monitor your cluster: ${pc.cyan("k9s -A")}`);
  }
  if (selectedComponents.includes("grafana-operator")) {
    finalSteps.push(
      `Grafana dashboard: ${pc.cyan(`https://grafana.${fullConfig.clusterDomain}`)}`,
    );
  }
  if (selectedComponents.includes("victoria-metrics-k8s-stack")) {
    finalSteps.push(
      `Victoria Metrics: ${pc.cyan(`https://victoria.${fullConfig.clusterDomain}`)}`,
    );
  }
  if (isOpenclawEnabled) {
    finalSteps.push(
      `Open OpenClaw at ${pc.cyan(`https://openclaw.${fullConfig.clusterDomain}`)}`,
      `Pair a device: ${pc.cyan("npx gitops-ai openclaw-pair")}`,
    );
  }
  finalSteps.push(
    `Your infrastructure is managed via ${pc.bold("GitOps")} — push to '${fullConfig.repoBranch}' to deploy changes.`,
    `${pc.red("Backup your SOPS age key!")} If lost, you cannot decrypt your secrets.`,
  );
  nextSteps(finalSteps);

  clearInstallPlan();
  finish("Bootstrap complete");
}
