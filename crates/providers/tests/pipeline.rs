//! End-to-end tests of detection and the Claude Code adapter against the fake provider
//! executable (`src/bin/fake_provider.rs`), which replays documented stream-JSON fixtures.
//! No real provider runs and no AI quota is used.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::ffi::OsString;
use std::path::Path;
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use kalcode_contracts::agent::{
    AgentEvent, AgentInput, AgentProvider, AgentSession, AuthState, DetectionState, ProviderError,
    SessionConfig,
};
use kalcode_contracts::permissions::PermissionMode;
use kalcode_contracts::threads::ThreadStatus;
use kalcode_providers::claude::session::SessionTimeouts;
use kalcode_providers::detect::detect;
use kalcode_providers::{ClaudeCodeProvider, DetectEnv, ProviderRegistry, catalog};
use serde_json::{Value, json};

const FAKE: &str = env!("CARGO_BIN_EXE_kalcode-fake-provider");
const WAIT: Duration = Duration::from_secs(20);

/// A folder holding the fake provider under `name`, configured by `config`.
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

    /// Detection environment: only the fake's folder on PATH, plus variables to prove
    /// sanitization (a foreign provider's key and KalCode-internal variables must not pass).
    fn env(&self) -> DetectEnv {
        let mut vars: Vec<(OsString, OsString)> = vec![
            ("PATH".into(), self.dir.path().into()),
            ("ANTHROPIC_API_KEY".into(), "test-anthropic-value".into()),
            ("OPENAI_API_KEY".into(), "test-openai-value".into()),
            ("KALCODE_DATA_DIR".into(), "/should/not/pass".into()),
            ("GITHUB_TOKEN".into(), "test-github-value".into()),
        ];
        // No HOME/USERPROFILE/APPDATA: the documented install folders under them could resolve
        // to a real provider install on the test machine.
        for name in ["SystemRoot", "TEMP", "TMP", "TMPDIR"] {
            if let Some(value) = std::env::var_os(name) {
                vars.push((name.into(), value));
            }
        }
        DetectEnv {
            vars,
            windows: cfg!(windows),
            probe_timeout: Some(Duration::from_secs(10)),
            // Homebrew's `/opt/homebrew/bin` and `/usr/local/bin` are searched under this empty
            // folder, so a real `codex` or `gemini` installed on the host can't leak in.
            system_root: Some(self.work.path().join("no-system-installs")),
        }
    }

    fn read_json(&self, file: &str) -> Value {
        let text = std::fs::read_to_string(self.dir.path().join(file)).expect(file);
        serde_json::from_str(&text).expect("json")
    }

    fn config(&self, mode: PermissionMode, resume: Option<&str>) -> SessionConfig {
        SessionConfig {
            thread_id: kalcode_contracts::ids::new_id(),
            workspace_id: kalcode_contracts::ids::new_id(),
            provider_account_id: None,
            working_directory: self.work.path().display().to_string(),
            model: Some("sonnet".into()),
            effort: None,
            permission_mode: mode,
            resume_session_id: resume.map(str::to_owned),
            secret_ref: None,
        }
    }
}

fn provider(fake: &FakeInstall) -> ClaudeCodeProvider {
    provider_with_ack(fake, Duration::from_secs(2))
}

#[test]
fn installation_registry_never_probes_the_standalone_account() {
    let fake = FakeInstall::new("claude", json!({"authExit": 0}));
    let registry = ProviderRegistry::installation_only(fake.env());
    let (statuses, _) = registry.detect_all();
    let claude = statuses
        .iter()
        .find(|s| s.id.as_str() == "claude-code")
        .expect("Claude");
    let detection = claude.detection.as_ref().expect("detection");
    assert_eq!(detection.state, DetectionState::Installed);
    assert_eq!(detection.auth, AuthState::Unknown);
    let runs = std::fs::read_to_string(fake.dir.path().join("runs.log")).expect("runs");
    let invocations: Vec<Value> = runs
        .lines()
        .map(|line| serde_json::from_str(line).expect("run"))
        .collect();
    assert_eq!(invocations.len(), 1);
    assert_eq!(invocations[0]["args"], json!(["--version"]));
}

#[cfg(any(windows, target_os = "macos"))]
#[test]
fn managed_claude_requires_an_account_and_holds_its_profile_until_session_cleanup() {
    let fake = FakeInstall::new("claude", json!({"version": "2.1.282 (Claude Code)"}));
    let storage = tempfile::tempdir().expect("storage");
    let storage_root = if cfg!(target_os = "macos") {
        storage.path().canonicalize().expect("canonical storage")
    } else {
        storage.path().to_path_buf()
    };
    #[cfg(any(windows, target_os = "macos"))]
    let guardian = kalcode_providers::guardian::GuardianRuntime::launch(
        std::path::Path::new(env!("CARGO_BIN_EXE_kalcode-provider-guardian")),
        &storage_root,
    )
    .expect("native provider guardian");
    #[cfg(any(windows, target_os = "macos"))]
    let profiles = kalcode_providers::managed::ManagedProfiles::for_data_dir_guarded(
        &storage_root,
        guardian.authority(),
        guardian.profile_generation(),
    )
    .expect("guarded profiles");
    #[cfg(not(any(windows, target_os = "macos")))]
    let profiles = kalcode_providers::managed::ManagedProfiles::new(storage_root.join("managed"))
        .expect("profiles");
    let adapter = provider(&fake).with_managed_profiles(profiles.clone());
    assert!(matches!(
        adapter.start_session(
            fake.config(PermissionMode::Plan, None),
            Box::new(|_: AgentEvent| {})
        ),
        Err(ProviderError::NotAuthenticated)
    ));
    let account = kalcode_contracts::ids::new_id();
    let mut config = fake.config(PermissionMode::Plan, None);
    config.provider_account_id = Some(account.clone());
    assert!(
        provider(&fake)
            .start_session(config.clone(), Box::new(|_: AgentEvent| {}))
            .is_err()
    );
    let (tx, rx) = mpsc::channel();
    let session = adapter
        .start_session(
            config,
            Box::new(move |event: AgentEvent| {
                let _ = tx.send(event);
            }),
        )
        .expect("managed session");
    session
        .send(AgentInput::Text {
            text: "fixture prompt".into(),
        })
        .expect("send to fake provider");
    let _ = until(&rx, |e| matches!(e, AgentEvent::SessionStarted { .. }));
    let names: Vec<String> = serde_json::from_str(
        &std::fs::read_to_string(fake.dir.path().join("last-env.json")).expect("env names"),
    )
    .expect("json");
    assert!(names.iter().any(|n| n == "CLAUDE_CONFIG_DIR"));
    assert!(!names.iter().any(|n| n == "ANTHROPIC_API_KEY"));
    assert!(
        profiles
            .acquire_sign_in_lease("claude-code", &account)
            .is_err()
    );
    session.terminate().expect("terminate");
    drop(session);
    let _lease = profiles
        .acquire_sign_in_lease("claude-code", &account)
        .expect("profile released");
}

#[cfg(any(windows, target_os = "macos"))]
#[test]
fn managed_claude_rejects_an_unreviewed_version_before_session_launch() {
    let fake = FakeInstall::new("claude", json!({"version": "2.2.0 (Claude Code)"}));
    let storage = tempfile::tempdir().expect("storage");
    let storage_root = if cfg!(target_os = "macos") {
        storage.path().canonicalize().expect("canonical storage")
    } else {
        storage.path().to_path_buf()
    };
    #[cfg(any(windows, target_os = "macos"))]
    let guardian = kalcode_providers::guardian::GuardianRuntime::launch(
        std::path::Path::new(env!("CARGO_BIN_EXE_kalcode-provider-guardian")),
        &storage_root,
    )
    .expect("native provider guardian");
    #[cfg(any(windows, target_os = "macos"))]
    let profiles = kalcode_providers::managed::ManagedProfiles::for_data_dir_guarded(
        &storage_root,
        guardian.authority(),
        guardian.profile_generation(),
    )
    .expect("guarded profiles");
    #[cfg(not(any(windows, target_os = "macos")))]
    let profiles = kalcode_providers::managed::ManagedProfiles::new(storage_root.join("managed"))
        .expect("profiles");
    let adapter = provider(&fake).with_managed_profiles(profiles);
    let mut config = fake.config(PermissionMode::Plan, None);
    config.provider_account_id = Some(kalcode_contracts::ids::new_id());

    let error = match adapter.start_session(config, Box::new(|_: AgentEvent| {})) {
        Ok(_) => panic!("an unreviewed managed Claude version must not launch"),
        Err(error) => error,
    };
    assert!(error.to_string().contains("certified Claude Code 2.1.282"));
    let runs = std::fs::read_to_string(fake.dir.path().join("runs.log")).expect("runs");
    assert!(
        !runs.lines().any(|line| line.contains("--input-format")),
        "the session process must not start: {runs}"
    );
}

#[cfg(all(not(windows), not(target_os = "macos")))]
#[test]
fn managed_claude_fails_closed_without_a_native_guardian() {
    let fake = FakeInstall::new("claude", json!({"version": "2.1.282 (Claude Code)"}));
    let storage = tempfile::tempdir().expect("storage");
    let profiles = kalcode_providers::managed::ManagedProfiles::new(storage.path().join("managed"))
        .expect("profiles");
    let adapter = provider(&fake).with_managed_profiles(profiles);
    let mut config = fake.config(PermissionMode::Plan, None);
    config.provider_account_id = Some(kalcode_contracts::ids::new_id());

    let error = match adapter.start_session(config, Box::new(|_: AgentEvent| {})) {
        Ok(_) => panic!("managed Claude must not launch without a native guardian"),
        Err(error) => error,
    };
    match error {
        ProviderError::Start(message) => {
            assert_eq!(message, "provider runtime guardian is not configured");
        }
        other => panic!("expected a provider start denial, got {other:?}"),
    }
    assert!(
        !fake.dir.path().join("runs.log").exists(),
        "guardian denial must happen before provider detection or launch"
    );
}

fn provider_with_ack(fake: &FakeInstall, interrupt_ack: Duration) -> ClaudeCodeProvider {
    ClaudeCodeProvider::new(fake.env()).with_timeouts(SessionTimeouts {
        interrupt_ack,
        terminate_grace: Duration::from_millis(500),
    })
}

fn start(
    fake: &FakeInstall,
    mode: PermissionMode,
) -> (Box<dyn AgentSession>, Receiver<AgentEvent>) {
    start_with(provider(fake), fake, mode)
}

fn start_with(
    provider: ClaudeCodeProvider,
    fake: &FakeInstall,
    mode: PermissionMode,
) -> (Box<dyn AgentSession>, Receiver<AgentEvent>) {
    let (tx, rx) = mpsc::channel();
    let session = provider
        .start_session(
            fake.config(mode, None),
            Box::new(move |event: AgentEvent| {
                let _ = tx.send(event);
            }),
        )
        .expect("session starts");
    (session, rx)
}

/// Collects events until `done` matches one (inclusive).
fn until(rx: &Receiver<AgentEvent>, done: impl Fn(&AgentEvent) -> bool) -> Vec<AgentEvent> {
    let deadline = Instant::now() + WAIT;
    let mut events = Vec::new();
    loop {
        let event = rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap_or_else(|_| panic!("timed out; got {events:#?}"));
        let stop = done(&event);
        events.push(event);
        if stop {
            return events;
        }
    }
}

fn turn_done(e: &AgentEvent) -> bool {
    matches!(e, AgentEvent::TurnCompleted { .. })
}

fn exited(e: &AgentEvent) -> bool {
    matches!(e, AgentEvent::Exited { .. })
}

fn text(t: &str) -> AgentInput {
    AgentInput::Text { text: t.into() }
}

#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    use std::os::windows::process::CommandExt;

    let mut command = std::process::Command::new("tasklist");
    command.creation_flags(0x0800_0000);
    let out = command
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
        .expect("tasklist");
    String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
}

#[cfg(not(windows))]
fn process_alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .is_ok_and(|s| s.success())
}

fn wait_for(condition: impl Fn() -> bool) -> bool {
    let deadline = Instant::now() + WAIT;
    while Instant::now() < deadline {
        if condition() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

// ---------------------------------------------------------------- detection

#[test]
fn detects_an_installed_signed_in_claude_on_a_temp_path() {
    let fake = FakeInstall::new(
        "claude",
        json!({"version": "2.1.300 (Claude Code)", "authExit": 0}),
    );
    let result = detect(&catalog::claude_spec(), &fake.env());
    let d = &result.detection;
    assert_eq!(d.state, DetectionState::Installed);
    assert_eq!(d.version.as_deref(), Some("2.1.300"));
    assert_eq!(d.minimum_version.as_deref(), Some("2.1.259"));
    assert_eq!(d.auth, AuthState::Authenticated);
    assert!(
        d.display_path
            .as_deref()
            .is_some_and(|p| p.contains("claude"))
    );
    assert_eq!(
        result.executable.as_deref().and_then(Path::parent),
        Some(fake.dir.path())
    );
}

#[test]
fn reports_signed_out_outdated_and_broken_installs() {
    let signed_out = FakeInstall::new("claude", json!({"authExit": 1}));
    assert_eq!(
        detect(&catalog::claude_spec(), &signed_out.env())
            .detection
            .auth,
        AuthState::NotAuthenticated
    );

    let old = FakeInstall::new("claude", json!({"version": "2.1.100 (Claude Code)"}));
    let d = detect(&catalog::claude_spec(), &old.env()).detection;
    assert_eq!(d.state, DetectionState::Outdated);
    assert!(d.message.as_deref().is_some_and(|m| m.contains("2.1.259")));

    let garbage = FakeInstall::new("claude", json!({"version": "who knows"}));
    let r = detect(&catalog::claude_spec(), &garbage.env());
    assert_eq!(r.detection.state, DetectionState::Error);
    assert_eq!(r.error_code, Some("version_unrecognized"));

    let failing = FakeInstall::new("claude", json!({"versionExit": 2}));
    let r = detect(&catalog::claude_spec(), &failing.env());
    assert_eq!(r.detection.state, DetectionState::Error);
    assert_eq!(r.error_code, Some("version_exit_status"));
}

#[test]
fn a_hanging_version_command_times_out() {
    let fake = FakeInstall::new("claude", json!({"versionDelayMs": 30000}));
    let mut env = fake.env();
    env.probe_timeout = Some(Duration::from_millis(700));
    let started = Instant::now();
    let r = detect(&catalog::claude_spec(), &env);
    assert_eq!(r.detection.state, DetectionState::Error);
    assert_eq!(r.error_code, Some("version_timeout"));
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "{:?}",
        started.elapsed()
    );
}

#[test]
fn codex_sign_in_comes_from_its_documented_status_command() {
    let fake = FakeInstall::new("codex", json!({"version": "codex-cli 0.155.1"}));
    let d = detect(&catalog::codex_spec(), &fake.env()).detection;
    assert_eq!(d.state, DetectionState::Installed);
    assert_eq!(d.version.as_deref(), Some("0.155.1"));
    assert_eq!(d.auth, AuthState::Authenticated);

    let odd = FakeInstall::new(
        "codex",
        json!({"loginStatus": "Something new", "loginExit": 0}),
    );
    assert_eq!(
        detect(&catalog::codex_spec(), &odd.env()).detection.auth,
        AuthState::Unknown
    );
}

#[test]
fn gemini_sign_in_is_unknown_and_missing_tools_are_not_installed() {
    let fake = FakeInstall::new("gemini", json!({"version": "0.12.0"}));
    let d = detect(&catalog::gemini_spec(), &fake.env()).detection;
    assert_eq!(d.state, DetectionState::Installed);
    assert_eq!(d.auth, AuthState::Unknown);
    assert_eq!(
        detect(&catalog::codex_spec(), &fake.env()).detection.state,
        DetectionState::NotInstalled
    );
}

#[test]
fn registry_isolates_a_hanging_provider_from_the_others() {
    // One folder holds a healthy claude and a codex whose version check hangs.
    let fake = FakeInstall::new(
        "claude",
        json!({"version": "2.1.300 (Claude Code)", "versionDelayMs": 0}),
    );
    let hanging = FakeInstall::new("codex", json!({"versionDelayMs": 30000}));
    let sep = if cfg!(windows) { ";" } else { ":" };
    let mut env = fake.env();
    env.vars.retain(|(k, _)| k != "PATH");
    env.vars.push((
        "PATH".into(),
        format!(
            "{}{sep}{}",
            fake.dir.path().display(),
            hanging.dir.path().display()
        )
        .into(),
    ));
    env.probe_timeout = Some(Duration::from_secs(4));
    let registry = ProviderRegistry::new(env);
    let (statuses, events) = registry.detect_all();
    let state = |id: &str| {
        statuses
            .iter()
            .find(|s| s.id.as_str() == id)
            .and_then(|s| s.detection.as_ref())
            .map(|d| d.state)
    };
    assert_eq!(state("claude-code"), Some(DetectionState::Installed));
    assert_eq!(state("codex"), Some(DetectionState::Error));
    assert_eq!(state("gemini-cli"), Some(DetectionState::NotInstalled));
    assert!(events.iter().any(|e| e.type_name() == "provider.error"));
    assert_eq!(
        registry.usable(),
        vec![kalcode_contracts::agent::ProviderId::new("claude-code")]
    );
}

// ---------------------------------------------------------------- sessions

#[test]
fn text_turn_flows_from_process_to_normalized_events() {
    let fake = FakeInstall::new("claude", json!({}));
    let (session, rx) = start(&fake, PermissionMode::Approve);
    let id = session.provider_session_id().expect("id assigned up front");
    session
        .send(text("How does the build look?"))
        .expect("send");
    let events = until(&rx, turn_done);

    assert_eq!(
        events[0],
        AgentEvent::Status {
            status: ThreadStatus::Starting,
            detail: None
        }
    );
    assert!(events.contains(&AgentEvent::SessionStarted {
        provider_session_id: id.clone(),
        model: Some("claude-sonnet-5".into())
    }));
    let deltas: String = events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::MessageDelta { message_id, text } if message_id == "msg_01TextReply" => {
                Some(text.as_str())
            }
            _ => None,
        })
        .collect();
    assert_eq!(deltas, "The project builds cleanly.");
    assert!(events.contains(&AgentEvent::MessageCompleted {
        message_id: "msg_01TextReply".into(),
        text: "The project builds cleanly.".into()
    }));
    assert!(events.iter().any(|e| matches!(e, AgentEvent::Usage { usage } if usage.output_tokens == Some(6) && usage.cost_usd_micros == Some(420))));
    assert_eq!(events.last(), Some(&AgentEvent::TurnCompleted { ok: true }));

    // What the process was started with.
    let args: Vec<String> = serde_json::from_value(fake.read_json("last-args.json")).expect("args");
    let after = |flag: &str| {
        args.iter()
            .position(|a| a == flag)
            .map(|i| args[i + 1].clone())
    };
    assert_eq!(args[0], "-p");
    assert_eq!(after("--session-id"), Some(id));
    assert_eq!(after("--permission-mode").as_deref(), Some("default"));
    assert_eq!(after("--permission-prompts").as_deref(), Some("none"));
    assert_eq!(after("--model").as_deref(), Some("sonnet"));
    let env: Vec<String> = serde_json::from_value(fake.read_json("last-env.json")).expect("env");
    assert!(env.iter().any(|n| n == "ANTHROPIC_API_KEY"), "{env:?}");
    for leaked in ["OPENAI_API_KEY", "KALCODE_DATA_DIR", "GITHUB_TOKEN"] {
        assert!(
            !env.iter().any(|n| n == leaked),
            "{leaked} reached the provider: {env:?}"
        );
    }
    let cwd = std::fs::read_to_string(fake.dir.path().join("last-cwd.txt")).expect("cwd");
    assert_eq!(
        std::fs::canonicalize(cwd).expect("canon"),
        std::fs::canonicalize(fake.work.path()).expect("canon")
    );

    session.terminate().expect("terminate");
    let tail = until(&rx, exited);
    assert!(
        tail.contains(&AgentEvent::Exited { exit_code: Some(0) }),
        "{tail:#?}"
    );
    assert!(
        !tail.iter().any(|e| matches!(e, AgentEvent::Error { .. })),
        "{tail:#?}"
    );
}

#[test]
fn tool_calls_denials_and_retries_are_normalized() {
    let fake = FakeInstall::new("claude", json!({}));
    let (session, rx) = start(&fake, PermissionMode::Approve);
    session.send(text("use tools")).expect("send");
    let events = until(&rx, turn_done);
    assert!(events.contains(&AgentEvent::ToolRequested {
        tool_call_id: "toolu_01GitStatus".into(),
        tool: "Bash".into(),
        summary: "Run git status".into()
    }));
    assert!(events.contains(&AgentEvent::Status {
        status: ThreadStatus::RunningCommand,
        detail: Some("Run git status".into())
    }));
    assert!(events.contains(&AgentEvent::ToolCompleted {
        tool_call_id: "toolu_01GitStatus".into(),
        ok: true,
        summary: None
    }));
    assert!(
        events
            .iter()
            .any(|e| matches!(e, AgentEvent::Error { code, .. } if code == "permission_denied"))
    );
    assert!(events.contains(&AgentEvent::ToolCompleted {
        tool_call_id: "toolu_02WriteNotes".into(),
        ok: false,
        summary: Some("Denied by the permission mode".into())
    }));
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, AgentEvent::FileChanged { .. }))
    );
    assert!(events.iter().any(|e| matches!(
        e,
        AgentEvent::Status {
            status: ThreadStatus::Recovering,
            ..
        }
    )));
    assert_eq!(events.last(), Some(&AgentEvent::TurnCompleted { ok: true }));
}

#[test]
fn malformed_and_oversized_lines_never_break_the_session() {
    let fake = FakeInstall::new("claude", json!({"session": "flood"}));
    let (session, rx) = start(&fake, PermissionMode::Approve);
    session.send(text("malformed please")).expect("send");
    let events = until(&rx, turn_done);
    let protocol_errors = events
        .iter()
        .filter(|e| matches!(e, AgentEvent::Error { code, .. } if code == "protocol_error"))
        .count();
    // 1 oversized line + 5 malformed lines (unknown types are ignored, not errors).
    assert_eq!(protocol_errors, 6, "{events:#?}");
    assert!(events.contains(&AgentEvent::MessageCompleted {
        message_id: "msg_05Mixed".into(),
        text: "Still here.".into()
    }));
    assert_eq!(events.last(), Some(&AgentEvent::TurnCompleted { ok: true }));
    // The session still works after all that.
    session.send(text("again")).expect("send");
    let events = until(&rx, turn_done);
    assert_eq!(events.last(), Some(&AgentEvent::TurnCompleted { ok: true }));
}

#[test]
fn interrupt_uses_the_control_protocol_when_advertised() {
    let fake = FakeInstall::new("claude", json!({}));
    // A generous acknowledgement window: under a loaded test machine the fake can take longer
    // than the default 2 s to answer, and the stop fallback would then (correctly) take over.
    let provider = provider_with_ack(&fake, Duration::from_secs(15));
    let (session, rx) = start_with(provider, &fake, PermissionMode::Approve);
    session.send(text("hello")).expect("send");
    until(&rx, turn_done);
    session.interrupt().expect("interrupt");
    let events = until(&rx, turn_done);
    assert!(events.contains(&AgentEvent::Status {
        status: ThreadStatus::Interrupted,
        detail: None
    }));
    assert_eq!(
        events.last(),
        Some(&AgentEvent::TurnCompleted { ok: false })
    );
    // Still alive and usable.
    session.send(text("continue")).expect("send");
    assert_eq!(
        until(&rx, turn_done).last(),
        Some(&AgentEvent::TurnCompleted { ok: true })
    );
}

#[test]
fn an_unconfirmed_interrupt_stops_the_process_instead() {
    let fake = FakeInstall::new("claude", json!({"session": "no_interrupt_ack"}));
    let (session, rx) = start(&fake, PermissionMode::Approve);
    session.send(text("hello")).expect("send");
    until(&rx, turn_done);
    session.interrupt().expect("interrupt");
    let events = until(&rx, exited);
    assert!(
        events.iter().any(
            |e| matches!(e, AgentEvent::Error { code, .. } if code == "interrupt_unconfirmed")
        )
    );
    assert!(events.contains(&AgentEvent::Status {
        status: ThreadStatus::Completed,
        detail: None
    }));
    assert_eq!(session.send(text("more")), Err(ProviderError::SessionEnded));
}

#[test]
fn a_crash_is_reported_with_its_exit_code() {
    let fake = FakeInstall::new("claude", json!({"session": "crash_after_init"}));
    let (session, rx) = start(&fake, PermissionMode::Approve);
    session.send(text("hello")).expect("send");
    let events = until(&rx, exited);
    assert!(events.iter().any(|e| matches!(e, AgentEvent::Error { code, recoverable: true, .. } if code == "process_exited")));
    assert!(events.contains(&AgentEvent::Status {
        status: ThreadStatus::Failed,
        detail: None
    }));
    assert_eq!(
        events.last(),
        Some(&AgentEvent::Exited { exit_code: Some(3) })
    );
    // Nothing from stderr (which held a credential-shaped string) reaches the events.
    for event in &events {
        let json = serde_json::to_string(event).expect("json");
        assert!(!json.contains("sk-ant-api03"), "{json}");
    }
}

#[test]
fn an_unexpected_host_permission_request_fails_closed() {
    let fake = FakeInstall::new("claude", json!({"session": "host_request"}));
    let (session, rx) = start(&fake, PermissionMode::Approve);
    session.send(text("hello")).expect("send");
    let events = until(&rx, exited);
    assert!(events.iter().any(|e| matches!(e, AgentEvent::Error { code, recoverable: false, .. } if code == "unexpected_host_request")));
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, AgentEvent::ToolCompleted { ok: true, .. }))
    );
    assert_eq!(
        session.respond_to_approval(
            "req_1",
            kalcode_contracts::permissions::ApprovalDecision::ApproveOnce
        ),
        Err(ProviderError::Unsupported)
    );
}

#[test]
fn terminate_kills_a_hung_process_and_its_children() {
    let fake = FakeInstall::new("claude", json!({"session": "hang"}));
    let (session, rx) = start(&fake, PermissionMode::Approve);
    let pid_file = fake.dir.path().join("grandchild.pid");
    assert!(wait_for(|| pid_file.exists()), "grandchild never started");
    let grandchild: u32 = std::fs::read_to_string(&pid_file)
        .expect("pid")
        .trim()
        .parse()
        .expect("pid");
    assert!(process_alive(grandchild));
    let started = Instant::now();
    session.terminate().expect("terminate");
    let events = until(&rx, exited);
    assert!(
        started.elapsed() < Duration::from_secs(15),
        "{:?}",
        started.elapsed()
    );
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, AgentEvent::Error { code, .. } if code == "process_exited"))
    );
    assert!(
        wait_for(|| !process_alive(grandchild)),
        "grandchild {grandchild} survived"
    );
}

#[test]
fn dropping_a_session_kills_its_process_tree() {
    let fake = FakeInstall::new("claude", json!({"session": "hang"}));
    let (session, rx) = start(&fake, PermissionMode::Approve);
    let pid_file = fake.dir.path().join("grandchild.pid");
    assert!(wait_for(|| pid_file.exists()), "grandchild never started");
    let grandchild: u32 = std::fs::read_to_string(&pid_file)
        .expect("pid")
        .trim()
        .parse()
        .expect("pid");
    drop(session);
    until(&rx, exited);
    assert!(
        wait_for(|| !process_alive(grandchild)),
        "grandchild {grandchild} survived"
    );
}

#[test]
fn one_session_crashing_does_not_affect_another() {
    let healthy = FakeInstall::new("claude", json!({"turnDelayMs": 300}));
    let crashing = FakeInstall::new("claude", json!({"session": "crash_after_init"}));
    let (good, good_rx) = start(&healthy, PermissionMode::Approve);
    let (bad, bad_rx) = start(&crashing, PermissionMode::Approve);
    good.send(text("hello")).expect("send");
    bad.send(text("hello")).expect("send");
    let bad_events = until(&bad_rx, exited);
    assert_eq!(
        bad_events.last(),
        Some(&AgentEvent::Exited { exit_code: Some(3) })
    );
    let good_events = until(&good_rx, turn_done);
    assert_eq!(
        good_events.last(),
        Some(&AgentEvent::TurnCompleted { ok: true })
    );
    good.send(text("still there?"))
        .expect("healthy session keeps working");
    assert_eq!(
        until(&good_rx, turn_done).last(),
        Some(&AgentEvent::TurnCompleted { ok: true })
    );
}

#[test]
fn resume_passes_the_session_id_and_plan_mode_is_restricted() {
    let fake = FakeInstall::new("claude", json!({}));
    let resume_id = "5d7a3c0e-8a1b-4c7e-9f00-1234567890ab";
    let (tx, rx) = mpsc::channel();
    let session = provider(&fake)
        .start_session(
            fake.config(PermissionMode::Plan, Some(resume_id)),
            Box::new(move |e: AgentEvent| {
                let _ = tx.send(e);
            }),
        )
        .expect("start");
    session.send(text("hello")).expect("send");
    let events = until(&rx, turn_done);
    assert!(events.contains(&AgentEvent::SessionStarted {
        provider_session_id: resume_id.into(),
        model: Some("claude-sonnet-5".into())
    }));
    let args: Vec<String> = serde_json::from_value(fake.read_json("last-args.json")).expect("args");
    assert!(args.windows(2).any(|w| w == ["--resume", resume_id]));
    assert!(args.iter().any(|a| a == "--restricted"));
    assert!(args.windows(2).any(|w| w == ["--permission-mode", "plan"]));
}

#[test]
fn sessions_refuse_to_start_when_the_provider_is_unusable() {
    let missing = FakeInstall::new("not-claude", json!({}));
    let sink = || Box::new(|_: AgentEvent| {}) as Box<dyn kalcode_contracts::agent::AgentEventSink>;
    assert_eq!(
        provider(&missing)
            .start_session(missing.config(PermissionMode::Approve, None), sink())
            .err(),
        Some(ProviderError::NotInstalled)
    );
    let signed_out = FakeInstall::new("claude", json!({"authExit": 1}));
    assert_eq!(
        provider(&signed_out)
            .start_session(signed_out.config(PermissionMode::Approve, None), sink())
            .err(),
        Some(ProviderError::NotAuthenticated)
    );
    let fake = FakeInstall::new("claude", json!({}));
    let mut config = fake.config(PermissionMode::Approve, None);
    config.working_directory = "relative/dir".into();
    assert!(matches!(
        provider(&fake).start_session(config, sink()).err(),
        Some(ProviderError::Start(_))
    ));
    let mut config = fake.config(PermissionMode::Approve, None);
    config.model = Some("--dangerously-skip-permissions".into());
    assert!(matches!(
        provider(&fake).start_session(config, sink()).err(),
        Some(ProviderError::Start(_))
    ));
    assert!(
        !fake.dir.path().join("last-args.json").exists(),
        "nothing may start"
    );
}

// ---------------------------------------------------------------- real provider (opt-in)

/// Detects the real `claude` on this machine. Runs only `claude --version` and
/// `claude auth status` (no prompt, no quota). Opt in with `cargo test -- --ignored real_`.
#[test]
#[ignore = "uses the real Claude Code install on this machine"]
fn real_claude_detection() {
    let result = detect(&catalog::claude_spec(), &DetectEnv::from_process());
    eprintln!(
        "{:?} {:?} {:?}",
        result.detection.state, result.detection.version, result.detection.auth
    );
    assert_eq!(result.detection.state, DetectionState::Installed);
}

/// Sends one real prompt through the adapter. CONSUMES THE OWNER'S AI QUOTA — run only with the
/// owner's explicit approval: `KALCODE_REAL_PROVIDER_SMOKE=1 cargo test -- --ignored real_claude_session`.
#[test]
#[ignore = "consumes AI quota; requires the owner's explicit approval"]
fn real_claude_session_smoke() {
    if std::env::var_os("KALCODE_REAL_PROVIDER_SMOKE").is_none() {
        eprintln!("skipped: set KALCODE_REAL_PROVIDER_SMOKE=1 to confirm quota use");
        return;
    }
    let work = tempfile::tempdir().expect("workdir");
    let (tx, rx) = mpsc::channel();
    let session = ClaudeCodeProvider::new(DetectEnv::from_process())
        .start_session(
            SessionConfig {
                thread_id: kalcode_contracts::ids::new_id(),
                workspace_id: kalcode_contracts::ids::new_id(),
                provider_account_id: None,
                working_directory: work.path().display().to_string(),
                model: None,
                effort: None,
                permission_mode: PermissionMode::Plan,
                resume_session_id: None,
                secret_ref: None,
            },
            Box::new(move |e: AgentEvent| {
                let _ = tx.send(e);
            }),
        )
        .expect("start");
    session
        .send(text("Reply with the single word: ready"))
        .expect("send");
    let events = until(&rx, turn_done);
    assert_eq!(events.last(), Some(&AgentEvent::TurnCompleted { ok: true }));
    session.terminate().expect("terminate");
}
