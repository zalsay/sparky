use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::{mpsc, Mutex};
use rusqlite::{params, Connection};

mod websocket;
use websocket::FeishuWsClient;

mod pty;
use pty::{PtyManager, pty_spawn, pty_write, pty_kill, pty_resize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub app_id: String,
    pub app_secret: String,
    pub encrypt_key: Option<String>,
    pub verification_token: Option<String>,
    pub chat_id: Option<String>,
}

impl Default for AppConfig {
    fn default() -> Self {
        AppConfig {
            app_id: String::new(),
            app_secret: String::new(),
            encrypt_key: None,
            verification_token: None,
            chat_id: None,
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

fn get_config_path(app_handle: &tauri::AppHandle) -> PathBuf {
    let app_data_dir = app_handle.path().app_data_dir().expect("Failed to get app data dir");
    fs::create_dir_all(&app_data_dir).expect("Failed to create app data dir");
    app_data_dir.join("config.json")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WssStatus {
    pub last_receive_time: Option<i64>,
    pub last_open_id: Option<String>,
}

fn get_db_path() -> PathBuf {
    let config_dir = dirs::config_dir()
        .expect("Failed to get config directory")
        .join("com.claude.monitor");
    fs::create_dir_all(&config_dir).expect("Failed to create config directory");
    config_dir.join("hooks.db")
}

fn init_db(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS hook_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_name TEXT NOT NULL,
            session_id TEXT NOT NULL,
            notification_text TEXT NOT NULL,
            transcript_path TEXT NOT NULL,
            content TEXT NOT NULL,
            result TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )",
        [],
    )?;
    Ok(())
}

fn open_db() -> Result<Connection, String> {
    let conn = Connection::open(get_db_path()).map_err(|e| e.to_string())?;
    init_db(&conn).map_err(|e| e.to_string())?;
    Ok(conn)
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
fn get_config(app_handle: tauri::AppHandle) -> Result<AppConfig, String> {
    let config_path = get_config_path(&app_handle);
    
    if config_path.exists() {
        let config_str = fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read config: {}", e))?;
        let config: AppConfig = serde_json::from_str(&config_str)
            .map_err(|e| format!("Failed to parse config: {}", e))?;
        Ok(config)
    } else {
        Ok(AppConfig::default())
    }
}

#[tauri::command]
fn save_config(app_handle: tauri::AppHandle, config: AppConfig) -> Result<(), String> {
    let config_path = get_config_path(&app_handle);
    let config_str = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    fs::write(&config_path, config_str)
        .map_err(|e| format!("Failed to write config: {}", e))?;
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
fn get_hook_records(page: Option<u32>, page_size: Option<u32>) -> Result<HookRecordsResponse, String> {
    let conn = open_db()?;

    // 获取总数
    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM hook_records", [], |row| row.get(0))
        .unwrap_or(0);

    let page = page.unwrap_or(1).max(1);
    let page_size = page_size.unwrap_or(20).min(100);
    let offset = (page - 1) * page_size;

    let mut stmt = conn
        .prepare(
            "SELECT id, event_name, session_id, notification_text, transcript_path, content, result, created_at
             FROM hook_records
             ORDER BY created_at DESC
             LIMIT ?1 OFFSET ?2",
        )
        .map_err(|e| e.to_string())?;

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
fn delete_hook_record(id: i64) -> Result<(), String> {
    let conn = open_db()?;
    conn.execute("DELETE FROM hook_records WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_hook_records(ids: Vec<i64>) -> Result<(), String> {
    let conn = open_db()?;
    for id in ids {
        conn.execute("DELETE FROM hook_records WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn get_hook_status() -> Result<HookStatus, String> {
    let conn = open_db()?;
    let mut stmt = conn
        .prepare(
            "SELECT event_name, result, created_at
             FROM hook_records
             ORDER BY created_at DESC
             LIMIT 1",
        )
        .map_err(|e| e.to_string())?;

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
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // 启动时自动连接飞书 WSS
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // 等待一小段时间让应用完全启动
                tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

                // 读取配置文件获取 app_id 和 app_secret
                let config_path = app_handle.path().app_data_dir()
                    .map(|p| p.join("config.json"))
                    .ok();

                if let Some(path) = config_path {
                    if let Ok(content) = fs::read_to_string(&path) {
                        if let Ok(config) = serde_json::from_str::<AppConfig>(&content) {
                            if !config.app_id.is_empty() && !config.app_secret.is_empty() {
                                log::info!("Starting Feishu WebSocket connection...");
                                let client = FeishuWsClient::new(
                                    config.app_id.clone(),
                                    config.app_secret.clone(),
                                );

                                // 带重连机制的连接循环
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
                        }
                    }
                } else {
                    log::warn!("Config file not found, skipping WSS connection");
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
            pty_resize
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
