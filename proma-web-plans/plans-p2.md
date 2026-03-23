# Proma Web 项目总计划（P2）

**项目总题目：** 完整迁移 GitHub 上的 Proma 项目核心功能到 `sparky` 工作区，并在保留原有产品能力与交互语义的前提下，将原本偏 Electron renderer 耦合的实现改造为 `web + server` 的前后端分离架构。前端以可复用的共享核心为中心，后端以 Go server 提供平台能力与数据接口，最终形成一套可在浏览器环境独立运行、并可继续向多平台扩展的 Proma Web 版本。

**项目描述：** 在 P1 已完成基础主链路解耦与最小可运行闭环之后，P2 面向更接近 upstream Proma 产品能力的后续阶段，继续推进流式消息、附件、tool 调用、prompt / context divider、服务端行为对齐与系统回归测试等工作。本阶段强调在不破坏现有 `web + server` 分层的前提下，逐步补齐更复杂的交互与消息语义，使 `sparky` 中的 Proma Web 不只是“能运行”，而是持续向功能完整、结构清晰、可维护和可扩展的前后端分离版本演进。

# Upstream Frontend 能力解耦后续阶段计划（P2）

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 P1 已完成 web 最小链路解耦的基础上，继续补齐更接近 upstream Electron renderer 的高级能力，包括流式消息、附件、tool 调用、prompt / context divider，以及 Go server 行为对齐与更细粒度回归体系。

**Architecture:** 延续 `PlatformClient -> frontend-core -> platform-web -> Go server` 分层，不把 Electron 专属实现直接搬进 web。优先补平台契约与最小端到端链路，再逐步增强 UI 行为、服务端语义与回归测试覆盖。

**Tech Stack:** React、TypeScript、Vite、Go server、platform-contract、platform-web、frontend-core

---

## 目标范围

- [ ] 为 chat 补齐流式消息最小能力
- [ ] 规划并补齐附件消息能力的 web / server 最小闭环
- [ ] 规划并补齐 tool 调用结果展示的共享数据结构与最小 UI
- [ ] 规划并补齐 prompt / context divider 的共享模型与编辑能力
- [ ] 为 Go server 增加更细粒度的行为对齐与回归测试
- [ ] 在不破坏 `proma-web/web` 薄壳结构的前提下完成新增能力接入

## 非目标

- [ ] 不在本阶段一次性追平 upstream 所有 Electron 特性
- [ ] 不引入只适用于 Electron 的前端直连实现
- [ ] 不为了未来假设需求提前做过度抽象

---

## 功能清单

### 1. 流式消息能力
- [ ] 盘点 upstream 当前流式消息的数据流与状态机
- [ ] 定义 `PlatformClient` 所需最小 streaming 契约
- [ ] 明确 web 侧采用 SSE、chunked response 还是轮询模拟
- [ ] 在 `frontend-core` 中增加 streaming message 的最小状态模型
- [ ] 支持 streaming 中的 loading / partial / done / error 状态
- [ ] 校验 send 与 streaming 完成后的 conversation/message 同步刷新

### 2. 附件能力
- [ ] 盘点 upstream 附件上传、展示、删除、失败态行为
- [ ] 定义共享附件类型与 message 附件结构
- [ ] 为 `PlatformClient` 增加附件上传/引用所需最小接口
- [ ] 在 web / Go server 侧实现最小附件链路
- [ ] 在 chat UI 中增加附件展示与发送前状态
- [ ] 明确本阶段支持的附件类型与大小边界

### 3. Tool 调用能力
- [ ] 盘点 upstream tool call / tool result 的消息结构
- [ ] 定义共享 tool invocation / result 类型
- [ ] 为消息渲染补最小 tool result 展示
- [ ] 明确 tool 执行是服务端驱动、平台透传还是仅展示历史记录
- [ ] 校验 tool 消息与普通消息混排的排序/刷新逻辑

### 4. Prompt / Context Divider 能力
- [ ] 盘点 upstream prompt / context divider 的数据模型与用户操作
- [ ] 定义共享 context divider 类型与最小接口
- [ ] 在 `PlatformClient` 中增加查询/更新 divider 所需接口
- [ ] 在 `frontend-core` 中增加最小读取、展示与编辑能力
- [ ] 保证与现有消息列表、truncate/replay 行为兼容

### 5. Go server 行为对齐与测试
- [ ] 梳理当前 Go server 与 upstream 仍有差异的语义点
- [ ] 为 conversation/message 关键链路补接口级测试
- [ ] 为 edit / resend / truncate / pin / rename 等操作补回归测试
- [ ] 为后续新增 streaming / attachment / tool / divider 能力预留测试结构
- [ ] 明确哪些行为差异接受保留，哪些必须在本阶段补齐

### 6. 文档与交付
- [ ] 持续更新 `plans-p2.md` 的 `[ ]` / `[*]` 状态
- [ ] 记录每项新增能力的范围、限制与验证方式
- [ ] 每个阶段结束后提交代码与计划更新
- [ ] 最终补齐已知限制、验证结果与后续建议

---

## 分阶段实施任务

### Task 1: 盘点 upstream 高级能力并形成缺口清单

**Files:**
- Modify: `proma-web-plans/plans-p2.md`
- Read: upstream chat / attachments / prompt / tool 相关实现
- Read: `packages/platform-contract/src/index.ts`
- Read: `packages/frontend-core/src/index.tsx`
- Read: `packages/platform-web/src/index.ts`
- Read: `proma-web/server-go/internal/api/*.go`

**Step 1: 盘点 upstream 依赖点**
- [ ] 梳理流式、附件、tool、prompt/context divider 的真实依赖面

**Step 2: 产出缺口清单**
- [ ] 明确哪些能力需要新契约、哪些可复用现有链路

**Step 3: 记录阶段边界**
- [ ] 写清本阶段必须交付与明确不做的内容

### Task 2: 设计并实现流式消息最小链路

**Files:**
- Modify: `packages/platform-contract/src/index.ts`
- Modify: `packages/platform-web/src/index.ts`
- Modify: `packages/frontend-core/src/index.tsx`
- Modify: `proma-web/server-go/internal/api/*.go`
- Modify: `proma-web-plans/plans-p2.md`

**Step 1: 定义 streaming 契约**
- [ ] 补齐最小共享类型与接口

**Step 2: 实现 web / server 最小链路**
- [ ] 先跑通一条真实 streaming 消息链路

**Step 3: 接入 frontend-core**
- [ ] 增加 streaming 状态与 UI 更新逻辑

**Step 4: 验证并提交**
- [ ] 执行 build / type-check / server test / 手动回归

### Task 3: 设计并实现附件最小链路

**Files:**
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/platform-contract/src/index.ts`
- Modify: `packages/platform-web/src/index.ts`
- Modify: `packages/frontend-core/src/index.tsx`
- Modify: `proma-web/server-go/internal/api/*.go`
- Modify: `proma-web-plans/plans-p2.md`

**Step 1: 定义附件模型**
- [ ] 补齐 message attachment 共享类型

**Step 2: 实现上传/引用最小闭环**
- [ ] 跑通服务端与前端最小流程

**Step 3: 接入 chat UI**
- [ ] 支持附件展示与发送前状态

**Step 4: 验证并提交**
- [ ] 执行 build / type-check / server test / 手动回归

### Task 4: 设计并实现 tool / divider 最小支持

**Files:**
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/platform-contract/src/index.ts`
- Modify: `packages/platform-web/src/index.ts`
- Modify: `packages/frontend-core/src/index.tsx`
- Modify: `proma-web/server-go/internal/api/*.go`
- Modify: `proma-web-plans/plans-p2.md`

**Step 1: 定义共享模型**
- [ ] 补齐 tool result 与 context divider 所需类型

**Step 2: 接入最小读取/展示能力**
- [ ] 先实现能正确展示与刷新

**Step 3: 再补编辑能力**
- [ ] 仅补最小必要操作，不扩散范围

**Step 4: 验证并提交**
- [ ] 执行 build / type-check / server test / 手动回归

### Task 5: Go server 行为对齐与回归体系补强

**Files:**
- Modify: `proma-web/server-go/internal/api/*.go`
- Modify: `proma-web/server-go/internal/store/*.go`
- Modify: `proma-web/server-go/**/*_test.go`
- Modify: `proma-web-plans/plans-p2.md`

**Step 1: 梳理差异语义**
- [ ] 列出当前与 upstream 的剩余行为差异

**Step 2: 增加关键链路测试**
- [ ] conversation / message / edit / resend / truncate / pin / rename

**Step 3: 增加新能力测试**
- [ ] streaming / attachment / tool / divider 的最小回归用例

**Step 4: 收尾与提交**
- [ ] 更新计划状态、记录限制并提交

---

## 已知风险与决策

- [ ] streaming 方案选型会影响前后端契约，需先收敛最小实现方式
- [ ] 附件能力可能牵涉存储、鉴权、清理策略，需避免在本阶段扩成完整文件系统方案
- [ ] tool / divider 更接近上游复杂交互，需坚持“先最小展示，再补编辑”原则
- [ ] Go server 行为对齐应优先补测试，再补复杂语义，避免回归不可见

## 完成定义

- [ ] 新增能力仍经由 `PlatformClient` 暴露，不回退到平台直连
- [ ] `frontend-core` 承载新增共享逻辑，`proma-web/web` 仍保持薄壳
- [ ] 每个新能力块都有最小端到端链路与明确验证结果
- [ ] `plans-p2.md` 与代码进度保持同步
