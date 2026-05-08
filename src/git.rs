use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone)]
pub struct GitRuntimeContext {
    pub home_dir: PathBuf,
    pub ssh_auth_sock: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitStatusSummary {
    pub available: bool,
    pub root: String,
    pub branch: String,
    pub message: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub has_changes: bool,
    pub changes: Vec<GitFileChange>,
    pub staged_count: usize,
    pub unstaged_count: usize,
    pub untracked_count: usize,
    pub last_commit: Option<GitCommitSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitFileChange {
    pub path: String,
    pub original_path: Option<String>,
    pub staged: String,
    pub unstaged: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitCommitSummary {
    pub id: String,
    pub subject: String,
    pub author: String,
    pub relative_time: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum GitAction {
    Fetch,
    Pull,
    Push,
    StageAll,
    Commit {
        message: String,
        author_name: String,
        author_email: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitActionResult {
    pub output: String,
    pub status: GitStatusSummary,
}

pub fn load_git_status(
    project_root: &Path,
    runtime: &GitRuntimeContext,
) -> Result<GitStatusSummary, String> {
    let Some(repo_root) = resolve_repo_root(project_root)? else {
        return Ok(unavailable_status(project_root));
    };

    let branch_output = git_output(&repo_root, runtime, ["status", "--porcelain=1", "--branch"])?;
    let status_text = output_text(&branch_output);
    let mut lines = status_text.lines();
    let header = lines.next().unwrap_or_default();
    let (branch, upstream, ahead, behind) = parse_branch_header(header);

    let mut changes = Vec::new();
    let mut staged_count = 0usize;
    let mut unstaged_count = 0usize;
    let mut untracked_count = 0usize;

    for line in lines {
        if line.trim().is_empty() || !line.is_ascii() {
            continue;
        }

        if line.len() < 3 {
            continue;
        }

        let staged = line[0..1].to_string();
        let unstaged = line[1..2].to_string();
        let rest = line[3..].trim();
        let (path, original_path) = if rest.contains(" -> ") {
            let mut parts = rest.splitn(2, " -> ");
            let from = parts.next().unwrap_or_default().trim().to_string();
            let to = parts.next().unwrap_or_default().trim().to_string();
            (to, Some(from))
        } else {
            (rest.to_string(), None)
        };

        if staged.trim() != "?" && staged.trim() != "" {
            staged_count += 1;
        }
        if unstaged.trim() != "?" && unstaged.trim() != "" {
            unstaged_count += 1;
        }
        if staged == "?" || unstaged == "?" {
            untracked_count += 1;
        }

        changes.push(GitFileChange {
            path,
            original_path,
            staged,
            unstaged,
        });
    }

    let last_commit = git_last_commit(&repo_root, runtime);

    Ok(GitStatusSummary {
        available: true,
        root: repo_root.display().to_string(),
        branch,
        message: None,
        upstream,
        ahead,
        behind,
        has_changes: !changes.is_empty(),
        changes,
        staged_count,
        unstaged_count,
        untracked_count,
        last_commit,
    })
}

pub fn execute_git_action(
    project_root: &Path,
    runtime: &GitRuntimeContext,
    action: GitAction,
) -> Result<GitActionResult, String> {
    let Some(repo_root) = resolve_repo_root(project_root)? else {
        return Err("当前项目目录还不是 Git 仓库".to_string());
    };

    align_branch_with_remote_default(&repo_root, runtime)?;
    let status_before = load_git_status(&repo_root, runtime)?;

    let output = match action {
        GitAction::Fetch => git_output(&repo_root, runtime, ["fetch", "--all", "--prune"])?,
        GitAction::Pull => execute_pull(&repo_root, runtime, &status_before)?,
        GitAction::Push => execute_push(&repo_root, runtime, &status_before)?,
        GitAction::StageAll => git_output(&repo_root, runtime, ["add", "-A"])?,
        GitAction::Commit {
            message,
            author_name,
            author_email,
        } => {
            let trimmed = message.trim();
            if trimmed.is_empty() {
                return Err("commit message is required".to_string());
            }
            git_output(&repo_root, runtime, ["add", "-A"])?;
            git_output_with_env(
                &repo_root,
                runtime,
                ["commit", "-m", trimmed],
                [
                    ("GIT_AUTHOR_NAME", author_name.as_str()),
                    ("GIT_AUTHOR_EMAIL", author_email.as_str()),
                    ("GIT_COMMITTER_NAME", author_name.as_str()),
                    ("GIT_COMMITTER_EMAIL", author_email.as_str()),
                ],
            )?
        }
    };

    let status = load_git_status(&repo_root, runtime)?;
    Ok(GitActionResult {
        output: output_text(&output),
        status,
    })
}

pub fn ensure_local_branch_tracking(
    project_root: &Path,
    runtime: &GitRuntimeContext,
) -> Result<(), String> {
    let Some(repo_root) = resolve_repo_root(project_root)? else {
        return Ok(());
    };

    align_branch_with_remote_default(&repo_root, runtime)?;

    if has_upstream(&repo_root, runtime)? {
        return Ok(());
    }

    let branch = current_branch(&repo_root, runtime)?;
    let remote = default_remote(&repo_root, runtime)?;
    let remote_key = format!("branch.{}.remote", branch);
    let merge_key = format!("branch.{}.merge", branch);
    let merge_ref = format!("refs/heads/{}", branch);

    git_output(
        &repo_root,
        runtime,
        ["config", "--local", remote_key.as_str(), remote.as_str()],
    )?;
    git_output(
        &repo_root,
        runtime,
        ["config", "--local", merge_key.as_str(), merge_ref.as_str()],
    )?;

    Ok(())
}

fn align_branch_with_remote_default(
    repo_root: &Path,
    runtime: &GitRuntimeContext,
) -> Result<(), String> {
    let current = current_branch(repo_root, runtime)?;
    if current != "master" {
        return Ok(());
    }

    let remote = default_remote(repo_root, runtime)?;
    if remote_branch_exists(repo_root, runtime, &remote, "master")? {
        return Ok(());
    }

    let Some(default_branch) = remote_default_branch(repo_root, runtime, &remote)? else {
        return Ok(());
    };

    if default_branch != "main" {
        return Ok(());
    }

    if local_branch_exists(repo_root, runtime, "main")? {
        git_output(repo_root, runtime, ["checkout", "main"])?;
        return Ok(());
    }

    if remote_branch_exists(repo_root, runtime, &remote, "main")? {
        git_output(
            repo_root,
            runtime,
            [
                "checkout",
                "-b",
                "main",
                "--track",
                &format!("{}/main", remote),
            ],
        )?;
    }

    Ok(())
}

fn execute_pull(
    repo_root: &Path,
    runtime: &GitRuntimeContext,
    status: &GitStatusSummary,
) -> Result<std::process::Output, String> {
    if status.upstream.is_some() {
        return git_output(repo_root, runtime, ["pull", "--ff-only"]);
    }

    let branch = current_branch(repo_root, runtime)?;
    let remote = default_remote(repo_root, runtime)?;
    git_output(
        repo_root,
        runtime,
        [
            "pull",
            "--ff-only",
            "--set-upstream",
            remote.as_str(),
            branch.as_str(),
        ],
    )
}

fn execute_push(
    repo_root: &Path,
    runtime: &GitRuntimeContext,
    status: &GitStatusSummary,
) -> Result<std::process::Output, String> {
    if status.upstream.is_some() {
        return git_output(repo_root, runtime, ["push"]);
    }

    let branch = current_branch(repo_root, runtime)?;
    let remote = default_remote(repo_root, runtime)?;
    git_output(
        repo_root,
        runtime,
        ["push", "-u", remote.as_str(), branch.as_str()],
    )
}

pub fn has_git_repository(project_root: &Path) -> Result<bool, String> {
    resolve_repo_root(project_root).map(|root| root.is_some())
}

pub fn discover_git_roots(project_root: &Path) -> Result<Vec<PathBuf>, String> {
    if !project_root.exists() {
        return Ok(Vec::new());
    }

    let mut roots = discover_nested_repo_roots(project_root)?;

    match repo_root(project_root) {
        Ok(root) => roots.push(root),
        Err(error) if is_not_git_repository_error(&error) => {}
        Err(error) => return Err(error),
    }

    roots.sort();
    roots.dedup();
    Ok(roots)
}

pub fn resolve_runtime_worktree_compat(
    project_root: &Path,
    preferred_remote: Option<&str>,
) -> Result<PathBuf, String> {
    if !project_root.exists() {
        return Ok(project_root.to_path_buf());
    }

    match repo_root(project_root) {
        Ok(root) => Ok(root),
        Err(error) if is_not_git_repository_error(&error) => {
            let roots = discover_nested_repo_roots(project_root)?;
            if roots.is_empty() {
                return Ok(project_root.to_path_buf());
            }

            if roots.len() == 1 {
                return Ok(roots
                    .into_iter()
                    .next()
                    .unwrap_or_else(|| project_root.to_path_buf()));
            }

            if let Some(remote) = preferred_remote.and_then(normalize_git_remote_key) {
                let matching = roots
                    .iter()
                    .filter(|root| repo_matches_remote(root, &remote))
                    .cloned()
                    .collect::<Vec<_>>();

                if !matching.is_empty() {
                    return Ok(pick_preferred_root(project_root, matching));
                }
            }

            Ok(pick_preferred_root(project_root, roots))
        }
        Err(error) => Err(error),
    }
}

pub fn resolve_runtime_worktree(project_root: &Path) -> Result<PathBuf, String> {
    Ok(resolve_repo_root(project_root)?.unwrap_or_else(|| project_root.to_path_buf()))
}

fn resolve_repo_root(project_root: &Path) -> Result<Option<PathBuf>, String> {
    if !project_root.exists() {
        return Ok(None);
    }

    match repo_root(project_root) {
        Ok(root) => Ok(Some(root)),
        Err(error) if is_not_git_repository_error(&error) => {
            let roots = discover_nested_repo_roots(project_root)?;
            match roots.len() {
                0 => Ok(None),
                1 => Ok(roots.into_iter().next()),
                _ => Err("项目目录下存在多个 Git 仓库，请把项目路径指向具体仓库根目录".to_string()),
            }
        }
        Err(error) => Err(error),
    }
}

fn repo_root(project_root: &Path) -> Result<PathBuf, String> {
    let output = Command::new("git")
        .args(["-c", "safe.directory=*", "rev-parse", "--show-toplevel"])
        .current_dir(project_root)
        .output()
        .map_err(|error| format!("run git: {}", error))?;

    if !output.status.success() {
        let message = output_text(&output);
        let trimmed = message.trim();
        if trimmed.is_empty() {
            return Err(format!("git command failed with status {}", output.status));
        }
        return Err(trimmed.to_string());
    }

    let root = output_text(&output).trim().to_string();
    if root.is_empty() {
        return Err("git repository not found".to_string());
    }
    Ok(PathBuf::from(root))
}

fn repo_matches_remote(repo_root: &Path, preferred_remote: &str) -> bool {
    let output = Command::new("git")
        .args(["-c", "safe.directory=*", "remote", "-v"])
        .current_dir(repo_root)
        .output();

    let Ok(output) = output else {
        return false;
    };
    if !output.status.success() {
        return false;
    }

    output_text(&output)
        .lines()
        .filter_map(|line| line.split_whitespace().nth(1))
        .filter_map(normalize_git_remote_key)
        .any(|remote| remote == preferred_remote)
}

fn normalize_git_remote_key(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }

    let normalized = if let Some(rest) = trimmed.strip_prefix("git@") {
        let (host, path) = rest.split_once(':')?;
        format!("{}/{}", host, path)
    } else if let Some((_, rest)) = trimmed.split_once("://") {
        let without_user = rest.rsplit_once('@').map(|(_, tail)| tail).unwrap_or(rest);
        without_user.trim_start_matches('/').to_string()
    } else {
        trimmed.to_string()
    };

    Some(
        normalized
            .trim_end_matches(".git")
            .trim_end_matches('/')
            .to_ascii_lowercase(),
    )
}

fn pick_preferred_root(project_root: &Path, roots: Vec<PathBuf>) -> PathBuf {
    roots
        .into_iter()
        .min_by(|left, right| compare_repo_candidates(project_root, left, right))
        .unwrap_or_else(|| project_root.to_path_buf())
}

fn compare_repo_candidates(
    project_root: &Path,
    left: &PathBuf,
    right: &PathBuf,
) -> std::cmp::Ordering {
    repo_candidate_key(project_root, left).cmp(&repo_candidate_key(project_root, right))
}

fn repo_candidate_key(project_root: &Path, candidate: &Path) -> (usize, usize, String) {
    let relative = candidate.strip_prefix(project_root).unwrap_or(candidate);
    (
        relative.components().count(),
        candidate.as_os_str().len(),
        candidate.display().to_string(),
    )
}

fn discover_nested_repo_roots(project_root: &Path) -> Result<Vec<PathBuf>, String> {
    const MAX_DEPTH: usize = 3;

    let mut stack = vec![(project_root.to_path_buf(), 0usize)];
    let mut roots = Vec::new();

    while let Some((dir, depth)) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!("read project dir {}: {}", dir.display(), error));
            }
        };

        for entry in entries {
            let entry =
                entry.map_err(|error| format!("read project dir {}: {}", dir.display(), error))?;
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };

            let name = entry.file_name();
            let name = name.to_string_lossy();

            if name == ".git" {
                if file_type.is_dir() || file_type.is_file() || file_type.is_symlink() {
                    roots.push(dir.clone());
                }
                continue;
            }

            if !file_type.is_dir() {
                continue;
            }

            if matches!(name.as_ref(), ".sparky" | ".cc-bridge" | "node_modules") {
                continue;
            }

            if depth < MAX_DEPTH {
                stack.push((path, depth + 1));
            }
        }
    }

    roots.sort();
    roots.dedup();
    Ok(roots)
}

fn unavailable_status(project_root: &Path) -> GitStatusSummary {
    GitStatusSummary {
        available: false,
        root: project_root.display().to_string(),
        branch: String::new(),
        message: Some("当前目录还不是 Git 仓库".to_string()),
        upstream: None,
        ahead: 0,
        behind: 0,
        has_changes: false,
        changes: Vec::new(),
        staged_count: 0,
        unstaged_count: 0,
        untracked_count: 0,
        last_commit: None,
    }
}

fn is_not_git_repository_error(error: &str) -> bool {
    let text = error.to_ascii_lowercase();
    text.contains("not a git repository") || text.contains("git repository not found")
}

fn git_last_commit(project_root: &Path, runtime: &GitRuntimeContext) -> Option<GitCommitSummary> {
    let output = git_output(
        project_root,
        runtime,
        ["log", "-1", "--pretty=format:%H%n%s%n%an%n%cr"],
    )
    .ok()?;

    let text = output_text(&output);
    let mut lines = text.lines();
    Some(GitCommitSummary {
        id: lines.next()?.trim().to_string(),
        subject: lines.next()?.trim().to_string(),
        author: lines.next()?.trim().to_string(),
        relative_time: lines.next()?.trim().to_string(),
    })
}

fn current_branch(project_root: &Path, runtime: &GitRuntimeContext) -> Result<String, String> {
    let output = git_output(project_root, runtime, ["branch", "--show-current"])?;
    let branch = output_text(&output).trim().to_string();
    if branch.is_empty() {
        Err("当前仓库处于 detached HEAD，无法自动推断要同步的分支".to_string())
    } else {
        Ok(branch)
    }
}

fn local_branch_exists(
    project_root: &Path,
    runtime: &GitRuntimeContext,
    branch: &str,
) -> Result<bool, String> {
    ref_exists(
        project_root,
        runtime,
        format!("refs/heads/{}", branch).as_str(),
    )
}

fn remote_branch_exists(
    project_root: &Path,
    runtime: &GitRuntimeContext,
    remote: &str,
    branch: &str,
) -> Result<bool, String> {
    ref_exists(
        project_root,
        runtime,
        format!("refs/remotes/{}/{}", remote, branch).as_str(),
    )
}

fn remote_default_branch(
    project_root: &Path,
    runtime: &GitRuntimeContext,
    remote: &str,
) -> Result<Option<String>, String> {
    if remote_branch_exists(project_root, runtime, remote, "main")? {
        return Ok(Some("main".to_string()));
    }

    let output = Command::new("git")
        .args([
            "-c",
            "safe.directory=*",
            "symbolic-ref",
            &format!("refs/remotes/{}/HEAD", remote),
        ])
        .current_dir(project_root)
        .env("HOME", &runtime.home_dir)
        .output()
        .map_err(|error| format!("run git: {}", error))?;

    if !output.status.success() {
        return Ok(None);
    }

    let value = output_text(&output).trim().to_string();
    let branch = value.rsplit('/').next().unwrap_or_default().trim();
    if branch.is_empty() {
        Ok(None)
    } else {
        Ok(Some(branch.to_string()))
    }
}

fn has_upstream(project_root: &Path, runtime: &GitRuntimeContext) -> Result<bool, String> {
    let output = Command::new("git")
        .args([
            "-c",
            "safe.directory=*",
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ])
        .current_dir(project_root)
        .env("HOME", &runtime.home_dir)
        .output()
        .map_err(|error| format!("run git: {}", error))?;

    if output.status.success() {
        return Ok(true);
    }

    let text = output_text(&output).to_ascii_lowercase();
    if text.contains("no upstream configured")
        || text.contains("no upstream")
        || text.contains("does not point to a branch")
        || text.contains("unknown revision or path not in the working tree")
    {
        return Ok(false);
    }

    let trimmed = output_text(&output).trim().to_string();
    if trimmed.is_empty() {
        Err(format!("git command failed with status {}", output.status))
    } else {
        Err(trimmed)
    }
}

fn ref_exists(
    project_root: &Path,
    runtime: &GitRuntimeContext,
    reference: &str,
) -> Result<bool, String> {
    let output = Command::new("git")
        .args([
            "-c",
            "safe.directory=*",
            "show-ref",
            "--verify",
            "--quiet",
            reference,
        ])
        .current_dir(project_root)
        .env("HOME", &runtime.home_dir)
        .output()
        .map_err(|error| format!("run git: {}", error))?;

    if output.status.success() {
        return Ok(true);
    }

    if output.status.code() == Some(1) {
        return Ok(false);
    }

    let trimmed = output_text(&output).trim().to_string();
    if trimmed.is_empty() {
        Err(format!("git command failed with status {}", output.status))
    } else {
        Err(trimmed)
    }
}

fn default_remote(project_root: &Path, runtime: &GitRuntimeContext) -> Result<String, String> {
    let output = git_output(project_root, runtime, ["remote"])?;
    let mut remotes = output_text(&output)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();

    remotes.sort();
    remotes.dedup();

    if remotes.iter().any(|remote| remote == "origin") {
        return Ok("origin".to_string());
    }

    match remotes.len() {
        0 => Err("当前仓库没有配置远端仓库".to_string()),
        1 => Ok(remotes.remove(0)),
        _ => Err(
            "当前分支未配置 upstream，且仓库存在多个 remote，请先在终端中明确设置跟踪分支"
                .to_string(),
        ),
    }
}

fn git_output<I, S>(
    project_root: &Path,
    runtime: &GitRuntimeContext,
    args: I,
) -> Result<std::process::Output, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    git_output_with_env(
        project_root,
        runtime,
        args,
        std::iter::empty::<(&str, &str)>(),
    )
}

fn git_output_with_env<I, S, E, K, V>(
    project_root: &Path,
    runtime: &GitRuntimeContext,
    args: I,
    envs: E,
) -> Result<std::process::Output, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
    E: IntoIterator<Item = (K, V)>,
    K: AsRef<std::ffi::OsStr>,
    V: AsRef<std::ffi::OsStr>,
{
    let mut command = Command::new("git");
    command
        .args(["-c", "safe.directory=*"])
        .current_dir(project_root)
        .args(args);

    command.env("HOME", &runtime.home_dir);
    command.env(
        "GIT_SSH_COMMAND",
        "ssh -o GlobalKnownHostsFile=/etc/sparky/known_hosts -o UserKnownHostsFile=$HOME/.ssh/known_hosts -o StrictHostKeyChecking=accept-new",
    );
    if let Some(ssh_auth_sock) = runtime.ssh_auth_sock.as_deref() {
        command.env("SSH_AUTH_SOCK", ssh_auth_sock);
    }

    for (key, value) in envs {
        command.env(key, value);
    }

    let output = command
        .output()
        .map_err(|error| format!("run git: {}", error))?;

    if output.status.success() {
        return Ok(output);
    }

    let message = output_text(&output);
    let trimmed = message.trim();
    if trimmed.is_empty() {
        Err(format!("git command failed with status {}", output.status))
    } else {
        Err(trimmed.to_string())
    }
}

fn output_text(output: &std::process::Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    format!("{}{}", stdout, stderr)
}

fn parse_branch_header(header: &str) -> (String, Option<String>, u32, u32) {
    let mut upstream = None;
    let mut ahead = 0u32;
    let mut behind = 0u32;

    let text = header.trim().strip_prefix("## ").unwrap_or(header.trim());

    if let Some(rest) = text.strip_prefix("No commits yet on ") {
        return (rest.trim().to_string(), upstream, ahead, behind);
    }

    if let Some((left, right)) = text.split_once("...") {
        let branch = left.trim().to_string();

        if let Some((remote, counts)) = right.split_once(" [") {
            upstream = Some(remote.trim().to_string());
            parse_ahead_behind(counts.trim_end_matches(']'), &mut ahead, &mut behind);
        } else {
            upstream = Some(right.trim().to_string());
        }

        return (branch, upstream, ahead, behind);
    }

    if let Some((left, counts)) = text.split_once(" [") {
        let branch = left.trim().to_string();
        parse_ahead_behind(counts.trim_end_matches(']'), &mut ahead, &mut behind);
        return (branch, upstream, ahead, behind);
    }

    (text.trim().to_string(), upstream, ahead, behind)
}

fn parse_ahead_behind(text: &str, ahead: &mut u32, behind: &mut u32) {
    for part in text.split(',') {
        let trimmed = part.trim();
        if let Some(value) = trimmed.strip_prefix("ahead ") {
            *ahead = value.trim().parse().unwrap_or(0);
        } else if let Some(value) = trimmed.strip_prefix("behind ") {
            *behind = value.trim().parse().unwrap_or(0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{discover_git_roots, resolve_runtime_worktree, resolve_runtime_worktree_compat};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let path = std::env::temp_dir().join(format!("sparky-git-test-{}", unique));
            fs::create_dir_all(&path).expect("create temp dir");
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn discover_git_roots_includes_git_file_repositories() {
        let temp = TempDir::new();
        let repo = temp.path().join("nested");
        fs::create_dir_all(&repo).expect("create nested repo");
        fs::write(repo.join(".git"), "gitdir: /tmp/mock").expect("write git file");

        let roots = discover_git_roots(temp.path()).expect("discover git roots");

        assert_eq!(roots, vec![repo]);
    }

    #[test]
    fn resolve_runtime_worktree_rejects_ambiguous_nested_repositories() {
        let temp = TempDir::new();
        let repo_a = temp.path().join("repo-a");
        let repo_b = temp.path().join("repo-b");

        fs::create_dir_all(repo_a.join(".git")).expect("create repo-a");
        fs::create_dir_all(repo_b.join(".git")).expect("create repo-b");

        let error =
            resolve_runtime_worktree(temp.path()).expect_err("should reject ambiguous repos");
        assert!(error.contains("多个 Git 仓库"));
    }

    #[test]
    fn resolve_runtime_worktree_compat_prefers_shallowest_repository() {
        let temp = TempDir::new();
        let repo_a = temp.path().join("repo-a");
        let repo_b = temp.path().join("nested").join("repo-b");

        fs::create_dir_all(repo_a.join(".git")).expect("create repo-a");
        fs::create_dir_all(repo_b.join(".git")).expect("create repo-b");

        let root = resolve_runtime_worktree_compat(temp.path(), None)
            .expect("resolve compatible runtime worktree");

        assert_eq!(root, repo_a);
    }

    #[test]
    fn resolve_runtime_worktree_compat_prefers_matching_remote() {
        let temp = TempDir::new();
        let repo_a = temp.path().join("repo-a");
        let repo_b = temp.path().join("repo-b");

        init_git_repo(&repo_a, "https://github.com/example/other.git");
        init_git_repo(&repo_b, "https://github.com/zalsay/ai-finance.git");

        let root = resolve_runtime_worktree_compat(
            temp.path(),
            Some("git@github.com:zalsay/ai-finance.git"),
        )
        .expect("resolve compatible runtime worktree");

        assert_eq!(root, repo_b);
    }

    fn init_git_repo(path: &Path, remote: &str) {
        fs::create_dir_all(path).expect("create repo dir");
        let init_status = Command::new("git")
            .args(["init", "-q"])
            .current_dir(path)
            .status()
            .expect("git init");
        assert!(init_status.success(), "git init failed");

        let remote_status = Command::new("git")
            .args(["remote", "add", "origin", remote])
            .current_dir(path)
            .status()
            .expect("git remote add");
        assert!(remote_status.success(), "git remote add failed");
    }
}
