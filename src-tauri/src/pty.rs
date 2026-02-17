use std::collections::HashMap;
use std::sync::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, PtySize, PtyPair, Child};
use std::io::{Read, Write};
use std::thread;
use tauri::{Emitter, Manager};

pub struct PtyManager {
    pty_pairs: Mutex<HashMap<String, PtyPair>>,
    children: Mutex<HashMap<String, Box<dyn Child + Send + Sync>>>,
    writers: Mutex<HashMap<String, Box<dyn Write + Send>>>,
}

impl PtyManager {
    pub fn new() -> Self {
        PtyManager {
            pty_pairs: Mutex::new(HashMap::new()),
            children: Mutex::new(HashMap::new()),
            writers: Mutex::new(HashMap::new()),
        }
    }

    pub fn add_pty(&self, project_path: String, pair: PtyPair, child: Box<dyn Child + Send + Sync>) {
        // Remove existing PTY if any
        let _ = self.remove_pty(&project_path);

        // Create writer immediately and store it
        let writer = pair.master.take_writer().expect("Failed to take writer");
        self.writers.lock().unwrap().insert(project_path.clone(), writer);

        self.pty_pairs.lock().unwrap().insert(project_path.clone(), pair);
        self.children.lock().unwrap().insert(project_path, child);
    }

    pub fn write(&self, project_path: &str, data: &str) -> Result<(), String> {
        let mut writers = self.writers.lock().unwrap();
        if let Some(writer) = writers.get_mut(project_path) {
            writer.write_all(data.as_bytes()).map_err(|e| format!("Write error: {}", e))?;
            writer.flush().map_err(|e| format!("Flush error: {}", e))?;
            Ok(())
        } else {
            Err(format!("Writer not found for project: {}", project_path))
        }
    }

    pub fn remove_pty(&self, project_path: &str) -> Option<(PtyPair, Box<dyn Child + Send + Sync>)> {
        let pair = self.pty_pairs.lock().unwrap().remove(project_path);
        let child = self.children.lock().unwrap().remove(project_path);
        let _writer = self.writers.lock().unwrap().remove(project_path);
        match (pair, child) {
            (Some(pair), Some(child)) => Some((pair, child)),
            _ => None,
        }
    }

    pub fn has_pty(&self, project_path: &str) -> bool {
        self.pty_pairs.lock().unwrap().contains_key(project_path)
    }
}

#[tauri::command]
pub async fn pty_spawn(
    app: tauri::AppHandle,
    program: String,
    args: Vec<String>,
    cwd: String,
    envs: HashMap<String, String>,
    cols: u16,
    rows: u16,
    project_path: String,
) -> Result<String, String> {
    log::info!("Spawning PTY: program={}, args={:?}, cwd={}, project={}", program, args, cwd, project_path);

    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    let mut cmd = CommandBuilder::new(&program);
    cmd.args(&args);
    cmd.cwd(&cwd);
    for (key, value) in envs {
        cmd.env(&key, &value);
    }

    let child = pair.slave.spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn command: {}", e))?;

    // Store the pair and child with project path as key
    let manager = app.state::<PtyManager>();
    manager.add_pty(project_path.clone(), pair, child);

    log::info!("PTY spawned for project: {}", project_path);

    // Spawn a task to read from the PTY
    let app_handle = app.clone();

    // Get a reader clone
    let master_reader = {
        let manager = app.state::<PtyManager>();
        let pair_guard = manager.pty_pairs.lock().unwrap();
        let pair = pair_guard.get(&project_path).unwrap();
        pair.master.try_clone_reader().map_err(|e| format!("Failed to clone master: {}", e))?
    };

    // PTY Reader Thread
    let project_path_clone = project_path.clone();
    let log_path = get_pty_log_path(&project_path);
    
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
                                    let _ = app_handle.emit("pty-data", serde_json::json!({
                                        "projectPath": project_path_clone,
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
                                    let _ = app_handle.emit("pty-data", serde_json::json!({
                                        "projectPath": project_path_clone,
                                        "data": valid
                                    }));
                                }
                                if let Some(error_len) = err.error_len() {
                                    pending.drain(0..valid_up_to + error_len);
                                    let _ = app_handle.emit("pty-data", serde_json::json!({
                                        "projectPath": project_path_clone,
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
                        "data": valid
                    }));
                }
            }
        }
        log::info!("PTY reader thread exiting for project: {}", project_path_clone);
    });

    Ok(project_path)
}

fn get_pty_log_path(project_path: &str) -> std::path::PathBuf {
    let home = dirs::home_dir().expect("Failed to get home dir");
    let safe_name = project_path.replace("/", "_").replace(":", "_");
    home.join("sparky/pty_logs").join(format!("{}.log", safe_name))
}

#[tauri::command]
pub fn pty_write(app: tauri::AppHandle, project_path: String, data: String) -> Result<(), String> {
    log::debug!("PTY write: project={}, data={}", project_path, data);

    let manager = app.state::<PtyManager>();
    manager.write(&project_path, &data)
}

#[tauri::command]
pub fn pty_kill(app: tauri::AppHandle, project_path: String) -> Result<(), String> {
    log::info!("PTY kill: project={}", project_path);

    let manager = app.state::<PtyManager>();
    let _ = manager.remove_pty(&project_path);
    Ok(())
}

#[tauri::command]
pub fn pty_resize(app: tauri::AppHandle, project_path: String, cols: u16, rows: u16) -> Result<(), String> {
    log::info!("PTY resize: project={}, cols={}, rows={}", project_path, cols, rows);

    let manager = app.state::<PtyManager>();
    let mut pairs = manager.pty_pairs.lock().unwrap();

    if let Some(pair) = pairs.get_mut(&project_path) {
        pair.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Resize error: {}", e))?;
        Ok(())
    } else {
        Err(format!("PTY not found for project: {}", project_path))
    }
}

#[tauri::command]
pub fn pty_exists(app: tauri::AppHandle, project_path: String) -> bool {
    let manager = app.state::<PtyManager>();
    manager.has_pty(&project_path)
}
