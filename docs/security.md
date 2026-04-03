# Security Model

- **Secrets at rest**: all sensitive values (API tokens, keys) are encrypted with SOPS/Age before being committed to Git. The age private key exists only in the cluster (as a Kubernetes secret) and on the machine that ran the bootstrap (at `~/.sops/age.agekey`).
- **GitLab auth**: the Git credentials secret uses a PAT scoped to the minimum required permissions. Flux pulls over HTTPS.
- **Container hardening**: the template repository configures workloads with non-root users, read-only root filesystems, and dropped capabilities following [NSA Kubernetes hardening guidelines](https://media.defense.gov/2022/Aug/29/2003066362/-1/-1/0/CTR_KUBERNETES_HARDENING_GUIDANCE_1.2_20220829.PDF).
- **Network isolation**: ingress is restricted to the CIDR ranges you specify during the wizard. Components include NetworkPolicy resources to limit pod-to-pod communication.
