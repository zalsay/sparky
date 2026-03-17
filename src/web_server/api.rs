use std::time::Duration;

use axum::{
    extract::{Path, Query, State},
    response::{sse::Event, Sse},
    Json,
};
use serde::Deserialize;
use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio_stream::wrappers::BroadcastStream;
use tracing::{info, warn};
use uuid::Uuid;

use crate::web_server::{
    auth::AuthSession,
    events::ServerEvent,
    tunnel::protocol::TunnelMessage,
    AppState,
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

pub fn api_routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/api/projects", axum::routing::get(list_projects))
        .route("/api/projects/:id/detail", axum::routing::get(project_detail))
        .route("/api/sessions", axum::routing::get(list_sessions))
        .route("/api/terminal/history", axum::routing::get(terminal_history))
        .route("/api/terminal/exec", axum::routing::post(exec_terminal))
        .route("/api/sessions/:id/rename", axum::routing::post(rename_session))
        .route("/api/sessions/:id/delete", axum::routing::post(delete_session))
        .route("/api/sessions/:id/resume", axum::routing::post(resume_session))
        .route("/api/events", axum::routing::get(event_stream))
}

async fn list_projects(
    State(state): State<AppState>,
    auth: AuthSession,
) -> Result<Json<Value>, (axum::http::StatusCode, String)> {
    forward_request(state, auth, "projects.list", None, json!({})).await
}

async fn project_detail(
    State(state): State<AppState>,
    auth: AuthSession,
    Path(id): Path<String>,
) -> Result<Json<Value>, (axum::http::StatusCode, String)> {
    forward_request(state, auth, "projects.detail", Some(id), json!({})).await
}

#[derive(Deserialize)]
struct ProjectQuery {
    project_id: String,
}

async fn list_sessions(
    State(state): State<AppState>,
    auth: AuthSession,
    Query(query): Query<ProjectQuery>,
) -> Result<Json<Value>, (axum::http::StatusCode, String)> {
    forward_request(
        state,
        auth,
        "sessions.list",
        Some(query.project_id),
        json!({}),
    )
    .await
}

async fn terminal_history(
    State(state): State<AppState>,
    auth: AuthSession,
    Query(query): Query<ProjectQuery>,
) -> Result<Json<Value>, (axum::http::StatusCode, String)> {
    forward_request(
        state,
        auth,
        "terminal.history",
        Some(query.project_id),
        json!({}),
    )
    .await
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
    State(state): State<AppState>,
    auth: AuthSession,
    Path(id): Path<String>,
    Json(payload): Json<RenamePayload>,
) -> Result<Json<Value>, (axum::http::StatusCode, String)> {
    info!("audit session rename session_id={} project_id={}", id, payload.project_id);
    forward_request(
        state,
        auth,
        "sessions.rename",
        Some(payload.project_id),
        json!({ "session_id": id, "name": payload.name }),
    )
    .await
}

#[derive(Deserialize)]
struct SessionPayload {
    project_id: String,
}

async fn delete_session(
    State(state): State<AppState>,
    auth: AuthSession,
    Path(id): Path<String>,
    Json(payload): Json<SessionPayload>,
) -> Result<Json<Value>, (axum::http::StatusCode, String)> {
    info!("audit session delete session_id={} project_id={}", id, payload.project_id);
    forward_request(
        state,
        auth,
        "sessions.delete",
        Some(payload.project_id),
        json!({ "session_id": id }),
    )
    .await
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

async fn event_stream(
    State(state): State<AppState>,
    auth: AuthSession,
    Query(query): Query<ProjectQuery>,
) -> Result<Sse<impl tokio_stream::Stream<Item = Result<Event, axum::Error>>>, (axum::http::StatusCode, String)> {
    if !is_authorized_project(&auth.0.allowed_projects, &query.project_id) {
        return Err((axum::http::StatusCode::FORBIDDEN, "Forbidden".to_string()));
    }

    let receiver = state.events.subscribe(&query.project_id).await;
    let stream = BroadcastStream::new(receiver).filter_map(|message| {
        async move {
            match message {
                Ok(event) => Some(Ok(event_to_sse(event))),
                Err(_) => None,
            }
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
        req_id,
        op,
        agent_id,
        project_id
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
                req_id,
                op,
                agent_id,
                err
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

fn is_authorized_project(allowed_projects: &[String], project_id: &str) -> bool {
    if allowed_projects.is_empty() {
        return true;
    }
    allowed_projects.iter().any(|p| p == project_id)
}

fn event_to_sse(event: ServerEvent) -> Event {
    let data = serde_json::to_string(&event).unwrap_or_else(|_| "{}".to_string());
    Event::default().event("project_event").data(data)
}

