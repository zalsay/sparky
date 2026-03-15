# 项目详情页 Web 转发（方案 A）— Design

**Date:** 2026-03-15

## 目标
在公网 Server 上提供“项目详情”纯 Web 访问能力（左 IDE / code-server + 右终端管理），**复用现有 React UI**，数据来自桌面端本地 DB/文件。Web 端支持**运行指令/任务**与**会话/历史管理**，并使用 **WebSocket/SSE** 实时同步。鉴权采用 **Token/API Key**。

## 背景与现状
- 项目详情 UI 目前在桌面端 Tauri WebView 中实现（`ui/src/App.tsx` 的 `project-detail` 区域）。
- 数据层通过 `invoke(...)` 调用本地能力。
- 需要在 server 侧提供同一套 UI 与数据服务，且**不暴露本地端口**（公网 server）。

## 方案选择（已定）
**方案 A：API/状态镜像 + Agent 隧道（推荐）**
- 桌面端运行 Agent，向公网 Server 建立**出站 WebSocket 隧道**。
- Server 作为 Web API 网关 + UI 承载，提供 REST + WS/SSE。
- 前端复用现有 UI，数据源从 `invoke` 改为 HTTP/WS。

## 范围与非目标
**范围：**
- 纯 Web 项目详情页（IDE + 终端管理）
- Token 登录鉴权
- Web 端读写（运行命令、会话管理）
- 实时同步（WS/SSE）

**非目标：**
- SSO/企业账号接入
- 公网匿名访问
- 像素流/远程渲染
- 多租户复杂权限模型

## 架构概览
**组件**
1) **Web UI（复用 React）**：项目详情页面同源渲染；替换数据适配层。
2) **公网 Server**：提供 REST + WS/SSE；Token 鉴权、权限校验、审计。
3) **桌面端 Agent**：出站隧道连接 Server；访问本地 DB/文件、终端与会话。
4) **本地数据/执行层**：项目数据库、会话记录、终端执行、code-server。

**数据流（高层）**
Web UI → Server（鉴权）→ Agent（隧道）→ 本地执行/数据 → Server 推送 → Web UI

## 接口边界与职责
**Server**
- 鉴权与权限校验
- API 聚合与审计
- 维护 Agent 连接与路由

**Agent**
- 本地数据读取（限定项目路径）
- 终端执行与会话管理
- 本地 code-server 访问代理

**Web UI**
- 复用现有项目详情组件
- 统一数据适配层（REST + WS/SSE）

## API 与事件模型（草案）
**REST（读）**
- `GET /api/projects`
- `GET /api/projects/:id/detail`
- `GET /api/sessions?project_id=...`
- `GET /api/terminal/history?project_id=...`

**REST（写/执行）**
- `POST /api/terminal/exec`
- `POST /api/sessions/:id/rename`
- `POST /api/sessions/:id/delete`
- `POST /api/sessions/:id/resume`

**WS/SSE 事件**
- `project_status_changed`
- `terminal_output_chunk`
- `session_updated`
- `ide_status`

> Server 统一转发 Agent 推送事件；Web UI 只订阅授权项目。

## IDE / code-server 代理
- Web 端 IDE iframe 指向 Server 的代理入口，例如：
  - `/ide/{agent_id}/{project_id}/`
- Server 通过隧道将请求转发至 Agent，Agent 访问本地 code-server。
- Server 在代理层做鉴权校验与请求头加固（防跨域/点击劫持）。

## 实时同步策略
- 默认使用 WS/SSE 推送终端输出与会话变化。
- 重要状态变化后，前端可触发 `GET /api/projects/:id/detail` 进行兜底校正。

## 安全与权限控制
- Token 绑定 `agent_id` + 项目列表。
- Server 记录所有写操作与执行结果（审计日志）。
- Agent 仅访问授权项目路径，命令执行统一入口可控。
- 隧道仅出站连接，无需暴露本地端口。

## 错误处理
- **Agent 断线**：Server 返回 `AGENT_OFFLINE`，Web UI 提示不可操作。
- **执行超时**：返回 `AGENT_TIMEOUT`，可重试。
- **权限不足**：返回 `403`，并记录审计。

## 最小测试计划
1) Token 校验：无 Token → 401；合法 Token → 正常访问。
2) 隧道在线：项目详情可获取；断线提示不可执行。
3) IDE 代理：iframe 能加载 code-server。
4) 终端执行：Web 端下发命令并回传结果。
5) 会话管理：列表/重命名/删除/恢复可用。
6) 实时同步：终端输出与会话状态变化实时推送。

## 实施建议（高层）
- 抽象前端数据层：将 `invoke(...)` 替换为 `apiClient`。
- 设计 Agent ↔ Server 协议（request/response + event）。
- 实现 Server 鉴权与路由，接入 WS/SSE。
- 补充审计与最小权限策略。
