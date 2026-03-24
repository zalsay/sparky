# Proma Web P3 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 P2 已完成最小高级 chat 能力后，继续把 Proma Web 从“最小闭环”推进到“可用产品级体验”，优先补齐真实附件链路、流式语义收敛、tool/divider 交互完善，以及前端回归测试。

**Architecture:** 继续沿用 `PlatformClient -> frontend-core -> platform-web -> Go server` 分层，所有新能力先收敛到共享契约，再分别落到 web client、frontend-core 和 Go server。P3 不回退到 Electron 直连，也不一次性追平 upstream 全量行为；重点是把 P2 中仍是占位/最小展示的能力升级成真实可用、可测试、可维护的实现。

**Tech Stack:** React、TypeScript、Vite、Go、SSE、platform-contract、platform-web、frontend-core、MemoryStore、PostgresStore

---

## 范围与边界

### 本阶段目标
- 将附件从“消息元数据闭环”升级为“真实上传 + 持久化引用 + 前端发送前状态”
- 将 streaming 从“占位 assistant 流式回复”升级为“更接近真实语义的 server-side streaming 状态流”
- 将 tool / divider 从“最小展示”升级为“明确交互边界 + 前端渲染收敛”
- 为 `frontend-core` 增加最小回归测试，避免后续 UI 逻辑继续只靠手动验证
- 补齐 P3 的验证和已知限制记录

### 非目标
- 不在 P3 直接实现完整 Claude runtime / tool 执行引擎
- 不在 P3 引入 Electron 专属上传或本地文件直连
- 不做大规模 UI 重构，不把 `proma-web/web` 从薄壳扩成厚前端
- 不为了未来假设场景提前设计对象存储、权限系统、多租户隔离

---

## 已知 P2 基线（实现者必须先理解）

1. `packages/shared/src/index.ts` 已定义：
   - `Attachment` / `AttachmentInput`
   - `ToolInvocation` / `ToolResult`
   - `ContextDivider`
   - `StreamingEvent` / `StreamMessageHandlers`
2. `packages/platform-contract/src/index.ts` 已暴露：
   - `streamMessage(...)`
   - `updateContextDivider(...)`
3. `packages/platform-web/src/index.ts` 已有：
   - SSE 解析器 `streamRequest(...)`
   - 普通 chat REST 调用
4. `packages/frontend-core/src/index.tsx` 当前仍是单文件核心 UI：
   - 已能展示 streaming / attachment / tool / divider
   - 但附件仍是本地 pending 元数据
   - streaming 仍依赖后端占位内容
5. `proma-web/server-go/internal/api/chat.go` 当前：
   - `/messages/stream` 返回 SSE `start/delta/done/error`
   - 非流式消息、重发、truncate、divider 更新都已可用
   - 附件只做 metadata normalize，没有真实 upload endpoint
6. store 层当前 `BuildStreamingReply(...)` 仍是最小占位语义，P3 要先决定是否继续保留“伪流式”还是收敛成更稳定的真实语义。

---

## 分阶段实施任务

### Task 1: 盘点 P2 剩余缺口并写入 P3 边界

**Files:**
- Create: `proma-web-plans/plans-p3.md`
- Modify: `proma-web-plans/plans-p2.md`
- Read: `packages/shared/src/index.ts:86-206`
- Read: `packages/platform-contract/src/index.ts:24-46`
- Read: `packages/platform-web/src/index.ts:109-234`
- Read: `packages/frontend-core/src/index.tsx:136-828`
- Read: `proma-web/server-go/internal/api/chat.go:36-317`
- Read: `proma-web/server-go/internal/store/types.go:69-124`

**Step 1: 写出 P2 剩余能力清单**

```md
- streaming 仍是占位 assistant 回复，不是真实 runtime 输出
- attachment 仅有 metadata，没有 upload API / 存储策略 / 引用持久化约束
- tool_result 仅能展示历史结果，没有明确的消息块渲染规范
- context_divider 仅支持最小文本更新，没有更明确的编辑边界
- frontend-core 缺少自动化测试，当前主要靠 build + 手测
```

**Step 2: 运行只读核对，确认现状**

Run: `git -C "/Volumes/RC500/cib/sparky-proma" diff --stat HEAD~1..HEAD`
Expected: 能看到 P2 最后一批改动范围，用于确认 P3 不是重复做 P2

**Step 3: 在 P3 计划文件写清边界**

```md
## P3 Scope Decisions
- 先做真实 upload，文件落本地目录即可，不先接对象存储
- streaming 仍可保留 mock 内容来源，但事件语义必须稳定
- tool 不做执行引擎，只做结构化渲染与排序/状态收敛
- divider 只增强已有编辑体验，不扩成完整 prompt 管理器
```

## P3 Scope Decisions
- 先做真实 upload，文件落本地目录即可，不先接对象存储
- streaming 仍可保留 mock 内容来源，但 `start/delta/done/error` 事件语义必须稳定，前端必须能正确清理 loading / streamingMessageId
- tool 不做执行引擎，只做结构化渲染、状态文案与展示顺序收敛
- divider 只增强已有编辑体验，不扩成完整 prompt 管理器
- `frontend-core` 本阶段至少建立 vitest + jsdom 最小回归基线，优先覆盖 streaming 状态机

---

### Task 2: 设计并实现真实附件上传最小链路

**Files:**
- Modify: `packages/shared/src/index.ts:90-105`
- Modify: `packages/platform-contract/src/index.ts:24-46`
- Modify: `packages/platform-web/src/index.ts:1-234`
- Modify: `packages/frontend-core/src/index.tsx:136-154,467-527,791-827`
- Modify: `proma-web/server-go/internal/api/chat.go:14-41,130-295`
- Modify: `proma-web/server-go/internal/api/server.go:24-40`
- Modify: `proma-web/server-go/internal/store/types.go:40-47,83-123`
- Modify: `proma-web/server-go/internal/store/memory.go`
- Modify: `proma-web/server-go/internal/store/postgres.go`
- Test: `proma-web/server-go/internal/api/chat_test.go`
- Test: `proma-web/server-go/internal/store/memory_test.go`
- Test: `proma-web/server-go/internal/store/postgres_test.go`

**Step 1: 先写失败测试，定义 upload endpoint 行为**

```go
func TestUploadAttachmentEndpoint(t *testing.T) {
    // multipart/form-data 上传一个小文件
    // 期望返回 attachment JSON，包含 id/name/mimeType/size/url/status=ready
}
```

**Step 2: 跑单测确认失败**

Run: `cd "/Volumes/RC500/cib/sparky-proma/proma-web/server-go" && go test ./internal/api -run UploadAttachment -v`
Expected: FAIL，提示路由或处理器不存在

**Step 3: 在共享契约里补齐上传结果模型**

```ts
export interface UploadedAttachment extends Attachment {
  url: string
  status: 'ready'
}
```

并为 `PlatformClient` 新增：

```ts
uploadAttachment(file: File): Promise<UploadedAttachment>
```

**Step 4: 实现 web client multipart 上传**

```ts
const form = new FormData()
form.append('file', file)
return fetch('/api/chat/attachments', { method: 'POST', body: form })
```

**Step 5: 实现 Go server upload endpoint**

```go
// POST /api/chat/attachments
// ParseMultipartForm
// 文件写入本地 uploads 目录
// 返回 attachment 元数据和可访问 url
```

要求：
- 文件大小加最小边界校验（例如 10MB）
- 文件名走安全 basename，避免路径穿越
- MIME type 缺失时给默认值

**Step 6: 前端把 pending attachment 改成真实上传状态**

```ts
// 选中文件后：先显示 pending，再 await client.uploadAttachment(file)，成功后替换为 ready
// 失败则显示 error，并允许移除
```

**Step 7: 让 sendMessage / streamMessage 使用 upload 后的 attachment 引用**

Run: `npm --prefix "/Volumes/RC500/cib/sparky-proma/proma-web/web" run build`
Expected: PASS

**Step 8: 跑 Go 测试确保 API/store 都通过**

Run: `cd "/Volumes/RC500/cib/sparky-proma/proma-web/server-go" && go test ./...`
Expected: PASS

---

### Task 3: 收敛 streaming 语义并补前后端回归

**Files:**
- Modify: `packages/shared/src/index.ts:141-157`
- Modify: `packages/platform-web/src/index.ts:114-174`
- Modify: `packages/frontend-core/src/index.tsx:156-180,480-537,731-789`
- Modify: `proma-web/server-go/internal/api/chat.go:232-280`
- Modify: `proma-web/server-go/internal/store/types.go:95-123`
- Modify: `proma-web/server-go/internal/store/memory.go:292-...`
- Modify: `proma-web/server-go/internal/store/postgres.go:409-...`
- Test: `proma-web/server-go/internal/api/chat_test.go:123-157`
- Test: `packages/frontend-core/src/__tests__/streaming.test.tsx`

**Step 1: 先写 frontend-core streaming 测试**

```ts
it('applies start -> delta -> done in order', () => {
  // 验证消息从 loading 到 partial 到 done
})
```

**Step 2: 跑测试确认失败**

Run: `npm --prefix "/Volumes/RC500/cib/sparky-proma/proma-web/web" exec vitest run packages/frontend-core/src/__tests__/streaming.test.tsx`
Expected: FAIL，说明测试基线已建立

**Step 3: 收敛共享事件语义**

要求：
- 明确 `start` 一定带 message
- `delta` 只增量追加内容
- `done` 一定带最终 message
- `error` 终止 streaming，并能被前端稳定落态

必要时把类型改成更严格的联合：

```ts
type StreamingEvent =
  | { type: 'start'; conversationId: string; message: ChatMessage }
  | { type: 'delta'; conversationId: string; delta: StreamingMessageDelta }
  | { type: 'done'; conversationId: string; message: ChatMessage }
  | { type: 'error'; conversationId: string; error: string }
```

**Step 4: 修正 frontend-core 状态收敛**

重点检查：
- `handleStreamingEvent(...)` 遇到 `error` 时不要残留 loading
- `streamingMessageId` 在 `done/error` 后清空
- refresh 后消息不要重复插入

**Step 5: 补 server 侧流式边界测试**

```go
func TestChatStreamEndpoint_EventOrderAndFinalMessage(t *testing.T) {
    // start -> delta -> done 顺序固定
    // done 中 final message 内容完整
}
```

**Step 6: 运行前端测试 + build + Go 测试**

Run: `npm --prefix "/Volumes/RC500/cib/sparky-proma/proma-web/web" exec vitest run`
Expected: PASS

Run: `npm --prefix "/Volumes/RC500/cib/sparky-proma/proma-web/web" run build`
Expected: PASS

Run: `cd "/Volumes/RC500/cib/sparky-proma/proma-web/server-go" && go test ./...`
Expected: PASS

---

### Task 4: 收敛 tool / divider 渲染与编辑边界

**Status:** Completed

**Files:**
- Modify: `packages/shared/src/index.ts:107-125,127-139`
- Modify: `packages/frontend-core/src/index.tsx:540-786`
- Modify: `proma-web/server-go/internal/api/chat.go:55-58,212-224`
- Modify: `proma-web/server-go/internal/store/memory.go:271-...`
- Modify: `proma-web/server-go/internal/store/postgres.go:386-...`
- Test: `packages/frontend-core/src/__tests__/message-rendering.test.tsx`
- Test: `proma-web/server-go/internal/store/memory_test.go:126-190`
- Test: `proma-web/server-go/internal/store/postgres_test.go:136-254`

**Step 1: 先写消息渲染测试**

```ts
it('renders tool result block with status and output', () => {})
it('renders context divider block and supports edit save', () => {})
```

**Step 2: 跑测试确认失败**

Run: `npm --prefix "/Volumes/RC500/cib/sparky-proma/proma-web/web" exec vitest run packages/frontend-core/src/__tests__/message-rendering.test.tsx`
Expected: FAIL

**Step 3: 收敛 tool result 渲染规则**

要求：
- 优先显示 `toolResult.name`
- 明确显示 success/error 状态
- `message.content` 仅作 fallback，不与 `toolResult.output` 重复冲突

**Step 4: 收敛 divider 编辑边界**

要求：
- divider 只编辑 content，title 采用当前值或默认值
- 保存后前端局部更新，不强制整页刷新
- 编辑取消时恢复原值

**Step 5: 更新 store/API 测试**

```go
// MemoryStore / PostgresStore
// 验证 UpdateContextDivider 后 title/content 持久化正确
```

**Step 6: 跑前端测试与 Go 测试**

Run: `npm --prefix "/Volumes/RC500/cib/sparky-proma/proma-web/web" exec vitest run`
Expected: PASS

Run: `cd "/Volumes/RC500/cib/sparky-proma/proma-web/server-go" && go test ./...`
Expected: PASS

---

### Task 5: 为 frontend-core 建立最小测试基线并完成 P3 收尾

**Status:** Completed

**Files:**
- Modify: `packages/frontend-core/src/index.tsx`
- Create: `packages/frontend-core/src/__tests__/bootstrap.test.tsx`
- Modify: `proma-web/web/package.json`
- Modify: `proma-web/web/vite.config.*` 或 `vitest.config.*`
- Modify: `proma-web-plans/plans-p3.md`

**Step 1: 先写 bootstrap/交互测试**

```ts
it('loads bootstrap data and renders first conversation', async () => {})
it('creates conversation and selects it', async () => {})
```

**Step 2: 跑测试确认失败**

Run: `npm --prefix "/Volumes/RC500/cib/sparky-proma/proma-web/web" exec vitest run packages/frontend-core/src/__tests__/bootstrap.test.tsx`
Expected: FAIL

**Step 3: 补齐最小测试运行环境**

必要时添加：

```ts
// vitest config
environment: 'jsdom'
setupFiles: ['./test/setup.ts']
```

只加当前测试必需依赖，不做额外测试框架重构。

**Step 4: 修复测试暴露的问题**

重点关注：
- bootstrap 完成后 active conversation 与 message 加载是否一致
- create / select / refresh 是否有竞态
- message 列表刷新是否重复

**Step 5: 跑完整验证**

Run: `npm --prefix "/Volumes/RC500/cib/sparky-proma/proma-web/web" exec vitest run`
Expected: PASS

Run: `npm --prefix "/Volumes/RC500/cib/sparky-proma/proma-web/web" run build`
Expected: PASS

Run: `cd "/Volumes/RC500/cib/sparky-proma/proma-web/server-go" && go test ./...`
Expected: PASS

**Step 6: 更新计划文件中的完成状态、限制与验证结果**

```md
## Validation
- vitest: PASS
- web build: PASS
- go test ./...: PASS

## Known Limits
- upload 当前使用本地磁盘存储
- streaming 仍未接真实 Claude runtime，仅保证事件语义稳定
- tool 仍不负责执行，只负责结构化展示
```

---

## Validation
- vitest: PASS
- web build: PASS
- go test ./...: PASS

## Known Limits
- upload 当前使用本地磁盘存储（`./uploads`）
- streaming 仍未接真实 Claude runtime，仅保证事件语义稳定
- tool 仍不负责执行，只负责结构化展示
- vitest 仍有 React `act(...)` warning，属于测试写法收口问题，不影响当前功能验证

---

## 最终完成定义

- `PlatformClient` 具备真实附件上传能力，不再只是本地 metadata 占位
- `frontend-core` 对 streaming / attachment / tool / divider 的行为有自动化测试覆盖
- Go server 的 attachment / stream / divider 行为有对应测试保护
- `proma-web/web` build 通过，`proma-web/server-go` 全量测试通过
- `proma-web-plans/plans-p3.md` 完整记录范围、验证、限制与后续建议

## 执行顺序建议

1. 先做 Task 1，固定范围，避免边做边扩
2. 再做 Task 2，优先把真实 upload 打通
3. 再做 Task 3，收敛流式事件语义
4. 再做 Task 4，收敛 tool/divider 交互
5. 最后做 Task 5，补前端测试基线并整体收尾

## 后续建议（不属于本次实现）

- P4 可考虑把 streaming 接到真实 Claude runtime / agent backend
- P4 可考虑附件清理策略、静态文件服务鉴权、对象存储替换
- P4 可考虑将 `packages/frontend-core/src/index.tsx` 拆成更可测的 hooks + presentational components
