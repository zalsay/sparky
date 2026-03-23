use std::{fs, path::Path};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppConfig {
    #[serde(default)]
    pub app_id: String,
    #[serde(default)]
    pub app_secret: String,
    pub app_name: Option<String>,
    pub encrypt_key: Option<String>,
    pub verification_token: Option<String>,
    pub chat_id: Option<String>,
    pub project_path: Option<String>,
    pub open_id: Option<String>,
    pub hook_events_filter: Option<String>,
    pub anthropic_logo_img_key: Option<String>,
    pub terminal_bg_color: Option<String>,
    pub terminal_fg_color: Option<String>,
    pub terminal_font_size: Option<i32>,
    pub default_provider_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AIProvider {
    pub id: String,
    pub app_type: String,
    pub name: String,
    pub settings_config: String,
    pub website_url: Option<String>,
    pub category: Option<String>,
    pub created_at: Option<i64>,
    pub sort_index: Option<i64>,
    pub notes: Option<String>,
    pub icon: Option<String>,
    pub icon_color: Option<String>,
    pub meta: String,
    pub is_current: bool,
    pub in_failover_queue: bool,
    pub cost_multiplier: String,
    pub limit_daily_usd: Option<String>,
    pub limit_monthly_usd: Option<String>,
    pub provider_type: Option<String>,
    pub endpoints: Vec<AIProviderEndpoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AIProviderEndpoint {
    pub id: Option<i64>,
    pub provider_id: String,
    pub app_type: String,
    pub url: String,
    pub added_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookRecord {
    pub id: i64,
    pub event_name: String,
    pub session_id: String,
    pub notification_text: String,
    pub transcript_path: String,
    pub content: String,
    pub result: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookStatus {
    pub last_event_name: Option<String>,
    pub last_result: Option<String>,
    pub last_event_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookRecordsResponse {
    pub records: Vec<HookRecord>,
    pub total: i64,
    pub page: u32,
    pub page_size: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: i64,
    pub name: String,
    pub path: String,
    pub hooks_installed: bool,
    pub agent_teams_enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub default_provider_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: i64,
    pub session_id: String,
    pub project_path: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub reason: Option<String>,
    pub name: Option<String>,
    pub project_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectDetail {
    pub project: Project,
    pub sessions: Vec<SessionInfo>,
    pub terminal_history: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebIdeProjectStatus {
    pub project_id: String,
    pub project_path: String,
    pub project_name: String,
    pub active_pty_count: u32,
    pub agent_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebIdeSummaryResponse {
    pub projects: Vec<WebIdeProjectStatus>,
}

pub fn load_app_config(conn: &Connection) -> Result<AppConfig, String> {
    Ok(load_config_from_db(conn)?.unwrap_or_default())
}

pub fn save_app_config(conn: &Connection, config: &AppConfig) -> Result<(), String> {
    upsert_config(conn, config)
}

pub fn list_ai_providers(conn: &Connection) -> Result<Vec<AIProvider>, String> {
    let mut stmt = conn.prepare("SELECT id, app_type, name, settings_config, website_url, category, created_at, sort_index, notes, icon, icon_color, meta, is_current, in_failover_queue, cost_multiplier, limit_daily_usd, limit_monthly_usd, provider_type FROM ai_providers ORDER BY sort_index ASC, created_at ASC")
        .map_err(|e| e.to_string())?;

    let rows = stmt.query_map([], |row| {
        let provider_id: String = row.get(0)?;
        let app_type: String = row.get(1)?;
        Ok((provider_id, app_type, AIProvider {
            id: row.get(0)?,
            app_type: row.get(1)?,
            name: row.get(2)?,
            settings_config: row.get(3)?,
            website_url: row.get(4)?,
            category: row.get(5)?,
            created_at: row.get(6)?,
            sort_index: row.get(7)?,
            notes: row.get(8)?,
            icon: row.get(9)?,
            icon_color: row.get(10)?,
            meta: row.get(11)?,
            is_current: row.get(12)?,
            in_failover_queue: row.get(13)?,
            cost_multiplier: row.get(14)?,
            limit_daily_usd: row.get(15)?,
            limit_monthly_usd: row.get(16)?,
            provider_type: row.get(17)?,
            endpoints: Vec::new(),
        }))
    }).map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    for row in rows {
        if let Ok((pid, atype, mut provider)) = row {
            let mut estmt = conn.prepare("SELECT id, provider_id, app_type, url, added_at FROM provider_endpoints WHERE provider_id = ?1 AND app_type = ?2")
                .map_err(|e| e.to_string())?;
            let erows = estmt.query_map(params![pid, atype], |erow| {
                Ok(AIProviderEndpoint {
                    id: Some(erow.get(0)?),
                    provider_id: erow.get(1)?,
                    app_type: erow.get(2)?,
                    url: erow.get(3)?,
                    added_at: erow.get(4)?,
                })
            }).map_err(|e| e.to_string())?;

            for erow in erows {
                if let Ok(endpoint) = erow {
                    provider.endpoints.push(endpoint);
                }
            }
            result.push(provider);
        }
    }
    Ok(result)
}

pub fn upsert_ai_provider(conn: &Connection, provider: AIProvider) -> Result<String, String> {
    let existing_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM ai_providers WHERE id = ?1 AND app_type = ?2",
        params![provider.id, provider.app_type],
        |r| r.get(0),
    ).unwrap_or(0);

    if existing_count > 0 {
        conn.execute(
            "UPDATE ai_providers SET name=?1, settings_config=?2, website_url=?3, category=?4, created_at=?5, sort_index=?6, notes=?7, icon=?8, icon_color=?9, meta=?10, is_current=?11, in_failover_queue=?12, cost_multiplier=?13, limit_daily_usd=?14, limit_monthly_usd=?15, provider_type=?16 WHERE id=?17 AND app_type=?18",
            params![
                provider.name, provider.settings_config, provider.website_url, provider.category,
                provider.created_at, provider.sort_index, provider.notes, provider.icon,
                provider.icon_color, provider.meta, provider.is_current, provider.in_failover_queue,
                provider.cost_multiplier, provider.limit_daily_usd, provider.limit_monthly_usd,
                provider.provider_type, provider.id, provider.app_type
            ],
        ).map_err(|e| e.to_string())?;
    } else {
        conn.execute(
            "INSERT INTO ai_providers (id, app_type, name, settings_config, website_url, category, created_at, sort_index, notes, icon, icon_color, meta, is_current, in_failover_queue, cost_multiplier, limit_daily_usd, limit_monthly_usd, provider_type) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
            params![
                provider.id, provider.app_type, provider.name, provider.settings_config,
                provider.website_url, provider.category, provider.created_at, provider.sort_index,
                provider.notes, provider.icon, provider.icon_color, provider.meta,
                provider.is_current, provider.in_failover_queue, provider.cost_multiplier,
                provider.limit_daily_usd, provider.limit_monthly_usd, provider.provider_type
            ],
        ).map_err(|e| e.to_string())?;
    }

    conn.execute(
        "DELETE FROM provider_endpoints WHERE provider_id = ?1 AND app_type = ?2",
        params![provider.id, provider.app_type],
    ).map_err(|e| e.to_string())?;
    for endpoint in provider.endpoints {
        conn.execute(
            "INSERT INTO provider_endpoints (provider_id, app_type, url, added_at) VALUES (?1, ?2, ?3, ?4)",
            params![provider.id, provider.app_type, endpoint.url, endpoint.added_at],
        ).map_err(|e| e.to_string())?;
    }

    Ok(provider.id)
}

pub fn delete_ai_provider(conn: &Connection, id: &str, app_type: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM ai_providers WHERE id = ?1 AND app_type = ?2",
        params![id, app_type],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn list_projects(conn: &Connection) -> Result<Vec<Project>, String> {
    let mut stmt = conn
        .prepare("SELECT id, name, path, hooks_installed, created_at, updated_at, default_provider_id FROM projects ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                hooks_installed: row.get::<_, i64>(3)? != 0,
                agent_teams_enabled: false,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                default_provider_id: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut projects = Vec::new();
    for project in rows {
        let mut item = project.map_err(|e| e.to_string())?;
        item.agent_teams_enabled = check_agent_teams_enabled_for_path(&item.path).unwrap_or(false);

        if let Ok(actual) = check_hooks_installed_for_path(&item.path) {
            if actual != item.hooks_installed {
                let now = now_ts();
                conn.execute(
                    "UPDATE projects SET hooks_installed = ?1, updated_at = ?2 WHERE id = ?3",
                    params![actual as i64, now, item.id],
                )
                .map_err(|e| e.to_string())?;
                item.hooks_installed = actual;
                item.updated_at = now;
            }
        }
        projects.push(item);
    }

    Ok(projects)
}

pub fn add_project(conn: &Connection, name: String, path: String) -> Result<Project, String> {
    let now = now_ts();
    let hooks_installed = check_hooks_installed_for_path(&path).unwrap_or(false);
    conn.execute(
        "INSERT INTO projects (name, path, hooks_installed, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![name, path, hooks_installed as i64, now, now],
    )
    .map_err(|e| e.to_string())?;

    let id = conn.last_insert_rowid();
    let agent_teams_enabled = check_agent_teams_enabled_for_path(&path).unwrap_or(false);

    Ok(Project {
        id,
        name,
        path,
        hooks_installed,
        agent_teams_enabled,
        created_at: now,
        updated_at: now,
        default_provider_id: None,
    })
}

pub fn update_project(
    conn: &Connection,
    id: i64,
    name: String,
    path: String,
    default_provider_id: Option<String>,
) -> Result<(), String> {
    let now = now_ts();
    conn.execute(
        "UPDATE projects SET name = ?1, path = ?2, updated_at = ?3, default_provider_id = ?4 WHERE id = ?5",
        params![name, path, now, default_provider_id, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_project(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM projects WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn get_project_by_id(conn: &Connection, project_id: i64) -> Result<Option<Project>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, path, hooks_installed, created_at, updated_at, default_provider_id FROM projects WHERE id = ?1",
        )
        .map_err(|e| e.to_string())?;

    let project = stmt
        .query_row(params![project_id], |row| {
            let path: String = row.get(2)?;
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                path: path.clone(),
                hooks_installed: row.get::<_, i64>(3)? != 0,
                agent_teams_enabled: check_agent_teams_enabled_for_path(&path).unwrap_or(false),
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                default_provider_id: row.get(6)?,
            })
        })
        .optional()
        .map_err(|e| e.to_string())?;

    Ok(project)
}

pub fn get_project_path_by_id(conn: &Connection, project_id: i64) -> Result<Option<String>, String> {
    let path = conn
        .query_row(
            "SELECT path FROM projects WHERE id = ?1",
            params![project_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(path)
}

pub fn list_project_sessions(conn: &Connection, project_path: &str) -> Result<Vec<SessionInfo>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, project_path, started_at, ended_at, reason, name, project_name
             FROM sessions
             WHERE project_path = ?1
             ORDER BY started_at DESC
             LIMIT 50",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![project_path], |row| {
            Ok(SessionInfo {
                id: row.get(0)?,
                session_id: row.get(1)?,
                project_path: row.get(2)?,
                started_at: row.get(3)?,
                ended_at: row.get(4)?,
                reason: row.get(5)?,
                name: row.get(6)?,
                project_name: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut sessions = Vec::new();
    for session in rows {
        sessions.push(session.map_err(|e| e.to_string())?);
    }
    Ok(sessions)
}

pub fn update_session_name(conn: &Connection, session_id: &str, name: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE sessions SET name = ?1 WHERE session_id = ?2",
        params![name, session_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_session(conn: &Connection, session_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM sessions WHERE session_id = ?1",
        params![session_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn list_terminal_history(conn: &Connection, project_path: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT content FROM terminal_history
             WHERE project_path = ?1
             ORDER BY id DESC
             LIMIT 500",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query(params![project_path]).map_err(|e| e.to_string())?;
    let mut items = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        items.push(row.get::<_, String>(0).map_err(|e| e.to_string())?);
    }
    items.reverse();
    Ok(items)
}

pub fn list_hook_records(
    conn: &Connection,
    project_path: &str,
    page: Option<u32>,
    page_size: Option<u32>,
) -> Result<HookRecordsResponse, String> {
    let table_name = project_hooks_table_name(project_path);
    ensure_project_hooks_table(conn, &table_name)?;

    let total_sql = format!("SELECT COUNT(*) FROM {}", table_name);
    let total: i64 = conn.query_row(&total_sql, [], |row| row.get(0)).unwrap_or(0);

    let page = page.unwrap_or(1).max(1);
    let page_size = page_size.unwrap_or(20).min(100);
    let offset = (page - 1) * page_size;

    let query_sql = format!(
        "SELECT id, event_name, session_id, notification_text, transcript_path, content, result, created_at
         FROM {}
         ORDER BY created_at DESC
         LIMIT ?1 OFFSET ?2",
        table_name
    );
    let mut stmt = conn.prepare(&query_sql).map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![page_size as i64, offset as i64], |row| {
            Ok(HookRecord {
                id: row.get(0)?,
                event_name: row.get(1)?,
                session_id: row.get(2)?,
                notification_text: row.get(3)?,
                transcript_path: row.get(4)?,
                content: row.get(5)?,
                result: row.get(6)?,
                created_at: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut records = Vec::new();
    for record in rows {
        records.push(record.map_err(|e| e.to_string())?);
    }
    Ok(HookRecordsResponse {
        records,
        total,
        page,
        page_size,
    })
}

pub fn delete_hook_record(conn: &Connection, project_path: &str, id: i64) -> Result<(), String> {
    let table_name = project_hooks_table_name(project_path);
    ensure_project_hooks_table(conn, &table_name)?;
    let delete_sql = format!("DELETE FROM {} WHERE id = ?1", table_name);
    conn.execute(&delete_sql, params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_hook_records(conn: &Connection, project_path: &str, ids: &[i64]) -> Result<(), String> {
    let table_name = project_hooks_table_name(project_path);
    ensure_project_hooks_table(conn, &table_name)?;
    let delete_sql = format!("DELETE FROM {} WHERE id = ?1", table_name);
    for id in ids {
        conn.execute(&delete_sql, params![id]).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn get_project_detail(conn: &Connection, project_id: i64) -> Result<ProjectDetail, String> {
    let project = get_project_by_id(conn, project_id)?.ok_or_else(|| "PROJECT_NOT_FOUND".to_string())?;
    let sessions = list_project_sessions(conn, &project.path)?;
    let terminal_history = list_terminal_history(conn, &project.path)?;
    Ok(ProjectDetail {
        project,
        sessions,
        terminal_history,
    })
}

fn now_ts() -> i64 {
    Utc::now().timestamp()
}

fn check_hooks_installed_for_path(project_path: &str) -> Result<bool, String> {
    let settings_path = Path::new(project_path)
        .join(".claude")
        .join("settings.local.json");

    if !settings_path.exists() {
        return Ok(false);
    }

    let content = fs::read_to_string(&settings_path)
        .map_err(|e| format!("Failed to read settings: {}", e))?;

    let settings: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse settings: {}", e))?;

    Ok(is_hooks_config_complete(&settings))
}

fn is_hooks_config_complete(settings: &serde_json::Value) -> bool {
    let required = ["Notification", "PermissionRequest", "Stop", "UserPromptSubmit", "SessionStart", "SessionEnd"];
    if let Some(obj) = settings.as_object() {
        if required.iter().all(|key| obj.contains_key(*key)) {
            if required.iter().all(|key| is_hooks_event_complete(&obj[*key])) {
                return true;
            }
        }
    }
    if let Some(hooks) = settings.get("hooks") {
        if let Some(hook_obj) = hooks.as_object() {
            if required.iter().all(|key| hook_obj.contains_key(*key)) {
                if required.iter().all(|key| is_hooks_event_complete(&hook_obj[*key])) {
                    return true;
                }
            }
        }
    }
    false
}

fn is_hooks_event_complete(value: &serde_json::Value) -> bool {
    let entries = match value.as_array() {
        Some(items) if !items.is_empty() => items,
        _ => return false,
    };
    for entry in entries {
        let hooks = match entry.get("hooks").and_then(|v| v.as_array()) {
            Some(items) if !items.is_empty() => items,
            _ => return false,
        };
        for hook in hooks {
            let kind = hook.get("type").and_then(|v| v.as_str()).unwrap_or("");
            let command = hook.get("command").and_then(|v| v.as_str()).unwrap_or("");
            if kind != "command" || command.trim().is_empty() {
                return false;
            }
        }
    }
    true
}

fn check_agent_teams_enabled_for_path(project_path: &str) -> Result<bool, String> {
    let agents_dir = Path::new(project_path).join(".claude").join("agents");
    if !agents_dir.exists() {
        return Ok(false);
    }
    let expected_files = vec![
        "architect.md",
        "implementer.md",
        "code-reviewer.md",
        "debugger.md",
        "test-writer.md",
        "refactorer.md",
    ];
    Ok(expected_files.iter().all(|f| agents_dir.join(f).exists()))
}

fn table_exists(conn: &Connection, table_name: &str) -> Result<bool, String> {
    let exists: Result<i64, rusqlite::Error> = conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
        params![table_name],
        |row| row.get(0),
    );
    match exists {
        Ok(_) => Ok(true),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

fn load_config_from_table(conn: &Connection, table_name: &str) -> Result<Option<AppConfig>, String> {
    let sql = format!(
        "SELECT app_id, app_secret, encrypt_key, verification_token, chat_id, project_path
         FROM {} WHERE id = 1",
        table_name
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    if let Some(row) = rows.next().map_err(|e| e.to_string())? {
        Ok(Some(AppConfig {
            app_id: row.get(0).map_err(|e| e.to_string())?,
            app_secret: row.get(1).map_err(|e| e.to_string())?,
            encrypt_key: row.get(2).map_err(|e| e.to_string())?,
            verification_token: row.get(3).map_err(|e| e.to_string())?,
            chat_id: row.get(4).map_err(|e| e.to_string())?,
            project_path: row.get(5).map_err(|e| e.to_string())?,
            open_id: None,
            hook_events_filter: None,
            app_name: None,
            anthropic_logo_img_key: None,
            terminal_bg_color: None,
            terminal_fg_color: None,
            terminal_font_size: None,
            default_provider_id: None,
        }))
    } else {
        Ok(None)
    }
}

fn migrate_app_config_table(conn: &Connection) -> Result<(), String> {
    if !table_exists(conn, "app_config")? {
        return Ok(());
    }
    if load_config_from_db(conn)?.is_none() {
        if let Some(config) = load_config_from_table(conn, "app_config")? {
            upsert_config(conn, &config)?;
        }
    }
    conn.execute("DROP TABLE IF EXISTS app_config", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn load_config_from_db(conn: &Connection) -> Result<Option<AppConfig>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT app_id, app_secret, encrypt_key, verification_token, chat_id, project_path, open_id, hook_events_filter, app_name, anthropic_logo_img_key, terminal_bg_color, terminal_fg_color, terminal_font_size, default_provider_id
             FROM app_config_feishu WHERE id = 1",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    if let Some(row) = rows.next().map_err(|e| e.to_string())? {
        Ok(Some(AppConfig {
            app_id: row.get(0).unwrap_or_default(),
            app_secret: row.get(1).unwrap_or_default(),
            encrypt_key: row.get(2).ok(),
            verification_token: row.get(3).ok(),
            chat_id: row.get(4).ok(),
            project_path: row.get(5).ok(),
            open_id: row.get(6).ok(),
            hook_events_filter: row.get(7).ok(),
            app_name: row.get(8).ok(),
            anthropic_logo_img_key: row.get(9).ok(),
            terminal_bg_color: row.get(10).ok(),
            terminal_fg_color: row.get(11).ok(),
            terminal_font_size: row.get(12).ok(),
            default_provider_id: row.get(13).ok(),
        }))
    } else {
        Ok(None)
    }
}

fn upsert_config(conn: &Connection, config: &AppConfig) -> Result<(), String> {
    let now = now_ts();
    conn.execute(
        "INSERT INTO app_config_feishu (id, app_id, app_secret, encrypt_key, verification_token, chat_id, project_path, open_id, hook_events_filter, app_name, anthropic_logo_img_key, terminal_bg_color, terminal_fg_color, terminal_font_size, default_provider_id, updated_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
         ON CONFLICT(id) DO UPDATE SET
           app_id = excluded.app_id,
           app_secret = excluded.app_secret,
           encrypt_key = excluded.encrypt_key,
           verification_token = excluded.verification_token,
           chat_id = COALESCE(excluded.chat_id, app_config_feishu.chat_id),
           app_name = excluded.app_name,
           project_path = excluded.project_path,
           open_id = COALESCE(excluded.open_id, app_config_feishu.open_id),
           hook_events_filter = excluded.hook_events_filter,
           anthropic_logo_img_key = excluded.anthropic_logo_img_key,
           terminal_bg_color = excluded.terminal_bg_color,
           terminal_fg_color = excluded.terminal_fg_color,
           terminal_font_size = excluded.terminal_font_size,
           default_provider_id = excluded.default_provider_id,
           updated_at = excluded.updated_at",
        params![
            config.app_id,
            config.app_secret,
            config.encrypt_key,
            config.verification_token,
            config.chat_id,
            config.project_path,
            config.open_id,
            config.hook_events_filter,
            config.app_name,
            config.anthropic_logo_img_key,
            config.terminal_bg_color,
            config.terminal_fg_color,
            config.terminal_font_size,
            config.default_provider_id,
            now
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn project_hooks_table_name(project_path: &str) -> String {
    let mut hash: u64 = 14695981039346656037;
    for byte in project_path.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(1099511628211);
    }
    format!("hook_records_{:x}", hash)
}

fn ensure_project_hooks_table(conn: &Connection, table_name: &str) -> Result<(), String> {
    let sql = format!(
        "CREATE TABLE IF NOT EXISTS {} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_name TEXT NOT NULL,
            session_id TEXT NOT NULL,
            notification_text TEXT NOT NULL,
            transcript_path TEXT NOT NULL,
            content TEXT NOT NULL,
            result TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )",
        table_name
    );
    conn.execute(&sql, []).map_err(|e| e.to_string())?;
    ensure_session_id_column(conn, table_name)?;
    Ok(())
}

fn ensure_session_id_column(conn: &Connection, table_name: &str) -> Result<(), String> {
    let pragma_sql = format!("PRAGMA table_info({})", table_name);
    let mut stmt = conn.prepare(&pragma_sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?;
    let mut has_session = false;
    for row in rows {
        if row.map_err(|e| e.to_string())? == "session_id" {
            has_session = true;
            break;
        }
    }
    if !has_session {
        let alter_sql = format!(
            "ALTER TABLE {} ADD COLUMN session_id TEXT NOT NULL DEFAULT ''",
            table_name
        );
        conn.execute(&alter_sql, []).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn post_open_db_migrations(conn: &Connection) -> Result<(), String> {
    let _ = conn.execute("ALTER TABLE sessions ADD COLUMN name TEXT", []);
    let _ = conn.execute("ALTER TABLE sessions ADD COLUMN project_name TEXT", []);
    let _ = conn.execute(
        "DELETE FROM sessions WHERE id NOT IN (SELECT MIN(id) FROM sessions GROUP BY session_id)",
        [],
    );
    let _ = conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_session_id ON sessions(session_id)",
        [],
    );
    cleanup_legacy_data(conn)?;
    migrate_app_config_table(conn)?;
    Ok(())
}

fn cleanup_legacy_data(conn: &Connection) -> Result<(), String> {
    let cleaned: Result<String, _> = conn.query_row(
        "SELECT value FROM db_meta WHERE key = 'cleanup_legacy_v1'",
        [],
        |row| row.get(0),
    );
    if cleaned.is_ok() {
        return Ok(());
    }
    conn.execute("DROP TABLE IF EXISTS hook_records", [])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM terminal_history", [])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM terminal_input_history", [])
        .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO db_meta (key, value) VALUES ('cleanup_legacy_v1', '1')",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
