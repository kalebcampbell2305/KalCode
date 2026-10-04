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

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
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
use kalcode_hook_bridge::server::{HookGate, HookHandler, Registration};
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
/// Bracketed-paste framing plus the one submit byte must fit in one bounded PTY write.
pub const MAX_HANDOFF_TEXT_BYTES: usize = MAX_WRITE_BYTES - 13;

const ANSWER_IN_PROVIDER: &str = "Answer in Claude Code";
const MAX_SUBMIT_BOUNDARIES: usize = 64;
const MAX_CODEX_PENDING_SUBMITS: usize = 64;
const MAX_CODEX_SEEN_TURNS: usize = 4096;
const BRACKETED_PASTE_START: &[u8] = b"\x1b[200~";
const BRACKETED_PASTE_END: &[u8] = b"\x1b[201~";

/// Fixed reasons an automated voice submit cannot enter a provider PTY. Provider output is never
/// included: callers can safely map these variants to stable UI errors.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaneVoiceWriteError {
    SessionEnded,
    TargetChanged,
    ProviderPrompt,
    Unverified,
    Io,
}

/// Why KalCode did not deliver an automated handoff into a provider pane.
///
/// These reasons contain no provider output or user text and are safe to surface directly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandoffDeliveryError {
    /// The authenticated provider lifecycle says a turn is still active.
    ReadyBusy,
    /// The provider is showing a permission, authentication, or other native question.
    ProviderPrompt,
    /// KalCode has no authenticated structured signal proving the native prompt is ready.
    Unverified,
    /// Human input has reached the pane since the last verified native prompt boundary.
    InputPending,
    /// The thread now names a different provider-process instance.
    TargetChanged,
    /// The provider process has ended or is being reconfigured.
    SessionEnded,
    /// The text is empty, too large, or contains terminal-control characters.
    InvalidText,
    /// The guarded PTY write could not be verified after the caller's durable claim.
    Io,
}

impl std::fmt::Display for HandoffDeliveryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::ReadyBusy => "The receiving agent is still working.",
            Self::ProviderPrompt => {
                "The receiving agent is waiting on a provider permission or sign-in prompt."
            }
            Self::Unverified => {
                "KalCode cannot verify that the receiving agent is at an idle native prompt."
            }
            Self::InputPending => {
                "The receiving terminal has unsubmitted or unverified human input."
            }
            Self::TargetChanged => {
                "The receiving agent restarted before the handoff was delivered."
            }
            Self::SessionEnded => "The receiving agent session has ended.",
            Self::InvalidText => {
                "The handoff text is empty, too large, or contains unsafe controls."
            }
            Self::Io => "KalCode could not verify terminal delivery of the handoff.",
        })
    }
}

impl std::error::Error for HandoffDeliveryError {}

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum HandoffReadiness {
    #[default]
    Unverified,
    Ready,
    Busy,
    ProviderPrompt,
}

#[derive(Debug)]
struct ClaudeSubmitBoundary {
    generation: u64,
    trailing_input: bool,
    clears_input: bool,
}

#[derive(Default)]
struct LifecycleState {
    events: VecDeque<AgentEvent>,
    draining: bool,
    input_writes: u64,
    input_pending: bool,
    input_pending_generation: u64,
    claude_submit_boundaries: VecDeque<ClaudeSubmitBoundary>,
    claude_submit_tracking_failed: bool,
    codex_pending_submits: usize,
    codex_seen_turn_ids: HashSet<String>,
    codex_tracking_failed: bool,
    codex_in_bracketed_paste: bool,
    codex_paste_prefix: Vec<u8>,
    cursor_generation: Option<String>,
    cursor_finished_generations: HashSet<String>,
    cursor_tracking_failed: bool,
    cursor_start_seen: bool,
    cursor_model: Option<String>,
    handoff_readiness: HandoffReadiness,
    reconfigure_reserved: bool,
}

const CHANNEL_WAITING: u8 = 0;
const CHANNEL_ACTIVE: u8 = 1;
const CHANNEL_LIMITED: u8 = 2;
const CHANNEL_ENDED: u8 = 3;

pub(crate) struct Shared {
    pub(crate) ctx: ActionContext,
    pub(crate) provider_id: String,
    instance_id: String,
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
            instance_id: new_id(),
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

    fn record_codex_submit_locked(&self, lifecycle: &mut LifecycleState) {
        if lifecycle.codex_tracking_failed {
            lifecycle.handoff_readiness = HandoffReadiness::Unverified;
            return;
        }
        let Some(pending) = lifecycle.codex_pending_submits.checked_add(1) else {
            lifecycle.codex_tracking_failed = true;
            lifecycle.handoff_readiness = HandoffReadiness::Unverified;
            return;
        };
        if pending > MAX_CODEX_PENDING_SUBMITS {
            lifecycle.codex_tracking_failed = true;
            lifecycle.handoff_readiness = HandoffReadiness::Unverified;
            return;
        }
        lifecycle.codex_pending_submits = pending;
        lifecycle.handoff_readiness = HandoffReadiness::Busy;
    }

    fn record_claude_submit_boundary_locked(
        &self,
        lifecycle: &mut LifecycleState,
        generation: u64,
        trailing_input: bool,
        clears_input: bool,
    ) {
        if lifecycle.claude_submit_tracking_failed {
            lifecycle.handoff_readiness = HandoffReadiness::Unverified;
            return;
        }
        if lifecycle.claude_submit_boundaries.len() >= MAX_SUBMIT_BOUNDARIES {
            lifecycle.claude_submit_tracking_failed = true;
            lifecycle.handoff_readiness = HandoffReadiness::Unverified;
            return;
        }
        lifecycle
            .claude_submit_boundaries
            .push_back(ClaudeSubmitBoundary {
                generation,
                trailing_input,
                clears_input,
            });
    }

    fn observe_codex_input_locked(&self, lifecycle: &mut LifecycleState, data: &[u8]) {
        let mut buffered = std::mem::take(&mut lifecycle.codex_paste_prefix);
        buffered.extend_from_slice(data);
        let mut cursor = 0;
        while cursor < buffered.len() {
            let marker = if lifecycle.codex_in_bracketed_paste {
                BRACKETED_PASTE_END
            } else {
                BRACKETED_PASTE_START
            };
            let remaining = &buffered[cursor..];
            if marker.starts_with(remaining) {
                // A partial marker is still real human input until subsequent bytes prove it is
                // terminal framing. In particular, a lone Escape must dirty a ready prompt.
                lifecycle.input_pending = true;
                lifecycle.codex_paste_prefix.extend_from_slice(remaining);
                break;
            }
            if remaining.starts_with(marker) {
                lifecycle.input_pending = true;
                lifecycle.codex_in_bracketed_paste = !lifecycle.codex_in_bracketed_paste;
                cursor += marker.len();
                continue;
            }
            let byte = buffered[cursor];
            cursor += 1;
            if lifecycle.codex_in_bracketed_paste {
                lifecycle.input_pending = true;
            } else if byte == b'\r' {
                self.record_codex_submit_locked(lifecycle);
                lifecycle.input_pending = false;
            } else {
                lifecycle.input_pending = true;
            }
        }
    }

    fn observe_input_write_locked(&self, lifecycle: &mut LifecycleState, data: &[u8]) {
        lifecycle.input_writes = lifecycle.input_writes.saturating_add(1);
        let generation = lifecycle.input_writes;
        if self.provider_id == "codex" {
            self.observe_codex_input_locked(lifecycle, data);
            return;
        }
        lifecycle.input_pending = true;
        lifecycle.input_pending_generation = generation;
        let Some(last_submit) = data.iter().rposition(|byte| matches!(byte, b'\r' | b'\n')) else {
            return;
        };
        let trailing_input = last_submit + 1 < data.len();
        if matches!(self.provider_id.as_str(), "claude-code" | "cursor") {
            // The authenticated UserPromptSubmit that follows consumes this exact boundary.
            // A later write has a higher generation and therefore survives that hook.
            self.record_claude_submit_boundary_locked(lifecycle, generation, trailing_input, true);
        }
    }

    pub(crate) fn write(&self, data: &[u8]) -> Result<(), ProviderError> {
        let mut lifecycle = lock(&self.lifecycle);
        let protocol_reply = terminal_protocol_reply(data);
        if self.is_terminal() {
            return Err(ProviderError::SessionEnded);
        }
        if lifecycle.reconfigure_reserved && !protocol_reply {
            return Err(ProviderError::Io(
                "The pane is restarting with new settings.".into(),
            ));
        }
        let pty = self.pty().ok_or(ProviderError::SessionEnded)?;
        pty.write(data)
            .map_err(|error| ProviderError::Io(error.to_string()))?;
        if !protocol_reply {
            self.observe_input_write_locked(&mut lifecycle, data);
        }
        Ok(())
    }

    pub(crate) fn reserve_if_unused(&self) -> Result<bool, ProviderError> {
        let mut lifecycle = lock(&self.lifecycle);
        if self.is_terminal() {
            return Err(ProviderError::SessionEnded);
        }
        if lifecycle.input_writes != 0 || lifecycle.reconfigure_reserved {
            return Ok(false);
        }
        lifecycle.reconfigure_reserved = true;
        Ok(true)
    }

    pub(crate) fn cancel_unused_reservation(&self) {
        lock(&self.lifecycle).reconfigure_reserved = false;
    }

    fn terminate_reserved(&self) -> Result<(), ProviderError> {
        {
            let mut lifecycle = lock(&self.lifecycle);
            if self.is_terminal() || !lifecycle.reconfigure_reserved {
                return Err(ProviderError::SessionEnded);
            }
            lifecycle.reconfigure_reserved = false;
            self.stopping.store(true, Ordering::SeqCst);
            lock(&self.pending).clear();
        }
        if let Some(pty) = self.pty() {
            pty.kill()
                .map_err(|error| ProviderError::Io(error.to_string()))?;
        }
        Ok(())
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
            instance_id: Some(self.instance_id.clone()),
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
            lifecycle.handoff_readiness = HandoffReadiness::Unverified;
            tracing::warn!(event = "pane.hooks_inactive", thread_id = %self.ctx.thread_id);
            self.queue_events_locked(
                &mut lifecycle,
                [AgentEvent::Error {
                    code: "hooks_inactive".into(),
                    message: if self.provider_id == "cursor" {
                        "KalCode isn't receiving Cursor's hook events. This terminal remains usable, but status and automatic task delivery are unavailable. Check Cursor's plugin and hook settings.".into()
                    } else {
                        "KalCode isn't receiving Claude Code's hook events, so this pane shows limited status and approvals happen in Claude Code. Your Claude Code settings may disable hooks.".into()
                    },
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
                return self.unrecorded("The KalCode session is ending.");
            }
            self.channel.store(CHANNEL_ACTIVE, Ordering::SeqCst);
            lifecycle.handoff_readiness = HandoffReadiness::Busy;

            match self.routing {
                DecisionRouting::ProviderPrompt => {
                    {
                        let mut state = lock(&self.state);
                        if state.open_tools.len() >= MAX_OPEN_TOOLS
                            || state.open_tools.contains_key(&tool_call_id)
                        {
                            // Activity tracking is full (or the id repeats). The provider still
                            // decides; KalCode only skips recording this call.
                            tracing::warn!(
                                event = "pane.tools_bounded",
                                thread_id = %self.ctx.thread_id
                            );
                            return HookReply::NoDecision;
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
                        "Claude Code's sign-in for this account ended. Sign in to it again in Providers, then start a new agent."
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
            HookEvent::CodexNotify | HookEvent::Cursor => {
                // Codex completion is correlated and deduplicated under the lifecycle lock in
                // `accept_codex_notify_locked`; reaching this arm would split those decisions.
                Vec::new()
            }
            // Activity detail only, and lifecycle the process exit reports better.
            HookEvent::SubagentStart
            | HookEvent::SubagentStop
            | HookEvent::SessionEnd
            | HookEvent::PreToolUse => Vec::new(),
        }
    }

    fn accept_codex_notify_locked(
        &self,
        lifecycle: &mut LifecycleState,
        record: &HookRecord,
    ) -> Vec<AgentEvent> {
        let (Some(provider_session_id), Some(turn_id)) = (
            record
                .provider_session_id
                .as_deref()
                .filter(|id| kalcode_contracts::ids::is_valid_id(id)),
            record.codex_turn_id.as_deref(),
        ) else {
            lifecycle.handoff_readiness = HandoffReadiness::Unverified;
            return Vec::new();
        };
        if self.provider_id != "codex"
            || record.codex_type.as_deref() != Some("agent-turn-complete")
        {
            return Vec::new();
        }
        let session_matches = {
            let mut known = lock(&self.provider_session_id);
            match known.as_deref() {
                None => {
                    *known = Some(provider_session_id.to_owned());
                    true
                }
                Some(expected) => expected == provider_session_id,
            }
        };
        if !session_matches {
            tracing::warn!(event = "pane.session_id_mismatch", thread_id = %self.ctx.thread_id);
            return Vec::new();
        }
        if lifecycle.codex_seen_turn_ids.contains(turn_id) {
            return Vec::new();
        }
        let remembered = lifecycle.codex_seen_turn_ids.len() < MAX_CODEX_SEEN_TURNS;
        if remembered {
            lifecycle.codex_seen_turn_ids.insert(turn_id.to_owned());
        } else {
            lifecycle.codex_tracking_failed = true;
        }
        let mut events = Vec::new();
        if !self.session_started_emitted.swap(true, Ordering::SeqCst) {
            events.push(AgentEvent::SessionStarted {
                provider_session_id: provider_session_id.to_owned(),
                model: None,
            });
        }
        events.push(AgentEvent::TurnCompleted { ok: true });
        if lifecycle.codex_tracking_failed || !remembered {
            lifecycle.handoff_readiness = HandoffReadiness::Unverified;
            return events;
        }
        if lifecycle.codex_pending_submits == 0 {
            // A delayed completion without a locally observed submit cannot establish which
            // prompt is now visible. Remember its id so it can never consume a future submit.
            lifecycle.handoff_readiness = HandoffReadiness::Unverified;
            return events;
        }

        lifecycle.codex_pending_submits -= 1;
        lifecycle.handoff_readiness = if lifecycle.codex_pending_submits == 0 {
            HandoffReadiness::Ready
        } else {
            HandoffReadiness::Busy
        };
        events
    }

    /// Updates only from authenticated structured lifecycle records. Provider output and timing
    /// never establish handoff readiness.
    fn observe_handoff_lifecycle_locked(
        &self,
        lifecycle: &mut LifecycleState,
        record: &HookRecord,
    ) {
        match record.event {
            Some(HookEvent::SessionStart)
                if self.provider_id == "claude-code"
                    && matches!(
                        record.source.as_deref(),
                        None | Some("startup" | "resume" | "clear")
                    )
                    && record.provider_session_id.as_deref()
                        == lock(&self.provider_session_id).as_deref() =>
            {
                lifecycle.handoff_readiness = HandoffReadiness::Ready;
            }
            Some(HookEvent::UserPromptSubmit) => {
                // Claude has consumed input through the matching native submit boundary. Preserve
                // anything typed after Enter but before this authenticated hook arrived.
                if let Some(boundary) = lifecycle.claude_submit_boundaries.pop_front()
                    && boundary.clears_input
                    && lifecycle.input_pending_generation <= boundary.generation
                    && !boundary.trailing_input
                {
                    lifecycle.input_pending = false;
                }
                lifecycle.handoff_readiness = if lifecycle.claude_submit_tracking_failed {
                    HandoffReadiness::Unverified
                } else {
                    HandoffReadiness::Busy
                };
            }
            Some(HookEvent::PermissionRequest) => {
                lifecycle.handoff_readiness = HandoffReadiness::ProviderPrompt;
            }
            Some(HookEvent::Notification)
                if matches!(
                    record.notification_type.as_deref(),
                    Some(
                        "permission_prompt"
                            | "idle_prompt"
                            | "elicitation_dialog"
                            | "elicitation_url_dialog"
                            | "agent_needs_input"
                    )
                ) =>
            {
                lifecycle.handoff_readiness = HandoffReadiness::ProviderPrompt;
            }
            Some(HookEvent::Stop) => {
                lifecycle.handoff_readiness = HandoffReadiness::Ready;
            }
            Some(HookEvent::StopFailure)
                if matches!(
                    record.error_type.as_deref(),
                    Some(
                        "authentication_failed"
                            | "oauth_org_not_allowed"
                            | "billing_error"
                            | "account_on_hold"
                    )
                ) =>
            {
                lifecycle.handoff_readiness = HandoffReadiness::ProviderPrompt;
            }
            Some(HookEvent::StopFailure) => {
                lifecycle.handoff_readiness = HandoffReadiness::Ready;
            }
            _ => {}
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

    /// The reply to a `PreToolUse` call KalCode can't record. Provider-prompt sessions leave the
    /// call to the provider's own permission flow; only engine routing refuses it.
    fn unrecorded(&self, reason: &str) -> HookReply {
        match self.routing {
            DecisionRouting::ProviderPrompt => HookReply::NoDecision,
            DecisionRouting::Engine => HookReply::Deny {
                reason: reason.into(),
            },
        }
    }

    fn accept_cursor_locked(
        &self,
        lifecycle: &mut LifecycleState,
        record: &HookRecord,
    ) -> Vec<AgentEvent> {
        let Some(cursor) = record.cursor.as_ref() else {
            return Vec::new();
        };
        let Some(id) = record.provider_session_id.as_deref() else {
            return Vec::new();
        };
        let (accepted, started) = self.observe_session_id(id, false);
        if !accepted {
            return Vec::new();
        }
        let current_generation =
            cursor.generation_id.is_some() && cursor.generation_id == lifecycle.cursor_generation;
        let current_model_signal = cursor.event == "sessionStart"
            || (cursor.event == "beforeSubmitPrompt"
                && cursor
                    .generation_id
                    .as_ref()
                    .is_some_and(|id| !lifecycle.cursor_finished_generations.contains(id)))
            || current_generation;
        let model_changed = current_model_signal
            && cursor.model.is_some()
            && cursor.model != lifecycle.cursor_model;
        let first_identity = started.is_some();
        let mut events = started
            .into_iter()
            .map(|event| match event {
                AgentEvent::SessionStarted {
                    provider_session_id,
                    ..
                } => AgentEvent::SessionStarted {
                    provider_session_id,
                    model: cursor.model.clone(),
                },
                other => other,
            })
            .collect::<Vec<_>>();
        if model_changed {
            lifecycle.cursor_model.clone_from(&cursor.model);
            if !first_identity {
                // The shared runtime updates native session metadata without starting another
                // terminal. This follows model switches made inside Cursor's own UI.
                events.push(AgentEvent::SessionStarted {
                    provider_session_id: id.to_owned(),
                    model: cursor.model.clone(),
                });
            }
        }
        self.channel.store(CHANNEL_ACTIVE, Ordering::SeqCst);
        match cursor.event.as_str() {
            "sessionStart"
                if !lifecycle.cursor_start_seen
                    && !lifecycle.cursor_tracking_failed
                    && lifecycle.cursor_generation.is_none()
                    && lifecycle.cursor_finished_generations.is_empty() =>
            {
                // Verified Cursor CLI 2026.10.01: trust/auth/MCP onboarding precedes this
                // hook; resume skips it. Only a fresh authenticated session can start ready.
                lifecycle.handoff_readiness = HandoffReadiness::Ready;
                lifecycle.cursor_start_seen = true;
                events.push(AgentEvent::Status {
                    status: ThreadStatus::Idle,
                    detail: None,
                });
            }
            "beforeSubmitPrompt" => {
                let Some(generation) = cursor.generation_id.clone() else {
                    return events;
                };
                if lifecycle.cursor_finished_generations.contains(&generation)
                    || lifecycle.cursor_generation.as_ref() == Some(&generation)
                {
                    return events;
                }
                if let Some(boundary) = lifecycle.claude_submit_boundaries.pop_front()
                    && boundary.clears_input
                    && !boundary.trailing_input
                    && lifecycle.input_pending_generation <= boundary.generation
                {
                    lifecycle.input_pending = false;
                }
                lifecycle.cursor_generation = Some(generation);
                lifecycle.cursor_start_seen = true;
                lifecycle.handoff_readiness = HandoffReadiness::Busy;
                events.push(AgentEvent::Status {
                    status: ThreadStatus::Active,
                    detail: None,
                });
            }
            "stop" => {
                let Some(generation) = cursor.generation_id.as_ref() else {
                    return events;
                };
                if lifecycle.cursor_finished_generations.contains(generation) {
                    return events;
                }
                if lifecycle.cursor_generation.as_ref() != Some(generation) {
                    lifecycle.handoff_readiness = HandoffReadiness::Unverified;
                    return events;
                }
                if lifecycle.cursor_finished_generations.len() >= MAX_CODEX_SEEN_TURNS {
                    lifecycle.cursor_tracking_failed = true;
                } else {
                    lifecycle
                        .cursor_finished_generations
                        .insert(generation.clone());
                }
                lifecycle.cursor_generation = None;
                let completed = cursor.status.as_deref() == Some("completed");
                lifecycle.handoff_readiness = if completed && !lifecycle.cursor_tracking_failed {
                    HandoffReadiness::Ready
                } else {
                    HandoffReadiness::Unverified
                };
                events.push(AgentEvent::TurnCompleted { ok: completed });
                if !completed {
                    events.push(AgentEvent::Error {
                        code: "cursor_turn_ended".into(),
                        message: format!("Cursor reported this turn as {}. Open the coding terminal for details.", cursor.status.as_deref().unwrap_or("error")),
                        recoverable: true,
                    });
                }
            }
            "sessionEnd" => {
                lifecycle.handoff_readiness = HandoffReadiness::Unverified;
                lifecycle.cursor_generation = None;
            }
            "postToolUse" | "postToolUseFailure" if current_generation => {
                // A tool event proves work, never prompt readiness or tool permission.
                lifecycle.handoff_readiness = HandoffReadiness::Busy;
            }
            _ => {}
        }
        events
    }

    pub(crate) fn handle(&self, record: HookRecord) -> HookReply {
        let blocking = record.event.is_some_and(HookEvent::is_blocking);
        if record.validate().is_err() {
            return if blocking {
                self.unrecorded("KalCode rejected an invalid hook record.")
            } else {
                HookReply::Ack
            };
        }
        if (self.provider_id == "cursor") != (record.event == Some(HookEvent::Cursor)) {
            return HookReply::Ack;
        }
        if blocking {
            return self.pre_tool_use(&record);
        }

        let (should_drain, first_prompt) = {
            let mut lifecycle = lock(&self.lifecycle);
            if self.is_terminal() {
                return HookReply::Ack;
            }
            if self.provider_id != "cursor" {
                self.channel.store(CHANNEL_ACTIVE, Ordering::SeqCst);
            }
            let first_prompt = if record.event == Some(HookEvent::UserPromptSubmit) {
                let first = {
                    let mut state = lock(&self.state);
                    !std::mem::replace(&mut state.first_prompt_seen, true)
                };
                first.then(|| record.prompt.clone()).flatten()
            } else {
                None
            };
            let events = if record.event == Some(HookEvent::Cursor) {
                self.accept_cursor_locked(&mut lifecycle, &record)
            } else if record.event == Some(HookEvent::CodexNotify) {
                self.accept_codex_notify_locked(&mut lifecycle, &record)
            } else {
                let events = self.status_events(&record);
                self.observe_handoff_lifecycle_locked(&mut lifecycle, &record);
                events
            };
            (
                self.queue_events_locked(&mut lifecycle, events),
                first_prompt,
            )
        };
        if let (Some(titles), Some(prompt)) = (&self.titles, first_prompt.as_deref()) {
            titles.first_prompt(&self.ctx.thread_id, prompt);
        }
        let memory_session = !record.in_subagent
            && record
                .provider_session_id
                .as_ref()
                .is_some_and(|id| lock(&self.provider_session_id).as_ref() == Some(id));
        if memory_session && let Some(text) = record.memory_candidate.as_deref() {
            if record.event == Some(HookEvent::UserPromptSubmit)
                || record
                    .cursor
                    .as_ref()
                    .is_some_and(|cursor| cursor.event == "beforeSubmitPrompt")
            {
                self.sink.remember_user(text);
            } else {
                self.sink.remember(text);
            }
        }
        self.drain_events(should_drain);
        if memory_session
            && record.event == Some(HookEvent::UserPromptSubmit)
            && let Some(query) = record.prompt.as_deref()
            && let Some(text) = self.sink.project_context_for(query)
        {
            return HookReply::ProjectContext { text };
        }
        HookReply::Ack
    }

    pub(crate) fn pty(&self) -> Option<&PtySession> {
        self.pty.get()
    }

    pub(crate) fn instance_id(&self) -> &str {
        &self.instance_id
    }

    fn handoff_blocker_locked(&self, lifecycle: &LifecycleState) -> Option<HandoffDeliveryError> {
        if self.is_terminal() || lifecycle.reconfigure_reserved {
            return Some(HandoffDeliveryError::SessionEnded);
        }
        if !lock(&self.pending).is_empty()
            || lifecycle.handoff_readiness == HandoffReadiness::ProviderPrompt
        {
            return Some(HandoffDeliveryError::ProviderPrompt);
        }
        if self.provider_id == "codex" && lifecycle.codex_tracking_failed {
            return Some(HandoffDeliveryError::Unverified);
        }
        if matches!(self.provider_id.as_str(), "claude-code" | "cursor")
            && (lifecycle.claude_submit_tracking_failed
                || lifecycle.claude_submit_boundaries.len() >= MAX_SUBMIT_BOUNDARIES)
        {
            return Some(HandoffDeliveryError::Unverified);
        }
        if self.provider_id == "cursor" && lifecycle.cursor_tracking_failed {
            return Some(HandoffDeliveryError::Unverified);
        }
        if !matches!(
            self.provider_id.as_str(),
            "claude-code" | "codex" | "cursor"
        ) || self.channel_state() != HookChannelState::Active
        {
            return Some(HandoffDeliveryError::Unverified);
        }
        match lifecycle.handoff_readiness {
            HandoffReadiness::Unverified => Some(HandoffDeliveryError::Unverified),
            HandoffReadiness::Busy => Some(HandoffDeliveryError::ReadyBusy),
            HandoffReadiness::ProviderPrompt => Some(HandoffDeliveryError::ProviderPrompt),
            HandoffReadiness::Ready if lifecycle.input_pending => {
                Some(HandoffDeliveryError::InputPending)
            }
            HandoffReadiness::Ready => None,
        }
    }

    pub(crate) fn handoff_readiness(&self) -> Result<(), HandoffDeliveryError> {
        let lifecycle = lock(&self.lifecycle);
        self.handoff_blocker_locked(&lifecycle).map_or(Ok(()), Err)
    }

    /// Atomically claims and submits one handoff at an authenticated native prompt boundary.
    ///
    /// `before_write` runs under the provider lifecycle lock after every readiness check and
    /// immediately before the first PTY byte. It must not call back into this pane. A callback
    /// failure writes zero bytes; an [`HandoffDeliveryError::Io`] happens after the callback, so
    /// the caller must treat that durable claim as interrupted rather than replayable.
    pub(crate) fn deliver_handoff<F>(
        &self,
        text: &str,
        before_write: F,
    ) -> Result<(), HandoffDeliveryError>
    where
        F: FnOnce() -> Result<(), HandoffDeliveryError>,
    {
        if text.is_empty()
            || text.len() > MAX_HANDOFF_TEXT_BYTES
            || text.chars().any(|character| {
                character == '\u{1b}'
                    || (character.is_control() && !matches!(character, '\n' | '\t'))
            })
        {
            return Err(HandoffDeliveryError::InvalidText);
        }

        let mut lifecycle = lock(&self.lifecycle);
        if let Some(blocked) = self.handoff_blocker_locked(&lifecycle) {
            return Err(blocked);
        }
        let pty = self.pty().ok_or(HandoffDeliveryError::SessionEnded)?;

        before_write()?;

        let mut framed = Vec::with_capacity(text.len() + 13);
        framed.extend_from_slice(b"\x1b[200~");
        framed.extend_from_slice(text.as_bytes());
        framed.extend_from_slice(b"\x1b[201~\r");
        debug_assert!(framed.len() <= MAX_WRITE_BYTES);
        lifecycle.input_writes = lifecycle.input_writes.saturating_add(1);
        // KalCode wrote one complete bracketed paste plus its submit byte atomically. Any later
        // ordinary pane write sets this back to true and survives turn completion.
        lifecycle.input_pending = false;
        if self.provider_id == "codex" {
            self.record_codex_submit_locked(&mut lifecycle);
        } else if matches!(self.provider_id.as_str(), "claude-code" | "cursor") {
            let generation = lifecycle.input_writes;
            self.record_claude_submit_boundary_locked(&mut lifecycle, generation, false, false);
            if !lifecycle.claude_submit_tracking_failed {
                lifecycle.handoff_readiness = HandoffReadiness::Busy;
            }
        } else {
            lifecycle.handoff_readiness = HandoffReadiness::Busy;
        }
        pty.write_acknowledged(&framed)
            .map_err(|_| HandoffDeliveryError::Io)?;
        Ok(())
    }

    /// Sends the provider-native interrupt key under the same lifecycle barrier used by handoff
    /// delivery. Readiness is invalidated before the byte is written, so an interrupt racing a
    /// queued handoff either happens entirely before its claim or entirely after its submit.
    pub(crate) fn interrupt(&self) -> Result<(), ProviderError> {
        let mut lifecycle = lock(&self.lifecycle);
        if self.is_terminal() || lifecycle.reconfigure_reserved {
            return Err(ProviderError::SessionEnded);
        }
        lifecycle.handoff_readiness = HandoffReadiness::Busy;
        lifecycle.input_writes = lifecycle.input_writes.saturating_add(1);
        let pty = self.pty().ok_or(ProviderError::SessionEnded)?;
        pty.write(b"\x1b")
            .map_err(|error| ProviderError::Io(error.to_string()))
    }

    fn voice_submit_blocker_locked(&self) -> Option<PaneVoiceWriteError> {
        if self.is_terminal() {
            return Some(PaneVoiceWriteError::SessionEnded);
        }
        if !lock(&self.pending).is_empty() {
            return Some(PaneVoiceWriteError::ProviderPrompt);
        }
        let provider_prompt =
            lock(&self.state)
                .last_status
                .as_ref()
                .is_some_and(|(status, detail)| {
                    *status == ThreadStatus::WaitingForPermission
                        || (*status == ThreadStatus::WaitingForUser
                            && detail.as_deref() == Some(self.profile().answer_in))
                });
        if provider_prompt {
            return Some(PaneVoiceWriteError::ProviderPrompt);
        }
        // Claude must establish its authenticated lifecycle hook before an automated submit.
        // Codex and Gemini keep provider-native input authority, matching manual pane typing;
        // only their structured prompt signals can block a write.
        if matches!(self.provider_id.as_str(), "claude-code" | "cursor")
            && self.channel_state() != HookChannelState::Active
        {
            return Some(PaneVoiceWriteError::Unverified);
        }
        None
    }

    /// Writes voice input while the lifecycle lock prevents a permission/auth transition from
    /// racing a trusted Enter. Insert-only text is safe to draft before readiness is established;
    /// any submit byte is guarded.
    pub(crate) fn write_voice(&self, data: &[u8]) -> Result<(), PaneVoiceWriteError> {
        let mut lifecycle = lock(&self.lifecycle);
        let protocol_reply = terminal_protocol_reply(data);
        if self.is_terminal() {
            return Err(PaneVoiceWriteError::SessionEnded);
        }
        if lifecycle.reconfigure_reserved && !protocol_reply {
            return Err(PaneVoiceWriteError::SessionEnded);
        }
        if data.iter().any(|byte| matches!(byte, b'\r' | b'\n'))
            && let Some(blocked) = self.voice_submit_blocker_locked()
        {
            return Err(blocked);
        }
        let pty = self.pty().ok_or(PaneVoiceWriteError::SessionEnded)?;
        pty.write(data).map_err(|_| PaneVoiceWriteError::Io)?;
        if !protocol_reply {
            self.observe_input_write_locked(&mut lifecycle, data);
        }
        Ok(())
    }
}

/// Exact, bounded terminal-emulator replies generated in response to a provider query. These
/// bytes are written through xterm's ordinary input callback but are not human input. The
/// classification is deliberately narrow and does not include keys, paste framing, or text.
fn terminal_protocol_reply(data: &[u8]) -> bool {
    if data.len() < 3 || data.len() > 256 || data[0] != 0x1b {
        return false;
    }
    if matches!(data, b"\x1b[I" | b"\x1b[O") {
        return true;
    }
    if data[1] == b'[' {
        if matches!(
            data,
            b"\x1b[?1;2c" | b"\x1b[?6c" | b"\x1b[>0;276;0c" | b"\x1b[0n"
        ) {
            return true;
        }
        let body = &data[2..];
        if let Some(position) = body.strip_suffix(b"R") {
            let position = position.strip_prefix(b"?").unwrap_or(position);
            let mut coordinates = position.split(|byte| *byte == b';');
            return coordinates.next().is_some_and(ascii_number)
                && coordinates.next().is_some_and(ascii_number)
                && coordinates.next().is_none();
        }
        if let Some(mode) = body.strip_suffix(b"$y") {
            let mode = mode.strip_prefix(b"?").unwrap_or(mode);
            let mut values = mode.split(|byte| *byte == b';');
            return values.next().is_some_and(ascii_number)
                && values
                    .next()
                    .is_some_and(|value| matches!(value, b"0" | b"1" | b"2" | b"3" | b"4"))
                && values.next().is_none();
        }
        if let Some(window) = body.strip_suffix(b"t") {
            let mut values = window.split(|byte| *byte == b';');
            return values
                .next()
                .is_some_and(|value| matches!(value, b"4" | b"6" | b"8"))
                && values.next().is_some_and(ascii_number)
                && values.next().is_some_and(ascii_number)
                && values.next().is_none();
        }
        return false;
    }
    if data[1] == b'P' {
        let Some(body) = data[2..].strip_suffix(b"\x1b\\") else {
            return false;
        };
        let Some(report) = body
            .strip_prefix(b"0$r")
            .or_else(|| body.strip_prefix(b"1$r"))
        else {
            return false;
        };
        if matches!(report, b"" | b"0m" | b"61;1\"p") {
            return true;
        }
        if let Some(value) = report.strip_suffix(b" q") {
            return matches!(value, b"1" | b"2" | b"3" | b"4" | b"5" | b"6");
        }
        if let Some(value) = report.strip_suffix(b"\"q") {
            return matches!(value, b"0" | b"1");
        }
        if let Some(margins) = report.strip_suffix(b"r") {
            let mut values = margins.split(|byte| *byte == b';');
            return values.next().is_some_and(ascii_number)
                && values.next().is_some_and(ascii_number)
                && values.next().is_none();
        }
        return false;
    }
    if data[1] == b']' {
        let body = data[2..]
            .strip_suffix(b"\x07")
            .or_else(|| data[2..].strip_suffix(b"\x1b\\"));
        return body.is_some_and(color_report);
    }
    false
}

fn ascii_number(value: &[u8]) -> bool {
    !value.is_empty() && value.iter().all(u8::is_ascii_digit)
}

fn color_report(body: &[u8]) -> bool {
    let mut fields = body.split(|byte| *byte == b';');
    let Some(identifier) = fields.next() else {
        return false;
    };
    let color = if identifier == b"4" {
        let Some(index) = fields.next() else {
            return false;
        };
        if !ascii_number(index)
            || std::str::from_utf8(index)
                .ok()
                .and_then(|index| index.parse::<u16>().ok())
                .is_none_or(|index| index > 255)
        {
            return false;
        }
        fields.next()
    } else if matches!(identifier, b"10" | b"11" | b"12") {
        fields.next()
    } else {
        return false;
    };
    let Some(color) = color else {
        return false;
    };
    if fields.next().is_some() {
        return false;
    }
    let Some(channels) = color.strip_prefix(b"rgb:") else {
        return false;
    };
    let mut channels = channels.split(|byte| *byte == b'/');
    (0..3).all(|_| {
        channels
            .next()
            .is_some_and(|channel| channel.len() == 4 && channel.iter().all(u8::is_ascii_hexdigit))
    }) && channels.next().is_none()
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
pub(crate) struct HandlerRef {
    shared: Weak<Shared>,
    routing: DecisionRouting,
}

impl HandlerRef {
    pub(crate) fn new(shared: &Arc<Shared>) -> Self {
        Self {
            shared: Arc::downgrade(shared),
            routing: shared.routing,
        }
    }

    /// How the bridge treats this session's `PreToolUse` calls when the handler can't answer.
    pub(crate) fn gate(&self) -> HookGate {
        match self.routing {
            DecisionRouting::ProviderPrompt => HookGate::Observe,
            DecisionRouting::Engine => HookGate::Decide,
        }
    }
}

impl HookHandler for HandlerRef {
    fn handle(&self, record: HookRecord) -> HookReply {
        match self.shared.upgrade() {
            Some(shared) => shared.handle(record),
            None if record.event.is_some_and(HookEvent::is_blocking) => match self.routing {
                DecisionRouting::ProviderPrompt => HookReply::NoDecision,
                DecisionRouting::Engine => HookReply::Deny {
                    reason: "The KalCode session has ended.".into(),
                },
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

    fn send(&self, input: AgentInput) -> Result<(), ProviderError> {
        if self.shared.provider_id != "cursor" {
            return Err(ProviderError::Unsupported);
        }
        let AgentInput::Text { text } = input;
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            match self.shared.deliver_handoff(&text, || Ok(())) {
                Ok(()) => return Ok(()),
                Err(HandoffDeliveryError::Unverified) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(HandoffDeliveryError::Io) => return Err(ProviderError::Io("Cursor task delivery could not be verified. Check the terminal before retrying.".into())),
                Err(error) => return Err(ProviderError::Refused {
                    code: "cursor_input_not_ready".into(),
                    message: format!("Cursor could not accept the task: {error} Launch a Cursor terminal in Code, finish native setup, then retry the task."),
                }),
            }
        }
    }

    fn interrupt(&self) -> Result<(), ProviderError> {
        // A user action from KalCode's UI: the same key the person would press in the pane.
        self.shared.interrupt()
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

    fn reserve_if_unused(&self) -> Result<bool, ProviderError> {
        self.shared.reserve_if_unused()
    }

    fn cancel_unused_reservation(&self) {
        self.shared.cancel_unused_reservation();
    }

    fn terminate_reserved(&self) -> Result<(), ProviderError> {
        self.shared.terminate_reserved()
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
        shared_for("claude-code", routing, limits)
    }

    fn shared_for(
        provider_id: &str,
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
            provider_id: provider_id.into(),
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
    fn cursor_memory_preserves_user_provenance_and_rejects_other_sessions() {
        struct MemorySink(Arc<Mutex<Vec<(bool, String)>>>);
        impl AgentEventSink for MemorySink {
            fn emit(&self, _: AgentEvent) {}
            fn remember(&self, text: &str) {
                lock(&self.0).push((false, text.into()));
            }
            fn remember_user(&self, text: &str) {
                lock(&self.0).push((true, text.into()));
            }
        }
        let claims = Arc::new(Mutex::new(Vec::new()));
        let shared = Shared::new(SessionParts {
            ctx: ActionContext {
                thread_id: new_id(),
                workspace_id: new_id(),
                working_directory: "/work".into(),
            },
            provider_id: "cursor".into(),
            routing: DecisionRouting::ProviderPrompt,
            sink: Box::new(MemorySink(claims.clone())),
            provider_session_id: "cursor-session".into(),
            limits: SessionLimits::default(),
            expiry: None,
            titles: None,
        });
        let make = |event: &str, session: &str| {
            kalcode_hook_bridge::record::from_cursor_stdin(event, json!({
                "hook_event_name":event,"conversation_id":session,"generation_id":"generation-one",
                "prompt":"Decision: SQLite holds durable project knowledge.",
                "text":"Architecture: Dashboard.tsx owns the main dashboard shell."
            }).to_string().as_bytes()).unwrap()
        };
        // Cursor's prompt hook remains observing; it never receives a fabricated context schema.
        assert_eq!(
            shared.handle(make("beforeSubmitPrompt", "cursor-session")),
            HookReply::Ack
        );
        shared.handle(make("afterAgentResponse", "cursor-session"));
        shared.handle(make("afterAgentResponse", "another-session"));
        let claims = lock(&claims);
        assert_eq!(claims.len(), 2);
        assert!(claims[0].0);
        assert!(!claims[1].0);
        assert!(claims[0].1.starts_with("Decision:"));
        assert!(claims[1].1.starts_with("Architecture:"));
    }

    #[test]
    fn cursor_lifecycle_binds_native_identity_and_protects_handoff_input() {
        let (s, rx) = shared_for(
            "cursor",
            DecisionRouting::ProviderPrompt,
            SessionLimits::default(),
        );
        s.forget_session_id();
        let event = |name: &str, session: &str, generation: &str| {
            kalcode_hook_bridge::record::from_cursor_stdin(
                name,
                json!({
                    "hook_event_name":name,"conversation_id":session,
                    "generation_id":generation,"status":"completed", "model":"future-9-thinking"
                })
                .to_string()
                .as_bytes(),
            )
            .unwrap()
        };
        s.handle(record(HookEvent::Stop, json!({"session_id":"session"})));
        assert!(
            drain(&rx).is_empty(),
            "Claude-shaped records cannot certify Cursor readiness"
        );
        assert_eq!(s.handoff_readiness(), Err(HandoffDeliveryError::Unverified));
        s.handle(event("sessionStart", "native-session", "turn-1"));
        assert!(drain(&rx).iter().any(|event| matches!(event,
            AgentEvent::SessionStarted { provider_session_id, model }
            if provider_session_id == "native-session" && model.as_deref() == Some("future-9-thinking"))));
        assert!(s.handoff_readiness().is_ok());
        {
            let mut lifecycle = lock(&s.lifecycle);
            s.observe_input_write_locked(&mut lifecycle, b"task\r");
        }
        s.handle(event("beforeSubmitPrompt", "native-session", "turn-1"));
        assert_eq!(s.handoff_readiness(), Err(HandoffDeliveryError::ReadyBusy));
        // A delayed duplicate startup cannot certify an active turn as idle.
        s.handle(event("sessionStart", "native-session", "turn-1"));
        assert_eq!(s.handoff_readiness(), Err(HandoffDeliveryError::ReadyBusy));
        s.handle(event("stop", "other-session", "turn-1"));
        assert_eq!(s.handoff_readiness(), Err(HandoffDeliveryError::ReadyBusy));
        {
            let mut lifecycle = lock(&s.lifecycle);
            s.observe_input_write_locked(&mut lifecycle, b"unfinished next prompt");
        }
        s.handle(event("stop", "native-session", "turn-1"));
        assert_eq!(
            s.handoff_readiness(),
            Err(HandoffDeliveryError::InputPending)
        );
        let completed = drain(&rx);
        assert_eq!(
            completed
                .iter()
                .filter(|event| matches!(event, AgentEvent::TurnCompleted { ok: true }))
                .count(),
            1
        );
        s.handle(event("stop", "native-session", "turn-1"));
        assert!(
            drain(&rx).is_empty(),
            "duplicate completions are never replayed"
        );
        s.handle(event("sessionEnd", "native-session", "turn-1"));
        assert_eq!(s.handoff_readiness(), Err(HandoffDeliveryError::Unverified));
    }

    #[test]
    fn cursor_unmatched_stop_and_resume_cannot_certify_an_idle_prompt() {
        let (s, rx) = shared_for(
            "cursor",
            DecisionRouting::ProviderPrompt,
            SessionLimits::default(),
        );
        let id = lock(&s.provider_session_id).clone().unwrap();
        let event = kalcode_hook_bridge::record::from_cursor_stdin("stop", json!({
            "hook_event_name":"stop","conversation_id":id,"generation_id":"unknown-turn", "status":"completed"
        }).to_string().as_bytes()).unwrap();
        s.handle(event);
        assert_eq!(s.handoff_readiness(), Err(HandoffDeliveryError::Unverified));
        assert!(
            !drain(&rx)
                .iter()
                .any(|event| matches!(event, AgentEvent::TurnCompleted { .. }))
        );
    }

    #[test]
    fn cursor_reviewed_task_never_submits_into_a_provider_prompt_or_dirty_buffer() {
        for (readiness, input_pending) in [
            (HandoffReadiness::ProviderPrompt, false),
            (HandoffReadiness::Ready, true),
            (HandoffReadiness::Busy, false),
        ] {
            let (shared, _rx) = shared_for(
                "cursor",
                DecisionRouting::ProviderPrompt,
                SessionLimits::default(),
            );
            shared.channel.store(CHANNEL_ACTIVE, Ordering::SeqCst);
            {
                let mut lifecycle = lock(&shared.lifecycle);
                lifecycle.handoff_readiness = readiness;
                lifecycle.input_pending = input_pending;
            }
            let session = InteractiveSession { shared };
            let error = session
                .send(AgentInput::Text {
                    text: "reviewed task".into(),
                })
                .unwrap_err();
            assert!(
                matches!(error, ProviderError::Refused { code, .. } if code == "cursor_input_not_ready")
            );
            // No PTY exists: a write would report SessionEnded, so reaching these specific
            // blockers proves refusal happened before any terminal access.
        }
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

        // KalCode marks the account expired on this code and refuses its next launch, so a
        // sign-in inside this pane alone can't restore it: point to the account's sign-in.
        s.handle(record(
            HookEvent::StopFailure,
            json!({"error": "authentication_failed"}),
        ));
        let events = drain(&rx);
        assert!(matches!(&events[0], AgentEvent::Error { code, message, .. }
                if code == "provider_authentication_failed"
                    && message.contains("in Providers")
                    && !message.contains("in the pane")));
    }

    #[test]
    fn voice_submit_guard_uses_authenticated_lifecycle_state() {
        let (s, rx) = shared(DecisionRouting::ProviderPrompt, SessionLimits::default());
        {
            let _lifecycle = lock(&s.lifecycle);
            assert_eq!(
                s.voice_submit_blocker_locked(),
                Some(PaneVoiceWriteError::Unverified),
                "Claude startup without its authenticated SessionStart hook is not submit-ready"
            );
        }

        s.hooks_overdue();
        drain(&rx);
        {
            let _lifecycle = lock(&s.lifecycle);
            assert_eq!(s.channel_state(), HookChannelState::Limited);
            assert_eq!(
                s.voice_submit_blocker_locked(),
                Some(PaneVoiceWriteError::Unverified),
                "Claude limited status cannot certify that Enter will not answer a native prompt"
            );
        }

        let provider_session_id = lock(&s.provider_session_id).clone().expect("session id");
        s.handle(record(
            HookEvent::SessionStart,
            json!({"session_id": provider_session_id, "source": "startup"}),
        ));
        drain(&rx);
        {
            let _lifecycle = lock(&s.lifecycle);
            assert_eq!(s.voice_submit_blocker_locked(), None);
        }

        s.handle(record(
            HookEvent::UserPromptSubmit,
            json!({"prompt": "work"}),
        ));
        drain(&rx);
        {
            let _lifecycle = lock(&s.lifecycle);
            assert_eq!(
                s.voice_submit_blocker_locked(),
                None,
                "active providers accept native TUI steering"
            );
        }

        s.handle(record(
            HookEvent::Notification,
            json!({"notification_type": "permission_prompt"}),
        ));
        drain(&rx);
        let _lifecycle = lock(&s.lifecycle);
        assert_eq!(
            s.voice_submit_blocker_locked(),
            Some(PaneVoiceWriteError::ProviderPrompt)
        );
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
        let (s, rx) = shared_for(
            "codex",
            DecisionRouting::ProviderPrompt,
            SessionLimits::default(),
        );
        s.forget_session_id();
        let first = new_id();
        let different = new_id();
        s.record_codex_submit_locked(&mut lock(&s.lifecycle));

        for (id, turn_id) in [
            (&first, "turn-1"),
            (&first, "turn-1"),
            (&different, "turn-2"),
        ] {
            s.handle(HookRecord {
                event: Some(HookEvent::CodexNotify),
                provider_session_id: Some(id.clone()),
                codex_type: Some("agent-turn-complete".into()),
                codex_turn_id: Some(turn_id.into()),
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
    fn codex_orphan_completion_preserves_events_but_not_handoff_readiness() {
        let (s, rx) = shared_for(
            "codex",
            DecisionRouting::ProviderPrompt,
            SessionLimits::default(),
        );
        s.forget_session_id();
        let provider_session_id = new_id();
        let completion = HookRecord {
            event: Some(HookEvent::CodexNotify),
            provider_session_id: Some(provider_session_id.clone()),
            codex_type: Some("agent-turn-complete".into()),
            codex_turn_id: Some("orphan-turn".into()),
            ..HookRecord::default()
        };

        s.handle(completion.clone());
        s.handle(completion);

        assert_eq!(
            drain(&rx),
            [
                AgentEvent::SessionStarted {
                    provider_session_id,
                    model: None,
                },
                AgentEvent::TurnCompleted { ok: true },
            ]
        );
        assert_eq!(
            lock(&s.lifecycle).handoff_readiness,
            HandoffReadiness::Unverified
        );
    }

    #[test]
    fn malformed_codex_notify_does_not_activate_the_hook_channel() {
        let (s, rx) = shared_for(
            "codex",
            DecisionRouting::ProviderPrompt,
            SessionLimits::default(),
        );
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
    fn codex_pending_submit_cap_fails_closed_permanently() {
        let (s, _rx) = shared_for(
            "codex",
            DecisionRouting::ProviderPrompt,
            SessionLimits::default(),
        );
        let mut lifecycle = lock(&s.lifecycle);
        lifecycle.codex_pending_submits = MAX_CODEX_PENDING_SUBMITS;
        lifecycle.handoff_readiness = HandoffReadiness::Ready;

        s.record_codex_submit_locked(&mut lifecycle);

        assert!(lifecycle.codex_tracking_failed);
        assert_eq!(lifecycle.handoff_readiness, HandoffReadiness::Unverified);
        lifecycle.handoff_readiness = HandoffReadiness::Ready;
        s.record_codex_submit_locked(&mut lifecycle);
        assert_eq!(
            lifecycle.handoff_readiness,
            HandoffReadiness::Unverified,
            "a later submit cannot recover exhausted correlation state"
        );
    }

    #[test]
    fn claude_submit_boundary_cap_fails_closed_permanently() {
        let (s, _rx) = shared(DecisionRouting::ProviderPrompt, SessionLimits::default());
        s.channel.store(CHANNEL_ACTIVE, Ordering::SeqCst);
        let mut lifecycle = lock(&s.lifecycle);
        lifecycle.claude_submit_boundaries = (0..MAX_SUBMIT_BOUNDARIES)
            .map(|generation| ClaudeSubmitBoundary {
                generation: generation as u64,
                trailing_input: false,
                clears_input: true,
            })
            .collect();
        lifecycle.handoff_readiness = HandoffReadiness::Ready;

        s.record_claude_submit_boundary_locked(&mut lifecycle, u64::MAX, false, true);

        assert!(lifecycle.claude_submit_tracking_failed);
        assert_eq!(lifecycle.handoff_readiness, HandoffReadiness::Unverified);
        lifecycle.handoff_readiness = HandoffReadiness::Ready;
        assert_eq!(
            s.handoff_blocker_locked(&lifecycle),
            Some(HandoffDeliveryError::Unverified),
            "later lifecycle status cannot recover exhausted submit correlation"
        );
    }

    #[test]
    fn codex_seen_turn_cap_never_evicts_or_recovers() {
        let (s, _rx) = shared_for(
            "codex",
            DecisionRouting::ProviderPrompt,
            SessionLimits::default(),
        );
        let provider_session_id = lock(&s.provider_session_id)
            .clone()
            .expect("provider session id");
        let mut lifecycle = lock(&s.lifecycle);
        lifecycle.codex_seen_turn_ids = (0..MAX_CODEX_SEEN_TURNS)
            .map(|index| format!("seen-{index}"))
            .collect();
        lifecycle.codex_pending_submits = 1;
        lifecycle.handoff_readiness = HandoffReadiness::Busy;
        let completion = |turn_id: &str| HookRecord {
            event: Some(HookEvent::CodexNotify),
            provider_session_id: Some(provider_session_id.clone()),
            codex_type: Some("agent-turn-complete".into()),
            codex_turn_id: Some(turn_id.into()),
            ..HookRecord::default()
        };

        assert_eq!(
            s.accept_codex_notify_locked(&mut lifecycle, &completion("new-turn")),
            [
                AgentEvent::SessionStarted {
                    provider_session_id: provider_session_id.clone(),
                    model: None,
                },
                AgentEvent::TurnCompleted { ok: true },
            ]
        );
        assert!(lifecycle.codex_tracking_failed);
        assert_eq!(lifecycle.handoff_readiness, HandoffReadiness::Unverified);
        lifecycle.handoff_readiness = HandoffReadiness::Ready;
        assert_eq!(
            s.accept_codex_notify_locked(&mut lifecycle, &completion("later-turn")),
            [AgentEvent::TurnCompleted { ok: true }]
        );
        assert_eq!(
            lifecycle.handoff_readiness,
            HandoffReadiness::Unverified,
            "later completions cannot recover exhausted correlation state"
        );
        assert!(lifecycle.codex_tracking_failed);
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
        // A repeated id is not recorded twice, and the provider still decides: no forced prompt.
        assert_eq!(s.handle(tool()), HookReply::NoDecision);
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
            // Activity tracking is full; the tool still runs under the provider's own rules.
            HookReply::NoDecision
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
#[test]
fn only_terminal_protocol_replies_are_exempt_from_input_use() {
    for reply in [
        b"\x1b[0n".as_slice(),
        b"\x1b[1;12R",
        b"\x1b[?1;2c",
        b"\x1b[>0;276;0c",
        b"\x1b[4;1$y",
        b"\x1bP1$r0m\x1b\\",
        b"\x1b]10;rgb:ffff/ffff/ffff\x07",
        b"\x1b[I",
        b"\x1b[O",
    ] {
        assert!(terminal_protocol_reply(reply), "{reply:?}");
    }
    for input in [
        b"draft".as_slice(),
        b"draft\r",
        b"\x1b[A",
        b"\x1b[200~draft\x1b[201~",
        b"\x03",
        b"\x1b]52;copied secret\x07",
        b"\x1bPhello$rdiscard me\x1b\\",
        b"\x1b[123c",
        b"\x1b[999n",
        b"\x1b[1;2;3R",
    ] {
        assert!(!terminal_protocol_reply(input), "{input:?}");
    }
}
