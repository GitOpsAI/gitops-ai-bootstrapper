/**
 * Kubernetes API access via @kubernetes/client-node
 */
import { Buffer } from "node:buffer";
import * as path from "node:path";
import { homedir } from "node:os";
import tty from "node:tty";
import { Writable } from "node:stream";
import * as k8s from "@kubernetes/client-node";
import type { V1Secret, V1Status } from "@kubernetes/client-node";
import { resolveBootstrapKubeconfigPath } from "../utils/bootstrap-kubeconfig.js";

export const FLUX_SYSTEM_NS = "flux-system";

export const FLUX_INSTANCE_GROUP = "fluxcd.controlplane.io";
export const FLUX_INSTANCE_VERSION = "v1";
export const FLUX_INSTANCE_PLURAL = "fluxinstances";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Match `kubectl exec -it`: unpause stdin (readline / @clack/prompts often leave it paused) and put
 * the TTY in raw mode so keys and Enter are sent to the container PTY instead of being line-buffered locally.
 */
function prepareStdinForInteractiveExec(useTty: boolean): () => void {
  const stdin = process.stdin;
  if (typeof stdin.isPaused === "function" && stdin.isPaused()) {
    stdin.resume();
  }
  if (!useTty || !stdin.isTTY) {
    return () => {};
  }
  const rs = stdin as tty.ReadStream;
  if (typeof rs.setRawMode !== "function") {
    return () => {};
  }
  const previousRaw = rs.isRaw;
  rs.setRawMode(true);
  return () => {
    if (stdin.isTTY && typeof rs.setRawMode === "function") {
      rs.setRawMode(previousRaw);
    }
  };
}

/** Same as kubectl with no `KUBECONFIG`: `$HOME/.kube/config`. */
export function defaultKubeconfigPath(): string {
  return path.join(homedir(), ".kube", "config");
}

/**
 * Load **only** the kubeconfig written by bootstrap (`setupKubeconfig`):
 * `~/.kube/.gitops-ai-kubeconfig` (path marker), else the file derived from `INSTALL_PLAN_PATH` + cluster name.
 * Does not read `KUBECONFIG` or merge other files.
 */
export function kubeConfigFromDefault(): k8s.KubeConfig {
  const kubePath = resolveBootstrapKubeconfigPath();
  const kc = new k8s.KubeConfig();
  kc.loadFromFile(kubePath);
  return kc;
}

export function makeClients(kc: k8s.KubeConfig) {
  return {
    core: kc.makeApiClient(k8s.CoreV1Api),
    apps: kc.makeApiClient(k8s.AppsV1Api),
    custom: kc.makeApiClient(k8s.CustomObjectsApi),
  };
}

/** Human-readable line for logs (current context + API server URL). */
export function kubeConnectionSummary(kc: k8s.KubeConfig): string {
  try {
    const ctx = kc.getCurrentContext();
    const cluster = kc.getCurrentCluster();
    const server = cluster?.server ?? "(unknown server)";
    return ctx ? `context=${ctx} → ${server}` : "no current context in kubeconfig";
  } catch {
    return "could not read kubeconfig";
  }
}

function formatKubernetesRequestError(err: unknown): string {
  if (err == null) return "unknown error";
  if (typeof err === "string") return err;
  if (typeof err !== "object") return String(err);
  const o = err as Record<string, unknown>;
  const body = o.body;
  if (body && typeof body === "object") {
    const m = (body as Record<string, unknown>).message;
    if (typeof m === "string" && m.length > 0) return m;
  }
  if (typeof o.message === "string" && o.message.length > 0) return o.message;
  if (typeof o.reason === "string") return o.reason;
  return String(o.message ?? err);
}

export type ClusterApiHealth =
  | { ok: true }
  | { ok: false; detail: string };

/** One lightweight API call to verify credentials and network reach the apiserver. */
export async function checkClusterApi(kc: k8s.KubeConfig): Promise<ClusterApiHealth> {
  try {
    const { core } = makeClients(kc);
    await core.listNamespace({ limit: 1 });
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: formatKubernetesRequestError(err) };
  }
}

export async function isClusterReachableApi(kc: k8s.KubeConfig): Promise<boolean> {
  const r = await checkClusterApi(kc);
  return r.ok;
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

export async function podNameForDeployment(
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

/** Matches `containers.main` in templates/ai/openclaw/helm-release-openclaw.yaml */
export const OPENCLAW_K8S_CONTAINER_NAME = "main";

function execContainerName(explicit?: string): string {
  return explicit ?? OPENCLAW_K8S_CONTAINER_NAME;
}

/**
 * Prefer the **container exit code** from exec status (`details.causes` / ExitCode).
 * The top-level `code` field is often HTTP-style (e.g. 500) for any exec failure and is misleading.
 */
function statusExitCode(status: V1Status): number {
  if (status.status === "Success") return 0;
  const causes = status.details?.causes;
  if (causes) {
    for (const c of causes) {
      if (c.reason === "ExitCode" && c.message != null && c.message !== "") {
        const n = Number.parseInt(String(c.message), 10);
        if (!Number.isNaN(n)) return n;
      }
    }
  }
  const c = status.code;
  return typeof c === "number" ? c : 1;
}

/**
 * Run a command in a pod (by deployment name). Returns captured stdout/stderr.
 * Omit `containerName` to use {@link OPENCLAW_K8S_CONTAINER_NAME}.
 */
export async function execInDeploymentContainer(
  kc: k8s.KubeConfig,
  namespace: string,
  deploymentName: string,
  command: string[],
  containerName?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const podName = await podNameForDeployment(kc, namespace, deploymentName);
  if (!podName) {
    throw new Error(
      `No pod found for Deployment ${namespace}/${deploymentName}`,
    );
  }
  const resolvedContainer = execContainerName(containerName);
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
        resolvedContainer,
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
  command: string[],
  containerName?: string,
): Promise<number> {
  const podName = await podNameForDeployment(kc, namespace, deploymentName);
  if (!podName) {
    throw new Error(
      `No pod found for Deployment ${namespace}/${deploymentName}`,
    );
  }
  const resolvedContainer = execContainerName(containerName);
  const execApi = new k8s.Exec(kc);
  let exitCode = 0;
  await new Promise<void>((resolve, reject) => {
    execApi
      .exec(
        namespace,
        podName,
        resolvedContainer,
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

/** Result of {@link execInDeploymentInteractive} / {@link execInPodInteractive}. */
export interface ExecInteractiveResult {
  exitCode: number;
  /** Present on Failure; may include `message` / `reason` from the API. */
  k8sStatus?: V1Status;
}

/** Low-level interactive attach (TTY + stdin). Prefer higher-level helpers when possible. */
export async function execInteractiveAttach(
  kc: k8s.KubeConfig,
  namespace: string,
  podName: string,
  containerName: string,
  command: string[],
  ttyEnabled: boolean,
): Promise<ExecInteractiveResult> {
  const restoreStdin = prepareStdinForInteractiveExec(ttyEnabled);
  const execApi = new k8s.Exec(kc);
  let exitCode = 0;
  let k8sStatus: V1Status | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      execApi
        .exec(
          namespace,
          podName,
          containerName,
          command,
          process.stdout,
          process.stderr,
          process.stdin,
          ttyEnabled,
          (status: V1Status) => {
            k8sStatus = status;
            exitCode = statusExitCode(status);
            resolve();
          },
        )
        .catch(reject);
    });
  } finally {
    restoreStdin();
  }
  return { exitCode, k8sStatus };
}

/**
 * Interactive exec with local stdin attached (like `kubectl exec -it`).
 * Use for OAuth flows, shells, or any process that reads from the terminal.
 */
export async function execInDeploymentInteractive(
  kc: k8s.KubeConfig,
  namespace: string,
  deploymentName: string,
  command: string[],
  options?: { tty?: boolean; containerName?: string },
): Promise<ExecInteractiveResult> {
  const podName = await podNameForDeployment(kc, namespace, deploymentName);
  if (!podName) {
    throw new Error(
      `No pod found for Deployment ${namespace}/${deploymentName}`,
    );
  }
  const resolvedContainer = execContainerName(options?.containerName);
  return execInteractiveAttach(
    kc,
    namespace,
    podName,
    resolvedContainer,
    command,
    options?.tty ?? true,
  );
}

/**
 * When `explicit` is set, use it. Otherwise require a single container or ask the user to pass one.
 */
export async function resolvePodContainerNameForExec(
  kc: k8s.KubeConfig,
  namespace: string,
  podName: string,
  explicit?: string,
): Promise<string> {
  if (explicit) return explicit;
  const { core } = makeClients(kc);
  const pod = await core.readNamespacedPod({ name: podName, namespace });
  const names = (pod.spec?.containers ?? [])
    .map((c) => c.name)
    .filter((n): n is string => Boolean(n));
  if (names.length === 0) {
    throw new Error(`Pod ${namespace}/${podName} has no containers`);
  }
  if (names.length === 1) return names[0];
  throw new Error(
    `Pod has multiple containers (${names.join(", ")}). Pass --container <name>`,
  );
}

/**
 * Interactive exec into a **named pod** (any workload), with container auto-selection when there is only one.
 */
export async function execInPodInteractive(
  kc: k8s.KubeConfig,
  namespace: string,
  podName: string,
  command: string[],
  options?: { tty?: boolean; containerName?: string },
): Promise<ExecInteractiveResult> {
  const resolvedContainer = await resolvePodContainerNameForExec(
    kc,
    namespace,
    podName,
    options?.containerName,
  );
  return execInteractiveAttach(
    kc,
    namespace,
    podName,
    resolvedContainer,
    command,
    options?.tty ?? true,
  );
}

export interface PodConsoleRow {
  namespace: string;
  name: string;
  phase: string;
}

/**
 * Pods for `pod-console` selection. If `filterNamespace` is set, only that namespace; otherwise all namespaces.
 */
export async function listPodsForPodConsole(
  kc: k8s.KubeConfig,
  filterNamespace?: string,
): Promise<PodConsoleRow[]> {
  const { core } = makeClients(kc);
  if (filterNamespace) {
    const res = await core.listNamespacedPod({ namespace: filterNamespace });
    return (res.items ?? [])
      .map((p) => ({
        namespace: filterNamespace,
        name: p.metadata?.name ?? "?",
        phase: p.status?.phase ?? "?",
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  const res = await core.listPodForAllNamespaces();
  return (res.items ?? [])
    .map((p) => ({
      namespace: p.metadata?.namespace ?? "?",
      name: p.metadata?.name ?? "?",
      phase: p.status?.phase ?? "?",
    }))
    .sort((a, b) =>
      a.namespace === b.namespace
        ? a.name.localeCompare(b.name)
        : a.namespace.localeCompare(b.namespace),
    );
}

/** Regular container names in a Pod (excludes ephemeral). */
export async function listContainerNamesInPod(
  kc: k8s.KubeConfig,
  namespace: string,
  podName: string,
): Promise<string[]> {
  const { core } = makeClients(kc);
  const pod = await core.readNamespacedPod({ name: podName, namespace });
  return (pod.spec?.containers ?? [])
    .map((c) => c.name)
    .filter((n): n is string => Boolean(n));
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
