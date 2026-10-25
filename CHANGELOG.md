# Changelog

All notable changes to the **gitops-ai** bootstrapper CLI are documented here. Versions follow [Semantic Versioning](https://semver.org/).

## 1.3.2

Includes everything from 1.3.1, which was unpublished from npm.

### Added

- **Cloudflare Tunnel network mode**: publish the cluster without a public IP.
  - Adds the opt-in `cloudflare-tunnel` component and one proxied `*.<domain>` CNAME instead of External DNS.
  - A one-time setup token (never saved) creates or reuses the tunnel `gitops-ai-<cluster>` and a Cloudflare Access app for `*.<domain>`. Access is created before DNS points at the tunnel.
  - Tunnel credentials are SOPS-encrypted; cloudflared also validates the Access JWT.
  - The Gateway allowlist is narrowed to the pod CIDR `10.42.0.0/16`.
- **GitHub Codespaces support** (detected via `CODESPACES=true`):
  - k3d instead of k3s, no browser logins, repo taken from `GITHUB_REPOSITORY`.
  - Tokens pre-filled from Codespaces secrets: `GITOPS_GIT_TOKEN`, `GITOPS_FLUX_GIT_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_SETUP_TOKEN`.
  - Cloudflare Tunnel is the default network mode; the final steps explain how to keep the age key as a Codespaces secret.
- **Cloudflare pre-flight check**: before anything is created, read-only API calls verify the zone, Zero Trust and every token permission. Each problem names what is missing; you can retry, enter a new token or exit.
- **Let's Encrypt staging**: optional under *Additional settings*.
- **Unit tests**: `npm run test:unit` (platform detection, components, cloudflared config, Cloudflare flow on a mocked API, workload exec).

### Changed

- **Secrets are always generated**: every selected component's secrets are rendered and SOPS-encrypted. Missing Cloudflare or OpenAI credentials become empty strings with a warning; bootstrap stops if any `${VAR}` placeholder is left.
- **OpenClaw gateway token**: a random 256-bit token is generated when none is given, so the gateway is never left without auth.
- Integration and template-upgrade tests skip `cloudflare-tunnel` (it needs a real Cloudflare account).

### Fixed

- **`cluster-components` broke on Flux 2.9**, which enables strict post-build substitution: unresolved `${VAR}` placeholders in secret templates are no longer committed.
- **Secret rendering**: placeholders are written as quoted YAML strings, so empty or special-character values no longer turn into `null` or invalid YAML; `$` in values is kept as is.
- **SOPS failure**: bootstrap now stops and deletes the plaintext file instead of leaving it to be committed.
- **`openclaw-codex-login` and `openclaw-pair` failed with 404** after the OpenClaw operator migration. They now target `StatefulSet openclaw-instance/openclaw-instance`, container `openclaw`, and print how to check a missing workload.
- **Codex login rejected on OpenClaw 2026.10** (`openai-codex` is a legacy provider id). It now runs `openclaw models auth login --provider openai --device-code`, which can be approved from any device; the browser callback to `localhost:1455` can't reach a pod.
- **CLI did not exit after interactive exec** (`openclaw-codex-login`, `pod-console`). The exec WebSocket and stdin listeners are now cleaned up when the session ends.

## 1.3.0

### Added

- **`gitops-ai pod-console` (`shell`)** — open an interactive shell in a pod (pick from the cluster or pass a pod name); optional namespace filtering.
- **`gitops-ai openclaw-codex-login`** — complete OpenAI Codex (ChatGPT subscription) OAuth inside the OpenClaw pod after bootstrap.
- **Kubernetes name validation** — cluster and related names are validated against Kubernetes naming rules during the wizard.
- **Template upgrade testing** — `npm run test:template-upgrade` and shared **flux-ci-helpers** for Flux-oriented tests; integration tests refactored to use the new helpers.

### Changed

- **Bootstrap runner and Kubernetes integration** — expanded `@kubernetes/client-node` usage in **k8s-api** and bootstrap flows to support pod exec and related operations without host `kubectl`/`helm`.
- **Bootstrap wizard** — updates to accommodate validation, OpenClaw commands, and revised final steps.
- **CI** — workflow updates for the new tests and commands (GitHub Actions and GitLab CI).

## 1.2.4

### Fixed

- **Cloudflare OAuth** — simplified and corrected the browser OAuth flow (leaner `cloudflare-oauth` implementation).
- **GitHub / GitLab OAuth** — small fixes aligned with the Cloudflare auth changes.
- **Final bootstrap command** — corrected the command printed at the end of the wizard.
- **Wizard copy** — clearer text and a smoother step order.

## 1.2.3

### Added

- **macOS container runtime** — the CLI will install Docker Desktop via Homebrew on MacOS when no compatible runtime is present (Docker, OrbStack, or Colima).

### Changed

- **Wizard** — optional Flux branch/template prompts live under **Additional settings** at the end (off by default); the CLI tools summary and installs run only when a tool is missing, with no extra noise for tools already present.

## 1.2.2

### Changed

- **Removed `helm` and `kubectl` as dependencies** — bootstrap and cluster checks use `@kubernetes/client-node` instead of requiring those binaries on the host.

## 1.2.1

### Changed

- **Upstream template** — the canonical GitOps template repository now lives on GitHub (`GitOpsAI/gitops-ai-template`).

## 1.2.0

### Added

- **`gitops-ai template sync`** — interactive TUI wizard to fetch the upstream template remote, preview a diff, and merge a tag or branch; `--dry-run` fetches and prints a diff stat without merging
- **Network access mode selector** — choose between Public and Local only; public mode auto-detects your IP and offers ingress restriction; local mode detects LAN interfaces and presents them as options
- **LAN IP auto-detection** — the wizard reads `os.networkInterfaces()` and lists non-internal IPv4 addresses when "Local only" is selected
- **Public IP auto-detection** — silently probes `ifconfig.me`, `api.ipify.org`, `icanhazip.com` in the background and pre-fills the result
- **CI pipeline** — `typecheck` and `test-template-sync` jobs run on MRs and `main`
- **[docs/template-sync.md](docs/template-sync.md)** — upstream merge workflow and CLI options
- **[docs/scaling.md](docs/scaling.md)** — adding worker and control-plane nodes to a k3s cluster, with links to official k3s docs

### Changed

- **Browser prompts** — replaced automatic browser opening with "Press Enter to open browser…" for OAuth and API key flows
- **Default components** — Monitoring Stack and other optional components are now pre-selected on fresh runs
- **Prerequisites docs** — streamlined to list only what users must prepare; auto-installed tools removed
- **Network docs** — updated bootstrap walkthrough to document the new Public / Local access modes and `/etc/hosts` logic
- **Template paths** — `gitops-ai template sync` and bootstrap expect `clusters/_template/` and category directories under `templates/`; support for legacy `clusters/_default/` (and bootstrap/SOPS fallbacks) has been removed

## 1.1.0

### Added

- **GitHub support** — you can now choose between GitHub and GitLab as your Git provider during the wizard
- **Browser-based login** — authenticate with GitLab, GitHub, and Cloudflare directly from your browser instead of manually creating and pasting tokens
- **OpenAI key entry** — choose between opening the dashboard in the browser or pasting a key directly
- **Monitoring stack** — optional Grafana Operator + Victoria Metrics Stack available as a single "Monitoring Stack" toggle in the component selector
- **Template version picker** — when creating a new repo, choose which tagged version of the template to clone
- **Existing cluster detection** — warns you if a k3d or k3s cluster already exists before provisioning, with the option to continue or abort
- **SSH deploy keys for GitHub** — when using a short-lived GitHub OAuth token, an SSH deploy key is created automatically so Flux access never expires
- **Repo and namespace discovery** — the wizard auto-detects your username, lists your orgs/groups, and shows existing repositories for selection

### Changed

- **No more `glab` or `jq`** — all GitLab interactions now use the REST API directly; fewer CLI tools to install
- **Improved post-bootstrap summary** — shows Grafana and Victoria Metrics URLs when monitoring is enabled; suggests installing k9s if not already present
- **Live status during Flux startup** — the spinner shows pod readiness while waiting for Flux controllers to come up

## 1.0.0

### Added

- **Initial `gitops-ai` CLI** — interactive TUI for bootstrapping Flux-based GitOps on Kubernetes (k3d/k3s-oriented flows).
