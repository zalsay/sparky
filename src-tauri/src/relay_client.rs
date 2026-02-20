// Module B: Dual-Mode Execution Engine (v2.1)
// B-1: Local Worker - stub for now

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessagePayload {
    pub sender: String,
    pub task_id: String,
    #[serde(rename = "type")]
    pub msg_type: String,
    pub action: Option<String>,
    pub data: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MessageData {
    #[serde(rename = "execution_mode")]
    pub execution_mode: Option<String>,
    pub prompt: Option<String>,
    pub status: Option<String>,
    pub stream: Option<String>,
    pub content: Option<String>,
    #[serde(rename = "request_id")]
    pub request_id: Option<String>,
    pub hook_type: Option<String>,
    #[serde(rename = "raw_command")]
    pub raw_command: Option<String>,
    pub description: Option<String>,
    pub decision: Option<String>,
}

pub enum ExecutionMode {
    Local,
    Remote,
}

impl ExecutionMode {
    fn from_str(s: &str) -> Self {
        match s {
            "remote" => ExecutionMode::Remote,
            _ => ExecutionMode::Local,
        }
    }
}

// ============== Tauri Commands ==============
#[tauri::command]
pub async fn start_local_worker(task_id: String, relay_url: String) -> Result<String, String> {
    println!("Starting LocalWorker for task: {} at {}", task_id, relay_url);
    // TODO: Implement full WebSocket + Claude process management
    Ok(task_id)
}

#[tauri::command]
pub async fn stop_local_worker() -> Result<(), String> {
    println!("Stopping LocalWorker");
    Ok(())
}
