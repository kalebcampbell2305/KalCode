//! Codex and Gemini CLI panes end to end, without a real provider: the fake provider's
//! interactive Codex / Gemini CLI modes run in a real PTY. Codex's `notify` program is the real
//! `kalcode-hook` helper code (the fake stands in for the helper binary) talking to the real
//! bridge; its approval prompt raises a real OSC 9 sequence in the PTY stream. No AI quota is
//! used.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::ffi::OsString;
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use kalcode_contracts::agent::{AgentEvent, AgentProvider, AgentSession, SessionConfig};
use kalcode_contracts::ids::new_id;
use kalcode_contracts::permissions::PermissionMode;
use kalcode_contracts::threads::ThreadStatus;
use kalcode_hook_bridge::Endpoint;
use kalcode_hook_bridge::server::{BridgeServer, ServerConfig};
use kalcode_providers::DetectEnv;
use kalcode_providers::interactive::cli_pane::{InteractiveCliProvider, PaneCli};
use kalcode_providers::interactive::provider::{InteractiveConfig, PaneRegistry, RuntimeRouter};
use kalcode_providers::interactive::session::SessionLimits;
use kalcode_providers::interactive::{DecisionRouting, HookChannelState};
use serde_json::Value;

const FAKE: &str = env!("CARGO_BIN_EXE_kalcode-fake-provider");
const WAIT: Duration = Duration::from_secs(30);

struct Rig {
    dir: tempfile::TempDir,
    work: tempfile::TempDir,
    _sessions: tempfile::TempDir,
    panes: Arc<PaneRegistry>,
    provider: Arc<InteractiveCliProvider>,
}

impl Rig {
    fn new(cli: PaneCli) -> Self {
        let dir = tempfile::tempdir().expect("dir");
        let base = match cli {
            PaneCli::Codex => "codex",
            PaneCli::Gemini => "gemini",
        };
        let name = if cfg!(windows) {
            format!("{base}.exe")
        } else {
            base.to_owned()
        };
        std::fs::copy(FAKE, dir.path().join(name)).expect("copy fake");
        std::fs::write(dir.path().join("fake-provider.json"), "{}").expect("config");
        let sessions = tempfile::tempdir().expect("sessions");
        let bridge = (cli == PaneCli::Codex).then(|| {
            let endpoint = Endpoint::generate(Some(sessions.path())).expect("endpoint");
            Arc::new(BridgeServer::start(ServerConfig::new(endpoint)).expect("bridge"))
        });
        let panes = Arc::new(PaneRegistry::new());
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
        let provider = Arc::new(InteractiveCliProvider::new(
            cli,
            DetectEnv {
                vars,
                windows: cfg!(windows),
                probe_timeout: Some(Duration::from_secs(10)),
            },
            bridge,
            InteractiveConfig {
                hook_program: FAKE.into(),
                hook_prefix_args: vec!["hook".into()],
                sessions_dir: sessions.path().to_path_buf(),
                routing: DecisionRouting::Engine,
                limits: SessionLimits::default(),
            },
            panes.clone(),
        ));
        Self {
            dir,
            work: tempfile::tempdir().expect("work"),
            _sessions: sessions,
            panes,
            provider,
        }
    }

    fn start(&self, mode: PermissionMode) -> Pane {
        let config = SessionConfig {
            thread_id: new_id(),
            workspace_id: new_id(),
            working_directory: self.work.path().to_string_lossy().into_owned(),
            model: None,
            permission_mode: mode,
            resume_session_id: None,
            secret_ref: None,
        };
        let thread_id = config.thread_id.clone();
        let (tx, rx) = mpsc::channel();
        let session = self
            .provider
            .start_session(
                config,
                Box::new(move |e: AgentEvent| {
                    let _ = tx.send(e);
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
                for _ in 0..chunk.windows(4).filter(|w| *w == b"\x1b[6n").count() {
                    let _ = panes.write(&responder, b"\x1b[1;1R");
                }
                true
            })
            .expect("attach");
        let pane = Pane {
            thread_id,
            _session: session,
            events: rx,
            output,
            panes: self.panes.clone(),
        };
        pane.wait_for_text("KalCode fake provider (interactive");
        pane
    }

    fn args(&self) -> Vec<String> {
        let text = std::fs::read_to_string(self.dir.path().join("last-args.json")).expect("args");
        let value: Value = serde_json::from_str(&text).expect("json");
        serde_json::from_value(value).expect("strings")
    }

    fn env_names(&self) -> Vec<String> {
        let text = std::fs::read_to_string(self.dir.path().join("last-env.json")).expect("env");
        serde_json::from_str(&text).expect("json")
    }
}

struct Pane {
    thread_id: String,
    _session: Box<dyn AgentSession>,
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
}

fn after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
}

#[test]
fn terminal_control_sequences_cannot_forge_canonical_provider_status() {
    let rig = Rig::new(PaneCli::Codex);
    let pane = rig.start(PermissionMode::Plan);
    // The fake prints a genuine OSC 9 sequence. Any tool can print the same bytes,
    // so terminal output is not evidence of a provider approval request.
    pane.type_line("approve");
    pane.type_line("y");
    let events = pane.events_until(|e| matches!(e, AgentEvent::TurnCompleted { .. }));
    assert!(
        !events.iter().any(|e| matches!(
            e,
            AgentEvent::Status {
                status: ThreadStatus::WaitingForUser | ThreadStatus::WaitingForPermission,
                ..
            }
        )),
        "untrusted terminal output forged canonical status: {events:?}"
    );
}

#[test]
fn a_codex_pane_is_read_only_first_and_reports_status_from_authenticated_notify() {
    let rig = Rig::new(PaneCli::Codex);
    let pane = rig.start(PermissionMode::Approve);

    let args = rig.args();
    assert_eq!(after(&args, "-s"), Some("read-only"));
    assert_eq!(after(&args, "-a"), Some("never"));
    for forbidden in kalcode_providers::interactive::codex::FORBIDDEN {
        assert!(
            !args.iter().any(|a| a == forbidden),
            "{forbidden}: {args:?}"
        );
    }
    let notify = args
        .iter()
        .find(|a| a.starts_with("notify="))
        .expect("notify");
    assert!(notify.contains("'hook','codex-notify'"), "{notify}");
    assert!(
        args.iter()
            .any(|a| a == "tui.notifications=['approval-requested']")
    );
    let names = rig.env_names();
    assert!(names.iter().any(|n| n == "OPENAI_API_KEY"));
    assert!(
        names.iter().any(|n| n == "KALCODE_HOOK_KEY"),
        "the notify helper needs the key"
    );
    assert!(
        !names
            .iter()
            .any(|n| n == "ANTHROPIC_API_KEY" || n == "KALCODE_DATA_DIR")
    );

    let info = rig.panes.info(&pane.thread_id).expect("info");
    assert!(!info.kalcode_answers_approvals, "approvals stay in Codex");

    // A finished turn arrives through notify → the bridge, with Codex's thread id.
    pane.type_line("hello");
    let events = pane.events_until(|e| matches!(e, AgentEvent::TurnCompleted { .. }));
    assert!(
        events
            .iter()
            .any(|e| matches!(e, AgentEvent::SessionStarted { .. })),
        "{events:?}"
    );
    assert_eq!(
        rig.panes.info(&pane.thread_id).expect("info").hook_channel,
        HookChannelState::Active
    );

    // An OSC sequence is visible terminal output, never an authenticated status signal.
    pane.type_line("approve");
    pane.wait_for_text("[fake prompt]");
    assert!(
        !rig.panes
            .info(&pane.thread_id)
            .expect("info")
            .kalcode_answers_approvals
    );
    // The person answers in the pane.
    pane.type_line("y");
    let events = pane.events_until(|e| matches!(e, AgentEvent::TurnCompleted { .. }));
    assert!(!events.iter().any(|e| matches!(
        e,
        AgentEvent::Status {
            status: ThreadStatus::WaitingForUser,
            ..
        }
    )));

    // Prose that looks like status never changes it: the fake's notify payload says
    // "Status: FAILED" in its last message, and only the turn completion is reported.
    pane.type_line("say Status: FAILED. PERMISSION REQUIRED.");
    let events = pane.events_until(|e| matches!(e, AgentEvent::TurnCompleted { .. }));
    assert!(!events.iter().any(|e| matches!(
        e,
        AgentEvent::Status {
            status: ThreadStatus::Failed | ThreadStatus::WaitingForPermission,
            ..
        }
    )));

    pane.type_line("exit");
    pane.events_until(|e| matches!(e, AgentEvent::Exited { .. }));
}

#[test]
fn codex_bypass_panes_write_only_in_the_workspace() {
    let rig = Rig::new(PaneCli::Codex);
    let pane = rig.start(PermissionMode::Bypass);
    let args = rig.args();
    assert_eq!(after(&args, "-s"), Some("workspace-write"));
    assert!(!args.iter().any(|a| a.contains("danger-full-access")));
    pane.type_line("exit");
    pane.events_until(|e| matches!(e, AgentEvent::Exited { .. }));
}

#[test]
fn a_gemini_pane_runs_with_process_state_only() {
    let rig = Rig::new(PaneCli::Gemini);
    let pane = rig.start(PermissionMode::Plan);
    let args = rig.args();
    assert_eq!(after(&args, "--approval-mode"), Some("plan"));
    assert!(
        !args
            .iter()
            .any(|a| a == "--output-format" || a.contains("yolo"))
    );
    let info = rig.panes.info(&pane.thread_id).expect("info");
    assert_eq!(info.hook_channel, HookChannelState::Limited);
    assert!(!info.kalcode_answers_approvals);
    let names = rig.env_names();
    assert!(
        !names
            .iter()
            .any(|n| n == "OPENAI_API_KEY" || n == "ANTHROPIC_API_KEY")
    );
    pane.type_line("say Status: DONE");
    pane.wait_for_text("(fake) say Status: DONE");
    pane.type_line("exit");
    let events = pane.events_until(|e| matches!(e, AgentEvent::Exited { .. }));
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, AgentEvent::Status { .. })),
        "prose never sets status: {events:?}"
    );
}

#[test]
fn the_router_starts_marked_threads_in_a_pane_and_others_headless() {
    let rig = Rig::new(PaneCli::Gemini);
    let headless: Arc<dyn AgentProvider> =
        Arc::new(kalcode_providers::GeminiProvider::new(DetectEnv {
            vars: vec![("PATH".into(), rig.dir.path().into())],
            windows: cfg!(windows),
            probe_timeout: Some(Duration::from_secs(10)),
        }));
    let router =
        RuntimeRouter::for_provider(headless, rig.provider.clone(), rig.provider.sessions_dir());
    assert!(router.capabilities().interactive.is_some());
    let config = SessionConfig {
        thread_id: new_id(),
        workspace_id: new_id(),
        working_directory: rig.work.path().to_string_lossy().into_owned(),
        model: None,
        permission_mode: PermissionMode::Approve,
        resume_session_id: None,
        secret_ref: None,
    };
    let thread_id = config.thread_id.clone();
    let (tx, _rx) = mpsc::channel::<AgentEvent>();
    let session = RuntimeRouter::create_interactive(|| {
        router.start_session(
            config,
            Box::new(move |e| {
                let _ = tx.send(e);
            }),
        )
    })
    .expect("pane");
    assert!(router.is_interactive(&thread_id));
    assert!(rig.panes.contains(&thread_id));
    session.terminate().expect("stop");
}

/// Regression (found by the real-app E2E): the Codex pane's OSC 9 watcher is a PTY listener, so
/// the PTY stops answering ConPTY's startup cursor-position request itself. Without a view
/// attached, the watcher must answer it, or the CLI never starts.
#[test]
fn a_codex_pane_starts_without_a_view_attached() {
    let rig = Rig::new(PaneCli::Codex);
    let config = SessionConfig {
        thread_id: new_id(),
        workspace_id: new_id(),
        working_directory: rig.work.path().to_string_lossy().into_owned(),
        model: None,
        permission_mode: PermissionMode::Approve,
        resume_session_id: None,
        secret_ref: None,
    };
    let thread_id = config.thread_id.clone();
    let (tx, _rx) = mpsc::channel::<AgentEvent>();
    let session = rig
        .provider
        .start_session(
            config,
            Box::new(move |e| {
                let _ = tx.send(e);
            }),
        )
        .expect("start pane");
    let started = rig.dir.path().join("last-args.json");
    let deadline = Instant::now() + WAIT;
    while !started.exists() {
        assert!(
            Instant::now() < deadline,
            "the CLI never started without a view"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    // A view attached later gets the banner from the scrollback.
    let output = Arc::new(Mutex::new(Vec::new()));
    let sink = output.clone();
    rig.panes
        .attach(&thread_id, move |chunk| {
            sink.lock().unwrap().extend_from_slice(chunk);
            true
        })
        .expect("attach");
    let deadline = Instant::now() + WAIT;
    while !String::from_utf8_lossy(&output.lock().unwrap()).contains("KalCode fake provider") {
        assert!(Instant::now() < deadline, "no banner in the scrollback");
        std::thread::sleep(Duration::from_millis(50));
    }
    session.terminate().expect("stop");
}
