#!/usr/bin/env node
/**
 * Builds distributable artifacts into `artifacts/`:
 *
 *   1. pod-file-manager-<version>.tgz      npm tarball — what the OpenLens
 *                                          Extensions page accepts (drag & drop)
 *   2. pod-file-manager-<version>.tar.gz   portable archive with a top-level
 *                                          folder, for manual installation
 *   3. SHA256SUMS.txt                      checksums for both
 *
 * The tar writer below (ustar + gzip) keeps the result independent of a system
 * `tar` binary.
 *
 * Usage: npm run pack:dist
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "artifacts");
const BLOCK = 512;

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const FOLDER = pkg.name + "-" + pkg.version;

// ------------------------------------------------------------------ tar writer

function writeAscii(buf, offset, length, value) {
  const bytes = Buffer.from(value, "utf8");
  bytes.copy(buf, offset, 0, Math.min(bytes.length, length));
}

function writeOctal(buf, offset, length, value) {
  const text = Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, "0").slice(-(length - 1));
  buf.write(text + "\0", offset, length, "ascii");
}

function splitName(name) {
  if (Buffer.byteLength(name, "utf8") <= 100) return { name, prefix: "" };
  for (let i = name.length - 1; i > 0; i -= 1) {
    if (name[i] !== "/") continue;
    const prefix = name.slice(0, i);
    const suffix = name.slice(i + 1);
    if (!suffix || Buffer.byteLength(suffix) > 100 || Buffer.byteLength(prefix) > 155) continue;
    return { name: suffix, prefix };
  }
  throw new Error("路径过长，无法打包：" + name);
}

function header(name, size, mode, mtime) {
  const buf = Buffer.alloc(BLOCK, 0);
  const isDir = name.endsWith("/");
  const split = splitName(name);

  writeAscii(buf, 0, 100, split.name);
  writeOctal(buf, 100, 8, mode);
  writeOctal(buf, 108, 8, 0);
  writeOctal(buf, 116, 8, 0);
  writeOctal(buf, 124, 12, size);
  writeOctal(buf, 136, 12, mtime);
  writeAscii(buf, 148, 8, "        ");
  writeAscii(buf, 156, 1, isDir ? "5" : "0");
  writeAscii(buf, 257, 6, "ustar\0");
  writeAscii(buf, 263, 2, "00");
  writeAscii(buf, 345, 155, split.prefix);

  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return buf;
}

function padding(size) {
  const remainder = size % BLOCK;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - remainder, 0);
}

function createTar(entries) {
  const chunks = [];
  const mtime = Math.floor(Date.now() / 1000);

  for (const entry of entries) {
    if (entry.dir) {
      chunks.push(header(entry.name.endsWith("/") ? entry.name : entry.name + "/", 0, 0o755, mtime));
      continue;
    }
    const data = fs.readFileSync(entry.absolute);
    chunks.push(header(entry.name, data.length, 0o644, mtime));
    chunks.push(data);
    chunks.push(padding(data.length));
  }

  chunks.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(chunks);
}

// --------------------------------------------------------------------- payload

function collectFiles(dir, prefix) {
  const result = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, item.name);
    const name = prefix + "/" + item.name;
    if (item.isDirectory()) {
      result.push({ name, dir: true });
      result.push(...collectFiles(absolute, name));
    } else {
      result.push({ name, absolute });
    }
  }
  return result;
}

function installNote() {
  const lines = [
    "# Pod 文件管理器 " + pkg.version + " · 安装说明",
    "",
    "## 方式一：用 OpenLens 扩展页面安装（推荐）",
    "",
    "使用同目录下的 " + pkg.name + "-" + pkg.version + ".tgz。",
    "",
    "1. 打开 OpenLens → File → Extensions（macOS: OpenLens → Extensions）",
    "2. 把 .tgz 拖进窗口，或点击 Install 选择该文件",
    "3. 重启 OpenLens",
    "",
    "## 方式二：手动安装（本 tar.gz）",
    "",
    "OpenLens 6.5 需要两处同时存在才会加载扩展：",
    "",
    "1. 解压本包，把 " + FOLDER + "/ 的内容复制到 userData 的 node_modules：",
    "   - Windows: %APPDATA%\\OpenLens\\node_modules\\" + pkg.name,
    "   - macOS:   ~/Library/Application Support/OpenLens/node_modules/" + pkg.name,
    "   - Linux:   ~/.config/OpenLens/node_modules/" + pkg.name,
    "",
    "2. 再复制一份到扩展发现目录：",
    "   - Windows: %USERPROFILE%\\.k8slens\\extensions\\" + FOLDER,
    "   - macOS/Linux: ~/.k8slens/extensions/" + FOLDER,
    "",
    "3. userData 下的 lens-extensions.json 里确认有该条目：",
    '   ["<绝对路径>/node_modules/' + pkg.name + '/package.json", { "enabled": true, "name": "' + pkg.name + '" }]',
    "",
    "4. 完全退出并重启 OpenLens",
    "",
    "## 使用",
    "",
    "Pod 详情页右上角工具栏 → 文件夹图标 → 打开全屏文件管理器。",
    "支持：浏览、文件信息、重命名、上传、下载、新建目录、删除。",
    "",
    "## 权限",
    "",
    "需要目标命名空间的 pods/exec 权限，例如：",
    "",
    "    apiVersion: rbac.authorization.k8s.io/v1",
    "    kind: Role",
    "    metadata:",
    "      namespace: <ns>",
    "    rules:",
    '      - apiGroups: [""]',
    '        resources: ["pods/exec"]',
    '        verbs: ["create", "get"]',
    "",
    "详细说明见 README.md。",
    "",
  ];
  return lines.join("\n");
}

// ------------------------------------------------------------------------ main

function main() {
  if (!fs.existsSync(path.join(ROOT, "dist", "main.js"))) {
    console.error("dist/main.js 不存在，请先运行 npm run build");
    process.exit(1);
  }

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const entries = [
    { name: FOLDER + "/", dir: true },
    { name: FOLDER + "/package.json", absolute: path.join(ROOT, "package.json") },
    { name: FOLDER + "/README.md", absolute: path.join(ROOT, "README.md") },
    { name: FOLDER + "/dist/", dir: true },
    ...collectFiles(path.join(ROOT, "dist"), FOLDER + "/dist"),
  ];

  const notePath = path.join(OUT_DIR, "INSTALL.md");
  fs.writeFileSync(notePath, installNote(), "utf8");
  entries.push({ name: FOLDER + "/INSTALL.md", absolute: notePath });

  const tarGzPath = path.join(OUT_DIR, FOLDER + ".tar.gz");
  fs.writeFileSync(tarGzPath, zlib.gzipSync(createTar(entries), { level: 9 }));
  fs.rmSync(notePath, { force: true });

  // npm-style tarball (top-level `package/`) — the format the Extensions page
  // imports when the user drags a .tgz in. Written with the same tar writer so
  // the build does not need to spawn `npm pack`.
  const tgzName = FOLDER + ".tgz";
  const tgzEntries = [
    { name: "package/", dir: true },
    { name: "package/package.json", absolute: path.join(ROOT, "package.json") },
    { name: "package/README.md", absolute: path.join(ROOT, "README.md") },
    { name: "package/dist/", dir: true },
    ...collectFiles(path.join(ROOT, "dist"), "package/dist"),
  ];
  fs.writeFileSync(path.join(OUT_DIR, tgzName), zlib.gzipSync(createTar(tgzEntries), { level: 9 }));

  const artifacts = fs
    .readdirSync(OUT_DIR)
    .filter((name) => name.endsWith(".tar.gz") || name.endsWith(".tgz"))
    .sort();

  const sums = artifacts.map((name) => {
    const digest = crypto.createHash("sha256").update(fs.readFileSync(path.join(OUT_DIR, name))).digest("hex");
    return digest + "  " + name;
  });
  fs.writeFileSync(path.join(OUT_DIR, "SHA256SUMS.txt"), sums.join("\n") + "\n", "utf8");

  console.log("打包完成 → " + OUT_DIR);
  for (const name of artifacts) {
    const size = fs.statSync(path.join(OUT_DIR, name)).size;
    console.log("  " + name + "  (" + (size / 1024).toFixed(1) + " KB)");
  }
  console.log("  SHA256SUMS.txt");
  if (tgzName) console.log("\n扩展页面安装用：" + path.join(OUT_DIR, tgzName));
}

main();
