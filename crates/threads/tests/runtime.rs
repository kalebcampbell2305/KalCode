//! Thread runtime integration tests against a real `Core` (SQLite + event bus) with a fake
//! provider implementing the shared provider contract.

#![allow(clippy::expect_used, clippy::unwrap_used)]

mod common;

use std::sync::mpsc::{SyncSender, sync_channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::*;
use kalcode_context::{
    ContextItem, ContextPackage, ContextPurpose, Firewall, FirewallPolicy, ItemKind, ItemOrigin,
    PackageOptions, PromptReview, RenderedPackage, TextOnlyDefaults, WorkspaceRoot,
};
use kalcode_contracts::agent::{
    AgentEvent, FileChange, LaunchOrigin, ModelInfo, ProviderError, ProviderId, Usage,
};
use kalcode_contracts::events::EventPayload;
use kalcode_contracts::ids::new_id;
use kalcode_contracts::permissions::{ApprovalDecision, PermissionMode, PolicyEffect};
use kalcode_contracts::threads::{MessageRole, ThreadStatus};
use kalcode_core::Core;
use kalcode_threads::runtime::{
    INTERRUPTED_ACTIVITY, PAUSED_ACTIVITY, RECOVERED_ACTIVITY, SHUTDOWN_ACTIVITY, STOPPED_ACTIVITY,
};
use kalcode_threads::{
    CreateThread, ProviderEntry, ProviderErrorObserver, ProviderRegistry, ThreadRuntime,
    ToolCallStatus,
};

fn status(h: &Harness, id: &str) -> ThreadStatus {
    h.runtime.get(id).expect("get").status
}

fn wait_status(h: &Harness, id: &str, expected: ThreadStatus) {
    wait_until(&format!("status {expected:?}"), || {
        status(h, id) == expected
    });
}

struct ReleaseOnDrop(Option<SyncSender<()>>);

impl ReleaseOnDrop {
    fn release(&mut self) {
        if let Some(sender) = self.0.take() {
            let _ = sender.send(());
        }
    }
}

impl Drop for ReleaseOnDrop {
    fn drop(&mut self) {
        self.release();
    }
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
fn new_coding_options_default_to_bypass() {
    // Owner directive 2026-10-03: coding sessions start without approvals.
    let h = Harness::new();
    let options = h.runtime.options().expect("options");
    assert_eq!(options.default_permission_mode, PermissionMode::Bypass);
    assert!(options.permission_modes.contains(&PermissionMode::Plan));
    assert!(options.permission_modes.contains(&PermissionMode::Approve));
    assert!(options.permission_modes.contains(&PermissionMode::Auto));
    assert!(options.permission_modes.contains(&PermissionMode::Bypass));
    assert!(!options.permission_modes.contains(&PermissionMode::Custom));
}

#[test]
fn claude_full_model_id_is_preserved_with_a_nonempty_alias_catalog() {
    let h = Harness::new();
    let model = |id: &str, display_name: &str, is_default| ModelInfo {
        id: id.into(),
        display_name: display_name.into(),
        is_default,
    };
    let claude = FakeProvider::with_models(
        ProviderId::CLAUDE_CODE,
        "Claude Code",
        vec![
            model("default", "Account default", true),
            model("opus", "Opus", false),
            model("sonnet", "Sonnet", false),
            model("haiku", "Haiku", false),
            model("fable", "Fable", false),
        ],
    );
    h.registry.register(claude.clone());

    let thread = h
        .runtime
        .create(CreateThread {
            provider_id: ProviderId::CLAUDE_CODE.into(),
            model: Some("claude-sonnet-5".into()),
            ..h.request("use the exact Claude model")
        })
        .expect("full Claude model id");

    assert_eq!(thread.model.as_deref(), Some("claude-sonnet-5"));
    assert_eq!(
        claude.last_session().config.model.as_deref(),
        Some("claude-sonnet-5")
    );
}

/// Owner directive (2026-10-04): a session the Operations scheduler starts is background work
/// for the Resource Governor, while a thread the person creates, or one they resume (whatever
/// started it), is theirs. The origin reaches the provider wrapper through `SessionConfig`.
#[test]
fn operation_sessions_are_background_and_a_resume_makes_them_the_persons() {
    let h = Harness::new();
    h.runtime
        .create(h.request("the person's own agent"))
        .expect("create");
    assert_eq!(
        h.provider.last_session().config.launch_origin,
        LaunchOrigin::User
    );

    let operation_id = new_id();
    let thread = h
        .runtime
        .create_reviewed_for_operation(&operation_id, h.request("scheduled work"), None)
        .expect("create operation thread");
    assert_eq!(
        h.provider.last_session().config.launch_origin,
        LaunchOrigin::Background
    );

    h.runtime.stop(&thread.id).expect("stop");
    h.runtime.resume(&thread.id, None).expect("resume");
    assert_eq!(h.provider.session_count(), 3);
    assert_eq!(
        h.provider.last_session().config.launch_origin,
        LaunchOrigin::User,
        "the person resumed it"
    );
}

/// Owner rule: a person's message on a thread the Operations scheduler started is theirs. The
/// live session learns it before the turn is admitted, so CPU load never holds it.
#[test]
fn a_persons_message_on_an_operation_thread_makes_its_turns_theirs() {
    let h = Harness::new();
    let operation_id = new_id();
    let thread = h
        .runtime
        .create_reviewed_for_operation(&operation_id, h.request("scheduled work"), None)
        .expect("create operation thread");
    let session = h.provider.last_session();
    assert_eq!(session.launch_origin(), LaunchOrigin::Background);
    session.emit(AgentEvent::TurnCompleted { ok: true });
    wait_status(&h, &thread.id, ThreadStatus::Idle);

    h.runtime
        .send(&thread.id, "keep going")
        .expect("the person's follow-up");
    assert_eq!(
        session.launch_origin(),
        LaunchOrigin::User,
        "the person's turn is admitted as theirs"
    );
    assert_eq!(
        session.calls().last(),
        Some(&Call::Send("keep going".into()))
    );
}

#[test]
fn operation_thread_uses_reserved_id_and_never_replays_on_collision() {
    let h = Harness::new();
    let operation_id = new_id();
    let request = h.request("run the queued operation exactly once");

    let thread = h
        .runtime
        .create_reviewed_for_operation(&operation_id, request.clone(), None)
        .expect("create reserved operation thread");
    assert_eq!(thread.id, operation_id);
    assert_eq!(h.provider.session_count(), 1);

    assert!(
        h.runtime
            .create_reviewed_for_operation(&operation_id, request, None)
            .is_err(),
        "a durable id collision must fail closed"
    );
    assert_eq!(
        h.provider.session_count(),
        1,
        "a duplicate operation id must not start another provider session"
    );
}

fn secret_shaped_prompt() -> String {
    let value = ["deterministic", "Q7x", "private", "value"].join("-");
    ["password", "=", &value].concat()
}

fn rendered_context(text: &str) -> RenderedPackage {
    ContextPackage::build(
        &Firewall::new(WorkspaceRoot::none(), FirewallPolicy::default()),
        &TextOnlyDefaults::new("fake"),
        PackageOptions::new(ContextPurpose::Drop),
        vec![ContextItem::text(
            ItemKind::Text,
            "test context",
            ItemOrigin::User,
            text,
        )],
    )
    .render()
    .expect("rendered context")
}

#[test]
fn create_prompt_warning_is_fail_closed_exact_and_one_shot() {
    let h = Harness::new();
    let request = h.request(&secret_shaped_prompt());

    assert_code(
        h.runtime.create(request.clone()),
        "context_prompt_confirmation_required",
    );
    assert_eq!(h.provider.session_count(), 0, "warning starts no provider");
    assert!(h.runtime.list(None, false).expect("threads").is_empty());

    let PromptReview::ConfirmationRequired(warning) = h
        .runtime
        .review_create_prompt(&request)
        .expect("review create")
    else {
        panic!("secret-shaped prompt must warn");
    };
    let thread = h
        .runtime
        .create_reviewed(request.clone(), Some(&warning.review_id))
        .expect("confirmed create");
    assert_eq!(thread.status, ThreadStatus::Active);
    assert_eq!(thread.name, kalcode_threads::naming::FALLBACK_NAME);
    assert!(
        !serde_json::to_string(&h.events_for(&thread.id))
            .expect("events")
            .contains(&secret_shaped_prompt()),
        "secret-shaped prompts are not copied into event metadata"
    );
    assert_eq!(h.provider.session_count(), 1);

    assert_code(
        h.runtime.create_reviewed(request, Some(&warning.review_id)),
        "context_prompt_confirmation_invalid",
    );
    assert_eq!(h.provider.session_count(), 1, "replay starts no provider");

    let invalid_target = CreateThread {
        provider_account_id: Some("../different-account".into()),
        ..h.request(&secret_shaped_prompt())
    };
    assert_code(
        h.runtime.review_create_prompt(&invalid_target),
        "invalid_provider_account",
    );
}

#[test]
fn send_and_resume_prompts_cannot_bypass_or_swap_confirmation() {
    let h = Harness::new();
    let id = started(&h, "start clean");
    let secret = secret_shaped_prompt();
    let session = h.provider.last_session();
    let before = session.calls();

    assert_code(
        h.runtime.send(&id, &secret),
        "context_prompt_confirmation_required",
    );
    assert_eq!(session.calls(), before);
    assert_eq!(h.runtime.messages(&id, 50, None).unwrap().len(), 1);

    let PromptReview::ConfirmationRequired(warning) = h
        .runtime
        .review_thread_prompt(&id, &secret)
        .expect("review send")
    else {
        panic!("warning");
    };
    assert_code(
        h.runtime
            .send_reviewed(&id, &format!("{secret} changed"), Some(&warning.review_id)),
        "context_prompt_confirmation_invalid",
    );
    assert_code(
        h.runtime
            .send_reviewed(&id, &secret, Some(&warning.review_id)),
        "context_prompt_confirmation_invalid",
    );
    assert_eq!(session.calls(), before, "object swap consumes the review");

    let PromptReview::ConfirmationRequired(warning) = h
        .runtime
        .review_thread_prompt(&id, &secret)
        .expect("review send again")
    else {
        panic!("warning");
    };
    h.runtime
        .send_reviewed(&id, &secret, Some(&warning.review_id))
        .expect("confirmed send");
    assert_eq!(session.calls().last(), Some(&Call::Send(secret.clone())));

    h.runtime.pause(&id).expect("pause");
    assert_code(
        h.runtime.resume(&id, Some(&secret)),
        "context_prompt_confirmation_required",
    );
    assert_eq!(status(&h, &id), ThreadStatus::Paused);
    let PromptReview::ConfirmationRequired(warning) = h
        .runtime
        .review_thread_prompt(&id, &secret)
        .expect("review resume")
    else {
        panic!("warning");
    };
    h.runtime
        .resume_reviewed(&id, Some(&secret), Some(&warning.review_id))
        .expect("confirmed resume");
    assert_eq!(session.calls().last(), Some(&Call::Send(secret)));
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
fn a_turn_the_provider_starts_after_an_interrupt_is_not_reported_as_interrupted() {
    // A coding-terminal agent: the person types each prompt into the provider's own pane, so
    // KalCode learns of a new turn only from the provider's status, never from `send`.
    let h = Harness::new();
    let id = started(&h, "first turn");
    let session = h.provider.last_session();
    h.runtime.interrupt(&id).expect("interrupt");
    wait_until("the interrupted turn completed", || {
        h.events_for(&id)
            .iter()
            .any(|event| matches!(event.event, EventPayload::AgentTurnCompleted { .. }))
    });
    let completions = |h: &Harness| {
        h.events_for(&id)
            .into_iter()
            .filter_map(|event| match event.event {
                EventPayload::AgentTurnCompleted {
                    ok, interrupted, ..
                } => Some((ok, interrupted)),
                _ => None,
            })
            .collect::<Vec<_>>()
    };

    // The person's next prompt, typed in the pane, succeeds.
    session.emit(AgentEvent::Status {
        status: ThreadStatus::Active,
        detail: None,
    });
    wait_status(&h, &id, ThreadStatus::Active);
    session.emit(AgentEvent::TurnCompleted { ok: true });
    wait_until("second completion", || completions(&h).len() == 2);
    assert_eq!(
        completions(&h)[1],
        (true, false),
        "a finished turn is not interrupted"
    );

    // The one after that fails: the agent shows FAILED, not a plain idle.
    session.emit(AgentEvent::Status {
        status: ThreadStatus::Active,
        detail: None,
    });
    wait_status(&h, &id, ThreadStatus::Active);
    session.emit(AgentEvent::Error {
        code: "provider_rate_limit".into(),
        message: "Rate limited.".into(),
        recoverable: true,
    });
    session.emit(AgentEvent::TurnCompleted { ok: false });
    wait_until("third completion", || completions(&h).len() == 3);
    assert_eq!(completions(&h)[2], (false, false));
    wait_until("idle after the failed turn", || {
        h.runtime
            .get(&id)
            .expect("thread")
            .current_activity
            .as_deref()
            == Some(kalcode_threads::runtime::LAST_TURN_FAILED_ACTIVITY)
    });
    assert_eq!(status(&h, &id), ThreadStatus::Idle);

    // A new turn begins with a clean slate, as one KalCode sends does.
    session.emit(AgentEvent::Status {
        status: ThreadStatus::Active,
        detail: None,
    });
    wait_status(&h, &id, ThreadStatus::Active);
    assert_eq!(h.runtime.get(&id).expect("thread").error, None);
}

#[test]
fn turn_completion_events_preserve_provider_result_and_owner_interruption() {
    let h = Harness::new();
    let id = started(&h, "first turn");
    let session = h.provider.last_session();

    session.emit(AgentEvent::TurnCompleted { ok: true });
    wait_status(&h, &id, ThreadStatus::Idle);
    h.runtime
        .send(&id, "second turn")
        .expect("send second turn");
    h.runtime.pause(&id).expect("pause second turn");
    wait_until("two durable turn completions", || {
        h.events_for(&id)
            .iter()
            .filter(|event| matches!(event.event, EventPayload::AgentTurnCompleted { .. }))
            .count()
            == 2
    });

    let completions = h
        .events_for(&id)
        .into_iter()
        .filter_map(|event| match event.event {
            EventPayload::AgentTurnCompleted {
                thread_id,
                ok,
                interrupted,
            } => Some((thread_id, ok, interrupted, event.source)),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        completions,
        [
            (
                id.clone(),
                true,
                false,
                kalcode_contracts::events::EventSource::Provider
            ),
            (
                id,
                false,
                true,
                kalcode_contracts::events::EventSource::Provider
            ),
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

/// Bug B: a classified tool status (RUNNING COMMAND, EDITING, TESTING) or the provider's own
/// prompt for that tool (WAITING FOR YOU) stuck after the tool finished, because only
/// `RunningTool` returned to WORKING.
#[test]
fn a_finished_tool_returns_its_tool_or_prompt_status_to_working() {
    let h = Harness::new();
    let id = started(&h, "work");
    let session = h.provider.last_session();

    for (index, status) in [
        ThreadStatus::RunningCommand,
        ThreadStatus::Editing,
        ThreadStatus::Testing,
        ThreadStatus::WaitingForUser,
        ThreadStatus::RunningTool,
    ]
    .into_iter()
    .enumerate()
    {
        let call = format!("t{index}");
        session.emit(AgentEvent::ToolRequested {
            tool_call_id: call.clone(),
            tool: "Bash".into(),
            summary: "Run it".into(),
        });
        session.emit(AgentEvent::ToolStarted {
            tool_call_id: call.clone(),
        });
        session.emit(AgentEvent::Status {
            status,
            detail: Some("Answer in Codex".into()),
        });
        wait_status(&h, &id, status);
        session.emit(AgentEvent::ToolCompleted {
            tool_call_id: call,
            ok: true,
            summary: None,
        });
        wait_status(&h, &id, ThreadStatus::Active);
    }

    // A tool that completes after its turn ended never wakes an idle agent.
    session.emit(AgentEvent::ToolRequested {
        tool_call_id: "late".into(),
        tool: "Bash".into(),
        summary: "Run it".into(),
    });
    session.emit(AgentEvent::ToolStarted {
        tool_call_id: "late".into(),
    });
    session.emit(AgentEvent::Status {
        status: ThreadStatus::RunningCommand,
        detail: Some("Run it".into()),
    });
    wait_status(&h, &id, ThreadStatus::RunningCommand);
    session.emit(AgentEvent::TurnCompleted { ok: true });
    wait_status(&h, &id, ThreadStatus::Idle);
    session.emit(AgentEvent::ToolCompleted {
        tool_call_id: "late".into(),
        ok: true,
        summary: None,
    });
    wait_until("late call recorded", || {
        h.runtime
            .tool_calls(&id, 50)
            .unwrap()
            .iter()
            .all(|call| call.completed_at.is_some())
    });
    assert_eq!(status(&h, &id), ThreadStatus::Idle);
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
    // Three file events for two distinct files: wait for the count and for every event, since the
    // repeat edit of `src/main.rs` is recorded after the count has already reached two.
    let file_events = |h: &Harness| {
        h.events_for(&id)
            .into_iter()
            .filter(|e| {
                matches!(
                    e.event,
                    EventPayload::FileModified { .. } | EventPayload::FileCreated { .. }
                )
            })
            .count()
    };
    wait_until("files", || {
        h.runtime.get(&id).unwrap().files_changed == Some(2) && file_events(&h) == 3
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
    // Usage is persisted from its own event, which can land after the file events on a loaded
    // machine (lane gate 37357306434 read (0, 0, 0)); wait for it like the files above.
    let usage = || {
        h.core
            .read(|conn| kalcode_threads::store::usage(conn, &id))
            .expect("usage")
    };
    wait_until("usage", || usage() == (100, 40, 0));
    assert_eq!(usage(), (100, 40, 0));
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
        seen.lock().unwrap().contains(&AgentEvent::MessageDelta {
            message_id: "m".into(),
            text: "Working on it".into(),
        })
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
    // The operation returns the exact user-driven transition even when the provider's queued
    // TurnCompleted subsequently clears its transient activity from durable state.
    wait_until("provider completion applied", || {
        let current = h.runtime.get(&id).expect("thread after completion");
        current.status == ThreadStatus::Idle && current.current_activity.is_none()
    });
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
fn concurrent_resume_claims_one_durable_launch_and_never_reverts_to_starting() {
    let h = Harness::new();
    let id = started(&h, "x");
    h.runtime.stop(&id).expect("stop");

    // A new runtime has the persisted thread but no process-local LiveThread authority yet,
    // exactly as after reopening KalCode. Hold one caller after its initial no-live check while
    // the other completes a resume; the delayed caller must lose the durable compare-and-set.
    let core = h.core.clone();
    let registry = h.registry.clone();
    let workspaces = h.workspaces.clone();
    let gate = h.gate.clone();
    let provider = h.provider.clone();
    drop(h.runtime);
    let runtime = Arc::new(
        ThreadRuntime::new(core, registry, workspaces.clone(), gate).expect("restart runtime"),
    );
    let sessions_before = provider.session_count();

    let (entered_tx, entered_rx) = sync_channel(1);
    let (release_tx, release_rx) = sync_channel(1);
    workspaces.on_next_resolve(move || {
        entered_tx.send(()).expect("announce delayed resume");
        release_rx.recv().expect("release delayed resume");
    });
    let delayed = {
        let runtime = runtime.clone();
        let id = id.clone();
        std::thread::spawn(move || runtime.resume(&id, Some("delayed")))
    };
    entered_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("delayed resume reached workspace preflight");

    let winner = runtime.resume(&id, Some("winner")).expect("winning resume");
    assert_eq!(winner.status, ThreadStatus::Active);
    release_tx.send(()).expect("release delayed resume");
    let loser = delayed.join().expect("delayed resume task");
    assert_code(loser, "thread_already_running");

    assert_eq!(
        provider.session_count(),
        sessions_before + 1,
        "only one provider session may be started"
    );
    assert_eq!(
        runtime.get(&id).expect("final truth").status,
        ThreadStatus::Active
    );
}

#[test]
fn stop_waits_for_a_resuming_launch_and_leaves_it_interrupted() {
    let h = Harness::new();
    let id = started(&h, "x");
    h.runtime.stop(&id).expect("stop");

    let core = h.core.clone();
    let registry = h.registry.clone();
    let workspaces = h.workspaces.clone();
    let gate = h.gate.clone();
    let provider = h.provider.clone();
    drop(h.runtime);
    let runtime = Arc::new(ThreadRuntime::new(core, registry, workspaces, gate).expect("restart"));

    let (entered_tx, entered_rx) = sync_channel(1);
    let (release_tx, release_rx) = sync_channel(1);
    let first = Arc::new(std::sync::atomic::AtomicBool::new(true));
    provider.set_start_observer({
        let first = first.clone();
        let release_rx = Mutex::new(release_rx);
        move || {
            if first.swap(false, std::sync::atomic::Ordering::SeqCst) {
                entered_tx.send(()).expect("announce blocked resume");
                release_rx.lock().unwrap().recv().expect("release resume");
            }
        }
    });

    let resuming = {
        let runtime = runtime.clone();
        let id = id.clone();
        std::thread::spawn(move || runtime.resume(&id, None))
    };
    entered_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("resume reached provider start");
    let (stopped_tx, stopped_rx) = sync_channel(1);
    let stopping = {
        let runtime = runtime.clone();
        let id = id.clone();
        std::thread::spawn(move || stopped_tx.send(runtime.stop(&id)).expect("return stop"))
    };
    assert!(
        stopped_rx.recv_timeout(Duration::from_millis(75)).is_err(),
        "stop must serialize with the canonical launch authority"
    );

    release_tx.send(()).expect("release provider start");
    resuming
        .join()
        .expect("resume task")
        .expect("resume completed before serialized stop");
    let stopped = stopped_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("stop completed")
        .expect("stop");
    stopping.join().expect("stop task");
    assert_eq!(stopped.status, ThreadStatus::Interrupted);
    assert_eq!(stopped.current_activity.as_deref(), Some(STOPPED_ACTIVITY));
    assert_eq!(runtime.get(&id).expect("final truth"), stopped);
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
fn paused_threads_reject_direct_and_preadmitted_context_until_resumed() {
    let direct = Harness::new();
    let direct_id = started(&direct, "start direct");
    let direct_session = direct.provider.last_session();
    direct.runtime.pause(&direct_id).expect("pause direct");
    let direct_calls = direct_session.calls();
    let direct_messages = direct.runtime.messages(&direct_id, 50, None).unwrap().len();

    assert_code(
        direct.runtime.send(&direct_id, "must remain paused"),
        "thread_paused",
    );
    assert_eq!(direct_session.calls(), direct_calls);
    assert_eq!(
        direct.runtime.messages(&direct_id, 50, None).unwrap().len(),
        direct_messages,
        "a denied paused send must not persist a user message"
    );
    assert_eq!(status(&direct, &direct_id), ThreadStatus::Paused);

    let resumed = direct
        .runtime
        .resume(&direct_id, Some("explicitly resumed"))
        .expect("resume and send");
    assert_eq!(resumed.status, ThreadStatus::Active);
    assert_eq!(
        direct_session.calls().last(),
        Some(&Call::Send("explicitly resumed".into()))
    );

    let context = Harness::new();
    let context_id = started(&context, "start context");
    let admission = context
        .runtime
        .admit_thread_prompt(&context_id, "use reviewed context", None)
        .expect("admit while active");
    let context_session = context.provider.last_session();
    context.runtime.pause(&context_id).expect("pause context");
    let context_calls = context_session.calls();
    let context_messages = context
        .runtime
        .messages(&context_id, 50, None)
        .unwrap()
        .len();

    assert_code(
        context
            .runtime
            .send_with_context_admitted(admission, &rendered_context("bounded context")),
        "thread_paused",
    );
    assert_eq!(context_session.calls(), context_calls);
    assert_eq!(
        context
            .runtime
            .messages(&context_id, 50, None)
            .unwrap()
            .len(),
        context_messages,
        "a denied pre-admitted context send must not persist a user message"
    );
    assert_eq!(status(&context, &context_id), ThreadStatus::Paused);
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
fn provider_crash_expires_permissions_before_publishing_terminal_status() {
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
    let crashed_session = h.provider.last_session();
    crashed_session.emit(AgentEvent::ApprovalRequired {
        request_id: "crash-approval".into(),
        action: command_action("make deploy"),
    });
    wait_status(&h, &a, ThreadStatus::WaitingForPermission);
    assert_eq!(h.gate.opened().len(), 1);

    let (entered_tx, entered_rx) = sync_channel(1);
    let (release_tx, release_rx) = sync_channel(1);
    let release_rx = Mutex::new(release_rx);
    h.gate.set_expire_observer(Arc::new(move |thread_id| {
        let _ = entered_tx.send(thread_id.to_owned());
        let _ = release_rx
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(5));
    }));
    let mut release = ReleaseOnDrop(Some(release_tx));

    crashed_session.crash(Some(137));
    let entered = entered_rx.recv_timeout(Duration::from_secs(5));
    let a_while_expiring = status(&h, &a);
    let b_while_expiring = status(&h, &b);
    let expired_while_blocked = h.gate.expired().contains(&a);
    let b_send = h.runtime.send(&b, "still there?");
    let b_calls = other.last_session().calls();
    release.release();

    assert_eq!(entered.expect("expiry entered"), a);
    assert_ne!(a_while_expiring, ThreadStatus::Failed);
    assert_eq!(b_while_expiring, ThreadStatus::Active);
    assert!(!expired_while_blocked);
    b_send.expect("send b");
    assert_eq!(b_calls.last(), Some(&Call::Send("still there?".into())));
    wait_status(&h, &a, ThreadStatus::Failed);
    assert!(h.gate.expired().contains(&a));
    assert_eq!(
        h.runtime.get(&a).expect("failed thread").pending_approvals,
        0
    );
    assert!(
        !crashed_session
            .calls()
            .iter()
            .any(|call| matches!(call, Call::Respond(_, _))),
        "a dead provider cannot receive an approval response"
    );
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

struct RecordingProviderErrorObserver {
    core: Arc<Core>,
    observed: Mutex<Vec<(String, String, String, bool)>>,
}

impl ProviderErrorObserver for RecordingProviderErrorObserver {
    fn observe(
        &self,
        provider_id: &ProviderId,
        account_id: &str,
        code: &str,
    ) -> kalcode_core::Result<()> {
        let already_published = self.core.recent_events(500, None)?.iter().any(|event| {
            matches!(
                &event.event,
                EventPayload::ProviderError { code: published, .. } if published == code
            )
        });
        self.observed.lock().unwrap().push((
            provider_id.to_string(),
            account_id.to_owned(),
            code.to_owned(),
            already_published,
        ));
        Ok(())
    }
}

#[test]
fn provider_error_observer_gets_the_current_account_before_the_error_is_published() {
    let h = Harness::new();
    let observed = Arc::new(RecordingProviderErrorObserver {
        core: h.core.clone(),
        observed: Mutex::new(Vec::new()),
    });
    h.runtime
        .set_provider_error_observer(observed.clone())
        .expect("observer");
    let account_id = new_id();
    h.core
        .transact(|conn| {
            conn.execute(
                "INSERT INTO provider_accounts (
                    id, provider_id, display_name, authentication_state, is_default, created_at
                 ) VALUES (?1, 'claude-code', 'Fixture account', 'authenticated', 1, ?2)",
                rusqlite::params![&account_id, "2026-09-25T00:00:00Z"],
            )?;
            Ok(((), Vec::new()))
        })
        .expect("account");
    let mut request = h.request("x");
    request.provider_account_id = Some(account_id.clone());
    let thread = h.runtime.create(request).expect("create");
    h.provider.last_session().emit(AgentEvent::Error {
        code: "api_authentication_failed".into(),
        message: "Sign in again".into(),
        recoverable: true,
    });
    wait_until("provider error observation", || {
        !observed.observed.lock().unwrap().is_empty()
    });
    assert_eq!(
        observed.observed.lock().unwrap().as_slice(),
        &[(
            "fake".into(),
            account_id,
            "api_authentication_failed".into(),
            false,
        )]
    );
    wait_until("provider error publication", || {
        h.events_for(&thread.id).iter().any(|event| {
            matches!(
                &event.event,
                EventPayload::ProviderError { code, .. } if code == "api_authentication_failed"
            )
        })
    });
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
fn context_payload_reaches_the_provider_but_never_durable_history() {
    let h = Harness::new();
    let id = started(&h, "start");
    let marker = ["ephemeral", "context", "payload", "marker"].join("-");
    let visible = "Investigate this failure.";
    let rendered = rendered_context(&marker);
    let provider_payload = format!("{visible}\n\nContext supplied by you:\n{}", rendered.text())
        .trim_end()
        .to_owned();

    h.runtime
        .send_with_context(&id, visible, &rendered)
        .expect("send with context");

    assert_eq!(
        h.provider.last_session().calls().last(),
        Some(&Call::Send(provider_payload.clone()))
    );
    let messages = h.runtime.messages(&id, 50, None).expect("messages");
    assert_eq!(messages.last().expect("visible message").content, visible);
    assert!(
        messages
            .iter()
            .all(|message| !message.content.contains(&marker))
    );
    let events = serde_json::to_string(&h.events_for(&id)).expect("events serialize");
    assert!(!events.contains(&marker));

    let failed = Harness::new();
    let failed_id = started(&failed, "start");
    failed.provider.last_session().fail_next_sends();
    let summary = failed
        .runtime
        .send_with_context(&failed_id, visible, &rendered)
        .expect("provider failure returns the failed thread");
    assert_eq!(summary.status, ThreadStatus::Failed);
    let failed_messages = failed
        .runtime
        .messages(&failed_id, 50, None)
        .expect("failed messages");
    assert_eq!(
        failed_messages
            .last()
            .expect("visible failed message")
            .content,
        visible
    );
    assert!(
        failed_messages
            .iter()
            .all(|message| !message.content.contains(&marker))
    );
    let failed_events =
        serde_json::to_string(&failed.events_for(&failed_id)).expect("events serialize");
    assert!(!failed_events.contains(&marker));

    let invalid = Harness::new();
    let invalid_id = started(&invalid, "start");
    let invalid_session = invalid.provider.last_session();
    let before = invalid_session.calls();
    assert_code(
        invalid.runtime.send_with_context(
            &invalid_id,
            &"x".repeat(kalcode_threads::validate::MAX_PROMPT_CHARS + 1),
            &rendered,
        ),
        "invalid_prompt",
    );
    assert_code(
        invalid
            .runtime
            .send_with_context(&invalid_id, "safe\0unsafe", &rendered),
        "invalid_prompt",
    );
    assert_eq!(
        invalid_session.calls(),
        before,
        "invalid context never reaches the provider"
    );
    assert_eq!(
        invalid
            .runtime
            .messages(&invalid_id, 50, None)
            .unwrap()
            .len(),
        1
    );
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
            permission_mode: PermissionMode::Custom,
            ..h.request("x")
        },
        "custom_not_allowed_at_create",
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
    bad(
        CreateThread {
            effort: Some("high; --model opus".into()),
            ..h.request("x")
        },
        "invalid_effort",
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
fn unarchive_restores_a_thread_to_the_open_list() {
    let h = Harness::new();
    let a = started(&h, "first task");
    let b = started(&h, "second task");
    h.runtime.stop(&a).expect("stop");
    let archived = h.runtime.archive(&a).expect("archive");
    assert!(archived.archived_at.is_some());
    let status = archived.status;

    // An open thread is returned unchanged and records nothing.
    let open = h.runtime.unarchive(&b).expect("open thread");
    assert!(open.archived_at.is_none());
    assert!(
        !h.event_types().contains(&"thread.unarchived".to_owned()),
        "nothing was restored"
    );

    let restored = h.runtime.unarchive(&a).expect("unarchive");
    assert_eq!(restored.id, a);
    assert!(restored.archived_at.is_none());
    assert_eq!(restored.status, status, "status is unchanged");
    h.runtime.unarchive(&a).expect("idempotent");
    assert_eq!(
        h.event_types()
            .iter()
            .filter(|t| *t == "thread.unarchived")
            .count(),
        1
    );
    assert_eq!(h.runtime.list(None, false).unwrap().len(), 2);
    // A restored thread is usable again: resume no longer refuses it as archived.
    h.runtime.resume(&a, None).expect("resume after restore");

    assert_code(h.runtime.unarchive("bad"), "invalid_thread_id");
    assert_code(h.runtime.unarchive(&new_id()), "thread_not_found");
}

#[test]
fn permission_modes_are_stored_for_the_permission_engine() {
    let h = Harness::new();
    let id = started(&h, "x");
    let thread = h
        .runtime
        .set_permission_mode(&id, PermissionMode::Auto, None)
        .expect("mode");
    assert_eq!(thread.permission_mode, PermissionMode::Auto);
    assert_eq!(h.runtime.permission_profile_id(&id).expect("profile"), None);
    // The engine (Z4) records permission.mode_changed with its audit entry; storing records none.
    assert!(
        !h.events_for(&id)
            .iter()
            .any(|e| matches!(e.event, EventPayload::PermissionModeChanged { .. }))
    );

    // Custom keeps its profile; any other mode clears it.
    h.runtime
        .set_permission_mode(&id, PermissionMode::Custom, Some("code-reviewer"))
        .expect("custom");
    assert_eq!(
        h.runtime
            .permission_profile_id(&id)
            .expect("profile")
            .as_deref(),
        Some("code-reviewer")
    );
    h.runtime
        .set_permission_mode(&id, PermissionMode::Plan, Some("code-reviewer"))
        .expect("plan");
    assert_eq!(h.runtime.permission_profile_id(&id).expect("profile"), None);
    assert_code(
        h.runtime
            .set_permission_mode(&new_id(), PermissionMode::Plan, None),
        "thread_not_found",
    );
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
fn failed_stop_retains_the_live_session_for_a_proven_retry() {
    let h = Harness::new();
    let id = started(&h, "x");
    let session = h.provider.last_session();
    session.fail_next_terminate();

    let error = h.runtime.stop(&id).expect_err("termination must fail");
    assert_eq!(error.code, "provider_terminate_failed");
    assert_eq!(status(&h, &id), ThreadStatus::Active);
    assert!(
        !session.is_ended(),
        "the runtime must retain live ownership"
    );
    assert!(
        !h.gate.expired().contains(&id),
        "a failed termination must retain approval authority for the live retry"
    );

    let stopped = h.runtime.stop(&id).expect("retry termination");
    assert_eq!(stopped.status, ThreadStatus::Interrupted);
    assert!(session.is_ended());
    assert!(h.gate.expired().contains(&id));
    assert_eq!(
        session
            .calls()
            .iter()
            .filter(|call| **call == Call::Terminate)
            .count(),
        2
    );
}

#[test]
fn checked_shutdown_drains_every_session_and_reports_incomplete_termination() {
    let h = Harness::new();
    let failed_id = started(&h, "one");
    let failed_session = h.provider.last_session();
    let drained_id = started(&h, "two");
    let drained_session = h.provider.last_session();
    failed_session.fail_next_terminate();

    let error = h
        .runtime
        .shutdown_checked()
        .expect_err("one provider process is still owned");
    assert_eq!(error.code, "provider_terminate_failed");
    assert_eq!(status(&h, &failed_id), ThreadStatus::Active);
    assert_eq!(status(&h, &drained_id), ThreadStatus::Interrupted);
    assert!(!failed_session.is_ended());
    assert!(
        drained_session.is_ended(),
        "shutdown must continue draining"
    );

    h.runtime.shutdown_checked().expect("retry shutdown");
    assert_eq!(status(&h, &failed_id), ThreadStatus::Interrupted);
    assert!(failed_session.is_ended());
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
        provider_account_id: None,
        account_label: None,
        workspace_id: workspace_id.clone(),
        model: None,
        effort: None,
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
    // The relaunched session is at its prompt with no task yet: READY.
    assert_eq!(
        resumed.current_activity.as_deref(),
        Some(kalcode_threads::runtime::READY_ACTIVITY)
    );
    let messages = runtime.messages(&running, 10, None).unwrap();
    assert_eq!(messages[0].content, "running", "history survived the crash");
}

#[test]
fn idle_threads_start_without_a_task() {
    let h = Harness::new();
    let request = kalcode_threads::CreateIdleThread {
        provider_id: "fake".into(),
        provider_account_id: None,
        account_label: None,
        workspace_id: h.workspace_id.clone(),
        model: None,
        effort: None,
        permission_mode: PermissionMode::Approve,
        name: None,
    };
    let created = h.runtime.create_idle_threads(&request, 3).expect("bulk");
    assert_eq!(created.len(), 3);
    for thread in created {
        let thread = thread.expect("created");
        assert_eq!(thread.status, ThreadStatus::Idle, "waiting for input");
        assert_eq!(thread.name, "Fake Provider");
        assert!(h.runtime.messages(&thread.id, 10, None).unwrap().is_empty());
    }
    assert!(
        h.provider.last_session().calls().is_empty(),
        "nothing was sent"
    );
    assert_code(
        h.runtime.create_idle_threads(&request, 0),
        "invalid_thread_count",
    );
    assert_code(
        h.runtime.create_idle_threads(&request, 17),
        "invalid_thread_count",
    );

    let named = h
        .runtime
        .create_idle(kalcode_threads::CreateIdleThread {
            name: Some("Reviewer".into()),
            ..request
        })
        .expect("named");
    assert_eq!(named.name, "Reviewer");
    h.runtime.send(&named.id, "review the diff").expect("send");
    assert_eq!(status(&h, &named.id), ThreadStatus::Active);
}

fn idle_request(h: &Harness) -> kalcode_threads::CreateIdleThread {
    kalcode_threads::CreateIdleThread {
        provider_id: "fake".into(),
        provider_account_id: None,
        account_label: None,
        workspace_id: h.workspace_id.clone(),
        model: None,
        effort: None,
        permission_mode: PermissionMode::Approve,
        name: None,
    }
}

#[test]
fn smart_agent_names_follow_meaningful_tasks_and_preserve_manual_intent() {
    let h = Harness::new();
    let agent = h.runtime.create_idle(idle_request(&h)).unwrap();
    for filler in ["hello", "yes", "continue", "/model"] {
        assert_eq!(
            h.runtime.name_from_task(&agent.id, filler).unwrap().name,
            "Fake Provider"
        );
    }
    assert_eq!(
        h.runtime
            .name_from_task(&agent.id, "Redesign the pricing page and all plan tiers")
            .unwrap()
            .name,
        "Pricing Redesign"
    );
    assert_eq!(
        h.runtime
            .name_from_task(&agent.id, "add tests and fix the failing cases")
            .unwrap()
            .name,
        "Pricing Redesign"
    );
    assert_eq!(
        h.runtime
            .name_from_task(&agent.id, "New task: fix billing cancellation webhooks")
            .unwrap()
            .name,
        "Billing Cancellation Webhooks Fix"
    );
    assert_eq!(
        h.runtime
            .name_from_task(&agent.id, "Build the new Live Browser")
            .unwrap()
            .name,
        "Live Browser"
    );
    h.runtime.rename(&agent.id, "Fake Provider").unwrap();
    assert_eq!(
        h.runtime
            .name_from_task(&agent.id, "New task: redesign the pricing page")
            .unwrap()
            .name,
        "Fake Provider"
    );
    let pinned = h.runtime.create_idle(idle_request(&h)).unwrap();
    // Choosing exactly the existing default is still an explicit manual choice.
    h.runtime.rename(&pinned.id, "Fake Provider").unwrap();
    assert_eq!(
        h.runtime
            .name_from_task(&pinned.id, "Redesign the pricing page")
            .unwrap()
            .name,
        "Fake Provider"
    );
    assert!(
        h.runtime.messages(&agent.id, 10, None).unwrap().is_empty(),
        "title callbacks never persist user input"
    );
}

#[test]
fn smart_agent_names_survive_restart_and_concurrent_manual_rename() {
    let h = Harness::new();
    let agent = h.runtime.create_idle(idle_request(&h)).unwrap();
    std::thread::scope(|scope| {
        scope.spawn(|| {
            h.runtime
                .name_from_task(&agent.id, "Redesign pricing plans")
                .unwrap();
        });
        scope.spawn(|| {
            h.runtime.rename(&agent.id, "My Release").unwrap();
        });
    });
    assert_eq!(h.runtime.get(&agent.id).unwrap().name, "My Release");
    h.runtime.shutdown();
    let restarted = ThreadRuntime::new(
        h.core.clone(),
        h.registry.clone(),
        h.workspaces.clone(),
        h.gate.clone(),
    )
    .unwrap();
    assert_eq!(
        restarted
            .name_from_task(&agent.id, "New task: fix billing cancellation webhooks")
            .unwrap()
            .name,
        "My Release"
    );
}

#[test]
fn smart_agent_names_are_shared_by_direct_native_task_submission() {
    let h = Harness::new();
    let agent = h.runtime.create_idle(idle_request(&h)).unwrap();
    let submitted = h
        .runtime
        .send(&agent.id, "Redesign the pricing page")
        .unwrap();
    assert_eq!(submitted.name, "Pricing Redesign");
    assert!(
        h.runtime
            .list(None, false)
            .unwrap()
            .iter()
            .any(|item| item.id == agent.id && item.name == submitted.name)
    );
}

#[test]
fn smart_agent_names_restore_legacy_defaults_without_rewriting_manual_names() {
    let h = Harness::new();
    let old = h.runtime.create_idle(idle_request(&h)).unwrap();
    let manual = h.runtime.create_idle(idle_request(&h)).unwrap();
    h.runtime.rename(&manual.id, "New agent").unwrap();
    h.runtime.shutdown();
    // Pre-upgrade rows have no naming metadata. Their rename event remains authoritative.
    h.core
        .write_with_events(|tx| {
            tx.execute("UPDATE threads SET name='New agent' WHERE id=?1", [&old.id])?;
            for id in [&old.id, &manual.id] {
                tx.execute(
                    "DELETE FROM app_meta WHERE key=?1",
                    [format!("thread.name.origin:{id}")],
                )?;
            }
            Ok(((), Vec::new()))
        })
        .unwrap();
    let restarted = ThreadRuntime::new(
        h.core.clone(),
        h.registry.clone(),
        h.workspaces.clone(),
        h.gate.clone(),
    )
    .unwrap();
    assert_eq!(restarted.get(&old.id).unwrap().name, "Fake Provider");
    assert_eq!(
        restarted
            .name_from_task(&old.id, "Redesign the pricing page")
            .unwrap()
            .name,
        "Pricing Redesign"
    );
    assert_eq!(
        restarted
            .name_from_task(&manual.id, "Redesign the pricing page")
            .unwrap()
            .name,
        "New agent"
    );
}

#[test]
fn exact_unused_launch_group_restarts_with_persisted_model_and_effort() {
    let h = Harness::new();
    let created = h
        .runtime
        .create_idle_threads(&idle_request(&h), 2)
        .expect("create")
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .expect("threads");
    let ids = created
        .iter()
        .map(|thread| thread.id.clone())
        .collect::<Vec<_>>();
    let targets = h.runtime.launch_instances(&ids).expect("instances");
    let updated = h
        .runtime
        .reconfigure_idle_launch(&targets, &ProviderId::new("fake"), "fake-small", "high")
        .expect("reconfigure");
    assert_eq!(updated.len(), 2);
    assert!(updated.iter().all(|thread| {
        thread.status == ThreadStatus::Idle
            && thread.model.as_deref() == Some("fake-small")
            && thread.effort.as_deref() == Some("high")
    }));
    assert_eq!(h.provider.session_count(), 4, "both sessions restarted");
    for session in h.provider.sessions.lock().unwrap().iter().skip(2) {
        assert_eq!(session.config.model.as_deref(), Some("fake-small"));
        assert_eq!(session.config.effort.as_deref(), Some("high"));
    }
}

#[test]
fn native_draft_refuses_the_whole_recent_launch_without_effects() {
    let h = Harness::new();
    let created = h
        .runtime
        .create_idle_threads(&idle_request(&h), 2)
        .expect("create")
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .expect("threads");
    let ids = created
        .iter()
        .map(|thread| thread.id.clone())
        .collect::<Vec<_>>();
    let targets = h.runtime.launch_instances(&ids).expect("instances");
    h.provider.session(1).type_native_draft();
    assert_code(
        h.runtime
            .reconfigure_idle_launch(&targets, &ProviderId::new("fake"), "fake-small", "high"),
        "recent_launch_not_unused",
    );
    assert_eq!(h.provider.session_count(), 2, "nothing restarted");
    for (index, id) in ids.iter().enumerate() {
        let thread = h.runtime.get(id).expect("thread");
        assert_eq!(thread.status, ThreadStatus::Idle);
        assert_eq!(thread.model, None);
        assert!(!h.provider.session(index).is_ended());
    }
}

#[test]
fn recent_launch_reconfigure_reconciles_start_and_terminate_failures() {
    let h = Harness::new();
    let created = h
        .runtime
        .create_idle_threads(&idle_request(&h), 2)
        .expect("create")
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .expect("threads");
    let ids = created
        .iter()
        .map(|thread| thread.id.clone())
        .collect::<Vec<_>>();
    let targets = h.runtime.launch_instances(&ids).expect("instances");
    h.provider
        .fail_next_start(ProviderError::Start("injected".into()));
    let updated = h
        .runtime
        .reconfigure_idle_launch(&targets, &ProviderId::new("fake"), "fake-small", "high")
        .expect("truthful partial result");
    assert_eq!(updated.len(), 2);
    assert!(
        updated
            .iter()
            .all(|thread| thread.status != ThreadStatus::Starting)
    );
    assert!(
        updated
            .iter()
            .any(|thread| thread.status == ThreadStatus::Failed)
    );
    assert!(
        updated
            .iter()
            .any(|thread| thread.status == ThreadStatus::Idle)
    );

    let fresh = h
        .runtime
        .create_idle_threads(&idle_request(&h), 2)
        .expect("second group")
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .expect("threads");
    let fresh_ids = fresh
        .iter()
        .map(|thread| thread.id.clone())
        .collect::<Vec<_>>();
    let fresh_targets = h.runtime.launch_instances(&fresh_ids).expect("instances");
    let failing_id = fresh_targets[1].thread_id.clone();
    let session_index = fresh_ids
        .iter()
        .position(|id| id == &failing_id)
        .expect("target");
    h.provider
        .session(h.provider.session_count() - 2 + session_index)
        .fail_next_terminate();
    assert_code(
        h.runtime.reconfigure_idle_launch(
            &fresh_targets,
            &ProviderId::new("fake"),
            "fake-small",
            "max",
        ),
        "provider_terminate_failed",
    );
    for id in fresh_ids {
        let thread = h.runtime.get(&id).expect("restored");
        assert_ne!(thread.status, ThreadStatus::Starting);
        assert_eq!(thread.model, None, "old configuration retained");
        assert_eq!(thread.effort, None, "old configuration retained");
    }
}

#[test]
fn concurrent_stop_waits_for_recent_launch_reconfigure_and_is_not_overwritten() {
    let h = Harness::new();
    let created = h
        .runtime
        .create_idle_threads(&idle_request(&h), 1)
        .expect("create")
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .expect("thread");
    let id = created[0].id.clone();
    let targets = h
        .runtime
        .launch_instances(std::slice::from_ref(&id))
        .expect("instance");

    let (entered_tx, entered_rx) = sync_channel(1);
    let (release_tx, release_rx) = sync_channel(1);
    let first = Arc::new(std::sync::atomic::AtomicBool::new(true));
    h.provider.set_start_observer({
        let first = first.clone();
        let release_rx = Mutex::new(release_rx);
        move || {
            if first.swap(false, std::sync::atomic::Ordering::SeqCst) {
                entered_tx.send(()).expect("announce blocked start");
                release_rx.lock().unwrap().recv().expect("release start");
            }
        }
    });

    let runtime = Arc::new(h.runtime);
    let configuring = {
        let runtime = runtime.clone();
        std::thread::spawn(move || {
            runtime.reconfigure_idle_launch(
                &targets,
                &ProviderId::new("fake"),
                "fake-small",
                "high",
            )
        })
    };
    entered_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("reconfigure reached provider start");

    let (stop_entered_tx, stop_entered_rx) = sync_channel(1);
    let (stopped_tx, stopped_rx) = sync_channel(1);
    let stopping = {
        let runtime = runtime.clone();
        let id = id.clone();
        std::thread::spawn(move || {
            stop_entered_tx.send(()).expect("announce stop call");
            stopped_tx.send(runtime.stop(&id)).expect("return stop");
        })
    };
    stop_entered_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("stop task reached runtime call");
    assert!(
        stopped_rx.recv_timeout(Duration::from_millis(75)).is_err(),
        "stop must wait on the same live-thread authority lock"
    );

    release_tx.send(()).expect("release provider start");
    let configured = configuring
        .join()
        .expect("reconfigure task")
        .expect("reconfigure");
    assert_eq!(configured[0].status, ThreadStatus::Idle);
    let stopped = stopped_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("stop completed")
        .expect("stop");
    stopping.join().expect("stop task");
    assert_eq!(stopped.status, ThreadStatus::Interrupted);
    assert_eq!(
        runtime.get(&id).expect("final thread").status,
        ThreadStatus::Interrupted
    );
}

#[test]
fn effort_is_normalized_persisted_and_reused_after_runtime_restart() {
    let h = Harness::new();
    let created = h
        .runtime
        .create(CreateThread {
            effort: Some(" HIGH ".into()),
            ..h.request("keep the selected effort")
        })
        .expect("create");
    assert_eq!(created.effort.as_deref(), Some("high"));
    assert_eq!(
        h.provider.last_session().config.effort.as_deref(),
        Some("high")
    );
    h.runtime.stop(&created.id).expect("stop");

    let Harness {
        dir,
        core,
        registry,
        workspaces,
        workspace_id,
        gate,
        provider,
        runtime,
    } = h;
    drop(runtime);
    let restarted = ThreadRuntime::new(core, registry, workspaces, gate).expect("restart");
    assert_eq!(
        restarted
            .get(&created.id)
            .expect("summary")
            .effort
            .as_deref(),
        Some("high")
    );
    restarted.resume(&created.id, None).expect("resume");
    assert_eq!(
        provider.last_session().config.effort.as_deref(),
        Some("high")
    );
    drop((dir, workspace_id));
}

#[test]
fn selected_provider_account_survives_runtime_restart_and_default_changes() {
    let h = Harness::new();
    let provider = FakeProvider::configured(ProviderId::CODEX, "Codex", true, true);
    h.registry.register(provider.clone());
    let personal_id = new_id();
    let work_id = new_id();
    h.core
        .transact(|conn| {
            for (id, label, is_default) in
                [(&personal_id, "Personal", 1_i64), (&work_id, "Work", 0_i64)]
            {
                conn.execute(
                    "INSERT INTO provider_accounts (
                        id, provider_id, display_name, authentication_state, is_default, created_at
                     ) VALUES (?1, 'codex', ?2, 'authenticated', ?3, ?4)",
                    rusqlite::params![id, label, is_default, "2026-09-25T00:00:00Z"],
                )?;
            }
            Ok(((), Vec::new()))
        })
        .expect("accounts");

    let created = h
        .runtime
        .create(CreateThread {
            provider_id: ProviderId::CODEX.into(),
            provider_account_id: Some(personal_id.clone()),
            account_label: Some("My Personal".into()),
            workspace_id: h.workspace_id.clone(),
            model: None,
            effort: None,
            permission_mode: PermissionMode::Approve,
            prompt: "keep this account".into(),
            name: None,
        })
        .expect("thread");
    assert_eq!(
        created.provider_account_id.as_deref(),
        Some(personal_id.as_str())
    );
    assert_eq!(created.account_label.as_deref(), Some("My Personal"));
    assert_eq!(
        provider
            .last_session()
            .config
            .provider_account_id
            .as_deref(),
        Some(personal_id.as_str())
    );

    h.core
        .transact(|conn| {
            conn.execute(
                "UPDATE provider_accounts
                 SET is_default = 0, archived_at = '2026-09-25T01:00:00Z'
                 WHERE id = ?1",
                [&personal_id],
            )?;
            conn.execute(
                "UPDATE provider_accounts SET is_default = 1 WHERE id = ?1",
                [&work_id],
            )?;
            Ok(((), Vec::new()))
        })
        .expect("switch default");
    h.runtime.stop(&created.id).expect("stop");

    let Harness {
        dir,
        core,
        registry,
        workspaces,
        workspace_id,
        gate,
        provider: _,
        runtime,
    } = h;
    drop(runtime);
    let restarted = ThreadRuntime::new(
        core.clone(),
        registry.clone(),
        workspaces.clone(),
        gate.clone(),
    )
    .expect("restart");
    let sessions_before = provider.session_count();
    // The thread keeps its archived account selection instead of using the new default, and
    // says so clearly rather than launching anything.
    assert_code(
        restarted.resume(&created.id, None),
        "provider_account_archived",
    );
    assert_eq!(provider.session_count(), sessions_before);
    let resumed = restarted.get(&created.id).expect("summary");
    assert_eq!(
        resumed.provider_account_id.as_deref(),
        Some(personal_id.as_str())
    );
    assert_eq!(resumed.account_label.as_deref(), Some("My Personal"));
    drop((dir, workspace_id));
}

#[test]
fn legacy_thread_creation_does_not_claim_the_registry_account_without_a_selected_id() {
    let h = Harness::new();
    h.registry.register_entry(ProviderEntry {
        provider: h.provider.clone(),
        account_label: Some("Standalone CLI".into()),
        secret_ref: None,
    });
    let created = h
        .runtime
        .create(h.request("legacy thread"))
        .expect("thread");
    assert_eq!(created.provider_account_id, None);
    assert_eq!(created.account_label, None);
    assert_eq!(h.provider.last_session().config.provider_account_id, None);
}

#[test]
fn scoped_operations_and_search_for_non_ui_callers() {
    use kalcode_contracts::kalvoice::ThreadScope;
    let h = Harness::new();
    let a = started(&h, "fix the login flow");
    let b = started(&h, "write release notes");

    // A named thread in the wrong state reports why.
    h.runtime.stop(&b).expect("stop b");
    let outcome = h.runtime.pause_threads(&ThreadScope::Thread {
        thread_id: b.clone(),
    });
    assert_eq!(outcome.len(), 1);
    assert!(!outcome[0].ok);
    assert!(
        outcome[0]
            .message
            .as_deref()
            .unwrap_or("")
            .contains("isn't running")
    );

    // Workspace scope only touches that workspace's threads.
    let other = kalcode_threads::ResolvedWorkspace {
        id: new_id(),
        name: "other".into(),
        root: h.dir.path().join("other"),
    };
    assert!(
        h.runtime
            .pause_threads(&ThreadScope::Workspace {
                workspace_id: other.id.clone()
            })
            .is_empty()
    );
    let paused = h.runtime.pause_threads(&ThreadScope::Workspace {
        workspace_id: h.workspace_id.clone(),
    });
    assert_eq!(
        paused
            .iter()
            .map(|o| o.thread_id.as_str())
            .collect::<Vec<_>>(),
        [a.as_str()]
    );
    assert_eq!(status(&h, &a), ThreadStatus::Paused);
    let resumed = h.runtime.resume_threads(&ThreadScope::All);
    assert_eq!(resumed.len(), 1);
    assert_eq!(status(&h, &a), ThreadStatus::Idle);
    let stopped = h.runtime.stop_threads(&ThreadScope::All);
    assert_eq!(stopped.len(), 1, "only threads with a session are stopped");

    let found = h.runtime.find("  LOGIN ").unwrap();
    assert_eq!(
        found.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
        [a.as_str()]
    );
    let by_workspace = h.runtime.find("kalcode").unwrap();
    assert_eq!(by_workspace.len(), 2);
    assert!(h.runtime.find("   ").unwrap().is_empty());
    let exact = h.runtime.find("write release notes").unwrap();
    assert_eq!(exact[0].id, b, "exact name first");
}

#[test]
fn every_plan_can_start_and_resume_agents_beyond_obsolete_caps() {
    use kalcode_core::plans::{Limited, PlanTier};
    let h = Harness::new();
    for tier in kalcode_core::plans::PUBLIC_PLANS {
        h.runtime
            .set_agent_limit(Arc::new(move || tier.limit(Limited::ParallelAgents)));
        for _ in 0..5 {
            started(&h, "parallel task");
        }
    }
    assert_eq!(h.runtime.list(None, true).expect("list").len(), 20);
    let first = started(&h, "resume task");
    h.runtime.stop(&first).expect("stop");
    h.runtime
        .set_agent_limit(Arc::new(|| PlanTier::Free.limit(Limited::ParallelAgents)));
    h.runtime
        .resume(&first, None)
        .expect("unlimited resume on Free");
}

#[test]
fn running_thread_snapshot_binds_exact_sessions_and_keeps_paused_processes() {
    use kalcode_contracts::kalvoice::ThreadScope;

    let h = Harness::new();
    let a = started(&h, "work on frontend");
    let b = started(&h, "work on backend");
    h.runtime.pause(&a).expect("pause while retaining session");

    let all = h
        .runtime
        .running_threads(&ThreadScope::All)
        .expect("running snapshot");
    let ids = all
        .iter()
        .map(|target| target.thread.id.as_str())
        .collect::<Vec<_>>();
    assert!(ids.contains(&a.as_str()), "paused session stays bound");
    assert!(ids.contains(&b.as_str()));

    let exact = h
        .runtime
        .running_threads(&ThreadScope::Thread {
            thread_id: a.clone(),
        })
        .expect("exact running snapshot");
    assert_eq!(exact.len(), 1);
    assert_eq!(exact[0].thread.id, a);

    let stale = h
        .runtime
        .running_threads(&ThreadScope::Thread {
            thread_id: b.clone(),
        })
        .expect("bound backend")
        .pop()
        .expect("running backend");

    h.runtime.stop(&b).expect("stop backend");
    h.runtime.resume(&b, None).expect("replace backend session");
    assert_eq!(
        h.runtime
            .stop_running_thread(&stale)
            .expect_err("stale target must not stop replacement")
            .code,
        "thread_stop_target_changed"
    );
    assert!(
        h.runtime
            .running_threads(&ThreadScope::Thread {
                thread_id: b.clone(),
            })
            .expect("replacement snapshot")
            .iter()
            .any(|target| target.thread.id == b),
        "replacement session remains running"
    );
}

#[test]
fn a_thread_bound_to_its_own_worktree_runs_and_resumes_there() {
    let h = Harness::new();
    let worktree = h.dir.path().join("worktrees").join("wt-1");
    let cwd = worktree.join("sub");
    std::fs::create_dir_all(&cwd).expect("worktree folder");
    let (thread_id, worktree_id) = (new_id(), new_id());
    let bind = |core: &Core, id: &str, path: &std::path::Path, owner: &str| {
        core.transact(|tx| {
            tx.execute(
                "INSERT INTO git_worktrees (id, workspace_id, path, branch, base_commit, purpose,
                    owner_ref, status, created_at)
                 VALUES (?1, ?2, ?3, 'kal/agent-12345678', ?4, 'thread', ?5, 'active', 't')",
                (
                    id,
                    &h.workspace_id,
                    path.to_string_lossy().into_owned(),
                    "a".repeat(40),
                    owner,
                ),
            )?;
            Ok(((), Vec::new()))
        })
        .expect("binding");
    };

    // Request checks run before the folder is prepared: a failing request costs no checkout.
    let mut bad = h.request("x");
    bad.provider_id = "missing".into();
    let prepared = std::cell::Cell::new(false);
    assert!(
        h.runtime
            .create_reviewed_in(&new_id(), bad, None, || {
                prepared.set(true);
                Ok(cwd.clone())
            })
            .is_err()
    );
    assert!(!prepared.get());
    // The prepared folder must be an existing absolute path.
    assert_code(
        h.runtime
            .create_reviewed_in(&new_id(), h.request("x"), None, || {
                Ok(h.dir.path().join("missing"))
            }),
        "thread_folder_unavailable",
    );
    assert_eq!(h.provider.session_count(), 0);

    let thread = h
        .runtime
        .create_reviewed_in(&thread_id, h.request("work alone"), None, || {
            // The caller records the binding while preparing the folder.
            bind(&h.core, &worktree_id, &worktree, &thread_id);
            Ok(cwd.clone())
        })
        .expect("create");
    assert_eq!(thread.id, thread_id);
    assert_eq!(thread.branch.as_deref(), Some("kal/agent-12345678"));
    assert_eq!(thread.worktree_id.as_deref(), Some(worktree_id.as_str()));
    let folder = cwd.to_string_lossy().into_owned();
    assert_eq!(h.provider.last_session().config.working_directory, folder);
    let listed = h.runtime.list(None, false).expect("list");
    assert_eq!(listed[0].worktree_id.as_deref(), Some(worktree_id.as_str()));

    // Resume keeps the worktree folder (an unbound thread would re-resolve the workspace root).
    h.runtime.stop(&thread_id).expect("stop");
    h.runtime.resume(&thread_id, Some("go on")).expect("resume");
    assert_eq!(h.provider.session_count(), 2);
    assert_eq!(h.provider.last_session().config.working_directory, folder);

    // When the worktree folder is gone, resume never falls back to the workspace folder:
    // without a way to re-attach it, it refuses and the thread keeps its folder.
    h.runtime.stop(&thread_id).expect("stop");
    std::fs::remove_dir_all(&worktree).expect("remove worktree folder");
    assert_code(
        h.runtime.resume(&thread_id, Some("again")),
        "thread_folder_unavailable",
    );
    assert_eq!(h.provider.session_count(), 2);
    let stored = h
        .core
        .read(|conn| kalcode_threads::store::get(conn, &thread_id))
        .expect("row");
    assert_eq!(stored.cwd, folder);

    // With re-attachment, the branch comes back in a fresh worktree and the thread runs there.
    type Bind = dyn Fn(&Core, &str, &std::path::Path, &str) + Send + Sync;
    struct Reattach {
        core: Arc<Core>,
        folder: std::path::PathBuf,
        bind: Box<Bind>,
        released: Mutex<Vec<String>>,
    }
    impl kalcode_threads::ThreadWorktrees for Reattach {
        fn reattach(&self, thread_id: &str) -> kalcode_core::Result<std::path::PathBuf> {
            std::fs::create_dir_all(&self.folder).expect("fresh worktree");
            self.core.transact(|tx| {
                tx.execute(
                    "UPDATE git_worktrees SET status = 'removed', removed_at = 't'
                     WHERE owner_ref = ?1",
                    [thread_id],
                )?;
                Ok(((), Vec::new()))
            })?;
            (self.bind)(&self.core, &new_id(), &self.folder, thread_id);
            Ok(self.folder.clone())
        }
        fn release(&self, thread_id: &str) {
            self.released.lock().unwrap().push(thread_id.to_owned());
        }
    }
    let fresh = h.dir.path().join("worktrees").join("wt-2");
    let workspace_id = h.workspace_id.clone();
    let hooks = Arc::new(Reattach {
        core: h.core.clone(),
        folder: fresh.clone(),
        bind: Box::new(move |core, id, path, owner| {
            core.transact(|tx| {
                tx.execute(
                    "INSERT INTO git_worktrees (id, workspace_id, path, branch, base_commit,
                        purpose, owner_ref, status, created_at)
                     VALUES (?1, ?2, ?3, 'kal/agent-12345678', ?4, 'thread', ?5, 'active', 't2')",
                    (
                        id,
                        &workspace_id,
                        path.to_string_lossy().into_owned(),
                        "a".repeat(40),
                        owner,
                    ),
                )?;
                Ok(((), Vec::new()))
            })
            .expect("rebind");
        }),
        released: Mutex::new(Vec::new()),
    });
    h.runtime.set_thread_worktrees(hooks.clone());
    let resumed = h.runtime.resume(&thread_id, Some("again")).expect("resume");
    assert_eq!(
        h.provider.last_session().config.working_directory,
        fresh.to_string_lossy()
    );
    assert_eq!(resumed.branch.as_deref(), Some("kal/agent-12345678"));
    assert_ne!(resumed.worktree_id.as_deref(), Some(worktree_id.as_str()));

    // Archiving lets the desktop free the folder (the branch stays for a later resume).
    h.runtime.stop(&thread_id).expect("stop");
    h.runtime.archive(&thread_id).expect("archive");
    assert_eq!(
        *hooks.released.lock().unwrap(),
        std::slice::from_ref(&thread_id)
    );

    // A thread without a worktree keeps reporting none.
    let plain = h.runtime.create(h.request("shared folder")).expect("plain");
    assert_eq!((plain.branch, plain.worktree_id), (None, None));
}

#[test]
fn free_agents_can_prepare_worktrees_with_other_agents_running() {
    use kalcode_core::plans::{Limited, PlanTier};
    let h = Harness::new();
    h.runtime
        .set_agent_limit(Arc::new(|| PlanTier::Free.limit(Limited::ParallelAgents)));
    let _first = started(&h, "first task");
    let prepared = std::cell::Cell::new(false);
    h.runtime
        .create_reviewed_in(&new_id(), h.request("isolated"), None, || {
            prepared.set(true);
            Ok(h.dir.path().to_path_buf())
        })
        .expect("unlimited Free agents");
    assert!(
        prepared.get(),
        "the additional Free agent prepares its worktree"
    );
    assert_eq!(h.runtime.list(None, true).expect("list").len(), 2);
}
