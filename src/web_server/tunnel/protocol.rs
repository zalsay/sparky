use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientHello {
    pub agent_id: String,
    pub token: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TunnelMessage {
    ClientHello(ClientHello),
    Request {
        req_id: String,
        op: String,
        project_id: Option<String>,
        payload: Value,
    },
    Response {
        req_id: String,
        ok: bool,
        status: Option<u16>,
        payload: Option<Value>,
        error: Option<String>,
    },
    Event {
        project_id: String,
        event_type: String,
        payload: Value,
    },
}
