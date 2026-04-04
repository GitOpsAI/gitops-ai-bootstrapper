import { describe, it, before, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import { execSafe } from "../src/utils/shell.js";
import { runBootstrap, type RunBootstrapResult } from "../src/core/bootstrap-runner.js";
import { COMPONENTS, type ProviderType } from "../src/schemas.js";
import {
  kubeConfigFromDefault,
  makeClients,
  FLUX_SYSTEM_NS,
  FLUX_INSTANCE_GROUP,
  FLUX_INSTANCE_VERSION,
  FLUX_INSTANCE_PLURAL,
  waitForAllNodesReady,
} from "../src/core/k8s-api.js";

const SOURCE_GROUP = "source.toolkit.fluxcd.io";
const SOURCE_V1 = "v1";
const KUSTOMIZE_GROUP = "kustomize.toolkit.fluxcd.io";
const KUSTOMIZE_V1 = "v1";
const HELM_GROUP = "helm.toolkit.fluxcd.io";
const HELM_V2 = "v2";

/**
 * Canonical git work tree. Prefer `GITHUB_WORKSPACE` on the Actions runner (integration
 * job runs on the VM, not in node:alpine, so `actions/checkout` is a real clone).
 */
function resolveRepoRoot(): string {
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

const ALL_COMPONENT_IDS = COMPONENTS.map((c) => c.id);

// ---------------------------------------------------------------------------
// CI environment (explicit env vars override; on GitHub Actions we default from GITHUB_*)
// ---------------------------------------------------------------------------

const inGitHubActions = process.env.GITHUB_ACTIONS === "true";
const ghRepo = process.env.GITHUB_REPOSITORY ?? "";
const [ghOwner, ghName] = ghRepo.includes("/") ? ghRepo.split("/", 2) : ["", ""];

const GIT_PROVIDER = (process.env.GIT_PROVIDER ??
  (inGitHubActions ? "github" : "gitlab")) as ProviderType;
const CI_PIPELINE_ID =
  process.env.CI_PIPELINE_ID ?? process.env.GITHUB_RUN_ID ?? "local";
const CI_SERVER_HOST = process.env.CI_SERVER_HOST ?? (GIT_PROVIDER === "github" ? "github.com" : "gitlab.com");
const CI_PROJECT_PATH = process.env.CI_PROJECT_PATH ?? (inGitHubActions ? ghRepo : "");
const CI_PROJECT_NAME =
  process.env.CI_PROJECT_NAME ?? (inGitHubActions ? ghName : "");
const CI_PROJECT_NAMESPACE =
  process.env.CI_PROJECT_NAMESPACE ??
  (inGitHubActions ? (process.env.GITHUB_REPOSITORY_OWNER ?? ghOwner) : "");
/** Git HTTPS password for bootstrap (push) and, unless `FLUX_GIT_TOKEN` is set, for the Flux `flux-system` secret. In GitHub Actions CI we set `GIT_TOKEN` to `GITHUB_TOKEN`. */
const GIT_TOKEN = process.env.GIT_TOKEN ?? process.env.GITLAB_PAT ?? process.env.GITHUB_TOKEN ?? "";
/** Optional override for Flux only — use when `GITHUB_TOKEN` cannot clone the repo (e.g. fork PRs). */
const FLUX_GIT_TOKEN = process.env.FLUX_GIT_TOKEN?.trim() ?? "";

const SOURCE_BRANCH = `ci-test-${CI_PIPELINE_ID}`;
const CLUSTER_NAME = "ci-test";

let result: RunBootstrapResult;
let repoRoot: string | undefined;

// ---------------------------------------------------------------------------
// Helpers (Kubernetes API — no kubectl)
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function httpErrorCode(e: unknown): number | undefined {
  const x = e as { statusCode?: number; code?: number; body?: { code?: number } };
  return x.statusCode ?? x.code ?? x.body?.code;
}

function crReady(obj: unknown): boolean {
  const o = obj as {
    status?: { conditions?: Array<{ type?: string; status?: string }> };
  };
  return (
    o.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True") ??
    false
  );
}

function listItems(body: unknown): unknown[] {
  const b = body as { items?: unknown[] };
  return b.items ?? [];
}

/** One line per object: namespace/name, Ready/NotReady, short message (for failure diagnostics). */
function fluxCrSummaryLine(namespace: string | undefined, name: string | undefined, obj: unknown): string {
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

function printFluxListSummary(label: string, listBody: unknown): void {
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

function log(msg: string): void {
  console.log(`\n\x1b[1m\x1b[36m==> ${msg}\x1b[0m`);
}

async function waitForPodsReadyByLabel(
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

async function waitForKustomizationReady(
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

async function waitForHelmReleaseReady(
  kc: KubeConfig,
  namespace: string,
  name: string,
  timeoutMs: number,
): Promise<void> {
  const { custom } = makeClients(kc);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const obj = await custom.getNamespacedCustomObject({
      group: HELM_GROUP,
      version: HELM_V2,
      namespace,
      plural: "helmreleases",
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

async function listAllHelmReleaseRefs(
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

function remoteUrl(): string {
  if (GIT_PROVIDER === "github") {
    return `https://x-access-token:${GIT_TOKEN}@${CI_SERVER_HOST}/${CI_PROJECT_PATH}.git`;
  }
  return `https://oauth2:${GIT_TOKEN}@${CI_SERVER_HOST}/${CI_PROJECT_PATH}.git`;
}

async function waitForDocker(timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (execSafe("docker info").exitCode === 0) return;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error("Docker did not become available within timeout");
}

/** Flux / cluster diagnostics when a test or bootstrap fails (no secrets printed). Uses the Kubernetes API only. */
async function logFluxDiagnostics(context: string): Promise<void> {
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

function itWithDiagnostics(
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Integration", { timeout: 1_800_000 }, () => {
  before(async () => {
    try {
      repoRoot = resolveRepoRoot();

      log("Waiting for Docker");
      await waitForDocker();

      log("Running bootstrap");
      result = await runBootstrap(
        {
          gitProvider: GIT_PROVIDER,
          clusterName: CLUSTER_NAME,
          clusterDomain: "example.com",
          clusterPublicIp: "127.0.0.1",
          letsencryptEmail: "ci@example.com",
          ingressAllowedIps: "0.0.0.0/0",
          gitToken: GIT_TOKEN,
          gitFluxToken: FLUX_GIT_TOKEN || undefined,
          repoName: CI_PROJECT_NAME,
          repoOwner: CI_PROJECT_NAMESPACE,
          repoBranch: SOURCE_BRANCH,
          selectedComponents: ALL_COMPONENT_IDS,
        },
        repoRoot,
      );
    } catch (err) {
      await logFluxDiagnostics("before hook (bootstrap)");
      throw err;
    }
  });

  after(() => {
    if (!repoRoot) return;
    log("Cleaning up test branch");
    execSafe(`git push "${remoteUrl()}" --delete "${SOURCE_BRANCH}"`, {
      cwd: repoRoot,
    });
  });

  // ── Assertions ──────────────────────────────────────────────────────────

  itWithDiagnostics("should have healthy cluster nodes", undefined, async () => {
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
  });

  itWithDiagnostics("should have Flux Operator running", undefined, async () => {
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
  });

  it("should reconcile Flux Kustomizations", { timeout: 360_000 }, async (t) => {
    if (!result.fluxInstanceInstalled) {
      t.skip("Flux Instance not installed (no flux-instance.yaml)");
      return;
    }

    try {
      log("Waiting for Flux Kustomizations to reconcile");
      const kc = kubeConfigFromDefault();
      await waitForKustomizationReady(
        kc,
        FLUX_SYSTEM_NS,
        "cluster-components",
        300_000,
      );
    } catch (err) {
      await logFluxDiagnostics("test: should reconcile Flux Kustomizations");
      throw err;
    }
  });

  it("should have all HelmReleases ready", { timeout: 900_000 }, async (t) => {
    if (!result.fluxInstanceInstalled) {
      t.skip("Flux Instance not installed");
      return;
    }

    try {
      /** Not asserted here — needs live Cloudflare API credentials. Flux also re-applies these from Git, so deleting the CR does not remove them for long. */
      const helmReleasesSkipReadyInCi: { namespace: string; name: string }[] = [
        { namespace: "external-dns", name: "external-dns" },
      ];
      const kc = kubeConfigFromDefault();
      const allRefs = await listAllHelmReleaseRefs(kc);
      const skipKey = (r: { namespace: string; name: string }) =>
        `${r.namespace}/${r.name}`;
      const skipSet = new Set(helmReleasesSkipReadyInCi.map(skipKey));
      const refs = allRefs.filter((r) => !skipSet.has(skipKey(r)));

      log("Waiting for all HelmReleases to become Ready");
      for (const r of helmReleasesSkipReadyInCi) {
        if (allRefs.some((x) => x.namespace === r.namespace && x.name === r.name)) {
          console.log(
            `  skip ${r.namespace}/${r.name} (needs live provider credentials; not deleted — Flux re-applies from Git)`,
          );
        }
      }
      for (const { namespace, name } of refs) {
        console.log(`  Waiting for ${namespace}/${name}`);
        await waitForHelmReleaseReady(kc, namespace, name, 600_000);
      }
    } catch (err) {
      await logFluxDiagnostics("test: should have all HelmReleases ready");
      throw err;
    }
  });

  itWithDiagnostics("should display cluster status", undefined, async () => {
    log("Cluster status");
    const kc = kubeConfigFromDefault();
    const { core, custom } = makeClients(kc);

    console.log("\n── Namespaces ──");
    const nsList = await core.listNamespace();
    const nsNames = (nsList.items ?? [])
      .map((n) => n.metadata?.name)
      .filter((x): x is string => Boolean(x))
      .sort();
    console.log(`count: ${nsNames.length}`);
    for (const n of nsNames) console.log(n);

    console.log("\n── Pods (all namespaces) ──");
    const podList = await core.listPodForAllNamespaces();
    const pods = podList.items ?? [];
    const maxPods = 80;
    console.log(`count: ${pods.length} (showing first ${Math.min(maxPods, pods.length)})`);
    for (const p of pods.slice(0, maxPods)) {
      console.log(
        `${p.metadata?.namespace ?? "?"}/${p.metadata?.name ?? "?"}  ${p.status?.phase ?? "?"}`,
      );
    }
    if (pods.length > maxPods) {
      console.log(`… and ${pods.length - maxPods} more`);
    }

    const kustomizations = await custom.listCustomObjectForAllNamespaces({
      group: KUSTOMIZE_GROUP,
      version: KUSTOMIZE_V1,
      plural: "kustomizations",
    });
    console.log("\n── Kustomizations ──");
    printFluxListSummary("Kustomization", kustomizations);

    const gitrepos = await custom.listCustomObjectForAllNamespaces({
      group: SOURCE_GROUP,
      version: SOURCE_V1,
      plural: "gitrepositories",
    });
    console.log("\n── GitRepositories ──");
    printFluxListSummary("GitRepository", gitrepos);

    const helmrepos = await custom.listCustomObjectForAllNamespaces({
      group: SOURCE_GROUP,
      version: SOURCE_V1,
      plural: "helmrepositories",
    });
    console.log("\n── HelmRepositories ──");
    printFluxListSummary("HelmRepository", helmrepos);

    const helmreleases = await custom.listCustomObjectForAllNamespaces({
      group: HELM_GROUP,
      version: HELM_V2,
      plural: "helmreleases",
    });
    console.log("\n── HelmReleases ──");
    printFluxListSummary("HelmRelease", helmreleases);
  });
});
