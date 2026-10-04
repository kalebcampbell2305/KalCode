//! Provider panes through the whole stack: the Z3 thread runtime, the Z4 permission engine and
//! the approval queue, with the fake provider in a real PTY and the real hook bridge. Covers the
//! approval round trip (hook → approval → the person's decision → provider), the hand-over to
//! the provider's own prompt (`answered_in_provider`), and headless/interactive threads side by
//! side in one runtime and one status model. No AI quota is used.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::collections::HashSet;
use std::ffi::OsString;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};

use kalcode_contracts::agent::{
    AgentEventSink, AgentProvider, AgentSession, ProviderCapabilities, ProviderDetection,
    ProviderError, ProviderId, SessionConfig,
};
use kalcode_contracts::permissions::{
    ApprovalDecision, ApprovalStatus, PermissionGate, PermissionMode,
};
use kalcode_contracts::resources::{LaunchHold, LaunchHoldKind};
use kalcode_contracts::threads::{ThreadStatus, ThreadSummary};
use kalcode_core::flags::BuildChannel;
use kalcode_core::{Core, CoreConfig, KalError, Paths};
use kalcode_hook_bridge::Endpoint;
use kalcode_hook_bridge::server::{BridgeServer, ServerConfig};
use kalcode_permissions::{Actor, CoreWorkspaceRoots, PermissionService, ThreadModeStore};
use kalcode_providers::interactive::provider::{
    InteractiveClaudeProvider, InteractiveConfig, PaneRegistry, RuntimeRouter, marked_interactive,
};
use kalcode_providers::interactive::session::SessionLimits;
use kalcode_providers::interactive::{ApprovalExpiry, DecisionRouting, TitleSink};
use kalcode_providers::{ClaudeCodeProvider, DetectEnv};
use kalcode_threads::{
    CoreWorkspaces, CreateIdleThread, CreateThread, ProviderRegistry, ThreadRuntime, naming,
};

const FAKE: &str = env!("CARGO_BIN_EXE_kalcode-fake-provider");
const WAIT: Duration = Duration::from_secs(30);

/// Captured pane output by thread id.
type Outputs = Mutex<Vec<(String, Arc<Mutex<Vec<u8>>>)>>;

#[derive(Default)]
struct Modes(OnceLock<Weak<ThreadRuntime>>);

impl Modes {
    fn runtime(&self) -> kalcode_core::Result<Arc<ThreadRuntime>> {
        self.0
            .get()
            .and_then(Weak::upgrade)
            .ok_or_else(|| KalError::internal("threads_unavailable", "gone"))
    }
}

impl ThreadModeStore for Modes {
    fn thread(&self, thread_id: &str) -> kalcode_core::Result<Option<ThreadSummary>> {
        match self.runtime()?.get(thread_id) {
            Ok(t) => Ok(Some(t)),
            Err(e) if e.code == "thread_not_found" => Ok(None),
            Err(e) => Err(e),
        }
    }

    fn set_mode(
        &self,
        thread_id: &str,
        mode: PermissionMode,
        profile_id: Option<&str>,
    ) -> kalcode_core::Result<ThreadSummary> {
        self.runtime()?
            .set_permission_mode(thread_id, mode, profile_id)
    }
}

/// The desktop's glue, as tests see it: expiry through the engine, titles through the runtime.
struct Glue {
    service: OnceLock<Weak<PermissionService>>,
    modes: Arc<Modes>,
}

impl ApprovalExpiry for Glue {
    fn answered_in_provider(&self, thread_id: &str, action_id: &str) {
        if let Some(service) = self.service.get().and_then(Weak::upgrade) {
            service
                .expire_answered_in_provider(thread_id, action_id)
                .expect("expire");
        }
    }
}

impl TitleSink for Glue {
    fn first_prompt(&self, thread_id: &str, prompt: &str) {
        let Ok(runtime) = self.modes.runtime() else {
            return;
        };
        if runtime
            .get(thread_id)
            .is_ok_and(|t| naming::is_placeholder(&t.name))
        {
            let _ = runtime.rename(thread_id, &naming::name_from_prompt(prompt));
        }
    }
}

struct Stack {
    _dir: tempfile::TempDir,
    runtime: Arc<ThreadRuntime>,
    service: Arc<PermissionService>,
    panes: Arc<PaneRegistry>,
    workspace_id: String,
    output: Outputs,
}

/// Models the desktop admission wrapper: a held launch does not call the inner provider.
struct HeldProvider {
    inner: Arc<dyn AgentProvider>,
    admitted: Arc<AtomicBool>,
}

impl AgentProvider for HeldProvider {
    fn id(&self) -> ProviderId {
        self.inner.id()
    }

    fn display_name(&self) -> &str {
        self.inner.display_name()
    }

    fn detect(&self) -> ProviderDetection {
        self.inner.detect()
    }

    fn capabilities(&self) -> ProviderCapabilities {
        self.inner.capabilities()
    }

    fn start_session(
        &self,
        config: SessionConfig,
        sink: Box<dyn AgentEventSink>,
    ) -> Result<Box<dyn AgentSession>, ProviderError> {
        if !self.admitted.load(Ordering::SeqCst) {
            return Err(ProviderError::ResourcesHeld(LaunchHold {
                kind: LaunchHoldKind::ConcurrencyLimit,
                running: Some(1),
                limit: Some(1),
                free_mb: None,
                floor_mb: None,
                retry_after: Duration::from_millis(15),
                wait_limit: WAIT,
            }));
        }
        self.inner.start_session(config, sink)
    }
}

impl Stack {
    fn new(ask_window: Duration) -> Self {
        Self::with_admission(ask_window, None)
    }

    fn with_admission(ask_window: Duration, admitted: Option<Arc<AtomicBool>>) -> Self {
        let dir = tempfile::tempdir().expect("dir");
        let bin = dir.path().join("bin");
        std::fs::create_dir_all(&bin).expect("bin");
        let name = if cfg!(windows) {
            "claude.exe"
        } else {
            "claude"
        };
        std::fs::copy(FAKE, bin.join(name)).expect("copy fake");
        std::fs::write(bin.join("fake-provider.json"), "{}").expect("config");
        let work = dir.path().join("work");
        std::fs::create_dir_all(&work).expect("work");

        let core = Arc::new(
            Core::open(CoreConfig {
                paths: Paths::new(dir.path().join("data")),
                app_version: "0.0.0-test".into(),
                channel: BuildChannel::Development,
            })
            .expect("core"),
        );
        let workspace_id = core.open_workspace(&work).expect("workspace").id;
        let modes = Arc::new(Modes::default());
        let service = Arc::new(
            PermissionService::new(
                core.clone(),
                Arc::new(CoreWorkspaceRoots::new(core.clone())),
                modes.clone(),
            )
            .expect("service"),
        );
        let glue = Arc::new(Glue {
            service: OnceLock::new(),
            modes: modes.clone(),
        });
        let _ = glue.service.set(Arc::downgrade(&service));

        let mut vars: Vec<(OsString, OsString)> = vec![("PATH".into(), bin.clone().into())];
        for name in ["SystemRoot", "TEMP", "TMP", "TMPDIR"] {
            if let Some(value) = std::env::var_os(name) {
                vars.push((name.into(), value));
            }
        }
        let env = DetectEnv {
            vars,
            windows: cfg!(windows),
            probe_timeout: Some(Duration::from_secs(10)),
            system_root: None,
        };
        let endpoint = Endpoint::generate(Some(dir.path())).expect("endpoint");
        let bridge = Arc::new(BridgeServer::start(ServerConfig::new(endpoint)).expect("bridge"));
        let panes = Arc::new(PaneRegistry::new());
        let interactive = Arc::new(
            InteractiveClaudeProvider::new(
                env.clone(),
                bridge,
                InteractiveConfig {
                    hook_program: FAKE.into(),
                    hook_prefix_args: vec!["hook".into()],
                    sessions_dir: dir.path().join("data").join("sessions"),
                    routing: DecisionRouting::Engine,
                    limits: SessionLimits {
                        ask_window,
                        ..SessionLimits::default()
                    },
                },
                panes.clone(),
            )
            .with_expiry(glue.clone())
            .with_titles(glue.clone()),
        );
        let providers = Arc::new(ProviderRegistry::new());
        let router = RuntimeRouter::new(Arc::new(ClaudeCodeProvider::new(env)), interactive);
        let router = if let Some(admitted) = admitted {
            router.with_session_guards(|inner| {
                Arc::new(HeldProvider {
                    inner,
                    admitted: admitted.clone(),
                })
            })
        } else {
            router
        };
        providers.register(Arc::new(router));
        let gate: Arc<dyn PermissionGate> = service.clone();
        let runtime = Arc::new(
            ThreadRuntime::new(
                core.clone(),
                providers,
                Arc::new(CoreWorkspaces::new(core)),
                gate,
            )
            .expect("runtime"),
        );
        let _ = modes.0.set(Arc::downgrade(&runtime));
        Self {
            _dir: dir,
            runtime,
            service,
            panes,
            workspace_id,
            output: Mutex::new(Vec::new()),
        }
    }

    fn new_pane(&self, mode: PermissionMode) -> String {
        let thread = RuntimeRouter::create_interactive(|| {
            self.runtime.create_idle(CreateIdleThread {
                provider_id: "claude-code".into(),
                provider_account_id: None,
                account_label: None,
                workspace_id: self.workspace_id.clone(),
                model: None,
                effort: None,
                permission_mode: mode,
                name: None,
            })
        })
        .expect("create");
        assert!(self.panes.contains(&thread.id), "{thread:?}");
        let output = Arc::new(Mutex::new(Vec::new()));
        let sink = output.clone();
        let panes = self.panes.clone();
        let id = thread.id.clone();
        self.panes
            .attach(&thread.id, move |chunk| {
                sink.lock().unwrap().extend_from_slice(chunk);
                for _ in 0..chunk.windows(4).filter(|w| *w == b"\x1b[6n").count() {
                    let _ = panes.write(&id, b"\x1b[1;1R");
                }
                true
            })
            .expect("attach");
        self.output
            .lock()
            .unwrap()
            .push((thread.id.clone(), output));
        self.wait_text(&thread.id, "KalCode fake provider");
        thread.id
    }

    /// Matches the desktop and KalVoice fan-out path: every request independently arms one
    /// interactive creation, and the requests may arrive concurrently on different IPC threads.
    fn new_panes(&self, count: usize, mode: PermissionMode) -> Vec<String> {
        std::thread::scope(|scope| {
            let starts: Vec<_> = (0..count)
                .map(|_| scope.spawn(move || self.new_pane(mode)))
                .collect();
            starts
                .into_iter()
                .map(|start| start.join().expect("pane start thread"))
                .collect()
        })
    }

    fn pane_info(&self, thread_id: &str) -> kalcode_providers::interactive::PaneInfo {
        self.panes.info(thread_id).expect("pane info")
    }

    fn wait_pane_stopped(&self, thread_id: &str) {
        let deadline = Instant::now() + WAIT;
        while self.pane_info(thread_id).running {
            assert!(Instant::now() < deadline, "the provider kept running");
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    fn set_fake_config(&self, json: &str) {
        std::fs::write(
            self._dir.path().join("bin").join("fake-provider.json"),
            json,
        )
        .expect("fake provider config");
    }

    fn provider_launches(&self) -> Vec<Vec<String>> {
        let log = std::fs::read_to_string(self._dir.path().join("bin").join("runs.log"))
            .expect("provider run log");
        log.lines()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .filter_map(|record| record.get("args").cloned())
            .filter_map(|args| serde_json::from_value::<Vec<String>>(args).ok())
            .filter(|args| args.iter().any(|arg| arg == "--settings"))
            .collect()
    }

    fn wait_provider_launches(&self, count: usize) -> Vec<Vec<String>> {
        let deadline = Instant::now() + WAIT;
        loop {
            let launches = self.provider_launches();
            if launches.len() >= count {
                return launches;
            }
            assert!(
                Instant::now() < deadline,
                "expected {count} provider launches, saw {launches:?}"
            );
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    fn text(&self, thread_id: &str) -> String {
        let outputs = self.output.lock().unwrap();
        let output = outputs
            .iter()
            .find(|(id, _)| id == thread_id)
            .map(|(_, o)| o.clone())
            .expect("pane output");
        drop(outputs);
        String::from_utf8_lossy(&output.lock().unwrap()).into_owned()
    }

    fn wait_text(&self, thread_id: &str, needle: &str) {
        let deadline = Instant::now() + WAIT;
        while Instant::now() < deadline {
            if self.text(thread_id).contains(needle) {
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        panic!("{needle:?} never appeared: {:?}", self.text(thread_id));
    }

    fn type_line(&self, thread_id: &str, line: &str) {
        self.panes
            .write(thread_id, format!("{line}\r").as_bytes())
            .expect("write");
    }

    fn wait_status(&self, thread_id: &str, status: ThreadStatus) -> ThreadSummary {
        let deadline = Instant::now() + WAIT;
        loop {
            let thread = self.runtime.get(thread_id).expect("thread");
            if thread.status == status {
                return thread;
            }
            if Instant::now() > deadline {
                panic!("never reached {status:?}: {thread:?}");
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    fn wait_resumable(&self, thread_id: &str) -> ThreadSummary {
        let deadline = Instant::now() + WAIT;
        loop {
            let thread = self.runtime.get(thread_id).expect("thread");
            if thread.resumable {
                return thread;
            }
            assert!(
                Instant::now() < deadline,
                "provider session id never became durable: {thread:?}"
            );
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    fn pending(&self) -> Vec<kalcode_permissions::ApprovalView> {
        self.service
            .list_approvals(Some(ApprovalStatus::Pending))
            .expect("list")
    }

    fn wait_pending(&self) -> kalcode_permissions::ApprovalView {
        let deadline = Instant::now() + WAIT;
        loop {
            if let Some(view) = self.pending().into_iter().next() {
                return view;
            }
            assert!(Instant::now() < deadline, "no approval appeared");
            std::thread::sleep(Duration::from_millis(25));
        }
    }
}

#[test]
fn resource_held_agent_keeps_terminal_identity_before_retry_and_after_resume() {
    let admitted = Arc::new(AtomicBool::new(false));
    let stack = Stack::with_admission(SessionLimits::default().ask_window, Some(admitted.clone()));
    let thread = RuntimeRouter::create_interactive(|| {
        stack.runtime.create_idle(CreateIdleThread {
            provider_id: "claude-code".into(),
            provider_account_id: None,
            account_label: None,
            workspace_id: stack.workspace_id.clone(),
            model: Some("sonnet".into()),
            effort: Some("high".into()),
            permission_mode: PermissionMode::Approve,
            name: None,
        })
    })
    .expect("create held agent");
    assert_eq!(thread.status, ThreadStatus::WaitingForDependency);
    assert!(
        !stack.panes.contains(&thread.id),
        "no PTY starts before admission"
    );
    let sessions = stack._dir.path().join("data/sessions");
    assert!(
        marked_interactive(&sessions, &thread.id),
        "a held agent must already be durably classified as a terminal"
    );
    admitted.store(true, Ordering::SeqCst);
    assert!(
        kalcode_providers::interactive::provider::wait_for_pane(&stack.panes, &thread.id, WAIT),
        "the waiter must start a PTY, never a headless thread"
    );
    let started = stack.wait_status(&thread.id, ThreadStatus::Idle);
    assert_eq!(started.workspace_id, stack.workspace_id);
    assert_eq!(started.model.as_deref(), Some("sonnet"));
    assert_eq!(started.effort.as_deref(), Some("high"));
    stack.runtime.stop(&thread.id).expect("stop agent");
    assert!(
        marked_interactive(&sessions, &thread.id),
        "terminal identity survives session shutdown"
    );
    stack
        .runtime
        .resume(&thread.id, None)
        .expect("resume terminal");
    stack.wait_status(&thread.id, ThreadStatus::Idle);
    assert!(
        stack
            .panes
            .info(&thread.id)
            .is_some_and(|pane| pane.running)
    );
    stack.runtime.stop(&thread.id).expect("stop resumed agent");
}

#[test]
fn one_and_four_claude_agents_start_fresh_live_terminals_in_current_workspace() {
    let stack = Stack::new(SessionLimits::default().ask_window);
    let mut previous = std::collections::HashSet::new();
    for count in [1, 4] {
        let agents = (0..count)
            .map(|_| stack.new_pane(PermissionMode::Approve))
            .collect::<Vec<_>>();
        let mut instances = std::collections::HashSet::new();
        for id in &agents {
            assert!(
                previous.insert(id.clone()),
                "every launch creates a fresh session"
            );
            let thread = stack.wait_status(id, ThreadStatus::Idle);
            assert_eq!(thread.workspace_id, stack.workspace_id);
            let pane = stack.panes.info(id).expect("real provider terminal");
            assert!(pane.running);
            assert_eq!(pane.provider_id.as_str(), "claude-code");
            assert!(instances.insert(pane.instance_id.expect("live PTY instance")));
            assert!(
                stack
                    .runtime
                    .messages(id, 10, None)
                    .expect("messages")
                    .is_empty(),
                "terminal startup must not create a chat exchange"
            );
        }
        assert_eq!(instances.len(), count);
        for id in agents {
            stack.runtime.stop(&id).expect("stop test terminal");
        }
    }
}

#[test]
fn approvals_round_trip_through_the_engine_and_the_queue() {
    let stack = Stack::new(SessionLimits::default().ask_window);
    let thread = stack.new_pane(PermissionMode::Approve);
    stack.wait_status(&thread, ThreadStatus::Idle);

    // Approve mode asks before a build command: the approval appears in KalCode's one queue.
    stack.type_line(&thread, "run cargo build");
    let view = stack.wait_pending();
    assert_eq!(view.action.thread_id, thread);
    assert_eq!(view.action.effective_origin().kind(), "thread");
    let waiting = stack.wait_status(&thread, ThreadStatus::WaitingForPermission);
    assert_eq!(waiting.pending_approvals, 1);
    assert!(
        !stack.text(&thread).contains("RAN Bash"),
        "nothing ran before the answer"
    );

    // The person approves in KalCode; the decision reaches the provider through the hook.
    stack
        .service
        .decide(&view.id, ApprovalDecision::ApproveOnce, Actor::User)
        .expect("approve");
    stack.wait_text(&thread, "RAN Bash");
    let idle = stack.wait_status(&thread, ThreadStatus::Idle);
    assert_eq!(idle.pending_approvals, 0);
    // The first prompt titled the thread (deterministic namer); the prompt itself isn't stored.
    assert_eq!(idle.name, naming::name_from_prompt("run cargo build"));
    assert!(
        stack
            .runtime
            .messages(&thread, 50, None)
            .expect("messages")
            .is_empty()
    );

    // A denial blocks the call in the provider.
    stack.type_line(&thread, "run git push origin main");
    let view = stack.wait_pending();
    stack
        .service
        .decide(&view.id, ApprovalDecision::Deny, Actor::User)
        .expect("deny");
    stack.wait_text(&thread, "BLOCKED BY HOOK");
    stack.wait_status(&thread, ThreadStatus::Idle);
    let tools = stack.runtime.tool_calls(&thread, 10).expect("tools");
    assert_eq!(tools.len(), 2, "{tools:?}");

    // Stopping the thread ends the pane's process.
    stack.runtime.stop(&thread).expect("stop");
    let deadline = Instant::now() + WAIT;
    while stack.panes.info(&thread).is_some_and(|i| i.running) {
        assert!(Instant::now() < deadline, "the provider kept running");
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[test]
fn an_unanswered_approval_expires_as_answered_in_provider() {
    let stack = Stack::new(Duration::from_millis(400));
    let thread = stack.new_pane(PermissionMode::Approve);
    stack.wait_status(&thread, ThreadStatus::Idle);
    stack.type_line(&thread, "run npm install left-pad");
    stack.wait_text(&thread, "[fake prompt] Allow Bash?");
    let all = stack.service.list_approvals(None).expect("list");
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].status, ApprovalStatus::Expired);
    assert_eq!(
        all[0].expire_reason.as_deref(),
        Some("answered_in_provider")
    );
    // The person answers in the provider's own prompt.
    stack.type_line(&thread, "y");
    stack.wait_text(&thread, "RAN Bash");
    stack.wait_status(&thread, ThreadStatus::Idle);
    stack.runtime.stop(&thread).expect("stop");
}

#[test]
fn headless_and_interactive_threads_share_one_runtime_and_status_model() {
    let stack = Stack::new(SessionLimits::default().ask_window);
    let pane = stack.new_pane(PermissionMode::Approve);
    // A headless thread (what missions and automations use) through the same provider.
    let headless = stack
        .runtime
        .create(CreateThread {
            provider_id: "claude-code".into(),
            provider_account_id: None,
            account_label: None,
            workspace_id: stack.workspace_id.clone(),
            model: None,
            effort: None,
            permission_mode: PermissionMode::Approve,
            prompt: "hello".into(),
            name: None,
        })
        .expect("headless");
    assert!(!stack.panes.contains(&headless.id));
    stack.wait_status(&headless.id, ThreadStatus::Idle);
    stack.wait_status(&pane, ThreadStatus::Idle);
    let listed = stack.runtime.list(None, false).expect("list");
    assert_eq!(listed.len(), 2);
    for thread in listed {
        assert_eq!(
            thread.status.display().0,
            kalcode_contracts::workspace_ui::DisplayStatus::Idle
        );
    }
    stack.runtime.stop(&pane).expect("stop");
    stack.runtime.stop(&headless.id).expect("stop");
}

#[test]
fn new_claude_agents_fan_out_to_fresh_live_ptys_for_one_four_and_six() {
    for count in [1, 4, 6] {
        let stack = Stack::new(SessionLimits::default().ask_window);
        let threads = stack.new_panes(count, PermissionMode::Approve);

        assert_eq!(threads.len(), count);
        assert_eq!(threads.iter().collect::<HashSet<_>>().len(), count);
        let mut instances = HashSet::new();
        for thread_id in &threads {
            stack.wait_status(thread_id, ThreadStatus::Idle);
            // The launch itself publishes Idle before the authenticated SessionStart hook can
            // make the provider's resume identity durable. Wait for that exact lifecycle fact.
            let thread = stack.wait_resumable(thread_id);
            assert!(thread.error.is_none(), "fresh agent failed: {thread:?}");
            assert!(
                thread.resumable,
                "Claude did not report a session id: {thread:?}"
            );
            let info = stack.pane_info(thread_id);
            assert!(info.running, "fresh provider process is not live: {info:?}");
            assert_eq!(info.thread_id, *thread_id);
            assert!(
                instances.insert(info.instance_id.expect("process instance id")),
                "two panes shared one provider process identity"
            );
        }

        let launches = stack.wait_provider_launches(count);
        assert_eq!(
            launches.len(),
            count,
            "unexpected Claude launches: {launches:?}"
        );
        let session_ids: HashSet<_> = launches
            .iter()
            .map(|args| {
                let index = args
                    .iter()
                    .position(|arg| arg == "--session-id")
                    .expect("new launch must use --session-id");
                args.get(index + 1).expect("session id value").clone()
            })
            .collect();
        assert_eq!(
            session_ids.len(),
            count,
            "new agents reused a provider session id: {launches:?}"
        );
        assert!(
            launches
                .iter()
                .all(|args| !args.iter().any(|arg| arg == "--resume")),
            "a new agent resumed historical provider state: {launches:?}"
        );

        for thread_id in threads {
            stack.runtime.stop(&thread_id).expect("stop");
            stack.wait_pane_stopped(&thread_id);
        }
    }
}

#[test]
fn one_claude_provider_failure_does_not_end_its_siblings() {
    let stack = Stack::new(SessionLimits::default().ask_window);
    stack.set_fake_config(r#"{"exitCode":17}"#);
    let threads = stack.new_panes(4, PermissionMode::Approve);
    let failed = &threads[0];

    // A non-zero provider exit is a genuine failure, not an intentional stop.
    stack.type_line(failed, "exit");
    stack.wait_pane_stopped(failed);
    let failed_thread = stack.wait_status(failed, ThreadStatus::Failed);
    assert_eq!(
        failed_thread
            .error
            .as_ref()
            .map(|error| error.code.as_str()),
        Some("provider_exited")
    );

    for sibling in &threads[1..] {
        assert!(stack.pane_info(sibling).running, "sibling process ended");
        let thread = stack.wait_status(sibling, ThreadStatus::Idle);
        assert!(
            thread.error.is_none(),
            "sibling inherited failure: {thread:?}"
        );
    }

    for sibling in &threads[1..] {
        stack.runtime.stop(sibling).expect("stop sibling");
        stack.wait_pane_stopped(sibling);
    }
}

#[test]
fn a_fresh_claude_agent_never_inherits_an_ended_historical_pane() {
    let stack = Stack::new(SessionLimits::default().ask_window);
    let historical = stack.new_pane(PermissionMode::Approve);
    stack.wait_resumable(&historical);
    let historical_instance = stack
        .pane_info(&historical)
        .instance_id
        .expect("historical instance");
    let original_launch = stack
        .wait_provider_launches(1)
        .pop()
        .expect("original launch");
    let original_session = original_launch
        .iter()
        .position(|arg| arg == "--session-id")
        .and_then(|index| original_launch.get(index + 1))
        .cloned()
        .expect("original provider session");

    stack.runtime.stop(&historical).expect("stop historical");
    stack.wait_pane_stopped(&historical);
    assert!(
        stack
            .runtime
            .get(&historical)
            .expect("stopped historical")
            .resumable,
        "stopping a historical agent cleared its durable provider session"
    );

    let fresh = stack.new_pane(PermissionMode::Approve);
    let fresh_info = stack.pane_info(&fresh);
    let fresh_instance = fresh_info.instance_id.clone().expect("fresh instance");
    assert!(fresh_info.running);
    assert_ne!(fresh, historical);
    assert_ne!(fresh_instance, historical_instance);
    let fresh_launch = stack.wait_provider_launches(2).pop().expect("fresh launch");
    let fresh_session = fresh_launch
        .iter()
        .position(|arg| arg == "--session-id")
        .and_then(|index| fresh_launch.get(index + 1))
        .cloned()
        .expect("fresh provider session");
    assert_ne!(fresh_session, original_session);
    assert!(!fresh_launch.iter().any(|arg| arg == "--resume"));

    // Resuming the historical agent is a separate path: it keeps the thread/provider session
    // identity but receives a new process instance. The fresh agent remains untouched and live.
    stack
        .runtime
        .resume(&historical, None)
        .expect("resume historical");
    stack.wait_status(&historical, ThreadStatus::Idle);
    let resumed_info = stack.pane_info(&historical);
    assert!(resumed_info.running);
    assert_ne!(
        resumed_info.instance_id.as_deref(),
        Some(historical_instance.as_str())
    );
    assert_ne!(
        resumed_info.instance_id.as_deref(),
        Some(fresh_instance.as_str())
    );
    let resumed_launch = stack
        .wait_provider_launches(3)
        .pop()
        .expect("resume launch");
    let resumed_session = resumed_launch
        .iter()
        .position(|arg| arg == "--resume")
        .and_then(|index| resumed_launch.get(index + 1))
        .cloned()
        .unwrap_or_else(|| panic!("resume provider session missing: {resumed_launch:?}"));
    assert_eq!(resumed_session, original_session);
    assert_eq!(
        stack.pane_info(&fresh).instance_id.as_deref(),
        Some(fresh_instance.as_str())
    );
    assert!(stack.pane_info(&fresh).running);

    stack.runtime.stop(&historical).expect("stop resumed");
    stack.runtime.stop(&fresh).expect("stop fresh");
    stack.wait_pane_stopped(&historical);
    stack.wait_pane_stopped(&fresh);
}
