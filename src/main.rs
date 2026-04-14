//! Sparky: Bwrap Sandbox Web Gateway
//!
//! API:
//!   GET  /projects              - list all projects
//!   DELETE /projects/:id       - remove a custom project
//!   POST /projects/:id/session - create a sandbox session
//!   GET  /session/:id/ws      - WebSocket to session PTY
//!   DELETE /session/:id        - destroy session
//!   GET  /health               - health check

mod auth;
mod codex;
mod config;
mod dev_server;
mod editor;
mod executor;
mod executor_client;
mod git;
mod internal_api;
mod project;
mod sandbox;
pub mod session;

use actix_files::NamedFile;
use actix_web::cookie::{Cookie, SameSite};
use actix_web::{delete, get, patch, post, web, App, Error, HttpRequest, HttpResponse, HttpServer};
use actix_ws::Message;
use auth::{AuthError, AuthUser, UserStore};
use awc::Client;
use bytes::BytesMut;
use codex::{CodexLiveSessionSummary, CodexSessionSummary, CodexSessionsResponse};
use config::ServerConfig;
use dev_server::{
    build_dev_request_path, bytes_to_string, document_base_for_proxy, rewrite_html_for_proxy,
};
use editor::{build_editor_url, list_directory, resolve_requested_path};
use executor::{ExecutorControl, ExecutorRuntime, SessionAccessError};
use executor_client::{RemoteExecutorClient, RemoteExecutorError};
use futures_util::{SinkExt, StreamExt};
use git::{
    execute_git_action, has_git_repository, load_git_status, resolve_runtime_worktree, GitAction,
    GitRuntimeContext,
};
use once_cell::sync::{Lazy, OnceCell};
use project::{Project, ProjectStore};
use serde::Deserialize;
use session::{LaunchOverride, SessionSummary};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

// ── Global State ────────────────────────────────────────────────────────────────

static PROJECTS: Lazy<Arc<ProjectStore>> = Lazy::new(|| {
    Arc::new(ProjectStore::new(
        config::config_path(),
        config::custom_projects_root(),
    ))
});
static SERVER_CONFIG: Lazy<ServerConfig> = Lazy::new(ServerConfig::new);
static EXECUTOR: Lazy<Arc<dyn ExecutorControl>> =
    Lazy::new(|| Arc::new(ExecutorRuntime::new(SERVER_CONFIG.clone())));
static EXECUTOR_REMOTE: Lazy<Option<Arc<RemoteExecutorClient>>> = Lazy::new(|| {
    SERVER_CONFIG
        .executor_base_url
        .clone()
        .map(RemoteExecutorClient::new)
        .map(Arc::new)
});
static USER_STORE: OnceCell<Arc<UserStore>> = OnceCell::new();
const PROXY_WS_MAX_FRAME_SIZE: usize = 16 * 1024 * 1024;

#[derive(Deserialize)]
struct CredentialsRequest {
    username: String,
    password: String,
}

#[derive(Deserialize)]
struct CreateProjectRequest {
    name: String,
    path: String,
    git_url: Option<String>,
    runtime: Option<String>,
}

#[derive(Deserialize)]
struct UpdateProjectRequest {
    name: String,
    path: String,
    git_url: Option<String>,
    runtime: Option<String>,
}

#[derive(Debug)]
struct PendingRepositoryClone {
    project_id: String,
    project_path: PathBuf,
    git_url: String,
}

#[derive(Deserialize)]
struct GitActionRequest {
    action: String,
    message: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct CreateSessionRequest {
    temporary: Option<bool>,
    fresh: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
struct ResumeCodexSessionRequest {
    session_id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct OpenWebDebugRequest {
    candidate_id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct RestartWebDebugRequest {
    candidate_id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct DestroySessionQuery {
    allow_persistent: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
struct FileTreeQuery {
    path: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct OpenEditorRequest {
    path: Option<String>,
}

fn unauthorized() -> HttpResponse {
    HttpResponse::Unauthorized().json(serde_json::json!({
        "error": "unauthorized"
    }))
}

fn build_auth_cookie(name: &str, token: &str, path: &str, secure: bool) -> Cookie<'static> {
    Cookie::build(name.to_string(), token.to_string())
        .http_only(true)
        .same_site(SameSite::Lax)
        .path(path.to_string())
        .secure(secure)
        .finish()
}

fn build_removal_cookie(name: &str, path: &str, secure: bool) -> Cookie<'static> {
    let mut cookie = Cookie::build(name.to_string(), String::new())
        .http_only(true)
        .same_site(SameSite::Lax)
        .path(path.to_string())
        .secure(secure)
        .finish();
    cookie.make_removal();
    cookie
}

fn remote_executor_error_response(error: RemoteExecutorError) -> HttpResponse {
    let status = actix_web::http::StatusCode::from_u16(error.status)
        .unwrap_or(actix_web::http::StatusCode::BAD_GATEWAY);
    HttpResponse::build(status).json(serde_json::json!({
        "error": error.message
    }))
}

fn project_payload(project: &Project) -> serde_json::Value {
    serde_json::json!({
        "project_id": project.project_id,
        "name": project.display_name,
        "provider": project.provider,
        "summary": project.summary,
        "accent": project.accent,
        "tagline": project.tagline,
        "git_url": project.git_url,
        "root_fs": project.root_fs,
        "bind_dirs": project.bind_dirs,
        "cmd": project.cmd,
        "deletable": !PROJECTS.is_builtin(&project.project_id),
    })
}

fn is_codex_project(project: &Project) -> bool {
    project
        .accent
        .as_deref()
        .map(|value| value.eq_ignore_ascii_case("codex"))
        .unwrap_or(false)
        || project
            .provider
            .as_deref()
            .map(|value| value.eq_ignore_ascii_case("openai"))
            .unwrap_or(false)
        || project.cmd.eq_ignore_ascii_case("codex")
        || project.cmd_args.iter().any(|arg| arg.contains("codex"))
}

fn build_live_codex_session_summary(
    session: &SessionSummary,
    cwd: &str,
) -> CodexLiveSessionSummary {
    CodexLiveSessionSummary {
        session_id: session.session_id.clone(),
        codex_session_id: session.codex_session_id.clone(),
        cwd: cwd.to_string(),
        created_at_ms: session.created_at_ms,
        updated_at_ms: session.created_at_ms,
    }
}

fn collect_live_codex_sessions(
    sessions: Vec<SessionSummary>,
    project: &Project,
    cwd: &str,
) -> Vec<CodexLiveSessionSummary> {
    let live_sessions = sessions
        .into_iter()
        .filter(|session| session.project_id == project.project_id)
        .filter(|session| session.alive && !session.temporary)
        .map(|session| build_live_codex_session_summary(&session, cwd))
        .collect::<Vec<_>>();

    let original_count = live_sessions.len();
    let mut deduped = HashMap::with_capacity(original_count);
    for session in live_sessions {
        deduped
            .entry(session.session_id.clone())
            .and_modify(|current: &mut CodexLiveSessionSummary| {
                if (session.updated_at_ms, session.created_at_ms)
                    > (current.updated_at_ms, current.created_at_ms)
                {
                    *current = session.clone();
                }
            })
            .or_insert(session);
    }

    if deduped.len() != original_count {
        log::warn!(
            "Deduplicated live Codex sessions for project {}: {} -> {}",
            project.project_id,
            original_count,
            deduped.len()
        );
    }

    let mut live_sessions = deduped.into_values().collect::<Vec<_>>();

    live_sessions.sort_by(|left, right| {
        right
            .updated_at_ms
            .cmp(&left.updated_at_ms)
            .then_with(|| left.session_id.cmp(&right.session_id))
    });
    live_sessions
}

async fn current_live_codex_sessions(
    user: &auth::AuthSession,
    project: &Project,
) -> Result<Vec<CodexLiveSessionSummary>, String> {
    let cwd = project_runtime_root(project)?.display().to_string();
    if let Some(remote) = EXECUTOR_REMOTE.as_ref() {
        let sessions = remote
            .list_sessions_for_user(&user.user_id)
            .await
            .map_err(|error| format!("list remote executor sessions: {}", error.message))?;
        return Ok(collect_live_codex_sessions(sessions, project, &cwd));
    }

    Ok(collect_live_codex_sessions(
        EXECUTOR.list_sessions_for_user(&user.user_id),
        project,
        &cwd,
    ))
}

async fn sync_live_codex_session(
    user_id: &str,
    project_id: &str,
    session: &CodexLiveSessionSummary,
) -> Result<(), String> {
    let Some(pool) = USER_STORE.get().and_then(|store| store.postgres_pool()) else {
        return Ok(());
    };

    codex::upsert_live_session(&pool, user_id, project_id, session).await
}

async fn clear_live_codex_sessions(user_id: &str, project_id: &str) -> Result<(), String> {
    let Some(pool) = USER_STORE.get().and_then(|store| store.postgres_pool()) else {
        return Ok(());
    };

    codex::clear_live_sessions_for_project(&pool, user_id, project_id).await
}

async fn remove_live_codex_session(
    user_id: &str,
    project_id: &str,
    session_id: &str,
) -> Result<(), String> {
    let Some(pool) = USER_STORE.get().and_then(|store| store.postgres_pool()) else {
        return Ok(());
    };

    codex::remove_live_session(&pool, user_id, project_id, session_id).await
}

fn bearer_token_with_source(req: &HttpRequest) -> Option<(String, &'static str)> {
    if let Some(header) = req.headers().get("Authorization") {
        if let Ok(value) = header.to_str() {
            if let Some(token) = value.strip_prefix("Bearer ") {
                let trimmed = token.trim();
                if !trimmed.is_empty() {
                    return Some((trimmed.to_string(), "authorization"));
                }
            }
        }
    }

    if let Some(cookie) = req.cookie("sparky_auth_token") {
        let value = cookie.value().trim();
        if !value.is_empty() {
            return Some((value.to_string(), "sparky_auth_token"));
        }
    }

    if let Some(cookie) = req.cookie("sparky_dev_token") {
        let value = cookie.value().trim();
        if !value.is_empty() {
            return Some((value.to_string(), "sparky_dev_token"));
        }
    }

    if let Some(cookie) = req.cookie("sparky_editor_token") {
        let value = cookie.value().trim();
        if !value.is_empty() {
            return Some((value.to_string(), "sparky_editor_token"));
        }
    }

    req.query_string().split('&').find_map(|pair| {
        let mut parts = pair.splitn(2, '=');
        match (parts.next(), parts.next()) {
            (Some("token"), Some(token)) if !token.is_empty() => {
                Some((token.to_string(), "query_token"))
            }
            _ => None,
        }
    })
}

fn bearer_token(req: &HttpRequest) -> Option<String> {
    bearer_token_with_source(req).map(|(token, _)| token)
}

async fn current_user(req: &HttpRequest) -> Option<auth::AuthSession> {
    let token = bearer_token(req)?;
    let store = USER_STORE.get()?;
    store.get(&token).await
}

fn cookie_token(req: &HttpRequest, name: &'static str) -> Option<(String, &'static str)> {
    let cookie = req.cookie(name)?;
    let value = cookie.value().trim();
    if value.is_empty() {
        None
    } else {
        Some((value.to_string(), name))
    }
}

fn proxy_session_token_with_source(req: &HttpRequest) -> Option<(String, &'static str)> {
    let path = req.path();

    if path.starts_with("/dev/") {
        return cookie_token(req, "sparky_dev_token")
            .or_else(|| cookie_token(req, "sparky_auth_token"))
            .or_else(|| cookie_token(req, "sparky_editor_token"));
    }

    if path.starts_with("/editor/") {
        return cookie_token(req, "sparky_editor_token")
            .or_else(|| cookie_token(req, "sparky_auth_token"))
            .or_else(|| cookie_token(req, "sparky_dev_token"));
    }

    cookie_token(req, "sparky_auth_token")
        .or_else(|| cookie_token(req, "sparky_dev_token"))
        .or_else(|| cookie_token(req, "sparky_editor_token"))
}

fn proxy_session_token(req: &HttpRequest) -> Option<String> {
    proxy_session_token_with_source(req).map(|(token, _)| token)
}

async fn current_proxy_user(req: &HttpRequest) -> Option<auth::AuthSession> {
    let token = proxy_session_token(req)?;
    let store = USER_STORE.get()?;
    store.get(&token).await
}

fn auth_error_response(error: AuthError) -> HttpResponse {
    let status = match &error {
        AuthError::BadRequest(_) => actix_web::http::StatusCode::BAD_REQUEST,
        AuthError::Unauthorized(_) => actix_web::http::StatusCode::UNAUTHORIZED,
        AuthError::Conflict(_) => actix_web::http::StatusCode::CONFLICT,
        AuthError::Internal(_) => actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
    };

    HttpResponse::build(status).json(serde_json::json!({
        "error": error.message()
    }))
}

#[post("/auth/register")]
async fn register(req: HttpRequest, payload: web::Json<CredentialsRequest>) -> HttpResponse {
    let Some(store) = USER_STORE.get() else {
        return HttpResponse::InternalServerError().json(serde_json::json!({
            "error": "auth store not initialized"
        }));
    };

    match store.register(&payload.username, &payload.password).await {
        Ok(session) => {
            let secure = req.connection_info().scheme() == "https";
            HttpResponse::Ok()
                .cookie(build_auth_cookie(
                    "sparky_auth_token",
                    &session.token,
                    "/",
                    secure,
                ))
                .json(serde_json::json!({
                    "token": session.token,
                    "user": AuthUser {
                        user_id: session.user_id.clone(),
                        username: session.username.clone(),
                    }
                }))
        }
        Err(error) => auth_error_response(error),
    }
}

#[post("/auth/login")]
async fn login(req: HttpRequest, payload: web::Json<CredentialsRequest>) -> HttpResponse {
    let Some(store) = USER_STORE.get() else {
        return HttpResponse::InternalServerError().json(serde_json::json!({
            "error": "auth store not initialized"
        }));
    };

    match store.login(&payload.username, &payload.password).await {
        Ok(session) => {
            let secure = req.connection_info().scheme() == "https";
            HttpResponse::Ok()
                .cookie(build_auth_cookie(
                    "sparky_auth_token",
                    &session.token,
                    "/",
                    secure,
                ))
                .json(serde_json::json!({
                    "token": session.token,
                    "user": AuthUser {
                        user_id: session.user_id.clone(),
                        username: session.username.clone(),
                    }
                }))
        }
        Err(error) => auth_error_response(error),
    }
}

#[get("/auth/me")]
async fn auth_me(req: HttpRequest) -> HttpResponse {
    match current_user(&req).await {
        Some(session) => {
            let secure = req.connection_info().scheme() == "https";
            HttpResponse::Ok()
                .cookie(build_auth_cookie(
                    "sparky_auth_token",
                    &session.token,
                    "/",
                    secure,
                ))
                .json(serde_json::json!({
                    "user": AuthUser {
                        user_id: session.user_id.clone(),
                        username: session.username.clone(),
                    }
                }))
        }
        None => unauthorized(),
    }
}

#[post("/auth/logout")]
async fn auth_logout(req: HttpRequest) -> HttpResponse {
    let token = match bearer_token(&req) {
        Some(token) => token,
        None => return unauthorized(),
    };

    let Some(store) = USER_STORE.get() else {
        return HttpResponse::InternalServerError().json(serde_json::json!({
            "error": "auth store not initialized"
        }));
    };

    let secure = req.connection_info().scheme() == "https";
    match store.logout(&token).await {
        Ok(true) => HttpResponse::Ok()
            .cookie(build_removal_cookie("sparky_auth_token", "/", secure))
            .cookie(build_removal_cookie("sparky_dev_token", "/dev", secure))
            .cookie(build_removal_cookie(
                "sparky_editor_token",
                "/editor",
                secure,
            ))
            .json(serde_json::json!({
                "status": "logged_out"
            })),
        Ok(false) => unauthorized(),
        Err(error) => HttpResponse::InternalServerError().json(serde_json::json!({
            "error": error
        })),
    }
}

// ── Health ────────────────────────────────────────────────────────────────────

#[get("/health")]
async fn health() -> HttpResponse {
    HttpResponse::Ok().json(serde_json::json!({
        "status": "ok",
        "sessions": EXECUTOR.session_count(),
        "projects": PROJECTS.len(),
    }))
}

// ── Static Files ───────────────────────────────────────────────────────────────

async fn serve_index(req: HttpRequest) -> actix_web::Result<HttpResponse> {
    let path = SERVER_CONFIG.web_dist_dir.join("index.html");
    if !path.exists() {
        return Ok(HttpResponse::ServiceUnavailable()
            .content_type("text/plain; charset=utf-8")
            .body("Sparky API server is running. Open the dedicated web service for the UI."));
    }

    Ok(NamedFile::open(path)?.into_response(&req))
}

async fn serve_assets(path: web::Path<String>) -> actix_web::Result<NamedFile> {
    let path = SERVER_CONFIG
        .web_dist_dir
        .join("assets")
        .join(path.into_inner());
    if !path.exists() {
        return Err(actix_web::error::ErrorNotFound("not found"));
    }
    Ok(NamedFile::open(path)?)
}

async fn serve_seti_assets(path: web::Path<String>) -> actix_web::Result<NamedFile> {
    let relative = path.into_inner();
    if relative.contains("..") || relative.contains('\\') {
        return Err(actix_web::error::ErrorNotFound("not found"));
    }

    let path = SERVER_CONFIG.web_dist_dir.join("seti").join(relative);
    if !path.exists() {
        return Err(actix_web::error::ErrorNotFound("not found"));
    }
    Ok(NamedFile::open(path)?)
}

async fn serve_root_static(path: web::Path<String>) -> actix_web::Result<NamedFile> {
    let filename = path.into_inner();
    if filename.contains('/') || filename.contains('\\') {
        return Err(actix_web::error::ErrorNotFound("not found"));
    }
    let path = SERVER_CONFIG.web_dist_dir.join(filename);
    if !path.exists() {
        return Err(actix_web::error::ErrorNotFound("not found"));
    }
    Ok(NamedFile::open(path)?)
}

// ── Projects ──────────────────────────────────────────────────────────────────

#[get("/projects")]
async fn list_projects(req: HttpRequest) -> HttpResponse {
    let user = match current_user(&req).await {
        Some(user) => user,
        None => return unauthorized(),
    };

    HttpResponse::Ok().json(serde_json::json!({
        "projects": PROJECTS.list_for_user(&user.user_id).iter().map(project_payload).collect::<Vec<_>>()
    }))
}

#[post("/projects")]
async fn create_project(
    req: HttpRequest,
    payload: web::Json<CreateProjectRequest>,
) -> HttpResponse {
    let user = match current_user(&req).await {
        Some(user) => user,
        None => return unauthorized(),
    };

    let request = payload.into_inner();

    let result =
        tokio::task::spawn_blocking(move || create_project_inner(&user.user_id, request)).await;

    let (project, pending_clone) = match result {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => {
            return HttpResponse::BadRequest().json(serde_json::json!({
                "error": error
            }))
        }
        Err(error) => {
            return HttpResponse::InternalServerError().json(serde_json::json!({
                "error": format!("create project task failed: {}", error)
            }))
        }
    };

    spawn_repository_clone(pending_clone);

    HttpResponse::Ok().json(serde_json::json!({
        "project": project_payload(&project)
    }))
}

#[delete("/projects/{id}")]
async fn delete_project(req: HttpRequest, path: web::Path<String>) -> HttpResponse {
    let user = match current_user(&req).await {
        Some(user) => user,
        None => return unauthorized(),
    };

    let project_id = path.into_inner();
    let user_id = user.user_id.clone();
    let project_id_for_task = project_id.clone();
    let task = tokio::task::spawn_blocking(move || {
        let project = PROJECTS.remove_custom_project(&user_id, &project_id_for_task)?;
        let removed_sessions = EXECUTOR.remove_project_runtime(&user_id, &project_id_for_task);
        Ok::<_, String>((project, removed_sessions))
    })
    .await;

    match task {
        Ok(Ok((project, removed_sessions))) => {
            if let Err(error) = clear_live_codex_sessions(&user.user_id, &project_id).await {
                return HttpResponse::InternalServerError().json(serde_json::json!({
                    "error": error
                }));
            }

            HttpResponse::Ok().json(serde_json::json!({
                "project": project_payload(&project),
                "removed_sessions": removed_sessions,
            }))
        }
        Ok(Err(error)) if error == "project not found" => {
            HttpResponse::NotFound().json(serde_json::json!({
                "error": error
            }))
        }
        Ok(Err(error)) if error == "builtin projects cannot be removed" => {
            HttpResponse::BadRequest().json(serde_json::json!({
                "error": error
            }))
        }
        Ok(Err(error)) => HttpResponse::BadRequest().json(serde_json::json!({
            "error": error
        })),
        Err(error) => HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("delete project task failed: {}", error)
        })),
    }
}

#[patch("/projects/{id}")]
async fn update_project(
    req: HttpRequest,
    path: web::Path<String>,
    payload: web::Json<UpdateProjectRequest>,
) -> HttpResponse {
    let user = match current_user(&req).await {
        Some(user) => user,
        None => return unauthorized(),
    };

    let project_id = path.into_inner();
    let request = payload.into_inner();
    let user_id = user.user_id.clone();
    let user_id_for_task = user_id.clone();
    let project_id_for_task = project_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        let (project, pending_clone) =
            update_project_inner(&user_id_for_task, &project_id_for_task, request)?;
        let removed_sessions =
            EXECUTOR.remove_project_runtime(&user_id_for_task, &project_id_for_task);
        Ok::<_, String>((project, pending_clone, removed_sessions))
    })
    .await;

    match result {
        Ok(Ok((project, pending_clone, removed_sessions))) => {
            spawn_repository_clone(pending_clone);

            if let Err(error) = clear_live_codex_sessions(&user_id, &project_id).await {
                return HttpResponse::InternalServerError().json(serde_json::json!({
                    "error": error
                }));
            }

            HttpResponse::Ok().json(serde_json::json!({
                "project": project_payload(&project),
                "removed_sessions": removed_sessions,
            }))
        }
        Ok(Err(error)) if error == "project not found" => {
            HttpResponse::NotFound().json(serde_json::json!({
                "error": error
            }))
        }
        Ok(Err(error)) if error == "builtin projects cannot be edited" => {
            HttpResponse::BadRequest().json(serde_json::json!({
                "error": error
            }))
        }
        Ok(Err(error)) => HttpResponse::BadRequest().json(serde_json::json!({
            "error": error
        })),
        Err(error) => HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("update project task failed: {}", error)
        })),
    }
}

#[get("/projects/{id}/git/status")]
async fn project_git_status(req: HttpRequest, path: web::Path<String>) -> HttpResponse {
    let user = match current_user(&req).await {
        Some(user) => user,
        None => return unauthorized(),
    };

    let project_id = path.into_inner();
    let Some(project) = PROJECTS.find_for_user(&user.user_id, &project_id) else {
        return HttpResponse::NotFound().json(serde_json::json!({
            "error": "project not found"
        }));
    };

    let project_root = match project_worktree_path(&project) {
        Ok(path) => path,
        Err(error) => {
            return HttpResponse::BadRequest().json(serde_json::json!({
                "error": error
            }))
        }
    };

    if let Some(remote) = EXECUTOR_REMOTE.as_ref() {
        return match remote.git_status(&user, &project_root).await {
            Ok(status) => HttpResponse::Ok().json(serde_json::json!({ "status": status })),
            Err(error) => remote_executor_error_response(error),
        };
    }

    let git_runtime = GitRuntimeContext {
        home_dir: user.home_dir.clone(),
        ssh_auth_sock: SERVER_CONFIG.ssh_auth_sock.clone(),
    };

    match tokio::task::spawn_blocking(move || load_git_status(&project_root, &git_runtime)).await {
        Ok(Ok(status)) => HttpResponse::Ok().json(serde_json::json!({ "status": status })),
        Ok(Err(error)) => HttpResponse::BadRequest().json(serde_json::json!({
            "error": error
        })),
        Err(error) => HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("git status task failed: {}", error)
        })),
    }
}

#[post("/projects/{id}/git/action")]
async fn project_git_action(
    req: HttpRequest,
    path: web::Path<String>,
    payload: web::Json<GitActionRequest>,
) -> HttpResponse {
    let user = match current_user(&req).await {
        Some(user) => user,
        None => return unauthorized(),
    };

    let project_id = path.into_inner();
    let Some(project) = PROJECTS.find_for_user(&user.user_id, &project_id) else {
        return HttpResponse::NotFound().json(serde_json::json!({
            "error": "project not found"
        }));
    };

    let action = match parse_git_action(payload.into_inner(), &user.username) {
        Ok(action) => action,
        Err(error) => {
            return HttpResponse::BadRequest().json(serde_json::json!({
                "error": error
            }))
        }
    };

    let project_root = match project_worktree_path(&project) {
        Ok(path) => path,
        Err(error) => {
            return HttpResponse::BadRequest().json(serde_json::json!({
                "error": error
            }))
        }
    };

    if let Some(remote) = EXECUTOR_REMOTE.as_ref() {
        return match remote.git_action(&user, &project_root, action).await {
            Ok(result) => HttpResponse::Ok().json(serde_json::json!({
                "output": result.output,
                "status": result.status
            })),
            Err(error) => remote_executor_error_response(error),
        };
    }

    let git_runtime = GitRuntimeContext {
        home_dir: user.home_dir.clone(),
        ssh_auth_sock: SERVER_CONFIG.ssh_auth_sock.clone(),
    };

    match tokio::task::spawn_blocking(move || {
        execute_git_action(&project_root, &git_runtime, action)
    })
    .await
    {
        Ok(Ok(result)) => HttpResponse::Ok().json(serde_json::json!({
            "output": result.output,
            "status": result.status
        })),
        Ok(Err(error)) => HttpResponse::BadRequest().json(serde_json::json!({
            "error": error
        })),
        Err(error) => HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("git action task failed: {}", error)
        })),
    }
}

#[get("/projects/{id}/files/tree")]
async fn project_file_tree(
    req: HttpRequest,
    path: web::Path<String>,
    query: web::Query<FileTreeQuery>,
) -> HttpResponse {
    let user = match current_user(&req).await {
        Some(user) => user,
        None => return unauthorized(),
    };

    let project_id = path.into_inner();
    let Some(project) = PROJECTS.find_for_user(&user.user_id, &project_id) else {
        return HttpResponse::NotFound().json(serde_json::json!({
            "error": "project not found"
        }));
    };

    let requested_path = query.path.clone();
    let project_root = match project_worktree_path(&project) {
        Ok(path) => path,
        Err(error) => {
            return HttpResponse::BadRequest().json(serde_json::json!({
                "error": error
            }))
        }
    };

    if let Some(remote) = EXECUTOR_REMOTE.as_ref() {
        return match remote
            .list_file_tree(&project_root, requested_path.as_deref())
            .await
        {
            Ok(response) => HttpResponse::Ok().json(serde_json::json!({
                "tree": response.tree
            })),
            Err(error) => remote_executor_error_response(error),
        };
    }

    match tokio::task::spawn_blocking(move || {
        let root = resolve_runtime_worktree(&project_root)?;
        let source = if root == project_root {
            "project"
        } else {
            "git"
        };
        let listing = list_directory(&root, requested_path.as_deref(), source)?;
        Ok::<_, String>(listing)
    })
    .await
    {
        Ok(Ok(listing)) => HttpResponse::Ok().json(serde_json::json!({
            "tree": listing
        })),
        Ok(Err(error)) => HttpResponse::BadRequest().json(serde_json::json!({
            "error": error
        })),
        Err(error) => HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("load file tree task failed: {}", error)
        })),
    }
}

#[post("/projects/{id}/editor/open")]
async fn project_editor_open(
    req: HttpRequest,
    path: web::Path<String>,
    payload: Option<web::Json<OpenEditorRequest>>,
) -> HttpResponse {
    let token = match bearer_token(&req) {
        Some(token) => token,
        None => return unauthorized(),
    };

    let user = match current_user(&req).await {
        Some(user) => user,
        None => return unauthorized(),
    };

    let project_id = path.into_inner();
    let Some(project) = PROJECTS.find_for_user(&user.user_id, &project_id) else {
        return HttpResponse::NotFound().json(serde_json::json!({
            "error": "project not found"
        }));
    };

    let request = payload.map(web::Json::into_inner).unwrap_or_default();
    let root = match project_runtime_root(&project) {
        Ok(root) => root,
        Err(error) => {
            return HttpResponse::BadRequest().json(serde_json::json!({
                "error": error
            }))
        }
    };

    if let Some(remote) = EXECUTOR_REMOTE.as_ref() {
        return match remote
            .open_editor(&user, &project_id, &root, request.path.as_deref())
            .await
        {
            Ok(response) => {
                let secure = req.connection_info().scheme() == "https";
                let cookie = Cookie::build("sparky_editor_token", token)
                    .http_only(true)
                    .same_site(SameSite::Lax)
                    .path("/editor")
                    .secure(secure)
                    .finish();

                HttpResponse::Ok().cookie(cookie).json(serde_json::json!({
                    "status": response.status,
                    "url": response.url,
                }))
            }
            Err(error) => remote_executor_error_response(error),
        };
    }

    let user_for_task = user.clone();
    let project_id_for_task = project_id.clone();
    match tokio::task::spawn_blocking(move || {
        let file_path = if let Some(path) = request
            .path
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            Some(resolve_requested_path(&root, Some(path))?)
        } else {
            None
        };
        if let Some(file_path) = file_path.as_ref() {
            if !file_path.exists() {
                return Err("文件不存在".to_string());
            }
            if file_path.is_dir() {
                return Err("请选择文件而不是目录".to_string());
            }
        }
        let status = EXECUTOR.ensure_editor(&user_for_task, &project_id_for_task, &root)?;
        let url = build_editor_url(status.proxy_base.as_str(), &root, file_path.as_deref());
        Ok::<_, String>((status, url))
    })
    .await
    {
        Ok(Ok((status, url))) => {
            let secure = req.connection_info().scheme() == "https";
            let cookie = Cookie::build("sparky_editor_token", token)
                .http_only(true)
                .same_site(SameSite::Lax)
                .path("/editor")
                .secure(secure)
                .finish();

            HttpResponse::Ok().cookie(cookie).json(serde_json::json!({
                "status": status,
                "url": url,
            }))
        }
        Ok(Err(error)) => HttpResponse::BadRequest().json(serde_json::json!({
            "error": error
        })),
        Err(error) => HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("open editor task failed: {}", error)
        })),
    }
}

#[get("/projects/{id}/web/targets")]
async fn project_web_targets(req: HttpRequest, path: web::Path<String>) -> HttpResponse {
    let user = match current_user(&req).await {
        Some(user) => user,
        None => return unauthorized(),
    };

    let project_id = path.into_inner();
    let Some(project) = PROJECTS.find_for_user(&user.user_id, &project_id) else {
        return HttpResponse::NotFound().json(serde_json::json!({
            "error": "project not found"
        }));
    };

    let project_root = match project_runtime_root(&project) {
        Ok(path) => path,
        Err(error) => {
            return HttpResponse::BadRequest().json(serde_json::json!({
                "error": error
            }))
        }
    };

    if let Some(remote) = EXECUTOR_REMOTE.as_ref() {
        return match remote
            .list_web_targets(&user, &project_id, &project_root)
            .await
        {
            Ok(response) => HttpResponse::Ok().json(serde_json::json!({
                "targets": response.targets
            })),
            Err(error) => remote_executor_error_response(error),
        };
    }

    match tokio::task::spawn_blocking(move || {
        let candidates = EXECUTOR.discover_web_candidates(&project_root)?;
        let targets = EXECUTOR.list_web_statuses(&user.user_id, &project_id, candidates);
        Ok::<_, String>(targets)
    })
    .await
    {
        Ok(Ok(targets)) => HttpResponse::Ok().json(serde_json::json!({
            "targets": targets
        })),
        Ok(Err(error)) => HttpResponse::BadRequest().json(serde_json::json!({
            "error": error
        })),
        Err(error) => HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("discover web targets task failed: {}", error)
        })),
    }
}

#[post("/projects/{id}/web/open")]
async fn project_web_open(
    req: HttpRequest,
    path: web::Path<String>,
    payload: Option<web::Json<OpenWebDebugRequest>>,
) -> HttpResponse {
    let token = match bearer_token(&req) {
        Some(token) => token,
        None => return unauthorized(),
    };

    let user = match current_user(&req).await {
        Some(user) => user,
        None => return unauthorized(),
    };

    let project_id = path.into_inner();
    let Some(project) = PROJECTS.find_for_user(&user.user_id, &project_id) else {
        return HttpResponse::NotFound().json(serde_json::json!({
            "error": "project not found"
        }));
    };

    let request = payload.map(web::Json::into_inner).unwrap_or_default();
    let project_root = match project_runtime_root(&project) {
        Ok(path) => path,
        Err(error) => {
            return HttpResponse::BadRequest().json(serde_json::json!({
                "error": error
            }))
        }
    };

    if let Some(remote) = EXECUTOR_REMOTE.as_ref() {
        return match remote
            .open_web_target(
                &user,
                &project_id,
                &project_root,
                request.candidate_id.as_deref(),
            )
            .await
        {
            Ok(response) => {
                let secure = req.connection_info().scheme() == "https";
                let cookie = build_auth_cookie("sparky_dev_token", &token, "/dev", secure);

                HttpResponse::Ok().cookie(cookie).json(serde_json::json!({
                    "target": response.target,
                    "status": response.status,
                    "url": response.url,
                }))
            }
            Err(error) => remote_executor_error_response(error),
        };
    }

    let user_for_task = user.clone();
    let project_id_for_task = project_id.clone();
    match tokio::task::spawn_blocking(move || {
        let candidate =
            EXECUTOR.find_web_candidate(&project_root, request.candidate_id.as_deref())?;
        let server =
            EXECUTOR.ensure_dev_server(&user_for_task, &project_id_for_task, &candidate)?;
        Ok::<_, String>((candidate, server))
    })
    .await
    {
        Ok(Ok((candidate, server))) => {
            let secure = req.connection_info().scheme() == "https";
            let cookie = build_auth_cookie("sparky_dev_token", &token, "/dev", secure);

            HttpResponse::Ok().cookie(cookie).json(serde_json::json!({
                "target": candidate,
                "status": server,
                "url": server.url,
            }))
        }
        Ok(Err(error)) => HttpResponse::BadRequest().json(serde_json::json!({
            "error": error
        })),
        Err(error) => HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("open web debug task failed: {}", error)
        })),
    }
}

#[post("/projects/{id}/web/restart")]
async fn project_web_restart(
    req: HttpRequest,
    path: web::Path<String>,
    payload: Option<web::Json<RestartWebDebugRequest>>,
) -> HttpResponse {
    let token = match bearer_token(&req) {
        Some(token) => token,
        None => return unauthorized(),
    };

    let user = match current_user(&req).await {
        Some(user) => user,
        None => return unauthorized(),
    };

    let project_id = path.into_inner();
    let Some(project) = PROJECTS.find_for_user(&user.user_id, &project_id) else {
        return HttpResponse::NotFound().json(serde_json::json!({
            "error": "project not found"
        }));
    };

    let request = payload.map(web::Json::into_inner).unwrap_or_default();
    let project_root = match project_runtime_root(&project) {
        Ok(path) => path,
        Err(error) => {
            return HttpResponse::BadRequest().json(serde_json::json!({
                "error": error
            }))
        }
    };

    if let Some(remote) = EXECUTOR_REMOTE.as_ref() {
        return match remote
            .restart_web_target(
                &user,
                &project_id,
                &project_root,
                request.candidate_id.as_deref(),
            )
            .await
        {
            Ok(response) => {
                let secure = req.connection_info().scheme() == "https";
                let cookie = build_auth_cookie("sparky_dev_token", &token, "/dev", secure);

                HttpResponse::Ok().cookie(cookie).json(serde_json::json!({
                    "target": response.target,
                    "status": response.status,
                    "url": response.url,
                }))
            }
            Err(error) => remote_executor_error_response(error),
        };
    }

    let user_for_task = user.clone();
    let project_id_for_task = project_id.clone();
    match tokio::task::spawn_blocking(move || {
        let candidate =
            EXECUTOR.find_web_candidate(&project_root, request.candidate_id.as_deref())?;
        let server =
            EXECUTOR.restart_dev_server(&user_for_task, &project_id_for_task, &candidate)?;
        Ok::<_, String>((candidate, server))
    })
    .await
    {
        Ok(Ok((candidate, server))) => {
            let secure = req.connection_info().scheme() == "https";
            let cookie = build_auth_cookie("sparky_dev_token", &token, "/dev", secure);

            HttpResponse::Ok().cookie(cookie).json(serde_json::json!({
                "target": candidate,
                "status": server,
                "url": server.url,
            }))
        }
        Ok(Err(error)) => HttpResponse::BadRequest().json(serde_json::json!({
            "error": error
        })),
        Err(error) => HttpResponse::InternalServerError().json(serde_json::json!({
            "error": format!("restart web debug task failed: {}", error)
        })),
    }
}

// ── Sessions ─────────────────────────────────────────────────────────────────

#[get("/sessions")]
async fn list_sessions(req: HttpRequest) -> HttpResponse {
    let user = match current_user(&req).await {
        Some(user) => user,
        None => return unauthorized(),
    };

    if let Some(remote) = EXECUTOR_REMOTE.as_ref() {
        return match remote.list_sessions_for_user(&user.user_id).await {
            Ok(sessions) => HttpResponse::Ok().json(serde_json::json!({
                "sessions": sessions
            })),
            Err(error) => remote_executor_error_response(error),
        };
    }

    HttpResponse::Ok().json(serde_json::json!({
        "sessions": EXECUTOR.list_sessions_for_user(&user.user_id)
    }))
}

#[post("/projects/{id}/session")]
async fn create_session(
    req: HttpRequest,
    path: web::Path<String>,
    payload: Option<web::Json<CreateSessionRequest>>,
) -> HttpResponse {
    let user = match current_user(&req).await {
        Some(user) => user,
        None => return unauthorized(),
    };

    let project_id = path.into_inner();
    let project = match PROJECTS.find_for_user(&user.user_id, &project_id) {
        Some(p) => p,
        None => {
            return HttpResponse::NotFound().json(serde_json::json!({
                "error": "project not found"
            }));
        }
    };

    let request = payload.map(web::Json::into_inner).unwrap_or_default();
    let temporary = request.temporary.unwrap_or(false);
    let fresh = request.fresh.unwrap_or(false);
    let live_session_cwd = if is_codex_project(&project) {
        match project_runtime_root(&project) {
            Ok(path) => Some(path.display().to_string()),
            Err(error) => {
                return HttpResponse::BadRequest().json(serde_json::json!({
                    "error": error
                }))
            }
        }
    } else {
        None
    };

    if let Some(remote) = EXECUTOR_REMOTE.as_ref() {
        return match remote
            .create_session(&project, &user, temporary, fresh, false, None)
            .await
        {
            Ok(session) => {
                if let Some(cwd) = live_session_cwd.as_deref().filter(|_| !session.temporary) {
                    let live_session = build_live_codex_session_summary(&session, cwd);
                    if let Err(error) =
                        sync_live_codex_session(&user.user_id, &project.project_id, &live_session)
                            .await
                    {
                        return HttpResponse::InternalServerError().json(serde_json::json!({
                            "error": error
                        }));
                    }
                }

                HttpResponse::Ok().json(serde_json::json!({
                    "session_id": session.session_id,
                    "project_id": project_id,
                    "temporary": session.temporary,
                }))
            }
            Err(error) => remote_executor_error_response(error),
        };
    }

    match EXECUTOR.create_session(&project, &user, temporary, fresh) {
        Ok(session) => {
            if is_codex_project(&project) && !session.temporary {
                let live_session = CodexLiveSessionSummary {
                    session_id: session.id.clone(),
                    codex_session_id: session.codex_session_id.clone(),
                    cwd: session.runtime_worktree.clone(),
                    created_at_ms: session.created_at_ms,
                    updated_at_ms: session.created_at_ms,
                };
                if let Err(error) =
                    sync_live_codex_session(&user.user_id, &project.project_id, &live_session).await
                {
                    return HttpResponse::InternalServerError().json(serde_json::json!({
                        "error": error
                    }));
                }
            }

            let id = session.id.clone();
            HttpResponse::Ok().json(serde_json::json!({
                "session_id": id,
                "project_id": project_id,
                "temporary": session.temporary,
            }))
        }
        Err(e) => HttpResponse::InternalServerError().json(serde_json::json!({ "error": e })),
    }
}

#[get("/projects/{id}/codex/sessions")]
async fn list_codex_sessions(req: HttpRequest, path: web::Path<String>) -> HttpResponse {
    let user = match current_user(&req).await {
        Some(user) => user,
        None => return unauthorized(),
    };

    let project_id = path.into_inner();
    let Some(project) = PROJECTS.find_for_user(&user.user_id, &project_id) else {
        return HttpResponse::NotFound().json(serde_json::json!({
            "error": "project not found"
        }));
    };

    if !is_codex_project(&project) {
        return HttpResponse::BadRequest().json(serde_json::json!({
            "error": "project runtime is not codex"
        }));
    }

    match load_project_codex_sessions(&user, &project).await {
        Ok(sessions) => HttpResponse::Ok().json(sessions),
        Err(error) => HttpResponse::InternalServerError().json(serde_json::json!({
            "error": error
        })),
    }
}

#[post("/projects/{id}/codex/resume")]
async fn resume_codex_session(
    req: HttpRequest,
    path: web::Path<String>,
    payload: Option<web::Json<ResumeCodexSessionRequest>>,
) -> HttpResponse {
    let user = match current_user(&req).await {
        Some(user) => user,
        None => return unauthorized(),
    };

    let project_id = path.into_inner();
    let Some(project) = PROJECTS.find_for_user(&user.user_id, &project_id) else {
        return HttpResponse::NotFound().json(serde_json::json!({
            "error": "project not found"
        }));
    };

    if !is_codex_project(&project) {
        return HttpResponse::BadRequest().json(serde_json::json!({
            "error": "project runtime is not codex"
        }));
    }

    let sessions = match load_project_codex_sessions(&user, &project).await {
        Ok(sessions) => sessions,
        Err(error) => {
            return HttpResponse::InternalServerError().json(serde_json::json!({
                "error": error
            }))
        }
    };

    let request = payload.map(web::Json::into_inner).unwrap_or_default();
    let target_session_id = if let Some(session_id) = request
        .session_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        if sessions
            .history_sessions
            .iter()
            .any(|session| session.session_id == session_id)
        {
            session_id
        } else {
            return HttpResponse::NotFound().json(serde_json::json!({
                "error": "codex session not found"
            }));
        }
    } else {
        match sessions.history_sessions.first() {
            Some(session) => session.session_id.clone(),
            None => {
                return HttpResponse::NotFound().json(serde_json::json!({
                    "error": "no resumable codex session found"
                }))
            }
        }
    };

    let launch = LaunchOverride {
        command: "codex".to_string(),
        args: vec!["resume".to_string(), target_session_id.clone()],
        cwd: Some(
            project_runtime_root(&project)
                .unwrap_or_else(|_| {
                    project_worktree_path(&project).unwrap_or_else(|_| PathBuf::from("/projects"))
                })
                .display()
                .to_string(),
        ),
        codex_session_id: Some(target_session_id.clone()),
    };
    let live_session_cwd = launch.cwd.clone().unwrap_or_default();

    if let Some(remote) = EXECUTOR_REMOTE.as_ref() {
        return match remote
            .create_session(&project, &user, false, true, true, Some(launch))
            .await
        {
            Ok(session) => {
                let live_session = build_live_codex_session_summary(&session, &live_session_cwd);
                if let Err(error) =
                    sync_live_codex_session(&user.user_id, &project.project_id, &live_session).await
                {
                    return HttpResponse::InternalServerError().json(serde_json::json!({
                        "error": error
                    }));
                }

                HttpResponse::Ok().json(serde_json::json!({
                    "session_id": session.session_id,
                    "project_id": project_id,
                    "temporary": session.temporary,
                    "codex_session_id": target_session_id,
                }))
            }
            Err(error) => remote_executor_error_response(error),
        };
    }

    match EXECUTOR.create_session_with_launch(&project, &user, false, Some(launch), true, true) {
        Ok(session) => {
            let live_session = CodexLiveSessionSummary {
                session_id: session.id.clone(),
                codex_session_id: session.codex_session_id.clone(),
                cwd: session.runtime_worktree.clone(),
                created_at_ms: session.created_at_ms,
                updated_at_ms: session.created_at_ms,
            };
            if let Err(error) =
                sync_live_codex_session(&user.user_id, &project.project_id, &live_session).await
            {
                return HttpResponse::InternalServerError().json(serde_json::json!({
                    "error": error
                }));
            }

            HttpResponse::Ok().json(serde_json::json!({
                "session_id": session.id,
                "project_id": project_id,
                "temporary": session.temporary,
                "codex_session_id": target_session_id,
            }))
        }
        Err(error) => HttpResponse::InternalServerError().json(serde_json::json!({
            "error": error
        })),
    }
}

#[get("/projects/{id}/codex/sessions/{session_id}/timeline")]
async fn get_codex_session_timeline(
    req: HttpRequest,
    path: web::Path<(String, String)>,
) -> HttpResponse {
    let user = match current_user(&req).await {
        Some(user) => user,
        None => return unauthorized(),
    };

    let (project_id, target_session_id) = path.into_inner();
    let Some(project) = PROJECTS.find_for_user(&user.user_id, &project_id) else {
        return HttpResponse::NotFound().json(serde_json::json!({
            "error": "project not found"
        }));
    };

    if !is_codex_project(&project) {
        return HttpResponse::BadRequest().json(serde_json::json!({
            "error": "project runtime is not codex"
        }));
    }

    let sessions = match load_project_codex_sessions(&user, &project).await {
        Ok(sessions) => sessions,
        Err(error) => {
            return HttpResponse::InternalServerError().json(serde_json::json!({
                "error": error
            }))
        }
    };

    let Some(session) = sessions
        .history_sessions
        .iter()
        .find(|session| session.session_id == target_session_id)
    else {
        return HttpResponse::NotFound().json(serde_json::json!({
            "error": "codex session not found"
        }));
    };

    match codex::read_timeline(session) {
        Ok(timeline) => HttpResponse::Ok().json(timeline),
        Err(error) => HttpResponse::InternalServerError().json(serde_json::json!({
            "error": error
        })),
    }
}

#[delete("/session/{id}")]
async fn destroy_session(
    req: HttpRequest,
    path: web::Path<String>,
    query: web::Query<DestroySessionQuery>,
) -> HttpResponse {
    let user = match current_user(&req).await {
        Some(user) => user,
        None => return unauthorized(),
    };

    let session_id = path.into_inner();
    let allow_persistent = query.allow_persistent.unwrap_or(false);
    if let Some(remote) = EXECUTOR_REMOTE.as_ref() {
        let session = match remote.get_session(&user.user_id, &session_id).await {
            Ok(session) => session,
            Err(error) => return remote_executor_error_response(error),
        };
        return match remote
            .destroy_session(&user.user_id, &session_id, allow_persistent)
            .await
        {
            Ok(()) => {
                if !session.temporary {
                    let Some(project) = PROJECTS.find_for_user(&user.user_id, &session.project_id)
                    else {
                        return HttpResponse::NotFound().json(serde_json::json!({
                            "error": "project not found"
                        }));
                    };
                    if is_codex_project(&project) {
                        if let Err(error) = remove_live_codex_session(
                            &user.user_id,
                            &project.project_id,
                            &session_id,
                        )
                        .await
                        {
                            return HttpResponse::InternalServerError().json(serde_json::json!({
                                "error": error
                            }));
                        }
                    }
                }

                HttpResponse::Ok().json(serde_json::json!({
                    "status": "destroyed",
                    "session_id": session_id,
                    "temporary": !allow_persistent,
                }))
            }
            Err(error) => remote_executor_error_response(error),
        };
    }

    let existing_session = match EXECUTOR.resolve_session_for_user(&user.user_id, &session_id) {
        Ok(session) => session,
        Err(error) => {
            return match error {
                SessionAccessError::Forbidden => {
                    HttpResponse::Forbidden().json(serde_json::json!({
                        "error": "forbidden"
                    }))
                }
                SessionAccessError::NotFound => HttpResponse::NotFound().json(serde_json::json!({
                    "error": "session not found"
                })),
                SessionAccessError::DefaultSessionCannotBeClosed => unreachable!(),
            };
        }
    };

    if !allow_persistent {
        if existing_session.temporary {
        } else {
            return HttpResponse::BadRequest().json(serde_json::json!({
                "error": "default session cannot be closed"
            }));
        }
    }

    let existing_project_id = existing_session.project_id.clone();
    let existing_temporary = existing_session.temporary;
    EXECUTOR.remove_session(&session_id);
    if !existing_temporary {
        if let Some(project) = PROJECTS.find_for_user(&user.user_id, &existing_project_id) {
            if is_codex_project(&project) {
                if let Err(error) =
                    remove_live_codex_session(&user.user_id, &existing_project_id, &session_id)
                        .await
                {
                    return HttpResponse::InternalServerError().json(serde_json::json!({
                        "error": error
                    }));
                }
            }
        }
    }

    HttpResponse::Ok().json(serde_json::json!({
        "status": "destroyed",
        "session_id": session_id,
        "temporary": !allow_persistent,
    }))
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

async fn session_ws(
    req: HttpRequest,
    stream: web::Payload,
    path: web::Path<String>,
) -> actix_web::Result<HttpResponse> {
    let user = match current_user(&req).await {
        Some(user) => user,
        None => {
            return Ok(unauthorized());
        }
    };

    let session_id = path.into_inner();
    if let Some(remote) = EXECUTOR_REMOTE.as_ref() {
        match remote.get_session(&user.user_id, &session_id).await {
            Ok(_) => {
                let upstream_url = remote.attach_ws_url(&session_id, &user.user_id);
                let origin_override = upstream_http_origin(&upstream_url);
                return proxy_dev_websocket(req, stream, upstream_url, origin_override, &[]).await;
            }
            Err(error) => {
                return Ok(remote_executor_error_response(error));
            }
        }
    }

    match EXECUTOR.resolve_session_for_user(&user.user_id, &session_id) {
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

    log::info!("WS [/session/{}/ws] connecting...", session_id);

    let (response, mut ws_session, mut msg_stream) = actix_ws::handle(&req, stream)?;

    log::info!("WS [{}] attached to PTY", session_id);

    let sid = session_id.clone();
    let user_id = user.user_id.clone();
    actix_web::rt::spawn(async move {
        let _ = EXECUTOR
            .attach_session(&user_id, &sid, &mut ws_session, &mut msg_stream)
            .await;
    });

    Ok(response)
}

async fn load_project_codex_sessions(
    user: &auth::AuthSession,
    project: &Project,
) -> Result<CodexSessionsResponse, String> {
    let project_root = project_runtime_root(project)?;
    let project_clone = project.clone();
    let discovered = tokio::task::spawn_blocking(move || {
        codex::discover_project_sessions(&project_clone, &project_root)
    })
    .await
    .map_err(|error| format!("discover codex sessions task failed: {}", error))??;

    let live_sessions = current_live_codex_sessions(user, project).await?;

    if let Some(pool) = USER_STORE.get().and_then(|store| store.postgres_pool()) {
        codex::replace_sessions(&pool, &user.user_id, &project.project_id, &discovered).await?;
        codex::replace_live_sessions(&pool, &user.user_id, &project.project_id, &live_sessions)
            .await?;

        return Ok(CodexSessionsResponse {
            history_sessions: codex::list_sessions(&pool, &user.user_id, &project.project_id)
                .await?,
            live_sessions: codex::list_live_sessions(&pool, &user.user_id, &project.project_id)
                .await?,
        });
    }

    Ok(CodexSessionsResponse {
        history_sessions: discovered
            .into_iter()
            .map(CodexSessionSummary::from)
            .collect(),
        live_sessions,
    })
}

async fn dev_proxy_root(req: HttpRequest, payload: web::Payload) -> Result<HttpResponse, Error> {
    dev_proxy(req, payload, String::new()).await
}

async fn dev_proxy_tail(
    req: HttpRequest,
    payload: web::Payload,
    path: web::Path<(String, String, String)>,
) -> Result<HttpResponse, Error> {
    let (_, _, tail) = path.into_inner();
    dev_proxy(req, payload, tail).await
}

async fn editor_proxy_root(req: HttpRequest, payload: web::Payload) -> Result<HttpResponse, Error> {
    editor_proxy(req, payload, String::new()).await
}

async fn editor_proxy_tail(
    req: HttpRequest,
    payload: web::Payload,
    path: web::Path<(String, String)>,
) -> Result<HttpResponse, Error> {
    let (_, tail) = path.into_inner();
    editor_proxy(req, payload, tail).await
}

async fn editor_proxy(
    req: HttpRequest,
    payload: web::Payload,
    tail: String,
) -> Result<HttpResponse, Error> {
    let token = proxy_session_token(&req);
    let user = match current_proxy_user(&req).await {
        Some(user) => user,
        None => return Ok(unauthorized()),
    };

    let Some(project_id) = req.match_info().get("project_id").map(str::to_string) else {
        return Ok(HttpResponse::BadRequest().json(serde_json::json!({
            "error": "missing project id"
        })));
    };
    let Some(project) = PROJECTS.find_for_user(&user.user_id, &project_id) else {
        return Ok(HttpResponse::NotFound().json(serde_json::json!({
            "error": "project not found"
        })));
    };

    let upstream_path = if tail.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", tail)
    };

    let root = match project_runtime_root(&project) {
        Ok(root) => root,
        Err(error) => {
            return Ok(HttpResponse::BadRequest().json(serde_json::json!({
                "error": error
            })))
        }
    };

    if let Some(remote) = EXECUTOR_REMOTE.as_ref() {
        let upstream_url = remote.editor_proxy_url(
            project_id.as_str(),
            upstream_path.as_str(),
            req.uri().query(),
        );
        let extra_headers = executor_proxy_headers(&user, Some(&root));

        if is_websocket_request(&req) {
            return proxy_dev_websocket(req, payload, upstream_url, None, &extra_headers).await;
        }

        let mut response =
            proxy_dev_http(req.clone(), payload, upstream_url, None, &extra_headers).await?;
        if let Some(token) = token.filter(|value| !value.trim().is_empty()) {
            let secure = req.connection_info().scheme() == "https";
            let cookie = build_auth_cookie("sparky_editor_token", &token, "/editor", secure);
            let _ = response.add_cookie(&cookie);
        }

        return Ok(response);
    }

    let upstream_url = match EXECUTOR.editor_upstream_url(
        &user.user_id,
        project_id.as_str(),
        upstream_path.as_str(),
        req.uri().query(),
    ) {
        Ok(url) => url,
        Err(error)
            if matches!(
                error.as_str(),
                "编辑器未启动" | "编辑器已退出，请重新打开文件"
            ) =>
        {
            let user_for_task = user.clone();
            let project_id_for_task = project_id.clone();
            match tokio::task::spawn_blocking(move || {
                EXECUTOR.ensure_editor(&user_for_task, &project_id_for_task, &root)
            })
            .await
            {
                Ok(Ok(_)) => {}
                Ok(Err(error)) => {
                    return Ok(HttpResponse::BadRequest().json(serde_json::json!({
                        "error": error
                    })))
                }
                Err(error) => {
                    return Ok(HttpResponse::InternalServerError().json(serde_json::json!({
                        "error": format!("ensure editor task failed: {}", error)
                    })))
                }
            }

            match EXECUTOR.editor_upstream_url(
                &user.user_id,
                project_id.as_str(),
                upstream_path.as_str(),
                req.uri().query(),
            ) {
                Ok(url) => url,
                Err(error) => {
                    return Ok(HttpResponse::BadRequest().json(serde_json::json!({
                        "error": error
                    })))
                }
            }
        }
        Err(error) => {
            return Ok(HttpResponse::BadRequest().json(serde_json::json!({
                "error": error
            })))
        }
    };

    if is_websocket_request(&req) {
        let origin_override = upstream_http_origin(&upstream_url);
        return proxy_dev_websocket(req, payload, upstream_url, origin_override, &[]).await;
    }

    let mut response = proxy_dev_http(req.clone(), payload, upstream_url, None, &[]).await?;
    if let Some(token) = token.filter(|value| !value.trim().is_empty()) {
        let secure = req.connection_info().scheme() == "https";
        let cookie = build_auth_cookie("sparky_editor_token", &token, "/editor", secure);
        let _ = response.add_cookie(&cookie);
    }

    Ok(response)
}

async fn dev_proxy(
    req: HttpRequest,
    payload: web::Payload,
    tail: String,
) -> Result<HttpResponse, Error> {
    let token_meta =
        proxy_session_token_with_source(&req).map(|(token, source)| (source, token.len()));
    let user = match current_proxy_user(&req).await {
        Some(user) => user,
        None => {
            log::warn!(
                "dev proxy auth failed method={} path={} token_source={} token_len={} has_auth_cookie={} has_dev_cookie={} has_editor_cookie={} has_authorization={} has_query_token={} referer={}",
                req.method(),
                req.uri(),
                token_meta.map(|(source, _)| source).unwrap_or("none"),
                token_meta.map(|(_, len)| len).unwrap_or(0),
                req.cookie("sparky_auth_token").is_some(),
                req.cookie("sparky_dev_token").is_some(),
                req.cookie("sparky_editor_token").is_some(),
                req.headers().contains_key(actix_web::http::header::AUTHORIZATION),
                req.query_string().split('&').any(|pair| pair.starts_with("token=")),
                req.headers()
                    .get(actix_web::http::header::REFERER)
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or("-"),
            );
            return Ok(unauthorized());
        }
    };

    let Some(project_id) = req.match_info().get("project_id").map(str::to_string) else {
        return Ok(HttpResponse::BadRequest().json(serde_json::json!({
            "error": "missing project id"
        })));
    };
    let Some(candidate_id) = req.match_info().get("entry_id").map(str::to_string) else {
        return Ok(HttpResponse::BadRequest().json(serde_json::json!({
            "error": "missing entry id"
        })));
    };

    if let Some(remote) = EXECUTOR_REMOTE.as_ref() {
        let upstream_url = remote.dev_server_proxy_url(
            project_id.as_str(),
            candidate_id.as_str(),
            &tail,
            req.uri().query(),
        );
        log::info!("dev proxy request {} -> remote {}", req.uri(), upstream_url);
        let extra_headers = executor_proxy_headers(&user, None);

        if is_websocket_request(&req) {
            return proxy_dev_websocket(req, payload, upstream_url, None, &extra_headers).await;
        }

        let proxy_base = format!("/dev/{}/{}/", project_id, candidate_id);
        return proxy_dev_http(
            req,
            payload,
            upstream_url,
            Some(proxy_base.as_str()),
            &extra_headers,
        )
        .await;
    }

    let upstream_url = match EXECUTOR.dev_server_upstream_url(
        &user.user_id,
        project_id.as_str(),
        candidate_id.as_str(),
        build_dev_request_path(project_id.as_str(), candidate_id.as_str(), &tail).as_str(),
        req.uri().query(),
    ) {
        Ok(url) => url,
        Err(error) => {
            return Ok(HttpResponse::BadRequest().json(serde_json::json!({
                "error": error
            })))
        }
    };
    log::info!("dev proxy request {} -> local {}", req.uri(), upstream_url);

    if is_websocket_request(&req) {
        return proxy_dev_websocket(req, payload, upstream_url, None, &[]).await;
    }

    let proxy_base = format!("/dev/{}/{}/", project_id, candidate_id);
    proxy_dev_http(req, payload, upstream_url, Some(proxy_base.as_str()), &[]).await
}

async fn proxy_dev_http(
    req: HttpRequest,
    mut payload: web::Payload,
    upstream_url: String,
    proxy_base: Option<&str>,
    extra_headers: &[(actix_web::http::header::HeaderName, String)],
) -> Result<HttpResponse, Error> {
    let client = Client::default();
    let mut body = BytesMut::new();
    while let Some(chunk) = payload.next().await {
        let chunk = chunk.map_err(actix_web::error::ErrorBadRequest)?;
        body.extend_from_slice(&chunk);
    }

    let forward = copy_forward_headers(
        req.headers(),
        client.request(req.method().clone(), upstream_url.clone()),
        extra_headers,
    );

    let mut upstream = forward
        .send_body(body.freeze())
        .await
        .map_err(actix_web::error::ErrorBadGateway)?;

    let status = upstream.status();
    let content_type = upstream
        .headers()
        .get(actix_web::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let request_uri = req.uri().to_string();
    let is_html = content_type.starts_with("text/html") && proxy_base.is_some();
    let response_headers = upstream.headers().clone();
    let body = upstream
        .body()
        .limit(64 * 1024 * 1024)
        .await
        .map_err(actix_web::error::ErrorBadGateway)?;

    if request_uri.contains("/api/") || !status.is_success() {
        log::info!(
            "dev proxy response method={} path={} upstream={} status={} content_type={}",
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
    copy_response_headers(&response_headers, &mut response, proxy_base);

    if is_html {
        let proxy_root = proxy_base.unwrap_or("/");
        let document_base = document_base_for_proxy(req.uri().path(), proxy_root);
        let rewritten = rewrite_html_for_proxy(&bytes_to_string(body), proxy_root, &document_base);
        Ok(response.body(rewritten))
    } else {
        Ok(response.body(body))
    }
}

async fn proxy_dev_websocket(
    req: HttpRequest,
    payload: web::Payload,
    upstream_url: String,
    origin_override: Option<String>,
    extra_headers: &[(actix_web::http::header::HeaderName, String)],
) -> Result<HttpResponse, Error> {
    let (response, mut client_ws, client_stream) = actix_ws::handle(&req, payload)?;
    let request_path = req.uri().path().to_string();
    let mut client_stream = client_stream.max_frame_size(PROXY_WS_MAX_FRAME_SIZE);

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
        builder = builder.set_header("sec-websocket-protocol", protocol);
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
    for (name, value) in extra_headers {
        builder = builder.set_header(name.clone(), value.clone());
    }

    let (_, mut upstream) = builder.connect().await.map_err(|error| {
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

fn origin_authority(origin: &str) -> Option<&str> {
    let (_, rest) = origin.split_once("://")?;
    if rest.is_empty() {
        return None;
    }
    Some(rest)
}

fn is_websocket_request(req: &HttpRequest) -> bool {
    req.headers()
        .get(actix_web::http::header::UPGRADE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
}

fn should_skip_request_header(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if lower.starts_with("sec-websocket-") {
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
            | "content-encoding"
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
    extra_headers: &[(actix_web::http::header::HeaderName, String)],
) -> awc::ClientRequest {
    for (name, value) in headers {
        if should_skip_request_header(name.as_str()) {
            continue;
        }
        request = request.append_header((name.clone(), value.clone()));
    }
    for (name, value) in extra_headers {
        request = request.append_header((name.clone(), value.clone()));
    }
    request
}

fn executor_proxy_headers(
    user: &auth::AuthSession,
    root: Option<&Path>,
) -> Vec<(actix_web::http::header::HeaderName, String)> {
    let mut headers = vec![
        (
            actix_web::http::header::HeaderName::from_static("x-sparky-user-id"),
            user.user_id.clone(),
        ),
        (
            actix_web::http::header::HeaderName::from_static("x-sparky-username"),
            user.username.clone(),
        ),
        (
            actix_web::http::header::HeaderName::from_static("x-sparky-home-dir"),
            user.home_dir.display().to_string(),
        ),
    ];

    if let Some(root) = root {
        headers.push((
            actix_web::http::header::HeaderName::from_static("x-sparky-root"),
            root.display().to_string(),
        ));
    }

    headers
}

fn join_proxy_location(proxy_base: &str, location: &str) -> String {
    let base = proxy_base.trim_end_matches('/');
    if location.is_empty() {
        return proxy_base.to_string();
    }

    if location.starts_with('?') || location.starts_with('#') {
        return format!("{}{}", proxy_base, location);
    }

    if location.starts_with('/') {
        return format!("{}{}", base, location);
    }

    format!("{}/{}", base, location.trim_start_matches("./"))
}

fn rewrite_proxy_location(location: &str, proxy_base: &str) -> Option<String> {
    if location.is_empty() || location.starts_with(proxy_base) {
        return None;
    }

    if location.starts_with('/') || location.starts_with('?') || location.starts_with('#') {
        return Some(join_proxy_location(proxy_base, location));
    }

    let absolute_prefixes = [
        "http://127.0.0.1:",
        "https://127.0.0.1:",
        "http://localhost:",
        "https://localhost:",
    ];

    if absolute_prefixes
        .iter()
        .any(|prefix| location.starts_with(prefix))
    {
        let Some(scheme_index) = location.find("://") else {
            return None;
        };
        let host_start = scheme_index + 3;
        let path_start = location[host_start..]
            .find('/')
            .map(|index| host_start + index)
            .unwrap_or(location.len());
        let path_and_query = &location[path_start..];
        return Some(join_proxy_location(
            proxy_base,
            if path_and_query.is_empty() {
                "/"
            } else {
                path_and_query
            },
        ));
    }

    None
}

fn copy_response_headers(
    headers: &actix_web::http::header::HeaderMap,
    response: &mut actix_web::HttpResponseBuilder,
    proxy_base: Option<&str>,
) {
    for (name, value) in headers {
        if should_skip_response_header(name.as_str()) {
            continue;
        }

        if name == actix_web::http::header::LOCATION {
            if let (Some(proxy_base), Ok(location)) = (proxy_base, value.to_str()) {
                if let Some(rewritten) = rewrite_proxy_location(location, proxy_base) {
                    response.append_header((name.clone(), rewritten));
                    continue;
                }
            }
        }

        response.append_header((name.clone(), value.clone()));
    }
}

// ── Main ──────────────────────────────────────────────────────────────────────

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    env_logger::init_from_env(env_logger::Env::default().default_filter_or("info"));

    let cfg = SERVER_CONFIG.clone();
    let sandbox_root = cfg.sandbox_root.display().to_string();
    let user_store = Arc::new(
        UserStore::new(cfg.clone())
            .await
            .map_err(std::io::Error::other)?,
    );
    let auth_backend = user_store.backend_name();
    let postgres_pool = user_store.postgres_pool();
    let _ = USER_STORE.set(user_store);

    if let Some(pool) = postgres_pool {
        codex::init_schema(&pool)
            .await
            .map_err(std::io::Error::other)?;
    }

    std::fs::create_dir_all(&cfg.sandbox_root).ok();
    std::fs::create_dir_all(cfg.sandbox_root.join("sessions")).ok();

    log::info!("Sparky sandbox server");
    log::info!("  listening on  0.0.0.0:{}", cfg.port);
    log::info!("  sandbox root  {}", sandbox_root);
    log::info!("  web dist      {}", cfg.web_dist_dir.display());
    log::info!("  config       {:?}", config::config_path());
    log::info!("  builtins     {:?}", PROJECTS.base_path());
    log::info!("  custom root  {:?}", PROJECTS.custom_root());
    log::info!("  builtin projects {} loaded", PROJECTS.len());
    log::info!("  auth backend  {}", auth_backend);
    log::info!("  bwrap unshare_user {}", cfg.bwrap_unshare_user);

    HttpServer::new(|| {
        App::new()
            .service(health)
            .service(register)
            .service(login)
            .service(auth_me)
            .service(auth_logout)
            .service(list_projects)
            .service(create_project)
            .service(update_project)
            .service(delete_project)
            .service(project_git_status)
            .service(project_git_action)
            .service(list_codex_sessions)
            .service(resume_codex_session)
            .service(get_codex_session_timeline)
            .service(project_file_tree)
            .service(project_editor_open)
            .service(project_web_targets)
            .service(project_web_open)
            .service(project_web_restart)
            .service(list_sessions)
            .service(create_session)
            .service(destroy_session)
            .route("/session/{id}/ws", web::get().to(session_ws))
            .route("/dev/{project_id}/{entry_id}", web::to(dev_proxy_root))
            .route(
                "/dev/{project_id}/{entry_id}/{tail:.*}",
                web::to(dev_proxy_tail),
            )
            .route("/editor/{project_id}", web::to(editor_proxy_root))
            .route("/editor/{project_id}/{tail:.*}", web::to(editor_proxy_tail))
            .route("/{filename:logo\\.png}", web::get().to(serve_root_static))
            .route("/", web::get().to(serve_index))
            .route("/assets/{path:.*}", web::get().to(serve_assets))
            .route("/seti/{path:.*}", web::get().to(serve_seti_assets))
    })
    .bind(("0.0.0.0", cfg.port))?
    .run()
    .await
}

fn create_project_inner(
    user_id: &str,
    request: CreateProjectRequest,
) -> Result<(Project, Option<PendingRepositoryClone>), String> {
    let name = request.name.trim();
    if name.is_empty() {
        return Err("project name is required".to_string());
    }

    let projects_root = config::projects_root();
    let project_path = resolve_project_path(&request.path, &projects_root)?;
    let project_path_str = project_path.to_string_lossy().to_string();

    if PROJECTS.path_in_use(user_id, &project_path_str) {
        return Err("project path already configured".to_string());
    }

    let git_url = normalize_git_url(request.git_url.as_deref());
    let runtime = parse_runtime(request.runtime.as_deref());
    initialize_project_directory(&project_path, git_url.is_some())?;

    let existing_ids = PROJECTS
        .list_for_user(user_id)
        .into_iter()
        .map(|project| project.project_id)
        .collect::<Vec<_>>();
    let project_id = unique_project_id(name, &existing_ids);
    let project = build_project_template(
        &project_id,
        name,
        &project_path_str,
        git_url.clone(),
        runtime,
    );

    let project = PROJECTS.add_custom_project(user_id, project)?;
    let pending_clone = git_url.map(|git_url| PendingRepositoryClone {
        project_id: project.project_id.clone(),
        project_path,
        git_url,
    });

    Ok((project, pending_clone))
}

fn project_worktree_path(project: &Project) -> Result<PathBuf, String> {
    project
        .bind_dirs
        .iter()
        .find(|dir| dir.as_str() != "/tmp")
        .map(PathBuf::from)
        .ok_or_else(|| "project worktree is not configured".to_string())
}

fn project_runtime_root(project: &Project) -> Result<PathBuf, String> {
    let worktree = project_worktree_path(project)?;
    resolve_runtime_worktree(&worktree)
}

fn parse_git_action(payload: GitActionRequest, username: &str) -> Result<GitAction, String> {
    match payload.action.trim().to_ascii_lowercase().as_str() {
        "fetch" => Ok(GitAction::Fetch),
        "pull" => Ok(GitAction::Pull),
        "push" => Ok(GitAction::Push),
        "stage_all" => Ok(GitAction::StageAll),
        "commit" => Ok(GitAction::Commit {
            message: payload.message.unwrap_or_default(),
            author_name: username.to_string(),
            author_email: git_author_email(username),
        }),
        _ => Err("unsupported git action".to_string()),
    }
}

fn git_author_email(username: &str) -> String {
    let local = username
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>();

    let local = local.trim_matches('-');
    if local.is_empty() {
        "user@sparky.local".to_string()
    } else {
        format!("{}@sparky.local", local)
    }
}

fn update_project_inner(
    user_id: &str,
    project_id: &str,
    request: UpdateProjectRequest,
) -> Result<(Project, Option<PendingRepositoryClone>), String> {
    let existing = PROJECTS
        .find_for_user(user_id, project_id)
        .ok_or_else(|| "project not found".to_string())?;

    let name = request.name.trim();
    if name.is_empty() {
        return Err("project name is required".to_string());
    }

    let projects_root = config::projects_root();
    let project_path = resolve_project_path(&request.path, &projects_root)?;
    let project_path_str = project_path.to_string_lossy().to_string();

    if PROJECTS.path_in_use_except(user_id, &project_path_str, Some(project_id)) {
        return Err("project path already configured".to_string());
    }

    let git_url = normalize_git_url(request.git_url.as_deref());
    let should_clone = matches!(git_url.as_deref(), Some(_)) && !has_git_repository(&project_path)?;

    if should_clone {
        initialize_project_directory(&project_path, true)?;
    } else {
        ensure_project_directory_exists(&project_path)?;
    }

    let runtime = parse_runtime(request.runtime.as_deref());
    let project = PROJECTS.update_custom_project(
        user_id,
        project_id,
        build_project_template(
            &existing.project_id,
            name,
            &project_path_str,
            git_url.clone(),
            runtime,
        ),
    )?;

    let pending_clone = if should_clone {
        git_url.map(|git_url| PendingRepositoryClone {
            project_id: project.project_id.clone(),
            project_path,
            git_url,
        })
    } else {
        None
    };

    Ok((project, pending_clone))
}

#[derive(Clone, Copy)]
enum RuntimeKind {
    Claude,
    Codex,
}

fn parse_runtime(value: Option<&str>) -> RuntimeKind {
    match value.map(|item| item.trim().to_ascii_lowercase()) {
        Some(runtime) if runtime == "codex" => RuntimeKind::Codex,
        _ => RuntimeKind::Claude,
    }
}

fn build_project_template(
    project_id: &str,
    display_name: &str,
    project_path: &str,
    git_url: Option<String>,
    runtime: RuntimeKind,
) -> Project {
    let (provider, summary, accent, tagline, command) = match runtime {
        RuntimeKind::Claude => (
            "Anthropic",
            "用户创建的 Claude Code 项目工作区。",
            "claude",
            "推理工作区",
            "claude",
        ),
        RuntimeKind::Codex => (
            "OpenAI",
            "用户创建的 OpenAI Codex 项目工作区。",
            "codex",
            "代码执行工作区",
            "codex",
        ),
    };

    let mut env_vars = std::collections::HashMap::from([
        ("HOME".to_string(), "/home/app".to_string()),
        ("TERM".to_string(), "xterm-256color".to_string()),
        ("CC_SNAPSHOT_DIR".to_string(), project_path.to_string()),
    ]);

    if matches!(runtime, RuntimeKind::Codex) {
        env_vars.insert("CODEX_HOME".to_string(), "/home/app/.codex".to_string());
        env_vars.insert(
            "OPENAI_API_KEY".to_string(),
            "{{OPENAI_API_KEY}}".to_string(),
        );
    }

    Project {
        project_id: project_id.to_string(),
        display_name: Some(display_name.to_string()),
        provider: Some(provider.to_string()),
        summary: Some(summary.to_string()),
        accent: Some(accent.to_string()),
        tagline: Some(tagline.to_string()),
        git_url,
        root_fs: "/".to_string(),
        bind_dirs: vec!["/tmp".to_string(), project_path.to_string()],
        env_vars,
        cmd: "/bin/bash".to_string(),
        cmd_args: vec![
            "-lc".to_string(),
            format!("cd {} && exec {}", shell_escape(project_path), command),
        ],
    }
}

fn resolve_project_path(input: &str, projects_root: &Path) -> Result<PathBuf, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("project path is required".to_string());
    }

    let raw = PathBuf::from(trimmed);
    let relative = if raw.is_absolute() {
        raw.strip_prefix(projects_root)
            .map_err(|_| "project path must stay under /projects".to_string())?
            .to_path_buf()
    } else {
        raw
    };

    let mut clean = PathBuf::new();
    for component in relative.components() {
        match component {
            Component::Normal(part) => clean.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("project path must stay under /projects".to_string())
            }
        }
    }

    if clean.as_os_str().is_empty() {
        return Err("project path is required".to_string());
    }

    Ok(projects_root.join(clean))
}

fn normalize_git_url(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn initialize_project_directory(
    project_path: &Path,
    validate_clone_target: bool,
) -> Result<(), String> {
    ensure_project_parent_exists(project_path)?;

    if validate_clone_target {
        ensure_clone_target_ready(project_path)?;
    }

    std::fs::create_dir_all(project_path).map_err(|error| {
        format!(
            "create project directory {}: {}",
            project_path.display(),
            error
        )
    })
}

fn spawn_repository_clone(task: Option<PendingRepositoryClone>) {
    let Some(task) = task else {
        return;
    };

    log::info!(
        "starting background git clone for project {} into {}",
        task.project_id,
        task.project_path.display()
    );

    let _ = tokio::task::spawn_blocking(move || {
        match clone_project_repository(&task.project_path, &task.git_url) {
            Ok(()) => {
                log::info!(
                    "background git clone finished for project {} into {}",
                    task.project_id,
                    task.project_path.display()
                );
            }
            Err(error) => {
                log::warn!(
                    "background git clone failed for project {} into {}: {}",
                    task.project_id,
                    task.project_path.display(),
                    error
                );
            }
        }
    });
}

fn ensure_project_parent_exists(project_path: &Path) -> Result<(), String> {
    if let Some(parent) = project_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("create project parent {}: {}", parent.display(), error))?;
    }
    Ok(())
}

fn clone_project_repository(project_path: &Path, git_url: &str) -> Result<(), String> {
    ensure_clone_target_ready(project_path)?;

    let status = Command::new("git")
        .args([
            "-c",
            "protocol.file.allow=always",
            "-c",
            "safe.directory=*",
            "clone",
            "--depth",
            "1",
            git_url,
        ])
        .arg(project_path)
        .status()
        .map_err(|error| format!("run git clone: {}", error))?;

    if !status.success() {
        return Err(format!("git clone failed with status {}", status));
    }

    Ok(())
}

fn ensure_clone_target_ready(project_path: &Path) -> Result<(), String> {
    if !project_path.exists() {
        return Ok(());
    }

    let entries = project_path
        .read_dir()
        .map_err(|error| format!("read project dir {}: {}", project_path.display(), error))?;

    for entry in entries {
        let entry = entry
            .map_err(|error| format!("read project dir {}: {}", project_path.display(), error))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if matches!(name.as_ref(), ".sparky" | ".cc-bridge") {
            continue;
        }
        return Err("project path already exists and is not empty".to_string());
    }

    Ok(())
}

fn ensure_project_directory_exists(project_path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(project_path).map_err(|error| {
        format!(
            "create project directory {}: {}",
            project_path.display(),
            error
        )
    })
}

fn unique_project_id(name: &str, existing: &[String]) -> String {
    let base = slugify(name);
    if !existing.iter().any(|item| item == &base) {
        return base;
    }

    for index in 2.. {
        let candidate = format!("{}-{}", base, index);
        if !existing.iter().any(|item| item == &candidate) {
            return candidate;
        }
    }

    unreachable!()
}

fn slugify(value: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = false;

    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            slug.push('-');
            last_dash = true;
        }
    }

    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "project".to_string()
    } else {
        slug
    }
}

fn shell_escape(value: &str) -> String {
    let escaped = value.replace('\'', r"'\''");
    format!("'{}'", escaped)
}
