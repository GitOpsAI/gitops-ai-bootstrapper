import {
  execSync,
  exec as execCb,
  spawnSync,
  type StdioOptions,
} from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run a command synchronously, returning trimmed stdout.
 * Throws on non-zero exit.
 */
export function exec(
  command: string,
  opts?: { cwd?: string; env?: Record<string, string> },
): string {
  return execSync(command, {
    encoding: "utf-8",
    cwd: opts?.cwd,
    env: { ...process.env, ...opts?.env },
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
  }).trim();
}

/**
 * Run a command synchronously, never throws.
 */
export function execSafe(
  command: string,
  opts?: { cwd?: string },
): ExecResult {
  try {
    const stdout = execSync(command, {
      encoding: "utf-8",
      cwd: opts?.cwd,
      stdio: "pipe",
    }).trim();
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; status?: number };
    return {
      stdout: e.stdout?.toString().trim() ?? "",
      stderr: e.stderr?.toString().trim() ?? "",
      exitCode: e.status ?? 1,
    };
  }
}

/**
 * Run a command asynchronously (for use with spinners).
 */
export function execAsync(
  command: string,
  opts?: { cwd?: string },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execCb(
      command,
      {
        encoding: "utf-8",
        cwd: opts?.cwd,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error: Error | null, stdout: string, stderr: string) => {
        if (error) {
          const wrapped = new Error(stderr || error.message) as Error & {
            exitCode: number;
            stdout: string;
          };
          wrapped.exitCode = (error as NodeJS.ErrnoException).code as unknown as number;
          wrapped.stdout = stdout;
          reject(wrapped);
        } else {
          resolve(stdout.trim());
        }
      },
    );
  });
}

/**
 * Run a command with output streamed to the terminal (inherit stdio).
 */
export function streamExec(
  command: string,
  opts?: { cwd?: string; stdio?: StdioOptions },
): void {
  execSync(command, {
    cwd: opts?.cwd,
    stdio: opts?.stdio ?? "inherit",
  });
}

/**
 * Run a command with spawnSync for finer arg control.
 */
export function run(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; stdio?: StdioOptions },
): ExecResult {
  const result = spawnSync(cmd, args, {
    encoding: "utf-8",
    stdio: opts?.stdio ?? "pipe",
    cwd: opts?.cwd,
  });
  return {
    stdout: (result.stdout as string)?.trim() ?? "",
    stderr: (result.stderr as string)?.trim() ?? "",
    exitCode: result.status ?? 1,
  };
}

export function commandExists(name: string): boolean {
  const { exitCode } = execSafe(`command -v ${name}`);
  return exitCode === 0;
}
