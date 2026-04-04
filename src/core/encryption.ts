import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
} from "node:fs";
import { join, basename, relative } from "node:path";
import { exec, execSafe, execAsync } from "../utils/shell.js";
import { log } from "../utils/log.js";
import type { SopsConfig } from "../schemas.js";

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function* walkYaml(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      yield* walkYaml(full);
    } else if (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml")) {
      yield full;
    }
  }
}

export function findSecretFiles(searchDir: string): string[] {
  const results: string[] = [];
  for (const file of walkYaml(searchDir)) {
    if (basename(file).startsWith("_")) continue;
    const content = readFileSync(file, "utf-8");
    if (/^\s*kind:\s*Secret\s*$/m.test(content)) {
      results.push(file);
    }
  }
  return results.sort();
}

export function isEncrypted(file: string): boolean {
  const content = readFileSync(file, "utf-8");
  return content.includes("sops:") && content.includes("encrypted_regex");
}

function hasEnvsubstVars(file: string): boolean {
  const content = readFileSync(file, "utf-8");
  return /\$\{[A-Za-z_]+\}/.test(content);
}

// ---------------------------------------------------------------------------
// Age key management
// ---------------------------------------------------------------------------

export function generateAgeKey(cfg: SopsConfig): string {
  mkdirSync(cfg.keyDir, { recursive: true, mode: 0o700 });
  exec(`age-keygen -o "${cfg.keyFile}" 2>&1`);
  chmodSync(cfg.keyFile, 0o600);
  return getAgePublicKey(cfg);
}

export function getAgePublicKey(cfg: SopsConfig): string {
  const content = readFileSync(cfg.keyFile, "utf-8");
  const match = content.match(/public key:\s*(\S+)/);
  if (!match) throw new Error("Could not extract public key from age key file");
  return match[1];
}

export function ageKeyExists(cfg: SopsConfig): boolean {
  return existsSync(cfg.keyFile);
}

export function backupAgeKey(cfg: SopsConfig): void {
  mkdirSync(cfg.backupDir, { recursive: true, mode: 0o700 });
  const backupPath = join(cfg.backupDir, `age.agekey.${Date.now()}.bak`);
  copyFileSync(cfg.keyFile, backupPath);
  log.warn(`Old key backed up to ${cfg.backupDir}/`);
}

// ---------------------------------------------------------------------------
// SOPS config
// ---------------------------------------------------------------------------

export function createSopsConfig(publicKey: string, cfg: SopsConfig): void {
  const content = `creation_rules:
  # Encrypt only data and stringData fields in Kubernetes Secrets
  - path_regex: .*(secret|Secret).*\\.yaml$
    encrypted_regex: ^(data|stringData)$
    age: ${publicKey}
`;
  writeFileSync(cfg.configFile, content);
  log.success(`Created ${cfg.configFile}`);
}

// ---------------------------------------------------------------------------
// Encrypt / decrypt
// ---------------------------------------------------------------------------

export async function encryptFile(
  file: string,
  cfg: SopsConfig,
  repoRoot: string,
): Promise<boolean> {
  const relpath = relative(repoRoot, file);
  if (isEncrypted(file)) {
    log.warn(`${relpath} is already encrypted`);
    return false;
  }

  const cmd = `SOPS_AGE_KEY_FILE="${cfg.keyFile}" sops --encrypt --in-place --config "${cfg.configFile}" "${file}"`;
  const { exitCode, stderr } = execSafe(cmd);
  if (exitCode === 0) {
    log.success(`Encrypted: ${relpath}`);
    return true;
  }
  log.error(`Failed to encrypt: ${relpath}`);
  if (stderr) log.error(stderr);
  return false;
}

export async function decryptFile(
  file: string,
  cfg: SopsConfig,
  repoRoot: string,
): Promise<boolean> {
  const relpath = relative(repoRoot, file);
  if (!isEncrypted(file)) {
    log.warn(`${relpath} is not SOPS-encrypted`);
    return false;
  }

  const cmd = `SOPS_AGE_KEY_FILE="${cfg.keyFile}" sops --decrypt --in-place --config "${cfg.configFile}" "${file}"`;
  const { exitCode, stderr } = execSafe(cmd);
  if (exitCode === 0) {
    log.success(`Decrypted: ${relpath}`);
    log.warn("Remember to re-encrypt before committing!");
    return true;
  }
  log.error(`Failed to decrypt: ${relpath}`);
  if (stderr) log.error(stderr);
  return false;
}

export function editFile(file: string, cfg: SopsConfig): void {
  exec(
    `SOPS_AGE_KEY_FILE="${cfg.keyFile}" EDITOR="${process.env.EDITOR ?? "vim"}" sops --config "${cfg.configFile}" "${file}"`,
  );
}

// ---------------------------------------------------------------------------
// Batch operations
// ---------------------------------------------------------------------------

export async function encryptAll(
  cfg: SopsConfig,
  repoRoot: string,
): Promise<{ encrypted: number; skipped: number; total: number }> {
  const files = findSecretFiles(repoRoot);
  let encrypted = 0;
  let skipped = 0;

  for (const file of files) {
    const relpath = relative(repoRoot, file);

    if (isEncrypted(file)) {
      log.info(`  [skip] ${relpath} (already encrypted)`);
      skipped++;
      continue;
    }

    if (hasEnvsubstVars(file)) {
      log.warn(`  [skip] ${relpath} (contains envsubst variables)`);
      skipped++;
      continue;
    }

    const ok = await encryptFile(file, cfg, repoRoot);
    if (ok) encrypted++;
    else skipped++;
  }

  return { encrypted, skipped, total: files.length };
}

export async function decryptAll(
  cfg: SopsConfig,
  repoRoot: string,
): Promise<string[]> {
  const files = findSecretFiles(repoRoot);
  const decrypted: string[] = [];

  for (const file of files) {
    if (isEncrypted(file)) {
      const ok = await decryptFile(file, cfg, repoRoot);
      if (ok) decrypted.push(file);
    }
  }

  return decrypted;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface SecretFileStatus {
  path: string;
  relpath: string;
  status: "encrypted" | "template" | "plaintext";
}

export function getSecretStatus(repoRoot: string): SecretFileStatus[] {
  return findSecretFiles(repoRoot).map((file) => {
    const relpath = relative(repoRoot, file);
    let status: SecretFileStatus["status"];

    if (isEncrypted(file)) {
      status = "encrypted";
    } else if (hasEnvsubstVars(file)) {
      status = "template";
    } else {
      status = "plaintext";
    }

    return { path: file, relpath, status };
  });
}

// ---------------------------------------------------------------------------
// Template substitution for secrets
// ---------------------------------------------------------------------------

export function substituteAndEncrypt(
  file: string,
  vars: Record<string, string>,
  cfg: SopsConfig,
  repoRoot: string,
): void {
  let content = readFileSync(file, "utf-8");

  content = content
    .split("\n")
    .filter(
      (line: string) =>
        !line.includes("# This secret is created by the bootstrap script") &&
        !line.includes("# This is just a template"),
    )
    .join("\n");

  for (const [key, value] of Object.entries(vars)) {
    content = content.replaceAll(`\${${key}}`, value);
  }

  writeFileSync(file, content);
  encryptFile(file, cfg, repoRoot);
}

// ---------------------------------------------------------------------------
// Flux Kustomization patching
// ---------------------------------------------------------------------------

export function updateFluxKustomization(
  repoRoot: string,
  secretName: string,
): void {
  const syncFile = `${repoRoot}/clusters/_template/cluster-sync.yaml`;
  if (!existsSync(syncFile)) {
    log.warn("No cluster-sync.yaml template found — skipping auto-patch.");
    return;
  }

  const content = readFileSync(syncFile, "utf-8");
  if (content.includes("decryption:")) {
    log.success("Decryption already configured in cluster-sync.yaml");
    return;
  }

  const patched = content.replace(
    /^(\s*prune:)/m,
    `  decryption:\n    provider: sops\n    secretRef:\n      name: ${secretName}\n$1`,
  );
  writeFileSync(syncFile, patched);
  log.success("Added decryption config to cluster-sync.yaml");
}
