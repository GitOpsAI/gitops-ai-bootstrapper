# Prerequisites

Before running the bootstrap, gather the following credentials and ensure your environment meets the runtime requirements.

## 1. GitLab Personal Access Token

The CLI uses a GitLab PAT to create/clone the GitOps repository and configure Flux to pull from it.

**Required scopes:**

- `api` -- create projects, manage CI/CD variables
- `read_repository` -- clone the template repository
- `write_repository` -- push cluster configuration and encrypted secrets

**How to create one:**

1. Go to **GitLab > User Settings > Access Tokens** (or `https://gitlab.com/-/user_settings/personal_access_tokens`)
2. Name it something descriptive (e.g. `fluxcd-ai-bootstrap`)
3. Select the three scopes above
4. Set an expiration date (the token is stored as a Kubernetes secret for Flux to pull from Git)
5. Click **Create personal access token** and copy it immediately

The bootstrap wizard prompts for the PAT as a masked password field. It is saved locally in `/tmp/installplan.json` (mode `0600`) during the run and deleted on completion.

## 2. Cloudflare API Token

**Only required if you enable automatic DNS and TLS management** during the wizard. If you skip DNS/TLS, the bootstrap runs without it.

The token is used by:
- **cert-manager** -- to solve DNS-01 challenges for Let's Encrypt TLS certificates
- **external-dns** -- to create/update DNS A records pointing to your cluster IP

**Required permissions:**

- Zone > DNS > Edit (for your domain's zone)

**How to create one:**

1. Go to **Cloudflare > My Profile > API Tokens** (or `https://dash.cloudflare.com/profile/api-tokens`)
2. Click **Create Token**
3. Use the **Edit zone DNS** template, or create a custom token with `Zone:DNS:Edit` permission
4. Scope it to the specific zone (domain) you plan to use
5. Click **Continue to summary > Create Token** and copy it

The token is encrypted with SOPS/Age and stored as a Kubernetes Secret -- it never appears in plaintext in Git.

## 3. OpenAI API Key

**Only required if you select the OpenClaw component** during the wizard. If you skip OpenClaw, no API key is needed.

**How to get one:**

1. Go to **OpenAI > API Keys** (`https://platform.openai.com/api-keys`)
2. Click **Create new secret key**
3. Copy the key

Like the Cloudflare token, the OpenAI key is encrypted with SOPS before being committed.

## 4. Docker Runtime (macOS only)

macOS uses [k3d](https://k3d.io/) to run a Kubernetes cluster inside Docker containers. You need a Docker-compatible runtime installed and running:

| Runtime | Install |
|---------|---------|
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) | `brew install --cask docker` |
| [OrbStack](https://orbstack.dev/) | `brew install --cask orbstack` |
| [Colima](https://github.com/abiosoft/colima) | `brew install colima && colima start` |

On **Linux**, the bootstrap installs [k3s](https://k3s.io/) natively -- no Docker required.

## 5. Node.js

Node.js 18 or later is required to run the CLI. If you use `install.sh`, it is installed automatically:

- **macOS**: via Homebrew (`brew install node`)
- **Linux**: via NodeSource (`setup_20.x`)

## 6. Network Requirements

For a production-facing cluster with DNS and TLS:

- The server must be reachable on **port 80** (HTTP, for Let's Encrypt challenges) and **port 443** (HTTPS, for ingress traffic)
- The domain you configure must be managed by Cloudflare (so external-dns can create records)
- The public IP you provide during the wizard must route to the server

For local/homelab use without DNS management:

- The bootstrap suggests adding entries to `/etc/hosts` for local resolution
- Services are accessible via the cluster IP on port 80/443
