//! Desktop ownership of the persistent, signed local interpreter. Acquiring a worker never
//! downloads anything. Its component leases and capacity reservation survive uncertain cleanup.
//!
//! Starting is an intent, not a single attempt. At a cold start the Resource Governor has just
//! been created: its first sample carries no CPU reading ("warming up: needs a second
//! measurement") and the next one is due a full idle interval later, so admission is held. A held
//! start stays pending and is re-evaluated on the governor's next fresh sample — never on a timer —
//! within a bounded window; genuine start failures are retried a bounded number of times, also on
//! samples. Every transition is traced (event names and safe codes only) and published.

use std::cell::RefCell;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use kalcode_kalvoice::component_store::ComponentLease;
use kalcode_kalvoice::llama_worker::{
    LlamaWorker, LlamaWorkerError, LlamaWorkerLimits, LlamaWorkerStatus,
};
use kalcode_kalvoice::local_reasoning::{
    LocalInterpretation, LocalInterpretationCancellation, LocalInterpretationError,
    LocalInterpretationRequest, LocalInterpreter,
};
use kalcode_kalvoice::signals::LocalReasoningStatus;
use kalcode_resources::{
    AdmissionDecision, AdmissionReason, GovernorStatus, GovernorUpdate, HoldReason,
};

use crate::kalvoice_components::{ComponentManagerError, KalVoiceComponentManager};
use crate::kalvoice_guardian::KalVoiceGuardianLauncher;
use crate::resource_commands::{LocalWorkloadEstimate, ResourceGovernorState};

/// Governor updates buffered for a waiting start. Each evaluation drains the buffer first, so a
/// burst never turns into back-to-back evaluations.
const CAPACITY_EVENT_BUFFER: usize = 16;

/// How often a waiting start looks for shutdown or a manual retry between governor samples.
/// Only a fresh sample (or a retry) re-evaluates admission; this slice never does.
const WAIT_SLICE: Duration = Duration::from_millis(200);

/// Bounds for an automatic start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct AutostartPolicy {
    /// Longest continuous wait for the governor to admit the start before giving up.
    capacity_wait: Duration,
    /// Genuine start attempts (spawn or health check) before giving up.
    start_attempts: u32,
}

impl Default for AutostartPolicy {
    fn default() -> Self {
        Self {
            capacity_wait: Duration::from_secs(15 * 60),
            start_attempts: 3,
        }
    }
}

/// A start that did not happen, with a safe code and whether an unchanged retry may succeed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct StartFailure {
    code: &'static str,
    retryable: bool,
}

impl StartFailure {
    const fn hard(code: &'static str) -> Self {
        Self {
            code,
            retryable: false,
        }
    }

    const fn transient(code: &'static str) -> Self {
        Self {
            code,
            retryable: true,
        }
    }
}

const fn worker_failure(error: LlamaWorkerError) -> StartFailure {
    match error {
        LlamaWorkerError::IncompatibleComponents => {
            StartFailure::hard("worker_incompatible_components")
        }
        LlamaWorkerError::InvalidConfiguration => {
            StartFailure::hard("worker_invalid_configuration")
        }
        LlamaWorkerError::CleanupUnproven => StartFailure::hard("worker_cleanup_unproven"),
        LlamaWorkerError::Cancelled => StartFailure::hard("worker_start_cancelled"),
        LlamaWorkerError::Unavailable => StartFailure::transient("worker_unavailable"),
        LlamaWorkerError::Busy => StartFailure::transient("worker_busy"),
        LlamaWorkerError::StartFailed => StartFailure::transient("worker_start_failed"),
        LlamaWorkerError::ProcessExited => StartFailure::transient("worker_exited"),
        LlamaWorkerError::Timeout => StartFailure::transient("worker_health_timeout"),
        LlamaWorkerError::InvalidResponse => StartFailure::transient("worker_invalid_response"),
        LlamaWorkerError::Transport => StartFailure::transient("worker_transport_failed"),
        LlamaWorkerError::LoopbackOwnerMismatch => {
            StartFailure::transient("worker_identity_unproven")
        }
        LlamaWorkerError::ServerRejected => StartFailure::transient("worker_rejected"),
    }
}

const fn component_failure(error: ComponentManagerError) -> StartFailure {
    match error {
        // Storage contention or a concurrent delete can clear without the owner doing anything.
        ComponentManagerError::CatalogStorage
        | ComponentManagerError::StorageUnavailable
        | ComponentManagerError::InUse => StartFailure::transient(error.code()),
        _ => StartFailure::hard(error.code()),
    }
}

/// Why the governor held a start, as a safe code. `permanent` means no sample will ever come.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Hold {
    code: &'static str,
    permanent: bool,
}

fn classify_hold(decision: &AdmissionDecision) -> Hold {
    let (mut monitor, mut memory, mut cpu, mut pressure, mut permanent) =
        (false, false, false, false, false);
    for reason in &decision.reasons {
        match reason {
            AdmissionReason::GovernorNotReady {
                status: GovernorStatus::Failed { .. } | GovernorStatus::Stopped,
            } => permanent = true,
            AdmissionReason::GovernorNotReady { .. }
            | AdmissionReason::SnapshotMissing
            | AdmissionReason::SnapshotFromFuture { .. }
            | AdmissionReason::SnapshotStale { .. }
            | AdmissionReason::SnapshotModeMismatch { .. }
            | AdmissionReason::RequiredTelemetryUnknown { .. }
            | AdmissionReason::RequiredTelemetryUnavailable { .. } => monitor = true,
            AdmissionReason::Capacity { holds } => {
                for hold in holds {
                    match hold {
                        HoldReason::MemoryHeadroom { .. } | HoldReason::KalCodeMemoryCap { .. } => {
                            memory = true;
                        }
                        HoldReason::CpuHeadroom { .. } => cpu = true,
                        HoldReason::Pressure { .. } => pressure = true,
                        _ => {}
                    }
                }
            }
            AdmissionReason::CapacityUnavailable => {}
        }
    }
    let code = if permanent {
        "resource_monitor_unavailable"
    } else if monitor {
        "resource_monitor_starting"
    } else if memory {
        "memory_headroom"
    } else if cpu {
        "cpu_headroom"
    } else if pressure {
        "resource_pressure"
    } else {
        "capacity_unavailable"
    };
    Hold { code, permanent }
}

/// Why the interpreter is not running although it is installed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Issue {
    /// Start pending until the governor admits it.
    Waiting(&'static str),
    /// The automatic start gave up (or is between bounded retries).
    Failed(&'static str),
}

trait ManagedInterpreter: LocalInterpreter {
    fn warm(&self, cancel: &LocalInterpretationCancellation) -> Result<(), StartFailure>;
    fn stop(&self) -> bool;
    fn status(&self) -> LlamaWorkerStatus;
}

impl ManagedInterpreter for LlamaWorker {
    fn warm(&self, cancel: &LocalInterpretationCancellation) -> Result<(), StartFailure> {
        self.start_with_control(Duration::from_secs(30), cancel)
            .map_err(worker_failure)
    }
    fn stop(&self) -> bool {
        self.stop().is_ok()
    }
    fn status(&self) -> LlamaWorkerStatus {
        self.status()
    }
}

/// Verified, leased components ready to launch. Holding it keeps the signed bytes in place.
trait PreparedInterpreter: Send {
    fn launch(self: Box<Self>) -> Result<Arc<dyn ManagedInterpreter>, StartFailure>;
}

/// What a start needs from the desktop: the signed components, the governor and the guardian.
trait InterpreterHost: Send + Sync {
    /// Cheap receipt check; no hashing.
    fn installed(&self) -> bool;
    /// Verifies (hashes) and leases the signed runtime and model, with the workload they need.
    fn acquire(
        &self,
    ) -> Result<(Box<dyn PreparedInterpreter>, LocalWorkloadEstimate), StartFailure>;
    /// Atomically admits and reserves the workload for the resident process's lifetime.
    fn reserve(&self, estimate: LocalWorkloadEstimate) -> Result<Box<dyn Send>, AdmissionDecision>;
    /// The governor's updates, whose fresh samples re-evaluate a held start. `None`: no sampler.
    fn capacity_events(&self) -> Option<Receiver<GovernorUpdate>>;
}

struct DesktopHost {
    components: Arc<KalVoiceComponentManager>,
    resources: Arc<ResourceGovernorState>,
    launcher: Option<Arc<KalVoiceGuardianLauncher>>,
}

struct SignedWorker {
    runtime: ComponentLease,
    model: ComponentLease,
    limits: LlamaWorkerLimits,
    launcher: Arc<KalVoiceGuardianLauncher>,
}

impl PreparedInterpreter for SignedWorker {
    fn launch(self: Box<Self>) -> Result<Arc<dyn ManagedInterpreter>, StartFailure> {
        let worker = LlamaWorker::new(self.runtime, self.model, self.limits, self.launcher)
            .map_err(worker_failure)?;
        Ok(Arc::new(worker))
    }
}

impl InterpreterHost for DesktopHost {
    fn installed(&self) -> bool {
        self.components.reasoning_installed()
    }

    fn acquire(
        &self,
    ) -> Result<(Box<dyn PreparedInterpreter>, LocalWorkloadEstimate), StartFailure> {
        let Some(launcher) = &self.launcher else {
            return Err(StartFailure::hard("worker_guardian_unavailable"));
        };
        let (runtime, model) = self
            .components
            .acquire_reasoning()
            .map_err(component_failure)?;
        let limits = LlamaWorkerLimits::default();
        // GGUF bytes plus a bounded context/compute working set; reserve CPU for the actual
        // configured thread count for the entire resident process lifetime.
        let memory_mib = model
            .manifest()
            .size_bytes
            .div_ceil(1 << 20)
            .saturating_add(1024);
        let estimate = LocalWorkloadEstimate::inference(
            Some(u32::from(limits.threads) * 1000),
            Some(memory_mib),
        )
        .map_err(|_| StartFailure::hard("workload_estimate_invalid"))?;
        Ok((
            Box::new(SignedWorker {
                runtime,
                model,
                limits,
                launcher: launcher.clone(),
            }),
            estimate,
        ))
    }

    fn reserve(&self, estimate: LocalWorkloadEstimate) -> Result<Box<dyn Send>, AdmissionDecision> {
        self.resources
            .reserve_local_task(estimate)
            .map(|capacity| Box::new(capacity) as Box<dyn Send>)
    }

    fn capacity_events(&self) -> Option<Receiver<GovernorUpdate>> {
        self.resources.subscribe(CAPACITY_EVENT_BUFFER)
    }
}

struct Resident {
    worker: Arc<dyn ManagedInterpreter>,
    // Mutex makes the Send-only owner shareable without ever releasing it during an operation.
    _capacity: Mutex<Box<dyn Send>>,
}

#[derive(Default)]
struct State {
    resident: Option<Arc<Resident>>,
    warming: bool,
    cleanup: Option<JoinHandle<bool>>,
    /// Why the last automatic start is waiting or gave up; cleared once admission passes.
    issue: Option<Issue>,
    /// The installed components' workload, known after their first verification, so a held
    /// start re-checks admission without re-hashing the model on every sample.
    estimate: Option<LocalWorkloadEstimate>,
    /// One start driver runs at a time; later requests nudge it instead of racing it.
    driving: bool,
    /// A start was requested while the driver was busy: evaluate again now, with fresh bounds.
    nudged: bool,
    /// The reason the previous admission check was held, so a repeat is not logged again.
    last_hold: Option<&'static str>,
}

/// The outcome of one evaluation.
enum Attempt {
    Ready,
    Held(Hold),
    Failed(StartFailure),
    /// Nothing to start: not installed, sealed, or cleanup still owns the worker.
    Idle,
}

/// What ended a wait between evaluations.
enum Wake {
    Sample,
    Retry,
    Stop,
    /// The sampler went away; no sample will come.
    MonitorLost,
}

pub(super) struct DesktopLocalInterpreter {
    host: Arc<dyn InterpreterHost>,
    launcher: Option<Arc<KalVoiceGuardianLauncher>>,
    policy: AutostartPolicy,
    cancellation: LocalInterpretationCancellation,
    state: Mutex<State>,
}

/// Clears `driving` if a driver unwinds, so a later request can start one.
struct Driving<'a>(&'a DesktopLocalInterpreter);

impl Drop for Driving<'_> {
    fn drop(&mut self) {
        let mut state = self.0.lock();
        state.driving = false;
        state.nudged = false;
    }
}

impl DesktopLocalInterpreter {
    pub(super) fn new(
        components: Arc<KalVoiceComponentManager>,
        resources: Arc<ResourceGovernorState>,
        launcher: Option<Arc<KalVoiceGuardianLauncher>>,
    ) -> Arc<Self> {
        Self::with_host(
            Arc::new(DesktopHost {
                components,
                resources,
                launcher: launcher.clone(),
            }),
            launcher,
            AutostartPolicy::default(),
        )
    }

    fn with_host(
        host: Arc<dyn InterpreterHost>,
        launcher: Option<Arc<KalVoiceGuardianLauncher>>,
        policy: AutostartPolicy,
    ) -> Arc<Self> {
        Arc::new(Self {
            host,
            launcher,
            policy,
            cancellation: LocalInterpretationCancellation::default(),
            state: Mutex::new(State::default()),
        })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Starts the installed interpreter and keeps that intent until it is ready, gives up within
    /// its bounds, or the runtime is sealed. Called only by the runtime's retained background
    /// task; no request can start a process. `publish` receives every distinct status. A call
    /// while a start is already being driven asks that driver to evaluate again, once.
    pub(super) fn autostart(&self, publish: &dyn Fn(LocalReasoningStatus, Option<&'static str>)) {
        tracing::info!(event = "kalvoice.runtime_autostart_requested");
        {
            let mut state = self.lock();
            if state.driving {
                state.nudged = true;
                tracing::info!(event = "kalvoice.runtime_autostart_coalesced");
                return;
            }
            state.driving = true;
        }
        let _driving = Driving(self);
        let last = RefCell::new(None);
        let report = || {
            let current = self.snapshot();
            if last.borrow().as_ref() != Some(&current) {
                publish(current.0.clone(), current.1);
                *last.borrow_mut() = Some(current);
            }
        };
        // Subscribe before the first evaluation so no sample between a hold and the wait is lost.
        let events = self.host.capacity_events();
        loop {
            self.drive(events.as_ref(), &report);
            report();
            // A request that arrived while this driver was finishing is served here, not lost.
            let mut state = self.lock();
            if !std::mem::take(&mut state.nudged) || self.cancellation.is_cancelled() {
                return;
            }
            drop(state);
            tracing::info!(
                event = "kalvoice.runtime_autostart_requested",
                trigger = "retry"
            );
        }
    }

    fn drive(&self, events: Option<&Receiver<GovernorUpdate>>, report: &dyn Fn()) {
        let mut failures = 0_u32;
        let mut held_since: Option<Instant> = None;
        loop {
            if let Some(events) = events {
                // Only samples taken after this evaluation may wake the next one.
                while events.try_recv().is_ok() {}
            }
            match self.attempt(report) {
                Attempt::Ready => {
                    tracing::info!(event = "kalvoice.intelligence_ready");
                    return;
                }
                Attempt::Idle => return,
                Attempt::Held(hold) => {
                    let since = *held_since.get_or_insert_with(Instant::now);
                    if hold.permanent || events.is_none() {
                        self.give_up("resource_monitor_unavailable");
                        return;
                    }
                    if since.elapsed() >= self.policy.capacity_wait {
                        self.give_up("capacity_wait_exhausted");
                        return;
                    }
                    self.lock().issue = Some(Issue::Waiting(hold.code));
                }
                Attempt::Failed(failure) => {
                    failures += 1;
                    held_since = None;
                    if !failure.retryable
                        || failures >= self.policy.start_attempts
                        || events.is_none()
                    {
                        self.give_up(failure.code);
                        return;
                    }
                    self.lock().issue = Some(Issue::Failed(failure.code));
                    tracing::info!(
                        event = "kalvoice.runtime_autostart_retry_pending",
                        code = failure.code,
                        attempts = failures
                    );
                }
            }
            report();
            match self.wait(events) {
                Wake::Sample => {}
                Wake::Retry => {
                    failures = 0;
                    held_since = None;
                    tracing::info!(
                        event = "kalvoice.runtime_autostart_requested",
                        trigger = "retry"
                    );
                }
                Wake::Stop => return,
                Wake::MonitorLost => {
                    self.give_up("resource_monitor_unavailable");
                    return;
                }
            }
        }
    }

    fn give_up(&self, code: &'static str) {
        self.lock().issue = Some(Issue::Failed(code));
        tracing::warn!(event = "kalvoice.runtime_autostart_failed", code);
    }

    /// Blocks until the governor publishes a fresh sample, a retry is requested, or the runtime
    /// is sealed. The short slice only bounds how late shutdown or a retry is noticed.
    fn wait(&self, events: Option<&Receiver<GovernorUpdate>>) -> Wake {
        let Some(events) = events else {
            return Wake::Stop;
        };
        loop {
            {
                let mut state = self.lock();
                if self.cancellation.is_cancelled() {
                    return Wake::Stop;
                }
                if std::mem::take(&mut state.nudged) {
                    return Wake::Retry;
                }
            }
            match events.recv_timeout(WAIT_SLICE) {
                Ok(GovernorUpdate::Sample(_)) => return Wake::Sample,
                Ok(_) | Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    return if self.cancellation.is_cancelled() {
                        Wake::Stop
                    } else {
                        Wake::MonitorLost
                    };
                }
            }
        }
    }

    fn attempt(&self, report: &dyn Fn()) -> Attempt {
        let mut state = self.lock();
        if self.cancellation.is_cancelled() || state.warming || state.cleanup.is_some() {
            return Attempt::Idle;
        }
        state.warming = true;
        let existing = state.resident.clone();
        let cached = state.estimate;
        drop(state);
        let admitted = match existing {
            Some(resident) => Ok(resident),
            None => self.admit(cached),
        };
        let outcome = match admitted {
            Ok(resident) => {
                {
                    let mut state = self.lock();
                    state.resident = Some(resident.clone());
                    state.issue = None;
                }
                self.run(&resident, report)
            }
            Err(outcome) => outcome,
        };
        self.lock().warming = false;
        outcome
    }

    /// Discovers, admits and prepares a resident worker. A known workload is admitted before
    /// the components are verified again, so a held start never re-hashes the model.
    fn admit(&self, cached: Option<LocalWorkloadEstimate>) -> Result<Arc<Resident>, Attempt> {
        let installed = self.host.installed();
        if !installed {
            tracing::info!(event = "kalvoice.component_discovered", installed);
            return Err(Attempt::Idle);
        }
        let early = match cached {
            Some(estimate) => Some((estimate, self.check(estimate)?)),
            None => None,
        };
        // Logged once admission can proceed, so a start re-checked on every sample stays quiet.
        tracing::info!(event = "kalvoice.component_discovery_started");
        tracing::info!(event = "kalvoice.component_discovered", installed);
        let started = Instant::now();
        let (prepared, estimate) = self.host.acquire().map_err(|failure| {
            tracing::warn!(
                event = "kalvoice.component_verify_failed",
                code = failure.code
            );
            Attempt::Failed(failure)
        })?;
        tracing::info!(
            event = "kalvoice.component_verified",
            verify_ms = elapsed_ms(started)
        );
        self.lock().estimate = Some(estimate);
        let capacity = match early {
            Some((reserved, capacity)) if reserved == estimate => capacity,
            stale => {
                // The components changed size since the last check: release, then re-admit.
                drop(stale);
                self.check(estimate)?
            }
        };
        let worker = prepared.launch().map_err(|failure| {
            tracing::warn!(event = "kalvoice.runtime_spawn_failed", code = failure.code);
            Attempt::Failed(failure)
        })?;
        Ok(Arc::new(Resident {
            worker,
            _capacity: Mutex::new(capacity),
        }))
    }

    /// Admits the workload. A start held for the same reason on consecutive samples logs that
    /// once; each re-check is still traced at debug level.
    fn check(&self, estimate: LocalWorkloadEstimate) -> Result<Box<dyn Send>, Attempt> {
        let previous = self.lock().last_hold;
        if previous.is_none() {
            tracing::info!(event = "kalvoice.resource_check_started");
        } else {
            tracing::debug!(event = "kalvoice.resource_check_started");
        }
        let decision = self.host.reserve(estimate);
        let hold = decision.as_ref().err().map(classify_hold);
        self.lock().last_hold = hold.map(|hold| hold.code);
        match (decision, hold) {
            (Ok(capacity), _) => {
                tracing::info!(event = "kalvoice.resource_check_passed");
                Ok(capacity)
            }
            (Err(_), Some(hold)) if previous == Some(hold.code) => {
                tracing::debug!(event = "kalvoice.resource_check_held", reason = hold.code);
                Err(Attempt::Held(hold))
            }
            (Err(decision), hold) => {
                let hold = hold.unwrap_or_else(|| classify_hold(&decision));
                tracing::info!(event = "kalvoice.resource_check_held", reason = hold.code);
                Err(Attempt::Held(hold))
            }
        }
    }

    fn run(&self, resident: &Arc<Resident>, report: &dyn Fn()) -> Attempt {
        report();
        // The worker spawns and then waits for its authenticated health endpoint in one call.
        tracing::info!(event = "kalvoice.runtime_spawn_started");
        tracing::info!(event = "kalvoice.runtime_healthcheck_started");
        let started = Instant::now();
        match resident.worker.warm(&self.cancellation) {
            Ok(()) => {
                let start_ms = elapsed_ms(started);
                tracing::info!(event = "kalvoice.runtime_spawn_succeeded", start_ms);
                tracing::info!(event = "kalvoice.runtime_healthcheck_passed", start_ms);
                Attempt::Ready
            }
            Err(failure) => {
                tracing::warn!(event = "kalvoice.runtime_spawn_failed", code = failure.code);
                if resident.worker.status() == LlamaWorkerStatus::Stopped {
                    // No process remains: release the leases and the reservation so a later
                    // attempt starts clean instead of pinning capacity for a dead worker.
                    let mut state = self.lock();
                    if state
                        .resident
                        .as_ref()
                        .is_some_and(|current| Arc::ptr_eq(current, resident))
                    {
                        state.resident = None;
                    }
                }
                if self.cancellation.is_cancelled() {
                    Attempt::Idle
                } else {
                    Attempt::Failed(failure)
                }
            }
        }
    }

    /// The status and, when waiting or failed, its safe reason code.
    pub(super) fn snapshot(&self) -> (LocalReasoningStatus, Option<&'static str>) {
        if self.cancellation.is_cancelled() {
            return (LocalReasoningStatus::Unavailable, None);
        }
        let state = self.lock();
        let issue = state.issue;
        if state.warming {
            // Re-checking a held start is not starting it.
            return match issue {
                Some(Issue::Waiting(code)) => (LocalReasoningStatus::Waiting, Some(code)),
                _ => (LocalReasoningStatus::Warming, None),
            };
        }
        let resident = state.resident.clone();
        drop(state);
        match resident.map(|resident| resident.worker.status()) {
            Some(LlamaWorkerStatus::Ready | LlamaWorkerStatus::Busy) => {
                (LocalReasoningStatus::Ready, None)
            }
            Some(LlamaWorkerStatus::Starting) => (LocalReasoningStatus::Warming, None),
            Some(_) => match issue {
                Some(Issue::Failed(code)) => (LocalReasoningStatus::Failed, Some(code)),
                _ => (LocalReasoningStatus::Unavailable, None),
            },
            None if !self.host.installed() => (LocalReasoningStatus::NotInstalled, None),
            None => match issue {
                Some(Issue::Waiting(code)) => (LocalReasoningStatus::Waiting, Some(code)),
                Some(Issue::Failed(code)) => (LocalReasoningStatus::Failed, Some(code)),
                None => (LocalReasoningStatus::Installed, None),
            },
        }
    }

    pub(super) fn status(&self) -> LocalReasoningStatus {
        self.snapshot().0
    }

    pub(super) fn seal(&self) {
        self.cancellation.cancel();
    }

    /// Caller first drains request/background owners. A slow or failed stop retains both the
    /// JoinHandle and the resident owner; repeated calls retry without surrendering custody.
    pub(super) fn shutdown_reasoning(&self, deadline: Instant) -> bool {
        self.seal();
        loop {
            let mut state = self.lock();
            if state.warming {
                return false;
            }
            if let Some(cleanup) = state.cleanup.as_ref() {
                if cleanup.is_finished() {
                    let clean = state
                        .cleanup
                        .take()
                        .is_some_and(|handle| handle.join().unwrap_or(false));
                    if clean {
                        state.resident = None;
                    }
                    return clean;
                }
            } else if let Some(resident) = state.resident.clone() {
                if Instant::now() >= deadline {
                    return false;
                }
                let launcher = self.launcher.clone();
                let Ok(handle) = std::thread::Builder::new()
                    .name("kalvoice-reasoning-stop".into())
                    .spawn(move || {
                        let clean = resident.worker.stop();
                        let guardian_clean = launcher.as_ref().is_none_or(|launcher| {
                            launcher
                                .retry_retained_cleanup(Instant::now() + Duration::from_secs(5))
                                .is_ok()
                        });
                        clean && guardian_clean
                    })
                else {
                    return false;
                };
                state.cleanup = Some(handle);
            } else {
                return self
                    .launcher
                    .as_ref()
                    .is_none_or(|launcher| launcher.retained_processes() == 0);
            }
            drop(state);
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(
                Duration::from_millis(5).min(deadline.saturating_duration_since(Instant::now())),
            );
        }
    }
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

impl LocalInterpreter for DesktopLocalInterpreter {
    fn interpret(
        &self,
        request: LocalInterpretationRequest,
        deadline: Instant,
        cancellation: &LocalInterpretationCancellation,
    ) -> Result<LocalInterpretation, LocalInterpretationError> {
        if self.cancellation.is_cancelled() {
            return Err(LocalInterpretationError::Unavailable);
        }
        let state = self.lock();
        if state.warming || state.cleanup.is_some() {
            return Err(LocalInterpretationError::Unavailable);
        }
        let resident = state
            .resident
            .clone()
            .ok_or(LocalInterpretationError::Unavailable)?;
        drop(state);
        resident.worker.interpret(request, deadline, cancellation)
    }
}

#[cfg(all(
    test,
    any(
        all(windows, target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64")
    )
))]
#[path = "kalvoice_reasoning_tests.rs"]
mod tests;
