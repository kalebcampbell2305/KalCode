//! Migration 0006 (KalVoice) upgrade test and `Core::transact` semantics.

use std::sync::{Arc, Mutex};

use kalcode_core::db::{self, MIGRATIONS};
use kalcode_core::events::{EventPayload, NewEvent};
use kalcode_core::flags::BuildChannel;
use kalcode_core::settings::{SettingsPatch, ThemePreference};
use kalcode_core::{Core, CoreConfig, KalError, Paths};

fn config(dir: &std::path::Path) -> CoreConfig {
    CoreConfig {
        paths: Paths::new(dir),
        app_version: "0.1.0-test".into(),
        channel: BuildChannel::Development,
    }
}

fn table_exists(conn: &rusqlite::Connection, name: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [name],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n == 1)
}

#[test]
fn upgrade_from_foundation_adds_kalvoice_tables_and_keeps_data() {
    let dir = tempfile::tempdir().expect("tempdir");
    {
        let core = Core::open_with_migrations(config(dir.path()), &MIGRATIONS[..1]).expect("v1");
        core.update_settings(&SettingsPatch {
            theme: Some(ThemePreference::Light),
            ..Default::default()
        })
        .expect("settings");
        core.shutdown();
    }

    let core = Core::open(config(dir.path())).expect("upgrade");
    assert_eq!(
        core.settings().expect("settings").theme,
        ThemePreference::Light
    );
    core.read(|conn| {
        assert!(table_exists(conn, "kalvoice_requests")?);
        assert!(table_exists(conn, "kalvoice_preferences")?);
        assert_eq!(db::schema_version(conn)?, 6);
        Ok(())
    })
    .expect("read");
    let backups = std::fs::read_dir(dir.path().join("backups"))
        .expect("backups")
        .count();
    assert_eq!(
        backups, 1,
        "an existing database is backed up before upgrading"
    );
    let migrated = core
        .recent_events(20, None)
        .expect("events")
        .into_iter()
        .any(|e| {
            matches!(
                e.event,
                EventPayload::DatabaseMigrated {
                    from_version: 1,
                    to_version: 6,
                    backup_created: true
                }
            )
        });
    assert!(migrated);
}

#[test]
fn kalvoice_tables_reject_invalid_rows() {
    let dir = tempfile::tempdir().expect("tempdir");
    let core = Core::open(config(dir.path())).expect("open");
    core.read(|conn| {
        let bad_input = conn.execute(
            "INSERT INTO kalvoice_requests (request_id, period_start, recorded_at, input, intent)
             VALUES ('a', 'p', 'r', 'telepathy', 'navigate')",
            [],
        );
        assert!(bad_input.is_err());
        let bad_json = conn.execute(
            "INSERT INTO kalvoice_preferences (key, value, updated_at) VALUES ('k', 'not json', 'x')",
            [],
        );
        assert!(bad_json.is_err());
        Ok(())
    })
    .expect("read");
}

#[test]
fn transact_commits_state_and_events_together_then_publishes() {
    let dir = tempfile::tempdir().expect("tempdir");
    let core = Core::open(config(dir.path())).expect("open");
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    core.subscribe(move |e| {
        sink.lock().expect("lock").push(e.event.type_name());
        true
    });

    let (value, envelopes) = core
        .transact(|tx| {
            tx.execute(
                "INSERT INTO kalvoice_preferences (key, value, updated_at) VALUES ('k', '1', 'x')",
                [],
            )?;
            Ok((
                7,
                vec![NewEvent::core(EventPayload::SettingsChanged {
                    keys: vec!["kalvoice.k".into()],
                })],
            ))
        })
        .expect("transact");
    assert_eq!(value, 7);
    assert_eq!(envelopes.len(), 1);
    assert_eq!(*seen.lock().expect("lock"), vec!["settings.changed"]);

    // A failure rolls back both the state change and its events, and publishes nothing.
    let failed = core.transact::<()>(|tx| {
        tx.execute(
            "INSERT INTO kalvoice_preferences (key, value, updated_at) VALUES ('k2', '2', 'x')",
            [],
        )?;
        Err(KalError::internal("test_failure", "stop"))
    });
    assert!(failed.is_err());
    let exists: i64 = core
        .read(|c| {
            Ok(c.query_row(
                "SELECT COUNT(*) FROM kalvoice_preferences WHERE key = 'k2'",
                [],
                |r| r.get(0),
            )?)
        })
        .expect("read");
    assert_eq!(exists, 0);
    assert_eq!(seen.lock().expect("lock").len(), 1);
}
