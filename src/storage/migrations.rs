use rusqlite::{params, Connection};

use crate::storage::db::seed_default_ide_plugins;

pub fn init_db(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            path TEXT NOT NULL,
            hooks_installed INTEGER DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            default_provider_id TEXT
        )",
        [],
    )?;

    let columns: Vec<String> = conn
        .prepare("PRAGMA table_info(projects)")?
        .query_map([], |row| row.get(1))?
        .collect::<Result<Vec<_>, _>>()?;

    if !columns.contains(&"default_provider_id".to_string()) {
        let _ = conn.execute("ALTER TABLE projects ADD COLUMN default_provider_id TEXT", []);
    }

    if !columns.contains(&"hooks_installed".to_string()) {
        let _ = conn.execute("ALTER TABLE projects ADD COLUMN hooks_installed INTEGER DEFAULT 0", []);
    }

    conn.execute(
        "CREATE TABLE IF NOT EXISTS pty_commands (
            id INTEGER PRIMARY KEY,
            project_path TEXT NOT NULL,
            command TEXT NOT NULL,
            message_id TEXT,
            processed INTEGER DEFAULT 0,
            created_at INTEGER
        )",
        [],
    )?;

    let cmd_columns: Vec<String> = conn
        .prepare("PRAGMA table_info(pty_commands)")?
        .query_map([], |row| row.get(1))?
        .collect::<Result<Vec<_>, _>>()?;

    if !cmd_columns.contains(&"message_id".to_string()) {
        let _ = conn.execute("ALTER TABLE pty_commands ADD COLUMN message_id TEXT", []);
    }

    conn.execute(
        "CREATE TABLE IF NOT EXISTS permission_requests (
            id INTEGER PRIMARY KEY,
            project_path TEXT NOT NULL,
            status TEXT NOT NULL,
            choice TEXT,
            created_at INTEGER
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS active_ptys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_path TEXT NOT NULL UNIQUE,
            created_at INTEGER NOT NULL
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS terminal_input_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_path TEXT NOT NULL,
            input TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS terminal_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_path TEXT NOT NULL,
            kind TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS project_recent_urls (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_path TEXT NOT NULL,
            url TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(project_path, url)
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS app_config_feishu (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            app_id TEXT NOT NULL,
            app_secret TEXT NOT NULL,
            encrypt_key TEXT,
            verification_token TEXT,
            chat_id TEXT,
            project_path TEXT,
            open_id TEXT,
            hook_events_filter TEXT,
            app_name TEXT,
            anthropic_logo_img_key TEXT,
            terminal_bg_color TEXT,
            terminal_fg_color TEXT,
            terminal_font_size INTEGER,
            updated_at INTEGER NOT NULL,
            default_provider_id TEXT
        )",
        [],
    )?;

    let mut needs_rebuild = false;
    if let Ok(mut stmt) = conn.prepare("PRAGMA table_info(ai_providers)") {
        let _ = stmt
            .query_map([], |row| {
                let name: String = row.get(1)?;
                let type_str: String = row.get(2)?;
                if name == "id" && type_str.to_uppercase().contains("INT") {
                    needs_rebuild = true;
                }
                Ok(())
            })
            .and_then(|mapped| {
                for _ in mapped {}
                Ok(())
            });
    }

    if needs_rebuild {
        let _ = conn.execute("ALTER TABLE ai_providers RENAME TO ai_providers_old_v1", []);
    }

    conn.execute(
        "CREATE TABLE IF NOT EXISTS ai_providers (
            id TEXT NOT NULL,
            app_type TEXT NOT NULL,
            name TEXT NOT NULL,
            settings_config TEXT NOT NULL,
            website_url TEXT,
            category TEXT,
            created_at INTEGER,
            sort_index INTEGER,
            notes TEXT,
            icon TEXT,
            icon_color TEXT,
            meta TEXT NOT NULL DEFAULT '{}',
            is_current BOOLEAN NOT NULL DEFAULT 0,
            in_failover_queue BOOLEAN NOT NULL DEFAULT 0,
            cost_multiplier TEXT NOT NULL DEFAULT '1.0',
            limit_daily_usd TEXT,
            limit_monthly_usd TEXT,
            provider_type TEXT,
            PRIMARY KEY (id, app_type)
        )",
        [],
    )?;

    let _ = conn.execute("ALTER TABLE ai_providers ADD COLUMN app_type TEXT", []);
    let _ = conn.execute("ALTER TABLE ai_providers ADD COLUMN settings_config TEXT", []);
    let _ = conn.execute("ALTER TABLE ai_providers ADD COLUMN website_url TEXT", []);
    let _ = conn.execute("ALTER TABLE ai_providers ADD COLUMN category TEXT", []);
    let _ = conn.execute("ALTER TABLE ai_providers ADD COLUMN created_at INTEGER", []);
    let _ = conn.execute("ALTER TABLE ai_providers ADD COLUMN sort_index INTEGER", []);
    let _ = conn.execute("ALTER TABLE ai_providers ADD COLUMN notes TEXT", []);
    let _ = conn.execute("ALTER TABLE ai_providers ADD COLUMN icon TEXT", []);
    let _ = conn.execute("ALTER TABLE ai_providers ADD COLUMN icon_color TEXT", []);
    let _ = conn.execute("ALTER TABLE ai_providers ADD COLUMN meta TEXT NOT NULL DEFAULT '{}'", []);
    let _ = conn.execute("ALTER TABLE ai_providers ADD COLUMN is_current BOOLEAN NOT NULL DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE ai_providers ADD COLUMN in_failover_queue BOOLEAN NOT NULL DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE ai_providers ADD COLUMN cost_multiplier TEXT NOT NULL DEFAULT '1.0'", []);
    let _ = conn.execute("ALTER TABLE ai_providers ADD COLUMN limit_daily_usd TEXT", []);
    let _ = conn.execute("ALTER TABLE ai_providers ADD COLUMN limit_monthly_usd TEXT", []);
    let _ = conn.execute("ALTER TABLE ai_providers ADD COLUMN provider_type TEXT", []);

    let _ = conn.execute("ALTER TABLE app_config_feishu ADD COLUMN default_provider_id TEXT", []);
    let _ = conn.execute("ALTER TABLE app_config_feishu ADD COLUMN app_name TEXT", []);
    let _ = conn.execute("ALTER TABLE app_config_feishu ADD COLUMN open_id TEXT", []);
    let _ = conn.execute("ALTER TABLE app_config_feishu ADD COLUMN hook_events_filter TEXT", []);
    let _ = conn.execute("ALTER TABLE app_config_feishu ADD COLUMN anthropic_logo_img_key TEXT", []);
    let _ = conn.execute("ALTER TABLE app_config_feishu ADD COLUMN terminal_bg_color TEXT", []);
    let _ = conn.execute("ALTER TABLE app_config_feishu ADD COLUMN terminal_fg_color TEXT", []);
    let _ = conn.execute("ALTER TABLE app_config_feishu ADD COLUMN terminal_font_size INTEGER", []);

    conn.execute(
        "CREATE TABLE IF NOT EXISTS provider_endpoints (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            provider_id TEXT NOT NULL,
            app_type TEXT NOT NULL,
            url TEXT NOT NULL,
            added_at INTEGER,
            FOREIGN KEY (provider_id, app_type) REFERENCES ai_providers(id, app_type) ON DELETE CASCADE
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS app_config_dingtalk (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            app_id TEXT NOT NULL,
            app_secret TEXT NOT NULL,
            encrypt_key TEXT,
            verification_token TEXT,
            chat_id TEXT,
            project_path TEXT,
            updated_at INTEGER NOT NULL
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS app_config_wework (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            app_id TEXT NOT NULL,
            app_secret TEXT NOT NULL,
            encrypt_key TEXT,
            verification_token TEXT,
            chat_id TEXT,
            project_path TEXT,
            updated_at INTEGER NOT NULL
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS db_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL UNIQUE,
            project_path TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            ended_at INTEGER,
            reason TEXT,
            name TEXT,
            project_name TEXT
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS ide_plugins (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            desc TEXT NOT NULL DEFAULT '',
            created_at INTEGER
        )",
        [],
    )?;

    seed_default_ide_plugins(conn)?;
    Ok(())
}
