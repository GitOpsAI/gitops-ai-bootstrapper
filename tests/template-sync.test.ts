import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

import {
  readMetadataVersion,
  classifyFile,
  looksLikeGitopsTemplateLayout,
  assertGitRepo,
  currentBranch,
  hasCommonAncestor,
  diffUpstream,
  mergeUpstream,
  type RiskTier,
} from "../src/core/template-sync.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// Keep fixtures outside the workspace so `git` cannot discover the bootstrapper's `.git`
// when Actions uses a real clone (git installed before checkout).
const TMP_BASE_RAW = join(tmpdir(), "gitops-ai-template-sync-test");
mkdirSync(TMP_BASE_RAW, { recursive: true });
const TMP_BASE = realpathSync(TMP_BASE_RAW);

/**
 * Branch used in git integration tests. In GitLab CI, `ci-<pipeline_id>` avoids
 * ambiguous default-branch behaviour; set `GIT_TEST_BRANCH` in `.gitlab-ci.yml`
 * or rely on `CI_PIPELINE_ID`. Locally defaults to `main`.
 */
const GIT_TEST_BRANCH =
  process.env.GIT_TEST_BRANCH?.trim() ||
  (process.env.CI_PIPELINE_ID ? `ci-${process.env.CI_PIPELINE_ID}` : "main");

function mktmp(prefix = "sync-test-"): string {
  return mkdtempSync(join(TMP_BASE, prefix));
}

function git(cmd: string, cwd: string): string {
  // Use empty template to avoid sandbox issues with system hook copies
  const env = { ...process.env, GIT_TEMPLATE_DIR: "" };
  return execSync(`git ${cmd}`, { cwd, encoding: "utf-8", stdio: "pipe", env }).trim();
}

function writeFile(dir: string, relPath: string, content: string): void {
  const full = join(dir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf-8");
}

/**
 * Create a bare "upstream" repo and a cloned "fork" that share history.
 * Returns { upstream, fork } directory paths.
 *
 * Upstream has an initial commit with template-sync-metadata.yaml and a
 * basic templates/<category>/ layout so it looks like a real template repo.
 */
function createLinkedRepos(): { upstream: string; fork: string } {
  const upstream = mktmp("upstream-");
  const fork = mktmp("fork-");

  git("init --bare", upstream);
  // Set bare repo's HEAD so clones check out GIT_TEST_BRANCH instead of the
  // system default (often `master`), which may not match the branch we push to.
  git(`symbolic-ref HEAD refs/heads/${GIT_TEST_BRANCH}`, upstream);

  const staging = mktmp("staging-");
  git(`init -b ${GIT_TEST_BRANCH}`, staging);
  git("config user.email test@test.com", staging);
  git("config user.name Test", staging);
  git(`remote add origin "${upstream}"`, staging);

  writeFile(staging, "template-sync-metadata.yaml", [
    'version: "1.0.0"',
    "schema: 1",
    "upstream:",
    "  provider: github",
    "  path: GitOpsAI/gitops-ai-template",
    "  host: github.com",
  ].join("\n"));

  mkdirSync(join(staging, "templates", "system"), { recursive: true });
  writeFile(staging, "templates/system/kustomization.yaml", "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\n");
  mkdirSync(join(staging, "clusters", "_template"), { recursive: true });
  writeFile(staging, "clusters/_template/kustomization.yaml", "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\n");

  git("add -A", staging);
  git('commit -m "initial template"', staging);
  git(`push origin HEAD:${GIT_TEST_BRANCH}`, staging);

  git(`clone "${upstream}" "${fork}"`, staging);
  git("config user.email test@test.com", fork);
  git("config user.name Test", fork);

  rmSync(staging, { recursive: true, force: true });
  return { upstream, fork };
}

/**
 * Push a new commit to the upstream bare repo by creating a temp clone,
 * committing changes, and pushing.
 */
function pushUpstreamChange(
  upstream: string,
  files: Record<string, string>,
  message = "upstream update",
): void {
  const tmp = mktmp("push-");
  git(`clone "${upstream}" "${tmp}"`, tmp);
  git("config user.email test@test.com", tmp);
  git("config user.name Test", tmp);

  for (const [relPath, content] of Object.entries(files)) {
    writeFile(tmp, relPath, content);
  }

  git("add -A", tmp);
  git(`commit -m "${message}"`, tmp);
  // Push current HEAD to GIT_TEST_BRANCH (clone may use `master` if remote HEAD is unset — e.g. Alpine CI)
  git(`push origin HEAD:${GIT_TEST_BRANCH}`, tmp);
  rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Unit tests: classifyFile
// ---------------------------------------------------------------------------

describe("classifyFile", () => {
  const cases: [string, RiskTier][] = [
    ["templates/base/kustomization.yaml", "routine"],
    ["templates/system/shared-helm-repos/kustomization.yaml", "routine"],
    ["templates/ai/openclaw/helm-release-openclaw.yaml", "routine"],
    [".sops.yaml", "high_touch"],
    ["flux-instance-values.yaml", "high_touch"],
    ["secret-cloudflare.yaml", "high_touch"],
    ["clusters/homelab/cluster-sync.yaml", "high_touch"],
    ["clusters/homelab/kustomization.yaml", "cluster_overlay"],
    ["clusters/homelab/components/grafana/kustomization.yaml", "cluster_overlay"],
    ["README.md", "other"],
    ["docs/template-sync.md", "other"],
    ["template-sync-metadata.yaml", "other"],
  ];

  for (const [path, expected] of cases) {
    it(`classifies "${path}" as ${expected}`, () => {
      assert.equal(classifyFile(path), expected);
    });
  }
});

// ---------------------------------------------------------------------------
// Unit tests: readMetadataVersion
// ---------------------------------------------------------------------------

describe("readMetadataVersion", () => {
  let dir: string;

  beforeEach(() => { dir = mktmp(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("reads quoted semver", () => {
    writeFile(dir, "template-sync-metadata.yaml", 'version: "1.2.3"\nschema: 1\n');
    assert.equal(readMetadataVersion(dir), "1.2.3");
  });

  it("reads unquoted semver", () => {
    writeFile(dir, "template-sync-metadata.yaml", "version: 2.0.0\nschema: 1\n");
    assert.equal(readMetadataVersion(dir), "2.0.0");
  });

  it("returns undefined when file missing", () => {
    assert.equal(readMetadataVersion(dir), undefined);
  });

  it("returns undefined when version key missing", () => {
    writeFile(dir, "template-sync-metadata.yaml", "schema: 1\n");
    assert.equal(readMetadataVersion(dir), undefined);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: looksLikeGitopsTemplateLayout
// ---------------------------------------------------------------------------

describe("looksLikeGitopsTemplateLayout", () => {
  let dir: string;

  beforeEach(() => { dir = mktmp(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("returns true when both paths exist", () => {
    mkdirSync(join(dir, "templates", "system"), { recursive: true });
    mkdirSync(join(dir, "clusters", "_template"), { recursive: true });
    assert.equal(looksLikeGitopsTemplateLayout(dir), true);
  });

  it("returns true when only templates/base exists as the shared tree", () => {
    mkdirSync(join(dir, "templates", "base"), { recursive: true });
    mkdirSync(join(dir, "clusters", "_template"), { recursive: true });
    assert.equal(looksLikeGitopsTemplateLayout(dir), true);
  });

  it("returns false when only clusters/_default exists (no _template)", () => {
    mkdirSync(join(dir, "templates", "system"), { recursive: true });
    mkdirSync(join(dir, "clusters", "_default"), { recursive: true });
    assert.equal(looksLikeGitopsTemplateLayout(dir), false);
  });

  it("returns false when templates/ has no category or base layout", () => {
    mkdirSync(join(dir, "templates"), { recursive: true });
    mkdirSync(join(dir, "clusters", "_template"), { recursive: true });
    assert.equal(looksLikeGitopsTemplateLayout(dir), false);
  });

  it("returns false when templates/ missing", () => {
    mkdirSync(join(dir, "clusters", "_template"), { recursive: true });
    assert.equal(looksLikeGitopsTemplateLayout(dir), false);
  });

  it("returns false for empty dir", () => {
    assert.equal(looksLikeGitopsTemplateLayout(dir), false);
  });
});

// ---------------------------------------------------------------------------
// Git primitive tests
// ---------------------------------------------------------------------------

describe("assertGitRepo", () => {
  it("succeeds inside a git repo", () => {
    const dir = mktmp();
    git("init", dir);
    assert.doesNotThrow(() => assertGitRepo(dir));
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws for a plain directory outside any repo", () => {
    const dir = mktmp();
    // Prevent git from traversing up into the bootstrapper's own .git
    const origCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = TMP_BASE;
    try {
      assert.throws(() => assertGitRepo(dir), /Not a git repository/);
    } finally {
      if (origCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = origCeiling;
    }
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("currentBranch", () => {
  it("returns branch name", () => {
    const dir = mktmp();
    git(`init -b ${GIT_TEST_BRANCH}`, dir);
    git("config user.email test@test.com", dir);
    git("config user.name Test", dir);
    writeFile(dir, "f.txt", "x");
    git("add -A && git commit -m init", dir);
    assert.equal(currentBranch(dir), GIT_TEST_BRANCH);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Integration: diff & merge with real git repos
// ---------------------------------------------------------------------------

describe("diffUpstream – three-dot behaviour", { timeout: 30_000 }, () => {
  let upstream: string;
  let fork: string;

  before(() => {
    ({ upstream, fork } = createLinkedRepos());
  });

  after(() => {
    rmSync(upstream, { recursive: true, force: true });
    rmSync(fork, { recursive: true, force: true });
  });

  it("shows empty diff when upstream has no new changes", () => {
    // Fetch sets FETCH_HEAD automatically
    git(`fetch origin ${GIT_TEST_BRANCH}`, fork);

    const result = diffUpstream(fork);
    assert.equal(result.empty, true, "should be empty when repos are identical");
    assert.equal(result.totalFiles, 0);
  });

  it("shows only upstream changes, excluding local additions", () => {
    // Add a local-only file to the fork (simulates clusters/homelab/)
    writeFile(fork, "clusters/homelab/kustomization.yaml", "local content\n");
    git("add -A", fork);
    git('commit -m "add local cluster"', fork);

    // Push an upstream-only change
    pushUpstreamChange(upstream, {
      "templates/system/new-component.yaml": "apiVersion: v1\nkind: ConfigMap\n",
    });

    git(`fetch origin ${GIT_TEST_BRANCH}`, fork);

    const result = diffUpstream(fork);

    assert.equal(result.empty, false, "should detect upstream changes");

    const paths = result.files.map((f) => f.path);
    assert.ok(
      paths.includes("templates/system/new-component.yaml"),
      "should include upstream addition",
    );
    assert.ok(
      !paths.includes("clusters/homelab/kustomization.yaml"),
      "must NOT include local-only file (three-dot diff)",
    );
  });

  it("classifies diff files by risk tier", () => {
    // The previous test already fetched upstream with the new file.
    // Re-run diff to verify classification.
    const result = diffUpstream(fork);
    const routine = result.files.filter((f) => f.risk === "routine");
    assert.ok(routine.length > 0, "templates/ files should be classified as routine");
    assert.equal(result.routineCount, routine.length);
  });
});

describe("diffUpstream – two-dot fallback (no common ancestor)", { timeout: 30_000 }, () => {
  let repoA: string;
  let repoB: string;

  before(() => {
    repoA = mktmp("unrel-a-");
    git(`init -b ${GIT_TEST_BRANCH}`, repoA);
    git("config user.email test@test.com", repoA);
    git("config user.name Test", repoA);
    writeFile(repoA, "a.txt", "aaa");
    git("add -A", repoA);
    git('commit -m "commit A"', repoA);

    repoB = mktmp("unrel-b-");
    git(`init -b ${GIT_TEST_BRANCH}`, repoB);
    git("config user.email test@test.com", repoB);
    git("config user.name Test", repoB);
    writeFile(repoB, "b.txt", "bbb");
    git("add -A", repoB);
    git('commit -m "commit B"', repoB);

    git(`fetch "${repoA}" ${GIT_TEST_BRANCH}`, repoB);
  });

  after(() => {
    rmSync(repoA, { recursive: true, force: true });
    rmSync(repoB, { recursive: true, force: true });
  });

  it("still returns a valid diff result (falls back to two-dot)", () => {
    const result = diffUpstream(repoB);
    assert.equal(result.empty, false, "unrelated repos have differences");
    assert.ok(!result.error, "should not report an error");
  });
});

describe("hasCommonAncestor", { timeout: 15_000 }, () => {
  it("returns true for repos with shared history", () => {
    const { upstream, fork } = createLinkedRepos();
    git(`fetch origin ${GIT_TEST_BRANCH}`, fork);
    assert.equal(hasCommonAncestor(fork), true);
    rmSync(upstream, { recursive: true, force: true });
    rmSync(fork, { recursive: true, force: true });
  });

  it("returns false for unrelated repos", () => {
    const a = mktmp();
    git(`init -b ${GIT_TEST_BRANCH}`, a);
    git("config user.email t@t.com", a);
    git("config user.name T", a);
    writeFile(a, "x.txt", "x");
    git("add -A", a);
    git('commit -m "a"', a);

    const b = mktmp();
    git(`init -b ${GIT_TEST_BRANCH}`, b);
    git("config user.email t@t.com", b);
    git("config user.name T", b);
    writeFile(b, "y.txt", "y");
    git("add -A", b);
    git('commit -m "b"', b);
    git(`fetch "${a}" ${GIT_TEST_BRANCH}`, b);

    assert.equal(hasCommonAncestor(b), false);
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Integration: mergeUpstream
// ---------------------------------------------------------------------------

describe("mergeUpstream – clean merge", { timeout: 30_000 }, () => {
  let upstream: string;
  let fork: string;

  before(() => {
    ({ upstream, fork } = createLinkedRepos());

    // Add a local-only commit so the merge is non-fast-forward
    writeFile(fork, "local-readme.md", "local docs\n");
    git("add -A", fork);
    git('commit -m "local: add readme"', fork);

    pushUpstreamChange(upstream, {
      "templates/system/added.yaml": "new: true\n",
    }, "upstream adds a file");

    git(`fetch origin ${GIT_TEST_BRANCH}`, fork);
  });

  after(() => {
    rmSync(upstream, { recursive: true, force: true });
    rmSync(fork, { recursive: true, force: true });
  });

  it("merges cleanly and returns success", async () => {
    const result = await mergeUpstream(fork, GIT_TEST_BRANCH, "origin", false);
    assert.equal(result.success, true);
    assert.equal(result.conflictCount, 0);
    assert.ok(
      existsSync(join(fork, "templates/system/added.yaml")),
      "upstream file should appear after merge",
    );
    assert.ok(
      existsSync(join(fork, "local-readme.md")),
      "local file should be preserved after merge",
    );
  });

  it("merge commit message references the upstream sync", () => {
    const msg = git("log -1 --format=%s", fork);
    assert.ok(
      msg.includes("sync template from upstream"),
      `commit message should mention upstream sync, got: "${msg}"`,
    );
  });
});

describe("mergeUpstream – conflict detection", { timeout: 30_000 }, () => {
  let upstream: string;
  let fork: string;

  before(() => {
    ({ upstream, fork } = createLinkedRepos());

    // Both sides modify the same file
    pushUpstreamChange(upstream, {
      "templates/system/kustomization.yaml": "upstream: modified\n",
    }, "upstream modifies kustomization");

    writeFile(fork, "templates/system/kustomization.yaml", "local: modified\n");
    git("add -A", fork);
    git('commit -m "local modifies kustomization"', fork);

    git(`fetch origin ${GIT_TEST_BRANCH}`, fork);
  });

  after(() => {
    // Abort any pending merge before cleanup
    try { git("merge --abort", fork); } catch { /* noop */ }
    rmSync(upstream, { recursive: true, force: true });
    rmSync(fork, { recursive: true, force: true });
  });

  it("detects conflicts and reports count", async () => {
    const result = await mergeUpstream(fork, GIT_TEST_BRANCH, "origin", false);
    assert.equal(result.success, false, "merge should fail due to conflicts");
    assert.ok(result.conflictCount > 0, `expected at least 1 conflict, got ${result.conflictCount}`);
    assert.ok(result.error?.includes("conflict"), "error message should mention conflicts");
  });
});

describe("mergeUpstream – unrelated histories", { timeout: 30_000 }, () => {
  let repoA: string;
  let repoB: string;

  before(() => {
    repoA = mktmp("unrel-merge-a-");
    git(`init -b ${GIT_TEST_BRANCH}`, repoA);
    git("config user.email t@t.com", repoA);
    git("config user.name T", repoA);
    writeFile(repoA, "upstream.txt", "upstream");
    git("add -A", repoA);
    git('commit -m "upstream init"', repoA);

    repoB = mktmp("unrel-merge-b-");
    git(`init -b ${GIT_TEST_BRANCH}`, repoB);
    git("config user.email t@t.com", repoB);
    git("config user.name T", repoB);
    writeFile(repoB, "local.txt", "local");
    git("add -A", repoB);
    git('commit -m "local init"', repoB);

    git(`remote add upstream "${repoA}"`, repoB);
    git(`fetch upstream ${GIT_TEST_BRANCH}`, repoB);
  });

  after(() => {
    try { git("merge --abort", repoB); } catch { /* noop */ }
    rmSync(repoA, { recursive: true, force: true });
    rmSync(repoB, { recursive: true, force: true });
  });

  it("fails without --allow-unrelated-histories", async () => {
    const result = await mergeUpstream(repoB, GIT_TEST_BRANCH, "upstream", false);
    assert.equal(result.success, false);
  });

  it("succeeds with --allow-unrelated-histories", async () => {
    // Reset from the failed merge state
    try { git("merge --abort", repoB); } catch { /* noop */ }

    const result = await mergeUpstream(repoB, GIT_TEST_BRANCH, "upstream", true);
    assert.equal(result.success, true, result.error ?? "merge should succeed");
    assert.ok(existsSync(join(repoB, "upstream.txt")), "upstream file should be present");
    assert.ok(existsSync(join(repoB, "local.txt")), "local file should be preserved");
  });
});

// ---------------------------------------------------------------------------
// Integration: already-merged detection (no diff after merge)
// ---------------------------------------------------------------------------

describe("diffUpstream – already merged shows empty", { timeout: 30_000 }, () => {
  let upstream: string;
  let fork: string;

  before(async () => {
    ({ upstream, fork } = createLinkedRepos());

    pushUpstreamChange(upstream, {
      "templates/system/added.yaml": "new: true\n",
    });

    git(`fetch origin ${GIT_TEST_BRANCH}`, fork);
    await mergeUpstream(fork, GIT_TEST_BRANCH, "origin", false);

    // Fetch again after merging — now HEAD includes all upstream changes
    git(`fetch origin ${GIT_TEST_BRANCH}`, fork);
  });

  after(() => {
    rmSync(upstream, { recursive: true, force: true });
    rmSync(fork, { recursive: true, force: true });
  });

  it("shows empty diff after upstream is fully merged", () => {
    const result = diffUpstream(fork);
    assert.equal(result.empty, true, "diff should be empty after merge");
    assert.equal(result.totalFiles, 0);
  });
});

// ---------------------------------------------------------------------------
// Integration: multiple upstream updates accumulate correctly
// ---------------------------------------------------------------------------

describe("diffUpstream – accumulates multiple upstream commits", { timeout: 30_000 }, () => {
  let upstream: string;
  let fork: string;

  before(() => {
    ({ upstream, fork } = createLinkedRepos());

    pushUpstreamChange(upstream, {
      "templates/system/comp-a.yaml": "a: true\n",
    }, "add comp-a");

    pushUpstreamChange(upstream, {
      "templates/monitoring/comp-b.yaml": "b: true\n",
    }, "add comp-b");

    pushUpstreamChange(upstream, {
      ".sops.yaml": "creation_rules: []\n",
    }, "update sops");

    git(`fetch origin ${GIT_TEST_BRANCH}`, fork);
  });

  after(() => {
    rmSync(upstream, { recursive: true, force: true });
    rmSync(fork, { recursive: true, force: true });
  });

  it("includes all upstream additions in a single diff", () => {
    const result = diffUpstream(fork);
    assert.equal(result.empty, false);

    const paths = result.files.map((f) => f.path);
    assert.ok(paths.includes("templates/system/comp-a.yaml"), "missing comp-a");
    assert.ok(paths.includes("templates/monitoring/comp-b.yaml"), "missing comp-b");
    assert.ok(paths.includes(".sops.yaml"), "missing .sops.yaml");
  });

  it("counts risk tiers correctly across commits", () => {
    const result = diffUpstream(fork);
    assert.equal(result.routineCount, 2, "two routine files");
    assert.equal(result.highTouchCount, 1, "one high-touch file (.sops.yaml)");
  });
});
