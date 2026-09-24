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
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};

pub use scrollback::Scrollback;
pub use shells::{ShellInfo, detect_shells};

/// Default scrollback retained per session for replay.
pub const SCROLLBACK_BYTES: usize = 512 * 1024;
const READ_CHUNK: usize = 16 * 1024;

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
}

pub type AttachId = u64;
type Listener = Box<dyn Fn(&[u8]) -> bool + Send + Sync>;

struct Shared {
    scrollback: Scrollback,
    listeners: HashMap<AttachId, Listener>,
}

struct Inner {
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
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
        let system = native_pty_system();
        let pair = system
            .openpty(spec.size.to_pty())
            .map_err(|e| PtyError::Spawn(e.to_string()))?;

        let mut command = CommandBuilder::new(&spec.program);
        command.args(&spec.args);
        command.cwd(&spec.cwd);
        for key in &spec.env_remove {
            command.env_remove(key);
        }
        for (key, value) in &spec.env {
            command.env(key, value);
        }
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|e| PtyError::Spawn(e.to_string()))?;
        // Dropping the slave lets the reader see end-of-file once the shell exits.
        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| PtyError::Spawn(e.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| PtyError::Spawn(e.to_string()))?;
        let killer = child.clone_killer();
        let pid = child.process_id();

        let inner = Arc::new(Inner {
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(Some(writer)),
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

        let reader_inner = inner.clone();
        std::thread::Builder::new()
            .name("kalcode-pty-reader".into())
            .spawn(move || read_loop(reader, &reader_inner))
            .map_err(|e| PtyError::Spawn(e.to_string()))?;

        let waiter_inner = inner.clone();
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
                lock(&waiter_inner.writer).take();
                lock(&waiter_inner.master).take();
                on_exit(info);
            })
            .map_err(|e| PtyError::Spawn(e.to_string()))?;

        Ok(Self { inner })
    }

    pub fn pid(&self) -> Option<u32> {
        self.inner.pid
    }

    pub fn exit_info(&self) -> Option<ExitInfo> {
        *lock(&self.inner.exit)
    }

    pub fn write(&self, data: &[u8]) -> Result<(), PtyError> {
        let mut writer = lock(&self.inner.writer);
        let writer = writer.as_mut().ok_or(PtyError::Exited)?;
        writer
            .write_all(data)
            .and_then(|()| writer.flush())
            .map_err(|e| PtyError::Io(e.to_string()))
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
        lock(&self.inner.writer).take();
        lock(&self.inner.master).take();
        // On Windows, portable-pty 0.9 inverts TerminateProcess's result (success comes back as
        // an error carrying a stale OS error), so the return value carries no information there;
        // the exit waiter observes the real outcome. Elsewhere, a failed kill is only an error if
        // the process is still running (it may have exited between the check and the kill).
        if cfg!(not(windows))
            && let Err(error) = result
            && self.exit_info().is_none()
        {
            return Err(PtyError::Io(error.to_string()));
        }
        Ok(())
    }
}

/// Device Status Report: "where is the cursor?". ConPTY sends it at startup and blocks until a
/// terminal answers.
const CURSOR_POSITION_REQUEST: &[u8] = b"\x1b[6n";
const CURSOR_POSITION_REPLY: &[u8] = b"\x1b[1;1R";

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
    if let Some(writer) = lock(&inner.writer).as_mut() {
        for _ in 0..count {
            let _ = writer.write_all(CURSOR_POSITION_REPLY);
        }
        let _ = writer.flush();
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
