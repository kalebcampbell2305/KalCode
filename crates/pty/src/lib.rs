//! KalCode terminal sessions.
//!
//! A [`PtySession`] runs one shell in a native pseudo-terminal (ConPTY on Windows, openpty on
//! macOS/Linux). It keeps a bounded scrollback so a view that re-attaches can replay output,
//! streams new output to attached listeners, accepts input and resizes, and reports the exit.
//! [`detect_shells`] lists shells present on this machine without changing anything.

mod scrollback;
mod shells;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError, sync_channel};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};

pub use scrollback::Scrollback;
pub use shells::{ShellInfo, detect_shells};

/// Default scrollback retained per session for replay.
pub const SCROLLBACK_BYTES: usize = 512 * 1024;
const READ_CHUNK: usize = 16 * 1024;
/// Input writes queued for the writer thread before `write` reports the terminal busy.
const INPUT_QUEUE: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalSize {
    pub cols: u16,
    pub rows: u16,
}

impl TerminalSize {
    pub const MIN: u16 = 2;
    pub const MAX: u16 = 1000;

    /// Validated constructor: both dimensions must be within 2..=1000.
    pub fn new(cols: u16, rows: u16) -> Result<Self, PtyError> {
        let valid = |n: u16| (Self::MIN..=Self::MAX).contains(&n);
        if valid(cols) && valid(rows) {
            Ok(Self { cols, rows })
        } else {
            Err(PtyError::InvalidSize)
        }
    }

    fn to_pty(self) -> PtySize {
        PtySize {
            rows: self.rows,
            cols: self.cols,
            pixel_width: 0,
            pixel_height: 0,
        }
    }
}

/// What to run. Built natively from a detected shell; never from WebView input.
#[derive(Debug, Clone)]
pub struct SpawnSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
    /// Variables removed from the inherited environment (KalCode's own settings and test hooks
    /// must not leak into the user's shell).
    pub env_remove: Vec<String>,
    pub size: TerminalSize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExitInfo {
    /// Process exit code (Windows: the full exit code; Unix: the status, or 1 for signals).
    pub code: u32,
    pub success: bool,
    /// True when the session was closed by KalCode rather than exiting on its own.
    pub killed: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum PtyError {
    #[error("terminal size out of range")]
    InvalidSize,
    #[error("the terminal has exited")]
    Exited,
    #[error("could not start the terminal: {0}")]
    Spawn(String),
    #[error("terminal I/O failed: {0}")]
    Io(String),
    #[error("the terminal is not reading input")]
    Busy,
}

pub type AttachId = u64;
type Listener = Box<dyn Fn(&[u8]) -> bool + Send + Sync>;

struct Shared {
    scrollback: Scrollback,
    listeners: HashMap<AttachId, Listener>,
}

struct Inner {
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    /// Input queue drained by the writer thread, so `write` never blocks its caller (a shell
    /// that stops reading would otherwise stall it) and writes keep their order.
    input: Mutex<Option<SyncSender<Vec<u8>>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    shared: Mutex<Shared>,
    exit: Mutex<Option<ExitInfo>>,
    killed: std::sync::atomic::AtomicBool,
    next_attach: AtomicU64,
    pid: Option<u32>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A running (or exited) shell. Cloning shares the same session.
#[derive(Clone)]
pub struct PtySession {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for PtySession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PtySession")
            .field("pid", &self.inner.pid)
            .finish_non_exhaustive()
    }
}

impl PtySession {
    /// Starts `spec`. `on_exit` runs once, on a background thread, when the process ends.
    pub fn spawn(
        spec: SpawnSpec,
        on_exit: impl FnOnce(ExitInfo) + Send + 'static,
    ) -> Result<Self, PtyError> {
        preflight_program(&spec.program)?;
        let system = native_pty_system();
        let pair = system
            .openpty(spec.size.to_pty())
            .map_err(|e| PtyError::Spawn(e.to_string()))?;

        let command = build_command(&spec);
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|e| PtyError::Spawn(e.to_string()))?;
        // Dropping the slave lets the reader see end-of-file once the shell exits.
        drop(pair.slave);

        // From here on a failure must not leave the started shell running.
        let started = (|| {
            let reader = pair.master.try_clone_reader()?;
            let writer = pair.master.take_writer()?;
            Ok::<_, Box<dyn std::error::Error + Send + Sync>>((reader, writer))
        })();
        let (reader, writer) = match started {
            Ok(io) => io,
            Err(error) => {
                let _ = child.kill();
                return Err(PtyError::Spawn(error.to_string()));
            }
        };
        let killer = child.clone_killer();
        let pid = child.process_id();

        let (input, queued) = sync_channel::<Vec<u8>>(INPUT_QUEUE);
        let inner = Arc::new(Inner {
            master: Mutex::new(Some(pair.master)),
            input: Mutex::new(Some(input)),
            killer: Mutex::new(killer),
            shared: Mutex::new(Shared {
                scrollback: Scrollback::new(SCROLLBACK_BYTES),
                listeners: HashMap::new(),
            }),
            exit: Mutex::new(None),
            killed: std::sync::atomic::AtomicBool::new(false),
            next_attach: AtomicU64::new(1),
            pid,
        });

        let spawn_failed =
            |error: std::io::Error, killer: &mut Box<dyn ChildKiller + Send + Sync>| {
                let _ = killer.kill();
                PtyError::Spawn(error.to_string())
            };
        std::thread::Builder::new()
            .name("kalcode-pty-writer".into())
            .spawn(move || write_loop(writer, &queued))
            .map_err(|e| spawn_failed(e, &mut lock(&inner.killer)))?;

        let reader_inner = inner.clone();
        std::thread::Builder::new()
            .name("kalcode-pty-reader".into())
            .spawn(move || read_loop(reader, &reader_inner))
            .map_err(|e| spawn_failed(e, &mut lock(&inner.killer)))?;

        let waiter_inner = inner.clone();
        let waiter_killer = &inner.killer;
        std::thread::Builder::new()
            .name("kalcode-pty-wait".into())
            .spawn(move || {
                let status = child.wait();
                let killed = waiter_inner.killed.load(Ordering::SeqCst);
                let info = match status {
                    Ok(status) => ExitInfo {
                        code: status.exit_code(),
                        success: status.success() && !killed,
                        killed,
                    },
                    Err(_) => ExitInfo {
                        code: 1,
                        success: false,
                        killed,
                    },
                };
                *lock(&waiter_inner.exit) = Some(info);
                // Release the pseudo-terminal so the reader reaches end-of-file.
                lock(&waiter_inner.input).take();
                lock(&waiter_inner.master).take();
                on_exit(info);
            })
            .map_err(|e| spawn_failed(e, &mut lock(waiter_killer)))?;

        Ok(Self { inner })
    }

    pub fn pid(&self) -> Option<u32> {
        self.inner.pid
    }

    pub fn exit_info(&self) -> Option<ExitInfo> {
        *lock(&self.inner.exit)
    }

    /// Queues input for the shell. Never blocks; writes are delivered in order.
    pub fn write(&self, data: &[u8]) -> Result<(), PtyError> {
        let input = lock(&self.inner.input);
        let input = input.as_ref().ok_or(PtyError::Exited)?;
        input.try_send(data.to_vec()).map_err(|e| match e {
            TrySendError::Full(_) => PtyError::Busy,
            TrySendError::Disconnected(_) => PtyError::Exited,
        })
    }

    pub fn resize(&self, size: TerminalSize) -> Result<(), PtyError> {
        let master = lock(&self.inner.master);
        let master = master.as_ref().ok_or(PtyError::Exited)?;
        master
            .resize(size.to_pty())
            .map_err(|e| PtyError::Io(e.to_string()))
    }

    /// Replays the scrollback to `listener`, then streams new output to it. Replay and
    /// registration happen under one lock, so no output is lost or duplicated between them.
    /// The first call to `listener` is always the replay (empty when there is no output yet),
    /// so a view can tell history from live output. The listener returns `false` to detach
    /// itself (e.g. its channel closed).
    pub fn attach(&self, listener: impl Fn(&[u8]) -> bool + Send + Sync + 'static) -> AttachId {
        let id = self.inner.next_attach.fetch_add(1, Ordering::Relaxed);
        let mut shared = lock(&self.inner.shared);
        let replay = shared.scrollback.contents();
        if listener(&replay) {
            shared.listeners.insert(id, Box::new(listener));
        }
        id
    }

    pub fn detach(&self, id: AttachId) -> bool {
        lock(&self.inner.shared).listeners.remove(&id).is_some()
    }

    /// Ends the shell. Closing the pseudo-terminal also ends programs started from it
    /// (on Windows, every process attached to the console receives the close event).
    pub fn kill(&self) -> Result<(), PtyError> {
        if self.exit_info().is_some() {
            return Ok(());
        }
        self.inner.killed.store(true, Ordering::SeqCst);
        let result = lock(&self.inner.killer).kill();
        lock(&self.inner.input).take();
        lock(&self.inner.master).take();
        // On Windows, portable-pty 0.9 inverts TerminateProcess's result (success comes back as
        // an error carrying a stale OS error), so the return value carries no information there;
        // the exit waiter observes the real outcome. Elsewhere, a failed kill is only an error if
        // the process is still running (it may have exited between the check and the kill).
        #[cfg(unix)]
        escalate_kill(self);
        if cfg!(not(windows))
            && let Err(error) = result
            && self.exit_info().is_none()
        {
            return Err(PtyError::Io(error.to_string()));
        }
        Ok(())
    }
}

/// The shell must be an absolute path to an existing regular file. Checked before anything reaches
/// portable-pty: a missing program would make it search `PATH` (see [`sanitized_pathext`]), and a
/// relative one would be resolved against folders KalCode doesn't control.
fn preflight_program(program: &Path) -> Result<(), PtyError> {
    if !program.is_absolute() {
        tracing::warn!(event = "pty.program_not_absolute");
        return Err(PtyError::Spawn(
            "the shell must be given as an absolute path".into(),
        ));
    }
    match std::fs::canonicalize(program).and_then(std::fs::metadata) {
        Ok(meta) if meta.is_file() => Ok(()),
        Ok(_) => Err(PtyError::Spawn("the shell is not a program file".into())),
        Err(_) => Err(PtyError::Spawn(
            "the shell program no longer exists; choose another shell".into(),
        )),
    }
}

/// The portable-pty command for `spec`.
fn build_command(spec: &SpawnSpec) -> CommandBuilder {
    let mut command = CommandBuilder::new(&spec.program);
    command.args(&spec.args);
    command.cwd(&spec.cwd);
    for key in &spec.env_remove {
        command.env_remove(key);
    }
    for (key, value) in &spec.env {
        command.env(key, value);
    }
    // portable-pty 0.9 (`CommandBuilder::search_path`, Windows) slices every PATHEXT entry with
    // `&ext[1..]` and `expect`s UTF-8, so an empty, one-character or non-UTF-8 entry panics (an
    // abort in release builds) whenever the program isn't found at its exact path. The program
    // is checked first ([`preflight_program`]), but it can disappear between the check and the
    // spawn, so the child's PATHEXT is always made safe too.
    #[cfg(windows)]
    if let Some(pathext) = command.get_env("PATHEXT").map(sanitized_pathext) {
        command.env("PATHEXT", pathext);
    }
    command
}

/// PATHEXT keeping only well-formed entries (`.` followed by ASCII letters or digits), or the
/// Windows default when none remain.
#[cfg_attr(not(windows), allow(dead_code))]
fn sanitized_pathext(value: &std::ffi::OsStr) -> std::ffi::OsString {
    let kept: Vec<&str> = value
        .to_str()
        .map(|text| {
            text.split(';')
                .map(str::trim)
                .filter(|ext| {
                    ext.len() >= 2
                        && ext.starts_with('.')
                        && ext[1..].bytes().all(|b| b.is_ascii_alphanumeric())
                })
                .collect()
        })
        .unwrap_or_default();
    if kept.is_empty() {
        ".COM;.EXE;.BAT;.CMD".into()
    } else {
        kept.join(";").into()
    }
}

/// On Unix the shell gets SIGHUP when its pseudo-terminal closes, but a shell or job that ignores
/// it would keep running. The shell leads its own session and process group (portable-pty calls
/// `setsid`), so after a grace period the whole group is killed with SIGKILL.
#[cfg(unix)]
fn escalate_kill(session: &PtySession) {
    const GRACE: std::time::Duration = std::time::Duration::from_secs(3);
    let Some(pid) = session.inner.pid else {
        return;
    };
    let inner = session.inner.clone();
    let _ = std::thread::Builder::new()
        .name("kalcode-pty-reaper".into())
        .spawn(move || {
            std::thread::sleep(GRACE);
            if lock(&inner.exit).is_none() {
                tracing::warn!(event = "pty.kill_escalated", pid);
                // `kill -KILL -- -PGID` signals every process in the shell's group.
                let _ = std::process::Command::new("kill")
                    .args(["-KILL", "--", &format!("-{pid}")])
                    .status();
            }
        });
}

/// Device Status Report: "where is the cursor?". ConPTY sends it at startup and blocks until a
/// terminal answers.
const CURSOR_POSITION_REQUEST: &[u8] = b"\x1b[6n";
const CURSOR_POSITION_REPLY: &[u8] = b"\x1b[1;1R";

fn write_loop(mut writer: Box<dyn Write + Send>, queued: &Receiver<Vec<u8>>) {
    // Ends when the session drops its sender (exit or kill) or the pseudo-terminal closes.
    for data in queued {
        if let Err(error) = writer.write_all(&data).and_then(|()| writer.flush()) {
            tracing::debug!(event = "pty.write_ended", error = %error);
            break;
        }
    }
}

fn read_loop(mut reader: Box<dyn Read + Send>, inner: &Inner) {
    let mut buffer = vec![0u8; READ_CHUNK];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                let mut shared = lock(&inner.shared);
                let chunk = if shared.listeners.is_empty() {
                    // No terminal view is attached to answer, so answer here — otherwise the
                    // shell waits forever.
                    answer_cursor_requests(&buffer[..n], inner)
                } else {
                    std::borrow::Cow::Borrowed(&buffer[..n])
                };
                if chunk.is_empty() {
                    continue;
                }
                // Requests are never kept in the scrollback: a view that re-attaches must not
                // answer a request that was already answered.
                shared.scrollback.push(&strip_cursor_requests(&chunk));
                shared.listeners.retain(|_, deliver| deliver(&chunk));
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => {
                tracing::debug!(event = "pty.read_ended", error = %error);
                break;
            }
        }
    }
}

/// Replies to each cursor-position request in `chunk` and returns the chunk without them.
fn answer_cursor_requests<'a>(chunk: &'a [u8], inner: &Inner) -> std::borrow::Cow<'a, [u8]> {
    let count = chunk
        .windows(CURSOR_POSITION_REQUEST.len())
        .filter(|w| *w == CURSOR_POSITION_REQUEST)
        .count();
    if count == 0 {
        return std::borrow::Cow::Borrowed(chunk);
    }
    if let Some(input) = lock(&inner.input).as_ref() {
        for _ in 0..count {
            let _ = input.try_send(CURSOR_POSITION_REPLY.to_vec());
        }
    }
    std::borrow::Cow::Owned(strip_all(chunk, CURSOR_POSITION_REQUEST))
}

fn strip_cursor_requests(chunk: &[u8]) -> std::borrow::Cow<'_, [u8]> {
    if chunk
        .windows(CURSOR_POSITION_REQUEST.len())
        .any(|w| w == CURSOR_POSITION_REQUEST)
    {
        std::borrow::Cow::Owned(strip_all(chunk, CURSOR_POSITION_REQUEST))
    } else {
        std::borrow::Cow::Borrowed(chunk)
    }
}

fn strip_all(haystack: &[u8], needle: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(haystack.len());
    let mut i = 0;
    while i < haystack.len() {
        if haystack[i..].starts_with(needle) {
            i += needle.len();
        } else {
            out.push(haystack[i]);
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests;
