import * as p from "@clack/prompts";
import pc from "picocolors";
import { header, log, handleCancel, formatError } from "../utils/log.js";
import * as k8sApi from "../core/k8s-api.js";
import { podConsole } from "./pod-console.js";

const WORKLOAD = k8sApi.OPENCLAW_WORKLOAD;

const MISSING_HINT =
  `Is the OpenClaw component enabled and reconciled? Check: ${pc.cyan(
    `kubectl get openclawinstance,statefulset,pods -n ${WORKLOAD.namespace}`,
  )} and ${pc.cyan("flux get helmreleases -A")}`;

const LOGS_HINT = `kubectl logs -n ${WORKLOAD.namespace} statefulset/${WORKLOAD.name} -c ${k8sApi.OPENCLAW_K8S_CONTAINER_NAME} --tail=100`;

function failWith(prefix: string, err: unknown): never {
  log.error(`${prefix}\n${formatError(err)}`);
  if (err instanceof k8sApi.WorkloadNotFoundError) log.detail(MISSING_HINT);
  return process.exit(1) as never;
}

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
    const code = await k8sApi.execInWorkloadContainerTty(kc, WORKLOAD, [
      "openclaw",
      "devices",
      "list",
    ]);
    if (code !== 0) {
      log.error("devices list failed");
      return process.exit(1) as never;
    }
  } catch (err) {
    failWith("Failed to list device requests", err);
  }

  const requestId = await p.text({
    message: "Enter REQUEST_ID to approve",
    validate: (v) => {
      if (!v) return "REQUEST_ID must not be empty";
    },
  });
  if (p.isCancel(requestId)) handleCancel();

  log.step(`Approving device ${requestId}`);
  let approve: Awaited<ReturnType<typeof k8sApi.execInWorkloadContainer>>;
  try {
    approve = await k8sApi.execInWorkloadContainer(k8sApi.kubeConfigFromDefault(), WORKLOAD, [
      "openclaw",
      "devices",
      "approve",
      requestId as string,
    ]);
  } catch (err) {
    failWith("Failed to approve the device", err);
  }
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
      `This runs OpenClaw's PKCE OAuth flow in the ${pc.cyan(`${WORKLOAD.namespace}/${WORKLOAD.name}`)} pod ` +
      `(same mechanism as ${pc.cyan("gitops-ai pod-console")} — Kubernetes API attach).\n` +
      `If the browser callback cannot reach the pod (typical on remote clusters), ` +
      `paste the redirect URL or code when the CLI asks.\n\n` +
      pc.dim("Docs: https://docs.openclaw.ai/concepts/oauth"),
    "OpenAI Codex",
  );

  await podConsole(undefined, {
    sessionTitle: "OpenClaw — OpenAI Codex (OAuth)",
    sessionSubtitle: "OAuth login in the openclaw workload",
    workload: WORKLOAD,
    workloadMissingHint: MISSING_HINT,
    container: k8sApi.OPENCLAW_K8S_CONTAINER_NAME,
    shell: "bash",
    execCommand: ["openclaw", "models", "auth", "login", "--provider", "openai-codex"],
    execSuccessMessage: "OAuth login finished",
    execFailureHint:
      "If the browser cannot reach the callback inside the pod, choose paste / manual URL when OpenClaw offers it. " +
      `Check logs: ${pc.cyan(LOGS_HINT)}`,
  });

  p.log.message(
    pc.dim(
      "If models still fail, set the default model to a Codex-capable id in OpenClaw " +
        "(e.g. openai-codex/…) per OpenClaw provider docs.",
    ),
  );
}
