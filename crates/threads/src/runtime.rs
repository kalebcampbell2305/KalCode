//! The thread runtime: creates threads, drives provider sessions through the `AgentProvider`
//! contract, turns their normalized events into persisted state and protocol events, routes
//! actions through the `PermissionGate`, and recovers threads after a crash.
//!
//! Concurrency model (see docs/AGENT_RUNTIME.md):
//! - Each live session has its own event channel and worker thread. A provider's sink only
//!   enqueues, so providers never block on KalCode and a slow or failing provider affects only
//!   its own threads.
//! - Per-thread state lives behind one mutex (`LiveThread::state`), taken by that thread's
//!   worker and by commands on that thread. Lock order: thread state → database → (bus
//!   subscribers, which only enqueue). The database lock is never held while calling a
//!   provider, the permission gate or the workspace resolver.
//! - Approval decisions arrive as `approval.*` events on the event bus. The bus subscriber
//!   forwards them to a dispatcher thread that applies them to the owning thread.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak, mpsc};
use std::time::Instant;

use kalcode_context::{
    Firewall, FirewallPolicy, PromptAdmission, PromptGate, PromptReview, PromptTarget,
    RenderedPackage, WorkspaceRoot,
};
use kalcode_contracts::agent::{
    AgentEvent, AgentInput, AgentSession, FileChange, ModelInfo, ProviderError, ProviderId,
    SessionConfig,
};
use kalcode_contracts::events::{Correlation, EventPayload, EventSource, NewEvent};
use kalcode_contracts::ids::{is_valid_id, new_id};
use kalcode_contracts::kalvoice::ThreadScope;
use kalcode_contracts::permissions::{
    ApprovalDecision, NormalizedAction, PermissionGate, PermissionMode, PolicyEffect,
};
use kalcode_contracts::resources::{LaunchHold, LaunchHoldKind};
use kalcode_contracts::threads::{
    MessageRole, ThreadError, ThreadMessage, ThreadStatus, ThreadSummary, error_codes,
};
use kalcode_core::events::SubscriptionId;
use kalcode_core::plans::PlanLimit;
use kalcode_core::time::now_rfc3339;
use kalcode_core::{Core, ErrorCategory, KalError, Result};

use crate::naming;
use crate::registry::{ProviderEntry, ProviderRegistry, WorkspaceResolver};
use crate::store::{self, AgentTurnRecord, NewThreadRow, ThreadRow, ToolCallHistoryRecord};
use crate::types::{
    BulkOutcome, CreateIdleThread, CreateThread, ProviderOption, StatusCount, ThreadOptions,
    ThreadsStatusSummary, ToolCallRecord, WorkspaceOption,
};
use crate::validate;

/// Identifies a live-delta stream subscription.
pub type StreamId = u64;

/// Longest assistant message KalCode stores, in bytes. Longer output is truncated with a note.
const MAX_MESSAGE_BYTES: usize = 2 * 1024 * 1024;
const TRUNCATION_NOTE: &str = "\n\n[KalCode truncated this message: it exceeded 2 MB.]";
/// Resolutions for approval ids KalCode hasn't routed yet (decided before registration).
const EARLY_RESOLUTIONS_KEPT: usize = 256;

pub const RECOVERED_ACTIVITY: &str = "KalCode closed while this thread was running";
pub const STOPPED_ACTIVITY: &str = "Stopped by you";
pub const SHUTDOWN_ACTIVITY: &str = "KalCode closed";
pub const INTERRUPTED_ACTIVITY: &str = "Interrupted by you";
pub const PAUSED_ACTIVITY: &str = "Paused";
/// Activity of a thread whose idle session was ended because its account was switched.
pub const ACCOUNT_SWITCHED_ACTIVITY: &str = "Switched provider account";
const NEW_SESSION_NOTICE: &str = "Started a new provider session. The earlier conversation couldn't be restored, so the provider won't remember the messages above.";
/// Activity while the Resource Governor holds a launch or turn (a reason follows in brackets).
pub const WAITING_FOR_RESOURCES_ACTIVITY: &str = "Waiting for system resources";
/// Activity of a thread whose bounded wait for system resources ended without starting.
pub const RESOURCES_UNAVAILABLE_ACTIVITY: &str = "Not started: system resources were busy";
/// Activity of an idle thread whose last turn reported failure.
pub const LAST_TURN_FAILED_ACTIVITY: &str = "Last turn failed";
/// Activity of an idle thread whose session ended because it was archived.
pub const ARCHIVED_ACTIVITY: &str = "Archived";

type StreamSubscriber = Box<dyn Fn(&AgentEvent) -> bool + Send + Sync>;

/// The current plan's cap on coding agents running at the same time (`None`: no cap). The
/// desktop derives it from the verified account on every check, so a plan change applies to the
/// next start without restarting the runtime.
pub type AgentLimitSource = Arc<dyn Fn() -> Option<PlanLimit> + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Resolution {
    Approved(ApprovalDecision),
    Denied,
    Expired,
}

impl Resolution {
    fn decision(self) -> ApprovalDecision {
        match self {
            Self::Approved(decision) => decision,
            Self::Denied | Self::Expired => ApprovalDecision::Deny,
        }
    }
}

fn resolution_of(event: &EventPayload) -> Option<(String, Resolution)> {
    match event {
        EventPayload::ApprovalApproved {
            request_id,
            decision,
            ..
        } => Some((request_id.clone(), Resolution::Approved(*decision))),
        EventPayload::ApprovalDenied { request_id, .. } => {
            Some((request_id.clone(), Resolution::Denied))
        }
        EventPayload::ApprovalExpired { request_id, .. } => {
            Some((request_id.clone(), Resolution::Expired))
        }
        _ => None,
    }
}

/// Immutable identity of a thread, used for event correlation.
struct Ctx {
    thread_id: String,
    workspace_id: String,
    provider_id: ProviderId,
}

impl Ctx {
    fn from_row(row: &ThreadRow) -> Self {
        Self {
            thread_id: row.id.clone(),
            workspace_id: row.workspace_id.clone(),
            provider_id: row.provider_id.clone(),
        }
    }

    fn event(&self, source: EventSource, event: EventPayload) -> NewEvent {
        NewEvent {
            source,
            correlation: Correlation {
                workspace_id: Some(self.workspace_id.clone()),
                thread_id: Some(self.thread_id.clone()),
                provider_id: Some(self.provider_id.to_string()),
                ..Correlation::default()
            },
            event,
        }
    }

    fn status_changed(
        &self,
        source: EventSource,
        from: ThreadStatus,
        to: ThreadStatus,
        detail: Option<&str>,
    ) -> Vec<NewEvent> {
        if from == to {
            return Vec::new();
        }
        vec![self.event(
            source,
            EventPayload::ThreadStatusChanged {
                thread_id: self.thread_id.clone(),
                from,
                to,
                detail: detail.map(str::to_owned),
            },
        )]
    }
}

struct PendingApproval {
    provider_request_id: String,
    summary: String,
}

#[derive(Clone)]
struct ToolRef {
    id: String,
    summary: String,
    started: bool,
}

#[derive(Default)]
struct LiveState {
    /// Incremented whenever a session starts or ends; events from older sessions are ignored.
    generation: u64,
    session: Option<Arc<dyn AgentSession>>,
    cwd: String,
    /// Pending approvals by gate request id.
    pending: BTreeMap<String, PendingApproval>,
    /// Status to return to when the last pending approval is resolved.
    resume_status: Option<ThreadStatus>,
    /// Streaming assistant text by provider message id, until the message completes.
    buffers: BTreeMap<String, String>,
    /// Tool calls of the current session by provider tool-call id.
    tools: HashMap<String, ToolRef>,
    /// A launch or turn the Resource Governor is holding. While set, a waiter thread re-checks
    /// admission on the governor's cadence until it proceeds or its bounded wait ends.
    waiting: Option<Waiting>,
    /// Identifies waits: a waiter acts only while its ticket is the current wait's.
    wait_ticket: u64,
    /// The last turn reported failure (`TurnCompleted { ok: false }`); the next turn clears it.
    turn_failed: bool,
    /// The user interrupted or paused the current turn: its failed completion is not a failure.
    halted: bool,
}

/// A message on its way to the provider.
struct TurnInput {
    /// What the provider receives (the user's text, or that text plus previewed context).
    payload: String,
    /// The user's text to record in history first; `None` once it is recorded.
    record: Option<String>,
    /// Delivering the recorded text later is the same message (no ephemeral context attached),
    /// so it may be kept as the thread's undelivered message.
    redeliverable: bool,
}

impl TurnInput {
    fn new(text: String) -> Self {
        Self {
            payload: text.clone(),
            record: Some(text),
            redeliverable: true,
        }
    }

    fn recorded(text: String) -> Self {
        Self {
            payload: text,
            record: None,
            redeliverable: true,
        }
    }
}

/// What a held thread does once the governor admits it.
enum WaitFor {
    /// No session yet: start one, then deliver `input` (already recorded in history).
    Start {
        resume_session_id: Option<String>,
        input: Option<TurnInput>,
        notice: Option<&'static str>,
    },
    /// The session is up and idle: deliver this (already recorded) turn.
    Turn { input: TurnInput },
}

struct Waiting {
    ticket: u64,
    /// When the bounded wait ends (`resources_unavailable`). Re-checks never extend it.
    deadline: Instant,
    hold: LaunchHold,
    what: WaitFor,
}

/// The current wait being re-checked: its ticket, deadline and the hold last shown.
type Recheck = Option<(u64, Instant, LaunchHoldKind)>;

struct LiveThread {
    ctx: Ctx,
    state: Mutex<LiveState>,
}

impl LiveThread {
    fn lock(&self) -> MutexGuard<'_, LiveState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Fields shared by the public create paths (validated in `Inner::create`).
struct NewThread<'a> {
    provider_id: &'a str,
    provider_account_id: Option<&'a str>,
    account_label: Option<&'a str>,
    workspace_id: &'a str,
    model: Option<&'a str>,
    effort: Option<&'a str>,
    permission_mode: PermissionMode,
    name: String,
    /// Prepares the folder the session runs in instead of the workspace root (a thread's own
    /// Git worktree). Runs after every other check, just before the thread is recorded.
    cwd: Option<PrepareFolder<'a>>,
}

/// See [`NewThread::cwd`].
type PrepareFolder<'a> = Box<dyn FnOnce() -> Result<PathBuf> + 'a>;

/// The desktop's management of threads' own Git worktrees (Agent Fleet), which this crate can't
/// do itself (no Git here).
pub trait ThreadWorktrees: Send + Sync {
    /// The isolated thread's worktree folder is gone: check its branch out into a fresh managed
    /// worktree, bind that to the thread (`git_worktrees`) and return the folder the session runs
    /// in (absolute, existing). An error means the thread can't run anywhere safe.
    fn reattach(&self, thread_id: &str) -> Result<PathBuf>;
    /// The thread was archived: best effort, free its worktree folder when it holds no
    /// uncommitted work. The branch is kept, so resuming later re-attaches it.
    fn release(&self, thread_id: &str);
}

fn thread_folder_unavailable() -> KalError {
    KalError::validation(
        "thread_folder_unavailable",
        "This agent's worktree folder is gone and KalCode couldn't restore it from its branch.",
    )
}

/// Normalizes an inert provider-native effort name before it reaches persistence. Individual
/// adapters remain authoritative for which values they support.
fn normalize_effort(effort: Option<&str>) -> Result<Option<String>> {
    let Some(effort) = effort.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let effort = effort.to_ascii_lowercase();
    if effort.len() <= 32
        && effort.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
        })
    {
        Ok(Some(effort))
    } else {
        Err(KalError::validation(
            "invalid_effort",
            "That reasoning effort isn't valid.",
        ))
    }
}

/// Whether one already syntax-validated model is accepted by the provider's declared catalog.
/// Claude Code also documents full model ids and bracketed aliases that cannot be exhaustively
/// listed in the static catalog; keep that exception identical for create and reconfigure.
fn provider_accepts_model(provider_id: &ProviderId, models: &[ModelInfo], model: &str) -> bool {
    models.is_empty()
        || models.iter().any(|available| available.id == model)
        || (provider_id.as_str() == ProviderId::CLAUDE_CODE
            && model.len() <= validate::MAX_MODEL_CHARS
            && model
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._:[]-".contains(&byte))
            && (model.starts_with("claude-")
                || model.split_once('[').is_some_and(|(alias, suffix)| {
                    matches!(alias, "opus" | "sonnet" | "haiku" | "fable") && suffix.ends_with(']')
                })))
}

struct AdmittedPrompt {
    text: String,
    target: PromptTarget,
    admission: PromptAdmission,
}

/// Opaque, runtime-generation-bound admission for one existing thread prompt.
/// It can be obtained before a durable one-shot claim and consumed only by this runtime.
pub struct ThreadPromptAdmission {
    thread_id: String,
    prompt: AdmittedPrompt,
}

fn prompt_firewall() -> Firewall {
    Firewall::new(WorkspaceRoot::none(), FirewallPolicy::default())
}

fn create_prompt_target(request: &CreateThread) -> Result<PromptTarget> {
    validate::provider_id(&request.provider_id)?;
    validate::workspace_id(&request.workspace_id)?;
    if request
        .provider_account_id
        .as_deref()
        .is_some_and(|account_id| !is_valid_id(account_id))
    {
        return Err(KalError::validation(
            "invalid_provider_account",
            "That provider account reference isn't valid.",
        ));
    }
    Ok(PromptTarget {
        workspace_id: request.workspace_id.clone(),
        thread_id: None,
        provider_id: request.provider_id.clone(),
        provider_account_id: request.provider_account_id.clone(),
    })
}

fn row_prompt_target(row: &ThreadRow) -> PromptTarget {
    PromptTarget {
        workspace_id: row.workspace_id.clone(),
        thread_id: Some(row.id.clone()),
        provider_id: row.provider_id.to_string(),
        provider_account_id: row.provider_account_id.clone(),
    }
}

fn row_create_prompt_target(row: &ThreadRow) -> PromptTarget {
    PromptTarget {
        thread_id: None,
        ..row_prompt_target(row)
    }
}

enum EndReason {
    /// The provider process ended on its own.
    Exited(Option<i32>),
    /// A non-recoverable error; KalCode ends the session.
    Failed { code: String, message: String },
    /// The user (or shutdown) stopped the thread.
    Stopped { activity: &'static str },
    /// The thread was rebound to another account; its idle session under the old account ends.
    /// The thread is resumable (`completed`, not `interrupted`) and no `thread.completed`
    /// notification is published, because nothing finished.
    AccountSwitched,
    /// A held turn's bounded wait for system resources ended. Nothing failed: the thread is
    /// `interrupted` (resumable) with `resources_unavailable`, and no `thread.failed` is sent.
    ResourcesUnavailable { message: String },
}

#[derive(Default)]
struct StreamHub {
    next: AtomicU64,
    subscribers: Mutex<HashMap<String, Vec<(StreamId, StreamSubscriber)>>>,
}

impl StreamHub {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, Vec<(StreamId, StreamSubscriber)>>> {
        self.subscribers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn next_id(&self) -> StreamId {
        self.next.fetch_add(1, Ordering::Relaxed) + 1
    }

    fn add(&self, thread_id: &str, id: StreamId, subscriber: StreamSubscriber) {
        self.lock()
            .entry(thread_id.to_owned())
            .or_default()
            .push((id, subscriber));
    }

    fn remove(&self, id: StreamId) -> bool {
        let mut subscribers = self.lock();
        let mut removed = false;
        subscribers.retain(|_, list| {
            let before = list.len();
            list.retain(|(sid, _)| *sid != id);
            removed |= list.len() != before;
            !list.is_empty()
        });
        removed
    }

    fn publish(&self, thread_id: &str, event: &AgentEvent) {
        let mut subscribers = self.lock();
        if let Some(list) = subscribers.get_mut(thread_id) {
            list.retain(|(_, deliver)| deliver(event));
            if list.is_empty() {
                subscribers.remove(thread_id);
            }
        }
    }

    fn count(&self, thread_id: &str) -> usize {
        self.lock().get(thread_id).map_or(0, Vec::len)
    }
}

#[derive(Default)]
struct Routes {
    /// Gate request id → thread id, for approvals a thread is waiting on.
    by_request: HashMap<String, String>,
    /// Decisions that arrived before their request was registered.
    early: VecDeque<(String, Resolution)>,
}

struct Inner {
    core: Arc<Core>,
    providers: Arc<ProviderRegistry>,
    workspaces: Arc<dyn WorkspaceResolver>,
    gate: Arc<dyn PermissionGate>,
    prompt_gate: PromptGate,
    live: Mutex<HashMap<String, Arc<LiveThread>>>,
    routes: Mutex<Routes>,
    streams: StreamHub,
    /// Set by shutdown: no wait may start or re-check a provider launch any more.
    shutting_down: AtomicBool,
    /// Caps how many agents may run at once; unset (tests, no account) imposes none.
    agent_limit: Mutex<Option<AgentLimitSource>>,
    self_ref: Weak<Inner>,
    /// See [`ThreadRuntime::set_thread_worktrees`].
    worktrees: OnceLock<Arc<dyn ThreadWorktrees>>,
}

/// The thread runtime. One per `Core`. Every method validates its input natively and is safe to
/// call from any thread; non-UI callers use the same API as the IPC commands.
pub struct ThreadRuntime {
    inner: Arc<Inner>,
    subscription: SubscriptionId,
}

/// One exact live provider session (or resource-admission wait) selected for a consequential
/// bulk action. The generation fields stay private so callers cannot forge or retarget it.
#[derive(Debug, Clone)]
pub struct RunningThreadTarget {
    pub thread: ThreadSummary,
    generation: u64,
    waiting_ticket: Option<u64>,
}

/// Generation-bound identity of one provider session created by a launch. Callers may retain
/// this briefly for a follow-up; any stop, resume, exit, or replacement invalidates it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadLaunchInstance {
    pub thread_id: String,
    pub generation: u64,
}

impl RunningThreadTarget {
    /// Whether two fresh snapshots still name the same runtime-owned execution object.
    pub fn is_same_session(&self, other: &Self) -> bool {
        self.thread.id == other.thread.id
            && self.generation == other.generation
            && self.waiting_ticket == other.waiting_ticket
    }
}

impl Drop for ThreadRuntime {
    fn drop(&mut self) {
        self.inner.core.unsubscribe(self.subscription);
    }
}

impl ThreadRuntime {
    /// Starts the runtime: subscribes to approval decisions and recovers threads a previous
    /// process left running (they become `interrupted`, resumable).
    pub fn new(
        core: Arc<Core>,
        providers: Arc<ProviderRegistry>,
        workspaces: Arc<dyn WorkspaceResolver>,
        gate: Arc<dyn PermissionGate>,
    ) -> Result<Self> {
        let inner = Arc::new_cyclic(|weak| Inner {
            core: core.clone(),
            providers,
            workspaces,
            gate,
            prompt_gate: PromptGate::default(),
            live: Mutex::new(HashMap::new()),
            routes: Mutex::new(Routes::default()),
            streams: StreamHub::default(),
            shutting_down: AtomicBool::new(false),
            agent_limit: Mutex::new(None),
            self_ref: weak.clone(),
            worktrees: OnceLock::new(),
        });

        let (decisions, receiver) = mpsc::channel::<(String, Resolution)>();
        let weak = Arc::downgrade(&inner);
        std::thread::Builder::new()
            .name("kalcode-thread-approvals".into())
            .spawn(move || {
                for (request_id, resolution) in receiver {
                    let Some(inner) = weak.upgrade() else { break };
                    inner.on_resolution(&request_id, resolution);
                }
            })
            .map_err(|e| {
                KalError::internal(
                    "thread_runtime_start_failed",
                    "KalCode couldn't start its thread runtime.",
                )
                .with_source(e)
            })?;
        // Runs while the core holds its database lock: it only enqueues.
        let subscription = core.subscribe(move |envelope| match resolution_of(&envelope.event) {
            Some(resolution) => decisions.send(resolution).is_ok(),
            None => true,
        });

        let runtime = Self {
            inner,
            subscription,
        };
        runtime.inner.recover();
        Ok(runtime)
    }

    /// Installs the plan's cap on agents running at the same time. Every new agent session
    /// (create or resume) is refused with `too_many_agents` at the cap; running agents are never
    /// stopped.
    pub fn set_agent_limit(&self, source: AgentLimitSource) {
        *self
            .inner
            .agent_limit
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(source);
    }

    // ---- Queries ----

    pub fn list(
        &self,
        workspace_id: Option<&str>,
        include_archived: bool,
    ) -> Result<Vec<ThreadSummary>> {
        if let Some(id) = workspace_id {
            validate::workspace_id(id)?;
        }
        let rows = self
            .inner
            .core
            .read(|conn| store::list(conn, workspace_id, include_archived))?;
        let names: HashMap<String, String> = self
            .inner
            .workspaces
            .list()
            .map(|all| all.into_iter().map(|w| (w.id, w.name)).collect())
            .unwrap_or_default();
        Ok(rows
            .into_iter()
            .map(|row| {
                let name = names.get(&row.workspace_id).cloned();
                self.inner.to_summary(row, name)
            })
            .collect())
    }

    pub fn get(&self, thread_id: &str) -> Result<ThreadSummary> {
        validate::thread_id(thread_id)?;
        self.inner.summary(thread_id)
    }

    /// Captures the exact in-process generation of each newly created provider thread. A
    /// follow-up can use these opaque identities without guessing from recency or names.
    pub fn launch_instances(&self, thread_ids: &[String]) -> Result<Vec<ThreadLaunchInstance>> {
        if thread_ids.is_empty() || thread_ids.len() > 16 {
            return Err(KalError::validation(
                "launch_instances_invalid",
                "The launch session set is invalid.",
            ));
        }
        let mut seen = HashSet::new();
        thread_ids
            .iter()
            .map(|thread_id| {
                validate::thread_id(thread_id)?;
                if !seen.insert(thread_id.as_str()) {
                    return Err(KalError::validation(
                        "launch_instances_invalid",
                        "The launch session set contains a duplicate.",
                    ));
                }
                let live = self.inner.existing_live(thread_id).ok_or_else(|| {
                    KalError::validation(
                        "launch_instance_stale",
                        "One of those sessions is no longer the session KalVoice launched.",
                    )
                })?;
                let generation = live.lock().generation;
                Ok(ThreadLaunchInstance {
                    thread_id: thread_id.clone(),
                    generation,
                })
            })
            .collect()
    }

    /// Reconfigures and restarts exactly one recent launch group. Every target is generation
    /// checked, idle, unused, and locked before any provider is stopped. This deliberately does
    /// not provide a general active-session mutation API.
    pub fn reconfigure_idle_launch(
        &self,
        targets: &[ThreadLaunchInstance],
        provider_id: &ProviderId,
        model: &str,
        effort: &str,
    ) -> Result<Vec<ThreadSummary>> {
        if targets.is_empty() || targets.len() > 16 {
            return Err(KalError::validation(
                "recent_launch_missing",
                "Launch the sessions first, then change their model and effort.",
            ));
        }
        let model = validate::model(Some(model))?.ok_or_else(|| {
            KalError::validation("invalid_model", "Choose a model for those sessions.")
        })?;
        let effort = normalize_effort(Some(effort))?.ok_or_else(|| {
            KalError::validation(
                "invalid_effort",
                "Choose an effort level for those sessions.",
            )
        })?;
        let mut ordered = targets.to_vec();
        ordered.sort_by(|left, right| left.thread_id.cmp(&right.thread_id));
        if ordered
            .windows(2)
            .any(|pair| pair[0].thread_id == pair[1].thread_id)
        {
            return Err(KalError::validation(
                "recent_launch_invalid",
                "The recent launch session set is invalid.",
            ));
        }
        for target in &ordered {
            validate::thread_id(&target.thread_id)?;
        }

        let lives = ordered
            .iter()
            .map(|target| {
                self.inner
                    .existing_live(&target.thread_id)
                    .ok_or_else(recent_launch_changed)
            })
            .collect::<Result<Vec<_>>>()?;
        let mut states = lives.iter().map(|live| live.lock()).collect::<Vec<_>>();
        let rows = self.inner.core.read(|conn| {
            ordered
                .iter()
                .map(|target| {
                    let row = store::get(conn, &target.thread_id)?;
                    Ok((row, store::has_messages(conn, &target.thread_id)?))
                })
                .collect::<Result<Vec<_>>>()
        })?;
        for (((target, live), state), (row, has_messages)) in
            ordered.iter().zip(&lives).zip(&states).zip(&rows)
        {
            if live.ctx.thread_id != target.thread_id || state.generation != target.generation {
                return Err(recent_launch_changed());
            }
            if &row.provider_id != provider_id {
                return Err(KalError::validation(
                    "recent_launch_provider_mismatch",
                    "Those sessions are not all using the requested provider. Nothing was changed.",
                ));
            }
            if row.archived_at.is_some()
                || row.status != ThreadStatus::Idle
                || *has_messages
                || state.session.is_none()
                || state.waiting.is_some()
                || !state.pending.is_empty()
                || !state.buffers.is_empty()
                || !state.tools.is_empty()
            {
                return Err(KalError::validation(
                    "recent_launch_not_idle",
                    "Those sessions are no longer fresh and idle. Nothing was changed.",
                ));
            }
        }

        let entry = self
            .inner
            .providers
            .get(provider_id)
            .ok_or_else(|| provider_unavailable(provider_id.as_str()))?;
        let models = entry.provider.capabilities().models;
        if !provider_accepts_model(provider_id, &models, &model) {
            return Err(KalError::validation(
                "invalid_model",
                "That model isn't available for this provider.",
            ));
        }

        let mut reserved = 0usize;
        for state in &states {
            let Some(session) = state.session.as_ref() else {
                return Err(recent_launch_changed());
            };
            match session.reserve_if_unused() {
                Ok(true) => reserved += 1,
                Ok(false) => {
                    for state in &states[..reserved] {
                        if let Some(session) = &state.session {
                            session.cancel_unused_reservation();
                        }
                    }
                    return Err(KalError::validation(
                        "recent_launch_not_unused",
                        "One of those sessions already has typed input. Nothing was changed.",
                    ));
                }
                Err(error) => {
                    for state in &states[..reserved] {
                        if let Some(session) = &state.session {
                            session.cancel_unused_reservation();
                        }
                    }
                    return Err(KalError::new(
                        ErrorCategory::Provider,
                        "recent_launch_unavailable",
                        "KalCode couldn't reserve every session for the settings change. Nothing was changed.",
                    )
                    .retryable()
                    .with_source(error));
                }
            }
        }
        for index in 0..states.len() {
            let session = states[index]
                .session
                .as_ref()
                .ok_or_else(recent_launch_changed)?;
            if let Err(error) = session.terminate_reserved() {
                for state in &states[index + 1..] {
                    if let Some(session) = &state.session {
                        session.cancel_unused_reservation();
                    }
                }
                // Interactive termination closes input authority before killing the PTY. If
                // kill then fails, detach and restore that unusable current handle as well.
                for state in &mut states[..=index] {
                    state.session.take();
                    state.generation += 1;
                }
                let restore = rows[..=index]
                    .iter()
                    .map(|(row, _)| row.clone())
                    .collect::<Vec<_>>();
                self.mark_detached_for_restore(&restore)?;
                self.launch_detached_locked(&restore, &lives[..=index], &mut states[..=index])?;
                drop(states);
                return Err(KalError::new(
                    ErrorCategory::Provider,
                    "provider_terminate_failed",
                    "KalCode couldn't safely restart every session. It kept the existing settings and restored each affected session where possible. Open or launch a fresh group before changing its model and effort.",
                )
                .with_source(error));
            }
        }
        for state in &mut states {
            state.session.take();
            state.generation += 1;
            state.turn_failed = false;
            state.halted = false;
        }

        let now = now_rfc3339();
        let update = self.inner.core.write_with_events(|tx| {
            let mut events = Vec::new();
            for (row, _) in &rows {
                store::set_launch_configuration(tx, &row.id, &model, &effort)?;
                let from = store::set_status(
                    tx,
                    &row.id,
                    ThreadStatus::Starting,
                    Some("Applying model and effort"),
                    &now,
                )?;
                events.extend(Ctx::from_row(row).status_changed(
                    EventSource::Core,
                    from,
                    ThreadStatus::Starting,
                    Some("Applying model and effort"),
                ));
            }
            Ok(((), events))
        });
        if let Err(error) = update {
            let restore = rows.iter().map(|(row, _)| row.clone()).collect::<Vec<_>>();
            self.mark_detached_for_restore(&restore)?;
            self.launch_detached_locked(&restore, &lives, &mut states)?;
            drop(states);
            return Err(error);
        }
        let configured = rows
            .iter()
            .map(|(row, _)| self.inner.row(&row.id))
            .collect::<Result<Vec<_>>>()?;
        self.launch_detached_locked(&configured, &lives, &mut states)?;
        drop(states);
        let summaries = configured
            .iter()
            .map(|row| self.inner.summary(&row.id))
            .collect::<Result<Vec<_>>>()?;
        Ok(summaries)
    }

    fn mark_detached_for_restore(&self, rows: &[ThreadRow]) -> Result<()> {
        let now = now_rfc3339();
        self.inner
            .core
            .write_with_events(|tx| {
                let mut events = Vec::new();
                for old in rows {
                    let current = store::get(tx, &old.id)?;
                    let from = store::set_status(
                        tx,
                        &old.id,
                        ThreadStatus::Starting,
                        Some("Restoring session"),
                        &now,
                    )?;
                    events.extend(Ctx::from_row(&current).status_changed(
                        EventSource::Core,
                        from,
                        ThreadStatus::Starting,
                        Some("Restoring session"),
                    ));
                }
                Ok(((), events))
            })
            .map(|_| ())
    }

    fn launch_detached_locked(
        &self,
        rows: &[ThreadRow],
        lives: &[Arc<LiveThread>],
        states: &mut [MutexGuard<'_, LiveState>],
    ) -> Result<()> {
        for ((row, live), state) in rows.iter().zip(lives).zip(states) {
            let start = self.inner.providers.get(&row.provider_id).map_or_else(
                || Err(provider_unavailable(&row.provider_name)),
                |entry| {
                    let resume_id = entry
                        .provider
                        .capabilities()
                        .resume
                        .then(|| row.provider_session_id.clone())
                        .flatten();
                    self.inner
                        .launch(live, state, row, &entry, resume_id, None, None, None)
                },
            );
            if let Err(error) = start {
                self.inner
                    .fail_idle_thread(&Ctx::from_row(row), error.code, &error.message)?;
            }
        }
        Ok(())
    }

    /// Up to `limit` messages before `before` (a message id), oldest first. Reading the newest
    /// page marks the thread's messages as read.
    pub fn messages(
        &self,
        thread_id: &str,
        limit: u32,
        before: Option<&str>,
    ) -> Result<Vec<ThreadMessage>> {
        validate::thread_id(thread_id)?;
        let limit = validate::page_limit(limit)?;
        if let Some(before) = before
            && !kalcode_contracts::ids::is_valid_id(before)
        {
            return Err(KalError::validation(
                "invalid_cursor",
                "The message cursor is invalid.",
            ));
        }
        self.inner.core.read(|conn| {
            store::get(conn, thread_id)?;
            let page = store::messages(conn, thread_id, limit, before)?;
            if before.is_none() {
                store::mark_read(conn, thread_id)?;
            }
            Ok(page)
        })
    }

    /// The latest `limit` tool calls of a thread, oldest first.
    pub fn tool_calls(&self, thread_id: &str, limit: u32) -> Result<Vec<ToolCallRecord>> {
        validate::thread_id(thread_id)?;
        let limit = validate::page_limit(limit)?;
        self.inner.core.read(|conn| {
            store::get(conn, thread_id)?;
            store::tool_calls(conn, thread_id, limit)
        })
    }

    /// Newest-first durable user turns across open and archived threads.
    pub fn agent_turn_history(
        &self,
        workspace_id: Option<&str>,
        before_message_id: Option<&str>,
        limit: u32,
    ) -> Result<(Vec<AgentTurnRecord>, Option<String>)> {
        self.inner
            .core
            .read(|conn| store::agent_turn_history(conn, workspace_id, before_message_id, limit))
    }

    /// Exact durable user turn in the requested workspace scope.
    pub fn agent_turn(
        &self,
        message_id: &str,
        workspace_id: Option<&str>,
    ) -> Result<Option<AgentTurnRecord>> {
        self.inner
            .core
            .read(|conn| store::agent_turn(conn, message_id, workspace_id))
    }

    /// Newest-first durable tool-call history across threads.
    pub fn tool_call_history(
        &self,
        workspace_id: Option<&str>,
        thread_id: Option<&str>,
        before_tool_id: Option<&str>,
        limit: u32,
    ) -> Result<(Vec<ToolCallHistoryRecord>, Option<String>)> {
        self.inner.core.read(|conn| {
            store::tool_call_history(conn, workspace_id, thread_id, before_tool_id, limit)
        })
    }

    /// Exact durable tool call in the requested workspace scope.
    pub fn tool_call(
        &self,
        tool_id: &str,
        workspace_id: Option<&str>,
    ) -> Result<Option<ToolCallHistoryRecord>> {
        self.inner
            .core
            .read(|conn| store::tool_call(conn, tool_id, workspace_id))
    }

    /// Providers, workspaces and permission modes a new thread can use.
    pub fn options(&self) -> Result<ThreadOptions> {
        let providers = self
            .inner
            .providers
            .entries()
            .into_iter()
            .map(|entry| {
                let caps = entry.provider.capabilities();
                ProviderOption {
                    id: entry.provider.id(),
                    display_name: entry.provider.display_name().to_owned(),
                    account_label: entry.account_label.clone(),
                    models: caps.models,
                    supports_resume: caps.resume,
                    supports_interrupt: caps.interrupt,
                    host_approvals: caps.host_approvals,
                    permission_mappings: caps.permission_mappings,
                }
            })
            .collect();
        let workspaces = self
            .inner
            .workspaces
            .list()?
            .into_iter()
            .map(|w| WorkspaceOption {
                id: w.id,
                name: w.name,
            })
            .collect();
        Ok(ThreadOptions {
            providers,
            workspaces,
            permission_modes: vec![
                PermissionMode::Plan,
                PermissionMode::Approve,
                PermissionMode::Auto,
            ],
            default_permission_mode: PermissionMode::Approve,
        })
    }

    /// Every open thread with counts by status — for callers that report what threads are doing.
    pub fn status_summary(&self) -> Result<ThreadsStatusSummary> {
        let threads = self.list(None, false)?;
        let mut by_status: BTreeMap<String, StatusCount> = BTreeMap::new();
        for thread in &threads {
            by_status
                .entry(store::enum_str(thread.status))
                .or_insert(StatusCount {
                    status: thread.status,
                    count: 0,
                })
                .count += 1;
        }
        let count = |f: &dyn Fn(&ThreadSummary) -> bool| {
            u32::try_from(threads.iter().filter(|t| f(t)).count()).unwrap_or(u32::MAX)
        };
        Ok(ThreadsStatusSummary {
            total: count(&|_| true),
            working: count(&|t| t.status.is_live()),
            needs_attention: count(&|t| t.status.needs_attention()),
            pending_approvals: threads.iter().map(|t| t.pending_approvals).sum(),
            by_status: by_status.into_values().collect(),
            threads,
        })
    }

    // ---- Commands ----

    /// Creates a thread and starts its provider session with `prompt` as the first message.
    /// A provider that fails to start yields a `failed` thread (with the reason), not an error.
    pub fn create(&self, request: CreateThread) -> Result<ThreadSummary> {
        self.create_reviewed(request, None)
    }

    /// [`Self::create`] with a caller-chosen thread id (a provider pane marks its id durably
    /// before the thread exists).
    pub fn create_with_id(&self, thread_id: &str, request: CreateThread) -> Result<ThreadSummary> {
        validate::thread_id(thread_id)?;
        self.create_reviewed_with_id(request, None, Some(thread_id), None)
    }

    /// Inspects a create prompt without starting a provider or writing thread state.
    pub fn review_create_prompt(&self, request: &CreateThread) -> Result<PromptReview> {
        let prompt = validate::prompt(&request.prompt)?;
        self.inner
            .prompt_gate
            .review(&prompt_firewall(), create_prompt_target(request)?, &prompt)
            .map_err(Into::into)
    }

    /// Best-effort cancellation for an opaque prompt-review handle owned by this runtime.
    /// Unknown, expired, already-consumed, and already-cancelled handles are harmless.
    pub fn cancel_prompt_review(&self, review_id: &str) -> Result<bool> {
        self.inner.prompt_gate.cancel(review_id).map_err(Into::into)
    }

    /// Creates a thread after consuming an exact owner confirmation when the prompt warned.
    pub fn create_reviewed(
        &self,
        request: CreateThread,
        review_id: Option<&str>,
    ) -> Result<ThreadSummary> {
        self.create_reviewed_with_id(request, review_id, None, None)
    }

    /// Creates a reviewed Operations thread using the scheduler's durable operation id. The
    /// Operations ledger reserves this exact id before calling the provider, so a restart can
    /// correlate the two records without replaying work or relying on process memory.
    pub fn create_reviewed_for_operation(
        &self,
        operation_id: &str,
        request: CreateThread,
        review_id: Option<&str>,
    ) -> Result<ThreadSummary> {
        validate::thread_id(operation_id)?;
        self.create_reviewed_with_id(request, review_id, Some(operation_id), None)
    }

    /// Creates a reviewed thread with a caller-chosen id whose session runs in `cwd` (an
    /// existing absolute folder, the thread's own Git worktree) instead of the workspace root.
    /// `prepare` creates that folder and records the worktree binding (`git_worktrees`, owner =
    /// `thread_id`); it runs only after the prompt is admitted and the provider, model and
    /// workspace are validated, so a request that would fail costs no checkout. The returned
    /// summary carries the branch. Resume keeps the folder while the binding is active and the
    /// folder exists, and otherwise re-attaches it ([`ThreadWorktrees::reattach`]).
    pub fn create_reviewed_in(
        &self,
        thread_id: &str,
        request: CreateThread,
        review_id: Option<&str>,
        prepare: impl FnOnce() -> Result<PathBuf>,
    ) -> Result<ThreadSummary> {
        validate::thread_id(thread_id)?;
        self.create_reviewed_with_id(request, review_id, Some(thread_id), Some(Box::new(prepare)))
    }

    /// Lets the runtime re-attach and release threads' own worktrees. Set once; later calls are
    /// ignored. Without it, an isolated thread whose folder is gone refuses to resume.
    pub fn set_thread_worktrees(&self, worktrees: Arc<dyn ThreadWorktrees>) {
        let _ = self.inner.worktrees.set(worktrees);
    }

    fn create_reviewed_with_id(
        &self,
        request: CreateThread,
        review_id: Option<&str>,
        thread_id: Option<&str>,
        cwd: Option<PrepareFolder<'_>>,
    ) -> Result<ThreadSummary> {
        let prompt = validate::prompt(&request.prompt)?;
        let target = create_prompt_target(&request)?;
        let admission =
            self.inner
                .prompt_gate
                .admit(&prompt_firewall(), &target, &prompt, review_id)?;
        let prompt_warned = prompt_firewall().check_user_prompt(&prompt).warn;
        let name = match request.name.as_deref().filter(|n| !n.trim().is_empty()) {
            Some(name) => validate::name(name)?,
            None if prompt_warned => naming::FALLBACK_NAME.to_owned(),
            None => naming::name_from_prompt(&prompt),
        };
        self.inner.create(
            NewThread {
                provider_id: &request.provider_id,
                provider_account_id: request.provider_account_id.as_deref(),
                account_label: request.account_label.as_deref(),
                workspace_id: &request.workspace_id,
                model: request.model.as_deref(),
                effort: request.effort.as_deref(),
                permission_mode: request.permission_mode,
                name,
                cwd,
            },
            Some(AdmittedPrompt {
                text: prompt,
                target,
                admission,
            }),
            thread_id,
        )
    }

    /// Creates a thread whose session starts without a task; it waits (`idle`) for input. Coding
    /// agents (provider panes) start this way, so an untitled one is a "New agent".
    pub fn create_idle(&self, request: CreateIdleThread) -> Result<ThreadSummary> {
        self.create_idle_inner(request, None)
    }

    /// [`Self::create_idle`] with a caller-chosen thread id (a provider pane marks its id
    /// durably before the thread exists).
    pub fn create_idle_with_id(
        &self,
        thread_id: &str,
        request: CreateIdleThread,
    ) -> Result<ThreadSummary> {
        validate::thread_id(thread_id)?;
        self.create_idle_inner(request, Some(thread_id))
    }

    fn create_idle_inner(
        &self,
        request: CreateIdleThread,
        thread_id: Option<&str>,
    ) -> Result<ThreadSummary> {
        let name = match request.name.as_deref().filter(|n| !n.trim().is_empty()) {
            Some(name) => validate::name(name)?,
            None => naming::AGENT_FALLBACK_NAME.to_owned(),
        };
        self.inner.create(
            NewThread {
                provider_id: &request.provider_id,
                provider_account_id: request.provider_account_id.as_deref(),
                account_label: request.account_label.as_deref(),
                workspace_id: &request.workspace_id,
                model: request.model.as_deref(),
                effort: request.effort.as_deref(),
                permission_mode: request.permission_mode,
                name,
                cwd: None,
            },
            None,
            thread_id,
        )
    }

    /// Creates `count` (1-16) task-less threads with the same provider and workspace. Each
    /// result is independent.
    pub fn create_idle_threads(
        &self,
        request: &CreateIdleThread,
        count: u8,
    ) -> Result<Vec<Result<ThreadSummary>>> {
        if count == 0 || usize::from(count) > validate::MAX_BULK_CREATE {
            return Err(KalError::validation(
                "invalid_thread_count",
                format!(
                    "Create between 1 and {} threads at a time.",
                    validate::MAX_BULK_CREATE
                ),
            ));
        }
        Ok((0..count)
            .map(|_| self.create_idle(request.clone()))
            .collect())
    }

    /// Creates several threads (at most 16). Each result is independent.
    pub fn create_threads(
        &self,
        requests: Vec<CreateThread>,
    ) -> Result<Vec<Result<ThreadSummary>>> {
        if requests.is_empty() || requests.len() > validate::MAX_BULK_CREATE {
            return Err(KalError::validation(
                "invalid_thread_count",
                format!(
                    "Create between 1 and {} threads at a time.",
                    validate::MAX_BULK_CREATE
                ),
            ));
        }
        Ok(requests
            .into_iter()
            .map(|request| self.create(request))
            .collect())
    }

    /// Inspects a prompt for an existing thread without sending or writing message state.
    pub fn review_thread_prompt(&self, thread_id: &str, text: &str) -> Result<PromptReview> {
        validate::thread_id(thread_id)?;
        let text = validate::prompt(text)?;
        let row = self.inner.row(thread_id)?;
        self.inner
            .prompt_gate
            .review(&prompt_firewall(), row_prompt_target(&row), &text)
            .map_err(Into::into)
    }

    pub fn send(&self, thread_id: &str, text: &str) -> Result<ThreadSummary> {
        self.send_reviewed(thread_id, text, None)
    }

    /// Sends after consuming an exact owner confirmation when the prompt warned.
    pub fn send_reviewed(
        &self,
        thread_id: &str,
        text: &str,
        review_id: Option<&str>,
    ) -> Result<ThreadSummary> {
        let admitted = self.admit_thread_prompt(thread_id, text, review_id)?;
        self.send_admitted(admitted)?;
        self.inner.summary(thread_id)
    }

    /// Validates and admits a thread prompt without starting a provider effect or writing it.
    pub fn admit_thread_prompt(
        &self,
        thread_id: &str,
        text: &str,
        review_id: Option<&str>,
    ) -> Result<ThreadPromptAdmission> {
        validate::thread_id(thread_id)?;
        let text = validate::prompt(text)?;
        let row = self.inner.row(thread_id)?;
        let admission = self.inner.prompt_gate.admit(
            &prompt_firewall(),
            &row_prompt_target(&row),
            &text,
            review_id,
        )?;
        Ok(ThreadPromptAdmission {
            thread_id: thread_id.to_owned(),
            prompt: AdmittedPrompt {
                text,
                target: row_prompt_target(&row),
                admission,
            },
        })
    }

    fn send_admitted(&self, admitted: ThreadPromptAdmission) -> Result<()> {
        self.inner.send(&admitted.thread_id, admitted.prompt)
    }

    /// Sends an explicitly previewed context payload while persisting only the user's own
    /// message. Context content is ephemeral provider input; its package reference and firewall
    /// facts are stored by the context service, never copied into thread history or events.
    pub fn send_with_context(
        &self,
        thread_id: &str,
        user_text: &str,
        context: &RenderedPackage,
    ) -> Result<ThreadSummary> {
        self.send_with_context_reviewed(thread_id, user_text, context, None)
    }

    /// Sends a previewed context payload after consuming any exact prompt confirmation.
    pub fn send_with_context_reviewed(
        &self,
        thread_id: &str,
        user_text: &str,
        context: &RenderedPackage,
        review_id: Option<&str>,
    ) -> Result<ThreadSummary> {
        let admitted = self.admit_thread_prompt(thread_id, user_text, review_id)?;
        self.send_with_context_admitted(admitted, context)?;
        self.inner.summary(thread_id)
    }

    /// Consumes a previously admitted prompt and a non-forgeable rendered context package at the
    /// central provider boundary.
    pub fn send_with_context_admitted(
        &self,
        admitted: ThreadPromptAdmission,
        context: &RenderedPackage,
    ) -> Result<ThreadSummary> {
        let thread_id = admitted.thread_id.clone();
        let provider_payload = validate::prompt(&format!(
            "{}\n\nContext supplied by you:\n{}",
            admitted.prompt.text,
            context.text()
        ))?;
        self.inner
            .send_with_payload(&thread_id, admitted.prompt, provider_payload)?;
        self.inner.summary(&thread_id)
    }

    /// Stops the current turn; the session stays open for more input.
    pub fn interrupt(&self, thread_id: &str) -> Result<ThreadSummary> {
        validate::thread_id(thread_id)?;
        let row = self
            .inner
            .halt_turn(thread_id, ThreadStatus::Idle, INTERRUPTED_ACTIVITY)?;
        Ok(self.inner.summary_from_row(row))
    }

    /// Stops the current turn and holds the thread `paused` until resumed.
    pub fn pause(&self, thread_id: &str) -> Result<ThreadSummary> {
        validate::thread_id(thread_id)?;
        let row = self
            .inner
            .halt_turn(thread_id, ThreadStatus::Paused, PAUSED_ACTIVITY)?;
        Ok(self.inner.summary_from_row(row))
    }

    /// Ends the session and its process tree. The thread becomes `interrupted`, resumable.
    pub fn stop(&self, thread_id: &str) -> Result<ThreadSummary> {
        validate::thread_id(thread_id)?;
        self.inner.stop(thread_id, STOPPED_ACTIVITY)?;
        self.inner.summary(thread_id)
    }

    /// Continues a thread: un-pauses a live one, or starts a new session (resuming the
    /// provider's own session when it supports that). `text`, when given, is sent first.
    pub fn resume(&self, thread_id: &str, text: Option<&str>) -> Result<ThreadSummary> {
        self.resume_reviewed(thread_id, text, None)
    }

    /// Resumes after consuming an exact owner confirmation when the optional prompt warned.
    pub fn resume_reviewed(
        &self,
        thread_id: &str,
        text: Option<&str>,
        review_id: Option<&str>,
    ) -> Result<ThreadSummary> {
        validate::thread_id(thread_id)?;
        let text = text
            .filter(|t| !t.trim().is_empty())
            .map(validate::prompt)
            .transpose()?;
        let admitted = match text {
            Some(text) => {
                let row = self.inner.row(thread_id)?;
                let target = row_prompt_target(&row);
                let admission =
                    self.inner
                        .prompt_gate
                        .admit(&prompt_firewall(), &target, &text, review_id)?;
                Some(AdmittedPrompt {
                    text,
                    target,
                    admission,
                })
            }
            None => None,
        };
        self.inner.resume(thread_id, admitted)?;
        self.inner.summary(thread_id)
    }

    pub fn rename(&self, thread_id: &str, name: &str) -> Result<ThreadSummary> {
        validate::thread_id(thread_id)?;
        let name = validate::name(name)?;
        self.inner.rename(thread_id, &name)?;
        self.inner.summary(thread_id)
    }

    /// Archives a thread that isn't running. Idempotent.
    pub fn archive(&self, thread_id: &str) -> Result<ThreadSummary> {
        validate::thread_id(thread_id)?;
        self.inner.archive(thread_id)?;
        if let Some(hooks) = self.inner.worktrees.get()
            && self.inner.row(thread_id)?.worktree_id.is_some()
        {
            hooks.release(thread_id);
        }
        self.inner.summary(thread_id)
    }

    /// Restores an archived thread to the open list, unchanged otherwise (status, messages,
    /// account). Records `thread.unarchived`. Idempotent: an open thread is returned as is.
    pub fn unarchive(&self, thread_id: &str) -> Result<ThreadSummary> {
        validate::thread_id(thread_id)?;
        self.inner.unarchive(thread_id)?;
        self.inner.summary(thread_id)
    }

    /// Explicitly rebinds a thread to another account of its provider (switch accounts). Only
    /// future provider requests use the new account: past messages stay, and the provider resume
    /// id is cleared with the account in one transaction because it belongs to the old account's
    /// profile home. An idle live session is ended first (without marking the thread
    /// interrupted), which drops it and so releases the old profile's shared lease; the next
    /// turn starts a fresh session under the new account with the new-session notice.
    ///
    /// Refused while a turn is starting or running (`thread_rebind_busy`) or an approval is
    /// pending (`thread_rebind_pending_approval`), for archived threads, and for unknown,
    /// removed or other-provider accounts. Rebinding to the current account changes nothing.
    /// Sign-in state and plan policy are the caller's to check: this crate never sees them.
    /// Records `thread.account_changed` with the account's label snapshot.
    pub fn rebind_account(&self, thread_id: &str, account_id: &str) -> Result<ThreadSummary> {
        validate::thread_id(thread_id)?;
        if !is_valid_id(account_id) {
            return Err(KalError::validation(
                "provider_account_id_invalid",
                "That account or binding id isn't valid.",
            ));
        }
        let row = self.inner.rebind_account(thread_id, account_id)?;
        Ok(self.inner.summary_from_row(row))
    }

    /// Changes a thread's permission mode and records `permission.mode_changed` atomically.
    /// For the permission engine (Z4), which enforces who may change it (Bypass needs a
    /// confirmed user action). A live session keeps the provider setting it started with.
    /// Stores a thread's permission mode (and Custom profile). This is the permission engine's
    /// storage seam (`ThreadModeStore`, Z4): callers change modes through
    /// `PermissionService::set_thread_mode`, which checks who may change it (Bypass needs the
    /// user's confirmation; agents and KalVoice are refused), expires the thread's pending
    /// requests, and records `permission.mode_changed` with its audit entry in one transaction.
    /// So this method records no event of its own. New decisions use the new mode immediately.
    pub fn set_permission_mode(
        &self,
        thread_id: &str,
        mode: PermissionMode,
        profile_id: Option<&str>,
    ) -> Result<ThreadSummary> {
        validate::thread_id(thread_id)?;
        self.inner
            .set_permission_mode(thread_id, mode, profile_id)?;
        self.inner.summary(thread_id)
    }

    /// The Custom permission profile a thread uses, if any.
    pub fn permission_profile_id(&self, thread_id: &str) -> Result<Option<String>> {
        validate::thread_id(thread_id)?;
        self.inner
            .core
            .read(|conn| store::permission_profile_id(conn, thread_id))
    }

    /// Pauses every working thread in `scope`. A single named thread is always attempted, so
    /// the caller hears why it couldn't be paused.
    pub fn pause_threads(&self, scope: &ThreadScope) -> Vec<BulkOutcome> {
        self.bulk(
            scope,
            |t| t.status.is_live() || t.status == ThreadStatus::WaitingForPermission,
            |id| self.pause(id).map(|_| ()),
        )
    }

    /// Resumes every paused thread in `scope`.
    pub fn resume_threads(&self, scope: &ThreadScope) -> Vec<BulkOutcome> {
        self.bulk(
            scope,
            |t| t.status == ThreadStatus::Paused,
            |id| self.resume(id, None).map(|_| ()),
        )
    }

    /// Stops every thread in `scope` that has a running session.
    pub fn stop_threads(&self, scope: &ThreadScope) -> Vec<BulkOutcome> {
        let running: std::collections::HashSet<String> =
            self.inner.running_ids().into_iter().collect();
        self.bulk(
            scope,
            |t| running.contains(&t.id),
            |id| self.stop(id).map(|_| ()),
        )
    }

    /// A point-in-time, read-only snapshot of the exact sessions a scoped stop would affect.
    /// Status alone is insufficient: idle and paused threads can still own provider processes.
    /// Callers bind these stable ids, then re-read this snapshot before stopping each id
    /// individually so a newly started session is never swept into the action.
    pub fn running_threads(&self, scope: &ThreadScope) -> Result<Vec<RunningThreadTarget>> {
        let running: HashMap<String, (u64, Option<u64>)> =
            self.inner.running_targets().into_iter().collect();
        if let ThreadScope::Thread { thread_id } = scope {
            let thread = self.get(thread_id)?;
            return Ok(running
                .get(thread_id)
                .map(|(generation, waiting_ticket)| RunningThreadTarget {
                    thread,
                    generation: *generation,
                    waiting_ticket: *waiting_ticket,
                })
                .into_iter()
                .collect());
        }
        let workspace_id = match scope {
            ThreadScope::Workspace { workspace_id } => Some(workspace_id.as_str()),
            ThreadScope::All | ThreadScope::Thread { .. } => None,
        };
        Ok(self
            .list(workspace_id, false)?
            .into_iter()
            .filter_map(|thread| {
                running
                    .get(&thread.id)
                    .map(|(generation, waiting_ticket)| RunningThreadTarget {
                        thread,
                        generation: *generation,
                        waiting_ticket: *waiting_ticket,
                    })
            })
            .collect())
    }

    /// Stops only the exact execution object represented by `target`. If that thread ended and
    /// resumed after target resolution, this fails closed and leaves it running.
    pub fn stop_running_thread(&self, target: &RunningThreadTarget) -> Result<ThreadSummary> {
        validate::thread_id(&target.thread.id)?;
        self.inner.stop_bound(
            &target.thread.id,
            STOPPED_ACTIVITY,
            target.generation,
            target.waiting_ticket,
        )?;
        self.inner.summary(&target.thread.id)
    }

    pub fn pause_all(&self) -> Vec<BulkOutcome> {
        self.pause_threads(&ThreadScope::All)
    }

    pub fn resume_all(&self) -> Vec<BulkOutcome> {
        self.resume_threads(&ThreadScope::All)
    }

    pub fn stop_all(&self) -> Vec<BulkOutcome> {
        self.stop_threads(&ThreadScope::All)
    }

    /// Open threads whose name, provider or workspace contains `query` (case-insensitive):
    /// exact name matches first, then name matches, then the rest; most recent first in each.
    pub fn find(&self, query: &str) -> Result<Vec<ThreadSummary>> {
        let query = query.trim().to_lowercase();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let mut matches: Vec<(u8, ThreadSummary)> = self
            .list(None, false)?
            .into_iter()
            .filter_map(|t| {
                let name = t.name.to_lowercase();
                let rank = if name == query {
                    0
                } else if name.contains(&query) {
                    1
                } else if t.provider_name.to_lowercase().contains(&query)
                    || t.workspace_name.to_lowercase().contains(&query)
                {
                    2
                } else {
                    return None;
                };
                Some((rank, t))
            })
            .collect();
        // `list` is most recent first and the sort is stable.
        matches.sort_by_key(|(rank, _)| *rank);
        Ok(matches.into_iter().map(|(_, t)| t).collect())
    }

    /// Subscribes to a thread's live stream (message deltas and completions). Text already
    /// streamed for an unfinished message is delivered first, so a late subscriber sees the
    /// whole message. `subscriber` returns false when it can no longer receive.
    pub fn subscribe_stream(
        &self,
        thread_id: &str,
        subscriber: impl Fn(&AgentEvent) -> bool + Send + Sync + 'static,
    ) -> Result<StreamId> {
        validate::thread_id(thread_id)?;
        self.inner.core.read(|conn| store::get(conn, thread_id))?;
        let id = self.inner.streams.next_id();
        match self.inner.existing_live(thread_id) {
            Some(live) => {
                let state = live.lock();
                for (message_id, text) in &state.buffers {
                    let catch_up = AgentEvent::MessageDelta {
                        message_id: message_id.clone(),
                        text: text.clone(),
                    };
                    if !subscriber(&catch_up) {
                        return Ok(id);
                    }
                }
                self.inner.streams.add(thread_id, id, Box::new(subscriber));
            }
            None => self.inner.streams.add(thread_id, id, Box::new(subscriber)),
        }
        Ok(id)
    }

    pub fn unsubscribe_stream(&self, id: StreamId) -> bool {
        self.inner.streams.remove(id)
    }

    /// Live-stream subscribers for a thread (diagnostics and tests).
    pub fn stream_subscriber_count(&self, thread_id: &str) -> usize {
        self.inner.streams.count(thread_id)
    }

    /// Ends every running session (app exit). `Ok` proves every provider accepted termination.
    /// Failed sessions remain owned by this runtime so a later call can retry safely.
    pub fn shutdown_checked(&self) -> Result<()> {
        // No held launch may start a provider after this point; waits end as stopped.
        self.inner.shutting_down.store(true, Ordering::SeqCst);
        let mut first_error = None;
        for id in self.inner.running_ids() {
            if let Err(error) = self.inner.stop(&id, SHUTDOWN_ACTIVITY) {
                tracing::warn!(event = "thread.shutdown_failed", thread_id = %id, error = %error.diagnostic());
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    /// Compatibility wrapper for callers that cannot surface shutdown failure yet.
    pub fn shutdown(&self) {
        if let Err(error) = self.shutdown_checked() {
            tracing::error!(event = "thread.shutdown_incomplete", error = %error.diagnostic());
        }
    }

    fn bulk(
        &self,
        scope: &ThreadScope,
        select: impl Fn(&ThreadSummary) -> bool,
        apply: impl Fn(&str) -> Result<()>,
    ) -> Vec<BulkOutcome> {
        if let ThreadScope::Thread { thread_id } = scope {
            return vec![outcome(thread_id, apply(thread_id))];
        }
        let workspace = match scope {
            ThreadScope::Workspace { workspace_id } => Some(workspace_id.as_str()),
            _ => None,
        };
        match self.list(workspace, false) {
            Ok(threads) => threads
                .iter()
                .filter(|t| select(t))
                .map(|t| outcome(&t.id, apply(&t.id)))
                .collect(),
            Err(error) => {
                tracing::error!(event = "thread.bulk_failed", error = %error.diagnostic());
                Vec::new()
            }
        }
    }
}

fn outcome(thread_id: &str, result: Result<()>) -> BulkOutcome {
    match result {
        Ok(()) => BulkOutcome {
            thread_id: thread_id.to_owned(),
            ok: true,
            message: None,
        },
        Err(error) => BulkOutcome {
            thread_id: thread_id.to_owned(),
            ok: false,
            message: Some(error.message),
        },
    }
}

fn not_running() -> KalError {
    KalError::validation(
        "thread_not_running",
        "This thread isn't running. Resume it to continue.",
    )
}

fn stop_target_changed() -> KalError {
    KalError::validation(
        "thread_stop_target_changed",
        "That agent session changed after KalCode resolved it, so KalCode left it running. Try again.",
    )
}

fn recent_launch_changed() -> KalError {
    KalError::validation(
        "recent_launch_changed",
        "One of those sessions changed after KalVoice launched it. Nothing was changed.",
    )
}

fn provider_unavailable(name: &str) -> KalError {
    KalError::new(
        ErrorCategory::Provider,
        "provider_unavailable",
        format!("{name} isn't connected to KalCode. Connect it in Providers, then try again."),
    )
}

/// User-safe code and message for a provider failure. Raw provider detail is logged only.
fn describe_provider_error(error: &ProviderError, provider: &str) -> (String, String) {
    let (code, message) = match error {
        ProviderError::NotInstalled => (
            "provider_not_installed",
            format!("{provider} isn't installed on this computer."),
        ),
        ProviderError::NotAuthenticated => (
            "provider_not_authenticated",
            format!(
                "{provider} isn't signed in for this account. Sign in to this {provider} account in Providers, then resume this thread."
            ),
        ),
        ProviderError::Unsupported => (
            "provider_unsupported",
            format!("{provider} doesn't support that."),
        ),
        ProviderError::SessionEnded => (
            "provider_session_ended",
            format!("The {provider} session has ended. Resume the thread to continue."),
        ),
        ProviderError::Start(_) => (
            "provider_start_failed",
            format!(
                "{provider} couldn't start. Check that it works in a terminal, then resume this thread."
            ),
        ),
        ProviderError::Io(_) => (
            "provider_io_failed",
            format!(
                "KalCode lost contact with {provider}. Your conversation is saved; resume the thread to continue."
            ),
        ),
        ProviderError::Protocol(_) => (
            "provider_protocol_error",
            format!(
                "{provider} sent output KalCode couldn't understand. Your conversation is saved; resume the thread to continue."
            ),
        ),
        // Reached only where a hold cannot wait (the runtime waits on launches and turns).
        ProviderError::ResourcesHeld(hold) => (
            error_codes::RESOURCES_UNAVAILABLE,
            unavailable_message(provider, hold, false, false),
        ),
        // KalCode's own fixed refusal copy (account in use, plan, version): shown as written.
        ProviderError::Refused { code, message } => {
            return (
                validate::provider_code(code, error_codes::PROVIDER_START_FAILED),
                validate::provider_text(message, 600),
            );
        }
    };
    (code.to_owned(), message)
}

/// "(CPU busy)", "(4 of 4 threads are already working)".
fn hold_phrase(hold: &LaunchHold, provider: &str) -> String {
    match (hold.kind, hold.running, hold.limit) {
        (LaunchHoldKind::ConcurrencyLimit, Some(running), Some(limit)) => {
            format!("{running} of {limit} threads are already working")
        }
        (LaunchHoldKind::ProviderLimit, Some(running), Some(limit)) => {
            format!("{running} of {limit} {provider} threads are already working")
        }
        (kind, _, _) => kind.phrase().to_owned(),
    }
}

/// While waiting: what is held, that KalCode re-checks, and what the person can do.
fn waiting_message(provider: &str, hold: &LaunchHold) -> String {
    let phrase = hold_phrase(hold, provider);
    if hold.kind.freed_by_stopping_a_thread() {
        format!(
            "KalCode is waiting for system resources ({phrase}). {provider} starts as soon as one finishes; stop a thread you're not using to start it sooner."
        )
    } else {
        format!(
            "KalCode is waiting for system resources ({phrase}). {provider} starts when they free up; KalCode checks again every few seconds."
        )
    }
}

/// After the bounded wait: nothing started, what to do next. `has_message` says the person's
/// message is saved and Resume sends it.
fn unavailable_message(provider: &str, hold: &LaunchHold, has_message: bool, turn: bool) -> String {
    let phrase = hold_phrase(hold, provider);
    let what = if turn {
        format!("{provider} didn't run this turn")
    } else {
        format!("{provider} didn't start")
    };
    let waited = hold.wait_limit.as_secs();
    let saved = if has_message {
        " Your message is saved; Resume sends it."
    } else {
        ""
    };
    if hold.kind.freed_by_stopping_a_thread() {
        format!(
            "{what}: KalCode waited {waited} s for system resources ({phrase}).{saved} Stop a thread you're not using, then resume this one."
        )
    } else {
        format!(
            "{what}: KalCode waited {waited} s for system resources ({phrase}).{saved} Resume this thread to try again."
        )
    }
}

/// The error means the message never reached the provider (nothing was spawned or written).
fn never_delivered(error: &ProviderError) -> bool {
    matches!(
        error,
        ProviderError::Start(_)
            | ProviderError::Refused { .. }
            | ProviderError::ResourcesHeld(_)
            | ProviderError::NotAuthenticated
            | ProviderError::NotInstalled
    )
}

/// Statuses a provider may report. The rest belong to the runtime (lifecycle, approvals,
/// pause) and are never taken from a provider.
fn provider_settable(status: ThreadStatus) -> bool {
    matches!(
        status,
        ThreadStatus::Active
            | ThreadStatus::Thinking
            | ThreadStatus::RunningTool
            | ThreadStatus::RunningCommand
            | ThreadStatus::Editing
            | ThreadStatus::Testing
            | ThreadStatus::Reviewing
            | ThreadStatus::Idle
            | ThreadStatus::WaitingForUser
            | ThreadStatus::WaitingForDependency
    )
}

/// A provider-reported path, shown relative to the working directory when inside it. Returns
/// `None` for paths KalCode won't record (control characters, absurd length).
fn display_path(cwd: &str, path: &str) -> Option<String> {
    if path.is_empty() || path.len() > 4096 || path.chars().any(char::is_control) {
        return None;
    }
    let norm = |p: &str| p.replace('\\', "/");
    let (root, full) = (norm(cwd), norm(path));
    let root = root.trim_end_matches('/');
    let fold = |s: &str| {
        if cfg!(windows) {
            s.to_lowercase()
        } else {
            s.to_owned()
        }
    };
    if !root.is_empty()
        && full.len() > root.len() + 1
        && full.is_char_boundary(root.len())
        && fold(&full[..root.len()]) == fold(root)
        && full[root.len()..].starts_with('/')
    {
        return Some(full[root.len() + 1..].to_owned());
    }
    Some(path.to_owned())
}

fn cap_message(mut content: String) -> String {
    if content.len() > MAX_MESSAGE_BYTES {
        let mut cut = MAX_MESSAGE_BYTES;
        while !content.is_char_boundary(cut) {
            cut -= 1;
        }
        content.truncate(cut);
        content.push_str(TRUNCATION_NOTE);
    }
    content
}

impl Inner {
    fn existing_live(&self, thread_id: &str) -> Option<Arc<LiveThread>> {
        self.live
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(thread_id)
            .cloned()
    }

    fn live_thread(&self, row: &ThreadRow) -> Arc<LiveThread> {
        self.live
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(row.id.clone())
            .or_insert_with(|| {
                Arc::new(LiveThread {
                    ctx: Ctx::from_row(row),
                    state: Mutex::new(LiveState::default()),
                })
            })
            .clone()
    }

    /// Refuses starting one more agent session once the plan's cap of running (or held)
    /// sessions is reached. Checked before any thread row is written, so a refusal leaves
    /// nothing behind.
    fn admit_agent(&self) -> Result<()> {
        let source = self
            .agent_limit
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let Some(limit) = source.and_then(|limit| limit()) else {
            return Ok(());
        };
        limit.admit(i64::try_from(self.running_ids().len()).unwrap_or(i64::MAX))
    }

    fn running_ids(&self) -> Vec<String> {
        let all: Vec<Arc<LiveThread>> = self
            .live
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .cloned()
            .collect();
        all.into_iter()
            .filter(|live| {
                let state = live.lock();
                state.session.is_some() || state.waiting.is_some()
            })
            .map(|live| live.ctx.thread_id.clone())
            .collect()
    }

    fn running_targets(&self) -> Vec<(String, (u64, Option<u64>))> {
        let all: Vec<Arc<LiveThread>> = self
            .live
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .cloned()
            .collect();
        all.into_iter()
            .filter_map(|live| {
                let state = live.lock();
                if state.session.is_some() {
                    Some((live.ctx.thread_id.clone(), (state.generation, None)))
                } else {
                    state.waiting.as_ref().map(|waiting| {
                        (
                            live.ctx.thread_id.clone(),
                            (state.generation, Some(waiting.ticket)),
                        )
                    })
                }
            })
            .collect()
    }

    fn row(&self, thread_id: &str) -> Result<ThreadRow> {
        self.core.read(|conn| store::get(conn, thread_id))
    }

    fn summary(&self, thread_id: &str) -> Result<ThreadSummary> {
        let row = self.row(thread_id)?;
        Ok(self.summary_from_row(row))
    }

    fn summary_from_row(&self, row: ThreadRow) -> ThreadSummary {
        let workspace_name = self
            .workspaces
            .resolve(&row.workspace_id)
            .ok()
            .map(|w| w.name);
        self.to_summary(row, workspace_name)
    }

    fn to_summary(&self, row: ThreadRow, workspace_name: Option<String>) -> ThreadSummary {
        let entry = self.providers.get(&row.provider_id);
        // Resume restores the provider's own conversation only when the provider supports it and
        // a provider session id was stored; otherwise resume starts a fresh session.
        let resumable = row.provider_session_id.is_some()
            && entry
                .as_ref()
                .is_some_and(|entry| entry.provider.capabilities().resume);
        let provider_name = entry.map_or(row.provider_name, |entry| {
            entry.provider.display_name().to_owned()
        });
        ThreadSummary {
            id: row.id,
            name: row.name,
            provider_id: row.provider_id,
            provider_name,
            model: row.model,
            effort: row.effort,
            provider_account_id: row.provider_account_id,
            account_label: row.account_label,
            workspace_id: row.workspace_id,
            workspace_name: workspace_name.unwrap_or(row.workspace_name),
            permission_mode: row.permission_mode,
            status: row.status,
            current_activity: row.current_activity,
            created_at: row.created_at,
            last_activity_at: row.last_activity_at,
            pending_approvals: row.pending_approvals,
            unread_messages: row.unread_messages,
            files_changed: Some(row.files_changed),
            branch: row.worktree_branch,
            error: row
                .error_code
                .zip(row.error_message)
                .map(|(code, message)| ThreadError { code, message }),
            archived_at: row.archived_at,
            resumable,
            permission_profile_id: row.permission_profile_id,
            runtime_kind: None,
            terminal_id: None,
            worktree_id: row.worktree_id,
        }
    }

    /// Crash recovery: threads left in a non-final state had their process die with the
    /// previous KalCode session. They become `interrupted` and can be resumed.
    fn recover(&self) {
        let rows = match self.core.read(store::unfinished) {
            Ok(rows) => rows,
            Err(error) => {
                tracing::error!(event = "thread.recovery_failed", error = %error.diagnostic());
                return;
            }
        };
        for row in rows {
            let ctx = Ctx::from_row(&row);
            let now = now_rfc3339();
            let result = self.core.write_with_events(|tx| {
                let from = store::set_status(
                    tx,
                    &row.id,
                    ThreadStatus::Interrupted,
                    Some(RECOVERED_ACTIVITY),
                    &now,
                )?;
                store::set_pending_approvals(tx, &row.id, 0)?;
                store::cancel_open_tool_calls(tx, &row.id, &now)?;
                // A wait for system resources ended with the previous process; nothing is
                // waiting now. An undelivered message stays marked, so Resume sends it.
                if row.error_code.as_deref() == Some(error_codes::WAITING_FOR_RESOURCES) {
                    store::set_error(tx, &row.id, None)?;
                }
                Ok((
                    (),
                    ctx.status_changed(
                        EventSource::Core,
                        from,
                        ThreadStatus::Interrupted,
                        Some(RECOVERED_ACTIVITY),
                    ),
                ))
            });
            match result {
                Ok(_) => {
                    self.gate.expire_for_thread(&row.id);
                    tracing::warn!(event = "thread.recovered", thread_id = %row.id, from = ?row.status);
                }
                Err(error) => {
                    tracing::error!(event = "thread.recovery_failed", thread_id = %row.id, error = %error.diagnostic());
                }
            }
        }
    }

    /// Creates a thread and starts its session; `prompt`, when given, is the first message.
    fn create(
        &self,
        request: NewThread<'_>,
        prompt: Option<AdmittedPrompt>,
        thread_id: Option<&str>,
    ) -> Result<ThreadSummary> {
        let provider_id = validate::provider_id(request.provider_id)?;
        validate::workspace_id(request.workspace_id)?;
        let model = validate::model(request.model)?;
        let effort = normalize_effort(request.effort)?;
        let mode = validate::creation_mode(request.permission_mode)?;
        let name = request.name;
        let entry = self
            .providers
            .get(&provider_id)
            .ok_or_else(|| provider_unavailable(provider_id.as_str()))?;
        let provider_name = entry.provider.display_name().to_owned();
        let account_label = request
            .provider_account_id
            .and(request.account_label.or(entry.account_label.as_deref()));
        if let Some(model) = &model {
            let models = entry.provider.capabilities().models;
            if !provider_accepts_model(&provider_id, &models, model) {
                return Err(KalError::validation(
                    "invalid_model",
                    format!("That model isn't available for {provider_name}."),
                ));
            }
        }
        let workspace = self.workspaces.resolve(request.workspace_id)?;
        // The plan's agent cap is checked before the folder is prepared, so a refused agent
        // leaves no worktree or branch behind.
        self.admit_agent()?;
        let cwd = match request.cwd {
            Some(prepare) => {
                let cwd = prepare()?;
                if !(cwd.is_absolute() && cwd.is_dir()) {
                    return Err(thread_folder_unavailable());
                }
                cwd
            }
            None => workspace.root.clone(),
        };
        let cwd = cwd.to_string_lossy().into_owned();

        let id = thread_id.map(str::to_owned).unwrap_or_else(new_id);
        let now = now_rfc3339();
        let row = NewThreadRow {
            id: &id,
            name: &name,
            provider_id: &provider_id,
            provider_name: &provider_name,
            model: model.as_deref(),
            effort: effort.as_deref(),
            provider_account_id: request.provider_account_id,
            account_label,
            workspace_id: &workspace.id,
            workspace_name: &workspace.name,
            cwd: &cwd,
            permission_mode: mode,
            now: &now,
        };
        let created = EventPayload::ThreadCreated {
            thread_id: id.clone(),
            name: name.clone(),
            provider_id: provider_id.clone(),
            workspace_id: workspace.id.clone(),
        };
        self.core.write_with_events(|tx| {
            store::insert_thread(tx, &row)?;
            let ctx = Ctx {
                thread_id: id.clone(),
                workspace_id: workspace.id.clone(),
                provider_id: provider_id.clone(),
            };
            Ok(((), vec![ctx.event(EventSource::Core, created)]))
        })?;
        tracing::info!(event = "thread.created", thread_id = %id, provider_id = %provider_id);

        let row = self.row(&id)?;
        self.start_session(&row, &entry, None, prompt, None, None)?;
        self.summary(&id)
    }

    /// Starts a provider session for `row`, then sends `first_input` (or, on a resume without
    /// new text, `redeliver`: the thread's recorded but undelivered message). Provider failures
    /// are recorded on the thread (`failed`) rather than returned; a launch the Resource
    /// Governor holds waits (`waiting_for_dependency`) instead.
    fn start_session(
        &self,
        row: &ThreadRow,
        entry: &ProviderEntry,
        resume_session_id: Option<String>,
        first_input: Option<AdmittedPrompt>,
        notice: Option<&'static str>,
        redeliver: Option<String>,
    ) -> Result<()> {
        let live = self.live_thread(row);
        let mut state = live.lock();
        if state.session.is_some() || state.waiting.is_some() {
            return Err(KalError::validation(
                "thread_already_running",
                "This thread is already running.",
            ));
        }
        // Revalidate the opaque proof at the last in-process boundary before a provider starts.
        // This also prevents a reviewed prompt from being swapped after validation.
        let first_input = match first_input {
            Some(admitted) => {
                let target = if admitted.target.thread_id.is_none() {
                    row_create_prompt_target(row)
                } else {
                    row_prompt_target(row)
                };
                self.prompt_gate
                    .verify(admitted.admission, &target, &admitted.text)?;
                Some(TurnInput::new(admitted.text))
            }
            // Admitted when it was first sent, for this thread and account (a rebind clears it).
            None => redeliver.map(TurnInput::recorded),
        };
        self.launch(
            &live,
            &mut state,
            row,
            entry,
            resume_session_id,
            first_input,
            notice,
            None,
        )
    }

    /// Starts the provider session. `recheck` is the current wait when a held launch re-checks.
    #[allow(clippy::too_many_arguments)]
    fn launch(
        &self,
        live: &Arc<LiveThread>,
        state: &mut LiveState,
        row: &ThreadRow,
        entry: &ProviderEntry,
        resume_session_id: Option<String>,
        input: Option<TurnInput>,
        notice: Option<&'static str>,
        recheck: Recheck,
    ) -> Result<()> {
        state.generation += 1;
        let generation = state.generation;
        state.pending.clear();
        state.resume_status = None;
        state.buffers.clear();
        state.tools.clear();
        state.cwd = row.cwd.clone();

        let (events, receiver) = mpsc::channel::<AgentEvent>();
        let sink = move |event: AgentEvent| {
            // A closed channel means KalCode stopped listening (the session ended).
            let _ = events.send(event);
        };
        let config = SessionConfig {
            thread_id: row.id.clone(),
            workspace_id: row.workspace_id.clone(),
            provider_account_id: row.provider_account_id.clone(),
            working_directory: row.cwd.clone(),
            model: row.model.clone(),
            effort: row.effort.clone(),
            permission_mode: row.permission_mode,
            resume_session_id: resume_session_id.clone(),
            secret_ref: entry.secret_ref.clone(),
        };
        let provider_name = entry.provider.display_name().to_owned();
        let session: Arc<dyn AgentSession> = match entry
            .provider
            .start_session(config, Box::new(sink))
        {
            Ok(session) => Arc::from(session),
            Err(ProviderError::ResourcesHeld(hold)) => {
                let input = self.record_undelivered(&live.ctx, input)?;
                return self.wait_for_resources(
                    live,
                    state,
                    hold,
                    WaitFor::Start {
                        resume_session_id,
                        input,
                        notice,
                    },
                    recheck,
                );
            }
            Err(error) => {
                tracing::warn!(event = "thread.session_start_failed", thread_id = %row.id, error = %error);
                // The task is kept: recorded in history and delivered by Resume.
                self.record_undelivered(&live.ctx, input)?;
                let (code, message) = describe_provider_error(&error, &provider_name);
                return self.fail_idle_thread(&live.ctx, &code, &message);
            }
        };
        state.session = Some(session.clone());
        state.turn_failed = false;
        state.halted = false;
        if let Err(error) = self.spawn_worker(live.clone(), generation, receiver) {
            let _ = session.terminate();
            state.session = None;
            return Err(error);
        }

        let ctx = &live.ctx;
        self.core.write_with_events(|tx| {
            store::set_error(tx, &ctx.thread_id, None)?;
            Ok((
                (),
                vec![ctx.event(
                    EventSource::Core,
                    EventPayload::ThreadStarted {
                        thread_id: ctx.thread_id.clone(),
                    },
                )],
            ))
        })?;
        if let Some(notice) = notice {
            self.persist_message(ctx, MessageRole::System, notice, None, EventSource::Core)?;
        }
        match input {
            Some(input) => self.deliver_locked(live, state, input, None)?,
            // The session is up and no turn is running: the thread waits for input.
            None => self.transition(ctx, ThreadStatus::Idle, None)?,
        }
        Ok(())
    }

    /// Records `input` in history (when it isn't yet) and marks it undelivered, so the task is
    /// visible and Resume delivers it. Returns the input as recorded.
    fn record_undelivered(&self, ctx: &Ctx, input: Option<TurnInput>) -> Result<Option<TurnInput>> {
        let Some(mut input) = input else {
            return Ok(None);
        };
        if let Some(text) = input.record.take() {
            let message =
                self.persist_message(ctx, MessageRole::User, &text, None, EventSource::Ui)?;
            if input.redeliverable {
                self.core.write_with_events(|tx| {
                    store::set_undelivered(tx, &ctx.thread_id, &message.id)?;
                    Ok(((), Vec::new()))
                })?;
            }
        }
        Ok(Some(input))
    }

    /// Holds the thread while the Resource Governor re-checks: `waiting_for_dependency` with a
    /// truthful activity and `waiting_for_resources`. A first hold starts the bounded wait and
    /// its waiter; a re-check keeps the original deadline and only updates a changed reason.
    fn wait_for_resources(
        &self,
        live: &Arc<LiveThread>,
        state: &mut LiveState,
        hold: LaunchHold,
        what: WaitFor,
        recheck: Recheck,
    ) -> Result<()> {
        let ctx = &live.ctx;
        let (ticket, deadline, changed) = match recheck {
            Some((ticket, deadline, shown)) => (ticket, deadline, shown != hold.kind),
            None => {
                state.wait_ticket += 1;
                (state.wait_ticket, Instant::now() + hold.wait_limit, true)
            }
        };
        let waiting = Waiting {
            ticket,
            deadline,
            hold,
            what,
        };
        if self.shutting_down.load(Ordering::SeqCst) || Instant::now() >= deadline {
            return self.wait_ended(live, state, waiting);
        }
        if changed {
            let provider_name = self.row(&ctx.thread_id)?.provider_name;
            let activity = format!(
                "{WAITING_FOR_RESOURCES_ACTIVITY} ({})",
                hold_phrase(&waiting.hold, &provider_name)
            );
            let message = waiting_message(&provider_name, &waiting.hold);
            let now = now_rfc3339();
            self.core.write_with_events(|tx| {
                let from = store::set_status(
                    tx,
                    &ctx.thread_id,
                    ThreadStatus::WaitingForDependency,
                    Some(&activity),
                    &now,
                )?;
                store::set_error(
                    tx,
                    &ctx.thread_id,
                    Some((error_codes::WAITING_FOR_RESOURCES, &message)),
                )?;
                Ok((
                    (),
                    ctx.status_changed(
                        EventSource::Core,
                        from,
                        ThreadStatus::WaitingForDependency,
                        Some(&activity),
                    ),
                ))
            })?;
            tracing::info!(
                event = "thread.waiting_for_resources",
                thread_id = %ctx.thread_id,
                reason = waiting.hold.kind.code(),
                retry_ms = u64::try_from(waiting.hold.retry_after.as_millis()).unwrap_or(u64::MAX),
                wait_limit_ms = u64::try_from(waiting.hold.wait_limit.as_millis()).unwrap_or(u64::MAX)
            );
        }
        let fresh = recheck.is_none();
        state.waiting = Some(waiting);
        if fresh && let Err(error) = self.spawn_waiter(live.clone(), ticket) {
            if let Some(waiting) = state.waiting.take() {
                self.wait_ended(live, state, waiting)?;
            }
            return Err(error);
        }
        Ok(())
    }

    /// One thread per wait: sleeps on the governor's retry cadence (never past the deadline),
    /// then re-checks. It holds the runtime weakly and stops once its wait is no longer current.
    fn spawn_waiter(&self, live: Arc<LiveThread>, ticket: u64) -> Result<()> {
        let runtime = self.self_ref.clone();
        let short: String = live.ctx.thread_id.chars().take(8).collect();
        std::thread::Builder::new()
            .name(format!("kalcode-thread-wait-{short}"))
            .spawn(move || {
                loop {
                    let delay = {
                        let state = live.lock();
                        let Some(waiting) = state.waiting.as_ref().filter(|w| w.ticket == ticket)
                        else {
                            return;
                        };
                        waiting
                            .hold
                            .retry_after
                            .min(waiting.deadline.saturating_duration_since(Instant::now()))
                    };
                    std::thread::sleep(delay);
                    let Some(inner) = runtime.upgrade() else {
                        return;
                    };
                    if !inner.recheck_wait(&live, ticket) {
                        return;
                    }
                }
            })
            .map(|_| ())
            .map_err(|e| {
                KalError::internal(
                    "thread_worker_failed",
                    "KalCode couldn't start a worker for this thread.",
                )
                .with_source(e)
            })
    }

    /// Re-evaluates a held launch or turn against current admission. Returns whether the same
    /// wait continues.
    fn recheck_wait(&self, live: &Arc<LiveThread>, ticket: u64) -> bool {
        let mut state = live.lock();
        let Some(waiting) = state.waiting.take_if(|waiting| waiting.ticket == ticket) else {
            return false;
        };
        let result = if self.shutting_down.load(Ordering::SeqCst)
            || Instant::now() >= waiting.deadline
        {
            self.wait_ended(live, &mut state, waiting)
        } else {
            let recheck = Some((ticket, waiting.deadline, waiting.hold.kind));
            match waiting.what {
                WaitFor::Start {
                    resume_session_id,
                    input,
                    notice,
                } => match self.row(&live.ctx.thread_id).and_then(|row| {
                    let entry = self
                        .providers
                        .get(&row.provider_id)
                        .ok_or_else(|| provider_unavailable(&row.provider_name))?;
                    Ok((row, entry))
                }) {
                    Ok((row, entry)) => self.launch(
                        live,
                        &mut state,
                        &row,
                        &entry,
                        resume_session_id,
                        input,
                        notice,
                        recheck,
                    ),
                    Err(error) => self.fail_idle_thread(&live.ctx, error.code, &error.message),
                },
                WaitFor::Turn { input } => self.deliver_locked(live, &mut state, input, recheck),
            }
        };
        if let Err(error) = result {
            tracing::error!(event = "thread.wait_recheck_failed", thread_id = %live.ctx.thread_id, error = %error.diagnostic());
        }
        state
            .waiting
            .as_ref()
            .is_some_and(|waiting| waiting.ticket == ticket)
    }

    /// The bounded wait ended (or KalCode is shutting down): nothing started. The thread is
    /// `interrupted` (resumable) with `resources_unavailable`; never `failed`.
    fn wait_ended(
        &self,
        live: &Arc<LiveThread>,
        state: &mut LiveState,
        waiting: Waiting,
    ) -> Result<()> {
        let ctx = &live.ctx;
        let provider_name = self.row(&ctx.thread_id)?.provider_name;
        tracing::info!(
            event = "thread.resources_unavailable",
            thread_id = %ctx.thread_id,
            reason = waiting.hold.kind.code()
        );
        match waiting.what {
            WaitFor::Start { input, .. } => {
                let message =
                    unavailable_message(&provider_name, &waiting.hold, input.is_some(), false);
                let now = now_rfc3339();
                self.core.write_with_events(|tx| {
                    let from = store::set_status(
                        tx,
                        &ctx.thread_id,
                        ThreadStatus::Interrupted,
                        Some(RESOURCES_UNAVAILABLE_ACTIVITY),
                        &now,
                    )?;
                    store::set_error(
                        tx,
                        &ctx.thread_id,
                        Some((error_codes::RESOURCES_UNAVAILABLE, &message)),
                    )?;
                    Ok((
                        (),
                        ctx.status_changed(
                            EventSource::Core,
                            from,
                            ThreadStatus::Interrupted,
                            Some(RESOURCES_UNAVAILABLE_ACTIVITY),
                        ),
                    ))
                })?;
                Ok(())
            }
            WaitFor::Turn { input } => {
                let message =
                    unavailable_message(&provider_name, &waiting.hold, input.redeliverable, true);
                self.end_session(live, state, EndReason::ResourcesUnavailable { message })
            }
        }
    }

    fn spawn_worker(
        &self,
        live: Arc<LiveThread>,
        generation: u64,
        receiver: mpsc::Receiver<AgentEvent>,
    ) -> Result<()> {
        // Workers hold the runtime weakly: dropping the runtime ends them instead of keeping
        // the core (and its data-folder lock) alive.
        let runtime = self.self_ref.clone();
        let short: String = live.ctx.thread_id.chars().take(8).collect();
        std::thread::Builder::new()
            .name(format!("kalcode-thread-{short}"))
            .spawn(move || {
                for event in receiver.iter() {
                    let Some(inner) = runtime.upgrade() else {
                        return;
                    };
                    if inner.handle_event(&live, generation, event) {
                        break;
                    }
                }
                if let Some(inner) = runtime.upgrade() {
                    inner.session_gone(&live, generation);
                }
            })
            .map(|_| ())
            .map_err(|e| {
                KalError::internal(
                    "thread_worker_failed",
                    "KalCode couldn't start a worker for this thread.",
                )
                .with_source(e)
            })
    }

    /// The session's event channel closed without `Exited` (the adapter dropped its sink).
    fn session_gone(&self, live: &Arc<LiveThread>, generation: u64) {
        let mut state = live.lock();
        if state.generation == generation
            && state.session.is_some()
            && let Err(error) = self.end_session(live, &mut state, EndReason::Exited(None))
        {
            tracing::error!(event = "thread.end_failed", thread_id = %live.ctx.thread_id, error = %error.diagnostic());
        }
    }

    /// Applies one provider event. Returns true when the session has ended.
    fn handle_event(&self, live: &Arc<LiveThread>, generation: u64, event: AgentEvent) -> bool {
        let ended = matches!(event, AgentEvent::Exited { .. });
        let mut state = live.lock();
        if state.generation != generation || state.session.is_none() {
            // A stale session (stopped, replaced by a resume): its events no longer apply.
            return ended;
        }
        if let Err(error) = self.apply_event(live, &mut state, event) {
            tracing::error!(event = "thread.event_failed", thread_id = %live.ctx.thread_id, error = %error.diagnostic());
        }
        ended
    }

    fn apply_event(
        &self,
        live: &Arc<LiveThread>,
        state: &mut LiveState,
        event: AgentEvent,
    ) -> Result<()> {
        let ctx = &live.ctx;
        let id = ctx.thread_id.as_str();
        let now = now_rfc3339();
        match event {
            AgentEvent::SessionStarted {
                provider_session_id,
                model,
            } => {
                let session_id = validate::provider_text(&provider_session_id, 256);
                let model = validate::model(model.as_deref()).ok().flatten();
                self.core.write_with_events(|tx| {
                    store::set_provider_session(tx, id, &session_id, model.as_deref())?;
                    let mut events = Vec::new();
                    if store::status(tx, id)? == ThreadStatus::Starting {
                        let from = store::set_status(tx, id, ThreadStatus::Active, None, &now)?;
                        events = ctx.status_changed(
                            EventSource::Provider,
                            from,
                            ThreadStatus::Active,
                            None,
                        );
                    }
                    Ok(((), events))
                })?;
            }
            AgentEvent::Status { status, detail } => {
                if !provider_settable(status) || state.waiting.is_some() {
                    // A held turn owns the status until it is admitted (a late idle from the
                    // previous turn must not hide the wait).
                    tracing::debug!(event = "thread.status_ignored", thread_id = %id, status = ?status);
                    return Ok(());
                }
                if !state.pending.is_empty() {
                    state.resume_status = Some(status);
                    return Ok(());
                }
                let detail = detail
                    .map(|d| validate::provider_text(&d, 160))
                    .or_else(|| {
                        (status == ThreadStatus::Idle && state.turn_failed)
                            .then(|| LAST_TURN_FAILED_ACTIVITY.to_owned())
                    });
                self.provider_transition(ctx, status, detail.as_deref())?;
            }
            AgentEvent::MessageDelta { message_id, text } => {
                let buffer = state.buffers.entry(message_id.clone()).or_default();
                if buffer.len() + text.len() <= MAX_MESSAGE_BYTES {
                    buffer.push_str(&text);
                }
                self.streams
                    .publish(id, &AgentEvent::MessageDelta { message_id, text });
            }
            AgentEvent::MessageCompleted { message_id, text } => {
                let buffered = state.buffers.remove(&message_id).unwrap_or_default();
                let content = cap_message(if text.is_empty() { buffered } else { text });
                if !content.trim().is_empty() {
                    self.persist_message(
                        ctx,
                        MessageRole::Assistant,
                        &content,
                        Some(&message_id),
                        EventSource::Provider,
                    )?;
                }
                self.streams.publish(
                    id,
                    &AgentEvent::MessageCompleted {
                        message_id,
                        text: content,
                    },
                );
            }
            AgentEvent::ToolRequested {
                tool_call_id,
                tool,
                summary,
            } => {
                let tool = validate::provider_text(&tool, 64);
                let summary = validate::provider_text(&summary, 200);
                let waiting = !state.pending.is_empty();
                let (tool_id, _) = self.core.write_with_events(|tx| {
                    let tool_id =
                        store::insert_tool_call(tx, id, &tool_call_id, &tool, &summary, &now)?;
                    if !waiting {
                        store::set_activity(tx, id, Some(&summary), &now)?;
                    }
                    let event = ctx.event(
                        EventSource::Provider,
                        EventPayload::ToolRequested {
                            thread_id: id.to_owned(),
                            tool_call_id: tool_id.clone(),
                            tool: tool.clone(),
                            summary: summary.clone(),
                        },
                    );
                    Ok((tool_id, vec![event]))
                })?;
                state.tools.insert(
                    tool_call_id,
                    ToolRef {
                        id: tool_id,
                        summary,
                        started: false,
                    },
                );
            }
            AgentEvent::ToolStarted { tool_call_id } => {
                let Some(tool) = state.tools.get_mut(&tool_call_id) else {
                    tracing::warn!(event = "thread.unknown_tool_call", thread_id = %id);
                    return Ok(());
                };
                tool.started = true;
                let tool = tool.clone();
                let waiting = !state.pending.is_empty();
                self.core.write_with_events(|tx| {
                    store::tool_started(tx, &tool.id, &now)?;
                    let mut events = vec![ctx.event(
                        EventSource::Provider,
                        EventPayload::ToolStarted {
                            thread_id: id.to_owned(),
                            tool_call_id: tool.id.clone(),
                        },
                    )];
                    if !waiting && store::status(tx, id)? != ThreadStatus::Paused {
                        let from = store::set_status(
                            tx,
                            id,
                            ThreadStatus::RunningTool,
                            Some(&tool.summary),
                            &now,
                        )?;
                        events.extend(ctx.status_changed(
                            EventSource::Provider,
                            from,
                            ThreadStatus::RunningTool,
                            Some(&tool.summary),
                        ));
                    }
                    Ok(((), events))
                })?;
                if waiting {
                    state.resume_status = Some(ThreadStatus::RunningTool);
                }
            }
            AgentEvent::ToolCompleted {
                tool_call_id,
                ok,
                summary,
            } => {
                let Some(tool) = state.tools.remove(&tool_call_id) else {
                    tracing::warn!(event = "thread.unknown_tool_call", thread_id = %id);
                    return Ok(());
                };
                let result = summary.map(|s| validate::provider_text(&s, 200));
                let still_running = state.tools.values().find(|t| t.started).cloned();
                let waiting = !state.pending.is_empty();
                self.core.write_with_events(|tx| {
                    store::tool_finished(tx, &tool.id, ok, result.as_deref(), &now)?;
                    let payload = if ok {
                        EventPayload::ToolCompleted {
                            thread_id: id.to_owned(),
                            tool_call_id: tool.id.clone(),
                        }
                    } else {
                        EventPayload::ToolFailed {
                            thread_id: id.to_owned(),
                            tool_call_id: tool.id.clone(),
                            summary: result.clone(),
                        }
                    };
                    let mut events = vec![ctx.event(EventSource::Provider, payload)];
                    if !waiting {
                        match &still_running {
                            Some(other) => {
                                store::set_activity(tx, id, Some(&other.summary), &now)?;
                            }
                            None if store::status(tx, id)? == ThreadStatus::RunningTool => {
                                let from =
                                    store::set_status(tx, id, ThreadStatus::Active, None, &now)?;
                                events.extend(ctx.status_changed(
                                    EventSource::Provider,
                                    from,
                                    ThreadStatus::Active,
                                    None,
                                ));
                            }
                            None => store::set_activity(tx, id, None, &now)?,
                        }
                    }
                    Ok(((), events))
                })?;
                if waiting && still_running.is_none() {
                    state.resume_status = Some(ThreadStatus::Active);
                }
            }
            AgentEvent::ApprovalRequired { request_id, action } => {
                self.on_approval_required(live, state, request_id, action)?;
            }
            AgentEvent::FileChanged { path, change } => {
                let Some(path) = display_path(&state.cwd, &path) else {
                    tracing::warn!(event = "thread.file_path_rejected", thread_id = %id);
                    return Ok(());
                };
                let thread_id = Some(id.to_owned());
                let payload = match change {
                    FileChange::Created => EventPayload::FileCreated {
                        thread_id,
                        path: path.clone(),
                    },
                    FileChange::Modified => EventPayload::FileModified {
                        thread_id,
                        path: path.clone(),
                    },
                    FileChange::Deleted => EventPayload::FileDeleted {
                        thread_id,
                        path: path.clone(),
                    },
                };
                self.core.write_with_events(|tx| {
                    store::record_file(tx, id, &path, change, &now)?;
                    Ok(((), vec![ctx.event(EventSource::Provider, payload)]))
                })?;
            }
            AgentEvent::Usage { usage } => {
                self.core.write_with_events(|tx| {
                    store::add_usage(
                        tx,
                        id,
                        usage.input_tokens,
                        usage.output_tokens,
                        usage.cost_usd_micros,
                    )?;
                    Ok(((), Vec::new()))
                })?;
            }
            AgentEvent::TurnCompleted { ok } => {
                // A failed turn is reported through `Error`; the turn itself is over either way.
                // An idle thread whose last turn failed says so, so status and error agree.
                self.flush_buffers(ctx, state)?;
                let interrupted = state.halted;
                state.turn_failed = !ok && !interrupted;
                self.core.emit(ctx.event(
                    EventSource::Provider,
                    EventPayload::AgentTurnCompleted {
                        thread_id: id.to_owned(),
                        ok,
                        interrupted,
                    },
                ))?;
                if state.waiting.is_some() {
                    return Ok(());
                }
                if state.pending.is_empty() {
                    let detail = state.turn_failed.then_some(LAST_TURN_FAILED_ACTIVITY);
                    self.provider_transition(ctx, ThreadStatus::Idle, detail)?;
                } else {
                    state.resume_status = Some(ThreadStatus::Idle);
                }
            }
            AgentEvent::Error {
                code,
                message,
                recoverable,
            } => {
                let code = validate::provider_code(&code, "provider_error");
                let message = validate::provider_text(&message, 300);
                if recoverable {
                    self.core.write_with_events(|tx| {
                        store::set_error(tx, id, Some((&code, &message)))?;
                        Ok((
                            (),
                            vec![ctx.event(
                                EventSource::Provider,
                                EventPayload::ProviderError {
                                    provider_id: ctx.provider_id.clone(),
                                    code: code.clone(),
                                    message: message.clone(),
                                },
                            )],
                        ))
                    })?;
                } else {
                    self.end_session(live, state, EndReason::Failed { code, message })?;
                }
            }
            AgentEvent::Exited { exit_code } => {
                self.end_session(live, state, EndReason::Exited(exit_code))?;
            }
        }
        Ok(())
    }

    /// A provider-driven status change. A paused thread stays paused until the user resumes.
    fn provider_transition(&self, ctx: &Ctx, to: ThreadStatus, detail: Option<&str>) -> Result<()> {
        let now = now_rfc3339();
        self.core.write_with_events(|tx| {
            if store::status(tx, &ctx.thread_id)? == ThreadStatus::Paused {
                return Ok(((), Vec::new()));
            }
            let from = store::set_status(tx, &ctx.thread_id, to, detail, &now)?;
            Ok((
                (),
                ctx.status_changed(EventSource::Provider, from, to, detail),
            ))
        })?;
        Ok(())
    }

    /// A runtime- or user-driven status change.
    fn transition(&self, ctx: &Ctx, to: ThreadStatus, detail: Option<&str>) -> Result<()> {
        let now = now_rfc3339();
        self.core.write_with_events(|tx| {
            let from = store::set_status(tx, &ctx.thread_id, to, detail, &now)?;
            Ok(((), ctx.status_changed(EventSource::Core, from, to, detail)))
        })?;
        Ok(())
    }

    fn persist_message(
        &self,
        ctx: &Ctx,
        role: MessageRole,
        content: &str,
        provider_message_id: Option<&str>,
        source: EventSource,
    ) -> Result<ThreadMessage> {
        let now = now_rfc3339();
        let (message, _) = self.core.write_with_events(|tx| {
            let message = store::insert_message(
                tx,
                &ctx.thread_id,
                role,
                content,
                provider_message_id,
                &now,
            )?;
            let event = ctx.event(
                source,
                EventPayload::AgentMessage {
                    thread_id: ctx.thread_id.clone(),
                    message_id: message.id.clone(),
                    role,
                },
            );
            Ok((message, vec![event]))
        })?;
        Ok(message)
    }

    /// Persists partially streamed assistant text (interrupt, stop, crash) so nothing the user
    /// saw is lost, and tells live-stream subscribers those messages are finished.
    fn flush_buffers(&self, ctx: &Ctx, state: &mut LiveState) -> Result<()> {
        for (message_id, text) in std::mem::take(&mut state.buffers) {
            let text = cap_message(text);
            if !text.trim().is_empty() {
                self.persist_message(
                    ctx,
                    MessageRole::Assistant,
                    &text,
                    Some(&message_id),
                    EventSource::Provider,
                )?;
            }
            self.streams.publish(
                &ctx.thread_id,
                &AgentEvent::MessageCompleted { message_id, text },
            );
        }
        Ok(())
    }

    fn on_approval_required(
        &self,
        live: &Arc<LiveThread>,
        state: &mut LiveState,
        provider_request_id: String,
        mut action: NormalizedAction,
    ) -> Result<()> {
        let ctx = &live.ctx;
        // Identity comes from the runtime, never from the adapter.
        action.thread_id = ctx.thread_id.clone();
        action.workspace_id = ctx.workspace_id.clone();
        action.provider_id = ctx.provider_id.clone();
        if !kalcode_contracts::ids::is_valid_id(&action.id) {
            action.id = new_id();
        }
        if action.requested_at.is_empty() {
            action.requested_at = now_rfc3339();
        }
        action.summary = validate::provider_text(&action.summary, 200);
        let Some(session) = state.session.clone() else {
            return Ok(());
        };
        let mode = self.row(&ctx.thread_id)?.permission_mode;
        let decision = self.gate.evaluate(&action, mode);
        tracing::info!(event = "thread.action_evaluated", thread_id = %ctx.thread_id, effect = ?decision.effect);
        let respond = |decision: ApprovalDecision| {
            if let Err(error) = session.respond_to_approval(&provider_request_id, decision) {
                tracing::warn!(event = "thread.approval_response_failed", thread_id = %ctx.thread_id, error = %error);
            }
        };
        match decision.effect {
            PolicyEffect::Allow => respond(ApprovalDecision::ApproveOnce),
            PolicyEffect::Deny => respond(ApprovalDecision::Deny),
            PolicyEffect::Ask => {
                let summary = action.summary.clone();
                let request = match self.gate.open_request(action, mode, decision) {
                    Ok(request) => request,
                    Err(error) => {
                        // Fail closed: an approval that can't be recorded is a denial.
                        tracing::error!(event = "thread.approval_open_failed", thread_id = %ctx.thread_id, error = %error);
                        respond(ApprovalDecision::Deny);
                        return Ok(());
                    }
                };
                if state.pending.is_empty() {
                    let current = self.row(&ctx.thread_id)?.status;
                    state.resume_status = Some(if provider_settable(current) {
                        current
                    } else {
                        ThreadStatus::Active
                    });
                }
                state.pending.insert(
                    request.id.clone(),
                    PendingApproval {
                        provider_request_id,
                        summary: summary.clone(),
                    },
                );
                let activity = format!("Waiting for approval: {summary}");
                let count = state.pending.len();
                let now = now_rfc3339();
                self.core.write_with_events(|tx| {
                    store::set_pending_approvals(tx, &ctx.thread_id, count)?;
                    let from = store::set_status(
                        tx,
                        &ctx.thread_id,
                        ThreadStatus::WaitingForPermission,
                        Some(&activity),
                        &now,
                    )?;
                    Ok((
                        (),
                        ctx.status_changed(
                            EventSource::Core,
                            from,
                            ThreadStatus::WaitingForPermission,
                            Some(&activity),
                        ),
                    ))
                })?;
                let early = {
                    let mut routes = self.lock_routes();
                    match routes.early.iter().position(|(id, _)| *id == request.id) {
                        Some(index) => routes.early.remove(index).map(|(_, r)| r),
                        None => {
                            routes
                                .by_request
                                .insert(request.id.clone(), ctx.thread_id.clone());
                            None
                        }
                    }
                };
                if let Some(resolution) = early {
                    self.apply_resolution(live, state, &request.id, resolution)?;
                }
            }
        }
        Ok(())
    }

    fn lock_routes(&self) -> MutexGuard<'_, Routes> {
        self.routes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Dispatcher thread: an `approval.*` decision arrived on the event bus.
    fn on_resolution(&self, request_id: &str, resolution: Resolution) {
        let thread_id = {
            let mut routes = self.lock_routes();
            match routes.by_request.remove(request_id) {
                Some(thread_id) => thread_id,
                None => {
                    // Not (yet) ours: it may belong to a request still being registered.
                    routes.early.push_back((request_id.to_owned(), resolution));
                    while routes.early.len() > EARLY_RESOLUTIONS_KEPT {
                        routes.early.pop_front();
                    }
                    return;
                }
            }
        };
        let Some(live) = self.existing_live(&thread_id) else {
            return;
        };
        let mut state = live.lock();
        if let Err(error) = self.apply_resolution(&live, &mut state, request_id, resolution) {
            tracing::error!(event = "thread.approval_apply_failed", thread_id = %thread_id, error = %error.diagnostic());
        }
    }

    /// Forwards a decision to the provider session and leaves `waiting_for_permission` once
    /// nothing else is pending.
    fn apply_resolution(
        &self,
        live: &Arc<LiveThread>,
        state: &mut LiveState,
        request_id: &str,
        resolution: Resolution,
    ) -> Result<()> {
        let Some(pending) = state.pending.remove(request_id) else {
            return Ok(());
        };
        let ctx = &live.ctx;
        tracing::info!(event = "thread.approval_resolved", thread_id = %ctx.thread_id, resolution = ?resolution);
        if let Some(session) = &state.session
            && let Err(error) =
                session.respond_to_approval(&pending.provider_request_id, resolution.decision())
        {
            tracing::warn!(event = "thread.approval_response_failed", thread_id = %ctx.thread_id, error = %error);
        }
        let count = state.pending.len();
        let next = state.pending.values().next().map(|p| p.summary.clone());
        let resume = if count == 0 {
            Some(state.resume_status.take().unwrap_or(ThreadStatus::Active))
        } else {
            None
        };
        let now = now_rfc3339();
        self.core.write_with_events(|tx| {
            store::set_pending_approvals(tx, &ctx.thread_id, count)?;
            let events = match (resume, &next) {
                (Some(to), _) => {
                    let from = store::set_status(tx, &ctx.thread_id, to, None, &now)?;
                    ctx.status_changed(EventSource::Core, from, to, None)
                }
                (None, Some(summary)) => {
                    store::set_activity(
                        tx,
                        &ctx.thread_id,
                        Some(&format!("Waiting for approval: {summary}")),
                        &now,
                    )?;
                    Vec::new()
                }
                (None, None) => Vec::new(),
            };
            Ok(((), events))
        })?;
        Ok(())
    }

    /// Answers every pending approval with Deny and forgets it (the turn is ending).
    fn deny_pending(&self, state: &mut LiveState) {
        let pending = std::mem::take(&mut state.pending);
        if pending.is_empty() {
            return;
        }
        {
            let mut routes = self.lock_routes();
            for request_id in pending.keys() {
                routes.by_request.remove(request_id);
            }
        }
        if let Some(session) = &state.session {
            for approval in pending.values() {
                let _ = session
                    .respond_to_approval(&approval.provider_request_id, ApprovalDecision::Deny);
            }
        }
    }

    fn end_session(
        &self,
        live: &Arc<LiveThread>,
        state: &mut LiveState,
        reason: EndReason,
    ) -> Result<()> {
        let ctx = &live.ctx;
        let had_pending = !state.pending.is_empty();
        // Ending the session ends any wait on it.
        state.waiting = None;
        if let Some(session) = &state.session
            && !matches!(reason, EndReason::Exited(_))
        {
            session.terminate().map_err(|error| {
                KalError::new(
                    ErrorCategory::Provider,
                    "provider_terminate_failed",
                    "KalCode couldn't stop the provider session. It is still tracked; try again.",
                )
                .retryable()
                .with_source(error)
            })?;
        }
        if !matches!(reason, EndReason::Exited(_)) {
            self.deny_pending(state);
        } else {
            // The process is gone; nothing can answer, so just forget the routes.
            let pending = std::mem::take(&mut state.pending);
            let mut routes = self.lock_routes();
            for request_id in pending.keys() {
                routes.by_request.remove(request_id);
            }
        }
        let _session = state.session.take();
        state.generation += 1;
        state.tools.clear();
        state.resume_status = None;
        let id = ctx.thread_id.as_str();
        // Do not publish a terminal thread state while an approval for that thread can still be
        // resolved. This external gate call remains outside the database transaction and after
        // the provider session/routes are irreversibly detached.
        self.gate.expire_for_thread(id);
        self.flush_buffers(ctx, state)?;

        let now = now_rfc3339();
        let (to, _) = self.core.write_with_events(|tx| {
            store::cancel_open_tool_calls(tx, id, &now)?;
            store::set_pending_approvals(tx, id, 0)?;
            let current = store::status(tx, id)?;
            let (to, activity, error): (ThreadStatus, Option<String>, Option<(String, String)>) =
                match &reason {
                    EndReason::Stopped { activity } => {
                        (ThreadStatus::Interrupted, Some((*activity).to_owned()), None)
                    }
                    // Neutral here: the rebind records "switched" only once the account change
                    // itself commits (it can still be refused after the session ends).
                    EndReason::AccountSwitched => (ThreadStatus::Completed, None, None),
                    EndReason::Failed { code, message } => (
                        ThreadStatus::Failed,
                        None,
                        Some((code.clone(), message.clone())),
                    ),
                    EndReason::ResourcesUnavailable { message } => (
                        ThreadStatus::Interrupted,
                        Some(RESOURCES_UNAVAILABLE_ACTIVITY.to_owned()),
                        Some((
                            error_codes::RESOURCES_UNAVAILABLE.to_owned(),
                            message.clone(),
                        )),
                    ),
                    EndReason::Exited(code) => {
                        let finished = *code == Some(0)
                            && !had_pending
                            && matches!(
                                current,
                                ThreadStatus::Idle
                                    | ThreadStatus::WaitingForUser
                                    | ThreadStatus::Paused
                            );
                        if finished {
                            (ThreadStatus::Completed, None, None)
                        } else {
                            let message = match code {
                                Some(code) => format!(
                                    "The provider stopped unexpectedly (exit code {code}). The conversation is saved; resume the thread to continue."
                                ),
                                None => "The provider stopped unexpectedly. The conversation is saved; resume the thread to continue.".to_owned(),
                            };
                            (
                                ThreadStatus::Failed,
                                None,
                                Some(("provider_exited".to_owned(), message)),
                            )
                        }
                    }
                };
            let from = store::set_status(tx, id, to, activity.as_deref(), &now)?;
            let mut events = ctx.status_changed(EventSource::Core, from, to, activity.as_deref());
            if let Some((code, message)) = &error {
                store::set_error(tx, id, Some((code, message)))?;
                // Waiting for resources ran out: nothing failed, so no failure notification.
                if !matches!(reason, EndReason::ResourcesUnavailable { .. }) {
                    events.push(ctx.event(
                        EventSource::Core,
                        EventPayload::ThreadFailed {
                            thread_id: id.to_owned(),
                            code: code.clone(),
                            message: message.clone(),
                        },
                    ));
                }
            }
            if to == ThreadStatus::Completed && !matches!(reason, EndReason::AccountSwitched) {
                events.push(ctx.event(
                    EventSource::Core,
                    EventPayload::ThreadCompleted {
                        thread_id: id.to_owned(),
                    },
                ));
            }
            Ok((to, events))
        })?;
        tracing::info!(event = "thread.session_ended", thread_id = %id, status = ?to);
        Ok(())
    }

    /// Marks a thread without a session as failed (its provider couldn't start).
    fn fail_idle_thread(&self, ctx: &Ctx, code: &str, message: &str) -> Result<()> {
        let now = now_rfc3339();
        self.core.write_with_events(|tx| {
            store::set_error(tx, &ctx.thread_id, Some((code, message)))?;
            let from = store::set_status(tx, &ctx.thread_id, ThreadStatus::Failed, None, &now)?;
            let mut events =
                ctx.status_changed(EventSource::Core, from, ThreadStatus::Failed, None);
            events.push(ctx.event(
                EventSource::Core,
                EventPayload::ThreadFailed {
                    thread_id: ctx.thread_id.clone(),
                    code: code.to_owned(),
                    message: message.to_owned(),
                },
            ));
            Ok(((), events))
        })?;
        Ok(())
    }

    /// Records a user message and sends it to the live session.
    fn send_locked(
        &self,
        live: &Arc<LiveThread>,
        state: &mut LiveState,
        text: String,
    ) -> Result<()> {
        self.deliver_locked(live, state, TurnInput::new(text), None)
    }

    fn send_locked_with_payload(
        &self,
        live: &Arc<LiveThread>,
        state: &mut LiveState,
        persisted_text: String,
        provider_payload: String,
    ) -> Result<()> {
        let redeliverable = persisted_text == provider_payload;
        let input = TurnInput {
            payload: provider_payload,
            record: Some(persisted_text),
            redeliverable,
        };
        self.deliver_locked(live, state, input, None)
    }

    /// Records the message (when it isn't yet) and sends it. A turn the Resource Governor holds
    /// waits; a message that never reached the provider stays marked for Resume.
    fn deliver_locked(
        &self,
        live: &Arc<LiveThread>,
        state: &mut LiveState,
        mut input: TurnInput,
        recheck: Recheck,
    ) -> Result<()> {
        let ctx = &live.ctx;
        let session = state.session.clone().ok_or_else(not_running)?;
        let recorded = match input.record.take() {
            Some(text) => {
                Some(self.persist_message(ctx, MessageRole::User, &text, None, EventSource::Ui)?)
            }
            None => None,
        };
        let mark_undelivered = |message: &Option<ThreadMessage>| -> Result<()> {
            if let Some(message) = message
                && input.redeliverable
            {
                self.core.write_with_events(|tx| {
                    store::set_undelivered(tx, &ctx.thread_id, &message.id)?;
                    Ok(((), Vec::new()))
                })?;
            }
            Ok(())
        };
        match session.send(AgentInput::Text {
            text: input.payload.clone(),
        }) {
            Ok(()) => {
                state.turn_failed = false;
                state.halted = false;
                // Delivered: nothing is waiting to be resent, and a new turn clears the last
                // turn's problem so status and error stay consistent.
                self.core.write_with_events(|tx| {
                    store::clear_undelivered(tx, &ctx.thread_id)?;
                    store::set_error(tx, &ctx.thread_id, None)?;
                    Ok(((), Vec::new()))
                })?;
                if state.pending.is_empty() {
                    self.transition(ctx, ThreadStatus::Active, None)?;
                }
                Ok(())
            }
            Err(ProviderError::ResourcesHeld(hold)) => {
                mark_undelivered(&recorded)?;
                self.wait_for_resources(live, state, hold, WaitFor::Turn { input }, recheck)
            }
            Err(error) => {
                tracing::warn!(event = "thread.send_failed", thread_id = %ctx.thread_id, error = %error);
                if never_delivered(&error) {
                    mark_undelivered(&recorded)?;
                }
                let name = self.row(&ctx.thread_id)?.provider_name;
                let (code, message) = describe_provider_error(&error, &name);
                self.end_session(live, state, EndReason::Failed { code, message })
            }
        }
    }

    fn send(&self, thread_id: &str, prompt: AdmittedPrompt) -> Result<()> {
        let provider_payload = prompt.text.clone();
        self.send_with_payload(thread_id, prompt, provider_payload)
    }

    fn send_with_payload(
        &self,
        thread_id: &str,
        persisted_prompt: AdmittedPrompt,
        provider_payload: String,
    ) -> Result<()> {
        let row = self.row(thread_id)?;
        if row.archived_at.is_some() {
            return Err(archived());
        }
        let live = self.existing_live(thread_id).ok_or_else(not_running)?;
        let mut state = live.lock();
        // Re-read status while holding the live-thread lock. `pause` takes the same lock before
        // committing Paused, so a send admitted just before a concurrent pause cannot use a stale
        // row to send through the still-open provider session and silently unpause the thread.
        let row = self.row(thread_id)?;
        if row.archived_at.is_some() {
            return Err(archived());
        }
        if row.status == ThreadStatus::Paused {
            return Err(KalError::validation(
                "thread_paused",
                "Resume this thread before sending another message.",
            ));
        }
        if state.waiting.is_some() {
            return Err(waiting_for_resources());
        }
        if state.session.is_none() {
            return Err(not_running());
        }
        if !state.pending.is_empty() {
            return Err(KalError::validation(
                "thread_waiting_for_permission",
                "This thread is waiting for a permission decision. Answer it or interrupt the turn first.",
            ));
        }
        self.prompt_gate.verify(
            persisted_prompt.admission,
            &row_prompt_target(&row),
            &persisted_prompt.text,
        )?;
        self.send_locked_with_payload(&live, &mut state, persisted_prompt.text, provider_payload)
    }

    /// Interrupt (→ idle) or pause (→ paused) the current turn, keeping the session.
    fn halt_turn(
        &self,
        thread_id: &str,
        to: ThreadStatus,
        activity: &'static str,
    ) -> Result<ThreadRow> {
        // Preserve the public `thread_not_found` result before consulting live runtime state.
        self.row(thread_id)?;
        let live = self.existing_live(thread_id).ok_or_else(not_running)?;
        let mut state = live.lock();
        // Status may have changed while this call waited for the per-thread authority lock.
        let row = self.row(thread_id)?;
        let session = state.session.clone().ok_or_else(not_running)?;
        let mid_turn = row.status.is_live() || row.status == ThreadStatus::WaitingForPermission;
        if mid_turn {
            if let Err(error) = session.interrupt() {
                return Err(match error {
                    ProviderError::Unsupported => KalError::new(
                        ErrorCategory::Provider,
                        "interrupt_unsupported",
                        format!(
                            "{} can't interrupt a turn. Stop the thread instead.",
                            row.provider_name
                        ),
                    ),
                    other => {
                        let (_, message) = describe_provider_error(&other, &row.provider_name);
                        KalError::new(ErrorCategory::Provider, "interrupt_failed", message)
                    }
                });
            }
        } else if to == ThreadStatus::Idle {
            return Err(KalError::validation(
                "thread_not_working",
                "This thread isn't working on anything right now.",
            ));
        }
        let had_pending = !state.pending.is_empty();
        self.deny_pending(&mut state);
        state.tools.clear();
        state.resume_status = None;
        state.halted = true;
        state.turn_failed = false;
        self.flush_buffers(&live.ctx, &mut state)?;
        let now = now_rfc3339();
        let ctx = &live.ctx;
        let (halted_row, _) = self.core.write_with_events(|tx| {
            store::cancel_open_tool_calls(tx, thread_id, &now)?;
            store::set_pending_approvals(tx, thread_id, 0)?;
            let from = store::set_status(tx, thread_id, to, Some(activity), &now)?;
            let row = store::get(tx, thread_id)?;
            Ok((
                row,
                ctx.status_changed(EventSource::Core, from, to, Some(activity)),
            ))
        })?;
        if had_pending {
            self.gate.expire_for_thread(thread_id);
        }
        Ok(halted_row)
    }

    fn stop(&self, thread_id: &str, activity: &'static str) -> Result<()> {
        self.stop_inner(thread_id, activity, None)
    }

    fn stop_bound(
        &self,
        thread_id: &str,
        activity: &'static str,
        generation: u64,
        waiting_ticket: Option<u64>,
    ) -> Result<()> {
        self.stop_inner(thread_id, activity, Some((generation, waiting_ticket)))
    }

    fn stop_inner(
        &self,
        thread_id: &str,
        activity: &'static str,
        expected: Option<(u64, Option<u64>)>,
    ) -> Result<()> {
        let row = self.row(thread_id)?;
        if let Some(live) = self.existing_live(thread_id) {
            let mut state = live.lock();
            if let Some((generation, waiting_ticket)) = expected {
                let same = state.generation == generation
                    && match waiting_ticket {
                        Some(ticket) => {
                            state.session.is_none()
                                && state
                                    .waiting
                                    .as_ref()
                                    .is_some_and(|wait| wait.ticket == ticket)
                        }
                        None => state.session.is_some(),
                    };
                if !same {
                    return Err(stop_target_changed());
                }
            }
            // Stopping ends a wait for system resources: its waiter sees no current ticket. The
            // held message stays recorded and marked, so Resume sends it.
            if state.waiting.take().is_some() {
                self.core.write_with_events(|tx| {
                    store::set_error(tx, thread_id, None)?;
                    Ok(((), Vec::new()))
                })?;
                if state.session.is_none() {
                    return self.transition(
                        &Ctx::from_row(&row),
                        ThreadStatus::Interrupted,
                        Some(activity),
                    );
                }
            }
            if state.session.is_some() {
                return self.end_session(&live, &mut state, EndReason::Stopped { activity });
            }
        } else if expected.is_some() {
            return Err(stop_target_changed());
        }
        if row.status.is_terminal() {
            return Err(not_running());
        }
        // No session but not final (e.g. a start that never completed): record the stop.
        self.transition(
            &Ctx::from_row(&row),
            ThreadStatus::Interrupted,
            Some(activity),
        )
    }

    fn resume(&self, thread_id: &str, text: Option<AdmittedPrompt>) -> Result<()> {
        let row = self.row(thread_id)?;
        if row.archived_at.is_some() {
            return Err(archived());
        }
        if let Some(live) = self.existing_live(thread_id) {
            let mut state = live.lock();
            if state.waiting.is_some() {
                return Err(waiting_for_resources());
            }
            if state.session.is_some() {
                if row.status != ThreadStatus::Paused {
                    return Err(KalError::validation(
                        "thread_already_running",
                        "This thread is already running.",
                    ));
                }
                if let Some(text) = text {
                    self.prompt_gate.verify(
                        text.admission,
                        &row_prompt_target(&row),
                        &text.text,
                    )?;
                    self.transition(&live.ctx, ThreadStatus::Idle, None)?;
                    self.send_locked(&live, &mut state, text.text)?;
                } else {
                    self.transition(&live.ctx, ThreadStatus::Idle, None)?;
                }
                return Ok(());
            }
        }
        self.admit_agent()?;
        let entry = self
            .providers
            .get(&row.provider_id)
            .ok_or_else(|| provider_unavailable(&row.provider_name))?;
        let workspace = self.workspaces.resolve(&row.workspace_id)?;
        // A thread with its own worktree never runs in the workspace folder: it keeps its folder
        // while that exists, and otherwise gets it back from its branch, or doesn't start.
        let cwd = if !row.isolated {
            workspace.root.to_string_lossy().into_owned()
        } else if row.worktree_id.is_some() && Path::new(&row.cwd).is_dir() {
            row.cwd.clone()
        } else {
            let hooks = self.worktrees.get().ok_or_else(thread_folder_unavailable)?;
            let cwd = hooks.reattach(thread_id).map_err(|error| {
                tracing::warn!(event = "thread.worktree_reattach_failed", thread_id, error = %error.diagnostic());
                thread_folder_unavailable()
            })?;
            if !(cwd.is_absolute() && cwd.is_dir()) {
                return Err(thread_folder_unavailable());
            }
            cwd.to_string_lossy().into_owned()
        };
        let capabilities = entry.provider.capabilities();
        let has_history = self
            .core
            .read(|conn| store::messages(conn, thread_id, 1, None))?
            .into_iter()
            .next()
            .is_some();
        let ctx = Ctx::from_row(&row);
        let now = now_rfc3339();
        self.core.write_with_events(|tx| {
            // A thread keeps its own account: when that account was removed from KalCode, say
            // so instead of launching (or falling back to another account).
            let current = store::get(tx, thread_id)?;
            if let Some(account_id) = &current.provider_account_id
                && store::account(tx, account_id)?.is_some_and(|account| account.archived)
            {
                return Err(thread_account_archived());
            }
            // A prompt is admitted for the account the thread had when it was reviewed. If a
            // rebind committed since, refuse here, before `starting`, so the thread keeps its
            // status and the person can simply resume again under the new account.
            if let Some(admitted) = &text
                && admitted.target.provider_account_id != current.provider_account_id
            {
                return Err(thread_account_changed());
            }
            store::set_cwd(tx, thread_id, &cwd, &workspace.name)?;
            // New text supersedes a message that never reached the provider.
            if text.is_some() {
                store::clear_undelivered(tx, thread_id)?;
            }
            let from = store::set_status(
                tx,
                thread_id,
                ThreadStatus::Starting,
                Some("Resuming"),
                &now,
            )?;
            Ok((
                (),
                ctx.status_changed(
                    EventSource::Core,
                    from,
                    ThreadStatus::Starting,
                    Some("Resuming"),
                ),
            ))
        })?;
        // Read the account and resume id after the `starting` write: a rebind that committed
        // before it is seen here, and one after it is refused as busy. So a resume id is never
        // paired with a different account than the one it was recorded under.
        let row = self.row(thread_id)?;
        let resume_id = if capabilities.resume {
            row.provider_session_id.clone()
        } else {
            None
        };
        let notice = (resume_id.is_none() && has_history).then_some(NEW_SESSION_NOTICE);
        // Without new text, Resume delivers the message a held or refused start never sent.
        let redeliver = if text.is_none() {
            self.core.read(|conn| store::undelivered(conn, thread_id))?
        } else {
            None
        };
        self.start_session(&row, &entry, resume_id, text, notice, redeliver)
    }

    fn rebind_account(&self, thread_id: &str, account_id: &str) -> Result<ThreadRow> {
        let row = self.row(thread_id)?;
        if row.archived_at.is_some() {
            return Err(archived());
        }
        let account = self.core.read(|conn| store::account(conn, account_id))?;
        rebind_target(account, &row.provider_id)?;
        if row.provider_account_id.as_deref() == Some(account_id) {
            return Ok(row);
        }
        // Hold the thread's authority lock (when it has live state) so no turn can start on the
        // old session between the busy check and the write.
        let live = self.existing_live(thread_id);
        let mut state = live.as_ref().map(|live| live.lock());
        let row = self.row(thread_id)?;
        let pending = state.as_ref().map_or(0, |state| state.pending.len());
        if state.as_ref().is_some_and(|state| state.waiting.is_some()) {
            return Err(KalError::validation(
                "thread_rebind_busy",
                "Wait for the current turn to finish or stop the thread first.",
            ));
        }
        rebind_ready(&row, pending)?;
        let ended_session = if let (Some(live), Some(state)) = (&live, state.as_mut())
            && state.session.is_some()
        {
            self.end_session(live, state, EndReason::AccountSwitched)?;
            true
        } else {
            false
        };
        let now = now_rfc3339();
        let ctx = Ctx::from_row(&row);
        let (row, _) = self.core.write_with_events(|tx| {
            // Authoritative re-checks in the write transaction: a resume that marked the thread
            // `starting`, an archive of the thread, or an archive of the account since the
            // checks above all refuse instead of rebinding.
            let current = store::get(tx, thread_id)?;
            if current.archived_at.is_some() {
                return Err(archived());
            }
            rebind_ready(&current, 0)?;
            let account = rebind_target(store::account(tx, account_id)?, &current.provider_id)?;
            store::set_account(tx, thread_id, account_id, Some(&account.display_name))?;
            // A message admitted for the old account is never sent automatically to the new one.
            store::clear_undelivered(tx, thread_id)?;
            if ended_session {
                store::set_activity(tx, thread_id, Some(ACCOUNT_SWITCHED_ACTIVITY), &now)?;
            }
            let row = store::get(tx, thread_id)?;
            let event = ctx.event(
                EventSource::Ui,
                EventPayload::ThreadAccountChanged {
                    thread_id: thread_id.to_owned(),
                    provider_account_id: account_id.to_owned(),
                    account_label: row.account_label.clone(),
                },
            );
            Ok((row, vec![event]))
        })?;
        drop(state);
        tracing::info!(event = "thread.account_changed", thread_id = %thread_id);
        Ok(row)
    }

    fn rename(&self, thread_id: &str, name: &str) -> Result<()> {
        let row = self.row(thread_id)?;
        if row.name == name {
            return Ok(());
        }
        let ctx = Ctx::from_row(&row);
        self.core.write_with_events(|tx| {
            store::rename(tx, thread_id, name)?;
            Ok((
                (),
                vec![ctx.event(
                    EventSource::Ui,
                    EventPayload::ThreadRenamed {
                        thread_id: thread_id.to_owned(),
                        name: name.to_owned(),
                    },
                )],
            ))
        })?;
        Ok(())
    }

    fn archive(&self, thread_id: &str) -> Result<()> {
        let row = self.row(thread_id)?;
        if row.archived_at.is_some() {
            return Ok(());
        }
        if let Some(live) = self.existing_live(thread_id) {
            let mut state = live.lock();
            let running =
                || KalError::validation("thread_running", "Stop the thread before archiving it.");
            if state.waiting.is_some() {
                return Err(running());
            }
            if state.session.is_some() {
                // An idle session (no turn, no approval) ends with the archive; anything that is
                // working or paused mid-turn must be stopped first.
                let status = self.row(thread_id)?.status;
                if !matches!(status, ThreadStatus::Idle | ThreadStatus::WaitingForUser) {
                    return Err(running());
                }
                self.end_session(
                    &live,
                    &mut state,
                    EndReason::Stopped {
                        activity: ARCHIVED_ACTIVITY,
                    },
                )?;
            }
        }
        let ctx = Ctx::from_row(&row);
        let now = now_rfc3339();
        self.core.write_with_events(|tx| {
            store::archive(tx, thread_id, &now)?;
            store::clear_undelivered(tx, thread_id)?;
            Ok((
                (),
                vec![ctx.event(
                    EventSource::Ui,
                    EventPayload::ThreadArchived {
                        thread_id: thread_id.to_owned(),
                    },
                )],
            ))
        })?;
        self.live
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(thread_id);
        Ok(())
    }

    fn unarchive(&self, thread_id: &str) -> Result<()> {
        let row = self.row(thread_id)?;
        if row.archived_at.is_none() {
            return Ok(());
        }
        let ctx = Ctx::from_row(&row);
        self.core.write_with_events(|tx| {
            // Only a row that is still archived records the event (a concurrent restore wins once).
            let events = if store::unarchive(tx, thread_id)? {
                vec![ctx.event(
                    EventSource::Ui,
                    EventPayload::ThreadUnarchived {
                        thread_id: thread_id.to_owned(),
                    },
                )]
            } else {
                Vec::new()
            };
            Ok(((), events))
        })?;
        Ok(())
    }

    fn set_permission_mode(
        &self,
        thread_id: &str,
        mode: PermissionMode,
        profile_id: Option<&str>,
    ) -> Result<()> {
        // Exists (or `thread_not_found`), then store; the permission engine records the event.
        self.row(thread_id)?;
        self.core.write_with_events(|tx| {
            store::set_permission_mode(tx, thread_id, mode, profile_id)?;
            Ok(((), Vec::new()))
        })?;
        Ok(())
    }
}

fn archived() -> KalError {
    KalError::validation("thread_archived", "This thread is archived.")
}

fn waiting_for_resources() -> KalError {
    KalError::validation(
        "thread_waiting_for_resources",
        "This thread is waiting for system resources and starts on its own. Stop it to cancel.",
    )
}

fn thread_account_changed() -> KalError {
    KalError::validation(
        "thread_account_changed",
        "This thread was switched to another account while your message was being sent. Nothing was sent; send it again.",
    )
}

fn thread_account_archived() -> KalError {
    KalError::validation(
        "provider_account_archived",
        "This thread's account was removed from KalCode. Switch the thread to an active account to continue.",
    )
}

/// The account a thread may be rebound to: an existing, active account of the thread's provider.
fn rebind_target(
    account: Option<store::AccountRef>,
    provider_id: &ProviderId,
) -> Result<store::AccountRef> {
    let account = account.ok_or_else(|| {
        KalError::validation(
            "provider_account_unknown",
            "That provider account no longer exists.",
        )
    })?;
    if account.provider_id != *provider_id {
        return Err(KalError::validation(
            "provider_account_mismatch",
            "That account belongs to a different provider.",
        ));
    }
    if account.archived {
        return Err(KalError::validation(
            "provider_account_archived",
            "That account was removed from KalCode. Reconnect it or choose an active account.",
        ));
    }
    Ok(account)
}

/// A rebind waits for a quiet thread: no turn starting or running, no approval pending (an
/// approved action would otherwise run under the wrong account).
fn rebind_ready(row: &ThreadRow, live_pending: usize) -> Result<()> {
    if row.status == ThreadStatus::WaitingForPermission
        || row.pending_approvals > 0
        || live_pending > 0
    {
        return Err(KalError::validation(
            "thread_rebind_pending_approval",
            "Answer or deny the pending approval, or stop the thread, before switching accounts.",
        ));
    }
    if row.status.is_live() {
        return Err(KalError::validation(
            "thread_rebind_busy",
            "Wait for the current turn to finish or stop the thread first.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_inside_the_workspace_are_relative() {
        assert_eq!(
            display_path("/home/u/repo", "/home/u/repo/src/main.rs").as_deref(),
            Some("src/main.rs")
        );
        assert_eq!(
            display_path("/home/u/repo/", "/home/u/repository/x").as_deref(),
            Some("/home/u/repository/x")
        );
        assert_eq!(display_path("/r", "src/a.rs").as_deref(), Some("src/a.rs"));
        assert_eq!(display_path("/r", "bad\u{0}path"), None);
        assert_eq!(display_path("/r", ""), None);
        if cfg!(windows) {
            assert_eq!(
                display_path(r"C:\Users\K\repo", r"c:\users\k\repo\src\a.rs").as_deref(),
                Some("src/a.rs")
            );
        }
    }

    #[test]
    fn oversized_messages_are_truncated_on_a_char_boundary() {
        let text = "é".repeat(MAX_MESSAGE_BYTES);
        let capped = cap_message(text);
        assert!(capped.ends_with(TRUNCATION_NOTE));
        assert!(capped.len() <= MAX_MESSAGE_BYTES + TRUNCATION_NOTE.len());
        assert_eq!(cap_message("short".into()), "short");
    }

    #[test]
    fn providers_cannot_set_runtime_owned_statuses() {
        for status in [
            ThreadStatus::Starting,
            ThreadStatus::WaitingForPermission,
            ThreadStatus::Paused,
            ThreadStatus::Completed,
            ThreadStatus::Failed,
            ThreadStatus::Interrupted,
            ThreadStatus::Recovering,
            ThreadStatus::Offline,
        ] {
            assert!(!provider_settable(status), "{status:?}");
        }
        assert!(provider_settable(ThreadStatus::Thinking));
    }

    #[test]
    fn provider_errors_are_user_safe() {
        let (code, message) = describe_provider_error(
            &ProviderError::Start("C:\\secret\\claude.exe: boom".into()),
            "Claude Code",
        );
        assert_eq!(code, "provider_start_failed");
        assert!(!message.contains("secret"));
        assert!(message.contains("Claude Code"));
    }

    #[test]
    fn a_signed_out_account_points_to_its_providers_sign_in() {
        let (code, message) =
            describe_provider_error(&ProviderError::NotAuthenticated, "Gemini CLI");
        assert_eq!(code, "provider_not_authenticated");
        assert_eq!(
            message,
            "Gemini CLI isn't signed in for this account. Sign in to this Gemini CLI account in \
             Providers, then resume this thread."
        );
        assert!(!message.contains("terminal"), "{message}");
    }
}
