use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use rusqlite::{params, Connection};

mod websocket;
use websocket::FeishuWsClient;

mod pty;
use pty::{PtyManager, pty_spawn, pty_write, pty_kill, pty_resize, pty_exists};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub app_id: String,
    pub app_secret: String,
    pub encrypt_key: Option<String>,
    pub verification_token: Option<String>,
    pub chat_id: Option<String>,
    pub project_path: Option<String>,
    pub open_id: Option<String>,
    pub hook_events_filter: Option<String>,
}

impl Default for AppConfig {
    fn default() -> Self {
        AppConfig {
            app_id: String::new(),
            app_secret: String::new(),
            encrypt_key: None,
            verification_token: None,
            chat_id: None,
            project_path: None,
            open_id: None,
            hook_events_filter: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeishuEvent {
    pub schema: String,
    pub header: EventHeader,
    pub event: EventPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventHeader {
    pub event_id: String,
    pub event_type: String,
    pub create_time: String,
    pub token: String,
    pub app_id: String,
    pub tenant_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventPayload {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub sender: Sender,
    pub message: Message,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Sender {
    pub sender_id: SenderId,
    pub sender_type: String,
    pub tenant_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SenderId {
    pub union_id: String,
    pub user_id: String,
    pub open_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub message_id: String,
    pub root_id: Option<String>,
    pub parent_id: Option<String>,
    pub create_time: String,
    pub chat_id: String,
    pub chat_type: String,
    pub message_type: String,
    pub content: String,
    pub mentions: Option<Vec<Mention>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Mention {
    pub key: String,
    pub id: MentionId,
    pub name: String,
    pub tenant_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MentionId {
    pub union_id: String,
    pub user_id: String,
    pub open_id: String,
}

pub struct AppState {
    pub config: Arc<Mutex<Option<AppConfig>>>,
    pub event_tx: mpsc::Sender<String>,
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
pub struct Project {
    pub id: i64,
    pub name: String,
    pub path: String,
    pub hooks_installed: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WssStatus {
    pub last_receive_time: Option<i64>,
    pub last_open_id: Option<String>,
}

fn get_db_path() -> PathBuf {
    let base_dir = dirs::home_dir()
        .expect("Failed to get home directory")
        .join("sparky");
    fs::create_dir_all(&base_dir).expect("Failed to create base directory");
    base_dir.join("hooks.db")
}

fn init_db(conn: &Connection) -> rusqlite::Result<()> {
    // 创建项目表
    conn.execute(
        "CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            path TEXT NOT NULL,
            hooks_installed INTEGER DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS pty_commands (
            id INTEGER PRIMARY KEY,
            project_path TEXT NOT NULL,
            command TEXT NOT NULL,
            processed INTEGER DEFAULT 0,
            created_at INTEGER
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS permission_requests (
            id INTEGER PRIMARY KEY,
            project_path TEXT NOT NULL,
            status TEXT NOT NULL,
            choice TEXT,
            created_at INTEGER
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS terminal_input_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_path TEXT NOT NULL,
            input TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS terminal_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_path TEXT NOT NULL,
            kind TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS app_config_feishu (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            app_id TEXT NOT NULL,
            app_secret TEXT NOT NULL,
            encrypt_key TEXT,
            verification_token TEXT,
            chat_id TEXT,
            project_path TEXT,
            open_id TEXT,
            hook_events_filter TEXT,
            updated_at INTEGER NOT NULL
        )",
        [],
    )?;

    // 迁移：给已存在的表添加 open_id 列
    let _ = conn.execute("ALTER TABLE app_config_feishu ADD COLUMN open_id TEXT", []);
    let _ = conn.execute("ALTER TABLE app_config_feishu ADD COLUMN hook_events_filter TEXT", []);

    conn.execute(
        "CREATE TABLE IF NOT EXISTS app_config_dingtalk (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            app_id TEXT NOT NULL,
            app_secret TEXT NOT NULL,
            encrypt_key TEXT,
            verification_token TEXT,
            chat_id TEXT,
            project_path TEXT,
            updated_at INTEGER NOT NULL
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS app_config_wework (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            app_id TEXT NOT NULL,
            app_secret TEXT NOT NULL,
            encrypt_key TEXT,
            verification_token TEXT,
            chat_id TEXT,
            project_path TEXT,
            updated_at INTEGER NOT NULL
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS db_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )",
        [],
    )?;

    Ok(())
}

pub(crate) fn open_db() -> Result<Connection, String> {
    let conn = Connection::open(get_db_path()).map_err(|e| e.to_string())?;
    init_db(&conn).map_err(|e| e.to_string())?;
    cleanup_legacy_data(&conn)?;
    migrate_app_config_table(&conn)?;
    Ok(conn)
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
            "SELECT app_id, app_secret, encrypt_key, verification_token, chat_id, project_path, open_id, hook_events_filter
             FROM app_config_feishu WHERE id = 1",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    if let Some(row) = rows.next().map_err(|e| e.to_string())? {
        Ok(Some(AppConfig {
            app_id: row.get(0).map_err(|e| e.to_string())?,
            app_secret: row.get(1).map_err(|e| e.to_string())?,
            encrypt_key: row.get(2).map_err(|e| e.to_string())?,
            verification_token: row.get(3).map_err(|e| e.to_string())?,
            chat_id: row.get(4).map_err(|e| e.to_string())?,
            project_path: row.get(5).map_err(|e| e.to_string())?,
            open_id: row.get(6).map_err(|e| e.to_string())?,
            hook_events_filter: row.get(7).map_err(|e| e.to_string())?,
        }))
    } else {
        Ok(None)
    }
}

fn upsert_config(conn: &Connection, config: &AppConfig) -> Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;
    conn.execute(
        "INSERT INTO app_config_feishu (id, app_id, app_secret, encrypt_key, verification_token, chat_id, project_path, open_id, hook_events_filter, updated_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET
           app_id = excluded.app_id,
           app_secret = excluded.app_secret,
           encrypt_key = excluded.encrypt_key,
           verification_token = excluded.verification_token,
           chat_id = excluded.chat_id,
           project_path = excluded.project_path,
           open_id = COALESCE(excluded.open_id, app_config_feishu.open_id),
           hook_events_filter = excluded.hook_events_filter,
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
            now
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 单独更新 open_id 到 SQLite（供 WebSocket 回调使用）
fn save_open_id_to_db(open_id: &str) -> Result<(), String> {
    let conn = open_db()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;
    conn.execute(
        "UPDATE app_config_feishu SET open_id = ?1, updated_at = ?2 WHERE id = 1",
        params![open_id, now],
    )
    .map_err(|e| e.to_string())?;
    log::info!("[db] open_id saved to SQLite: {}", open_id);
    Ok(())
}

#[tauri::command]
fn record_terminal_input(project_path: String, input: String) -> Result<(), String> {
    let conn = open_db()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;

    conn.execute(
        "INSERT INTO terminal_history (project_path, kind, content, created_at) VALUES (?1, 'input', ?2, ?3)",
        params![project_path, input, now],
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "DELETE FROM terminal_history
         WHERE id NOT IN (
           SELECT id FROM terminal_history
           WHERE project_path = ?1 AND kind = 'input'
           ORDER BY id DESC
           LIMIT 50
         ) AND project_path = ?1 AND kind = 'input'",
        params![project_path],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn record_terminal_output(project_path: String, output: String) -> Result<(), String> {
    let conn = open_db()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;

    conn.execute(
        "INSERT INTO terminal_history (project_path, kind, content, created_at) VALUES (?1, 'output', ?2, ?3)",
        params![project_path, output, now],
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "DELETE FROM terminal_history
         WHERE id NOT IN (
           SELECT id FROM terminal_history
           WHERE project_path = ?1 AND kind = 'output'
           ORDER BY id DESC
           LIMIT 500
         ) AND project_path = ?1 AND kind = 'output'",
        params![project_path],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn get_terminal_history(project_path: String) -> Result<Vec<String>, String> {
    let conn = open_db()?;
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

#[tauri::command]
fn get_wss_status() -> Result<WssStatus, String> {
    let config_dir = dirs::config_dir()
        .ok_or("Failed to get config directory")?
        .join("com.claude.monitor");

    let last_receive_time = std::fs::read_to_string(config_dir.join("last_receive_time.txt"))
        .ok()
        .and_then(|s| s.trim().parse().ok());

    let last_open_id = std::fs::read_to_string(config_dir.join("last_open_id.txt"))
        .ok()
        .map(|s| s.trim().to_string());

    Ok(WssStatus {
        last_receive_time,
        last_open_id,
    })
}

#[tauri::command]
fn get_config() -> Result<AppConfig, String> {
    let conn = open_db()?;
    if let Some(config) = load_config_from_db(&conn)? {
        Ok(config)
    } else {
        Ok(AppConfig::default())
    }
}

#[tauri::command]
fn save_config(config: AppConfig) -> Result<(), String> {
    let conn = open_db()?;
    upsert_config(&conn, &config)?;
    Ok(())
}

fn get_claude_settings_path() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or("Failed to find home directory")?;
    Ok(home.join(".claude").join("settings.local.json"))
}

fn build_hook_command() -> Result<String, String> {
    if let Ok(cmd) = std::env::var("CLAUDE_MONITOR_HOOK_COMMAND") {
        if !cmd.trim().is_empty() {
            return Ok(cmd);
        }
    }

    let exe_path = std::env::current_exe()
        .map_err(|e| format!("Failed to get executable path: {}", e))?;

    // CLI 二进制名固定为 "sparky"（与根目录 Cargo.toml 的 package name 一致）
    let cli_bin_name = "sparky";

    let mut current = exe_path.parent();
    let mut repo_root: Option<std::path::PathBuf> = None;
    while let Some(dir) = current {
        if dir.file_name().map(|name| name == "src-tauri").unwrap_or(false) {
            repo_root = dir.parent().map(|p| p.to_path_buf());
            break;
        }
        current = dir.parent();
    }

    if let Some(root) = repo_root {
        let debug_path = root.join("target").join("debug").join(cli_bin_name);
        if debug_path.exists() {
            return Ok(format!("{} hook", debug_path.to_string_lossy()));
        }
        let release_path = root.join("target").join("release").join(cli_bin_name);
        if release_path.exists() {
            return Ok(format!("{} hook", release_path.to_string_lossy()));
        }
    }

    // fallback: 尝试全局 PATH 中查找
    Ok(format!("{} hook", cli_bin_name))
}

#[tauri::command]
fn check_hooks_installed(project_path: String) -> Result<bool, String> {
    check_hooks_installed_for_path(&project_path)
}

fn check_hooks_installed_for_path(project_path: &str) -> Result<bool, String> {
    let settings_path = std::path::Path::new(&project_path)
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
    let required = ["Notification", "PermissionRequest", "Stop", "UserPromptSubmit"];
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

#[tauri::command]
fn install_hooks(project_path: String) -> Result<(), String> {
    let settings_path = std::path::Path::new(&project_path)
        .join(".claude")
        .join("settings.local.json");

    // Ensure .claude directory exists
    if let Some(parent) = settings_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create .claude directory: {}", e))?;
    }

    let hook_command = build_hook_command()?;
    let hooks_events = serde_json::json!({
        "Notification": [
            {
                "hooks": [
                    {
                        "type": "command",
                        "command": hook_command.clone()
                    }
                ]
            }
        ],
        "PermissionRequest": [
            {
                "hooks": [
                    {
                        "type": "command",
                        "command": hook_command.clone()
                    }
                ]
            }
        ],
        "Stop": [
            {
                "hooks": [
                    {
                        "type": "command",
                        "command": hook_command.clone()
                    }
                ]
            }
        ],
        "UserPromptSubmit": [
            {
                "hooks": [
                    {
                        "type": "command",
                        "command": hook_command
                    }
                ]
            }
        ]
    });

    // Claude Code 要求 hooks 放在 "hooks" key 下
    let hooks_config = serde_json::json!({
        "hooks": hooks_events
    });

    if settings_path.exists() {
        // Read existing settings and merge
        let content = fs::read_to_string(&settings_path)
            .map_err(|e| format!("Failed to read settings: {}", e))?;

        let mut settings: serde_json::Value = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse settings: {}", e))?;

        if let Some(obj) = settings.as_object_mut() {
            // 移除旧的顶层 hook 事件 key（兼容旧格式）
            for key in ["Notification", "PermissionRequest", "Stop", "UserPromptSubmit"] {
                obj.remove(key);
            }
            // 设置/覆盖 "hooks" key
            obj.insert("hooks".to_string(), hooks_events);
        }

        let new_content = serde_json::to_string_pretty(&settings)
            .map_err(|e| format!("Failed to serialize settings: {}", e))?;

        fs::write(&settings_path, new_content)
            .map_err(|e| format!("Failed to write settings: {}", e))?;
    } else {
        // Create new settings file
        let content = serde_json::to_string_pretty(&hooks_config)
            .map_err(|e| format!("Failed to serialize: {}", e))?;

        fs::write(&settings_path, content)
            .map_err(|e| format!("Failed to write settings: {}", e))?;
    }

    log::info!("Hooks installed successfully to {:?}", settings_path);
    Ok(())
}

#[tauri::command]
fn uninstall_hooks(project_path: String) -> Result<(), String> {
    let settings_path = std::path::Path::new(&project_path)
        .join(".claude")
        .join("settings.local.json");

    if !settings_path.exists() {
        return Ok(());
    }

    let content = fs::read_to_string(&settings_path)
        .map_err(|e| format!("Failed to read settings: {}", e))?;

    let mut settings: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse settings: {}", e))?;

    if let Some(obj) = settings.as_object_mut() {
        obj.remove("Notification");
        obj.remove("PermissionRequest");
        obj.remove("Stop");
        obj.remove("UserPromptSubmit");
        obj.remove("hooks");
    }

    let new_content = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;

    fs::write(&settings_path, new_content)
        .map_err(|e| format!("Failed to write settings: {}", e))?;

    log::info!("Hooks uninstalled successfully");
    Ok(())
}

#[tauri::command]
async fn test_feishu_connection(app_id: String, app_secret: String) -> Result<String, String> {
    let client = reqwest::Client::new();
    
    // 获取 tenant_access_token
    let token_url = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";
    let token_body = serde_json::json!({
        "app_id": app_id,
        "app_secret": app_secret
    });
    
    let response = client
        .post(token_url)
        .json(&token_body)
        .send()
        .await
        .map_err(|e| format!("Failed to request token: {}", e))?;
    
    let token_result: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse token response: {}", e))?;
    
    if token_result["code"].as_i64().unwrap_or(-1) != 0 {
        return Err(format!("Failed to get token: {}", token_result["msg"].as_str().unwrap_or("Unknown error")));
    }
    
    Ok("飞书应用配置验证成功".to_string())
}

#[tauri::command]
async fn send_feishu_message(
    app_id: String,
    app_secret: String,
    receive_id: String,
    message: String,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    
    // 获取 tenant_access_token
    let token_url = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";
    let token_body = serde_json::json!({
        "app_id": app_id,
        "app_secret": app_secret
    });
    
    let response = client
        .post(token_url)
        .json(&token_body)
        .send()
        .await
        .map_err(|e| format!("Failed to request token: {}", e))?;
    
    let token_result: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse token response: {}", e))?;
    
    let tenant_access_token = token_result["tenant_access_token"]
        .as_str()
        .ok_or("Failed to get tenant_access_token")?;
    
    // 发送消息
    let message_url = "https://open.feishu.cn/open-apis/im/v1/messages";
    let message_body = serde_json::json!({
        "receive_id": receive_id,
        "msg_type": "interactive",
        "content": message
    });
    
    let response = client
        .post(message_url)
        .header("Authorization", format!("Bearer {}", tenant_access_token))
        .query(&[("receive_id_type", "chat_id")])
        .json(&message_body)
        .send()
        .await
        .map_err(|e| format!("Failed to send message: {}", e))?;
    
    let result: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse message response: {}", e))?;
    
    if result["code"].as_i64().unwrap_or(-1) != 0 {
        return Err(format!("Failed to send message: {}", result["msg"].as_str().unwrap_or("Unknown error")));
    }
    
    Ok("消息发送成功".to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookRecordsResponse {
    pub records: Vec<HookRecord>,
    pub total: i64,
    pub page: u32,
    pub page_size: u32,
}

#[tauri::command]
fn get_hook_records(project_path: String, page: Option<u32>, page_size: Option<u32>) -> Result<HookRecordsResponse, String> {
    let conn = open_db()?;
    let table_name = project_hooks_table_name(&project_path);
    ensure_project_hooks_table(&conn, &table_name)?;

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

#[tauri::command]
fn delete_hook_record(project_path: String, id: i64) -> Result<(), String> {
    let conn = open_db()?;
    let table_name = project_hooks_table_name(&project_path);
    ensure_project_hooks_table(&conn, &table_name)?;
    let delete_sql = format!("DELETE FROM {} WHERE id = ?1", table_name);
    conn.execute(&delete_sql, params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_hook_records(project_path: String, ids: Vec<i64>) -> Result<(), String> {
    let conn = open_db()?;
    let table_name = project_hooks_table_name(&project_path);
    ensure_project_hooks_table(&conn, &table_name)?;
    let delete_sql = format!("DELETE FROM {} WHERE id = ?1", table_name);
    for id in ids {
        conn.execute(&delete_sql, params![id]).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn get_hook_status(project_path: String) -> Result<HookStatus, String> {
    let conn = open_db()?;
    let table_name = project_hooks_table_name(&project_path);
    ensure_project_hooks_table(&conn, &table_name)?;
    let query_sql = format!(
        "SELECT event_name, result, created_at
         FROM {}
         ORDER BY created_at DESC
         LIMIT 1",
        table_name
    );
    let mut stmt = conn.prepare(&query_sql).map_err(|e| e.to_string())?;

    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    if let Some(row) = rows.next().map_err(|e| e.to_string())? {
        Ok(HookStatus {
            last_event_name: Some(row.get(0).map_err(|e| e.to_string())?),
            last_result: Some(row.get(1).map_err(|e| e.to_string())?),
            last_event_at: Some(row.get(2).map_err(|e| e.to_string())?),
        })
    } else {
        Ok(HookStatus {
            last_event_name: None,
            last_result: None,
            last_event_at: None,
        })
    }
}

#[tauri::command]
fn get_projects() -> Result<Vec<Project>, String> {
    let conn = open_db()?;

    let mut stmt = conn
        .prepare("SELECT id, name, path, hooks_installed, created_at, updated_at FROM projects ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                hooks_installed: row.get::<_, i64>(3)? != 0,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut projects = Vec::new();
    for project in rows {
        let mut item = project.map_err(|e| e.to_string())?;
        if let Ok(actual) = check_hooks_installed_for_path(&item.path) {
            if actual != item.hooks_installed {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|e| e.to_string())?
                    .as_secs() as i64;
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

#[tauri::command]
fn add_project(name: String, path: String) -> Result<Project, String> {
    let conn = open_db()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;

    let hooks_installed = check_hooks_installed_for_path(&path).unwrap_or(false);
    conn.execute(
        "INSERT INTO projects (name, path, hooks_installed, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![name, path, hooks_installed as i64, now, now],
    )
    .map_err(|e| e.to_string())?;

    let id = conn.last_insert_rowid();

    Ok(Project {
        id,
        name,
        path,
        hooks_installed,
        created_at: now,
        updated_at: now,
    })
}

#[tauri::command]
fn update_project(id: i64, name: String, path: String) -> Result<(), String> {
    let conn = open_db()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;

    conn.execute(
        "UPDATE projects SET name = ?1, path = ?2, updated_at = ?3 WHERE id = ?4",
        params![name, path, now, id],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn delete_project(id: i64) -> Result<(), String> {
    let conn = open_db()?;
    conn.execute("DELETE FROM projects WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn set_project_hooks_status(id: i64, hooks_installed: bool) -> Result<(), String> {
    let conn = open_db()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;

    conn.execute(
        "UPDATE projects SET hooks_installed = ?1, updated_at = ?2 WHERE id = ?3",
        params![hooks_installed as i64, now, id],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let (event_tx, _event_rx) = mpsc::channel::<String>(100);
    let state = Arc::new(AppState {
        config: Arc::new(Mutex::new(None)),
        event_tx,
    });

    tauri::Builder::default()
        .manage(state)
        .manage(PtyManager::new())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            
            // App 重启时，将所有 pending 的权限请求标记为已过期
            if let Ok(conn) = open_db() {
                if let Err(e) = conn.execute(
                    "UPDATE permission_requests SET status = 'expired' WHERE status = 'pending'",
                    [],
                ) {
                    log::error!("Failed to mark pending requests as expired: {}", e);
                } else {
                    log::info!("Successfully marked all pending permission requests as expired on app start.");
                }
            }

            // 启动时自动连接飞书 WSS
            tauri::async_runtime::spawn(async move {
                // 等待一小段时间让应用完全启动
                tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

                let config = get_config().ok();

                if let Some(config) = config {
                    if !config.app_id.is_empty() && !config.app_secret.is_empty() {
                        log::info!("Starting Feishu WebSocket connection...");
                        let client = FeishuWsClient::new(
                            config.app_id.clone(),
                            config.app_secret.clone(),
                        );

                        loop {
                            match client.connect().await {
                                Ok(_) => {
                                    log::info!("WebSocket connection closed normally");
                                }
                                Err(e) => {
                                    log::error!("WebSocket connection error: {}", e);
                                }
                            }
                            log::info!("Reconnecting in 5 seconds...");
                            tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                        }
                    } else {
                        log::warn!("Feishu app_id or app_secret not configured");
                    }
                } else {
                    log::warn!("Config not found, skipping WSS connection");
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            test_feishu_connection,
            send_feishu_message,
            get_hook_records,
            get_hook_status,
            delete_hook_record,
            delete_hook_records,
            get_wss_status,
            pty_spawn,
            pty_write,
            pty_kill,
            pty_resize,
            pty_exists,
            record_terminal_input,
            record_terminal_output,
            get_terminal_history,
            check_hooks_installed,
            install_hooks,
            uninstall_hooks,
            get_projects,
            add_project,
            update_project,
            delete_project,
            set_project_hooks_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
