use axum::{
    extract::ws::WebSocketUpgrade,
    response::Response,
    routing::get,
    Router,
};
use std::sync::Arc;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

mod handler;
mod state;

#[derive(Clone, serde::Serialize, serde::Deserialize, Debug)]
pub struct MessagePayload {
    pub sender: String,
    pub task_id: String,
    pub msg_type: String,
    pub action: Option<String>,
    pub data: serde_json::Value,
}

#[tokio::main]
async fn main() {
    // Parse command line arguments
    let args: Vec<String> = std::env::args().collect();
    let port = args
        .iter()
        .position(|arg| arg == "--port")
        .and_then(|i| args.get(i + 1))
        .map(|p| p.parse::<u16>().unwrap_or(8005))
        .unwrap_or(8005);

    tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer())
        .init();

    let state = Arc::new(state::AppState::new());

    let app = Router::new()
        .route("/ws/:task_id", get(ws_handler))
        .with_state(state);

    let addr = format!("0.0.0.0:{}", port);
    tracing::info!("Relay server starting on {}", addr);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn ws_handler(ws: WebSocketUpgrade, axum::extract::Path(task_id): axum::extract::Path<String>, state: axum::extract::State<Arc<state::AppState>>) -> Response {
    tracing::info!("New WebSocket connection for task_id: {}", task_id);
    
    ws.on_upgrade(move |socket| handler::handle_socket(socket, task_id, state.0.clone()))
}
