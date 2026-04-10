# Executor Split Architecture

## Goal

Split the current single-process `cc-dev` runtime into three layers:

- `web`: browser-facing static UI
- `server`: control plane and gateway
- `executor`: long-lived execution plane

The primary reason for this split is to let us update `web` or `server` without interrupting running PTY sessions, Codex/Claude jobs, code-server, or web dev servers.

## Current Shape

Today the repository runs as a monolith:

- `src/main.rs`: HTTP API, auth, websocket bridge, project APIs, proxying
- `src/session.rs`: PTY lifecycle and process supervision
- `src/editor.rs`: code-server lifecycle
- `src/dev_server.rs`: web dev server lifecycle
- `web/`: React frontend

In practice, this means one Rust process is simultaneously:

- the API server
- the websocket bridge
- the PTY host
- the code-server manager
- the web dev server manager

That coupling is the root cause behind upgrade sensitivity and reconnect complexity.

## Current Implementation Status

The repository now runs in split mode in Docker Compose:

- `sparky-web`: browser-facing static web tier
- `sparky`: control-plane server
- `sparky-executor`: execution plane

Current default local ports:

- `127.0.0.1:3001` -> `sparky-web`
- `127.0.0.1:3101` -> `sparky` direct debug access
- `127.0.0.1:3102` -> `sparky-executor` direct debug access

In this topology:

- browser traffic lands on `web`
- `web` reverse proxies public HTTP and websocket routes to `server`
- `server` handles auth, project metadata, and public API routing
- `server` forwards execution-bound operations to `executor`
- `executor` owns PTY, editor, dev server, file tree, and Git operations

## Target Topology

```text
Browser
  -> web
  -> server

server
  -> postgres
  -> redis (optional)
  -> executor registry
  -> executor attach proxy

executor
  -> PTY sessions
  -> Codex / Claude processes
  -> temporary shells
  -> code-server
  -> web dev servers
  -> runtime caches and snapshots
```

## Ownership By Layer

### web

Responsibilities:

- serve frontend assets
- xterm UI
- file tree / git / codex / web debug panels
- reconnect and attach UX

Must not own:

- PTY lifecycle
- process IDs
- editor or dev server lifecycle
- session truth

### server

Responsibilities:

- auth and authorization
- project metadata CRUD
- session metadata and routing
- public HTTP API
- public websocket gateway
- executor discovery and selection
- attach token issuance
- persistence of session and runtime metadata

Must not own:

- PTY master handles
- Codex / Claude child processes
- code-server child processes
- web dev server child processes

### executor

Responsibilities:

- PTY creation, attach, detach, destroy
- Codex / Claude process execution
- shell execution
- code-server management
- web dev server management
- stdout/stderr snapshots
- runtime health and cleanup
- per-project runtime environment

This is the long-lived layer that should avoid restarts during normal product iteration.

## PTY Placement

PTY must live in `executor`.

Reason:

- a PTY is execution state, not control state
- websocket disconnect should mean `detach`, not process shutdown
- upgrading API or UI must not touch running shell processes
- terminal tabs need stable `session_id` identity independent of browser connections

If PTY remains in `server`, then `server` restarts continue to threaten running work.

## Session Model

We should explicitly split `session` and `attachment`.

### Session

A session is a long-lived execution object:

- stable `session_id`
- `user_id`
- `project_id`
- `runtime`
- `temporary`
- `state`: `starting | running | exited | destroyed`
- process metadata
- ring buffer snapshot
- created / updated / exited timestamps

Session ends only when:

- the child process exits
- the user explicitly destroys it
- executor cleanup policy removes it

### Attachment

An attachment is a temporary browser connection to a session:

- websocket or stream channel
- can be created multiple times
- can disappear without affecting the underlying session

Browser refresh, tab switch, reconnect, or server restart should only affect attachments.

## Server API

The browser-facing API should remain on `server`.

Suggested public endpoints:

- `GET /projects`
- `POST /projects/{id}/sessions`
- `GET /sessions`
- `GET /sessions/{id}`
- `DELETE /sessions/{id}`
- `POST /sessions/{id}/attach`
- `POST /sessions/{id}/resize`
- `POST /projects/{id}/editor`
- `GET /projects/{id}/editor`
- `POST /projects/{id}/dev-servers/{candidate_id}`
- `POST /projects/{id}/dev-servers/{candidate_id}/restart`

Suggested browser attach flow:

1. browser asks `server` to attach to `session_id`
2. server validates ownership and state
3. server resolves which executor owns the session
4. server either proxies the websocket or issues a short-lived executor attach token
5. browser attaches to that session stream

For security and operational simplicity, proxying through `server` is the better first step.

## Internal Executor API

The internal `server -> executor` contract should be explicit and versioned.

Suggested RPC surface:

- `CreateSession`
- `GetSession`
- `ListSessions`
- `AttachSession`
- `DetachSession`
- `DestroySession`
- `SendInput`
- `ResizeSession`
- `GetSnapshot`
- `EnsureEditor`
- `GetEditor`
- `StopEditor`
- `EnsureDevServer`
- `GetDevServer`
- `RestartDevServer`
- `StopDevServer`
- `ListFiles`
- `GitStatus`

Transport can be:

- HTTP + websocket for simplest migration
- gRPC later if we need stronger streaming semantics

For now, HTTP + websocket is enough and keeps the migration smaller.

## Persistence Model

`server` should persist control-plane metadata.

Suggested tables:

### `executors`

- `id`
- `hostname`
- `status`
- `version`
- `last_heartbeat_at`
- `capabilities`

### `sessions`

- `id`
- `user_id`
- `project_id`
- `executor_id`
- `runtime`
- `temporary`
- `state`
- `title`
- `cwd`
- `created_at`
- `updated_at`
- `exited_at`

### `session_attachments`

- `id`
- `session_id`
- `user_id`
- `client_id`
- `connected_at`
- `disconnected_at`

### `editors`

- `user_id`
- `project_id`
- `executor_id`
- `port`
- `proxy_base`
- `state`
- `started_at`

### `dev_servers`

- `user_id`
- `project_id`
- `candidate_id`
- `executor_id`
- `port`
- `proxy_base`
- `state`
- `started_at`

Executor-local state should remain on disk:

- PTY ring buffer snapshots
- session logs
- code-server data directories
- runtime temporary files

## Process Supervision Rules

The executor needs a clear lifecycle contract.

### PTY sessions

- stay alive after websocket detach
- keep a ring buffer for reconnect
- support repeated attach
- are not destroyed by `server` restart

### Codex / Claude

- are child processes of session objects
- inherit stable runtime env from executor
- continue running even if browser disconnects

### code-server

- is keyed by `user_id + project_id`
- remains alive until explicit stop, failure, or idle cleanup

### web dev server

- is keyed by `user_id + project_id + candidate_id`
- restart is an executor operation
- query string preservation remains a server/web routing concern

## Deployment Shape

Recommended containers:

### `cc-web`

- static assets only
- can be restarted at any time

### `cc-server`

- control plane API
- stateless apart from database
- can be rolled independently

### `cc-executor`

- execution plane
- owns `/projects`
- owns runtime caches
- should be restarted deliberately, not routinely

Suggested mounted data for executor:

- `/projects`
- `/home/app/.codex`
- `/home/app/.claude`
- `/home/app/go`
- `/home/app/.cache/go-build`
- `/home/app/.local`
- `/home/app/.cache/pip`
- `/home/app/.cache/uv`

## Repository Split Proposal

Suggested future layout:

```text
web/
server/
executor/
shared/
  api/
  models/
  auth/
```

### `server/`

- auth
- project metadata
- session registry
- browser API
- websocket proxy

### `executor/`

- pty runtime
- process supervisor
- editor runtime
- dev server runtime
- runtime adapters

### `shared/`

- DTOs
- enums
- executor RPC contract
- shared validation logic

## Migration Plan

### Phase 0: Stabilize semantics in current codebase

- redefine websocket disconnect as detach
- stop coupling browser connection with session lifetime
- keep stable session ids for PTY tabs

This phase reduces behavioral churn before any service split.

### Phase 1: Extract executor runtime inside the same repo

- move `session`, `editor`, and `dev_server` into an `executor` crate/module boundary
- keep one deployable binary if needed
- expose internal trait or RPC-like boundary

Goal:

- isolate execution logic behind a clean interface without changing deployment yet

### Phase 2: Split `server` from `executor`

- `server` stops importing PTY/editor/dev-server runtime directly
- `executor` gets its own process entrypoint
- `server` persists session routing data and forwards attach traffic

Goal:

- restarting `server` no longer stops sessions

### Phase 3: Split `web`

- serve frontend from separate container
- configure API base and websocket base through env

Goal:

- frontend rollout is completely independent

### Phase 4: Add executor heartbeat and registry

- multiple executors become possible
- sessions are placed onto a specific executor
- future drain / migration policies become possible

## First Slice To Implement

The best first real slice is:

1. define `SessionRuntime` interface
2. move PTY session management behind that interface
3. treat websocket as attach/detach only
4. keep `session_id` stable across reconnects
5. stop `server` code from depending on PTY internals

This first slice gives the largest product win with the smallest migration risk.

## Immediate Practical Outcome

Once PTY, Codex/Claude, code-server, and dev servers live in `executor`:

- updating the React UI does not affect running sessions
- updating `server` APIs does not kill Codex jobs
- terminal reconnect becomes a simple attach operation
- tab switching no longer risks restarting the process
- executor can be treated as the long-lived worker tier

That is the architectural direction we should optimize for.
