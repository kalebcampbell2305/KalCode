//! Integration tests: database upgrades with real data, refusal paths, and restart persistence.

use kalcode_core::db::{self, MIGRATIONS, Migration};
use kalcode_core::events::EventPayload;
use kalcode_core::flags::BuildChannel;
use kalcode_core::settings::{Density, SettingsPatch, ThemePreference};
use kalcode_core::{Core, CoreConfig, Paths};

fn config(dir: &std::path::Path) -> CoreConfig {
    CoreConfig {
        paths: Paths::new(dir),
        app_version: "0.1.0-test".into(),
        channel: BuildChannel::Development,
    }
}

/// Version of a hypothetical migration after every migration this build ships.
fn next_version() -> i64 {
    MIGRATIONS.len() as i64 + 1
}

/// This build's migrations plus a hypothetical next one, to exercise the upgrade path end to
/// end independently of how many migrations exist.
fn v1_plus_v2() -> Vec<Migration> {
    let mut all = MIGRATIONS.to_vec();
    all.push(Migration {
        version: next_version(),
        name: "test_next",
        sql: "CREATE TABLE test_next (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL) STRICT;
              ALTER TABLE events ADD COLUMN test_marker TEXT;",
    });
    all
}

#[test]
fn settings_and_history_persist_across_restart() {
    let dir = tempfile::tempdir().expect("tempdir");
    {
        let core = Core::open(config(dir.path())).expect("first open");
        core.update_settings(&SettingsPatch {
            theme: Some(ThemePreference::Light),
            density: Some(Density::Compact),
            ..Default::default()
        })
        .expect("update");
        core.shutdown();
    }
    let core = Core::open(config(dir.path())).expect("second open");
    let settings = core.settings().expect("settings");
    assert_eq!(settings.theme, ThemePreference::Light);
    assert_eq!(settings.density, Density::Compact);

    let types: Vec<&str> = core
        .recent_events(50, None)
        .expect("events")
        .iter()
        .rev()
        .map(|e| e.event.type_name())
        .collect();
    assert_eq!(
        types,
        vec![
            "database.migrated",
            "app.started",
            "settings.changed",
            "app.stopped",
            "app.started"
        ],
        "full lifecycle history is persisted in order"
    );
}

#[test]
fn unclean_exit_is_detected_on_next_start() {
    let dir = tempfile::tempdir().expect("tempdir");
    // Simulate a crash: open without calling shutdown().
    drop(Core::open(config(dir.path())).expect("first open"));
    let core = Core::open(config(dir.path())).expect("second open");
    let types: Vec<&str> = core
        .recent_events(10, None)
        .expect("events")
        .iter()
        .map(|e| e.event.type_name())
        .collect();
    assert_eq!(
        &types[..2],
        &["app.started", "app.previous_session_interrupted"]
    );

    // A clean shutdown is not reported as interrupted.
    core.shutdown();
    drop(core);
    let core = Core::open(config(dir.path())).expect("third open");
    let latest: Vec<&str> = core
        .recent_events(2, None)
        .expect("events")
        .iter()
        .map(|e| e.event.type_name())
        .collect();
    assert_eq!(latest, vec!["app.started", "app.stopped"]);
}

#[test]
fn upgrade_from_v1_keeps_data_and_writes_backup() {
    let dir = tempfile::tempdir().expect("tempdir");
    {
        let core =
            Core::open_with_migrations(config(dir.path()), &MIGRATIONS[..1]).expect("v1 open");
        core.update_settings(&SettingsPatch {
            theme: Some(ThemePreference::Dark),
            ..Default::default()
        })
        .expect("update");
        core.shutdown();
    }

    let migrations = v1_plus_v2();
    let core = Core::open_with_migrations(config(dir.path()), &migrations).expect("v2 open");

    // Data intact.
    assert_eq!(
        core.settings().expect("settings").theme,
        ThemePreference::Dark
    );
    let events = core.recent_events(50, None).expect("events");
    assert!(
        events
            .iter()
            .any(|e| e.event.type_name() == "settings.changed")
    );

    // Migration recorded as an event with a backup.
    let migrated = events
        .iter()
        .find_map(|e| match e.event {
            EventPayload::DatabaseMigrated {
                from_version: 1,
                to_version,
                backup_created,
            } if to_version == next_version() => Some(backup_created),
            _ => None,
        })
        .expect("database.migrated 1 -> next");
    assert!(migrated);

    // Backup file exists and is a valid v1 database with the pre-upgrade data.
    let backups: Vec<_> = std::fs::read_dir(dir.path().join("backups"))
        .expect("backups dir")
        .filter_map(|e| e.ok())
        .collect();
    assert_eq!(backups.len(), 1);
    let backup = rusqlite::Connection::open(backups[0].path()).expect("open backup");
    assert_eq!(db::schema_version(&backup).expect("backup version"), 1);
    let theme: String = backup
        .query_row(
            "SELECT value FROM settings WHERE key = 'appearance.theme'",
            [],
            |r| r.get(0),
        )
        .expect("backup has settings");
    assert_eq!(theme, "\"dark\"");

    let diagnostics = core.diagnostics().expect("diagnostics");
    assert_eq!(diagnostics.database.schema_version, next_version());
    assert_eq!(diagnostics.database.journal_mode.to_lowercase(), "wal");
}

#[test]
fn newer_schema_is_refused_without_changes() {
    let dir = tempfile::tempdir().expect("tempdir");
    let migrations = v1_plus_v2();
    Core::open_with_migrations(config(dir.path()), &migrations)
        .expect("open with v2")
        .shutdown();

    let err = match Core::open(config(dir.path())) {
        Ok(_) => panic!("an older build must refuse a newer database"),
        Err(err) => err,
    };
    assert_eq!(err.code, "schema_too_new");

    let conn = rusqlite::Connection::open(dir.path().join("kalcode.db")).expect("reopen");
    assert_eq!(
        db::schema_version(&conn).expect("version"),
        next_version(),
        "database untouched"
    );
}

#[test]
fn edited_migration_is_detected() {
    let dir = tempfile::tempdir().expect("tempdir");
    Core::open(config(dir.path())).expect("open").shutdown();

    let mut tampered = MIGRATIONS.to_vec();
    tampered[0] = Migration {
        sql: "CREATE TABLE something_else (x INTEGER);",
        ..MIGRATIONS[0]
    };
    let err = match Core::open_with_migrations(config(dir.path()), &tampered) {
        Ok(_) => panic!("checksum mismatch must be refused"),
        Err(err) => err,
    };
    assert_eq!(err.code, "migration_checksum_mismatch");
}

#[test]
fn live_subscribers_receive_events_in_order() {
    use std::sync::{Arc, Mutex};

    let dir = tempfile::tempdir().expect("tempdir");
    let core = Arc::new(Core::open(config(dir.path())).expect("open"));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    core.subscribe(move |e| {
        sink.lock().expect("lock").push(e.seq);
        true
    });

    let threads: Vec<_> = (0..8)
        .map(|i| {
            let core = core.clone();
            std::thread::spawn(move || {
                let theme = if i % 2 == 0 {
                    ThemePreference::Dark
                } else {
                    ThemePreference::Light
                };
                let _ = core.update_settings(&SettingsPatch {
                    theme: Some(theme),
                    ..Default::default()
                });
                core.record_secure_store_check(true, "test")
                    .expect("record");
            })
        })
        .collect();
    for t in threads {
        t.join().expect("join");
    }

    let seen = seen.lock().expect("lock").clone();
    assert!(seen.len() >= 8);
    assert!(
        seen.windows(2).all(|w| w[0] < w[1]),
        "published strictly in seq order: {seen:?}"
    );
}

#[test]
fn diagnostics_are_sanitized() {
    let dir = tempfile::tempdir().expect("tempdir");
    let core = Core::open(config(dir.path())).expect("open");
    core.record_secure_store_check(true, "Windows Credential Manager")
        .expect("record");
    let diagnostics = core.diagnostics().expect("diagnostics");
    assert_eq!(diagnostics.secure_store.last_check_ok, Some(true));
    assert_eq!(
        diagnostics.secure_store.backend.as_deref(),
        Some("Windows Credential Manager")
    );
    assert!(diagnostics.database.event_count >= 3);
    let json = serde_json::to_string(&diagnostics).expect("json");
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        let home = home.to_string_lossy().replace('\\', "\\\\");
        if dir
            .path()
            .starts_with(std::path::Path::new(&*home.replace("\\\\", "\\")))
        {
            assert!(
                !json.contains(&home),
                "home directory must not appear in diagnostics"
            );
        }
    }
}

#[test]
fn a_data_folder_can_only_be_opened_once() {
    let dir = tempfile::tempdir().expect("tempdir");
    let first = Core::open(config(dir.path())).expect("first open");
    let err = match Core::open(config(dir.path())) {
        Ok(_) => panic!("a second core on the same data folder must be refused"),
        Err(err) => err,
    };
    assert_eq!(err.code, "already_running");
    first.shutdown();
    drop(first);
    Core::open(config(dir.path())).expect("reopen after the first core closed");
}

#[test]
fn settings_change_and_its_event_commit_atomically() {
    let dir = tempfile::tempdir().expect("tempdir");
    let core = Core::open(config(dir.path())).expect("open");

    // Make every event insert fail, simulating a write error after the settings row is written.
    let other =
        rusqlite::Connection::open(dir.path().join("kalcode.db")).expect("second connection");
    other
        .execute_batch(
            "CREATE TRIGGER reject_events BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
        )
        .expect("trigger");

    let result = core.update_settings(&SettingsPatch {
        theme: Some(ThemePreference::Light),
        ..Default::default()
    });
    assert!(
        result.is_err(),
        "the update must fail when its event cannot be recorded"
    );
    assert_eq!(
        core.settings().expect("settings").theme,
        ThemePreference::System,
        "the settings write must roll back with the failed event"
    );

    other
        .execute_batch("DROP TRIGGER reject_events;")
        .expect("drop trigger");
    core.update_settings(&SettingsPatch {
        theme: Some(ThemePreference::Light),
        ..Default::default()
    })
    .expect("succeeds once events can be written");
    assert_eq!(
        core.settings().expect("settings").theme,
        ThemePreference::Light
    );
}

#[test]
fn refused_newer_database_keeps_its_journal_mode() {
    let dir = tempfile::tempdir().expect("tempdir");
    {
        let conn = rusqlite::Connection::open(dir.path().join("kalcode.db")).expect("create");
        conn.execute_batch(
            "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;
             INSERT INTO schema_migrations VALUES (99, 'future', 'x', '2030-01-01T00:00:00.000Z');",
        )
        .expect("future schema");
    }
    let err = match Core::open(config(dir.path())) {
        Ok(_) => panic!("must refuse"),
        Err(err) => err,
    };
    assert_eq!(err.code, "schema_too_new");
    let conn = rusqlite::Connection::open(dir.path().join("kalcode.db")).expect("reopen");
    let mode: String = conn
        .pragma_query_value(None, "journal_mode", |r| r.get(0))
        .expect("mode");
    assert_eq!(
        mode.to_lowercase(),
        "delete",
        "a refused database is not switched to WAL"
    );
}
