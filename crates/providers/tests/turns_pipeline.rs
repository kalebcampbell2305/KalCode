//! End-to-end tests of the Codex and Gemini CLI adapters against the fake provider executable
//! (`src/bin/fake_provider.rs`), copied as `codex` / `gemini` into a temporary folder that is the
//! only `PATH` entry. It replays the official-format fixtures in `tests/fixtures/{codex,gemini}`.
//! No real provider runs and no AI quota is used.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::ffi::OsString;
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use kalcode_contracts::agent::{
    AgentEvent, AgentInput, AgentProvider, AgentSession, AuthState, DetectionState, FileChange,
    ProviderError, ProviderId, SessionConfig,
};
use kalcode_contracts::health::{CapacityState, HealthState};
use kalcode_contracts::permissions::PermissionMode;
use kalcode_contracts::threads::ThreadStatus;
use kalcode_providers::health::observe::ObservedProvider;
use kalcode_providers::{
    CodexProvider, DetectEnv, GeminiProvider, HealthMonitor, ProviderRegistry, catalog, detect,
};
use serde_json::{Value, json};

const FAKE: &str = env!("CARGO_BIN_EXE_kalcode-fake-provider");
const WAIT: Duration = Duration::from_secs(20);

struct FakeInstall {
    dir: tempfile::TempDir,
    work: tempfile::TempDir,
}

impl FakeInstall {
    fn new(name: &str, config: Value) -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.to_owned()
        };
        std::fs::copy(FAKE, dir.path().join(file)).expect("copy fake provider");
        std::fs::write(dir.path().join("fake-provider.json"), config.to_string()).expect("config");
        Self {
            dir,
            work: tempfile::tempdir().expect("workdir"),
        }
    }

    fn env(&self) -> DetectEnv {
        let mut vars: Vec<(OsString, OsString)> = vec![
            ("PATH".into(), self.dir.path().into()),
            ("ANTHROPIC_API_KEY".into(), "test-anthropic-value".into()),
            ("OPENAI_API_KEY".into(), "test-openai-value".into()),
            ("GEMINI_API_KEY".into(), "test-gemini-value".into()),
            ("KALCODE_DATA_DIR".into(), "/should/not/pass".into()),
            ("GITHUB_TOKEN".into(), "test-github-value".into()),
        ];
        for name in ["SystemRoot", "TEMP", "TMP", "TMPDIR"] {
            if let Some(value) = std::env::var_os(name) {
                vars.push((name.into(), value));
            }
        }
        DetectEnv {
            vars,
            windows: cfg!(windows),
            probe_timeout: Some(Duration::from_secs(10)),
            system_root: None,
        }
    }

    fn read_json(&self, file: &str) -> Value {
        let text = std::fs::read_to_string(self.dir.path().join(file)).expect(file);
        serde_json::from_str(&text).expect("json")
    }

    fn args(&self) -> Vec<String> {
        serde_json::from_value(self.read_json("last-args.json")).expect("args")
    }

    fn env_names(&self) -> Vec<String> {
        serde_json::from_value(self.read_json("last-env.json")).expect("env")
    }

    fn stdin(&self) -> String {
        std::fs::read_to_string(self.dir.path().join("last-stdin.txt")).expect("stdin")
    }

    fn config(&self, mode: PermissionMode, resume: Option<&str>) -> SessionConfig {
        SessionConfig {
            thread_id: kalcode_contracts::ids::new_id(),
            workspace_id: kalcode_contracts::ids::new_id(),
            provider_account_id: None,
            working_directory: self.work.path().display().to_string(),
            model: None,
            effort: None,
            permission_mode: mode,
            resume_session_id: resume.map(str::to_owned),
            secret_ref: None,
        }
    }
}

fn start(
    provider: &dyn AgentProvider,
    config: SessionConfig,
) -> (Box<dyn AgentSession>, Receiver<AgentEvent>) {
    let (tx, rx) = mpsc::channel();
    let session = provider
        .start_session(
            config,
            Box::new(move |event: AgentEvent| {
                let _ = tx.send(event);
            }),
        )
        .expect("session starts");
    (session, rx)
}

fn until(rx: &Receiver<AgentEvent>, done: impl Fn(&AgentEvent) -> bool) -> Vec<AgentEvent> {
    let deadline = Instant::now() + WAIT;
    let mut events = Vec::new();
    loop {
        let event = rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap_or_else(|_| panic!("timed out; got {events:#?}"));
        let finished = done(&event);
        events.push(event);
        if finished {
            return events;
        }
    }
}

fn turn(session: &dyn AgentSession, rx: &Receiver<AgentEvent>, text: &str) -> Vec<AgentEvent> {
    session
        .send(AgentInput::Text { text: text.into() })
        .expect("send");
    until(rx, |e| matches!(e, AgentEvent::TurnCompleted { .. }))
}

fn after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
}

// ---- Codex ----------------------------------------------------------------------------

#[test]
fn codex_detection_uses_version_and_login_status() {
    let fake = FakeInstall::new("codex", json!({"loginStatus": "Logged in using ChatGPT"}));
    let result = detect::detect(&catalog::codex_spec(), &fake.env());
    assert_eq!(result.detection.state, DetectionState::Installed);
    assert_eq!(result.detection.version.as_deref(), Some("0.160.0"));
    assert_eq!(
        result.detection.minimum_version.as_deref(),
        Some(if cfg!(windows) { "0.160.0" } else { "0.155.1" })
    );
    assert_eq!(result.detection.auth, AuthState::Authenticated);

    let old = FakeInstall::new("codex", json!({"version": "codex-cli 0.120.0"}));
    assert_eq!(
        detect::detect(&catalog::codex_spec(), &old.env())
            .detection
            .state,
        DetectionState::Outdated
    );
    let out = FakeInstall::new(
        "codex",
        json!({"loginStatus": "Not logged in", "loginExit": 1}),
    );
    let provider = CodexProvider::new(out.env());
    let (tx, _rx) = mpsc::channel::<AgentEvent>();
    let refused = provider.start_session(
        out.config(PermissionMode::Approve, None),
        Box::new(move |e| {
            let _ = tx.send(e);
        }),
    );
    assert_eq!(refused.err(), Some(ProviderError::NotAuthenticated));
}

#[test]
fn codex_text_turn_streams_to_done_and_the_next_turn_resumes_the_thread() {
    let fake = FakeInstall::new("codex", json!({}));
    let provider = CodexProvider::new(fake.env());
    let (session, rx) = start(&provider, fake.config(PermissionMode::Approve, None));

    let events = turn(session.as_ref(), &rx, "hello from KalCode");
    let thread_id = events
        .iter()
        .find_map(|e| match e {
            AgentEvent::SessionStarted {
                provider_session_id,
                ..
            } => Some(provider_session_id.clone()),
            _ => None,
        })
        .expect("thread.started");
    assert!(events.iter().any(|e| matches!(e, AgentEvent::MessageCompleted { text, .. } if text == "Hello from the fake Codex.")));
    assert!(
        events
            .iter()
            .any(|e| matches!(e, AgentEvent::Usage { usage } if usage.input_tokens == Some(2400)))
    );
    assert!(events.contains(&AgentEvent::TurnCompleted { ok: true }));
    assert_eq!(
        session.provider_session_id().as_deref(),
        Some(thread_id.as_str())
    );

    // The message went over stdin, never on the command line.
    let args = fake.args();
    assert!(fake.stdin().contains("hello from KalCode"));
    assert!(!args.iter().any(|a| a.contains("hello from KalCode")));
    assert_eq!(args.first().map(String::as_str), Some("exec"));
    assert_eq!(args.last().map(String::as_str), Some("-"));
    assert_eq!(after(&args, "--sandbox"), Some("workspace-write"));
    assert!(args.iter().any(|a| a == "approval_policy='on-request'"));
    assert!(!args.iter().any(|a| a == "approval_policy='never'"));
    assert!(!args.iter().any(|a| a == "resume"));

    // Credential scoping: only Codex's own variables reach Codex.
    let names = fake.env_names();
    assert!(names.iter().any(|n| n == "OPENAI_API_KEY"));
    for foreign in [
        "ANTHROPIC_API_KEY",
        "GEMINI_API_KEY",
        "KALCODE_DATA_DIR",
        "GITHUB_TOKEN",
    ] {
        assert!(
            !names.iter().any(|n| n.eq_ignore_ascii_case(foreign)),
            "{foreign} passed"
        );
    }

    // Turn two resumes the same Codex thread.
    let events = turn(session.as_ref(), &rx, "and again");
    assert!(events.contains(&AgentEvent::TurnCompleted { ok: true }));
    let args = fake.args();
    assert_eq!(after(&args, "resume"), Some(thread_id.as_str()));
    assert_eq!(after(&args, "--sandbox"), Some("workspace-write"));
    assert!(args.iter().any(|a| a == "approval_policy='on-request'"));
    assert!(!args.iter().any(|a| a == "approval_policy='never'"));
    assert_eq!(args.last().map(String::as_str), Some("-"));

    session.terminate().expect("terminate");
    until(&rx, |e| matches!(e, AgentEvent::Exited { .. }));
    assert_eq!(
        session.send(AgentInput::Text { text: "x".into() }),
        Err(ProviderError::SessionEnded)
    );
}

#[test]
fn codex_tool_turn_reports_commands_and_file_changes() {
    let fake = FakeInstall::new("codex", json!({}));
    let provider = CodexProvider::new(fake.env());
    let (session, rx) = start(&provider, fake.config(PermissionMode::Bypass, None));
    let events = turn(session.as_ref(), &rx, "use tools");
    assert!(events.iter().any(|e| matches!(
        e,
        AgentEvent::Status {
            status: ThreadStatus::RunningCommand,
            ..
        }
    )));
    assert!(events.iter().any(|e| matches!(e, AgentEvent::ToolCompleted { tool_call_id, ok: true, .. } if tool_call_id == "item_0")));
    let work_root = if cfg!(target_os = "macos") {
        fake.work.path().canonicalize().expect("canonical workdir")
    } else {
        fake.work.path().to_path_buf()
    };
    let work = work_root.display().to_string();
    assert!(events.iter().any(|e| matches!(e, AgentEvent::FileChanged { path, change: FileChange::Modified } if path.ends_with("notes.md") && path.starts_with(&work))));
    let args = fake.args();
    assert_eq!(after(&args, "--sandbox"), Some("danger-full-access"));
    assert!(args.iter().any(|a| a == "approval_policy='never'"));
    assert!(!args.iter().any(|a| a == "approval_policy='on-request'"));
    assert!(
        !args
            .iter()
            .any(|a| a == "--dangerously-bypass-approvals-and-sandbox")
    );
}

#[test]
fn codex_argv_is_never_broader_than_the_mode() {
    let fake = FakeInstall::new("codex", json!({}));
    let provider = CodexProvider::new(fake.env());
    for (mode, expected_sandbox, expected_approval) in [
        (PermissionMode::Plan, "read-only", "approval_policy='never'"),
        (
            PermissionMode::Approve,
            "workspace-write",
            "approval_policy='on-request'",
        ),
        (
            PermissionMode::Auto,
            "workspace-write",
            "approval_policy='never'",
        ),
        (
            PermissionMode::Custom,
            "workspace-write",
            "approval_policy='on-request'",
        ),
        (
            PermissionMode::Bypass,
            "danger-full-access",
            "approval_policy='never'",
        ),
    ] {
        let (session, rx) = start(&provider, fake.config(mode, None));
        turn(session.as_ref(), &rx, "hello");
        let args = fake.args();
        for forbidden in kalcode_providers::codex::argv::FORBIDDEN {
            assert!(
                !args.iter().any(|a| a.contains(forbidden)),
                "{mode:?}: {forbidden}"
            );
        }
        assert_eq!(
            after(&args, "--sandbox"),
            Some(expected_sandbox),
            "{mode:?}"
        );
        let approval_policies: Vec<&str> = args
            .iter()
            .filter_map(|arg| arg.starts_with("approval_policy=").then_some(arg.as_str()))
            .collect();
        assert_eq!(approval_policies, [expected_approval], "{mode:?}");
        session.terminate().unwrap();
    }
}

#[test]
fn codex_failures_are_recoverable_and_never_leak_stderr() {
    let fake = FakeInstall::new("codex", json!({}));
    let provider = CodexProvider::new(fake.env());
    let (session, rx) = start(&provider, fake.config(PermissionMode::Approve, None));

    let events = turn(session.as_ref(), &rx, "please fail");
    assert!(events.iter().any(
        |e| matches!(e, AgentEvent::Error { code, recoverable: true, .. } if code == "turn_failed")
    ));
    assert!(events.contains(&AgentEvent::TurnCompleted { ok: false }));
    // turn.failed already ended the turn: the non-zero exit adds no second error.
    let crash_errors = events
        .iter()
        .filter(|e| matches!(e, AgentEvent::Error { code, .. } if code == "process_exited"))
        .count();
    assert_eq!(crash_errors, 0);

    let events = turn(session.as_ref(), &rx, "crash now");
    let crash = events.iter().find_map(|e| match e {
        AgentEvent::Error {
            code,
            message,
            recoverable,
        } if code == "process_exited" => Some((message.clone(), *recoverable)),
        _ => None,
    });
    let (message, recoverable) = crash.expect("crash reported");
    assert!(recoverable);
    assert!(message.contains("exit code 3"), "{message}");
    for event in &events {
        let text = format!("{event:?}");
        assert!(!text.contains("sk-proj"), "stderr leaked into {text}");
    }
    // The session is still usable after a crashed turn.
    let events = turn(session.as_ref(), &rx, "hello");
    assert!(events.contains(&AgentEvent::TurnCompleted { ok: true }));
    session.terminate().unwrap();
}

#[test]
fn codex_interrupt_kills_the_turn_tree_and_keeps_the_session() {
    let fake = FakeInstall::new("codex", json!({}));
    let provider = CodexProvider::new(fake.env());
    let (session, rx) = start(&provider, fake.config(PermissionMode::Approve, None));
    session
        .send(AgentInput::Text {
            text: "hang forever".into(),
        })
        .expect("send");
    let pid_file = fake.dir.path().join("grandchild.pid");
    let deadline = Instant::now() + WAIT;
    while !pid_file.exists() {
        assert!(Instant::now() < deadline, "grandchild never started");
        std::thread::sleep(Duration::from_millis(50));
    }
    // A second message while the turn runs is refused, not queued into the provider.
    assert!(matches!(
        session.send(AgentInput::Text {
            text: "more".into()
        }),
        Err(ProviderError::Io(_))
    ));
    session.interrupt().expect("interrupt");
    let events = until(&rx, |e| {
        matches!(
            e,
            AgentEvent::Status {
                status: ThreadStatus::Interrupted,
                ..
            }
        )
    });
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, AgentEvent::Error { code, .. } if code == "process_exited"))
    );
    let pid: u32 = std::fs::read_to_string(&pid_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let deadline = Instant::now() + WAIT;
    while process_alive(pid) {
        assert!(
            Instant::now() < deadline,
            "grandchild {pid} outlived the interrupt"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    // The next message starts a new turn.
    let events = turn(session.as_ref(), &rx, "hello");
    assert!(events.contains(&AgentEvent::TurnCompleted { ok: true }));
    session.terminate().unwrap();
}

#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    use std::os::windows::process::CommandExt;

    let mut command = std::process::Command::new("tasklist");
    command.creation_flags(0x0800_0000);
    let out = command
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
}

#[cfg(not(windows))]
fn process_alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .is_ok_and(|s| s.success())
}

#[test]
fn codex_malformed_output_is_reported_without_echo() {
    let fake = FakeInstall::new("codex", json!({}));
    let provider = CodexProvider::new(fake.env());
    let (session, rx) = start(&provider, fake.config(PermissionMode::Approve, None));
    session
        .send(AgentInput::Text {
            text: "malformed".into(),
        })
        .unwrap();
    let events = until(
        &rx,
        |e| matches!(e, AgentEvent::Error { code, .. } if code == "protocol_error"),
    );
    assert!(!format!("{events:?}").contains("not json at all"));
    session.terminate().unwrap();
}

#[test]
fn codex_resume_starts_with_the_known_thread() {
    let fake = FakeInstall::new("codex", json!({}));
    let provider = CodexProvider::new(fake.env());
    let id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
    let (session, rx) = start(&provider, fake.config(PermissionMode::Approve, Some(id)));
    assert_eq!(session.provider_session_id().as_deref(), Some(id));
    let events = turn(session.as_ref(), &rx, "continue");
    assert!(events.iter().any(|e| matches!(e, AgentEvent::SessionStarted { provider_session_id, .. } if provider_session_id == id)));
    assert_eq!(after(&fake.args(), "resume"), Some(id));
    // An id that isn't a UUID never reaches argv.
    let (tx, _rx) = mpsc::channel::<AgentEvent>();
    let bad = provider.start_session(
        fake.config(PermissionMode::Approve, Some("--last")),
        Box::new(move |e| {
            let _ = tx.send(e);
        }),
    );
    assert!(matches!(bad.err(), Some(ProviderError::Start(_))));
    session.terminate().unwrap();
}

// ---- Gemini CLI -----------------------------------------------------------------------

#[test]
fn gemini_detection_reports_sign_in_as_unknown() {
    let fake = FakeInstall::new("gemini", json!({}));
    let result = detect::detect(&catalog::gemini_spec(), &fake.env());
    assert_eq!(result.detection.state, DetectionState::Installed);
    assert_eq!(result.detection.version.as_deref(), Some("0.21.0"));
    assert_eq!(
        result.detection.auth,
        AuthState::Unknown,
        "no documented status command"
    );
    // Only `--version` ran: no sign-in probe, no prompt.
    let runs = std::fs::read_to_string(fake.dir.path().join("runs.log")).unwrap();
    assert_eq!(runs.lines().count(), 1, "{runs}");
}

#[test]
fn gemini_turns_stream_to_done_and_resume_by_session_id() {
    let fake = FakeInstall::new("gemini", json!({}));
    let provider = GeminiProvider::new(fake.env());
    let (session, rx) = start(&provider, fake.config(PermissionMode::Approve, None));
    let events = turn(session.as_ref(), &rx, "hello gemini");
    let deltas: String = events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::MessageDelta { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(deltas, "Hello from the fake Gemini CLI.");
    assert!(events.iter().any(|e| matches!(e, AgentEvent::MessageCompleted { text, .. } if text == "Hello from the fake Gemini CLI.")));
    let session_id = session.provider_session_id().expect("session id from init");
    let args = fake.args();
    assert_eq!(after(&args, "--output-format"), Some("stream-json"));
    assert_eq!(after(&args, "--approval-mode"), Some("default"));
    assert!(fake.stdin().contains("hello gemini"));
    assert!(!args.iter().any(|a| a.contains("hello gemini")));
    let names = fake.env_names();
    assert!(names.iter().any(|n| n == "GEMINI_API_KEY"));
    for foreign in [
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "KALCODE_DATA_DIR",
        "GITHUB_TOKEN",
    ] {
        assert!(
            !names.iter().any(|n| n.eq_ignore_ascii_case(foreign)),
            "{foreign} passed"
        );
    }

    let events = turn(session.as_ref(), &rx, "use tools");
    assert!(
        events.iter().any(
            |e| matches!(e, AgentEvent::FileChanged { path, .. } if path.ends_with("notes.md"))
        )
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, AgentEvent::ToolCompleted { ok: false, .. })),
        "the shell call wasn't available"
    );
    assert_eq!(after(&fake.args(), "--resume"), Some(session_id.as_str()));
    session.terminate().unwrap();
}

#[test]
fn gemini_modes_never_use_yolo() {
    let fake = FakeInstall::new("gemini", json!({}));
    let provider = GeminiProvider::new(fake.env());
    for (mode, expected) in [
        (PermissionMode::Plan, "plan"),
        (PermissionMode::Approve, "default"),
        (PermissionMode::Auto, "default"),
        (PermissionMode::Custom, "default"),
        (PermissionMode::Bypass, "auto_edit"),
    ] {
        let (session, rx) = start(&provider, fake.config(mode, None));
        turn(session.as_ref(), &rx, "hello");
        let args = fake.args();
        assert_eq!(after(&args, "--approval-mode"), Some(expected), "{mode:?}");
        for forbidden in kalcode_providers::gemini::FORBIDDEN {
            assert!(
                !args.iter().any(|a| a == forbidden),
                "{mode:?}: {forbidden}"
            );
        }
        session.terminate().unwrap();
    }
}

#[test]
fn gemini_quota_errors_are_rate_limits_and_crashes_are_recoverable() {
    let fake = FakeInstall::new("gemini", json!({}));
    let provider = GeminiProvider::new(fake.env());
    let (session, rx) = start(&provider, fake.config(PermissionMode::Approve, None));
    let events = turn(session.as_ref(), &rx, "quota please");
    assert!(
        events
            .iter()
            .any(|e| matches!(e, AgentEvent::Error { code, .. } if code == "rate_limited"))
    );
    let events = turn(session.as_ref(), &rx, "crash");
    assert!(events.iter().any(|e| matches!(e, AgentEvent::Error { code, recoverable: true, .. } if code == "process_exited")));
    assert!(!format!("{events:?}").contains("AIzaSy"));
    session.terminate().unwrap();
}

// ---- Provider Health through real sessions ---------------------------------------------

#[test]
fn health_follows_detection_and_real_sessions() {
    let codex = FakeInstall::new("codex", json!({}));
    let monitor = Arc::new(HealthMonitor::new());
    let registry = ProviderRegistry::with_specs(codex.env(), vec![catalog::codex_spec()]);
    registry.set_health(Arc::clone(&monitor));
    registry.detect_all();
    let id = ProviderId::new(ProviderId::CODEX);
    let health = monitor.get(&id).unwrap();
    assert_eq!(health.state, HealthState::Healthy);
    assert_eq!(health.version.as_deref(), Some("0.160.0"));

    let provider = ObservedProvider::new(
        Arc::new(CodexProvider::new(codex.env())),
        Arc::clone(&monitor),
    );
    let (session, rx) = start(&provider, codex.config(PermissionMode::Approve, None));
    assert_eq!(monitor.get(&id).unwrap().active_sessions, 1);
    turn(session.as_ref(), &rx, "hello");
    let health = monitor.get(&id).unwrap();
    assert_eq!(
        health.latency_samples, 1,
        "time to first output was observed"
    );
    assert!(health.latency_p50_ms.is_some());

    turn(session.as_ref(), &rx, "crash");
    turn(session.as_ref(), &rx, "fail");
    let health = monitor.get(&id).unwrap();
    assert_eq!(health.state, HealthState::Degraded);
    assert_eq!(health.recent_failures, 2);
    assert_eq!(
        health.capacity,
        CapacityState::Available,
        "failures are not rate limits"
    );

    session.terminate().unwrap();
    until(&rx, |e| matches!(e, AgentEvent::Exited { .. }));
    assert_eq!(monitor.get(&id).unwrap().active_sessions, 0);

    let gemini = FakeInstall::new("gemini", json!({}));
    let gemini_registry = ProviderRegistry::with_specs(gemini.env(), vec![catalog::gemini_spec()]);
    gemini_registry.set_health(Arc::clone(&monitor));
    gemini_registry.detect_all();
    let provider = ObservedProvider::new(
        Arc::new(GeminiProvider::new(gemini.env())),
        Arc::clone(&monitor),
    );
    let (session, rx) = start(&provider, gemini.config(PermissionMode::Approve, None));
    turn(session.as_ref(), &rx, "quota");
    let gemini_health = monitor
        .get(&ProviderId::new(ProviderId::GEMINI_CLI))
        .unwrap();
    assert_eq!(gemini_health.capacity, CapacityState::BackingOff);
    assert_eq!(
        gemini_health.backoff_until, None,
        "no retry time is invented"
    );
    turn(session.as_ref(), &rx, "hello");
    assert_eq!(
        monitor
            .get(&ProviderId::new(ProviderId::GEMINI_CLI))
            .unwrap()
            .capacity,
        CapacityState::Available,
        "a successful turn clears the reported limit"
    );
    session.terminate().unwrap();
}

#[test]
fn a_failed_start_is_recorded_and_requests_a_recheck() {
    let fake = FakeInstall::new(
        "codex",
        json!({"loginStatus": "Not logged in", "loginExit": 1}),
    );
    let monitor = Arc::new(HealthMonitor::new());
    let provider = ObservedProvider::new(
        Arc::new(CodexProvider::new(fake.env())),
        Arc::clone(&monitor),
    );
    let (tx, _rx) = mpsc::channel::<AgentEvent>();
    let result = provider.start_session(
        fake.config(PermissionMode::Approve, None),
        Box::new(move |e| {
            let _ = tx.send(e);
        }),
    );
    assert_eq!(result.err(), Some(ProviderError::NotAuthenticated));
    let id = ProviderId::new(ProviderId::CODEX);
    assert_eq!(monitor.get(&id).unwrap().active_sessions, 0);
    let (_, due) = monitor.evaluate_now();
    assert_eq!(due, [id]);
}
