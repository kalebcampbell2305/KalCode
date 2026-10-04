//! One account-bound Operations coordinator. The ledger owns queue/run identity; execution
//! remains in the existing guarded terminal and thread runtimes. Observations never confer
//! execution authority, and neither a restart nor a sign-in replays work automatically.
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use base64::Engine as _;
use kalcode_contracts::events::{
    CorrelationFilter, EventEnvelope, EventPayload, EventQuery, SeqOrder,
};
use kalcode_contracts::operations::*;
use kalcode_contracts::threads::{ThreadStatus, ThreadSummary};
use kalcode_core::confirm::{NativeConfirmation, confirm};
use kalcode_core::operations::{ACTIVITY_MOMENT_LIMIT, OperationsStore};
use kalcode_core::plans::{Limited, PlanLimit};
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
use crate::thread_commands::ThreadsState;

const OBSERVATION_TTL: Duration = Duration::from_secs(5);
const HISTORY_PAGE_SIZE: usize = 100;
const HISTORY_CURSOR_LIMIT: usize = 4096;

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
    expires: Instant,
}

impl Authorization {
    fn matches(&self, spec: &OperationSpec) -> bool {
        Instant::now() < self.expires && &self.spec == spec
    }
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
        let state = Arc::new(Self {
            core,
            store,
            threads,
            git,
            account: Some(account),
            gate: Mutex::new(()),
            authorized: Mutex::new(HashMap::new()),
            stop: Arc::new((Mutex::new(false), Condvar::new())),
            worker: Mutex::new(None),
            observations: Mutex::new(None),
            commits: Mutex::new(None),
            artifact_checked: Mutex::new(HashSet::new()),
            voice_callback,
        });
        let weak = Arc::downgrade(&state);
        let stop = state.stop.clone();
        let app = app.clone();
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
                    // Each tick borrows the same account authority as an IPC command. No detached
                    // scheduler can outlive sign-out or execute while the runtime is draining.
                    let Ok(lease) = RuntimeState::<OperationsState>::from_app(&app) else {
                        continue;
                    };
                    let Ok(_gate) = state.gate.try_lock() else {
                        continue;
                    };
                    if lease.revalidate_core().is_err() {
                        continue;
                    }
                    if let Err(error) = state.tick(&lease) {
                        tracing::warn!(event = "operations.tick_failed", code = error.code);
                        let _ = state.store.set_paused(true);
                    }
                }
            })
            .map_err(|_| {
                KalError::internal(
                    "operations_worker_unavailable",
                    "Operations could not start its scheduler.",
                )
            })?;
        *state.worker.lock().map_err(|_| poisoned())? = Some(worker);
        Ok(state)
    }

    fn plan_limit(&self, kind: Limited) -> Option<PlanLimit> {
        self.account.as_ref().map_or_else(
            || AccountSnapshot::signed_out().plan_limit(kind),
            |account| account.snapshot().plan_limit(kind),
        )
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
        drop(stopping);
        let Ok(mut worker) = self.worker.lock() else {
            return false;
        };
        if let Some(worker) = worker.take()
            && worker.join().is_err()
        {
            return false;
        }
        self.authorized.lock().map(|mut ids| ids.clear()).is_ok()
            && self.store.set_paused(true).is_ok()
    }

    fn tick(&self, lease: &RuntimeState<Self>) -> Result<()> {
        self.reconcile()?;
        let (_, paused, rows) = self.store.snapshot()?;
        self.prune_finished_terminals(&rows)?;
        if paused {
            return Ok(());
        }
        let authorized = self.authorized.lock().map_err(|_| poisoned())?.clone();
        // Store snapshot is dependency/priority ordered. Only native-confirmed Next tasks can
        // auto-start. One-use consent is consumed before launch, including failed launches.
        for row in rows {
            if row.spec.lane != OperationLane::Next
                || !authorized
                    .get(&row.id)
                    .is_some_and(|consent| consent.matches(&row.spec))
                || row.status != OperationStatus::Queued
                || !row.blockers.is_empty()
            {
                continue;
            }
            if authorized[&row.id].revision != self.revision(&row.spec.workspace_id)? {
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
                    break;
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
                Err(error) => return Err(error),
            }
        }
        Ok(())
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

    fn reconcile(&self) -> Result<()> {
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
            matches!(
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

    fn launch(&self, row: OperationRecord, lease: &RuntimeState<Self>) -> Result<()> {
        let consent = self
            .authorized
            .lock()
            .map_err(|_| poisoned())?
            .remove(&row.id);
        let revision = match self.revision(&row.spec.workspace_id) {
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
        if !consent
            .is_some_and(|consent| consent.matches(&row.spec) && consent.revision == revision)
        {
            self.finish_run(
                &row.id,
                OperationStatus::Interrupted,
                "Execution consent expired. Queue the task again.",
            )?;
            return Ok(());
        }
        let result = (|| {
            lease.revalidate_core()?;
            let (branch, version) = revision;
            if row.spec.kind == OperationKind::Agent {
                // Reserve the canonical thread identity durably before provider execution. The
                // thread runtime then inserts this exact id, so restart recovery never depends on
                // in-process state and never relaunches an uncertain task.
                self.store
                    .reserve_agent_thread(&row.id, branch.as_deref(), version.as_deref())?;
                let runtime = self.threads.runtime_handle().ok_or_else(unavailable)?;
                let thread = match self.threads.start_operation(&self.core, &row.id, &row.spec) {
                    Ok(thread) => thread,
                    Err(start_error) => match runtime.get(&row.id) {
                        Err(error) if error.code == "thread_not_found" => return Err(start_error),
                        Ok(thread) if operation_thread_matches(&thread, &row.spec, &row.id) => {
                            if runtime.stop(&row.id).is_ok() {
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
                };
                if !operation_thread_matches(&thread, &row.spec, &row.id) {
                    return Err(KalError::internal(
                        "operation_cleanup_unproven",
                        "The provider thread did not match its reserved Operations identity. Scheduling is paused; inspect the run before continuing.",
                    ));
                }
                if let Err(error) = self.store.bind(
                    &row.id,
                    None,
                    Some(&row.id),
                    branch.as_deref(),
                    version.as_deref(),
                ) {
                    if runtime.stop(&row.id).is_ok() {
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
            if error.code == "operation_cleanup_unproven" {
                let _ = self.store.set_paused(true);
                return Err(error);
            }
            self.finish_run(
                &row.id,
                OperationStatus::Failed,
                safe(&error.message).as_str(),
            )?;
        }
        *self.observations.lock().map_err(|_| poisoned())? = None;
        Ok(())
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
        let authorized = self.authorized.lock().map_err(|_| poisoned())?;
        for row in &mut rows {
            if matches!(
                row.status,
                OperationStatus::Queued | OperationStatus::Blocked | OperationStatus::Paused
            ) && !authorized
                .get(&row.id)
                .is_some_and(|consent| consent.matches(&row.spec))
            {
                row.blockers.push("Run now to authorize this task. Consent expires after 30 minutes or a workspace revision change.".into());
            }
        }
        drop(authorized);
        if let Some(runtime) = self.threads.runtime_handle() {
            let mut threads = runtime
                .list(None, true)?
                .into_iter()
                .map(|thread| (thread.id.clone(), thread))
                .collect::<HashMap<_, _>>();
            for row in rows.iter_mut().filter(|row| {
                row.source == "operations"
                    && row.thread_id.is_some()
                    && matches!(
                        row.status,
                        OperationStatus::Starting | OperationStatus::Running
                    )
            }) {
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
        let (operations, more_operations) =
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

    fn snapshot(&self) -> Result<OperationsSnapshot> {
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

    fn detail(&self, id: &str) -> Result<OperationDetail> {
        let mut after_seq = None;
        let mut before_seq = None;
        let mut stored_detail = None;
        let mut event_evidence_available = true;
        let run = if kalcode_contracts::ids::is_valid_id(id) {
            let detail = self.store.detail(id)?;
            let mut run = detail.run.clone();
            if run.source == "operations"
                && matches!(
                    run.status,
                    OperationStatus::Starting | OperationStatus::Running
                )
                && let Some(thread_id) = run.thread_id.as_deref()
                && let Some(runtime) = self.threads.runtime_handle()
            {
                let thread = runtime.get(thread_id)?;
                project_active_operation_thread(&mut run, &thread)?;
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

    fn authorize(&self, app: &AppHandle, spec: &OperationSpec) -> Result<Authorization> {
        let mut spec = kalcode_core::operations::normalize_spec(spec.clone())?;
        if spec.kind == OperationKind::Agent {
            spec = self.threads.canonicalize_operation(&self.core, &spec)?;
        }
        let spec = kalcode_core::operations::normalize_spec(spec)?;
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
        if content.len() > 8192 || safe(content) != content {
            return Err(KalError::validation(
                "operations_sensitive_input",
                "Use environment variable references instead of secret values.",
            ));
        }
        if spec
            .effort
            .as_deref()
            .is_some_and(|effort| effort != "default")
        {
            return Err(KalError::validation(
                "operations_effort_unsupported",
                "This provider uses its default effort; per-task effort is not supported.",
            ));
        }
        let revision = self.revision(&spec.workspace_id)?;
        let context = format!(
            "Environment: {:?}\nProvider: {}\nAccount: {}\nModel: {}\nEffort: provider default\nBranch: {}\nRevision: {}\nConsent expires after 30 minutes or a workspace revision change.\n\nCommand / prompt:\n{}",
            spec.environment,
            spec.provider_id.as_deref().unwrap_or("local shell"),
            spec.provider_account_id
                .as_deref()
                .unwrap_or("not applicable"),
            spec.model.as_deref().unwrap_or("not applicable"),
            revision.0.as_deref().unwrap_or("not available"),
            revision.1.as_deref().unwrap_or("not available"),
            content
        );
        confirm(
            &TauriConfirmer::new(app.clone()),
            &NativeConfirmation::operations_task(
                &spec.name,
                &workspace.name,
                &context,
                spec.environment == OperationEnvironmentKind::Production,
            ),
        )
        .map_err(|_| KalError::validation("confirmation_declined", "Nothing was authorized."))?;
        Ok(Authorization {
            spec,
            revision,
            expires: Instant::now() + Duration::from_secs(30 * 60),
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
                self.threads
                    .runtime_handle()
                    .ok_or_else(unavailable)?
                    .stop(thread)?;
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
        && thread.permission_mode.is_confirm_free_start()
}

fn project_active_operation_thread(
    row: &mut OperationRecord,
    thread: &ThreadSummary,
) -> Result<()> {
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
        let consent = s.authorize(&app, &spec)?;
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
        let _gate = s.gate.lock().map_err(|_| poisoned())?;
        let consent = s.authorize(&app, &spec)?;
        s.revalidate_core()?;
        let row = s.store.update(&id, consent.spec.clone(), revision)?;
        s.authorized
            .lock()
            .map_err(|_| poisoned())?
            .insert(row.id.clone(), consent);
        Ok(row)
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
    blocking(state, move |s| {
        let _gate = s.gate.lock().map_err(|_| poisoned())?;
        s.store.hold(&id, paused)
    })
    .await
}
#[tauri::command]
pub async fn operations_cancel(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<OperationsState>,
    id: String,
) -> std::result::Result<(), IpcError> {
    blocking(state, move |s| {
        let _gate = s.gate.lock().map_err(|_| poisoned())?;
        s.cancel(&id)
    })
    .await
}
#[tauri::command]
pub async fn operations_run_now(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<OperationsState>,
    app: AppHandle,
    id: String,
) -> std::result::Result<(), IpcError> {
    blocking(state, move |s| {
        let _gate = s.gate.lock().map_err(|_| poisoned())?;
        let row = s.store.detail(&id)?.run;
        let consent = s.authorize(&app, &row.spec)?;
        s.revalidate_core()?;
        if consent.spec != row.spec {
            let (revision, _, _) = s.store.snapshot()?;
            s.store.update(&id, consent.spec.clone(), revision)?;
        }
        s.authorized
            .lock()
            .map_err(|_| poisoned())?
            .insert(id.clone(), consent);
        let row = s.store.claim(Some(&id))?.ok_or_else(|| {
            KalError::validation(
                "operation_blocked",
                "Resume the queue and resolve this task's blockers before running it.",
            )
        })?;
        s.launch(row, s)
    })
    .await
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
            let consent = s.authorize(&app, &old.spec)?; s.revalidate_core()?;
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
    use kalcode_core::{CoreConfig, Paths, flags::BuildChannel};

    fn fixture(
        core: Arc<Core>,
        data: &Path,
    ) -> (
        OperationsState,
        Arc<crate::resource_commands::ResourceGovernorState>,
    ) {
        let resources = Arc::new(crate::resource_commands::ResourceGovernorState::start());
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
        let resources = Arc::new(crate::resource_commands::ResourceGovernorState::start());
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
            expires: Instant::now() + Duration::from_secs(10),
        };
        assert!(consent.matches(&spec));
        spec.command = Some("echo different".into());
        assert!(!consent.matches(&spec));
        let expired = Authorization {
            expires: Instant::now() - Duration::from_secs(1),
            ..consent.clone()
        };
        assert!(!expired.matches(&consent.spec));
        let mut changed = consent.spec.clone();
        changed.provider_account_id = Some("different account".into());
        assert!(!consent.matches(&changed));
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
        assert_eq!(
            persisted.ended_at.as_deref(),
            Some(completion.occurred_at.as_str())
        );
        let detail = state.detail(&operation.id).expect("operation detail");
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
