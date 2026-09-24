use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::*;

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

/// A command that prints `text` and exits with `code`, run through the platform shell.
fn command_spec(script: &str) -> SpawnSpec {
    let (program, args) = if cfg!(windows) {
        let cmd = std::env::var("ComSpec").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".into());
        (PathBuf::from(cmd), vec!["/d".to_owned(), "/c".to_owned(), script.to_owned()])
    } else {
        (PathBuf::from("/bin/sh"), vec!["-c".to_owned(), script.to_owned()])
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
    let session = PtySession::spawn(spec, move |info| *exit_sink.lock().expect("lock") = Some(info)).expect("spawn");
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
    Captured { output, exit, session }
}

#[test]
fn runs_a_command_and_reports_success() {
    let run = start(command_spec("echo kalcode-pty-ok"));
    assert!(wait_until(Duration::from_secs(15), || run.exit().is_some()), "did not exit; output so far: {:?}", run.text());
    assert!(wait_until(Duration::from_secs(5), || run.text().contains("kalcode-pty-ok")), "output: {:?}", run.text());
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

#[test]
fn accepts_interactive_input() {
    let run = start(interactive_spec());
    run.session.write(b"echo interactive-ok\r").expect("write");
    assert!(
        wait_until(Duration::from_secs(15), || run.text().matches("interactive-ok").count() >= 2),
        "expected the echoed command and its output: {:?}",
        run.text()
    );
    run.session.write(b"exit\r").expect("write exit");
    assert!(wait_until(Duration::from_secs(15), || run.exit().is_some()), "shell did not exit");
    assert!(matches!(run.session.write(b"x"), Err(PtyError::Exited)));
}

#[test]
fn resizes_and_validates_sizes() {
    let run = start(interactive_spec());
    run.session.resize(TerminalSize::new(120, 40).expect("size")).expect("resize");
    assert!(matches!(TerminalSize::new(0, 40), Err(PtyError::InvalidSize)));
    assert!(matches!(TerminalSize::new(80, 1001), Err(PtyError::InvalidSize)));
    run.session.kill().expect("kill");
    assert!(wait_until(Duration::from_secs(15), || run.exit().is_some()));
}

#[test]
fn kill_ends_the_session_and_marks_it_killed() {
    let run = start(interactive_spec());
    run.session.kill().expect("kill");
    assert!(wait_until(Duration::from_secs(15), || run.exit().is_some()), "did not exit after kill");
    let exit = run.exit().expect("exit");
    assert!(exit.killed);
    assert!(!exit.success);
    run.session.kill().expect("killing an exited session is a no-op");
}

#[test]
fn late_attach_replays_scrollback_once() {
    let run = start(command_spec("echo replay-marker"));
    assert!(wait_until(Duration::from_secs(15), || run.exit().is_some() && run.text().contains("replay-marker")));
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
    let session =
        PtySession::spawn(command_spec("echo unattended-ok"), move |info| *sink.lock().expect("lock") = Some(info))
            .expect("spawn");
    assert!(wait_until(Duration::from_secs(15), || exit.lock().expect("lock").is_some()), "hung without a view");
    let replay = Arc::new(Mutex::new(Vec::new()));
    let r = replay.clone();
    session.attach(move |chunk| {
        r.lock().expect("lock").extend_from_slice(chunk);
        true
    });
    let text = String::from_utf8_lossy(&replay.lock().expect("lock")).into_owned();
    assert!(text.contains("unattended-ok"), "{text:?}");
    assert!(!text.contains("\x1b[6n"), "answered requests are not replayed: {text:?}");
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
    assert!(text.starts_with("line-"), "trimmed at a line start: {text:?}");
    assert!(text.ends_with("line-four\n"));

    let mut big = Scrollback::new(8);
    big.push(b"0123456789abcdef");
    assert_eq!(big.contents(), b"89abcdef");
}

/// Closing a terminal must also end programs started inside it, not just the shell.
#[cfg(windows)]
#[test]
fn closing_a_terminal_ends_programs_started_in_it() {
    let run = start(interactive_spec());
    let shell_pid = run.session.pid().expect("pid");
    run.session.write(b"ping -n 120 127.0.0.1\r").expect("start child");

    let child_pid = || -> Option<u32> {
        let query = format!(
            "(Get-CimInstance Win32_Process -Filter \"ParentProcessId={shell_pid} AND Name='PING.EXE'\").ProcessId"
        );
        let out = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", &query])
            .output()
            .ok()?;
        String::from_utf8_lossy(&out.stdout).trim().lines().next()?.trim().parse().ok()
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
    let alive = || {
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {ping}"), "/NH"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains(&ping.to_string()))
            .unwrap_or(false)
    };
    assert!(wait_until(Duration::from_secs(20), || !alive()), "child {ping} outlived its terminal");
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
    assert_eq!(calls.len(), 1, "exactly one replay call for an exited session");
    assert!(String::from_utf8_lossy(&calls[0]).contains("first-replay"));
}

#[test]
fn cursor_requests_are_stripped_from_scrollback_chunks() {
    assert_eq!(&*strip_cursor_requests(b"before\x1b[6nafter"), b"beforeafter");
    assert!(matches!(strip_cursor_requests(b"plain"), std::borrow::Cow::Borrowed(_)));
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
    assert!(wait_until(Duration::from_secs(5), || run.text().contains(']')), "{:?}", run.text());
    assert!(!run.text().contains(&format!("[{inherited}]")), "{:?}", run.text());
}
