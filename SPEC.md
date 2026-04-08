# Sparky Spec

## Role

`sparky` is the active Rust PTY backend.

It does three things:

1. Loads predefined project environments from config
2. Spawns a PTY-backed process for a selected project
3. Serves the web UI and bridges browser input/output over WebSocket

Legacy Go/Python implementations have been moved to `legacy/` and are not part of the active runtime.

## Runtime Shape

```text
Browser
  -> GET /projects
  -> POST /projects/{id}/session
  -> GET /session/{id}/ws
  -> DELETE /session/{id}

Rust Actix server
  -> portable-pty session
  -> local CLI process defined by project config
```

## API

### Health

- `GET /health`

Response:

```json
{
  "status": "ok",
  "sessions": 1,
  "projects": 3
}
```

### List projects

- `GET /projects`

Response:

```json
{
  "projects": [
    {
      "project_id": "claude-dev",
      "root_fs": "/root",
      "bind_dirs": ["/tmp"],
      "cmd": "/usr/bin/claude"
    }
  ]
}
```

### Create session

- `POST /projects/{id}/session`

Response:

```json
{
  "session_id": "abcd1234",
  "project_id": "claude-dev"
}
```

### Session WebSocket

- `GET /session/{id}/ws`

Client message:

```json
{
  "type": "input",
  "content": "help\n"
}
```

Server message:

```json
{
  "type": "output",
  "content": "..."
}
```

Completion message:

```json
{
  "type": "done"
}
```

### Destroy session

- `DELETE /session/{id}`

Response:

```json
{
  "status": "destroyed",
  "session_id": "abcd1234"
}
```

## Configuration

- `PORT`
  - HTTP listen port
  - default: `3001`
- `SANDBOX_ROOT`
  - session temp directory root
  - default: `/tmp/cc-sandbox`
- `WEB_DIST_DIR`
  - directory containing built frontend assets
  - default:
    - `/app/web-dist` in container
    - `/root/.openclaw/workspace/sparky-web/web/dist` in local workspace
- `PROJECT_CONFIG_DIR`
  - directory containing `projects.json` or `projects.toml`
- `SPARKY_BWRAP_UNSHARE_USER`
  - reserved sandbox flag

## Repository Notes

- Active Rust code lives in `src/`
- Frontend source lives in `web/`
- Legacy Go/Python code lives in `legacy/`
