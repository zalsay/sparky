# Rust 服务侧需求文档（接口清单版 + 数据库表设计版）

## 1. 文档目标

本文用于给后端 Rust 服务侧同步开发，覆盖两部分：

1. 当前本地 Rust / Tauri 已承载能力的服务端对齐需求
2. 用户注册 / 登录 / 项目授权体系的新增需求

目标是让现有前端在 browser/web 模式下逐步摆脱本地 Tauri 运行时，迁移到服务端统一承载，同时尽量保持现有 UI 与接口形态稳定。

---

## 2. 总体约束

### 2.1 鉴权分层

#### 用户态接口
- 路径前缀：`/api/**`
- 鉴权方式：`Authorization: Bearer <access_token>`
- 建议同时支持 `HttpOnly + SameSite=Lax` refresh cookie

#### 内部运行时 / agent 接口
- 路径前缀：`/internal/**`
- 鉴权方式：`agent_token` 或 mTLS
- **不能**复用用户 JWT

### 2.2 权限模型

建议按项目成员角色控制：

- `owner`：项目删除、成员管理、项目级配置
- `admin`：provider/config/hooks/session 管理
- `member`：terminal/Claude session/WebIDE 使用
- `viewer`：只读查看

### 2.3 兼容原则

前端当前已依赖的路径建议优先保留：

- `GET /api/projects`
- `POST /api/projects`
- `DELETE /api/projects/:id`
- `GET /api/projects/:id/detail`
- `GET /api/sessions`
- `POST /api/sessions/:id/rename`
- `POST /api/sessions/:id/delete`
- `POST /api/sessions/:id/resume`
- `GET /api/terminal/history`
- `POST /api/terminal/exec`
- `GET /api/config`
- `POST /api/config`
- `GET /api/providers`
- `POST /api/providers`
- `DELETE /api/providers/:app_type/:id`
- `GET /api/hooks`
- `DELETE /api/hooks/:id`
- `POST /api/hooks/batch-delete`
- `GET /api/web-ide/summary`
- `GET /api/web-ide/events`
- `GET /api/events`

### 2.4 统一错误码建议

- `UNAUTHORIZED`
- `TOKEN_EXPIRED`
- `FORBIDDEN`
- `PROJECT_NOT_FOUND`
- `SESSION_NOT_FOUND`
- `TERMINAL_NOT_FOUND`
- `PROVIDER_NOT_FOUND`
- `AGENT_OFFLINE`
- `AGENT_TIMEOUT`
- `WEB_IDE_NOT_READY`
- `INVALID_PROJECT_ID`
- `INVALID_REQUEST`

---

## 3. 接口清单

## 3.1 用户注册 / 登录 / 会话管理

| API | 鉴权 | 状态 | 说明 | 优先级 |
|---|---|---|---|---|
| `POST /api/auth/register` | 公共 | 新增 | 用户注册，返回用户信息与 access token | P0 |
| `POST /api/auth/login` | 公共 | 新增 | 用户登录，支持 username/email + password | P0 |
| `POST /api/auth/refresh` | refresh token | 新增 | 刷新 access token | P0 |
| `POST /api/auth/logout` | 登录态 | 新增 | 注销当前登录会话 | P0 |
| `GET /api/me` | 登录态 | 新增 | 获取当前用户信息、角色、项目摘要 | P0 |
| `PATCH /api/me/password` | 登录态 | 新增 | 修改密码 | P1 |
| `GET /api/me/projects` | 登录态 | 新增 | 获取当前用户可访问项目列表 | P0 |

### 注册 / 登录返回建议

```json
{
  "user": {
    "id": "u_xxx",
    "username": "ying",
    "display_name": "ying",
    "email": "a@b.com"
  },
  "access_token": "jwt-or-opaque-token",
  "expires_in": 3600
}
```

---

## 3.2 项目与成员权限

| API | 鉴权 | 状态 | 说明 | 优先级 |
|---|---|---|---|---|
| `GET /api/projects` | 登录态 | 已有 | 只返回当前用户有权限的项目 | P0 |
| `POST /api/projects` | 登录态 | 已有 | 创建项目 | P0 |
| `PATCH /api/projects/:id` | 登录态 | 新增 | 更新项目名称/路径/项目配置 | P0 |
| `DELETE /api/projects/:id` | 登录态 | 已有 | 删除项目，仅 `owner` 可执行 | P0 |
| `GET /api/projects/:id/detail` | 登录态 | 已有 | 返回项目详情聚合结果 | P0 |
| `GET /api/projects/:id/members` | 登录态 | 新增 | 获取项目成员列表 | P0 |
| `POST /api/projects/:id/members` | 登录态 | 新增 | 添加项目成员并设置角色 | P0 |
| `PATCH /api/projects/:id/members/:user_id` | 登录态 | 新增 | 修改成员角色 | P0 |
| `DELETE /api/projects/:id/members/:user_id` | 登录态 | 新增 | 移除项目成员 | P0 |

### 项目详情返回建议

```json
{
  "project": {
    "id": 1,
    "name": "claude-monitor",
    "path": "/workspace/claude-monitor",
    "hooks_enabled": true
  },
  "sessions": [],
  "terminal_history": [],
  "web_ide": {
    "status": "running",
    "url": "https://..."
  }
}
```

---

## 3.3 配置与 AI Provider

| API | 鉴权 | 状态 | 说明 | 优先级 |
|---|---|---|---|---|
| `GET /api/config` | 登录态 | 已有 | 获取系统/用户可见配置 | P0 |
| `POST /api/config` | 登录态 | 已有 | 保存配置，建议区分 system/user scope | P0 |
| `GET /api/providers` | 登录态 | 已有 | 获取 provider 列表 | P0 |
| `POST /api/providers` | 登录态 | 已有 | 新增或更新 provider | P0 |
| `DELETE /api/providers/:app_type/:id` | 登录态 | 已有 | 删除 provider | P0 |
| `POST /api/providers/:app_type/:id/test` | 登录态 | 新增 | 测试 provider 可用性 | P1 |
| `POST /api/providers/:app_type/:id/duplicate` | 登录态 | 新增 | 服务端复制 provider | P1 |
| `POST /api/providers/import` | 登录态 | 新增 | 导入 provider 配置 | P2 |

---

## 3.4 Claude Session / Terminal / Runtime

### 3.4.1 前端已依赖接口

| API | 鉴权 | 状态 | 说明 | 优先级 |
|---|---|---|---|---|
| `GET /api/sessions?project_id=` | 登录态 | 已有 | 获取项目会话列表 | P0 |
| `POST /api/sessions/:id/rename` | 登录态 | 已有 | 重命名会话 | P0 |
| `POST /api/sessions/:id/delete` | 登录态 | 已有 | 删除会话 | P0 |
| `POST /api/sessions/:id/resume` | 登录态 | 已有 | 恢复 Claude 会话；当前可先兼容转发 | P0 |
| `POST /api/terminal/exec` | 登录态 | 已有 | 执行 terminal 命令；当前可先兼容转发 | P0 |
| `GET /api/terminal/history?project_id=` | 登录态 | 已有 | 获取 terminal 历史 | P0 |
| `GET /api/events?project_id=` | 登录态 | 已有 | 项目级 SSE 事件流 | P0 |

### 3.4.2 完整服务化后应补齐接口

| API | 鉴权 | 状态 | 说明 | 优先级 |
|---|---|---|---|---|
| `POST /api/terminal/spawn` | 登录态 | 新增 | 创建 PTY / Claude 终端 | P1 |
| `POST /api/terminal/:id/write` | 登录态 | 新增 | 向 PTY 写入输入 | P1 |
| `POST /api/terminal/:id/resize` | 登录态 | 新增 | 调整终端尺寸 | P1 |
| `POST /api/terminal/:id/kill` | 登录态 | 新增 | 结束 PTY | P1 |
| `GET /api/terminal/:id/status` | 登录态 | 新增 | 查询终端状态 | P1 |
| `GET /api/terminal/:id/active-process` | 登录态 | 新增 | 获取活跃进程 | P1 |
| `POST /api/terminal/:id/provider` | 登录态 | 新增 | 设置 terminal provider | P1 |
| `GET /api/projects/:id/claude/latest-jsonl` | 登录态 | 新增 | 获取最新 Claude jsonl | P1 |

### 项目 SSE 事件建议

- `terminal.output`
- `terminal.exit`
- `session.created`
- `session.updated`
- `session.deleted`
- `project.updated`

### SSE 数据结构建议

```json
{
  "type": "terminal.output",
  "project_id": 1,
  "terminal_id": "t_xxx",
  "session_id": "s_xxx",
  "content": "hello\n",
  "ts": 1710000000
}
```

---

## 3.5 Hook 与审计

| API | 鉴权 | 状态 | 说明 | 优先级 |
|---|---|---|---|---|
| `GET /api/hooks?project_id=&page=&page_size=` | 登录态 | 已有 | 分页获取 hook 记录 | P0 |
| `DELETE /api/hooks/:id?project_id=` | 登录态 | 已有 | 删除单条 hook 记录 | P0 |
| `POST /api/hooks/batch-delete` | 登录态 | 已有 | 批量删除 hook 记录 | P0 |
| `GET /api/projects/:id/hooks/config` | 登录态 | 新增 | 获取项目 hook 配置/开关 | P1 |
| `PATCH /api/projects/:id/hooks/config` | 登录态 | 新增 | 更新 hook 配置/开关 | P1 |
| `POST /api/projects/:id/hooks/install` | 登录态 | 新增 | 安装项目 hooks | P1 |
| `POST /api/projects/:id/hooks/uninstall` | 登录态 | 新增 | 卸载项目 hooks | P1 |
| `GET /api/projects/:id/hooks/install-status` | 登录态 | 新增 | 检查 hooks 是否已安装 | P1 |
| `GET /api/audit?project_id=&page=` | 登录态 | 新增 | 查询项目级审计日志 | P1 |

---

## 3.6 Web IDE / code-server / IDE 插件

| API | 鉴权 | 状态 | 说明 | 优先级 |
|---|---|---|---|---|
| `GET /api/web-ide/summary` | 登录态 | 已有 | 获取 WebIDE 项目状态摘要 | P0 |
| `GET /api/web-ide/events` | 登录态 | 已有 | WebIDE SSE 事件流 | P0 |
| `GET /api/projects/:id/web-ide/status` | 登录态 | 新增 | 获取项目 WebIDE 状态/访问地址 | P0 |
| `POST /api/projects/:id/web-ide/start` | 登录态 | 新增 | 启动项目 WebIDE | P0 |
| `POST /api/projects/:id/web-ide/restart` | 登录态 | 新增 | 重启 WebIDE / code-server | P1 |
| `GET /api/projects/:id/code-server/extensions` | 登录态 | 新增 | 获取已安装 code-server 扩展 | P1 |
| `POST /api/projects/:id/code-server/extensions` | 登录态 | 新增 | 安装 code-server 扩展 | P1 |
| `DELETE /api/projects/:id/code-server/extensions/:extension_id` | 登录态 | 新增 | 删除扩展 | P2 |
| `GET /api/projects/:id/ide-plugins` | 登录态 | 新增 | 获取 IDE 插件配置 | P1 |
| `POST /api/projects/:id/ide-plugins` | 登录态 | 新增 | 添加 IDE 插件 | P1 |
| `DELETE /api/projects/:id/ide-plugins/:plugin_id` | 登录态 | 新增 | 删除 IDE 插件 | P1 |
| `GET /api/system/dependencies` | 管理员 | 新增 | 检查服务依赖 | P1 |
| `GET /api/system/code-server/status` | 管理员 | 新增 | 获取 code-server 状态 | P1 |
| `POST /api/system/code-server/install` | 管理员 | 新增 | 安装 code-server | P2 |
| `POST /api/system/code-server/restart` | 管理员 | 新增 | 重启全局 code-server | P1 |

---

## 3.7 其他业务接口

| API | 鉴权 | 状态 | 说明 | 优先级 |
|---|---|---|---|---|
| `GET /api/projects/:id/recent-urls` | 登录态 | 新增 | 获取项目最近 URL | P1 |
| `POST /api/projects/:id/recent-urls` | 登录态 | 新增 | 记录最近 URL | P1 |
| `GET /api/projects/:id/testing-session` | 登录态 | 新增 | 获取 testing session | P1 |
| `POST /api/projects/:id/testing-session` | 登录态 | 新增 | 保存 testing session | P1 |
| `GET /api/system/mcp/status` | 管理员 | 新增 | 获取 MCP 服务状态 | P2 |
| `POST /api/system/mcp/start` | 管理员 | 新增 | 启动 MCP 服务 | P2 |
| `POST /api/integrations/feishu/test` | 管理员 | 新增 | 测试飞书连接 | P2 |
| `POST /api/integrations/feishu/message` | 管理员 | 新增 | 发送飞书消息 | P2 |

---

## 3.8 内部 agent / runtime 接口

如果短期仍保留“服务端统一入口 + agent/runtime 实际执行”的架构，建议单独保留内部接口：

| API | 鉴权 | 说明 | 优先级 |
|---|---|---|---|
| `POST /internal/agents/connect` | agent token | agent 注册/建立通道 | P0 |
| `POST /internal/agents/:id/heartbeat` | agent token | 心跳上报 | P0 |
| `POST /internal/agents/:id/runtime/request` | agent token | 服务向 agent 下发 runtime 请求 | P0 |
| `POST /internal/agents/:id/runtime/event` | agent token | agent 上报 terminal / webide / session 事件 | P0 |
| `GET /internal/agents` | 管理员/内部 | 查看 agent 在线状态 | P1 |

> 如果后续完全改成“服务本机直接持有 PTY / code-server / Claude runtime”，这组接口可以缩减；如果仍保留多 agent / 多节点，这组接口必须独立于用户鉴权体系。

---

## 3.9 不建议直接按原语义服务化的本地能力

以下能力不建议后端照搬当前 Tauri 调用语义：

- `open_folder`
  - 浏览器服务端无法替用户本机打开 Finder / 文件管理器
- `save_window_size`
  - 前端本地状态
- `set_active_terminal_id`
  - 前端本地状态
- `get_active_projects`
  - 更适合前端 session/local storage
- `check_file_exists`
  - 若确有需要，应收敛成 IDE 文件 API，而非通用 OS 文件探测
- `open_in_coder`
  - 应改成“返回 WebIDE URL”，而不是服务端执行打开动作
- `import_from_ccswitch`
  - 建议前端先解析，再调用标准 provider 导入接口

---

## 4. 数据库表设计

## 4.1 设计原则

1. **用户体系与业务体系分离**
   - 登录态、refresh token、项目授权单独建模
2. **项目资源全部带 `project_id`**
   - session / terminal / hook / webide / recent_urls 都要能按项目直接过滤
3. **用户权限通过 membership 控制**
   - 不再依赖静态 `allowed_projects`
4. **运行时节点可扩展**
   - 单机先用一个 `runtime_node`
   - 多机 / 多 agent 时可平滑扩展
5. **敏感字段必须加密/哈希**
   - `password_hash`
   - `refresh_token_hash`
   - provider API key / secret
6. **统一 UTC 时间字段**
   - `created_at`
   - `updated_at`
   - `deleted_at`
   - `last_*_at`

---

## 4.2 认证域

### 4.2.1 `users`

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | `TEXT/UUID` | PK | 用户 ID |
| `username` | `TEXT` | `UNIQUE NOT NULL` | 登录名 |
| `email` | `TEXT` | `UNIQUE` | 邮箱 |
| `password_hash` | `TEXT` | `NOT NULL` | Argon2/Bcrypt hash |
| `display_name` | `TEXT` |  | 展示名 |
| `avatar_url` | `TEXT` |  | 头像 |
| `status` | `TEXT` | `NOT NULL` | `active/disabled` |
| `last_login_at` | `DATETIME` |  | 最近登录时间 |
| `created_at` | `DATETIME` | `NOT NULL` | 创建时间 |
| `updated_at` | `DATETIME` | `NOT NULL` | 更新时间 |
| `deleted_at` | `DATETIME` |  | 软删除 |

**索引建议**
- `uk_users_username`
- `uk_users_email`

### 4.2.2 `user_sessions`

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | `TEXT/UUID` | PK | 登录会话 ID |
| `user_id` | `TEXT/UUID` | FK `users.id` | 所属用户 |
| `refresh_token_hash` | `TEXT` | `UNIQUE NOT NULL` | refresh token 哈希 |
| `client_type` | `TEXT` | `NOT NULL` | `web/desktop/api` |
| `user_agent` | `TEXT` |  | 浏览器/客户端 UA |
| `ip_address` | `TEXT` |  | 登录来源 |
| `expires_at` | `DATETIME` | `NOT NULL` | 过期时间 |
| `revoked_at` | `DATETIME` |  | 注销时间 |
| `last_used_at` | `DATETIME` |  | 最后使用时间 |
| `created_at` | `DATETIME` | `NOT NULL` | 创建时间 |

**索引建议**
- `idx_user_sessions_user_id`
- `idx_user_sessions_expires_at`

### 4.2.3 `project_memberships`

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `project_id` | `BIGINT` | FK `projects.id` | 项目 |
| `user_id` | `TEXT/UUID` | FK `users.id` | 用户 |
| `role` | `TEXT` | `NOT NULL` | `owner/admin/member/viewer` |
| `permissions_json` | `TEXT` |  | 细粒度权限预留 |
| `invited_by` | `TEXT/UUID` | FK `users.id` | 邀请人 |
| `joined_at` | `DATETIME` |  | 加入时间 |
| `created_at` | `DATETIME` | `NOT NULL` | 创建时间 |
| `updated_at` | `DATETIME` | `NOT NULL` | 更新时间 |

**约束建议**
- `PRIMARY KEY (project_id, user_id)`

**索引建议**
- `idx_project_memberships_user_id`
- `idx_project_memberships_role`

---

## 4.3 基础业务域

### 4.3.1 `runtime_nodes`

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | `TEXT` | PK | 运行时节点 ID，如 `local` / `agent-1` |
| `name` | `TEXT` | `NOT NULL` | 节点名称 |
| `type` | `TEXT` | `NOT NULL` | `embedded/agent` |
| `status` | `TEXT` | `NOT NULL` | `online/offline/disabled` |
| `endpoint` | `TEXT` |  | 节点地址/标识 |
| `last_heartbeat_at` | `DATETIME` |  | 最近心跳 |
| `metadata_json` | `TEXT` |  | 扩展字段 |
| `created_at` | `DATETIME` | `NOT NULL` | 创建时间 |
| `updated_at` | `DATETIME` | `NOT NULL` | 更新时间 |

### 4.3.2 `projects`

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | `BIGINT` | PK | 项目 ID，兼容当前模型 |
| `name` | `TEXT` | `NOT NULL` | 项目名 |
| `path` | `TEXT` | `NOT NULL` | 服务端可访问路径 |
| `runtime_node_id` | `TEXT` | FK `runtime_nodes.id` | 所属运行时节点 |
| `created_by` | `TEXT/UUID` | FK `users.id` | 创建人 |
| `hooks_enabled` | `BOOLEAN` | `NOT NULL DEFAULT 0` | hooks 总开关 |
| `status` | `TEXT` | `NOT NULL` | `active/archived/deleted` |
| `created_at` | `DATETIME` | `NOT NULL` | 创建时间 |
| `updated_at` | `DATETIME` | `NOT NULL` | 更新时间 |
| `deleted_at` | `DATETIME` |  | 软删除 |

**索引 / 约束建议**
- `UNIQUE(runtime_node_id, path)`
- `idx_projects_created_by`

### 4.3.3 `system_settings`

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `key` | `TEXT` | PK | 配置键 |
| `value_json` | `TEXT` | `NOT NULL` | 配置值 |
| `updated_by` | `TEXT/UUID` | FK `users.id` | 修改人 |
| `updated_at` | `DATETIME` | `NOT NULL` | 更新时间 |

> 当前 `AppConfig` 建议先落到这张表中，后续如有必要再拆更细。

### 4.3.4 `user_preferences`

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `user_id` | `TEXT/UUID` | FK `users.id` | 用户 |
| `key` | `TEXT` |  | 配置键 |
| `value_json` | `TEXT` | `NOT NULL` | 值 |
| `updated_at` | `DATETIME` | `NOT NULL` | 更新时间 |

**约束建议**
- `PRIMARY KEY (user_id, key)`

---

## 4.4 Provider / 模型配置域

### 4.4.1 `ai_providers`

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | `TEXT` | PK | provider ID |
| `scope_type` | `TEXT` | `NOT NULL` | `system/project/user` |
| `scope_id` | `TEXT` |  | 作用域 ID |
| `app_type` | `TEXT` | `NOT NULL` | 如 `claude/openai/gemini` |
| `name` | `TEXT` | `NOT NULL` | 展示名 |
| `secret_encrypted` | `TEXT` |  | 加密后的 API key / secret |
| `config_json` | `TEXT` |  | 模型配置、headers、额外参数 |
| `created_by` | `TEXT/UUID` | FK `users.id` | 创建人 |
| `created_at` | `DATETIME` | `NOT NULL` | 创建时间 |
| `updated_at` | `DATETIME` | `NOT NULL` | 更新时间 |
| `deleted_at` | `DATETIME` |  | 软删除 |

**索引建议**
- `idx_ai_providers_scope`
- `idx_ai_providers_app_type`

### 4.4.2 `ai_provider_endpoints`

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | `BIGINT` | PK | endpoint ID |
| `provider_id` | `TEXT` | FK `ai_providers.id` | 所属 provider |
| `endpoint_name` | `TEXT` |  | 名称 |
| `base_url` | `TEXT` |  | endpoint/base url |
| `model` | `TEXT` |  | 默认模型 |
| `headers_json` | `TEXT` |  | 额外 headers |
| `is_enabled` | `BOOLEAN` | `NOT NULL DEFAULT 1` | 是否启用 |
| `sort_order` | `INTEGER` | `NOT NULL DEFAULT 0` | 排序 |
| `created_at` | `DATETIME` | `NOT NULL` | 创建时间 |
| `updated_at` | `DATETIME` | `NOT NULL` | 更新时间 |

---

## 4.5 Claude / Terminal / 会话域

### 4.5.1 `claude_sessions`

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | `TEXT` | PK | Claude session ID |
| `project_id` | `BIGINT` | FK `projects.id` | 所属项目 |
| `owner_user_id` | `TEXT/UUID` | FK `users.id` | 发起用户 |
| `name` | `TEXT` |  | 会话名 |
| `provider_id` | `TEXT` | FK `ai_providers.id` | 当前 provider |
| `terminal_id` | `TEXT` | FK `terminal_sessions.id` | 关联终端 |
| `status` | `TEXT` | `NOT NULL` | `created/running/idle/stopped/error` |
| `latest_jsonl_path` | `TEXT` |  | 最新 jsonl 路径 |
| `metadata_json` | `TEXT` |  | 扩展字段 |
| `last_activity_at` | `DATETIME` |  | 最近活动时间 |
| `created_at` | `DATETIME` | `NOT NULL` | 创建时间 |
| `updated_at` | `DATETIME` | `NOT NULL` | 更新时间 |
| `deleted_at` | `DATETIME` |  | 软删除 |

**索引建议**
- `idx_claude_sessions_project_id`
- `idx_claude_sessions_last_activity_at`

### 4.5.2 `terminal_sessions`

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | `TEXT` | PK | terminal ID |
| `project_id` | `BIGINT` | FK `projects.id` | 所属项目 |
| `owner_user_id` | `TEXT/UUID` | FK `users.id` | 发起用户 |
| `claude_session_id` | `TEXT` | FK `claude_sessions.id` | 关联 Claude 会话 |
| `runtime_node_id` | `TEXT` | FK `runtime_nodes.id` | 运行节点 |
| `provider_id` | `TEXT` | FK `ai_providers.id` | 当前 provider |
| `status` | `TEXT` | `NOT NULL` | `starting/running/exited/killed/error` |
| `shell` | `TEXT` |  | shell/program |
| `pid` | `BIGINT` |  | 进程号 |
| `cols` | `INTEGER` |  | 终端宽度 |
| `rows` | `INTEGER` |  | 终端高度 |
| `active_process` | `TEXT` |  | 活跃进程名 |
| `exit_code` | `INTEGER` |  | 退出码 |
| `created_at` | `DATETIME` | `NOT NULL` | 创建时间 |
| `started_at` | `DATETIME` |  | 启动时间 |
| `ended_at` | `DATETIME` |  | 结束时间 |
| `last_output_at` | `DATETIME` |  | 最后输出时间 |

**索引建议**
- `idx_terminal_sessions_project_id`
- `idx_terminal_sessions_status`
- `idx_terminal_sessions_claude_session_id`

### 4.5.3 `terminal_io_logs`

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | `BIGINT` | PK | 自增 ID |
| `terminal_id` | `TEXT` | FK `terminal_sessions.id` | terminal |
| `seq` | `BIGINT` | `NOT NULL` | 顺序号 |
| `stream_type` | `TEXT` | `NOT NULL` | `stdin/stdout/stderr/system` |
| `content` | `TEXT` | `NOT NULL` | 输出内容 |
| `created_at` | `DATETIME` | `NOT NULL` | 写入时间 |

**约束建议**
- `UNIQUE(terminal_id, seq)`

### 4.5.4 `project_recent_urls`

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | `BIGINT` | PK | 自增 ID |
| `project_id` | `BIGINT` | FK `projects.id` | 项目 |
| `user_id` | `TEXT/UUID` | FK `users.id` | 用户 |
| `url` | `TEXT` | `NOT NULL` | URL |
| `title` | `TEXT` |  | 标题 |
| `last_used_at` | `DATETIME` | `NOT NULL` | 最近使用时间 |
| `created_at` | `DATETIME` | `NOT NULL` | 创建时间 |
| `updated_at` | `DATETIME` | `NOT NULL` | 更新时间 |

**约束建议**
- `UNIQUE(project_id, user_id, url)`

### 4.5.5 `project_testing_sessions`

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `project_id` | `BIGINT` | FK `projects.id` | 项目 |
| `user_id` | `TEXT/UUID` | FK `users.id` | 用户 |
| `session_id` | `TEXT` | FK `claude_sessions.id` | 当前 testing session |
| `updated_at` | `DATETIME` | `NOT NULL` | 更新时间 |

**约束建议**
- `PRIMARY KEY (project_id, user_id)`

---

## 4.6 Hook / IDE / 审计域

### 4.6.1 `project_hook_settings`

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `project_id` | `BIGINT` | PK / FK `projects.id` | 项目 |
| `enabled` | `BOOLEAN` | `NOT NULL DEFAULT 0` | hook 开关 |
| `install_state` | `TEXT` | `NOT NULL` | `unknown/installed/missing/error` |
| `config_json` | `TEXT` |  | hook 配置 |
| `last_checked_at` | `DATETIME` |  | 最近检查时间 |
| `updated_at` | `DATETIME` | `NOT NULL` | 更新时间 |

### 4.6.2 `hook_records`

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | `BIGINT` | PK | 记录 ID |
| `project_id` | `BIGINT` | FK `projects.id` | 项目 |
| `claude_session_id` | `TEXT` | FK `claude_sessions.id` | 会话，可空 |
| `hook_name` | `TEXT` | `NOT NULL` | hook 名 |
| `event_name` | `TEXT` | `NOT NULL` | 事件名 |
| `status` | `TEXT` | `NOT NULL` | `success/failed/blocked` |
| `input_json` | `TEXT` |  | 输入内容 |
| `output_json` | `TEXT` |  | 输出内容 |
| `created_at` | `DATETIME` | `NOT NULL` | 创建时间 |

**索引建议**
- `idx_hook_records_project_id_created_at`
- `idx_hook_records_status`

### 4.6.3 `web_ide_instances`

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | `TEXT/UUID` | PK | WebIDE 实例 ID |
| `project_id` | `BIGINT` | FK `projects.id` | 项目 |
| `owner_user_id` | `TEXT/UUID` | FK `users.id` | 发起用户 |
| `runtime_node_id` | `TEXT` | FK `runtime_nodes.id` | 节点 |
| `workspace_path` | `TEXT` | `NOT NULL` | 工作区路径 |
| `access_url` | `TEXT` |  | 访问 URL |
| `port` | `INTEGER` |  | 端口 |
| `status` | `TEXT` | `NOT NULL` | `starting/running/stopped/error` |
| `error_message` | `TEXT` |  | 错误信息 |
| `started_at` | `DATETIME` |  | 启动时间 |
| `stopped_at` | `DATETIME` |  | 停止时间 |
| `last_heartbeat_at` | `DATETIME` |  | 最近心跳 |
| `created_at` | `DATETIME` | `NOT NULL` | 创建时间 |
| `updated_at` | `DATETIME` | `NOT NULL` | 更新时间 |

**索引建议**
- `idx_web_ide_instances_project_id`
- `idx_web_ide_instances_status`

### 4.6.4 `ide_plugins`

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | `BIGINT` | PK | 插件记录 ID |
| `scope_type` | `TEXT` | `NOT NULL` | `system/project` |
| `scope_id` | `TEXT` | `NOT NULL` | 作用域 ID |
| `extension_id` | `TEXT` | `NOT NULL` | 扩展 ID |
| `desired_state` | `TEXT` | `NOT NULL` | `enabled/removed` |
| `installed_version` | `TEXT` |  | 已安装版本 |
| `last_operation_status` | `TEXT` |  | 最近安装结果 |
| `created_at` | `DATETIME` | `NOT NULL` | 创建时间 |
| `updated_at` | `DATETIME` | `NOT NULL` | 更新时间 |

**约束建议**
- `UNIQUE(scope_type, scope_id, extension_id)`

### 4.6.5 `audit_logs`

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | `BIGINT` | PK | 审计日志 ID |
| `actor_type` | `TEXT` | `NOT NULL` | `user/agent/system` |
| `actor_id` | `TEXT` | `NOT NULL` | 操作人 ID |
| `project_id` | `BIGINT` | FK `projects.id` | 项目，可空 |
| `action` | `TEXT` | `NOT NULL` | 例如 `project.delete` |
| `resource_type` | `TEXT` | `NOT NULL` | 资源类型 |
| `resource_id` | `TEXT` |  | 资源 ID |
| `request_id` | `TEXT` |  | 请求链路 ID |
| `detail_json` | `TEXT` |  | 详情 |
| `created_at` | `DATETIME` | `NOT NULL` | 创建时间 |

**索引建议**
- `idx_audit_logs_project_id_created_at`
- `idx_audit_logs_actor`
- `idx_audit_logs_action`

---

## 5. 最小可落地范围

### 5.1 第一批必须新增

- `users`
- `user_sessions`
- `project_memberships`
- `runtime_nodes`
- `audit_logs`

### 5.2 第二批建议在现有业务表基础上补字段

- `projects`
- `hook_records`
- `ai_providers`
- `ai_provider_endpoints`
- `claude_sessions`

### 5.3 第三批为完整运行时服务化补齐

- `terminal_sessions`
- `terminal_io_logs`
- `web_ide_instances`
- `project_hook_settings`
- `project_recent_urls`
- `project_testing_sessions`
- `ide_plugins`

---

## 6. 开发优先级建议

### P0
- 用户注册 / 登录 / refresh / logout
- `GET /api/me`
- 项目成员权限模型
- 保持现有 `/api/projects`、`/api/projects/:id/detail`、`/api/sessions`、`/api/config`、`/api/providers`、`/api/hooks`、`/api/web-ide/*` 路径兼容

### P1
- PTY / terminal 生命周期完整服务化
- Claude session 恢复与历史输出查询
- Hook 安装状态与配置接口
- WebIDE / code-server 项目级实例管理

### P2
- 飞书集成
- MCP 管理
- provider 导入与更多系统级运维接口

---

## 7. 一句话结论

建议后端先完成 **用户注册登录 + 项目成员权限 + 现有 `/api/...` 兼容接入**，再继续推进 **PTY / Claude / WebIDE runtime 完整服务化**，这样对前端改造最平滑、落地风险最低。
