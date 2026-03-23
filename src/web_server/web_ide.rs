use std::{collections::HashMap, sync::Arc};

use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, Mutex};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebIdeProjectStatus {
    pub project_id: String,
    pub project_path: String,
    pub project_name: String,
    pub active_pty_count: u32,
    #[serde(default)]
    pub agent_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebIdeEvent {
    pub event_type: String,
    pub agent_id: String,
    pub project: Option<WebIdeProjectStatus>,
}

#[derive(Clone, Default)]
pub struct WebIdeState {
    inner: Arc<Mutex<HashMap<String, HashMap<String, WebIdeProjectStatus>>>>,
}

impl WebIdeState {
    pub async fn upsert_project(&self, status: WebIdeProjectStatus) {
        let mut guard = self.inner.lock().await;
        let projects = guard.entry(status.agent_id.clone()).or_default();
        if status.active_pty_count == 0 {
            projects.remove(&status.project_id);
            if projects.is_empty() {
                guard.remove(&status.agent_id);
            }
            return;
        }
        projects.insert(status.project_id.clone(), status);
    }

    pub async fn remove_agent(&self, agent_id: &str) {
        let mut guard = self.inner.lock().await;
        guard.remove(agent_id);
    }

    pub async fn summary_for_agent(&self, agent_id: &str, allowed_projects: &[String]) -> Vec<WebIdeProjectStatus> {
        let guard = self.inner.lock().await;
        let Some(projects) = guard.get(agent_id) else {
            return Vec::new();
        };
        projects
            .values()
            .filter(|status| {
                if allowed_projects.is_empty() {
                    return true;
                }
                allowed_projects.iter().any(|p| p == &status.project_id)
            })
            .cloned()
            .collect()
    }
}

#[derive(Clone)]
pub struct WebIdeEventHub {
    sender: broadcast::Sender<WebIdeEvent>,
}

impl Default for WebIdeEventHub {
    fn default() -> Self {
        let (sender, _rx) = broadcast::channel(256);
        Self { sender }
    }
}

impl WebIdeEventHub {
    pub async fn publish(&self, event: WebIdeEvent) {
        let _ = self.sender.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<WebIdeEvent> {
        self.sender.subscribe()
    }
}
