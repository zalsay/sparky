use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use flate2::read::GzDecoder;
use prost::Message;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use std::io::Read;
use tokio::sync::Mutex;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message as WsMessage};
use tokio_tungstenite::MaybeTlsStream;
use tokio::net::TcpStream;
use futures_util::stream::SplitSink;

// 包含由 prost 生成的 protobuf 代码
pub mod proto {
    include!(concat!(env!("OUT_DIR"), "/pbbp2.rs"));
}

use proto::{Frame, Header};

const FEISHU_DOMAIN: &str = "https://open.feishu.cn";
const GEN_ENDPOINT_URI: &str = "/callback/ws/endpoint";

// Frame method 类型
const FRAME_METHOD_CONTROL: i32 = 1;
const FRAME_METHOD_DATA: i32 = 2;

// Header keys
const HEADER_TYPE: &str = "type";
const HEADER_MESSAGE_ID: &str = "message_id";
const HEADER_SUM: &str = "sum";
const HEADER_SEQ: &str = "seq";
const HEADER_TRACE_ID: &str = "trace_id";

// Message types
const MSG_TYPE_PING: &str = "ping";
const MSG_TYPE_PONG: &str = "pong";
const MSG_TYPE_EVENT: &str = "event";
const MSG_TYPE_ACK: &str = "ack";

type WsWrite = SplitSink<tokio_tungstenite::WebSocketStream<MaybeTlsStream<TcpStream>>, WsMessage>;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EndpointResponse {
    code: i32,
    msg: Option<String>,
    data: Option<EndpointData>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EndpointData {
    #[serde(rename = "URL")]
    url: String,
    #[serde(rename = "ClientConfig")]
    client_config: Option<ClientConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ClientConfig {
    #[serde(rename = "ReconnectCount")]
    reconnect_count: Option<i32>,
    #[serde(rename = "ReconnectInterval")]
    reconnect_interval: Option<i32>,
    #[serde(rename = "PingInterval")]
    ping_interval: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventPayload {
    pub schema: String,
    pub header: EventHeader,
    pub event: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventHeader {
    pub event_id: String,
    pub event_type: String,
    pub create_time: String,
    pub token: String,
    pub app_id: String,
    pub tenant_key: String,
}

pub struct FeishuWsClient {
    app_id: String,
    app_secret: String,
    connected: Arc<AtomicBool>,
    ping_interval_secs: Arc<AtomicU64>,
}

impl FeishuWsClient {
    pub fn new(app_id: String, app_secret: String) -> Self {
        FeishuWsClient {
            app_id,
            app_secret,
            connected: Arc::new(AtomicBool::new(false)),
            ping_interval_secs: Arc::new(AtomicU64::new(30)),
        }
    }

    async fn get_ws_url(&self) -> Result<String> {
        let client = reqwest::Client::new();
        let url = format!("{}{}", FEISHU_DOMAIN, GEN_ENDPOINT_URI);

        let response = client
            .post(&url)
            .header("locale", "zh")
            .json(&serde_json::json!({
                "AppID": self.app_id,
                "AppSecret": self.app_secret,
            }))
            .send()
            .await?;

        let resp: EndpointResponse = response.json().await?;

        if resp.code != 0 {
            anyhow::bail!("Failed to get WebSocket URL: code={}, msg={:?}", resp.code, resp.msg);
        }

        let data = resp.data.ok_or_else(|| anyhow::anyhow!("No data in response"))?;
        tracing::info!("Got WebSocket URL: {}", data.url);

        // 更新 ping 间隔
        if let Some(config) = data.client_config {
            if let Some(interval) = config.ping_interval {
                self.ping_interval_secs.store(interval as u64, Ordering::Relaxed);
            }
        }

        Ok(data.url)
    }

    pub async fn connect(&self) -> Result<()> {
        // 获取 WebSocket URL
        let ws_url = self.get_ws_url().await?;
        tracing::info!("Connecting to Feishu WebSocket...");

        let (ws_stream, _) = connect_async(&ws_url).await?;
        tracing::info!("WebSocket connected successfully");

        let (write, mut read) = ws_stream.split();
        let write = Arc::new(Mutex::new(write));
        self.connected.store(true, Ordering::SeqCst);

        // 心跳任务
        let connected = self.connected.clone();
        let ping_interval_secs = self.ping_interval_secs.clone();
        let heartbeat_write = write.clone();
        let heartbeat_handle = tokio::spawn(async move {
            loop {
                let interval_secs = ping_interval_secs.load(Ordering::Relaxed);
                tokio::time::sleep(Duration::from_secs(interval_secs)).await;
                if !connected.load(Ordering::SeqCst) {
                    break;
                }
                // 发送 ping 帧
                let ping_frame = Self::create_ping_frame(0);
                let mut buf = Vec::new();
                if ping_frame.encode(&mut buf).is_ok() {
                    let mut locked = heartbeat_write.lock().await;
                    if locked.send(WsMessage::Binary(buf.into())).await.is_err() {
                        tracing::error!("Failed to send heartbeat");
                        break;
                    }
                    tracing::debug!("Ping sent");
                }
            }
        });

        // 接收消息循环
        while let Some(msg) = read.next().await {
            match msg {
                Ok(WsMessage::Binary(data)) => {
                    if let Err(e) = self.handle_message(&data, &write).await {
                        tracing::error!("Error handling message: {}", e);
                    }
                }
                Ok(WsMessage::Ping(_)) => {
                    tracing::debug!("Received ping");
                }
                Ok(WsMessage::Pong(_)) => {
                    tracing::debug!("Received pong");
                }
                Ok(WsMessage::Close(_)) => {
                    tracing::info!("WebSocket closed by server");
                    self.connected.store(false, Ordering::SeqCst);
                    break;
                }
                Err(e) => {
                    tracing::error!("WebSocket error: {}", e);
                    self.connected.store(false, Ordering::SeqCst);
                    break;
                }
                _ => {}
            }
        }

        heartbeat_handle.abort();
        self.connected.store(false, Ordering::SeqCst);
        tracing::info!("WebSocket disconnected");

        Ok(())
    }

    fn create_ping_frame(service_id: i32) -> Frame {
        let header = Header {
            key: HEADER_TYPE.to_string(),
            value: MSG_TYPE_PING.to_string(),
        };
        Frame {
            seq_id: 0,
            log_id: 0,
            service: service_id,
            method: FRAME_METHOD_CONTROL,
            headers: vec![header],
            payload_encoding: None,
            payload_type: None,
            payload: None,
            log_id_new: None,
        }
    }

    fn get_header_value(frame: &Frame, key: &str) -> Option<String> {
        frame.headers.iter().find(|h| h.key == key).map(|h| h.value.clone())
    }

    async fn handle_message(&self, data: &[u8], write: &Arc<Mutex<WsWrite>>) -> Result<()> {
        let frame = Frame::decode(data)?;
        let method = frame.method;
        let msg_type = Self::get_header_value(&frame, HEADER_TYPE);
        let payload_len = frame.payload.as_ref().map(|payload| payload.len()).unwrap_or(0);
        let payload_encoding = frame.payload_encoding.as_deref().unwrap_or("none");
        let payload_type = frame.payload_type.as_deref().unwrap_or("none");

        tracing::debug!(
            "Frame received: method={}, type={:?}, seq_id={}, log_id={}, service={}, payload_len={}, encoding={}, payload_type={}, headers={:?}",
            method,
            msg_type,
            frame.seq_id,
            frame.log_id,
            frame.service,
            payload_len,
            payload_encoding,
            payload_type,
            frame.headers
        );

        if matches!(msg_type.as_deref(), Some(MSG_TYPE_EVENT)) {
            self.handle_data_frame(&frame, write).await?;
            return Ok(());
        }

        match method {
            FRAME_METHOD_CONTROL => {
                self.handle_control_frame(&frame, write).await?;
            }
            FRAME_METHOD_DATA => {
                self.handle_data_frame(&frame, write).await?;
            }
            _ => {
                tracing::debug!("Unknown frame method: {}", method);
            }
        }

        Ok(())
    }

    async fn handle_control_frame(&self, frame: &Frame, write: &Arc<Mutex<WsWrite>>) -> Result<()> {
        let msg_type = Self::get_header_value(frame, HEADER_TYPE);
        
        match msg_type.as_deref() {
            Some(MSG_TYPE_PING) => {
                tracing::debug!("Received ping");
                self.send_pong(frame.service, write).await?;
            }
            Some(MSG_TYPE_PONG) => {
                tracing::debug!("Received pong");
            }
            Some(MSG_TYPE_EVENT) => {
                tracing::debug!("Received event in control frame");
                self.handle_data_frame(frame, write).await?;
            }
            _ => {
                tracing::debug!("Unknown control message type: {:?}", msg_type);
            }
        }

        Ok(())
    }

    async fn handle_data_frame(&self, frame: &Frame, write: &Arc<Mutex<WsWrite>>) -> Result<()> {
        let msg_type = Self::get_header_value(frame, HEADER_TYPE);
        let payload_encoding = frame.payload_encoding.as_deref().unwrap_or("none");
        let payload_type = frame.payload_type.as_deref().unwrap_or("none");

        tracing::debug!(
            "Data frame headers: type={:?}, encoding={}, payload_type={}, headers={:?}",
            msg_type,
            payload_encoding,
            payload_type,
            frame.headers
        );

        self.send_ack(frame, write).await?;

        let payload_str = Self::decode_payload(frame)?;
        if let Some(payload_str) = payload_str {
            tracing::debug!("Event payload: {}", payload_str);
            if let Ok(event) = serde_json::from_str::<EventPayload>(&payload_str) {
                self.handle_event(&event).await?;
            } else if let Ok(value) = serde_json::from_str::<serde_json::Value>(&payload_str) {
                tracing::debug!("Raw event json: {}", value);
            }
        }

        Ok(())
    }

    async fn handle_event(&self, event: &EventPayload) -> Result<()> {
        let event_type = &event.header.event_type;
        tracing::info!("Received event: {}", event_type);

        match event_type.as_str() {
            "card.action.trigger" => {
                self.handle_card_action(&event.event).await?;
            }
            "im.message.receive_v1" => {
                self.handle_message_receive(&event.event).await?;
            }
            _ => {
                tracing::debug!("Unhandled event type: {}", event_type);
            }
        }

        Ok(())
    }

    async fn handle_card_action(&self, event_data: &serde_json::Value) -> Result<()> {
        tracing::info!("Card action: {}", serde_json::to_string_pretty(event_data)?);
        
        // 获取用户选择的值
        if let Some(action) = event_data.get("action") {
            if let Some(value) = action.get("value") {
                if let Some(choice) = value.get("choice") {
                    if let Some(choice_str) = choice.as_str() {
                        tracing::info!("User choice: {}", choice_str);
                        self.save_user_choice(choice_str).await?;
                    }
                }
            }
        }

        Ok(())
    }

    async fn handle_message_receive(&self, event_data: &serde_json::Value) -> Result<()> {
        tracing::info!("Message receive: {}", serde_json::to_string_pretty(event_data)?);

        let message_type = event_data
            .get("message")
            .and_then(|message| message.get("message_type"))
            .and_then(|value| value.as_str())
            .unwrap_or("unknown");
        let content = event_data
            .get("message")
            .and_then(|message| message.get("content"))
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let sender = event_data
            .get("sender")
            .and_then(|sender| sender.get("sender_id"))
            .and_then(|sender_id| sender_id.get("open_id"))
            .and_then(|value| value.as_str())
            .unwrap_or("unknown");

        // 解析消息内容
        let text_content = if message_type == "text" {
            // 尝试解析 JSON 格式的 text 消息
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(content) {
                json.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string()
            } else {
                content.to_string()
            }
        } else {
            content.to_string()
        };

        tracing::info!("Message parsed: sender={}, type={}, content={}", sender, message_type, text_content);

        // 检查是否是权限确认回复（1 或 2）
        let trimmed = text_content.trim();
        if trimmed == "1" || trimmed == "2" {
            tracing::info!("Received permission response: {}", trimmed);
            self.send_permission_response(trimmed).await?;
        }

        Ok(())
    }

    async fn send_permission_response(&self, choice: &str) -> Result<()> {
        // 使用 AppleScript 模拟按键
        let script = format!(
            r#"tell application "System Events"
    tell process "Claude"
        set frontmost to true
        delay 0.1
        keystroke "{}"
        delay 0.1
        keystroke return
    end tell
end tell"#,
            choice
        );

        tracing::info!("Executing AppleScript to send: {}", choice);

        let output = std::process::Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()?;

        if output.status.success() {
            tracing::info!("AppleScript executed successfully");
        } else {
            let error = String::from_utf8_lossy(&output.stderr);
            tracing::error!("AppleScript failed: {}", error);
        }

        Ok(())
    }

    fn decode_payload(frame: &Frame) -> Result<Option<String>> {
        let payload = match &frame.payload {
            Some(payload) => payload.as_slice(),
            None => return Ok(None),
        };

        let payload_encoding = frame.payload_encoding.as_deref().unwrap_or("");
        let is_gzip = payload_encoding.eq_ignore_ascii_case("gzip")
            || payload.starts_with(&[0x1f, 0x8b]);
        let decoded = if is_gzip {
            let mut decoder = GzDecoder::new(payload);
            let mut output = String::new();
            decoder.read_to_string(&mut output)?;
            output
        } else {
            String::from_utf8_lossy(payload).to_string()
        };

        Ok(Some(decoded))
    }

    async fn send_pong(&self, service_id: i32, write: &Arc<Mutex<WsWrite>>) -> Result<()> {
        let pong_frame = Self::create_control_frame(
            service_id,
            vec![Header {
                key: HEADER_TYPE.to_string(),
                value: MSG_TYPE_PONG.to_string(),
            }],
        );
        let mut buf = Vec::new();
        pong_frame.encode(&mut buf)?;
        let mut locked = write.lock().await;
        locked.send(WsMessage::Binary(buf.into())).await?;
        Ok(())
    }

    async fn send_ack(&self, frame: &Frame, write: &Arc<Mutex<WsWrite>>) -> Result<()> {
        let message_id = Self::get_header_value(frame, HEADER_MESSAGE_ID);
        let sum = Self::get_header_value(frame, HEADER_SUM);
        let seq = Self::get_header_value(frame, HEADER_SEQ);
        let trace_id = Self::get_header_value(frame, HEADER_TRACE_ID);

        if message_id.is_none() || sum.is_none() || seq.is_none() {
            tracing::debug!("Missing ack headers: message_id={:?}, sum={:?}, seq={:?}", message_id, sum, seq);
            return Ok(());
        }

        let mut headers = vec![
            Header {
                key: HEADER_TYPE.to_string(),
                value: MSG_TYPE_ACK.to_string(),
            },
            Header {
                key: HEADER_MESSAGE_ID.to_string(),
                value: message_id.unwrap(),
            },
            Header {
                key: HEADER_SUM.to_string(),
                value: sum.unwrap(),
            },
            Header {
                key: HEADER_SEQ.to_string(),
                value: seq.unwrap(),
            },
        ];

        if let Some(trace_id) = trace_id {
            headers.push(Header {
                key: HEADER_TRACE_ID.to_string(),
                value: trace_id,
            });
        }

        let ack_frame = Self::create_control_frame(frame.service, headers);
        let mut buf = Vec::new();
        ack_frame.encode(&mut buf)?;
        let mut locked = write.lock().await;
        locked.send(WsMessage::Binary(buf.into())).await?;
        Ok(())
    }

    fn create_control_frame(service_id: i32, headers: Vec<Header>) -> Frame {
        Frame {
            seq_id: 0,
            log_id: 0,
            service: service_id,
            method: FRAME_METHOD_CONTROL,
            headers,
            payload_encoding: None,
            payload_type: None,
            payload: None,
            log_id_new: None,
        }
    }

    async fn save_user_choice(&self, choice: &str) -> Result<()> {
        let choice_path = dirs::config_dir()
            .expect("Failed to get config directory")
            .join("com.claude.monitor")
            .join("user_choice.txt");
        
        tokio::fs::write(&choice_path, choice).await?;
        tracing::info!("User choice saved: {}", choice);
        
        Ok(())
    }

    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }
}
