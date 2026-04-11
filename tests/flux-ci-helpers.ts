/**
 * Shared Kubernetes / Flux wait helpers and diagnostics for integration-style tests.
 */
import { it, type TestContext } from "node:test";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import { execSafe } from "../src/utils/shell.js";
import type { RunBootstrapResult } from "../src/core/bootstrap-runner.js";
import {
  kubeConfigFromDefault,
  makeClients,
  FLUX_SYSTEM_NS,
  FLUX_INSTANCE_GROUP,
  FLUX_INSTANCE_VERSION,
  FLUX_INSTANCE_PLURAL,
  waitForAllNodesReady,
} from "../src/core/k8s-api.js";

export const SOURCE_GROUP = "source.toolkit.fluxcd.io";
export const SOURCE_V1 = "v1";
export const KUSTOMIZE_GROUP = "kustomize.toolkit.fluxcd.io";
export const KUSTOMIZE_V1 = "v1";
export const HELM_GROUP = "helm.toolkit.fluxcd.io";
export const HELM_V2 = "v2";

/** Not asserted — needs live Cloudflare API credentials. */
export const helmReleasesSkipReadyInCi: { namespace: string; name: string }[] = [
  { namespace: "external-dns", name: "external-dns" },
];

export function resolveRepoRoot(): string {
  const fromTestFile = join(dirname(fileURLToPath(import.meta.url)), "..");
  const candidates = [
    process.env.GITHUB_WORKSPACE,
    process.env.CI_PROJECT_DIR,
    process.env.GIT_WORK_TREE,
    fromTestFile,
    process.cwd(),
  ].filter((p): p is string => Boolean(p));

  const tried = [...new Set(candidates.map((c) => resolve(c)))];
  for (const root of tried) {
    if (execSafe("git rev-parse --is-inside-work-tree", { cwd: root }).exitCode !== 0) {
      continue;
    }
    try {
      return realpathSync(root);
    } catch {
      return root;
    }
  }

  throw new Error(
    `Could not find a git work tree (git rev-parse failed). Tried: ${tried.join(", ")}`,
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function httpErrorCode(e: unknown): number | undefined {
  const x = e as { statusCode?: number; code?: number; body?: { code?: number } };
  return x.statusCode ?? x.code ?? x.body?.code;
}

export function crReady(obj: unknown): boolean {
  const o = obj as {
    status?: { conditions?: Array<{ type?: string; status?: string }> };
  };
  return (
    o.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True") ??
    false
  );
}

export function listItems(body: unknown): unknown[] {
  const b = body as { items?: unknown[] };
  return b.items ?? [];
}

export function fluxCrSummaryLine(
  namespace: string | undefined,
  name: string | undefined,
  obj: unknown,
): string {
  const ready = crReady(obj) ? "Ready" : "NotReady";
  const o = obj as {
    status?: {
      conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
    };
  };
  const readyCond = o.status?.conditions?.find((c) => c.type === "Ready");
  const detail =
    readyCond && readyCond.status !== "True"
      ? ` ${[readyCond.reason, readyCond.message].filter(Boolean).join(": ").slice(0, 140)}`
      : "";
  return `${namespace ?? "?"}/${name ?? "?"}  ${ready}${detail}`;
}

export function printFluxListSummary(label: string, listBody: unknown): void {
  const items = listItems(listBody);
  console.log(`${label} (${items.length})`);
  for (const item of items) {
    const meta = (item as { metadata?: { namespace?: string; name?: string } }).metadata;
    console.log(fluxCrSummaryLine(meta?.namespace, meta?.name, item));
  }
}

async function printFluxSystemEventsSummary(core: CoreV1Api): Promise<void> {
  const ev = await core.listNamespacedEvent({ namespace: FLUX_SYSTEM_NS });
  const items = ev.items ?? [];
  console.log(`events in ${FLUX_SYSTEM_NS} (${items.length}, showing last 25)`);
  const sorted = [...items].sort((a, b) => {
    const ta = Date.parse(String(a.lastTimestamp ?? a.eventTime ?? 0)) || 0;
    const tb = Date.parse(String(b.lastTimestamp ?? b.eventTime ?? 0)) || 0;
    return ta - tb;
  });
  for (const e of sorted.slice(-25)) {
    const o = e.involvedObject;
    const msg = (e.message ?? "").replace(/\s+/g, " ").slice(0, 160);
    console.log(
      `${e.type ?? "?"}\t${e.reason ?? "?"}\t${o?.kind ?? "?"}/${o?.namespace ? `${o.namespace}/` : ""}${o?.name ?? "?"} ${msg}`,
    );
  }
}

export function log(msg: string): void {
  console.log(`\n\x1b[1m\x1b[36m==> ${msg}\x1b[0m`);
}

export async function waitForPodsReadyByLabel(
  kc: KubeConfig,
  namespace: string,
  labelSelector: string,
  timeoutMs: number,
): Promise<void> {
  const { core } = makeClients(kc);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await core.listNamespacedPod({ namespace, labelSelector });
    const items = res.items ?? [];
    if (
      items.length > 0 &&
      items.every((pod) =>
        pod.status?.conditions?.some(
          (c) => c.type === "Ready" && c.status === "True",
        ),
      )
    ) {
      return;
    }
    await sleep(2000);
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for pods (${namespace}, ${labelSelector})`,
  );
}

export async function waitForKustomizationReady(
  kc: KubeConfig,
  namespace: string,
  name: string,
  timeoutMs: number,
): Promise<void> {
  const { custom } = makeClients(kc);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const obj = await custom.getNamespacedCustomObject({
      group: KUSTOMIZE_GROUP,
      version: KUSTOMIZE_V1,
      namespace,
      plural: "kustomizations",
      name,
    });
    if (crReady(obj)) return;
    await sleep(2000);
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for Kustomization ${namespace}/${name}`,
  );
}

export async function waitForHelmReleaseReady(
  kc: KubeConfig,
  namespace: string,
  name: string,
  timeoutMs: number,
): Promise<void> {
  const { custom } = makeClients(kc);
  const deadline = Date.now() + timeoutMs;
  const plural = "helmreleases";
  while (Date.now() < deadline) {
    const obj = await custom.getNamespacedCustomObject({
      group: HELM_GROUP,
      version: HELM_V2,
      namespace,
      plural,
      name,
    });
    if (crReady(obj)) return;
    await sleep(2000);
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for HelmRelease ${namespace}/${name}`,
  );
}

async function podNameForDeployment(
  kc: KubeConfig,
  namespace: string,
  deploymentName: string,
): Promise<string | null> {
  const { apps, core } = makeClients(kc);
  const dep = await apps.readNamespacedDeployment({ name: deploymentName, namespace });
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

async function deploymentContainerLogsTail(
  kc: KubeConfig,
  namespace: string,
  deploymentName: string,
  containerName: string,
  tailLines: number,
): Promise<string> {
  const { core } = makeClients(kc);
  const podName = await podNameForDeployment(kc, namespace, deploymentName);
  if (!podName) return "(no pod for deployment)\n";
  try {
    return await core.readNamespacedPodLog({
      name: podName,
      namespace,
      container: containerName,
      tailLines,
    });
  } catch (e: unknown) {
    return `readNamespacedPodLog failed: ${String(e)}\n`;
  }
}

export async function listAllHelmReleaseRefs(
  kc: KubeConfig,
): Promise<{ namespace: string; name: string }[]> {
  const { custom } = makeClients(kc);
  const list = await custom.listCustomObjectForAllNamespaces({
    group: HELM_GROUP,
    version: HELM_V2,
    plural: "helmreleases",
  });
  const body = list as { items?: Array<{ metadata?: { namespace?: string; name?: string } }> };
  const refs: { namespace: string; name: string }[] = [];
  for (const item of body.items ?? []) {
    const ns = item.metadata?.namespace;
    const n = item.metadata?.name;
    if (ns && n) refs.push({ namespace: ns, name: n });
  }
  return refs;
}

/** Deployed chart revision from {@link HelmRelease} `status.history[0]` (Flux helm-controller). */
export interface HelmReleaseVersionSnapshot {
  chartName: string;
  chartVersion: string;
  appVersion?: string;
}

function helmRefKey(namespace: string, name: string): string {
  return `${namespace}/${name}`;
}

function snapshotFromHelmReleaseItem(item: unknown): HelmReleaseVersionSnapshot | undefined {
  const o = item as {
    status?: {
      history?: Array<{ chartName?: string; chartVersion?: string; appVersion?: string }>;
    };
  };
  const h = o.status?.history?.[0];
  if (!h) return undefined;
  const chartVersion = h.chartVersion?.trim();
  const chartName = h.chartName?.trim();
  if (!chartVersion && !chartName) return undefined;
  return {
    chartName: chartName ?? "?",
    chartVersion: chartVersion ?? "?",
    appVersion: h.appVersion?.trim() || undefined,
  };
}

/** Reads all HelmReleases and records chart name/version from the latest successful release in status. */
export async function getHelmReleaseVersionSnapshots(
  kc: KubeConfig,
): Promise<Map<string, HelmReleaseVersionSnapshot>> {
  const { custom } = makeClients(kc);
  const list = await custom.listCustomObjectForAllNamespaces({
    group: HELM_GROUP,
    version: HELM_V2,
    plural: "helmreleases",
  });
  const body = list as {
    items?: Array<{ metadata?: { namespace?: string; name?: string } }>;
  };
  const map = new Map<string, HelmReleaseVersionSnapshot>();
  for (const item of body.items ?? []) {
    const ns = item.metadata?.namespace;
    const n = item.metadata?.name;
    if (!ns || !n) continue;
    const snap = snapshotFromHelmReleaseItem(item);
    if (snap) map.set(helmRefKey(ns, n), snap);
  }
  return map;
}

function formatHelmSnapshot(s: HelmReleaseVersionSnapshot | undefined): string {
  if (!s) return "(unknown)";
  const parts = [`chart ${s.chartVersion}`];
  if (s.chartName && s.chartName !== "?") parts.unshift(s.chartName);
  if (s.appVersion) parts.push(`app ${s.appVersion}`);
  return parts.join(" · ");
}

/**
 * Logs Helm chart/app version changes between two snapshots (e.g. main baseline vs after PR upgrade).
 */
export function logHelmReleaseVersionDiff(
  title: string,
  before: Map<string, HelmReleaseVersionSnapshot>,
  after: Map<string, HelmReleaseVersionSnapshot>,
): void {
  log(title);
  const keys = new Set([...before.keys(), ...after.keys()]);
  for (const key of [...keys].sort()) {
    const b = before.get(key);
    const a = after.get(key);
    if (!b && a) {
      console.log(`  ${key}  (new)  ${formatHelmSnapshot(a)}`);
      continue;
    }
    if (b && !a) {
      console.log(`  ${key}  (removed)  was ${formatHelmSnapshot(b)}`);
      continue;
    }
    if (!b || !a) continue;
    const same =
      b.chartVersion === a.chartVersion &&
      b.appVersion === a.appVersion &&
      b.chartName === a.chartName;
    if (same) {
      console.log(`  ${key}  unchanged  ${formatHelmSnapshot(a)}`);
    } else {
      console.log(`  ${key}`);
      console.log(`    ${formatHelmSnapshot(b)}  →  ${formatHelmSnapshot(a)}`);
    }
  }
}

export async function waitForDocker(timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (execSafe("docker info").exitCode === 0) return;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error("Docker did not become available within timeout");
}

/** Flux / cluster diagnostics when a test or bootstrap fails (no secrets printed). */
export async function logFluxDiagnostics(context: string): Promise<void> {
  console.log(`\n\x1b[1m\x1b[31m── Flux / cluster diagnostics: ${context} ──\x1b[0m\n`);

  const kc = kubeConfigFromDefault();
  const { core, custom } = makeClients(kc);

  const dump = async (title: string, fn: () => Promise<void>): Promise<void> => {
    console.log(`\n▸ ${title}`);
    try {
      await fn();
    } catch (e: unknown) {
      const code = httpErrorCode(e);
      console.log(code != null ? `(error ${String(e)} code=${code})` : String(e));
    }
  };

  await dump("cluster context", async () => {
    console.log(`context: ${kc.getCurrentContext()}`);
    const cluster = kc.getCurrentCluster();
    console.log(`server: ${cluster?.server ?? "?"}`);
  });

  await dump("nodes", async () => {
    const list = await core.listNode();
    for (const n of list.items ?? []) {
      const name = n.metadata?.name ?? "?";
      const ready =
        n.status?.conditions?.find((c) => c.type === "Ready")?.status === "True";
      console.log(`${name}\t${ready ? "Ready" : "NotReady"}`);
    }
  });

  await dump("flux-system pods", async () => {
    const list = await core.listNamespacedPod({ namespace: FLUX_SYSTEM_NS });
    for (const p of list.items ?? []) {
      console.log(
        `${p.metadata?.name ?? "?"}\t${p.status?.phase ?? "?"}\t${p.status?.conditions?.find((c) => c.type === "Ready")?.status ?? "?"}`,
      );
    }
  });

  await dump("gitrepositories", async () => {
    const list = await custom.listCustomObjectForAllNamespaces({
      group: SOURCE_GROUP,
      version: SOURCE_V1,
      plural: "gitrepositories",
    });
    printFluxListSummary("GitRepository", list);
  });

  await dump("kustomizations", async () => {
    const list = await custom.listCustomObjectForAllNamespaces({
      group: KUSTOMIZE_GROUP,
      version: KUSTOMIZE_V1,
      plural: "kustomizations",
    });
    printFluxListSummary("Kustomization", list);
  });

  await dump("fluxinstance", async () => {
    const list = await custom.listCustomObjectForAllNamespaces({
      group: FLUX_INSTANCE_GROUP,
      version: FLUX_INSTANCE_VERSION,
      plural: FLUX_INSTANCE_PLURAL,
    });
    printFluxListSummary("FluxInstance", list);
  });

  await dump("helmreleases", async () => {
    const list = await custom.listCustomObjectForAllNamespaces({
      group: HELM_GROUP,
      version: HELM_V2,
      plural: "helmreleases",
    });
    printFluxListSummary("HelmRelease", list);
  });

  await dump("events flux-system", async () => {
    await printFluxSystemEventsSummary(core);
  });

  await dump("source-controller logs", async () => {
    const text = await deploymentContainerLogsTail(
      kc,
      FLUX_SYSTEM_NS,
      "source-controller",
      "manager",
      120,
    );
    console.log(text);
  });

  await dump("kustomize-controller logs", async () => {
    const text = await deploymentContainerLogsTail(
      kc,
      FLUX_SYSTEM_NS,
      "kustomize-controller",
      "manager",
      80,
    );
    console.log(text);
  });

  await dump("helm-controller logs", async () => {
    const text = await deploymentContainerLogsTail(
      kc,
      FLUX_SYSTEM_NS,
      "helm-controller",
      "manager",
      80,
    );
    console.log(text);
  });

  console.log("\x1b[1m\x1b[31m── end diagnostics ──\x1b[0m\n");
}

export function itWithDiagnostics(
  name: string,
  options: { timeout?: number } | undefined,
  fn: (t: TestContext) => void | Promise<void>,
): void {
  it(name, options ?? {}, async (t) => {
    try {
      await fn(t);
    } catch (err) {
      await logFluxDiagnostics(`test: ${name}`);
      throw err;
    }
  });
}

const skipKey = (r: { namespace: string; name: string }) => `${r.namespace}/${r.name}`;

export async function waitForClusterComponentsKustomization(
  result: RunBootstrapResult,
  t: TestContext,
): Promise<void> {
  if (!result.fluxInstanceInstalled) {
    t.skip("Flux Instance not installed");
    return;
  }

  const kc = kubeConfigFromDefault();

  try {
    log("Waiting for Flux Kustomizations to reconcile");
    await waitForKustomizationReady(
      kc,
      FLUX_SYSTEM_NS,
      "cluster-components",
      300_000,
    );
  } catch (err) {
    await logFluxDiagnostics("waitForClusterComponentsKustomization");
    throw err;
  }
}

export async function waitForAllHelmReleasesReadyFiltered(
  result: RunBootstrapResult,
  t: TestContext,
): Promise<void> {
  if (!result.fluxInstanceInstalled) {
    t.skip("Flux Instance not installed");
    return;
  }

  const kc = kubeConfigFromDefault();
  const skipSet = new Set(helmReleasesSkipReadyInCi.map(skipKey));
  const allRefs = await listAllHelmReleaseRefs(kc);
  const refs = allRefs.filter((r) => !skipSet.has(skipKey(r)));

  try {
    log("Waiting for all HelmReleases to become Ready");
    for (const r of helmReleasesSkipReadyInCi) {
      if (allRefs.some((x) => x.namespace === r.namespace && x.name === r.name)) {
        console.log(
          `  skip ${r.namespace}/${r.name} (needs live provider credentials)`,
        );
      }
    }
    for (const { namespace, name } of refs) {
      console.log(`  Waiting for ${namespace}/${name}`);
      await waitForHelmReleaseReady(kc, namespace, name, 600_000);
    }
  } catch (err) {
    await logFluxDiagnostics("waitForAllHelmReleasesReadyFiltered");
    throw err;
  }
}

/** Full stack: cluster-components Kustomization then all HelmReleases (template upgrade test). */
export async function waitForFluxClusterComponentsAndHelm(
  result: RunBootstrapResult,
  t: TestContext,
): Promise<void> {
  await waitForClusterComponentsKustomization(result, t);
  await waitForAllHelmReleasesReadyFiltered(result, t);
}

export async function assertHealthyClusterNodes(): Promise<void> {
  log("Checking cluster nodes");
  const kc = kubeConfigFromDefault();
  await waitForAllNodesReady(kc, 30_000);

  const { core } = makeClients(kc);
  const list = await core.listNode();
  const lines =
    list.items
      ?.map((n) => {
        const name = n.metadata?.name ?? "?";
        const ready =
          n.status?.conditions?.find((c) => c.type === "Ready")?.status ===
          "True";
        const ip =
          n.status?.addresses?.find((a) => a.type === "InternalIP")?.address ??
          "?";
        return `${name}\t${ready ? "Ready" : "NotReady"}\t${ip}`;
      })
      .join("\n") ?? "";
  if (lines) console.log(lines);
}

export async function assertFluxOperatorRunning(): Promise<void> {
  log("Checking Flux Operator pods");
  const kc = kubeConfigFromDefault();
  await waitForPodsReadyByLabel(
    kc,
    FLUX_SYSTEM_NS,
    "app.kubernetes.io/name=flux-operator",
    60_000,
  );

  const { core } = makeClients(kc);
  const list = await core.listNamespacedPod({
    namespace: FLUX_SYSTEM_NS,
    labelSelector: "app.kubernetes.io/name=flux-operator",
  });
  for (const p of list.items ?? []) {
    const ready = p.status?.conditions?.find((c) => c.type === "Ready")?.status ?? "?";
    console.log(
      `${p.metadata?.name ?? "?"}\t${p.status?.phase ?? "?"}\tReady=${ready}`,
    );
  }
}
