//! Real Codex / Gemini CLI checks. Every test is `#[ignore]`d.
//!
//! - `real_codex_detection` / `real_gemini_detection` run only `--version` and the documented
//!   status command (`codex login status`; Gemini CLI has none). No prompt, no quota.
//! - `real_codex_session_smoke` / `real_gemini_session_smoke` send ONE short prompt through the
//!   adapter, in Plan mode, in an empty temporary folder. They CONSUME THE OWNER'S AI QUOTA and
//!   run only with `KALCODE_REAL_PROVIDER_SMOKE=1`, through `tooling/smoke/*-headless-smoke.ps1`,
//!   with the owner's explicit approval. They check what fixtures can't: the real event shapes
//!   (`thread.started` / `init`, message, `turn.completed` / `result`), that the prompt is read
//!   from stdin, that the flags KalCode passes are accepted, and resume by the provider's id.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use kalcode_contracts::agent::{
    AgentEvent, AgentInput, AgentProvider, AgentSession, DetectionState, SessionConfig,
};
use kalcode_contracts::permissions::PermissionMode;
use kalcode_providers::{CodexProvider, DetectEnv, GeminiProvider, catalog, detect};

const WAIT: Duration = Duration::from_secs(180);

fn smoke_approved() -> bool {
    if std::env::var_os("KALCODE_REAL_PROVIDER_SMOKE").is_none() {
        eprintln!("skipped: set KALCODE_REAL_PROVIDER_SMOKE=1 to confirm quota use");
        return false;
    }
    true
}

fn until_turn(rx: &Receiver<AgentEvent>) -> Vec<AgentEvent> {
    let deadline = Instant::now() + WAIT;
    let mut events = Vec::new();
    loop {
        let event = rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap_or_else(|_| panic!("timed out; got {events:#?}"));
        eprintln!("{event:?}");
        let done = matches!(event, AgentEvent::TurnCompleted { .. });
        events.push(event);
        if done {
            return events;
        }
    }
}

fn two_turns(provider: &dyn AgentProvider) {
    let work = tempfile::tempdir().expect("workdir");
    std::fs::write(work.path().join("README.md"), "# smoke\n").expect("readme");
    let (tx, rx) = mpsc::channel();
    let session: Box<dyn AgentSession> = provider
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
                launch_origin: Default::default(),
            },
            Box::new(move |e: AgentEvent| {
                let _ = tx.send(e);
            }),
        )
        .expect("start");
    session
        .send(AgentInput::Text {
            text: "Reply with the single word: ready".into(),
        })
        .expect("send");
    let events = until_turn(&rx);
    assert!(
        events.contains(&AgentEvent::TurnCompleted { ok: true }),
        "{events:#?}"
    );
    let id = session.provider_session_id().expect("provider session id");
    session
        .send(AgentInput::Text {
            text: "Reply with the single word: again".into(),
        })
        .expect("send");
    let events = until_turn(&rx);
    assert!(events.contains(&AgentEvent::TurnCompleted { ok: true }));
    assert_eq!(
        session.provider_session_id().as_deref(),
        Some(id.as_str()),
        "resumed"
    );
    session.terminate().expect("terminate");
}

#[test]
#[ignore = "uses the real Codex install on this machine (no prompt, no quota)"]
fn real_codex_detection() {
    let result = detect::detect(&catalog::codex_spec(), &DetectEnv::from_process());
    eprintln!(
        "{:?} {:?} {:?}",
        result.detection.state, result.detection.version, result.detection.auth
    );
    assert_eq!(result.detection.state, DetectionState::Installed);
}

#[test]
#[ignore = "uses the real Gemini CLI install on this machine (no prompt, no quota)"]
fn real_gemini_detection() {
    let result = detect::detect(&catalog::gemini_spec(), &DetectEnv::from_process());
    eprintln!(
        "{:?} {:?}",
        result.detection.state, result.detection.version
    );
    assert_eq!(result.detection.state, DetectionState::Installed);
}

#[test]
#[ignore = "consumes AI quota; requires the owner's explicit approval"]
fn real_codex_session_smoke() {
    if smoke_approved() {
        two_turns(&CodexProvider::new(DetectEnv::from_process()));
    }
}

#[test]
#[ignore = "consumes AI quota; requires the owner's explicit approval"]
fn real_gemini_session_smoke() {
    if smoke_approved() {
        two_turns(&GeminiProvider::new(DetectEnv::from_process()));
    }
}
