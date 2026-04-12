use crate::auth::AuthSession;
use crate::config::ServerConfig;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime};

const START_PORT: u16 = 4300;
const END_PORT: u16 = 4499;
const DEFAULT_CODE_SERVER_EXTENSIONS_DIR: &str = "/opt/sparky/code-server/default-extensions";
const DEFAULT_CODE_SERVER_LOCALE: &str = "zh-cn";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditorStatus {
    pub running: bool,
    pub url: String,
    pub proxy_base: String,
    pub port: u16,
    pub started_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileTreeListing {
    pub root: String,
    pub root_name: String,
    pub current_path: String,
    pub source: String,
    pub entries: Vec<FileTreeEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileTreeEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub has_children: bool,
}

#[derive(Debug)]
struct RunningEditor {
    port: u16,
    proxy_base: String,
    started_at_ms: u64,
    child: Mutex<Child>,
}

impl RunningEditor {
    fn is_alive(&self) -> bool {
        self.child
            .lock()
            .try_wait()
            .map(|status| status.is_none())
            .unwrap_or(false)
    }

    fn kill(&self) {
        let mut child = self.child.lock();
        let _ = child.kill();
        let _ = child.wait();
    }

    fn status(&self) -> EditorStatus {
        EditorStatus {
            running: self.is_alive(),
            url: format!("{}/", self.proxy_base),
            proxy_base: self.proxy_base.clone(),
            port: self.port,
            started_at_ms: self.started_at_ms,
        }
    }
}

pub struct EditorManager {
    editors: Mutex<HashMap<String, Arc<RunningEditor>>>,
    next_port: AtomicU16,
    server_config: ServerConfig,
}

impl EditorManager {
    pub fn new(server_config: ServerConfig) -> Self {
        Self {
            editors: Mutex::new(HashMap::new()),
            next_port: AtomicU16::new(START_PORT),
            server_config,
        }
    }

    pub fn ensure_running(
        &self,
        user: &AuthSession,
        project_id: &str,
        root: &Path,
    ) -> Result<EditorStatus, String> {
        self.remove_if_dead(user.user_id.as_str(), project_id);

        if let Some(editor) = self.get_editor(user.user_id.as_str(), project_id) {
            return Ok(editor.status());
        }

        let port = self.allocate_port()?;
        let proxy_base = format!("/editor/{}", project_id);
        let started_at_ms = now_ms();

        let mut command =
            build_editor_command(user, &self.server_config, port, proxy_base.as_str(), root);
        command.stdout(Stdio::null()).stderr(Stdio::null());

        let child = command
            .spawn()
            .map_err(|error| format!("start code-server: {}", error))?;

        wait_for_editor_ready(port, Duration::from_secs(20))
            .map_err(|error| format!("wait for code-server on {}: {}", port, error))?;

        let editor = Arc::new(RunningEditor {
            port,
            proxy_base,
            started_at_ms,
            child: Mutex::new(child),
        });

        let key = editor_key(user.user_id.as_str(), project_id);
        self.editors.lock().insert(key, Arc::clone(&editor));

        Ok(editor.status())
    }

    pub fn upstream_url(
        &self,
        user_id: &str,
        project_id: &str,
        request_path: &str,
        query: Option<&str>,
    ) -> Result<String, String> {
        let editor = self
            .get_editor(user_id, project_id)
            .ok_or_else(|| "编辑器未启动".to_string())?;

        if !editor.is_alive() {
            self.stop_for_project(user_id, project_id);
            return Err("编辑器已退出，请重新打开文件".to_string());
        }

        let mut url = format!("http://127.0.0.1:{}{}", editor.port, request_path);
        if let Some(query) = query.filter(|value| !value.is_empty()) {
            url.push('?');
            url.push_str(query);
        }
        Ok(url)
    }

    pub fn remove_for_user_project(&self, user_id: &str, project_id: &str) {
        self.stop_for_project(user_id, project_id);
    }

    fn get_editor(&self, user_id: &str, project_id: &str) -> Option<Arc<RunningEditor>> {
        self.editors
            .lock()
            .get(&editor_key(user_id, project_id))
            .cloned()
    }

    fn stop_for_project(&self, user_id: &str, project_id: &str) {
        if let Some(editor) = self.editors.lock().remove(&editor_key(user_id, project_id)) {
            editor.kill();
        }
    }

    fn remove_if_dead(&self, user_id: &str, project_id: &str) {
        let key = editor_key(user_id, project_id);
        let should_remove = self
            .editors
            .lock()
            .get(&key)
            .is_some_and(|editor| !editor.is_alive());

        if should_remove {
            self.stop_for_project(user_id, project_id);
        }
    }

    fn allocate_port(&self) -> Result<u16, String> {
        for _ in START_PORT..=END_PORT {
            let next = self.next_port.fetch_add(1, Ordering::Relaxed);
            let candidate = if next > END_PORT {
                self.next_port.store(START_PORT + 1, Ordering::Relaxed);
                START_PORT
            } else {
                next
            };

            if port_available(candidate) {
                return Ok(candidate);
            }
        }

        Err("没有可用的编辑器端口".to_string())
    }
}

pub fn list_directory(
    root: &Path,
    relative_path: Option<&str>,
    source: &str,
) -> Result<FileTreeListing, String> {
    let current_path = normalize_relative_path(relative_path.unwrap_or_default())?;
    let current_dir = join_under_root(root, current_path.as_str())?;
    if !current_dir.exists() {
        return Err("目录不存在".to_string());
    }
    if !current_dir.is_dir() {
        return Err("目标不是目录".to_string());
    }

    let entries = fs::read_dir(&current_dir)
        .map_err(|error| format!("read {}: {}", current_dir.display(), error))?;

    let mut items = Vec::new();
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("read {} entry: {}", current_dir.display(), error))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("read {} type: {}", path.display(), error))?;

        let name = entry.file_name().to_string_lossy().to_string();
        if should_skip_name(name.as_str(), file_type.is_dir()) {
            continue;
        }

        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");

        let has_children = if file_type.is_dir() {
            directory_has_children(&path)?
        } else {
            false
        };

        items.push(FileTreeEntry {
            name,
            path: relative,
            kind: if file_type.is_dir() {
                "directory".to_string()
            } else {
                "file".to_string()
            },
            has_children,
        });
    }

    items.sort_by(|left, right| {
        let left_dir = left.kind == "directory";
        let right_dir = right.kind == "directory";
        right_dir
            .cmp(&left_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });

    let root_name = root
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| root.display().to_string());

    Ok(FileTreeListing {
        root: root.display().to_string(),
        root_name,
        current_path,
        source: source.to_string(),
        entries: items,
    })
}

pub fn build_editor_url(proxy_base: &str, root: &Path, file_path: Option<&Path>) -> String {
    let mut query = vec![format!(
        "folder={}",
        url_encode(root.display().to_string().as_str())
    )];
    if let Some(file_path) = file_path {
        query.push(format!(
            "file={}",
            url_encode(file_path.display().to_string().as_str())
        ));
    }
    format!("{}/?{}", proxy_base.trim_end_matches('/'), query.join("&"))
}

fn persistent_editor_data_root(user: &AuthSession) -> PathBuf {
    let stable_home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| PathBuf::from("/home/app"));

    stable_home
        .join(".local")
        .join("share")
        .join("sparky")
        .join("code-server")
        .join(&user.user_id)
}

fn migrate_editor_dir_if_needed(legacy_dir: &Path, target_dir: &Path) {
    if !legacy_dir.exists() || target_dir.exists() {
        return;
    }

    if let Some(parent) = target_dir.parent() {
        if let Err(error) = fs::create_dir_all(parent) {
            log::warn!("create editor data parent {}: {}", parent.display(), error);
            return;
        }
    }

    if let Err(error) = fs::rename(legacy_dir, target_dir) {
        log::warn!(
            "migrate editor data {} -> {}: {}",
            legacy_dir.display(),
            target_dir.display(),
            error
        );
    }
}

fn seed_default_editor_extensions(default_dir: &Path, target_dir: &Path) {
    if !default_dir.exists() {
        return;
    }

    if let Err(error) = fs::create_dir_all(target_dir) {
        log::warn!(
            "create editor extensions dir {}: {}",
            target_dir.display(),
            error
        );
        return;
    }

    let entries = match fs::read_dir(default_dir) {
        Ok(entries) => entries,
        Err(error) => {
            log::warn!(
                "read default editor extensions {}: {}",
                default_dir.display(),
                error
            );
            return;
        }
    };

    for entry in entries.flatten() {
        let source = entry.path();
        let target = target_dir.join(entry.file_name());
        if target.exists() {
            continue;
        }

        if let Err(error) = copy_dir_or_file(&source, &target) {
            log::warn!(
                "seed default editor extension {} -> {}: {}",
                source.display(),
                target.display(),
                error
            );
        }
    }
}

fn copy_dir_or_file(source: &Path, target: &Path) -> Result<(), String> {
    let metadata =
        fs::metadata(source).map_err(|error| format!("stat {}: {}", source.display(), error))?;

    if metadata.is_dir() {
        fs::create_dir_all(target)
            .map_err(|error| format!("mkdir {}: {}", target.display(), error))?;
        for entry in
            fs::read_dir(source).map_err(|error| format!("read {}: {}", source.display(), error))?
        {
            let entry =
                entry.map_err(|error| format!("read entry {}: {}", source.display(), error))?;
            let child_source = entry.path();
            let child_target = target.join(entry.file_name());
            copy_dir_or_file(&child_source, &child_target)?;
        }
        return Ok(());
    }

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("mkdir {}: {}", parent.display(), error))?;
    }

    fs::copy(source, target).map(|_| ()).map_err(|error| {
        format!(
            "copy {} -> {}: {}",
            source.display(),
            target.display(),
            error
        )
    })
}

pub fn resolve_requested_path(root: &Path, relative_path: Option<&str>) -> Result<PathBuf, String> {
    let relative = normalize_relative_path(relative_path.unwrap_or_default())?;
    join_under_root(root, relative.as_str())
}

fn build_editor_command(
    user: &AuthSession,
    config: &ServerConfig,
    port: u16,
    proxy_base: &str,
    root: &Path,
) -> Command {
    let legacy_data_root = user
        .home_dir
        .join(".local")
        .join("share")
        .join("sparky")
        .join("code-server");
    let data_root = persistent_editor_data_root(user);
    let user_data_dir = data_root.join("user-data");
    let extensions_dir = data_root.join("extensions");
    migrate_editor_dir_if_needed(&legacy_data_root.join("user-data"), &user_data_dir);
    migrate_editor_dir_if_needed(&legacy_data_root.join("extensions"), &extensions_dir);
    let _ = fs::create_dir_all(&user_data_dir);
    let _ = fs::create_dir_all(&extensions_dir);
    seed_default_editor_extensions(
        Path::new(DEFAULT_CODE_SERVER_EXTENSIONS_DIR),
        &extensions_dir,
    );

    let mut command = Command::new("code-server");
    command.args([
        "--auth",
        "none",
        "--bind-addr",
        &format!("127.0.0.1:{}", port),
        "--abs-proxy-base-path",
        proxy_base,
        "--app-name",
        "Sparky",
        "--disable-telemetry",
        "--disable-update-check",
        "--locale",
        DEFAULT_CODE_SERVER_LOCALE,
        "--user-data-dir",
        &user_data_dir.display().to_string(),
        "--extensions-dir",
        &extensions_dir.display().to_string(),
    ]);
    command.arg(root);
    command.env("HOME", user.home_dir.display().to_string());
    command.env("USER", user.user_id.as_str());
    command.env("LOGNAME", user.user_id.as_str());
    command.env("USERNAME", user.username.as_str());
    command.env("BROWSER", "none");
    command.env("SHELL", "/bin/bash");
    command.env_remove("PORT");
    if let Some(ssh_auth_sock) = config.ssh_auth_sock.as_deref() {
        command.env("SSH_AUTH_SOCK", ssh_auth_sock);
    }
    command
}

fn normalize_relative_path(input: &str) -> Result<String, String> {
    let trimmed = input.trim().trim_matches('/');
    if trimmed.is_empty() {
        return Ok(String::new());
    }

    let mut clean = PathBuf::new();
    for component in Path::new(trimmed).components() {
        match component {
            Component::Normal(part) => clean.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("路径必须位于当前项目目录内".to_string());
            }
        }
    }

    Ok(clean.to_string_lossy().replace('\\', "/"))
}

fn join_under_root(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let joined = if relative.is_empty() {
        root.to_path_buf()
    } else {
        root.join(relative)
    };
    let normalized = joined
        .components()
        .fold(PathBuf::new(), |mut acc, component| {
            match component {
                Component::CurDir => {}
                other => acc.push(other.as_os_str()),
            }
            acc
        });

    if !normalized.starts_with(root) {
        return Err("路径必须位于当前项目目录内".to_string());
    }
    Ok(normalized)
}

fn directory_has_children(path: &Path) -> Result<bool, String> {
    let entries =
        fs::read_dir(path).map_err(|error| format!("read {}: {}", path.display(), error))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("read {} entry: {}", path.display(), error))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("read {} type: {}", entry.path().display(), error))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if should_skip_name(name.as_str(), file_type.is_dir()) {
            continue;
        }
        return Ok(true);
    }
    Ok(false)
}

fn should_skip_name(name: &str, is_dir: bool) -> bool {
    if !is_dir {
        return false;
    }

    matches!(
        name,
        ".git"
            | ".sparky"
            | ".cc-bridge"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | "coverage"
            | ".next"
            | ".nuxt"
    )
}

fn wait_for_port(port: u16, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut last_error = None;

    while Instant::now() < deadline {
        match TcpStream::connect_timeout(&addr, Duration::from_millis(250)) {
            Ok(_) => return Ok(()),
            Err(error) => {
                last_error = Some(error.to_string());
                thread::sleep(Duration::from_millis(200));
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "timeout".to_string()))
}

fn wait_for_editor_ready(port: u16, timeout: Duration) -> Result<(), String> {
    wait_for_port(port, timeout)?;

    let deadline = Instant::now() + timeout;
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut last_error = None;

    while Instant::now() < deadline {
        match TcpStream::connect_timeout(&addr, Duration::from_millis(250)) {
            Ok(mut stream) => {
                let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
                let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));

                let request = concat!(
                    "GET / HTTP/1.1\r\n",
                    "Host: 127.0.0.1\r\n",
                    "Connection: close\r\n\r\n"
                );

                if let Err(error) = stream.write_all(request.as_bytes()) {
                    last_error = Some(error.to_string());
                    thread::sleep(Duration::from_millis(200));
                    continue;
                }

                let mut response = String::new();
                if let Err(error) = stream.read_to_string(&mut response) {
                    last_error = Some(error.to_string());
                    thread::sleep(Duration::from_millis(200));
                    continue;
                }

                if response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.1 302") {
                    return Ok(());
                }

                last_error = Some(
                    response
                        .lines()
                        .next()
                        .unwrap_or("unexpected response")
                        .to_string(),
                );
            }
            Err(error) => {
                last_error = Some(error.to_string());
            }
        }

        thread::sleep(Duration::from_millis(200));
    }

    Err(last_error.unwrap_or_else(|| "timeout".to_string()))
}

fn port_available(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn editor_key(user_id: &str, project_id: &str) -> String {
    format!("{}:{}", user_id, project_id)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn url_encode(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                output.push(char::from(byte));
            }
            _ => output.push_str(format!("%{:02X}", byte).as_str()),
        }
    }
    output
}
