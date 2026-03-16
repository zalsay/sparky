use std::{collections::HashMap, sync::Arc, time::Duration};

use serde_json::Value;
use tokio::{
    sync::{mpsc, oneshot, Mutex},
    time::timeout,
};

use super::protocol::TunnelMessage;

#[derive(Clone, Default)]
pub struct PendingRouter {
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<TunnelMessage>>>>,
}

impl PendingRouter {
    pub fn new() -> Self {
        Self {
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn register(&self, req_id: String) -> oneshot::Receiver<TunnelMessage> {
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(req_id, tx);
        rx
    }

    pub async fn resolve(&self, req_id: &str, message: TunnelMessage) {
        if let Some(tx) = self.pending.lock().await.remove(req_id) {
            let _ = tx.send(message);
        }
    }

    pub async fn remove(&self, req_id: &str) {
        self.pending.lock().await.remove(req_id);
    }
}

#[derive(Clone)]
pub struct AgentHandle {
    pub agent_id: String,
    pub tx: mpsc::Sender<TunnelMessage>,
    pub last_seen: Arc<Mutex<std::time::Instant>>,
}

impl AgentHandle {
    pub async fn send_request(
        &self,
        router: &PendingRouter,
        req_id: String,
        op: String,
        project_id: Option<String>,
        payload: Value,
        timeout_duration: Duration,
    ) -> Result<TunnelMessage, String> {
        let receiver = router.register(req_id.clone()).await;
        let message = TunnelMessage::Request {
            req_id: req_id.clone(),
            op,
            project_id,
            payload,
        };

        if self.tx.send(message).await.is_err() {
            router.remove(&req_id).await;
            return Err("AGENT_OFFLINE".to_string());
        }

        let response = match timeout(timeout_duration, receiver).await {
            Ok(Ok(message)) => message,
            Ok(Err(_)) => {
                router.remove(&req_id).await;
                return Err("AGENT_OFFLINE".to_string());
            }
            Err(_) => {
                router.remove(&req_id).await;
                return Err("AGENT_TIMEOUT".to_string());
            }
        };

        Ok(response)
    }
}
