//! KalVoice's schema v6 (registered in `kalcode_core::db::MIGRATIONS` after the event
//! platform's v5): upgrades from v4 (the released 0.1.x schema) and from v5 (what the next
//! update leaves) keep every row, back up the untouched old database, and add KalVoice's tables;
//! the tables refuse bad rows; state and events commit together.

use std::sync::{Arc, Mutex};

use kalcode_core::db::{self, MIGRATIONS, Migration};
use kalcode_core::events::{Correlation, EventPayload, NewEvent};
use kalcode_core::flags::BuildChannel;
use kalcode_core::settings::{SettingsPatch, ThemePreference};
use kalcode_core::{Core, CoreConfig, KalError, Paths};
use kalcode_kalvoice::schema::{self, KALVOICE_SCHEMA_VERSION};

fn config(dir: &std::path::Path) -> CoreConfig {
    CoreConfig {
        paths: Paths::new(dir),
        app_version: "0.1.0-test".into(),
        channel: BuildChannel::Development,
    }
}

/// The migrations up to and including `version` (what an older build shipped).
fn through(version: i64) -> &'static [Migration] {
    let end = MIGRATIONS
        .iter()
        .position(|m| m.version == version)
        .map_or(MIGRATIONS.len(), |i| i + 1);
    &MIGRATIONS[..end]
}

// Test helper: panics on setup failures by design.
#[allow(clippy::expect_used)]
fn backup_versions(dir: &std::path::Path) -> Vec<i64> {
    let Ok(entries) = std::fs::read_dir(dir.join("backups")) else {
        return Vec::new();
    };
    let mut versions: Vec<i64> = entries
        .filter_map(|e| e.ok())
        .map(|e| {
            let conn = rusqlite::Connection::open(e.path()).expect("open backup");
            db::schema_version(&conn).expect("backup version")
        })
        .collect();
    versions.sort_unstable();
    versions
}

// Test helper: panics on setup failures by design.
#[allow(clippy::expect_used)]
fn migrated(core: &Core) -> Vec<(i64, i64, bool)> {
    core.recent_events(100, None)
        .expect("events")
        .iter()
        .rev()
        .filter_map(|e| match e.event {
            EventPayload::DatabaseMigrated {
                from_version,
                to_version,
                backup_created,
            } => Some((from_version, to_version, backup_created)),
            _ => None,
        })
        .collect()
}

// Test helper: panics on setup failures by design.
#[allow(clippy::expect_used)]
fn write_theme_and_workspace(core: &Core, project: &std::path::Path) -> String {
    core.update_settings(&SettingsPatch {
        theme: Some(ThemePreference::Light),
        ..Default::default()
    })
    .expect("settings");
    core.open_workspace(project).expect("workspace").id
}

// Test helper: panics on setup failures by design.
#[allow(clippy::expect_used)]
fn assert_kept(core: &Core, workspace_id: &str) {
    assert_eq!(
        core.settings().expect("settings").theme,
        ThemePreference::Light
    );
    assert_eq!(
        core.active_workspace().expect("active").map(|w| w.id),
        Some(workspace_id.to_owned())
    );
    assert!(core.read(schema::installed).expect("installed"));
    let requests: i64 = core
        .read(|c| Ok(c.query_row("SELECT COUNT(*) FROM kalvoice_requests", [], |r| r.get(0))?))
        .expect("count");
    assert_eq!(requests, 0);
}

// Test helper: panics on setup failures by design.
#[allow(clippy::expect_used)]
fn backup_has_no_kalvoice_tables(dir: &std::path::Path) {
    let entries: Vec<_> = std::fs::read_dir(dir.join("backups"))
        .expect("backups")
        .filter_map(|e| e.ok())
        .collect();
    assert_eq!(entries.len(), 1);
    let conn = rusqlite::Connection::open(entries[0].path()).expect("open backup");
    assert!(!schema::installed(&conn).expect("installed"));
}

#[test]
fn upgrade_from_v4_to_v6_keeps_data_and_backs_up() {
    let dir = tempfile::tempdir().expect("tempdir");
    let project = tempfile::tempdir().expect("project");
    let workspace_id = {
        let core = Core::open_with_migrations(config(dir.path()), through(4)).expect("v4");
        assert!(!core.read(schema::installed).expect("installed"));
        let id = write_theme_and_workspace(&core, project.path());
        core.shutdown();
        id
    };

    let core = Core::open(config(dir.path())).expect("upgrade");
    assert_kept(&core, &workspace_id);
    assert_eq!(
        core.read(db::schema_version).expect("version"),
        KALVOICE_SCHEMA_VERSION
    );
    assert_eq!(backup_versions(dir.path()), vec![4]);
    backup_has_no_kalvoice_tables(dir.path());
    assert_eq!(migrated(&core).last(), Some(&(4, 6, true)));
    // v5's event columns arrived on the way.
    core.read(|c| {
        c.query_row("SELECT causation_id FROM events LIMIT 1", [], |_| Ok(()))?;
        Ok(())
    })
    .expect("v5 column");
}

#[test]
fn upgrade_from_v5_to_v6_keeps_data_and_backs_up() {
    let dir = tempfile::tempdir().expect("tempdir");
    let project = tempfile::tempdir().expect("project");
    let (workspace_id, v5_event) = {
        let core = Core::open_with_migrations(config(dir.path()), through(5)).expect("v5");
        let id = write_theme_and_workspace(&core, project.path());
        // A row that uses v5's new correlation columns.
        let (_, envelopes) = core
            .transact(|_| {
                Ok((
                    (),
                    vec![
                        NewEvent::core(EventPayload::SettingsChanged {
                            keys: vec!["appearance.theme".into()],
                        })
                        .with_correlation(Correlation {
                            agent_id: Some("0199a000-0000-7000-8000-0000000000c1".into()),
                            causation_id: Some("0199a000-0000-7000-8000-0000000000c2".into()),
                            ..Correlation::default()
                        }),
                    ],
                ))
            })
            .expect("v5 event");
        core.shutdown();
        (id, envelopes.into_iter().next().expect("envelope"))
    };
    assert_eq!(backup_versions(dir.path()), Vec::<i64>::new());

    let core = Core::open(config(dir.path())).expect("upgrade");
    assert_kept(&core, &workspace_id);
    assert_eq!(
        core.read(db::schema_version).expect("version"),
        KALVOICE_SCHEMA_VERSION
    );
    assert_eq!(backup_versions(dir.path()), vec![5]);
    backup_has_no_kalvoice_tables(dir.path());
    assert_eq!(migrated(&core).last(), Some(&(5, 6, true)));
    // The v5 row, with its v5 correlation ids, reads back identically.
    let kept = core
        .recent_events(500, None)
        .expect("events")
        .into_iter()
        .find(|e| e.id == v5_event.id)
        .expect("v5 event kept");
    assert_eq!(kept, v5_event);
    assert_eq!(
        kept.correlation.causation_id.as_deref(),
        Some("0199a000-0000-7000-8000-0000000000c2")
    );
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
fn state_and_events_commit_together_then_publish() {
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
