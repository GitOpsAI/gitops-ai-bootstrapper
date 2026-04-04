import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { log, withSpinner } from "../utils/log.js";
import { execAsync, execSafe } from "../utils/shell.js";
import {
  SOURCE_TEMPLATE_HOST,
  SOURCE_PROJECT_PATH,
} from "../schemas.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** HTTPS URL for the canonical GitOps template on GitHub. */
export const UPSTREAM_GIT_URL = `https://${SOURCE_TEMPLATE_HOST}/${SOURCE_PROJECT_PATH}.git`;

export function readPackageVersion(): string {
  try {
    const pkgPath = join(__dirname, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Read `version:` from repo-root template-sync-metadata.yaml if present (template semver).
 */
export function readMetadataVersion(repoRoot: string): string | undefined {
  const metaPath = join(repoRoot, "template-sync-metadata.yaml");
  if (!existsSync(metaPath)) return undefined;
  try {
    const text = readFileSync(metaPath, "utf-8");
    const m = /^version:\s*["']?([^'"\n]+)/m.exec(text);
    return m?.[1]?.trim();
  } catch {
    return undefined;
  }
}

/**
 * Shared Helm / component bases live under `templates/` (category dirs such as
 * `templates/system/`, `templates/ai/`, …).
 */
function hasSharedTemplatesTree(repoRoot: string): boolean {
  const templatesRoot = join(repoRoot, "templates");
  if (!existsSync(templatesRoot)) return false;
  try {
    const entries = readdirSync(templatesRoot, { withFileTypes: true });
    return entries.some((e) => e.isDirectory());
  } catch {
    return false;
  }
}

export function looksLikeGitopsTemplateLayout(repoRoot: string): boolean {
  return (
    hasSharedTemplatesTree(repoRoot) &&
    existsSync(join(repoRoot, "clusters", "_template"))
  );
}

function unrelatedHistoryHint(repoRoot: string): string {
  if (!looksLikeGitopsTemplateLayout(repoRoot)) {
    return (
      "This directory does not look like a fork of the GitOps template (missing `templates/` shared bases or `clusters/_template/`). " +
        "Use the repository created by `gitops-ai bootstrap`, or pass `--cwd` to that repo's root."
    );
  }
  return (
    "Run `template sync` from the GitOps repository you created with `gitops-ai bootstrap` (or use `--cwd /path/to/that/repo`). " +
      "If you truly need to combine unrelated histories, run again with `--allow-unrelated-histories` (expect many conflicts)."
  );
}


// ---------------------------------------------------------------------------
// Fetch upstream tags (shared between bootstrap wizard and sync TUI)
// ---------------------------------------------------------------------------

export async function fetchTemplateTags(): Promise<string[]> {
  const url = `https://api.github.com/repos/${SOURCE_PROJECT_PATH}/tags?per_page=100`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return [];
    const tags = (await res.json()) as { name: string }[];
    return tags.map((t) => t.name);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Composable sync primitives (used by both non-interactive and TUI paths)
// ---------------------------------------------------------------------------

export function assertGitRepo(repoRoot: string): void {
  const { exitCode } = execSafe("git rev-parse --is-inside-work-tree", {
    cwd: repoRoot,
  });
  if (exitCode !== 0) {
    throw new Error(`Not a git repository: ${repoRoot}`);
  }
}

export function currentBranch(repoRoot: string): string {
  const { stdout } = execSafe("git branch --show-current", { cwd: repoRoot });
  return stdout || "(detached HEAD)";
}

export async function ensureUpstreamRemote(
  repoRoot: string,
  remoteName: string,
): Promise<void> {
  const { stdout: remotes } = execSafe("git remote", { cwd: repoRoot });
  const remoteList = remotes.split(/\s+/).filter(Boolean);
  if (!remoteList.includes(remoteName)) {
    log.step(`Adding remote '${remoteName}' → ${UPSTREAM_GIT_URL}`);
    await execAsync(`git remote add "${remoteName}" "${UPSTREAM_GIT_URL}"`, {
      cwd: repoRoot,
    });
  }
}

export async function fetchUpstream(
  repoRoot: string,
  remoteName: string,
  ref: string,
): Promise<void> {
  await withSpinner(`Fetching ${remoteName} ${ref}`, async () => {
    await execAsync(`git fetch "${remoteName}" "${ref}"`, { cwd: repoRoot });
  });
}

// ---------------------------------------------------------------------------
// Diff analysis
// ---------------------------------------------------------------------------

export type RiskTier = "routine" | "high_touch" | "cluster_overlay" | "other";

export interface DiffFileEntry {
  path: string;
  risk: RiskTier;
}

export interface UpstreamDiffResult {
  raw: string;
  files: DiffFileEntry[];
  totalFiles: number;
  routineCount: number;
  highTouchCount: number;
  clusterOverlayCount: number;
  otherCount: number;
  empty: boolean;
  error?: string;
}

const HIGH_TOUCH_PATTERNS = [
  /^flux-instance-values\.yaml$/,
  /^\.sops\.yaml$/,
  /secret-.*\.yaml$/,
  /cluster-sync\.yaml$/,
];

export function classifyFile(path: string): RiskTier {
  if (HIGH_TOUCH_PATTERNS.some((re) => re.test(path))) return "high_touch";
  if (path.startsWith("clusters/")) return "cluster_overlay";
  if (path.startsWith("templates/")) return "routine";
  return "other";
}

export function diffUpstream(repoRoot: string): UpstreamDiffResult {
  // Three-dot shows only what changed on upstream since the common ancestor,
  // excluding local-only files (e.g. clusters/homelab/).
  // Falls back to two-dot when there is no merge-base (unrelated histories).
  let diffCmd = "git diff --stat HEAD...FETCH_HEAD";
  let nameCmd = "git diff --name-only HEAD...FETCH_HEAD";

  const { exitCode: hasMergeBase } = execSafe("git merge-base HEAD FETCH_HEAD", { cwd: repoRoot });
  if (hasMergeBase !== 0) {
    diffCmd = "git diff --stat HEAD FETCH_HEAD";
    nameCmd = "git diff --name-only HEAD FETCH_HEAD";
  }

  const result = execSafe(diffCmd, { cwd: repoRoot });

  if (result.exitCode !== 0) {
    return {
      raw: "",
      files: [],
      totalFiles: 0,
      routineCount: 0,
      highTouchCount: 0,
      clusterOverlayCount: 0,
      otherCount: 0,
      empty: true,
      error: result.stderr || "git diff failed",
    };
  }

  const raw = result.stdout.trim();
  if (!raw) {
    return {
      raw: "",
      files: [],
      totalFiles: 0,
      routineCount: 0,
      highTouchCount: 0,
      clusterOverlayCount: 0,
      otherCount: 0,
      empty: true,
    };
  }

  const nameResult = execSafe(nameCmd, { cwd: repoRoot });
  const filePaths = nameResult.stdout.trim().split("\n").filter(Boolean);
  const files: DiffFileEntry[] = filePaths.map((p) => ({
    path: p,
    risk: classifyFile(p),
  }));

  return {
    raw,
    files,
    totalFiles: files.length,
    routineCount: files.filter((f) => f.risk === "routine").length,
    highTouchCount: files.filter((f) => f.risk === "high_touch").length,
    clusterOverlayCount: files.filter((f) => f.risk === "cluster_overlay").length,
    otherCount: files.filter((f) => f.risk === "other").length,
    empty: false,
  };
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

export function hasCommonAncestor(repoRoot: string): boolean {
  const { exitCode } = execSafe("git merge-base HEAD FETCH_HEAD", {
    cwd: repoRoot,
  });
  return exitCode === 0;
}

export interface MergeResult {
  success: boolean;
  conflictCount: number;
  error?: string;
}

export async function mergeUpstream(
  repoRoot: string,
  ref: string,
  remoteName: string,
  allowUnrelatedHistories = false,
): Promise<MergeResult> {
  const unrelatedFlag = allowUnrelatedHistories
    ? " --allow-unrelated-histories"
    : "";

  try {
    await withSpinner(`Merging ${remoteName}/${ref}`, async () => {
      await execAsync(
        `git merge${unrelatedFlag} FETCH_HEAD -m "chore: sync template from upstream ${ref}"`,
        { cwd: repoRoot },
      );
    });
    return { success: true, conflictCount: 0 };
  } catch (err) {
    const conflictResult = execSafe(
      "git diff --name-only --diff-filter=U",
      { cwd: repoRoot },
    );
    const conflictFiles = conflictResult.stdout.trim().split("\n").filter(Boolean);
    if (conflictFiles.length > 0) {
      return {
        success: false,
        conflictCount: conflictFiles.length,
        error: `Merge produced ${conflictFiles.length} conflict(s). Resolve them, then commit and push.`,
      };
    }
    return {
      success: false,
      conflictCount: 0,
      error: (err as Error).message,
    };
  }
}

// ---------------------------------------------------------------------------
// High-level convenience (non-interactive CLI path — preserved from before)
// ---------------------------------------------------------------------------

export interface TemplateSyncOptions {
  repoRoot: string;
  ref: string;
  dryRun: boolean;
  remoteName: string;
  allowUnrelatedHistories?: boolean;
}

export async function mergeUpstreamTemplate(
  options: TemplateSyncOptions,
): Promise<void> {
  const { repoRoot, ref, dryRun, remoteName, allowUnrelatedHistories } =
    options;

  assertGitRepo(repoRoot);
  await ensureUpstreamRemote(repoRoot, remoteName);
  await fetchUpstream(repoRoot, remoteName, ref);

  const diff = diffUpstream(repoRoot);
  if (diff.error) {
    log.detail(`(could not diff HEAD vs FETCH_HEAD: ${diff.error})`);
  } else if (!diff.empty) {
    log.detail(diff.raw);
  } else {
    log.detail("(no file differences between HEAD and FETCH_HEAD)");
  }

  if (dryRun) {
    log.success(
      "Dry-run: fetch complete; no merge performed. Review diff above, then run without --dry-run.",
    );
    return;
  }

  if (!hasCommonAncestor(repoRoot) && !allowUnrelatedHistories) {
    throw new Error(
      "No common Git ancestor with the upstream template on GitHub. " +
        unrelatedHistoryHint(repoRoot) +
        " `--ref` is the branch/tag on upstream; `--remote` is only the local remote name (default: upstream).",
    );
  }

  const result = await mergeUpstream(repoRoot, ref, remoteName, allowUnrelatedHistories);
  if (result.success) {
    log.success(
      "Merge complete. Resolve conflicts if any, run validation (flux build / kubeconform), then push.",
    );
  } else {
    throw new Error(result.error ?? "Merge failed");
  }
}
