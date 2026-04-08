use crate::config::ServerConfig;
use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use parking_lot::Mutex;
use serde::Serialize;
use sqlx::{PgPool, Row};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize)]
pub struct AuthUser {
    pub user_id: String,
    pub username: String,
}

#[derive(Clone, Debug)]
pub struct AuthSession {
    pub token: String,
    pub user_id: String,
    pub username: String,
    pub home_dir: PathBuf,
}

#[derive(Clone, Debug)]
struct StoredUser {
    user_id: String,
    username: String,
    password_hash: Option<String>,
}

#[derive(Default)]
struct MemoryStore {
    users: HashMap<String, StoredUser>,
    sessions: HashMap<String, AuthSession>,
}

enum AuthBackend {
    Memory(Mutex<MemoryStore>),
    Postgres(PgPool),
}

#[derive(Debug)]
pub enum AuthError {
    BadRequest(String),
    Unauthorized(String),
    Conflict(String),
    Internal(String),
}

impl AuthError {
    pub fn message(&self) -> &str {
        match self {
            Self::BadRequest(msg)
            | Self::Unauthorized(msg)
            | Self::Conflict(msg)
            | Self::Internal(msg) => msg,
        }
    }
}

pub struct UserStore {
    backend: AuthBackend,
    cfg: ServerConfig,
}

impl UserStore {
    pub async fn new(cfg: ServerConfig) -> Result<Self, String> {
        if let Some(database_url) = cfg.database_url.clone() {
            let pool = sqlx::postgres::PgPoolOptions::new()
                .max_connections(cfg.db_max_connections)
                .connect(&database_url)
                .await
                .map_err(|e| format!("connect postgres: {}", e))?;

            init_schema(&pool).await?;

            return Ok(Self {
                backend: AuthBackend::Postgres(pool),
                cfg,
            });
        }

        Ok(Self {
            backend: AuthBackend::Memory(Mutex::new(MemoryStore::default())),
            cfg,
        })
    }

    pub async fn register(&self, username: &str, password: &str) -> Result<AuthSession, AuthError> {
        let username = normalize_username(username)?;
        validate_new_password(password)?;
        let password_hash = hash_password(password).map_err(AuthError::Internal)?;

        let user = match &self.backend {
            AuthBackend::Memory(store) => {
                let mut store = store.lock();
                match store.users.get_mut(&username) {
                    Some(existing) => {
                        if existing.password_hash.is_some() {
                            return Err(AuthError::Conflict("username already exists".to_string()));
                        }

                        existing.password_hash = Some(password_hash);
                        existing.clone()
                    }
                    None => {
                        let user = StoredUser {
                            user_id: sanitize_user_id(&username),
                            username: username.clone(),
                            password_hash: Some(password_hash),
                        };
                        store.users.insert(username.clone(), user.clone());
                        user
                    }
                }
            }
            AuthBackend::Postgres(pool) => register_user(pool, &username, &password_hash).await?,
        };

        self.issue_session(&user.user_id, &user.username).await
    }

    pub async fn login(&self, username: &str, password: &str) -> Result<AuthSession, AuthError> {
        let username = normalize_username(username)?;
        validate_login_password(password)?;

        let user = match &self.backend {
            AuthBackend::Memory(store) => {
                let store = store.lock();
                let Some(user) = store.users.get(&username).cloned() else {
                    return Err(AuthError::Unauthorized(
                        "invalid username or password".to_string(),
                    ));
                };

                match &user.password_hash {
                    Some(password_hash) => verify_password(password, password_hash)?,
                    None => {
                        return Err(AuthError::BadRequest(
                            "account has no password yet; use register to set one".to_string(),
                        ))
                    }
                }

                user
            }
            AuthBackend::Postgres(pool) => authenticate_user(pool, &username, password).await?,
        };

        self.issue_session(&user.user_id, &user.username).await
    }

    pub async fn get(&self, token: &str) -> Option<AuthSession> {
        match &self.backend {
            AuthBackend::Memory(store) => {
                let session = store.lock().sessions.get(token).cloned()?;
                if let Err(error) = ensure_user_home(&session.home_dir, &self.cfg) {
                    log::warn!(
                        "failed to ensure user home for '{}' from memory session: {}",
                        session.user_id,
                        error
                    );
                    return None;
                }
                Some(session)
            }
            AuthBackend::Postgres(pool) => {
                let row = sqlx::query(
                    r#"
                    SELECT s.token, u.id AS user_id, u.username
                    FROM bridge_user_sessions s
                    JOIN bridge_users u ON u.id = s.user_id
                    WHERE s.token = $1
                    "#,
                )
                .bind(token)
                .fetch_optional(pool)
                .await
                .ok()
                .flatten()?;

                let _ = sqlx::query(
                    "UPDATE bridge_user_sessions SET last_seen_at = NOW() WHERE token = $1",
                )
                .bind(token)
                .execute(pool)
                .await;

                let user_id: String = row.try_get("user_id").ok()?;
                let username: String = row.try_get("username").ok()?;

                let session = AuthSession {
                    token: token.to_string(),
                    user_id: user_id.clone(),
                    username,
                    home_dir: self
                        .cfg
                        .sandbox_root
                        .join("users")
                        .join(user_id)
                        .join("home"),
                };

                if let Err(error) = ensure_user_home(&session.home_dir, &self.cfg) {
                    log::warn!(
                        "failed to ensure user home for '{}' from postgres session: {}",
                        session.user_id,
                        error
                    );
                    return None;
                }

                Some(session)
            }
        }
    }

    pub async fn logout(&self, token: &str) -> Result<bool, String> {
        match &self.backend {
            AuthBackend::Memory(store) => Ok(store.lock().sessions.remove(token).is_some()),
            AuthBackend::Postgres(pool) => {
                let result = sqlx::query("DELETE FROM bridge_user_sessions WHERE token = $1")
                    .bind(token)
                    .execute(pool)
                    .await
                    .map_err(|e| format!("delete bridge session: {}", e))?;

                Ok(result.rows_affected() > 0)
            }
        }
    }

    pub fn backend_name(&self) -> &'static str {
        match &self.backend {
            AuthBackend::Memory(_) => "memory",
            AuthBackend::Postgres(_) => "postgres",
        }
    }

    pub fn postgres_pool(&self) -> Option<PgPool> {
        match &self.backend {
            AuthBackend::Postgres(pool) => Some(pool.clone()),
            AuthBackend::Memory(_) => None,
        }
    }

    async fn issue_session(&self, user_id: &str, username: &str) -> Result<AuthSession, AuthError> {
        let home_dir = self
            .cfg
            .sandbox_root
            .join("users")
            .join(user_id)
            .join("home");
        ensure_user_home(&home_dir, &self.cfg).map_err(AuthError::Internal)?;

        let session = AuthSession {
            token: Uuid::new_v4().to_string(),
            user_id: user_id.to_string(),
            username: username.to_string(),
            home_dir,
        };

        match &self.backend {
            AuthBackend::Memory(store) => {
                store
                    .lock()
                    .sessions
                    .insert(session.token.clone(), session.clone());
            }
            AuthBackend::Postgres(pool) => {
                sqlx::query(
                    r#"
                    INSERT INTO bridge_user_sessions (token, user_id, username, created_at, last_seen_at)
                    VALUES ($1, $2, $3, NOW(), NOW())
                    "#,
                )
                .bind(&session.token)
                .bind(&session.user_id)
                .bind(&session.username)
                .execute(pool)
                .await
                .map_err(|e| AuthError::Internal(format!("insert bridge session: {}", e)))?;
            }
        }

        Ok(session)
    }
}

async fn init_schema(pool: &PgPool) -> Result<(), String> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS bridge_users (
            id VARCHAR(64) PRIMARY KEY,
            username VARCHAR(255) UNIQUE NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        "#,
    )
    .execute(pool)
    .await
    .map_err(|e| format!("create bridge_users: {}", e))?;

    sqlx::query("ALTER TABLE bridge_users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255)")
        .execute(pool)
        .await
        .map_err(|e| format!("alter bridge_users.password_hash: {}", e))?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS bridge_user_sessions (
            token VARCHAR(64) PRIMARY KEY,
            user_id VARCHAR(64) NOT NULL REFERENCES bridge_users(id) ON DELETE CASCADE,
            username VARCHAR(255) NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        "#,
    )
    .execute(pool)
    .await
    .map_err(|e| format!("create bridge_user_sessions: {}", e))?;

    Ok(())
}

async fn register_user(
    pool: &PgPool,
    username: &str,
    password_hash: &str,
) -> Result<StoredUser, AuthError> {
    let existing =
        sqlx::query("SELECT id, username, password_hash FROM bridge_users WHERE username = $1")
            .bind(username)
            .fetch_optional(pool)
            .await
            .map_err(|e| AuthError::Internal(format!("select bridge user: {}", e)))?;

    if let Some(row) = existing {
        let existing_hash: Option<String> = row
            .try_get("password_hash")
            .map_err(|e| AuthError::Internal(format!("read bridge user password_hash: {}", e)))?;
        if existing_hash.is_some() {
            return Err(AuthError::Conflict("username already exists".to_string()));
        }

        let row = sqlx::query(
            r#"
            UPDATE bridge_users
            SET password_hash = $2, updated_at = NOW()
            WHERE username = $1
            RETURNING id, username, password_hash
            "#,
        )
        .bind(username)
        .bind(password_hash)
        .fetch_one(pool)
        .await
        .map_err(|e| AuthError::Internal(format!("activate bridge user password: {}", e)))?;

        return stored_user_from_row(&row);
    }

    let row = sqlx::query(
        r#"
        INSERT INTO bridge_users (id, username, password_hash, created_at, updated_at)
        VALUES ($1, $2, $3, NOW(), NOW())
        RETURNING id, username, password_hash
        "#,
    )
    .bind(sanitize_user_id(username))
    .bind(username)
    .bind(password_hash)
    .fetch_one(pool)
    .await
    .map_err(|e| AuthError::Internal(format!("insert bridge user: {}", e)))?;

    stored_user_from_row(&row)
}

async fn authenticate_user(
    pool: &PgPool,
    username: &str,
    password: &str,
) -> Result<StoredUser, AuthError> {
    let row =
        sqlx::query("SELECT id, username, password_hash FROM bridge_users WHERE username = $1")
            .bind(username)
            .fetch_optional(pool)
            .await
            .map_err(|e| AuthError::Internal(format!("select bridge user: {}", e)))?;

    let Some(row) = row else {
        return Err(AuthError::Unauthorized(
            "invalid username or password".to_string(),
        ));
    };

    let user = stored_user_from_row(&row)?;
    let Some(password_hash) = &user.password_hash else {
        return Err(AuthError::BadRequest(
            "account has no password yet; use register to set one".to_string(),
        ));
    };

    verify_password(password, password_hash)?;

    Ok(user)
}

fn stored_user_from_row(row: &sqlx::postgres::PgRow) -> Result<StoredUser, AuthError> {
    let user_id: String = row
        .try_get("id")
        .map_err(|e| AuthError::Internal(format!("read bridge user id: {}", e)))?;
    let username: String = row
        .try_get("username")
        .map_err(|e| AuthError::Internal(format!("read bridge username: {}", e)))?;
    let password_hash: Option<String> = row
        .try_get("password_hash")
        .map_err(|e| AuthError::Internal(format!("read bridge user password_hash: {}", e)))?;

    Ok(StoredUser {
        user_id,
        username,
        password_hash,
    })
}

fn normalize_username(username: &str) -> Result<String, AuthError> {
    let username = username.trim();
    if username.is_empty() {
        return Err(AuthError::BadRequest("username is required".to_string()));
    }
    if username.len() > 255 {
        return Err(AuthError::BadRequest("username is too long".to_string()));
    }
    Ok(username.to_string())
}

fn validate_new_password(password: &str) -> Result<(), AuthError> {
    if password.len() < 8 {
        return Err(AuthError::BadRequest(
            "password must be at least 8 characters".to_string(),
        ));
    }
    Ok(())
}

fn validate_login_password(password: &str) -> Result<(), AuthError> {
    if password.is_empty() {
        return Err(AuthError::BadRequest("password is required".to_string()));
    }
    Ok(())
}

fn hash_password(password: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|e| format!("hash password: {}", e))
}

fn verify_password(password: &str, password_hash: &str) -> Result<(), AuthError> {
    let parsed_hash = PasswordHash::new(password_hash)
        .map_err(|e| AuthError::Internal(format!("parse password hash: {}", e)))?;

    Argon2::default()
        .verify_password(password.as_bytes(), &parsed_hash)
        .map_err(|_| AuthError::Unauthorized("invalid username or password".to_string()))
}

fn sanitize_user_id(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut last_dash = false;

    for ch in input.chars() {
        let normalized = match ch {
            'a'..='z' | '0'..='9' => Some(ch),
            'A'..='Z' => Some(ch.to_ascii_lowercase()),
            '_' | '-' | '.' => Some(ch),
            _ => Some('-'),
        };

        if let Some(ch) = normalized {
            if ch == '-' {
                if last_dash || result.is_empty() {
                    continue;
                }
                last_dash = true;
            } else {
                last_dash = false;
            }
            result.push(ch);
        }
    }

    let mut trimmed = result.trim_matches(['-', '.']).to_string();
    if trimmed.len() > 64 {
        trimmed.truncate(64);
        trimmed = trimmed.trim_matches(['-', '.']).to_string();
    }

    if trimmed.is_empty() {
        format!("user-{}", &Uuid::new_v4().to_string()[..8])
    } else {
        trimmed
    }
}

fn ensure_user_home(home_dir: &Path, cfg: &ServerConfig) -> Result<(), String> {
    fs::create_dir_all(home_dir.join(".claude")).map_err(|e| format!("create home dir: {}", e))?;
    fs::create_dir_all(home_dir.join(".ssh")).map_err(|e| format!("create ssh dir: {}", e))?;

    seed_file_if_missing(
        &cfg.claude_user_state_template,
        &home_dir.join(".claude.json"),
    )?;
    seed_file_if_missing(
        &cfg.claude_settings_template,
        &home_dir.join(".claude").join("settings.json"),
    )?;

    if let Some(template) = cfg.ssh_known_hosts_template.as_deref() {
        sync_file_if_exists(template, &home_dir.join(".ssh").join("known_hosts"))?;
    }

    Ok(())
}

fn seed_file_if_missing(template: &Path, target: &Path) -> Result<(), String> {
    if target.exists() {
        return Ok(());
    }

    if !template.exists() {
        return Err(format!("template missing: {}", template.display()));
    }

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create target dir: {}", e))?;
    }

    fs::copy(template, target).map_err(|e| {
        format!(
            "copy template {} -> {}: {}",
            template.display(),
            target.display(),
            e
        )
    })?;

    Ok(())
}

fn sync_file_if_exists(source: &Path, target: &Path) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create target dir: {}", e))?;
    }

    fs::copy(source, target).map_err(|e| {
        format!(
            "copy template {} -> {}: {}",
            source.display(),
            target.display(),
            e
        )
    })?;

    Ok(())
}
