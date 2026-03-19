use std::time::Duration;

use axum::{
    extract::{Path, Query, State},
    response::{sse::Event, Sse},
    routing::{delete, get, post},
    Json,
};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_stream::wrappers::BroadcastStream;
use tracing::{info, warn};
use uuid::Uuid;

use crate::{
    storage::{
        db::open_db,
        models::{self, AIProvider, AppConfig, HookRecordsResponse, WebIdeSummaryResponse},
    },
    web_server::{
        auth::AuthSession,
        events::ServerEvent,
        tunnel::protocol::TunnelMessage,
        web_ide::WebIdeEvent,
        AppState,
    },
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

pub fn api_routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/api/projects", get(list_projects).post(create_project))
        .route("/api/projects/:id", delete(delete_project_handler))
        .route("/api/projects/:id/detail", get(project_detail))
        .route("/api/sessions", get(list_sessions))
        .route("/api/terminal/history", get(terminal_history))
        .route("/api/terminal/exec", post(exec_terminal))
        .route("/api/sessions/:id/rename", post(rename_session))
        .route("/api/sessions/:id/delete", post(delete_session))
        .route("/api/sessions/:id/resume", post(resume_session))
        .route("/api/config", get(get_config).post(save_config))
        .route("/api/providers", get(list_providers).post(save_provider))
        .route("/api/providers/:app_type/:id", delete(delete_provider))
        .route("/api/hooks", get(list_hook_records))
        .route("/api/hooks/:id", delete(delete_hook_record_handler))
        .route("/api/hooks/batch-delete", post(delete_hook_records_handler))
        .route("/api/web-ide/summary", get(web_ide_summary))
        .route("/api/web-ide/events", get(web_ide_events))
        .route("/api/events", get(event_stream))
}

async fn list_projects(
    _state: State<AppState>,
    auth: AuthSession,
) -> Result<Json<Value>, (axum::http::StatusCode, String)> {
    let conn = open_db().map_err(internal_error)?;
    let mut projects = models::list_projects(&conn).map_err(internal_error)?;
    if !auth.0.allowed_projects.is_empty() {
        projects.retain(|project| auth.0.allowed_projects.iter().any(|id| id == &project.id.to_string()));
    }
    Ok(Json(json!(projects)))
}

#[derive(Deserialize)]
struct CreateProjectPayload {
    name: String,
    path: String,
}

async fn create_project(
    _state: State<AppState>,
    auth: AuthSession,
    Json(payload): Json<CreateProjectPayload>,
) -> Result<Json<Value>, (axum::http::StatusCode, String)> {
    if !auth.0.allowed_projects.is_empty() {
        return Err((axum::http::StatusCode::FORBIDDEN, "Forbidden".to_string()));
    }
    let conn = open_db().map_err(internal_error)?;
    let project = models::add_project(&conn, payload.name, payload.path).map_err(internal_error)?;
    Ok(Json(json!(project)))
}

async fn delete_project_handler(
    _state: State<AppState>,
    auth: AuthSession,
    Path(id): Path<String>,
) -> Result<Json<Value>, (axum::http::StatusCode, String)> {
    if !auth.0.allowed_projects.is_empty() {
        return Err((axum::http::StatusCode::FORBIDDEN, "Forbidden".to_string()));
    }
    let project_id = parse_project_id(&id)?;
    let conn = open_db().map_err(internal_error)?;
    models::delete_project(&conn, project_id).map_err(internal_error)?;
    Ok(Json(json!({})))
}

async fn project_detail(
    _state: State<AppState>,
    auth: AuthSession,
    Path(id): Path<String>,
) -> Result<Json<Value>, (axum::http::StatusCode, String)> {
    ensure_project_allowed(&auth, &id)?;
    let project_id = parse_project_id(&id)?;
    let conn = open_db().map_err(internal_error)?;
    let detail = models::get_project_detail(&conn, project_id).map_err(map_project_not_found)?;
    Ok(Json(json!(detail)))
}

#[derive(Deserialize)]
struct ProjectQuery {
    project_id: String,
}

async fn list_sessions(
    _state: State<AppState>,
    auth: AuthSession,
    Query(query): Query<ProjectQuery>,
) -> Result<Json<Value>, (axum::http::StatusCode, String)> {
    ensure_project_allowed(&auth, &query.project_id)?;
    let project_id = parse_project_id(&query.project_id)?;
    let conn = open_db().map_err(internal_error)?;
    let project_path = models::get_project_path_by_id(&conn, project_id)
        .map_err(internal_error)?
        .ok_or_else(|| (axum::http::StatusCode::NOT_FOUND, "PROJECT_NOT_FOUND".to_string()))?;
    let sessions = models::list_project_sessions(&conn, &project_path).map_err(internal_error)?;
    Ok(Json(json!(sessions)))
}

async fn terminal_history(
    _state: State<AppState>,
    auth: AuthSession,
    Query(query): Query<ProjectQuery>,
) -> Result<Json<Value>, (axum::http::StatusCode, String)> {
    ensure_project_allowed(&auth, &query.project_id)?;
    let project_id = parse_project_id(&query.project_id)?;
    let conn = open_db().map_err(internal_error)?;
    let project_path = models::get_project_path_by_id(&conn, project_id)
        .map_err(internal_error)?
        .ok_or_else(|| (axum::http::StatusCode::NOT_FOUND, "PROJECT_NOT_FOUND".to_string()))?;
    let history = models::list_terminal_history(&conn, &project_path).map_err(internal_error)?;
    Ok(Json(json!(history)))
}

#[derive(Deserialize)]
struct ExecPayload {
    project_id: String,
    command: String,
}

async fn exec_terminal(
    State(state): State<AppState>,
    auth: AuthSession,
    Json(payload): Json<ExecPayload>,
) -> Result<Json<Value>, (axum::http::StatusCode, String)> {
    info!("audit exec project_id={} cmd={}", payload.project_id, payload.command);
    forward_request(
        state,
        auth,
        "terminal.exec",
        Some(payload.project_id),
        json!({ "command": payload.command }),
    )
    .await
}

#[derive(Deserialize)]
struct RenamePayload {
    project_id: String,
    name: String,
}

async fn rename_session(
    _state: State<AppState>,
    auth: AuthSession,
    Path(id): Path<String>,
    Json(payload): Json<RenamePayload>,
) -> Result<Json<Value>, (axum::http::StatusCode, String)> {
    info!("audit session rename session_id={} project_id={}", id, payload.project_id);
    ensure_project_allowed(&auth, &payload.project_id)?;
    let conn = open_db().map_err(internal_error)?;
    models::update_session_name(&conn, &id, &payload.name).map_err(internal_error)?;
    Ok(Json(json!({})))
}

#[derive(Deserialize)]
struct SessionPayload {
    project_id: String,
}

async fn delete_session(
    _state: State<AppState>,
    auth: AuthSession,
    Path(id): Path<String>,
    Json(payload): Json<SessionPayload>,
) -> Result<Json<Value>, (axum::http::StatusCode, String)> {
    info!("audit session delete session_id={} project_id={}", id, payload.project_id);
    ensure_project_allowed(&auth, &payload.project_id)?;
    let conn = open_db().map_err(internal_error)?;
    models::delete_session(&conn, &id).map_err(internal_error)?;
    Ok(Json(json!({})))
}

async fn resume_session(
    State(state): State<AppState>,
    auth: AuthSession,
    Path(id): Path<String>,
    Json(payload): Json<SessionPayload>,
) -> Result<Json<Value>, (axum::http::StatusCode, String)> {
    info!("audit session resume session_id={} project_id={}", id, payload.project_id);
    forward_request(
        state,
        auth,
        "sessions.resume",
        Some(payload.project_id),
        json!({ "session_id": id }),
    )
    .await
}

async fn get_config(
    _state: State<AppState>,
    _auth: AuthSession,
) -> Result<Json<Value>, (axum::http::StatusCode, String)> {
    let conn = open_db().map_err(internal_error)?;
    let config = models::load_app_config(&conn).map_err(internal_error)?;
    Ok(Json(json!(config)))
}

async fn save_config(
    _state: State<AppState>,
    _auth: AuthSession,
    Json(config): Json<AppConfig>,
) -> Result<Json<Value>, (axum::http::StatusCode, String)> {
    let conn = open_db().map_err(internal_error)?;
    models::save_app_config(&conn, &config).map_err(internal_error)?;
    Ok(Json(json!({})))
}

async fn list_providers(
    _state: State<AppState>,
    _auth: AuthSession,
) -> Result<Json<Value>, (axum::http::StatusCode, String)> {
    let conn = open_db().map_err(internal_error)?;
    let providers = models::list_ai_providers(&conn).map_err(internal_error)?;
    Ok(Json(json!(providers)))
}

async fn save_provider(
    _state: State<AppState>,
    _auth: AuthSession,
    Json(provider): Json<AIProvider>,
) -> Result<Json<Value>, (axum::http::StatusCode, String)> {
    let conn = open_db().map_err(internal_error)?;
    let id = models::upsert_ai_provider(&conn, provider).map_err(internal_error)?;
    Ok(Json(json!({ "id": id })))
}

async fn delete_provider(
    _state: State<AppState>,
    _auth: AuthSession,
    Path((app_type, id)): Path<(String, String)>,
) -> Result<Json<Value>, (axum::http::StatusCode, String)> {
    let conn = open_db().map_err(internal_error)?;
    models::delete_ai_provider(&conn, &id, &app_type).map_err(internal_error)?;
    Ok(Json(json!({})))
}

#[derive(Deserialize)]
struct HookRecordsQuery {
    project_id: String,
    page: Option<u32>,
    page_size: Option<u32>,
}

async fn list_hook_records(
    _state: State<AppState>,
    auth: AuthSession,
    Query(query): Query<HookRecordsQuery>,
) -> Result<Json<Value>, (axum::http::StatusCode, String)> {
    ensure_project_allowed(&auth, &query.project_id)?;
    let project_id = parse_project_id(&query.project_id)?;
    let conn = open_db().map_err(internal_error)?;
    let project_path = models::get_project_path_by_id(&conn, project_id)
        .map_err(internal_error)?
        .ok_or_else(|| (axum::http::StatusCode::NOT_FOUND, "PROJECT_NOT_FOUND".to_string()))?;
    let response: HookRecordsResponse = models::list_hook_records(&conn, &project_path, query.page, query.page_size)
        .map_err(internal_error)?;
    Ok(Json(json!(response)))
}

async fn delete_hook_record_handler(
    _state: State<AppState>,
    auth: AuthSession,
    Path(id): Path<i64>,
    Query(query): Query<ProjectQuery>,
) -> Result<Json<Value>, (axum::http::StatusCode, String)> {
    ensure_project_allowed(&auth, &query.project_id)?;
    let project_id = parse_project_id(&query.project_id)?;
    let conn = open_db().map_err(internal_error)?;
    let project_path = models::get_project_path_by_id(&conn, project_id)
        .map_err(internal_error)?
        .ok_or_else(|| (axum::http::StatusCode::NOT_FOUND, "PROJECT_NOT_FOUND".to_string()))?;
    models::delete_hook_record(&conn, &project_path, id).map_err(internal_error)?;
    Ok(Json(json!({})))
}

#[derive(Deserialize)]
struct DeleteHooksPayload {
    project_id: String,
    ids: Vec<i64>,
}

async fn delete_hook_records_handler(
    _state: State<AppState>,
    auth: AuthSession,
    Json(payload): Json<DeleteHooksPayload>,
) -> Result<Json<Value>, (axum::http::StatusCode, String)> {
    ensure_project_allowed(&auth, &payload.project_id)?;
    let project_id = parse_project_id(&payload.project_id)?;
    let conn = open_db().map_err(internal_error)?;
    let project_path = models::get_project_path_by_id(&conn, project_id)
        .map_err(internal_error)?
        .ok_or_else(|| (axum::http::StatusCode::NOT_FOUND, "PROJECT_NOT_FOUND".to_string()))?;
    models::delete_hook_records(&conn, &project_path, &payload.ids).map_err(internal_error)?;
    Ok(Json(json!({})))
}

async fn web_ide_summary(
    State(state): State<AppState>,
    auth: AuthSession,
) -> Result<Json<Value>, (axum::http::StatusCode, String)> {
    let projects = state
        .web_ide
        .summary_for_agent(&auth.0.agent_id, &auth.0.allowed_projects)
        .await;
    Ok(Json(json!(WebIdeSummaryResponse { projects })))
}

async fn web_ide_events(
    State(state): State<AppState>,
    auth: AuthSession,
) -> Result<Sse<impl tokio_stream::Stream<Item = Result<Event, axum::Error>>>, (axum::http::StatusCode, String)> {
    let receiver = state.web_ide_events.subscribe();
    let agent_id = auth.0.agent_id.clone();
    let allowed_projects = auth.0.allowed_projects.clone();
    let stream = BroadcastStream::new(receiver).filter_map(move |message| {
        let agent_id = agent_id.clone();
        let allowed_projects = allowed_projects.clone();
        async move {
            match message {
                Ok(event) if event.agent_id == agent_id => {
                    if let Some(project) = event.project.as_ref() {
                        if !allowed_projects.is_empty()
                            && !allowed_projects.iter().any(|id| id == &project.project_id)
                        {
                            return None;
                        }
                    }
                    Some(Ok(web_ide_event_to_sse(event)))
                }
                _ => None,
            }
        }
    });

    Ok(Sse::new(stream))
}

async fn event_stream(
    State(state): State<AppState>,
    auth: AuthSession,
    Query(query): Query<ProjectQuery>,
) -> Result<Sse<impl tokio_stream::Stream<Item = Result<Event, axum::Error>>>, (axum::http::StatusCode, String)> {
    if !is_authorized_project(&auth.0.allowed_projects, &query.project_id) {
        return Err((axum::http::StatusCode::FORBIDDEN, "Forbidden".to_string()));
    }

    let receiver = state.events.subscribe(&query.project_id).await;
    let stream = BroadcastStream::new(receiver).filter_map(|message| async move {
        match message {
            Ok(event) => Some(Ok(event_to_sse(event))),
            Err(_) => None,
        }
    });

    Ok(Sse::new(stream))
}

async fn forward_request(
    state: AppState,
    auth: AuthSession,
    op: &str,
    project_id: Option<String>,
    payload: Value,
) -> Result<Json<Value>, (axum::http::StatusCode, String)> {
    if let Some(pid) = project_id.as_ref() {
        if !is_authorized_project(&auth.0.allowed_projects, pid) {
            return Err((axum::http::StatusCode::FORBIDDEN, "Forbidden".to_string()));
        }
    }

    let agent_id = auth.0.agent_id.clone();
    let agent = state.registry.get(&agent_id).await.ok_or_else(|| {
        (axum::http::StatusCode::SERVICE_UNAVAILABLE, "AGENT_OFFLINE".to_string())
    })?;

    let req_id = format!("{}-{}", agent_id, Uuid::new_v4());
    let start = std::time::Instant::now();
    info!(
        "forward_request start req_id={} op={} agent_id={} project_id={:?}",
        req_id, op, agent_id, project_id
    );
    let response = agent
        .send_request(
            &state.registry.router(),
            req_id.clone(),
            op.to_string(),
            project_id,
            payload,
            REQUEST_TIMEOUT,
        )
        .await
        .map_err(|err| {
            warn!(
                "forward_request failed req_id={} op={} agent_id={} err={}",
                req_id, op, agent_id, err
            );
            match err.as_str() {
                "AGENT_TIMEOUT" => (axum::http::StatusCode::GATEWAY_TIMEOUT, err.to_string()),
                _ => (axum::http::StatusCode::SERVICE_UNAVAILABLE, err.to_string()),
            }
        })?;
    info!(
        "forward_request done req_id={} op={} agent_id={} elapsed_ms={}",
        req_id,
        op,
        agent_id,
        start.elapsed().as_millis()
    );

    match response {
        TunnelMessage::Response {
            ok,
            status,
            payload,
            error,
            ..
        } => {
            if ok {
                Ok(Json(payload.unwrap_or_else(|| json!({}))))
            } else {
                let status = status
                    .and_then(|code| axum::http::StatusCode::from_u16(code).ok())
                    .unwrap_or(axum::http::StatusCode::BAD_GATEWAY);
                Err((status, error.unwrap_or_else(|| "AGENT_ERROR".to_string())))
            }
        }
        _ => Err((
            axum::http::StatusCode::BAD_GATEWAY,
            "INVALID_RESPONSE".to_string(),
        )),
    }
}

fn parse_project_id(project_id: &str) -> Result<i64, (axum::http::StatusCode, String)> {
    project_id
        .parse::<i64>()
        .map_err(|_| (axum::http::StatusCode::BAD_REQUEST, "INVALID_PROJECT_ID".to_string()))
}

fn ensure_project_allowed(
    auth: &AuthSession,
    project_id: &str,
) -> Result<(), (axum::http::StatusCode, String)> {
    if !is_authorized_project(&auth.0.allowed_projects, project_id) {
        return Err((axum::http::StatusCode::FORBIDDEN, "Forbidden".to_string()));
    }
    Ok(())
}

fn is_authorized_project(allowed_projects: &[String], project_id: &str) -> bool {
    if allowed_projects.is_empty() {
        return true;
    }
    allowed_projects.iter().any(|p| p == project_id)
}

fn internal_error(err: String) -> (axum::http::StatusCode, String) {
    (axum::http::StatusCode::INTERNAL_SERVER_ERROR, err)
}

fn map_project_not_found(err: String) -> (axum::http::StatusCode, String) {
    if err == "PROJECT_NOT_FOUND" {
        (axum::http::StatusCode::NOT_FOUND, err)
    } else {
        internal_error(err)
    }
}

fn event_to_sse(event: ServerEvent) -> Event {
    let data = serde_json::to_string(&event).unwrap_or_else(|_| "{}".to_string());
    Event::default().event("project_event").data(data)
}

fn web_ide_event_to_sse(event: WebIdeEvent) -> Event {
    let data = serde_json::to_string(&event).unwrap_or_else(|_| "{}".to_string());
    Event::default().event("web_ide_event").data(data)
}
