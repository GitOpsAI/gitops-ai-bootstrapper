# GitOps AI - Bootstrapper

[![Website](https://img.shields.io/badge/website-gitops--ai.vercel.app-blue)](https://gitops-ai.vercel.app) [![Docs](https://img.shields.io/badge/docs-gitops--ai.vercel.app-orange)](https://gitops-ai.vercel.app/#docs/prerequisites)

GitOps-managed Kubernetes infrastructure for AI-powered applications powered by the [Flux Operator](https://fluxoperator.dev/) and [Flux CD](https://fluxcd.io/). A single bootstrap application provisions a Kubernetes cluster, installs all infrastructure components, and enables continuous delivery from Git.

## Why GitOps for your infrastructure

**💾 Infrastructure as Code** -- your entire cluster is defined in Git. Every change is versioned, reviewable, and reversible. You can modify infrastructure with AI coding assistants (Cursor, Copilot, Claude) that understand YAML and Helm values -- describe what you want in natural language and commit the result.

**🔒 Security by default** -- containers run as non-root with read-only filesystems and dropped capabilities. Network policies isolate workloads so pods can only communicate with explicitly allowed services. Secrets are encrypted at rest with SOPS/Age before they ever reach Git. SSL certificates are automatically managed by cert-manager.

**🔄 Reproducible deployments** -- the same bootstrap script produces an identical cluster every time, on any supported machine. Drift is automatically corrected by Flux reconciliation -- if someone manually changes a resource, Flux reverts it to match Git within minutes.

**🔌 Scalable and flexible** -- powered by Kubernetes, you can add worker nodes to grow capacity or drop in new components like Lego blocks. Need a database, a message queue, or another AI model? Add a HelmRelease to the repo and push -- Flux deploys it automatically.

## Quick Start

On your Mac or Linux machine:

```bash
npx gitops-ai bootstrap
```

Or SSH into your server (or run locally on macOS) and run:

```bash
curl -sfL https://raw.githubusercontent.com/your-org/gitops-ai/main/install.sh | bash
```

Or, if you already have Node.js >= 18:

```bash
npx gitops-ai bootstrap
```

The interactive wizard will prompt for your Git provider (GitHub or GitLab), create or use a repository from the [GitOps AI Template](https://gitlab.com/everythings-gonna-be-alright/gitops_ai_template), and run the full bootstrap.

## Requirements

| Resource    | Minimum                                       |
|-------------|-----------------------------------------------|
| **CPU**     | 2+ cores                                      |
| **Memory**  | 4+ GB                                         |
| **Disk**    | 20+ GB free                                   |
| **OS**      | Ubuntu 25.04+ or macOS                        |
| **Node.js** | 18+ (installed automatically by `install.sh`) |

You will also need a [GitLab PAT](docs/prerequisites.md#1-gitlab-personal-access-token), a [Cloudflare API Token](docs/prerequisites.md#2-cloudflare-api-token) (if using automatic DNS/TLS), and an [OpenAI API Key](docs/prerequisites.md#3-openai-api-key) (if using OpenClaw). See [Prerequisites](docs/prerequisites.md) for full details.

### Docker runtime (macOS only)

macOS requires a Docker-compatible runtime for k3d. Install one of:

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- [OrbStack](https://orbstack.dev/)
- [Colima](https://github.com/abiosoft/colima)

On Linux the bootstrap installs k3s directly -- no Docker required.

## Template Repository

This CLI bootstraps clusters from the [GitOps AI Template](https://gitlab.com/everythings-gonna-be-alright/gitops_ai_template) -- a ready-made GitOps repository structure that Flux uses as the single source of truth for your cluster.

The template contains the declarative Kubernetes manifests, HelmRelease definitions, Kustomization overlays, and SOPS encryption configuration that define a complete infrastructure stack. When you run `npx gitops-ai bootstrap`, the CLI forks this template into your GitLab namespace, customises it with your cluster variables (domain, tokens, component selections), and points Flux at the resulting repository. From that moment on, every `git push` to the repo triggers Flux reconciliation -- your cluster converges to match whatever is declared in Git.

Keeping the template in a separate repository means:

- **Upstream updates** -- pull improvements, new components, and security patches from the upstream template without disrupting your running cluster.
- **Clean separation** -- the bootstrapper CLI handles provisioning logic; the template holds pure infrastructure declarations. Each can be versioned and tested independently.
- **Customisation without lock-in** -- after the fork you own the repo. Add namespaces, swap Helm charts, or restructure directories to fit your needs.

### Repository layout (template → your repo)

The upstream template (and your bootstrapped repo) is organised roughly as:

| Path                     | Role                                                                                                                                                                                        |
|--------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `templates/<category>/…` | Shared Helm bases and component manifests (e.g. `templates/system/`, `templates/ai/`, `templates/monitoring/`). |
| `clusters/_template/`    | Prototype cluster layout; the CLI copies this to `clusters/<your-cluster-name>/` during bootstrap.            |
| `clusters/<name>/`       | Your live cluster overlay (`cluster-sync.yaml`, `components/`, encrypted secrets).                                                                                                          |

See [Architecture](docs/architecture.md) for diagrams and a fuller tree.

## CLI Commands

The CLI provides these commands:

### `bootstrap` (alias: `install`)

Interactive wizard that provisions a complete Kubernetes cluster with Flux GitOps. Walks through repository setup, component selection, cluster creation, SOPS encryption, and Flux reconciliation.

```bash
npx gitops-ai bootstrap
```

See [Bootstrap](docs/bootstrap.md) for a detailed walkthrough.

### `sops [subcommand] [file]`

SOPS secret encryption management. Run without arguments for an interactive menu, or specify a subcommand directly:

```bash
npx gitops-ai sops [subcommand] [file]
```

| Subcommand       | Description                                                            |
|------------------|------------------------------------------------------------------------|
| `init`           | First-time setup: generate age key, create `.sops.yaml` and K8s secret |
| `encrypt`        | Encrypt all unencrypted secret files                                   |
| `encrypt <file>` | Encrypt a specific file                                                |
| `decrypt <file>` | Decrypt a file for viewing (re-encrypt before commit)                  |
| `edit <file>`    | Open encrypted file in `$EDITOR` (auto re-encrypts on save)            |
| `status`         | Show encryption status of all secret files                             |
| `import`         | Import an existing age key into a new cluster                          |
| `rotate`         | Rotate to a new age key and re-encrypt everything                      |

### `openclaw-pair`

Pair an OpenClaw device with the cluster after bootstrap:

```bash
npx gitops-ai openclaw-pair
```

### `template sync`

Fetch the upstream GitOps template and merge changes into your current branch. Run without flags for an **interactive wizard** (tag picker, diff preview with risk classification, merge/dry-run/cancel), or pass flags for non-interactive use:

```bash
npx gitops-ai template sync                        # interactive wizard
npx gitops-ai template sync --ref v1.0.0           # non-interactive merge
npx gitops-ai template sync --ref main --dry-run   # non-interactive preview
```

See [Template synchronization](docs/template-sync.md).

## Components

The bootstrap wizard lets you select which components to install:

| Component                   | Required | Description                                        |
|-----------------------------|----------|----------------------------------------------------|
| Helm Repositories           | Yes      | Shared Helm chart repos                            |
| Ingress Nginx (external)    | Yes      | External HTTP/HTTPS ingress controller             |
| Prometheus CRDs             | Yes      | Monitoring custom resource definitions             |
| Cert Manager                | DNS/TLS  | Automatic TLS certificates via Let's Encrypt       |
| External DNS                | DNS/TLS  | Automatic DNS records in Cloudflare                |
| Grafana Operator            | No       | Grafana dashboards and datasources via CRDs        |
| Victoria Metrics Stack      | No       | Metrics collection, alerting and long-term storage |
| Flux Web UI                 | No       | Web dashboard for Flux status                      |
| OpenClaw                    | No       | AI assistant gateway (requires OpenAI key)         |

Components marked **DNS/TLS** are automatically enabled when you opt into automatic DNS and TLS management during the wizard.

## Documentation

| Document                                          | Description                                                         |
|---------------------------------------------------|---------------------------------------------------------------------|
| [Prerequisites](docs/prerequisites.md)            | Node.js, Docker (macOS), Git provider, optional Cloudflare / OpenAI |
| [Bootstrap](docs/bootstrap.md)                    | What the bootstrap does, wizard walkthrough, resume capability      |
| [Architecture](docs/architecture.md)              | Repositories, bootstrap flow, Flux Operator & Instance, repo tree   |
| [Configuration](docs/configuration.md)            | Cluster variables, SOPS defaults, post-bootstrap changes            |
| [Template synchronization](docs/template-sync.md) | Upstream merges, `template sync`, CI parity, risk tiers             |
| [Scaling](docs/scaling.md)                        | Adding k3s worker and server nodes (Linux)                          |
| [Security](docs/security.md)                      | SOPS, Git auth, hardening, network                                  |

## Development

```bash
git clone https://gitlab.com/everythings-gonna-be-alright/gitops_ai_bootstrapper.git
cd gitops_ai_bootstrapper
npm install

npm run dev              # Run CLI locally via tsx
npm run build            # Compile TypeScript to dist/
npm run typecheck        # Type-check without emitting
npm run test:sync        # Unit tests for template sync logic
npm run test:integration # Full k3d + Flux integration test (requires Docker)
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the LICENSE file for details.
