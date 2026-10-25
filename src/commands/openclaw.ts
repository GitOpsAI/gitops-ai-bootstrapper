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
 * Browser OAuth redirects to localhost:1455 inside the pod, which a browser outside the
 * cluster cannot reach; the device-code flow works from any device.
 */
const CODEX_LOGIN_ARGV = ["openclaw", "models", "auth", "login", "--provider", "openai", "--device-code"];

/**
 * Run OpenClaw's ChatGPT/Codex subscription login inside the cluster.
 * Uses the same session path as {@link podConsole} (kubeconfig, API check, TTY exec).
 * Tokens are stored on the OpenClaw PVC under ~/.openclaw (see OpenClaw OAuth docs).
 */
export async function openclawCodexLogin(): Promise<void> {
  const pod = `${WORKLOAD.namespace}/${WORKLOAD.name}`;
  p.note(
    `${pc.bold("Subscription auth")}\n\n` +
      `This runs OpenClaw's ChatGPT device-code sign-in in the ${pc.cyan(pod)} pod ` +
      `(same mechanism as ${pc.cyan("gitops-ai pod-console")} — Kubernetes API attach).\n` +
      `Open the link it prints on any device, enter the code and approve; the pod stores the tokens.\n\n` +
      pc.dim("Docs: https://docs.openclaw.ai/providers/openai/setup"),
    "OpenAI Codex",
  );

  await podConsole(undefined, {
    sessionTitle: "OpenClaw — OpenAI Codex (OAuth)",
    sessionSubtitle: "ChatGPT sign-in in the openclaw workload",
    workload: WORKLOAD,
    workloadMissingHint: MISSING_HINT,
    container: k8sApi.OPENCLAW_K8S_CONTAINER_NAME,
    shell: "bash",
    execCommand: CODEX_LOGIN_ARGV,
    execSuccessMessage: "OAuth login finished",
    execFailureHint:
      "If device-code sign-in is disabled for your ChatGPT workspace, run the browser flow and paste the redirect URL " +
      `when asked: ${pc.cyan(
        `kubectl exec -it -n ${WORKLOAD.namespace} ${WORKLOAD.name}-0 -c ${k8sApi.OPENCLAW_K8S_CONTAINER_NAME} -- openclaw models auth login --provider openai`,
      )}\nCheck logs: ${pc.cyan(LOGS_HINT)}`,
  });

  p.log.message(
    pc.dim(
      `Verify: ${pc.cyan(
        `kubectl exec -n ${WORKLOAD.namespace} ${WORKLOAD.name}-0 -c ${k8sApi.OPENCLAW_K8S_CONTAINER_NAME} -- openclaw models auth list --provider openai`,
      )}. ` + "If models still fail, select an openai/* model (e.g. openai/gpt-6-astra) in the OpenClaw UI.",
    ),
  );
}
