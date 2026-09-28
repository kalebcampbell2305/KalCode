//! Interactive priority: latency-critical foreground work (KalVoice push-to-talk listening and
//! transcription) asks background starts to wait, for a bounded time.
//!
//! Advisory like the rest of the crate: it never stops, suspends or re-prioritises anything.
//! A background owner calls [`InteractivePriority::yield_to_interactive`] before it *starts*
//! heavy work; running work is untouched. Every deferral is bounded twice — a span stops
//! deferring [`MAX_INTERACTIVE_DEFERRAL`] after it began even if its owner never ends it, and a
//! single wait never exceeds the caller's own bound — so nothing can be starved.

use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::{Duration, Instant};

/// The longest a single interactive span defers background starts.
pub const MAX_INTERACTIVE_DEFERRAL: Duration = Duration::from_secs(10);

/// How often a waiting caller re-checks its own cancellation.
const WAIT_SLICE: Duration = Duration::from_millis(100);

#[derive(Debug, Default)]
struct Spans {
    next_id: u64,
    /// Open spans and when each began.
    open: Vec<(u64, Instant)>,
}

impl Spans {
    /// Time left before every open span stops deferring (`None`: nothing defers now).
    fn remaining(&mut self, now: Instant, cap: Duration) -> Option<Duration> {
        self.open
            .retain(|(_, began)| now.saturating_duration_since(*began) < cap);
        self.open
            .iter()
            .map(|(_, began)| cap.saturating_sub(now.saturating_duration_since(*began)))
            .max()
    }
}

#[derive(Debug, Default)]
struct Inner {
    spans: Mutex<Spans>,
    changed: Condvar,
}

/// Shared by the interactive owner (which opens spans) and background owners (which yield).
#[derive(Debug, Clone)]
pub struct InteractivePriority {
    inner: Arc<Inner>,
    cap: Duration,
}

impl Default for InteractivePriority {
    fn default() -> Self {
        Self::with_cap(MAX_INTERACTIVE_DEFERRAL)
    }
}

/// An open interactive span; dropping it ends the span.
#[derive(Debug)]
#[must_use = "the span ends when this is dropped"]
pub struct InteractiveSpan {
    inner: Arc<Inner>,
    id: u64,
    began: Instant,
    cap: Duration,
}

impl InteractiveSpan {
    /// Whether this span has outlived its deferral bound (it no longer defers anything).
    pub fn expired(&self) -> bool {
        self.began.elapsed() >= self.cap
    }
}

impl Drop for InteractiveSpan {
    fn drop(&mut self) {
        let mut spans = self
            .inner
            .spans
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        spans.open.retain(|(id, _)| *id != self.id);
        drop(spans);
        self.inner.changed.notify_all();
    }
}

impl InteractivePriority {
    /// A gate whose spans defer for at most `cap` each (tests use a short cap).
    pub fn with_cap(cap: Duration) -> Self {
        Self {
            inner: Arc::default(),
            cap: cap.min(MAX_INTERACTIVE_DEFERRAL),
        }
    }

    /// Opens a span: background starts wait until it ends or its bound passes.
    pub fn begin(&self) -> InteractiveSpan {
        let began = Instant::now();
        let mut spans = self
            .inner
            .spans
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        spans.next_id = spans.next_id.wrapping_add(1);
        let id = spans.next_id;
        spans.open.push((id, began));
        InteractiveSpan {
            inner: self.inner.clone(),
            id,
            began,
            cap: self.cap,
        }
    }

    /// Whether a background start should wait now.
    pub fn active(&self) -> bool {
        self.inner
            .spans
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remaining(Instant::now(), self.cap)
            .is_some()
    }

    /// Blocks while an interactive span is open, for at most `max` (and never longer than
    /// [`MAX_INTERACTIVE_DEFERRAL`]), returning early once `cancelled` reports true. Returns how
    /// long it waited. Call before starting heavy background work, never while holding a lock
    /// the interactive path needs.
    pub fn yield_to_interactive(&self, max: Duration, cancelled: &dyn Fn() -> bool) -> Duration {
        let started = Instant::now();
        let limit = max.min(MAX_INTERACTIVE_DEFERRAL);
        let mut spans = self
            .inner
            .spans
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let mut blocked = false;
        loop {
            let now = Instant::now();
            let waited = if blocked {
                now.saturating_duration_since(started)
            } else {
                Duration::ZERO
            };
            let Some(remaining) = spans.remaining(now, self.cap) else {
                return waited;
            };
            if waited >= limit || cancelled() {
                return waited;
            }
            let slice = remaining.min(limit - waited).min(WAIT_SLICE);
            blocked = true;
            spans = self
                .inner
                .changed
                .wait_timeout(spans, slice)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;

    fn never() -> bool {
        false
    }

    #[test]
    fn nothing_open_means_no_wait() {
        let gate = InteractivePriority::default();
        assert!(!gate.active());
        assert_eq!(
            gate.yield_to_interactive(Duration::from_secs(5), &never),
            Duration::ZERO
        );
    }

    #[test]
    fn a_waiter_resumes_when_the_span_ends() {
        let gate = InteractivePriority::default();
        let span = gate.begin();
        assert!(gate.active());
        let waiter = {
            let gate = gate.clone();
            std::thread::spawn(move || gate.yield_to_interactive(Duration::from_secs(5), &never))
        };
        std::thread::sleep(Duration::from_millis(50));
        drop(span);
        let waited = waiter.join().expect("join");
        assert!(waited >= Duration::from_millis(40), "{waited:?}");
        assert!(waited < Duration::from_secs(2), "{waited:?}");
        assert!(!gate.active());
    }

    #[test]
    fn a_span_that_is_never_ended_stops_deferring_at_its_bound() {
        let gate = InteractivePriority::with_cap(Duration::from_millis(80));
        let span = gate.begin();
        let waited = gate.yield_to_interactive(Duration::from_secs(5), &never);
        assert!(waited >= Duration::from_millis(60), "{waited:?}");
        assert!(waited < Duration::from_secs(2), "{waited:?}");
        assert!(!gate.active(), "expired spans defer nothing");
        assert!(span.expired());
    }

    #[test]
    fn each_wait_is_bounded_by_the_caller_and_by_cancellation() {
        let gate = InteractivePriority::default();
        let _span = gate.begin();
        let waited = gate.yield_to_interactive(Duration::from_millis(60), &never);
        assert!(waited >= Duration::from_millis(50) && waited < Duration::from_secs(2));
        let stop = AtomicBool::new(false);
        let cancelled = || stop.swap(true, Ordering::SeqCst);
        let waited = gate.yield_to_interactive(Duration::from_secs(5), &cancelled);
        assert!(waited < Duration::from_secs(1), "{waited:?}");
    }

    #[test]
    fn the_cap_can_never_exceed_the_maximum() {
        let gate = InteractivePriority::with_cap(Duration::from_secs(3600));
        assert_eq!(gate.cap, MAX_INTERACTIVE_DEFERRAL);
    }

    #[test]
    fn overlapping_spans_all_have_to_end() {
        let gate = InteractivePriority::default();
        let first = gate.begin();
        let second = gate.begin();
        drop(first);
        assert!(gate.active());
        drop(second);
        assert!(!gate.active());
    }
}
