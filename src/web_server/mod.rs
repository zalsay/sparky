pub mod api;
pub mod auth;
pub mod config;
pub mod events;
pub mod tunnel;

use std::{net::SocketAddr, sync::Arc};

use axum::{
    middleware,
    routing::get,
    Router,
};
use tokio::net::TcpListener;
use tower_http::trace::TraceLayer;
use tracing::info;

use crate::web_server::{
    api::api_routes,
    auth::{auth_guard, AuthState},
    config::WebServerConfig,
    events::EventHub,
    tunnel::{AgentRegistry, TunnelState},
};

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<WebServerConfig>,
    pub auth: Arc<AuthState>,
    pub registry: AgentRegistry,
    pub events: EventHub,
    pub tunnel: TunnelState,
}

pub async fn start_server(config: WebServerConfig) -> Result<(), anyhow::Error> {
    let bind = config.bind.clone();
    let config = Arc::new(config);
    let registry = AgentRegistry::default();
    let events = EventHub::default();
    let auth_state = Arc::new(AuthState::new(config.clone()));
    let tunnel_state = TunnelState::new(config.clone(), registry.clone(), events.clone());

    let state = AppState {
        config: config.clone(),
        auth: auth_state.clone(),
        registry: registry.clone(),
        events: events.clone(),
        tunnel: tunnel_state,
    };

    let api = api_routes().route_layer(middleware::from_fn_with_state(auth_state, auth_guard));

    let app = Router::new()
        .route("/health", get(|| async { "OK" }))
        .route("/tunnel/ws", get(crate::web_server::tunnel::ws_handler))
        .merge(api)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = TcpListener::bind(bind).await?;
    let addr: SocketAddr = listener.local_addr()?;
    info!(
        "web server starting addr={} api_tokens={} agent_tokens={}",
        addr,
        config.api_tokens.len(),
        config.agent_tokens.len()
    );

    axum::serve(listener, app).await?;
    Ok(())
}
