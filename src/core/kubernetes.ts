import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { exec, execAsync, execSafe } from "../utils/shell.js";
import { isMacOS, isCI } from "../utils/platform.js";
import { log, withSpinner } from "../utils/log.js";
import { KUBERNETES_VERSION } from "../schemas.js";

export function isClusterReachable(): boolean {
  const { exitCode } = execSafe("kubectl cluster-info 2>/dev/null");
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
    await execAsync(
      "kubectl wait --for=condition=Ready node --all --timeout=120s",
    );
  });
}

export async function createNamespace(name: string): Promise<void> {
  await execAsync(
    `kubectl create namespace ${name} --dry-run=client -o yaml | kubectl apply -f -`,
  );
}

export async function createSecret(
  name: string,
  namespace: string,
  data: Record<string, string>,
): Promise<void> {
  const literals = Object.entries(data)
    .map(([k, v]) => `--from-literal=${k}='${v}'`)
    .join(" ");
  const cmd = `kubectl create secret generic ${name} --namespace=${namespace} ${literals}`;
  log.detail(`kubectl create secret generic ${name} --namespace=${namespace}`);
  await execAsync(cmd);
}

export function secretExists(name: string, namespace: string): boolean {
  const { exitCode } = execSafe(
    `kubectl get secret ${name} -n ${namespace} 2>/dev/null`,
  );
  return exitCode === 0;
}

export async function deleteSecret(
  name: string,
  namespace: string,
): Promise<void> {
  await execAsync(`kubectl delete secret ${name} -n ${namespace}`);
}

export async function createSecretFromFile(
  name: string,
  namespace: string,
  key: string,
  filePath: string,
): Promise<void> {
  const cmd = `kubectl create secret generic ${name} --namespace=${namespace} --from-file=${key}="${filePath}"`;
  log.detail(`kubectl create secret generic ${name} --namespace=${namespace} --from-file=${key}`);
  await execAsync(cmd);
}
