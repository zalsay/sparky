use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tracing::error;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub app_id: String,
    pub app_secret: String,
    pub encrypt_key: Option<String>,
    pub verification_token: Option<String>,
    pub chat_id: Option<String>,
    pub open_id: Option<String>,
    pub hook_events_filter: Option<String>,
    pub project_path: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            app_id: String::new(),
            app_secret: String::new(),
            encrypt_key: None,
            verification_token: None,
            chat_id: None,
            open_id: None,
            hook_events_filter: None,
            project_path: None,
        }
    }
}

fn get_db_path() -> PathBuf {
    let base_dir = dirs::home_dir()
        .expect("Failed to get home directory")
        .join("sparky");
    fs::create_dir_all(&base_dir).expect("Failed to create base directory");
    base_dir.join("hooks.db")
}

impl Config {
    pub fn load() -> Result<Self, anyhow::Error> {
        let db_path = get_db_path();
        tracing::info!("[config] loading from DB: {:?}", db_path);
        let conn = Connection::open(&db_path)?;

        // 迁移：确保新列存在
        let _ = conn.execute("ALTER TABLE app_config_feishu ADD COLUMN open_id TEXT", []);
        let _ = conn.execute("ALTER TABLE app_config_feishu ADD COLUMN hook_events_filter TEXT", []);

        // 创建 PTY 命令表
        let _ = conn.execute(
            "CREATE TABLE IF NOT EXISTS pty_commands (
                id INTEGER PRIMARY KEY,
                project_path TEXT NOT NULL,
                command TEXT NOT NULL,
                processed INTEGER DEFAULT 0,
                created_at INTEGER
            )",
            [],
        );

        // project_path 应该是已存在的列 (由 Tauri 端负责创建/更新)
        // 但如果 CLI 独立运行且 DB 刚创建，可能没有?
        // src-tauri/src/lib.rs 中 upsert_config 更新 project_path。
        // 表结构在 load_config_from_db 中创建。
        // 如果 CLI 先运行? CLI 只是读取。
        // 所以我们假设 project_path 列存在。

        let config = conn
            .query_row(
                "SELECT app_id, app_secret, encrypt_key, verification_token, chat_id, open_id, hook_events_filter, project_path
                 FROM app_config_feishu WHERE id = 1",
                [],
                |row| {
                    Ok(Config {
                        app_id: row.get(0)?,
                        app_secret: row.get(1)?,
                        encrypt_key: row.get(2)?,
                        verification_token: row.get(3)?,
                        chat_id: row.get(4)?,
                        open_id: row.get(5)?,
                        hook_events_filter: row.get(6)?,
                        project_path: row.get(7)?,
                    })
                },
            )
            .optional()?;

        let config = match config {
            Some(config) => {
                let masked_id = if config.app_id.len() > 8 {
                    format!("{}...", &config.app_id[..8])
                } else {
                    config.app_id.clone()
                };
                tracing::info!(
                    "[config] loaded OK: app_id={}, chat_id={:?}, has_encrypt_key={}, has_verification_token={}",
                    masked_id,
                    config.chat_id,
                    config.encrypt_key.is_some(),
                    config.verification_token.is_some()
                );
                config
            }
            None => {
                error!("未在 SQLite 中找到飞书配置，请先在桌面应用中配置");
                anyhow::bail!("Feishu config not found in SQLite");
            }
        };

        if config.app_id.is_empty() || config.app_secret.is_empty() {
            error!("SQLite 中的飞书配置不完整，缺少 app_id 或 app_secret");
            anyhow::bail!("App ID and App Secret are required in configuration");
        }

        Ok(config)
    }
}
