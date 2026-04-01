# Configuration

This document covers cluster variables, environment variables, SOPS defaults, and how to make changes after bootstrap.

## Cluster Variables

These values are collected during the wizard and rendered into `clusters/<name>/cluster-sync.yaml` via variable substitution:

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `CLUSTER_NAME` | Kubernetes cluster name; used as the directory name under `clusters/` | `homelab` | `production` |
| `CLUSTER_DOMAIN` | DNS domain for services; components with subdomains are accessible at `<sub>.<domain>` | `homelab.click` | `infra.example.com` |
| `CLUSTER_PUBLIC_IP` | IP address that DNS records point to; `127.0.0.1` when DNS management is disabled | Auto-detected | `203.0.113.10` |
| `LETSENCRYPT_EMAIL` | Email for Let's Encrypt certificate issuance notifications | (none) | `admin@example.com` |
| `INGRESS_NGINX_ALLOWED_IPS` | Comma-separated CIDR ranges allowed to access the ingress controller | `0.0.0.0/0` | `10.0.0.0/8,192.168.1.0/24` |

After bootstrap, you can change these by editing `clusters/<name>/cluster-sync.yaml` directly, committing, and pushing. Flux picks up the change on its next reconciliation cycle.

## Environment Variables

The CLI reads the following environment variables at runtime:

| Variable | Description | Default |
|----------|-------------|---------|
| `SOPS_AGE_KEY_DIR` | Directory where the age encryption key is stored | `~/.sops` |
| `SOPS_NAMESPACE` | Kubernetes namespace for the SOPS age secret | `flux-system` |
| `SOPS_SECRET_NAME` | Name of the Kubernetes secret holding the age key | `sops-age` |
| `EDITOR` | Editor used by `sops edit` to open encrypted files | `vim` |
| `HOME` | Used to derive default paths for kubeconfig and SOPS keys | (system) |
| `KUBECONFIG` | Set automatically by the bootstrap after cluster creation | (set at runtime) |
| `CI` | When set, the bootstrap uses k3d instead of k3s (same as macOS path) | (unset) |

## SOPS Defaults

The `defaultSopsConfig()` function derives these paths from the environment:

| Setting | Path |
|---------|------|
| Key directory | `$SOPS_AGE_KEY_DIR` or `~/.sops` |
| Key file | `<keyDir>/age.agekey` |
| Backup directory | `<keyDir>/backups` |
| SOPS config | `<repoRoot>/.sops.yaml` |
| K8s secret name | `$SOPS_SECRET_NAME` or `sops-age` |
| K8s namespace | `$SOPS_NAMESPACE` or `flux-system` |

## Post-Bootstrap Changes

### Changing cluster variables

Edit `clusters/<name>/cluster-sync.yaml`, commit, and push. Flux reconciles the change automatically.

```bash
# Example: restrict ingress to a private subnet
vim clusters/homelab/cluster-sync.yaml
git add -A && git commit -m "Restrict ingress to 10.0.0.0/8" && git push
```

### Adding a component

If a component was disabled during bootstrap and you want to add it later:

1. Copy the component directory from `clusters/_default-template/components/<id>` to `clusters/<name>/components/<id>`
2. Add the component to `clusters/<name>/components/kustomization.yaml`
3. If the component requires secrets (check the component directory for `secret-*.yaml` files), encrypt them with SOPS:

```bash
npx gitops-ai sops encrypt clusters/<name>/components/<id>/secret-*.yaml
```

4. Commit and push

### Removing a component

1. Delete the component directory: `rm -rf clusters/<name>/components/<id>`
2. Remove the `- <id>` line from `clusters/<name>/components/kustomization.yaml`
3. Commit and push

Flux will remove the component's resources from the cluster on reconciliation.

### Re-encrypting secrets

After editing a decrypted secret, re-encrypt before committing:

```bash
# Decrypt, edit, re-encrypt a single file
npx gitops-ai sops edit clusters/homelab/components/cert-manager/secret-cloudflare.yaml

# Or encrypt all plaintext secrets at once
npx gitops-ai sops encrypt

# Check which secrets need encryption
npx gitops-ai sops status
```

### Rotating the SOPS key

If you need to rotate the age encryption key (e.g. after a key compromise):

```bash
npx gitops-ai sops rotate
```

This generates a new age key, decrypts all secrets with the old key, re-encrypts with the new key, and updates the Kubernetes secret. Commit the updated `.sops.yaml` and re-encrypted files afterward.

Keep the old key backup (stored in `~/.sops/backups/`) until all clusters are updated.

## Security Notes

### Age key backup

The age private key at `~/.sops/age.agekey` is the only way to decrypt your secrets. If lost, encrypted secrets in Git become unrecoverable. Back it up securely (e.g. in a password manager or hardware security module).

### Secret encryption at rest

All sensitive values (Cloudflare tokens, OpenAI keys, gateway tokens) are encrypted with SOPS/Age before being committed to Git. The age private key exists only in two places:

- On the machine that ran the bootstrap (`~/.sops/age.agekey`)
- In the Kubernetes cluster (as a secret in `flux-system`)

Flux's kustomize-controller decrypts secrets in-memory during reconciliation -- plaintext values never touch disk inside the cluster beyond Kubernetes secret storage.

### Container hardening

The GitOps template configures workloads following NSA Kubernetes hardening guidelines:

- Containers run as non-root users
- Root filesystems are read-only
- All Linux capabilities are dropped
- SecurityContext is set on every pod

### Network policies

Ingress traffic is restricted to the CIDR ranges you configure. Individual components include NetworkPolicy resources that limit pod-to-pod communication to only the services they need to reach.
