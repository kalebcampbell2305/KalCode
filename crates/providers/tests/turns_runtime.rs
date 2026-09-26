//! Codex and Gemini CLI headless threads through the whole stack: the Z3 thread runtime (one
//! status machine), the Z4 permission engine as its gate, and Provider Health observing the
//! same sessions, with the fake provider replaying official-format fixtures. Covers thread
//! create → stream → done, a follow-up message resuming the provider session, stop, and resume
//! after the session ended. No AI quota is used.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::ffi::OsString;
use std::sync::{Arc, OnceLock, Weak};
use std::time::{Duration, Instant};

use kalcode_contracts::agent::{AgentProvider, ProviderId};
use kalcode_contracts::health::HealthState;
use kalcode_contracts::permissions::{PermissionGate, PermissionMode};
use kalcode_contracts::threads::{MessageRole, ThreadStatus, ThreadSummary};
use kalcode_core::flags::BuildChannel;
use kalcode_core::{Core, CoreConfig, KalError, Paths};
use kalcode_permissions::{CoreWorkspaceRoots, PermissionService, ThreadModeStore};
use kalcode_providers::health::observe::ObservedProvider;
use kalcode_providers::{CodexProvider, DetectEnv, GeminiProvider, HealthMonitor};
use kalcode_threads::{CoreWorkspaces, CreateThread, ProviderRegistry, ThreadRuntime};

const FAKE: &str = env!("CARGO_BIN_EXE_kalcode-fake-provider");
const WAIT: Duration = Duration::from_secs(30);

#[derive(Default)]
struct Modes(OnceLock<Weak<ThreadRuntime>>);

impl ThreadModeStore for Modes {
    fn thread(&self, thread_id: &str) -> kalcode_core::Result<Option<ThreadSummary>> {
        let runtime = self
            .0
            .get()
            .and_then(Weak::upgrade)
            .ok_or_else(|| KalError::internal("threads_unavailable", "gone"))?;
        match runtime.get(thread_id) {
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
        self.0
            .get()
            .and_then(Weak::upgrade)
            .ok_or_else(|| KalError::internal("threads_unavailable", "gone"))?
            .set_permission_mode(thread_id, mode, profile_id)
    }
}

struct Stack {
    _dir: tempfile::TempDir,
    runtime: Arc<ThreadRuntime>,
    monitor: Arc<HealthMonitor>,
    workspace_id: String,
}

impl Stack {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("dir");
        let bin = dir.path().join("bin");
        std::fs::create_dir_all(&bin).expect("bin");
        for name in ["codex", "gemini"] {
            let file = if cfg!(windows) {
                format!("{name}.exe")
            } else {
                name.to_owned()
            };
            std::fs::copy(FAKE, bin.join(file)).expect("copy fake");
        }
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
        let mut vars: Vec<(OsString, OsString)> = vec![("PATH".into(), bin.into())];
        for name in ["SystemRoot", "TEMP", "TMP", "TMPDIR"] {
            if let Some(value) = std::env::var_os(name) {
                vars.push((name.into(), value));
            }
        }
        let env = DetectEnv {
            vars,
            windows: cfg!(windows),
            probe_timeout: Some(Duration::from_secs(10)),
        };
        let monitor = Arc::new(HealthMonitor::new());
        let detection = kalcode_providers::ProviderRegistry::new(env.clone());
        detection.set_health(monitor.clone());
        detection.detect_all();
        let providers = Arc::new(ProviderRegistry::new());
        let codex: Arc<dyn AgentProvider> = Arc::new(CodexProvider::new(env.clone()));
        let gemini: Arc<dyn AgentProvider> = Arc::new(GeminiProvider::new(env));
        providers.register(ObservedProvider::wrap(codex, Some(&monitor)));
        providers.register(ObservedProvider::wrap(gemini, Some(&monitor)));
        let gate: Arc<dyn PermissionGate> = service;
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
            monitor,
            workspace_id,
        }
    }

    fn create(&self, provider: &str, prompt: &str) -> ThreadSummary {
        self.runtime
            .create(CreateThread {
                provider_id: provider.into(),
                provider_account_id: None,
                account_label: None,
                workspace_id: self.workspace_id.clone(),
                model: None,
                permission_mode: PermissionMode::Approve,
                prompt: prompt.into(),
                name: None,
            })
            .expect("create")
    }

    fn wait_status(&self, thread_id: &str, want: ThreadStatus) -> ThreadSummary {
        let deadline = Instant::now() + WAIT;
        loop {
            let thread = self.runtime.get(thread_id).expect("thread");
            if thread.status == want {
                return thread;
            }
            assert!(
                Instant::now() < deadline,
                "never reached {want:?}: {thread:?}"
            );
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    fn assistant_texts(&self, thread_id: &str) -> Vec<String> {
        self.runtime
            .messages(thread_id, 50, None)
            .expect("messages")
            .into_iter()
            .filter(|m| m.role == MessageRole::Assistant)
            .map(|m| m.content)
            .collect()
    }

    fn wait_messages(&self, thread_id: &str, count: usize) -> Vec<String> {
        let deadline = Instant::now() + WAIT;
        loop {
            let texts = self.assistant_texts(thread_id);
            if texts.len() >= count {
                return texts;
            }
            assert!(Instant::now() < deadline, "only {texts:?}");
            std::thread::sleep(Duration::from_millis(25));
        }
    }
}

#[test]
fn codex_threads_stream_to_done_and_follow_ups_resume_the_codex_thread() {
    let stack = Stack::new();
    let thread = stack.create(ProviderId::CODEX, "hello from a KalCode thread");
    assert_eq!(thread.provider_id.as_str(), "codex");
    let texts = stack.wait_messages(&thread.id, 1);
    assert_eq!(texts, ["Hello from the fake Codex."]);
    let idle = stack.wait_status(&thread.id, ThreadStatus::Idle);
    assert!(idle.error.is_none(), "{idle:?}");

    // A follow-up right after the turn: the runtime sends, the adapter resumes Codex's thread.
    stack
        .runtime
        .send(&thread.id, "now use tools")
        .expect("send");
    let texts = stack.wait_messages(&thread.id, 2);
    assert_eq!(texts[1], "Updated notes.md.");
    stack.wait_status(&thread.id, ThreadStatus::Idle);

    let health = stack
        .monitor
        .get(&ProviderId::new(ProviderId::CODEX))
        .unwrap();
    assert_eq!(health.active_sessions, 1);
    assert!(health.latency_samples >= 2, "{health:?}");

    stack.runtime.stop(&thread.id).expect("stop");
    let deadline = Instant::now() + WAIT;
    while stack
        .monitor
        .get(&ProviderId::new(ProviderId::CODEX))
        .unwrap()
        .active_sessions
        != 0
    {
        assert!(Instant::now() < deadline, "session count never dropped");
        std::thread::sleep(Duration::from_millis(25));
    }

    // Resume after stop continues the same Codex thread (resumable by its id).
    stack
        .runtime
        .resume(&thread.id, Some("hello again"))
        .expect("resume");
    stack.wait_messages(&thread.id, 3);
    stack.wait_status(&thread.id, ThreadStatus::Idle);
    stack.runtime.stop(&thread.id).expect("stop");
}

#[test]
fn a_failed_codex_turn_is_recorded_and_the_thread_stays_usable() {
    let stack = Stack::new();
    let thread = stack.create(ProviderId::CODEX, "please fail");
    let deadline = Instant::now() + WAIT;
    let failed = loop {
        let t = stack.runtime.get(&thread.id).unwrap();
        if t.error.is_some() && t.status == ThreadStatus::Idle {
            break t;
        }
        assert!(Instant::now() < deadline, "{t:?}");
        std::thread::sleep(Duration::from_millis(25));
    };
    assert_eq!(
        failed.error.as_ref().map(|e| e.code.as_str()),
        Some("turn_failed")
    );
    stack
        .runtime
        .send(&thread.id, "hello")
        .expect("send after a failed turn");
    stack.wait_messages(&thread.id, 1);
    stack.runtime.stop(&thread.id).expect("stop");
}

#[test]
fn gemini_threads_stream_to_done_and_quota_errors_degrade_health() {
    let stack = Stack::new();
    let thread = stack.create(ProviderId::GEMINI_CLI, "hello gemini");
    let texts = stack.wait_messages(&thread.id, 1);
    assert_eq!(texts, ["Hello from the fake Gemini CLI."]);
    stack.wait_status(&thread.id, ThreadStatus::Idle);

    stack.runtime.send(&thread.id, "quota").expect("send");
    let deadline = Instant::now() + WAIT;
    loop {
        let health = stack
            .monitor
            .get(&ProviderId::new(ProviderId::GEMINI_CLI))
            .unwrap();
        if health.state == HealthState::Degraded
            && health.capacity == kalcode_contracts::health::CapacityState::BackingOff
        {
            assert_eq!(health.reason_code.as_deref(), Some("rate_limited"));
            break;
        }
        assert!(Instant::now() < deadline, "{health:?}");
        std::thread::sleep(Duration::from_millis(25));
    }
    let thread = stack.wait_status(&thread.id, ThreadStatus::Idle);
    assert_eq!(
        thread.error.as_ref().map(|e| e.code.as_str()),
        Some("rate_limited")
    );
    stack.runtime.stop(&thread.id).expect("stop");
}
