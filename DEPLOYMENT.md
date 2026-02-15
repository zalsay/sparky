# 部署指南

## 前置要求

1. Rust 工具链 (1.70+)
2. 飞书开放平台应用（企业自建应用）

## 步骤一：创建飞书开放平台应用

### 1. 创建应用

1. 访问 [飞书开发者后台](https://open.feishu.cn/app)
2. 点击"创建企业自建应用"
3. 填写应用名称和描述
4. 在"应用能力"中开启"机器人"能力

### 2. 配置权限

在"权限管理"中申请以下权限：

- `im:message` - 获取与发送消息
- `im:message.group_at_msg` - 接收群聊@消息
- `im:message.p2p_msg` - 接收单聊消息
- `im:message:send_as_bot` - 以应用身份发消息

### 3. 配置事件订阅（长连接模式）

1. 在"事件与回调"中点击"添加事件"
2. 选择"接收消息"事件：`im.message.receive_v1`
3. 在"订阅方式"中选择"使用长连接接收事件"
4. 保存配置

### 4. 获取应用凭证

在"凭证与基础信息"页面获取：

- **App ID**: 应用的唯一标识
- **App Secret**: 应用的密钥

### 5. 发布应用

1. 点击"创建版本"
2. 填写版本说明
3. 提交审核
4. 审核通过后，在飞书中启用应用

## 步骤二：配置项目

### 方式一：使用 Tauri 桌面应用（推荐）

1. 启动应用：
   ```bash
   ./start-dev.sh
   ```

2. 在应用界面中填写：
   - App ID
   - App Secret
   - （可选）Encrypt Key
   - （可选）Verification Token

3. 点击"测试应用连接"验证配置

4. 点击"保存配置"

### 方式二：使用环境变量

1. 复制环境变量模板：
   ```bash
   cp .env.example .env
   ```

2. 编辑 `.env` 文件：
   ```env
   FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
   FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   FEISHU_CHAT_ID=oc_xxxxxxxxxxxxxxxxxxxxxxxx
   ```

## 步骤三：获取 Chat ID

Chat ID 是目标群聊或单聊的唯一标识。

### 方法一：通过 API 获取

```bash
# 获取用户或群聊列表
curl -X GET "https://open.feishu.cn/open-apis/im/v1/chats" \
  -H "Authorization: Bearer {tenant_access_token}"
```

### 方法二：通过群聊信息

1. 在飞书群聊中，点击群设置
2. 查看群信息
3. 找到群 ID（Chat ID）

## 步骤四：配置 Claude Code Hooks

### 项目级配置

在项目根目录创建 `.claude/settings.local.json`：

```json
{
  "hooks": {
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "/绝对路径/claude-monitor hook"
          }
        ]
      }
    ]
  }
}
```

### 全局配置

在 `~/.claude/settings.json` 中添加相同配置。

## 步骤五：构建和运行

### 构建项目

```bash
# 构建 CLI 版本
cargo build --release

# 构建 Tauri 应用
./build.sh
```

### 运行模式

#### 1. Hook 模式（自动）

当配置好 Claude Code hooks 后，每次触发 Notification 事件时会自动运行。

#### 2. 测试模式

```bash
# 发送测试消息到飞书
./target/release/claude-monitor test
```

## 长连接工作流程

```
Claude Code 触发 Notification
    ↓
Hook 监听器读取 stdin
    ↓
判断是否包含 "Do you want to proceed?"
    ↓
发送交互式卡片到飞书（通过 API）
    ↓
用户在飞书中点击按钮
    ↓
飞书通过长连接推送事件到你的服务
    ↓
处理用户选择（需要实现事件处理服务）
```

## 实现事件处理服务（可选）

如果需要实时处理用户在飞书中的回复，需要实现一个长连接服务：

```rust
// 示例：监听飞书消息事件
// 需要根据飞书开放平台的 WebSocket 长连接协议实现
// 具体实现请参考飞书开放平台文档
```

## 安全建议

1. **凭证保护**：
   - 不要将 App ID 和 App Secret 提交到版本控制
   - 使用环境变量或配置文件管理凭证
   - 定期更换 App Secret

2. **权限最小化**：
   - 只申请必要的权限
   - 定期审查应用权限

3. **消息加密**：
   - 使用 Encrypt Key 加敏感消息
   - 验证消息来源（Verification Token）

## 故障排查

### Hook 不触发

- 检查 `.claude/settings.json` 配置是否正确
- 确认命令路径是绝对路径
- 运行 `claude --debug` 查看详细日志

### 消息发送失败

- 检查 App ID 和 App Secret 是否正确
- 确认应用已发布并启用
- 检查权限配置是否完整
- 验证 Chat ID 是否正确

### 无法接收用户回复

- 确认已配置事件订阅
- 检查长连接服务是否正常运行
- 查看飞书开发者后台的事件推送日志

## 生产部署建议

### 使用 Systemd（Linux）

创建服务文件 `/etc/systemd/system/claude-monitor.service`：

```ini
[Unit]
Description=Claude Monitor
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/claude-monitor
ExecStart=/path/to/claude-monitor/target/release/claude-monitor test
Restart=on-failure
Environment="FEISHU_APP_ID=cli_xxxxx"
Environment="FEISHU_APP_SECRET=xxxxx"
Environment="FEISHU_CHAT_ID=oc_xxxxx"

[Install]
WantedBy=multi-user.target
```

### 使用 Docker

创建 `Dockerfile`：

```dockerfile
FROM rust:1.70 as builder
WORKDIR /app
COPY . .
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates
COPY --from=builder /app/target/release/claude-monitor /usr/local/bin/
CMD ["claude-monitor", "test"]
```

## 测试

### 测试应用连接

```bash
# 使用 Tauri 应用
# 点击"测试应用连接"按钮

# 或使用 CLI
./target/release/claude-monitor test
```

### 验证权限

在飞书中尝试：
1. 在群聊中 @机器人
2. 发送单聊消息
3. 检查机器人是否能正常接收和回复

## 更多资源

- [飞书开放平台文档](https://open.feishu.cn/document/)
- [飞书机器人开发指南](https://open.feishu.cn/document/home/introduction-to-feishu-platform/bot-development-Overview/)
- [消息卡片搭建工具](https://open.feishu.cn/cardkit)
