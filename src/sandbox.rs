//! Bwrap sandbox management with overlayfs.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Per-session overlay mount point paths.
#[derive(Debug)]
pub struct OverlayPaths {
    /// overlayfs work dir (must be on same filesystem as upper)
    pub work: PathBuf,
    /// overlayfs upper dir (writable layer)
    pub upper: PathBuf,
    /// overlayfs merged mount point (where filesystem appears)
    pub merged: PathBuf,
}

impl OverlayPaths {
    /// Create directory structure under sandbox_root/sessions/{session_id}/.
    pub fn new(sandbox_root: &Path, session_id: &str) -> Self {
        let base = sandbox_root.join("sessions").join(session_id);
        Self {
            work: base.join("overlay_work"),
            upper: base.join("overlay_upper"),
            merged: base.join("overlay_merged"),
        }
    }

    /// Create all required directories for the overlay.
    pub fn create(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.work)?;
        std::fs::create_dir_all(&self.upper)?;
        std::fs::create_dir_all(&self.merged)?;
        Ok(())
    }

    /// Remove the overlay directory tree.
    pub fn cleanup(&self) {
        // Try to unmount first (best effort).
        let _ = Command::new("umount")
            .arg(self.merged.as_os_str())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();

        let _ = std::fs::remove_dir_all(self.merged.parent().unwrap_or(&self.merged));
    }
}

/// Attempt to mount an overlayfs.
/// Requires CAP_SYS_ADMIN (i.e. must run as root or with suitable capabilities).
pub fn mount_overlay(lower: &str, upper: &Path, work: &Path, merged: &Path) -> Result<(), String> {
    let opts = format!(
        "lowerdir={},upperdir={},workdir={}",
        lower,
        upper.to_string_lossy(),
        work.to_string_lossy()
    );
    let status = Command::new("mount")
        .args([
            "-t",
            "overlay",
            "-o",
            &opts,
            "overlay",
            &merged.to_string_lossy(),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| format!("failed to run mount: {}", e))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("mount overlay exited with {}", status))
    }
}

/// Unmount an overlayfs path.
pub fn unmount_overlay(merged: &Path) -> Result<(), String> {
    let status = Command::new("umount")
        .arg(merged.as_os_str())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| format!("umount failed: {}", e))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("umount {} failed", merged.display()))
    }
}
