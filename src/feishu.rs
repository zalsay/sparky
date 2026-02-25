use reqwest::Client;
use serde::{Deserialize, Serialize};
use rusqlite::{params, Connection, OptionalExtension};
use std::fs;
use tracing::error;
use rand::Rng;

/// 打开 SQLite 数据库连接
fn open_db() -> Result<Connection, String> {
    let home = dirs::home_dir().ok_or("Failed to get home dir".to_string())?;
    // CLI 和 GUI 使用相同的数据库路径
    let db_path = home.join("sparky-server/hooks.db");
    tracing::info!("[feishu] open_db path: {:?}", db_path);
    if let Some(parent) = db_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    Connection::open(&db_path).map_err(|e| e.to_string())
}

/// 保存 open_id 到 SQLite（供 WebSocket 回调使用）
pub fn save_open_id_to_db(open_id: &str) -> Result<(), String> {
    let conn = open_db()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;
    conn.execute(
        "UPDATE app_config_feishu SET open_id = ?1, updated_at = ?2 WHERE id = 1",
        params![open_id, now],
    )
    .map_err(|e| e.to_string())?;
    tracing::info!("[db] open_id saved to SQLite: {}", open_id);
    Ok(())
}

/// 创建一个新的权限请求（Pending 状态），返回 4 位随机配对码
pub fn create_permission_request(project_path: &str) -> Result<String, String> {
    let conn = open_db()?;
    let db_path = dirs::home_dir().unwrap().join("sparky-server/hooks.db");
    
    // 生成 2 位随机码，并确保不与当前 pending 的冲突
    let mut code_str = String::new();
    let mut found = false;
    
    // 尝试最多 100 次找到唯一的 2 位码
    for _ in 0..100 {
        let code: u16 = rand::rng().random_range(10..100);
        let candidate = code.to_string();
        
        // 检查数据库中是否存在同名的 pending code
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM permission_requests WHERE code = ?1 AND status = 'pending')",
            params![candidate],
            |row| row.get(0),
        ).unwrap_or(false);
        
        if !exists {
            code_str = candidate;
            found = true;
            break;
        }
    }
    
    if !found {
        return Err("无法生成唯一的 2 位配对码（未处理请求过多）".to_string());
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;
    
    match conn.execute(
        "INSERT INTO permission_requests (project_path, status, code, created_at) VALUES (?1, 'pending', ?2, ?3)",
        params![project_path, code_str, now],
    ) {
        Ok(_) => {
            let row_id = conn.last_insert_rowid();
            tracing::info!("[db:perm] Created permission request (id={}, code={}) for project: {} at {:?}", row_id, code_str, project_path, db_path);
        }
        Err(e) => {
            let err_msg = e.to_string();
            tracing::error!("[db:perm] Failed to insert permission request: {} (db={:?})", err_msg, db_path);
            return Err(err_msg);
        }
    }
    
    Ok(code_str)
}

/// 获取项目在数据库中的 ID
pub fn get_project_index(project_path: &str) -> Option<usize> {
    let conn = open_db().ok()?;
    
    let mut stmt = conn.prepare("SELECT id FROM projects WHERE path = ?1 LIMIT 1").ok()?;
    let mut rows = stmt.query(params![project_path]).ok()?;
    
    if let Some(row) = rows.next().ok()? {
        if let Ok(id) = row.get::<_, i64>(0) {
            return Some(id as usize);
        }
    }
    
    None
}

/// 验证并执行命令（通过 code 匹配 pending 请求）
pub fn verify_and_execute_command(code: &str, choice: &str, message_id: &str) -> Result<(), String> {
    let mut conn = open_db()?;
    let db_path = dirs::home_dir().unwrap().join("sparky-server/hooks.db");

    // 防止重复处理相同的权限决策消息
    if !message_id.is_empty() {
        let count: i64 = conn.query_row(
            "SELECT COUNT(1) FROM pty_commands WHERE message_id = ?1",
            rusqlite::params![message_id],
            |row| row.get(0)
        ).unwrap_or(0);

        if count > 0 {
            tracing::info!("[db:verify] Permission message ID {} already processed, skipping duplicate.", message_id);
            return Ok(());
        }
    }
    
    // 通过 code 查找 pending 请求
    let result: Option<(i64, String)> = conn.query_row(
        "SELECT id, project_path FROM permission_requests 
         WHERE code = ?1 AND status = 'pending' 
         LIMIT 1",
        params![code],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional().map_err(|e| format!("Failed to query pending requests: {}", e))?;

    let (req_id, project_path) = match result {
        Some((id, path)) => {
            tracing::info!("[db:verify] Found pending request id={}, code={}, project='{}'", id, code, path);
            (id, path)
        }
        None => {
            // 检查是否是因为已经执行过了
            let status_result: Option<String> = conn.query_row(
                "SELECT status FROM permission_requests WHERE code = ?1 ORDER BY created_at DESC LIMIT 1",
                params![code],
                |row| row.get(0),
            ).optional().unwrap_or(None);

            if let Some(status) = status_result {
                return Err(format!("DUPLICATE: 配对码 {} 已被处理 (状态: {})", code, status));
            }

            tracing::warn!("[db:verify] No pending request found for code={}", code);
            return Err(format!("No pending permission request found for code {}", code));
        }
    };

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;

    // Map choice to ANSI sequence for interactive menus in terminal
    let ansi_command = if let Ok(n) = choice.parse::<usize>() {
        if n > 0 && n <= 50 {
            let arrows = "\x1b[B".repeat(n - 1);
            format!("{}\r", arrows)
        } else {
            choice.to_string()
        }
    } else {
        choice.to_string()
    };

    // Mark request as completed
    tx.execute(
        "UPDATE permission_requests SET status = 'completed', choice = ?1 WHERE id = ?2",
        params![ansi_command, req_id],
    ).map_err(|e| e.to_string())?;

    // Insert command
    tx.execute(
        "INSERT INTO pty_commands (project_path, command, message_id, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![project_path, ansi_command, message_id, now],
    ).map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    
    tracing::info!("[db:verify] Verified and queued choice='{}' for code={}, project='{}' (req_id={})", choice, code, project_path, req_id);
    Ok(())
}

/// 将非权限确认的普通消息转发到终端
pub fn forward_message_to_pty(message: &str, message_id: &str) -> Result<(), String> {
    let mut conn = open_db()?;

    // 防止重复转发同一消息
    if !message_id.is_empty() {
        let count: i64 = conn.query_row(
            "SELECT COUNT(1) FROM pty_commands WHERE message_id = ?1",
            rusqlite::params![message_id],
            |row| row.get(0)
        ).unwrap_or(0);

        if count > 0 {
            tracing::info!("[db:forward] Message ID {} already forwarded, skipping duplicate.", message_id);
            return Ok(());
        }
    }

    // 尝试获取活跃的 project_path
    // 首先从 app_config_feishu 读取
    let project_path_res: Option<String> = conn.query_row(
        "SELECT project_path FROM app_config_feishu WHERE id = 1 AND project_path IS NOT NULL AND project_path != '' LIMIT 1",
        [],
        |row| row.get(0),
    ).optional().map_err(|e| format!("Failed to query app_config: {}", e))?;

    let project_path = match project_path_res {
        Some(path) => path,
        None => {
            // 回退: 尝试从最近的 permission_requests 中获取
            let recent_path: Option<String> = conn.query_row(
                "SELECT project_path FROM permission_requests ORDER BY created_at DESC LIMIT 1",
                [],
                |row| row.get(0)
            ).optional().map_err(|e| format!("Failed to query recent permission request: {}", e))?;

            match recent_path {
                Some(path) => path,
                None => {
                    return Err("无法确定当前的 project_path 以转发消息。".to_string());
                }
            }
        }
    };

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;

    // 确保命令以换行符结尾以便在终端中执行
    let command = if message.ends_with('\n') {
        message.to_string()
    } else {
        format!("{}\n", message)
    };

    conn.execute(
        "INSERT INTO pty_commands (project_path, command, message_id, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![project_path, command, message_id, now],
    ).map_err(|e| e.to_string())?;

    tracing::info!("[db:forward] Forwarded message {} to pty for project='{}'", message_id, project_path);
    Ok(())
}


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Card {
    pub config: CardConfig,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub header: Option<CardHeader>,
    pub elements: Vec<CardElement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CardHeader {
    pub title: CardText,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<CardHeaderIcon>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CardHeaderIcon {
    pub tag: String,
    pub img_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CardConfig {
    pub wide_screen_mode: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CardElement {
    #[serde(rename = "tag")]
    pub tag: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<CardText>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actions: Option<Vec<CardAction>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub table: Option<Table>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Table {
    #[serde(rename = "tag")]
    pub tag: String,
    pub elements: Vec<TableElement>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows: Option<Vec<TableElement>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableElement {
    #[serde(rename = "tag")]
    pub tag: String,
    pub cells: Vec<TableCell>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableCell {
    #[serde(rename = "tag")]
    pub tag: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<CardText>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CardText {
    pub content: String,
    #[serde(rename = "tag")]
    pub tag: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CardAction {
    #[serde(rename = "tag")]
    pub tag: String,
    pub text: CardText,
    #[serde(rename = "type")]
    pub action_type: String,
    pub value: serde_json::Value,
}

pub struct FeishuClient {
    client: Client,
    app_id: String,
    app_secret: String,
}

impl FeishuClient {
    pub fn new(app_id: String, app_secret: String) -> Self {
        FeishuClient {
            client: Client::new(),
            app_id,
            app_secret,
        }
    }

    async fn get_tenant_access_token(&self) -> Result<String, anyhow::Error> {
        let token_url = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";
        let masked_id = if self.app_id.len() > 8 {
            format!("{}...", &self.app_id[..8])
        } else {
            self.app_id.clone()
        };
        tracing::info!("[feishu:token] requesting token for app_id={}", masked_id);

        let token_body = serde_json::json!({
            "app_id": self.app_id,
            "app_secret": self.app_secret
        });

        let mut attempts = 0;
        let max_attempts = 3;
        loop {
            attempts += 1;
            match self.client
                .post(token_url)
                .json(&token_body)
                .send()
                .await 
            {
                Ok(response) => {
                    let status = response.status();
                    let text = response.text().await?;
                    let result: serde_json::Value = serde_json::from_str(&text)?;
                    let code = result["code"].as_i64().unwrap_or(-1);
                    let msg = result["msg"].as_str().unwrap_or("Unknown error");
                    tracing::info!("[feishu:token] response: status={}, code={}, msg={}", status, code, msg);
                    
                    if code != 0 {
                        let body_preview = if text.len() > 2000 { &text[..2000] } else { &text };
                        error!(
                            "[feishu:token] FAILED: status={}, code={}, msg={}, body={}",
                            status, code, msg, body_preview
                        );
                        if attempts >= max_attempts {
                            anyhow::bail!("Failed to get token: {}", msg);
                        }
                    } else {
                        let token = result["tenant_access_token"]
                            .as_str()
                            .ok_or_else(|| anyhow::anyhow!("No tenant_access_token in response"))?
                            .to_string();
                        tracing::info!("[feishu:token] obtained token (len={})", token.len());
                        return Ok(token);
                    }
                }
                Err(e) => {
                    error!("[feishu:token] Network error on attempt {}: {}", attempts, e);
                    if attempts >= max_attempts {
                        return Err(anyhow::anyhow!("Failed after {} attempts: {}", max_attempts, e));
                    }
                }
            }
            tracing::warn!("[feishu:token] Retrying in 2 seconds...");
            tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
        }
    }

    pub async fn send_notification(
        &self,
        content: String,
        actions: Option<Vec<CardAction>>,
        receive_id: &str,
    ) -> Result<(), anyhow::Error> {
        self.send_message(receive_id, content, actions, "open_id").await
    }

    /// 发送消息到飞书
    /// receive_id: 可以是 chat_id, open_id, user_id, union_id
    /// receive_id_type: 对应的类型
    pub async fn send_message(
        &self,
        receive_id: &str,
        content: String,
        actions: Option<Vec<CardAction>>,
        receive_id_type: &str,
    ) -> Result<(), anyhow::Error> {
        self.send_message_with_title(receive_id, None, None, content, actions, receive_id_type).await
    }

    pub async fn send_message_with_title(
        &self,
        receive_id: &str,
        title: Option<&str>,
        img_key: Option<&str>,
        content: String,
        actions: Option<Vec<CardAction>>,
        receive_id_type: &str,
    ) -> Result<(), anyhow::Error> {
        let token = self.get_tenant_access_token().await?;

        // 检测是否包含 markdown 表格
        let has_table = content.contains("| --- |") || content.contains("| 文件 |");

        let mut elements: Vec<CardElement> = Vec::new();

        if has_table {
            // 解析 markdown 表格并转换为飞书表格
            let lines: Vec<&str> = content.lines().collect();
            let mut i = 0;
            while i < lines.len() {
                let line = lines[i];
                if line.contains("| --- |") || line.contains("| 文件 |") {
                    // 找到表格开始，解析表头和行
                    let mut table_lines = Vec::new();
                    // 收集表头之前的文本
                    if i > 0 {
                        let before_text: String = lines[..i].join("\n");
                        if !before_text.trim().is_empty() {
                            elements.push(CardElement {
                                tag: "div".to_string(),
                                text: Some(CardText {
                                    content: before_text.trim().to_string(),
                                    tag: "lark_md".to_string(),
                                }),
                                actions: None,
                                table: None,
                            });
                        }
                    }

                    // 跳过表头分隔符
                    i += 1;

                    // 收集表格行
                    while i < lines.len() && lines[i].contains("|") {
                        table_lines.push(lines[i].trim());
                        i += 1;
                    }

                    // 解析表格
                    if table_lines.len() >= 1 {
                        let headers: Vec<String> = table_lines[0]
                            .split('|')
                            .filter(|s| !s.trim().is_empty())
                            .map(|s| s.trim().to_string())
                            .collect();

                        let mut table_rows: Vec<Vec<String>> = Vec::new();
                        for row_line in table_lines.iter().skip(1) {
                            let cells: Vec<String> = row_line
                                .split('|')
                                .filter(|s| !s.trim().is_empty())
                                .map(|s| s.trim().to_string())
                                .collect();
                            if !cells.is_empty() {
                                table_rows.push(cells);
                            }
                        }

                        // 构建飞书表格
                        let mut table_cells: Vec<TableCell> = Vec::new();
                        for h in &headers {
                            table_cells.push(TableCell {
                                tag: "cell".to_string(),
                                text: Some(CardText {
                                    content: h.clone(),
                                    tag: "lark_md".to_string(),
                                }),
                            });
                        }

                        // 转换行数据
                        let table_rows_elements: Vec<TableElement> = table_rows.iter().map(|row| {
                            let cells: Vec<TableCell> = row.iter().map(|cell| {
                                TableCell {
                                    tag: "cell".to_string(),
                                    text: Some(CardText {
                                        content: cell.clone(),
                                        tag: "lark_md".to_string(),
                                    }),
                                }
                            }).collect();
                            TableElement {
                                tag: "tr".to_string(),
                                cells,
                            }
                        }).collect();

                        let table_elements = vec![CardElement {
                            tag: "table".to_string(),
                            text: None,
                            actions: None,
                            table: Some(Table {
                                tag: "table".to_string(),
                                elements: vec![TableElement {
                                    tag: "tr".to_string(),
                                    cells: table_cells,
                                }],
                                rows: Some(table_rows_elements),
                            }),
                        }];

                        elements.extend(table_elements);
                    }
                    continue;
                }
                i += 1;
            }

            // 如果没有解析到表格，添加整个内容
            if elements.is_empty() {
                elements.push(CardElement {
                    tag: "div".to_string(),
                    text: Some(CardText {
                        content,
                        tag: "lark_md".to_string(),
                    }),
                    actions: None,
                    table: None,
                });
            }
        } else {
            // 没有表格，正常发送
            elements.push(CardElement {
                tag: "div".to_string(),
                text: Some(CardText {
                    content,
                    tag: "lark_md".to_string(),
                }),
                actions: None,
                table: None,
            });
        }

        let has_actions = actions.as_ref().map(|a| !a.is_empty()).unwrap_or(false);
        tracing::info!(
            "[feishu:send] building card: elements={}, has_actions={}",
            elements.len(), has_actions
        );

        if let Some(actions) = actions {
            if !actions.is_empty() {
                elements.push(CardElement {
                    tag: "action".to_string(),
                    text: None,
                    actions: Some(actions),
                    table: None,
                });
            }
        }

        let card_header = title.map(|t| CardHeader {
            title: CardText {
                content: t.to_string(),
                tag: "plain_text".to_string(),
            },
            icon: img_key.map(|k| CardHeaderIcon {
                tag: "img".to_string(),
                img_key: k.to_string(),
            }),
            template: Some("blue".to_string()),
        });

        let card = Card {
            config: CardConfig {
                wide_screen_mode: true,
            },
            header: card_header,
            elements,
        };

        let message_url = "https://open.feishu.cn/open-apis/im/v1/messages";
        let card_json = serde_json::to_string(&card)?;
        tracing::info!("[feishu:send] card JSON length={}", card_json.len());

        let message_body = serde_json::json!({
            "receive_id": receive_id,
            "msg_type": "interactive",
            "content": card_json
        });

        tracing::info!(
            "[feishu:send] POST {}: receive_id_type={}, receive_id={}, body_len={}",
            message_url,
            receive_id_type,
            receive_id,
            message_body.to_string().len()
        );

        let mut attempts = 0;
        let max_attempts = 3;
        loop {
            attempts += 1;
            match self.client
                .post(message_url)
                .header("Authorization", format!("Bearer {}", token))
                .query(&[("receive_id_type", receive_id_type)])
                .json(&message_body)
                .send()
                .await 
            {
                Ok(response) => {
                    let status = response.status();
                    let text = response.text().await?;
                    let result: serde_json::Value = serde_json::from_str(&text)?;
                    let code = result["code"].as_i64().unwrap_or(-1);
                    let msg = result["msg"].as_str().unwrap_or("Unknown error");
                    tracing::info!("[feishu:send] response: status={}, code={}, msg={}", status, code, msg);

                    if code != 0 {
                        let body_preview = if text.len() > 2000 { &text[..2000] } else { &text };
                        error!(
                            "[feishu:send] FAILED: status={}, code={}, msg={}, body={}",
                            status, code, msg, body_preview
                        );
                        if attempts >= max_attempts {
                            anyhow::bail!("Failed to send message: {}", msg);
                        }
                    } else {
                        tracing::info!("[feishu:send] message sent successfully");
                        return Ok(());
                    }
                }
                Err(e) => {
                    error!("[feishu:send] Network error on attempt {}: {}", attempts, e);
                    if attempts >= max_attempts {
                        return Err(anyhow::anyhow!("Failed after {} attempts: {}", max_attempts, e));
                    }
                }
            }
            tracing::warn!("[feishu:send] Retrying in 2 seconds...");
            tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
        }
    }
}
