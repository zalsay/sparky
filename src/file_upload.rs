use crate::editor::resolve_requested_path;
use actix_multipart::Multipart;
use futures_util::StreamExt;
use std::path::{Component, Path, PathBuf};
use tokio::io::AsyncWriteExt;

pub async fn save_multipart_upload(root: &Path, mut multipart: Multipart) -> Result<usize, String> {
    let mut count = 0usize;

    while let Some(field_result) = multipart.next().await {
        let mut field = field_result.map_err(|error| format!("read upload field: {}", error))?;
        let Some(filename) = field
            .content_disposition()
            .and_then(|disposition| disposition.get_filename())
        else {
            continue;
        };

        let relative_path = normalize_upload_path(filename)?;
        let target_path = resolve_requested_path(root, Some(relative_path.as_str()))?;
        if let Some(parent) = target_path.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|error| {
                format!("create upload directory {}: {}", parent.display(), error)
            })?;
        }

        let mut file = tokio::fs::File::create(&target_path)
            .await
            .map_err(|error| format!("create upload file {}: {}", target_path.display(), error))?;
        while let Some(chunk_result) = field.next().await {
            let chunk = chunk_result.map_err(|error| format!("read upload chunk: {}", error))?;
            file.write_all(&chunk).await.map_err(|error| {
                format!("write upload file {}: {}", target_path.display(), error)
            })?;
        }

        count += 1;
    }

    if count == 0 {
        return Err("请选择要上传的文件".to_string());
    }

    Ok(count)
}

pub async fn delete_existing_file(root: &Path, path: &str) -> Result<(), String> {
    let file_path = resolve_existing_file_path(root, path)?;

    if !file_path.exists() {
        return Err(file_not_found_message(root, &file_path));
    }

    if file_path.is_dir() {
        return Err("请选择文件而不是目录".to_string());
    }

    tokio::fs::remove_file(&file_path)
        .await
        .map_err(|error| format!("delete file {}: {}", file_path.display(), error))
}

pub fn resolve_existing_file_path(root: &Path, path: &str) -> Result<PathBuf, String> {
    let primary_path = resolve_requested_path(root, Some(path))?;
    if primary_path.exists() {
        return Ok(primary_path);
    }

    if path.contains(' ') {
        let plus_path = path.replace(' ', "+");
        let fallback_path = resolve_requested_path(root, Some(plus_path.as_str()))?;
        if fallback_path.exists() {
            return Ok(fallback_path);
        }
    }

    Ok(primary_path)
}

pub fn file_not_found_message(root: &Path, path: &Path) -> String {
    let relative = path.strip_prefix(root).unwrap_or(path);
    format!("文件不存在: {}", relative.display())
}

fn normalize_upload_path(input: &str) -> Result<String, String> {
    let normalized = input.replace('\\', "/");
    let trimmed = normalized.trim().trim_start_matches('/');
    if trimmed.is_empty() {
        return Err("上传文件名不能为空".to_string());
    }

    let mut clean = PathBuf::new();
    for component in Path::new(trimmed).components() {
        match component {
            Component::Normal(part) => clean.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("上传路径必须位于当前项目目录内".to_string());
            }
        }
    }

    if clean.as_os_str().is_empty() {
        return Err("上传文件名不能为空".to_string());
    }

    Ok(clean.to_string_lossy().replace('\\', "/"))
}
