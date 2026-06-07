//! PTY session management with direct PTY shell bridge.

use crate::auth::AuthSession;
use crate::config::ServerConfig;
use crate::git::{
    ensure_local_branch_tracking, repair_runtime_path_ownership, resolve_runtime_worktree_compat,
    GitRuntimeContext,
};
use crate::project::Project;
use crate::sandbox::{unmount_overlay, OverlayPaths};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write as IoWrite;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const SNAPSHOT_MAX_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchOverride {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    #[serde(default)]
    pub codex_session_id: Option<String>,
}

/// PTY handles — the master PTY and child process.
struct PtyHandles {
    /// PTY master (kept for lifecycle/resize extension later).
    master: Box<dyn portable_pty::MasterPty + Send>,
    /// Child process handle.
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

struct SnapshotState {
    base_offset: u64,
    data: String,
}

/// A running terminal session.
pub struct Session {
    /// Unique session ID.
    pub id: String,
    /// Logged-in user that owns this session.
    pub user_id: String,
    /// Project this session belongs to.
    pub project_id: String,
    /// Username for display and reconnect decisions.
    pub username: String,
    /// Session creation timestamp in milliseconds since Unix epoch.
    pub created_at_ms: u64,
    /// Effective runtime worktree used when the session was spawned.
    pub runtime_worktree: String,
    /// Back-reference to the recovered Codex history session when available.
    pub codex_session_id: String,
    /// Temporary sessions run an auxiliary shell and can still be restored.
    pub temporary: bool,
    /// Snapshot file persisted under the project path when available.
    snapshot_path: Option<PathBuf>,
    /// Legacy snapshot path kept for one-way migration from `.cc-bridge`.
    legacy_snapshot_path: Option<PathBuf>,
    /// Overlay paths for cleanup (kept for compatibility; unused in direct mode).
    pub overlay: OverlayPaths,
    /// PTY handles protected by a mutex.
    pty: Mutex<PtyHandles>,
    /// Separate writer handle (can only take once from master).
    writer: Mutex<Box<dyn std::io::Write + Send>>,
    /// Rolling output snapshot for reconnect/resume.
    snapshot: Arc<Mutex<SnapshotState>>,
}

impl Session {
    /// Create a new direct PTY session for the given project.
    pub fn spawn(
        project: &Project,
        sandbox_root: &PathBuf,
        cfg: &ServerConfig,
        user: &AuthSession,
        temporary: bool,
        launch_override: Option<&LaunchOverride>,
    ) -> Result<Self, String> {
        let id = Uuid::new_v4().to_string()[..8].to_string();
        log::info!(
            "Spawning direct session [{}] for project '{}' as user '{}'",
            id,
            project.project_id,
            user.user_id
        );

        // Keep session directory layout for compatibility/cleanup.
        let overlay = OverlayPaths::new(sandbox_root, &id);
        overlay
            .create()
            .map_err(|e| format!("session dir create: {}", e))?;

        // Open a PTY pair.
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 40,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("openpty: {}", e))?;

        // Prepare a persistent reader before consuming the writer handle.
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("try_clone_reader: {}", e))?;
        let snapshot_path = (!temporary)
            .then(|| snapshot_file_path(project, user, &id))
            .flatten();
        let legacy_snapshot_path = (!temporary)
            .then(|| legacy_snapshot_file_path(project, user, &id))
            .flatten();
        let initial_snapshot = load_snapshot_from_file(snapshot_path.as_deref());
        let snapshot = Arc::new(Mutex::new(SnapshotState {
            base_offset: 0,
            data: initial_snapshot,
        }));
        let snapshot_reader = Arc::clone(&snapshot);
        let snapshot_path_reader = snapshot_path.clone();
        thread::spawn(move || {
            use std::io::Read;
            loop {
                let mut buf = [0u8; 4096];
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                        append_snapshot(&snapshot_reader, snapshot_path_reader.as_deref(), &chunk);
                    }
                    Err(e) => {
                        log::warn!("PTY reader thread exiting: {}", e);
                        break;
                    }
                }
            }
        });

        // Direct command launch: no bwrap, no mount/userns path.
        let runtime_worktree = resolved_session_worktree(project);
        let git_runtime = GitRuntimeContext {
            home_dir: user.home_dir.clone(),
            ssh_auth_sock: cfg.ssh_auth_sock.clone(),
        };
        fs::create_dir_all(&user.home_dir)
            .map_err(|error| format!("create runtime home {}: {}", user.home_dir.display(), error))?;
        let project_root = PathBuf::from(configured_session_worktree(project));
        repair_runtime_path_ownership(&project_root, &git_runtime).map_err(|error| {
            format!(
                "repair project permissions {}: {}",
                project_root.display(),
                error
            )
        })?;
        sync_codex_agents_file(project, &runtime_worktree)?;
        if let Err(error) = ensure_local_branch_tracking(Path::new(&runtime_worktree), &git_runtime)
        {
            log::warn!(
                "Session [{}] skipped automatic git upstream setup for {}: {}",
                id,
                runtime_worktree,
                error
            );
        }
        let (command, args, cwd) = match launch_override {
            Some(override_spec) => (
                override_spec.command.clone(),
                override_spec.args.clone(),
                override_spec.cwd.clone(),
            ),
            None => session_command(project, temporary, &runtime_worktree),
        };
        let mut cmd = CommandBuilder::new(&command);
        cmd.args(&args);
        if let Some(cwd) = cwd.as_deref() {
            cmd.cwd(cwd);
        }
        for (k, v) in project.resolved_env_vars() {
            cmd.env(k.as_str(), v.as_str());
        }
        cmd.env("HOME", user.home_dir.display().to_string());
        cmd.env("USER", user.user_id.as_str());
        cmd.env("LOGNAME", user.user_id.as_str());
        cmd.env("USERNAME", user.username.as_str());
        if let Some(ssh_auth_sock) = cfg.ssh_auth_sock.as_deref() {
            cmd.env("SSH_AUTH_SOCK", ssh_auth_sock);
        }

        log::info!(
            "Session [{}] command={} args={:?} home={}",
            id,
            command,
            args,
            user.home_dir.display()
        );

        let child: Box<dyn portable_pty::Child + Send + Sync> =
            pair.slave.spawn_command(cmd).map_err(|e| {
                log::error!(
                    "Session [{}] spawn failed: command={} args={:?} home={} error={}",
                    id,
                    command,
                    args,
                    user.home_dir.display(),
                    e
                );
                format!("spawn: {}", e)
            })?;

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("take_writer: {}", e))?;

        Ok(Self {
            id,
            user_id: user.user_id.clone(),
            project_id: project.project_id.clone(),
            username: user.username.clone(),
            created_at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            runtime_worktree,
            codex_session_id: launch_override
                .and_then(|override_spec| override_spec.codex_session_id.clone())
                .unwrap_or_default(),
            temporary,
            snapshot_path,
            legacy_snapshot_path,
            overlay,
            pty: Mutex::new(PtyHandles {
                master: pair.master,
                child,
            }),
            writer: Mutex::new(writer),
            snapshot,
        })
    }

    pub fn snapshot_all(&self) -> (u64, String) {
        let snapshot = self.snapshot.lock();
        (
            snapshot.base_offset + snapshot.data.len() as u64,
            snapshot.data.clone(),
        )
    }

    pub fn snapshot_since(&self, cursor: u64) -> (u64, String) {
        let snapshot = self.snapshot.lock();
        let end = snapshot.base_offset + snapshot.data.len() as u64;

        if cursor <= snapshot.base_offset {
            return (end, snapshot.data.clone());
        }

        if cursor >= end {
            return (end, String::new());
        }

        let start = (cursor - snapshot.base_offset) as usize;
        (end, snapshot.data[start..].to_string())
    }

    pub fn snapshot_path(&self) -> Option<&Path> {
        self.snapshot_path.as_deref()
    }

    /// Write input to the PTY.
    pub fn send(&self, input: &str) -> Result<(), String> {
        let normalized = input.replace("\r\n", "\r").replace('\n', "\r");
        let mut w = self.writer.lock();
        w.write_all(normalized.as_bytes())
            .map_err(|e| format!("write: {}", e))?;
        w.flush().map_err(|e| format!("flush: {}", e))?;
        Ok(())
    }

    /// Resize the PTY so full-screen terminal apps can reflow to the visible viewport.
    pub fn resize(&self, rows: u16, cols: u16) -> Result<(), String> {
        let pty = self.pty.lock();
        pty.master
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(2),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("resize: {}", e))
    }

    /// Check if the child process is still alive.
    pub fn is_alive(&self) -> bool {
        let mut pty = self.pty.lock();
        pty.child.try_wait().map(|s| s.is_none()).unwrap_or(false)
    }

    /// Clean up: kill child and remove session dirs.
    pub fn cleanup(&self) {
        {
            let mut pty = self.pty.lock();
            let _ = pty.child.kill();
            let _ = pty.child.wait();
        }
        remove_snapshot_file(self.snapshot_path());
        remove_snapshot_file(self.legacy_snapshot_path.as_deref());
        let _ = unmount_overlay(&self.overlay.merged);
        self.overlay.cleanup();
        log::info!("Session [{}] cleaned up", self.id);
    }
}

fn append_snapshot(snapshot: &Mutex<SnapshotState>, snapshot_path: Option<&Path>, chunk: &str) {
    if chunk.is_empty() {
        return;
    }

    let mut state = snapshot.lock();
    state.data.push_str(chunk);

    if state.data.len() > SNAPSHOT_MAX_BYTES {
        let remove = state.data.len() - SNAPSHOT_MAX_BYTES;
        let mut split = remove;
        while split < state.data.len() && !state.data.is_char_boundary(split) {
            split += 1;
        }

        if split > 0 {
            state.data.drain(..split);
            state.base_offset += split as u64;
        }
    }

    persist_snapshot_to_file(snapshot_path, &state.data);
}

fn session_command(
    project: &Project,
    temporary: bool,
    runtime_worktree: &str,
) -> (String, Vec<String>, Option<String>) {
    if !temporary {
        if let Some(exec_target) = inferred_exec_target(project) {
            return (
                "/bin/bash".to_string(),
                vec!["-lc".to_string(), format!("exec {}", exec_target)],
                Some(runtime_worktree.to_string()),
            );
        }

        return (
            project.cmd.clone(),
            project.cmd_args.clone(),
            Some(runtime_worktree.to_string()),
        );
    }

    (
        "/bin/bash".to_string(),
        vec!["-i".to_string()],
        Some(runtime_worktree.to_string()),
    )
}

fn configured_session_worktree(project: &Project) -> String {
    project
        .bind_dirs
        .iter()
        .find(|dir| dir.as_str() != "/tmp")
        .cloned()
        .unwrap_or_else(|| "/projects".to_string())
}

fn resolved_session_worktree(project: &Project) -> String {
    let env_vars = project.resolved_env_vars();
    if let Some(path) = env_vars
        .get("SPARKY_RUNTIME_WORKTREE")
        .filter(|value| !value.trim().is_empty())
    {
        return path.to_string();
    }

    let configured = configured_session_worktree(project);
    resolve_runtime_worktree_compat(Path::new(&configured), project.git_url.as_deref())
        .map(|path| path.display().to_string())
        .unwrap_or(configured)
}

fn sync_codex_agents_file(project: &Project, runtime_worktree: &str) -> Result<(), String> {
    let env_vars = project.resolved_env_vars();
    let Some(codex_home) = env_vars
        .get("CODEX_HOME")
        .filter(|value| !value.trim().is_empty())
    else {
        return Ok(());
    };

    let source = Path::new(codex_home).join("AGENTS.md");
    if !source.is_file() {
        return Ok(());
    }

    let target_dir = Path::new(runtime_worktree).join(".codex");
    fs::create_dir_all(&target_dir).map_err(|error| {
        format!(
            "create codex config dir {}: {}",
            target_dir.display(),
            error
        )
    })?;

    let target = target_dir.join("AGENTS.md");
    fs::copy(&source, &target).map_err(|error| {
        format!(
            "sync codex agents {} -> {}: {}",
            source.display(),
            target.display(),
            error
        )
    })?;

    Ok(())
}

fn inferred_exec_target(project: &Project) -> Option<String> {
    if project.cmd != "/bin/bash" {
        return None;
    }

    let script = project.cmd_args.get(1)?.trim();
    let marker = "&& exec ";
    let (_, target) = script.split_once(marker)?;
    let trimmed = target.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn snapshot_file_path(project: &Project, user: &AuthSession, session_id: &str) -> Option<PathBuf> {
    let root = project.snapshot_root()?;
    Some(
        root.join(".sparky")
            .join("snapshots")
            .join(&user.user_id)
            .join(&project.project_id)
            .join(format!("{}.ansi", session_id)),
    )
}

fn legacy_snapshot_file_path(
    project: &Project,
    user: &AuthSession,
    session_id: &str,
) -> Option<PathBuf> {
    let root = project.snapshot_root()?;
    Some(
        root.join(".cc-bridge")
            .join("snapshots")
            .join(&user.user_id)
            .join(&project.project_id)
            .join(format!("{}.ansi", session_id)),
    )
}

fn load_snapshot_from_file(path: Option<&Path>) -> String {
    let Some(contents) = path.and_then(|path| fs::read_to_string(path).ok()) else {
        return String::new();
    };

    if contents.len() <= SNAPSHOT_MAX_BYTES {
        return contents;
    }

    let remove = contents.len() - SNAPSHOT_MAX_BYTES;
    let mut split = remove;
    while split < contents.len() && !contents.is_char_boundary(split) {
        split += 1;
    }
    contents[split..].to_string()
}

fn persist_snapshot_to_file(path: Option<&Path>, snapshot: &str) {
    let Some(path) = path else {
        return;
    };

    if let Some(parent) = path.parent() {
        if let Err(error) = fs::create_dir_all(parent) {
            log::warn!("create snapshot dir {}: {}", parent.display(), error);
            return;
        }
    }

    if let Err(error) = fs::write(path, snapshot) {
        log::warn!("write snapshot {}: {}", path.display(), error);
    }
}

fn remove_snapshot_file(path: Option<&Path>) {
    let Some(path) = path else {
        return;
    };

    if let Err(error) = fs::remove_file(path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            log::warn!("remove snapshot {}: {}", path.display(), error);
        }
    }

    let mut current = path.parent();
    for _ in 0..4 {
        let Some(dir) = current else {
            break;
        };

        match fs::remove_dir(dir) {
            Ok(()) => current = dir.parent(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                current = dir.parent();
            }
            Err(error) if error.kind() == std::io::ErrorKind::DirectoryNotEmpty => break,
            Err(error) => {
                log::warn!("remove snapshot dir {}: {}", dir.display(), error);
                break;
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSummary {
    pub session_id: String,
    pub project_id: String,
    pub username: String,
    pub created_at_ms: u64,
    pub alive: bool,
    pub temporary: bool,
    #[serde(default)]
    pub codex_session_id: String,
}

// ── SessionManager ─────────────────────────────────────────────────────────────

pub struct SessionManager {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    sandbox_root: PathBuf,
    cfg: ServerConfig,
}

impl SessionManager {
    pub fn new(sandbox_root: PathBuf, cfg: ServerConfig) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            sandbox_root,
            cfg,
        }
    }

    fn reap_dead_sessions(&self) {
        let dead_ids = {
            let sessions = self.sessions.lock();
            sessions
                .iter()
                .filter_map(|(id, session)| (!session.is_alive()).then_some(id.clone()))
                .collect::<Vec<_>>()
        };

        for id in dead_ids {
            self.remove(&id);
        }
    }

    /// Create a new session for the given project.
    pub fn create(
        &self,
        project: &Project,
        user: &AuthSession,
        temporary: bool,
        fresh: bool,
    ) -> Result<Arc<Session>, String> {
        self.create_with_launch(project, user, temporary, None, false, fresh)
    }

    pub fn create_with_launch(
        &self,
        project: &Project,
        user: &AuthSession,
        temporary: bool,
        launch_override: Option<LaunchOverride>,
        replace_existing: bool,
        fresh: bool,
    ) -> Result<Arc<Session>, String> {
        self.reap_dead_sessions();

        if !temporary && !fresh {
            if let Some(existing) = self.find_for_user_project(&user.user_id, &project.project_id) {
                if !replace_existing
                    && launch_override.is_none()
                    && existing.runtime_worktree == resolved_session_worktree(project)
                {
                    return Ok(existing);
                }

                let existing_id = existing.id.clone();
                drop(existing);
                self.remove(&existing_id);
            }
        }

        let session = Session::spawn(
            project,
            &self.sandbox_root,
            &self.cfg,
            user,
            temporary,
            launch_override.as_ref(),
        )?;
        let id = session.id.clone();
        let arc = Arc::new(session);
        self.sessions.lock().insert(id, arc.clone());
        Ok(arc)
    }

    /// Remove and clean up a session by ID.
    pub fn remove(&self, id: &str) {
        if let Some(session) = self.sessions.lock().remove(id) {
            session.cleanup();
        }
        let session_dir = self.sandbox_root.join("sessions").join(id);
        let _ = std::fs::remove_dir_all(session_dir);
    }

    /// Get the number of active sessions.
    pub fn len(&self) -> usize {
        self.reap_dead_sessions();
        self.sessions.lock().len()
    }

    /// Look up a session by ID.
    pub fn get(&self, id: &str) -> Option<Arc<Session>> {
        self.reap_dead_sessions();
        self.sessions.lock().get(id).cloned()
    }

    pub fn list_for_user(&self, user_id: &str) -> Vec<SessionSummary> {
        self.reap_dead_sessions();

        let mut sessions = self
            .sessions
            .lock()
            .values()
            .filter(|session| session.user_id == user_id)
            .map(|session| SessionSummary {
                session_id: session.id.clone(),
                project_id: session.project_id.clone(),
                username: session.username.clone(),
                created_at_ms: session.created_at_ms,
                alive: true,
                temporary: session.temporary,
                codex_session_id: session.codex_session_id.clone(),
            })
            .collect::<Vec<_>>();

        sessions.sort_by(|a, b| {
            b.created_at_ms
                .cmp(&a.created_at_ms)
                .then_with(|| a.project_id.cmp(&b.project_id))
        });
        sessions
    }

    pub fn remove_for_user_project(&self, user_id: &str, project_id: &str) -> usize {
        self.reap_dead_sessions();

        let ids = self
            .sessions
            .lock()
            .values()
            .filter(|session| session.user_id == user_id && session.project_id == project_id)
            .map(|session| session.id.clone())
            .collect::<Vec<_>>();

        let removed = ids.len();
        for id in ids {
            self.remove(&id);
        }
        removed
    }

    fn find_for_user_project(&self, user_id: &str, project_id: &str) -> Option<Arc<Session>> {
        self.sessions
            .lock()
            .values()
            .filter(|session| {
                session.user_id == user_id && session.project_id == project_id && !session.temporary
            })
            .max_by(|left, right| {
                left.created_at_ms
                    .cmp(&right.created_at_ms)
                    .then_with(|| left.id.cmp(&right.id))
            })
            .cloned()
    }
}
