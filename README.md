# Pod 文件管理器 · OpenLens 扩展

在 OpenLens 里浏览容器内文件：查看文件信息、重命名、上传、下载、新建目录、删除。

**唯一入口**：Pod 详情页右上角工具栏的文件夹图标 → 打开**全屏浮层**。列表滚动位置、Pod 侧栏与抽屉状态全程保留，点「返回」/`Esc`/点遮罩即回到原处。

- 宿主：OpenLens 6.5.x（`engines.lens: ^6.5.0`）
- 传输方式：`kubectl exec` + tar 流，**文件字节不经过渲染进程 IPC**
- 无运行时 npm 依赖（tar 打包/解包为本仓库内置实现）

## 功能

| 能力 | 说明 |
|---|---|
| 入口 | Pod 详情右上角工具栏图标（与 shell / logs 图标同一排） |
| 呈现 | 全屏浮层：`position: fixed` + `createPortal` 进当前 `.Drawer` 内部，**不换路由**，所以底层列表与抽屉不被卸载。挂进 `.Drawer` 是必需的——OpenLens 的抽屉把「点击目标 `closest(".Drawer")` 为空」判定为外部点击并关闭自己，挂在 `body` 上会导致点一下就全关。同一判定还有第二个坑：抽屉的监听器在 window 冒泡阶段才跑，此时 React 已经把「点了就自己卸载」的节点（搜索框 ✕、弹窗按钮、下拉选项）从 DOM 里摘掉，`closest` 返回 null → 整个侧边栏被关。因此插件内所有按钮都 `preventDefault()`（抽屉自己会跳过 `defaultPrevented` 的点击），清除按钮还改成常驻 DOM、只用 `visibility` 隐藏 |
| 容器选择 | 顶部常显「容器」下拉（**自绘**，非原生 `<select>`——原生圆角与蓝色胶囊高亮无法定制），默认取 `kubectl.kubernetes.io/default-container` 注解，没有则取第一个容器；切换后自动回到 `/` 并重新探测 |
| 浏览目录 | **双击目录进入**；面包屑导航（根就是那个 `/`，第一级不再重复画一个斜杠，多级路径渲染成 `/etc/nginx` 而不是 `/ / etc / nginx`，每段都可点）；隐藏文件开关；目录优先排序 |
| 路径直达 | 面包屑右侧的 ✎（或双击路径区）把整条路径区变成占满宽度的可编辑地址栏：**回车跳到该路径**，输入框失焦即取消。支持绝对路径（`/var/log`）与相对当前目录的路径（`nginx`、`../var`），相对路径在本地解析后才发给容器 |
| 文件名搜索 | 工具栏右侧、容器下拉左侧的搜索框：输入后**回车**过滤当前目录列表，命中的字符在文件名里高亮；输入框右侧的 **✕** 还原全列表。列表本身就是整目录一次拉取，所以过滤在本地完成，不额外 exec，也不受分页影响；切换目录时自动清空 |
| 加载体验 | 切换目录时立即清空旧列表，半透明遮罩**铺满整个列表区**并居中显示 spinner —— 列表区是 flex 撑满的滚动容器，高度恒定不跳动；过期响应会被丢弃（快速连点不会串目录） |
| 操作入口 | 每行末尾「操作」列：信息 / 重命名 / 下载（仅文件）/ 删除 |
| 文件信息 | 类型、大小、权限位、uid/gid、修改时间、符号链接目标 |
| 重命名 | 目标已存在时拒绝；不合法名称在本地即被拦截 |
| 上传 | 单文件/多文件/整个目录（递归）；冲突策略 跳过·覆盖·自动改名 |
| 下载 | **仅普通文件**（目录不提供下载）；流式写入，不占内存 |
| 传输反馈 | 上传/下载弹出模态框：进度条、字节数与百分比、保存位置；传输中可取消 |
| 新建目录 / 删除 | 删除目录需二次确认，根目录禁止删除 |

### 方式一：tgz 安装（推荐分发方式）

```bash
npm ci
npm run pack:dist    # 产出 artifacts/ 下的两个包 + 校验和
```

| 产物 | 用途 |
|---|---|
| `artifacts/pod-file-manager-<version>.tgz` | **用这个分发**：npm 布局（`package/` 根），OpenLens 的 Extensions 页面可直接拖入安装 |
| `artifacts/pod-file-manager-<version>.tar.gz` | 便携包（顶层 `pod-file-manager-<version>/` 目录 + `INSTALL.md`），适合手动安装或解压查看 |
| `artifacts/SHA256SUMS.txt` | 两个包的 SHA256 校验和 |

两个包都用仓库内置的 ustar+gzip 写出，不依赖系统 `tar`，也不需要 `npm pack`。

在 OpenLens 中打开 **File → Extensions**，把 `.tgz` 拖进窗口即可。

### 方式二：直接装进本机 OpenLens（开发用）

```bash
npm run install:local
```

OpenLens 6.5 需要**两处同时存在**才会加载扩展，脚本会一次写好：

1. `<userData>/node_modules/pod-file-manager/`（注册 id）
2. `~/.k8slens/extensions/openlens--pod-file-manager/`（发现入口）
3. `<userData>/lens-extensions.json` 里的启用条目

改完代码后重新 `npm run install:local` 并重启 OpenLens（客户端不支持热重载本地扩展）。

## 配置（可选）

一般不需要。若自动解析失败，可编辑 `%APPDATA%\OpenLens\pod-file-manager.json`：

```json
{
  "kubectlPath": "C:\\Windows\\system32\\kubectl.exe",
  "kubeconfigPath": "C:\\Users\\me\\.kube\\config",
  "contextName": "my-context"
}
```

解析顺序：本文件 → OpenLens 的 `lens-cluster-store.json`（按当前集群匹配）→ `~/.kube/config`。
kubectl 定位顺序：本文件的 `kubectlPath` → OpenLens 内置 `binaries/kubectl/<版本>/` → 系统 PATH。

## 权限要求

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: <ns>
rules:
  - apiGroups: [""]
    resources: ["pods/exec"]
    verbs: ["create", "get"]
```

## 已知限制

- 容器内需要 `tar`（列目录还需要 `find` 或 `ls`、`stat`）。**distroless / scratch / Windows 容器不支持**——扩展会先探测并明确提示。
- 上传依赖 Electron 的 `File.path`（OpenLens 6.5 所在 Electron 版本仍提供）；拿不到路径会明确报错，不会假装成功。
- 浮层挂在状态栏的常驻组件上，所以要**先打开一次 Pod 详情抽屉**（工具栏图标在那里）才能进入。
- 大目录不分页，一次列出全部条目（`stat` 每批 300 条，自动分批）。文件名搜索是在这份已加载的列表上做的本地子串过滤（不区分大小写，不做 glob/正则）。

## 开发与测试

```bash
npm run typecheck   # 对 Lens 类型面做完整类型检查
npm run test:unit   # 16 项：路径/相对路径解析、文件名搜索与高亮、tar 打包/解析、busybox stat 解析、错误映射
npm run test:e2e    # 25 项：WSL 里跑真实 Linux 命令模拟容器（零集群接触）
npm run test:smoke  # 9 项：按宿主方式 require 两个 bundle，校验注册与降级
npm run test:ui     # 75 项：jsdom 真实交互（从工具栏图标一路点到关闭浮层，含路径编辑、面包屑斜杠、文件名搜索与「点击不误关抽屉」回归）
npm test            # 全部串起来跑
```

`test:e2e` 通过 `tools/fake-kubectl.js` 把 `kubectl exec` 转发到 WSL 默认发行版，**不会连接任何 Kubernetes 集群**；可用 `PODFS_WSL_DISTRO` 指定发行版。

## 安全说明

- 命令一律以 argv 数组传给 `kubectl`，**从不拼接 shell 字符串**，文件名含空格/引号/换行/中文都安全。
- 不缓存任何凭据，不修改集群资源；所有操作仅在目标容器内执行 `tar`/`stat`/`mv`/`mkdir`/`rm`。
- 删除前展示完整绝对路径，目录删除额外提示不可恢复，`/` 直接拒绝。
