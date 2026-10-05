//! Test doubles for the thread runtime's integration seams: a scriptable fake provider that
//! implements the shared `AgentProvider` / `AgentSession` contract, a recording permission
//! gate, and an in-memory workspace resolver. Test-only; never shipped.

#![allow(
    dead_code,
    clippy::expect_used,
    clippy::unwrap_used,
    clippy::large_enum_variant
)]

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use kalcode_contracts::agent::{
    AgentEvent, AgentEventSink, AgentInput, AgentProvider, AgentSession, AuthState, DetectionState,
    LaunchOrigin, ModelInfo, ProviderCapabilities, ProviderDetection, ProviderError, ProviderId,
    SessionConfig,
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
type StartObserver = Arc<dyn Fn() + Send + Sync>;

pub struct FakeSession {
    pub config: SessionConfig,
    sink: Box<dyn AgentEventSink>,
    pub calls: Mutex<Vec<Call>>,
    script: Option<Script>,
    interrupted: AtomicBool,
    ended: AtomicBool,
    fail_send: AtomicBool,
    /// Errors the next sends return, in order (for example Resource Governor holds).
    send_errors: Mutex<VecDeque<ProviderError>>,
    terminate_failures: AtomicUsize,
    native_input_used: AtomicBool,
    reconfigure_reserved: AtomicBool,
    interrupt_supported: bool,
    /// Set when the runtime drops its handle: a real adapter releases the account's shared
    /// profile lease at that point.
    released: AtomicBool,
    /// Who asks for the next turns, as the resource admission wrapper sees it.
    origin: Mutex<LaunchOrigin>,
}

impl FakeSession {
    /// Pushes an event exactly as a provider adapter would.
    pub fn emit(&self, event: AgentEvent) {
        self.sink.emit(event);
    }

    pub fn calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }

    /// Who asks for this session's next turn: its launch origin, or the latest update.
    pub fn launch_origin(&self) -> LaunchOrigin {
        *self.origin.lock().unwrap()
    }

    pub fn fail_next_sends(&self) {
        self.fail_send.store(true, Ordering::SeqCst);
    }

    /// The next `count` sends return `error` before anything is delivered.
    pub fn fail_sends_with(&self, count: usize, error: ProviderError) {
        let mut errors = self.send_errors.lock().unwrap();
        errors.extend(std::iter::repeat_n(error, count));
    }

    /// Admits every held send from now on.
    pub fn admit_sends(&self) {
        self.send_errors.lock().unwrap().clear();
    }

    pub fn fail_next_terminate(&self) {
        self.terminate_failures.store(1, Ordering::SeqCst);
    }

    /// Simulates text typed directly into an interactive provider pane without Enter. Runtime
    /// history and status remain untouched, as in the real PTY path.
    pub fn type_native_draft(&self) {
        self.native_input_used.store(true, Ordering::SeqCst);
    }

    pub fn is_ended(&self) -> bool {
        self.ended.load(Ordering::SeqCst)
    }

    /// The runtime no longer holds this session (its profile lease would be released).
    pub fn is_released(&self) -> bool {
        self.released.load(Ordering::SeqCst)
    }

    /// Simulates the provider process dying.
    pub fn crash(&self, exit_code: Option<i32>) {
        self.ended.store(true, Ordering::SeqCst);
        self.emit(AgentEvent::Exited { exit_code });
    }
}

struct SessionHandle(Arc<FakeSession>);

impl Drop for SessionHandle {
    fn drop(&mut self) {
        self.0.released.store(true, Ordering::SeqCst);
    }
}

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
        if let Some(error) = self.0.send_errors.lock().unwrap().pop_front() {
            return Err(error);
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

    fn set_launch_origin(&self, origin: LaunchOrigin) {
        *self.0.origin.lock().unwrap() = origin;
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
        let mut remaining = self.0.terminate_failures.load(Ordering::SeqCst);
        while remaining > 0 {
            match self.0.terminate_failures.compare_exchange(
                remaining,
                remaining - 1,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => {
                    return Err(ProviderError::Io("simulated termination failure".into()));
                }
                Err(current) => remaining = current,
            }
        }
        if !self.0.ended.swap(true, Ordering::SeqCst) {
            // A real adapter reports the process exit after killing the tree.
            self.0.emit(AgentEvent::Exited { exit_code: None });
        }
        Ok(())
    }

    fn reserve_if_unused(&self) -> Result<bool, ProviderError> {
        if self.0.native_input_used.load(Ordering::SeqCst)
            || self
                .0
                .calls
                .lock()
                .unwrap()
                .iter()
                .any(|call| matches!(call, Call::Send(_)))
        {
            return Ok(false);
        }
        Ok(self
            .0
            .reconfigure_reserved
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok())
    }

    fn cancel_unused_reservation(&self) {
        self.0.reconfigure_reserved.store(false, Ordering::SeqCst);
    }

    fn terminate_reserved(&self) -> Result<(), ProviderError> {
        if !self.0.reconfigure_reserved.swap(false, Ordering::SeqCst) {
            return Err(ProviderError::SessionEnded);
        }
        self.terminate()
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
    start_error: Mutex<VecDeque<ProviderError>>,
    start_observer: Mutex<Option<StartObserver>>,
    pub sessions: Mutex<Vec<Arc<FakeSession>>>,
}

impl FakeProvider {
    pub fn new(id: &str, name: &str) -> Arc<Self> {
        Self::with_models(
            id,
            name,
            vec![
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
        )
    }

    pub fn with_models(id: &str, name: &str, models: Vec<ModelInfo>) -> Arc<Self> {
        Arc::new(Self {
            id: id.into(),
            name: name.into(),
            resume: true,
            interrupt: true,
            models,
            script: Mutex::new(None),
            start_error: Mutex::new(VecDeque::new()),
            start_observer: Mutex::new(None),
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
        self.start_error.lock().unwrap().push_back(error);
    }

    pub fn set_start_observer(&self, observer: impl Fn() + Send + Sync + 'static) {
        *self.start_observer.lock().unwrap() = Some(Arc::new(observer));
    }

    /// The next `count` starts return `error` (for example a Resource Governor hold).
    pub fn fail_starts_with(&self, count: usize, error: ProviderError) {
        self.start_error
            .lock()
            .unwrap()
            .extend(std::iter::repeat_n(error, count));
    }

    /// Admits every held start from now on.
    pub fn admit_starts(&self) {
        self.start_error.lock().unwrap().clear();
    }

    /// Start attempts refused so far are not recorded; this counts started sessions only.
    pub fn started_sessions(&self) -> usize {
        self.session_count()
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
            tools: Vec::new(),
        }
    }

    fn start_session(
        &self,
        config: SessionConfig,
        sink: Box<dyn AgentEventSink>,
    ) -> Result<Box<dyn AgentSession>, ProviderError> {
        let observer = self.start_observer.lock().unwrap().clone();
        if let Some(observer) = observer {
            observer();
        }
        if let Some(error) = self.start_error.lock().unwrap().pop_front() {
            return Err(error);
        }
        let origin = Mutex::new(config.launch_origin);
        let session = Arc::new(FakeSession {
            config,
            sink,
            calls: Mutex::new(Vec::new()),
            script: self.script.lock().unwrap().clone(),
            interrupted: AtomicBool::new(false),
            ended: AtomicBool::new(false),
            fail_send: AtomicBool::new(false),
            send_errors: Mutex::new(VecDeque::new()),
            terminate_failures: AtomicUsize::new(0),
            native_input_used: AtomicBool::new(false),
            reconfigure_reserved: AtomicBool::new(false),
            interrupt_supported: self.interrupt,
            released: AtomicBool::new(false),
            origin,
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
    /// Runs once on the next `resolve` (to interleave a concurrent change mid-operation).
    resolve_observer: Mutex<Option<Box<dyn FnOnce() + Send>>>,
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
            resolve_observer: Mutex::new(None),
        });
        (workspaces, id)
    }

    pub fn on_next_resolve(&self, observer: impl FnOnce() + Send + 'static) {
        *self.resolve_observer.lock().unwrap() = Some(Box::new(observer));
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
        let observer = self.resolve_observer.lock().unwrap().take();
        if let Some(observer) = observer {
            observer();
        }
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
            effort: None,
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
