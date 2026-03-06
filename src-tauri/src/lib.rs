use std::net::TcpStream;
use std::time::Duration;
use serde::{Deserialize, Serialize};
use std::fs;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex as StdMutex;
use tokio::sync::{mpsc, Mutex};
use rusqlite::{params, Connection, OptionalExtension};
use base64::Engine as _;

use tauri::Manager;
mod websocket;
use websocket::FeishuWsClient;

mod feishu_client;

mod pty;
use pty::{PtyManager, pty_spawn, pty_write, pty_kill, pty_resize, pty_exists};

pub struct WsConnectionState(pub Arc<AtomicBool>);

#[tauri::command(rename_all = "snake_case")]
fn get_ws_connected(state: tauri::State<'_, WsConnectionState>) -> bool {
    state.0.load(std::sync::atomic::Ordering::SeqCst)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    pub terminal_font_size: Option<i64>,
}

impl Default for AppConfig {
    fn default() -> Self {
        AppConfig {
            app_id: String::new(),
            app_secret: String::new(),
            app_name: None,
            encrypt_key: None,
            verification_token: None,
            chat_id: None,
            project_path: None,
            open_id: None,
            hook_events_filter: None,
            anthropic_logo_img_key: None,
            terminal_bg_color: None,
            terminal_fg_color: None,
            terminal_font_size: None,
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
    pub active_project: Arc<StdMutex<Option<String>>>,
    pub pending_selections: Arc<StdMutex<HashMap<String, Vec<String>>>>,
    pub active_terminal_id: Arc<StdMutex<Option<String>>>,
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
    pub agent_teams_enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WssStatus {
    pub last_receive_time: Option<i64>,
    pub last_open_id: Option<String>,
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
            message_id TEXT,
            processed INTEGER DEFAULT 0,
            created_at INTEGER
        )",
        [],
    )?;
    
    // migration: add message_id column to existing table
    let _ = conn.execute("ALTER TABLE pty_commands ADD COLUMN message_id TEXT", []);

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
        "CREATE TABLE IF NOT EXISTS active_ptys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_path TEXT NOT NULL UNIQUE,
            created_at INTEGER NOT NULL
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
    let _ = conn.execute("ALTER TABLE app_config_feishu ADD COLUMN app_name TEXT", []);
    let _ = conn.execute("ALTER TABLE app_config_feishu ADD COLUMN anthropic_logo_img_key TEXT", []);
    let _ = conn.execute("ALTER TABLE app_config_feishu ADD COLUMN terminal_bg_color TEXT", []);
    let _ = conn.execute("ALTER TABLE app_config_feishu ADD COLUMN terminal_fg_color TEXT", []);
    let _ = conn.execute("ALTER TABLE app_config_feishu ADD COLUMN terminal_font_size INTEGER", []);

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

    conn.execute(
        "CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL UNIQUE,
            project_path TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            ended_at INTEGER,
            reason TEXT,
            name TEXT,
            project_name TEXT
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS testing_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_path TEXT NOT NULL UNIQUE,
            session_id TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )",
        [],
    )?;

    Ok(())
}

pub(crate) fn open_db() -> Result<Connection, String> {
    let conn = Connection::open(get_db_path()).map_err(|e| e.to_string())?;
    init_db(&conn).map_err(|e| e.to_string())?;
    
    // Add missing names column to active databases
    let _ = conn.execute("ALTER TABLE sessions ADD COLUMN name TEXT", []);
    let _ = conn.execute("ALTER TABLE sessions ADD COLUMN project_name TEXT", []);

    // Remove duplicates keeping the first one, then enforce unique constraint
    let _ = conn.execute(
        "DELETE FROM sessions WHERE id NOT IN (SELECT MIN(id) FROM sessions GROUP BY session_id)",
        [],
    );
    let _ = conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_session_id ON sessions(session_id)",
        [],
    );

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
            app_name: None,
            anthropic_logo_img_key: None,
            terminal_bg_color: None,
            terminal_fg_color: None,
            terminal_font_size: None,
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
            "SELECT app_id, app_secret, encrypt_key, verification_token, chat_id, project_path, open_id, hook_events_filter, app_name, anthropic_logo_img_key, terminal_bg_color, terminal_fg_color, terminal_font_size
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
        "INSERT INTO app_config_feishu (id, app_id, app_secret, encrypt_key, verification_token, chat_id, project_path, open_id, hook_events_filter, app_name, terminal_bg_color, terminal_fg_color, terminal_font_size, updated_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
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
           terminal_bg_color = excluded.terminal_bg_color,
           terminal_fg_color = excluded.terminal_fg_color,
           terminal_font_size = excluded.terminal_font_size,
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
            config.terminal_bg_color,
            config.terminal_fg_color,
            config.terminal_font_size,
            now
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 处理来自飞书的权限决策回复，写入 SQLite 供 CLI hook 读取
pub fn handle_permission_decision(code: &str, choice: &str, message_id: &str) -> Result<(), String> {
    let conn = open_db()?;

    // 防止重复处理相同的权限决策消息
    if !message_id.is_empty() {
        let count: i64 = conn.query_row(
            "SELECT COUNT(1) FROM pty_commands WHERE message_id = ?1",
            rusqlite::params![message_id],
            |row| row.get(0)
        ).unwrap_or(0);

        if count > 0 {
            log::info!("Permission message ID {} already processed, skipping duplicate.", message_id);
            return Ok(());
        }
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;

    let result: Option<(i64, String)> = conn.query_row(
        "SELECT id, project_path FROM permission_requests WHERE code = ?1 AND status = 'pending' LIMIT 1",
        rusqlite::params![code],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional().map_err(|e| e.to_string())?;

    let (req_id, project_path) = result.ok_or_else(|| format!("No pending request for code {}", code))?;

    // Map choice to ANSI sequence for interactive menus in terminal
    let ansi_command = if let Ok(n) = choice.parse::<usize>() {
        if n > 0 && n <= 50 {
            let arrows = "\x1b[B".repeat(n - 1);
            format!("{}\r", arrows)
        } else {
            choice.to_string()
        }
    } else {
        choice.to_string()
    };

    conn.execute(
        "UPDATE permission_requests SET status = 'completed', choice = ?1 WHERE id = ?2",
        rusqlite::params![ansi_command, req_id],
    ).map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT INTO pty_commands (project_path, command, message_id, created_at) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![project_path, ansi_command, message_id, now],
    ).map_err(|e| e.to_string())?;

    log::info!("Permission decision: code={}, choice={}, project={}", code, choice, project_path);
    Ok(())
}

/// 将非权限确认的普通消息转发到终端
pub fn forward_message_to_pty(app: tauri::AppHandle, message: &str, message_id: &str, open_id: &str) -> Result<(), String> {
    let state = app.state::<Arc<AppState>>();
    let pty_manager = app.state::<PtyManager>();

    let active_project = {
        let guard = state.active_project.lock().unwrap();
        guard.clone()
    };

    // 如果还没有记录活跃项目且终端有正在运行的，尝试通过 pty_manager 获取
    let _active_project = active_project.or_else(|| {
        let fallback = pty_manager.get_active_projects().first().cloned();
        if let Some(ref p) = fallback {
            log::info!("No active project in AppState, using first available from PTY manager: {}", p);
        }
        fallback
    });

    let conn = open_db()?;

    // 防止重复转发同一消息
    if !message_id.is_empty() {
        let count: i64 = conn.query_row(
            "SELECT COUNT(1) FROM pty_commands WHERE message_id = ?1",
            rusqlite::params![message_id],
            |row| row.get(0)
        ).unwrap_or(0);

        if count > 0 {
            log::info!("Message ID {} already forwarded, skipping duplicate.", message_id);
            return Ok(());
        }
    }

    let active_projects = pty_manager.get_active_projects();

    if active_projects.is_empty() {
        return Err("当前没有运行中的终端".to_string());
    }

    // 解析 "<序号>::<命令>" 格式
    let mut target_project_path: Option<String> = None;
    let mut final_command = message.trim().to_string();

    if let Some(pos) = message.find("::") {
        let prefix = &message[..pos].trim();
        if let Ok(index) = prefix.parse::<usize>() {
            if index > 0 {
                // 处理从 1 开始的序号
                let selections = state.pending_selections.lock().unwrap();
                if let Some(list) = selections.get(open_id) {
                    if index <= list.len() {
                        target_project_path = Some(list[index - 1].clone());
                        final_command = message[pos + 2..].trim().to_string();
                    }
                } else if index <= active_projects.len() {
                    target_project_path = Some(active_projects[index - 1].clone());
                    final_command = message[pos + 2..].trim().to_string();
                }
            }
        }
    }

    // 如果还没有确定目标路径，且有多个活跃项目，需要用户选择
    if target_project_path.is_none() {
        if active_projects.len() > 1 {
            // 发送选择列表
            let mut reply = String::from("检测到多个运行中的终端，请使用 `序号::命令` 或回复 `序号` 来选择目标:\n ");
            for (i, path) in active_projects.iter().enumerate() {
                let name = path.split('/').last().unwrap_or(path);
                reply.push_str(&format!("{}: {}\n ", i + 1, name));
            }
            
            // 更新该用户的待选列表
            {
                let mut selections = state.pending_selections.lock().unwrap();
                selections.insert(open_id.to_string(), active_projects.clone());
            }

            // 发送消息回飞书
            let app_clone = app.clone();
            let open_id_clone = open_id.to_string();
            tokio::spawn(async move {
                let config = {
                    let s = app_clone.state::<Arc<AppState>>();
                    let conf_guard = s.config.lock().await;
                    conf_guard.as_ref().cloned()
                };

                if let Some(c) = config {
                    let client = crate::feishu_client::FeishuClient::new(c.app_id, c.app_secret);
                    let _ = client.send_text_message(&open_id_clone, &reply).await;
                }
            });

            return Ok(());
        } else {
            // 只有一个活跃项目，直接转发
            target_project_path = Some(active_projects[0].clone());
        }
    }

    let project_path = target_project_path.unwrap();

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;

    // 确定命令以换行符结尾
    if !final_command.ends_with('\n') && !final_command.ends_with('\r') {
        final_command.push('\n');
    }

    conn.execute(
        "INSERT INTO pty_commands (project_path, command, message_id, created_at) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![project_path, final_command, message_id, now],
    ).map_err(|e| e.to_string())?;

    log::info!("[db:forward] Forwarded message {} to pty for project='{}'", message_id, project_path);
    Ok(())
}



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

/// 上传 Anthropic logo 到飞书，获取 img_key 并保存到 SQLite
#[tauri::command(rename_all = "snake_case")]
async fn upload_anthropic_logo() -> Result<String, String> {
    let config = get_config()?;

    // 获取 token
    let client = reqwest::Client::new();
    let token_result: serde_json::Value = client
        .post("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal")
        .json(&serde_json::json!({ "app_id": config.app_id, "app_secret": config.app_secret }))
        .send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;
    let token = token_result["tenant_access_token"].as_str()
        .ok_or("Failed to get tenant_access_token")?;

    // Anthropic logo PNG (32x32, base64 encoded)
    let logo_b64 = "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";
    let logo_bytes = base64::engine::general_purpose::STANDARD.decode(logo_b64)
        .map_err(|e| e.to_string())?;

    // 上传到飞书
    let part = reqwest::multipart::Part::bytes(logo_bytes)
        .file_name("anthropic_logo.png")
        .mime_str("image/png").map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new()
        .text("image_type", "message")
        .part("image", part);

    let upload_result: serde_json::Value = client
        .post("https://open.feishu.cn/open-apis/im/v1/images")
        .header("Authorization", format!("Bearer {}", token))
        .multipart(form)
        .send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;

    if upload_result["code"].as_i64().unwrap_or(-1) != 0 {
        return Err(format!("Upload failed: {}", upload_result["msg"].as_str().unwrap_or("unknown")));
    }

    let img_key = upload_result["data"]["image_key"].as_str()
        .ok_or("No image_key in response")?
        .to_string();

    // 保存到 SQLite
    let conn = open_db()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;
    conn.execute(
        "UPDATE app_config_feishu SET anthropic_logo_img_key = ?1, updated_at = ?2 WHERE id = 1",
        params![img_key, now],
    ).map_err(|e| e.to_string())?;

    log::info!("[feishu] Anthropic logo uploaded, img_key={}", img_key);
    Ok(img_key)
}

#[tauri::command(rename_all = "snake_case")]
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

#[tauri::command(rename_all = "snake_case")]
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

#[tauri::command(rename_all = "snake_case")]
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

#[tauri::command(rename_all = "snake_case")]
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

#[tauri::command(rename_all = "snake_case")]
fn get_config() -> Result<AppConfig, String> {
    let conn = open_db()?;
    if let Some(config) = load_config_from_db(&conn)? {
        Ok(config)
    } else {
        Ok(AppConfig::default())
    }
}

#[tauri::command(rename_all = "snake_case")]
fn save_config(config: AppConfig) -> Result<(), String> {
    let conn = open_db()?;
    upsert_config(&conn, &config)?;
    Ok(())
}

pub fn find_executable(cmd_name: &str) -> Option<String> {
    // 1. Try standard which (relies on current PATH)
    if let Ok(out) = std::process::Command::new("which").arg(cmd_name).output() {
        if out.status.success() {
            if let Ok(path) = String::from_utf8(out.stdout) {
                let path = path.trim().to_string();
                if std::path::Path::new(&path).exists() {
                    return Some(path);
                }
            }
        }
    }
    
    // 2. Fallback to common global Unix paths
    let common_paths = ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"];
    for dir in common_paths.iter() {
        let p = std::path::Path::new(dir).join(cmd_name);
        if p.exists() {
            return Some(p.to_string_lossy().to_string());
        }
    }
    
    // 3. Fallback to user-specific installation paths (NVM, npm, cargo)
    if let Some(home) = dirs::home_dir() {
        // NVM (Node Version Manager) paths
        let nvm_node_dir = home.join(".nvm/versions/node");
        if nvm_node_dir.exists() {
            if let Ok(entries) = std::fs::read_dir(nvm_node_dir) {
                for entry in entries.filter_map(Result::ok) {
                    let p = entry.path().join("bin").join(cmd_name);
                    if p.exists() {
                        return Some(p.to_string_lossy().to_string());
                    }
                }
            }
        }
        
        let npm_global = home.join(".npm-global/bin").join(cmd_name);
        if npm_global.exists() { return Some(npm_global.to_string_lossy().to_string()); }
        
        let cargo_bin = home.join(".cargo/bin").join(cmd_name);
        if cargo_bin.exists() { return Some(cargo_bin.to_string_lossy().to_string()); }
    }
    
    // 4. Final fallback: Execute a login shell to get the resolved PATH
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "sh".to_string());
    if let Ok(out) = std::process::Command::new(&shell)
        .arg("-lc")
        .arg(format!("which {}", cmd_name))
        .output() 
    {
        if out.status.success() {
            if let Ok(output_str) = String::from_utf8(out.stdout) {
                for line in output_str.lines() {
                    let line = line.trim();
                    if line.starts_with('/') && std::path::Path::new(line).exists() {
                        return Some(line.to_string());
                    }
                }
            }
        }
    }
    
    None
}

#[tauri::command(rename_all = "snake_case")]
fn check_file_exists(file_path: String) -> Result<bool, String> {
    let path = std::path::Path::new(&file_path);
    // Strip :line:col suffix if present (e.g. path/to/file.tsx:650)
    let clean_path_str = file_path.split(':').next().unwrap_or(&file_path);
    let clean_path = std::path::Path::new(clean_path_str);
    Ok(clean_path.exists())
}

#[tauri::command(rename_all = "snake_case")]
async fn open_in_coder(file_path: String) -> Result<(), String> {
    log::info!("Attempting to open file in code-server: {}", file_path);
    let cmd_path = find_executable("code-server").unwrap_or_else(|| "code-server".to_string());
    let output = std::process::Command::new(cmd_path)
        .args(["-r", &file_path])
        .output()
        .map_err(|e| {
            let err_msg = format!("Failed to execute code-server command: {}", e);
            log::error!("{}", err_msg);
            err_msg
        })?;

    if output.status.success() {
        log::info!("code-server command executed successfully for path: {}", file_path);
        Ok(())
    } else {
        let err_msg = format!(
            "code-server exited with error: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        log::error!("{}", err_msg);
        Err(err_msg)
    }
}

#[tauri::command(rename_all = "snake_case")]
fn open_folder(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct McpStatus {
    installed: bool,
    running: bool,
    path: String,
}

#[tauri::command(rename_all = "snake_case")]
fn run_curl_command(command: String, cwd: String) -> Result<String, String> {
    let output = std::process::Command::new("sh")
        .arg("-c")
        .arg(&command)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to execute command: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !stderr.is_empty() && stdout.is_empty() {
        Ok(format!("[stderr]\n{}", stderr))
    } else if !stderr.is_empty() {
        Ok(format!("{}\n\n[stderr]\n{}", stdout, stderr))
    } else {
        Ok(stdout)
    }
}

#[tauri::command(rename_all = "snake_case")]
fn check_mcp_status() -> Result<McpStatus, String> {
    // Check if chrome-devtools-mcp is installed
    // Use login shell (-lc) so user's PATH (including npm global bin) is available in release builds
    let which_output = std::process::Command::new("sh")
        .arg("-lc")
        .arg("which chrome-devtools-mcp 2>/dev/null || echo ''")
        .output()
        .map_err(|e| format!("Failed to check MCP installation: {}", e))?;
    let path = String::from_utf8_lossy(&which_output.stdout).trim().to_string();
    let installed = !path.is_empty();

    // Check if chrome-devtools-mcp is running
    let pgrep_output = std::process::Command::new("sh")
        .arg("-lc")
        .arg("pgrep -f chrome-devtools-mcp 2>/dev/null")
        .output()
        .map_err(|e| format!("Failed to check MCP process: {}", e))?;
    let running = pgrep_output.status.success()
        && !String::from_utf8_lossy(&pgrep_output.stdout).trim().is_empty();

    Ok(McpStatus {
        installed,
        running,
        path,
    })
}

#[tauri::command(rename_all = "snake_case")]
fn start_mcp_server() -> Result<String, String> {
    // First check if already running
    let pgrep_output = std::process::Command::new("sh")
        .arg("-lc")
        .arg("pgrep -f chrome-devtools-mcp 2>/dev/null")
        .output()
        .map_err(|e| format!("Failed to check MCP process: {}", e))?;

    if pgrep_output.status.success()
        && !String::from_utf8_lossy(&pgrep_output.stdout).trim().is_empty()
    {
        return Ok("chrome-devtools-mcp 已经在运行中".to_string());
    }

    // Start chrome-devtools-mcp in background
    // Use login shell so PATH includes npm global bin
    std::process::Command::new("sh")
        .arg("-lc")
        .arg("nohup chrome-devtools-mcp > /tmp/chrome-devtools-mcp.log 2>&1 &")
        .spawn()
        .map_err(|e| format!("Failed to start MCP server: {}", e))?;

    // Wait a moment for startup
    std::thread::sleep(std::time::Duration::from_millis(500));

    // Verify it started
    let verify = std::process::Command::new("sh")
        .arg("-lc")
        .arg("pgrep -f chrome-devtools-mcp 2>/dev/null")
        .output()
        .map_err(|e| format!("Failed to verify MCP process: {}", e))?;

    if verify.status.success() && !String::from_utf8_lossy(&verify.stdout).trim().is_empty() {
        Ok("chrome-devtools-mcp 启动成功".to_string())
    } else {
        Err("chrome-devtools-mcp 启动失败，请检查日志: /tmp/chrome-devtools-mcp.log".to_string())
    }
}

#[tauri::command(rename_all = "snake_case")]
fn get_testing_session(project_path: String) -> Result<Option<String>, String> {
    let conn = open_db()?;
    let result = conn.query_row(
        "SELECT session_id FROM testing_sessions WHERE project_path = ?1",
        params![project_path],
        |row| row.get::<_, String>(0),
    );
    match result {
        Ok(session_id) => Ok(Some(session_id)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command(rename_all = "snake_case")]
fn save_testing_session(project_path: String, session_id: String) -> Result<(), String> {
    let conn = open_db()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;
    conn.execute(
        "INSERT INTO testing_sessions (project_path, session_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?3)
         ON CONFLICT(project_path) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at",
        params![project_path, session_id, now],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn build_hook_command() -> Result<String, String> {
    if let Ok(cmd) = std::env::var("CLAUDE_MONITOR_HOOK_COMMAND") {
        if !cmd.trim().is_empty() {
            return Ok(cmd);
        }
    }

    // Windows 上可执行文件名带 .exe 后缀
    #[cfg(target_os = "windows")]
    let cli_bin_name = "sparky-server.exe";
    #[cfg(not(target_os = "windows"))]
    let cli_bin_name = "sparky-server";

    // 1. ~/sparky/sparky（release 安装路径）
    if let Some(home) = dirs::home_dir() {
        let installed = home.join("sparky").join(cli_bin_name);
        if installed.exists() {
            return Ok(format!("{} hook", installed.to_string_lossy()));
        }
    }

    // 2. 从 Tauri exe 向上找 src-tauri（开发模式）
    if let Ok(exe_path) = std::env::current_exe() {
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
    }

    // 3. fallback: PATH
    Ok(format!("{} hook", cli_bin_name))
}

#[tauri::command(rename_all = "snake_case")]
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

#[tauri::command(rename_all = "snake_case")]
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
                        "command": hook_command.clone()
                    }
                ]
            }
        ],
        "SessionStart": [
            {
                "hooks": [
                    {
                        "type": "command",
                        "command": hook_command.clone()
                    }
                ]
            }
        ],
        "SessionEnd": [
            {
                "hooks": [
                    {
                        "type": "command",
                        "command": hook_command.clone()
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
            for key in ["Notification", "PermissionRequest", "Stop", "UserPromptSubmit", "SessionStart", "SessionEnd"] {
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

fn check_agent_teams_enabled_for_path(project_path: &str) -> Result<bool, String> {
    let agents_dir = std::path::Path::new(project_path)
        .join(".claude")
        .join("agents");
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

#[tauri::command(rename_all = "snake_case")]
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
        obj.remove("SessionStart");
        obj.remove("SessionEnd");
        obj.remove("hooks");
    }

    let new_content = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;

    fs::write(&settings_path, new_content)
        .map_err(|e| format!("Failed to write settings: {}", e))?;

    log::info!("Hooks uninstalled successfully");
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
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

#[tauri::command(rename_all = "snake_case")]
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

#[tauri::command(rename_all = "snake_case")]
async fn notify_project_active(
    project_name: String,
    project_path: String,
    manager: tauri::State<'_, PtyManager>,
) -> Result<(), String> {
    let config = get_config()?;
    let (receive_id, receive_id_type) = if let Some(id) = config.chat_id.filter(|id| !id.is_empty()) {
        (id, "chat_id")
    } else if let Some(id) = config.open_id.filter(|id| !id.is_empty()) {
        (id, "open_id")
    } else {
        return Err("No chat_id or open_id configured".to_string());
    };

    let client = reqwest::Client::new();
    let token_url = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";
    let token_result: serde_json::Value = client
        .post(token_url)
        .json(&serde_json::json!({ "app_id": config.app_id, "app_secret": config.app_secret }))
        .send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;
    let token = token_result["tenant_access_token"].as_str()
        .ok_or("Failed to get tenant_access_token")?;

    let mut index_prefix = String::new();
    if let Ok(conn) = open_db() {
        if let Ok(mut stmt) = conn.prepare("SELECT id FROM projects WHERE path = ?1 LIMIT 1") {
            if let Ok(mut rows) = stmt.query(rusqlite::params![project_path]) {
                if let Ok(Some(row)) = rows.next() {
                    if let Ok(id) = row.get::<_, i64>(0) {
                        index_prefix = format!("【项目::{}】", id);
                    }
                }
            }
        }
    }
    
    let title_text = format!("{}【{}】项目进入开发状态～", index_prefix, project_name);

    let img_key = config.anthropic_logo_img_key.as_deref().unwrap_or("");
    let content = if img_key.is_empty() {
        serde_json::json!({
            "config": { "wide_screen_mode": true },
            "elements": [{ "tag": "div", "text": { "content": format!("**{}**", title_text), "tag": "lark_md" } }]
        })
    } else {
        serde_json::json!({
            "config": { "wide_screen_mode": true },
            "header": {
                "title": { "content": title_text, "tag": "plain_text" },
                "icon": { "tag": "img", "img_key": img_key },
                "template": "blue"
            },
            "elements": []
        })
    };
    let result: serde_json::Value = client
        .post("https://open.feishu.cn/open-apis/im/v1/messages")
        .header("Authorization", format!("Bearer {}", token))
        .query(&[("receive_id_type", receive_id_type)])
        .json(&serde_json::json!({
            "receive_id": receive_id,
            "msg_type": "interactive",
            "content": content.to_string()
        }))
        .send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;

    if result["code"].as_i64().unwrap_or(-1) != 0 {
        return Err(format!("Feishu error: {}", result["msg"].as_str().unwrap_or("unknown")));
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
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

#[tauri::command(rename_all = "snake_case")]
fn delete_hook_record(project_path: String, id: i64) -> Result<(), String> {
    let conn = open_db()?;
    let table_name = project_hooks_table_name(&project_path);
    ensure_project_hooks_table(&conn, &table_name)?;
    let delete_sql = format!("DELETE FROM {} WHERE id = ?1", table_name);
    conn.execute(&delete_sql, params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
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

#[tauri::command(rename_all = "snake_case")]
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

#[tauri::command(rename_all = "snake_case")]
fn get_project_sessions(project_path: String) -> Result<Vec<SessionInfo>, String> {
    let conn = open_db()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, project_path, started_at, ended_at, reason, name, project_name
             FROM sessions
             WHERE project_path = ?1
             ORDER BY started_at DESC
             LIMIT 50"
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

#[tauri::command(rename_all = "snake_case")]
fn update_session_name(session_id: String, name: String) -> Result<(), String> {
    let conn = open_db()?;
    conn.execute(
        "UPDATE sessions SET name = ?1 WHERE session_id = ?2",
        params![name, session_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
fn delete_session(session_id: String) -> Result<(), String> {
    let conn = open_db()?;
    conn.execute(
        "DELETE FROM sessions WHERE session_id = ?1",
        params![session_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
fn get_latest_claude_jsonl(project_path: String) -> Result<String, String> {
    let escaped_path = project_path.replace("/", "-");
    let claude_dir = dirs::home_dir()
        .ok_or("Could not find home directory")?
        .join(".claude")
        .join("projects")
        .join(&escaped_path);
    
    eprintln!("[get_latest_claude_jsonl] project_path={}, escaped={}, claude_dir={}", project_path, escaped_path, claude_dir.display());
    
    if !claude_dir.exists() {
        eprintln!("[get_latest_claude_jsonl] Directory does not exist: {}", claude_dir.display());
        return Ok("".to_string());
    }
    
    let mut latest_file = None;
    let mut latest_time = std::time::SystemTime::UNIX_EPOCH;
    
    if let Ok(entries) = std::fs::read_dir(&claude_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("jsonl") {
                // Ignore agent jsonl files which are metadata only
                if path.file_name().and_then(|n| n.to_str()).map(|n| n.starts_with("agent-")).unwrap_or(false) {
                    continue;
                }
                if let Ok(meta) = entry.metadata() {
                    if let Ok(modified) = meta.modified() {
                        if modified > latest_time {
                            latest_time = modified;
                            latest_file = Some(path);
                        }
                    }
                }
            }
        }
    }
    
    if let Some(path) = latest_file {
        std::fs::read_to_string(&path).map_err(|e| e.to_string())
    } else {
        Ok("".to_string())
    }
}

#[tauri::command(rename_all = "snake_case")]
fn get_agent_teams_status(project_path: String) -> Result<bool, String> {
    check_agent_teams_enabled_for_path(&project_path)
}

#[tauri::command(rename_all = "snake_case")]
fn toggle_agent_teams(project_path: String) -> Result<bool, String> {
    let settings_path = std::path::Path::new(&project_path)
        .join(".claude")
        .join("settings.local.json");
    
    let mut config: serde_json::Value = if settings_path.exists() {
        let content = fs::read_to_string(&settings_path).unwrap_or_else(|_| "{}".to_string());
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    let current = config.get("features")
        .and_then(|f| f.get("agent_teams"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let next_value = !current;

    if config.get("features").is_none() || !config["features"].is_object() {
        config["features"] = serde_json::json!({});
    }
    config["features"]["agent_teams"] = serde_json::json!(next_value);

    let new_content = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    
    if let Some(parent) = settings_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&settings_path, new_content).map_err(|e| e.to_string())?;

    // Handle the creation / deletion of sub-agents files
    let agents_dir = std::path::Path::new(&project_path)
        .join(".claude")
        .join("agents");

    if next_value {
        // Enable: create files
        if let Err(e) = fs::create_dir_all(&agents_dir) {
            log::error!("Failed to create agents directory {:?}: {}", agents_dir, e);
        } else {
            let agents = vec![
                (
                    "architect.md",
                    r#"---
name: architect
description: Use for system design, feature planning, refactoring strategy, and task decomposition before implementation.
model: sonnet
maxTurns: 2
---

You are a senior software architect.

Responsibilities:
- Define system boundaries
- Propose module structure
- Define APIs and data flow
- Identify technical risks
- Break large tasks into actionable steps

Rules:
- Do NOT write production code.
- Provide structured sections.
- Keep output concise and implementation-ready."#,
                ),
                (
                    "implementer.md",
                    r#"---
name: implementer
description: Use when writing new code or implementing a planned module.
model: sonnet
maxTurns: 3
tools: Read, Write, Edit, Glob, Grep
---

You are a senior software engineer.

Responsibilities:
- Implement approved design
- Produce clean, maintainable, production-ready code
- Include error handling
- Follow best practices

Rules:
- Do not redesign architecture.
- Avoid unnecessary explanations.
- Output complete runnable units."#,
                ),
                (
                    "code-reviewer.md",
                    r#"---
name: code-reviewer
description: Use proactively after code changes to review quality, security, and maintainability.
model: sonnet
maxTurns: 2
tools: Read, Glob, Grep
disallowedTools: Write, Edit
---

You are a strict code reviewer.

Review checklist:
- Security vulnerabilities
- Error handling completeness
- Resource management
- Concurrency risks
- Code readability
- Performance issues

Output format:
- Critical issues
- Major improvements
- Minor suggestions
- Optional optimizations"#,
                ),
                (
                    "debugger.md",
                    r#"---
name: debugger
description: Use when errors occur, tests fail, or unexpected behavior is observed.
model: haiku
maxTurns: 3
tools: Read, Grep, Glob, Bash
---

You are an expert debugger.

Responsibilities:
- Identify root cause
- Reproduce issue logically
- Suggest minimal fix
- Avoid speculative redesign

Output:
- Root cause
- Fix proposal
- Risk assessment"#,
                ),
                (
                    "test-writer.md",
                    r#"---
name: test-writer
description: Use to create unit tests, integration tests, or edge-case coverage.
model: sonnet
maxTurns: 2
tools: Read, Write, Edit
---

You are a test engineer.

Responsibilities:
- Write deterministic tests
- Cover edge cases
- Ensure meaningful assertions
- Avoid redundant tests

Prefer:
- Isolated unit tests
- Clear naming
- Small fixtures"#,
                ),
                (
                    "refactorer.md",
                    r#"---
name: refactorer
description: Use when improving structure, readability, or performance without changing behavior.
model: sonnet
maxTurns: 2
tools: Read, Write, Edit
---

You are a refactoring specialist.

Responsibilities:
- Improve structure
- Reduce duplication
- Simplify logic
- Preserve behavior

Rules:
- Do not change functionality.
- Provide diff-style changes when possible."#,
                ),
            ];

            for (filename, content) in agents {
                let file_path = agents_dir.join(filename);
                if let Err(e) = fs::write(&file_path, content) {
                    log::error!("Failed to write agent file {:?}: {}", file_path, e);
                }
            }
        }
    } else {
        // Disable: delete files
        let agent_files = vec![
            "architect.md",
            "implementer.md",
            "code-reviewer.md",
            "debugger.md",
            "test-writer.md",
            "refactorer.md",
        ];

        for filename in agent_files {
            let file_path = agents_dir.join(filename);
            if file_path.exists() {
                if let Err(e) = fs::remove_file(&file_path) {
                    log::error!("Failed to delete agent file {:?}: {}", file_path, e);
                }
            }
        }
    }

    Ok(next_value)
}

#[tauri::command(rename_all = "snake_case")]
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
                agent_teams_enabled: false,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut projects = Vec::new();
    for project in rows {
        let mut item = project.map_err(|e| e.to_string())?;
        
        // Agent teams dynamic evaluation for per-project setting
        item.agent_teams_enabled = check_agent_teams_enabled_for_path(&item.path).unwrap_or(false);
        
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

#[tauri::command(rename_all = "snake_case")]
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
    let agent_teams_enabled = check_agent_teams_enabled_for_path(&path).unwrap_or(false);

    Ok(Project {
        id,
        name,
        path,
        hooks_installed,
        agent_teams_enabled,
        created_at: now,
        updated_at: now,
    })
}

#[tauri::command(rename_all = "snake_case")]
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

#[tauri::command(rename_all = "snake_case")]
fn delete_project(id: i64) -> Result<(), String> {
    let conn = open_db()?;
    conn.execute("DELETE FROM projects WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
async fn get_active_projects(manager: tauri::State<'_, PtyManager>) -> Result<Vec<String>, String> {
    Ok(manager.get_active_projects())
}

#[tauri::command(rename_all = "snake_case")]
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

#[tauri::command(rename_all = "snake_case")]
async fn set_active_project(state: tauri::State<'_, Arc<AppState>>, project_path: String) -> Result<(), String> {
    log::info!("Setting active project to: {}", project_path);
    let mut active = state.active_project.lock().unwrap();
    *active = Some(project_path);
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
async fn set_active_terminal_id(state: tauri::State<'_, Arc<AppState>>, terminal_id: String) -> Result<(), String> {
    log::info!("Setting active terminal ID to: {}", terminal_id);
    let mut active = state.active_terminal_id.lock().unwrap();
    *active = Some(terminal_id);
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
async fn save_window_size(window: tauri::Window) -> Result<(), String> {
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let conn = open_db()?;
    
    conn.execute(
        "INSERT INTO db_meta (key, value) VALUES ('window_width', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![size.width.to_string()],
    ).map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT INTO db_meta (key, value) VALUES ('window_height', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![size.height.to_string()],
    ).map_err(|e| e.to_string())?;

    log::info!("Saved window size: {}x{}", size.width, size.height);
    Ok(())
}
#[derive(Serialize)]
pub struct DependencyStatus {
    pub claude: bool,
    pub code_server: bool,
}

#[tauri::command(rename_all = "snake_case")]
async fn install_code_server() -> Result<String, String> {
    log::info!("Attempting to install code-server via brew");
    let output = std::process::Command::new("sh")
        .arg("-lc")
        .arg("brew install code-server")
        .output()
        .map_err(|e| format!("Failed to execute brew install: {}", e))?;

    if output.status.success() {
        Ok("code-server installed successfully".to_string())
    } else {
        let err_msg = String::from_utf8_lossy(&output.stderr).to_string();
        Err(format!("Install failed: {}", err_msg))
    }
}

#[tauri::command(rename_all = "snake_case")]
fn check_dependencies() -> Result<DependencyStatus, String> {
    Ok(DependencyStatus {
        claude: find_executable("claude").is_some(),
        code_server: find_executable("code-server").is_some(),
    })
}

#[tauri::command(rename_all = "snake_case")]
fn check_code_server_connection() -> bool {
    // Check if code-server is responding on port 18080
    match TcpStream::connect_timeout(
        &"127.0.0.1:18080".parse().expect("Invalid address"),
        Duration::from_millis(500),
    ) {
        Ok(_) => true,
        Err(_) => false,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let (event_tx, _event_rx) = mpsc::channel::<String>(100);
    let state = Arc::new(AppState {
        config: Arc::new(Mutex::new(None)),
        event_tx,
        active_project: Arc::new(std::sync::Mutex::new(None)),
        pending_selections: Arc::new(std::sync::Mutex::new(HashMap::new())),
        active_terminal_id: Arc::new(std::sync::Mutex::new(None)),
    });

    let ws_connected = Arc::new(AtomicBool::new(false));

    tauri::Builder::default()
        .manage(state)
        .manage(PtyManager::new())
        .manage(WsConnectionState(ws_connected.clone()))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            
            // 将 sparky 二进制复制到 ~/sparky/ 供 hooks 使用
            if let Ok(exe_path) = std::env::current_exe() {
                // 在 .app bundle 里，sparky CLI 与 Tauri exe 同目录
                // Windows 上可执行文件名带 .exe 后缀
                #[cfg(target_os = "windows")]
                let sparky_src = exe_path.parent().map(|p| p.join("sparky-server.exe"));
                #[cfg(not(target_os = "windows"))]
                let sparky_src = exe_path.parent().map(|p| p.join("sparky-server"));
                if let Some(src) = sparky_src {
                    if src.exists() {
                        if let Some(home) = dirs::home_dir() {
                            let dest_dir = home.join("sparky");
                            // Windows 目标文件名也带 .exe 后缀
                            #[cfg(target_os = "windows")]
                            let dest = dest_dir.join("sparky-server.exe");
                            #[cfg(not(target_os = "windows"))]
                            let dest = dest_dir.join("sparky-server");
                            if let Err(e) = std::fs::create_dir_all(&dest_dir) {
                                log::error!("Failed to create ~/sparky dir: {}", e);
                            } else if let Err(e) = std::fs::copy(&src, &dest) {
                                log::error!("Failed to copy sparky-server binary: {}", e);
                            } else {
                                // 确保可执行权限
                                #[cfg(unix)]
                                {
                                    use std::os::unix::fs::PermissionsExt;
                                    let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755));
                                }
                                log::info!("sparky binary installed to {:?}", dest);
                            }
                        }
                    }
                }
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

            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                log::info!("Starting code-server on 127.0.0.1:18080...");
                let cmd_path = find_executable("code-server").unwrap_or_else(|| "code-server".to_string());
                
                use tauri::Manager;
                // Get the path to our bundled extensions using Tauri's path resolver
                // and copy them to ~/sparky/extensions on every startup to ensure we have the latest version.
                // This ensures we have a writable, unified extensions directory and prevents old cached versions from persisting.
                let ext_dir = dirs::home_dir()
                    .map(|h| h.join("sparky").join("extensions"))
                    .unwrap_or_else(|| std::path::PathBuf::from("extensions"));
                
                if let Ok(resource_ext_dir) = app_handle.path().resource_dir().map(|p| p.join("extensions")) {
                    if resource_ext_dir.exists() {
                        log::info!("Syncing bundled extensions from {:?} to {:?}", resource_ext_dir, ext_dir);
                        let _ = std::fs::create_dir_all(&ext_dir);
                        
                        // Use cp -Rf to copy everything from resource_ext_dir into ext_dir
                        // We use the contents of resource_ext_dir (/*) to copy into ext_dir
                        let _ = std::process::Command::new("cp")
                            .args(["-Rf", &format!("{}/.", resource_ext_dir.to_string_lossy()), &ext_dir.to_string_lossy()])
                            .status();
                    }
                }
                    
                match std::process::Command::new(cmd_path)
                    .args([
                        "--auth", "none", 
                        "--bind-addr", "127.0.0.1:18080",
                        "--extensions-dir", &ext_dir.to_string_lossy(),
                        "--locale", "zh-cn"
                    ])
                    .stdout(std::process::Stdio::inherit())
                    .stderr(std::process::Stdio::inherit())
                    .spawn()
                {
                    Ok(mut child) => {
                        log::info!("code-server started successfully with PID: {}", child.id());
                        let status = child.wait();
                        log::error!("code-server exited unexpectedly with status: {:?}", status);
                    },
                    Err(e) => log::error!("Failed to start code-server: {}", e),
                }
            });

            // Start HTTP listener for extension -> terminal communication
            let app_handle_for_http = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                use tokio::net::TcpListener;
                use tokio::io::{AsyncReadExt, AsyncWriteExt};

                let listener = match TcpListener::bind("127.0.0.1:18081").await {
                    Ok(l) => {
                        log::info!("Extension HTTP endpoint listening on 127.0.0.1:18081");
                        l
                    }
                    Err(e) => {
                        log::error!("Failed to bind extension HTTP listener: {}", e);
                        return;
                    }
                };

                loop {
                    let (mut stream, _) = match listener.accept().await {
                        Ok(s) => s,
                        Err(e) => {
                            log::error!("Failed to accept connection: {}", e);
                            continue;
                        }
                    };

                    let app = app_handle_for_http.clone();
                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 8192];
                        let mut request = Vec::new();

                        // Read the full request
                        loop {
                            match stream.read(&mut buf).await {
                                Ok(0) => break,
                                Ok(n) => {
                                    request.extend_from_slice(&buf[..n]);
                                    // Check if we have the full request (headers + body)
                                    let req_str = String::from_utf8_lossy(&request);
                                    if let Some(header_end) = req_str.find("\r\n\r\n") {
                                        // Check Content-Length
                                        let headers = &req_str[..header_end];
                                        if let Some(cl_line) = headers.lines().find(|l| l.to_lowercase().starts_with("content-length:")) {
                                            if let Ok(cl) = cl_line.split(':').nth(1).unwrap_or("0").trim().parse::<usize>() {
                                                let body_start = header_end + 4;
                                                if request.len() >= body_start + cl {
                                                    break;
                                                }
                                                continue;
                                            }
                                        }
                                        break;
                                    }
                                }
                                Err(_) => break,
                            }
                        }

                        let req_str = String::from_utf8_lossy(&request).to_string();

                        // Parse method and path
                        let first_line = req_str.lines().next().unwrap_or("");
                        let is_post_send = first_line.starts_with("POST /send-to-terminal");
                        let is_options = first_line.starts_with("OPTIONS");

                        let cors_headers = "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\n";

                        if is_options {
                            let response = format!("HTTP/1.1 204 No Content\r\n{}\r\n", cors_headers);
                            let _ = stream.write_all(response.as_bytes()).await;
                            return;
                        }

                        if !is_post_send {
                            let response = format!("HTTP/1.1 404 Not Found\r\n{}Content-Length: 9\r\n\r\nNot Found", cors_headers);
                            let _ = stream.write_all(response.as_bytes()).await;
                            return;
                        }

                        // Extract JSON body
                        let body = if let Some(pos) = req_str.find("\r\n\r\n") {
                            &req_str[pos + 4..]
                        } else {
                            ""
                        };

                        #[derive(Deserialize)]
                        struct SendRequest {
                            code: String,
                        }

                        let parsed: Result<SendRequest, _> = serde_json::from_str(body);
                        match parsed {
                            Ok(req) => {
                                let state = app.state::<Arc<AppState>>();
                                let terminal_id = state.active_terminal_id.lock().unwrap().clone();

                                if let Some(tid) = terminal_id {
                                    let manager = app.state::<PtyManager>();
                                    let safe_data = req.code.replace('\r', " ").replace('\n', " ");
                                    match manager.write(&tid, &safe_data) {
                                        Ok(_) => {
                                            log::info!("Extension sent code to terminal {}", tid);
                                            let response = format!("HTTP/1.1 200 OK\r\n{}Content-Type: application/json\r\nContent-Length: 15\r\n\r\n{{\"status\":\"ok\"}}", cors_headers);
                                            let _ = stream.write_all(response.as_bytes()).await;
                                        }
                                        Err(e) => {
                                            log::error!("Failed to write to terminal: {}", e);
                                            let body = format!("{{\"error\":\"{}\"}}", e);
                                            let response = format!("HTTP/1.1 500 Internal Server Error\r\n{}Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{}", cors_headers, body.len(), body);
                                            let _ = stream.write_all(response.as_bytes()).await;
                                        }
                                    }
                                } else {
                                    let body = "{\"error\":\"No active terminal\"}";
                                    let response = format!("HTTP/1.1 400 Bad Request\r\n{}Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{}", cors_headers, body.len(), body);
                                    let _ = stream.write_all(response.as_bytes()).await;
                                }
                            }
                            Err(e) => {
                                let body = format!("{{\"error\":\"Invalid JSON: {}\"}}", e);
                                let response = format!("HTTP/1.1 400 Bad Request\r\n{}Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{}", cors_headers, body.len(), body);
                                let _ = stream.write_all(response.as_bytes()).await;
                            }
                        }
                    });
                }
            });

            // 启动时自动连接飞书 WSS
            let app_handle_for_ws = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // 等待一小段时间让应用完全启动
                tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

                let config = get_config().ok();

                if let Some(config) = config {
                    if !config.app_id.is_empty() && !config.app_secret.is_empty() {
                        log::info!("Starting Feishu WebSocket connection...");
                        let client = FeishuWsClient::new_with_connected(
                            config.app_id.clone(),
                            config.app_secret.clone(),
                            ws_connected.clone(),
                            Some(app_handle_for_ws.clone()),
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

            // 应用保存的窗口大小（如果存在）
            if let Ok(conn) = open_db() {
                if let Ok(width_str) = conn.query_row("SELECT value FROM db_meta WHERE key = 'window_width'", [], |row| row.get::<_, String>(0)) {
                    if let Ok(height_str) = conn.query_row("SELECT value FROM db_meta WHERE key = 'window_height'", [], |row| row.get::<_, String>(0)) {
                        if let (Ok(width), Ok(height)) = (width_str.parse::<u32>(), height_str.parse::<u32>()) {
                            if let Some(main_window) = app.get_webview_window("main") {
                                let _ = main_window.set_size(tauri::PhysicalSize::new(width, height));
                                log::info!("Applied saved window size: {}x{}", width, height);
                            }
                        }
                    }
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            get_agent_teams_status,
            toggle_agent_teams,
            test_feishu_connection,
            send_feishu_message,
            upload_anthropic_logo,
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
            set_project_hooks_status,
            open_folder,
            check_file_exists,
            open_in_coder,
            get_ws_connected,
            notify_project_active,
            set_active_project,
            get_active_projects,
            save_window_size,
            get_project_sessions,
            run_curl_command,
            check_mcp_status,
            start_mcp_server,
            get_testing_session,
            save_testing_session,
            update_session_name,
            delete_session,
            check_dependencies,
            check_code_server_connection,
            install_code_server,
            get_latest_claude_jsonl,
            set_active_terminal_id
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
