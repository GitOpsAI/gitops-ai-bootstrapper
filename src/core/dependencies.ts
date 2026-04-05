import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  commandExists,
  execAsync,
  execSafe,
  execShellInteractive,
} from "../utils/shell.js";
import { isMacOS, getArch } from "../utils/platform.js";
import { log, withSpinner } from "../utils/log.js";

const DOCKER_APP = "/Applications/Docker.app";
const DOCKER_BUNDLED_CLI = `${DOCKER_APP}/Contents/Resources/bin/docker`;
const ORBSTACK_APP = "/Applications/OrbStack.app";
/** OrbStack ships docker inside the app bundle (path may vary by version). */
const ORBSTACK_BUNDLED_DOCKER_PATHS = [
  `${ORBSTACK_APP}/Contents/MacOS/xbin/docker`,
  `${ORBSTACK_APP}/Contents/MacOS/bin/docker`,
];

/** True if Docker Desktop, OrbStack, Colima, or a docker CLI is already present — skip installing Docker Desktop. */
function dockerInstalledOnMac(): boolean {
  const orbstackHomeDocker = join(homedir(), ".orbstack/bin/docker");
  return (
    commandExists("docker") ||
    existsSync(DOCKER_APP) ||
    existsSync(DOCKER_BUNDLED_CLI) ||
    existsSync(ORBSTACK_APP) ||
    ORBSTACK_BUNDLED_DOCKER_PATHS.some((p) => existsSync(p)) ||
    existsSync(orbstackHomeDocker) ||
    commandExists("colima")
  );
}

/** Resolve docker binary on macOS when PATH is not yet updated after cask install. */
function dockerCliForExec(): string {
  if (commandExists("docker")) return "docker";
  const candidates = [
    DOCKER_BUNDLED_CLI,
    ...ORBSTACK_BUNDLED_DOCKER_PATHS,
    join(homedir(), ".orbstack/bin/docker"),
    "/opt/homebrew/bin/docker",
    "/usr/local/bin/docker",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return "docker";
}

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
    name: "docker",
    check: () => (isMacOS() ? dockerInstalledOnMac() : true),
    installDarwin: () =>
      execShellInteractive("brew install --cask docker"),
    installLinux: () => Promise.resolve(),
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
    return;
  }

  if (name === "docker" && isMacOS()) {
    log.info(
      "Docker Desktop (Homebrew cask) — if a password dialog appears, enter your Mac login password. Your input is sent to the system installer.",
    );
    await dep.installDarwin();
    return;
  }

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

/**
 * Ensure Docker Desktop daemon is reachable (macOS / k3d). Opens the app and polls until `docker info` succeeds.
 */
export async function ensureDockerDaemonReady(): Promise<void> {
  if (!isMacOS()) return;

  await withSpinner("Waiting for Docker", async () => {
    let bin = dockerCliForExec();
    if (execSafe(`${bin} info`).exitCode === 0) return;

    if (existsSync(DOCKER_APP)) {
      await execAsync("open -a Docker").catch(() => {});
    } else if (existsSync(ORBSTACK_APP)) {
      await execAsync("open -a OrbStack").catch(() => {});
    }

    const maxAttempts = 90;
    for (let i = 0; i < maxAttempts; i++) {
      bin = dockerCliForExec();
      if (execSafe(`${bin} info`).exitCode === 0) return;
      await new Promise((r) => setTimeout(r, 2000));
    }

    throw new Error(
      "Docker daemon did not become ready in time. Start your container runtime (e.g. open -a Docker, open -a OrbStack, or colima start) — https://docs.docker.com/desktop/setup/install/mac-install/",
    );
  });
}
