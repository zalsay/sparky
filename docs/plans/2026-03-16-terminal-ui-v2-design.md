# Terminal UI v2 (CodePilot-style) — Design

Date: 2026-03-16

## Goal

Introduce a **Terminal UI v2** that visually matches CodePilot’s terminal (header + container styling), while **preserving Sparky’s existing terminal tabs and right-side quick-action buttons**. The current v1 terminal implementation must remain unchanged; v2 is a parallel implementation with a settings toggle.

## Non-Goals

- No backend/PTTY changes.
- No change to terminal tab management.
- No change to existing terminal behavior or shortcuts.
- No refactor of v1 terminal code.

## Summary of Decisions

- Add a **new component** `TerminalV2` that reuses the same PTY data flow but has CodePilot-like UI styling.
- **Keep v1 intact**; switch between v1 and v2 via a new settings toggle.
- **Default**: v2 **enabled** (when config value is absent, treat as enabled).

## UI Scope (V2)

- **Header bar** (CodePilot-style):
  - Height ~28–32px, thin border, uppercase label, subtle muted color.
  - Displays terminal title (tab title).
  - Purely visual unless you request functional buttons.
- **Container styling**:
  - Dark background, rounded corners, subtle inner shadow.
  - Hover glow + border highlight (matching CodePilot tone).
  - Maintain fullscreen behavior (no radius in fullscreen).
- **Terminal body**:
  - xterm stays as-is for input/output.
  - Padding and background tuned to match CodePilot aesthetic.

## Architecture

- **New component**: `ui/src/components/TerminalV2.tsx` (new file).
- Uses the same `usePty` hook and xterm setup logic as v1 but with updated styling.
- **Terminal cache** for V2 kept separate from v1 to avoid cross-instance state conflicts.

## Settings Toggle

- Add a new field to `AppConfig` (e.g. `terminal_ui_v2?: boolean`).
- Add a **Switch** in the Settings menu (label: “Terminal UI v2”).
- Default logic:
  - If config missing: treat as `true`.
  - If user toggles off: set to `false`, use v1.

## Rendering Logic

In `ui/src/App.tsx`, where terminal tabs render:

- If `appConfig?.terminal_ui_v2 !== false`, render `TerminalV2`.
- Else render existing `Terminal`.

This ensures backward compatibility and preserves v1 without edits.

## Data Flow (unchanged)

- `TerminalV2` uses `usePty` (same as v1):
  - `pty_spawn`, `pty_write`, `pty_resize` via Tauri.
  - `pty-data` event listening.
- No changes to backend Rust/Tauri APIs.

## Error Handling

- Reuse v1 logic (catch errors in invoke, ignore resize failures, preserve IME handling).
- V2 should follow the same behavior to avoid regressions.

## Testing Plan

- Manual UI validation:
  - Toggle v1/v2 in Settings.
  - Confirm terminal content renders and input works.
  - Confirm tabs switching preserves terminal state.
  - Confirm fullscreen mode respects styling (no radius).
- No automated tests added (UI-only change).
