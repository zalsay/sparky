use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, PtySize, PtyPair, Child};
use std::io::{Read, Write};
use std::thread;
use tauri::{Emitter, Manager};
use rusqlite::params;

pub struct PtyManager {
    masters: Mutex<HashMap<String, Box<dyn portable_pty::MasterPty + Send>>>,
    children: Mutex<HashMap<String, Box<dyn Child + Send + Sync>>>,
    writers: Mutex<HashMap<String, Box<dyn Write + Send>>>,
    project_terminals: Mutex<HashMap<String, Vec<String>>>,
    spawning: Mutex<HashSet<String>>,
    verified_terminals: Mutex<HashSet<String>>,
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
) -> Result<String, String> {
    // Atomic spawn lock: prevent concurrent duplicate spawns for same terminal
    {
        let manager = app.state::<PtyManager>();
        let mut spawning = manager.spawning.lock().unwrap();
        if spawning.contains(&terminal_id) || manager.has_pty(&terminal_id) {
            log::info!("[pty_spawn] SKIP duplicate for terminal: {}", terminal_id);
            return Ok(terminal_id);
        }
        spawning.insert(terminal_id.clone());
    }

    log::info!("Spawning PTY: program={}, args={:?}, cwd={}, project={}, terminal={}", program, args, cwd, project_path, terminal_id);

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
    // 继承父进程环境变量，再覆盖指定的
    for (key, value) in std::env::vars() {
        cmd.env(&key, &value);
    }
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
    let manager = app.state::<PtyManager>();
    manager.add_pty(project_path.clone(), terminal_id.clone(), pair, child);

    // Remove from spawning set
    manager.spawning.lock().unwrap().remove(&terminal_id);

    log::info!("[pty_spawn] PTY stored for terminal: {}", terminal_id);

    // Spawn a task to read from the PTY
    let app_handle = app.clone();

    // Get a reader clone
    let master_reader = {
        let manager = app.state::<PtyManager>();
        let master_guard = manager.masters.lock().unwrap();
        let master = master_guard.get(&terminal_id).unwrap();
        master.try_clone_reader().map_err(|e| format!("Failed to clone master: {}", e))?
    };

    // PTY Reader Thread
    let project_path_clone = project_path.clone();
    let terminal_id_clone = terminal_id.clone();
    let log_path = get_pty_log_path(&project_path); // Might want to add terminal_id to log path?
    
    // Ensure directory exists
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    thread::spawn(move || {
        let mut reader = master_reader;
        let mut buf = [0u8; 1024];
        let mut pending: Vec<u8> = Vec::new();

        // Open log file in the thread
        let mut log_file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .ok();

        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    // Write to log file
                    if let Some(f) = log_file.as_mut() {
                        let _ = f.write_all(&buf[..n]);
                        let _ = f.flush();
                    }

                    pending.extend_from_slice(&buf[..n]);
                    // ... (rest of parsing logic)
                    loop {
                        match std::str::from_utf8(&pending) {
                            Ok(valid) => {
                                if !valid.is_empty() {
                                    // Mark terminal as verified now that it has produced output
                                    app_handle.state::<PtyManager>().mark_verified(&terminal_id_clone);
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
                                    app_handle.state::<PtyManager>().mark_verified(&terminal_id_clone);
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
            let manager = app_handle_for_poll.state::<PtyManager>();
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

fn get_pty_log_path(project_path: &str) -> std::path::PathBuf {
    let home = dirs::home_dir().expect("Failed to get home dir");
    let safe_name = project_path.replace("/", "_").replace(":", "_");
    home.join("sparky/pty_logs").join(format!("{}.log", safe_name))
}

#[tauri::command(rename_all = "snake_case")]
pub fn pty_write(app: tauri::AppHandle, terminal_id: String, data: String) -> Result<(), String> {
    log::debug!("PTY write: terminal={}, data={}", terminal_id, data);

    let manager = app.state::<PtyManager>();
    manager.write(&terminal_id, &data)
}

#[tauri::command(rename_all = "snake_case")]
pub fn pty_kill(app: tauri::AppHandle, terminal_id: String) -> Result<(), String> {
    log::info!("[pty_kill] START terminal={}", terminal_id);

    let manager = app.state::<PtyManager>();
    
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

    let manager = app.state::<PtyManager>();
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
    let manager = app.state::<PtyManager>();
    manager.has_pty(&terminal_id)
}
