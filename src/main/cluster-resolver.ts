import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ClusterHint } from "../common/types";

export interface ResolvedCluster {
  kubeconfigPath: string;
  contextName?: string;
  clusterLabel?: string;
  clusterId?: string;
  server?: string;
  source: "settings" | "cluster-store" | "default";
}

export interface ResolveClusterOptions {
  userDataPath: string;
  homeDir: string;
  settings: Settings;
  hint?: ClusterHint;
}

export interface Settings {
  kubectlPath?: string;
  kubeconfigPath?: string;
  contextName?: string;
}

/** Shape of entries inside OpenLens' `lens-cluster-store.json` (6.5.x). */
interface StoredCluster {
  id?: string;
  contextName?: string;
  kubeConfigPath?: string;
  // Defensive: older/newer builds use different casing.
  kubeconfigContext?: string;
  kubeconfigPath?: string;
  preferences?: { clusterName?: string };
  metadata?: { version?: string; distribution?: string };
}

export function readClusterStore(userDataPath: string): StoredCluster[] {
  const file = join(userDataPath, "lens-cluster-store.json");
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const clusters = Array.isArray(parsed?.clusters) ? parsed.clusters : [];
    return clusters as StoredCluster[];
  } catch {
    return [];
  }
}

/** Extract every `server:` value from a kubeconfig (YAML, parsed cheaply). */
function serverUrlsOf(kubeconfigPath: string): string[] {
  try {
    const text = readFileSync(kubeconfigPath, "utf8");
    return Array.from(text.matchAll(/^\s*server:\s*(\S+)\s*$/gm)).map((m) => m[1]);
  } catch {
    return [];
  }
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function matchesHint(cluster: StoredCluster, hint?: ClusterHint): boolean {
  if (!hint) return false;
  if (hint.clusterId && cluster.id && hint.clusterId === cluster.id) return true;

  const hintHost = hint.apiUrl ? hostOf(hint.apiUrl) : undefined;
  const path = cluster.kubeConfigPath ?? cluster.kubeconfigPath;
  if (hintHost && path) {
    return serverUrlsOf(path).some((server) => hostOf(server) === hintHost);
  }
  return false;
}

/**
 * Resolve which kubeconfig/context the current request belongs to.
 *
 * 1. Explicit extension settings (most reliable)
 * 2. OpenLens cluster store, matched against the API URL we got from the renderer
 * 3. OpenLens cluster store, single-cluster shortcut
 * 4. `~/.kube/config` with its current context
 */
export function resolveCluster(opts: ResolveClusterOptions): ResolvedCluster | undefined {
  const { settings, hint } = opts;

  if (settings.kubeconfigPath) {
    const cluster: ResolvedCluster = {
      kubeconfigPath: settings.kubeconfigPath,
      contextName: settings.contextName,
      source: "settings",
      clusterLabel: "设置中指定的 kubeconfig",
    };
    cluster.server = serverUrlsOf(settings.kubeconfigPath)[0];
    return cluster;
  }

  const clusters = readClusterStore(opts.userDataPath).filter(
    (c) => typeof (c.kubeConfigPath ?? c.kubeconfigPath) === "string",
  );

  const toResolved = (c: StoredCluster): ResolvedCluster => {
    const kubeconfigPath = (c.kubeConfigPath ?? c.kubeconfigPath) as string;
    return {
      kubeconfigPath,
      contextName: c.contextName ?? c.kubeconfigContext ?? settings.contextName,
      clusterLabel: c.preferences?.clusterName,
      clusterId: c.id,
      server: serverUrlsOf(kubeconfigPath)[0],
      source: "cluster-store",
    };
  };

  const byHint = clusters.find((c) => matchesHint(c, hint));
  if (byHint) return toResolved(byHint);

  if (clusters.length > 0) return toResolved(clusters[0]);

  const defaultPath = join(opts.homeDir, ".kube", "config");
  if (existsSync(defaultPath)) {
    return {
      kubeconfigPath: defaultPath,
      contextName: settings.contextName,
      clusterLabel: "~/.kube/config",
      source: "default",
      server: serverUrlsOf(defaultPath)[0],
    };
  }

  return undefined;
}
