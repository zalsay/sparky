# 内置 WebView 最终实现说明

本文记录 Sparky 项目内置 WebView 的最终实现方式、关键约束和调试方法。以后修改 IDE 标签页、原生 WebView、页面链接或浏览器 MCP 时，应先阅读本文。

## 1. 最终行为

项目详情页的 IDE 区域由 React 标签栏和 Tauri 原生子 WebView 组成：

- `code-server` 和自定义网页都显示为 IDE 标签页。
- 每个标签页对应一个 Tauri 原生 WebView。
- 原生 WebView 的内容区域始终位于 Tab 栏下方。
- 页面中的普通链接在当前 WebView 导航。
- `target="_blank"`、其他非当前窗口 target 和 `window.open()` 会创建新的 Sparky IDE 标签页。
- 页面打开新标签失败时，会回退为当前 WebView 导航，避免完全没有响应。
- 浏览器 MCP 可以按标签页注册、绑定、截图和执行 DOM 操作。

最终实现涉及以下文件：

- `ui/src/App.tsx`
- `src-tauri/src/lib.rs`
- `src-tauri/src/browser_bridge.rs`
- `src-tauri/capabilities/browser-bridge.json`
- `src-tauri/build.rs`

## 2. 整体架构

### 2.1 React 层

`ui/src/App.tsx` 负责：

- 保存每个项目的 `ideTabs` 和 `activeIdeTabId`。
- 保存原生 WebView 句柄：`ideWebviewsRef`。
- 保存每个标签页对应的 DOM 容器：`browserViewportRefs`。
- 根据项目路径和标签页 ID 生成稳定的 `runtimeKey`：

```text
${projectPath}::${tabId}
```

- 根据项目路径和标签页 ID 生成稳定的原生 label：

```text
sparky-ide-${projectHash}-${tabId}
```

- 同步打开、隐藏、关闭和聚焦原生 WebView。
- 监听 `ide-new-window` 事件，把页面的新窗口请求转换成新的 IDE 标签页。

### 2.2 Rust 层

`src-tauri/src/lib.rs` 负责创建原生子 WebView：

```rust
Window::add_child(WebviewBuilder, position, size)
```

创建时配置：

- 初始 URL。
- `focused(false)`，避免后台打开标签抢走焦点。
- 每个标签页独立的数据目录。
- macOS 使用 16 字节 `data_store_identifier`。
- `initialization_script_for_all_frames`，注入链接拦截脚本。
- `on_new_window`，处理没有被脚本拦截的原生新窗口请求。

### 2.3 浏览器桥接层

`src-tauri/src/browser_bridge.rs` 负责：

- 注册浏览器目标。
- 更新目标的物理坐标。
- 绑定目标到终端。
- 执行 DOM 快照、点击、填充、滚动、导航和截图。
- 为远程页面提供受控的链接打开和日志命令。

## 3. 为什么不能直接使用前端 `new Webview(...)`

Tauri 前端 `Webview` API 可以创建和操作原生 WebView，但它没有暴露 `on_new_window` 配置接口。

因此，下面的方式不能完整支持页面新窗口：

```ts
new Webview(getCurrentWindow(), label, options)
```

页面执行 `window.open()` 或点击 `target="_blank"` 时，原生 WebView 会发出新窗口请求，但前端创建的 WebView 没有新窗口处理器，最终请求会被丢弃。

最终方案是：

1. 前端调用 `create_ide_webview`。
2. Rust 使用 `WebviewBuilder` 创建子 WebView。
3. Rust 配置 `on_new_window` 和初始化脚本。
4. 创建完成后，前端通过 `Webview.getByLabel(label)` 获取句柄。
5. 前端继续负责定位、显示、隐藏和生命周期管理。

## 4. WebView 生命周期

### 4.1 打开流程

`openIdeWebview` 的顺序必须保持如下：

1. 根据 `projectPath` 和 `tab.id` 计算 `runtimeKey` 和 `label`。
2. 先调用 `Webview.getByLabel(label)`，避免重复创建。
3. 找不到时调用：

```ts
invoke('create_ide_webview', {
  label,
  project_path: projectPath,
  tab_id: tab.id,
  url: tab.url,
  data_directory: 'browser-data',
  data_store_identifier: ideWebviewDataStoreIdentifier(...),
})
```

4. 轮询 `Webview.getByLabel(label)`，等待 Rust 创建完成。
5. 检查同步代数 `syncGeneration`，如果当前打开请求已经过期，立即关闭新创建的 WebView。
6. 写入 `ideWebviewsRef.current`。
7. 调用 `browser_register_target` 注册浏览器目标。
8. 再次检查同步代数，过期时注销并关闭。
9. 调用布局同步，最后才显示或隐藏 WebView。

### 4.2 关闭流程

删除标签页或切换项目时必须同时做两件事：

1. 从前端引用中删除并调用 `browser_unregister_target`。
2. 调用原生 WebView 的 `close()`。

组件卸载时也必须遍历所有句柄执行这两步。只关闭原生 WebView而不注销浏览器目标，会留下 MCP 的失效目标；只注销目标而不关闭原生 WebView，会留下不可见的原生视图。

### 4.3 并发和过期请求

项目切换、Tab 切换和 React 状态更新可能同时触发多轮同步。

`ideWebviewSyncGenerationRef` 用来标识最新同步请求。所有异步打开流程在以下节点都必须检查同步代数：

- 开始创建之前。
- Rust 创建完成之后。
- 浏览器目标注册之后。
- 等待激活标签页之前。

不能删除这组检查，否则旧请求可能在新项目或新标签页上创建并显示错误的 WebView。

## 5. Tab 栏定位和原生坐标

### 5.1 当前坐标算法

布局函数是 `getIdeWebviewRect`。

计算步骤：

1. 首选 `.ide-browser-viewport` 的 `getBoundingClientRect()`。
2. 如果该节点在 Ant Design Tab 切换期间暂时没有有效尺寸，回退到 `.terminal-tabs-inner`。
3. 读取 `.ant-tabs-nav` 的实际矩形。
4. 使用 `IDE_TAB_BAR_HEIGHT = 32` 作为最小 Tab 高度。
5. 计算 Tab 栏底部：

```text
tabBarBottom = max(tabNav.bottom, tabsRoot.top + tabBarHeight)
```

6. 原生 WebView 起点必须是：

```text
top = max(baseRect.top, tabBarBottom + IDE_TAB_BAR_HEIGHT)
```

当前实际效果中：

```text
tabBarBottom = 75
nativeWebViewTop = 107
safeTopInset = 32
```

7. WebView 高度使用容器底部减去 `top`，不能继续使用完整 viewport 高度。

### 5.2 最容易踩坑的地方

不要把原生 WebView 设置为：

```text
y = tabBarBottom + 1
```

在 macOS 上，原生子 WebView 的视觉绘制层和 DOM 回读坐标并不总是表现一致。之前日志虽然显示 `y=76`，但视觉上仍然覆盖 Tab 栏。

当前使用完整的 32px 安全下移，确保原生内容不会侵入 Tab 区域。不要只根据 `position()` 的回读值判断没有遮挡，必须同时检查实际截图或界面表现。

### 5.3 Logical 和 Physical 坐标不能混用

原生 WebView 定位使用逻辑坐标：

```ts
webview.setPosition(new LogicalPosition(x, y))
webview.setSize(new LogicalSize(width, height))
```

浏览器 MCP 目标边界使用物理坐标：

```text
physicalX = window.innerPosition.x + cssX * scaleFactor
physicalY = window.innerPosition.y + cssY * scaleFactor
physicalWidth = cssWidth * scaleFactor
physicalHeight = cssHeight * scaleFactor
```

不要把 `innerPosition`、CSS `getBoundingClientRect()` 和原生 WebView 的逻辑坐标直接相加而不乘缩放因子。

### 5.4 为什么需要隐藏逻辑

原生 WebView 位于 HTML DOM 之上，CSS 的 `z-index` 不能让 Tab 栏覆盖原生 WebView。

因此在以下情况下必须隐藏当前原生 WebView：

- Modal 打开。
- Dropdown 打开。
- Select 下拉框打开。
- Popover 打开。
- 当前页面不是项目详情页。
- 当前标签页没有有效 viewport。

`hasBlockingOverlay` 和 MutationObserver 负责检测这些状态。

## 6. 页面链接和新窗口处理

### 6.1 初始化脚本

每个原生 WebView 创建时注入 `initialization_script_for_all_frames`。必须使用初始化脚本，而不是只在创建后调用一次 `eval`，原因是页面每次导航都会重新创建 document。

脚本负责：

- 覆盖 `window.open`。
- 捕获阶段监听 `click`。
- 查找点击路径中的 `<a>` 元素。
- 处理非 `_self`、`_top`、`_parent` 的 target。
- 使用 `new URL(rawUrl, location.href)` 解析相对链接。
- 只允许 `http` 和 `https`。
- 记录 `[IDE_OPEN]` 日志。
- 调用远程 capability 允许的插件命令。
- 插件命令失败时回退到 `window.location.assign(url)`。

### 6.2 远程页面不能直接调用普通应用命令

Tauri 对远程页面的 IPC 有 ACL 限制。外部 URL 即使运行在应用创建的 WebView 中，也不能默认调用任意应用自定义命令。

因此不能只在脚本中调用：

```js
window.__TAURI_INTERNALS__.invoke('ide_open_webview_link', args)
```

远程页面必须调用 `browser-bridge` 插件命令：

```js
window.__TAURI_INTERNALS__.invoke(
  'plugin:browser-bridge|browser_link_open',
  args,
)
```

日志使用：

```js
window.__TAURI_INTERNALS__.invoke(
  'plugin:browser-bridge|browser_debug_log',
  { message },
)
```

对应的 capability 必须同时包含：

- WebView label 范围：`sparky-ide-*`。
- 允许的远程 URL 范围。
- `browser-bridge:allow-browser-debug-log`。
- `browser-bridge:allow-browser-link-open`。

### 6.3 新窗口事件链路

页面点击新窗口链接后，正常链路如下：

```text
页面 anchor-click / window.open
  -> browser_debug_log
  -> browser_link_open
  -> AppHandle.emit("ide-new-window")
  -> React listen("ide-new-window")
  -> createIdeTabFromUrl(url)
  -> activeIdeTabId 更新
  -> syncIdeWebviews
  -> create_ide_webview
  -> 新标签页显示
```

Rust 的 `on_new_window` 是第二条兜底路径：

```text
原生 new-window request
  -> [IDE_OPEN] native-new-window-request
  -> emit("ide-new-window")
  -> React 创建新标签
  -> 返回 NewWindowResponse::Deny
```

返回 `Deny` 是有意的。否则 Tauri 可能创建一个脱离 Sparky Tab 管理的独立原生窗口。

### 6.4 URL 校验

远程链接打开命令和初始 WebView 创建命令都必须校验 URL scheme：

```text
只允许 http 和 https
```

不能直接把任意 `file:`, `javascript:`, 自定义 scheme 或未解析字符串传给 `WebviewUrl` 或 `location`。

## 7. 浏览器 MCP 集成

每个 IDE 标签页注册一个 `BrowserTarget`：

```text
target_id       = projectPath::tabId
webview_label   = sparky-ide-...
project_path    = projectPath
tab_id          = tabId
url             = initial URL
bounds          = current physical bounds
```

前端调用：

- 打开并注册后：`browser_register_target`
- 布局变化后：`browser_update_target_bounds`
- 删除或项目切换时：`browser_unregister_target`
- 当前终端变化时：`browser_bind_target`

MCP 的 bounds 是截图和 DOM 自动化使用的物理坐标。原生 WebView 的显示坐标和 MCP bounds 必须由同一次布局计算产生，不能各自使用不同的偏移量。

## 8. 调试日志规范

### 8.1 坐标日志开关

`ui/src/App.tsx` 中：

```ts
const IDE_LAYOUT_DEBUG = false;
```

布局相关日志默认关闭。过滤的日志包括：

- `layout-*`
- `native-geometry-*`
- `native-bounds-*`
- `native-coordinate-*`
- `native-webview-shown`
- `native-webview-hidden`
- `bridge-bounds-update-*`

包含 `failed` 的错误日志仍然保留。

`ide_debug_dump_webviews` 命令仍可用于临时手动检查，但不应在每轮同步中自动调用，否则会重新产生大量定位日志。

### 8.2 新窗口日志

正常打开新标签时，应能看到类似链路：

```text
[IDE_OPEN] link-interceptor-installed label=...
[IDE_OPEN] remote anchor-click source=... url=...
[IDE_OPEN] remote-command kind=anchor-click source_tab=... url=...
[IDE_DEBUG] open-event-received {...}
[IDE_DEBUG] new-window-opened-as-ide-tab {...}
[IDE_DEBUG] open-tab-created {...}
[IDE_OPEN] link-interceptor-installed label=...
[IDE_DEBUG] open-webview-registered-in-frontend {...}
[IDE_DEBUG] sync-complete {...}
```

原生兜底路径的关键日志是：

```text
[IDE_OPEN] native-new-window-request source_tab=... url=...
```

### 8.3 根据日志定位问题

| 最后出现的日志 | 可能原因 |
|---|---|
| 没有 `remote anchor-click` | 初始化脚本没有加载，或点击元素不是可捕获的链接 |
| 有 `anchor-click`，没有 `remote-command` | 远程 capability、插件命令或 IPC 权限失败 |
| 有 `remote-command`，没有 `open-event-received` | 主 WebView 没有监听事件，或事件目标/生命周期有问题 |
| 有 `open-event-received`，出现 `open-event-ignored` | 当前项目不匹配、URL 不是 http/https，或当前项目已经切换 |
| 有 `open-tab-created`，没有新 WebView 创建日志 | `syncIdeWebviews` 没有触发，或打开请求被同步代数淘汰 |
| 有 `native-new-window-request`，没有前端事件 | Rust emit 或前端 listener 链路有问题 |
| 有 `invoke-failed` | 远程页面 IPC 权限或命令注册不完整，检查 capability 和 `build.rs` |
| 只有 `invoke-unavailable` | 页面没有拿到 Tauri IPC，脚本会回退为当前 WebView 导航 |

### 8.4 新增插件命令时必须同步三处

给远程页面增加 `browser-bridge` 命令时，必须同时修改：

1. `src-tauri/src/browser_bridge.rs` 的 `generate_handler!`。
2. `src-tauri/build.rs` 的 `InlinedPlugin::new().commands(...)`。
3. `src-tauri/capabilities/browser-bridge.json` 的 permission。

只修改其中一处，通常会表现为页面点击日志存在，但 `invoke` 失败或远程页面没有权限。

## 9. 已踩过的错误方案

### 错误 1：只修改 CSS 或 z-index

原生 WebView 不属于 HTML stacking context。CSS 的 `z-index` 不能覆盖它。

正确做法是调整原生 WebView 的 geometry，并在 Modal 等遮罩出现时隐藏它。

### 错误 2：使用 `viewport.top + 1` 作为原生 WebView 起点

回读坐标可能看似没有覆盖 Tab，但 macOS 的原生绘制视觉结果仍可能覆盖 Tab。

正确做法是使用：

```text
tabBarBottom + 32
```

并同步减少高度。

### 错误 3：只依赖 `Webview.position()` 和 `Webview.size()` 回读

回读值只能证明原生 API 接受了目标值，不能证明视觉层没有遮挡 DOM。

必须结合：

- DOM `getBoundingClientRect()`。
- 原生回读。
- 实际截图或人工界面验证。

### 错误 4：继续使用前端 `new Webview`，再尝试补新窗口事件

前端 WebView API 没有 `on_new_window` builder 配置。需要新窗口转新 Tab 时，必须改用 Rust `WebviewBuilder` 创建。

### 错误 5：只在 WebView 创建完成后 `eval` 一次链接脚本

页面导航后脚本会随着旧 document 消失。必须使用 `initialization_script_for_all_frames`，保证每个新 document 都重新安装拦截器。

### 错误 6：让远程页面直接调用普通自定义应用命令

外部 URL 受 Tauri remote ACL 约束。必须通过带明确 capability permission 的 `browser-bridge` 插件命令，并且命令内部继续校验 URL 和参数。

### 错误 7：新窗口直接 `Allow`

直接 Allow 可能创建脱离 React Tab 状态的原生窗口。需要由 Rust emit 事件、由 React 创建标签页，最后返回 `Deny`。

### 错误 8：只关闭 WebView，不注销浏览器目标

这会让 MCP 继续持有失效目标。标签页删除、项目切换和组件卸载都必须同时 close 和 unregister。

## 10. 修改后的验证清单

修改内置 WebView 后至少执行：

```bash
npm --prefix ui run build
cargo check --manifest-path src-tauri/Cargo.toml
git diff --check
```

手动验证：

1. 打开项目详情页，确认 Tab 栏可见且未被网页覆盖。
2. 切换 `code-server` 和自定义网页标签页。
3. 点击普通链接，确认当前 WebView 导航。
4. 点击 `target="_blank"` 链接，确认生成并激活新的 IDE 标签页。
5. 在页面中触发 `window.open()`，确认同样生成新标签页。
6. 打开 Modal、Select、Dropdown，确认原生 WebView 不遮挡控件。
7. 调整窗口大小，确认 WebView 和 MCP bounds 同步变化。
8. 删除新标签页，确认原生 WebView 和浏览器目标都被清理。
9. 切换项目，确认旧项目的原生 WebView 和 MCP 目标都被清理。
10. 检查 dev 日志中没有持续刷屏的定位日志，打开链接时能看到 `[IDE_OPEN]` 链路。
