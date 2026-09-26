//! Supervision for provider child processes.
//!
//! Rules every provider process follows:
//! - Spawned from an argv vector, never a shell command string. On Windows, a `.cmd`/`.bat`
//!   shim is replaced by the absolute program it launches (see [`crate::launch`]); only a shim
//!   KalCode can't read is started through `cmd.exe`, with the hardened environment.
//! - The environment always has `NoDefaultCurrentDirectoryInExePath=1` and a `PATH` of absolute
//!   folders only ([`crate::env::harden`]), so nothing is looked up in the working directory.
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
use std::process::{ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use kalcode_core::logging::redact;

use crate::guardian::{GuardedJob, RegisteredJob};

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
    #[error("terminating the program tree failed: {0}")]
    Terminate(#[source] std::io::Error),
    #[error("writing to the program failed: {0}")]
    Write(#[source] std::io::Error),
    #[error("the program's input is closed")]
    InputClosed,
    #[error("provider guardian cleanup failed: {0}")]
    Guardian(String),
}

/// Builds the command for a spec. The environment is [`crate::env::harden`]ed again here, and a
/// `.cmd`/`.bat` shim is replaced by what it launches ([`crate::launch`]), so no caller can
/// start a provider in a way that lets `cmd.exe` pick a program from the working directory.
fn command(spec: &ProcessSpec) -> Command {
    let mut env = spec.env.clone();
    crate::env::harden(&mut env);
    let launch = crate::launch::resolve(&spec.program, &env);
    let mut command = Command::new(&launch.program);
    command
        .args(&launch.prefix_args)
        .args(&spec.args)
        .env_clear()
        .envs(&env);
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
    run_probe_inner(spec, None, timeout, capture_stdout, max_output)
}

/// Runs a short process through a PREPARED guardian job. The typed admission remains owned until
/// the process and its complete tree have exited.
pub fn run_probe_guarded(
    spec: &ProcessSpec,
    admission: RegisteredJob,
    timeout: Duration,
    capture_stdout: bool,
    max_output: usize,
) -> Result<ProbeOutput, ProcessError> {
    run_probe_inner(spec, Some(admission), timeout, capture_stdout, max_output)
}

fn run_probe_inner(
    spec: &ProcessSpec,
    admission: Option<RegisteredJob>,
    timeout: Duration,
    capture_stdout: bool,
    max_output: usize,
) -> Result<ProbeOutput, ProcessError> {
    let started = Instant::now();
    let mut command = command(spec);
    command
        .stdin(Stdio::null())
        .stdout(if capture_stdout {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stderr(Stdio::piped());
    let (mut child, guardian_job) = match admission {
        Some(admission) => platform::spawn_guarded(command, admission),
        None => platform::spawn(command).map(|child| (child, None)),
    }
    .map_err(ProcessError::Spawn)?;

    // Readers report through channels rather than being joined: a grandchild that inherited a
    // pipe could keep it open after the probe exits, and that must not hang detection.
    let stdout = platform::take_stdout(&mut child).map(|pipe| {
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let mut buffer = Vec::new();
            let _ = pipe.take(max_output as u64).read_to_end(&mut buffer);
            let _ = tx.send(String::from_utf8_lossy(&buffer).into_owned());
        });
        rx
    });
    let tail = Arc::new(Mutex::new(StderrTail::default()));
    let stderr = platform::take_stderr(&mut child).map(|pipe| {
        let (tx, rx) = mpsc::channel::<()>();
        let tail = Arc::clone(&tail);
        thread::spawn(move || {
            spawn_stderr_reader(pipe, tail).join().ok();
            let _ = tx.send(());
        });
        rx
    });

    let status = loop {
        match platform::try_wait(&mut child) {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() >= timeout => {
                if kill_tree(&mut child).is_ok()
                    && let Some(guardian) = &guardian_job
                {
                    guardian
                        .cancel_and_prove_quiescence()
                        .map_err(|error| ProcessError::Guardian(error.to_string()))?;
                }
                // Reader threads end once the pipes close with the process.
                return Err(ProcessError::TimedOut(timeout));
            }
            Ok(None) => thread::sleep(Duration::from_millis(15)),
            Err(error) => {
                if kill_tree(&mut child).is_ok()
                    && let Some(guardian) = &guardian_job
                {
                    guardian
                        .cancel_and_prove_quiescence()
                        .map_err(|cleanup| ProcessError::Guardian(cleanup.to_string()))?;
                }
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
    if let Some(guardian) = &guardian_job {
        guardian
            .cancel_and_prove_quiescence()
            .map_err(|error| ProcessError::Guardian(error.to_string()))?;
    }
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
    child: Mutex<platform::Child>,
    stdin: Mutex<Option<ChildStdin>>,
    stderr: Arc<Mutex<StderrTail>>,
    pid: u32,
    // Retains the typed admission record for this exact process tree. The generation authority
    // remains the canonical owner; this value prevents accidental loss in adapter code.
    guardian_job: Mutex<Option<GuardedJob>>,
}

impl SupervisedChild {
    /// Spawns the process with piped stdio. Returns the child and its stdout line stream.
    pub fn spawn(spec: &ProcessSpec) -> Result<(Self, Receiver<OutputLine>), ProcessError> {
        Self::spawn_inner(spec, None)
    }

    /// Spawns a provider through a PREPARED guardian admission. On Windows the child is created
    /// suspended, assigned to both the external guardian's named job and the local per-child job,
    /// and committed using PID plus creation time from that same process handle before it resumes.
    pub fn spawn_guarded(
        spec: &ProcessSpec,
        admission: RegisteredJob,
    ) -> Result<(Self, Receiver<OutputLine>), ProcessError> {
        Self::spawn_inner(spec, Some(admission))
    }

    fn spawn_inner(
        spec: &ProcessSpec,
        admission: Option<RegisteredJob>,
    ) -> Result<(Self, Receiver<OutputLine>), ProcessError> {
        let mut command = command(spec);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let (mut child, guardian_job) = match admission {
            Some(admission) => platform::spawn_guarded(command, admission),
            None => platform::spawn(command).map(|child| (child, None)),
        }
        .map_err(ProcessError::Spawn)?;
        let (tx, rx) = mpsc::channel();
        if let Some(stdout) = platform::take_stdout(&mut child) {
            spawn_stdout_reader(stdout, tx);
        }
        let stderr = Arc::new(Mutex::new(StderrTail::default()));
        if let Some(pipe) = platform::take_stderr(&mut child) {
            spawn_stderr_reader(pipe, Arc::clone(&stderr));
        }
        let stdin = platform::take_stdin(&mut child);
        let pid = platform::id(&child);
        Ok((
            Self {
                child: Mutex::new(child),
                stdin: Mutex::new(stdin),
                stderr,
                pid,
                guardian_job: Mutex::new(guardian_job),
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
        let status = platform::try_wait(&mut lock(&self.child)).map_err(ProcessError::Wait)?;
        if status.is_some() {
            self.complete_guardian()?;
        }
        Ok(status)
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
        self.kill_confirmed()?;
        self.wait_timeout(Duration::from_secs(5))
    }

    /// Kills the process and everything it started. Idempotent.
    pub fn kill(&self) {
        let _ = self.kill_confirmed();
    }

    fn kill_confirmed(&self) -> Result<(), ProcessError> {
        let mut child = lock(&self.child);
        if matches!(platform::try_wait(&mut child), Ok(Some(_))) {
            drop(child);
            self.complete_guardian()?;
            return Ok(());
        }
        kill_tree(&mut child)?;
        drop(child);
        self.complete_guardian()
    }

    fn complete_guardian(&self) -> Result<(), ProcessError> {
        let mut guarded = lock(&self.guardian_job);
        let Some(job) = guarded.as_ref() else {
            return Ok(());
        };
        job.cancel_and_prove_quiescence()
            .map_err(|error| ProcessError::Guardian(error.to_string()))?;
        guarded.take();
        Ok(())
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
fn kill_tree(child: &mut platform::Child) -> Result<(), ProcessError> {
    platform::kill_tree(child).map_err(ProcessError::Terminate)
}

/// A channel receive with a deadline that tells timeouts and disconnection apart.
pub fn recv_until<T>(rx: &Receiver<T>, deadline: Instant) -> Result<T, RecvTimeoutError> {
    rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))
}

#[cfg(windows)]
mod platform {
    use process_wrap::std::{ChildWrapper, CommandWrap, CommandWrapper, CreationFlags, JobObject};
    use std::fmt;
    use std::process::{ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus};
    use std::sync::{Arc, Mutex};
    use windows::Win32::System::Threading::CREATE_NO_WINDOW;

    use crate::guardian::{GuardedJob, RegisteredJob};

    pub type Child = Box<dyn ChildWrapper>;

    pub fn configure(_command: &mut Command) {}

    pub fn spawn(command: Command) -> std::io::Result<Child> {
        let mut command = CommandWrap::from(command);
        command.wrap(CreationFlags(CREATE_NO_WINDOW));
        command.wrap(JobObject);
        command.spawn()
    }

    pub fn spawn_guarded(
        command: Command,
        admission: RegisteredJob,
    ) -> std::io::Result<(Child, Option<GuardedJob>)> {
        let committed = Arc::new(Mutex::new(None));
        let mut command = CommandWrap::from(command);
        command.wrap(CreationFlags(CREATE_NO_WINDOW));
        command.wrap(GuardianAssignment {
            admission: Some(admission),
            committed: Arc::clone(&committed),
        });
        // JobObject adds CREATE_SUSPENDED during pre_spawn and resumes only after every earlier
        // child wrapper has run. GuardianAssignment is deliberately registered first.
        command.wrap(JobObject);
        let child = command.spawn()?;
        let guarded = committed
            .lock()
            .map_err(|_| std::io::Error::other("guardian admission result was poisoned"))?
            .take()
            .ok_or_else(|| std::io::Error::other("guardian admission was not committed"))?;
        Ok((child, Some(guarded)))
    }

    struct GuardianAssignment {
        admission: Option<RegisteredJob>,
        committed: Arc<Mutex<Option<GuardedJob>>>,
    }

    impl fmt::Debug for GuardianAssignment {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter
                .debug_struct("GuardianAssignment")
                .field("prepared", &self.admission.is_some())
                .finish_non_exhaustive()
        }
    }

    impl CommandWrapper for GuardianAssignment {
        fn wrap_child(
            &mut self,
            mut child: Box<dyn ChildWrapper>,
            _core: &CommandWrap,
        ) -> std::io::Result<Box<dyn ChildWrapper>> {
            let process = child
                .process_handle()
                .or_else(|| {
                    child
                        .try_inner_child()
                        .and_then(|inner| inner.process_handle())
                })
                .ok_or_else(|| {
                    std::io::Error::other("spawned child did not expose its process handle")
                })?;
            let admission = self
                .admission
                .take()
                .ok_or_else(|| std::io::Error::other("guardian admission wrapper was replayed"))?;
            let result = admission.assign_suspended_process(process, child.id());
            match result {
                Ok(guarded) => {
                    *self.committed.lock().map_err(|_| {
                        std::io::Error::other("guardian admission result was poisoned")
                    })? = Some(guarded);
                    Ok(child)
                }
                Err(error) => {
                    let _ = child.start_kill();
                    let _ = child.wait();
                    Err(std::io::Error::other(error.to_string()))
                }
            }
        }
    }

    pub fn id(child: &Child) -> u32 {
        child.id()
    }

    pub fn take_stdin(child: &mut Child) -> Option<ChildStdin> {
        child.stdin().take()
    }

    pub fn take_stdout(child: &mut Child) -> Option<ChildStdout> {
        child.stdout().take()
    }

    pub fn take_stderr(child: &mut Child) -> Option<ChildStderr> {
        child.stderr().take()
    }

    pub fn try_wait(child: &mut Child) -> std::io::Result<Option<ExitStatus>> {
        let status = child.try_wait()?;
        if status.is_some() {
            // JobObjectChild::kill terminates any surviving descendants and its wait verifies the
            // completion-port signal for the whole job before a profile lease may be released.
            child.kill()?;
        }
        Ok(status)
    }

    pub fn kill_tree(child: &mut Child) -> std::io::Result<()> {
        child.kill()
    }
}

#[cfg(unix)]
mod platform {
    use std::os::unix::process::CommandExt;
    use std::process::{ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};

    pub type Child = std::process::Child;

    /// Each provider runs in its own process group so its whole tree can be signalled.
    pub fn configure(command: &mut Command) {
        command.process_group(0);
    }

    pub fn spawn(mut command: Command) -> std::io::Result<Child> {
        command.spawn()
    }

    pub fn spawn_guarded(
        _command: Command,
        _admission: crate::guardian::RegisteredJob,
    ) -> std::io::Result<(Child, Option<crate::guardian::GuardedJob>)> {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "the provider crash guardian requires Windows Job Objects",
        ))
    }

    pub fn id(child: &Child) -> u32 {
        child.id()
    }

    pub fn take_stdin(child: &mut Child) -> Option<ChildStdin> {
        child.stdin.take()
    }

    pub fn take_stdout(child: &mut Child) -> Option<ChildStdout> {
        child.stdout.take()
    }

    pub fn take_stderr(child: &mut Child) -> Option<ChildStderr> {
        child.stderr.take()
    }

    pub fn try_wait(child: &mut Child) -> std::io::Result<Option<ExitStatus>> {
        child.try_wait()
    }

    pub fn kill_tree(child: &mut Child) -> std::io::Result<()> {
        let pid = child.id();
        let group = Command::new("/bin/kill")
            .args(["-KILL", "--", &format!("-{pid}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        if let Ok(status) = group
            && !status.success()
            && child.try_wait()?.is_none()
        {
            return Err(std::io::Error::other(
                "couldn't terminate provider process group",
            ));
        }
        child.kill()?;
        child.wait().map(|_| ())
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

    #[cfg(windows)]
    #[test]
    fn supervised_child_waits_for_job_tree_quiescence_after_root_exit() {
        let temp = tempfile::tempdir().expect("temp");
        let marker = temp.path().join("descendant-pid");
        let marker_literal = marker.to_string_lossy().replace('\'', "''");
        let system_root = std::env::var_os("SystemRoot").expect("SystemRoot");
        let powershell = std::path::Path::new(&system_root)
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
        let command = format!(
            "$p=Start-Process -WindowStyle Hidden -FilePath '{}' -ArgumentList '-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 60' -PassThru; [IO.File]::WriteAllText('{}',[string]$p.Id)",
            powershell.to_string_lossy().replace('\'', "''"),
            marker_literal,
        );
        let env =
            crate::detect::DetectEnv::from_process().provider_env(&crate::env::EnvPolicy::BASE);
        let (child, _lines) = SupervisedChild::spawn(&ProcessSpec {
            program: powershell,
            args: vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                command.into(),
            ],
            cwd: Some(temp.path().to_path_buf()),
            env,
        })
        .expect("supervised root");
        let deadline = Instant::now() + Duration::from_secs(10);
        while !marker.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(15));
        }
        let descendant_pid = std::fs::read_to_string(&marker)
            .expect("descendant pid marker")
            .trim()
            .parse::<u32>()
            .expect("descendant pid");

        assert!(
            child
                .wait_timeout(Duration::from_secs(10))
                .expect("job wait")
                .is_some(),
            "the exited root and its descendant job must quiesce"
        );
        let tasklist = std::path::Path::new(&system_root)
            .join("System32")
            .join("tasklist.exe");
        use std::os::windows::process::CommandExt;
        let mut tasklist_command = Command::new(tasklist);
        tasklist_command.creation_flags(0x0800_0000);
        let output = tasklist_command
            .args([
                "/FI",
                &format!("PID eq {descendant_pid}"),
                "/NH",
                "/FO",
                "CSV",
            ])
            .output()
            .expect("tasklist");
        let listing = String::from_utf8_lossy(&output.stdout);
        assert!(
            !listing.contains(&format!(",\"{descendant_pid}\",")),
            "descendant remained alive after the supervised root exited: {listing}"
        );
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
