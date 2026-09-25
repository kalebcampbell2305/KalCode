//! An interactive session: the provider's real CLI in a PTY, with its hook calls turned into
//! `AgentEvent`s for the Z3 runtime (one status machine for headless and interactive threads).
//!
//! Status sources, and nothing else (docs/PROVIDER_PANES.md §2):
//!
//! | Hook | `AgentEvent`s |
//! | --- | --- |
//! | First matching SessionStart (startup/resume/clear) | `SessionStarted`, `Status(idle)` |
//! | Repeated SessionStart (compact/fork) | no duplicate lifecycle transition |
//! | UserPromptSubmit | `Status(active)`; first prompt → title (never stored) |
//! | PreToolUse | `ToolRequested`; engine routing: `ApprovalRequired` then, when allowed, `ToolStarted` + `Status(by tool)`; provider-prompt routing: `ToolStarted` + `Status(by tool)` |
//! | PermissionRequest, Notification(permission_prompt) | `Status(waiting_for_user, "Answer in Claude Code")` |
//! | Notification(idle_prompt, elicitation…, agent_needs_input) | `Status(waiting_for_user)` |
//! | PostToolUse / PostToolUseFailure | `ToolCompleted { ok }`; `FileChanged` for edit tools |
//! | Stop | open tool calls closed as not run, `TurnCompleted { ok: true }` |
//! | StopFailure | `Error { recoverable }`, `TurnCompleted { ok: false }` |
//! | process exit | `Exited { exit_code }` |
//!
//! The runtime ignores `waiting_for_permission` from providers (it owns approval state), so a
//! prompt shown by the provider itself is reported as WAITING FOR YOU with a detail.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError, Weak};
use std::time::Duration;

use kalcode_contracts::agent::{
    AgentEvent, AgentEventSink, AgentInput, AgentSession, FileChange, ProviderError,
};
use kalcode_contracts::ids::new_id;
use kalcode_contracts::permissions::{
    ActionKind, ActionOrigin, ApprovalDecision, NormalizedAction,
};
use kalcode_contracts::threads::ThreadStatus;
use kalcode_hook_bridge::server::{HookHandler, Registration};
use kalcode_hook_bridge::{HookEvent, HookRecord, HookReply};
use kalcode_pty::{AttachId, PtySession, TerminalSize};
use serde_json::Value;

use super::{ApprovalExpiry, DecisionRouting, HookChannelState, PaneInfo, TitleSink};
use crate::claude::actions::{self, ActionContext};

/// Approvals one session may hold at once. More `PreToolUse` calls go to the provider's own
/// prompt immediately, so a flood can't fill KalCode's approval queue.
pub const MAX_HELD_APPROVALS: usize = 8;
/// Tool lifecycles retained between `PreToolUse` and completion/stop. This independently bounds
/// provider-prompt routing, where no KalCode approval is held.
pub const MAX_OPEN_TOOLS: usize = 64;
/// Largest single write from a pane view (as for Z1 terminals).
pub const MAX_WRITE_BYTES: usize = 64 * 1024;

const ANSWER_IN_PROVIDER: &str = "Answer in Claude Code";

/// What differs between the providers a pane can run (PROVIDERS-2). Claude Code is the default:
/// hooks, and KalCode answers approvals with engine routing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PaneProfile {
    /// Detail shown while the provider's own prompt waits for the person.
    pub answer_in: &'static str,
    /// Whether KalCode can answer this provider's approvals at all.
    pub kalcode_answers: bool,
}

pub(crate) const CLAUDE_PROFILE: PaneProfile = PaneProfile {
    answer_in: ANSWER_IN_PROVIDER,
    kalcode_answers: true,
};

/// Timing for one session. Defaults per docs/campaigns/Z7-W4-THREATS.md §4.5.
#[derive(Debug, Clone, Copy)]
pub struct SessionLimits {
    /// How long KalCode holds a PreToolUse call waiting for the person.
    pub ask_window: Duration,
    /// No hook call by then: the pane is marked "limited status".
    pub hooks_expected_within: Duration,
    pub max_held: usize,
}

impl Default for SessionLimits {
    fn default() -> Self {
        Self {
            ask_window: kalcode_hook_bridge::helper::ASK_WINDOW,
            hooks_expected_within: Duration::from_secs(20),
            max_held: MAX_HELD_APPROVALS,
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[derive(Debug, Clone)]
struct OpenTool {
    started: bool,
}

#[derive(Debug, Default)]
struct HookState {
    /// Tool calls requested and not completed, by tool call id.
    open_tools: BTreeMap<String, OpenTool>,
    first_prompt_seen: bool,
    last_status: Option<(ThreadStatus, Option<String>)>,
}

#[derive(Default)]
struct LifecycleState {
    events: VecDeque<AgentEvent>,
    draining: bool,
}

const CHANNEL_WAITING: u8 = 0;
const CHANNEL_ACTIVE: u8 = 1;
const CHANNEL_LIMITED: u8 = 2;
const CHANNEL_ENDED: u8 = 3;

pub(crate) struct Shared {
    pub(crate) ctx: ActionContext,
    pub(crate) provider_id: String,
    routing: DecisionRouting,
    sink: Box<dyn AgentEventSink>,
    pub(crate) pty: OnceLock<PtySession>,
    registration: Mutex<Option<Registration>>,
    lifecycle: Mutex<LifecycleState>,
    state: Mutex<HookState>,
    /// Held PreToolUse calls by KalCode request id.
    pending: Mutex<HashMap<String, SyncSender<ApprovalDecision>>>,
    provider_session_id: Mutex<Option<String>>,
    session_started_emitted: AtomicBool,
    channel: AtomicU8,
    stopping: AtomicBool,
    ended: AtomicBool,
    exit_code: Mutex<Option<i64>>,
    limits: SessionLimits,
    expiry: Option<Arc<dyn ApprovalExpiry>>,
    titles: Option<Arc<dyn TitleSink>>,
    profile: OnceLock<PaneProfile>,
    /// Terminal views attached right now (they answer the PTY's cursor-position requests).
    pub(crate) views: std::sync::atomic::AtomicUsize,
}

/// Everything a session needs besides its PTY, which is attached after spawning.
pub(crate) struct SessionParts {
    pub ctx: ActionContext,
    pub provider_id: String,
    pub routing: DecisionRouting,
    pub sink: Box<dyn AgentEventSink>,
    pub provider_session_id: String,
    pub limits: SessionLimits,
    pub expiry: Option<Arc<dyn ApprovalExpiry>>,
    pub titles: Option<Arc<dyn TitleSink>>,
}

impl Shared {
    pub(crate) fn new(parts: SessionParts) -> Arc<Self> {
        Arc::new(Self {
            ctx: parts.ctx,
            provider_id: parts.provider_id,
            routing: parts.routing,
            sink: parts.sink,
            pty: OnceLock::new(),
            registration: Mutex::new(None),
            lifecycle: Mutex::new(LifecycleState::default()),
            state: Mutex::new(HookState::default()),
            pending: Mutex::new(HashMap::new()),
            provider_session_id: Mutex::new(Some(parts.provider_session_id)),
            session_started_emitted: AtomicBool::new(false),
            channel: AtomicU8::new(CHANNEL_WAITING),
            stopping: AtomicBool::new(false),
            ended: AtomicBool::new(false),
            exit_code: Mutex::new(None),
            limits: parts.limits,
            expiry: parts.expiry,
            titles: parts.titles,
            profile: OnceLock::new(),
            views: std::sync::atomic::AtomicUsize::new(0),
        })
    }

    pub(crate) fn set_profile(&self, profile: PaneProfile) {
        let _ = self.profile.set(profile);
    }

    fn profile(&self) -> PaneProfile {
        self.profile.get().copied().unwrap_or(CLAUDE_PROFILE)
    }

    /// The provider session id isn't known yet (a new Codex pane learns it from `notify`).
    pub(crate) fn forget_session_id(&self) {
        lock(&self.provider_session_id).take();
        self.session_started_emitted.store(false, Ordering::SeqCst);
    }

    /// No structured hook channel for this provider: status comes from the process (and, for
    /// Codex, authenticated `notify`). The pane says "limited status".
    pub(crate) fn mark_limited(&self) {
        let _lifecycle = lock(&self.lifecycle);
        if !self.is_terminal() {
            self.channel.store(CHANNEL_LIMITED, Ordering::SeqCst);
        }
    }

    pub(crate) fn set_registration(&self, registration: Registration) {
        let _lifecycle = lock(&self.lifecycle);
        if !self.is_terminal() {
            *lock(&self.registration) = Some(registration);
        }
    }

    fn is_terminal(&self) -> bool {
        self.ended.load(Ordering::SeqCst) || self.stopping.load(Ordering::SeqCst)
    }

    /// Queues events while the caller holds `lifecycle`, returning whether it became the drainer.
    /// Provider callbacks run only from [`Self::drain_events`], outside every session mutex, so a
    /// callback may safely re-enter status, termination, or approval APIs.
    fn queue_events_locked(
        &self,
        lifecycle: &mut LifecycleState,
        events: impl IntoIterator<Item = AgentEvent>,
    ) -> bool {
        let mut added = false;
        for event in events {
            if let AgentEvent::Status { status, detail } = &event {
                let next = (*status, detail.clone());
                let mut state = lock(&self.state);
                if state.last_status.as_ref() == Some(&next) {
                    continue;
                }
                state.last_status = Some(next);
            }
            lifecycle.events.push_back(event);
            added = true;
        }
        if added && !lifecycle.draining {
            lifecycle.draining = true;
            true
        } else {
            false
        }
    }

    fn drain_events(&self, should_drain: bool) {
        if !should_drain {
            return;
        }
        loop {
            let event = {
                let mut lifecycle = lock(&self.lifecycle);
                match lifecycle.events.pop_front() {
                    Some(event) => event,
                    None => {
                        lifecycle.draining = false;
                        return;
                    }
                }
            };
            self.sink.emit(event);
        }
    }

    pub(crate) fn channel_state(&self) -> HookChannelState {
        match self.channel.load(Ordering::SeqCst) {
            CHANNEL_ACTIVE => HookChannelState::Active,
            CHANNEL_LIMITED => HookChannelState::Limited,
            CHANNEL_ENDED => HookChannelState::Ended,
            _ => HookChannelState::Waiting,
        }
    }

    pub(crate) fn info(&self) -> PaneInfo {
        let channel = self.channel_state();
        PaneInfo {
            thread_id: self.ctx.thread_id.clone(),
            provider_id: self.provider_id.clone(),
            hook_channel: channel,
            decision_routing: self.routing,
            kalcode_answers_approvals: self.profile().kalcode_answers
                && self.routing == DecisionRouting::Engine
                && channel == HookChannelState::Active,
            running: !self.ended.load(Ordering::SeqCst),
            exit_code: *lock(&self.exit_code),
        }
    }

    /// Called by the watchdog: no hook call arrived in time.
    pub(crate) fn hooks_overdue(&self) {
        let should_drain = {
            let mut lifecycle = lock(&self.lifecycle);
            if self.is_terminal()
                || self
                    .channel
                    .compare_exchange(
                        CHANNEL_WAITING,
                        CHANNEL_LIMITED,
                        Ordering::SeqCst,
                        Ordering::SeqCst,
                    )
                    .is_err()
            {
                return;
            }
            tracing::warn!(event = "pane.hooks_inactive", thread_id = %self.ctx.thread_id);
            self.queue_events_locked(
                &mut lifecycle,
                [AgentEvent::Error {
                    code: "hooks_inactive".into(),
                    message:
                        "KalCode isn't receiving Claude Code's hook events, so this pane shows \
                          limited status and approvals happen in Claude Code. Your Claude Code \
                          settings may disable hooks."
                            .into(),
                    recoverable: true,
                }],
            )
        };
        self.drain_events(should_drain);
    }

    /// The PTY process ended.
    pub(crate) fn on_exit(&self, code: u32, killed: bool) {
        let should_drain = {
            let mut lifecycle = lock(&self.lifecycle);
            if self.ended.load(Ordering::SeqCst) {
                return;
            }
            self.ended.store(true, Ordering::SeqCst);
            self.channel.store(CHANNEL_ENDED, Ordering::SeqCst);
            // Held calls end with a denial (their helpers are gone with the process anyway).
            lock(&self.pending).clear();
            lock(&self.state).open_tools.clear();
            // Revoke the session: late or stray hook calls are rejected from now on.
            lock(&self.registration).take();
            *lock(&self.exit_code) = Some(i64::from(code));
            // Windows exit codes are 32-bit unsigned (NTSTATUS values included); keep the bits.
            self.queue_events_locked(
                &mut lifecycle,
                [AgentEvent::Exited {
                    exit_code: Some(code as i32),
                }],
            )
        };
        tracing::info!(event = "pane.exited", thread_id = %self.ctx.thread_id, code, killed);
        self.drain_events(should_drain);
    }

    fn tool_status(tool: &str) -> ThreadStatus {
        match tool {
            "Bash" | "PowerShell" => ThreadStatus::RunningCommand,
            "Edit" | "Write" | "NotebookEdit" | "MultiEdit" => ThreadStatus::Editing,
            _ => ThreadStatus::RunningTool,
        }
    }

    /// Marks an admitted tool as running and returns its events. The caller serializes the state
    /// transition and publication with process exit by holding `lifecycle`.
    fn start_tool_events(&self, tool_call_id: &str, tool: &str, summary: &str) -> Vec<AgentEvent> {
        if let Some(open) = lock(&self.state).open_tools.get_mut(tool_call_id) {
            open.started = true;
        }
        vec![
            AgentEvent::ToolStarted {
                tool_call_id: tool_call_id.to_owned(),
            },
            AgentEvent::Status {
                status: Self::tool_status(tool),
                detail: Some(summary.to_owned()),
            },
        ]
    }

    /// Closes an admitted tool and returns its event while the caller holds `lifecycle`.
    fn close_tool_event(
        &self,
        tool_call_id: &str,
        ok: bool,
        summary: Option<&str>,
    ) -> Option<AgentEvent> {
        lock(&self.state)
            .open_tools
            .remove(tool_call_id)
            .map(|_| AgentEvent::ToolCompleted {
                tool_call_id: tool_call_id.to_owned(),
                ok,
                summary: summary.map(str::to_owned),
            })
    }

    /// The action for a tool call. Oversized or missing input is classified as an opaque tool,
    /// which the engine always asks about.
    fn action_for(&self, record: &HookRecord, tool: &str) -> (NormalizedAction, String) {
        let now = kalcode_core::time::now_rfc3339();
        let mut action = match (&record.tool_input, record.tool_input_dropped) {
            (Some(input), false) => actions::normalize(&self.ctx, tool, input, now),
            _ => NormalizedAction {
                id: new_id(),
                thread_id: self.ctx.thread_id.clone(),
                workspace_id: self.ctx.workspace_id.clone(),
                provider_id: kalcode_contracts::agent::ProviderId::new(&self.provider_id),
                action: ActionKind::Tool {
                    tool: tool.to_owned(),
                    input_summary: "input too large to show".into(),
                },
                summary: format!("Use {tool}"),
                requested_at: now,
                origin: None,
            },
        };
        if let Some(reason) = known_gap(tool, record.tool_input.as_ref()) {
            // A shape the classifier can't judge fully yet (SEC-LATENT §5): opaque, so the
            // engine asks for an explicit one-time approval in every mode.
            action.action = ActionKind::Tool {
                tool: tool.to_owned(),
                input_summary: reason.to_owned(),
            };
        }
        action.provider_id = kalcode_contracts::agent::ProviderId::new(&self.provider_id);
        action.origin = Some(ActionOrigin::Thread {
            thread_id: self.ctx.thread_id.clone(),
        });
        let summary = action.summary.clone();
        (action, summary)
    }

    fn pre_tool_use(&self, record: &HookRecord) -> HookReply {
        let tool = record.tool_name.clone().unwrap_or_else(|| "unknown".into());
        let tool_call_id = record.tool_use_id.clone().unwrap_or_else(new_id);
        let (action, summary) = self.action_for(record, &tool);
        let action_id = action.id.clone();
        let (approval, should_drain) = {
            let mut lifecycle = lock(&self.lifecycle);
            if self.is_terminal() {
                return HookReply::Deny {
                    reason: "The KalCode session is ending.".into(),
                };
            }
            self.channel.store(CHANNEL_ACTIVE, Ordering::SeqCst);

            match self.routing {
                DecisionRouting::ProviderPrompt => {
                    {
                        let mut state = lock(&self.state);
                        if state.open_tools.len() >= MAX_OPEN_TOOLS
                            || state.open_tools.contains_key(&tool_call_id)
                        {
                            tracing::warn!(
                                event = "pane.tools_bounded",
                                thread_id = %self.ctx.thread_id
                            );
                            return HookReply::Ask {
                                reason: "Several tool calls are already active; answer this one in the provider."
                                    .into(),
                            };
                        }
                        state
                            .open_tools
                            .insert(tool_call_id.clone(), OpenTool { started: true });
                    }
                    let should_drain = self.queue_events_locked(
                        &mut lifecycle,
                        [
                            AgentEvent::ToolRequested {
                                tool_call_id: tool_call_id.clone(),
                                tool: tool.clone(),
                                summary: summary.clone(),
                            },
                            AgentEvent::ToolStarted {
                                tool_call_id: tool_call_id.clone(),
                            },
                            AgentEvent::Status {
                                status: Self::tool_status(&tool),
                                detail: Some(summary.clone()),
                            },
                        ],
                    );
                    (None, should_drain)
                }
                DecisionRouting::Engine => {
                    let request_id = new_id();
                    let (tx, receiver) = mpsc::sync_channel(1);
                    {
                        let mut pending = lock(&self.pending);
                        if pending.len() >= self.limits.max_held {
                            tracing::warn!(
                                event = "pane.approvals_bounded",
                                thread_id = %self.ctx.thread_id
                            );
                            return HookReply::Ask {
                                reason: "Several requests are already waiting in KalCode; answer this one in Claude Code."
                                    .into(),
                            };
                        }
                        let mut state = lock(&self.state);
                        if state.open_tools.len() >= MAX_OPEN_TOOLS
                            || state.open_tools.contains_key(&tool_call_id)
                        {
                            tracing::warn!(
                                event = "pane.tools_bounded",
                                thread_id = %self.ctx.thread_id
                            );
                            return HookReply::Ask {
                                reason: "Several tool calls are already active; answer this one in Claude Code."
                                    .into(),
                            };
                        }
                        pending.insert(request_id.clone(), tx);
                        state
                            .open_tools
                            .insert(tool_call_id.clone(), OpenTool { started: false });
                    }
                    let should_drain = self.queue_events_locked(
                        &mut lifecycle,
                        [
                            AgentEvent::ToolRequested {
                                tool_call_id: tool_call_id.clone(),
                                tool: tool.clone(),
                                summary: summary.clone(),
                            },
                            AgentEvent::ApprovalRequired {
                                request_id: request_id.clone(),
                                action,
                            },
                        ],
                    );
                    (Some((request_id, receiver)), should_drain)
                }
            }
        };
        self.drain_events(should_drain);

        match approval {
            None => HookReply::NoDecision,
            Some((request_id, receiver)) => self.ask_engine(
                action_id,
                &tool_call_id,
                &tool,
                &summary,
                request_id,
                receiver,
            ),
        }
    }

    fn ask_engine(
        &self,
        action_id: String,
        tool_call_id: &str,
        tool: &str,
        summary: &str,
        request_id: String,
        receiver: mpsc::Receiver<ApprovalDecision>,
    ) -> HookReply {
        match receiver.recv_timeout(self.limits.ask_window) {
            Ok(ApprovalDecision::Deny) => {
                let should_drain = {
                    let mut lifecycle = lock(&self.lifecycle);
                    if self.is_terminal() {
                        return HookReply::Deny {
                            reason: "The KalCode session ended.".into(),
                        };
                    }
                    let event =
                        self.close_tool_event(tool_call_id, false, Some("Denied by KalCode"));
                    self.queue_events_locked(&mut lifecycle, event)
                };
                self.drain_events(should_drain);
                HookReply::Deny {
                    reason: "KalCode denied this action (its policy, or your answer).".into(),
                }
            }
            Ok(_) => {
                let should_drain = {
                    let mut lifecycle = lock(&self.lifecycle);
                    if self.is_terminal() {
                        return HookReply::Deny {
                            reason: "The KalCode session ended.".into(),
                        };
                    }
                    let events = self.start_tool_events(tool_call_id, tool, summary);
                    self.queue_events_locked(&mut lifecycle, events)
                };
                self.drain_events(should_drain);
                HookReply::Allow {
                    reason: "Allowed by KalCode.".into(),
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                {
                    let _lifecycle = lock(&self.lifecycle);
                    if self.is_terminal() {
                        return HookReply::Deny {
                            reason: "The KalCode session ended.".into(),
                        };
                    }
                    lock(&self.pending).remove(&request_id);
                }
                if let Some(expiry) = &self.expiry {
                    expiry.answered_in_provider(&self.ctx.thread_id, &action_id);
                }
                HookReply::Ask {
                    reason: "Nobody answered in KalCode; answer in Claude Code.".into(),
                }
            }
            Err(RecvTimeoutError::Disconnected) => HookReply::Deny {
                reason: "The KalCode session ended.".into(),
            },
        }
    }

    /// Status events. Returns the events to emit (pure except for session state).
    fn status_events(&self, record: &HookRecord) -> Vec<AgentEvent> {
        let Some(event) = record.event else {
            return Vec::new();
        };
        let waiting = |detail: &str| AgentEvent::Status {
            status: ThreadStatus::WaitingForUser,
            detail: Some(detail.to_owned()),
        };
        match event {
            HookEvent::SessionStart => {
                let mut events = Vec::new();
                let Some(id) = &record.provider_session_id else {
                    return events;
                };
                let (accepted, started) = self.observe_session_id(id, false);
                if !accepted {
                    return events;
                }
                events.extend(started);
                if matches!(
                    record.source.as_deref(),
                    None | Some("startup" | "resume" | "clear")
                ) {
                    events.push(AgentEvent::Status {
                        status: ThreadStatus::Idle,
                        detail: None,
                    });
                }
                events
            }
            HookEvent::UserPromptSubmit => {
                vec![AgentEvent::Status {
                    status: ThreadStatus::Active,
                    detail: None,
                }]
            }
            HookEvent::PermissionRequest => vec![waiting(self.profile().answer_in)],
            HookEvent::Notification => match record.notification_type.as_deref() {
                Some("permission_prompt") => vec![waiting(self.profile().answer_in)],
                Some("idle_prompt") => vec![waiting("Claude Code is waiting for your input")],
                Some("elicitation_dialog" | "elicitation_url_dialog" | "agent_needs_input") => {
                    vec![waiting("Claude Code needs your input")]
                }
                _ => Vec::new(),
            },
            HookEvent::PostToolUse | HookEvent::PostToolUseFailure => {
                let ok = event == HookEvent::PostToolUse;
                let mut events = Vec::new();
                if let Some(id) = &record.tool_use_id
                    && lock(&self.state).open_tools.remove(id).is_some()
                {
                    events.push(AgentEvent::ToolCompleted {
                        tool_call_id: id.clone(),
                        ok,
                        summary: None,
                    });
                }
                let edits = matches!(
                    record.tool_name.as_deref(),
                    Some("Edit" | "Write" | "NotebookEdit" | "MultiEdit")
                );
                if ok
                    && edits
                    && let Some(path) = record.tool_input.as_ref().and_then(|input| {
                        input
                            .get("file_path")
                            .or_else(|| input.get("notebook_path"))
                            .and_then(Value::as_str)
                    })
                {
                    events.push(AgentEvent::FileChanged {
                        path: path.to_owned(),
                        change: FileChange::Modified,
                    });
                }
                events
            }
            HookEvent::Stop => {
                let open: Vec<String> = std::mem::take(&mut lock(&self.state).open_tools)
                    .into_keys()
                    .collect();
                let mut events: Vec<AgentEvent> = open
                    .into_iter()
                    .map(|tool_call_id| AgentEvent::ToolCompleted {
                        tool_call_id,
                        ok: false,
                        summary: Some("Not run".into()),
                    })
                    .collect();
                events.push(AgentEvent::TurnCompleted { ok: true });
                events
            }
            HookEvent::StopFailure => {
                let message = match record.error_type.as_deref() {
                    Some("rate_limit") => "Claude Code hit a rate limit. Try again in a moment.",
                    Some("overloaded") => "Claude Code's service is overloaded. Try again soon.",
                    Some("authentication_failed" | "oauth_org_not_allowed") => {
                        "Claude Code couldn't sign in. Sign in again in the pane."
                    }
                    Some("billing_error" | "account_on_hold") => {
                        "Claude Code reported an account or billing problem."
                    }
                    _ => "Claude Code's turn ended with an error.",
                };
                vec![
                    AgentEvent::Error {
                        code: format!(
                            "provider_{}",
                            record.error_type.as_deref().unwrap_or("stop_failure")
                        ),
                        message: message.into(),
                        recoverable: true,
                    },
                    AgentEvent::TurnCompleted { ok: false },
                ]
            }
            // Codex `notify` (docs/PROVIDER_PANES.md §3): the thread id, and turn completion.
            HookEvent::CodexNotify => {
                let mut events = Vec::new();
                let Some(id) = record
                    .provider_session_id
                    .as_ref()
                    .filter(|id| kalcode_contracts::ids::is_valid_id(id))
                else {
                    return events;
                };
                let (accepted, started) = self.observe_session_id(id, true);
                if !accepted {
                    return events;
                }
                events.extend(started);
                if record.codex_type.as_deref() == Some("agent-turn-complete") {
                    events.push(AgentEvent::TurnCompleted { ok: true });
                }
                events
            }
            // Activity detail only, and lifecycle the process exit reports better.
            HookEvent::SubagentStart
            | HookEvent::SubagentStop
            | HookEvent::SessionEnd
            | HookEvent::PreToolUse => Vec::new(),
        }
    }

    fn observe_session_id(
        &self,
        id: &str,
        require_contract_id: bool,
    ) -> (bool, Option<AgentEvent>) {
        if require_contract_id && !kalcode_contracts::ids::is_valid_id(id) {
            return (false, None);
        }
        let accepted = {
            let mut known = lock(&self.provider_session_id);
            match known.as_deref() {
                None => {
                    *known = Some(id.to_owned());
                    true
                }
                Some(expected) => expected == id,
            }
        };
        if !accepted {
            tracing::warn!(event = "pane.session_id_mismatch", thread_id = %self.ctx.thread_id);
            return (false, None);
        }
        let event = (!self.session_started_emitted.swap(true, Ordering::SeqCst)).then(|| {
            AgentEvent::SessionStarted {
                provider_session_id: id.to_owned(),
                model: None,
            }
        });
        (true, event)
    }

    pub(crate) fn handle(&self, record: HookRecord) -> HookReply {
        let blocking = record.event.is_some_and(HookEvent::is_blocking);
        if record.validate().is_err() {
            return if blocking {
                HookReply::Deny {
                    reason: "KalCode rejected an invalid hook record.".into(),
                }
            } else {
                HookReply::Ack
            };
        }
        if blocking {
            return self.pre_tool_use(&record);
        }

        let (should_drain, first_prompt) = {
            let mut lifecycle = lock(&self.lifecycle);
            if self.is_terminal() {
                return HookReply::Ack;
            }
            self.channel.store(CHANNEL_ACTIVE, Ordering::SeqCst);
            let first_prompt = if record.event == Some(HookEvent::UserPromptSubmit) {
                let first = {
                    let mut state = lock(&self.state);
                    !std::mem::replace(&mut state.first_prompt_seen, true)
                };
                first.then(|| record.prompt.clone()).flatten()
            } else {
                None
            };
            let events = self.status_events(&record);
            (
                self.queue_events_locked(&mut lifecycle, events),
                first_prompt,
            )
        };
        if let (Some(titles), Some(prompt)) = (&self.titles, first_prompt.as_deref()) {
            titles.first_prompt(&self.ctx.thread_id, prompt);
        }
        self.drain_events(should_drain);
        HookReply::Ack
    }

    pub(crate) fn pty(&self) -> Option<&PtySession> {
        self.pty.get()
    }
}

/// Tool calls whose shape the permission classifier can't judge fully yet
/// (`docs/campaigns/SEC-LATENT.md` §5), treated as opaque by the bridge:
/// - recursive searches (the Grep tool over a folder; `grep -r`, `rg`, `findstr /s`,
///   `Select-String -Recurse`, `Get-ChildItem -Recurse`) read every file below, `.env` included;
/// - pipelines, which the classifier judges one command at a time;
/// - multi-level wildcards (`src/*/config`), checked only statically.
pub(crate) fn known_gap(tool: &str, input: Option<&Value>) -> Option<&'static str> {
    let field = |key: &str| input.and_then(|i| i.get(key)).and_then(Value::as_str);
    match tool {
        "Grep" => {
            let path = field("path").map(std::path::Path::new);
            let single_file = path.is_some_and(|p| p.is_absolute() && p.is_file());
            (!single_file).then_some("recursive search: may read credential files")
        }
        "Bash" | "PowerShell" => {
            let command = field("command")?;
            let lower = command.to_ascii_lowercase();
            let words: Vec<&str> = lower.split_whitespace().collect();
            let recursive = words.iter().enumerate().any(|(i, w)| {
                let program = w.rsplit(['/', '\\']).next().unwrap_or(w);
                let program = program.trim_end_matches(".exe");
                let rest = &words[i + 1..];
                match program {
                    "rg" | "ripgrep" | "ag" => true,
                    "grep" | "egrep" | "fgrep" => {
                        rest.iter().take_while(|a| a.starts_with('-')).any(|a| {
                            *a == "--recursive"
                                || *a == "--dereference-recursive"
                                || (!a.starts_with("--") && (a.contains('r') || a.contains('R')))
                        })
                    }
                    "findstr" => rest.contains(&"/s"),
                    "select-string" | "sls" | "get-childitem" | "gci" | "dir" | "ls" => rest
                        .iter()
                        .any(|a| a.starts_with("-r") && "-recurse".starts_with(*a)),
                    _ => false,
                }
            });
            if recursive {
                return Some("recursive search: may read credential files");
            }
            if command.contains('|') {
                return Some("pipeline: judged as a whole only after review");
            }
            let deep_wildcard = command.split_whitespace().any(|arg| {
                arg.find('*')
                    .is_some_and(|star| arg[star..].contains(['/', '\\']))
            });
            deep_wildcard.then_some("multi-level wildcard")
        }
        _ => None,
    }
}

/// The bridge holds sessions weakly, so a revoked or dropped session is never kept alive by it.
pub(crate) struct HandlerRef(pub(crate) Weak<Shared>);

impl HookHandler for HandlerRef {
    fn handle(&self, record: HookRecord) -> HookReply {
        match self.0.upgrade() {
            Some(shared) => shared.handle(record),
            None if record.event.is_some_and(HookEvent::is_blocking) => HookReply::Deny {
                reason: "The KalCode session has ended.".into(),
            },
            None => HookReply::Ack,
        }
    }
}

/// The `AgentSession` the Z3 runtime drives. Input is typed in the pane, not sent by KalCode.
pub struct InteractiveSession {
    pub(crate) shared: Arc<Shared>,
}

impl InteractiveSession {
    pub fn attach(
        &self,
        listener: impl Fn(&[u8]) -> bool + Send + Sync + 'static,
    ) -> Option<AttachId> {
        self.shared.pty().map(|pty| pty.attach(listener))
    }

    pub fn info(&self) -> PaneInfo {
        self.shared.info()
    }

    pub fn resize(&self, size: TerminalSize) -> Result<(), ProviderError> {
        let pty = self.shared.pty().ok_or(ProviderError::SessionEnded)?;
        pty.resize(size)
            .map_err(|e| ProviderError::Io(e.to_string()))
    }
}

impl AgentSession for InteractiveSession {
    fn provider_session_id(&self) -> Option<String> {
        lock(&self.shared.provider_session_id).clone()
    }

    fn send(&self, _input: AgentInput) -> Result<(), ProviderError> {
        // The person types in the pane. KalCode never types into a provider's TUI for them.
        Err(ProviderError::Unsupported)
    }

    fn interrupt(&self) -> Result<(), ProviderError> {
        // A user action from KalCode's UI: the same key the person would press in the pane.
        let pty = self.shared.pty().ok_or(ProviderError::SessionEnded)?;
        pty.write(b"\x1b")
            .map_err(|e| ProviderError::Io(e.to_string()))
    }

    fn terminate(&self) -> Result<(), ProviderError> {
        {
            let _lifecycle = lock(&self.shared.lifecycle);
            if !self.shared.ended.load(Ordering::SeqCst) {
                self.shared.stopping.store(true, Ordering::SeqCst);
                lock(&self.shared.pending).clear();
            }
        }
        if let Some(pty) = self.shared.pty() {
            pty.kill().map_err(|e| ProviderError::Io(e.to_string()))?;
        }
        Ok(())
    }

    fn respond_to_approval(
        &self,
        request_id: &str,
        decision: ApprovalDecision,
    ) -> Result<(), ProviderError> {
        // Unknown ids are answers to calls that already went to the provider's prompt.
        {
            let _lifecycle = lock(&self.shared.lifecycle);
            if self.shared.is_terminal() {
                return Ok(());
            }
            if let Some(waiter) = lock(&self.shared.pending).remove(request_id) {
                let _ = waiter.try_send(decision);
            }
        }
        Ok(())
    }
}

impl Drop for InteractiveSession {
    fn drop(&mut self) {
        // The runtime dropped the session (stopped or replaced): the process must not outlive it.
        let has_process = self.shared.pty().is_some();
        let should_kill = {
            let _lifecycle = lock(&self.shared.lifecycle);
            if !has_process || self.shared.ended.load(Ordering::SeqCst) {
                false
            } else {
                self.shared.stopping.store(true, Ordering::SeqCst);
                lock(&self.shared.pending).clear();
                true
            }
        };
        if should_kill && let Some(pty) = self.shared.pty() {
            let _ = pty.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Condvar;

    #[derive(Clone, Copy)]
    enum GateEvent {
        ToolRequested,
        ApprovalRequired,
    }

    #[derive(Default)]
    struct GateState {
        entered: bool,
        released: bool,
    }

    struct GatedSink {
        gate_on: GateEvent,
        gate: Mutex<GateState>,
        changed: Condvar,
        events: Mutex<Vec<AgentEvent>>,
    }

    impl GatedSink {
        fn new(gate_on: GateEvent) -> Arc<Self> {
            Arc::new(Self {
                gate_on,
                gate: Mutex::new(GateState::default()),
                changed: Condvar::new(),
                events: Mutex::new(Vec::new()),
            })
        }

        fn emit(&self, event: AgentEvent) {
            let gated = matches!(
                (self.gate_on, &event),
                (GateEvent::ToolRequested, AgentEvent::ToolRequested { .. })
                    | (
                        GateEvent::ApprovalRequired,
                        AgentEvent::ApprovalRequired { .. }
                    )
            );
            lock(&self.events).push(event);
            if gated {
                let mut gate = lock(&self.gate);
                gate.entered = true;
                self.changed.notify_all();
                while !gate.released {
                    gate = self
                        .changed
                        .wait(gate)
                        .unwrap_or_else(PoisonError::into_inner);
                }
            }
        }

        fn wait_entered(&self) {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            let mut gate = lock(&self.gate);
            while !gate.entered {
                let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                assert!(!remaining.is_zero(), "event sink was not entered");
                gate = self
                    .changed
                    .wait_timeout(gate, remaining)
                    .unwrap_or_else(PoisonError::into_inner)
                    .0;
            }
        }

        fn release(&self) {
            lock(&self.gate).released = true;
            self.changed.notify_all();
        }

        fn events(&self) -> Vec<AgentEvent> {
            lock(&self.events).clone()
        }

        fn request_id(&self) -> String {
            lock(&self.events)
                .iter()
                .find_map(|event| match event {
                    AgentEvent::ApprovalRequired { request_id, .. } => Some(request_id.clone()),
                    _ => None,
                })
                .expect("approval request")
        }
    }

    fn shared(
        routing: DecisionRouting,
        limits: SessionLimits,
    ) -> (Arc<Shared>, mpsc::Receiver<AgentEvent>) {
        let (tx, rx) = mpsc::channel();
        let sink = move |event: AgentEvent| {
            let _ = tx.send(event);
        };
        let shared = Shared::new(SessionParts {
            ctx: ActionContext {
                thread_id: new_id(),
                workspace_id: new_id(),
                working_directory: "/work".into(),
            },
            provider_id: "claude-code".into(),
            routing,
            sink: Box::new(sink),
            provider_session_id: new_id(),
            limits,
            expiry: None,
            titles: None,
        });
        (shared, rx)
    }

    fn gated_shared(gate_on: GateEvent, routing: DecisionRouting) -> (Arc<Shared>, Arc<GatedSink>) {
        let sink = GatedSink::new(gate_on);
        let captured = sink.clone();
        let shared = Shared::new(SessionParts {
            ctx: ActionContext {
                thread_id: new_id(),
                workspace_id: new_id(),
                working_directory: "/work".into(),
            },
            provider_id: "claude-code".into(),
            routing,
            sink: Box::new(move |event| captured.emit(event)),
            provider_session_id: new_id(),
            limits: SessionLimits {
                ask_window: Duration::from_millis(250),
                ..SessionLimits::default()
            },
            expiry: None,
            titles: None,
        });
        (shared, sink)
    }

    fn record(event: HookEvent, value: Value) -> HookRecord {
        kalcode_hook_bridge::record::from_claude_stdin(event, value.to_string().as_bytes())
            .expect("record")
    }

    fn drain(rx: &mpsc::Receiver<AgentEvent>) -> Vec<AgentEvent> {
        rx.try_iter().collect()
    }

    #[test]
    fn status_mapping_follows_the_design_table() {
        let (s, rx) = shared(DecisionRouting::ProviderPrompt, SessionLimits::default());
        let provider_session_id = lock(&s.provider_session_id).clone().expect("session id");
        s.handle(record(
            HookEvent::SessionStart,
            json!({"session_id": provider_session_id, "source": "startup"}),
        ));
        assert_eq!(
            drain(&rx),
            [
                AgentEvent::SessionStarted {
                    provider_session_id: provider_session_id.clone(),
                    model: None
                },
                AgentEvent::Status {
                    status: ThreadStatus::Idle,
                    detail: None
                }
            ]
        );
        assert_eq!(s.channel_state(), HookChannelState::Active);

        s.handle(record(
            HookEvent::SessionStart,
            json!({"session_id": provider_session_id, "source": "compact"}),
        ));
        assert!(drain(&rx).is_empty());

        s.handle(record(HookEvent::UserPromptSubmit, json!({"prompt": "hi"})));
        assert_eq!(
            drain(&rx),
            [AgentEvent::Status {
                status: ThreadStatus::Active,
                detail: None
            }]
        );

        s.handle(record(
            HookEvent::Notification,
            json!({"notification_type": "permission_prompt"}),
        ));
        assert_eq!(
            drain(&rx),
            [AgentEvent::Status {
                status: ThreadStatus::WaitingForUser,
                detail: Some(ANSWER_IN_PROVIDER.into())
            }]
        );
        s.handle(record(
            HookEvent::Notification,
            json!({"notification_type": "auth_success"}),
        ));
        assert!(drain(&rx).is_empty());

        s.handle(record(
            HookEvent::StopFailure,
            json!({"error_type": "rate_limit"}),
        ));
        let events = drain(&rx);
        assert!(
            matches!(&events[0], AgentEvent::Error { code, recoverable: true, .. } if code == "provider_rate_limit")
        );
        assert_eq!(events[1], AgentEvent::TurnCompleted { ok: false });
    }

    #[test]
    fn provider_session_id_is_latched_and_session_started_is_emitted_once() {
        let (s, rx) = shared(DecisionRouting::ProviderPrompt, SessionLimits::default());
        let expected = lock(&s.provider_session_id).clone().expect("expected id");
        let session_start = || {
            record(
                HookEvent::SessionStart,
                json!({"session_id": expected, "source": "resume"}),
            )
        };

        s.handle(session_start());
        s.handle(session_start());
        s.handle(record(
            HookEvent::SessionStart,
            json!({"session_id": "different-session", "source": "resume"}),
        ));

        assert_eq!(
            lock(&s.provider_session_id).as_deref(),
            Some(expected.as_str())
        );
        assert_eq!(
            drain(&rx)
                .iter()
                .filter(|event| matches!(event, AgentEvent::SessionStarted { .. }))
                .count(),
            1
        );
    }

    #[test]
    fn codex_new_session_latches_the_first_valid_thread_id() {
        let (s, rx) = shared(DecisionRouting::ProviderPrompt, SessionLimits::default());
        s.forget_session_id();
        let first = new_id();
        let different = new_id();

        for id in [&first, &first, &different] {
            s.handle(HookRecord {
                event: Some(HookEvent::CodexNotify),
                provider_session_id: Some(id.clone()),
                codex_type: Some("agent-turn-complete".into()),
                ..HookRecord::default()
            });
        }

        assert_eq!(
            lock(&s.provider_session_id).as_deref(),
            Some(first.as_str())
        );
        assert_eq!(
            drain(&rx)
                .iter()
                .filter(|event| matches!(event, AgentEvent::SessionStarted { .. }))
                .count(),
            1
        );
    }

    #[test]
    fn malformed_codex_notify_does_not_activate_the_hook_channel() {
        let (s, rx) = shared(DecisionRouting::ProviderPrompt, SessionLimits::default());
        s.forget_session_id();
        assert_eq!(s.channel_state(), HookChannelState::Waiting);

        assert_eq!(
            s.handle(HookRecord {
                event: Some(HookEvent::CodexNotify),
                ..HookRecord::default()
            }),
            HookReply::Ack
        );

        assert_eq!(s.channel_state(), HookChannelState::Waiting);
        assert!(drain(&rx).is_empty());
    }

    #[test]
    fn duplicate_status_and_tool_transitions_are_suppressed() {
        let (s, rx) = shared(DecisionRouting::ProviderPrompt, SessionLimits::default());
        s.handle(record(
            HookEvent::UserPromptSubmit,
            json!({"prompt": "first"}),
        ));
        s.handle(record(
            HookEvent::UserPromptSubmit,
            json!({"prompt": "duplicate status"}),
        ));
        assert_eq!(
            drain(&rx)
                .iter()
                .filter(|event| matches!(event, AgentEvent::Status { .. }))
                .count(),
            1
        );

        let tool = || {
            record(
                HookEvent::PreToolUse,
                json!({"tool_name": "Bash", "tool_use_id": "same", "tool_input": {"command": "npm test"}}),
            )
        };
        assert_eq!(s.handle(tool()), HookReply::NoDecision);
        drain(&rx);
        assert!(matches!(s.handle(tool()), HookReply::Ask { .. }));
        assert!(drain(&rx).is_empty());
    }

    #[test]
    fn approval_overflow_does_not_create_a_tool_lifecycle() {
        let (s, rx) = shared(
            DecisionRouting::Engine,
            SessionLimits {
                max_held: 1,
                ..SessionLimits::default()
            },
        );
        let first = engine_call(&s, "first");
        let request_id = approval_request(&rx).0;
        assert!(matches!(
            s.handle(record(
                HookEvent::PreToolUse,
                json!({"tool_name": "Bash", "tool_use_id": "overflow", "tool_input": {"command": "ls"}}),
            )),
            HookReply::Ask { .. }
        ));
        assert!(drain(&rx).is_empty());
        session(&s)
            .respond_to_approval(&request_id, ApprovalDecision::Deny)
            .expect("respond");
        first.join().expect("join");
        drain(&rx);

        s.handle(record(HookEvent::Stop, json!({})));
        assert_eq!(drain(&rx), [AgentEvent::TurnCompleted { ok: true }]);
    }

    #[test]
    fn exit_wins_before_approval_admission_without_emitting_or_retaining_it() {
        let (s, rx) = shared(
            DecisionRouting::Engine,
            SessionLimits {
                ask_window: Duration::from_millis(150),
                ..SessionLimits::default()
            },
        );
        let pending = lock(&s.pending);
        let exiting = {
            let s = s.clone();
            std::thread::spawn(move || s.on_exit(0, false))
        };
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !s.ended.load(Ordering::SeqCst) {
            assert!(
                std::time::Instant::now() < deadline,
                "exit did not publish the ended state"
            );
            std::thread::yield_now();
        }
        // Exit owns the lifecycle boundary but is deliberately blocked while clearing waiters.
        // A concurrent hook must not admit or publish an approval behind it.
        let call = engine_call(&s, "racing");
        drop(pending);

        assert!(matches!(
            call.join().expect("hook call"),
            HookReply::Deny { .. }
        ));
        exiting.join().expect("exit");
        assert!(lock(&s.pending).is_empty());
        assert_eq!(drain(&rx), [AgentEvent::Exited { exit_code: Some(0) }]);
    }

    #[test]
    fn exit_is_ordered_after_admitted_approval_events_when_sink_reenters_slowly() {
        let (s, sink) = gated_shared(GateEvent::ToolRequested, DecisionRouting::Engine);
        let call = engine_call(&s, "ordered");
        sink.wait_entered();

        s.on_exit(0, false);
        sink.release();

        assert!(matches!(
            call.join().expect("hook call"),
            HookReply::Deny { .. }
        ));
        let events = sink.events();
        assert!(matches!(
            events.as_slice(),
            [
                AgentEvent::ToolRequested { .. },
                AgentEvent::ApprovalRequired { .. },
                AgentEvent::Exited { exit_code: Some(0) }
            ]
        ));
    }

    #[test]
    fn queued_approval_cannot_allow_or_emit_tool_state_after_exit() {
        let (s, sink) = gated_shared(GateEvent::ApprovalRequired, DecisionRouting::Engine);
        let call = engine_call(&s, "queued");
        sink.wait_entered();

        session(&s)
            .respond_to_approval(&sink.request_id(), ApprovalDecision::ApproveOnce)
            .expect("queue approval");
        s.on_exit(0, false);
        sink.release();

        assert!(matches!(
            call.join().expect("hook call"),
            HookReply::Deny { .. }
        ));
        let events = sink.events();
        assert!(matches!(events.last(), Some(AgentEvent::Exited { .. })));
        assert!(!events.iter().any(|event| matches!(
            event,
            AgentEvent::ToolStarted { .. } | AgentEvent::Status { .. }
        )));
    }

    #[test]
    fn provider_prompt_events_are_ordered_before_exit_when_sink_reenters_slowly() {
        let (s, sink) = gated_shared(GateEvent::ToolRequested, DecisionRouting::ProviderPrompt);
        let call = engine_call(&s, "provider-ordered");
        sink.wait_entered();

        s.on_exit(0, false);
        sink.release();

        assert_eq!(call.join().expect("hook call"), HookReply::NoDecision);
        assert!(matches!(
            sink.events().as_slice(),
            [
                AgentEvent::ToolRequested { .. },
                AgentEvent::ToolStarted { .. },
                AgentEvent::Status { .. },
                AgentEvent::Exited { exit_code: Some(0) }
            ]
        ));
    }

    #[test]
    fn provider_prompt_tool_lifecycles_are_bounded() {
        let (s, rx) = shared(DecisionRouting::ProviderPrompt, SessionLimits::default());
        for index in 0..64 {
            assert_eq!(
                s.handle(record(
                    HookEvent::PreToolUse,
                    json!({"tool_name": "Bash", "tool_use_id": format!("tool-{index}"), "tool_input": {"command": "npm test"}}),
                )),
                HookReply::NoDecision
            );
        }
        drain(&rx);
        assert!(matches!(
            s.handle(record(
                HookEvent::PreToolUse,
                json!({"tool_name": "Bash", "tool_use_id": "overflow", "tool_input": {"command": "npm test"}}),
            )),
            HookReply::Ask { .. }
        ));
        assert!(drain(&rx).is_empty());
    }

    #[test]
    fn tool_calls_in_provider_prompt_routing_never_ask_the_engine() {
        let (s, rx) = shared(DecisionRouting::ProviderPrompt, SessionLimits::default());
        let reply = s.handle(record(
            HookEvent::PreToolUse,
            json!({"tool_name": "Bash", "tool_use_id": "t1", "tool_input": {"command": "npm test"}}),
        ));
        assert_eq!(reply, HookReply::NoDecision);
        let events = drain(&rx);
        assert!(
            matches!(&events[0], AgentEvent::ToolRequested { tool_call_id, summary, .. } if tool_call_id == "t1" && summary == "Run npm test")
        );
        assert_eq!(
            events[1],
            AgentEvent::ToolStarted {
                tool_call_id: "t1".into()
            }
        );
        assert!(matches!(
            &events[2],
            AgentEvent::Status {
                status: ThreadStatus::RunningCommand,
                ..
            }
        ));
        assert!(
            !events
                .iter()
                .any(|e| matches!(e, AgentEvent::ApprovalRequired { .. }))
        );

        s.handle(record(
            HookEvent::PostToolUse,
            json!({"tool_name": "Bash", "tool_use_id": "t1", "tool_output": {"stdout": "secret"}}),
        ));
        assert_eq!(
            drain(&rx),
            [AgentEvent::ToolCompleted {
                tool_call_id: "t1".into(),
                ok: true,
                summary: None
            }]
        );
    }

    #[test]
    fn edits_report_file_changes_and_stop_closes_open_calls() {
        let (s, rx) = shared(DecisionRouting::ProviderPrompt, SessionLimits::default());
        s.handle(record(
            HookEvent::PreToolUse,
            json!({"tool_name": "Write", "tool_use_id": "w1", "tool_input": {"file_path": "/work/a.rs", "content": "x"}}),
        ));
        s.handle(record(
            HookEvent::PreToolUse,
            json!({"tool_name": "Bash", "tool_use_id": "b1", "tool_input": {"command": "rm x"}}),
        ));
        drain(&rx);
        s.handle(record(
            HookEvent::PostToolUse,
            json!({"tool_name": "Write", "tool_use_id": "w1", "tool_input": {"file_path": "/work/a.rs"}}),
        ));
        let events = drain(&rx);
        assert!(events.contains(&AgentEvent::FileChanged {
            path: "/work/a.rs".into(),
            change: FileChange::Modified
        }));
        s.handle(record(
            HookEvent::Stop,
            json!({"last_assistant_message": "Status: DONE"}),
        ));
        assert_eq!(
            drain(&rx),
            [
                AgentEvent::ToolCompleted {
                    tool_call_id: "b1".into(),
                    ok: false,
                    summary: Some("Not run".into())
                },
                AgentEvent::TurnCompleted { ok: true }
            ]
        );
    }

    fn engine_call(s: &Arc<Shared>, id: &str) -> std::thread::JoinHandle<HookReply> {
        let s = s.clone();
        let id = id.to_owned();
        std::thread::spawn(move || {
            s.handle(record(
                HookEvent::PreToolUse,
                json!({"tool_name": "Bash", "tool_use_id": id, "tool_input": {"command": "cargo build"}}),
            ))
        })
    }

    fn approval_request(rx: &mpsc::Receiver<AgentEvent>) -> (String, NormalizedAction) {
        loop {
            match rx.recv_timeout(Duration::from_secs(5)).expect("event") {
                AgentEvent::ApprovalRequired { request_id, action } => return (request_id, action),
                _ => continue,
            }
        }
    }

    fn session(s: &Arc<Shared>) -> InteractiveSession {
        InteractiveSession { shared: s.clone() }
    }

    #[test]
    fn engine_routing_waits_for_the_decision_and_maps_it() {
        let (s, rx) = shared(DecisionRouting::Engine, SessionLimits::default());
        let call = engine_call(&s, "a1");
        let (request_id, action) = approval_request(&rx);
        assert_eq!(
            action.origin,
            Some(ActionOrigin::Thread {
                thread_id: s.ctx.thread_id.clone()
            })
        );
        assert_eq!(action.thread_id, s.ctx.thread_id);
        session(&s)
            .respond_to_approval(&request_id, ApprovalDecision::ApproveOnce)
            .expect("respond");
        assert!(matches!(
            call.join().expect("join"),
            HookReply::Allow { .. }
        ));

        let call = engine_call(&s, "a2");
        let (request_id, _) = approval_request(&rx);
        session(&s)
            .respond_to_approval(&request_id, ApprovalDecision::Deny)
            .expect("respond");
        assert!(matches!(call.join().expect("join"), HookReply::Deny { .. }));
    }

    struct Expired(Mutex<Vec<(String, String)>>);
    impl ApprovalExpiry for Expired {
        fn answered_in_provider(&self, thread_id: &str, action_id: &str) {
            lock(&self.0).push((thread_id.to_owned(), action_id.to_owned()));
        }
    }

    #[test]
    fn unanswered_ask_hands_over_to_the_provider_prompt_and_expires() {
        let (tx, rx) = mpsc::channel();
        let expired = Arc::new(Expired(Mutex::new(Vec::new())));
        let s = Shared::new(SessionParts {
            ctx: ActionContext {
                thread_id: new_id(),
                workspace_id: new_id(),
                working_directory: "/w".into(),
            },
            provider_id: "claude-code".into(),
            routing: DecisionRouting::Engine,
            sink: Box::new(move |e: AgentEvent| {
                let _ = tx.send(e);
            }),
            provider_session_id: new_id(),
            limits: SessionLimits {
                ask_window: Duration::from_millis(150),
                ..SessionLimits::default()
            },
            expiry: Some(expired.clone()),
            titles: None,
        });
        let call = engine_call(&s, "late");
        let (request_id, action) = approval_request(&rx);
        let reply = call.join().expect("join");
        assert!(matches!(reply, HookReply::Ask { .. }), "{reply:?}");
        assert_eq!(*lock(&expired.0), [(s.ctx.thread_id.clone(), action.id)]);
        // A late answer is ignored: the provider's prompt owns the call now.
        session(&s)
            .respond_to_approval(&request_id, ApprovalDecision::ApproveOnce)
            .expect("respond");
    }

    #[test]
    fn held_approvals_are_bounded() {
        let (s, rx) = shared(
            DecisionRouting::Engine,
            SessionLimits {
                max_held: 2,
                ..SessionLimits::default()
            },
        );
        let first = engine_call(&s, "h1");
        let second = engine_call(&s, "h2");
        let a = approval_request(&rx).0;
        let b = approval_request(&rx).0;
        let third = s.handle(record(
            HookEvent::PreToolUse,
            json!({"tool_name": "Bash", "tool_use_id": "h3", "tool_input": {"command": "ls"}}),
        ));
        assert!(matches!(third, HookReply::Ask { .. }), "{third:?}");
        for id in [a, b] {
            session(&s)
                .respond_to_approval(&id, ApprovalDecision::Deny)
                .expect("respond");
        }
        first.join().expect("join");
        second.join().expect("join");
    }

    #[test]
    fn classifier_gaps_are_opaque() {
        let bash = |c: &str| json!({ "command": c });
        for (tool, input) in [
            ("Grep", json!({"pattern": "KEY"})),
            ("Grep", json!({"pattern": "KEY", "path": "/work"})),
            ("Bash", bash("grep -rn TOKEN .")),
            ("Bash", bash("grep -Rl KEY src")),
            ("Bash", bash("rg password")),
            ("Bash", bash("/usr/bin/rg x")),
            ("PowerShell", bash("findstr /s secret *.txt")),
            (
                "PowerShell",
                bash("Get-ChildItem -Recurse -Include *.pem | Get-Content"),
            ),
            (
                "PowerShell",
                bash("Select-String -Path * -Pattern key -Recurse"),
            ),
            ("Bash", bash("cat package.json | node -e 'x'")),
            ("Bash", bash("cat src/*/config")),
        ] {
            assert!(known_gap(tool, Some(&input)).is_some(), "{tool}: {input}");
        }
        for (tool, input) in [
            ("Bash", bash("npm test")),
            ("Bash", bash("grep TODO src/main.rs")),
            ("Bash", bash("ls src/*.rs")),
            ("Read", json!({"file_path": "/w/a"})),
            ("Edit", json!({"file_path": "/w/a"})),
        ] {
            assert_eq!(known_gap(tool, Some(&input)), None, "{tool}: {input}");
        }
        let (s, _rx) = shared(DecisionRouting::Engine, SessionLimits::default());
        let (action, summary) = s.action_for(
            &record(
                HookEvent::PreToolUse,
                json!({"tool_name": "Bash", "tool_input": {"command": "rg API_KEY"}}),
            ),
            "Bash",
        );
        assert!(matches!(action.action, ActionKind::Tool { .. }));
        assert_eq!(
            summary, "Run rg API_KEY",
            "the person still sees the command"
        );
    }

    #[test]
    fn oversized_tool_input_is_opaque() {
        let (s, _rx) = shared(DecisionRouting::ProviderPrompt, SessionLimits::default());
        let record = HookRecord {
            event: Some(HookEvent::PreToolUse),
            tool_name: Some("Bash".into()),
            tool_input_dropped: true,
            ..HookRecord::default()
        };
        let (action, _) = s.action_for(&record, "Bash");
        assert!(matches!(action.action, ActionKind::Tool { .. }));
    }

    #[test]
    fn an_ended_session_denies_and_ignores() {
        let (s, rx) = shared(DecisionRouting::Engine, SessionLimits::default());
        s.on_exit(0, false);
        assert_eq!(drain(&rx), [AgentEvent::Exited { exit_code: Some(0) }]);
        assert!(matches!(
            s.handle(record(HookEvent::PreToolUse, json!({"tool_name": "Bash"}))),
            HookReply::Deny { .. }
        ));
        assert_eq!(s.handle(record(HookEvent::Stop, json!({}))), HookReply::Ack);
        assert!(drain(&rx).is_empty());
        assert_eq!(s.channel_state(), HookChannelState::Ended);
        // Exit is reported once.
        s.on_exit(1, false);
        assert!(drain(&rx).is_empty());
    }

    #[test]
    fn no_hooks_in_time_marks_the_pane_limited_once() {
        let (s, rx) = shared(DecisionRouting::Engine, SessionLimits::default());
        s.hooks_overdue();
        assert_eq!(s.channel_state(), HookChannelState::Limited);
        assert!(!s.info().kalcode_answers_approvals);
        assert!(
            matches!(drain(&rx).as_slice(), [AgentEvent::Error { code, .. }] if code == "hooks_inactive")
        );
        s.hooks_overdue();
        assert!(drain(&rx).is_empty());
        // Hooks that start late restore the channel.
        s.handle(record(HookEvent::Stop, json!({})));
        assert_eq!(s.channel_state(), HookChannelState::Active);
        assert!(s.info().kalcode_answers_approvals);
    }

    struct Titles(Mutex<Vec<String>>);
    impl TitleSink for Titles {
        fn first_prompt(&self, _thread_id: &str, prompt: &str) {
            lock(&self.0).push(prompt.to_owned());
        }
    }

    #[test]
    fn first_prompt_is_used_only_for_the_title() {
        let (tx, rx) = mpsc::channel();
        let titles = Arc::new(Titles(Mutex::new(Vec::new())));
        let s = Shared::new(SessionParts {
            ctx: ActionContext {
                thread_id: new_id(),
                workspace_id: new_id(),
                working_directory: "/w".into(),
            },
            provider_id: "claude-code".into(),
            routing: DecisionRouting::ProviderPrompt,
            sink: Box::new(move |e: AgentEvent| {
                let _ = tx.send(e);
            }),
            provider_session_id: new_id(),
            limits: SessionLimits::default(),
            expiry: None,
            titles: Some(titles.clone()),
        });
        s.handle(record(
            HookEvent::UserPromptSubmit,
            json!({"prompt": "Fix the flaky login test"}),
        ));
        s.handle(record(
            HookEvent::UserPromptSubmit,
            json!({"prompt": "second"}),
        ));
        assert_eq!(*lock(&titles.0), ["Fix the flaky login test"]);
        // The prompt never appears in an event.
        for event in drain(&rx) {
            let text = serde_json::to_string(&event).expect("json");
            assert!(!text.contains("flaky"), "{text}");
        }
    }
}
