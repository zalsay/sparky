use reqwest::Client;

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

        let response = self.client.post(token_url).json(&token_body).send().await?;
        let result: serde_json::Value = response.json().await?;
        
        let token = result["tenant_access_token"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("No tenant_access_token in response: {:?}", result))?
            .to_string();
        Ok(token)
    }

    pub async fn send_text_message(&self, receive_id: &str, text: &str) -> Result<(), anyhow::Error> {
        let token = self.get_tenant_access_token().await?;
        let message_url = "https://open.feishu.cn/open-apis/im/v1/messages";
        
        let body = serde_json::json!({
            "receive_id": receive_id,
            "msg_type": "text",
            "content": serde_json::to_string(&serde_json::json!({"text": text}))?
        });

        let response = self.client
            .post(message_url)
            .header("Authorization", format!("Bearer {}", token))
            .query(&[("receive_id_type", "open_id")])
            .json(&body)
            .send()
            .await?;

        let result: serde_json::Value = response.json().await?;
        let code = result["code"].as_i64().unwrap_or(-1);
        if code != 0 {
            anyhow::bail!("Failed to send message: {}", result["msg"]);
        }
        Ok(())
    }
}
