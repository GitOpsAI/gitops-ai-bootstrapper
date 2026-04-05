import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { exec, execAsync } from "../utils/shell.js";
import { log, withSpinner, p, pc } from "../utils/log.js";
import { getProvider } from "./git-provider.js";
import { shouldUseSshDeployKey, type BootstrapConfig } from "../schemas.js";
import * as k8sApi from "./k8s-api.js";

/**
 * Installs the Flux Operator and a FluxInstance in one step using the official CLI.
 * Requires `flux-system` namespace and the `flux-system` git credentials secret to exist first.
 */
export async function installFluxOperatorAndInstance(
  config: BootstrapConfig,
  repoRoot: string,
): Promise<void> {
  const templatePath = `${repoRoot}/flux-instance.yaml`;
  const tmpPath = "/tmp/flux-instance.yaml";

  const provider = await getProvider(config.gitProvider ?? "gitlab");
  const gitHost = config.gitHost ?? provider.defaultHost;

  let content = readFileSync(templatePath, "utf-8");
  const vars: Record<string, string> = {
    FLUX_GIT_HOST: gitHost,
    FLUX_GIT_REPO_OWNER: config.repoOwner,
    FLUX_GIT_REPO_NAME: config.repoName,
    FLUX_GIT_REPO_BRANCH: config.repoBranch,
    CLUSTER_NAME: config.clusterName,
  };
  content = envsubst(content, vars);

  if (gitHost !== "gitlab.com") {
    content = content.replaceAll("https://gitlab.com/", `https://${gitHost}/`);
  }

  if (shouldUseSshDeployKey(config)) {
    const httpsUrl = `https://${gitHost}/${config.repoOwner}/${config.repoName}.git`;
    const sshUrl = `ssh://git@${gitHost}/${config.repoOwner}/${config.repoName}.git`;
    content = content.replaceAll(httpsUrl, sshUrl);
  }
  writeFileSync(tmpPath, content);

  const cmd = [
    "flux-operator install",
    "-n flux-system",
    `-f ${tmpPath}`,
    "--timeout 30m",
  ].join(" ");
  log.detail(cmd);
  await withSpinner("Installing Flux Operator and Flux instance (flux-operator install)", () =>
    execAsync(cmd),
  );

  unlinkSync(tmpPath);
}

async function getPodStatusLine(): Promise<string> {
  const kc = k8sApi.kubeConfigFromDefault();
  const raw = await k8sApi.listPodsStatusLines(kc, k8sApi.FLUX_SYSTEM_NS);
  if (!raw) return "";

  const pods = raw.split("\n").filter(Boolean).map((line) => {
    const parts = line.trim().split(/\t/);
    const name = (parts[0] ?? "").replace(/^(.*?)-[a-f0-9]+-[a-z0-9]+$/, "$1");
    const phase = parts[1] ?? "?";
    const ready = parts[2] === "True";
    const icon = ready ? pc.green("✓") : phase === "Running" ? pc.yellow("●") : pc.dim("○");
    return `  ${icon} ${pc.dim(name)} ${pc.dim(phase)}`;
  });

  return pods.join("\n");
}

export async function waitForInstance(): Promise<void> {
  const s = p.spinner();
  s.start("Waiting for FluxInstance to be ready");

  const kc = k8sApi.kubeConfigFromDefault();
  const waitPromise = k8sApi.waitForFluxInstanceReady(kc, 300_000);

  const poll = setInterval(() => {
    void getPodStatusLine().then((status) => {
      if (status) {
        s.message(`Waiting for FluxInstance to be ready\n${pc.dim(status)}`);
      }
    });
  }, 3000);

  try {
    await waitPromise;
    s.stop(pc.green("FluxInstance is ready"));
  } catch (err) {
    s.stop(pc.red("FluxInstance failed to become ready"));
    throw err;
  } finally {
    clearInterval(poll);
  }
}

export async function reconcile(): Promise<void> {
  await withSpinner("Reconciling Flux", async () => {
    const kc = k8sApi.kubeConfigFromDefault();
    log.detail("Waiting for FluxInstance condition=Ready...");
    await k8sApi.reconcileFluxInstance(kc, 300_000);
  });
}

export function getStatus(): string {
  try {
    return exec("flux-operator -n flux-system get instance flux");
  } catch {
    return "(unable to retrieve status)";
  }
}

function envsubst(
  content: string,
  vars: Record<string, string>,
): string {
  return Object.entries(vars).reduce(
    (acc, [key, value]) => acc.replaceAll(`\${${key}}`, value),
    content,
  );
}
