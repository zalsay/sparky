// 此文件已废弃，使用飞书开放平台长连接模式
// 长连接由飞书开放平台维护，无需本地 HTTP 服务器

// 保留此文件以避免编译错误，实际不使用
pub struct AppState;

pub async fn run_server() -> Result<(), anyhow::Error> {
    anyhow::bail!("Server mode is deprecated. Please use Feishu Open Platform long connection mode.")
}
