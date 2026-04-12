import * as p from "@clack/prompts";
import pc from "picocolors";
import { handleCancel, header, log } from "../utils/log.js";
import {
  checkClusterApi,
  execInteractiveAttach,
  kubeConfigFromDefault,
  kubeConnectionSummary,
  listContainerNamesInPod,
  listPodsForPodConsole,
  podNameForDeployment,
  type PodConsoleRow,
  type ExecInteractiveResult,
} from "../core/k8s-api.js";

export interface PodConsoleCliOptions {
  /** With explicit pod name: exec namespace (default applied in handler). */
  namespace?: string;
  container?: string;
  shell: string;
  /** Resolve pod from this Deployment (requires `namespace`). Skips pod picker. */
  deployment?: string;
  /** Run this argv with TTY instead of an interactive shell (same exec path as shell). */
  execCommand?: string[];
  /** Override {@link header} title/sub (e.g. OpenClaw codex login). */
  sessionTitle?: string;
  sessionSubtitle?: string;
  execSuccessMessage?: string;
  execFailureHint?: string;
}

/** When `--shell bash` (the default), try these in order for minimal / distroless images. */
const DEFAULT_SHELL_FALLBACK_ARGVS: string[][] = [
  ["/bin/bash"],
  ["/bin/ash"],
  ["/bin/sh"],
];

/** True when Kubernetes exec failed because the binary was missing (retry with next shell). */
export function execMessageLooksLikeMissingExecutable(
  message: string | undefined,
): boolean {
  if (!message) return false;
  return /no such file or directory|executable file not found/i.test(message);
}

/**
 * Map CLI `--shell` to the process argv for `kubectl exec` (single binary, no login shell).
 * Default `bash` uses {@link DEFAULT_SHELL_FALLBACK_ARGVS} at runtime when a binary is missing.
 */
export function shellCommandArgv(shell: string): string[] {
  const raw = shell.trim();
  if (!raw) return ["/bin/bash"];
  if (raw.includes("/")) return [raw];
  const key = raw.toLowerCase();
  if (key === "auto") return ["/bin/sh"];
  const map: Record<string, string[]> = {
    bash: ["/bin/bash"],
    sh: ["/bin/sh"],
    ash: ["/bin/sh"],
  };
  if (map[key]) return map[key];
  return [`/bin/${raw}`];
}

/**
 * Use bash → ash → sh only for the default `bash` option; explicit `sh` / `auto` / paths stay single-shot.
 * Exported for unit tests.
 */
export function shellArgvCandidates(shellOption: string): string[][] {
  const t = shellOption.trim().toLowerCase();
  if (t === "" || t === "bash") {
    return DEFAULT_SHELL_FALLBACK_ARGVS;
  }
  return [shellCommandArgv(shellOption)];
}

function rowKey(row: PodConsoleRow): string {
  return `${row.namespace}\x1e${row.name}`;
}

function parseRowKey(key: string): { namespace: string; name: string } {
  const i = key.indexOf("\x1e");
  if (i === -1) return { namespace: "default", name: key };
  return { namespace: key.slice(0, i), name: key.slice(i + 1) };
}

/**
 * Interactive shell in a Pod: pick from the cluster when `podName` is omitted.
 */
export async function podConsole(
  podName: string | undefined,
  opts: PodConsoleCliOptions,
): Promise<void> {
  header(
    opts.sessionTitle ?? "Pod console",
    opts.sessionSubtitle ??
      (opts.execCommand?.length
        ? "Run command in pod"
        : "Choose a pod and open a shell"),
  );

  let kc;
  try {
    kc = kubeConfigFromDefault();
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const health = await checkClusterApi(kc);
  if (!health.ok) {
    log.error(
      `Cannot reach the Kubernetes API.\n${pc.dim(kubeConnectionSummary(kc))}\n\n${health.detail}`,
    );
    log.detail(
      "Uses only the kubeconfig from gitops-ai bootstrap (~/.kube/.gitops-ai-kubeconfig). Check VPN/firewall and that the cluster is up.",
    );
    process.exit(1);
  }

  let namespace: string;
  let name: string;

  if (podName) {
    namespace = opts.namespace ?? "default";
    name = podName;
  } else if (opts.deployment?.trim()) {
    const ns = opts.namespace?.trim();
    if (!ns) {
      log.error("With deployment, set namespace (e.g. openclaw).");
      process.exit(1);
    }
    namespace = ns;
    const resolved = await podNameForDeployment(kc, namespace, opts.deployment.trim());
    if (!resolved) {
      log.error(`No pod found for Deployment ${namespace}/${opts.deployment}`);
      process.exit(1);
    }
    name = resolved;
  } else {
    const filterHint = opts.namespace
      ? pc.dim(`namespace filter: ${opts.namespace}`)
      : pc.dim("all namespaces");
    p.log.info(`Loading pods (${filterHint})…`);
    const rows = await listPodsForPodConsole(kc, opts.namespace);
    if (rows.length === 0) {
      log.error(
        opts.namespace
          ? `No pods in namespace ${opts.namespace}.`
          : "No pods found in the cluster.",
      );
      process.exit(1);
    }

    const choice = await p.select({
      message: pc.bold("Select a pod"),
      options: rows.map((r) => ({
        value: rowKey(r),
        label: `${r.namespace}/${r.name}`,
        hint: r.phase,
      })),
      maxItems: 20,
    });
    if (p.isCancel(choice)) handleCancel();
    const parsed = parseRowKey(choice as string);
    namespace = parsed.namespace;
    name = parsed.name;
  }

  let containerName = opts.container;
  if (!containerName) {
    const names = await listContainerNamesInPod(kc, namespace, name);
    if (names.length === 0) {
      log.error(`Pod ${namespace}/${name} has no containers.`);
      process.exit(1);
    }
    if (names.length === 1) {
      containerName = names[0];
    } else {
      const c = await p.select({
        message: pc.bold("Select a container"),
        options: names.map((n) => ({ value: n, label: n })),
      });
      if (p.isCancel(c)) handleCancel();
      containerName = c as string;
    }
  }

  const execCmd = opts.execCommand?.filter((s) => s.length > 0);
  if (execCmd && execCmd.length > 0) {
    log.info(
      `${pc.dim("Exec →")} ${pc.cyan(`${namespace}/${name}`)} · ${pc.dim(containerName)}\n` +
        pc.dim(execCmd.join(" ")),
    );
    try {
      const last = await execInteractiveAttach(
        kc,
        namespace,
        name,
        containerName,
        execCmd,
        true,
      );
      if (last.exitCode === 0) {
        if (opts.execSuccessMessage) {
          log.success(opts.execSuccessMessage);
        }
        return;
      }
      const extra = last.k8sStatus?.message ? `\n${last.k8sStatus.message}` : "";
      log.error(`Command exited with code ${last.exitCode}.${extra}`);
      if (opts.execFailureHint) {
        p.log.message(pc.dim(opts.execFailureHint));
      }
      process.exit(1);
    } catch (err) {
      log.error((err as Error).message);
      process.exit(1);
    }
  }

  log.info(`Shell → ${pc.cyan(`${namespace}/${name}`)} · ${pc.dim(containerName)}`);

  const candidates = shellArgvCandidates(opts.shell);
  try {
    let last: ExecInteractiveResult | undefined;
    for (let i = 0; i < candidates.length; i++) {
      const argv = candidates[i];
      last = await execInteractiveAttach(
        kc,
        namespace,
        name,
        containerName,
        argv,
        true,
      );
      if (last.exitCode === 0) {
        return;
      }
      const msg = last.k8sStatus?.message;
      const canRetry =
        i < candidates.length - 1 && execMessageLooksLikeMissingExecutable(msg);
      if (canRetry) {
        log.detail(`${pc.dim(argv[0])} not available in image, trying ${candidates[i + 1][0]}…`);
        continue;
      }
      const extra = msg ? `\n${msg}` : "";
      log.error(`Shell exited with code ${last.exitCode}.${extra}`);
      process.exit(1);
    }
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }
}
