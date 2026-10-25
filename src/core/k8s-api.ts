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

/** Flux `GitRepository` (source-controller). */
export const FLUX_SOURCE_GROUP = "source.toolkit.fluxcd.io";
export const FLUX_SOURCE_VERSION = "v1";

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
  const wasPaused = typeof stdin.isPaused === "function" && stdin.isPaused();
  // The exec client adds its own stdin listeners and never removes them; a flowing
  // stdin with listeners keeps the event loop (and the CLI) alive after the command ends.
  const listenersBefore = {
    data: new Set(stdin.listeners("data")),
    end: new Set(stdin.listeners("end")),
  };
  if (wasPaused) stdin.resume();

  const rs = stdin as tty.ReadStream;
  const canRaw = useTty && stdin.isTTY && typeof rs.setRawMode === "function";
  const previousRaw = canRaw ? rs.isRaw : false;
  if (canRaw) rs.setRawMode(true);

  return () => {
    if (canRaw && stdin.isTTY) rs.setRawMode(previousRaw);
    for (const event of ["data", "end"] as const) {
      for (const listener of stdin.listeners(event)) {
        if (!listenersBefore[event].has(listener)) {
          stdin.removeListener(event, listener as (...args: unknown[]) => void);
        }
      }
    }
    if (wasPaused || stdin.listenerCount("data") === 0) stdin.pause();
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

export interface WorkloadRef {
  kind: "Deployment" | "StatefulSet";
  namespace: string;
  name: string;
}

/** StatefulSet the operator creates for `OpenClawInstance/openclaw-instance` (templates/ai/openclaw-instance). */
export const OPENCLAW_WORKLOAD: WorkloadRef = {
  kind: "StatefulSet",
  namespace: "openclaw-instance",
  name: "openclaw-instance",
};

/** Main container of the operator-managed pod (sidecars: gateway-proxy, otel-collector). */
export const OPENCLAW_K8S_CONTAINER_NAME = "openclaw";

export function workloadLabel(ref: WorkloadRef): string {
  return `${ref.kind} ${ref.namespace}/${ref.name}`;
}

export class WorkloadNotFoundError extends Error {
  constructor(readonly ref: WorkloadRef) {
    super(`${workloadLabel(ref)} not found`);
    this.name = "WorkloadNotFoundError";
  }
}

export async function podNameForWorkload(
  kc: k8s.KubeConfig,
  ref: WorkloadRef,
): Promise<string | null> {
  const { apps, core } = makeClients(kc);
  const args = { name: ref.name, namespace: ref.namespace };
  let selector: Record<string, string> | undefined;
  try {
    const workload =
      ref.kind === "StatefulSet"
        ? await apps.readNamespacedStatefulSet(args)
        : await apps.readNamespacedDeployment(args);
    selector = workload.spec?.selector?.matchLabels;
  } catch (e: unknown) {
    if ((e as { code?: number })?.code === 404) throw new WorkloadNotFoundError(ref);
    throw e;
  }
  if (!selector || Object.keys(selector).length === 0) return null;
  const labelSelector = Object.entries(selector)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(",");
  const pods = await core.listNamespacedPod({ namespace: ref.namespace, labelSelector });
  const pick =
    pods.items?.find((p) => p.status?.phase === "Running") ?? pods.items?.[0];
  return pick?.metadata?.name ?? null;
}

export function podNameForDeployment(
  kc: k8s.KubeConfig,
  namespace: string,
  deploymentName: string,
): Promise<string | null> {
  return podNameForWorkload(kc, { kind: "Deployment", namespace, name: deploymentName });
}

async function requirePodForWorkload(kc: k8s.KubeConfig, ref: WorkloadRef): Promise<string> {
  const podName = await podNameForWorkload(kc, ref);
  if (!podName) throw new Error(`No pod found for ${workloadLabel(ref)}`);
  return podName;
}

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
 * Run a command in a workload's pod. Returns captured stdout/stderr.
 * Omit `containerName` to use {@link OPENCLAW_K8S_CONTAINER_NAME}.
 */
export async function execInWorkloadContainer(
  kc: k8s.KubeConfig,
  ref: WorkloadRef,
  command: string[],
  containerName?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const namespace = ref.namespace;
  const podName = await requirePodForWorkload(kc, ref);
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
export async function execInWorkloadContainerTty(
  kc: k8s.KubeConfig,
  ref: WorkloadRef,
  command: string[],
  containerName?: string,
): Promise<number> {
  const namespace = ref.namespace;
  const podName = await requirePodForWorkload(kc, ref);
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

/** Result of {@link execInWorkloadInteractive} / {@link execInPodInteractive}. */
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
  let socket: { close(): void } | undefined;
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
        .then((ws) => {
          socket = ws;
        })
        .catch(reject);
    });
  } finally {
    socket?.close();
    restoreStdin();
  }
  return { exitCode, k8sStatus };
}

/**
 * Interactive exec with local stdin attached (like `kubectl exec -it`).
 * Use for OAuth flows, shells, or any process that reads from the terminal.
 */
export async function execInWorkloadInteractive(
  kc: k8s.KubeConfig,
  ref: WorkloadRef,
  command: string[],
  options?: { tty?: boolean; containerName?: string },
): Promise<ExecInteractiveResult> {
  const podName = await requirePodForWorkload(kc, ref);
  const resolvedContainer = execContainerName(options?.containerName);
  return execInteractiveAttach(
    kc,
    ref.namespace,
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

function gitRepositoryArtifactRevision(obj: unknown): string {
  const o = obj as {
    status?: { artifact?: { revision?: string } };
  };
  return o.status?.artifact?.revision ?? "";
}

/**
 * Annotates a Flux {@link https://fluxcd.io/flux/components/source/gitrepositories/ GitRepository}
 * so source-controller reconciles and fetches from the remote (same mechanism as `flux reconcile source git`).
 */
export async function reconcileGitRepository(
  kc: k8s.KubeConfig,
  namespace: string,
  name: string,
): Promise<void> {
  const { custom } = makeClients(kc);
  const ts = Math.floor(Date.now() / 1000);
  const existing = await custom.getNamespacedCustomObject({
    group: FLUX_SOURCE_GROUP,
    version: FLUX_SOURCE_VERSION,
    namespace,
    plural: "gitrepositories",
    name,
  });
  const merged = existing as Record<string, unknown>;
  const meta = (merged.metadata ?? {}) as Record<string, unknown>;
  const prev = (meta.annotations ?? {}) as Record<string, string>;
  const ann = { ...prev, "reconcile.fluxcd.io/requestedAt": String(ts) };
  meta.annotations = ann;
  merged.metadata = meta;
  await custom.replaceNamespacedCustomObject({
    group: FLUX_SOURCE_GROUP,
    version: FLUX_SOURCE_VERSION,
    namespace,
    plural: "gitrepositories",
    name,
    body: merged,
  });
}

/**
 * Waits until {@link status.artifact.revision} references the given commit (Flux uses forms like
 * `refs/heads/branch@sha1:<40-char-sha>`).
 */
export async function waitForGitRepositoryArtifactContainsSha(
  kc: k8s.KubeConfig,
  namespace: string,
  name: string,
  fullSha: string,
  timeoutMs: number,
): Promise<void> {
  const { custom } = makeClients(kc);
  const normalized = fullSha.trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(normalized)) {
    throw new Error(`Invalid git SHA for wait: ${fullSha}`);
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const obj = await custom.getNamespacedCustomObject({
      group: FLUX_SOURCE_GROUP,
      version: FLUX_SOURCE_VERSION,
      namespace,
      plural: "gitrepositories",
      name,
    });
    const rev = gitRepositoryArtifactRevision(obj).toLowerCase();
    if (rev.includes(normalized)) {
      return;
    }
    await sleep(2000);
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for GitRepository ${namespace}/${name} artifact to include commit ${fullSha.slice(0, 12)}…`,
  );
}
