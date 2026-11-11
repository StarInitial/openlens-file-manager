import { existsSync, readdirSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface KubectlLookupOptions {
  /** OpenLens userData dir (…/AppData/Roaming/OpenLens). */
  userDataPath: string;
  /** Explicit path from extension settings. */
  overridePath?: string;
}

function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function listDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Locate a kubectl binary.
 *
 * Order: explicit setting → OpenLens bundled binaries → PATH.
 * OpenLens downloads kubectl lazily into `<userData>/binaries/kubectl/<version>/`.
 */
export function findKubectl(opts: KubectlLookupOptions): string | undefined {
  const exe = process.platform === "win32" ? "kubectl.exe" : "kubectl";

  if (opts.overridePath && existsSync(opts.overridePath)) {
    return opts.overridePath;
  }

  const bundledRoot = join(opts.userDataPath, "binaries", "kubectl");
  const versions = listDirSafe(bundledRoot)
    .filter((name) => /^\d+(\.\d+)+/.test(name))
    .sort(compareVersionsDesc);

  for (const version of versions) {
    const versionDir = join(bundledRoot, version);
    const candidates = [
      join(versionDir, `${process.platform}-${process.arch}`, exe),
      join(versionDir, exe),
    ];
    // Some builds nest an extra platform folder we cannot predict.
    for (const sub of listDirSafe(versionDir)) {
      candidates.push(join(versionDir, sub, exe));
    }
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  }

  const pathVar = process.env.PATH ?? "";
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, exe);
    if (existsSync(candidate)) return candidate;
  }

  return undefined;
}
