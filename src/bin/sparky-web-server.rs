use std::path::PathBuf;

use clap::Parser;
use tracing_subscriber::EnvFilter;

use sparky_server::web_server::{config::WebServerConfig, start_server};

#[derive(Parser, Debug)]
#[command(name = "sparky-web-server")]
struct Cli {
    /// Config path (default: ~/.sparky/web-server.json)
    #[arg(long)]
    config: Option<PathBuf>,
    /// Bind address (override config)
    #[arg(long)]
    bind: Option<String>,
}

#[tokio::main]
async fn main() -> Result<(), anyhow::Error> {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt().with_env_filter(filter).init();

    let cli = Cli::parse();
    let mut config = WebServerConfig::load(cli.config)?;
    if let Some(bind) = cli.bind {
        config.bind = bind;
    }

    start_server(config).await
}
