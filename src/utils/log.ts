import * as p from "@clack/prompts";
import pc from "picocolors";

export const log = {
  step: (msg: string) => p.log.step(pc.cyan(msg)),
  success: (msg: string) => p.log.success(pc.green(msg)),
  warn: (msg: string) => p.log.warning(pc.yellow(msg)),
  error: (msg: string) => p.log.error(pc.red(msg)),
  info: (msg: string) => p.log.info(msg),
  message: (msg: string) => p.log.message(msg),
  detail: (msg: string) => p.log.message(pc.dim(msg)),
};

export function header(title: string, subtitle?: string): void {
  console.log();
  p.intro(pc.bgCyan(pc.black(` ${title} `)));
  if (subtitle) {
    p.log.info(pc.dim(subtitle));
  }
}

/** Max characters per line for values before wrapping (tokens, long URLs). */
const SUMMARY_VALUE_WRAP = 56;

function formatSummaryLines(entries: Record<string, string>): string {
  const list = Object.entries(entries);
  if (list.length === 0) return "";

  const labelWithColon = (k: string) => `${k}:`;
  const labelWidth = Math.max(
    ...list.map(([k]) => labelWithColon(k).length),
    0,
  );
  const gap = 2;
  const indent = " ".repeat(labelWidth + gap);

  const out: string[] = [];
  for (const [key, raw] of list) {
    const label = labelWithColon(key).padEnd(labelWidth + gap);
    const value = raw ?? "";

    if (value.length === 0 || value.length <= SUMMARY_VALUE_WRAP) {
      out.push(`${pc.bold(label)}${pc.cyan(value)}`);
      continue;
    }

    let pos = 0;
    let first = true;
    while (pos < value.length) {
      const chunk = value.slice(pos, pos + SUMMARY_VALUE_WRAP);
      pos += SUMMARY_VALUE_WRAP;
      if (first) {
        out.push(`${pc.bold(label)}${pc.cyan(chunk)}`);
        first = false;
      } else {
        out.push(`${indent}${pc.cyan(chunk)}`);
      }
    }
  }
  return out.join("\n");
}

export function summary(title: string, entries: Record<string, string>): void {
  p.note(formatSummaryLines(entries), title);
}

export function nextSteps(steps: string[]): void {
  const lines = steps
    .map((s, i) => `${pc.bold(`${i + 1}.`)} ${s}`)
    .join("\n");
  p.note(lines, "Next Steps");
}

export function finish(msg: string): void {
  p.outro(pc.green(msg));
}

export function handleCancel(): never {
  p.cancel("Operation cancelled.");
  return process.exit(0) as never;
}

/**
 * Format an error for display — extracts stderr, stdout, and message.
 */
export function formatError(err: unknown): string {
  const e = err as Error & { stderr?: string; stdout?: string; exitCode?: number };
  const parts: string[] = [];
  if (e.stderr) parts.push(e.stderr.trim());
  else if (e.message) parts.push(e.message);
  if (e.stdout) parts.push(pc.dim(e.stdout.trim()));
  return parts.join("\n");
}

/**
 * Wrap an async task with a @clack/prompts spinner.
 * Shows command output on success (if string) and error details on failure.
 */
export async function withSpinner<T>(
  message: string,
  fn: () => Promise<T>,
  doneMessage?: string,
): Promise<T> {
  const s = p.spinner();
  s.start(message);
  try {
    const result = await fn();
    s.stop(doneMessage ?? pc.green(message));
    if (typeof result === "string" && result.trim()) {
      log.detail(result.trim());
    }
    return result;
  } catch (err) {
    s.stop(pc.red(`Failed: ${message}`));
    const details = formatError(err);
    if (details) log.error(details);
    throw err;
  }
}

/**
 * Run a step with error handling — logs the error and exits.
 * Use for steps that should abort the bootstrap on failure.
 */
export async function runStep<T>(
  title: string,
  fn: () => Promise<T>,
): Promise<T> {
  log.step(title);
  try {
    const result = await fn();
    if (typeof result === "string" && result.trim()) {
      log.detail(result.trim());
    }
    return result;
  } catch (err) {
    const details = formatError(err);
    if (details) log.error(details);
    return process.exit(1) as never;
  }
}

export { pc, p };
