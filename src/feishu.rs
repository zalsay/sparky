use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// 获取保存的 open_id 文件路径
fn get_open_id_path() -> PathBuf {
    let config_dir = dirs::config_dir()
        .expect("Failed to get config directory")
        .join("com.claude.monitor");
    std::fs::create_dir_all(&config_dir).expect("Failed to create config directory");
    config_dir.join("last_open_id.txt")
}

/// 从文件读取上次保存的 open_id
pub fn get_last_open_id() -> Option<String> {
    let path = get_open_id_path();
    fs::read_to_string(path).ok().map(|s| s.trim().to_string())
}

/// 保存 open_id 到文件（供 Tauri 应用调用）
pub fn save_open_id(open_id: &str) -> Result<(), std::io::Error> {
    let path = get_open_id_path();
    fs::write(path, open_id)
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

        let result: serde_json::Value = response.json().await?;
        
        if result["code"].as_i64().unwrap_or(-1) != 0 {
            anyhow::bail!("Failed to get token: {}", result["msg"].as_str().unwrap_or("Unknown error"));
        }

        Ok(result["tenant_access_token"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("No tenant_access_token in response"))?
            .to_string())
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
        let message_body = serde_json::json!({
            "receive_id": receive_id,
            "msg_type": "interactive",
            "content": serde_json::to_string(&card)?
        });

        let response = self
            .client
            .post(message_url)
            .header("Authorization", format!("Bearer {}", token))
            .query(&[("receive_id_type", receive_id_type)])
            .json(&message_body)
            .send()
            .await?;

        let result: serde_json::Value = response.json().await?;

        if result["code"].as_i64().unwrap_or(-1) != 0 {
            anyhow::bail!("Failed to send message: {}", result["msg"].as_str().unwrap_or("Unknown error"));
        }

        Ok(())
    }
}
