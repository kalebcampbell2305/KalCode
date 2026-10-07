//! One account-bound Operations coordinator. The ledger owns queue/run identity; execution
//! remains in the existing guarded terminal and thread runtimes. Observations never confer
//! execution authority, and neither a restart nor a sign-in replays work automatically.
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use base64::Engine as _;
use kalcode_contracts::agent::LaunchOrigin;
use kalcode_contracts::events::{
    CorrelationFilter, EventEnvelope, EventPayload, EventQuery, SeqOrder,
};
use kalcode_contracts::operations::*;
use kalcode_contracts::threads::{ThreadStatus, ThreadSummary};
use kalcode_core::confirm::{NativeConfirmation, NativeConfirmer, confirm};
use kalcode_core::operations::{
    ACTIVITY_MOMENT_LIMIT, OPERATION_CANCELLING_ACTION, OperationsStore,
};
use kalcode_core::plans::{Limited, PlanLimit, PlanTier};
use kalcode_core::squads::SquadsStore;
use kalcode_core::workspaces::{TerminalInfo, TerminalSize, TerminalStatus};
use kalcode_core::{Core, IpcError, KalError, Result};
use kalcode_git::GitCore;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::account::model::AccountSnapshot;
use crate::account::runtime::AccountRuntime;
use crate::kalvoice_callbacks::{OperationAnnouncer, OperationCallback};
use crate::native_confirm::TauriConfirmer;
use crate::runtime_coordinator::{RuntimeAccess, RuntimeState};
use crate::thread_commands::{OperationPaneRequest, ThreadsState};

const OBSERVATION_TTL: Duration = Duration::from_secs(5);
const HISTORY_PAGE_SIZE: usize = 100;
const HISTORY_CURSOR_LIMIT: usize = 4096;
/// Mechanical startup parallelism only. This never caps live coding agents: a worker returns to
/// the pool as soon as its exact pane has been created or held.
const SQUAD_DISPATCH_WORKERS: usize = 8;
/// A member's pane was stopped by its exact id but no longer matched its settings. This needs only
/// that member's attention; it is never treated as unproven cleanup that pauses the queue.
const MEMBER_PANE_MISMATCH: &str = "operation_member_pane_mismatch";
const UNBOUND_SQUAD_START_REASON: &str =
    "This Squad member stopped before its provider pane started. Run now to start it.";

fn event_time_upper_bound(ended_at: &str) -> Result<String> {
    let ended_at = OffsetDateTime::parse(ended_at, &Rfc3339).map_err(|_| {
        KalError::internal(
            "operation_event_time_invalid",
            "The operation event window is invalid.",
        )
    })?;
    let upper_bound = ended_at
        .checked_add(time::Duration::milliseconds(1))
        .ok_or_else(|| {
            KalError::internal(
                "operation_event_time_invalid",
                "The operation event window is invalid.",
            )
        })?;
    Ok(kalcode_core::time::format_rfc3339(upper_bound))
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HistoryCursor {
    version: u8,
    operations: Option<String>,
    agent_turns: Option<String>,
    tools: Option<String>,
    shells: Option<String>,
    background: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HistoryAuthority {
    Operations,
    AgentTurns,
    Tools,
    Shells,
    Background,
}

impl HistoryAuthority {
    fn rank(self) -> u8 {
        match self {
            Self::Operations => 0,
            Self::AgentTurns => 1,
            Self::Tools => 2,
            Self::Shells => 3,
            Self::Background => 4,
        }
    }

    fn advance(self, cursor: &mut HistoryCursor, value: String) {
        *match self {
            Self::Operations => &mut cursor.operations,
            Self::AgentTurns => &mut cursor.agent_turns,
            Self::Tools => &mut cursor.tools,
            Self::Shells => &mut cursor.shells,
            Self::Background => &mut cursor.background,
        } = Some(value);
    }
}

struct HistoryRow {
    authority: HistoryAuthority,
    cursor: String,
    created_at: String,
    id: String,
    /// `None` consumes an authority row that is represented by another canonical source. This
    /// keeps each source cursor moving when an Operations-owned agent turn is suppressed.
    record: Option<OperationRecord>,
}

struct HistoryBatch {
    rows: Vec<HistoryRow>,
    has_more: bool,
}

fn history_cursor(before: Option<&str>) -> Result<HistoryCursor> {
    let Some(before) = before else {
        return Ok(HistoryCursor {
            version: 1,
            ..HistoryCursor::default()
        });
    };
    if before.is_empty() || before.len() > HISTORY_CURSOR_LIMIT {
        return Err(invalid_history_cursor());
    }
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(before)
        .map_err(|_| invalid_history_cursor())?;
    if bytes.len() > HISTORY_CURSOR_LIMIT {
        return Err(invalid_history_cursor());
    }
    let cursor: HistoryCursor =
        serde_json::from_slice(&bytes).map_err(|_| invalid_history_cursor())?;
    if cursor.version != 1 {
        return Err(invalid_history_cursor());
    }
    Ok(cursor)
}

fn encoded_history_cursor(cursor: &HistoryCursor) -> Result<String> {
    let bytes = serde_json::to_vec(cursor).map_err(|_| invalid_history_cursor())?;
    if bytes.len() > HISTORY_CURSOR_LIMIT {
        return Err(invalid_history_cursor());
    }
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    if encoded.len() > HISTORY_CURSOR_LIMIT {
        return Err(invalid_history_cursor());
    }
    Ok(encoded)
}

fn invalid_history_cursor() -> KalError {
    KalError::validation(
        "invalid_operations_history_cursor",
        "That Operations history cursor is invalid or no longer available.",
    )
}

fn history_source<T>(result: Result<T>) -> Result<T> {
    result.map_err(|error| {
        if matches!(
            error.code,
            "invalid_observed_history_cursor" | "invalid_operations_history_cursor"
        ) {
            invalid_history_cursor()
        } else {
            error
        }
    })
}

fn merge_history(
    mut cursor: HistoryCursor,
    batches: Vec<HistoryBatch>,
) -> Result<OperationHistoryPage> {
    let source_has_more = batches.iter().any(|batch| batch.has_more);
    let mut rows = batches
        .into_iter()
        .flat_map(|batch| batch.rows)
        .collect::<Vec<_>>();
    rows.sort_by(|left, right| {
        right
            .created_at
            .cmp(&left.created_at)
            .then(left.authority.rank().cmp(&right.authority.rank()))
            .then(right.id.cmp(&left.id))
    });

    let mut seen = HashSet::new();
    let mut items = Vec::with_capacity(HISTORY_PAGE_SIZE);
    let mut consumed = 0;
    for row in rows.iter() {
        if items.len() == HISTORY_PAGE_SIZE {
            break;
        }
        row.authority.advance(&mut cursor, row.cursor.clone());
        consumed += 1;
        if let Some(record) = &row.record
            && seen.insert(record.id.clone())
        {
            items.push(record.clone());
        }
    }
    let has_more = consumed < rows.len() || source_has_more;
    Ok(OperationHistoryPage {
        items,
        next_cursor: has_more
            .then(|| encoded_history_cursor(&cursor))
            .transpose()?,
    })
}

#[derive(Clone)]
struct Authorization {
    spec: OperationSpec,
    revision: (Option<String>, Option<String>),
    expires: Option<Instant>,
    origin: LaunchOrigin,
    revision_bound: bool,
}

impl Authorization {
    fn matches(&self, spec: &OperationSpec) -> bool {
        self.expires.is_none_or(|expires| Instant::now() < expires) && &self.spec == spec
    }

    fn revision_matches(&self, revision: &(Option<String>, Option<String>)) -> bool {
        !self.revision_bound || &self.revision == revision
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SquadDispatchKind {
    Authorize,
    Run,
}

#[derive(Debug)]
struct SquadDispatchJob {
    operation_id: String,
    kind: SquadDispatchKind,
}

#[derive(Default)]
struct SquadDispatchState {
    stopping: bool,
    queued: VecDeque<SquadDispatchJob>,
    reserved: HashSet<String>,
    active: HashMap<String, Arc<AtomicU8>>,
    /// Jobs handed to workers since start. Lets tests prove the scheduler does not spin.
    taken: u64,
}

#[derive(Default)]
struct SquadDispatchQueue {
    state: Mutex<SquadDispatchState>,
    changed: Condvar,
}

impl SquadDispatchQueue {
    fn enqueue(&self, operation_id: &str, kind: SquadDispatchKind) -> Result<bool> {
        let mut state = self.state.lock().map_err(|_| poisoned())?;
        if state.stopping || !state.reserved.insert(operation_id.to_owned()) {
            return Ok(false);
        }
        state.queued.push_back(SquadDispatchJob {
            operation_id: operation_id.to_owned(),
            kind,
        });
        self.changed.notify_one();
        Ok(true)
    }

    fn take(&self) -> Option<(SquadDispatchJob, Arc<AtomicU8>)> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        loop {
            if state.stopping {
                return None;
            }
            if let Some(job) = state.queued.pop_front() {
                state.taken += 1;
                let canceled = Arc::new(AtomicU8::new(0));
                state
                    .active
                    .insert(job.operation_id.clone(), canceled.clone());
                return Some((job, canceled));
            }
            state = self
                .changed
                .wait(state)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }

    fn finish(&self, operation_id: &str, canceled: &Arc<AtomicU8>) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state
            .active
            .get(operation_id)
            .is_some_and(|active| Arc::ptr_eq(active, canceled))
        {
            state.active.remove(operation_id);
            state.reserved.remove(operation_id);
        }
    }

    fn cancel(&self, operation_id: &str, user_cancel: bool) -> bool {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(active) = state.active.get(operation_id) {
            active.fetch_max(if user_cancel { 2 } else { 1 }, Ordering::AcqRel);
            true
        } else if state.reserved.remove(operation_id) {
            state.queued.retain(|job| job.operation_id != operation_id);
            false
        } else {
            false
        }
    }

    fn reserved_ids(&self) -> HashSet<String> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .reserved
            .clone()
    }

    fn is_reserved(&self, operation_id: &str) -> bool {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .reserved
            .contains(operation_id)
    }

    fn stop(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.stopping = true;
        state.queued.clear();
        for canceled in state.active.values() {
            canceled.fetch_max(1, Ordering::AcqRel);
        }
        self.changed.notify_all();
    }

    #[cfg(test)]
    fn jobs_taken(&self) -> u64 {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .taken
    }
}

/// Owns one taken job's exact-ID reservation. `release` normally runs under the Operations gate,
/// so it linearizes with cancel/update/hold. Dropping an unreleased guard (an early error return
/// or a panic) still frees the member: a reservation can never outlive its job.
struct DispatchReservation {
    queue: Arc<SquadDispatchQueue>,
    operation_id: String,
    canceled: Arc<AtomicU8>,
    released: AtomicBool,
}

impl DispatchReservation {
    fn release(&self) {
        if !self.released.swap(true, Ordering::AcqRel) {
            self.queue.finish(&self.operation_id, &self.canceled);
        }
    }
}

impl Drop for DispatchReservation {
    fn drop(&mut self) {
        self.release();
    }
}

/// The account/runtime authority an Operations effect borrows. Production always uses the IPC or
/// scheduler `RuntimeState`; tests use a stub so dispatch can run without a Tauri app.
trait OperationsLease {
    fn revalidate_core(&self) -> Result<()>;
}

impl OperationsLease for RuntimeState<OperationsState> {
    fn revalidate_core(&self) -> Result<()> {
        RuntimeState::revalidate_core(self)
    }
}

/// Acquires a fresh lease for each scheduler tick or dispatch job.
type LeaseSource = Arc<dyn Fn() -> Result<Box<dyn OperationsLease>> + Send + Sync>;

fn app_leases(app: &AppHandle) -> LeaseSource {
    let app = app.clone();
    Arc::new(move || {
        RuntimeState::<OperationsState>::from_app(&app)
            .map(|lease| Box::new(lease) as Box<dyn OperationsLease>)
            .map_err(|_| unavailable())
    })
}

/// The provider-pane effects Operations performs, mostly outside its gate. Production always uses
/// the canonical thread runtime; tests substitute a deliberately slow pane factory to prove the
/// dispatcher never holds the Operations gate across a provider spawn.
trait OperationPanes: Send + Sync {
    fn canonicalize(
        &self,
        threads: &ThreadsState,
        core: &Arc<Core>,
        spec: &OperationSpec,
    ) -> Result<OperationSpec>;
    /// Creates (or resumes) a member's pane without sending its task.
    fn prepare(
        &self,
        threads: &ThreadsState,
        request: OperationPaneRequest<'_>,
    ) -> Result<ThreadSummary>;
    /// Creates a pane and, when the spec has a prompt, sends it.
    fn start(
        &self,
        threads: &ThreadsState,
        request: OperationPaneRequest<'_>,
    ) -> Result<ThreadSummary>;
    /// Releases an already-prepared pane and sends its task, when it has one.
    fn deliver(
        &self,
        threads: &ThreadsState,
        operation_id: &str,
        prompt: Option<&str>,
    ) -> Result<ThreadSummary>;
    /// Reclaims a prepared pane the person typed into, after an explicit Run now.
    fn rearm(&self, threads: &ThreadsState, operation_id: &str) -> Result<bool>;
}

struct ThreadPanes;

impl OperationPanes for ThreadPanes {
    fn canonicalize(
        &self,
        threads: &ThreadsState,
        core: &Arc<Core>,
        spec: &OperationSpec,
    ) -> Result<OperationSpec> {
        threads.canonicalize_operation(core, spec)
    }

    fn prepare(
        &self,
        threads: &ThreadsState,
        request: OperationPaneRequest<'_>,
    ) -> Result<ThreadSummary> {
        threads.prepare_operation(request)
    }

    fn start(
        &self,
        threads: &ThreadsState,
        request: OperationPaneRequest<'_>,
    ) -> Result<ThreadSummary> {
        threads.start_operation(request)
    }

    fn deliver(
        &self,
        threads: &ThreadsState,
        operation_id: &str,
        prompt: Option<&str>,
    ) -> Result<ThreadSummary> {
        let runtime = threads.runtime_handle().ok_or_else(unavailable)?;
        match prompt {
            Some(prompt) => runtime.send_prepared_operation(operation_id, prompt),
            None => runtime.dependency_ready(operation_id),
        }
    }

    fn rearm(&self, threads: &ThreadsState, operation_id: &str) -> Result<bool> {
        match threads.runtime_handle() {
            Some(runtime) => runtime.rearm_prepared_pane(operation_id),
            None => Ok(false),
        }
    }
}

/// The fields that define a member's real provider pane. Task text and scheduling metadata can
/// change without replacing a pane; these cannot.
fn same_execution_identity(left: &OperationSpec, right: &OperationSpec) -> bool {
    left.workspace_id == right.workspace_id
        && left.kind == right.kind
        && left.provider_id == right.provider_id
        && left.provider_account_id == right.provider_account_id
        && left.model == right.model
        && left.effort == right.effort
}

pub struct OperationsState {
    core: Arc<Core>,
    store: OperationsStore,
    threads: Arc<ThreadsState>,
    git: Arc<GitCore>,
    /// The signed-in account whose verified plan caps open terminals and queued tasks. `None`
    /// applies the signed-out (Free) caps.
    account: Option<Arc<AccountRuntime>>,
    /// Serializes claims, confirmations, edits and effects; never held on the UI thread.
    gate: Mutex<()>,
    /// Consent is exact-object and account-epoch scoped, never restored from disk.
    authorized: Mutex<HashMap<String, Authorization>>,
    squad_dispatch: Arc<SquadDispatchQueue>,
    squad_workers: Mutex<Vec<JoinHandle<()>>>,
    /// Provider-pane effects; always the canonical thread runtime outside tests.
    panes: Arc<dyn OperationPanes>,
    stop: Arc<(Mutex<bool>, Condvar)>,
    worker: Mutex<Option<JoinHandle<()>>>,
    observations: Mutex<Option<(Instant, Vec<DevelopmentService>, bool)>>,
    commits: Mutex<Option<(Instant, Vec<OperationActivity>)>>,
    /// Final artifact handoffs are checked once per process; transient collector errors retry.
    artifact_checked: Mutex<HashSet<String>>,
    /// Live-only optional speech sink. Operations remains the durable source of completion
    /// metadata; this is invoked only after its final write commits.
    voice_callback: Option<OperationAnnouncer>,
}

impl OperationsState {
    pub(crate) fn start(
        core: Arc<Core>,
        threads: Arc<ThreadsState>,
        git: Arc<GitCore>,
        account: Arc<AccountRuntime>,
        voice_callback: Option<OperationAnnouncer>,
        app: &AppHandle,
    ) -> Result<Arc<Self>> {
        let store = OperationsStore::new(core.clone());
        store.recover()?;
        store.hold_unstarted_squad_members_after_restart()?;
        let state = Arc::new(Self {
            core,
            store,
            threads,
            git,
            account: Some(account),
            gate: Mutex::new(()),
            authorized: Mutex::new(HashMap::new()),
            squad_dispatch: Arc::new(SquadDispatchQueue::default()),
            squad_workers: Mutex::new(Vec::new()),
            panes: Arc::new(ThreadPanes),
            stop: Arc::new((Mutex::new(false), Condvar::new())),
            worker: Mutex::new(None),
            observations: Mutex::new(None),
            commits: Mutex::new(None),
            artifact_checked: Mutex::new(HashSet::new()),
            voice_callback,
        });
        // Each tick and dispatch borrows the same account authority as an IPC command. No
        // detached scheduler or worker can outlive sign-out or execute while the runtime drains.
        let leases = app_leases(app);
        state.start_squad_workers(leases.clone())?;
        state.start_scheduler(leases)?;
        Ok(state)
    }

    fn start_scheduler(self: &Arc<Self>, leases: LeaseSource) -> Result<()> {
        let weak = Arc::downgrade(self);
        let stop = self.stop.clone();
        let worker = std::thread::Builder::new()
            .name("operations".into())
            .spawn(move || {
                loop {
                    let (lock, wake) = &*stop;
                    let Ok(stopping) = lock.lock() else { break };
                    let Ok((stopping, _)) = wake.wait_timeout(stopping, Duration::from_secs(1))
                    else {
                        break;
                    };
                    if *stopping {
                        break;
                    }
                    drop(stopping);
                    let Some(state) = weak.upgrade() else { break };
                    let Ok(lease) = leases() else {
                        continue;
                    };
                    if lease.revalidate_core().is_err() {
                        continue;
                    }
                    if let Err(error) = state.tick(&*lease) {
                        tracing::warn!(event = "operations.tick_failed", code = error.code);
                        let _ = state.store.set_paused(true);
                    }
                }
            })
            .map_err(|_| {
                self.squad_dispatch.stop();
                if let Ok(mut workers) = self.squad_workers.lock() {
                    for worker in workers.drain(..) {
                        let _ = worker.join();
                    }
                }
                KalError::internal(
                    "operations_worker_unavailable",
                    "Operations could not start its scheduler.",
                )
            })?;
        *self.worker.lock().map_err(|_| poisoned())? = Some(worker);
        Ok(())
    }

    fn start_squad_workers(self: &Arc<Self>, leases: LeaseSource) -> Result<()> {
        let mut workers: Vec<JoinHandle<()>> = Vec::with_capacity(SQUAD_DISPATCH_WORKERS);
        for index in 0..SQUAD_DISPATCH_WORKERS {
            let weak = Arc::downgrade(self);
            let leases = leases.clone();
            let queue = self.squad_dispatch.clone();
            let worker = std::thread::Builder::new()
                .name(format!("operations-squad-{index}"))
                .spawn(move || {
                    while let Some((job, canceled)) = queue.take() {
                        let reservation = DispatchReservation {
                            queue: queue.clone(),
                            operation_id: job.operation_id.clone(),
                            canceled: canceled.clone(),
                            released: AtomicBool::new(false),
                        };
                        let Some(state) = weak.upgrade() else { break };
                        if state.run_dispatch_job(&job, &reservation, &leases) {
                            // Wake the scheduler only for a real ledger change. A no-op job (for
                            // example a pane that is still waiting) must not re-arm it at once.
                            state.stop.1.notify_all();
                        }
                    }
                })
                .map_err(|_| {
                    self.squad_dispatch.stop();
                    for worker in workers.drain(..) {
                        let _ = worker.join();
                    }
                    KalError::internal(
                        "operations_worker_unavailable",
                        "Operations could not start its Squad dispatcher.",
                    )
                })?;
            workers.push(worker);
        }
        *self.squad_workers.lock().map_err(|_| poisoned())? = workers;
        Ok(())
    }

    /// Runs one taken dispatch job to completion and always releases its reservation. A panic in
    /// provider or store code is contained here: it is logged, the member is held with a reason,
    /// and the worker keeps serving the pool. Returns whether the ledger changed.
    fn run_dispatch_job(
        &self,
        job: &SquadDispatchJob,
        reservation: &DispatchReservation,
        leases: &LeaseSource,
    ) -> bool {
        let canceled = &reservation.canceled;
        let before = self.store.revision().ok();
        let mut settled = true;
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let result = leases().and_then(|lease| {
                lease.revalidate_core()?;
                self.execute_squad_dispatch(job, canceled, &*lease)
            });
            self.complete_squad_dispatch(job, reservation, result)
        }));
        match outcome {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                settled = false;
                if !dispatch_canceled(canceled) || error.code == "operation_cleanup_unproven" {
                    tracing::warn!(
                        event = "operations.squad_dispatch_failed",
                        operation_id = job.operation_id,
                        code = error.code
                    );
                }
            }
            Err(_) => {
                settled = false;
                tracing::error!(
                    event = "operations.squad_dispatch_panicked",
                    operation_id = job.operation_id
                );
                self.hold_panicked_dispatch(&job.operation_id);
            }
        }
        // An early error or a panic may skip the gated release in `complete_squad_dispatch`.
        // Release under the gate here so a racing cancel still sees one linear order.
        {
            let _gate = self.lock_gate_after_panic();
            if !settled && dispatch_user_canceled(canceled) {
                self.clear_unsettled_cancellation(&job.operation_id);
            }
            reservation.release();
        }
        before.is_none() || self.store.revision().ok() != before
    }

    /// The gate guards no in-memory data (`Mutex<()>`); ledger writes are transactional. A panic
    /// while it was held must not wedge every later Operations command, so clear the poison.
    fn lock_gate_after_panic(&self) -> std::sync::MutexGuard<'_, ()> {
        self.gate.lock().unwrap_or_else(|poisoned| {
            self.gate.clear_poison();
            poisoned.into_inner()
        })
    }

    /// A cancel whose settlement failed must not leave "Stopping safely" behind: return the member
    /// to an actionable hold so the person can cancel it again or Run now.
    fn clear_unsettled_cancellation(&self, id: &str) {
        let stuck = self.store.get(id).is_ok_and(|row| {
            matches!(
                row.status,
                OperationStatus::Queued | OperationStatus::Blocked | OperationStatus::Paused
            ) && row.current_action.as_deref() == Some(OPERATION_CANCELLING_ACTION)
        });
        if stuck
            && let Err(error) = self
                .store
                .hold_with_reason(id, kalcode_core::operations::UNSETTLED_CANCELLATION_REASON)
        {
            tracing::warn!(
                event = "operations.squad_cancel_hold_failed",
                operation_id = id,
                code = error.code
            );
        }
    }

    fn hold_panicked_dispatch(&self, id: &str) {
        const REASON: &str = "This Squad member stopped unexpectedly while starting. Inspect its pane, then Run now to retry.";
        let _gate = self.lock_gate_after_panic();
        self.authorized
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(id);
        let held = match self.store.get(id).map(|row| row.status) {
            Ok(OperationStatus::Queued | OperationStatus::Blocked | OperationStatus::Paused) => {
                self.store.hold_with_reason(id, REASON)
            }
            // The panic may have come after the prompt reached the pane but before bind. Only a
            // provably unsent member returns to a hold; any other ends interrupted, never resent.
            Ok(OperationStatus::Starting) => {
                self.store.settle_panicked_start(id, REASON).map(|_| ())
            }
            Ok(_) => Ok(()),
            Err(error) => Err(error),
        };
        if let Err(error) = held {
            tracing::warn!(
                event = "operations.squad_dispatch_panic_hold_failed",
                operation_id = id,
                code = error.code
            );
        }
    }

    fn plan_limit(&self, kind: Limited) -> Option<PlanLimit> {
        self.account.as_ref().map_or_else(
            || AccountSnapshot::signed_out().plan_limit(kind),
            |account| account.snapshot().plan_limit(kind),
        )
    }

    fn ensure_dispatch_not_cancelling(&self, id: &str) -> Result<()> {
        if self.squad_dispatch.is_reserved(id)
            && self
                .store
                .get(id)?
                .current_action
                .as_deref()
                .is_some_and(|action| action == OPERATION_CANCELLING_ACTION)
        {
            return Err(KalError::validation(
                "operation_cancellation_in_progress",
                "This Squad member is still stopping. Wait for cleanup to finish before running or editing it again.",
            ));
        }
        Ok(())
    }

    /// Run now must never supersede an in-flight dispatch: a member mid-launch may already have
    /// received its task. Refuse clearly instead of cancelling or silently dropping the click.
    fn ensure_dispatch_idle(&self, id: &str) -> Result<()> {
        self.ensure_dispatch_not_cancelling(id)?;
        if self.squad_dispatch.is_reserved(id) {
            return Err(dispatch_in_progress());
        }
        Ok(())
    }

    pub(crate) fn core(&self) -> &Arc<Core> {
        &self.core
    }

    pub(crate) fn queue_limit(&self) -> Option<PlanLimit> {
        self.plan_limit(Limited::QueuedTasks)
    }

    pub(crate) fn plan_tier(&self) -> PlanTier {
        self.account.as_ref().map_or_else(
            || AccountSnapshot::signed_out().plan_tier(),
            |account| account.snapshot().plan_tier(),
        )
    }

    /// Authorizes the newly-created, still-queued members of one explicit Squad launch. A
    /// provider/account failure pauses only that member with a durable actionable reason; all
    /// compatible siblings remain authorized. Replayed launch IPC cannot reauthorize an active,
    /// paused, blocked, interrupted, cancelled, or completed operation.
    pub(crate) fn authorize_squad_members(
        &self,
        _app: &AppHandle,
        operation_ids: &[String],
    ) -> Result<()> {
        self.queue_squad_authorizations(operation_ids)
    }

    /// Only short, gated ledger transitions happen here; every provider spawn and worktree
    /// creation runs on the dispatcher outside the global Operations gate.
    fn queue_squad_authorizations(&self, operation_ids: &[String]) -> Result<()> {
        let _gate = self.gate.lock().map_err(|_| poisoned())?;
        for id in operation_ids {
            let row = self.store.detail(id)?.run;
            if row.status != OperationStatus::Queued {
                continue;
            }
            if self
                .authorized
                .lock()
                .map_err(|_| poisoned())?
                .get(id)
                .is_some_and(|consent| consent.matches(&row.spec))
            {
                continue;
            }
            if !self.store.mark_squad_authorized(id)? {
                continue;
            }
            self.squad_dispatch
                .enqueue(id, SquadDispatchKind::Authorize)?;
        }
        self.stop.1.notify_all();
        Ok(())
    }

    fn execute_squad_dispatch(
        &self,
        job: &SquadDispatchJob,
        canceled: &AtomicU8,
        lease: &dyn OperationsLease,
    ) -> Result<bool> {
        match job.kind {
            SquadDispatchKind::Authorize => {
                self.authorize_squad_member(&job.operation_id, canceled, lease)?;
                // A successful member does not wait behind the rest of a large Squad's
                // authorization queue. It immediately uses this same exact-ID reservation to
                // prepare or start its real pane; the bounded workers keep pulling siblings.
                self.run_squad_member(&job.operation_id, canceled, lease)
            }
            SquadDispatchKind::Run => self.run_squad_member(&job.operation_id, canceled, lease),
        }
    }

    /// Settles one dispatch under the gate and releases its reservation there. `result` is
    /// `Ok(true)` when this dispatch created the member's pane.
    fn complete_squad_dispatch(
        &self,
        job: &SquadDispatchJob,
        reservation: &DispatchReservation,
        mut result: Result<bool>,
    ) -> Result<()> {
        let id = job.operation_id.as_str();
        let canceled = &reservation.canceled;
        let mut cleaned = false;
        loop {
            // Only an explicit user cancel tears a pane down here, and only one that never
            // received a task: a still-pending member's prepared pane. A started or running
            // member may already have its prompt, so it takes the ordinary cancel path below
            // (stop, capture evidence, no archive). A hold or shutdown never stops a pane here.
            // This closes both races: a token visible after the factory, and one set after that
            // check but before the worker reacquires the global gate.
            if dispatch_user_canceled(canceled) && !cleaned {
                let row = self.store.detail(id)?.run;
                if matches!(
                    row.status,
                    OperationStatus::Queued | OperationStatus::Blocked | OperationStatus::Paused
                ) {
                    let cleanup = if result.as_ref().is_ok_and(|created| *created) {
                        self.reap_created_squad_thread(&row)
                    } else {
                        self.stop_exact_squad_thread(&row)
                    };
                    if let Err(error) = cleanup {
                        result = Err(error);
                    }
                }
                cleaned = true;
            }

            // Settlement must survive a panic elsewhere that poisoned the gate.
            let _gate = self.lock_gate_after_panic();
            if dispatch_user_canceled(canceled) && !cleaned {
                drop(_gate);
                continue;
            }
            if let Err(error) = &result
                && error.code == "operation_cleanup_unproven"
            {
                self.hold_cleanup_unproven(id, &error.message)?;
            } else if dispatch_user_canceled(canceled) {
                let current = self.store.detail(id)?.run;
                match current.status {
                    OperationStatus::Queued
                    | OperationStatus::Blocked
                    | OperationStatus::Paused => self.store.cancel_pending(id)?,
                    // Exactly what the same click a moment later would do.
                    OperationStatus::Starting | OperationStatus::Running => self.cancel(id)?,
                    _ => {}
                }
                self.authorized.lock().map_err(|_| poisoned())?.remove(id);
                // Cancellation is the requested final state; an earlier provider error is no
                // longer actionable once exact cleanup and durable cancellation both succeeded.
                result = Ok(false);
            } else if let Err(error) = &result
                && error.code == MEMBER_PANE_MISMATCH
            {
                // The pane was already stopped by its exact id. Only this member needs attention;
                // the rest of the queue keeps running.
                self.hold_member_with_reason(id, &error.message)?;
            } else {
                self.hold_unbound_start(id)?;
            }
            // The gate linearizes queue release with update/hold/cancel. If cancel acquired it
            // first, its token and durable cancelling state are visible here; if it acquires next,
            // the reservation is gone and it follows the ordinary synchronous cancel path.
            reservation.release();
            return result.map(|_| ());
        }
    }

    /// Returns one member to an actionable hold without touching the global queue.
    fn hold_member_with_reason(&self, id: &str, message: &str) -> Result<()> {
        self.authorized.lock().map_err(|_| poisoned())?.remove(id);
        let reason = safe(message);
        match self.store.get(id)?.status {
            OperationStatus::Queued | OperationStatus::Blocked | OperationStatus::Paused => {
                self.store.hold_with_reason(id, &reason)
            }
            OperationStatus::Starting => self.store.hold_starting_with_reason(id, &reason),
            _ => Ok(()),
        }
    }

    /// A dispatch that claimed a member but never reserved or bound its pane (for example one
    /// stopped by shutdown before the provider started) must not stay `starting` forever.
    fn hold_unbound_start(&self, id: &str) -> Result<()> {
        let row = self.store.get(id)?;
        if row.status == OperationStatus::Starting
            && row.thread_id.is_none()
            && row.terminal_id.is_none()
        {
            self.authorized.lock().map_err(|_| poisoned())?.remove(id);
            self.store
                .hold_starting_with_reason(id, UNBOUND_SQUAD_START_REASON)?;
        }
        Ok(())
    }

    fn authorize_squad_member(
        &self,
        id: &str,
        canceled: &AtomicU8,
        lease: &dyn OperationsLease,
    ) -> Result<()> {
        let row = self.store.detail(id)?.run;
        if row.status != OperationStatus::Queued || dispatch_canceled(canceled) {
            return Ok(());
        }
        let consent = match self.prepare_authorization(&row.spec, LaunchOrigin::User, false, true) {
            Ok(consent) => consent,
            Err(error) => {
                if !dispatch_canceled(canceled) {
                    let _gate = self.lock_gate_after_panic();
                    if self.store.get(id).is_ok_and(|current| {
                        !dispatch_canceled(canceled)
                            && current.status == OperationStatus::Queued
                            && current.spec == row.spec
                    }) {
                        self.store.hold_with_reason(id, &safe(&error.message))?;
                    }
                }
                return Ok(());
            }
        };
        if dispatch_canceled(canceled) {
            return Ok(());
        }
        lease.revalidate_core()?;
        let _gate = self.lock_gate_after_panic();
        let current = self.store.detail(id)?.run;
        if current.status != OperationStatus::Queued
            || current.spec != row.spec
            || dispatch_canceled(canceled)
        {
            return Ok(());
        }
        let current = if consent.spec != current.spec {
            let (revision, _, _) = self.store.snapshot()?;
            self.store.update(id, consent.spec.clone(), revision)?
        } else {
            current
        };
        self.authorized
            .lock()
            .map_err(|_| poisoned())?
            .insert(current.id, consent);
        Ok(())
    }

    fn run_squad_member(
        &self,
        id: &str,
        canceled: &AtomicU8,
        lease: &dyn OperationsLease,
    ) -> Result<bool> {
        self.run_squad_member_once(id, canceled, lease, true)
    }

    /// `rewait` lets a member whose canonical pane exists but is not waiting (for example a pane
    /// the person typed into, then re-armed by Run now) re-enter the dependency wait before its
    /// claim. Delivery always requires that wait, so the task is still sent at most once.
    fn run_squad_member_once(
        &self,
        id: &str,
        canceled: &AtomicU8,
        lease: &dyn OperationsLease,
        rewait: bool,
    ) -> Result<bool> {
        if dispatch_canceled(canceled) {
            return Ok(false);
        }
        let (row, consent, prepare) = {
            let _gate = self.lock_gate_after_panic();
            lease.revalidate_core()?;
            let row = self.store.detail(id)?.run;
            let Some(consent) = self
                .authorized
                .lock()
                .map_err(|_| poisoned())?
                .get(id)
                .filter(|consent| {
                    consent.origin == LaunchOrigin::User && consent.matches(&row.spec)
                })
                .cloned()
            else {
                return Ok(false);
            };
            if SquadsStore::new(self.core.clone())
                .get_member(id)?
                .is_none()
                || !matches!(
                    row.status,
                    OperationStatus::Queued | OperationStatus::Blocked
                )
                || dispatch_canceled(canceled)
            {
                return Ok(false);
            }
            let pane_needs_wait = rewait
                && row.thread_id.as_deref() == Some(row.id.as_str())
                && !self.pane_waiting(&row);
            if !row.blockers.is_empty() || pane_needs_wait {
                (row, consent, true)
            } else {
                if row.status != OperationStatus::Queued {
                    return Ok(false);
                }
                match self.store.claim_user_squad_agent(id) {
                    Ok(Some(claimed)) => (claimed, consent, false),
                    Ok(None) => return Ok(false),
                    // A refused claim holds only this member with its reason; it never fails
                    // the dispatcher or the queue.
                    Err(error) => {
                        self.authorized.lock().map_err(|_| poisoned())?.remove(id);
                        self.store.hold_with_reason(id, &safe(&error.message))?;
                        return Ok(false);
                    }
                }
            }
        };

        if prepare {
            let runtime = self.threads.runtime_handle().ok_or_else(unavailable)?;
            let existed = runtime.get(id).is_ok();
            match self.prepare_squad_member(&row, &consent) {
                Ok(()) => {
                    if dispatch_user_canceled(canceled) {
                        if !existed {
                            self.reap_created_squad_thread(&row)?;
                        }
                        return Ok(false);
                    }
                    if dispatch_canceled(canceled) {
                        // A hold (or shutdown) arrived during preparation. A held member keeps
                        // its prepared waiting pane, exactly like one held after preparing.
                        return Ok(!existed);
                    }
                    let current = self.store.detail(id)?.run;
                    // Task text may be edited while the pane starts; only an execution identity
                    // change (refused while dispatching) would make the new pane wrong.
                    if lease.revalidate_core().is_err()
                        || !matches!(
                            current.status,
                            OperationStatus::Queued | OperationStatus::Blocked
                        )
                        || !same_execution_identity(&current.spec, &row.spec)
                    {
                        if !existed {
                            self.stop_exact_squad_thread(&row)?;
                        }
                        return Ok(false);
                    }
                    if row.blockers.is_empty() {
                        // The pane is waiting again and nothing blocks it: start it now. Keep
                        // reporting a pane this dispatch created so a cancel still reaps it.
                        return self
                            .run_squad_member_once(id, canceled, lease, false)
                            .map(|created| created || !existed);
                    }
                    return Ok(!existed);
                }
                Err(_error) if dispatch_canceled(canceled) => {
                    // A provider factory may report an error after inserting the exact pane. If
                    // a user cancel raced before that insertion, its synchronous stop could not
                    // see it; reap the late pane before the reservation is released. A hold
                    // leaves any pane for the next explicit Run now.
                    if !existed && dispatch_user_canceled(canceled) {
                        self.reap_created_squad_thread(&row)?;
                    }
                }
                Err(error) if error.code == "operation_cleanup_unproven" => {
                    let _ = self.store.set_paused(true);
                    return Err(error);
                }
                Err(error) => {
                    let _gate = self.lock_gate_after_panic();
                    self.authorized.lock().map_err(|_| poisoned())?.remove(id);
                    if self.store.get(id).is_ok_and(|current| {
                        matches!(
                            current.status,
                            OperationStatus::Queued | OperationStatus::Blocked
                        )
                    }) {
                        self.store.hold_with_reason(id, &safe(&error.message))?;
                    }
                }
            }
            return Ok(false);
        }

        let prepared = row.thread_id.as_deref() == Some(row.id.as_str());
        self.launch_with_cancellation(row, lease, Some(canceled))?;
        Ok(!prepared)
    }

    /// The member's canonical pane exists, matches it, and is waiting for its dependencies.
    fn pane_waiting(&self, row: &OperationRecord) -> bool {
        self.threads.runtime_handle().is_some_and(|runtime| {
            runtime.get(&row.id).is_ok_and(|thread| {
                thread.status == ThreadStatus::WaitingForDependency
                    && operation_thread_matches(&thread, &row.spec, &row.id)
            })
        })
    }

    /// Stops a member's pane by its exact Operations-reserved id. The pane is stopped even when
    /// its configuration no longer matches the member (it is still this member's pane); that case
    /// is then reported as a member-scoped mismatch, never as unproven cleanup.
    fn stop_exact_squad_thread(&self, row: &OperationRecord) -> Result<()> {
        let runtime = self.threads.runtime_handle().ok_or_else(unavailable)?;
        let thread = match runtime.get(&row.id) {
            Ok(thread) => thread,
            Err(error) if error.code == "thread_not_found" => return Ok(()),
            Err(error) => return Err(error),
        };
        match runtime.stop(&row.id) {
            Ok(_) => {}
            Err(error) if error.code == "thread_not_running" => {}
            Err(_) => {
                return Err(KalError::internal(
                    "operation_cleanup_unproven",
                    "The canceled Squad pane could not be stopped. Scheduling is paused; inspect the pane before continuing.",
                ));
            }
        }
        if !operation_thread_matches(&thread, &row.spec, &row.id) {
            return Err(KalError::validation(
                MEMBER_PANE_MISMATCH,
                "This Squad member's pane no longer matched its settings, so KalCode stopped it. Review the member, then Run now.",
            ));
        }
        Ok(())
    }

    fn reap_created_squad_thread(&self, row: &OperationRecord) -> Result<()> {
        let stopped = self.stop_exact_squad_thread(row);
        if let Err(error) = &stopped
            && error.code != MEMBER_PANE_MISMATCH
        {
            return stopped;
        }
        let runtime = self.threads.runtime_handle().ok_or_else(unavailable)?;
        match runtime.archive(&row.id) {
            Ok(_) => stopped,
            Err(error) if error.code == "thread_not_found" => stopped,
            Err(_) => Err(KalError::internal(
                "operation_cleanup_unproven",
                "The canceled Squad pane stopped but its isolated workspace could not be released. Scheduling is paused; inspect the pane before continuing.",
            )),
        }
    }

    fn hold_cleanup_unproven(&self, id: &str, message: &str) -> Result<()> {
        let reason = safe(message);
        self.store.set_paused(true)?;
        self.authorized.lock().map_err(|_| poisoned())?.remove(id);
        self.store.hold_cleanup_unproven(id, &reason)
    }

    fn terminal_limit(&self) -> Option<PlanLimit> {
        self.plan_limit(Limited::OpenTerminals)
    }

    pub fn shutdown_checked(&self) -> bool {
        let (lock, wake) = &*self.stop;
        let Ok(mut stopping) = lock.lock() else {
            return false;
        };
        *stopping = true;
        wake.notify_all();
        self.squad_dispatch.stop();
        drop(stopping);
        let scheduler_clean = self
            .worker
            .lock()
            .map(|mut worker| worker.take().is_none_or(|worker| worker.join().is_ok()))
            .unwrap_or(false);
        // Always join every owned dispatcher. Returning on the first panic would drop the rest
        // of the handles and let those workers outlive a later apparently-successful shutdown.
        let workers_clean = self
            .squad_workers
            .lock()
            .map(|mut workers| {
                workers
                    .drain(..)
                    .map(JoinHandle::join)
                    // Join every handle (no short-circuit), then report whether all were clean.
                    .filter(Result::is_err)
                    .count()
                    == 0
            })
            .unwrap_or(false);
        let state_clean = self.authorized.lock().map(|mut ids| ids.clear()).is_ok()
            && self.store.set_paused(true).is_ok();
        scheduler_clean && workers_clean && state_clean
    }

    fn tick(&self, lease: &dyn OperationsLease) -> Result<()> {
        let Ok(_gate) = self.gate.try_lock() else {
            return Ok(());
        };
        let dispatching = self.squad_dispatch.reserved_ids();
        self.reconcile_excluding(&dispatching)?;
        let (_, paused, rows) = self.store.snapshot()?;
        self.prune_finished_terminals(&rows)?;
        let authorized = self.authorized.lock().map_err(|_| poisoned())?.clone();
        let runtime = self.threads.runtime_handle();
        // Dependency-bound Squad members are real agents from the moment the Squad launches.
        // Prepare their canonical panes without a prompt; dependency admission below remains the
        // only path that can deliver the first task.
        for row in &rows {
            let Some(consent) = authorized.get(&row.id) else {
                continue;
            };
            if consent.origin != LaunchOrigin::User
                || row.spec.kind != OperationKind::Agent
                || !matches!(
                    row.status,
                    OperationStatus::Queued | OperationStatus::Blocked
                )
                || (row.thread_id.is_none() && row.blockers.is_empty())
                || !consent.matches(&row.spec)
            {
                continue;
            }
            // A pane that is already prepared and waiting has nothing to do until its
            // dependencies succeed. Re-dispatching it every tick would only spin the scheduler.
            if !row.blockers.is_empty()
                && row.thread_id.as_deref() == Some(row.id.as_str())
                && runtime.as_ref().is_some_and(|runtime| {
                    runtime.get(&row.id).is_ok_and(|thread| {
                        thread.status == ThreadStatus::WaitingForDependency
                            && operation_thread_matches(&thread, &row.spec, &row.id)
                    })
                })
            {
                continue;
            }
            if SquadsStore::new(self.core.clone())
                .get_member(&row.id)?
                .is_none()
            {
                continue;
            }
            self.squad_dispatch
                .enqueue(&row.id, SquadDispatchKind::Run)?;
        }
        let (_, _, rows) = self.store.snapshot()?;
        // Store snapshot is dependency/priority ordered. Only native-confirmed Next tasks can
        // auto-start. One-use consent is consumed before launch, including failed launches.
        // Ordinary background work keeps one launch per tick; Squad members only queue here and
        // start on the dispatcher, so they are never serialized behind it.
        let mut launched = false;
        for row in rows {
            let Some(consent) = authorized
                .get(&row.id)
                .filter(|consent| consent.matches(&row.spec))
            else {
                continue;
            };
            if row.spec.lane != OperationLane::Next
                || row.status != OperationStatus::Queued
                || !row.blockers.is_empty()
            {
                continue;
            }
            if consent.origin == LaunchOrigin::User
                && SquadsStore::new(self.core.clone())
                    .get_member(&row.id)?
                    .is_some()
            {
                // An explicit Squad launch or Run now is the user's own action: it bypasses the
                // global pause on its scoped dispatcher, exactly like `claim_user_squad_agent`.
                self.squad_dispatch
                    .enqueue(&row.id, SquadDispatchKind::Run)?;
                continue;
            }
            if paused || launched {
                continue;
            }
            if !consent.revision_matches(&self.authorization_revision(&row)?) {
                self.authorized
                    .lock()
                    .map_err(|_| poisoned())?
                    .remove(&row.id);
                continue;
            }
            lease.revalidate_core()?;
            match self.store.claim(Some(&row.id)) {
                Ok(Some(claimed)) => {
                    self.launch(claimed, lease)?;
                    launched = true;
                }
                Ok(None) => {}
                Err(error)
                    if matches!(
                        error.code,
                        "operation_slot_unavailable" | "operation_provider_account_missing"
                    ) =>
                {
                    continue;
                }
                Err(error) => {
                    // One row's refusal must never abort the tick: the scheduler would pause the
                    // whole queue and every later row (including ready Squad members) would stall.
                    tracing::warn!(
                        event = "operations.claim_refused",
                        operation_id = row.id,
                        code = error.code
                    );
                    self.authorized
                        .lock()
                        .map_err(|_| poisoned())?
                        .remove(&row.id);
                    if let Err(hold) = self.store.hold_with_reason(&row.id, &safe(&error.message)) {
                        tracing::warn!(
                            event = "operations.claim_refusal_hold_failed",
                            operation_id = row.id,
                            code = hold.code
                        );
                    }
                }
            }
        }
        Ok(())
    }

    fn prepare_squad_member(&self, row: &OperationRecord, consent: &Authorization) -> Result<()> {
        let runtime = self.threads.runtime_handle().ok_or_else(unavailable)?;
        if row.thread_id.as_deref() == Some(row.id.as_str()) {
            match runtime.get(&row.id) {
                Ok(thread)
                    if thread.status == ThreadStatus::WaitingForDependency
                        && operation_thread_matches(&thread, &row.spec, &row.id) =>
                {
                    return Ok(());
                }
                Ok(_) => {}
                Err(error) if error.code == "thread_not_found" => {}
                Err(error) => return Err(error),
            }
        }
        let member = SquadsStore::new(self.core.clone())
            .get_member(&row.id)?
            .ok_or_else(|| {
                KalError::internal(
                    "squad_member_missing",
                    "This Squad member is no longer linked to its Operation.",
                )
            })?;
        let revision = if member.worktree && row.thread_id.as_deref() == Some(row.id.as_str()) {
            (row.branch.clone(), row.version.clone())
        } else {
            self.revision(&row.spec.workspace_id)?
        };
        if !consent.revision_matches(&revision) {
            return Err(KalError::validation(
                "operation_authorization_changed",
                "This member's workspace changed before its provider pane could start. Run it again to revalidate.",
            ));
        }
        let execution_branch = if member.worktree {
            row.branch.clone().or_else(|| {
                Some(crate::thread_commands::operation_branch_name(
                    Some(&row.spec.name),
                    &row.id,
                ))
            })
        } else {
            revision.0.clone()
        };
        self.store.prepare_agent_thread(
            &row.id,
            execution_branch.as_deref(),
            revision.1.as_deref(),
        )?;
        match self.panes.prepare(
            &self.threads,
            OperationPaneRequest {
                core: &self.core,
                git: &self.git,
                operation_id: &row.id,
                spec: &row.spec,
                origin: consent.origin,
                isolate: member.worktree,
                start_revision: revision.1.as_deref(),
            },
        ) {
            Ok(thread) if operation_thread_matches(&thread, &row.spec, &row.id) => Ok(()),
            Ok(_) => Err(KalError::internal(
                "operation_thread_identity_mismatch",
                "The prepared provider pane did not match its Squad member.",
            )),
            Err(start_error) => match runtime.get(&row.id) {
                Err(error) if error.code == "thread_not_found" => {
                    self.store.clear_prepared_agent_thread(&row.id)?;
                    Err(start_error)
                }
                Ok(thread) if operation_thread_matches(&thread, &row.spec, &row.id) => {
                    Err(start_error)
                }
                Ok(_) | Err(_) => Err(KalError::internal(
                    "operation_cleanup_unproven",
                    "The prepared provider pane identity could not be verified. Scheduling is paused; inspect the member before continuing.",
                )),
            },
        }
    }

    fn prune_finished_terminals(&self, rows: &[OperationRecord]) -> Result<()> {
        // Finished command output belongs to the durable run. Keep four recent terminal tabs
        // per workspace; pruning keeps the visible terminal list manageable.
        for workspace in self.core.workspaces()? {
            let mut finished = self
                .core
                .terminals(&workspace.id)?
                .into_iter()
                .filter_map(|terminal| {
                    let row = rows.iter().find(|row| {
                        row.id == terminal.id
                            && row.terminal_id.as_deref() == Some(terminal.id.as_str())
                            && row.spec.workspace_id == workspace.id
                            && row.source == "operations"
                            && matches!(
                                row.status,
                                OperationStatus::Succeeded
                                    | OperationStatus::Failed
                                    | OperationStatus::Cancelled
                                    | OperationStatus::Interrupted
                            )
                    })?;
                    (terminal.status != TerminalStatus::Running
                        && terminal.shell_id.starts_with("operation:"))
                    .then_some((terminal, row))
                })
                .collect::<Vec<_>>();
            finished.sort_by(|(a, _), (b, _)| b.ended_at.cmp(&a.ended_at).then(b.id.cmp(&a.id)));
            for (terminal, row) in finished.into_iter().skip(4) {
                self.capture_output(row)?;
                self.core.close_terminal(&terminal.id)?;
            }
        }
        Ok(())
    }

    #[cfg(test)]
    fn reconcile(&self) -> Result<()> {
        self.reconcile_excluding(&HashSet::new())
    }

    fn reconcile_excluding(&self, dispatching: &HashSet<String>) -> Result<()> {
        let (_, _, rows) = self.store.snapshot()?;
        let visible = rows
            .iter()
            .map(|row| row.id.as_str())
            .collect::<HashSet<_>>();
        self.artifact_checked
            .lock()
            .map_err(|_| poisoned())?
            .retain(|id| visible.contains(id.as_str()));
        // Recovery can settle a terminal before this coordinator starts. Artifact reports remain
        // at their per-run handoff path until this durable import succeeds.
        for row in rows.iter().filter(|row| {
            row.source == "operations"
                && row.terminal_id.as_deref() == Some(row.id.as_str())
                && matches!(
                    row.status,
                    OperationStatus::Succeeded
                        | OperationStatus::Failed
                        | OperationStatus::Cancelled
                        | OperationStatus::Interrupted
                )
        }) {
            self.capture_artifacts(row);
        }
        for mut row in rows.into_iter().filter(|r| {
            !dispatching.contains(&r.id)
                && matches!(
                    r.status,
                    OperationStatus::Running | OperationStatus::Starting
                )
        }) {
            if row.thread_id.is_none() && row.spec.kind == OperationKind::Agent {
                let runtime = self.threads.runtime_handle().ok_or_else(unavailable)?;
                match runtime.get(&row.id) {
                    Ok(thread) if operation_thread_matches(&thread, &row.spec, &row.id) => {
                        self.store.bind(
                            &row.id,
                            None,
                            Some(&row.id),
                            row.branch.as_deref(),
                            row.version.as_deref(),
                        )?;
                        row.thread_id = Some(row.id.clone());
                    }
                    Ok(_) => {
                        return Err(KalError::internal(
                            "operation_thread_identity_mismatch",
                            "A reserved Operations thread did not match its task. Scheduling is paused; inspect the run before continuing.",
                        ));
                    }
                    // A Squad member is claimed under the gate but starts on the dispatcher.
                    // Once no dispatch owns it, a claim that never reserved a pane is abandoned:
                    // return it to an actionable hold instead of leaving it `starting` forever.
                    Err(error)
                        if error.code == "thread_not_found"
                            && row.status == OperationStatus::Starting
                            && SquadsStore::new(self.core.clone())
                                .get_member(&row.id)?
                                .is_some() =>
                    {
                        self.authorized
                            .lock()
                            .map_err(|_| poisoned())?
                            .remove(&row.id);
                        self.store
                            .hold_starting_with_reason(&row.id, UNBOUND_SQUAD_START_REASON)?;
                        continue;
                    }
                    Err(error) if error.code == "thread_not_found" => {}
                    Err(error) => return Err(error),
                }
            }
            if row.terminal_id.is_none() && row.spec.kind != OperationKind::Agent {
                match self.core.terminal(&row.id) {
                    Ok(terminal)
                        if terminal.workspace_id == row.spec.workspace_id
                            && terminal.shell_id.starts_with("operation:") =>
                    {
                        self.store.bind(
                            &row.id,
                            Some(&terminal.id),
                            None,
                            row.branch.as_deref(),
                            row.version.as_deref(),
                        )?;
                        row.terminal_id = Some(terminal.id);
                    }
                    Err(error) if error.code != "not_found" => return Err(error),
                    _ => {}
                }
            }
            if let Some(id) = &row.terminal_id {
                match self.core.terminal(id) {
                    Ok(terminal) => {
                        if let Some((status, outcome)) = terminal_outcome(&terminal) {
                            let artifact_note = self.capture_artifacts(&row);
                            let mut outcome = self.with_output_evidence(&row, &outcome);
                            if let Some(note) = artifact_note {
                                outcome.push(' ');
                                outcome.push_str(note);
                            }
                            if let Some(ended_at) = terminal.ended_at.as_deref() {
                                self.finish_run_at(&row.id, status, outcome.as_str(), ended_at)?;
                            } else {
                                self.finish_run(&row.id, status, outcome.as_str())?;
                            }
                        }
                    }
                    Err(error) if error.code == "not_found" => self.finish_run(
                        &row.id,
                        OperationStatus::Interrupted,
                        "The terminal is no longer available; completion was not observed.",
                    )?,
                    Err(error) => return Err(error),
                }
            } else if let Some(id) = &row.thread_id {
                let completed = self.core.query_events(&EventQuery {
                    types: vec!["agent.turn_completed".into()],
                    correlation: CorrelationFilter {
                        thread_id: Some(id.clone()),
                        ..Default::default()
                    },
                    from: row.started_at.clone(),
                    order: SeqOrder::Asc,
                    limit: 1,
                    ..Default::default()
                })?;
                if let Some(event) = completed.events.first()
                    && let EventPayload::AgentTurnCompleted {
                        ok, interrupted, ..
                    } = event.event
                {
                    let (status, outcome) = if interrupted {
                        (
                            OperationStatus::Interrupted,
                            "The provider turn was interrupted.",
                        )
                    } else if ok {
                        (
                            OperationStatus::Succeeded,
                            "The provider completed the task.",
                        )
                    } else {
                        (
                            OperationStatus::Failed,
                            "The provider reported an unsuccessful task.",
                        )
                    };
                    self.finish_run_at(&row.id, status, outcome, &event.occurred_at)?;
                    continue;
                }
                let thread = match self
                    .threads
                    .runtime_handle()
                    .ok_or_else(unavailable)?
                    .get(id)
                {
                    Ok(thread) => thread,
                    // Reconcile runs under the gate, so no launch is between reserving this
                    // identity and creating its thread: a missing thread was removed.
                    Err(error) if error.code == "thread_not_found" => {
                        self.finish_run(
                            &row.id,
                            OperationStatus::Interrupted,
                            "The provider thread is no longer available; completion was not observed.",
                        )?;
                        continue;
                    }
                    Err(error) => return Err(error),
                };
                let status = thread_status(thread.status);
                if matches!(
                    status,
                    OperationStatus::Succeeded
                        | OperationStatus::Failed
                        | OperationStatus::Interrupted
                ) {
                    self.finish_run(
                        &row.id,
                        status,
                        thread
                            .current_activity
                            .as_deref()
                            .unwrap_or("Provider turn ended."),
                    )?;
                }
            }
        }
        Ok(())
    }

    fn finish_run<'a>(
        &self,
        id: &str,
        status: OperationStatus,
        outcome: impl Into<Option<&'a str>>,
    ) -> Result<()> {
        self.store.finish(id, status, outcome)?;
        self.announce_finished(id);
        Ok(())
    }

    fn finish_run_at<'a>(
        &self,
        id: &str,
        status: OperationStatus,
        outcome: impl Into<Option<&'a str>>,
        ended_at: &str,
    ) -> Result<()> {
        self.store.finish_at(id, status, outcome, ended_at)?;
        self.announce_finished(id);
        Ok(())
    }

    fn announce_finished(&self, id: &str) {
        if let Some(memory) = self.threads.memory()
            && let Ok(run) = self.store.get(id)
            && let Some(outcome) = &run.outcome
        {
            memory.capture(
                &run.spec.workspace_id,
                kalcode_contracts::unified_memory::MemorySourceKind::Run,
                id,
                outcome,
            );
        }
        let Some(announce) = &self.voice_callback else {
            return;
        };
        match self.store.get(id) {
            Ok(run) => announce(OperationCallback {
                id: run.id,
                name: run.spec.name,
                kind: run.spec.kind,
                status: run.status,
                thread_id: run.thread_id,
                workspace_id: Some(run.spec.workspace_id),
            }),
            Err(error) => tracing::warn!(
                event = "operations.voice_callback_skipped",
                operation_id = id,
                code = error.code
            ),
        }
    }

    fn launch(&self, row: OperationRecord, lease: &dyn OperationsLease) -> Result<()> {
        self.launch_with_cancellation(row, lease, None)
    }

    fn launch_with_cancellation(
        &self,
        row: OperationRecord,
        lease: &dyn OperationsLease,
        canceled: Option<&AtomicU8>,
    ) -> Result<()> {
        if canceled.is_some_and(dispatch_canceled) {
            self.authorized
                .lock()
                .map_err(|_| poisoned())?
                .remove(&row.id);
            return Ok(());
        }
        let consent = self.take_authorization(&row.id)?;
        let revision = match self.authorization_revision(&row) {
            Ok(revision) => revision,
            Err(error) => {
                self.finish_run(
                    &row.id,
                    OperationStatus::Failed,
                    "Workspace revision could not be verified; execution did not start.",
                )?;
                return Err(error);
            }
        };
        let Some(consent) = consent
            .filter(|consent| consent.matches(&row.spec) && consent.revision_matches(&revision))
        else {
            self.finish_run(
                &row.id,
                OperationStatus::Interrupted,
                "Execution consent expired. Queue the task again.",
            )?;
            return Ok(());
        };
        let result = (|| {
            lease.revalidate_core()?;
            let (branch, version) = self.revision(&row.spec.workspace_id)?;
            if row.spec.kind == OperationKind::Agent {
                let squad_member = SquadsStore::new(self.core.clone()).get_member(&row.id)?;
                let is_squad_member = squad_member.is_some();
                let isolate = squad_member.as_ref().is_some_and(|member| member.worktree);
                let prepared = row.thread_id.as_deref() == Some(row.id.as_str());
                let (execution_branch, execution_version) = if isolate {
                    (
                        row.branch.clone().or_else(|| {
                            Some(crate::thread_commands::operation_branch_name(
                                Some(&row.spec.name),
                                &row.id,
                            ))
                        }),
                        row.version.clone().or(version.clone()),
                    )
                } else {
                    (branch.clone(), version.clone())
                };
                // Reserve the canonical thread identity durably before provider execution. The
                // thread runtime then inserts this exact id, so restart recovery never depends on
                // in-process state and never relaunches an uncertain task.
                self.store.reserve_agent_thread(
                    &row.id,
                    execution_branch.as_deref(),
                    execution_version.as_deref(),
                )?;
                let runtime = self.threads.runtime_handle().ok_or_else(unavailable)?;
                let started = if prepared {
                    let thread = runtime.get(&row.id)?;
                    if !operation_thread_matches(&thread, &row.spec, &row.id) {
                        return Err(KalError::internal(
                            "operation_thread_identity_mismatch",
                            "The prepared provider pane did not match its Squad member.",
                        ));
                    }
                    self.panes
                        .deliver(&self.threads, &row.id, row.spec.prompt.as_deref())
                } else {
                    self.panes.start(
                        &self.threads,
                        OperationPaneRequest {
                            core: &self.core,
                            git: &self.git,
                            operation_id: &row.id,
                            spec: &row.spec,
                            origin: consent.origin,
                            isolate,
                            start_revision: execution_version.as_deref(),
                        },
                    )
                };
                let thread = if prepared {
                    started?
                } else {
                    match started {
                        Ok(thread) => thread,
                        Err(start_error) => match runtime.get(&row.id) {
                            Err(error) if error.code == "thread_not_found" => {
                                return Err(start_error);
                            }
                            Ok(thread) if operation_thread_matches(&thread, &row.spec, &row.id) => {
                                let cleanup = if is_squad_member {
                                    self.reap_created_squad_thread(&row)
                                } else {
                                    runtime.stop(&row.id).map(|_| ())
                                };
                                if cleanup.is_ok() {
                                    return Err(start_error);
                                }
                                return Err(KalError::internal(
                                    "operation_cleanup_unproven",
                                    "Execution may have started and could not be stopped. Scheduling is paused; inspect the thread before continuing.",
                                ));
                            }
                            Ok(_) | Err(_) => {
                                return Err(KalError::internal(
                                    "operation_cleanup_unproven",
                                    "Execution identity could not be verified after launch failed. Scheduling is paused; inspect the thread before continuing.",
                                ));
                            }
                        },
                    }
                };
                if !operation_thread_matches(&thread, &row.spec, &row.id) {
                    return Err(KalError::internal(
                        "operation_cleanup_unproven",
                        "The provider thread did not match its reserved Operations identity. Scheduling is paused; inspect the run before continuing.",
                    ));
                }
                // The pane may already have its prompt, so always record the truth: bind it. A
                // user cancel that arrived meanwhile settles through the ordinary cancel path
                // (stop and capture evidence), and shutdown leaves delivered work to restart
                // recovery (interrupted, never archived).
                if let Err(error) = self.store.bind(
                    &row.id,
                    None,
                    Some(&row.id),
                    execution_branch.as_deref(),
                    execution_version.as_deref(),
                ) {
                    let cleanup = if is_squad_member && !prepared {
                        self.reap_created_squad_thread(&row)
                    } else {
                        runtime.stop(&row.id).map(|_| ())
                    };
                    if cleanup.is_ok() {
                        return Err(error);
                    }
                    return Err(KalError::internal(
                        "operation_cleanup_unproven",
                        "Execution started but could not be marked running or stopped. Scheduling is paused; inspect the thread before continuing.",
                    ));
                }
            } else {
                let command = row.spec.command.as_deref().ok_or_else(|| {
                    KalError::validation(
                        "operations_command_required",
                        "Enter a command for this task.",
                    )
                })?;
                let artifact_report = crate::operation_artifacts::prepare(&self.core, &row.id)?;
                let terminal = self.core.create_operation_terminal_with_artifact_report(
                    &row.spec.workspace_id,
                    &row.id,
                    command,
                    &artifact_report,
                    TerminalSize::new(120, 30).map_err(|_| unavailable())?,
                    self.terminal_limit(),
                )?;
                if let Err(error) = self.store.bind(
                    &row.id,
                    Some(&terminal.id),
                    None,
                    branch.as_deref(),
                    version.as_deref(),
                ) {
                    if self
                        .core
                        .stop_operation_terminal(&terminal.id, None)
                        .is_err()
                    {
                        let _ = self.store.bind(
                            &row.id,
                            Some(&terminal.id),
                            None,
                            branch.as_deref(),
                            version.as_deref(),
                        );
                        return Err(KalError::internal(
                            "operation_cleanup_unproven",
                            "Execution started but could not be linked or stopped. Scheduling is paused; inspect the terminal before continuing.",
                        ));
                    }
                    return Err(error);
                }
            }
            Ok(())
        })();
        if let Err(error) = result {
            if canceled.is_some_and(dispatch_canceled) && error.code != "operation_cleanup_unproven"
            {
                return Ok(());
            }
            self.handle_launch_error(&row, error)?;
        }
        *self.observations.lock().map_err(|_| poisoned())? = None;
        Ok(())
    }

    fn take_authorization(&self, id: &str) -> Result<Option<Authorization>> {
        Ok(self.authorized.lock().map_err(|_| poisoned())?.remove(id))
    }

    fn handle_launch_error(&self, row: &OperationRecord, error: KalError) -> Result<()> {
        if matches!(
            error.code,
            "operation_prepared_thread_busy"
                | "operation_prepared_thread_changed"
                | "operation_prepared_provider_not_ready"
        ) {
            return self
                .store
                .hold_starting_with_reason(&row.id, &safe(&error.message));
        }
        if error.code == "operation_cleanup_unproven" {
            self.hold_cleanup_unproven(&row.id, &error.message)?;
            return Err(error);
        }
        self.finish_run(
            &row.id,
            OperationStatus::Failed,
            safe(&error.message).as_str(),
        )
    }

    fn capture_output(&self, row: &OperationRecord) -> Result<()> {
        if let Some(id) = &row.terminal_id
            && let Some(output) = self.core.terminal_output(id)?
        {
            self.store.record_output(&row.id, &output)?;
        }
        Ok(())
    }

    fn capture_artifacts(&self, row: &OperationRecord) -> Option<&'static str> {
        if row.source != "operations" || row.terminal_id.as_deref() != Some(row.id.as_str()) {
            return None;
        }
        match self.artifact_checked.lock() {
            Ok(checked) if checked.contains(&row.id) => return None,
            Ok(_) => {}
            Err(_) => return Some("Artifact report evidence was unavailable."),
        }
        match crate::operation_artifacts::collect(&self.core, row) {
            Ok(_) => match self.artifact_checked.lock() {
                Ok(mut checked) => {
                    checked.insert(row.id.clone());
                    None
                }
                Err(_) => Some("Artifact report evidence was unavailable."),
            },
            Err(error) => {
                tracing::warn!(
                    event = "operations.artifact_capture_failed",
                    code = error.code
                );
                Some("Artifact report evidence was unavailable.")
            }
        }
    }

    fn with_output_evidence(&self, row: &OperationRecord, outcome: &str) -> String {
        match self.capture_output(row) {
            Ok(()) => outcome.to_owned(),
            Err(error) => {
                tracing::warn!(event = "operations.output_unavailable", code = error.code);
                format!("{outcome} Final log capture was unavailable.")
            }
        }
    }

    fn revision(&self, id: &str) -> Result<(Option<String>, Option<String>)> {
        let workspace = self
            .core
            .workspaces()?
            .into_iter()
            .find(|workspace| workspace.id == id)
            .ok_or_else(|| {
                KalError::validation("workspace_not_found", "The task workspace is unavailable.")
            })?;
        let root = kalcode_git::WorkspaceRoot::new(&workspace.id, Path::new(&workspace.root_path))?;
        Ok(self
            .git
            .status(&root)?
            .map(|status| (status.branch.branch, status.branch.head_oid))
            .unwrap_or_default())
    }

    fn events(&self) -> Result<(Vec<EventEnvelope>, bool)> {
        self.matching_events(EventQuery::default())
    }

    fn matching_events(&self, query: EventQuery) -> Result<(Vec<EventEnvelope>, bool)> {
        let mut events = Vec::new();
        let mut before_seq = query.before_seq;
        for _ in 0..10 {
            let page = self.core.query_events(&EventQuery {
                limit: 500,
                before_seq,
                ..query.clone()
            })?;
            events.extend(page.events);
            before_seq = page.next_cursor;
            if before_seq.is_none() {
                break;
            }
        }
        Ok((events, before_seq.is_some()))
    }

    fn rows(&self, events: &[EventEnvelope]) -> Result<(u64, bool, Vec<OperationRecord>)> {
        let (revision, paused, mut rows) = self.store.snapshot()?;
        let linked_terminals: HashSet<_> =
            rows.iter().filter_map(|r| r.terminal_id.clone()).collect();
        let authorized = self.authorized.lock().map_err(|_| poisoned())?.clone();
        let unauthorized = rows
            .iter()
            .filter(|row| {
                matches!(
                    row.status,
                    OperationStatus::Queued | OperationStatus::Blocked | OperationStatus::Paused
                ) && !authorized
                    .get(&row.id)
                    .is_some_and(|consent| consent.matches(&row.spec))
            })
            .map(|row| row.id.clone())
            .collect::<Vec<_>>();
        let squad_members = self.store.squad_member_ids(&unauthorized)?;
        for row in &mut rows {
            if matches!(
                row.status,
                OperationStatus::Queued | OperationStatus::Blocked | OperationStatus::Paused
            ) && !authorized
                .get(&row.id)
                .is_some_and(|consent| consent.matches(&row.spec))
            {
                row.blockers.push(if squad_members.contains(&row.id) {
                    "Resume to authorize this member after restart.".into()
                } else {
                    "Run now to authorize this task. Consent expires after 30 minutes or a workspace revision change.".into()
                });
            }
        }
        if let Some(runtime) = self.threads.runtime_handle() {
            let mut threads = runtime
                .list(None, true)?
                .into_iter()
                .map(|thread| (thread.id.clone(), thread))
                .collect::<HashMap<_, _>>();
            for row in rows
                .iter_mut()
                .filter(|row| row.source == "operations" && row.thread_id.is_some())
            {
                let id = row.thread_id.as_deref().unwrap_or_default();
                let thread = if let Some(thread) = threads.get(id) {
                    thread.clone()
                } else {
                    // A launching agent reserves its thread id before the thread exists, and a
                    // removed thread is reconciled by the scheduler; keep the stored row.
                    let thread = match runtime.get(id) {
                        Ok(thread) => thread,
                        Err(error) if error.code == "thread_not_found" => continue,
                        Err(error) => return Err(error),
                    };
                    threads.insert(id.to_owned(), thread.clone());
                    thread
                };
                project_active_operation_thread(row, &thread)?;
            }
            let (turns, _) = runtime.agent_turn_history(None, None, 100)?;
            for turn in turns.into_iter().filter(|turn| turn.operation_id.is_none()) {
                let thread = if let Some(thread) = threads.get(&turn.thread_id) {
                    thread.clone()
                } else {
                    let thread = runtime.get(&turn.thread_id)?;
                    threads.insert(turn.thread_id.clone(), thread.clone());
                    thread
                };
                rows.push(crate::operations_observed::agent_turn_run(&thread, &turn));
            }
            let (tools, _) = runtime.tool_call_history(None, None, None, 100)?;
            for tool in tools {
                let thread_id = tool.call.thread_id.clone();
                let thread = if let Some(thread) = threads.get(&thread_id) {
                    thread.clone()
                } else {
                    let thread = runtime.get(&thread_id)?;
                    threads.insert(thread_id, thread.clone());
                    thread
                };
                rows.push(crate::operations_observed::tool_run(&thread, tool.call));
            }
        }
        for workspace in self.core.workspaces()?.into_iter().take(100) {
            for terminal in self.core.terminals(&workspace.id)? {
                if linked_terminals.contains(&terminal.id) {
                    continue;
                }
                if let Some(shell) = self
                    .store
                    .shell_run_for_terminal(&terminal.id, &workspace.id)?
                {
                    rows.push(observed_live_shell(&shell, &terminal));
                } else {
                    rows.push(observed_terminal(terminal, &workspace.name));
                }
            }
        }
        rows.extend(crate::operations_observed::background_runs(events));
        Ok((revision, paused, rows))
    }

    fn history(&self, before: Option<&str>) -> Result<OperationHistoryPage> {
        let cursor = history_cursor(before)?;
        let fetch = u32::try_from(HISTORY_PAGE_SIZE + 1).unwrap_or(101);
        let (mut operations, more_operations) =
            history_source(self.store.history(cursor.operations.as_deref(), fetch))?;
        let runtime = self.threads.runtime_handle().ok_or_else(unavailable)?;
        let (turns, more_turns) =
            history_source(runtime.agent_turn_history(None, cursor.agent_turns.as_deref(), fetch))?;
        let (tools, more_tools) =
            history_source(runtime.tool_call_history(None, None, cursor.tools.as_deref(), fetch))?;
        let (shells, more_shells) = history_source(self.store.shell_history(
            None,
            cursor.shells.as_deref(),
            fetch,
        ))?;
        let (background, more_background) = history_source(self.store.background_history(
            None,
            cursor.background.as_deref(),
            fetch,
        ))?;

        let mut threads = runtime
            .list(None, true)?
            .into_iter()
            .map(|thread| (thread.id.clone(), thread))
            .collect::<HashMap<_, _>>();
        for operation in &mut operations {
            if let Some(id) = &operation.thread_id {
                match runtime.get(id) {
                    Ok(thread) => project_operation_name(operation, &thread)?,
                    Err(error) if error.code == "thread_not_found" => {}
                    Err(error) => return Err(error),
                }
            }
        }
        let mut turn_rows = Vec::with_capacity(turns.len());
        for turn in turns {
            let record = if turn.operation_id.is_some() {
                None
            } else {
                let thread = if let Some(thread) = threads.get(&turn.thread_id) {
                    thread.clone()
                } else {
                    let thread = runtime.get(&turn.thread_id)?;
                    threads.insert(turn.thread_id.clone(), thread.clone());
                    thread
                };
                Some(crate::operations_observed::agent_turn_run(&thread, &turn))
            };
            turn_rows.push(HistoryRow {
                authority: HistoryAuthority::AgentTurns,
                cursor: turn.message_id.clone(),
                created_at: turn.created_at.clone(),
                id: format!("turn:{}", turn.message_id),
                record,
            });
        }
        let mut tool_rows = Vec::with_capacity(tools.len());
        for tool in tools {
            let thread_id = tool.call.thread_id.clone();
            let thread = if let Some(thread) = threads.get(&thread_id) {
                thread.clone()
            } else {
                let thread = runtime.get(&thread_id)?;
                threads.insert(thread_id, thread.clone());
                thread
            };
            let created_at = tool.call.requested_at.clone();
            let cursor = tool.call.id.clone();
            let record = crate::operations_observed::tool_run(&thread, tool.call);
            tool_rows.push(HistoryRow {
                authority: HistoryAuthority::Tools,
                cursor,
                created_at,
                id: record.id.clone(),
                record: Some(record),
            });
        }

        merge_history(
            cursor,
            vec![
                HistoryBatch {
                    rows: operations
                        .into_iter()
                        .map(|record| HistoryRow {
                            authority: HistoryAuthority::Operations,
                            cursor: record.id.clone(),
                            created_at: record
                                .started_at
                                .clone()
                                .unwrap_or_else(|| record.created_at.clone()),
                            id: record.id.clone(),
                            record: Some(record),
                        })
                        .collect(),
                    has_more: more_operations.is_some(),
                },
                HistoryBatch {
                    rows: turn_rows,
                    has_more: more_turns.is_some(),
                },
                HistoryBatch {
                    rows: tool_rows,
                    has_more: more_tools.is_some(),
                },
                HistoryBatch {
                    rows: shells
                        .into_iter()
                        .map(|shell| {
                            let record = crate::operations_observed::shell_run(&shell);
                            HistoryRow {
                                authority: HistoryAuthority::Shells,
                                cursor: shell.start_event_id,
                                created_at: shell.started_at,
                                id: record.id.clone(),
                                record: Some(record),
                            }
                        })
                        .collect(),
                    has_more: more_shells.is_some(),
                },
                HistoryBatch {
                    rows: background
                        .into_iter()
                        .map(|background| {
                            let record = crate::operations_observed::background_run(&background);
                            HistoryRow {
                                authority: HistoryAuthority::Background,
                                cursor: background.start_event_id,
                                created_at: background.started_at,
                                id: record.id.clone(),
                                record: Some(record),
                            }
                        })
                        .collect(),
                    has_more: more_background.is_some(),
                },
            ],
        )
    }

    pub(crate) fn snapshot(&self) -> Result<OperationsSnapshot> {
        let (events, truncated) = self.events()?;
        let (revision, paused, items) = self.rows(&events)?;
        let (operation_moments, moments_truncated) =
            self.store.activity_moments(ACTIVITY_MOMENT_LIMIT)?;
        let mut warnings = vec!["Recent overview: up to 100 agent turns and 100 tool calls. Load older executions in Runs.".into()];
        if moments_truncated {
            warnings.push("Activity includes the latest 5,000 Operations lifecycle moments; older moments remain available through individual run details.".into());
        }
        let services_available;
        let services = {
            let mut cache = self.observations.lock().map_err(|_| poisoned())?;
            if let Some((at, services, available)) = &*cache
                && at.elapsed() < OBSERVATION_TTL
            {
                services_available = *available;
                services.clone()
            } else {
                match kalcode_utilities::services::discover_observation(&self.core, &items) {
                    Ok((services, available)) => {
                        services_available = available;
                        *cache = Some((Instant::now(), services.clone(), available));
                        services
                    }
                    Err(_) => {
                        services_available = false;
                        warnings.push("Service observation is unavailable. No cached service is reported as running.".into());
                        Vec::new()
                    }
                }
            }
        };
        if !services_available {
            warnings.push("Service discovery is incomplete. Known Operations processes are shown; undiscovered services may also be running.".into());
        }
        if truncated {
            warnings.push("Activity includes the latest 5,000 recorded events; older events remain in the event history.".into());
        }
        let observed_at = kalcode_core::time::now_rfc3339();
        let workspaces = self.core.workspaces()?;
        let names = std::env::vars_os()
            .filter_map(|(name, _)| name.into_string().ok())
            .collect::<Vec<_>>();
        let mut environments = kalcode_utilities::operation_evidence::environments(
            &items,
            &services,
            &workspaces,
            &names,
            &observed_at,
        );
        if !services_available {
            kalcode_utilities::operation_evidence::mark_local_port_observation_unavailable(
                &mut environments,
            );
        }
        let mut activity = kalcode_utilities::operation_evidence::activity_with_moments(
            &events,
            &items,
            &operation_moments,
        );
        // Git is sampled read-only at most once per thirty seconds, independent of UI polling.
        let mut commits = self.commits.lock().map_err(|_| poisoned())?;
        if commits
            .as_ref()
            .is_none_or(|(at, _)| at.elapsed() >= Duration::from_secs(30))
        {
            let mut observed_commits = Vec::new();
            for workspace in workspaces.iter().take(16) {
                let Ok(root) =
                    kalcode_git::WorkspaceRoot::new(&workspace.id, Path::new(&workspace.root_path))
                else {
                    continue;
                };
                if let Ok(commits) = self.git.log(&root, 50, None) {
                    for commit in commits.items {
                        if commit.parents.len() > 1
                            && commit.subject.contains(':')
                            && let Some(memory) = self.threads.memory()
                        {
                            memory.capture(
                                &workspace.id,
                                kalcode_contracts::unified_memory::MemorySourceKind::Merge,
                                &commit.oid,
                                &commit.subject,
                            );
                        }
                        observed_commits.push(OperationActivity {
                            id: format!("commit:{}:{}", workspace.id, commit.oid),
                            at: commit.committed_at,
                            kind: "commit".into(),
                            name: safe(&commit.subject),
                            area: "Repository".into(),
                            workspace_id: Some(workspace.id.clone()),
                            run_id: None,
                        });
                    }
                }
            }
            *commits = Some((Instant::now(), observed_commits));
        }
        if let Some((_, commits)) = &*commits {
            activity.extend(commits.iter().cloned());
        }
        activity.sort_by(|a, b| b.at.cmp(&a.at).then(a.id.cmp(&b.id)));
        let mut seen = HashSet::new();
        activity.retain(|item| seen.insert(item.id.clone()));
        activity.truncate(5000);
        Ok(OperationsSnapshot {
            revision,
            paused,
            items,
            services,
            environments,
            activity,
            observed_at,
            warnings,
        })
    }

    pub(crate) fn detail(&self, id: &str) -> Result<OperationDetail> {
        let mut after_seq = None;
        let mut before_seq = None;
        let mut stored_detail = None;
        let mut event_evidence_available = true;
        let run = if kalcode_contracts::ids::is_valid_id(id) {
            let detail = self.store.detail(id)?;
            let mut run = detail.run.clone();
            if run.source == "operations"
                && let Some(thread_id) = run.thread_id.as_deref()
                && let Some(runtime) = self.threads.runtime_handle()
            {
                match runtime.get(thread_id) {
                    Ok(thread) => project_active_operation_thread(&mut run, &thread)?,
                    Err(error) if error.code == "thread_not_found" => {}
                    Err(error) => return Err(error),
                }
            }
            if run.spec.kind == OperationKind::Agent {
                event_evidence_available = false;
                if let (Some(thread_id), Some(started_at)) = (&run.thread_id, &run.started_at) {
                    let start = self
                        .core
                        .query_events(&EventQuery {
                            types: vec!["agent.message".into()],
                            correlation: CorrelationFilter {
                                thread_id: Some(thread_id.clone()),
                                ..Default::default()
                            },
                            from: Some(started_at.clone()),
                            order: SeqOrder::Asc,
                            limit: 500,
                            ..Default::default()
                        })?
                        .events
                        .into_iter()
                        .find(|event| {
                            matches!(
                                &event.event,
                                EventPayload::AgentMessage {
                                    role: kalcode_contracts::threads::MessageRole::User,
                                    ..
                                }
                            )
                        });
                    if let Some(start) = start {
                        event_evidence_available = true;
                        after_seq = Some(start.seq.saturating_sub(1));
                        before_seq = self
                            .core
                            .query_events(&EventQuery {
                                types: vec!["agent.turn_completed".into()],
                                correlation: CorrelationFilter {
                                    thread_id: Some(thread_id.clone()),
                                    ..Default::default()
                                },
                                after_seq: Some(start.seq),
                                order: SeqOrder::Asc,
                                limit: 1,
                                ..Default::default()
                            })?
                            .events
                            .first()
                            .map(|event| event.seq.saturating_add(1));
                    }
                }
            }
            stored_detail = Some(detail);
            run
        } else if let Some(message_id) = id.strip_prefix("turn:") {
            let runtime = self.threads.runtime_handle().ok_or_else(unavailable)?;
            let turn = runtime
                .agent_turn(message_id, None)?
                .filter(|turn| turn.operation_id.is_none())
                .ok_or_else(operation_not_found)?;
            let thread = runtime.get(&turn.thread_id)?;
            if thread.workspace_id != turn.workspace_id {
                return Err(KalError::internal(
                    "operation_thread_workspace_mismatch",
                    "An observed agent turn did not match its workspace.",
                ));
            }
            after_seq = turn.started_event_seq.map(|seq| seq.saturating_sub(1));
            event_evidence_available = turn.started_event_seq.is_some();
            before_seq = turn
                .completed_event_seq
                .map(|seq| seq.saturating_add(1))
                .or(turn.next_started_event_seq);
            crate::operations_observed::agent_turn_run(&thread, &turn)
        } else if let Some(tool_id) = id.strip_prefix("tool:") {
            let runtime = self.threads.runtime_handle().ok_or_else(unavailable)?;
            let tool = runtime
                .tool_call(tool_id, None)?
                .ok_or_else(operation_not_found)?;
            let thread = runtime.get(&tool.call.thread_id)?;
            if thread.workspace_id != tool.workspace_id {
                return Err(KalError::internal(
                    "operation_thread_workspace_mismatch",
                    "An observed tool call did not match its workspace.",
                ));
            }
            crate::operations_observed::tool_run(&thread, tool.call)
        } else if let Some(start_event_id) = id.strip_prefix("shell:") {
            let shell = self
                .store
                .shell_run(start_event_id, None)?
                .ok_or_else(operation_not_found)?;
            after_seq = Some(shell.start_event_seq.saturating_sub(1));
            before_seq = shell.completed_event_seq.map(|seq| seq.saturating_add(1));
            crate::operations_observed::shell_run(&shell)
        } else if let Some(run_id) = id.strip_prefix("background:doctor:") {
            let background = self
                .store
                .background_run(run_id, None)?
                .ok_or_else(operation_not_found)?;
            after_seq = Some(background.start_event_seq.saturating_sub(1));
            before_seq = background
                .completed_event_seq
                .map(|seq| seq.saturating_add(1));
            crate::operations_observed::background_run(&background)
        } else if let Some(thread_id) = id.strip_prefix("thread:") {
            observed_thread(
                self.threads
                    .runtime_handle()
                    .ok_or_else(unavailable)?
                    .get(thread_id)?,
            )
        } else if let Some(terminal_id) = id.strip_prefix("terminal:") {
            let terminal = self.core.terminal(terminal_id)?;
            let workspace_name = self
                .core
                .workspaces()?
                .into_iter()
                .find(|workspace| workspace.id == terminal.workspace_id)
                .map(|workspace| workspace.name)
                .ok_or_else(operation_not_found)?;
            observed_terminal(terminal, &workspace_name)
        } else {
            return Err(operation_not_found());
        };
        let (mut events, mut truncated) = if event_evidence_available {
            self.matching_events(EventQuery {
                correlation: CorrelationFilter {
                    workspace_id: (!run.spec.workspace_id.is_empty())
                        .then(|| run.spec.workspace_id.clone()),
                    thread_id: run.thread_id.clone(),
                    ..Default::default()
                },
                after_seq,
                before_seq,
                from: (!run.created_at.is_empty()).then(|| run.created_at.clone()),
                to: run
                    .ended_at
                    .as_deref()
                    .map(event_time_upper_bound)
                    .transpose()?,
                ..Default::default()
            })?
        } else {
            (Vec::new(), false)
        };
        if let Some(ended) = &run.ended_at {
            events.retain(|event| event.occurred_at <= *ended);
        }
        if run.source == "operations" {
            // Artifact reports can be imported by restart recovery after the run's terminal end
            // boundary. Read only this exact task's typed report evidence outside that lifecycle
            // window; never admit later workspace-wide events.
            let (reported, reported_truncated) = self.matching_events(EventQuery {
                types: vec![
                    "operation.artifact_reported".into(),
                    "operation.artifact_report_rejected".into(),
                ],
                correlation: CorrelationFilter {
                    workspace_id: Some(run.spec.workspace_id.clone()),
                    task_id: Some(run.id.clone()),
                    ..CorrelationFilter::default()
                },
                order: SeqOrder::Asc,
                limit: 500,
                ..EventQuery::default()
            })?;
            let mut seen = events
                .iter()
                .map(|event| event.id.clone())
                .collect::<HashSet<_>>();
            events.extend(
                reported
                    .into_iter()
                    .filter(|event| seen.insert(event.id.clone())),
            );
            truncated |= reported_truncated;
        }
        if run.source == "tool" {
            let expected = id.strip_prefix("tool:");
            events.retain(|event| match &event.event {
                EventPayload::ToolRequested { tool_call_id, .. }
                | EventPayload::ToolStarted { tool_call_id, .. }
                | EventPayload::ToolCompleted { tool_call_id, .. }
                | EventPayload::ToolFailed { tool_call_id, .. } => {
                    expected == Some(tool_call_id.as_str())
                }
                _ => false,
            });
        } else if run.source == "terminal" && id.starts_with("shell:") {
            events.retain(|event| match &event.event {
                EventPayload::ShellStarted { terminal_id, .. }
                | EventPayload::ShellCompleted { terminal_id, .. }
                | EventPayload::ShellFailed { terminal_id, .. } => {
                    run.terminal_id.as_deref() == Some(terminal_id.as_str())
                }
                _ => false,
            });
        } else if run.source == "background" {
            let expected = id.strip_prefix("background:doctor:");
            events.retain(|event| match &event.event {
                EventPayload::DoctorRunStarted { run_id, .. }
                | EventPayload::DoctorRunCompleted { run_id, .. } => {
                    expected == Some(run_id.as_str())
                }
                _ => false,
            });
        }
        let mut detail = stored_detail.unwrap_or_else(|| OperationDetail {
            run: run.clone(),
            timeline: Vec::new(),
            logs: None,
            files: Vec::new(),
            artifacts: Vec::new(),
            tests: Vec::new(),
            notes: Vec::new(),
            related_services: Vec::new(),
            related_deployments: Vec::new(),
        });
        if !event_evidence_available {
            detail.notes.push(
                "This historical turn has no durable event boundary, so its timeline and logs are unavailable."
                    .into(),
            );
        }
        if events.iter().any(|event| {
            matches!(
                &event.event,
                EventPayload::OperationArtifactReportRejected { .. }
            )
        }) {
            detail.notes.push(
                "The command reported artifacts, but the bounded native report was rejected; no unverified paths are shown."
                    .into(),
            );
        }
        detail
            .timeline
            .extend(kalcode_utilities::operation_evidence::timeline(
                &events, &run,
            ));
        detail
            .timeline
            .sort_by(|a, b| a.at.cmp(&b.at).then(a.id.cmp(&b.id)));
        let (files, artifacts, tests) =
            kalcode_utilities::operation_evidence::detail_evidence(&events, &run);
        detail.files = files;
        detail.artifacts = artifacts;
        detail.tests = tests;
        if let Some(id) = &run.terminal_id
            && run.source != "tool"
        {
            if let Some(output) = self.core.terminal_output(id)? {
                detail.logs = Some(safe(&output));
            }
            detail.notes.push(if run.source == "operations" { "Command output is bounded and redacted. Completed Operations runs retain their final log tail." } else { "Terminal logs are bounded in-memory scrollback. Historical shell lifecycle events remain available, but their output is not retained after the terminal session closes or KalCode restarts." }.into());
        }
        if let Some(id) = &run.thread_id
            && run.source != "tool"
            && let Some(runtime) = self.threads.runtime_handle()
        {
            let message_ids = events
                .iter()
                .filter_map(|event| match &event.event {
                    EventPayload::AgentMessage { message_id, .. } => Some(message_id.clone()),
                    _ => None,
                })
                .collect::<HashSet<_>>();
            let (messages, messages_truncated) = messages_for_evidence(&runtime, id, &message_ids)?;
            detail.logs = (!messages.is_empty()).then_some(messages);
            detail.logs = detail.logs.map(bounded_log);
            detail.notes.push("Agent logs include only messages linked by durable events inside this turn boundary and are bounded to 512 KiB.".into());
            if messages_truncated {
                detail.notes.push(
                    "Some older agent messages were outside the bounded evidence read.".into(),
                );
            }
        }
        if truncated {
            detail
                .notes
                .push("Timeline is bounded to 5,000 matching workspace/thread events.".into());
        }
        let (related_services, related_deployments) = self.detail_relationships(&run)?;
        detail.related_services = related_services;
        detail.related_deployments = related_deployments;
        detail.run = run;
        Ok(detail)
    }

    fn detail_relationships(
        &self,
        run: &OperationRecord,
    ) -> Result<(
        Vec<kalcode_contracts::operations::OperationServiceRelationship>,
        Vec<kalcode_contracts::operations::OperationDeploymentRelationship>,
    )> {
        if !matches!(
            run.spec.kind,
            OperationKind::Service | OperationKind::Deploy | OperationKind::Release
        ) {
            return Ok((Vec::new(), Vec::new()));
        }

        let (_, _, current_runs) = self.store.snapshot()?;
        let (services, services_available) = {
            let mut cache = self.observations.lock().map_err(|_| poisoned())?;
            if let Some((at, services, available)) = &*cache
                && at.elapsed() < OBSERVATION_TTL
            {
                (services.clone(), *available)
            } else {
                match kalcode_utilities::services::discover_observation(&self.core, &current_runs) {
                    Ok((services, available)) => {
                        *cache = Some((Instant::now(), services.clone(), available));
                        (services, available)
                    }
                    Err(_) => (Vec::new(), false),
                }
            }
        };
        let observed_at = kalcode_core::time::now_rfc3339();
        let workspaces = self.core.workspaces()?;
        let names = std::env::vars_os()
            .filter_map(|(name, _)| name.into_string().ok())
            .collect::<Vec<_>>();
        let mut environments = kalcode_utilities::operation_evidence::environments(
            &current_runs,
            &services,
            &workspaces,
            &names,
            &observed_at,
        );
        if !services_available {
            kalcode_utilities::operation_evidence::mark_local_port_observation_unavailable(
                &mut environments,
            );
        }
        Ok(kalcode_utilities::operation_evidence::detail_relationships(
            run,
            &services,
            &environments,
        ))
    }

    fn authorize(
        &self,
        confirmer: &dyn NativeConfirmer,
        spec: &OperationSpec,
    ) -> Result<Authorization> {
        self.authorize_with_origin_at_revision(
            confirmer,
            spec,
            LaunchOrigin::Background,
            None,
            false,
        )
    }

    fn authorize_with_origin_at_revision(
        &self,
        confirmer: &dyn NativeConfirmer,
        spec: &OperationSpec,
        origin: LaunchOrigin,
        exact_revision: Option<(Option<String>, Option<String>)>,
        squad_member: bool,
    ) -> Result<Authorization> {
        let mut authorization = self.prepare_authorization(spec, origin, true, squad_member)?;
        let exact = exact_revision.is_some();
        if let Some(revision) = exact_revision {
            authorization.revision = revision;
        }
        if squad_member {
            // A Squad member can wait on its dependencies far longer than 30 minutes, while they
            // commit and move HEAD. Its consent lasts until it starts or is edited, like the
            // launch's. Only an isolated member re-run at its exact worktree base stays bound to
            // that revision.
            authorization.expires = None;
            if !exact {
                authorization.revision_bound = false;
                authorization.revision = (None, None);
            }
        }
        self.confirm_authorization(confirmer, &authorization)?;
        Ok(authorization)
    }

    fn confirm_authorization(
        &self,
        confirmer: &dyn NativeConfirmer,
        authorization: &Authorization,
    ) -> Result<()> {
        let spec = &authorization.spec;
        let workspace = self
            .core
            .workspaces()?
            .into_iter()
            .find(|w| w.id == spec.workspace_id)
            .ok_or_else(|| {
                KalError::validation("workspace_not_found", "Select an existing workspace.")
            })?;
        let content = spec
            .command
            .as_deref()
            .or(spec.prompt.as_deref())
            .unwrap_or("");
        let revision = &authorization.revision;
        let lifetime = match (authorization.expires, authorization.revision_bound) {
            (Some(_), _) => "Consent expires after 30 minutes or a workspace revision change.",
            (None, true) => {
                "Consent lasts until this Squad member starts or is edited; a workspace revision change revokes it."
            }
            (None, false) => "Consent lasts until this Squad member starts or is edited.",
        };
        let context = format!(
            "Environment: {:?}\nProvider: {}\nAccount: {}\nModel: {}\nEffort: {}\nBranch: {}\nRevision: {}\n{}\n\nCommand / prompt:\n{}",
            spec.environment,
            spec.provider_id.as_deref().unwrap_or("local shell"),
            spec.provider_account_id
                .as_deref()
                .unwrap_or("not applicable"),
            spec.model.as_deref().unwrap_or("not applicable"),
            spec.effort.as_deref().unwrap_or("provider default"),
            revision.0.as_deref().unwrap_or("not available"),
            revision.1.as_deref().unwrap_or("not available"),
            lifetime,
            content
        );
        confirm(
            confirmer,
            &NativeConfirmation::operations_task(
                &spec.name,
                &workspace.name,
                &context,
                spec.environment == OperationEnvironmentKind::Production,
            ),
        )
        .map_err(|_| KalError::validation("confirmation_declined", "Nothing was authorized."))?;
        Ok(())
    }

    /// An isolated prepared pane remains bound to the exact reviewed worktree base even when the
    /// root workspace advances while its dependencies run. Shared-workspace members intentionally
    /// revalidate the current root revision because their pane observes those new files.
    fn authorization_revision(
        &self,
        row: &OperationRecord,
    ) -> Result<(Option<String>, Option<String>)> {
        if row.thread_id.as_deref() == Some(row.id.as_str())
            && SquadsStore::new(self.core.clone())
                .get_member(&row.id)?
                .is_some_and(|member| member.worktree)
        {
            return Ok((row.branch.clone(), row.version.clone()));
        }
        self.revision(&row.spec.workspace_id)
    }

    /// Canonicalizes one exact spec for consent. Only a Squad member may be a taskless coding
    /// terminal; an ordinary agent task still requires its prompt.
    fn prepare_authorization(
        &self,
        spec: &OperationSpec,
        origin: LaunchOrigin,
        revision_bound: bool,
        squad_member: bool,
    ) -> Result<Authorization> {
        let normalize = if squad_member {
            kalcode_core::operations::normalize_squad_member_spec
        } else {
            kalcode_core::operations::normalize_spec
        };
        let mut spec = normalize(spec.clone())?;
        if spec.kind == OperationKind::Agent {
            spec = self.panes.canonicalize(&self.threads, &self.core, &spec)?;
        }
        let spec = normalize(spec)?;
        self.core
            .workspaces()?
            .into_iter()
            .find(|w| w.id == spec.workspace_id)
            .ok_or_else(|| {
                KalError::validation("workspace_not_found", "Select an existing workspace.")
            })?;
        let content = spec
            .command
            .as_deref()
            .or(spec.prompt.as_deref())
            .unwrap_or("");
        validate_authorization_content(content, squad_member)?;
        let revision = if revision_bound {
            self.revision(&spec.workspace_id)?
        } else {
            (None, None)
        };
        Ok(Authorization {
            spec,
            revision,
            expires: revision_bound.then(|| Instant::now() + Duration::from_secs(30 * 60)),
            origin,
            revision_bound,
        })
    }

    fn cancel(&self, id: &str) -> Result<()> {
        let row = self.store.detail(id)?.run;
        if matches!(
            row.status,
            OperationStatus::Running | OperationStatus::Starting
        ) {
            if let Some(terminal) = &row.terminal_id {
                self.core.stop_operation_terminal(terminal, None)?;
            }
            if let Some(thread) = &row.thread_id {
                let runtime = self.threads.runtime_handle().ok_or_else(unavailable)?;
                match runtime.stop(thread) {
                    Ok(_) => {}
                    Err(error)
                        if matches!(error.code, "thread_not_running" | "thread_not_found") => {}
                    Err(error) => return Err(error),
                }
            }
            let artifact_note = self.capture_artifacts(&row);
            let mut outcome = self.with_output_evidence(&row, "Cancelled by you.");
            if let Some(note) = artifact_note {
                outcome.push(' ');
                outcome.push_str(note);
            }
            self.store
                .finish(id, OperationStatus::Cancelled, outcome.as_str())?;
        } else {
            if let Some(thread) = &row.thread_id {
                let runtime = self.threads.runtime_handle().ok_or_else(unavailable)?;
                match runtime.stop(thread) {
                    Ok(_) => {}
                    Err(error)
                        if matches!(error.code, "thread_not_running" | "thread_not_found") => {}
                    Err(error) => return Err(error),
                }
            }
            self.store.cancel_pending(id)?;
        }
        self.authorized.lock().map_err(|_| poisoned())?.remove(id);
        *self.observations.lock().map_err(|_| poisoned())? = None;
        Ok(())
    }
}

fn unavailable() -> KalError {
    KalError::internal(
        "operations_unavailable",
        "Operations is not available in this runtime.",
    )
}
fn dispatch_in_progress() -> KalError {
    KalError::validation(
        "operation_dispatch_in_progress",
        "This Squad member is already starting. Wait for its pane to be ready, then try again.",
    )
}
/// Run now only re-sends a Squad member that never started. A started, interrupted or finished
/// member may already have its task, so it must never be re-prepared or sent again.
fn ensure_squad_member_pending(row: &OperationRecord) -> Result<()> {
    if matches!(
        row.status,
        OperationStatus::Queued | OperationStatus::Blocked | OperationStatus::Paused
    ) {
        return Ok(());
    }
    Err(KalError::validation(
        "operation_not_pending",
        "This Squad member already started, so KalCode will not send its task again. Open its pane, or launch a replacement.",
    ))
}
fn dispatch_canceled(state: &AtomicU8) -> bool {
    state.load(Ordering::Acquire) != 0
}
fn dispatch_user_canceled(state: &AtomicU8) -> bool {
    state.load(Ordering::Acquire) == 2
}
fn operation_not_found() -> KalError {
    KalError::validation("operation_not_found", "This run is no longer available.")
}
fn poisoned() -> KalError {
    KalError::internal(
        "operations_lock_failed",
        "Operations stopped because its state could not be verified. Restart KalCode.",
    )
}
fn safe(text: &str) -> String {
    kalcode_core::redact::redact_log_line(text).into_owned()
}

/// Ordinary tasks keep main's 8 KiB cap on reviewed command/prompt content. A Squad member's task
/// is exempt: its definition bounds it at 64 KiB when the Squad is saved.
fn validate_authorization_content(content: &str, squad_member: bool) -> Result<()> {
    if (squad_member || content.len() <= 8192) && safe(content) == content {
        Ok(())
    } else {
        Err(KalError::validation(
            "operations_sensitive_input",
            "Use environment variable references instead of secret values.",
        ))
    }
}

fn full_safe(text: &str) -> String {
    kalcode_core::redact::redact_text(
        text,
        kalcode_core::redact::secrets::ScanContext::default(),
        kalcode_core::redact::PlaceholderStyle::Labelled,
    )
    .text
}

fn messages_for_evidence(
    runtime: &kalcode_threads::ThreadRuntime,
    thread_id: &str,
    message_ids: &HashSet<String>,
) -> Result<(String, bool)> {
    if message_ids.is_empty() {
        return Ok((String::new(), false));
    }
    let mut found = Vec::new();
    let mut before = None;
    let mut exhausted = false;
    for _ in 0..10 {
        let page = runtime.messages(thread_id, 500, before.as_deref())?;
        if page.is_empty() {
            exhausted = true;
            break;
        }
        before = page.first().map(|message| message.id.clone());
        let page_len = page.len();
        found.extend(
            page.into_iter()
                .filter(|message| message_ids.contains(&message.id)),
        );
        if found.len() == message_ids.len() {
            exhausted = true;
            break;
        }
        if page_len < 500 {
            exhausted = true;
            break;
        }
    }
    found.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then(left.id.cmp(&right.id))
    });
    let missing = found.len() < message_ids.len();
    Ok((
        found
            .into_iter()
            .map(|message| full_safe(&message.content))
            .collect::<Vec<_>>()
            .join("\n\n"),
        !exhausted || missing,
    ))
}

fn bounded_log(text: String) -> String {
    const LIMIT: usize = 512 * 1024;
    if text.len() <= LIMIT {
        return text;
    }
    let mut start = text.len() - LIMIT;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].to_owned()
}

fn terminal_outcome(terminal: &TerminalInfo) -> Option<(OperationStatus, String)> {
    match (terminal.status, terminal.exit_code) {
        (TerminalStatus::Running, _) | (TerminalStatus::Exited, None) => None,
        (TerminalStatus::EndedByApp, _) => Some((
            OperationStatus::Interrupted,
            "KalCode ended before completion was observed.".into(),
        )),
        (TerminalStatus::Exited, Some(0)) => Some((
            OperationStatus::Succeeded,
            "Command exited successfully (code 0).".into(),
        )),
        (TerminalStatus::Exited, Some(code)) => Some((
            OperationStatus::Failed,
            format!("Command exited with code {code}."),
        )),
    }
}

fn operation_thread_matches(
    thread: &ThreadSummary,
    spec: &OperationSpec,
    operation_id: &str,
) -> bool {
    thread.id == operation_id
        && thread.workspace_id == spec.workspace_id
        && spec.provider_id.as_deref() == Some(thread.provider_id.as_str())
        && spec.provider_account_id.as_deref() == thread.provider_account_id.as_deref()
        && (spec.model.as_deref() == thread.model.as_deref()
            || (thread.provider_id.as_str() == kalcode_contracts::agent::ProviderId::CURSOR
                && spec.model.is_none()))
        && spec.effort.as_deref() == thread.effort.as_deref()
        && thread.permission_mode.is_confirm_free_start()
}

fn project_active_operation_thread(
    row: &mut OperationRecord,
    thread: &ThreadSummary,
) -> Result<()> {
    project_operation_name(row, thread)?;
    if row.source != "operations"
        || !matches!(
            row.status,
            OperationStatus::Starting | OperationStatus::Running
        )
    {
        return Ok(());
    }
    if row.thread_id.as_deref() != Some(thread.id.as_str()) {
        return Err(KalError::internal(
            "operation_thread_identity_mismatch",
            "An Operations thread did not match its task.",
        ));
    }
    if row.spec.workspace_id != thread.workspace_id {
        return Err(KalError::internal(
            "operation_thread_workspace_mismatch",
            "An Operations thread did not match its workspace.",
        ));
    }
    row.spec.provider_id = Some(thread.provider_id.to_string());
    row.spec.provider_account_id = thread.provider_account_id.clone();
    row.spec.model = thread.model.clone();
    row.account_label = thread.account_label.clone();
    if row.branch.is_none() {
        row.branch = thread.branch.clone();
    }
    row.status = thread_status(thread.status);
    row.current_action = thread
        .current_activity
        .as_deref()
        .map(safe)
        .or(row.current_action.take());
    Ok(())
}

/// Display projection only: never rewrite the queued/executed specification or its consent.
fn project_operation_name(row: &mut OperationRecord, thread: &ThreadSummary) -> Result<()> {
    if row.source != "operations" || row.spec.kind != OperationKind::Agent {
        return Ok(());
    }
    if row.thread_id.as_deref() != Some(thread.id.as_str()) {
        return Err(KalError::internal(
            "operation_thread_identity_mismatch",
            "An Operations thread did not match its task.",
        ));
    }
    row.spec.name = safe(&thread.name);
    Ok(())
}

fn thread_status(status: ThreadStatus) -> OperationStatus {
    match status {
        ThreadStatus::Completed => OperationStatus::Succeeded,
        ThreadStatus::Failed => OperationStatus::Failed,
        ThreadStatus::Interrupted | ThreadStatus::Offline => OperationStatus::Interrupted,
        ThreadStatus::Paused | ThreadStatus::Idle => OperationStatus::Paused,
        ThreadStatus::WaitingForPermission
        | ThreadStatus::WaitingForUser
        | ThreadStatus::WaitingForDependency => OperationStatus::Blocked,
        ThreadStatus::Starting | ThreadStatus::Recovering => OperationStatus::Starting,
        _ => OperationStatus::Running,
    }
}

fn observed_spec(name: String, workspace_id: String, kind: OperationKind) -> OperationSpec {
    OperationSpec {
        name,
        workspace_id,
        kind,
        command: None,
        prompt: None,
        provider_id: None,
        provider_account_id: None,
        model: None,
        effort: None,
        dependencies: Vec::new(),
        priority: 0,
        lane: OperationLane::Next,
        environment: OperationEnvironmentKind::Local,
        urls: Vec::new(),
        env_keys: Vec::new(),
    }
}

fn observed_thread(thread: ThreadSummary) -> OperationRecord {
    let mut spec = observed_spec(
        safe(&thread.name),
        thread.workspace_id,
        OperationKind::Agent,
    );
    spec.provider_id = Some(thread.provider_id.to_string());
    spec.provider_account_id = thread.provider_account_id;
    spec.model = thread.model;
    let status = thread_status(thread.status);
    let ended = matches!(
        status,
        OperationStatus::Succeeded | OperationStatus::Failed | OperationStatus::Interrupted
    );
    OperationRecord {
        id: format!("thread:{}", thread.id),
        spec,
        source: "thread".into(),
        status,
        workspace_name: thread.workspace_name,
        branch: thread.branch,
        version: None,
        account_label: thread.account_label,
        terminal_id: thread.terminal_id,
        thread_id: Some(thread.id),
        created_at: thread.created_at.clone(),
        started_at: Some(thread.created_at),
        ended_at: ended.then_some(thread.last_activity_at),
        current_action: thread.current_activity.map(|s| safe(&s)),
        attention_reason: None,
        outcome: thread
            .error
            .map(|_| "Provider reported a failure. Open the thread for details.".into()),
        position: 0,
        blockers: Vec::new(),
    }
}

fn observed_terminal(terminal: TerminalInfo, workspace_name: &str) -> OperationRecord {
    let (status, outcome) = terminal_outcome(&terminal)
        .map(|(status, outcome)| (status, Some(outcome)))
        .unwrap_or((OperationStatus::Running, None));
    OperationRecord {
        id: format!("terminal:{}", terminal.id),
        spec: observed_spec(
            safe(&terminal.title),
            terminal.workspace_id,
            OperationKind::Script,
        ),
        source: "terminal".into(),
        status,
        workspace_name: workspace_name.into(),
        branch: None,
        version: None,
        account_label: None,
        terminal_id: Some(terminal.id),
        thread_id: None,
        created_at: terminal.started_at.clone().unwrap_or_default(),
        started_at: terminal.started_at,
        ended_at: terminal.ended_at,
        current_action: Some(
            "Terminal session; individual shell commands are not instrumented.".into(),
        ),
        attention_reason: None,
        outcome,
        position: 0,
        blockers: Vec::new(),
    }
}

fn observed_live_shell(
    shell: &kalcode_core::operations::ShellRunRecord,
    terminal: &TerminalInfo,
) -> OperationRecord {
    let mut record = crate::operations_observed::shell_run(shell);
    if shell.completed_event_seq.is_none() {
        if let Some((status, outcome)) = terminal_outcome(terminal) {
            record.status = status;
            record.ended_at = terminal.ended_at.clone();
            record.outcome = Some(outcome);
        } else {
            record.status = OperationStatus::Running;
            record.current_action = Some("Terminal session is running.".into());
            record.outcome = None;
        }
    }
    record
}

async fn blocking<T: Send + 'static>(
    state: RuntimeState<OperationsState>,
    work: impl FnOnce(&RuntimeState<OperationsState>) -> Result<T> + Send + 'static,
) -> std::result::Result<T, IpcError> {
    tauri::async_runtime::spawn_blocking(move || {
        state.revalidate_core()?;
        work(&state)
    })
    .await
    .map_err(|_| unavailable().to_ipc())?
    .map_err(|e| e.log_and_convert("operations"))
}

#[tauri::command]
pub async fn operations_snapshot(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<OperationsState>,
) -> std::result::Result<OperationsSnapshot, IpcError> {
    blocking(state, |s| s.snapshot()).await
}
#[tauri::command]
pub async fn operations_detail(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<OperationsState>,
    id: String,
) -> std::result::Result<OperationDetail, IpcError> {
    blocking(state, move |s| s.detail(&id)).await
}
#[tauri::command]
pub async fn operations_history(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<OperationsState>,
    before: Option<String>,
) -> std::result::Result<OperationHistoryPage, IpcError> {
    blocking(state, move |s| s.history(before.as_deref())).await
}
#[tauri::command]
pub async fn operations_enqueue(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<OperationsState>,
    app: AppHandle,
    spec: OperationSpec,
) -> std::result::Result<OperationRecord, IpcError> {
    blocking(state, move |s| {
        let _gate = s.gate.lock().map_err(|_| poisoned())?;
        // Refuse a task past the plan's queue cap before asking the owner to approve it.
        let limit = s.plan_limit(Limited::QueuedTasks);
        s.store.check_queue_capacity(limit)?;
        let consent = s.authorize(&TauriConfirmer::new(app.clone()), &spec)?;
        s.revalidate_core()?;
        let row = s.store.enqueue_limited(consent.spec.clone(), limit)?;
        s.authorized
            .lock()
            .map_err(|_| poisoned())?
            .insert(row.id.clone(), consent);
        Ok(row)
    })
    .await
}
#[tauri::command]
pub async fn operations_update(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<OperationsState>,
    app: AppHandle,
    id: String,
    spec: OperationSpec,
    revision: u64,
) -> std::result::Result<OperationRecord, IpcError> {
    blocking(state, move |s| {
        s.update_command(&TauriConfirmer::new(app), s, &id, spec, revision)
    })
    .await
}
#[tauri::command]
pub async fn operations_reorder(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<OperationsState>,
    ids: Vec<String>,
    revision: u64,
) -> std::result::Result<(), IpcError> {
    blocking(state, move |s| {
        let _gate = s.gate.lock().map_err(|_| poisoned())?;
        s.store.reorder(&ids, revision)
    })
    .await
}
#[tauri::command]
pub async fn operations_pause(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<OperationsState>,
    paused: bool,
) -> std::result::Result<(), IpcError> {
    blocking(state, move |s| {
        let _gate = s.gate.lock().map_err(|_| poisoned())?;
        s.store.set_paused(paused)
    })
    .await
}
#[tauri::command]
pub async fn operations_hold(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<OperationsState>,
    id: String,
    paused: bool,
) -> std::result::Result<(), IpcError> {
    blocking(state, move |s| s.hold_command(&id, paused)).await
}
#[tauri::command]
pub async fn operations_cancel(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<OperationsState>,
    id: String,
) -> std::result::Result<(), IpcError> {
    blocking(state, move |s| s.cancel_command(&id)).await
}
#[tauri::command]
pub async fn operations_run_now(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<OperationsState>,
    app: AppHandle,
    id: String,
) -> std::result::Result<(), IpcError> {
    blocking(state, move |s| {
        s.run_now_command(&TauriConfirmer::new(app), s, &id)
    })
    .await
}

/// IPC command bodies, kept free of Tauri types so the dispatcher's interaction with edits,
/// holds, cancellation and Run now is exercised directly by tests.
impl OperationsState {
    fn update_command(
        &self,
        confirmer: &dyn NativeConfirmer,
        lease: &dyn OperationsLease,
        id: &str,
        spec: OperationSpec,
        revision: u64,
    ) -> Result<OperationRecord> {
        let _gate = self.gate.lock().map_err(|_| poisoned())?;
        self.ensure_dispatch_not_cancelling(id)?;
        let consent = if SquadsStore::new(self.core.clone())
            .get_member(id)?
            .is_some()
        {
            // A Squad member keeps the User-origin, non-expiring consent its launch granted, now
            // for exactly the edited spec, so it stays on the lock-free dispatcher path.
            let consent = self.prepare_authorization(&spec, LaunchOrigin::User, false, true)?;
            // A member whose pane is being created outside the gate keeps the identity that pane
            // is being built with; task text may still change.
            if self.squad_dispatch.is_reserved(id)
                && !same_execution_identity(&consent.spec, &self.store.get(id)?.spec)
            {
                return Err(KalError::validation(
                    "operation_dispatch_identity_locked",
                    "This Squad member is starting. Wait for its pane to be ready before changing its workspace, provider, account, model or effort.",
                ));
            }
            self.confirm_authorization(confirmer, &consent)?;
            consent
        } else {
            self.authorize(confirmer, &spec)?
        };
        lease.revalidate_core()?;
        let row = self.store.update(id, consent.spec.clone(), revision)?;
        self.authorized
            .lock()
            .map_err(|_| poisoned())?
            .insert(row.id.clone(), consent);
        Ok(row)
    }

    fn hold_command(&self, id: &str, paused: bool) -> Result<()> {
        let _gate = self.gate.lock().map_err(|_| poisoned())?;
        let squad_member = SquadsStore::new(self.core.clone())
            .get_member(id)?
            .is_some();
        if paused {
            self.store.hold(id, true)?;
            // A hold supersedes a dispatch that has not taken effect yet. It never stops a pane
            // that already exists, including one prepared while the hold arrived: a held
            // prepared member keeps its waiting pane.
            self.squad_dispatch.cancel(id, false);
            if squad_member {
                // A member you paused must not start again on its launch consent (which would
                // also bypass the global pause). Starting it again needs a new Run now.
                self.authorized.lock().map_err(|_| poisoned())?.remove(id);
            }
            Ok(())
        } else {
            self.ensure_dispatch_not_cancelling(id)?;
            if squad_member {
                let row = self.store.get(id)?;
                let consented = self
                    .authorized
                    .lock()
                    .map_err(|_| poisoned())?
                    .get(id)
                    .is_some_and(|consent| consent.matches(&row.spec));
                if row.status == OperationStatus::Paused && !consented {
                    // Resuming would leave it queued with nothing able to start it.
                    return Err(KalError::validation(
                        "operation_squad_run_required",
                        "Run this Squad member to start it. Paused members need your confirmation again.",
                    ));
                }
            }
            self.store.hold(id, false)
        }
    }

    fn cancel_command(&self, id: &str) -> Result<()> {
        let _gate = self.gate.lock().map_err(|_| poisoned())?;
        let current = self.store.detail(id)?.run;
        if current.status == OperationStatus::Cancelled {
            return Ok(());
        }
        if self.squad_dispatch.is_reserved(id) {
            // Publish a truthful durable cancelling state before signaling the out-of-gate
            // worker. Provider termination and worktree cleanup never hold the global gate.
            self.store.request_dispatch_cancel(id)?;
            self.authorized.lock().map_err(|_| poisoned())?.remove(id);
            if self.squad_dispatch.cancel(id, true) {
                return Ok(());
            }
            // The job was still queued and is now removed atomically, so no worker can race.
            // Take the full cancel path: a prepared member's real pane stops with its row.
        }
        self.cancel(id)
    }

    fn run_now_command(
        &self,
        confirmer: &dyn NativeConfirmer,
        lease: &dyn OperationsLease,
        id: &str,
    ) -> Result<()> {
        let squad_member = {
            let _gate = self.gate.lock().map_err(|_| poisoned())?;
            SquadsStore::new(self.core.clone()).get_member(id)?
        };
        let Some(member) = squad_member else {
            // Ordinary tasks keep main's Run now exactly: Background consent, and one gate epoch
            // from the native confirmation through claim and launch.
            let _gate = self.gate.lock().map_err(|_| poisoned())?;
            let row = self.store.detail(id)?.run;
            let consent = self.authorize(confirmer, &row.spec)?;
            lease.revalidate_core()?;
            if consent.spec != row.spec {
                let (revision, _, _) = self.store.snapshot()?;
                self.store.update(id, consent.spec.clone(), revision)?;
            }
            self.authorized
                .lock()
                .map_err(|_| poisoned())?
                .insert(id.to_owned(), consent);
            let claimed = self.store.claim(Some(id))?.ok_or_else(|| {
                KalError::validation(
                    "operation_blocked",
                    "Resume the queue and resolve this task's blockers before running it.",
                )
            })?;
            return self.launch(claimed, lease);
        };

        // A Squad member's Run now is User work its scoped dispatcher may start while the queue
        // is paused. The confirmation runs outside the gate so it never stalls the dispatcher.
        let row = {
            let _gate = self.gate.lock().map_err(|_| poisoned())?;
            self.ensure_dispatch_idle(id)?;
            let row = self.store.detail(id)?.run;
            ensure_squad_member_pending(&row)?;
            row
        };
        let exact_revision = (member.worktree && row.thread_id.as_deref() == Some(row.id.as_str()))
            .then(|| (row.branch.clone(), row.version.clone()));
        // Declining keeps any existing actionable hold reason untouched.
        let consent = self.authorize_with_origin_at_revision(
            confirmer,
            &row.spec,
            LaunchOrigin::User,
            exact_revision,
            true,
        )?;
        lease.revalidate_core()?;
        let _gate = self.gate.lock().map_err(|_| poisoned())?;
        // The native confirmation ran outside the gate; a dispatch may have started since.
        self.ensure_dispatch_idle(id)?;
        let current = self.store.detail(id)?.run;
        ensure_squad_member_pending(&current)?;
        if current.spec != row.spec {
            return Err(KalError::validation(
                "operation_authorization_changed",
                "This task changed while it was being authorized. Run it again.",
            ));
        }
        if consent.spec != current.spec {
            if current.thread_id.as_deref() == Some(current.id.as_str())
                && !same_execution_identity(&consent.spec, &current.spec)
            {
                // The member's real pane already exists with its reviewed identity; a changed
                // provider default cannot be applied to it.
                return Err(KalError::validation(
                    "operation_prepared_identity_drift",
                    "This Squad member's provider settings changed since its pane started (for example a new default model or account). Cancel it and launch a replacement.",
                ));
            }
            let (revision, _, _) = self.store.snapshot()?;
            self.store.update(id, consent.spec.clone(), revision)?;
        }
        if let Err(error) = self.panes.rearm(&self.threads, id) {
            // Run now is the explicit action that may reclaim a prepared pane the person typed
            // into. Without it the member's task could never be sent again.
            self.store.hold_with_reason(id, &safe(&error.message))?;
            return Err(error);
        }
        if current.attention_reason.is_some() {
            self.store.clear_attention_hold(id)?;
        } else if current.status == OperationStatus::Paused {
            self.store.hold(id, false)?;
        }
        self.authorized
            .lock()
            .map_err(|_| poisoned())?
            .insert(id.to_owned(), consent);
        // Squad retries always execute on the bounded dispatcher, outside the gate.
        if !self.squad_dispatch.enqueue(id, SquadDispatchKind::Run)? {
            return Err(dispatch_in_progress());
        }
        self.stop.1.notify_all();
        Ok(())
    }
}
#[tauri::command]
pub async fn operations_service_action(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<OperationsState>,
    app: AppHandle,
    id: String,
    action: String,
) -> std::result::Result<(), IpcError> {
    blocking(state, move |s| { let _gate = s.gate.lock().map_err(|_| poisoned())?;
        if action != "stop" && action != "restart" { return Err(KalError::validation("operation_invalid_action", "Choose Stop or Restart.")); }
        let (_, paused, rows) = s.rows(&s.events()?.0)?;
        let service = kalcode_utilities::services::discover(&s.core, &rows)?.into_iter().find(|v| v.id == id)
            .ok_or_else(|| KalError::validation("service_not_found", "Refresh Services; this process changed."))?;
        if (action == "stop" && !service.can_stop) || (action == "restart" && !service.can_restart) {
            return Err(KalError::validation("service_action_unavailable", "This service cannot be controlled safely. Refresh Services or open its terminal."));
        }
        let run_id = service.run_id.filter(|id| rows.iter().any(|r| &r.id == id && r.source == "operations"))
            .ok_or_else(|| KalError::validation("service_not_owned", "This service was discovered outside Operations. Use its terminal to control it."))?;
        let old = s.store.detail(&run_id)?.run;
        if old.terminal_id.as_deref() != Some(old.id.as_str()) {
            return Err(KalError::validation("service_not_owned", "This service has no verified Operations terminal."));
        }
        if action == "restart" {
            if paused { return Err(KalError::validation("operations_paused", "Resume Operations before restarting a service.")); }
            if rows.iter().any(|row| row.id != old.id && row.source == "operations"
                && row.spec.workspace_id == old.spec.workspace_id && row.spec.command == old.spec.command
                && matches!(row.status, OperationStatus::Queued | OperationStatus::Paused | OperationStatus::Blocked | OperationStatus::Starting | OperationStatus::Running)) {
                return Err(KalError::validation("service_restart_pending", "This service already has pending or active work. Refresh Services."));
            }
        }
        if action == "restart" {
            let consent = s.authorize(&TauriConfirmer::new(app.clone()), &old.spec)?; s.revalidate_core()?;
            // Reserve the successor before stopping a healthy service. Queue admission failure
            // must not turn a requested restart into an avoidable outage.
            let row = s.store.enqueue(consent.spec.clone())?;
            if matches!(old.status, OperationStatus::Running | OperationStatus::Starting)
                && let Err(error) = s.cancel(&run_id) {
                s.store.cancel_pending(&row.id)?;
                return Err(error);
            }
            s.authorized.lock().map_err(|_| poisoned())?.insert(row.id.clone(), consent);
            if let Some(row) = s.store.claim(Some(&row.id))? { s.launch(row, s)?; }
        } else if matches!(old.status, OperationStatus::Running | OperationStatus::Starting) {
            s.cancel(&run_id)?;
        }
        Ok(()) }).await
}

fn checked_url(raw: &str) -> Result<url::Url> {
    let url = url::Url::parse(raw)
        .map_err(|_| KalError::validation("operations_url_invalid", "This address is invalid."))?;
    if raw.len() > 2048
        || !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || safe(raw) != raw
    {
        return Err(KalError::validation(
            "operations_url_invalid",
            "Only HTTP(S) addresses without credentials can be opened.",
        ));
    }
    Ok(url)
}
#[tauri::command]
pub async fn operations_open_url(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<OperationsState>,
    url: String,
) -> std::result::Result<(), IpcError> {
    blocking(state, move |s| {
        let url = checked_url(&url)?;
        let snapshot = s.snapshot()?;
        let known = snapshot
            .services
            .iter()
            .flat_map(|v| v.urls.iter())
            .chain(snapshot.environments.iter().flat_map(|v| v.urls.iter()))
            .any(|v| checked_url(v).is_ok_and(|known| known == url));
        if !known {
            return Err(KalError::validation(
                "operations_url_stale",
                "Refresh Operations before opening this address.",
            ));
        }
        s.revalidate_core()?;
        tauri_plugin_opener::open_url(url.as_str(), None::<&str>).map_err(|_| {
            KalError::internal(
                "operations_browser_failed",
                "The browser could not be opened.",
            )
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used)]
    use super::*;
    use kalcode_contracts::permissions::PermissionMode;
    use kalcode_contracts::squads::{SquadDefinition, SquadMemberDefinition};
    use kalcode_core::{CoreConfig, Paths, flags::BuildChannel};

    #[test]
    fn squad_dispatch_cancel_retains_exact_reservation_until_worker_cleanup() {
        let queue = SquadDispatchQueue::default();
        assert!(
            queue
                .enqueue("member-1", SquadDispatchKind::Authorize)
                .expect("enqueue")
        );
        let (job, canceled) = queue.take().expect("worker claim");
        assert_eq!(job.operation_id, "member-1");
        assert!(queue.cancel("member-1", true));
        assert!(dispatch_user_canceled(&canceled));
        assert!(
            !queue
                .enqueue("member-1", SquadDispatchKind::Run)
                .expect("retry is bounded"),
            "an active canceled worker retains the exact-ID reservation"
        );

        queue.finish("member-1", &canceled);
        assert!(
            queue
                .enqueue("member-1", SquadDispatchKind::Run)
                .expect("retry after cleanup")
        );
        assert!(
            !queue.cancel("member-1", true),
            "queued cancellation removes the job without inventing an active worker"
        );
        assert!(!queue.is_reserved("member-1"));
    }

    #[test]
    fn squad_dispatch_user_cancel_finishes_durably_before_releasing_reservation() {
        let data = tempfile::tempdir().expect("data");
        let project = tempfile::tempdir().expect("project");
        let core = Arc::new(
            Core::open(CoreConfig {
                paths: Paths::new(data.path()),
                app_version: "0.1.9-test".into(),
                channel: BuildChannel::Development,
            })
            .expect("core"),
        );
        let workspace = core.open_workspace(project.path()).expect("workspace");
        let (state, resources) = fixture_with_thread_runtime(core.clone(), data.path());
        let mut spec = observed_spec("Cancel member".into(), workspace.id, OperationKind::Agent);
        spec.prompt = Some("Review the change".into());
        spec.provider_id = Some("fixture".into());
        let operation = state.store.enqueue(spec).expect("enqueue");
        state
            .squad_dispatch
            .enqueue(&operation.id, SquadDispatchKind::Authorize)
            .expect("queue dispatch");
        let (job, canceled) = state.squad_dispatch.take().expect("claim dispatch");
        let reservation = reservation_for(&state, &job, &canceled);
        state
            .store
            .request_dispatch_cancel(&operation.id)
            .expect("durable cancelling state");
        canceled.store(2, Ordering::Release);

        state
            .complete_squad_dispatch(&job, &reservation, Ok(false))
            .expect("complete exact cancellation");
        let cancelled = state.store.get(&operation.id).expect("cancelled member");
        assert_eq!(cancelled.status, OperationStatus::Cancelled);
        assert!(cancelled.attention_reason.is_none());
        assert!(!state.squad_dispatch.is_reserved(&operation.id));

        state
            .threads
            .shutdown_checked()
            .expect("thread runtime shutdown");
        assert!(resources.shutdown_checked());
        core.shutdown();
    }

    #[test]
    fn shutdown_joins_every_squad_worker_even_after_one_panics() {
        let data = tempfile::tempdir().expect("data");
        let core = Arc::new(
            Core::open(CoreConfig {
                paths: Paths::new(data.path()),
                app_version: "0.1.9-test".into(),
                channel: BuildChannel::Development,
            })
            .expect("core"),
        );
        let (state, resources) = fixture(core.clone(), data.path());
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        let waiting = release.clone();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let first = std::thread::spawn(|| panic!("expected worker panic"));
        let second = std::thread::spawn(move || {
            ready_tx.send(()).expect("ready");
            let (lock, wake) = &*waiting;
            let mut released = lock.lock().expect("release lock");
            while !*released {
                released = wake.wait(released).expect("release wait");
            }
        });
        ready_rx.recv().expect("worker waiting");
        state
            .squad_workers
            .lock()
            .expect("workers")
            .extend([first, second]);

        let shutdown = std::thread::spawn(move || {
            let clean = state.shutdown_checked();
            (clean, state)
        });
        std::thread::sleep(Duration::from_millis(50));
        assert!(
            !shutdown.is_finished(),
            "shutdown must keep joining workers after the first panic"
        );
        {
            let (lock, wake) = &*release;
            *lock.lock().expect("release lock") = true;
            wake.notify_all();
        }
        let (clean, state) = shutdown.join().expect("shutdown caller");
        assert!(!clean, "the panicked worker remains a truthful failure");
        assert!(
            state.shutdown_checked(),
            "a retry succeeds only after all worker handles were joined"
        );

        assert!(resources.shutdown_checked());
        core.shutdown();
    }

    fn reservation_for(
        state: &OperationsState,
        job: &SquadDispatchJob,
        canceled: &Arc<AtomicU8>,
    ) -> DispatchReservation {
        DispatchReservation {
            queue: state.squad_dispatch.clone(),
            operation_id: job.operation_id.clone(),
            canceled: canceled.clone(),
            released: AtomicBool::new(false),
        }
    }

    struct TestLease;

    impl OperationsLease for TestLease {
        fn revalidate_core(&self) -> Result<()> {
            Ok(())
        }
    }

    fn test_leases() -> LeaseSource {
        Arc::new(|| Ok(Box::new(TestLease) as Box<dyn OperationsLease>))
    }

    struct AllowAll;

    impl NativeConfirmer for AllowAll {
        fn show(&self, _confirmation: &NativeConfirmation) -> kalcode_core::confirm::DialogAnswer {
            kalcode_core::confirm::DialogAnswer::Confirmed
        }
    }

    fn insert_pane(core: &Core, id: &str, spec: &OperationSpec, status: ThreadStatus) {
        let workspace = core
            .workspaces()
            .expect("workspaces")
            .into_iter()
            .find(|workspace| workspace.id == spec.workspace_id)
            .expect("pane workspace");
        let provider = kalcode_contracts::agent::ProviderId::new(
            spec.provider_id.as_deref().expect("pane provider"),
        );
        let now = kalcode_core::time::now_rfc3339();
        core.write_with_events(|tx| {
            kalcode_threads::store::insert_thread(
                tx,
                &kalcode_threads::store::NewThreadRow {
                    id,
                    name: &spec.name,
                    provider_id: &provider,
                    provider_name: "Fake provider",
                    model: spec.model.as_deref(),
                    effort: spec.effort.as_deref(),
                    provider_account_id: spec.provider_account_id.as_deref(),
                    account_label: Some("Fake account"),
                    workspace_id: &workspace.id,
                    workspace_name: &workspace.name,
                    cwd: &workspace.root_path,
                    permission_mode: PermissionMode::Auto,
                    now: &now,
                },
            )?;
            kalcode_threads::store::set_status(tx, id, status, Some("Fake pane"), &now)?;
            Ok(((), Vec::new()))
        })
        .expect("insert fake pane");
    }

    fn set_pane_status(core: &Core, id: &str, status: ThreadStatus) {
        let now = kalcode_core::time::now_rfc3339();
        core.write_with_events(|tx| {
            kalcode_threads::store::set_status(tx, id, status, Some("Fake pane"), &now)?;
            Ok(((), Vec::new()))
        })
        .expect("set fake pane status");
    }

    #[derive(Default)]
    struct FakeSpawns {
        block: bool,
        released: HashSet<String>,
        spawning: HashSet<String>,
    }

    /// A deliberately slow provider-pane factory. Creation can be held mid-spawn; it records the
    /// pane in the real thread store so every runtime lookup, stop and archive is genuine.
    struct FakePanes {
        core: Arc<Core>,
        spawns: Mutex<FakeSpawns>,
        changed: Condvar,
        user_turn: Mutex<HashSet<String>>,
        panic_on: Mutex<HashSet<String>>,
        rearmed: Mutex<Vec<String>>,
        /// Simulates a provider default that changed after a pane started.
        canonical_model: Mutex<Option<String>>,
    }

    impl FakePanes {
        fn new(core: Arc<Core>) -> Self {
            Self {
                core,
                spawns: Mutex::new(FakeSpawns::default()),
                changed: Condvar::new(),
                user_turn: Mutex::new(HashSet::new()),
                panic_on: Mutex::new(HashSet::new()),
                rearmed: Mutex::new(Vec::new()),
                canonical_model: Mutex::new(None),
            }
        }

        fn block_spawns(&self) {
            self.spawns.lock().expect("spawns").block = true;
        }

        fn release(&self, id: &str) {
            self.spawns
                .lock()
                .expect("spawns")
                .released
                .insert(id.to_owned());
            self.changed.notify_all();
        }

        fn release_all(&self) {
            self.spawns.lock().expect("spawns").block = false;
            self.changed.notify_all();
        }

        fn wait_spawning(&self, count: usize) -> bool {
            let deadline = Instant::now() + Duration::from_secs(20);
            let mut spawns = self.spawns.lock().expect("spawns");
            while spawns.spawning.len() < count {
                let now = Instant::now();
                if now >= deadline {
                    return false;
                }
                spawns = self
                    .changed
                    .wait_timeout(spawns, deadline - now)
                    .expect("spawn wait")
                    .0;
            }
            true
        }

        fn create(
            &self,
            threads: &ThreadsState,
            request: &OperationPaneRequest<'_>,
            status: ThreadStatus,
        ) -> Result<ThreadSummary> {
            let panic = self
                .panic_on
                .lock()
                .expect("panic set")
                .contains(request.operation_id);
            if panic {
                panic!("fake provider factory panicked");
            }
            {
                let mut spawns = self.spawns.lock().expect("spawns");
                spawns.spawning.insert(request.operation_id.to_owned());
                self.changed.notify_all();
                while spawns.block && !spawns.released.contains(request.operation_id) {
                    spawns = self.changed.wait(spawns).expect("spawn release");
                }
                spawns.spawning.remove(request.operation_id);
                self.changed.notify_all();
            }
            insert_pane(&self.core, request.operation_id, request.spec, status);
            threads
                .runtime_handle()
                .ok_or_else(unavailable)?
                .get(request.operation_id)
        }
    }

    impl OperationPanes for FakePanes {
        fn canonicalize(
            &self,
            _threads: &ThreadsState,
            _core: &Arc<Core>,
            spec: &OperationSpec,
        ) -> Result<OperationSpec> {
            let mut spec = spec.clone();
            if let Some(model) = self.canonical_model.lock().expect("model").clone() {
                spec.model = Some(model);
            }
            Ok(spec)
        }

        fn prepare(
            &self,
            threads: &ThreadsState,
            request: OperationPaneRequest<'_>,
        ) -> Result<ThreadSummary> {
            let runtime = threads.runtime_handle().ok_or_else(unavailable)?;
            if runtime.get(request.operation_id).is_ok() {
                // Mirrors the runtime: a pane the person typed into refuses to re-enter the
                // dependency wait until an explicit Run now re-arms it.
                if self
                    .user_turn
                    .lock()
                    .expect("user turns")
                    .contains(request.operation_id)
                {
                    return Err(KalError::validation(
                        "operation_prepared_thread_busy",
                        "This member's terminal is already working.",
                    ));
                }
                set_pane_status(
                    &self.core,
                    request.operation_id,
                    ThreadStatus::WaitingForDependency,
                );
                return runtime.get(request.operation_id);
            }
            self.create(threads, &request, ThreadStatus::WaitingForDependency)
        }

        fn start(
            &self,
            threads: &ThreadsState,
            request: OperationPaneRequest<'_>,
        ) -> Result<ThreadSummary> {
            self.create(threads, &request, ThreadStatus::Active)
        }

        fn deliver(
            &self,
            threads: &ThreadsState,
            operation_id: &str,
            _prompt: Option<&str>,
        ) -> Result<ThreadSummary> {
            // Mirrors runtime.rs send_prepared_operation/dependency_ready: a prepared pane only
            // accepts its task while it is still waiting for its dependencies.
            let runtime = threads.runtime_handle().ok_or_else(unavailable)?;
            if runtime.get(operation_id)?.status != ThreadStatus::WaitingForDependency
                || self
                    .user_turn
                    .lock()
                    .expect("user turns")
                    .contains(operation_id)
            {
                return Err(KalError::validation(
                    "operation_prepared_thread_changed",
                    "This member's terminal was used before its Squad task started.",
                ));
            }
            set_pane_status(&self.core, operation_id, ThreadStatus::Active);
            threads
                .runtime_handle()
                .ok_or_else(unavailable)?
                .get(operation_id)
        }

        fn rearm(&self, _threads: &ThreadsState, operation_id: &str) -> Result<bool> {
            self.rearmed
                .lock()
                .expect("rearmed")
                .push(operation_id.to_owned());
            Ok(self
                .user_turn
                .lock()
                .expect("user turns")
                .remove(operation_id))
        }
    }

    /// A real Squad launch over a real ledger and thread store, with a fake pane factory.
    struct SquadHarness {
        core: Arc<Core>,
        state: Arc<OperationsState>,
        resources: Arc<crate::resource_commands::ResourceGovernorState>,
        panes: Arc<FakePanes>,
        workspace_id: String,
        ids: HashMap<String, String>,
        _data: tempfile::TempDir,
        _project: tempfile::TempDir,
    }

    impl SquadHarness {
        fn new(members: &[(&str, &[&str])]) -> Self {
            Self::new_with(members, false)
        }

        fn new_with(members: &[(&str, &[&str])], repository: bool) -> Self {
            let data = tempfile::tempdir().expect("data");
            let project = tempfile::tempdir().expect("project");
            if repository {
                for args in [
                    &["init", "-q", "-b", "main"][..],
                    &["config", "user.name", "Test User"],
                    &["config", "user.email", "test@example.invalid"],
                    &["config", "commit.gpgSign", "false"],
                ] {
                    git_in(project.path(), args);
                }
                commit_file(project.path(), "README.md", "one\n");
            }
            let core = Arc::new(
                Core::open(CoreConfig {
                    paths: Paths::new(data.path()),
                    app_version: "0.1.9-test".into(),
                    channel: BuildChannel::Development,
                })
                .expect("core"),
            );
            let workspace = core.open_workspace(project.path()).expect("workspace");
            let account_id = kalcode_contracts::ids::new_id();
            core.transact(|tx| {
                tx.execute(
                    "INSERT INTO provider_accounts (
                       id, provider_id, display_name, authentication_state, is_default, created_at
                     ) VALUES (?1, 'codex', 'Codex test', 'authenticated', 0,
                       '2026-10-06T12:00:00.000Z')",
                    [&account_id],
                )?;
                Ok(((), Vec::new()))
            })
            .expect("provider account");
            let ids: HashMap<String, String> = if members.is_empty() {
                HashMap::new()
            } else {
                let squads = SquadsStore::new(core.clone());
                let saved = squads
                    .save_squad(SquadDefinition {
                        id: kalcode_contracts::ids::new_id(),
                        name: "Dispatch crew".into(),
                        goal: "Exercise the Squad dispatcher".into(),
                        members: members
                            .iter()
                            .map(|(key, depends_on)| SquadMemberDefinition {
                                key: (*key).into(),
                                name: format!("{key} member"),
                                provider_id: "codex".into(),
                                provider_account_id: account_id.clone(),
                                model: "gpt-test".into(),
                                effort: "high".into(),
                                role: "implementation".into(),
                                task: Some(format!("Implement {key}.")),
                                worktree: false,
                                depends_on: depends_on.iter().map(|key| (*key).into()).collect(),
                                manager_key: None,
                                owned_paths: vec![format!("{key}/")],
                            })
                            .collect(),
                    })
                    .expect("save squad");
                let launch = squads
                    .launch(
                        &kalcode_contracts::ids::new_id(),
                        &saved.id,
                        &workspace.id,
                        None,
                        None,
                    )
                    .expect("launch squad");
                launch
                    .members
                    .iter()
                    .map(|member| (member.key.clone(), member.operation_id.clone()))
                    .collect()
            };
            let (mut state, resources) = fixture_with_thread_runtime(core.clone(), data.path());
            let panes = Arc::new(FakePanes::new(core.clone()));
            state.panes = panes.clone() as Arc<dyn OperationPanes>;
            Self {
                core,
                state: Arc::new(state),
                resources,
                panes,
                workspace_id: workspace.id,
                ids,
                _data: data,
                _project: project,
            }
        }

        fn id(&self, key: &str) -> String {
            self.ids[key].clone()
        }

        fn row(&self, key: &str) -> OperationRecord {
            self.state.store.get(&self.ids[key]).expect("member row")
        }

        fn thread(&self, key: &str) -> ThreadSummary {
            self.state
                .threads
                .runtime_handle()
                .expect("runtime")
                .get(&self.ids[key])
                .expect("member pane")
        }

        /// The exact consent a Squad launch grants a member.
        fn launch_consent(&self, key: &str) {
            let row = self.row(key);
            self.state.authorized.lock().expect("consent").insert(
                row.id.clone(),
                Authorization {
                    spec: row.spec,
                    revision: (None, None),
                    expires: None,
                    origin: LaunchOrigin::User,
                    revision_bound: false,
                },
            );
        }

        fn prepare_waiting(&self, key: &str) {
            let row = self.row(key);
            self.state
                .store
                .prepare_agent_thread(&row.id, None, None)
                .expect("prepare member");
            insert_pane(
                &self.core,
                &row.id,
                &row.spec,
                ThreadStatus::WaitingForDependency,
            );
        }

        fn start_running(&self, key: &str) {
            let id = self.id(key);
            let claimed = self
                .state
                .store
                .claim_user_squad_agent(&id)
                .expect("claim")
                .expect("claimable");
            self.state
                .store
                .reserve_agent_thread(&id, None, None)
                .expect("reserve pane");
            insert_pane(&self.core, &id, &claimed.spec, ThreadStatus::Active);
            self.state
                .store
                .bind(&id, None, Some(&id), None, None)
                .expect("bind pane");
        }

        fn take_job(
            &self,
            key: &str,
            kind: SquadDispatchKind,
        ) -> (SquadDispatchJob, DispatchReservation) {
            assert!(
                self.state
                    .squad_dispatch
                    .enqueue(&self.ids[key], kind)
                    .expect("enqueue")
            );
            let (job, canceled) = self.state.squad_dispatch.take().expect("take job");
            assert_eq!(job.operation_id, self.ids[key]);
            let reservation = reservation_for(&self.state, &job, &canceled);
            (job, reservation)
        }

        fn wait_released(&self, key: &str) {
            let deadline = Instant::now() + Duration::from_secs(20);
            while self.state.squad_dispatch.is_reserved(&self.ids[key]) {
                assert!(Instant::now() < deadline, "{key} dispatch never finished");
                std::thread::sleep(Duration::from_millis(10));
            }
        }

        fn shutdown(self) {
            self.panes.release_all();
            assert!(self.state.shutdown_checked(), "Operations shutdown");
            self.state
                .threads
                .shutdown_checked()
                .expect("thread runtime shutdown");
            assert!(self.resources.shutdown_checked());
            self.core.shutdown();
        }
    }

    #[test]
    fn cancelling_an_ordinary_run_whose_thread_already_ended_still_cancels() {
        // All-Operations hardening kept from the branch: a provider thread that already ended
        // (stop reports `thread_not_running`) must not make Cancel fail for an ordinary task.
        let squad = SquadHarness::new(&[]);
        let mut spec = observed_spec(
            "Ordinary agent".into(),
            squad.workspace_id.clone(),
            OperationKind::Agent,
        );
        spec.prompt = Some("Review the change".into());
        spec.provider_id = Some("codex".into());
        let operation = squad.state.store.enqueue(spec).expect("enqueue");
        let claimed = squad
            .state
            .store
            .claim(Some(&operation.id))
            .expect("claim")
            .expect("claimable");
        squad
            .state
            .store
            .reserve_agent_thread(&operation.id, None, None)
            .expect("reserve");
        insert_pane(
            &squad.core,
            &operation.id,
            &claimed.spec,
            ThreadStatus::Completed,
        );
        squad
            .state
            .store
            .bind(&operation.id, None, Some(&operation.id), None, None)
            .expect("bind");

        squad
            .state
            .cancel_command(&operation.id)
            .expect("cancel an ended run");
        assert_eq!(
            squad.state.store.get(&operation.id).expect("run").status,
            OperationStatus::Cancelled
        );
        squad.shutdown();
    }

    fn git_in(dir: &Path, args: &[&str]) {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .expect("spawn git");
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn commit_file(dir: &Path, name: &str, content: &str) {
        std::fs::write(dir.join(name), content).expect("write file");
        git_in(dir, &["add", name]);
        git_in(dir, &["commit", "-q", "--no-verify", "-m", name]);
    }

    /// Records whether the Operations gate was held while the native dialog was showing.
    struct GateProbe {
        state: Arc<OperationsState>,
        gate_held: AtomicBool,
    }

    impl NativeConfirmer for GateProbe {
        fn show(&self, _confirmation: &NativeConfirmation) -> kalcode_core::confirm::DialogAnswer {
            self.gate_held
                .store(self.state.gate.try_lock().is_err(), Ordering::SeqCst);
            kalcode_core::confirm::DialogAnswer::Confirmed
        }
    }

    fn finish_dependency(squad: &SquadHarness, key: &str) {
        squad
            .state
            .store
            .finish(&squad.id(key), OperationStatus::Succeeded, "Done.")
            .expect("dependency succeeded");
    }

    fn run_job_now(squad: &SquadHarness, key: &str) {
        let (job, canceled) = squad.state.squad_dispatch.take().expect("job");
        assert_eq!(job.operation_id, squad.id(key));
        let reservation = reservation_for(&squad.state, &job, &canceled);
        squad
            .state
            .run_dispatch_job(&job, &reservation, &test_leases());
    }

    /// Runs a member's job on a worker thread while the fake factory holds its spawn.
    fn spawn_blocked_job(
        squad: &SquadHarness,
        key: &str,
        kind: SquadDispatchKind,
    ) -> std::thread::JoinHandle<()> {
        squad.panes.block_spawns();
        let (job, reservation) = squad.take_job(key, kind);
        let state = squad.state.clone();
        let worker = std::thread::spawn(move || {
            state.run_dispatch_job(&job, &reservation, &test_leases());
        });
        assert!(squad.panes.wait_spawning(1), "{key} reaches its spawn");
        worker
    }

    #[test]
    fn run_now_recovers_a_used_pane_after_its_dependency_finished() {
        let squad = SquadHarness::new(&[("build", &[]), ("review", &["build"])]);
        squad.prepare_waiting("review");
        let id = squad.id("review");
        // The person typed into the waiting pane; the scheduler held the member.
        squad
            .panes
            .user_turn
            .lock()
            .expect("user turns")
            .insert(id.clone());
        set_pane_status(&squad.core, &id, ThreadStatus::Idle);
        squad
            .state
            .store
            .hold_with_reason(&id, "Terminal used directly; Squad task remains held.")
            .expect("hold");
        // Its dependency then succeeds, so nothing blocks it any more.
        squad.start_running("build");
        finish_dependency(&squad, "build");
        assert!(squad.row("review").blockers.is_empty());

        squad
            .state
            .run_now_command(&AllowAll, &TestLease, &id)
            .expect("run now");
        run_job_now(&squad, "review");

        let review = squad.row("review");
        assert_eq!(
            review.status,
            OperationStatus::Running,
            "the re-armed pane re-enters its wait, then receives its task once: {:?}",
            review.attention_reason
        );
        assert_eq!(review.thread_id.as_deref(), Some(id.as_str()));
        assert_eq!(squad.thread("review").status, ThreadStatus::Active);
        squad.shutdown();
    }

    #[test]
    fn cancel_after_a_member_received_its_task_keeps_its_pane_and_evidence() {
        let squad = SquadHarness::new(&[("one", &[])]);
        squad.launch_consent("one");
        let worker = spawn_blocked_job(&squad, "one", SquadDispatchKind::Run);
        // The provider start (which sends the prompt) is in flight when Cancel arrives.
        squad
            .state
            .cancel_command(&squad.id("one"))
            .expect("cancel mid-start");
        squad.panes.release_all();
        worker.join().expect("worker");

        let one = squad.row("one");
        assert_eq!(one.status, OperationStatus::Cancelled);
        assert!(
            one.outcome
                .as_deref()
                .is_some_and(|outcome| outcome.starts_with("Cancelled by you.")),
            "{:?}",
            one.outcome
        );
        let pane = squad.thread("one");
        assert_eq!(
            pane.status,
            ThreadStatus::Interrupted,
            "the pane is stopped"
        );
        assert!(
            pane.archived_at.is_none(),
            "a pane that may hold delivered work is never archived on cancel"
        );
        assert!(!squad.state.squad_dispatch.is_reserved(&squad.id("one")));
        squad.shutdown();
    }

    #[test]
    fn shutdown_leaves_a_delivered_member_for_restart_recovery() {
        let squad = SquadHarness::new(&[("one", &[])]);
        squad.launch_consent("one");
        let worker = spawn_blocked_job(&squad, "one", SquadDispatchKind::Run);
        squad.state.squad_dispatch.stop();
        squad.panes.release_all();
        worker.join().expect("worker");

        let one = squad.row("one");
        assert_eq!(
            one.status,
            OperationStatus::Running,
            "delivered work is recorded"
        );
        assert_eq!(one.thread_id.as_deref(), Some(one.id.as_str()));
        let pane = squad.thread("one");
        assert!(pane.archived_at.is_none(), "shutdown never archives it");
        assert_eq!(pane.status, ThreadStatus::Active);
        squad.shutdown();
    }

    #[test]
    fn declining_run_now_keeps_the_existing_hold_reason() {
        const RESTART: &str =
            "KalCode restarted before this member started. Run now to revalidate and start it.";
        let squad = SquadHarness::new(&[("one", &[])]);
        let id = squad.id("one");
        squad
            .state
            .store
            .hold_with_reason(&id, RESTART)
            .expect("restart hold");
        let error = squad
            .state
            .run_now_command(&kalcode_core::confirm::DenyAll, &TestLease, &id)
            .expect_err("declined");
        assert_eq!(error.code, "confirmation_declined");
        assert_eq!(squad.row("one").attention_reason.as_deref(), Some(RESTART));

        // Ordinary tasks keep main's behaviour: a decline or Run now never rewrites or clears
        // their hold.
        let mut build = observed_spec(
            "Held build".into(),
            squad.workspace_id.clone(),
            OperationKind::Build,
        );
        build.command = Some("echo build".into());
        let build = squad.state.store.enqueue(build).expect("enqueue build");
        squad
            .state
            .store
            .hold_with_reason(&build.id, "Needs attention.")
            .expect("hold build");
        for confirmer in [
            &kalcode_core::confirm::DenyAll as &dyn NativeConfirmer,
            &AllowAll,
        ] {
            assert!(
                squad
                    .state
                    .run_now_command(confirmer, &TestLease, &build.id)
                    .is_err()
            );
            assert_eq!(
                squad
                    .state
                    .store
                    .get(&build.id)
                    .expect("build")
                    .attention_reason
                    .as_deref(),
                Some("Needs attention.")
            );
        }
        squad.shutdown();
    }

    #[test]
    fn a_paused_member_needs_run_now_to_start_again() {
        let squad = SquadHarness::new(&[("one", &[]), ("two", &[])]);
        let one = squad.id("one");
        squad.launch_consent("one");
        squad.state.hold_command(&one, true).expect("pause member");
        assert!(
            !squad
                .state
                .authorized
                .lock()
                .expect("consent")
                .contains_key(&one),
            "pausing revokes the launch consent"
        );
        squad.state.store.set_paused(true).expect("pause queue");
        let error = squad
            .state
            .hold_command(&one, false)
            .expect_err("resume without a new Run now");
        assert_eq!(error.code, "operation_squad_run_required");
        squad.state.tick(&TestLease).expect("tick");
        assert!(!squad.state.squad_dispatch.is_reserved(&one));
        assert_eq!(squad.row("one").status, OperationStatus::Paused);

        // Paused during its Authorize job: it never got consent, so it cannot sit queued with
        // no reason after a resume either. Run now starts it.
        let two = squad.id("two");
        let (job, reservation) = squad.take_job("two", SquadDispatchKind::Authorize);
        squad
            .state
            .hold_command(&two, true)
            .expect("pause mid-authorize");
        squad
            .state
            .run_dispatch_job(&job, &reservation, &test_leases());
        assert_eq!(
            squad
                .state
                .hold_command(&two, false)
                .expect_err("resume without consent")
                .code,
            "operation_squad_run_required"
        );
        squad
            .state
            .run_now_command(&AllowAll, &TestLease, &two)
            .expect("run now");
        assert!(squad.state.squad_dispatch.is_reserved(&two));
        squad.shutdown();
    }

    #[test]
    fn a_hold_during_preparation_keeps_the_new_waiting_pane() {
        let squad = SquadHarness::new(&[("build", &[]), ("review", &["build"])]);
        squad.launch_consent("review");
        let worker = spawn_blocked_job(&squad, "review", SquadDispatchKind::Run);
        squad
            .state
            .hold_command(&squad.id("review"), true)
            .expect("pause mid-prepare");
        squad.panes.release_all();
        worker.join().expect("worker");
        assert_eq!(squad.row("review").status, OperationStatus::Paused);
        assert_eq!(
            squad.thread("review").status,
            ThreadStatus::WaitingForDependency,
            "a held member keeps its prepared pane"
        );
        squad.shutdown();
    }

    #[test]
    fn squad_run_now_consent_survives_a_dependency_moving_head() {
        let squad = SquadHarness::new_with(&[("build", &[]), ("review", &["build"])], true);
        squad.prepare_waiting("review");
        let id = squad.id("review");
        squad
            .state
            .run_now_command(&AllowAll, &TestLease, &id)
            .expect("run now while waiting");
        // The no-op re-dispatch of a waiting pane.
        run_job_now(&squad, "review");
        // The dependency commits (HEAD moves), then succeeds.
        let root = squad
            .core
            .workspaces()
            .expect("workspaces")
            .into_iter()
            .find(|workspace| workspace.id == squad.workspace_id)
            .expect("workspace")
            .root_path;
        commit_file(Path::new(&root), "build.txt", "built\n");
        squad.start_running("build");
        finish_dependency(&squad, "build");
        assert!(
            squad
                .state
                .squad_dispatch
                .enqueue(&id, SquadDispatchKind::Run)
                .expect("enqueue")
        );
        run_job_now(&squad, "review");
        assert_eq!(
            squad.row("review").status,
            OperationStatus::Running,
            "a shared-workspace member's consent is not revoked by its dependency's commit: {:?}",
            squad.row("review").outcome
        );
        squad.shutdown();
    }

    #[test]
    fn run_now_reports_provider_drift_for_a_prepared_member() {
        let squad = SquadHarness::new(&[("build", &[]), ("review", &["build"])]);
        squad.prepare_waiting("review");
        *squad.panes.canonical_model.lock().expect("model") = Some("gpt-next".into());
        let error = squad
            .state
            .run_now_command(&AllowAll, &TestLease, &squad.id("review"))
            .expect_err("drifted identity");
        assert_eq!(error.code, "operation_prepared_identity_drift");
        assert_eq!(squad.row("review").spec.model.as_deref(), Some("gpt-test"));
        squad.shutdown();
    }

    #[test]
    fn settlement_survives_a_panic_that_poisoned_the_gate() {
        let squad = SquadHarness::new(&[("one", &[])]);
        let (job, reservation) = squad.take_job("one", SquadDispatchKind::Run);
        squad
            .state
            .cancel_command(&squad.id("one"))
            .expect("cancel");
        let state = squad.state.clone();
        let panicked = std::thread::spawn(move || {
            let _gate = state.gate.lock().expect("gate");
            panic!("panic while holding the Operations gate");
        })
        .join();
        assert!(panicked.is_err());
        assert!(squad.state.gate.is_poisoned());
        squad
            .state
            .complete_squad_dispatch(&job, &reservation, Ok(false))
            .expect("settles despite the poisoned gate");
        assert_eq!(squad.row("one").status, OperationStatus::Cancelled);
        assert!(!squad.state.squad_dispatch.is_reserved(&squad.id("one")));
        squad.shutdown();
    }

    #[test]
    fn ordinary_run_now_keeps_the_gate_across_its_confirmation() {
        let squad = SquadHarness::new(&[]);
        let mut build = observed_spec(
            "Ordinary build".into(),
            squad.workspace_id.clone(),
            OperationKind::Build,
        );
        build.command = Some("echo build".into());
        let build = squad.state.store.enqueue(build).expect("enqueue build");
        squad.state.store.set_paused(true).expect("pause queue");
        let probe = GateProbe {
            state: squad.state.clone(),
            gate_held: AtomicBool::new(false),
        };
        let _ = squad.state.run_now_command(&probe, &TestLease, &build.id);
        assert!(
            probe.gate_held.load(Ordering::SeqCst),
            "as on main, no edit or delete can interleave with an ordinary task's dialog"
        );
        squad.shutdown();
    }

    #[test]
    fn prepared_waiting_member_does_not_spin_the_scheduler() {
        let squad = SquadHarness::new(&[("build", &[]), ("review", &["build"])]);
        squad.start_running("build");
        squad.prepare_waiting("review");
        squad.launch_consent("review");
        assert!(!squad.row("review").blockers.is_empty());
        squad
            .state
            .start_squad_workers(test_leases())
            .expect("workers");
        squad
            .state
            .start_scheduler(test_leases())
            .expect("scheduler");

        std::thread::sleep(Duration::from_millis(2_500));
        let dispatched = squad.state.squad_dispatch.jobs_taken();
        assert!(
            dispatched <= 2,
            "a pane waiting on a running dependency must not be re-dispatched in a hot loop \
             (dispatched {dispatched} jobs in 2.5 s)"
        );
        let review = squad.row("review");
        assert!(review.attention_reason.is_none());
        assert_eq!(
            squad.thread("review").status,
            ThreadStatus::WaitingForDependency
        );
        assert!(
            !squad.state.store.snapshot().expect("snapshot").1,
            "queue not paused"
        );
        squad.shutdown();
    }

    #[test]
    fn cancelling_a_queued_squad_dispatch_stops_the_prepared_pane() {
        let squad = SquadHarness::new(&[("build", &[]), ("review", &["build"])]);
        squad.prepare_waiting("review");
        let id = squad.id("review");
        assert!(
            squad
                .state
                .squad_dispatch
                .enqueue(&id, SquadDispatchKind::Run)
                .expect("enqueue")
        );

        squad
            .state
            .cancel_command(&id)
            .expect("cancel queued dispatch");
        assert_eq!(squad.row("review").status, OperationStatus::Cancelled);
        assert_eq!(
            squad.thread("review").status,
            ThreadStatus::Interrupted,
            "the prepared provider pane stops with its cancelled member"
        );
        assert!(!squad.state.squad_dispatch.is_reserved(&id));
        squad.shutdown();
    }

    #[test]
    fn run_now_rearms_a_prepared_pane_the_person_used_before_redispatch() {
        let squad = SquadHarness::new(&[("build", &[]), ("review", &["build"])]);
        squad.prepare_waiting("review");
        let id = squad.id("review");
        // The person typed into the waiting pane; the scheduler then held the member.
        squad
            .panes
            .user_turn
            .lock()
            .expect("user turns")
            .insert(id.clone());
        set_pane_status(&squad.core, &id, ThreadStatus::Idle);
        squad
            .state
            .store
            .hold_with_reason(&id, "Terminal used directly; Squad task remains held.")
            .expect("hold");

        squad
            .state
            .run_now_command(&AllowAll, &TestLease, &id)
            .expect("run now");
        assert_eq!(
            *squad.panes.rearmed.lock().expect("rearmed"),
            vec![id.clone()]
        );
        let (job, canceled) = squad.state.squad_dispatch.take().expect("re-dispatch");
        let reservation = reservation_for(&squad.state, &job, &canceled);
        squad
            .state
            .run_dispatch_job(&job, &reservation, &test_leases());

        let review = squad.row("review");
        assert!(
            review.attention_reason.is_none(),
            "dispatch proceeds after the explicit re-arm: {:?}",
            review.attention_reason
        );
        assert!(matches!(
            review.status,
            OperationStatus::Queued | OperationStatus::Blocked
        ));
        assert_eq!(
            squad.thread("review").status,
            ThreadStatus::WaitingForDependency
        );
        assert!(!squad.state.squad_dispatch.is_reserved(&id));
        squad.shutdown();
    }

    #[test]
    fn run_now_refuses_an_in_flight_squad_dispatch_and_abandoned_starts_are_held() {
        let squad = SquadHarness::new(&[("one", &[]), ("two", &[]), ("three", &[])]);
        let (_job, reservation) = squad.take_job("one", SquadDispatchKind::Run);
        let error = squad
            .state
            .run_now_command(&AllowAll, &TestLease, &squad.id("one"))
            .expect_err("Run now during an in-flight dispatch");
        assert_eq!(error.code, "operation_dispatch_in_progress");
        assert_eq!(
            reservation.canceled.load(Ordering::Acquire),
            0,
            "Run now never cancels a member that may already have its task"
        );
        assert!(squad.state.squad_dispatch.is_reserved(&squad.id("one")));
        reservation.release();

        // A dispatch that claimed a member but never reserved its pane returns it to a hold.
        let (job, reservation) = squad.take_job("two", SquadDispatchKind::Run);
        squad
            .state
            .store
            .claim_user_squad_agent(&squad.id("two"))
            .expect("claim")
            .expect("claimable");
        squad
            .state
            .complete_squad_dispatch(&job, &reservation, Ok(false))
            .expect("complete");
        let two = squad.row("two");
        assert_eq!(two.status, OperationStatus::Paused);
        assert_eq!(
            two.attention_reason.as_deref(),
            Some(UNBOUND_SQUAD_START_REASON)
        );
        assert!(!squad.state.squad_dispatch.is_reserved(&squad.id("two")));

        // Reconcile does the same for one no dispatch owns any more.
        squad
            .state
            .store
            .claim_user_squad_agent(&squad.id("three"))
            .expect("claim")
            .expect("claimable");
        squad.state.reconcile().expect("reconcile");
        let three = squad.row("three");
        assert_eq!(three.status, OperationStatus::Paused);
        assert_eq!(
            three.attention_reason.as_deref(),
            Some(UNBOUND_SQUAD_START_REASON)
        );
        squad.shutdown();
    }

    #[test]
    fn identity_edits_wait_for_an_in_flight_dispatch_and_mismatch_holds_only_the_member() {
        let squad = SquadHarness::new(&[("one", &[]), ("two", &["one"])]);
        let id = squad.id("one");
        assert!(
            squad
                .state
                .squad_dispatch
                .enqueue(&id, SquadDispatchKind::Run)
                .expect("enqueue")
        );
        let mut identity_edit = squad.row("one").spec;
        identity_edit.model = Some("other-model".into());
        let revision = squad.state.store.snapshot().expect("snapshot").0;
        let error = squad
            .state
            .update_command(&AllowAll, &TestLease, &id, identity_edit, revision)
            .expect_err("identity edit while dispatching");
        assert_eq!(error.code, "operation_dispatch_identity_locked");
        assert_eq!(squad.row("one").spec.model.as_deref(), Some("gpt-test"));
        let mut task_edit = squad.row("one").spec;
        task_edit.prompt = Some("Implement one, then report.".into());
        squad
            .state
            .update_command(&AllowAll, &TestLease, &id, task_edit, revision)
            .expect("task text may change while the pane starts");
        // Drop the still-queued job so the next take is the member under test.
        assert!(!squad.state.squad_dispatch.cancel(&id, false));

        // A pane created with an older identity is stopped by its exact id and only its member
        // is held; the global queue keeps running.
        let two = squad.row("two");
        squad
            .state
            .store
            .prepare_agent_thread(&two.id, None, None)
            .expect("prepare");
        let mut old = two.spec.clone();
        old.model = Some("old-model".into());
        insert_pane(
            &squad.core,
            &two.id,
            &old,
            ThreadStatus::WaitingForDependency,
        );
        let (job, reservation) = squad.take_job("two", SquadDispatchKind::Run);
        let error = squad
            .state
            .stop_exact_squad_thread(&squad.row("two"))
            .expect_err("mismatched pane");
        assert_eq!(error.code, MEMBER_PANE_MISMATCH);
        assert_eq!(squad.thread("two").status, ThreadStatus::Interrupted);
        let _ = squad
            .state
            .complete_squad_dispatch(&job, &reservation, Err(error));
        let two = squad.row("two");
        assert_eq!(two.status, OperationStatus::Paused);
        assert!(
            two.attention_reason
                .as_deref()
                .is_some_and(|reason| reason.contains("no longer matched"))
        );
        assert!(
            !squad.state.store.snapshot().expect("snapshot").1,
            "a member mismatch never pauses the whole queue"
        );
        assert!(!squad.state.squad_dispatch.is_reserved(&two.id));
        squad.shutdown();
    }

    #[test]
    fn paused_queue_with_a_run_now_ordinary_task_still_dispatches_ready_squad_members() {
        let squad = SquadHarness::new(&[("one", &[])]);
        // The ordinary task is ahead of the Squad member in queue order.
        let mut build = observed_spec(
            "Ordinary build".into(),
            squad.workspace_id.clone(),
            OperationKind::Build,
        );
        build.command = Some("echo build".into());
        let build = squad.state.store.enqueue(build).expect("enqueue build");
        squad.state.store.set_paused(true).expect("pause queue");

        let error = squad
            .state
            .run_now_command(&AllowAll, &TestLease, &build.id)
            .expect_err("paused queue");
        assert_eq!(error.code, "operations_paused");
        assert_eq!(
            squad.state.authorized.lock().expect("consent")[&build.id].origin,
            LaunchOrigin::Background,
            "an ordinary Run now keeps main's Background consent"
        );

        squad.launch_consent("one");
        squad.state.tick(&TestLease).expect("tick never fails");
        assert!(
            squad.state.squad_dispatch.is_reserved(&squad.id("one")),
            "the ready Squad member is still dispatched"
        );
        assert_eq!(
            squad.state.store.get(&build.id).expect("build").status,
            OperationStatus::Queued
        );
        squad.shutdown();
    }

    #[test]
    fn cancelling_member_refuses_run_now_edits_and_resume() {
        let squad = SquadHarness::new(&[("one", &[])]);
        let id = squad.id("one");
        let (job, reservation) = squad.take_job("one", SquadDispatchKind::Run);
        squad
            .state
            .cancel_command(&id)
            .expect("cancel active dispatch");
        assert!(dispatch_user_canceled(&reservation.canceled));

        let run_now = squad
            .state
            .run_now_command(&AllowAll, &TestLease, &id)
            .expect_err("Run now while stopping");
        assert_eq!(run_now.code, "operation_cancellation_in_progress");
        let mut edit = squad.row("one").spec;
        edit.prompt = Some("Different task".into());
        let revision = squad.state.store.snapshot().expect("snapshot").0;
        let update = squad
            .state
            .update_command(&AllowAll, &TestLease, &id, edit, revision)
            .expect_err("edit while stopping");
        assert_eq!(update.code, "operation_cancellation_in_progress");
        let resume = squad
            .state
            .hold_command(&id, false)
            .expect_err("resume while stopping");
        assert_eq!(resume.code, "operation_cancellation_in_progress");
        let stopping = squad.row("one");
        assert_eq!(stopping.status, OperationStatus::Paused);
        assert_eq!(
            stopping.current_action.as_deref(),
            Some(OPERATION_CANCELLING_ACTION)
        );

        squad
            .state
            .complete_squad_dispatch(&job, &reservation, Ok(false))
            .expect("cleanup completes");
        assert_eq!(squad.row("one").status, OperationStatus::Cancelled);
        squad.shutdown();
    }

    #[test]
    fn editing_a_squad_member_keeps_user_non_expiring_dispatcher_consent() {
        let squad = SquadHarness::new(&[("one", &[])]);
        let id = squad.id("one");
        let mut edit = squad.row("one").spec;
        edit.prompt = Some("Implement one with tests.".into());
        let revision = squad.state.store.snapshot().expect("snapshot").0;
        squad
            .state
            .update_command(&AllowAll, &TestLease, &id, edit.clone(), revision)
            .expect("edit member");
        {
            let consent = squad.state.authorized.lock().expect("consent");
            let consent = &consent[&id];
            assert_eq!(consent.origin, LaunchOrigin::User);
            assert!(
                consent.expires.is_none(),
                "a Squad member's consent never expires"
            );
            assert_eq!(consent.spec.prompt, edit.prompt, "exactly the edited spec");
        }
        squad.state.tick(&TestLease).expect("tick");
        assert!(
            squad.state.squad_dispatch.is_reserved(&id),
            "the edited member stays on the lock-free dispatcher path"
        );
        assert_eq!(squad.row("one").status, OperationStatus::Queued);
        squad.shutdown();
    }

    #[test]
    fn dispatch_job_releases_its_reservation_after_a_store_error_and_a_panic() {
        let squad = SquadHarness::new(&[("one", &[])]);
        // A store error (the row no longer exists) on the early-return path.
        let missing = kalcode_contracts::ids::new_id();
        assert!(
            squad
                .state
                .squad_dispatch
                .enqueue(&missing, SquadDispatchKind::Run)
                .expect("enqueue")
        );
        let (job, canceled) = squad.state.squad_dispatch.take().expect("take");
        let reservation = reservation_for(&squad.state, &job, &canceled);
        squad
            .state
            .run_dispatch_job(&job, &reservation, &test_leases());
        assert!(!squad.state.squad_dispatch.is_reserved(&missing));

        // A panic inside the provider factory is contained and the member is held.
        let id = squad.id("one");
        squad.launch_consent("one");
        squad
            .panes
            .panic_on
            .lock()
            .expect("panic set")
            .insert(id.clone());
        let (job, reservation) = squad.take_job("one", SquadDispatchKind::Run);
        squad
            .state
            .run_dispatch_job(&job, &reservation, &test_leases());
        assert!(!squad.state.squad_dispatch.is_reserved(&id));
        let one = squad.row("one");
        assert_eq!(one.status, OperationStatus::Paused);
        assert!(
            one.attention_reason
                .as_deref()
                .is_some_and(|reason| reason.contains("stopped unexpectedly"))
        );
        assert!(squad.state.gate.lock().is_ok(), "the gate stays usable");
        squad.shutdown();
    }

    #[test]
    fn a_panic_after_the_task_was_sent_never_sends_it_again() {
        let squad = SquadHarness::new(&[("sent", &[]), ("unsent", &[])]);
        for key in ["sent", "unsent"] {
            squad.prepare_waiting(key);
            let id = squad.id(key);
            squad
                .state
                .store
                .claim_user_squad_agent(&id)
                .expect("claim")
                .expect("claimable");
            squad
                .state
                .store
                .reserve_agent_thread(&id, None, None)
                .expect("reserve pane");
        }
        // The pane received "sent"'s task (the runtime persists it before the provider write),
        // then the dispatcher panicked before bind.
        let sent = squad.id("sent");
        squad
            .core
            .emit(kalcode_contracts::events::NewEvent {
                source: kalcode_contracts::events::EventSource::Ui,
                correlation: kalcode_contracts::events::Correlation {
                    workspace_id: Some(squad.workspace_id.clone()),
                    thread_id: Some(sent.clone()),
                    ..Default::default()
                },
                event: EventPayload::AgentMessage {
                    thread_id: sent.clone(),
                    message_id: kalcode_contracts::ids::new_id(),
                    role: kalcode_contracts::threads::MessageRole::User,
                },
            })
            .expect("delivered task evidence");
        squad.state.hold_panicked_dispatch(&sent);
        squad.state.hold_panicked_dispatch(&squad.id("unsent"));

        let row = squad.row("sent");
        assert_eq!(
            row.status,
            OperationStatus::Interrupted,
            "never re-preparable"
        );
        assert!(row.attention_reason.is_none());
        let error = squad
            .state
            .run_now_command(&AllowAll, &TestLease, &sent)
            .expect_err("Run now refuses a member that may hold its task");
        assert_eq!(error.code, "operation_not_pending");
        assert!(
            !squad.panes.rearmed.lock().expect("rearmed").contains(&sent),
            "its pane is never re-armed"
        );
        assert_eq!(squad.row("sent").status, OperationStatus::Interrupted);

        // Without delivery evidence the member provably never got its task: it stays held.
        let unsent = squad.row("unsent");
        assert_eq!(unsent.status, OperationStatus::Paused);
        assert!(
            unsent
                .attention_reason
                .as_deref()
                .is_some_and(|reason| reason.contains("stopped unexpectedly"))
        );
        squad.shutdown();
    }

    #[test]
    fn squad_fanout_spawns_outside_the_operations_gate() {
        let squad = SquadHarness::new(&[("one", &[]), ("two", &[]), ("three", &[])]);
        let mut build = observed_spec(
            "Unrelated build".into(),
            squad.workspace_id.clone(),
            OperationKind::Build,
        );
        build.command = Some("echo build".into());
        let build = squad.state.store.enqueue(build).expect("enqueue build");
        squad.panes.block_spawns();
        squad
            .state
            .start_squad_workers(test_leases())
            .expect("workers");
        let ids = ["one", "two", "three"].map(|key| squad.id(key));
        squad
            .state
            .queue_squad_authorizations(&ids)
            .expect("authorize Squad");
        assert!(
            squad.panes.wait_spawning(3),
            "every member reaches its provider spawn in parallel"
        );

        // (a) The global gate is free while every member is mid-spawn.
        let state = squad.state.clone();
        let build_id = build.id.clone();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = done_tx.send(state.hold_command(&build_id, true));
        });
        done_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("another Operations command completes during the spawns")
            .expect("hold succeeds");
        assert_eq!(
            squad.state.store.get(&build.id).expect("build").status,
            OperationStatus::Paused
        );

        // (c) Run now during a spawn is a clear refusal, not a silent drop.
        let error = squad
            .state
            .run_now_command(&AllowAll, &TestLease, &squad.id("two"))
            .expect_err("Run now mid-spawn");
        assert_eq!(error.code, "operation_dispatch_in_progress");

        // (b) Cancel during a spawn returns at once, then stops that member's pane.
        squad
            .state
            .cancel_command(&squad.id("one"))
            .expect("cancel mid-spawn");
        squad.panes.release(&squad.id("one"));
        squad.wait_released("one");
        assert_eq!(squad.row("one").status, OperationStatus::Cancelled);
        let pane = squad.thread("one");
        assert_eq!(
            pane.status,
            ThreadStatus::Interrupted,
            "the started pane is stopped"
        );
        assert!(
            pane.archived_at.is_none(),
            "its prompt may have been delivered, so it is kept for evidence"
        );

        squad.panes.release_all();
        for key in ["two", "three"] {
            squad.wait_released(key);
            let row = squad.row(key);
            assert_eq!(row.status, OperationStatus::Running, "{key}");
            assert_eq!(row.thread_id.as_deref(), Some(row.id.as_str()), "{key}");
        }
        squad.shutdown();
    }

    fn fixture(
        core: Arc<Core>,
        data: &Path,
    ) -> (
        OperationsState,
        Arc<crate::resource_commands::ResourceGovernorState>,
    ) {
        // A synthetic healthy machine: these tests are about operations, and a real sampler can
        // outlast the governor's 2 s shutdown bound on a loaded gate machine.
        let resources = crate::resource_commands::tests::healthy_governor();
        let detection = Arc::new(kalcode_providers::ProviderRegistry::with_specs(
            kalcode_providers::DetectEnv {
                vars: Vec::new(),
                windows: cfg!(windows),
                probe_timeout: None,
                system_root: Some(data.to_path_buf()),
            },
            Vec::new(),
        ));
        let threads = Arc::new(ThreadsState::start(
            None,
            detection,
            None,
            &crate::thread_commands::ThreadModes::default(),
            None,
            crate::provider_pane_commands::PaneRoutes::default(),
            None,
            resources.clone(),
        ));
        (
            OperationsState {
                store: OperationsStore::new(core.clone()),
                core,
                threads,
                git: Arc::new(GitCore::new(data)),
                account: None,
                gate: Mutex::new(()),
                authorized: Mutex::new(HashMap::new()),
                squad_dispatch: Arc::new(SquadDispatchQueue::default()),
                squad_workers: Mutex::new(Vec::new()),
                panes: Arc::new(ThreadPanes),
                stop: Arc::new((Mutex::new(false), Condvar::new())),
                worker: Mutex::new(None),
                observations: Mutex::new(None),
                commits: Mutex::new(None),
                artifact_checked: Mutex::new(HashSet::new()),
                voice_callback: None,
            },
            resources,
        )
    }

    fn fixture_with_thread_runtime(
        core: Arc<Core>,
        data: &Path,
    ) -> (
        OperationsState,
        Arc<crate::resource_commands::ResourceGovernorState>,
    ) {
        // A synthetic healthy machine: these tests are about operations, and a real sampler can
        // outlast the governor's 2 s shutdown bound on a loaded gate machine.
        let resources = crate::resource_commands::tests::healthy_governor();
        let detection = Arc::new(kalcode_providers::ProviderRegistry::with_specs(
            kalcode_providers::DetectEnv {
                vars: Vec::new(),
                windows: cfg!(windows),
                probe_timeout: None,
                system_root: Some(data.to_path_buf()),
            },
            Vec::new(),
        ));
        let permissions = crate::permission_commands::PermissionState::unwired(Some(core.clone()));
        let modes = crate::thread_commands::ThreadModes::default();
        let threads = Arc::new(ThreadsState::start(
            Some(&core),
            detection,
            permissions.service(),
            &modes,
            None,
            crate::provider_pane_commands::PaneRoutes::default(),
            None,
            resources.clone(),
        ));
        (
            OperationsState {
                store: OperationsStore::new(core.clone()),
                core,
                threads,
                git: Arc::new(GitCore::new(data)),
                account: None,
                gate: Mutex::new(()),
                authorized: Mutex::new(HashMap::new()),
                squad_dispatch: Arc::new(SquadDispatchQueue::default()),
                squad_workers: Mutex::new(Vec::new()),
                panes: Arc::new(ThreadPanes),
                stop: Arc::new((Mutex::new(false), Condvar::new())),
                worker: Mutex::new(None),
                observations: Mutex::new(None),
                commits: Mutex::new(None),
                artifact_checked: Mutex::new(HashSet::new()),
                voice_callback: None,
            },
            resources,
        )
    }

    #[test]
    fn consent_expires_and_cannot_be_reused_for_a_changed_task() {
        let mut spec = observed_spec("Build".into(), "workspace".into(), OperationKind::Build);
        spec.command = Some("echo approved".into());
        let consent = Authorization {
            spec: spec.clone(),
            revision: (Some("main".into()), Some("commit".into())),
            expires: Some(Instant::now() + Duration::from_secs(10)),
            origin: LaunchOrigin::Background,
            revision_bound: true,
        };
        assert!(consent.matches(&spec));
        spec.command = Some("echo different".into());
        assert!(!consent.matches(&spec));
        let expired = Authorization {
            expires: Some(Instant::now() - Duration::from_secs(1)),
            ..consent.clone()
        };
        assert!(!expired.matches(&consent.spec));
        let mut changed = consent.spec.clone();
        changed.provider_account_id = Some("different account".into());
        assert!(!consent.matches(&changed));
    }

    #[test]
    fn prepared_provider_refusal_consumes_authorization_and_becomes_attention_hold() {
        let data = tempfile::tempdir().expect("data");
        let project = tempfile::tempdir().expect("project");
        let core = Arc::new(
            Core::open(CoreConfig {
                paths: Paths::new(data.path()),
                app_version: "0.0.0-test".into(),
                channel: BuildChannel::Development,
            })
            .expect("core"),
        );
        let workspace = core.open_workspace(project.path()).expect("workspace");
        let (state, resources) = fixture(core.clone(), data.path());
        let mut spec = observed_spec(
            "Prepared reviewer".into(),
            workspace.id,
            OperationKind::Agent,
        );
        spec.prompt = Some("Review the dependency output".into());
        spec.provider_id = Some("codex".into());
        let queued = state.store.enqueue(spec.clone()).expect("enqueue");
        let starting = state
            .store
            .claim(Some(&queued.id))
            .expect("claim")
            .expect("starting operation");
        state.authorized.lock().expect("authorization lock").insert(
            starting.id.clone(),
            Authorization {
                spec,
                revision: (None, None),
                expires: None,
                origin: LaunchOrigin::User,
                revision_bound: false,
            },
        );

        assert!(
            state
                .take_authorization(&starting.id)
                .expect("consume authorization")
                .is_some()
        );
        state
            .handle_launch_error(
                &starting,
                KalError::validation(
                    "operation_prepared_provider_not_ready",
                    "Codex is showing a native permission prompt. Answer it, then run this member again.",
                ),
            )
            .expect("attention hold");

        assert!(
            state
                .take_authorization(&starting.id)
                .expect("authorization remains consumed")
                .is_none(),
            "a held prepared member must require a fresh explicit Run authorization"
        );
        let held = state.store.get(&starting.id).expect("held operation");
        assert_eq!(held.status, OperationStatus::Paused);
        assert_eq!(
            held.attention_reason.as_deref(),
            Some(
                "Codex is showing a native permission prompt. Answer it, then run this member again."
            )
        );
        assert!(resources.shutdown_checked());
        core.shutdown();
    }

    #[test]
    fn prepared_squad_revision_policy_survives_root_head_advance() {
        let data = tempfile::tempdir().expect("data");
        let project = tempfile::tempdir().expect("project");
        let git = |args: &[&str]| {
            let output = std::process::Command::new("git")
                .arg("-C")
                .arg(project.path())
                .args(args)
                .output()
                .expect("spawn git");
            assert!(
                output.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.name", "Test User"]);
        git(&["config", "user.email", "test@example.invalid"]);
        git(&["config", "commit.gpgSign", "false"]);
        std::fs::write(project.path().join("README.md"), "one\n").expect("readme");
        git(&["add", "README.md"]);
        git(&["commit", "-q", "--no-verify", "-m", "one"]);

        let core = Arc::new(
            Core::open(CoreConfig {
                paths: Paths::new(data.path()),
                app_version: "0.0.0-test".into(),
                channel: BuildChannel::Development,
            })
            .expect("core"),
        );
        let workspace = core.open_workspace(project.path()).expect("workspace");
        let account_id = kalcode_contracts::ids::new_id();
        core.transact(|tx| {
            tx.execute(
                "INSERT INTO provider_accounts (
                   id, provider_id, display_name, authentication_state, is_default, created_at
                 ) VALUES (?1, 'codex', 'Codex test', 'authenticated', 0,
                   '2026-10-05T12:00:00.000Z')",
                [&account_id],
            )?;
            Ok(((), Vec::new()))
        })
        .expect("provider account");
        let members = [("isolated", true), ("shared", false)]
            .into_iter()
            .map(|(key, worktree)| SquadMemberDefinition {
                key: key.into(),
                name: format!("{key} member"),
                provider_id: "codex".into(),
                provider_account_id: account_id.clone(),
                model: "gpt-test".into(),
                effort: "high".into(),
                role: "implementation".into(),
                task: Some(format!("Implement {key}.")),
                worktree,
                depends_on: Vec::new(),
                manager_key: None,
                owned_paths: vec![format!("{key}/")],
            })
            .collect();
        let squads = SquadsStore::new(core.clone());
        let saved = squads
            .save_squad(SquadDefinition {
                id: kalcode_contracts::ids::new_id(),
                name: "Revision crew".into(),
                goal: "Verify revision recovery".into(),
                members,
            })
            .expect("save squad");
        let launch = squads
            .launch(
                "revision-policy-request",
                &saved.id,
                &workspace.id,
                None,
                None,
            )
            .expect("launch squad");
        let (state, resources) = fixture(core.clone(), data.path());
        let initial = state.revision(&workspace.id).expect("initial revision");
        for launched in &launch.members {
            let member = squads
                .get_member(&launched.operation_id)
                .expect("member lookup")
                .expect("member relation");
            let branch = member
                .worktree
                .then(|| {
                    crate::thread_commands::operation_branch_name(
                        Some("isolated member"),
                        &launched.operation_id,
                    )
                })
                .or_else(|| initial.0.clone());
            state
                .store
                .prepare_agent_thread(
                    &launched.operation_id,
                    branch.as_deref(),
                    initial.1.as_deref(),
                )
                .expect("prepare member");
        }

        std::fs::write(project.path().join("README.md"), "two\n").expect("advance readme");
        git(&["add", "README.md"]);
        git(&["commit", "-q", "--no-verify", "-m", "two"]);
        let advanced = state.revision(&workspace.id).expect("advanced revision");
        assert_ne!(advanced.1, initial.1);
        for launched in &launch.members {
            let row = state.store.get(&launched.operation_id).expect("operation");
            let member = squads
                .get_member(&launched.operation_id)
                .expect("member lookup")
                .expect("member relation");
            let authorized = state
                .authorization_revision(&row)
                .expect("authorization revision");
            if member.worktree {
                assert_eq!(authorized.1, initial.1, "isolated base stays exact");
                assert_eq!(authorized.0, row.branch);
            } else {
                assert_eq!(authorized, advanced, "shared pane follows the root");
            }
        }
        assert!(resources.shutdown_checked());
    }

    #[test]
    fn squad_authorization_accepts_bounded_tasks_larger_than_confirmation_copy() {
        let task = "x".repeat(64 * 1024);
        validate_authorization_content(&task, true).expect("64 KiB squad task");
        assert_eq!(
            validate_authorization_content(&task, false)
                .expect_err("ordinary tasks keep main's 8 KiB cap")
                .code,
            "operations_sensitive_input"
        );
        validate_authorization_content(&"x".repeat(8192), false).expect("8 KiB ordinary task");
        let secret = format!("token={}", "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8");
        assert_eq!(
            validate_authorization_content(&secret, true)
                .expect_err("secret-shaped task")
                .code,
            "operations_sensitive_input"
        );
    }

    #[test]
    fn agent_message_logs_apply_the_full_secret_scanner() {
        let secret = ["J8kQ", "2mZp", "7RxV", "4LcN", "9TdW", "6HsA"].join("");
        let message = format!("provider result value: {secret}");

        assert_eq!(
            safe(&message),
            message,
            "generic entropy is intentionally outside the structured-log scanner"
        );
        let redacted = full_safe(&message);
        assert!(!redacted.contains(&secret));
        assert!(redacted.contains("[REDACTED:high_entropy_string]"));
    }

    #[test]
    fn voice_callback_runs_only_after_a_final_operation_write_commits() {
        let data = tempfile::tempdir().expect("data");
        let project = tempfile::tempdir().expect("project");
        let core = Arc::new(
            Core::open(CoreConfig {
                paths: Paths::new(data.path()),
                app_version: "0.1.8-test".into(),
                channel: BuildChannel::Development,
            })
            .expect("core"),
        );
        let workspace = core.open_workspace(project.path()).expect("workspace");
        let (mut state, resources) = fixture(core.clone(), data.path());
        let callbacks = Arc::new(Mutex::new(Vec::<OperationCallback>::new()));
        let recorded = callbacks.clone();
        state.voice_callback = Some(Arc::new(move |callback| {
            recorded.lock().expect("callback lock").push(callback);
        }));

        assert!(
            state
                .finish_run(
                    "missing-operation",
                    OperationStatus::Succeeded,
                    "not written"
                )
                .is_err()
        );
        assert!(callbacks.lock().expect("callback lock").is_empty());

        let mut spec = observed_spec(
            "Production deploy".into(),
            workspace.id.clone(),
            OperationKind::Deploy,
        );
        spec.command = Some("deploy".into());
        let operation = state.store.enqueue(spec).expect("enqueue");
        assert!(
            state
                .finish_run(&operation.id, OperationStatus::Succeeded, "premature")
                .is_err(),
            "a queued partial run cannot report success"
        );
        assert!(callbacks.lock().expect("callback lock").is_empty());

        state
            .store
            .claim(Some(&operation.id))
            .expect("claim")
            .expect("available");
        state
            .finish_run(&operation.id, OperationStatus::Failed, "deploy failed")
            .expect("durable failure");
        let callbacks = callbacks.lock().expect("callback lock");
        assert_eq!(callbacks.len(), 1);
        assert_eq!(callbacks[0].status, OperationStatus::Failed);
        assert_eq!(callbacks[0].name, "Production deploy");

        assert!(state.shutdown_checked());
        assert!(resources.shutdown_checked());
        core.shutdown();
    }

    #[test]
    fn snapshot_activity_contains_the_owned_queue_start_run_and_finish_moments() {
        let data = tempfile::tempdir().expect("data");
        let project = tempfile::tempdir().expect("project");
        let core = Arc::new(
            Core::open(CoreConfig {
                paths: Paths::new(data.path()),
                app_version: "0.1.7-test".into(),
                channel: BuildChannel::Development,
            })
            .expect("core"),
        );
        let workspace = core.open_workspace(project.path()).expect("workspace");
        let (state, resources) = fixture(core.clone(), data.path());
        let mut spec = observed_spec(
            "Activity lifecycle".into(),
            workspace.id.clone(),
            OperationKind::Build,
        );
        spec.command = Some("cargo check".into());
        let operation = state.store.enqueue(spec).expect("enqueue");
        state
            .store
            .claim(Some(&operation.id))
            .expect("claim")
            .expect("available");
        state
            .store
            .bind(&operation.id, Some(&operation.id), None, None, None)
            .expect("bind");
        state
            .store
            .finish(
                &operation.id,
                OperationStatus::Succeeded,
                "Lifecycle complete.",
            )
            .expect("finish");

        let snapshot = state.snapshot().expect("snapshot");
        let lifecycle = snapshot
            .activity
            .iter()
            .filter(|item| item.run_id.as_deref() == Some(operation.id.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(lifecycle.len(), 4);
        assert!(
            lifecycle
                .iter()
                .all(|item| { item.workspace_id.as_deref() == Some(workspace.id.as_str()) })
        );
        assert_eq!(
            lifecycle
                .iter()
                .map(|item| item.kind.as_str())
                .collect::<std::collections::BTreeSet<_>>(),
            std::collections::BTreeSet::from(["queued", "running", "starting", "succeeded"])
        );

        assert!(state.shutdown_checked());
        assert!(resources.shutdown_checked());
        core.shutdown();
    }

    fn history_record(id: &str, source: &str, created_at: &str) -> OperationRecord {
        OperationRecord {
            id: id.into(),
            spec: observed_spec(id.into(), "workspace".into(), OperationKind::Script),
            source: source.into(),
            status: OperationStatus::Succeeded,
            workspace_name: "Workspace".into(),
            branch: None,
            version: None,
            account_label: None,
            terminal_id: None,
            thread_id: None,
            created_at: created_at.into(),
            started_at: Some(created_at.into()),
            ended_at: Some(created_at.into()),
            current_action: None,
            attention_reason: None,
            outcome: None,
            position: 0,
            blockers: Vec::new(),
        }
    }

    fn history_row(
        authority: HistoryAuthority,
        cursor: &str,
        record: OperationRecord,
    ) -> HistoryRow {
        HistoryRow {
            authority,
            cursor: cursor.into(),
            created_at: record.created_at.clone(),
            id: record.id.clone(),
            record: Some(record),
        }
    }

    #[test]
    fn unified_history_cursor_is_versioned_bounded_and_rejects_unknown_shapes() {
        let cursor = HistoryCursor {
            version: 1,
            operations: Some("operation".into()),
            agent_turns: Some("turn".into()),
            tools: Some("tool".into()),
            shells: Some("shell".into()),
            background: Some("background".into()),
        };
        let encoded = encoded_history_cursor(&cursor).expect("encode cursor");
        assert!(encoded.len() <= HISTORY_CURSOR_LIMIT);
        assert_eq!(
            history_cursor(Some(&encoded)).expect("decode cursor"),
            cursor
        );

        let unknown = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(br#"{"version":1,"unknown":"field"}"#);
        assert_eq!(
            history_cursor(Some(&unknown))
                .expect_err("unknown fields fail closed")
                .code,
            "invalid_operations_history_cursor"
        );
        assert_eq!(
            history_cursor(Some(&"x".repeat(HISTORY_CURSOR_LIMIT + 1)))
                .expect_err("oversized cursor")
                .code,
            "invalid_operations_history_cursor"
        );
    }

    #[test]
    fn unified_history_has_stable_equal_timestamp_order_and_advances_duplicates() {
        let at = "2026-09-30T12:00:00.000Z";
        let page = merge_history(
            HistoryCursor {
                version: 1,
                ..HistoryCursor::default()
            },
            vec![
                HistoryBatch {
                    rows: vec![
                        history_row(
                            HistoryAuthority::Tools,
                            "tool-z",
                            history_record("shared", "tool", at),
                        ),
                        history_row(
                            HistoryAuthority::Tools,
                            "tool-y",
                            history_record("tool-y", "tool", at),
                        ),
                    ],
                    has_more: false,
                },
                HistoryBatch {
                    rows: vec![
                        history_row(
                            HistoryAuthority::Operations,
                            "operation-z",
                            history_record("shared", "operations", at),
                        ),
                        history_row(
                            HistoryAuthority::Operations,
                            "operation-a",
                            history_record("operation-a", "operations", at),
                        ),
                    ],
                    has_more: false,
                },
            ],
        )
        .expect("merge history");
        assert_eq!(
            page.items
                .iter()
                .map(|row| row.id.as_str())
                .collect::<Vec<_>>(),
            ["shared", "operation-a", "tool-y"]
        );
        assert_eq!(page.items[0].source, "operations");
        assert_eq!(page.next_cursor, None);
    }

    #[test]
    fn unified_history_pages_beyond_the_overview_limit_without_skips() {
        let rows = (0..125)
            .rev()
            .map(|index| {
                let cursor = format!("message-{index:03}");
                history_row(
                    HistoryAuthority::AgentTurns,
                    &cursor,
                    history_record(
                        &format!("turn:message-{index:03}"),
                        "thread",
                        &format!("2026-09-30T12:{:02}:00Z", index / 60),
                    ),
                )
            })
            .collect::<Vec<_>>();
        let first = merge_history(
            HistoryCursor {
                version: 1,
                ..HistoryCursor::default()
            },
            vec![HistoryBatch {
                rows,
                has_more: false,
            }],
        )
        .expect("first page");
        assert_eq!(first.items.len(), 100);
        let cursor = history_cursor(first.next_cursor.as_deref()).expect("page cursor");
        assert_eq!(cursor.agent_turns.as_deref(), Some("message-025"));

        let remaining = (0..25)
            .rev()
            .map(|index| {
                let cursor = format!("message-{index:03}");
                history_row(
                    HistoryAuthority::AgentTurns,
                    &cursor,
                    history_record(
                        &format!("turn:message-{index:03}"),
                        "thread",
                        "2026-09-30T11:00:00Z",
                    ),
                )
            })
            .collect();
        let second = merge_history(
            cursor,
            vec![HistoryBatch {
                rows: remaining,
                has_more: false,
            }],
        )
        .expect("second page");
        assert_eq!(second.items.len(), 25);
        assert_eq!(second.next_cursor, None);
        let ids = first
            .items
            .iter()
            .chain(&second.items)
            .map(|row| row.id.as_str())
            .collect::<HashSet<_>>();
        assert_eq!(ids.len(), 125);
    }

    #[test]
    fn canonical_history_pages_old_threads_and_tools_and_resolves_exact_details() {
        let data = tempfile::tempdir().expect("data");
        let project = tempfile::tempdir().expect("project");
        let core = Arc::new(
            Core::open(CoreConfig {
                paths: Paths::new(data.path()),
                app_version: "0.1.7-test".into(),
                channel: BuildChannel::Development,
            })
            .expect("core"),
        );
        let workspace = core.open_workspace(project.path()).expect("workspace");
        let provider = kalcode_contracts::agent::ProviderId::new("fixture");
        let (oldest_turn, oldest_tool) = core
            .write_with_events(|tx| {
                let mut oldest_turn = None;
                let mut oldest_tool = None;
                for index in 0..105 {
                    let thread_id = kalcode_contracts::ids::new_id();
                    let at = format!("2026-09-30T10:{:02}:{:02}.000Z", index / 60, index % 60);
                    kalcode_threads::store::insert_thread(
                        tx,
                        &kalcode_threads::store::NewThreadRow {
                            id: &thread_id,
                            name: "Historical task",
                            provider_id: &provider,
                            provider_name: "Fixture",
                            model: Some("fixture-model"),
                            effort: None,
                            provider_account_id: None,
                            account_label: None,
                            workspace_id: &workspace.id,
                            workspace_name: &workspace.name,
                            cwd: &workspace.root_path,
                            permission_mode: PermissionMode::Approve,
                            now: &at,
                        },
                    )?;
                    kalcode_threads::store::set_status(
                        tx,
                        &thread_id,
                        ThreadStatus::Idle,
                        None,
                        &at,
                    )?;
                    let message = kalcode_threads::store::insert_message(
                        tx,
                        &thread_id,
                        kalcode_contracts::threads::MessageRole::User,
                        "Run the historical task",
                        None,
                        &at,
                    )?;
                    oldest_turn.get_or_insert(message.id);
                    if index == 0 {
                        for tool_index in 0..25 {
                            let tool_at = format!("2026-09-30T11:00:{tool_index:02}.000Z");
                            let tool_id = kalcode_threads::store::insert_tool_call(
                                tx,
                                &thread_id,
                                &format!("provider-{tool_index}"),
                                "Bash",
                                "Run cargo test",
                                &tool_at,
                            )?;
                            kalcode_threads::store::tool_finished(
                                tx,
                                &tool_id,
                                true,
                                Some("passed"),
                                &tool_at,
                            )?;
                            oldest_tool.get_or_insert(tool_id);
                        }
                    }
                }
                Ok(((oldest_turn, oldest_tool), Vec::new()))
            })
            .expect("seed canonical history")
            .0;
        let (state, resources) = fixture_with_thread_runtime(core.clone(), data.path());

        let mut before = None;
        let mut rows = Vec::new();
        loop {
            let page = state.history(before.as_deref()).expect("history page");
            rows.extend(page.items);
            let Some(next) = page.next_cursor else { break };
            before = Some(next);
        }
        assert_eq!(
            rows.iter()
                .filter(|row| row.id.starts_with("turn:"))
                .count(),
            105
        );
        assert_eq!(
            rows.iter()
                .filter(|row| row.id.starts_with("tool:"))
                .count(),
            25
        );
        let oldest_turn = format!("turn:{}", oldest_turn.expect("turn id"));
        let oldest_tool = format!("tool:{}", oldest_tool.expect("tool id"));
        assert_eq!(
            state.detail(&oldest_turn).expect("old turn detail").run.id,
            oldest_turn
        );
        assert_eq!(
            state.detail(&oldest_tool).expect("old tool detail").run.id,
            oldest_tool
        );
        let forged = encoded_history_cursor(&HistoryCursor {
            version: 1,
            agent_turns: Some(kalcode_contracts::ids::new_id()),
            ..HistoryCursor::default()
        })
        .expect("forged composite cursor");
        assert_eq!(
            state
                .history(Some(&forged))
                .expect_err("unknown authority cursor")
                .code,
            "invalid_operations_history_cursor"
        );

        assert!(resources.shutdown_checked());
        core.shutdown();
    }

    #[test]
    fn operation_detail_stops_at_completion_and_reused_thread_turn_remains_visible() {
        let data = tempfile::tempdir().expect("data");
        let project = tempfile::tempdir().expect("project");
        let core = Arc::new(
            Core::open(CoreConfig {
                paths: Paths::new(data.path()),
                app_version: "0.1.7-test".into(),
                channel: BuildChannel::Development,
            })
            .expect("core"),
        );
        let workspace = core.open_workspace(project.path()).expect("workspace");
        let (state, resources) = fixture_with_thread_runtime(core.clone(), data.path());
        let mut spec = observed_spec(
            "Agent operation".into(),
            workspace.id.clone(),
            OperationKind::Agent,
        );
        spec.prompt = Some("First task".into());
        spec.provider_id = Some("fixture".into());
        spec.model = Some("fixture-model".into());
        let operation = state.store.enqueue(spec).expect("enqueue");
        let running = state
            .store
            .claim(Some(&operation.id))
            .expect("claim")
            .expect("running operation");
        state
            .store
            .reserve_agent_thread(&operation.id, None, None)
            .expect("reserve exact thread");
        let at = running.started_at.clone().expect("started at");
        let provider = kalcode_contracts::agent::ProviderId::new("fixture");
        let (first_message_id, first_reply_id, second_message_id, second_reply_id) = core
            .write_with_events(|tx| {
                kalcode_threads::store::insert_thread(
                    tx,
                    &kalcode_threads::store::NewThreadRow {
                        id: &operation.id,
                        name: "Agent operation",
                        provider_id: &provider,
                        provider_name: "Fixture",
                        model: Some("fixture-model"),
                        effort: None,
                        provider_account_id: None,
                        account_label: None,
                        workspace_id: &workspace.id,
                        workspace_name: &workspace.name,
                        cwd: &workspace.root_path,
                        permission_mode: PermissionMode::Approve,
                        now: &at,
                    },
                )?;
                let first = kalcode_threads::store::insert_message(
                    tx,
                    &operation.id,
                    kalcode_contracts::threads::MessageRole::User,
                    "first-turn-user",
                    None,
                    &at,
                )?;
                let first_reply = kalcode_threads::store::insert_message(
                    tx,
                    &operation.id,
                    kalcode_contracts::threads::MessageRole::Assistant,
                    "first-turn-assistant",
                    None,
                    &at,
                )?;
                let second = kalcode_threads::store::insert_message(
                    tx,
                    &operation.id,
                    kalcode_contracts::threads::MessageRole::User,
                    "second-turn-user",
                    None,
                    &at,
                )?;
                let second_reply = kalcode_threads::store::insert_message(
                    tx,
                    &operation.id,
                    kalcode_contracts::threads::MessageRole::Assistant,
                    "second-turn-assistant",
                    None,
                    &at,
                )?;
                kalcode_threads::store::set_status(
                    tx,
                    &operation.id,
                    ThreadStatus::Idle,
                    None,
                    &at,
                )?;
                Ok((
                    (first.id, first_reply.id, second.id, second_reply.id),
                    Vec::new(),
                ))
            })
            .expect("persist two same-timestamp turns")
            .0;
        let correlation = kalcode_contracts::events::Correlation {
            workspace_id: Some(workspace.id.clone()),
            thread_id: Some(operation.id.clone()),
            provider_id: Some("fixture".into()),
            ..Default::default()
        };
        let emit = |event| {
            core.emit(kalcode_contracts::events::NewEvent {
                source: kalcode_contracts::events::EventSource::Provider,
                correlation: correlation.clone(),
                event,
            })
            .expect("emit turn evidence")
        };
        emit(EventPayload::AgentMessage {
            thread_id: operation.id.clone(),
            message_id: first_message_id.clone(),
            role: kalcode_contracts::threads::MessageRole::User,
        });
        emit(EventPayload::AgentMessage {
            thread_id: operation.id.clone(),
            message_id: first_reply_id,
            role: kalcode_contracts::threads::MessageRole::Assistant,
        });
        let completion = emit(EventPayload::AgentTurnCompleted {
            thread_id: operation.id.clone(),
            ok: true,
            interrupted: false,
        });
        emit(EventPayload::AgentMessage {
            thread_id: operation.id.clone(),
            message_id: second_message_id.clone(),
            role: kalcode_contracts::threads::MessageRole::User,
        });
        emit(EventPayload::AgentMessage {
            thread_id: operation.id.clone(),
            message_id: second_reply_id,
            role: kalcode_contracts::threads::MessageRole::Assistant,
        });
        state
            .store
            .bind(&operation.id, None, Some(&operation.id), None, None)
            .expect("bind operation thread");
        state.reconcile().expect("reconcile completion");

        let persisted = state.store.get(&operation.id).expect("operation");
        assert_eq!(persisted.status, OperationStatus::Succeeded);
        state
            .threads
            .runtime_handle()
            .expect("runtime")
            .rename(&operation.id, "Billing Webhooks")
            .expect("manual name");
        assert_eq!(
            state.store.get(&operation.id).unwrap().spec.name,
            "Agent operation",
            "display naming must not rewrite execution or authorization inputs"
        );
        let (_, _, projected) = state.rows(&[]).expect("snapshot rows");
        assert_eq!(
            projected
                .iter()
                .find(|row| row.id == operation.id)
                .unwrap()
                .spec
                .name,
            "Billing Webhooks"
        );
        assert_eq!(
            persisted.ended_at.as_deref(),
            Some(completion.occurred_at.as_str())
        );
        let detail = state.detail(&operation.id).expect("operation detail");
        assert_eq!(detail.run.spec.name, "Billing Webhooks");
        let logs = detail.logs.expect("first-turn logs");
        assert!(logs.contains("first-turn-user"));
        assert!(logs.contains("first-turn-assistant"));
        assert!(!logs.contains("second-turn-user"));
        assert!(!logs.contains("second-turn-assistant"));

        let history = state.history(None).expect("unified history");
        assert_eq!(
            history
                .items
                .iter()
                .find(|row| row.id == operation.id)
                .unwrap()
                .spec
                .name,
            "Billing Webhooks"
        );
        assert_eq!(
            history
                .items
                .iter()
                .filter(|row| row.id == operation.id)
                .count(),
            1
        );
        assert!(
            history
                .items
                .iter()
                .all(|row| row.id != format!("turn:{first_message_id}")),
            "the Operations-owned first turn must not be duplicated"
        );
        let second_id = format!("turn:{second_message_id}");
        assert_eq!(
            history
                .items
                .iter()
                .filter(|row| row.id == second_id)
                .count(),
            1
        );
        let second_detail = state.detail(&second_id).expect("second turn detail");
        assert_eq!(second_detail.run.status, OperationStatus::Unknown);
        assert!(second_detail.related_services.is_empty());
        assert!(second_detail.related_deployments.is_empty());
        assert!(
            second_detail
                .logs
                .as_deref()
                .is_some_and(|logs| logs.contains("second-turn-user"))
        );

        assert!(resources.shutdown_checked());
        core.shutdown();
    }

    #[test]
    fn operation_detail_retains_historical_service_after_a_successor_takes_ownership() {
        let data = tempfile::tempdir().expect("data");
        let project = tempfile::tempdir().expect("project");
        let core = Arc::new(
            Core::open(CoreConfig {
                paths: Paths::new(data.path()),
                app_version: "0.1.7-test".into(),
                channel: BuildChannel::Development,
            })
            .expect("core"),
        );
        let workspace = core.open_workspace(project.path()).expect("workspace");
        let (state, resources) = fixture(core.clone(), data.path());
        let mut spec = observed_spec(
            "Frontend service".into(),
            workspace.id.clone(),
            OperationKind::Service,
        );
        spec.command = Some("pnpm dev".into());
        spec.urls = vec!["http://localhost:3000/".into()];

        let first = state.store.enqueue(spec.clone()).expect("enqueue first");
        state
            .store
            .claim(Some(&first.id))
            .expect("claim first")
            .expect("first running");
        state
            .store
            .bind(&first.id, Some(&first.id), None, None, None)
            .expect("bind first terminal");
        state
            .store
            .finish(
                &first.id,
                OperationStatus::Succeeded,
                "Service command exited.",
            )
            .expect("finish first");

        let successor = state.store.enqueue(spec).expect("enqueue successor");
        state
            .store
            .claim(Some(&successor.id))
            .expect("claim successor")
            .expect("successor running");
        state
            .store
            .bind(&successor.id, Some(&successor.id), None, None, None)
            .expect("bind successor terminal");
        let current_service = DevelopmentService {
            id: format!("{}:42:1", successor.id),
            run_id: Some(successor.id.clone()),
            name: successor.spec.name.clone(),
            status: "running".into(),
            pid: Some(42),
            process_name: "node".into(),
            uptime_seconds: Some(12),
            ports: vec![3000],
            urls: successor.spec.urls.clone(),
            workspace_id: workspace.id.clone(),
            workspace_name: workspace.name.clone(),
            terminal_id: Some(successor.id.clone()),
            can_stop: true,
            can_restart: true,
            action_reason: None,
        };
        *state.observations.lock().expect("observations") =
            Some((Instant::now(), vec![current_service.clone()], true));

        let first_detail = state.detail(&first.id).expect("first detail");
        assert_eq!(first_detail.related_services.len(), 1);
        assert!(!first_detail.related_services[0].is_current);
        assert_eq!(first_detail.related_services[0].service.status, "stopped");
        assert_eq!(first_detail.related_services[0].service.pid, None);
        assert!(first_detail.related_services[0].service.ports.is_empty());
        assert!(!first_detail.related_services[0].service.can_stop);
        assert!(!first_detail.related_services[0].service.can_restart);

        let successor_detail = state.detail(&successor.id).expect("successor detail");
        assert_eq!(successor_detail.related_services.len(), 1);
        assert!(successor_detail.related_services[0].is_current);
        assert_eq!(
            successor_detail.related_services[0].service,
            current_service
        );

        assert!(resources.shutdown_checked());
        core.shutdown();
    }

    #[test]
    fn active_agent_detail_matches_runtime_paused_and_waiting_snapshot_truth() {
        let data = tempfile::tempdir().expect("data");
        let project = tempfile::tempdir().expect("project");
        let core = Arc::new(
            Core::open(CoreConfig {
                paths: Paths::new(data.path()),
                app_version: "0.1.7-test".into(),
                channel: BuildChannel::Development,
            })
            .expect("core"),
        );
        let workspace = core.open_workspace(project.path()).expect("workspace");
        let (state, resources) = fixture_with_thread_runtime(core.clone(), data.path());
        let mut spec = observed_spec(
            "Agent operation".into(),
            workspace.id.clone(),
            OperationKind::Agent,
        );
        spec.prompt = Some("Inspect the workspace".into());
        spec.provider_id = Some("fixture".into());
        spec.model = Some("fixture-model".into());
        let operation = state.store.enqueue(spec).expect("enqueue");
        let running = state
            .store
            .claim(Some(&operation.id))
            .expect("claim")
            .expect("running operation");
        state
            .store
            .reserve_agent_thread(&operation.id, None, None)
            .expect("reserve exact thread");
        let at = running.started_at.clone().expect("started at");
        let provider = kalcode_contracts::agent::ProviderId::new("fixture");
        core.write_with_events(|tx| {
            kalcode_threads::store::insert_thread(
                tx,
                &kalcode_threads::store::NewThreadRow {
                    id: &operation.id,
                    name: "Agent operation",
                    provider_id: &provider,
                    provider_name: "Fixture",
                    model: Some("fixture-model"),
                    effort: None,
                    provider_account_id: None,
                    account_label: Some("Fixture account"),
                    workspace_id: &workspace.id,
                    workspace_name: &workspace.name,
                    cwd: &workspace.root_path,
                    permission_mode: PermissionMode::Auto,
                    now: &at,
                },
            )?;
            kalcode_threads::store::set_status(
                tx,
                &operation.id,
                ThreadStatus::Paused,
                Some("Paused by owner"),
                &at,
            )?;
            Ok(((), Vec::new()))
        })
        .expect("persist paused thread");
        state
            .store
            .bind(&operation.id, None, Some(&operation.id), None, None)
            .expect("bind operation thread");
        let current = state
            .threads
            .runtime_handle()
            .expect("runtime")
            .get(&operation.id)
            .expect("operation thread");
        assert_eq!(current.permission_mode, PermissionMode::Auto);
        let mut cursor_thread = current.clone();
        cursor_thread.provider_id = kalcode_contracts::agent::ProviderId::new("cursor");
        cursor_thread.model = Some("provider-reported-model-42".into());
        let mut cursor_spec = operation.spec.clone();
        cursor_spec.provider_id = Some("cursor".into());
        cursor_spec.model = None;
        assert!(
            operation_thread_matches(&cursor_thread, &cursor_spec, &operation.id),
            "Cursor may report the exact model chosen for a native-default launch"
        );
        cursor_spec.model = Some("explicit-model-43".into());
        assert!(
            !operation_thread_matches(&cursor_thread, &cursor_spec, &operation.id),
            "an explicit model must never silently change"
        );
        assert!(operation_thread_matches(
            &current,
            &operation.spec,
            &operation.id
        ));
        let mut legacy = current.clone();
        legacy.permission_mode = PermissionMode::Approve;
        assert!(
            operation_thread_matches(&legacy, &operation.spec, &operation.id),
            "an in-flight Approve operation from an older build remains recoverable"
        );
        legacy.permission_mode = PermissionMode::Plan;
        assert!(
            operation_thread_matches(&legacy, &operation.spec, &operation.id),
            "an explicitly restrictive operation remains recoverable"
        );
        // Owner directive 2026-10-03: Bypass is the default start, so it matches too.
        legacy.permission_mode = PermissionMode::Bypass;
        assert!(operation_thread_matches(
            &legacy,
            &operation.spec,
            &operation.id
        ));
        legacy.permission_mode = PermissionMode::Custom;
        assert!(!operation_thread_matches(
            &legacy,
            &operation.spec,
            &operation.id
        ));

        for (runtime_status, activity, expected) in [
            (
                ThreadStatus::Paused,
                "Paused by owner",
                OperationStatus::Paused,
            ),
            (
                ThreadStatus::WaitingForUser,
                "Waiting for owner input",
                OperationStatus::Blocked,
            ),
            (
                ThreadStatus::WaitingForPermission,
                "Waiting for approval",
                OperationStatus::Blocked,
            ),
        ] {
            core.write_with_events(|tx| {
                kalcode_threads::store::set_status(
                    tx,
                    &operation.id,
                    runtime_status,
                    Some(activity),
                    &kalcode_core::time::now_rfc3339(),
                )?;
                Ok(((), Vec::new()))
            })
            .expect("update thread truth");
            let snapshot = state
                .rows(&[])
                .expect("snapshot rows")
                .2
                .into_iter()
                .find(|row| row.id == operation.id)
                .expect("operation snapshot row");
            let detail = state.detail(&operation.id).expect("operation detail").run;
            assert_eq!(snapshot.status, expected);
            assert_eq!(detail.status, snapshot.status);
            assert_eq!(detail.current_action, snapshot.current_action);
            assert_eq!(detail.account_label, snapshot.account_label);
            assert_eq!(detail.spec.provider_id, snapshot.spec.provider_id);
            assert_eq!(detail.spec.model, snapshot.spec.model);
        }

        assert_eq!(
            state
                .store
                .get(&operation.id)
                .expect("canonical run")
                .status,
            OperationStatus::Running
        );
        state
            .threads
            .shutdown_checked()
            .expect("thread runtime shutdown");
        assert!(resources.shutdown_checked());
        core.shutdown();
    }

    #[test]
    fn reserved_or_removed_agent_thread_never_breaks_the_snapshot() {
        let data = tempfile::tempdir().expect("data");
        let project = tempfile::tempdir().expect("project");
        let core = Arc::new(
            Core::open(CoreConfig {
                paths: Paths::new(data.path()),
                app_version: "0.1.7-test".into(),
                channel: BuildChannel::Development,
            })
            .expect("core"),
        );
        let workspace = core.open_workspace(project.path()).expect("workspace");
        let (state, resources) = fixture_with_thread_runtime(core.clone(), data.path());
        let mut spec = observed_spec(
            "Agent operation".into(),
            workspace.id.clone(),
            OperationKind::Agent,
        );
        spec.prompt = Some("Task".into());
        spec.provider_id = Some("fixture".into());
        spec.model = Some("fixture-model".into());
        let operation = state.store.enqueue(spec).expect("enqueue");
        state
            .store
            .claim(Some(&operation.id))
            .expect("claim")
            .expect("running operation");
        // The launch reserves the thread id before the provider thread exists.
        state
            .store
            .reserve_agent_thread(&operation.id, None, None)
            .expect("reserve exact thread");

        let row = state
            .rows(&[])
            .expect("snapshot while the thread is not created yet")
            .2
            .into_iter()
            .find(|row| row.id == operation.id)
            .expect("operation row");
        assert_eq!(row.thread_id.as_deref(), Some(operation.id.as_str()));

        // Outside a launch (the scheduler holds the gate), a missing thread was removed:
        // reconciliation records that completion was not observed instead of failing the tick.
        state.reconcile().expect("reconcile a removed thread");
        assert_eq!(
            state
                .store
                .get(&operation.id)
                .expect("canonical run")
                .status,
            OperationStatus::Interrupted
        );

        state
            .threads
            .shutdown_checked()
            .expect("thread runtime shutdown");
        assert!(resources.shutdown_checked());
        core.shutdown();
    }

    #[test]
    fn old_completed_operation_detail_survives_newer_workspace_event_volume() {
        let data = tempfile::tempdir().expect("data");
        let project = tempfile::tempdir().expect("project");
        let core = Arc::new(
            Core::open(CoreConfig {
                paths: Paths::new(data.path()),
                app_version: "0.1.7-test".into(),
                channel: BuildChannel::Development,
            })
            .expect("core"),
        );
        let workspace = core.open_workspace(project.path()).expect("workspace");
        let (state, resources) = fixture(core.clone(), data.path());
        let mut spec = observed_spec(
            "Historical test".into(),
            workspace.id.clone(),
            OperationKind::Test,
        );
        spec.command = Some("cargo test".into());
        let operation = state.store.enqueue(spec).expect("enqueue");
        state
            .store
            .claim(Some(&operation.id))
            .expect("claim")
            .expect("claimed operation");
        state
            .store
            .bind(&operation.id, Some(&operation.id), None, None, None)
            .expect("bind operation terminal");

        let completion = core
            .emit(kalcode_contracts::events::NewEvent {
                source: kalcode_contracts::events::EventSource::Core,
                correlation: kalcode_contracts::events::Correlation {
                    workspace_id: Some(workspace.id.clone()),
                    task_id: Some(operation.id.clone()),
                    ..Default::default()
                },
                event: EventPayload::ShellCompleted {
                    terminal_id: operation.id.clone(),
                    exit_code: 0,
                    closed_by_user: false,
                },
            })
            .expect("emit exact completion");
        state
            .store
            .finish_at(
                &operation.id,
                OperationStatus::Succeeded,
                "Tests passed.",
                &completion.occurred_at,
            )
            .expect("finish operation");

        let newer_events = (0..5_001)
            .map(|index| kalcode_contracts::events::NewEvent {
                source: kalcode_contracts::events::EventSource::Core,
                correlation: kalcode_contracts::events::Correlation {
                    workspace_id: Some(workspace.id.clone()),
                    ..Default::default()
                },
                event: EventPayload::GitDiffChanged {
                    workspace_id: workspace.id.clone(),
                    worktree_id: None,
                    files: index,
                },
            })
            .collect::<Vec<_>>();
        core.write_with_events(|_| Ok(((), newer_events)))
            .expect("emit newer workspace events");
        core.emit(kalcode_contracts::events::NewEvent {
            source: kalcode_contracts::events::EventSource::Core,
            correlation: kalcode_contracts::events::Correlation {
                workspace_id: Some(workspace.id.clone()),
                task_id: Some(operation.id.clone()),
                ..Default::default()
            },
            event: EventPayload::OperationArtifactReported {
                path: "dist/late.zip".into(),
            },
        })
        .expect("emit late recovery artifact");

        let detail = state.detail(&operation.id).expect("historical detail");
        assert_eq!(detail.tests.len(), 1);
        assert_eq!(detail.tests[0].status, "passed");
        assert_eq!(detail.tests[0].detail, "Test command exited with code 0.");
        assert!(detail.artifacts.iter().any(|artifact| {
            artifact.location == "dist/late.zip" && artifact.kind == "reported_file"
        }));

        assert!(resources.shutdown_checked());
        core.shutdown();
    }

    #[test]
    fn fourteen_real_runs_preserve_logs_without_exhausting_terminal_tabs() {
        let data = tempfile::tempdir().expect("data");
        let project = tempfile::tempdir().expect("project");
        let core = Arc::new(
            Core::open(CoreConfig {
                paths: Paths::new(data.path()),
                app_version: "0.1.7-test".into(),
                channel: BuildChannel::Development,
            })
            .expect("core"),
        );
        let workspace = core.open_workspace(project.path()).expect("workspace");
        let (state, resources) = fixture(core.clone(), data.path());
        state.store.set_paused(false).expect("resume");
        let mut first = None;
        for index in 0..14 {
            let mut spec = observed_spec(
                format!("Run {index}"),
                workspace.id.clone(),
                OperationKind::Script,
            );
            spec.command = Some("echo operations-history-proof".into());
            let row = state.store.enqueue(spec).expect("enqueue");
            first.get_or_insert_with(|| row.id.clone());
            state
                .store
                .claim(Some(&row.id))
                .expect("claim")
                .expect("claimed");
            core.create_operation_terminal(
                &workspace.id,
                &row.id,
                "echo operations-history-proof",
                TerminalSize::new(80, 24).expect("size"),
                None,
            )
            .expect("real execution");
            state
                .store
                .bind(&row.id, Some(&row.id), None, None, None)
                .expect("bind");
            let deadline = Instant::now() + Duration::from_secs(20);
            while terminal_outcome(&core.terminal(&row.id).expect("terminal")).is_none()
                && Instant::now() < deadline
            {
                std::thread::sleep(Duration::from_millis(25));
            }
            state.reconcile().expect("reconcile");
            assert_eq!(
                state.store.get(&row.id).expect("run").status,
                OperationStatus::Succeeded
            );
            let (_, _, rows) = state.store.snapshot().expect("snapshot");
            state
                .prune_finished_terminals(&rows)
                .expect("archive terminals");
            assert!(core.terminals(&workspace.id).expect("tabs").len() <= 4);
        }
        let first = first.expect("first");
        assert!(core.terminal(&first).is_err());
        let detail = state.detail(&first).expect("archived run detail");
        assert!(
            detail
                .logs
                .expect("durable logs")
                .contains("operations-history-proof")
        );
        assert!(state.shutdown_checked());
        assert!(resources.shutdown_checked());
        core.shutdown();
    }

    #[test]
    fn exited_terminal_waits_for_its_durable_exit_code() {
        let mut terminal = TerminalInfo {
            id: kalcode_contracts::ids::new_id(),
            workspace_id: kalcode_contracts::ids::new_id(),
            shell_id: "operation:test".into(),
            title: "Test".into(),
            position: 0,
            status: TerminalStatus::Exited,
            started_at: Some(kalcode_core::time::now_rfc3339()),
            ended_at: None,
            exit_code: None,
        };
        assert_eq!(terminal_outcome(&terminal), None);
        let observed = observed_terminal(terminal.clone(), "Fixture");
        assert_eq!(observed.status, OperationStatus::Running);
        assert_eq!(observed.outcome, None);

        let shell = kalcode_core::operations::ShellRunRecord {
            start_event_id: kalcode_contracts::ids::new_id(),
            start_event_seq: 1,
            completed_event_seq: None,
            terminal_id: terminal.id.clone(),
            workspace_id: terminal.workspace_id.clone(),
            workspace_name: Some("Fixture".into()),
            shell_name: "PowerShell".into(),
            started_at: terminal.started_at.clone().expect("started"),
            completed_at: None,
            exit_code: None,
            closed_by_user: None,
            failed: None,
        };
        let canonical = observed_live_shell(&shell, &terminal);
        assert_eq!(canonical.id, format!("shell:{}", shell.start_event_id));
        assert_eq!(canonical.status, OperationStatus::Running);
        assert_eq!(canonical.terminal_id, Some(terminal.id.clone()));

        terminal.ended_at = Some(kalcode_core::time::now_rfc3339());
        terminal.exit_code = Some(0);
        assert_eq!(
            terminal_outcome(&terminal).map(|(status, _)| status),
            Some(OperationStatus::Succeeded)
        );

        terminal.status = TerminalStatus::EndedByApp;
        terminal.exit_code = None;
        assert_eq!(
            terminal_outcome(&terminal).map(|(status, _)| status),
            Some(OperationStatus::Interrupted)
        );
    }

    #[test]
    fn browser_addresses_reject_code_credentials_and_malformed_hosts() {
        for raw in [
            "javascript:alert(1)",
            "file:///tmp/key",
            "https://user:pass@example.com",
            "not a URL",
        ] {
            assert!(checked_url(raw).is_err());
        }
        assert!(checked_url("http://localhost:3000/").is_ok());
    }
    #[test]
    fn waiting_and_idle_are_never_fabricated_success() {
        assert_eq!(thread_status(ThreadStatus::Idle), OperationStatus::Paused);
        assert_eq!(
            thread_status(ThreadStatus::WaitingForPermission),
            OperationStatus::Blocked
        );
        assert_eq!(
            thread_status(ThreadStatus::Completed),
            OperationStatus::Succeeded
        );
    }
}
