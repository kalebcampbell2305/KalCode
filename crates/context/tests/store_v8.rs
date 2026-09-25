//! Schema v8: the registered migration applies through the core runner, packages store
//! references only, finished packages are immutable, and the decision log is append-only.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod common;

use common::{Ws, token};
use kalcode_context::log::DecisionLog;
use kalcode_context::never_share::PatternScope;
use kalcode_context::package::{ContextItem, ContextPackage, PackageOptions};
use kalcode_context::provider::TextOnlyDefaults;
use kalcode_context::store::{
    PackageStatus, SqliteDecisionLog, append_log, finish_package, log_for_package,
    never_share_for_workspace, never_share_list, never_share_set, package_status, save_preview,
};
use kalcode_context::{ContextPurpose, Firewall, MIGRATION_V8, Sensitivity};
use kalcode_core::db::{MIGRATIONS, migrate, open_in_memory, schema_version};
use rusqlite::Connection;

fn db() -> Connection {
    let mut conn = open_in_memory().expect("db");
    migrate(&mut conn, MIGRATIONS, None).expect("migrate");
    assert!(schema_version(&conn).expect("version") >= 8);
    conn
}

#[test]
fn migration_is_registered_as_v8_and_well_formed() {
    assert_eq!(MIGRATION_V8.version, 8);
    assert_eq!(MIGRATION_V8.name, "context");
    let registered = MIGRATIONS
        .iter()
        .find(|m| m.version == 8)
        .expect("v8 is registered");
    assert_eq!(registered.name, "context");
    assert_eq!(registered.sql, MIGRATION_V8.sql);
    let conn = db();
    for table in [
        "context_packages",
        "context_items",
        "context_firewall_log",
        "context_never_share",
    ] {
        let n: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |r| r.get(0),
            )
            .expect("query");
        assert_eq!(n, 1, "{table}");
    }
}

fn package(ws: &Ws, secret: &str) -> ContextPackage {
    ws.write("src/config.rs", format!("const T: &str = \"{secret}\";\n"));
    ws.write(".env", format!("T={secret}\n"));
    let firewall = Firewall::for_root(ws.path());
    let mut options = PackageOptions::new(ContextPurpose::Drop);
    options.workspace_id = Some("ws-1".into());
    options.target_thread_id = Some("thread-1".into());
    ContextPackage::build(
        &firewall,
        &TextOnlyDefaults::new("provider-x"),
        options,
        vec![
            ContextItem::file("src/config.rs"),
            ContextItem::file(".env"),
            ContextItem::text(
                kalcode_context::ItemKind::Selection,
                "selection",
                kalcode_context::ItemOrigin::User,
                format!("token {secret}"),
            ),
        ],
    )
}

#[test]
fn packages_store_references_never_content() {
    let ws = Ws::new();
    let secret = token("ghp_", 21, 36);
    let mut conn = db();
    let mut package = package(&ws, &secret);
    save_preview(&mut conn, &package).expect("save");
    // Editing the preview updates the stored hash and items.
    package.set_included(2, false).expect("exclude");
    save_preview(&mut conn, &package).expect("save again");
    let (hash, total): (String, i64) = conn
        .query_row(
            "SELECT content_sha256, total_bytes FROM context_packages WHERE id = ?1",
            [&package.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .expect("row");
    assert_eq!(hash, package.content_sha256());
    assert!(total > 0);
    let rows: Vec<(i64, String, String, String, i64)> = conn
        .prepare("SELECT position, source, verdict, sensitivity, included FROM context_items WHERE package_id = ?1 ORDER BY position")
        .expect("prepare")
        .query_map([&package.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows");
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0].2, "redact");
    assert_eq!(rows[1].2, "block");
    assert_eq!(rows[1].3, "secret");
    assert_eq!(rows[2].4, 0);
    let dump: String = rows.iter().map(|r| r.1.clone()).collect();
    assert!(
        !dump.contains(&secret),
        "item source stored content: {dump}"
    );
    assert!(dump.contains("\"path\":\"src/config.rs\""));
    assert!(dump.contains("contentSha256"));
}

#[test]
fn finished_packages_are_immutable() {
    let ws = Ws::new();
    let mut conn = db();
    let package = package(&ws, &token("ghp_", 22, 36));
    save_preview(&mut conn, &package).expect("save");
    finish_package(
        &conn,
        &package.id,
        PackageStatus::Sent,
        "2026-09-24T12:00:00.000Z",
    )
    .expect("finish");
    assert_eq!(
        package_status(&conn, &package.id)
            .expect("status")
            .as_deref(),
        Some("sent")
    );
    assert!(
        finish_package(
            &conn,
            &package.id,
            PackageStatus::Discarded,
            "2026-09-24T12:00:01.000Z"
        )
        .is_err()
    );
    let direct = conn.execute(
        "UPDATE context_packages SET status = 'previewed' WHERE id = ?1",
        [&package.id],
    );
    assert!(
        direct.is_err(),
        "trigger must refuse changes to a finished package"
    );
    let identity = conn.execute("UPDATE context_packages SET purpose = 'memory'", []);
    assert!(identity.is_err());
    assert!(
        save_preview(&mut conn, &package).is_err(),
        "a sent package cannot be re-previewed"
    );
}

#[test]
fn decision_log_is_append_only_and_content_free() {
    let ws = Ws::new();
    let secret = token("ghp_", 23, 36);
    let mut conn = db();
    let mut package = package(&ws, &secret);
    let entries = package.log_entries();
    assert!(!entries.is_empty());
    {
        let log = SqliteDecisionLog::new(&mut conn);
        log.append(&entries).expect("append");
    }
    // Overrides are logged too (none possible here: .env is final; confirm fails).
    assert!(package.confirm_override(1).is_err());
    let rows = log_for_package(&conn, &package.id).expect("rows");
    assert_eq!(rows.len(), entries.len());
    for (_, _, detail) in &rows {
        assert!(!detail.contains(&secret));
    }
    assert!(
        rows.iter()
            .any(|(rule, action, _)| rule == "secret_detected" && action == "redacted")
    );
    assert!(
        rows.iter().any(
            |(rule, action, _)| rule == "ignored_path.builtin_sensitive" && action == "blocked"
        )
    );
    assert!(
        conn.execute("UPDATE context_firewall_log SET action = 'warned'", [])
            .is_err()
    );
    assert!(
        conn.execute("DELETE FROM context_firewall_log", [])
            .is_err()
    );
    // Appending more is fine; bad actions are refused by the CHECK.
    append_log(
        &mut conn,
        &entries[..1]
            .iter()
            .map(|e| {
                let mut e = e.clone();
                e.id = uuid::Uuid::now_v7().to_string();
                e
            })
            .collect::<Vec<_>>(),
    )
    .expect("append more");
    assert_eq!(
        log_for_package(&conn, &package.id).expect("rows").len(),
        entries.len() + 1
    );
}

#[test]
fn never_share_patterns_round_trip() {
    let mut conn = db();
    let workspace = PatternScope::Workspace {
        workspace_id: "ws-1".into(),
    };
    never_share_set(
        &mut conn,
        &PatternScope::Global,
        &[("*.sqlite".into(), Sensitivity::Confidential)],
        "2026-09-24T00:00:00.000Z",
    )
    .expect("set global");
    never_share_set(
        &mut conn,
        &workspace,
        &[
            ("private/".into(), Sensitivity::Secret),
            ("drafts/*.md".into(), Sensitivity::Public),
        ],
        "2026-09-24T00:00:00.000Z",
    )
    .expect("set workspace");
    let list = never_share_list(&conn, &workspace).expect("list");
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].pattern, "drafts/*.md");
    assert_eq!(
        list[0].sensitivity,
        Sensitivity::Confidential,
        "public is raised to confidential"
    );
    assert_eq!(list[1].sensitivity, Sensitivity::Secret);
    assert_eq!(
        never_share_for_workspace(&conn, "ws-1").expect("all").len(),
        3
    );
    // An invalid pattern writes nothing.
    let before = never_share_list(&conn, &workspace).expect("list");
    assert!(
        never_share_set(
            &mut conn,
            &workspace,
            &[
                ("ok/".into(), Sensitivity::Secret),
                ("!neg".into(), Sensitivity::Secret)
            ],
            "t"
        )
        .is_err()
    );
    assert_eq!(never_share_list(&conn, &workspace).expect("list"), before);
    // Replacing a scope's patterns.
    never_share_set(&mut conn, &workspace, &[], "t").expect("clear");
    assert!(
        never_share_list(&conn, &workspace)
            .expect("list")
            .is_empty()
    );
}
