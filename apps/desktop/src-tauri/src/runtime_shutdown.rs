//! Serialize shutdown and cache success only. A failed preflight must remain retryable.

use std::sync::{Mutex, PoisonError};

/// UI callbacks never wait on the shutdown mutex; the worker may need the UI thread to close
/// child webviews. Atomics let the UI prevent duplicate exits without blocking its event loop.
#[derive(Default)]
pub struct ExitControl {
    pub requested: std::sync::atomic::AtomicBool,
    pub ready: std::sync::atomic::AtomicBool,
    /// Set once `RunEvent::Exit` arrives: the event loop is gone and the main thread is blocked in
    /// the final cleanup, so work queued for the main thread would never run. Cleanup must not
    /// wait on it.
    pub event_loop_ended: std::sync::atomic::AtomicBool,
}

impl ExitControl {
    pub fn event_loop_ended(&self) -> bool {
        self.event_loop_ended
            .load(std::sync::atomic::Ordering::Acquire)
    }
}

#[derive(Default)]
pub struct RuntimeShutdown(Mutex<bool>);

impl RuntimeShutdown {
    pub fn run(&self, shutdown: impl FnOnce() -> bool) -> bool {
        let mut complete = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if *complete {
            return true;
        }
        let succeeded = shutdown();
        *complete = succeeded;
        succeeded
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier};

    #[test]
    fn failed_preflight_retries_and_completed_cleanup_is_not_repeated() {
        let state = RuntimeShutdown::default();
        let attempts = AtomicUsize::new(0);
        assert!(!state.run(|| {
            attempts.fetch_add(1, Ordering::SeqCst);
            false
        }));
        assert!(state.run(|| {
            attempts.fetch_add(1, Ordering::SeqCst);
            true
        }));
        assert!(state.run(|| panic!("completed shutdown must not run again")));
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn concurrent_exit_and_install_requests_share_one_completed_cleanup() {
        let state = Arc::new(RuntimeShutdown::default());
        let start = Arc::new(Barrier::new(8));
        let attempts = Arc::new(AtomicUsize::new(0));
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let state = state.clone();
                let start = start.clone();
                let attempts = attempts.clone();
                std::thread::spawn(move || {
                    start.wait();
                    state.run(|| {
                        attempts.fetch_add(1, Ordering::SeqCst);
                        true
                    })
                })
            })
            .collect();
        for worker in workers {
            assert!(worker.join().unwrap());
        }
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }
}
