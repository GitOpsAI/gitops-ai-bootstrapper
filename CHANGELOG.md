# Changelog

All notable changes to the **gitops-ai** bootstrapper CLI are documented here. Versions follow [Semantic Versioning](https://semver.org/).

## 1.4.0

### Added

- **Cloudflare Tunnel network mode** — publish the cluster without a public IP. The wizard adds the opt-in `cloudflare-tunnel` template component (inserted into `components/kustomization.yaml` only when selected) and replaces External DNS with a single proxied `*.<domain>` CNAME to the tunnel. A one-time setup token (never persisted) creates or reuses the locally-managed tunnel `gitops-ai-<cluster>`, the Cloudflare Access application for `*.<domain>` (email / `@domain` allow policy, created before DNS points at the tunnel) and the wildcard record. Tunnel credentials are derived from the tunnel token on every run and SOPS-encrypted; the cloudflared config carries the Access team and AUD so the connector also validates the Access JWT. The Gateway allowlist is narrowed to the pod CIDR `10.42.0.0/16`.
- **GitHub Codespaces support** — `CODESPACES=true` is detected: k3d instead of k3s (no systemd in the container), no browser-based logins, repo owner/name/path from `GITHUB_REPOSITORY`, tokens pre-filled from Codespaces secrets (`GITOPS_GIT_TOKEN`, `GITOPS_FLUX_GIT_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_SETUP_TOKEN`), and Cloudflare Tunnel as the default network mode. The final steps explain how to keep the age key as a Codespaces secret.
- **Cloudflare pre-flight check** — in tunnel mode, read-only API calls verify the zone, that Zero Trust is enabled and each setup token permission right after the wizard, before anything is created. Problems name the missing permission (or an invalid token) and offer retry, a new token or exit.
- **Let's Encrypt staging** — optional under *Additional settings*; writes `letsencrypt_server` to `cluster-sync.yaml`.
- **Unit tests** — `npm run test:unit` covers platform detection, component pruning / opt-in insertion, cloudflared config rendering and the Cloudflare provisioning flow against a mocked API.

### Changed

- Integration and template-upgrade tests exclude `cloudflare-tunnel` (it needs a real Cloudflare account).

## 1.3.1

### Changed

- **Secret generation** — secrets of every selected component are now always rendered and SOPS-encrypted; missing Cloudflare/OpenAI credentials render as empty strings with a warning, and bootstrap fails fast if any `${VAR}` placeholder remains.
- **OpenClaw gateway token** — a random 256-bit gateway token is generated when none is provided instead of leaving the gateway without an auth token.

### Fixed

- **Flux 2.9 strict post-build substitution** — kustomize-controller v1.9 enables `StrictPostBuildSubstitutions` by default, so committed secret templates with unresolved `${VAR}` placeholders broke the `cluster-components` Kustomization.
- **Secret rendering** — whole-value placeholders are emitted as quoted YAML strings (empty or special-character values no longer become `null` or invalid YAML), and `$` sequences in values are no longer interpreted as replacement patterns.
- **SOPS failure handling** — a failed encryption now aborts bootstrap and deletes the plaintext file instead of leaving it to be committed.

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
