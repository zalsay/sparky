mod config;
mod feishu;
mod hooks;
mod server;
mod websocket;

use anyhow::Result;
use clap::{Parser, Subcommand};
use rusqlite::{params, Connection};
use std::time::{SystemTime, UNIX_EPOCH};
use std::io::{Write, Read, Seek, SeekFrom};
use std::fs::File;
use std::path::PathBuf;

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
    use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, Layer};

    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));

    // File appender: ~/sparky/sparky.YYYY-MM-DD.log
    let home = dirs::home_dir().expect("Failed to get HOME");
    let log_dir = home.join("sparky");
    let file_appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("sparky")
        .filename_suffix("log")
        .build(log_dir)
        .expect("Failed to create rolling file appender");
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);

    let stdout_layer = tracing_subscriber::fmt::layer()
        .with_writer(std::io::stderr)
        .with_filter(env_filter);
    
    let file_layer = tracing_subscriber::fmt::layer()
        .with_writer(non_blocking)
        .with_ansi(false)
        .with_filter(tracing_subscriber::EnvFilter::new("debug"));

    tracing_subscriber::registry()
        .with(stdout_layer)
        .with(file_layer)
        .init();

    // Log startup info
    if let Ok(exe) = std::env::current_exe() {
        tracing::info!("[main] Starting sparky: {:?}", exe);
    }
    if let Ok(cwd) = std::env::current_dir() {
        tracing::info!("[main] CWD: {:?}", cwd);
    }
    let args: Vec<String> = std::env::args().collect();
    tracing::info!("[main] Args: {:?}", args);

    let cli = Cli::parse();
    let config = config::Config::load()?;

    match cli.command {
        Commands::Hook => {
            if let Err(e) = run_hook(&config).await {
                tracing::error!("[main] run_hook failed: {:?}", e);
                return Err(e);
            }
        }
        Commands::Test { chat_id } => run_test(&config, chat_id).await?,
        Commands::Connect => run_connect(&config).await?,
    }

    Ok(())
}

async fn run_hook(config: &config::Config) -> Result<()> {
    tracing::info!("[run_hook] starting hook processing");
    let hook_input = hooks::read_hook_input()?;
    tracing::info!(
        "[run_hook] event={}, session={}, cwd={}, notification_len={}, final_response_len={}, tool={:?}",
        hook_input.hook_event_name,
        hook_input.session_id,
        hook_input.cwd,
        hook_input.notification_text.as_ref().map(|s| s.len()).unwrap_or(0),
        hook_input.final_response.as_ref().map(|s| s.len()).unwrap_or(0),
        hook_input.tool_name
    );
    append_hook_log(&format!(
        "📥 Hook触发: event={}, tool={:?}, cwd={}",
        hook_input.hook_event_name,
        hook_input.tool_name.as_deref().unwrap_or("-"),
        hook_input.cwd
    ));

    // 检查事件类型是否在过滤列表中
    if let Some(ref filter) = config.hook_events_filter {
        if !filter.is_empty() {
            let allowed: Vec<&str> = filter.split(',').map(|s| s.trim()).collect();
            if !allowed.contains(&hook_input.hook_event_name.as_str()) {
                tracing::info!(
                    "[run_hook] event={} not in filter [{}], skipping",
                    hook_input.hook_event_name, filter
                );
                append_hook_log(&format!(
                    "⏭️ 事件已过滤: event={} (允许: {})",
                    hook_input.hook_event_name, filter
                ));
                // 输出 continue 让 Claude Code 继续
                let output = hooks::HookOutput::success();
                println!("{}", serde_json::to_string(&output).unwrap_or_default());
                return Ok(());
            }
        }
    }

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
    let (base_title, allow_actions) = match event_lower.as_str() {
        "notification" => ("🧭 需要确认", true),
        "permissionrequest" => ("🧭 权限确认", true),
        "stop" => ("Claude 回复", false),
        "status" => ("🟡 状态更新", false),
        "progress" => ("🔵 进度更新", false),
        "start" | "started" => ("🟢 开始", false),
        "complete" | "completed" | "done" | "finish" | "finished" => ("✅ 完成", false),
        "error" | "failed" => ("🔴 失败", false),
        "warning" => ("🟠 警告", false),
        _ => ("📌 通知", false),
    };

    let project_path = &hook_input.cwd;
    let project_name = std::path::Path::new(project_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Unknown");
        
    let dynamic_title = if let Some(index) = feishu::get_project_index(project_path) {
        format!("【项目::{}】【{}】{}", index, project_name, base_title)
    } else {
        format!("【{}】{}", project_name, base_title)
    };

    let mut content = String::new();

    // Stop 和 PermissionRequest 简化内容，不显示 Event、Session、CWD、Permission
    if event_name != "Stop" && event_name != "PermissionRequest" {
        content.push_str(&format!("**Event**: {}\n", event_name));
        content.push_str(&format!("**Session**: {}\n", hook_input.session_id));
        content.push_str(&format!("**CWD**: {}\n", hook_input.cwd));
        content.push_str(&format!("\n**Permission**: {}\n", hook_input.permission_mode.clone().unwrap_or("ask".to_string())));
    }

    if !notification_text.is_empty() {
        content.push_str("\n\n**Notification**\n");
        content.push_str(&notification_text);
    }

        // PermissionRequest - 显示工具信息
    if !permission_summary.is_empty() {
        // Record pending permission request in DB using CWD
        let project_path = &hook_input.cwd;
        tracing::info!("[main] Creating permission request for project: {}", project_path);
        let req_code = match feishu::create_permission_request(project_path) {
            Ok(code) => {
                tracing::info!("[main] Permission request created with code: {}", code);
                Some(code)
            }
            Err(e) => {
                tracing::error!("Failed to create permission request: {}", e);
                None
            }
        };

        content.push_str("\n\n**权限请求**\n");
        content.push_str(&permission_summary);

        // 尝试从终端日志中捕获提示
        let mut prompt_captured = false;
        if let Some(project_path) = config.project_path.as_ref() {
            if let Some(prompt) = read_terminal_prompt(project_path) {
                content.push_str("\n\n❓ **Terminal Output**\n");
                content.push_str("```\n");
                content.push_str(&prompt);
                content.push_str("\n```");
                prompt_captured = true;
            }
        }

        if let Some(code) = &req_code {
            content.push_str(&format!("\n\n🔑 **配对码: {}**\n", code));
            content.push_str(&format!("❯ 回复 `{}-1` 允许\n", code));
            content.push_str(&format!("  回复 `{}-2` 始终允许\n", code));
            content.push_str(&format!("  回复 `{}-3` 拒绝", code));
        } else if !prompt_captured {
            content.push_str("\n\n❓ **Do you want to proceed?**\n");
            content.push_str("❯ 1. Yes\n");
            content.push_str("  2. Yes, and always allow access\n");
            content.push_str("  3. No");
        }
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
                // 提取最新的交流过程（只包含文本和工具调用，过滤掉执行详情）
                let lines: Vec<&str> = transcript.lines().collect();
                let mut session_elements: Vec<String> = Vec::new();

                // 从后向前遍历，开始收集
                for line in lines.iter().rev().take(100) {
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(line) {
                        let role = json.get("message").and_then(|v| v.get("role")).and_then(|v| v.as_str());
                        
                        // 提取内容
                        if let Some(content_val) = json.get("message").and_then(|v| v.get("content")) {
                            let mut turn_has_tool_result = false;
                            let mut turn_elements = Vec::new();

                            if let Some(content_array) = content_val.as_array() {
                                for item in content_array {
                                    let item_type = item.get("type").and_then(|v| v.as_str());
                                    
                                    if item_type == Some("text") {
                                        if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                                            if !text.trim().is_empty() {
                                                turn_elements.push(format!("-- {}", text));
                                            } else {
                                                turn_elements.push(String::new());
                                            }
                                        }
                                    } else if item_type == Some("tool_use") {
                                        let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("tool");
                                        let input = item.get("input").map(|v| v.to_string()).unwrap_or_default();
                                        // 简化 input 显示
                                        let input_display = if input.len() > 100 { format!("{}...", &input[..100]) } else { input };
                                        turn_elements.push(format!("-- **{}**({})", name, input_display));
                                    } else if item_type == Some("tool_result") {
                                        turn_has_tool_result = true;
                                        // 过滤掉 tool_result，不再添加 ⎿ 行
                                    }
                                }
                            } else if let Some(text) = content_val.as_str() {
                                if !text.trim().is_empty() {
                                    turn_elements.push(format!("-- {}", text));
                                } else {
                                    turn_elements.push(String::new());
                                }
                            }

                            if !turn_elements.is_empty() {
                                // 因为是 rev 遍历行，所以要把这一行的元素按原来的正序加入 session_elements
                                // 稍后整体再 rev 一次
                                for el in turn_elements.into_iter().rev() {
                                    session_elements.push(el);
                                }
                            }

                            // 如果是用户发送的文本消息（且不是工具回传），说明到了本轮对话的起点，停止
                            if role == Some("user") && !turn_has_tool_result {
                                break;
                            }
                        }
                    }
                }

                if !session_elements.is_empty() {
                    // 整体反转回正序（从前到后）
                    for el in session_elements.iter().rev() {
                        content.push_str(el);
                        content.push('\n');
                    }
                } else {
                    // 如果没有提取到，显示最后 3 行作为保底
                    content.push_str("（无法解析转录）\n");
                    let last_lines: Vec<&str> = lines.iter().rev().take(3).cloned().collect();
                    for line in last_lines.iter().rev() {
                        content.push_str(line);
                        content.push_str("\n");
                    }
                }
            }
            Err(err) => {
                content.push_str("读取失败: ");
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
        &hook_input.cwd,
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
    let env_chat_id = std::env::var("FEISHU_CHAT_ID").ok();
    let env_cm_chat_id = std::env::var("CLAUDE_MONITOR_CHAT_ID").ok();
    let config_chat_id = config.chat_id.clone();
    let config_open_id = config.open_id.clone();
    tracing::info!(
        "[run_hook] receive_id candidates: FEISHU_CHAT_ID={:?}, CLAUDE_MONITOR_CHAT_ID={:?}, config.chat_id={:?}, config.open_id={:?}",
        env_chat_id, env_cm_chat_id, config_chat_id, config_open_id
    );

    let (receive_id, receive_id_type) = env_chat_id
        .or(env_cm_chat_id)
        .or(config_chat_id)
        .map(|id| (id, "chat_id"))
        .unwrap_or_else(|| {
            config_open_id
                .filter(|id| !id.is_empty())
                .map(|id| (id, "open_id"))
                .unwrap_or((String::new(), ""))
        });

    tracing::info!("[run_hook] resolved receive_id_type={}, receive_id={}", receive_id_type, receive_id);

    // 如果没有配置接收者ID，只保存记录并退出
    if receive_id.is_empty() {
        tracing::warn!("[run_hook] No chat_id or open_id configured, hook record saved but no notification sent");
        append_hook_log(&format!("⚠️ 无接收者ID，跳过通知: event={}", event_name));
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

    tracing::info!(
        "[run_hook] allow_actions={}, need_action={}, action_text_len={}",
        allow_actions, need_action, action_text.len()
    );

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
        .send_message_with_title(&receive_id, Some(&dynamic_title), config.anthropic_logo_img_key.as_deref(), send_content, actions, receive_id_type)
        .await;

    if let Err(err) = &send_result {
        tracing::error!(
            "Failed to send hook message: receive_id_type={}, receive_id={}, error={}",
            receive_id_type,
            receive_id,
            err
        );
        append_hook_log(&format!("❌ 飞书发送失败: {}", err));
    } else {
        append_hook_log(&format!("✅ 飞书发送成功: event={}, receive_id_type={}", event_name, receive_id_type));
    }

    // 更新记录状态
    let record_result = match &send_result {
        Ok(_) => "sent".to_string(),
        Err(err) => format!("failed: {}", err),
    };

    // 如果有 record_id，使用 UPDATE；否则创建新记录
    if let Some(id) = record_id {
        if let Err(err) = update_hook_record(
            &hook_input.cwd,
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
            &hook_input.cwd,
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
    let base_dir = dirs::home_dir()
        .expect("Failed to get home directory")
        .join("sparky");
    std::fs::create_dir_all(&base_dir).expect("Failed to create base directory");
    base_dir.join("hooks.db")
}

fn project_hooks_table_name(project_path: &str) -> String {
    let mut hash: u64 = 14695981039346656037;
    for byte in project_path.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(1099511628211);
    }
    format!("hook_records_{:x}", hash)
}

fn ensure_project_hooks_table(conn: &Connection, table_name: &str) -> Result<()> {
    let sql = format!(
        "CREATE TABLE IF NOT EXISTS {} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_name TEXT NOT NULL,
            session_id TEXT NOT NULL,
            notification_text TEXT NOT NULL,
            transcript_path TEXT NOT NULL,
            content TEXT NOT NULL,
            result TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )",
        table_name
    );
    conn.execute(&sql, [])?;
    ensure_session_id_column(conn, table_name)?;
    Ok(())
}

fn ensure_session_id_column(conn: &Connection, table_name: &str) -> Result<()> {
    let pragma_sql = format!("PRAGMA table_info({})", table_name);
    let mut stmt = conn.prepare(&pragma_sql)?;
    let mut has_session = false;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for row in rows {
        if row? == "session_id" {
            has_session = true;
            break;
        }
    }
    if !has_session {
        let alter_sql = format!(
            "ALTER TABLE {} ADD COLUMN session_id TEXT NOT NULL DEFAULT ''",
            table_name
        );
        conn.execute(&alter_sql, [])?;
    }
    Ok(())
}

fn cleanup_legacy_hook_records(conn: &Connection) -> Result<()> {
    conn.execute("DROP TABLE IF EXISTS hook_records", [])?;
    Ok(())
}

fn save_hook_record(
    project_path: &str,
    event_name: &str,
    session_id: &str,
    notification_text: &str,
    transcript_path: &str,
    content: &str,
    result: &str,
) -> Result<i64> {
    let db_path = get_db_path();
    tracing::info!(
        "[db:save] opening DB: {:?}, project_path={}, event={}",
        db_path, project_path, event_name
    );
    let conn = Connection::open(&db_path)?;
    cleanup_legacy_hook_records(&conn)?;
    let table_name = project_hooks_table_name(project_path);
    tracing::info!("[db:save] table_name={}", table_name);
    ensure_project_hooks_table(&conn, &table_name)?;
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let insert_sql = format!(
        "INSERT INTO {} (event_name, session_id, notification_text, transcript_path, content, result, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        table_name
    );
    tracing::info!(
        "[db:save] inserting: event={}, session={}, content_len={}, result={}",
        event_name, session_id, content.len(), result
    );
    match conn.execute(
        &insert_sql,
        params![
            event_name,
            session_id,
            notification_text,
            transcript_path,
            content,
            result,
            created_at
        ],
    ) {
        Ok(rows) => tracing::info!("[db:save] INSERT affected {} rows", rows),
        Err(e) => {
            tracing::error!("[db:save] INSERT failed: {}", e);
            return Err(e.into());
        }
    }
    let row_id = conn.last_insert_rowid();
    tracing::info!("[db:save] last_insert_rowid={}", row_id);
    let trim_sql = format!(
        "DELETE FROM {table}
         WHERE id NOT IN (
           SELECT id FROM {table}
           ORDER BY id DESC
           LIMIT 1000
         )",
        table = table_name
    );
    conn.execute(&trim_sql, [])?;
    Ok(row_id)
}

fn update_hook_record(
    project_path: &str,
    id: i64,
    event_name: &str,
    session_id: &str,
    notification_text: &str,
    transcript_path: &str,
    content: &str,
    result: &str,
) -> Result<()> {
    let db_path = get_db_path();
    tracing::info!("[db:update] opening DB: {:?}, id={}, event={}", db_path, id, event_name);
    let conn = Connection::open(&db_path)?;
    cleanup_legacy_hook_records(&conn)?;
    let table_name = project_hooks_table_name(project_path);
    tracing::info!("[db:update] table_name={}", table_name);
    ensure_project_hooks_table(&conn, &table_name)?;
    let update_sql = format!(
        "UPDATE {} SET event_name = ?1, session_id = ?2, notification_text = ?3, transcript_path = ?4, content = ?5, result = ?6 WHERE id = ?7",
        table_name
    );
    match conn.execute(
        &update_sql,
        params![
            event_name,
            session_id,
            notification_text,
            transcript_path,
            content,
            result,
            id
        ],
    ) {
        Ok(rows) => tracing::info!("[db:update] UPDATE affected {} rows for id={}", rows, id),
        Err(e) => {
            tracing::error!("[db:update] UPDATE failed for id={}: {}", id, e);
            return Err(e.into());
        }
    }
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

    // 启动 hook.log tail 监视任务
    tokio::spawn(async {
        if let Err(e) = tail_hook_log().await {
            tracing::error!("Hook log watcher error: {}", e);
        }
    });
    
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

/// 获取 hook.log 路径
fn get_hook_log_path() -> std::path::PathBuf {
    dirs::home_dir()
        .expect("Failed to get home directory")
        .join("sparky")
        .join("hook.log")
}

/// Hook 进程调用：追加一行日志到 ~/sparky/hook.log
fn append_hook_log(message: &str) {
    let log_path = get_hook_log_path();
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
        let _ = writeln!(file, "[{}] {}", now, message);
    }
}

/// Connect 进程调用：监视 ~/sparky/hook.log，打印新增内容
async fn tail_hook_log() -> Result<()> {
    let log_path = get_hook_log_path();
    tracing::info!("Watching hook log: {:?}", log_path);

    // 如果文件已存在，跳过已有内容
    let mut last_pos = if log_path.exists() {
        std::fs::metadata(&log_path)?.len()
    } else {
        0
    };

    loop {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;

        if !log_path.exists() {
            continue;
        }

        let metadata = std::fs::metadata(&log_path)?;
        let current_len = metadata.len();

        if current_len > last_pos {
            // 读取新增内容
            use std::io::{Read, Seek, SeekFrom};
            let mut file = std::fs::File::open(&log_path)?;
            file.seek(SeekFrom::Start(last_pos))?;
            let mut new_content = String::new();
            file.read_to_string(&mut new_content)?;
            last_pos = current_len;

            // 逐行打印
            for line in new_content.lines() {
                if !line.is_empty() {
                    println!("🪝 {}", line);
                }
            }
        } else if current_len < last_pos {
            // 文件被截断（日志轮转），重置
            last_pos = 0;
        }
    }
}

fn get_pty_log_path(project_path: &str) -> PathBuf {
    let home = dirs::home_dir().expect("Failed to get home dir");
    let safe_name = project_path.replace("/", "_").replace(":", "_");
    home.join("sparky/pty_logs").join(format!("{}.log", safe_name))
}

fn read_terminal_prompt(project_path: &str) -> Option<String> {
    let log_path = get_pty_log_path(project_path);
    let mut file = File::open(log_path).ok()?;
    let metadata = file.metadata().ok()?;
    let len = metadata.len();
    
    // Read last 4KB to be safe
    let read_len = if len > 4096 { 4096 } else { len };
    let mut buf = vec![0; read_len as usize];
    
    if len > 4096 {
        file.seek(SeekFrom::End(-4096)).ok()?;
    }
    file.read_exact(&mut buf).ok()?;
    
    let content = String::from_utf8_lossy(&buf);
    
    // Look for "Do you want to proceed?"
    if let Some(pos) = content.rfind("Do you want to proceed?") {
        let prompt_part = &content[pos..];
        // Only take lines up to some reasonable limit or until next prompt?
        // Prompt ends with user input.
        // Assuming we just want to show the prompt and options.
        return Some(prompt_part.trim().to_string());
    }
    
    None
}
