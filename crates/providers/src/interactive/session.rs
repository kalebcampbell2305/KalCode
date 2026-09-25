//! An interactive session: the provider's real CLI in a PTY, with its hook calls turned into
//! `AgentEvent`s for the Z3 runtime (one status machine for headless and interactive threads).
//!
//! Status sources, and nothing else (docs/PROVIDER_PANES.md §2):
//!
//! | Hook | `AgentEvent`s |
//! | --- | --- |
//! | SessionStart (startup/resume/clear) | `SessionStarted`, `Status(idle)` |
//! | SessionStart (compact/fork) | `SessionStarted` |
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

use std::collections::{BTreeMap, HashMap};
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
    /// The person's keystrokes after a provider prompt mean it was answered (providers without
    /// a structured "prompt answered" signal).
    pub input_answers_prompt: bool,
}

pub(crate) const CLAUDE_PROFILE: PaneProfile = PaneProfile {
    answer_in: ANSWER_IN_PROVIDER,
    kalcode_answers: true,
    input_answers_prompt: false,
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
    state: Mutex<HookState>,
    /// Held PreToolUse calls by KalCode request id.
    pending: Mutex<HashMap<String, SyncSender<ApprovalDecision>>>,
    provider_session_id: Mutex<Option<String>>,
    channel: AtomicU8,
    stopping: AtomicBool,
    ended: AtomicBool,
    exit_code: Mutex<Option<i64>>,
    limits: SessionLimits,
    expiry: Option<Arc<dyn ApprovalExpiry>>,
    titles: Option<Arc<dyn TitleSink>>,
    profile: OnceLock<PaneProfile>,
    /// A provider prompt is showing (set by [`Shared::provider_prompt`]).
    prompt_showing: AtomicBool,
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
            state: Mutex::new(HookState::default()),
            pending: Mutex::new(HashMap::new()),
            provider_session_id: Mutex::new(Some(parts.provider_session_id)),
            channel: AtomicU8::new(CHANNEL_WAITING),
            stopping: AtomicBool::new(false),
            ended: AtomicBool::new(false),
            exit_code: Mutex::new(None),
            limits: parts.limits,
            expiry: parts.expiry,
            titles: parts.titles,
            profile: OnceLock::new(),
            prompt_showing: AtomicBool::new(false),
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
    }

    /// No structured hook channel for this provider: status comes from the process (and, for
    /// Codex, `notify` and OSC 9). The pane says "limited status".
    pub(crate) fn mark_limited(&self) {
        self.channel.store(CHANNEL_LIMITED, Ordering::SeqCst);
    }

    /// The provider's own approval prompt is showing (Codex OSC 9 `approval-requested`).
    pub(crate) fn provider_prompt(&self) {
        if self.ended.load(Ordering::SeqCst) {
            return;
        }
        self.prompt_showing.store(true, Ordering::SeqCst);
        self.emit(AgentEvent::Status {
            status: ThreadStatus::WaitingForUser,
            detail: Some(self.profile().answer_in.to_owned()),
        });
    }

    /// The person typed in the pane.
    pub(crate) fn user_input(&self) {
        if self.profile().input_answers_prompt
            && self.prompt_showing.swap(false, Ordering::SeqCst)
            && !self.ended.load(Ordering::SeqCst)
        {
            self.emit(AgentEvent::Status {
                status: ThreadStatus::Active,
                detail: None,
            });
        }
    }

    pub(crate) fn set_registration(&self, registration: Registration) {
        *lock(&self.registration) = Some(registration);
    }

    fn emit(&self, event: AgentEvent) {
        self.sink.emit(event);
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
        if self
            .channel
            .compare_exchange(
                CHANNEL_WAITING,
                CHANNEL_LIMITED,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_ok()
            && !self.ended.load(Ordering::SeqCst)
        {
            tracing::warn!(event = "pane.hooks_inactive", thread_id = %self.ctx.thread_id);
            self.emit(AgentEvent::Error {
                code: "hooks_inactive".into(),
                message: "KalCode isn't receiving Claude Code's hook events, so this pane shows \
                          limited status and approvals happen in Claude Code. Your Claude Code \
                          settings may disable hooks."
                    .into(),
                recoverable: true,
            });
        }
    }

    /// The PTY process ended.
    pub(crate) fn on_exit(&self, code: u32, killed: bool) {
        if self.ended.swap(true, Ordering::SeqCst) {
            return;
        }
        self.channel.store(CHANNEL_ENDED, Ordering::SeqCst);
        // Held calls end with a denial (their helpers are gone with the process anyway).
        lock(&self.pending).clear();
        // Revoke the session: late or stray hook calls are rejected from now on.
        lock(&self.registration).take();
        *lock(&self.exit_code) = Some(i64::from(code));
        tracing::info!(event = "pane.exited", thread_id = %self.ctx.thread_id, code, killed);
        // Windows exit codes are 32-bit unsigned (NTSTATUS values included); keep the bits.
        self.emit(AgentEvent::Exited {
            exit_code: Some(code as i32),
        });
    }

    fn tool_status(tool: &str) -> ThreadStatus {
        match tool {
            "Bash" | "PowerShell" => ThreadStatus::RunningCommand,
            "Edit" | "Write" | "NotebookEdit" | "MultiEdit" => ThreadStatus::Editing,
            _ => ThreadStatus::RunningTool,
        }
    }

    fn start_tool(&self, tool_call_id: &str, tool: &str, summary: &str) {
        if let Some(open) = lock(&self.state).open_tools.get_mut(tool_call_id) {
            open.started = true;
        }
        self.emit(AgentEvent::ToolStarted {
            tool_call_id: tool_call_id.to_owned(),
        });
        self.emit(AgentEvent::Status {
            status: Self::tool_status(tool),
            detail: Some(summary.to_owned()),
        });
    }

    fn close_tool(&self, tool_call_id: &str, ok: bool, summary: Option<&str>) {
        if lock(&self.state).open_tools.remove(tool_call_id).is_some() {
            self.emit(AgentEvent::ToolCompleted {
                tool_call_id: tool_call_id.to_owned(),
                ok,
                summary: summary.map(str::to_owned),
            });
        }
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
        lock(&self.state)
            .open_tools
            .insert(tool_call_id.clone(), OpenTool { started: false });
        self.emit(AgentEvent::ToolRequested {
            tool_call_id: tool_call_id.clone(),
            tool: tool.clone(),
            summary: summary.clone(),
        });
        match self.routing {
            DecisionRouting::ProviderPrompt => {
                self.start_tool(&tool_call_id, &tool, &summary);
                HookReply::NoDecision
            }
            DecisionRouting::Engine => self.ask_engine(action, &tool_call_id, &tool, &summary),
        }
    }

    fn ask_engine(
        &self,
        action: NormalizedAction,
        tool_call_id: &str,
        tool: &str,
        summary: &str,
    ) -> HookReply {
        let request_id = new_id();
        let receiver = {
            let mut pending = lock(&self.pending);
            if pending.len() >= self.limits.max_held {
                tracing::warn!(event = "pane.approvals_bounded", thread_id = %self.ctx.thread_id);
                return HookReply::Ask {
                    reason: "Several requests are already waiting in KalCode; answer this one in \
                             Claude Code."
                        .into(),
                };
            }
            let (tx, rx) = mpsc::sync_channel(1);
            pending.insert(request_id.clone(), tx);
            rx
        };
        let action_id = action.id.clone();
        self.emit(AgentEvent::ApprovalRequired {
            request_id: request_id.clone(),
            action,
        });
        match receiver.recv_timeout(self.limits.ask_window) {
            Ok(ApprovalDecision::Deny) => {
                self.close_tool(tool_call_id, false, Some("Denied by KalCode"));
                HookReply::Deny {
                    reason: "KalCode denied this action (its policy, or your answer).".into(),
                }
            }
            Ok(_) => {
                self.start_tool(tool_call_id, tool, summary);
                HookReply::Allow {
                    reason: "Allowed by KalCode.".into(),
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                lock(&self.pending).remove(&request_id);
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
                if let Some(id) = &record.provider_session_id {
                    *lock(&self.provider_session_id) = Some(id.clone());
                    events.push(AgentEvent::SessionStarted {
                        provider_session_id: id.clone(),
                        model: None,
                    });
                }
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
                let first = {
                    let mut state = lock(&self.state);
                    !std::mem::replace(&mut state.first_prompt_seen, true)
                };
                if first && let (Some(titles), Some(prompt)) = (&self.titles, &record.prompt) {
                    titles.first_prompt(&self.ctx.thread_id, prompt);
                }
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
                if let Some(id) = record
                    .provider_session_id
                    .as_ref()
                    .filter(|id| kalcode_contracts::ids::is_valid_id(id))
                {
                    let mut known = lock(&self.provider_session_id);
                    if known.as_deref() != Some(id.as_str()) {
                        *known = Some(id.clone());
                        events.push(AgentEvent::SessionStarted {
                            provider_session_id: id.clone(),
                            model: None,
                        });
                    }
                }
                if record.codex_type.as_deref() == Some("agent-turn-complete") {
                    self.prompt_showing.store(false, Ordering::SeqCst);
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

    pub(crate) fn handle(&self, record: HookRecord) -> HookReply {
        let blocking = record.event.is_some_and(HookEvent::is_blocking);
        if self.ended.load(Ordering::SeqCst) || self.stopping.load(Ordering::SeqCst) {
            return if blocking {
                HookReply::Deny {
                    reason: "The KalCode session is ending.".into(),
                }
            } else {
                HookReply::Ack
            };
        }
        let _ = self.channel.compare_exchange(
            CHANNEL_WAITING,
            CHANNEL_ACTIVE,
            Ordering::SeqCst,
            Ordering::SeqCst,
        );
        let _ = self.channel.compare_exchange(
            CHANNEL_LIMITED,
            CHANNEL_ACTIVE,
            Ordering::SeqCst,
            Ordering::SeqCst,
        );
        if blocking {
            return self.pre_tool_use(&record);
        }
        for event in self.status_events(&record) {
            self.emit(event);
        }
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
        self.shared.stopping.store(true, Ordering::SeqCst);
        lock(&self.shared.pending).clear();
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
        if let Some(waiter) = lock(&self.shared.pending).remove(request_id) {
            let _ = waiter.try_send(decision);
        }
        Ok(())
    }
}

impl Drop for InteractiveSession {
    fn drop(&mut self) {
        // The runtime dropped the session (stopped or replaced): the process must not outlive it.
        if !self.shared.ended.load(Ordering::SeqCst)
            && let Some(pty) = self.shared.pty()
        {
            let _ = pty.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
        s.handle(record(
            HookEvent::SessionStart,
            json!({"session_id": "sess-1", "source": "startup"}),
        ));
        assert_eq!(
            drain(&rx),
            [
                AgentEvent::SessionStarted {
                    provider_session_id: "sess-1".into(),
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
            json!({"session_id": "sess-1", "source": "compact"}),
        ));
        assert!(matches!(
            drain(&rx).as_slice(),
            [AgentEvent::SessionStarted { .. }]
        ));

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
