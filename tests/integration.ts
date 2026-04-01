import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  cpSync,
  mkdirSync,
} from "node:fs";
import { exec, execSafe } from "../src/utils/shell.js";
import * as k8s from "../src/core/kubernetes.js";
import * as flux from "../src/core/flux.js";
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
const CLUSTER_DOMAIN = "example.com";
const CLUSTER_PUBLIC_IP = "127.0.0.1";
const LETSENCRYPT_EMAIL = "ci@example.com";
const INGRESS_ALLOWED_IPS = "0.0.0.0/0";

let fluxInstanceInstalled = false;

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

function envsubst(content: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce(
    (acc, [k, v]) => acc.replaceAll(`\${${k}}`, v),
    content,
  );
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

    // ── Kubernetes cluster ──────────────────────────────────────────────
    log("Creating k3d cluster");
    await k8s.createK3dCluster(CLUSTER_NAME);

    log("Setting up kubeconfig");
    k8s.setupKubeconfig(CLUSTER_NAME);

    log("Waiting for cluster nodes");
    await k8s.waitForCluster();

    // ── Flux ────────────────────────────────────────────────────────────
    log("Installing Flux Operator");
    await flux.installOperator();

    log("Creating GitLab auth secret");
    await k8s.createNamespace("flux-system");
    await k8s.createSecret("flux-system", "flux-system", {
      username: "git",
      password: GITLAB_PAT,
    });

    // ── Cluster template (present in the template repo) ─────────────────
    if (existsSync("clusters/_default-template")) {
      log("Rendering cluster template");
      const clusterDir = `clusters/${CLUSTER_NAME}`;
      mkdirSync(clusterDir, { recursive: true });
      cpSync("clusters/_default-template", clusterDir, { recursive: true });

      const syncFile = `${clusterDir}/cluster-sync.yaml`;
      if (existsSync(syncFile)) {
        writeFileSync(
          syncFile,
          envsubst(readFileSync(syncFile, "utf-8"), {
            CLUSTER_NAME,
            CLUSTER_DOMAIN,
            CLUSTER_PUBLIC_IP,
            LETSENCRYPT_EMAIL,
            INGRESS_NGINX_ALLOWED_IPS: INGRESS_ALLOWED_IPS,
          }),
        );
      }

      exec("git add .");
      execSafe('git commit -m "ci: render cluster template"');
      exec(`git push origin "${SOURCE_BRANCH}"`);
    }

    // ── Flux Instance (needs flux-instance-values.yaml) ─────────────────
    if (existsSync("flux-instance-values.yaml")) {
      log("Installing Flux Instance");
      const config: BootstrapConfig = {
        clusterName: CLUSTER_NAME,
        clusterDomain: CLUSTER_DOMAIN,
        clusterPublicIp: CLUSTER_PUBLIC_IP,
        letsencryptEmail: LETSENCRYPT_EMAIL,
        ingressAllowedIps: INGRESS_ALLOWED_IPS,
        gitlabPat: GITLAB_PAT,
        repoName: CI_PROJECT_NAME,
        repoOwner: CI_PROJECT_NAMESPACE,
        repoBranch: SOURCE_BRANCH,
        selectedComponents: [],
      };

      await flux.installInstance(config, process.cwd());
      await flux.waitForInstance();
      await flux.reconcile();
      fluxInstanceInstalled = true;
    }
  });

  after(() => {
    log("Cleaning up test branch");
    execSafe(`git push "${remoteUrl()}" --delete "${SOURCE_BRANCH}"`);
  });

  // ── Assertions ──────────────────────────────────────────────────────────

  it("should reconcile Flux Kustomizations", { timeout: 360_000 }, (t) => {
    if (!fluxInstanceInstalled) {
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
    if (!fluxInstanceInstalled) {
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
    if (!fluxInstanceInstalled) {
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
