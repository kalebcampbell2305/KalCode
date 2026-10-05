//! A provider launch or turn the Resource Governor holds (only genuine hard pressure or an
//! explicit Custom limit can hold a user-requested agent; CPU load never does): the thread waits
//! truthfully with the real reason, re-checks on the governor's cadence, proceeds when admitted
//! or when the person chooses Start Anyway, and ends in a resumable `resources_unavailable` state
//! when the bounded wait runs out. Real start failures keep their provider-specific errors.
//! Deterministic: holds are scripted on the fake provider (no load).

#![allow(clippy::expect_used, clippy::unwrap_used)]

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::*;
use kalcode_contracts::agent::{AgentEvent, ProviderError};
use kalcode_contracts::permissions::PolicyEffect;
use kalcode_contracts::resources::{LaunchHold, LaunchHoldKind};
use kalcode_contracts::threads::{MessageRole, ThreadErrorKind, ThreadStatus, ThreadSummary};
use kalcode_core::Core;
use kalcode_threads::runtime::{
    LAST_TURN_FAILED_ACTIVITY, RECOVERED_ACTIVITY, RESOURCES_UNAVAILABLE_ACTIVITY,
    SHUTDOWN_ACTIVITY, STOPPED_ACTIVITY,
};
use kalcode_threads::{ProviderRegistry, ThreadRuntime};

const RETRY: Duration = Duration::from_millis(15);

fn hold(kind: LaunchHoldKind, wait_limit: Duration) -> ProviderError {
    let counts = matches!(kind, LaunchHoldKind::ConcurrencyLimit).then_some((4, 4));
    let evidence = matches!(
        kind,
        LaunchHoldKind::MemoryCritical | LaunchHoldKind::DiskFull
    )
    .then_some((412, 634));
    ProviderError::ResourcesHeld(LaunchHold {
        kind,
        running: counts.map(|(running, _)| running),
        limit: counts.map(|(_, limit)| limit),
        free_mb: evidence.map(|(free, _)| free),
        floor_mb: evidence.map(|(_, floor)| floor),
        retry_after: RETRY,
        wait_limit,
    })
}

fn get(h: &Harness, id: &str) -> ThreadSummary {
    h.runtime.get(id).expect("get")
}

fn error_kind(thread: &ThreadSummary) -> Option<ThreadErrorKind> {
    thread
        .error
        .as_ref()
        .map(|error| ThreadErrorKind::of_code(&error.code))
}

fn user_messages(h: &Harness, id: &str) -> Vec<String> {
    h.runtime
        .messages(id, 50, None)
        .expect("messages")
        .into_iter()
        .filter(|m| m.role == MessageRole::User)
        .map(|m| m.content)
        .collect()
}

fn failed_events(h: &Harness, id: &str) -> usize {
    h.events_for(id)
        .iter()
        .filter(|e| e.event.type_name() == "thread.failed")
        .count()
}

/// (B)(G) Critically low memory holds the launch: the thread waits (not failed) with the real
/// reason, then starts on its own once admission passes, delivering the task exactly once.
#[test]
fn a_held_launch_waits_then_starts_when_resources_free_up() {
    let h = Harness::new();
    h.provider.fail_starts_with(
        3,
        hold(LaunchHoldKind::MemoryCritical, Duration::from_secs(10)),
    );

    let thread = h
        .runtime
        .create(h.request("refactor the parser"))
        .expect("create");
    assert_eq!(thread.status, ThreadStatus::WaitingForDependency);
    assert_eq!(
        thread.current_activity.as_deref(),
        Some("Waiting to start: memory is critically low (412 MB free)")
    );
    assert_eq!(
        error_kind(&thread),
        Some(ThreadErrorKind::WaitingForResources)
    );
    let message = &thread.error.as_ref().unwrap().message;
    assert!(
        message.starts_with("Memory is critically low (412 MB free)."),
        "{message}"
    );
    assert!(message.contains("Run KalTidy"), "{message}");
    assert!(message.contains("Start Anyway"), "{message}");
    assert!(!message.contains("CPU"), "{message}");
    assert!(!message.contains("every few seconds"), "{message}");
    assert!(!message.contains("terminal"), "{message}");
    // The task is visible while it waits.
    assert_eq!(user_messages(&h, &thread.id), ["refactor the parser"]);
    assert_eq!(h.provider.started_sessions(), 0);

    wait_until("admitted", || {
        get(&h, &thread.id).status == ThreadStatus::Active
    });
    let started = get(&h, &thread.id);
    assert_eq!(started.error, None);
    assert_eq!(
        h.provider.last_session().calls(),
        [Call::Send("refactor the parser".into())]
    );
    assert_eq!(user_messages(&h, &thread.id), ["refactor the parser"]);
    assert_eq!(failed_events(&h, &thread.id), 0);
}

/// (C) Each hard-pressure hold names its real reason, never the provider and never CPU.
#[test]
fn hard_pressure_waits_with_the_real_reason() {
    for (kind, activity) in [
        (
            LaunchHoldKind::DiskFull,
            "Waiting to start: the disk is almost full (412 MB free)",
        ),
        (
            LaunchHoldKind::ProcessLimit,
            "Waiting to start: the system couldn't create another process",
        ),
    ] {
        let h = Harness::new();
        h.provider
            .fail_starts_with(1_000, hold(kind, Duration::from_secs(10)));
        let thread = h
            .runtime
            .create(h.request("index the repo"))
            .expect("create");
        assert_eq!(thread.status, ThreadStatus::WaitingForDependency);
        assert_eq!(thread.current_activity.as_deref(), Some(activity));
        h.runtime.stop(&thread.id).expect("stop");
    }
}

/// Start Anyway re-checks a held launch at once (the host has granted its governor the
/// override), without waiting for the governor's cadence, and delivers the task exactly once.
#[test]
fn start_anyway_starts_a_held_launch_immediately() {
    let h = Harness::new();
    // A slow cadence: only Start Anyway can make this start within the test.
    h.provider.fail_starts_with(
        1,
        ProviderError::ResourcesHeld(LaunchHold {
            retry_after: Duration::from_secs(60),
            ..LaunchHold::new(
                LaunchHoldKind::MemoryCritical,
                Duration::from_secs(60),
                Duration::from_secs(90),
            )
        }),
    );
    let thread = h
        .runtime
        .create(h.request("fix the build"))
        .expect("create");
    assert_eq!(thread.status, ThreadStatus::WaitingForDependency);
    assert_eq!(h.provider.started_sessions(), 0);

    let started = h
        .runtime
        .retry_held_launch(&thread.id)
        .expect("start anyway");
    assert_eq!(started.status, ThreadStatus::Active);
    assert_eq!(started.error, None);
    assert_eq!(h.provider.started_sessions(), 1);
    assert_eq!(
        h.provider.last_session().calls(),
        [Call::Send("fix the build".into())]
    );
    assert_eq!(user_messages(&h, &thread.id), ["fix the build"]);

    // On a thread that isn't held it changes nothing.
    let again = h.runtime.retry_held_launch(&thread.id).expect("no-op");
    assert_eq!(again.status, ThreadStatus::Active);
    assert_eq!(h.provider.started_sessions(), 1);
}

/// Start Anyway on a launch whose wait already ran out resumes it.
#[test]
fn start_anyway_resumes_a_launch_whose_wait_ran_out() {
    let h = Harness::new();
    h.provider.fail_starts_with(
        1_000,
        hold(LaunchHoldKind::MemoryCritical, Duration::from_millis(60)),
    );
    let thread = h.runtime.create(h.request("lint")).expect("create");
    wait_until("bound", || {
        get(&h, &thread.id).status == ThreadStatus::Interrupted
    });
    h.provider.admit_starts();
    let started = h
        .runtime
        .retry_held_launch(&thread.id)
        .expect("start anyway");
    assert_eq!(started.status, ThreadStatus::Active);
    assert_eq!(
        h.provider.last_session().calls(),
        [Call::Send("lint".into())]
    );
}

/// (D)(E) A stale snapshot or an unavailable sampler that doesn't recover within the bound ends
/// as `resources_unavailable`: interrupted (resumable), not failed, no failure notification, the
/// message kept, and Resume delivers it once admission passes.
#[test]
fn a_hold_that_outlasts_the_bound_ends_resumable_and_resume_delivers_the_task() {
    for kind in [LaunchHoldKind::MemoryCritical, LaunchHoldKind::DiskFull] {
        let h = Harness::new();
        h.provider
            .fail_starts_with(1_000, hold(kind, Duration::from_millis(120)));
        let thread = h
            .runtime
            .create(h.request("write the tests"))
            .expect("create");
        assert_eq!(thread.status, ThreadStatus::WaitingForDependency);

        wait_until("bound", || {
            get(&h, &thread.id).status == ThreadStatus::Interrupted
        });
        let ended = get(&h, &thread.id);
        assert_eq!(
            ended.current_activity.as_deref(),
            Some(RESOURCES_UNAVAILABLE_ACTIVITY)
        );
        let error = ended.error.as_ref().expect("error");
        assert_eq!(error.code, "resources_unavailable");
        assert_eq!(
            ThreadErrorKind::of_code(&error.code),
            ThreadErrorKind::ResourcesUnavailable
        );
        assert!(
            error.message.contains("Resume sends it"),
            "{}",
            error.message
        );
        assert!(error.message.contains("Start Anyway"), "{}", error.message);
        assert_ne!(ended.status, ThreadStatus::Failed);
        assert_eq!(failed_events(&h, &thread.id), 0);
        assert_eq!(h.provider.started_sessions(), 0);

        h.provider.admit_starts();
        let resumed = h.runtime.resume(&thread.id, None).expect("resume");
        assert_eq!(resumed.status, ThreadStatus::Active, "{kind:?}");
        assert_eq!(resumed.error, None);
        assert_eq!(
            h.provider.last_session().calls(),
            [Call::Send("write the tests".into())]
        );
        // Delivered from history, not recorded twice.
        assert_eq!(user_messages(&h, &thread.id), ["write the tests"]);
    }
}

/// (F) A concurrency hold says which limit and what the person can do.
#[test]
fn a_concurrency_hold_names_the_limit_and_suggests_stopping_a_thread() {
    let h = Harness::new();
    h.provider.fail_starts_with(
        1_000,
        hold(LaunchHoldKind::ConcurrencyLimit, Duration::from_millis(80)),
    );
    let thread = h.runtime.create(h.request("audit deps")).expect("create");
    assert_eq!(
        thread.current_activity.as_deref(),
        Some("Waiting to start: 4 of 4 agents are already working (your Custom limit)")
    );
    let waiting = thread.error.expect("waiting error").message;
    assert!(
        waiting.contains("Stop an agent you're not using"),
        "{waiting}"
    );

    wait_until("bound", || {
        get(&h, &thread.id).status == ThreadStatus::Interrupted
    });
    let ended = get(&h, &thread.id).error.expect("error").message;
    assert!(ended.contains("Stop an agent you're not using"), "{ended}");

    // A hard-pressure hold never suggests stopping agents; it offers KalTidy.
    let memory = Harness::new();
    memory.provider.fail_starts_with(
        1_000,
        hold(LaunchHoldKind::MemoryCritical, Duration::from_secs(10)),
    );
    let thread = memory
        .runtime
        .create(memory.request("audit deps"))
        .expect("create");
    let message = thread.error.expect("error").message;
    assert!(!message.contains("Stop an agent"), "{message}");
    assert!(message.contains("Run KalTidy"), "{message}");
    memory.runtime.stop(&thread.id).expect("stop");
}

/// A turn on a live session that is held waits the same way and is delivered once admitted.
#[test]
fn a_held_turn_waits_and_is_delivered_once_admitted() {
    let h = Harness::new();
    let id = h.runtime.create(h.request("first")).expect("create").id;
    let session = h.provider.last_session();
    session.emit(AgentEvent::TurnCompleted { ok: true });
    wait_until("idle", || get(&h, &id).status == ThreadStatus::Idle);

    session.fail_sends_with(
        2,
        hold(LaunchHoldKind::MemoryCritical, Duration::from_secs(10)),
    );
    let held = h.runtime.send(&id, "second").expect("send is accepted");
    assert_eq!(held.status, ThreadStatus::WaitingForDependency);
    assert_code(h.runtime.send(&id, "third"), "thread_waiting_for_resources");

    wait_until("admitted", || get(&h, &id).status == ThreadStatus::Active);
    assert_eq!(
        session.calls(),
        [Call::Send("first".into()), Call::Send("second".into())]
    );
    assert_eq!(user_messages(&h, &id), ["first", "second"]);
    assert_eq!(get(&h, &id).error, None);
}

/// Stop cancels a wait: nothing starts afterwards, and Resume still has the task.
#[test]
fn stopping_a_waiting_thread_cancels_the_wait_and_keeps_the_task() {
    let h = Harness::new();
    h.provider.fail_starts_with(
        2,
        hold(LaunchHoldKind::MemoryCritical, Duration::from_secs(10)),
    );
    let id = h.runtime.create(h.request("migrate")).expect("create").id;
    let stopped = h.runtime.stop(&id).expect("stop");
    assert_eq!(stopped.status, ThreadStatus::Interrupted);
    assert_eq!(stopped.current_activity.as_deref(), Some(STOPPED_ACTIVITY));
    assert_eq!(stopped.error, None);
    // The waiter sees its wait is gone and never starts a provider.
    std::thread::sleep(RETRY * 6);
    assert_eq!(h.provider.started_sessions(), 0);
    assert_eq!(get(&h, &id).status, ThreadStatus::Interrupted);

    h.provider.admit_starts();
    h.runtime.resume(&id, None).expect("resume");
    assert_eq!(
        h.provider.last_session().calls(),
        [Call::Send("migrate".into())]
    );
}

/// (H) A real spawn failure is a provider start failure, with the task kept for Resume.
#[test]
fn a_real_spawn_failure_stays_provider_specific_and_keeps_the_task() {
    let h = Harness::new();
    h.provider.fail_next_start(ProviderError::Start(
        "C:\\Users\\me\\codex.exe: denied".into(),
    ));
    let thread = h.runtime.create(h.request("ship it")).expect("create");
    assert_eq!(thread.status, ThreadStatus::Failed);
    let error = thread.error.expect("error");
    assert_eq!(error.code, "provider_start_failed");
    assert_eq!(
        ThreadErrorKind::of_code(&error.code),
        ThreadErrorKind::ProviderStartFailed
    );
    assert!(
        error.message.contains("couldn't start"),
        "{}",
        error.message
    );
    assert!(!error.message.contains("codex.exe"), "{}", error.message);
    assert_eq!(failed_events(&h, &thread.id), 1);
    // G2: "No messages yet" no longer: the task is in history and Resume sends it.
    assert_eq!(user_messages(&h, &thread.id), ["ship it"]);
    h.runtime.resume(&thread.id, None).expect("resume");
    assert_eq!(
        h.provider.last_session().calls(),
        [Call::Send("ship it".into())]
    );

    // New text on Resume supersedes the undelivered task.
    let other = Harness::new();
    other
        .provider
        .fail_next_start(ProviderError::Start("x".into()));
    let id = other.runtime.create(other.request("old task")).unwrap().id;
    other.runtime.resume(&id, Some("new task")).expect("resume");
    assert_eq!(
        other.provider.last_session().calls(),
        [Call::Send("new task".into())]
    );
}

/// KalCode's own launch refusals (account in use, plan, version) carry their code and copy.
#[test]
fn launch_refusals_carry_their_own_code_and_message() {
    let h = Harness::new();
    h.provider.fail_next_start(ProviderError::Refused {
        code: "provider_account_busy".into(),
        message: "Another account operation is using this Codex account.".into(),
    });
    let thread = h.runtime.create(h.request("go")).expect("create");
    let error = thread.error.expect("error");
    assert_eq!(error.code, "provider_account_busy");
    assert_eq!(
        error.message,
        "Another account operation is using this Codex account."
    );
    assert_eq!(
        ThreadErrorKind::of_code(&error.code),
        ThreadErrorKind::AccountRefused
    );
}

/// D3: a failed turn leaves the thread idle but saying so; the next turn clears the problem.
#[test]
fn a_failed_turn_reads_as_failed_until_the_next_turn() {
    let h = Harness::new();
    let id = h.runtime.create(h.request("first")).expect("create").id;
    let session = h.provider.last_session();
    session.emit(AgentEvent::Error {
        code: "process_exited".into(),
        message: "Gemini CLI stopped unexpectedly (exit code 1).".into(),
        recoverable: true,
    });
    session.emit(AgentEvent::TurnCompleted { ok: false });
    session.emit(AgentEvent::Status {
        status: ThreadStatus::Idle,
        detail: None,
    });
    wait_until("idle", || {
        get(&h, &id).current_activity.as_deref() == Some(LAST_TURN_FAILED_ACTIVITY)
    });
    let failed = get(&h, &id);
    assert_eq!(failed.status, ThreadStatus::Idle);
    assert_eq!(
        error_kind(&failed),
        Some(ThreadErrorKind::ProviderProcessExited)
    );

    h.runtime.send(&id, "again").expect("send");
    let working = get(&h, &id);
    assert_eq!(working.status, ThreadStatus::Active);
    assert_eq!(working.error, None);
    session.emit(AgentEvent::TurnCompleted { ok: true });
    wait_until("idle", || get(&h, &id).status == ThreadStatus::Idle);
    assert_eq!(get(&h, &id).current_activity, None);
}

/// Idle threads can be archived (their session ends); a waiting one must be stopped first.
#[test]
fn idle_threads_archive_and_waiting_threads_must_be_stopped() {
    let h = Harness::new();
    let id = h.runtime.create(h.request("done")).expect("create").id;
    let session = h.provider.last_session();
    session.emit(AgentEvent::TurnCompleted { ok: true });
    wait_until("idle", || get(&h, &id).status == ThreadStatus::Idle);
    let archived = h.runtime.archive(&id).expect("archive idle");
    assert!(archived.archived_at.is_some());
    assert!(session.is_ended());

    h.provider.fail_starts_with(
        1_000,
        hold(LaunchHoldKind::MemoryCritical, Duration::from_secs(10)),
    );
    let waiting = h.runtime.create(h.request("held")).expect("create").id;
    assert_code(h.runtime.archive(&waiting), "thread_running");
    assert_code(
        h.runtime.resume(&waiting, None),
        "thread_waiting_for_resources",
    );
    h.runtime.stop(&waiting).expect("stop");
    h.runtime.archive(&waiting).expect("archive stopped");
}

/// (M) Quit while waiting: the wait ends, nothing starts later, the thread is resumable.
#[test]
fn shutdown_ends_waits_and_starts_nothing_afterwards() {
    let h = Harness::new();
    h.provider.fail_starts_with(
        3,
        hold(LaunchHoldKind::MemoryCritical, Duration::from_secs(10)),
    );
    let id = h.runtime.create(h.request("nightly")).expect("create").id;
    h.runtime.shutdown_checked().expect("shutdown");
    let thread = get(&h, &id);
    assert_eq!(thread.status, ThreadStatus::Interrupted);
    assert_eq!(thread.current_activity.as_deref(), Some(SHUTDOWN_ACTIVITY));
    std::thread::sleep(RETRY * 8);
    assert_eq!(h.provider.started_sessions(), 0, "no launch after quit");
}

/// (N) A thread left waiting by a crash is recovered as interrupted without a stale waiting
/// error, and Resume delivers its task.
#[test]
fn a_crash_while_waiting_recovers_without_phantom_waits() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("repo");
    std::fs::create_dir_all(&root).unwrap();
    let (workspaces, workspace_id) = FakeWorkspaces::with(root);
    let provider = FakeProvider::new("fake", "Fake Provider");
    let request = kalcode_threads::CreateThread {
        provider_id: "fake".into(),
        provider_account_id: None,
        account_label: None,
        workspace_id: workspace_id.clone(),
        model: None,
        effort: None,
        permission_mode: kalcode_contracts::permissions::PermissionMode::Approve,
        prompt: "resume me".into(),
        name: None,
    };
    let id = {
        let core = Arc::new(Core::open(config(dir.path())).expect("core"));
        let registry = Arc::new(ProviderRegistry::new());
        registry.register(provider.clone());
        let runtime = ThreadRuntime::new(
            core,
            registry,
            workspaces.clone(),
            TestGate::new(PolicyEffect::Ask),
        )
        .expect("runtime");
        provider.fail_starts_with(
            1_000,
            hold(LaunchHoldKind::MemoryCritical, Duration::from_secs(10)),
        );
        let id = runtime.create(request).expect("create").id;
        assert_eq!(
            runtime.get(&id).unwrap().status,
            ThreadStatus::WaitingForDependency
        );
        id
        // Crash: no shutdown. The waiter holds the runtime weakly and ends with it.
    };
    std::thread::sleep(RETRY * 4);
    provider.admit_starts();
    assert_eq!(provider.started_sessions(), 0);

    let core = Arc::new(Core::open(config(dir.path())).expect("reopen"));
    let registry = Arc::new(ProviderRegistry::new());
    registry.register(provider.clone());
    let runtime = ThreadRuntime::new(core, registry, workspaces, TestGate::new(PolicyEffect::Ask))
        .expect("runtime");
    let recovered = runtime.get(&id).unwrap();
    assert_eq!(recovered.status, ThreadStatus::Interrupted);
    assert_eq!(
        recovered.current_activity.as_deref(),
        Some(RECOVERED_ACTIVITY)
    );
    assert_eq!(recovered.error, None, "no stale waiting error");
    runtime.resume(&id, None).expect("resume");
    assert_eq!(
        provider.last_session().calls(),
        [Call::Send("resume me".into())]
    );
}
