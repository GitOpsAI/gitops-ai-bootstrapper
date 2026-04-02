import { commandExists, execAsync } from "../utils/shell.js";
import { isMacOS, getArch } from "../utils/platform.js";
import { log, withSpinner } from "../utils/log.js";

interface Dependency {
  name: string;
  check: () => boolean;
  installDarwin: () => Promise<void>;
  installLinux: () => Promise<void>;
}

async function runInstall(cmd: string): Promise<void> {
  await execAsync(cmd);
}

const registry: Dependency[] = [
  {
    name: "kubectl",
    check: () => commandExists("kubectl"),
    installDarwin: () => runInstall("brew install kubectl"),
    installLinux: async () => {
      const arch = getArch();
      const version = await execAsync(
        "curl -sL https://dl.k8s.io/release/stable.txt",
      );
      await execAsync(
        `curl -sL "https://dl.k8s.io/release/${version}/bin/linux/${arch}/kubectl" -o /tmp/kubectl`,
      );
      await execAsync(
        "sudo install -o root -g root -m 0755 /tmp/kubectl /usr/local/bin/kubectl",
      );
      await execAsync("rm -f /tmp/kubectl");
    },
  },
  {
    name: "helm",
    check: () => commandExists("helm"),
    installDarwin: () => runInstall("brew install helm"),
    installLinux: () =>
      runInstall(
        "curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash",
      ),
  },
  {
    name: "k9s",
    check: () => commandExists("k9s"),
    installDarwin: () => runInstall("brew install derailed/k9s/k9s"),
    installLinux: async () => {
      await execAsync(
        "wget -qO /tmp/k9s_linux_amd64.deb https://github.com/derailed/k9s/releases/latest/download/k9s_linux_amd64.deb",
      );
      await execAsync(
        "sudo DEBIAN_FRONTEND=noninteractive apt install -y /tmp/k9s_linux_amd64.deb",
      );
      await execAsync("rm /tmp/k9s_linux_amd64.deb");
    },
  },
  {
    name: "flux-operator",
    check: () => commandExists("flux-operator"),
    installDarwin: () =>
      runInstall("brew install controlplaneio-fluxcd/tap/flux-operator"),
    installLinux: async () => {
      const arch = getArch();
      const release = await execAsync(
        `curl -sL https://api.github.com/repos/controlplaneio-fluxcd/flux-operator/releases/latest | grep '"tag_name"' | cut -d'"' -f4`,
      );
      const num = release.replace(/^v/, "");
      await execAsync(
        `curl -Lo /tmp/flux-operator.tar.gz "https://github.com/controlplaneio-fluxcd/flux-operator/releases/download/${release}/flux-operator_${num}_linux_${arch}.tar.gz"`,
      );
      await execAsync("tar -xzf /tmp/flux-operator.tar.gz -C /tmp flux-operator");
      await execAsync(
        "sudo install -o root -g root -m 0755 /tmp/flux-operator /usr/local/bin/flux-operator",
      );
      await execAsync("rm -f /tmp/flux-operator.tar.gz /tmp/flux-operator");
    },
  },
  {
    name: "k3d",
    check: () => commandExists("k3d"),
    installDarwin: () => runInstall("brew install k3d"),
    installLinux: () =>
      runInstall(
        'curl -sL "https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh" | bash',
      ),
  },
  {
    name: "git",
    check: () => commandExists("git"),
    installDarwin: () => runInstall("brew install git"),
    installLinux: () =>
      runInstall(
        "sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git > /dev/null",
      ),
  },
  {
    name: "sops",
    check: () => commandExists("sops"),
    installDarwin: () => runInstall("brew install sops"),
    installLinux: async () => {
      const arch = getArch();
      const os = "linux";
      const version = await execAsync(
        `curl -sL https://api.github.com/repos/getsops/sops/releases/latest | grep '"tag_name"' | cut -d'"' -f4`,
      );
      await execAsync(
        `curl -Lo /tmp/sops "https://github.com/getsops/sops/releases/download/${version}/sops-${version}.${os}.${arch}"`,
      );
      await execAsync("sudo install -m 0755 /tmp/sops /usr/local/bin/sops");
      await execAsync("rm -f /tmp/sops");
    },
  },
  {
    name: "age",
    check: () => commandExists("age") || commandExists("age-keygen"),
    installDarwin: () => runInstall("brew install age"),
    installLinux: async () => {
      const arch = getArch();
      const version = await execAsync(
        `curl -sL https://api.github.com/repos/FiloSottile/age/releases/latest | grep '"tag_name"' | cut -d'"' -f4`,
      );
      await execAsync(
        `curl -Lo /tmp/age.tar.gz "https://github.com/FiloSottile/age/releases/download/${version}/age-${version}-linux-${arch}.tar.gz"`,
      );
      await execAsync("tar -xzf /tmp/age.tar.gz -C /tmp");
      await execAsync(
        "sudo install -m 0755 /tmp/age/age /usr/local/bin/age",
      );
      await execAsync(
        "sudo install -m 0755 /tmp/age/age-keygen /usr/local/bin/age-keygen",
      );
      await execAsync("rm -rf /tmp/age.tar.gz /tmp/age");
    },
  },
];

function getDep(name: string): Dependency {
  const dep = registry.find((d) => d.name === name);
  if (!dep) throw new Error(`Unknown dependency: ${name}`);
  return dep;
}

export async function ensureDependency(name: string): Promise<void> {
  const dep = getDep(name);
  if (dep.check()) {
    log.success(`${dep.name} ✓`);
    return;
  }

  log.detail(`${dep.name} not found, installing...`);
  await withSpinner(`Installing ${dep.name}`, async () => {
    if (isMacOS()) {
      await dep.installDarwin();
    } else {
      await dep.installLinux();
    }
  });
}

export async function ensureAll(names: string[]): Promise<void> {
  for (const name of names) {
    await ensureDependency(name);
  }
}

export function checkPrerequisite(name: string): void {
  if (!commandExists(name)) {
    throw new Error(`Required tool '${name}' is not installed.`);
  }
}
