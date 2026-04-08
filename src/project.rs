//! Project definitions for Sparky sandbox environments.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

/// A single project environment configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    /// Unique project identifier, e.g. "python-dev", "rust-prod"
    pub project_id: String,
    /// Optional user-facing display name.
    #[serde(default)]
    pub display_name: Option<String>,
    /// Optional provider label for UI rendering.
    #[serde(default)]
    pub provider: Option<String>,
    /// Optional summary copy for UI rendering.
    #[serde(default)]
    pub summary: Option<String>,
    /// Optional accent key for UI rendering.
    #[serde(default)]
    pub accent: Option<String>,
    /// Optional tagline for UI rendering.
    #[serde(default)]
    pub tagline: Option<String>,
    /// Optional git remote used to initialize the project.
    #[serde(default)]
    pub git_url: Option<String>,
    /// Read-only root filesystem path for this project
    pub root_fs: String,
    /// Extra directories to bind-mount into the sandbox (writable)
    #[serde(default)]
    pub bind_dirs: Vec<String>,
    /// Environment variables to set inside the sandbox (supports {{ENV_VAR}} substitution)
    #[serde(default)]
    pub env_vars: HashMap<String, String>,
    /// Default command to run (e.g. "claude-code", "/usr/bin/python3")
    #[serde(default = "default_cmd")]
    pub cmd: String,
    /// Command arguments
    #[serde(default)]
    pub cmd_args: Vec<String>,
}

fn default_cmd() -> String {
    "claude".to_string()
}

/// Expand {{ENV_VAR}} patterns in a string with actual environment variable values.
fn expand_env(s: &str) -> String {
    let mut result = s.to_string();
    // Keep substituting until no more substitutions found (handles nested)
    loop {
        let before = result.clone();
        for (key, val) in std::env::vars() {
            let pattern = format!("{{{{{}}}}}", key);
            result = result.replace(&pattern, &val);
        }
        // Also handle ${VAR} syntax
        for (key, val) in std::env::vars() {
            let pattern = format!("${{{}}}", key);
            result = result.replace(&pattern, &val);
        }
        if result == before {
            break;
        }
    }
    result
}

impl Project {
    /// Get environment variables with {{ENV_VAR}} substitution applied.
    pub fn resolved_env_vars(&self) -> HashMap<String, String> {
        self.env_vars
            .iter()
            .map(|(k, v)| (k.clone(), expand_env(v)))
            .collect()
    }

    /// Resolve the writable project root used for snapshot persistence.
    pub fn snapshot_root(&self) -> Option<PathBuf> {
        let env_vars = self.resolved_env_vars();

        if let Some(path) = env_vars
            .get("CC_SNAPSHOT_DIR")
            .filter(|value| !value.trim().is_empty())
        {
            return Some(PathBuf::from(path));
        }

        if self.bind_dirs.iter().any(|dir| dir == "/workspace") {
            return Some(PathBuf::from("/workspace"));
        }

        self.bind_dirs
            .iter()
            .find(|dir| dir.as_str() != "/tmp")
            .map(PathBuf::from)
    }
}

/// All projects loaded from config file.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Projects {
    #[serde(default)]
    pub projects: Vec<Project>,
}

impl Projects {
    /// Find a project by its id.
    pub fn find(&self, id: &str) -> Option<&Project> {
        self.projects.iter().find(|p| p.project_id == id)
    }
}

pub struct ProjectStore {
    base_path: PathBuf,
    custom_root: PathBuf,
    builtins: Vec<Project>,
}

impl ProjectStore {
    pub fn new(base_path: PathBuf, custom_root: PathBuf) -> Self {
        let builtins = load_projects_from_path(&base_path).projects;

        Self {
            base_path,
            custom_root,
            builtins,
        }
    }

    pub fn list_for_user(&self, user_id: &str) -> Vec<Project> {
        self.load_custom_for_user(user_id)
    }

    pub fn len(&self) -> usize {
        self.builtins.len()
    }

    pub fn find_for_user(&self, user_id: &str, id: &str) -> Option<Project> {
        self.load_custom_for_user(user_id)
            .into_iter()
            .find(|project| project.project_id == id)
    }

    pub fn is_builtin(&self, id: &str) -> bool {
        self.builtins.iter().any(|project| project.project_id == id)
    }

    pub fn path_in_use(&self, user_id: &str, path: &str) -> bool {
        self.path_in_use_except(user_id, path, None)
    }

    pub fn path_in_use_except(
        &self,
        user_id: &str,
        path: &str,
        exclude_project_id: Option<&str>,
    ) -> bool {
        self.load_custom_for_user(user_id).iter().any(|project| {
            if exclude_project_id.is_some_and(|exclude| project.project_id == exclude) {
                return false;
            }
            project
                .bind_dirs
                .iter()
                .any(|dir| dir.as_str() != "/tmp" && dir == path)
        })
    }

    pub fn add_custom_project(&self, user_id: &str, project: Project) -> Result<Project, String> {
        let mut custom = self.load_custom_for_user(user_id);

        if custom
            .iter()
            .any(|existing| existing.project_id == project.project_id)
        {
            return Err(format!("project '{}' already exists", project.project_id));
        }

        if project
            .bind_dirs
            .iter()
            .find(|dir| dir.as_str() != "/tmp")
            .is_some_and(|path| {
                custom.iter().any(|existing| {
                    existing
                        .bind_dirs
                        .iter()
                        .any(|dir| dir.as_str() != "/tmp" && dir == path)
                })
            })
        {
            return Err("project path already configured".to_string());
        }

        custom.push(project.clone());
        persist_custom_projects(&self.custom_path_for_user(user_id), &custom)?;
        Ok(project)
    }

    pub fn remove_custom_project(
        &self,
        user_id: &str,
        project_id: &str,
    ) -> Result<Project, String> {
        if self.is_builtin(project_id) {
            return Err("builtin projects cannot be removed".to_string());
        }

        let mut custom = self.load_custom_for_user(user_id);
        let Some(index) = custom
            .iter()
            .position(|project| project.project_id == project_id)
        else {
            return Err("project not found".to_string());
        };

        let removed = custom.remove(index);
        persist_custom_projects(&self.custom_path_for_user(user_id), &custom)?;
        Ok(removed)
    }

    pub fn update_custom_project(
        &self,
        user_id: &str,
        project_id: &str,
        project: Project,
    ) -> Result<Project, String> {
        if self.is_builtin(project_id) {
            return Err("builtin projects cannot be edited".to_string());
        }

        let mut custom = self.load_custom_for_user(user_id);
        let Some(index) = custom
            .iter()
            .position(|existing| existing.project_id == project_id)
        else {
            return Err("project not found".to_string());
        };

        if project
            .bind_dirs
            .iter()
            .find(|dir| dir.as_str() != "/tmp")
            .is_some_and(|path| self.path_in_use_except(user_id, path, Some(project_id)))
        {
            return Err("project path already configured".to_string());
        }

        custom[index] = project.clone();
        persist_custom_projects(&self.custom_path_for_user(user_id), &custom)?;
        Ok(project)
    }

    pub fn base_path(&self) -> &PathBuf {
        &self.base_path
    }

    pub fn custom_root(&self) -> &PathBuf {
        &self.custom_root
    }

    pub fn custom_path_for_user(&self, user_id: &str) -> PathBuf {
        self.custom_root
            .join("users")
            .join(user_id)
            .join("projects.json")
    }

    fn load_custom_for_user(&self, user_id: &str) -> Vec<Project> {
        load_projects_from_path(&self.custom_path_for_user(user_id)).projects
    }
}

fn load_projects_from_path(path: &PathBuf) -> Projects {
    match fs::read_to_string(path) {
        Ok(content) => match serde_json::from_str::<Projects>(&content) {
            Ok(projects) => {
                log::info!(
                    "Loaded {} projects from {}",
                    projects.projects.len(),
                    path.display()
                );
                projects
            }
            Err(error) => {
                log::warn!("Failed to parse {}: {}", path.display(), error);
                Projects::default()
            }
        },
        Err(error) => {
            if error.kind() == std::io::ErrorKind::NotFound {
                log::info!("No project config at {}", path.display());
            } else {
                log::warn!("No project config at {}: {}", path.display(), error);
            }
            Projects::default()
        }
    }
}

fn persist_custom_projects(path: &Path, projects: &[Project]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!("create custom project dir {}: {}", parent.display(), error)
        })?;
    }

    let payload = serde_json::to_string_pretty(&Projects {
        projects: projects.to_vec(),
    })
    .map_err(|error| format!("serialize custom projects: {}", error))?;

    fs::write(path, payload)
        .map_err(|error| format!("write custom project file {}: {}", path.display(), error))
}
