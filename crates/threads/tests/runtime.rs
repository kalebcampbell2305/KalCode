//! Thread runtime integration tests against a real `Core` (SQLite + event bus) with a fake
//! provider implementing the shared provider contract.

#![allow(clippy::expect_used, clippy::unwrap_used)]

mod common;

use std::sync::{Arc, Mutex};

use common::*;
use kalcode_contracts::agent::{AgentEvent, FileChange, ProviderError, Usage};
use kalcode_contracts::events::EventPayload;
use kalcode_contracts::ids::new_id;
use kalcode_contracts::permissions::{ApprovalDecision, PermissionMode, PolicyEffect};
use kalcode_contracts::threads::{MessageRole, ThreadStatus};
use kalcode_core::Core;
use kalcode_threads::runtime::{
    INTERRUPTED_ACTIVITY, PAUSED_ACTIVITY, RECOVERED_ACTIVITY, SHUTDOWN_ACTIVITY, STOPPED_ACTIVITY,
};
use kalcode_threads::{CreateThread, ProviderRegistry, ThreadRuntime, ToolCallStatus};

fn status(h: &Harness, id: &str) -> ThreadStatus {
    h.runtime.get(id).expect("get").status
}

fn wait_status(h: &Harness, id: &str, expected: ThreadStatus) {
    wait_until(&format!("status {expected:?}"), || {
        status(h, id) == expected
    });
}

/// Creates a thread and waits until its first prompt reached the session.
fn started(h: &Harness, prompt: &str) -> String {
    let thread = h.runtime.create(h.request(prompt)).expect("create");
    assert_eq!(thread.status, ThreadStatus::Active);
    thread.id
}

#[test]
fn create_starts_a_session_and_records_the_lifecycle() {
    let h = Harness::new();
    let thread = h
        .runtime
        .create(h.request("fix the OAuth callback race in the login flow"))
        .expect("create");

    assert_eq!(thread.name, "Fix OAuth Callback Race");
    assert_eq!(thread.provider_name, "Fake Provider");
    assert_eq!(thread.workspace_name, "kalcode");
    assert_eq!(thread.permission_mode, PermissionMode::Approve);
    assert_eq!(thread.status, ThreadStatus::Active);
    assert_eq!(thread.error, None);

    let session = h.provider.last_session();
    assert_eq!(session.config.thread_id, thread.id);
    assert_eq!(session.config.workspace_id, h.workspace_id);
    assert_eq!(
        std::path::PathBuf::from(&session.config.working_directory),
        h.dir.path().join("repo"),
        "the working directory is the native-resolved workspace root"
    );
    assert_eq!(session.config.permission_mode, PermissionMode::Approve);
    assert_eq!(session.config.resume_session_id, None);
    assert_eq!(
        session.calls(),
        vec![Call::Send(
            "fix the OAuth callback race in the login flow".into()
        )]
    );

    let messages = h.runtime.messages(&thread.id, 50, None).expect("messages");
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].role, MessageRole::User);

    let events = h.events_for(&thread.id);
    let types: Vec<&str> = events.iter().map(|e| e.event.type_name()).collect();
    assert_eq!(
        types,
        [
            "thread.created",
            "thread.started",
            "agent.message",
            "thread.status_changed"
        ]
    );
    for event in &events {
        assert_eq!(
            event.correlation.workspace_id.as_deref(),
            Some(h.workspace_id.as_str())
        );
        assert_eq!(event.correlation.provider_id.as_deref(), Some("fake"));
    }
    // Event payloads never carry message text.
    let json = serde_json::to_string(&events).expect("json");
    assert!(!json.contains("OAuth callback race"));
}

#[test]
fn explicit_names_and_models_are_used() {
    let h = Harness::new();
    let thread = h
        .runtime
        .create(CreateThread {
            name: Some("  My   thread ".into()),
            model: Some("fake-small".into()),
            permission_mode: PermissionMode::Plan,
            ..h.request("do things")
        })
        .expect("create");
    assert_eq!(thread.name, "My thread");
    assert_eq!(thread.model.as_deref(), Some("fake-small"));
    assert_eq!(thread.permission_mode, PermissionMode::Plan);
    assert_eq!(
        h.provider.last_session().config.model.as_deref(),
        Some("fake-small")
    );
}

#[test]
fn status_follows_structured_events_only() {
    let h = Harness::new();
    let id = started(&h, "build it");
    let session = h.provider.last_session();

    session.emit(AgentEvent::SessionStarted {
        provider_session_id: "sess-1".into(),
        model: Some("fake-large".into()),
    });
    session.emit(AgentEvent::Status {
        status: ThreadStatus::Thinking,
        detail: Some("Planning".into()),
    });
    wait_status(&h, &id, ThreadStatus::Thinking);
    assert_eq!(
        h.runtime.get(&id).unwrap().current_activity.as_deref(),
        Some("Planning")
    );
    assert_eq!(
        h.runtime.get(&id).unwrap().model.as_deref(),
        Some("fake-large")
    );

    // Runtime-owned statuses are never taken from a provider.
    for forbidden in [
        ThreadStatus::Completed,
        ThreadStatus::Paused,
        ThreadStatus::WaitingForPermission,
        ThreadStatus::Failed,
    ] {
        session.emit(AgentEvent::Status {
            status: forbidden,
            detail: None,
        });
    }
    session.emit(AgentEvent::Status {
        status: ThreadStatus::Testing,
        detail: Some("Running npm test".into()),
    });
    wait_status(&h, &id, ThreadStatus::Testing);

    session.emit(AgentEvent::TurnCompleted { ok: true });
    wait_status(&h, &id, ThreadStatus::Idle);

    let transitions: Vec<(ThreadStatus, ThreadStatus)> = h
        .events_for(&id)
        .into_iter()
        .filter_map(|e| match e.event {
            EventPayload::ThreadStatusChanged { from, to, .. } => Some((from, to)),
            _ => None,
        })
        .collect();
    assert_eq!(
        transitions,
        [
            (ThreadStatus::Starting, ThreadStatus::Active),
            (ThreadStatus::Active, ThreadStatus::Thinking),
            (ThreadStatus::Thinking, ThreadStatus::Testing),
            (ThreadStatus::Testing, ThreadStatus::Idle),
        ]
    );
}

#[test]
fn message_deltas_assemble_stream_and_persist() {
    let h = Harness::new();
    let id = started(&h, "explain");
    let session = h.provider.last_session();

    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    let stream = h
        .runtime
        .subscribe_stream(&id, move |event| {
            sink.lock().unwrap().push(event.clone());
            true
        })
        .expect("stream");

    session.emit(AgentEvent::MessageDelta {
        message_id: "m1".into(),
        text: "Hel".into(),
    });
    session.emit(AgentEvent::MessageDelta {
        message_id: "m1".into(),
        text: "lo".into(),
    });
    wait_until("two deltas", || seen.lock().unwrap().len() == 2);

    // A late subscriber first receives everything streamed so far.
    let late = Arc::new(Mutex::new(Vec::new()));
    let late_sink = late.clone();
    h.runtime
        .subscribe_stream(&id, move |event| {
            late_sink.lock().unwrap().push(event.clone());
            true
        })
        .expect("late stream");
    assert_eq!(
        late.lock().unwrap().first(),
        Some(&AgentEvent::MessageDelta {
            message_id: "m1".into(),
            text: "Hello".into()
        })
    );

    // Deltas are live only: nothing is persisted until the message completes.
    assert_eq!(h.runtime.messages(&id, 50, None).unwrap().len(), 1);
    session.emit(AgentEvent::MessageCompleted {
        message_id: "m1".into(),
        text: String::new(),
    });
    wait_until("assistant message", || {
        h.runtime.get(&id).unwrap().unread_messages == 1
    });
    let messages = h.runtime.messages(&id, 50, None).unwrap();
    assert_eq!(messages[1].role, MessageRole::Assistant);
    assert_eq!(messages[1].content, "Hello");
    assert_eq!(
        h.runtime.get(&id).unwrap().unread_messages,
        0,
        "reading marks read"
    );

    // Completed text from the provider wins over the assembled deltas.
    session.emit(AgentEvent::MessageDelta {
        message_id: "m2".into(),
        text: "partial".into(),
    });
    session.emit(AgentEvent::MessageCompleted {
        message_id: "m2".into(),
        text: "Final answer".into(),
    });
    wait_until("second message", || {
        h.runtime.messages(&id, 50, None).unwrap().len() == 3
    });
    assert_eq!(
        h.runtime.messages(&id, 50, None).unwrap()[2].content,
        "Final answer"
    );
    assert!(seen.lock().unwrap().iter().any(|e| matches!(
        e,
        AgentEvent::MessageCompleted { text, .. } if text == "Final answer"
    )));

    assert!(h.runtime.unsubscribe_stream(stream));
    assert!(!h.runtime.unsubscribe_stream(stream));
    assert_eq!(h.runtime.stream_subscriber_count(&id), 1);
}

#[test]
fn dead_stream_subscribers_are_dropped() {
    let h = Harness::new();
    let id = started(&h, "x");
    h.runtime.subscribe_stream(&id, |_| false).expect("stream");
    assert_eq!(h.runtime.stream_subscriber_count(&id), 1);
    h.provider.last_session().emit(AgentEvent::MessageDelta {
        message_id: "m".into(),
        text: "t".into(),
    });
    wait_until("dropped", || h.runtime.stream_subscriber_count(&id) == 0);
}

#[test]
fn tool_calls_are_recorded_with_their_outcome() {
    let h = Harness::new();
    let id = started(&h, "test it");
    let session = h.provider.last_session();

    session.emit(AgentEvent::ToolRequested {
        tool_call_id: "t1".into(),
        tool: "Bash".into(),
        summary: "Run npm test".into(),
    });
    session.emit(AgentEvent::ToolStarted {
        tool_call_id: "t1".into(),
    });
    wait_status(&h, &id, ThreadStatus::RunningTool);
    assert_eq!(
        h.runtime.get(&id).unwrap().current_activity.as_deref(),
        Some("Run npm test")
    );
    session.emit(AgentEvent::ToolCompleted {
        tool_call_id: "t1".into(),
        ok: false,
        summary: Some("2 tests failed".into()),
    });
    wait_status(&h, &id, ThreadStatus::Active);

    session.emit(AgentEvent::ToolRequested {
        tool_call_id: "t2".into(),
        tool: "Edit".into(),
        summary: "Edit src/app.ts".into(),
    });
    session.emit(AgentEvent::ToolStarted {
        tool_call_id: "t2".into(),
    });
    session.emit(AgentEvent::ToolCompleted {
        tool_call_id: "t2".into(),
        ok: true,
        summary: None,
    });
    // Unknown ids are ignored rather than corrupting state.
    session.emit(AgentEvent::ToolCompleted {
        tool_call_id: "nope".into(),
        ok: true,
        summary: None,
    });
    wait_until("two finished calls", || {
        h.runtime
            .tool_calls(&id, 50)
            .unwrap()
            .iter()
            .filter(|c| c.completed_at.is_some())
            .count()
            == 2
    });
    let calls = h.runtime.tool_calls(&id, 50).unwrap();
    assert_eq!(calls[0].tool, "Bash");
    assert_eq!(calls[0].status, ToolCallStatus::Failed);
    assert_eq!(calls[0].result_summary.as_deref(), Some("2 tests failed"));
    assert!(calls[0].started_at.is_some());
    assert_eq!(calls[1].status, ToolCallStatus::Completed);

    let types: Vec<String> = h
        .events_for(&id)
        .iter()
        .map(|e| e.event.type_name().to_owned())
        .filter(|t| t.starts_with("tool."))
        .collect();
    assert_eq!(
        types,
        [
            "tool.requested",
            "tool.started",
            "tool.failed",
            "tool.requested",
            "tool.started",
            "tool.completed"
        ]
    );
}

#[test]
fn file_changes_and_usage_are_recorded() {
    let h = Harness::new();
    let id = started(&h, "edit");
    let session = h.provider.last_session();
    let root = h.dir.path().join("repo");
    session.emit(AgentEvent::FileChanged {
        path: root
            .join("src")
            .join("main.rs")
            .to_string_lossy()
            .into_owned(),
        change: FileChange::Modified,
    });
    session.emit(AgentEvent::FileChanged {
        path: "README.md".into(),
        change: FileChange::Created,
    });
    session.emit(AgentEvent::FileChanged {
        path: "src/main.rs".into(),
        change: FileChange::Modified,
    });
    session.emit(AgentEvent::Usage {
        usage: Usage {
            input_tokens: Some(100),
            output_tokens: Some(40),
            cost_usd_micros: None,
        },
    });
    wait_until("files", || {
        h.runtime.get(&id).unwrap().files_changed == Some(2)
    });
    let paths: Vec<String> =
        h.events_for(&id)
            .into_iter()
            .filter_map(|e| match e.event {
                EventPayload::FileModified { path, .. }
                | EventPayload::FileCreated { path, .. } => Some(path),
                _ => None,
            })
            .collect();
    assert_eq!(paths, ["src/main.rs", "README.md", "src/main.rs"]);
    let usage = h
        .core
        .read(|conn| kalcode_threads::store::usage(conn, &id))
        .expect("usage");
    assert_eq!(usage, (100, 40, 0));
}

#[test]
fn allowed_actions_are_approved_without_asking() {
    let h = Harness::with_gate(TestGate::new(PolicyEffect::Allow));
    let id = started(&h, "read");
    let session = h.provider.last_session();
    session.emit(AgentEvent::ApprovalRequired {
        request_id: "p-1".into(),
        action: command_action("cat README.md"),
    });
    wait_until("response", || session.calls().len() == 2);
    assert_eq!(
        session.calls()[1],
        Call::Respond("p-1".into(), ApprovalDecision::ApproveOnce)
    );
    assert_eq!(status(&h, &id), ThreadStatus::Active);
    assert!(h.gate.opened().is_empty());
    // The runtime, not the adapter, supplies the action's identity.
    let (action, mode) = h.gate.evaluated.lock().unwrap()[0].clone();
    assert_eq!(action.thread_id, id);
    assert_eq!(action.workspace_id, h.workspace_id);
    assert_eq!(action.provider_id.as_str(), "fake");
    assert!(kalcode_contracts::ids::is_valid_id(&action.id));
    assert_eq!(mode, PermissionMode::Approve);
}

#[test]
fn denied_actions_are_refused() {
    let h = Harness::with_gate(TestGate::new(PolicyEffect::Deny));
    let _id = started(&h, "delete");
    let session = h.provider.last_session();
    session.emit(AgentEvent::ApprovalRequired {
        request_id: "p-1".into(),
        action: command_action("rm -rf build"),
    });
    wait_until("response", || session.calls().len() == 2);
    assert_eq!(
        session.calls()[1],
        Call::Respond("p-1".into(), ApprovalDecision::Deny)
    );
}

#[test]
fn asked_actions_wait_for_the_users_decision() {
    let h = Harness::new();
    let id = started(&h, "install");
    let session = h.provider.last_session();
    session.emit(AgentEvent::Status {
        status: ThreadStatus::Thinking,
        detail: None,
    });
    session.emit(AgentEvent::ApprovalRequired {
        request_id: "p-1".into(),
        action: command_action("npm install lodash"),
    });
    wait_status(&h, &id, ThreadStatus::WaitingForPermission);
    let thread = h.runtime.get(&id).unwrap();
    assert_eq!(thread.pending_approvals, 1);
    assert_eq!(
        thread.current_activity.as_deref(),
        Some("Waiting for approval: Run npm install lodash")
    );
    assert!(thread.status.needs_attention());

    // Provider status updates while waiting don't hide the pending approval.
    session.emit(AgentEvent::Status {
        status: ThreadStatus::Editing,
        detail: None,
    });
    assert_code(
        h.runtime.send(&id, "hello?"),
        "thread_waiting_for_permission",
    );

    let request = h.gate.opened()[0].clone();
    h.decide(&request.id, &id, Some(ApprovalDecision::ApproveForThread));
    wait_until("forwarded", || session.calls().len() == 2);
    assert_eq!(
        session.calls()[1],
        Call::Respond("p-1".into(), ApprovalDecision::ApproveForThread)
    );
    wait_status(&h, &id, ThreadStatus::Editing);
    assert_eq!(h.runtime.get(&id).unwrap().pending_approvals, 0);

    // A decision for a request that's no longer pending changes nothing.
    h.decide(&request.id, &id, Some(ApprovalDecision::ApproveOnce));
    std::thread::sleep(std::time::Duration::from_millis(50));
    assert_eq!(session.calls().len(), 2);
}

#[test]
fn denied_and_expired_decisions_deny_the_provider() {
    let h = Harness::new();
    let id = started(&h, "risky");
    let session = h.provider.last_session();
    for (provider_id, command) in [("p-1", "git push"), ("p-2", "curl example.com")] {
        session.emit(AgentEvent::ApprovalRequired {
            request_id: provider_id.into(),
            action: command_action(command),
        });
    }
    wait_until("two requests", || h.gate.opened().len() == 2);
    wait_until("two pending", || {
        h.runtime.get(&id).unwrap().pending_approvals == 2
    });
    let opened = h.gate.opened();
    h.decide(&opened[0].id, &id, None);
    wait_until("denied", || {
        h.runtime.get(&id).unwrap().pending_approvals == 1
    });
    assert_eq!(status(&h, &id), ThreadStatus::WaitingForPermission);
    h.expire(&opened[1].id, &id);
    wait_status(&h, &id, ThreadStatus::Active);
    let responses: Vec<Call> = session.calls().into_iter().skip(1).collect();
    assert_eq!(
        responses,
        [
            Call::Respond("p-1".into(), ApprovalDecision::Deny),
            Call::Respond("p-2".into(), ApprovalDecision::Deny)
        ]
    );
}

#[test]
fn a_decision_that_races_registration_still_applies() {
    let h = Harness::new();
    let id = started(&h, "race");
    let session = h.provider.last_session();
    let request_id = new_id();
    *h.gate.next_request_id.lock().unwrap() = Some(request_id.clone());
    // The decision is published before the thread registers the request.
    h.decide(&request_id, &id, Some(ApprovalDecision::ApproveOnce));
    std::thread::sleep(std::time::Duration::from_millis(30));
    session.emit(AgentEvent::ApprovalRequired {
        request_id: "p-1".into(),
        action: command_action("make"),
    });
    wait_until("applied", || session.calls().len() == 2);
    assert_eq!(
        session.calls()[1],
        Call::Respond("p-1".into(), ApprovalDecision::ApproveOnce)
    );
    wait_status(&h, &id, ThreadStatus::Active);
}

#[test]
fn an_approval_that_cannot_be_recorded_fails_closed() {
    let h = Harness::new();
    h.gate
        .fail_open
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let id = started(&h, "x");
    let session = h.provider.last_session();
    session.emit(AgentEvent::ApprovalRequired {
        request_id: "p-1".into(),
        action: command_action("make"),
    });
    wait_until("response", || session.calls().len() == 2);
    assert_eq!(
        session.calls()[1],
        Call::Respond("p-1".into(), ApprovalDecision::Deny)
    );
    assert_eq!(status(&h, &id), ThreadStatus::Active);
}

#[test]
fn interrupt_stops_a_slow_turn_and_keeps_partial_output() {
    let h = Harness::new();
    h.provider.set_script(|_| {
        vec![
            Step::Emit(AgentEvent::Status {
                status: ThreadStatus::Thinking,
                detail: None,
            }),
            Step::Emit(AgentEvent::MessageDelta {
                message_id: "m".into(),
                text: "Working on it".into(),
            }),
            Step::Sleep(5_000),
            Step::Emit(AgentEvent::MessageCompleted {
                message_id: "m".into(),
                text: "never".into(),
            }),
        ]
    });
    let id = started(&h, "slow");
    wait_status(&h, &id, ThreadStatus::Thinking);
    wait_until("delta buffered", || {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let sid = h
            .runtime
            .subscribe_stream(&id, move |e| {
                sink.lock().unwrap().push(e.clone());
                true
            })
            .unwrap();
        h.runtime.unsubscribe_stream(sid);
        !seen.lock().unwrap().is_empty()
    });

    let streamed = Arc::new(Mutex::new(Vec::new()));
    let sink = streamed.clone();
    h.runtime
        .subscribe_stream(&id, move |e| {
            sink.lock().unwrap().push(e.clone());
            true
        })
        .unwrap();
    let thread = h.runtime.interrupt(&id).expect("interrupt");
    assert_eq!(thread.status, ThreadStatus::Idle);
    assert_eq!(
        thread.current_activity.as_deref(),
        Some(INTERRUPTED_ACTIVITY)
    );
    // Live viewers learn the partial message is finished.
    assert_eq!(
        streamed.lock().unwrap().last(),
        Some(&AgentEvent::MessageCompleted {
            message_id: "m".into(),
            text: "Working on it".into()
        })
    );
    assert!(h.provider.last_session().calls().contains(&Call::Interrupt));
    let messages = h.runtime.messages(&id, 50, None).unwrap();
    assert_eq!(messages.last().unwrap().content, "Working on it");
    // The provider's own TurnCompleted after the interrupt keeps the thread idle.
    std::thread::sleep(std::time::Duration::from_millis(50));
    assert_eq!(status(&h, &id), ThreadStatus::Idle);
    assert_code(h.runtime.interrupt(&id), "thread_not_working");

    // The session is still usable.
    h.runtime.send(&id, "try again").expect("send");
    // The scripted provider starts thinking again right away.
    assert!(matches!(
        status(&h, &id),
        ThreadStatus::Active | ThreadStatus::Thinking
    ));
    assert_eq!(
        h.provider.last_session().calls().last(),
        Some(&Call::Send("try again".into()))
    );
}

#[test]
fn interrupt_denies_pending_approvals() {
    let h = Harness::new();
    let id = started(&h, "x");
    let session = h.provider.last_session();
    session.emit(AgentEvent::ApprovalRequired {
        request_id: "p-1".into(),
        action: command_action("make deploy"),
    });
    wait_status(&h, &id, ThreadStatus::WaitingForPermission);
    let thread = h.runtime.interrupt(&id).expect("interrupt");
    assert_eq!(thread.pending_approvals, 0);
    assert!(
        session
            .calls()
            .contains(&Call::Respond("p-1".into(), ApprovalDecision::Deny))
    );
    assert!(h.gate.expired().contains(&id));
}

#[test]
fn providers_without_interrupt_say_so() {
    let h = Harness::new();
    let provider = FakeProvider::configured("stubborn", "Stubborn", false, false);
    h.registry.register(provider.clone());
    let thread = h
        .runtime
        .create(CreateThread {
            provider_id: "stubborn".into(),
            ..h.request("x")
        })
        .expect("create");
    assert_code(h.runtime.interrupt(&thread.id), "interrupt_unsupported");
    assert_eq!(status(&h, &thread.id), ThreadStatus::Active);
}

#[test]
fn stop_terminates_the_session_and_ignores_late_events() {
    let h = Harness::new();
    let id = started(&h, "x");
    let session = h.provider.last_session();
    session.emit(AgentEvent::ToolRequested {
        tool_call_id: "t1".into(),
        tool: "Bash".into(),
        summary: "Run build".into(),
    });
    session.emit(AgentEvent::ToolStarted {
        tool_call_id: "t1".into(),
    });
    wait_status(&h, &id, ThreadStatus::RunningTool);

    let thread = h.runtime.stop(&id).expect("stop");
    assert_eq!(thread.status, ThreadStatus::Interrupted);
    assert_eq!(thread.current_activity.as_deref(), Some(STOPPED_ACTIVITY));
    assert!(session.calls().contains(&Call::Terminate));
    assert!(h.gate.expired().contains(&id));
    assert_eq!(
        h.runtime.tool_calls(&id, 10).unwrap()[0].status,
        ToolCallStatus::Cancelled
    );

    session.emit(AgentEvent::Status {
        status: ThreadStatus::Thinking,
        detail: None,
    });
    std::thread::sleep(std::time::Duration::from_millis(50));
    assert_eq!(
        status(&h, &id),
        ThreadStatus::Interrupted,
        "stale session ignored"
    );

    assert_code(h.runtime.send(&id, "more"), "thread_not_running");
    assert_code(h.runtime.stop(&id), "thread_not_running");
}

#[test]
fn resume_reattaches_the_provider_session() {
    let h = Harness::new();
    let id = started(&h, "x");
    h.provider.last_session().emit(AgentEvent::SessionStarted {
        provider_session_id: "provider-sess-9".into(),
        model: None,
    });
    wait_until("session id", || {
        h.core
            .read(|conn| kalcode_threads::store::get(conn, &id))
            .unwrap()
            .provider_session_id
            .is_some()
    });
    h.runtime.stop(&id).expect("stop");

    let thread = h
        .runtime
        .resume(&id, Some("continue please"))
        .expect("resume");
    assert_eq!(thread.status, ThreadStatus::Active);
    assert_eq!(h.provider.session_count(), 2);
    let session = h.provider.last_session();
    assert_eq!(
        session.config.resume_session_id.as_deref(),
        Some("provider-sess-9")
    );
    assert_eq!(session.calls(), [Call::Send("continue please".into())]);
    assert_code(h.runtime.resume(&id, None), "thread_already_running");
}

#[test]
fn resume_without_provider_support_starts_fresh_and_says_so() {
    let h = Harness::new();
    let provider = FakeProvider::configured("forgetful", "Forgetful", false, true);
    h.registry.register(provider.clone());
    let thread = h
        .runtime
        .create(CreateThread {
            provider_id: "forgetful".into(),
            ..h.request("x")
        })
        .expect("create");
    h.runtime.stop(&thread.id).expect("stop");
    h.runtime.resume(&thread.id, None).expect("resume");
    assert_eq!(provider.last_session().config.resume_session_id, None);
    let messages = h.runtime.messages(&thread.id, 50, None).unwrap();
    let notice = messages.last().unwrap();
    assert_eq!(notice.role, MessageRole::System);
    assert!(notice.content.contains("won't remember"));
}

#[test]
fn resume_requires_the_provider_and_workspace() {
    let h = Harness::new();
    let id = started(&h, "x");
    h.runtime.stop(&id).expect("stop");
    h.registry
        .unregister(&kalcode_contracts::agent::ProviderId::new("fake"));
    assert_code(h.runtime.resume(&id, None), "provider_unavailable");
    h.registry.register(h.provider.clone());
    h.workspaces.remove_all();
    assert_code(h.runtime.resume(&id, None), "workspace_not_found");
    assert_eq!(status(&h, &id), ThreadStatus::Interrupted);
}

#[test]
fn pause_holds_until_resumed() {
    let h = Harness::new();
    let id = started(&h, "x");
    let session = h.provider.last_session();
    let thread = h.runtime.pause(&id).expect("pause");
    assert_eq!(thread.status, ThreadStatus::Paused);
    assert_eq!(thread.current_activity.as_deref(), Some(PAUSED_ACTIVITY));
    assert!(session.calls().contains(&Call::Interrupt));
    // Provider events after the pause (its TurnCompleted, a stray status) don't un-pause.
    session.emit(AgentEvent::Status {
        status: ThreadStatus::Thinking,
        detail: None,
    });
    std::thread::sleep(std::time::Duration::from_millis(50));
    assert_eq!(status(&h, &id), ThreadStatus::Paused);

    let thread = h.runtime.resume(&id, None).expect("resume");
    assert_eq!(thread.status, ThreadStatus::Idle);
    assert_eq!(h.provider.session_count(), 1, "the same session continues");
}

#[test]
fn provider_exit_after_a_finished_turn_completes_the_thread() {
    let h = Harness::new();
    let id = started(&h, "x");
    let session = h.provider.last_session();
    session.emit(AgentEvent::TurnCompleted { ok: true });
    session.crash(Some(0));
    wait_status(&h, &id, ThreadStatus::Completed);
    assert!(h.event_types().contains(&"thread.completed".to_owned()));
    assert_eq!(h.runtime.get(&id).unwrap().error, None);
}

#[test]
fn provider_crash_fails_only_its_own_threads() {
    let h = Harness::new();
    let other = FakeProvider::new("other", "Other Provider");
    h.registry.register(other.clone());

    let a = started(&h, "one");
    let b = h
        .runtime
        .create(CreateThread {
            provider_id: "other".into(),
            ..h.request("two")
        })
        .expect("create b")
        .id;

    h.provider.last_session().crash(Some(137));
    wait_status(&h, &a, ThreadStatus::Failed);
    let failed = h.runtime.get(&a).unwrap();
    let error = failed.error.expect("error");
    assert_eq!(error.code, "provider_exited");
    assert!(error.message.contains("exit code 137"));
    assert!(h.gate.expired().contains(&a));

    // The other provider's thread is untouched and keeps working.
    assert_eq!(status(&h, &b), ThreadStatus::Active);
    h.runtime.send(&b, "still there?").expect("send b");
    assert_eq!(
        other.last_session().calls().last(),
        Some(&Call::Send("still there?".into()))
    );

    // A provider that can't start fails that thread with a user-safe reason.
    h.provider.fail_next_start(ProviderError::Start(
        "C:\\Users\\secret\\bin: denied".into(),
    ));
    let c = h.runtime.create(h.request("three")).expect("create c");
    assert_eq!(c.status, ThreadStatus::Failed);
    let error = c.error.expect("error");
    assert_eq!(error.code, "provider_start_failed");
    assert!(!error.message.contains("secret"));
    assert_eq!(status(&h, &b), ThreadStatus::Active);

    // A failed thread can be resumed once the provider works again.
    let resumed = h.runtime.resume(&a, Some("again")).expect("resume a");
    assert_eq!(resumed.status, ThreadStatus::Active);
    assert_eq!(resumed.error, None);
}

#[test]
fn provider_errors_are_recorded() {
    let h = Harness::new();
    let id = started(&h, "x");
    let session = h.provider.last_session();
    session.emit(AgentEvent::Error {
        code: "rate_limited".into(),
        message: "Rate limited; retrying\u{1b}[0m".into(),
        recoverable: true,
    });
    wait_until("error", || h.runtime.get(&id).unwrap().error.is_some());
    let thread = h.runtime.get(&id).unwrap();
    assert_eq!(thread.status, ThreadStatus::Active);
    assert_eq!(thread.error.as_ref().unwrap().code, "rate_limited");
    assert!(!thread.error.unwrap().message.contains('\u{1b}'));
    assert!(h.event_types().contains(&"provider.error".to_owned()));

    session.emit(AgentEvent::Error {
        code: "bad code!".into(),
        message: "Model overloaded".into(),
        recoverable: false,
    });
    wait_status(&h, &id, ThreadStatus::Failed);
    assert_eq!(
        h.runtime.get(&id).unwrap().error.unwrap().code,
        "provider_error"
    );
    assert!(session.calls().contains(&Call::Terminate));
}

#[test]
fn a_failed_send_fails_the_thread() {
    let h = Harness::new();
    let id = started(&h, "x");
    h.provider.last_session().fail_next_sends();
    let thread = h
        .runtime
        .send(&id, "hello")
        .expect("send returns the thread");
    assert_eq!(thread.status, ThreadStatus::Failed);
    assert_eq!(thread.error.unwrap().code, "provider_io_failed");
}

#[test]
fn inputs_are_validated_natively() {
    let h = Harness::new();
    let bad = |request: CreateThread, code: &str| assert_code(h.runtime.create(request), code);
    bad(
        CreateThread {
            provider_id: "../evil".into(),
            ..h.request("x")
        },
        "invalid_provider",
    );
    bad(
        CreateThread {
            provider_id: "missing".into(),
            ..h.request("x")
        },
        "provider_unavailable",
    );
    bad(
        CreateThread {
            workspace_id: "C:\\Windows".into(),
            ..h.request("x")
        },
        "invalid_workspace_id",
    );
    bad(
        CreateThread {
            workspace_id: new_id(),
            ..h.request("x")
        },
        "workspace_not_found",
    );
    bad(
        CreateThread {
            permission_mode: PermissionMode::Bypass,
            ..h.request("x")
        },
        "bypass_not_allowed_at_create",
    );
    bad(
        CreateThread {
            model: Some("gpt-unknown".into()),
            ..h.request("x")
        },
        "invalid_model",
    );
    bad(
        CreateThread {
            model: Some("$(whoami)".into()),
            ..h.request("x")
        },
        "invalid_model",
    );
    bad(h.request("   "), "invalid_prompt");
    bad(
        CreateThread {
            name: Some("n".repeat(81)),
            ..h.request("x")
        },
        "invalid_name",
    );
    assert_eq!(h.provider.session_count(), 0, "nothing started");
    assert!(
        h.runtime.list(None, true).unwrap().is_empty(),
        "nothing stored"
    );

    let id = started(&h, "x");
    assert_code(h.runtime.get("not-an-id"), "invalid_thread_id");
    assert_code(h.runtime.get(&new_id()), "thread_not_found");
    assert_code(h.runtime.rename(&id, " \t "), "invalid_name");
    assert_code(h.runtime.send(&id, ""), "invalid_prompt");
    assert_code(h.runtime.messages(&id, 0, None), "invalid_page_size");
    assert_code(h.runtime.messages(&id, 501, None), "invalid_page_size");
    assert_code(h.runtime.messages(&id, 10, Some("x")), "invalid_cursor");
    assert_code(
        h.runtime.messages(&id, 10, Some(&new_id())),
        "invalid_cursor",
    );
    assert_code(h.runtime.tool_calls(&id, 0), "invalid_page_size");
    assert_code(h.runtime.list(Some("bad"), false), "invalid_workspace_id");
}

#[test]
fn rename_archive_and_list() {
    let h = Harness::new();
    let a = started(&h, "first task");
    let b = started(&h, "second task");
    let list = h.runtime.list(None, false).unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].id, b, "most recent first");

    let renamed = h.runtime.rename(&a, "Better name").expect("rename");
    assert_eq!(renamed.name, "Better name");
    assert!(h.event_types().contains(&"thread.renamed".to_owned()));

    assert_code(h.runtime.archive(&a), "thread_running");
    h.runtime.stop(&a).expect("stop");
    let archived = h.runtime.archive(&a).expect("archive");
    assert_eq!(archived.id, a);
    h.runtime.archive(&a).expect("idempotent");
    assert_eq!(
        h.event_types()
            .iter()
            .filter(|t| *t == "thread.archived")
            .count(),
        1
    );
    assert_eq!(h.runtime.list(None, false).unwrap().len(), 1);
    assert_eq!(h.runtime.list(None, true).unwrap().len(), 2);
    assert_eq!(
        h.runtime.list(Some(&h.workspace_id), true).unwrap().len(),
        2
    );
    assert!(h.runtime.list(Some(&new_id()), true).unwrap().is_empty());
    assert_code(h.runtime.resume(&a, None), "thread_archived");
    assert_code(h.runtime.send(&a, "x"), "thread_archived");
}

#[test]
fn permission_mode_changes_are_recorded() {
    let h = Harness::new();
    let id = started(&h, "x");
    let thread = h
        .runtime
        .set_permission_mode(&id, PermissionMode::Auto)
        .expect("mode");
    assert_eq!(thread.permission_mode, PermissionMode::Auto);
    let changed = h
        .events_for(&id)
        .into_iter()
        .find_map(|e| match e.event {
            EventPayload::PermissionModeChanged { from, to, .. } => Some((from, to)),
            _ => None,
        })
        .expect("permission.mode_changed");
    assert_eq!(changed, (PermissionMode::Approve, PermissionMode::Auto));
}

#[test]
fn bulk_operations_for_non_ui_callers() {
    let h = Harness::new();
    let results = h
        .runtime
        .create_threads(vec![h.request("one"), h.request("two"), h.request(" ")])
        .expect("bulk");
    assert!(results[0].is_ok() && results[1].is_ok());
    assert_eq!(
        results[2].as_ref().expect_err("blank").code,
        "invalid_prompt"
    );
    assert_code(h.runtime.create_threads(Vec::new()), "invalid_thread_count");

    let summary = h.runtime.status_summary().unwrap();
    assert_eq!(summary.total, 2);
    assert_eq!(summary.working, 2);

    let paused = h.runtime.pause_all();
    assert_eq!(paused.len(), 2);
    assert!(paused.iter().all(|o| o.ok));
    let summary = h.runtime.status_summary().unwrap();
    assert_eq!(summary.by_status.len(), 1);
    assert_eq!(summary.by_status[0].status, ThreadStatus::Paused);

    let resumed = h.runtime.resume_all();
    assert_eq!(resumed.len(), 2);
    let stopped = h.runtime.stop_all();
    assert_eq!(stopped.len(), 2);
    assert!(
        h.runtime
            .list(None, false)
            .unwrap()
            .iter()
            .all(|t| t.status == ThreadStatus::Interrupted)
    );
}

#[test]
fn shutdown_interrupts_running_threads() {
    let h = Harness::new();
    let id = started(&h, "x");
    h.runtime.shutdown();
    let thread = h.runtime.get(&id).unwrap();
    assert_eq!(thread.status, ThreadStatus::Interrupted);
    assert_eq!(thread.current_activity.as_deref(), Some(SHUTDOWN_ACTIVITY));
    assert!(h.provider.last_session().is_ended());
}

#[test]
fn crash_recovery_interrupts_threads_left_running() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("repo");
    std::fs::create_dir_all(&root).unwrap();
    let (workspaces, workspace_id) = FakeWorkspaces::with(root);
    let provider = FakeProvider::new("fake", "Fake Provider");
    let request = |prompt: &str| CreateThread {
        provider_id: "fake".into(),
        workspace_id: workspace_id.clone(),
        model: None,
        permission_mode: PermissionMode::Approve,
        prompt: prompt.into(),
        name: None,
    };

    let (running, waiting, done) = {
        let core = Arc::new(Core::open(config(dir.path())).expect("core"));
        let registry = Arc::new(ProviderRegistry::new());
        registry.register(provider.clone());
        let gate = TestGate::new(PolicyEffect::Ask);
        let runtime =
            ThreadRuntime::new(core.clone(), registry, workspaces.clone(), gate).expect("runtime");
        let running = runtime.create(request("running")).unwrap().id;
        provider.session(0).emit(AgentEvent::ToolRequested {
            tool_call_id: "t".into(),
            tool: "Bash".into(),
            summary: "Run tests".into(),
        });
        let waiting = runtime.create(request("waiting")).unwrap().id;
        provider.session(1).emit(AgentEvent::ApprovalRequired {
            request_id: "p".into(),
            action: command_action("make"),
        });
        let done = runtime.create(request("done")).unwrap().id;
        provider
            .session(2)
            .emit(AgentEvent::TurnCompleted { ok: true });
        provider.session(2).crash(Some(0));
        wait_until("states", || {
            runtime.get(&waiting).unwrap().status == ThreadStatus::WaitingForPermission
                && runtime.get(&done).unwrap().status == ThreadStatus::Completed
                && runtime.tool_calls(&running, 5).unwrap().len() == 1
        });
        // Crash: no shutdown, no stop. Everything is dropped as a killed process would.
        (running, waiting, done)
    };

    let core = Arc::new(Core::open(config(dir.path())).expect("reopen"));
    let registry = Arc::new(ProviderRegistry::new());
    registry.register(provider.clone());
    let gate = TestGate::new(PolicyEffect::Ask);
    let runtime =
        ThreadRuntime::new(core.clone(), registry, workspaces, gate.clone()).expect("runtime");

    for id in [&running, &waiting] {
        let thread = runtime.get(id).unwrap();
        assert_eq!(thread.status, ThreadStatus::Interrupted, "{id}");
        assert_eq!(thread.current_activity.as_deref(), Some(RECOVERED_ACTIVITY));
        assert_eq!(thread.pending_approvals, 0);
        assert!(gate.expired().contains(id));
    }
    assert_eq!(runtime.get(&done).unwrap().status, ThreadStatus::Completed);
    assert_eq!(
        runtime.tool_calls(&running, 5).unwrap()[0].status,
        ToolCallStatus::Cancelled
    );
    let mut events = core.recent_events(50, None).unwrap();
    events.reverse();
    assert!(
        events
            .iter()
            .any(|e| e.event.type_name() == "app.previous_session_interrupted")
    );

    // Recovered threads resume.
    let resumed = runtime.resume(&running, None).expect("resume");
    assert_eq!(
        resumed.status,
        ThreadStatus::Idle,
        "resumed and waiting for input"
    );
    assert_eq!(resumed.current_activity, None);
    let messages = runtime.messages(&running, 10, None).unwrap();
    assert_eq!(messages[0].content, "running", "history survived the crash");
}
