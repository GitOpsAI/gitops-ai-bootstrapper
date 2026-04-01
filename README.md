# FluxCD AI

GitOps-managed Kubernetes infrastructure for AI homelabs powered by the [Flux Operator](https://fluxoperator.dev/) and [Flux CD](https://fluxcd.io/). A single bootstrap script provisions a Kubernetes cluster, installs all infrastructure components, and enables continuous delivery from Git.

## Why GitOps for your homelab

**💾 Infrastructure as Code** -- your entire cluster is defined in Git. Every change is versioned, reviewable, and reversible. You can modify infrastructure with AI coding assistants (Cursor, Copilot, Claude) that understand YAML and Helm values -- describe what you want in natural language and commit the result.

**🔒 Security by default** -- containers run as non-root with read-only filesystems and dropped capabilities. Network policies isolate workloads so pods can only communicate with explicitly allowed services. Secrets are encrypted at rest with SOPS/Age before they ever reach Git. SSL certificates are automatically managed by cert-manager.

**🔄 Reproducible deployments** -- the same bootstrap script produces an identical cluster every time, on any supported machine. Drift is automatically corrected by Flux reconciliation -- if someone manually changes a resource, Flux reverts it to match Git within minutes.

**💪🏻 Scalable and flexible** -- powered by Kubernetes, you can add worker nodes to grow capacity or drop in new components like Lego blocks. Need a database, a message queue, or another AI model? Add a HelmRelease to the repo and push -- Flux deploys it automatically. Your homelab grows with your needs without re-architecting anything.

## Requirements

| Resource   | Minimum                |
|------------|------------------------|
| **CPU**    | 2+ cores               |
| **Memory** | 4+ GB                  |
| **Disk**   | 20+ GB free            |
| **OS**     | Ubuntu 25.04+ or macOS |

You will also need a [GitLab PAT](docs/prerequisites.md#1-gitlab-personal-access-token), a [Cloudflare API Token](docs/prerequisites.md#2-cloudflare-api-token), and an [OpenAI API Key](docs/prerequisites.md#3-openai-api-key). See [Prerequisites](docs/prerequisites.md) for details.

### 4. Docker runtime (macOS only)

macOS requires a Docker-compatible runtime for k3d. Install one of:

SSH into your server (or run locally on macOS) and run:

```bash
curl -sfL https://gitlab.com/everythings-gonna-be-alright/fluxcd_ai_template/-/raw/main/scripts/install.sh | bash
```

This will interactively prompt for your GitLab PAT, fork the template into your namespace, and run the full bootstrap.

### Manual setup

```bash
git clone <your-gitlab-repo-url>
cd <repo-name>
bash scripts/bootstrap.sh
```

The script prompts for all required values (cluster name, domain, tokens, etc.) and can be fully automated via environment variables. See [Bootstrap](docs/bootstrap.md) for the full list of prompts and what each step does.

## Documentation

| Document | Description |
|----------|-------------|
| [Prerequisites](docs/prerequisites.md) | API tokens, Docker runtime, network and IP requirements |
| [Bootstrap](docs/bootstrap.md) | What the bootstrap does, configuration prompts, device pairing |
| [Architecture](docs/architecture.md) | Repository structure, how Flux Operator works, GitOps workflow |
| [Configuration](docs/configuration.md) | Cluster variables, post-bootstrap changes, security notes |

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the LICENSE file for details.
