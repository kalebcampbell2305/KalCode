//! Owner-approved smoke run of a REAL interactive Claude Code session in a pane. It CONSUMES THE
//! OWNER'S AI QUOTA (one short prompt). It is `#[ignore]`d and additionally refuses to run
//! unless `KALCODE_REAL_PROVIDER_SMOKE=1` is set. Run it only through
//! `tooling/smoke/claude-interactive-smoke.ps1`, after the owner approves.
//!
//! It confirms the assumptions listed in docs/campaigns/Z7-W4-THREATS.md §5 that the fake
//! provider can't: `--settings` hooks load together with `--setting-sources user`; exec-form
//! `args` work; hooks inherit the key from the provider's environment; payload shapes of
//! SessionStart, UserPromptSubmit, PreToolUse and PostToolUse; and a KalCode "allow" reaches
//! the provider.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use kalcode_contracts::agent::{AgentEvent, AgentProvider, SessionConfig};
use kalcode_contracts::ids::new_id;
use kalcode_contracts::permissions::{ActionKind, ApprovalDecision, PermissionMode};
use kalcode_hook_bridge::Endpoint;
use kalcode_hook_bridge::server::{BridgeServer, ServerConfig};
use kalcode_providers::DetectEnv;
use kalcode_providers::interactive::provider::{
    InteractiveClaudeProvider, InteractiveConfig, PaneRegistry,
};
use kalcode_providers::interactive::session::SessionLimits;
use kalcode_providers::interactive::{DecisionRouting, HookChannelState, TitleSink};

struct Prompts(Mutex<Vec<String>>);

impl TitleSink for Prompts {
    fn first_prompt(&self, _thread_id: &str, prompt: &str) {
        self.0.lock().unwrap().push(prompt.to_owned());
    }
}

#[test]
#[ignore = "starts a real Claude Code session: consumes AI quota; requires the owner's explicit approval"]
fn real_claude_interactive_smoke() {
    if std::env::var_os("KALCODE_REAL_PROVIDER_SMOKE").is_none() {
        eprintln!("skipped: set KALCODE_REAL_PROVIDER_SMOKE=1 to confirm quota use");
        return;
    }
    let hook_program = PathBuf::from(
        std::env::var_os("KALCODE_HOOK_PROGRAM").expect("KALCODE_HOOK_PROGRAM: built kalcode-hook"),
    );
    assert!(hook_program.is_absolute() && hook_program.is_file());
    let work = tempfile::tempdir().expect("work");
    std::fs::write(work.path().join("hello.txt"), "kalcode smoke\n").expect("file");
    let sessions = tempfile::tempdir().expect("sessions");
    let endpoint = Endpoint::generate(Some(sessions.path())).expect("endpoint");
    let bridge = Arc::new(BridgeServer::start(ServerConfig::new(endpoint)).expect("bridge"));
    let panes = Arc::new(PaneRegistry::new());
    let prompts = Arc::new(Prompts(Mutex::new(Vec::new())));
    let provider = InteractiveClaudeProvider::new(
        DetectEnv::from_process(),
        bridge,
        InteractiveConfig {
            hook_program,
            hook_prefix_args: Vec::new(),
            sessions_dir: sessions.path().to_path_buf(),
            routing: DecisionRouting::Engine,
            limits: SessionLimits {
                ask_window: Duration::from_secs(60),
                ..SessionLimits::default()
            },
        },
        panes.clone(),
    )
    .with_titles(prompts.clone());
    let thread_id = new_id();
    let (tx, rx) = mpsc::channel();
    let session = provider
        .start_session(
            SessionConfig {
                thread_id: thread_id.clone(),
                workspace_id: new_id(),
                provider_account_id: None,
                working_directory: work.path().display().to_string(),
                model: None,
                effort: None,
                permission_mode: PermissionMode::Approve,
                resume_session_id: None,
                secret_ref: None,
                launch_origin: Default::default(),
            },
            Box::new(move |e: AgentEvent| {
                let _ = tx.send(e);
            }),
        )
        .expect("start");
    let output = Arc::new(Mutex::new(Vec::new()));
    let sink = output.clone();
    let writer = panes.clone();
    let id = thread_id.clone();
    panes
        .attach(&thread_id, move |chunk| {
            sink.lock().unwrap().extend_from_slice(chunk);
            for _ in 0..chunk.windows(4).filter(|w| *w == b"\x1b[6n").count() {
                let _ = writer.write(&id, b"\x1b[1;1R");
            }
            true
        })
        .expect("attach");

    let wait =
        |what: &str, timeout: Duration, done: &dyn Fn(&AgentEvent) -> bool| -> Vec<AgentEvent> {
            let deadline = Instant::now() + timeout;
            let mut seen = Vec::new();
            while Instant::now() < deadline {
                if let Ok(event) = rx.recv_timeout(Duration::from_millis(200)) {
                    eprintln!("event: {event:?}");
                    let stop = done(&event);
                    seen.push(event);
                    if stop {
                        return seen;
                    }
                }
            }
            panic!(
                "{what} never arrived; saw {seen:?}; pane: {}",
                String::from_utf8_lossy(&output.lock().unwrap())
            );
        };

    // 1. SessionStart hook: --settings hooks load with --setting-sources user, exec form works,
    //    and the helper found its key in the inherited environment.
    let started = wait("SessionStarted", Duration::from_secs(90), &|e| {
        matches!(e, AgentEvent::SessionStarted { .. })
    });
    assert!(!started.is_empty());
    assert_eq!(
        panes.info(&thread_id).expect("info").hook_channel,
        HookChannelState::Active
    );

    // 2. A new folder shows the provider's workspace-trust dialog first; accept its default.
    std::thread::sleep(Duration::from_secs(3));
    panes.write(&thread_id, b"\r").expect("trust");
    std::thread::sleep(Duration::from_secs(2));

    // 3. One short prompt that makes Claude read a file (PreToolUse → KalCode → allow).
    panes
        .write(
            &thread_id,
            b"Use the Read tool to read hello.txt, then reply with its first word only.\r",
        )
        .expect("prompt");
    let asked = wait("ApprovalRequired", Duration::from_secs(180), &|e| {
        matches!(e, AgentEvent::ApprovalRequired { .. })
    });
    let Some(AgentEvent::ApprovalRequired { request_id, action }) = asked.last().cloned() else {
        unreachable!()
    };
    eprintln!("PreToolUse action: {action:?}");
    assert!(
        matches!(&action.action, ActionKind::FileRead { path } if path.ends_with("hello.txt")),
        "{action:?}"
    );
    session
        .respond_to_approval(&request_id, ApprovalDecision::ApproveOnce)
        .expect("respond");
    let turn = wait("TurnCompleted", Duration::from_secs(180), &|e| {
        matches!(e, AgentEvent::TurnCompleted { .. })
    });
    assert!(
        turn.iter()
            .any(|e| matches!(e, AgentEvent::ToolCompleted { ok: true, .. })),
        "PostToolUse after KalCode's allow: {turn:?}"
    );
    // 4. UserPromptSubmit's prompt field (`prompt` or `user_prompt`) reached the namer.
    assert_eq!(
        prompts.0.lock().unwrap().len(),
        1,
        "first prompt for the title"
    );

    // 5. End the session from the TUI.
    panes.write(&thread_id, b"/exit\r").expect("exit");
    wait("Exited", Duration::from_secs(60), &|e| {
        matches!(e, AgentEvent::Exited { .. })
    });
    eprintln!("smoke run passed");
}
