//! SQLite persistence: connection setup and the migration runner.
//!
//! Migrations are embedded, numbered, checksummed and applied one transaction each. Existing
//! databases are backed up before migrating. A database newer than this build, or an applied
//! migration whose SQL has changed, is refused rather than "repaired".

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use sha2::{Digest, Sha256};

use crate::error::{ErrorCategory, KalError, Result};
use crate::time::now_rfc3339;

#[derive(Debug, Clone, Copy)]
pub struct Migration {
    pub version: i64,
    pub name: &'static str,
    pub sql: &'static str,
}

/// All migrations shipped with this build, in order.
pub const MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    name: "foundation",
    sql: include_str!("../migrations/0001_foundation.sql"),
}];

/// How many pre-migration backups to keep.
const BACKUPS_RETAINED: usize = 5;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationOutcome {
    pub from_version: i64,
    pub to_version: i64,
    pub backup: Option<PathBuf>,
}

impl MigrationOutcome {
    pub fn applied_any(&self) -> bool {
        self.to_version > self.from_version
    }
}

/// Opens (creating if needed) the database file with KalCode's standard pragmas.
pub fn open(path: &Path) -> Result<Connection> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            KalError::new(ErrorCategory::Filesystem, "data_dir_unavailable", "KalCode couldn't create its data folder.")
                .with_source(e)
        })?;
    }
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    configure(&conn)?;
    Ok(conn)
}

/// In-memory database with the same configuration (tests).
pub fn open_in_memory() -> Result<Connection> {
    let conn = Connection::open_in_memory()?;
    configure(&conn)?;
    Ok(conn)
}

fn configure(conn: &Connection) -> Result<()> {
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    let fk: i64 = conn.pragma_query_value(None, "foreign_keys", |row| row.get(0))?;
    if fk != 1 {
        return Err(KalError::new(ErrorCategory::Database, "foreign_keys_unavailable", "KalCode's database engine is misconfigured."));
    }
    Ok(())
}

pub fn checksum(sql: &str) -> String {
    let digest = Sha256::digest(sql.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Current schema version (0 for a fresh database).
pub fn schema_version(conn: &Connection) -> Result<i64> {
    ensure_migrations_table(conn)?;
    Ok(conn.query_row("SELECT COALESCE(MAX(version), 0) FROM schema_migrations", [], |row| row.get(0))?)
}

fn ensure_migrations_table(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version    INTEGER PRIMARY KEY NOT NULL,
            name       TEXT NOT NULL,
            checksum   TEXT NOT NULL,
            applied_at TEXT NOT NULL
        ) STRICT;",
    )?;
    Ok(())
}

/// Applies pending `migrations`. `backup_dir` receives a copy of an existing database first.
pub fn migrate(conn: &mut Connection, migrations: &[Migration], backup_dir: Option<&Path>) -> Result<MigrationOutcome> {
    validate_sequence(migrations)?;
    ensure_migrations_table(conn)?;

    let applied: Vec<(i64, String)> = {
        let mut stmt = conn.prepare("SELECT version, checksum FROM schema_migrations ORDER BY version")?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect::<std::result::Result<_, _>>()?
    };
    let from_version = applied.last().map_or(0, |(v, _)| *v);
    let latest_known = migrations.last().map_or(0, |m| m.version);

    if from_version > latest_known {
        return Err(KalError::new(
            ErrorCategory::Database,
            "schema_too_new",
            "Your KalCode data was created by a newer version of KalCode. Update KalCode to open it — your data has not been changed.",
        ));
    }

    for (version, stored) in &applied {
        let known = migrations.iter().find(|m| m.version == *version).ok_or_else(|| {
            KalError::new(ErrorCategory::Database, "migration_unknown", "KalCode found an unrecognized database change and stopped to protect your data.")
        })?;
        if &checksum(known.sql) != stored {
            return Err(KalError::new(
                ErrorCategory::Database,
                "migration_checksum_mismatch",
                "KalCode's database history doesn't match this build. KalCode stopped to protect your data.",
            ));
        }
    }

    let pending: Vec<&Migration> = migrations.iter().filter(|m| m.version > from_version).collect();
    if pending.is_empty() {
        return Ok(MigrationOutcome { from_version, to_version: from_version, backup: None });
    }

    let backup = match (from_version > 0, backup_dir) {
        (true, Some(dir)) => Some(backup_database(conn, dir, pending[0].version)?),
        _ => None,
    };

    for migration in pending {
        let tx = conn.transaction()?;
        tx.execute_batch(migration.sql).map_err(|e| migration_failed(migration, e))?;
        tx.execute(
            "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?1, ?2, ?3, ?4)",
            params![migration.version, migration.name, checksum(migration.sql), now_rfc3339()],
        )
        .map_err(|e| migration_failed(migration, e))?;
        tx.commit().map_err(|e| migration_failed(migration, e))?;
        tracing::info!(event = "database.migration_applied", version = migration.version, name = migration.name);
    }

    Ok(MigrationOutcome { from_version, to_version: latest_known, backup })
}

fn migration_failed(migration: &Migration, error: rusqlite::Error) -> KalError {
    KalError::new(
        ErrorCategory::Database,
        "migration_failed",
        format!("KalCode couldn't upgrade its database (step {}). Your data was left unchanged.", migration.version),
    )
    .with_source(error)
}

fn validate_sequence(migrations: &[Migration]) -> Result<()> {
    for (index, migration) in migrations.iter().enumerate() {
        let expected = i64::try_from(index).unwrap_or(i64::MAX).saturating_add(1);
        if migration.version != expected {
            return Err(KalError::internal("migration_sequence_invalid", "KalCode's database migrations are misnumbered."));
        }
    }
    Ok(())
}

fn backup_database(conn: &Connection, dir: &Path, next_version: i64) -> Result<PathBuf> {
    let fs_err = |e: std::io::Error| {
        KalError::new(ErrorCategory::Filesystem, "backup_failed", "KalCode couldn't back up its database before upgrading, so it didn't upgrade.")
            .with_source(e)
    };
    fs::create_dir_all(dir).map_err(fs_err)?;
    let stamp = now_rfc3339().replace([':', '.'], "-");
    let path = dir.join(format!("kalcode-pre-v{next_version}-{stamp}.db"));
    let mut target = Connection::open(&path)?;
    {
        let backup = rusqlite::backup::Backup::new(conn, &mut target)?;
        backup.run_to_completion(256, Duration::from_millis(0), None)?;
    }
    drop(target);
    prune_backups(dir).map_err(fs_err)?;
    tracing::info!(event = "database.backup_created", next_version);
    Ok(path)
}

fn prune_backups(dir: &Path) -> std::io::Result<()> {
    let mut backups: Vec<PathBuf> = fs::read_dir(dir)?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("kalcode-pre-v") && n.ends_with(".db"))
        })
        .collect();
    // Names embed an RFC 3339 timestamp, so lexical order is chronological within a version;
    // sort by modification time to be robust across versions.
    backups.sort_by_key(|p| fs::metadata(p).and_then(|m| m.modified()).ok());
    let excess = backups.len().saturating_sub(BACKUPS_RETAINED);
    for old in backups.into_iter().take(excess) {
        fs::remove_file(old)?;
    }
    Ok(())
}

/// Reads a value from `app_meta`.
pub fn meta_get(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn.query_row("SELECT value FROM app_meta WHERE key = ?1", [key], |row| row.get(0)).optional()?)
}

/// Writes a value to `app_meta`.
pub fn meta_set(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO app_meta (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, value, now_rfc3339()],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_database_migrates_to_latest() {
        let mut conn = open_in_memory().expect("open");
        let outcome = migrate(&mut conn, MIGRATIONS, None).expect("migrate");
        assert_eq!(outcome.from_version, 0);
        assert_eq!(outcome.to_version, MIGRATIONS.len() as i64);
        assert!(outcome.backup.is_none());
        assert_eq!(schema_version(&conn).expect("version"), MIGRATIONS.len() as i64);
    }

    #[test]
    fn migrate_is_idempotent() {
        let mut conn = open_in_memory().expect("open");
        migrate(&mut conn, MIGRATIONS, None).expect("first");
        let second = migrate(&mut conn, MIGRATIONS, None).expect("second");
        assert!(!second.applied_any());
    }

    #[test]
    fn misnumbered_migrations_are_rejected() {
        let mut conn = open_in_memory().expect("open");
        let bad = [Migration { version: 2, name: "skip", sql: "SELECT 1;" }];
        let err = migrate(&mut conn, &bad, None).expect_err("must fail");
        assert_eq!(err.code, "migration_sequence_invalid");
    }

    #[test]
    fn failing_migration_rolls_back() {
        let mut conn = open_in_memory().expect("open");
        let bad = [
            MIGRATIONS[0],
            Migration { version: 2, name: "broken", sql: "CREATE TABLE ok_table (x INTEGER); THIS IS NOT SQL;" },
        ];
        let err = migrate(&mut conn, &bad, None).expect_err("must fail");
        assert_eq!(err.code, "migration_failed");
        assert_eq!(schema_version(&conn).expect("version"), 1);
        let exists: i64 = conn
            .query_row("SELECT COUNT(*) FROM sqlite_master WHERE name = 'ok_table'", [], |r| r.get(0))
            .expect("query");
        assert_eq!(exists, 0, "partial migration must be rolled back");
    }

    #[test]
    fn meta_round_trip() {
        let mut conn = open_in_memory().expect("open");
        migrate(&mut conn, MIGRATIONS, None).expect("migrate");
        assert_eq!(meta_get(&conn, "k").expect("get"), None);
        meta_set(&conn, "k", "v1").expect("set");
        meta_set(&conn, "k", "v2").expect("overwrite");
        assert_eq!(meta_get(&conn, "k").expect("get").as_deref(), Some("v2"));
    }
}
