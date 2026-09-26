//! The SQLite Viewer (UD-05).
//!
//! A database is opened **read-only** three times over: the file is opened with
//! `SQLITE_OPEN_READ_ONLY` (never created, links not followed), `PRAGMA query_only` is on, and an
//! authorizer denies everything but reads — no writes, no `ATTACH`/`DETACH`, no schema changes,
//! no `PRAGMA` that sets something, no extension loading. `trusted_schema` is off and defensive
//! mode on, so a hostile file's views and triggers can't call unsafe functions. Every statement
//! runs under a 5-second limit (a progress handler interrupts it) and returns at most
//! [`MAX_PAGE_ROWS`] rows per page; only one statement runs per call.
//!
//! Changes are possible only through [`SqliteSessions::write`], a separate call the desktop
//! shell puts behind the permission engine (`filesystem.write` on the file) and the person's
//! explicit confirmation. It opens its own read-write connection for that one statement, still
//! without `ATTACH`, `PRAGMA`, `VACUUM` or extensions, and closes it.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use kalcode_contracts::permissions::UtilitySqliteOperation;
use kalcode_core::{ErrorCategory, KalError, Result};
use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags, config::DbConfig};

use crate::types::{
    SqliteCell, SqliteColumn, SqliteHandle, SqliteObject, SqliteObjectKind, SqliteQueryResult,
    SqliteWriteResult,
};
use crate::{invalid, invalid_id, refused};

pub const QUERY_TIME_LIMIT: Duration = Duration::from_secs(5);
pub const MAX_PAGE_ROWS: u32 = 500;
pub const DEFAULT_PAGE_ROWS: u32 = 100;
pub const MAX_SQL_BYTES: usize = 100 * 1024;
/// Databases open at once.
pub const MAX_OPEN: usize = 8;
const MAX_TEXT_CHARS: usize = 4096;
const BLOB_PREVIEW: usize = 32;

fn linked_database_refused() -> KalError {
    refused(
        "sqlite_link_refused",
        "Open a database file that has exactly one filesystem name; links are not allowed.",
    )
}

fn database_changed() -> KalError {
    refused(
        "sqlite_file_changed",
        "That database file changed after it was opened. Open it again.",
    )
}

#[cfg(windows)]
#[allow(unsafe_code)]
mod stable_file {
    use std::os::windows::ffi::OsStrExt;

    use super::*;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, CreateFileW, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
        GetFileInformationByHandle, OPEN_EXISTING,
    };

    const GENERIC_READ_ACCESS: u32 = 0x8000_0000;

    #[derive(Clone, Copy, PartialEq, Eq)]
    struct Identity {
        volume: u32,
        index: u64,
    }

    pub(super) struct StableFile {
        handle: HANDLE,
        identity: Identity,
    }

    // SAFETY: this owned Windows file handle may be queried and closed from any thread, and the
    // struct has one close path in Drop.
    unsafe impl Send for StableFile {}
    unsafe impl Sync for StableFile {}

    impl Drop for StableFile {
        fn drop(&mut self) {
            // SAFETY: `handle` is a unique owned non-null handle returned by CreateFileW.
            unsafe { CloseHandle(self.handle) };
        }
    }

    impl StableFile {
        pub(super) fn open(path: &Path) -> Result<Self> {
            let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
            wide.push(0);
            // No FILE_SHARE_DELETE: the selected object cannot be renamed/replaced while a
            // sealed operation retains this handle. OPEN_REPARSE_POINT lets us reject a final
            // symlink/junction instead of following it.
            let handle = unsafe {
                CreateFileW(
                    wide.as_ptr(),
                    GENERIC_READ_ACCESS,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    std::ptr::null(),
                    OPEN_EXISTING,
                    FILE_FLAG_OPEN_REPARSE_POINT,
                    std::ptr::null_mut(),
                )
            };
            if handle == INVALID_HANDLE_VALUE {
                return Err(KalError::new(
                    ErrorCategory::Filesystem,
                    "sqlite_cannot_open",
                    "KalCode couldn't retain that database file.",
                )
                .with_source(std::io::Error::last_os_error()));
            }
            let info = match information(handle) {
                Ok(info) => info,
                Err(error) => {
                    unsafe { CloseHandle(handle) };
                    return Err(error);
                }
            };
            if let Err(error) = validate_information(&info) {
                unsafe { CloseHandle(handle) };
                return Err(error);
            }
            Ok(Self {
                handle,
                identity: identity(&info),
            })
        }

        /// Revalidates mutable filesystem facts on the exact retained object.
        pub(super) fn verify_retained(&self) -> Result<()> {
            let info = information(self.handle)?;
            validate_information(&info)?;
            if identity(&info) != self.identity {
                return Err(database_changed());
            }
            Ok(())
        }

        /// Opens the current path without delete sharing and proves it still names this file.
        /// The returned handle stays live through the SQLite effect.
        pub(super) fn verify_current(&self, path: &Path) -> Result<Self> {
            self.verify_retained()?;
            let current = Self::open(path)?;
            if current.identity != self.identity {
                return Err(database_changed());
            }
            Ok(current)
        }
    }

    fn information(handle: HANDLE) -> Result<BY_HANDLE_FILE_INFORMATION> {
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        if unsafe { GetFileInformationByHandle(handle, &mut info) } == 0 {
            return Err(KalError::new(
                ErrorCategory::Filesystem,
                "sqlite_identity_unavailable",
                "KalCode couldn't verify that database file.",
            )
            .with_source(std::io::Error::last_os_error()));
        }
        Ok(info)
    }

    fn validate_information(info: &BY_HANDLE_FILE_INFORMATION) -> Result<()> {
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 || info.nNumberOfLinks != 1 {
            return Err(linked_database_refused());
        }
        Ok(())
    }

    fn identity(info: &BY_HANDLE_FILE_INFORMATION) -> Identity {
        Identity {
            volume: info.dwVolumeSerialNumber,
            index: (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
        }
    }
}

#[cfg(not(windows))]
mod stable_file {
    use super::*;

    #[derive(Clone, Copy, PartialEq, Eq)]
    struct Identity {
        #[cfg(unix)]
        device: u64,
        #[cfg(unix)]
        inode: u64,
        #[cfg(not(unix))]
        length: u64,
        #[cfg(not(unix))]
        modified: Option<std::time::SystemTime>,
    }

    pub(super) struct StableFile {
        file: std::fs::File,
        canonical: PathBuf,
        identity: Identity,
    }

    impl StableFile {
        pub(super) fn open(path: &Path) -> Result<Self> {
            let metadata = std::fs::symlink_metadata(path).map_err(|error| {
                KalError::new(
                    ErrorCategory::Filesystem,
                    "sqlite_cannot_open",
                    "KalCode couldn't retain that database file.",
                )
                .with_source(error)
            })?;
            if metadata.file_type().is_symlink() {
                return Err(refused(
                    "sqlite_link_refused",
                    "Open the database file itself rather than a link.",
                ));
            }
            let canonical = std::fs::canonicalize(path).map_err(|error| {
                KalError::new(
                    ErrorCategory::Filesystem,
                    "sqlite_identity_unavailable",
                    "KalCode couldn't verify that database file.",
                )
                .with_source(error)
            })?;
            let file = std::fs::File::open(&canonical).map_err(|error| {
                KalError::new(
                    ErrorCategory::Filesystem,
                    "sqlite_cannot_open",
                    "KalCode couldn't retain that database file.",
                )
                .with_source(error)
            })?;
            let retained = file.metadata().map_err(identity_error)?;
            validate_metadata(&retained)?;
            let current = std::fs::metadata(&canonical).map_err(identity_error)?;
            validate_metadata(&current)?;
            let identity = metadata_identity(&retained);
            if metadata_identity(&current) != identity {
                return Err(database_changed());
            }
            Ok(Self {
                file,
                canonical,
                identity,
            })
        }

        pub(super) fn verify_retained(&self) -> Result<()> {
            let retained = self.file.metadata().map_err(identity_error)?;
            validate_metadata(&retained)?;
            if metadata_identity(&retained) != self.identity {
                return Err(database_changed());
            }
            Ok(())
        }

        pub(super) fn verify_current(&self, path: &Path) -> Result<Self> {
            self.verify_retained()?;
            let current = Self::open(path)?;
            if current.canonical != self.canonical || current.identity != self.identity {
                return Err(database_changed());
            }
            Ok(current)
        }
    }

    fn identity_error(error: std::io::Error) -> KalError {
        KalError::new(
            ErrorCategory::Filesystem,
            "sqlite_identity_unavailable",
            "KalCode couldn't verify that database file.",
        )
        .with_source(error)
    }

    fn validate_metadata(metadata: &std::fs::Metadata) -> Result<()> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;

            if metadata.nlink() != 1 {
                return Err(linked_database_refused());
            }
            Ok(())
        }
        #[cfg(not(unix))]
        {
            let _ = metadata;
            Err(KalError::new(
                ErrorCategory::Filesystem,
                "sqlite_identity_unavailable",
                "KalCode can't verify database link identity on this platform.",
            ))
        }
    }

    fn metadata_identity(metadata: &std::fs::Metadata) -> Identity {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;

            Identity {
                device: metadata.dev(),
                inode: metadata.ino(),
            }
        }
        #[cfg(not(unix))]
        {
            Identity {
                length: metadata.len(),
                modified: metadata.modified().ok(),
            }
        }
    }
}

use stable_file::StableFile;

/// `PRAGMA`s that only read, allowed with or without an argument (`table_info(t)`).
const READ_PRAGMAS: &[&str] = &[
    "table_info",
    "table_xinfo",
    "table_list",
    "index_list",
    "index_info",
    "index_xinfo",
    "foreign_key_list",
    "foreign_key_check",
    "integrity_check",
    "quick_check",
    "collation_list",
    "function_list",
    "module_list",
    "pragma_list",
    "compile_options",
    "database_list",
];

/// `PRAGMA`s that read a setting without an argument and would change it with one.
const STATE_PRAGMAS: &[&str] = &[
    "user_version",
    "schema_version",
    "application_id",
    "page_count",
    "page_size",
    "max_page_count",
    "encoding",
    "journal_mode",
    "freelist_count",
    "auto_vacuum",
    "data_version",
    "foreign_keys",
    "query_only",
];

fn not_allowed() -> KalError {
    refused(
        "sqlite_read_only",
        "The SQLite Viewer opens databases read-only. Use “Run as a change” to modify data.",
    )
}

fn not_a_change() -> KalError {
    invalid(
        "sqlite_not_a_change",
        "That statement doesn't change anything. Run it as a query instead.",
    )
}

/// The read-only authorizer.
fn read_only_authorizer(ctx: AuthContext<'_>) -> Authorization {
    match ctx.action {
        AuthAction::Select | AuthAction::Read { .. } | AuthAction::Recursive => {
            Authorization::Allow
        }
        AuthAction::Function { function_name } => function_authorization(function_name),
        AuthAction::Pragma {
            pragma_name,
            pragma_value,
        } => {
            let name = pragma_name.to_ascii_lowercase();
            if READ_PRAGMAS.contains(&name.as_str())
                || (pragma_value.is_none() && STATE_PRAGMAS.contains(&name.as_str()))
            {
                Authorization::Allow
            } else {
                Authorization::Deny
            }
        }
        _ => Authorization::Deny,
    }
}

fn function_authorization(name: &str) -> Authorization {
    match name.to_ascii_lowercase().as_str() {
        "load_extension" | "fts3_tokenizer" | "readfile" | "writefile" | "edit" => {
            Authorization::Deny
        }
        _ => Authorization::Allow,
    }
}

/// The write authorizer: data and schema changes, but no `ATTACH`/`DETACH`, no `PRAGMA`, no
/// extensions.
fn write_authorizer(ctx: AuthContext<'_>) -> Authorization {
    match ctx.action {
        AuthAction::Attach { .. } | AuthAction::Detach { .. } | AuthAction::Pragma { .. } => {
            Authorization::Deny
        }
        AuthAction::Function { function_name } => function_authorization(function_name),
        _ => Authorization::Allow,
    }
}

/// Settings every connection gets before any statement from the person runs.
fn harden(conn: &Connection) -> Result<()> {
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)
        .map_err(db_error)?;
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA, false)
        .map_err(db_error)?;
    Ok(())
}

fn db_error(error: rusqlite::Error) -> KalError {
    use rusqlite::ErrorCode;
    match &error {
        rusqlite::Error::SqliteFailure(e, message) => match e.code {
            ErrorCode::OperationInterrupted => KalError::new(
                ErrorCategory::Database,
                "sqlite_timeout",
                "The query took longer than 5 seconds and was stopped.",
            ),
            ErrorCode::AuthorizationForStatementDenied | ErrorCode::ReadOnly => not_allowed(),
            ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked => KalError::new(
                ErrorCategory::Database,
                "sqlite_busy",
                "Another program is writing to this database. Try again in a moment.",
            )
            .retryable(),
            ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt => KalError::new(
                ErrorCategory::Database,
                "sqlite_not_a_database",
                "That file isn't a readable SQLite database.",
            ),
            ErrorCode::CannotOpen => KalError::new(
                ErrorCategory::Database,
                "sqlite_cannot_open",
                "KalCode couldn't open that database file.",
            ),
            _ => KalError::new(
                ErrorCategory::Database,
                "sqlite_error",
                message
                    .as_deref()
                    .map(|m| format!("SQLite: {}", kalcode_core::confirm::sanitize(m)))
                    .unwrap_or_else(|| "SQLite reported an error.".into()),
            ),
        },
        rusqlite::Error::MultipleStatement => {
            invalid("sqlite_multiple_statements", "Run one statement at a time.")
        }
        _ => KalError::new(
            ErrorCategory::Database,
            "sqlite_error",
            format!(
                "SQLite: {}",
                kalcode_core::confirm::sanitize(&error.to_string())
            ),
        ),
    }
}

/// Checks the file starts with the SQLite header (a clear error for any other file).
fn check_header(path: &Path) -> Result<u64> {
    let mut file = std::fs::File::open(path).map_err(|e| {
        KalError::new(
            ErrorCategory::Filesystem,
            "sqlite_cannot_open",
            "KalCode couldn't open that file.",
        )
        .with_source(e)
    })?;
    let bytes = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut header = [0u8; 16];
    if bytes == 0 {
        return Err(KalError::new(
            ErrorCategory::Database,
            "sqlite_empty",
            "That file is empty, so there's nothing to show.",
        ));
    }
    if file.read_exact(&mut header).is_err() || &header != b"SQLite format 3\0" {
        return Err(KalError::new(
            ErrorCategory::Database,
            "sqlite_not_a_database",
            "That file isn't a SQLite database.",
        ));
    }
    Ok(bytes)
}

fn open_read_only(path: &Path) -> Result<Connection> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(db_error)?;
    harden(&conn)?;
    conn.pragma_update(None, "query_only", true)
        .map_err(db_error)?;
    conn.authorizer(Some(read_only_authorizer))
        .map_err(db_error)?;
    Ok(conn)
}

/// Runs `f` with a time limit on `conn` (a progress handler interrupts it).
fn with_time_limit<T>(conn: &Connection, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
    let deadline = Instant::now() + QUERY_TIME_LIMIT;
    conn.progress_handler(1_000, Some(move || Instant::now() > deadline))
        .map_err(db_error)?;
    let result = f(conn);
    let _ = conn.progress_handler(0, None::<fn() -> bool>);
    result
}

fn cell(value: ValueRef<'_>) -> SqliteCell {
    match value {
        ValueRef::Null => SqliteCell::Null,
        ValueRef::Integer(v) => SqliteCell::Integer { value: v },
        ValueRef::Real(v) if v.is_finite() => SqliteCell::Real { value: v },
        ValueRef::Real(v) => SqliteCell::Text {
            value: if v.is_nan() {
                "NaN".into()
            } else if v > 0.0 {
                "Infinity".into()
            } else {
                "-Infinity".into()
            },
            truncated: false,
        },
        ValueRef::Text(bytes) => {
            let text = String::from_utf8_lossy(bytes);
            let truncated = text.chars().count() > MAX_TEXT_CHARS;
            SqliteCell::Text {
                value: if truncated {
                    text.chars().take(MAX_TEXT_CHARS).collect()
                } else {
                    text.into_owned()
                },
                truncated,
            }
        }
        ValueRef::Blob(bytes) => SqliteCell::Blob {
            bytes: u32::try_from(bytes.len()).unwrap_or(u32::MAX),
            preview_hex: bytes
                .iter()
                .take(BLOB_PREVIEW)
                .map(|b| format!("{b:02x}"))
                .collect(),
        },
    }
}

fn check_sql(sql: &str) -> Result<&str> {
    let sql = sql.trim();
    if sql.is_empty() {
        return Err(invalid("sqlite_sql_missing", "Enter a SQL statement."));
    }
    if sql.len() > MAX_SQL_BYTES {
        return Err(invalid(
            "sqlite_sql_too_long",
            "That statement is longer than 100 KiB.",
        ));
    }
    Ok(sql)
}

/// The first keyword of a statement (comments skipped), upper-case.
fn first_keyword(sql: &str) -> String {
    let mut rest = sql.trim_start();
    loop {
        if let Some(after) = rest.strip_prefix("--") {
            rest = after.split_once('\n').map_or("", |(_, r)| r).trim_start();
        } else if let Some(after) = rest.strip_prefix("/*") {
            rest = after.split_once("*/").map_or("", |(_, r)| r).trim_start();
        } else {
            break;
        }
    }
    rest.chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_ascii_uppercase()
}

fn object_kind(kind: &str) -> Option<SqliteObjectKind> {
    match kind {
        "table" => Some(SqliteObjectKind::Table),
        "view" => Some(SqliteObjectKind::View),
        "index" => Some(SqliteObjectKind::Index),
        "trigger" => Some(SqliteObjectKind::Trigger),
        _ => None,
    }
}

/// Tables, views, indexes and triggers with their columns.
fn schema(conn: &Connection) -> Result<Vec<SqliteObject>> {
    with_time_limit(conn, |conn| {
        let mut stmt = conn
            .prepare(
                "SELECT type, name, tbl_name, sql FROM sqlite_master
                 WHERE name NOT LIKE 'sqlite_%' ORDER BY type = 'table' DESC, type, name",
            )
            .map_err(db_error)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(db_error)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(db_error)?;
        let mut objects = Vec::new();
        for (kind, name, table, sql) in rows.into_iter().take(2_000) {
            let Some(kind) = object_kind(&kind) else {
                continue;
            };
            let columns = if matches!(kind, SqliteObjectKind::Table | SqliteObjectKind::View) {
                let mut cols = conn
                    .prepare("SELECT name, type, \"notnull\", pk, dflt_value FROM pragma_table_xinfo(?1)")
                    .map_err(db_error)?;
                cols.query_map([&name], |row| {
                    Ok(SqliteColumn {
                        name: row.get(0)?,
                        decl_type: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                        not_null: row.get::<_, i64>(2)? != 0,
                        primary_key: u32::try_from(row.get::<_, i64>(3)?).unwrap_or(0),
                        default_value: row.get(4)?,
                    })
                })
                .map_err(db_error)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(db_error)?
            } else {
                Vec::new()
            };
            objects.push(SqliteObject {
                kind,
                table: table.filter(|t| t != &name),
                name,
                sql,
                columns,
            });
        }
        Ok(objects)
    })
}

struct OpenDb {
    conn: Mutex<Connection>,
    path: PathBuf,
    stable: StableFile,
    display_name: String,
    workspace_id: Option<String>,
    bytes: u64,
}

/// One exact SQLite change sealed before approval. It retains the opened database identity and
/// the SQL bytes in native memory; approval review receives only the typed operation and safe
/// display name.
pub struct PreparedSqliteWrite {
    db: Arc<OpenDb>,
    database_id: String,
    sql: String,
    operation: UtilitySqliteOperation,
}

impl std::fmt::Debug for PreparedSqliteWrite {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PreparedSqliteWrite")
            .field("database_id", &self.database_id)
            .field("operation", &self.operation)
            .finish_non_exhaustive()
    }
}

impl PreparedSqliteWrite {
    pub fn database_id(&self) -> &str {
        &self.database_id
    }

    pub fn database_name(&self) -> &str {
        &self.db.display_name
    }

    pub fn workspace_id(&self) -> Option<&str> {
        self.db.workspace_id.as_deref()
    }

    pub fn operation(&self) -> UtilitySqliteOperation {
        self.operation
    }

    pub fn execute(self) -> Result<SqliteWriteResult> {
        execute_write(&self.db, &self.sql)
    }
}

fn write_operation(sql: &str) -> Result<UtilitySqliteOperation> {
    match first_keyword(sql).as_str() {
        "INSERT" => Ok(UtilitySqliteOperation::Insert),
        "UPDATE" => Ok(UtilitySqliteOperation::Update),
        "DELETE" => Ok(UtilitySqliteOperation::Delete),
        "REPLACE" => Ok(UtilitySqliteOperation::Replace),
        "CREATE" => Ok(UtilitySqliteOperation::Create),
        "DROP" => Ok(UtilitySqliteOperation::Drop),
        "ALTER" => Ok(UtilitySqliteOperation::Alter),
        _ => Err(refused(
            "sqlite_statement_refused",
            "The SQLite Viewer changes data only with INSERT, UPDATE, DELETE, REPLACE, CREATE, DROP or ALTER.",
        )),
    }
}

fn execute_write(db: &OpenDb, sql: &str) -> Result<SqliteWriteResult> {
    // Hold both the original identity and a fresh current-path identity without delete sharing
    // until the transaction has committed. A reparse/symlink or object swap fails closed.
    let current_identity = db.stable.verify_current(&db.path)?;
    let _read = db.conn.lock().unwrap_or_else(PoisonError::into_inner);
    let started = Instant::now();
    let mut conn = Connection::open_with_flags(
        &db.path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(db_error)?;
    let after_sqlite_open = db.stable.verify_current(&db.path)?;
    harden(&conn)?;
    conn.busy_timeout(Duration::from_secs(2))
        .map_err(db_error)?;
    conn.authorizer(Some(write_authorizer)).map_err(db_error)?;
    let deadline = Instant::now() + QUERY_TIME_LIMIT;
    conn.progress_handler(1_000, Some(move || Instant::now() > deadline))
        .map_err(db_error)?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let changes = {
        let mut stmt = tx.prepare(sql).map_err(db_error)?;
        if stmt.readonly() {
            return Err(not_a_change());
        }
        db.stable.verify_retained()?;
        current_identity.verify_retained()?;
        after_sqlite_open.verify_retained()?;
        stmt.raw_execute().map_err(db_error)?;
        tx.changes()
    };
    db.stable.verify_retained()?;
    current_identity.verify_retained()?;
    after_sqlite_open.verify_retained()?;
    tx.commit().map_err(db_error)?;
    tracing::info!(event = "utility.sqlite_write", changes);
    Ok(SqliteWriteResult {
        changes,
        elapsed_ms: crate::elapsed_ms(started),
    })
}

/// Databases open in this session.
#[derive(Default)]
pub struct SqliteSessions {
    open: Mutex<HashMap<String, Arc<OpenDb>>>,
}

impl SqliteSessions {
    pub fn new() -> Self {
        Self::default()
    }

    fn get(&self, id: &str) -> Result<Arc<OpenDb>> {
        if !kalcode_contracts::ids::is_valid_id(id) {
            return Err(invalid_id());
        }
        self.open
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(id)
            .cloned()
            .ok_or_else(|| {
                invalid(
                    "sqlite_not_open",
                    "That database isn't open any more. Open it again.",
                )
            })
    }

    /// Opens `path` read-only. The caller resolved `path` natively (a verified workspace file
    /// handle or the native picker) and refused KalCode's own data folder.
    pub fn open(
        &self,
        path: &Path,
        display_name: String,
        workspace_id: Option<String>,
    ) -> Result<SqliteHandle> {
        let stable = StableFile::open(path)?;
        let bytes = check_header(path)?;
        let conn = open_read_only(path)?;
        let current = stable.verify_current(path)?;
        let objects = schema(&conn)?;
        stable.verify_retained()?;
        current.verify_retained()?;
        let id = uuid::Uuid::now_v7().to_string();
        let db = Arc::new(OpenDb {
            conn: Mutex::new(conn),
            path: path.to_path_buf(),
            stable,
            display_name: display_name.clone(),
            workspace_id: workspace_id.clone(),
            bytes,
        });
        let mut open = self.open.lock().unwrap_or_else(PoisonError::into_inner);
        if open.len() >= MAX_OPEN {
            return Err(invalid(
                "sqlite_too_many_open",
                "Close a database first: at most 8 can be open at once.",
            ));
        }
        open.insert(id.clone(), db);
        Ok(SqliteHandle {
            id,
            display_name,
            workspace_id,
            bytes,
            objects,
        })
    }

    /// The schema again (after a change).
    pub fn describe(&self, id: &str) -> Result<SqliteHandle> {
        let db = self.get(id)?;
        let current = db.stable.verify_current(&db.path)?;
        let conn = db.conn.lock().unwrap_or_else(PoisonError::into_inner);
        let objects = schema(&conn)?;
        db.stable.verify_retained()?;
        current.verify_retained()?;
        Ok(SqliteHandle {
            id: id.to_owned(),
            display_name: db.display_name.clone(),
            workspace_id: db.workspace_id.clone(),
            bytes: std::fs::metadata(&db.path).map_or(db.bytes, |m| m.len()),
            objects,
        })
    }

    /// Where an open database is (for the permission engine's `filesystem.write` evaluation).
    pub fn path_of(&self, id: &str) -> Result<(PathBuf, Option<String>, String)> {
        let db = self.get(id)?;
        Ok((
            db.path.clone(),
            db.workspace_id.clone(),
            db.display_name.clone(),
        ))
    }

    pub fn close(&self, id: &str) -> Result<()> {
        if !kalcode_contracts::ids::is_valid_id(id) {
            return Err(invalid_id());
        }
        self.open
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(id);
        Ok(())
    }

    /// Releases every native connection retained by this account runtime. Idempotent so a
    /// coordinator retry after another service's shutdown failure remains safe.
    pub fn close_all(&self) {
        self.open
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clear();
    }

    /// One page of a read-only statement. `cursor` is the row offset from a previous page.
    pub fn query(
        &self,
        id: &str,
        sql: &str,
        cursor: Option<&str>,
        limit: u32,
    ) -> Result<SqliteQueryResult> {
        let sql = check_sql(sql)?;
        let offset: u32 = match cursor {
            None => 0,
            Some(c) => c
                .parse()
                .map_err(|_| invalid("invalid_cursor", "That page cursor isn't valid."))?,
        };
        let limit = limit.clamp(1, MAX_PAGE_ROWS);
        let db = self.get(id)?;
        let current = db.stable.verify_current(&db.path)?;
        let conn = db.conn.lock().unwrap_or_else(PoisonError::into_inner);
        let started = Instant::now();
        let result = with_time_limit(&conn, |conn| {
            let mut stmt = conn.prepare(sql).map_err(db_error)?;
            if !stmt.readonly() {
                return Err(not_allowed());
            }
            let columns: Vec<String> = stmt
                .column_names()
                .iter()
                .map(|c| (*c).to_owned())
                .collect();
            let width = columns.len();
            let mut rows_iter = stmt.query([]).map_err(db_error)?;
            let mut skipped = 0u32;
            while skipped < offset {
                if rows_iter.next().map_err(db_error)?.is_none() {
                    break;
                }
                skipped += 1;
            }
            let mut rows = Vec::new();
            let mut truncated = false;
            while let Some(row) = rows_iter.next().map_err(db_error)? {
                if rows.len() as u32 >= limit {
                    truncated = true;
                    break;
                }
                let mut cells = Vec::with_capacity(width);
                for i in 0..width {
                    cells.push(cell(row.get_ref(i).map_err(db_error)?));
                }
                rows.push(cells);
            }
            let next = offset + rows.len() as u32;
            Ok(SqliteQueryResult {
                columns,
                rows,
                truncated,
                next_cursor: truncated.then(|| next.to_string()),
                offset,
                elapsed_ms: crate::elapsed_ms(started),
            })
        });
        db.stable.verify_retained()?;
        current.verify_retained()?;
        result
    }

    /// Runs one data or schema change on its own read-write connection, in a transaction. The
    /// desktop shell calls this only after the permission engine and the person's confirmation.
    pub fn write(&self, id: &str, sql: &str) -> Result<SqliteWriteResult> {
        // Preserve the original direct-call contract for an ordinary read statement. Approval
        // callers use `prepare_write`, whose fixed catalog intentionally classifies the same
        // statement as `sqlite_statement_refused` before creating an approval.
        if first_keyword(check_sql(sql)?) == "SELECT" {
            return Err(not_a_change());
        }
        self.prepare_write(id, sql)?.execute()
    }

    /// Seals one fixed-catalog change while retaining the database object from preparation
    /// through approval and effect.
    pub fn prepare_write(&self, id: &str, sql: &str) -> Result<PreparedSqliteWrite> {
        let sql = check_sql(sql)?;
        let operation = write_operation(sql)?;
        let db = self.get(id)?;
        // Prove the path still names the retained object while sealing. `OpenDb` itself keeps the
        // original identity handle alive through the later effect.
        let _current = db.stable.verify_current(&db.path)?;
        Ok(PreparedSqliteWrite {
            db,
            database_id: id.to_owned(),
            sql: sql.to_owned(),
            operation,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("shop.db");
        let conn = Connection::open(&path).expect("create");
        conn.execute_batch(
            "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price REAL, img BLOB);
             CREATE INDEX items_by_name ON items(name);
             CREATE VIEW cheap AS SELECT * FROM items WHERE price < 5;
             WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200)
             INSERT INTO items (name, price, img) SELECT 'item ' || i, i * 0.5, x'00ff10' FROM n;",
        )
        .expect("seed");
        drop(conn);
        (dir, path)
    }

    fn open(path: &Path) -> (SqliteSessions, SqliteHandle) {
        let sessions = SqliteSessions::new();
        let handle = sessions.open(path, "shop.db".into(), None).expect("opened");
        (sessions, handle)
    }

    #[test]
    fn the_schema_is_browsable() {
        let (_dir, path) = fixture();
        let (_s, handle) = open(&path);
        let names: Vec<(SqliteObjectKind, &str)> = handle
            .objects
            .iter()
            .map(|o| (o.kind, o.name.as_str()))
            .collect();
        assert_eq!(
            names,
            vec![
                (SqliteObjectKind::Table, "items"),
                (SqliteObjectKind::Index, "items_by_name"),
                (SqliteObjectKind::View, "cheap"),
            ]
        );
        let items = &handle.objects[0];
        assert_eq!(items.columns.len(), 4);
        assert_eq!(items.columns[0].primary_key, 1);
        assert!(items.columns[1].not_null);
        assert_eq!(handle.objects[1].table.as_deref(), Some("items"));
    }

    #[test]
    fn close_all_releases_every_retained_database_session() {
        let (_dir, path) = fixture();
        let sessions = SqliteSessions::new();
        let first = sessions
            .open(&path, "first.db".into(), None)
            .expect("first open");
        let second = sessions
            .open(&path, "second.db".into(), None)
            .expect("second open");

        sessions.close_all();

        assert_eq!(
            sessions.describe(&first.id).expect_err("first closed").code,
            "sqlite_not_open"
        );
        assert_eq!(
            sessions
                .describe(&second.id)
                .expect_err("second closed")
                .code,
            "sqlite_not_open"
        );
        sessions.close_all();
    }

    #[test]
    fn results_are_paged() {
        let (_dir, path) = fixture();
        let (s, handle) = open(&path);
        let first = s
            .query(
                &handle.id,
                "SELECT id, name, price, img, NULL FROM items ORDER BY id",
                None,
                500,
            )
            .expect("page 1");
        assert_eq!(first.rows.len(), 500);
        assert!(first.truncated);
        assert_eq!(first.next_cursor.as_deref(), Some("500"));
        assert_eq!(first.rows[0][0], SqliteCell::Integer { value: 1 });
        assert_eq!(
            first.rows[0][3],
            SqliteCell::Blob {
                bytes: 3,
                preview_hex: "00ff10".into()
            }
        );
        assert_eq!(first.rows[0][4], SqliteCell::Null);
        let third = s
            .query(
                &handle.id,
                "SELECT id FROM items ORDER BY id",
                Some("1000"),
                500,
            )
            .expect("page 3");
        assert_eq!(third.rows.len(), 200);
        assert!(!third.truncated);
        assert_eq!(third.rows[0][0], SqliteCell::Integer { value: 1001 });
        // The page limit is clamped.
        let clamped = s
            .query(&handle.id, "SELECT id FROM items", None, 100_000)
            .expect("clamped");
        assert_eq!(clamped.rows.len(), MAX_PAGE_ROWS as usize);
        // Read-only pragmas work.
        let info = s
            .query(&handle.id, "PRAGMA table_info(items)", None, 10)
            .expect("pragma");
        assert_eq!(info.rows.len(), 4);
        s.query(&handle.id, "PRAGMA user_version", None, 10)
            .expect("state pragma");
    }

    #[test]
    fn every_kind_of_write_is_refused_by_the_read_path() {
        let (dir, path) = fixture();
        let (s, handle) = open(&path);
        let outside = dir.path().join("evil.db");
        for sql in [
            "INSERT INTO items (name) VALUES ('x')",
            "UPDATE items SET name = 'x'",
            "DELETE FROM items",
            "DROP TABLE items",
            "CREATE TABLE t (x)",
            "ALTER TABLE items ADD COLUMN y",
            &format!("ATTACH DATABASE '{}' AS evil", outside.display()),
            "PRAGMA user_version = 7",
            "PRAGMA journal_mode = DELETE",
            "PRAGMA query_only = 0",
            "SELECT load_extension('x')",
            "VACUUM",
            "BEGIN",
            "REINDEX",
            "ANALYZE",
        ] {
            let error = s.query(&handle.id, sql, None, 10).expect_err(sql);
            assert!(
                matches!(error.code, "sqlite_read_only" | "sqlite_error"),
                "{sql}: {} {}",
                error.code,
                error.message
            );
        }
        assert!(!outside.exists(), "ATTACH must not create a file");
        // Still unchanged.
        let count = s
            .query(&handle.id, "SELECT count(*) FROM items", None, 1)
            .expect("count");
        assert_eq!(count.rows[0][0], SqliteCell::Integer { value: 1200 });
        let error = s
            .query(&handle.id, "SELECT 1; DELETE FROM items", None, 1)
            .expect_err("two");
        assert!(
            matches!(
                error.code,
                "sqlite_multiple_statements" | "sqlite_read_only"
            ),
            "{}",
            error.code
        );
    }

    #[test]
    fn runaway_queries_are_stopped() {
        let (_dir, path) = fixture();
        let (s, handle) = open(&path);
        let started = Instant::now();
        let error = s
            .query(
                &handle.id,
                "WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM r) SELECT count(*) FROM r",
                None,
                1,
            )
            .expect_err("interrupted");
        assert_eq!(error.code, "sqlite_timeout");
        assert!(started.elapsed() < Duration::from_secs(8));
    }

    #[test]
    fn writes_go_only_through_the_explicit_path() {
        let (_dir, path) = fixture();
        let (s, handle) = open(&path);
        let result = s
            .write(&handle.id, "UPDATE items SET price = 0 WHERE id <= 3")
            .expect("changed");
        assert_eq!(result.changes, 3);
        let zero = s
            .query(
                &handle.id,
                "SELECT count(*) FROM items WHERE price = 0",
                None,
                1,
            )
            .expect("read");
        assert_eq!(zero.rows[0][0], SqliteCell::Integer { value: 3 });
        for sql in [
            "VACUUM",
            "PRAGMA user_version = 3",
            "ATTACH 'x.db' AS x",
            "  -- c\n vacuum",
        ] {
            assert!(s.write(&handle.id, sql).is_err(), "{sql}");
        }
        assert_eq!(
            s.prepare_write(&handle.id, "SELECT 1")
                .expect_err("read statement is outside the approval catalog")
                .code,
            "sqlite_statement_refused"
        );
        assert_eq!(
            s.write(&handle.id, "SELECT 1").map_err(|e| e.code),
            Err("sqlite_not_a_change")
        );
    }

    #[test]
    fn multiply_linked_database_is_refused_at_read_open() {
        let (dir, path) = fixture();
        let protected_dir = dir.path().join("protected-data");
        std::fs::create_dir(&protected_dir).expect("protected fixture directory");
        let protected = protected_dir.join("owner.db");
        std::fs::rename(&path, &protected).expect("move fixture into protected directory");
        let outside_alias = dir.path().join("selected.db");
        std::fs::hard_link(&protected, &outside_alias).expect("outside hardlink fixture");

        let sessions = SqliteSessions::new();
        assert_eq!(
            sessions
                .open(&outside_alias, "selected.db".into(), None)
                .expect_err("multiply linked database must be refused")
                .code,
            "sqlite_link_refused"
        );
    }

    #[test]
    fn hardlink_added_after_open_is_refused_before_read_or_write_preparation() {
        let (dir, path) = fixture();
        let (sessions, handle) = open(&path);
        std::fs::hard_link(&path, dir.path().join("late-alias.db")).expect("late hardlink fixture");

        assert_eq!(
            sessions
                .query(&handle.id, "SELECT count(*) FROM items", None, 1)
                .expect_err("query must revalidate retained link count")
                .code,
            "sqlite_link_refused"
        );
        assert_eq!(
            sessions
                .prepare_write(&handle.id, "UPDATE items SET price = 0 WHERE id = 1")
                .expect_err("write preparation must revalidate retained link count")
                .code,
            "sqlite_link_refused"
        );
    }

    #[test]
    fn hardlink_added_after_write_preparation_is_refused_before_effect() {
        let (dir, path) = fixture();
        let (sessions, handle) = open(&path);
        let prepared = sessions
            .prepare_write(&handle.id, "UPDATE items SET price = 0 WHERE id = 1")
            .expect("sealed write");
        std::fs::hard_link(&path, dir.path().join("post-approval-alias.db"))
            .expect("post-approval hardlink fixture");

        assert_eq!(
            prepared
                .execute()
                .expect_err("effect must revalidate retained link count")
                .code,
            "sqlite_link_refused"
        );
        let check = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("read unchanged fixture");
        let price: f64 = check
            .query_row("SELECT price FROM items WHERE id = 1", [], |row| row.get(0))
            .expect("unchanged price");
        assert_eq!(price, 0.5);
    }

    #[test]
    fn prepared_write_retains_database_identity_until_consumed() {
        let (_dir, path) = fixture();
        let (sessions, handle) = open(&path);
        let prepared = sessions
            .prepare_write(&handle.id, "UPDATE items SET price = 0 WHERE id = 1")
            .expect("sealed write");
        assert_eq!(prepared.database_id(), handle.id);
        assert_eq!(prepared.database_name(), "shop.db");
        assert_eq!(prepared.operation(), UtilitySqliteOperation::Update);

        sessions.close(&handle.id).expect("close session map");
        let result = prepared.execute().expect("retained database remains exact");
        assert_eq!(result.changes, 1);
    }

    #[test]
    fn write_approval_catalog_refuses_untyped_or_read_statements() {
        let (_dir, path) = fixture();
        let (sessions, handle) = open(&path);
        for sql in [
            "SELECT 1",
            "WITH changed AS (SELECT 1) UPDATE items SET price = 0",
            "VACUUM",
            "ATTACH DATABASE 'other.db' AS other",
            "PRAGMA user_version = 2",
            "REINDEX",
            "ANALYZE",
        ] {
            assert_eq!(
                sessions
                    .prepare_write(&handle.id, sql)
                    .expect_err("outside fixed approval catalog")
                    .code,
                "sqlite_statement_refused",
                "{sql}"
            );
        }
    }

    #[test]
    fn non_databases_and_unknown_ids_are_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        let text = dir.path().join("notes.db");
        std::fs::write(&text, "hello world, not sqlite").expect("write");
        let s = SqliteSessions::new();
        assert_eq!(
            s.open(&text, "notes.db".into(), None).map_err(|e| e.code),
            Err("sqlite_not_a_database")
        );
        let empty = dir.path().join("empty.db");
        std::fs::write(&empty, "").expect("write");
        assert_eq!(
            s.open(&empty, "empty.db".into(), None).map_err(|e| e.code),
            Err("sqlite_empty")
        );
        assert!(s.query("not-an-id", "SELECT 1", None, 1).is_err());
        assert!(!dir.path().join("missing.db").exists());
        assert!(
            s.open(&dir.path().join("missing.db"), "m".into(), None)
                .is_err()
        );
        assert!(!dir.path().join("missing.db").exists(), "never created");
    }

    #[test]
    fn keywords_skip_comments() {
        assert_eq!(first_keyword("  /* x */ -- y\n vacuum into 'x'"), "VACUUM");
        assert_eq!(first_keyword("select 1"), "SELECT");
    }
}
