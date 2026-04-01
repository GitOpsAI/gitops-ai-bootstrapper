import { existsSync } from "node:fs";
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
import { execAsync, exec, commandExists } from "../utils/shell.js";
import { isMacOS, isCI } from "../utils/platform.js";
import { ensureAll } from "../core/dependencies.js";
import { runBootstrap } from "../core/bootstrap-runner.js";
import * as flux from "../core/flux.js";
import * as gitlab from "../core/gitlab.js";
import {
  COMPONENTS,
  REQUIRED_COMPONENT_IDS,
  DNS_TLS_COMPONENT_IDS,
  OPTIONAL_COMPONENTS,
  SOURCE_GITLAB_HOST,
  SOURCE_PROJECT_PATH,
  type BootstrapConfig,
  type ComponentDef,
} from "../schemas.js";
import {
  stepWizard,
  back,
  maskSecret,
  type WizardField,
} from "../utils/wizard.js";

// ---------------------------------------------------------------------------
// Wizard state
// ---------------------------------------------------------------------------

interface WizardState {
  setupMode: "new" | "existing";
  manageDnsAndTls: boolean;
  selectedComponents: string[];
  clusterName: string;
  clusterDomain: string;
  repoName: string;
  repoLocalPath: string;
  repoOwner: string;
  repoBranch: string;
  letsencryptEmail: string;
  gitlabPat: string;
  cloudflareApiToken: string;
  openaiApiKey: string;
  openclawGatewayToken: string;
  ingressAllowedIps: string;
  clusterPublicIp: string;
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

// ---------------------------------------------------------------------------
// Wizard field definitions (Esc / Ctrl+C = go back one field)
// ---------------------------------------------------------------------------

function buildFields(detectedIp: string, hasSavedPlan: boolean): WizardField<WizardState>[] {
  const saved = (state: WizardState, key: keyof WizardState) =>
    hasSavedPlan && !!state[key];

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

    // ── GitLab Repository ───────────────────────────────────────────────
    {
      id: "gitlabPat",
      section: "GitLab Repository",
      skip: (state) => !!state.gitlabPat,
      run: async (state) => {
        const v = await p.password({
          message:
            pc.bold("GitLab Personal Access Token (api, read_repository, write_repository)"),
          validate: (v) => {
            if (!v) return "Required";
          },
        });
        if (p.isCancel(v)) return back();
        return { ...state, gitlabPat: v as string };
      },
      review: (state) => ["PAT", maskSecret(state.gitlabPat)],
    },
    {
      id: "repoOwner",
      section: "GitLab Repository",
      skip: (state) => saved(state, "repoOwner"),
      run: async (state) => {
        const v = await p.text({
          message: pc.bold("GitLab repo owner / namespace (without @)"),
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
      section: "GitLab Repository",
      skip: (state) => saved(state, "repoName"),
      run: async (state) => {
        const v = await p.text({
          message: isNewRepo(state)
            ? pc.bold("New repository name")
            : pc.bold("Flux GitLab repo name"),
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
      section: "GitLab Repository",
      hidden: (state) => !isNewRepo(state),
      skip: (state) => saved(state, "repoLocalPath"),
      run: async (state) => {
        const v = await p.text({
          message: pc.bold("Local directory to clone into"),
          placeholder: `./${state.repoName}  (relative to current directory)`,
          defaultValue: state.repoLocalPath || state.repoName,
        });
        if (p.isCancel(v)) return back();
        return { ...state, repoLocalPath: v as string };
      },
      review: (state) => ["Local path", `./${state.repoLocalPath}`],
    },
    {
      id: "repoBranch",
      section: "GitLab Repository",
      skip: (state) => saved(state, "repoBranch"),
      run: async (state) => {
        const v = await p.text({
          message: isNewRepo(state)
            ? pc.bold("Template branch name to clone")
            : pc.bold("Git branch for Flux"),
          placeholder: "main",
          defaultValue: state.repoBranch,
        });
        if (p.isCancel(v)) return back();
        return { ...state, repoBranch: v as string };
      },
      review: (state) => ["Branch", state.repoBranch],
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
        const selected = await p.multiselect({
          message: pc.bold("Optional components to install"),
          options: OPTIONAL_COMPONENTS.map((c) => ({
            value: c.id,
            label: c.label,
            hint: c.hint,
          })),
          initialValues: state.selectedComponents.filter((id) =>
            OPTIONAL_COMPONENTS.some((c) => c.id === id),
          ),
          required: false,
        });
        if (p.isCancel(selected)) return back();
        const dnsTlsIds = state.manageDnsAndTls ? DNS_TLS_COMPONENT_IDS : [];
        return {
          ...state,
          selectedComponents: [
            ...REQUIRED_COMPONENT_IDS,
            ...dnsTlsIds,
            ...(selected as string[]),
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
        const v = await p.password({
          message: pc.bold("Cloudflare API Token (DNS zone edit access)"),
          validate: (v) => {
            if (!v) return "Required";
          },
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
        const v = await p.password({
          message: pc.bold("OpenAI API Key (for AI components)"),
          validate: (v) => {
            if (!v) return "Required";
          },
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
      id: "ingressAllowedIps",
      section: "Network",
      skip: (state) => saved(state, "ingressAllowedIps"),
      run: async (state) => {
        const v = await p.text({
          message: pc.bold("IPs allowed to access your cluster (CIDR, comma-separated)"),
          placeholder: "0.0.0.0/0",
          defaultValue: state.ingressAllowedIps,
        });
        if (p.isCancel(v)) return back();
        return { ...state, ingressAllowedIps: v as string };
      },
      review: (state) => ["Allowed IPs", state.ingressAllowedIps],
    },
    {
      id: "clusterPublicIp",
      section: "Network",
      skip: (state) => saved(state, "clusterPublicIp"),
      run: async (state) => {
        const useLocal = !dnsAndTlsEnabled(state);
        const fallback = useLocal ? "127.0.0.1" : detectedIp;
        const defaultIp = state.clusterPublicIp || fallback;
        const v = await p.text({
          message: useLocal
            ? pc.bold("Cluster IP") + pc.dim("  (local because DNS management is disabled. Rewrite if it necessary)")
            : pc.bold("Public IP of your cluster"),
          defaultValue: defaultIp,
          placeholder: fallback || "x.x.x.x",
          validate: (v) => {
            if (!v && !defaultIp) return "Required";
          },
        });
        if (p.isCancel(v)) return back();
        return { ...state, clusterPublicIp: v as string };
      },
      review: (state) => ["Public IP", state.clusterPublicIp],
    },
  ];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveRepoRoot(): string {
  const scriptDir = new URL(".", import.meta.url).pathname;
  return resolve(scriptDir, "../../../");
}

// ---------------------------------------------------------------------------
// Repo creation phase (only for "new" mode)
// ---------------------------------------------------------------------------

async function createAndCloneRepo(wizard: WizardState): Promise<string> {
  log.step("Authenticating with GitLab");
  await gitlab.authenticate(wizard.gitlabPat, SOURCE_GITLAB_HOST);

  log.step(`Resolving namespace '${wizard.repoOwner}'`);
  const namespaceId = await gitlab.resolveNamespaceId(
    wizard.repoOwner,
    SOURCE_GITLAB_HOST,
  );

  log.step(`Creating project ${wizard.repoOwner}/${wizard.repoName}`);
  const existing = await gitlab.getProject(
    wizard.repoOwner,
    wizard.repoName,
    SOURCE_GITLAB_HOST,
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
    const created = await withSpinner("Creating GitLab project", () =>
      gitlab.createProject(wizard.repoName, namespaceId, SOURCE_GITLAB_HOST),
    );
    httpUrl = created.httpUrl;
    pathWithNs = created.pathWithNamespace;
    log.success(`Created: ${pathWithNs}`);
  }

  const cloneDir = wizard.repoLocalPath || wizard.repoName;

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
    await withSpinner("Cloning template repository", () =>
      execAsync(
        `git clone --quiet --branch "${wizard.repoBranch}" "https://${SOURCE_GITLAB_HOST}/${SOURCE_PROJECT_PATH}.git" "${cloneDir}"`,
      ),
    );
    exec(`git remote set-url origin "${httpUrl}"`, { cwd: cloneDir });
  }

  const authRemote = `https://oauth2:${wizard.gitlabPat}@${SOURCE_GITLAB_HOST}/${pathWithNs}.git`;

  await withSpinner(`Pushing to ${pathWithNs}`, () => {
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
    await execAsync(
      "kubectl exec -n openclaw deployment/openclaw -c main -- node dist/index.js devices list",
    );
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
  await execAsync(
    `kubectl exec -n openclaw deployment/openclaw -c main -- node dist/index.js devices approve "${requestId}"`,
  );
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
  p.box(
    `💅 Secure, isolated and flexible GitOps infrastructure for modern requirements\n` +
    `🤖 You can manage it yourself — or delegate to AI.\n` +
    `🔐 Encrypted secrets, hardened containers, continuous delivery.`,
    pc.bold("Welcome to GitOps AI Bootstrapper"),
    {
      contentAlign: "center",
      titleAlign: "center",
      rounded: true,
      formatBorder: (text) => pc.cyan(text),
    },
  );

  // ── Load saved state ─────────────────────────────────────────────────
  const saved = loadInstallPlan();
  if (saved) {
    log.warn("Loading saved inputs from previous run");
  }
  const prev = (saved ?? {}) as Record<string, string>;

  // ── Detect public IP (silent) ────────────────────────────────────────
  let detectedIp = prev.clusterPublicIp ?? "";
  if (!detectedIp) {
    try {
      detectedIp = await execAsync("curl -s --max-time 5 ifconfig.me");
    } catch {
      detectedIp = "";
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
        ...OPTIONAL_COMPONENTS.map((c) => c.id),
      ];

  const initialState: WizardState = {
    setupMode: (prev.setupMode as "new" | "existing") ?? "new",
    manageDnsAndTls: savedDnsTls,
    selectedComponents: savedComponents,
    clusterName: prev.clusterName ?? "homelab",
    clusterDomain: prev.clusterDomain ?? "homelab.click",
    repoName: prev.repoName ?? "fluxcd_ai",
    repoLocalPath: prev.repoLocalPath ?? "",
    repoOwner: prev.repoOwner ?? "",
    repoBranch: prev.repoBranch ?? "main",
    letsencryptEmail: prev.letsencryptEmail ?? "",
    gitlabPat: prev.gitlabPat ?? "",
    cloudflareApiToken: prev.cloudflareApiToken ?? "",
    openaiApiKey: prev.openaiApiKey ?? "",
    openclawGatewayToken: prev.openclawGatewayToken ?? "",
    ingressAllowedIps: prev.ingressAllowedIps ?? "0.0.0.0/0",
    clusterPublicIp: prev.clusterPublicIp ?? detectedIp,
  };

  const wizard = await stepWizard(buildFields(detectedIp, !!saved), initialState);

  // ── Save config ─────────────────────────────────────────────────────
  saveInstallPlan({
    setupMode: wizard.setupMode,
    manageDnsAndTls: String(wizard.manageDnsAndTls),
    clusterName: wizard.clusterName,
    clusterDomain: wizard.clusterDomain,
    clusterPublicIp: wizard.clusterPublicIp,
    letsencryptEmail: wizard.letsencryptEmail,
    ingressAllowedIps: wizard.ingressAllowedIps,
    gitlabPat: wizard.gitlabPat,
    repoName: wizard.repoName,
    repoLocalPath: wizard.repoLocalPath,
    repoOwner: wizard.repoOwner,
    repoBranch: wizard.repoBranch,
    cloudflareApiToken: wizard.cloudflareApiToken,
    openaiApiKey: wizard.openaiApiKey ?? "",
    openclawGatewayToken: wizard.openclawGatewayToken ?? "",
    selectedComponents: wizard.selectedComponents.join(","),
  });
  log.success("Configuration saved");

  // ── Warn about CLI tools that will be installed ─────────────────────
  const toolDescriptions: [string, string][] = [
    ["git",            "Version control (repo operations)"],
    ["jq",             "JSON processor (API responses)"],
    ["glab",           "GitLab CLI (repo & auth management)"],
    ["kubectl",        "Kubernetes CLI (cluster management)"],
    ["helm",           "Kubernetes package manager (chart installs)"],
    ["k9s",            "Terminal UI for Kubernetes (monitoring)"],
    ["flux-operator",  "FluxCD Operator CLI (GitOps reconciliation)"],
    ["sops",           "Mozilla SOPS (secret encryption)"],
    ["age",            "Age encryption (SOPS key backend)"],
  ];
  if (isMacOS() || isCI()) {
    toolDescriptions.push(["k3d", "Lightweight K3s in Docker (local cluster)"]);
  }

  const toBeInstalled = toolDescriptions
    .filter(([name]) => !commandExists(name));

  const toolListFormatted = toolDescriptions
    .map(([name, desc]) => {
      const status = commandExists(name)
        ? pc.green("installed")
        : pc.yellow("will install");
      return `  ${pc.bold(name.padEnd(16))} ${pc.dim(desc)}  [${status}]`;
    })
    .join("\n");

  const uninstallMac = toolDescriptions
    .map(([name]) => name)
    .join(" ");

  p.note(
    `${pc.bold("The following CLI tools are required and will be installed if missing:")}\n\n` +
    toolListFormatted +
    "\n\n" +
    pc.dim("─".repeat(60)) + "\n\n" +
    pc.bold("Why are these needed?\n") +
    pc.dim("These tools are used to create and manage your Kubernetes cluster,\n") +
    pc.dim("deploy components via Helm/Flux, encrypt secrets, and interact with GitLab.\n\n") +
    pc.bold("How to uninstall later:\n") +
    (isMacOS()
      ? `  ${pc.cyan(`brew uninstall ${uninstallMac}`)}\n`
      : `  ${pc.cyan("sudo rm -f /usr/local/bin/{kubectl,helm,k9s,flux-operator,sops,age,age-keygen}")}\n` +
        `  ${pc.cyan("sudo apt remove -y glab jq git")}  ${pc.dim("(if installed via apt)")}\n`
    ) +
    pc.dim("\nAlready-installed tools will be skipped. No system tools will be modified."),
    "Required CLI Tools",
  );

  const confirmMsg = toBeInstalled.length > 0
    ? `Install ${toBeInstalled.length} missing tool(s) and continue?`
    : "All tools are already installed. Continue?";
  const proceed = await p.confirm({
    message: pc.bold(confirmMsg),
    initialValue: true,
  });
  if (p.isCancel(proceed) || !proceed) {
    log.error("Aborted.");
    return process.exit(1) as never;
  }

  // ── Install all CLI tools upfront ───────────────────────────────────
  if (toBeInstalled.length > 0) {
    log.step("Installing CLI tools");
    const allToolNames = toolDescriptions.map(([name]) => name);
    await ensureAll(allToolNames);
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
    repoRoot = resolveRepoRoot();
  }

  // ── Build final config ───────────────────────────────────────────────
  const selectedComponents = wizard.selectedComponents;
  const isOpenclawEnabled = openclawEnabled(wizard);

  const fullConfig: BootstrapConfig = {
    clusterName: wizard.clusterName,
    clusterDomain: wizard.clusterDomain,
    clusterPublicIp: wizard.clusterPublicIp,
    letsencryptEmail: wizard.letsencryptEmail,
    ingressAllowedIps: wizard.ingressAllowedIps,
    gitlabPat: wizard.gitlabPat,
    repoName: wizard.repoName,
    repoOwner: wizard.repoOwner,
    repoBranch: wizard.repoBranch,
    cloudflareApiToken: wizard.cloudflareApiToken,
    openaiApiKey: isOpenclawEnabled ? wizard.openaiApiKey : undefined,
    openclawGatewayToken: isOpenclawEnabled
      ? wizard.openclawGatewayToken
      : undefined,
    selectedComponents,
  };

  // ── Configure git credentials ────────────────────────────────────────
  await runStep("Configuring git credentials", async () => {
    gitlab.configureGitCredentials(fullConfig.gitlabPat, repoRoot);
  });

  // ── Check macOS prerequisites ────────────────────────────────────────
  if (isMacOS()) {
    if (!commandExists("brew")) {
      log.error("Homebrew is required on macOS. Install from https://brew.sh");
      return process.exit(1) as never;
    }
    if (!commandExists("docker")) {
      log.error(
        "Docker is required on macOS (Docker Desktop, OrbStack, or Colima).",
      );
      return process.exit(1) as never;
    }
  }

  // ── Run bootstrap (cluster + flux + template + sops + git push) ─────
  try {
    await runBootstrap(fullConfig, repoRoot);
  } catch (err) {
    log.error(`Bootstrap failed\n${formatError(err)}`);
    return process.exit(1) as never;
  }

  // ── /etc/hosts suggestion (no DNS management) ───────────────────────
  if (!wizard.manageDnsAndTls) {
    const hostsEntries = selectedComponents
      .map((id) => COMPONENTS.find((c) => c.id === id))
      .filter((c): c is ComponentDef => !!c?.subdomain)
      .map((c) => `${fullConfig.clusterPublicIp}  ${c.subdomain}.${fullConfig.clusterDomain}`);

    if (hostsEntries.length > 0) {
      const hostsBlock = hostsEntries.join("\n");
      p.note(
        `${pc.dim("Since automatic DNS is disabled, add these to")} ${pc.bold("/etc/hosts")}${pc.dim(":")}\n\n` +
        hostsEntries.map((e) => pc.cyan(e)).join("\n"),
        "Local DNS",
      );

      const addHosts = await p.confirm({
        message: pc.bold("Append these entries to /etc/hosts now?"),
        initialValue: false,
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
    `Check status: ${pc.cyan("kubectl get helmreleases -A")} or ${pc.cyan("k9s -A")}`,
  ];
  if (isOpenclawEnabled) {
    finalSteps.push(
      `Open OpenClaw at ${pc.cyan(`https://openclaw.${fullConfig.clusterDomain}`)}`,
      `Pair a device: ${pc.cyan("npx fluxcd-ai-bootstraper openclaw-pair")}`,
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
