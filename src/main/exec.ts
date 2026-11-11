import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { Readable, Writable } from "node:stream";

import type { PodTarget } from "../common/types";

export interface ExecRunnerOptions {
  /**
   * Command prefix used to invoke kubectl, e.g. `["/usr/bin/kubectl"]`.
   * An array so tests can substitute a shim (`[nodeExe, fakeKubectlJs]`).
   */
  kubectlCommand: string[];
  kubeconfigPath?: string;
  contextName?: string;
}

export interface RunResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

export interface PipeOptions {
  input?: Readable | null;
  output?: Writable | null;
  /** Called with the number of bytes written to `output` (or read from stdout). */
  onBytes?: (bytes: number) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface PipeResult {
  code: number | null;
  bytes: number;
  stderr: string;
  aborted: boolean;
}

const MAX_CAPTURED_STDOUT = 8 * 1024 * 1024;

/**
 * Runs commands inside a pod with `kubectl exec`.
 *
 * The command is always passed as an argv array (never through a shell), so
 * container paths can contain spaces, quotes, newlines or Unicode safely.
 */
export class ExecRunner {
  constructor(private readonly opts: ExecRunnerOptions) {}

  get kubeconfigPath(): string | undefined {
    return this.opts.kubeconfigPath;
  }

  get contextName(): string | undefined {
    return this.opts.contextName;
  }

  private spawnFor(target: PodTarget, argv: string[], shellStdio: boolean, withStdin = false): ChildProcess {
    const [command, ...prefix] = this.opts.kubectlCommand;
    if (!command) throw new Error("kubectl 命令为空");

    const args: string[] = [...prefix];
    if (this.opts.kubeconfigPath) args.push("--kubeconfig", this.opts.kubeconfigPath);
    if (this.opts.contextName) args.push("--context", this.opts.contextName);
    // `-i` is required for kubectl to forward stdin; without it the remote command
    // never reads our pipe and kubectl exits → EPIPE on the first write.
    args.push("exec", ...(withStdin ? ["-i"] : []), "-n", target.namespace, target.pod);
    if (target.container) args.push("-c", target.container);
    args.push("--", ...argv);

    return spawn(command, args, {
      stdio: shellStdio ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  }

  /** Run a command and capture its (small) output. */
  async run(target: PodTarget, argv: string[], timeoutMs = 30_000): Promise<RunResult> {
    const child = this.spawnFor(target, argv, false);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let captured = 0;

    child.stdout?.on("data", (chunk: Buffer) => {
      if (captured < MAX_CAPTURED_STDOUT) {
        stdout.push(chunk);
        captured += chunk.length;
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    try {
      const [code] = (await once(child, "close")) as [number | null];
      return { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString("utf8") };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Run `sh -c <script>` for fixed scripts only (never with user input inside). */
  async runShellScript(target: PodTarget, script: string, timeoutMs = 30_000): Promise<RunResult> {
    return this.run(target, ["sh", "-c", script], timeoutMs);
  }

  /** Stream bytes into the command (upload) and/or out of it (download). */
  async pipe(target: PodTarget, argv: string[], options: PipeOptions = {}): Promise<PipeResult> {
    const child = this.spawnFor(target, argv, true, true);
    const stderrChunks: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    /**
     * The remote side can close the pipe early (missing tar, read-only fs, OOM …).
     * Node then raises EPIPE on the next write — it must never escape as an
     * uncaught exception, or it takes the whole main process down with a
     * "A JavaScript error occurred in the main process" dialog.
     */
    let pipeBroken: Error | undefined;
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      pipeBroken = error;
      options.input?.destroy();
    });
    child.stdout?.on("error", () => undefined);

    const abort = () => {
      child.kill("SIGKILL");
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = options.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), options.timeoutMs) : undefined;

    let bytes = 0;
    const stdoutStream = child.stdout;
    if (stdoutStream) {
      stdoutStream.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        options.onBytes?.(bytes);
      });
      if (options.output) {
        stdoutStream.pipe(options.output);
      } else {
        stdoutStream.resume();
      }
    }

    if (options.input) {
      options.input.on("error", () => child.stdin?.destroy());
      // Stop reading the local source if the remote end hung up.
      child.stdin?.on("close", () => options.input?.destroy());
      options.input.pipe(child.stdin!);
    } else {
      child.stdin?.end();
    }

    try {
      const [code] = (await once(child, "close")) as [number | null];
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      return {
        code,
        bytes,
        stderr:
          stderr.trim().length > 0
            ? stderr
            : pipeBroken
              ? `管道提前关闭（${(pipeBroken as NodeJS.ErrnoException).code ?? "EPIPE"}）：容器端命令已退出，通常是容器内缺少 tar 或磁盘不可写。`
              : stderr,
        aborted: options.signal?.aborted ?? false,
      };
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }
}
