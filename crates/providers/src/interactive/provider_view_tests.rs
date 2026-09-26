#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::cell::RefCell;
use std::io::Write as _;
use std::sync::mpsc::{self, Receiver, Sender};

use kalcode_contracts::agent::AgentEvent;
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
        }
    }
}

struct Rig {
    shared: Arc<Shared>,
    panes: Arc<PaneRegistry>,
    thread_id: String,
    exit: Receiver<()>,
    _dir: tempfile::TempDir,
}

impl Rig {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("fixture directory");
        let thread_id = new_id();
        let shared = Shared::new(SessionParts {
            ctx: ActionContext {
                thread_id: thread_id.clone(),
                workspace_id: new_id(),
                working_directory: dir.path().to_string_lossy().into_owned(),
            },
            provider_id: "codex".into(),
            routing: DecisionRouting::Engine,
            sink: Box::new(|_: AgentEvent| {}),
            provider_session_id: new_id(),
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
            exit,
            _dir: dir,
        }
    }

    fn pty(&self) -> &PtySession {
        self.shared.pty().expect("fixture PTY")
    }

    // An ordinary non-view listener sees output under the same PTY lock as the
    // production Codex cursor responder. Probe the actual counter it consults.
    fn observer(&self) -> Receiver<usize> {
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
            if output.windows(OUTPUT.len()).any(|window| window == OUTPUT) {
                let _ = tx.send(shared.views.load(Ordering::SeqCst));
                output.clear();
            }
            true
        });
        rx
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
