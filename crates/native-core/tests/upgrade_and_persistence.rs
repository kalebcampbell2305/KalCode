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

/// The schema as shipped in the first release (v1).
fn v1_only() -> &'static [Migration] {
    &MIGRATIONS[..1]
}

/// Schema v2 (v1 + Z1 workspaces and terminals).
fn v2_only() -> &'static [Migration] {
    &MIGRATIONS[..2]
}

/// The final numbering of this build's migrations. Versions must stay contiguous and each
/// released migration's number, name and checksum is fixed forever.
#[test]
fn migrations_are_numbered_contiguously() {
    let numbering: Vec<(i64, &str)> = MIGRATIONS.iter().map(|m| (m.version, m.name)).collect();
    assert_eq!(
        numbering,
        vec![
            (1, "foundation"),
            (2, "workspaces"),
            (3, "threads"),
            (4, "permissions"),
            (5, "event_correlation"),
            (6, "kalvoice"),
            (7, "git"),
            (8, "context"),
            (9, "workspace_ui"),
            (10, "notifications"),
            (11, "rail_locator"),
            (12, "provider_accounts"),
            (13, "kalvoice_request_lifecycle"),
            (14, "utility_dock"),
            (15, "time_machine"),
            (16, "doctor"),
            (17, "utility_authority"),
            (18, "context_delivery"),
            (19, "kalvoice_account_usage"),
            (20, "operations"),
            (21, "threads_effort"),
            (22, "handoffs"),
            (23, "cursor_accounts"),
            (24, "unified_memory")
        ]
    );
}

#[test]
fn thread_effort_upgrade_preserves_existing_rows_and_reopens() {
    let dir = tempfile::tempdir().expect("tempdir");
    {
        let core =
            Core::open_with_migrations(config(dir.path()), &MIGRATIONS[..20]).expect("v20 open");
        core.transact(|conn| {
            conn.execute(
                "INSERT INTO workspaces (id, name, root_path, created_at, last_opened_at) \
                 VALUES ('w', 'Workspace', 'C:/repo', 't', 't')",
                [],
            )?;
            conn.execute(
                "INSERT INTO threads (id, name, provider_id, provider_name, workspace_id, \
                    workspace_name, cwd, permission_mode, status, created_at, last_activity_at) \
                 VALUES ('t', 'Thread', 'codex', 'Codex', 'w', 'Workspace', 'C:/repo', \
                    'approve', 'idle', 't', 't')",
                [],
            )?;
            Ok(((), Vec::new()))
        })
        .expect("seed v20 thread");
        core.shutdown();
    }

    for pass in 0..2 {
        let core = Core::open(config(dir.path())).expect("upgrade/reopen");
        let preserved: (String, String, String) = core
            .read(|conn| {
                Ok(conn.query_row(
                    "SELECT name, workspace_id, status FROM threads WHERE id = 't'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?)
            })
            .expect("preserved thread");
        assert_eq!(preserved, ("Thread".into(), "w".into(), "idle".into()));
        let effort: Option<String> = core
            .read(|conn| {
                Ok(
                    conn.query_row("SELECT effort FROM threads WHERE id = 't'", [], |row| {
                        row.get(0)
                    })?,
                )
            })
            .expect("effort");
        if pass == 0 {
            assert_eq!(effort, None, "legacy rows use provider-default effort");
            core.transact(|conn| {
                conn.execute("UPDATE threads SET effort = 'high' WHERE id = 't'", [])?;
                Ok(((), Vec::new()))
            })
            .expect("persist effort");
        } else {
            assert_eq!(effort.as_deref(), Some("high"));
        }
        core.shutdown();
    }

    let backups: Vec<_> = std::fs::read_dir(dir.path().join("backups"))
        .expect("backups")
        .map(|entry| entry.expect("backup").path())
        .collect();
    assert_eq!(backups.len(), 1, "reopen must not repeat the v21 backup");
    let backup = db::open_read_only(&backups[0]).expect("open pre-v21 backup");
    assert_eq!(db::schema_version(&backup).expect("backup schema"), 20);
    let preserved: (String, String, String) = backup
        .query_row(
            "SELECT name, workspace_id, status FROM threads WHERE id = 't'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("backup thread");
    assert_eq!(preserved, ("Thread".into(), "w".into(), "idle".into()));
    let effort_columns: i64 = backup
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('threads') WHERE name = 'effort'",
            [],
            |row| row.get(0),
        )
        .expect("backup columns");
    assert_eq!(effort_columns, 0, "backup remains exact pre-v21 schema");
}

#[test]
fn utility_timeline_doctor_upgrade_preserves_v13_data_and_reopens() {
    let dir = tempfile::tempdir().expect("tempdir");
    {
        let core =
            Core::open_with_migrations(config(dir.path()), &MIGRATIONS[..13]).expect("v13 open");
        core.update_settings(&SettingsPatch {
            theme: Some(ThemePreference::Dark),
            ..Default::default()
        })
        .expect("settings");
        core.shutdown();
    }
    for _ in 0..2 {
        let core = Core::open(config(dir.path())).expect("upgraded open");
        assert_eq!(
            core.settings().expect("settings").theme,
            ThemePreference::Dark
        );
        assert_eq!(
            core.diagnostics()
                .expect("diagnostics")
                .database
                .schema_version,
            MIGRATIONS.last().expect("registered migrations").version
        );
        let tables: i64 = core
            .read(|conn| {
                Ok(conn.query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name IN
            ('scratchpads','http_saved_requests','restore_operations','replay_runs',
             'doctor_ignores','doctor_runs','doctor_fix_log','doctor_approval_claims',
             'utility_approval_claims')",
                    [],
                    |row| row.get(0),
                )?)
            })
            .expect("feature tables");
        assert_eq!(tables, 9);
        core.shutdown();
    }
    let backups: Vec<_> = std::fs::read_dir(dir.path().join("backups"))
        .expect("backups")
        .map(|entry| entry.expect("backup").path())
        .collect();
    assert_eq!(
        backups.len(),
        1,
        "restart must not repeat migration or backup"
    );
    let backup = db::open_read_only(&backups[0]).expect("backup read only");
    assert_eq!(db::schema_version(&backup).expect("backup schema"), 13);
    let theme: String = backup
        .query_row(
            "SELECT value FROM settings WHERE key = 'appearance.theme'",
            [],
            |row| row.get(0),
        )
        .expect("backup settings");
    assert_eq!(theme, "\"dark\"");
}

/// A hypothetical migration after the current latest, to exercise refusal paths.
fn current_plus_next() -> Vec<Migration> {
    let mut all = MIGRATIONS.to_vec();
    all.push(Migration {
        version: MIGRATIONS.len() as i64 + 1,
        name: "test_next",
        sql: "CREATE TABLE test_next (id TEXT PRIMARY KEY NOT NULL) STRICT;",
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
        // A user on the first release (schema v1) with real data.
        let core = Core::open_with_migrations(config(dir.path()), v1_only()).expect("v1 open");
        core.update_settings(&SettingsPatch {
            theme: Some(ThemePreference::Dark),
            ..Default::default()
        })
        .expect("update");
        core.shutdown();
    }

    // Upgrade to the current build's schema.
    let core = Core::open(config(dir.path())).expect("current open");

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
    let latest = MIGRATIONS.last().expect("migrations").version;
    let migrated = events
        .iter()
        .find_map(|e| match e.event {
            EventPayload::DatabaseMigrated {
                from_version: 1,
                to_version,
                backup_created,
            } if to_version == latest => Some(backup_created),
            _ => None,
        })
        .expect("database.migrated 1 -> latest");
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
    assert_eq!(diagnostics.database.schema_version, MIGRATIONS.len() as i64);
    assert_eq!(diagnostics.database.journal_mode.to_lowercase(), "wal");

    // The v2 tables exist and are usable after the upgrade.
    assert!(core.workspaces().expect("workspaces").is_empty());
    let project = tempfile::tempdir().expect("project");
    let workspace = core.open_workspace(project.path()).expect("open workspace");
    assert_eq!(
        core.active_workspace().expect("active").map(|w| w.id),
        Some(workspace.id)
    );

    // The v3 thread tables and the v4 permission tables exist.
    assert_eq!(thread_tables(&core), THREAD_TABLES);
    assert_eq!(permission_tables(&core), PERMISSION_TABLES);
}

const THREAD_TABLES: [&str; 4] = ["thread_files", "thread_messages", "threads", "tool_calls"];

const PERMISSION_TABLES: [&str; 5] = [
    "approvals",
    "permission_audit",
    "permission_grants",
    "permission_profiles",
    "permission_settings",
];

// Test helper: panics on setup failures by design.
#[allow(clippy::expect_used)]
fn permission_tables(core: &Core) -> Vec<String> {
    core.read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table'
               AND name IN ('approvals', 'permission_audit', 'permission_grants',
                            'permission_profiles', 'permission_settings')
             ORDER BY name",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    })
    .expect("list tables")
}

/// Schema v3 (v2 + Z3 threads).
fn v3_only() -> &'static [Migration] {
    &MIGRATIONS[..3]
}

/// Schema v4 (v3 + Z4 permissions): what the installed app ships before L-1.
fn v4_only() -> &'static [Migration] {
    &MIGRATIONS[..4]
}

// Test helper: panics on setup failures by design.
#[allow(clippy::expect_used)]
fn thread_tables(core: &Core) -> Vec<String> {
    core.read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table'
               AND name IN ('threads', 'thread_messages', 'tool_calls', 'thread_files')
             ORDER BY name",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    })
    .expect("list tables")
}

// Test helper: panics on setup failures by design.
#[allow(clippy::expect_used)]
fn backup_versions(dir: &std::path::Path) -> Vec<i64> {
    let mut versions: Vec<i64> = std::fs::read_dir(dir.join("backups"))
        .expect("backups dir")
        .filter_map(|e| e.ok())
        .map(|e| {
            let conn = rusqlite::Connection::open(e.path()).expect("open backup");
            db::schema_version(&conn).expect("backup version")
        })
        .collect();
    versions.sort_unstable();
    versions
}

/// v1 (first release) → v2 (Z1) → v3 (Z3) → v4 (Z4) → v5 (L-1, this build), one step at a time,
/// with data written at every version. Each upgrade writes a backup of the version it started
/// from.
#[test]
fn upgrade_v1_to_v5_step_by_step_keeps_data_and_backs_up_each_step() {
    let dir = tempfile::tempdir().expect("tempdir");
    let project = tempfile::tempdir().expect("project");
    {
        let core = Core::open_with_migrations(config(dir.path()), v1_only()).expect("v1 open");
        core.update_settings(&SettingsPatch {
            theme: Some(ThemePreference::Light),
            density: Some(Density::Compact),
            ..Default::default()
        })
        .expect("update");
        core.shutdown();
    }
    let workspace_id = {
        let core = Core::open_with_migrations(config(dir.path()), v2_only()).expect("v2 open");
        assert_eq!(
            core.diagnostics()
                .expect("diagnostics")
                .database
                .schema_version,
            2
        );
        assert!(
            thread_tables(&core).is_empty(),
            "v2 has no thread tables yet"
        );
        let workspace = core.open_workspace(project.path()).expect("open workspace");
        core.shutdown();
        workspace.id
    };
    assert_eq!(backup_versions(dir.path()), vec![1]);

    let thread_id = kalcode_contracts::ids::new_id();
    {
        let core = Core::open_with_migrations(config(dir.path()), v3_only()).expect("v3 open");
        assert!(
            permission_tables(&core).is_empty(),
            "v3 has no permission tables yet"
        );
        // A thread row as Z3 writes it (raw SQL: this test stays independent of the runtime).
        core.write_with_events(|tx| {
            tx.execute(
                "INSERT INTO threads (id, name, provider_id, provider_name, workspace_id,
                   workspace_name, cwd, permission_mode, status, created_at, last_activity_at)
                 VALUES (?1, 'Fix login', 'claude-code', 'Claude Code', ?2, 'project', 'C:\\p',
                   'approve', 'interrupted', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')",
                [&thread_id, &workspace_id],
            )?;
            Ok(((), Vec::new()))
        })
        .expect("insert thread");
        core.shutdown();
    }
    assert_eq!(backup_versions(dir.path()), vec![1, 2]);

    {
        let core = Core::open_with_migrations(config(dir.path()), v4_only()).expect("v4 open");
        assert_eq!(
            core.diagnostics()
                .expect("diagnostics")
                .database
                .schema_version,
            4
        );
        assert!(
            event_columns(&core).is_empty(),
            "v4 has no v5 correlation columns yet"
        );
        core.shutdown();
    }
    assert_eq!(backup_versions(dir.path()), vec![1, 2, 3]);

    // Exactly v4 -> v5 here; v4 -> v6 and v5 -> v6 (KalVoice) are in crates/kalvoice/tests.
    let core = Core::open_with_migrations(config(dir.path()), &MIGRATIONS[..5]).expect("v5 open");
    assert_eq!(backup_versions(dir.path()), vec![1, 2, 3, 4]);
    assert_eq!(
        core.diagnostics()
            .expect("diagnostics")
            .database
            .schema_version,
        5
    );

    // v1 settings, the v2 workspace, the v3 thread and the whole event history survive.
    let settings = core.settings().expect("settings");
    assert_eq!(settings.theme, ThemePreference::Light);
    assert_eq!(settings.density, Density::Compact);
    assert_eq!(
        core.active_workspace().expect("active").map(|w| w.id),
        Some(workspace_id)
    );
    let migrations: Vec<(i64, i64, bool)> = core
        .recent_events(100, None)
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
        .collect();
    assert_eq!(
        migrations,
        vec![
            (0, 1, false),
            (1, 2, true),
            (2, 3, true),
            (3, 4, true),
            (4, 5, true)
        ],
        "each step recorded, backups for every existing database"
    );
    let types: Vec<&str> = core
        .recent_events(100, None)
        .expect("events")
        .iter()
        .map(|e| e.event.type_name())
        .collect();
    assert!(types.contains(&"settings.changed"));
    assert!(types.contains(&"workspace.created"));
    assert_eq!(thread_tables(&core), THREAD_TABLES);
    let name: String = core
        .read(|conn| {
            Ok(conn.query_row(
                "SELECT name FROM threads WHERE id = ?1",
                [&thread_id],
                |r| r.get(0),
            )?)
        })
        .expect("thread kept");
    assert_eq!(name, "Fix login");
    assert_eq!(permission_tables(&core), PERMISSION_TABLES);
    assert_eq!(event_columns(&core), V5_EVENT_COLUMNS);
}

const V5_EVENT_COLUMNS: [&str; 4] = ["agent_id", "automation_id", "causation_id", "task_id"];

// Test helper: panics on setup failures by design.
#[allow(clippy::expect_used)]
fn event_columns(core: &Core) -> Vec<String> {
    core.read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT name FROM pragma_table_info('events')
             WHERE name IN ('agent_id', 'task_id', 'automation_id', 'causation_id') ORDER BY name",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    })
    .expect("event columns")
}

/// The installed app is at schema v4. Opening its database in this build upgrades it to v5: a
/// backup of the untouched v4 database is written first, every row survives, old events read
/// back with the new correlation ids as null, and the new columns and partial indexes work.
#[test]
fn upgrade_v4_to_v5_backs_up_and_preserves_everything() {
    use kalcode_contracts::events::{CorrelationFilter, EventQuery, SeqOrder};
    use kalcode_core::events::{Correlation, NewEvent};

    let dir = tempfile::tempdir().expect("tempdir");
    let project = tempfile::tempdir().expect("project");
    let thread_id = kalcode_contracts::ids::new_id();
    let (workspace_id, v4_events) = {
        let core = Core::open_with_migrations(config(dir.path()), v4_only()).expect("v4 open");
        core.update_settings(&SettingsPatch {
            theme: Some(ThemePreference::Light),
            ..Default::default()
        })
        .expect("settings");
        let workspace = core.open_workspace(project.path()).expect("workspace");
        core.write_with_events(|tx| {
            tx.execute(
                "INSERT INTO threads (id, name, provider_id, provider_name, workspace_id,
                   workspace_name, cwd, permission_mode, status, created_at, last_activity_at)
                 VALUES (?1, 'Keep me', 'claude-code', 'Claude Code', ?2, 'project', 'C:\\p',
                   'approve', 'idle', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')",
                [&thread_id, &workspace.id],
            )?;
            tx.execute(
                "INSERT INTO permission_settings (key, value, updated_at)
                 VALUES ('defaults', '{\"defaultMode\":\"plan\"}', '2026-09-01T00:00:00Z')",
                [],
            )?;
            Ok((
                (),
                vec![
                    NewEvent::core(EventPayload::ThreadStarted {
                        thread_id: thread_id.clone(),
                    })
                    .with_correlation(Correlation {
                        workspace_id: Some(workspace.id.clone()),
                        thread_id: Some(thread_id.clone()),
                        provider_id: Some("claude-code".into()),
                        ..Correlation::default()
                    }),
                ],
            ))
        })
        .expect("thread");
        let events = core.recent_events(500, None).expect("v4 events");
        core.shutdown();
        (workspace.id, events)
    };
    let v4_count = v4_events.len() + 1; // + app.stopped

    // Exactly v4 -> v5 here; v4 -> v6 and v5 -> v6 (KalVoice) are in crates/kalvoice/tests.
    let core = Core::open_with_migrations(config(dir.path()), &MIGRATIONS[..5]).expect("v5 open");

    // The backup is the untouched v4 database.
    assert_eq!(backup_versions(dir.path()), vec![4]);
    let backup_path = std::fs::read_dir(dir.path().join("backups"))
        .expect("backups")
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .next()
        .expect("backup");
    let backup = rusqlite::Connection::open(&backup_path).expect("open backup");
    let backup_events: i64 = backup
        .query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))
        .expect("backup events");
    assert_eq!(backup_events, v4_count as i64);
    let backup_columns: i64 = backup
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('events') WHERE name = 'causation_id'",
            [],
            |r| r.get(0),
        )
        .expect("backup columns");
    assert_eq!(backup_columns, 0, "the backup is the pre-upgrade schema");

    // Schema v5, with the columns and indexes.
    assert_eq!(
        core.diagnostics()
            .expect("diagnostics")
            .database
            .schema_version,
        5
    );
    assert_eq!(event_columns(&core), V5_EVENT_COLUMNS);
    let indexes: Vec<String> = core
        .read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'
                   AND name IN ('events_agent_id_idx', 'events_task_id_idx',
                     'events_automation_id_idx', 'events_causation_id_idx', 'events_request_id_idx')
                 ORDER BY name",
            )?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
        })
        .expect("indexes");
    assert_eq!(
        indexes,
        vec![
            "events_agent_id_idx",
            "events_automation_id_idx",
            "events_causation_id_idx",
            "events_request_id_idx",
            "events_task_id_idx"
        ]
    );

    // Every v4 row survives, and old events decode identically (new ids null).
    let after = core.recent_events(500, None).expect("events");
    for old in &v4_events {
        let same = after.iter().find(|e| e.id == old.id).expect("event kept");
        assert_eq!(same, old);
        assert_eq!(same.correlation.causation_id, None);
    }
    assert_eq!(
        core.settings().expect("settings").theme,
        ThemePreference::Light
    );
    assert_eq!(
        core.active_workspace().expect("active").map(|w| w.id),
        Some(workspace_id.clone())
    );
    let kept: (String, String) = core
        .read(|conn| {
            Ok(conn.query_row(
                "SELECT t.name, s.value FROM threads t, permission_settings s
                 WHERE t.id = ?1 AND s.key = 'defaults'",
                [&thread_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .expect("rows kept");
    assert_eq!(
        kept,
        (
            "Keep me".to_owned(),
            "{\"defaultMode\":\"plan\"}".to_owned()
        )
    );
    let migrated = after
        .iter()
        .find_map(|e| match e.event {
            EventPayload::DatabaseMigrated {
                from_version: 4,
                to_version: 5,
                backup_created,
            } => Some(backup_created),
            _ => None,
        })
        .expect("database.migrated 4 -> 5");
    assert!(migrated);

    // The query API reads old rows by their v1 correlation, and new rows by the v5 ids.
    let by_thread = core
        .query_events(&EventQuery {
            correlation: CorrelationFilter {
                thread_id: Some(thread_id.clone()),
                ..CorrelationFilter::default()
            },
            ..EventQuery::default()
        })
        .expect("by thread");
    assert_eq!(by_thread.events.len(), 1);
    let cause = by_thread.events[0].id.clone();
    let reaction = core
        .emit(
            NewEvent::core(EventPayload::ThreadCompleted {
                thread_id: thread_id.clone(),
            })
            .with_correlation(Correlation {
                thread_id: Some(thread_id.clone()),
                agent_id: Some("agent".into()),
                causation_id: Some(cause.clone()),
                ..Correlation::default()
            }),
        )
        .expect("emit");
    let caused = core
        .query_events(&EventQuery {
            types: vec!["thread.*".into()],
            correlation: CorrelationFilter {
                causation_id: Some(cause),
                ..CorrelationFilter::default()
            },
            order: SeqOrder::Asc,
            ..EventQuery::default()
        })
        .expect("caused");
    assert_eq!(caused.events, vec![reaction]);
    core.shutdown();
}

/// Tables each migration after v6 adds, including credential-free provider account metadata.
const POST_V6_TABLES: [&str; 13] = [
    "checkpoints",
    "context_firewall_log",
    "context_items",
    "context_never_share",
    "context_packages",
    "git_worktrees",
    "layout_presets",
    "operation_moments",
    "operations",
    "operations_state",
    "provider_account_bindings",
    "provider_accounts",
    "workspace_layouts",
];

// Test helper: panics on setup failures by design.
#[allow(clippy::expect_used)]
fn tables_named(conn: &rusqlite::Connection, names: &[&str]) -> Vec<String> {
    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .expect("prepare");
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .expect("tables");
    rows.filter_map(|r| r.ok())
        .filter(|name| names.contains(&name.as_str()))
        .collect()
}

/// A database at v6 (the schema the owner's installed app has) upgrades to this build's latest
/// schema in one start: exactly one backup (the untouched v6 file), every row kept (settings,
/// workspace, events, KalVoice's v6 rows), and the git and context tables added.
#[test]
fn upgrade_v6_to_latest_backs_up_once_and_keeps_everything() {
    let dir = tempfile::tempdir().expect("tempdir");
    let project = tempfile::tempdir().expect("project");
    let latest = MIGRATIONS.last().expect("migrations").version;
    let (workspace_id, v6_events) = {
        let core = Core::open_with_migrations(config(dir.path()), &MIGRATIONS[..6]).expect("v6");
        assert_eq!(core.read(db::schema_version).expect("version"), 6);
        core.update_settings(&SettingsPatch {
            theme: Some(ThemePreference::Light),
            density: Some(Density::Compact),
            ..Default::default()
        })
        .expect("settings");
        let workspace = core.open_workspace(project.path()).expect("workspace");
        core.transact(|tx| {
            tx.execute(
                "INSERT INTO kalvoice_preferences (key, value, updated_at)
                 VALUES ('voice.speakReplies', 'true', '2026-09-24T10:00:00Z')",
                [],
            )?;
            Ok(((), Vec::new()))
        })
        .expect("kalvoice row");
        let events = core.recent_events(500, None).expect("v6 events");
        core.shutdown();
        (workspace.id, events)
    };
    assert!(
        !dir.path().join("backups").exists() || backup_versions(dir.path()).is_empty(),
        "a fresh v6 install has no backup yet"
    );

    let core = Core::open(config(dir.path())).expect("upgrade");
    assert_eq!(core.read(db::schema_version).expect("version"), latest);
    assert!(latest >= 8, "v7 and v8 are registered");
    // One backup: the untouched v6 database.
    assert_eq!(backup_versions(dir.path()), vec![6]);
    let backup_path = std::fs::read_dir(dir.path().join("backups"))
        .expect("backups")
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .next()
        .expect("backup");
    assert!(
        backup_path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("kalcode-pre-v7-")),
        "{backup_path:?}"
    );
    let backup = rusqlite::Connection::open(&backup_path).expect("open backup");
    assert!(tables_named(&backup, &POST_V6_TABLES).is_empty());
    let backup_prefs: i64 = backup
        .query_row("SELECT COUNT(*) FROM kalvoice_preferences", [], |r| {
            r.get(0)
        })
        .expect("backup prefs");
    assert_eq!(backup_prefs, 1);

    // Every v6 row survives.
    let settings = core.settings().expect("settings");
    assert_eq!(settings.theme, ThemePreference::Light);
    assert_eq!(settings.density, Density::Compact);
    assert_eq!(
        core.active_workspace().expect("active").map(|w| w.id),
        Some(workspace_id)
    );
    let after = core.recent_events(500, None).expect("events");
    for event in &v6_events {
        assert!(
            after.iter().any(|e| e == event),
            "v6 event {} kept",
            event.id
        );
    }
    let pref: String = core
        .read(|c| {
            Ok(c.query_row(
                "SELECT value FROM kalvoice_preferences WHERE key = 'voice.speakReplies'",
                [],
                |r| r.get(0),
            )?)
        })
        .expect("pref");
    assert_eq!(pref, "true");
    // The new tables exist, and the upgrade is recorded once, from v6, with its backup.
    let tables = core
        .read(|c| Ok(tables_named(c, &POST_V6_TABLES)))
        .expect("tables");
    assert_eq!(tables, POST_V6_TABLES);
    let upgrades: Vec<(i64, i64, bool)> = after
        .iter()
        .filter_map(|e| match e.event {
            EventPayload::DatabaseMigrated {
                from_version,
                to_version,
                backup_created,
            } if from_version > 0 => Some((from_version, to_version, backup_created)),
            _ => None,
        })
        .collect();
    assert_eq!(upgrades, vec![(6, latest, true)]);
}

#[test]
fn upgrade_v11_to_v12_preserves_threads_and_adds_account_authority() {
    let dir = tempfile::tempdir().expect("tempdir");
    let thread_id = "11111111-1111-4111-8111-111111111111";
    {
        let core = Core::open_with_migrations(config(dir.path()), &MIGRATIONS[..11]).expect("v11");
        core.transact(|tx| {
            tx.execute(
                "INSERT INTO threads (
                     id, name, provider_id, provider_name, account_label,
                     workspace_id, workspace_name, cwd, permission_mode, status,
                     created_at, last_activity_at
                 ) VALUES (
                     ?1, 'Existing thread', 'codex', 'Codex', 'Historical label',
                     'legacy-workspace', 'Legacy workspace', 'C:/legacy', 'approve', 'idle',
                     '2026-09-24T10:00:00.000Z', '2026-09-24T10:00:00.000Z'
                 )",
                [thread_id],
            )?;
            Ok(((), Vec::new()))
        })
        .expect("v11 thread");
        core.shutdown();
    }

    let core = Core::open(config(dir.path())).expect("upgrade");
    assert_eq!(
        core.read(db::schema_version).expect("version"),
        MIGRATIONS.last().expect("registered migrations").version
    );
    let row: (String, String, Option<String>) = core
        .read(|conn| {
            Ok(conn.query_row(
                "SELECT name, account_label, provider_account_id FROM threads WHERE id = ?1",
                [thread_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?)
        })
        .expect("preserved thread");
    assert_eq!(
        row,
        ("Existing thread".into(), "Historical label".into(), None)
    );
    let tables = core
        .read(|conn| {
            Ok(tables_named(
                conn,
                &["provider_account_bindings", "provider_accounts"],
            ))
        })
        .expect("provider account tables");
    assert_eq!(
        tables,
        vec!["provider_account_bindings", "provider_accounts"]
    );
    core.shutdown();
}

#[test]
fn upgrade_v17_to_v18_backs_up_reopens_and_preserves_context_data() {
    const PACKAGE_ID: &str = "018f6f65-6c6a-7f32-a21b-22600a5d8a18";
    const CREATED_AT: &str = "2026-09-25T12:00:00.000Z";

    let dir = tempfile::tempdir().expect("tempdir");
    {
        let core = Core::open_with_migrations(config(dir.path()), &MIGRATIONS[..17])
            .expect("open schema v17");
        core.update_settings(&SettingsPatch {
            theme: Some(ThemePreference::Light),
            density: Some(Density::Compact),
            ..Default::default()
        })
        .expect("preserved settings");
        core.transact(|tx| {
            tx.execute(
                "INSERT INTO context_packages
                   (id, purpose, status, content_sha256, total_bytes, created_at)
                 VALUES (?1, 'drop', 'previewed', ?2, 7, ?3)",
                rusqlite::params![PACKAGE_ID, "a".repeat(64), CREATED_AT],
            )?;
            Ok(((), Vec::new()))
        })
        .expect("pre-v18 context package");
        core.shutdown();
    }

    for _ in 0..2 {
        let core = Core::open_with_migrations(config(dir.path()), &MIGRATIONS[..18])
            .expect("upgrade to v18 or reopen");
        assert_eq!(core.read(db::schema_version).expect("schema version"), 18);
        let settings = core.settings().expect("settings");
        assert_eq!(settings.theme, ThemePreference::Light);
        assert_eq!(settings.density, Density::Compact);
        let preserved: (String, String, i64) = core
            .read(|conn| {
                Ok(conn.query_row(
                    "SELECT status, content_sha256, total_bytes
                       FROM context_packages
                      WHERE id = ?1",
                    [PACKAGE_ID],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?)
            })
            .expect("preserved context package");
        assert_eq!(preserved, ("previewed".into(), "a".repeat(64), 7));
        let delivery_rows: i64 = core
            .read(|conn| {
                Ok(conn.query_row(
                    "SELECT COUNT(*) FROM context_delivery_attempts",
                    [],
                    |row| row.get(0),
                )?)
            })
            .expect("delivery table");
        assert_eq!(
            delivery_rows, 0,
            "migration never fabricates delivery evidence"
        );
        core.shutdown();
    }

    let backups: Vec<_> = std::fs::read_dir(dir.path().join("backups"))
        .expect("backups")
        .map(|entry| entry.expect("backup entry").path())
        .collect();
    assert_eq!(
        backups.len(),
        1,
        "reopen must not repeat backup or migration"
    );
    let backup = db::open_read_only(&backups[0]).expect("open v17 backup");
    assert_eq!(db::schema_version(&backup).expect("backup schema"), 17);
    let preserved: (String, i64) = backup
        .query_row(
            "SELECT content_sha256, total_bytes FROM context_packages WHERE id = ?1",
            [PACKAGE_ID],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("backup context package");
    assert_eq!(preserved, ("a".repeat(64), 7));
    let delivery_table: i64 = backup
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
              WHERE type = 'table' AND name = 'context_delivery_attempts'",
            [],
            |row| row.get(0),
        )
        .expect("backup delivery table check");
    assert_eq!(delivery_table, 0, "backup remains an exact pre-v18 schema");
}

#[test]
fn newer_schema_is_refused_without_changes() {
    let dir = tempfile::tempdir().expect("tempdir");
    let migrations = current_plus_next();
    Core::open_with_migrations(config(dir.path()), &migrations)
        .expect("open with the next schema")
        .shutdown();

    let err = match Core::open(config(dir.path())) {
        Ok(_) => panic!("an older build must refuse a newer database"),
        Err(err) => err,
    };
    assert_eq!(err.code, "schema_too_new");

    let conn = rusqlite::Connection::open(dir.path().join("kalcode.db")).expect("reopen");
    assert_eq!(
        db::schema_version(&conn).expect("version"),
        MIGRATIONS.len() as i64 + 1,
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
