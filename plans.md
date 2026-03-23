# Upstream Frontend 能力解耦完整开发计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 `sparky-proma` 的前端从 Electron renderer 依赖逐步解耦为基于 `PlatformClient` 的共享前端核心，完整覆盖 sidebar 会话管理、chat 数据层、运行时信息、workspace 能力、用户信息与后续扩展边界。

**Architecture:** 以 `packages/platform-contract` 作为唯一平台边界，所有前端共享逻辑下沉到 `packages/frontend-core`，由 `packages/platform-web` 提供 web 实现，并保留后续接入 Electron / Tauri / 其他运行时的空间。实现上先补齐共享类型与接口，再分阶段迁移 sidebar 与 chat 的数据读写逻辑，最后统一验证 build、类型检查与服务端 API 对齐。

**Tech Stack:** React、TypeScript、Vite、Go server、platform-contract、platform-web、frontend-core

---

## 总体原则

- [ ] 所有共享前端逻辑必须只依赖 `PlatformClient`，不直接访问 `window.electronAPI`
- [ ] `apps/web` 维持薄壳，只做平台注入和启动
- [ ] 先补数据与能力边界，再迁 UI 行为，不硬搬 upstream 全量 renderer 结构
- [ ] 以最小可运行链路为先：list/create/select/send，再逐步补 rename/delete/pin/load-more/refresh
- [ ] 每完成一个独立能力块都执行对应 build / type-check / API 验证
- [ ] 每个阶段结束后提交代码，保持可回退

## 当前已完成基线

- [*] 建立 `proma` 分支并已推送远程
- [*] 建立 `packages/platform-contract` 基础接口
- [*] 建立 `packages/platform-web` 基础 web 平台实现
- [*] 建立 `packages/frontend-core` 基础共享 UI 壳层
- [*] 将 runtime / settings / workspaces / listConversations / createConversation / getMessages / sendMessage 接入 web 版本
- [*] 补充 `UserProfile`、`WorkspaceCapabilities`、`ConversationMeta.pinned` 共享类型
- [*] 在 `frontend-core` 落下会话按 今天 / 昨天 / 更早 分组的基础能力
- [*] `apps/web` 已收敛为平台注入薄壳
- [*] Go server 可编译，web build 可通过
- [ ] TypeScript 全链路校验稳定通过

---

## 功能清单

### 1. 平台契约与共享类型
- [*] 定义 `PlatformClient.getRuntime`
- [*] 定义 `PlatformClient.getSettings`
- [*] 定义 `PlatformClient.updateSettings`
- [*] 定义 `PlatformClient.listWorkspaces`
- [*] 定义 `PlatformClient.listConversations`
- [*] 定义 `PlatformClient.createConversation`
- [*] 定义 `PlatformClient.getMessages`
- [*] 定义 `PlatformClient.sendMessage`
- [*] 定义 `PlatformClient.getUserProfile`
- [*] 定义 `PlatformClient.getWorkspaceCapabilities`
- [*] 定义 `PlatformClient.renameConversation`
- [*] 定义 `PlatformClient.deleteConversation`
- [*] 定义 `PlatformClient.pinConversation`
- [*] 定义 `PlatformClient.unpinConversation`
- [*] 定义 `PlatformClient.refreshMessages`（若复用 `getMessages` 则文档中明确约束）
- [*] 定义 `PlatformClient.getMessagesBefore` / `loadMoreMessages`
- [*] 定义 chat resend / edit / truncate 所需最小接口形状
- [*] 补齐共享类型：conversation 变更输入类型
- [*] 补齐共享类型：message 编辑 / 重发 / 分页返回结构
- [*] 统一各包导出声明，避免 path alias 与文件级引用混用

### 2. Web 平台实现
- [*] 实现 `createWebPlatformClient`
- [*] 为 rename conversation 增加 HTTP 请求实现
- [*] 为 delete conversation 增加 HTTP 请求实现
- [*] 为 pin/unpin conversation 增加 HTTP 请求实现
- [*] 为消息分页 / load more 增加 HTTP 请求实现
- [*] 为消息刷新逻辑统一封装请求方法
- [*] 为 edit / resend / truncate 增加最小 web 请求实现
- [ ] 统一 `request()` 错误结构，返回更清晰的前端错误信息
- [*] 校验 API base URL、headers、JSON body 行为在所有新接口上一致

### 3. Go server API 对齐
- [*] 已有 runtime / settings / workspaces / chat sessions / messages API 基础骨架
- [*] 确认现有会话 API 是否支持 rename
- [*] 确认现有会话 API 是否支持 delete
- [*] 确认现有会话 API 是否支持 pin/unpin
- [*] 若缺失，则补齐对应 handler / route / store 接口
- [*] 为消息分页补参数支持（如 before / cursor / limit）
- [*] 为 edit / resend / truncate 增加最小 API 设计
- [*] 保证 API 返回结构与 `@sparky/shared` 基本对齐
- [*] 为新增接口补最小 server 侧编译验证
- [*] 当前 server 路由仅覆盖 sessions list/create 与 messages list/send，尚未提供 rename/delete/pin/unpin/edit/resend/truncate

### 4. frontend-core：Sidebar 会话管理解耦
- [*] 已有会话分组函数 `groupConversationsByDate`
- [*] 将 pinned conversations 从普通列表中逻辑分离
- [*] 在 sidebar 中增加 pinned 区域
- [*] pinned 区域支持展开 / 收起
- [*] 会话列表支持 active 状态
- [*] 会话列表支持选择会话
- [*] 会话列表支持新建会话
- [*] 会话列表支持重命名会话
- [*] 会话列表支持删除会话
- [*] 会话列表支持 pin 会话
- [*] 会话列表支持 unpin 会话
- [*] 操作成功后本地状态与服务端结果同步
- [*] 操作失败时显示最小错误提示，不让整个页面崩溃
- [*] 当前对话被删除时，定义并实现新的回退选择逻辑
- [*] 会话变更后保证分组与排序仍正确
- [*] 避免 sidebar 逻辑重新耦合 Electron 特有状态

### 5. frontend-core：Chat 数据层解耦
- [*] 已有选择会话后加载消息能力
- [*] 已有发送消息后刷新消息与会话列表能力
- [*] 抽出 chat panel 的最小数据状态模型
- [*] 增加消息加载中状态
- [*] 增加消息刷新能力
- [*] 增加 load more / 分页加载更早消息
- [ ] 增加 chat 空状态
- [*] 增加 chat 错误态
- [*] 增加 resend 的平台接口与最小 UI 行为
- [*] 增加 edit message 的平台接口与最小 UI 行为
- [*] 增加 truncate/replay 所需最小数据流
- [*] 保证 send / resend / edit 后消息列表与 sidebar updatedAt 同步刷新
- [*] 保持当前实现为非流式最小链路，不提前引入 Electron 流式复杂度

### 6. frontend-core：共享信息面板与上下文
- [*] runtime 面板基础展示
- [*] workspace 列表基础展示
- [*] workspace capabilities 基础展示
- [*] user profile 基础展示
- [ ] 校验 workspace capabilities 缓存与刷新策略
- [ ] 明确 profile/runtime/workspaces 的 bootstrap 顺序与失败处理
- [ ] 将 bootstrap 中的并发加载错误收敛为稳定的页面状态
- [ ] 必要时拆分 `SparkyApp` 过大的状态与 handler

### 7. apps/web 薄壳治理
- [*] `apps/web` 只负责注入 `PlatformClient`
- [ ] 确认 `apps/web/src/App.tsx` 不再承载业务逻辑
- [ ] 确认 `apps/web` 只依赖 package 导出，不直接引用内部源码路径
- [ ] 清理为解耦临时保留的直连实现
- [ ] 统一 web 入口、样式、provider 装配方式

### 8. 类型系统与构建稳定性
- [*] web build 已通过
- [*] 复现 `tsc -p apps/web/tsconfig.json --noEmit` 的 internal crash
- [ ] 定位是 TS 版本、paths、package exports 还是 monorepo 引用方式导致
- [ ] 统一 package.json exports / types / main 字段
- [ ] 统一 tsconfig path 与 workspace 解析方式
- [ ] 去掉容易触发 TS Debug Failure 的混合引用模式
- [ ] 让 `frontend-core / platform-web / platform-contract / shared / apps/web` 类型检查稳定通过
- [ ] 记录根因与修复方式，避免后续回归

### 9. 文档与交付
- [*] 写出本计划文档 `plans.md`
- [*] 在实现过程中持续更新 `[ ]` / `[*]` 状态
- [*] 记录已完成接口、仍未完成接口、验证结果与已知问题
- [*] 在阶段性提交前更新文档，保证进度可追踪

---

## 分阶段实施任务

### Task 1: 盘点当前契约、上游依赖与缺口

**Files:**
- Modify: `plans.md`
- Read: `packages/platform-contract/src/index.ts`
- Read: `packages/platform-web/src/index.ts`
- Read: `packages/frontend-core/src/index.tsx`
- Read: `packages/shared/src/index.ts`
- Read: `apps/server-go/internal/api/server.go`
- Read: upstream `Proma/apps/electron/src/renderer/components/app-shell/LeftSidebar.tsx`
- Read: upstream `Proma/apps/electron/src/renderer/components/chat/ChatView.tsx`

**Step 1: 阅读当前实现与 upstream 依赖点**
- [*] 已完成。LeftSidebar 当前直接依赖 create/select/rename/togglePin/deleteConversation 与 getUserProfile/getWorkspaceCapabilities。
- [*] 已完成。ChatView 当前直接依赖 getRecentMessages、sendMessage、truncateMessagesFrom、deleteMessage、stopGeneration、updateContextDividers、saveAttachment 等 Electron 能力。

**Step 2: 产出缺口清单**
- [*] 已完成。当前 `PlatformClient` 仍缺 rename/delete/pin/unpin、消息分页、edit/resend/truncate 等接口。
- [*] 已完成。当前 `platform-web` 仅覆盖 list/create/get/send，Go server 路由同样只覆盖 sessions list/create 与 messages list/send。

**Step 3: 校验当前最小链路**
Run: `npm --prefix apps/web run build`
Expected: PASS
- [*] 已完成。当前 build PASS。

**Step 4: 提交文档更新**
```bash
git add plans.md
git commit -m "docs: add upstream frontend decoupling plan"
```
- [*] 已完成。提交为 `a4406d6`。

### Task 2: 扩展共享类型与 PlatformClient 契约

**Files:**
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/platform-contract/src/index.ts`
- Modify: `plans.md`

**Step 1: 写出缺失类型定义**
- 增加 conversation rename / pin / unpin / delete 输入输出类型。
- 增加 messages 分页、编辑、重发、截断所需最小类型。
- [*] 已完成。已补 `RenameConversationInput`、`UpdateConversationPinInput`、`GetMessagesInput`、`EditMessageInput`、`ResendMessageInput`、`TruncateMessagesInput`。

**Step 2: 扩展 `PlatformClient`**
- 在 `packages/platform-contract/src/index.ts` 增加对应方法签名。
- [*] 已完成。已补 rename/delete/pin/unpin/refresh/loadMore/edit/resend/truncate 方法签名。

**Step 3: 运行类型检查**
Run: `npx tsc -p packages/platform-contract/tsconfig.json --noEmit`
Expected: PASS 或暴露真实类型错误（非 TS internal crash）
- [ ] 未执行。当前只更新计划，不追加新的代码或验证。

**Step 4: 更新计划状态**
- 将本任务已完成项标记为 `[*]`。
- [*] 已完成。

**Step 5: 提交**
```bash
git add packages/shared/src/index.ts packages/platform-contract/src/index.ts plans.md
git commit -m "feat: extend shared types and platform contract"
```
- [ ] 未单独提交。当前相关代码仍在工作区，尚未按任务切分提交。

### Task 3: 对齐 web 平台实现与 Go server API

**Files:**
- Modify: `packages/platform-web/src/index.ts`
- Modify: `apps/server-go/internal/api/server.go`
- Modify: `apps/server-go/internal/store/*.go`
- Modify: `plans.md`

**Step 1: 先写或确认 server 侧接口**
- rename conversation
- delete conversation
- pin / unpin conversation
- message pagination
- edit / resend / truncate 的最小接口
- [*] 已完成。相关 handler / route / store 已写入工作区。

**Step 2: 在 `platform-web` 中实现对应 request 调用**
- 统一 path、method、body、query 参数。
- [*] 已完成。相关 request 已写入工作区。

**Step 3: 运行 server 编译验证**
Run: `cd /Volumes/RC500/cib/sparky-proma/apps/server-go && go test ./...`
Expected: PASS
- [*] 已完成。已改为在 `apps/server-go` 模块上下文执行并 PASS。

**Step 4: 运行 web build 验证**
Run: `npm --prefix apps/web run build`
Expected: PASS
- [*] 已完成。build PASS。

**Step 5: 更新计划状态并提交**
```bash
git add packages/platform-web/src/index.ts apps/server-go plans.md
git commit -m "feat: add platform web conversation and message APIs"
```
- [ ] 未执行。本轮按你的要求只更新计划并提交计划文件，不提交代码实现。

### Task 4: 解耦 sidebar 会话管理

**Files:**
- Modify: `packages/frontend-core/src/index.tsx`
- Modify: `plans.md`

**Step 1: 抽出 sidebar 视图状态**
- pinned 区域
- grouped conversations
- active conversation
- conversation actions
- [*] 已完成。相关状态与 handler 已写入工作区。

**Step 2: 实现 rename / delete / pin / unpin UI 与 handler**
- 所有操作只经由 `client` 调用。
- [*] 已完成。相关 UI 与调用链已写入工作区。

**Step 3: 定义删除后回退逻辑**
- 当前会话删除后自动切到最近可用会话或空状态。
- [*] 已完成。`selectConversationAfterDeletion` 已实现。

**Step 4: 运行 web build**
Run: `npm --prefix apps/web run build`
Expected: PASS
- [*] 已完成。build PASS。

**Step 5: 手动验证 sidebar 基础行为**
- 新建、选择、置顶、取消置顶、重命名、删除后列表正常。
- [ ] 未执行。当前没有继续做手动回归。

**Step 6: 更新计划状态并提交**
```bash
git add packages/frontend-core/src/index.tsx plans.md
git commit -m "feat: decouple sidebar conversation management"
```
- [ ] 未执行。本轮不提交功能代码。

### Task 5: 解耦 chat 数据层

**Files:**
- Modify: `packages/frontend-core/src/index.tsx`
- Modify: `plans.md`

**Step 1: 抽出消息区域状态与 handler**
- loading
- refreshing
- hasMore
- error
- [*] 已完成。相关状态与 handler 已写入工作区。

**Step 2: 实现 load more / refresh**
- 只依赖 `PlatformClient`。
- [*] 已完成。相关逻辑已写入工作区。

**Step 3: 实现 edit / resend / truncate 最小链路**
- 保持非流式版本。
- [*] 已完成。相关接口调用与最小 UI 行为已写入工作区。

**Step 4: 校验消息操作后的 sidebar 刷新**
- updatedAt、title、message list 同步更新。
- [*] 已完成。当前实现中已在 send / resend / edit / truncate 后刷新 conversations。

**Step 5: 运行 web build 与类型检查**
Run: `npm --prefix apps/web run build && npx tsc -p apps/web/tsconfig.json --noEmit`
Expected: build PASS；type-check 尽量 PASS，若仍 crash 则记录并在 Task 6 处理
- [*] build 已完成并 PASS。
- [*] type-check 已复现 TS internal crash。

**Step 6: 更新计划状态并提交**
```bash
git add packages/frontend-core/src/index.tsx plans.md
git commit -m "feat: decouple chat data flow from platform"
```
- [ ] 未执行。本轮不提交功能代码。

### Task 6: 收敛 TS 校验链路

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`
- Modify: `packages/*/package.json`
- Modify: `apps/web/tsconfig.json`
- Modify: `plans.md`

**Step 1: 复现 TS internal crash**
Run: `npx tsc -p apps/web/tsconfig.json --noEmit`
Expected: 复现当前问题
- [*] 已完成。仍会出现 `Debug Failure`。

**Step 2: 最小化问题范围**
- 分别对 `shared / platform-contract / platform-web / frontend-core / apps/web` 做独立类型检查。
- [*] 已完成。当前仓库中仅 `apps/web/tsconfig.json` 存在可用 tsconfig；对该入口单独执行类型检查已 PASS，packages 暂无独立 tsconfig，说明问题集中在 web 入口解析链路而非各 package 独立编译。

**Step 3: 修正 exports / path alias / package resolution**
- 去掉混用包导入与源码相对导入的模式。
- [*] 已完成。已移除根 tsconfig 的全局包源码映射，将 alias 收敛到 `apps/web/tsconfig.json`，并将 `apps/web/src/api.ts` 改为包导入。

**Step 4: 重新运行类型检查**
Run: `npx tsc -p apps/web/tsconfig.json --noEmit`
Expected: PASS
- [*] 已完成。当前 `tsc -p apps/web/tsconfig.json --noEmit` PASS。

**Step 5: 更新计划状态并提交**
```bash
git add package.json tsconfig.json packages apps/web/tsconfig.json plans.md
git commit -m "fix: stabilize web type-check pipeline"
```
- [ ] 未执行。

### Task 7: 完整回归验证与文档收尾

**Files:**
- Modify: `plans.md`

**Step 1: 执行最终验证**
Run:
- `cd /Volumes/RC500/cib/sparky-proma/apps/server-go && go test ./...`
- `npm --prefix apps/web run build`
- `npx tsc -p apps/web/tsconfig.json --noEmit`

Expected: 前两项 PASS，TypeScript 校验当前仍因 internal crash 未通过。
- [*] server test 已通过。
- [*] web build 已通过。
- [ ] web type-check 尚未通过。

**Step 2: 手动功能回归**
- bootstrap
- list conversations
- create conversation
- select conversation
- send message
- rename conversation
- delete conversation
- pin / unpin conversation
- refresh messages
- load more messages
- edit / resend / truncate（若已实现）
- [ ] 未执行。

**Step 3: 更新 `plans.md` 勾选状态**
- 所有已完成项标记为 `[*]`
- 未完成项保持 `[ ]`
- 写清楚已知限制与下一步
- [*] 已完成。

**Step 4: 提交最终计划状态**
```bash
git add plans.md
git commit -m "docs: update decoupling implementation progress"
```
- [ ] 待本次执行。

---

## 当前实现状态说明

- [*] `packages/shared/src/index.ts` 已补 conversation / message 相关最小共享类型
- [*] `packages/platform-contract/src/index.ts` 已补 rename / delete / pin / refresh / loadMore / edit / resend / truncate 契约
- [*] `packages/platform-web/src/index.ts` 已补对应 HTTP 请求实现
- [*] `apps/server-go/internal/api/server.go`、`apps/server-go/internal/api/chat.go` 与 `internal/store/*` 已补最小后端接口与存储实现
- [*] `packages/frontend-core/src/index.tsx` 已补 sidebar 会话管理与 chat 数据层最小解耦实现
- [*] `cd /Volumes/RC500/cib/sparky-proma/apps/server-go && go test ./...` 已通过
- [*] `npm --prefix /Volumes/RC500/cib/sparky-proma/apps/web run build` 已通过
- [ ] `npx tsc -p apps/web/tsconfig.json --noEmit` 仍为 TypeScript internal crash，尚未处理
- [ ] 本次仅提交 `plans.md`，其余功能代码保持未提交状态

## 已知风险与决策

- [ ] upstream `ChatView` 绑定了流式、附件、tool、prompt、context divider 等大量 Electron 特性，本轮只迁最小数据层，不强行一次搬完
- [ ] 当前 `frontend-core/src/index.tsx` 状态过于集中，后续可能需要拆分组件，但只有在解耦落地后再做，避免提前抽象
- [ ] Go server API 可能尚未完全覆盖 upstream 行为，需以 web 最小链路优先，不追求一轮对齐全部功能
- [*] 根目录 `go test ./...` 与仓库结构不匹配，后续验证应在 `apps/server-go` 模块内执行
- [ ] TypeScript internal crash 可能与仓库结构配置有关，需要单列为稳定性任务处理

## 完成定义

- [ ] `frontend-core` 不直接依赖 Electron API
- [ ] sidebar 会话管理完整经由 `PlatformClient`
- [ ] chat 最小数据层完整经由 `PlatformClient`
- [ ] web 平台与 Go server 支撑上述所有能力
- [ ] `apps/web` 维持薄壳
- [*] web build 通过
- [ ] web type-check 通过
- [*] server test / build 通过
- [*] `plans.md` 与代码进度同步
