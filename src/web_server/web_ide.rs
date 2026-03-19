use std::{collections::HashMap, sync::Arc};

use tokio::sync::{broadcast, Mutex};

use crate::storage::models::WebIdeProjectStatus;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WebIdeEvent {
    pub event_type: String,
    pub agent_id: String,
    pub project: Option<WebIdeProjectStatus>,
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

#[derive(Clone, Default)]
pub struct WebIdeState {
    inner: Arc<Mutex<HashMap<String, HashMap<String, WebIdeProjectStatus>>>>,
}

impl WebIdeState {
    pub async fn upsert_project(&self, status: WebIdeProjectStatus) {
        let mut guard = self.inner.lock().await;
        let agent_projects = guard.entry(status.agent_id.clone()).or_default();
        agent_projects.insert(status.project_id.clone(), status);
    }

    pub async fn remove_agent(&self, agent_id: &str) {
        let mut guard = self.inner.lock().await;
        guard.remove(agent_id);
    }

    pub async fn summary_for_agent(
        &self,
        agent_id: &str,
        allowed_projects: &[String],
    ) -> Vec<WebIdeProjectStatus> {
        let guard = self.inner.lock().await;
        let projects: Vec<WebIdeProjectStatus> = match guard.get(agent_id) {
            Some(map) => map.values().cloned().collect(),
            None => Vec::new(),
        };

        if allowed_projects.is_empty() {
            return projects;
        }

        projects
            .into_iter()
            .filter(|project| allowed_projects.iter().any(|id| id == &project.project_id))
            .collect()
    }
}
