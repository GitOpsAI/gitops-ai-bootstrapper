import { existsSync, chmodSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  header,
  log,
  summary,
  finish,
  handleCancel,
  withSpinner,
} from "../utils/log.js";
import { commandExists } from "../utils/shell.js";
import { ensureAll } from "../core/dependencies.js";
import * as k8s from "../core/kubernetes.js";
import * as enc from "../core/encryption.js";
import { defaultSopsConfig, type SopsConfig } from "../schemas.js";

function resolveRepoRoot(): string {
  const scriptDir = new URL(".", import.meta.url).pathname;
  return resolve(scriptDir, "../../../");
}

async function ensurePrerequisites(): Promise<void> {
  await ensureAll(["sops", "age"]);
  if (!commandExists("kubectl")) {
    throw new Error("kubectl is required but not installed.");
  }
}

function ensureAgeKey(cfg: SopsConfig): void {
  if (!enc.ageKeyExists(cfg)) {
    log.error(`Age key not found at ${cfg.keyFile}`);
    log.error("Run 'sops init' first, or 'sops import' to import an existing key");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdInit(repoRoot: string, cfg: SopsConfig): Promise<void> {
  header("SOPS Initialization", "Age encryption setup for Flux GitOps");
  await ensurePrerequisites();

  if (enc.ageKeyExists(cfg)) {
    const pubKey = enc.getAgePublicKey(cfg);
    log.warn(`Age key already exists at ${cfg.keyFile}`);
    log.info(`Public key: ${pubKey}`);

    const useExisting = await p.confirm({
      message: "Use existing key?",
      initialValue: true,
    });
    if (p.isCancel(useExisting)) handleCancel();

    if (!useExisting) {
      enc.backupAgeKey(cfg);
      enc.generateAgeKey(cfg);
    }
  } else {
    enc.generateAgeKey(cfg);
  }

  const pubKey = enc.getAgePublicKey(cfg);
  enc.createSopsConfig(pubKey, cfg);

  if (k8s.isClusterReachable()) {
    if (k8s.secretExists(cfg.secretName, cfg.namespace)) {
      log.warn(`Secret ${cfg.namespace}/${cfg.secretName} already exists`);
      const overwrite = await p.confirm({
        message: "Overwrite?",
        initialValue: false,
      });
      if (p.isCancel(overwrite)) handleCancel();
      if (overwrite) {
        await k8s.deleteSecret(cfg.secretName, cfg.namespace);
        await k8s.createSecretFromFile(
          cfg.secretName, cfg.namespace, "age.agekey", cfg.keyFile,
        );
      }
    } else {
      await k8s.createNamespace(cfg.namespace);
      await k8s.createSecretFromFile(
        cfg.secretName, cfg.namespace, "age.agekey", cfg.keyFile,
      );
    }
    log.success(`Created secret ${cfg.namespace}/${cfg.secretName}`);
  } else {
    log.warn("No Kubernetes cluster reachable — skipping K8s secret creation.");
    log.warn("Run 'sops import' when a cluster is available.");
  }

  enc.updateFluxKustomization(repoRoot, cfg.secretName);

  summary("SOPS Initialization Complete", {
    "Age public key": pubKey,
    "Key file": cfg.keyFile,
    "SOPS config": cfg.configFile,
    "K8s secret": `${cfg.namespace}/${cfg.secretName}`,
  });

  finish("SOPS initialized");
}

async function cmdEncrypt(
  repoRoot: string,
  cfg: SopsConfig,
  targetFile?: string,
): Promise<void> {
  header("SOPS Encrypt");
  await ensurePrerequisites();
  ensureAgeKey(cfg);

  if (targetFile) {
    await enc.encryptFile(targetFile, cfg, repoRoot);
    return;
  }

  log.step("Scanning for unencrypted Kubernetes Secrets");
  const result = await enc.encryptAll(cfg, repoRoot);
  log.success(
    `Done: ${result.encrypted} encrypted, ${result.skipped} skipped, ${result.total} total`,
  );
}

async function cmdDecrypt(
  repoRoot: string,
  cfg: SopsConfig,
  targetFile?: string,
): Promise<void> {
  if (!targetFile) {
    log.error("Usage: sops decrypt <file>");
    return process.exit(1) as never;
  }

  header("SOPS Decrypt");
  await ensurePrerequisites();
  ensureAgeKey(cfg);

  await enc.decryptFile(targetFile, cfg, repoRoot);
}

async function cmdEdit(
  _repoRoot: string,
  cfg: SopsConfig,
  targetFile?: string,
): Promise<void> {
  if (!targetFile) {
    log.error("Usage: sops edit <file>");
    return process.exit(1) as never;
  }

  await ensurePrerequisites();
  ensureAgeKey(cfg);
  enc.editFile(targetFile, cfg);
}

async function cmdStatus(repoRoot: string): Promise<void> {
  header("SOPS Secret Status");

  const statuses = enc.getSecretStatus(repoRoot);

  if (statuses.length === 0) {
    log.success("No Kubernetes Secret files found");
    return;
  }

  const colorMap = {
    encrypted: pc.green,
    template: pc.cyan,
    plaintext: pc.red,
  };

  let encrypted = 0;
  let templates = 0;
  let plaintext = 0;

  p.log.message(
    `  ${pc.bold("STATUS".padEnd(12))} ${pc.bold("FILE")}`,
  );

  for (const { relpath, status } of statuses) {
    const colorFn = colorMap[status];
    const label = status === "plaintext" ? "PLAINTEXT" : status;
    p.log.message(`  ${colorFn(label.padEnd(12))} ${relpath}`);

    if (status === "encrypted") encrypted++;
    else if (status === "template") templates++;
    else plaintext++;
  }

  p.log.message("");
  p.log.message(
    `  Total: ${statuses.length} | Encrypted: ${encrypted} | Templates: ${templates} | ${pc.red(`Plaintext: ${plaintext}`)}`,
  );

  if (plaintext > 0) {
    log.warn("Run 'sops encrypt' to encrypt plaintext secrets");
  }
}

async function cmdImport(cfg: SopsConfig): Promise<void> {
  header("SOPS Key Import");

  if (!enc.ageKeyExists(cfg)) {
    const keyPath = await p.text({
      message: "Enter path to age.agekey file",
      validate: (v) => {
        if (!v) return "Required";
        if (!existsSync(v)) return `File not found: ${v}`;
      },
    });
    if (p.isCancel(keyPath)) handleCancel();

    mkdirSync(cfg.keyDir, { recursive: true, mode: 0o700 });
    copyFileSync(keyPath as string, cfg.keyFile);
    chmodSync(cfg.keyFile, 0o600);
    log.success(`Imported key to ${cfg.keyFile}`);
  }

  await ensurePrerequisites();

  if (k8s.secretExists(cfg.secretName, cfg.namespace)) {
    const overwrite = await p.confirm({
      message: `Secret ${cfg.namespace}/${cfg.secretName} exists. Overwrite?`,
      initialValue: false,
    });
    if (p.isCancel(overwrite)) handleCancel();
    if (overwrite) {
      await k8s.deleteSecret(cfg.secretName, cfg.namespace);
    } else {
      log.success("Keeping existing secret");
      return;
    }
  }

  await k8s.createSecretFromFile(
    cfg.secretName, cfg.namespace, "age.agekey", cfg.keyFile,
  );
  log.success("Age key imported to cluster");
  finish("Import complete");
}

async function cmdRotate(repoRoot: string, cfg: SopsConfig): Promise<void> {
  header("SOPS Key Rotation");
  await ensurePrerequisites();
  ensureAgeKey(cfg);

  log.warn("This will:");
  log.warn("  1. Generate a new age key");
  log.warn("  2. Re-encrypt all secrets with the new key");
  log.warn("  3. Update the Kubernetes secret");

  const confirm = await p.confirm({
    message: "Continue with key rotation?",
    initialValue: false,
  });
  if (p.isCancel(confirm) || !confirm) {
    finish("Aborted");
    return;
  }

  const oldPubKey = enc.getAgePublicKey(cfg);

  log.step("Decrypting all secrets with current key");
  const decryptedFiles = await enc.decryptAll(cfg, repoRoot);

  enc.backupAgeKey(cfg);
  enc.generateAgeKey(cfg);
  const newPubKey = enc.getAgePublicKey(cfg);

  enc.createSopsConfig(newPubKey, cfg);

  log.step("Re-encrypting all secrets with new key");
  for (const file of decryptedFiles) {
    await enc.encryptFile(file, cfg, repoRoot);
  }

  if (k8s.isClusterReachable()) {
    if (k8s.secretExists(cfg.secretName, cfg.namespace)) {
      await k8s.deleteSecret(cfg.secretName, cfg.namespace);
    }
    await k8s.createSecretFromFile(
      cfg.secretName, cfg.namespace, "age.agekey", cfg.keyFile,
    );
  }

  summary("Key Rotation Complete", {
    "Old public key": oldPubKey,
    "New public key": newPubKey,
  });

  log.warn("Commit the updated .sops.yaml and re-encrypted secrets");
  log.warn("Keep the old key backup until all clusters are updated");
  finish("Key rotation complete");
}

function showHelp(): void {
  header("SOPS Secret Manager", "Age encryption for Flux GitOps");

  const commands = [
    ["init", "First-time setup: generate age key, create .sops.yaml & K8s secret"],
    ["encrypt", "Encrypt all unencrypted secret files"],
    ["encrypt <file>", "Encrypt a specific file"],
    ["decrypt <file>", "Decrypt a file for viewing (re-encrypt before commit!)"],
    ["edit <file>", "Open encrypted file in $EDITOR (auto re-encrypts on save)"],
    ["status", "Show encryption status of all secret files"],
    ["import", "Import existing age key to a new cluster"],
    ["rotate", "Rotate to a new age key (re-encrypts everything)"],
  ];

  for (const [cmd, desc] of commands) {
    p.log.message(`  ${pc.cyan(cmd.padEnd(20))} ${desc}`);
  }

  p.log.message("");
  p.log.message(pc.dim("  Environment variables:"));
  p.log.message(`  ${pc.dim("SOPS_AGE_KEY_DIR")}     Directory for age keys   (default: ~/.sops)`);
  p.log.message(`  ${pc.dim("SOPS_NAMESPACE")}      K8s namespace for secret (default: flux-system)`);
  p.log.message(`  ${pc.dim("SOPS_SECRET_NAME")}    K8s secret name          (default: sops-age)`);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function sops(
  subcommand?: string,
  targetFile?: string,
): Promise<void> {
  const repoRoot = resolveRepoRoot();
  const cfg = defaultSopsConfig(repoRoot);

  if (!subcommand) {
    const selected = await p.select({
      message: "Select SOPS operation",
      options: [
        { value: "init", label: "Init", hint: "First-time setup" },
        { value: "encrypt", label: "Encrypt", hint: "Encrypt secret files" },
        { value: "decrypt", label: "Decrypt", hint: "Decrypt a file" },
        { value: "edit", label: "Edit", hint: "Edit encrypted file in $EDITOR" },
        { value: "status", label: "Status", hint: "Show encryption status" },
        { value: "import", label: "Import", hint: "Import age key to cluster" },
        { value: "rotate", label: "Rotate", hint: "Rotate to new age key" },
      ],
    });
    if (p.isCancel(selected)) handleCancel();
    subcommand = selected as string;
  }

  switch (subcommand) {
    case "init":
      return cmdInit(repoRoot, cfg);
    case "encrypt":
      return cmdEncrypt(repoRoot, cfg, targetFile);
    case "decrypt":
      return cmdDecrypt(repoRoot, cfg, targetFile);
    case "edit":
      return cmdEdit(repoRoot, cfg, targetFile);
    case "status":
      return cmdStatus(repoRoot);
    case "import":
      return cmdImport(cfg);
    case "rotate":
      return cmdRotate(repoRoot, cfg);
    case "help":
    case "-h":
    case "--help":
      return showHelp();
    default:
      log.error(`Unknown command: ${subcommand}`);
      showHelp();
      process.exit(1);
  }
}
