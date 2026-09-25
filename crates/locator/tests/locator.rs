//! Session Locator (LOC) behaviour against a real core: search quality, filters, privacy,
//! incremental indexing from the event bus, corruption recovery and the isolated migration.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod common;

use std::time::Duration;

use common::{FakeSources, core_with_v10, core_without_v10, thread, workspace};
use kalcode_contracts::events::{Correlation, EventPayload};
use kalcode_contracts::threads::ThreadStatus;
use kalcode_core::db::MIGRATIONS;
use kalcode_core::events::NewEvent;
use kalcode_core::time::format_rfc3339;
use kalcode_locator::store::Store;
use kalcode_locator::{
    Locator, LocatorEntityKind, LocatorQuery, LocatorRecency, LocatorSort, LocatorStatusFilter,
    LocatorVia, RAIL_LOCATOR_MIGRATION, RailUpdate,
};
use time::OffsetDateTime;

const WAIT: Duration = Duration::from_secs(20);

fn ago(hours: i64) -> String {
    format_rfc3339(OffsetDateTime::now_utc() - time::Duration::hours(hours))
}

fn q(text: &str) -> LocatorQuery {
    LocatorQuery {
        text: text.to_owned(),
        ..LocatorQuery::default()
    }
}

fn titles(locator: &Locator, query: &LocatorQuery) -> Vec<String> {
    locator
        .search(query)
        .expect("search")
        .results
        .items
        .into_iter()
        .map(|r| r.title)
        .collect()
}

#[test]
fn migration_is_isolated_and_well_formed() {
    assert_eq!(RAIL_LOCATOR_MIGRATION.version, 10);
    assert_eq!(RAIL_LOCATOR_MIGRATION.name, "rail_locator");
    assert!(
        MIGRATIONS.iter().all(|m| m.version != 10),
        "v10 is registered by the lead at integration, not on this branch"
    );
    let dir = tempfile::tempdir().unwrap();
    let core = core_with_v10(dir.path());
    let conn = core.reader();
    for table in [
        "workspace_groups",
        "workspace_rail",
        "locator_entries",
        "locator_fts",
    ] {
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name = ?1",
                [table],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "{table}");
    }
    assert_eq!(kalcode_core::db::schema_version(&conn).unwrap(), 10);
}

#[test]
fn auth_finds_authentication_refactor_first() {
    let dir = tempfile::tempdir().unwrap();
    let core = core_with_v10(dir.path());
    let ws = workspace(&core, dir.path(), "atlas-api");
    let sources = FakeSources::new();
    for (name, hours) in [
        ("Authentication Refactor", 30),
        ("Fix flaky upload tests", 2),
        ("Author page redesign", 1),
        ("Billing webhooks", 5),
        ("Login rate limiting", 50),
    ] {
        sources.add(thread(
            name,
            "claude-code",
            &ws.id,
            &ws.name,
            ThreadStatus::Idle,
            &ago(hours),
        ));
    }
    let locator = Locator::start(core.clone(), sources).expect("start");
    assert!(locator.wait_ready(WAIT));

    let found = titles(&locator, &q("auth"));
    assert_eq!(
        found.first().map(String::as_str),
        Some("Authentication Refactor")
    );
    assert!(
        found.contains(&"Login rate limiting".to_owned()),
        "alias: {found:?}"
    );
    let response = locator.search(&q("auth")).unwrap();
    let top = &response.results.items[0];
    assert_eq!(top.kind, LocatorEntityKind::Thread);
    assert!(
        !top.highlights.is_empty(),
        "the matched part is highlighted"
    );
    assert!(response.interpreted.expanded.contains(&"login".to_owned()));
    assert!(!top.semantic, "lexical ranking is never labelled semantic");

    // "login" reaches the same thread through the alias table.
    assert!(titles(&locator, &q("login")).contains(&"Authentication Refactor".to_owned()));
    // Stems: "refactoring" finds "Refactor".
    assert!(titles(&locator, &q("refactoring")).contains(&"Authentication Refactor".to_owned()));
    // Short words go through the LIKE path.
    assert!(titles(&locator, &q("at")).contains(&"atlas-api".to_owned()));
    locator.shutdown();
}

#[test]
fn filters_by_kind_status_provider_workspace_and_recency() {
    let dir = tempfile::tempdir().unwrap();
    let core = core_with_v10(dir.path());
    let a = workspace(&core, dir.path(), "alpha");
    let b = workspace(&core, dir.path(), "beta");
    let sources = FakeSources::new();
    sources.add(thread(
        "Payments retry",
        "codex",
        &a.id,
        &a.name,
        ThreadStatus::WaitingForPermission,
        &ago(1),
    ));
    sources.add(thread(
        "Payments docs",
        "claude-code",
        &b.id,
        &b.name,
        ThreadStatus::Completed,
        &ago(3),
    ));
    sources.add(thread(
        "Payments ledger",
        "claude-code",
        &a.id,
        &a.name,
        ThreadStatus::RunningTool,
        &ago(40),
    ));
    let locator = Locator::start(core.clone(), sources).expect("start");
    assert!(locator.wait_ready(WAIT));

    let mut query = q("payments");
    query.kinds = vec![LocatorEntityKind::Thread];
    assert_eq!(titles(&locator, &query).len(), 3);

    query.statuses = vec![LocatorStatusFilter::NeedsYou];
    assert_eq!(titles(&locator, &query), vec!["Payments retry"]);

    let mut by_provider = q("payments");
    by_provider.provider_id = Some(kalcode_contracts::agent::ProviderId::new("claude-code"));
    by_provider.sort = LocatorSort::Recency;
    assert_eq!(
        titles(&locator, &by_provider),
        vec!["Payments docs", "Payments ledger"]
    );

    let mut by_workspace = q("payments");
    by_workspace.workspace_id = Some(b.id.clone());
    assert_eq!(titles(&locator, &by_workspace), vec!["Payments docs"]);

    // Filter words typed in the text do the same.
    assert_eq!(
        titles(&locator, &q("payments waiting")),
        vec!["Payments retry"]
    );
    assert_eq!(
        titles(&locator, &q("codex payments")),
        vec!["Payments retry"]
    );
    let running = titles(&locator, &q("payments running now"));
    assert_eq!(running, vec!["Payments ledger"]);

    // "Yesterday" relative to a clock one day ahead covers everything done "today".
    let tomorrow = OffsetDateTime::now_utc() + time::Duration::days(1);
    let yesterday = locator
        .search_at(
            &LocatorQuery {
                recency: Some(LocatorRecency::Yesterday),
                kinds: vec![LocatorEntityKind::Thread],
                ..LocatorQuery::default()
            },
            tomorrow,
        )
        .unwrap();
    assert!(!yesterday.results.items.is_empty());

    // A filter word that is really part of a title: retried as plain text.
    let dir2 = tempfile::tempdir().unwrap();
    let core2 = core_with_v10(dir2.path());
    let ws2 = workspace(&core2, dir2.path(), "gamma");
    let sources2 = FakeSources::new();
    sources2.add(thread(
        "Error handling cleanup",
        "claude-code",
        &ws2.id,
        &ws2.name,
        ThreadStatus::Idle,
        &ago(1),
    ));
    let locator2 = Locator::start(core2.clone(), sources2).expect("start");
    assert!(locator2.wait_ready(WAIT));
    assert_eq!(
        titles(&locator2, &q("failed error handling")),
        vec!["Error handling cleanup"]
    );
    locator.shutdown();
    locator2.shutdown();
}

#[test]
fn what_was_i_working_on_yesterday() {
    let dir = tempfile::tempdir().unwrap();
    let core = core_with_v10(dir.path());
    let ws = workspace(&core, dir.path(), "kalcode");
    let sources = FakeSources::new();
    sources.add(thread(
        "Rail persistence",
        "claude-code",
        &ws.id,
        &ws.name,
        ThreadStatus::Idle,
        &ago(0),
    ));
    let locator = Locator::start(core.clone(), sources).expect("start");
    assert!(locator.wait_ready(WAIT));
    let tomorrow = OffsetDateTime::now_utc() + time::Duration::days(1);
    let response = locator
        .search_at(&q("find what I was working on yesterday"), tomorrow)
        .unwrap();
    assert_eq!(
        response.interpreted.recency,
        Some(LocatorRecency::Yesterday)
    );
    assert!(response.interpreted.terms.is_empty());
    let found: Vec<&str> = response
        .results
        .items
        .iter()
        .map(|r| r.title.as_str())
        .collect();
    assert!(found.contains(&"Rail persistence"), "{found:?}");
    assert!(found.contains(&"kalcode"), "{found:?}");
    // And today (relative to now) it is today, not yesterday.
    let today = locator
        .search(&q("what was I working on yesterday"))
        .unwrap();
    assert!(
        today
            .results
            .items
            .iter()
            .all(|r| r.title != "Rail persistence")
    );
    locator.shutdown();
}

#[test]
fn indexes_incrementally_from_events_and_forgets_removed_items() {
    let dir = tempfile::tempdir().unwrap();
    let core = core_with_v10(dir.path());
    let ws = workspace(&core, dir.path(), "orbit");
    let sources = FakeSources::new();
    let locator = Locator::start(core.clone(), sources.clone()).expect("start");
    assert!(locator.wait_ready(WAIT));
    assert!(titles(&locator, &q("orbit")).contains(&"orbit".to_owned()));

    let t = thread(
        "Subscription guard",
        "claude-code",
        &ws.id,
        &ws.name,
        ThreadStatus::Starting,
        &ago(0),
    );
    sources.add(t.clone());
    core.emit(NewEvent {
        source: kalcode_contracts::events::EventSource::Core,
        correlation: Correlation {
            workspace_id: Some(ws.id.clone()),
            thread_id: Some(t.id.clone()),
            ..Correlation::default()
        },
        event: EventPayload::ThreadCreated {
            thread_id: t.id.clone(),
            name: t.name.clone(),
            provider_id: t.provider_id.clone(),
            workspace_id: ws.id.clone(),
        },
    })
    .unwrap();
    assert!(locator.flush(WAIT));
    let hit = locator.search(&q("subscription")).unwrap();
    assert_eq!(hit.results.items[0].status.as_deref(), Some("starting"));

    sources.set_status(&t.id, ThreadStatus::Completed);
    core.emit(NewEvent::core(EventPayload::ThreadCompleted {
        thread_id: t.id.clone(),
    }))
    .unwrap();
    assert!(locator.flush(WAIT));
    let hit = locator.search(&q("subscription guard")).unwrap();
    assert_eq!(hit.results.items[0].status.as_deref(), Some("done"));
    // The completion is findable as activity too.
    let mut activity = q("subscription");
    activity.kinds = vec![LocatorEntityKind::Activity];
    assert_eq!(
        titles(&locator, &activity),
        vec!["Completed · Subscription guard"]
    );

    // Removing the workspace from KalCode drops it from the index (files untouched).
    core.remove_workspace(&ws.id).unwrap();
    assert!(locator.flush(WAIT));
    let mut workspaces = q("orbit");
    workspaces.kinds = vec![LocatorEntityKind::Workspace];
    assert!(titles(&locator, &workspaces).is_empty());
    assert!(
        dir.path().join("orbit").exists(),
        "the folder is never touched"
    );
    locator.shutdown();
}

#[test]
fn privacy_names_are_redacted_queries_never_stored_messages_off_by_default() {
    let dir = tempfile::tempdir().unwrap();
    let core = core_with_v10(dir.path());
    let ws = workspace(&core, dir.path(), "vault");
    let sources = FakeSources::new();
    let secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    let leaky = thread(
        &format!("Rotate token {secret}"),
        "claude-code",
        &ws.id,
        &ws.name,
        ThreadStatus::Idle,
        &ago(1),
    );
    let quiet = thread(
        "Quarterly report",
        "claude-code",
        &ws.id,
        &ws.name,
        ThreadStatus::Idle,
        &ago(1),
    );
    sources.texts.lock().unwrap().insert(
        quiet.id.clone(),
        "we discussed the zebracorn migration plan".into(),
    );
    sources.add(leaky);
    sources.add(quiet.clone());
    let locator = Locator::start(core.clone(), sources).expect("start");
    assert!(locator.wait_ready(WAIT));

    let hit = locator.search(&q("rotate token")).unwrap();
    let title = &hit.results.items[0].title;
    assert!(!title.contains(secret), "{title}");
    assert!(title.contains("[REDACTED]"), "{title}");

    // Message text is not indexed by default.
    assert!(titles(&locator, &q("zebracorn")).is_empty());
    // Opting the workspace in indexes it; the result says where it matched, never the text.
    locator
        .rail_update(&RailUpdate {
            workspace_id: ws.id.clone(),
            index_messages: Some(true),
            ..RailUpdate::default()
        })
        .unwrap();
    // Re-index the thread (a new message would do this).
    core.emit(NewEvent::core(EventPayload::ThreadRenamed {
        thread_id: quiet.id.clone(),
        name: quiet.name.clone(),
    }))
    .unwrap();
    assert!(locator.flush(WAIT));
    let hit = locator.search(&q("zebracorn")).unwrap();
    assert_eq!(hit.results.items.len(), 1);
    assert_eq!(hit.results.items[0].title, "Quarterly report");
    let snippet = hit.results.items[0].snippet.clone().unwrap();
    assert!(!snippet.contains("zebracorn"), "{snippet}");

    // A distinctive query leaves no trace in the database or the event log.
    let marker = "qzxv-distinctive-query-7781";
    let _ = locator.search(&q(marker)).unwrap();
    let _ = locator
        .open(LocatorEntityKind::Workspace, &ws.id, LocatorVia::Palette)
        .unwrap();
    locator.shutdown();
    let stored: i64 = core
        .reader()
        .query_row(
            "SELECT COUNT(*) FROM events WHERE payload LIKE ?1",
            [format!("%{marker}%")],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(stored, 0);
    drop(core);
    for file in ["kalcode.db", "kalcode.db-wal"] {
        if let Ok(bytes) = std::fs::read(dir.path().join(file)) {
            let hay = String::from_utf8_lossy(&bytes);
            assert!(!hay.contains(marker), "{file} contains the query");
        }
    }
}

#[test]
fn a_damaged_index_is_rebuilt_without_touching_anything_else() {
    let dir = tempfile::tempdir().unwrap();
    let core = core_with_v10(dir.path());
    let ws = workspace(&core, dir.path(), "phoenix");
    let sources = FakeSources::new();
    sources.add(thread(
        "Checkout flow",
        "claude-code",
        &ws.id,
        &ws.name,
        ThreadStatus::Idle,
        &ago(1),
    ));
    let locator = Locator::start(core.clone(), sources).expect("start");
    assert!(locator.wait_ready(WAIT));
    locator
        .rail_update(&RailUpdate {
            workspace_id: ws.id.clone(),
            pinned: Some(true),
            ..RailUpdate::default()
        })
        .unwrap();
    // Damage the FTS index's storage.
    core.write_with_events(|tx| {
        tx.execute("DELETE FROM locator_fts_data WHERE id > 1", [])?;
        tx.execute("UPDATE locator_fts_data SET block = x'00ff00ff'", [])?;
        Ok(((), Vec::new()))
    })
    .unwrap();
    // The first search notices, answers nothing, and queues a rebuild.
    let _ = locator.search(&q("checkout"));
    assert!(locator.wait_ready(WAIT));
    assert!(locator.flush(WAIT));
    assert_eq!(titles(&locator, &q("checkout")), vec!["Checkout flow"]);
    // Rail state and the workspace are intact.
    assert_eq!(locator.rail_state().unwrap().pinned.len(), 1);
    assert_eq!(core.workspaces().unwrap().len(), 1);
    locator.shutdown();
}

#[test]
fn without_v10_everything_works_for_the_session() {
    let dir = tempfile::tempdir().unwrap();
    let core = core_without_v10(dir.path());
    let ws = workspace(&core, dir.path(), "nimbus");
    let sources = FakeSources::new();
    let locator = Locator::start(core.clone(), sources).expect("start");
    assert!(locator.wait_ready(WAIT));
    assert!(!locator.index_state().unwrap().persistent);
    assert!(titles(&locator, &q("nimbus")).contains(&"nimbus".to_owned()));
    let state = locator
        .rail_update(&RailUpdate {
            workspace_id: ws.id.clone(),
            pinned: Some(true),
            ..RailUpdate::default()
        })
        .unwrap();
    assert!(state.pinned);
    assert!(!locator.rail_state().unwrap().persistent);
    // Nothing was written to the user's database under an unknown schema.
    let n: i64 = core
        .reader()
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'locator%' OR name LIKE 'workspace_rail%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 0);
    assert!(matches!(Store::memory().unwrap(), Store::Memory(_)));
    locator.shutdown();
}

#[test]
fn search_input_is_validated() {
    let dir = tempfile::tempdir().unwrap();
    let core = core_with_v10(dir.path());
    let locator = Locator::start(core.clone(), FakeSources::new()).expect("start");
    let mut bad = q("x");
    bad.workspace_id = Some("../etc".into());
    assert_eq!(locator.search(&bad).unwrap_err().code, "invalid_id");
    let mut bad = q("x");
    bad.page = Some(kalcode_contracts::refs::PageRequest {
        limit: 0,
        cursor: None,
    });
    assert_eq!(locator.search(&bad).unwrap_err().code, "invalid_page_size");
    let mut bad = q("x");
    bad.tz_offset_minutes = 5000;
    assert_eq!(locator.search(&bad).unwrap_err().code, "invalid_offset");
    let mut bad = q("x");
    bad.since = Some("yesterday-ish".into());
    assert_eq!(locator.search(&bad).unwrap_err().code, "invalid_time");
    // Hostile text is only ever data.
    for text in [
        "\" OR 1=1 --",
        "title:*",
        "NEAR(a b)",
        "'; DROP TABLE locator_entries; --",
        "%_\\",
    ] {
        locator.search(&q(text)).expect(text);
    }
    assert_eq!(
        locator
            .open(LocatorEntityKind::Thread, "not-an-id", LocatorVia::Palette)
            .unwrap_err()
            .code,
        "not_found"
    );
    locator.shutdown();
}
