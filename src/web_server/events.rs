use std::{collections::HashMap, sync::Arc};

use serde::Serialize;
use serde_json::Value;
use tokio::sync::{broadcast, Mutex};

#[derive(Debug, Clone, Serialize)]
pub struct ServerEvent {
    pub project_id: String,
    pub event_type: String,
    pub payload: Value,
}

#[derive(Clone, Default)]
pub struct EventHub {
    inner: Arc<Mutex<HashMap<String, broadcast::Sender<ServerEvent>>>>,
}

impl EventHub {
    pub async fn publish(&self, project_id: String, event_type: String, payload: Value) {
        let sender = self.ensure_channel(&project_id).await;
        let _ = sender.send(ServerEvent {
            project_id,
            event_type,
            payload,
        });
    }

    pub async fn subscribe(&self, project_id: &str) -> broadcast::Receiver<ServerEvent> {
        let sender = self.ensure_channel(project_id).await;
        sender.subscribe()
    }

    async fn ensure_channel(&self, project_id: &str) -> broadcast::Sender<ServerEvent> {
        let mut guard = self.inner.lock().await;
        if let Some(sender) = guard.get(project_id) {
            return sender.clone();
        }
        let (sender, _rx) = broadcast::channel(256);
        guard.insert(project_id.to_string(), sender.clone());
        sender
    }
}
