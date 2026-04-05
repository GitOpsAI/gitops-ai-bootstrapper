import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec, execAsync, execSafe } from "../utils/shell.js";
import { isMacOS, isCI } from "../utils/platform.js";
import { log, withSpinner } from "../utils/log.js";
import { KUBERNETES_VERSION } from "../schemas.js";
import * as k8sApi from "./k8s-api.js";

export async function isClusterReachable(): Promise<boolean> {
  return k8sApi.isClusterReachableApi(k8sApi.kubeConfigFromDefault());
}

export interface ExistingCluster {
  type: "k3d" | "k3s";
  names: string[];
}

export function detectExistingClusters(): ExistingCluster | null {
  if (isMacOS() || isCI()) {
    const names = listK3dClusters();
    if (names.length > 0) return { type: "k3d", names };
    return null;
  }

  if (k3sInstalled()) {
    return { type: "k3s", names: ["k3s"] };
  }

  return null;
}

export function listK3dClusters(): string[] {
  const { stdout, exitCode } = execSafe(
    "k3d cluster list --no-headers 2>/dev/null",
  );
  if (exitCode !== 0 || !stdout.trim()) return [];
  return stdout
    .trim()
    .split("\n")
    .map((line) => line.split(/\s+/)[0])
    .filter(Boolean);
}

export function k3dClusterExists(clusterName: string): boolean {
  return listK3dClusters().includes(clusterName);
}

export function k3sInstalled(): boolean {
  const { exitCode } = execSafe("command -v k3s");
  return exitCode === 0;
}

export async function createK3dCluster(clusterName: string): Promise<void> {
  const { stdout } = execSafe("k3d cluster list 2>/dev/null");
  if (stdout.includes(clusterName)) {
    log.success(`k3d cluster '${clusterName}' already exists`);
    return;
  }

  const cmd = [
    "k3d cluster create",
    clusterName,
    `--image "rancher/k3s:v${KUBERNETES_VERSION}-k3s1"`,
    '--k3s-arg "--disable=traefik@server:0"',
    '--port "80:80@loadbalancer"',
    '--port "443:443@loadbalancer"',
    "--wait",
  ].join(" ");
  log.detail(cmd);
  await withSpinner(`Creating k3d cluster '${clusterName}'`, () =>
    execAsync(cmd),
  );
}

export async function installK3s(): Promise<void> {
  const { exitCode } = execSafe("command -v k3s");
  if (exitCode === 0) {
    log.success("k3s already installed");
    return;
  }

  await withSpinner("Installing k3s", () =>
    execAsync(
      `curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="v${KUBERNETES_VERSION}+k3s1" INSTALL_K3S_EXEC="server --disable=traefik --write-kubeconfig-mode=644" sh -`,
    ),
  );
}

export function setupKubeconfig(clusterName: string): string {
  mkdirSync(`${process.env.HOME}/.kube`, { recursive: true });

  if (isMacOS() || isCI()) {
    const kubeconfigPath = `${process.env.HOME}/.kube/k3d-${clusterName}`;
    const kubeconfig = exec(`k3d kubeconfig get ${clusterName}`);
    writeFileSync(kubeconfigPath, kubeconfig, { mode: 0o600 });
    process.env.KUBECONFIG = kubeconfigPath;
    return kubeconfigPath;
  }

  exec("sudo cp /etc/rancher/k3s/k3s.yaml $HOME/.kube/config");
  exec('sudo chown "$(id -u):$(id -g)" $HOME/.kube/config');
  exec("chmod 600 $HOME/.kube/config");
  const kubeconfigPath = `${process.env.HOME}/.kube/config`;
  process.env.KUBECONFIG = kubeconfigPath;
  return kubeconfigPath;
}

export async function waitForCluster(): Promise<void> {
  await withSpinner("Waiting for cluster to be ready", async () => {
    await new Promise((r) => setTimeout(r, 5000));
    const kc = k8sApi.kubeConfigFromDefault();
    await k8sApi.waitForAllNodesReady(kc, 120_000);
  });
}

export async function createNamespace(name: string): Promise<void> {
  await k8sApi.createNamespaceApi(k8sApi.kubeConfigFromDefault(), name);
}

export async function createSecret(
  name: string,
  namespace: string,
  data: Record<string, string>,
): Promise<void> {
  log.detail(`create secret ${name} --namespace=${namespace}`);
  await k8sApi.createSecretLiteralsApi(
    k8sApi.kubeConfigFromDefault(),
    name,
    namespace,
    data,
  );
}

export async function secretExists(
  name: string,
  namespace: string,
): Promise<boolean> {
  return k8sApi.secretExistsApi(
    k8sApi.kubeConfigFromDefault(),
    name,
    namespace,
  );
}

export async function deleteSecret(
  name: string,
  namespace: string,
): Promise<void> {
  await k8sApi.deleteSecretApi(
    k8sApi.kubeConfigFromDefault(),
    name,
    namespace,
  );
}

export async function createSecretFromFile(
  name: string,
  namespace: string,
  key: string,
  filePath: string,
): Promise<void> {
  log.detail(
    `create secret generic ${name} --namespace=${namespace} --from-file=${key}`,
  );
  await k8sApi.createSecretFromFilesApi(
    k8sApi.kubeConfigFromDefault(),
    name,
    namespace,
    { [key]: filePath },
  );
}

export async function createSshSecret(
  name: string,
  namespace: string,
  privateKey: string,
  publicKey: string,
  knownHosts: string,
): Promise<void> {
  const tmpDir = mkdtempSync(join(tmpdir(), "flux-ssh-"));
  try {
    const identity = join(tmpDir, "identity");
    const identityPub = join(tmpDir, "identity.pub");
    const knownHostsPath = join(tmpDir, "known_hosts");
    writeFileSync(identity, privateKey, { mode: 0o600 });
    writeFileSync(identityPub, publicKey);
    writeFileSync(knownHostsPath, knownHosts);
    log.detail(`create secret generic ${name} --namespace=${namespace} (SSH)`);
    await k8sApi.createSecretFromFilesApi(
      k8sApi.kubeConfigFromDefault(),
      name,
      namespace,
      {
        identity,
        "identity.pub": identityPub,
        known_hosts: knownHostsPath,
      },
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
