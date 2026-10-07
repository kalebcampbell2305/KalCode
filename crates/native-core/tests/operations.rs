use std::sync::{Arc, Barrier};
use std::thread;
use std::time::{Duration, Instant};

use kalcode_contracts::operations::{
    OperationEnvironmentKind, OperationKind, OperationLane, OperationSpec, OperationStatus,
};
use kalcode_core::events::{Correlation, EventPayload, NewEvent};
use kalcode_core::flags::BuildChannel;
use kalcode_core::operations::{OperationsStore, normalize_spec, owns_thread};
use kalcode_core::plans::{Limited, PlanTier};
use kalcode_core::workspaces::{TerminalSize, TerminalStatus};
use kalcode_core::{Core, CoreConfig, Paths};
use rusqlite::params;

#[allow(clippy::expect_used)] // test helper: fixture setup must fail loudly
fn open(data: &std::path::Path) -> Arc<Core> {
    Arc::new(
        Core::open(CoreConfig {
            paths: Paths::new(data),
            app_version: "0.1.7-test".into(),
            channel: BuildChannel::Development,
        })
        .expect("open core"),
    )
}

#[allow(clippy::expect_used)] // test helper: fixture setup must fail loudly
fn workspace(core: &Core, root: &std::path::Path) -> String {
    std::fs::create_dir_all(root).expect("create workspace");
    core.open_workspace(root).expect("open workspace").id
}

fn spec(workspace_id: &str, name: &str) -> OperationSpec {
    OperationSpec {
        name: name.into(),
        workspace_id: workspace_id.into(),
        kind: OperationKind::Build,
        command: Some("cargo check".into()),
        prompt: None,
        provider_id: None,
        provider_account_id: None,
        model: None,
        effort: None,
        dependencies: Vec::new(),
        priority: 0,
        lane: OperationLane::Next,
        environment: OperationEnvironmentKind::Local,
        urls: Vec::new(),
        env_keys: Vec::new(),
    }
}

fn agent_spec(workspace_id: &str, account_id: &str, name: &str) -> OperationSpec {
    OperationSpec {
        name: name.into(),
        workspace_id: workspace_id.into(),
        kind: OperationKind::Agent,
        command: None,
        prompt: Some("Inspect the current changes.".into()),
        provider_id: Some("codex".into()),
        provider_account_id: Some(account_id.into()),
        model: Some("gpt-test".into()),
        effort: None,
        dependencies: Vec::new(),
        priority: 0,
        lane: OperationLane::Next,
        environment: OperationEnvironmentKind::Local,
        urls: Vec::new(),
        env_keys: Vec::new(),
    }
}

#[allow(clippy::expect_used)] // test helper: fixture setup must fail loudly
fn provider_account(core: &Core, label: &str) -> String {
    let id = uuid::Uuid::now_v7().to_string();
    core.transact(|tx| {
        tx.execute(
            "INSERT INTO provider_accounts (
               id, provider_id, display_name, authentication_state, is_default, created_at
             ) VALUES (?1, 'codex', ?2, 'authenticated', 0, '2026-09-30T12:00:00.000Z')",
            params![id, label],
        )?;
        Ok(((), Vec::new()))
    })
    .expect("insert provider account");
    id
}

#[allow(clippy::too_many_arguments)]
#[allow(clippy::expect_used)] // test helper: fixture setup must fail loudly
fn insert_agent_thread(
    core: &Core,
    id: &str,
    workspace_id: &str,
    account_id: Option<&str>,
    model: Option<&str>,
    permission_mode: &str,
    status: &str,
) {
    core.transact(|tx| {
        tx.execute(
            "INSERT INTO threads (
               id, name, provider_id, provider_name, model, provider_account_id, account_label,
               workspace_id, workspace_name, cwd, permission_mode, status, created_at,
               last_activity_at
             ) VALUES (
               ?1, 'Recovered agent', 'codex', 'Codex', ?2, ?3, 'Test account',
               ?4, 'Fixture', 'C:/fixture', ?5, ?6,
               '2026-09-30T12:00:00.000Z', '2026-09-30T12:00:00.000Z'
             )",
            params![id, model, account_id, workspace_id, permission_mode, status],
        )?;
        Ok(((), Vec::new()))
    })
    .expect("insert exact agent thread");
}

#[allow(clippy::expect_used)] // test helper: fixture setup must fail loudly
fn emit_agent_completion(
    core: &Core,
    workspace_id: &str,
    thread_id: &str,
    ok: bool,
    interrupted: bool,
) {
    core.emit(
        NewEvent::core(EventPayload::AgentTurnCompleted {
            thread_id: thread_id.into(),
            ok,
            interrupted,
        })
        .with_correlation(Correlation {
            workspace_id: Some(workspace_id.into()),
            thread_id: Some(thread_id.into()),
            provider_id: Some("codex".into()),
            ..Correlation::default()
        }),
    )
    .expect("emit agent completion");
}

#[allow(clippy::expect_used)] // test helper: fixture setup must fail loudly
fn insert_event_at(
    core: &Core,
    event_type: &str,
    workspace_id: Option<&str>,
    payload: serde_json::Value,
    occurred_at: &str,
) -> (String, i64) {
    let id = uuid::Uuid::now_v7().to_string();
    core.transact(|tx| {
        tx.execute(
            "INSERT INTO events (
               id, type, version, occurred_at, source, workspace_id, payload
             ) VALUES (?1, ?2, 1, ?3, 'core', ?4, ?5)",
            params![
                id,
                event_type,
                occurred_at,
                workspace_id,
                payload.to_string()
            ],
        )?;
        Ok(((id.clone(), tx.last_insert_rowid()), Vec::new()))
    })
    .expect("insert event")
    .0
}

fn wait_until(timeout: Duration, mut check: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if check() {
            return true;
        }
        thread::sleep(Duration::from_millis(20));
    }
    check()
}

fn long_running_command() -> &'static str {
    if cfg!(windows) {
        "ping 127.0.0.1 -n 30"
    } else {
        "sleep 30"
    }
}

#[test]
fn one_durable_identity_moves_from_queue_through_run_to_outcome() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let operation_id;
    let secret = format!("{}{}", "ghp_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8");

    {
        let core = open(data.path());
        let workspace_id = workspace(&core, project.path());
        let store = OperationsStore::new(Arc::clone(&core));
        let queued = store
            .enqueue(spec(&workspace_id, "Compile desktop"))
            .expect("enqueue");
        operation_id = queued.id.clone();
        assert_eq!(queued.status, OperationStatus::Queued);

        let starting = store.claim(None).expect("claim").expect("available");
        assert_eq!(starting.id, operation_id);
        assert_eq!(starting.status, OperationStatus::Starting);
        let terminal_id = uuid::Uuid::now_v7().to_string();
        store
            .bind(
                &operation_id,
                Some(&terminal_id),
                None,
                Some("feat/operations"),
                Some("0.1.7"),
            )
            .expect("bind");
        store
            .annotate(&operation_id, Some("Compiling Rust crates"))
            .expect("annotate");
        store
            .record_output(
                &operation_id,
                &format!("compile started\ntoken={secret}\ncompile done"),
            )
            .expect("record redacted output");
        store
            .finish(
                &operation_id,
                OperationStatus::Succeeded,
                Some("Desktop build completed"),
            )
            .expect("finish");
        assert_eq!(
            store
                .finish(
                    &operation_id,
                    OperationStatus::Failed,
                    "a replay must not rewrite the outcome",
                )
                .expect_err("final result is immutable")
                .code,
            "operation_not_active"
        );

        let detail = store.detail(&operation_id).expect("detail");
        assert_eq!(detail.run.id, operation_id);
        assert_eq!(detail.run.status, OperationStatus::Succeeded);
        assert_eq!(
            detail.run.terminal_id.as_deref(),
            Some(terminal_id.as_str())
        );
        assert_eq!(detail.run.branch.as_deref(), Some("feat/operations"));
        assert!(detail.run.started_at.is_some());
        assert!(detail.run.ended_at.is_some());
        assert_eq!(detail.timeline.first().expect("queued").kind, "queued");
        assert_eq!(detail.timeline.last().expect("finished").kind, "succeeded");
        let logs = detail.logs.expect("durable logs");
        assert!(logs.contains("compile started"));
        assert!(logs.contains("[REDACTED]"));
        assert!(!logs.contains(&secret));
        core.shutdown();
    }

    let core = open(data.path());
    let store = OperationsStore::new(core);
    let reopened = store.get(&operation_id).expect("get after restart");
    assert_eq!(reopened.status, OperationStatus::Succeeded);
    assert_eq!(reopened.outcome.as_deref(), Some("Desktop build completed"));
    let reopened_logs = store
        .detail(&operation_id)
        .expect("detail after restart")
        .logs
        .expect("logs after restart");
    assert!(reopened_logs.contains("compile done"));
    assert!(reopened_logs.contains("[REDACTED]"));
    assert!(!reopened_logs.contains(&secret));

    let replacement = "final failure tail ✅";
    store
        .record_output(&operation_id, replacement)
        .expect("replace final snapshot");
    store
        .record_output(&operation_id, replacement)
        .expect("idempotent checkpoint retry");
    assert_eq!(
        store
            .detail(&operation_id)
            .expect("replacement detail")
            .logs
            .as_deref(),
        Some(replacement)
    );
}

#[test]
fn activity_moments_follow_one_operation_identity_through_its_lifecycle() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let core = open(data.path());
    let workspace_id = workspace(&core, project.path());
    let store = OperationsStore::new(core);
    let queued = store
        .enqueue(spec(&workspace_id, "Activity lifecycle"))
        .expect("enqueue");
    store
        .claim(Some(&queued.id))
        .expect("claim")
        .expect("available");
    store
        .bind(&queued.id, Some(&queued.id), None, None, None)
        .expect("bind");
    store
        .finish(
            &queued.id,
            OperationStatus::Succeeded,
            "Lifecycle complete.",
        )
        .expect("finish");

    let (moments, truncated) = store.activity_moments(10).expect("activity moments");
    assert!(!truncated);
    assert_eq!(
        moments
            .iter()
            .map(|entry| entry.moment.kind.as_str())
            .collect::<Vec<_>>(),
        vec!["succeeded", "running", "starting", "queued"]
    );
    assert!(moments.iter().all(|entry| {
        entry.operation_id == queued.id
            && entry.workspace_id == workspace_id
            && entry.operation_name == "Activity lifecycle"
            && entry.operation_kind == OperationKind::Build
    }));
    assert_eq!(
        moments
            .iter()
            .map(|entry| entry.moment.id.as_str())
            .collect::<std::collections::HashSet<_>>()
            .len(),
        moments.len(),
        "canonical moment ids remain unique"
    );
    let (bounded, truncated) = store.activity_moments(2).expect("bounded activity moments");
    assert!(truncated);
    assert_eq!(bounded.len(), 2);
    assert_eq!(bounded[0].moment.kind, "succeeded");
    assert_eq!(bounded[1].moment.kind, "running");
    assert_eq!(
        store
            .activity_moments(0)
            .expect_err("zero is unbounded")
            .code,
        "invalid_operations_activity_limit"
    );
}

#[test]
fn a_limited_plan_bounds_waiting_tasks_and_an_unlimited_one_does_not() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let core = open(data.path());
    let workspace_id = workspace(&core, project.path());
    let store = OperationsStore::new(core);
    let limit = PlanTier::Free.limit(Limited::QueuedTasks);
    let queued: Vec<_> = (0..3)
        .map(|n| {
            store
                .enqueue_limited(spec(&workspace_id, &format!("Task {n}")), limit)
                .expect("fits")
        })
        .collect();
    store.check_queue_capacity(None).expect("uncapped");
    assert_eq!(
        store.check_queue_capacity(limit).expect_err("full").code,
        "too_many_queued_tasks"
    );
    let refused = store
        .enqueue_limited(spec(&workspace_id, "Fourth"), limit)
        .expect_err("a fourth waiting task");
    assert_eq!(refused.code, "too_many_queued_tasks");
    assert_eq!(
        refused.message,
        "The Free plan allows 3 queued tasks. Run or remove one to queue another, or upgrade to Pro for unlimited."
    );
    let (_, _, items) = store.snapshot().expect("snapshot");
    assert_eq!(items.len(), 3, "a refusal writes nothing");

    // Removing a waiting task frees a slot; Pro and above have no queue cap.
    store.cancel_pending(&queued[0].id).expect("cancel");
    store
        .enqueue_limited(spec(&workspace_id, "Fourth"), limit)
        .expect("a removed task frees a slot");
    assert_eq!(PlanTier::Pro.limit(Limited::QueuedTasks), None);
    store
        .enqueue_limited(spec(&workspace_id, "Fifth"), None)
        .expect("uncapped");
}

#[test]
fn reorder_requires_the_full_pending_set_and_a_fresh_revision() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let core = open(data.path());
    let workspace_id = workspace(&core, project.path());
    let store = OperationsStore::new(core);
    let first = store.enqueue(spec(&workspace_id, "First")).expect("first");
    let second = store
        .enqueue(spec(&workspace_id, "Second"))
        .expect("second");
    let (revision, _, _) = store.snapshot().expect("snapshot");

    let incomplete = store
        .reorder(std::slice::from_ref(&first.id), revision)
        .expect_err("full set required");
    assert_eq!(incomplete.code, "invalid_queue_order");

    store
        .reorder(&[second.id.clone(), first.id.clone()], revision)
        .expect("reorder");
    let stale = store
        .reorder(&[first.id.clone(), second.id.clone()], revision)
        .expect_err("stale revision");
    assert_eq!(stale.code, "stale_operations_revision");

    let (_, _, items) = store.snapshot().expect("snapshot");
    let pending: Vec<_> = items
        .iter()
        .filter(|item| {
            matches!(
                item.status,
                OperationStatus::Queued | OperationStatus::Paused | OperationStatus::Blocked
            )
        })
        .map(|item| item.id.as_str())
        .collect();
    assert_eq!(pending, vec![second.id.as_str(), first.id.as_str()]);
}

#[test]
fn dependencies_are_validated_auto_ordered_and_never_bypassed() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let core = open(data.path());
    let workspace_id = workspace(&core, project.path());
    let store = OperationsStore::new(core);

    let mut foundation = spec(&workspace_id, "Foundation");
    foundation.priority = -10;
    foundation.lane = OperationLane::Later;
    let foundation = store.enqueue(foundation).expect("foundation");

    let mut dependent = spec(&workspace_id, "Dependent");
    dependent.priority = 100;
    dependent.dependencies.push(foundation.id.clone());
    let dependent = store.enqueue(dependent).expect("dependent");

    let (_, _, items) = store.snapshot().expect("snapshot");
    let pending: Vec<_> = items
        .iter()
        .filter(|item| item.status == OperationStatus::Queued)
        .map(|item| item.id.as_str())
        .collect();
    assert_eq!(pending, vec![foundation.id.as_str(), dependent.id.as_str()]);
    assert_eq!(
        store
            .claim(Some(&dependent.id))
            .expect_err("dependency cannot be bypassed")
            .code,
        "operation_blocked"
    );

    let mut cycle = foundation.spec.clone();
    cycle.dependencies = vec![dependent.id.clone()];
    let (revision, _, _) = store.snapshot().expect("revision");
    assert_eq!(
        store
            .update(&foundation.id, cycle, revision)
            .expect_err("cycle")
            .code,
        "operation_dependency_cycle"
    );

    let start = store
        .claim(Some(&foundation.id))
        .expect("manual later claim")
        .expect("claim");
    assert_eq!(start.id, foundation.id);
    store
        .finish(
            &foundation.id,
            OperationStatus::Failed,
            Some("Compiler failed"),
        )
        .expect("fail");
    assert_eq!(
        store.get(&dependent.id).expect("dependent").status,
        OperationStatus::Blocked
    );
    assert_eq!(
        store
            .claim(Some(&dependent.id))
            .expect_err("failed dependency cannot be bypassed")
            .code,
        "operation_blocked"
    );
}

#[test]
fn claims_are_atomic_and_enforce_execution_slots() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let core = open(data.path());
    let workspace_id = workspace(&core, project.path());
    let store = Arc::new(OperationsStore::new(core));
    for index in 0..8 {
        store
            .enqueue(spec(&workspace_id, &format!("Build {index}")))
            .expect("enqueue");
    }
    let barrier = Arc::new(Barrier::new(8));
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let store = Arc::clone(&store);
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                barrier.wait();
                store.claim(None).expect("claim")
            })
        })
        .collect();
    let claimed: Vec<_> = handles
        .into_iter()
        .filter_map(|handle| handle.join().expect("thread"))
        .collect();
    assert_eq!(claimed.len(), 1, "one foreground execution slot");
    assert_eq!(claimed[0].status, OperationStatus::Starting);
}

#[test]
fn service_slots_do_not_starve_the_single_foreground_slot() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let core = open(data.path());
    let workspace_id = workspace(&core, project.path());
    let store = OperationsStore::new(core);

    let mut services = Vec::new();
    for index in 0..5 {
        let mut service = spec(&workspace_id, &format!("Service {index}"));
        service.kind = OperationKind::Service;
        services.push(store.enqueue(service).expect("enqueue service"));
    }
    for service in &services[..4] {
        store
            .claim(Some(&service.id))
            .expect("service claim")
            .expect("available");
    }
    assert_eq!(
        store
            .claim(Some(&services[4].id))
            .expect_err("service limit")
            .code,
        "operation_slot_unavailable"
    );

    let foreground = store
        .enqueue(spec(&workspace_id, "Foreground build"))
        .expect("foreground");
    assert!(
        store
            .claim(Some(&foreground.id))
            .expect("foreground claim")
            .is_some(),
        "services have a separate slot pool"
    );
    let another = store
        .enqueue(spec(&workspace_id, "Another build"))
        .expect("another");
    assert_eq!(
        store
            .claim(Some(&another.id))
            .expect_err("foreground limit")
            .code,
        "operation_slot_unavailable"
    );
}

#[test]
fn pause_hold_cancel_and_crash_recovery_are_fail_closed() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let core = open(data.path());
    let workspace_id = workspace(&core, project.path());
    let store = OperationsStore::new(core);
    let held = store.enqueue(spec(&workspace_id, "Held")).expect("held");
    store.hold(&held.id, true).expect("hold");
    assert_eq!(
        store.get(&held.id).expect("get").status,
        OperationStatus::Paused
    );
    assert_eq!(
        store
            .claim(Some(&held.id))
            .expect_err("hold cannot be bypassed")
            .code,
        "operation_paused"
    );
    store.hold(&held.id, false).expect("resume");

    store.set_paused(true).expect("pause queue");
    assert_eq!(
        store
            .claim(Some(&held.id))
            .expect_err("global pause cannot be bypassed")
            .code,
        "operations_paused"
    );
    assert!(store.claim(None).expect("auto while paused").is_none());
    store.set_paused(false).expect("resume queue");
    store.claim(Some(&held.id)).expect("claim").expect("run");

    let cancelled = store
        .enqueue(spec(&workspace_id, "Cancelled"))
        .expect("cancelled");
    store.cancel_pending(&cancelled.id).expect("cancel");
    assert_eq!(
        store.get(&cancelled.id).expect("get").status,
        OperationStatus::Cancelled
    );

    assert_eq!(store.recover().expect("recover"), 1);
    let (_, paused, _) = store.snapshot().expect("snapshot");
    assert!(paused, "recovery pauses automatic execution");
    assert_eq!(
        store.get(&held.id).expect("get").status,
        OperationStatus::Interrupted
    );
}

#[test]
fn recovery_links_a_terminal_committed_before_the_run_binding() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let operation_id;

    {
        let core = open(data.path());
        let workspace_id = workspace(&core, project.path());
        let store = OperationsStore::new(Arc::clone(&core));
        let queued = store
            .enqueue(spec(&workspace_id, "Crash window"))
            .expect("enqueue");
        operation_id = queued.id.clone();
        store
            .claim(Some(&operation_id))
            .expect("claim")
            .expect("available");
        core.create_operation_terminal(
            &workspace_id,
            &operation_id,
            long_running_command(),
            TerminalSize::new(80, 24).expect("terminal size"),
            None,
        )
        .expect("launch committed terminal");
        // Simulate a crash before OperationsStore::bind and without Core::shutdown.
    }

    let core = open(data.path());
    let store = OperationsStore::new(core);
    assert_eq!(store.recover().expect("recover"), 1);
    let recovered = store.get(&operation_id).expect("recovered operation");
    assert_eq!(recovered.status, OperationStatus::Interrupted);
    assert_eq!(
        recovered.terminal_id.as_deref(),
        Some(operation_id.as_str())
    );
    assert!(
        store
            .detail(&operation_id)
            .expect("detail")
            .timeline
            .iter()
            .any(|moment| moment.kind == "recovered_link")
    );
}

#[test]
fn recovery_preserves_recorded_terminal_success_and_failure() {
    for (command, expected_code, expected_status) in [
        ("echo recovered-success", 0, OperationStatus::Succeeded),
        ("exit 7", 7, OperationStatus::Failed),
    ] {
        let data = tempfile::tempdir().expect("data");
        let project = tempfile::tempdir().expect("project");
        let operation_id;

        {
            let core = open(data.path());
            let workspace_id = workspace(&core, project.path());
            let store = OperationsStore::new(Arc::clone(&core));
            let operation = store
                .enqueue(spec(&workspace_id, "Recorded exit"))
                .expect("enqueue");
            operation_id = operation.id.clone();
            store
                .claim(Some(&operation_id))
                .expect("claim")
                .expect("available");
            let terminal = core
                .create_operation_terminal(
                    &workspace_id,
                    &operation_id,
                    command,
                    TerminalSize::new(80, 24).expect("terminal size"),
                    None,
                )
                .expect("launch terminal");
            store
                .bind(&operation_id, Some(&terminal.id), None, None, None)
                .expect("bind");
            assert!(wait_until(Duration::from_secs(20), || {
                core.terminal(&terminal.id).is_ok_and(|terminal| {
                    terminal.ended_at.is_some() && terminal.exit_code == Some(expected_code)
                })
            }));
            // Crash after the terminal exit is durable but before the Operations tick finishes.
        }

        let core = open(data.path());
        let store = OperationsStore::new(core);
        assert_eq!(store.recover().expect("recover"), 1);
        let recovered = store.get(&operation_id).expect("recovered operation");
        assert_eq!(recovered.status, expected_status);
        assert!(recovered.ended_at.is_some());
        assert!(
            recovered
                .outcome
                .as_deref()
                .is_some_and(|outcome| outcome.contains(&expected_code.to_string()))
        );
    }
}

#[test]
fn reserved_agent_thread_recovers_exactly_once_from_the_first_completion() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let operation_id;

    {
        let core = open(data.path());
        let workspace_id = workspace(&core, project.path());
        let account_id = provider_account(&core, "Reserved agent account");
        let store = OperationsStore::new(Arc::clone(&core));
        let operation = store
            .enqueue(agent_spec(
                &workspace_id,
                &account_id,
                "Reserved agent recovery",
            ))
            .expect("enqueue agent");
        operation_id = operation.id.clone();
        store
            .claim(Some(&operation_id))
            .expect("claim agent")
            .expect("agent available");
        store
            .reserve_agent_thread(&operation_id, Some("feature/recovery"), Some("revision-1"))
            .expect("reserve exact thread");
        store
            .reserve_agent_thread(&operation_id, Some("feature/recovery"), Some("revision-1"))
            .expect("reservation replay is idempotent");
        // The reserved thread belongs to Operations; an unrelated thread does not.
        assert!(owns_thread(&core.reader(), &operation_id).expect("owned"));
        assert!(
            !owns_thread(&core.reader(), &kalcode_contracts::ids::new_id()).expect("not owned")
        );
        assert_eq!(
            store
                .reserve_agent_thread(
                    &operation_id,
                    Some("feature/recovery"),
                    Some("different-revision"),
                )
                .expect_err("reservation cannot be swapped")
                .code,
            "operation_execution_already_bound"
        );
        let reserved = store.get(&operation_id).expect("reserved run");
        assert_eq!(reserved.status, OperationStatus::Starting);
        assert_eq!(reserved.current_action.as_deref(), Some("Starting"));
        assert_eq!(reserved.thread_id.as_deref(), Some(operation_id.as_str()));
        let swapped_thread = uuid::Uuid::now_v7().to_string();
        assert_eq!(
            store
                .bind(
                    &operation_id,
                    None,
                    Some(&swapped_thread),
                    Some("feature/recovery"),
                    Some("revision-1"),
                )
                .expect_err("reserved thread cannot be swapped")
                .code,
            "operation_execution_already_bound"
        );

        insert_agent_thread(
            &core,
            &operation_id,
            &workspace_id,
            Some(&account_id),
            Some("gpt-test"),
            "approve",
            "completed",
        );
        emit_agent_completion(&core, &workspace_id, &operation_id, true, false);
        // A reused thread can have later turns. The operation belongs to its first submitted turn.
        emit_agent_completion(&core, &workspace_id, &operation_id, false, false);
        core.shutdown();
    }

    let core = open(data.path());
    let store = OperationsStore::new(Arc::clone(&core));
    assert_eq!(store.recover().expect("recover"), 1);
    let recovered = store.get(&operation_id).expect("recovered operation");
    assert_eq!(recovered.status, OperationStatus::Succeeded);
    assert_eq!(recovered.thread_id.as_deref(), Some(operation_id.as_str()));
    assert_eq!(recovered.branch.as_deref(), Some("feature/recovery"));
    assert_eq!(recovered.version.as_deref(), Some("revision-1"));
    let first_completion_at: String = core
        .read(|conn| {
            Ok(conn.query_row(
                "SELECT occurred_at FROM events
                 WHERE type = 'agent.turn_completed' AND thread_id = ?1
                 ORDER BY seq ASC LIMIT 1",
                [&operation_id],
                |row| row.get(0),
            )?)
        })
        .expect("first completion time");
    assert_eq!(
        recovered.ended_at.as_deref(),
        Some(first_completion_at.as_str()),
        "restart recovery keeps the first authoritative completion boundary"
    );
    let (_, paused, snapshot) = store.snapshot().expect("snapshot");
    assert!(paused);
    assert_eq!(
        snapshot.iter().filter(|run| run.id == operation_id).count(),
        1
    );
    assert!(store.claim(None).expect("paused claim").is_none());
    assert_eq!(store.recover().expect("recovery replay"), 0);
    let thread_count: i64 = core
        .read(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM threads WHERE id = ?1",
                [&operation_id],
                |row| row.get(0),
            )?)
        })
        .expect("thread count");
    assert_eq!(
        thread_count, 1,
        "recovery never duplicates or relaunches a thread"
    );
}

#[test]
fn reserved_agent_without_a_durable_thread_recovers_interrupted_without_replay() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let operation_id;

    {
        let core = open(data.path());
        let workspace_id = workspace(&core, project.path());
        let account_id = provider_account(&core, "Missing reserved agent account");
        let store = OperationsStore::new(Arc::clone(&core));
        let operation = store
            .enqueue(agent_spec(
                &workspace_id,
                &account_id,
                "Missing reserved thread",
            ))
            .expect("enqueue agent");
        operation_id = operation.id.clone();
        store
            .claim(Some(&operation_id))
            .expect("claim agent")
            .expect("agent available");
        store
            .reserve_agent_thread(&operation_id, None, None)
            .expect("reserve exact thread");
        core.shutdown();
    }

    let core = open(data.path());
    let store = OperationsStore::new(Arc::clone(&core));
    assert_eq!(store.recover().expect("recover"), 1);
    let recovered = store.get(&operation_id).expect("recovered operation");
    assert_eq!(recovered.status, OperationStatus::Interrupted);
    assert_eq!(recovered.thread_id.as_deref(), Some(operation_id.as_str()));
    let thread_count: i64 = core
        .read(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM threads WHERE id = ?1",
                [&operation_id],
                |row| row.get(0),
            )?)
        })
        .expect("thread count");
    assert_eq!(thread_count, 0, "recovery does not launch a missing thread");
    assert_eq!(store.recover().expect("recovery replay"), 0);
}

#[test]
fn recovery_repairs_an_exact_agent_thread_committed_before_binding() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let operation_id;

    {
        let core = open(data.path());
        let workspace_id = workspace(&core, project.path());
        let account_id = provider_account(&core, "Unbound agent account");
        let store = OperationsStore::new(Arc::clone(&core));
        let operation = store
            .enqueue(agent_spec(
                &workspace_id,
                &account_id,
                "Unbound agent recovery",
            ))
            .expect("enqueue agent");
        operation_id = operation.id.clone();
        store
            .claim(Some(&operation_id))
            .expect("claim agent")
            .expect("agent available");
        insert_agent_thread(
            &core,
            &operation_id,
            &workspace_id,
            Some(&account_id),
            Some("gpt-test"),
            "approve",
            "failed",
        );
        emit_agent_completion(&core, &workspace_id, &operation_id, false, false);
        core.shutdown();
    }

    let core = open(data.path());
    let store = OperationsStore::new(core);
    assert_eq!(store.recover().expect("recover"), 1);
    let recovered = store.get(&operation_id).expect("recovered operation");
    assert_eq!(recovered.status, OperationStatus::Failed);
    assert_eq!(recovered.thread_id.as_deref(), Some(operation_id.as_str()));
    assert!(
        store
            .detail(&operation_id)
            .expect("detail")
            .timeline
            .iter()
            .any(|moment| moment.kind == "recovered_link")
    );
}

#[test]
fn unbound_agent_recovery_rejects_every_mismatched_thread_identity() {
    for mismatch in ["workspace", "account", "model", "permission"] {
        let data = tempfile::tempdir().expect("data");
        let project = tempfile::tempdir().expect("project");
        let other_project = tempfile::tempdir().expect("other project");
        let operation_id;

        {
            let core = open(data.path());
            let workspace_id = workspace(&core, project.path());
            let other_workspace_id = workspace(&core, other_project.path());
            let account_id = provider_account(&core, &format!("Expected {mismatch}"));
            let other_account_id = provider_account(&core, &format!("Other {mismatch}"));
            let store = OperationsStore::new(Arc::clone(&core));
            let operation = store
                .enqueue(agent_spec(
                    &workspace_id,
                    &account_id,
                    "Mismatched agent recovery",
                ))
                .expect("enqueue agent");
            operation_id = operation.id.clone();
            store
                .claim(Some(&operation_id))
                .expect("claim agent")
                .expect("agent available");
            insert_agent_thread(
                &core,
                &operation_id,
                if mismatch == "workspace" {
                    &other_workspace_id
                } else {
                    &workspace_id
                },
                Some(if mismatch == "account" {
                    &other_account_id
                } else {
                    &account_id
                }),
                Some(if mismatch == "model" {
                    "different-model"
                } else {
                    "gpt-test"
                }),
                if mismatch == "permission" {
                    "auto"
                } else {
                    "approve"
                },
                "completed",
            );
            emit_agent_completion(&core, &workspace_id, &operation_id, true, false);
            core.shutdown();
        }

        let core = open(data.path());
        let store = OperationsStore::new(core);
        assert_eq!(store.recover().expect("recover"), 1, "{mismatch}");
        let recovered = store.get(&operation_id).expect("recovered operation");
        assert_eq!(recovered.status, OperationStatus::Interrupted, "{mismatch}");
        assert_eq!(recovered.thread_id, None, "{mismatch} must not bind");
    }
}

#[test]
fn forgotten_cross_workspace_dependency_blocks_without_poisoning_startup() {
    let data = tempfile::tempdir().expect("data");
    let first_project = tempfile::tempdir().expect("first project");
    let second_project = tempfile::tempdir().expect("second project");
    let dependent_id;
    let dependency_id;

    {
        let core = open(data.path());
        let first_workspace = workspace(&core, first_project.path());
        let second_workspace = workspace(&core, second_project.path());
        let store = OperationsStore::new(Arc::clone(&core));
        let dependency = store
            .enqueue(spec(&first_workspace, "Removed dependency"))
            .expect("dependency");
        dependency_id = dependency.id.clone();
        let mut dependent_spec = spec(&second_workspace, "Retained dependent");
        dependent_spec.dependencies.push(dependency.id);
        dependent_id = store.enqueue(dependent_spec).expect("dependent").id;
        core.remove_workspace(&first_workspace)
            .expect("forget first workspace");
        assert_eq!(
            store.get(&dependency_id).expect_err("cascaded run").code,
            "operation_not_found"
        );
        core.shutdown();
    }

    let core = open(data.path());
    let second_workspace = core
        .workspaces()
        .expect("workspaces")
        .into_iter()
        .next()
        .expect("retained workspace")
        .id;
    let store = OperationsStore::new(core);
    store.recover().expect("healthy startup recovery");
    let dependent = store.get(&dependent_id).expect("retained dependent");
    assert_eq!(dependent.status, OperationStatus::Blocked);
    assert_eq!(dependent.blockers, vec![dependency_id]);
    assert_eq!(
        store
            .claim(Some(&dependent_id))
            .expect_err("missing dependency cannot be bypassed")
            .code,
        "operations_paused"
    );
    store
        .set_paused(false)
        .expect("resume after recovery review");
    assert_eq!(
        store
            .claim(Some(&dependent_id))
            .expect_err("missing dependency remains blocked")
            .code,
        "operation_blocked"
    );
    store
        .enqueue(spec(&second_workspace, "Healthy new task"))
        .expect("dangling history does not poison graph validation");
}

#[test]
fn real_terminal_completion_persists_logs_and_releases_dependencies() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let completed_id;

    {
        let core = open(data.path());
        let workspace_id = workspace(&core, project.path());
        let store = OperationsStore::new(Arc::clone(&core));
        let completed = store
            .enqueue(spec(&workspace_id, "Real command"))
            .expect("enqueue command");
        completed_id = completed.id.clone();
        let mut dependent_spec = spec(&workspace_id, "After command");
        dependent_spec.dependencies.push(completed.id.clone());
        let dependent = store.enqueue(dependent_spec).expect("enqueue dependent");

        store
            .claim(Some(&completed.id))
            .expect("claim")
            .expect("available");
        let terminal = core
            .create_operation_terminal(
                &workspace_id,
                &completed.id,
                "echo operations-success",
                TerminalSize::new(80, 24).expect("terminal size"),
                None,
            )
            .expect("launch command");
        store
            .bind(&completed.id, Some(&terminal.id), None, None, None)
            .expect("bind command");
        assert!(wait_until(Duration::from_secs(20), || {
            core.terminal(&terminal.id)
                .is_ok_and(|terminal| terminal.status != TerminalStatus::Running)
        }));
        let terminal = core.terminal(&terminal.id).expect("ended terminal");
        assert_eq!(terminal.exit_code, Some(0));
        let output = core
            .terminal_output(&terminal.id)
            .expect("terminal output")
            .expect("retained scrollback");
        assert!(output.contains("operations-success"));
        store
            .record_output(&completed.id, &output)
            .expect("durable output");
        store
            .finish(
                &completed.id,
                OperationStatus::Succeeded,
                "Command exited successfully.",
            )
            .expect("finish command");

        let released = store
            .claim(None)
            .expect("claim dependent")
            .expect("dependency released");
        assert_eq!(released.id, dependent.id);
        store
            .finish(&dependent.id, OperationStatus::Cancelled, "Test cleanup.")
            .expect("finish dependent");
        core.shutdown();
    }

    let core = open(data.path());
    let detail = OperationsStore::new(core)
        .detail(&completed_id)
        .expect("durable detail");
    assert_eq!(detail.run.status, OperationStatus::Succeeded);
    assert!(
        detail
            .logs
            .is_some_and(|output| output.contains("operations-success"))
    );
}

#[test]
fn cancelling_a_service_stops_its_real_process_and_releases_capacity() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let core = open(data.path());
    let workspace_id = workspace(&core, project.path());
    let store = OperationsStore::new(Arc::clone(&core));
    let mut service_spec = spec(&workspace_id, "Long service");
    service_spec.kind = OperationKind::Service;
    service_spec.command = Some(long_running_command().into());
    let service = store.enqueue(service_spec).expect("enqueue service");
    store
        .claim(Some(&service.id))
        .expect("claim")
        .expect("available");
    let terminal = core
        .create_operation_terminal(
            &workspace_id,
            &service.id,
            long_running_command(),
            TerminalSize::new(80, 24).expect("terminal size"),
            None,
        )
        .expect("launch service");
    store
        .bind(&service.id, Some(&terminal.id), None, None, None)
        .expect("bind service");
    assert_eq!(
        core.terminal(&terminal.id)
            .expect("running terminal")
            .status,
        TerminalStatus::Running
    );

    core.stop_operation_terminal(&terminal.id, None)
        .expect("verified process stop");
    assert!(wait_until(Duration::from_secs(20), || {
        core.terminal(&terminal.id)
            .is_ok_and(|terminal| terminal.status != TerminalStatus::Running)
    }));
    if let Some(output) = core.terminal_output(&terminal.id).expect("output") {
        store
            .record_output(&service.id, &output)
            .expect("checkpoint output");
    }
    store
        .finish(
            &service.id,
            OperationStatus::Cancelled,
            "Cancelled by test.",
        )
        .expect("finish cancellation");
    assert_eq!(
        store.get(&service.id).expect("service").status,
        OperationStatus::Cancelled
    );

    let mut replacement_spec = spec(&workspace_id, "Replacement service");
    replacement_spec.kind = OperationKind::Service;
    let replacement = store.enqueue(replacement_spec).expect("replacement");
    assert!(
        store
            .claim(Some(&replacement.id))
            .expect("replacement claim")
            .is_some(),
        "a verified stop and final status release service capacity"
    );
    store
        .finish(&replacement.id, OperationStatus::Cancelled, "Test cleanup.")
        .expect("cleanup replacement");
    core.shutdown();
}

#[test]
fn operation_inputs_are_bounded_and_never_persist_secret_values() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let core = open(data.path());
    let workspace_id = workspace(&core, project.path());
    let store = OperationsStore::new(core);

    let mut unnamed = spec(&workspace_id, "   ");
    assert_eq!(
        store.enqueue(unnamed.clone()).expect_err("name").code,
        "invalid_operation_name"
    );
    unnamed.name = "Valid".into();
    unnamed.command = Some(format!(
        "deploy --token={}",
        "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"
    ));
    assert_eq!(
        store.enqueue(unnamed.clone()).expect_err("secret").code,
        "operation_contains_secret"
    );
    unnamed.command = Some("cargo check".into());
    unnamed.env_keys = vec!["API_KEY=secret".into()];
    assert_eq!(
        store.enqueue(unnamed.clone()).expect_err("env value").code,
        "invalid_environment_key"
    );
    unnamed.env_keys = vec!["PUBLIC_API_URL".into()];
    unnamed.urls = vec!["https://user:password@example.test/dashboard".into()];
    assert_eq!(
        store
            .enqueue(unnamed.clone())
            .expect_err("url credentials")
            .code,
        "invalid_operation_url"
    );
    unnamed.urls = vec!["https://example.test/dashboard".into()];
    unnamed.effort = Some("high".into());
    assert_eq!(
        store.enqueue(unnamed).expect_err("unsupported effort").code,
        "unsupported_operation_effort"
    );

    let mut public_env = spec(&workspace_id, "Public environment name");
    public_env.env_keys = vec!["PUBLIC_API_URL".into()];
    store
        .enqueue(public_env)
        .expect("ordinary environment name is accepted");

    let secret_env_name = format!("{}{}", "ghp_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8");
    let mut secret_env = spec(&workspace_id, "Secret-shaped environment name");
    secret_env.env_keys = vec![secret_env_name];
    assert_eq!(
        store
            .enqueue(secret_env)
            .expect_err("secret-shaped environment name")
            .code,
        "invalid_environment_key"
    );
    assert!(
        store
            .snapshot()
            .expect("snapshot")
            .2
            .iter()
            .all(|run| run.spec.name != "Secret-shaped environment name"),
        "rejected environment names are never persisted"
    );
}

#[test]
fn output_snapshots_are_utf8_bounded_and_replaced_idempotently() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let core = open(data.path());
    let workspace_id = workspace(&core, project.path());
    let store = OperationsStore::new(core);
    let operation = store
        .enqueue(spec(&workspace_id, "Unicode output"))
        .expect("enqueue");
    store
        .claim(Some(&operation.id))
        .expect("claim")
        .expect("available");

    let unicode = "界".repeat((512 * 1024) / "界".len());
    assert!(unicode.len() <= 512 * 1024);
    store
        .record_output(&operation.id, &unicode)
        .expect("bounded unicode snapshot");
    assert_eq!(
        store.detail(&operation.id).expect("detail").logs.as_deref(),
        Some(unicode.as_str())
    );

    let oversized = format!("{unicode}abcd");
    assert!(oversized.len() > 512 * 1024);
    assert_eq!(
        store
            .record_output(&operation.id, &oversized)
            .expect_err("oversized snapshot")
            .code,
        "operation_output_too_large"
    );

    let latest = "latest failure tail ✅";
    store
        .record_output(&operation.id, latest)
        .expect("replace snapshot");
    store
        .record_output(&operation.id, latest)
        .expect("checkpoint replay");
    assert_eq!(
        store
            .detail(&operation.id)
            .expect("latest detail")
            .logs
            .as_deref(),
        Some(latest)
    );
}

#[test]
fn execution_shape_is_validated_before_persistence_and_binding() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let core = open(data.path());
    let workspace_id = workspace(&core, project.path());
    let store = OperationsStore::new(core);

    let mut agent = spec(&workspace_id, "Agent task");
    agent.kind = OperationKind::Agent;
    agent.command = None;
    assert_eq!(
        normalize_spec(agent.clone())
            .expect_err("prompt required")
            .code,
        "operation_prompt_required"
    );
    agent.prompt = Some("  inspect the workspace  ".into());
    let normalized = normalize_spec(agent.clone()).expect("normalize agent");
    assert_eq!(normalized.prompt.as_deref(), Some("inspect the workspace"));
    agent.command = Some("cargo check".into());
    assert_eq!(
        normalize_spec(agent).expect_err("agent command").code,
        "operation_command_not_allowed"
    );

    let mut command = spec(&workspace_id, "Command task");
    command.command = None;
    assert_eq!(
        normalize_spec(command.clone())
            .expect_err("command required")
            .code,
        "operation_command_required"
    );
    command.command = Some("cargo check".into());
    command.prompt = Some("also ask an agent".into());
    assert_eq!(
        normalize_spec(command).expect_err("mixed task").code,
        "operation_agent_fields_not_allowed"
    );
    let mut command_with_effort = spec(&workspace_id, "Command effort");
    command_with_effort.effort = Some("default".into());
    assert_eq!(
        normalize_spec(command_with_effort)
            .expect_err("command effort")
            .code,
        "operation_agent_fields_not_allowed"
    );

    let build = store
        .enqueue(spec(&workspace_id, "Bound command"))
        .expect("enqueue build");
    store
        .claim(Some(&build.id))
        .expect("claim build")
        .expect("available");
    let terminal_id = uuid::Uuid::now_v7().to_string();
    let thread_id = uuid::Uuid::now_v7().to_string();
    assert_eq!(
        store
            .bind(&build.id, None, None, None, None)
            .expect_err("zero bindings")
            .code,
        "operation_execution_binding_invalid"
    );
    assert_eq!(
        store
            .bind(&build.id, Some(&terminal_id), Some(&thread_id), None, None,)
            .expect_err("both bindings")
            .code,
        "operation_execution_binding_invalid"
    );
    assert_eq!(
        store
            .bind(&build.id, None, Some(&thread_id), None, None)
            .expect_err("wrong binding kind")
            .code,
        "operation_execution_binding_invalid"
    );
    store
        .bind(&build.id, Some(&terminal_id), None, None, None)
        .expect("bind terminal");
    store
        .bind(&build.id, Some(&terminal_id), None, None, None)
        .expect("idempotent bind");
    let replacement = uuid::Uuid::now_v7().to_string();
    assert_eq!(
        store
            .bind(&build.id, Some(&replacement), None, None, None)
            .expect_err("execution identity swap")
            .code,
        "operation_execution_already_bound"
    );
    store
        .finish(&build.id, OperationStatus::Succeeded, "Build complete.")
        .expect("finish build");

    let mut agent = spec(&workspace_id, "Bound agent");
    agent.kind = OperationKind::Agent;
    agent.command = None;
    agent.prompt = Some("Inspect the current change.".into());
    let agent = store.enqueue(agent).expect("enqueue agent");
    store
        .claim(Some(&agent.id))
        .expect("claim agent")
        .expect("agent available");
    assert_eq!(
        store
            .bind(&agent.id, Some(&agent.id), None, None, None)
            .expect_err("agent terminal binding")
            .code,
        "operation_execution_binding_invalid"
    );
    store
        .reserve_agent_thread(&agent.id, None, None)
        .expect("reserve agent thread");
    store
        .bind(&agent.id, None, Some(&agent.id), None, None)
        .expect("bind agent thread");
}

#[test]
fn snapshot_is_bounded_without_losing_queue_or_environment_truth_and_history_pages() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let core = open(data.path());
    let workspace_id = workspace(&core, project.path());
    let store = OperationsStore::new(core);

    let mut deploy_spec = spec(&workspace_id, "Old preview deployment");
    deploy_spec.kind = OperationKind::Deploy;
    deploy_spec.environment = OperationEnvironmentKind::Preview;
    let deploy = store.enqueue(deploy_spec).expect("enqueue deploy");
    store
        .claim(Some(&deploy.id))
        .expect("claim deploy")
        .expect("deploy available");
    store
        .bind(
            &deploy.id,
            Some(&deploy.id),
            None,
            Some("preview-stable"),
            Some("preview-v1"),
        )
        .expect("bind successful deploy");
    store
        .finish(&deploy.id, OperationStatus::Succeeded, "Preview deployed.")
        .expect("finish deploy");

    let mut api_spec = spec(&workspace_id, "Preview API");
    api_spec.kind = OperationKind::Service;
    api_spec.command = Some("cargo run --bin api".into());
    let api = store.enqueue(api_spec).expect("enqueue api service");
    store
        .claim(Some(&api.id))
        .expect("claim api service")
        .expect("api available");
    store
        .bind(&api.id, Some(&api.id), None, None, None)
        .expect("bind api service");
    store
        .finish(&api.id, OperationStatus::Succeeded, "API stopped cleanly.")
        .expect("finish api service");

    let mut docs_spec = spec(&workspace_id, "Preview docs");
    docs_spec.kind = OperationKind::Service;
    docs_spec.command = Some("pnpm docs:dev".into());
    let docs = store.enqueue(docs_spec).expect("enqueue docs service");
    store
        .claim(Some(&docs.id))
        .expect("claim docs service")
        .expect("docs available");
    store
        .bind(&docs.id, Some(&docs.id), None, None, None)
        .expect("bind docs service");
    store
        .finish(
            &docs.id,
            OperationStatus::Succeeded,
            "Docs stopped cleanly.",
        )
        .expect("finish docs service");

    for index in 0..205 {
        let build = store
            .enqueue(spec(&workspace_id, &format!("Historical build {index:03}")))
            .expect("enqueue history");
        store
            .claim(Some(&build.id))
            .expect("claim history")
            .expect("history available");
        store
            .finish(&build.id, OperationStatus::Succeeded, "Build complete.")
            .expect("finish history");
    }
    let mut failed_spec = spec(&workspace_id, "Failed preview deployment");
    failed_spec.kind = OperationKind::Deploy;
    failed_spec.environment = OperationEnvironmentKind::Preview;
    failed_spec.command = Some("deploy preview --broken".into());
    let failed_deploy = store.enqueue(failed_spec).expect("enqueue failed deploy");
    store
        .claim(Some(&failed_deploy.id))
        .expect("claim failed deploy")
        .expect("failed deploy available");
    store
        .bind(&failed_deploy.id, Some(&failed_deploy.id), None, None, None)
        .expect("bind failed deploy");
    store
        .finish(
            &failed_deploy.id,
            OperationStatus::Failed,
            "Deployment failed.",
        )
        .expect("finish failed deploy");
    let pending = store
        .enqueue(spec(&workspace_id, "Still queued"))
        .expect("enqueue pending");

    let (_, _, snapshot) = store.snapshot().expect("bounded snapshot");
    assert!(snapshot.iter().any(|row| row.id == pending.id));
    assert!(
        snapshot.iter().any(|row| row.id == deploy.id),
        "the last successful deployed version survives a newer failed attempt"
    );
    assert!(snapshot.iter().any(|row| row.id == failed_deploy.id));
    assert!(snapshot.iter().any(|row| row.id == api.id));
    assert!(snapshot.iter().any(|row| row.id == docs.id));
    assert_eq!(
        snapshot
            .iter()
            .filter(|row| {
                matches!(
                    row.status,
                    OperationStatus::Succeeded
                        | OperationStatus::Failed
                        | OperationStatus::Cancelled
                        | OperationStatus::Interrupted
                )
            })
            .count(),
        203,
        "latest 200 plus the old successful deploy and two distinct services"
    );
    assert_eq!(
        snapshot
            .iter()
            .filter(|row| row.status == OperationStatus::Succeeded)
            .count(),
        202
    );

    let (first, cursor) = store.history(None, 50).expect("first history page");
    assert_eq!(first.len(), 50);
    let cursor = cursor.expect("more history");
    assert_eq!(
        first.last().map(|row| row.id.as_str()),
        Some(cursor.as_str())
    );
    let (second, _) = store
        .history(Some(&cursor), 50)
        .expect("second history page");
    assert_eq!(second.len(), 50);
    let first_ids: std::collections::HashSet<_> = first.iter().map(|row| &row.id).collect();
    assert!(second.iter().all(|row| !first_ids.contains(&row.id)));
    assert!(first.iter().all(|row| row.started_at.is_some()));
    assert!(second.iter().all(|row| row.started_at.is_some()));
    assert_eq!(
        store
            .history(Some(&pending.id), 50)
            .expect_err("queue-only cursor")
            .code,
        "invalid_operations_history_cursor"
    );
    assert_eq!(
        store.history(None, 201).expect_err("oversized page").code,
        "invalid_operations_history_limit"
    );
}

#[test]
fn snapshot_truth_retention_uses_execution_recency_after_final_window_eviction() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let core = open(data.path());
    let workspace_id = workspace(&core, project.path());
    let store = OperationsStore::new(core.clone());

    let mut first_deploy_spec = spec(&workspace_id, "Environment delivery");
    first_deploy_spec.kind = OperationKind::Deploy;
    first_deploy_spec.environment = OperationEnvironmentKind::Preview;
    let first_deploy = store.enqueue(first_deploy_spec).expect("first deploy");
    store
        .claim(Some(&first_deploy.id))
        .expect("claim first deploy")
        .expect("first deploy available");
    store
        .bind(&first_deploy.id, Some(&first_deploy.id), None, None, None)
        .expect("bind first deploy");
    store
        .finish(
            &first_deploy.id,
            OperationStatus::Succeeded,
            "first deploy complete",
        )
        .expect("finish first deploy");

    let mut second_deploy_spec = spec(&workspace_id, "Environment release");
    second_deploy_spec.kind = OperationKind::Release;
    second_deploy_spec.environment = OperationEnvironmentKind::Preview;
    let second_deploy = store.enqueue(second_deploy_spec).expect("second deploy");
    store
        .claim(Some(&second_deploy.id))
        .expect("claim second deploy")
        .expect("second deploy available");
    store
        .bind(&second_deploy.id, Some(&second_deploy.id), None, None, None)
        .expect("bind second deploy");
    store
        .finish(
            &second_deploy.id,
            OperationStatus::Succeeded,
            "second deploy complete",
        )
        .expect("finish second deploy");

    let mut first_service_spec = spec(&workspace_id, "Concurrent worker");
    first_service_spec.kind = OperationKind::Service;
    first_service_spec.command = Some("pnpm worker".into());
    let first_service = store
        .enqueue(first_service_spec.clone())
        .expect("first service");
    store
        .claim(Some(&first_service.id))
        .expect("claim first service")
        .expect("first service available");
    store
        .bind(&first_service.id, Some(&first_service.id), None, None, None)
        .expect("bind first service");
    store
        .finish(
            &first_service.id,
            OperationStatus::Succeeded,
            "first service complete",
        )
        .expect("finish first service");

    let second_service = store
        .enqueue(first_service_spec.clone())
        .expect("second service");
    store
        .claim(Some(&second_service.id))
        .expect("claim second service")
        .expect("second service available");
    store
        .bind(
            &second_service.id,
            Some(&second_service.id),
            None,
            None,
            None,
        )
        .expect("bind second service");
    store
        .finish(
            &second_service.id,
            OperationStatus::Succeeded,
            "second service complete",
        )
        .expect("finish second service");

    let phantom_service = store
        .enqueue(first_service_spec)
        .expect("phantom service claim");
    store
        .claim(Some(&phantom_service.id))
        .expect("claim phantom service")
        .expect("phantom service available");
    store
        .finish(
            &phantom_service.id,
            OperationStatus::Failed,
            "service process was never created",
        )
        .expect("fail phantom service before binding");

    core.transact(|tx| {
        for (id, created, started, ended) in [
            (
                first_deploy.id.as_str(),
                "2000-01-01T08:00:00.000Z",
                "2000-01-01T12:00:00.000Z",
                "2000-01-01T14:00:00.000Z",
            ),
            (
                second_deploy.id.as_str(),
                "2000-01-01T09:00:00.000Z",
                "2000-01-01T10:00:00.000Z",
                "2000-01-01T11:00:00.000Z",
            ),
            (
                first_service.id.as_str(),
                "2000-01-01T08:00:00.000Z",
                "2000-01-01T12:00:00.000Z",
                "2000-01-01T14:00:00.000Z",
            ),
            (
                second_service.id.as_str(),
                "2000-01-01T09:00:00.000Z",
                "2000-01-01T10:00:00.000Z",
                "2000-01-01T11:00:00.000Z",
            ),
            (
                phantom_service.id.as_str(),
                "2000-01-01T09:30:00.000Z",
                "2000-01-01T15:00:00.000Z",
                "2000-01-01T15:01:00.000Z",
            ),
        ] {
            tx.execute(
                "UPDATE operations SET created_at = ?2, started_at = ?3, ended_at = ?4 WHERE id = ?1",
                params![id, created, started, ended],
            )?;
        }
        Ok(((), Vec::new()))
    })
    .expect("set deterministic execution order");

    for index in 0..205 {
        let filler = store
            .enqueue(spec(&workspace_id, &format!("Window filler {index:03}")))
            .expect("enqueue filler");
        store
            .claim(Some(&filler.id))
            .expect("claim filler")
            .expect("filler available");
        store
            .finish(&filler.id, OperationStatus::Succeeded, "filler complete")
            .expect("finish filler");
    }

    let (_, _, snapshot) = store.snapshot().expect("snapshot");
    assert!(snapshot.iter().any(|run| run.id == first_deploy.id));
    assert!(snapshot.iter().all(|run| run.id != second_deploy.id));
    assert!(snapshot.iter().any(|run| run.id == first_service.id));
    assert!(snapshot.iter().all(|run| run.id != second_service.id));
    assert!(snapshot.iter().all(|run| run.id != phantom_service.id));
}

#[test]
fn run_history_orders_by_execution_start_instead_of_enqueue_time() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let core = open(data.path());
    let workspace_id = workspace(&core, project.path());
    let store = OperationsStore::new(core);
    let delayed = store
        .enqueue(spec(&workspace_id, "Queued first, started last"))
        .expect("enqueue delayed");
    thread::sleep(Duration::from_millis(5));
    let recent = store
        .enqueue(spec(&workspace_id, "Queued last, started first"))
        .expect("enqueue recent");

    store
        .claim(Some(&recent.id))
        .expect("claim recent")
        .expect("recent available");
    store
        .finish(&recent.id, OperationStatus::Succeeded, "recent complete")
        .expect("finish recent");
    thread::sleep(Duration::from_millis(5));
    store
        .claim(Some(&delayed.id))
        .expect("claim delayed")
        .expect("delayed available");
    store
        .finish(&delayed.id, OperationStatus::Succeeded, "delayed complete")
        .expect("finish delayed");

    let (history, cursor) = store.history(None, 2).expect("run history");
    assert_eq!(cursor, None);
    assert_eq!(
        history
            .iter()
            .map(|run| run.id.as_str())
            .collect::<Vec<_>>(),
        [delayed.id.as_str(), recent.id.as_str()]
    );
}

#[test]
fn finish_at_uses_the_authoritative_boundary_and_rejects_unknown_or_invalid_time() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let core = open(data.path());
    let workspace_id = workspace(&core, project.path());
    let store = OperationsStore::new(core);
    let run = store
        .enqueue(spec(&workspace_id, "Authoritative completion"))
        .expect("enqueue");
    let started = store
        .claim(Some(&run.id))
        .expect("claim")
        .expect("starting")
        .started_at
        .expect("started at");

    assert_eq!(
        store
            .finish_at(
                &run.id,
                OperationStatus::Unknown,
                "projection status",
                &started,
            )
            .expect_err("unknown cannot enter durable state")
            .code,
        "invalid_operation_outcome"
    );
    assert_eq!(
        store
            .finish_at(
                &run.id,
                OperationStatus::Succeeded,
                "done",
                "2026-09-30T12:00:00Z",
            )
            .expect_err("timestamp lacks canonical millis")
            .code,
        "invalid_operation_ended_at"
    );
    assert_eq!(
        store
            .finish_at(
                &run.id,
                OperationStatus::Succeeded,
                "done",
                "1970-01-01T00:00:00.000Z",
            )
            .expect_err("completion precedes start")
            .code,
        "invalid_operation_ended_at"
    );
    store
        .finish_at(
            &run.id,
            OperationStatus::Succeeded,
            "provider turn completed",
            &started,
        )
        .expect("finish at event boundary");
    assert_eq!(
        store.get(&run.id).expect("finished").ended_at.as_deref(),
        Some(started.as_str())
    );
}

#[test]
fn shell_history_is_paged_exact_and_excludes_operation_owned_shells() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let core = open(data.path());
    let workspace_id = workspace(&core, project.path());
    let store = OperationsStore::new(Arc::clone(&core));
    let terminal_id = uuid::Uuid::now_v7().to_string();
    let (start_id, start_seq) = insert_event_at(
        &core,
        "shell.started",
        Some(&workspace_id),
        serde_json::json!({
            "terminalId": terminal_id,
            "shellId": "pwsh",
            "shellName": "PowerShell"
        }),
        "2026-09-30T14:00:00.000Z",
    );
    let operation_terminal = uuid::Uuid::now_v7().to_string();
    let (operation_start, _) = insert_event_at(
        &core,
        "shell.started",
        Some(&workspace_id),
        serde_json::json!({
            "terminalId": operation_terminal,
            "shellId": "operation:test",
            "shellName": "Operations"
        }),
        "2026-09-30T14:00:00.000Z",
    );
    let second_terminal = uuid::Uuid::now_v7().to_string();
    let (second_start, _) = insert_event_at(
        &core,
        "shell.started",
        Some(&workspace_id),
        serde_json::json!({
            "terminalId": second_terminal,
            "shellId": "zsh",
            "shellName": "Zsh"
        }),
        "2026-09-30T14:00:00.000Z",
    );
    let (_, completed_seq) = insert_event_at(
        &core,
        "shell.completed",
        Some(&workspace_id),
        serde_json::json!({
            "terminalId": terminal_id,
            "exitCode": 0,
            "closedByUser": false
        }),
        "2026-09-30T14:00:00.100Z",
    );
    insert_event_at(
        &core,
        "shell.failed",
        Some(&workspace_id),
        serde_json::json!({"terminalId": second_terminal, "exitCode": 7}),
        "2026-09-30T14:00:00.100Z",
    );

    let (first_page, cursor) = store
        .shell_history(Some(&workspace_id), None, 1)
        .expect("first shell page");
    let (second_page, exhausted) = store
        .shell_history(
            Some(&workspace_id),
            Some(cursor.as_deref().expect("second shell page")),
            1,
        )
        .expect("second shell page");
    assert_eq!(exhausted, None);
    let pages = [first_page, second_page].concat();
    assert_eq!(pages.len(), 2);
    assert_ne!(pages[0].start_event_id, pages[1].start_event_id);
    let first = pages
        .iter()
        .find(|run| run.start_event_id == start_id)
        .expect("first ordinary shell");
    assert_eq!(first.start_event_seq, start_seq);
    assert_eq!(first.completed_event_seq, Some(completed_seq));
    assert_eq!(first.exit_code, Some(0));
    assert_eq!(first.failed, Some(false));
    assert!(first.workspace_name.is_some());
    let failed = pages
        .iter()
        .find(|run| run.start_event_id == second_start)
        .expect("second ordinary shell");
    assert_eq!(failed.exit_code, Some(7));
    assert_eq!(failed.failed, Some(true));
    let (restarted_start, restarted_seq) = insert_event_at(
        &core,
        "shell.started",
        Some(&workspace_id),
        serde_json::json!({
            "terminalId": second_terminal,
            "shellId": "zsh",
            "shellName": "Zsh"
        }),
        "2026-09-30T14:00:00.200Z",
    );
    let by_terminal = store
        .shell_run_for_terminal(&second_terminal, &workspace_id)
        .expect("shell by terminal")
        .expect("canonical shell identity");
    assert_eq!(by_terminal.start_event_id, restarted_start);
    assert_eq!(by_terminal.start_event_seq, restarted_seq);
    assert_eq!(by_terminal.completed_event_seq, None);
    assert_eq!(by_terminal.terminal_id, second_terminal);
    assert_eq!(
        store
            .shell_run_for_terminal(&operation_terminal, &workspace_id)
            .expect("operation terminal is excluded"),
        None
    );
    assert_eq!(
        store
            .shell_run_for_terminal(&terminal_id, &uuid::Uuid::now_v7().to_string())
            .expect("wrong workspace"),
        None
    );
    assert_eq!(
        store
            .shell_run(&start_id, Some(&workspace_id))
            .expect("exact shell")
            .expect("ordinary shell")
            .terminal_id,
        terminal_id
    );
    assert_eq!(
        store
            .shell_run(&operation_start, Some(&workspace_id))
            .expect("excluded shell"),
        None
    );
}

#[test]
fn doctor_history_pages_past_the_old_five_thousand_event_window() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let core = open(data.path());
    let workspace_id = workspace(&core, project.path());
    let store = OperationsStore::new(Arc::clone(&core));
    let (oldest_run, oldest_start) = core
        .transact(|tx| {
            let mut oldest = None;
            for index in 0..2_501 {
                let run_id = uuid::Uuid::now_v7().to_string();
                let start_id = uuid::Uuid::now_v7().to_string();
                tx.execute(
                    "INSERT INTO events (
                       id, type, version, occurred_at, source, workspace_id, payload
                     ) VALUES (?1, 'doctor.run_started', 1, ?2, 'core', ?3, ?4)",
                    params![
                        start_id,
                        "2026-09-30T15:00:00.000Z",
                        workspace_id,
                        serde_json::json!({"runId": run_id, "checks": 3}).to_string()
                    ],
                )?;
                if index == 0 {
                    oldest = Some((run_id.clone(), start_id.clone()));
                }
                tx.execute(
                    "INSERT INTO events (
                       id, type, version, occurred_at, source, workspace_id, payload
                     ) VALUES (?1, 'doctor.run_completed', 1, ?2, 'core', ?3, ?4)",
                    params![
                        uuid::Uuid::now_v7().to_string(),
                        "2026-09-30T15:00:00.000Z",
                        workspace_id,
                        serde_json::json!({
                            "runId": run_id,
                            "checks": 3,
                            "critical": 0,
                            "warning": 0,
                            "info": 1,
                            "couldNotCheck": 0,
                            "ignored": 0,
                            "cancelled": false
                        })
                        .to_string()
                    ],
                )?;
            }
            Ok((oldest.expect("oldest doctor run"), Vec::new()))
        })
        .expect("insert doctor event history")
        .0;

    let mut cursor = None;
    let mut count = 0;
    let mut saw_oldest = false;
    loop {
        let (page, next) = store
            .background_history(Some(&workspace_id), cursor.as_deref(), 200)
            .expect("doctor page");
        count += page.len();
        saw_oldest |= page.iter().any(|run| run.run_id == oldest_run);
        cursor = next;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(count, 2_501);
    assert!(saw_oldest, "paging reaches runs beyond 5,000 newer events");
    let exact = store
        .background_run(&oldest_run, Some(&workspace_id))
        .expect("exact doctor run")
        .expect("oldest doctor run");
    assert_eq!(exact.start_event_id, oldest_start);
    assert!(exact.completed_event_seq.is_some());
    assert_eq!(exact.info, Some(1));
    assert_eq!(exact.cancelled, Some(false));
}
