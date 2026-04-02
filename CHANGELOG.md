# Changelog

## 1.0.1

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
