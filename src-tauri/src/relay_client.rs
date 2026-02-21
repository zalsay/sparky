// Module B: Dual-Mode Execution Engine (v2.1)
// B-1: Local Worker - Core Scheduler Implementation

use serde::{Deserialize, Serialize};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Mutex};
use tokio::time::{timeout, Duration};
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message as WsMessage};
use futures_util::StreamExt;
use tracing::{info, warn, error, debug};

// ============== Message Types ==============
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessagePayload {
    pub sender: String,
    pub task_id: String,
    #[serde(rename = "type")]
    pub msg_type: String,
    pub action: Option<String>,
    pub data: MessageData,
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

#[derive(Debug, Clone, Copy, PartialEq)]
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

// ============== Local Worker ==============
pub struct LocalWorker {
    task_id: String,
    relay_url: String,
    child: Arc<Mutex<Option<Child>>>,
    stdin: Arc<Mutex<Option<tokio::process::ChildStdin>>>,
    ws_sender: mpsc::Sender<String>,
}

impl LocalWorker {
    pub fn new(task_id: String, relay_url: String) -> Self {
        let (ws_sender, _) = mpsc::channel(200);
        
        Self {
            task_id,
            relay_url,
            child: Arc::new(Mutex::new(None)),
            stdin: Arc::new(Mutex::new(None)),
            ws_sender,
        }
    }

    /// Run the worker
    pub async fn run(&self) {
        let url = format!("{}/ws/{}", self.relay_url, self.task_id);
        info!("[LocalWorker] Connecting to {}", url);

        match connect_async(&url).await {
            Ok((ws_stream, _)) => {
                info!("[LocalWorker] Connected!");
                self.send_status("connected").await;
                self.handle_connection(ws_stream).await;
            }
            Err(e) => {
                info!("[LocalWorker] Connect failed: {}", e);
            }
        }

        self.kill_process().await;
    }

    async fn handle_connection(&self, ws_stream: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>) {
        let (_write, mut read) = ws_stream.split();

        loop {
            tokio::select! {
                msg = read.next() => {
                    match msg {
                        Some(Ok(WsMessage::Text(text))) => {
                            if let Err(e) = self.handle_message(&text).await {
                                info!("[LocalWorker] Error: {}", e);
                            }
                        }
                        Some(Ok(WsMessage::Close(_))) | None => break,
                        _ => {}
                    }
                }
            }
        }
    }

    async fn handle_message(&self, text: &str) -> Result<(), String> {
        let payload: MessagePayload = serde_json::from_str(text)
            .map_err(|e| e.to_string())?;

        match payload.msg_type.as_str() {
            "command" => {
                match payload.action.as_deref() {
                    Some("start_task") => {
                        let prompt = payload.data.prompt.as_deref().unwrap_or("");
                        self.spawn_claude(prompt).await?;
                    }
                    Some("stop_task") => self.kill_process().await,
                    _ => {}
                }
            }
            "permission_response" => {
                let decision = payload.data.decision.as_deref().unwrap_or("reject");
                self.handle_permission_response(decision).await;
            }
            _ => {}
        }
        Ok(())
    }

    async fn spawn_claude(&self, prompt: &str) -> Result<(), String> {
        self.kill_process().await;
        
        info!("[LocalWorker] Spawning Claude: {}", prompt);

        let mut cmd = Command::new("claude");
        cmd.arg("--print")
           .arg(prompt)
           .stdout(Stdio::piped())
           .stderr(Stdio::piped())
           .stdin(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let stdin = child.stdin.take();

        *self.child.lock().await = Some(child);
        *self.stdin.lock().await = stdin;

        self.send_status("running").await;

        // Stdout reader
        let sender1 = self.ws_sender.clone();
        let task_id1 = self.task_id.clone();
        tokio::spawn(async move {
            if let Some(out) = stdout {
                let mut lines = tokio::io::BufReader::new(out).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let msg = MessagePayload {
                        sender: "local_worker".to_string(),
                        task_id: task_id1.clone(),
                        msg_type: "chat_log_stream".to_string(),
                        action: None,
                        data: MessageData {
                            stream: Some("stdout".to_string()),
                            content: Some(line),
                            ..Default::default()
                        },
                    };
                    if let Ok(t) = serde_json::to_string(&msg) { let _ = sender1.send(t).await; }
                }
            }
        });

        // Stderr reader
        let sender2 = self.ws_sender.clone();
        let task_id2 = self.task_id.clone();
        tokio::spawn(async move {
            if let Some(err) = stderr {
                let mut lines = tokio::io::BufReader::new(err).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let (msg_type, data) = Self::check_permission(&line);
                    let msg = MessagePayload {
                        sender: "local_worker".to_string(),
                        task_id: task_id2.clone(),
                        msg_type,
                        action: None,
                        data,
                    };
                    if let Ok(t) = serde_json::to_string(&msg) { let _ = sender2.send(t).await; }
                }
            }
        });

        // Wait for completion (with 5 minute timeout)
        let sender3 = self.ws_sender.clone();
        let task_id3 = self.task_id.clone();
        let child_ref = self.child.clone();
        tokio::spawn(async move {
            let mut c = child_ref.lock().await;
            if let Some(ref mut child) = *c {
                let timeout_result = timeout(Duration::from_secs(300), child.wait()).await;
                let final_status = match timeout_result {
                    Ok(Ok(s)) if s.success() => "success",
                    Ok(Ok(_)) => "failed",
                    Ok(Err(_)) => "error",
                    Err(_) => "timeout",
                };
                let msg = MessagePayload {
                    sender: "local_worker".to_string(),
                    task_id: task_id3,
                    msg_type: "status".to_string(),
                    action: None,
                    data: MessageData { status: Some(final_status.to_string()), ..Default::default() },
                };
                if let Ok(t) = serde_json::to_string(&msg) { let _ = sender3.send(t).await; }
                *c = None;
            }
        });

        Ok(())
    }

    fn check_permission(line: &str) -> (String, MessageData) {
        let lower = line.to_lowercase();
        // 改进权限检测：使用更精确的匹配模式
        let is_permission = lower.contains("permission") 
            || (lower.contains("allow") && (lower.contains("continue?") || lower.contains("run this command") || lower.contains("proceed")))
            || lower.contains("approve")
            || (lower.contains("continue") && (lower.contains("?") || lower.contains("action")));
        
        if is_permission {
            let id = format!("req_{}", std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap()
                .as_nanos());
            return ("permission_request".to_string(), MessageData {
                request_id: Some(id),
                hook_type: Some("shell".to_string()),
                raw_command: Some(line.chars().take(200).collect()),
                description: Some("Requires approval".to_string()),
                ..Default::default()
            });
        }
        ("chat_log_stream".to_string(), MessageData {
            stream: Some("stderr".to_string()),
            content: Some(line.to_string()),
            ..Default::default()
        })
    }

    async fn handle_permission_response(&self, decision: &str) {
        info!("[LocalWorker] Permission: {}", decision);
        let mut s = self.stdin.lock().await;
        if let Some(ref mut stdin) = *s {
            let input = if decision == "approve" { "y\n" } else { "\n" };
            let _ = stdin.write_all(input.as_bytes()).await;
        }
    }

    async fn kill_process(&self) {
        let mut c = self.child.lock().await;
        if let Some(ref mut child) = *c { let _ = child.kill().await; *c = None; }
        let mut s = self.stdin.lock().await;
        *s = None;
    }

    async fn send_status(&self, status: &str) {
        let msg = MessagePayload {
            sender: "local_worker".to_string(),
            task_id: self.task_id.clone(),
            msg_type: "status".to_string(),
            action: None,
            data: MessageData { status: Some(status.to_string()), ..Default::default() },
        };
        if let Ok(t) = serde_json::to_string(&msg) { let _ = self.ws_sender.send(t).await; }
    }
}

// ============== Tauri Commands ==============
#[tauri::command]
pub async fn start_local_worker(task_id: String, relay_url: String) -> Result<String, String> {
    println!("Starting LocalWorker: {} @ {}", task_id, relay_url);
    
    let worker = LocalWorker::new(task_id.clone(), relay_url);
    let w = Arc::new(worker);
    
    let ww = w.clone();
    tokio::spawn(async move {
        ww.run().await;
    });

    Ok(task_id)
}

#[tauri::command]
pub async fn stop_local_worker() -> Result<(), String> {
    println!("Stopping LocalWorker");
    Ok(())
}

// ============== Unit Tests ==============
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_execution_mode_from_str() {
        assert_eq!(ExecutionMode::from_str("remote"), ExecutionMode::Remote);
        assert_eq!(ExecutionMode::from_str("local"), ExecutionMode::Local);
        assert_eq!(ExecutionMode::from_str(""), ExecutionMode::Local);
        assert_eq!(ExecutionMode::from_str("unknown"), ExecutionMode::Local);
    }

    #[test]
    fn test_execution_mode_equality() {
        assert_eq!(ExecutionMode::Local, ExecutionMode::Local);
        assert_eq!(ExecutionMode::Remote, ExecutionMode::Remote);
        assert_ne!(ExecutionMode::Local, ExecutionMode::Remote);
    }

    #[test]
    fn test_message_data_default() {
        let data = MessageData::default();
        assert!(data.execution_mode.is_none());
        assert!(data.prompt.is_none());
        assert!(data.status.is_none());
        assert!(data.stream.is_none());
        assert!(data.content.is_none());
        assert!(data.request_id.is_none());
        assert!(data.hook_type.is_none());
        assert!(data.raw_command.is_none());
        assert!(data.description.is_none());
        assert!(data.decision.is_none());
    }

    #[test]
    fn test_message_payload_serialize() {
        let payload = MessagePayload {
            sender: "test_sender".to_string(),
            task_id: "task_123".to_string(),
            msg_type: "request".to_string(),
            action: Some("execute".to_string()),
            data: MessageData {
                prompt: Some("hello".to_string()),
                ..Default::default()
            },
        };

        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("test_sender"));
        assert!(json.contains("task_123"));
        assert!(json.contains("\"type\":\"request\""));
    }

    #[test]
    fn test_message_payload_deserialize() {
        let json = r#"{
            "sender": "worker",
            "task_id": "t1",
            "type": "response",
            "action": null,
            "data": {"status": "ok"}
        }"#;

        let payload: MessagePayload = serde_json::from_str(json).unwrap();
        assert_eq!(payload.sender, "worker");
        assert_eq!(payload.task_id, "t1");
        assert_eq!(payload.msg_type, "response");
        assert!(payload.action.is_none());
        assert_eq!(payload.data.status, Some("ok".to_string()));
    }

    #[test]
    fn test_local_worker_new() {
        let worker = LocalWorker::new("task_001".to_string(), "ws://localhost:8080".to_string());
        assert_eq!(worker.task_id, "task_001");
        assert_eq!(worker.relay_url, "ws://localhost:8080");
    }
}
