/** Shared types between the main and renderer processes. */

export type FileKind = "file" | "dir" | "symlink" | "other";

/** One directory entry as reported by `stat` inside the container. */
export interface FileEntry {
  name: string;
  /** Absolute POSIX path inside the container. */
  path: string;
  kind: FileKind;
  size: number;
  /** Symbolic permissions, e.g. `-rw-r--r--`. */
  mode: string;
  /** Raw mode in hex as reported by `stat -c %f` (e.g. `81a4`). */
  rawMode: string;
  /** Milliseconds since epoch. */
  mtimeMs: number;
  uid: number;
  gid: number;
  linkTarget?: string;
}

export interface PodTarget {
  namespace: string;
  pod: string;
  container?: string;
}

/** Best effort hint about which cluster the request belongs to. */
export interface ClusterHint {
  apiUrl?: string;
  clusterId?: string;
  clusterName?: string;
}

export interface RequestContext {
  target: PodTarget;
  cluster?: ClusterHint;
}

export interface ListRequest extends RequestContext {
  dir: string;
  showHidden?: boolean;
}

export interface ListResult {
  dir: string;
  entries: FileEntry[];
}

export interface StatRequest extends RequestContext {
  path: string;
}

export interface RenameRequest extends RequestContext {
  path: string;
  newName: string;
}

export interface MkdirRequest extends RequestContext {
  dir: string;
  name: string;
}

export interface DeleteRequest extends RequestContext {
  paths: string[];
}

export interface UploadRequest extends RequestContext {
  dir: string;
  localPaths: string[];
  onConflict: ConflictPolicy;
  taskId: string;
}

export interface DownloadRequest extends RequestContext {
  path: string;
  isDir: boolean;
  taskId: string;
}

export interface ReadTextRequest extends RequestContext {
  path: string;
  maxBytes?: number;
}

export type ConflictPolicy = "skip" | "overwrite" | "rename";

export interface OpResult {
  ok: boolean;
  message?: string;
  code?: ErrorCode;
  /** Structured target of the operation (saved file path / destination dir). */
  path?: string;
}

export interface ProbeResult extends OpResult {
  kubectlPath?: string;
  kubeconfigPath?: string;
  contextName?: string;
  clusterLabel?: string;
  tools: Record<string, boolean>;
  canWrite: boolean;
}

export interface ProgressEvent {
  taskId: string;
  phase: "upload" | "download";
  bytes: number;
  total?: number;
  name?: string;
  done?: boolean;
}

export type ErrorCode =
  | "KUBECTL_MISSING"
  | "KUBECONFIG_MISSING"
  | "POD_NOT_RUNNING"
  | "CONTAINER_NOT_FOUND"
  | "NO_SHELL_TOOLS"
  | "PERMISSION_DENIED"
  | "NOT_FOUND"
  | "READ_ONLY_FS"
  | "CONFLICT"
  | "CANCELLED"
  | "TIMEOUT"
  | "UNKNOWN";

export const CHANNELS = {
  probe: "podfs:probe",
  list: "podfs:list",
  stat: "podfs:stat",
  rename: "podfs:rename",
  mkdir: "podfs:mkdir",
  remove: "podfs:remove",
  upload: "podfs:upload",
  download: "podfs:download",
  cancel: "podfs:cancel",
  progress: "podfs:progress",
} as const;
