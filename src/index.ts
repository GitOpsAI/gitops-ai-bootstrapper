#!/usr/bin/env node
import { Command } from "commander";
import { bootstrap, openclawPair } from "./commands/bootstrap.js";
import { sops } from "./commands/sops.js";
import pc from "picocolors";

const program = new Command();

program
  .name("flux-cli")
  .description("Flux GitOps cluster bootstrap CLI with interactive TUI")
  .version("1.0.0");

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

program.parse();
