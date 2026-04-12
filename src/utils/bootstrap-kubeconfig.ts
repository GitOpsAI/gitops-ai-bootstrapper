import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { loadInstallPlan } from "./config.js";
import { isMacOS, isCI } from "./platform.js";
import { INSTALL_PLAN_PATH } from "../schemas.js";

/** Written by `setupKubeconfig`: first line is the absolute path to the active bootstrap kubeconfig. */
const MARKER_BASENAME = ".gitops-ai-kubeconfig";

function expandKubeconfigPath(p: string): string {
  const t = p.trim();
  if (!t) return t;
  if (t[0] !== "~") return t;
  if (t.length === 1) return homedir();
  if (t[1] === "/" || t[1] === path.sep) {
    return path.join(homedir(), t.slice(2));
  }
  return t;
}

export function bootstrapKubeconfigMarkerPath(): string {
  return path.join(homedir(), ".kube", MARKER_BASENAME);
}

/**
 * Persist the kubeconfig path from the last successful `setupKubeconfig` so all CLI/API code
 * loads exactly that file — not `KUBECONFIG`, not `~/.kube/config` unless bootstrap wrote it there.
 */
export function writeBootstrapKubeconfigMarker(kubeconfigPath: string): void {
  const abs = path.resolve(kubeconfigPath);
  writeFileSync(bootstrapKubeconfigMarkerPath(), `${abs}\n`, { mode: 0o600 });
}

/**
 * Absolute path to the kubeconfig file bootstrap created: marker file first, else install plan + same path rules as `setupKubeconfig`.
 */
export function resolveBootstrapKubeconfigPath(): string {
  const marker = bootstrapKubeconfigMarkerPath();
  if (existsSync(marker)) {
    try {
      const line =
        readFileSync(marker, "utf-8").split(/\r?\n/u)[0]?.trim() ?? "";
      const candidate = expandKubeconfigPath(line);
      if (candidate && existsSync(candidate)) {
        return path.resolve(candidate);
      }
    } catch {
      /* fall through */
    }
  }

  const plan = loadInstallPlan();
  const name = plan?.clusterName?.trim();
  if (name) {
    const p = bootstrapKubeconfigFileForCluster(name);
    if (existsSync(p)) {
      return path.resolve(p);
    }
    throw new Error(
      `Kubeconfig for cluster '${name}' not found at:\n  ${p}\n` +
        `Run bootstrap (Kubernetes step) or restore that file. Install plan: ${INSTALL_PLAN_PATH}`,
    );
  }

  throw new Error(
    `No GitOps AI bootstrap kubeconfig.\n` +
      `Run \`gitops-ai bootstrap\` (writes ${marker}) or ensure ${INSTALL_PLAN_PATH} lists clusterName and the kubeconfig from setup exists.`,
  );
}

/**
 * Absolute path where bootstrap writes kubeconfig for this cluster (whether or not the file exists).
 * Matches `setupKubeconfig`: k3d → `~/.kube/k3d-<name>`, k3s → `~/.kube/config`.
 */
export function bootstrapKubeconfigFileForCluster(clusterName: string): string {
  if (isMacOS() || isCI()) {
    return path.join(homedir(), ".kube", `k3d-${clusterName}`);
  }
  return path.join(homedir(), ".kube", "config");
}
