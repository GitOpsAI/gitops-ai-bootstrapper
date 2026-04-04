import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  header,
  log,
  summary,
  nextSteps,
  finish,
  handleCancel,
} from "../utils/log.js";
import {
  readMetadataVersion,
  looksLikeGitopsTemplateLayout,
  fetchTemplateTags,
  assertGitRepo,
  currentBranch,
  ensureUpstreamRemote,
  fetchUpstream,
  diffUpstream,
  hasCommonAncestor,
  mergeUpstream,
  type UpstreamDiffResult,
} from "../core/template-sync.js";

const CUSTOM_REF_VALUE = "__custom__";
const DEFAULT_REMOTE = "upstream";

export async function templateSyncWizard(repoRoot: string): Promise<void> {
  header("Template Sync", "Merge upstream template changes into your GitOps repository");

  // ── Repo validation ─────────────────────────────────────────────────
  assertGitRepo(repoRoot);

  if (!looksLikeGitopsTemplateLayout(repoRoot)) {
    log.warn(
      "This directory does not look like a GitOps template repo " +
        "(missing templates/ shared bases or clusters/_template/).",
    );
    const proceed = await p.confirm({
      message: "Continue anyway?",
      initialValue: false,
    });
    if (p.isCancel(proceed) || !proceed) handleCancel();
  }

  // ── Current state ───────────────────────────────────────────────────
  const branch = currentBranch(repoRoot);
  const localVersion = readMetadataVersion(repoRoot) ?? "unknown";

  p.note(
    `${pc.bold("Branch:")}   ${pc.cyan(branch)}\n` +
      `${pc.bold("Template:")} ${pc.cyan(`v${localVersion}`)}`,
    "Current state",
  );

  // ── Remote setup ────────────────────────────────────────────────────
  await ensureUpstreamRemote(repoRoot, DEFAULT_REMOTE);

  // ── Tag picker ──────────────────────────────────────────────────────
  const tags = await fetchTemplateTags();

  let ref: string;
  if (tags.length > 0) {
    const tagOptions = [
      ...tags.map((t) => ({ value: t, label: t })),
      { value: CUSTOM_REF_VALUE, label: "Custom branch or ref", hint: "type manually" },
    ];

    const selected = await p.select({
      message: pc.bold("Select upstream ref to sync"),
      options: tagOptions,
      initialValue: tags[0],
    });
    if (p.isCancel(selected)) handleCancel();

    if (selected === CUSTOM_REF_VALUE) {
      const custom = await p.text({
        message: pc.bold("Enter branch or tag name"),
        placeholder: "main",
        defaultValue: "main",
      });
      if (p.isCancel(custom)) handleCancel();
      ref = custom as string;
    } else {
      ref = selected as string;
    }
  } else {
    log.warn("Could not fetch tags from upstream (offline or private repo).");
    const custom = await p.text({
      message: pc.bold("Enter upstream branch or tag to sync"),
      placeholder: "main",
      defaultValue: "main",
    });
    if (p.isCancel(custom)) handleCancel();
    ref = custom as string;
  }

  // ── Fetch ───────────────────────────────────────────────────────────
  await fetchUpstream(repoRoot, DEFAULT_REMOTE, ref);

  // ── Diff preview ────────────────────────────────────────────────────
  const diff = diffUpstream(repoRoot);

  if (diff.error) {
    log.warn(`Could not compute diff: ${diff.error}`);
  } else if (diff.empty) {
    log.success("Already up to date — no differences with upstream.");
    finish("Nothing to merge.");
    return;
  } else {
    showDiffSummary(diff);
  }

  // ── Ancestor check ──────────────────────────────────────────────────
  const hasAncestor = hasCommonAncestor(repoRoot);
  if (!hasAncestor) {
    log.warn(
      "No shared Git ancestor with upstream. Merging will use --allow-unrelated-histories.",
    );
    const proceed = await p.confirm({
      message: "Continue with unrelated histories merge? (expect conflicts)",
      initialValue: false,
    });
    if (p.isCancel(proceed) || !proceed) handleCancel();
  }

  // ── Action prompt ───────────────────────────────────────────────────
  const action = await p.select({
    message: pc.bold("What would you like to do?"),
    options: [
      { value: "merge", label: "Merge now", hint: `merge ${ref} into ${branch}` },
      { value: "dry-run", label: "Dry-run only", hint: "review complete — skip merge" },
      { value: "cancel", label: "Cancel" },
    ],
  });
  if (p.isCancel(action)) handleCancel();

  if (action === "cancel") {
    handleCancel();
  }

  if (action === "dry-run") {
    log.success("Dry-run complete. No merge performed.");
    finish("Re-run and choose 'Merge now' when ready.");
    return;
  }

  // ── Merge ───────────────────────────────────────────────────────────
  const result = await mergeUpstream(
    repoRoot,
    ref,
    DEFAULT_REMOTE,
    !hasAncestor,
  );

  if (result.success) {
    summary("Merge Complete", {
      "Upstream ref": ref,
      "Branch": branch,
      "Files changed": String(diff.totalFiles),
    });

    nextSteps([
      "Review the merged changes.",
      `Run validation: ${pc.cyan("flux build kustomization")} + ${pc.cyan("kubeconform")}`,
      `Commit and push: ${pc.cyan("git push")}`,
    ]);

    finish("Template sync complete.");
  } else if (result.conflictCount > 0) {
    log.warn(
      `Merge produced ${pc.bold(String(result.conflictCount))} conflict(s).`,
    );

    nextSteps([
      `Resolve conflicts in the listed files.`,
      `Stage resolved files: ${pc.cyan("git add <file>")}`,
      `Complete the merge: ${pc.cyan('git commit')}`,
      `Run validation, then push.`,
    ]);

    finish("Merge started with conflicts — resolve them to continue.");
  } else {
    log.error(result.error ?? "Merge failed for an unknown reason.");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function showDiffSummary(diff: UpstreamDiffResult): void {
  const lines: string[] = [];

  lines.push(
    `${pc.bold("Files changed:")} ${diff.totalFiles}`,
  );
  lines.push("");

  if (diff.routineCount > 0) {
    lines.push(
      `  ${pc.green("Routine")}          ${diff.routineCount} file(s) — templates/ changes`,
    );
  }
  if (diff.highTouchCount > 0) {
    lines.push(
      `  ${pc.red("High-touch")}       ${diff.highTouchCount} file(s) — flux config, secrets, or cluster-sync`,
    );
  }
  if (diff.clusterOverlayCount > 0) {
    lines.push(
      `  ${pc.yellow("Cluster overlay")}  ${diff.clusterOverlayCount} file(s) — clusters/ paths`,
    );
  }
  if (diff.otherCount > 0) {
    lines.push(
      `  ${pc.dim("Other")}            ${diff.otherCount} file(s)`,
    );
  }

  if (diff.highTouchCount > 0) {
    lines.push("");
    lines.push(
      pc.red("  ⚠ High-touch files require careful review before merge."),
    );
  }

  p.note(lines.join("\n"), "Diff Summary");

  log.detail(diff.raw);
}
