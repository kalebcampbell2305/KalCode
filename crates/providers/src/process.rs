//! Supervision for provider child processes.
//!
//! Rules every provider process follows:
//! - Spawned from an argv vector, never a shell command string. (On Windows, `.cmd`/`.bat`
//!   shims are started by the standard library, which quotes each argument for `cmd.exe`.)
//! - A sanitized environment (see [`crate::env`]); `env_clear()` first, then the allow-list.
//! - stdout is read line by line on a dedicated thread with a hard per-line size cap; stderr is
//!   captured on its own thread into a bounded tail buffer and redacted before it is exposed.
//! - Timeouts are enforced by the supervisor, and a [`SupervisedChild`] kills its whole process
//!   tree when dropped, so a crashed or abandoned session never leaves orphans behind.
//! - Each child has its own threads and channels: one provider crashing, hanging or flooding
//!   output cannot block or crash another provider or the rest of KalCode.

use std::collections::{BTreeMap, VecDeque};
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use kalcode_core::logging::redact;

/// Longest stdout line accepted from a provider (a single stream-JSON event). Longer lines are
/// discarded and reported as [`OutputLine::TooLong`] instead of growing memory without bound.
pub const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

/// How much of the end of stderr is kept for diagnostics.
pub const STDERR_TAIL_BYTES: usize = 16 * 1024;

/// How a process is started.
#[derive(Debug, Clone)]
pub struct ProcessSpec {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub cwd: Option<PathBuf>,
    /// The complete environment of the child (already sanitized).
    pub env: BTreeMap<OsString, OsString>,
}

/// One unit of stdout from a supervised child.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OutputLine {
    /// A complete line without its trailing newline. Invalid UTF-8 is replaced lossily.
    Line(String),
    /// A line longer than [`MAX_LINE_BYTES`] was dropped.
    TooLong { bytes: usize },
    /// stdout closed (the process exited or closed it).
    Closed,
}

#[derive(Debug, thiserror::Error)]
pub enum ProcessError {
    #[error("the program could not be started: {0}")]
    Spawn(#[source] std::io::Error),
    #[error("the program did not finish within {0:?}")]
    TimedOut(Duration),
    #[error("waiting for the program failed: {0}")]
    Wait(#[source] std::io::Error),
    #[error("writing to the program failed: {0}")]
    Write(#[source] std::io::Error),
    #[error("the program's input is closed")]
    InputClosed,
}

fn command(spec: &ProcessSpec) -> Command {
    let mut command = Command::new(&spec.program);
    command.args(&spec.args).env_clear().envs(&spec.env);
    if let Some(cwd) = &spec.cwd {
        command.current_dir(cwd);
    }
    platform::configure(&mut command);
    command
}

/// Result of a short, bounded run (version and status probes).
#[derive(Debug, Clone)]
pub struct ProbeOutput {
    pub status: ExitStatus,
    /// At most `max_output` bytes of stdout.
    pub stdout: String,
    /// Redacted stderr tail.
    pub stderr: String,
    pub duration: Duration,
}

/// Runs a program to completion with a timeout, killing its process tree if it overruns.
/// `capture_stdout = false` discards stdout unread (for commands whose output may contain
/// account details we don't need, like `claude auth status`).
pub fn run_probe(
    spec: &ProcessSpec,
    timeout: Duration,
    capture_stdout: bool,
    max_output: usize,
) -> Result<ProbeOutput, ProcessError> {
    let started = Instant::now();
    let mut child = command(spec)
        .stdin(Stdio::null())
        .stdout(if capture_stdout {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stderr(Stdio::piped())
        .spawn()
        .map_err(ProcessError::Spawn)?;

    // Readers report through channels rather than being joined: a grandchild that inherited a
    // pipe could keep it open after the probe exits, and that must not hang detection.
    let stdout = child.stdout.take().map(|pipe| {
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let mut buffer = Vec::new();
            let _ = pipe.take(max_output as u64).read_to_end(&mut buffer);
            let _ = tx.send(String::from_utf8_lossy(&buffer).into_owned());
        });
        rx
    });
    let tail = Arc::new(Mutex::new(StderrTail::default()));
    let stderr = child.stderr.take().map(|pipe| {
        let (tx, rx) = mpsc::channel::<()>();
        let tail = Arc::clone(&tail);
        thread::spawn(move || {
            spawn_stderr_reader(pipe, tail).join().ok();
            let _ = tx.send(());
        });
        rx
    });

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() >= timeout => {
                kill_tree(&mut child);
                // Reader threads end once the pipes close with the process.
                return Err(ProcessError::TimedOut(timeout));
            }
            Ok(None) => thread::sleep(Duration::from_millis(15)),
            Err(error) => {
                kill_tree(&mut child);
                return Err(ProcessError::Wait(error));
            }
        }
    };
    const DRAIN: Duration = Duration::from_secs(2);
    let stdout = stdout
        .and_then(|rx| rx.recv_timeout(DRAIN).ok())
        .unwrap_or_default();
    if let Some(done) = stderr {
        let _ = done.recv_timeout(DRAIN);
    }
    let stderr = lock(&tail).redacted();
    Ok(ProbeOutput {
        status,
        stdout,
        stderr,
        duration: started.elapsed(),
    })
}

/// Bounded buffer holding the end of a child's stderr.
#[derive(Debug, Default)]
struct StderrTail {
    bytes: VecDeque<u8>,
}

impl StderrTail {
    fn push(&mut self, chunk: &[u8]) {
        self.bytes.extend(chunk);
        let excess = self.bytes.len().saturating_sub(STDERR_TAIL_BYTES);
        self.bytes.drain(..excess);
    }

    fn redacted(&self) -> String {
        let (a, b) = self.bytes.as_slices();
        let text = String::from_utf8_lossy(&[a, b].concat()).into_owned();
        redact(&text).into_owned()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn spawn_stderr_reader(
    mut pipe: impl Read + Send + 'static,
    tail: Arc<Mutex<StderrTail>>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut chunk = [0u8; 4096];
        loop {
            match pipe.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => lock(&tail).push(&chunk[..n]),
            }
        }
    })
}

fn spawn_stdout_reader(pipe: impl Read + Send + 'static, lines: Sender<OutputLine>) {
    thread::spawn(move || {
        let mut reader = BufReader::with_capacity(64 * 1024, pipe);
        while let Ok(Some(line)) = read_bounded_line(&mut reader, MAX_LINE_BYTES) {
            if lines.send(line).is_err() {
                break; // Nobody is listening any more.
            }
        }
        let _ = lines.send(OutputLine::Closed);
    });
}

/// Reads one `\n`-terminated line, never buffering more than `max` bytes of it.
pub fn read_bounded_line(
    reader: &mut impl BufRead,
    max: usize,
) -> std::io::Result<Option<OutputLine>> {
    let mut line: Vec<u8> = Vec::new();
    let mut total = 0usize;
    let mut overflowed = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            // EOF: a final line without a newline still counts.
            return Ok(if total == 0 {
                None
            } else {
                Some(finish_line(line, total, overflowed))
            });
        }
        let (chunk, found_newline) = match available.iter().position(|&b| b == b'\n') {
            Some(index) => (&available[..index], true),
            None => (available, false),
        };
        total += chunk.len();
        if !overflowed {
            if line.len() + chunk.len() > max {
                overflowed = true;
                line = Vec::new();
            } else {
                line.extend_from_slice(chunk);
            }
        }
        let consumed = chunk.len() + usize::from(found_newline);
        reader.consume(consumed);
        if found_newline {
            return Ok(Some(finish_line(line, total, overflowed)));
        }
    }
}

fn finish_line(mut line: Vec<u8>, total: usize, overflowed: bool) -> OutputLine {
    if overflowed {
        return OutputLine::TooLong { bytes: total };
    }
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    OutputLine::Line(String::from_utf8_lossy(&line).into_owned())
}

/// A long-lived provider process (an agent session).
pub struct SupervisedChild {
    child: Mutex<Child>,
    stdin: Mutex<Option<ChildStdin>>,
    stderr: Arc<Mutex<StderrTail>>,
    pid: u32,
}

impl SupervisedChild {
    /// Spawns the process with piped stdio. Returns the child and its stdout line stream.
    pub fn spawn(spec: &ProcessSpec) -> Result<(Self, Receiver<OutputLine>), ProcessError> {
        let mut child = command(spec)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(ProcessError::Spawn)?;
        let (tx, rx) = mpsc::channel();
        if let Some(stdout) = child.stdout.take() {
            spawn_stdout_reader(stdout, tx);
        }
        let stderr = Arc::new(Mutex::new(StderrTail::default()));
        if let Some(pipe) = child.stderr.take() {
            spawn_stderr_reader(pipe, Arc::clone(&stderr));
        }
        let stdin = child.stdin.take();
        let pid = child.id();
        Ok((
            Self {
                child: Mutex::new(child),
                stdin: Mutex::new(stdin),
                stderr,
                pid,
            },
            rx,
        ))
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Writes one line (a trailing newline is added) to the child's stdin.
    pub fn write_line(&self, line: &str) -> Result<(), ProcessError> {
        let mut guard = lock(&self.stdin);
        let stdin = guard.as_mut().ok_or(ProcessError::InputClosed)?;
        stdin
            .write_all(line.as_bytes())
            .and_then(|()| stdin.write_all(b"\n"))
            .and_then(|()| stdin.flush())
            .map_err(ProcessError::Write)
    }

    /// Closes stdin (end of input). Idempotent.
    pub fn close_stdin(&self) {
        lock(&self.stdin).take();
    }

    /// Exit status if the process has exited.
    pub fn try_status(&self) -> Result<Option<ExitStatus>, ProcessError> {
        lock(&self.child).try_wait().map_err(ProcessError::Wait)
    }

    /// Waits up to `timeout` for the process to exit on its own.
    pub fn wait_timeout(&self, timeout: Duration) -> Result<Option<ExitStatus>, ProcessError> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self.try_status()? {
                return Ok(Some(status));
            }
            if Instant::now() >= deadline {
                return Ok(None);
            }
            thread::sleep(Duration::from_millis(15));
        }
    }

    /// Ends the session: closes stdin, gives the process `grace` to exit, then kills its tree.
    pub fn terminate(&self, grace: Duration) -> Result<Option<ExitStatus>, ProcessError> {
        self.close_stdin();
        if let Some(status) = self.wait_timeout(grace)? {
            return Ok(Some(status));
        }
        self.kill();
        self.wait_timeout(Duration::from_secs(5))
    }

    /// Kills the process and everything it started. Idempotent.
    pub fn kill(&self) {
        let mut child = lock(&self.child);
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        kill_tree(&mut child);
    }

    /// The redacted end of the child's stderr.
    pub fn stderr_tail(&self) -> String {
        lock(&self.stderr).redacted()
    }
}

impl Drop for SupervisedChild {
    fn drop(&mut self) {
        self.close_stdin();
        self.kill();
    }
}

/// Kills `child` and its descendants, then reaps it.
fn kill_tree(child: &mut Child) {
    platform::kill_descendants(child.id());
    let _ = child.kill();
    let _ = child.wait();
}

/// A channel receive with a deadline that tells timeouts and disconnection apart.
pub fn recv_until<T>(rx: &Receiver<T>, deadline: Instant) -> Result<T, RecvTimeoutError> {
    rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))
}

#[cfg(windows)]
mod platform {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    /// No console window for provider processes started from the GUI app.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    pub fn configure(command: &mut Command) {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    /// Ends the process tree rooted at `pid` with the system `taskkill` (argv, no shell).
    pub fn kill_descendants(pid: u32) {
        let system_root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        let taskkill = std::path::Path::new(&system_root)
            .join("System32")
            .join("taskkill.exe");
        let _ = Command::new(taskkill)
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
}

#[cfg(unix)]
mod platform {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    /// Each provider runs in its own process group so its whole tree can be signalled.
    pub fn configure(command: &mut Command) {
        command.process_group(0);
    }

    pub fn kill_descendants(pid: u32) {
        let _ = Command::new("/bin/kill")
            .args(["-KILL", "--", &format!("-{pid}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn lines(input: &[u8], max: usize) -> Vec<OutputLine> {
        let mut reader = BufReader::with_capacity(4, Cursor::new(input.to_vec()));
        let mut out = Vec::new();
        while let Some(line) = read_bounded_line(&mut reader, max).expect("read") {
            out.push(line);
        }
        out
    }

    #[test]
    fn splits_lines_and_strips_crlf() {
        assert_eq!(
            lines(b"one\r\ntwo\nlast", 100),
            [
                OutputLine::Line("one".into()),
                OutputLine::Line("two".into()),
                OutputLine::Line("last".into())
            ]
        );
    }

    #[test]
    fn oversized_lines_are_dropped_without_losing_the_next_line() {
        let mut input = vec![b'x'; 50];
        input.extend_from_slice(b"\n{\"ok\":1}\n");
        assert_eq!(
            lines(&input, 10),
            [
                OutputLine::TooLong { bytes: 50 },
                OutputLine::Line("{\"ok\":1}".into())
            ]
        );
    }

    #[test]
    fn invalid_utf8_is_replaced_not_fatal() {
        assert_eq!(
            lines(b"a\xffb\n", 100),
            [OutputLine::Line("a\u{fffd}b".into())]
        );
    }

    #[test]
    fn stderr_tail_is_bounded_and_redacted() {
        let mut tail = StderrTail::default();
        tail.push(&vec![b'.'; STDERR_TAIL_BYTES]);
        tail.push(b" token=supersecretvalue123 and sk-ant-api03-abcdefghijklmnopqrstuvwx");
        let text = tail.redacted();
        assert!(text.len() <= STDERR_TAIL_BYTES + 20);
        assert!(!text.contains("supersecretvalue123"), "{text}");
        assert!(!text.contains("sk-ant-api03"), "{text}");
        assert!(text.contains("[REDACTED]"));
    }
}
