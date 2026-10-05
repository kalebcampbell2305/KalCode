use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::*;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
fn windows_process_is_alive(pid: u32) -> bool {
    use std::os::windows::process::CommandExt as _;

    std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()))
        .unwrap_or(false)
}

#[cfg(windows)]
const FAILURE_HELPER_MODE: &str = "KALCODE_PTY_FAILURE_HELPER";
#[cfg(windows)]
const FAILURE_HELPER_PID_FILE: &str = "KALCODE_PTY_FAILURE_PID_FILE";
#[cfg(windows)]
const FAILURE_HELPER_EXIT_AFTER_SPAWN: &str = "KALCODE_PTY_FAILURE_HELPER_EXIT_AFTER_SPAWN";

/// This test doubles as an absolute-path, console-independent helper process for setup-failure
/// regressions. Unlike PowerShell it does not wait for a ConPTY cursor-position response before
/// creating its descendant, so every post-CreateProcess failure stage can be exercised.
#[cfg(windows)]
#[test]
fn pty_failure_descendant_helper() {
    if std::env::var_os(FAILURE_HELPER_MODE).is_none() {
        return;
    }

    use std::os::windows::process::CommandExt as _;
    use std::process::Stdio;

    let pid_file =
        PathBuf::from(std::env::var_os(FAILURE_HELPER_PID_FILE).expect("failure helper pid file"));
    std::fs::write(pid_file.with_extension("started"), b"started")
        .expect("record failure helper start");
    let system_root =
        PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into()));
    let mut descendant = std::process::Command::new(system_root.join("System32").join("PING.EXE"))
        .args(["-n", "120", "127.0.0.1"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .expect("spawn failure-test descendant");
    assert!(
        descendant
            .try_wait()
            .expect("probe failure-test descendant")
            .is_none(),
        "failure-test descendant exited before readiness"
    );
    let staged_pid_file = pid_file.with_extension("pid.pending");
    std::fs::write(&staged_pid_file, descendant.id().to_string()).expect("stage descendant pid");
    std::fs::rename(staged_pid_file, &pid_file).expect("publish descendant pid");

    let exit_after_spawn = match std::env::var_os(FAILURE_HELPER_EXIT_AFTER_SPAWN) {
        None => false,
        Some(value) if value == "1" => true,
        Some(_) => panic!("invalid failure-helper exit role"),
    };
    if exit_after_spawn {
        drop(descendant);
        return;
    }

    std::thread::sleep(Duration::from_secs(90));
    let _ = descendant.kill();
    let _ = descendant.wait();
}

#[cfg(windows)]
fn root_with_long_lived_descendant(pid_file: &std::path::Path) -> ProgramSpec {
    let system_root =
        PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into()));
    ProgramSpec {
        program: std::env::current_exe().expect("test binary"),
        args: vec![
            "--exact".into(),
            "tests::pty_failure_descendant_helper".into(),
            "--nocapture".into(),
        ],
        cwd: pid_file.parent().expect("pid file parent").to_path_buf(),
        env: vec![
            (FAILURE_HELPER_MODE.into(), "1".into()),
            (
                FAILURE_HELPER_PID_FILE.into(),
                pid_file.as_os_str().to_os_string(),
            ),
            (FAILURE_HELPER_EXIT_AFTER_SPAWN.into(), "1".into()),
            ("SystemRoot".into(), system_root.clone().into_os_string()),
            ("WINDIR".into(), system_root.into_os_string()),
        ],
        size: TerminalSize::new(80, 24).expect("size"),
    }
}

#[cfg(windows)]
fn failure_descendant_spec(pid_file: &std::path::Path) -> ProgramSpec {
    let system_root =
        PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into()));
    ProgramSpec {
        program: std::env::current_exe().expect("test binary"),
        args: vec![
            "--exact".into(),
            "tests::pty_failure_descendant_helper".into(),
            "--nocapture".into(),
        ],
        cwd: pid_file.parent().expect("pid file parent").to_path_buf(),
        env: vec![
            (FAILURE_HELPER_MODE.into(), "1".into()),
            (
                FAILURE_HELPER_PID_FILE.into(),
                pid_file.as_os_str().to_os_string(),
            ),
            ("SystemRoot".into(), system_root.clone().into_os_string()),
            ("WINDIR".into(), system_root.into_os_string()),
        ],
        size: TerminalSize::new(80, 24).expect("size"),
    }
}

#[cfg(windows)]
fn recorded_live_descendant(pid_file: &std::path::Path) -> Option<u32> {
    let pid = std::fs::read_to_string(pid_file)
        .ok()?
        .trim()
        .parse::<u32>()
        .ok()?;
    windows_process_is_alive(pid).then_some(pid)
}

#[cfg(windows)]
struct CallbackLeaseProbe {
    pid_file: PathBuf,
    released_while_descendant_alive: Arc<Mutex<Option<bool>>>,
}

#[cfg(windows)]
impl Drop for CallbackLeaseProbe {
    fn drop(&mut self) {
        let alive = std::fs::read_to_string(&self.pid_file)
            .ok()
            .and_then(|pid| pid.trim().parse::<u32>().ok())
            .is_none_or(windows_process_is_alive);
        *self
            .released_while_descendant_alive
            .lock()
            .expect("lease probe") = Some(alive);
    }
}

fn wait_until(timeout: Duration, mut condition: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if condition() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    condition()
}

#[derive(Debug)]
struct ReaderTestKiller;

impl ChildKiller for ReaderTestKiller {
    fn kill(&mut self) -> std::io::Result<()> {
        Ok(())
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(Self)
    }
}

fn reader_fixture(listeners: Vec<Listener>) -> (Inner, std::sync::mpsc::Receiver<InputWrite>) {
    let (input, queued) = sync_channel(8);
    let listeners = listeners
        .into_iter()
        .enumerate()
        .map(|(index, listener)| (index as AttachId + 1, listener))
        .collect();
    (
        Inner {
            master: Mutex::new(None),
            input: Mutex::new(Some(input)),
            killer: Mutex::new(Box::new(ReaderTestKiller)),
            shared: Mutex::new(Shared {
                scrollback: Scrollback::new(SCROLLBACK_BYTES),
                listeners,
            }),
            exit: Mutex::new(None),
            killed: std::sync::atomic::AtomicBool::new(false),
            next_attach: AtomicU64::new(1),
            pid: None,
            guardian_guard: Mutex::new(None),
            #[cfg(target_os = "macos")]
            custodied: false,
        },
        queued,
    )
}

/// A command that prints `text` and exits with `code`, run through the platform shell.
fn command_spec(script: &str) -> SpawnSpec {
    let (program, args) = if cfg!(windows) {
        let cmd =
            std::env::var("ComSpec").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".into());
        (
            PathBuf::from(cmd),
            vec!["/d".to_owned(), "/c".to_owned(), script.to_owned()],
        )
    } else {
        (
            PathBuf::from("/bin/sh"),
            vec!["-c".to_owned(), script.to_owned()],
        )
    };
    SpawnSpec {
        program,
        args,
        cwd: std::env::temp_dir(),
        env: vec![("TERM".into(), "xterm-256color".into())],
        env_remove: vec![],
        size: TerminalSize::new(100, 30).expect("size"),
    }
}

fn interactive_spec() -> SpawnSpec {
    let mut spec = command_spec("");
    if cfg!(windows) {
        spec.args = vec!["/d".into(), "/k".into()];
    } else {
        spec.args = vec![];
    }
    spec
}

struct Captured {
    output: Arc<Mutex<Vec<u8>>>,
    exit: Arc<Mutex<Option<ExitInfo>>>,
    session: PtySession,
}

impl Captured {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.output.lock().expect("lock")).into_owned()
    }
    fn exit(&self) -> Option<ExitInfo> {
        *self.exit.lock().expect("lock")
    }
}

fn start(spec: SpawnSpec) -> Captured {
    let exit = Arc::new(Mutex::new(None));
    let exit_sink = exit.clone();
    let session = PtySession::spawn(spec, move |info| {
        *exit_sink.lock().expect("lock") = Some(info)
    })
    .expect("spawn");
    let output = Arc::new(Mutex::new(Vec::new()));
    let sink = output.clone();
    // Behave like a real terminal view (xterm.js): answer cursor-position requests.
    let responder = session.clone();
    session.attach(move |chunk| {
        sink.lock().expect("lock").extend_from_slice(chunk);
        for _ in 0..chunk.windows(4).filter(|w| *w == b"\x1b[6n").count() {
            let _ = responder.write(b"\x1b[1;1R");
        }
        true
    });
    Captured {
        output,
        exit,
        session,
    }
}

#[test]
fn runs_a_command_and_reports_success() {
    let run = start(command_spec("echo kalcode-pty-ok"));
    assert!(
        wait_until(Duration::from_secs(15), || run.exit().is_some()),
        "did not exit; output so far: {:?}",
        run.text()
    );
    assert!(
        wait_until(Duration::from_secs(5), || run
            .text()
            .contains("kalcode-pty-ok")),
        "output: {:?}",
        run.text()
    );
    let exit = run.exit().expect("exit");
    assert!(exit.success);
    assert_eq!(exit.code, 0);
    assert!(!exit.killed);
}

#[test]
fn captures_non_zero_exit_codes() {
    let run = start(command_spec("exit 3"));
    assert!(wait_until(Duration::from_secs(15), || run.exit().is_some()));
    let exit = run.exit().expect("exit");
    assert_eq!(exit.code, 3);
    assert!(!exit.success);
}

/// Windows reserves 259 as the `STILL_ACTIVE` value returned by `GetExitCodeProcess` for a live
/// process. A process may also legitimately exit with 259, so completion is established with a
/// zero-time `WaitForSingleObject` rather than by comparing the exit code to that sentinel.
#[cfg(windows)]
#[test]
fn windows_exit_code_259_is_reported_as_completed() {
    let run = start(command_spec("exit /b 259"));
    assert!(
        wait_until(Duration::from_secs(15), || run.exit().is_some()),
        "exit code 259 was mistaken for a live process"
    );
    let exit = run.exit().expect("exit");
    assert_eq!(exit.code, 259);
    assert!(!exit.success);
}

#[test]
fn accepts_interactive_input() {
    let run = start(interactive_spec());
    run.session.write(b"echo interactive-ok\r").expect("write");
    assert!(
        wait_until(Duration::from_secs(15), || run
            .text()
            .matches("interactive-ok")
            .count()
            >= 2),
        "expected the echoed command and its output: {:?}",
        run.text()
    );
    run.session.write(b"exit\r").expect("write exit");
    assert!(
        wait_until(Duration::from_secs(15), || run.exit().is_some()),
        "shell did not exit"
    );
    assert!(matches!(run.session.write(b"x"), Err(PtyError::Exited)));
}

#[test]
fn acknowledged_write_reaches_the_terminal_writer_before_returning() {
    let run = start(interactive_spec());
    run.session
        .write_acknowledged(b"echo acknowledged-write-ok\r")
        .expect("acknowledged write");
    assert!(
        wait_until(Duration::from_secs(15), || run
            .text()
            .contains("acknowledged-write-ok")),
        "acknowledged input did not reach the shell: {:?}",
        run.text()
    );
    run.session.kill().expect("kill");
}

#[test]
fn writer_failure_is_returned_to_an_acknowledged_write() {
    struct FailedWriter;

    impl std::io::Write for FailedWriter {
        fn write(&mut self, _buffer: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("injected writer failure"))
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    let (queued, receiver) = sync_channel(1);
    let (acknowledge, acknowledged) = sync_channel(1);
    queued
        .send(InputWrite {
            data: b"guarded input".to_vec(),
            acknowledgement: Some(acknowledge),
        })
        .expect("queue write");
    drop(queued);

    write_loop(Box::new(FailedWriter), &receiver);

    let failure = acknowledged
        .recv_timeout(Duration::from_secs(1))
        .expect("writer acknowledgement")
        .expect_err("writer failure");
    assert!(failure.contains("injected writer failure"), "{failure}");
}

#[test]
fn acknowledged_write_timeout_is_bounded_and_truthful() {
    let (inner, _undrained) = reader_fixture(vec![]);
    let session = PtySession {
        inner: Arc::new(inner),
    };
    let error = session
        .write_acknowledged_with_timeout(b"guarded input", Duration::from_millis(10))
        .expect_err("undrained writer queue must time out");
    assert!(
        matches!(&error, PtyError::Io(message) if message.contains("uncertain")),
        "{error:?}"
    );
}

#[test]
fn resizes_and_validates_sizes() {
    let run = start(interactive_spec());
    run.session
        .resize(TerminalSize::new(120, 40).expect("size"))
        .expect("resize");
    assert!(matches!(
        TerminalSize::new(0, 40),
        Err(PtyError::InvalidSize)
    ));
    assert!(matches!(
        TerminalSize::new(80, 1001),
        Err(PtyError::InvalidSize)
    ));
    run.session.kill().expect("kill");
    assert!(wait_until(Duration::from_secs(15), || run.exit().is_some()));
}

#[test]
fn kill_ends_the_session_and_marks_it_killed() {
    let run = start(interactive_spec());
    run.session.kill().expect("kill");
    assert!(
        wait_until(Duration::from_secs(15), || run.exit().is_some()),
        "did not exit after kill"
    );
    let exit = run.exit().expect("exit");
    assert!(exit.killed);
    assert!(!exit.success);
    run.session
        .kill()
        .expect("killing an exited session is a no-op");
}

#[test]
fn a_quiesced_session_can_be_restarted_immediately() {
    let first = start(interactive_spec());
    first.session.kill().expect("kill first session tree");
    assert!(wait_until(Duration::from_secs(15), || first
        .exit()
        .is_some()));

    let second = start(command_spec("echo restart-ok"));
    assert!(
        wait_until(Duration::from_secs(15), || second.exit().is_some()
            && second.text().contains("restart-ok")),
        "replacement session did not complete: {:?}",
        second.text()
    );
    assert!(second.exit().expect("replacement exit").success);
}

#[test]
fn late_attach_replays_scrollback_once() {
    let run = start(command_spec("echo replay-marker"));
    assert!(wait_until(Duration::from_secs(15), || run.exit().is_some()
        && run.text().contains("replay-marker")));
    let replay = Arc::new(Mutex::new(Vec::new()));
    let sink = replay.clone();
    let id = run.session.attach(move |chunk| {
        sink.lock().expect("lock").extend_from_slice(chunk);
        true
    });
    let replayed = String::from_utf8_lossy(&replay.lock().expect("lock")).into_owned();
    assert_eq!(replayed.matches("replay-marker").count(), 1, "{replayed:?}");
    assert!(run.session.detach(id));
    assert!(!run.session.detach(id));
}

#[test]
fn answers_cursor_requests_when_no_view_is_attached() {
    // No listener: the session itself must answer ConPTY's startup request, or this hangs.
    let exit = Arc::new(Mutex::new(None));
    let sink = exit.clone();
    let session = PtySession::spawn(command_spec("echo unattended-ok"), move |info| {
        *sink.lock().expect("lock") = Some(info)
    })
    .expect("spawn");
    assert!(
        wait_until(Duration::from_secs(15), || exit
            .lock()
            .expect("lock")
            .is_some()),
        "hung without a view"
    );
    let replay = Arc::new(Mutex::new(Vec::new()));
    let r = replay.clone();
    session.attach(move |chunk| {
        r.lock().expect("lock").extend_from_slice(chunk);
        true
    });
    // Process exit and PTY output draining run on independent threads. `attach` atomically
    // replays the scrollback and registers for later chunks, so wait for the reader to deliver
    // output that was still pending when the exit callback ran.
    assert!(
        wait_until(Duration::from_secs(5), || {
            String::from_utf8_lossy(&replay.lock().expect("lock")).contains("unattended-ok")
        }),
        "output was not drained after exit: {:?}",
        String::from_utf8_lossy(&replay.lock().expect("lock"))
    );
    let text = String::from_utf8_lossy(&replay.lock().expect("lock")).into_owned();
    assert!(text.contains("unattended-ok"), "{text:?}");
    assert!(
        !text.contains("\x1b[6n"),
        "answered requests are not replayed: {text:?}"
    );
}

#[test]
fn reader_answers_once_after_the_final_listener_rejects_a_cursor_request() {
    let deliveries = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let delivery_count = deliveries.clone();
    let listener: Listener = Box::new(move |_| {
        delivery_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        false
    });
    let (inner, replies) = reader_fixture(vec![listener]);

    read_loop(
        Box::new(std::io::Cursor::new(b"before\x1b[6nafter")),
        &inner,
    );

    assert_eq!(deliveries.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!(
        replies
            .recv_timeout(Duration::from_secs(1))
            .expect("cursor fallback reply")
            .data,
        CURSOR_POSITION_REPLY
    );
    assert!(matches!(
        replies.try_recv(),
        Err(std::sync::mpsc::TryRecvError::Empty)
    ));
    let shared = lock(&inner.shared);
    assert!(shared.listeners.is_empty());
    assert_eq!(shared.scrollback.contents(), b"beforeafter");
}

#[test]
fn reader_leaves_cursor_reply_to_an_accepting_listener() {
    let listener: Listener = Box::new(|_| true);
    let (inner, replies) = reader_fixture(vec![listener]);

    read_loop(
        Box::new(std::io::Cursor::new(CURSOR_POSITION_REQUEST)),
        &inner,
    );

    assert!(matches!(
        replies.try_recv(),
        Err(std::sync::mpsc::TryRecvError::Empty)
    ));
    let shared = lock(&inner.shared);
    assert_eq!(shared.listeners.len(), 1);
    assert!(shared.scrollback.contents().is_empty());
}

#[test]
fn reader_answers_once_when_a_cursor_request_starts_without_listeners() {
    let (inner, replies) = reader_fixture(vec![]);

    read_loop(
        Box::new(std::io::Cursor::new(CURSOR_POSITION_REQUEST)),
        &inner,
    );

    assert_eq!(
        replies
            .recv_timeout(Duration::from_secs(1))
            .expect("cursor fallback reply")
            .data,
        CURSOR_POSITION_REPLY
    );
    assert!(matches!(
        replies.try_recv(),
        Err(std::sync::mpsc::TryRecvError::Empty)
    ));
    assert!(lock(&inner.shared).scrollback.contents().is_empty());
}

#[test]
fn strip_all_removes_every_occurrence() {
    assert_eq!(strip_all(b"a\x1b[6nb\x1b[6n", b"\x1b[6n"), b"ab");
    assert_eq!(strip_all(b"plain", b"\x1b[6n"), b"plain");
}

#[test]
fn scrollback_is_bounded_and_trims_at_line_starts() {
    let mut scrollback = Scrollback::new(32);
    scrollback.push(b"line-one\nline-two\nline-three\n");
    scrollback.push(b"line-four\n");
    let text = String::from_utf8(scrollback.contents()).expect("utf8");
    assert!(scrollback.len() <= 32);
    assert!(
        text.starts_with("line-"),
        "trimmed at a line start: {text:?}"
    );
    assert!(text.ends_with("line-four\n"));

    let mut big = Scrollback::new(8);
    big.push(b"0123456789abcdef");
    assert_eq!(big.contents(), b"89abcdef");
}

/// Closing a terminal must also end programs started inside it, not just the shell.
#[cfg(windows)]
#[test]
fn closing_a_terminal_ends_programs_started_in_it() {
    use std::os::windows::process::CommandExt as _;

    let run = start(interactive_spec());
    let shell_pid = run.session.pid().expect("pid");
    run.session
        .write(b"ping -n 120 127.0.0.1\r")
        .expect("start child");

    let child_pid = || -> Option<u32> {
        let query = format!(
            "(Get-CimInstance Win32_Process -Filter \"ParentProcessId={shell_pid} AND Name='PING.EXE'\").ProcessId"
        );
        let out = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", &query])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()?;
        String::from_utf8_lossy(&out.stdout)
            .trim()
            .lines()
            .next()?
            .trim()
            .parse()
            .ok()
    };
    let mut ping = None;
    assert!(
        wait_until(Duration::from_secs(20), || {
            ping = child_pid();
            ping.is_some()
        }),
        "child process did not start"
    );
    let ping = ping.expect("ping pid");

    run.session.kill().expect("kill");
    assert!(
        wait_until(Duration::from_secs(20), || !windows_process_is_alive(ping)),
        "child {ping} outlived its terminal"
    );
}

/// The root provider process can exit while a child keeps running. The exit callback is the
/// account-profile lease release point, so Windows must terminate and observe that child before
/// invoking it.
#[cfg(windows)]
#[test]
fn natural_root_exit_quiesces_descendants_before_callback() {
    let temp = tempfile::tempdir().expect("tempdir");
    let pid_file = temp.path().join("descendant.pid");
    let observed = Arc::new(Mutex::new(None));
    let callback_observed = Arc::clone(&observed);
    let callback_pid_file = pid_file.clone();
    let _session =
        PtySession::spawn_program(root_with_long_lived_descendant(&pid_file), move |exit| {
            let observation = std::fs::read_to_string(&callback_pid_file)
                .map_err(|error| format!("root did not record descendant pid: {error}"))
                .and_then(|pid| {
                    pid.trim().parse::<u32>().map_err(|error| {
                        format!("root recorded an invalid descendant pid: {error}")
                    })
                })
                .map(|pid| (exit, pid, windows_process_is_alive(pid)));
            *callback_observed.lock().expect("callback result") = Some(observation);
        })
        .expect("spawn contained root");

    assert!(
        wait_until(Duration::from_secs(20), || observed
            .lock()
            .expect("callback result")
            .is_some()),
        "natural root exit did not reach a quiescent callback"
    );
    let (exit, child_pid, child_alive) = observed
        .lock()
        .expect("callback result")
        .take()
        .expect("callback result")
        .unwrap_or_else(|error| panic!("contained root fixture failed: {error}"));
    assert!(exit.success, "root exit: {exit:?}");
    assert!(!exit.killed, "natural exit must remain distinguishable");
    assert!(
        !child_alive && !windows_process_is_alive(child_pid),
        "descendant {child_pid} was alive at lease-release callback"
    );
}

/// `Child::try_wait` is also a lifecycle boundary used by polling callers. It must not return
/// `Some` while a descendant from the same provider tree remains alive.
#[cfg(windows)]
#[test]
fn try_wait_reports_completion_only_after_descendant_quiescence() {
    let temp = tempfile::tempdir().expect("tempdir");
    let pid_file = temp.path().join("try-wait-descendant.pid");
    let spec = root_with_long_lived_descendant(&pid_file);
    let pair = native_pty_system()
        .openpty(spec.size.to_pty())
        .expect("open ConPTY");
    let mut child = pair
        .slave
        .spawn_command(build_program_command(&spec))
        .expect("spawn contained root");
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().expect("clone PTY reader");
    let mut writer = pair.master.take_writer().expect("take PTY writer");
    let responder = std::thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        while let Ok(read) = reader.read(&mut buffer) {
            if read == 0 {
                break;
            }
            for _ in buffer[..read]
                .windows(CURSOR_POSITION_REQUEST.len())
                .filter(|window| *window == CURSOR_POSITION_REQUEST)
            {
                let _ = writer.write_all(CURSOR_POSITION_REPLY);
                let _ = writer.flush();
            }
        }
    });

    let deadline = Instant::now() + Duration::from_secs(20);
    let status = loop {
        if let Some(status) = child.try_wait().expect("poll contained tree") {
            break status;
        }
        assert!(Instant::now() < deadline, "contained root did not exit");
        std::thread::sleep(Duration::from_millis(10));
    };
    assert!(status.success());
    let descendant = std::fs::read_to_string(&pid_file)
        .expect("root recorded descendant pid")
        .trim()
        .parse::<u32>()
        .expect("descendant pid");
    assert!(
        !windows_process_is_alive(descendant),
        "try_wait returned Some while descendant {descendant} lived"
    );
    drop(pair.master);
    responder.join().expect("PTY responder");
}

/// Every error after `CreateProcessW` must keep the callback-held profile lease until the Job
/// Object proves that the root and descendant are both gone. These injected stages cover I/O
/// setup and all three background-thread creation boundaries.
#[cfg(windows)]
#[test]
fn setup_failures_quiesce_descendants_before_releasing_callback_lease() {
    for stage in [
        SetupStage::Io,
        SetupStage::WriterThread,
        SetupStage::ReaderThread,
        SetupStage::WaiterThread,
    ] {
        let temp = tempfile::tempdir().expect("tempdir");
        let pid_file = temp.path().join("setup-failure-descendant.pid");
        let descendant_ready = Arc::new(Mutex::new(false));
        let hook_ready = Arc::clone(&descendant_ready);
        let hook_pid_file = pid_file.clone();
        let released_alive = Arc::new(Mutex::new(None));
        let lease_probe = CallbackLeaseProbe {
            pid_file: pid_file.clone(),
            released_while_descendant_alive: Arc::clone(&released_alive),
        };

        let error = PtySession::spawn_program_with_failure(
            failure_descendant_spec(&pid_file),
            stage,
            move || {
                *hook_ready.lock().expect("descendant readiness") =
                    wait_until(Duration::from_secs(20), || {
                        recorded_live_descendant(&hook_pid_file).is_some()
                    });
            },
            move |_| drop(lease_probe),
        )
        .expect_err("injected setup failure");

        assert!(matches!(error, PtyError::Spawn(_)), "{error:?}");
        assert!(
            *descendant_ready.lock().expect("descendant readiness"),
            "{stage:?} did not observe its live descendant (helper started: {})",
            pid_file.with_extension("started").exists()
        );
        let descendant = std::fs::read_to_string(&pid_file)
            .expect("descendant pid")
            .trim()
            .parse::<u32>()
            .expect("descendant pid");
        assert_eq!(
            *released_alive.lock().expect("lease probe"),
            Some(false),
            "callback lease released before stage cleanup proved quiescence"
        );
        assert!(
            !windows_process_is_alive(descendant),
            "descendant {descendant} survived setup failure"
        );
    }
}

#[cfg(windows)]
fn assert_backend_wait_failure_quiesces(stage: SetupStage) {
    let temp = tempfile::tempdir().expect("tempdir");
    let pid_file = temp.path().join("wait-failure-descendant.pid");
    let descendant_ready = Arc::new(Mutex::new(false));
    let hook_ready = Arc::clone(&descendant_ready);
    let hook_pid_file = pid_file.clone();
    let released_alive = Arc::new(Mutex::new(None));
    let lease_probe = CallbackLeaseProbe {
        pid_file: pid_file.clone(),
        released_while_descendant_alive: Arc::clone(&released_alive),
    };
    let exit = Arc::new(Mutex::new(None));
    let callback_exit = Arc::clone(&exit);

    let session = PtySession::spawn_program_with_failure(
        failure_descendant_spec(&pid_file),
        stage,
        move || {
            *hook_ready.lock().expect("descendant readiness") =
                wait_until(Duration::from_secs(20), || {
                    recorded_live_descendant(&hook_pid_file).is_some()
                });
        },
        move |info| {
            *callback_exit.lock().expect("exit") = Some(info);
            drop(lease_probe);
        },
    )
    .expect("spawn failure-injected session");

    assert!(
        wait_until(Duration::from_secs(20), || exit
            .lock()
            .expect("exit")
            .is_some()),
        "wait failure did not reach a quiescent callback"
    );
    assert!(
        wait_until(Duration::from_secs(5), || released_alive
            .lock()
            .expect("lease probe")
            .is_some()),
        "quiescent callback did not release its lease capture"
    );
    assert!(
        *descendant_ready.lock().expect("descendant readiness"),
        "wait failure hook did not observe its live descendant"
    );
    let descendant = std::fs::read_to_string(&pid_file)
        .expect("descendant pid")
        .trim()
        .parse::<u32>()
        .expect("descendant pid");
    assert_eq!(
        *released_alive.lock().expect("lease probe"),
        Some(false),
        "callback lease released before wait cleanup proved quiescence"
    );
    assert!(!windows_process_is_alive(descendant));
    let failure = exit.lock().expect("exit").expect("exit");
    assert!(!failure.success);
    assert_eq!(failure.code, 1);
    assert!(session.exit_info().is_some());
}

/// A returned backend wait error is production-equivalent to handle duplication or wait API
/// failure. It must terminate and prove the process tree before releasing the callback lease.
#[cfg(windows)]
#[test]
fn backend_wait_error_quiesces_descendant_before_callback() {
    assert_backend_wait_failure_quiesces(SetupStage::BackendWaitError);
}

/// Debug builds also prove the defensive unwind path. Production uses `panic = "abort"`, so the
/// release invariant is that the vendored wait path is panic-free; this test is not cited as the
/// production recovery proof.
#[cfg(all(windows, panic = "unwind"))]
#[test]
fn backend_wait_panic_quiesces_descendant_before_callback() {
    assert_backend_wait_failure_quiesces(SetupStage::BackendWaitPanic);
}

/// If cleanup cannot be proved, the callback closure (and therefore its provider-profile lease)
/// remains retained. A later explicit kill may clean the process tree, but it cannot retroactively
/// make the earlier lifecycle boundary safe.
#[cfg(windows)]
#[test]
fn unproved_backend_wait_retains_callback_lease() {
    let temp = tempfile::tempdir().expect("tempdir");
    let pid_file = temp.path().join("wait-unproved-descendant.pid");
    let hook_pid_file = pid_file.clone();
    let released_alive = Arc::new(Mutex::new(None));
    let lease_probe = CallbackLeaseProbe {
        pid_file: pid_file.clone(),
        released_while_descendant_alive: Arc::clone(&released_alive),
    };

    let session = PtySession::spawn_program_with_failure(
        failure_descendant_spec(&pid_file),
        SetupStage::BackendWaitUnproven,
        move || {
            let _ = wait_until(Duration::from_secs(20), || {
                recorded_live_descendant(&hook_pid_file).is_some()
            });
        },
        move |_| drop(lease_probe),
    )
    .expect("spawn unproved-wait session");

    assert!(
        wait_until(Duration::from_secs(20), || matches!(
            session.write(b"probe"),
            Err(PtyError::Exited)
        )),
        "failed waiter did not close session input"
    );
    let descendant = recorded_live_descendant(&pid_file).expect("live descendant before cleanup");
    assert_eq!(
        *released_alive.lock().expect("lease probe"),
        None,
        "unproved cleanup released callback-held lease"
    );
    assert_eq!(session.exit_info(), None);

    session.kill().expect("clean up retained test process tree");
    assert!(
        wait_until(Duration::from_secs(20), || !windows_process_is_alive(
            descendant
        )),
        "descendant {descendant} survived explicit cleanup"
    );
    assert_eq!(
        *released_alive.lock().expect("lease probe"),
        None,
        "retained callback must not be released after an unproved boundary"
    );
}

/// `PROC_THREAD_ATTRIBUTE_JOB_LIST` must remain compatible with the parent jobs used by test
/// runners, app launchers and CI. A helper test process is itself placed in an outer Job Object,
/// then creates a contained ConPTY child through the production path.
#[cfg(windows)]
#[test]
fn atomic_job_assignment_works_inside_parent_job() {
    const HELPER: &str = "KALCODE_PTY_NESTED_JOB_HELPER";
    if std::env::var_os(HELPER).is_some() {
        let run = start(command_spec("exit 0"));
        assert!(wait_until(Duration::from_secs(15), || run.exit().is_some()));
        assert!(run.exit().expect("helper exit").success);
        return;
    }

    use process_wrap::std::{CommandWrap, CreationFlags, JobObject};
    use std::os::windows::process::CommandExt as _;
    use std::process::Stdio;
    use windows::Win32::System::Threading::CREATE_NO_WINDOW as WINDOWS_CREATE_NO_WINDOW;

    let mut command = std::process::Command::new(std::env::current_exe().expect("test binary"));
    command
        .args([
            "--exact",
            "tests::atomic_job_assignment_works_inside_parent_job",
            "--nocapture",
        ])
        .env(HELPER, "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);
    let mut command = CommandWrap::from(command);
    command.wrap(CreationFlags(WINDOWS_CREATE_NO_WINDOW));
    command.wrap(JobObject);
    let mut child = command.spawn().expect("spawn outer-job helper");
    assert!(child.wait().expect("wait outer-job helper").success());
}

#[test]
fn attach_always_delivers_the_replay_first() {
    let run = start(command_spec("echo first-replay"));
    assert!(wait_until(Duration::from_secs(15), || run.exit().is_some()
        && run.text().contains("first-replay")));
    let calls = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));
    let sink = calls.clone();
    run.session.attach(move |chunk| {
        sink.lock().expect("lock").push(chunk.to_vec());
        true
    });
    let calls = calls.lock().expect("lock");
    assert_eq!(
        calls.len(),
        1,
        "exactly one replay call for an exited session"
    );
    assert!(String::from_utf8_lossy(&calls[0]).contains("first-replay"));
}

#[test]
fn cursor_requests_are_stripped_from_scrollback_chunks() {
    assert_eq!(
        &*strip_cursor_requests(b"before\x1b[6nafter"),
        b"beforeafter"
    );
    assert!(matches!(
        strip_cursor_requests(b"plain"),
        std::borrow::Cow::Borrowed(_)
    ));
}

#[test]
fn removed_variables_do_not_reach_the_shell() {
    // A variable every process inherits on this platform.
    let (name, script) = if cfg!(windows) {
        ("OS", "echo [%OS%]")
    } else {
        ("HOME", "echo [$HOME]")
    };
    let inherited = std::env::var(name).expect("inherited variable");
    let mut spec = command_spec(script);
    spec.env_remove.push(name.into());
    let run = start(spec);
    assert!(wait_until(Duration::from_secs(15), || run.exit().is_some()));
    assert!(
        wait_until(Duration::from_secs(5), || run.text().contains(']')),
        "{:?}",
        run.text()
    );
    assert!(
        !run.text().contains(&format!("[{inherited}]")),
        "{:?}",
        run.text()
    );
}

/// Regression (review finding): a shell that no longer exists, with an empty PATHEXT entry, made
/// portable-pty panic (abort in release) instead of returning an error.
#[test]
fn a_missing_shell_with_a_malformed_pathext_is_a_clean_error() {
    let gone = tempfile::tempdir().expect("tempdir");
    let mut spec = command_spec("");
    spec.program = gone.path().join("pwsh.exe");
    spec.env.push(("PATHEXT".into(), ".COM;;.EXE;é;.".into()));
    spec.env.push((
        "PATH".into(),
        gone.path().to_string_lossy().into_owned()
            + ";"
            + &std::env::var("PATH").unwrap_or_default(),
    ));
    let error = PtySession::spawn(spec, |_| {}).expect_err("missing program");
    assert!(matches!(error, PtyError::Spawn(_)), "{error:?}");
}

/// The same program vanishing *after* the pre-flight check still reaches portable-pty's `PATH`
/// search; the sanitized PATHEXT keeps that from panicking.
#[test]
fn portable_pty_never_sees_a_malformed_pathext() {
    let gone = tempfile::tempdir().expect("tempdir");
    let mut spec = command_spec("");
    spec.program = gone.path().join("pwsh.exe");
    spec.env.push(("PATHEXT".into(), ".COM;;.EXE;é;.".into()));
    spec.env
        .push(("PATH".into(), gone.path().to_string_lossy().into_owned()));
    let command = build_command(&spec);
    if cfg!(windows) {
        assert_eq!(
            command.get_env("PATHEXT"),
            Some(std::ffi::OsStr::new(".COM;.EXE"))
        );
    }
    let pair = native_pty_system()
        .openpty(TerminalSize::new(80, 24).expect("size").to_pty())
        .expect("openpty");
    let spawned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        pair.slave.spawn_command(command).map(|mut child| {
            let _ = child.kill();
        })
    }));
    let result = spawned.expect("portable-pty must not panic");
    assert!(result.is_err(), "a missing program can't start");
}

#[test]
fn pathext_keeps_only_well_formed_entries() {
    let clean = |s: &str| sanitized_pathext(std::ffi::OsStr::new(s));
    assert_eq!(clean(".COM;.EXE;.BAT;.CMD"), ".COM;.EXE;.BAT;.CMD");
    assert_eq!(clean(";.EXE;;. ;é;.c md;x;.PS1;"), ".EXE;.PS1");
    assert_eq!(clean(""), ".COM;.EXE;.BAT;.CMD");
    assert_eq!(clean(";;"), ".COM;.EXE;.BAT;.CMD");
}

#[test]
fn relative_or_non_file_programs_are_refused() {
    for program in [
        PathBuf::from("cmd.exe"),
        PathBuf::from("pwsh"),
        PathBuf::from(r"bin\bash.exe"),
    ] {
        let mut spec = command_spec("");
        spec.program = program.clone();
        assert!(
            matches!(PtySession::spawn(spec, |_| {}), Err(PtyError::Spawn(_))),
            "{program:?}"
        );
    }
    let folder = tempfile::tempdir().expect("tempdir");
    let mut spec = command_spec("");
    spec.program = folder.path().to_path_buf();
    assert!(matches!(
        PtySession::spawn(spec, |_| {}),
        Err(PtyError::Spawn(_))
    ));
}

/// The provider launch API passes exactly the given environment: nothing is inherited.
#[test]
fn program_launch_clears_the_environment() {
    let (program, args, mut env): (PathBuf, Vec<std::ffi::OsString>, Vec<_>) = if cfg!(windows) {
        let cmd =
            std::env::var("ComSpec").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".into());
        (
            PathBuf::from(cmd),
            vec![
                "/d".into(),
                "/c".into(),
                "echo [%KALCODE_PTY_MARK%] [%USERNAME%]".into(),
            ],
            vec![(
                "SystemRoot".into(),
                std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into()),
            )],
        )
    } else {
        (
            PathBuf::from("/bin/sh"),
            vec![
                "-c".into(),
                "echo \"[$KALCODE_PTY_MARK] [${HOME-unset}]\"".into(),
            ],
            vec![],
        )
    };
    env.push(("KALCODE_PTY_MARK".into(), "present".into()));
    let exit = Arc::new(Mutex::new(None));
    let exit_sink = exit.clone();
    let session = PtySession::spawn_program(
        ProgramSpec {
            program,
            args,
            cwd: std::env::temp_dir(),
            env,
            size: TerminalSize::new(100, 30).expect("size"),
        },
        move |info| *exit_sink.lock().expect("lock") = Some(info),
    )
    .expect("spawn");
    let output = Arc::new(Mutex::new(Vec::new()));
    let sink = output.clone();
    let responder = session.clone();
    session.attach(move |chunk| {
        sink.lock().expect("lock").extend_from_slice(chunk);
        for _ in 0..chunk.windows(4).filter(|w| *w == b"\x1b[6n").count() {
            let _ = responder.write(b"\x1b[1;1R");
        }
        true
    });
    let text = || String::from_utf8_lossy(&output.lock().expect("lock")).into_owned();
    assert!(
        wait_until(Duration::from_secs(15), || text().contains("[present]")),
        "output: {:?}",
        text()
    );
    let expected_unset = if cfg!(windows) {
        "[%USERNAME%]"
    } else {
        "[unset]"
    };
    assert!(text().contains(expected_unset), "inherited: {:?}", text());
    assert!(wait_until(Duration::from_secs(10), || exit
        .lock()
        .expect("lock")
        .is_some()));
}

#[test]
fn program_launch_requires_an_absolute_existing_program() {
    let spec = |program: &str| ProgramSpec {
        program: PathBuf::from(program),
        args: vec![],
        cwd: std::env::temp_dir(),
        env: vec![],
        size: TerminalSize::new(80, 24).expect("size"),
    };
    assert!(PtySession::spawn_program(spec("claude"), |_| {}).is_err());
    let missing = std::env::temp_dir().join("kalcode-no-such-program.exe");
    assert!(PtySession::spawn_program(spec(&missing.to_string_lossy()), |_| {}).is_err());
}

#[test]
fn end_of_output_hands_a_coalesced_tail_over_at_once_and_keeps_detach_exact() {
    // A view whose timer would hold buffered output for ten seconds: only the release at the
    // end of the output can deliver the tail promptly.
    let delivered = Arc::new(Mutex::new(Vec::new()));
    let sink = delivered.clone();
    let coalescer = OutputCoalescer::new(
        CoalesceConfig {
            interval: Duration::from_secs(10),
            max_bytes: 1 << 20,
        },
        move |bytes| {
            sink.lock().expect("lock").extend_from_slice(&bytes);
            true
        },
    );
    let exit = Arc::new(Mutex::new(None));
    let exit_sink = exit.clone();
    let session = PtySession::spawn(
        command_spec(if cfg!(windows) {
            "ping -n 2 127.0.0.1 >nul & echo coalesced-tail-marker"
        } else {
            "sleep 1; echo coalesced-tail-marker"
        }),
        move |info| *exit_sink.lock().expect("lock") = Some(info),
    )
    .expect("spawn");
    let responder = session.clone();
    let id = session.attach(move |chunk| {
        for _ in 0..chunk.windows(4).filter(|w| *w == b"\x1b[6n").count() {
            let _ = responder.write(b"\x1b[1;1R");
        }
        coalescer.push(chunk)
    });
    assert!(
        wait_until(Duration::from_secs(8), || String::from_utf8_lossy(
            &delivered.lock().expect("lock")
        )
        .contains("coalesced-tail-marker")),
        "the tail waited for the timer: {:?}",
        String::from_utf8_lossy(&delivered.lock().expect("lock"))
    );
    assert!(wait_until(Duration::from_secs(5), || exit
        .lock()
        .expect("lock")
        .is_some()));
    assert!(
        session.detach(id),
        "a released listener still detaches once"
    );
    assert!(!session.detach(id));
}
