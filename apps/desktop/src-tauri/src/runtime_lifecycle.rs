//! Epoch admission for the desktop runtime. Effects and cleanup run outside this lock.

use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Phase {
    #[default]
    SignedOut,
    Starting,
    Ready,
    Draining,
    BlockedUnclean,
    AppExiting,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Epoch {
    pub generation: u64,
    pub epoch: u64,
}

#[derive(Default)]
struct State {
    phase: Phase,
    current: Option<Epoch>,
    next_epoch: u64,
    building: bool,
    in_flight: usize,
    exiting: bool,
    mutations: usize,
    admission_revision: u64,
}

#[derive(Clone, Default)]
pub struct Lifecycle(Arc<Mutex<State>>);

impl Lifecycle {
    pub fn block_unclean(&self) {
        let mut state = self.lock();
        state.phase = if state.exiting {
            Phase::AppExiting
        } else {
            Phase::BlockedUnclean
        };
    }

    pub fn begin_build(&self, generation: u64) -> Option<BuildPermit> {
        self.begin_start(generation).map(|epoch| BuildPermit {
            lifecycle: self.clone(),
            epoch,
            published: false,
        })
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        match self.0.lock() {
            Ok(state) => state,
            Err(poisoned) => {
                let mut state = poisoned.into_inner();
                state.phase = if state.exiting {
                    Phase::AppExiting
                } else {
                    Phase::BlockedUnclean
                };
                state
            }
        }
    }

    pub fn acquire_mutation(&self) -> Option<MutationLease> {
        let mut state = self.lock();
        if !matches!(
            state.phase,
            Phase::SignedOut | Phase::Starting | Phase::Ready
        ) || state.exiting
        {
            return None;
        }
        state.mutations = state.mutations.checked_add(1)?;
        Some(MutationLease {
            lifecycle: self.clone(),
            revision: state.admission_revision,
        })
    }
    pub fn phase(&self) -> Phase {
        self.lock().phase
    }

    pub fn begin_start(&self, generation: u64) -> Option<Epoch> {
        let mut state = self.lock();
        if state.phase != Phase::SignedOut || state.exiting {
            return None;
        }
        state.next_epoch = state.next_epoch.checked_add(1)?;
        let epoch = Epoch {
            generation,
            epoch: state.next_epoch,
        };
        state.current = Some(epoch);
        state.building = true;
        state.phase = Phase::Starting;
        Some(epoch)
    }

    /// Publish only after external account authority has been revalidated. A rejected builder
    /// must finish cleaning its partial bundle before calling `finish_start`.
    pub fn publish(&self, epoch: Epoch) -> bool {
        let mut state = self.lock();
        if state.current != Some(epoch) || state.phase != Phase::Starting || state.exiting {
            return false;
        }
        state.building = false;
        state.phase = Phase::Ready;
        true
    }

    pub fn finish_start(&self, epoch: Epoch) {
        let mut state = self.lock();
        if state.current == Some(epoch) {
            state.building = false;
        }
    }

    pub fn acquire(&self, generation: u64) -> Option<Lease> {
        let mut state = self.lock();
        let epoch = state.current?;
        if state.phase != Phase::Ready || epoch.generation != generation || state.exiting {
            return None;
        }
        state.in_flight = state.in_flight.checked_add(1)?;
        Some(Lease {
            lifecycle: self.clone(),
            epoch,
        })
    }

    /// Linearization point: new and queued command leases stop being valid before cleanup.
    pub fn begin_drain(&self, exiting: bool) -> Option<Epoch> {
        let mut state = self.lock();
        if matches!(
            state.phase,
            Phase::SignedOut | Phase::Starting | Phase::Ready
        ) {
            state.admission_revision = state.admission_revision.saturating_add(1);
        }
        state.exiting |= exiting;
        state.phase = if state.exiting {
            Phase::AppExiting
        } else {
            Phase::Draining
        };
        state.current
    }

    pub fn finish_empty_drain(&self) -> bool {
        // A poisoned authority cannot be recovered by retrying UI startup.
        let Ok(mut state) = self.0.lock() else {
            return false;
        };
        if state.current.is_none()
            && !state.building
            && state.in_flight == 0
            && state.mutations == 0
            && !state.exiting
            && matches!(state.phase, Phase::Draining | Phase::BlockedUnclean)
        {
            state.phase = Phase::SignedOut;
            true
        } else {
            false
        }
    }

    /// `clean` must come from actual service/guardian cleanup, never registry emptiness.
    /// Ownership is retained whenever construction, commands or cleanup remain outstanding.
    pub fn finish_drain(&self, epoch: Epoch, clean: bool) -> bool {
        let mut state = self.lock();
        if state.current != Some(epoch)
            || !matches!(
                state.phase,
                Phase::Draining | Phase::BlockedUnclean | Phase::AppExiting
            )
        {
            return false;
        }
        if !clean || state.building || state.in_flight != 0 || state.mutations != 0 {
            state.phase = if state.exiting {
                Phase::AppExiting
            } else {
                Phase::BlockedUnclean
            };
            return false;
        }
        state.current = None;
        state.phase = if state.exiting {
            Phase::AppExiting
        } else {
            Phase::SignedOut
        };
        true
    }

    pub fn pending(&self) -> (bool, usize) {
        let state = self.lock();
        (
            state.building,
            state.in_flight.saturating_add(state.mutations),
        )
    }
}

pub struct BuildPermit {
    lifecycle: Lifecycle,
    epoch: Epoch,
    published: bool,
}

impl BuildPermit {
    pub fn publish(&mut self) -> bool {
        self.published = self.lifecycle.publish(self.epoch);
        self.published
    }
}

impl Drop for BuildPermit {
    fn drop(&mut self) {
        if !self.published {
            self.lifecycle.begin_drain(false);
            self.lifecycle.finish_start(self.epoch);
        }
    }
}

pub struct MutationLease {
    lifecycle: Lifecycle,
    revision: u64,
}

impl MutationLease {
    pub fn valid(&self) -> bool {
        let state = self.lifecycle.lock();
        state.admission_revision == self.revision
            && !state.exiting
            && matches!(
                state.phase,
                Phase::SignedOut | Phase::Starting | Phase::Ready
            )
    }
}

impl Drop for MutationLease {
    fn drop(&mut self) {
        self.lifecycle.lock().mutations -= 1;
    }
}

pub struct Lease {
    lifecycle: Lifecycle,
    pub epoch: Epoch,
}

impl Lease {
    pub fn valid(&self) -> bool {
        let state = self.lifecycle.lock();
        state.phase == Phase::Ready && state.current == Some(self.epoch) && !state.exiting
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        let mut state = self.lifecycle.lock();
        if state.current == Some(self.epoch) {
            state.in_flight = state.in_flight.saturating_sub(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleaned_failed_start_can_retry_without_a_restart() {
        let lifecycle = Lifecycle::default();
        let epoch = lifecycle.begin_start(7).unwrap();
        lifecycle.begin_drain(false);
        lifecycle.finish_start(epoch);
        assert!(lifecycle.finish_drain(epoch, true));
        lifecycle.block_unclean();
        assert!(lifecycle.finish_empty_drain());
        let replacement = lifecycle
            .begin_start(7)
            .expect("same restored account retries startup");
        assert_ne!(replacement.epoch, epoch.epoch);
        assert!(lifecycle.publish(replacement));
    }

    #[test]
    fn empty_recovery_never_discards_build_leases_mutations_or_exit() {
        let lifecycle = Lifecycle::default();
        let mutation = lifecycle.acquire_mutation().unwrap();
        lifecycle.block_unclean();
        assert!(!lifecycle.finish_empty_drain());
        drop(mutation);
        assert!(lifecycle.finish_empty_drain());
        let epoch = lifecycle.begin_start(7).unwrap();
        lifecycle.block_unclean();
        assert!(!lifecycle.finish_empty_drain());
        lifecycle.finish_start(epoch);
        assert!(
            !lifecycle.finish_empty_drain(),
            "unproved epoch cleanup is retained"
        );
        assert!(lifecycle.finish_drain(epoch, true));
        let epoch = lifecycle.begin_start(7).unwrap();
        assert!(lifecycle.publish(epoch));
        let lease = lifecycle.acquire(7).unwrap();
        lifecycle.block_unclean();
        assert!(!lifecycle.finish_empty_drain());
        drop(lease);
        assert!(!lifecycle.finish_empty_drain());
        assert!(lifecycle.finish_drain(epoch, true));
        lifecycle.begin_drain(true);
        assert!(!lifecycle.finish_empty_drain());
        assert!(lifecycle.begin_start(7).is_none());
    }

    #[test]
    fn signed_out_cannot_acquire_or_publish_without_start() {
        let lifecycle = Lifecycle::default();
        assert_eq!(lifecycle.phase(), Phase::SignedOut);
        assert!(lifecycle.acquire(1).is_none());
    }

    #[test]
    fn duplicate_activation_starts_once_and_refresh_keeps_epoch() {
        let lifecycle = Lifecycle::default();
        let start = lifecycle.begin_start(7).unwrap();
        assert!(lifecycle.begin_start(7).is_none());
        assert!(lifecycle.publish(start));
        let lease = lifecycle.acquire(7).unwrap();
        assert!(lifecycle.begin_start(7).is_none());
        assert!(lease.valid());
        assert_eq!(lifecycle.phase(), Phase::Ready);
    }

    #[test]
    fn logout_during_partial_start_rejects_late_publish_and_relogin() {
        let lifecycle = Lifecycle::default();
        let start = lifecycle.begin_start(1).unwrap();
        let drain = lifecycle.begin_drain(false).unwrap();
        assert!(!lifecycle.publish(start));
        assert!(lifecycle.begin_start(2).is_none());
        assert!(!lifecycle.finish_drain(drain, true));
        lifecycle.finish_start(start);
        assert!(lifecycle.finish_drain(drain, true));
        assert!(lifecycle.begin_start(2).is_some());
    }

    #[test]
    fn queued_old_epoch_work_is_invalidated_before_cleanup() {
        let lifecycle = Lifecycle::default();
        assert!(lifecycle.publish(lifecycle.begin_start(1).unwrap()));
        let queued = lifecycle.acquire(1).unwrap();
        let drain = lifecycle.begin_drain(false).unwrap();
        assert!(!queued.valid());
        assert!(lifecycle.acquire(1).is_none());
        assert!(!lifecycle.finish_drain(drain, true));
        drop(queued);
        assert!(lifecycle.finish_drain(drain, true));
    }

    #[test]
    fn cleanup_failure_blocks_relogin_and_retains_retry_identity() {
        let lifecycle = Lifecycle::default();
        assert!(lifecycle.publish(lifecycle.begin_start(1).unwrap()));
        let drain = lifecycle.begin_drain(false).unwrap();
        assert!(!lifecycle.finish_drain(drain, false));
        assert_eq!(lifecycle.phase(), Phase::BlockedUnclean);
        assert!(lifecycle.begin_start(2).is_none());
        assert!(lifecycle.acquire_mutation().is_none());
        assert_eq!(lifecycle.begin_drain(false), Some(drain));
        assert!(lifecycle.finish_drain(drain, true));
        let replacement = lifecycle.begin_start(2).unwrap();
        assert_ne!(replacement.epoch, drain.epoch);
        assert!(lifecycle.publish(replacement));
        assert!(!lifecycle.finish_drain(drain, true));
        assert_eq!(lifecycle.phase(), Phase::Ready);
    }

    #[test]
    fn exit_cannot_be_reopened_by_late_activation() {
        let lifecycle = Lifecycle::default();
        lifecycle.begin_drain(true);
        assert_eq!(lifecycle.phase(), Phase::AppExiting);
        assert!(lifecycle.begin_start(8).is_none());
    }

    #[test]
    fn account_generation_mismatch_never_admits() {
        let lifecycle = Lifecycle::default();
        assert!(lifecycle.publish(lifecycle.begin_start(7).unwrap()));
        assert!(lifecycle.acquire(8).is_none());
        assert!(lifecycle.begin_start(8).is_none());
    }

    #[test]
    fn concurrent_activation_has_exactly_one_builder() {
        let lifecycle = Lifecycle::default();
        let threads: Vec<_> = (0..16)
            .map(|_| {
                let lifecycle = lifecycle.clone();
                std::thread::spawn(move || lifecycle.begin_start(1))
            })
            .collect();
        assert_eq!(
            threads
                .into_iter()
                .filter_map(|t| t.join().unwrap())
                .count(),
            1
        );
    }

    #[test]
    fn queued_account_mutation_is_revoked_and_drain_waits_for_it() {
        let lifecycle = Lifecycle::default();
        assert!(lifecycle.publish(lifecycle.begin_start(1).unwrap()));
        let mutation = lifecycle.acquire_mutation().unwrap();
        let drain = lifecycle.begin_drain(false).unwrap();
        assert!(!mutation.valid());
        assert!(lifecycle.acquire_mutation().is_none());
        assert!(!lifecycle.finish_drain(drain, true));
        drop(mutation);
        assert!(lifecycle.finish_drain(drain, true));
    }

    #[test]
    fn poisoned_authority_never_admits_work() {
        let lifecycle = Lifecycle::default();
        assert!(lifecycle.publish(lifecycle.begin_start(1).unwrap()));
        let poisoned = lifecycle.clone();
        assert!(
            std::thread::spawn(move || {
                let _guard = poisoned.0.lock().unwrap();
                panic!("synthetic lock interruption");
            })
            .join()
            .is_err()
        );
        assert!(lifecycle.acquire(1).is_none());
        assert!(lifecycle.acquire_mutation().is_none());
    }

    #[test]
    fn empty_shell_logout_still_seals_pending_account_operations() {
        let lifecycle = Lifecycle::default();
        let pending = lifecycle.acquire_mutation().unwrap();
        assert!(lifecycle.begin_drain(false).is_none());
        assert!(!pending.valid());
        assert!(lifecycle.acquire_mutation().is_none());
        assert!(!lifecycle.finish_empty_drain());
        drop(pending);
        assert!(lifecycle.finish_empty_drain());
        assert!(lifecycle.acquire_mutation().is_some());
    }

    #[test]
    fn builder_unwind_releases_only_build_ownership_not_cleanup_authority() {
        let lifecycle = Lifecycle::default();
        let worker = lifecycle.clone();
        assert!(
            std::panic::catch_unwind(move || {
                let _permit = worker.begin_build(1).unwrap();
                panic!("synthetic partial startup failure");
            })
            .is_err()
        );
        assert_eq!(lifecycle.pending(), (false, 0));
        assert_eq!(lifecycle.phase(), Phase::Draining);
        assert!(lifecycle.begin_build(2).is_none());
        assert!(!lifecycle.finish_empty_drain());
    }
}
