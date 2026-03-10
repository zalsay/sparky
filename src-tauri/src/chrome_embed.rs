#[cfg(target_os = "macos")]
use std::process::Command;
use tauri::Manager;

#[cfg(target_os = "macos")]
#[tauri::command(rename_all = "snake_case")]
pub fn launch_chrome_with_tabs(urls: Vec<String>) -> Result<(), String> {
    if urls.is_empty() {
        return Err("urls is empty".to_string());
    }

    // 使用 osascript 确保创建新的独立窗口
    let script = format!(
        r#"
tell application "Google Chrome"
    activate
    set newWindow to make new window
    set URL of active tab of newWindow to "{}"
    {}
end tell
"#,
        urls[0],
        urls.iter().skip(1).map(|url| format!("make new tab at end of tabs of newWindow with properties {{URL:\"{}\"}}", url)).collect::<Vec<_>>().join("\n    ")
    );

    let output = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&output.stderr).to_string();
        Err(err)
    }
}

#[cfg(target_os = "macos")]
#[tauri::command(rename_all = "snake_case")]
pub fn set_chrome_bounds(x: i32, y: i32, width: i32, height: i32) -> Result<(), String> {
    if width <= 0 || height <= 0 {
        return Err("invalid bounds".to_string());
    }

    let right = x + width;
    let bottom = y + height;

    let script = format!(
        "tell application \"Google Chrome\"\n  if (count of windows) = 0 then return\n  set bounds of front window to {{{},{},{},{}}}\nend tell\n",
        x, y, right, bottom
    );

    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&output.stderr).to_string();
        Err(err)
    }
}

#[cfg(target_os = "macos")]
#[tauri::command(rename_all = "snake_case")]
pub fn embed_chrome_window(app: tauri::AppHandle, x: i32, y: i32, width: i32, height: i32) -> Result<(), String> {
    if width <= 0 || height <= 0 {
        return Err("invalid bounds".to_string());
    }

    // 使用 AppleScript 获取 Chrome 窗口并设置位置
    let script = format!(
        r#"
tell application "Google Chrome"
    if (count of windows) = 0 then return
    set chromeWindow to front window
    set bounds of chromeWindow to {{{}, {}, {}, {}}}
    set windowTitle to name of chromeWindow
    return windowTitle
end tell
"#,
        x, y, x + width, y + height
    );

    let output = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(err);
    }

    // 获取主窗口
    let main_window = app.get_webview_window("main")
        .ok_or("Main window not found")?;
    
    // 设置 Chrome 窗口为工具窗口风格，使其看起来像嵌入的
    let style_script = r#"
tell application "System Events"
    tell process "Google Chrome"
        set front window's visible to true
    end tell
end tell
"#;
    
    Command::new("osascript")
        .arg("-e")
        .arg(style_script)
        .output()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg(target_os = "macos")]
#[tauri::command(rename_all = "snake_case")]
pub fn unembed_chrome_window() -> Result<(), String> {
    // 恢复 Chrome 窗口为普通窗口
    Ok(())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command(rename_all = "snake_case")]
pub fn launch_chrome_with_tabs(_urls: Vec<String>) -> Result<(), String> {
    Err("launch_chrome_with_tabs is only supported on macOS".to_string())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command(rename_all = "snake_case")]
pub fn set_chrome_bounds(_x: i32, _y: i32, _width: i32, _height: i32) -> Result<(), String> {
    Err("set_chrome_bounds is only supported on macOS".to_string())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command(rename_all = "snake_case")]
pub fn embed_chrome_window(_app: tauri::AppHandle, _x: i32, _y: i32, _width: i32, _height: i32) -> Result<(), String> {
    Err("embed_chrome_window is only supported on macOS".to_string())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command(rename_all = "snake_case")]
pub fn unembed_chrome_window() -> Result<(), String> {
    Err("unembed_chrome_window is only supported on macOS".to_string())
}
