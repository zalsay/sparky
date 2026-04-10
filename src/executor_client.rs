use crate::auth::AuthSession;
use crate::git::{GitAction, GitStatusSummary};
use crate::internal_api::{
    CreateExecutorSessionRequest, ExecutorSessionResponse, ExecutorSessionsResponse,
    ExecutorUserPayload, FileTreeRequest, FileTreeResponse, GitActionRequest, GitActionResponse,
    GitStatusRequest, GitStatusResponse, OpenEditorRequest, OpenEditorResponse, OpenWebRequest,
    OpenWebResponse, WebTargetsRequest, WebTargetsResponse,
};
use crate::project::Project;
use crate::session::{LaunchOverride, SessionSummary};
use awc::Client;
use bytes::Bytes;
use futures_util::Stream;
use serde::{de::DeserializeOwned, Deserialize, Serialize};

#[derive(Clone)]
pub struct RemoteExecutorClient {
    base_url: String,
}

#[derive(Debug, Clone)]
pub struct RemoteExecutorError {
    pub status: u16,
    pub message: String,
}

#[derive(Debug, Deserialize)]
struct ExecutorErrorResponse {
    error: String,
}

impl RemoteExecutorClient {
    pub fn new(base_url: String) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
        }
    }

    pub fn attach_ws_url(&self, session_id: &str, user_id: &str) -> String {
        let base = if let Some(rest) = self.base_url.strip_prefix("https://") {
            format!("wss://{}", rest)
        } else if let Some(rest) = self.base_url.strip_prefix("http://") {
            format!("ws://{}", rest)
        } else {
            self.base_url.clone()
        };

        format!(
            "{}/internal/sessions/{}/attach?user_id={}",
            base,
            url_encode_path(session_id),
            url_encode_query(user_id),
        )
    }

    pub fn editor_proxy_url(
        &self,
        project_id: &str,
        request_path: &str,
        query: Option<&str>,
    ) -> String {
        let normalized_path = request_path.trim_start_matches('/');
        let mut url = if normalized_path.is_empty() {
            format!(
                "{}/internal/editors/{}/proxy",
                self.base_url,
                url_encode_path(project_id),
            )
        } else {
            format!(
                "{}/internal/editors/{}/proxy/{}",
                self.base_url,
                url_encode_path(project_id),
                normalized_path,
            )
        };

        if let Some(query) = query.filter(|value| !value.is_empty()) {
            url.push('?');
            url.push_str(query);
        }

        url
    }

    pub fn dev_server_proxy_url(
        &self,
        project_id: &str,
        candidate_id: &str,
        tail: &str,
        query: Option<&str>,
    ) -> String {
        let normalized_tail = tail.trim_start_matches('/');
        let mut url = if normalized_tail.is_empty() {
            format!(
                "{}/internal/dev/{}/{}/proxy",
                self.base_url,
                url_encode_path(project_id),
                url_encode_path(candidate_id),
            )
        } else {
            format!(
                "{}/internal/dev/{}/{}/proxy/{}",
                self.base_url,
                url_encode_path(project_id),
                url_encode_path(candidate_id),
                normalized_tail,
            )
        };

        if let Some(query) = query.filter(|value| !value.is_empty()) {
            url.push('?');
            url.push_str(query);
        }

        url
    }

    pub async fn list_sessions_for_user(
        &self,
        user_id: &str,
    ) -> Result<Vec<SessionSummary>, RemoteExecutorError> {
        let url = format!(
            "{}/internal/sessions?user_id={}",
            self.base_url,
            url_encode_query(user_id),
        );
        let response: ExecutorSessionsResponse = self.get_json(url.as_str()).await?;
        Ok(response.sessions)
    }

    pub async fn get_session(
        &self,
        user_id: &str,
        session_id: &str,
    ) -> Result<SessionSummary, RemoteExecutorError> {
        let url = format!(
            "{}/internal/sessions/{}?user_id={}",
            self.base_url,
            url_encode_path(session_id),
            url_encode_query(user_id),
        );
        let response: ExecutorSessionResponse = self.get_json(url.as_str()).await?;
        Ok(response.session)
    }

    pub async fn create_session(
        &self,
        project: &Project,
        user: &AuthSession,
        temporary: bool,
        fresh: bool,
        replace_existing: bool,
        launch_override: Option<LaunchOverride>,
    ) -> Result<SessionSummary, RemoteExecutorError> {
        let request = CreateExecutorSessionRequest {
            project: project.clone(),
            user: ExecutorUserPayload::from_auth_session(user),
            temporary,
            fresh,
            replace_existing,
            launch_override,
        };

        let url = format!("{}/internal/sessions", self.base_url);
        let response: ExecutorSessionResponse = self.post_json(url.as_str(), &request).await?;
        Ok(response.session)
    }

    pub async fn open_editor(
        &self,
        user: &AuthSession,
        project_id: &str,
        root: &std::path::Path,
        path: Option<&str>,
    ) -> Result<OpenEditorResponse, RemoteExecutorError> {
        let request = OpenEditorRequest {
            user: ExecutorUserPayload::from_auth_session(user),
            project_id: project_id.to_string(),
            root: root.display().to_string(),
            path: path.map(str::to_string),
        };

        let url = format!("{}/internal/editors/open", self.base_url);
        self.post_json(url.as_str(), &request).await
    }

    pub async fn list_web_targets(
        &self,
        user: &AuthSession,
        project_id: &str,
        root: &std::path::Path,
    ) -> Result<WebTargetsResponse, RemoteExecutorError> {
        let request = WebTargetsRequest {
            user: ExecutorUserPayload::from_auth_session(user),
            project_id: project_id.to_string(),
            root: root.display().to_string(),
        };

        let url = format!("{}/internal/web/targets", self.base_url);
        self.post_json(url.as_str(), &request).await
    }

    pub async fn open_web_target(
        &self,
        user: &AuthSession,
        project_id: &str,
        root: &std::path::Path,
        candidate_id: Option<&str>,
    ) -> Result<OpenWebResponse, RemoteExecutorError> {
        let request = OpenWebRequest {
            user: ExecutorUserPayload::from_auth_session(user),
            project_id: project_id.to_string(),
            root: root.display().to_string(),
            candidate_id: candidate_id.map(str::to_string),
        };

        let url = format!("{}/internal/web/open", self.base_url);
        self.post_json(url.as_str(), &request).await
    }

    pub async fn restart_web_target(
        &self,
        user: &AuthSession,
        project_id: &str,
        root: &std::path::Path,
        candidate_id: Option<&str>,
    ) -> Result<OpenWebResponse, RemoteExecutorError> {
        let request = OpenWebRequest {
            user: ExecutorUserPayload::from_auth_session(user),
            project_id: project_id.to_string(),
            root: root.display().to_string(),
            candidate_id: candidate_id.map(str::to_string),
        };

        let url = format!("{}/internal/web/restart", self.base_url);
        self.post_json(url.as_str(), &request).await
    }

    pub async fn list_file_tree(
        &self,
        project_root: &std::path::Path,
        path: Option<&str>,
    ) -> Result<FileTreeResponse, RemoteExecutorError> {
        let request = FileTreeRequest {
            project_root: project_root.display().to_string(),
            path: path.map(str::to_string),
        };

        let url = format!("{}/internal/files/tree", self.base_url);
        self.post_json(url.as_str(), &request).await
    }

    pub async fn git_status(
        &self,
        user: &AuthSession,
        project_root: &std::path::Path,
    ) -> Result<GitStatusSummary, RemoteExecutorError> {
        let request = GitStatusRequest {
            user: ExecutorUserPayload::from_auth_session(user),
            project_root: project_root.display().to_string(),
        };

        let url = format!("{}/internal/git/status", self.base_url);
        let response: GitStatusResponse = self.post_json(url.as_str(), &request).await?;
        Ok(response.status)
    }

    pub async fn git_action(
        &self,
        user: &AuthSession,
        project_root: &std::path::Path,
        action: GitAction,
    ) -> Result<GitActionResponse, RemoteExecutorError> {
        let request = GitActionRequest {
            user: ExecutorUserPayload::from_auth_session(user),
            project_root: project_root.display().to_string(),
            action,
        };

        let url = format!("{}/internal/git/action", self.base_url);
        self.post_json(url.as_str(), &request).await
    }

    pub async fn destroy_session(
        &self,
        user_id: &str,
        session_id: &str,
        allow_persistent: bool,
    ) -> Result<(), RemoteExecutorError> {
        let url = format!(
            "{}/internal/sessions/{}?user_id={}&allow_persistent={}",
            self.base_url,
            url_encode_path(session_id),
            url_encode_query(user_id),
            if allow_persistent { "true" } else { "false" },
        );

        let mut response =
            self.http()
                .delete(url)
                .send()
                .await
                .map_err(|error| RemoteExecutorError {
                    status: 502,
                    message: format!("executor request failed: {}", error),
                })?;

        if response.status().is_success() {
            return Ok(());
        }

        Err(read_executor_error(&mut response).await)
    }

    async fn get_json<T: DeserializeOwned>(&self, url: &str) -> Result<T, RemoteExecutorError> {
        let mut response =
            self.http()
                .get(url)
                .send()
                .await
                .map_err(|error| RemoteExecutorError {
                    status: 502,
                    message: format!("executor request failed: {}", error),
                })?;

        if response.status().is_success() {
            return response
                .json::<T>()
                .await
                .map_err(|error| RemoteExecutorError {
                    status: 502,
                    message: format!("decode executor response: {}", error),
                });
        }

        Err(read_executor_error(&mut response).await)
    }

    async fn post_json<T: DeserializeOwned, S: Serialize>(
        &self,
        url: &str,
        payload: &S,
    ) -> Result<T, RemoteExecutorError> {
        let mut response = self
            .http()
            .post(url)
            .send_json(payload)
            .await
            .map_err(|error| RemoteExecutorError {
                status: 502,
                message: format!("executor request failed: {}", error),
            })?;

        if response.status().is_success() {
            return response
                .json::<T>()
                .await
                .map_err(|error| RemoteExecutorError {
                    status: 502,
                    message: format!("decode executor response: {}", error),
                });
        }

        Err(read_executor_error(&mut response).await)
    }

    fn http(&self) -> Client {
        Client::default()
    }
}

async fn read_executor_error<S>(response: &mut awc::ClientResponse<S>) -> RemoteExecutorError
where
    S: Stream<Item = Result<Bytes, awc::error::PayloadError>> + Unpin,
{
    let status = response.status().as_u16();
    match response.body().limit(64 * 1024).await {
        Ok(bytes) => match serde_json::from_slice::<ExecutorErrorResponse>(&bytes) {
            Ok(payload) => RemoteExecutorError {
                status,
                message: payload.error,
            },
            Err(_) => RemoteExecutorError {
                status,
                message: String::from_utf8_lossy(&bytes).trim().to_string(),
            },
        },
        Err(error) => RemoteExecutorError {
            status,
            message: format!("executor returned status {}: {}", status, error),
        },
    }
}

fn url_encode_query(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            b' ' => vec!['+'],
            other => format!("%{:02X}", other).chars().collect(),
        })
        .collect()
}

fn url_encode_path(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            other => format!("%{:02X}", other).chars().collect(),
        })
        .collect()
}
