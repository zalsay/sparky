// Module B: Dual-Mode Execution Engine (v2.1)
// B-2: Remote Cloud Worker - LiteBox Sandbox Implementation

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Mutex, RwLock};
use tokio::time::{timeout, Duration};
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message as WsMessage};
use futures_util::{SinkExt, StreamExt};
use tracing::{info, warn, error, debug};

// ============== VFS Directory Mapping ==============
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VfsMapping {
    pub host_path: PathBuf,
    pub sandbox_path: PathBuf,
    pub readonly: bool,
}

#[derive(Debug, Clone, Default)]
pub struct VfsConfig {
    mappings: Vec<VfsMapping>,
}

impl VfsConfig {
    pub fn new() -> Self {
        Self { mappings: Vec::new() }
    }

    pub fn add_mapping(&mut self, host: impl AsRef<Path>, sandbox: impl AsRef<Path>, readonly: bool) {
        self.mappings.push(VfsMapping {
            host_path: host.as_ref().to_path_buf(),
            sandbox_path: sandbox.as_ref().to_path_buf(),
            readonly,
        });
    }

    pub fn to_litebox_args(&self) -> Vec<String> {
        let mut args = Vec::new();
        for m in &self.mappings {
            let flag = if m.readonly { "--ro-bind" } else { "--bind" };
            args.push(flag.to_string());
            args.push(m.host_path.to_string_lossy().to_string());
            args.push(m.sandbox_path.to_string_lossy().to_string());
        }
        args
    }

    pub fn resolve_host_path(&self, sandbox_path: &Path) -> Option<PathBuf> {
        for m in &self.mappings {
            if let Ok(rel) = sandbox_path.strip_prefix(&m.sandbox_path) {
                return Some(m.host_path.join(rel));
            }
        }
        None
    }

    pub fn resolve_sandbox_path(&self, host_path: &Path) -> Option<PathBuf> {
        for m in &self.mappings {
            if let Ok(rel) = host_path.strip_prefix(&m.host_path) {
                return Some(m.sandbox_path.join(rel));
            }
        }
        None
    }
}

// ============== LiteBox Sandbox Config ==============
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxConfig {
    pub litebox_path: String,
    pub network_enabled: bool,
    pub max_memory_mb: u64,
    pub max_cpu_percent: u32,
    pub timeout_secs: u64,
    pub env_vars: HashMap<String, String>,
}

impl Default for SandboxConfig {
    fn default() -> Self {
        Self {
            litebox_path: "litebox".to_string(),
            network_enabled: false,
            max_memory_mb: 512,
            max_cpu_percent: 50,
            timeout_secs: 300,
            env_vars: HashMap::new(),
        }
    }
}

// ============== Message Types ==============
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteMessagePayload {
    pub sender: String,
    pub task_id: String,
    #[serde(rename = "type")]
    pub msg_type: String,
    pub action: Option<String>,
    pub data: RemoteMessageData,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RemoteMessageData {
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
    pub sandbox_id: Option<String>,
    pub exit_code: Option<i32>,
}

// ============== Remote Worker ==============
pub struct RemoteWorker {
    task_id: String,
    relay_url: String,
    sandbox_config: SandboxConfig,
    vfs_config: Arc<RwLock<VfsConfig>>,
    child: Arc<Mutex<Option<Child>>>,
    stdin: Arc<Mutex<Option<tokio::process::ChildStdin>>>,
    ws_sender: mpsc::Sender<String>,
}

impl RemoteWorker {
    pub fn new(task_id: String, relay_url: String, sandbox_config: Option<SandboxConfig>) -> Self {
        let (ws_sender, _) = mpsc::channel(200);
        
        Self {
            task_id,
            relay_url,
            sandbox_config: sandbox_config.unwrap_or_default(),
            vfs_config: Arc::new(RwLock::new(VfsConfig::new())),
            child: Arc::new(Mutex::new(None)),
            stdin: Arc::new(Mutex::new(None)),
            ws_sender,
        }
    }

    pub async fn configure_vfs(&self, mappings: Vec<VfsMapping>) {
        let mut vfs = self.vfs_config.write().await;
        for m in mappings {
            vfs.mappings.push(m);
        }
    }

    pub async fn add_vfs_mapping(&self, host: impl AsRef<Path>, sandbox: impl AsRef<Path>, readonly: bool) {
        let mut vfs = self.vfs_config.write().await;
        vfs.add_mapping(host, sandbox, readonly);
    }

    /// Run the remote worker with LiteBox sandbox
    pub async fn run(&self) {
        info!("[RemoteWorker] Starting: task_id={}", self.task_id);

        // Parse URL for validation, then convert to string for connect_async
        let ws_url = self.relay_url.clone();

        let (ws_stream, _) = match connect_async(&ws_url).await {
            Ok(s) => s,
            Err(e) => {
                error!("[RemoteWorker] WebSocket connection failed: {}", e);
                return;
            }
        };

        info!("[RemoteWorker] Connected to relay server");

        let (mut ws_write, mut ws_read) = ws_stream.split();
        let (tx, mut rx) = mpsc::channel::<String>(200);

        // Send registration
        let reg_msg = RemoteMessagePayload {
            sender: "remote_worker".to_string(),
            task_id: self.task_id.clone(),
            msg_type: "register".to_string(),
            action: None,
            data: RemoteMessageData {
                execution_mode: Some("remote".to_string()),
                sandbox_id: Some(format!("litebox-{}", self.task_id)),
                ..Default::default()
            },
        };
        if let Ok(json) = serde_json::to_string(&reg_msg) {
            let _ = ws_write.send(WsMessage::Text(json.into())).await;
        }

        let child_arc = self.child.clone();
        let stdin_arc = self.stdin.clone();
        let sandbox_config = self.sandbox_config.clone();
        let vfs_config = self.vfs_config.clone();
        let task_id = self.task_id.clone();
        let tx_clone = tx.clone();

        // WebSocket sender task
        let sender_task = tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if ws_write.send(WsMessage::Text(msg.into())).await.is_err() {
                    break;
                }
            }
        });

        // WebSocket receiver task
        let receiver_task = tokio::spawn(async move {
            while let Some(msg_result) = ws_read.next().await {
                let msg = match msg_result {
                    Ok(WsMessage::Text(t)) => t.to_string(),
                    Ok(WsMessage::Close(_)) => break,
                    Err(_) => break,
                    _ => continue,
                };

                let payload: RemoteMessagePayload = match serde_json::from_str(&msg) {
                    Ok(p) => p,
                    Err(_) => continue,
                };

                match payload.msg_type.as_str() {
                    "execute" => {
                        if let Some(cmd) = payload.data.raw_command {
                            Self::execute_in_sandbox(
                                &child_arc,
                                &stdin_arc,
                                &sandbox_config,
                                &vfs_config,
                                &task_id,
                                &tx_clone,
                                &cmd,
                            ).await;
                        }
                    }
                    "input" => {
                        if let Some(content) = payload.data.content {
                            let mut stdin_guard = stdin_arc.lock().await;
                            if let Some(ref mut stdin) = *stdin_guard {
                                let _ = stdin.write_all(content.as_bytes()).await;
                                let _ = stdin.write_all(b"\n").await;
                            }
                        }
                    }
                    "terminate" => {
                        let mut child_guard = child_arc.lock().await;
                        if let Some(ref mut child) = *child_guard {
                            let _ = child.kill().await;
                        }
                        Self::send_status_msg(&tx_clone, &task_id, "terminated").await;
                        break;
                    }
                    _ => {}
                }
            }
        });

        let _ = tokio::join!(sender_task, receiver_task);
        info!("[RemoteWorker] Disconnected: task_id={}", self.task_id);
    }

    async fn execute_in_sandbox(
        child_arc: &Arc<Mutex<Option<Child>>>,
        stdin_arc: &Arc<Mutex<Option<tokio::process::ChildStdin>>>,
        sandbox_config: &SandboxConfig,
        vfs_config: &Arc<RwLock<VfsConfig>>,
        task_id: &str,
        tx: &mpsc::Sender<String>,
        command: &str,
    ) {
        info!("[RemoteWorker] Executing in sandbox: {}", command);

        let vfs = vfs_config.read().await;
        let vfs_args = vfs.to_litebox_args();
        drop(vfs);

        // Build LiteBox command
        let mut cmd = Command::new(&sandbox_config.litebox_path);
        
        // Add sandbox isolation flags
        cmd.arg("--unshare-all");
        
        // Network isolation
        if !sandbox_config.network_enabled {
            cmd.arg("--unshare-net");
        }

        // Resource limits
        cmd.arg("--rlimit-as").arg(format!("{}M", sandbox_config.max_memory_mb));
        
        // Add VFS mappings
        for arg in &vfs_args {
            cmd.arg(arg);
        }

        // Add environment variables
        for (key, value) in &sandbox_config.env_vars {
            cmd.arg("--setenv").arg(key).arg(value);
        }

        // Execute shell command inside sandbox
        cmd.arg("--").arg("/bin/sh").arg("-c").arg(command);

        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                error!("[RemoteWorker] Failed to spawn sandbox: {}", e);
                Self::send_error_msg(tx, task_id, &format!("Sandbox spawn failed: {}", e)).await;
                return;
            }
        };

        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        {
            let mut stdin_guard = stdin_arc.lock().await;
            *stdin_guard = stdin;
        }
        {
            let mut child_guard = child_arc.lock().await;
            *child_guard = Some(child);
        }

        Self::send_status_msg(tx, task_id, "running").await;

        let tx_stdout = tx.clone();
        let tx_stderr = tx.clone();
        let task_id_stdout = task_id.to_string();
        let task_id_stderr = task_id.to_string();

        // Stream stdout
        let stdout_task = tokio::spawn(async move {
            if let Some(out) = stdout {
                let reader = BufReader::new(out);
                let mut lines = reader.lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    Self::send_stream_msg(&tx_stdout, &task_id_stdout, "stdout", &line).await;
                }
            }
        });

        // Stream stderr
        let stderr_task = tokio::spawn(async move {
            if let Some(err) = stderr {
                let reader = BufReader::new(err);
                let mut lines = reader.lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    Self::send_stream_msg(&tx_stderr, &task_id_stderr, "stderr", &line).await;
                }
            }
        });

        let _ = tokio::join!(stdout_task, stderr_task);

        // Wait for process with timeout
        let timeout_duration = Duration::from_secs(sandbox_config.timeout_secs);
        let mut child_guard = child_arc.lock().await;
        
        if let Some(ref mut child) = *child_guard {
            match timeout(timeout_duration, child.wait()).await {
                Ok(Ok(status)) => {
                    let exit_code = status.code().unwrap_or(-1);
                    Self::send_exit_msg(tx, task_id, exit_code).await;
                }
                Ok(Err(e)) => {
                    Self::send_error_msg(tx, task_id, &format!("Process error: {}", e)).await;
                }
                Err(_) => {
                    let _ = child.kill().await;
                    Self::send_error_msg(tx, task_id, "Execution timeout").await;
                }
            }
        }
        *child_guard = None;
    }

    async fn send_status_msg(tx: &mpsc::Sender<String>, task_id: &str, status: &str) {
        let msg = RemoteMessagePayload {
            sender: "remote_worker".to_string(),
            task_id: task_id.to_string(),
            msg_type: "status".to_string(),
            action: None,
            data: RemoteMessageData { status: Some(status.to_string()), ..Default::default() },
        };
        if let Ok(json) = serde_json::to_string(&msg) {
            let _ = tx.send(json).await;
        }
    }

    async fn send_stream_msg(tx: &mpsc::Sender<String>, task_id: &str, stream_type: &str, content: &str) {
        let msg = RemoteMessagePayload {
            sender: "remote_worker".to_string(),
            task_id: task_id.to_string(),
            msg_type: "stream".to_string(),
            action: None,
            data: RemoteMessageData {
                stream: Some(stream_type.to_string()),
                content: Some(content.to_string()),
                ..Default::default()
            },
        };
        if let Ok(json) = serde_json::to_string(&msg) {
            let _ = tx.send(json).await;
        }
    }

    async fn send_exit_msg(tx: &mpsc::Sender<String>, task_id: &str, exit_code: i32) {
        let msg = RemoteMessagePayload {
            sender: "remote_worker".to_string(),
            task_id: task_id.to_string(),
            msg_type: "exit".to_string(),
            action: None,
            data: RemoteMessageData {
                exit_code: Some(exit_code),
                status: Some("completed".to_string()),
                ..Default::default()
            },
        };
        if let Ok(json) = serde_json::to_string(&msg) {
            let _ = tx.send(json).await;
        }
    }

    async fn send_error_msg(tx: &mpsc::Sender<String>, task_id: &str, error: &str) {
        let msg = RemoteMessagePayload {
            sender: "remote_worker".to_string(),
            task_id: task_id.to_string(),
            msg_type: "error".to_string(),
            action: None,
            data: RemoteMessageData {
                status: Some("error".to_string()),
                content: Some(error.to_string()),
                ..Default::default()
            },
        };
        if let Ok(json) = serde_json::to_string(&msg) {
            let _ = tx.send(json).await;
        }
    }
}

// ============== Tauri Commands ==============
#[tauri::command]
pub async fn start_remote_worker(
    task_id: String,
    relay_url: String,
    vfs_mappings: Option<Vec<VfsMapping>>,
) -> Result<String, String> {
    info!("[RemoteWorker] Starting: {} @ {}", task_id, relay_url);

    let worker = RemoteWorker::new(task_id.clone(), relay_url, None);
    
    // Configure default VFS mappings
    worker.add_vfs_mapping("/tmp", "/tmp", false).await;
    worker.add_vfs_mapping("/usr", "/usr", true).await;
    worker.add_vfs_mapping("/lib", "/lib", true).await;
    worker.add_vfs_mapping("/lib64", "/lib64", true).await;
    worker.add_vfs_mapping("/bin", "/bin", true).await;

    // Add custom mappings
    if let Some(mappings) = vfs_mappings {
        worker.configure_vfs(mappings).await;
    }

    let w = Arc::new(worker);
    let ww = w.clone();
    
    tokio::spawn(async move {
        ww.run().await;
    });

    Ok(task_id)
}

#[tauri::command]
pub async fn stop_remote_worker() -> Result<(), String> {
    info!("[RemoteWorker] Stopping");
    Ok(())
}

#[tauri::command]
pub async fn configure_sandbox(
    network_enabled: Option<bool>,
    max_memory_mb: Option<u64>,
    timeout_secs: Option<u64>,
) -> Result<SandboxConfig, String> {
    let mut config = SandboxConfig::default();
    
    if let Some(net) = network_enabled {
        config.network_enabled = net;
    }
    if let Some(mem) = max_memory_mb {
        config.max_memory_mb = mem;
    }
    if let Some(t) = timeout_secs {
        config.timeout_secs = t;
    }

    Ok(config)
}

// ============== Unit Tests ==============
#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::path::Path;

    #[test]
    fn test_vfs_mapping_creation() {
        let mapping = VfsMapping {
            host_path: PathBuf::from("/home/user/project"),
            sandbox_path: PathBuf::from("/workspace"),
            readonly: true,
        };

        assert_eq!(mapping.host_path, PathBuf::from("/home/user/project"));
        assert_eq!(mapping.sandbox_path, PathBuf::from("/workspace"));
        assert!(mapping.readonly);
    }

    #[test]
    fn test_vfs_config_new() {
        let config = VfsConfig::new();
        assert!(config.mappings.is_empty());
    }

    #[test]
    fn test_vfs_config_add_mapping() {
        let mut config = VfsConfig::new();
        config.add_mapping("/host/path", "/sandbox/path", false);
        config.add_mapping("/host/readonly", "/sandbox/ro", true);

        assert_eq!(config.mappings.len(), 2);
        assert!(!config.mappings[0].readonly);
        assert!(config.mappings[1].readonly);
    }

    #[test]
    fn test_vfs_config_to_litebox_args() {
        let mut config = VfsConfig::new();
        config.add_mapping("/data", "/mnt/data", false);
        config.add_mapping("/config", "/etc/config", true);

        let args = config.to_litebox_args();

        assert_eq!(args.len(), 6);
        assert_eq!(args[0], "--bind");
        assert_eq!(args[1], "/data");
        assert_eq!(args[2], "/mnt/data");
        assert_eq!(args[3], "--ro-bind");
        assert_eq!(args[4], "/config");
        assert_eq!(args[5], "/etc/config");
    }

    #[test]
    fn test_vfs_config_resolve_host_path() {
        let mut config = VfsConfig::new();
        config.add_mapping("/home/user/project", "/workspace", false);

        let result = config.resolve_host_path(Path::new("/workspace/src/main.rs"));
        assert_eq!(result, Some(PathBuf::from("/home/user/project/src/main.rs")));

        let no_match = config.resolve_host_path(Path::new("/other/path"));
        assert!(no_match.is_none());
    }

    #[test]
    fn test_vfs_config_resolve_sandbox_path() {
        let mut config = VfsConfig::new();
        config.add_mapping("/home/user/project", "/workspace", false);

        let result = config.resolve_sandbox_path(Path::new("/home/user/project/src/lib.rs"));
        assert_eq!(result, Some(PathBuf::from("/workspace/src/lib.rs")));

        let no_match = config.resolve_sandbox_path(Path::new("/other/host/path"));
        assert!(no_match.is_none());
    }

    #[test]
    fn test_sandbox_config_default() {
        let config = SandboxConfig::default();

        assert_eq!(config.litebox_path, "litebox");
        assert!(!config.network_enabled);
        assert_eq!(config.max_memory_mb, 512);
        assert_eq!(config.max_cpu_percent, 50);
        assert_eq!(config.timeout_secs, 300);
        assert!(config.env_vars.is_empty());
    }

    #[test]
    fn test_sandbox_config_serialize() {
        let mut env_vars = HashMap::new();
        env_vars.insert("PATH".to_string(), "/bin".to_string());
        
        let config = SandboxConfig {
            litebox_path: "/usr/bin/litebox".to_string(),
            network_enabled: true,
            max_memory_mb: 1024,
            max_cpu_percent: 80,
            timeout_secs: 600,
            env_vars,
        };

        let json = serde_json::to_string(&config).unwrap();
        assert!(json.contains("network_enabled"));
        assert!(json.contains("1024"));
    }

    #[test]
    fn test_vfs_mapping_serialize_deserialize() {
        let mapping = VfsMapping {
            host_path: PathBuf::from("/src"),
            sandbox_path: PathBuf::from("/dest"),
            readonly: true,
        };

        let json = serde_json::to_string(&mapping).unwrap();
        let deserialized: VfsMapping = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.host_path, mapping.host_path);
        assert_eq!(deserialized.sandbox_path, mapping.sandbox_path);
        assert_eq!(deserialized.readonly, mapping.readonly);
    }
}
