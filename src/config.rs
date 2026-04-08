//! Configuration loading for Sparky.

use crate::project::Projects;
use std::path::PathBuf;

/// Resolve the config file path.
/// Priority: PROJECT_CONFIG_DIR env > /etc/sparky/projects.json > /etc/sparky/projects.toml
pub fn config_path() -> PathBuf {
    if let Some(dir) = std::env::var_os("PROJECT_CONFIG_DIR") {
        let dir = PathBuf::from(dir);
        if dir.join("projects.json").exists() {
            return dir.join("projects.json");
        }
        return dir.join("projects.toml");
    }

    for candidate in [
        "/etc/sparky/projects.json",
        "/etc/cc-bridge/projects.json",
        "/etc/sparky/projects.toml",
        "/etc/cc-bridge/projects.toml",
    ] {
        let path = PathBuf::from(candidate);
        if path.exists() {
            return path;
        }
    }

    PathBuf::from("/etc/sparky/projects.toml")
}

/// Load projects from the resolved config path.
/// Returns empty Projects on error (logs warning).
pub fn load_projects() -> Projects {
    let path = config_path();
    match std::fs::read_to_string(&path) {
        Ok(content) => match serde_json::from_str::<Projects>(&content) {
            Ok(p) => {
                log::info!(
                    "Loaded {} projects from {}",
                    p.projects.len(),
                    path.display()
                );
                p
            }
            Err(e) => {
                log::warn!("Failed to parse {}: {}", path.display(), e);
                Projects::default()
            }
        },
        Err(e) => {
            log::warn!("No config at {}: {}", path.display(), e);
            Projects::default()
        }
    }
}

/// Resolve the writable root used to store project files.
pub fn projects_root() -> PathBuf {
    std::env::var("PROJECTS_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/projects"))
}

/// Resolve the writable custom-project config root.
pub fn custom_projects_root() -> PathBuf {
    if let Some(path) = std::env::var_os("CUSTOM_PROJECTS_FILE") {
        let path = PathBuf::from(path);
        if path.extension().is_some() {
            return path
                .parent()
                .map(PathBuf::from)
                .unwrap_or_else(|| projects_root().join(".sparky"));
        }
        return path;
    }

    projects_root().join(".sparky")
}

fn env_bool(name: &str, default: bool) -> bool {
    match std::env::var(name) {
        Ok(v) => match v.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => true,
            "0" | "false" | "no" | "off" => false,
            _ => default,
        },
        Err(_) => default,
    }
}

/// Server-level configuration.
#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub port: u16,
    pub sandbox_root: PathBuf,
    pub web_dist_dir: PathBuf,
    pub claude_user_state_template: PathBuf,
    pub claude_settings_template: PathBuf,
    pub ssh_known_hosts_template: Option<PathBuf>,
    pub ssh_auth_sock: Option<String>,
    pub database_url: Option<String>,
    pub db_max_connections: u32,
    pub bwrap_unshare_user: bool,
}

fn find_existing_path(candidates: &[&str], fallback: &str) -> PathBuf {
    candidates
        .iter()
        .map(PathBuf::from)
        .find(|path| path.exists())
        .unwrap_or_else(|| PathBuf::from(fallback))
}

impl ServerConfig {
    pub fn new() -> Self {
        let port: u16 = std::env::var("PORT")
            .unwrap_or_else(|_| "3001".to_string())
            .parse()
            .unwrap_or(3001);

        let sandbox_root = std::env::var("SANDBOX_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("/tmp/cc-sandbox"));

        let web_dist_dir = std::env::var("WEB_DIST_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                let container_path = PathBuf::from("/app/web-dist");
                if container_path.exists() {
                    container_path
                } else {
                    find_existing_path(
                        &[
                            "/root/.openclaw/workspace/sparky-web/web/dist",
                            "/root/.openclaw/workspace/cc-bridge-web/dist",
                        ],
                        "/root/.openclaw/workspace/sparky-web/web/dist",
                    )
                }
            });

        let claude_user_state_template = std::env::var("CLAUDE_USER_STATE_TEMPLATE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                find_existing_path(
                    &[
                        "/etc/sparky/claude-user-state.json",
                        "/workspace/sparky-web/config/claude-user-state.json",
                        "/root/.openclaw/workspace/sparky-web/config/claude-user-state.json",
                        "/etc/cc-bridge/claude-user-state.json",
                        "/workspace/cc-bridge/config/claude-user-state.json",
                        "/root/.openclaw/workspace/cc-bridge/config/claude-user-state.json",
                    ],
                    "/etc/sparky/claude-user-state.json",
                )
            });

        let claude_settings_template = std::env::var("CLAUDE_SETTINGS_TEMPLATE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                find_existing_path(
                    &[
                        "/etc/sparky/claude-settings.json",
                        "/workspace/sparky-web/config/claude-settings.json",
                        "/root/.openclaw/workspace/sparky-web/config/claude-settings.json",
                        "/etc/cc-bridge/claude-settings.json",
                        "/workspace/cc-bridge/config/claude-settings.json",
                        "/root/.openclaw/workspace/cc-bridge/config/claude-settings.json",
                    ],
                    "/etc/sparky/claude-settings.json",
                )
            });

        let ssh_known_hosts_template = std::env::var("SSH_KNOWN_HOSTS_TEMPLATE")
            .ok()
            .map(PathBuf::from)
            .or_else(|| {
                let path = find_existing_path(
                    &[
                        "/etc/sparky/known_hosts",
                        "/workspace/sparky-web/config/known_hosts",
                        "/root/.openclaw/workspace/sparky-web/config/known_hosts",
                        "/etc/cc-bridge/known_hosts",
                        "/workspace/cc-bridge/config/known_hosts",
                        "/root/.openclaw/workspace/cc-bridge/config/known_hosts",
                    ],
                    "/etc/sparky/known_hosts",
                );
                path.exists().then_some(path)
            });

        let ssh_auth_sock = std::env::var("SSH_AUTH_SOCK")
            .ok()
            .filter(|value| !value.trim().is_empty());

        let database_url = std::env::var("DATABASE_URL")
            .ok()
            .filter(|value| !value.trim().is_empty());

        let db_max_connections = std::env::var("DB_MAX_CONNECTIONS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(5);

        let bwrap_unshare_user = std::env::var("SPARKY_BWRAP_UNSHARE_USER")
            .ok()
            .map(|value| match value.trim().to_ascii_lowercase().as_str() {
                "1" | "true" | "yes" | "on" => true,
                "0" | "false" | "no" | "off" => false,
                _ => true,
            })
            .unwrap_or_else(|| env_bool("CC_BRIDGE_BWRAP_UNSHARE_USER", true));

        Self {
            port,
            sandbox_root,
            web_dist_dir,
            claude_user_state_template,
            claude_settings_template,
            ssh_known_hosts_template,
            ssh_auth_sock,
            database_url,
            db_max_connections,
            bwrap_unshare_user,
        }
    }
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self::new()
    }
}
