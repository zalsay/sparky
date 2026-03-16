# Feishu Bridge for Sparky (Rust) — Design

**Date:** 2026-03-15

## Goal
Integrate a Feishu IM bridge into Sparky using Rust (no Node). The bridge targets **private chats only**, controls **terminal/PTY execution**, supports **multiple terminal sessions per app**, and uses **interactive cards for session binding**. Permission approvals stay **text-based** (e.g., `26-1`). Terminal output is **not streamed**; only **Stop hook results** are returned to Feishu, for **all stop types**.

## Scope Decisions
- **IM channel:** Feishu (private chats only / open_id).
- **Control target:** PTY terminals (command execution).
- **Session identity:** **terminal_id** (PTY instance ID).
- **Binding:** one open_id can bind to multiple terminal_ids; default session is tracked.
- **Approval:** text reply (`code-choice`) only.
- **Output:** only Stop hook results; no streaming.
- **Access control:** no allowlist.

## Architecture Overview
### Components
- **Feishu WS client**: receives `im.message.receive_v1` and `card.action.trigger` events.
- **Session binding store**: maps `open_id ↔ terminal_id` with default selection.
- **Command router**: routes messages to the correct terminal_id.
- **PTY command queue**: persists commands for PTY poller.
- **Hook output publisher**: on `Stop` hook, send result back to Feishu.

### Data Flow (happy path)
1. Feishu private message received.
2. If command == session/bind action → render session card.
3. Otherwise → resolve default terminal_id for open_id.
4. Write command to PTY command queue (terminal_id).
5. PTY poller executes command.
6. Stop hook fires → send result to Feishu.

## Data Model
### New table: `feishu_terminal_bindings`
Tracks multi-session binding per user.

Fields (suggested):
- `id` (PK)
- `open_id` (Feishu user)
- `terminal_id` (PTY instance)
- `is_default` (bool)
- `created_at`, `updated_at`

Constraints:
- Unique (`open_id`, `terminal_id`)
- Only one `is_default=1` per `open_id`

### Notes
- No changes to `permission_requests` or `pty_commands` required for approvals.
- If feasible, store reverse index for `terminal_id → open_id` for Stop output.

## Session Binding via Interactive Cards
### Card Content
- **Existing sessions list**: one button per active terminal_id.
- **New session**: a button to create and bind a new PTY.

### Card Callback Handling
- `select` action → set binding as default.
- `new` action → create PTY, bind, set default.
- Respond with confirmation message.

## Command Routing Rules
- Any normal text message: resolve `open_id` → default `terminal_id`.
- If no binding: return message prompting the user to bind + session card.
- `pty_commands` should be keyed by `terminal_id` (preferred), not only project_path.

## Permission Flow (Text Reply)
- Permissions remain on `permission_requests` + `code-choice`.
- `verify_and_execute_command` should write to the correct terminal_id queue.
- Card UI is **not** used for approvals (by requirement).

## Stop Hook Output
- Trigger: any hook event `Stop` (all stop types).
- Content source order:
  1) `last_assistant_message`
  2) fallback to transcript parsing
- Target: resolve `terminal_id → open_id` (binding table).
- If no binding exists: log and skip send.

## Error Handling
- Missing binding: return “please bind session” card.
- Unknown card action: respond with error message.
- Command enqueue failure: send error to Feishu.
- Feishu WS disconnect: keep reconnect logic; log status.

## Minimal Test Plan
1. Private chat sends normal text without binding → prompt card.
2. Card select session → subsequent messages route to selected terminal.
3. Card new session → creates PTY + binds + routes.
4. Permission request → `code-choice` works.
5. Stop hook → Feishu receives final output.

## Out of Scope
- Group chat support
- Streaming output
- Card-based approval
- Allowlist

## Related Code (current)
- Feishu WS client: `src-tauri/src/feishu_client.rs`
- Feishu message sender: `src/feishu.rs`
- PTY manager: `src-tauri/src/pty.rs`
- Hooks Stop output: `src/main.rs` / `src/hooks.rs`
