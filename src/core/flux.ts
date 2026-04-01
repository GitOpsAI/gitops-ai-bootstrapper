import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { exec, execAsync } from "../utils/shell.js";
import { log, withSpinner } from "../utils/log.js";
import type { BootstrapConfig } from "../schemas.js";

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

  let content = readFileSync(templatePath, "utf-8");
  content = envsubst(content, {
    FLUX_GITLAB_REPO_OWNER: config.repoOwner,
    FLUX_GITLAB_REPO_NAME: config.repoName,
    FLUX_GITLAB_REPO_BRANCH: config.repoBranch,
    CLUSTER_NAME: config.clusterName,
  });
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
  await withSpinner("Waiting for FluxInstance to be ready", () =>
    execAsync(
      "kubectl -n flux-system wait fluxinstance/flux --for=condition=Ready --timeout=5m",
    ),
  );
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
