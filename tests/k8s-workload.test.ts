import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as k8s from "@kubernetes/client-node";

import {
  OPENCLAW_WORKLOAD,
  WorkloadNotFoundError,
  podNameForDeployment,
  podNameForWorkload,
} from "../src/core/k8s-api.js";

const SELECTOR = { "app.kubernetes.io/name": "openclaw", "app.kubernetes.io/instance": "openclaw-instance" };

describe("podNameForWorkload", () => {
  let server: Server;
  let kc: k8s.KubeConfig;
  const requests: string[] = [];

  before(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      requests.push(`${req.method} ${url.pathname}?${url.searchParams}`);
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };

      if (url.pathname === "/apis/apps/v1/namespaces/openclaw-instance/statefulsets/openclaw-instance") {
        return send(200, { kind: "StatefulSet", metadata: { name: "openclaw-instance" }, spec: { selector: { matchLabels: SELECTOR } } });
      }
      if (url.pathname === "/api/v1/namespaces/openclaw-instance/pods") {
        return send(200, {
          kind: "PodList",
          items: [
            { metadata: { name: "openclaw-instance-1" }, status: { phase: "Pending" } },
            { metadata: { name: "openclaw-instance-0" }, status: { phase: "Running" } },
          ],
        });
      }
      return send(404, {
        kind: "Status",
        apiVersion: "v1",
        status: "Failure",
        message: "deployments.apps \"openclaw\" not found",
        reason: "NotFound",
        code: 404,
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    kc = new k8s.KubeConfig();
    kc.loadFromOptions({
      // The client only allows plain-HTTP servers with skipTLSVerify; this is a loopback fake.
      clusters: [{ name: "fake", server: `http://127.0.0.1:${port}`, skipTLSVerify: true }],
      users: [{ name: "fake" }],
      contexts: [{ name: "fake", cluster: "fake", user: "fake" }],
      currentContext: "fake",
    });
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("resolves the running OpenClaw pod through the StatefulSet selector", async () => {
    assert.equal(await podNameForWorkload(kc, OPENCLAW_WORKLOAD), "openclaw-instance-0");
    const podQuery = requests.find((r) => r.includes("/pods"));
    assert.match(decodeURIComponent(podQuery ?? ""), /labelSelector=app\.kubernetes\.io\/name=openclaw,app\.kubernetes\.io\/instance=openclaw-instance/);
  });

  it("turns a 404 into WorkloadNotFoundError with the workload name", async () => {
    await assert.rejects(podNameForDeployment(kc, "openclaw", "openclaw"), (err: unknown) => {
      assert.ok(err instanceof WorkloadNotFoundError);
      assert.equal(err.message, "Deployment openclaw/openclaw not found");
      return true;
    });
  });
});
