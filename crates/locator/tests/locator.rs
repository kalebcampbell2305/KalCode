//! Session Locator (LOC) behaviour against a real core: search quality, filters, privacy,
//! incremental indexing from the event bus, corruption recovery and the isolated migration.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod common;

use std::time::Duration;

use common::{FakeSources, core_with_v11, core_without_v11, thread, workspace};
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
    ago_at(OffsetDateTime::now_utc(), hours)
}

fn ago_at(now: OffsetDateTime, hours: i64) -> String {
    format_rfc3339(now - time::Duration::hours(hours))
}

fn reference_noon_utc() -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp(1_790_337_600).expect("2026-09-25T12:00:00Z")
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
fn migration_is_registered_as_v11_and_well_formed() {
    assert_eq!(RAIL_LOCATOR_MIGRATION.version, 11);
    assert_eq!(RAIL_LOCATOR_MIGRATION.name, "rail_locator");
    assert!(
        MIGRATIONS
            .iter()
            .any(|m| m.version == 11 && m.name == "rail_locator"),
        "v11 is registered in kalcode_core::db::MIGRATIONS"
    );
    let dir = tempfile::tempdir().unwrap();
    let core = core_with_v11(dir.path());
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
    assert_eq!(kalcode_core::db::schema_version(&conn).unwrap(), 11);
}

#[test]
fn auth_finds_authentication_refactor_first() {
    let dir = tempfile::tempdir().unwrap();
    let core = core_with_v11(dir.path());
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
    // A newer synonym match that needs you still ranks below the word as typed.
    sources.add(thread(
        "Login page copy",
        "codex",
        &ws.id,
        &ws.name,
        ThreadStatus::WaitingForPermission,
        &ago(1),
    ));
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
    let core = core_with_v11(dir.path());
    let a = workspace(&core, dir.path(), "alpha");
    let b = workspace(&core, dir.path(), "beta");
    let sources = FakeSources::new();
    let reference = reference_noon_utc();
    sources.add(thread(
        "Payments retry",
        "codex",
        &a.id,
        &a.name,
        ThreadStatus::WaitingForPermission,
        &ago_at(reference, 1),
    ));
    sources.add(thread(
        "Payments docs",
        "claude-code",
        &b.id,
        &b.name,
        ThreadStatus::Completed,
        &ago_at(reference, 3),
    ));
    sources.add(thread(
        "Payments ledger",
        "claude-code",
        &a.id,
        &a.name,
        ThreadStatus::RunningTool,
        &ago_at(reference, 40),
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
    let tomorrow = reference + time::Duration::days(1);
    let mut yesterday = locator
        .search_at(
            &LocatorQuery {
                recency: Some(LocatorRecency::Yesterday),
                kinds: vec![LocatorEntityKind::Thread],
                ..LocatorQuery::default()
            },
            tomorrow,
        )
        .unwrap()
        .results
        .items
        .into_iter()
        .map(|item| item.title)
        .collect::<Vec<_>>();
    yesterday.sort();
    assert_eq!(yesterday, vec!["Payments docs", "Payments retry"]);

    // A filter word that is really part of a title: retried as plain text.
    let dir2 = tempfile::tempdir().unwrap();
    let core2 = core_with_v11(dir2.path());
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
    let core = core_with_v11(dir.path());
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
    let core = core_with_v11(dir.path());
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
    let core = core_with_v11(dir.path());
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
fn enabling_message_search_reindexes_existing_workspace_threads() {
    let dir = tempfile::tempdir().unwrap();
    let core = core_with_v11(dir.path());
    let ws = workspace(&core, dir.path(), "message-opt-in");
    let sources = FakeSources::new();
    let existing = thread(
        "Existing conversation",
        "claude-code",
        &ws.id,
        &ws.name,
        ThreadStatus::Idle,
        &ago(1),
    );
    sources
        .texts
        .lock()
        .unwrap()
        .insert(existing.id.clone(), "existing-message-search-marker".into());
    sources.add(existing);
    let locator = Locator::start(core.clone(), sources).expect("start");
    assert!(locator.wait_ready(WAIT));
    assert!(titles(&locator, &q("existing-message-search-marker")).is_empty());

    locator
        .rail_update(&RailUpdate {
            workspace_id: ws.id,
            index_messages: Some(true),
            ..RailUpdate::default()
        })
        .unwrap();
    assert!(locator.flush(WAIT));

    assert_eq!(
        titles(&locator, &q("existing-message-search-marker")),
        vec!["Existing conversation"]
    );
    locator.shutdown();
}

#[test]
fn disabling_message_search_purges_immediately_and_survives_restart() {
    let dir = tempfile::tempdir().unwrap();
    let core = core_with_v11(dir.path());
    let ws = workspace(&core, dir.path(), "message-opt-out");
    let sources = FakeSources::new();
    let existing = thread(
        "Private conversation",
        "claude-code",
        &ws.id,
        &ws.name,
        ThreadStatus::Idle,
        &ago(1),
    );
    sources
        .texts
        .lock()
        .unwrap()
        .insert(existing.id.clone(), "private-message-search-marker".into());
    sources.add(existing.clone());
    let locator = Locator::start(core.clone(), sources.clone()).expect("start");
    assert!(locator.wait_ready(WAIT));
    locator
        .rail_update(&RailUpdate {
            workspace_id: ws.id.clone(),
            index_messages: Some(true),
            ..RailUpdate::default()
        })
        .unwrap();
    core.emit(NewEvent::core(EventPayload::ThreadRenamed {
        thread_id: existing.id,
        name: existing.name,
    }))
    .unwrap();
    assert!(locator.flush(WAIT));
    assert_eq!(
        titles(&locator, &q("private-message-search-marker")),
        vec!["Private conversation"]
    );

    locator
        .rail_update(&RailUpdate {
            workspace_id: ws.id,
            index_messages: Some(false),
            ..RailUpdate::default()
        })
        .unwrap();
    assert!(
        titles(&locator, &q("private-message-search-marker")).is_empty(),
        "the opt-out must purge before rail_update returns"
    );
    locator.shutdown();

    let restarted = Locator::start(core.clone(), sources).expect("restart");
    assert!(restarted.wait_ready(WAIT));
    assert!(
        titles(&restarted, &q("private-message-search-marker")).is_empty(),
        "the opt-out must remain effective after a persistent-index rebuild"
    );
    restarted.shutdown();
}

#[test]
fn message_opt_out_wins_against_an_in_flight_opted_in_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let core = core_with_v11(dir.path());
    let ws = workspace(&core, dir.path(), "message-opt-out-race");
    let sources = FakeSources::new();
    let existing = thread(
        "Racing private conversation",
        "claude-code",
        &ws.id,
        &ws.name,
        ThreadStatus::Idle,
        &ago(1),
    );
    sources
        .texts
        .lock()
        .unwrap()
        .insert(existing.id.clone(), "racing-private-message-marker".into());
    sources.add(existing.clone());
    let locator = Locator::start(core.clone(), sources.clone()).expect("start");
    assert!(locator.wait_ready(WAIT));
    locator
        .rail_update(&RailUpdate {
            workspace_id: ws.id.clone(),
            index_messages: Some(true),
            ..RailUpdate::default()
        })
        .unwrap();
    core.emit(NewEvent::core(EventPayload::ThreadRenamed {
        thread_id: existing.id.clone(),
        name: existing.name.clone(),
    }))
    .unwrap();
    assert!(locator.flush(WAIT));
    assert_eq!(
        titles(&locator, &q("racing-private-message-marker")),
        vec!["Racing private conversation"]
    );

    // Pause an incremental update after it observed the opted-in rail row but before it writes.
    sources.block_next_thread_read();
    core.emit(NewEvent::core(EventPayload::ThreadRenamed {
        thread_id: existing.id,
        name: existing.name,
    }))
    .unwrap();
    assert!(sources.wait_until_thread_read_blocked(WAIT));
    locator
        .rail_update(&RailUpdate {
            workspace_id: ws.id,
            index_messages: Some(false),
            ..RailUpdate::default()
        })
        .unwrap();
    let absent_when_opt_out_returns =
        titles(&locator, &q("racing-private-message-marker")).is_empty();
    sources.release_thread_read();
    assert!(locator.flush(WAIT));
    let absent_after_stale_update =
        titles(&locator, &q("racing-private-message-marker")).is_empty();

    assert!(
        absent_when_opt_out_returns,
        "the synchronous opt-out must remove the previously indexed body"
    );
    assert!(
        absent_after_stale_update,
        "the paused opted-in snapshot must not restore the private body"
    );
    locator.shutdown();
}

#[test]
fn rebuild_cannot_restore_message_body_from_pre_opt_out_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let core = core_with_v11(dir.path());
    let ws = workspace(&core, dir.path(), "message-opt-out-rebuild-race");
    let sources = FakeSources::new();
    let existing = thread(
        "Rebuilding private conversation",
        "claude-code",
        &ws.id,
        &ws.name,
        ThreadStatus::Idle,
        &ago(1),
    );
    sources.texts.lock().unwrap().insert(
        existing.id.clone(),
        "rebuilding-private-message-marker".into(),
    );
    sources.add(existing);
    let locator = Locator::start(core.clone(), sources.clone()).expect("start");
    assert!(locator.wait_ready(WAIT));
    locator
        .rail_update(&RailUpdate {
            workspace_id: ws.id.clone(),
            index_messages: Some(true),
            ..RailUpdate::default()
        })
        .unwrap();
    assert!(locator.flush(WAIT));
    assert_eq!(
        titles(&locator, &q("rebuilding-private-message-marker")),
        vec!["Rebuilding private conversation"]
    );
    locator.shutdown();

    // Restart blocks after the rebuild captured the opted-in rail row. Opting out must purge the
    // existing body synchronously, and the stale rebuild snapshot must not restore it.
    sources.block_next_thread_read();
    let restarted = Locator::start(core, sources.clone()).expect("restart");
    assert!(sources.wait_until_thread_read_blocked(WAIT));
    restarted
        .rail_update(&RailUpdate {
            workspace_id: ws.id,
            index_messages: Some(false),
            ..RailUpdate::default()
        })
        .unwrap();
    let absent_when_opt_out_returns =
        titles(&restarted, &q("rebuilding-private-message-marker")).is_empty();
    sources.release_thread_read();
    assert!(restarted.wait_ready(WAIT));
    assert!(restarted.flush(WAIT));
    let absent_after_rebuild =
        titles(&restarted, &q("rebuilding-private-message-marker")).is_empty();
    restarted.shutdown();

    assert!(
        absent_when_opt_out_returns,
        "the opt-out must synchronously remove the old body"
    );
    assert!(
        absent_after_rebuild,
        "the rebuild's stale opted-in snapshot must not restore the body"
    );
}

fn observe_removed_workspace_before_index_cleanup(
    session_only: bool,
) -> (Vec<String>, Option<String>, Option<String>) {
    let dir = tempfile::tempdir().unwrap();
    let core = core_with_v11(dir.path());
    let ws = workspace(&core, dir.path(), "removed-before-cleanup");
    let sources = FakeSources::new();
    let stale_thread = thread(
        "Deleted private conversation",
        "claude-code",
        &ws.id,
        &ws.name,
        ThreadStatus::Idle,
        &ago(1),
    );
    sources.texts.lock().unwrap().insert(
        stale_thread.id.clone(),
        "deleted-workspace-private-marker".into(),
    );
    sources.add(stale_thread.clone());
    let locator = if session_only {
        Locator::start_with_store(core.clone(), sources.clone(), Store::memory().unwrap())
            .expect("start session-only locator")
    } else {
        Locator::start(core.clone(), sources.clone()).expect("start persistent locator")
    };
    assert!(locator.wait_ready(WAIT));
    locator
        .rail_update(&RailUpdate {
            workspace_id: ws.id.clone(),
            index_messages: Some(true),
            ..RailUpdate::default()
        })
        .unwrap();
    assert!(locator.flush(WAIT));
    assert_eq!(
        titles(&locator, &q("deleted-workspace-private-marker")),
        vec!["Deleted private conversation"]
    );
    let activity = core
        .emit(NewEvent {
            source: kalcode_contracts::events::EventSource::Core,
            correlation: Correlation {
                workspace_id: Some(ws.id.clone()),
                thread_id: Some(stale_thread.id.clone()),
                ..Correlation::default()
            },
            event: EventPayload::ThreadCompleted {
                thread_id: stale_thread.id.clone(),
            },
        })
        .unwrap();
    assert!(locator.flush(WAIT));

    // Hold the only indexing worker so WorkspaceRemoved is known to be queued but unapplied.
    sources.block_next_thread_read();
    core.emit(NewEvent::core(EventPayload::ThreadRenamed {
        thread_id: stale_thread.id.clone(),
        name: stale_thread.name.clone(),
    }))
    .unwrap();
    assert!(sources.wait_until_thread_read_blocked(WAIT));
    let removed = core.remove_workspace(&ws.id);
    let visible = titles(&locator, &q("deleted-workspace-private-marker"));
    let open_error = locator
        .open(
            LocatorEntityKind::Thread,
            &stale_thread.id,
            LocatorVia::Palette,
        )
        .err()
        .map(|error| error.code.to_owned());
    let activity_open_error = locator
        .open(
            LocatorEntityKind::Activity,
            &activity.id,
            LocatorVia::Palette,
        )
        .err()
        .map(|error| error.code.to_owned());
    sources.release_thread_read();
    assert!(locator.flush(WAIT));
    locator.shutdown();
    removed.unwrap();
    (visible, open_error, activity_open_error)
}

#[test]
fn removed_workspace_is_hidden_before_persistent_index_cleanup() {
    let (visible, open_error, activity_open_error) =
        observe_removed_workspace_before_index_cleanup(false);
    assert!(
        visible.is_empty(),
        "search must consult workspace authority instead of exposing queued stale rows"
    );
    assert_eq!(open_error.as_deref(), Some("not_found"));
    assert_eq!(activity_open_error.as_deref(), Some("not_found"));
}

#[test]
fn removed_workspace_is_hidden_before_session_index_cleanup() {
    let (visible, open_error, activity_open_error) =
        observe_removed_workspace_before_index_cleanup(true);
    assert!(
        visible.is_empty(),
        "the session-only index must have the same privacy boundary"
    );
    assert_eq!(open_error.as_deref(), Some("not_found"));
    assert_eq!(activity_open_error.as_deref(), Some("not_found"));
}

#[test]
fn workspace_removal_purges_all_derived_rows_and_stale_events_cannot_restore_them() {
    let dir = tempfile::tempdir().unwrap();
    let core = core_with_v11(dir.path());
    let ws = workspace(&core, dir.path(), "removed-private-workspace");
    let sources = FakeSources::new();
    let stale_thread = thread(
        "Removed workspace sentinel",
        "claude-code",
        &ws.id,
        &ws.name,
        ThreadStatus::Idle,
        &ago(1),
    );
    sources.texts.lock().unwrap().insert(
        stale_thread.id.clone(),
        "removed-workspace-body-marker".into(),
    );
    sources.add(stale_thread.clone());
    let locator = Locator::start(core.clone(), sources.clone()).expect("start");
    assert!(locator.wait_ready(WAIT));
    locator
        .rail_update(&RailUpdate {
            workspace_id: ws.id.clone(),
            index_messages: Some(true),
            ..RailUpdate::default()
        })
        .unwrap();
    core.emit(NewEvent {
        source: kalcode_contracts::events::EventSource::Core,
        correlation: Correlation {
            workspace_id: Some(ws.id.clone()),
            thread_id: Some(stale_thread.id.clone()),
            ..Correlation::default()
        },
        event: EventPayload::ThreadCompleted {
            thread_id: stale_thread.id.clone(),
        },
    })
    .unwrap();
    assert!(locator.flush(WAIT));
    assert_eq!(
        titles(&locator, &q("removed-workspace-body-marker")),
        vec!["Removed workspace sentinel"]
    );
    let mut activity = q("removed workspace sentinel");
    activity.kinds = vec![LocatorEntityKind::Activity];
    assert_eq!(
        titles(&locator, &activity),
        vec!["Completed · Removed workspace sentinel"]
    );

    core.remove_workspace(&ws.id).unwrap();
    core.emit(NewEvent::core(EventPayload::ThreadRenamed {
        thread_id: stale_thread.id.clone(),
        name: stale_thread.name.clone(),
    }))
    .unwrap();
    assert!(locator.flush(WAIT));
    for marker in [
        "removed workspace sentinel",
        "removed-workspace-body-marker",
    ] {
        assert!(titles(&locator, &q(marker)).is_empty(), "marker: {marker}");
    }
    let indexed_for_workspace: i64 = core
        .reader()
        .query_row(
            "SELECT COUNT(*) FROM locator_entries WHERE workspace_id = ?1",
            [&ws.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        indexed_for_workspace, 0,
        "thread and activity rows are derived"
    );
    assert!(
        sources
            .threads
            .lock()
            .unwrap()
            .iter()
            .any(|thread| thread.id == stale_thread.id),
        "the locator must not mutate the canonical thread/message source"
    );
    locator.shutdown();

    let restarted = Locator::start(core.clone(), sources).expect("restart");
    assert!(restarted.wait_ready(WAIT));
    assert!(
        titles(&restarted, &q("removed-workspace-body-marker")).is_empty(),
        "a rebuild must not resurrect a thread whose workspace is gone"
    );
    assert!(
        titles(&restarted, &q("removed workspace sentinel")).is_empty(),
        "a rebuild must not resurrect thread or activity metadata"
    );
    restarted.shutdown();
}

#[test]
fn a_damaged_index_is_rebuilt_without_touching_anything_else() {
    let dir = tempfile::tempdir().unwrap();
    let core = core_with_v11(dir.path());
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
fn without_v11_everything_works_for_the_session() {
    let dir = tempfile::tempdir().unwrap();
    let core = core_without_v11(dir.path());
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
    let core = core_with_v11(dir.path());
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
