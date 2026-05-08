use crate::project::Project;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{PgPool, Row};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexSessionSummary {
    pub session_id: String,
    pub title: String,
    pub cwd: String,
    pub rollout_path: String,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexLiveSessionSummary {
    pub session_id: String,
    #[serde(default)]
    pub codex_session_id: String,
    pub cwd: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexSessionsResponse {
    pub live_sessions: Vec<CodexLiveSessionSummary>,
    pub history_sessions: Vec<CodexSessionSummary>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CodexTimelineItem {
    pub id: String,
    pub session_id: String,
    pub kind: String,
    pub timestamp: String,
    pub group_id: String,
    pub title: String,
    pub text: String,
    pub meta: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct CodexTimelineResponse {
    pub session_id: String,
    pub title: String,
    pub updated_at_ms: u64,
    pub items: Vec<CodexTimelineItem>,
}

#[derive(Debug, Clone)]
pub struct DiscoveredCodexSession {
    pub session_id: String,
    pub title: String,
    pub cwd: String,
    pub rollout_path: String,
    pub updated_at_ms: u64,
}

impl From<DiscoveredCodexSession> for CodexSessionSummary {
    fn from(value: DiscoveredCodexSession) -> Self {
        Self {
            session_id: value.session_id,
            title: value.title,
            cwd: value.cwd,
            rollout_path: value.rollout_path,
            updated_at_ms: value.updated_at_ms,
        }
    }
}

#[derive(Debug, Deserialize)]
struct CodexHistoryEntry {
    session_id: String,
    ts: i64,
    text: String,
}

#[derive(Debug, Default, Clone)]
struct HistorySummary {
    first_text: Option<String>,
    latest_ts: Option<i64>,
}

#[derive(Debug)]
struct RolloutMeta {
    session_id: String,
    cwd: String,
}

#[derive(Debug, Default)]
struct TimelineDraft {
    kind: &'static str,
    title: String,
    text: String,
    group_id: String,
    meta: Value,
}

pub async fn init_schema(pool: &PgPool) -> Result<(), String> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS bridge_codex_sessions (
            user_id VARCHAR(64) NOT NULL REFERENCES bridge_users(id) ON DELETE CASCADE,
            project_id VARCHAR(128) NOT NULL,
            codex_session_id VARCHAR(128) NOT NULL,
            title TEXT NOT NULL,
            cwd TEXT NOT NULL,
            rollout_path TEXT NOT NULL,
            updated_at_ms BIGINT NOT NULL,
            synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (user_id, project_id, codex_session_id)
        )
        "#,
    )
    .execute(pool)
    .await
    .map_err(|error| format!("create bridge_codex_sessions: {}", error))?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS bridge_codex_live_sessions (
            user_id VARCHAR(64) NOT NULL REFERENCES bridge_users(id) ON DELETE CASCADE,
            project_id VARCHAR(128) NOT NULL,
            session_id VARCHAR(128) NOT NULL,
            cwd TEXT NOT NULL,
            created_at_ms BIGINT NOT NULL,
            updated_at_ms BIGINT NOT NULL,
            synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (user_id, project_id, session_id)
        )
        "#,
    )
    .execute(pool)
    .await
    .map_err(|error| format!("create bridge_codex_live_sessions: {}", error))?;

    sqlx::query(
        r#"
        ALTER TABLE bridge_codex_live_sessions
        ADD COLUMN IF NOT EXISTS codex_session_id VARCHAR(128) NOT NULL DEFAULT ''
        "#,
    )
    .execute(pool)
    .await
    .map_err(|error| {
        format!(
            "alter bridge_codex_live_sessions add codex_session_id: {}",
            error
        )
    })?;

    Ok(())
}

pub async fn replace_sessions(
    pool: &PgPool,
    user_id: &str,
    project_id: &str,
    sessions: &[DiscoveredCodexSession],
) -> Result<(), String> {
    sqlx::query(
        r#"
        DELETE FROM bridge_codex_sessions
        WHERE user_id = $1 AND project_id = $2
        "#,
    )
    .bind(user_id)
    .bind(project_id)
    .execute(pool)
    .await
    .map_err(|error| format!("clear bridge_codex_sessions: {}", error))?;

    for session in sessions {
        sqlx::query(
            r#"
            INSERT INTO bridge_codex_sessions (
                user_id,
                project_id,
                codex_session_id,
                title,
                cwd,
                rollout_path,
                updated_at_ms,
                synced_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
            ON CONFLICT (user_id, project_id, codex_session_id)
            DO UPDATE SET
                title = EXCLUDED.title,
                cwd = EXCLUDED.cwd,
                rollout_path = EXCLUDED.rollout_path,
                updated_at_ms = EXCLUDED.updated_at_ms,
                synced_at = NOW()
            "#,
        )
        .bind(user_id)
        .bind(project_id)
        .bind(&session.session_id)
        .bind(&session.title)
        .bind(&session.cwd)
        .bind(&session.rollout_path)
        .bind(session.updated_at_ms as i64)
        .execute(pool)
        .await
        .map_err(|error| format!("insert bridge_codex_sessions: {}", error))?;
    }

    Ok(())
}

pub async fn list_sessions(
    pool: &PgPool,
    user_id: &str,
    project_id: &str,
) -> Result<Vec<CodexSessionSummary>, String> {
    let rows = sqlx::query(
        r#"
        SELECT codex_session_id, title, cwd, rollout_path, updated_at_ms
        FROM bridge_codex_sessions
        WHERE user_id = $1 AND project_id = $2
        ORDER BY updated_at_ms DESC, codex_session_id DESC
        "#,
    )
    .bind(user_id)
    .bind(project_id)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("list bridge_codex_sessions: {}", error))?;

    rows.into_iter()
        .map(|row| {
            Ok(CodexSessionSummary {
                session_id: row
                    .try_get("codex_session_id")
                    .map_err(|error| format!("read codex_session_id: {}", error))?,
                title: row
                    .try_get("title")
                    .map_err(|error| format!("read title: {}", error))?,
                cwd: row
                    .try_get("cwd")
                    .map_err(|error| format!("read cwd: {}", error))?,
                rollout_path: row
                    .try_get("rollout_path")
                    .map_err(|error| format!("read rollout_path: {}", error))?,
                updated_at_ms: row
                    .try_get::<i64, _>("updated_at_ms")
                    .map_err(|error| format!("read updated_at_ms: {}", error))?
                    .max(0) as u64,
            })
        })
        .collect()
}

pub async fn replace_live_sessions(
    pool: &PgPool,
    user_id: &str,
    project_id: &str,
    sessions: &[CodexLiveSessionSummary],
) -> Result<(), String> {
    sqlx::query(
        r#"
        DELETE FROM bridge_codex_live_sessions
        WHERE user_id = $1 AND project_id = $2
        "#,
    )
    .bind(user_id)
    .bind(project_id)
    .execute(pool)
    .await
    .map_err(|error| format!("clear bridge_codex_live_sessions: {}", error))?;

    for session in sessions {
        sqlx::query(
            r#"
            INSERT INTO bridge_codex_live_sessions (
                user_id,
                project_id,
                session_id,
                codex_session_id,
                cwd,
                created_at_ms,
                updated_at_ms,
                synced_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
            ON CONFLICT (user_id, project_id, session_id)
            DO UPDATE SET
                codex_session_id = EXCLUDED.codex_session_id,
                cwd = EXCLUDED.cwd,
                created_at_ms = EXCLUDED.created_at_ms,
                updated_at_ms = EXCLUDED.updated_at_ms,
                synced_at = NOW()
            "#,
        )
        .bind(user_id)
        .bind(project_id)
        .bind(&session.session_id)
        .bind(&session.codex_session_id)
        .bind(&session.cwd)
        .bind(session.created_at_ms as i64)
        .bind(session.updated_at_ms as i64)
        .execute(pool)
        .await
        .map_err(|error| format!("insert bridge_codex_live_sessions: {}", error))?;
    }

    Ok(())
}

pub async fn upsert_live_session(
    pool: &PgPool,
    user_id: &str,
    project_id: &str,
    session: &CodexLiveSessionSummary,
) -> Result<(), String> {
    sqlx::query(
        r#"
        INSERT INTO bridge_codex_live_sessions (
            user_id,
            project_id,
            session_id,
            codex_session_id,
            cwd,
            created_at_ms,
            updated_at_ms,
            synced_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        ON CONFLICT (user_id, project_id, session_id)
        DO UPDATE SET
            codex_session_id = EXCLUDED.codex_session_id,
            cwd = EXCLUDED.cwd,
            created_at_ms = EXCLUDED.created_at_ms,
            updated_at_ms = EXCLUDED.updated_at_ms,
            synced_at = NOW()
        "#,
    )
    .bind(user_id)
    .bind(project_id)
    .bind(&session.session_id)
    .bind(&session.codex_session_id)
    .bind(&session.cwd)
    .bind(session.created_at_ms as i64)
    .bind(session.updated_at_ms as i64)
    .execute(pool)
    .await
    .map_err(|error| format!("upsert bridge_codex_live_sessions: {}", error))?;

    Ok(())
}

pub async fn remove_live_session(
    pool: &PgPool,
    user_id: &str,
    project_id: &str,
    session_id: &str,
) -> Result<(), String> {
    sqlx::query(
        r#"
        DELETE FROM bridge_codex_live_sessions
        WHERE user_id = $1 AND project_id = $2 AND session_id = $3
        "#,
    )
    .bind(user_id)
    .bind(project_id)
    .bind(session_id)
    .execute(pool)
    .await
    .map_err(|error| format!("delete bridge_codex_live_sessions: {}", error))?;

    Ok(())
}

pub async fn clear_live_sessions_for_project(
    pool: &PgPool,
    user_id: &str,
    project_id: &str,
) -> Result<(), String> {
    sqlx::query(
        r#"
        DELETE FROM bridge_codex_live_sessions
        WHERE user_id = $1 AND project_id = $2
        "#,
    )
    .bind(user_id)
    .bind(project_id)
    .execute(pool)
    .await
    .map_err(|error| format!("clear project bridge_codex_live_sessions: {}", error))?;

    Ok(())
}

pub async fn list_live_sessions(
    pool: &PgPool,
    user_id: &str,
    project_id: &str,
) -> Result<Vec<CodexLiveSessionSummary>, String> {
    let rows = sqlx::query(
        r#"
        SELECT session_id, codex_session_id, cwd, created_at_ms, updated_at_ms
        FROM bridge_codex_live_sessions
        WHERE user_id = $1 AND project_id = $2
        ORDER BY updated_at_ms DESC, session_id DESC
        "#,
    )
    .bind(user_id)
    .bind(project_id)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("list bridge_codex_live_sessions: {}", error))?;

    rows.into_iter()
        .map(|row| {
            Ok(CodexLiveSessionSummary {
                session_id: row
                    .try_get("session_id")
                    .map_err(|error| format!("read live session_id: {}", error))?,
                codex_session_id: row
                    .try_get("codex_session_id")
                    .map_err(|error| format!("read live codex_session_id: {}", error))?,
                cwd: row
                    .try_get("cwd")
                    .map_err(|error| format!("read live cwd: {}", error))?,
                created_at_ms: row
                    .try_get::<i64, _>("created_at_ms")
                    .map_err(|error| format!("read live created_at_ms: {}", error))?
                    .max(0) as u64,
                updated_at_ms: row
                    .try_get::<i64, _>("updated_at_ms")
                    .map_err(|error| format!("read live updated_at_ms: {}", error))?
                    .max(0) as u64,
            })
        })
        .collect()
}

pub fn discover_project_sessions(
    project: &Project,
    project_root: &Path,
) -> Result<Vec<DiscoveredCodexSession>, String> {
    let codex_home = resolve_codex_home(project);
    let sessions_root = codex_home.join("sessions");
    if !sessions_root.exists() {
        return Ok(Vec::new());
    }

    let history = read_history_map(&codex_home.join("history.jsonl"));
    let match_roots = candidate_match_roots(project, project_root);
    let mut discovered = Vec::new();

    collect_rollout_files(&sessions_root, &mut Vec::new(), &mut |path| {
        let Some(meta) = read_rollout_meta(path.as_path()) else {
            return;
        };
        let session_cwd = normalize_existing_path(Path::new(&meta.cwd));
        if !matches_project_roots(session_cwd.as_path(), &match_roots) {
            return;
        }

        let history_summary = history.get(&meta.session_id);
        let title = history_summary
            .and_then(|entry| entry.first_text.clone())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| fallback_title(session_cwd.as_path()));
        let updated_at_ms = updated_at_ms(
            path.as_path(),
            history_summary.and_then(|entry| entry.latest_ts),
        );

        discovered.push(DiscoveredCodexSession {
            session_id: meta.session_id,
            title,
            cwd: session_cwd.display().to_string(),
            rollout_path: path.display().to_string(),
            updated_at_ms,
        });
    })?;

    discovered.sort_by(|left, right| {
        right
            .updated_at_ms
            .cmp(&left.updated_at_ms)
            .then_with(|| left.session_id.cmp(&right.session_id))
    });
    discovered.dedup_by(|left, right| left.session_id == right.session_id);

    Ok(discovered)
}

pub fn read_timeline(session: &CodexSessionSummary) -> Result<CodexTimelineResponse, String> {
    let file = fs::File::open(&session.rollout_path)
        .map_err(|error| format!("open codex rollout {}: {}", session.rollout_path, error))?;
    let reader = BufReader::new(file);
    let mut items = Vec::new();

    for (index, line) in reader.lines().map_while(Result::ok).enumerate() {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };

        let timestamp = value
            .get("timestamp")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();

        let Some(item_type) = value.get("type").and_then(Value::as_str) else {
            continue;
        };

        let draft = match item_type {
            "session_meta" => parse_session_meta(&value),
            "event_msg" => parse_event_msg(&value),
            "response_item" => parse_response_item(&value),
            _ => None,
        };

        let Some(draft) = draft else {
            continue;
        };

        let next_item = CodexTimelineItem {
            id: format!("{}-{}", session.session_id, index),
            session_id: session.session_id.clone(),
            kind: draft.kind.to_string(),
            timestamp,
            group_id: draft.group_id,
            title: draft.title,
            text: draft.text,
            meta: draft.meta,
        };

        if should_skip_timeline_item(&items, &next_item) {
            continue;
        }

        items.push(next_item);
    }

    Ok(CodexTimelineResponse {
        session_id: session.session_id.clone(),
        title: session.title.clone(),
        updated_at_ms: session.updated_at_ms,
        items,
    })
}

fn should_skip_timeline_item(items: &[CodexTimelineItem], next: &CodexTimelineItem) -> bool {
    let Some(previous) = items.last() else {
        return false;
    };

    if next.kind == "tool_result"
        && !next.group_id.is_empty()
        && items
            .iter()
            .any(|item| item.kind == "tool_result" && item.group_id == next.group_id)
    {
        return true;
    }

    previous.kind == next.kind
        && previous.title == next.title
        && previous.text == next.text
        && previous.timestamp == next.timestamp
}

fn resolve_codex_home(project: &Project) -> PathBuf {
    let env_vars = project.resolved_env_vars();
    if let Some(path) = env_vars
        .get("CODEX_HOME")
        .filter(|value| !value.trim().is_empty())
    {
        return PathBuf::from(path);
    }

    if let Some(path) = std::env::var_os("CODEX_HOME") {
        return PathBuf::from(path);
    }

    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/root"))
        .join(".codex")
}

fn read_history_map(path: &Path) -> HashMap<String, HistorySummary> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return HashMap::new(),
    };

    let reader = BufReader::new(file);
    let mut map = HashMap::new();

    for line in reader.lines().map_while(Result::ok) {
        let Ok(entry) = serde_json::from_str::<CodexHistoryEntry>(&line) else {
            continue;
        };

        let text = first_line(entry.text.trim());
        let session = map
            .entry(entry.session_id)
            .or_insert_with(HistorySummary::default);
        if session.first_text.is_none() && !text.is_empty() {
            session.first_text = Some(text);
        }
        session.latest_ts = Some(session.latest_ts.unwrap_or(entry.ts).max(entry.ts));
    }

    map
}

fn first_line(value: &str) -> String {
    value
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default()
        .chars()
        .take(120)
        .collect()
}

fn candidate_match_roots(project: &Project, project_root: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    roots.push(normalize_existing_path(project_root));

    if let Some(bind_root) = project
        .bind_dirs
        .iter()
        .find(|dir| dir.as_str() != "/tmp" && !dir.trim().is_empty())
    {
        roots.push(normalize_existing_path(Path::new(bind_root)));
    }

    roots.sort();
    roots.dedup();
    roots
}

fn normalize_existing_path(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn matches_project_roots(cwd: &Path, roots: &[PathBuf]) -> bool {
    roots
        .iter()
        .any(|root| cwd.starts_with(root) || root.starts_with(cwd))
}

fn fallback_title(cwd: &Path) -> String {
    cwd.file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| "Codex 会话".to_string())
}

fn parse_session_meta(value: &Value) -> Option<TimelineDraft> {
    let payload = value.get("payload")?;
    let cwd = payload
        .get("cwd")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let cli_version = payload
        .get("cli_version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let text = if cwd.is_empty() {
        "Codex 会话已启动".to_string()
    } else {
        format!("工作目录 {}", cwd)
    };

    Some(TimelineDraft {
        kind: "status",
        title: "会话启动".to_string(),
        text,
        group_id: String::new(),
        meta: serde_json::json!({
            "cwd": cwd,
            "originator": payload.get("originator").and_then(Value::as_str).unwrap_or_default(),
            "cli_version": cli_version,
            "source": payload.get("source").and_then(Value::as_str).unwrap_or_default(),
        }),
    })
}

fn parse_event_msg(value: &Value) -> Option<TimelineDraft> {
    let payload = value.get("payload")?;
    let event_type = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();

    match event_type {
        "agent_message" => {
            let text = payload
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            if text.is_empty() {
                return None;
            }

            Some(TimelineDraft {
                kind: "commentary",
                title: "进度更新".to_string(),
                text,
                group_id: String::new(),
                meta: serde_json::json!({
                    "phase": payload.get("phase").and_then(Value::as_str).unwrap_or_default(),
                }),
            })
        }
        "task_started" => Some(TimelineDraft {
            kind: "status",
            title: "任务开始".to_string(),
            text: "Codex 已开始处理当前请求".to_string(),
            group_id: payload
                .get("turn_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            meta: serde_json::json!({
                "turn_id": payload.get("turn_id").and_then(Value::as_str).unwrap_or_default(),
                "collaboration_mode_kind": payload.get("collaboration_mode_kind").and_then(Value::as_str).unwrap_or_default(),
            }),
        }),
        "exec_command_end" => {
            let call_id = payload
                .get("call_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let command = payload
                .get("command")
                .and_then(Value::as_array)
                .map(|parts| {
                    parts
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .unwrap_or_default();
            let output = payload
                .get("aggregated_output")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let exit_code = payload
                .get("exit_code")
                .and_then(Value::as_i64)
                .unwrap_or(0);

            Some(TimelineDraft {
                kind: "tool_result",
                title: if command.is_empty() {
                    "命令结果".to_string()
                } else {
                    format!("命令完成 · {}", preview_text(&command, 72))
                },
                text: summarize_output(output),
                group_id: call_id.clone(),
                meta: serde_json::json!({
                    "call_id": call_id,
                    "command": command,
                    "exit_code": exit_code,
                    "duration_secs": payload.get("duration").and_then(|value| value.get("secs")).and_then(Value::as_u64).unwrap_or(0),
                    "output_truncated": output.chars().count() > 1200,
                }),
            })
        }
        _ => None,
    }
}

fn parse_response_item(value: &Value) -> Option<TimelineDraft> {
    let payload = value.get("payload")?;
    let response_type = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();

    match response_type {
        "message" => {
            let role = payload
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let phase = payload
                .get("phase")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let text = collect_message_text(payload.get("content"));
            if text.is_empty() {
                return None;
            }

            let kind = match (role, phase) {
                ("assistant", "commentary") => "commentary",
                ("assistant", _) => "assistant",
                ("user", _) => "user",
                _ => return None,
            };

            let title = match kind {
                "user" => "用户".to_string(),
                "assistant" => "Codex".to_string(),
                _ => "进度更新".to_string(),
            };

            Some(TimelineDraft {
                kind,
                title,
                text,
                group_id: String::new(),
                meta: serde_json::json!({
                    "role": role,
                    "phase": phase,
                }),
            })
        }
        "function_call" => {
            let name = payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let call_id = payload
                .get("call_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let arguments = payload
                .get("arguments")
                .and_then(Value::as_str)
                .unwrap_or_default();

            Some(TimelineDraft {
                kind: "tool_call",
                title: if name.is_empty() {
                    "工具调用".to_string()
                } else {
                    format!("调用工具 · {}", name)
                },
                text: summarize_tool_call(name, arguments),
                group_id: call_id.clone(),
                meta: serde_json::json!({
                    "call_id": call_id,
                    "tool_name": name,
                    "arguments": preview_text(arguments, 600),
                }),
            })
        }
        "function_call_output" => {
            let call_id = payload
                .get("call_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let output = payload
                .get("output")
                .and_then(Value::as_str)
                .unwrap_or_default();

            Some(TimelineDraft {
                kind: "tool_result",
                title: "工具结果".to_string(),
                text: summarize_output(output),
                group_id: call_id.clone(),
                meta: serde_json::json!({
                    "call_id": call_id,
                    "output_truncated": output.chars().count() > 1200,
                }),
            })
        }
        "reasoning" => {
            let text = payload
                .get("summary")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| {
                            item.get("text")
                                .and_then(Value::as_str)
                                .or_else(|| item.as_str())
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default();

            Some(TimelineDraft {
                kind: "reasoning",
                title: "思考中".to_string(),
                text: if text.is_empty() {
                    "Codex 正在组织推理过程".to_string()
                } else {
                    text
                },
                group_id: String::new(),
                meta: serde_json::json!({
                    "has_encrypted_content": payload.get("encrypted_content").is_some(),
                }),
            })
        }
        _ => None,
    }
}

fn collect_message_text(content: Option<&Value>) -> String {
    let Some(content) = content else {
        return String::new();
    };

    match content {
        Value::String(text) => text.trim().to_string(),
        Value::Array(items) => items
            .iter()
            .filter_map(extract_text_fragment)
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n"),
        Value::Object(_) => extract_text_fragment(content).unwrap_or_default(),
        _ => String::new(),
    }
}

fn extract_text_fragment(value: &Value) -> Option<String> {
    if let Some(text) = value.get("text").and_then(Value::as_str) {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    if let Some(text) = value.get("output_text").and_then(Value::as_str) {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    if let Some(text) = value.get("input_text").and_then(Value::as_str) {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToString::to_string)
}

fn summarize_tool_call(name: &str, arguments: &str) -> String {
    if name == "exec_command" {
        if let Ok(value) = serde_json::from_str::<Value>(arguments) {
            if let Some(command) = value.get("cmd").and_then(Value::as_str) {
                return preview_text(command, 200);
            }
        }
    }

    preview_text(arguments, 200)
}

fn summarize_output(output: &str) -> String {
    let trimmed = output.trim();
    if trimmed.is_empty() {
        return "无输出".to_string();
    }

    preview_text(trimmed, 1200)
}

fn preview_text(value: &str, max_chars: usize) -> String {
    let trimmed = value.trim();
    let mut result = String::new();

    for (index, ch) in trimmed.chars().enumerate() {
        if index >= max_chars {
            result.push('…');
            break;
        }
        result.push(ch);
    }

    result
}

fn updated_at_ms(rollout_path: &Path, history_ts: Option<i64>) -> u64 {
    let file_ms = fs::metadata(rollout_path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);

    let history_ms = history_ts.unwrap_or(0).max(0) as u64 * 1000;
    file_ms.max(history_ms)
}

fn read_rollout_meta(path: &Path) -> Option<RolloutMeta> {
    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);

    for line in reader.lines().map_while(Result::ok).take(16) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };

        if value.get("type").and_then(Value::as_str) != Some("session_meta") {
            continue;
        }

        let payload = value.get("payload")?;
        let session_id = payload
            .get("id")
            .and_then(Value::as_str)?
            .trim()
            .to_string();
        let cwd = payload
            .get("cwd")
            .and_then(Value::as_str)?
            .trim()
            .to_string();
        if session_id.is_empty() || cwd.is_empty() {
            return None;
        }

        return Some(RolloutMeta { session_id, cwd });
    }

    None
}

fn collect_rollout_files(
    root: &Path,
    stack: &mut Vec<PathBuf>,
    callback: &mut impl FnMut(PathBuf),
) -> Result<(), String> {
    stack.push(root.to_path_buf());

    while let Some(dir) = stack.pop() {
        let entries = fs::read_dir(&dir)
            .map_err(|error| format!("read codex sessions dir {}: {}", dir.display(), error))?;

        for entry in entries {
            let entry = entry.map_err(|error| {
                format!("read codex sessions entry {}: {}", dir.display(), error)
            })?;
            let path = entry.path();
            let file_type = entry
                .file_type()
                .map_err(|error| format!("inspect codex path {}: {}", path.display(), error))?;

            if file_type.is_dir() {
                stack.push(path);
                continue;
            }

            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };

            if name.starts_with("rollout-") && name.ends_with(".jsonl") {
                callback(path);
            }
        }
    }

    Ok(())
}
