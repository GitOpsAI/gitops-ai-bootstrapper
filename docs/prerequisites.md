# Prerequisites

Before running the bootstrap, ensure your environment meets the runtime requirements below. Most credentials are collected interactively during the wizard -- you only need to prepare them in advance if using the manual PAT option.

## 1. Git Provider Account

You need an account on **GitHub** or **GitLab** (the wizard lets you choose). The recommended authentication method is **browser login** -- the CLI opens your provider in a browser for OAuth authorization, auto-detects your username, and lists your namespaces.

### Browser login (recommended)

No preparation needed. The CLI handles everything:

- **GitHub** -- uses the Device Authorization flow. You enter a short code at `github.com/login/device` and authorize the app.
- **GitLab** -- uses the Authorization Code flow with PKCE. After you click "Authorize", the token is received automatically.

### Manual Personal Access Token (fallback)

For environments without a browser (CI, SSH), create a PAT with the following scopes:

**GitHub:**

- `repo` -- full repository access (clone, push, deploy keys)

**GitLab:**

- `api` -- create projects, manage CI/CD variables
- `read_repository` -- clone the template repository
- `write_repository` -- push cluster configuration and encrypted secrets

**How to create one:**

- **GitHub**: go to **Settings > Developer settings > Personal access tokens > Fine-grained tokens** (`github.com/settings/tokens`)
- **GitLab**: go to **User Settings > Access Tokens** (`gitlab.com/-/user_settings/personal_access_tokens`)

The bootstrap wizard prompts for the PAT as a masked password field. It is saved locally in `/tmp/installplan.json` (mode `0600`) during the run and deleted on completion.

## 2. Cloudflare API Token

**Only required if you enable automatic DNS and TLS management** during the wizard. If you skip DNS/TLS, the bootstrap runs without it.

The token is used by:
- **cert-manager** -- to solve DNS-01 challenges for Let's Encrypt TLS certificates
- **external-dns** -- to create/update DNS A records pointing to your cluster IP

### Browser login (recommended)

The wizard offers a **"Login with browser"** option that opens Cloudflare for OAuth authorization and auto-creates a scoped DNS token for your domain. No manual setup needed.

### Manual API token (fallback)

**Required permissions:**

- Zone > DNS > Edit (for your domain's zone)

**How to create one:**

1. Go to **Cloudflare > My Profile > API Tokens** (`dash.cloudflare.com/profile/api-tokens`)
2. Click **Create Token**
3. Use the **Edit zone DNS** template, or create a custom token with `Zone:DNS:Edit` permission
4. Scope it to the specific zone (domain) you plan to use
5. Click **Continue to summary > Create Token** and copy it

The token is encrypted with SOPS/Age and stored as a Kubernetes Secret -- it never appears in plaintext in Git.

## 3. OpenAI API Key

**Only required if you select the OpenClaw component** during the wizard. If you skip OpenClaw, no API key is needed.

The wizard can open the OpenAI dashboard in your browser to help you create a key, or you can paste an existing one.

**How to get one manually:**

1. Go to **OpenAI > API Keys** (`platform.openai.com/api-keys`)
2. Click **Create new secret key**
3. Copy the key (starts with `sk-`, shown only once)

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

- The bootstrap suggests adding entries to `/etc/hosts` for local resolution (requires `sudo`)
- Services are accessible via the cluster IP on port 80/443
