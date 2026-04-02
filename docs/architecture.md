# Architecture

This document explains how the GitOps AI Bootstrapper works, the relationship between its components, and how the GitOps reconciliation loop keeps your cluster in sync with Git.

## System Overview

The system consists of two repositories and a Kubernetes cluster:

```mermaid
graph LR
    subgraph repos [Git Repositories]
        Template["fluxcd_ai_template<br/>(source template)"]
        UserRepo["your-namespace/fluxcd_ai<br/>(your GitOps repo)"]
    end

    subgraph cli [Bootstrap CLI]
        Wizard["Interactive Wizard"]
        Provisioner["Cluster Provisioner"]
    end

    subgraph cluster [Kubernetes Cluster]
        FluxOp["Flux Operator"]
        FluxInst["Flux Instance"]
        Components["Deployed Components"]
    end

    Template -->|"clone + push"| UserRepo
    Wizard -->|"collects config"| Provisioner
    Provisioner -->|"creates"| cluster
    Provisioner -->|"commits to"| UserRepo
    UserRepo -->|"watched by"| FluxInst
    FluxOp -->|"manages"| FluxInst
    FluxInst -->|"deploys"| Components
```

1. **Template repository** (`gitlab.com/everythings-gonna-be-alright/fluxcd_ai_template`) -- contains the default cluster layout, Helm values, and component manifests. You never modify this repo directly.

2. **Your GitOps repository** -- a fork/clone of the template, owned by your GitLab namespace. This is the single source of truth for your cluster. All changes flow through Git.

3. **Bootstrap CLI** (`gitops-ai`) -- the npm package you run. It clones the template, collects configuration, provisions the cluster, and installs Flux. After bootstrap, you rarely need it again.

## Bootstrap Flow

```mermaid
flowchart TD
    Start["npx gitops-ai bootstrap"] --> Resume{"Saved plan<br/>exists?"}
    Resume -->|Yes| LoadPlan["Load /tmp/installplan.json"]
    Resume -->|No| Wizard["Interactive Wizard"]
    LoadPlan --> Wizard
    Wizard --> SavePlan["Save install plan"]
    SavePlan --> RepoSetup{"Setup mode?"}
    RepoSetup -->|New| Clone["Clone template +<br/>create GitLab project"]
    RepoSetup -->|Existing| UseExisting["Use existing repo"]
    Clone --> GitCreds["Configure git credentials"]
    UseExisting --> GitCreds
    GitCreds --> Deps["Install dependencies<br/>(kubectl, helm, k9s, etc.)"]
    Deps --> K8s{"Platform?"}
    K8s -->|macOS / CI| K3d["Create k3d cluster"]
    K8s -->|Linux| K3s["Install k3s"]
    K3d --> FluxOp["Install Flux Operator"]
    K3s --> FluxOp
    FluxOp --> GitSecret["Create GitLab auth secret"]
    GitSecret --> Template["Copy + render<br/>cluster template"]
    Template --> SOPS["SOPS: generate key +<br/>encrypt secrets"]
    SOPS --> Push["git commit + push"]
    Push --> FluxInst["Install Flux Instance"]
    FluxInst --> Reconcile["Trigger reconciliation"]
    Reconcile --> Done["Bootstrap complete"]
```

## Repository Structure

After bootstrap, your GitOps repository looks like this:

```
fluxcd_ai/
├── .sops.yaml                          # SOPS encryption config (age public key)
├── flux-instance-values.yaml           # Flux Instance Helm values
├── clusters/
│   ├── _default-template/              # Original template (unchanged)
│   │   └── ...
│   └── homelab/                        # Your cluster (clusterName)
│       ├── cluster-sync.yaml           # Flux sync config with cluster variables
│       └── components/
│           ├── kustomization.yaml      # Component index
│           ├── helm-repos/             # Helm chart repositories
│           ├── ingress-nginx-external/ # Ingress controller
│           ├── prometheus-operator-crds/
│           ├── cert-manager/           # TLS certificates (if enabled)
│           │   └── secret-cloudflare.yaml  # SOPS-encrypted
│           ├── external-dns/           # DNS automation (if enabled)
│           │   └── secret-cloudflare.yaml  # SOPS-encrypted
│           ├── grafana-operator/        # Grafana dashboards & datasources (if monitoring enabled)
│           ├── victoria-metrics-k8s-stack/ # Metrics collection & alerting (if monitoring enabled)
│           ├── flux-web/               # Flux dashboard (if enabled)
│           └── openclaw/               # AI gateway (if enabled)
│               └── secret-openclaw-envs.yaml  # SOPS-encrypted
```

Disabled components are removed entirely -- their directories and `kustomization.yaml` entries are pruned during bootstrap.

## How Flux Operator Works

The bootstrap installs two Flux-specific resources:

### Flux Operator

A Helm chart installed into `flux-system` that acts as a Kubernetes controller. It watches for `FluxInstance` custom resources and manages the lifecycle of Flux controllers (source-controller, kustomize-controller, helm-controller, etc.).

### Flux Instance

A custom resource that tells the Flux Operator where your Git repository is and which branch to watch. The Flux Operator reads this CR and spins up the necessary Flux controllers configured to sync from your repo.

```mermaid
graph TD
    subgraph controlPlane [Flux System Namespace]
        Operator["Flux Operator<br/>(Helm chart)"]
        Instance["FluxInstance CR"]
        Source["source-controller"]
        Kustomize["kustomize-controller"]
        HelmCtrl["helm-controller"]
    end

    subgraph secrets [Secrets]
        GitSecret["flux-system secret<br/>(GitLab PAT)"]
        SOPSSecret["sops-age secret<br/>(age private key)"]
    end

    GitRepo["GitLab Repository"]

    Operator -->|"manages"| Instance
    Instance -->|"configures"| Source
    Instance -->|"configures"| Kustomize
    Instance -->|"configures"| HelmCtrl
    Source -->|"pulls from"| GitRepo
    GitSecret -->|"auth for"| Source
    SOPSSecret -->|"decrypts secrets in"| Kustomize
    Kustomize -->|"applies manifests"| K8sAPI["Kubernetes API"]
    HelmCtrl -->|"installs charts"| K8sAPI
```

## GitOps Reconciliation Loop

Once bootstrap is complete, Flux continuously reconciles the cluster state with Git:

```mermaid
flowchart LR
    Dev["Developer / AI Assistant"] -->|"git push"| Git["GitLab Repo"]
    Git -->|"polled by"| Flux["Flux Controllers"]
    Flux -->|"applies"| Cluster["Kubernetes Cluster"]
    Cluster -->|"drift detected"| Flux
```

1. **You push a change** to the GitOps repo (edit a HelmRelease, update values, add a component).
2. **Flux source-controller** polls the repo (default: every few minutes) and detects the new commit.
3. **Flux kustomize-controller** renders the Kustomization and applies resources. SOPS-encrypted secrets are decrypted in-memory using the age key stored in the cluster.
4. **Flux helm-controller** processes any HelmRelease changes, upgrading or installing Helm charts.
5. **Drift correction** -- if someone manually modifies a resource in the cluster, Flux reverts it to match Git on the next reconciliation cycle.

This means your Git repo is always the source of truth. You never `kubectl apply` manually -- every change goes through Git, giving you a full audit trail and the ability to roll back by reverting a commit.

## Security Model

- **Secrets at rest**: all sensitive values (API tokens, keys) are encrypted with SOPS/Age before being committed to Git. The age private key exists only in the cluster (as a Kubernetes secret) and on the machine that ran the bootstrap (at `~/.sops/age.agekey`).
- **GitLab auth**: the Git credentials secret uses a PAT scoped to the minimum required permissions. Flux pulls over HTTPS.
- **Container hardening**: the template repository configures workloads with non-root users, read-only root filesystems, and dropped capabilities following NSA Kubernetes hardening guidelines.
- **Network isolation**: ingress is restricted to the CIDR ranges you specify during the wizard. Components include NetworkPolicy resources to limit pod-to-pod communication.
