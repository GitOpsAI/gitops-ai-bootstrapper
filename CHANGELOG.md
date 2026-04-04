# Changelog

All notable changes to the **gitops-ai** bootstrapper CLI are documented here. Versions follow [Semantic Versioning](https://semver.org/).

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
