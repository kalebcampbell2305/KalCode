//! The threads migration upgrades an existing v1 (foundation) database with data intact, and
//! the upgraded database works with the thread runtime.

#![allow(clippy::expect_used, clippy::unwrap_used)]

mod common;

use std::sync::Arc;

use common::*;
use kalcode_contracts::permissions::{PermissionMode, PolicyEffect};
use kalcode_contracts::threads::ThreadStatus;
use kalcode_core::Core;
use kalcode_core::db::{self, MIGRATIONS};
use kalcode_core::events::EventPayload;
use kalcode_core::settings::{SettingsPatch, ThemePreference};
use kalcode_threads::{CreateThread, ProviderRegistry, ThreadRuntime};

fn threads_migration_version() -> i64 {
    MIGRATIONS
        .iter()
        .find(|m| m.name == "threads")
        .expect("threads migration registered")
        .version
}

#[test]
fn upgrading_a_v1_database_keeps_its_data_and_adds_threads() {
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

    let core = Arc::new(Core::open(config(dir.path())).expect("upgrade"));
    assert_eq!(
        core.settings().expect("settings").theme,
        ThemePreference::Light
    );
    let events = core.recent_events(50, None).expect("events");
    assert!(
        events
            .iter()
            .any(|e| e.event.type_name() == "settings.changed")
    );
    assert!(events.iter().any(|e| matches!(
        e.event,
        EventPayload::DatabaseMigrated {
            from_version: 1,
            backup_created: true,
            ..
        }
    )));
    let backups = std::fs::read_dir(dir.path().join("backups"))
        .expect("backups")
        .count();
    assert_eq!(backups, 1, "a pre-upgrade backup was written");

    let tables: Vec<String> = core
        .read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN
                 ('threads', 'thread_messages', 'tool_calls', 'thread_files') ORDER BY name",
            )?;
            let rows = stmt.query_map([], |r| r.get(0))?;
            Ok(rows.collect::<Result<Vec<String>, _>>()?)
        })
        .expect("tables");
    assert_eq!(
        tables,
        ["thread_files", "thread_messages", "threads", "tool_calls"]
    );
    assert_eq!(
        core.diagnostics()
            .expect("diagnostics")
            .database
            .schema_version,
        MIGRATIONS.last().unwrap().version
    );
    assert!(threads_migration_version() >= 2);

    // The upgraded database serves the runtime end to end.
    let root = dir.path().join("repo");
    std::fs::create_dir_all(&root).unwrap();
    let (workspaces, workspace_id) = FakeWorkspaces::with(root);
    let registry = Arc::new(ProviderRegistry::new());
    let provider = FakeProvider::new("fake", "Fake Provider");
    registry.register(provider.clone());
    let runtime = ThreadRuntime::new(core, registry, workspaces, TestGate::new(PolicyEffect::Ask))
        .expect("runtime");
    let thread = runtime
        .create(CreateThread {
            provider_id: "fake".into(),
            provider_account_id: None,
            account_label: None,
            workspace_id,
            model: None,
            permission_mode: PermissionMode::Approve,
            prompt: "hello".into(),
            name: None,
        })
        .expect("create");
    assert_eq!(thread.status, ThreadStatus::Active);
}

#[test]
fn the_schema_rejects_invalid_rows() {
    let mut conn = db::open_in_memory().expect("open");
    db::migrate(&mut conn, MIGRATIONS, None).expect("migrate");
    let insert = |status: &str, mode: &str| {
        conn.execute(
            "INSERT INTO threads (id, name, provider_id, provider_name, workspace_id, workspace_name,
                cwd, permission_mode, status, created_at, last_activity_at)
             VALUES (lower(hex(randomblob(16))), 'n', 'p', 'P', 'w', 'W', '/', ?1, ?2, 't', 't')",
            [mode, status],
        )
    };
    assert!(insert("active", "approve").is_ok());
    assert!(insert("teleporting", "approve").is_err());
    assert!(insert("active", "yolo").is_err());
    // Messages must belong to a thread.
    assert!(
        conn.execute(
            "INSERT INTO thread_messages (id, thread_id, role, content, created_at)
             VALUES ('m', 'no-such-thread', 'user', 'x', 't')",
            [],
        )
        .is_err()
    );
}
