//! Exit participant for native update preparation, independent of runtime leases.
use std::sync::{Condvar, Mutex, PoisonError};
use std::time::{Duration, Instant};

#[derive(Default)]
struct State {
    running: bool,
    closing: bool,
    generation: u64,
}

#[derive(Default)]
pub struct UpdatePreparation {
    state: Mutex<State>,
    changed: Condvar,
}

pub struct Preparation<'a> {
    gate: &'a UpdatePreparation,
    generation: u64,
}

impl UpdatePreparation {
    pub fn begin(&self) -> Option<Preparation<'_>> {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.closing || state.running {
            return None;
        }
        state.running = true;
        Some(Preparation {
            gate: self,
            generation: state.generation,
        })
    }

    pub fn cancel_and_wait(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.closing = true;
        state.generation = state.generation.wrapping_add(1);
        while state.running {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            (state, _) = self
                .changed
                .wait_timeout(state, remaining)
                .unwrap_or_else(PoisonError::into_inner);
        }
        true
    }

    pub fn reopen(&self) {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .closing = false;
    }
}

impl Preparation<'_> {
    pub fn cancelled(&self) -> bool {
        let state = self
            .gate
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        state.closing || state.generation != self.generation
    }
}

impl Drop for Preparation<'_> {
    fn drop(&mut self) {
        self.gate
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .running = false;
        self.gate.changed.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quit_waits_for_cleanup_and_refuses_new_preparation() {
        let gate = UpdatePreparation::default();
        let preparation = gate.begin().unwrap();
        assert!(!gate.cancel_and_wait(Duration::ZERO));
        assert!(preparation.cancelled());
        assert!(gate.begin().is_none());
        drop(preparation);
        assert!(gate.cancel_and_wait(Duration::ZERO));
        assert!(gate.begin().is_none());
    }

    #[test]
    fn failed_quit_retry_cannot_uncancel_old_worker() {
        let gate = UpdatePreparation::default();
        let preparation = gate.begin().unwrap();
        assert!(!gate.cancel_and_wait(Duration::ZERO));
        gate.reopen();
        assert!(preparation.cancelled());
        assert!(gate.begin().is_none());
        drop(preparation);
        let next = gate.begin().unwrap();
        assert!(!next.cancelled());
    }

    #[test]
    fn quit_joins_worker_after_cleanup() {
        let gate = UpdatePreparation::default();
        let preparation = gate.begin().unwrap();
        std::thread::scope(|scope| {
            let worker = scope.spawn(|| {
                let deadline = Instant::now() + Duration::from_secs(5);
                while !preparation.cancelled() {
                    assert!(Instant::now() < deadline, "quit did not cancel preparation");
                    std::thread::yield_now();
                }
                drop(preparation);
            });
            assert!(gate.cancel_and_wait(Duration::from_secs(5)));
            worker.join().unwrap();
        });
    }
}
