import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
  mkdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { resolve as resolvePath } from "node:path";
import { isMacOS, isCI } from "../utils/platform.js";
import { log, withSpinner } from "../utils/log.js";
import { exec, execAsync, execSafe } from "../utils/shell.js";
import { ensureAll } from "./dependencies.js";
import { getProvider } from "./git-provider.js";
import * as k8s from "./kubernetes.js";
import * as flux from "./flux.js";
import * as encryption from "./encryption.js";
import {
  COMPONENTS,
  defaultSopsConfig,
  httpsGitCredentialUsername,
  shouldUseSshDeployKey,
  SOURCE_TEMPLATE_HOST,
  SOURCE_PROJECT_PATH,
  type BootstrapConfig,
} from "../schemas.js";
import { createGitHubDeployKey } from "./github.js";

export interface RunBootstrapResult {
  fluxInstanceInstalled: boolean;
}

/**
 * Non-interactive bootstrap execution — shared between the CLI wizard
 * and the integration test suite.
 *
 * Assumes git credentials and the working branch are already configured.
 * If the template repo hasn't been cloned yet, it will be fetched
 * automatically from the source project.
 */
export async function runBootstrap(
  config: BootstrapConfig,
  repoRootInput: string,
): Promise<RunBootstrapResult> {
  const provider = await getProvider(config.gitProvider ?? "gitlab");

  // ── CLI dependencies ──────────────────────────────────────────────
  const tools = ["git", "flux-operator", "sops", "age"];
  if (isMacOS() || isCI()) tools.push("k3d");
  log.step("Installing CLI dependencies");
  await ensureAll(tools);

  let repoRoot: string;
  try {
    repoRoot = realpathSync(resolvePath(repoRootInput));
  } catch {
    throw new Error(`Bootstrap repo path does not exist: ${repoRootInput}`);
  }
  if (execSafe("git rev-parse --is-inside-work-tree", { cwd: repoRoot }).exitCode !== 0) {
    throw new Error(
      `Bootstrap needs a real git clone (with .git), not a source archive. Fix CI checkout (install git before actions/checkout). Offending path: ${repoRoot}`,
    );
  }

  // ── Git setup ─────────────────────────────────────────────────────
  log.step("Configuring git");
  const emailCfg = execSafe("git config user.email", { cwd: repoRoot });
  if (!emailCfg.stdout.trim()) {
    exec('git config user.email "bootstrap@gitops.local"', { cwd: repoRoot });
    exec('git config user.name "GitOps Bootstrap"', { cwd: repoRoot });
  }
  const { stdout: remoteUrl } = execSafe("git remote get-url origin", { cwd: repoRoot });
  if (remoteUrl) {
    const cleanUrl = remoteUrl.replace(/\/\/[^@]+@/, "//");
    const match = cleanUrl.match(/https:\/\/([^/]+)\/(.+?)(?:\.git)?$/);
    if (match) {
      const [, host, pathWithNs] = match;
      const authedUrl = provider.getAuthRemoteUrl(host, pathWithNs, config.gitToken);
      exec(`git remote set-url origin "${authedUrl}"`, { cwd: repoRoot });
    }
  }

  const currentBranch = execSafe("git branch --show-current", { cwd: repoRoot }).stdout;
  if (currentBranch !== config.repoBranch) {
    const { exitCode } = execSafe(
      `git checkout "${config.repoBranch}"`,
      { cwd: repoRoot },
    );
    if (exitCode !== 0) {
      exec(`git checkout -b "${config.repoBranch}"`, { cwd: repoRoot });
    }
  }

  // ── Kubernetes cluster ─────────────────────────────────────────────
  log.step("Setting up Kubernetes cluster");
  if (isMacOS() || isCI()) {
    await k8s.createK3dCluster(config.clusterName);
  } else {
    await k8s.installK3s();
  }

  const kubeconfigPath = k8s.setupKubeconfig(config.clusterName);
  log.success(`Kubeconfig: ${kubeconfigPath}`);
  await k8s.waitForCluster();

  await k8s.createNamespace("flux-system");

  // ── Git auth secret ────────────────────────────────────────────────
  if (shouldUseSshDeployKey(config)) {
    const gitHost = config.gitHost ?? "github.com";
    log.step("Creating SSH deploy key for Flux");
    const { privateKey, publicKey, knownHosts } = await createGitHubDeployKey(
      config.repoOwner,
      config.repoName,
      gitHost,
      config.gitToken,
    );
    await k8s.createSshSecret("flux-system", "flux-system", privateKey, publicKey, knownHosts);
    log.success("flux-system SSH secret created (deploy key — never expires)");
  } else {
    const fluxToken = config.gitFluxToken || config.gitToken;
    log.step("Creating Git auth secret");
    await k8s.createSecret("flux-system", "flux-system", {
      username: httpsGitCredentialUsername(config),
      password: fluxToken,
    });
    log.success("flux-system secret created");
  }

  await configureClusterTemplateInRepo(config, repoRoot);

  // ── Git commit & push ─────────────────────────────────────────────
  await withSpinner("Committing and pushing to Git", async () => {
    // Never commit workflow changes from the template copy: GitHub rejects pushes that
    // touch `.github/workflows/*` unless the token has `workflows` scope.
    resetLocalWorkflowFiles(repoRoot);

    await execAsync("git add .", { cwd: repoRoot });
    execSafe(
      `git commit -m "Add ${config.clusterName} cluster with encrypted secrets"`,
      { cwd: repoRoot },
    );
    await execAsync(`git push -u origin "${config.repoBranch}"`, {
      cwd: repoRoot,
    });
  });

  // ── Flux Instance ─────────────────────────────────────────────────
  let fluxInstanceInstalled = false;

  if (existsSync(`${repoRoot}/flux-instance.yaml`)) {
    await flux.installFluxOperatorAndInstance(config, repoRoot);
    await flux.waitForInstance();
    await flux.reconcile();
    fluxInstanceInstalled = true;
  }

  return { fluxInstanceInstalled };
}

/**
 * Copies `clusters/_template` into `clusters/<clusterName>`, renders vars, prunes components,
 * and runs SOPS setup. Does not commit, push, or touch the Kubernetes cluster.
 */
export async function configureClusterTemplateInRepo(
  config: BootstrapConfig,
  repoRoot: string,
): Promise<string> {
  const templateDir = `${repoRoot}/clusters/_template`;

  if (!existsSync(templateDir)) {
    await cloneTemplate(repoRoot);
  }

  await ensureFluxInstanceYaml(repoRoot);

  if (!existsSync(templateDir)) {
    throw new Error(`clusters/_template is missing after template resolution: ${repoRoot}`);
  }

  const clusterDir = `${repoRoot}/clusters/${config.clusterName}`;

  log.step(`Configuring cluster template for '${config.clusterName}'`);
  mkdirSync(clusterDir, { recursive: true });
  cpSync(templateDir, clusterDir, { recursive: true });
  log.detail(`Copied template → ${clusterDir}`);

  const syncFile = `${clusterDir}/cluster-sync.yaml`;
  if (existsSync(syncFile)) {
    writeFileSync(
      syncFile,
      envsubst(readFileSync(syncFile, "utf-8"), {
        CLUSTER_NAME: config.clusterName,
        CLUSTER_DOMAIN: config.clusterDomain,
        CLUSTER_PUBLIC_IP: config.clusterPublicIp,
        LETSENCRYPT_EMAIL: config.letsencryptEmail ?? "",
        INGRESS_NGINX_ALLOWED_IPS: config.ingressAllowedIps,
      }),
    );
    log.detail("Rendered cluster-sync.yaml with cluster vars");
  }

  pruneDisabledComponents(clusterDir, config.selectedComponents);

  await setupSops(config, repoRoot, clusterDir);

  return clusterDir;
}

export interface ApplyClusterTemplateOptions {
  /** Defaults to a generic CI upgrade message. */
  commitMessage?: string;
}

/**
 * Re-runs {@link configureClusterTemplateInRepo}, then commits and pushes to `config.repoBranch`.
 * Use when the Git tree already contains a newer template revision (e.g. merged PR) but the
 * cluster directory must be regenerated — does not create a cluster or install Flux.
 */
export async function applyClusterTemplateAndPush(
  config: BootstrapConfig,
  repoRootInput: string,
  options?: ApplyClusterTemplateOptions,
): Promise<void> {
  let repoRoot: string;
  try {
    repoRoot = realpathSync(resolvePath(repoRootInput));
  } catch {
    throw new Error(`Repo path does not exist: ${repoRootInput}`);
  }
  if (execSafe("git rev-parse --is-inside-work-tree", { cwd: repoRoot }).exitCode !== 0) {
    throw new Error(`Not a git work tree: ${repoRoot}`);
  }

  await configureClusterTemplateInRepo(config, repoRoot);

  const msg =
    options?.commitMessage ??
    `ci: apply cluster template update (${config.clusterName})`;

  await withSpinner("Committing and pushing template update", async () => {
    resetLocalWorkflowFiles(repoRoot);

    await execAsync("git add .", { cwd: repoRoot });
    if (execSafe("git diff --cached --quiet", { cwd: repoRoot }).exitCode === 0) {
      log.warn("No staged changes after configureClusterTemplateInRepo — skipping commit/push");
      return;
    }
    await execAsync(`git commit -m ${JSON.stringify(msg)}`, { cwd: repoRoot });
    await execAsync(`git push origin "${config.repoBranch}"`, { cwd: repoRoot });
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resetLocalWorkflowFiles(repoRoot: string): void {
  const wf = `${repoRoot}/.github/workflows`;
  if (!existsSync(wf)) return;
  execSafe("git checkout HEAD -- .github/workflows", { cwd: repoRoot });
  execSafe("git clean -fd -- .github/workflows", { cwd: repoRoot });
}

/** Default branch on GitHub for raw.githubusercontent.com links (template repo). */
const TEMPLATE_DEFAULT_BRANCH = "main";

/**
 * Ensure `flux-instance.yaml` exists at the repo root so Flux bootstrap can run.
 * When missing, downloads from the canonical template (same as a full template clone).
 */
async function ensureFluxInstanceYaml(repoRoot: string): Promise<void> {
  const dest = `${repoRoot}/flux-instance.yaml`;
  if (existsSync(dest)) return;

  const rawUrl = `https://raw.githubusercontent.com/${SOURCE_PROJECT_PATH}/${TEMPLATE_DEFAULT_BRANCH}/flux-instance.yaml`;

  try {
    await withSpinner("Fetching flux-instance.yaml from template repository", async () => {
      await execAsync(`curl -fsSL "${rawUrl}" -o "${dest}"`);
    });
    log.success("flux-instance.yaml added from GitOpsAI/gitops-ai-template");
  } catch {
    if (existsSync(dest)) {
      rmSync(dest);
    }
    log.warn(
      "Could not download flux-instance.yaml (network or firewall). " +
        "Add flux-instance.yaml at the repo root manually, then re-run bootstrap. " +
        "Skipping Flux installation for this run.",
    );
  }
}

async function cloneTemplate(repoRoot: string): Promise<void> {
  const tmpDir = "/tmp/gitops-template";

  await withSpinner("Cloning template repository", async () => {
    execSafe(`rm -rf "${tmpDir}"`);
    await execAsync(
      `git clone --quiet "https://${SOURCE_TEMPLATE_HOST}/${SOURCE_PROJECT_PATH}.git" "${tmpDir}"`,
    );

    // Never copy `.github` — template CI must not overwrite the target repo (push 403).
    for (const entry of readdirSync(tmpDir)) {
      if (entry === ".git" || entry === ".github") continue;
      cpSync(`${tmpDir}/${entry}`, `${repoRoot}/${entry}`, {
        recursive: true,
        force: true,
      });
    }

    execSafe(`rm -rf "${tmpDir}"`);
  });
}

/**
 * A full `git clone` of the upstream template includes `.github/workflows`. GitHub rejects
 * pushes that create or update workflow files when the credential is a GitHub OAuth App token
 * without the `workflow` scope. Remove the template’s `.github` tree and commit before the
 * first push to the user’s remote (same intent as skipping `.github` in {@link cloneTemplate}).
 */
export async function stripTemplateGitHubDirectory(repoRoot: string): Promise<void> {
  const dotGithub = resolvePath(repoRoot, ".github");
  if (!existsSync(dotGithub)) return;

  const rmTracked = execSafe(`git rm -r -f -- .github`, { cwd: repoRoot });
  if (rmTracked.exitCode !== 0) {
    rmSync(dotGithub, { recursive: true, force: true });
    await execAsync("git add -A", { cwd: repoRoot });
  }

  const { stdout } = execSafe("git diff --cached --name-only", { cwd: repoRoot });
  if (!stdout.trim()) return;

  await execAsync(
    `git -c user.email=bootstrap@gitops.local -c user.name="GitOps Bootstrap" commit --no-gpg-sign -m "chore: remove template .github before push (OAuth workflow scope)"`,
    { cwd: repoRoot },
  );
}

function envsubst(content: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce(
    (acc, [key, value]) => acc.replaceAll(`\${${key}}`, value),
    content,
  );
}

function pruneDisabledComponents(
  clusterDir: string,
  selectedComponents: string[],
): void {
  const allComponentIds = COMPONENTS.map((c) => c.id);
  const disabled = allComponentIds.filter(
    (id) => !selectedComponents.includes(id),
  );

  for (const id of disabled) {
    const componentPath = `${clusterDir}/components/${id}`;
    if (existsSync(componentPath)) {
      rmSync(componentPath, { recursive: true, force: true });
      log.detail(`Removed disabled component: ${id}`);
    }
  }

  const kustomizationPath = `${clusterDir}/components/kustomization.yaml`;
  if (existsSync(kustomizationPath)) {
    let content = readFileSync(kustomizationPath, "utf-8");
    for (const id of disabled) {
      content = content
        .split("\n")
        .filter((line) => !line.includes(`- ${id}`))
        .join("\n");
    }
    writeFileSync(kustomizationPath, content);
  }

  log.success(
    `Cluster template configured (${selectedComponents.length} components enabled)`,
  );
}

async function setupSops(
  config: BootstrapConfig,
  repoRoot: string,
  clusterDir: string,
): Promise<void> {
  log.step("Setting up SOPS secret encryption");
  const sopsCfg = defaultSopsConfig(repoRoot);

  if (!encryption.ageKeyExists(sopsCfg)) {
    encryption.generateAgeKey(sopsCfg);
    log.detail(`Generated new age key at ${sopsCfg.keyFile}`);
  } else {
    log.detail(`Using existing age key at ${sopsCfg.keyFile}`);
  }

  const pubKey = encryption.getAgePublicKey(sopsCfg);
  log.detail(`Age public key: ${pubKey}`);
  encryption.createSopsConfig(pubKey, sopsCfg);

  if (await k8s.isClusterReachable()) {
    await k8s.createSecretFromFile(
      sopsCfg.secretName,
      sopsCfg.namespace,
      "age.agekey",
      sopsCfg.keyFile,
    );
    log.detail(`Created ${sopsCfg.secretName} secret in ${sopsCfg.namespace}`);
  }
  encryption.updateFluxKustomization(repoRoot, sopsCfg.secretName);

  log.step("Encrypting secrets from templates");
  const componentsDir = `${clusterDir}/components`;
  const selected = config.selectedComponents;

  if (selected.includes("cert-manager") && config.cloudflareApiToken) {
    encryption.substituteAndEncrypt(
      `${componentsDir}/cert-manager/secret-cloudflare.yaml`,
      { CLOUDFLARE_API_TOKEN: config.cloudflareApiToken },
      sopsCfg,
      repoRoot,
    );
    log.detail("Encrypted: cert-manager/secret-cloudflare.yaml");
  }

  if (selected.includes("external-dns") && config.cloudflareApiToken) {
    encryption.substituteAndEncrypt(
      `${componentsDir}/external-dns/secret-cloudflare.yaml`,
      { CLOUDFLARE_API_TOKEN: config.cloudflareApiToken },
      sopsCfg,
      repoRoot,
    );
    log.detail("Encrypted: external-dns/secret-cloudflare.yaml");
  }

  const openclawAuth =
    config.openclawAuthMode ?? "openai_api_key";
  const openclawSecretOk =
    selected.includes("openclaw") &&
    config.openclawGatewayToken &&
    (openclawAuth === "openai_codex_oauth" ||
      (openclawAuth === "openai_api_key" && !!config.openaiApiKey));

  if (openclawSecretOk && config.openclawGatewayToken) {
    encryption.substituteAndEncrypt(
      `${componentsDir}/openclaw/secret-openclaw-envs.yaml`,
      {
        OPENAI_API_KEY:
          openclawAuth === "openai_codex_oauth" ? "" : (config.openaiApiKey ?? ""),
        OPENCLAW_GATEWAY_TOKEN: config.openclawGatewayToken,
      },
      sopsCfg,
      repoRoot,
    );
    log.detail("Encrypted: openclaw/secret-openclaw-envs.yaml");
  }

  log.success("All secrets encrypted with SOPS");
}
