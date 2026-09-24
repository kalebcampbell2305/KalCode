//! The KalCode core runtime: owns the database and event bus and exposes the operations the
//! desktop shell turns into IPC commands.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Instant;

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::db::{self, Migration};
use crate::error::{KalError, Result};
use crate::events::{EventBus, EventEnvelope, EventPayload, EventStore, NewEvent, SubscriptionId};
use crate::flags::{BuildChannel, FeatureFlags};
use crate::settings::{self, Settings, SettingsPatch};
use crate::time::now_rfc3339;

pub const PRODUCT_NAME: &str = "KalCode";

/// Filesystem layout under the data directory.
#[derive(Debug, Clone)]
pub struct Paths {
    pub data_dir: PathBuf,
    pub database: PathBuf,
    pub logs: PathBuf,
    pub backups: PathBuf,
}

impl Paths {
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        let data_dir = data_dir.into();
        Self {
            database: data_dir.join("kalcode.db"),
            logs: data_dir.join("logs"),
            backups: data_dir.join("backups"),
            data_dir,
        }
    }
}

#[derive(Debug, Clone)]
pub struct CoreConfig {
    pub paths: Paths,
    pub app_version: String,
    pub channel: BuildChannel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub channel: BuildChannel,
    pub platform: String,
    pub arch: String,
    pub flags: FeatureFlags,
}

impl AppInfo {
    /// Build information; available even when the core failed to start.
    pub fn current(version: &str, channel: BuildChannel) -> Self {
        Self {
            name: PRODUCT_NAME.to_owned(),
            version: version.to_owned(),
            channel,
            platform: std::env::consts::OS.to_owned(),
            arch: std::env::consts::ARCH.to_owned(),
            flags: FeatureFlags::for_channel(channel),
        }
    }
}

/// What the UI needs to render its first frame: build info, and the startup error if the
/// core could not start (for example, a database created by a newer KalCode).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BootState {
    pub info: AppInfo,
    pub startup_error: Option<crate::error::IpcError>,
}

/// Result of an end-to-end check of the OS credential store.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SecureStoreCheck {
    pub ok: bool,
    pub backend: String,
    pub checked_at: String,
    /// User-safe explanation when the check failed.
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OsSummary {
    pub family: String,
    pub version: String,
    pub arch: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DatabaseSummary {
    pub schema_version: i64,
    pub latest_schema_version: i64,
    pub size_bytes: u64,
    pub event_count: i64,
    pub journal_mode: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SecureStoreSummary {
    pub last_checked_at: Option<String>,
    pub last_check_ok: Option<bool>,
    pub backend: Option<String>,
}

/// Paths shown to the user, with the home directory replaced by `~`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PathSummary {
    pub data_dir: String,
    pub log_dir: String,
    pub database: String,
}

/// A sanitized diagnostic snapshot. Contains no project content, prompts or secrets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Diagnostics {
    pub generated_at: String,
    pub app: AppInfo,
    pub os: OsSummary,
    pub uptime_ms: u64,
    pub started_at: String,
    pub database: DatabaseSummary,
    pub secure_store: SecureStoreSummary,
    pub paths: PathSummary,
}

pub struct Core {
    /// Exclusive OS lock on `<data_dir>/kalcode.lock`, held for the life of the core so only
    /// one KalCode process can use a data folder at a time.
    _data_lock: std::fs::File,
    conn: Mutex<Connection>,
    bus: EventBus,
    config: CoreConfig,
    latest_schema: i64,
    started: Instant,
    started_at: String,
    stopped: AtomicBool,
}

impl Core {
    /// Opens the database, applies migrations and records `app.started`.
    pub fn open(config: CoreConfig) -> Result<Self> {
        Self::open_with_migrations(config, db::MIGRATIONS)
    }

    /// As [`Core::open`] with an explicit migration set (upgrade tests).
    pub fn open_with_migrations(config: CoreConfig, migrations: &[Migration]) -> Result<Self> {
        let data_lock = lock_data_dir(&config.paths.data_dir)?;
        let mut conn = db::open(&config.paths.database)?;
        let outcome = db::migrate(&mut conn, migrations, Some(&config.paths.backups))?;
        db::enable_wal(&conn)?;
        let interrupted = previous_session_interrupted(&conn)?;
        let first_run = db::meta_get(&conn, "first_run_at")?.is_none();
        if first_run {
            db::meta_set(&conn, "first_run_at", &now_rfc3339())?;
        }
        db::meta_set(&conn, "last_version", &config.app_version)?;

        let core = Self {
            _data_lock: data_lock,
            conn: Mutex::new(conn),
            bus: EventBus::new(),
            latest_schema: migrations.last().map_or(0, |m| m.version),
            started: Instant::now(),
            started_at: now_rfc3339(),
            stopped: AtomicBool::new(false),
            config,
        };
        if outcome.applied_any() {
            core.emit(NewEvent::core(EventPayload::DatabaseMigrated {
                from_version: outcome.from_version,
                to_version: outcome.to_version,
                backup_created: outcome.backup.is_some(),
            }))?;
        }
        if let Some(last_event_at) = interrupted {
            tracing::warn!(event = "app.previous_session_interrupted", last_event_at = %last_event_at);
            core.emit(NewEvent::core(EventPayload::PreviousSessionInterrupted {
                last_event_at,
            }))?;
        }
        let info = core.app_info();
        core.emit(NewEvent::core(EventPayload::AppStarted {
            version: info.version,
            channel: info.channel,
            platform: info.platform,
            arch: info.arch,
        }))?;
        tracing::info!(event = "app.started", version = %core.config.app_version, first_run);
        Ok(core)
    }

    pub fn paths(&self) -> &Paths {
        &self.config.paths
    }

    fn conn(&self) -> MutexGuard<'_, Connection> {
        // The connection holds no invariants that a panic elsewhere could break mid-way
        // (all writes are transactional), so recover from poisoning.
        self.conn
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Persists then publishes an event. Publishing happens while the connection lock is held
    /// so subscribers always observe events in `seq` order.
    pub fn emit(&self, event: NewEvent) -> Result<EventEnvelope> {
        let conn = self.conn();
        let envelope = EventStore::append(&conn, event)?;
        self.bus.publish(&envelope);
        drop(conn);
        Ok(envelope)
    }

    pub fn app_info(&self) -> AppInfo {
        AppInfo::current(&self.config.app_version, self.config.channel)
    }

    pub fn settings(&self) -> Result<Settings> {
        settings::load(&self.conn())
    }

    pub fn update_settings(&self, patch: &SettingsPatch) -> Result<Settings> {
        let mut conn = self.conn();
        // The settings write and its `settings.changed` event commit together, or not at all.
        let tx = conn.transaction()?;
        let (next, keys) = settings::apply(&tx, patch)?;
        let envelope = if keys.is_empty() {
            None
        } else {
            Some(EventStore::append(
                &tx,
                NewEvent::core(EventPayload::SettingsChanged { keys }),
            )?)
        };
        tx.commit()?;
        if let Some(envelope) = envelope {
            self.bus.publish(&envelope);
        }
        Ok(next)
    }

    pub fn recent_events(&self, limit: u32, before_seq: Option<i64>) -> Result<Vec<EventEnvelope>> {
        EventStore::recent(&self.conn(), limit, before_seq)
    }

    pub fn subscribe(
        &self,
        subscriber: impl Fn(&EventEnvelope) -> bool + Send + Sync + 'static,
    ) -> SubscriptionId {
        self.bus.subscribe(subscriber)
    }

    pub fn unsubscribe(&self, id: SubscriptionId) -> bool {
        self.bus.unsubscribe(id)
    }

    /// Records the outcome of a secure-store check performed by the shell.
    pub fn record_secure_store_check(&self, ok: bool, backend: &str) -> Result<EventEnvelope> {
        self.emit(NewEvent::core(EventPayload::SecureStoreChecked {
            ok,
            backend: backend.to_owned(),
        }))
    }

    pub fn diagnostics(&self) -> Result<Diagnostics> {
        let conn = self.conn();
        let schema_version = db::schema_version(&conn)?;
        let event_count = EventStore::count(&conn)?;
        let journal_mode: String =
            conn.pragma_query_value(None, "journal_mode", |row| row.get(0))?;
        let last_check: Option<(String, String)> = conn
            .query_row(
                "SELECT occurred_at, payload FROM events WHERE type = 'secure_store.checked' ORDER BY seq DESC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        drop(conn);

        let secure_store = match last_check {
            Some((at, payload)) => {
                let value: serde_json::Value = serde_json::from_str(&payload)?;
                SecureStoreSummary {
                    last_checked_at: Some(at),
                    last_check_ok: value.get("ok").and_then(serde_json::Value::as_bool),
                    backend: value
                        .get("backend")
                        .and_then(|v| v.as_str())
                        .map(str::to_owned),
                }
            }
            None => SecureStoreSummary {
                last_checked_at: None,
                last_check_ok: None,
                backend: None,
            },
        };

        let paths = &self.config.paths;
        let size_bytes = [paths.database.clone(), wal_path(&paths.database)]
            .iter()
            .filter_map(|p| std::fs::metadata(p).ok())
            .map(|m| m.len())
            .sum();
        let os = os_info::get();

        Ok(Diagnostics {
            generated_at: now_rfc3339(),
            app: self.app_info(),
            os: OsSummary {
                family: std::env::consts::OS.to_owned(),
                version: os.version().to_string(),
                arch: std::env::consts::ARCH.to_owned(),
            },
            uptime_ms: u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX),
            started_at: self.started_at.clone(),
            database: DatabaseSummary {
                schema_version,
                latest_schema_version: self.latest_schema,
                size_bytes,
                event_count,
                journal_mode,
            },
            secure_store,
            paths: PathSummary {
                data_dir: display_path(&paths.data_dir),
                log_dir: display_path(&paths.logs),
                database: display_path(&paths.database),
            },
        })
    }

    /// Records `app.stopped` once. Safe to call multiple times.
    pub fn shutdown(&self) {
        if self.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        let uptime_ms = u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX);
        match self.emit(NewEvent::core(EventPayload::AppStopped { uptime_ms })) {
            Ok(_) => tracing::info!(event = "app.stopped", uptime_ms),
            Err(error) => {
                tracing::error!(event = "app.stop_record_failed", error = %error.diagnostic())
            }
        }
        // Checkpoint the WAL so the database file is self-contained after exit.
        if let Err(error) = self
            .conn()
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        {
            tracing::warn!(event = "database.checkpoint_failed", error = %error);
        }
    }
}

/// Takes the exclusive lock that makes a data folder single-writer.
fn lock_data_dir(data_dir: &Path) -> Result<std::fs::File> {
    let fs_error = |e: std::io::Error| {
        KalError::new(
            crate::error::ErrorCategory::Filesystem,
            "data_dir_unavailable",
            "KalCode couldn't open its data folder.",
        )
        .with_source(e)
    };
    std::fs::create_dir_all(data_dir).map_err(fs_error)?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(data_dir.join("kalcode.lock"))
        .map_err(fs_error)?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(std::fs::TryLockError::WouldBlock) => Err(KalError::new(
            crate::error::ErrorCategory::Internal,
            "already_running",
            "KalCode is already running with this data folder. Switch to the open KalCode window.",
        )),
        Err(std::fs::TryLockError::Error(e)) => Err(fs_error(e)),
    }
}

/// If the most recent lifecycle event is `app.started` (no matching `app.stopped`), the last
/// session ended unexpectedly. Returns the time of the last event recorded in that session.
fn previous_session_interrupted(conn: &Connection) -> Result<Option<String>> {
    let last_lifecycle: Option<String> = conn
        .query_row(
            "SELECT type FROM events WHERE type IN ('app.started', 'app.stopped') ORDER BY seq DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if last_lifecycle.as_deref() != Some("app.started") {
        return Ok(None);
    }
    Ok(conn
        .query_row(
            "SELECT occurred_at FROM events ORDER BY seq DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()?)
}

fn wal_path(database: &Path) -> PathBuf {
    let mut name = database.as_os_str().to_owned();
    name.push("-wal");
    PathBuf::from(name)
}

/// Replaces the user's home directory prefix with `~` so reports don't reveal the username.
pub fn display_path(path: &Path) -> String {
    let full = path.display().to_string();
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    match home.and_then(|home| strip_home(&full, &home.to_string_lossy(), cfg!(windows))) {
        Some(rest) => format!("~{rest}"),
        None => full,
    }
}

/// Returns the part of `path` after the `home` prefix (starting with a separator, or empty).
/// Windows comparison ignores case and a `\\?\` verbatim prefix. The prefix must end at a
/// path boundary, so `C:\Users\Kal` does not match `C:\Users\Kaleb`.
fn strip_home<'a>(path: &'a str, home: &str, windows: bool) -> Option<&'a str> {
    const VERBATIM: &str = r"\\?\";
    let (path, home) = if windows {
        (
            path.strip_prefix(VERBATIM).unwrap_or(path),
            home.strip_prefix(VERBATIM).unwrap_or(home),
        )
    } else {
        (path, home)
    };
    let home = home.trim_end_matches(['/', '\\']);
    if home.is_empty() || !path.is_char_boundary(home.len()) || path.len() < home.len() {
        return None;
    }
    let (head, rest) = path.split_at(home.len());
    let same = if windows {
        head.to_lowercase() == home.to_lowercase()
    } else {
        head == home
    };
    let at_boundary = rest.is_empty() || rest.starts_with(['/', '\\']);
    (same && at_boundary).then_some(rest)
}

impl KalError {
    /// Convenience for command handlers: log the full diagnostic, return the IPC shape.
    pub fn log_and_convert(self, command: &'static str) -> crate::error::IpcError {
        tracing::error!(event = "ipc.command_failed", command, error_code = self.code, error = %self.diagnostic());
        self.to_ipc()
    }
}

#[cfg(test)]
mod path_tests {
    use super::strip_home;

    #[test]
    fn strips_home_case_insensitively_on_windows() {
        assert_eq!(
            strip_home(r"c:\USERS\kaleb\AppData\x.db", r"C:\Users\Kaleb", true),
            Some(r"\AppData\x.db")
        );
        assert_eq!(
            strip_home(r"\\?\C:\Users\Kaleb\data", r"C:\Users\Kaleb", true),
            Some(r"\data")
        );
        assert_eq!(
            strip_home(r"C:\Users\Kaleb", r"C:\Users\Kaleb\", true),
            Some("")
        );
    }

    #[test]
    fn requires_a_path_boundary() {
        assert_eq!(
            strip_home(r"C:\Users\Kaleb2\data", r"C:\Users\Kaleb", true),
            None
        );
        assert_eq!(strip_home("/home/kal/x", "/home/kaleb", false), None);
        assert_eq!(strip_home("/home/kalebx/x", "/home/kaleb", false), None);
    }

    #[test]
    fn unix_comparison_is_case_sensitive() {
        assert_eq!(
            strip_home("/home/kaleb/x", "/home/kaleb", false),
            Some("/x")
        );
        assert_eq!(strip_home("/HOME/kaleb/x", "/home/kaleb", false), None);
    }

    #[test]
    fn non_ascii_does_not_panic() {
        assert_eq!(strip_home("/home/é", "/home/éé", false), None);
        assert_eq!(strip_home("/hé", "/h", false), None);
    }
}
