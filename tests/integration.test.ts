import { describe, it, before, after } from "node:test";
import { execSafe } from "../src/utils/shell.js";
import { runBootstrap, type RunBootstrapResult } from "../src/core/bootstrap-runner.js";
import { COMPONENTS, type ProviderType } from "../src/schemas.js";
import { kubeConfigFromDefault, makeClients, FLUX_SYSTEM_NS } from "../src/core/k8s-api.js";
import {
  resolveRepoRoot,
  waitForDocker,
  logFluxDiagnostics,
  itWithDiagnostics,
  log,
  printFluxListSummary,
  KUSTOMIZE_GROUP,
  KUSTOMIZE_V1,
  SOURCE_GROUP,
  SOURCE_V1,
  HELM_GROUP,
  HELM_V2,
  waitForClusterComponentsKustomization,
  waitForAllHelmReleasesReadyFiltered,
  assertHealthyClusterNodes,
  assertFluxOperatorRunning,
} from "./flux-ci-helpers.js";

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
const GIT_TOKEN = process.env.GIT_TOKEN ?? process.env.GITLAB_PAT ?? process.env.GITHUB_TOKEN ?? "";
const FLUX_GIT_TOKEN = process.env.FLUX_GIT_TOKEN?.trim() ?? "";

const SOURCE_BRANCH = `ci-test-${CI_PIPELINE_ID}`;
const CLUSTER_NAME = "ci-test";

let result: RunBootstrapResult;
let repoRoot: string | undefined;

function remoteUrl(): string {
  if (GIT_PROVIDER === "github") {
    return `https://x-access-token:${GIT_TOKEN}@${CI_SERVER_HOST}/${CI_PROJECT_PATH}.git`;
  }
  return `https://oauth2:${GIT_TOKEN}@${CI_SERVER_HOST}/${CI_PROJECT_PATH}.git`;
}

const ALL_COMPONENT_IDS = COMPONENTS.map((c) => c.id);

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

  itWithDiagnostics("should have healthy cluster nodes", undefined, async () => {
    await assertHealthyClusterNodes();
  });

  itWithDiagnostics("should have Flux Operator running", undefined, async () => {
    await assertFluxOperatorRunning();
  });

  it("should reconcile Flux Kustomizations", { timeout: 360_000 }, async (t) => {
    try {
      await waitForClusterComponentsKustomization(result, t);
    } catch (err) {
      await logFluxDiagnostics("test: should reconcile Flux Kustomizations");
      throw err;
    }
  });

  it("should have all HelmReleases ready", { timeout: 900_000 }, async (t) => {
    try {
      await waitForAllHelmReleasesReadyFiltered(result, t);
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
