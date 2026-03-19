# cc-rust-server API Reference

**Authentication:** All `/api/**` routes require an API token. The server currently accepts either of these headers:

```http
Authorization: Bearer <token>
```

or

```http
x-api-key: <token>
```

`/health` does not require authentication.

---

## Projects

### List Projects

```http
GET /api/projects
```

**Response 200:**
```json
[
  {
    "id": 1,
    "name": "MyProject",
    "path": "/root/project",
    "hooks_installed": false,
    "agent_teams_enabled": false,
    "created_at": 1742370270,
    "updated_at": 1742370270,
    "default_provider_id": null
  }
]
```

---

### Create Project

```http
POST /api/projects
Content-Type: application/json
```

**Request:**
```json
{
  "name": "MyProject",
  "path": "/root/project"
}
```

**Response 200:**
```json
{
  "id": 1,
  "name": "MyProject",
  "path": "/root/project",
  "hooks_installed": false,
  "agent_teams_enabled": false,
  "created_at": 1742370270,
  "updated_at": 1742370270,
  "default_provider_id": null
}
```

If the token is scoped to specific projects, create/delete project operations return `403 Forbidden`.

---

### Delete Project

```http
DELETE /api/projects/:id
```

**Response 200:**
```json
{}
```

---

### Get Project Detail

```http
GET /api/projects/:id/detail
```

**Response 200:**
```json
{
  "project": {
    "id": 1,
    "name": "MyProject",
    "path": "/root/project",
    "hooks_installed": false,
    "agent_teams_enabled": false,
    "created_at": 1742370270,
    "updated_at": 1742370270,
    "default_provider_id": null
  },
  "sessions": [
    {
      "id": 1,
      "session_id": "session-uuid",
      "project_path": "/root/project",
      "started_at": 1742370270,
      "ended_at": null,
      "reason": null,
      "name": "Debug session",
      "project_name": "MyProject"
    }
  ],
  "terminal_history": [
    "$ pwd",
    "/root/project"
  ]
}
```

**Response 404:**
```json
"PROJECT_NOT_FOUND"
```

---

## Sessions

### List Sessions

```http
GET /api/sessions?project_id=1
```

**Response 200:**
```json
[
  {
    "id": 1,
    "session_id": "session-uuid",
    "project_path": "/root/project",
    "started_at": 1742370270,
    "ended_at": null,
    "reason": null,
    "name": "Debug session",
    "project_name": "MyProject"
  }
]
```

---

### Rename Session

```http
POST /api/sessions/:id/rename
Content-Type: application/json
```

**Request:**
```json
{
  "project_id": "1",
  "name": "New Name"
}
```

**Response 200:**
```json
{}
```

---

### Delete Session

```http
POST /api/sessions/:id/delete
Content-Type: application/json
```

**Request:**
```json
{
  "project_id": "1"
}
```

**Response 200:**
```json
{}
```

---

### Resume Session

```http
POST /api/sessions/:id/resume
Content-Type: application/json
```

**Request:**
```json
{
  "project_id": "1"
}
```

**Response 200:**
```json
{}
```

This endpoint forwards a `sessions.resume` request to the connected agent for the token's `agent_id`.

---

## Terminal

### Execute Command

```http
POST /api/terminal/exec
Content-Type: application/json
```

**Request:**
```json
{
  "project_id": "1",
  "command": "ls -la\n"
}
```

**Response 200:**
```json
{}
```

This endpoint forwards a `terminal.exec` request to the connected agent for the token's `agent_id`.

---

### Terminal History

```http
GET /api/terminal/history?project_id=1
```

**Response 200:**
```json
[
  "$ pwd",
  "/root/project"
]
```

---

## Providers

### List Providers

```http
GET /api/providers
```

**Response 200:**
```json
[
  {
    "id": "provider-uuid",
    "app_type": "openai",
    "name": "OpenAI",
    "settings_config": "{}",
    "website_url": null,
    "category": null,
    "created_at": 1742370270,
    "sort_index": 0,
    "notes": null,
    "icon": null,
    "icon_color": null,
    "meta": "{}",
    "is_current": false,
    "in_failover_queue": false,
    "cost_multiplier": "1",
    "limit_daily_usd": null,
    "limit_monthly_usd": null,
    "provider_type": null,
    "endpoints": []
  }
]
```

---

### Save Provider

```http
POST /api/providers
Content-Type: application/json
```

**Request:** full `AIProvider` object.

**Response 200:**
```json
{ "id": "provider-uuid" }
```

---

### Delete Provider

```http
DELETE /api/providers/:app_type/:id
```

**Response 200:**
```json
{}
```

---

## Hooks

### List Hooks

```http
GET /api/hooks?project_id=1&page=1&page_size=20
```

**Response 200:**
```json
{
  "records": [
    {
      "id": 1,
      "event_name": "pre-command",
      "session_id": "session-uuid",
      "notification_text": "Claude hook notification",
      "transcript_path": "/tmp/transcript.jsonl",
      "content": "payload",
      "result": "ok",
      "created_at": 1742370270
    }
  ],
  "total": 1,
  "page": 1,
  "page_size": 20
}
```

---

### Delete Hook

```http
DELETE /api/hooks/:id?project_id=1
```

**Response 200:**
```json
{}
```

---

### Batch Delete Hooks

```http
POST /api/hooks/batch-delete
Content-Type: application/json
```

**Request:**
```json
{
  "project_id": "1",
  "ids": [1, 2]
}
```

**Response 200:**
```json
{}
```

---

## WebIDE

### Summary

```http
GET /api/web-ide/summary
```

**Response 200:**
```json
{
  "projects": [
    {
      "project_id": "1",
      "project_path": "/root/project",
      "project_name": "MyProject",
      "active_pty_count": 1,
      "agent_id": "agent-alpha"
    }
  ]
}
```

---

### WebIDE Events (SSE)

```http
GET /api/web-ide/events
```

SSE event name:

```text
web_ide_event
```

**Event data example:**
```json
{
  "event_type": "pty_active_changed",
  "agent_id": "agent-alpha",
  "project": {
    "project_id": "1",
    "project_path": "/root/project",
    "project_name": "MyProject",
    "active_pty_count": 1,
    "agent_id": "agent-alpha"
  }
}
```

---

## Events

### Event Stream (SSE)

```http
GET /api/events?project_id=1
```

SSE event name:

```text
project_event
```

**Event data shape:**
```json
{
  "project_id": "1",
  "event_type": "terminal_output_chunk",
  "payload": {
    "terminal_id": "web-1",
    "data": "hello\n"
  }
}
```

Known event types currently consumed by the web UI:
- `terminal_output_chunk`
- `terminal_exit`

---

## Config

### Get Config

```http
GET /api/config
```

**Response 200:**
```json
{
  "app_id": "",
  "app_secret": "",
  "app_name": null,
  "encrypt_key": null,
  "verification_token": null,
  "chat_id": null,
  "project_path": null,
  "open_id": null,
  "hook_events_filter": null,
  "anthropic_logo_img_key": null,
  "terminal_bg_color": null,
  "terminal_fg_color": null,
  "terminal_font_size": null,
  "default_provider_id": null
}
```

---

### Save Config

```http
POST /api/config
Content-Type: application/json
```

**Request:** full `AppConfig` object.

**Response 200:**
```json
{}
```

---

## Health

### Health Check

```http
GET /health
```

No auth required.

**Response 200:**
```json
{ "status": "ok" }
```

---

## Error Responses

Errors are currently returned as plain strings by many handlers, for example:

```json
"PROJECT_NOT_FOUND"
```

or HTTP error text such as:

```json
"Forbidden"
```

Common statuses:

| HTTP Status | Meaning |
|-------------|---------|
| 400 | Bad Request |
| 401 | Unauthorized (missing or invalid token) |
| 403 | Forbidden |
| 404 | Not Found |
| 500 | Internal Server Error |
| 503 | Agent offline / service unavailable |
| 504 | Agent timeout |
