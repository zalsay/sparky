use crate::auth::AuthSession;
use crate::dev_server::{DevServerStatus, WebCandidate, WebCandidateStatus};
use crate::editor::EditorStatus;
use crate::editor::FileTreeListing;
use crate::git::{GitAction, GitActionResult, GitStatusSummary};
use crate::project::Project;
use crate::session::{LaunchOverride, SessionSummary};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutorUserPayload {
    pub user_id: String,
    pub username: String,
    pub home_dir: String,
}

#[allow(dead_code)]
impl ExecutorUserPayload {
    pub fn from_auth_session(user: &AuthSession) -> Self {
        Self {
            user_id: user.user_id.clone(),
            username: user.username.clone(),
            home_dir: user.home_dir.display().to_string(),
        }
    }

    pub fn into_auth_session(self) -> AuthSession {
        AuthSession {
            token: "__executor__".to_string(),
            user_id: self.user_id,
            username: self.username,
            home_dir: PathBuf::from(self.home_dir),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateExecutorSessionRequest {
    pub project: Project,
    pub user: ExecutorUserPayload,
    #[serde(default)]
    pub temporary: bool,
    #[serde(default)]
    pub fresh: bool,
    #[serde(default)]
    pub replace_existing: bool,
    pub launch_override: Option<LaunchOverride>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutorSessionResponse {
    pub session: SessionSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutorSessionsResponse {
    pub sessions: Vec<SessionSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenEditorRequest {
    pub user: ExecutorUserPayload,
    pub project_id: String,
    pub root: String,
    pub path: Option<String>,
}

#[allow(dead_code)]
impl OpenEditorRequest {
    pub fn root_path(&self) -> &Path {
        Path::new(&self.root)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenEditorResponse {
    pub status: EditorStatus,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebTargetsRequest {
    pub user: ExecutorUserPayload,
    pub project_id: String,
    pub root: String,
}

#[allow(dead_code)]
impl WebTargetsRequest {
    pub fn root_path(&self) -> &Path {
        Path::new(&self.root)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebTargetsResponse {
    pub targets: Vec<WebCandidateStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenWebRequest {
    pub user: ExecutorUserPayload,
    pub project_id: String,
    pub root: String,
    pub candidate_id: Option<String>,
}

#[allow(dead_code)]
impl OpenWebRequest {
    pub fn root_path(&self) -> &Path {
        Path::new(&self.root)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenWebResponse {
    pub target: WebCandidate,
    pub status: DevServerStatus,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileTreeRequest {
    pub project_root: String,
    pub path: Option<String>,
}

#[allow(dead_code)]
impl FileTreeRequest {
    pub fn project_root_path(&self) -> &Path {
        Path::new(&self.project_root)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileTreeResponse {
    pub tree: FileTreeListing,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitStatusRequest {
    pub user: ExecutorUserPayload,
    pub project_root: String,
}

#[allow(dead_code)]
impl GitStatusRequest {
    pub fn project_root_path(&self) -> &Path {
        Path::new(&self.project_root)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitStatusResponse {
    pub status: GitStatusSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitActionRequest {
    pub user: ExecutorUserPayload,
    pub project_root: String,
    pub action: GitAction,
}

#[allow(dead_code)]
impl GitActionRequest {
    pub fn project_root_path(&self) -> &Path {
        Path::new(&self.project_root)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitActionResponse {
    pub output: String,
    pub status: GitStatusSummary,
}

impl From<GitActionResult> for GitActionResponse {
    fn from(value: GitActionResult) -> Self {
        Self {
            output: value.output,
            status: value.status,
        }
    }
}
