use std::{collections::HashMap, sync::Arc};

use axum::{
    extract::{FromRequestParts, Request, State},
    http::{request::Parts, HeaderMap, StatusCode},
    middleware::Next,
    response::Response,
};
use tracing::warn;

use crate::web_server::{
    config::{ApiTokenConfig, SharedConfig},
    AppState,
};

#[derive(Clone, Debug)]
pub struct AuthContext {
    pub agent_id: String,
    pub allowed_projects: Vec<String>,
}

#[derive(Clone)]
pub struct AuthState {
    token_map: Arc<HashMap<String, ApiTokenConfig>>,
}

impl AuthState {
    pub fn new(config: SharedConfig) -> Self {
        Self {
            token_map: Arc::new(config.api_token_map()),
        }
    }

    pub fn resolve(&self, token: &str) -> Option<AuthContext> {
        self.token_map.get(token).map(|entry| AuthContext {
            agent_id: entry.agent_id.clone(),
            allowed_projects: entry.allowed_projects.clone(),
        })
    }
}

#[derive(Clone, Debug)]
pub struct AuthSession(pub AuthContext);

#[axum::async_trait]
impl FromRequestParts<AppState> for AuthSession {
    type Rejection = (StatusCode, String);

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        if let Some(ctx) = parts.extensions.get::<AuthContext>().cloned() {
            return Ok(AuthSession(ctx));
        }

        let headers = &parts.headers;
        let token = extract_token(headers).ok_or_else(|| {
            (StatusCode::UNAUTHORIZED, "Missing auth token".to_string())
        })?;

        match state.auth.resolve(&token) {
            Some(ctx) => Ok(AuthSession(ctx)),
            None => Err((StatusCode::UNAUTHORIZED, "Invalid auth token".to_string())),
        }
    }
}

pub async fn auth_guard(
    State(state): State<Arc<AuthState>>,
    mut request: Request,
    next: Next,
) -> Result<Response, (StatusCode, String)> {
    let path = request.uri().path();
    if path == "/health" || path == "/tunnel/ws" {
        return Ok(next.run(request).await);
    }

    let headers = request.headers();
    let token = extract_token(headers).ok_or_else(|| {
        (StatusCode::UNAUTHORIZED, "Missing auth token".to_string())
    })?;

    let ctx = match state.resolve(&token) {
        Some(ctx) => ctx,
        None => {
            warn!("auth failed for request path={}", path);
            return Err((StatusCode::UNAUTHORIZED, "Invalid auth token".to_string()));
        }
    };

    request.extensions_mut().insert(ctx);
    Ok(next.run(request).await)
}

fn extract_token(headers: &HeaderMap) -> Option<String> {
    if let Some(value) = headers.get("x-api-key").and_then(|v| v.to_str().ok()) {
        let token = value.trim();
        if !token.is_empty() {
            return Some(token.to_string());
        }
    }

    if let Some(value) = headers.get("authorization").and_then(|v| v.to_str().ok()) {
        let raw = value.trim();
        if let Some((scheme, token)) = raw.split_once(' ') {
            if scheme.eq_ignore_ascii_case("bearer") {
                let token = token.trim();
                if !token.is_empty() {
                    return Some(token.to_string());
                }
            }
        }
    }

    None
}
