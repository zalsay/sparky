# P4 Channel-Driven Agent Runtime & Chat Model Switching Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the single `ANTHROPIC_API_KEY` runtime assumption in `proma-web` with a Proma-style `Channel` configuration model, and enable both chat and agent sessions to select `channel + model` per conversation/session.

**Architecture:** Reuse Proma desktop’s `Channel` abstraction as the single provider configuration source in `proma-web`. The Go server owns channel storage and runtime resolution, chat conversations persist `channelId + modelId`, and agent session creation also binds `channelId + modelId`. Chat remains multi-provider, while the Claude Agent SDK runner resolves only Anthropic-compatible channels into Claude runtime settings/env at session start. For agent execution, follow the cc-switch pattern from `docs/cc-switch-provider-terminal.md`: resolve provider config before Claude starts and launch each session with an isolated settings/env payload rather than relying on a global live key.

**Tech Stack:** Go HTTP server, TypeScript shared contracts, platform-web client, frontend-core/web React UI, Docker Compose, Claude Agent SDK runner, Proma Channel schema, per-session Claude settings/env injection.

---

## Context you must understand before coding

### Reference implementation in `/Volumes/RC500/cib/Proma`
- Channel type: `/Volumes/RC500/cib/Proma/packages/shared/src/types/channel.ts:72`
- Channel file storage + API key encryption pattern: `/Volumes/RC500/cib/Proma/apps/electron/src/main/lib/channel-manager.ts:34`
- Chat/agent model selection UI pattern: `/Volumes/RC500/cib/Proma/apps/electron/src/renderer/components/chat/ModelSelector.tsx:31`
- Agent runtime resolves channel, decrypts API key, sets Anthropic env: `/Volumes/RC500/cib/Proma/apps/electron/src/main/lib/agent-orchestrator.ts:698`

### Reference design note in this repo
- `docs/cc-switch-provider-terminal.md:7`
- Key idea: provider is resolved **before** Claude starts; a temporary settings/env payload is built specifically for that Claude process.

### Existing P4 plan sections that are now outdated
- `proma-web-plans/plans-p4.md:395` still assumes global `ANTHROPIC_API_KEY`
- `proma-web-plans/plans-p4.md:428` still treats runner env as static provider configuration
- `proma-web-plans/plans-p4.md:1248` still uses an outdated frontend vitest command path

### Guardrails
- Do **not** add a second provider schema. Reuse `Channel` naming and shape.
- Do **not** let runner read channel storage directly. Server resolves runtime config and sends only the minimum needed payload to runner.
- Do **not** pretend Agent supports every provider. In this phase, Chat supports all channels, Agent only accepts `anthropic` channels.
- Do **not** keep `ANTHROPIC_API_KEY` as the primary runtime configuration source for agent sessions.

---

## Task 1: Update the P4 plan document to record the channel-based design

**Files:**
- Modify: `/Volumes/RC500/cib/sparky-proma/proma-web-plans/plans-p4.md`
- Reference: `/Volumes/RC500/cib/sparky-proma/docs/cc-switch-provider-terminal.md`
- Reference: `/Volumes/RC500/cib/Proma/packages/shared/src/types/channel.ts`

**Step 1: Replace outdated environment assumptions in the plan**

In `plans-p4.md`, update the architecture and deployment sections so they say:
- global `ANTHROPIC_API_KEY` is replaced by channel-driven runtime resolution
- chat and agent sessions both carry `channelId + modelId`
- runner receives resolved runtime config from server, not raw channel storage access
- agent runtime only supports Anthropic channels in P4.5/P4 follow-up

Explicitly rewrite the parts around:
- `proma-web-plans/plans-p4.md:395`
- `proma-web-plans/plans-p4.md:428`
- `proma-web-plans/plans-p4.md:435`

**Step 2: Fix the stale frontend test command in the plan**

Change the final frontend test step so it runs from the actual repo root/package layout instead of the broken web cwd command.

Expected correction pattern:
```bash
npm --prefix "/Volumes/RC500/cib/sparky-proma/proma-web" exec vitest run
```
or the exact command that matches the repo’s real vitest setup after verification.

**Step 3: Add a new section documenting the channel/model migration**

Document:
- why the old API-key-only approach failed for compose/local smoke
- why Proma’s `Channel` abstraction is the correct source model
- why chat is multi-provider but agent is Anthropic-only for now
- why runner sessions should use per-session settings/env payloads

**Step 4: Review the markdown for consistency**

Ensure the plan no longer contradicts itself about:
- env ownership
- provider/model switching
- Docker validation steps

**Step 5: Commit**

```bash
git -C "/Volumes/RC500/cib/sparky-proma" add proma-web-plans/plans-p4.md
git -C "/Volumes/RC500/cib/sparky-proma" commit -m "docs: update p4 plan for channel-based runtime"
```

---

## Task 2: Add shared Channel and selection contracts to `proma-web`

**Files:**
- Modify: `/Volumes/RC500/cib/sparky-proma/proma-web/packages/shared/src/index.ts`
- Test: compile coverage through downstream imports
- Reference: `/Volumes/RC500/cib/Proma/packages/shared/src/types/channel.ts:72`

**Step 1: Write the failing type usage first**

Add downstream imports in the server/platform/frontend code that require these new exports to exist:
- `ProviderType`
- `ChannelModel`
- `Channel`
- `ChannelCreateInput`
- `ChannelUpdateInput`
- `ChannelSummary` (safe response without plaintext key, if needed)
- `ConversationModelSelection`

Suggested minimal shared code shape:
```ts
export type ProviderType =
  | 'anthropic'
  | 'openai'
  | 'deepseek'
  | 'google'
  | 'moonshot'
  | 'zhipu'
  | 'minimax'
  | 'doubao'
  | 'qwen'
  | 'custom'

export interface ChannelModel {
  id: string
  name: string
  enabled: boolean
}

export interface Channel {
  id: string
  name: string
  provider: ProviderType
  baseUrl: string
  apiKey: string
  models: ChannelModel[]
  enabled: boolean
  createdAt: number
  updatedAt: number
}

export interface ConversationModelSelection {
  channelId: string
  modelId: string
}
```

**Step 2: Extend existing P4 agent contracts**

Update `CreateAgentSessionInput` and any related session payload types to include:
```ts
channelId: string
modelId: string
```

Also extend conversation metadata/shared chat contract to persist:
```ts
channelId?: string
modelId?: string
```

**Step 3: Run TypeScript build to verify contract breakage is visible**

Run:
```bash
npm --prefix "/Volumes/RC500/cib/sparky-proma/proma-web/web" run build
```
Expected: FAIL first because platform/server/frontend code is not updated yet.

**Step 4: Keep the shared types minimal**

Do not add Electron-only fields or IPC constants. This is the web/shared contract, not a copy-paste dump.

**Step 5: Re-run build after downstream fixes later**

This step will pass only after later tasks complete.

**Step 6: Commit**

```bash
git -C "/Volumes/RC500/cib/sparky-proma" add proma-web/packages/shared/src/index.ts
git -C "/Volumes/RC500/cib/sparky-proma" commit -m "feat: add shared channel contracts for proma-web"
```

---

## Task 3: Implement server-side channel storage and safe API surface

**Files:**
- Modify: `/Volumes/RC500/cib/sparky-proma/proma-web/server-go/internal/...` (exact files to be identified from current server layout)
- Likely modify: server config/store/api files under `server-go/internal/api`, `server-go/internal/store`, `server-go/internal/config`
- Test: new Go tests beside channel store/api packages
- Reference: `/Volumes/RC500/cib/Proma/apps/electron/src/main/lib/channel-manager.ts:34`

**Step 1: Write failing Go tests for channel persistence**

Cover:
- create channel stores metadata and encrypted key
- list channels does not expose plaintext key in normal response
- update channel preserves encrypted key when apiKey is omitted/empty
- delete channel removes record
- get runtime-resolved key returns plaintext only inside server internals

Example skeleton:
```go
func TestCreateChannelEncryptsApiKey(t *testing.T) {
    store := newTestChannelStore(t)
    created, err := store.CreateChannel(ChannelCreateInput{...})
    require.NoError(t, err)
    require.NotEqual(t, "plain-key", created.APIKey)
}
```

**Step 2: Implement the minimal channel store**

Requirements:
- persistent storage owned by `server-go`
- plaintext key never returned by list/get APIs
- internal resolver can decrypt/access plaintext
- support `models[]`, `enabled`, `provider`, `baseUrl`

If there is already an existing config/storage mechanism in `server-go`, reuse it. Do not invent a DB layer if file-backed config is sufficient for P4.

**Step 3: Add channel management endpoints**

Add minimal API endpoints:
- `GET /api/channels`
- `POST /api/channels`
- `PATCH /api/channels/:id`
- `DELETE /api/channels/:id`

Optional if easy in same pattern:
- `POST /api/channels/:id/test`
- `POST /api/channels/:id/models:refresh`

Response rule:
- API never returns plaintext `apiKey`
- edit requests may accept plaintext `apiKey`

**Step 4: Run targeted Go tests**

Run:
```bash
cd "/Volumes/RC500/cib/sparky-proma/proma-web/server-go" && go test ./...
```
Expected: PASS for the new channel tests and existing suites.

**Step 5: Commit**

```bash
git -C "/Volumes/RC500/cib/sparky-proma" add proma-web/server-go
git -C "/Volumes/RC500/cib/sparky-proma" commit -m "feat: add server-side channel management"
```

---

## Task 4: Persist `channelId + modelId` on chat conversations

**Files:**
- Modify: `/Volumes/RC500/cib/sparky-proma/proma-web/server-go/internal/...` conversation/chat files
- Modify: `/Volumes/RC500/cib/sparky-proma/proma-web/packages/platform-web/src/index.ts`
- Modify: `/Volumes/RC500/cib/sparky-proma/proma-web/packages/frontend-core/src/...`
- Test: Go conversation tests and frontend conversation selection tests
- Reference: `/Volumes/RC500/cib/Proma/apps/electron/src/renderer/components/chat/ModelSelector.tsx:164`

**Step 1: Write a failing backend test for conversation model metadata**

Cover:
- creating/updating a conversation can save `channelId` and `modelId`
- fetching conversation returns those fields
- invalid channel/model combinations are rejected at the API boundary if that validation already exists nearby

**Step 2: Write a failing frontend test for selection persistence**

Cover:
- selecting a channel/model updates conversation state
- switching conversation restores that conversation’s saved selection

Example skeleton:
```tsx
it('persists channel and model per conversation', async () => {
  render(<FrontendCore api={api} />)
  // select channel/model, switch conversation, switch back
  expect(...).toHaveTextContent('Claude Sonnet')
})
```

**Step 3: Implement the minimal persistence path**

Requirements:
- conversation metadata stores `channelId` and `modelId`
- platform-web exposes update/read methods needed by frontend
- no global-only fallback if a conversation has explicit selection

**Step 4: Run targeted tests**

Run:
```bash
cd "/Volumes/RC500/cib/sparky-proma/proma-web/server-go" && go test ./...
npm --prefix "/Volumes/RC500/cib/sparky-proma/proma-web" exec vitest run
```
Expected: the new conversation selection tests PASS.

**Step 5: Commit**

```bash
git -C "/Volumes/RC500/cib/sparky-proma" add proma-web/server-go proma-web/packages/platform-web/src proma-web/packages/frontend-core/src
git -C "/Volumes/RC500/cib/sparky-proma" commit -m "feat: persist chat channel and model selection"
```

---

## Task 5: Extend agent session contracts to bind `channelId + modelId`

**Files:**
- Modify: `/Volumes/RC500/cib/sparky-proma/proma-web/packages/shared/src/index.ts`
- Modify: `/Volumes/RC500/cib/sparky-proma/proma-web/packages/platform-web/src/index.ts`
- Modify: `/Volumes/RC500/cib/sparky-proma/proma-web/server-go/internal/api/agent.go`
- Modify: `/Volumes/RC500/cib/sparky-proma/proma-web/agent-runner/src/types.ts`
- Test: Go API tests and TS compile coverage

**Step 1: Write failing API tests for create session payload**

Cover:
- missing `channelId` is rejected
- missing `modelId` is rejected
- non-Anthropic channel is rejected for agent sessions
- valid Anthropic channel creates a session record successfully

Example skeleton:
```go
func TestCreateAgentSessionRejectsNonAnthropicChannel(t *testing.T) {
    // arrange openai channel
    // call POST /api/agent/sessions
    // assert 400 or 409
}
```

**Step 2: Update request/response payloads**

Add required fields:
```ts
interface CreateAgentSessionInput {
  workspaceId: string
  name: string
  channelId: string
  modelId: string
}
```

Make sure server and runner internal payloads carry the same identifiers or a resolved runtime payload.

**Step 3: Implement server validation**

Validation rules:
- channel must exist
- channel must be enabled
- channel provider must be `anthropic` for agent runtime
- model must exist and be enabled inside that channel

**Step 4: Run tests**

Run:
```bash
cd "/Volumes/RC500/cib/sparky-proma/proma-web/server-go" && go test ./...
npm --prefix "/Volumes/RC500/cib/sparky-proma/proma-web/web" run build
```
Expected: PASS.

**Step 5: Commit**

```bash
git -C "/Volumes/RC500/cib/sparky-proma" add proma-web/packages/shared/src/index.ts proma-web/packages/platform-web/src/index.ts proma-web/server-go/internal/api/agent.go proma-web/agent-runner/src/types.ts
git -C "/Volumes/RC500/cib/sparky-proma" commit -m "feat: bind agent sessions to channel and model"
```

---

## Task 6: Resolve Anthropic runtime config on the server and send it to runner

**Files:**
- Modify: `/Volumes/RC500/cib/sparky-proma/proma-web/server-go/internal/...` agent service/client files
- Modify: `/Volumes/RC500/cib/sparky-proma/proma-web/agent-runner/src/types.ts`
- Test: Go unit tests for runtime resolution
- Reference: `/Volumes/RC500/cib/Proma/apps/electron/src/main/lib/agent-orchestrator.ts:713`
- Reference: `/Volumes/RC500/cib/sparky-proma/docs/cc-switch-provider-terminal.md:79`

**Step 1: Write failing tests for runtime resolution**

Cover:
- Anthropic channel resolves into normalized Claude runtime config
- default Anthropic base URL does not need an override when standard
- custom Anthropic-compatible base URL is forwarded correctly
- plaintext key is only present in the internal runner request, not stored in session metadata

Suggested runtime payload shape:
```ts
interface RunnerClaudeRuntimeConfig {
  modelId: string
  apiKey: string
  baseUrl?: string
  provider: 'anthropic'
}
```

**Step 2: Implement server-side resolver**

Server creates a runner request payload that includes only what the runner needs for Claude startup.

Do not send the whole channel object.

**Step 3: Keep session metadata safe**

Persist on the server session record:
- `channelId`
- `modelId`
- maybe `provider`

Do not persist plaintext API key into session state, logs, or API responses.

**Step 4: Run tests**

Run:
```bash
cd "/Volumes/RC500/cib/sparky-proma/proma-web/server-go" && go test ./...
```
Expected: PASS.

**Step 5: Commit**

```bash
git -C "/Volumes/RC500/cib/sparky-proma" add proma-web/server-go proma-web/agent-runner/src/types.ts
git -C "/Volumes/RC500/cib/sparky-proma" commit -m "feat: resolve claude runtime config from channels"
```

---

## Task 7: Update runner to use per-session Claude settings/env instead of global key env

**Files:**
- Modify: `/Volumes/RC500/cib/sparky-proma/proma-web/agent-runner/src/claude-runtime.ts`
- Modify: `/Volumes/RC500/cib/sparky-proma/proma-web/agent-runner/src/server.ts`
- Modify: `/Volumes/RC500/cib/sparky-proma/proma-web/agent-runner/src/types.ts`
- Test: `/Volumes/RC500/cib/sparky-proma/proma-web/agent-runner/...` tests
- Reference: `/Volumes/RC500/cib/sparky-proma/docs/cc-switch-provider-terminal.md:79`

**Step 1: Write failing runner tests**

Cover:
- session startup uses the request payload model rather than a hardcoded env model
- session startup builds isolated Claude settings/env per session
- health no longer reports failure solely because global `ANTHROPIC_API_KEY` is absent
- restart reuses stored resolved runtime config without rereading global env

Example skeleton:
```ts
it('starts claude with session-scoped runtime config', async () => {
  const session = await runtime.createSession({
    runtimeConfig: { provider: 'anthropic', modelId: 'claude-sonnet-4-6', apiKey: 'x' },
  })
  expect(spawnedConfig.model).toBe('claude-sonnet-4-6')
})
```

**Step 2: Implement session-scoped runtime startup**

Requirements:
- remove dependency on global `ANTHROPIC_API_KEY` for actual session startup
- keep non-root `/home/app` + `/workspace` execution model already validated
- for each session, build the Claude startup settings/env payload from resolved runtime config
- use the requested `modelId`, not a static model env

If Claude Agent SDK supports passing env/settings directly, use that.
If it requires a temp settings file, follow the cc-switch pattern and generate a session-specific temp file.

**Step 3: Update runner health semantics**

Health should mean:
- runner process is alive
- filesystem/runtime prerequisites exist
- Claude can be started when valid runtime config is supplied

Health should not require a globally configured API key anymore.

**Step 4: Run runner tests**

Run:
```bash
npm --prefix "/Volumes/RC500/cib/sparky-proma/proma-web/agent-runner" test
```
Expected: PASS.

**Step 5: Commit**

```bash
git -C "/Volumes/RC500/cib/sparky-proma" add proma-web/agent-runner
git -C "/Volumes/RC500/cib/sparky-proma" commit -m "feat: start runner sessions with channel-scoped claude config"
```

---

## Task 8: Add channel + model management UI and conversation-level selectors

**Files:**
- Modify: `/Volumes/RC500/cib/sparky-proma/proma-web/packages/frontend-core/src/...`
- Modify: `/Volumes/RC500/cib/sparky-proma/proma-web/web/src/api.ts`
- Test: frontend-core tests for channel/model selection and channel management UI
- Reference: `/Volumes/RC500/cib/Proma/apps/electron/src/renderer/components/chat/ModelSelector.tsx:31`

**Step 1: Write failing frontend tests**

Cover:
- channel list loads and only enabled models/channels are selectable
- selecting a channel filters model options to that channel
- changing channel resets invalid model selection
- conversation switch restores per-conversation `channelId + modelId`
- channel settings CRUD updates the selector options

Example skeleton:
```tsx
it('supports channel and model double switching in chat composer', async () => {
  render(<FrontendCore api={api} />)
  // pick channel, then pick model, then assert saved state
})
```

**Step 2: Implement minimal channel selector + model selector UI**

Requirements:
- a channel selector in the chat composer/toolbar
- a model selector whose options depend on the chosen channel
- the selected values come from conversation metadata, not only a global atom/state
- disabled/unavailable channels are hidden or clearly marked unusable

Keep it minimal. No overdesigned settings workflow.

**Step 3: Add channel management UI if the repo already has a settings surface**

Minimal functionality:
- list channels
- create channel
- edit channel
- delete channel

If a settings surface already exists, extend it. Do not create a second unrelated admin page unless the current architecture forces it.

**Step 4: Run targeted frontend tests**

Run:
```bash
npm --prefix "/Volumes/RC500/cib/sparky-proma/proma-web" exec vitest run
```
Expected: PASS.

**Step 5: Run frontend build**

Run:
```bash
npm --prefix "/Volumes/RC500/cib/sparky-proma/proma-web/web" run build
```
Expected: PASS.

**Step 6: Commit**

```bash
git -C "/Volumes/RC500/cib/sparky-proma" add proma-web/packages/frontend-core/src proma-web/web/src/api.ts
git -C "/Volumes/RC500/cib/sparky-proma" commit -m "feat: add chat channel and model switching ui"
```

---

## Task 9: Update agent session UI to require Anthropic channel selection

**Files:**
- Modify: `/Volumes/RC500/cib/sparky-proma/proma-web/packages/frontend-core/src/index.tsx`
- Test: `/Volumes/RC500/cib/sparky-proma/proma-web/packages/frontend-core/src/__tests__/agent-sessions.test.tsx`

**Step 1: Write the failing UI test**

Cover:
- create agent session form requires selecting channel and model
- only Anthropic channels are shown in the agent-session create flow
- invalid/non-Anthropic channels show a clear explanatory message
- active session display includes selected channel/model metadata

Example skeleton:
```tsx
it('creates agent sessions only from anthropic channels', async () => {
  render(<FrontendCore api={api} />)
  expect(screen.getByText(/anthropic/i)).toBeInTheDocument()
})
```

**Step 2: Implement the minimal UI changes**

Add to the agent session create flow:
- channel selector filtered to Anthropic channels
- model selector filtered to enabled models in that channel
- validation text if no Anthropic channels are configured

**Step 3: Keep connect/close/restart flows unchanged where possible**

Do not rewrite the whole panel. Only add the new required inputs and display context.

**Step 4: Run targeted tests**

Run:
```bash
npm --prefix "/Volumes/RC500/cib/sparky-proma/proma-web" exec vitest run packages/frontend-core/src/__tests__/agent-sessions.test.tsx
```
Expected: PASS.

**Step 5: Commit**

```bash
git -C "/Volumes/RC500/cib/sparky-proma" add proma-web/packages/frontend-core/src/index.tsx proma-web/packages/frontend-core/src/__tests__/agent-sessions.test.tsx
git -C "/Volumes/RC500/cib/sparky-proma" commit -m "feat: require channel and model for agent sessions"
```

---

## Task 10: Update Docker and smoke validation for channel-driven runtime

**Files:**
- Modify: `/Volumes/RC500/cib/sparky-proma/proma-web/docker-compose.p4.yml`
- Modify: `/Volumes/RC500/cib/sparky-proma/proma-web/agent-runner/Dockerfile`
- Modify: `/Volumes/RC500/cib/sparky-proma/proma-web/server-go/Dockerfile` (only if needed)
- Modify: `/Volumes/RC500/cib/sparky-proma/proma-web-plans/plans-p4.md`

**Step 1: Remove static runtime key assumptions from compose**

Requirements:
- no required global `ANTHROPIC_API_KEY` for runner startup
- preserve validated non-root runner setup:
  - `HOME=/home/app`
  - `SHELL=/bin/sh`
  - `PROMA_WORKSPACE_ROOT=/workspace`
- keep mounted workspace path readable/writable by `app`

**Step 2: Bring up compose stack**

Run:
```bash
docker compose -f "/Volumes/RC500/cib/sparky-proma/proma-web/docker-compose.p4.yml" up -d --build
```
Expected: server and runner start successfully without requiring a global API key env.

**Step 3: Verify health endpoints**

Run:
```bash
curl http://localhost:3010/health
curl http://localhost:3010/api/runtime
curl http://localhost:3210/health
```
Expected:
- 200 from all endpoints
- runtime reports agent control plane enabled
- runner health no longer fails due to missing static key

**Step 4: Run complete smoke flow with configured channel**

Use API/browser/manual flow:
- create at least one Anthropic channel via server API/UI
- create an agent session using that `channelId + modelId`
- connect session
- send message / stream response
- close session
- restart session

Expected:
- no `spawn node ENOENT`
- no root/bypass error
- no invalid API key unless the configured channel key is actually wrong

**Step 5: Run verification commands**

Run:
```bash
cd "/Volumes/RC500/cib/sparky-proma/proma-web/server-go" && go test ./...
npm --prefix "/Volumes/RC500/cib/sparky-proma/proma-web/agent-runner" test
npm --prefix "/Volumes/RC500/cib/sparky-proma/proma-web" exec vitest run
npm --prefix "/Volumes/RC500/cib/sparky-proma/proma-web/web" run build
```
Expected: PASS.

**Step 6: Update plan with final validation notes**

In `proma-web-plans/plans-p4.md`, record:
- final runtime architecture
- health semantics change
- known limitation: agent supports Anthropic channels only
- exact verified frontend test command
- exact smoke path used

**Step 7: Commit**

```bash
git -C "/Volumes/RC500/cib/sparky-proma" add proma-web/docker-compose.p4.yml proma-web/agent-runner/Dockerfile proma-web/server-go/Dockerfile proma-web-plans/plans-p4.md
git -C "/Volumes/RC500/cib/sparky-proma" commit -m "feat: validate channel-driven p4 runtime flow"
```

---

## Final verification checklist

Run these before declaring the work complete:

```bash
cd "/Volumes/RC500/cib/sparky-proma/proma-web/server-go" && go test ./...
npm --prefix "/Volumes/RC500/cib/sparky-proma/proma-web/agent-runner" test
npm --prefix "/Volumes/RC500/cib/sparky-proma/proma-web" exec vitest run
npm --prefix "/Volumes/RC500/cib/sparky-proma/proma-web/web" run build
docker compose -f "/Volumes/RC500/cib/sparky-proma/proma-web/docker-compose.p4.yml" up -d --build
curl http://localhost:3010/health
curl http://localhost:3010/api/runtime
curl http://localhost:3210/health
```

Manual smoke checklist:
- Create an Anthropic channel in settings/API
- In chat, switch channel and model successfully
- Switch conversations and confirm each restores its own channel/model
- Create agent session with Anthropic `channelId + modelId`
- Connect that session to a conversation
- Send a message and receive streamed output
- Close and restart the same session
- Confirm chat remains blocked when no agent session is connected

## Known limitations to keep explicit
- Agent runtime supports Anthropic channels only in this phase.
- Chat may support additional providers via channel metadata, but runner does not.
- Channel secret handling in `proma-web` is server-side and does not reuse Electron `safeStorage`.
- Per-session Claude settings/env isolation is required; do not regress to a global key env.
