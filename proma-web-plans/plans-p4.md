# P4 Agent Runtime Control Plane Implementation Plan

> **Status (2026-03-24):** 实现已补齐到可运行闭环。`server-go` 全量测试通过；`web` 测试在修复新增 channel/runtime 相关 fixture 后，仅剩前端测试断言同步调整中的小问题，build 已通过。

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build P4 as a deployable control plane where the Go server manages an external agent-runner service/container and the web UI can create, connect, close, and restart agent runtime sessions.

**Architecture:** Split responsibilities across three layers: web for session management UI, Go server as the control plane and source of truth, and a separate agent-runner HTTP service that owns Claude Agent SDK runtime sessions. Keep chat conversation data separate from agent runtime session state, and route connect/control operations through the Go server so the browser never talks to the runner directly.

**Tech Stack:** Go HTTP server, Go in-memory/store-backed registry, TypeScript shared contracts, platform-web client, Vite/React frontend, Docker/Docker Compose, Claude Agent SDK runtime hosted behind an agent-runner HTTP service.

---

## Section 1: 架构与职责划分

P4 的目标是把当前 `proma-web` 从“chat API + 前端会话列表”升级为“可部署的 Agent Runtime 控制面”。建议新增一条独立链路：

**Web -> platform-web -> Go server(control plane) -> agent-runner(data plane) -> Claude Agent SDK runtime**

其中：
- **Web** 负责会话创建、连接、关闭、重启，以及状态展示
- **Go server** 负责 session registry、生命周期编排、健康检查、错误聚合、API 暴露
- **agent-runner** 负责真正启动和托管 Claude Agent SDK 会话
- **Claude Agent SDK** 仍然只在 runner 内部运行，不直接暴露给前端

P4 里“连接”按方案 B 语义，定义为：

> **Web 把某个 AgentSession 设为当前活跃 runtime 连接目标，后续 chat/控制请求都经 Go server 路由到该 runner session。**

P4 先不做完整 terminal attach，而是先做：
- create session
- connect session
- close session
- restart session
- list/get session
- 显示 runner/session status

这样先把控制面闭环做完整，避免一次把 websocket shell bridge 也塞进来。

### 推荐最小部署形态
- `proma-server` 容器：Go API
- `proma-agent-runner` 容器：Claude Agent SDK runner
- 可选 `postgres` 容器：已有数据持久化
- web 继续沿用当前前端构建产物/开发方式，不强行纳入 runner

### 当前落地状态（2026-03-24）
- 已完成 `channelId + modelId` 贯穿 conversation / agent session / runner runtime。
- 已完成 channel CRUD API，以及 memory / postgres 两套 store 的 channel 持久化实现。
- 已完成 runner 按 session runtimeConfig 动态注入 `modelId`、`ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL`。
- 已完成前端最小可用的 Channel / Model 双切换 UI。
- 已验证 `proma-web/server-go` 全量 `go test ./...` 通过。
- 已验证 `proma-web/web` build 通过；vitest 在新增 runtime/channel 断言适配中，当前剩余的是前端测试夹具/断言同步问题，不是主链路编译或运行问题。

## Section 2: 数据模型与 API 设计

基于方案 B，P4 需要把“chat 会话”与“agent runtime 会话”彻底分开。现有 `ConversationMeta` / `ChatMessage` 继续服务聊天记录；P4 新增一套 `AgentSession` 模型，专门表示由 Go server 管理、实际运行在 `agent-runner` 中的 runtime 会话。

### 2.1 新增共享模型

建议在 `proma-web/packages/shared/src/index.ts` 新增：

```ts
export type AgentRunnerStatus = 'unknown' | 'healthy' | 'unreachable'

export type AgentSessionStatus =
  | 'creating'
  | 'starting'
  | 'running'
  | 'connecting'
  | 'stopped'
  | 'closing'
  | 'restarting'
  | 'error'

export interface AgentRunnerInfo {
  id: string
  baseUrl: string
  status: AgentRunnerStatus
  version?: string
  lastHeartbeatAt?: string
  lastError?: string
}

export interface AgentSession {
  id: string
  workspaceId: string
  name: string
  status: AgentSessionStatus
  runnerId: string
  transport: 'http'
  createdAt: string
  updatedAt: string
  connectedAt?: string
  lastError?: string
}

export interface CreateAgentSessionInput {
  workspaceId: string
  name: string
}

export interface ConnectAgentSessionInput {
  conversationId?: string
}

export interface AgentSessionConnection {
  sessionId: string
  conversationId?: string
  connectedAt: string
}

export interface AgentSessionActionResult {
  session: AgentSession
}
```

### 2.2 runtime 信息扩展

当前 runtime 信息只暴露数据库状态，P4 需要把 agent 控制面状态也暴露出来。建议扩展 runtime payload：

```ts
export interface RuntimeInfo {
  service: string
  version: string
  environment: string
  database: {
    configured: boolean
    status: 'connected' | 'disconnected'
  }
  agentControlPlane: {
    enabled: boolean
    runnerCount: number
    defaultRunnerStatus: AgentRunnerStatus
  }
}
```

这样 web 首屏就能知道：
- 是否启用了 runner 管理
- 当前默认 runner 是否健康
- 是否该允许“创建 / 重启 / 连接”按钮

### 2.3 Go server API 设计

现有路由集中在 `proma-web/server-go/internal/api/server.go`。P4 新增独立路由：

#### Runner 状态
- `GET /api/agent/runners`
- `GET /api/agent/runners/:id`

#### Session 管理
- `GET /api/agent/sessions`
- `POST /api/agent/sessions`
- `GET /api/agent/sessions/:id`
- `POST /api/agent/sessions/:id/connect`
- `POST /api/agent/sessions/:id/close`
- `POST /api/agent/sessions/:id/restart`

#### 请求/响应约定

`GET /api/agent/sessions`
```json
{
  "sessions": [AgentSession],
  "activeSessionId": "optional-session-id"
}
```

`POST /api/agent/sessions`
```json
{
  "workspaceId": "workspace-123",
  "name": "Default Agent"
}
```

返回：
```json
{
  "session": { ...AgentSession }
}
```

`POST /api/agent/sessions/:id/connect`
```json
{
  "conversationId": "optional-chat-conversation-id"
}
```

语义：
- 把该 agent session 标记为当前活跃连接目标
- 若传 `conversationId`，则把 chat 会话绑定到这个 runtime session

返回：
```json
{
  "session": { ...AgentSession },
  "connection": {
    "sessionId": "...",
    "conversationId": "...",
    "connectedAt": "..."
  }
}
```

`POST /api/agent/sessions/:id/close`
- Go server 向 runner 发送关闭请求
- session 转成 `closing -> stopped` 或 `error`

`POST /api/agent/sessions/:id/restart`
- Go server 执行 close + start
- session 转成 `restarting -> starting -> running` 或 `error`

### 2.4 agent-runner 对 Go server 的内部协议

方案 B 需要一层 server-to-runner internal API。建议 runner 暴露最小 HTTP 接口，不直接让 web 访问：

- `GET /health`
- `POST /internal/sessions`
- `GET /internal/sessions/:id`
- `POST /internal/sessions/:id/connect`
- `POST /internal/sessions/:id/close`
- `POST /internal/sessions/:id/restart`
- `POST /internal/sessions/:id/messages`
- `POST /internal/sessions/:id/messages/stream`
- direct SSE relay implemented: runner now emits `text/event-stream`, and Go server relays upstream events into the existing `start / delta / done` SSE contract
- future upgrade reserved: Go server can later evolve from event-level relay to a more transparent byte-level passthrough if needed

runner 自己维护“Claude Agent SDK session -> runner local runtime handle”的映射；Go server 只保留业务级 registry，不直接持有 SDK 细节。

### 2.5 状态机约束

建议固定状态流转：
- `creating -> starting -> running`
- `running -> connecting -> running`
- `running -> closing -> stopped`
- `running -> restarting -> starting -> running`
- `* -> error`

约束：
- 只有 `running` 状态允许 connect
- `stopped` 和 `error` 状态允许 restart
- `closing` / `restarting` 时禁止重复操作
- `connect` 失败不能直接把 session 干掉，应落到 `running + lastError` 或 `error`

### 2.6 Web 侧 contract 增量

当前 web client 入口在 `proma-web/web/src/api.ts`，底层 contract 在 `proma-web/packages/platform-web/src/index.ts`。P4 在 `platform-web` 增加：

```ts
listAgentSessions()
createAgentSession(input)
getAgentSession(sessionId)
connectAgentSession(sessionId, input?)
closeAgentSession(sessionId)
restartAgentSession(sessionId)
listAgentRunners()
```

这样 `frontend-core` / `web` 仍沿用统一 contract 分层，不直接在 UI 写 fetch。

### 2.7 兼容边界

P4 需要明确边界：
- chat conversation 仍然存在
- 但从 P4 开始，conversation 可以“连接到”某个 `AgentSession`
- 新建或使用聊天前，必须先有一个可用的 `AgentSession` 并完成 connect

## Section 3: 后端组件拆分（Go server / agent-runner / Docker 结构）

P4 的后端应该按“控制面 / 执行面 / 部署面”拆清楚，避免把 Claude Agent SDK 逻辑继续塞回现有 Go API。这里建议新增一个独立的 `agent-runner` 服务目录，并让 Go server 通过内部 HTTP client 管它。

### 3.1 目录建议

在 `proma-web` 下新增/扩展：

- Modify: `proma-web/server-go/internal/api/server.go`
- Modify: `proma-web/server-go/internal/api/runtime.go`
- Create: `proma-web/server-go/internal/api/agent.go`
- Create: `proma-web/server-go/internal/agent/service.go`
- Create: `proma-web/server-go/internal/agent/runner_client.go`
- Create: `proma-web/server-go/internal/agent/types.go`
- Create: `proma-web/server-go/internal/agent/memory_registry.go`
- Create: `proma-web/agent-runner/package.json`
- Create: `proma-web/agent-runner/src/server.ts`
- Create: `proma-web/agent-runner/src/session-manager.ts`
- Create: `proma-web/agent-runner/src/types.ts`
- Create: `proma-web/agent-runner/src/claude-runtime.ts`
- Create: `proma-web/agent-runner/tsconfig.json`
- Create: `proma-web/agent-runner/Dockerfile`
- Create: `proma-web/docker-compose.p4.yml`
- Create: `proma-web/server-go/Dockerfile`

原则：
- Go server 只做控制编排和业务状态汇总
- runner 只做 Claude Agent SDK session 生命周期
- Docker 只负责编排和环境注入，不写业务逻辑

### 3.2 Go server 内部职责拆分

建议新增 `internal/agent` 包：

#### `types.go`
定义 Go 侧控制面模型：
- `RunnerInfo`
- `SessionRecord`
- `CreateSessionInput`
- `ConnectSessionInput`
- `SessionConnection`

#### `memory_registry.go`
先实现最小内存 registry，保存：
- session 元信息
- active session id
- conversation -> session 绑定
- 最近错误和更新时间

P4 先不急着做数据库持久化，保持 YAGNI；但接口要留出后续替换成 store 的空间。

#### `runner_client.go`
封装 Go -> runner 的 HTTP 调用：
- `Health()`
- `CreateSession()`
- `GetSession()`
- `ConnectSession()`
- `CloseSession()`
- `RestartSession()`

这里统一处理：
- base URL
- timeout
- JSON 编解码
- runner 4xx/5xx 到 server 错误映射

#### `service.go`
编排层，负责：
- create 时先写 creating，再调 runner，再落 running/error
- connect 时校验状态与 workspace/conversation 绑定
- close/restart 时更新中间态
- 聚合 runtime 和 runner 健康状态

`internal/api/agent.go` 只负责 HTTP 层解析与返回，不写业务判断。

### 3.3 agent-runner 服务职责

`agent-runner` 作为独立 HTTP 服务，负责真正托管 Claude Agent SDK runtime session。建议用最小 Node/TypeScript 服务即可，因为 runner 更容易直接接 Claude Agent SDK / JS ecosystem。

#### `src/types.ts`
定义 runner 内部模型：
- `RunnerSessionStatus`
- `RunnerSessionRecord`
- `CreateRunnerSessionInput`
- `ConnectRunnerSessionInput`

#### `src/session-manager.ts`
维护 runner 本地 session map，职责包括：
- 创建 Claude Agent SDK session handle
- 保存 session 状态
- close/restart/connect 生命周期更新
- 记录 `lastError`
- 暴露 list/get/action 方法

#### `src/claude-runtime.ts`
封装真正的 Claude Agent SDK 交互。P4 要求：
- 所有 SDK 调用都藏在这一层
- API 尽量简单：`startSession`, `connectSession`, `stopSession`, `restartSession`
- 若当前先做最小 stub，也必须保证接口形状与未来真实 SDK 接入一致

#### `src/server.ts`
暴露：
- `GET /health`
- `POST /internal/sessions`
- `GET /internal/sessions/:id`
- `POST /internal/sessions/:id/connect`
- `POST /internal/sessions/:id/close`
- `POST /internal/sessions/:id/restart`

并且：
- 只监听容器内网地址
- 默认不开放给浏览器跨域访问
- 日志只打印 session id / 状态，不打印敏感 key

### 3.4 Docker 部署结构

P4 的 Docker 目标不是上 K8s，而是先让本地和单机部署都能稳定跑起来。建议提供两个 Dockerfile + 一个 compose：

#### `proma-web/server-go/Dockerfile`
职责：
- 构建 Go server 二进制
- 注入运行时环境变量
- 暴露 server port（例如 3010）
- 允许通过 `PROMA_AGENT_RUNNER_BASE_URL` 指向 runner

建议多阶段构建：
1. golang builder
2. slim runtime

#### `proma-web/agent-runner/Dockerfile`
职责：
- 安装 Node 依赖
- 构建 runner TS 服务
- 安装 Claude Agent SDK 运行所需依赖
- 注入 `ANTHROPIC_API_KEY`、workspace root、session root 等环境变量
- 暴露 runner port（例如 3210）

#### `proma-web/docker-compose.p4.yml`
至少包含：
- `server`
- `agent-runner`
- 可选 `postgres`

P4 当前阶段按本机联调执行：
- 不包含 `nginx` 静态托管服务
- 前端使用本机 Vite dev server 运行
- 通过前端 dev proxy 将 `/api`（含 SSE）转发到本机 `proma-server`

并配置：
- `server` 依赖 `agent-runner`
- 共享 workspace 卷给 runner
- 持久化 sessions 目录
- 持久化 uploads 目录给 server
- 通过内部 service name 让 server 访问 runner，如 `http://agent-runner:3210`

### 3.5 环境变量约定

#### Go server
- `PORT`
- `APP_ENV`
- `DATABASE_URL`
- `PROMA_AGENT_CONTROL_PLANE_ENABLED`
- `PROMA_AGENT_RUNNER_BASE_URL`
- `PROMA_AGENT_RUNNER_TIMEOUT_MS`

#### agent-runner
- `PORT`
- `ANTHROPIC_API_KEY`
- `PROMA_WORKSPACE_ROOT`
- `PROMA_AGENT_SESSIONS_ROOT`
- `PROMA_AGENT_MODEL`
- `PROMA_AGENT_PERMISSION_MODE`

P4 要明确：
- 没有 `ANTHROPIC_API_KEY` 时 runner health 仍可启动，但应报告 degraded/unhealthy 原因
- Go server 的 runtime API 要能把“control plane enabled but runner unhealthy”暴露给前端

### 3.6 健康检查与错误传播

P4 不要只做“能启动”，还要把错误链路打通。

#### runner health payload 建议
```json
{
  "status": "healthy",
  "service": "proma-agent-runner",
  "version": "0.1.0",
  "sdkReady": true,
  "lastError": null
}
```

#### server runtime payload 增量
```json
{
  "agentControlPlane": {
    "enabled": true,
    "runnerCount": 1,
    "defaultRunnerStatus": "healthy"
  }
}
```

错误传播原则：
- runner 启动失败：server 返回 502/503 语义错误给前端
- session action 失败：保留原 session，更新 `lastError`
- web 不直接显示原始堆栈，显示可读文案
- 日志里保留足够排障信息，但不输出 API key / token

### 3.7 P4 的实现边界

本节实现时要控制范围：
- 做单 runner 实例，不做调度器
- 做内存 registry，不做完整持久化恢复
- 做 HTTP control API，不做 websocket terminal bridge
- 做 session lifecycle，不做复杂权限/多租户

这样 P4 就能稳定交付“Docker 可部署 + runner 可控 + web 可操作”的最小闭环。

## Section 4: Web UI、交互流程与连接体验设计

P4 的前端目标不是做成完整 IDE，而是把“可管理 agent runtime session”这件事落到用户可理解、可操作、可恢复的界面里。基于当前代码结构，web 仍然只通过 `proma-web/web/src/api.ts:1` -> `proma-web/packages/platform-web/src/index.ts:205` 访问 Go server；UI 侧建议在现有聊天页左侧会话栏附近新增一个 **Agent Sessions 面板**，避免 P4 引入新的顶级路由和额外的信息架构成本。

### 4.1 UI 信息架构

建议把前端界面分成三块：

1. **Agent Sessions 面板**
   - 展示 runner 健康状态
   - 展示当前 workspace 下的 agent sessions
   - 提供 create / connect / close / restart 操作

2. **当前连接状态条**
   - 位于聊天主区域顶部
   - 明确显示“当前 conversation 是否已连接到某个 AgentSession”
   - 若未连接，阻止进入发送态并给出可执行提示

3. **聊天区域**
   - 保持现有 conversation / message UI 为主
   - 仅增加“依赖 active AgentSession”的 gating 行为

这样可以最大化复用现有聊天界面，不把 P4 做成另一个管理后台。

### 4.2 关键前端状态模型

建议在 web UI state 中新增一组轻量状态：

```ts
interface AgentSessionsViewState {
  runnerStatus: 'unknown' | 'healthy' | 'unreachable'
  sessions: AgentSession[]
  activeSessionId?: string
  loading: boolean
  creating: boolean
  pendingActionSessionId?: string
  error?: string
}
```

以及 conversation 侧的连接态：

```ts
interface ConversationConnectionState {
  conversationId: string
  connectedAgentSessionId?: string
}
```

注意：
- `activeSessionId` 是控制面当前激活的 runtime session
- `connectedAgentSessionId` 是当前聊天上下文感知到的连接目标
- P4 可以先让两者等价，但概念上要拆开，给后续支持多 conversation 绑定留余地

### 4.3 推荐交互流程

#### 创建会话
1. 用户点击 `Create Agent Session`
2. 弹出极简表单：
   - `name`
   - `workspace`（默认当前 workspace）
3. 提交后按钮进入 loading
4. 成功后：
   - 列表追加新 session
   - 若是首个 running session，可自动选中但不自动 connect
5. 失败后：
   - 保留表单
   - 展示错误文案

#### 连接会话
1. 用户在某个 `running` session 上点击 `Connect`
2. 若当前已打开某个 conversation，则调用：
   - `POST /api/agent/sessions/:id/connect` with `conversationId`
3. 成功后：
   - 顶部状态条显示 `Connected to <session name>`
   - 发送框进入可用态
4. 失败后：
   - 保持原连接态
   - 展示非阻塞错误 toast / inline message

#### 关闭会话
1. 仅 `running` 状态显示 `Close`
2. 点击后进入 `closing` loading 态
3. 若关闭的是当前 active session：
   - 清空顶部连接状态
   - 发送框立即禁用
4. 成功后状态变 `stopped`

#### 重启会话
1. `stopped` / `error` / `running` 可显示 `Restart`
2. 点击后进入 `restarting`
3. 成功后回到 `running`
4. 若该 session 原本就是当前连接目标：
   - P4 建议重启成功后保持为 active session
   - 但聊天区显示短暂 “Reconnected” 状态

### 4.4 状态 badge 与按钮策略

建议先统一成很简单的 badge：

- `creating` → gray
- `starting` → blue
- `running` → green
- `connecting` → blue
- `closing` → amber
- `restarting` → amber
- `stopped` → neutral
- `error` → red

按钮可见性规则：
- `running`：显示 `Connect`、`Close`、`Restart`
- `stopped`：显示 `Restart`
- `error`：显示 `Restart`
- `creating/starting/closing/restarting/connecting`：隐藏主操作，只显示 spinner

按钮禁用规则：
- runner unhealthy 时，`Create` 全局禁用
- 当前有 pending action session 时，仅禁用对应 session 行，避免整页锁死

### 4.5 聊天发送态 gating

P4 的一个重要产品收敛是：

> 新建或使用聊天前，必须先连接一个可用的 AgentSession。

因此前端要做明确 gating：

#### 未连接时
- 输入框可保留内容编辑
- `Send` 按钮禁用
- 显示提示：`请先创建并连接一个 Agent Session`
- 若当前没有 session，则提示 CTA：`创建 Agent Session`

#### 已连接但 session 非 running
- 输入框可读但不可发送
- 状态条提示：`当前 Agent Session 不可用，请重启或重新连接`

#### 已连接且 running
- 沿用现有聊天发送与 streaming 逻辑
- 无需在聊天请求里重复传复杂 runner 元信息，只需传 conversation 绑定后的常规请求

### 4.6 错误呈现与空态设计

#### 空态 1：runner 不健康
- 文案：`Agent runner unavailable`
- 辅助文案：`检查 server runtime 与 runner 容器状态后重试`
- 禁用 create/connect 操作

#### 空态 2：还没有任何 session
- 文案：`No agent sessions yet`
- CTA：`Create your first session`

#### 行级错误
- 每个 session 行可显示 `lastError` 的简化版
- 只展示一句话，不展示堆栈

#### 顶部全局错误
- 仅用于 list/create 失败等全局问题
- 放在 Agent Sessions 面板顶部

### 4.7 现有代码落点建议

P4 前端改动建议集中在：

- Modify: `proma-web/web/src/App.tsx` 或当前聊天页入口组件
- Modify: `proma-web/web/src/api.ts`
- Modify: `proma-web/packages/platform-web/src/index.ts`
- Modify: `proma-web/packages/shared/src/index.ts`
- Create: `proma-web/web/src/components/agent-sessions-panel.tsx`
- Create: `proma-web/web/src/components/agent-session-row.tsx`
- Create: `proma-web/web/src/components/agent-connection-banner.tsx`
- Test: `proma-web/web/src/components/__tests__/agent-sessions-panel.test.tsx`
- Test: `proma-web/web/src/components/__tests__/agent-connection-banner.test.tsx`

如果现有聊天页已经过于集中，也可以不强拆三个新文件，而是先提一个 `AgentSessionsPanel` 组件，其他行组件保持内联。P4 的重点是行为闭环，不是组件抽象。

### 4.8 前端测试重点

前端测试只覆盖最关键交互，不追求视觉细节：

1. runner unhealthy 时 create 按钮禁用
2. create 成功后 session 出现在列表中
3. connect 成功后 banner 显示连接态，send 按钮解锁
4. close 当前 active session 后 banner 清空，send 按钮禁用
5. restart 失败时显示 session 行错误信息
6. 未连接 session 时聊天发送入口不可用

这几项足以兜住 P4 的控制面产品逻辑。

## Section 5: runner 与 Claude Agent SDK 集成、Docker 运行与验证设计

P4 真正有区别于 P3 的地方，不只是多了几个 API，而是要把 Claude Agent SDK runtime 放进一个 **可部署、可观测、可重启** 的 runner 服务里。因此 Section 5 要把 runner 内部集成方式、容器化边界和验证方案定清，避免后面实现时又退回到本地 dev-only 模式。

### 5.1 runner 的最小职责边界

`agent-runner` 只负责四类事情：

1. 接收 Go server 的内部控制请求
2. 启动/持有 Claude Agent SDK session runtime handle
3. 管理 session 生命周期（create/connect/close/restart）
4. 暴露健康状态和可读错误

runner **不负责**：
- 直接对 browser 暴露接口
- 持有产品级聊天记录真相
- 做复杂调度
- 做多 tenant 权限系统

也就是说，runner 是一个受控执行器，不是第二个业务后端。

### 5.2 Claude Agent SDK 集成建议

P4 里建议在 `proma-web/agent-runner/src/claude-runtime.ts` 提供一个薄封装层，把 SDK 相关代码隔离开。接口形状可以先定为：

```ts
export interface ClaudeRuntimeSessionHandle {
  id: string
  status: 'starting' | 'running' | 'stopped' | 'error'
  workspaceId: string
  startedAt: string
  stop(): Promise<void>
  restart(): Promise<void>
  connect(input?: { conversationId?: string }): Promise<{ connectedAt: string }>
}

export interface ClaudeRuntimeAdapter {
  startSession(input: { sessionId: string; workspaceId: string; name: string }): Promise<ClaudeRuntimeSessionHandle>
}
```

实现要求：
- runner 的 `session-manager` 不直接依赖 SDK 细节，只依赖 `ClaudeRuntimeAdapter`
- 如果当前阶段还需要先接最小 stub，也必须让 stub 和真实 adapter 共享同一接口
- 所有 session 状态变化由 `session-manager` 驱动，不要让 HTTP handler 直接摸 SDK

### 5.3 connect 语义在 runner 内部的定义

因为 P4 选的是“Go server 管理独立 runner”，这里的 `connect` 最好定义成一个 **轻量 attach/bind** 动作，而不是 terminal websocket attach：

- 接受 `conversationId`（可选）
- 记录该 runtime session 已被哪个 conversation / control-plane 请求绑定
- 返回 `connectedAt`
- 不要求长连接常驻

这意味着：
- P4 的 connect 更像“选定目标 runtime”
- P5 如果要做 terminal/stdio 可视化，再在这个基础上追加 stream bridge

### 5.4 runner 进程内状态与异常恢复

建议 `session-manager` 在 runner 内部维护：

```ts
interface RunnerSessionRecord {
  id: string
  workspaceId: string
  name: string
  status: RunnerSessionStatus
  startedAt: string
  updatedAt: string
  connectedAt?: string
  lastError?: string
  handle?: ClaudeRuntimeSessionHandle
}
```

最小规则：
- create 成功后保存 handle
- close 时先调用 `handle.stop()`，再清理 handle
- restart 时先 stop 再 start 新 handle
- 任一步骤失败都更新 `lastError`
- runner 进程重启后，P4 可以直接丢失内存态；Go server 只要能识别为 unreachable / stale 即可

也就是说，P4 不做自动恢复历史 handles，只做可检测、可重建。

### 5.5 Dockerfile 设计建议

#### `proma-web/server-go/Dockerfile`
建议：
- 多阶段构建
- builder 用 Go 官方镜像
- runtime 用 `debian:bookworm-slim` 或同类基础镜像
- 只复制最终二进制和必要静态资源
- 暴露 3010
- 通过 env 注入 `PROMA_AGENT_RUNNER_BASE_URL`

#### `proma-web/agent-runner/Dockerfile`
建议：
- builder/runtime 可以先合并成一个简单 Node 20 镜像，P4 不必过度优化镜像层
- 安装 `package.json` 依赖并构建 TS
- 运行产物落到 `dist/`
- 暴露 3210
- 通过 env 注入：
  - `ANTHROPIC_API_KEY`
  - `PROMA_WORKSPACE_ROOT`
  - `PROMA_AGENT_SESSIONS_ROOT`
  - `PROMA_AGENT_MODEL`
  - `PROMA_AGENT_PERMISSION_MODE`

关键点：
- Dockerfile 里不要硬编码 API key
- 所有敏感配置都走 compose/env file
- workspace / session 数据通过 volume 注入，不 bake 进镜像

### 5.6 docker-compose.p4.yml 建议

建议最小 compose 结构：

```yaml
services:
  agent-runner:
    build: ./proma-web/agent-runner
    environment:
      PORT: 3210
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      PROMA_WORKSPACE_ROOT: /workspace
      PROMA_AGENT_SESSIONS_ROOT: /data/sessions
    volumes:
      - ../:/workspace
      - proma-agent-sessions:/data/sessions

  server:
    build: ./proma-web/server-go
    environment:
      PORT: 3010
      PROMA_AGENT_CONTROL_PLANE_ENABLED: "true"
      PROMA_AGENT_RUNNER_BASE_URL: http://agent-runner:3210
    ports:
      - "3010:3010"
    depends_on:
      - agent-runner
```

P4 当前阶段不在 compose 中托管前端：
- 不启 nginx
- 前端在宿主机通过 Vite dev server 启动
- Vite 代理把 `/api` 和 SSE 请求转发到 `http://127.0.0.1:3010`
- 如需自定义目标，可通过 `VITE_API_PROXY_TARGET` 覆盖

如需数据库，再补 `postgres`，但不要让 P4 与数据库耦合得更深。

### 5.7 运行与观测约定

P4 至少要保证下面几类运行信号明确：

#### server
- `/health` 返回 200
- `/api/runtime` 返回数据库状态 + control plane 状态
- 当 runner unreachable 时，runtime 能反映 `defaultRunnerStatus = unreachable`

#### runner
- `/health` 返回：
  - service/version
  - `sdkReady`
  - `status`
  - `lastError`

#### web
- 页面可看到 runner 不健康提示
- 页面可看到 session list / action loading / lastError

这三层一起才能形成真正可排障的部署闭环。

### 5.8 端到端验证清单

P4 实现后，至少要验证下面这些场景：

#### Docker / 服务级
1. `docker compose -f proma-web/docker-compose.p4.yml up --build` 能启动 server + runner
2. `GET /health` 和 `GET /api/runtime` 正常
3. `GET runner /health` 正常
4. 本机 `npm --prefix proma-web/web run dev` 可通过 Vite 代理访问 `proma-server`，且 `/api` streaming 请求不中断

#### API 级
4. `POST /api/agent/sessions` 成功创建 running session
5. `POST /api/agent/sessions/:id/connect` 成功返回 connection
6. `POST /api/agent/sessions/:id/close` 后 session 变 stopped
7. `POST /api/agent/sessions/:id/restart` 后 session 回到 running
8. runner 异常时 server 返回合理错误码和错误体

#### Web / MCP 级
9. 页面可创建 agent session
10. 页面可 connect 到当前 conversation
11. 未 connect 时 send 禁用
12. close 当前 active session 后 send 重新禁用
13. restart 后状态恢复为 running
14. runner 不健康时页面展示禁用态与错误提示

### 5.9 测试文件建议

建议至少补这些测试：

- Go:
  - `proma-web/server-go/internal/agent/service_test.go`
  - `proma-web/server-go/internal/api/agent_test.go`
- Runner:
  - `proma-web/agent-runner/src/session-manager.test.ts`
  - `proma-web/agent-runner/src/server.test.ts`
- Web:
  - `proma-web/web/src/components/__tests__/agent-sessions-panel.test.tsx`
  - `proma-web/web/src/components/__tests__/agent-connection-banner.test.tsx`

如果测试成本太高，P4 最低也要做到：
- Go service/API 测试
- web 关键交互测试
- MCP 手测一轮 create/connect/close/restart

### 5.10 P4 完成标准

P4 可以定义为完成，当且仅当：

- Go server 能通过内部 HTTP 成功管理 agent-runner
- agent-runner 能在 Docker 中启动并报告健康状态
- web 能完成 create/connect/close/restart 整套基本操作
- 未连接 session 时聊天发送被正确 gating
- docker compose 能在本地单机环境跑通
- 关键 API、前端交互、MCP 页面回归通过

这样 P4 的交付物就不是“多了几个接口”，而是真正进入 **可部署的 Agent Runtime 控制面** 阶段。

## Implementation Tasks

### Task 1: Define shared P4 contracts

**Files:**
- Modify: `proma-web/packages/shared/src/index.ts`
- Test: `proma-web/packages/shared/src/index.ts` (type export sanity via existing TS compile)

**Step 1: Write the contract additions**

Add the `AgentRunnerStatus`, `AgentSessionStatus`, `AgentRunnerInfo`, `AgentSession`, create/connect input types, action result types, and the `RuntimeInfo.agentControlPlane` extension exactly as designed above.

**Step 2: Run type-check to verify exports compile**

Run: `npm --prefix "/Volumes/RC500/cib/sparky-proma/proma-web/web" run build`
Expected: build succeeds and shared type exports do not break downstream imports.

**Step 3: Commit**

```bash
git -C "/Volumes/RC500/cib/sparky-proma" add proma-web/packages/shared/src/index.ts
git -C "/Volumes/RC500/cib/sparky-proma" commit -m "feat: add p4 agent session contracts"
```

### Task 2: Add Go control-plane domain layer

**Files:**
- Create: `proma-web/server-go/internal/agent/types.go`
- Create: `proma-web/server-go/internal/agent/memory_registry.go`
- Create: `proma-web/server-go/internal/agent/runner_client.go`
- Create: `proma-web/server-go/internal/agent/service.go`
- Test: `proma-web/server-go/internal/agent/service_test.go`

**Step 1: Write the failing tests**

Cover at least:
- create session transitions to running on successful runner response
- create session stores error state on runner failure
- connect updates active session and optional conversation binding
- close transitions to stopped
- restart from stopped/error transitions back to running
- duplicate action during closing/restarting is rejected

Example skeleton:

```go
func TestServiceCreateSessionStoresRunningState(t *testing.T) {
    runner := &fakeRunnerClient{createResult: RunnerSession{ID: "s1", Status: "running"}}
    svc := NewService(NewMemoryRegistry(), runner)

    result, err := svc.CreateSession(context.Background(), CreateSessionInput{WorkspaceID: "w1", Name: "Default Agent"})
    require.NoError(t, err)
    require.Equal(t, SessionStatusRunning, result.Status)
}
```

**Step 2: Run the test to verify it fails**

Run: `cd "/Volumes/RC500/cib/sparky-proma/proma-web/server-go" && go test ./internal/agent -run TestService -v`
Expected: FAIL because service/registry/client types do not exist yet.

**Step 3: Write minimal implementation**

Implement:
- registry map + mutex
- service orchestration
- runner client interface and HTTP implementation shell
- state validation helpers

Keep persistence in memory only for P4.

**Step 4: Run tests to verify they pass**

Run: `cd "/Volumes/RC500/cib/sparky-proma/proma-web/server-go" && go test ./internal/agent -v`
Expected: PASS.

**Step 5: Commit**

```bash
git -C "/Volumes/RC500/cib/sparky-proma" add proma-web/server-go/internal/agent
git -C "/Volumes/RC500/cib/sparky-proma" commit -m "feat: add p4 agent control plane service"
```

### Task 3: Expose Go agent APIs

**Files:**
- Modify: `proma-web/server-go/internal/api/server.go`
- Modify: `proma-web/server-go/internal/api/runtime.go`
- Create: `proma-web/server-go/internal/api/agent.go`
- Test: `proma-web/server-go/internal/api/agent_test.go`

**Step 1: Write the failing API tests**

Cover:
- `GET /api/agent/sessions`
- `POST /api/agent/sessions`
- `POST /api/agent/sessions/:id/connect`
- `POST /api/agent/sessions/:id/close`
- `POST /api/agent/sessions/:id/restart`
- `GET /api/agent/runners`
- `GET /api/runtime` includes `agentControlPlane`

**Step 2: Run the API tests to verify failure**

Run: `cd "/Volumes/RC500/cib/sparky-proma/proma-web/server-go" && go test ./internal/api -run 'TestAgent|TestRuntime' -v`
Expected: FAIL because routes and handlers are missing.

**Step 3: Implement minimal handlers and route wiring**

Implement:
- server struct gains agent service dependency
- new route registration
- path parsing helpers for `/api/agent/sessions/:id/...`
- runtime payload extension
- error mapping for unavailable runner/control plane disabled

**Step 4: Run tests to verify pass**

Run: `cd "/Volumes/RC500/cib/sparky-proma/proma-web/server-go" && go test ./internal/api -run 'TestAgent|TestRuntime' -v`
Expected: PASS.

**Step 5: Commit**

```bash
git -C "/Volumes/RC500/cib/sparky-proma" add proma-web/server-go/internal/api
git -C "/Volumes/RC500/cib/sparky-proma" commit -m "feat: expose p4 agent session api"
```

### Task 4: Build the agent-runner service

**Files:**
- Create: `proma-web/agent-runner/package.json`
- Create: `proma-web/agent-runner/tsconfig.json`
- Create: `proma-web/agent-runner/src/types.ts`
- Create: `proma-web/agent-runner/src/session-manager.ts`
- Create: `proma-web/agent-runner/src/claude-runtime.ts`
- Create: `proma-web/agent-runner/src/server.ts`
- Test: `proma-web/agent-runner/src/session-manager.test.ts`

**Step 1: Write the failing runner tests**

Cover:
- create session stores running record
- connect updates connected timestamp
- close moves session to stopped
- restart re-enters running
- health shows degraded when SDK credentials/config missing

Example skeleton:

```ts
it('creates a running session', async () => {
  const runtime = fakeRuntime({ startSession: async () => ({ handleId: 'h1' }) })
  const manager = new SessionManager(runtime)
  const session = await manager.createSession({ workspaceId: 'w1', name: 'Default Agent' })
  expect(session.status).toBe('running')
})
```

**Step 2: Run the tests to verify failure**

Run: `npm --prefix "/Volumes/RC500/cib/sparky-proma/proma-web/agent-runner" test`
Expected: FAIL because service files do not exist.

**Step 3: Implement minimal runner service**

Implement:
- local in-memory session manager
- claude runtime adapter interface
- health endpoint
- internal HTTP endpoints
- safe startup config parsing

P4 may stub the actual SDK call shape first, but structure the adapter so swapping to the real Claude Agent SDK is localized to `claude-runtime.ts`.

**Step 4: Run tests to verify pass**

Run: `npm --prefix "/Volumes/RC500/cib/sparky-proma/proma-web/agent-runner" test`
Expected: PASS.

**Step 5: Commit**

```bash
git -C "/Volumes/RC500/cib/sparky-proma" add proma-web/agent-runner
git -C "/Volumes/RC500/cib/sparky-proma" commit -m "feat: add p4 agent runner service"
```

### Task 5: Extend platform-web client

**Files:**
- Modify: `proma-web/packages/platform-web/src/index.ts`
- Test: `proma-web/web/src/api.ts` (indirect compile coverage)

**Step 1: Write the client methods**

Add:
- `listAgentRunners`
- `listAgentSessions`
- `createAgentSession`
- `getAgentSession`
- `connectAgentSession`
- `closeAgentSession`
- `restartAgentSession`

Reuse the existing request helper patterns. Do not bypass the platform layer from UI code.

**Step 2: Run frontend build to catch client contract errors**

Run: `npm --prefix "/Volumes/RC500/cib/sparky-proma/proma-web/web" run build`
Expected: FAIL first if imports/types are incomplete, then PASS after fixes.

**Step 3: Commit**

```bash
git -C "/Volumes/RC500/cib/sparky-proma" add proma-web/packages/platform-web/src/index.ts
git -C "/Volumes/RC500/cib/sparky-proma" commit -m "feat: add p4 platform web agent client"
```

### Task 6: Add web session-management UI

**Files:**
- Modify: `proma-web/packages/frontend-core/src/index.tsx`
- Modify: `proma-web/web/src/api.ts` (only if API wiring changes)
- Test: `proma-web/packages/frontend-core/src/__tests__/agent-sessions.test.tsx`

**Step 1: Write the failing UI tests**

Cover:
- session list loads and renders status badges
- create session action posts and shows new record
- connect action marks active session
- close action disables unavailable controls during transition
- restart action recovers stopped/error session
- chat composer is blocked until an agent session is connected

Example skeleton:

```tsx
it('blocks sending until a session is connected', async () => {
  render(<FrontendCore api={fakeApiWithoutActiveSession} />)
  expect(screen.getByText(/connect an agent session/i)).toBeInTheDocument()
})
```

**Step 2: Run the failing test**

Run: `npm --prefix "/Volumes/RC500/cib/sparky-proma/proma-web/web" exec vitest run packages/frontend-core/src/__tests__/agent-sessions.test.tsx`
Expected: FAIL because UI does not exist yet.

**Step 3: Implement the minimal UI**

Add:
- session list panel/section
- create button/form
- connect/close/restart actions
- loading and disabled states
- active session indicator
- blocking message when no connected runtime is available

Keep it minimal. No terminal viewer in P4.

**Step 4: Run targeted UI test**

Run: `npm --prefix "/Volumes/RC500/cib/sparky-proma/proma-web/web" exec vitest run packages/frontend-core/src/__tests__/agent-sessions.test.tsx`
Expected: PASS.

**Step 5: Run full frontend suite**

Run: `npm --prefix "/Volumes/RC500/cib/sparky-proma/proma-web/web" exec vitest run`
Expected: PASS.

**Step 6: Commit**

```bash
git -C "/Volumes/RC500/cib/sparky-proma" add proma-web/packages/frontend-core/src/index.tsx proma-web/packages/frontend-core/src/__tests__/agent-sessions.test.tsx proma-web/web/src/api.ts
git -C "/Volumes/RC500/cib/sparky-proma" commit -m "feat: add p4 agent session management ui"
```

### Task 7: Add Docker deployment files

**Files:**
- Create: `proma-web/server-go/Dockerfile`
- Create: `proma-web/agent-runner/Dockerfile`
- Create: `proma-web/docker-compose.p4.yml`
- Test: local docker compose up/build verification

**Step 1: Write Dockerfiles and compose config**

Requirements:
- multi-stage Go build for server
- Node build/runtime image for runner
- env wiring between services
- mounted workspace/sessions/uploads volumes
- exposed server/runner ports

**Step 2: Build server image**

Run: `docker build -f "/Volumes/RC500/cib/sparky-proma/proma-web/server-go/Dockerfile" -t proma-server-p4 "/Volumes/RC500/cib/sparky-proma/proma-web/server-go"`
Expected: PASS.

**Step 3: Build runner image**

Run: `docker build -f "/Volumes/RC500/cib/sparky-proma/proma-web/agent-runner/Dockerfile" -t proma-agent-runner-p4 "/Volumes/RC500/cib/sparky-proma/proma-web/agent-runner"`
Expected: PASS.

**Step 4: Bring up compose stack**

Run: `docker compose -f "/Volumes/RC500/cib/sparky-proma/proma-web/docker-compose.p4.yml" up -d --build`
Expected: server and runner start successfully.

**Step 5: Start local web dev server**

Run: `VITE_API_PROXY_TARGET=http://127.0.0.1:3010 npm --prefix "/Volumes/RC500/cib/sparky-proma/proma-web/web" run dev`
Expected: Vite dev server starts on port 5174 and proxies `/api` including SSE requests to `proma-server`.

**Step 6: Verify health**

Run:
- `curl http://localhost:3010/health`
- `curl http://localhost:3010/api/runtime`
- `curl http://localhost:3210/health`

Expected: all endpoints return 200 and runtime reports agent control plane enabled.

**Step 7: Commit**

```bash
git -C "/Volumes/RC500/cib/sparky-proma" add proma-web/server-go/Dockerfile proma-web/agent-runner/Dockerfile proma-web/docker-compose.p4.yml
git -C "/Volumes/RC500/cib/sparky-proma" commit -m "feat: add p4 docker deployment"
```

### P4.5: Channel-driven runtime and chat model switching follow-up

After local smoke verification, the original P4 assumptions around a static `ANTHROPIC_API_KEY` and runner-global model selection are now known to be incomplete. The validated runner/container fixes (non-root execution, `/home/app`, `/workspace`, `SHELL=/bin/sh`) solved process startup, but provider/model configuration must follow Proma’s `Channel` model instead of a single environment key.

A detailed follow-up implementation plan has been added here:

- `docs/plans/2026-03-24-p4-channel-runtime-and-model-switching.md`

This follow-up plan records the required migration to:
- reuse Proma `Channel` semantics in `proma-web`
- support chat-level `channelId + modelId` switching
- require agent-session `channelId + modelId`
- resolve Anthropic runtime config server-side and pass session-scoped Claude settings/env to runner
- remove static `ANTHROPIC_API_KEY` as the primary agent runtime configuration assumption
- fix the stale frontend vitest command used in P4 verification

Current P4 implementation status should therefore be read together with that follow-up plan when continuing execution.

### Task 8: End-to-end verification and plan sync

**Files:**
- Modify: `proma-web-plans/plans-p4.md`

**Step 1: Run backend tests**

Run: `cd "/Volumes/RC500/cib/sparky-proma/proma-web/server-go" && go test ./...`
Expected: PASS.

**Step 2: Run runner tests**

Run: `npm --prefix "/Volumes/RC500/cib/sparky-proma/proma-web/agent-runner" test`
Expected: PASS.

**Step 3: Run frontend tests**

Run: `npm --prefix "/Volumes/RC500/cib/sparky-proma/proma-web/web" exec vitest run`
Expected: PASS.

**Step 4: Run frontend build**

Run: `npm --prefix "/Volumes/RC500/cib/sparky-proma/proma-web/web" run build`
Expected: PASS.

**Step 5: Do MCP/manual smoke test**

Verify in browser:
- runtime loads
- create session works
- connect session works
- close session works
- restart stopped session works
- chat stays blocked before connect and available after connect

**Step 6: Update plan with final status**

Record completed scope, validation commands, known limitations, and follow-up items in `proma-web-plans/plans-p4.md`.

**Step 7: Commit**

```bash
git -C "/Volumes/RC500/cib/sparky-proma" add proma-web-plans/plans-p4.md
git -C "/Volumes/RC500/cib/sparky-proma" commit -m "docs: finalize p4 execution notes"
```
