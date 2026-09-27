//! Desktop ownership and IPC for the resource governor.
//!
//! This module owns exactly one sampler handle. Reads never perform probes: they copy the
//! sampler's bounded in-memory state. Admission is evaluated immediately before a caller starts
//! governed work and never stops work that is already running. Local UI, authentication and
//! recovery paths must stay outside this admission gate.

use std::collections::BTreeMap;
#[cfg(feature = "e2e")]
use std::ffi::OsStr;
#[cfg(feature = "e2e")]
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::AppState;
use crate::runtime_coordinator::{RuntimeAccess, RuntimeState};
use kalcode_core::{IpcError, KalError};
#[cfg(feature = "e2e")]
use kalcode_resources::probe::{Counters, ProbePlan, RawCpu, RawMemory, RawSample};
use kalcode_resources::{
    Activity, AdmissionDecision, AdmissionReason, AdmissionRequirements, AdmissionState,
    CapacityAdvice, CapacityRequest, Constraint, Governor, GovernorConfig, GovernorHandle,
    GovernorStatus, HistoryPoint, HoldReason, ModeLimits, PressureTransition, ProcessRole, Reading,
    ResourceMode, ResourceSnapshot, RunningWork, SamplerStats, WorkspaceRoot, admission_max_age,
    capacity, evaluate_admission,
};
#[cfg(feature = "e2e")]
use kalcode_resources::{SystemClock, SystemProbe};
use serde::Serialize;

const REPORT_HISTORY_POINTS: usize = 60;
const MAX_LOCAL_CPU_MILLICORES: u32 = 64_000;
const MAX_LOCAL_MEMORY_MIB: u64 = 262_144;
const MAX_LOCAL_DISK_MIB: u64 = 1_048_576;
#[cfg(feature = "e2e")]
const RESOURCE_FIXTURE_OPT_IN_ENV: &str = "KALCODE_E2E_RESOURCE_FIXTURE";
#[cfg(feature = "e2e")]
const RESOURCE_FIXTURE_VALUE: &str = "provider-capacity-v1";

#[cfg(feature = "e2e")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum E2eResourceFixtureSelection {
    Real,
    ProviderCapacity,
    Rejected,
}

/// One fixed low-pressure sample for marked native E2E profiles. The normal governor still owns
/// smoothing, freshness, pressure, capacity, admission, reservations and provider limits.
#[cfg(feature = "e2e")]
struct E2eProviderCapacityProbe;

#[cfg(feature = "e2e")]
impl SystemProbe for E2eProviderCapacityProbe {
    fn sample(&mut self, _plan: &ProbePlan<'_>) -> RawSample {
        RawSample {
            cpu: Reading::Value(RawCpu {
                total_percent: 5.0,
                logical_cores: 8,
            }),
            memory: Reading::Value(RawMemory {
                total_bytes: 16 * 1024 * 1024 * 1024,
                available_bytes: 12 * 1024 * 1024 * 1024,
            }),
            disk_io: Reading::Value(Counters {
                generation: 1,
                a_bytes: 0,
                b_bytes: 0,
            }),
            commit: None,
            network: None,
            volumes: None,
            processes: None,
            gpu: None,
        }
    }
}

#[cfg(feature = "e2e")]
fn classify_e2e_resource_fixture(
    opt_in: Option<&OsStr>,
    data_dir: Option<&Path>,
    attested: impl FnOnce(&Path) -> bool,
) -> E2eResourceFixtureSelection {
    let Some(opt_in) = opt_in else {
        return E2eResourceFixtureSelection::Real;
    };
    if opt_in != OsStr::new(RESOURCE_FIXTURE_VALUE) {
        return E2eResourceFixtureSelection::Rejected;
    }
    match data_dir {
        Some(data_dir) if attested(data_dir) => E2eResourceFixtureSelection::ProviderCapacity,
        _ => E2eResourceFixtureSelection::Rejected,
    }
}

#[cfg(feature = "e2e")]
fn e2e_resource_fixture_selection() -> E2eResourceFixtureSelection {
    let opt_in = std::env::var_os(RESOURCE_FIXTURE_OPT_IN_ENV);
    let data_dir = std::env::var_os("KALCODE_DATA_DIR").map(std::path::PathBuf::from);
    classify_e2e_resource_fixture(opt_in.as_deref(), data_dir.as_deref(), |data_dir| {
        crate::account::e2e::provider_fixture_is_attested(data_dir).unwrap_or(false)
    })
}

#[cfg(feature = "e2e")]
fn start_e2e_provider_capacity_governor() -> Result<GovernorHandle, kalcode_resources::ModeError> {
    Governor::start_with(
        GovernorConfig::default(),
        Box::new(E2eProviderCapacityProbe),
        Arc::new(SystemClock::default()),
    )
}

mod provider;
pub(crate) use provider::ResourceAdmissionProvider;

/// Managed desktop state. `Mutex` serializes lifecycle changes while the governor itself keeps
/// its sampling and read locks independent and bounded.
pub struct ResourceGovernorState {
    runtime: Mutex<Runtime>,
}

struct Runtime {
    handle: Option<GovernorHandle>,
    activity: ActivityTracker,
    fallback_status: GovernorStatus,
}

/// Merges activity reported by independent host owners. Opening or closing the resource view
/// must not erase the Scheduler's running-work count.
#[derive(Debug, Default)]
struct ActivityTracker {
    reported: RunningWork,
    reservations: RunningWork,
    reservation_claims: BTreeMap<u64, ReservationClaim>,
    next_reservation_id: u64,
    resource_view_open: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ReservationKind {
    Provider(kalcode_contracts::agent::ProviderId),
    Local,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ReservationClaim {
    kind: ReservationKind,
    budget: ReservationBudget,
}

/// Resources promised to admitted work but not safely attributable to one sampler reading.
///
/// The sampler reports whole-machine usage, so subtracting a reservation when usage rises could
/// accidentally credit unrelated work. Reservations therefore remain projected until their
/// owner proves process/download settlement by releasing the permit. This is intentionally
/// conservative and prevents a fresh sample from making the same capacity available twice.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct ReservationBudget {
    cpu_millicores: u64,
    memory_mib: u64,
    disk_mib: u64,
}

impl ReservationBudget {
    fn saturating_add(self, other: Self) -> Self {
        Self {
            cpu_millicores: self.cpu_millicores.saturating_add(other.cpu_millicores),
            memory_mib: self.memory_mib.saturating_add(other.memory_mib),
            disk_mib: self.disk_mib.saturating_add(other.disk_mib),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LocalTaskClass {
    Inference,
    Acquisition,
}

/// A caller-supplied peak allocation for local work. Constructors reject missing, zero and
/// unbounded values so admission never substitutes a provider-sized guess for local models.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LocalWorkloadEstimate {
    class: LocalTaskClass,
    budget: ReservationBudget,
}

impl LocalWorkloadEstimate {
    pub(crate) fn inference(
        cpu_millicores: Option<u32>,
        memory_mib: Option<u64>,
    ) -> Result<Self, IpcError> {
        Ok(Self {
            class: LocalTaskClass::Inference,
            budget: ReservationBudget {
                cpu_millicores: bounded_u32(
                    "cpuMillicores",
                    cpu_millicores,
                    MAX_LOCAL_CPU_MILLICORES,
                )?
                .into(),
                memory_mib: bounded_u64("memoryMib", memory_mib, MAX_LOCAL_MEMORY_MIB)?,
                disk_mib: 0,
            },
        })
    }

    pub(crate) fn acquisition(
        cpu_millicores: Option<u32>,
        memory_mib: Option<u64>,
        disk_mib: Option<u64>,
    ) -> Result<Self, IpcError> {
        Ok(Self {
            class: LocalTaskClass::Acquisition,
            budget: ReservationBudget {
                cpu_millicores: bounded_u32(
                    "cpuMillicores",
                    cpu_millicores,
                    MAX_LOCAL_CPU_MILLICORES,
                )?
                .into(),
                memory_mib: bounded_u64("memoryMib", memory_mib, MAX_LOCAL_MEMORY_MIB)?,
                disk_mib: bounded_u64("diskMib", disk_mib, MAX_LOCAL_DISK_MIB)?,
            },
        })
    }

    const fn requirements(self) -> AdmissionRequirements {
        match self.class {
            LocalTaskClass::Inference => AdmissionRequirements::provider_task(),
            LocalTaskClass::Acquisition => AdmissionRequirements::background_heavy(),
        }
    }

    const fn budget(self) -> ReservationBudget {
        self.budget
    }
}

impl ActivityTracker {
    fn activity(&self) -> Activity {
        Activity {
            active_tasks: self.running().agents,
            resource_view_open: self.resource_view_open,
        }
    }

    fn running(&self) -> RunningWork {
        let mut running = self.reported.clone();
        running.agents = running.agents.saturating_add(self.reservations.agents);
        for (provider, count) in &self.reservations.per_provider {
            let current = running.per_provider.entry(provider.clone()).or_default();
            *current = current.saturating_add(*count);
        }
        running
    }

    fn set_active_tasks(&mut self, active_tasks: u32) {
        self.reported.agents = active_tasks;
    }

    fn set_running(&mut self, running: RunningWork) {
        self.reported = running;
    }

    fn reserve(&mut self, kind: ReservationKind, budget: ReservationBudget) -> Option<u64> {
        let agents = self.reservations.agents.checked_add(1)?;
        let provider_count = match &kind {
            ReservationKind::Provider(provider) => Some((
                provider.clone(),
                self.reservations
                    .per_provider
                    .get(provider)
                    .copied()
                    .unwrap_or(0)
                    .checked_add(1)?,
            )),
            ReservationKind::Local => None,
        };
        let id = self.next_reservation_id.checked_add(1)?;
        if self.reservation_claims.contains_key(&id) {
            return None;
        }

        self.reservations.agents = agents;
        if let Some((provider, count)) = provider_count {
            self.reservations.per_provider.insert(provider, count);
        }
        self.reservation_claims
            .insert(id, ReservationClaim { kind, budget });
        self.next_reservation_id = id;
        Some(id)
    }

    fn release(&mut self, id: u64) {
        let Some(claim) = self.reservation_claims.get(&id).cloned() else {
            tracing::error!(
                event = "resources.reservation_unbalanced",
                reservation_id = id,
                "resource reservation release had no matching claim"
            );
            return;
        };

        if self.reservations.agents == 0
            || matches!(
                &claim.kind,
                ReservationKind::Provider(provider)
                    if self
                        .reservations
                        .per_provider
                        .get(provider)
                        .copied()
                        .unwrap_or(0)
                        == 0
            )
        {
            tracing::error!(
                event = "resources.reservation_unbalanced",
                reservation_id = id,
                "resource reservation counters were already empty"
            );
            return;
        }
        if let ReservationKind::Provider(provider) = &claim.kind {
            let Some(current) = self.reservations.per_provider.get_mut(provider) else {
                tracing::error!(
                    event = "resources.reservation_unbalanced",
                    reservation_id = id,
                    provider_id = %provider,
                    "provider reservation count disappeared before release"
                );
                return;
            };
            *current -= 1;
            if *current == 0 {
                self.reservations.per_provider.remove(provider);
            }
        }
        self.reservation_claims.remove(&id);
        self.reservations.agents -= 1;
    }

    fn pending_budget(&self) -> ReservationBudget {
        self.reservation_claims
            .values()
            .fold(ReservationBudget::default(), |pending, claim| {
                pending.saturating_add(claim.budget)
            })
    }

    fn set_view_open(&mut self, open: bool) {
        self.resource_view_open = open;
    }
}

/// One atomically reserved provider slot. The registered provider lifecycle owns this value;
/// dropping it after the underlying session has exited returns the slot exactly once.
#[must_use = "a provider reservation must be retained until its process lifecycle is complete"]
pub(super) struct ProviderTaskReservation {
    governor: Weak<ResourceGovernorState>,
    reservation_id: u64,
    released: AtomicBool,
}

impl ProviderTaskReservation {
    fn release(&self) {
        if self.released.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Some(governor) = self.governor.upgrade() {
            governor.release_task(self.reservation_id);
        }
    }
}

/// One atomically reserved local workload. The acquisition/worker owner must retain this until
/// every download handle is closed or the child process is confirmed reaped.
#[must_use = "a local task reservation must be retained until the operation is settled"]
pub(crate) struct LocalTaskReservation {
    governor: Weak<ResourceGovernorState>,
    reservation_id: u64,
    released: AtomicBool,
}

impl LocalTaskReservation {
    pub(crate) fn release(&self) {
        if self.released.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Some(governor) = self.governor.upgrade() {
            governor.release_task(self.reservation_id);
        }
    }
}

impl Drop for LocalTaskReservation {
    fn drop(&mut self) {
        self.release();
    }
}

impl Drop for ProviderTaskReservation {
    fn drop(&mut self) {
        self.release();
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceReport {
    pub status: GovernorStatus,
    pub snapshot: ResourceSnapshot,
    pub history: Vec<HistoryPoint>,
    pub transitions: Vec<PressureTransition>,
    pub stats: ResourceSamplerStats,
    pub capacity: CapacityAdvice,
    pub admission: AdmissionDecision,
    pub freshness: ResourceFreshness,
}

/// Duration fields are converted explicitly because serde's default `Duration` representation is
/// not the stable millisecond wire contract used by the WebView.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSamplerStats {
    pub samples: u64,
    pub failed_samples: u64,
    pub slow_tier_samples: u64,
    pub process_tier_samples: u64,
    pub total_probe_ms: u64,
    pub last_probe_ms: u64,
    pub max_probe_ms: u64,
    pub max_process_tier_ms: u64,
    pub dropped_updates: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceFreshnessState {
    Fresh,
    Stale,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceFreshness {
    pub state: ResourceFreshnessState,
    pub age_ms: Option<u64>,
    pub max_age_ms: u64,
    pub detail: &'static str,
}

impl ResourceGovernorState {
    /// Starts the one process-wide sampler. Invalid built-in configuration degrades to a visible,
    /// fail-closed state instead of preventing the desktop and recovery surfaces from opening.
    pub fn start() -> Self {
        let started = |result: Result<GovernorHandle, kalcode_resources::ModeError>| match result {
            Ok(handle) => (Some(handle), GovernorStatus::Starting),
            Err(error) => {
                tracing::error!(
                    event = "resources.start_failed",
                    error = %error,
                    "resource governor configuration was rejected"
                );
                (
                    None,
                    GovernorStatus::Failed {
                        reason: "the resource governor could not start".into(),
                    },
                )
            }
        };
        #[cfg(feature = "e2e")]
        let (handle, fallback_status) = match e2e_resource_fixture_selection() {
            E2eResourceFixtureSelection::Real => {
                started(Governor::start(GovernorConfig::default()))
            }
            E2eResourceFixtureSelection::ProviderCapacity => {
                started(start_e2e_provider_capacity_governor())
            }
            E2eResourceFixtureSelection::Rejected => {
                tracing::error!(
                    event = "resources.e2e_fixture_rejected",
                    "the resource E2E fixture was rejected"
                );
                (
                    None,
                    GovernorStatus::Failed {
                        reason: "the resource governor could not start".into(),
                    },
                )
            }
        };
        #[cfg(not(feature = "e2e"))]
        let (handle, fallback_status) = started(Governor::start(GovernorConfig::default()));
        Self {
            runtime: Mutex::new(Runtime {
                handle,
                activity: ActivityTracker::default(),
                fallback_status,
            }),
        }
    }

    /// Current owner-facing report. No call in this path waits for a new sample or touches the OS.
    pub fn report(&self) -> ResourceReport {
        self.report_at(unix_ms())
    }

    fn report_at(&self, now_unix_ms: i64) -> ResourceReport {
        let runtime = self.lock();
        report(&runtime, now_unix_ms)
    }

    /// Evaluates one launch from a captured snapshot and its matching capacity calculation.
    /// Callers must invoke this directly before spawn; an `Allowed` result is intentionally not a
    /// reservation and must not be cached or replayed.
    pub fn admission_for(
        &self,
        running: &RunningWork,
        request: &CapacityRequest,
        requirements: AdmissionRequirements,
    ) -> AdmissionDecision {
        self.admission_at(running, request, requirements, unix_ms())
    }

    /// Ordinary provider tasks require current CPU and memory telemetry. Optional unsupported GPU
    /// telemetry does not hold these tasks.
    pub fn admit_provider_task(
        &self,
        running: &RunningWork,
        request: &CapacityRequest,
    ) -> AdmissionDecision {
        self.admission_for(running, request, AdmissionRequirements::provider_task())
    }

    /// Atomically admits and reserves one managed provider session. Evaluation and count update
    /// share the governor mutex so concurrent starts cannot all consume the same final slot.
    pub(super) fn reserve_provider_task(
        self: &Arc<Self>,
        provider: kalcode_contracts::agent::ProviderId,
    ) -> Result<ProviderTaskReservation, AdmissionDecision> {
        let mut runtime = self.lock();
        let running = runtime.activity.running();
        let request = CapacityRequest {
            provider: Some(provider.clone()),
        };
        let pending = runtime.activity.pending_budget();
        let Some(handle) = runtime.handle.as_ref() else {
            return Err(capacity_unavailable(
                &runtime,
                AdmissionRequirements::provider_task(),
            ));
        };
        let status = handle.status();
        let latest = handle.latest();
        let limits = handle.limits();
        let Some(budget) = provider_budget(latest.as_deref(), &limits) else {
            return Err(capacity_unavailable(
                &runtime,
                AdmissionRequirements::provider_task(),
            ));
        };
        let decision = projected_admission(
            &status,
            latest.as_deref(),
            &limits,
            &running,
            &request,
            AdmissionRequirements::provider_task(),
            pending,
            budget,
            unix_ms(),
        );
        let reservation_id = reserve_claim(
            &mut runtime,
            ReservationKind::Provider(provider),
            budget,
            decision,
        )?;
        publish_activity(&runtime);
        drop(runtime);
        Ok(ProviderTaskReservation {
            governor: Arc::downgrade(self),
            reservation_id,
            released: AtomicBool::new(false),
        })
    }

    /// Test seam for the existing count-only provider contract. Production always uses the
    /// workload-projected path above.
    #[cfg(test)]
    fn reserve_provider_task_with(
        self: &Arc<Self>,
        provider: kalcode_contracts::agent::ProviderId,
        decide: impl FnOnce(&Runtime, &RunningWork, &CapacityRequest) -> AdmissionDecision,
    ) -> Result<ProviderTaskReservation, AdmissionDecision> {
        let mut runtime = self.lock();
        let running = runtime.activity.running();
        let request = CapacityRequest {
            provider: Some(provider.clone()),
        };
        let decision = decide(&runtime, &running, &request);
        let reservation_id = reserve_claim(
            &mut runtime,
            ReservationKind::Provider(provider),
            ReservationBudget::default(),
            decision,
        )?;
        publish_activity(&runtime);
        drop(runtime);
        Ok(ProviderTaskReservation {
            governor: Arc::downgrade(self),
            reservation_id,
            released: AtomicBool::new(false),
        })
    }

    #[cfg(test)]
    fn reserve_provider_task_with_estimate(
        self: &Arc<Self>,
        provider: kalcode_contracts::agent::ProviderId,
        budget: ReservationBudget,
        decide: impl FnOnce(&Runtime, &RunningWork, ReservationBudget) -> AdmissionDecision,
    ) -> Result<ProviderTaskReservation, AdmissionDecision> {
        let mut runtime = self.lock();
        let running = runtime.activity.running();
        let pending = runtime.activity.pending_budget();
        let decision = decide(&runtime, &running, pending);
        let reservation_id = reserve_claim(
            &mut runtime,
            ReservationKind::Provider(provider),
            budget,
            decision,
        )?;
        publish_activity(&runtime);
        drop(runtime);
        Ok(ProviderTaskReservation {
            governor: Arc::downgrade(self),
            reservation_id,
            released: AtomicBool::new(false),
        })
    }

    /// Atomically admits one local model inference or acquisition. The returned permit is the
    /// operation owner's proof of capacity and must outlive every child/download side effect.
    pub(crate) fn reserve_local_task(
        self: &Arc<Self>,
        estimate: LocalWorkloadEstimate,
    ) -> Result<LocalTaskReservation, AdmissionDecision> {
        self.reserve_local_task_with_decider(estimate, |runtime, running, pending| {
            projected_runtime_admission(
                runtime,
                running,
                &CapacityRequest::default(),
                estimate.requirements(),
                pending,
                estimate.budget(),
                unix_ms(),
            )
        })
    }

    fn reserve_local_task_with_decider(
        self: &Arc<Self>,
        estimate: LocalWorkloadEstimate,
        decide: impl FnOnce(&Runtime, &RunningWork, ReservationBudget) -> AdmissionDecision,
    ) -> Result<LocalTaskReservation, AdmissionDecision> {
        let mut runtime = self.lock();
        let running = runtime.activity.running();
        let pending = runtime.activity.pending_budget();
        let decision = decide(&runtime, &running, pending);
        let reservation_id = reserve_claim(
            &mut runtime,
            ReservationKind::Local,
            estimate.budget(),
            decision,
        )?;
        publish_activity(&runtime);
        drop(runtime);
        Ok(LocalTaskReservation {
            governor: Arc::downgrade(self),
            reservation_id,
            released: AtomicBool::new(false),
        })
    }

    #[cfg(test)]
    fn reserve_local_task_with(
        self: &Arc<Self>,
        estimate: LocalWorkloadEstimate,
        decide: impl FnOnce(&Runtime, &RunningWork, ReservationBudget) -> AdmissionDecision,
    ) -> Result<LocalTaskReservation, AdmissionDecision> {
        self.reserve_local_task_with_decider(estimate, decide)
    }

    fn release_task(&self, reservation_id: u64) {
        let mut runtime = self.lock();
        runtime.activity.release(reservation_id);
        publish_activity(&runtime);
    }

    #[cfg(test)]
    fn running_work_for_test(&self) -> RunningWork {
        self.lock().activity.running()
    }

    #[cfg(test)]
    fn pending_budget_for_test(&self) -> ReservationBudget {
        self.lock().activity.pending_budget()
    }

    fn admission_at(
        &self,
        running: &RunningWork,
        request: &CapacityRequest,
        requirements: AdmissionRequirements,
        now_unix_ms: i64,
    ) -> AdmissionDecision {
        let runtime = self.lock();
        admission(&runtime, running, request, requirements, now_unix_ms)
    }

    /// Scheduler-owned running work drives cadence and the capacity shown in the resource view.
    pub fn set_running_work(&self, running: RunningWork) {
        let mut runtime = self.lock();
        runtime.activity.set_running(running);
        publish_activity(&runtime);
    }

    /// Compatibility helper for hosts that do not yet provide per-provider counts.
    pub fn set_active_tasks(&self, active_tasks: u32) {
        let mut runtime = self.lock();
        runtime.activity.set_active_tasks(active_tasks);
        publish_activity(&runtime);
    }

    pub fn set_view_open(&self, open: bool) {
        let mut runtime = self.lock();
        runtime.activity.set_view_open(open);
        publish_activity(&runtime);
    }

    pub fn set_mode(&self, mode: ResourceMode) -> Result<(), IpcError> {
        let runtime = self.lock();
        let Some(handle) = runtime.handle.as_ref() else {
            return Err(governor_unavailable());
        };
        handle.set_mode(mode).map_err(|error| {
            tracing::warn!(event = "resources.mode_rejected", error = %error);
            KalError::validation(
                "invalid_resource_mode",
                "Those resource limits aren't valid.",
            )
            .to_ipc()
        })
    }

    pub fn set_workspaces(&self, workspaces: Vec<WorkspaceRoot>) {
        if let Some(handle) = self.lock().handle.as_ref() {
            handle.set_workspaces(workspaces);
        }
    }

    /// Refreshes governed volume roots from the canonical workspace store. Store failures do not
    /// block the desktop; disk telemetry becomes conservative until the next successful sync.
    pub fn sync_workspaces(&self, app: &AppState) {
        let mut roots = vec![WorkspaceRoot {
            workspace_id: None,
            path: app.paths.data_dir.clone(),
        }];
        if let Some(core) = &app.core {
            match core.workspaces() {
                Ok(workspaces) => roots.extend(
                    workspaces
                        .into_iter()
                        .filter(|workspace| workspace.available)
                        .map(|workspace| WorkspaceRoot {
                            workspace_id: Some(workspace.id),
                            path: workspace.root_path.into(),
                        }),
                ),
                Err(error) => tracing::warn!(
                    event = "resources.workspaces_unavailable",
                    error_code = error.code,
                    "resource governor could not refresh workspace volumes"
                ),
            }
        }
        self.set_workspaces(roots);
    }

    pub fn track_process(&self, pid: u32, role: ProcessRole) {
        if let Some(handle) = self.lock().handle.as_ref() {
            handle.track_process(pid, role);
        }
    }

    pub fn untrack_process(&self, pid: u32) {
        if let Some(handle) = self.lock().handle.as_ref() {
            handle.untrack_process(pid);
        }
    }

    /// Stops with a bounded wait while retaining exclusive sampler ownership. The coordinator
    /// closes command admission before this call; a timeout retains the handle for retry.
    pub fn shutdown_checked(&self) -> bool {
        let mut runtime = self.lock();
        if let Some(handle) = runtime.handle.as_mut()
            && !handle.shutdown_checked(Duration::from_secs(2))
        {
            return false;
        }
        runtime.handle.take();
        runtime.fallback_status = GovernorStatus::Stopped;
        true
    }

    #[cfg(test)]
    fn shutdown(&self) {
        assert!(self.shutdown_checked());
    }

    fn lock(&self) -> MutexGuard<'_, Runtime> {
        self.runtime
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl Default for ResourceGovernorState {
    fn default() -> Self {
        Self::start()
    }
}

fn bounded_u32(field: &'static str, value: Option<u32>, maximum: u32) -> Result<u32, IpcError> {
    let Some(value) = value else {
        return Err(invalid_workload_estimate(field, "is required"));
    };
    if value == 0 || value > maximum {
        return Err(invalid_workload_estimate(
            field,
            format!("must be between 1 and {maximum}"),
        ));
    }
    Ok(value)
}

fn bounded_u64(field: &'static str, value: Option<u64>, maximum: u64) -> Result<u64, IpcError> {
    let Some(value) = value else {
        return Err(invalid_workload_estimate(field, "is required"));
    };
    if value == 0 || value > maximum {
        return Err(invalid_workload_estimate(
            field,
            format!("must be between 1 and {maximum}"),
        ));
    }
    Ok(value)
}

fn invalid_workload_estimate(field: &'static str, reason: impl Into<String>) -> IpcError {
    KalError::validation(
        "invalid_local_workload_estimate",
        format!("Local workload estimate {field} {}.", reason.into()),
    )
    .to_ipc()
}

fn reserve_claim(
    runtime: &mut Runtime,
    kind: ReservationKind,
    budget: ReservationBudget,
    mut decision: AdmissionDecision,
) -> Result<u64, AdmissionDecision> {
    if decision.state != AdmissionState::Allowed || decision.additional == 0 {
        return Err(decision);
    }
    let Some(reservation_id) = runtime.activity.reserve(kind, budget) else {
        decision.state = AdmissionState::Held;
        decision.additional = 0;
        if !decision
            .reasons
            .contains(&AdmissionReason::CapacityUnavailable)
        {
            decision.reasons.push(AdmissionReason::CapacityUnavailable);
        }
        return Err(decision);
    };
    Ok(reservation_id)
}

fn provider_budget(
    snapshot: Option<&ResourceSnapshot>,
    limits: &ModeLimits,
) -> Option<ReservationBudget> {
    let cpu_millicores = (limits.agent_estimate.cpu_cores * 1_000.0).ceil();
    if !cpu_millicores.is_finite()
        || cpu_millicores < 1.0
        || cpu_millicores > f64::from(MAX_LOCAL_CPU_MILLICORES)
    {
        return None;
    }
    let memory_mib = snapshot
        .map(|snapshot| kalcode_resources::capacity::per_agent_memory_mb(snapshot, limits).0)
        .unwrap_or(limits.agent_estimate.memory_mb);
    if memory_mib == 0 || memory_mib > MAX_LOCAL_MEMORY_MIB {
        return None;
    }
    Some(ReservationBudget {
        cpu_millicores: cpu_millicores as u64,
        memory_mib,
        disk_mib: 0,
    })
}

fn capacity_unavailable(
    runtime: &Runtime,
    requirements: AdmissionRequirements,
) -> AdmissionDecision {
    let running = runtime.activity.running();
    let mut decision = admission(
        runtime,
        &running,
        &CapacityRequest::default(),
        requirements,
        unix_ms(),
    );
    decision.state = AdmissionState::Held;
    decision.additional = 0;
    if !decision
        .reasons
        .contains(&AdmissionReason::CapacityUnavailable)
    {
        decision.reasons.push(AdmissionReason::CapacityUnavailable);
    }
    decision
}

fn projected_runtime_admission(
    runtime: &Runtime,
    running: &RunningWork,
    request: &CapacityRequest,
    requirements: AdmissionRequirements,
    pending: ReservationBudget,
    requested: ReservationBudget,
    now_unix_ms: i64,
) -> AdmissionDecision {
    let Some(handle) = runtime.handle.as_ref() else {
        return projected_admission(
            &runtime.fallback_status,
            None,
            &ModeLimits::balanced(),
            running,
            request,
            requirements,
            pending,
            requested,
            now_unix_ms,
        );
    };
    let status = handle.status();
    let latest = handle.latest();
    let limits = handle.limits();
    projected_admission(
        &status,
        latest.as_deref(),
        &limits,
        running,
        request,
        requirements,
        pending,
        requested,
        now_unix_ms,
    )
}

#[allow(clippy::too_many_arguments)]
fn projected_admission(
    status: &GovernorStatus,
    snapshot: Option<&ResourceSnapshot>,
    limits: &ModeLimits,
    running: &RunningWork,
    request: &CapacityRequest,
    requirements: AdmissionRequirements,
    pending: ReservationBudget,
    requested: ReservationBudget,
    now_unix_ms: i64,
) -> AdmissionDecision {
    let advice = snapshot
        .map(|snapshot| projected_capacity(snapshot, limits, running, request, pending, requested));
    let max_age = snapshot
        .map(admission_max_age)
        .unwrap_or(kalcode_resources::MAX_ADMISSION_SAMPLE_AGE);
    let mut decision =
        evaluate_admission(status, snapshot, advice, requirements, now_unix_ms, max_age);

    if requirements.disk_space
        && !disk_budget_fits(snapshot, limits, pending.disk_mib, requested.disk_mib)
    {
        decision.state = AdmissionState::Held;
        decision.additional = 0;
        if !decision
            .reasons
            .contains(&AdmissionReason::CapacityUnavailable)
        {
            decision.reasons.push(AdmissionReason::CapacityUnavailable);
        }
    }
    decision
}

fn projected_capacity(
    snapshot: &ResourceSnapshot,
    limits: &ModeLimits,
    running: &RunningWork,
    request: &CapacityRequest,
    pending: ReservationBudget,
    requested: ReservationBudget,
) -> CapacityAdvice {
    let mut advice = capacity(snapshot, limits, running, request);
    advice.constraints.retain(|constraint| {
        !matches!(
            constraint.reason,
            HoldReason::CpuHeadroom { .. }
                | HoldReason::MemoryHeadroom { .. }
                | HoldReason::KalCodeMemoryCap { .. }
        )
    });

    if let Reading::Value(cpu) = &snapshot.cpu
        && cpu.logical_cores > 0
    {
        let machine_millicores = u64::from(cpu.logical_cores).saturating_mul(1_000);
        let pending_percent = pending.cpu_millicores as f64 * 100.0 / machine_millicores as f64;
        let requested_percent = requested.cpu_millicores as f64 * 100.0 / machine_millicores as f64;
        let projected_percent =
            f64::from(cpu.smoothed_percent) + pending_percent + requested_percent;
        advice.constraints.push(Constraint {
            reason: HoldReason::CpuHeadroom {
                cpu_percent: f64::from(cpu.smoothed_percent) + pending_percent,
                target_percent: limits.cpu_target_percent,
                per_agent_percent: requested_percent,
                mode: limits.kind,
            },
            allows: u32::from(projected_percent <= limits.cpu_target_percent),
        });
    }

    if let Reading::Value(memory) = &snapshot.memory {
        let available_mib = memory.smoothed_available_bytes / kalcode_resources::MIB;
        let effective_available_mib = available_mib.saturating_sub(pending.memory_mib);
        let required_mib = limits
            .memory_reserve_mb
            .saturating_add(requested.memory_mib);
        advice.constraints.push(Constraint {
            reason: HoldReason::MemoryHeadroom {
                available_mb: effective_available_mib,
                reserve_mb: limits.memory_reserve_mb,
                per_agent_mb: requested.memory_mib,
                mode: limits.kind,
            },
            allows: u32::from(effective_available_mib >= required_mib),
        });

        if let (Some(cap_bytes), Reading::Value(tree)) = (
            limits.kalcode_memory_cap.bytes(memory.total_bytes),
            &snapshot.kalcode_tree,
        ) {
            let cap_mib = cap_bytes / kalcode_resources::MIB;
            let projected_used_mib =
                (tree.total_rss_bytes / kalcode_resources::MIB).saturating_add(pending.memory_mib);
            advice.constraints.push(Constraint {
                reason: HoldReason::KalCodeMemoryCap {
                    used_mb: projected_used_mib,
                    cap_mb: cap_mib,
                    per_agent_mb: requested.memory_mib,
                    mode: limits.kind,
                },
                allows: u32::from(
                    projected_used_mib.saturating_add(requested.memory_mib) <= cap_mib,
                ),
            });
        }
    }

    advice.additional = advice
        .constraints
        .iter()
        .map(|constraint| constraint.allows)
        .min()
        .unwrap_or(0);
    advice.holds = advice
        .constraints
        .iter()
        .filter(|constraint| constraint.allows == advice.additional)
        .map(|constraint| constraint.reason.clone())
        .collect();
    advice
}

fn disk_budget_fits(
    snapshot: Option<&ResourceSnapshot>,
    limits: &ModeLimits,
    pending_mib: u64,
    requested_mib: u64,
) -> bool {
    let Some(ResourceSnapshot {
        volumes: Reading::Value(volumes),
        ..
    }) = snapshot
    else {
        return false;
    };
    let Some(free_mib) = volumes
        .iter()
        .filter(|volume| volume.workspace_ids.iter().any(Option::is_none))
        .map(|volume| volume.free_bytes / kalcode_resources::MIB)
        .min()
    else {
        return false;
    };
    let reserve_mib = limits.disk_free_mb.high.ceil() as u64;
    free_mib
        >= reserve_mib
            .saturating_add(pending_mib)
            .saturating_add(requested_mib)
}

fn report(runtime: &Runtime, now_unix_ms: i64) -> ResourceReport {
    let (status, latest, history, transitions, stats, limits) = match runtime.handle.as_ref() {
        Some(handle) => (
            handle.status(),
            handle.latest(),
            recent_history(handle.history()),
            handle.recent_transitions(),
            handle.stats(),
            handle.limits(),
        ),
        None => (
            runtime.fallback_status.clone(),
            None,
            Vec::new(),
            Vec::new(),
            SamplerStats::default(),
            ModeLimits::balanced(),
        ),
    };
    let snapshot = latest.as_deref().cloned().unwrap_or_else(|| {
        ResourceSnapshot::unknown("the resource sampler has no data yet", limits.kind)
    });
    let request = CapacityRequest::default();
    let running = runtime.activity.running();
    let advice = capacity(&snapshot, &limits, &running, &request);
    let max_age = latest
        .as_deref()
        .map(admission_max_age)
        .unwrap_or(kalcode_resources::MAX_ADMISSION_SAMPLE_AGE);
    let admission = admission(
        runtime,
        &running,
        &request,
        AdmissionRequirements::provider_task(),
        now_unix_ms,
    );
    ResourceReport {
        status,
        snapshot,
        history,
        transitions,
        stats: sampler_stats(stats),
        capacity: advice,
        admission,
        freshness: freshness(latest.as_deref(), now_unix_ms, max_age),
    }
}

fn admission(
    runtime: &Runtime,
    running: &RunningWork,
    request: &CapacityRequest,
    requirements: AdmissionRequirements,
    now_unix_ms: i64,
) -> AdmissionDecision {
    let Some(handle) = runtime.handle.as_ref() else {
        return evaluate_admission(
            &runtime.fallback_status,
            None,
            None,
            requirements,
            now_unix_ms,
            kalcode_resources::MAX_ADMISSION_SAMPLE_AGE,
        );
    };
    let status = handle.status();
    let latest = handle.latest();
    let limits = handle.limits();
    let advice = latest
        .as_deref()
        .map(|snapshot| capacity(snapshot, &limits, running, request));
    let max_age = latest
        .as_deref()
        .map(admission_max_age)
        .unwrap_or(kalcode_resources::MAX_ADMISSION_SAMPLE_AGE);
    evaluate_admission(
        &status,
        latest.as_deref(),
        advice,
        requirements,
        now_unix_ms,
        max_age,
    )
}

fn publish_activity(runtime: &Runtime) {
    if let Some(handle) = runtime.handle.as_ref() {
        handle.set_activity(runtime.activity.activity());
    }
}

fn recent_history(mut history: Vec<HistoryPoint>) -> Vec<HistoryPoint> {
    if history.len() > REPORT_HISTORY_POINTS {
        let drop_count = history.len() - REPORT_HISTORY_POINTS;
        drop(history.drain(..drop_count));
    }
    history
}

fn sampler_stats(stats: SamplerStats) -> ResourceSamplerStats {
    ResourceSamplerStats {
        samples: stats.samples,
        failed_samples: stats.failed_samples,
        slow_tier_samples: stats.slow_tier_samples,
        process_tier_samples: stats.process_tier_samples,
        total_probe_ms: duration_ms(stats.total_probe_time),
        last_probe_ms: duration_ms(stats.last_probe_time),
        max_probe_ms: duration_ms(stats.max_probe_time),
        max_process_tier_ms: duration_ms(stats.max_process_tier_time),
        dropped_updates: stats.dropped_updates,
    }
}

fn freshness(
    snapshot: Option<&ResourceSnapshot>,
    now_unix_ms: i64,
    max_age: Duration,
) -> ResourceFreshness {
    let max_age_ms = duration_ms(max_age);
    let Some(snapshot) = snapshot.filter(|snapshot| snapshot.seq > 0) else {
        return ResourceFreshness {
            state: ResourceFreshnessState::Unavailable,
            age_ms: None,
            max_age_ms,
            detail: "The sampler has not produced a reading yet.",
        };
    };
    let Some(age) = now_unix_ms
        .checked_sub(snapshot.sampled_at_unix_ms)
        .filter(|age| *age >= 0)
        .and_then(|age| u64::try_from(age).ok())
    else {
        return ResourceFreshness {
            state: ResourceFreshnessState::Unavailable,
            age_ms: None,
            max_age_ms,
            detail: "The sampler clock is inconsistent.",
        };
    };
    if age > max_age_ms {
        ResourceFreshness {
            state: ResourceFreshnessState::Stale,
            age_ms: Some(age),
            max_age_ms,
            detail: "The latest resource sample is older than the current safety window.",
        }
    } else {
        ResourceFreshness {
            state: ResourceFreshnessState::Fresh,
            age_ms: Some(age),
            max_age_ms,
            detail: "The latest resource sample is current.",
        }
    }
}

fn duration_ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or(0)
}

fn governor_unavailable() -> IpcError {
    KalError::internal(
        "resource_governor_unavailable",
        "KalCode's resource governor isn't available. Restart KalCode; if this keeps happening, export diagnostics.",
    )
    .to_ipc()
}

#[tauri::command(async)]
pub fn resource_report(
    access: RuntimeAccess,
    state: RuntimeState<ResourceGovernorState>,
) -> Result<ResourceReport, IpcError> {
    access.revalidate()?;
    state.revalidate()?;
    Ok(state.report())
}

#[tauri::command(async)]
pub fn resource_set_mode(
    access: RuntimeAccess,
    state: RuntimeState<ResourceGovernorState>,
    mode: ResourceMode,
) -> Result<ResourceReport, IpcError> {
    access.revalidate()?;
    state.revalidate()?;
    state.set_mode(mode)?;
    Ok(state.report())
}

#[tauri::command(async)]
pub fn resource_set_view_open(
    access: RuntimeAccess,
    state: RuntimeState<ResourceGovernorState>,
    open: bool,
) -> Result<(), IpcError> {
    access.revalidate()?;
    state.revalidate()?;
    state.set_view_open(open);
    Ok(())
}

#[cfg(test)]
#[path = "resource_commands_tests.rs"]
mod tests;
