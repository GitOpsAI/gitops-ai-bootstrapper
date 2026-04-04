/**
 * Kubernetes API access via @kubernetes/client-node
 */
import { Buffer } from "node:buffer";
import { Writable } from "node:stream";
import * as k8s from "@kubernetes/client-node";
import type { V1Secret, V1Status } from "@kubernetes/client-node";

export const FLUX_SYSTEM_NS = "flux-system";

export const FLUX_INSTANCE_GROUP = "fluxcd.controlplane.io";
export const FLUX_INSTANCE_VERSION = "v1";
export const FLUX_INSTANCE_PLURAL = "fluxinstances";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function kubeConfigFromDefault(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  return kc;
}

export function makeClients(kc: k8s.KubeConfig) {
  return {
    core: kc.makeApiClient(k8s.CoreV1Api),
    apps: kc.makeApiClient(k8s.AppsV1Api),
    custom: kc.makeApiClient(k8s.CustomObjectsApi),
  };
}

export async function isClusterReachableApi(kc: k8s.KubeConfig): Promise<boolean> {
  try {
    const { core } = makeClients(kc);
    await core.listNamespace({ limit: 1 });
    return true;
  } catch {
    return false;
  }
}

export async function waitForAllNodesReady(
  kc: k8s.KubeConfig,
  timeoutMs: number,
): Promise<void> {
  const { core } = makeClients(kc);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await core.listNode();
    const items = list.items ?? [];
    if (items.length > 0) {
      const allReady = items.every((n) =>
        n.status?.conditions?.some(
          (c) => c.type === "Ready" && c.status === "True",
        ),
      );
      if (allReady) return;
    }
    await sleep(2000);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for all nodes to be Ready`);
}

export async function createNamespaceApi(
  kc: k8s.KubeConfig,
  name: string,
): Promise<void> {
  const { core } = makeClients(kc);
  try {
    await core.createNamespace({
      body: { metadata: { name } },
    });
  } catch (e: unknown) {
    const code = (e as { code?: number; body?: { code?: number } })?.code
      ?? (e as { body?: { code?: number } })?.body?.code;
    if (code === 409) return;
    throw e;
  }
}

export async function createSecretLiteralsApi(
  kc: k8s.KubeConfig,
  name: string,
  namespace: string,
  data: Record<string, string>,
): Promise<void> {
  const { core } = makeClients(kc);
  const body: V1Secret = {
    metadata: { name, namespace },
    stringData: data,
  };
  try {
    await core.createNamespacedSecret({ namespace, body });
  } catch (e: unknown) {
    const code = (e as { code?: number })?.code;
    if (code === 409) {
      await core.deleteNamespacedSecret({ name, namespace });
      await core.createNamespacedSecret({ namespace, body });
      return;
    }
    throw e;
  }
}

export async function secretExistsApi(
  kc: k8s.KubeConfig,
  name: string,
  namespace: string,
): Promise<boolean> {
  const { core } = makeClients(kc);
  try {
    await core.readNamespacedSecret({ name, namespace });
    return true;
  } catch {
    return false;
  }
}

export async function deleteSecretApi(
  kc: k8s.KubeConfig,
  name: string,
  namespace: string,
): Promise<void> {
  const { core } = makeClients(kc);
  try {
    await core.deleteNamespacedSecret({ name, namespace });
  } catch (e: unknown) {
    const code = (e as { code?: number })?.code;
    if (code === 404) return;
    throw e;
  }
}

export async function createSecretFromFilesApi(
  kc: k8s.KubeConfig,
  name: string,
  namespace: string,
  files: Record<string, string>,
): Promise<void> {
  const fs = await import("node:fs");
  const stringData: Record<string, string> = {};
  for (const [key, path] of Object.entries(files)) {
    stringData[key] = fs.readFileSync(path, "utf-8");
  }
  await createSecretLiteralsApi(kc, name, namespace, stringData);
}

async function podNameForDeployment(
  kc: k8s.KubeConfig,
  namespace: string,
  deploymentName: string,
): Promise<string | null> {
  const { apps, core } = makeClients(kc);
  const dep = await apps.readNamespacedDeployment({
    name: deploymentName,
    namespace,
  });
  const match = dep.spec?.selector?.matchLabels;
  if (!match || Object.keys(match).length === 0) return null;
  const labelSelector = Object.entries(match)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(",");
  const pods = await core.listNamespacedPod({ namespace, labelSelector });
  const pick =
    pods.items?.find((p) => p.status?.phase === "Running") ?? pods.items?.[0];
  return pick?.metadata?.name ?? null;
}

function statusExitCode(status: V1Status): number {
  if (status.status === "Success") return 0;
  const c = status.code;
  return typeof c === "number" ? c : 1;
}

/**
 * Run a command in a pod (by deployment name). Returns captured stdout/stderr.
 */
export async function execInDeploymentContainer(
  kc: k8s.KubeConfig,
  namespace: string,
  deploymentName: string,
  containerName: string,
  command: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const podName = await podNameForDeployment(kc, namespace, deploymentName);
  if (!podName) {
    throw new Error(
      `No pod found for Deployment ${namespace}/${deploymentName}`,
    );
  }
  const execApi = new k8s.Exec(kc);
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const stdout = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      stdoutChunks.push(Buffer.from(chunk));
      cb();
    },
  });
  const stderr = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      stderrChunks.push(Buffer.from(chunk));
      cb();
    },
  });
  let exitCode = 0;
  await new Promise<void>((resolve, reject) => {
    execApi
      .exec(
        namespace,
        podName,
        containerName,
        command,
        stdout,
        stderr,
        null,
        false,
        (status: V1Status) => {
          exitCode = statusExitCode(status);
          resolve();
        },
      )
      .catch(reject);
  });
  return {
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    exitCode,
  };
}

/**
 * Stream exec to process stdout/stderr (for interactive listing).
 */
export async function execInDeploymentContainerTty(
  kc: k8s.KubeConfig,
  namespace: string,
  deploymentName: string,
  containerName: string,
  command: string[],
): Promise<number> {
  const podName = await podNameForDeployment(kc, namespace, deploymentName);
  if (!podName) {
    throw new Error(
      `No pod found for Deployment ${namespace}/${deploymentName}`,
    );
  }
  const execApi = new k8s.Exec(kc);
  let exitCode = 0;
  await new Promise<void>((resolve, reject) => {
    execApi
      .exec(
        namespace,
        podName,
        containerName,
        command,
        process.stdout,
        process.stderr,
        null,
        false,
        (status: V1Status) => {
          exitCode = statusExitCode(status);
          resolve();
        },
      )
      .catch(reject);
  });
  return exitCode;
}

export async function listPodsStatusLines(
  kc: k8s.KubeConfig,
  namespace: string,
): Promise<string> {
  const { core } = makeClients(kc);
  const list = await core.listNamespacedPod({ namespace });
  const lines: string[] = [];
  for (const pod of list.items ?? []) {
    const name = pod.metadata?.name ?? "?";
    const phase = pod.status?.phase ?? "?";
    const ready =
      pod.status?.conditions?.find((c) => c.type === "Ready")?.status ===
      "True";
    lines.push(`${name}\t${phase}\t${ready ? "True" : "False"}`);
  }
  return lines.join("\n");
}

function fluxInstanceReady(obj: unknown): boolean {
  const o = obj as {
    status?: { conditions?: Array<{ type?: string; status?: string }> };
  };
  return (
    o.status?.conditions?.some(
      (c) => c.type === "Ready" && c.status === "True",
    ) ?? false
  );
}

export async function waitForFluxInstanceReady(
  kc: k8s.KubeConfig,
  timeoutMs: number,
): Promise<void> {
  const { custom } = makeClients(kc);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const obj = await custom.getNamespacedCustomObject({
      group: FLUX_INSTANCE_GROUP,
      version: FLUX_INSTANCE_VERSION,
      namespace: FLUX_SYSTEM_NS,
      plural: FLUX_INSTANCE_PLURAL,
      name: "flux",
    });
    if (fluxInstanceReady(obj)) return;
    await sleep(2000);
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for FluxInstance flux to be Ready`,
  );
}

export async function reconcileFluxInstance(
  kc: k8s.KubeConfig,
  timeoutMs: number,
): Promise<void> {
  const { custom } = makeClients(kc);
  const ts = Math.floor(Date.now() / 1000);
  const existing = await custom.getNamespacedCustomObject({
    group: FLUX_INSTANCE_GROUP,
    version: FLUX_INSTANCE_VERSION,
    namespace: FLUX_SYSTEM_NS,
    plural: FLUX_INSTANCE_PLURAL,
    name: "flux",
  });
  const merged = existing as Record<string, unknown>;
  const meta = (merged.metadata ?? {}) as Record<string, unknown>;
  const ann = (meta.annotations ?? {}) as Record<string, string>;
  ann["reconcile.fluxcd.io/requestedAt"] = String(ts);
  meta.annotations = ann;
  merged.metadata = meta;
  await custom.replaceNamespacedCustomObject({
    group: FLUX_INSTANCE_GROUP,
    version: FLUX_INSTANCE_VERSION,
    namespace: FLUX_SYSTEM_NS,
    plural: FLUX_INSTANCE_PLURAL,
    name: "flux",
    body: merged,
  });
  await waitForFluxInstanceReady(kc, timeoutMs);
}
