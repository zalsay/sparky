use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::extract::{Query, State as AxumState};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State as TauriState};
use tokio::sync::oneshot;
use tokio::time::{timeout, Duration};
use uuid::Uuid;

const MCP_PROTOCOL_VERSION: &str = "2025-06-18";
const SERVER_NAME: &str = "sparky-browser";
const SERVER_VERSION: &str = "0.1.0";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Serialize)]
pub struct BrowserMcpConnection {
    pub endpoint: String,
    pub token: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct BrowserBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct BrowserTarget {
    pub target_id: String,
    pub project_path: String,
    pub tab_id: String,
    pub webview_label: String,
    pub title: String,
    pub url: String,
    pub bounds: Option<BrowserBounds>,
}

pub struct BrowserMcpState {
    app: Mutex<Option<AppHandle>>,
    endpoint: Mutex<Option<String>>,
    auth_token: String,
    targets: Mutex<HashMap<String, BrowserTarget>>,
    terminal_targets: Mutex<HashMap<String, String>>,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
}

pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("browser-bridge")
        .invoke_handler(tauri::generate_handler![
            browser_bridge_response,
            browser_debug_log,
            browser_link_open,
        ])
        .build()
}

impl BrowserMcpState {
    pub fn new() -> Self {
        Self {
            app: Mutex::new(None),
            endpoint: Mutex::new(None),
            auth_token: Uuid::new_v4().to_string(),
            targets: Mutex::new(HashMap::new()),
            terminal_targets: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
        }
    }

    pub fn connection(&self, terminal_id: &str) -> Option<BrowserMcpConnection> {
        let endpoint = self.endpoint.lock().ok()?.clone()?;
        Some(BrowserMcpConnection {
            endpoint: format!(
                "{}?terminal_id={}",
                endpoint,
                encode_query_component(terminal_id)
            ),
            token: self.auth_token.clone(),
        })
    }

    fn app(&self) -> Result<AppHandle, String> {
        self.app
            .lock()
            .map_err(|_| "Browser bridge state is poisoned".to_string())?
            .clone()
            .ok_or_else(|| "Browser bridge is not ready".to_string())
    }

    fn target(&self, target_id: &str) -> Result<BrowserTarget, String> {
        self.targets
            .lock()
            .map_err(|_| "Browser target state is poisoned".to_string())?
            .get(target_id)
            .cloned()
            .ok_or_else(|| format!("Browser target not found: {}", target_id))
    }

    fn resolve_target(
        &self,
        terminal_id: Option<&str>,
        args: &Value,
    ) -> Result<BrowserTarget, String> {
        if let Some(target_id) = args.get("target_id").and_then(Value::as_str) {
            return self.target(target_id);
        }

        if let Some(terminal_id) = terminal_id {
            if let Some(target_id) = self
                .terminal_targets
                .lock()
                .map_err(|_| "Browser target state is poisoned".to_string())?
                .get(terminal_id)
                .cloned()
            {
                return self.target(&target_id);
            }
        }

        let targets = self
            .targets
            .lock()
            .map_err(|_| "Browser target state is poisoned".to_string())?;
        if targets.len() == 1 {
            return targets
                .values()
                .next()
                .cloned()
                .ok_or_else(|| "No browser target is available".to_string());
        }

        Err(
            "No browser target is attached. Call browser_targets and browser_attach first."
                .to_string(),
        )
    }

    async fn evaluate(&self, target: &BrowserTarget, body: String) -> Result<Value, String> {
        let request_id = Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|_| "Browser bridge state is poisoned".to_string())?
            .insert(request_id.clone(), sender);

        let app = match self.app() {
            Ok(app) => app,
            Err(error) => {
                self.remove_pending(&request_id);
                return Err(error);
            }
        };
        let webview = app
            .get_webview(&target.webview_label)
            .ok_or_else(|| format!("WebView not found: {}", target.webview_label));
        let webview = match webview {
            Ok(webview) => webview,
            Err(error) => {
                self.remove_pending(&request_id);
                return Err(error);
            }
        };

        let script = bridge_script(&request_id, &body);
        if let Err(error) = webview.eval(script) {
            self.remove_pending(&request_id);
            return Err(format!("Failed to evaluate browser script: {}", error));
        }

        match timeout(REQUEST_TIMEOUT, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("Browser bridge response channel closed".to_string()),
            Err(_) => {
                self.remove_pending(&request_id);
                Err("Timed out waiting for browser page response".to_string())
            }
        }
    }

    fn remove_pending(&self, request_id: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(request_id);
        }
    }

    async fn call_tool(
        &self,
        terminal_id: Option<&str>,
        name: &str,
        args: Value,
    ) -> Result<Value, String> {
        match name {
            "browser_targets" => {
                let targets = self
                    .targets
                    .lock()
                    .map_err(|_| "Browser target state is poisoned".to_string())?;
                let bound_target = terminal_id.and_then(|id| {
                    self.terminal_targets
                        .lock()
                        .ok()
                        .and_then(|bindings| bindings.get(id).cloned())
                });
                let result = targets
                    .values()
                    .filter(|target| {
                        args.get("project_path")
                            .and_then(Value::as_str)
                            .map(|path| path == target.project_path)
                            .unwrap_or(true)
                    })
                    .map(|target| {
                        json!({
                            "target_id": target.target_id,
                            "project_path": target.project_path,
                            "tab_id": target.tab_id,
                            "title": target.title,
                            "url": target.url,
                            "webview_label": target.webview_label,
                            "attached": bound_target.as_deref() == Some(target.target_id.as_str()),
                        })
                    })
                    .collect::<Vec<_>>();
                Ok(json!({ "targets": result }))
            }
            "browser_attach" => {
                let terminal_id = terminal_id
                    .or_else(|| args.get("terminal_id").and_then(Value::as_str))
                    .ok_or_else(|| {
                        "browser_attach requires a terminal-bound MCP session".to_string()
                    })?;
                let target_id = args
                    .get("target_id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "browser_attach requires target_id".to_string())?;
                let target = self.target(target_id)?;
                self.terminal_targets
                    .lock()
                    .map_err(|_| "Browser target state is poisoned".to_string())?
                    .insert(terminal_id.to_string(), target_id.to_string());
                Ok(json!({
                    "attached": true,
                    "target_id": target.target_id,
                    "title": target.title,
                    "url": target.url,
                }))
            }
            "browser_snapshot" => {
                let target = self.resolve_target(terminal_id, &args)?;
                let max_chars = args
                    .get("max_chars")
                    .and_then(Value::as_u64)
                    .unwrap_or(12000)
                    .clamp(1000, 50000);
                self.evaluate(&target, snapshot_script(max_chars as usize))
                    .await
            }
            "browser_get_url" => {
                let target = self.resolve_target(terminal_id, &args)?;
                self.evaluate(
                    &target,
                    "({ url: location.href, title: document.title })".to_string(),
                )
                .await
            }
            "browser_click" => {
                let target = self.resolve_target(terminal_id, &args)?;
                let locator = locator_json(&args)?;
                self.evaluate(&target, click_script(&locator)).await
            }
            "browser_fill" => {
                let target = self.resolve_target(terminal_id, &args)?;
                let locator = locator_json(&args)?;
                let text = args
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "browser_fill requires text".to_string())?;
                self.evaluate(&target, fill_script(&locator, text)).await
            }
            "browser_press" => {
                let target = self.resolve_target(terminal_id, &args)?;
                let locator = locator_json(&args).unwrap_or_else(|_| "null".to_string());
                let key = args
                    .get("key")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "browser_press requires key".to_string())?;
                self.evaluate(&target, press_script(&locator, key)).await
            }
            "browser_scroll" => {
                let target = self.resolve_target(terminal_id, &args)?;
                self.evaluate(&target, scroll_script(&args)).await
            }
            "browser_wait_for" => {
                let target = self.resolve_target(terminal_id, &args)?;
                let locator = locator_json(&args)?;
                let timeout_ms = args
                    .get("timeout_ms")
                    .and_then(Value::as_u64)
                    .unwrap_or(10000)
                    .clamp(100, 30000);
                self.evaluate(&target, wait_script(&locator, timeout_ms))
                    .await
            }
            "browser_navigate" => {
                let target = self.resolve_target(terminal_id, &args)?;
                let url = args
                    .get("url")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "browser_navigate requires url".to_string())?;
                let parsed =
                    url::Url::parse(url).map_err(|error| format!("Invalid URL: {}", error))?;
                if !matches!(parsed.scheme(), "http" | "https") {
                    return Err("Only http and https navigation is allowed".to_string());
                }
                self.evaluate(&target, format!("(() => {{ const url = {}; setTimeout(() => {{ location.href = url; }}, 0); return {{ navigating: true, url }}; }})()", json_string(url)))
                    .await
            }
            "browser_evaluate" => {
                let target = self.resolve_target(terminal_id, &args)?;
                let script = args
                    .get("script")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "browser_evaluate requires script".to_string())?;
                if script.len() > 64 * 1024 {
                    return Err("browser_evaluate script is too large".to_string());
                }
                self.evaluate(
                    &target,
                    format!("(async () => {{ return await ({}) }})()", script),
                )
                .await
            }
            "browser_screenshot" => {
                let target = self.resolve_target(terminal_id, &args)?;
                capture_target_screenshot(self, &target)
            }
            _ => Err(format!("Unknown browser tool: {}", name)),
        }
    }
}

impl Default for BrowserMcpState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct BrowserMcpStatus {
    pub installed: bool,
    pub running: bool,
    pub path: String,
    pub endpoint: Option<String>,
}

#[derive(Debug, Deserialize)]
struct McpQuery {
    terminal_id: Option<String>,
}

pub fn start_server(app: AppHandle, state: Arc<BrowserMcpState>) -> Result<(), String> {
    state
        .app
        .lock()
        .map_err(|_| "Browser bridge state is poisoned".to_string())?
        .replace(app.clone());

    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("Failed to bind browser MCP server: {}", error))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("Failed to configure browser MCP server: {}", error))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("Failed to read browser MCP server address: {}", error))?;
    let endpoint = format!("http://{}/mcp", address);
    state
        .endpoint
        .lock()
        .map_err(|_| "Browser bridge state is poisoned".to_string())?
        .replace(endpoint.clone());

    let router = Router::new()
        .route("/mcp", post(mcp_handler))
        .with_state(state.clone());

    tauri::async_runtime::spawn(async move {
        let tokio_listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(listener) => listener,
            Err(error) => {
                log::error!("Failed to start browser MCP listener: {}", error);
                return;
            }
        };
        if let Err(error) = axum::serve(tokio_listener, router).await {
            log::error!("Browser MCP server stopped: {}", error);
        }
    });

    log::info!("Browser MCP server listening at {}", endpoint);
    Ok(())
}

pub fn status(state: &BrowserMcpState) -> BrowserMcpStatus {
    let endpoint = state.endpoint.lock().ok().and_then(|value| value.clone());
    BrowserMcpStatus {
        installed: endpoint.is_some(),
        running: endpoint.is_some(),
        path: endpoint.clone().unwrap_or_default(),
        endpoint,
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_browser_mcp_status(state: TauriState<'_, Arc<BrowserMcpState>>) -> BrowserMcpStatus {
    status(state.inner())
}

#[tauri::command(rename_all = "snake_case")]
pub fn browser_register_target(
    state: TauriState<'_, Arc<BrowserMcpState>>,
    target_id: String,
    project_path: String,
    tab_id: String,
    webview_label: String,
    title: String,
    url: String,
) -> Result<(), String> {
    state
        .targets
        .lock()
        .map_err(|_| "Browser target state is poisoned".to_string())?
        .insert(
            target_id.clone(),
            BrowserTarget {
                target_id,
                project_path,
                tab_id,
                webview_label,
                title,
                url,
                bounds: None,
            },
        );
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn browser_update_target(
    state: TauriState<'_, Arc<BrowserMcpState>>,
    target_id: String,
    title: Option<String>,
    url: Option<String>,
) -> Result<(), String> {
    let mut targets = state
        .targets
        .lock()
        .map_err(|_| "Browser target state is poisoned".to_string())?;
    let target = targets
        .get_mut(&target_id)
        .ok_or_else(|| format!("Browser target not found: {}", target_id))?;
    if let Some(title) = title {
        target.title = title;
    }
    if let Some(url) = url {
        target.url = url;
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn browser_update_target_bounds(
    state: TauriState<'_, Arc<BrowserMcpState>>,
    target_id: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let mut targets = state
        .targets
        .lock()
        .map_err(|_| "Browser target state is poisoned".to_string())?;
    let target = targets
        .get_mut(&target_id)
        .ok_or_else(|| format!("Browser target not found: {}", target_id))?;
    target.bounds = Some(BrowserBounds {
        x,
        y,
        width,
        height,
    });
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn browser_bind_target(
    state: TauriState<'_, Arc<BrowserMcpState>>,
    terminal_id: String,
    target_id: String,
) -> Result<(), String> {
    state.target(&target_id)?;
    state
        .terminal_targets
        .lock()
        .map_err(|_| "Browser target state is poisoned".to_string())?
        .insert(terminal_id, target_id);
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn browser_capture_screenshot(
    state: TauriState<'_, Arc<BrowserMcpState>>,
    target_id: String,
) -> Result<String, String> {
    let target = state.target(&target_id)?;
    let result = capture_target_screenshot(state.inner(), &target)?;
    result
        .get("path")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "Browser screenshot did not return a path".to_string())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn browser_reload_target(
    state: TauriState<'_, Arc<BrowserMcpState>>,
    target_id: String,
) -> Result<(), String> {
    let target = state.target(&target_id)?;
    state
        .evaluate(
            &target,
            "(() => { setTimeout(() => location.reload(), 0); return { reloading: true }; })()"
                .to_string(),
        )
        .await
        .map(|_| ())
}

#[tauri::command(rename_all = "snake_case")]
pub fn browser_unregister_target(
    state: TauriState<'_, Arc<BrowserMcpState>>,
    target_id: String,
) -> Result<(), String> {
    state
        .targets
        .lock()
        .map_err(|_| "Browser target state is poisoned".to_string())?
        .remove(&target_id);
    state
        .terminal_targets
        .lock()
        .map_err(|_| "Browser target state is poisoned".to_string())?
        .retain(|_, bound_target| bound_target != &target_id);
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn browser_debug_log(message: String) -> Result<(), String> {
    let message = message.strip_prefix("[IDE_OPEN] ").unwrap_or(&message);
    log::info!("[IDE_OPEN] remote {}", message);
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn browser_link_open<R: tauri::Runtime>(
    app: AppHandle<R>,
    project_path: String,
    tab_id: String,
    url: String,
    kind: String,
) -> Result<(), String> {
    let parsed_url = url::Url::parse(&url).map_err(|error| format!("Invalid opened URL: {}", error))?;
    if !matches!(parsed_url.scheme(), "http" | "https") {
        return Err("Only http and https opened URLs are allowed".to_string());
    }
    log::info!(
        "[IDE_OPEN] remote-command kind={} source_tab={} url={}",
        kind,
        tab_id,
        parsed_url,
    );
    app.emit(
        "ide-new-window",
        serde_json::json!({
            "projectPath": project_path,
            "sourceTabId": tab_id,
            "url": parsed_url.to_string(),
        }),
    )
    .map_err(|error| format!("Emit IDE new-window event failed: {}", error))?;
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn browser_bridge_response(
    state: TauriState<'_, Arc<BrowserMcpState>>,
    request_id: String,
    ok: bool,
    result: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    let sender = state
        .pending
        .lock()
        .map_err(|_| "Browser bridge state is poisoned".to_string())?
        .remove(&request_id);
    if let Some(sender) = sender {
        let response = if ok {
            Ok(result.unwrap_or(Value::Null))
        } else {
            Err(error.unwrap_or_else(|| "Browser script failed".to_string()))
        };
        let _ = sender.send(response);
    }
    Ok(())
}

async fn mcp_handler(
    AxumState(state): AxumState<Arc<BrowserMcpState>>,
    headers: HeaderMap,
    Query(query): Query<McpQuery>,
    Json(message): Json<Value>,
) -> Response {
    if !authorized(&state, &headers) {
        return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    }

    let id = message.get("id").cloned();
    let method = match message.get("method").and_then(Value::as_str) {
        Some(method) => method,
        None => return json_rpc_error(id, -32600, "Invalid JSON-RPC request"),
    };

    if method.starts_with("notifications/") {
        return StatusCode::ACCEPTED.into_response();
    }

    let result = match method {
        "initialize" => {
            let requested_version = message
                .get("params")
                .and_then(|params| params.get("protocolVersion"))
                .and_then(Value::as_str)
                .unwrap_or(MCP_PROTOCOL_VERSION);
            Ok(json!({
                "protocolVersion": requested_version,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION },
            }))
        }
        "tools/list" => Ok(json!({ "tools": tool_definitions() })),
        "tools/call" => {
            let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| "tools/call requires name".to_string());
            match name {
                Ok(name) => {
                    let args = params
                        .get("arguments")
                        .cloned()
                        .unwrap_or_else(|| json!({}));
                    let terminal_id = query.terminal_id.clone().or_else(|| {
                        args.get("terminal_id")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    });
                    match state.call_tool(terminal_id.as_deref(), name, args).await {
                        Ok(value) => Ok(tool_result(value, false)),
                        Err(error) => Ok(tool_result(json!({ "error": error }), true)),
                    }
                }
                Err(error) => Err(error),
            }
        }
        _ => Err(format!("Method not found: {}", method)),
    };

    match result {
        Ok(value) => json_rpc_result(id, value),
        Err(error) => json_rpc_error(id, -32601, &error),
    }
}

fn authorized(state: &BrowserMcpState, headers: &HeaderMap) -> bool {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .map(|value| value == format!("Bearer {}", state.auth_token))
        .unwrap_or(false)
}

fn json_rpc_result(id: Option<Value>, result: Value) -> Response {
    let body = json!({ "jsonrpc": "2.0", "id": id.unwrap_or(Value::Null), "result": result });
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json"),
            (
                header::HeaderName::from_static("mcp-protocol-version"),
                MCP_PROTOCOL_VERSION,
            ),
        ],
        Json(body),
    )
        .into_response()
}

fn json_rpc_error(id: Option<Value>, code: i64, message: &str) -> Response {
    let body = json!({
        "jsonrpc": "2.0",
        "id": id.unwrap_or(Value::Null),
        "error": { "code": code, "message": message },
    });
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json"),
            (
                header::HeaderName::from_static("mcp-protocol-version"),
                MCP_PROTOCOL_VERSION,
            ),
        ],
        Json(body),
    )
        .into_response()
}

fn tool_result(value: Value, is_error: bool) -> Value {
    let text = serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string());
    json!({
        "content": [{ "type": "text", "text": text }],
        "structuredContent": value,
        "isError": is_error,
    })
}

fn tool_definitions() -> Vec<Value> {
    vec![
        json!({
            "name": "browser_targets",
            "description": "List browser pages currently embedded in Sparky. Use browser_attach before operating a page when more than one target exists.",
            "inputSchema": { "type": "object", "properties": { "project_path": { "type": "string" } } },
        }),
        json!({
            "name": "browser_attach",
            "description": "Attach this Agent session to one Sparky browser target.",
            "inputSchema": { "type": "object", "required": ["target_id"], "properties": { "target_id": { "type": "string" } } },
        }),
        json!({
            "name": "browser_snapshot",
            "description": "Return a compact accessibility-oriented DOM snapshot with stable refs for interactive elements.",
            "inputSchema": { "type": "object", "properties": { "target_id": { "type": "string" }, "max_chars": { "type": "integer", "minimum": 1000, "maximum": 50000 } } },
        }),
        json!({
            "name": "browser_get_url",
            "description": "Read the current URL and document title.",
            "inputSchema": { "type": "object", "properties": { "target_id": { "type": "string" } } },
        }),
        json!({
            "name": "browser_click",
            "description": "Click an element by a snapshot ref or CSS selector.",
            "inputSchema": locator_schema(),
        }),
        json!({
            "name": "browser_fill",
            "description": "Fill an input, textarea, or contenteditable element by snapshot ref or CSS selector.",
            "inputSchema": {
                "type": "object",
                "required": ["text"],
                "properties": {
                    "target_id": { "type": "string" },
                    "ref": { "type": "string" },
                    "selector": { "type": "string" },
                    "text": { "type": "string" },
                },
            },
        }),
        json!({
            "name": "browser_press",
            "description": "Dispatch a keyboard key to an element or the active page.",
            "inputSchema": {
                "type": "object",
                "required": ["key"],
                "properties": {
                    "target_id": { "type": "string" },
                    "ref": { "type": "string" },
                    "selector": { "type": "string" },
                    "key": { "type": "string" },
                },
            },
        }),
        json!({
            "name": "browser_scroll",
            "description": "Scroll the page or an element into view.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "target_id": { "type": "string" },
                    "ref": { "type": "string" },
                    "selector": { "type": "string" },
                    "direction": { "type": "string", "enum": ["up", "down", "left", "right"] },
                    "amount": { "type": "integer", "minimum": 1, "maximum": 4000 },
                },
            },
        }),
        json!({
            "name": "browser_wait_for",
            "description": "Wait until an element identified by snapshot ref or CSS selector exists.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "target_id": { "type": "string" },
                    "ref": { "type": "string" },
                    "selector": { "type": "string" },
                    "timeout_ms": { "type": "integer", "minimum": 100, "maximum": 30000 },
                },
            },
        }),
        json!({
            "name": "browser_navigate",
            "description": "Navigate the attached page to an http or https URL.",
            "inputSchema": { "type": "object", "required": ["url"], "properties": { "target_id": { "type": "string" }, "url": { "type": "string" } } },
        }),
        json!({
            "name": "browser_evaluate",
            "description": "Evaluate a page expression in the attached target. Use only for focused DOM inspection or interaction.",
            "inputSchema": { "type": "object", "required": ["script"], "properties": { "target_id": { "type": "string" }, "script": { "type": "string" } } },
        }),
        json!({
            "name": "browser_screenshot",
            "description": "Capture the visible bounds of the attached Sparky browser target and return the PNG path.",
            "inputSchema": { "type": "object", "properties": { "target_id": { "type": "string" } } },
        }),
    ]
}

fn locator_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "target_id": { "type": "string" },
            "ref": { "type": "string" },
            "selector": { "type": "string" },
        },
        "oneOf": [{ "required": ["ref"] }, { "required": ["selector"] }],
    })
}

fn locator_json(args: &Value) -> Result<String, String> {
    if let Some(reference) = args.get("ref").and_then(Value::as_str) {
        return Ok(json!({ "ref": reference }).to_string());
    }
    if let Some(selector) = args.get("selector").and_then(Value::as_str) {
        return Ok(json!({ "selector": selector }).to_string());
    }
    Err("A ref or selector is required".to_string())
}

fn bridge_script(request_id: &str, body: &str) -> String {
    format!(
        r#"(async () => {{
  const requestId = {};
  const send = async (payload) => {{
    const invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
    if (typeof invoke !== 'function') throw new Error('Tauri IPC is unavailable in the browser target');
    await invoke('plugin:browser-bridge|browser_bridge_response', payload);
  }};
  const resolveLocator = (locator) => {{
    if (!locator) return null;
    if (locator.ref) {{
      return Array.from(document.querySelectorAll('[data-sparky-ref]'))
        .find((element) => element.getAttribute('data-sparky-ref') === locator.ref) || null;
    }}
    if (locator.selector) return document.querySelector(locator.selector);
    return null;
  }};
  try {{
    const value = await (async () => {{ {} }})();
    await send({{ request_id: requestId, ok: true, result: value === undefined ? null : value }});
  }} catch (error) {{
    try {{
      await send({{
        request_id: requestId,
        ok: false,
        error: String(error && (error.stack || error.message) || error),
      }});
    }} catch (_) {{}}
  }}
}})();"#,
        json_string(request_id),
        body
    )
}

fn snapshot_script(max_chars: usize) -> String {
    format!(
        r#"(() => {{
  const maxChars = {};
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const visible = (element) => {{
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  }};
  const nameOf = (element) => clean(
    element.getAttribute('aria-label') ||
    element.getAttribute('title') ||
    element.getAttribute('placeholder') ||
    element.innerText ||
    element.value ||
    element.getAttribute('alt') ||
    ''
  ).slice(0, 240);
  const interactive = new Set(['A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'SUMMARY']);
  const elements = [];
  let index = 0;
  for (const element of Array.from(document.querySelectorAll('body *'))) {{
    if (!visible(element)) continue;
    const role = element.getAttribute('role') || '';
    const isInteractive = interactive.has(element.tagName) || !!role || element.tabIndex >= 0 || element.isContentEditable;
    if (!isInteractive) continue;
    const ref = `sp-${{++index}}`;
    element.setAttribute('data-sparky-ref', ref);
    elements.push({{
      ref,
      tag: element.tagName.toLowerCase(),
      role: role || undefined,
      name: nameOf(element),
      text: clean(element.innerText).slice(0, 240),
      value: typeof element.value === 'string' ? element.value.slice(0, 240) : undefined,
      placeholder: element.getAttribute('placeholder') || undefined,
      href: element instanceof HTMLAnchorElement ? element.href : undefined,
      disabled: !!element.disabled,
    }});
  }}
  const bodyText = clean(document.body && document.body.innerText).slice(0, maxChars);
  return {{
    url: location.href,
    title: document.title,
    viewport: {{ width: window.innerWidth, height: window.innerHeight }},
    text: bodyText,
    elements,
  }};
}})()"#,
        max_chars
    )
}

fn click_script(locator: &str) -> String {
    format!(
        r#"(() => {{
  const locator = {};
  const element = resolveLocator(locator);
  if (!element) throw new Error('Element not found');
  element.scrollIntoView({{ block: 'center', inline: 'center' }});
  element.focus({{ preventScroll: true }});
  element.click();
  return {{ clicked: true, tag: element.tagName.toLowerCase(), text: String(element.innerText || element.value || '').trim().slice(0, 240) }};
}})()"#,
        locator
    )
}

fn fill_script(locator: &str, text: &str) -> String {
    format!(
        r#"(() => {{
  const locator = {};
  const value = {};
  const element = resolveLocator(locator);
  if (!element) throw new Error('Element not found');
  element.scrollIntoView({{ block: 'center', inline: 'center' }});
  element.focus({{ preventScroll: true }});
  if (element.isContentEditable) {{
    element.textContent = value;
  }} else {{
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (!descriptor || !descriptor.set) throw new Error('Element is not fillable');
    descriptor.set.call(element, value);
  }}
  element.dispatchEvent(new Event('input', {{ bubbles: true, composed: true }}));
  element.dispatchEvent(new Event('change', {{ bubbles: true, composed: true }}));
  return {{ filled: true }};
}})()"#,
        locator,
        json_string(text)
    )
}

fn press_script(locator: &str, key: &str) -> String {
    format!(
        r#"(() => {{
  const locator = {};
  const element = locator === null ? (document.activeElement || document.body) : resolveLocator(locator);
  if (!element) throw new Error('Element not found');
  element.focus({{ preventScroll: true }});
  const init = {{ key: {}, code: {}, bubbles: true, cancelable: true, composed: true }};
  element.dispatchEvent(new KeyboardEvent('keydown', init));
  element.dispatchEvent(new KeyboardEvent('keyup', init));
  if (init.key === 'Enter' && element.form && typeof element.form.requestSubmit === 'function') element.form.requestSubmit();
  return {{ pressed: init.key }};
}})()"#,
        locator,
        json_string(key),
        json_string(key)
    )
}

fn scroll_script(args: &Value) -> String {
    let direction = args
        .get("direction")
        .and_then(Value::as_str)
        .unwrap_or("down");
    let amount = args
        .get("amount")
        .and_then(Value::as_i64)
        .unwrap_or(600)
        .clamp(1, 4000);
    let locator = if args.get("ref").is_some() || args.get("selector").is_some() {
        locator_json(args).unwrap_or_else(|_| "null".to_string())
    } else {
        "null".to_string()
    };
    format!(
        r#"(() => {{
  const locator = {};
  if (locator !== null) {{
    const element = resolveLocator(locator);
    if (!element) throw new Error('Element not found');
    element.scrollIntoView({{ block: 'center', inline: 'center' }});
  }} else {{
    const amount = {};
    const direction = {};
    const x = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
    const y = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
    window.scrollBy({{ left: x, top: y, behavior: 'smooth' }});
  }}
  return {{ scrolled: true }};
}})()"#,
        locator,
        amount,
        json_string(direction)
    )
}

fn wait_script(locator: &str, timeout_ms: u64) -> String {
    format!(
        r#"(async () => {{
  const locator = {};
  const find = () => resolveLocator(locator);
  if (find()) return {{ found: true }};
  await new Promise((resolve, reject) => {{
    const observer = new MutationObserver(() => {{ if (find()) {{ observer.disconnect(); resolve(); }} }});
    observer.observe(document.documentElement, {{ subtree: true, childList: true, attributes: true }});
    setTimeout(() => {{ observer.disconnect(); reject(new Error('Timed out waiting for element')); }}, {});
  }});
  return {{ found: true }};
}})()"#,
        locator, timeout_ms
    )
}

fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

fn encode_query_component(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
                vec![byte as char]
            } else {
                format!("%{:02X}", byte).chars().collect()
            }
        })
        .collect()
}

fn capture_target_screenshot(
    state: &BrowserMcpState,
    target: &BrowserTarget,
) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;

        let bounds = target
            .bounds
            .as_ref()
            .ok_or_else(|| "Browser target bounds are not available yet".to_string())?;
        let app = state.app()?;
        if let Some(main_window) = app.get_webview_window("main") {
            let _ = main_window.set_focus();
        }
        let directory = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("Resolve screenshot directory failed: {}", error))?
            .join("screenshots");
        std::fs::create_dir_all(&directory)
            .map_err(|error| format!("Create screenshot directory failed: {}", error))?;
        let path = directory.join(format!("browser-{}.png", Uuid::new_v4()));
        let rect = format!(
            "{},{},{},{}",
            bounds.x, bounds.y, bounds.width, bounds.height
        );
        let status = Command::new("/usr/sbin/screencapture")
            .args(["-x", "-R", &rect, "-t", "png"])
            .arg(&path)
            .status()
            .map_err(|error| format!("Start browser screenshot failed: {}", error))?;
        if !status.success() || !path.is_file() {
            let _ = std::fs::remove_file(&path);
            return Err("Browser screenshot failed".to_string());
        }
        return Ok(json!({ "path": path.to_string_lossy(), "target_id": target.target_id }));
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (state, target);
        Err("Browser screenshots are currently supported on macOS only".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::encode_query_component;
    use super::mcp_handler;
    use super::tool_definitions;
    use super::BrowserMcpState;
    use super::McpQuery;
    use super::SERVER_NAME;
    use axum::body::to_bytes;
    use axum::extract::{Query, State as AxumState};
    use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
    use axum::Json;
    use serde_json::json;
    use std::sync::Arc;

    #[test]
    fn query_component_encodes_terminal_id_safely() {
        assert_eq!(encode_query_component("terminal-123"), "terminal-123");
        assert_eq!(encode_query_component("a b"), "a%20b");
    }

    #[test]
    fn browser_tools_include_core_agent_operations() {
        let tools = tool_definitions();
        for expected in [
            "browser_targets",
            "browser_snapshot",
            "browser_click",
            "browser_fill",
            "browser_press",
            "browser_wait_for",
            "browser_screenshot",
        ] {
            assert!(tools.iter().any(|tool| tool["name"] == expected));
        }
    }

    #[tokio::test]
    async fn authorized_mcp_initialize_and_tools_list_return_json_rpc() {
        let state = Arc::new(BrowserMcpState::new());
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", state.auth_token)).expect("auth header"),
        );

        let initialize = mcp_handler(
            AxumState(state.clone()),
            headers.clone(),
            Query(McpQuery { terminal_id: None }),
            Json(json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": { "protocolVersion": "2025-06-18" }
            })),
        )
        .await;
        assert_eq!(initialize.status(), StatusCode::OK);
        let initialize_body = to_bytes(initialize.into_body(), usize::MAX)
            .await
            .expect("initialize body");
        let initialize_json: serde_json::Value =
            serde_json::from_slice(&initialize_body).expect("initialize JSON");
        assert_eq!(initialize_json["result"]["serverInfo"]["name"], SERVER_NAME);

        let tools = mcp_handler(
            AxumState(state),
            headers,
            Query(McpQuery { terminal_id: None }),
            Json(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })),
        )
        .await;
        let tools_body = to_bytes(tools.into_body(), usize::MAX)
            .await
            .expect("tools body");
        let tools_json: serde_json::Value =
            serde_json::from_slice(&tools_body).expect("tools JSON");
        assert!(tools_json["result"]["tools"].as_array().unwrap().len() >= 7);
    }
}
