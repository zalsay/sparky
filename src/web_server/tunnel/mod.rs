pub mod protocol;
pub mod router;

use std::{collections::HashMap, sync::Arc};

use axum::{
    extract::{State, WebSocketUpgrade},
    response::IntoResponse,
};
use futures_util::{sink::SinkExt, stream::StreamExt};
use tokio::sync::{mpsc, Mutex};
use tracing::{info, warn};

use crate::web_server::{
    config::{AgentTokenConfig, SharedConfig},
    events::EventHub,
    tunnel::{
        protocol::{ClientHello, TunnelMessage},
        router::{AgentHandle, PendingRouter},
    },
    AppState,
};

#[derive(Clone, Default)]
pub struct AgentRegistry {
    inner: Arc<Mutex<HashMap<String, AgentHandle>>>,
    router: PendingRouter,
}

impl AgentRegistry {
    pub fn router(&self) -> PendingRouter {
        self.router.clone()
    }

    pub async fn register(&self, agent_id: String, handle: AgentHandle) {
        self.inner.lock().await.insert(agent_id, handle);
    }

    pub async fn unregister(&self, agent_id: &str) {
        self.inner.lock().await.remove(agent_id);
    }

    pub async fn get(&self, agent_id: &str) -> Option<AgentHandle> {
        self.inner.lock().await.get(agent_id).cloned()
    }
}

#[derive(Clone)]
pub struct TunnelState {
    pub registry: AgentRegistry,
    pub events: EventHub,
    agent_token_map: Arc<HashMap<String, AgentTokenConfig>>,
}

impl TunnelState {
    pub fn new(
        config: SharedConfig,
        registry: AgentRegistry,
        events: EventHub,
    ) -> Self {
        let agent_token_map = Arc::new(config.agent_token_map());
        Self {
            registry,
            events,
            agent_token_map,
        }
    }

    pub fn validate_agent(&self, hello: &ClientHello) -> bool {
        self.agent_token_map
            .get(&hello.agent_id)
            .map(|entry| entry.token == hello.token)
            .unwrap_or(false)
    }
}

pub async fn ws_handler(
    State(state): State<AppState>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let tunnel = state.tunnel.clone();
    ws.on_upgrade(move |socket| handle_socket(tunnel, socket))
}

async fn handle_socket(state: TunnelState, socket: axum::extract::ws::WebSocket) {
    let (mut sender, mut receiver) = socket.split();
    let (tx, mut rx) = mpsc::channel::<TunnelMessage>(64);

    let hello = match receiver.next().await {
        Some(Ok(msg)) => parse_hello(msg),
        _ => None,
    };

    let hello = match hello {
        Some(hello) => hello,
        None => {
            let _ = sender.send(axum::extract::ws::Message::Close(None)).await;
            return;
        }
    };

    if !state.validate_agent(&hello) {
        warn!("agent auth failed agent_id={}", hello.agent_id);
        let _ = sender.send(axum::extract::ws::Message::Close(None)).await;
        return;
    }

    let last_seen = Arc::new(Mutex::new(std::time::Instant::now()));
    let handle = AgentHandle {
        agent_id: hello.agent_id.clone(),
        tx: tx.clone(),
        last_seen: last_seen.clone(),
    };

    state.registry.register(hello.agent_id.clone(), handle).await;
    info!("agent connected agent_id={}", hello.agent_id);
    let agent_id = hello.agent_id.clone();
    let agent_id_for_recv = agent_id.clone();
    let router = state.registry.router();
    let events = state.events.clone();

    let send_task = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            let payload = match serde_json::to_string(&message) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if sender.send(axum::extract::ws::Message::Text(payload)).await.is_err() {
                break;
            }
        }
    });

    let recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            match msg {
                axum::extract::ws::Message::Text(text) => {
                    if let Ok(parsed) = serde_json::from_str::<TunnelMessage>(&text) {
                        handle_incoming(parsed, &router, &events, &agent_id_for_recv).await;
                        let mut last_seen = last_seen.lock().await;
                        *last_seen = std::time::Instant::now();
                    }
                }
                axum::extract::ws::Message::Ping(_) => {
                    let mut last_seen = last_seen.lock().await;
                    *last_seen = std::time::Instant::now();
                }
                axum::extract::ws::Message::Close(_) => break,
                _ => {}
            }
        }
    });

    let _ = tokio::join!(send_task, recv_task);

    state.registry.unregister(&agent_id).await;
    info!("agent disconnected agent_id={}", agent_id);
}

fn parse_hello(msg: axum::extract::ws::Message) -> Option<ClientHello> {
    match msg {
        axum::extract::ws::Message::Text(text) => {
            let parsed: TunnelMessage = serde_json::from_str(&text).ok()?;
            match parsed {
                TunnelMessage::ClientHello(hello) => Some(hello),
                _ => None,
            }
        }
        _ => None,
    }
}

async fn handle_incoming(
    message: TunnelMessage,
    router: &PendingRouter,
    events: &EventHub,
    agent_id: &str,
) {
    match message.clone() {
        TunnelMessage::Response { req_id, .. } => {
            router.resolve(&req_id, message).await;
        }
        TunnelMessage::Event {
            project_id,
            event_type,
            payload,
        } => {
            info!("tunnel event agent_id={} project_id={} event_type={}", agent_id, project_id, event_type);
            events.publish(project_id.clone(), event_type.clone(), payload.clone()).await;
        }
        _ => {}
    }
}
