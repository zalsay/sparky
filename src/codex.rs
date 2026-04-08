use crate::project::Project;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{PgPool, Row};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone, Serialize)]
pub struct CodexSessionSummary {
    pub session_id: String,
    pub title: String,
    pub cwd: String,
    pub rollout_path: String,
    pub updated_at_ms: u64,
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

    Ok(())
}

pub async fn upsert_sessions(
    pool: &PgPool,
    user_id: &str,
    project_id: &str,
    sessions: &[DiscoveredCodexSession],
) -> Result<(), String> {
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
        .map_err(|error| format!("upsert bridge_codex_sessions: {}", error))?;
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
