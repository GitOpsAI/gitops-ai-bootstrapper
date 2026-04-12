import * as p from "@clack/prompts";
import pc from "picocolors";
import { header, log, handleCancel } from "../utils/log.js";
import * as k8sApi from "../core/k8s-api.js";
import { podConsole } from "./pod-console.js";

/**
 * Pair an OpenClaw device with the cluster (list + approve device requests in the openclaw workload).
 */
export async function openclawPair(): Promise<void> {
  header("OpenClaw Device Pairing");

  p.log.info("1. Open Claude UI in your browser");
  p.log.info("2. Enter your Gateway Token and click Connect");

  const ready = await p.confirm({
    message: "Have you submitted the pairing request?",
  });
  if (p.isCancel(ready) || !ready) handleCancel();

  log.step("Listing pending device requests");
  try {
    const kc = k8sApi.kubeConfigFromDefault();
    const code = await k8sApi.execInDeploymentContainerTty(
      kc,
      "openclaw",
      "openclaw",
      ["node", "dist/index.js", "devices", "list"],
    );
    if (code !== 0) {
      log.error("devices list failed");
      return process.exit(1) as never;
    }
  } catch {
    log.error("Failed to list device requests");
    return process.exit(1) as never;
  }

  const requestId = await p.text({
    message: "Enter REQUEST_ID to approve",
    validate: (v) => {
      if (!v) return "REQUEST_ID must not be empty";
    },
  });
  if (p.isCancel(requestId)) handleCancel();

  log.step(`Approving device ${requestId}`);
  const kcApprove = k8sApi.kubeConfigFromDefault();
  const approve = await k8sApi.execInDeploymentContainer(
    kcApprove,
    "openclaw",
    "openclaw",
    ["node", "dist/index.js", "devices", "approve", requestId as string],
  );
  if (approve.exitCode !== 0) {
    log.error(approve.stderr || "approve failed");
    return process.exit(1) as never;
  }
  log.success("Device paired successfully");
}

/**
 * Run OpenClaw's interactive OpenAI Codex (ChatGPT OAuth) login inside the cluster.
 * Uses the same session path as {@link podConsole} (kubeconfig, API check, TTY exec).
 * Tokens are stored on the OpenClaw PVC under ~/.openclaw (see OpenClaw OAuth docs).
 */
export async function openclawCodexLogin(): Promise<void> {
  p.note(
    `${pc.bold("Subscription auth")}\n\n` +
      `This runs OpenClaw's PKCE OAuth flow in the ${pc.cyan("openclaw")} pod ` +
      `(same mechanism as ${pc.cyan("gitops-ai pod-console")} — Kubernetes API attach).\n` +
      `If the browser callback cannot reach the pod (typical on remote clusters), ` +
      `paste the redirect URL or code when the CLI asks.\n\n` +
      pc.dim("Docs: https://docs.openclaw.ai/concepts/oauth"),
    "OpenAI Codex",
  );

  await podConsole(undefined, {
    sessionTitle: "OpenClaw — OpenAI Codex (OAuth)",
    sessionSubtitle: "OAuth login in the openclaw workload",
    namespace: "openclaw",
    deployment: "openclaw",
    container: k8sApi.OPENCLAW_K8S_CONTAINER_NAME,
    shell: "bash",
    execCommand: [
      "node",
      "dist/index.js",
      "models",
      "auth",
      "login",
      "--provider",
      "openai-codex",
    ],
    execSuccessMessage: "OAuth login finished",
    execFailureHint:
      "If the browser cannot reach the callback inside the pod, choose paste / manual URL when OpenClaw offers it. " +
      `Check logs: ${pc.cyan("kubectl logs -n openclaw deployment/openclaw --all-containers --tail=100")}`,
  });

  p.log.message(
    pc.dim(
      "If models still fail, set the default model to a Codex-capable id in OpenClaw " +
        "(e.g. openai-codex/…) per OpenClaw provider docs.",
    ),
  );
}
