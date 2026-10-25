import os from "node:os";

export type OS = "darwin" | "linux";
export type Arch = "amd64" | "arm64";

export function getOS(): OS {
  const p = os.platform();
  if (p === "darwin") return "darwin";
  if (p === "linux") return "linux";
  throw new Error(`Unsupported platform: ${p}`);
}

export function getArch(): Arch {
  const a = os.arch();
  if (a === "x64") return "amd64";
  if (a === "arm64") return "arm64";
  throw new Error(`Unsupported architecture: ${a}`);
}

export const isMacOS = (): boolean => getOS() === "darwin";
export const isLinux = (): boolean => getOS() === "linux";
export const isCI = (): boolean => process.env.CI === "true";
export const isCodespaces = (): boolean => process.env.CODESPACES === "true";

/** k3s needs systemd on the host; macOS, CI runners and Codespaces containers run k3d instead. */
export const useK3d = (): boolean => isMacOS() || isCI() || isCodespaces();

/** No local browser to complete OAuth flows (CI runners, Codespaces terminals). */
export const isHeadless = (): boolean => isCI() || isCodespaces();
