//! The workspace rail (persistence across restart, groups, counts) and the returning-user home
//! (greeting from the Settings display name only, real-state summary, recent work).

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod common;

use common::{FakeSources, core_with_v11, thread, workspace};
use kalcode_contracts::events::{Correlation, EventPayload, EventSource};
use kalcode_contracts::refs::PageRequest;
use kalcode_contracts::threads::ThreadStatus;
use kalcode_core::events::NewEvent;
use kalcode_core::settings::SettingsPatch;
use kalcode_core::time::format_rfc3339;
use kalcode_locator::{Locator, RailSection, RailUpdate, RecentWorkKind, RecentWorkWhen};
use time::OffsetDateTime;

fn now() -> String {
    format_rfc3339(OffsetDateTime::now_utc())
}

#[test]
fn rail_state_persists_across_restart() {
    let dir = tempfile::tempdir().unwrap();
    let (a_id, b_id, c_id, group_id);
    {
        let core = core_with_v11(dir.path());
        let a = workspace(&core, dir.path(), "alpha");
        let b = workspace(&core, dir.path(), "beta");
        let c = workspace(&core, dir.path(), "gamma");
        let _d = workspace(&core, dir.path(), "delta");
        let locator = Locator::start(core.clone(), FakeSources::new()).expect("start");
        let pin = |id: &str| RailUpdate {
            workspace_id: id.to_owned(),
            pinned: Some(true),
            ..RailUpdate::default()
        };
        locator.rail_update(&pin(&b.id)).unwrap();
        locator.rail_update(&pin(&a.id)).unwrap();
        // Reorder: alpha first.
        locator
            .rail_update(&RailUpdate {
                workspace_id: a.id.clone(),
                position: Some(0),
                ..RailUpdate::default()
            })
            .unwrap();
        let group = locator.group_create("Client work").unwrap();
        locator
            .rail_update(&RailUpdate {
                workspace_id: c.id.clone(),
                group_id: Some(group.id.clone()),
                name: Some("Gamma (client)".into()),
                collapsed: Some(true),
                ..RailUpdate::default()
            })
            .unwrap();
        locator.group_update(&group.id, None, Some(true)).unwrap();
        locator
            .set_section_collapsed(RailSection::Recent, true)
            .unwrap();
        let archived = locator
            .rail_update(&RailUpdate {
                workspace_id: _d.id.clone(),
                archived: Some(true),
                ..RailUpdate::default()
            })
            .unwrap();
        assert!(archived.archived);
        (a_id, b_id, c_id, group_id) = (a.id, b.id, c.id, group.id);
        locator.shutdown();
        core.shutdown();
    }
    // Relaunch.
    let core = core_with_v11(dir.path());
    let locator = Locator::start(core.clone(), FakeSources::new()).expect("restart");
    let state = locator.rail_state().unwrap();
    assert!(state.persistent);
    let pinned: Vec<&str> = state
        .pinned
        .iter()
        .map(|e| e.workspace_id.as_str())
        .collect();
    assert_eq!(pinned, vec![a_id.as_str(), b_id.as_str()]);
    assert_eq!(state.groups.len(), 1);
    assert_eq!(state.groups[0].group.id, group_id);
    assert!(state.groups[0].group.collapsed);
    let gamma = &state.groups[0].workspaces[0];
    assert_eq!(gamma.workspace_id, c_id);
    assert_eq!(gamma.name, "Gamma (client)");
    assert_eq!(gamma.folder_name, "gamma");
    assert!(gamma.collapsed);
    assert_eq!(state.archived.len(), 1);
    assert!(state.recent.is_empty());
    assert_eq!(state.collapsed_sections, vec![RailSection::Recent]);
    // Renaming in the rail never renames the folder.
    assert!(dir.path().join("gamma").is_dir());

    // Unarchive, reset the name, leave the folder, delete the folder group.
    locator
        .rail_update(&RailUpdate {
            workspace_id: state.archived[0].workspace_id.clone(),
            archived: Some(false),
            ..RailUpdate::default()
        })
        .unwrap();
    locator
        .rail_update(&RailUpdate {
            workspace_id: c_id.clone(),
            name: Some("   ".into()),
            ..RailUpdate::default()
        })
        .unwrap();
    locator.group_delete(&group_id).unwrap();
    let state = locator.rail_state().unwrap();
    assert!(state.groups.is_empty());
    assert_eq!(state.recent.len(), 2);
    assert!(state.recent.iter().any(|e| e.name == "gamma"));
    locator.shutdown();
}

#[test]
fn pinned_order_and_unavailable_project_survive_recency_changes_and_restart() {
    let dir = tempfile::tempdir().unwrap();
    let sources = FakeSources::new();
    let (alpha_id, beta_id, gamma_id);
    {
        let core = core_with_v11(dir.path());
        let alpha = workspace(&core, dir.path(), "alpha");
        let beta = workspace(&core, dir.path(), "beta");
        let gamma = workspace(&core, dir.path(), "gamma");
        let locator = Locator::start(core.clone(), sources.clone()).expect("start");

        for workspace_id in [&alpha.id, &beta.id, &gamma.id] {
            locator
                .rail_update(&RailUpdate {
                    workspace_id: workspace_id.clone(),
                    pinned: Some(true),
                    ..RailUpdate::default()
                })
                .unwrap();
        }
        // Arrange the pins independently from workspace activation and thread recency.
        locator
            .rail_update(&RailUpdate {
                workspace_id: gamma.id.clone(),
                position: Some(0),
                ..RailUpdate::default()
            })
            .unwrap();
        locator
            .rail_update(&RailUpdate {
                workspace_id: beta.id.clone(),
                position: Some(1),
                ..RailUpdate::default()
            })
            .unwrap();

        core.activate_workspace(&alpha.id).unwrap();
        sources.add(thread(
            "Newest work",
            "claude-code",
            &alpha.id,
            &alpha.name,
            ThreadStatus::Active,
            "9999-12-31T23:59:59Z",
        ));
        std::fs::rename(dir.path().join("beta"), dir.path().join("beta-moved"))
            .expect("move pinned project folder");

        let state = locator.rail_state().unwrap();
        let pinned: Vec<&str> = state
            .pinned
            .iter()
            .map(|entry| entry.workspace_id.as_str())
            .collect();
        assert_eq!(
            pinned,
            vec![gamma.id.as_str(), beta.id.as_str(), alpha.id.as_str()],
            "activation and newer work must not reorder manually arranged pins"
        );
        assert!(state.pinned[2].active);
        assert_eq!(state.pinned[2].last_activity_at, "9999-12-31T23:59:59Z");
        assert!(!state.pinned[1].available);

        (alpha_id, beta_id, gamma_id) = (alpha.id, beta.id, gamma.id);
        locator.shutdown();
        core.shutdown();
    }

    let core = core_with_v11(dir.path());
    let locator = Locator::start(core.clone(), sources).expect("restart");
    let state = locator.rail_state().unwrap();
    let pinned: Vec<&str> = state
        .pinned
        .iter()
        .map(|entry| entry.workspace_id.as_str())
        .collect();
    assert_eq!(
        pinned,
        vec![gamma_id.as_str(), beta_id.as_str(), alpha_id.as_str()]
    );
    let unavailable = state
        .pinned
        .iter()
        .find(|entry| entry.workspace_id == beta_id)
        .expect("unavailable project remains pinned after restart");
    assert!(!unavailable.available);
    locator.shutdown();
}

#[test]
fn rail_counts_threads_per_provider_and_badges() {
    let dir = tempfile::tempdir().unwrap();
    let core = core_with_v11(dir.path());
    let ws = workspace(&core, dir.path(), "atlas");
    let sources = FakeSources::new();
    let at = now();
    sources.add(thread(
        "A",
        "claude-code",
        &ws.id,
        &ws.name,
        ThreadStatus::RunningTool,
        &at,
    ));
    sources.add(thread(
        "B",
        "claude-code",
        &ws.id,
        &ws.name,
        ThreadStatus::WaitingForPermission,
        &at,
    ));
    sources.add(thread(
        "C",
        "codex",
        &ws.id,
        &ws.name,
        ThreadStatus::Completed,
        &at,
    ));
    sources.add(thread(
        "D",
        "codex",
        &ws.id,
        &ws.name,
        ThreadStatus::Failed,
        &at,
    ));
    let mut archived = thread("E", "codex", &ws.id, &ws.name, ThreadStatus::Idle, &at);
    archived.archived_at = Some(at.clone());
    sources.add(archived);
    let locator = Locator::start(core.clone(), sources).expect("start");
    let state = locator.rail_state().unwrap();
    let entry = &state.recent[0];
    assert!(entry.active, "the workspace just opened is active");
    assert_eq!(entry.threads, 4, "archived threads are not counted");
    assert_eq!(entry.working, 1);
    assert_eq!(
        entry.needs_you, 2,
        "permission required and failed need you"
    );
    let claude = entry
        .providers
        .iter()
        .find(|p| p.provider_id.as_str() == "claude-code")
        .unwrap();
    assert_eq!(
        (claude.threads, claude.working, claude.needs_you),
        (2, 1, 1)
    );
    let codex = entry
        .providers
        .iter()
        .find(|p| p.provider_id.as_str() == "codex")
        .unwrap();
    assert_eq!((codex.threads, codex.working, codex.needs_you), (2, 0, 1));
    assert_eq!(codex.items.len(), 2);
    locator.shutdown();
}

#[test]
fn rail_input_is_validated() {
    let dir = tempfile::tempdir().unwrap();
    let core = core_with_v11(dir.path());
    let ws = workspace(&core, dir.path(), "atlas");
    let locator = Locator::start(core.clone(), FakeSources::new()).expect("start");
    let err = |update: RailUpdate| locator.rail_update(&update).unwrap_err().code;
    assert_eq!(
        err(RailUpdate {
            workspace_id: "C:\\Windows".into(),
            ..RailUpdate::default()
        }),
        "invalid_id"
    );
    assert_eq!(
        err(RailUpdate {
            workspace_id: kalcode_contracts::ids::new_id(),
            pinned: Some(true),
            ..RailUpdate::default()
        }),
        "workspace_unknown"
    );
    assert_eq!(
        err(RailUpdate {
            workspace_id: ws.id.clone(),
            name: Some("x".repeat(81)),
            ..RailUpdate::default()
        }),
        "name_too_long"
    );
    assert_eq!(
        err(RailUpdate {
            workspace_id: ws.id.clone(),
            name: Some("evil\u{202E}name".into()),
            ..RailUpdate::default()
        }),
        "name_invalid"
    );
    assert_eq!(
        err(RailUpdate {
            workspace_id: ws.id.clone(),
            group_id: Some(kalcode_contracts::ids::new_id()),
            ..RailUpdate::default()
        }),
        "group_not_found"
    );
    assert_eq!(
        locator.group_create("  ").unwrap_err().code,
        "name_required"
    );
    let one = locator.group_create("One").unwrap();
    assert_eq!(
        locator.group_reorder(&[]).unwrap_err().code,
        "groups_mismatch"
    );
    assert_eq!(
        locator
            .group_reorder(std::slice::from_ref(&one.id))
            .unwrap()
            .len(),
        1
    );
    // Unknown fields in an update are refused by the wire type.
    let parsed: Result<RailUpdate, _> =
        serde_json::from_str(r#"{"workspaceId":"x","path":"C:\\"}"#);
    assert!(parsed.is_err());
    locator.shutdown();
}

#[test]
fn greeting_uses_only_the_settings_display_name() {
    let dir = tempfile::tempdir().unwrap();
    let core = core_with_v11(dir.path());
    let ws = workspace(&core, dir.path(), "home");
    let sources = FakeSources::new();
    sources.add(thread(
        "Anything",
        "claude-code",
        &ws.id,
        &ws.name,
        ThreadStatus::Idle,
        &now(),
    ));
    let locator = Locator::start(core.clone(), sources).expect("start");

    // No name set: exactly "Welcome back." (the OS account name is never used).
    let summary = locator.home_summary(9, true).unwrap();
    assert_eq!(summary.greeting, "Welcome back.");
    assert_eq!(summary.display_name, None);
    assert!(!summary.first_run);
    if let Ok(os_name) = std::env::var("USERNAME").or_else(|_| std::env::var("USER")) {
        assert!(!summary.greeting.contains(&os_name) || os_name.is_empty());
    }

    // Set: the greeting rotates and never repeats one of the last five.
    core.update_settings(&SettingsPatch {
        display_name: Some("Kaleb".into()),
        ..SettingsPatch::default()
    })
    .unwrap();
    let mut shown: Vec<String> = Vec::new();
    for _ in 0..30 {
        let greeting = locator.home_summary(10, true).unwrap().greeting;
        assert!(greeting.contains("Kaleb"), "{greeting}");
        let last_five: Vec<&String> = shown.iter().rev().take(5).collect();
        assert!(
            !last_five.contains(&&greeting),
            "{greeting} repeated: {last_five:?}"
        );
        shown.push(greeting);
    }

    // A live refresh keeps the greeting on screen; the next visit rotates.
    let shown_now = locator.home_summary(10, true).unwrap().greeting;
    assert_eq!(locator.home_summary(10, false).unwrap().greeting, shown_now);
    assert_ne!(locator.home_summary(10, true).unwrap().greeting, shown_now);

    // Cleared: back to "Welcome back.".
    core.update_settings(&SettingsPatch {
        display_name: Some(String::new()),
        ..SettingsPatch::default()
    })
    .unwrap();
    assert_eq!(
        locator.home_summary(22, true).unwrap().greeting,
        "Welcome back."
    );
    assert_eq!(
        locator.home_summary(24, true).unwrap_err().code,
        "invalid_hour"
    );
    locator.shutdown();
}

#[test]
fn home_summary_is_real_state_only() {
    let dir = tempfile::tempdir().unwrap();
    // First run: nothing exists, and nothing is invented.
    {
        let core = core_with_v11(dir.path());
        let locator = Locator::start(core.clone(), FakeSources::new()).expect("start");
        let summary = locator.home_summary(9, true).unwrap();
        assert!(summary.first_run);
        assert_eq!(summary.greeting, "Welcome to KalCode.");
        assert!(summary.last_session.is_empty());
        assert!(summary.running.is_empty());
        assert!(summary.needs_you.is_empty());
        assert!(summary.finished_since_last_visit.is_empty());
        assert!(summary.resumable.is_empty());
        assert!(summary.recent_workspaces.is_empty());
        locator.shutdown();
        core.shutdown();
    }
    // Session 2: work happens.
    let sources = FakeSources::new();
    let (ws_id, done_id);
    {
        let core = core_with_v11(dir.path());
        let ws = workspace(&core, dir.path(), "atlas");
        let working = thread(
            "Build the rail",
            "claude-code",
            &ws.id,
            &ws.name,
            ThreadStatus::Active,
            &now(),
        );
        let waiting = thread(
            "Needs approval",
            "codex",
            &ws.id,
            &ws.name,
            ThreadStatus::WaitingForPermission,
            &now(),
        );
        let stopped = thread(
            "Stopped one",
            "claude-code",
            &ws.id,
            &ws.name,
            ThreadStatus::Interrupted,
            &now(),
        );
        let done = thread(
            "Shipped thing",
            "claude-code",
            &ws.id,
            &ws.name,
            ThreadStatus::Completed,
            &now(),
        );
        for t in [&working, &waiting, &stopped, &done] {
            sources.add(t.clone());
            core.emit(NewEvent {
                source: EventSource::Core,
                correlation: Correlation {
                    workspace_id: Some(ws.id.clone()),
                    thread_id: Some(t.id.clone()),
                    ..Correlation::default()
                },
                event: EventPayload::ThreadStarted {
                    thread_id: t.id.clone(),
                },
            })
            .unwrap();
        }
        let locator = Locator::start(core.clone(), sources.clone()).expect("start");
        // Visiting home during session 2 sets the watermark before the completion.
        let _ = locator.home_summary(9, true).unwrap();
        locator.shutdown();
        core.emit(NewEvent::core(EventPayload::ThreadCompleted {
            thread_id: done.id.clone(),
        }))
        .unwrap();
        (ws_id, done_id) = (ws.id, done.id);
        core.shutdown();
    }
    // Session 3: the returning visit.
    let core = core_with_v11(dir.path());
    let locator = Locator::start(core.clone(), sources).expect("start");
    let summary = locator.home_summary(9, true).unwrap();
    assert!(!summary.first_run);
    assert_eq!(summary.greeting, "Welcome back.");
    let names = |items: &[kalcode_locator::RecentWorkItem]| {
        items.iter().map(|i| i.title.clone()).collect::<Vec<_>>()
    };
    assert_eq!(names(&summary.running), vec!["Build the rail"]);
    assert_eq!(names(&summary.needs_you), vec!["Needs approval"]);
    assert_eq!(names(&summary.resumable), vec!["Stopped one"]);
    assert_eq!(summary.finished_since_last_visit.len(), 1);
    assert_eq!(summary.finished_since_last_visit[0].id, done_id);
    let last: Vec<RecentWorkKind> = summary.last_session.iter().map(|i| i.kind).collect();
    assert!(last.contains(&RecentWorkKind::Thread));
    assert!(
        summary
            .last_session
            .iter()
            .any(|i| i.id == ws_id && i.kind == RecentWorkKind::Workspace)
    );
    assert_eq!(summary.recent_workspaces.len(), 1);
    // The list stays stable within the session (StrictMode double calls, re-renders)...
    assert_eq!(
        locator
            .home_summary(9, true)
            .unwrap()
            .finished_since_last_visit
            .len(),
        1
    );
    locator.shutdown();
    core.shutdown();
    drop(locator);
    drop(core);
    // ...and is empty on the next session.
    let core = core_with_v11(dir.path());
    let locator = Locator::start(core.clone(), FakeSources::new()).expect("start");
    assert!(
        locator
            .home_summary(9, true)
            .unwrap()
            .finished_since_last_visit
            .is_empty()
    );
    locator.shutdown();
}

#[test]
fn recent_work_today_and_yesterday_come_from_the_event_log() {
    let dir = tempfile::tempdir().unwrap();
    let core = core_with_v11(dir.path());
    let ws = workspace(&core, dir.path(), "atlas");
    let sources = FakeSources::new();
    let t = thread(
        "Upload retries",
        "claude-code",
        &ws.id,
        &ws.name,
        ThreadStatus::Idle,
        &now(),
    );
    sources.add(t.clone());
    core.emit(NewEvent {
        source: EventSource::Core,
        correlation: Correlation {
            workspace_id: Some(ws.id.clone()),
            thread_id: Some(t.id.clone()),
            ..Correlation::default()
        },
        event: EventPayload::FileModified {
            thread_id: Some(t.id.clone()),
            path: "src/upload.rs".into(),
        },
    })
    .unwrap();
    let locator = Locator::start(core.clone(), sources).expect("start");
    let page = PageRequest {
        limit: 50,
        cursor: None,
    };
    let today = locator
        .recent_work(RecentWorkWhen::Today, 0, &page)
        .unwrap();
    let kinds: Vec<RecentWorkKind> = today.items.iter().map(|i| i.kind).collect();
    assert!(kinds.contains(&RecentWorkKind::Thread));
    assert!(kinds.contains(&RecentWorkKind::File));
    assert!(kinds.contains(&RecentWorkKind::Workspace));
    assert!(today.items.iter().any(|i| i.title == "src/upload.rs"));
    assert!(
        locator
            .recent_work(RecentWorkWhen::Yesterday, 0, &page)
            .unwrap()
            .items
            .is_empty()
    );
    // Seen from tomorrow, the same work is "yesterday".
    let tomorrow = OffsetDateTime::now_utc() + time::Duration::days(1);
    let yesterday = locator
        .recent_work_at(RecentWorkWhen::Yesterday, 0, &page, tomorrow)
        .unwrap();
    assert!(yesterday.items.iter().any(|i| i.title == "Upload retries"));
    assert_eq!(
        locator
            .recent_work(RecentWorkWhen::Today, 9999, &page)
            .unwrap_err()
            .code,
        "invalid_offset"
    );
    locator.shutdown();
}
