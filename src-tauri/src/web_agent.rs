use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message as WsMessage};
use futures_util::{SinkExt, StreamExt};
use rusqlite::{params, OptionalExtension};
use std::path::PathBuf;
use std::time::Duration;
use tauri::{Listener, Manager};

use crate::{
    open_db, get_projects, get_project_sessions, get_terminal_history, update_session_name,
    delete_session, WebAgentState,
};

const RECONNECT_DELAY: Duration = Duration::from_secs(5);
const OUTBOUND_CHANNEL_SIZE: usize = 128;

#[derive(Debug, Clone, Deserialize)]
struct WebAgentConfig {
    server_url: String,
    agent_id: String,
    token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientHello {
    pub agent_id: String,
    pub token: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TunnelMessage {
    ClientHello(ClientHello),
    Request {
        req_id: String,
        op: String,
        project_id: Option<String>,
        payload: Value,
    },
    Response {
        req_id: String,
        ok: bool,
        status: Option<u16>,
        payload: Option<Value>,
        error: Option<String>,
    },
    Event {
        project_id: String,
        event_type: String,
        payload: Value,
    },
}

pub async fn start_web_agent(app: tauri::AppHandle) {
    let config = match load_config() {
        Ok(Some(config)) => config,
        Ok(None) => return,
        Err(err) => {
            log::warn!("web agent config load failed: {}", err);
            return;
        }
    };

    loop {
        if let Err(err) = connect_and_run(&app, &config).await {
            log::warn!("web agent connection ended: {}", err);
        }
        tokio::time::sleep(RECONNECT_DELAY).await;
    }
}

pub fn register_pty_event_listeners(app: tauri::AppHandle) {
    let app_for_data = app.clone();
    app.listen_any("pty-data", move |event| {
        let app = app_for_data.clone();
        let payload = event.payload().to_string();
        tauri::async_runtime::spawn(async move {
            if let Err(err) = forward_pty_data_event(&app, &payload).await {
                log::debug!("web agent pty-data forward skipped: {}", err);
            }
        });
    });

    let app_for_exit = app.clone();
    app.listen_any("pty-exit", move |event| {
        let app = app_for_exit.clone();
        let payload = event.payload().to_string();
        tauri::async_runtime::spawn(async move {
            if let Err(err) = forward_pty_exit_event(&app, &payload).await {
                log::debug!("web agent pty-exit forward skipped: {}", err);
            }
        });
    });
}

fn load_config() -> Result<Option<WebAgentConfig>, String> {
    let path = web_agent_config_path().ok_or_else(|| "home directory not found".to_string())?;
    if !path.exists() {
        log::info!("web agent config not found at {:?}; skipping", path);
        return Ok(None);
    }

    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let parsed = serde_json::from_str::<WebAgentConfig>(&content).map_err(|e| e.to_string())?;

    if parsed.server_url.is_empty() || parsed.agent_id.is_empty() || parsed.token.is_empty() {
        return Err("web agent config missing required fields".to_string());
    }

    Ok(Some(parsed))
}

fn web_agent_config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join("sparky").join("web-agent.json"))
}

async fn connect_and_run(app: &tauri::AppHandle, config: &WebAgentConfig) -> Result<(), String> {
    log::info!("web agent connecting to {}", config.server_url);
    let (ws_stream, _) = connect_async(&config.server_url)
        .await
        .map_err(|e| e.to_string())?;

    let (mut write, mut read) = ws_stream.split();
    let (out_tx, mut out_rx) = mpsc::channel::<TunnelMessage>(OUTBOUND_CHANNEL_SIZE);

    {
        let state = app.state::<WebAgentState>();
        let mut guard = state.sender.lock().unwrap();
        *guard = Some(out_tx.clone());
    }

    let hello = TunnelMessage::ClientHello(ClientHello {
        agent_id: config.agent_id.clone(),
        token: config.token.clone(),
        capabilities: capabilities_list(),
    });
    let hello_payload = serde_json::to_string(&hello).map_err(|e| e.to_string())?;
    if let Err(err) = write.send(WsMessage::Text(hello_payload.into())).await {
        let state = app.state::<WebAgentState>();
        let mut guard = state.sender.lock().unwrap();
        *guard = None;
        return Err(err.to_string());
    }

    log::info!("web agent hello sent agent_id={}", config.agent_id);

    let app_for_recv = app.clone();
    let recv_tx = out_tx.clone();
    let recv_task = tokio::spawn(async move {
        while let Some(message) = read.next().await {
            let message = match message {
                Ok(msg) => msg,
                Err(err) => return Err(err.to_string()),
            };

            if let WsMessage::Text(text) = message {
                if let Ok(parsed) = serde_json::from_str::<TunnelMessage>(&text) {
                    if let TunnelMessage::Request {
                        req_id,
                        op,
                        project_id,
                        payload,
                    } = parsed
                    {
                        let response = handle_request(&app_for_recv, req_id, op, project_id, payload).await;
                        if recv_tx.send(response).await.is_err() {
                            return Err("web agent outbound channel closed".to_string());
                        }
                    }
                }
            }
        }
        Ok(())
    });

    let send_task = tokio::spawn(async move {
        while let Some(message) = out_rx.recv().await {
            let payload = match serde_json::to_string(&message) {
                Ok(payload) => payload,
                Err(_) => continue,
            };

            if write.send(WsMessage::Text(payload.into())).await.is_err() {
                break;
            }
        }
    });

    let result = tokio::select! {
        res = recv_task => res.unwrap_or_else(|e| Err(e.to_string())),
        _ = send_task => Ok(()),
    };

    {
        let state = app.state::<WebAgentState>();
        let mut guard = state.sender.lock().unwrap();
        *guard = None;
    }

    result
}

async fn handle_request(
    app: &tauri::AppHandle,
    req_id: String,
    op: String,
    project_id: Option<String>,
    payload: Value,
) -> TunnelMessage {
    log::info!("web agent request op={} project_id={:?}", op, project_id);
    match op.as_str() {
        "projects.list" => {
            let response = get_projects().map(|projects| json!(projects));
            response_to_message(req_id, response)
        }
        "projects.detail" => {
            let project_id = match project_id.and_then(|id| id.parse::<i64>().ok()) {
                Some(id) => id,
                None => return error_response(req_id, 400, "INVALID_PROJECT_ID"),
            };

            match handle_project_detail(project_id) {
                Ok(payload) => success_response(req_id, payload),
                Err(err) if err == "PROJECT_NOT_FOUND" => error_response(req_id, 404, &err),
                Err(err) => error_response(req_id, 500, &err),
            }
        }
        "sessions.list" => {
            let project_path = match project_id
                .as_ref()
                .and_then(|id| id.parse::<i64>().ok())
                .and_then(|id| get_project_path_by_id(id).ok().flatten())
            {
                Some(path) => path,
                None => return error_response(req_id, 404, "PROJECT_NOT_FOUND"),
            };

            let response = get_project_sessions(project_path).map(|sessions| json!(sessions));
            response_to_message(req_id, response)
        }
        "terminal.history" => {
            let project_path = match project_id
                .as_ref()
                .and_then(|id| id.parse::<i64>().ok())
                .and_then(|id| get_project_path_by_id(id).ok().flatten())
            {
                Some(path) => path,
                None => return error_response(req_id, 404, "PROJECT_NOT_FOUND"),
            };

            let response = get_terminal_history(project_path).map(|history| json!(history));
            response_to_message(req_id, response)
        }
        "terminal.exec" => {
            let project_path = match project_id
                .as_ref()
                .and_then(|id| id.parse::<i64>().ok())
                .and_then(|id| get_project_path_by_id(id).ok().flatten())
            {
                Some(path) => path,
                None => return error_response(req_id, 404, "PROJECT_NOT_FOUND"),
            };

            let command = payload
                .get("command")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let command = match command {
                Some(cmd) if !cmd.is_empty() => cmd,
                _ => return error_response(req_id, 400, "INVALID_COMMAND"),
            };

            let manager = app.state::<std::sync::Arc<crate::PtyManager>>();
            let terminal_id = manager.get_primary_terminal_for_project(&project_path);
            match terminal_id {
                Some(terminal_id) => match manager.write(&terminal_id, &command) {
                    Ok(_) => success_response(req_id, json!({ "terminal_id": terminal_id })),
                    Err(err) => error_response(req_id, 500, &err),
                },
                None => error_response(req_id, 409, "NO_ACTIVE_TERMINAL"),
            }
        }
        "sessions.rename" => {
            let session_id = payload
                .get("session_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let name = payload
                .get("name")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            match (session_id, name) {
                (Some(session_id), Some(name)) => {
                    response_to_message(req_id, update_session_name(session_id, name).map(|_| json!({})))
                }
                _ => error_response(req_id, 400, "INVALID_PAYLOAD"),
            }
        }
        "sessions.delete" => {
            let session_id = payload
                .get("session_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            match session_id {
                Some(session_id) => {
                    response_to_message(req_id, delete_session(session_id).map(|_| json!({})))
                }
                None => error_response(req_id, 400, "INVALID_PAYLOAD"),
            }
        }
        "sessions.resume" => error_response(req_id, 501, "UNIMPLEMENTED"),
        _ => error_response(req_id, 404, "UNKNOWN_OP"),
    }
}

fn handle_project_detail(project_id: i64) -> Result<Value, String> {
    let project = get_project_by_id(project_id)?.ok_or_else(|| "PROJECT_NOT_FOUND".to_string())?;
    let sessions = get_project_sessions(project.path.clone())?;
    let terminal_history = get_terminal_history(project.path.clone())?;
    Ok(json!({
        "project": project,
        "sessions": sessions,
        "terminal_history": terminal_history,
    }))
}

fn get_project_by_id(project_id: i64) -> Result<Option<crate::Project>, String> {
    let conn = open_db()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, path, hooks_installed, created_at, updated_at, default_provider_id FROM projects WHERE id = ?1",
        )
        .map_err(|e| e.to_string())?;

    let project = stmt
        .query_row(params![project_id], |row| {
            Ok(crate::Project {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                hooks_installed: row.get::<_, i64>(3)? != 0,
                agent_teams_enabled: false,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                default_provider_id: row.get(6)?,
            })
        })
        .optional()
        .map_err(|e| e.to_string())?;

    Ok(project)
}

fn get_project_path_by_id(project_id: i64) -> Result<Option<String>, String> {
    let conn = open_db()?;
    let path = conn
        .query_row(
            "SELECT path FROM projects WHERE id = ?1",
            params![project_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(path)
}

fn get_project_id_by_path(project_path: &str) -> Result<Option<i64>, String> {
    let conn = open_db()?;
    let project_id = conn
        .query_row(
            "SELECT id FROM projects WHERE path = ?1",
            params![project_path],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(project_id)
}

fn response_to_message(req_id: String, response: Result<Value, String>) -> TunnelMessage {
    match response {
        Ok(payload) => success_response(req_id, payload),
        Err(err) => error_response(req_id, 500, &err),
    }
}

fn success_response(req_id: String, payload: Value) -> TunnelMessage {
    TunnelMessage::Response {
        req_id,
        ok: true,
        status: Some(200),
        payload: Some(payload),
        error: None,
    }
}

fn error_response(req_id: String, status: u16, error: &str) -> TunnelMessage {
    TunnelMessage::Response {
        req_id,
        ok: false,
        status: Some(status),
        payload: None,
        error: Some(error.to_string()),
    }
}

fn capabilities_list() -> Vec<String> {
    vec![
        "projects.list",
        "projects.detail",
        "sessions.list",
        "terminal.history",
        "terminal.exec",
        "sessions.rename",
        "sessions.delete",
        "sessions.resume",
    ]
    .into_iter()
    .map(|s| s.to_string())
    .collect()
}

#[derive(Debug, Deserialize)]
struct PtyDataPayload {
    #[serde(rename = "projectPath")]
    project_path: String,
    #[serde(rename = "terminalId")]
    terminal_id: String,
    data: String,
}

#[derive(Debug, Deserialize)]
struct PtyExitPayload {
    #[serde(rename = "projectPath")]
    project_path: String,
    #[serde(rename = "terminalId")]
    terminal_id: String,
}

async fn forward_pty_data_event(app: &tauri::AppHandle, raw_payload: &str) -> Result<(), String> {
    let payload: PtyDataPayload = serde_json::from_str(raw_payload).map_err(|e| e.to_string())?;
    let project_id = get_project_id_by_path(&payload.project_path)?
        .ok_or_else(|| "PROJECT_NOT_FOUND".to_string())?;

    let message = TunnelMessage::Event {
        project_id: project_id.to_string(),
        event_type: "terminal_output_chunk".to_string(),
        payload: json!({
            "terminal_id": payload.terminal_id,
            "data": payload.data,
        }),
    };

    send_event(app, message).await
}

async fn forward_pty_exit_event(app: &tauri::AppHandle, raw_payload: &str) -> Result<(), String> {
    let payload: PtyExitPayload = serde_json::from_str(raw_payload).map_err(|e| e.to_string())?;
    let project_id = get_project_id_by_path(&payload.project_path)?
        .ok_or_else(|| "PROJECT_NOT_FOUND".to_string())?;

    let message = TunnelMessage::Event {
        project_id: project_id.to_string(),
        event_type: "terminal_exit".to_string(),
        payload: json!({
            "terminal_id": payload.terminal_id,
        }),
    };

    send_event(app, message).await
}

async fn send_event(app: &tauri::AppHandle, message: TunnelMessage) -> Result<(), String> {
    let state = app.state::<WebAgentState>();
    let sender = { state.sender.lock().unwrap().clone() };
    if let Some(sender) = sender {
        sender
            .send(message)
            .await
            .map_err(|_| "web agent outbound channel closed".to_string())
    } else {
        Err("web agent not connected".to_string())
    }
}
