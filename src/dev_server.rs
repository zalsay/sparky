use crate::auth::AuthSession;
use crate::config::ServerConfig;
use bytes::Bytes;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader};
use std::net::{SocketAddr, TcpStream};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_DISCOVERY_DEPTH: usize = 4;
const MAX_LOG_LINES: usize = 160;
const START_PORT: u16 = 4100;
const END_PORT: u16 = 4299;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebCandidate {
    pub id: String,
    pub name: String,
    pub relative_path: String,
    pub package_manager: String,
    pub framework: String,
    pub dev_script: String,
    pub support_level: String,
    #[serde(skip_serializing, skip_deserializing, default)]
    pub absolute_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebCandidateStatus {
    #[serde(flatten)]
    pub candidate: WebCandidate,
    pub running: bool,
    pub url: Option<String>,
    pub port: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DevServerStatus {
    pub running: bool,
    pub url: String,
    pub proxy_base: String,
    pub port: u16,
    pub logs: String,
    pub started_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedDevServer {
    pid: i32,
    port: u16,
    proxy_base: String,
    started_at_ms: u64,
}

#[derive(Debug, Default, Deserialize)]
struct PackageJson {
    name: Option<String>,
    #[serde(rename = "packageManager")]
    package_manager: Option<String>,
    scripts: Option<HashMap<String, String>>,
    dependencies: Option<HashMap<String, String>>,
    #[serde(rename = "devDependencies")]
    dev_dependencies: Option<HashMap<String, String>>,
}

#[derive(Debug)]
struct RunningDevServer {
    user_id: String,
    project_id: String,
    port: u16,
    proxy_base: String,
    started_at_ms: u64,
    child: Mutex<Child>,
    logs: Arc<Mutex<VecDeque<String>>>,
}

impl RunningDevServer {
    fn is_alive(&self) -> bool {
        self.child
            .lock()
            .try_wait()
            .map(|status| status.is_none())
            .unwrap_or(false)
    }

    fn kill(&self) {
        let mut child = self.child.lock();
        let pid = child.id() as i32;

        if pid > 0 {
            let _ = unsafe { libc::kill(-pid, libc::SIGTERM) };

            for _ in 0..20 {
                match child.try_wait() {
                    Ok(Some(_)) => return,
                    Ok(None) => thread::sleep(Duration::from_millis(100)),
                    Err(_) => break,
                }
            }

            let _ = unsafe { libc::kill(-pid, libc::SIGKILL) };
        }

        let _ = child.kill();
        let _ = child.wait();
    }

    fn status(&self) -> DevServerStatus {
        DevServerStatus {
            running: self.is_alive(),
            url: self.proxy_base.clone(),
            proxy_base: self.proxy_base.clone(),
            port: self.port,
            logs: self
                .logs
                .lock()
                .iter()
                .cloned()
                .collect::<Vec<_>>()
                .join("\n"),
            started_at_ms: self.started_at_ms,
        }
    }
}

pub struct DevServerManager {
    servers: Mutex<HashMap<String, Arc<RunningDevServer>>>,
    next_port: AtomicU16,
    server_config: ServerConfig,
}

impl DevServerManager {
    pub fn new(server_config: ServerConfig) -> Self {
        Self {
            servers: Mutex::new(HashMap::new()),
            next_port: AtomicU16::new(START_PORT),
            server_config,
        }
    }

    pub fn discover(&self, project_root: &Path) -> Result<Vec<WebCandidate>, String> {
        discover_web_candidates(project_root)
    }

    pub fn list_statuses(
        &self,
        user_id: &str,
        project_id: &str,
        candidates: Vec<WebCandidate>,
    ) -> Vec<WebCandidateStatus> {
        candidates
            .into_iter()
            .map(|candidate| {
                let status = self.status_for(user_id, project_id, &candidate.id);
                WebCandidateStatus {
                    candidate,
                    running: status.as_ref().is_some_and(|item| item.running),
                    url: status.as_ref().map(|item| item.url.clone()),
                    port: status.as_ref().map(|item| item.port),
                }
            })
            .collect()
    }

    pub fn status_for(
        &self,
        user_id: &str,
        project_id: &str,
        candidate_id: &str,
    ) -> Option<DevServerStatus> {
        self.get_server(user_id, project_id, candidate_id)
            .map(|server| server.status())
            .or_else(|| self.persisted_status_for(user_id, project_id, candidate_id))
    }

    pub fn ensure_running(
        &self,
        user: &AuthSession,
        project_id: &str,
        candidate: &WebCandidate,
    ) -> Result<DevServerStatus, String> {
        self.ensure_running_with_port(user, project_id, candidate, None)
    }

    fn ensure_running_with_port(
        &self,
        user: &AuthSession,
        project_id: &str,
        candidate: &WebCandidate,
        preferred_port: Option<u16>,
    ) -> Result<DevServerStatus, String> {
        self.remove_if_dead(user.user_id.as_str(), project_id, candidate.id.as_str());

        if let Some(server) =
            self.get_server(user.user_id.as_str(), project_id, candidate.id.as_str())
        {
            return Ok(server.status());
        }

        if let Some(status) =
            self.persisted_status_for(user.user_id.as_str(), project_id, candidate.id.as_str())
        {
            return Ok(status);
        }

        let port = if let Some(port) = preferred_port {
            if !port_available(port) {
                return Err(format!("调试端口 {} 仍被占用，旧进程未完全退出", port));
            }
            port
        } else {
            self.allocate_port()?
        };
        let proxy_base = format!("/dev/{}/{}/", project_id, candidate.id);
        let logs = Arc::new(Mutex::new(VecDeque::new()));
        let started_at_ms = now_ms();
        let launch_command = dev_shell_command(candidate, port, proxy_base.as_str());

        let mut command = build_dev_command(
            candidate,
            port,
            user,
            &self.server_config,
            proxy_base.as_str(),
        );
        log::info!(
            "starting dev server user={} project={} candidate={} framework={} package_manager={} cwd={} port={} proxy_base={} command={}",
            user.user_id,
            project_id,
            candidate.id,
            candidate.framework,
            candidate.package_manager,
            candidate.absolute_path.display(),
            port,
            proxy_base,
            launch_command,
        );
        command.stdout(Stdio::piped()).stderr(Stdio::piped());

        let mut child = command
            .spawn()
            .map_err(|error| format!("start dev server: {}", error))?;

        if let Some(stdout) = child.stdout.take() {
            spawn_log_reader(stdout, Arc::clone(&logs), "stdout");
        }
        if let Some(stderr) = child.stderr.take() {
            spawn_log_reader(stderr, Arc::clone(&logs), "stderr");
        }

        wait_for_port(port, Duration::from_secs(20))
            .map_err(|error| format!("wait for dev server on {}: {}", port, error))?;

        self.persist_runtime(
            user.user_id.as_str(),
            project_id,
            candidate.id.as_str(),
            PersistedDevServer {
                pid: child.id() as i32,
                port,
                proxy_base: proxy_base.clone(),
                started_at_ms,
            },
        )?;

        let server = Arc::new(RunningDevServer {
            user_id: user.user_id.clone(),
            project_id: project_id.to_string(),
            port,
            proxy_base: proxy_base.clone(),
            started_at_ms,
            child: Mutex::new(child),
            logs,
        });

        self.servers.lock().insert(
            server_key(user.user_id.as_str(), project_id, candidate.id.as_str()),
            Arc::clone(&server),
        );

        Ok(server.status())
    }

    pub fn restart(
        &self,
        user: &AuthSession,
        project_id: &str,
        candidate: &WebCandidate,
    ) -> Result<DevServerStatus, String> {
        let previous_port = self
            .get_server(user.user_id.as_str(), project_id, candidate.id.as_str())
            .map(|server| server.port)
            .or_else(|| {
                self.load_runtime(user.user_id.as_str(), project_id, candidate.id.as_str())
                    .map(|runtime| runtime.port)
            });

        self.stop_for_candidate(user.user_id.as_str(), project_id, candidate.id.as_str());

        if let Some(port) = previous_port {
            wait_for_port_release(port, Duration::from_secs(8))
                .map_err(|error| format!("旧调试进程未完全退出: {}", error))?;
        }

        self.ensure_running_with_port(user, project_id, candidate, previous_port)
    }

    pub fn remove_for_user_project(&self, user_id: &str, project_id: &str) {
        let keys = {
            let servers = self.servers.lock();
            servers
                .iter()
                .filter(|(_, server)| server.user_id == user_id && server.project_id == project_id)
                .map(|(key, _)| key.clone())
                .collect::<Vec<_>>()
        };

        for key in keys {
            if let Some(server) = self.servers.lock().remove(&key) {
                server.kill();
            }
        }

        let project_dir = self
            .metadata_root()
            .join(sanitize_key(user_id))
            .join(sanitize_key(project_id));
        let _ = fs::remove_dir_all(project_dir);
    }

    pub fn stop_for_candidate(&self, user_id: &str, project_id: &str, candidate_id: &str) {
        if let Some(server) =
            self.servers
                .lock()
                .remove(&server_key(user_id, project_id, candidate_id))
        {
            server.kill();
        }
        self.kill_persisted_runtime(user_id, project_id, candidate_id);
    }

    pub fn find_candidate(
        &self,
        project_root: &Path,
        candidate_id: Option<&str>,
    ) -> Result<WebCandidate, String> {
        let candidates = self.discover(project_root)?;
        if candidates.is_empty() {
            return Err("当前项目未检测到可运行 npm run dev 的 Web 工程".to_string());
        }

        if let Some(candidate_id) = candidate_id.filter(|value| !value.trim().is_empty()) {
            candidates
                .into_iter()
                .find(|candidate| candidate.id == candidate_id)
                .ok_or_else(|| "web 调试目标不存在".to_string())
        } else {
            candidates
                .into_iter()
                .next()
                .ok_or_else(|| "当前项目未检测到可运行 npm run dev 的 Web 工程".to_string())
        }
    }

    pub fn upstream_url(
        &self,
        user_id: &str,
        project_id: &str,
        candidate_id: &str,
        request_path: &str,
        query: Option<&str>,
    ) -> Result<String, String> {
        let server = self
            .get_server(user_id, project_id, candidate_id)
            .map(|server| (server.port, server.is_alive()))
            .or_else(|| {
                self.persisted_status_for(user_id, project_id, candidate_id)
                    .map(|status| (status.port, status.running))
            })
            .ok_or_else(|| "web 调试服务未启动".to_string())?;

        if !server.1 {
            self.stop_for_candidate(user_id, project_id, candidate_id);
            return Err("web 调试服务已退出，请重新打开调试页".to_string());
        }

        let path = request_path.trim();
        let mut url = if path.is_empty() || path == "/" {
            format!("http://127.0.0.1:{}/", server.0)
        } else {
            format!("http://127.0.0.1:{}{}", server.0, path)
        };

        if let Some(query) = query.filter(|value| !value.is_empty()) {
            url.push('?');
            url.push_str(query);
        }

        Ok(url)
    }

    fn get_server(
        &self,
        user_id: &str,
        project_id: &str,
        candidate_id: &str,
    ) -> Option<Arc<RunningDevServer>> {
        self.servers
            .lock()
            .get(&server_key(user_id, project_id, candidate_id))
            .cloned()
    }

    fn remove_if_dead(&self, user_id: &str, project_id: &str, candidate_id: &str) {
        let key = server_key(user_id, project_id, candidate_id);
        let should_remove = self
            .servers
            .lock()
            .get(&key)
            .is_some_and(|server| !server.is_alive());

        if should_remove {
            self.stop_for_candidate(user_id, project_id, candidate_id);
            return;
        }

        if self
            .load_runtime(user_id, project_id, candidate_id)
            .as_ref()
            .is_some_and(|runtime| !runtime_is_alive(runtime))
        {
            self.remove_runtime(user_id, project_id, candidate_id);
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

        Err("没有可用的调试端口".to_string())
    }

    fn metadata_root(&self) -> PathBuf {
        self.server_config.sandbox_root.join("dev-servers")
    }

    fn metadata_path(&self, user_id: &str, project_id: &str, candidate_id: &str) -> PathBuf {
        self.metadata_root()
            .join(sanitize_key(user_id))
            .join(sanitize_key(project_id))
            .join(format!("{}.json", sanitize_key(candidate_id)))
    }

    fn persist_runtime(
        &self,
        user_id: &str,
        project_id: &str,
        candidate_id: &str,
        runtime: PersistedDevServer,
    ) -> Result<(), String> {
        let path = self.metadata_path(user_id, project_id, candidate_id);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("create {}: {}", parent.display(), error))?;
        }
        let content = serde_json::to_vec(&runtime)
            .map_err(|error| format!("serialize runtime metadata: {}", error))?;
        fs::write(&path, content).map_err(|error| format!("write {}: {}", path.display(), error))
    }

    fn load_runtime(
        &self,
        user_id: &str,
        project_id: &str,
        candidate_id: &str,
    ) -> Option<PersistedDevServer> {
        let path = self.metadata_path(user_id, project_id, candidate_id);
        let content = fs::read(&path).ok()?;
        serde_json::from_slice(&content).ok()
    }

    fn remove_runtime(&self, user_id: &str, project_id: &str, candidate_id: &str) {
        let path = self.metadata_path(user_id, project_id, candidate_id);
        let _ = fs::remove_file(path);
    }

    fn persisted_status_for(
        &self,
        user_id: &str,
        project_id: &str,
        candidate_id: &str,
    ) -> Option<DevServerStatus> {
        let runtime = self.load_runtime(user_id, project_id, candidate_id)?;
        if !runtime_is_alive(&runtime) {
            self.remove_runtime(user_id, project_id, candidate_id);
            return None;
        }

        Some(DevServerStatus {
            running: true,
            url: runtime.proxy_base.clone(),
            proxy_base: runtime.proxy_base,
            port: runtime.port,
            logs: String::new(),
            started_at_ms: runtime.started_at_ms,
        })
    }

    fn kill_persisted_runtime(&self, user_id: &str, project_id: &str, candidate_id: &str) {
        if let Some(runtime) = self.load_runtime(user_id, project_id, candidate_id) {
            kill_runtime_process(runtime.pid, Some(runtime.port));
        }
        self.remove_runtime(user_id, project_id, candidate_id);
    }
}

fn sanitize_key(value: &str) -> String {
    value
        .chars()
        .map(|ch| match ch {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' => ch,
            _ => '_',
        })
        .collect()
}

fn runtime_is_alive(runtime: &PersistedDevServer) -> bool {
    process_exists(runtime.pid) && port_responding(runtime.port)
}

fn process_exists(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }

    let status = unsafe { libc::kill(pid, 0) };
    if status == 0 {
        return true;
    }

    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn kill_runtime_process(pid: i32, port: Option<u16>) {
    if pid <= 0 {
        return;
    }

    let _ = unsafe { libc::kill(-pid, libc::SIGTERM) };
    let _ = unsafe { libc::kill(pid, libc::SIGTERM) };

    for _ in 0..20 {
        if !process_exists(pid) && port.is_none_or(|value| !port_responding(value)) {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }

    let _ = unsafe { libc::kill(-pid, libc::SIGKILL) };
    let _ = unsafe { libc::kill(pid, libc::SIGKILL) };

    for _ in 0..20 {
        if !process_exists(pid) && port.is_none_or(|value| !port_responding(value)) {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
}

pub fn rewrite_html_for_proxy(html: &str, proxy_base: &str, document_base: &str) -> String {
    let mut output = html.to_string();
    let already_prefixed = output.contains(&format!("src=\"{}", proxy_base))
        || output.contains(&format!("href=\"{}", proxy_base))
        || output.contains(&format!("action=\"{}", proxy_base));

    if already_prefixed {
        return output;
    }

    let base_tag = format!("<base href=\"{}\">", document_base);

    if !output.contains("<base ") {
        if let Some(index) = output.find("<head>") {
            output.insert_str(index + "<head>".len(), &base_tag);
        } else {
            output = format!("{}{}", base_tag, output);
        }
    }

    for (from, to) in [
        ("href=\"/", format!("href=\"{}", proxy_base)),
        ("src=\"/", format!("src=\"{}", proxy_base)),
        ("action=\"/", format!("action=\"{}", proxy_base)),
        ("content=\"/", format!("content=\"{}", proxy_base)),
        ("poster=\"/", format!("poster=\"{}", proxy_base)),
        ("url(/", format!("url({}", proxy_base)),
    ] {
        output = output.replace(from, &to);
    }

    output
}

pub fn document_base_for_proxy(request_path: &str, proxy_base: &str) -> String {
    let trimmed = request_path.trim();
    if trimmed.is_empty() || trimmed == "/" {
        return proxy_base.to_string();
    }

    if trimmed.ends_with('/') {
        return trimmed.to_string();
    }

    let last_segment = trimmed.rsplit('/').next().unwrap_or_default();
    if last_segment.contains('.') {
        if let Some((prefix, _)) = trimmed.rsplit_once('/') {
            if prefix.is_empty() {
                return "/".to_string();
            }
            return format!("{}/", prefix);
        }
        return "/".to_string();
    }

    format!("{}/", trimmed)
}

pub fn build_dev_request_path(project_id: &str, candidate_id: &str, tail: &str) -> String {
    let normalized = tail.trim_start_matches('/');
    if normalized.is_empty() {
        return format!("/dev/{}/{}/", project_id, candidate_id);
    }

    if should_strip_dev_proxy_prefix(normalized) {
        return format!("/{}", normalized);
    }

    format!("/dev/{}/{}/{}", project_id, candidate_id, normalized)
}

fn should_strip_dev_proxy_prefix(tail: &str) -> bool {
    tail == "api" || tail.starts_with("api/")
}

fn discover_web_candidates(project_root: &Path) -> Result<Vec<WebCandidate>, String> {
    let mut found = Vec::new();
    let mut queue = VecDeque::from([(project_root.to_path_buf(), 0usize)]);

    while let Some((dir, depth)) = queue.pop_front() {
        let package_json_path = dir.join("package.json");
        if package_json_path.exists() {
            if let Some(candidate) = parse_candidate(project_root, &dir, &package_json_path)? {
                found.push(candidate);
            }
        }

        if depth >= MAX_DISCOVERY_DEPTH {
            continue;
        }

        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(error) => return Err(format!("read {}: {}", dir.display(), error)),
        };

        for entry in entries {
            let entry =
                entry.map_err(|error| format!("read {} entry: {}", dir.display(), error))?;
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }

            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };

            if skip_directory(name) {
                continue;
            }

            queue.push_back((path, depth + 1));
        }
    }

    found.sort_by(|a, b| {
        a.relative_path
            .len()
            .cmp(&b.relative_path.len())
            .then_with(|| a.relative_path.cmp(&b.relative_path))
    });
    found.dedup_by(|a, b| a.id == b.id);
    Ok(found)
}

fn parse_candidate(
    project_root: &Path,
    dir: &Path,
    package_json_path: &Path,
) -> Result<Option<WebCandidate>, String> {
    let content = fs::read_to_string(package_json_path)
        .map_err(|error| format!("read {}: {}", package_json_path.display(), error))?;
    let package: PackageJson = serde_json::from_str(&content)
        .map_err(|error| format!("parse {}: {}", package_json_path.display(), error))?;

    let Some(dev_script) = package
        .scripts
        .as_ref()
        .and_then(|scripts| scripts.get("dev"))
        .map(|script| script.trim().to_string())
        .filter(|script| !script.is_empty())
    else {
        return Ok(None);
    };

    let relative_path = dir
        .strip_prefix(project_root)
        .unwrap_or(dir)
        .to_string_lossy()
        .trim_matches('/')
        .to_string();
    let id = if relative_path.is_empty() {
        "root".to_string()
    } else {
        relative_path.replace('/', "__")
    };

    let name = package
        .name
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            if relative_path.is_empty() {
                "Web".to_string()
            } else {
                relative_path.clone()
            }
        });
    let framework = detect_framework(&package, dev_script.as_str());
    let support_level = if is_fully_supported_framework(&framework) {
        "full"
    } else {
        "best_effort"
    };

    Ok(Some(WebCandidate {
        id,
        name,
        relative_path,
        package_manager: detect_package_manager(dir, &package),
        framework,
        dev_script,
        support_level: support_level.to_string(),
        absolute_path: dir.to_path_buf(),
    }))
}

fn detect_package_manager(dir: &Path, package: &PackageJson) -> String {
    if dir.join("pnpm-lock.yaml").exists() {
        return "pnpm".to_string();
    }
    if dir.join("yarn.lock").exists() {
        return "yarn".to_string();
    }
    if dir.join("package-lock.json").exists() {
        return "npm".to_string();
    }
    if dir.join("bun.lockb").exists() || dir.join("bun.lock").exists() {
        return "bun".to_string();
    }

    package
        .package_manager
        .as_deref()
        .and_then(|value| value.split('@').next())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("npm")
        .to_string()
}

fn detect_framework(package: &PackageJson, dev_script: &str) -> String {
    let deps = package
        .dependencies
        .iter()
        .flat_map(|items| items.keys())
        .chain(
            package
                .dev_dependencies
                .iter()
                .flat_map(|items| items.keys()),
        )
        .map(|item| item.as_str())
        .collect::<Vec<_>>();
    let dev_script = dev_script.to_ascii_lowercase();

    for (needle, framework) in [
        ("vite", "vite"),
        ("astro", "astro"),
        ("next", "next"),
        ("nuxt", "nuxt"),
        ("react-scripts", "cra"),
        ("webpack-dev-server", "webpack"),
    ] {
        if dev_script.contains(needle) || deps.iter().any(|dep| dep == &needle) {
            return framework.to_string();
        }
    }

    "generic".to_string()
}

fn is_fully_supported_framework(framework: &str) -> bool {
    matches!(framework, "vite" | "astro")
}

fn skip_directory(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | ".idea"
            | ".next"
            | ".nuxt"
            | ".sparky"
            | ".cc-bridge"
            | "dist"
            | "build"
            | "coverage"
            | "node_modules"
            | "target"
    )
}

fn build_dev_command(
    candidate: &WebCandidate,
    port: u16,
    user: &AuthSession,
    config: &ServerConfig,
    proxy_base: &str,
) -> Command {
    let mut command = Command::new("/bin/bash");
    command.process_group(0);
    command.arg("-lc");
    command.arg(dev_shell_command(candidate, port, proxy_base));
    command.current_dir(&candidate.absolute_path);
    command.env("HOME", user.home_dir.display().to_string());
    command.env("USER", user.user_id.as_str());
    command.env("LOGNAME", user.user_id.as_str());
    command.env("USERNAME", user.username.as_str());
    command.env("TERM", "xterm-256color");
    command.env("HOST", "0.0.0.0");
    command.env("PORT", port.to_string());
    command.env("BROWSER", "none");
    command.env("CI", "1");
    command.env("FORCE_COLOR", "1");
    if matches!(candidate.framework.as_str(), "vite" | "astro") {
        command.env("VITE_RUNTIME_MODE", "online");
        command.env("VITE_PROXY_BASE", proxy_base);
    }
    if candidate.framework == "vite" {
        let debug = std::env::var("DEBUG")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(|value| format!("{},vite:proxy", value))
            .unwrap_or_else(|| "vite:proxy".to_string());
        command.env("DEBUG", debug);
    }
    if let Some(ssh_auth_sock) = config.ssh_auth_sock.as_deref() {
        command.env("SSH_AUTH_SOCK", ssh_auth_sock);
    }
    command
}

fn dev_shell_command(candidate: &WebCandidate, port: u16, proxy_base: &str) -> String {
    let port = port.to_string();
    let extra_args = match candidate.framework.as_str() {
        "vite" | "astro" => vec![
            "--host".to_string(),
            "0.0.0.0".to_string(),
            "--port".to_string(),
            port.clone(),
            "--strictPort".to_string(),
            "--mode".to_string(),
            "dev".to_string(),
            "--base".to_string(),
            proxy_base.to_string(),
        ],
        "next" => vec![
            "--hostname".to_string(),
            "0.0.0.0".to_string(),
            "--port".to_string(),
            port.clone(),
        ],
        "nuxt" => vec![
            "--host".to_string(),
            "0.0.0.0".to_string(),
            "--port".to_string(),
            port.clone(),
        ],
        _ => vec![
            "--host".to_string(),
            "0.0.0.0".to_string(),
            "--port".to_string(),
            port.clone(),
        ],
    };

    let runner = candidate.package_manager.as_str();
    match runner {
        "pnpm" => format!("exec pnpm dev {}", shell_join(&extra_args)),
        "yarn" => format!("exec yarn dev {}", shell_join(&extra_args)),
        "bun" => format!("exec bun run dev {}", shell_join(&extra_args)),
        _ => format!("exec npm run dev -- {}", shell_join(&extra_args)),
    }
}

fn shell_join(args: &[String]) -> String {
    args.iter()
        .map(|arg| shell_escape(arg))
        .collect::<Vec<_>>()
        .join(" ")
}

fn shell_escape(value: &str) -> String {
    if value.is_empty() {
        return "''".to_string();
    }
    if value.bytes().all(|byte| {
        byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b':' | b'.' | b'_' | b'-')
    }) {
        return value.to_string();
    }
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn spawn_log_reader<T: std::io::Read + Send + 'static>(
    stream: T,
    logs: Arc<Mutex<VecDeque<String>>>,
    label: &str,
) {
    let label = label.to_string();
    thread::spawn(move || {
        let reader = BufReader::new(stream);
        for line in reader.lines().map_while(Result::ok) {
            let line = if line.trim().is_empty() {
                continue;
            } else {
                format!("[{}] {}", label, line)
            };

            let mut log_lines = logs.lock();
            if log_lines.len() >= MAX_LOG_LINES {
                log_lines.pop_front();
            }
            log_lines.push_back(line);
        }
    });
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

fn wait_for_port_release(port: u16, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;

    while Instant::now() < deadline {
        if port_available(port) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(200));
    }

    Err(format!("port {} still busy", port))
}

fn port_responding(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

fn port_available(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn server_key(user_id: &str, project_id: &str, candidate_id: &str) -> String {
    format!("{}:{}:{}", user_id, project_id, candidate_id)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn bytes_to_string(bytes: Bytes) -> String {
    String::from_utf8_lossy(&bytes).to_string()
}
