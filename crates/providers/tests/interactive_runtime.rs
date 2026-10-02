//! Provider panes through the whole stack: the Z3 thread runtime, the Z4 permission engine and
//! the approval queue, with the fake provider in a real PTY and the real hook bridge. Covers the
//! approval round trip (hook → approval → the person's decision → provider), the hand-over to
//! the provider's own prompt (`answered_in_provider`), and headless/interactive threads side by
//! side in one runtime and one status model. No AI quota is used.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::ffi::OsString;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};

use kalcode_contracts::agent::AgentProvider;
use kalcode_contracts::permissions::{
    ApprovalDecision, ApprovalStatus, PermissionGate, PermissionMode,
};
use kalcode_contracts::threads::{ThreadStatus, ThreadSummary};
use kalcode_core::flags::BuildChannel;
use kalcode_core::{Core, CoreConfig, KalError, Paths};
use kalcode_hook_bridge::Endpoint;
use kalcode_hook_bridge::server::{BridgeServer, ServerConfig};
use kalcode_permissions::{Actor, CoreWorkspaceRoots, PermissionService, ThreadModeStore};
use kalcode_providers::interactive::provider::{
    InteractiveClaudeProvider, InteractiveConfig, PaneRegistry, RuntimeRouter,
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
            .is_ok_and(|t| t.name == naming::FALLBACK_NAME)
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

impl Stack {
    fn new(ask_window: Duration) -> Self {
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
        let router: Arc<dyn AgentProvider> = Arc::new(RuntimeRouter::new(
            Arc::new(ClaudeCodeProvider::new(env)),
            interactive,
        ));
        providers.register(router);
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
