//! A REAL Codex pane (PROVIDERS-2). `#[ignore]`d: it CONSUMES THE OWNER'S AI QUOTA and runs only
//! with `KALCODE_REAL_PROVIDER_SMOKE=1` through `tooling/smoke/codex-interactive-smoke.ps1`,
//! with the owner's explicit approval.
//!
//! It verifies what the fake can't (docs/PROVIDER_PANES.md §7): that `-c notify=[…]` and
//! `-c tui.notifications=['approval-requested']` / `tui.notification_method='osc9'` are accepted
//! by the installed codex-cli, that `notify` runs KalCode's helper with the documented payload
//! (`agent-turn-complete` with `thread-id`), and that an approval request raises OSC 9 under
//! ConPTY. The helper is the real `kalcode-hook` (`KALCODE_HOOK_PROGRAM`).

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use kalcode_contracts::agent::{AgentEvent, AgentProvider, SessionConfig};
use kalcode_contracts::permissions::PermissionMode;
use kalcode_contracts::threads::ThreadStatus;
use kalcode_hook_bridge::Endpoint;
use kalcode_hook_bridge::server::{BridgeServer, ServerConfig};
use kalcode_providers::DetectEnv;
use kalcode_providers::interactive::DecisionRouting;
use kalcode_providers::interactive::cli_pane::{InteractiveCliProvider, PaneCli};
use kalcode_providers::interactive::provider::{InteractiveConfig, PaneRegistry};
use kalcode_providers::interactive::session::SessionLimits;

#[test]
#[ignore = "consumes AI quota; requires the owner's explicit approval"]
fn real_codex_interactive_smoke() {
    if std::env::var_os("KALCODE_REAL_PROVIDER_SMOKE").is_none() {
        eprintln!("skipped: set KALCODE_REAL_PROVIDER_SMOKE=1 to confirm quota use");
        return;
    }
    let helper =
        PathBuf::from(std::env::var_os("KALCODE_HOOK_PROGRAM").expect("KALCODE_HOOK_PROGRAM"));
    let work = tempfile::tempdir().expect("work");
    let sessions = tempfile::tempdir().expect("sessions");
    let bridge = Arc::new(
        BridgeServer::start(ServerConfig::new(
            Endpoint::generate(None).expect("endpoint"),
        ))
        .expect("bridge"),
    );
    let panes = Arc::new(PaneRegistry::new());
    let provider = InteractiveCliProvider::new(
        PaneCli::Codex,
        DetectEnv::from_process(),
        Some(bridge),
        InteractiveConfig {
            hook_program: helper,
            hook_prefix_args: Vec::new(),
            sessions_dir: sessions.path().to_path_buf(),
            routing: DecisionRouting::Engine,
            limits: SessionLimits::default(),
        },
        panes.clone(),
    );
    let config = SessionConfig {
        thread_id: kalcode_contracts::ids::new_id(),
        workspace_id: kalcode_contracts::ids::new_id(),
        working_directory: work.path().display().to_string(),
        model: None,
        permission_mode: PermissionMode::Plan,
        resume_session_id: None,
        secret_ref: None,
    };
    let thread = config.thread_id.clone();
    let (tx, rx) = mpsc::channel();
    let session = provider
        .start_session(
            config,
            Box::new(move |e: AgentEvent| {
                let _ = tx.send(e);
            }),
        )
        .expect("start");
    let output = Arc::new(Mutex::new(Vec::new()));
    let sink = output.clone();
    let writer = panes.clone();
    let id = thread.clone();
    panes
        .attach(&thread, move |chunk| {
            sink.lock().unwrap().extend_from_slice(chunk);
            for _ in 0..chunk.windows(4).filter(|w| *w == b"\x1b[6n").count() {
                let _ = writer.write(&id, b"\x1b[1;1R");
            }
            true
        })
        .expect("attach");
    // Codex may show its own workspace-trust or update screens first; the person running the
    // smoke answers them in the printed pane output if needed.
    std::thread::sleep(Duration::from_secs(8));
    panes
        .write(&thread, b"Reply with the single word: ready\r")
        .expect("type");
    let deadline = Instant::now() + Duration::from_secs(240);
    let mut saw_session = false;
    loop {
        let event = rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap_or_else(|_| {
                panic!(
                    "no notify turn completion; pane: {}",
                    String::from_utf8_lossy(&output.lock().unwrap())
                )
            });
        eprintln!("{event:?}");
        saw_session |= matches!(event, AgentEvent::SessionStarted { .. });
        if matches!(event, AgentEvent::TurnCompleted { .. }) {
            break;
        }
    }
    assert!(saw_session, "notify carried the thread id");

    // A command that needs escalation in the read-only sandbox asks for approval: OSC 9.
    panes
        .write(&thread, b"Create a file named smoke.txt containing ok\r")
        .expect("type");
    let deadline = Instant::now() + Duration::from_secs(240);
    loop {
        let event = rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("approval prompt (OSC 9) or turn end");
        eprintln!("{event:?}");
        match event {
            AgentEvent::Status {
                status: ThreadStatus::WaitingForUser,
                ..
            } => {
                // Decline in Codex's own prompt.
                let _ = panes.write(&thread, b"\x1b");
                break;
            }
            AgentEvent::TurnCompleted { .. } => {
                eprintln!("Codex finished without asking (record this in PROVIDERS-2.md)");
                break;
            }
            _ => {}
        }
    }
    use kalcode_contracts::agent::AgentSession as _;
    session.terminate().expect("terminate");
    assert!(
        !work.path().join("smoke.txt").exists(),
        "Plan mode never writes"
    );
}
