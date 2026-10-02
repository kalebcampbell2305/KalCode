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
pub const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "foundation",
        sql: include_str!("../migrations/0001_foundation.sql"),
    },
    Migration {
        version: 2,
        name: "workspaces",
        sql: include_str!("../migrations/0002_workspaces.sql"),
    },
    Migration {
        version: 3,
        name: "threads",
        sql: include_str!("../migrations/0003_threads.sql"),
    },
    Migration {
        version: 4,
        name: "permissions",
        sql: include_str!("../migrations/0004_permissions.sql"),
    },
    Migration {
        version: 5,
        name: "event_correlation",
        sql: include_str!("../migrations/0005_event_correlation.sql"),
    },
    // KalVoice (campaign Z12): the local KalVoice Request ledger and KalVoice preferences.
    // Owned by `crates/kalvoice`; registered after L-1's v5 at integration.
    Migration {
        version: 6,
        name: "kalvoice",
        sql: include_str!("../migrations/0006_kalvoice.sql"),
    },
    GIT_MIGRATION,
    CONTEXT_MIGRATION,
    WORKSPACE_UI_MIGRATION,
    NOTIFICATIONS_MIGRATION,
    RAIL_LOCATOR_MIGRATION,
    PROVIDER_ACCOUNTS_MIGRATION,
    KALVOICE_REQUEST_LIFECYCLE_MIGRATION,
    UTILITY_MIGRATION,
    TIME_MACHINE_MIGRATION,
    DOCTOR_MIGRATION,
    UTILITY_AUTHORITY_MIGRATION,
    CONTEXT_DELIVERY_MIGRATION,
    Migration {
        version: 19,
        name: "kalvoice_account_usage",
        sql: include_str!("../migrations/0019_kalvoice_account_usage.sql"),
    },
    OPERATIONS_MIGRATION,
    THREADS_EFFORT_MIGRATION,
];

/// Migration v7 (campaign Z6a): `git_worktrees` and `checkpoints`. Owned by `crates/git`, which
/// re-exports it as `kalcode_git::store::GIT_MIGRATION`; the SQL lives here because native-core
/// cannot depend on the owning crate.
pub const GIT_MIGRATION: Migration = Migration {
    version: 7,
    name: "git",
    sql: include_str!("../migrations/0007_git.sql"),
};

/// Migration v8 (CTX/FW): context packages, items, the firewall decision log and never-share
/// patterns. Owned by `crates/context`, which re-exports it as `kalcode_context::MIGRATION_V8`.
pub const CONTEXT_MIGRATION: Migration = Migration {
    version: 8,
    name: "context",
    sql: include_str!("../migrations/0008_context.sql"),
};

/// Migration v9 (Z7-W1): `workspace_layouts` and `layout_presets`, the pane layout store. Owned
/// by `crates/workspace-ui`, which re-exports it as `kalcode_workspace_ui::WORKSPACE_UI_MIGRATION`.
pub const WORKSPACE_UI_MIGRATION: Migration = Migration {
    version: 9,
    name: "workspace_ui",
    sql: include_str!("../migrations/0009_workspace_ui.sql"),
};

/// Migration v10 (Z7-W3): `notifications`, the notification center's store. Owned by
/// `crates/notifications`, which re-exports it as `kalcode_notifications::NOTIFICATIONS_MIGRATION`.
pub const NOTIFICATIONS_MIGRATION: Migration = Migration {
    version: 10,
    name: "notifications",
    sql: include_str!("../migrations/0010_notifications.sql"),
};

/// Migration v11 (Z7-W2): `workspace_groups`, `workspace_rail`, `locator_entries`, `locator_fts`
/// (the workspace rail and the Session Locator's index). Owned by `crates/locator`, which
/// re-exports it as `kalcode_locator::RAIL_LOCATOR_MIGRATION`.
pub const RAIL_LOCATOR_MIGRATION: Migration = Migration {
    version: 11,
    name: "rail_locator",
    sql: include_str!("../migrations/0011_rail_locator.sql"),
};

/// Migration v12: credential-free provider account metadata and scoped account bindings.
pub const PROVIDER_ACCOUNTS_MIGRATION: Migration = Migration {
    version: 12,
    name: "provider_accounts",
    sql: include_str!("../migrations/0012_provider_accounts.sql"),
};

/// Migration v13: durable lifecycle for the canonical KalVoice request/usage claim.
pub const KALVOICE_REQUEST_LIFECYCLE_MIGRATION: Migration = Migration {
    version: 13,
    name: "kalvoice_request_lifecycle",
    sql: include_str!("../migrations/0013_kalvoice_request_lifecycle.sql"),
};

/// Utility Dock persistence, owned by the canonical single-writer database.
pub const UTILITY_MIGRATION: Migration = Migration {
    version: 14,
    name: "utility_dock",
    sql: include_str!("../migrations/0014_utility_dock.sql"),
};

/// Durable, non-replayable Time Machine operation authority and recovery evidence.
pub const TIME_MACHINE_MIGRATION: Migration = Migration {
    version: 15,
    name: "time_machine",
    sql: include_str!("../migrations/0015_time_machine.sql"),
};

/// Environment Doctor history and one-time approval claims.
pub const DOCTOR_MIGRATION: Migration = Migration {
    version: 16,
    name: "doctor",
    sql: include_str!("../migrations/0016_doctor.sql"),
};

/// Durable at-most-once claims for account-bound sealed Utility effects.
pub const UTILITY_AUTHORITY_MIGRATION: Migration = Migration {
    version: 17,
    name: "utility_authority",
    sql: include_str!("../migrations/0017_utility_authority.sql"),
};

/// Durable, one-shot Context Drop delivery authority and interrupted-send recovery evidence.
/// Owned by `crates/context`, which re-exports this typed migration.
pub const CONTEXT_DELIVERY_MIGRATION: Migration = Migration {
    version: 18,
    name: "context_delivery",
    sql: include_str!("../migrations/0018_context_delivery.sql"),
};

/// Canonical Operations queue/run identity, scheduler state and transition timeline.
pub const OPERATIONS_MIGRATION: Migration = Migration {
    version: 20,
    name: "operations",
    sql: include_str!("../migrations/0020_operations.sql"),
};

/// Durable provider-native reasoning effort for thread launch and restart.
pub const THREADS_EFFORT_MIGRATION: Migration = Migration {
    version: 21,
    name: "threads_effort",
    sql: include_str!("../migrations/0021_threads_effort.sql"),
};

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
            KalError::new(
                ErrorCategory::Filesystem,
                "data_dir_unavailable",
                "KalCode couldn't create its data folder.",
            )
            .with_source(e)
        })?;
    }
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    configure(&conn)?;
    Ok(conn)
}

/// Opens an existing database read-only, for background readers next to the single writer.
/// With WAL, readers never block the writer and see only committed transactions. `query_only`
/// makes any write attempt fail even if the file permissions would allow it.
pub fn open_read_only(path: &Path) -> Result<Connection> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.pragma_update(None, "query_only", "ON")?;
    Ok(conn)
}

/// In-memory database with the same configuration (tests).
pub fn open_in_memory() -> Result<Connection> {
    let conn = Connection::open_in_memory()?;
    configure(&conn)?;
    Ok(conn)
}

fn configure(conn: &Connection) -> Result<()> {
    // Connection-scoped settings only. The persistent journal mode is switched to WAL by
    // `enable_wal` after migrations succeed, so a database this build refuses stays untouched.
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    let fk: i64 = conn.pragma_query_value(None, "foreign_keys", |row| row.get(0))?;
    if fk != 1 {
        return Err(KalError::new(
            ErrorCategory::Database,
            "foreign_keys_unavailable",
            "KalCode's database engine is misconfigured.",
        ));
    }
    Ok(())
}

/// Switches the database to write-ahead logging (a persistent setting).
pub fn enable_wal(conn: &Connection) -> Result<()> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    Ok(())
}

pub fn checksum(sql: &str) -> String {
    let digest = Sha256::digest(sql.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Current schema version (0 for a fresh database).
pub fn schema_version(conn: &Connection) -> Result<i64> {
    ensure_migrations_table(conn)?;
    Ok(conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |row| row.get(0),
    )?)
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

/// Whether opening the database at `path` would apply any of `migrations`: true for a missing
/// database or an older schema. Read-only, so it never creates or changes the file. Every
/// migration is forward-only (an older build refuses a newer schema), so callers use this to
/// protect update recovery before [`migrate`] runs.
pub fn has_pending_migrations(path: &Path, migrations: &[Migration]) -> Result<bool> {
    if !path.exists() {
        return Ok(true);
    }
    let conn = open_read_only(path)?;
    let tracked: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations')",
        [],
        |row| row.get(0),
    )?;
    let current: i64 = if tracked {
        conn.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )?
    } else {
        0
    };
    Ok(current < migrations.last().map_or(0, |m| m.version))
}

/// Applies pending `migrations`. `backup_dir` receives a copy of an existing database first.
pub fn migrate(
    conn: &mut Connection,
    migrations: &[Migration],
    backup_dir: Option<&Path>,
) -> Result<MigrationOutcome> {
    validate_sequence(migrations)?;
    ensure_migrations_table(conn)?;

    let applied: Vec<(i64, String)> = {
        let mut stmt =
            conn.prepare("SELECT version, checksum FROM schema_migrations ORDER BY version")?;
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

    let pending: Vec<&Migration> = migrations
        .iter()
        .filter(|m| m.version > from_version)
        .collect();
    if pending.is_empty() {
        return Ok(MigrationOutcome {
            from_version,
            to_version: from_version,
            backup: None,
        });
    }

    let backup = match (from_version > 0, backup_dir) {
        (true, Some(dir)) => Some(backup_database(conn, dir, pending[0].version)?),
        _ => None,
    };

    for migration in pending {
        let tx = conn.transaction()?;
        tx.execute_batch(migration.sql)
            .map_err(|e| migration_failed(migration, e))?;
        tx.execute(
            "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?1, ?2, ?3, ?4)",
            params![migration.version, migration.name, checksum(migration.sql), now_rfc3339()],
        )
        .map_err(|e| migration_failed(migration, e))?;
        tx.commit().map_err(|e| migration_failed(migration, e))?;
        tracing::info!(
            event = "database.migration_applied",
            version = migration.version,
            name = migration.name
        );
    }

    Ok(MigrationOutcome {
        from_version,
        to_version: latest_known,
        backup,
    })
}

fn migration_failed(migration: &Migration, error: rusqlite::Error) -> KalError {
    KalError::new(
        ErrorCategory::Database,
        "migration_failed",
        format!(
            "KalCode couldn't upgrade its database (step {}). Your data was left unchanged.",
            migration.version
        ),
    )
    .with_source(error)
}

fn validate_sequence(migrations: &[Migration]) -> Result<()> {
    for (index, migration) in migrations.iter().enumerate() {
        let expected = i64::try_from(index).unwrap_or(i64::MAX).saturating_add(1);
        if migration.version != expected {
            return Err(KalError::internal(
                "migration_sequence_invalid",
                "KalCode's database migrations are misnumbered.",
            ));
        }
    }
    Ok(())
}

fn backup_failed(source: impl Into<Box<dyn std::error::Error + Send + Sync>>) -> KalError {
    KalError::new(
        ErrorCategory::Filesystem,
        "backup_failed",
        "KalCode couldn't back up its database before upgrading, so it didn't upgrade.",
    )
    .with_source(source)
}

/// Writes a consistent copy to `<name>.partial` and renames it into place only when complete,
/// so an interrupted backup never looks like a valid one. Pruning old backups is best-effort:
/// failing to delete an old copy must not block an upgrade that already has a fresh backup.
fn backup_database(conn: &Connection, dir: &Path, next_version: i64) -> Result<PathBuf> {
    fs::create_dir_all(dir).map_err(backup_failed)?;
    let stamp = now_rfc3339().replace([':', '.'], "-");
    let path = dir.join(format!("kalcode-pre-v{next_version}-{stamp}.db"));
    let partial = path.with_extension("db.partial");

    let written = (|| -> std::result::Result<(), rusqlite::Error> {
        let mut target = Connection::open(&partial)?;
        let backup = rusqlite::backup::Backup::new(conn, &mut target)?;
        backup.run_to_completion(256, Duration::from_millis(0), None)?;
        Ok(())
    })();
    if let Err(error) = written {
        let _ = fs::remove_file(&partial);
        return Err(backup_failed(error));
    }
    if let Err(error) = fs::rename(&partial, &path) {
        let _ = fs::remove_file(&partial);
        return Err(backup_failed(error));
    }
    if let Err(error) = prune_backups(dir) {
        tracing::warn!(event = "database.backup_prune_failed", error = %error);
    }
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
    // Try every file; report the first failure after attempting the rest.
    let mut first_error = None;
    for old in backups.into_iter().take(excess) {
        if let Err(error) = fs::remove_file(old) {
            first_error.get_or_insert(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

/// Reads a value from `app_meta`.
pub fn meta_get(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM app_meta WHERE key = ?1", [key], |row| {
            row.get(0)
        })
        .optional()?)
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
        assert_eq!(
            schema_version(&conn).expect("version"),
            MIGRATIONS.len() as i64
        );
    }

    #[test]
    fn pending_migrations_are_detected_without_changing_the_database() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("kalcode.db");
        assert!(has_pending_migrations(&path, MIGRATIONS).expect("missing"));
        assert!(!path.exists());

        let mut conn = open(&path).expect("open");
        migrate(&mut conn, &MIGRATIONS[..MIGRATIONS.len() - 1], None).expect("older schema");
        assert!(has_pending_migrations(&path, MIGRATIONS).expect("older"));
        assert!(!has_pending_migrations(&path, &MIGRATIONS[..MIGRATIONS.len() - 1]).expect("same"));
        assert_eq!(
            schema_version(&conn).expect("version"),
            MIGRATIONS.len() as i64 - 1
        );

        migrate(&mut conn, MIGRATIONS, None).expect("latest");
        assert!(!has_pending_migrations(&path, MIGRATIONS).expect("latest"));
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
        let bad = [Migration {
            version: 2,
            name: "skip",
            sql: "SELECT 1;",
        }];
        let err = migrate(&mut conn, &bad, None).expect_err("must fail");
        assert_eq!(err.code, "migration_sequence_invalid");
    }

    #[test]
    fn failing_migration_rolls_back() {
        let mut conn = open_in_memory().expect("open");
        let bad = [
            MIGRATIONS[0],
            Migration {
                version: 2,
                name: "broken",
                sql: "CREATE TABLE ok_table (x INTEGER); THIS IS NOT SQL;",
            },
        ];
        let err = migrate(&mut conn, &bad, None).expect_err("must fail");
        assert_eq!(err.code, "migration_failed");
        assert_eq!(schema_version(&conn).expect("version"), 1);
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name = 'ok_table'",
                [],
                |r| r.get(0),
            )
            .expect("query");
        assert_eq!(exists, 0, "partial migration must be rolled back");
    }

    #[test]
    fn prune_keeps_the_newest_backups_and_ignores_partials() {
        use std::time::{Duration as StdDuration, SystemTime};
        let dir = tempfile::tempdir().expect("tempdir");
        let base = SystemTime::now() - StdDuration::from_secs(3600);
        for i in 0..7u64 {
            let path = dir.path().join(format!("kalcode-pre-v2-{i}.db"));
            let file = fs::File::create(&path).expect("create");
            file.set_modified(base + StdDuration::from_secs(i * 60))
                .expect("mtime");
        }
        fs::write(dir.path().join("kalcode-pre-v2-9.db.partial"), b"x").expect("partial");
        fs::write(dir.path().join("unrelated.db"), b"x").expect("unrelated");

        prune_backups(dir.path()).expect("prune");

        let mut remaining: Vec<String> = fs::read_dir(dir.path())
            .expect("read")
            .filter_map(|e| e.ok().and_then(|e| e.file_name().into_string().ok()))
            .collect();
        remaining.sort();
        assert_eq!(
            remaining,
            vec![
                "kalcode-pre-v2-2.db",
                "kalcode-pre-v2-3.db",
                "kalcode-pre-v2-4.db",
                "kalcode-pre-v2-5.db",
                "kalcode-pre-v2-6.db",
                "kalcode-pre-v2-9.db.partial",
                "unrelated.db",
            ]
        );
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
