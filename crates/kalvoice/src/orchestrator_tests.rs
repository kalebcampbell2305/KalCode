//! Orchestrator tests with fakes (executor, permission gate, provider). All fakes here are
//! test doubles; production wiring lives in the desktop shell.

use std::sync::atomic::{AtomicUsize, Ordering};

use kalcode_contracts::agent::{
    AgentEventSink, AgentSession, AuthState, DetectionState, ProviderCapabilities,
    ProviderDetection, ProviderError,
};
use kalcode_contracts::permissions::{ApprovalRequest, ApprovalStatus, PolicyDecision};
use kalcode_core::flags::BuildChannel;
use kalcode_core::{CoreConfig, Paths};
use time::macros::datetime;

use super::*;
use crate::plan::{FixedEntitlement, Tier};
use crate::prefs::IntelligenceChoice;

const NOW: OffsetDateTime = datetime!(2026-09-24 18:00 UTC);

#[derive(Default)]
struct FakeExecutor {
    executed: Mutex<Vec<KalVoiceIntent>>,
    unavailable: bool,
}

impl Executor for FakeExecutor {
    fn find_workspace(&self, name: &str) -> std::result::Result<Option<String>, ExecError> {
        Ok((name == "kalcode").then(|| "0192f3c4-0000-7000-8000-00000000000a".to_owned()))
    }
    fn find_thread(&self, name: &str) -> std::result::Result<Option<String>, ExecError> {
        Ok((name == "login fix").then(|| "0192f3c4-0000-7000-8000-00000000000b".to_owned()))
    }
    fn check(&self, intent: &KalVoiceIntent) -> std::result::Result<(), ExecError> {
        if self.unavailable && !matches!(intent, KalVoiceIntent::Navigate { .. }) {
            return Err(ExecError::new(
                "threads_unavailable",
                "Threads aren't available in this build yet.",
            ));
        }
        Ok(())
    }
    fn execute(
        &self,
        intent: &KalVoiceIntent,
        _ctx: &ExecContext,
    ) -> std::result::Result<Executed, ExecError> {
        self.executed.lock().expect("lock").push(intent.clone());
        Ok(Executed {
            summary: format!("Done: {}", describe(intent)),
            directive: match intent {
                KalVoiceIntent::Navigate { surface } => {
                    Some(UiDirective::Navigate { surface: *surface })
                }
                _ => None,
            },
        })
    }
}

struct FakeGate {
    effect: PolicyEffect,
    modes: Mutex<Vec<PermissionMode>>,
    opened: AtomicUsize,
}

impl FakeGate {
    fn new(effect: PolicyEffect) -> Self {
        Self {
            effect,
            modes: Mutex::new(Vec::new()),
            opened: AtomicUsize::new(0),
        }
    }
}

impl PermissionGate for FakeGate {
    fn evaluate(&self, _action: &NormalizedAction, mode: PermissionMode) -> PolicyDecision {
        self.modes.lock().expect("lock").push(mode);
        PolicyDecision {
            effect: self.effect,
            scopes: vec![],
            reason: "Test policy.".into(),
            approvable: true,
        }
    }
    fn open_request(
        &self,
        action: NormalizedAction,
        mode: PermissionMode,
        decision: PolicyDecision,
    ) -> std::result::Result<ApprovalRequest, String> {
        self.opened.fetch_add(1, Ordering::SeqCst);
        Ok(ApprovalRequest {
            id: new_id(),
            action,
            decision,
            permission_mode: mode,
            status: ApprovalStatus::Pending,
            resolved_decision: None,
            resolved_at: None,
        })
    }
    fn expire_for_thread(&self, _thread_id: &str) {}
}

/// Test double provider: answers with a fixed message, or never answers.
struct FakeProvider {
    answer: Option<String>,
    configs: Arc<Mutex<Vec<SessionConfig>>>,
    terminated: Arc<AtomicUsize>,
}

struct FakeSession {
    answer: Option<String>,
    sink: Box<dyn AgentEventSink>,
    terminated: Arc<AtomicUsize>,
}

impl AgentSession for FakeSession {
    fn provider_session_id(&self) -> Option<String> {
        None
    }
    fn send(&self, input: AgentInput) -> std::result::Result<(), ProviderError> {
        let AgentInput::Text { text } = input;
        assert!(text.contains("read-only planning mode"));
        if let Some(answer) = &self.answer {
            self.sink.emit(AgentEvent::ApprovalRequired {
                request_id: "approval-1".into(),
                action: NormalizedAction {
                    id: "a".into(),
                    thread_id: String::new(),
                    workspace_id: String::new(),
                    provider_id: ProviderId::new("claude-code"),
                    action: ActionKind::FileWrite { path: "x".into() },
                    summary: String::new(),
                    requested_at: String::new(),
                },
            });
            self.sink.emit(AgentEvent::MessageDelta {
                message_id: "m".into(),
                text: "partial".into(),
            });
            self.sink.emit(AgentEvent::MessageCompleted {
                message_id: "m".into(),
                text: answer.clone(),
            });
            self.sink.emit(AgentEvent::TurnCompleted { ok: true });
        }
        Ok(())
    }
    fn interrupt(&self) -> std::result::Result<(), ProviderError> {
        Ok(())
    }
    fn terminate(&self) -> std::result::Result<(), ProviderError> {
        self.terminated.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    fn respond_to_approval(
        &self,
        _request_id: &str,
        decision: ApprovalDecision,
    ) -> std::result::Result<(), ProviderError> {
        assert_eq!(
            decision,
            ApprovalDecision::Deny,
            "reasoning never approves actions"
        );
        Ok(())
    }
}

impl AgentProvider for FakeProvider {
    fn id(&self) -> ProviderId {
        ProviderId::new(ProviderId::CLAUDE_CODE)
    }
    fn display_name(&self) -> &str {
        "Claude"
    }
    fn detect(&self) -> ProviderDetection {
        ProviderDetection {
            provider_id: self.id(),
            display_name: "Claude Code".into(),
            state: DetectionState::Installed,
            display_path: None,
            version: None,
            minimum_version: None,
            auth: AuthState::Authenticated,
            message: None,
            checked_at: String::new(),
        }
    }
    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            streaming: true,
            interrupt: true,
            resume: false,
            host_approvals: true,
            models: vec![],
            permission_mappings: vec![],
        }
    }
    fn start_session(
        &self,
        config: SessionConfig,
        sink: Box<dyn AgentEventSink>,
    ) -> std::result::Result<Box<dyn AgentSession>, ProviderError> {
        self.configs.lock().expect("lock").push(config);
        Ok(Box::new(FakeSession {
            answer: self.answer.clone(),
            sink,
            terminated: self.terminated.clone(),
        }))
    }
}

struct FakeDirectory {
    providers: Vec<ProviderChoice>,
    provider: Option<Arc<FakeProvider>>,
}

impl ProviderDirectory for FakeDirectory {
    fn connected(&self) -> Vec<ProviderChoice> {
        self.providers.clone()
    }
    fn provider(&self, _id: &ProviderId) -> Option<Arc<dyn AgentProvider>> {
        self.provider.clone().map(|p| p as Arc<dyn AgentProvider>)
    }
    fn session_config(
        &self,
        request_id: &str,
        workspace_id: Option<&str>,
    ) -> Option<SessionConfig> {
        Some(SessionConfig {
            thread_id: request_id.to_owned(),
            workspace_id: workspace_id.unwrap_or_default().to_owned(),
            working_directory: "C:/work".into(),
            model: None,
            permission_mode: PermissionMode::Auto,
            resume_session_id: None,
            secret_ref: None,
        })
    }
}

struct Harness {
    _dir: tempfile::TempDir,
    core: Arc<Core>,
    executor: Arc<FakeExecutor>,
    gate: Arc<FakeGate>,
    orchestrator: Orchestrator,
}

fn harness_with(
    tier: Tier,
    executor: FakeExecutor,
    effect: PolicyEffect,
    directory: Arc<dyn ProviderDirectory>,
) -> Harness {
    let dir = tempfile::tempdir().expect("tempdir");
    let core = Arc::new(
        Core::open(CoreConfig {
            paths: Paths::new(dir.path()),
            app_version: "test".into(),
            channel: BuildChannel::Development,
        })
        .expect("core"),
    );
    let executor = Arc::new(executor);
    let gate = Arc::new(FakeGate::new(effect));
    let orchestrator = Orchestrator::new(
        core.clone(),
        Arc::new(FixedEntitlement(tier)),
        executor.clone(),
        gate.clone(),
        directory,
    )
    .with_clock(|| NOW)
    .with_reasoning_timeout(Duration::from_millis(300));
    Harness {
        _dir: dir,
        core,
        executor,
        gate,
        orchestrator,
    }
}

fn harness() -> Harness {
    harness_with(
        Tier::Free,
        FakeExecutor::default(),
        PolicyEffect::Allow,
        Arc::new(NoProviders),
    )
}

fn request(text: &str) -> CommandRequest {
    CommandRequest {
        request_id: new_id(),
        text: text.into(),
        input: KalVoiceInput::Text,
        workspace_id: None,
    }
}

fn kalvoice_events(core: &Core) -> Vec<serde_json::Value> {
    core.recent_events(200, None)
        .expect("events")
        .into_iter()
        .rev()
        .filter(|e| e.event.type_name().starts_with("kalvoice."))
        .map(|e| serde_json::to_value(&e).expect("json"))
        .collect()
}

fn types(events: &[serde_json::Value]) -> Vec<String> {
    events
        .iter()
        .map(|e| e["type"].as_str().unwrap_or_default().to_owned())
        .collect()
}

#[test]
fn typed_navigation_runs_counts_once_and_records_facts_only() {
    let h = harness();
    let secret_text = "Go to settings";
    let response = h.orchestrator.handle(request(secret_text)).expect("handle");
    assert_eq!(
        response.outcome,
        KalVoiceOutcome::Completed {
            summary: "Done: navigate".into()
        }
    );
    assert_eq!(
        response.directive,
        Some(UiDirective::Navigate {
            surface: SurfaceId::Settings
        })
    );
    assert!(response.counted);
    assert_eq!(response.usage.used, 1);
    assert_eq!(response.usage.allowance, Some(250));
    assert_eq!(response.usage.resets_at, "2026-10-01T00:00:00.000Z");
    assert_eq!(response.intent.as_deref(), Some("navigate"));
    let events = kalvoice_events(&h.core);
    assert_eq!(
        types(&events),
        [
            "kalvoice.request_started",
            "kalvoice.command_recognized",
            "kalvoice.command_executed",
            "kalvoice.request_completed"
        ]
    );
    assert!(events.iter().all(|e| e["source"] == "kalvoice"));
    assert!(
        events
            .iter()
            .all(|e| e["correlation"]["requestId"] == response.request_id.as_str())
    );
    let json = serde_json::to_string(&events).expect("json");
    assert!(
        !json.to_lowercase().contains("go to settings"),
        "no request text in events"
    );
}

fn talk(text: &str, target: TalkTarget) -> TalkRequest {
    TalkRequest {
        request_id: new_id(),
        session_id: new_id(),
        text: text.into(),
        target,
        duration_ms: 1200,
        workspace_id: None,
    }
}

#[test]
fn one_gesture_routes_commands_dictation_and_requests() {
    use TalkRoute::{Command, Dictation, Request};
    use TalkTarget::{Field, None as Nothing, Terminal};
    let cases = [
        ("Open four Codex threads.", Field, Command),
        ("Pause every active thread", Terminal, Command),
        ("show approvals", Field, Command),
        ("go to settings", Nothing, Command),
        ("settings", Nothing, Command),
        ("settings", Field, Dictation),
        ("pending approvals", Field, Dictation),
        ("fix the parser so it handles empty input", Field, Dictation),
        ("npm test", Terminal, Dictation),
        ("plan the release", Nothing, Request),
        ("don't stop the threads", Field, Dictation),
        ("don't stop the threads", Nothing, Request),
        ("open 40 codex threads", Field, Command),
    ];
    for (text, target, route) in cases {
        assert_eq!(talk_route(text, target), route, "{text} / {target:?}");
    }
}

#[test]
fn talk_dictation_is_never_counted_and_records_only_facts() {
    let h = harness();
    let secret = "the api key is hunter2";
    let r = h
        .orchestrator
        .talk(talk(secret, TalkTarget::Field), &|_| {})
        .expect("talk");
    assert_eq!(r.route, TalkRoute::Dictation);
    assert!(r.response.is_none());
    assert!(r.recognized_ms < 50.0);
    assert_eq!(h.orchestrator.usage().expect("usage").used, 0);
    let events = kalvoice_events(&h.core);
    assert_eq!(types(&events), ["kalvoice.dictation_completed"]);
    assert_eq!(events[0]["payload"]["characters"], secret.len());
    assert!(
        !serde_json::to_string(&events)
            .expect("json")
            .contains("hunter2")
    );
}

#[test]
fn talk_commands_count_and_type_instead_refunds_reversible_ones() {
    let h = harness();
    let r = h
        .orchestrator
        .talk(talk("go to settings", TalkTarget::Field), &|_| {})
        .expect("talk");
    assert_eq!(r.route, TalkRoute::Command);
    let response = r.response.expect("response");
    assert!(response.counted);
    assert_eq!(h.orchestrator.usage().expect("usage").used, 1);
    assert!(
        h.orchestrator
            .type_instead(&response.request_id)
            .expect("undo")
    );
    assert_eq!(h.orchestrator.usage().expect("usage").used, 0);
    assert!(
        !h.orchestrator
            .type_instead(&response.request_id)
            .expect("again")
    );
    let last = kalvoice_events(&h.core).pop().expect("event");
    assert_eq!(last["payload"]["code"], "typed_instead");

    let request = h
        .orchestrator
        .talk(talk("plan the release", TalkTarget::None), &|_| {})
        .expect("talk");
    assert_eq!(request.route, TalkRoute::Request);
    assert!(matches!(
        request.response.expect("response").outcome,
        KalVoiceOutcome::NeedsProvider { .. }
    ));
}

#[test]
fn stages_are_reported_in_order() {
    let h = harness();
    let seen = Mutex::new(Vec::new());
    h.orchestrator
        .handle_with_stages(request("go to settings"), &|s| {
            seen.lock().expect("lock").push(s)
        })
        .expect("handle");
    assert_eq!(
        *seen.lock().expect("lock"),
        [RequestStage::Thinking, RequestStage::Executing]
    );
    let refused = Mutex::new(Vec::new());
    h.orchestrator
        .handle_with_stages(request("plan the release"), &|s| {
            refused.lock().expect("lock").push(s)
        })
        .expect("handle");
    assert_eq!(
        *refused.lock().expect("lock"),
        [RequestStage::Thinking],
        "never executes"
    );
}

#[test]
fn a_retried_request_id_is_neither_counted_nor_run_twice() {
    let h = harness();
    let req = request("go to dashboard");
    h.orchestrator.handle(req.clone()).expect("first");
    let again = h.orchestrator.handle(req).expect("retry");
    assert!(
        matches!(again.outcome, KalVoiceOutcome::Failed { ref code, .. } if code == "duplicate_request")
    );
    assert!(!again.counted);
    assert_eq!(h.orchestrator.usage().expect("usage").used, 1);
    assert_eq!(h.executor.executed.lock().expect("lock").len(), 1);
}

#[test]
fn limit_reached_is_returned_before_any_work() {
    let h = harness();
    h.core
        .read(|c| {
            for _ in 0..250 {
                ledger::consume(
                    c,
                    &new_id(),
                    KalVoiceInput::Text,
                    "navigate",
                    NOW,
                    1,
                    Some(250),
                )?;
            }
            Ok(())
        })
        .expect("fill");
    let response = h
        .orchestrator
        .handle(request("open four codex threads"))
        .expect("handle");
    assert_eq!(
        response.outcome,
        KalVoiceOutcome::LimitReached {
            resets_at: "2026-10-01T00:00:00.000Z".into()
        }
    );
    assert!(!response.counted);
    assert_eq!(response.usage.used, 250);
    assert!(h.executor.executed.lock().expect("lock").is_empty());
    assert!(
        h.gate.modes.lock().expect("lock").is_empty(),
        "not even evaluated"
    );
    assert_eq!(types(&kalvoice_events(&h.core)), ["kalvoice.limit_reached"]);
    assert_eq!(kalvoice_events(&h.core)[0]["payload"]["allowance"], 250);
}

#[test]
fn owner_is_unlimited() {
    let h = harness_with(
        Tier::Owner,
        FakeExecutor::default(),
        PolicyEffect::Allow,
        Arc::new(NoProviders),
    );
    h.core
        .read(|c| {
            for _ in 0..300 {
                ledger::consume(c, &new_id(), KalVoiceInput::Text, "navigate", NOW, 1, None)?;
            }
            Ok(())
        })
        .expect("fill");
    let response = h
        .orchestrator
        .handle(request("go to dashboard"))
        .expect("handle");
    assert!(matches!(
        response.outcome,
        KalVoiceOutcome::Completed { .. }
    ));
    assert_eq!(response.usage.used, 301);
    assert_eq!(response.usage.allowance, None);
}

#[test]
fn reasoning_without_a_provider_asks_to_connect_one_and_is_not_counted() {
    let h = harness();
    let response = h
        .orchestrator
        .handle(request(
            "have claude implement this, codex review it, then run the tests",
        ))
        .expect("handle");
    assert_eq!(
        response.outcome,
        KalVoiceOutcome::NeedsProvider {
            message: "Connect a supported AI provider to use KalVoice reasoning for this request."
                .into()
        }
    );
    assert!(!response.counted);
    assert_eq!(response.usage.used, 0);
    let events = kalvoice_events(&h.core);
    assert_eq!(
        events.last().expect("event")["payload"]["code"],
        "needs_provider"
    );
}

#[test]
fn an_unavailable_selected_provider_is_named() {
    let directory = Arc::new(FakeDirectory {
        providers: vec![ProviderChoice {
            id: ProviderId::new(ProviderId::CODEX),
            display_name: "Codex".into(),
            available: true,
        }],
        provider: None,
    });
    let h = harness_with(
        Tier::Free,
        FakeExecutor::default(),
        PolicyEffect::Allow,
        directory,
    );
    h.orchestrator
        .update_preferences(&KalVoicePreferencesPatch {
            intelligence: Some(IntelligenceChoice::Provider {
                provider_id: ProviderId::new(ProviderId::CLAUDE_CODE),
            }),
            ..Default::default()
        })
        .expect("prefs");
    let response = h
        .orchestrator
        .handle(request("plan the release"))
        .expect("handle");
    assert_eq!(
        response.outcome,
        KalVoiceOutcome::NeedsProvider {
            message: "Claude is currently unavailable. Choose another connected provider or retry."
                .into()
        }
    );
    let types = types(&kalvoice_events(&h.core));
    assert!(types.contains(&"kalvoice.provider_selected".to_owned()));
}

fn reasoning_harness(
    answer: Option<&str>,
) -> (Harness, Arc<Mutex<Vec<SessionConfig>>>, Arc<AtomicUsize>) {
    let configs = Arc::new(Mutex::new(Vec::new()));
    let terminated = Arc::new(AtomicUsize::new(0));
    let provider = Arc::new(FakeProvider {
        answer: answer.map(str::to_owned),
        configs: configs.clone(),
        terminated: terminated.clone(),
    });
    let directory = Arc::new(FakeDirectory {
        providers: vec![ProviderChoice {
            id: ProviderId::new(ProviderId::CLAUDE_CODE),
            display_name: "Claude".into(),
            available: true,
        }],
        provider: Some(provider),
    });
    (
        harness_with(
            Tier::Free,
            FakeExecutor::default(),
            PolicyEffect::Allow,
            directory,
        ),
        configs,
        terminated,
    )
}

#[test]
fn reasoning_runs_read_only_on_the_users_provider() {
    let (h, configs, terminated) = reasoning_harness(Some("Start with the schema, then the API."));
    let response = h
        .orchestrator
        .handle(request("plan the postgres migration"))
        .expect("handle");
    assert_eq!(
        response.outcome,
        KalVoiceOutcome::Completed {
            summary: "Start with the schema, then the API.".into()
        }
    );
    assert!(response.counted);
    assert_eq!(response.usage.used, 1);
    assert_eq!(
        configs.lock().expect("lock")[0].permission_mode,
        PermissionMode::Plan
    );
    assert_eq!(terminated.load(Ordering::SeqCst), 1, "session ended");
    let events = kalvoice_events(&h.core);
    let json = serde_json::to_string(&events).expect("json");
    assert!(!json.contains("postgres"), "request text never in events");
    assert!(!json.contains("schema"), "answers never in events");
    assert_eq!(
        events.last().expect("event")["correlation"]["providerId"],
        "claude-code"
    );
}

#[test]
fn reasoning_times_out_honestly() {
    let (h, _, terminated) = reasoning_harness(None);
    let response = h
        .orchestrator
        .handle(request("plan the release"))
        .expect("handle");
    assert!(
        matches!(response.outcome, KalVoiceOutcome::Failed { ref code, .. } if code == "provider_timeout")
    );
    assert_eq!(terminated.load(Ordering::SeqCst), 1);
}

#[test]
fn consequential_commands_wait_for_approval_then_run() {
    let h = harness_with(
        Tier::Free,
        FakeExecutor::default(),
        PolicyEffect::Ask,
        Arc::new(NoProviders),
    );
    let response = h
        .orchestrator
        .handle(request("stop all threads"))
        .expect("handle");
    let KalVoiceOutcome::PermissionRequired {
        approval_request_id,
    } = response.outcome
    else {
        panic!("{:?}", response.outcome);
    };
    assert!(response.counted);
    assert!(
        h.executor.executed.lock().expect("lock").is_empty(),
        "nothing runs before approval"
    );
    assert_eq!(h.gate.opened.load(Ordering::SeqCst), 1);

    let done = h
        .orchestrator
        .resolve_approval(&approval_request_id, Some(ApprovalDecision::ApproveOnce))
        .expect("pending");
    assert!(matches!(done.outcome, KalVoiceOutcome::Completed { .. }));
    assert_eq!(
        *h.executor.executed.lock().expect("lock"),
        vec![KalVoiceIntent::StopThreads {
            scope: ThreadScope::All
        }]
    );
    assert_eq!(
        h.orchestrator.usage().expect("usage").used,
        1,
        "approval doesn't count again"
    );
    assert!(
        h.orchestrator
            .resolve_approval(&approval_request_id, None)
            .is_none(),
        "resolved once"
    );
}

#[test]
fn denied_approvals_never_run() {
    let h = harness_with(
        Tier::Free,
        FakeExecutor::default(),
        PolicyEffect::Ask,
        Arc::new(NoProviders),
    );
    let response = h
        .orchestrator
        .handle(request("open four codex threads"))
        .expect("handle");
    let KalVoiceOutcome::PermissionRequired {
        approval_request_id,
    } = response.outcome
    else {
        panic!("{:?}", response.outcome);
    };
    let done = h
        .orchestrator
        .resolve_approval(&approval_request_id, Some(ApprovalDecision::Deny))
        .expect("pending");
    assert!(
        matches!(done.outcome, KalVoiceOutcome::Failed { ref code, .. } if code == "permission_denied")
    );
    assert!(h.executor.executed.lock().expect("lock").is_empty());
}

#[test]
fn policy_denial_is_not_counted_and_kalvoice_only_uses_approve_mode() {
    let h = harness_with(
        Tier::Free,
        FakeExecutor::default(),
        PolicyEffect::Deny,
        Arc::new(NoProviders),
    );
    for text in [
        "stop all threads",
        "pause every active thread",
        "open 2 claude threads in kalcode",
    ] {
        let response = h.orchestrator.handle(request(text)).expect("handle");
        assert!(
            matches!(response.outcome, KalVoiceOutcome::Failed { ref code, .. } if code == "permission_denied")
        );
        assert!(!response.counted);
    }
    assert!(h.executor.executed.lock().expect("lock").is_empty());
    let modes = h.gate.modes.lock().expect("lock").clone();
    assert_eq!(modes.len(), 3);
    assert!(modes.iter().all(|m| *m == PermissionMode::Approve));
}

#[test]
fn non_consequential_commands_skip_the_gate() {
    let h = harness_with(
        Tier::Free,
        FakeExecutor::default(),
        PolicyEffect::Deny,
        Arc::new(NoProviders),
    );
    for text in [
        "go to settings",
        "what needs permission",
        "what are my threads doing",
        "new terminal",
    ] {
        let response = h.orchestrator.handle(request(text)).expect("handle");
        assert!(
            matches!(response.outcome, KalVoiceOutcome::Completed { .. }),
            "{text}"
        );
    }
    assert!(h.gate.modes.lock().expect("lock").is_empty());
}

#[test]
fn named_targets_resolve_or_fail_uncounted() {
    let h = harness();
    let response = h
        .orchestrator
        .handle(request("open 2 claude threads in kalcode"))
        .expect("handle");
    assert!(matches!(
        response.outcome,
        KalVoiceOutcome::Completed { .. }
    ));
    assert_eq!(
        h.executor.executed.lock().expect("lock")[0],
        KalVoiceIntent::CreateThreads {
            provider_id: ProviderId::new(ProviderId::CLAUDE_CODE),
            count: 2,
            workspace_id: Some("0192f3c4-0000-7000-8000-00000000000a".into())
        }
    );
    let missing = h
        .orchestrator
        .handle(request("stop all threads in atlantis"))
        .expect("handle");
    assert_eq!(
        missing.outcome,
        KalVoiceOutcome::Failed {
            code: "workspace_not_found".into(),
            message: "KalCode has no workspace named \u{201c}atlantis\u{201d}.".into()
        }
    );
    assert!(!missing.counted);
    let thread = h
        .orchestrator
        .handle(request("pause thread login fix"))
        .expect("handle");
    assert!(matches!(thread.outcome, KalVoiceOutcome::Completed { .. }));
}

#[test]
fn rejected_and_unavailable_commands_are_not_counted() {
    let h = harness_with(
        Tier::Free,
        FakeExecutor {
            unavailable: true,
            ..Default::default()
        },
        PolicyEffect::Allow,
        Arc::new(NoProviders),
    );
    let too_many = h
        .orchestrator
        .handle(request("open 40 codex threads"))
        .expect("handle");
    assert!(
        matches!(too_many.outcome, KalVoiceOutcome::Failed { ref code, .. } if code == "thread_count_too_large")
    );
    let unavailable = h
        .orchestrator
        .handle(request("stop all threads"))
        .expect("handle");
    assert_eq!(
        unavailable.outcome,
        KalVoiceOutcome::Failed {
            code: "threads_unavailable".into(),
            message: "Threads aren't available in this build yet.".into()
        }
    );
    assert_eq!(h.orchestrator.usage().expect("usage").used, 0);
}

#[test]
fn invalid_requests_are_refused() {
    let h = harness();
    let mut bad = request("go to settings");
    bad.request_id = "not-a-uuid".into();
    assert_eq!(
        h.orchestrator.handle(bad).expect_err("id").code,
        "invalid_request_id"
    );
    let long = request(&"a".repeat(MAX_REQUEST_CHARS + 1));
    assert_eq!(
        h.orchestrator.handle(long).expect_err("long").code,
        "request_too_long"
    );
    let mut ws = request("go to settings");
    ws.workspace_id = Some("../x".into());
    assert_eq!(
        h.orchestrator.handle(ws).expect_err("ws").code,
        "invalid_workspace"
    );
    let empty = h.orchestrator.handle(request("   ")).expect("empty");
    assert!(
        matches!(empty.outcome, KalVoiceOutcome::Failed { ref code, .. } if code == "empty_request")
    );
}

#[test]
fn voice_output_events_carry_ids_only() {
    let h = harness();
    h.orchestrator
        .record_voice_output("0192f3c4-0000-7000-8000-00000000000c", true);
    h.orchestrator
        .record_voice_output("0192f3c4-0000-7000-8000-00000000000c", false);
    assert_eq!(
        types(&kalvoice_events(&h.core)),
        [
            "kalvoice.voice_output_started",
            "kalvoice.voice_output_completed"
        ]
    );
}
