import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { INSTALL_PLAN_PATH } from "../schemas.js";

export function saveInstallPlan(config: Record<string, string>): void {
  writeFileSync(INSTALL_PLAN_PATH, JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
}

export function loadInstallPlan(): Record<string, string> | null {
  if (!existsSync(INSTALL_PLAN_PATH)) return null;
  try {
    return JSON.parse(readFileSync(INSTALL_PLAN_PATH, "utf-8"));
  } catch {
    return null;
  }
}

export function clearInstallPlan(): void {
  try {
    unlinkSync(INSTALL_PLAN_PATH);
  } catch {
    /* already gone */
  }
}
