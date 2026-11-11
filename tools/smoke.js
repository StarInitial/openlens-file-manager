#!/usr/bin/env node
/**
 * Loads the built bundles the same way OpenLens does (CommonJS `require`), with
 * stubbed `electron` and `@k8slens/extensions`, to catch module-level crashes and
 * verify the registrations the host will look for.
 *
 * Usage: npm run test:smoke  (requires `npm run build` first)
 */
const assert = require("node:assert/strict");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");

const handled = new Map();
const broadcasts = [];

class FakeIpc {
  constructor(extension) {
    this.extension = extension;
  }

  handle(channel, listener) {
    handled.set(channel, listener);
  }

  broadcast(channel, payload) {
    broadcasts.push([channel, payload]);
  }

  listen() {
    return () => undefined;
  }

  async invoke() {
    return undefined;
  }

  // Mirrors the host behaviour: instantiate the subclass so its constructor
  // registers the handlers.
  static createInstance(extension) {
    return new this(extension);
  }
}

const fakeApi = {
  Main: { LensExtension: class {}, Ipc: FakeIpc, Catalog: {}, K8sApi: {}, Navigation: {}, Power: {} },
  Common: { Catalog: {} },
  Renderer: {
    LensExtension: class {},
    Ipc: FakeIpc,
    Component: {},
    K8sApi: { apiManager: { cluster: { apiUrl: "https://demo.invalid:6443", id: "cluster-1", name: "demo" } } },
  },
};

const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { getPath: () => path.join(os.tmpdir(), "podfs-smoke") },
      dialog: { showSaveDialog: async () => ({ canceled: true, filePath: undefined }) },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

// The bundles reference the host globals, exactly like OpenLens provides them.
global.LensExtensions = fakeApi;
global.React = require("react");
global.ReactDOM = require("react-dom");
const ReactDOMServer = require("react-dom/server");
global.Mobx = require("mobx");
global.MobxReact = require("mobx-react");

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

async function main() {
  console.log("[renderer bundle]");
  const rendererModule = require(path.join(__dirname, "..", "dist", "renderer.js"));
  const RendererClass = rendererModule.default ?? rendererModule;
  const renderer = new RendererClass();

  await renderer.onActivate();

  check("导出默认扩展类", () => assert.equal(typeof RendererClass, "function"));

  check("不再注册 Pod 详情项（抽屉内联区块已移除）", () => {
    const items = renderer.kubeObjectDetailItems;
    assert.ok(!items || items.length === 0, `仍有 ${items?.length} 个详情项`);
  });

  check("注册 Pod 工具栏图标（唯一入口）", () => {
    const items = renderer.kubeObjectMenuItems;
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "Pod");
    assert.deepEqual(items[0].apiVersions, ["v1"]);
    assert.equal(typeof items[0].components.MenuItem, "function");
  });

  const fakePod = {
    getNs: () => "lga-agent",
    getName: () => "demo-pod",
    metadata: { namespace: "lga-agent", name: "demo-pod", annotations: {} },
    spec: { containers: [{ name: "main" }, { name: "sidecar" }] },
  };

  check("工具栏图标可渲染出「文件管理」", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      renderer.kubeObjectMenuItems[0].components.MenuItem({ object: fakePod, toolbar: true }),
    );
    assert.ok(html.includes("文件管理"), html.slice(0, 160));
  });

  check("不再依赖状态栏作为浮层宿主", () => {
    const items = renderer.statusBarItems;
    assert.ok(!items || items.length === 0, "状态栏项已移除，浮层改由工具栏项自己渲染");
  });

  check("工具栏项在未打开浮层时不渲染覆盖层", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      renderer.kubeObjectMenuItems[0].components.MenuItem({ object: fakePod, toolbar: true }),
    );
    assert.ok(!html.includes("podfs-fs-backdrop"), "关闭状态下不应出现浮层");
  });

  console.log("\n[main bundle]");
  const mainModule = require(path.join(__dirname, "..", "dist", "main.js"));
  const MainClass = mainModule.default ?? mainModule;
  check("导出默认主进程扩展类", () => assert.equal(typeof MainClass, "function"));

  const extension = new MainClass();
  await extension.onActivate();

  const expectedChannels = [
    "podfs:probe",
    "podfs:list",
    "podfs:stat",
    "podfs:rename",
    "podfs:mkdir",
    "podfs:remove",
    "podfs:upload",
    "podfs:download",
    "podfs:cancel",
  ];
  check("注册全部 IPC 通道", () => {
    for (const channel of expectedChannels) assert.ok(handled.has(channel), `缺少通道 ${channel}`);
  });

  const probe = await handled.get("podfs:probe")({}, { target: { namespace: "default", pod: "demo" } });
  check("缺少 kubeconfig 时 probe 优雅降级", () => {
    assert.equal(probe.ok, false);
    assert.ok(["KUBECONFIG_MISSING", "KUBECTL_MISSING"].includes(probe.code), `实际 code=${probe.code}`);
  });

  await extension.onDeactivate();

  console.log(`\n通过 ${passed}，失败 ${failed}`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error("smoke 测试异常：", error);
  process.exitCode = 1;
});
