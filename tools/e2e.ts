/**
 * Local end-to-end test for the main-process file manager.
 *
 * A fake kubectl shim (`tools/fake-kubectl.js`) executes commands inside WSL, so
 * this exercises the real command construction, tar packing/extraction and stat
 * parsing against a live Linux userspace — with NO Kubernetes cluster involved.
 *
 * Usage: npm run test:e2e
 */
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";

import { PodFsService } from "../src/main/pod-fs";
import { ExecRunner } from "../src/main/exec";
import type { ProgressEvent } from "../src/common/types";

const FAKE_KUBECTL = join(__dirname, "..", "..", "tools", "fake-kubectl.js");
const SANDBOX = `/tmp/podfs-e2e-${Date.now()}`;
const target = { namespace: "test-ns", pod: "test-pod", container: "main" };
const ctx = { target };

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}`);
    if (detail !== undefined) console.log(`    实际值: ${JSON.stringify(detail)}`);
  }
}

/** Run a command inside WSL (test scaffolding only — not the code under test). */
function wsl(command: string[]): { code: number | null; stdout: string; stderr: string } {
  const distro = process.env.PODFS_WSL_DISTRO;
  const args = distro ? ["-d", distro, "-e", ...command] : ["-e", ...command];
  const result = spawnSync("wsl.exe", args, { encoding: "utf8" });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function main(): Promise<void> {
  // ------------------------------------------------------------------ fixture
  console.log(`准备 WSL 沙箱：${SANDBOX}`);
  const setup = wsl([
    "sh",
    "-c",
    [
      `mkdir -p "${SANDBOX}/etc/sub"`,
      `printf 'root:x:0:0:root:/root:/bin/sh\\n' > "${SANDBOX}/etc/passwd"`,
      `printf 'hello\\n' > "${SANDBOX}/etc/hostname"`,
      `printf 'nested\\n' > "${SANDBOX}/etc/sub/inner.txt"`,
      `touch "${SANDBOX}/etc/.hidden"`,
      `ln -sf ../passwd "${SANDBOX}/etc/shadow-link"`,
      `printf 'spaced\\n' > "${SANDBOX}/etc/文件 名.txt"`,
      `head -c 1000000 /dev/urandom > "${SANDBOX}/etc/blob.bin"`,
    ].join(" && "),
  ]);
  if (setup.code !== 0) {
    console.error("无法创建 WSL 沙箱：", setup.stderr);
    process.exit(1);
  }
  const expectedPasswdSize = Number(wsl(["stat", "-c", "%s", `${SANDBOX}/etc/passwd`]).stdout.trim());

  const progress: ProgressEvent[] = [];
  const service = new PodFsService({
    userDataPath: tmpdir(),
    homeDir: homedir(),
    getSettings: () => ({ kubectlPath: "fake", kubeconfigPath: "/dev/null", contextName: "fake" }),
    createRunner: (options) => new ExecRunner({ ...options, kubectlCommand: [process.execPath, FAKE_KUBECTL] }),
    onProgress: (event) => progress.push(event),
    pickSavePath: async (name) => join(await fs.mkdtemp(join(tmpdir(), "podfs-dl-")), name),
  });

  // -------------------------------------------------------------------- probe
  console.log("\n[probe]");
  const probe = await service.probe(ctx);
  check("probe 成功", probe.ok, probe);
  check("探测到 tar/stat/find/sh", probe.tools.tar && probe.tools.stat && probe.tools.find, probe.tools);

  // --------------------------------------------------------------------- list
  console.log("\n[list]");
  const listing = await service.list({ ...ctx, dir: `${SANDBOX}/etc` });
  const names = listing.entries.map((entry) => entry.name);
  check("列出全部 7 项", listing.entries.length === 7, names);
  check("目录排在文件前", listing.entries[0]?.name === "sub" && listing.entries[0]?.kind === "dir", names);
  const kindOf = (name: string) => listing.entries.find((entry) => entry.name === name)?.kind;
  check("识别 file/dir/symlink", kindOf("passwd") === "file" && kindOf("sub") === "dir" && kindOf("shadow-link") === "symlink", {
    passwd: kindOf("passwd"),
    sub: kindOf("sub"),
    link: kindOf("shadow-link"),
  });
  check("带空格与中文的文件名完整", names.includes("文件 名.txt"), names);

  console.log("\n[list 隐藏文件]");
  const hidden = await service.list({ ...ctx, dir: `${SANDBOX}/etc`, showHidden: false });
  check("showHidden=false 过滤点文件", !hidden.entries.some((entry) => entry.name.startsWith(".")), hidden.entries.map((e) => e.name));

  // --------------------------------------------------------------------- stat
  console.log("\n[stat]");
  const stat = await service.stat({ ...ctx, path: `${SANDBOX}/etc/passwd` });
  check("stat 大小与真实文件一致", stat?.size === expectedPasswdSize, { got: stat?.size, expected: expectedPasswdSize });
  check("stat 权限位可读", stat?.mode?.startsWith("-rw") === true, stat?.mode);
  const linkStat = await service.stat({ ...ctx, path: `${SANDBOX}/etc/shadow-link` });
  check("符号链接解析出目标", linkStat?.linkTarget?.includes("passwd") === true, linkStat?.linkTarget);

  // ----------------------------------------------------------------- download
  console.log("\n[download 单文件]");
  const fileSave = join(await fs.mkdtemp(join(tmpdir(), "podfs-dl-")), "hostname");
  const fileResult = await service.download({ ...ctx, path: `${SANDBOX}/etc/hostname`, isDir: false, taskId: "t-dl", savePath: fileSave });
  const content = fileResult.ok ? await fs.readFile(fileSave, "utf8") : "";
  check("下载内容一致", fileResult.ok && content === "hello\n", { result: fileResult, content });

  console.log("\n[download 二进制 1MB]");
  const binSave = join(await fs.mkdtemp(join(tmpdir(), "podfs-dl-")), "blob.bin");
  const binResult = await service.download({ ...ctx, path: `${SANDBOX}/etc/blob.bin`, isDir: false, taskId: "t-dl-bin", savePath: binSave });
  const binSize = binResult.ok ? (await fs.stat(binSave)).size : -1;
  check("二进制文件字节数一致", binSize === 1_000_000, binSize);

  console.log("\n[download 目录 → tar.gz]");
  const tarSave = join(await fs.mkdtemp(join(tmpdir(), "podfs-dl-")), "etc.tar.gz");
  const dirResult = await service.download({ ...ctx, path: `${SANDBOX}/etc`, isDir: true, taskId: "t-dl-dir", savePath: tarSave });
  let archiveEntries: string[] = [];
  if (dirResult.ok) {
    const raw = zlib.gunzipSync(await fs.readFile(tarSave));
    archiveEntries = raw.toString("latin1").match(/etc\/[A-Za-z0-9._-]+/g) ?? [];
  }
  check("目录归档包含子文件", dirResult.ok && archiveEntries.includes("etc/passwd"), archiveEntries.slice(0, 8));

  // ------------------------------------------------------------------- upload
  console.log("\n[upload 单文件]");
  const upDir = await fs.mkdtemp(join(tmpdir(), "podfs-up-"));
  const localFile = join(upDir, "上传 文件.txt");
  await fs.writeFile(localFile, "uploaded-content\n", "utf8");
  const upResult = await service.upload({ ...ctx, dir: `${SANDBOX}/etc`, localPaths: [localFile], onConflict: "overwrite", taskId: "t-up" });
  const afterUpload = await service.list({ ...ctx, dir: `${SANDBOX}/etc` });
  const uploadedEntry = afterUpload.entries.find((entry) => entry.name === "上传 文件.txt");
  check("上传成功且大小一致", upResult.ok && uploadedEntry?.size === 17, { result: upResult, entry: uploadedEntry });
  const remoteBytes = wsl(["cat", `${SANDBOX}/etc/上传 文件.txt`]).stdout;
  check("上传内容逐字节一致", remoteBytes === "uploaded-content\n", remoteBytes);

  console.log("\n[upload 冲突策略]");
  const skipResult = await service.upload({ ...ctx, dir: `${SANDBOX}/etc`, localPaths: [localFile], onConflict: "skip", taskId: "t-up-skip" });
  check("skip 策略直接返回成功", skipResult.ok === true, skipResult);
  const renameResult = await service.upload({ ...ctx, dir: `${SANDBOX}/etc`, localPaths: [localFile], onConflict: "rename", taskId: "t-up-rename" });
  const afterRenamePolicy = await service.list({ ...ctx, dir: `${SANDBOX}/etc` });
  check("rename 策略生成新名字", renameResult.ok && afterRenamePolicy.entries.some((e) => e.name === "上传 文件 (1).txt"), afterRenamePolicy.entries.map((e) => e.name));

  console.log("\n[upload 目录递归]");
  const tree = join(upDir, "tree");
  await fs.mkdir(join(tree, "a", "b"), { recursive: true });
  await fs.writeFile(join(tree, "1.txt"), "1", "utf8");
  await fs.writeFile(join(tree, "a", "b", "2.txt"), "2", "utf8");
  const treeResult = await service.upload({ ...ctx, dir: SANDBOX, localPaths: [tree], onConflict: "overwrite", taskId: "t-up-tree" });
  const deepList = await service.list({ ...ctx, dir: `${SANDBOX}/tree/a/b` });
  check("目录结构递归上传", treeResult.ok && deepList.entries.some((e) => e.name === "2.txt"), deepList.entries.map((e) => e.name));

  // ------------------------------------------------------------------ rename
  console.log("\n[rename]");
  const renameOp = await service.rename({ ...ctx, path: `${SANDBOX}/etc/上传 文件.txt`, newName: "改名后.txt" });
  const afterRename = await service.list({ ...ctx, dir: `${SANDBOX}/etc` });
  check("重命名成功", renameOp.ok && afterRename.entries.some((e) => e.name === "改名后.txt"), renameOp);
  const conflictRename = await service.rename({ ...ctx, path: `${SANDBOX}/etc/改名后.txt`, newName: "passwd" });
  check("目标已存在时拒绝", conflictRename.ok === false && conflictRename.code === "CONFLICT", conflictRename);

  // ------------------------------------------------------------------- mkdir
  console.log("\n[mkdir]");
  const mkdirOp = await service.mkdir({ ...ctx, dir: `${SANDBOX}/etc`, name: "新建 目录" });
  const afterMkdir = await service.list({ ...ctx, dir: `${SANDBOX}/etc` });
  check("新建目录成功", mkdirOp.ok && afterMkdir.entries.some((e) => e.name === "新建 目录" && e.kind === "dir"), mkdirOp);
  const badMkdir = await service.mkdir({ ...ctx, dir: `${SANDBOX}/etc`, name: "bad/name" });
  check("含 / 的名称被拒绝", badMkdir.ok === false, badMkdir);

  // ------------------------------------------------------------------ remove
  console.log("\n[remove]");
  const removeOp = await service.remove({ ...ctx, paths: [`${SANDBOX}/etc/改名后.txt`, `${SANDBOX}/etc/新建 目录`, `${SANDBOX}/tree`] });
  const afterRemove = await service.list({ ...ctx, dir: `${SANDBOX}/etc` });
  check("删除文件与目录", removeOp.ok && !afterRemove.entries.some((e) => e.name === "改名后.txt"), removeOp);
  const rootRemove = await service.remove({ ...ctx, paths: ["/"] });
  check("拒绝删除根目录", rootRemove.ok === false, rootRemove);

  // ---------------------------------------------------------------- 错误处理
  console.log("\n[错误处理]");
  let missingError: unknown;
  try {
    await service.list({ ...ctx, dir: `${SANDBOX}/does-not-exist` });
  } catch (error) {
    missingError = error;
  }
  check("不存在的目录抛出 NOT_FOUND", (missingError as { code?: string } | undefined)?.code === "NOT_FOUND", String(missingError));

  // ----------------------------------------------------------------- cleanup
  console.log("\n[汇总]");
  console.log(`progress 事件 ${progress.length} 条`);
  console.log(`通过 ${passed}，失败 ${failed}`);
  wsl(["rm", "-rf", SANDBOX]);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch(async (error) => {
  console.error("\n测试异常中断：", error);
  wsl(["rm", "-rf", SANDBOX]);
  process.exitCode = 1;
});
