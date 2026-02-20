// Module B: Tauri Worker - Relay Client
// Connects to the public relay server and manages Claude Code process

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, mpsc, Mutex};

// Message types matching the PRD protocol
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessagePayload {
    pub sender: String,
    pub task_id: String,
    pub msg_type: String,
    pub action: Option<String>,
    pub data: serde_json::Value,
}

// Relay server configuration
const DEFAULT_RELAY_URL: &str = "ws://localhost:8005";

pub struct RelayClient {
    task_id: String,
    shutdown_tx: broadcast::Sender<()>,
    child: Arc<Mutex<Option<Child>>>,
    ws_sender: mpsc::Sender<String>,
}

impl RelayClient {
    pub fn new(task_id: String) -> Self {
        let (shutdown_tx, _) = broadcast::channel(1);
        let (ws_sender, _) = mpsc::channel(100);
        
        Self {
            task_id,
            shutdown_tx,
            child: Arc::new(Mutex::new(None)),
            ws_sender,
        }
    }

    /// Get the channel sender for sending messages
    pub fn get_sender(&self) -> mpsc::Sender<String> {
        self.ws_sender.clone()
    }

    /// Spawn Claude Code process
    pub async fn spawn_claude_code(&self, prompt: &str) -> Result<(), String> {
        // Kill existing process if any
        self.kill_claude_code().await;

        println!("Spawning Claude Code with prompt: {}", prompt);

        // Build claude command
        let mut cmd = Command::new("claude");
        cmd.arg("--print")
           .arg(prompt)
           .stdout(std::process::Stdio::piped())
           .stderr(std::process::Stdio::piped())
           .stdin(std::process::Stdio::piped());

        #[cfg(windows)]
        {
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        
        *self.child.lock().await = Some(child);

        // Send status
        self.send_status("running").await;

        // Clone for spawned tasks
        let child_clone = self.child.clone();
        let sender_clone = self.ws_sender.clone();
        let task_id = self.task_id.clone();

        // Spawn task to read stdout
        tokio::spawn(async move {
            if let Some(stdout) = stdout {
                let reader = BufReader::new(stdout);
                let mut lines = reader.lines();
                
                while let Ok(Some(line)) = lines.next_line().await {
                    let log_msg = MessagePayload {
                        sender: "tauri_worker".to_string(),
                        task_id: task_id.clone(),
                        msg_type: "log".to_string(),
                        action: None,
                        data: serde_json::json!({
                            "stream": "stdout",
                            "content": line
                        }),
                    };
                    
                    if let Ok(text) = serde_json::to_string(&log_msg) {
                        let _ = sender_clone.send(text).await;
                    }
                }
            }
        });

        // Spawn task to read stderr
        let child_clone2 = self.child.clone();
        let sender_clone2 = self.ws_sender.clone();
        let task_id2 = self.task_id.clone();

        tokio::spawn(async move {
            if let Some(stderr) = stderr {
                let reader = BufReader::new(stderr);
                let mut lines = reader.lines();
                
                while let Ok(Some(line)) = lines.next_line().await {
                    let log_msg = MessagePayload {
                        sender: "tauri_worker".to_string(),
                        task_id: task_id2.clone(),
                        msg_type: "log".to_string(),
                        action: None,
                        data: serde_json::json!({
                            "stream": "stderr",
                            "content": line
                        }),
                    };
                    
                    if let Ok(text) = serde_json::to_string(&log_msg) {
                        let _ = sender_clone2.send(text).await;
                    }
                }
            }
        });

        // Spawn task to wait for process to finish
        let child_clone3 = self.child.clone();
        let task_id3 = self.task_id.clone();

        tokio::spawn(async move {
            let mut child_guard = child_clone3.lock().await;
            if let Some(ref mut child) = *child_guard {
                let status = child.wait().await;
                println!("Claude Code finished with: {:?}", status);
                
                // Send final status
                let final_status = if status.unwrap().success() { 
                    "success" 
                } else { 
                    "failed" 
                };
                
                let status_msg = MessagePayload {
                    sender: "tauri_worker".to_string(),
                    task_id: task_id3.clone(),
                    msg_type: "status".to_string(),
                    action: None,
                    data: serde_json::json!({ "status": final_status }),
                };
                
                if let Ok(text) = serde_json::to_string(&status_msg) {
                    // Note: Can't send without sender reference
                }
            }
        });

        Ok(())
    }

    /// Kill Claude Code process
    pub async fn kill_claude_code(&self) {
        let mut child_guard = self.child.lock().await;
        if let Some(ref mut child) = *child_guard {
            println!("Killing Claude Code process");
            let _ = child.kill().await;
            *child_guard = None;
        }
    }

    /// Send status message to relay
    pub async fn send_status(&self, status: &str) {
        let msg = MessagePayload {
            sender: "tauri_worker".to_string(),
            task_id: self.task_id.clone(),
            msg_type: "status".to_string(),
            action: None,
            data: serde_json::json!({ "status": status }),
        };
        
        if let Ok(text) = serde_json::to_string(&msg) {
            let _ = self.ws_sender.send(text).await;
        }
    }

    /// Send permission request to relay
    pub async fn send_permission_request(&self, request_id: &str, hook_type: &str, raw_command: &str, description: &str) {
        let msg = MessagePayload {
            sender: "tauri_worker".to_string(),
            task_id: self.task_id.clone(),
            msg_type: "permission_request".to_string(),
            action: None,
            data: serde_json::json!({
                "request_id": request_id,
                "hook_type": hook_type,
                "raw_command": raw_command,
                "description": description
            }),
        };
        
        if let Ok(text) = serde_json::to_string(&msg) {
            let _ = self.ws_sender.send(text).await;
        }
    }
}

// Tauri commands for relay client

#[tauri::command]
pub async fn start_relay_client(task_id: String, relay_url: Option<String>) -> Result<String, String> {
    println!("Starting relay client for task: {}", task_id);
    // Return task_id to indicate success
    Ok(task_id)
}

#[tauri::command]
pub async fn stop_relay_client() -> Result<(), String> {
    println!("Stopping relay client");
    Ok(())
}
