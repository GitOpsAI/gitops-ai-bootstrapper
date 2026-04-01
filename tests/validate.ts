import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  cpSync,
  mkdirSync,
} from "node:fs";
import { execSafe } from "../src/utils/shell.js";

const CLUSTER_NAME = "ci-test";
const TEMPLATE_DIR = "clusters/_default-template";
const CLUSTER_DIR = `clusters/${CLUSTER_NAME}`;

let templateReady = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function envsubst(content: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce(
    (acc, [k, v]) => acc.replaceAll(`\${${k}}`, v),
    content,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Validate manifests", { timeout: 120_000 }, () => {
  before(() => {
    if (!existsSync(TEMPLATE_DIR)) {
      console.log(`Template directory '${TEMPLATE_DIR}' not found — skipping validation setup`);
      return;
    }

    mkdirSync(CLUSTER_DIR, { recursive: true });
    cpSync(TEMPLATE_DIR, CLUSTER_DIR, { recursive: true });

    const syncFile = `${CLUSTER_DIR}/cluster-sync.yaml`;
    if (existsSync(syncFile)) {
      writeFileSync(
        syncFile,
        envsubst(readFileSync(syncFile, "utf-8"), {
          CLUSTER_NAME,
          CLUSTER_DOMAIN: "example.com",
          CLUSTER_PUBLIC_IP: "127.0.0.1",
          LETSENCRYPT_EMAIL: "ci@example.com",
          INGRESS_NGINX_ALLOWED_IPS: "0.0.0.0/0",
        }),
      );
    }

    writeFileSync(
      "/tmp/flux-system-ks.yaml",
      [
        "apiVersion: kustomize.toolkit.fluxcd.io/v1",
        "kind: Kustomization",
        "metadata:",
        "  name: flux-system",
        "  namespace: flux-system",
        "spec:",
        "  interval: 10m",
        "  sourceRef:",
        "    kind: GitRepository",
        "    name: flux-system",
        `  path: "./${CLUSTER_DIR}"`,
        "  prune: true",
        "",
      ].join("\n"),
    );

    templateReady = true;
  });

  it("should pass flux build kustomization validation", (t) => {
    if (!templateReady) {
      t.skip("No template directory to validate");
      return;
    }

    const { exitCode, stdout, stderr } = execSafe(
      `flux build kustomization flux-system --path "${CLUSTER_DIR}" --kustomization-file /tmp/flux-system-ks.yaml --dry-run`,
    );
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
    assert.equal(exitCode, 0, "Flux kustomization build failed");
  });
});
