//! Output coalescing for terminal views.
//!
//! A PTY reader delivers output in whatever chunks the operating system returns, which under a
//! burst (`cat` of a large file, a build log, a provider redrawing its screen) is thousands of
//! small reads per second. Each delivery to a webview costs the desktop's main thread a script
//! evaluation and, for anything over about 1 KiB, a second IPC round trip to fetch the bytes, so
//! forwarding every read one by one makes the main thread the bottleneck.
//!
//! [`OutputCoalescer`] sits between a listener and its sink and throttles deliveries:
//!
//! - **Leading edge.** Output that arrives after the view has been quiet for at least one
//!   interval is delivered at once, so an isolated keystroke echo is never delayed.
//! - **Trailing edge.** Output that arrives within an interval of the previous delivery is
//!   buffered and delivered when the interval ends, by one shared timer thread.
//! - **Size cap.** A buffer that reaches the cap is delivered immediately by the caller, so a
//!   fast producer never waits for the timer and a single delivery stays bounded.
//! - **First message.** The first push is always delivered on its own, at once: the PTY attach
//!   contract makes the first call the scrollback replay, which views tell apart from live output.
//! - **End.** Dropping the coalescer delivers whatever is still buffered. The PTY drops its
//!   listeners when the output ends, so the final bytes never wait for the timer.
//!
//! Bytes are delivered exactly once and in order: the buffer is taken and handed to the sink
//! under one lock, so the reader thread and the timer thread can never reorder two deliveries.

use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock, PoisonError, Weak};
use std::time::{Duration, Instant};

/// How long output is gathered after a delivery before the next one. Below one 60 Hz frame
/// (16.7 ms), so a coalesced burst still reaches the screen within a frame of being read.
pub const DEFAULT_INTERVAL: Duration = Duration::from_millis(8);
/// The most bytes gathered before they are delivered without waiting for the interval.
pub const DEFAULT_MAX_BYTES: usize = 64 * 1024;

/// Throttling parameters for an [`OutputCoalescer`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CoalesceConfig {
    pub interval: Duration,
    pub max_bytes: usize,
}

impl Default for CoalesceConfig {
    fn default() -> Self {
        Self {
            interval: DEFAULT_INTERVAL,
            max_bytes: DEFAULT_MAX_BYTES,
        }
    }
}

type Sink = Box<dyn FnMut(Vec<u8>) -> bool + Send>;

struct State {
    buffer: Vec<u8>,
    /// The first message (the replay) has been delivered.
    started: bool,
    /// The sink refused a delivery; nothing more is accepted.
    closed: bool,
    /// A trailing delivery is scheduled on the timer thread.
    armed: bool,
    last_delivery: Option<Instant>,
}

struct Inner {
    config: CoalesceConfig,
    /// Held while the buffer is taken *and* delivered, so deliveries keep their order.
    /// Lock order: `sink`, then `state`.
    sink: Mutex<Sink>,
    state: Mutex<State>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Inner {
    /// Delivers the buffer (always the first message, even when empty). `from_timer` disarms
    /// the scheduled delivery in the same critical section that takes the buffer.
    fn deliver(&self, from_timer: bool) -> bool {
        let mut sink = lock(&self.sink);
        let data = {
            let mut state = lock(&self.state);
            if from_timer {
                state.armed = false;
            }
            if state.closed {
                return false;
            }
            if state.started && state.buffer.is_empty() {
                return true;
            }
            state.started = true;
            state.last_delivery = Some(Instant::now());
            std::mem::take(&mut state.buffer)
        };
        let delivered = (*sink)(data);
        if !delivered {
            lock(&self.state).closed = true;
        }
        delivered
    }
}

/// Throttles one view's output stream. See the [module documentation](self).
pub struct OutputCoalescer {
    inner: Arc<Inner>,
}

impl OutputCoalescer {
    /// `sink` receives each delivery and returns `false` once it can take no more (its view went
    /// away); every later [`push`](Self::push) then returns `false` too.
    pub fn new(config: CoalesceConfig, sink: impl FnMut(Vec<u8>) -> bool + Send + 'static) -> Self {
        Self {
            inner: Arc::new(Inner {
                config,
                sink: Mutex::new(Box::new(sink)),
                state: Mutex::new(State {
                    buffer: Vec::new(),
                    started: false,
                    closed: false,
                    armed: false,
                    last_delivery: None,
                }),
            }),
        }
    }

    /// Accepts output for delivery. Returns `false` once the sink has refused a delivery, which
    /// is the PTY listener contract for "detach me".
    pub fn push(&self, bytes: &[u8]) -> bool {
        let mut state = lock(&self.inner.state);
        if state.closed {
            return false;
        }
        state.buffer.extend_from_slice(bytes);
        let interval = self.inner.config.interval;
        // When the last delivery was less than an interval ago: when the interval ends.
        let interval_end = state
            .last_delivery
            .map(|last| last + interval)
            .filter(|end| Instant::now() < *end);
        let deliver_now = !state.started
            || state.buffer.len() >= self.inner.config.max_bytes
            || !state.armed && interval_end.is_none();
        if !deliver_now {
            if state.armed {
                return true;
            }
            // Not armed and not delivered now means a delivery happened within this interval.
            if let (Some(due), Some(timer)) = (interval_end, scheduler()) {
                state.armed = true;
                drop(state);
                timer.schedule(due, Arc::downgrade(&self.inner));
                return true;
            }
        }
        drop(state);
        self.inner.deliver(false)
    }
}

impl Drop for OutputCoalescer {
    fn drop(&mut self) {
        // The listener holding this coalescer was released (detach, lag, or the end of the
        // output): hand over what is buffered instead of waiting for the timer. A coalescer that
        // never delivered was never attached (no session to show), so it sends nothing at all.
        if lock(&self.inner.state).started {
            let _ = self.inner.deliver(false);
        }
    }
}

/// One timer thread for every coalescer in the process. Each coalescer has at most one pending
/// entry, so a linear scan over the entries is cheaper than a heap at these sizes.
struct Scheduler {
    pending: Mutex<Vec<(Instant, Weak<Inner>)>>,
    wake: Condvar,
}

/// The shared timer, or `None` when its thread could not be started; coalescers then deliver
/// every push at once, exactly as if there were no coalescing.
fn scheduler() -> Option<&'static Scheduler> {
    static SCHEDULER: OnceLock<Scheduler> = OnceLock::new();
    static STARTED: OnceLock<bool> = OnceLock::new();
    let scheduler = SCHEDULER.get_or_init(|| Scheduler {
        pending: Mutex::new(Vec::new()),
        wake: Condvar::new(),
    });
    let started = *STARTED.get_or_init(|| {
        std::thread::Builder::new()
            .name("kalcode-pty-coalesce".into())
            .spawn(move || scheduler.run())
            .inspect_err(|error| {
                tracing::error!(event = "pty.coalesce_timer_unavailable", error = %error);
            })
            .is_ok()
    });
    started.then_some(scheduler)
}

impl Scheduler {
    fn schedule(&self, due: Instant, target: Weak<Inner>) {
        lock(&self.pending).push((due, target));
        self.wake.notify_one();
    }

    fn run(&self) {
        let mut pending = lock(&self.pending);
        loop {
            let now = Instant::now();
            let mut due = Vec::new();
            pending.retain(|(at, target)| {
                if *at <= now {
                    due.push(target.clone());
                    false
                } else {
                    true
                }
            });
            if !due.is_empty() {
                drop(pending);
                for target in due {
                    if let Some(inner) = target.upgrade() {
                        let _ = inner.deliver(true);
                    }
                }
                pending = lock(&self.pending);
                continue;
            }
            pending = match pending.iter().map(|(at, _)| *at).min() {
                Some(next) => {
                    self.wake
                        .wait_timeout(pending, next.saturating_duration_since(now))
                        .unwrap_or_else(PoisonError::into_inner)
                        .0
                }
                None => self
                    .wake
                    .wait(pending)
                    .unwrap_or_else(PoisonError::into_inner),
            };
        }
    }
}

#[cfg(test)]
#[path = "coalesce_tests.rs"]
mod tests;
