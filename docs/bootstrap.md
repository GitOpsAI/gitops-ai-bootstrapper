# Bootstrap Walkthrough

This document describes what happens when you run `npx gitops-ai bootstrap`, step by step.

## Overview

The bootstrap is a fully interactive process. A step-by-step wizard collects configuration, then the CLI automates cluster creation, Flux installation, secret encryption, and initial reconciliation. The entire process takes roughly 5-10 minutes depending on network speed.

## Interactive Wizard

The wizard walks through six sections. You can press **Escape** to go back to the previous step, or **Ctrl+C** to cancel entirely.

### 1. Setup Mode

Choose between two paths:

- **Init a new gitops repo** -- the CLI clones the [template repository](https://gitlab.com/everythings-gonna-be-alright/fluxcd_ai_template), creates a new GitLab project under your namespace, and pushes the template as your starting point.
- **I already have a repo** -- use an existing GitOps repository (e.g. one you previously bootstrapped or cloned manually).

### 2. GitLab Authentication

Two options for authenticating with GitLab:

- **Login with browser** (recommended) -- opens GitLab in your browser for OAuth2 authorization. Uses the standard Authorization Code flow with PKCE, exactly like Vercel's GitLab integration. After you click "Authorize", the token is received automatically — no copy-pasting required. The CLI then auto-detects your username and lists your namespaces and repositories.
- **Paste a Personal Access Token** -- manual fallback for environments without a browser (CI, SSH). Requires a token with `api`, `read_repository`, and `write_repository` scopes.

After authentication, a **Project Access Token** (`flux-gitops`) is automatically created for the selected repository via the GitLab API. This token is scoped to `read_repository` + `write_repository` with Developer access and expires in 1 year. It replaces the short-lived OAuth session token for all downstream operations (git push, Flux K8s secret), so Flux credentials remain valid long after the bootstrap completes.

### 3. GitLab Repository

- **Repo owner / namespace** -- auto-detected from your GitLab account. Shows your personal namespace and any groups you have access to. You can also enter a namespace manually.
- **Repo name** -- name for the new or existing project (default: `fluxcd_ai`). In "existing repo" mode, lists your repositories for selection.
- **Local clone path** -- where to clone the repo on disk (new repo mode only).
- **Branch** -- the Git branch Flux will track (default: `main`).

### 4. DNS & TLS

A yes/no prompt:

- **Yes** -- enables Cert Manager (automatic Let's Encrypt TLS) and External DNS (automatic Cloudflare DNS records). Requires a Cloudflare API token.
- **No** -- skips DNS automation. Services are accessible via IP and you manage DNS/TLS manually. The CLI offers to add entries to `/etc/hosts` at the end.

### 5. Components

A multi-select menu for optional components. Required components (Helm Repositories, Ingress Nginx, Prometheus CRDs) are always included. You can toggle:

- **Grafana Operator** -- Grafana dashboards and datasources managed via Kubernetes CRDs
- **Victoria Metrics Stack** -- Prometheus-compatible metrics collection, alerting, and long-term storage
- **Flux Web UI** -- web dashboard showing Flux reconciliation status
- **OpenClaw** -- AI assistant gateway (requires an OpenAI API key)

DNS/TLS components (Cert Manager, External DNS) are added automatically based on your choice in step 3.

### 6. Cluster

- **Cluster name** -- a human-readable name (default: `homelab`). Used as the k3d/k3s cluster name and the directory name under `clusters/`.
- **Cluster domain** -- the DNS domain for your services (e.g. `homelab.click`). Components with subdomains will be accessible at `<subdomain>.<domain>`.

### 7. Credentials & Secrets

Prompted conditionally based on your selections:

- **Let's Encrypt email** -- shown if DNS/TLS is enabled. Used for certificate issuance notifications.
- **Cloudflare API Token** -- shown if DNS/TLS is enabled. Encrypted with SOPS before commit.
- **OpenAI API Key** -- shown if OpenClaw is selected. Encrypted with SOPS before commit.

### 8. Network

- **Allowed IPs** -- CIDR ranges allowed to access the ingress controller (default: `0.0.0.0/0`).
- **Cluster public IP** -- the IP that DNS records point to. Auto-detected via `ifconfig.me` for public setups; defaults to `127.0.0.1` when DNS management is disabled.

### Review and Confirm

After all steps, the wizard displays a summary table of your choices. You can go back and edit any field before confirming.

## What Happens After the Wizard

Once you confirm, the bootstrap proceeds through these automated phases:

### Phase 1: Repository Setup (new repo mode)

1. Authenticates with GitLab via API (OAuth or PAT)
2. Resolves the target namespace ID
3. Creates a new GitLab project (or reuses an existing one)
4. Creates a Project Access Token (`flux-gitops`) for long-lived Flux access
5. Clones the template repository locally
6. Sets `origin` to your new project and pushes

### Phase 2: Dependencies

Installs missing CLI tools automatically:

| Tool | macOS | Linux |
|------|-------|-------|
| `kubectl` | Homebrew | apt / curl |
| `helm` | Homebrew | install script |
| `k9s` | Homebrew | curl |
| `flux-operator` | Homebrew | curl |
| `k3d` | Homebrew | curl (macOS and CI only) |
| `git` | Homebrew | apt |
| `sops`, `age` | Homebrew | apt / curl |

### Phase 3: Kubernetes Cluster

- **macOS / CI**: creates a k3d cluster (Kubernetes in Docker)
- **Linux**: installs k3s (lightweight Kubernetes)

Sets up kubeconfig and waits for the cluster to become ready.

### Phase 4: Flux Operator

Installs the Flux Operator via its OCI Helm chart into the `flux-system` namespace. Creates a Kubernetes secret with the Project Access Token so Flux can pull from your private repo. Since this token is scoped to the specific project with a 1-year expiry, Flux retains access long after the bootstrap session ends.

### Phase 5: Cluster Template

1. Copies `clusters/_default-template` to `clusters/<your-cluster-name>`
2. Renders `cluster-sync.yaml` with your cluster variables (name, domain, IP, email, allowed IPs)
3. Removes directories for disabled components
4. Updates `kustomization.yaml` to exclude disabled components

### Phase 6: SOPS Encryption

1. Generates an age encryption key (or reuses existing) at `~/.sops/age.agekey`
2. Creates `.sops.yaml` configuration in the repo root
3. Stores the age key as a Kubernetes secret for Flux's decryptor
4. Encrypts secret templates (Cloudflare token, OpenAI key) in-place

### Phase 7: Git Push

Commits all changes (cluster config + encrypted secrets) and pushes to your GitLab repo.

### Phase 8: Flux Instance

1. Installs a Flux Instance CR pointing to your repo and branch
2. Waits for the instance to become ready
3. Triggers an initial reconciliation

### Phase 9: Post-Bootstrap

- If DNS management is disabled, offers to add `/etc/hosts` entries for components with subdomains (e.g. `127.0.0.1 flux.homelab.click`)
- Displays a summary with cluster details and next steps
- Cleans up the saved install plan

## Resume Capability

Configuration is saved to `/tmp/installplan.json` (mode `0600`) after the wizard completes. If the bootstrap fails partway through, re-running `npx gitops-ai bootstrap` detects the saved plan and offers to resume with your previous inputs pre-filled.

The plan file is automatically deleted on successful completion.

## OpenClaw Device Pairing

After bootstrap, if OpenClaw is installed, pair a device with:

```bash
npx gitops-ai openclaw-pair
```

This connects to the OpenClaw deployment via `kubectl exec`, lists pending device pairing requests, and lets you approve one by entering its request ID.
