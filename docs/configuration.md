# Configuration

This document covers cluster variables, environment variables, SOPS defaults, and how to make changes after bootstrap.

## Cluster Variables

These values are collected during the wizard and rendered into `clusters/<name>/cluster-sync.yaml` via variable substitution:

| Variable                    | Description                                                                            | Default         | Example                     |
|-----------------------------|----------------------------------------------------------------------------------------|-----------------|-----------------------------|
| `CLUSTER_NAME`              | Kubernetes cluster name; used as the directory name under `clusters/`                  | `homelab`       | `production`                |
| `CLUSTER_DOMAIN`            | DNS domain for services; components with subdomains are accessible at `<sub>.<domain>` | `homelab.click` | `infra.example.com`         |
| `CLUSTER_PUBLIC_IP`         | IP address that DNS records point to; `127.0.0.1` when DNS management is disabled      | Auto-detected   | `203.0.113.10`              |
| `LETSENCRYPT_EMAIL`         | Email for Let's Encrypt certificate issuance notifications                             | (none)          | `admin@example.com`         |
| `INGRESS_NGINX_ALLOWED_IPS` | Comma-separated CIDR ranges allowed to access the ingress controller                   | `0.0.0.0/0`     | `10.0.0.0/8,192.168.1.0/24` |

After bootstrap, you can change these by editing `clusters/<name>/cluster-sync.yaml` directly, committing, and pushing. Flux picks up the change on its next reconciliation cycle.

## SOPS Defaults

The `defaultSopsConfig()` function derives these paths from the environment:

| Setting          | Path                               |
|------------------|------------------------------------|
| Key directory    | `$SOPS_AGE_KEY_DIR` or `~/.sops`   |
| Key file         | `<keyDir>/age.agekey`              |
| Backup directory | `<keyDir>/backups`                 |
| SOPS config      | `<repoRoot>/.sops.yaml`            |
| K8s secret name  | `$SOPS_SECRET_NAME` or `sops-age`  |
| K8s namespace    | `$SOPS_NAMESPACE` or `flux-system` |

## Template upstream sync

After bootstrap, your repository is independent from the template: Flux only watches your Git remote. To pull improvements from the upstream template (security patches, chart bumps, new defaults), use a merge workflow or `gitops-ai template sync`. See [Template synchronization](template-sync.md) for merge order, validation parity with CI, and when changes need extra review.

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

1. Copy the component directory from `clusters/_template/components/<id>` to `clusters/<name>/components/<id>`
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
