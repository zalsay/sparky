# Sparky - Claude Code Monitor & Feishu Connector

**Sparky** 是一个强大的 Claude Code 伴侣应用，旨在通过**飞书（Feishu）WebSocket** 和**内置长连接终端 (PTY)** 实现对 Claude Code 的远程监控、权限管理和无缝交互控制。它结合了 Rust 的高性能后端与 Tauri 的跨平台桌面能力，彻底免去公网 IP 的烦恼，为您提供随叫随到的 AI 辅助编码体验。

## ✨ 核心特性

- **🔌 内置 PTY 终端与项目管理**：
    - 在桌面应用内直观管理多个代码项目。
    - 一键为项目注入 Claude Code 监控 Hooks。
    - 应用内置全功能终端（基于 `xterm.js` 和 Rust PTY），直接在应用内运行 Claude Code，支持日志回溯与快捷命令。

- **🚀 飞书 WebSocket 长连接 (无需公网 IP)**：
    - 废弃了传统的 Webhook Server 模式。通过配置飞书 App ID / App Secret，Sparky 应用会自动与飞书建立加密的长连接 (WebSocket)。
    - **极简部署**：无需配置 ngrok，不需要内网穿透或服务器部署。只要打开电脑上的桌面端，即可接收通知！

- **🔐 创新的远程交互与权限验证**：
    - 当 Claude Code 在终端中卡在 `Do you want to proceed?` 或工具调用确认界面时，Sparky 会精准捕获，并向您的飞书发送包含上下文和**配对码**（如 `91`）的卡片。
    - **快捷回复授权**：在飞书中直接回复 `91-1`（同意）、`91-2`（始终同意）或 `91-3`（拒绝） 等列表按键。
    - 智能后端会自动转换这些回复为终端中的方向键和回车动作，精准操纵远端的互动命令行菜单，就如同您正在电脑前操作一样。

- **🖥️ 现代化专属 UI**：
    - **Tauri + React + Ant Design**，带来极速的原生桌面体验。
    - 支持深浅色主题自由切换，状态栏实时显示 WebSocket 连接健康度及后端项目活跃状态。
    - 提供“退出终端”等一键进程管理功能，防止僵尸进程。

## 🚀 快速开始

### 1. 配置飞书机器人
1. 前往 [飞书开放平台](https://open.feishu.cn/) 创建一个 **企业自建应用**。
2. 在应用功能中开启 **机器人** 能力，并申请接收消息相关权限。
3. 进入应用的 **凭证与基础信息**，获取 `App ID` 和 `App Secret`。

### 2. 构建与运行 Sparky
**开发模式调试**:
```bash
# 启动前端页面与 Rust 后端
./start-dev.sh
```

**构建分发版本**:
```bash
./build.sh
# 产物将生成在 src-tauri/target/release/bundle/ 目录下
```

### 3. 连接飞书配置
1. 打开 Sparky 桌面应用。
2. 左侧导航栏进入 **设置**。
3. 填入上面获取到的 `App ID` 和 `App Secret`。
4. 选填接收消息的 `Chat ID` 或 `Open ID`（可选项，指定推送给个人还是群）。
5. 保存配置。界面标题栏区域的“未连接”徽标会变为绿色的“已连接”。

### 4. 接入并运行您的代码项目
1. 在 **项目** 选项卡下点击 **添加项目**，选择您的代码目录。
2. 找到此项目，点击 **配置** 为其安装 `.claude/settings.local.json` 监控指令。
3. 点击 **Go >** 进入此项目的独立监控终端。
4. 在应用内集成的终端输入 `claude` (需全局安装过) 开始对话。发生确认事件即可在手机飞书上点击确认！

## 📦 目录结构

```text
claude-monitor/
├── src/                    # 专供 Claude 调用的 Hook CLI (Rust)
│   ├── main.rs             # Hook 主程序，截取上下文
│   ├── feishu.rs           # 数据库状态记录与飞书请求编码
│   └── hooks.rs            # 数据流过滤与 I/O 捕捉
├── src-tauri/              # Tauri 桌面应用核心守护后端 (Rust)
│   ├── src/lib.rs          # 数据库轮询、飞书 WebSocket 管理、路由
│   ├── src/pty.rs          # 终端 PTY 进程隔离控制台与生命周期管理
│   └── tauri.conf.json     # Tauri 构建设定档
├── ui/                     # 桌面应用前端大屏 (React + TS)
│   ├── src/App.tsx         # 主窗体与路由
│   ├── src/components/     # Xterm 终端组件等
│   └── src/hooks/          # React PTY 通信状态挂载
└── build.sh                # 全自动打包脚本
```

## 🛠 技术栈
- **核心引擎**: Rust + Tauri 2.0
- **本地持久化**: SQLite (rusqlite)
- **前端窗体**: React (Vite) + Ant Design + Xterm.js
- **OS 进程交互**: Portable PTY

## 📜 License
MIT
