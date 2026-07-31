use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, Arc};
use portable_pty::{native_pty_system, CommandBuilder, PtySize, PtyPair, Child};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::thread;
use tauri::{Emitter, Manager};
use rusqlite::params;
use serde::Serialize;
use serde_json::{json, Value};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
use crate::agent::{self, AgentKind};

pub struct PtyManager {
    masters: Mutex<HashMap<String, Box<dyn portable_pty::MasterPty + Send>>>,
    children: Mutex<HashMap<String, Box<dyn Child + Send + Sync>>>,
    writers: Mutex<HashMap<String, Box<dyn Write + Send>>>,
    project_terminals: Mutex<HashMap<String, Vec<String>>>,
    spawning: Mutex<HashSet<String>>,
    verified_terminals: Mutex<HashSet<String>>,
    terminal_providers: Mutex<HashMap<String, String>>, // terminal_id -> provider_id
    terminal_agents: Mutex<HashMap<String, String>>, // terminal_id -> agent type
    terminal_commands: Mutex<HashMap<String, String>>, // terminal_id -> launch command
    terminal_settings_paths: Mutex<HashMap<String, std::path::PathBuf>>, // terminal_id -> generated config file
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
            terminal_agents: Mutex::new(HashMap::new()),
            terminal_commands: Mutex::new(HashMap::new()),
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
            self.terminal_agents.lock().unwrap().remove(terminal_id);
            self.terminal_commands.lock().unwrap().remove(terminal_id);
            if let Some(path) = self.terminal_settings_paths.lock().unwrap().remove(terminal_id) {
                if let Some(parent) = path.parent() {
                    let _ = std::fs::remove_dir_all(parent);
                } else {
                    let _ = std::fs::remove_file(&path);
                }
                log::info!("[remove_pty] Cleaned up generated config for terminal {}", terminal_id);
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

    pub fn get_project_agent_session_roots(&self, project_path: &str) -> Vec<(String, PathBuf)> {
        let terminal_ids = self
            .project_terminals
            .lock()
            .unwrap()
            .get(project_path)
            .cloned()
            .unwrap_or_default();
        terminal_ids
            .into_iter()
            .filter_map(|terminal_id| {
                let agent_type = self.terminal_agents.lock().unwrap().get(&terminal_id).cloned()?;
                let settings_path = self
                    .terminal_settings_paths
                    .lock()
                    .unwrap()
                    .get(&terminal_id)
                    .cloned()?;
                Some((agent_type, settings_path.parent()?.join("sessions")))
            })
            .collect()
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

    pub fn store_agent_launch(&self, terminal_id: String, agent_type: String, command: String, config_path: Option<std::path::PathBuf>) {
        self.terminal_agents.lock().unwrap().insert(terminal_id.clone(), agent_type);
        self.terminal_commands.lock().unwrap().insert(terminal_id.clone(), command);
        if let Some(path) = config_path {
            self.store_settings_path(terminal_id, path);
        }
    }

    pub fn get_agent_type(&self, terminal_id: &str) -> Option<String> {
        self.terminal_agents.lock().unwrap().get(terminal_id).cloned()
    }

    pub fn get_agent_command(&self, terminal_id: &str) -> Option<String> {
        self.terminal_commands.lock().unwrap().get(terminal_id).cloned()
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

struct SpawnReservation {
    manager: Arc<PtyManager>,
    terminal_id: String,
}

impl Drop for SpawnReservation {
    fn drop(&mut self) {
        self.manager.spawning.lock().unwrap().remove(&self.terminal_id);
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
    agent_type: Option<String>,
) -> Result<String, String> {
    // Atomic spawn lock: prevent concurrent duplicate spawns for same terminal
    {
        let manager = app.state::<Arc<PtyManager>>();
        let mut spawning = manager.spawning.lock().unwrap();
        if spawning.contains(&terminal_id) || manager.has_pty(&terminal_id) {
            log::warn!(
                "[pty_spawn] SKIP duplicate for terminal: {} (existing PTY keeps its Agent configuration; recreate it to change Agent or provider)",
                terminal_id
            );
            return Ok(terminal_id);
        }
        spawning.insert(terminal_id.clone());
    }

    let _spawn_reservation = {
        let manager = app.state::<Arc<PtyManager>>();
        SpawnReservation {
            manager: manager.inner().clone(),
            terminal_id: terminal_id.clone(),
        }
    };

    log::info!("Spawning PTY: program={}, args={:?}, cwd={}, project={}, terminal={}, selected_model={:?}", program, args, cwd, project_path, terminal_id, selected_model_id);

    let manager = app.state::<Arc<PtyManager>>();
    let agent_kind = AgentKind::parse(agent_type.as_deref());
    let provider = default_provider_id
        .as_deref()
        .and_then(|provider_id| manager.get_provider_details(provider_id));
    if let Some(provider_id) = default_provider_id.as_ref() {
        log::info!("[PTY_SPAWN] Setting provider {} for {} terminal {}", provider_id, agent_kind.as_str(), terminal_id);
        manager.set_terminal_provider(terminal_id.clone(), provider_id.clone());
    }

    let browser_mcp = app
        .state::<Arc<crate::browser_bridge::BrowserMcpState>>()
        .connection(&terminal_id);
    let launch = agent::build_launch_config_with_mcp(
        agent_kind,
        &terminal_id,
        provider.as_ref(),
        selected_model_id.as_deref(),
        browser_mcp.as_ref(),
    )?;

    log::info!(
        "[PTY_SPAWN] Agent launch prepared: agent={}, command={}, config={:?}",
        agent_kind.as_str(),
        launch.command,
        launch.config_path
    );

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

    if agent_kind.is_claude() {
        cmd.env_remove("ANTHROPIC_API_KEY");
        cmd.env_remove("ANTHROPIC_AUTH_TOKEN");
        cmd.env_remove("ANTHROPIC_BASE_URL");
        cmd.env_remove("ANTHROPIC_MODEL");
        cmd.env_remove("ANTHROPIC_SMALL_FAST_MODEL");
        cmd.env_remove("ANTHROPIC_DEFAULT_HAIKU_MODEL");
        cmd.env_remove("ANTHROPIC_DEFAULT_SONNET_MODEL");
        cmd.env_remove("ANTHROPIC_DEFAULT_OPUS_MODEL");
    }

    for (key, value) in &launch.envs {
        cmd.env(key, value);
    }
    cmd.env("SPARKY_TERMINAL_ID", &terminal_id);
    cmd.env("SPARKY_AGENT_TYPE", agent_kind.as_str());

    // Ensure UTF-8 locale is set so non-ASCII input/output works properly in the PTY.
    cmd.env("LANG", "en_US.UTF-8");
    cmd.env("LC_ALL", "en_US.UTF-8");

    let mut has_hook = false;
    for (key, value) in envs {
        if key == "CLAUDE_MONITOR_HOOK_COMMAND" {
            if !agent_kind.is_claude() {
                continue;
            }
            has_hook = true;
        }
        cmd.env(&key, &value);
    }
    if agent_kind.is_claude() && !has_hook {
        if let Ok(hook_cmd) = crate::build_hook_command() {
            cmd.env("CLAUDE_MONITOR_HOOK_COMMAND", hook_cmd);
        }
    }

    let child = pair.slave.spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn command: {}", e))?;

    // Store the pair and child with project path as key.
    let manager = app.state::<Arc<PtyManager>>();
    manager.add_pty(project_path.clone(), terminal_id.clone(), pair, child);
    manager.store_agent_launch(
        terminal_id.clone(),
        agent_kind.as_str().to_string(),
        launch.command,
        launch.config_path,
    );

    let _ = app.emit("pty-spawn", json!({
        "projectPath": project_path.clone(),
        "agentType": agent_kind.as_str(),
    }));

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
        // Natural process exit must use the same cleanup path as an explicit kill.
        let manager = app_handle.state::<Arc<PtyManager>>();
        if manager.has_pty(&terminal_id_clone) {
            let _ = manager.remove_pty(&terminal_id_clone);
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
pub fn get_terminal_agent_command(app: tauri::AppHandle, terminal_id: String) -> Result<String, String> {
    let manager = app.state::<Arc<PtyManager>>();
    manager
        .get_agent_command(&terminal_id)
        .ok_or_else(|| format!("No launch command found for terminal: {}", terminal_id))
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentSessionInfo {
    pub session_id: String,
    pub agent_type: String,
    pub project_path: String,
    pub started_at: i64,
    pub last_active_at: i64,
    pub title: String,
}

struct StoredAgentSession {
    info: AgentSessionInfo,
    source_path: PathBuf,
    source_root: PathBuf,
}

fn resolved_path(path: &str) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path))
}

fn paths_match(left: &str, right: &Path) -> bool {
    resolved_path(left) == resolved_path(right.to_string_lossy().as_ref())
}

fn pi_agent_dir() -> Option<PathBuf> {
    std::env::var_os("PI_CODING_AGENT_DIR")
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .or_else(|| dirs::home_dir().map(|home| home.join(".pi").join("agent")))
        .filter(|path| path.is_dir())
}

fn codex_home() -> Option<PathBuf> {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))
        .filter(|path| path.is_dir())
}

fn timestamp_millis(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::Number(number)) => {
            let value = number.as_i64().or_else(|| number.as_f64().map(|v| v as i64))?;
            Some(if value < 10_000_000_000 { value * 1000 } else { value })
        }
        Some(Value::String(value)) => chrono::DateTime::parse_from_rfc3339(value)
            .ok()
            .map(|date| date.timestamp_millis()),
        _ => None,
    }
}

fn modified_millis(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

fn text_from_content(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) if !text.trim().is_empty() => Some(text.trim().to_string()),
        Some(Value::Array(items)) => items.iter().find_map(|item| {
            item.get("text")
                .and_then(Value::as_str)
                .filter(|text| !text.trim().is_empty())
                .map(|text| text.trim().to_string())
        }),
        _ => None,
    }
}

fn session_title(text: Option<String>, agent_type: &str) -> String {
    let text = text
        .unwrap_or_else(|| format!("{} 会话", agent_type))
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let mut title = text.chars().take(96).collect::<String>();
    if text.chars().count() > 96 {
        title.push_str("...");
    }
    title
}

fn pi_session_dir_name(project_path: &Path) -> String {
    let path = project_path.to_string_lossy();
    let trimmed = path.trim_start_matches(|value| value == '/' || value == '\\');
    let safe = trimmed
        .chars()
        .map(|value| if matches!(value, '/' | '\\' | ':') { '-' } else { value })
        .collect::<String>();
    format!("--{}--", safe)
}

fn parse_pi_session(path: &Path, project_path: &Path, source_root: &Path) -> Option<StoredAgentSession> {
    let file = std::fs::File::open(path).ok()?;
    let mut session_id = None;
    let mut cwd = None;
    let mut started_at = None;
    let mut title = None;

    for line in BufReader::new(file).lines().take(256).flatten() {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) == Some("session") {
            session_id = value.get("id").and_then(Value::as_str).map(str::to_string);
            cwd = value.get("cwd").and_then(Value::as_str).map(str::to_string);
            started_at = timestamp_millis(value.get("timestamp"));
        }
        if title.is_none()
            && value.get("type").and_then(Value::as_str) == Some("message")
            && value
                .get("message")
                .and_then(|message| message.get("role"))
                .and_then(Value::as_str)
                == Some("user")
        {
            title = value
                .get("message")
                .and_then(|message| text_from_content(message.get("content")));
        }
    }

    let session_id = session_id.filter(|value| is_session_id(value))?;
    let cwd = cwd?;
    if !paths_match(&cwd, project_path) {
        return None;
    }
    let started_at = started_at.unwrap_or_else(|| modified_millis(path));
    Some(StoredAgentSession {
        info: AgentSessionInfo {
            session_id,
            agent_type: "pi".to_string(),
            project_path: project_path.to_string_lossy().to_string(),
            started_at,
            last_active_at: modified_millis(path),
            title: session_title(title, "PI"),
        },
        source_path: path.to_path_buf(),
        source_root: source_root.to_path_buf(),
    })
}

fn parse_codex_session(path: &Path, project_path: &Path, source_root: &Path) -> Option<StoredAgentSession> {
    let file = std::fs::File::open(path).ok()?;
    let mut session_id = None;
    let mut cwd = None;
    let mut started_at = None;
    let mut title = None;

    for line in BufReader::new(file).lines().take(256).flatten() {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) == Some("session_meta") {
            let payload = value.get("payload")?;
            session_id = payload.get("id").and_then(Value::as_str).map(str::to_string);
            cwd = payload.get("cwd").and_then(Value::as_str).map(str::to_string);
            started_at = timestamp_millis(payload.get("timestamp"));
        }
        if value.get("type").and_then(Value::as_str) == Some("event_msg") {
            let payload = value.get("payload")?;
            if cwd.is_none() && payload.get("type").and_then(Value::as_str) == Some("turn_context") {
                cwd = payload.get("cwd").and_then(Value::as_str).map(str::to_string);
            }
            if title.is_none() && payload.get("type").and_then(Value::as_str) == Some("user_message") {
                title = payload.get("message").and_then(Value::as_str).map(str::to_string);
            }
        }
    }

    let session_id = session_id.filter(|value| is_session_id(value))?;
    let cwd = cwd?;
    if !paths_match(&cwd, project_path) {
        return None;
    }
    let started_at = started_at.unwrap_or_else(|| modified_millis(path));
    Some(StoredAgentSession {
        info: AgentSessionInfo {
            session_id,
            agent_type: "codex".to_string(),
            project_path: project_path.to_string_lossy().to_string(),
            started_at,
            last_active_at: modified_millis(path),
            title: session_title(title, "codex"),
        },
        source_path: path.to_path_buf(),
        source_root: source_root.to_path_buf(),
    })
}

fn collect_agent_sessions(
    project_path: &Path,
    additional_roots: &[(String, PathBuf)],
) -> Vec<StoredAgentSession> {
    let mut sessions = Vec::new();
    if let Some(agent_dir) = pi_agent_dir() {
        let root = agent_dir.join("sessions");
        let mut pi_files = Vec::new();
        collect_session_files(&root, &mut pi_files);
        sessions.extend(
            pi_files
                .iter()
                .filter_map(|path| parse_pi_session(path, project_path, &root)),
        );
    }
    if let Some(home) = codex_home() {
        for root in [home.join("sessions"), home.join("archived_sessions")] {
            let mut codex_files = Vec::new();
            collect_session_files(&root, &mut codex_files);
            sessions.extend(
                codex_files
                    .iter()
                    .filter_map(|path| parse_codex_session(path, project_path, &root)),
            );
        }
    }
    for (agent_type, root) in additional_roots {
        let mut files = Vec::new();
        collect_session_files(root, &mut files);
        if agent_type == "pi" {
            sessions.extend(
                files
                    .iter()
                    .filter_map(|path| parse_pi_session(path, project_path, root)),
            );
        } else if agent_type == "codex" {
            sessions.extend(
                files
                    .iter()
                    .filter_map(|path| parse_codex_session(path, project_path, root)),
            );
        }
    }

    sessions.sort_by(|left, right| right.info.last_active_at.cmp(&left.info.last_active_at));
    let mut seen = HashSet::new();
    sessions.retain(|session| {
        seen.insert(format!("{}:{}", session.info.agent_type, session.info.session_id))
    });
    sessions.truncate(100);
    sessions
}

fn find_agent_session(
    project_path: &Path,
    additional_roots: &[(String, PathBuf)],
    agent_type: &str,
    session_id: &str,
) -> Option<StoredAgentSession> {
    collect_agent_sessions(project_path, additional_roots)
        .into_iter()
        .find(|session| {
            session.info.agent_type == agent_type && session.info.session_id == session_id
        })
}

fn copy_session_to_terminal(
    session: &StoredAgentSession,
    target_config_dir: &Path,
    project_path: &Path,
) -> Result<(), String> {
    let relative_path = if session.info.agent_type == "pi" {
        PathBuf::from("sessions")
            .join(pi_session_dir_name(project_path))
            .join(session.source_path.file_name().ok_or("Invalid session filename")?)
    } else {
        let relative = session
            .source_path
            .strip_prefix(&session.source_root)
            .map(PathBuf::from)
            .or_else(|_| {
                session
                    .source_path
                    .file_name()
                    .map(PathBuf::from)
                    .ok_or(())
            })
            .map_err(|_| "Invalid session filename")?;
        PathBuf::from("sessions").join(relative)
    };
    let destination = target_config_dir.join(relative_path);
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("Create session directory failed: {}", error))?;
    }
    std::fs::copy(&session.source_path, &destination)
        .map_err(|error| format!("Copy session history failed: {}", error))?;
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_agent_session_history(
    app: tauri::AppHandle,
    project_path: String,
) -> Result<Vec<AgentSessionInfo>, String> {
    let manager = app.state::<Arc<PtyManager>>();
    let additional_roots = manager.get_project_agent_session_roots(&project_path);
    Ok(collect_agent_sessions(Path::new(&project_path), &additional_roots)
        .into_iter()
        .map(|session| session.info)
        .collect())
}

#[tauri::command(rename_all = "snake_case")]
pub fn prepare_agent_session(
    app: tauri::AppHandle,
    terminal_id: String,
    project_path: String,
    agent_type: String,
    session_id: String,
) -> Result<(), String> {
    if !session_id
        .chars()
        .all(|value| value.is_ascii_alphanumeric() || matches!(value, '-' | '_'))
    {
        return Err("Invalid session id".to_string());
    }
    if agent_type != "pi" && agent_type != "codex" {
        return Err(format!("Unsupported session agent: {}", agent_type));
    }

    let manager = app.state::<Arc<PtyManager>>();
    let settings_path = manager
        .get_settings_path(&terminal_id)
        .ok_or_else(|| format!("No Agent config found for terminal: {}", terminal_id))?;
    let target_config_dir = Path::new(&settings_path)
        .parent()
        .ok_or_else(|| format!("Invalid Agent config path for terminal: {}", terminal_id))?;
    let project_path_ref = Path::new(&project_path);
    let additional_roots = manager.get_project_agent_session_roots(&project_path);
    let session = find_agent_session(
        project_path_ref,
        &additional_roots,
        &agent_type,
        &session_id,
    )
    .ok_or_else(|| format!("Session not found for project: {}", project_path))?;
    copy_session_to_terminal(&session, target_config_dir, project_path_ref)
}

fn is_session_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|index| bytes[*index] == b'-')
        && bytes.iter().enumerate().all(|(index, byte)| {
            [8, 13, 18, 23].contains(&index)
                || byte.is_ascii_hexdigit()
        })
}

#[cfg(test)]
mod agent_session_tests {
    use super::*;

    #[test]
    fn parses_pi_and_codex_session_formats() {
        let root = std::env::temp_dir().join(format!("sparky-agent-session-test-{}", uuid::Uuid::new_v4()));
        let project = root.join("project");
        let pi_root = root.join("pi");
        let codex_root = root.join("codex");
        std::fs::create_dir_all(&project).expect("create project directory");
        std::fs::create_dir_all(&pi_root).expect("create pi directory");
        std::fs::create_dir_all(&codex_root).expect("create codex directory");

        let pi_id = "019fab65-a9da-7333-b3c1-6834ed819c74";
        let pi_path = pi_root.join("pi.jsonl");
        std::fs::write(
            &pi_path,
            format!(
                "{}\n{}\n",
                json!({
                    "type": "session",
                    "id": pi_id,
                    "timestamp": "2026-07-29T01:03:14.394Z",
                    "cwd": project,
                }),
                json!({
                    "type": "message",
                    "message": {
                        "role": "user",
                        "content": [{ "type": "text", "text": "Review the project" }]
                    }
                })
            ),
        )
        .expect("write pi session");

        let codex_id = "019d4c3f-fc2a-7031-8701-f9bedf2d69a4";
        let codex_path = codex_root.join("rollout.jsonl");
        std::fs::write(
            &codex_path,
            format!(
                "{}\n{}\n",
                json!({
                    "type": "session_meta",
                    "payload": {
                        "id": codex_id,
                        "timestamp": "2026-04-02T11:32:34.257Z",
                        "cwd": project,
                    }
                }),
                json!({
                    "type": "event_msg",
                    "payload": { "type": "user_message", "message": "Fix the PTY layout" }
                })
            ),
        )
        .expect("write codex session");

        let pi = parse_pi_session(&pi_path, &project, &pi_root).expect("parse pi session");
        assert_eq!(pi.info.agent_type, "pi");
        assert_eq!(pi.info.session_id, pi_id);
        assert_eq!(pi.info.title, "Review the project");

        let codex = parse_codex_session(&codex_path, &project, &codex_root).expect("parse codex session");
        assert_eq!(codex.info.agent_type, "codex");
        assert_eq!(codex.info.session_id, codex_id);
        assert_eq!(codex.info.title, "Fix the PTY layout");

        std::fs::remove_dir_all(root).expect("remove test directory");
    }
}

fn collect_session_files(root: &std::path::Path, files: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_session_files(&path, files);
        } else if path.extension().and_then(|value| value.to_str()) == Some("jsonl") {
            files.push(path);
        }
    }
}

fn read_session_id(path: &std::path::Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let first_line = BufReader::new(file).lines().find_map(Result::ok)?;
    let value: serde_json::Value = serde_json::from_str(first_line.trim()).ok()?;
    let entry_type = value.get("type").and_then(serde_json::Value::as_str);
    if entry_type != Some("session") && entry_type != Some("session_meta") {
        return None;
    }

    ["id", "session_id", "sessionId"]
        .iter()
        .find_map(|key| value.get(*key).and_then(serde_json::Value::as_str))
        .filter(|value| is_session_id(value))
        .map(str::to_string)
}

fn find_latest_session_id(root: &std::path::Path) -> Option<String> {
    let mut files = Vec::new();
    collect_session_files(root, &mut files);
    files.sort_by_key(|path| {
        std::fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .unwrap_or(std::time::UNIX_EPOCH)
    });
    files.into_iter().rev().find_map(|path| read_session_id(&path))
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_terminal_session_id(app: tauri::AppHandle, terminal_id: String) -> Result<String, String> {
    let manager = app.state::<Arc<PtyManager>>();
    let settings_path = manager
        .get_settings_path(&terminal_id)
        .ok_or_else(|| format!("No Agent config found for terminal: {}", terminal_id))?;
    let config_dir = std::path::Path::new(&settings_path)
        .parent()
        .ok_or_else(|| format!("Invalid Agent config path for terminal: {}", terminal_id))?;

    find_latest_session_id(config_dir).ok_or_else(|| {
        format!("No persisted Agent session found for terminal: {}", terminal_id)
    })
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
    let removed = manager.remove_pty(&terminal_id);

    if let Some((master, mut child)) = removed {
        let tid = terminal_id.clone();
        std::thread::spawn(move || {
            log::info!("[pty_kill bg] killing child for terminal {}", tid);
            let _ = child.kill();
            drop(master);
            log::info!("[pty_kill bg] COMPLETE for terminal {}", tid);
        });
    } else {
        log::warn!("[pty_kill] PTY not found for: {}", terminal_id);
    }

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
            "[pty_exists] Reusing existing terminal {}. Existing Agent environment is kept; recreate the terminal after changing Agent or provider.",
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

    let expected_agent = manager
        .get_agent_type(&terminal_id)
        .unwrap_or_else(|| "shell".to_string());
    let mut active_proc = "shell".to_string();
    for process in sys.processes().values() {
        if let Some(ppid) = process.parent() {
            if Some(ppid.as_u32()) == shell_pid {
                let name = process.name().to_string_lossy().to_lowercase();
                log::debug!("get_terminal_active_process: found child={} for shell_pid={:?}", name, shell_pid);
                if name.contains(&expected_agent) || (expected_agent == "pi" && name.contains("node")) {
                    return Ok(expected_agent.clone());
                }
                if active_proc == "shell" {
                    active_proc = name;
                }
            }
        }
    }

    Ok(active_proc)
}
