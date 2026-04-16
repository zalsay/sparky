use actix_web::{delete, get, post, web, App, Error, HttpRequest, HttpResponse, HttpServer};
use actix_ws::Message;
use awc::Client;
use bytes::BytesMut;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use sparky::auth::AuthSession;
use sparky::config::ServerConfig;
use sparky::dev_server::{build_dev_request_path, bytes_to_string};
use sparky::editor::{build_editor_url, list_directory, resolve_requested_path};
use sparky::executor::{ExecutorRuntime, SessionAccessError};
use sparky::git::{
    execute_git_action, load_git_status, resolve_runtime_worktree, GitRuntimeContext,
};
use sparky::internal_api::{
    CreateExecutorSessionRequest, FileTreeRequest, FileTreeResponse, GitActionRequest,
    GitActionResponse, GitStatusRequest, GitStatusResponse, OpenEditorRequest, OpenEditorResponse,
    OpenWebRequest, OpenWebResponse, WebTargetsRequest, WebTargetsResponse,
};
use sparky::session::SessionSummary;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

const PROXY_WS_MAX_FRAME_SIZE: usize = 16 * 1024 * 1024;
const PROXY_HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const EDITOR_NOT_RUNNING_ERRORS: [&str; 2] = ["编辑器未启动", "编辑器已退出，请重新打开文件"];

#[derive(Clone)]
struct ExecutorAppState {
    runtime: Arc<ExecutorRuntime>,
    config: ServerConfig,
}

#[derive(Debug, Deserialize)]
struct SessionUserQuery {
    user_id: String,
}

#[derive(Debug, Deserialize)]
struct DestroySessionQuery {
    user_id: String,
    #[serde(default)]
    allow_persistent: bool,
}

#[derive(Debug, Deserialize)]
struct AttachSessionQuery {
    user_id: String,
}

#[get("/health")]
async fn health(state: web::Data<ExecutorAppState>) -> HttpResponse {
    HttpResponse::Ok().json(serde_json::json!({
        "status": "ok",
        "service": "executor",
        "sessions": state.runtime.session_count(),
    }))
}

#[get("/internal/sessions")]
async fn list_sessions(
    state: web::Data<ExecutorAppState>,
    query: web::Query<SessionUserQuery>,
) -> HttpResponse {
    HttpResponse::Ok().json(serde_json::json!({
        "sessions": state.runtime.list_sessions_for_user(&query.user_id),
    }))
}

#[get("/internal/sessions/{id}")]
async fn get_session(
    state: web::Data<ExecutorAppState>,
    path: web::Path<String>,
    query: web::Query<SessionUserQuery>,
) -> HttpResponse {
    let session_id = path.into_inner();
    match state
        .runtime
        .resolve_session_for_user(&query.user_id, &session_id)
    {
        Ok(session) => HttpResponse::Ok().json(serde_json::json!({
            "session": session_summary_from_runtime(session.as_ref())
        })),
        Err(SessionAccessError::Forbidden) => HttpResponse::Forbidden().json(serde_json::json!({
            "error": "forbidden"
        })),
        Err(SessionAccessError::NotFound) => HttpResponse::NotFound().json(serde_json::json!({
            "error": "session not found"
        })),
        Err(SessionAccessError::DefaultSessionCannotBeClosed) => unreachable!(),
    }
}

#[get("/internal/sessions/{id}/snapshot")]
async fn get_session_snapshot(
    state: web::Data<ExecutorAppState>,
    path: web::Path<String>,
    query: web::Query<SessionUserQuery>,
) -> HttpResponse {
    let session_id = path.into_inner();
    match state
        .runtime
        .resolve_session_for_user(&query.user_id, &session_id)
    {
        Ok(session) => {
            let (cursor, snapshot) = session.snapshot_all();
            HttpResponse::Ok().json(serde_json::json!({
                "session_id": session_id,
                "cursor": cursor,
                "snapshot": snapshot,
            }))
        }
        Err(SessionAccessError::Forbidden) => HttpResponse::Forbidden().json(serde_json::json!({
            "error": "forbidden"
        })),
        Err(SessionAccessError::NotFound) => HttpResponse::NotFound().json(serde_json::json!({
            "error": "session not found"
        })),
        Err(SessionAccessError::DefaultSessionCannotBeClosed) => unreachable!(),
    }
}

#[post("/internal/sessions")]
async fn create_session(
    state: web::Data<ExecutorAppState>,
    payload: web::Json<CreateExecutorSessionRequest>,
) -> HttpResponse {
    let request = payload.into_inner();
    let user = request.user.into_auth_session();

    let result = state.runtime.create_session_with_launch(
        &request.project,
        &user,
        request.temporary,
        request.launch_override,
        request.replace_existing,
        request.fresh,
    );

    match result {
        Ok(session) => HttpResponse::Ok().json(serde_json::json!({
            "session": session_summary_from_runtime(session.as_ref())
        })),
        Err(error) => HttpResponse::BadRequest().json(serde_json::json!({
            "error": error
        })),
    }
}

#[delete("/internal/sessions/{id}")]
async fn destroy_session(
    state: web::Data<ExecutorAppState>,
    path: web::Path<String>,
    query: web::Query<DestroySessionQuery>,
) -> HttpResponse {
    let session_id = path.into_inner();

    if !query.allow_persistent {
        match state
            .runtime
            .require_temporary_session_for_user(&query.user_id, &session_id)
        {
            Ok(()) => {}
            Err(SessionAccessError::DefaultSessionCannotBeClosed) => {
                return HttpResponse::BadRequest().json(serde_json::json!({
                    "error": "default session cannot be closed"
                }));
            }
            Err(SessionAccessError::Forbidden) => {
                return HttpResponse::Forbidden().json(serde_json::json!({
                    "error": "forbidden"
                }));
            }
            Err(SessionAccessError::NotFound) => {
                return HttpResponse::NotFound().json(serde_json::json!({
                    "error": "session not found"
                }));
            }
        }
    } else if let Err(error) = state
        .runtime
        .resolve_session_for_user(&query.user_id, &session_id)
    {
        return match error {
            SessionAccessError::Forbidden => HttpResponse::Forbidden().json(serde_json::json!({
                "error": "forbidden"
            })),
            SessionAccessError::NotFound => HttpResponse::NotFound().json(serde_json::json!({
                "error": "session not found"
            })),
            SessionAccessError::DefaultSessionCannotBeClosed => unreachable!(),
        };
    }

    state.runtime.remove_session(&session_id);
    HttpResponse::Ok().json(serde_json::json!({
        "status": "destroyed",
        "session_id": session_id,
    }))
}

#[post("/internal/editors/open")]
async fn open_editor(
    state: web::Data<ExecutorAppState>,
    payload: web::Json<OpenEditorRequest>,
) -> HttpResponse {
    let request = payload.into_inner();
    let root = request.root_path().to_path_buf();
    let user = request.user.into_auth_session();

    let file_path = match request
        .path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        Some(path) => match resolve_requested_path(&root, Some(path)) {
            Ok(path) => {
                if !path.exists() {
                    return HttpResponse::BadRequest().json(serde_json::json!({
                        "error": "文件不存在"
                    }));
                }
                if path.is_dir() {
                    return HttpResponse::BadRequest().json(serde_json::json!({
                        "error": "请选择文件而不是目录"
                    }));
                }
                Some(path)
            }
            Err(error) => {
                return HttpResponse::BadRequest().json(serde_json::json!({
                    "error": error
                }));
            }
        },
        None => None,
    };

    match state
        .runtime
        .ensure_editor(&user, &request.project_id, &root)
    {
        Ok(status) => HttpResponse::Ok().json(OpenEditorResponse {
            url: build_editor_url(status.proxy_base.as_str(), &root, file_path.as_deref()),
            status,
        }),
        Err(error) => HttpResponse::BadRequest().json(serde_json::json!({
            "error": error
        })),
    }
}

#[post("/internal/web/targets")]
async fn list_web_targets(
    state: web::Data<ExecutorAppState>,
    payload: web::Json<WebTargetsRequest>,
) -> HttpResponse {
    let request = payload.into_inner();
    let root = request.root_path().to_path_buf();
    let user = request.user.into_auth_session();

    match state.runtime.discover_web_candidates(&root) {
        Ok(candidates) => HttpResponse::Ok().json(WebTargetsResponse {
            targets: state.runtime.list_web_statuses(
                &user.user_id,
                &request.project_id,
                candidates,
            ),
        }),
        Err(error) => HttpResponse::BadRequest().json(serde_json::json!({
            "error": error
        })),
    }
}

#[post("/internal/web/open")]
async fn open_web_target(
    state: web::Data<ExecutorAppState>,
    payload: web::Json<OpenWebRequest>,
) -> HttpResponse {
    open_or_restart_web_target(state, payload.into_inner(), false).await
}

#[post("/internal/web/restart")]
async fn restart_web_target(
    state: web::Data<ExecutorAppState>,
    payload: web::Json<OpenWebRequest>,
) -> HttpResponse {
    open_or_restart_web_target(state, payload.into_inner(), true).await
}

async fn open_or_restart_web_target(
    state: web::Data<ExecutorAppState>,
    request: OpenWebRequest,
    restart: bool,
) -> HttpResponse {
    let root = request.root_path().to_path_buf();
    let user = request.user.into_auth_session();

    let candidate = match state
        .runtime
        .find_web_candidate(&root, request.candidate_id.as_deref())
    {
        Ok(candidate) => candidate,
        Err(error) => {
            return HttpResponse::BadRequest().json(serde_json::json!({
                "error": error
            }));
        }
    };

    let result = if restart {
        state
            .runtime
            .restart_dev_server(&user, &request.project_id, &candidate)
    } else {
        state
            .runtime
            .ensure_dev_server(&user, &request.project_id, &candidate)
    };

    match result {
        Ok(status) => HttpResponse::Ok().json(OpenWebResponse {
            url: status.url.clone(),
            target: candidate,
            status,
        }),
        Err(error) => HttpResponse::BadRequest().json(serde_json::json!({
            "error": error
        })),
    }
}

#[post("/internal/files/tree")]
async fn file_tree(payload: web::Json<FileTreeRequest>) -> HttpResponse {
    let request = payload.into_inner();

    let project_root = request.project_root_path().to_path_buf();
    let root = match resolve_runtime_worktree(&project_root) {
        Ok(root) => root,
        Err(error) => {
            return HttpResponse::BadRequest().json(serde_json::json!({
                "error": error
            }));
        }
    };

    let source = if root == project_root {
        "project"
    } else {
        "git"
    };
    match list_directory(&root, request.path.as_deref(), source) {
        Ok(tree) => HttpResponse::Ok().json(FileTreeResponse { tree }),
        Err(error) => HttpResponse::BadRequest().json(serde_json::json!({
            "error": error
        })),
    }
}

#[post("/internal/git/status")]
async fn git_status(
    state: web::Data<ExecutorAppState>,
    payload: web::Json<GitStatusRequest>,
) -> HttpResponse {
    let request = payload.into_inner();
    let project_root = request.project_root_path().to_path_buf();
    let user = request.user.into_auth_session();
    let runtime = GitRuntimeContext {
        home_dir: user.home_dir,
        ssh_auth_sock: state.config.ssh_auth_sock.clone(),
    };

    match load_git_status(&project_root, &runtime) {
        Ok(status) => HttpResponse::Ok().json(GitStatusResponse { status }),
        Err(error) => HttpResponse::BadRequest().json(serde_json::json!({
            "error": error
        })),
    }
}

#[post("/internal/git/action")]
async fn git_action(
    state: web::Data<ExecutorAppState>,
    payload: web::Json<GitActionRequest>,
) -> HttpResponse {
    let request = payload.into_inner();
    let project_root = request.project_root_path().to_path_buf();
    let action = request.action;
    let user = request.user.into_auth_session();
    let runtime = GitRuntimeContext {
        home_dir: user.home_dir,
        ssh_auth_sock: state.config.ssh_auth_sock.clone(),
    };

    match execute_git_action(&project_root, &runtime, action) {
        Ok(result) => HttpResponse::Ok().json(GitActionResponse::from(result)),
        Err(error) => HttpResponse::BadRequest().json(serde_json::json!({
            "error": error
        })),
    }
}

async fn attach_session_ws(
    state: web::Data<ExecutorAppState>,
    req: HttpRequest,
    stream: web::Payload,
    path: web::Path<String>,
    query: web::Query<AttachSessionQuery>,
) -> actix_web::Result<HttpResponse> {
    let session_id = path.into_inner();

    match state
        .runtime
        .resolve_session_for_user(&query.user_id, &session_id)
    {
        Ok(_) => {}
        Err(SessionAccessError::Forbidden) => {
            return Ok(HttpResponse::Forbidden().json(serde_json::json!({
                "error": "forbidden"
            })));
        }
        Err(SessionAccessError::NotFound) => {
            return Ok(HttpResponse::NotFound().json(serde_json::json!({
                "error": "session not found"
            })));
        }
        Err(SessionAccessError::DefaultSessionCannotBeClosed) => unreachable!(),
    }

    let (response, mut ws_session, mut msg_stream) = actix_ws::handle(&req, stream)?;
    let runtime = Arc::clone(&state.runtime);
    let user_id = query.user_id.clone();

    actix_web::rt::spawn(async move {
        let _ = runtime
            .attach_session(&user_id, &session_id, &mut ws_session, &mut msg_stream)
            .await;
    });

    Ok(response)
}

async fn editor_proxy_root(
    state: web::Data<ExecutorAppState>,
    req: HttpRequest,
    payload: web::Payload,
    path: web::Path<String>,
) -> Result<HttpResponse, Error> {
    editor_proxy(state, req, payload, (path.into_inner(), String::new())).await
}

async fn editor_proxy_tail(
    state: web::Data<ExecutorAppState>,
    req: HttpRequest,
    payload: web::Payload,
    path: web::Path<(String, String)>,
) -> Result<HttpResponse, Error> {
    editor_proxy(state, req, payload, path.into_inner()).await
}

async fn editor_proxy(
    state: web::Data<ExecutorAppState>,
    req: HttpRequest,
    payload: web::Payload,
    path: (String, String),
) -> Result<HttpResponse, Error> {
    let (project_id, tail) = path;
    let upstream_path = if tail.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", tail)
    };

    let user = match proxy_auth_session(&req) {
        Ok(user) => user,
        Err(response) => return Ok(response),
    };
    let root = req
        .headers()
        .get("x-sparky-root")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string);

    let upstream_url = match state.runtime.editor_upstream_url(
        &user.user_id,
        &project_id,
        upstream_path.as_str(),
        req.uri().query(),
    ) {
        Ok(url) => url,
        Err(error) if EDITOR_NOT_RUNNING_ERRORS.contains(&error.as_str()) => {
            let Some(root) = root.as_deref() else {
                return Ok(HttpResponse::BadRequest().json(serde_json::json!({
                    "error": error
                })));
            };

            match state
                .runtime
                .ensure_editor(&user, &project_id, Path::new(root))
            {
                Ok(_) => {}
                Err(error) => {
                    return Ok(HttpResponse::BadRequest().json(serde_json::json!({
                        "error": error
                    })));
                }
            }

            match state.runtime.editor_upstream_url(
                &user.user_id,
                &project_id,
                upstream_path.as_str(),
                req.uri().query(),
            ) {
                Ok(url) => url,
                Err(error) => {
                    return Ok(HttpResponse::BadRequest().json(serde_json::json!({
                        "error": error
                    })));
                }
            }
        }
        Err(error) => {
            return Ok(HttpResponse::BadRequest().json(serde_json::json!({
                "error": error
            })));
        }
    };

    if is_websocket_request(&req) {
        let origin_override = upstream_http_origin(&upstream_url);
        return proxy_http_websocket(req, payload, upstream_url, origin_override).await;
    }

    proxy_http(req, payload, upstream_url).await
}

async fn dev_proxy_root(
    state: web::Data<ExecutorAppState>,
    req: HttpRequest,
    payload: web::Payload,
    path: web::Path<(String, String)>,
) -> Result<HttpResponse, Error> {
    let (project_id, candidate_id) = path.into_inner();
    let tail = raw_proxy_tail(
        req.uri().path(),
        &format!("/internal/dev/{}/{}/proxy", project_id, candidate_id),
    );
    dev_proxy(
        state,
        req,
        payload,
        (project_id, candidate_id, tail),
    )
    .await
}

async fn dev_proxy_tail(
    state: web::Data<ExecutorAppState>,
    req: HttpRequest,
    payload: web::Payload,
    path: web::Path<(String, String, String)>,
) -> Result<HttpResponse, Error> {
    let (project_id, candidate_id, _) = path.into_inner();
    let tail = raw_proxy_tail(
        req.uri().path(),
        &format!("/internal/dev/{}/{}/proxy", project_id, candidate_id),
    );
    dev_proxy(state, req, payload, (project_id, candidate_id, tail)).await
}

async fn dev_proxy(
    state: web::Data<ExecutorAppState>,
    req: HttpRequest,
    payload: web::Payload,
    path: (String, String, String),
) -> Result<HttpResponse, Error> {
    let (project_id, candidate_id, tail) = path;
    let user = match proxy_auth_session(&req) {
        Ok(user) => user,
        Err(response) => {
            log::warn!(
                "executor dev proxy auth failed method={} path={} has_user_id={} has_username={} has_home_dir={}",
                req.method(),
                req.uri(),
                req.headers().contains_key("x-sparky-user-id"),
                req.headers().contains_key("x-sparky-username"),
                req.headers().contains_key("x-sparky-home-dir"),
            );
            return Ok(response);
        }
    };

    let request_path = build_dev_request_path(&project_id, &candidate_id, &tail);
    let upstream_url = match state.runtime.dev_server_upstream_url(
        &user.user_id,
        &project_id,
        &candidate_id,
        request_path.as_str(),
        req.uri().query(),
    ) {
        Ok(url) => url,
        Err(error) => {
            return Ok(HttpResponse::BadRequest().json(serde_json::json!({
                "error": error
            })));
        }
    };
    log::info!(
        "executor dev proxy request /internal/dev/{}/{}/proxy/{} -> {}",
        project_id,
        candidate_id,
        tail,
        upstream_url
    );

    if is_websocket_request(&req) {
        let origin_override = upstream_http_origin(&upstream_url);
        return proxy_http_websocket(req, payload, upstream_url, origin_override).await;
    }

    proxy_http(req, payload, upstream_url).await
}

fn session_summary_from_runtime(session: &sparky::session::Session) -> SessionSummary {
    SessionSummary {
        session_id: session.id.clone(),
        project_id: session.project_id.clone(),
        username: session.username.clone(),
        created_at_ms: session.created_at_ms,
        alive: session.is_alive(),
        temporary: session.temporary,
        codex_session_id: session.codex_session_id.clone(),
    }
}

fn proxy_auth_session(req: &HttpRequest) -> Result<AuthSession, HttpResponse> {
    let user_id = required_header(req, "x-sparky-user-id")?;
    let username = required_header(req, "x-sparky-username")?;
    let home_dir = required_header(req, "x-sparky-home-dir")?;

    Ok(AuthSession {
        token: "__executor_proxy__".to_string(),
        user_id,
        username,
        home_dir: PathBuf::from(home_dir),
    })
}

fn required_header(req: &HttpRequest, name: &str) -> Result<String, HttpResponse> {
    req.headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            HttpResponse::BadRequest().json(serde_json::json!({
                "error": format!("missing header {}", name)
            }))
        })
}

fn is_websocket_request(req: &HttpRequest) -> bool {
    req.headers()
        .get(actix_web::http::header::UPGRADE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
}

fn should_skip_request_header(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if lower.starts_with("sec-websocket-") || lower.starts_with("x-sparky-") {
        return true;
    }

    matches!(
        lower.as_str(),
        "connection"
            | "host"
            | "content-length"
            | "transfer-encoding"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "upgrade"
            | "te"
            | "trailer"
    )
}

fn should_skip_response_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "connection"
            | "content-length"
            | "transfer-encoding"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
    )
}

fn copy_forward_headers(
    headers: &actix_web::http::header::HeaderMap,
    mut request: awc::ClientRequest,
) -> awc::ClientRequest {
    for (name, value) in headers {
        if should_skip_request_header(name.as_str()) {
            continue;
        }
        request = request.append_header((name.clone(), value.clone()));
    }
    request
}

fn copy_response_headers(
    headers: &actix_web::http::header::HeaderMap,
    response: &mut actix_web::HttpResponseBuilder,
) {
    for (name, value) in headers {
        if should_skip_response_header(name.as_str()) {
            continue;
        }
        response.append_header((name.clone(), value.clone()));
    }
}

async fn proxy_http(
    req: HttpRequest,
    mut payload: web::Payload,
    upstream_url: String,
) -> Result<HttpResponse, Error> {
    let client = Client::default();
    let mut body = BytesMut::new();
    while let Some(chunk) = payload.next().await {
        let chunk = chunk.map_err(actix_web::error::ErrorBadRequest)?;
        body.extend_from_slice(&chunk);
    }

    let forward = copy_forward_headers(
        req.headers(),
        client
            .request(req.method().clone(), upstream_url.clone())
            .force_close()
            .no_decompress()
            .timeout(PROXY_HTTP_TIMEOUT),
    );

    let mut upstream = forward.send_body(body.freeze()).await.map_err(|error| {
        log::warn!(
            "executor dev proxy upstream request failed method={} path={} upstream={}: {}",
            req.method(),
            req.uri(),
            upstream_url,
            error
        );
        actix_web::error::ErrorBadGateway(error)
    })?;

    let status = upstream.status();
    let response_headers = upstream.headers().clone();
    let content_type = upstream
        .headers()
        .get(actix_web::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let request_uri = req.uri().to_string();
    let body = upstream
        .body()
        .limit(64 * 1024 * 1024)
        .await
        .map_err(|error| {
            log::warn!(
                "executor dev proxy upstream body read failed method={} path={} upstream={} status={}: {}",
                req.method(),
                req.uri(),
                upstream_url,
                status.as_u16(),
                error
            );
            actix_web::error::ErrorBadGateway(error)
        })?;

    if request_uri.contains("/proxy/api/") || !status.is_success() {
        log::info!(
            "executor dev proxy response method={} path={} upstream={} status={} content_type={}",
            req.method(),
            request_uri,
            upstream_url,
            status.as_u16(),
            if content_type.is_empty() {
                "-"
            } else {
                content_type.as_str()
            }
        );
    }

    let mut response = HttpResponse::build(status);
    copy_response_headers(&response_headers, &mut response);
    Ok(response.body(body))
}

async fn proxy_http_websocket(
    req: HttpRequest,
    payload: web::Payload,
    upstream_url: String,
    origin_override: Option<String>,
) -> Result<HttpResponse, Error> {
    let upstream_ws_url = if let Some(rest) = upstream_url.strip_prefix("http://") {
        format!("ws://{}", rest)
    } else if let Some(rest) = upstream_url.strip_prefix("https://") {
        format!("wss://{}", rest)
    } else {
        upstream_url
    };

    let mut builder = Client::default()
        .ws(upstream_ws_url.clone())
        .max_frame_size(PROXY_WS_MAX_FRAME_SIZE);
    if let Some(protocol) = req
        .headers()
        .get("sec-websocket-protocol")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        builder = builder.protocols([protocol]);
    }
    if let Some(origin) = origin_override.as_deref() {
        if let Some(authority) = origin_authority(origin) {
            builder = builder.set_header(actix_web::http::header::HOST, authority);
        }
        builder = builder.set_header(actix_web::http::header::ORIGIN, origin);
    } else if let Some(host) = req.headers().get(actix_web::http::header::HOST) {
        builder = builder.set_header(actix_web::http::header::HOST, host.clone());
    }
    for (name, value) in req.headers() {
        if should_skip_request_header(name.as_str()) {
            continue;
        }
        if origin_override.is_some() && name == actix_web::http::header::ORIGIN {
            continue;
        }
        builder = builder.set_header(name.clone(), value.clone());
    }

    let (upstream_response, mut upstream) = builder.connect().await.map_err(|error| {
        log::warn!(
            "proxy websocket connect failed for {} protocol={} origin_override={}: {}",
            upstream_ws_url,
            req.headers()
                .get("sec-websocket-protocol")
                .and_then(|value| value.to_str().ok())
                .unwrap_or("-"),
            origin_override.as_deref().unwrap_or("-"),
            error
        );
        actix_web::error::ErrorBadGateway(error)
    })?;
    let selected_protocol = upstream_response
        .headers()
        .get(actix_web::http::header::SEC_WEBSOCKET_PROTOCOL)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let (response, mut client_ws, client_stream) =
        if let Some(protocol) = selected_protocol.as_deref() {
            actix_ws::handle_with_protocols(&req, payload, &[protocol])?
        } else {
            actix_ws::handle(&req, payload)?
        };
    let request_path = req.uri().path().to_string();
    let mut client_stream = client_stream.max_frame_size(PROXY_WS_MAX_FRAME_SIZE);

    actix_web::rt::spawn(async move {
        loop {
            tokio::select! {
                message = client_stream.next() => {
                    match message {
                        Some(Ok(Message::Text(text))) => {
                            if upstream.send(awc::ws::Message::Text(text.to_string().into())).await.is_err() {
                                break;
                            }
                        }
                        Some(Ok(Message::Binary(bytes))) => {
                            if upstream.send(awc::ws::Message::Binary(bytes)).await.is_err() {
                                break;
                            }
                        }
                        Some(Ok(Message::Continuation(item))) => {
                            if upstream.send(awc::ws::Message::Continuation(item)).await.is_err() {
                                break;
                            }
                        }
                        Some(Ok(Message::Ping(bytes))) => {
                            if upstream.send(awc::ws::Message::Ping(bytes)).await.is_err() {
                                break;
                            }
                        }
                        Some(Ok(Message::Pong(bytes))) => {
                            if upstream.send(awc::ws::Message::Pong(bytes)).await.is_err() {
                                break;
                            }
                        }
                        Some(Ok(Message::Close(reason))) => {
                            log::info!("proxy websocket client sent close for {}", request_path);
                            let _ = upstream.send(awc::ws::Message::Close(reason)).await;
                            break;
                        }
                        None => {
                            log::info!("proxy websocket client closed for {}", request_path);
                            let _ = upstream.close().await;
                            break;
                        }
                        Some(Err(error)) => {
                            log::warn!("proxy websocket client stream error for {}: {}", request_path, error);
                            let _ = upstream.close().await;
                            break;
                        }
                        _ => {}
                    }
                }

                message = upstream.next() => {
                    match message {
                        Some(Ok(awc::ws::Frame::Text(text))) => {
                            if client_ws.text(bytes_to_string(text)).await.is_err() {
                                break;
                            }
                        }
                        Some(Ok(awc::ws::Frame::Binary(bytes))) => {
                            if client_ws.binary(bytes).await.is_err() {
                                break;
                            }
                        }
                        Some(Ok(awc::ws::Frame::Continuation(item))) => {
                            if client_ws.continuation(item).await.is_err() {
                                break;
                            }
                        }
                        Some(Ok(awc::ws::Frame::Ping(bytes))) => {
                            if client_ws.ping(&bytes).await.is_err() {
                                break;
                            }
                        }
                        Some(Ok(awc::ws::Frame::Pong(bytes))) => {
                            if client_ws.pong(&bytes).await.is_err() {
                                break;
                            }
                        }
                        Some(Ok(awc::ws::Frame::Close(reason))) => {
                            log::info!("proxy websocket upstream sent close for {}", request_path);
                            let _ = client_ws.close(reason).await;
                            break;
                        }
                        None => {
                            log::info!("proxy websocket upstream closed for {}", request_path);
                            let _ = client_ws.close(None).await;
                            break;
                        }
                        Some(Err(error)) => {
                            log::warn!("proxy websocket upstream stream error for {}: {}", request_path, error);
                            let _ = client_ws.close(None).await;
                            break;
                        }
                    }
                }
            }
        }
    });

    Ok(response)
}

fn upstream_http_origin(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let authority = rest.split('/').next()?;
    if authority.is_empty() {
        return None;
    }
    Some(format!("{}://{}", scheme, authority))
}

fn raw_proxy_tail(request_path: &str, prefix: &str) -> String {
    if request_path == prefix {
        return String::new();
    }

    request_path
        .strip_prefix(&(prefix.to_string() + "/"))
        .unwrap_or_default()
        .to_string()
}

fn origin_authority(origin: &str) -> Option<&str> {
    let (_, rest) = origin.split_once("://")?;
    if rest.is_empty() {
        return None;
    }
    Some(rest)
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    env_logger::init_from_env(env_logger::Env::default().default_filter_or("info"));

    let cfg = ServerConfig::new();
    let port = std::env::var("EXECUTOR_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(cfg.port.saturating_add(1));

    std::fs::create_dir_all(&cfg.sandbox_root).ok();
    std::fs::create_dir_all(cfg.sandbox_root.join("sessions")).ok();

    let state = web::Data::new(ExecutorAppState {
        runtime: Arc::new(ExecutorRuntime::new(cfg.clone())),
        config: cfg.clone(),
    });

    log::info!("Sparky executor");
    log::info!("  listening on  0.0.0.0:{}", port);
    log::info!("  sandbox root  {}", cfg.sandbox_root.display());

    HttpServer::new(move || {
        App::new()
            .app_data(state.clone())
            .service(health)
            .service(list_sessions)
            .service(get_session)
            .service(get_session_snapshot)
            .service(create_session)
            .service(destroy_session)
            .service(open_editor)
            .service(list_web_targets)
            .service(open_web_target)
            .service(restart_web_target)
            .service(file_tree)
            .service(git_status)
            .service(git_action)
            .route(
                "/internal/sessions/{id}/attach",
                web::get().to(attach_session_ws),
            )
            .route(
                "/internal/editors/{project_id}/proxy",
                web::to(editor_proxy_root),
            )
            .route(
                "/internal/editors/{project_id}/proxy/{tail:.*}",
                web::to(editor_proxy_tail),
            )
            .route(
                "/internal/dev/{project_id}/{candidate_id}/proxy",
                web::to(dev_proxy_root),
            )
            .route(
                "/internal/dev/{project_id}/{candidate_id}/proxy/{tail:.*}",
                web::to(dev_proxy_tail),
            )
    })
    .bind(("0.0.0.0", port))?
    .run()
    .await
}
