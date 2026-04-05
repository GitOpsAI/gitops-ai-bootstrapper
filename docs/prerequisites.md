# Prerequisites

The bootstrap installs **git**, **flux-operator**, **sops**, **age**, **Docker Desktop** (macOS only, for k3d), and **k3d** (macOS / CI) or provisions **k3s** (Linux). The CLI talks to the Kubernetes API using **@kubernetes/client-node** (no `kubectl` binary required). **Flux** (operator + controllers) is installed into the cluster with **`flux-operator install`** during bootstrap. **Helm** is not required for that step; you may still use Helm charts inside your Flux repo via **helm-controller**. **kubectl** and **k9s** are optional for interactive debugging; the post-bootstrap summary may suggest installing them if they are not found.

You should prepare the items below before running the wizard.

## Required

### Node.js 18+

Required to run the CLI. Check with `node -v`.

- **macOS**: `brew install node`
- **Linux**: [nodesource.com/distributions](https://github.com/nodesource/distributions#installation-instructions)
- If you use `npx gitops-ai`, Node.js is already present.

### Docker runtime (macOS only)

macOS uses [k3d](https://k3d.io/) to run Kubernetes inside Docker. During `npx gitops-ai bootstrap`, the CLI installs Docker Desktop via Homebrew only if no Docker-compatible runtime is already present (Docker CLI, Docker Desktop, OrbStack, or Colima). It then starts Docker Desktop or OrbStack if needed and waits until the daemon responds to `docker info`. For a manual GUI install instead, see [Install Docker Desktop on Mac](https://docs.docker.com/desktop/setup/install/mac-install/).

| Runtime                                                           | Install                               |
|-------------------------------------------------------------------|---------------------------------------|
| [OrbStack](https://orbstack.dev/)                                 | `brew install --cask orbstack`        |
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) | `brew install --cask docker`          |
| [Colima](https://github.com/abiosoft/colima)                      | `brew install colima && colima start` |

On **Linux**, the CLI installs [k3s](https://k3s.io/) natively -- no Docker required.

### Git provider account

A **GitHub** or **GitLab** account. The wizard handles authentication interactively via browser OAuth -- no tokens to create in advance.

For headless environments (CI, SSH) where a browser is not available, create a Personal Access Token:

<details>
<summary>GitHub PAT scopes</summary>

- `repo` -- full repository access (clone, push, deploy keys)

Create at **Settings > Developer settings > Personal access tokens > Fine-grained tokens** ([github.com/settings/tokens](https://github.com/settings/tokens))
</details>

<details>
<summary>GitLab PAT scopes</summary>

- `api` -- create projects, manage CI/CD variables
- `read_repository` -- clone the template
- `write_repository` -- push cluster configuration

Create at **User Settings > Access Tokens** ([gitlab.com/-/user_settings/personal_access_tokens](https://gitlab.com/-/user_settings/personal_access_tokens))
</details>

## Optional (only if you enable the feature)

### Cloudflare account

**When:** you choose to enable automatic DNS and TLS management during the wizard.

**Used by:** cert-manager (Let's Encrypt DNS-01 challenges) and external-dns (automatic DNS records).

The wizard offers **browser login** that auto-creates a scoped Cloudflare DNS token -- no manual setup. If you prefer a manual token, create one at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) with `Zone > DNS > Edit` permission scoped to your domain.

The token is encrypted with SOPS/Age before being committed to Git.

### OpenAI API key

**When:** you select the OpenClaw component during the wizard.

The wizard can open the [OpenAI dashboard](https://platform.openai.com/api-keys) for you to create a key, or you can paste an existing one (starts with `sk-`).

The key is encrypted with SOPS/Age before being committed to Git.

## Network

### Public-facing cluster (DNS/TLS enabled)

- Ports **80** (HTTP) and **443** (HTTPS) must be reachable from the internet
- The domain must be managed by Cloudflare
- The public IP you provide must route to the server

### Local / homelab cluster

- No inbound ports required
- The CLI offers to add entries to `/etc/hosts` for local name resolution
- Services are accessible via the cluster IP on ports 80/443
