#!/usr/bin/env node
import { Command } from "commander";
import { bootstrap } from "./commands/bootstrap.js";
import { openclawPair, openclawCodexLogin } from "./commands/openclaw.js";
import { podConsole } from "./commands/pod-console.js";
import { sops } from "./commands/sops.js";
import { registerTemplateSyncCommand } from "./commands/template-sync.js";
import { readPackageVersion } from "./core/template-sync.js";
import pc from "picocolors";

const program = new Command();

program
  .name("gitops-ai")
  .description("Flux GitOps cluster bootstrap CLI with interactive TUI")
  .version(readPackageVersion());

program
  .command("bootstrap")
  .alias("install")
  .description("Bootstrap a Kubernetes cluster with Flux GitOps (create new repo or use existing)")
  .action(async () => {
    try {
      await bootstrap();
    } catch (err) {
      console.error(pc.red(`\n  Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

program
  .command("sops [subcommand] [file]")
  .description("SOPS secret encryption management (init, encrypt, decrypt, edit, status, import, rotate)")
  .action(async (subcommand?: string, file?: string) => {
    try {
      await sops(subcommand, file);
    } catch (err) {
      console.error(pc.red(`\n  Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

program
  .command("openclaw-pair")
  .description("Pair an OpenClaw device with the cluster")
  .action(async () => {
    try {
      await openclawPair();
    } catch (err) {
      console.error(pc.red(`\n  Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

program
  .command("openclaw-codex-login")
  .description(
    "Complete OpenAI Codex (ChatGPT subscription) OAuth in the OpenClaw pod — use after bootstrap if you chose Codex auth",
  )
  .action(async () => {
    try {
      await openclawCodexLogin();
    } catch (err) {
      console.error(pc.red(`\n  Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

program
  .command("pod-console")
  .alias("shell")
  .description(
    "Open an interactive shell in a pod — pick from all cluster pods, or pass POD name",
  )
  .argument("[pod]", "Pod name (omit to choose from a list)")
  .option(
    "-n, --namespace <ns>",
    "With POD: namespace to exec into (default: default). Without POD: only list pods in this namespace (omit for all namespaces)",
  )
  .option(
    "-c, --container <name>",
    "Skip container selection when the pod has several containers",
  )
  .option(
    "-s, --shell <shell>",
    "Shell: bash (default — tries /bin/bash, then /bin/ash, then /bin/sh if missing), sh, ash, auto (/bin/sh), or an absolute path",
    "bash",
  )
  .action(
    async (
      pod: string | undefined,
      opts: { namespace?: string; container?: string; shell: string },
    ) => {
      try {
        await podConsole(pod, {
          namespace: opts.namespace,
          container: opts.container,
          shell: opts.shell,
        });
      } catch (err) {
        console.error(pc.red(`\n  Error: ${(err as Error).message}`));
        process.exit(1);
      }
    },
  );

registerTemplateSyncCommand(program);

program.parse();
