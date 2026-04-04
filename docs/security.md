# Security Model

## Network use (CLI)

The **gitops-ai** CLI is a networked tool. Static scanners (e.g. “network access” or `fetch` / HTTP capability flags) will report that the package can use the network; that is **intentional**, not a defect to remove.

Outbound access is used only for documented workflows:

| Area                  | Purpose                                                                                                                                                                               |
|-----------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Git provider APIs** | GitHub / GitLab REST calls (repos, namespaces, deploy keys, etc.) via `fetch`.                                                                                                        |
| **OAuth**             | Device and browser OAuth for GitHub, GitLab, and Cloudflare; HTTPS token exchange; a short-lived **local** `node:http` listener for the redirect/callback where the flow requires it. |
| **Template sync**     | Resolving upstream template tags/refs from the configured Git host.                                                                                                                   |
| **Child processes**   | `git`, `helm`, `kubectl`, `k3d`, and similar tools, which open connections when you push, pull, install charts, or talk to a cluster API server.                                      |

**Consumers** should run the CLI on **trusted** machines, pin releases, and restrict egress in line with organizational policy if needed. **Supply-chain tools** should treat network capability here as **expected** for a GitOps installer, not as evidence of unwanted behavior unless runtime traffic contradicts the table above.

## Repository and cluster

- **Secrets at rest**: all sensitive values (API tokens, keys) are encrypted with SOPS/Age before being committed to Git. The age private key exists only in the cluster (as a Kubernetes secret) and on the machine that ran the bootstrap (at `~/.sops/age.agekey`).
- **Git provider auth**: the in-cluster Git credentials secret uses a token or deploy key scoped to the minimum required permissions; Flux pulls over HTTPS or SSH as configured.
- **Container hardening**: the template repository configures workloads with non-root users, read-only root filesystems, and dropped capabilities following [NSA Kubernetes hardening guidelines](https://media.defense.gov/2022/Aug/29/2003066362/-1/-1/0/CTR_KUBERNETES_HARDENING_GUIDANCE_1.2_20220829.PDF).
- **Network isolation**: ingress is restricted to the CIDR ranges you specify during the wizard. Components include NetworkPolicy resources to limit pod-to-pod communication.
