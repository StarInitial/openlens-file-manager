import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Renderer } from "@k8slens/extensions";

import type { ClusterHint, FileEntry, ListResult, OpResult, ProbeResult } from "../common/types";
import { breadcrumbs, normalizeDir } from "../common/remote-path";
import { invoke, onProgress } from "./ipc";
import { formatTime, humanSize, kindIcon, kindLabel } from "./format";
import { ActionButton, ErrorBox, Icon, Modal, SimpleSelect, TextInput } from "./ui";

const K8sApi = ((Renderer as unknown as { K8sApi?: Record<string, any> }).K8sApi) ?? {};

export interface FileBrowserProps {
  namespace: string;
  podName: string;
  /** Container names to offer; omit to just use `initialContainer`. */
  containers?: string[];
  initialContainer?: string;
  initialDir?: string;
  compact?: boolean;
}

const STYLE_ID = "podfs-styles";
const CSS = `
.podfs-body { position: relative; flex: 1; min-height: 0; overflow: auto; }
.podfs-overlay {
  position: absolute; inset: 0; z-index: 5;
  display: flex; align-items: center; justify-content: center; gap: 10px;
  background: rgba(18, 20, 23, .45);
  border-radius: 4px;
  font-size: 12px; color: #cfd3d8;
  pointer-events: all;
}
.podfs-spinner {
  width: 18px; height: 18px; border-radius: 50%;
  border: 2px solid rgba(160, 170, 180, .3);
  border-top-color: #3d7eff;
  animation: podfs-spin .8s linear infinite;
}
@keyframes podfs-spin { to { transform: rotate(360deg); } }
.podfs-row[data-dir="true"] { cursor: pointer; }
.podfs-row:hover { background: rgba(128, 128, 128, .12); }
.podfs-row[data-selected="true"] { background: rgba(61, 126, 255, .22); }
.podfs-action {
  color: inherit; text-decoration: none; display: inline-flex; align-items: center;
  opacity: .85; cursor: pointer;
}
.podfs-action:hover { opacity: 1; }
.podfs-action[data-disabled="true"] { opacity: .3; cursor: default; }
.podfs-progress-track {
  height: 6px; border-radius: 3px; overflow: hidden;
  background: rgba(140, 150, 160, .25);
}
.podfs-progress-fill {
  height: 100%; background: #3d7eff; transition: width .15s linear;
}
.podfs-progress-fill[data-indeterminate="true"] { width: 40%; animation: podfs-indeterminate 1.2s ease-in-out infinite; }
@keyframes podfs-indeterminate {
  0% { margin-left: -40%; }
  100% { margin-left: 100%; }
}
`;

interface TransferState {
  taskId: string;
  kind: "download" | "upload";
  title: string;
  phase: "running" | "done" | "error";
  bytes: number;
  total?: number;
  detail?: string;
  statusText?: string;
}

function useStyles(): void {
  useEffect(() => {
    if (document.getElementById(STYLE_ID)) return;
    const element = document.createElement("style");
    element.id = STYLE_ID;
    element.textContent = CSS;
    document.head.appendChild(element);
  }, []);
}

function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Best-effort read of the active cluster so main can pick the right kubeconfig. */
function clusterHint(): ClusterHint | undefined {
  try {
    const cluster = (K8sApi as Record<string, any>).apiManager?.cluster;
    if (!cluster) return undefined;
    return { apiUrl: cluster.apiUrl, clusterId: cluster.id, clusterName: cluster.name };
  } catch {
    return undefined;
  }
}

function localPathOf(file: File): string | undefined {
  const withPath = file as File & { path?: string };
  if (withPath.path) return withPath.path;
  try {
    const electron = (window as unknown as { require?: (id: string) => any }).require?.("electron");
    return electron?.webUtils?.getPathForFile?.(file);
  } catch {
    return undefined;
  }
}

function RowAction(props: {
  action: string;
  icon: string;
  title: string;
  disabled?: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <a
      className="podfs-action"
      data-action={props.action}
      data-disabled={props.disabled ? "true" : undefined}
      title={props.title}
      href="#"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (props.disabled) return;
        props.onClick();
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <Icon material={props.icon} />
    </a>
  );
}

export function FileBrowser({
  namespace,
  podName,
  containers: containerNames,
  initialContainer,
  initialDir,
  compact,
}: FileBrowserProps): JSX.Element {
  useStyles();

  const containers = useMemo(() => (containerNames ?? []).map((name) => ({ name })), [containerNames]);
  const defaultContainer = initialContainer ?? containers[0]?.name ?? "";

  const [container, setContainer] = useState(defaultContainer);
  const [dir, setDir] = useState(normalizeDir(initialDir ?? "/"));
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [probe, setProbe] = useState<ProbeResult>();
  const [showHidden, setShowHidden] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [selectedPath, setSelectedPath] = useState<string>();
  const [transfer, setTransfer] = useState<TransferState>();

  const [infoEntry, setInfoEntry] = useState<FileEntry>();
  const [renameEntry, setRenameEntry] = useState<FileEntry>();
  const [renameValue, setRenameValue] = useState("");
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [mkdirValue, setMkdirValue] = useState("");
  const [deleteEntry, setDeleteEntry] = useState<FileEntry>();

  const uploadInput = useRef<HTMLInputElement>(null);
  const lastPod = useRef("");
  /** Monotonic request id: stale `/list` responses are dropped. */
  const requestSeq = useRef(0);

  const target = useMemo(() => ({ namespace, pod: podName, container: container || undefined }), [namespace, podName, container]);
  const cluster = useMemo(clusterHint, []);
  const ctx = useMemo(() => ({ target, cluster }), [target, cluster]);

  useEffect(() => {
    const key = `${namespace}/${podName}`;
    if (lastPod.current !== key) {
      lastPod.current = key;
      setDir("/");
      setEntries([]);
      setError(undefined);
      setNotice(undefined);
      setSelectedPath(undefined);
    }
  }, [namespace, podName]);

  const load = useCallback(
    async (nextDir: string) => {
      if (!podName) return;
      const seq = (requestSeq.current += 1);

      // Drop the old rows immediately so nothing stale can be clicked; the
      // overlay covers the full body area, so the layout never collapses.
      setEntries([]);
      setSelectedPath(undefined);
      setError(undefined);
      setLoading(true);

      try {
        const result = await invoke<ListResult>("list", { ...ctx, dir: nextDir, showHidden });
        if (seq !== requestSeq.current) return; // a newer request won the race
        setEntries(result.entries);
        setDir(result.dir);
      } catch (err) {
        if (seq !== requestSeq.current) return;
        setError(toMessage(err));
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [ctx, showHidden, podName],
  );

  const runProbe = useCallback(async () => {
    if (!podName) return;
    setProbe(undefined);
    try {
      setProbe(await invoke<ProbeResult>("probe", ctx));
    } catch (err) {
      setProbe({ ok: false, tools: {}, canWrite: false, message: toMessage(err) });
    }
  }, [ctx, podName]);

  useEffect(() => {
    void runProbe();
  }, [runProbe]);

  useEffect(() => {
    void load(dir);
  }, [load, dir]);

  useEffect(
    () =>
      onProgress((event) => {
        setTransfer((previous) => {
          if (!previous || previous.taskId !== event.taskId) return previous;
          return { ...previous, bytes: Math.max(previous.bytes, event.bytes) };
        });
      }),
    [],
  );

  const refresh = useCallback(async () => {
    await load(dir);
  }, [load, dir]);

  const navigate = useCallback((next: string) => {
    setDir(normalizeDir(next));
  }, []);

  const applyResult = useCallback(
    async (result: OpResult | undefined, successText: string) => {
      if (result && result.ok === false) {
        setError(result.message ?? "操作失败");
      } else {
        setError(undefined);
        setNotice(result?.message ?? successText);
        await load(dir);
      }
      setTimeout(() => setNotice(undefined), 4000);
    },
    [load, dir],
  );

  const finishTransfer = useCallback((taskId: string, result: OpResult | undefined, fallbackError?: string) => {
    setTransfer((previous) => {
      if (!previous || previous.taskId !== taskId) return previous;
      if (result?.ok) {
        return { ...previous, phase: "done", statusText: "已完成", detail: result.path ?? result.message };
      }
      return {
        ...previous,
        phase: "error",
        statusText: "失败",
        detail: result?.message ?? fallbackError ?? "操作失败",
      };
    });
  }, []);

  const onUpload = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const selected = Array.from(files);
      const localPaths = selected
        .map(localPathOf)
        .filter((value): value is string => Boolean(value));
      if (localPaths.length === 0) {
        setError("无法获取本地文件路径（宿主 Electron 版本不再暴露 File.path）。");
        return;
      }

      const taskId = `up-${Date.now()}`;
      const total = selected.reduce((sum, file) => sum + (file.size || 0), 0);
      setTransfer({
        taskId,
        kind: "upload",
        title: selected.length === 1 ? `上传 ${selected[0].name}` : `上传 ${selected.length} 个文件`,
        phase: "running",
        bytes: 0,
        total: total || undefined,
        statusText: "上传中…",
      });

      try {
        const result = await invoke<OpResult>("upload", {
          ...ctx,
          dir,
          localPaths,
          onConflict: "rename" as const,
          taskId,
        });
        finishTransfer(taskId, result);
        if (result?.ok) await load(dir);
      } catch (err) {
        finishTransfer(taskId, undefined, toMessage(err));
      }
    },
    [ctx, dir, finishTransfer, load],
  );

  const onDownload = useCallback(
    async (entry: FileEntry) => {
      const taskId = `dl-${Date.now()}`;
      setTransfer({
        taskId,
        kind: "download",
        title: `下载 ${entry.name}`,
        phase: "running",
        bytes: 0,
        total: entry.size || undefined,
        statusText: "下载中…",
      });

      try {
        const result = await invoke<OpResult>("download", {
          ...ctx,
          path: entry.path,
          isDir: false,
          taskId,
        });
        finishTransfer(taskId, result);
      } catch (err) {
        finishTransfer(taskId, undefined, toMessage(err));
      }
    },
    [ctx, finishTransfer],
  );

  const cancelTransfer = useCallback(async () => {
    if (!transfer || transfer.phase !== "running") return;
    const { taskId } = transfer;
    await invoke("cancel", taskId).catch(() => undefined);
    setTransfer((previous) =>
      previous && previous.taskId === taskId
        ? { ...previous, phase: "error", statusText: "已取消", detail: "传输已取消" }
        : previous,
    );
  }, [transfer]);

  const onDelete = useCallback(async () => {
    if (!deleteEntry) return;
    const entry = deleteEntry;
    setDeleteEntry(undefined);
    try {
      await applyResult(await invoke<OpResult>("remove", { ...ctx, paths: [entry.path] }), "已删除");
    } catch (err) {
      setError(toMessage(err));
    }
  }, [applyResult, ctx, deleteEntry]);

  const onRename = useCallback(async () => {
    if (!renameEntry) return;
    const entry = renameEntry;
    const newName = renameValue.trim();
    setRenameEntry(undefined);
    if (!newName || newName === entry.name) return;
    try {
      await applyResult(await invoke<OpResult>("rename", { ...ctx, path: entry.path, newName }), "已重命名");
    } catch (err) {
      setError(toMessage(err));
    }
  }, [applyResult, ctx, renameEntry, renameValue]);

  const onMkdir = useCallback(async () => {
    const name = mkdirValue.trim();
    setMkdirOpen(false);
    setMkdirValue("");
    if (!name) return;
    try {
      await applyResult(await invoke<OpResult>("mkdir", { ...ctx, dir, name }), "已创建目录");
    } catch (err) {
      setError(toMessage(err));
    }
  }, [applyResult, ctx, dir, mkdirValue]);

  const openInfo = useCallback(
    async (entry: FileEntry) => {
      setInfoEntry(entry);
      try {
        const full = await invoke<FileEntry | undefined>("stat", { ...ctx, path: entry.path });
        if (full?.path) setInfoEntry(full);
      } catch {
        // keep the list-provided snapshot
      }
    },
    [ctx],
  );

  const startRename = useCallback((entry: FileEntry) => {
    setRenameEntry(entry);
    setRenameValue(entry.name);
  }, []);

  const canWrite = probe?.canWrite !== false;
  const containerSupported = !probe || probe.ok;
  const crumbs = breadcrumbs(dir);
  /** Root has nowhere to go back to. */
  const canGoBack = dir !== "/";
  const parentDir = dir.split("/").slice(0, -1).join("/") || "/";
  const progressPercent =
    transfer && transfer.total && transfer.total > 0
      ? Math.min(100, Math.round((transfer.bytes / transfer.total) * 100))
      : undefined;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        height: "100%",
        minHeight: 0,
        minWidth: 0,
        flex: 1,
        fontSize: compact ? 12 : 13,
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        <span data-testid="podfs-back" data-disabled={canGoBack ? undefined : "true"}>
          <ActionButton label="后退" title={canGoBack ? "返回上级目录" : "已在根目录，无法后退"} disabled={!canGoBack} onClick={() => navigate(parentDir)} />
        </span>
        <ActionButton label="刷新" onClick={() => void refresh()} />
        <ActionButton label="上传" disabled={!canWrite} onClick={() => uploadInput.current?.click()} />
        <ActionButton label="新建目录" disabled={!canWrite} onClick={() => setMkdirOpen(true)} />
        <label style={{ display: "flex", alignItems: "center", gap: 4, opacity: 0.85 }}>
          <input type="checkbox" checked={showHidden} onChange={(event) => setShowHidden(event.target.checked)} />
          隐藏文件
        </label>

        {containers.length > 0 ? (
          <label style={{ display: "flex", alignItems: "center", gap: 4, marginLeft: "auto" }}>
            <span style={{ opacity: 0.7 }}>容器</span>
            <SimpleSelect
              testId="podfs-container-select"
              title="选择容器"
              value={container}
              options={containers.map((item) => ({ value: item.name, label: item.name }))}
              onChange={(next) => {
                setContainer(next);
                setDir("/"); // another container may not have the current path
              }}
            />
          </label>
        ) : null}
        <input
          ref={uploadInput}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={(event) => {
            void onUpload(event.target.files);
            event.target.value = "";
          }}
        />
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 2, opacity: 0.9 }}>
        {crumbs.map((crumb, index) => (
          <span key={crumb.path} style={{ display: "flex", alignItems: "center", gap: 2 }}>
            {index > 0 ? <span style={{ opacity: 0.5 }}>/</span> : null}
            <a
              href="#"
              onClick={(event) => {
                event.preventDefault();
                navigate(crumb.path);
              }}
              style={{
                color: "inherit",
                textDecoration: "none",
                padding: "1px 3px",
                borderRadius: 3,
                background: crumb.path === dir ? "rgba(128,128,128,.25)" : "transparent",
              }}
            >
              {crumb.name}
            </a>
          </span>
        ))}
      </div>

      {probe && !containerSupported ? (
        <ErrorBox message={probe.message ?? "当前容器不支持文件操作"} onRetry={() => void runProbe()} />
      ) : null}
      {probe?.ok && probe.tools.tar === false ? <ErrorBox message="容器内缺少 tar，上传/下载不可用。" /> : null}
      {error ? <ErrorBox message={error} onRetry={() => void refresh()} /> : null}
      {notice ? <div style={{ color: "#7cd992" }}>{notice}</div> : null}

      <div className="podfs-body">
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", opacity: 0.7 }}>
              <th style={{ padding: "4px 6px", fontWeight: 500 }}>名称</th>
              <th style={{ padding: "4px 6px", fontWeight: 500, width: 88 }}>大小</th>
              <th style={{ padding: "4px 6px", fontWeight: 500, width: 140 }}>修改时间</th>
              <th style={{ padding: "4px 6px", fontWeight: 500, width: 108 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {dir !== "/" ? (
              <tr
                className="podfs-row"
                data-dir="true"
                onDoubleClick={() => navigate(dir.split("/").slice(0, -1).join("/") || "/")}
              >
                <td colSpan={4} style={{ padding: "4px 6px" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <Icon material="arrow_upward" /> ..
                  </span>
                </td>
              </tr>
            ) : null}

            {entries.map((entry) => (
              <tr
                key={entry.path}
                className="podfs-row"
                data-entry="true"
                data-kind={entry.kind}
                data-dir={entry.kind === "dir" ? "true" : undefined}
                data-selected={selectedPath === entry.path ? "true" : undefined}
                style={{ borderTop: "1px solid rgba(128,128,128,.18)" }}
                onClick={() => setSelectedPath(entry.path)}
                onDoubleClick={() => {
                  if (entry.kind === "dir") navigate(entry.path);
                  else void openInfo(entry);
                }}
              >
                <td style={{ padding: "4px 6px", wordBreak: "break-all" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <Icon material={kindIcon(entry.kind)} tooltip={kindLabel(entry.kind)} />
                    <span>{entry.name}</span>
                  </span>
                </td>
                <td style={{ padding: "4px 6px", opacity: 0.85 }}>{entry.kind === "dir" ? "-" : humanSize(entry.size)}</td>
                <td style={{ padding: "4px 6px", opacity: 0.85, whiteSpace: "nowrap" }}>{formatTime(entry.mtimeMs)}</td>
                <td style={{ padding: "4px 6px" }}>
                  <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <RowAction action="info" icon="info" title="文件信息" onClick={() => void openInfo(entry)} />
                    <RowAction
                      action="rename"
                      icon="edit"
                      title="重命名"
                      disabled={!canWrite}
                      onClick={() => startRename(entry)}
                    />
                    {entry.kind !== "dir" ? (
                      <RowAction action="download" icon="download" title="下载" onClick={() => void onDownload(entry)} />
                    ) : null}
                    <RowAction
                      action="delete"
                      icon="delete"
                      title="删除"
                      disabled={!canWrite}
                      onClick={() => setDeleteEntry(entry)}
                    />
                  </span>
                </td>
              </tr>
            ))}

            {!loading && entries.length === 0 ? (
              <tr>
                <td colSpan={4} style={{ padding: 10, opacity: 0.6 }}>
                  {error ? "加载失败" : "空目录"}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>

        {loading ? (
          <div className="podfs-overlay">
            <div className="podfs-spinner" />
            <span>加载中…</span>
          </div>
        ) : null}
      </div>

      {entries.length > 0 ? (
        <div style={{ opacity: 0.55, fontSize: 11 }}>双击目录进入 · 右侧图标可查看信息 / 重命名 / 下载（仅文件）/ 删除</div>
      ) : null}

      {transfer ? (
        <Modal
          title={transfer.title}
          onClose={() => {
            if (transfer.phase !== "running") setTransfer(undefined);
          }}
        >
          <table style={{ fontSize: 12, width: "100%" }}>
            <tbody>
              <tr>
                <td style={{ padding: "3px 10px 3px 0", opacity: 0.7, whiteSpace: "nowrap" }}>状态</td>
                <td style={{ padding: "3px 0" }}>
                  {transfer.statusText ?? (transfer.phase === "running" ? "进行中…" : transfer.phase === "done" ? "已完成" : "失败")}
                </td>
              </tr>
              <tr>
                <td style={{ padding: "3px 10px 3px 0", opacity: 0.7, verticalAlign: "top", whiteSpace: "nowrap" }}>进度</td>
                <td style={{ padding: "3px 0" }}>
                  <div className="podfs-progress-track">
                    <div
                      className="podfs-progress-fill"
                      data-indeterminate={progressPercent === undefined ? "true" : undefined}
                      style={progressPercent === undefined ? undefined : { width: `${progressPercent}%` }}
                    />
                  </div>
                  <div style={{ fontSize: 11, opacity: 0.75, marginTop: 4 }}>
                    {humanSize(transfer.bytes)}
                    {transfer.total ? ` / ${humanSize(transfer.total)}` : ""}
                    {progressPercent !== undefined ? ` · ${progressPercent}%` : ""}
                  </div>
                </td>
              </tr>
              {transfer.detail ? (
                <tr>
                  <td style={{ padding: "3px 10px 3px 0", opacity: 0.7, whiteSpace: "nowrap" }}>
                    {transfer.kind === "download" ? "保存位置" : "目标目录"}
                  </td>
                  <td style={{ padding: "3px 0", wordBreak: "break-all" }}>{transfer.detail}</td>
                </tr>
              ) : null}
            </tbody>
          </table>
          <div style={{ marginTop: 12, display: "flex", gap: 8, justifyContent: "flex-end" }}>
            {transfer.phase === "running" ? <ActionButton label="取消" onClick={() => void cancelTransfer()} /> : null}
            <ActionButton
              label="关闭"
              primary={transfer.phase !== "running"}
              disabled={transfer.phase === "running"}
              onClick={() => setTransfer(undefined)}
            />
          </div>
        </Modal>
      ) : null}

      {infoEntry ? (
        <Modal title={infoEntry.name} onClose={() => setInfoEntry(undefined)}>
          <table style={{ fontSize: 12 }}>
            <tbody>
              {[
                ["类型", kindLabel(infoEntry.kind)],
                ["路径", infoEntry.path],
                ["大小", infoEntry.kind === "dir" ? "-" : `${humanSize(infoEntry.size)} (${infoEntry.size} B)`],
                ["权限", `${infoEntry.mode} (${infoEntry.rawMode})`],
                ["属主", `uid ${infoEntry.uid} / gid ${infoEntry.gid}`],
                ["修改时间", formatTime(infoEntry.mtimeMs)],
                ["链接目标", infoEntry.linkTarget ?? "-"],
              ].map(([label, value]) => (
                <tr key={label}>
                  <td style={{ padding: "3px 10px 3px 0", opacity: 0.7, whiteSpace: "nowrap" }}>{label}</td>
                  <td style={{ padding: "3px 0", wordBreak: "break-all" }}>{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 12, textAlign: "right" }}>
            <ActionButton label="关闭" onClick={() => setInfoEntry(undefined)} primary />
          </div>
        </Modal>
      ) : null}

      {renameEntry ? (
        <Modal title={`重命名 ${renameEntry.name}`} onClose={() => setRenameEntry(undefined)}>
          <TextInput value={renameValue} onChange={setRenameValue} placeholder="新名称" />
          <div style={{ marginTop: 12, display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <ActionButton label="取消" onClick={() => setRenameEntry(undefined)} />
            <ActionButton label="确定" primary onClick={() => void onRename()} />
          </div>
        </Modal>
      ) : null}

      {mkdirOpen ? (
        <Modal title="新建目录" onClose={() => setMkdirOpen(false)}>
          <TextInput value={mkdirValue} onChange={setMkdirValue} placeholder="目录名称" />
          <div style={{ marginTop: 12, display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <ActionButton label="取消" onClick={() => setMkdirOpen(false)} />
            <ActionButton label="创建" primary onClick={() => void onMkdir()} />
          </div>
        </Modal>
      ) : null}

      {deleteEntry ? (
        <Modal title="确认删除" onClose={() => setDeleteEntry(undefined)}>
          <p style={{ marginTop: 0 }}>
            将删除 <strong>{deleteEntry.path}</strong>
            {deleteEntry.kind === "dir" ? "（含全部内容，不可恢复）" : ""}
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <ActionButton label="取消" onClick={() => setDeleteEntry(undefined)} />
            <ActionButton label="删除" primary onClick={() => void onDelete()} />
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
