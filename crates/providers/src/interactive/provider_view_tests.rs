#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::cell::RefCell;
use std::io::Write as _;
use std::sync::mpsc::{self, Receiver, Sender};

use kalcode_contracts::agent::{AgentEvent, AgentSession};
use kalcode_contracts::ids::new_id;

use super::*;

type Pause = Box<dyn FnOnce()>;
thread_local! {
    static BEFORE_ATTACH: RefCell<Option<Pause>> = const { RefCell::new(None) };
    static AFTER_DETACH: RefCell<Option<Pause>> = const { RefCell::new(None) };
}

pub(super) fn before_attach() {
    if let Some(pause) = BEFORE_ATTACH.with(|slot| slot.take()) {
        pause();
    }
}

pub(super) fn after_detach() {
    if let Some(pause) = AFTER_DETACH.with(|slot| slot.take()) {
        pause();
    }
}

const WAIT: Duration = Duration::from_secs(10);
const FIXTURE_ENV: &str = "KALCODE_PROVIDER_VIEW_TEST_HELPER";
const OUTPUT: &[u8] = b"VIEW_OBSERVER_OUTPUT";
const HANDOFF_OUTPUT: &[u8] = b"HANDOFF_DELIVERY_OUTPUT";
const HANDOFF_TEXT: &str = "SAFE_HANDOFF_REVIEW";

#[test]
fn view_fixture_process() {
    if std::env::var_os(FIXTURE_ENV).is_none() {
        return;
    }
    let mut line = String::new();
    loop {
        line.clear();
        if std::io::stdin().read_line(&mut line).unwrap_or(0) == 0 {
            break;
        }
        if line.trim() == "observe" {
            let mut stdout = std::io::stdout().lock();
            writeln!(stdout, "VIEW_OBSERVER_OUTPUT").expect("fixture output");
            stdout.flush().expect("flush fixture output");
        } else if line.contains(HANDOFF_TEXT) {
            let mut stdout = std::io::stdout().lock();
            writeln!(stdout, "HANDOFF_DELIVERY_OUTPUT").expect("handoff fixture output");
            stdout.flush().expect("flush handoff fixture output");
        }
    }
}

struct Rig {
    shared: Arc<Shared>,
    panes: Arc<PaneRegistry>,
    thread_id: String,
    provider_session_id: String,
    codex_turn: std::sync::atomic::AtomicUsize,
    exit: Receiver<()>,
    _dir: tempfile::TempDir,
}

impl Rig {
    fn new() -> Self {
        Self::new_for("codex")
    }

    fn new_for(provider_id: &str) -> Self {
        let dir = tempfile::tempdir().expect("fixture directory");
        let thread_id = new_id();
        let provider_session_id = new_id();
        let shared = Shared::new(SessionParts {
            ctx: ActionContext {
                thread_id: thread_id.clone(),
                workspace_id: new_id(),
                working_directory: dir.path().to_string_lossy().into_owned(),
            },
            provider_id: provider_id.into(),
            routing: DecisionRouting::Engine,
            sink: Box::new(|_: AgentEvent| {}),
            provider_session_id: provider_session_id.clone(),
            limits: SessionLimits::default(),
            expiry: None,
            titles: None,
        });
        let mut env = vec![(FIXTURE_ENV.into(), "1".into())];
        for name in ["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"] {
            if let Some(value) = std::env::var_os(name) {
                env.push((name.into(), value));
            }
        }
        let (tx, exit) = mpsc::channel();
        let pty = PtySession::spawn_program(
            ProgramSpec {
                program: std::env::current_exe().expect("fixture executable"),
                args: vec![
                    "--exact".into(),
                    "interactive::provider::view_tests::view_fixture_process".into(),
                    "--nocapture".into(),
                ],
                cwd: dir.path().to_path_buf(),
                env,
                size: TerminalSize::new(80, 24).expect("terminal size"),
            },
            move |_| {
                let _ = tx.send(());
            },
        )
        .expect("fixture PTY");
        shared.pty.set(pty).expect("set fixture PTY");
        let panes = Arc::new(PaneRegistry::new());
        panes.insert(&thread_id, shared.clone());
        Self {
            shared,
            panes,
            thread_id,
            provider_session_id,
            codex_turn: std::sync::atomic::AtomicUsize::new(1),
            exit,
            _dir: dir,
        }
    }

    fn pty(&self) -> &PtySession {
        self.shared.pty().expect("fixture PTY")
    }

    // An ordinary non-view listener sees output under the same PTY lock as the
    // production Codex cursor responder. Probe the actual counter it consults.
    fn observer_for(&self, marker: &'static [u8]) -> Receiver<usize> {
        let weak = Arc::downgrade(&self.shared);
        let (tx, rx) = mpsc::channel();
        let output = Mutex::new(Vec::new());
        self.pty().attach(move |bytes| {
            let Some(shared) = weak.upgrade() else {
                return false;
            };
            if let Some(pty) = shared.pty() {
                for _ in bytes.windows(4).filter(|window| *window == b"\x1b[6n") {
                    pty.write(b"\x1b[1;1R").expect("fixture cursor reply");
                }
            }
            let mut output = lock(&output);
            output.extend_from_slice(bytes);
            if output.windows(marker.len()).any(|window| window == marker) {
                let _ = tx.send(shared.views.load(Ordering::SeqCst));
                output.clear();
            }
            true
        });
        rx
    }

    fn observer(&self) -> Receiver<usize> {
        self.observer_for(OUTPUT)
    }

    fn establish_ready_boundary(&self) {
        let record = match self.shared.provider_id.as_str() {
            "claude-code" => kalcode_hook_bridge::HookRecord {
                event: Some(kalcode_hook_bridge::HookEvent::SessionStart),
                provider_session_id: Some(self.provider_session_id.clone()),
                source: Some("startup".into()),
                ..kalcode_hook_bridge::HookRecord::default()
            },
            "codex" => {
                self.panes
                    .write(&self.thread_id, b"\r")
                    .expect("Codex readiness seed submit");
                return self.complete_codex_turn();
            }
            provider => panic!("{provider} has no verified handoff-ready boundary"),
        };
        assert_eq!(
            self.shared.handle(record),
            kalcode_hook_bridge::HookReply::Ack
        );
    }

    fn complete_codex_turn(&self) {
        let turn = self.codex_turn.fetch_add(1, Ordering::SeqCst);
        self.notify_codex_turn(&format!("turn-{turn}"));
    }

    fn notify_codex_turn(&self, turn_id: &str) {
        assert_eq!(
            self.shared.handle(kalcode_hook_bridge::HookRecord {
                event: Some(kalcode_hook_bridge::HookEvent::CodexNotify),
                provider_session_id: Some(self.provider_session_id.clone()),
                codex_type: Some("agent-turn-complete".into()),
                codex_turn_id: Some(turn_id.to_owned()),
                ..kalcode_hook_bridge::HookRecord::default()
            }),
            kalcode_hook_bridge::HookReply::Ack
        );
    }

    fn observe(&self, rx: &Receiver<usize>) -> usize {
        self.pty().write(b"observe\r").expect("request observation");
        rx.recv_timeout(WAIT).expect("fixture output observation")
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        let _ = self.pty().kill();
        let _ = self.exit.recv_timeout(WAIT);
    }
}

fn recursive_test_process_slot() -> std::sync::MutexGuard<'static, ()> {
    lock(&crate::RECURSIVE_TEST_EXECUTABLE_SLOT)
}

fn pause(
    chosen: &'static std::thread::LocalKey<RefCell<Option<Pause>>>,
    reached: Sender<()>,
    resume: Receiver<()>,
) {
    chosen.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move || {
            reached.send(()).expect("signal scheduling boundary");
            resume
                .recv_timeout(WAIT)
                .expect("resume scheduling boundary");
        }));
    });
}

#[test]
fn pending_attach_does_not_suppress_the_existing_cursor_responder() {
    // Locals drop in reverse declaration order, so every Rig is killed and joined first.
    let _recursive_test_process_slot = recursive_test_process_slot();
    let rig = Rig::new();
    let observed = rig.observer();
    let panes = rig.panes.clone();
    let thread_id = rig.thread_id.clone();
    let (reached, entered) = mpsc::channel();
    let (resume, release) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        pause(&BEFORE_ATTACH, reached, release);
        panes.attach(&thread_id, |_| true).expect("attach")
    });
    entered
        .recv_timeout(WAIT)
        .expect("attach paused before registration");
    let views = rig.observe(&observed);
    resume.send(()).expect("resume attach");
    let attached = worker.join().expect("attach worker");
    assert!(rig.panes.detach(&rig.thread_id, attached));
    assert_eq!(
        views, 0,
        "no view is registered yet; the watcher must answer"
    );
}

#[test]
fn removed_view_does_not_suppress_the_existing_cursor_responder() {
    let _recursive_test_process_slot = recursive_test_process_slot();
    let rig = Rig::new();
    let observed = rig.observer();
    let attached = rig.panes.attach(&rig.thread_id, |_| true).expect("attach");
    let panes = rig.panes.clone();
    let thread_id = rig.thread_id.clone();
    let (reached, entered) = mpsc::channel();
    let (resume, release) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        pause(&AFTER_DETACH, reached, release);
        panes.detach(&thread_id, attached)
    });
    entered
        .recv_timeout(WAIT)
        .expect("detach paused after removal");
    let views = rig.observe(&observed);
    resume.send(()).expect("resume detach");
    assert!(worker.join().expect("detach worker"));
    assert_eq!(
        views, 0,
        "the last view is already removed; the watcher must answer"
    );
}

#[test]
fn independent_views_rejected_replay_and_repeated_detach_keep_exact_counts() {
    let _recursive_test_process_slot = recursive_test_process_slot();
    let rig = Rig::new();
    let first = rig
        .panes
        .attach(&rig.thread_id, |_| true)
        .expect("first view");
    let second = rig
        .panes
        .attach(&rig.thread_id, |_| true)
        .expect("second view");
    assert_eq!(rig.shared.views.load(Ordering::SeqCst), 2);
    let rejected = rig
        .panes
        .attach(&rig.thread_id, |_| false)
        .expect("rejected view id");
    assert_eq!(rig.shared.views.load(Ordering::SeqCst), 2);
    assert!(!rig.panes.detach(&rig.thread_id, rejected));
    assert!(rig.panes.detach(&rig.thread_id, first));
    assert!(!rig.panes.detach(&rig.thread_id, first));
    assert_eq!(rig.shared.views.load(Ordering::SeqCst), 1);
    assert!(rig.panes.detach(&rig.thread_id, second));
    assert_eq!(rig.shared.views.load(Ordering::SeqCst), 0);
}

#[test]
fn rejected_live_output_retires_the_view_without_explicit_detach() {
    let _recursive_test_process_slot = recursive_test_process_slot();
    let rig = Rig::new();
    let observed = rig.observer();
    let replay = std::sync::atomic::AtomicBool::new(true);
    let attached = rig
        .panes
        .attach(&rig.thread_id, move |_| {
            replay.swap(false, Ordering::SeqCst)
        })
        .expect("view");
    let _ = rig.observe(&observed);
    // Taking the PTY registration lock ensures the preceding output delivery and
    // all its listener removals completed, regardless of HashMap iteration order.
    let barrier = rig.pty().attach(|_| false);
    assert!(!rig.pty().detach(barrier));
    assert_eq!(rig.shared.views.load(Ordering::SeqCst), 0);
    assert!(!rig.panes.detach(&rig.thread_id, attached));
}

#[test]
fn view_retirement_stays_bound_to_its_original_session_after_registry_replacement() {
    let _recursive_test_process_slot = recursive_test_process_slot();
    let original = Rig::new();
    let replacement = Rig::new();
    let attached = original
        .panes
        .attach(&original.thread_id, |_| true)
        .expect("view");
    original
        .panes
        .insert(&original.thread_id, replacement.shared.clone());
    assert!(original.pty().detach(attached));
    assert_eq!(original.shared.views.load(Ordering::SeqCst), 0);
    assert_eq!(replacement.shared.views.load(Ordering::SeqCst), 0);
}

#[test]
fn attaching_replays_history_once_then_streams_new_output_once() {
    let _recursive_test_process_slot = recursive_test_process_slot();
    let rig = Rig::new();
    let observed = rig.observer();
    assert_eq!(rig.observe(&observed), 0);
    let output = Arc::new(Mutex::new(Vec::new()));
    let sink = output.clone();
    let attached = rig
        .panes
        .attach(&rig.thread_id, move |bytes| {
            lock(&sink).extend_from_slice(bytes);
            true
        })
        .expect("view");
    assert_eq!(
        lock(&output)
            .windows(OUTPUT.len())
            .filter(|bytes| *bytes == OUTPUT)
            .count(),
        1,
        "historical output appears exactly once during attach"
    );
    assert_eq!(rig.observe(&observed), 1);
    assert!(rig.panes.detach(&rig.thread_id, attached));
    assert_eq!(
        lock(&output)
            .windows(OUTPUT.len())
            .filter(|bytes| *bytes == OUTPUT)
            .count(),
        2,
        "live output appears once after replay"
    );
}

#[test]
fn codex_and_gemini_voice_use_their_provider_native_input_authority() {
    let _recursive_test_process_slot = recursive_test_process_slot();
    for provider_id in ["codex", "gemini-cli"] {
        let rig = Rig::new_for(provider_id);
        let observed = rig.observer();
        let instance_id = rig.shared.instance_id();
        rig.panes
            .write_voice(&rig.thread_id, instance_id, b"observe\r")
            .expect("guarded provider-native voice submit");
        assert_eq!(
            observed.recv_timeout(WAIT).expect("voice command output"),
            0,
            "{provider_id} ordinary input reaches its PTY"
        );
    }
}

#[test]
fn terminal_replies_and_focus_reports_do_not_hide_real_draft_input() {
    let _recursive_test_process_slot = recursive_test_process_slot();
    let rig = Rig::new();
    for reply in [b"\x1b[0n".as_slice(), b"\x1b[1;1R", b"\x1b[I", b"\x1b[O"] {
        rig.panes
            .write(&rig.thread_id, reply)
            .expect("terminal-generated reply");
    }
    assert!(
        rig.shared.reserve_if_unused().expect("fresh reservation"),
        "terminal protocol replies are not user input"
    );
    rig.panes
        .write(&rig.thread_id, b"\x1b[1;1R")
        .expect("DSR reply remains live while reserved");
    assert!(
        rig.panes.write(&rig.thread_id, b"blocked draft").is_err(),
        "human input cannot race a reserved restart"
    );
    rig.shared.cancel_unused_reservation();
    rig.panes
        .write(&rig.thread_id, b"unsent draft")
        .expect("human draft");
    assert!(
        !rig.shared.reserve_if_unused().expect("draft check"),
        "an unsent draft blocks restart"
    );
}

#[test]
fn guarded_voice_write_rejects_a_replaced_provider_instance() {
    let _recursive_test_process_slot = recursive_test_process_slot();
    let original = Rig::new();
    let replacement = Rig::new();
    let captured_instance = original.shared.instance_id().to_owned();
    original
        .panes
        .insert(&original.thread_id, replacement.shared.clone());

    assert_eq!(
        original
            .panes
            .write_voice(&original.thread_id, &captured_instance, b"draft"),
        Err(PaneVoiceWriteError::TargetChanged)
    );
}

#[test]
fn handoff_delivery_requires_authenticated_idle_and_empty_input() {
    let _recursive_test_process_slot = recursive_test_process_slot();

    let fresh = Rig::new_for("claude-code");
    let fresh_claims = std::sync::atomic::AtomicUsize::new(0);
    assert_eq!(
        fresh.panes.deliver_handoff(
            &fresh.thread_id,
            fresh.shared.instance_id(),
            HANDOFF_TEXT,
            || {
                fresh_claims.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        ),
        Err(HandoffDeliveryError::Unverified)
    );
    assert_eq!(fresh_claims.load(Ordering::SeqCst), 0);

    let busy = Rig::new_for("claude-code");
    busy.establish_ready_boundary();
    busy.shared.handle(kalcode_hook_bridge::HookRecord {
        event: Some(kalcode_hook_bridge::HookEvent::UserPromptSubmit),
        prompt: Some("already working".into()),
        ..kalcode_hook_bridge::HookRecord::default()
    });
    assert_eq!(
        busy.panes.deliver_handoff(
            &busy.thread_id,
            busy.shared.instance_id(),
            HANDOFF_TEXT,
            || panic!("busy target must not be claimed"),
        ),
        Err(HandoffDeliveryError::ReadyBusy)
    );

    let prompted = Rig::new_for("claude-code");
    prompted.establish_ready_boundary();
    prompted.shared.handle(kalcode_hook_bridge::HookRecord {
        event: Some(kalcode_hook_bridge::HookEvent::Notification),
        notification_type: Some("permission_prompt".into()),
        ..kalcode_hook_bridge::HookRecord::default()
    });
    assert_eq!(
        prompted.panes.deliver_handoff(
            &prompted.thread_id,
            prompted.shared.instance_id(),
            HANDOFF_TEXT,
            || panic!("provider prompt must not be claimed"),
        ),
        Err(HandoffDeliveryError::ProviderPrompt)
    );

    let auth_prompt = Rig::new_for("claude-code");
    auth_prompt.establish_ready_boundary();
    auth_prompt.shared.handle(kalcode_hook_bridge::HookRecord {
        event: Some(kalcode_hook_bridge::HookEvent::StopFailure),
        error_type: Some("authentication_failed".into()),
        ..kalcode_hook_bridge::HookRecord::default()
    });
    assert_eq!(
        auth_prompt.panes.deliver_handoff(
            &auth_prompt.thread_id,
            auth_prompt.shared.instance_id(),
            HANDOFF_TEXT,
            || panic!("authentication prompt must not be claimed"),
        ),
        Err(HandoffDeliveryError::ProviderPrompt)
    );

    let typed = Rig::new_for("claude-code");
    typed.establish_ready_boundary();
    typed
        .panes
        .write(&typed.thread_id, b"human draft")
        .expect("human typeahead");
    assert_eq!(
        typed.panes.deliver_handoff(
            &typed.thread_id,
            typed.shared.instance_id(),
            HANDOFF_TEXT,
            || panic!("dirty input must not be claimed"),
        ),
        Err(HandoffDeliveryError::InputPending)
    );

    let gemini = Rig::new_for("gemini-cli");
    assert_eq!(
        gemini.panes.deliver_handoff(
            &gemini.thread_id,
            gemini.shared.instance_id(),
            HANDOFF_TEXT,
            || panic!("Gemini process state cannot prove prompt readiness"),
        ),
        Err(HandoffDeliveryError::Unverified)
    );
}

#[test]
fn claude_and_completed_codex_receive_one_bracketed_handoff() {
    let _recursive_test_process_slot = recursive_test_process_slot();
    for provider_id in ["claude-code", "codex"] {
        let rig = Rig::new_for(provider_id);
        let delivered = rig.observer_for(HANDOFF_OUTPUT);

        assert_eq!(
            rig.panes.deliver_handoff(
                &rig.thread_id,
                rig.shared.instance_id(),
                HANDOFF_TEXT,
                || panic!("fresh {provider_id} must not be claimed"),
            ),
            Err(HandoffDeliveryError::Unverified),
            "process existence alone cannot establish readiness"
        );

        rig.establish_ready_boundary();
        let claims = std::sync::atomic::AtomicUsize::new(0);
        rig.panes
            .deliver_handoff(
                &rig.thread_id,
                rig.shared.instance_id(),
                HANDOFF_TEXT,
                || {
                    claims.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                },
            )
            .expect("guarded handoff delivery");
        assert_eq!(claims.load(Ordering::SeqCst), 1);
        assert_eq!(
            delivered
                .recv_timeout(WAIT)
                .expect("handoff reached fixture"),
            0
        );
        assert_eq!(
            rig.panes.deliver_handoff(
                &rig.thread_id,
                rig.shared.instance_id(),
                HANDOFF_TEXT,
                || panic!("an in-flight handoff must not be claimed again"),
            ),
            Err(HandoffDeliveryError::ReadyBusy)
        );
    }
}

#[test]
fn turn_completion_preserves_human_typeahead_after_the_submitted_prompt() {
    let _recursive_test_process_slot = recursive_test_process_slot();

    let claude = Rig::new_for("claude-code");
    claude.establish_ready_boundary();
    claude
        .panes
        .write(&claude.thread_id, b"current turn\r")
        .expect("Claude prompt submit");
    claude
        .panes
        .write(&claude.thread_id, b"draft for the next turn")
        .expect("Claude typeahead");
    claude.shared.handle(kalcode_hook_bridge::HookRecord {
        event: Some(kalcode_hook_bridge::HookEvent::UserPromptSubmit),
        prompt: Some("current turn".into()),
        ..kalcode_hook_bridge::HookRecord::default()
    });
    claude.shared.handle(kalcode_hook_bridge::HookRecord {
        event: Some(kalcode_hook_bridge::HookEvent::Stop),
        ..kalcode_hook_bridge::HookRecord::default()
    });
    assert_eq!(
        claude.panes.deliver_handoff(
            &claude.thread_id,
            claude.shared.instance_id(),
            HANDOFF_TEXT,
            || panic!("Claude completion must not erase human typeahead"),
        ),
        Err(HandoffDeliveryError::InputPending)
    );

    let codex = Rig::new_for("codex");
    codex.establish_ready_boundary();
    codex
        .panes
        .write(&codex.thread_id, b"current turn\r")
        .expect("Codex prompt submit");
    codex
        .panes
        .write(&codex.thread_id, b"draft for the next turn")
        .expect("Codex typeahead");
    codex.complete_codex_turn();
    assert_eq!(
        codex.panes.deliver_handoff(
            &codex.thread_id,
            codex.shared.instance_id(),
            HANDOFF_TEXT,
            || panic!("Codex completion must not erase human typeahead"),
        ),
        Err(HandoffDeliveryError::InputPending)
    );
}

#[test]
fn codex_native_submit_marks_busy_then_completion_restores_clean_readiness() {
    let _recursive_test_process_slot = recursive_test_process_slot();
    let rig = Rig::new_for("codex");
    let delivered = rig.observer_for(HANDOFF_OUTPUT);
    rig.establish_ready_boundary();
    rig.panes
        .write(&rig.thread_id, b"current turn")
        .expect("Codex prompt draft");
    rig.panes
        .write(&rig.thread_id, b"\r")
        .expect("Codex prompt submit");
    assert_eq!(
        rig.panes.deliver_handoff(
            &rig.thread_id,
            rig.shared.instance_id(),
            HANDOFF_TEXT,
            || panic!("Codex is busy immediately after native submit"),
        ),
        Err(HandoffDeliveryError::ReadyBusy)
    );
    rig.complete_codex_turn();
    rig.panes
        .deliver_handoff(
            &rig.thread_id,
            rig.shared.instance_id(),
            HANDOFF_TEXT,
            || Ok(()),
        )
        .expect("authenticated completion restores clean Codex readiness");
    delivered
        .recv_timeout(WAIT)
        .expect("handoff reached completed Codex fixture");
}

#[test]
fn codex_correlates_each_submit_to_one_unique_completion() {
    let _recursive_test_process_slot = recursive_test_process_slot();
    let rig = Rig::new_for("codex");
    rig.panes
        .write(&rig.thread_id, b"first\rsecond\r")
        .expect("two Codex submits");

    rig.notify_codex_turn("delayed-first");
    assert_eq!(
        rig.panes.deliver_handoff(
            &rig.thread_id,
            rig.shared.instance_id(),
            HANDOFF_TEXT,
            || panic!("one completion cannot clear two submits"),
        ),
        Err(HandoffDeliveryError::ReadyBusy)
    );
    rig.notify_codex_turn("delayed-first");
    assert_eq!(
        rig.panes.deliver_handoff(
            &rig.thread_id,
            rig.shared.instance_id(),
            HANDOFF_TEXT,
            || panic!("duplicate turn id cannot consume another submit"),
        ),
        Err(HandoffDeliveryError::ReadyBusy)
    );
    rig.notify_codex_turn("second");
    rig.panes
        .deliver_handoff(
            &rig.thread_id,
            rig.shared.instance_id(),
            HANDOFF_TEXT,
            || Ok(()),
        )
        .expect("second unique completion clears the second submit");
}

#[test]
fn codex_missing_or_unsolicited_completion_never_establishes_readiness() {
    let _recursive_test_process_slot = recursive_test_process_slot();
    let rig = Rig::new_for("codex");
    rig.notify_codex_turn("orphan");
    assert_eq!(
        rig.panes.deliver_handoff(
            &rig.thread_id,
            rig.shared.instance_id(),
            HANDOFF_TEXT,
            || panic!("orphan completion must not be claimed"),
        ),
        Err(HandoffDeliveryError::Unverified)
    );

    rig.panes
        .write(&rig.thread_id, b"work\r")
        .expect("Codex submit");
    assert_eq!(
        rig.shared.handle(kalcode_hook_bridge::HookRecord {
            event: Some(kalcode_hook_bridge::HookEvent::CodexNotify),
            provider_session_id: Some(rig.provider_session_id.clone()),
            codex_type: Some("agent-turn-complete".into()),
            ..kalcode_hook_bridge::HookRecord::default()
        }),
        kalcode_hook_bridge::HookReply::Ack
    );
    assert_eq!(
        rig.panes.deliver_handoff(
            &rig.thread_id,
            rig.shared.instance_id(),
            HANDOFF_TEXT,
            || panic!("missing turn id must not clear the submit"),
        ),
        Err(HandoffDeliveryError::ReadyBusy)
    );
}

#[test]
fn codex_bracketed_paste_newlines_are_not_extra_submits() {
    let _recursive_test_process_slot = recursive_test_process_slot();
    let rig = Rig::new_for("codex");
    rig.panes
        .write(&rig.thread_id, b"\x1b[200~first\rsecond\nthird\x1b[201~\r")
        .expect("Codex bracketed paste and submit");
    rig.notify_codex_turn("pasted-turn");
    rig.panes
        .deliver_handoff(
            &rig.thread_id,
            rig.shared.instance_id(),
            HANDOFF_TEXT,
            || Ok(()),
        )
        .expect("paste contents count as one outer submit");
}

#[test]
fn codex_extra_enter_conservatively_stays_busy() {
    let _recursive_test_process_slot = recursive_test_process_slot();
    let rig = Rig::new_for("codex");
    rig.panes
        .write(&rig.thread_id, b"work\rapproval\r")
        .expect("turn plus provider answer");
    rig.notify_codex_turn("work-turn");
    assert_eq!(
        rig.panes.deliver_handoff(
            &rig.thread_id,
            rig.shared.instance_id(),
            HANDOFF_TEXT,
            || panic!("unmatched Enter must fail closed"),
        ),
        Err(HandoffDeliveryError::ReadyBusy)
    );
}

#[test]
fn codex_handoff_submit_requires_its_own_completion() {
    let _recursive_test_process_slot = recursive_test_process_slot();
    let rig = Rig::new_for("codex");
    rig.establish_ready_boundary();
    rig.panes
        .deliver_handoff(
            &rig.thread_id,
            rig.shared.instance_id(),
            HANDOFF_TEXT,
            || Ok(()),
        )
        .expect("first handoff");
    assert_eq!(
        rig.panes.deliver_handoff(
            &rig.thread_id,
            rig.shared.instance_id(),
            HANDOFF_TEXT,
            || panic!("handoff Enter must count as a pending submit"),
        ),
        Err(HandoffDeliveryError::ReadyBusy)
    );
    rig.complete_codex_turn();
    rig.panes
        .deliver_handoff(
            &rig.thread_id,
            rig.shared.instance_id(),
            HANDOFF_TEXT,
            || Ok(()),
        )
        .expect("unique completion clears the handoff submit");
}

#[test]
fn claude_handoff_hook_does_not_consume_a_later_human_submit_boundary() {
    let _recursive_test_process_slot = recursive_test_process_slot();
    let rig = Rig::new_for("claude-code");
    let delivered = rig.observer_for(HANDOFF_OUTPUT);
    rig.establish_ready_boundary();
    rig.panes
        .deliver_handoff(
            &rig.thread_id,
            rig.shared.instance_id(),
            HANDOFF_TEXT,
            || Ok(()),
        )
        .expect("guarded handoff delivery");
    delivered
        .recv_timeout(WAIT)
        .expect("handoff fixture output");
    rig.panes
        .write(&rig.thread_id, b"human prompt after handoff Enter\r")
        .expect("later human submit");
    rig.shared.handle(kalcode_hook_bridge::HookRecord {
        event: Some(kalcode_hook_bridge::HookEvent::UserPromptSubmit),
        prompt: Some(HANDOFF_TEXT.into()),
        ..kalcode_hook_bridge::HookRecord::default()
    });
    rig.shared.handle(kalcode_hook_bridge::HookRecord {
        event: Some(kalcode_hook_bridge::HookEvent::Stop),
        ..kalcode_hook_bridge::HookRecord::default()
    });
    assert_eq!(
        rig.panes.deliver_handoff(
            &rig.thread_id,
            rig.shared.instance_id(),
            HANDOFF_TEXT,
            || panic!("handoff hook must not consume the later human submit boundary"),
        ),
        Err(HandoffDeliveryError::InputPending)
    );
}

#[test]
fn handoff_rejects_stale_instances_controls_and_ended_sessions_before_claim() {
    let _recursive_test_process_slot = recursive_test_process_slot();

    let rig = Rig::new_for("claude-code");
    rig.establish_ready_boundary();
    assert_eq!(
        rig.panes.deliver_handoff(
            &rig.thread_id,
            "replaced-instance",
            HANDOFF_TEXT,
            || panic!("stale target must not be claimed"),
        ),
        Err(HandoffDeliveryError::TargetChanged)
    );
    assert_eq!(
        rig.panes.deliver_handoff(
            &rig.thread_id,
            rig.shared.instance_id(),
            "unsafe\u{1b}[2J",
            || panic!("unsafe text must not be claimed"),
        ),
        Err(HandoffDeliveryError::InvalidText)
    );

    let delivered = rig.observer_for(HANDOFF_OUTPUT);
    assert_eq!(
        rig.panes.deliver_handoff(
            &rig.thread_id,
            rig.shared.instance_id(),
            HANDOFF_TEXT,
            || Err(HandoffDeliveryError::Io),
        ),
        Err(HandoffDeliveryError::Io),
        "a failed durable claim returns before any terminal byte"
    );
    rig.panes
        .deliver_handoff(
            &rig.thread_id,
            rig.shared.instance_id(),
            HANDOFF_TEXT,
            || Ok(()),
        )
        .expect("a failed claim leaves the verified prompt deliverable");
    delivered
        .recv_timeout(WAIT)
        .expect("only the successful claimed delivery reaches the fixture");

    rig.shared.on_exit(0, false);
    assert_eq!(
        rig.panes.deliver_handoff(
            &rig.thread_id,
            rig.shared.instance_id(),
            HANDOFF_TEXT,
            || panic!("ended target must not be claimed"),
        ),
        Err(HandoffDeliveryError::SessionEnded)
    );
}

#[test]
fn terminal_protocol_replies_do_not_dirty_a_ready_handoff_target() {
    let _recursive_test_process_slot = recursive_test_process_slot();
    let rig = Rig::new_for("claude-code");
    let delivered = rig.observer_for(HANDOFF_OUTPUT);
    rig.establish_ready_boundary();
    for reply in [b"\x1b[0n".as_slice(), b"\x1b[1;1R", b"\x1b[I", b"\x1b[O"] {
        rig.panes
            .write(&rig.thread_id, reply)
            .expect("terminal protocol reply");
    }
    rig.panes
        .deliver_handoff(
            &rig.thread_id,
            rig.shared.instance_id(),
            HANDOFF_TEXT,
            || Ok(()),
        )
        .expect("protocol replies do not become typeahead");
    delivered
        .recv_timeout(WAIT)
        .expect("handoff reached fixture after protocol replies");
}

#[test]
fn codex_lone_escape_dirties_a_ready_handoff_target() {
    let _recursive_test_process_slot = recursive_test_process_slot();
    let rig = Rig::new_for("codex");
    rig.establish_ready_boundary();
    rig.panes
        .write(&rig.thread_id, b"\x1b")
        .expect("manual Escape");
    assert_eq!(
        rig.panes.deliver_handoff(
            &rig.thread_id,
            rig.shared.instance_id(),
            HANDOFF_TEXT,
            || panic!("manual Escape must dirty the prompt"),
        ),
        Err(HandoffDeliveryError::InputPending)
    );
}

#[test]
fn prompt_transition_cannot_interleave_between_claim_and_terminal_write() {
    let _recursive_test_process_slot = recursive_test_process_slot();
    let rig = Rig::new_for("claude-code");
    let delivered = rig.observer_for(HANDOFF_OUTPUT);
    rig.establish_ready_boundary();

    let panes = rig.panes.clone();
    let thread_id = rig.thread_id.clone();
    let instance_id = rig.shared.instance_id().to_owned();
    let (claimed_tx, claimed_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let delivery = std::thread::spawn(move || {
        panes.deliver_handoff(&thread_id, &instance_id, HANDOFF_TEXT, || {
            claimed_tx.send(()).expect("claim reached");
            release_rx
                .recv_timeout(WAIT)
                .expect("release guarded write");
            Ok(())
        })
    });
    claimed_rx.recv_timeout(WAIT).expect("delivery claimed");

    let shared = rig.shared.clone();
    let (prompt_done_tx, prompt_done_rx) = mpsc::channel();
    let prompt = std::thread::spawn(move || {
        shared.handle(kalcode_hook_bridge::HookRecord {
            event: Some(kalcode_hook_bridge::HookEvent::Notification),
            notification_type: Some("permission_prompt".into()),
            ..kalcode_hook_bridge::HookRecord::default()
        });
        prompt_done_tx.send(()).expect("prompt transition complete");
    });
    assert!(
        prompt_done_rx
            .recv_timeout(Duration::from_millis(100))
            .is_err(),
        "the prompt transition waits for the atomic claim/write region"
    );
    release_tx.send(()).expect("release delivery");
    delivery
        .join()
        .expect("delivery thread")
        .expect("delivery wins the ordered lifecycle race");
    delivered
        .recv_timeout(WAIT)
        .expect("handoff fixture output");
    prompt_done_rx
        .recv_timeout(WAIT)
        .expect("prompt transition");
    prompt.join().expect("prompt thread");

    assert_eq!(
        rig.panes.deliver_handoff(
            &rig.thread_id,
            rig.shared.instance_id(),
            HANDOFF_TEXT,
            || panic!("established provider prompt must not be claimed"),
        ),
        Err(HandoffDeliveryError::ProviderPrompt)
    );
}

#[test]
fn interrupt_cannot_interleave_between_claim_and_terminal_write() {
    let _recursive_test_process_slot = recursive_test_process_slot();
    let rig = Rig::new_for("claude-code");
    rig.establish_ready_boundary();

    let panes = rig.panes.clone();
    let thread_id = rig.thread_id.clone();
    let instance_id = rig.shared.instance_id().to_owned();
    let (claimed_tx, claimed_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let delivery = std::thread::spawn(move || {
        panes.deliver_handoff(&thread_id, &instance_id, HANDOFF_TEXT, || {
            claimed_tx.send(()).expect("claim reached");
            release_rx
                .recv_timeout(WAIT)
                .expect("release guarded write");
            Ok(())
        })
    });
    claimed_rx.recv_timeout(WAIT).expect("delivery claimed");

    let session = InteractiveSession {
        shared: rig.shared.clone(),
    };
    let (interrupt_done_tx, interrupt_done_rx) = mpsc::channel();
    let interrupt = std::thread::spawn(move || {
        AgentSession::interrupt(&session).expect("interrupt");
        interrupt_done_tx.send(()).expect("interrupt complete");
    });
    assert!(
        interrupt_done_rx
            .recv_timeout(Duration::from_millis(100))
            .is_err(),
        "interrupt waits for the atomic claim/write region"
    );
    release_tx.send(()).expect("release delivery");
    delivery
        .join()
        .expect("delivery thread")
        .expect("delivery wins the ordered lifecycle race");
    // The acknowledged write proves write_all + flush completed before the interrupt.
    // Once interrupted, provider consumption and output are intentionally not guaranteed.
    interrupt_done_rx
        .recv_timeout(WAIT)
        .expect("interrupt transition");
    interrupt.join().expect("interrupt thread");

    assert!(matches!(
        rig.panes.deliver_handoff(
            &rig.thread_id,
            rig.shared.instance_id(),
            HANDOFF_TEXT,
            || panic!("interrupt-invalidated target must not be claimed"),
        ),
        // The interrupt can leave the CLI busy or end the fixture process;
        // neither state admits another durable claim or terminal write.
        Err(HandoffDeliveryError::ReadyBusy | HandoffDeliveryError::SessionEnded)
    ));
}

/// The claim and acknowledged write hold only the target's lifecycle lock: main-thread pane
/// commands (resize, replacement) never wait on them, and the handoff still lands only on the
/// exact instance that was resolved, never on a replacement registered meanwhile.
#[test]
fn registry_stays_responsive_and_replacement_cannot_redirect_a_claimed_handoff() {
    let _recursive_test_process_slot = recursive_test_process_slot();
    let original = Rig::new_for("claude-code");
    let replacement = Rig::new_for("claude-code");
    let delivered = original.observer_for(HANDOFF_OUTPUT);
    let redirected = replacement.observer_for(HANDOFF_OUTPUT);
    original.establish_ready_boundary();

    let panes = original.panes.clone();
    let thread_id = original.thread_id.clone();
    let instance_id = original.shared.instance_id().to_owned();
    let (claimed_tx, claimed_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let delivery = std::thread::spawn(move || {
        panes.deliver_handoff(&thread_id, &instance_id, HANDOFF_TEXT, || {
            claimed_tx.send(()).expect("claim reached");
            release_rx
                .recv_timeout(WAIT)
                .expect("release guarded write");
            Ok(())
        })
    });
    claimed_rx.recv_timeout(WAIT).expect("delivery claimed");

    let panes = original.panes.clone();
    let thread_id = original.thread_id.clone();
    let replacement_shared = replacement.shared.clone();
    let (registry_done_tx, registry_done_rx) = mpsc::channel();
    let registry = std::thread::spawn(move || {
        panes.resize(&thread_id, 100, 30).expect("resize");
        panes.insert(&thread_id, replacement_shared);
        registry_done_tx
            .send(())
            .expect("registry commands complete");
    });
    registry_done_rx
        .recv_timeout(WAIT)
        .expect("resize and replacement do not wait for the held claim/write");
    registry.join().expect("registry thread");

    release_tx.send(()).expect("release delivery");
    delivery
        .join()
        .expect("delivery thread")
        .expect("original instance receives delivery");
    delivered
        .recv_timeout(WAIT)
        .expect("original fixture output");
    assert!(
        redirected.recv_timeout(Duration::from_millis(300)).is_err(),
        "the replacement never receives the claimed handoff"
    );
    assert_eq!(
        original
            .panes
            .info(&original.thread_id)
            .and_then(|info| info.instance_id),
        Some(replacement.shared.instance_id().to_owned())
    );
}
