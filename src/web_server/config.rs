use std::{collections::HashMap, fs, path::PathBuf, sync::Arc};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiTokenConfig {
    pub token: String,
    pub agent_id: String,
    pub allowed_projects: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTokenConfig {
    pub agent_id: String,
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebServerConfig {
    pub bind: String,
    #[serde(default)]
    pub api_tokens: Vec<ApiTokenConfig>,
    #[serde(default)]
    pub agent_tokens: Vec<AgentTokenConfig>,
}

impl WebServerConfig {
    pub fn default_path() -> PathBuf {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        home.join(".sparky").join("web-server.json")
    }

    pub fn load(path: Option<PathBuf>) -> Result<Self, anyhow::Error> {
        let path = path
            .or_else(|| std::env::var("SPARKY_WEB_SERVER_CONFIG").ok().map(PathBuf::from))
            .unwrap_or_else(Self::default_path);
        let raw = fs::read_to_string(&path)
            .map_err(|e| anyhow::anyhow!("failed to read config {}: {}", path.display(), e))?;
        let mut config: WebServerConfig = serde_json::from_str(&raw)
            .map_err(|e| anyhow::anyhow!("failed to parse config {}: {}", path.display(), e))?;

        if let (Ok(token), Ok(agent_id)) = (
            std::env::var("SPARKY_WEB_TOKEN"),
            std::env::var("SPARKY_WEB_AGENT_ID"),
        ) {
            config.api_tokens.push(ApiTokenConfig {
                token,
                agent_id,
                allowed_projects: Vec::new(),
            });
        }

        Ok(config)
    }

    pub fn api_token_map(&self) -> HashMap<String, ApiTokenConfig> {
        self.api_tokens
            .iter()
            .cloned()
            .map(|entry| (entry.token.clone(), entry))
            .collect()
    }

    pub fn agent_token_map(&self) -> HashMap<String, AgentTokenConfig> {
        self.agent_tokens
            .iter()
            .cloned()
            .map(|entry| (entry.agent_id.clone(), entry))
            .collect()
    }
}

pub type SharedConfig = Arc<WebServerConfig>;
