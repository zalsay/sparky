use axum::extract::ws::{Message, WebSocket};
use futures_util::{sink::SinkExt, stream::StreamExt};
use std::sync::Arc;

use crate::state::AppState;

pub async fn handle_socket(socket: WebSocket, task_id: String, state: Arc<AppState>) {
    let (mut sender, mut receiver) = socket.split();
    
    // Get or create broadcast channel for this task
    let tx = state.get_or_create_channel(&task_id);
    let mut rx = tx.subscribe();

    // Clone sender for broadcasting tasks
    let tx_clone = tx.clone();

    // Spawn task to forward messages from broadcast channel to client
    let forward_task = tokio::spawn(async move {
        while let Ok(msg) = rx.recv().await {
            if sender.send(Message::Text(msg)).await.is_err() {
                break;
            }
        }
    });

    // Handle incoming messages from client
    let task_id_for_recv = task_id.clone();
    let recv_task = tokio::spawn(async move {
        while let Some(msg) = receiver.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    tracing::debug!("Received from {}: {}", task_id_for_recv, text);
                    // Broadcast to all subscribers in the same room
                    let _ = tx_clone.send(text);
                }
                Ok(Message::Close(_)) => {
                    tracing::info!("Client closed connection for task_id: {}", task_id_for_recv);
                    break;
                }
                Err(_) => {
                    tracing::error!("Error receiving message for task_id: {}", task_id_for_recv);
                    break;
                }
                _ => {}
            }
        }
    });

    // Wait for either task to complete
    tokio::select! {
        _ = forward_task => {}
        _ = recv_task => {}
    }

    // Check if room is empty and remove if so
    state.remove_room(&task_id);
    tracing::info!("Connection closed for task_id: {}", task_id);
}
