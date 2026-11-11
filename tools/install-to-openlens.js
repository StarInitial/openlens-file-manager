#!/usr/bin/env node
/**
 * Installs the built extension into the running OpenLens installation so it can
 * be loaded on the next start.
 *
 * OpenLens 6.x needs the extension in TWO places at once:
 *   1. `<userData>/node_modules/<name>/`               → registry `id` / manifestPath
 *   2. `<home>/.k8slens/extensions/<publisher>--<name>/` → discovery `absolutePath`
 * plus an entry in `<userData>/lens-extensions.json`.
 * Verified against an extension that OpenLens itself installed: both copies are
 * plain directories with identical contents.
 *
 * Note: the host does NOT resolve `@k8slens/extensions` from the extension
 * folder, which is why the bundles reference the `global.LensExtensions` global.
 *
 * Usage: npm run install:local   (after `npm run build`)
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const EXTENSION_NAME = "pod-file-manager";

const roaming = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
const userData = process.env.PODFS_OPENLENS_USER_DATA ?? path.join(roaming, "OpenLens");
const projectRoot = path.join(__dirname, "..");
const targetDir = path.join(userData, "node_modules", EXTENSION_NAME);
const manifestPath = path.join(targetDir, "package.json");
const home = os.homedir();
const extensionsRoot = process.env.PODFS_EXTENSIONS_DIR ?? path.join(home, ".k8slens", "extensions");
const discoveryDir = path.join(extensionsRoot, `openlens--${EXTENSION_NAME}`);

if (!fs.existsSync(path.join(projectRoot, "dist", "main.js"))) {
  console.error("dist/main.js 不存在，请先运行 npm run build");
  process.exit(1);
}
if (!fs.existsSync(userData)) {
  console.error(`找不到 OpenLens 数据目录：${userData}`);
  process.exit(1);
}

function copyPayload(destination) {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  for (const file of ["package.json", "README.md"]) {
    fs.copyFileSync(path.join(projectRoot, file), path.join(destination, file));
  }
  fs.cpSync(path.join(projectRoot, "dist"), path.join(destination, "dist"), { recursive: true });
}

copyPayload(targetDir);
copyPayload(discoveryDir);

const storePath = path.join(userData, "lens-extensions.json");
let store = { extensions: [] };
if (fs.existsSync(storePath)) {
  store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  store.extensions = Array.isArray(store.extensions) ? store.extensions : [];
}

const normalize = (value) => path.resolve(value).toLowerCase();
const existing = store.extensions.find((entry) => normalize(entry[0]) === normalize(manifestPath));
if (existing) {
  existing[1] = { ...existing[1], enabled: true, name: EXTENSION_NAME };
} else {
  store.extensions.push([manifestPath, { enabled: true, name: EXTENSION_NAME }]);
}

fs.writeFileSync(storePath, JSON.stringify(store, null, "\t"));

console.log(`已安装到：${targetDir}`);
console.log(`已安装到：${discoveryDir}`);
console.log(`已登记到：${storePath}`);
console.log("请重启 OpenLens（先完全退出，含托盘）生效。");
