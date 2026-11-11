import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { finished } from "node:stream/promises";
import * as path from "node:path";
import { PassThrough, Transform } from "node:stream";
import * as zlib from "node:zlib";

import type {
  DeleteRequest,
  DownloadRequest,
  ErrorCode,
  FileEntry,
  FileKind,
  ListRequest,
  ListResult,
  MkdirRequest,
  OpResult,
  PodTarget,
  ProbeResult,
  ProgressEvent,
  RenameRequest,
  RequestContext,
  StatRequest,
  UploadRequest,
} from "../common/types";
import { basename, dirname, joinPath, normalizeDir, validateEntryName } from "../common/remote-path";
import { resolveCluster, type ResolvedCluster, type Settings } from "./cluster-resolver";
import { ExecRunner, type ExecRunnerOptions } from "./exec";
import { findKubectl } from "./kubectl";
import { createTarStream, readFirstFileEntry, type PackEntry } from "./tar";

export class PodFsError extends Error {
  constructor(public readonly code: ErrorCode, message: string) {
    super(message);
  }
}

export interface PodFsServiceOptions {
  userDataPath: string;
  homeDir: string;
  getSettings: () => Settings;
  /** Ask the user where to save a downloaded file. */
  pickSavePath?: (suggestedName: string) => Promise<string | undefined>;
  /** Progress sink (main process → renderer). */
  onProgress?: (event: ProgressEvent) => void;
  /** Test seam: override how an exec runner is built. */
  createRunner?: (options: ExecRunnerOptions) => ExecRunner;
}

const SEP = "\u001f";
const STAT_FORMAT = ["%f", "%s", "%Y", "%u", "%g", "%A", "%n"].join(SEP);
const STAT_CHUNK = 300;

function splitNul(text: string): string[] {
  return text.split("\u0000").filter((value) => value.length > 0);
}

function kindFromRawMode(rawMode: string): FileKind {
  const mode = parseInt(rawMode, 16);
  if (!Number.isFinite(mode)) return "other";
  switch (mode & 0o170000) {
    case 0o100000:
      return "file";
    case 0o040000:
      return "dir";
    case 0o120000:
      return "symlink";
    default:
      return "other";
  }
}

/** Turn kubectl/container stderr into a stable error code. */
function mapStderr(stderr: string): PodFsError {
  const text = stderr.toLowerCase();
  if (/executable file not found|no such file or directory: *sh|oci runtime exec failed: exec failed/.test(text)) {
    return new PodFsError(
      "NO_SHELL_TOOLS",
      "该容器缺少 sh/tar 等基础工具（distroless 或 scratch 镜像），无法使用文件管理。",
    );
  }
  if (/forbidden|cannot exec|unauthorized/.test(text)) {
    return new PodFsError("PERMISSION_DENIED", `没有执行权限（需要 pods/exec 授权）：${stderr.trim()}`);
  }
  if (/read-only file system/.test(text)) {
    return new PodFsError("READ_ONLY_FS", "容器文件系统只读，无法写入。");
  }
  if (/container .*not found|no such container/.test(text)) {
    return new PodFsError("CONTAINER_NOT_FOUND", `容器不存在：${stderr.trim()}`);
  }
  if (/is waiting to start|not running|container .* is not valid/.test(text)) {
    return new PodFsError("POD_NOT_RUNNING", `Pod/容器当前不可执行命令：${stderr.trim()}`);
  }
  if (/permission denied|operation not permitted/.test(text)) {
    return new PodFsError("PERMISSION_DENIED", `容器内权限不足：${stderr.trim()}`);
  }
  if (/no such file or directory|not found/.test(text)) {
    return new PodFsError("NOT_FOUND", `路径不存在：${stderr.trim()}`);
  }
  return new PodFsError("UNKNOWN", stderr.trim() || "未知错误");
}

class CountingTransform extends Transform {
  constructor(private readonly onBytes: (delta: number) => void) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void): void {
    this.onBytes(chunk.length);
    callback(null, chunk);
  }
}

export class PodFsService {
  private readonly runners = new Map<string, ExecRunner>();

  private readonly aborts = new Map<string, AbortController>();

  constructor(private readonly opts: PodFsServiceOptions) {}

  // ---------------------------------------------------------------- plumbing

  private settings(): Settings {
    try {
      return this.opts.getSettings();
    } catch {
      return {};
    }
  }

  private kubectlPath(): string {
    const settings = this.settings();
    const found = findKubectl({ userDataPath: this.opts.userDataPath, overridePath: settings.kubectlPath });
    if (!found) {
      throw new PodFsError(
        "KUBECTL_MISSING",
        "找不到 kubectl。请在插件设置中填写 kubectl 绝对路径，或确保它在 PATH 中。",
      );
    }
    return found;
  }

  private cluster(ctx: RequestContext): ResolvedCluster {
    const resolved = resolveCluster({
      userDataPath: this.opts.userDataPath,
      homeDir: this.opts.homeDir,
      settings: this.settings(),
      hint: ctx.cluster,
    });
    if (!resolved) {
      throw new PodFsError(
        "KUBECONFIG_MISSING",
        "找不到可用的 kubeconfig。请在插件设置中指定 kubeconfig 路径。",
      );
    }
    return resolved;
  }

  private runner(ctx: RequestContext): { runner: ExecRunner; cluster: ResolvedCluster; kubectlPath: string } {
    const kubectlPath = this.kubectlPath();
    const cluster = this.cluster(ctx);
    const key = [kubectlPath, cluster.kubeconfigPath, cluster.contextName ?? ""].join("|");
    let runner = this.runners.get(key);
    if (!runner) {
      const runnerOptions: ExecRunnerOptions = {
        kubectlCommand: [kubectlPath],
        kubeconfigPath: cluster.kubeconfigPath,
        contextName: cluster.contextName,
      };
      runner = this.opts.createRunner
        ? this.opts.createRunner(runnerOptions)
        : new ExecRunner(runnerOptions);
      this.runners.set(key, runner);
    }
    return { runner, cluster, kubectlPath };
  }

  cancel(taskId: string): void {
    this.aborts.get(taskId)?.abort();
  }

  // ------------------------------------------------------------------- probe

  async probe(ctx: RequestContext): Promise<ProbeResult> {
    const tools: Record<string, boolean> = {};
    try {
      const { runner, cluster, kubectlPath } = this.runner(ctx);
      const script = "for c in tar stat find ls mv mkdir rm readlink; do command -v $c >/dev/null 2>&1 || echo MISSING:$c; done";
      const result = await runner.runShellScript(ctx.target, script, 20_000);

      for (const tool of ["tar", "stat", "find", "ls", "mv", "mkdir", "rm", "readlink"]) tools[tool] = true;
      for (const line of result.stdout.toString("utf8").split("\n")) {
        const match = /^MISSING:(.+)$/.exec(line.trim());
        if (match) tools[match[1]] = false;
      }

      if (result.code !== 0) {
        const error = mapStderr(result.stderr);
        return {
          ok: false,
          code: error.code,
          message: error.message,
          tools,
          canWrite: false,
          kubectlPath,
          kubeconfigPath: cluster.kubeconfigPath,
          contextName: cluster.contextName,
          clusterLabel: cluster.clusterLabel,
        };
      }

      return {
        ok: tools.tar !== false,
        tools,
        canWrite: tools.mv !== false,
        code: tools.tar === false ? "NO_SHELL_TOOLS" : undefined,
        message: tools.tar === false ? "容器内缺少 tar，仅能查看基础信息。" : undefined,
        kubectlPath,
        kubeconfigPath: cluster.kubeconfigPath,
        contextName: cluster.contextName,
        clusterLabel: cluster.clusterLabel,
      };
    } catch (error) {
      const podError = error instanceof PodFsError ? error : new PodFsError("UNKNOWN", String(error));
      return { ok: false, code: podError.code, message: podError.message, tools, canWrite: false };
    }
  }

  // -------------------------------------------------------------------- list

  private async listNames(runner: ExecRunner, target: PodTarget, dir: string): Promise<string[]> {
    const viaFind = await runner.run(target, ["find", dir, "-maxdepth", "1", "-mindepth", "1", "-print0"], 30_000);
    if (viaFind.code === 0) {
      const names = splitNul(viaFind.stdout.toString("utf8"));
      if (names.length > 0) return names;
      // `find` may succeed but be unsupported (no -maxdepth); verify with ls.
      const viaLs = await runner.run(target, ["ls", "-1A", dir], 30_000);
      if (viaLs.code === 0) return viaLs.stdout.toString("utf8").split("\n").filter(Boolean).map((name) => joinPath(dir, name));
      return [];
    }

    const viaLs = await runner.run(target, ["ls", "-1A", dir], 30_000);
    if (viaLs.code === 0) {
      return viaLs.stdout.toString("utf8").split("\n").filter(Boolean).map((name) => joinPath(dir, name));
    }
    throw mapStderr(viaLs.stderr || viaFind.stderr);
  }

  private parseStat(text: string): FileEntry[] {
    const entries: FileEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split(SEP);
      if (parts.length < 7) continue;
      const [rawMode, size, mtime, uid, gid, mode, ...rest] = parts;
      const remotePath = rest.join(SEP);
      if (!remotePath) continue;
      entries.push({
        name: basename(remotePath),
        path: remotePath,
        kind: kindFromRawMode(rawMode),
        size: Number.parseInt(size, 10) || 0,
        mode,
        rawMode,
        mtimeMs: (Number.parseInt(mtime, 10) || 0) * 1000,
        uid: Number.parseInt(uid, 10) || 0,
        gid: Number.parseInt(gid, 10) || 0,
      });
    }
    return entries;
  }

  private async statPaths(runner: ExecRunner, target: PodTarget, paths: string[]): Promise<FileEntry[]> {
    const result: FileEntry[] = [];
    for (let i = 0; i < paths.length; i += STAT_CHUNK) {
      const chunk = paths.slice(i, i + STAT_CHUNK);
      const response = await runner.run(target, ["stat", "-c", STAT_FORMAT, ...chunk], 30_000);
      if (response.code !== 0) throw mapStderr(response.stderr);
      result.push(...this.parseStat(response.stdout.toString("utf8")));
    }
    return result;
  }

  async list(req: ListRequest): Promise<ListResult> {
    const { runner } = this.runner(req);
    const dir = normalizeDir(req.dir);

    const names = await this.listNames(runner, req.target, dir);
    const entries = names.length > 0 ? await this.statPaths(runner, req.target, names) : [];

    const visible = req.showHidden === false ? entries.filter((entry) => !entry.name.startsWith(".")) : entries;
    visible.sort((a, b) => {
      const aDir = a.kind === "dir" ? 0 : 1;
      const bDir = b.kind === "dir" ? 0 : 1;
      if (aDir !== bDir) return aDir - bDir;
      return a.name.localeCompare(b.name, "zh-Hans-CN");
    });

    return { dir, entries: visible };
  }

  async stat(req: StatRequest): Promise<FileEntry | undefined> {
    const { runner } = this.runner(req);
    const target = normalizeDir(req.path);
    const [entry] = await this.statPaths(runner, req.target, [target]);
    if (!entry) return undefined;

    if (entry.kind === "symlink") {
      const link = await runner.run(req.target, ["readlink", target], 10_000);
      if (link.code === 0) entry.linkTarget = link.stdout.toString("utf8").trim();
    }
    return entry;
  }

  private async exists(runner: ExecRunner, target: PodTarget, remotePath: string): Promise<boolean> {
    const result = await runner.run(target, ["stat", "-c", "%s", remotePath], 15_000);
    return result.code === 0;
  }

  // ------------------------------------------------------------------ mutate

  async rename(req: RenameRequest): Promise<OpResult> {
    const invalid = validateEntryName(req.newName);
    if (invalid) return { ok: false, code: "UNKNOWN", message: invalid };

    const { runner } = this.runner(req);
    const source = normalizeDir(req.path);
    const destination = joinPath(dirname(source), req.newName.trim());
    if (source === destination) return { ok: true };

    if (await this.exists(runner, req.target, destination)) {
      return { ok: false, code: "CONFLICT", message: `目标已存在：${destination}` };
    }

    const result = await runner.run(req.target, ["mv", source, destination], 60_000);
    if (result.code !== 0) {
      const error = mapStderr(result.stderr);
      return { ok: false, code: error.code, message: error.message };
    }
    return { ok: true };
  }

  async mkdir(req: MkdirRequest): Promise<OpResult> {
    const invalid = validateEntryName(req.name);
    if (invalid) return { ok: false, code: "UNKNOWN", message: invalid };

    const { runner } = this.runner(req);
    const destination = joinPath(normalizeDir(req.dir), req.name.trim());
    const result = await runner.run(req.target, ["mkdir", "-p", destination], 30_000);
    if (result.code !== 0) {
      const error = mapStderr(result.stderr);
      return { ok: false, code: error.code, message: error.message };
    }
    return { ok: true };
  }

  async remove(req: DeleteRequest): Promise<OpResult> {
    const { runner } = this.runner(req);
    for (const item of req.paths) {
      const remotePath = normalizeDir(item);
      if (remotePath === "/" || remotePath === ".") {
        return { ok: false, code: "UNKNOWN", message: "拒绝删除根目录。" };
      }
      const result = await runner.run(req.target, ["rm", "-rf", remotePath], 120_000);
      if (result.code !== 0) {
        const error = mapStderr(result.stderr);
        return { ok: false, code: error.code, message: error.message };
      }
    }
    return { ok: true };
  }

  // ------------------------------------------------------------------ upload

  /**
   * Local (possibly Windows) permissions are not meaningful inside a Linux
   * container: Node reports `0o666` for everything there, which makes uploaded
   * directories untraversable. Always give directories traversal bits.
   */
  private static archiveMode(mode: number, isDir: boolean): number {
    const permission = mode & 0o777;
    if (isDir) return permission | 0o755;
    return permission === 0 ? 0o644 : permission;
  }

  private async *walkLocal(archiveName: string, localPath: string): AsyncGenerator<PackEntry> {
    const stats = await fs.lstat(localPath);
    if (stats.isDirectory()) {
      const mode = PodFsService.archiveMode(stats.mode, true);
      yield { name: archiveName, type: "dir", mode, mtimeMs: stats.mtimeMs };
      const children = await fs.readdir(localPath);
      for (const child of children) {
        yield* this.walkLocal(`${archiveName}/${child}`, path.join(localPath, child));
      }
      return;
    }
    if (stats.isFile()) {
      yield {
        name: archiveName,
        type: "file",
        size: stats.size,
        mode: PodFsService.archiveMode(stats.mode, false),
        mtimeMs: stats.mtimeMs,
        content: createReadStream(localPath),
      };
    }
  }

  private async uniqueRemoteName(runner: ExecRunner, target: PodTarget, dir: string, name: string): Promise<string> {
    const extension = path.posix.extname(name);
    const stem = extension ? name.slice(0, -extension.length) : name;
    for (let index = 1; index < 100; index += 1) {
      const candidate = `${stem} (${index})${extension}`;
      if (!(await this.exists(runner, target, joinPath(dir, candidate)))) return candidate;
    }
    throw new PodFsError("CONFLICT", `无法为 ${name} 找到可用名称`);
  }

  async upload(req: UploadRequest & { taskId: string }): Promise<OpResult> {
    const { runner } = this.runner(req);
    const dir = normalizeDir(req.dir);
    const abort = new AbortController();
    this.aborts.set(req.taskId, abort);

    try {
      const planned: { localPath: string; archiveName: string }[] = [];

      for (const localPath of req.localPaths) {
        const name = path.basename(localPath);
        const remotePath = joinPath(dir, name);
        if (await this.exists(runner, req.target, remotePath)) {
          if (req.onConflict === "skip") continue;
          if (req.onConflict === "rename") {
            planned.push({ localPath, archiveName: await this.uniqueRemoteName(runner, req.target, dir, name) });
            continue;
          }
        }
        planned.push({ localPath, archiveName: name });
      }

      if (planned.length === 0) {
        return { ok: true, message: "全部文件已跳过（目标已存在）。" };
      }

      const self = this;
      const entries = async function* (): AsyncGenerator<PackEntry> {
        for (const item of planned) {
          yield* self.walkLocal(item.archiveName, item.localPath);
        }
      };

      let sent = 0;
      const counter = new CountingTransform((delta) => {
        sent += delta;
        self.opts.onProgress?.({ taskId: req.taskId, phase: "upload", bytes: sent, name: dir });
      });

      const tarStream = createTarStream(entries());
      tarStream.pipe(counter);

      const result = await runner.pipe(req.target, ["tar", "-xf", "-", "-C", dir], {
        input: counter,
        signal: abort.signal,
        timeoutMs: 30 * 60_000,
      });

      if (result.aborted) return { ok: false, code: "CANCELLED", message: "上传已取消。" };
      if (result.code !== 0) {
        const error = mapStderr(result.stderr);
        return { ok: false, code: error.code, message: error.message };
      }

      this.opts.onProgress?.({ taskId: req.taskId, phase: "upload", bytes: sent, done: true, name: dir });
      return { ok: true, message: `已上传 ${planned.length} 项到 ${dir}`, path: dir };
    } finally {
      this.aborts.delete(req.taskId);
    }
  }

  // ---------------------------------------------------------------- download

  async download(req: DownloadRequest & { savePath?: string }): Promise<OpResult> {
    const { runner } = this.runner(req);
    const source = normalizeDir(req.path);
    const parent = dirname(source);
    const name = basename(source);

    let savePath = req.savePath;
    if (!savePath) {
      const suggested = req.isDir ? `${name}.tar.gz` : name;
      savePath = await this.opts.pickSavePath?.(suggested);
    }
    if (!savePath) return { ok: false, code: "CANCELLED", message: "已取消保存。" };

    const abort = new AbortController();
    this.aborts.set(req.taskId, abort);

    try {
      const onBytes = (bytes: number) => {
        this.opts.onProgress?.({ taskId: req.taskId, phase: "download", bytes, name });
      };

      if (req.isDir) {
        const gzip = zlib.createGzip();
        const output = createWriteStream(savePath);
        gzip.pipe(output);

        const result = await runner.pipe(req.target, ["tar", "-cf", "-", "-C", parent, name], {
          output: gzip,
          onBytes,
          signal: abort.signal,
          timeoutMs: 60 * 60_000,
        });
        await finished(output).catch(() => undefined);

        if (result.aborted) return { ok: false, code: "CANCELLED", message: "下载已取消。" };
        if (result.code !== 0) {
          const error = mapStderr(result.stderr);
          return { ok: false, code: error.code, message: error.message };
        }
        this.opts.onProgress?.({ taskId: req.taskId, phase: "download", bytes: result.bytes, done: true, name });
        return { ok: true, message: `已保存到 ${savePath}`, path: savePath };
      }

      const sink = new PassThrough();
      sink.on("error", () => undefined);
      const pipePromise = runner.pipe(req.target, ["tar", "-cf", "-", "-C", parent, name], {
        output: sink,
        onBytes,
        signal: abort.signal,
        timeoutMs: 60 * 60_000,
      });

      const extracted = await readFirstFileEntry(sink);
      if (!extracted) {
        sink.destroy();
        await pipePromise;
        return { ok: false, code: "UNKNOWN", message: `无法读取文件内容：${source}` };
      }

      const output = createWriteStream(savePath);
      await finished(extracted.content.pipe(output));
      sink.destroy();

      const result = await pipePromise;
      if (result.aborted) return { ok: false, code: "CANCELLED", message: "下载已取消。" };
      this.opts.onProgress?.({ taskId: req.taskId, phase: "download", bytes: extracted.size, done: true, name });
      return { ok: true, message: `已保存到 ${savePath}`, path: savePath };
    } finally {
      this.aborts.delete(req.taskId);
    }
  }
}
