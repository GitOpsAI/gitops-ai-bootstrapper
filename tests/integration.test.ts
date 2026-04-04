import { describe, it, before, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSafe } from "../src/utils/shell.js";
import { runBootstrap, type RunBootstrapResult } from "../src/core/bootstrap-runner.js";
import { COMPONENTS, type ProviderType } from "../src/schemas.js";

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
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string): void {
  console.log(`\n\x1b[1m\x1b[36m==> ${msg}\x1b[0m`);
}

async function waitForDocker(timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (execSafe("docker info").exitCode === 0) return;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error("Docker did not become available within timeout");
}

function remoteUrl(): string {
  if (GIT_PROVIDER === "github") {
    return `https://x-access-token:${GIT_TOKEN}@${CI_SERVER_HOST}/${CI_PROJECT_PATH}.git`;
  }
  return `https://oauth2:${GIT_TOKEN}@${CI_SERVER_HOST}/${CI_PROJECT_PATH}.git`;
}

/** kubectl / Flux context when a test or bootstrap fails (no secrets printed). */
function logFluxDiagnostics(context: string): void {
  console.log(`\n\x1b[1m\x1b[31m── Flux / cluster diagnostics: ${context} ──\x1b[0m\n`);

  const dump = (title: string, cmd: string): void => {
    console.log(`\n▸ ${title}`);
    const r = execSafe(cmd);
    const out = [r.stdout, r.stderr].filter(Boolean).join("\n");
    if (out) console.log(out);
    if (r.exitCode !== 0) console.log(`(exit ${r.exitCode})`);
  };

  dump("cluster-info", "kubectl cluster-info");
  dump("nodes", "kubectl get nodes -o wide");
  dump("flux-system pods", "kubectl get pods -n flux-system -o wide");
  dump("gitrepositories (list)", "kubectl get gitrepository -A -o wide");
  dump("gitrepositories (yaml)", "kubectl get gitrepository -A -o yaml");
  dump("kustomizations (list)", "kubectl get kustomization -A -o wide");
  dump("fluxinstance", "kubectl get fluxinstance -A -o wide");
  dump("fluxinstance describe", "kubectl describe fluxinstance -n flux-system flux");
  dump("helmreleases (list)", "kubectl get helmrelease -A -o wide");
  dump("events flux-system", "kubectl get events -n flux-system");
  dump("source-controller logs", "kubectl logs -n flux-system deploy/source-controller --tail=120");
  dump("kustomize-controller logs", "kubectl logs -n flux-system deploy/kustomize-controller --tail=80");
  dump("helm-controller logs", "kubectl logs -n flux-system deploy/helm-controller --tail=80");

  const gr = execSafe(
    "kubectl get gitrepository -A -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name --no-headers",
  );
  for (const line of gr.stdout.split("\n").filter(Boolean)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2) {
      const ns = parts[0]!;
      const name = parts[1]!;
      dump(`describe gitrepository ${ns}/${name}`, `kubectl describe gitrepository ${name} -n ${ns}`);
    }
  }

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
      logFluxDiagnostics(`test: ${name}`);
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
      logFluxDiagnostics("before hook (bootstrap)");
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

  itWithDiagnostics("should have healthy cluster nodes", undefined, () => {
    log("Checking cluster nodes");
    const { exitCode, stderr } = execSafe(
      "kubectl wait --for=condition=Ready node --all --timeout=30s",
    );
    assert.equal(exitCode, 0, `Nodes not ready: ${stderr}`);

    const { stdout } = execSafe("kubectl get nodes -o wide");
    if (stdout) console.log(stdout);
  });

  itWithDiagnostics("should have Flux Operator running", undefined, () => {
    log("Checking Flux Operator pods");
    const { exitCode, stderr } = execSafe(
      "kubectl -n flux-system wait pod --for=condition=Ready -l app.kubernetes.io/name=flux-operator --timeout=60s",
    );
    assert.equal(exitCode, 0, `Flux Operator pod not ready: ${stderr}`);

    const { stdout } = execSafe("kubectl get pods -n flux-system");
    if (stdout) console.log(stdout);
  });

  it("should reconcile Flux Kustomizations", { timeout: 360_000 }, async (t) => {
    if (!result.fluxInstanceInstalled) {
      t.skip("Flux Instance not installed (no flux-instance-values.yaml)");
      return;
    }

    try {
      log("Waiting for Flux Kustomizations to reconcile");
      const { exitCode, stderr } = execSafe(
        "kubectl -n flux-system wait kustomization/cluster-components --for=condition=Ready --timeout=5m",
      );
      assert.equal(exitCode, 0, `Kustomization not ready: ${stderr}`);
    } catch (err) {
      logFluxDiagnostics("test: should reconcile Flux Kustomizations");
      throw err;
    }
  });

  it("should have all HelmReleases ready", { timeout: 900_000 }, async (t) => {
    if (!result.fluxInstanceInstalled) {
      t.skip("Flux Instance not installed");
      return;
    }

    try {
      /** Skipped so the suite does not need live Cloudflare API credentials. */
      const helmReleasesRemovedForCi: { namespace: string; name: string }[] = [
        { namespace: "external-dns", name: "external-dns" },
      ];
      log("Removing HelmReleases that require real credentials:");
      for (const { namespace, name } of helmReleasesRemovedForCi) {
        console.log(`  delete HelmRelease ${namespace}/${name}`);
        execSafe(
          `kubectl delete helmrelease "${name}" -n "${namespace}" --ignore-not-found`,
        );
      }

      log("Waiting for all HelmReleases to become Ready");
      const { stdout } = execSafe(
        `kubectl get helmrelease -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}{"\\n"}{end}'`,
      );

      for (const line of stdout.split("\n").filter(Boolean)) {
        const slash = line.indexOf("/");
        if (slash === -1) continue;
        const ns = line.slice(0, slash);
        const name = line.slice(slash + 1);
        console.log(`  Waiting for ${ns}/${name}`);
        const { exitCode, stderr } = execSafe(
          `kubectl -n "${ns}" wait helmrelease/"${name}" --for=condition=Ready --timeout=10m`,
        );
        assert.equal(exitCode, 0, `HelmRelease ${ns}/${name} not ready: ${stderr}`);
      }
    } catch (err) {
      logFluxDiagnostics("test: should have all HelmReleases ready");
      throw err;
    }
  });

  itWithDiagnostics("should display cluster status", undefined, () => {
    log("Cluster status");

    const sections: [string, string][] = [
      ["Namespaces",        "kubectl get namespaces"],
      ["Pods (all)",        "kubectl get pods -A"],
      ["Kustomizations",    "kubectl get kustomizations -A"],
      ["GitRepositories",   "kubectl get gitrepositories -A"],
      ["HelmRepositories",  "kubectl get helmrepositories -A"],
      ["HelmReleases",      "kubectl get helmreleases -A"],
    ];

    for (const [label, cmd] of sections) {
      const { stdout } = execSafe(cmd);
      if (stdout) {
        console.log(`\n── ${label} ──`);
        console.log(stdout);
      }
    }
  });
});
