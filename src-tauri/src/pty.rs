use std::collections::HashMap;
use std::sync::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, PtySize, PtyPair, Child};
use std::io::{Read, Write};
use std::thread;
use tauri::{Emitter, Manager};

pub struct PtyManager {
    pty_pairs: Mutex<HashMap<u32, PtyPair>>,
    children: Mutex<HashMap<u32, Box<dyn Child + Send + Sync>>>,
    writers: Mutex<HashMap<u32, Box<dyn Write + Send>>>,
    next_pid: Mutex<u32>,
}

impl PtyManager {
    pub fn new() -> Self {
        PtyManager {
            pty_pairs: Mutex::new(HashMap::new()),
            children: Mutex::new(HashMap::new()),
            writers: Mutex::new(HashMap::new()),
            next_pid: Mutex::new(1),
        }
    }

    pub fn add_pty(&self, pair: PtyPair, child: Box<dyn Child + Send + Sync>) -> u32 {
        let mut next_pid = self.next_pid.lock().unwrap();
        let pid = *next_pid;
        *next_pid += 1;

        // Create writer immediately and store it
        let writer = pair.master.take_writer().expect("Failed to take writer");
        self.writers.lock().unwrap().insert(pid, writer);

        self.pty_pairs.lock().unwrap().insert(pid, pair);
        self.children.lock().unwrap().insert(pid, child);

        pid
    }

    pub fn write(&self, pid: u32, data: &str) -> Result<(), String> {
        let mut writers = self.writers.lock().unwrap();
        if let Some(writer) = writers.get_mut(&pid) {
            writer.write_all(data.as_bytes()).map_err(|e| format!("Write error: {}", e))?;
            writer.flush().map_err(|e| format!("Flush error: {}", e))?;
            Ok(())
        } else {
            Err(format!("Writer not found for pid: {}", pid))
        }
    }

    pub fn remove_pty(&self, pid: u32) -> Option<(PtyPair, Box<dyn Child + Send + Sync>)> {
        let pair = self.pty_pairs.lock().unwrap().remove(&pid);
        let child = self.children.lock().unwrap().remove(&pid);
        let _writer = self.writers.lock().unwrap().remove(&pid);
        match (pair, child) {
            (Some(pair), Some(child)) => Some((pair, child)),
            _ => None,
        }
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
) -> Result<u32, String> {
    log::info!("Spawning PTY: program={}, args={:?}, cwd={}", program, args, cwd);

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

    // Store the pair and child, get a unique PID
    let manager = app.state::<PtyManager>();
    let pid = manager.add_pty(pair, child);

    log::info!("PTY spawned with internal pid: {}", pid);

    // Spawn a task to read from the PTY
    let app_handle = app.clone();
    let reader_pid = pid;

    // Get a reader clone
    let master_reader = {
        let manager = app.state::<PtyManager>();
        let pair_guard = manager.pty_pairs.lock().unwrap();
        let pair = pair_guard.get(&reader_pid).unwrap();
        pair.master.try_clone_reader().map_err(|e| format!("Failed to clone master: {}", e))?
    };
    drop(manager);

    thread::spawn(move || {
        let mut reader = master_reader;
        let mut buf = [0u8; 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_handle.emit("pty-data", serde_json::json!({
                        "pid": reader_pid,
                        "data": data
                    }));
                }
                Err(_) => break,
            }
        }
        log::info!("PTY reader thread exiting for pid: {}", reader_pid);
    });

    Ok(pid)
}

#[tauri::command]
pub fn pty_write(app: tauri::AppHandle, pid: u32, data: String) -> Result<(), String> {
    log::debug!("PTY write: pid={}, data={}", pid, data);

    let manager = app.state::<PtyManager>();
    manager.write(pid, &data)
}

#[tauri::command]
pub fn pty_kill(app: tauri::AppHandle, pid: u32) -> Result<(), String> {
    log::info!("PTY kill: pid={}", pid);

    let manager = app.state::<PtyManager>();
    let _ = manager.remove_pty(pid);
    Ok(())
}

#[tauri::command]
pub fn pty_resize(app: tauri::AppHandle, pid: u32, cols: u16, rows: u16) -> Result<(), String> {
    log::info!("PTY resize: pid={}, cols={}, rows={}", pid, cols, rows);

    let manager = app.state::<PtyManager>();
    let mut pairs = manager.pty_pairs.lock().unwrap();

    if let Some(pair) = pairs.get_mut(&pid) {
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
        Err(format!("PTY not found for pid: {}", pid))
    }
}
