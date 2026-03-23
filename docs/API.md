# cc-rust-server API Reference

**Base URL:** `https://i.meetlife.com.cn:3010`

**Authentication:** Bearer token (JWT) in `Authorization` header, except for auth endpoints.

---

## Auth

All auth endpoints are **public** (no token required).

### Register

```
POST /api/auth/register
```

**Request:**
```json
{
  "username": "alice",
  "password": "secret123",
  "display_name": "Alice",
  "email": "alice@example.com"   // optional
}
```

**Response 200:**
```json
{
  "user": {
    "id": "692eab3d-d711-4028-90f9-4414a0e8f9ab",
    "username": "alice",
    "display_name": "Alice",
    "email": null
  },
  "access_token": "eyJ...",
  "refresh_token": "eyJ...",
  "expires_in": 3600
}
```

---

### Login

```
POST /api/auth/login
```

**Request:**
```json
{
  "username": "alice",
  "password": "secret123"
}
```

**Response 200:**
```json
{
  "user": { "id": "...", "username": "alice", "display_name": "Alice", "email": null },
  "access_token": "eyJ...",
  "refresh_token": "eyJ...",
  "expires_in": 3600
}
```

---

### Refresh Token

```
POST /api/auth/refresh
```

**Request:**
```json
{
  "refresh_token": "eyJ..."
}
```

**Response 200:**
```json
{
  "access_token": "eyJ...",
  "expires_in": 3600
}
```

---

### Logout

```
POST /api/auth/logout
```

**Request:**
```json
{
  "refresh_token": "eyJ..."
}
```

**Response 200:**
```json
{ "status": "ok" }
```

---

## Authenticated Endpoints

All routes under `/api/**` (except `/api/auth/*`) require:

```
Authorization: Bearer <access_token>
```

---

### Get Current User

```
GET /api/me
```

**Response 200:**
```json
{
  "id": "692eab3d-d711-4028-90f9-4414a0e8f9ab",
  "username": "alice",
  "display_name": "Alice",
  "email": null
}
```

---

## Projects

### List Projects

```
GET /api/projects
```

**Response 200:**
```json
[
  {
    "id": 1,
    "name": "MyProject",
    "path": "/root/project",
    "hooks_enabled": false,
    "created_at": "2026-03-19T07:44:30.098947Z"
  }
]
```

---

### Create Project

```
POST /api/projects
```

**Request:**
```json
{
  "name": "MyProject",
  "path": "/root/project"
}
```

**Response 201:**
```json
{
  "id": 1,
  "name": "MyProject",
  "path": "/root/project"
}
```

---

### Update Project

```
PATCH /api/projects/:id
```

**Request:**
```json
{
  "name": "New Name",
  "description": "Updated description",
  "hooks_enabled": true
}
```

All fields optional. Only `owner`/`admin` can update.

**Response 200:**
```json
{ "status": "updated" }
```

---

### Delete Project

```
DELETE /api/projects/:id
```

Only `owner` role can delete. Performs soft delete.

**Response 200:**
```json
{ "status": "deleted" }
```

---

### Get Project Detail

```
GET /api/projects/:id/detail
```

Returns project info with full member list.

**Response 200:**
```json
{
  "id": 1,
  "name": "MyProject",
  "description": null,
  "created_at": "2026-03-19T07:44:30.098947Z",
  "members": [
    { "username": "alice", "role": "owner", "user_id": "...", "joined_at": "2026-03-19 07:44:30.098947" }
  ]
}
```

---

## Project Members

### List Members

```
GET /api/projects/:id/members
```

**Response 200:**
```json
[
  { "username": "alice", "role": "owner", "user_id": "..." }
]
```

---

### Add Member

```
POST /api/projects/:id/members
```

Only `owner`/`admin` can add.

**Request:**
```json
{
  "user_id": "user-uuid",
  "role": "member"
}
```

**Response 201:**
```json
{ "status": "added" }
```

---

### Update Member Role

```
PATCH /api/projects/:id/members/:user_id
```

Only `owner`/`admin` can update.

**Request:**
```json
{ "role": "admin" }
```

**Response 200:**
```json
{ "status": "updated" }
```

---

### Remove Member

```
DELETE /api/projects/:id/members/:user_id
```

Only `owner`/`admin` can remove. Cannot remove self.

**Response 200:**
```json
{ "status": "removed" }
```

---

## Providers

### List Providers

```
GET /api/providers
```

**Response 200:**
```json
[
  {
    "id": "provider-uuid",
    "name": "OpenAI",
    "app_type": "openai",
    "scope_type": "user"
  }
]
```

---

### Create Provider

```
POST /api/providers
```

**Request:**
```json
{
  "name": "OpenAI",
  "app_type": "openai",
  "api_type": "openai"
}
```

**Response 201:**
```json
{ "id": "...", "name": "OpenAI", "app_type": "openai" }
```

---

### Delete Provider

```
DELETE /api/providers/:id
```

**Response 200:**
```json
{ "status": "deleted" }
```

---

## Sessions

### List Sessions

```
GET /api/sessions?project_id=1
```

**Response 200:**
```json
[
  {
    "id": "session-uuid",
    "project_id": 1,
    "name": "Debug session",
    "status": "active"
  }
]
```

---

### Rename Session

```
POST /api/sessions/:id/rename
```

**Request:**
```json
{ "name": "New Name" }
```

**Response 200:**
```json
{ "status": "renamed" }
```

---

### Delete Session

```
POST /api/sessions/:id/delete
```

**Request:**
```json
{ "project_id": 1 }
```

**Response 200:**
```json
{ "status": "deleted" }
```

---

### Resume Session

```
POST /api/sessions/:id/resume
```

**Request:**
```json
{ "project_id": 1 }
```

**Response 200:**
```json
{ "session_id": "...", "status": "resumed" }
```

---

## Terminal

### Execute Command

```
POST /api/terminal/exec
```

**Request:**
```json
{ "session_id": "session-uuid", "command": "ls -la" }
```

**Response 200:**
```json
{
  "stdout": "total 64\ndrwxr-xr-x  5 root root 4096 Mar 19 07:44 ...",
  "stderr": "",
  "exit_code": 0
}
```

---

### Terminal History

```
GET /api/terminal/history?project_id=1&page=1&page_size=20
```

**Response 200:**
```json
[
  {
    "id": "log-uuid",
    "session_id": "session-uuid",
    "direction": "out",
    "content": "ls -la",
    "created_at": "2026-03-19T07:45:00Z"
  }
]
```

---

## Hooks

### List Hooks

```
GET /api/hooks?project_id=1&page=1&page_size=20
```

**Response 200:**
```json
[
  {
    "id": "hook-uuid",
    "hook_type": "pre-deploy",
    "name": "Lint check",
    "description": "Run linter before deploy",
    "created_at": "2026-03-19T07:45:00Z"
  }
]
```

---

### Delete Hook

```
DELETE /api/hooks/:id?project_id=1
```

**Response 200:**
```json
{ "status": "deleted" }
```

---

### Batch Delete Hooks

```
POST /api/hooks/batch-delete
```

**Request:**
```json
{
  "ids": ["hook-uuid-1", "hook-uuid-2"],
  "project_id": 1
}
```

**Response 200:**
```json
{ "deleted": 2 }
```

---

## WebIDE

### Summary

```
GET /api/web-ide/summary
```

**Response 200:**
```json
{ "active_instances": 0 }
```

---

### WebIDE Events (SSE)

```
GET /api/web-ide/events
```

Returns Server-Sent Events stream for WebIDE activity.

---

### Project WebIDE Status

```
GET /api/projects/:id/web-ide/status
```

**Response 200:**
```json
{ "status": "stopped", "instance_id": null }
```

---

### Start WebIDE

```
POST /api/projects/:id/web-ide/start
```

**Response 200:**
```json
{ "instance_id": "...", "status": "starting" }
```

---

## Events

### Event Stream (SSE)

```
GET /api/events
```

Returns Server-Sent Events stream for real-time events.

---

## Config

### Get Config

```
GET /api/config
```

**Response 200:**
```json
{
  "key": "hook.default_timeout",
  "value": "300"
}
```

---

### Set Config

```
POST /api/config
```

**Request:**
```json
{
  "key": "hook.default_timeout",
  "value": "300"
}
```

**Response 200:**
```json
{ "status": "saved" }
```

---

## Internal (No Auth)

### Agent Connect

```
POST /internal/agents/connect
```

**Request:**
```json
{
  "node_id": "node-alpha",
  "name": "Alpha Node",
  "capabilities": ["exec", "file-access"]
}
```

**Response 200:**
```json
{ "status": "connected" }
```

---

### Agent Heartbeat

```
POST /internal/agents/:id/heartbeat
```

**Request:**
```json
{ "status": "online" }
```

**Response 200:**
```json
{ "status": "ok" }
```

---

## Health

### Health Check

```
GET /health
```

No auth required.

**Response 200:**
```json
{ "status": "ok" }
```

---

## Error Responses

All errors follow this format:

```json
{ "error": "description of the error" }
```

| HTTP Status | Meaning |
|-------------|---------|
| 400 | Bad Request |
| 401 | Unauthorized (missing or invalid token) |
| 403 | Forbidden (insufficient permissions) |
| 404 | Not Found |
| 409 | Conflict (e.g. username already exists) |
| 500 | Internal Server Error |
