# Bootstrap Walkthrough

This document describes what happens when you run `npx gitops-ai bootstrap`, step by step.

## Overview

The bootstrap is a fully interactive process. A step-by-step wizard collects configuration, then the CLI automates cluster creation, Flux installation, secret encryption, and initial reconciliation. The entire process takes roughly 5-10 minutes depending on network speed.

## Interactive Wizard

The wizard walks through several sections. You can press **Escape** to go back to the previous step, or **Ctrl+C** to cancel entirely.

### 1. Setup Mode

Choose between two paths:

- **Init a new gitops repo** -- the CLI clones the [template repository](https://gitlab.com/everythings-gonna-be-alright/fluxcd_ai_template), creates a new project under your namespace, and pushes the template as your starting point.
- **I already have a repo** -- use an existing GitOps repository (e.g. one you previously bootstrapped or cloned manually).

### 2. Git Provider

Choose your Git hosting platform:

- **GitHub** -- github.com or GitHub Enterprise
- **GitLab** -- gitlab.com or self-hosted

### 3. Authentication

Two options for authenticating with your Git provider:

- **Login with browser** (recommended) -- opens GitHub or GitLab in your browser for OAuth authorization. After you click "Authorize", the token is received automatically -- no copy-pasting required. The CLI then auto-detects your username and lists your namespaces and repositories.
- **Paste a Personal Access Token** -- manual fallback for environments without a browser (CI, SSH).

**How Flux gets long-lived Git access:**

- **GitHub with browser login** -- since the OAuth token is short-lived, the CLI automatically creates an SSH **deploy key** on the repository for Flux. Deploy keys never expire, so Flux retains access permanently.
- **GitLab / manual PAT** -- the token you provide (or the OAuth token) is stored as a Kubernetes secret for Flux to pull from Git.

### 4. Git Repository

- **Namespace / owner** -- auto-detected from your account. Shows your personal namespace and any organizations or groups you have access to. You can also enter a namespace manually.
- **Repo name** -- name for the new or existing project (default: `fluxcd_ai`). In "existing repo" mode, lists your repositories for selection.
- **Local path** -- where to clone the repo on disk (new repo mode), or the path to your existing local checkout (existing repo mode). In existing repo mode, the CLI validates that the directory exists and is a Git repository.
- **Branch** -- the Git branch Flux will track (default: `main`).
- **Template version** -- (new repo mode only) select a tagged release of the template to clone, or enter a branch name manually.

### 5. DNS & TLS

A yes/no prompt:

- **Yes** -- enables Cert Manager (automatic Let's Encrypt TLS) and External DNS (automatic Cloudflare DNS records). Requires a Cloudflare API token.
- **No** -- skips DNS automation. Services are accessible via IP and you manage DNS/TLS manually. The CLI offers to add entries to `/etc/hosts` at the end.

### 6. Components

A multi-select menu for optional components. Required components (Helm Repositories, Ingress Nginx, Prometheus CRDs) are always included. You can toggle:

- **Monitoring Stack** -- Victoria Metrics + Grafana Operator bundled together (metrics collection, alerting, dashboards)
- **Flux Web UI** -- web dashboard showing Flux reconciliation status
- **OpenClaw** -- AI assistant gateway (requires an OpenAI API key)

DNS/TLS components (Cert Manager, External DNS) are added automatically based on your choice in step 5.

### 7. Cluster

- **Cluster name** -- a human-readable name (default: `homelab`). Used as the k3d/k3s cluster name and the directory name under `clusters/`.
- **Cluster domain** -- the DNS domain for your services (e.g. `homelab.click`). Components with subdomains will be accessible at `<subdomain>.<domain>`.

### 8. Credentials & Secrets

Prompted conditionally based on your selections:

- **Let's Encrypt email** -- shown if DNS/TLS is enabled. Used for certificate issuance notifications.
- **Cloudflare API Token** -- shown if DNS/TLS is enabled. You can authenticate via browser (OAuth login that auto-creates a scoped DNS token) or paste a token manually. Encrypted with SOPS before commit.
- **OpenAI API Key** -- shown if OpenClaw is selected. The CLI can open the OpenAI dashboard in your browser for key creation, or you can paste an existing key. Encrypted with SOPS before commit.

### 9. Network

The wizard asks **"How will you access the cluster?"** and adapts the remaining prompts based on your answer.

#### Public

1. **Public IP detection** -- the CLI silently probes `ifconfig.me`, `api.ipify.org`, and `icanhazip.com` in the background (started when the wizard opens). The detected IP is pre-filled in the next prompt; you can accept it or type a different one.
2. **Restrict ingress access?**
   - *Open to everyone* -- sets the ingress allowlist to `0.0.0.0/0` (any source IP can reach the cluster).
   - *Restrict to specific IPs* -- prompts for one or more CIDRs (comma-separated, e.g. `203.0.113.0/24,198.51.100.5/32`). Only those ranges will be allowed through ingress.

#### Local only (localhost / LAN)

1. **Cluster IP** -- the CLI detects non-internal IPv4 addresses from your network interfaces and presents them as options (with the interface name as a hint). The list always includes `127.0.0.1 (localhost)` and an *Enter manually* fallback. If no LAN interfaces are found, a free-text input defaults to `127.0.0.1`.
2. **Allowed CIDRs** -- defaults to the standard RFC 1918 private ranges (`10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16`). You can accept or customise.

All network values are written into `clusters/<name>/cluster-sync.yaml` and can be changed later via a Git commit.

### Review and Confirm

After all steps, the wizard displays a summary table of your choices. You can go back and edit any section before confirming.

## What Happens After the Wizard

Once you confirm, the bootstrap proceeds through these automated phases:

### Phase 1: Repository Setup (new repo mode)

1. Authenticates with your Git provider via API
2. Resolves the target namespace ID
3. Creates a new project (or reuses an existing one)
4. Clones the template repository locally
5. Sets `origin` to your new project and pushes

### Phase 2: Dependencies

Installs missing CLI tools automatically:

| Tool            | macOS    | Linux                    |
|-----------------|----------|--------------------------|
| `git`           | Homebrew | apt                      |
| `kubectl`       | Homebrew | apt / curl               |
| `helm`          | Homebrew | install script           |
| `flux-operator` | Homebrew | curl                     |
| `sops`, `age`   | Homebrew | apt / curl               |
| `k3d`           | Homebrew | curl (macOS and CI only) |

### Phase 3: Kubernetes Cluster

- **macOS / CI**: creates a k3d cluster (Kubernetes in Docker)
- **Linux**: installs k3s (lightweight Kubernetes). After bootstrap, you can add more nodes to scale horizontally -- see [Scaling the Cluster](scaling.md).

Sets up kubeconfig and waits for the cluster to become ready.

### Phase 4: Flux Operator

Installs the Flux Operator via its OCI Helm chart into the `flux-system` namespace.

Git authentication for Flux depends on your provider and login method:

- **GitHub + browser OAuth** -- creates an SSH deploy key on the repository and stores it as a Kubernetes secret. Deploy keys never expire.
- **GitLab / manual PAT** -- stores the token as a Kubernetes secret so Flux can pull from your private repo.

### Phase 5: Cluster Template

1. Copies `clusters/_template` to `clusters/<your-cluster-name>`
2. Renders `cluster-sync.yaml` with your cluster variables (name, domain, IP, email, allowed IPs)
3. Removes directories for disabled components
4. Updates `kustomization.yaml` to exclude disabled components
5. Writes `template-sync-metadata.yaml` coordinates so `gitops-ai template sync` knows which upstream to track

### Phase 6: SOPS Encryption

1. Generates an age encryption key (or reuses existing) at `~/.sops/age.agekey`
2. Creates `.sops.yaml` configuration in the repo root
3. Stores the age key as a Kubernetes secret for Flux's decryptor
4. Encrypts secret templates (Cloudflare token, OpenAI key) in-place

### Phase 7: Git Push

Commits all changes (cluster config + encrypted secrets) and pushes to your Git repository.

### Phase 8: Flux Instance

1. Installs a Flux Instance CR pointing to your repo and branch
2. Waits for the instance to become ready
3. Triggers an initial reconciliation

### Phase 9: Post-Bootstrap

- **`/etc/hosts` suggestion** -- shown when the cluster IP is a local/private address (127.x, 10.x, 172.16-31.x, 192.168.x) **or** when automatic DNS management is disabled. The CLI lists all component subdomains (e.g. `192.168.1.50 flux.homelab.click`) and offers to append them to `/etc/hosts` in one step. This requires `sudo` -- macOS will prompt for your system password.
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
