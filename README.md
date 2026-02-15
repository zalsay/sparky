# Claude Code Monitor with Feishu Integration

这是一个使用 Rust + Tauri 开发的 Claude Code 监视器，基于 Claude Code hooks 接口，实现远程与 Claude Code 的交互。

## 功能特性

- 🖥️ **图形化配置界面**：使用 Tauri 构建的桌面应用，方便配置和管理
- 💾 **本地配置保存**：配置自动保存到本地 JSON 文件
- 🔔 **实时监控**：监听 Claude Code 的 Notification 事件
- 📱 **飞书集成**：当出现 "Do you want to proceed?" 等需要用户确认的提示时，自动转发到飞书机器人
- 🎯 **远程交互**：通过飞书按钮回复对应的选项 (Yes/No)，实现远程交互
- 🌐 **HTTP 服务器**：支持 HTTP 服务器模式接收飞书回调

## 快速开始

### 方式一：使用桌面应用（推荐）

1. **启动开发模式**
   ```bash
   ./start-dev.sh
   ```
   
   或手动启动：
   ```bash
   cd ui && npm install && cd ..
   cargo tauri dev
   ```

2. **构建生产版本**
   ```bash
   ./build.sh
   ```
   
   构建完成后，应用位于 `src-tauri/target/release/bundle/` 目录

3. **使用应用配置**
   - 在应用界面中填写飞书 Webhook URL
   - 点击"测试 Webhook 连接"验证配置
   - 点击"保存配置"
   - 配置会自动保存到本地

### 方式二：命令行模式

#### 1. 配置飞书机器人

1. 在飞书中创建自定义机器人
2. 获取 Webhook URL
3. 配置机器人消息卡片回调地址 (http://your-server:3000/feishu/callback)

#### 2. 配置环境变量

复制 `.env.example` 为 `.env` 并填写配置:

```bash
cp .env.example .env
```

编辑 `.env` 文件:

```env
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/your-webhook-token
SERVER_HOST=0.0.0.0
SERVER_PORT=3000
```

#### 3. 构建项目

```bash
cargo build --release
```

#### 4. 配置 Claude Code Hooks

在项目根目录创建 `.claude/settings.local.json`:

```json
{
  "hooks": {
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/claude-monitor hook"
          }
        ]
      }
    ]
  }
}
```

或在用户全局配置 `~/.claude/settings.json` 中添加上述配置。

#### 5. 启动服务器模式 (可选)

如果需要独立运行服务器:

```bash
./target/release/claude-monitor server
```

## 使用方式

### Hook 模式

当 Claude Code 需要用户确认时,会自动触发 Notification hook,监视器会:

1. 读取 Claude Code 发送的通知内容
2. 发送交互式卡片到飞书
3. 等待用户在飞书中点击按钮
4. 将用户的选择返回给 Claude Code

### 服务器模式

独立运行 HTTP 服务器,接收飞书的回调请求:

```bash
./target/release/claude-monitor server
```

## 架构说明

```
claude-monitor/
├── src/                    # CLI 模式源代码
│   ├── main.rs            # 主程序入口
│   ├── config.rs          # 配置管理
│   ├── hooks.rs           # Claude Code hooks 处理
│   ├── feishu.rs          # 飞书机器人集成
│   └── server.rs          # HTTP 服务器
├── src-tauri/              # Tauri 桌面应用
│   ├── src/
│   │   └── lib.rs         # Tauri 后端逻辑
│   ├── Cargo.toml
│   └── tauri.conf.json    # Tauri 配置
├── ui/                     # 前端界面
│   ├── src/
│   │   ├── App.tsx        # 主应用组件
│   │   └── App.css        # 样式
│   ├── package.json
│   └── vite.config.ts
├── Cargo.toml             # 项目依赖
├── .env.example           # 环境变量示例
├── start-dev.sh           # 开发启动脚本
└── build.sh               # 构建脚本
```

## 工作流程

1. Claude Code 触发 Notification 事件
2. Hook 监听器读取 stdin 中的 JSON 数据
3. 解析通知内容,判断是否需要用户交互
4. 发送交互式卡片到飞书
5. 启动临时 HTTP 服务器等待回调
6. 用户在飞书中点击按钮
7. 飞书发送回调到 HTTP 服务器
8. 将用户选择返回给 Claude Code

## 注意事项

- 飞书机器人需要有消息卡片回调权限
- HTTP 服务器需要公网可访问 (可使用 ngrok 等工具)
- 飞书回调地址需要配置为: `http://your-server:3000/feishu/callback`

## 开发

### 开发模式

```bash
# Tauri 桌面应用开发模式
./start-dev.sh

# CLI 模式开发
cargo run -- hook
cargo run -- server
```

### 构建生产版本

```bash
# 构建 Tauri 应用
./build.sh

# 构建 CLI 版本
cargo build --release
```

### 技术栈

- **后端**: Rust + Tauri 2.0
- **前端**: React + TypeScript + Vite
- **UI 框架**: Ant Design
- **功能**:
  - Claude Code Hooks 集成
  - 飞书机器人 API
  - HTTP 服务器（Axum）
  - 本地配置管理

## License

MIT
