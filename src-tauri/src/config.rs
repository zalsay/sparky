use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub logging: LoggingConfig,
    #[serde(default)]
    pub server: ServerConfig,
    #[serde(default)]
    pub database: DatabaseConfig,
    #[serde(default)]
    pub worker: WorkerConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoggingConfig {
    #[serde(default = "default_log_level")]
    pub level: String,
    #[serde(default)]
    pub file_output: bool,
    #[serde(default)]
    pub file_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    #[serde(default = "default_relay_port")]
    pub relay_port: u16,
    #[serde(default = "default_websocket_port")]
    pub websocket_port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseConfig {
    #[serde(default)]
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerConfig {
    #[serde(default = "default_timeout")]
    pub timeout: u64,
    #[serde(default = "default_max_concurrent")]
    pub max_concurrent: usize,
}

fn default_log_level() -> String { "info".to_string() }
fn default_relay_port() -> u16 { 8765 }
fn default_websocket_port() -> u16 { 8766 }
fn default_timeout() -> u64 { 300 }
fn default_max_concurrent() -> usize { 5 }

impl Default for Config {
    fn default() -> Self {
        Config {
            logging: LoggingConfig::default(),
            server: ServerConfig::default(),
            database: DatabaseConfig::default(),
            worker: WorkerConfig::default(),
        }
    }
}

impl Default for LoggingConfig {
    fn default() -> Self {
        LoggingConfig {
            level: default_log_level(),
            file_output: false,
            file_path: String::new(),
        }
    }
}

impl Default for ServerConfig {
    fn default() -> Self {
        ServerConfig {
            relay_port: default_relay_port(),
            websocket_port: default_websocket_port(),
        }
    }
}

impl Default for DatabaseConfig {
    fn default() -> Self {
        DatabaseConfig { path: String::new() }
    }
}

impl Default for WorkerConfig {
    fn default() -> Self {
        WorkerConfig {
            timeout: default_timeout(),
            max_concurrent: default_max_concurrent(),
        }
    }
}

pub fn load_config(config_path: Option<PathBuf>) -> Config {
    let path = config_path.unwrap_or_else(|| {
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("sparky")
            .join("config.yaml")
    });

    if path.exists() {
        match std::fs::read_to_string(&path) {
            Ok(content) => {
                match serde_yaml::from_str(&content) {
                    Ok(config) => return config,
                    Err(e) => {
                        tracing::warn!("Failed to parse config file: {}", e);
                    }
                }
            }
            Err(e) => {
                tracing::warn!("Failed to read config file: {}", e);
            }
        }
    }

    Config::default()
}
