/**
 * Template upgrade test (invoked from gitops-ai-template PR workflow): bootstrap the template as on
 * `main`, wait for Flux + Helm to settle, run the same merge path as `gitops-ai template sync`
 * (fetch PR head into FETCH_HEAD, diff, merge), re-apply the cluster directory, push, and verify
 * the stack again — simulating upgrading live clusters to a new template revision.
 *
 * Requires {@link process.env.TEMPLATE_UPGRADE_TEST} === "true" (set by the template repo CI job)
 * and {@link process.env.TEMPLATE_UPGRADE_PR_NUMBER}.
 */
import { describe, it, before, after } from "node:test";
import { execAsync, execSafe } from "../src/utils/shell.js";
import {
  runBootstrap,
  applyClusterTemplateAndPush,
  type RunBootstrapResult,
} from "../src/core/bootstrap-runner.js";
import { reconcile } from "../src/core/flux.js";
import { mergeUpstreamTemplate } from "../src/core/template-sync.js";
import { COMPONENTS, type ProviderType } from "../src/schemas.js";
import {
  FLUX_SYSTEM_NS,
  kubeConfigFromDefault,
  reconcileGitRepository,
  waitForGitRepositoryArtifactContainsSha,
} from "../src/core/k8s-api.js";
import {
  resolveRepoRoot,
  waitForDocker,
  logFluxDiagnostics,
  itWithDiagnostics,
  log,
  waitForFluxClusterComponentsAndHelm,
  assertHealthyClusterNodes,
  assertFluxOperatorRunning,
  getHelmReleaseVersionSnapshots,
  logHelmReleaseVersionDiff,
  type HelmReleaseVersionSnapshot,
} from "./flux-ci-helpers.js";

const templateUpgradeTestEnabled =
  process.env.TEMPLATE_UPGRADE_TEST === "true" &&
  Boolean(process.env.TEMPLATE_UPGRADE_PR_NUMBER?.trim());

const inGitHubActions = process.env.GITHUB_ACTIONS === "true";
const ghRepo = process.env.GITHUB_REPOSITORY ?? "";
const [ghOwner, ghName] = ghRepo.includes("/") ? ghRepo.split("/", 2) : ["", ""];

const GIT_PROVIDER = (process.env.GIT_PROVIDER ??
  (inGitHubActions ? "github" : "gitlab")) as ProviderType;
const CI_PIPELINE_ID =
  process.env.CI_PIPELINE_ID ?? process.env.GITHUB_RUN_ID ?? "local";
const CI_SERVER_HOST =
  process.env.CI_SERVER_HOST ?? (GIT_PROVIDER === "github" ? "github.com" : "gitlab.com");
const CI_PROJECT_PATH = process.env.CI_PROJECT_PATH ?? (inGitHubActions ? ghRepo : "");
const CI_PROJECT_NAME = process.env.CI_PROJECT_NAME ?? (inGitHubActions ? ghName : "");
const CI_PROJECT_NAMESPACE =
  process.env.CI_PROJECT_NAMESPACE ??
  (inGitHubActions ? (process.env.GITHUB_REPOSITORY_OWNER ?? ghOwner) : "");
const GIT_TOKEN = process.env.GIT_TOKEN ?? process.env.GITLAB_PAT ?? process.env.GITHUB_TOKEN ?? "";
const FLUX_GIT_TOKEN = process.env.FLUX_GIT_TOKEN?.trim() ?? "";

const TEMPLATE_UPGRADE_BRANCH = `ci-template-upgrade-${CI_PIPELINE_ID}`;
const CLUSTER_NAME = "ci-test";

const ALL_COMPONENT_IDS = COMPONENTS.map((c) => c.id);

let result: RunBootstrapResult;
let repoRoot: string | undefined;
/** Helm chart versions observed after main baseline (before PR merge). */
let helmVersionsBaseline: Map<string, HelmReleaseVersionSnapshot> | undefined;

function remoteUrl(): string {
  if (GIT_PROVIDER === "github") {
    return `https://x-access-token:${GIT_TOKEN}@${CI_SERVER_HOST}/${CI_PROJECT_PATH}.git`;
  }
  return `https://oauth2:${GIT_TOKEN}@${CI_SERVER_HOST}/${CI_PROJECT_PATH}.git`;
}

function bootstrapConfig() {
  return {
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
    repoBranch: TEMPLATE_UPGRADE_BRANCH,
    selectedComponents: ALL_COMPONENT_IDS,
  };
}

describe(
  "Template upgrade test (main baseline → PR)",
  { skip: !templateUpgradeTestEnabled, timeout: 2_400_000 },
  () => {
    before(async () => {
      try {
        repoRoot = resolveRepoRoot();

        log("Fetching main and checking out for baseline bootstrap");
        execSafe("git fetch origin main", { cwd: repoRoot });
        const co = execSafe("git checkout main", { cwd: repoRoot });
        if (co.exitCode !== 0) {
          execSafe("git checkout -B main origin/main", { cwd: repoRoot });
        }
        execSafe("git reset --hard origin/main", { cwd: repoRoot });

        log("Waiting for Docker");
        await waitForDocker();

        log("Running bootstrap from main onto template-upgrade branch");
        result = await runBootstrap(bootstrapConfig(), repoRoot!);
      } catch (err) {
        await logFluxDiagnostics("template-upgrade before hook (bootstrap from main)");
        throw err;
      }
    });

    after(() => {
      if (!repoRoot) return;
      log("Cleaning up template-upgrade branch");
      execSafe(`git push "${remoteUrl()}" --delete "${TEMPLATE_UPGRADE_BRANCH}"`, {
        cwd: repoRoot,
      });
    });

    itWithDiagnostics("should have healthy cluster nodes after baseline bootstrap", undefined, async () => {
      await assertHealthyClusterNodes();
    });

    itWithDiagnostics("should have Flux Operator running after baseline", undefined, async () => {
      await assertFluxOperatorRunning();
    });

    it("should reconcile all components on main baseline", { timeout: 1_200_000 }, async (t) => {
      try {
        await waitForFluxClusterComponentsAndHelm(result, t);
        helmVersionsBaseline = await getHelmReleaseVersionSnapshots(kubeConfigFromDefault());
        log("Helm chart versions (main baseline)");
        for (const key of [...helmVersionsBaseline.keys()].sort()) {
          const s = helmVersionsBaseline.get(key)!;
          console.log(
            `  ${key}  ${s.chartName} · chart ${s.chartVersion}${s.appVersion ? ` · app ${s.appVersion}` : ""}`,
          );
        }
      } catch (err) {
        await logFluxDiagnostics("template-upgrade: baseline stack ready");
        throw err;
      }
    });

    it(
      "should template-sync PR head, push cluster overlay, and reconcile Flux",
      { timeout: 600_000 },
      async () => {
        const pr = process.env.TEMPLATE_UPGRADE_PR_NUMBER!.trim();
        const root = repoRoot!;
        log(
          `Template sync (merge FETCH_HEAD): PR #${pr} → branch ${TEMPLATE_UPGRADE_BRANCH} (current branch)`,
        );

        await mergeUpstreamTemplate({
          repoRoot: root,
          ref: `pull/${pr}/head`,
          dryRun: false,
          remoteName: "upstream",
          allowUnrelatedHistories: false,
        });

        log("Pushing template-sync merge to origin");
        await execAsync(`git push origin "${TEMPLATE_UPGRADE_BRANCH}"`, { cwd: root });

        log("Re-applying cluster template from merged tree and pushing");
        await applyClusterTemplateAndPush(bootstrapConfig(), root, {
          commitMessage: `ci: regenerate cluster after template sync (PR #${pr})`,
        });

        const head = execSafe("git rev-parse HEAD", { cwd: root });
        if (head.exitCode !== 0) {
          throw new Error(`git rev-parse HEAD failed: ${head.stderr || head.stdout}`);
        }
        const pushedSha = head.stdout.trim();

        log("Reconciling GitRepository and waiting for source-controller to fetch pushed revision");
        const kc = kubeConfigFromDefault();
        await reconcileGitRepository(kc, FLUX_SYSTEM_NS, "flux-system");
        await waitForGitRepositoryArtifactContainsSha(
          kc,
          FLUX_SYSTEM_NS,
          "flux-system",
          pushedSha,
          300_000,
        );

        log("Triggering Flux reconcile");
        await reconcile();
      },
    );

    itWithDiagnostics("should have healthy cluster nodes after upgrade", undefined, async () => {
      await assertHealthyClusterNodes();
    });

    itWithDiagnostics("should have Flux Operator running after upgrade", undefined, async () => {
      await assertFluxOperatorRunning();
    });

    it("should reconcile all components after PR upgrade", { timeout: 1_200_000 }, async (t) => {
      try {
        await waitForFluxClusterComponentsAndHelm(result, t);
        const helmVersionsAfter = await getHelmReleaseVersionSnapshots(kubeConfigFromDefault());
        logHelmReleaseVersionDiff(
          "Helm chart versions: main baseline → after PR upgrade",
          helmVersionsBaseline ?? new Map(),
          helmVersionsAfter,
        );
      } catch (err) {
        await logFluxDiagnostics("template-upgrade: post-upgrade stack ready");
        throw err;
      }
    });
  },
);
