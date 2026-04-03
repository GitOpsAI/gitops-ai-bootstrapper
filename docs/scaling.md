# Scaling the Cluster (k3s)

> This section applies to **k3s** installations on Linux. k3d clusters (macOS / CI) are single-node by design and are not intended for production scaling.

k3s supports horizontal scaling by adding **server** (control-plane) and **agent** (worker-only) nodes. After bootstrap you have a single-node cluster; all the steps below happen outside of Git and Flux -- they configure the k3s runtime, not the workloads.

## Adding worker nodes

On each new machine, run the k3s agent installer pointing to your existing server:

```bash
curl -sfL https://get.k3s.io | K3S_URL=https://<server-ip>:6443 \
  K3S_TOKEN=<node-token> sh -
```

The node token is stored on the server at `/var/lib/rancher/k3s/server/node-token`.

Once the agent joins, Kubernetes schedules pods across all nodes automatically. Flux-managed workloads will spread according to their resource requests and any topology/affinity rules defined in their Helm values.

## Adding server (control-plane) nodes

For high availability, add additional server nodes that share the same datastore:

```bash
curl -sfL https://get.k3s.io | K3S_TOKEN=<node-token> \
  sh -s - server --server https://<first-server-ip>:6443
```

k3s uses an embedded etcd cluster when three or more server nodes are present, providing automatic leader election and fault tolerance.

## Removing nodes

```bash
# On the node being removed
/usr/local/bin/k3s-agent-uninstall.sh   # agent node
/usr/local/bin/k3s-uninstall.sh          # server node

# On any remaining server — clean up the node record
kubectl delete node <node-name>
```

## GitOps considerations

- **Workload distribution** is handled by Kubernetes scheduling. To pin components to specific nodes, add `nodeSelector` or `tolerations` in the Helm values within your GitOps repo (`clusters/<name>/components/<component>/`).
- **Persistent volumes**: if you scale to multiple nodes, ensure your storage class supports distributed access or use `nodeAffinity` to bind stateful workloads.
- **Ingress**: all nodes running the ingress controller share the same CIDR allowlist defined during bootstrap. Point your DNS or load balancer to the appropriate node IPs.

## Further reading

- [k3s Architecture](https://docs.k3s.io/architecture) -- single-server and HA topologies
- [k3s Quick-Start](https://docs.k3s.io/quick-start) -- installation and cluster join commands
- [k3s High Availability](https://docs.k3s.io/datastore/ha-embedded) -- embedded etcd HA setup
- [k3s Agent Configuration](https://docs.k3s.io/cli/agent) -- agent flags and environment variables
