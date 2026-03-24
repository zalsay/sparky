# P5 完全复用 Proma 设置页与渠道配置 UI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `sparky-proma` web fully reuse the mature Proma settings/channel management UI so the browser app can configure provider + model with the same experience as the Proma Electron app.

**Architecture:** Reuse the existing Proma renderer settings architecture at the `packages/frontend-core` layer instead of rebuilding a new settings page inside `apps/web`. Keep `apps/web` as a thin shell that mounts `SparkyApp`, and migrate the reusable UI primitives, settings panel structure, channel CRUD form, and related state into the shared frontend package. Replace Electron-only APIs with the existing `PlatformClient` methods already exposed by `@sparky/platform-web`, while keeping browser-specific gaps explicit and minimal.

**Tech Stack:** React 18, TypeScript, Jotai, Vite, `@sparky/frontend-core`, `@sparky/platform-web`, `@sparky/shared`, existing Go server channel/settings APIs, Proma Electron renderer design as source UI reference.

---

## 0. Context and design constraints

### What already exists in `sparky-proma`
- `apps/web/src/App.tsx` already mounts `SparkyApp` from `@sparky/frontend-core`, so the browser shell is intentionally thin.
- `packages/frontend-core/src/index.tsx:1025` already supports per-conversation `Channel + Model` switching in the chat header, but there is no full settings surface for provider/channel CRUD.
- `packages/platform-web/src/index.ts:220` already exposes browser-safe APIs for settings, channel CRUD, runtime, workspaces, agent sessions, and chat operations.
- `packages/shared/src/index.ts:11` already has `Channel`, `ChannelModel`, `ChannelCreateInput`, `ChannelUpdateInput`, and app settings types needed by a reusable settings UI.

### What already exists in `Proma`
- `apps/electron/src/renderer/components/settings/SettingsPanel.tsx` has the reusable settings shell pattern: left nav, right content, tab switching.
- `apps/electron/src/renderer/components/settings/ChannelSettings.tsx` has the list/create/edit flow for channels and agent-provider selection.
- `apps/electron/src/renderer/components/settings/ChannelForm.tsx` already covers provider selection, base URL, API key, test connection, fetch models, and model toggles.
- `apps/electron/src/renderer/atoms/settings-tab.ts:14` already defines the settings tab model.

### Key decision
P5 should **not** clone Proma UI into `apps/web`. It should move/adapt the reusable parts into `packages/frontend-core`, then let both browser and future shells consume the same component tree.

---

## Task 1: Freeze the reuse boundary before moving code

**Files:**
- Modify: `/Volumes/RC500/cib/sparky-proma/packages/frontend-core/src/index.tsx`
- Modify: `/Volumes/RC500/cib/sparky-proma/packages/platform-web/src/index.ts`
- Reference: `/Volumes/RC500/cib/Proma/apps/electron/src/renderer/components/settings/SettingsPanel.tsx`
- Reference: `/Volumes/RC500/cib/Proma/apps/electron/src/renderer/components/settings/ChannelSettings.tsx`
- Reference: `/Volumes/RC500/cib/Proma/apps/electron/src/renderer/components/settings/ChannelForm.tsx`

**Step 1: Write the failing test**

Add a focused frontend-core test that asserts the app can render a settings entry point and load channel settings content through the injected `PlatformClient`.

Example shape:

```tsx
it('renders settings view and loads channels from PlatformClient', async () => {
  const client = createMockPlatformClient({
    listChannels: vi.fn().mockResolvedValue([mockChannel]),
    getSettings: vi.fn().mockResolvedValue(mockSettings),
  })

  render(<SparkyApp client={client} />)

  await user.click(screen.getByRole('button', { name: /settings/i }))

  expect(await screen.findByText('渠道管理')).toBeInTheDocument()
  expect(await screen.findByText(mockChannel.name)).toBeInTheDocument()
})
```

**Step 2: Run test to verify it fails**

Run:
```bash
npm --prefix /Volumes/RC500/cib/sparky-proma test -- packages/frontend-core/src/__tests__/<new-settings-test>.test.tsx
```

Expected: FAIL because frontend-core currently has no reusable settings page.

**Step 3: Write minimal implementation notes in code comments/TODO-free structure**

Before copying UI, establish these boundaries in code:
- `SparkyApp` owns active view state.
- settings/channel CRUD must call `client.listChannels/createChannel/updateChannel/deleteChannel/getSettings/updateSettings`.
- no `window.electronAPI` references may enter `packages/frontend-core`.

**Step 4: Run the test again after the first scaffold change**

Expected: still FAIL, but now only on missing rendered settings content rather than missing entry points.

**Step 5: Commit**

```bash
git add /Volumes/RC500/cib/sparky-proma/packages/frontend-core/src/index.tsx /Volumes/RC500/cib/sparky-proma/packages/platform-web/src/index.ts
git commit -m "feat: scaffold reusable settings entry point"
```

---

## Task 2: Port the settings tab state model into shared frontend-core

**Files:**
- Create: `/Volumes/RC500/cib/sparky-proma/packages/frontend-core/src/atoms/settings-tab.ts`
- Modify: `/Volumes/RC500/cib/sparky-proma/packages/frontend-core/src/index.tsx`
- Reference: `/Volumes/RC500/cib/Proma/apps/electron/src/renderer/atoms/settings-tab.ts`

**Step 1: Write the failing test**

Add a small atom/view test that verifies settings defaults to the `channels` tab and can switch tabs without Electron dependencies.

```tsx
it('defaults settings tab to channels', () => {
  expect(store.get(settingsTabAtom)).toBe('channels')
})
```

**Step 2: Run test to verify it fails**

Run the targeted test file.

Expected: FAIL because atom file does not exist.

**Step 3: Write minimal implementation**

Create the atom with the smallest browser-safe subset needed for P5:
- `general`
- `channels`
- `appearance`
- `about`

If the full tab union from Proma is copied, keep unsupported tabs hidden rather than partially rendered.

**Step 4: Run the test to verify it passes**

Run the targeted test file.

Expected: PASS.

**Step 5: Commit**

```bash
git add /Volumes/RC500/cib/sparky-proma/packages/frontend-core/src/atoms/settings-tab.ts /Volumes/RC500/cib/sparky-proma/packages/frontend-core/src/index.tsx
git commit -m "feat: add shared settings tab state"
```

---

## Task 3: Port the Proma `SettingsPanel` shell into frontend-core

**Files:**
- Create: `/Volumes/RC500/cib/sparky-proma/packages/frontend-core/src/components/settings/SettingsPanel.tsx`
- Create: `/Volumes/RC500/cib/sparky-proma/packages/frontend-core/src/components/settings/primitives/*`
- Modify: `/Volumes/RC500/cib/sparky-proma/packages/frontend-core/src/index.tsx`
- Reference: `/Volumes/RC500/cib/Proma/apps/electron/src/renderer/components/settings/SettingsPanel.tsx`

**Step 1: Write the failing test**

Add a render test for settings navigation.

```tsx
it('renders settings navigation tabs', async () => {
  render(<SparkyApp client={client} />)
  await user.click(screen.getByRole('button', { name: /settings/i }))
  expect(await screen.findByText('设置')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '渠道' })).toBeInTheDocument()
})
```

**Step 2: Run test to verify it fails**

Expected: FAIL because settings shell is absent.

**Step 3: Write minimal implementation**

Port the Proma panel structure, but keep only browser-relevant tabs initially:
- General
- Channels
- Appearance
- About

Also port the small reusable settings primitives (`SettingsSection`, `SettingsCard`, `SettingsRow`, `SettingsInput`, `SettingsSelect`, `SettingsToggle`, optional secret input) into frontend-core so later tasks can reuse the exact layout pattern.

Do **not** port Agent / Feishu / Tool / Tutorial tabs in P5 unless they are already supported by `SparkyApp`; hide them by omission.

**Step 4: Run test to verify it passes**

Run the targeted settings render test.

Expected: PASS.

**Step 5: Commit**

```bash
git add /Volumes/RC500/cib/sparky-proma/packages/frontend-core/src/components/settings /Volumes/RC500/cib/sparky-proma/packages/frontend-core/src/index.tsx
git commit -m "feat: port settings shell from proma"
```

---

## Task 4: Port `ChannelSettings` list view and wire it to `PlatformClient`

**Files:**
- Create: `/Volumes/RC500/cib/sparky-proma/packages/frontend-core/src/components/settings/ChannelSettings.tsx`
- Modify: `/Volumes/RC500/cib/sparky-proma/packages/frontend-core/src/index.tsx`
- Modify: relevant frontend-core test files
- Reference: `/Volumes/RC500/cib/Proma/apps/electron/src/renderer/components/settings/ChannelSettings.tsx`

**Step 1: Write the failing test**

Add a test that verifies channel rows render from `client.listChannels()` and delete/toggle call the client methods.

```tsx
it('renders channel rows from PlatformClient', async () => {
  const listChannels = vi.fn().mockResolvedValue([mockChannel])
  render(<SparkyApp client={clientWith({ listChannels })} />)
  await openSettingsChannels()
  expect(await screen.findByText(mockChannel.name)).toBeInTheDocument()
})
```

**Step 2: Run test to verify it fails**

Expected: FAIL because channels page is still placeholder/missing.

**Step 3: Write minimal implementation**

Port the list page structure from Proma and adapt these Electron calls:
- `window.electronAPI.listChannels()` -> `client.listChannels()`
- `window.electronAPI.deleteChannel()` -> `client.deleteChannel()`
- `window.electronAPI.updateChannel()` -> `client.updateChannel()`
- `window.electronAPI.updateSettings()` -> `client.updateSettings()`
- remove `PromaProviderCard` external-download promotion unless product explicitly wants it in web

Keep the second section concept, but rename it clearly if needed:
- “Agent 默认渠道” or similar, backed by `AppSettings.agentChannelId` / `agentModelId`

**Step 4: Run test to verify it passes**

Run the targeted channel settings test.

Expected: PASS.

**Step 5: Commit**

```bash
git add /Volumes/RC500/cib/sparky-proma/packages/frontend-core/src/components/settings/ChannelSettings.tsx /Volumes/RC500/cib/sparky-proma/packages/frontend-core/src/index.tsx
git commit -m "feat: reuse proma channel settings list"
```

---

## Task 5: Port `ChannelForm` and replace Electron-only capabilities deliberately

**Files:**
- Create: `/Volumes/RC500/cib/sparky-proma/packages/frontend-core/src/components/settings/ChannelForm.tsx`
- Modify: `/Volumes/RC500/cib/sparky-proma/packages/shared/src/index.ts` (only if missing direct test/fetch models contracts)
- Modify: `/Volumes/RC500/cib/sparky-proma/packages/platform-contract/package.json` and types only if contract additions are needed
- Modify: `/Volumes/RC500/cib/sparky-proma/packages/platform-web/src/index.ts` if new methods are added
- Reference: `/Volumes/RC500/cib/Proma/apps/electron/src/renderer/components/settings/ChannelForm.tsx`

**Step 1: Write the failing test**

Add a form flow test for create/edit channel.

```tsx
it('creates a channel from settings form', async () => {
  const createChannel = vi.fn().mockResolvedValue(createdChannel)
  render(<SparkyApp client={clientWith({ createChannel })} />)
  await openCreateChannelForm()
  await user.type(screen.getByLabelText('渠道名称'), 'Test Channel')
  await user.type(screen.getByLabelText('API Key'), 'sk-test')
  await user.click(screen.getByRole('button', { name: /创建渠道/i }))
  expect(createChannel).toHaveBeenCalled()
})
```

**Step 2: Run test to verify it fails**

Expected: FAIL because form flow does not exist yet.

**Step 3: Write minimal implementation**

Port the form almost verbatim in layout and interaction, but make these substitutions explicit:
- `decryptApiKey(channel.id)` is **not** available in web. For browser P5, do not support revealing stored secrets from server. Edit mode should allow entering a new key, but never round-trip the existing key back to UI.
- `testChannelDirect` and `fetchModels` only stay if browser/server contracts exist. If they do not, scope them out of initial P5 and hide those buttons rather than inventing ad hoc endpoints.
- Keep provider picker, base URL, model list management, enabled toggle, create/edit actions.

This is the most important YAGNI line in P5: reuse the UI shell, but only preserve behaviors the web platform can support safely.

**Step 4: Run test to verify it passes**

Run the targeted create/edit tests.

Expected: PASS.

**Step 5: Commit**

```bash
git add /Volumes/RC500/cib/sparky-proma/packages/frontend-core/src/components/settings/ChannelForm.tsx /Volumes/RC500/cib/sparky-proma/packages/shared/src/index.ts /Volumes/RC500/cib/sparky-proma/packages/platform-web/src/index.ts
git commit -m "feat: port reusable channel form to web frontend"
```

---

## Task 6: Integrate settings view into existing `SparkyApp` navigation

**Files:**
- Modify: `/Volumes/RC500/cib/sparky-proma/packages/frontend-core/src/index.tsx`
- Modify: relevant styles used by frontend-core
- Reference: Proma left-sidebar/settings-entry UX as visual reference only

**Step 1: Write the failing test**

Add a behavior test that opening settings does not break existing conversation/channel/model flows.

```tsx
it('switches between chat view and settings view without losing loaded conversations', async () => {
  render(<SparkyApp client={client} />)
  await user.click(screen.getByRole('button', { name: /settings/i }))
  await user.click(screen.getByRole('button', { name: /all chats|chats/i }))
  expect(await screen.findByText(mockConversation.title)).toBeInTheDocument()
})
```

**Step 2: Run test to verify it fails**

Expected: FAIL because settings navigation is not fully wired.

**Step 3: Write minimal implementation**

Add a true settings view entry in the existing frontend-core shell instead of bolting settings into the chat header. Ensure:
- sidebar or equivalent nav exposes settings
- returning to chat preserves current conversation selection
- settings uses the same client instance as chat
- existing conversation `Channel + Model` selectors remain unchanged for per-conversation overrides

**Step 4: Run test to verify it passes**

Run targeted navigation tests.

Expected: PASS.

**Step 5: Commit**

```bash
git add /Volumes/RC500/cib/sparky-proma/packages/frontend-core/src/index.tsx
git commit -m "feat: integrate shared settings view into sparky app"
```

---

## Task 7: Add browser-safe defaults and explicit unsupported-state handling

**Files:**
- Modify: `/Volumes/RC500/cib/sparky-proma/packages/frontend-core/src/components/settings/ChannelSettings.tsx`
- Modify: `/Volumes/RC500/cib/sparky-proma/packages/frontend-core/src/components/settings/ChannelForm.tsx`
- Modify: related tests

**Step 1: Write the failing test**

Add tests for unsupported Electron-only actions.

```tsx
it('does not expose decrypt-existing-key behavior in web settings', async () => {
  render(<SparkyApp client={client} />)
  await openEditChannelForm()
  expect(screen.queryByRole('button', { name: /显示已保存 key/i })).not.toBeInTheDocument()
})
```

**Step 2: Run test to verify it fails**

Expected: FAIL if copied UI still assumes Electron APIs.

**Step 3: Write minimal implementation**

Make the browser limitations intentional and productized:
- if no `fetchModels` contract exists, hide the button
- if no direct connection test endpoint exists, hide the button or show a passive note
- in edit mode, API key field means “replace existing key”
- surface server errors via existing frontend error pattern, not console-only silent failure

**Step 4: Run test to verify it passes**

Run the targeted unsupported-state tests.

Expected: PASS.

**Step 5: Commit**

```bash
git add /Volumes/RC500/cib/sparky-proma/packages/frontend-core/src/components/settings/ChannelSettings.tsx /Volumes/RC500/cib/sparky-proma/packages/frontend-core/src/components/settings/ChannelForm.tsx
git commit -m "fix: adapt reused settings ui for browser-safe behavior"
```

---

## Task 8: End-to-end verification in the browser app

**Files:**
- Modify tests under `/Volumes/RC500/cib/sparky-proma/packages/frontend-core/src/__tests__/`
- Optionally modify web smoke docs or plan notes

**Step 1: Write/extend failing test coverage**

Cover at least these flows:
- settings page opens
- create channel
- edit channel metadata/model list
- delete channel
- update default agent channel in settings
- existing chat header still reflects available channel/model selections after settings changes

**Step 2: Run targeted test suite**

Run:
```bash
npm --prefix /Volumes/RC500/cib/sparky-proma test -- packages/frontend-core/src/__tests__
```

Expected: initially FAIL until all integration edges are complete.

**Step 3: Run app-level build/test**

Run:
```bash
npm --prefix /Volumes/RC500/cib/sparky-proma test
npm --prefix /Volumes/RC500/cib/sparky-proma --workspace @sparky/frontend-core test
npm --prefix /Volumes/RC500/cib/sparky-proma --workspace @sparky/platform-web test
npm --prefix /Volumes/RC500/cib/sparky-proma --workspace @sparky/apps-web build
```

If workspace names differ, use the repo’s actual scripts; do not invent new package scripts in code.

**Step 4: Manual smoke test**

In browser app:
1. Open settings
2. Add a provider/channel
3. Enable at least one model
4. Return to chat
5. Confirm new channel appears in header selector
6. Send a message using that channel/model
7. Confirm persistence after refresh

**Step 5: Commit**

```bash
git add /Volumes/RC500/cib/sparky-proma/packages/frontend-core/src/__tests__
git commit -m "test: verify reused proma settings flow in web"
```

---

## Task 9: Update planning docs and delivery notes

**Files:**
- Modify: `/Volumes/RC500/cib/sparky-proma/proma-web-plans/plans-p5.md`
- Optionally modify: follow-up status doc if your workflow keeps a dated execution log

**Step 1: Document final scope**

Record clearly that P5 means:
- browser app now reuses Proma settings/channel UX
- reuse happens in `packages/frontend-core`, not `apps/web`
- Electron-only capabilities were either adapted or intentionally omitted

**Step 2: Document any non-goals**

Explicitly list what was *not* reused in P5:
- Feishu/tool/tutorial/settings tabs
- secret decryption round-trip in browser
- any Electron-only IPC integrations

**Step 3: Document verification**

Include exact test/build/smoke commands that passed.

**Step 4: Final review**

Before implementation handoff, confirm there is no duplicated settings UI living separately in both `apps/web` and `packages/frontend-core`.

**Step 5: Commit**

```bash
git add /Volumes/RC500/cib/sparky-proma/proma-web-plans/plans-p5.md
git commit -m "docs: finalize p5 proma ui reuse plan"
```

---

## Risks to watch during execution

1. **Blind copy of Electron renderer code**
   - Risk: `window.electronAPI` leaks into browser package.
   - Mitigation: every ported component must depend only on `PlatformClient` and shared types.

2. **Over-reusing unsupported behaviors**
   - Risk: browser UI exposes decrypt/test/fetch features without backend support.
   - Mitigation: explicitly hide unsupported actions instead of faking them.

3. **Two competing settings surfaces**
   - Risk: one settings page in `apps/web`, another in `frontend-core`.
   - Mitigation: keep `apps/web` thin; all reusable UI belongs in `frontend-core`.

4. **Breaking existing chat flow**
   - Risk: settings state changes disrupt current conversation selection or per-conversation model selection.
   - Mitigation: preserve current chat header behavior and add regression tests for navigation + selection persistence.

---

## Definition of done

P5 is done when all of the following are true:
- Browser app has a real settings page.
- Provider/model configuration is managed through reused Proma channel UI, not ad hoc new forms.
- Reuse lives in `packages/frontend-core` and is consumed by `apps/web` through `SparkyApp`.
- Channel CRUD works via `PlatformClient` against the Go server.
- Existing conversation `Channel + Model` chat selectors still work.
- Tests cover the ported settings flow and pass.
- `proma-web-plans/plans-p5.md` reflects final scope and limitations.
