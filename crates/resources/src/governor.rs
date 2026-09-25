//! The governor thread and its handle.
//!
//! One background thread (`kalcode-resources`) samples on the adaptive cadence. Callers never
//! wait for a sample: every handle method takes one short lock (no I/O under it) and returns.
//! If sampling fails, panics or the thread cannot start, readers get `Unknown` data and
//! [`GovernorHandle::capacity`] falls back to count limits only (§11 failure isolation).

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError, sync_channel};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::cadence::Activity;
use crate::capacity::{CapacityAdvice, CapacityRequest, RunningWork, capacity};
use crate::clock::{Clock, SystemClock};
use crate::engine::{Engine, GovernorConfig, ModeChange};
use crate::history::{HistoryPoint, Ring};
use crate::intervene::{ProposedIntervention, propose};
use crate::mode::{ModeError, ModeLimits, ResourceMode};
use crate::model::{PressureTransition, ProcessRole, ResourceSnapshot};
use crate::probe::{SysinfoProbe, SystemProbe, WorkspaceRoot};
use crate::tree::TrackedRoot;

/// After this many consecutive probe panics the probe is dropped and the governor stops
/// sampling (status `Failed`); readers keep getting `Unknown`.
pub const MAX_CONSECUTIVE_PANICS: u32 = 5;
/// Recent pressure transitions kept for late subscribers.
pub const TRANSITION_HISTORY: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum GovernorStatus {
    /// Started; no sample yet.
    Starting,
    Running,
    /// Sampling, but the last sample(s) failed; data is `Unknown` until one succeeds.
    Degraded {
        reason: String,
    },
    /// Not sampling (the thread could not start, or the probe kept failing). Readers get
    /// `Unknown` and count-only capacity.
    Failed {
        reason: String,
    },
    Stopped,
}

/// What subscribers receive. Samples stream here and are never events (RG-04); the host maps
/// `PressureChanged` / `ModeChanged` to the proposed `resource.*` events.
#[derive(Debug, Clone, PartialEq)]
pub enum GovernorUpdate {
    Sample(Arc<ResourceSnapshot>),
    PressureChanged(PressureTransition),
    ModeChanged(ModeChange),
}

/// The sampler's own cost, measured on its thread (wall time spent inside the probe).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SamplerStats {
    pub samples: u64,
    pub failed_samples: u64,
    pub slow_tier_samples: u64,
    pub process_tier_samples: u64,
    pub total_probe_time: Duration,
    pub last_probe_time: Duration,
    pub max_probe_time: Duration,
    /// Wall time of the most expensive sample that ran the process tier (process snapshot).
    pub max_process_tier_time: Duration,
    /// Updates not delivered because a subscriber's buffer was full.
    pub dropped_updates: u64,
}

#[derive(Debug, Default)]
struct Pending {
    activity: Option<Activity>,
    mode: Option<ResourceMode>,
    workspaces: Option<Vec<WorkspaceRoot>>,
    track: Vec<TrackedRoot>,
    untrack: Vec<u32>,
    shutdown: bool,
}

#[derive(Debug)]
struct State {
    latest: Option<Arc<ResourceSnapshot>>,
    history: Ring<HistoryPoint>,
    transitions: Ring<PressureTransition>,
    status: GovernorStatus,
    stats: SamplerStats,
    limits: ModeLimits,
    subscribers: Vec<SyncSender<GovernorUpdate>>,
    pending: Pending,
}

#[derive(Debug)]
struct Shared {
    state: Mutex<State>,
    wake: Condvar,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        // A poisoned lock only means a panic elsewhere while holding it; the data is plain
        // values, so keep serving it rather than propagating the panic to callers.
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Entry point.
pub struct Governor;

impl Governor {
    /// Starts the governor with the real probe and clock. Fails only on invalid custom limits;
    /// a thread that cannot start yields a handle in the `Failed` state instead.
    pub fn start(config: GovernorConfig) -> Result<GovernorHandle, ModeError> {
        Self::start_with(
            config,
            Box::new(SysinfoProbe::new()),
            Arc::new(SystemClock::default()),
        )
    }

    /// Starts with an injected probe and clock (tests, other platforms).
    pub fn start_with(
        config: GovernorConfig,
        probe: Box<dyn SystemProbe>,
        clock: Arc<dyn Clock>,
    ) -> Result<GovernorHandle, ModeError> {
        let engine = Engine::new(&config)?;
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                latest: None,
                history: Ring::new(config.history_capacity.clamp(1, 3600)),
                transitions: Ring::new(TRANSITION_HISTORY),
                status: GovernorStatus::Starting,
                stats: SamplerStats::default(),
                limits: engine.limits().clone(),
                subscribers: Vec::new(),
                pending: Pending::default(),
            }),
            wake: Condvar::new(),
        });
        let worker_shared = Arc::clone(&shared);
        let spawned = std::thread::Builder::new()
            .name("kalcode-resources".into())
            .spawn(move || {
                Worker {
                    shared: worker_shared,
                    engine,
                    probe,
                    clock,
                }
                .run()
            });
        let thread = match spawned {
            Ok(thread) => Some(thread),
            Err(error) => {
                tracing::warn!(module = "resources", error = %error, "resource sampler thread did not start");
                shared.lock().status = GovernorStatus::Failed {
                    reason: "the resource sampler could not start".into(),
                };
                None
            }
        };
        Ok(GovernorHandle { shared, thread })
    }
}

/// Handle to a running governor. Cheap, non-blocking methods; dropping it stops the thread.
pub struct GovernorHandle {
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
}

impl GovernorHandle {
    pub fn status(&self) -> GovernorStatus {
        self.shared.lock().status.clone()
    }

    /// The latest snapshot (`None` before the first sample).
    pub fn latest(&self) -> Option<Arc<ResourceSnapshot>> {
        self.shared.lock().latest.clone()
    }

    /// The latest snapshot, or an all-unknown one when there is none. Never blocks on sampling.
    pub fn snapshot_or_unknown(&self) -> Arc<ResourceSnapshot> {
        let state = self.shared.lock();
        match &state.latest {
            Some(snapshot) => Arc::clone(snapshot),
            None => Arc::new(ResourceSnapshot::unknown(
                "the resource sampler has no data yet",
                state.limits.kind,
            )),
        }
    }

    /// Oldest first.
    pub fn history(&self) -> Vec<HistoryPoint> {
        self.shared.lock().history.to_vec()
    }

    /// The most recent pressure transitions, oldest first (for consumers that missed updates).
    pub fn recent_transitions(&self) -> Vec<PressureTransition> {
        self.shared.lock().transitions.to_vec()
    }

    pub fn stats(&self) -> SamplerStats {
        self.shared.lock().stats
    }

    pub fn limits(&self) -> ModeLimits {
        self.shared.lock().limits.clone()
    }

    /// Advisory capacity from the latest snapshot. With no data, count limits only.
    pub fn capacity(&self, running: &RunningWork, request: &CapacityRequest) -> CapacityAdvice {
        let (snapshot, limits) = {
            let state = self.shared.lock();
            let snapshot = match &state.latest {
                Some(snapshot) => Arc::clone(snapshot),
                None => Arc::new(ResourceSnapshot::unknown(
                    "the resource sampler has no data yet",
                    state.limits.kind,
                )),
            };
            (snapshot, state.limits.clone())
        };
        capacity(&snapshot, &limits, running, request)
    }

    /// Proposed (never performed) interventions for the latest snapshot.
    pub fn proposals(&self, running: &RunningWork) -> Vec<ProposedIntervention> {
        self.latest()
            .map(|snapshot| propose(&snapshot, running))
            .unwrap_or_default()
    }

    /// Reports what KalCode is doing; drives the adaptive cadence.
    pub fn set_activity(&self, activity: Activity) {
        let mut state = self.shared.lock();
        state.pending.activity = Some(activity);
        self.shared.wake.notify_all();
    }

    /// Changes the mode. Custom limits are validated here; the new thresholds apply at an
    /// immediate re-sample.
    pub fn set_mode(&self, mode: ResourceMode) -> Result<(), ModeError> {
        let limits = mode.limits()?;
        let mut state = self.shared.lock();
        state.limits = limits;
        state.pending.mode = Some(mode);
        self.shared.wake.notify_all();
        Ok(())
    }

    /// Sets the folders whose volumes are governed for free space.
    pub fn set_workspaces(&self, workspaces: Vec<WorkspaceRoot>) {
        self.shared.lock().pending.workspaces = Some(workspaces);
    }

    /// Registers a process KalCode started (provider CLI, terminal shell). Untracked
    /// automatically when it exits.
    pub fn track_process(&self, pid: u32, role: ProcessRole) {
        self.shared
            .lock()
            .pending
            .track
            .push(TrackedRoot { pid, role });
    }

    pub fn untrack_process(&self, pid: u32) {
        self.shared.lock().pending.untrack.push(pid);
    }

    /// Streams updates. A full buffer drops updates (counted in `stats().dropped_updates`)
    /// rather than slowing the sampler; `recent_transitions()` lets a consumer catch up.
    pub fn subscribe(&self, buffer: usize) -> Receiver<GovernorUpdate> {
        let (sender, receiver) = sync_channel(buffer.clamp(1, 1024));
        self.shared.lock().subscribers.push(sender);
        receiver
    }

    /// Stops the thread and waits for it (at most one in-flight sample).
    pub fn shutdown(mut self) {
        self.stop();
    }

    fn stop(&mut self) {
        {
            let mut state = self.shared.lock();
            state.pending.shutdown = true;
            self.shared.wake.notify_all();
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        let mut state = self.shared.lock();
        if !matches!(state.status, GovernorStatus::Failed { .. }) {
            state.status = GovernorStatus::Stopped;
        }
    }
}

impl Drop for GovernorHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

struct Worker {
    shared: Arc<Shared>,
    engine: Engine,
    probe: Box<dyn SystemProbe>,
    clock: Arc<dyn Clock>,
}

/// Marks the governor failed if the worker thread unwinds outside the probe guard.
struct PanicGuard(Arc<Shared>);

impl Drop for PanicGuard {
    fn drop(&mut self) {
        if std::thread::panicking() {
            self.0.lock().status = GovernorStatus::Failed {
                reason: "the resource sampler stopped unexpectedly".into(),
            };
        }
    }
}

impl Worker {
    fn run(mut self) {
        let _guard = PanicGuard(Arc::clone(&self.shared));
        let mut last_sample_at: Option<Duration> = None;
        let mut consecutive_panics = 0u32;
        loop {
            let Some(mode_changes) = self.wait(last_sample_at) else {
                return;
            };
            let now = self.clock.monotonic();
            last_sample_at = Some(now);
            let tiers = self.engine.plan_tiers(now);
            let started = Instant::now();
            let probe = &mut self.probe;
            let plan = self.engine.probe_plan(tiers);
            let outcome = catch_unwind(AssertUnwindSafe(|| probe.sample(&plan)));
            let elapsed = started.elapsed();
            let ingested = match outcome {
                Ok(raw) => {
                    consecutive_panics = 0;
                    self.engine.ingest(tiers, raw, now, self.clock.unix_ms())
                }
                Err(_) => {
                    consecutive_panics += 1;
                    tracing::warn!(
                        module = "resources",
                        consecutive_panics,
                        "resource probe panicked"
                    );
                    self.engine
                        .ingest_failure(self.clock.unix_ms(), "the resource probe failed")
                }
            };
            let give_up = consecutive_panics >= MAX_CONSECUTIVE_PANICS;
            self.publish(mode_changes, ingested, tiers, elapsed, give_up);
            if give_up {
                return;
            }
        }
    }

    /// Applies pending commands and sleeps until the next sample is due. Returns `None` on
    /// shutdown, otherwise the mode changes applied while waiting.
    fn wait(&mut self, last_sample_at: Option<Duration>) -> Option<Vec<ModeChange>> {
        let shared = Arc::clone(&self.shared);
        let mut state = shared.lock();
        let mut mode_changes = Vec::new();
        loop {
            let pending = std::mem::take(&mut state.pending);
            if pending.shutdown {
                return None;
            }
            let mut sample_now = last_sample_at.is_none();
            if let Some(activity) = pending.activity {
                self.engine.set_activity(activity);
            }
            if let Some(mode) = pending.mode {
                match self.engine.set_mode(mode) {
                    Ok(Some(change)) => {
                        mode_changes.push(change);
                        sample_now = true;
                    }
                    Ok(None) => {}
                    Err(error) => {
                        // Validated by the handle already; keep the current mode.
                        tracing::warn!(module = "resources", error = %error, "resource mode rejected");
                        state.limits = self.engine.limits().clone();
                    }
                }
            }
            if let Some(workspaces) = pending.workspaces {
                self.engine.set_workspaces(workspaces);
            }
            for pid in pending.untrack {
                self.engine.untrack(pid);
            }
            for root in pending.track {
                self.engine.track(root);
            }
            let now = self.clock.monotonic();
            let due = match last_sample_at {
                None => now,
                Some(at) => at.saturating_add(self.engine.next_delay().0),
            };
            if sample_now || now >= due {
                return Some(mode_changes);
            }
            let (next, _) = shared
                .wake
                .wait_timeout(state, due - now)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state = next;
        }
    }

    fn publish(
        &mut self,
        mode_changes: Vec<ModeChange>,
        ingested: crate::engine::Ingested,
        tiers: crate::model::Tiers,
        elapsed: Duration,
        give_up: bool,
    ) {
        let mut state = self.shared.lock();
        let failures = ingested.snapshot.sampling.consecutive_failures;
        state.status = if give_up {
            GovernorStatus::Failed {
                reason: "the resource probe kept failing".into(),
            }
        } else if failures > 0 {
            GovernorStatus::Degraded {
                reason: "resource sampling is failing".into(),
            }
        } else {
            GovernorStatus::Running
        };
        let stats = &mut state.stats;
        stats.samples += 1;
        if failures > 0 {
            stats.failed_samples += 1;
        }
        if tiers.slow {
            stats.slow_tier_samples += 1;
        }
        if tiers.processes {
            stats.process_tier_samples += 1;
            stats.max_process_tier_time = stats.max_process_tier_time.max(elapsed);
        }
        stats.total_probe_time += elapsed;
        stats.last_probe_time = elapsed;
        stats.max_probe_time = stats.max_probe_time.max(elapsed);

        state
            .history
            .push(HistoryPoint::from_snapshot(&ingested.snapshot));
        for transition in &ingested.transitions {
            state.transitions.push(transition.clone());
        }
        state.latest = Some(Arc::clone(&ingested.snapshot));

        let mut updates: Vec<GovernorUpdate> = mode_changes
            .into_iter()
            .map(GovernorUpdate::ModeChanged)
            .collect();
        updates.extend(
            ingested
                .transitions
                .into_iter()
                .map(GovernorUpdate::PressureChanged),
        );
        updates.push(GovernorUpdate::Sample(ingested.snapshot));
        let mut dropped = 0u64;
        state.subscribers.retain(|subscriber| {
            for update in &updates {
                match subscriber.try_send(update.clone()) {
                    Ok(()) => {}
                    Err(TrySendError::Full(_)) => dropped += 1,
                    Err(TrySendError::Disconnected(_)) => return false,
                }
            }
            true
        });
        state.stats.dropped_updates += dropped;
    }
}

#[cfg(test)]
mod tests;
