use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub app_id: String,
    pub app_secret: String,
    pub encrypt_key: Option<String>,
    pub verification_token: Option<String>,
    pub chat_id: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            app_id: String::new(),
            app_secret: String::new(),
            encrypt_key: None,
            verification_token: None,
            chat_id: None,
        }
    }
}

fn get_config_path() -> PathBuf {
    let config_dir = dirs::config_dir()
        .expect("Failed to get config directory")
        .join("com.claude.monitor");
    
    fs::create_dir_all(&config_dir).expect("Failed to create config directory");
    config_dir.join("config.json")
}

impl Config {
    pub fn load() -> Result<Self, anyhow::Error> {
        let config_path = get_config_path();
        
        if config_path.exists() {
            let config_str = fs::read_to_string(&config_path)?;
            let config: Config = serde_json::from_str(&config_str)?;
            
            // 验证必填字段
            if config.app_id.is_empty() || config.app_secret.is_empty() {
                anyhow::bail!("App ID and App Secret are required in configuration");
            }
            
            Ok(config)
        } else {
            eprintln!("配置文件不存在，请先使用桌面应用进行配置");
            eprintln!("配置文件路径: {:?}", config_path);
            eprintln!("\n您也可以手动创建配置文件，格式如下：");
            eprintln!("{}", serde_json::to_string_pretty(&Config::default())?);
            anyhow::bail!("Configuration file not found. Please configure using the desktop app first.");
        }
    }
}
