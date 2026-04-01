import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { exec, execSafe } from "../src/utils/shell.js";
import { runBootstrap, type RunBootstrapResult } from "../src/core/bootstrap-runner.js";
import type { BootstrapConfig } from "../src/schemas.js";

// ---------------------------------------------------------------------------
// CI environment
// ---------------------------------------------------------------------------

const CI_PIPELINE_ID = process.env.CI_PIPELINE_ID ?? "local";
const CI_SERVER_HOST = process.env.CI_SERVER_HOST ?? "gitlab.com";
const CI_PROJECT_PATH = process.env.CI_PROJECT_PATH ?? "";
const CI_PROJECT_NAME = process.env.CI_PROJECT_NAME ?? "";
const CI_PROJECT_NAMESPACE = process.env.CI_PROJECT_NAMESPACE ?? "";
const GITLAB_PAT = process.env.GITLAB_PAT ?? "";

const SOURCE_BRANCH = `ci-test-${CI_PIPELINE_ID}`;
const CLUSTER_NAME = "ci-test";

let result: RunBootstrapResult;

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
  return `https://oauth2:${GITLAB_PAT}@${CI_SERVER_HOST}/${CI_PROJECT_PATH}.git`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Integration", { timeout: 1_800_000 }, () => {
  before(async () => {
    log("Waiting for Docker");
    await waitForDocker();

    // ── Git test branch ─────────────────────────────────────────────────
    log("Setting up test branch");
    exec('git config --global user.email "ci@example.com"');
    exec('git config --global user.name "GitLab CI"');
    try {
      exec(`git remote set-url origin "${remoteUrl()}"`);
    } catch {
      exec(`git remote add origin "${remoteUrl()}"`);
    }
    exec(`git checkout -b "${SOURCE_BRANCH}"`);
    exec(`git push -u origin "${SOURCE_BRANCH}"`);

    // ── Bootstrap ───────────────────────────────────────────────────────
    log("Running bootstrap");
    const config: BootstrapConfig = {
      clusterName: CLUSTER_NAME,
      clusterDomain: "example.com",
      clusterPublicIp: "127.0.0.1",
      letsencryptEmail: "ci@example.com",
      ingressAllowedIps: "0.0.0.0/0",
      gitlabPat: GITLAB_PAT,
      repoName: CI_PROJECT_NAME,
      repoOwner: CI_PROJECT_NAMESPACE,
      repoBranch: SOURCE_BRANCH,
      selectedComponents: [],
    };

    result = await runBootstrap(config, process.cwd(), {
      skipSops: true,
      skipComponentPruning: true,
    });
  });

  after(() => {
    log("Cleaning up test branch");
    execSafe(`git push "${remoteUrl()}" --delete "${SOURCE_BRANCH}"`);
  });

  // ── Assertions ──────────────────────────────────────────────────────────

  it("should reconcile Flux Kustomizations", { timeout: 360_000 }, (t) => {
    if (!result.fluxInstanceInstalled) {
      t.skip("Flux Instance not installed (no flux-instance-values.yaml)");
      return;
    }

    log("Waiting for Flux Kustomizations to reconcile");
    const { exitCode, stderr } = execSafe(
      "kubectl -n flux-system wait kustomization/cluster-components --for=condition=Ready --timeout=5m",
    );
    assert.equal(exitCode, 0, `Kustomization not ready: ${stderr}`);
  });

  it("should have all HelmReleases ready after cleanup", { timeout: 900_000 }, (t) => {
    if (!result.fluxInstanceInstalled) {
      t.skip("Flux Instance not installed");
      return;
    }

    log("Removing HelmReleases that require real credentials");
    execSafe(
      "kubectl delete helmrelease external-dns -n external-dns --ignore-not-found",
    );

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
  });

  it("should display Flux reconciliation status", (t) => {
    if (!result.fluxInstanceInstalled) {
      t.skip("Flux Instance not installed");
      return;
    }

    log("Flux reconciliation status");
    const resources = [
      "kustomizations",
      "gitrepositories",
      "helmrepositories",
      "helmreleases",
    ];
    for (const resource of resources) {
      const { stdout } = execSafe(`kubectl get ${resource} -A`);
      if (stdout) console.log(stdout);
    }
  });
});
