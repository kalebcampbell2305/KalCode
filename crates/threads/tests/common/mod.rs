//! Test doubles for the thread runtime's integration seams: a scriptable fake provider that
//! implements the shared `AgentProvider` / `AgentSession` contract, a recording permission
//! gate, and an in-memory workspace resolver. Test-only; never shipped.

#![allow(
    dead_code,
    clippy::expect_used,
    clippy::unwrap_used,
    clippy::large_enum_variant
)]

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use kalcode_contracts::agent::{
    AgentEvent, AgentEventSink, AgentInput, AgentProvider, AgentSession, AuthState, DetectionState,
    ModelInfo, ProviderCapabilities, ProviderDetection, ProviderError, ProviderId, SessionConfig,
};
use kalcode_contracts::events::{EventPayload, NewEvent};
use kalcode_contracts::ids::new_id;
use kalcode_contracts::permissions::{
    ActionKind, ApprovalDecision, ApprovalRequest, ApprovalStatus, NormalizedAction,
    PermissionGate, PermissionMode, PolicyDecision, PolicyEffect,
};
use kalcode_core::flags::BuildChannel;
use kalcode_core::{Core, CoreConfig, KalError, Paths};
use kalcode_threads::{
    CreateThread, ProviderRegistry, ResolvedWorkspace, ThreadRuntime, WorkspaceResolver,
};

// ---------------------------------------------------------------- fake provider

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Call {
    Send(String),
    Interrupt,
    Terminate,
    Respond(String, ApprovalDecision),
}

/// A step of a scripted turn, run on a background thread after each `send`.
#[derive(Debug, Clone)]
pub enum Step {
    Emit(AgentEvent),
    Sleep(u64),
}

type Script = Arc<dyn Fn(&str) -> Vec<Step> + Send + Sync>;
type ExpireObserver = Arc<dyn Fn(&str) + Send + Sync>;

pub struct FakeSession {
    pub config: SessionConfig,
    sink: Box<dyn AgentEventSink>,
    pub calls: Mutex<Vec<Call>>,
    script: Option<Script>,
    interrupted: AtomicBool,
    ended: AtomicBool,
    fail_send: AtomicBool,
    terminate_failures: AtomicUsize,
    interrupt_supported: bool,
}

impl FakeSession {
    /// Pushes an event exactly as a provider adapter would.
    pub fn emit(&self, event: AgentEvent) {
        self.sink.emit(event);
    }

    pub fn calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }

    pub fn fail_next_sends(&self) {
        self.fail_send.store(true, Ordering::SeqCst);
    }

    pub fn fail_next_terminate(&self) {
        self.terminate_failures.store(1, Ordering::SeqCst);
    }

    pub fn is_ended(&self) -> bool {
        self.ended.load(Ordering::SeqCst)
    }

    /// Simulates the provider process dying.
    pub fn crash(&self, exit_code: Option<i32>) {
        self.ended.store(true, Ordering::SeqCst);
        self.emit(AgentEvent::Exited { exit_code });
    }
}

struct SessionHandle(Arc<FakeSession>);

impl AgentSession for SessionHandle {
    fn provider_session_id(&self) -> Option<String> {
        Some(format!("fake-session-{}", self.0.config.thread_id))
    }

    fn send(&self, input: AgentInput) -> Result<(), ProviderError> {
        let AgentInput::Text { text } = input;
        if self.0.ended.load(Ordering::SeqCst) {
            return Err(ProviderError::SessionEnded);
        }
        if self.0.fail_send.load(Ordering::SeqCst) {
            return Err(ProviderError::Io("pipe closed".into()));
        }
        self.0.calls.lock().unwrap().push(Call::Send(text.clone()));
        if let Some(script) = &self.0.script {
            self.0.interrupted.store(false, Ordering::SeqCst);
            let steps = script(&text);
            let session = self.0.clone();
            std::thread::spawn(move || {
                for step in steps {
                    if session.interrupted.load(Ordering::SeqCst)
                        || session.ended.load(Ordering::SeqCst)
                    {
                        return;
                    }
                    match step {
                        Step::Emit(event) => session.emit(event),
                        Step::Sleep(ms) => std::thread::sleep(Duration::from_millis(ms)),
                    }
                }
            });
        }
        Ok(())
    }

    fn interrupt(&self) -> Result<(), ProviderError> {
        if !self.0.interrupt_supported {
            return Err(ProviderError::Unsupported);
        }
        self.0.calls.lock().unwrap().push(Call::Interrupt);
        self.0.interrupted.store(true, Ordering::SeqCst);
        self.0.emit(AgentEvent::TurnCompleted { ok: false });
        Ok(())
    }

    fn terminate(&self) -> Result<(), ProviderError> {
        self.0.calls.lock().unwrap().push(Call::Terminate);
        if self
            .0
            .terminate_failures
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |remaining| {
                remaining.checked_sub(1)
            })
            .is_ok()
        {
            return Err(ProviderError::Io("simulated termination failure".into()));
        }
        if !self.0.ended.swap(true, Ordering::SeqCst) {
            // A real adapter reports the process exit after killing the tree.
            self.0.emit(AgentEvent::Exited { exit_code: None });
        }
        Ok(())
    }

    fn respond_to_approval(
        &self,
        request_id: &str,
        decision: ApprovalDecision,
    ) -> Result<(), ProviderError> {
        self.0
            .calls
            .lock()
            .unwrap()
            .push(Call::Respond(request_id.to_owned(), decision));
        Ok(())
    }
}

pub struct FakeProvider {
    id: String,
    name: String,
    pub resume: bool,
    pub interrupt: bool,
    models: Vec<ModelInfo>,
    script: Mutex<Option<Script>>,
    start_error: Mutex<Option<ProviderError>>,
    pub sessions: Mutex<Vec<Arc<FakeSession>>>,
}

impl FakeProvider {
    pub fn new(id: &str, name: &str) -> Arc<Self> {
        Arc::new(Self {
            id: id.into(),
            name: name.into(),
            resume: true,
            interrupt: true,
            models: vec![
                ModelInfo {
                    id: "fake-large".into(),
                    display_name: "Fake Large".into(),
                    is_default: true,
                },
                ModelInfo {
                    id: "fake-small".into(),
                    display_name: "Fake Small".into(),
                    is_default: false,
                },
            ],
            script: Mutex::new(None),
            start_error: Mutex::new(None),
            sessions: Mutex::new(Vec::new()),
        })
    }

    pub fn configured(id: &str, name: &str, resume: bool, interrupt: bool) -> Arc<Self> {
        let mut provider = Arc::into_inner(Self::new(id, name)).expect("fresh");
        provider.resume = resume;
        provider.interrupt = interrupt;
        Arc::new(provider)
    }

    pub fn set_script(&self, script: impl Fn(&str) -> Vec<Step> + Send + Sync + 'static) {
        *self.script.lock().unwrap() = Some(Arc::new(script));
    }

    pub fn fail_next_start(&self, error: ProviderError) {
        *self.start_error.lock().unwrap() = Some(error);
    }

    pub fn session(&self, index: usize) -> Arc<FakeSession> {
        self.sessions.lock().unwrap()[index].clone()
    }

    pub fn last_session(&self) -> Arc<FakeSession> {
        self.sessions
            .lock()
            .unwrap()
            .last()
            .expect("a session")
            .clone()
    }

    pub fn session_count(&self) -> usize {
        self.sessions.lock().unwrap().len()
    }
}

impl AgentProvider for FakeProvider {
    fn id(&self) -> ProviderId {
        ProviderId::new(self.id.clone())
    }

    fn display_name(&self) -> &str {
        &self.name
    }

    fn detect(&self) -> ProviderDetection {
        ProviderDetection {
            provider_id: self.id(),
            display_name: self.name.clone(),
            state: DetectionState::Installed,
            display_path: None,
            version: Some("1.0.0".into()),
            minimum_version: None,
            auth: AuthState::Authenticated,
            message: None,
            checked_at: String::new(),
        }
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            streaming: true,
            interrupt: self.interrupt,
            resume: self.resume,
            host_approvals: true,
            models: self.models.clone(),
            permission_mappings: Vec::new(),
            interactive: None,
        }
    }

    fn start_session(
        &self,
        config: SessionConfig,
        sink: Box<dyn AgentEventSink>,
    ) -> Result<Box<dyn AgentSession>, ProviderError> {
        if let Some(error) = self.start_error.lock().unwrap().take() {
            return Err(error);
        }
        let session = Arc::new(FakeSession {
            config,
            sink,
            calls: Mutex::new(Vec::new()),
            script: self.script.lock().unwrap().clone(),
            interrupted: AtomicBool::new(false),
            ended: AtomicBool::new(false),
            fail_send: AtomicBool::new(false),
            terminate_failures: AtomicUsize::new(0),
            interrupt_supported: self.interrupt,
        });
        self.sessions.lock().unwrap().push(session.clone());
        Ok(Box::new(SessionHandle(session)))
    }
}

// ---------------------------------------------------------------- gate

/// A permission gate whose verdict the test chooses. Records what it was asked.
pub struct TestGate {
    pub effect: Mutex<PolicyEffect>,
    pub evaluated: Mutex<Vec<(NormalizedAction, PermissionMode)>>,
    pub opened: Mutex<Vec<ApprovalRequest>>,
    pub expired: Mutex<Vec<String>>,
    pub fail_open: AtomicBool,
    expire_observer: Mutex<Option<ExpireObserver>>,
    /// Id the next opened request gets (to simulate decisions that race registration).
    pub next_request_id: Mutex<Option<String>>,
}

impl TestGate {
    pub fn new(effect: PolicyEffect) -> Arc<Self> {
        Arc::new(Self {
            effect: Mutex::new(effect),
            evaluated: Mutex::new(Vec::new()),
            opened: Mutex::new(Vec::new()),
            expired: Mutex::new(Vec::new()),
            fail_open: AtomicBool::new(false),
            expire_observer: Mutex::new(None),
            next_request_id: Mutex::new(None),
        })
    }

    pub fn set(&self, effect: PolicyEffect) {
        *self.effect.lock().unwrap() = effect;
    }

    pub fn opened(&self) -> Vec<ApprovalRequest> {
        self.opened.lock().unwrap().clone()
    }

    pub fn expired(&self) -> Vec<String> {
        self.expired.lock().unwrap().clone()
    }

    pub fn set_expire_observer(&self, observer: Arc<dyn Fn(&str) + Send + Sync>) {
        *self.expire_observer.lock().unwrap() = Some(observer);
    }
}

impl PermissionGate for TestGate {
    fn evaluate(&self, action: &NormalizedAction, mode: PermissionMode) -> PolicyDecision {
        self.evaluated.lock().unwrap().push((action.clone(), mode));
        PolicyDecision {
            effect: *self.effect.lock().unwrap(),
            scopes: Vec::new(),
            reason: "test".into(),
            approvable: true,
        }
    }

    fn open_request(
        &self,
        action: NormalizedAction,
        mode: PermissionMode,
        decision: PolicyDecision,
    ) -> Result<ApprovalRequest, String> {
        if self.fail_open.load(Ordering::SeqCst) {
            return Err("approval store unavailable".into());
        }
        let request = ApprovalRequest {
            id: self
                .next_request_id
                .lock()
                .unwrap()
                .take()
                .unwrap_or_else(new_id),
            action,
            decision,
            permission_mode: mode,
            status: ApprovalStatus::Pending,
            resolved_decision: None,
            resolved_at: None,
            allowed_decisions: Vec::new(),
            grant_coverage: String::new(),
            context: None,
            created_at: String::new(),
            expire_reason: None,
        };
        self.opened.lock().unwrap().push(request.clone());
        Ok(request)
    }

    fn expire_for_thread(&self, thread_id: &str) {
        let observer = self.expire_observer.lock().unwrap().take();
        if let Some(observer) = observer {
            observer(thread_id);
        }
        self.expired.lock().unwrap().push(thread_id.to_owned());
    }
}

// ---------------------------------------------------------------- workspaces

pub struct FakeWorkspaces {
    pub workspaces: Mutex<Vec<ResolvedWorkspace>>,
}

impl FakeWorkspaces {
    pub fn with(root: PathBuf) -> (Arc<Self>, String) {
        let id = new_id();
        let workspaces = Arc::new(Self {
            workspaces: Mutex::new(vec![ResolvedWorkspace {
                id: id.clone(),
                name: "kalcode".into(),
                root,
            }]),
        });
        (workspaces, id)
    }

    pub fn remove_all(&self) {
        self.workspaces.lock().unwrap().clear();
    }
}

impl WorkspaceResolver for FakeWorkspaces {
    fn list(&self) -> kalcode_core::Result<Vec<ResolvedWorkspace>> {
        Ok(self.workspaces.lock().unwrap().clone())
    }

    fn resolve(&self, workspace_id: &str) -> kalcode_core::Result<ResolvedWorkspace> {
        self.workspaces
            .lock()
            .unwrap()
            .iter()
            .find(|w| w.id == workspace_id)
            .cloned()
            .ok_or_else(kalcode_threads::registry::workspace_not_found)
    }
}

// ---------------------------------------------------------------- harness

pub struct Harness {
    pub dir: tempfile::TempDir,
    pub core: Arc<Core>,
    pub registry: Arc<ProviderRegistry>,
    pub workspaces: Arc<FakeWorkspaces>,
    pub workspace_id: String,
    pub gate: Arc<TestGate>,
    pub provider: Arc<FakeProvider>,
    pub runtime: ThreadRuntime,
}

pub fn config(dir: &std::path::Path) -> CoreConfig {
    CoreConfig {
        paths: Paths::new(dir),
        app_version: "0.1.0-test".into(),
        channel: BuildChannel::Development,
    }
}

impl Harness {
    pub fn new() -> Self {
        Self::with_gate(TestGate::new(PolicyEffect::Ask))
    }

    pub fn with_gate(gate: Arc<TestGate>) -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let core = Arc::new(Core::open(config(dir.path())).expect("core"));
        let registry = Arc::new(ProviderRegistry::new());
        let provider = FakeProvider::new("fake", "Fake Provider");
        registry.register(provider.clone());
        let root = dir.path().join("repo");
        std::fs::create_dir_all(&root).expect("repo");
        let (workspaces, workspace_id) = FakeWorkspaces::with(root);
        let runtime = ThreadRuntime::new(
            core.clone(),
            registry.clone(),
            workspaces.clone(),
            gate.clone(),
        )
        .expect("runtime");
        Self {
            dir,
            core,
            registry,
            workspaces,
            workspace_id,
            gate,
            provider,
            runtime,
        }
    }

    pub fn request(&self, prompt: &str) -> CreateThread {
        CreateThread {
            provider_id: "fake".into(),
            provider_account_id: None,
            account_label: None,
            workspace_id: self.workspace_id.clone(),
            model: None,
            permission_mode: PermissionMode::Approve,
            prompt: prompt.into(),
            name: None,
        }
    }

    pub fn event_types(&self) -> Vec<String> {
        let mut events = self.core.recent_events(500, None).expect("events");
        events.reverse();
        events
            .iter()
            .map(|e| e.event.type_name().to_owned())
            .collect()
    }

    pub fn events_for(&self, thread_id: &str) -> Vec<kalcode_core::events::EventEnvelope> {
        let mut events = self.core.recent_events(500, None).expect("events");
        events.reverse();
        events
            .into_iter()
            .filter(|e| e.correlation.thread_id.as_deref() == Some(thread_id))
            .collect()
    }

    /// Simulates the permission engine (Z4) publishing a decision.
    pub fn decide(&self, request_id: &str, thread_id: &str, decision: Option<ApprovalDecision>) {
        let event = match decision {
            Some(ApprovalDecision::Deny) | None => EventPayload::ApprovalDenied {
                request_id: request_id.into(),
                thread_id: thread_id.into(),
            },
            Some(decision) => EventPayload::ApprovalApproved {
                request_id: request_id.into(),
                thread_id: thread_id.into(),
                decision,
            },
        };
        self.core
            .emit(NewEvent::core(event))
            .expect("emit decision");
    }

    pub fn expire(&self, request_id: &str, thread_id: &str) {
        self.core
            .emit(NewEvent::core(EventPayload::ApprovalExpired {
                request_id: request_id.into(),
                thread_id: thread_id.into(),
            }))
            .expect("emit expiry");
    }
}

/// Polls `condition` until it holds (events are applied on worker threads).
pub fn wait_until(what: &str, condition: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if condition() {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("timed out waiting for {what}");
}

pub fn command_action(command: &str) -> NormalizedAction {
    NormalizedAction {
        id: String::new(),
        // Deliberately wrong identity: the runtime must overwrite it.
        thread_id: "spoofed".into(),
        workspace_id: "spoofed".into(),
        provider_id: ProviderId::new("spoofed"),
        action: ActionKind::Command {
            command: command.into(),
            argv: command.split(' ').map(str::to_owned).collect(),
            cwd: String::new(),
        },
        summary: format!("Run {command}"),
        requested_at: String::new(),
        origin: None,
    }
}

pub fn assert_code<T: std::fmt::Debug>(result: kalcode_core::Result<T>, code: &str) {
    match result {
        Ok(value) => panic!("expected error {code}, got {value:?}"),
        Err(KalError { code: actual, .. }) => assert_eq!(actual, code),
    }
}
