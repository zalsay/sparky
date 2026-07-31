use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use crate::browser_bridge::BrowserMcpConnection;
use crate::AIProvider;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentKind {
    Claude,
    Codex,
    Pi,
}

impl AgentKind {
    pub fn parse(value: Option<&str>) -> Self {
        match value
            .unwrap_or("claude")
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "codex" | "openai-codex" => Self::Codex,
            "pi" | "pi-coding-agent" => Self::Pi,
            _ => Self::Claude,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Pi => "pi",
        }
    }

    pub fn is_claude(self) -> bool {
        matches!(self, Self::Claude)
    }
}

pub struct AgentLaunchConfig {
    pub command: String,
    pub config_path: Option<PathBuf>,
    pub envs: HashMap<String, String>,
}

struct ProviderConfig {
    value: Value,
    base_url: Option<String>,
    api_key: Option<String>,
    models: Vec<String>,
    api: String,
    default_thinking_level: String,
    context_window: u64,
}

pub fn build_launch_config(
    kind: AgentKind,
    terminal_id: &str,
    provider: Option<&AIProvider>,
    selected_model_id: Option<&str>,
) -> Result<AgentLaunchConfig, String> {
    build_launch_config_with_mcp(kind, terminal_id, provider, selected_model_id, None)
}

pub fn build_launch_config_with_mcp(
    kind: AgentKind,
    terminal_id: &str,
    provider: Option<&AIProvider>,
    selected_model_id: Option<&str>,
    browser_mcp: Option<&BrowserMcpConnection>,
) -> Result<AgentLaunchConfig, String> {
    let provider_config = provider.map(read_provider_config).transpose()?;
    let model_id = selected_model_id
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .or_else(|| {
            provider_config
                .as_ref()
                .and_then(|config| config.models.first().cloned())
        });

    let mut envs = HashMap::new();
    if let Some(api_key) = provider_config
        .as_ref()
        .and_then(|config| config.api_key.clone())
    {
        if !api_key.is_empty() {
            envs.insert("SPARKY_PROVIDER_API_KEY".to_string(), api_key);
        }
    }

    match kind {
        AgentKind::Claude => {
            build_claude_config(terminal_id, provider_config.as_ref(), model_id, envs, browser_mcp)
        }
        AgentKind::Codex => {
            build_codex_config(terminal_id, provider_config.as_ref(), model_id, envs, browser_mcp)
        }
        AgentKind::Pi => build_pi_config(
            terminal_id,
            provider_config.as_ref(),
            model_id,
            envs,
            browser_mcp,
        ),
    }
}

fn read_provider_config(provider: &AIProvider) -> Result<ProviderConfig, String> {
    let value: Value = serde_json::from_str(&provider.settings_config)
        .map_err(|error| format!("Invalid provider settings: {}", error))?;

    let base_url = value
        .get("base_url")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .or_else(|| {
            provider
                .endpoints
                .first()
                .map(|endpoint| endpoint.url.clone())
        });

    let api_key = value
        .get("api_key")
        .and_then(Value::as_str)
        .map(resolve_secret_value)
        .or_else(|| {
            value.get("env").and_then(Value::as_object).and_then(|env| {
                [
                    "SPARKY_PROVIDER_API_KEY",
                    "OPENAI_API_KEY",
                    "ANTHROPIC_AUTH_TOKEN",
                    "ANTHROPIC_API_KEY",
                ]
                .iter()
                .find_map(|key| {
                    env.get(*key)
                        .and_then(Value::as_str)
                        .map(resolve_secret_value)
                })
            })
        });

    let models = value
        .get("model_ids")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter(|model| !model.trim().is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .filter(|items| !items.is_empty())
        .or_else(|| {
            value
                .get("model_id")
                .and_then(Value::as_str)
                .filter(|model| !model.trim().is_empty())
                .map(|model| vec![model.to_string()])
        })
        .unwrap_or_default();

    let api = value
        .get("api")
        .and_then(Value::as_str)
        .or_else(|| value.get("wire_api").and_then(Value::as_str))
        .or(provider.provider_type.as_deref())
        .map(normalize_api)
        .unwrap_or_else(|| normalize_api(&provider.app_type));
    let default_thinking_level =
        normalize_thinking_level(value.get("default_thinking_level").and_then(Value::as_str));
    let context_window = value
        .get("context_window")
        .and_then(Value::as_u64)
        .filter(|window| *window > 0)
        .unwrap_or(256000);

    Ok(ProviderConfig {
        value,
        base_url,
        api_key,
        models,
        api,
        default_thinking_level,
        context_window,
    })
}

fn build_claude_config(
    terminal_id: &str,
    provider: Option<&ProviderConfig>,
    model_id: Option<String>,
    envs: HashMap<String, String>,
    browser_mcp: Option<&BrowserMcpConnection>,
) -> Result<AgentLaunchConfig, String> {
    let mut env = provider
        .and_then(|config| config.value.get("env"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    if let Some(provider) = provider {
        if !env.contains_key("ANTHROPIC_BASE_URL") {
            if let Some(base_url) = &provider.base_url {
                env.insert(
                    "ANTHROPIC_BASE_URL".to_string(),
                    Value::String(base_url.clone()),
                );
            }
        }
        if !env.contains_key("ANTHROPIC_AUTH_TOKEN") && !env.contains_key("ANTHROPIC_API_KEY") {
            if let Some(api_key) = &provider.api_key {
                env.insert(
                    "ANTHROPIC_AUTH_TOKEN".to_string(),
                    Value::String(api_key.clone()),
                );
            }
        }
        if !env.contains_key("ANTHROPIC_MODEL") {
            if let Some(model_id) = model_id {
                env.insert("ANTHROPIC_MODEL".to_string(), Value::String(model_id));
            }
        }
    }

    if provider.is_none() && browser_mcp.is_none() {
        return Ok(AgentLaunchConfig {
            command: "claude".to_string(),
            config_path: None,
            envs,
        });
    }

    let config_path = agent_temp_dir(terminal_id).join("claude-settings.json");
    let settings = json!({ "env": env });
    let mut command = format!("claude --settings {}", shell_quote(&config_path));
    if let Some(browser_mcp) = browser_mcp {
        let mcp_config_path = agent_temp_dir(terminal_id).join("browser-mcp.json");
        write_json(
            &mcp_config_path,
            &json!({
                "mcpServers": {
                    "sparky-browser": {
                        "type": "http",
                        "url": browser_mcp.endpoint,
                        "headers": {
                            "Authorization": format!("Bearer {}", browser_mcp.token),
                        },
                    }
                }
            }),
        )?;
        command.push_str(&format!(" --mcp-config {}", shell_quote(&mcp_config_path)));
    }

    write_json(&config_path, &settings)?;

    Ok(AgentLaunchConfig {
        command,
        config_path: Some(config_path),
        envs,
    })
}

fn build_codex_config(
    terminal_id: &str,
    provider: Option<&ProviderConfig>,
    model_id: Option<String>,
    mut envs: HashMap<String, String>,
    browser_mcp: Option<&BrowserMcpConnection>,
) -> Result<AgentLaunchConfig, String> {
    let config_dir = agent_temp_dir(terminal_id).join("codex");
    fs::create_dir_all(&config_dir)
        .map_err(|error| format!("Failed to create Codex config directory: {}", error))?;

    let config_path = config_dir.join("config.toml");
    let mut content = String::new();
    if let Some(model_id) = model_id {
        content.push_str(&format!("model = {}\n", toml_string(&model_id)));
    }
    content.push_str("model_provider = \"sparky\"\n\n[model_providers.sparky]\n");
    content.push_str("name = \"Sparky\"\n");
    let wire_api = provider
        .and_then(|config| config.value.get("wire_api").and_then(Value::as_str))
        .map(str::to_string)
        .or_else(|| {
            provider.map(|config| {
                if config.api == "openai-completions" {
                    "chat".to_string()
                } else {
                    "responses".to_string()
                }
            })
        })
        .unwrap_or_else(|| "responses".to_string());
    content.push_str(&format!("wire_api = {}\n", toml_string(&wire_api)));
    content.push_str("requires_openai_auth = false\n");
    content.push_str("env_key = \"SPARKY_PROVIDER_API_KEY\"\n");

    if let Some(provider) = provider {
        if let Some(base_url) = &provider.base_url {
            content.push_str(&format!("base_url = {}\n", toml_string(base_url)));
        }
    }

    if let Some(browser_mcp) = browser_mcp {
        content.push_str("\n[mcp_servers.sparky_browser]\n");
        content.push_str(&format!("url = {}\n", toml_string(&browser_mcp.endpoint)));
        content.push_str("bearer_token_env_var = \"SPARKY_BROWSER_MCP_TOKEN\"\n");
        envs.insert(
            "SPARKY_BROWSER_MCP_TOKEN".to_string(),
            browser_mcp.token.clone(),
        );
    }

    write_text(&config_path, &content)?;
    envs.insert(
        "CODEX_HOME".to_string(),
        config_dir.to_string_lossy().to_string(),
    );

    Ok(AgentLaunchConfig {
        command: "codex".to_string(),
        config_path: Some(config_path),
        envs,
    })
}

fn build_pi_config(
    terminal_id: &str,
    provider: Option<&ProviderConfig>,
    model_id: Option<String>,
    mut envs: HashMap<String, String>,
    browser_mcp: Option<&BrowserMcpConnection>,
) -> Result<AgentLaunchConfig, String> {
    let provider = provider.ok_or_else(|| "pi requires a selected model provider".to_string())?;
    let model_id = model_id.ok_or_else(|| "pi requires a selected model".to_string())?;
    let config_dir = agent_temp_dir(terminal_id).join("pi");
    fs::create_dir_all(&config_dir)
        .map_err(|error| format!("Failed to create pi config directory: {}", error))?;
    seed_pi_tool_cache(&config_dir);

    let models = if provider.models.is_empty() {
        vec![model_id.clone()]
    } else {
        provider.models.clone()
    };
    let thinking_levels = ["low", "medium", "high", "xhigh", "max"];
    let thinking_level_map = thinking_levels
        .iter()
        .map(|level| {
            (
                (*level).to_string(),
                if *level == provider.default_thinking_level {
                    Value::String((*level).to_string())
                } else {
                    Value::Null
                },
            )
        })
        .collect::<Map<String, Value>>();
    let model_values: Vec<Value> = models
        .iter()
        .map(|model| {
            json!({
                "id": model,
                "name": model,
                "input": ["text"],
                "contextWindow": provider.context_window,
                "maxTokens": 16384,
                "reasoning": true,
                "thinkingLevelMap": thinking_level_map.clone(),
                "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
            })
        })
        .collect();

    let mut provider_value = Map::new();
    if let Some(base_url) = &provider.base_url {
        provider_value.insert("baseUrl".to_string(), Value::String(base_url.clone()));
    }
    provider_value.insert("api".to_string(), Value::String(provider.api.clone()));
    provider_value.insert(
        "apiKey".to_string(),
        Value::String("$SPARKY_PROVIDER_API_KEY".to_string()),
    );
    provider_value.insert("models".to_string(), Value::Array(model_values));

    let models_path = config_dir.join("models.json");
    write_json(
        &models_path,
        &json!({ "providers": { "sparky": Value::Object(provider_value) } }),
    )?;

    let settings_path = config_dir.join("settings.json");
    let (packages, mut extensions) = mirror_local_pi_resources();
    if let Some(browser_mcp) = browser_mcp {
        let browser_extension_path = config_dir.join("sparky-browser.js");
        write_text(
            &browser_extension_path,
            &pi_browser_extension_source(),
        )?;
        extensions.push(browser_extension_path.to_string_lossy().to_string());
        envs.insert(
            "SPARKY_BROWSER_MCP_URL".to_string(),
            browser_mcp.endpoint.clone(),
        );
        envs.insert(
            "SPARKY_BROWSER_MCP_TOKEN".to_string(),
            browser_mcp.token.clone(),
        );
    }
    let mut settings = json!({
        "defaultProvider": "sparky",
        "defaultModel": model_id,
        "defaultThinkingLevel": provider.default_thinking_level,
        "enableInstallTelemetry": false
    });
    if !packages.is_empty() {
        settings["packages"] = Value::Array(packages);
    }
    if !extensions.is_empty() {
        settings["extensions"] = Value::Array(
            extensions
                .into_iter()
                .map(Value::String)
                .collect(),
        );
    }
    write_json(&settings_path, &settings)?;

    envs.insert(
        "PI_CODING_AGENT_DIR".to_string(),
        config_dir.to_string_lossy().to_string(),
    );

    Ok(AgentLaunchConfig {
        command: "pi".to_string(),
        config_path: Some(models_path),
        envs,
    })
}

fn pi_browser_extension_source() -> &'static str {
    r#"const browserEndpoint = () => process.env.SPARKY_BROWSER_MCP_URL;
const browserToken = () => process.env.SPARKY_BROWSER_MCP_TOKEN;

const string = () => ({ type: "string" });
const integer = (minimum, maximum) => ({ type: "integer", minimum, maximum });
const object = (properties, required = []) => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
});

async function callBrowser(name, args = {}) {
  const endpoint = browserEndpoint();
  const token = browserToken();
  if (!endpoint || !token) {
    throw new Error("Sparky browser bridge is not configured for this Pi session");
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `pi-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`Sparky browser bridge HTTP ${response.status}`);
  }
  if (payload.error) {
    throw new Error(payload.error.message || "Sparky browser bridge request failed");
  }

  const result = payload.result;
  if (!result) return null;
  if (result.isError) {
    const message = (result.content || [])
      .map((item) => item.text || "")
      .filter(Boolean)
      .join("\\n");
    throw new Error(message || "Sparky browser tool failed");
  }
  return result.structuredContent ?? result.content ?? null;
}

function toolResult(value) {
  return {
    content: [{
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    }],
    details: { value },
  };
}

export default function (pi) {
  pi.registerTool({
    name: "browser_targets",
    label: "Browser Targets",
    description: "List browser pages currently embedded in Sparky.",
    promptSnippet: "List browser pages embedded in Sparky",
    parameters: object({ project_path: string() }),
    async execute(_toolCallId, params) {
      return toolResult(await callBrowser("browser_targets", params));
    },
  });

  pi.registerTool({
    name: "browser_attach",
    label: "Browser Attach",
    description: "Attach this Pi session to one Sparky browser page.",
    parameters: object({ target_id: string() }, ["target_id"]),
    async execute(_toolCallId, params) {
      return toolResult(await callBrowser("browser_attach", params));
    },
  });

  pi.registerTool({
    name: "browser_snapshot",
    label: "Browser Snapshot",
    description: "Return an accessibility-oriented snapshot of the attached browser page with stable refs.",
    parameters: object({ target_id: string(), max_chars: integer(1000, 50000) }),
    async execute(_toolCallId, params) {
      return toolResult(await callBrowser("browser_snapshot", params));
    },
  });

  pi.registerTool({
    name: "browser_get_url",
    label: "Browser URL",
    description: "Read the current URL and title of the attached browser page.",
    parameters: object({ target_id: string() }),
    async execute(_toolCallId, params) {
      return toolResult(await callBrowser("browser_get_url", params));
    },
  });

  pi.registerTool({
    name: "browser_click",
    label: "Browser Click",
    description: "Click an element in the attached browser page by snapshot ref or CSS selector.",
    parameters: object({ target_id: string(), ref: string(), selector: string() }),
    async execute(_toolCallId, params) {
      return toolResult(await callBrowser("browser_click", params));
    },
  });

  pi.registerTool({
    name: "browser_fill",
    label: "Browser Fill",
    description: "Fill an input, textarea, or contenteditable element by ref or CSS selector.",
    parameters: object({ target_id: string(), ref: string(), selector: string(), text: string() }, ["text"]),
    async execute(_toolCallId, params) {
      return toolResult(await callBrowser("browser_fill", params));
    },
  });

  pi.registerTool({
    name: "browser_press",
    label: "Browser Press",
    description: "Dispatch a keyboard key to an element or the attached browser page.",
    parameters: object({ target_id: string(), ref: string(), selector: string(), key: string() }, ["key"]),
    async execute(_toolCallId, params) {
      return toolResult(await callBrowser("browser_press", params));
    },
  });

  pi.registerTool({
    name: "browser_scroll",
    label: "Browser Scroll",
    description: "Scroll the attached browser page or an element into view.",
    parameters: object({
      target_id: string(),
      ref: string(),
      selector: string(),
      direction: string(),
      amount: integer(1, 4000),
    }),
    async execute(_toolCallId, params) {
      return toolResult(await callBrowser("browser_scroll", params));
    },
  });

  pi.registerTool({
    name: "browser_wait_for",
    label: "Browser Wait",
    description: "Wait until an element exists in the attached browser page.",
    parameters: object({
      target_id: string(),
      ref: string(),
      selector: string(),
      timeout_ms: integer(100, 30000),
    }),
    async execute(_toolCallId, params) {
      return toolResult(await callBrowser("browser_wait_for", params));
    },
  });

  pi.registerTool({
    name: "browser_navigate",
    label: "Browser Navigate",
    description: "Navigate the attached browser page to an http or https URL.",
    parameters: object({ target_id: string(), url: string() }, ["url"]),
    async execute(_toolCallId, params) {
      return toolResult(await callBrowser("browser_navigate", params));
    },
  });

  pi.registerTool({
    name: "browser_evaluate",
    label: "Browser Evaluate",
    description: "Evaluate a focused JavaScript expression in the attached browser page.",
    parameters: object({ target_id: string(), script: string() }, ["script"]),
    async execute(_toolCallId, params) {
      return toolResult(await callBrowser("browser_evaluate", params));
    },
  });

  pi.registerTool({
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description: "Capture the visible bounds of the attached Sparky browser page and return the PNG path.",
    parameters: object({ target_id: string() }),
    async execute(_toolCallId, params) {
      return toolResult(await callBrowser("browser_screenshot", params));
    },
  });
}
"#
}

fn mirror_local_pi_resources() -> (Vec<Value>, Vec<String>) {
    let Some(agent_dir) = local_pi_agent_dir() else {
        return (Vec::new(), Vec::new());
    };

    let settings_path = agent_dir.join("settings.json");
    let settings = fs::read_to_string(settings_path)
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .unwrap_or_else(|| json!({}));

    let packages = settings
        .get("packages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|package| {
            let source = match package {
                Value::String(source) => source.as_str(),
                Value::Object(package) => package.get("source")?.as_str()?,
                _ => return None,
            };
            let path = local_pi_resource_path(source, &agent_dir)?;
            let path = path.to_string_lossy().to_string();

            match package {
                Value::String(_) => Some(Value::String(path)),
                Value::Object(package) => {
                    let mut mirrored = package.clone();
                    mirrored.insert("source".to_string(), Value::String(path));
                    Some(Value::Object(mirrored))
                }
                _ => None,
            }
        })
        .collect();

    let mut extensions = Vec::new();
    let global_extensions = agent_dir.join("extensions");
    if global_extensions.is_dir() {
        extensions.push(global_extensions.to_string_lossy().to_string());
    }
    if let Some(entries) = settings.get("extensions").and_then(Value::as_array) {
        for entry in entries.iter().filter_map(Value::as_str) {
            let Some(path) = local_pi_resource_path(entry, &agent_dir) else {
                continue;
            };
            let path = path.to_string_lossy().to_string();
            if !extensions.contains(&path) {
                extensions.push(path);
            }
        }
    }

    (packages, extensions)
}

fn local_pi_agent_dir() -> Option<PathBuf> {
    std::env::var_os("PI_CODING_AGENT_DIR")
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .or_else(|| dirs::home_dir().map(|home| home.join(".pi").join("agent")))
        .filter(|path| path.is_dir())
}

fn local_pi_resource_path(source: &str, agent_dir: &Path) -> Option<PathBuf> {
    let source = source.trim();
    let path = if let Some(spec) = source.strip_prefix("npm:") {
        let package_name = npm_package_name(spec)?;
        agent_dir.join("npm").join("node_modules").join(package_name)
    } else if source.starts_with("git:")
        || source.starts_with("http://")
        || source.starts_with("https://")
        || source.starts_with("ssh://")
    {
        return None;
    } else {
        let path = Path::new(source);
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            agent_dir.join(path)
        }
    };

    path.exists().then_some(path)
}

fn npm_package_name(spec: &str) -> Option<&str> {
    let spec = spec.trim();
    if spec.is_empty() {
        return None;
    }
    if spec.starts_with('@') {
        let slash = spec.find('/')?;
        let version = spec[slash + 1..]
            .find('@')
            .map(|index| slash + 1 + index)
            .unwrap_or(spec.len());
        Some(&spec[..version])
    } else {
        Some(spec.split('@').next()?.split('/').next()?)
    }
}

fn normalize_thinking_level(value: Option<&str>) -> String {
    match value
        .unwrap_or("xhigh")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "low" => "low".to_string(),
        "medium" => "medium".to_string(),
        "high" => "high".to_string(),
        "xhigh" => "xhigh".to_string(),
        "max" => "max".to_string(),
        _ => "xhigh".to_string(),
    }
}

fn normalize_api(value: &str) -> String {
    let value = value.trim().to_ascii_lowercase();
    if value.contains("anthropic") || value.contains("claude") {
        "anthropic-messages".to_string()
    } else if value.contains("responses") {
        "openai-responses".to_string()
    } else if value.contains("google") || value.contains("gemini") {
        "google-generative-ai".to_string()
    } else {
        "openai-completions".to_string()
    }
}

fn resolve_secret_value(value: &str) -> String {
    if let Some(name) = value.strip_prefix('$') {
        std::env::var(name).unwrap_or_default()
    } else {
        value.to_string()
    }
}

fn seed_pi_tool_cache(config_dir: &Path) {
    let bin_dir = config_dir.join("bin");
    if fs::create_dir_all(&bin_dir).is_err() {
        return;
    }

    let mut source_dirs = Vec::new();
    if let Some(agent_dir) = std::env::var_os("PI_CODING_AGENT_DIR") {
        source_dirs.push(PathBuf::from(agent_dir).join("bin"));
    }
    if let Some(home_dir) = dirs::home_dir() {
        source_dirs.push(home_dir.join(".pi").join("agent").join("bin"));
    }
    source_dirs.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));

    for tool in ["fd", "rg"] {
        let target = bin_dir.join(tool);
        if target.exists() {
            continue;
        }

        let Some(source) = source_dirs
            .iter()
            .map(|directory| directory.join(tool))
            .find(|path| path.is_file())
        else {
            continue;
        };

        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&source, &target).is_ok();
        #[cfg(not(unix))]
        let linked = false;

        if !linked {
            let _ = fs::copy(&source, &target);
        }
    }
}

fn agent_temp_dir(terminal_id: &str) -> PathBuf {
    std::env::temp_dir().join(format!("sparky_agent_{}", sanitize_id(terminal_id)))
}

fn sanitize_id(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let content = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    write_text(path, &content)
}

fn write_text(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create config directory: {}", error))?;
    }
    fs::write(path, content).map_err(|error| format!("Failed to write agent config: {}", error))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("Failed to restrict agent config permissions: {}", error))?;
    }
    Ok(())
}

fn toml_string(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
    )
}

fn shell_quote(path: &Path) -> String {
    format!("\"{}\"", path.to_string_lossy().replace('"', "\\\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(api: &str) -> AIProvider {
        AIProvider {
            id: "provider-test".to_string(),
            app_type: "generic".to_string(),
            name: "Test Provider".to_string(),
            settings_config: serde_json::json!({
                "api_key": "test-key",
                "base_url": "https://example.test/v1",
                "api": api,
                "model_ids": ["model-a", "model-b"]
            })
            .to_string(),
            website_url: None,
            category: None,
            created_at: None,
            sort_index: None,
            notes: None,
            icon: None,
            icon_color: None,
            meta: "{}".to_string(),
            is_current: false,
            in_failover_queue: false,
            cost_multiplier: "1.0".to_string(),
            limit_daily_usd: None,
            limit_monthly_usd: None,
            provider_type: Some(api.to_string()),
            endpoints: Vec::new(),
        }
    }

    fn remove_generated_config(path: &Path) {
        if let Some(root) = path.parent().and_then(Path::parent) {
            let _ = fs::remove_dir_all(root);
        }
    }

    #[test]
    fn codex_config_uses_selected_model_and_isolated_home() {
        let launch = build_launch_config(
            AgentKind::Codex,
            "test-codex-config",
            Some(&provider("openai-responses")),
            Some("model-b"),
        )
        .expect("Codex config should be generated");

        let config_path = launch.config_path.expect("Codex config path");
        let raw_content = fs::read_to_string(&config_path).expect("read Codex config");
        assert!(raw_content.contains(&format!("model = {}", toml_string("model-b"))));
        assert!(raw_content.contains(&format!("model_provider = {}", toml_string("sparky"))));
        assert!(raw_content.contains(&format!(
            "base_url = {}",
            toml_string("https://example.test/v1")
        )));
        let content = raw_content.replace(
            char::from(34),
            &format!("{}{}", char::from(92), char::from(34)),
        );
        assert!(content.contains("model = \\\"model-b\\\""));
        assert!(content.contains("model_provider = \\\"sparky\\\""));
        assert!(content.contains("base_url = \\\"https://example.test/v1\\\""));
        assert_eq!(
            Path::new(launch.envs.get("CODEX_HOME").expect("CODEX_HOME")),
            config_path.parent().expect("Codex config directory")
        );
        remove_generated_config(&config_path);
    }

    #[test]
    fn claude_config_loads_embedded_browser_mcp_config() {
        let connection = BrowserMcpConnection {
            endpoint: "http://127.0.0.1:41000/mcp?terminal_id=test-terminal".to_string(),
            token: "test-token".to_string(),
        };
        let launch = build_launch_config_with_mcp(
            AgentKind::Claude,
            "test-claude-mcp",
            Some(&provider("anthropic-messages")),
            Some("model-a"),
            Some(&connection),
        )
        .expect("Claude config should be generated");

        assert!(launch.command.contains("--mcp-config"));
        let mcp_path = agent_temp_dir("test-claude-mcp").join("browser-mcp.json");
        let mcp_config: Value = serde_json::from_str(
            &fs::read_to_string(&mcp_path).expect("read browser MCP config"),
        )
        .expect("parse browser MCP config");
        assert_eq!(
            mcp_config["mcpServers"]["sparky-browser"]["type"],
            "http"
        );
        assert_eq!(
            mcp_config["mcpServers"]["sparky-browser"]["url"],
            connection.endpoint
        );
        assert_eq!(
            mcp_config["mcpServers"]["sparky-browser"]["headers"]["Authorization"],
            "Bearer test-token"
        );
        let _ = fs::remove_dir_all(agent_temp_dir("test-claude-mcp"));
    }

    #[test]
    fn pi_config_includes_isolated_browser_extension() {
        let connection = BrowserMcpConnection {
            endpoint: "http://127.0.0.1:41000/mcp?terminal_id=test-pi-browser".to_string(),
            token: "test-token".to_string(),
        };
        let launch = build_launch_config_with_mcp(
            AgentKind::Pi,
            "test-pi-browser",
            Some(&provider("openai-completions")),
            Some("model-b"),
            Some(&connection),
        )
        .expect("pi config should include browser extension");

        let models_path = launch.config_path.expect("pi models path");
        let settings_path = models_path
            .parent()
            .expect("pi config directory")
            .join("settings.json");
        let settings: Value =
            serde_json::from_str(&fs::read_to_string(&settings_path).expect("read pi settings"))
                .expect("parse pi settings");
        let extension_path = settings["extensions"]
            .as_array()
            .and_then(|extensions| {
                extensions
                    .iter()
                    .filter_map(Value::as_str)
                    .find(|path| path.ends_with("sparky-browser.js"))
            })
            .expect("browser extension path");
        assert!(extension_path.ends_with("sparky-browser.js"));
        let extension = fs::read_to_string(extension_path).expect("read browser extension");
        assert!(extension.contains("browser_snapshot"));
        assert!(!extension.contains("test-token"));
        assert!(!extension.contains(&connection.endpoint));
        assert_eq!(
            launch.envs.get("SPARKY_BROWSER_MCP_URL"),
            Some(&connection.endpoint)
        );
        assert_eq!(
            launch.envs.get("SPARKY_BROWSER_MCP_TOKEN"),
            Some(&connection.token)
        );
        remove_generated_config(&models_path);
    }

    #[test]
    fn pi_config_contains_provider_models_and_defaults() {
        let launch = build_launch_config(
            AgentKind::Pi,
            "test-pi-config",
            Some(&provider("openai-completions")),
            Some("model-b"),
        )
        .expect("pi config should be generated");

        let models_path = launch.config_path.expect("pi models path");
        let models: Value =
            serde_json::from_str(&fs::read_to_string(&models_path).expect("read pi models"))
                .expect("parse pi models");
        let settings_path = models_path
            .parent()
            .expect("pi config directory")
            .join("settings.json");
        let settings: Value =
            serde_json::from_str(&fs::read_to_string(settings_path).expect("read pi settings"))
                .expect("parse pi settings");
        assert_eq!(models["providers"]["sparky"]["api"], "openai-completions");
        assert_eq!(models["providers"]["sparky"]["models"][1]["id"], "model-b");
        assert_eq!(
            models["providers"]["sparky"]["models"][1]["contextWindow"],
            256000
        );
        assert_eq!(
            models["providers"]["sparky"]["models"][1]["reasoning"],
            true
        );
        assert_eq!(
            models["providers"]["sparky"]["models"][1]["thinkingLevelMap"]["xhigh"],
            "xhigh"
        );
        assert_eq!(
            models["providers"]["sparky"]["models"][1]["thinkingLevelMap"]["medium"],
            Value::Null
        );
        assert_eq!(
            models["providers"]["sparky"]["models"][1]["thinkingLevelMap"]["max"],
            Value::Null
        );
        assert_eq!(settings["defaultProvider"], "sparky");
        assert_eq!(settings["defaultModel"], "model-b");
        assert_eq!(settings["defaultThinkingLevel"], "xhigh");
        assert_eq!(
            Path::new(
                launch
                    .envs
                    .get("PI_CODING_AGENT_DIR")
                    .expect("PI_CODING_AGENT_DIR")
            ),
            models_path.parent().expect("pi config directory")
        );
        remove_generated_config(&models_path);
    }
}
