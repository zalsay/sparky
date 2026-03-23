use std::{fs, path::PathBuf};

use rusqlite::{params, Connection};

use crate::storage::models;

pub fn default_db_path() -> PathBuf {
    let base_dir = dirs::home_dir()
        .expect("Failed to get home directory")
        .join("sparky");
    fs::create_dir_all(&base_dir).expect("Failed to create base directory");
    base_dir.join("hooks.db")
}

pub fn open_db() -> Result<Connection, String> {
    let conn = Connection::open(default_db_path()).map_err(|e| e.to_string())?;
    crate::storage::migrations::init_db(&conn).map_err(|e| e.to_string())?;
    models::post_open_db_migrations(&conn)?;
    Ok(conn)
}

pub fn seed_default_ide_plugins(conn: &Connection) -> rusqlite::Result<()> {
    let ide_plugins_count: i64 = conn.query_row("SELECT COUNT(*) FROM ide_plugins", [], |row| row.get(0))?;
    if ide_plugins_count == 0 {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        let defaults = [(
            "detachhead.basedpyright",
            "Basedpyright",
            "A better, faster Pyright language server for Python",
        )];
        for (id, name, desc) in defaults {
            conn.execute(
                "INSERT INTO ide_plugins (id, name, desc, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![id, name, desc, now],
            )?;
        }
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    conn.execute(
        "INSERT INTO ide_plugins (id, name, desc, created_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO NOTHING",
        params![
            "detachhead.basedpyright",
            "Basedpyright",
            "A better, faster Pyright language server for Python",
            now,
        ],
    )?;

    Ok(())
}
