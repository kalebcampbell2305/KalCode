//! KalVoice request orchestration (docs/KALVOICE.md, "Command pipeline").
//!
//! ```text
//! request ─▶ allowance check ─▶ grammar ─▶ deterministic intent ─▶ runtime check
//!                                   │                                  └▶ permission gate ─▶ count ─▶ execute
//!                                   └▶ Reasoning ─▶ user's provider (or NeedsProvider) ─▶ count ─▶ run
//! ```
//!
//! - One top-level request counts once, when KalVoice acts on it (runs a command, opens an
//!   approval request, or sends it to the user's provider). Requests refused up front — limit
//!   reached, no provider, a workspace that doesn't exist, a command this build can't run — are
//!   not counted. Retrying a client request id never counts twice or runs twice.
//! - Safety asymmetry (docs/ADVANCED.md, KV-02): commands that make things safer (pause, stop)
//!   run directly; commands that add work (creating or resuming threads) go through the
//!   permission engine as a KalVoice-origin action ([`OriginGate`], Z4's
//!   `PermissionService::request_for_origin`): evaluated under Approve, filed as an approval
//!   with `origin_kind = 'kalvoice'` that only the person answers (Approve once or Deny), and
//!   run only after the approval. KalVoice never answers approvals and never changes permission
//!   modes (a permission-mode request only opens the thread for the person to decide).
//! - Events carry ids and facts only; request text, transcripts and provider answers never
//!   appear in them. State and events commit together and are published after commit.

use std::collections::HashMap;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use kalcode_contracts::agent::{AgentEvent, AgentInput, AgentProvider, ProviderId, SessionConfig};
use kalcode_contracts::app::SurfaceId;
use kalcode_contracts::events::{Correlation, EventPayload, EventSource, NewEvent};
use kalcode_contracts::ids::{is_valid_id, new_id};
pub use kalcode_contracts::kalvoice::TalkRoute;
use kalcode_contracts::kalvoice::{
    KalVoiceInput, KalVoiceIntelligence, KalVoiceIntent, KalVoiceOutcome, KalVoiceUsage,
    PaneDirection, RequestableMode, ThreadScope,
};
use kalcode_contracts::permissions::{
    ActionKind, ActionOrigin, ApprovalDecision, NormalizedAction, PermissionMode, PolicyEffect,
};
use kalcode_contracts::workspace_ui::SplitAxis;
use kalcode_core::time::now_rfc3339;
use kalcode_core::{Core, KalError, Result};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use ts_rs::TS;

use crate::grammar::{self, Confidence, NamedTarget, Understood};
use crate::ledger::{self, Consumption};
use crate::plan::EntitlementSource;
use crate::prefs::{self, KalVoicePreferences, KalVoicePreferencesPatch};

/// Longest request KalVoice accepts (typed or transcribed).
pub const MAX_REQUEST_CHARS: usize = 4_000;

/// How long a provider may take to answer a reasoning request.
pub const REASONING_TIMEOUT: Duration = Duration::from_secs(120);

pub const CONNECT_PROVIDER_MESSAGE: &str =
    "Connect a supported AI provider to use KalVoice reasoning for this request.";

/// Instructions sent with a reasoning request to the user's own provider.
const REASONING_PREAMBLE: &str = "You are KalVoice, the assistant inside KalCode, answering a \
request the user spoke or typed. Reply briefly (a few sentences), in plain text. You are in \
read-only planning mode: do not modify files or run commands.\n\nRequest: ";

/// Where a request is in the pipeline (for the assistant's state display).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum RequestStage {
    /// Understanding the request, or waiting for the user's provider to answer.
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

/// The user's connected providers (implemented by the provider runtime).
pub trait ProviderDirectory: Send + Sync {
    fn connected(&self) -> Vec<ProviderChoice>;
    fn provider(&self, id: &ProviderId) -> Option<Arc<dyn AgentProvider>>;
    /// Session settings for a read-only reasoning session (native-resolved working directory).
    fn session_config(&self, request_id: &str, workspace_id: Option<&str>)
    -> Option<SessionConfig>;
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

struct Pending {
    request_id: String,
    intent: KalVoiceIntent,
    ctx: ExecContext,
}

/// What the permission engine decided about a consequential KalVoice action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GateOutcome {
    /// The policy allows it without asking.
    Allowed,
    /// The policy refuses it.
    Denied { reason: String },
    /// An approval request was filed; the person answers it in KalCode.
    Asked { approval_request_id: String },
}

/// The permission engine's entry point for actions that come from KalVoice (Z4's
/// `PermissionService::request_for_origin`): the action is evaluated under Approve (KalVoice
/// never selects or changes a mode), standing grants and rules never apply, and an approval is
/// filed with `origin_kind = 'kalvoice'` that only the person can answer, once.
pub trait OriginGate: Send + Sync {
    fn request(&self, action: NormalizedAction) -> std::result::Result<GateOutcome, String>;
}

impl OriginGate for kalcode_permissions::PermissionService {
    fn request(&self, action: NormalizedAction) -> std::result::Result<GateOutcome, String> {
        let outcome = self
            .request_for_origin(action)
            .map_err(|e| e.message.clone())?;
        Ok(match (outcome.decision.effect, outcome.approval) {
            (PolicyEffect::Ask, Some(approval)) => GateOutcome::Asked {
                approval_request_id: approval.id,
            },
            (PolicyEffect::Ask, None) => {
                return Err("KalCode couldn't file the approval request.".into());
            }
            (PolicyEffect::Allow, _) => GateOutcome::Allowed,
            (PolicyEffect::Deny, _) => GateOutcome::Denied {
                reason: outcome.decision.reason,
            },
        })
    }
}

type Clock = Arc<dyn Fn() -> OffsetDateTime + Send + Sync>;

pub struct Orchestrator {
    core: Arc<Core>,
    entitlement: Arc<dyn EntitlementSource>,
    executor: Arc<dyn Executor>,
    gate: Arc<dyn OriginGate>,
    providers: Arc<dyn ProviderDirectory>,
    clock: Clock,
    reasoning_timeout: Duration,
    pending: Mutex<HashMap<String, Pending>>,
}

impl Orchestrator {
    pub fn new(
        core: Arc<Core>,
        entitlement: Arc<dyn EntitlementSource>,
        executor: Arc<dyn Executor>,
        gate: Arc<dyn OriginGate>,
        providers: Arc<dyn ProviderDirectory>,
    ) -> Self {
        Self {
            core,
            entitlement,
            executor,
            gate,
            providers,
            clock: Arc::new(OffsetDateTime::now_utc),
            reasoning_timeout: REASONING_TIMEOUT,
            pending: Mutex::new(HashMap::new()),
        }
    }

    /// Tests: a fixed clock and a short reasoning timeout.
    pub fn with_clock(
        mut self,
        clock: impl Fn() -> OffsetDateTime + Send + Sync + 'static,
    ) -> Self {
        self.clock = Arc::new(clock);
        self
    }

    pub fn with_reasoning_timeout(mut self, timeout: Duration) -> Self {
        self.reasoning_timeout = timeout;
        self
    }

    fn allowance(&self) -> (Option<u32>, u8) {
        (
            self.entitlement.tier().kalvoice_allowance(),
            self.entitlement.cycle_anchor_day(),
        )
    }

    /// Current usage (for "Used N of 250, resets …").
    pub fn usage(&self) -> Result<KalVoiceUsage> {
        let (allowance, anchor) = self.allowance();
        let now = (self.clock)();
        self.core.read(|c| ledger::usage(c, now, anchor, allowance))
    }

    pub fn preferences(&self) -> Result<KalVoicePreferences> {
        self.core.read(prefs::load)
    }

    /// Validates and saves preferences; emits `settings.changed` and, when the reasoning
    /// provider changes, `kalvoice.provider_selected`.
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

    /// Handles one top-level request. Blocking (a reasoning request waits for the provider);
    /// call from a background thread.
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
        let (usage, duplicate) = self.core.read(|c| {
            Ok((
                ledger::usage(c, now, anchor, allowance)?,
                ledger::is_recorded(c, &req.request_id)?,
            ))
        })?;
        let mut run = Run {
            o: self,
            req: &req,
            usage,
            intent: None,
            counted: false,
            on_stage,
        };
        if duplicate {
            return Ok(run.respond(KalVoiceOutcome::Failed {
                code: "duplicate_request".into(),
                message: "KalVoice already handled this request.".into(),
            }));
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
            } => run.reason(&request),
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

    /// Whether `approval_request_id` is a KalVoice command waiting for the person's answer.
    pub fn is_waiting_for(&self, approval_request_id: &str) -> bool {
        self.pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains_key(approval_request_id)
    }

    /// Continues a command that waited for approval, once the person answered it in KalCode
    /// (`approval.approved` / `approval.denied`) or it expired (`None`). Returns the final
    /// response, or `None` when `approval_request_id` isn't one of KalVoice's. KalVoice never
    /// answers the approval itself; it only reacts to the answer.
    pub fn resolve_approval(
        &self,
        approval_request_id: &str,
        decision: Option<ApprovalDecision>,
    ) -> Option<KalVoiceResponse> {
        let pending = self
            .pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(approval_request_id)?;
        let usage = self.usage().ok()?;
        let req = CommandRequest {
            request_id: pending.request_id.clone(),
            text: String::new(),
            input: KalVoiceInput::Text,
            workspace_id: pending.ctx.workspace_id.clone(),
        };
        let mut run = Run {
            o: self,
            req: &req,
            usage,
            intent: Some(pending.intent.kind_name().to_owned()),
            counted: true,
            on_stage: &|_| {},
        };
        Some(match decision {
            Some(ApprovalDecision::Deny) => run.fail(
                "permission_denied",
                "The request wasn't approved, so KalVoice didn't run it.".into(),
            ),
            None => run.fail(
                "approval_expired",
                "The approval request expired, so KalVoice didn't run it.".into(),
            ),
            Some(ApprovalDecision::ApproveOnce) => run.execute(&pending.intent, &pending.ctx),
            // KalVoice requests only offer Approve once or Deny; anything else runs nothing.
            Some(_) => run.fail(
                "permission_denied",
                "KalVoice runs a request only when it's approved once.".into(),
            ),
        })
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

/// The permission-engine action for intents that add work for agents (they wait for the
/// person's approval). Pausing and stopping only make things safer, so they run directly
/// (KV-02); everything else is navigation or a read.
fn consequential_action(intent: &KalVoiceIntent, ctx: &ExecContext) -> Option<ActionKind> {
    match intent {
        KalVoiceIntent::CreateThreads {
            provider_id,
            count,
            workspace_id,
        } => Some(ActionKind::CreateThreads {
            provider_id: provider_id.clone(),
            count: u32::from(*count),
            workspace_id: workspace_id.clone().or_else(|| ctx.workspace_id.clone()),
        }),
        KalVoiceIntent::ResumeThreads { scope } => Some(ActionKind::ResumeThreads {
            scope: scope.clone(),
        }),
        _ => None,
    }
}

/// True for intents that add work for agents (they wait for the person's approval).
pub fn is_consequential(intent: &KalVoiceIntent) -> bool {
    matches!(
        intent,
        KalVoiceIntent::CreateThreads { .. } | KalVoiceIntent::ResumeThreads { .. }
    )
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

/// One-line description for the approval UI and audit log.
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

/// The action KalVoice asks the permission engine about, from the KalVoice origin. It has no
/// thread or provider of its own (`""`, as the contract says for non-thread origins).
fn normalized_action(
    kind: ActionKind,
    intent: &KalVoiceIntent,
    ctx: &ExecContext,
) -> NormalizedAction {
    let workspace_id = match &kind {
        ActionKind::CreateThreads { workspace_id, .. } => workspace_id.clone(),
        ActionKind::ResumeThreads {
            scope: ThreadScope::Workspace { workspace_id },
        } => Some(workspace_id.clone()),
        _ => ctx.workspace_id.clone(),
    };
    NormalizedAction {
        id: new_id(),
        thread_id: String::new(),
        workspace_id: workspace_id.unwrap_or_default(),
        provider_id: ProviderId::new(""),
        action: kind,
        summary: describe(intent),
        requested_at: now_rfc3339(),
        origin: Some(ActionOrigin::KalVoice {
            request_id: ctx.request_id.clone(),
        }),
    }
}

/// State for one request as it moves through the pipeline.
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

    /// Counts the request (atomically with the allowance). `false` when the limit was reached;
    /// the limit events are then already recorded.
    fn count(&mut self) -> Result<bool> {
        let (allowance, anchor) = self.o.allowance();
        let now = (self.o.clock)();
        let intent = self.intent.clone().unwrap_or_else(|| "reasoning".into());
        let req = self.req;
        let (consumption, _) = self.o.core.transact(|tx| {
            let consumption = ledger::consume(
                tx,
                &req.request_id,
                req.input,
                &intent,
                now,
                anchor,
                allowance,
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
        self.usage = consumption.usage().clone();
        match consumption {
            Consumption::LimitReached(_) => Ok(false),
            Consumption::Recorded(_) | Consumption::AlreadyRecorded(_) => {
                self.counted = true;
                Ok(true)
            }
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
        let mut asked = None;
        if let Some(kind) = consequential_action(&intent, &ctx) {
            match self.o.gate.request(normalized_action(kind, &intent, &ctx)) {
                Err(message) => return Ok(self.fail("approval_unavailable", message)),
                Ok(GateOutcome::Denied { reason }) => {
                    return Ok(self.fail(
                        "permission_denied",
                        format!("Your permission settings don't allow this. {reason}"),
                    ));
                }
                Ok(GateOutcome::Asked {
                    approval_request_id,
                }) => asked = Some(approval_request_id),
                Ok(GateOutcome::Allowed) => {}
            }
        }
        // Counted once KalVoice acts on it: an approval request filed, or the command run. (The
        // allowance was checked before any work; only a concurrent request can use it up in
        // between, and then the filed request stays unanswered here and nothing runs.)
        if !self.count()? {
            return Ok(self.respond(KalVoiceOutcome::LimitReached {
                resets_at: self.usage.resets_at.clone(),
            }));
        }
        if let Some(approval_request_id) = asked {
            self.o
                .pending
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(
                    approval_request_id.clone(),
                    Pending {
                        request_id: self.req.request_id.clone(),
                        intent,
                        ctx,
                    },
                );
            return Ok(self.respond(KalVoiceOutcome::PermissionRequired {
                approval_request_id,
            }));
        }
        Ok(self.execute(&intent, &ctx))
    }

    fn execute(&mut self, intent: &KalVoiceIntent, ctx: &ExecContext) -> KalVoiceResponse {
        (self.on_stage)(RequestStage::Executing);
        match self.o.executor.execute(intent, ctx) {
            Ok(done) => {
                self.o.emit(vec![
                    self.event(EventPayload::KalVoiceCommandExecuted {
                        request_id: self.req.request_id.clone(),
                        intent: intent.kind_name().to_owned(),
                    }),
                    self.event(EventPayload::KalVoiceRequestCompleted {
                        request_id: self.req.request_id.clone(),
                    }),
                ]);
                self.respond_with(
                    KalVoiceOutcome::Completed {
                        summary: done.summary,
                    },
                    done.directive,
                )
            }
            Err(e) => self.fail(&e.code, e.message),
        }
    }

    fn select_provider(&self) -> Result<std::result::Result<ProviderChoice, String>> {
        let prefs = self.o.core.read(prefs::load)?;
        let connected = self.o.providers.connected();
        Ok(match prefs.intelligence {
            Some(KalVoiceIntelligence::Local) => Err(
                "On-device reasoning isn't available yet. Choose a connected provider in Settings, KalVoice."
                    .into(),
            ),
            Some(KalVoiceIntelligence::Provider { provider_id }) => connected
                .into_iter()
                .find(|p| p.id == provider_id && p.available)
                .ok_or_else(|| {
                    format!(
                        "{} is currently unavailable. Choose another connected provider or retry.",
                        provider_display_name(&provider_id)
                    )
                }),
            None => {
                let mut usable: Vec<ProviderChoice> = connected.into_iter().filter(|p| p.available).collect();
                match usable.len() {
                    0 => Err(CONNECT_PROVIDER_MESSAGE.into()),
                    1 => Ok(usable.remove(0)),
                    _ => Err(
                        "Choose which connected provider KalVoice uses for reasoning in Settings, KalVoice."
                            .into(),
                    ),
                }
            }
        })
    }

    fn reason(&mut self, request: &str) -> Result<KalVoiceResponse> {
        self.intent = Some("reasoning".into());
        let choice = match self.select_provider()? {
            Ok(choice) => choice,
            Err(message) => {
                self.o
                    .emit(vec![self.event(EventPayload::KalVoiceRequestFailed {
                        request_id: self.req.request_id.clone(),
                        code: "needs_provider".into(),
                    })]);
                return Ok(self.respond(KalVoiceOutcome::NeedsProvider { message }));
            }
        };
        let unavailable = || {
            format!(
                "{} is currently unavailable. Choose another connected provider or retry.",
                choice.display_name
            )
        };
        let (Some(provider), Some(config)) = (
            self.o.providers.provider(&choice.id),
            self.o
                .providers
                .session_config(&self.req.request_id, self.req.workspace_id.as_deref()),
        ) else {
            let message = unavailable();
            self.o
                .emit(vec![self.event(EventPayload::KalVoiceRequestFailed {
                    request_id: self.req.request_id.clone(),
                    code: "needs_provider".into(),
                })]);
            return Ok(self.respond(KalVoiceOutcome::NeedsProvider { message }));
        };
        if !self.count()? {
            return Ok(self.respond(KalVoiceOutcome::LimitReached {
                resets_at: self.usage.resets_at.clone(),
            }));
        }
        let config = SessionConfig {
            // Reasoning is read-only whatever the session defaults are.
            permission_mode: PermissionMode::Plan,
            ..config
        };
        match run_reasoning(provider.as_ref(), config, request, self.o.reasoning_timeout) {
            Ok(answer) => {
                let correlation = Correlation {
                    provider_id: Some(choice.id.to_string()),
                    ..self.correlation()
                };
                self.o.emit(vec![
                    event(
                        EventPayload::KalVoiceCommandExecuted {
                            request_id: self.req.request_id.clone(),
                            intent: "reasoning".into(),
                        },
                        correlation.clone(),
                    ),
                    event(
                        EventPayload::KalVoiceRequestCompleted {
                            request_id: self.req.request_id.clone(),
                        },
                        correlation,
                    ),
                ]);
                Ok(self.respond(KalVoiceOutcome::Completed { summary: answer }))
            }
            Err(e) => Ok(self.fail(&e.code, e.message)),
        }
    }
}

/// Runs one read-only turn on the user's provider and returns its answer.
fn run_reasoning(
    provider: &dyn AgentProvider,
    config: SessionConfig,
    request: &str,
    timeout: Duration,
) -> std::result::Result<String, ExecError> {
    let name = provider.display_name().to_owned();
    let unavailable = |_| {
        ExecError::new(
            "provider_unavailable",
            format!("{name} is currently unavailable. Choose another connected provider or retry."),
        )
    };
    let (tx, rx) = mpsc::channel::<AgentEvent>();
    let sink = move |e: AgentEvent| {
        let _ = tx.send(e);
    };
    let session = provider
        .start_session(config, Box::new(sink))
        .map_err(unavailable)?;
    let finish = |result| {
        let _ = session.terminate();
        result
    };
    if let Err(e) = session.send(AgentInput::Text {
        text: format!("{REASONING_PREAMBLE}{request}"),
    }) {
        return finish(Err(unavailable(e)));
    }
    let deadline = Instant::now() + timeout;
    let mut completed: Option<String> = None;
    let mut streamed = String::new();
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(AgentEvent::MessageCompleted { text, .. }) => completed = Some(text),
            Ok(AgentEvent::MessageDelta { text, .. }) => streamed.push_str(&text),
            Ok(AgentEvent::ApprovalRequired { request_id, .. }) => {
                // Reasoning never acts; refuse anything that would.
                let _ = session.respond_to_approval(&request_id, ApprovalDecision::Deny);
            }
            Ok(AgentEvent::TurnCompleted { .. } | AgentEvent::Exited { .. }) => break,
            Ok(AgentEvent::Error {
                recoverable: false,
                message,
                ..
            }) => {
                return finish(Err(ExecError::new(
                    "provider_failed",
                    format!("{name} couldn't answer: {message}"),
                )));
            }
            Ok(_) => {}
            Err(RecvTimeoutError::Timeout) => {
                let _ = session.interrupt();
                return finish(Err(ExecError::new(
                    "provider_timeout",
                    format!("{name} didn't answer in time. Try again."),
                )));
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    let answer = completed.unwrap_or(streamed).trim().to_owned();
    if answer.is_empty() {
        return finish(Err(ExecError::new(
            "provider_no_answer",
            format!("{name} finished without an answer. Try rephrasing the request."),
        )));
    }
    finish(Ok(answer))
}

#[cfg(test)]
#[path = "orchestrator_tests.rs"]
mod tests;
