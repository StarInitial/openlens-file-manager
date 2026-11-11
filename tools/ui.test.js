#!/usr/bin/env node
/**
 * Interaction tests for the full-screen Pod file manager, in a real DOM (jsdom).
 *
 * The only entry point is the folder icon in the Pod details header, so every
 * test goes through that path: click the toolbar item → full-screen overlay →
 * assert inside the overlay.
 *
 * Covers: listing, action column, info/rename/delete dialogs, download modal with
 * progress, double-click navigation, loading skeleton + overlay, race guard, and
 * that closing the viewer removes it cleanly.
 *
 * Usage: npm run test:ui   (after `npm run build`)
 */
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>");
const { window } = dom;

global.window = window;
global.document = window.document;
global.navigator = window.navigator;
global.HTMLElement = window.HTMLElement;
global.Node = window.Node;
global.Event = window.Event;
global.MouseEvent = window.MouseEvent;
global.KeyboardEvent = window.KeyboardEvent;
global.getComputedStyle = window.getComputedStyle;
global.requestAnimationFrame = (callback) => setTimeout(callback, 16);
global.cancelAnimationFrame = (handle) => clearTimeout(handle);
window.requestAnimationFrame = global.requestAnimationFrame;
window.cancelAnimationFrame = global.cancelAnimationFrame;

// ------------------------------------------------------------------ host stubs

function entry(kind, fullPath, size = 0) {
  const name = fullPath.slice(fullPath.lastIndexOf("/") + 1);
  return {
    name,
    path: fullPath,
    kind,
    size,
    mode: kind === "dir" ? "drwxr-xr-x" : "-rw-r--r--",
    rawMode: kind === "dir" ? "41ed" : "81a4",
    mtimeMs: 1_700_000_000_000,
    uid: 0,
    gid: 0,
  };
}

const FIXTURES = {
  "/": [entry("dir", "/aaa"), entry("dir", "/bbb"), entry("dir", "/etc"), entry("file", "/readme.txt", 12)],
  "/aaa": [entry("file", "/aaa/aaa-only.txt", 3)],
  "/bbb": [entry("file", "/bbb/bbb-only.txt", 3)],
  "/etc": [entry("dir", "/etc/nginx"), entry("file", "/etc/passwd", 30)],
  "/etc/nginx": [entry("file", "/etc/nginx/nginx.conf", 7)],
};

const listCalls = [];
const listRequests = [];
const delayFor = { "/aaa": 120 };
const actionCalls = [];
let pendingDownload;
let progressHandler;

const fakeIpc = {
  async invoke(channel, request) {
    if (channel === "podfs:probe") {
      return { ok: true, tools: { tar: true, stat: true, find: true }, canWrite: true };
    }
    if (channel === "podfs:list") {
      listCalls.push(request.dir);
      listRequests.push({ dir: request.dir, container: request.target?.container });
      await new Promise((resolve) => setTimeout(resolve, delayFor[request.dir] ?? 0));
      return { dir: request.dir, entries: FIXTURES[request.dir] ?? [] };
    }
    if (channel === "podfs:stat") {
      return Object.values(FIXTURES).flat().find((item) => item.path === request.path);
    }
    if (channel === "podfs:download") {
      pendingDownload = { request };
      return new Promise((resolve) => {
        pendingDownload.resolve = resolve;
      });
    }
    actionCalls.push({ channel, request });
    return { ok: true };
  },
  listen(_channel, handler) {
    progressHandler = handler;
    return () => {
      progressHandler = undefined;
    };
  },
  broadcast() {
    return undefined;
  },
};

const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === "electron") {
    return { app: { getPath: () => "/tmp" }, dialog: { showSaveDialog: async () => ({ canceled: true }) } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

class FakeIpcBase {}

global.LensExtensions = {
  Main: { LensExtension: class {}, Ipc: FakeIpcBase, Catalog: {}, K8sApi: {}, Navigation: {}, Power: {} },
  Common: { Catalog: {} },
  Renderer: {
    LensExtension: class {},
    Ipc: class extends FakeIpcBase {
      static createInstance() {
        return fakeIpc;
      }
    },
    Component: {},
    K8sApi: {},
  },
};

global.React = require("react");
global.ReactDOM = require("react-dom");
global.Mobx = require("mobx");
global.MobxReact = require("mobx-react");

const React = global.React;
const ReactDOM = require("react-dom");
const { act } = require("react-dom/test-utils");

// ---------------------------------------------------------------------- utils

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The full-screen overlay (portal target lives on document.body). */
const panel = () => document.querySelector('[data-testid="podfs-fullscreen"]');

const rows = () => Array.from(panel().querySelectorAll('tr[data-entry="true"]'));
const skeletonRows = () => Array.from(panel().querySelectorAll('tr[data-skeleton="true"]'));

function rowNames() {
  return rows().map((row) => (row.querySelector("td")?.textContent ?? "").replace(/\[[a-z_]+\]/g, "").trim());
}

function findRow(name) {
  return rows().find((row) => row.textContent.includes(name));
}

function actionsOf(row) {
  return Array.from(row.querySelectorAll("a[data-action]")).map((node) => node.getAttribute("data-action"));
}

function findButton(label) {
  return Array.from(panel().querySelectorAll("button, a")).find((node) => node.textContent.trim() === label);
}

async function flush(ms = 0) {
  await act(async () => {
    await sleep(ms);
  });
}

async function click(node) {
  assert.ok(node, "要点击的节点不存在");
  await act(async () => {
    node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
}

/** Type into a controlled React input: native value setter + `input` event. */
async function typeInto(input, value) {
  assert.ok(input, "要输入的元素不存在");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

async function pressKey(node, key) {
  assert.ok(node, "要按键的元素不存在");
  await act(async () => {
    node.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

/** Real double clicks fire click before dblclick — emulate that (the drawer's
 *  outside-click rule listens for `click`). */
async function doubleClick(row) {
  await act(async () => {
    row.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    row.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
  });
}

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n    ${error.message}`);
  }
}

// ----------------------------------------------------------------------- main

async function main() {
  const rendererModule = require(path.join(__dirname, "..", "dist", "renderer.js"));
  const RendererClass = rendererModule.default ?? rendererModule;
  const renderer = new RendererClass();
  await renderer.onActivate();

  const fakePod = {
    getNs: () => "lga-agent",
    getName: () => "demo-pod",
    metadata: { namespace: "lga-agent", name: "demo-pod", annotations: {} },
    spec: { containers: [{ name: "main" }, { name: "sidecar" }] },
  };

  // Mount ONLY the details header slot. The overlay must be rendered by the
  // toolbar item itself — relying on a status bar host made clicking a no-op.
  // Emulate OpenLens' details drawer (window click listener, bubble phase):
  //   if (!open || evt.defaultPrevented || contentElem.contains(mouseDownTarget)) return;
  //   if (!evt.target.closest(".Drawer")) close();
  // The last check runs *after* React handled the click, so a button that
  // unmounts its own dialog looks detached and used to close the drawer.
  const drawer = document.createElement("div");
  drawer.className = "Drawer";
  document.body.appendChild(drawer);

  let drawerClosed = 0;
  const lensOnClickOutside = (event) => {
    if (event.defaultPrevented) return;
    const target = event.target;
    if (target?.isConnected === false) {
      drawerClosed += 1; // detached target: `closest` walks a node with no parents
      return;
    }
    if (target?.closest?.(".Drawer")) return;
    drawerClosed += 1;
  };
  window.addEventListener("click", lensOnClickOutside);

  const toolbarHost = document.createElement("div");
  toolbarHost.id = "toolbar-host";
  drawer.appendChild(toolbarHost);

  await act(async () => {
    ReactDOM.render(
      React.createElement(renderer.kubeObjectMenuItems[0].components.MenuItem, { object: fakePod, toolbar: true }),
      toolbarHost,
    );
  });
  await flush(10);

  console.log("[入口]");
  check("未点击前没有渲染浮层", () => assert.equal(panel(), null));
  check("抽屉里不再有内联的文件管理区块", () => assert.ok(!renderer.kubeObjectDetailItems || renderer.kubeObjectDetailItems.length === 0));
  check("工具栏图标显示「文件管理」", () => assert.ok(toolbarHost.textContent.includes("文件管理")));

  // Pods 列表行 kebab 菜单渲染的是同一个注册项，但 Lens 只在那里传 `object`
  // （详情抽屉头部才传 `toolbar`）。列表里必须什么都不渲染。
  const rowMenuHost = document.createElement("div");
  drawer.appendChild(rowMenuHost);
  await act(async () => {
    ReactDOM.render(
      React.createElement(renderer.kubeObjectMenuItems[0].components.MenuItem, { object: fakePod }),
      rowMenuHost,
    );
  });
  await flush(10);
  check("Pods 列表行的 ⋮ 菜单里没有「文件管理」", () => {
    assert.equal(rowMenuHost.textContent.trim(), "", rowMenuHost.textContent);
    assert.equal(rowMenuHost.querySelector("a, button"), null, "不应渲染任何可点元素");
  });
  await act(async () => {
    ReactDOM.unmountComponentAtNode(rowMenuHost);
  });
  rowMenuHost.remove();

  await click(toolbarHost.querySelector('[data-testid="podfs-toolbar-item"]'));
  await flush(30);
  check("点击图标打开全屏浮层", () => assert.ok(panel(), "浮层未出现"));
  check("浮层挂在 .Drawer 内部（否则会被判定为外部点击）", () => {
    assert.ok(panel().closest(".Drawer"), "浮层不在 .Drawer 内");
  });
  check("打开浮层本身不会触发抽屉关闭", () => assert.equal(drawerClosed, 0));

  console.log("\n[列表]");
  check("列出根目录 4 项", () => assert.deepEqual(rowNames(), ["aaa", "bbb", "etc", "readme.txt"]));
  check("表头为 名称/大小/修改时间/操作", () => {
    const headers = Array.from(panel().querySelectorAll("th")).map((cell) => cell.textContent.trim());
    assert.deepEqual(headers, ["名称", "大小", "修改时间", "操作"]);
  });
  const containerToggle = () => panel().querySelector('[data-testid="podfs-container-select"]');

  check("显示容器选择器且默认第一个容器", () => {
    const toggle = containerToggle();
    assert.ok(toggle, "缺少容器选择器");
    assert.ok(toggle.textContent.includes("main"), toggle.textContent);
  });
  check("容器选择器在工具栏右对齐", () => {
    const group = panel().querySelector('[data-testid="podfs-toolbar-right"]');
    assert.ok(group, "缺少右对齐分组");
    assert.equal(group.style.marginLeft, "auto");
    assert.ok(group.contains(containerToggle()), "容器选择器不在右对齐分组里");
  });
  check("搜索框在容器选择器左侧", () => {
    const search = panel().querySelector('[data-testid="podfs-search"]');
    assert.ok(search, "缺少搜索输入框");
    const relative = search.compareDocumentPosition(containerToggle());
    assert.ok(relative & window.Node.DOCUMENT_POSITION_FOLLOWING, "搜索框应排在容器选择器之前");
  });
  check("自绘下拉，不用原生 select", () => {
    assert.equal(panel().querySelector("select"), null, "不应再出现原生 select");
  });

  await click(containerToggle());
  check("下拉展开后列出两个容器", () => assert.equal(panel().querySelectorAll("[data-option]").length, 2));
  await click(panel().querySelector('[data-option="sidecar"]'));
  await flush(40);
  check("切换容器后按钮显示新容器", () => assert.ok(containerToggle().textContent.includes("sidecar")));
  check("切换容器会带上新容器重新拉取列表", () =>
    assert.ok(listRequests.some((request) => request.container === "sidecar"), JSON.stringify(listRequests.slice(-2))),
  );
  check("点容器选项（自身随即卸载）不会关掉抽屉", () => assert.equal(drawerClosed, 0));
  check("关闭按钮是 X 图标", () => {
    const close = panel().querySelector('[data-testid="podfs-fullscreen-back"]');
    assert.equal(close.textContent.trim(), "✕");
  });

  console.log("\n[后退按钮]");
  check("根目录时「后退」禁用", () => {
    const back = panel().querySelector('[data-testid="podfs-back"]');
    assert.ok(back, "缺少后退按钮");
    assert.equal(back.getAttribute("data-disabled"), "true");
    assert.equal(back.querySelector("button").disabled, true);
  });
  await doubleClick(findRow("etc"));
  await flush(30);
  check("进入子目录后「后退」可用", () => {
    const back = panel().querySelector('[data-testid="podfs-back"]');
    assert.equal(back.getAttribute("data-disabled"), null);
    assert.equal(back.querySelector("button").disabled, false);
  });
  await click(panel().querySelector('[data-testid="podfs-back"] button'));
  await flush(30);
  check("点「后退」回到上一级", () => assert.deepEqual(rowNames(), ["aaa", "bbb", "etc", "readme.txt"]));
  check("在浮层内双击目录不会关闭抽屉", () => assert.equal(drawerClosed, 0));

  console.log("\n[操作列]");
  check("文件行有 信息/重命名/下载/删除", () =>
    assert.deepEqual(actionsOf(findRow("readme.txt")), ["info", "rename", "download", "delete"]),
  );
  check("目录行没有下载", () => assert.deepEqual(actionsOf(findRow("etc")), ["info", "rename", "delete"]));

  await click(findRow("readme.txt").querySelector('a[data-action="info"]'));
  await flush(10);
  check("点信息图标显示路径", () => assert.ok(panel().textContent.includes("/readme.txt")));
  await click(findButton("关闭"));
  await flush(10);
  check("关闭弹窗（按钮随弹窗卸载）不会关掉抽屉", () => assert.equal(drawerClosed, 0));

  await click(findRow("readme.txt").querySelector('a[data-action="rename"]'));
  await flush(10);
  check("点重命名打开重命名弹窗", () => assert.ok(panel().textContent.includes("重命名 readme.txt")));
  await click(findButton("取消"));
  await flush(10);

  await click(findRow("readme.txt").querySelector('a[data-action="delete"]'));
  await flush(10);
  check("点删除打开确认弹窗并显示完整路径", () =>
    assert.ok(panel().textContent.includes("确认删除") && panel().textContent.includes("/readme.txt")),
  );
  await click(findButton("取消"));
  await flush(10);

  console.log("\n[下载：模态框 + 进度]");
  await click(findRow("readme.txt").querySelector('a[data-action="download"]'));
  await flush(10);
  check("下载时弹出传输模态框", () => {
    assert.ok(pendingDownload, "未调用 download");
    assert.equal(pendingDownload.request.isDir, false);
    assert.equal(pendingDownload.request.path, "/readme.txt");
    assert.ok(panel().textContent.includes("下载 readme.txt"));
    assert.ok(panel().textContent.includes("下载中…"));
  });

  await act(async () => {
    progressHandler(null, { taskId: pendingDownload.request.taskId, phase: "download", bytes: 6, total: 12 });
  });
  check("进度事件更新为 50%", () => assert.ok(panel().textContent.includes("50%")));
  check("进度条宽度跟随百分比", () => assert.equal(panel().querySelector(".podfs-progress-fill").style.width, "50%"));

  await act(async () => {
    pendingDownload.resolve({ ok: true, path: "D:\\\\tmp\\\\readme.txt", message: "已保存到 D:\\\\tmp\\\\readme.txt" });
    await sleep(10);
  });
  check("完成后显示已完成与保存位置", () =>
    assert.ok(panel().textContent.includes("已完成") && panel().textContent.includes("保存位置")),
  );
  await click(findButton("关闭"));
  await flush(10);

  console.log("\n[双击进入目录]");
  await click(findRow("etc"));
  await flush(10);
  check("单击不进入目录", () => assert.deepEqual(rowNames(), ["aaa", "bbb", "etc", "readme.txt"]));
  check("在浮层内单击文件行不会关闭抽屉", () => assert.equal(drawerClosed, 0));

  await doubleClick(findRow("etc"));
  await flush(30);
  check("双击 /etc 进入并列出 nginx 与 passwd", () => assert.deepEqual(rowNames(), ["nginx", "passwd"]));

  console.log("\n[遮罩铺满整个列表区]");
  const backRow = Array.from(panel().querySelectorAll('tr[data-dir="true"]')).find((row) => row.textContent.includes(".."));
  await doubleClick(backRow);
  await flush(30);
  check("回到根目录", () => assert.deepEqual(rowNames(), ["aaa", "bbb", "etc", "readme.txt"]));

  await act(async () => {
    findRow("aaa").dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
  });
  check("切换瞬间旧行已清空", () => assert.equal(rows().length, 0));
  check("切换瞬间显示遮罩", () => assert.ok(panel().querySelector(".podfs-overlay")));
  check("不再使用骨架行占位（遮罩直接铺满）", () => assert.equal(skeletonRows().length, 0));
  check("列表区是可伸缩的滚动容器", () => {
    const body = panel().querySelector(".podfs-body");
    assert.ok(body, "缺少 .podfs-body");
  });

  console.log("\n[竞态]");
  const rootCrumb = Array.from(panel().querySelectorAll("a")).find((anchor) => anchor.textContent === "/");
  await click(rootCrumb);
  await flush(220);
  check("最终显示根目录而不是迟到的 /aaa 结果", () =>
    assert.deepEqual(rowNames(), ["aaa", "bbb", "etc", "readme.txt"]),
  );
  check("遮罩已消失", () => assert.equal(panel().querySelector(".podfs-overlay"), null));

  console.log("\n[首次加载也有遮罩]");
  await click(document.querySelector('[data-testid="podfs-fullscreen-back"]'));
  await flush(20);
  delayFor["/"] = 120; // 让首次加载停留在 loading 态
  await click(toolbarHost.querySelector('[data-testid="podfs-toolbar-item"]'));
  check("首次加载立刻显示遮罩且无占位行", () => {
    assert.ok(panel().querySelector(".podfs-overlay"), "缺少遮罩");
    assert.equal(rows().length, 0, "不应有数据行");
    assert.equal(skeletonRows().length, 0, "不应有骨架行");
  });
  await flush(200);
  check("加载完成后遮罩消失、数据到位", () => {
    assert.equal(panel().querySelector(".podfs-overlay"), null);
    assert.deepEqual(rowNames(), ["aaa", "bbb", "etc", "readme.txt"]);
  });
  delete delayFor["/"];

  console.log("\n[编辑路径]");
  const pathEditButton = () => panel().querySelector('[data-testid="podfs-path-edit"]');
  const pathInput = () => panel().querySelector('[data-testid="podfs-path-input"]');
  /** What the user actually reads in the crumb bar, minus the trailing ✎ button. */
  const crumbText = () =>
    Array.from(panel().querySelector('[data-testid="podfs-pathbar"]').childNodes)
      .map((node) => node.textContent ?? "")
      .join("")
      .replace("✎", "")
      .trim();
  /** Standalone "/" separators (the root crumb is itself an anchor reading "/"). */
  const separatorCount = () => panel().querySelectorAll('[data-testid="podfs-pathbar"] [data-sep="true"]').length;

  check("面包屑右侧有编辑路径入口", () => assert.ok(pathEditButton(), "缺少编辑路径按钮"));
  check("根目录只显示一个 /", () => {
    assert.equal(crumbText(), "/");
    assert.equal(separatorCount(), 0, "根目录不应有额外分隔符");
  });
  await click(pathEditButton());
  await flush(10);
  check("点编辑后出现输入框并预填当前路径", () => {
    const input = pathInput();
    assert.ok(input, "缺少路径输入框");
    assert.equal(input.value, "/");
    assert.equal(pathEditButton(), null, "编辑态不应再显示面包屑");
  });

  await typeInto(pathInput(), "/etc");
  await pressKey(pathInput(), "Enter");
  await flush(60);
  check("输入绝对路径回车后切换目录", () => assert.deepEqual(rowNames(), ["nginx", "passwd"]));
  check("回车后退出编辑态并恢复面包屑", () => {
    assert.equal(pathInput(), null);
    assert.ok(panel().querySelector('[data-testid="podfs-pathbar"]'), "缺少面包屑栏");
  });
  check("路径框里回车不会关掉浮层", () => assert.ok(panel()));

  check("/etc 的面包屑是 /etc，不是 / /etc", () => {
    assert.equal(crumbText(), "/etc");
    assert.equal(separatorCount(), 0, "根与第一级之间不该再画一个斜杠");
  });

  await click(pathEditButton());
  await flush(10);
  await typeInto(pathInput(), "/etc/nginx");
  await pressKey(pathInput(), "Enter");
  await flush(60);
  check("多级路径只在段之间显示一个斜杠", () => {
    assert.deepEqual(rowNames(), ["nginx.conf"]);
    assert.equal(crumbText(), "/etc/nginx");
    assert.equal(separatorCount(), 1);
  });

  await click(pathEditButton());
  await flush(10);
  await typeInto(pathInput(), "/etc");
  await pressKey(pathInput(), "Enter");
  await flush(60);

  await click(pathEditButton());
  await flush(10);
  check("再次编辑时预填当前目录", () => assert.equal(pathInput().value, "/etc"));

  await typeInto(pathInput(), "..");
  await pressKey(pathInput(), "Enter");
  await flush(60);
  check("相对路径 .. 回到上一级", () => assert.deepEqual(rowNames(), ["aaa", "bbb", "etc", "readme.txt"]));

  await click(pathEditButton());
  await flush(10);
  await typeInto(pathInput(), "aaa");
  await pressKey(pathInput(), "Enter");
  await flush(200); // /aaa 的假响应故意慢了 120ms
  check("相对路径按当前目录解析", () => assert.deepEqual(rowNames(), ["aaa-only.txt"]));

  await click(pathEditButton());
  await flush(10);
  await act(async () => {
    pathInput().blur();
  });
  await flush(10);
  check("输入框失焦即取消编辑且目录不变", () => {
    assert.equal(pathInput(), null);
    assert.deepEqual(rowNames(), ["aaa-only.txt"]);
  });

  await click(pathEditButton());
  await flush(10);
  await typeInto(pathInput(), "/");
  await pressKey(pathInput(), "Enter");
  await flush(60);
  check("可以跳回根目录", () => assert.deepEqual(rowNames(), ["aaa", "bbb", "etc", "readme.txt"]));

  await doubleClick(panel().querySelector('[data-testid="podfs-pathbar"]'));
  await flush(10);
  check("双击路径区也能进入编辑", () => assert.ok(pathInput()));
  check("编辑态没有多余文案提示", () => assert.equal(panel().querySelector(".podfs-pathhint"), null));
  await act(async () => {
    pathInput().blur();
  });
  await flush(10);
  check("失焦后回到面包屑", () => assert.ok(panel().querySelector('[data-testid="podfs-pathbar"]')));

  console.log("\n[文件名搜索]");
  const searchInput = () => panel().querySelector('[data-testid="podfs-search"]');
  const searchClear = () => panel().querySelector('[data-testid="podfs-search-clear"]');

  check("搜索框默认为空且清除按钮不可见", () => {
    assert.equal(searchInput().value, "");
    assert.equal(searchClear().style.visibility, "hidden");
  });

  await typeInto(searchInput(), "RE");
  check("只输入不回车时列表不变", () => assert.deepEqual(rowNames(), ["aaa", "bbb", "etc", "readme.txt"]));

  await pressKey(searchInput(), "Enter");
  await flush(20);
  check("回车后只留下匹配的行（大小写不敏感）", () => assert.deepEqual(rowNames(), ["readme.txt"]));
  check("文件名里的命中字符被高亮", () => {
    const mark = findRow("readme.txt").querySelector("mark.podfs-hl");
    assert.ok(mark, "缺少高亮标记");
    assert.equal(mark.textContent, "re");
  });
  check("显示匹配计数", () => {
    const status = panel().querySelector('[data-testid="podfs-search-status"]');
    assert.ok(status, "缺少匹配计数");
    assert.ok(status.textContent.includes("匹配 1 / 共 4 项"), status.textContent);
  });

  await typeInto(searchInput(), "zzz");
  await pressKey(searchInput(), "Enter");
  await flush(20);
  check("无匹配时给出空结果提示", () => {
    assert.equal(rows().length, 0);
    const empty = panel().querySelector('[data-testid="podfs-empty"]');
    assert.ok(empty && empty.textContent.includes("没有匹配"), "缺少空结果提示");
  });

  await click(searchClear());
  await flush(20);
  check("点 X 还原为全列表", () => assert.deepEqual(rowNames(), ["aaa", "bbb", "etc", "readme.txt"]));
  check("点 X 后输入框清空、清除按钮隐藏但仍在 DOM 里", () => {
    assert.equal(searchInput().value, "");
    assert.equal(searchClear().style.visibility, "hidden");
    assert.equal(searchClear().isConnected, true, "清除按钮不应在点击后把自己卸载");
  });
  check("点 X 不会连带关掉整个抽屉", () => assert.equal(drawerClosed, 0, "抽屉被 X 的点击关掉了"));

  await typeInto(searchInput(), "aaa");
  await pressKey(searchInput(), "Enter");
  await flush(20);
  check("搜索只保留当前目录的匹配项", () => assert.deepEqual(rowNames(), ["aaa"]));

  await doubleClick(findRow("aaa"));
  await flush(200);
  check("进入新目录后自动清空搜索", () => {
    assert.equal(searchInput().value, "");
    assert.equal(panel().querySelector('[data-testid="podfs-search-status"]'), null, "搜索状态应被清掉");
    assert.deepEqual(rowNames(), ["aaa-only.txt"]);
  });

  await click(pathEditButton());
  await flush(10);
  await typeInto(pathInput(), "/");
  await pressKey(pathInput(), "Enter");
  await flush(60);
  check("回到根目录，后续用例继续从这里开始", () =>
    assert.deepEqual(rowNames(), ["aaa", "bbb", "etc", "readme.txt"]),
  );

  console.log("\n[关闭浮层]");
  await pressKey(document.body, "Escape");
  await flush(20);
  check("Esc 直接关闭浮层", () => assert.equal(panel(), null));

  await click(toolbarHost.querySelector('[data-testid="podfs-toolbar-item"]'));
  await flush(60);
  check("可以再次打开浮层", () => assert.ok(panel(), "浮层未重新出现"));
  await click(document.querySelector('[data-testid="podfs-fullscreen-back"]'));
  await flush(20);
  check("点返回后浮层消失", () => assert.equal(panel(), null));
  check("工具栏项本身仍正常（无残留覆盖层）", () => assert.ok(toolbarHost.textContent.includes("文件管理")));

  console.log(`\n通过 ${passed}，失败 ${failed}`);
  ReactDOM.unmountComponentAtNode(toolbarHost);
  dom.window.close();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("UI 测试异常：", error);
  dom.window.close();
  process.exit(1);
});
