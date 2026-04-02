import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { exec, execAsync, execSafe } from "../utils/shell.js";
import { log, withSpinner, p, pc } from "../utils/log.js";
import { getProvider } from "./git-provider.js";
import { shouldUseSshDeployKey, type BootstrapConfig } from "../schemas.js";

export async function installOperator(): Promise<void> {
  const cmd = [
    "helm install flux-operator",
    "oci://ghcr.io/controlplaneio-fluxcd/charts/flux-operator",
    "--namespace flux-system",
    "--create-namespace",
    "--set web.enabled=false",
    "--wait",
  ].join(" ");
  log.detail(cmd);
  await withSpinner("Installing Flux Operator via Helm", () => execAsync(cmd));
}

export async function installInstance(
  config: BootstrapConfig,
  repoRoot: string,
): Promise<void> {
  const templatePath = `${repoRoot}/flux-instance-values.yaml`;
  const tmpPath = "/tmp/flux-instance-values.yaml";

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

  // Replace hardcoded gitlab.com URLs in the template with the actual host
  if (gitHost !== "gitlab.com") {
    content = content.replaceAll("https://gitlab.com/", `https://${gitHost}/`);
  }

  // SSH deploy key: rewrite HTTPS URL → SSH URL for Flux source-controller
  if (shouldUseSshDeployKey(config)) {
    const httpsUrl = `https://${gitHost}/${config.repoOwner}/${config.repoName}.git`;
    const sshUrl = `ssh://git@${gitHost}/${config.repoOwner}/${config.repoName}.git`;
    content = content.replaceAll(httpsUrl, sshUrl);
  }
  writeFileSync(tmpPath, content);

  const cmd = [
    "helm install flux",
    "oci://ghcr.io/controlplaneio-fluxcd/charts/flux-instance",
    "--namespace flux-system",
    `--values ${tmpPath}`,
    "--wait",
  ].join(" ");
  log.detail(cmd);
  await withSpinner("Installing Flux Instance via Helm", () => execAsync(cmd));

  unlinkSync(tmpPath);
}

export async function waitForInstance(): Promise<void> {
  const s = p.spinner();
  s.start("Waiting for FluxInstance to be ready");

  const waitPromise = execAsync(
    "kubectl -n flux-system wait fluxinstance/flux --for=condition=Ready --timeout=5m",
  );

  const poll = setInterval(() => {
    const status = getPodStatusLine();
    if (status) {
      s.message(`Waiting for FluxInstance to be ready\n${pc.dim(status)}`);
    }
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

function getPodStatusLine(): string {
  const { stdout, exitCode } = execSafe(
    `kubectl get pods -n flux-system --no-headers -o custom-columns="NAME:.metadata.name,STATUS:.status.phase,READY:.status.conditions[?(@.type=='Ready')].status" 2>/dev/null`,
  );
  if (exitCode !== 0 || !stdout) return "";

  const pods = stdout.split("\n").filter(Boolean).map((line) => {
    const parts = line.trim().split(/\s+/);
    const name = (parts[0] ?? "").replace(/^(.*?)-[a-f0-9]+-[a-z0-9]+$/, "$1");
    const phase = parts[1] ?? "?";
    const ready = parts[2] === "True";
    const icon = ready ? pc.green("✓") : phase === "Running" ? pc.yellow("●") : pc.dim("○");
    return `  ${icon} ${pc.dim(name)} ${pc.dim(phase)}`;
  });

  return pods.join("\n");
}

export async function reconcile(): Promise<void> {
  await withSpinner("Reconciling Flux", async () => {
    const ts = Math.floor(Date.now() / 1000);
    await execAsync(
      `kubectl -n flux-system annotate --overwrite fluxinstance/flux reconcile.fluxcd.io/requestedAt="${ts}"`,
    );
    log.detail("Waiting for FluxInstance condition=Ready...");
    await execAsync(
      "kubectl -n flux-system wait fluxinstance/flux --for=condition=Ready --timeout=5m",
    );
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
