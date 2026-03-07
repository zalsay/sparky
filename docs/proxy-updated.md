# Proxy 更新记录：显式绑定新 Terminal 的 Provider

本文记录本次为减少 Sparky 中 `terminal -> provider map -> proxy fallback` 问题所做的改动。

## 背景

Sparky 当前的 Claude 请求链路本质上依赖这条路径：

```text
terminal_id -> terminal provider map -> proxy resolve_provider() -> upstream provider
```

其中：

- proxy 侧会先按 `terminal_id` 查 provider 映射：`src-tauri/src/proxy.rs:192`
- 如果映射不存在、provider_id 不可解析，才会进入 `app_type = claude` 的 fallback：`src-tauri/src/proxy.rs:231`
- PTY 侧只有在启动时拿到 `defaultProviderId`，或在复用既有 PTY 时调用 `set_terminal_provider`，才会把终端和 provider 真正绑定起来：`ui/src/hooks/usePty.ts:72`, `ui/src/hooks/usePty.ts:134`

之前的问题不在 proxy 本身“不会分流”，而在于**新 terminal 创建时经常没有先得到一个明确的 provider 绑定**，于是后续 Claude 请求容易掉进 fallback。

## 本次改动的核心思路

不再让用户点击 `+` 之后直接创建一个“未绑定 provider 的 terminal”，而是：

1. 点击 `+`
2. 先弹窗要求选择一个具体 provider
3. 选择后再创建 terminal tab
4. 将所选 provider 写入 terminal 的 `providerId`
5. 启动 PTY 时把这个 provider 传给后端

这样新 terminal 在第一次启动前，就已经具备明确的 provider 归属，能显著降低 proxy fallback 的概率。

## 已完成的改动

### 1. 新增“新建终端”弹窗

在 `ui/src/App.tsx` 中新增了 terminal 创建弹窗状态和确认逻辑：

- 弹窗状态：`ui/src/App.tsx:132`
- 打开弹窗：`ui/src/App.tsx:524`
- 确认创建 terminal：`ui/src/App.tsx:538`
- 弹窗 UI：`ui/src/App.tsx:1854`

现在点击 `+` 时，不再直接 `setProjectTerminals(...)`，而是先调用：

- `openCreateTerminalModal()`：`ui/src/App.tsx:524`

对应的 Tabs 编辑入口已改为：

- `ui/src/App.tsx:2034`

### 2. 新 terminal 创建时必须显式选择具体 provider

确认创建时，会直接把 provider 写入 terminal tab：

```ts
{ id: newId, title: `Claude-${current.length + 1}`, providerId: newTerminalProviderId }
```

位置：`ui/src/App.tsx:545`

这意味着新 terminal 从创建开始就不再是“空 provider 状态”。

### 3. 记住每个项目“上次选择的 provider”

新增本地存储 key：

- `LAST_PROVIDER_BY_PROJECT_STORAGE_KEY`：`ui/src/App.tsx:102`

并通过 `localStorage` 按项目路径保存上次选择：

- 读取：`ui/src/App.tsx:136`
- 持久化：`ui/src/App.tsx:287`

再次点击 `+` 时：

- 如果该项目上次选择的 provider 仍然存在，则自动选中它：`ui/src/App.tsx:532`
- 在 provider 列表中显示“上次选择”标签：`ui/src/App.tsx:1880`

### 4. terminal 顶部 provider 下拉只保留具体 provider

终端顶部的 provider 选择器已改为只显示具体 provider：

- `ui/src/App.tsx:2109`

本次移除了这类混合语义入口：

- 项目默认
- 系统设置 `system::claude`

这样可以避免 UI 层继续制造“看起来像绑定了 provider，实际上还是在走默认/回退”的状态。

### 5. provider 切换时同步后端 terminal-provider 映射

当用户在 terminal 顶部切换 provider 时，除了更新前端状态外，还会调用：

```ts
invoke('set_terminal_provider', { terminal_id: term.id, provider_id: providerId })
```

位置：`ui/src/App.tsx:2127`

这能让 proxy 在后续请求中更稳定地按 terminal 解析到正确 provider。

### 6. PTY 启动/复用链路仍会同步 provider

本次前端改动与现有 `usePty` 逻辑形成闭环：

- 复用已有 PTY 时会调用 `set_terminal_provider`：`ui/src/hooks/usePty.ts:72`
- 新建 PTY 时会把 `default_provider_id` 传给后端：`ui/src/hooks/usePty.ts:134`

因此对“新建 terminal 先选 provider”这个交互来说，当前链路已经能把选择传递到 PTY/Proxy 侧。

## 本次改动没有修改的部分

本次**没有直接修改** proxy 的转发实现，`src-tauri/src/proxy.rs` 的核心解析逻辑保持不变。

也就是说，这次更新的重点不是改 proxy 算法，而是**减少 fallback 发生的前置条件**：

- 让 terminal 更早拥有明确 provider
- 减少“无绑定 terminal”进入代理链路的机会

## 当前效果

对于通过 `+` 新建的 terminal：

- 创建前必须选择具体 provider
- terminal tab 会持有 `providerId`
- PTY 启动时会携带对应 provider
- proxy 更容易直接命中 terminal-provider 映射，而不是走全局 fallback

## 已验证

已执行前端构建验证：

```bash
npm run build
```

结果：构建通过。

## 仍然存在的残留风险

虽然 `+` 新建 terminal 的入口已经改为显式绑定 provider，但目前仍有残留的默认/兜底链路：

### 1. Terminal 启动时仍保留默认 provider 兜底

当前 `TerminalComponent` 传参仍然是：

```ts
const providerIdStr = term.providerId || selectedProject?.default_provider_id || appConfig?.default_provider_id;
```

位置：`ui/src/App.tsx:2165`

这表示：

- 新建 terminal 已优先使用 `term.providerId`
- 但如果某些 terminal 没有 `providerId`，仍可能继续走项目默认 / 全局默认链路

### 2. 某些特殊 terminal 入口仍未显式指定 provider

例如 `MCP 测试` terminal 的创建逻辑仍是：

- `ui/src/App.tsx:1695`

该入口当前创建 terminal 时没有显式写入 `providerId`，因此仍可能落回默认/fallback 行为。

## 后续建议

如果要继续彻底收敛 fallback，下一步建议是：

1. 把所有 terminal 创建入口统一改成“显式 provider 绑定”
2. 逐步从 terminal 启动链路中移除：
   - `selectedProject?.default_provider_id`
   - `appConfig?.default_provider_id`
3. 对 `MCP 测试`、恢复会话、特殊入口等场景补齐 provider 选择或继承规则

## 一句话总结

本次更新没有改 proxy 的解析逻辑，而是把问题前移到 terminal 创建阶段处理：

**新 terminal 必须先选择具体 provider，再创建并启动 PTY，从而减少 `terminal -> provider map -> proxy fallback` 的发生概率。**
