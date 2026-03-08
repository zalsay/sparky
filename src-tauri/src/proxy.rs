use axum::{
    body::Body,
    extract::{Path, Request, State},
    http::{HeaderMap, Method, StatusCode},
    middleware::{self, Next},
    response::Response as AxumResponse,
    routing::{any, get},
    Router,
};
use reqwest::Client;
use std::sync::Arc;

use crate::pty::PtyManager;

#[derive(Clone)]
pub struct ProxyState {
    pub pty_manager: Arc<PtyManager>,
    pub http_client: Client,
}

pub async fn start_proxy_server(state: ProxyState) -> Result<u16, String> {
    let app = Router::new()
        .route(
            "/health",
            get(|| async {
                log::info!("[PROXY] Health check hit");
                "OK"
            }),
        )
        .route("/pty/*full_path", any(proxy_handler_with_path_terminal))
        .route("/*full_path", any(proxy_handler_with_header_terminal))
        .fallback(any(
            |method: Method, uri: axum::http::Uri, headers: HeaderMap| async move {
                log::warn!(
                    "[PROXY] [CATCH-ALL] Unmatched request: {} {} headers={:?}",
                    method,
                    uri,
                    headers
                );
                (StatusCode::NOT_FOUND, "Not Found")
            },
        ))
        .layer(middleware::from_fn(log_request))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind proxy server: {}", e))?;

    let port = listener.local_addr().unwrap().port();
    log::info!("[PROXY] Proxy server listening on 127.0.0.1:{}", port);

    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            log::error!("[PROXY] Server exited unexpectedly: {}", e);
        }
    });

    Ok(port)
}

async fn log_request(req: Request, next: Next) -> AxumResponse {
    log::info!("[PROXY] Incoming request: {} {}", req.method(), req.uri());
    next.run(req).await
}

async fn proxy_handler_with_path_terminal(
    State(state): State<ProxyState>,
    Path(full_path): Path<String>,
    method: Method,
    headers: HeaderMap,
    body: Body,
) -> Result<AxumResponse, (StatusCode, String)> {
    let (terminal_id, remote_path) = match full_path.split_once('/') {
        Some((t, r)) if !t.is_empty() => (t.to_string(), normalize_remote_path(r)),
        _ => {
            log::warn!("[PROXY] Invalid /pty route path: {}", full_path);
            return Err((
                StatusCode::BAD_REQUEST,
                "Missing terminal ID in /pty path".to_string(),
            ));
        }
    };

    log::info!(
        "[PROXY] Route mode=path terminal_id={} remote_path={} method={}",
        terminal_id,
        remote_path,
        method
    );

    proxy_core(
        state,
        terminal_id,
        remote_path,
        method,
        headers,
        body,
        "path",
    )
    .await
}

async fn proxy_handler_with_header_terminal(
    State(state): State<ProxyState>,
    Path(full_path): Path<String>,
    method: Method,
    headers: HeaderMap,
    body: Body,
) -> Result<AxumResponse, (StatusCode, String)> {
    let remote_path = normalize_remote_path(&full_path);

    let terminal_id = extract_terminal_id(&headers).ok_or_else(|| {
        log::warn!(
            "[PROXY] Missing terminal identifier for path={} headers={:?}",
            full_path,
            headers
        );
        (
            StatusCode::BAD_REQUEST,
            "Missing terminal ID (expected x-sparky-terminal-id or bearer token)".to_string(),
        )
    })?;

    log::info!(
        "[PROXY] Route mode=header terminal_id={} remote_path={} method={}",
        terminal_id,
        remote_path,
        method
    );

    proxy_core(
        state,
        terminal_id,
        remote_path,
        method,
        headers,
        body,
        "header",
    )
    .await
}

fn normalize_remote_path(path: &str) -> String {
    path.trim_start_matches('/').to_string()
}

fn extract_terminal_id(headers: &HeaderMap) -> Option<String> {
    let from_terminal_header = headers
        .get("x-sparky-terminal-id")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    if from_terminal_header.is_some() {
        return from_terminal_header;
    }

    let token_from_auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(extract_terminal_id_from_bearer);

    if token_from_auth.is_some() {
        return token_from_auth;
    }

    headers
        .get("x-api-key")
        .and_then(|v| v.to_str().ok())
        .and_then(extract_terminal_id_from_token)
}

fn extract_terminal_id_from_bearer(auth: &str) -> Option<String> {
    let (scheme, token) = auth.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    extract_terminal_id_from_token(token.trim())
}

fn extract_terminal_id_from_token(token: &str) -> Option<String> {
    let prefix = "sparky-tid-";
    token
        .strip_prefix(prefix)
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn resolve_provider(state: &ProxyState, terminal_id: &str) -> Result<crate::AIProvider, (StatusCode, String)> {
    let assigned_provider = state.pty_manager.get_terminal_provider(terminal_id);
    log::info!(
        "[PROXY] Resolve provider terminal={} assigned={:?}",
        terminal_id,
        assigned_provider
    );

    if let Some(provider_id) = assigned_provider.clone() {
        if let Some(provider) = state.pty_manager.get_provider_details(&provider_id) {
            log::info!(
                "[PROXY] Provider resolved by id: terminal={} provider_id={} app_type={}",
                terminal_id,
                provider.id,
                provider.app_type
            );
            return Ok(provider);
        }

        log::warn!(
            "[PROXY] Provider id lookup failed: terminal={} provider_id={}",
            terminal_id,
            provider_id
        );

        let normalized = provider_id.split("::").last().unwrap_or(&provider_id);
        if normalized.eq_ignore_ascii_case("claude") {
            if let Some(provider) = state.pty_manager.get_provider_details_by_app_type("claude") {
                log::warn!(
                    "[PROXY] Fallback to app_type=claude succeeded: terminal={} provider_id={} fallback_id={}",
                    terminal_id,
                    provider_id,
                    provider.id
                );
                return Ok(provider);
            }
        }
    }

    if let Some(provider) = state.pty_manager.get_provider_details_by_app_type("claude") {
        log::warn!(
            "[PROXY] Using global fallback provider app_type=claude: terminal={} fallback_id={}",
            terminal_id,
            provider.id
        );
        return Ok(provider);
    }

    Err((
        StatusCode::NOT_FOUND,
        format!("No provider available for terminal {}", terminal_id),
    ))
}

async fn proxy_core(
    state: ProxyState,
    terminal_id: String,
    remote_path: String,
    method: Method,
    headers: HeaderMap,
    body: Body,
    route_mode: &'static str,
) -> Result<AxumResponse, (StatusCode, String)> {
    if remote_path.is_empty() {
        log::warn!(
            "[PROXY] Empty remote path terminal={} mode={}",
            terminal_id,
            route_mode
        );
    }

    let provider = resolve_provider(&state, &terminal_id)?;

    let settings: serde_json::Value = serde_json::from_str(&provider.settings_config).map_err(|e| {
        log::error!(
            "[PROXY] Invalid provider settings JSON terminal={} provider_id={} err={}",
            terminal_id,
            provider.id,
            e
        );
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Invalid provider config: {}", e),
        )
    })?;

    // settings_config.base_url 是用户配置的正确 URL，endpoints 可能过时，仅作 fallback
    let upstream_url_base = settings
        .get("base_url")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| provider.endpoints.first().map(|e| e.url.clone()))
        .ok_or_else(|| {
            log::error!(
                "[PROXY] No base_url/endpoint terminal={} provider_id={} provider_name={}",
                terminal_id,
                provider.id,
                provider.name
            );
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "No upstream URL configured".to_string(),
            )
        })?;

    let upstream_url = format!(
        "{}/{}",
        upstream_url_base.trim_end_matches('/'),
        remote_path.trim_start_matches('/')
    );

    log::info!(
        "[PROXY] Forward start terminal={} mode={} provider={}({}) method={} upstream={}",
        terminal_id,
        route_mode,
        provider.id,
        provider.app_type,
        method,
        upstream_url
    );

    let mut request_builder = state.http_client.request(method.clone(), &upstream_url);

    for (key, value) in headers.iter() {
        if key == "host" || key == "authorization" || key == "x-api-key" {
            continue;
        }
        request_builder = request_builder.header(key, value);
    }

    let api_key = settings
        .get("api_key")
        .or_else(|| settings.get("env").and_then(|v| v.get("ANTHROPIC_API_KEY")))
        .or_else(|| settings.get("env").and_then(|v| v.get("ANTHROPIC_AUTH_TOKEN")))
        .or_else(|| settings.get("auth").and_then(|v| v.get("OPENAI_API_KEY")))
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            log::error!(
                "[PROXY] Missing api_key in settings terminal={} provider_id={}",
                terminal_id,
                provider.id
            );
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "API Key not found in provider config".to_string(),
            )
        })?;

    if provider.app_type == "claude" {
        request_builder = request_builder.header("x-api-key", api_key);
        request_builder = request_builder.header("anthropic-version", "2023-06-01");
    } else {
        request_builder = request_builder.header("authorization", format!("Bearer {}", api_key));
    }

    let request_body = reqwest::Body::wrap_stream(body.into_data_stream());
    request_builder = request_builder.body(request_body);

    let resp = request_builder.send().await.map_err(|e| {
        log::error!(
            "[PROXY] Upstream request failed terminal={} provider_id={} method={} upstream={} err={}",
            terminal_id,
            provider.id,
            method,
            upstream_url,
            e
        );
        (StatusCode::BAD_GATEWAY, format!("Upstream request failed: {}", e))
    })?;

    let status = resp.status();
    log::info!(
        "[PROXY] Forward done terminal={} provider={} method={} status={} upstream={}",
        terminal_id,
        provider.id,
        method,
        status,
        upstream_url
    );

    let mut response_builder = AxumResponse::builder().status(status);
    for (key, value) in resp.headers().iter() {
        response_builder = response_builder.header(key, value);
    }

    let full_response = response_builder
        .body(Body::from_stream(resp.bytes_stream()))
        .map_err(|e| {
            log::error!(
                "[PROXY] Build response failed terminal={} method={} upstream={} err={}",
                terminal_id,
                method,
                upstream_url,
                e
            );
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to build response: {}", e),
            )
        })?;

    Ok(full_response)
}
