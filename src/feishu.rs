use reqwest::Client;
use serde::{Deserialize, Serialize};
use rusqlite::{params, Connection};
use std::fs;
use std::path::PathBuf;
use tracing::error;

/// 打开 SQLite 数据库连接
fn open_db() -> Result<Connection, String> {
    let home = dirs::home_dir().ok_or("Failed to get home dir".to_string())?;
    // CLI 和 GUI 使用相同的数据库路径
    let db_path = home.join("sparky/hooks.db");
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Card {
    pub config: CardConfig,
    pub elements: Vec<CardElement>,
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

        let response = self
            .client
            .post(token_url)
            .json(&token_body)
            .send()
            .await?;

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
            anyhow::bail!("Failed to get token: {}", msg);
        }

        let token = result["tenant_access_token"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("No tenant_access_token in response"))?
            .to_string();
        tracing::info!("[feishu:token] obtained token (len={})", token.len());
        Ok(token)
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

        let card = Card {
            config: CardConfig {
                wide_screen_mode: true,
            },
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

        let response = self
            .client
            .post(message_url)
            .header("Authorization", format!("Bearer {}", token))
            .query(&[("receive_id_type", receive_id_type)])
            .json(&message_body)
            .send()
            .await?;

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
            anyhow::bail!("Failed to send message: {}", msg);
        }

        tracing::info!("[feishu:send] message sent successfully");
        Ok(())
    }
}
