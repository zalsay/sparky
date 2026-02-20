use std::collections::HashMap;
use tokio::sync::broadcast;
use parking_lot::RwLock;

pub struct AppState {
    pub rooms: RwLock<HashMap<String, broadcast::Sender<String>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            rooms: RwLock::new(HashMap::new()),
        }
    }

    pub fn get_or_create_channel(&self, task_id: &str) -> broadcast::Sender<String> {
        let mut rooms = self.rooms.write();
        if let Some(sender) = rooms.get(task_id) {
            return sender.clone();
        }
        
        let (sender, _) = broadcast::channel(1000);
        rooms.insert(task_id.to_string(), sender.clone());
        tracing::info!("Created new room for task_id: {}", task_id);
        sender
    }

    pub fn remove_room(&self, task_id: &str) {
        let mut rooms = self.rooms.write();
        if rooms.remove(task_id).is_some() {
            tracing::info!("Removed room for task_id: {}", task_id);
        }
    }
}
