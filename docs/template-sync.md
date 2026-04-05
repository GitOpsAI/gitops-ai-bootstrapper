# Template synchronization

This guide matches the upstream [template repository](https://github.com/GitOpsAI/gitops-ai-template) layout: shared bases under `templates/` (by category, e.g. `templates/system/`, `templates/ai/`), `clusters/_template/`, and your live `clusters/<clusterName>/`.

## After bootstrap

- **`template-sync-metadata.yaml`** comes from the template and includes the semver of the template content. The `template sync` command uses this file and the `upstream` Git remote to identify what to fetch.

## Upstream remote

Add the canonical template (if not already present):

```bash
git remote add upstream https://github.com/GitOpsAI/gitops-ai-template.git
git fetch upstream --tags
```

## Where to run this

Run **`template sync` inside your bootstrapped GitOps repository** (the one with `templates/` and `clusters/`), or pass `--cwd` to that path.

Do **not** run it inside the **gitops-ai bootstrapper** source tree (the npm package named `gitops-ai` in this repo) — that project is unrelated to the template in Git history; the command is for syncing the **template** into **your Flux repo**, not for developing the CLI.

## Interactive mode (default)

Running without flags launches an interactive TUI wizard:

```bash
gitops-ai template sync
```

The wizard:

1. Shows your current branch and template version (`template-sync-metadata.yaml`).
2. Fetches available tags from upstream and lets you pick one (or type a custom ref).
3. Fetches the ref and shows a **diff summary** with risk classification:
   - **Routine** — `templates/` changes (chart bumps, shared Helm bases, namespace tweaks).
   - **High-touch** — `flux-instance.yaml`, `.sops.yaml`, `secret-*.yaml`, `cluster-sync.yaml`.
   - **Cluster overlay** — anything under `clusters/`.
4. Prompts: **Merge now**, **Dry-run only**, or **Cancel**.
5. After merge: shows a summary with files changed, conflict count (if any), and next steps.

## Non-interactive mode (flags)

Passing any flag (`--ref`, `--dry-run`, `--allow-unrelated-histories`) skips the wizard:

```bash
gitops-ai template sync --ref v1.0.0
gitops-ai template sync --ref v1.0.0 --dry-run
```

- Adds the `upstream` remote if missing.
- Fetches the ref (tag or branch).
- Shows a diff stat vs your current `HEAD`.
- Merges into your current branch with a conventional commit message.

Options:

| Option                        | Default           | Description                                                                    |
|-------------------------------|-------------------|--------------------------------------------------------------------------------|
| `--ref`                       | `main`            | Upstream **tag or branch** (e.g. `feat/template_sync`, `v1.0.0`)               |
| `--remote`                    | `upstream`        | **Local** name for the remote that points at the template URL — not the branch |
| `--cwd`                       | current directory | Repository root                                                                |
| `--dry-run`                   | off               | Fetch + diff only; no merge                                                    |
| `--allow-unrelated-histories` | off               | Only if this repo was never forked from the template; expect heavy conflicts   |

**Common mistake:** passing your branch name to `--remote`. That creates a remote literally named `feat/foo` and still fetches the default ref (`main`). Use `--ref feat/foo` instead.

If you see **refusing to merge unrelated histories**, your current directory is not a Git repo descended from the template (or you used the wrong flags). Run `template sync` from the repo you bootstrapped, or use `--allow-unrelated-histories` only when you understand the risk.

## Merge order (same as upstream docs)

1. **`templates/`** — shared Helm bases and component manifests (grouped by category).
2. **`clusters/_template/`** — reference snapshot for adding components later.
3. **`clusters/<clusterName>/`** — selective merge; never overwrite SOPS secrets or local tweaks blindly.

## CI validation parity

Before pushing, run the same checks the template uses in CI:

- `yamllint`
- `flux build kustomization` for your cluster path (with the same `CLUSTER_*` substitutions as CI)
- `kubeconform` on the build output

See the template [GitHub Actions workflow](https://github.com/GitOpsAI/gitops-ai-template/blob/main/.github/workflows/ci.yml) or [`.gitlab-ci.yml`](https://github.com/GitOpsAI/gitops-ai-template/blob/main/.gitlab-ci.yml) for exact variables.

## Risk tiers (GitLab MR jobs)

If you use GitLab and copy the template’s CI, merge requests may print **classification** lines:

- **ROUTINE_SYNC_CANDIDATE** — `templates/` changed.
- **HIGH_TOUCH_REVIEW** — `flux-instance.yaml`, `.sops.yaml`, `secret-*.yaml`, or `cluster-sync.yaml`.
- **CLUSTER_OVERLAY** — anything under `clusters/`.

Use these as hints for reviewer assignment — they do not replace human judgment.

## Bootstrapper ↔ template alignment

When the template adds components, paths, or secrets, **release a new `gitops-ai` version** that updates [`COMPONENTS`](../src/schemas.ts) and wizard behavior. Keep template majors and CLI majors loosely aligned for a predictable experience.
