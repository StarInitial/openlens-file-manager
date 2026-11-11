import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Settings } from "./cluster-resolver";

const FILE_NAME = "pod-file-manager.json";

/**
 * Extension settings live in a plain JSON file inside OpenLens' userData dir.
 * Deliberately simple: the user can hand-edit it, and we avoid depending on the
 * host's ExtensionStore API surface, which differs between OpenLens builds.
 */
export function settingsPath(userDataPath: string): string {
  return join(userDataPath, FILE_NAME);
}

export function readSettings(userDataPath: string): Settings {
  const file = settingsPath(userDataPath);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Settings;
    return {
      kubectlPath: typeof parsed.kubectlPath === "string" ? parsed.kubectlPath : undefined,
      kubeconfigPath: typeof parsed.kubeconfigPath === "string" ? parsed.kubeconfigPath : undefined,
      contextName: typeof parsed.contextName === "string" ? parsed.contextName : undefined,

    };
  } catch {
    return {};
  }
}
