import { resolve } from "node:path";
import { Command } from "commander";
import { mergeUpstreamTemplate } from "../core/template-sync.js";
import { templateSyncWizard } from "./template-sync-wizard.js";

/**
 * Register `gitops-ai template sync` (nested command).
 *
 * When run without explicit flags the command launches an interactive TUI.
 * Passing any flag (--ref, --dry-run, etc.) uses the non-interactive path.
 */
export function registerTemplateSyncCommand(program: Command): void {
  program
    .command("template")
    .description("Upstream GitOps template helpers")
    .addCommand(
      new Command("sync")
        .description(
          "Fetch upstream template and merge into the current branch (interactive wizard by default)",
        )
        .option(
          "-r, --ref <ref>",
          "Upstream tag or branch to fetch (e.g. main, v1.0.0, feat/foo)",
        )
        .option("--dry-run", "Fetch and show diff stat; do not merge", false)
        .option(
          "--remote <name>",
          "Local git remote name for the template URL (default: upstream). Not the branch name — use --ref for that",
          "upstream",
        )
        .option(
          "--allow-unrelated-histories",
          "Allow merge when this repo was not created from the template (experts only; expect conflicts)",
          false,
        )
        .option("--cwd <dir>", "Git repository root (default: current directory)")
        .action(
          async (opts: {
            ref?: string;
            dryRun: boolean;
            remote: string;
            cwd?: string;
            allowUnrelatedHistories: boolean;
          }) => {
            const repoRoot = resolve(opts.cwd ?? process.cwd());
            const hasExplicitFlags =
              opts.ref !== undefined ||
              opts.dryRun ||
              opts.allowUnrelatedHistories;

            if (hasExplicitFlags) {
              await mergeUpstreamTemplate({
                repoRoot,
                ref: opts.ref ?? "main",
                dryRun: opts.dryRun,
                remoteName: opts.remote,
                allowUnrelatedHistories: opts.allowUnrelatedHistories,
              });
            } else {
              await templateSyncWizard(repoRoot);
            }
          },
        ),
    );
}
