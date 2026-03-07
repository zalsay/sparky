# cc-switch 中按 Provider 打开 Claude 终端的实现说明

本文记录 `cc-switch` 中“在每个 provider 的控制按钮里直接打开对应 Claude 终端”的实现方式，供 Sparky 后续设计参考。

## 结论

`cc-switch` 这套能力的核心不是“应用内多 PTY + 运行时 provider 路由”，而是：

1. 从目标 provider 的配置中提取环境变量
2. 生成一个临时的 Claude settings JSON 文件
3. 启动系统终端
4. 在该终端中执行：

```bash
claude --settings <temp-settings-file>
```

因此，每次点击 provider 的“打开终端”按钮，实际得到的是：

- 一个新的系统终端窗口/标签页
- 一个新的 Claude 进程
- 一份仅供该终端使用的临时 settings 文件

这种方式属于**进程级隔离**，而不是在应用内部对多个 PTY 请求做 provider 分流。

---

## 前端调用链

provider 卡片上的终端按钮定义在：

- `cc-switch/src/components/providers/ProviderActions.tsx:276`
- `cc-switch/src/components/providers/ProviderCard.tsx:400`

最终在应用入口中绑定到：

- `cc-switch/src/App.tsx:635`
- `cc-switch/src/App.tsx:637`

前端调用的是：

- `cc-switch/src/lib/api/providers.ts:86`

对应的 Tauri 命令为：

```ts
invoke("open_provider_terminal", { providerId, app: appId })
```

---

## 后端核心流程

后端入口在：

- `cc-switch/src-tauri/src/commands/misc.rs:717`

`open_provider_terminal` 的处理流程如下：

### 1. 读取指定 provider

先从 provider 列表中找到目标 provider：

- `cc-switch/src-tauri/src/commands/misc.rs:724`
- `cc-switch/src-tauri/src/commands/misc.rs:728`

### 2. 从 provider.settings_config 提取环境变量

提取逻辑位于：

- `cc-switch/src-tauri/src/commands/misc.rs:743`

这里会读取配置中的 `env` 字段，并按应用类型补充关键变量。对于 Claude，重点关注：

- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_AUTH_TOKEN`
- 以及 provider 自带的其他 env

### 3. 生成临时 Claude settings 文件

临时文件写入逻辑位于：

- `cc-switch/src-tauri/src/commands/misc.rs:792`
- `cc-switch/src-tauri/src/commands/misc.rs:830`

生成的 JSON 结构大致如下：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "...",
    "ANTHROPIC_AUTH_TOKEN": "..."
  }
}
```

注意：这里写的是**临时文件**，不是直接覆盖全局 `~/.claude/settings.json`。

---

## 终端启动方式

### macOS

macOS 分支会生成一个临时 shell script，然后调用系统终端执行：

- `cc-switch/src-tauri/src/commands/misc.rs:850`
- `cc-switch/src-tauri/src/commands/misc.rs:863`
- `cc-switch/src-tauri/src/commands/misc.rs:868`

核心命令是：

```bash
claude --settings "<temp-config-path>"
```

并根据用户偏好选择 Terminal.app、iTerm2、Alacritty、Kitty、Ghostty、WezTerm 等终端。

### Linux

Linux 分支采用相同思路：

- `cc-switch/src-tauri/src/commands/misc.rs:1006`
- `cc-switch/src-tauri/src/commands/misc.rs:1031`
- `cc-switch/src-tauri/src/commands/misc.rs:1036`

同样是生成脚本后在系统终端中执行：

```bash
claude --settings "<temp-config-path>"
```

### Windows

Windows 分支会生成 `.bat` 文件，再用 `cmd` / `powershell` / `wt` 启动：

- `cc-switch/src-tauri/src/commands/misc.rs:1115`
- `cc-switch/src-tauri/src/commands/misc.rs:1126`
- `cc-switch/src-tauri/src/commands/misc.rs:1130`

核心依然是：

```bat
claude --settings "<temp-config-path>"
```

---

## 这套方案的本质

`cc-switch` 的 provider 终端能力，本质上是：

**在 Claude 进程启动前，就把该 provider 对应的配置文件显式传给 Claude CLI。**

也就是：

```text
provider -> 临时 settings.json -> 系统终端 -> claude --settings <temp-file>
```

它不是：

```text
应用内 PTY -> 请求发给 proxy -> proxy 再根据 terminal_id 决定 provider
```

因此它的隔离边界是**Claude 进程本身**，而不是应用内请求转发层。

---

## 与 cc-switch 的“切换当前 provider”机制区别

需要区分两条链路：

### A. 打开 provider 终端

本文描述的是这条链路：

- 仅为当前打开的终端生成一份临时 settings
- 使用 `claude --settings` 启动新 Claude 进程
- 不依赖当前全局 live config

相关入口：

- `cc-switch/src-tauri/src/commands/misc.rs:717`

### B. 切换当前 provider 并写入 live config

`cc-switch` 另有一套“切换当前 provider”的机制，会把当前 provider 写入 live 配置：

- `cc-switch/src-tauri/src/services/provider/mod.rs:579`
- `cc-switch/src-tauri/src/services/provider/mod.rs:588`
- `cc-switch/src-tauri/src/services/provider/live.rs:108`

对于 Claude，这条链路会写入实际配置文件路径，路径解析逻辑位于：

- `cc-switch/src-tauri/src/config.rs:72`

即通常为：

- `~/.claude/settings.json`

这与“打开 provider 终端”的临时文件方案不是同一件事。

---

## 对 Sparky 的启发

如果 Sparky 后续希望稳定支持“不同终端使用不同 provider”，`cc-switch` 提供了一个更直接的参考方向：

### 方案特点

- provider 选择在 Claude 启动前确定
- 每个终端使用独立 settings 文件
- 不依赖运行时 provider fallback
- 不需要在 proxy 中按 terminal_id 再查 provider

### 优势

- 终端之间天然隔离
- 语义更接近 Claude CLI 原生能力
- 更容易避免“映射丢失后退回全局 provider”的问题

### 代价

- 更适合“每个终端一个独立 Claude 进程”的模型
- 如果应用要做内嵌 PTY 复用、热切换 provider、共享会话，则需要额外设计

---

## 一句话总结

`cc-switch` 的实现方式不是“在应用里把多个 PTY 请求路由到不同 provider”，而是：

**为目标 provider 临时生成一份 Claude settings 文件，并通过 `claude --settings <temp-file>` 启动一个独立终端会话。**
