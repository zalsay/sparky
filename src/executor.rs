use crate::auth::AuthSession;
use crate::config::ServerConfig;
use crate::dev_server::{DevServerManager, DevServerStatus, WebCandidate, WebCandidateStatus};
use crate::editor::{EditorManager, EditorStatus};
use crate::project::Project;
use crate::session::{LaunchOverride, Session, SessionManager, SessionSummary};
use actix_ws::{Message, MessageStream, Session as WsSession};
use futures_util::{future::LocalBoxFuture, StreamExt};
use std::path::Path;
use std::sync::Arc;
use tokio::time::{sleep, Duration};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionAccessError {
    NotFound,
    Forbidden,
    DefaultSessionCannotBeClosed,
}

pub trait ExecutorControl: Send + Sync {
    fn session_count(&self) -> usize;
    fn list_sessions_for_user(&self, user_id: &str) -> Vec<SessionSummary>;
    fn create_session(
        &self,
        project: &Project,
        user: &AuthSession,
        temporary: bool,
        fresh: bool,
    ) -> Result<Arc<Session>, String>;
    fn create_session_with_launch(
        &self,
        project: &Project,
        user: &AuthSession,
        temporary: bool,
        launch_override: Option<LaunchOverride>,
        replace_existing: bool,
        fresh: bool,
    ) -> Result<Arc<Session>, String>;
    fn resolve_session_for_user(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> Result<Arc<Session>, SessionAccessError>;
    fn require_temporary_session_for_user(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> Result<(), SessionAccessError>;
    fn remove_session(&self, session_id: &str);
    fn remove_project_runtime(&self, user_id: &str, project_id: &str) -> usize;
    fn ensure_editor(
        &self,
        user: &AuthSession,
        project_id: &str,
        root: &Path,
    ) -> Result<EditorStatus, String>;
    fn editor_upstream_url(
        &self,
        user_id: &str,
        project_id: &str,
        request_path: &str,
        query: Option<&str>,
    ) -> Result<String, String>;
    fn discover_web_candidates(&self, project_root: &Path) -> Result<Vec<WebCandidate>, String>;
    fn list_web_statuses(
        &self,
        user_id: &str,
        project_id: &str,
        candidates: Vec<WebCandidate>,
    ) -> Vec<WebCandidateStatus>;
    fn find_web_candidate(
        &self,
        project_root: &Path,
        candidate_id: Option<&str>,
    ) -> Result<WebCandidate, String>;
    fn ensure_dev_server(
        &self,
        user: &AuthSession,
        project_id: &str,
        candidate: &WebCandidate,
    ) -> Result<DevServerStatus, String>;
    fn restart_dev_server(
        &self,
        user: &AuthSession,
        project_id: &str,
        candidate: &WebCandidate,
    ) -> Result<DevServerStatus, String>;
    fn dev_server_upstream_url(
        &self,
        user_id: &str,
        project_id: &str,
        candidate_id: &str,
        request_path: &str,
        query: Option<&str>,
    ) -> Result<String, String>;
    fn attach_session<'a>(
        &'a self,
        user_id: &'a str,
        session_id: &'a str,
        ws_session: &'a mut WsSession,
        msg_stream: &'a mut MessageStream,
    ) -> LocalBoxFuture<'a, Result<(), SessionAccessError>>;
}

pub struct ExecutorRuntime {
    sessions: SessionManager,
    editors: EditorManager,
    dev_servers: DevServerManager,
}

impl ExecutorRuntime {
    pub fn new(config: ServerConfig) -> Self {
        Self {
            sessions: SessionManager::new(config.sandbox_root.clone(), config.clone()),
            editors: EditorManager::new(config.clone()),
            dev_servers: DevServerManager::new(config),
        }
    }

    pub fn session_count(&self) -> usize {
        self.sessions.len()
    }

    pub fn list_sessions_for_user(&self, user_id: &str) -> Vec<SessionSummary> {
        self.sessions.list_for_user(user_id)
    }

    pub fn create_session(
        &self,
        project: &Project,
        user: &AuthSession,
        temporary: bool,
        fresh: bool,
    ) -> Result<Arc<Session>, String> {
        self.sessions.create(project, user, temporary, fresh)
    }

    pub fn create_session_with_launch(
        &self,
        project: &Project,
        user: &AuthSession,
        temporary: bool,
        launch_override: Option<LaunchOverride>,
        replace_existing: bool,
        fresh: bool,
    ) -> Result<Arc<Session>, String> {
        self.sessions.create_with_launch(
            project,
            user,
            temporary,
            launch_override,
            replace_existing,
            fresh,
        )
    }

    pub fn resolve_session_for_user(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> Result<Arc<Session>, SessionAccessError> {
        match self.sessions.get(session_id) {
            Some(session) if session.user_id == user_id => Ok(session),
            Some(_) => Err(SessionAccessError::Forbidden),
            None => Err(SessionAccessError::NotFound),
        }
    }

    pub fn require_temporary_session_for_user(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> Result<(), SessionAccessError> {
        let session = self.resolve_session_for_user(user_id, session_id)?;
        if session.temporary {
            Ok(())
        } else {
            Err(SessionAccessError::DefaultSessionCannotBeClosed)
        }
    }

    pub fn remove_session(&self, session_id: &str) {
        self.sessions.remove(session_id)
    }

    pub fn remove_project_runtime(&self, user_id: &str, project_id: &str) -> usize {
        let removed_sessions = self.sessions.remove_for_user_project(user_id, project_id);
        self.dev_servers
            .remove_for_user_project(user_id, project_id);
        self.editors.remove_for_user_project(user_id, project_id);
        removed_sessions
    }

    pub fn ensure_editor(
        &self,
        user: &AuthSession,
        project_id: &str,
        root: &Path,
    ) -> Result<EditorStatus, String> {
        self.editors.ensure_running(user, project_id, root)
    }

    pub fn editor_upstream_url(
        &self,
        user_id: &str,
        project_id: &str,
        request_path: &str,
        query: Option<&str>,
    ) -> Result<String, String> {
        self.editors
            .upstream_url(user_id, project_id, request_path, query)
    }

    pub fn discover_web_candidates(
        &self,
        project_root: &Path,
    ) -> Result<Vec<WebCandidate>, String> {
        self.dev_servers.discover(project_root)
    }

    pub fn list_web_statuses(
        &self,
        user_id: &str,
        project_id: &str,
        candidates: Vec<WebCandidate>,
    ) -> Vec<WebCandidateStatus> {
        self.dev_servers
            .list_statuses(user_id, project_id, candidates)
    }

    pub fn find_web_candidate(
        &self,
        project_root: &Path,
        candidate_id: Option<&str>,
    ) -> Result<WebCandidate, String> {
        self.dev_servers.find_candidate(project_root, candidate_id)
    }

    pub fn ensure_dev_server(
        &self,
        user: &AuthSession,
        project_id: &str,
        candidate: &WebCandidate,
    ) -> Result<DevServerStatus, String> {
        self.dev_servers.ensure_running(user, project_id, candidate)
    }

    pub fn restart_dev_server(
        &self,
        user: &AuthSession,
        project_id: &str,
        candidate: &WebCandidate,
    ) -> Result<DevServerStatus, String> {
        self.dev_servers.restart(user, project_id, candidate)
    }

    pub fn dev_server_upstream_url(
        &self,
        user_id: &str,
        project_id: &str,
        candidate_id: &str,
        request_path: &str,
        query: Option<&str>,
    ) -> Result<String, String> {
        self.dev_servers
            .upstream_url(user_id, project_id, candidate_id, request_path, query)
    }

    pub async fn attach_session(
        &self,
        user_id: &str,
        session_id: &str,
        ws_session: &mut WsSession,
        msg_stream: &mut MessageStream,
    ) -> Result<(), SessionAccessError> {
        let session = self.resolve_session_for_user(user_id, session_id)?;
        run_session_ws(ws_session, msg_stream, session, session_id.to_string()).await;
        Ok(())
    }
}

impl ExecutorControl for ExecutorRuntime {
    fn session_count(&self) -> usize {
        ExecutorRuntime::session_count(self)
    }

    fn list_sessions_for_user(&self, user_id: &str) -> Vec<SessionSummary> {
        ExecutorRuntime::list_sessions_for_user(self, user_id)
    }

    fn create_session(
        &self,
        project: &Project,
        user: &AuthSession,
        temporary: bool,
        fresh: bool,
    ) -> Result<Arc<Session>, String> {
        ExecutorRuntime::create_session(self, project, user, temporary, fresh)
    }

    fn create_session_with_launch(
        &self,
        project: &Project,
        user: &AuthSession,
        temporary: bool,
        launch_override: Option<LaunchOverride>,
        replace_existing: bool,
        fresh: bool,
    ) -> Result<Arc<Session>, String> {
        ExecutorRuntime::create_session_with_launch(
            self,
            project,
            user,
            temporary,
            launch_override,
            replace_existing,
            fresh,
        )
    }

    fn resolve_session_for_user(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> Result<Arc<Session>, SessionAccessError> {
        ExecutorRuntime::resolve_session_for_user(self, user_id, session_id)
    }

    fn require_temporary_session_for_user(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> Result<(), SessionAccessError> {
        ExecutorRuntime::require_temporary_session_for_user(self, user_id, session_id)
    }

    fn remove_session(&self, session_id: &str) {
        ExecutorRuntime::remove_session(self, session_id)
    }

    fn remove_project_runtime(&self, user_id: &str, project_id: &str) -> usize {
        ExecutorRuntime::remove_project_runtime(self, user_id, project_id)
    }

    fn ensure_editor(
        &self,
        user: &AuthSession,
        project_id: &str,
        root: &Path,
    ) -> Result<EditorStatus, String> {
        ExecutorRuntime::ensure_editor(self, user, project_id, root)
    }

    fn editor_upstream_url(
        &self,
        user_id: &str,
        project_id: &str,
        request_path: &str,
        query: Option<&str>,
    ) -> Result<String, String> {
        ExecutorRuntime::editor_upstream_url(self, user_id, project_id, request_path, query)
    }

    fn discover_web_candidates(&self, project_root: &Path) -> Result<Vec<WebCandidate>, String> {
        ExecutorRuntime::discover_web_candidates(self, project_root)
    }

    fn list_web_statuses(
        &self,
        user_id: &str,
        project_id: &str,
        candidates: Vec<WebCandidate>,
    ) -> Vec<WebCandidateStatus> {
        ExecutorRuntime::list_web_statuses(self, user_id, project_id, candidates)
    }

    fn find_web_candidate(
        &self,
        project_root: &Path,
        candidate_id: Option<&str>,
    ) -> Result<WebCandidate, String> {
        ExecutorRuntime::find_web_candidate(self, project_root, candidate_id)
    }

    fn ensure_dev_server(
        &self,
        user: &AuthSession,
        project_id: &str,
        candidate: &WebCandidate,
    ) -> Result<DevServerStatus, String> {
        ExecutorRuntime::ensure_dev_server(self, user, project_id, candidate)
    }

    fn restart_dev_server(
        &self,
        user: &AuthSession,
        project_id: &str,
        candidate: &WebCandidate,
    ) -> Result<DevServerStatus, String> {
        ExecutorRuntime::restart_dev_server(self, user, project_id, candidate)
    }

    fn dev_server_upstream_url(
        &self,
        user_id: &str,
        project_id: &str,
        candidate_id: &str,
        request_path: &str,
        query: Option<&str>,
    ) -> Result<String, String> {
        ExecutorRuntime::dev_server_upstream_url(
            self,
            user_id,
            project_id,
            candidate_id,
            request_path,
            query,
        )
    }

    fn attach_session<'a>(
        &'a self,
        user_id: &'a str,
        session_id: &'a str,
        ws_session: &'a mut WsSession,
        msg_stream: &'a mut MessageStream,
    ) -> LocalBoxFuture<'a, Result<(), SessionAccessError>> {
        Box::pin(async move {
            ExecutorRuntime::attach_session(self, user_id, session_id, ws_session, msg_stream).await
        })
    }
}

async fn run_session_ws(
    ws_session: &mut WsSession,
    msg_stream: &mut MessageStream,
    session: Arc<Session>,
    session_id: String,
) {
    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(128);
    let read_session = session.clone();
    let read_session_id = session_id.clone();
    let read_task = tokio::spawn(async move {
        let (mut cursor, snapshot) = read_session.snapshot_all();

        if !snapshot.is_empty() {
            let payload = serde_json::json!({
                "type": "output",
                "content": snapshot
            })
            .to_string();

            if tx.send(payload).await.is_err() {
                return;
            }
        }

        loop {
            let (next_cursor, delta) = read_session.snapshot_since(cursor);
            cursor = next_cursor;

            if !delta.is_empty() {
                let payload = serde_json::json!({
                    "type": "output",
                    "content": delta
                })
                .to_string();

                if tx.send(payload).await.is_err() {
                    break;
                }
            }

            if !read_session.is_alive() {
                if delta.is_empty() {
                    let _ = tx
                        .send(serde_json::json!({"type": "done"}).to_string())
                        .await;
                    break;
                }
            }
            sleep(Duration::from_millis(20)).await;
        }
    });

    loop {
        tokio::select! {
            msg = msg_stream.next() => {
                match msg {
                    Some(Ok(Message::Text(t))) => {
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&t) {
                            let msg_type = json.get("type").and_then(|v| v.as_str()).unwrap_or("");

                            if msg_type == "ping" {
                                if ws_session
                                    .text(serde_json::json!({"type": "pong"}).to_string())
                                    .await
                                    .is_err()
                                {
                                    break;
                                }
                                continue;
                            }

                            if msg_type == "resize" {
                                let rows = json
                                    .get("rows")
                                    .and_then(|v| v.as_u64())
                                    .and_then(|value| u16::try_from(value).ok())
                                    .unwrap_or(0);
                                let cols = json
                                    .get("cols")
                                    .and_then(|v| v.as_u64())
                                    .and_then(|value| u16::try_from(value).ok())
                                    .unwrap_or(0);

                                if rows > 0 && cols > 0 {
                                    let _ = session.resize(rows, cols);
                                }
                                continue;
                            }

                            let content = json.get("content")
                                .or_else(|| json.get("input"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("");

                            if !content.is_empty() {
                                let _ = session.send(content);
                            }
                        }
                    }
                    Some(Ok(Message::Close(reason))) => {
                        log::info!("WS [{}] closed: {:?}", session_id, reason);
                        break;
                    }
                    Some(Ok(Message::Ping(data))) => {
                        if ws_session.pong(&data).await.is_err() {
                            break;
                        }
                    }
                    Some(Err(error)) => {
                        log::error!("WS [{}] error: {}", session_id, error);
                        break;
                    }
                    None => break,
                    _ => {}
                }
            }

            out = rx.recv() => {
                if let Some(text) = out {
                    if ws_session.text(text).await.is_err() {
                        break;
                    }
                } else {
                    log::debug!("WS [{}] snapshot task ended", read_session_id);
                    break;
                }
            }
        }
    }

    read_task.abort();
    log::info!("WS [{}] ended", session_id);
}
