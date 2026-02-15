mod config;
mod feishu;
mod hooks;
mod server;
mod websocket;

use anyhow::Result;
use clap::{Parser, Subcommand};
use rusqlite::{params, Connection};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Parser)]
#[command(name = "claude-monitor")]
#[command(about = "Claude Code monitor with Feishu Open Platform integration")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Run as Claude Code hook (reads from stdin)
    Hook,
    /// Send a test message to Feishu
    Test {
        /// Chat ID to send message to
        #[arg(short, long)]
        chat_id: Option<String>,
    },
    /// Start WebSocket long connection to receive events
    Connect,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let cli = Cli::parse();
    let config = config::Config::load()?;

    match cli.command {
        Commands::Hook => run_hook(&config).await?,
        Commands::Test { chat_id } => run_test(&config, chat_id).await?,
        Commands::Connect => run_connect(&config).await?,
    }

    Ok(())
}

async fn run_hook(config: &config::Config) -> Result<()> {
    let hook_input = hooks::read_hook_input()?;
    tracing::info!("Received hook event: {:?}", hook_input);

    let notification_text = hook_input.notification_text.clone().unwrap_or_default();
    let final_response = hook_input.final_response.clone().unwrap_or_default();
    let event_name = hook_input.hook_event_name.clone();

    // 对于 PermissionRequest，提取 tool 信息作为摘要
    let permission_summary = if event_name == "PermissionRequest" {
        let tool_name = hook_input.tool_name.clone().unwrap_or_default();
        let tool_input = hook_input.tool_input.clone();
        let mut summary = format!("工具: {}", tool_name);
        if let Some(input) = tool_input {
            // 根据不同工具提取关键信息
            match tool_name.as_str() {
                "Bash" => {
                    if let Some(cmd) = input.get("command").and_then(|v| v.as_str()) {
                        summary.push_str(&format!("\n命令: {}", cmd));
                    }
                }
                "Edit" => {
                    if let Some(path) = input.get("file_path").and_then(|v| v.as_str()) {
                        summary.push_str(&format!("\n文件: {}", path));
                    }
                    if let Some(old) = input.get("old_string").and_then(|v| v.as_str()) {
                        summary.push_str(&format!("\n原内容:\n{}", old));
                    }
                    if let Some(new) = input.get("new_string").and_then(|v| v.as_str()) {
                        summary.push_str(&format!("\n新内容:\n{}", new));
                    }
                }
                "Write" => {
                    if let Some(path) = input.get("file_path").and_then(|v| v.as_str()) {
                        summary.push_str(&format!("\n文件: {}", path));
                    }
                    if let Some(content) = input.get("content").and_then(|v| v.as_str()) {
                        summary.push_str(&format!("\n内容:\n{}", content));
                    }
                }
                "Read" => {
                    if let Some(file_path) = input.get("file_path").and_then(|v| v.as_str()) {
                        summary.push_str(&format!("\n文件: {}", file_path));
                    }
                }
                "AskUserQuestion" => {
                    // 解析 questions 数组，友好显示
                    if let Some(questions) = input.get("questions").and_then(|v| v.as_array()) {
                        for (i, q) in questions.iter().enumerate() {
                            if i > 0 {
                                summary.push_str("\n---\n");
                            }
                            if let Some(header) = q.get("header").and_then(|v| v.as_str()) {
                                summary.push_str(&format!("**问题{}: {}**\n", i + 1, header));
                            }
                            if let Some(question) = q.get("question").and_then(|v| v.as_str()) {
                                summary.push_str(&format!("{}\n", question));
                            }
                            if let Some(options) = q.get("options").and_then(|v| v.as_array()) {
                                summary.push_str("可选:\n");
                                for (j, opt) in options.iter().enumerate() {
                                    let label = opt.get("label").and_then(|v| v.as_str()).unwrap_or("");
                                    let desc = opt.get("description").and_then(|v| v.as_str()).unwrap_or("");
                                    if desc.is_empty() {
                                        summary.push_str(&format!("  {}. {}\n", j + 1, label));
                                    } else {
                                        summary.push_str(&format!("  {}. {} - {}\n", j + 1, label, desc));
                                    }
                                }
                            }
                        }
                    }
                }
                _ => {
                    // 其他工具显示完整 JSON
                    if let Ok(json_str) = serde_json::to_string(&input) {
                        summary.push_str(&format!("\n输入: {}", json_str));
                    }
                }
            }
        }
        summary
    } else {
        String::new()
    };
    let event_lower = event_name.to_lowercase();
    let (title, allow_actions) = match event_lower.as_str() {
        "notification" => ("🧭 需要确认", true),
        "permissionrequest" => ("🧭 权限确认", true),
        "stop" => ("💬 Claude 回复", false),
        "status" => ("🟡 状态更新", false),
        "progress" => ("🔵 进度更新", false),
        "start" | "started" => ("🟢 开始", false),
        "complete" | "completed" | "done" | "finish" | "finished" => ("✅ 完成", false),
        "error" | "failed" => ("🔴 失败", false),
        "warning" => ("🟠 警告", false),
        _ => ("📌 通知", false),
    };

    let mut content = format!("{}\n\n", title);

    // Stop 和 PermissionRequest 简化内容，不显示 Event、Session、CWD、Permission
    if event_name != "Stop" && event_name != "PermissionRequest" {
        content.push_str(&format!("**Event**: {}\n", event_name));
        content.push_str(&format!("**Session**: {}\n", hook_input.session_id));
        content.push_str(&format!("**CWD**: {}\n", hook_input.cwd));
        content.push_str(&format!("**Permission**: {}\n", hook_input.permission_mode));
    }

    if !notification_text.is_empty() {
        content.push_str("\n\n**Notification**\n");
        content.push_str(&notification_text);
    }

    // PermissionRequest - 显示工具信息
    if !permission_summary.is_empty() {
        content.push_str("\n\n**权限请求**\n");
        content.push_str(&permission_summary);
    }

    // Stop hook - 显示 Claude 的输出内容
    if !final_response.is_empty() {
        content.push_str("\n\n**Claude 输出**\n");
        // 限制长度
        let truncated = if final_response.len() > 3000 {
            format!("{}...\n\n（省略 {} 字符）", &final_response[..3000], final_response.len() - 3000)
        } else {
            final_response
        };
        content.push_str(&truncated);
    }

    // Stop hook - 从 transcript 中提取最新的 Claude 回复
    if event_name == "Stop" && !hook_input.transcript_path.is_empty() {
        match std::fs::read_to_string(&hook_input.transcript_path) {
            Ok(transcript) => {
                // 提取所有 assistant 消息的最后几条
                let lines: Vec<&str> = transcript.lines().collect();
                let mut assistant_msgs: Vec<String> = Vec::new();

                // 从后向前遍历，找到包含 text 类型的 assistant 消息
                for line in lines.iter().rev().take(50) {
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(line) {
                        // 检查是否是 assistant 消息
                        let is_assistant = json.get("type").and_then(|v| v.as_str()) == Some("assistant")
                            || json.get("message").and_then(|v| v.get("role")).and_then(|v| v.as_str()) == Some("assistant");

                        if is_assistant {
                            // 提取 content 中的 text 类型内容
                            if let Some(message_obj) = json.get("message") {
                                if let Some(content_val) = message_obj.get("content") {
                                    if let Some(content_array) = content_val.as_array() {
                                        for item in content_array {
                                            // 提取 text 类型的内容
                                            if item.get("type").and_then(|v| v.as_str()) == Some("text") {
                                                if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                                                    assistant_msgs.push(text.to_string());
                                                }
                                            }
                                        }
                                    } else if let Some(text) = content_val.as_str() {
                                        assistant_msgs.push(text.to_string());
                                    }
                                }
                            }
                            // 找到 3 条包含实际文本的 assistant 消息就停止
                            if assistant_msgs.len() >= 3 {
                                break;
                            }
                        }
                    }
                }

                if !assistant_msgs.is_empty() {
                    content.push_str("\n\n**Claude 回复**\n");
                    // 显示所有提取的消息（倒序，最后的在前）
                    for msg in assistant_msgs.iter().rev() {
                        let truncated = if msg.len() > 500 {
                            format!("{}...", &msg[..500])
                        } else {
                            msg.clone()
                        };
                        content.push_str(&truncated);
                        content.push_str("\n---\n");
                    }
                } else {
                    // 如果没有提取到，显示原始 transcript 的最后部分
                    let last_lines: Vec<String> = lines.iter().rev().take(3).map(|s| s.to_string()).collect();
                    if !last_lines.is_empty() {
                        content.push_str("\n\n**Claude 回复**\n（无法解析，转录最后几行）\n");
                        for line in last_lines {
                            content.push_str(&line);
                            content.push_str("\n");
                        }
                    }
                }
            }
            Err(err) => {
                content.push_str("\n\n**Claude 回复**\n读取失败: ");
                content.push_str(&err.to_string());
            }
        }
    } else if !hook_input.transcript_path.is_empty() && event_name != "UserPromptSubmit" && event_name != "PermissionRequest" && event_name != "Stop" {
        // 其他事件读取 transcript（除了 Stop 和 PermissionRequest）
        match std::fs::read_to_string(&hook_input.transcript_path) {
            Ok(transcript) => {
                content.push_str("\n\n**Transcript**\n");
                // 只保留最后 2000 字符
                let truncated = if transcript.len() > 2000 {
                    format!("...（省略 {} 字符）\n\n{}", transcript.len() - 2000, &transcript[transcript.len() - 2000..])
                } else {
                    transcript
                };
                content.push_str(&truncated);
            }
            Err(err) => {
                content.push_str("\n\n**Transcript**\n读取失败: ");
                content.push_str(&err.to_string());
            }
        }
    } else if event_name == "UserPromptSubmit" || event_name == "PermissionRequest" || event_name == "Stop" {
        // 这些事件不读取 transcript
    }

    // 限制数据库存储的内容长度
    const MAX_DB_CONTENT_LEN: usize = 5000;
    let db_content = if content.len() > MAX_DB_CONTENT_LEN {
        format!("{}...\n\n（内容过长，已截断）", &content[..MAX_DB_CONTENT_LEN])
    } else {
        content.clone()
    };

    // 使用 permission_summary 作为 notification_text（如果存在）
    let notification_for_record = if !permission_summary.is_empty() {
        permission_summary.clone()
    } else {
        notification_text.clone()
    };

    // 先保存记录到数据库
    let record_id = match save_hook_record(
        &event_name,
        &hook_input.session_id,
        &notification_for_record,
        &hook_input.transcript_path,
        &db_content,
        "pending",
    ) {
        Ok(id) => Some(id),
        Err(err) => {
            tracing::error!("Failed to save hook record: {}", err);
            None
        }
    };

    // 获取接收者ID，发送飞书通知（可选）
    // 优先级：chat_id > open_id
    let (receive_id, receive_id_type) = std::env::var("FEISHU_CHAT_ID")
        .ok()
        .or_else(|| std::env::var("CLAUDE_MONITOR_CHAT_ID").ok())
        .or_else(|| config.chat_id.clone())
        .map(|id| (id, "chat_id"))
        .unwrap_or_else(|| {
            // 尝试使用保存的 open_id
            feishu::get_last_open_id()
                .map(|id| (id, "open_id"))
                .unwrap_or((String::new(), ""))
        });

    // 如果没有配置接收者ID，只保存记录并退出
    if receive_id.is_empty() {
        tracing::warn!("No chat_id or open_id configured, hook record saved but no notification sent");
        return Ok(());
    }

    // 检测是否需要确认按钮
    let action_text = if !notification_text.is_empty() {
        notification_text.clone()
    } else if !permission_summary.is_empty() {
        permission_summary.clone()
    } else {
        String::new()
    };

    let need_action = allow_actions
        && (action_text.contains("Do you want to")
            || action_text.contains("❯ 1. Yes")
            || action_text.contains("❯ 2. No")
            || action_text.contains("AskUserQuestion"));

    let actions = if need_action {
        Some(vec![
            feishu::CardAction {
                tag: "button".to_string(),
                text: feishu::CardText {
                    content: "✅ Yes (1)".to_string(),
                    tag: "plain_text".to_string(),
                },
                action_type: "primary".to_string(),
                value: serde_json::json!({"choice": "1"}),
            },
            feishu::CardAction {
                tag: "button".to_string(),
                text: feishu::CardText {
                    content: "❌ No (2)".to_string(),
                    tag: "plain_text".to_string(),
                },
                action_type: "danger".to_string(),
                value: serde_json::json!({"choice": "2"}),
            },
        ])
    } else {
        None
    };

    // 限制消息长度，飞书单条消息最大 20000 字符
    const MAX_CONTENT_LEN: usize = 18000;
    let mut send_content = content.clone();
    if send_content.len() > MAX_CONTENT_LEN {
        send_content = format!("{}...\n\n（内容过长，已截断）", &send_content[..MAX_CONTENT_LEN]);
    }

    let feishu_client = feishu::FeishuClient::new(
        config.app_id.clone(),
        config.app_secret.clone(),
    );

    let send_result = feishu_client
        .send_message(&receive_id, send_content, actions, receive_id_type)
        .await;

    // 更新记录状态
    let record_result = match &send_result {
        Ok(_) => "sent".to_string(),
        Err(err) => format!("failed: {}", err),
    };

    // 如果有 record_id，使用 UPDATE；否则创建新记录
    if let Some(id) = record_id {
        if let Err(err) = update_hook_record(
            id,
            &event_name,
            &hook_input.session_id,
            &notification_for_record,
            &hook_input.transcript_path,
            &db_content,
            &record_result,
        ) {
            tracing::error!("Failed to update hook record: {}", err);
        }
    } else {
        // 如果没有 ID，创建一个新记录
        if let Err(err) = save_hook_record(
            &event_name,
            &hook_input.session_id,
            &notification_for_record,
            &hook_input.transcript_path,
            &db_content,
            &record_result,
        ) {
            tracing::error!("Failed to save hook record: {}", err);
        }
    }

    send_result?;
    tracing::info!("Sent hook message to Feishu");

    if need_action {
        let output = hooks::HookOutput {
            continue_exec: Some(true),
            stop_reason: None,
            system_message: Some("通知已发送到飞书，请在飞书中查看并回复".to_string()),
        };
        hooks::send_hook_output(&output);
    } else {
        let output = hooks::HookOutput::success();
        hooks::send_hook_output(&output);
    }

    Ok(())
}

fn get_db_path() -> std::path::PathBuf {
    let config_dir = dirs::config_dir()
        .expect("Failed to get config directory")
        .join("com.claude.monitor");
    std::fs::create_dir_all(&config_dir).expect("Failed to create config directory");
    config_dir.join("hooks.db")
}

fn init_db(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS hook_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_name TEXT NOT NULL,
            session_id TEXT NOT NULL,
            notification_text TEXT NOT NULL,
            transcript_path TEXT NOT NULL,
            content TEXT NOT NULL,
            result TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )",
        [],
    )?;
    Ok(())
}

fn save_hook_record(
    event_name: &str,
    session_id: &str,
    notification_text: &str,
    transcript_path: &str,
    content: &str,
    result: &str,
) -> Result<i64> {
    let conn = Connection::open(get_db_path())?;
    init_db(&conn)?;
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    conn.execute(
        "INSERT INTO hook_records (event_name, session_id, notification_text, transcript_path, content, result, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            event_name,
            session_id,
            notification_text,
            transcript_path,
            content,
            result,
            created_at
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

fn update_hook_record(
    id: i64,
    event_name: &str,
    session_id: &str,
    notification_text: &str,
    transcript_path: &str,
    content: &str,
    result: &str,
) -> Result<()> {
    let conn = Connection::open(get_db_path())?;
    conn.execute(
        "UPDATE hook_records SET event_name = ?1, session_id = ?2, notification_text = ?3, transcript_path = ?4, content = ?5, result = ?6 WHERE id = ?7",
        params![
            event_name,
            session_id,
            notification_text,
            transcript_path,
            content,
            result,
            id
        ],
    )?;
    Ok(())
}

async fn run_test(config: &config::Config, chat_id: Option<String>) -> Result<()> {
    // 优先使用命令行参数，其次使用配置文件
    let target_chat_id = chat_id
        .or_else(|| std::env::var("FEISHU_CHAT_ID").ok())
        .or_else(|| std::env::var("CLAUDE_MONITOR_CHAT_ID").ok())
        .or_else(|| config.chat_id.clone())
        .ok_or_else(|| anyhow::anyhow!("Chat ID not provided. Use --chat-id, set FEISHU_CHAT_ID, or configure it in the desktop app."))?;
    
    tracing::info!("Sending test message to Feishu...");
    
    let feishu_client = feishu::FeishuClient::new(
        config.app_id.clone(),
        config.app_secret.clone(),
    );
    
    feishu_client
        .send_notification(
            "🧪 **Claude Monitor 连接成功！**".to_string(),
            None,
            &target_chat_id,
        )
        .await?;
    
    tracing::info!("Test message sent successfully to chat: {}", target_chat_id);
    Ok(())
}

async fn run_connect(config: &config::Config) -> Result<()> {
    tracing::info!("Starting Feishu WebSocket long connection...");
    tracing::info!("App ID: {}", config.app_id);
    
    let client = websocket::FeishuWsClient::new(
        config.app_id.clone(),
        config.app_secret.clone(),
    );
    
    // 带重连机制
    loop {
        match client.connect().await {
            Ok(_) => {
                tracing::info!("WebSocket connection closed normally");
            }
            Err(e) => {
                tracing::error!("WebSocket connection error: {}", e);
            }
        }
        
        // 等待 5 秒后重连
        tracing::info!("Reconnecting in 5 seconds...");
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
}
