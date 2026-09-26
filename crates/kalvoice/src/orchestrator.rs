//! KalVoice request orchestration (docs/KALVOICE.md, "Command pipeline").
//!
//! ```text
//! request ─▶ allowance check ─▶ grammar ─▶ deterministic intent ─▶ runtime check ─▶ count ─▶ execute
//!                                   └▶ local interpreter ─▶ validated intent ────────┘
//! ```
//!
//! - One top-level request counts once, when KalVoice executes a validated command. Requests
//!   refused up front — limit reached, missing local runtime, uncertain/invalid interpretation, a
//!   workspace that doesn't exist, a command this build can't run — are not counted. Retrying a
//!   client request id never counts twice or runs twice.
//! - Deterministic app-control commands run immediately through the same workspace/runtime APIs
//!   as direct UI gestures. Provider sessions retain their own native permission prompts for
//!   consequential work; KalVoice does not create a second approval in front of app control.
//!   A permission-mode request still only opens the thread for the person to decide.
//! - Events carry ids and facts only; request text, transcripts and interpreter output never
//!   appear in them. State and events commit together and are published after commit.

use std::collections::HashSet;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use kalcode_contracts::agent::{AgentProvider, ProviderId, SessionConfig};
use kalcode_contracts::app::SurfaceId;
use kalcode_contracts::events::{Correlation, EventPayload, EventSource, NewEvent};
use kalcode_contracts::ids::{is_valid_id, new_id};
pub use kalcode_contracts::kalvoice::TalkRoute;
use kalcode_contracts::kalvoice::{
    BrowserControl, KalVoiceInput, KalVoiceIntent, KalVoiceOutcome, KalVoiceUsage, PaneControl,
    PaneDirection, RequestableMode, ThreadScope,
};
use kalcode_contracts::threads::WorkspaceOption;
use kalcode_contracts::workspace_ui::SplitAxis;
use kalcode_core::{Core, KalError, Result};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use ts_rs::TS;

use crate::grammar::{self, Confidence, NamedTarget, Understood};
use crate::ledger::{self, Consumption, ExecutionResult, RequestExecution};
use crate::local_reasoning::{
    LOCAL_REASONING_FAILED_MESSAGE, LOCAL_REASONING_INVALID_OUTPUT_MESSAGE,
    LOCAL_REASONING_UNAVAILABLE_MESSAGE, LOCAL_REASONING_UNCERTAIN_MESSAGE, LocalInterpretation,
    LocalInterpretationCancellation, LocalInterpretationError, LocalInterpretationRequest,
    LocalInterpreter, NoLocalInterpreter, bounded_workspace_snapshot, validate_action,
};
use crate::plan::EntitlementSource;
use crate::prefs::{self, KalVoicePreferences, KalVoicePreferencesPatch};

/// Longest request KalVoice accepts (typed or transcribed).
pub const MAX_REQUEST_CHARS: usize = 4_000;

/// Local interpretation is deliberately short: app control must remain responsive, and a late
/// model result must never become an action after the caller has already observed a timeout.
const LOCAL_INTERPRETATION_TIMEOUT: Duration = Duration::from_millis(1_500);
/// Cooperative implementations settle in a few polling intervals. This separate bound prevents
/// a broken implementation from turning request cancellation into an indefinite join.
const LOCAL_INTERPRETATION_SETTLE_TIMEOUT: Duration = Duration::from_millis(250);
const LOCAL_INTERPRETATION_TIMEOUT_MESSAGE: &str =
    "The on-device KalVoice interpreter took too long to respond.";
const LOCAL_INTERPRETATION_BUSY_MESSAGE: &str =
    "KalVoice is already interpreting another request. Try again in a moment.";

/// Where a request is in the pipeline (for the assistant's state display).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum RequestStage {
    /// Understanding the request, including optional on-device interpretation.
    Thinking,
    /// Running a command through the runtime.
    Executing,
}

/// What had focus when the push-to-talk key went down.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum TalkTarget {
    /// A text box (composer, search, form field).
    Field,
    /// A terminal or provider pane (text goes to its PTY).
    Terminal,
    /// Nothing that accepts text.
    None,
}

/// One push-to-talk utterance after recognition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TalkRequest {
    /// Client-generated UUID for the request, if it becomes one.
    pub request_id: String,
    pub session_id: String,
    pub text: String,
    pub target: TalkTarget,
    pub duration_ms: u64,
    pub workspace_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TalkResponse {
    pub route: TalkRoute,
    /// The command or request result (none for dictation).
    pub response: Option<KalVoiceResponse>,
    /// Final transcript → route decided, in milliseconds.
    pub recognized_ms: f64,
}

/// Decides what an utterance was meant as (docs/KALVOICE.md, "One gesture"):
/// a command when the grammar recognizes it with high confidence (or at all, when nothing that
/// takes text had focus); otherwise text for the focused input; otherwise a request.
pub fn talk_route(text: &str, target: TalkTarget) -> TalkRoute {
    let (understood, confidence) = grammar::understand_with_confidence(text);
    let command_like = match &understood {
        Understood::Intent { intent, .. } => !intent.needs_reasoning(),
        Understood::Rejected { code, .. } => *code != "empty_request",
    };
    match (command_like, confidence, target) {
        (true, Confidence::High, _) | (true, _, TalkTarget::None) => TalkRoute::Command,
        (_, _, TalkTarget::Field | TalkTarget::Terminal) => TalkRoute::Dictation,
        _ => TalkRoute::Request,
    }
}

/// A top-level command request from the command bar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CommandRequest {
    /// Client-generated UUID; the idempotency key for usage.
    pub request_id: String,
    pub text: String,
    pub input: KalVoiceInput,
    /// The workspace the user is looking at, if any.
    pub workspace_id: Option<String>,
}

/// Something the UI does as part of a result (navigation lives in the UI).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum UiDirective {
    Navigate {
        surface: SurfaceId,
    },
    OpenWorkspace {
        workspace_id: String,
    },
    OpenThread {
        thread_id: String,
    },
    OpenTerminal {
        workspace_id: String,
        terminal_id: String,
    },
    /// Opens genuine provider CLI sessions in the selected workspace.
    OpenProviderPanes {
        workspace_id: String,
        thread_ids: Vec<String>,
    },
    /// Applies a deterministic layout operation to the selected workspace.
    ControlPane {
        workspace_id: String,
        command: PaneControl,
    },
    /// Applies one bounded action to KalCode's embedded browser pane.
    ControlBrowser {
        workspace_id: String,
        command: BrowserControl,
    },
    /// Opens the approvals panel.
    ShowApprovals,
    // ---- Pane layout (Z7-W1). Layout only: nothing starts, stops or closes a process. ----
    /// Split the focused pane (`horizontal` = side by side, `vertical` = stacked).
    SplitPane {
        axis: SplitAxis,
    },
    /// Put the panes of these providers' threads next to each other.
    ArrangePanes {
        axis: SplitAxis,
        provider_ids: Vec<ProviderId>,
    },
    /// Grow the focused pane toward `direction` by `steps` steps.
    ResizePane {
        direction: PaneDirection,
        steps: u8,
    },
    /// Close the pane whose title matches `query`, or the focused one. What it runs keeps
    /// running.
    ClosePane {
        query: Option<String>,
    },
    /// Shows the Dashboard filtered by a chip (Z7-W3).
    FilterDashboard {
        chip: kalcode_contracts::workspace_ui::DashboardChip,
    },
    /// Opens search with this query (Session Locator, Z7-W2).
    Search {
        query: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KalVoiceResponse {
    pub request_id: String,
    /// Stable intent name (`navigate`, `create_threads`, `reasoning`, …) once understood.
    pub intent: Option<String>,
    pub outcome: KalVoiceOutcome,
    pub usage: KalVoiceUsage,
    /// Whether this request counted against the allowance.
    pub counted: bool,
    pub directive: Option<UiDirective>,
}

/// A failure from the runtime, with a user-safe message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecError {
    pub code: String,
    pub message: String,
}

impl ExecError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Executed {
    pub summary: String,
    pub directive: Option<UiDirective>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecContext {
    pub request_id: String,
    pub workspace_id: Option<String>,
    /// Providers a pane layout command named ("split Claude and Codex side by side"), in order.
    pub providers: Vec<ProviderId>,
}

/// The runtime APIs KalVoice drives — the same ones the UI uses. The desktop implements this.
pub trait Executor: Send + Sync {
    /// Native-resolved workspaces safe to name in local interpretation. Paths never cross this
    /// boundary. The default is empty so incomplete adapters fail closed for workspace actions.
    fn workspace_options(&self) -> std::result::Result<Vec<WorkspaceOption>, ExecError> {
        Ok(Vec::new())
    }
    /// Resolves a spoken workspace name to its id.
    fn find_workspace(&self, name: &str) -> std::result::Result<Option<String>, ExecError>;
    /// Resolves a spoken thread name to its id.
    fn find_thread(&self, name: &str) -> std::result::Result<Option<String>, ExecError>;
    /// Whether this build can run `intent` at all. Checked before asking for permission or
    /// counting the request.
    fn check(&self, intent: &KalVoiceIntent) -> std::result::Result<(), ExecError>;
    fn execute(
        &self,
        intent: &KalVoiceIntent,
        ctx: &ExecContext,
    ) -> std::result::Result<Executed, ExecError>;
}

/// A provider the user connected, as KalVoice sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProviderChoice {
    pub id: ProviderId,
    pub display_name: String,
    /// Installed and signed in right now.
    pub available: bool,
}

/// Legacy provider-directory compatibility API. KalVoice interpretation never calls it; native
/// consumers may retain it while their constructor wiring migrates.
pub trait ProviderDirectory: Send + Sync {
    fn connected(&self) -> Vec<ProviderChoice>;
    fn provider(&self, id: &ProviderId) -> Option<Arc<dyn AgentProvider>>;
    /// Session settings for a read-only reasoning session (native-resolved working directory).
    fn session_config(&self, request_id: &str, workspace_id: Option<&str>)
    -> Option<SessionConfig>;

    /// Atomically selects the provider adapter and its account-bound configuration. Native
    /// runtimes override this so concurrent requests cannot pair one provider/account selection
    /// with another request's configuration. The default preserves isolated legacy test fakes.
    fn provider_session(
        &self,
        id: &ProviderId,
        request_id: &str,
        workspace_id: Option<&str>,
    ) -> Option<(Arc<dyn AgentProvider>, SessionConfig)> {
        Some((
            self.provider(id)?,
            self.session_config(request_id, workspace_id)?,
        ))
    }
}

/// No providers connected (the provider runtime is not part of this build yet).
#[derive(Debug, Default, Clone, Copy)]
pub struct NoProviders;

impl ProviderDirectory for NoProviders {
    fn connected(&self) -> Vec<ProviderChoice> {
        Vec::new()
    }
    fn provider(&self, _id: &ProviderId) -> Option<Arc<dyn AgentProvider>> {
        None
    }
    fn session_config(
        &self,
        _request_id: &str,
        _workspace_id: Option<&str>,
    ) -> Option<SessionConfig> {
        None
    }
}

/// User-facing provider name ("Claude is currently unavailable…").
pub fn provider_display_name(id: &ProviderId) -> String {
    match id.as_str() {
        ProviderId::CLAUDE_CODE => "Claude".into(),
        ProviderId::CODEX => "Codex".into(),
        ProviderId::GEMINI_CLI => "Gemini".into(),
        other => other.to_owned(),
    }
}

type Clock = Arc<dyn Fn() -> OffsetDateTime + Send + Sync>;

pub struct Orchestrator {
    core: Arc<Core>,
    entitlement: Option<Arc<dyn EntitlementSource>>,
    accounting: Option<Arc<dyn crate::accounting::RequestAccounting>>,
    executor: Arc<dyn Executor>,
    local_interpreter: Arc<dyn LocalInterpreter>,
    clock: Clock,
    execution_owner: String,
    active_claims: Arc<Mutex<HashSet<String>>>,
    local_interpretation_active: Arc<AtomicBool>,
    local_interpretation_state: Mutex<LocalInterpretationState>,
}

impl Orchestrator {
    pub fn new(
        core: Arc<Core>,
        entitlement: Arc<dyn EntitlementSource>,
        executor: Arc<dyn Executor>,
        _providers: Arc<dyn ProviderDirectory>,
    ) -> Self {
        Self {
            core,
            entitlement: Some(entitlement),
            accounting: None,
            executor,
            local_interpreter: Arc::new(NoLocalInterpreter),
            clock: Arc::new(OffsetDateTime::now_utc),
            execution_owner: new_id(),
            active_claims: Arc::new(Mutex::new(HashSet::new())),
            local_interpretation_active: Arc::new(AtomicBool::new(false)),
            local_interpretation_state: Mutex::new(LocalInterpretationState::default()),
        }
    }

    /// Production account authority replaces the provisional device-only allowance.
    pub fn new_accounted(
        core: Arc<Core>,
        accounting: Arc<dyn crate::accounting::RequestAccounting>,
        executor: Arc<dyn Executor>,
    ) -> Self {
        Self {
            core,
            entitlement: None,
            accounting: Some(accounting),
            executor,
            local_interpreter: Arc::new(NoLocalInterpreter),
            clock: Arc::new(OffsetDateTime::now_utc),
            execution_owner: new_id(),
            active_claims: Arc::new(Mutex::new(HashSet::new())),
            local_interpretation_active: Arc::new(AtomicBool::new(false)),
            local_interpretation_state: Mutex::new(LocalInterpretationState::default()),
        }
    }

    /// Tests can combine existing execution fixtures with account accounting.
    pub fn with_accounting(
        mut self,
        accounting: Arc<dyn crate::accounting::RequestAccounting>,
    ) -> Self {
        self.accounting = Some(accounting);
        self
    }

    fn execution_id(&self, request_id: &str) -> String {
        self.accounting.as_ref().map_or_else(
            || request_id.to_owned(),
            |accounting| crate::accounting::execution_id(accounting.account_id(), request_id),
        )
    }

    /// Tests: a fixed clock.
    pub fn with_clock(
        mut self,
        clock: impl Fn() -> OffsetDateTime + Send + Sync + 'static,
    ) -> Self {
        self.clock = Arc::new(clock);
        self
    }

    /// Injects the supported on-device structured-action interpreter. Without one, requests that
    /// fall outside the deterministic grammar fail honestly and remain uncounted.
    pub fn with_local_interpreter(mut self, interpreter: Arc<dyn LocalInterpreter>) -> Self {
        self.local_interpreter = interpreter;
        self
    }

    /// Cancels the current local inference and proves its worker thread has settled within the
    /// caller's bound. A `false` result leaves the operation and its join handle retained so a
    /// later drain can finish cleanup; admission remains closed in the meantime.
    pub fn drain_local_interpretation(&self, timeout: Duration) -> bool {
        let Some(operation) = self.current_local_interpretation() else {
            return true;
        };
        operation.cancellation.cancel();
        let deadline = Instant::now() + timeout;
        if operation.wait_until(deadline).is_none() {
            return false;
        }
        self.finish_local_interpretation(&operation, deadline)
    }

    /// Permanently seals local inference admission, cancels the admitted operation (if any), and
    /// returns only when cleanup is proved within `timeout`. Registration and sealing share one
    /// lock, so a request cannot publish a new worker after an empty shutdown reports success.
    pub fn shutdown_local_interpretation(&self, timeout: Duration) -> bool {
        let operation = {
            let mut state = self
                .local_interpretation_state
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            state.sealed = true;
            state.operation.clone()
        };
        let Some(operation) = operation else {
            return true;
        };
        operation.cancellation.cancel();
        let deadline = Instant::now() + timeout;
        if operation.wait_until(deadline).is_none() {
            return false;
        }
        self.finish_local_interpretation(&operation, deadline)
    }

    fn current_local_interpretation(&self) -> Option<Arc<LocalInterpretationOperation>> {
        self.local_interpretation_state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .operation
            .clone()
    }

    fn finish_local_interpretation(
        &self,
        operation: &Arc<LocalInterpretationOperation>,
        deadline: Instant,
    ) -> bool {
        let Some(joined) = operation.join_until(deadline) else {
            return false;
        };
        let mut state = self
            .local_interpretation_state
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if state
            .operation
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, operation))
        {
            state.operation.take();
        }
        joined
    }

    /// Reaps a worker which settled after its request returned. The retained permit is dropped
    /// before a new request attempts admission.
    fn reap_local_interpretation(&self) -> bool {
        let Some(operation) = self.current_local_interpretation() else {
            return true;
        };
        if !operation.is_complete() {
            return false;
        }
        let reaped = self.finish_local_interpretation(
            &operation,
            Instant::now() + LOCAL_INTERPRETATION_SETTLE_TIMEOUT,
        );
        drop(operation);
        reaped
    }

    fn allowance(&self) -> (Option<u32>, u8) {
        // Account accounting owns quota; this ledger remains the durable execution fence.
        if self.accounting.is_some() {
            return (None, ledger::DEFAULT_CYCLE_ANCHOR_DAY);
        }
        (
            self.entitlement.as_ref().map_or(Some(0), |entitlement| {
                entitlement.tier().kalvoice_allowance()
            }),
            self.entitlement
                .as_ref()
                .map_or(1, |entitlement| entitlement.cycle_anchor_day()),
        )
    }

    /// Current usage (for "N / 75 used · remaining · renews …" on Free).
    pub fn usage(&self) -> Result<KalVoiceUsage> {
        if let Some(accounting) = &self.accounting {
            return accounting.usage();
        }
        let (allowance, anchor) = self.allowance();
        let now = (self.clock)();
        self.core.read(|c| ledger::usage(c, now, anchor, allowance))
    }

    pub fn preferences(&self) -> Result<KalVoicePreferences> {
        self.core.read(prefs::load)
    }

    /// Validates and saves preferences; emits `settings.changed` and preserves the legacy
    /// `kalvoice.provider_selected` event when that stored preference changes.
    pub fn update_preferences(
        &self,
        patch: &KalVoicePreferencesPatch,
    ) -> Result<KalVoicePreferences> {
        let (prefs, _) = self.core.transact(|tx| {
            let (prefs, changes) = prefs::apply(tx, patch)?;
            let mut events = Vec::new();
            if !changes.keys.is_empty() {
                events.push(event(
                    EventPayload::SettingsChanged { keys: changes.keys },
                    Correlation::default(),
                ));
            }
            if let Some(Some(intelligence)) = changes.intelligence {
                events.push(event(
                    EventPayload::KalVoiceProviderSelected {
                        intelligence,
                        scope: "global".into(),
                    },
                    Correlation::default(),
                ));
            }
            Ok((prefs, events))
        })?;
        Ok(prefs)
    }

    fn emit(&self, events: Vec<NewEvent>) {
        if events.is_empty() {
            return;
        }
        if let Err(error) = self.core.transact(|_| Ok(((), events))) {
            tracing::warn!(event = "kalvoice.event_failed", error = %error.diagnostic());
        }
    }

    /// Handles one top-level request. A configured local interpreter may block, so call from a
    /// background thread.
    pub fn handle(&self, req: CommandRequest) -> Result<KalVoiceResponse> {
        self.handle_with_stages(req, &|_| {})
    }

    /// As [`Self::handle`], reporting each pipeline stage as it starts.
    pub fn handle_with_stages(
        &self,
        req: CommandRequest,
        on_stage: &dyn Fn(RequestStage),
    ) -> Result<KalVoiceResponse> {
        if !is_valid_id(&req.request_id) {
            return Err(KalError::validation(
                "invalid_request_id",
                "KalVoice received an invalid request id.",
            ));
        }
        if req.text.chars().count() > MAX_REQUEST_CHARS {
            return Err(KalError::validation(
                "request_too_long",
                format!("KalVoice requests can be up to {MAX_REQUEST_CHARS} characters."),
            ));
        }
        if req.workspace_id.as_deref().is_some_and(|w| !is_valid_id(w)) {
            return Err(KalError::validation(
                "invalid_workspace",
                "That workspace id is invalid.",
            ));
        }

        let (allowance, anchor) = self.allowance();
        let now = (self.clock)();
        // Serialize this read with request claims so a newly inserted claim is never observed
        // before its in-process owner is marked active.
        let account_usage = self
            .accounting
            .as_ref()
            .map(|accounting| accounting.usage())
            .transpose()?;
        let execution_id = self.execution_id(&req.request_id);
        let active = self
            .active_claims
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let (usage, recorded) = self.core.read(|c| {
            Ok((
                ledger::usage(c, now, anchor, allowance)?,
                ledger::recorded_request(c, &execution_id)?,
            ))
        })?;
        let replay = recorded.map(|recorded| {
            (
                recorded.intent,
                self.replay_state(&execution_id, &active, recorded.execution),
            )
        });
        drop(active);
        let mut run = Run {
            o: self,
            req: &req,
            usage: account_usage.unwrap_or(usage),
            intent: None,
            counted: false,
            on_stage,
        };
        if let Some((intent, replay)) = replay {
            run.intent = Some(intent);
            return Ok(run.replay(replay));
        }
        // The allowance is checked before any work.
        if run.usage.exhausted() {
            self.emit(vec![run.limit_event()]);
            return Ok(run.respond(KalVoiceOutcome::LimitReached {
                resets_at: run.usage.resets_at.clone(),
            }));
        }
        self.emit(vec![run.event(EventPayload::KalVoiceRequestStarted {
            request_id: req.request_id.clone(),
            input: req.input,
        })]);
        on_stage(RequestStage::Thinking);

        match grammar::understand(&req.text) {
            Understood::Rejected { code, message } => Ok(run.fail(code, message)),
            Understood::Intent {
                intent: KalVoiceIntent::Reasoning { request },
                ..
            } => {
                let request = if request.is_empty() {
                    req.text.as_str()
                } else {
                    request.as_str()
                };
                run.interpret_local(request)
            }
            Understood::Intent { intent, target } => {
                run.intent = Some(intent.kind_name().to_owned());
                self.emit(vec![run.event(EventPayload::KalVoiceCommandRecognized {
                    request_id: req.request_id.clone(),
                    intent: intent.kind_name().to_owned(),
                })]);
                let (intent, providers) = match target {
                    None => (intent, Vec::new()),
                    // Named providers aren't looked up; the layout command carries them.
                    Some(NamedTarget::Providers(providers)) => (intent, providers),
                    Some(target) => match self.resolve(&target) {
                        Ok(id) => (grammar::bind_target(intent, id), Vec::new()),
                        Err(e) => return Ok(run.fail(&e.code, e.message)),
                    },
                };
                run.command(intent, providers)
            }
        }
    }

    fn replay_state(
        &self,
        request_id: &str,
        active: &HashSet<String>,
        execution: RequestExecution,
    ) -> ReplayState {
        match execution {
            RequestExecution::Claimed { owner }
                if owner.as_deref() == Some(self.execution_owner.as_str())
                    && active.contains(request_id) =>
            {
                ReplayState::InProgress
            }
            RequestExecution::Claimed { .. } => ReplayState::Indeterminate,
            RequestExecution::Completed => ReplayState::Completed,
            RequestExecution::Failed { code } => ReplayState::Failed(code),
        }
    }

    fn resolve(&self, target: &NamedTarget) -> std::result::Result<String, ExecError> {
        let lookup =
            |name: &str, find: &dyn Fn(&str) -> std::result::Result<Option<String>, ExecError>| {
                // Forgiving about a leading "my" ("in my website workspace").
                let mut found = find(name)?;
                if found.is_none()
                    && let Some(rest) = name.strip_prefix("my ")
                {
                    found = find(rest)?;
                }
                Ok(found)
            };
        match target {
            NamedTarget::Workspace(name) => lookup(name, &|n| self.executor.find_workspace(n))?
                .ok_or_else(|| {
                    ExecError::new(
                        "workspace_not_found",
                        format!("KalCode has no workspace named \u{201c}{name}\u{201d}."),
                    )
                }),
            NamedTarget::Thread(name) => lookup(name, &|n| self.executor.find_thread(n))?
                .ok_or_else(|| {
                    ExecError::new(
                        "thread_not_found",
                        format!("KalCode has no thread named \u{201c}{name}\u{201d}."),
                    )
                }),
            NamedTarget::Providers(_) => Err(ExecError::new(
                "not_a_target",
                "KalVoice couldn't tell what that refers to.",
            )),
        }
    }

    /// Handles one push-to-talk utterance: routes it, then runs the command or request, or
    /// records the dictation (never counted). Blocking; call from a background thread.
    pub fn talk(&self, req: TalkRequest, on_stage: &dyn Fn(RequestStage)) -> Result<TalkResponse> {
        let started = Instant::now();
        let route = talk_route(&req.text, req.target);
        let recognized_ms = started.elapsed().as_secs_f64() * 1000.0;
        if is_valid_id(&req.request_id) {
            // The route only (never the words).
            self.emit(vec![event(
                EventPayload::KalVoiceTalkRouted {
                    request_id: req.request_id.clone(),
                    outcome: route,
                },
                Correlation {
                    request_id: Some(req.request_id.clone()),
                    workspace_id: req.workspace_id.clone().filter(|w| is_valid_id(w)),
                    ..Correlation::default()
                },
            )]);
        }
        let response = match route {
            TalkRoute::Dictation => {
                self.emit(vec![event(
                    EventPayload::KalVoiceDictationCompleted {
                        session_id: req.session_id.clone(),
                        duration_ms: req.duration_ms,
                        characters: u32::try_from(req.text.chars().count()).unwrap_or(u32::MAX),
                    },
                    Correlation::default(),
                )]);
                None
            }
            TalkRoute::Command | TalkRoute::Request => Some(self.handle_with_stages(
                CommandRequest {
                    request_id: req.request_id,
                    text: req.text,
                    input: KalVoiceInput::Voice,
                    workspace_id: req.workspace_id,
                },
                on_stage,
            )?),
        };
        Ok(TalkResponse {
            route,
            response,
            recognized_ms,
        })
    }

    /// "Type it instead": un-counts a spoken command the user turned into text, when the UI
    /// could undo it (navigation) and it ran within the last two minutes. Returns whether the
    /// request was un-counted.
    pub fn type_instead(&self, request_id: &str) -> Result<bool> {
        if !is_valid_id(request_id) {
            return Err(KalError::validation(
                "invalid_request_id",
                "KalVoice received an invalid request id.",
            ));
        }
        // The authoritative API has no refund operation. Never remove a durable account claim
        // or tell the renderer that a server-counted request was refunded.
        if self.accounting.is_some() {
            return Ok(false);
        }
        let now = (self.clock)();
        let request = request_id.to_owned();
        let (refunded, _) = self.core.transact(|tx| {
            let refunded = ledger::refund(tx, &request, now, time::Duration::minutes(2))?;
            let events = if refunded {
                vec![event(
                    EventPayload::KalVoiceRequestFailed {
                        request_id: request.clone(),
                        code: "typed_instead".into(),
                    },
                    Correlation {
                        request_id: Some(request.clone()),
                        ..Correlation::default()
                    },
                )]
            } else {
                Vec::new()
            };
            Ok((refunded, events))
        })?;
        Ok(refunded)
    }

    /// Records spoken-reply lifecycle events.
    pub fn record_voice_output(&self, request_id: &str, started: bool) {
        let correlation = Correlation {
            request_id: Some(request_id.to_owned()),
            ..Correlation::default()
        };
        let payload = if started {
            EventPayload::KalVoiceVoiceOutputStarted {
                request_id: request_id.to_owned(),
            }
        } else {
            EventPayload::KalVoiceVoiceOutputCompleted {
                request_id: request_id.to_owned(),
            }
        };
        self.emit(vec![event(payload, correlation)]);
    }
}

fn event(payload: EventPayload, correlation: Correlation) -> NewEvent {
    NewEvent {
        source: EventSource::KalVoice,
        correlation,
        event: payload,
    }
}

/// The person-facing name of a mode KalVoice may ask for (never Bypass: not representable).
pub fn requestable_mode_label(mode: RequestableMode) -> &'static str {
    match mode {
        RequestableMode::Plan => "Plan",
        RequestableMode::Approve => "Approve",
        RequestableMode::Auto => "Auto",
        RequestableMode::Custom => "Custom",
    }
}

/// One-line description for status and audit output.
pub fn describe(intent: &KalVoiceIntent) -> String {
    let scope_text = |scope: &ThreadScope| match scope {
        ThreadScope::All => "all threads",
        ThreadScope::Workspace { .. } => "the threads in a workspace",
        ThreadScope::Thread { .. } => "one thread",
    };
    match intent {
        KalVoiceIntent::CreateThreads {
            provider_id, count, ..
        } => format!(
            "Open {count} {} thread{}",
            provider_display_name(provider_id),
            if *count == 1 { "" } else { "s" }
        ),
        KalVoiceIntent::PauseThreads { scope } => format!("Pause {}", scope_text(scope)),
        KalVoiceIntent::ResumeThreads { scope } => format!("Resume {}", scope_text(scope)),
        KalVoiceIntent::StopThreads { scope } => format!("Stop {}", scope_text(scope)),
        KalVoiceIntent::CreateTerminal { .. } => "Open a terminal".into(),
        KalVoiceIntent::RequestPermissionMode { mode, .. } => format!(
            "Ask to switch a thread to {} mode",
            requestable_mode_label(*mode)
        ),
        other => other.kind_name().replace('_', " "),
    }
}

/// State for one request as it moves through the pipeline.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ReplayState {
    InProgress,
    Indeterminate,
    Completed,
    Failed(String),
}

enum ClaimDecision {
    Execute(ActiveClaim),
    Replay(ReplayState),
    LimitReached,
}

#[derive(Default)]
struct LocalInterpretationState {
    sealed: bool,
    operation: Option<Arc<LocalInterpretationOperation>>,
}

/// Owns the single local-interpreter lane until the worker has actually stopped interpreting.
/// The request may time out first, but dropping its receiver cannot release this permit early and
/// allow two model invocations to overlap.
struct LocalInterpretationPermit {
    active: Arc<AtomicBool>,
}

impl LocalInterpretationPermit {
    fn acquire(active: Arc<AtomicBool>) -> Option<Self> {
        active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Self { active })
    }
}

impl Drop for LocalInterpretationPermit {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
    }
}

#[derive(Clone)]
struct LocalInterpretationWorkerResult {
    completed_at: Instant,
    interpreted: std::result::Result<LocalInterpretation, LocalInterpretationError>,
}

enum LocalInterpretationJoin {
    Unregistered,
    Pending(JoinHandle<()>),
    Joining,
    Joined(bool),
}

/// Orchestrator-owned custody for one local inference. The operation retains the single-flight
/// permit, cancellation token and join handle even after the requesting thread times out.
struct LocalInterpretationOperation {
    cancellation: LocalInterpretationCancellation,
    result: Mutex<Option<LocalInterpretationWorkerResult>>,
    result_ready: Condvar,
    join: Mutex<LocalInterpretationJoin>,
    join_ready: Condvar,
    _permit: LocalInterpretationPermit,
}

impl LocalInterpretationOperation {
    fn new(permit: LocalInterpretationPermit) -> Self {
        Self {
            cancellation: LocalInterpretationCancellation::default(),
            result: Mutex::new(None),
            result_ready: Condvar::new(),
            join: Mutex::new(LocalInterpretationJoin::Unregistered),
            join_ready: Condvar::new(),
            _permit: permit,
        }
    }

    fn register(&self, handle: JoinHandle<()>) {
        *self.join.lock().unwrap_or_else(PoisonError::into_inner) =
            LocalInterpretationJoin::Pending(handle);
    }

    fn complete(
        &self,
        interpreted: std::result::Result<LocalInterpretation, LocalInterpretationError>,
    ) {
        *self.result.lock().unwrap_or_else(PoisonError::into_inner) =
            Some(LocalInterpretationWorkerResult {
                completed_at: Instant::now(),
                interpreted,
            });
        self.result_ready.notify_all();
    }

    fn is_complete(&self) -> bool {
        self.result
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_some()
    }

    fn wait_until(&self, deadline: Instant) -> Option<LocalInterpretationWorkerResult> {
        let mut result = self.result.lock().unwrap_or_else(PoisonError::into_inner);
        loop {
            if let Some(result) = result.as_ref() {
                return Some(result.clone());
            }
            let remaining = deadline.checked_duration_since(Instant::now())?;
            let (next, timed_out) = self
                .result_ready
                .wait_timeout(result, remaining)
                .unwrap_or_else(PoisonError::into_inner);
            result = next;
            if timed_out.timed_out() && result.is_none() {
                return None;
            }
        }
    }

    /// Joins only after completion has been observed. No interpreter-controlled code runs after
    /// `complete`, so taking the pending handle cannot inherit an unbounded provider/model wait.
    fn join_until(&self, deadline: Instant) -> Option<bool> {
        let mut join = self.join.lock().unwrap_or_else(PoisonError::into_inner);
        loop {
            match &*join {
                LocalInterpretationJoin::Unregistered => return Some(false),
                LocalInterpretationJoin::Joined(joined) => return Some(*joined),
                LocalInterpretationJoin::Joining => {
                    let remaining = deadline.checked_duration_since(Instant::now())?;
                    let (next, timed_out) = self
                        .join_ready
                        .wait_timeout(join, remaining)
                        .unwrap_or_else(PoisonError::into_inner);
                    join = next;
                    if timed_out.timed_out() && matches!(*join, LocalInterpretationJoin::Joining) {
                        return None;
                    }
                }
                LocalInterpretationJoin::Pending(_) => {
                    let LocalInterpretationJoin::Pending(handle) =
                        std::mem::replace(&mut *join, LocalInterpretationJoin::Joining)
                    else {
                        unreachable!();
                    };
                    drop(join);
                    let joined = handle.join().is_ok();
                    join = self.join.lock().unwrap_or_else(PoisonError::into_inner);
                    *join = LocalInterpretationJoin::Joined(joined);
                    self.join_ready.notify_all();
                    return Some(joined);
                }
            }
        }
    }
}

/// In-memory evidence that a durable `claimed` row is actively executing in this process.
/// Unwinding removes that evidence so a retry is reported as indeterminate instead of running.
struct ActiveClaim {
    request_id: String,
    execution_owner: String,
    active: Arc<Mutex<HashSet<String>>>,
    armed: bool,
}

impl ActiveClaim {
    fn finish(
        mut self,
        orchestrator: &Orchestrator,
        result: ExecutionResult<'_>,
        events: Vec<NewEvent>,
    ) -> Result<()> {
        let finished = orchestrator.core.transact(|tx| {
            if !ledger::finish(tx, &self.request_id, &self.execution_owner, result)? {
                return Err(KalError::internal(
                    "kalvoice_claim_changed",
                    "KalVoice couldn't record the request result because its claim changed.",
                ));
            }
            Ok(((), events))
        });
        self.active
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.request_id);
        self.armed = false;
        finished.map(|_| ())
    }
}

impl Drop for ActiveClaim {
    fn drop(&mut self) {
        if self.armed {
            self.active
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(&self.request_id);
        }
    }
}

struct Run<'a> {
    o: &'a Orchestrator,
    req: &'a CommandRequest,
    usage: KalVoiceUsage,
    intent: Option<String>,
    counted: bool,
    on_stage: &'a dyn Fn(RequestStage),
}

impl Run<'_> {
    fn correlation(&self) -> Correlation {
        Correlation {
            request_id: Some(self.req.request_id.clone()),
            workspace_id: self.req.workspace_id.clone(),
            ..Correlation::default()
        }
    }

    fn event(&self, payload: EventPayload) -> NewEvent {
        event(payload, self.correlation())
    }

    fn limit_event(&self) -> NewEvent {
        self.event(EventPayload::KalVoiceLimitReached {
            allowance: self.usage.allowance.unwrap_or(0),
            resets_at: self.usage.resets_at.clone(),
        })
    }

    fn respond(&self, outcome: KalVoiceOutcome) -> KalVoiceResponse {
        self.respond_with(outcome, None)
    }

    fn respond_with(
        &self,
        outcome: KalVoiceOutcome,
        directive: Option<UiDirective>,
    ) -> KalVoiceResponse {
        KalVoiceResponse {
            request_id: self.req.request_id.clone(),
            intent: self.intent.clone(),
            outcome,
            usage: self.usage.clone(),
            counted: self.counted,
            directive,
        }
    }

    fn replay(&self, replay: ReplayState) -> KalVoiceResponse {
        let outcome = match replay {
            ReplayState::InProgress => KalVoiceOutcome::Failed {
                code: "request_in_progress".into(),
                message: "KalVoice is already handling this request.".into(),
            },
            ReplayState::Indeterminate => KalVoiceOutcome::Failed {
                code: "request_indeterminate".into(),
                message: "KalVoice recorded this request before execution was interrupted. It will not run it again automatically.".into(),
            },
            ReplayState::Completed => KalVoiceOutcome::Completed {
                summary: "KalVoice already completed this request.".into(),
            },
            ReplayState::Failed(code) => KalVoiceOutcome::Failed {
                code,
                message: "KalVoice already handled this request, and the operation failed.".into(),
            },
        };
        self.respond(outcome)
    }

    fn fail(&mut self, code: &str, message: String) -> KalVoiceResponse {
        self.o
            .emit(vec![self.event(EventPayload::KalVoiceRequestFailed {
                request_id: self.req.request_id.clone(),
                code: code.to_owned(),
            })]);
        self.respond(KalVoiceOutcome::Failed {
            code: code.to_owned(),
            message,
        })
    }

    /// Atomically owns the durable usage/execution claim before any executor effect.
    fn claim(&mut self) -> Result<ClaimDecision> {
        let (allowance, anchor) = self.o.allowance();
        let now = (self.o.clock)();
        let intent = self.intent.clone().unwrap_or_else(|| "reasoning".into());
        let req = self.req;
        let execution_id = self.o.execution_id(&req.request_id);
        let active_claims = self.o.active_claims.clone();
        let mut active = active_claims.lock().unwrap_or_else(PoisonError::into_inner);
        let (consumption, _) = self.o.core.transact(|tx| {
            let consumption = ledger::consume(
                tx,
                ledger::RequestClaim {
                    request_id: &execution_id,
                    input: req.input,
                    intent_kind: &intent,
                    execution_owner: &self.o.execution_owner,
                },
                ledger::ConsumptionContext {
                    now,
                    anchor_day: anchor,
                    allowance,
                },
            )?;
            let events = match &consumption {
                Consumption::LimitReached(u) => vec![
                    event(
                        EventPayload::KalVoiceLimitReached {
                            allowance: u.allowance.unwrap_or(0),
                            resets_at: u.resets_at.clone(),
                        },
                        Correlation {
                            request_id: Some(req.request_id.clone()),
                            ..Correlation::default()
                        },
                    ),
                    event(
                        EventPayload::KalVoiceRequestFailed {
                            request_id: req.request_id.clone(),
                            code: "limit_reached".into(),
                        },
                        Correlation {
                            request_id: Some(req.request_id.clone()),
                            ..Correlation::default()
                        },
                    ),
                ],
                _ => Vec::new(),
            };
            Ok((consumption, events))
        })?;
        if self.o.accounting.is_none() {
            self.usage = consumption.usage().clone();
        }
        match consumption {
            Consumption::LimitReached(_) => Ok(ClaimDecision::LimitReached),
            Consumption::Recorded(_) => {
                self.counted = self.o.accounting.is_none();
                active.insert(execution_id.clone());
                drop(active);
                Ok(ClaimDecision::Execute(ActiveClaim {
                    request_id: execution_id.clone(),
                    execution_owner: self.o.execution_owner.clone(),
                    active: active_claims,
                    armed: true,
                }))
            }
            Consumption::AlreadyRecorded { execution, .. } => Ok(ClaimDecision::Replay(
                self.o.replay_state(&execution_id, &active, execution),
            )),
        }
    }

    fn command(
        &mut self,
        intent: KalVoiceIntent,
        providers: Vec<ProviderId>,
    ) -> Result<KalVoiceResponse> {
        if let Err(e) = self.o.executor.check(&intent) {
            return Ok(self.fail(&e.code, e.message));
        }
        let ctx = ExecContext {
            request_id: self.req.request_id.clone(),
            workspace_id: self.req.workspace_id.clone(),
            providers,
        };
        // Claim immediately before execution. The claim and allowance check are atomic, so a
        // concurrent retry can observe but can never repeat the effect.
        match self.claim()? {
            ClaimDecision::LimitReached => Ok(self.respond(KalVoiceOutcome::LimitReached {
                resets_at: self.usage.resets_at.clone(),
            })),
            ClaimDecision::Replay(replay) => Ok(self.replay(replay)),
            ClaimDecision::Execute(claim) => self.execute(&intent, &ctx, claim),
        }
    }

    fn execute(
        &mut self,
        intent: &KalVoiceIntent,
        ctx: &ExecContext,
        claim: ActiveClaim,
    ) -> Result<KalVoiceResponse> {
        if let Some(accounting) = &self.o.accounting {
            match accounting.authorize(&self.req.request_id) {
                Ok(decision) => {
                    self.usage = decision.usage;
                    if !decision.allowed {
                        claim.finish(
                            self.o,
                            ExecutionResult::Failed {
                                code: "limit_reached",
                            },
                            vec![self.limit_event()],
                        )?;
                        return Ok(self.respond(KalVoiceOutcome::LimitReached {
                            resets_at: self.usage.resets_at.clone(),
                        }));
                    }
                    self.counted = true;
                }
                Err(error) => {
                    claim.finish(
                        self.o,
                        ExecutionResult::Failed { code: error.code },
                        Vec::new(),
                    )?;
                    return Ok(self.fail(error.code, error.message));
                }
            }
        }
        (self.on_stage)(RequestStage::Executing);
        match self.o.executor.execute(intent, ctx) {
            Ok(done) => {
                claim.finish(
                    self.o,
                    ExecutionResult::Completed,
                    vec![
                        self.event(EventPayload::KalVoiceCommandExecuted {
                            request_id: self.req.request_id.clone(),
                            intent: intent.kind_name().to_owned(),
                        }),
                        self.event(EventPayload::KalVoiceRequestCompleted {
                            request_id: self.req.request_id.clone(),
                        }),
                    ],
                )?;
                Ok(self.respond_with(
                    KalVoiceOutcome::Completed {
                        summary: done.summary,
                    },
                    done.directive,
                ))
            }
            Err(e) => {
                claim.finish(
                    self.o,
                    ExecutionResult::Failed { code: &e.code },
                    vec![self.event(EventPayload::KalVoiceRequestFailed {
                        request_id: self.req.request_id.clone(),
                        code: e.code.clone(),
                    })],
                )?;
                Ok(self.respond(KalVoiceOutcome::Failed {
                    code: e.code,
                    message: e.message,
                }))
            }
        }
    }

    fn interpret_local(&mut self, request: &str) -> Result<KalVoiceResponse> {
        self.intent = Some("reasoning".into());
        if !self.o.reap_local_interpretation() {
            return Ok(self.fail(
                "local_reasoning_busy",
                LOCAL_INTERPRETATION_BUSY_MESSAGE.into(),
            ));
        }
        let Some(permit) =
            LocalInterpretationPermit::acquire(self.o.local_interpretation_active.clone())
        else {
            return Ok(self.fail(
                "local_reasoning_busy",
                LOCAL_INTERPRETATION_BUSY_MESSAGE.into(),
            ));
        };
        let interpreter = self.o.local_interpreter.clone();
        let workspaces = match self.o.executor.workspace_options() {
            Ok(workspaces) => bounded_workspace_snapshot(workspaces),
            Err(error) => return Ok(self.fail(&error.code, error.message)),
        };
        let workspace_id = self
            .req
            .workspace_id
            .as_ref()
            .filter(|id| workspaces.iter().any(|workspace| &workspace.id == *id))
            .cloned();
        let input = LocalInterpretationRequest {
            request: request.to_owned(),
            workspace_id,
            workspaces: workspaces.clone(),
        };
        let deadline = Instant::now() + LOCAL_INTERPRETATION_TIMEOUT;
        let operation = Arc::new(LocalInterpretationOperation::new(permit));
        {
            let mut state = self
                .o
                .local_interpretation_state
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if state.sealed {
                return Ok(self.fail(
                    "local_reasoning_unavailable",
                    LOCAL_REASONING_UNAVAILABLE_MESSAGE.into(),
                ));
            }
            if state.operation.is_some() {
                return Ok(self.fail(
                    "local_reasoning_busy",
                    LOCAL_INTERPRETATION_BUSY_MESSAGE.into(),
                ));
            }
            state.operation = Some(operation.clone());
        }
        let worker_operation = operation.clone();
        let (start_tx, start_rx) = std::sync::mpsc::sync_channel(1);
        let worker = std::thread::Builder::new()
            .name("kalvoice-local-interpreter".into())
            .spawn(move || {
                if start_rx.recv().is_err() {
                    worker_operation.complete(Err(LocalInterpretationError::Failed));
                    return;
                }
                let interpreted = if worker_operation.cancellation.is_cancelled() {
                    Err(LocalInterpretationError::Failed)
                } else {
                    std::panic::catch_unwind(AssertUnwindSafe(|| {
                        interpreter.interpret(input, deadline, &worker_operation.cancellation)
                    }))
                    .unwrap_or(Err(LocalInterpretationError::Failed))
                };
                worker_operation.complete(interpreted);
            });
        let Ok(worker) = worker else {
            operation.complete(Err(LocalInterpretationError::Failed));
            let _ = self.o.finish_local_interpretation(
                &operation,
                Instant::now() + LOCAL_INTERPRETATION_SETTLE_TIMEOUT,
            );
            return Ok(self.fail(
                "local_reasoning_failed",
                LOCAL_REASONING_FAILED_MESSAGE.into(),
            ));
        };
        operation.register(worker);
        if start_tx.send(()).is_err() {
            operation.complete(Err(LocalInterpretationError::Failed));
        }

        let worker_result = match operation.wait_until(deadline) {
            Some(result) => result,
            None => {
                operation.cancellation.cancel();
                let settle_deadline = Instant::now() + LOCAL_INTERPRETATION_SETTLE_TIMEOUT;
                if operation.wait_until(settle_deadline).is_some() {
                    let _ = self
                        .o
                        .finish_local_interpretation(&operation, settle_deadline);
                }
                return Ok(self.fail(
                    "local_reasoning_timeout",
                    LOCAL_INTERPRETATION_TIMEOUT_MESSAGE.into(),
                ));
            }
        };
        let joined = self.o.finish_local_interpretation(
            &operation,
            Instant::now() + LOCAL_INTERPRETATION_SETTLE_TIMEOUT,
        );
        if !joined {
            return Ok(self.fail(
                "local_reasoning_failed",
                LOCAL_REASONING_FAILED_MESSAGE.into(),
            ));
        }
        if worker_result.completed_at > deadline || operation.cancellation.is_cancelled() {
            return Ok(self.fail(
                "local_reasoning_timeout",
                LOCAL_INTERPRETATION_TIMEOUT_MESSAGE.into(),
            ));
        }
        let intent = match worker_result.interpreted {
            Err(LocalInterpretationError::Unavailable) => {
                return Ok(self.fail(
                    "local_reasoning_unavailable",
                    LOCAL_REASONING_UNAVAILABLE_MESSAGE.into(),
                ));
            }
            Err(LocalInterpretationError::Failed) => {
                return Ok(self.fail(
                    "local_reasoning_failed",
                    LOCAL_REASONING_FAILED_MESSAGE.into(),
                ));
            }
            Ok(LocalInterpretation::Uncertain) => {
                return Ok(self.fail(
                    "local_reasoning_uncertain",
                    LOCAL_REASONING_UNCERTAIN_MESSAGE.into(),
                ));
            }
            Ok(LocalInterpretation::Action(intent)) => match validate_action(intent, &workspaces) {
                Ok(action) => action.into_intent(),
                Err(_) => {
                    return Ok(self.fail(
                        "local_reasoning_invalid_output",
                        LOCAL_REASONING_INVALID_OUTPUT_MESSAGE.into(),
                    ));
                }
            },
        };
        self.intent = Some(intent.kind_name().to_owned());
        self.o
            .emit(vec![self.event(EventPayload::KalVoiceCommandRecognized {
                request_id: self.req.request_id.clone(),
                intent: intent.kind_name().to_owned(),
            })]);
        self.command(intent, Vec::new())
    }
}

#[cfg(test)]
#[path = "orchestrator_tests.rs"]
mod tests;
