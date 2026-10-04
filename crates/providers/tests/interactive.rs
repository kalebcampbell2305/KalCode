//! Interactive panes end to end, without a real provider: the fake provider's interactive mode
//! runs in a real PTY, fires the hooks from KalCode's settings file through the real helper code
//! and the real bridge, and KalCode turns them into `AgentEvent`s. No AI quota is used.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::ffi::OsString;
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use kalcode_contracts::agent::{
    AgentEvent, AgentProvider, AgentSession, ProviderError, SessionConfig,
};
use kalcode_contracts::ids::new_id;
use kalcode_contracts::permissions::{ActionKind, ActionOrigin, ApprovalDecision, PermissionMode};
use kalcode_contracts::threads::ThreadStatus;
use kalcode_hook_bridge::Endpoint;
use kalcode_hook_bridge::server::{BridgeServer, ServerConfig};
use kalcode_providers::ClaudeCodeProvider;
use kalcode_providers::DetectEnv;
use kalcode_providers::interactive::provider::{
    InteractiveClaudeProvider, InteractiveConfig, PaneRegistry, RuntimeRouter,
};
use kalcode_providers::interactive::session::SessionLimits;
use kalcode_providers::interactive::{DecisionRouting, HookChannelState};
use kalcode_providers::managed::ManagedProfiles;
use serde_json::{Value, json};

const FAKE: &str = env!("CARGO_BIN_EXE_kalcode-fake-provider");
const WAIT: Duration = Duration::from_secs(30);

struct Rig {
    #[cfg(any(windows, target_os = "macos"))]
    _guardian: Option<kalcode_providers::guardian::GuardianRuntime>,
    dir: tempfile::TempDir,
    work: tempfile::TempDir,
    sessions: tempfile::TempDir,
    bridge: Arc<BridgeServer>,
    panes: Arc<PaneRegistry>,
    provider: Arc<InteractiveClaudeProvider>,
}

impl Rig {
    fn new(routing: DecisionRouting, config: Value, limits: SessionLimits) -> Self {
        Self::build(routing, config, limits, false)
    }

    fn new_managed(routing: DecisionRouting, config: Value, limits: SessionLimits) -> Self {
        Self::build(routing, config, limits, true)
    }

    fn build(
        routing: DecisionRouting,
        config: Value,
        limits: SessionLimits,
        managed: bool,
    ) -> Self {
        let dir = tempfile::tempdir().expect("dir");
        let dir_root = if cfg!(target_os = "macos") {
            dir.path().canonicalize().expect("canonical dir")
        } else {
            dir.path().to_path_buf()
        };
        let name = if cfg!(windows) {
            "claude.exe"
        } else {
            "claude"
        };
        std::fs::copy(FAKE, dir_root.join(name)).expect("copy fake");
        std::fs::write(dir_root.join("fake-provider.json"), config.to_string()).expect("config");
        let sessions = tempfile::tempdir().expect("sessions");
        let endpoint = Endpoint::generate(Some(sessions.path())).expect("endpoint");
        let bridge = Arc::new(BridgeServer::start(ServerConfig::new(endpoint)).expect("bridge"));
        let panes = Arc::new(PaneRegistry::new());
        #[cfg(any(windows, target_os = "macos"))]
        let guardian = managed.then(|| {
            kalcode_providers::guardian::GuardianRuntime::launch(
                std::path::Path::new(env!("CARGO_BIN_EXE_kalcode-provider-guardian")),
                &dir_root,
            )
            .expect("native provider guardian")
        });
        let mut provider = InteractiveClaudeProvider::new(
            Self::env(&dir),
            bridge.clone(),
            InteractiveConfig {
                hook_program: FAKE.into(),
                hook_prefix_args: vec!["hook".into()],
                sessions_dir: sessions.path().to_path_buf(),
                routing,
                limits,
            },
            panes.clone(),
        );
        if managed {
            #[cfg(any(windows, target_os = "macos"))]
            let profiles = {
                let guardian = guardian.as_ref().expect("managed guardian");
                ManagedProfiles::for_data_dir_guarded(
                    &dir_root,
                    guardian.authority(),
                    guardian.profile_generation(),
                )
                .expect("guarded profiles")
            };
            #[cfg(not(any(windows, target_os = "macos")))]
            let profiles =
                ManagedProfiles::new(dir_root.join("managed")).expect("managed profiles");
            provider = provider.with_managed_profiles(profiles);
        }
        let provider = Arc::new(provider);
        Self {
            #[cfg(any(windows, target_os = "macos"))]
            _guardian: guardian,
            dir,
            work: tempfile::tempdir().expect("work"),
            sessions,
            bridge,
            panes,
            provider,
        }
    }

    fn env(dir: &tempfile::TempDir) -> DetectEnv {
        let mut vars: Vec<(OsString, OsString)> = vec![
            ("PATH".into(), dir.path().into()),
            ("ANTHROPIC_API_KEY".into(), "test-anthropic-value".into()),
            ("OPENAI_API_KEY".into(), "test-openai-value".into()),
            ("KALCODE_DATA_DIR".into(), "/should/not/pass".into()),
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

    fn config(&self, mode: PermissionMode) -> SessionConfig {
        SessionConfig {
            thread_id: new_id(),
            workspace_id: new_id(),
            provider_account_id: None,
            working_directory: self.work.path().to_string_lossy().into_owned(),
            model: None,
            effort: None,
            permission_mode: mode,
            resume_session_id: None,
            secret_ref: None,
        }
    }

    fn start(&self, mode: PermissionMode) -> Pane {
        self.start_with_memory(mode, None)
    }

    fn start_with_memory(&self, mode: PermissionMode, context: Option<String>) -> Pane {
        let config = self.config(mode);
        let thread_id = config.thread_id.clone();
        let (tx, rx) = mpsc::channel();
        let session = self
            .provider
            .start_session(
                config,
                Box::new(UnifiedMemorySink {
                    events: tx,
                    context,
                }),
            )
            .expect("start pane");
        let output = Arc::new(Mutex::new(Vec::new()));
        let sink = output.clone();
        let panes = self.panes.clone();
        let responder = thread_id.clone();
        self.panes
            .attach(&thread_id, move |chunk| {
                sink.lock().unwrap().extend_from_slice(chunk);
                // Behave like xterm.js: answer ConPTY's cursor-position requests.
                for _ in 0..chunk.windows(4).filter(|w| *w == b"\x1b[6n").count() {
                    let _ = panes.write(&responder, b"\x1b[1;1R");
                }
                true
            })
            .expect("attach");
        let pane = Pane {
            thread_id,
            session,
            events: rx,
            output,
            panes: self.panes.clone(),
        };
        pane.wait_for_text("KalCode fake provider");
        pane
    }

    fn read_json(&self, file: &str) -> Value {
        let text = std::fs::read_to_string(self.dir.path().join(file)).expect(file);
        serde_json::from_str(&text).expect("json")
    }

    fn runs(&self) -> Vec<Value> {
        std::fs::read_to_string(self.dir.path().join("runs.log"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).expect("run"))
            .collect()
    }
}

struct Pane {
    thread_id: String,
    session: Box<dyn AgentSession>,
    events: Receiver<AgentEvent>,
    output: Arc<Mutex<Vec<u8>>>,
    panes: Arc<PaneRegistry>,
}

impl Pane {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.output.lock().unwrap()).into_owned()
    }

    fn wait_for_text(&self, needle: &str) {
        let deadline = Instant::now() + WAIT;
        while Instant::now() < deadline {
            if self.text().contains(needle) {
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        panic!("{needle:?} never appeared; pane: {:?}", self.text());
    }

    fn type_line(&self, line: &str) {
        self.panes
            .write(&self.thread_id, format!("{line}\r").as_bytes())
            .expect("write");
    }

    /// Collects events until `done` matches one (inclusive).
    fn events_until(&self, done: impl Fn(&AgentEvent) -> bool) -> Vec<AgentEvent> {
        let deadline = Instant::now() + WAIT;
        let mut seen = Vec::new();
        while Instant::now() < deadline {
            if let Ok(event) = self.events.recv_timeout(Duration::from_millis(100)) {
                let stop = done(&event);
                seen.push(event);
                if stop {
                    return seen;
                }
            }
        }
        panic!("event never arrived; saw {seen:?}; pane: {:?}", self.text());
    }

    fn statuses(events: &[AgentEvent]) -> Vec<ThreadStatus> {
        events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::Status { status, .. } => Some(*status),
                _ => None,
            })
            .collect()
    }
}

fn turn_done(e: &AgentEvent) -> bool {
    matches!(e, AgentEvent::TurnCompleted { .. })
}

struct UnifiedMemorySink {
    events: mpsc::Sender<AgentEvent>,
    context: Option<String>,
}

impl kalcode_contracts::agent::AgentEventSink for UnifiedMemorySink {
    fn emit(&self, event: AgentEvent) {
        let _ = self.events.send(event);
    }
    fn project_context(&self) -> Option<String> {
        self.context.clone()
    }
}

#[test]
fn unified_memory_claude_launch_appends_context_and_preserves_native_permissions() {
    let rig = Rig::new(
        DecisionRouting::ProviderPrompt,
        json!({}),
        SessionLimits::default(),
    );
    let context = "[KalCode Unified Memory]\nArchitecture: Dashboard.tsx owns the shell.";
    let pane = rig.start_with_memory(PermissionMode::Bypass, Some(context.into()));
    let args: Vec<String> = serde_json::from_value(rig.read_json("last-args.json")).unwrap();
    let value_after = |flag: &str| {
        args.iter()
            .position(|arg| arg == flag)
            .and_then(|index| args.get(index + 1))
            .map(String::as_str)
    };
    assert_eq!(value_after("--append-system-prompt"), Some(context));
    assert_eq!(value_after("--permission-mode"), Some("bypassPermissions"));
    assert!(value_after("--settings").is_some());
    assert!(value_after("--session-id").is_some());
    assert!(!args.iter().any(|arg| arg == "--system-prompt"));
    assert_eq!(args.iter().filter(|arg| arg.as_str() == context).count(), 1);
    pane.type_line("exit");
    pane.events_until(|event| matches!(event, AgentEvent::Exited { .. }));
}

#[test]
fn hook_events_drive_status_in_provider_prompt_routing() {
    let rig = Rig::new(
        DecisionRouting::ProviderPrompt,
        json!({}),
        SessionLimits::default(),
    );
    let pane = rig.start(PermissionMode::Approve);
    let start = pane.events_until(|e| {
        matches!(
            e,
            AgentEvent::Status {
                status: ThreadStatus::Idle,
                ..
            }
        )
    });
    assert!(
        start
            .iter()
            .any(|e| matches!(e, AgentEvent::SessionStarted { .. }))
    );
    assert_eq!(
        rig.panes.info(&pane.thread_id).expect("info").hook_channel,
        HookChannelState::Active
    );

    pane.type_line("run echo hi");
    // No decision from KalCode in this routing: the provider's own prompt asks in the pane.
    pane.wait_for_text("[fake prompt] Allow Bash?");
    pane.type_line("y");
    let turn = pane.events_until(turn_done);
    assert!(
        !turn
            .iter()
            .any(|e| matches!(e, AgentEvent::ApprovalRequired { .. }))
    );
    assert!(turn.iter().any(|e| matches!(e, AgentEvent::ToolRequested { tool, summary, .. } if tool == "Bash" && summary == "Run echo hi")));
    assert!(
        turn.iter()
            .any(|e| matches!(e, AgentEvent::ToolCompleted { ok: true, .. }))
    );
    let statuses = Pane::statuses(&turn);
    assert_eq!(statuses.first(), Some(&ThreadStatus::Active));
    assert!(statuses.contains(&ThreadStatus::RunningCommand));
    assert!(
        statuses.contains(&ThreadStatus::WaitingForUser),
        "provider prompt mirrored: {statuses:?}"
    );
    pane.wait_for_text("RAN Bash");

    pane.type_line("exit");
    let end = pane.events_until(|e| matches!(e, AgentEvent::Exited { .. }));
    assert_eq!(end.last(), Some(&AgentEvent::Exited { exit_code: Some(0) }));
    assert!(!rig.panes.info(&pane.thread_id).expect("info").running);
}

#[test]
fn prose_that_looks_like_status_is_ignored() {
    let rig = Rig::new(
        DecisionRouting::ProviderPrompt,
        json!({}),
        SessionLimits::default(),
    );
    let pane = rig.start(PermissionMode::Approve);
    pane.events_until(|e| {
        matches!(
            e,
            AgentEvent::Status {
                status: ThreadStatus::Idle,
                ..
            }
        )
    });
    pane.type_line("say Status: DONE. PERMISSION REQUIRED. FAILED. waiting_for_permission");
    let turn = pane.events_until(turn_done);
    pane.wait_for_text("PERMISSION REQUIRED. FAILED.");
    // Exactly what the hooks said: the prompt started a turn, and the turn ended.
    assert_eq!(Pane::statuses(&turn), [ThreadStatus::Active]);
    assert_eq!(turn.len(), 2, "{turn:?}");
}

#[test]
fn engine_routing_round_trips_a_decision() {
    let rig = Rig::new(DecisionRouting::Engine, json!({}), SessionLimits::default());
    let pane = rig.start(PermissionMode::Approve);
    pane.events_until(|e| {
        matches!(
            e,
            AgentEvent::Status {
                status: ThreadStatus::Idle,
                ..
            }
        )
    });

    pane.type_line("run cargo build");
    let asked = pane.events_until(|e| matches!(e, AgentEvent::ApprovalRequired { .. }));
    let Some(AgentEvent::ApprovalRequired { request_id, action }) = asked.last().cloned() else {
        unreachable!()
    };
    assert_eq!(action.thread_id, pane.thread_id);
    assert_eq!(
        action.origin,
        Some(ActionOrigin::Thread {
            thread_id: pane.thread_id.clone()
        })
    );
    assert!(
        matches!(&action.action, ActionKind::Command { command, .. } if command == "cargo build")
    );
    pane.session
        .respond_to_approval(&request_id, ApprovalDecision::ApproveOnce)
        .expect("respond");
    pane.wait_for_text("RAN Bash");
    let turn = pane.events_until(turn_done);
    assert!(
        turn.iter()
            .any(|e| matches!(e, AgentEvent::ToolCompleted { ok: true, .. }))
    );

    pane.type_line("run git push");
    let asked = pane.events_until(|e| matches!(e, AgentEvent::ApprovalRequired { .. }));
    let Some(AgentEvent::ApprovalRequired { request_id, .. }) = asked.last().cloned() else {
        unreachable!()
    };
    pane.session
        .respond_to_approval(&request_id, ApprovalDecision::Deny)
        .expect("respond");
    pane.wait_for_text("BLOCKED BY HOOK: KalCode denied this action");
    let turn = pane.events_until(turn_done);
    assert!(
        turn.iter()
            .any(|e| matches!(e, AgentEvent::ToolCompleted { ok: false, .. }))
    );
    assert!(
        !pane
            .text()
            .contains("RAN Bash\r\n> run git push\r\n\r\nRAN")
    );
}

#[test]
fn unanswered_approval_hands_over_to_the_provider_prompt() {
    let rig = Rig::new(
        DecisionRouting::Engine,
        json!({}),
        SessionLimits {
            ask_window: Duration::from_millis(300),
            ..SessionLimits::default()
        },
    );
    let pane = rig.start(PermissionMode::Approve);
    pane.events_until(|e| {
        matches!(
            e,
            AgentEvent::Status {
                status: ThreadStatus::Idle,
                ..
            }
        )
    });
    pane.type_line("run make");
    pane.events_until(|e| matches!(e, AgentEvent::ApprovalRequired { .. }));
    // Nobody answers in KalCode: Claude Code's own prompt takes over, and the person answers.
    pane.wait_for_text("[fake prompt] Allow Bash?");
    pane.type_line("n");
    pane.wait_for_text("DENIED IN PROVIDER PROMPT");
}

#[test]
fn kalcode_unreachable_blocks_tool_calls_but_not_the_session() {
    let rig = Rig::new(
        DecisionRouting::ProviderPrompt,
        json!({}),
        SessionLimits::default(),
    );
    let pane = rig.start(PermissionMode::Approve);
    pane.events_until(|e| {
        matches!(
            e,
            AgentEvent::Status {
                status: ThreadStatus::Idle,
                ..
            }
        )
    });
    rig.bridge.shutdown();
    pane.type_line("run rm -rf build");
    pane.wait_for_text("BLOCKED BY HOOK: KalCode couldn't check this tool call");
    assert!(!pane.text().contains("RAN Bash"));
    // Status hooks fail open: the session keeps working.
    pane.type_line("say still here");
    pane.wait_for_text("still here");
}

#[test]
fn launch_uses_kalcode_settings_the_deny_floor_and_a_clean_environment() {
    let rig = Rig::new(
        DecisionRouting::ProviderPrompt,
        json!({}),
        SessionLimits::default(),
    );
    let pane = rig.start(PermissionMode::Approve);
    pane.events_until(|e| {
        matches!(
            e,
            AgentEvent::Status {
                status: ThreadStatus::Idle,
                ..
            }
        )
    });
    let args: Vec<String> = serde_json::from_value(rig.read_json("last-args.json")).expect("args");
    assert!(
        rig.runs().iter().all(|run| {
            run["args"].as_array().is_none_or(|args| {
                !args
                    .windows(2)
                    .any(|pair| pair[0] == "auth" && pair[1] == "status")
            })
        }),
        "interactive launch must never run Claude's unsafe short-lived status command"
    );
    let value_after = |flag: &str| {
        args.iter()
            .position(|a| a == flag)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    assert_eq!(value_after("--permission-mode").as_deref(), Some("manual"));
    assert_eq!(value_after("--setting-sources").as_deref(), Some("user"));
    assert!(args.iter().any(|a| a == "--strict-mcp-config"));
    assert!(args.iter().any(|a| a == "Bash(git push *)"));
    for forbidden in [
        "-p",
        "--dangerously-skip-permissions",
        "bypassPermissions",
        "--add-dir",
    ] {
        assert!(!args.iter().any(|a| a == forbidden), "{forbidden}");
    }
    let settings_path = value_after("--settings").expect("settings");
    assert!(settings_path.starts_with(&*rig.sessions.path().to_string_lossy()));
    let settings: Value =
        serde_json::from_str(&std::fs::read_to_string(&settings_path).expect("read"))
            .expect("json");
    assert_eq!(
        settings["hooks"]["PreToolUse"][0]["hooks"][0]["timeout"],
        600
    );
    assert!(!settings.to_string().contains("KALCODE_HOOK_KEY"));

    let env: Vec<String> = serde_json::from_value(rig.read_json("last-env.json")).expect("env");
    assert!(
        env.iter().any(|n| n == "KALCODE_HOOK_KEY"),
        "the helper needs its key"
    );
    assert!(env.iter().any(|n| n == "ANTHROPIC_API_KEY"));
    for leaked in ["OPENAI_API_KEY", "KALCODE_DATA_DIR"] {
        assert!(
            !env.iter().any(|n| n.eq_ignore_ascii_case(leaked)),
            "{leaked}"
        );
    }
    pane.session.terminate().expect("terminate");
}

#[test]
fn a_session_without_hooks_is_marked_limited() {
    let rig = Rig::new(
        DecisionRouting::Engine,
        json!({"hooks": false}),
        SessionLimits {
            hooks_expected_within: Duration::from_millis(500),
            ..SessionLimits::default()
        },
    );
    let pane = rig.start(PermissionMode::Approve);
    let events = pane.events_until(|e| matches!(e, AgentEvent::Error { .. }));
    assert!(
        matches!(events.last(), Some(AgentEvent::Error { code, recoverable: true, .. }) if code == "hooks_inactive")
    );
    let info = rig.panes.info(&pane.thread_id).expect("info");
    assert_eq!(info.hook_channel, HookChannelState::Limited);
    assert!(!info.kalcode_answers_approvals);
    pane.session.terminate().expect("terminate");
}

#[test]
fn stopping_a_pane_ends_its_process_and_revokes_the_session() {
    let rig = Rig::new(
        DecisionRouting::ProviderPrompt,
        json!({}),
        SessionLimits::default(),
    );
    let pane = rig.start(PermissionMode::Approve);
    pane.events_until(|e| {
        matches!(
            e,
            AgentEvent::Status {
                status: ThreadStatus::Idle,
                ..
            }
        )
    });
    assert_eq!(rig.bridge.session_count(), 1);
    pane.session.terminate().expect("terminate");
    pane.events_until(|e| matches!(e, AgentEvent::Exited { .. }));
    assert_eq!(
        rig.bridge.session_count(),
        0,
        "stale sessions can't call back"
    );
    assert!(matches!(
        pane.session
            .send(kalcode_contracts::agent::AgentInput::Text { text: "x".into() }),
        Err(ProviderError::Unsupported)
    ));
}

#[cfg(all(not(windows), not(target_os = "macos")))]
#[test]
fn managed_claude_pane_fails_closed_without_a_native_guardian() {
    let rig = Rig::new_managed(
        DecisionRouting::ProviderPrompt,
        json!({"version": "2.1.282 (Claude Code)"}),
        SessionLimits::default(),
    );
    let mut config = rig.config(PermissionMode::Approve);
    config.provider_account_id = Some(new_id());

    let error = match rig
        .provider
        .start_session(config, Box::new(|_: AgentEvent| {}))
    {
        Ok(_) => panic!("managed Claude must not start a PTY without a native guardian"),
        Err(error) => error,
    };
    match error {
        ProviderError::Start(message) => {
            assert_eq!(message, "provider runtime guardian is not configured");
        }
        other => panic!("expected a provider start denial, got {other:?}"),
    }
    assert!(
        !rig.dir.path().join("runs.log").exists(),
        "guardian denial must happen before provider detection or PTY launch"
    );
}

#[cfg(any(windows, target_os = "macos"))]
#[test]
fn managed_claude_pane_rejects_an_unreviewed_version_before_pty_launch() {
    let rig = Rig::new_managed(
        DecisionRouting::ProviderPrompt,
        json!({"version": "2.2.0 (Claude Code)"}),
        SessionLimits::default(),
    );
    let mut config = rig.config(PermissionMode::Approve);
    config.provider_account_id = Some(new_id());

    let error = match rig
        .provider
        .start_session(config, Box::new(|_: AgentEvent| {}))
    {
        Ok(_) => panic!("an unreviewed managed Claude version must not start a PTY"),
        Err(error) => error,
    };
    assert!(error.to_string().contains("certified Claude Code 2.1.282"));
    let runs = std::fs::read_to_string(rig.dir.path().join("runs.log")).expect("runs");
    assert!(
        !runs.lines().any(|line| line.contains("--settings")),
        "the provider TUI must not start: {runs}"
    );
}

#[test]
fn headless_and_interactive_threads_coexist_behind_one_provider() {
    let rig = Rig::new(
        DecisionRouting::ProviderPrompt,
        json!({}),
        SessionLimits::default(),
    );
    let headless = Arc::new(ClaudeCodeProvider::new(Rig::env(&rig.dir)));
    let router = RuntimeRouter::new(headless, rig.provider.clone());
    assert!(router.capabilities().interactive.is_some());

    // Created through the pane entry point: interactive, and remembered for resume.
    let config = rig.config(PermissionMode::Approve);
    let thread = config.thread_id.clone();
    let session = RuntimeRouter::create_interactive(|| {
        router.start_session(config, Box::new(|_: AgentEvent| {}))
    })
    .expect("interactive");
    assert!(router.is_interactive(&thread));
    assert!(rig.panes.contains(&thread));
    session.terminate().expect("terminate");

    // Anything else (missions, automations, thread_create): headless stream-JSON.
    let config = rig.config(PermissionMode::Approve);
    let other = config.thread_id.clone();
    let session = router
        .start_session(config, Box::new(|_: AgentEvent| {}))
        .expect("headless");
    assert!(!router.is_interactive(&other));
    assert!(!rig.panes.contains(&other));
    let deadline = Instant::now() + WAIT;
    let headless_args = loop {
        let args: Vec<String> = std::fs::read_to_string(rig.dir.path().join("last-args.json"))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        if args.iter().any(|a| a == "-p") || Instant::now() > deadline {
            break args;
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    assert!(
        headless_args.iter().any(|a| a == "-p"),
        "headless argv: {headless_args:?}"
    );
    session.terminate().expect("terminate");

    // The arming is consumed by exactly one session start.
    let config = rig.config(PermissionMode::Approve);
    let third = config.thread_id.clone();
    let _ = router
        .start_session(config, Box::new(|_: AgentEvent| {}))
        .map(|s| s.terminate());
    assert!(!router.is_interactive(&third));
}

#[test]
fn unavailable_terminals_never_fall_back_to_headless_on_create_or_resume() {
    let rig = Rig::new(
        DecisionRouting::ProviderPrompt,
        json!({}),
        SessionLimits::default(),
    );
    let router = RuntimeRouter::without_interactive(
        Arc::new(ClaudeCodeProvider::new(Rig::env(&rig.dir))),
        rig.sessions.path().to_path_buf(),
    );
    let config = rig.config(PermissionMode::Approve);
    let thread_id = config.thread_id.clone();
    let created = RuntimeRouter::create_interactive(|| {
        router.start_session(config.clone(), Box::new(|_: AgentEvent| {}))
    });
    assert!(
        matches!(created, Err(ProviderError::Refused { code, .. }) if code == "provider_panes_unavailable")
    );
    assert!(router.is_interactive(&thread_id));
    let resumed = router.start_session(config, Box::new(|_: AgentEvent| {}));
    assert!(
        matches!(resumed, Err(ProviderError::Refused { code, .. }) if code == "provider_panes_unavailable")
    );
    assert!(
        !rig.dir.path().join("last-args.json").exists(),
        "no provider process starts for a refused terminal"
    );

    let chat = router
        .start_session(
            rig.config(PermissionMode::Approve),
            Box::new(|_: AgentEvent| {}),
        )
        .expect("ordinary chat remains available");
    chat.terminate().expect("stop chat");
}

#[test]
fn unreadable_terminal_identity_refuses_instead_of_starting_headless() {
    let rig = Rig::new(
        DecisionRouting::ProviderPrompt,
        json!({}),
        SessionLimits::default(),
    );
    let router = RuntimeRouter::new(
        Arc::new(ClaudeCodeProvider::new(Rig::env(&rig.dir))),
        rig.provider.clone(),
    );
    let config = rig.config(PermissionMode::Approve);
    std::fs::create_dir_all(
        rig.sessions
            .path()
            .join(&config.thread_id)
            .join("interactive"),
    )
    .expect("invalid marker object");
    let result = router.start_session(config, Box::new(|_: AgentEvent| {}));
    assert!(matches!(result, Err(ProviderError::Start(_))));
    assert!(
        !rig.dir.path().join("last-args.json").exists(),
        "uncertain identity cannot start either provider runtime"
    );
}
