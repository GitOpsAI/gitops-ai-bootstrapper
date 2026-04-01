import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { isMacOS, isCI } from "../utils/platform.js";
import { log, withSpinner } from "../utils/log.js";
import { exec, execAsync, execSafe } from "../utils/shell.js";
import { ensureAll } from "./dependencies.js";
import * as gitlab from "./gitlab.js";
import * as k8s from "./kubernetes.js";
import * as flux from "./flux.js";
import * as encryption from "./encryption.js";
import {
  COMPONENTS,
  defaultSopsConfig,
  SOURCE_GITLAB_HOST,
  SOURCE_PROJECT_PATH,
  type BootstrapConfig,
} from "../schemas.js";

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
  repoRoot: string,
): Promise<RunBootstrapResult> {
  // ── CLI dependencies ──────────────────────────────────────────────
  const tools = ["git", "kubectl", "helm", "sops", "age"];
  if (isMacOS() || isCI()) tools.push("k3d");
  log.step("Installing CLI dependencies");
  await ensureAll(tools);

  // ── Git setup ─────────────────────────────────────────────────────
  log.step("Configuring git");
  if (!execSafe("git config user.email", { cwd: repoRoot }).stdout) {
    exec('git config user.email "bootstrap@gitops.local"', { cwd: repoRoot });
    exec('git config user.name "GitOps Bootstrap"', { cwd: repoRoot });
  }
  gitlab.configureGitCredentials(config.gitlabPat, repoRoot);

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

  // ── Flux Operator ──────────────────────────────────────────────────
  await flux.installOperator();

  // ── GitLab auth secret ─────────────────────────────────────────────
  log.step("Creating GitLab auth secret");
  await k8s.createSecret("flux-system", "flux-system", {
    username: "git",
    password: config.gitlabPat,
  });
  log.success("flux-system secret created");

  // ── Clone template if not present ─────────────────────────────────
  const templateDir = `${repoRoot}/clusters/_default-template`;

  if (!existsSync(templateDir)) {
    await cloneTemplate(repoRoot);
  }

  // ── Cluster template ──────────────────────────────────────────────
  const clusterDir = `${repoRoot}/clusters/${config.clusterName}`;

  if (existsSync(templateDir)) {
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
  }

  // ── SOPS encryption ───────────────────────────────────────────────
  await setupSops(config, repoRoot, clusterDir);

  // ── Git commit & push ─────────────────────────────────────────────
  await withSpinner("Committing and pushing to Git", async () => {
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

  if (existsSync(`${repoRoot}/flux-instance-values.yaml`)) {
    await flux.installInstance(config, repoRoot);
    await flux.waitForInstance();
    await flux.reconcile();
    fluxInstanceInstalled = true;
  }

  return { fluxInstanceInstalled };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function cloneTemplate(repoRoot: string): Promise<void> {
  const tmpDir = "/tmp/gitops-template";

  await withSpinner("Cloning template repository", async () => {
    execSafe(`rm -rf "${tmpDir}"`);
    await execAsync(
      `git clone --quiet "https://${SOURCE_GITLAB_HOST}/${SOURCE_PROJECT_PATH}.git" "${tmpDir}"`,
    );

    for (const entry of readdirSync(tmpDir)) {
      if (entry === ".git") continue;
      cpSync(`${tmpDir}/${entry}`, `${repoRoot}/${entry}`, {
        recursive: true,
        force: true,
      });
    }

    execSafe(`rm -rf "${tmpDir}"`);
  });
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

  if (k8s.isClusterReachable()) {
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

  if (
    selected.includes("openclaw") &&
    config.openaiApiKey &&
    config.openclawGatewayToken
  ) {
    encryption.substituteAndEncrypt(
      `${componentsDir}/openclaw/secret-openclaw-envs.yaml`,
      {
        OPENAI_API_KEY: config.openaiApiKey,
        OPENCLAW_GATEWAY_TOKEN: config.openclawGatewayToken,
      },
      sopsCfg,
      repoRoot,
    );
    log.detail("Encrypted: openclaw/secret-openclaw-envs.yaml");
  }

  log.success("All secrets encrypted with SOPS");
}
