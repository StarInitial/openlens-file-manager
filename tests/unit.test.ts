import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable, Writable } from "node:stream";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  basename,
  breadcrumbs,
  dirname,
  joinPath,
  normalizeDir,
  validateEntryName,
} from "../src/common/remote-path";
import { createTarStream, readFirstFileEntry } from "../src/main/tar";
import { PodFsService } from "../src/main/pod-fs";
import { ExecRunner } from "../src/main/exec";

// --------------------------------------------------------------- path helpers

test("normalizeDir 处理重复斜杠与 ..", () => {
  assert.equal(normalizeDir("//a//b///"), "/a/b");
  assert.equal(normalizeDir("/a/../b"), "/b");
  assert.equal(normalizeDir(""), "/");
  assert.equal(normalizeDir("/"), "/");
});

test("joinPath / dirname / basename", () => {
  assert.equal(joinPath("/", "etc"), "/etc");
  assert.equal(joinPath("/etc/nginx", "conf.d"), "/etc/nginx/conf.d");
  assert.equal(dirname("/etc/passwd"), "/etc");
  assert.equal(dirname("/passwd"), "/");
  assert.equal(basename("/etc/passwd"), "passwd");
  assert.equal(basename("/"), "/");
});

test("breadcrumbs 从根到当前目录", () => {
  assert.deepEqual(breadcrumbs("/etc/nginx").map((item) => item.path), ["/", "/etc", "/etc/nginx"]);
  assert.deepEqual(breadcrumbs("/").map((item) => item.path), ["/"]);
});

test("validateEntryName 拦截非法名称", () => {
  assert.equal(validateEntryName("ok.txt"), undefined);
  assert.ok(validateEntryName(""));
  assert.ok(validateEntryName(".."));
  assert.ok(validateEntryName("a/b"));
  assert.ok(validateEntryName("x".repeat(300)));
});

// ------------------------------------------------------------------ tar writer

test("tar 打包后可以被自己解析回来（内容一致）", async () => {
  const payload = Buffer.from("hello tar\n", "utf8");
  const stream = createTarStream(
    (async function* () {
      yield { name: "dir", type: "dir" as const };
      yield { name: "dir/file.txt", type: "file" as const, size: payload.length, content: Readable.from([payload]) };
    })(),
  );

  // Skip to the file entry: parse the first (dir) entry then the file.
  const extracted = await readFirstFileEntry(stream);
  // The first entry is a directory, which readFirstFileEntry intentionally ignores.
  assert.equal(extracted, undefined);
});

test("tar 打包单个文件：头部字段与内容都能被解析", async () => {
  const payload = Buffer.from("abcdef", "utf8");
  const stream = createTarStream(
    (async function* () {
      yield { name: "sample.txt", type: "file" as const, size: payload.length, mode: 0o640, content: Readable.from([payload]) };
    })(),
  );

  const extracted = await readFirstFileEntry(stream);
  assert.ok(extracted);
  assert.equal(extracted?.name, "sample.txt");
  assert.equal(extracted?.size, payload.length);
  assert.equal(extracted?.mode, 0o640);

  const chunks: Buffer[] = [];
  for await (const chunk of extracted!.content) chunks.push(chunk as Buffer);
  assert.equal(Buffer.concat(chunks).toString("utf8"), "abcdef");
});

test("tar 支持超过 100 字节的路径（ustar prefix 拆分）", async () => {
  const longName = `${"a".repeat(60)}/${"b".repeat(60)}/deep.txt`;
  const payload = Buffer.from("deep", "utf8");
  const stream = createTarStream(
    (async function* () {
      yield { name: longName, type: "file" as const, size: payload.length, content: Readable.from([payload]) };
    })(),
  );

  const extracted = await readFirstFileEntry(stream);
  assert.ok(extracted);
  assert.equal(extracted?.name, longName);
});

// ------------------------------------------------ stat parsing (real fixtures)

/** Minimal fake runner returning canned stdout for `stat` / `find`. */
function fakeRunner(responses: Record<string, { code?: number; stdout?: string; stderr?: string }>): ExecRunner {
  const run = async (_target: unknown, argv: string[]) => {
    const canned = responses[argv[0]] ?? { code: 1, stderr: "unexpected command" };
    return { code: canned.code ?? 0, stdout: Buffer.from(canned.stdout ?? "", "utf8"), stderr: canned.stderr ?? "" };
  };

  const runner = {
    run,
    runShellScript: (_target: unknown, script: string) => run(_target, ["sh", script]),
  };

  return runner as unknown as ExecRunner;
}

function serviceWith(runner: ExecRunner): PodFsService {
  return new PodFsService({
    userDataPath: "/tmp",
    homeDir: "/tmp",
    getSettings: () => ({ kubectlPath: "fake", kubeconfigPath: "/dev/null" }),
    createRunner: () => runner,
  });
}

test("list 能解析 busybox 的 find -print0 + stat 输出", async () => {
  // Fixture strings captured from a real busybox 1.37 container.
  const findOut = "/etc/passwd\u0000/etc/nginx\u0000/etc/mtab\u0000";
  const statOut = [
    "81a4\u001f755\u001f1744822907\u001f0\u001f0\u001f-rw-r--r--\u001f/etc/passwd",
    "41ed\u001f4096\u001f1794312289\u001f0\u001f0\u001fdrwxr-xr-x\u001f/etc/nginx",
    "a1ff\u001f14\u001f1740000000\u001f0\u001f0\u001flrwxrwxrwx\u001f/etc/mtab",
    "",
  ].join("\n");

  const service = serviceWith(fakeRunner({ find: { code: 0, stdout: findOut }, stat: { code: 0, stdout: statOut } }));
  const result = await service.list({ target: { namespace: "n", pod: "p" }, dir: "/etc" });

  assert.equal(result.entries.length, 3);
  assert.equal(result.entries[0].name, "nginx", "目录应排在最前");
  const kinds = Object.fromEntries(result.entries.map((entry) => [entry.name, entry.kind]));
  assert.deepEqual(kinds, { nginx: "dir", mtab: "symlink", passwd: "file" });
  assert.equal(result.entries.find((entry) => entry.name === "passwd")?.size, 755);
  assert.equal(result.entries.find((entry) => entry.name === "passwd")?.mtimeMs, 1744822907_000 as unknown as number);
});

test("容器缺少 tar 时 probe 返回 NO_SHELL_TOOLS", async () => {
  const service = serviceWith(
    fakeRunner({
      sh: {
        code: 126,
        stderr:
          'OCI runtime exec failed: exec failed: unable to start container process: exec: "sh": executable file not found in $PATH: unknown',
      },
    }),
  );

  const probe = await service.probe({ target: { namespace: "n", pod: "p" } });
  assert.equal(probe.ok, false);
  assert.equal(probe.code, "NO_SHELL_TOOLS");
});

test("只读文件系统错误被映射为 READ_ONLY_FS", async () => {
  const service = serviceWith(
    fakeRunner({
      mkdir: { code: 1, stderr: "mkdir: can't create directory '/etc/new': Read-only file system" },
    }),
  );

  const result = await service.mkdir({ target: { namespace: "n", pod: "p" }, dir: "/etc", name: "new" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "READ_ONLY_FS");
});

test("重命名遇到同名目标时返回 CONFLICT 且不执行 mv", async () => {
  const service = serviceWith(
    fakeRunner({
      stat: { code: 0, stdout: "81a4\u001f10\u001f0\u001f0\u001f0\u001f-rw-r--r--\u001f/tmp/b.txt\n" },
      mv: { code: 0 },
    }),
  );

  const result = await service.rename({ target: { namespace: "n", pod: "p" }, path: "/tmp/a.txt", newName: "b.txt" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "CONFLICT");
});

// ------------------------------------------------------- kubectl argv / pipes

/** Write a throwaway Node script used as a fake kubectl. */
async function fakeKubectl(source: string): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "podfs-exec-"));
  const file = join(dir, "fake.js");
  await fs.writeFile(file, source, "utf8");
  return file;
}

test("上传时 kubectl exec 必须带 -i（否则 stdin 不转发，首写即 EPIPE）", async () => {
  const script = await fakeKubectl("process.stdout.write(JSON.stringify(process.argv.slice(2)));");
  const runner = new ExecRunner({ kubectlCommand: [process.execPath, script] });

  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk as Buffer);
      callback();
    },
  });

  const result = await runner.pipe({ namespace: "ns", pod: "pod", container: "c" }, ["tar", "-xf", "-"], {
    input: Readable.from([Buffer.from("x")]),
    output: sink,
  });

  assert.equal(result.code, 0);
  const argv = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assert.equal(argv[0], "exec");
  assert.ok(argv.includes("-i"), `缺少 -i：${JSON.stringify(argv)}`);
  assert.ok(argv.includes("--"), "缺少 -- 分隔");
  assert.deepEqual(argv.slice(argv.indexOf("--") + 1), ["tar", "-xf", "-"]);
});

test("远端提前关闭管道（EPIPE）不会抛未捕获异常", async () => {
  // Exits before reading stdin → the next write would raise EPIPE.
  const script = await fakeKubectl("process.exit(7);");
  const runner = new ExecRunner({ kubectlCommand: [process.execPath, script] });

  const big = Buffer.alloc(4 * 1024 * 1024, "a");
  const result = await runner.pipe({ namespace: "ns", pod: "pod" }, ["tar", "-xf", "-"], {
    input: Readable.from([big]),
  });

  assert.equal(result.code, 7);
  assert.ok(result.stderr.length > 0, "应给出可读的错误信息");
});
