use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, Arc};
use portable_pty::{native_pty_system, CommandBuilder, PtySize, PtyPair, Child};
use std::io::{Read, Write};
use std::thread;
use tauri::{Emitter, Manager};
use rusqlite::params;
use serde_json::json;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};

pub struct PtyManager {
    masters: Mutex<HashMap<String, Box<dyn portable_pty::MasterPty + Send>>>,
    children: Mutex<HashMap<String, Box<dyn Child + Send + Sync>>>,
    writers: Mutex<HashMap<String, Box<dyn Write + Send>>>,
    project_terminals: Mutex<HashMap<String, Vec<String>>>,
    spawning: Mutex<HashSet<String>>,
    verified_terminals: Mutex<HashSet<String>>,
    terminal_providers: Mutex<HashMap<String, String>>, // terminal_id -> provider_id
    terminal_settings_paths: Mutex<HashMap<String, std::path::PathBuf>>, // terminal_id -> temp settings file
}

impl PtyManager {
    pub fn new() -> Self {
        PtyManager {
            masters: Mutex::new(HashMap::new()),
            children: Mutex::new(HashMap::new()),
            writers: Mutex::new(HashMap::new()),
            project_terminals: Mutex::new(HashMap::new()),
            spawning: Mutex::new(HashSet::new()),
            verified_terminals: Mutex::new(HashSet::new()),
            terminal_providers: Mutex::new(HashMap::new()),
            terminal_settings_paths: Mutex::new(HashMap::new()),
        }
    }

    pub fn add_pty(&self, project_path: String, terminal_id: String, pair: PtyPair, child: Box<dyn Child + Send + Sync>) {
        log::info!("[add_pty] start for terminal: {}", terminal_id);
        // Remove existing PTY if any
        let _ = self.remove_pty(&terminal_id);

        // Create writer immediately and store it
        let writer = pair.master.take_writer().expect("Failed to take writer");
        log::info!("[add_pty] storing writer for terminal: {}", terminal_id);
        self.writers.lock().unwrap().insert(terminal_id.clone(), writer);

        // Keep only master to drop the slave
        log::info!("[add_pty] storing master for terminal: {}", terminal_id);
        self.masters.lock().unwrap().insert(terminal_id.clone(), pair.master);
        log::info!("[add_pty] storing child for terminal: {}", terminal_id);
        self.children.lock().unwrap().insert(terminal_id.clone(), child);
        
        // Lock project_terminals, update, then DROP the lock BEFORE update_active_ptys_in_db
        {
            let mut pt = self.project_terminals.lock().unwrap();
            let terminals = pt.entry(project_path.clone()).or_insert_with(Vec::new);
            if !terminals.contains(&terminal_id) {
                terminals.push(terminal_id.clone());
            }
        } // <-- lock dropped here

        self.update_active_ptys_in_db();
        log::info!("[add_pty] done for terminal: {}", terminal_id);
    }

    pub fn write(&self, terminal_id: &str, data: &str) -> Result<(), String> {
        let mut writers = self.writers.lock().unwrap();
        if let Some(writer) = writers.get_mut(terminal_id) {
            writer.write_all(data.as_bytes()).map_err(|e| format!("Write error: {}", e))?;
            writer.flush().map_err(|e| format!("Flush error: {}", e))?;
            Ok(())
        } else {
            Err(format!("Writer not found for terminal: {}", terminal_id))
        }
    }

    pub fn remove_pty(&self, terminal_id: &str) -> Option<(Box<dyn portable_pty::MasterPty + Send>, Box<dyn Child + Send + Sync>)> {
        let master = self.masters.lock().unwrap().remove(terminal_id);
        let child = self.children.lock().unwrap().remove(terminal_id);
        // Use try_lock to avoid blocking if the command poller is mid-write
        match self.writers.try_lock() {
            Ok(mut w) => { w.remove(terminal_id); }
            Err(_) => {
                log::warn!("Could not acquire writers lock for terminal: {}, will be cleaned up later", terminal_id);
            }
        }
        
        let mut to_remove_project = None;
        {
            let mut pt = self.project_terminals.lock().unwrap();
            for (project, terminals) in pt.iter_mut() {
                if let Some(pos) = terminals.iter().position(|x| x == terminal_id) {
                    terminals.remove(pos);
                    if terminals.is_empty() {
                        to_remove_project = Some(project.clone());
                    }
                    break;
                }
            }
            if let Some(ref p) = to_remove_project {
                pt.remove(p);
            }
        } // <-- lock dropped here BEFORE update_active_ptys_in_db
        
        let removed = match (master, child) {
            (Some(master), Some(child)) => Some((master, child)),
            _ => None,
        };
        if removed.is_some() {
            self.verified_terminals.lock().unwrap().remove(terminal_id);
            self.terminal_providers.lock().unwrap().remove(terminal_id);
            if let Some(path) = self.terminal_settings_paths.lock().unwrap().remove(terminal_id) {
                if path.exists() {
                    let _ = std::fs::remove_file(&path);
                    log::info!("[remove_pty] Cleaned up settings file for terminal {}", terminal_id);
                }
            }
            self.update_active_ptys_in_db();
        }
        removed
    }

    pub fn has_pty(&self, terminal_id: &str) -> bool {
        self.masters.lock().unwrap().contains_key(terminal_id)
    }

    pub fn mark_verified(&self, terminal_id: &str) {
        let mut verified = self.verified_terminals.lock().unwrap();
        if !verified.contains(terminal_id) {
            log::info!("[mark_verified] terminal {} is now fully ready", terminal_id);
            verified.insert(terminal_id.to_string());
            // Drop lock before db update
            drop(verified);
            self.update_active_ptys_in_db();
        }
    }

    pub fn get_active_projects(&self) -> Vec<String> {
        let pt = self.project_terminals.lock().unwrap();
        let verified = self.verified_terminals.lock().unwrap();
        let mut projects: Vec<String> = pt.iter()
            .filter(|(_, terminals)| terminals.iter().any(|t| verified.contains(t)))
            .map(|(p, _)| p.clone())
            .collect();
        projects.sort();
        projects
    }
    
    pub fn get_primary_terminal_for_project(&self, project_path: &str) -> Option<String> {
        let pt = self.project_terminals.lock().unwrap();
        pt.get(project_path).and_then(|terminals| terminals.first().cloned())
    }

    pub fn get_project_terminal_count(&self, project_path: &str) -> usize {
        let pt = self.project_terminals.lock().unwrap();
        pt.get(project_path).map(|terminals| terminals.len()).unwrap_or(0)
    }

    pub fn get_project_terminal_counts(&self) -> HashMap<String, usize> {
        let pt = self.project_terminals.lock().unwrap();
        pt.iter().map(|(path, terminals)| (path.clone(), terminals.len())).collect()
    }

    pub fn get_project_verified_terminal_count(&self, project_path: &str) -> usize {
        let pt = self.project_terminals.lock().unwrap();
        let verified = self.verified_terminals.lock().unwrap();
        pt.get(project_path)
            .map(|terminals| terminals.iter().filter(|id| verified.contains(*id)).count())
            .unwrap_or(0)
    }

    fn update_active_ptys_in_db(&self) {
        let projects = self.get_active_projects();
        std::thread::spawn(move || {
            if let Ok(conn) = crate::open_db() {
                let _ = conn.execute("DELETE FROM active_ptys", []);
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64;
                for path in projects {
                    let _ = conn.execute(
                        "INSERT INTO active_ptys (project_path, created_at) VALUES (?1, ?2)",
                        params![path, now],
                    );
                }
            }
        });
    }

    pub fn set_terminal_provider(&self, terminal_id: String, provider_id: String) {
        log::info!("[set_terminal_provider] terminal {} -> provider {}", terminal_id, provider_id);
        self.terminal_providers.lock().unwrap().insert(terminal_id, provider_id);
    }

    pub fn get_terminal_provider(&self, terminal_id: &str) -> Option<String> {
        self.terminal_providers.lock().unwrap().get(terminal_id).cloned()
    }

    pub fn store_settings_path(&self, terminal_id: String, path: std::path::PathBuf) {
        log::info!("[store_settings_path] terminal {} -> {:?}", terminal_id, path);
        self.terminal_settings_paths.lock().unwrap().insert(terminal_id, path);
    }

    pub fn get_settings_path(&self, terminal_id: &str) -> Option<String> {
        self.terminal_settings_paths.lock().unwrap()
            .get(terminal_id)
            .map(|p| p.to_string_lossy().to_string())
    }

    pub fn get_provider_details(&self, provider_id: &str) -> Option<crate::AIProvider> {
        let actual_id = provider_id.split("::").last().unwrap_or(provider_id);
        log::info!("[get_provider_details] Searching for provider: {}", actual_id);

        let conn = match crate::open_db() {
            Ok(c) => c,
            Err(e) => {
                log::error!("[get_provider_details] Failed to open DB: {}", e);
                return None;
            }
        };

        let mut stmt = match conn.prepare("SELECT id, app_type, name, settings_config, website_url, category, created_at, sort_index, notes, icon, icon_color, meta, is_current, in_failover_queue, cost_multiplier, limit_daily_usd, limit_monthly_usd, provider_type FROM ai_providers WHERE id = ?") {
            Ok(s) => s,
            Err(e) => {
                log::error!("[get_provider_details] Failed to prepare statement: {}", e);
                return None;
            }
        };

        let provider_res = stmt.query_row(params![actual_id], |row| {
            Ok(crate::AIProvider {
                id: row.get(0)?,
                app_type: row.get(1)?,
                name: row.get(2)?,
                settings_config: row.get(3)?,
                website_url: row.get(4)?,
                category: row.get(5)?,
                created_at: row.get(6)?,
                sort_index: row.get(7)?,
                notes: row.get(8)?,
                icon: row.get(9)?,
                icon_color: row.get(10)?,
                meta: row.get(11)?,
                is_current: row.get(12)?,
                in_failover_queue: row.get(13)?,
                cost_multiplier: row.get(14)?,
                limit_daily_usd: row.get(15)?,
                limit_monthly_usd: row.get(16)?,
                provider_type: row.get(17)?,
                endpoints: Vec::new(),
            })
        });

        let mut provider = match provider_res {
            Ok(p) => p,
            Err(e) => {
                log::error!("[get_provider_details] Query error for ID {}: {}", actual_id, e);
                return None;
            }
        };

        let mut stmt_endpoints = match conn.prepare("SELECT id, provider_id, app_type, url, added_at FROM provider_endpoints WHERE provider_id = ?") {
            Ok(s) => s,
            Err(e) => {
                log::error!("[get_provider_details] Failed to prepare endpoints statement: {}", e);
                return Some(provider);
            }
        };

        let endpoints_iter = match stmt_endpoints.query_map(params![actual_id], |row| {
            Ok(crate::AIProviderEndpoint {
                id: row.get(0)?,
                provider_id: row.get(1)?,
                app_type: row.get(2)?,
                url: row.get(3)?,
                added_at: row.get(4)?,
            })
        }) {
            Ok(it) => it,
            Err(e) => {
                log::error!("[get_provider_details] Endpoints query error: {}", e);
                return Some(provider);
            }
        };

        let mut endpoints = Vec::new();
        for endpoint in endpoints_iter {
            if let Ok(e) = endpoint {
                endpoints.push(e);
            }
        }

        provider.endpoints = endpoints;
        log::info!("[get_provider_details] Successfully loaded provider: {} with {} endpoints", provider.name, provider.endpoints.len());
        Some(provider)
    }

    pub fn get_provider_details_by_app_type(&self, app_type: &str) -> Option<crate::AIProvider> {
        log::info!("[get_provider_details_by_app_type] Searching provider by app_type={}", app_type);

        let conn = match crate::open_db() {
            Ok(c) => c,
            Err(e) => {
                log::error!("[get_provider_details_by_app_type] Failed to open DB: {}", e);
                return None;
            }
        };

        let mut stmt = match conn.prepare(
            "SELECT id, app_type, name, settings_config, website_url, category, created_at, sort_index, notes, icon, icon_color, meta, is_current, in_failover_queue, cost_multiplier, limit_daily_usd, limit_monthly_usd, provider_type FROM ai_providers WHERE app_type = ? ORDER BY is_current DESC, sort_index ASC, created_at ASC LIMIT 1"
        ) {
            Ok(s) => s,
            Err(e) => {
                log::error!("[get_provider_details_by_app_type] Failed to prepare statement: {}", e);
                return None;
            }
        };

        let provider_res = stmt.query_row(params![app_type], |row| {
            Ok(crate::AIProvider {
                id: row.get(0)?,
                app_type: row.get(1)?,
                name: row.get(2)?,
                settings_config: row.get(3)?,
                website_url: row.get(4)?,
                category: row.get(5)?,
                created_at: row.get(6)?,
                sort_index: row.get(7)?,
                notes: row.get(8)?,
                icon: row.get(9)?,
                icon_color: row.get(10)?,
                meta: row.get(11)?,
                is_current: row.get(12)?,
                in_failover_queue: row.get(13)?,
                cost_multiplier: row.get(14)?,
                limit_daily_usd: row.get(15)?,
                limit_monthly_usd: row.get(16)?,
                provider_type: row.get(17)?,
                endpoints: Vec::new(),
            })
        });

        let mut provider = match provider_res {
            Ok(p) => p,
            Err(e) => {
                log::warn!("[get_provider_details_by_app_type] No provider found for app_type={}: {}", app_type, e);
                return None;
            }
        };

        let mut stmt_endpoints = match conn.prepare("SELECT id, provider_id, app_type, url, added_at FROM provider_endpoints WHERE provider_id = ?") {
            Ok(s) => s,
            Err(e) => {
                log::error!("[get_provider_details_by_app_type] Failed to prepare endpoints statement: {}", e);
                return Some(provider);
            }
        };

        let endpoints_iter = match stmt_endpoints.query_map(params![provider.id.clone()], |row| {
            Ok(crate::AIProviderEndpoint {
                id: row.get(0)?,
                provider_id: row.get(1)?,
                app_type: row.get(2)?,
                url: row.get(3)?,
                added_at: row.get(4)?,
            })
        }) {
            Ok(it) => it,
            Err(e) => {
                log::error!("[get_provider_details_by_app_type] Endpoints query error: {}", e);
                return Some(provider);
            }
        };

        let mut endpoints = Vec::new();
        for endpoint in endpoints_iter {
            if let Ok(e) = endpoint {
                endpoints.push(e);
            }
        }

        provider.endpoints = endpoints;
        log::info!(
            "[get_provider_details_by_app_type] Loaded provider: {} ({}) with {} endpoints",
            provider.id,
            provider.app_type,
            provider.endpoints.len()
        );
        Some(provider)
    }
}

#[tauri::command(rename_all = "snake_case")]
pub async fn pty_spawn(
    app: tauri::AppHandle,
    program: String,
    args: Vec<String>,
    cwd: String,
    envs: HashMap<String, String>,
    cols: u16,
    rows: u16,
    project_path: String,
    terminal_id: String,
    default_provider_id: Option<String>,
    selected_model_id: Option<String>,
) -> Result<String, String> {
    // Atomic spawn lock: prevent concurrent duplicate spawns for same terminal
    {
        let manager = app.state::<Arc<PtyManager>>();
        let mut spawning = manager.spawning.lock().unwrap();
        if spawning.contains(&terminal_id) || manager.has_pty(&terminal_id) {
            log::warn!(
                "[pty_spawn] SKIP duplicate for terminal: {} (existing PTY keeps old env; recreate PTY to re-inject proxy vars)",
                terminal_id
            );
            return Ok(terminal_id);
        }
        spawning.insert(terminal_id.clone());
    }

    log::info!("Spawning PTY: program={}, args={:?}, cwd={}, project={}, terminal={}, selected_model={:?}", program, args, cwd, project_path, terminal_id, selected_model_id);

    let manager = app.state::<Arc<PtyManager>>();
    let has_direct_provider = if let Some(ref provider_id) = default_provider_id {
        log::info!("[PTY_SPAWN] Setting provider {} for terminal {}", provider_id, terminal_id);
        manager.set_terminal_provider(terminal_id.clone(), provider_id.clone());
        true
    } else {
        false
    };

    let proxy_config = app.state::<crate::ProxyConfig>();
    let proxy_root_url = format!("http://127.0.0.1:{}", proxy_config.port);

    // Generate temp settings file for `claude --settings` with REAL provider config
    // Same approach as cc-switch: write { "env": { ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, ANTHROPIC_MODEL, ... } }
    if has_direct_provider {
        let provider_id = default_provider_id.as_ref().unwrap();
        if let Some(provider) = manager.get_provider_details(provider_id) {
            let config: serde_json::Value = serde_json::from_str(&provider.settings_config)
                .unwrap_or(serde_json::json!({}));

            // If settings_config already has cc-switch format { "env": { ... } }, use it as base
            let mut env_vars = if let Some(env_obj) = config.get("env").and_then(|v| v.as_object()) {
                env_obj.clone()
            } else {
                serde_json::Map::new()
            };

            // API URL
            if !env_vars.contains_key("ANTHROPIC_BASE_URL") {
                let base_url = config
                    .get("base_url")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .or_else(|| {
                        provider.endpoints.first().map(|e| e.url.clone())
                    });
                if let Some(ref url) = base_url {
                    env_vars.insert("ANTHROPIC_BASE_URL".to_string(), serde_json::Value::String(url.clone()));
                }
            }

            // API key
            if !env_vars.contains_key("ANTHROPIC_AUTH_TOKEN") && !env_vars.contains_key("ANTHROPIC_API_KEY") {
                if let Some(key) = config.get("api_key").and_then(|v| v.as_str()) {
                    env_vars.insert("ANTHROPIC_AUTH_TOKEN".to_string(), serde_json::Value::String(key.to_string()));
                }
            }

            // Model ID: use selected_model_id if provided, else fallback to model_ids[0] or model_id
            if !env_vars.contains_key("ANTHROPIC_MODEL") {
                let chosen_model = selected_model_id.clone()
                    .or_else(|| {
                        config.get("model_ids")
                            .and_then(|v| v.as_array())
                            .and_then(|arr| arr.first())
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                    })
                    .or_else(|| {
                        config.get("model_id")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                    });

                if let Some(model_id) = chosen_model {
                    let model_val = serde_json::Value::String(model_id);
                    env_vars.insert("ANTHROPIC_MODEL".to_string(), model_val.clone());
                    env_vars.entry("ANTHROPIC_DEFAULT_HAIKU_MODEL".to_string()).or_insert(model_val.clone());
                    env_vars.entry("ANTHROPIC_DEFAULT_SONNET_MODEL".to_string()).or_insert(model_val.clone());
                    env_vars.entry("ANTHROPIC_DEFAULT_OPUS_MODEL".to_string()).or_insert(model_val.clone());
                }
            }

            let temp_dir = std::env::temp_dir();
            let settings_file = temp_dir.join(format!("sparky_claude_settings_{}.json", terminal_id));
            let settings = serde_json::json!({ "env": env_vars });
            let content = serde_json::to_string_pretty(&settings)
                .map_err(|e| format!("Failed to serialize settings: {}", e))?;
            std::fs::write(&settings_file, &content)
                .map_err(|e| format!("Failed to write settings file: {}", e))?;

            log::info!(
                "[PTY_SPAWN] Direct provider settings: provider={}({}) base_url={:?} model={:?} file={:?}",
                provider.name, provider.id,
                env_vars.get("ANTHROPIC_BASE_URL"),
                env_vars.get("ANTHROPIC_MODEL"),
                settings_file
            );
            manager.store_settings_path(terminal_id.clone(), settings_file);
        }
    }

    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    let actual_program = if program.is_empty() {
        std::env::var("SHELL").unwrap_or_else(|_| if cfg!(target_os = "windows") { "cmd.exe".to_string() } else { "sh".to_string() })
    } else {
        program.clone()
    };

    let mut cmd = CommandBuilder::new(&actual_program);
    cmd.args(&args);
    cmd.cwd(&cwd);

    // When injecting provider settings via --settings, remove inherited Anthropic env vars
    // to avoid conflicts (e.g., "Auth conflict: Both AUTH_TOKEN and API_KEY are set")
    // CommandBuilder::new() inherits ALL parent env vars via get_base_env(),
    // so cmd.env_remove() is required — merely skipping cmd.env() does NOT work.
    if has_direct_provider {
        cmd.env_remove("ANTHROPIC_API_KEY");
        cmd.env_remove("ANTHROPIC_AUTH_TOKEN");
        cmd.env_remove("ANTHROPIC_BASE_URL");
        cmd.env_remove("ANTHROPIC_MODEL");
        cmd.env_remove("ANTHROPIC_SMALL_FAST_MODEL");
        cmd.env_remove("ANTHROPIC_DEFAULT_HAIKU_MODEL");
        cmd.env_remove("ANTHROPIC_DEFAULT_SONNET_MODEL");
        cmd.env_remove("ANTHROPIC_DEFAULT_OPUS_MODEL");
    }

    // Inject utility env vars (no proxy routing — provider config is in --settings file)
    cmd.env("SPARKY_PROXY_BASE_URL", &proxy_root_url);
    cmd.env("SPARKY_TERMINAL_ID", &terminal_id);
    
    // Ensure UTF-8 locale is set so Chinese characters work properly in the PTY
    cmd.env("LANG", "en_US.UTF-8");
    cmd.env("LC_ALL", "en_US.UTF-8");
    log::info!(
        "[PTY_SPAWN] Utility env set for terminal {}: SPARKY_TERMINAL_ID, SPARKY_PROXY_BASE_URL",
        terminal_id
    );
    let mut has_hook = false;
    for (key, value) in envs {
        if key == "CLAUDE_MONITOR_HOOK_COMMAND" {
            has_hook = true;
        }
        cmd.env(&key, &value);
    }
    if !has_hook {
        if let Ok(hook_cmd) = crate::build_hook_command() {
            cmd.env("CLAUDE_MONITOR_HOOK_COMMAND", hook_cmd);
        }
    }

    let child = pair.slave.spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn command: {}", e))?;

    // Store the pair and child with project path as key
    let manager = app.state::<Arc<PtyManager>>();
    manager.add_pty(project_path.clone(), terminal_id.clone(), pair, child);

    let _ = app.emit("pty-spawn", json!({
        "projectPath": project_path.clone(),
    }));

    // Remove from spawning set
    manager.spawning.lock().unwrap().remove(&terminal_id);

    log::info!("[pty_spawn] PTY stored for terminal: {}", terminal_id);

    // Spawn a task to read from the PTY
    let app_handle = app.clone();

    // Get a reader clone
    let master_reader = {
        let manager = app.state::<Arc<PtyManager>>();
        let master_guard = manager.masters.lock().unwrap();
        let master = master_guard.get(&terminal_id).unwrap();
        master.try_clone_reader().map_err(|e| format!("Failed to clone master: {}", e))?
    };

    // PTY Reader Thread
    let project_path_clone = project_path.clone();
    let terminal_id_clone = terminal_id.clone();

    thread::spawn(move || {
        let mut reader = master_reader;
        let mut buf = [0u8; 1024];
        let mut pending: Vec<u8> = Vec::new();

        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    // ... (rest of parsing logic)
                    loop {
                        match std::str::from_utf8(&pending) {
                            Ok(valid) => {
                                if !valid.is_empty() {
                                    // Mark terminal as verified now that it has produced output
                                    app_handle.state::<Arc<PtyManager>>().mark_verified(&terminal_id_clone);
                                    let _ = app_handle.emit("pty-data", serde_json::json!({
                                        "projectPath": project_path_clone,
                                        "terminalId": terminal_id_clone,
                                        "data": valid
                                    }));
                                }
                                pending.clear();
                                break;
                            }
                            Err(err) => {
                                let valid_up_to = err.valid_up_to();
                                if valid_up_to > 0 {
                                    let valid = unsafe { std::str::from_utf8_unchecked(&pending[..valid_up_to]) };
                                    app_handle.state::<Arc<PtyManager>>().mark_verified(&terminal_id_clone);
                                    let _ = app_handle.emit("pty-data", serde_json::json!({
                                        "projectPath": project_path_clone,
                                        "terminalId": terminal_id_clone,
                                        "data": valid
                                    }));
                                }
                                if let Some(error_len) = err.error_len() {
                                    pending.drain(0..valid_up_to + error_len);
                                    let _ = app_handle.emit("pty-data", serde_json::json!({
                                        "projectPath": project_path_clone,
                                        "terminalId": terminal_id_clone,
                                        "data": ""
                                    }));
                                    continue;
                                } else {
                                    pending = pending[valid_up_to..].to_vec();
                                    break;
                                }
                            }
                        }
                    }
                }
                Err(_) => break,
            }
        }
        if !pending.is_empty() {
            if let Ok(valid) = std::str::from_utf8(&pending) {
                if !valid.is_empty() {
                     let _ = app_handle.emit("pty-data", serde_json::json!({
                        "projectPath": project_path_clone,
                        "terminalId": terminal_id_clone,
                        "data": valid
                    }));
                }
            }
        }
        log::info!("PTY reader thread exiting for terminal: {}", terminal_id_clone);
        let _ = app_handle.emit("pty-exit", serde_json::json!({
            "projectPath": project_path_clone,
            "terminalId": terminal_id_clone,
        }));
    });

    // Spawn a task to poll for remote commands from DB
    // Only one poller per project is needed, but we currently spawn per pty.
    // To handle multiple terminals cleanly, we can still run it, but we should make sure we only write to the 'primary' terminal.
    let app_handle_for_poll = app.clone();
    let project_path_for_poll = project_path.clone();
    let terminal_id_for_poll = terminal_id.clone();
    
    thread::spawn(move || {
        log::info!("PTY command poller started for terminal: {}", terminal_id_for_poll);
        loop {
            thread::sleep(std::time::Duration::from_millis(500));
            
            // Check if THIS PTY still exists
            let manager = app_handle_for_poll.state::<Arc<PtyManager>>();
            if !manager.has_pty(&terminal_id_for_poll) {
                log::info!("PTY closed, stopping command poller for terminal: {}", terminal_id_for_poll);
                break;
            }

            // check if this is the primary terminal. If not we just sleep and continue, so we don't multiply execute commands.
            let primary_terminal_id = manager.get_primary_terminal_for_project(&project_path_for_poll);
            if primary_terminal_id != Some(terminal_id_for_poll.clone()) {
                // Not the primary terminal, don't poll
                continue;
            }

            // Open DB connection
            let conn = match crate::open_db() {
                Ok(c) => c,
                Err(e) => {
                    log::error!("Failed to open DB in poller: {}", e);
                    continue;
                }
            };

            // Query unprocessed commands
            let mut stmt = match conn.prepare(
                "SELECT id, command FROM pty_commands WHERE project_path = ?1 AND processed = 0 ORDER BY created_at ASC"
            ) {
                Ok(s) => s,
                Err(e) => {
                    log::error!("Failed to prepare polling statement: {}", e);
                    continue;
                }
            };

            let commands: Vec<(i64, String)> = stmt.query_map(params![project_path_for_poll], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .and_then(|mapped_rows| mapped_rows.collect())
            .unwrap_or_default();

            for (id, cmd) in commands {
                log::info!("Executing remote command: {} (id={}) on primary terminal {}", cmd, id, terminal_id_for_poll);
                
                // Construct input
                let mut input = cmd.to_string();
                if !input.ends_with('\r') && !input.ends_with('\n') {
                    input.push('\r');
                }
                
                // Write to PTY
                if let Err(e) = manager.write(&terminal_id_for_poll, &input) {
                    log::error!("Failed to write to primary PTY: {}", e);
                } else {
                    log::info!("Successfully wrote '{}' to PTY for project: {}", input, project_path_for_poll);
                    // Mark as processed
                    let _ = conn.execute(
                        "UPDATE pty_commands SET processed = 1 WHERE id = ?1",
                        params![id],
                    );
                }
            }
        }
    });

    Ok(terminal_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn pty_write(app: tauri::AppHandle, terminal_id: String, data: String) -> Result<(), String> {
    log::debug!("PTY write: terminal={}, data={}", terminal_id, data);

    let manager = app.state::<Arc<PtyManager>>();
    manager.write(&terminal_id, &data)
}

#[tauri::command(rename_all = "snake_case")]
pub fn pty_kill(app: tauri::AppHandle, terminal_id: String) -> Result<(), String> {
    log::info!("[pty_kill] START terminal={}", terminal_id);

    let manager = app.state::<Arc<PtyManager>>();
    
    log::info!("[pty_kill] acquiring masters lock...");
    let master = manager.masters.lock().unwrap().remove(&terminal_id);
    log::info!("[pty_kill] masters done, master found={}", master.is_some());
    
    log::info!("[pty_kill] acquiring children lock...");
    let child = manager.children.lock().unwrap().remove(&terminal_id);
    log::info!("[pty_kill] children done, child found={}", child.is_some());
    
    log::info!("[pty_kill] trying writers lock...");
    match manager.writers.try_lock() {
        Ok(mut w) => { 
            w.remove(&terminal_id); 
            log::info!("[pty_kill] writers removed");
        }
        Err(_) => { 
            log::warn!("[pty_kill] writers lock CONTENDED, skipping for: {}", terminal_id); 
        }
    }
    
    log::info!("[pty_kill] acquiring project_terminals lock...");
    {
        let mut pt = manager.project_terminals.lock().unwrap();
        let mut to_remove = None;
        for (project, terminals) in pt.iter_mut() {
            if let Some(pos) = terminals.iter().position(|x| x == &terminal_id) {
                terminals.remove(pos);
                if terminals.is_empty() {
                    to_remove = Some(project.clone());
                }
                break;
            }
        }
        if let Some(ref p) = to_remove {
            pt.remove(p);
        }
    }
    log::info!("[pty_kill] project_terminals done");
    
    manager.update_active_ptys_in_db();

    if let (Some(master), Some(mut child)) = (master, child) {
        log::info!("[pty_kill] spawning background kill thread...");
        let tid = terminal_id.clone();
        std::thread::spawn(move || {
            log::info!("[pty_kill bg] calling child.kill() for: {}", tid);
            let _ = child.kill();
            log::info!("[pty_kill bg] child.kill() done, dropping master for: {}", tid);
            drop(master);
            log::info!("[pty_kill bg] COMPLETE for: {}", tid);
        });
    } else {
        log::warn!("[pty_kill] PTY not found for: {}", terminal_id);
    }

    log::info!("[pty_kill] returning Ok for: {}", terminal_id);
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn pty_resize(app: tauri::AppHandle, terminal_id: String, cols: u16, rows: u16) -> Result<(), String> {
    log::info!("PTY resize: terminal={}, cols={}, rows={}", terminal_id, cols, rows);

    let manager = app.state::<Arc<PtyManager>>();
    let mut masters = manager.masters.lock().unwrap();

    if let Some(master) = masters.get_mut(&terminal_id) {
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Resize error: {}", e))?;
        Ok(())
    } else {
        Err(format!("PTY not found for terminal: {}", terminal_id))
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn pty_exists(app: tauri::AppHandle, terminal_id: String) -> bool {
    let manager = app.state::<Arc<PtyManager>>();
    let exists = manager.has_pty(&terminal_id);
    if exists {
        log::warn!(
            "[pty_exists] Reusing existing terminal {}. Existing shell env is kept; if proxy logs are missing, close and recreate terminal.",
            terminal_id
        );
    } else {
        log::info!("[pty_exists] Terminal {} does not exist, will spawn new PTY", terminal_id);
    }
    exists
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_terminal_active_process(app: tauri::AppHandle, terminal_id: String) -> Result<String, String> {
    let manager = app.state::<Arc<PtyManager>>();
    let children = manager.children.lock().unwrap();
    
    let shell_pid = if let Some(child) = children.get(&terminal_id) {
        let pid = child.process_id();
        log::debug!("get_terminal_active_process: terminal={} shell_pid={:?}", terminal_id, pid);
        pid
    } else {
        log::warn!("get_terminal_active_process: PTY not found for terminal={}", terminal_id);
        return Err("PTY not found".to_string());
    };

    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::default()
    );

    let mut active_proc = "shell".to_string();
    for process in sys.processes().values() {
        if let Some(ppid) = process.parent() {
            if Some(ppid.as_u32()) == shell_pid {
                let name = process.name().to_string_lossy().to_lowercase();
                log::debug!("get_terminal_active_process: found child={} for shell_pid={:?}", name, shell_pid);
                if name.contains("claude") {
                    return Ok("claude".to_string());
                }
                if active_proc == "shell" {
                    active_proc = name;
                }
            }
        }
    }

    Ok(active_proc)
}
