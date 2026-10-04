//! KalVoice: the conversational coding assistant and voice layer inside KalCode (docs/KALVOICE.md).
//!
//! One push-to-talk gesture (**Talk**, CA-1) routes each utterance: a clear command runs as a
//! KalCode action, words for a focused text box or terminal are dictated, and anything else is a
//! request for bounded on-device interpretation (`kalvoice.talk_routed`). Dictation is local,
//! unlimited on every plan and never counted; each top-level command that executes counts as one
//! KalVoice Request against the plan allowance, however many internal steps it takes.
//!
//! Zero-cost rule: KalVoice never uses company-funded AI. Deterministic commands run locally;
//! requests outside the grammar require the configured local runtime and never fall back to a
//! connected provider.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::agent::ProviderId;
use crate::app::SurfaceId;
use crate::permissions::PermissionMode;
use crate::sessions::SessionAttention;
use crate::workspace_ui::{DashboardChip, SplitAxis};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum KalVoiceMode {
    /// Deprecated since CA-1 (use `Talk`); still accepted so stored values decode.
    Dictation,
    /// Deprecated since CA-1 (use `Talk`); still accepted so stored values decode.
    Command,
    /// One push-to-talk gesture; KalVoice routes each utterance (see [`TalkRoute`]). Added in CA-1.
    Talk,
}

/// Which way a push-to-talk utterance went (`kalvoice.talk_routed`). Added in CA-1; the same
/// values as the KalVoice crate's route.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum TalkRoute {
    /// Ran as a KalCode command.
    Command,
    /// Typed into the focused text box or terminal (never counted).
    Dictation,
    /// Sent to the bounded on-device interpreter, or refused as unavailable/uncertain.
    Request,
}

/// A permission mode KalVoice may *ask* for. Bypass is deliberately absent: KalVoice can never
/// request it, and a requested change only takes effect when the person confirms it in KalCode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum RequestableMode {
    Plan,
    Approve,
    Auto,
    Custom,
}

impl RequestableMode {
    pub fn permission_mode(self) -> PermissionMode {
        match self {
            Self::Plan => PermissionMode::Plan,
            Self::Approve => PermissionMode::Approve,
            Self::Auto => PermissionMode::Auto,
            Self::Custom => PermissionMode::Custom,
        }
    }
}

/// A direction for resizing panes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum PaneDirection {
    Left,
    Right,
    Up,
    Down,
}

/// How a command request reached KalVoice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum KalVoiceInput {
    Voice,
    Text,
}

/// Legacy persisted intelligence selection. Current KalVoice reasoning is local-only; the provider
/// variant remains solely for wire/storage compatibility and never authorizes provider inference.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum KalVoiceIntelligence {
    /// Legacy provider preference; ignored by the local-only reasoning path.
    Provider { provider_id: ProviderId },
    /// A consented on-device model.
    Local,
}

/// Which threads a bulk command applies to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum ThreadScope {
    All,
    Workspace { workspace_id: String },
    Thread { thread_id: String },
}

/// One group of independent provider panes requested by the user. A missing provider uses
/// the user's selected/default provider; an account label must resolve uniquely, never guess.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProviderPaneRequest {
    pub provider_id: Option<ProviderId>,
    pub count: u8,
    pub account_query: Option<String>,
    pub model: Option<String>,
    /// Exact provider effort level. `None` preserves the provider/account default.
    pub effort: Option<String>,
    /// Optional per-agent task groups. Counts must add up to `count`; an empty list opens
    /// idle provider sessions that wait for the user's first prompt.
    #[serde(default)]
    pub assignments: Vec<AgentLaunchAssignment>,
}

/// A bounded task shared by one or more agents in a natural multi-agent launch request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AgentLaunchAssignment {
    pub count: u8,
    pub task: String,
}

/// App layout controls. These never issue provider input or stop a runtime process.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum PaneControl {
    Resize { query: String, grow: bool },
    Move { query: String, beside: String },
    Maximize { query: Option<String> },
    Restore { query: Option<String> },
    Collapse { query: Option<String> },
    Expand { query: Option<String> },
}

/// Deterministic controls for KalCode's embedded browser surface. These commands can navigate a
/// browser but cannot evaluate script, inspect the DOM, or grant a remote page application IPC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum BrowserControl {
    /// Open or focus a browser pane. `new_pane` requests a distinct browser identity.
    Open {
        url: Option<String>,
        new_pane: bool,
    },
    /// Navigate the explicitly selected browser, or the focused/sole browser when omitted.
    Navigate {
        url: String,
        browser_id: Option<String>,
    },
    Back {
        browser_id: Option<String>,
    },
    Forward {
        browser_id: Option<String>,
    },
    Reload {
        browser_id: Option<String>,
    },
    Stop {
        browser_id: Option<String>,
    },
}

/// A structured command. Everything except `Reasoning` executes deterministically without any
/// model; `Reasoning` requires the bounded on-device interpreter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum KalVoiceIntent {
    Navigate {
        surface: SurfaceId,
    },
    OpenWorkspace {
        query: String,
    },
    CreateTerminal {
        workspace_id: Option<String>,
    },
    CreateThreads {
        provider_id: ProviderId,
        count: u8,
        workspace_id: Option<String>,
        /// Owner-visible account label or suffix ("work", "Gemini B"), resolved to one of the
        /// provider's accounts by label. `None` keeps the workspace default / provider default.
        /// Missing on the wire decodes as `None` (pre-0.1.5 payloads).
        account_query: Option<String>,
        /// Exact provider model id or documented alias. Missing keeps the account/provider
        /// default and preserves compatibility with older KalVoice payloads.
        model: Option<String>,
        /// Exact provider effort level. Missing keeps the provider/account default.
        effort: Option<String>,
        /// Optional counted tasks. Missing on older payloads keeps the idle-session behavior.
        #[serde(default)]
        assignments: Vec<AgentLaunchAssignment>,
    },
    CreateProviderPanes {
        groups: Vec<ProviderPaneRequest>,
        workspace_id: Option<String>,
    },
    /// Applies an exact model and effort to the immediately preceding launch group. The
    /// orchestrator supplies generation-bound thread instances from transient follow-up memory;
    /// the executor refuses stale, active, used, or mixed-provider groups before changing any.
    ConfigureRecentLaunch {
        provider_id: ProviderId,
        model: String,
        effort: String,
    },
    ControlPane {
        command: PaneControl,
        workspace_id: Option<String>,
    },
    ControlBrowser {
        command: BrowserControl,
        workspace_id: Option<String>,
    },
    OpenThread {
        query: String,
    },
    PauseThreads {
        scope: ThreadScope,
    },
    ResumeThreads {
        scope: ThreadScope,
    },
    StopThreads {
        scope: ThreadScope,
        /// When spoken (for example, "stop six active terminals"), execution proceeds only if
        /// exactly this many provider sessions are live in the resolved scope. Older payloads
        /// omit it and keep the existing all-in-scope behavior.
        #[serde(default)]
        expected_count: Option<u8>,
    },
    ShowApprovals,
    /// "What are my threads doing?" — answered from runtime state, no model needed.
    StatusReport,
    /// Read relevant saved knowledge in the active workspace. Never invents an answer.
    ReadMemory {
        query: String,
    },
    /// Anything that needs understanding beyond the command grammar (planning, delegation).
    Reasoning {
        request: String,
    },
    // ---- Added in CA-1 (owner's list; layout-only intents never end a process) ----
    /// Split the focused pane.
    Split {
        axis: SplitAxis,
    },
    /// Grow or shrink the focused pane.
    Resize {
        direction: PaneDirection,
        steps: u8,
    },
    /// Focus a pane or thread by name ("focus the Codex pane").
    Focus {
        query: String,
    },
    /// Search sessions, threads and files (the query is never stored).
    Search {
        query: String,
    },
    /// Close a pane (`None`: the focused one). Closing a pane never stops its process.
    Close {
        query: Option<String>,
    },
    /// Use another provider for the next thread or pane.
    SwitchProvider {
        provider_id: ProviderId,
    },
    /// Ask for a permission-mode change. Never Bypass (not representable); the person confirms
    /// the change in KalCode's own UI, and KalVoice never changes a mode itself.
    RequestPermissionMode {
        mode: RequestableMode,
        thread_query: Option<String>,
    },
    // ---- Added in Z7-W3 ----
    /// Filter the Dashboard by chip ("show only agents that are working"). UI-only: it never
    /// changes a thread.
    FilterDashboard {
        chip: DashboardChip,
    },
    // ---- Added in 0.1.5 (switch accounts) ----
    /// "Switch this Gemini thread to Gemini B." Never rebinds by itself: the executor resolves
    /// the thread and account, then asks the person to confirm in KalCode's Rebind dialog.
    /// `thread_query: None` means the focused thread (`CommandRequest.thread_id`).
    RebindThreadAccount {
        thread_query: Option<String>,
        provider_id: Option<ProviderId>,
        account_query: String,
    },
    /// "Use Gemini A in this workspace." Writes the workspace default binding (metadata only;
    /// launching still requires that account to be signed in). `workspace_id: None` means the
    /// active workspace.
    SetWorkspaceAccount {
        provider_id: ProviderId,
        account_query: String,
        workspace_id: Option<String>,
    },
    // ---- Added in 0.1.5 (terminal-aware KalVoice). Deterministic grammar only: the local
    // interpreter may never produce the three prompt-carrying intents. ----
    /// "Send that / send it / submit that": presses the focused thread composer's own Send, so
    /// prompt review and warnings still run. Refused for a raw terminal (KalVoice never presses
    /// Enter in a shell). Not counted against the KalVoice allowance.
    SubmitFocused,
    /// "Don't send that / clear that / scratch that": removes the text KalVoice just dictated
    /// into the focused composer (only while unchanged). Not counted against the allowance.
    ClearFocused,
    /// "Tell <target> [to] <prompt>" / "ask <target> <prompt>": resolves `target` with the
    /// session resolver (clarifying when it is ambiguous) and submits `prompt` verbatim through
    /// that thread's composer. Explicit references to saved project rules add retrieved memory.
    /// `prompt` is transient: never stored, logged or spoken.
    DirectPrompt {
        target: String,
        prompt: String,
    },
    /// "Focus the one waiting for permission / that failed / that's stuck".
    FocusByState {
        state: SessionAttention,
    },
    /// "Go back to the terminal / thread I was just using."
    FocusPrevious,
    /// "Which agent failed? / which one is stuck?": reads back up to three names with status.
    WhichSessions {
        state: SessionAttention,
    },
}

impl KalVoiceIntent {
    /// Stable name for events and analytics (never includes user text).
    pub fn kind_name(&self) -> &'static str {
        match self {
            Self::Navigate { .. } => "navigate",
            Self::OpenWorkspace { .. } => "open_workspace",
            Self::CreateTerminal { .. } => "create_terminal",
            Self::CreateThreads { .. } => "create_threads",
            Self::CreateProviderPanes { .. } => "create_provider_panes",
            Self::ConfigureRecentLaunch { .. } => "configure_recent_launch",
            Self::ControlPane { .. } => "control_pane",
            Self::ControlBrowser { .. } => "control_browser",
            Self::OpenThread { .. } => "open_thread",
            Self::PauseThreads { .. } => "pause_threads",
            Self::ResumeThreads { .. } => "resume_threads",
            Self::StopThreads { .. } => "stop_threads",
            Self::ShowApprovals => "show_approvals",
            Self::StatusReport => "status_report",
            Self::ReadMemory { .. } => "read_memory",
            Self::Reasoning { .. } => "reasoning",
            Self::Split { .. } => "split",
            Self::Resize { .. } => "resize",
            Self::Focus { .. } => "focus",
            Self::Search { .. } => "search",
            Self::Close { .. } => "close",
            Self::SwitchProvider { .. } => "switch_provider",
            Self::RequestPermissionMode { .. } => "request_permission_mode",
            Self::FilterDashboard { .. } => "filter_dashboard",
            Self::RebindThreadAccount { .. } => "rebind_thread_account",
            Self::SetWorkspaceAccount { .. } => "set_workspace_account",
            Self::SubmitFocused => "submit_focused",
            Self::ClearFocused => "clear_focused",
            Self::DirectPrompt { .. } => "direct_prompt",
            Self::FocusByState { .. } => "focus_by_state",
            Self::FocusPrevious => "focus_previous",
            Self::WhichSessions { .. } => "which_sessions",
        }
    }

    /// True when the intent needs the configured on-device reasoning model.
    pub fn needs_reasoning(&self) -> bool {
        matches!(self, Self::Reasoning { .. })
    }

    /// Whether this local intent needs a durable execution fence. Composer Send/clear
    /// directives are handled by the UI. A claim never consumes KalVoice cloud quota.
    pub fn requires_execution_claim(&self) -> bool {
        !matches!(self, Self::SubmitFocused | Self::ClearFocused)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum KalVoiceOutcome {
    Completed {
        summary: String,
    },
    /// The action needs the user's approval first (permission engine).
    PermissionRequired {
        approval_request_id: String,
    },
    /// Legacy outcome retained for wire compatibility; the local-only orchestrator reports a
    /// typed local-reasoning failure instead.
    NeedsProvider {
        message: String,
    },
    /// The monthly KalVoice Request allowance is used up.
    LimitReached {
        resets_at: String,
    },
    Failed {
        code: String,
        message: String,
    },
}

/// Monthly KalVoice Request usage. The server ledger is authoritative.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KalVoiceUsage {
    pub used: u32,
    /// `None` means unlimited (OWNER).
    pub allowance: Option<u32>,
    pub period_start: String,
    pub resets_at: String,
}

impl KalVoiceUsage {
    pub fn remaining(&self) -> Option<u32> {
        self.allowance.map(|a| a.saturating_sub(self.used))
    }

    pub fn exhausted(&self) -> bool {
        self.allowance.is_some_and(|a| self.used >= a)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_reasoning_needs_a_model() {
        assert!(!KalVoiceIntent::StatusReport.needs_reasoning());
        assert!(
            !KalVoiceIntent::CreateThreads {
                provider_id: ProviderId::new(ProviderId::CODEX),
                count: 4,
                workspace_id: None,
                account_query: None,
                model: None,
                effort: None,
                assignments: Vec::new(),
            }
            .needs_reasoning()
        );
        assert!(
            KalVoiceIntent::Reasoning {
                request: "plan it".into()
            }
            .needs_reasoning()
        );
    }

    #[test]
    fn usage_math() {
        let usage = KalVoiceUsage {
            used: 412,
            allowance: Some(150),
            period_start: String::new(),
            resets_at: String::new(),
        };
        assert_eq!(usage.remaining(), Some(1088));
        assert!(!usage.exhausted());
        let owner = KalVoiceUsage {
            used: 99_999,
            allowance: None,
            ..usage.clone()
        };
        assert_eq!(owner.remaining(), None);
        assert!(!owner.exhausted());
        let full = KalVoiceUsage {
            used: 25,
            allowance: Some(25),
            ..usage
        };
        assert!(full.exhausted());
    }

    fn ca1_intents() -> Vec<KalVoiceIntent> {
        vec![
            KalVoiceIntent::Split {
                axis: SplitAxis::Vertical,
            },
            KalVoiceIntent::Resize {
                direction: PaneDirection::Left,
                steps: 2,
            },
            KalVoiceIntent::Focus {
                query: "codex".into(),
            },
            KalVoiceIntent::Search {
                query: "oauth".into(),
            },
            KalVoiceIntent::Close { query: None },
            KalVoiceIntent::SwitchProvider {
                provider_id: ProviderId::new(ProviderId::GEMINI_CLI),
            },
            KalVoiceIntent::RequestPermissionMode {
                mode: RequestableMode::Auto,
                thread_query: Some("login".into()),
            },
            KalVoiceIntent::FilterDashboard {
                chip: DashboardChip::WaitingForYou,
            },
            KalVoiceIntent::RebindThreadAccount {
                thread_query: None,
                provider_id: Some(ProviderId::new(ProviderId::GEMINI_CLI)),
                account_query: "Gemini B".into(),
            },
            KalVoiceIntent::SetWorkspaceAccount {
                provider_id: ProviderId::new(ProviderId::GEMINI_CLI),
                account_query: "Gemini A".into(),
                workspace_id: None,
            },
            KalVoiceIntent::CreateThreads {
                provider_id: ProviderId::new(ProviderId::CODEX),
                count: 1,
                workspace_id: None,
                account_query: Some("work".into()),
                model: None,
                effort: None,
                assignments: Vec::new(),
            },
            KalVoiceIntent::SubmitFocused,
            KalVoiceIntent::ClearFocused,
            KalVoiceIntent::DirectPrompt {
                target: "Release Mac".into(),
                prompt: "Bump the version, don't touch CI.".into(),
            },
            KalVoiceIntent::FocusByState {
                state: SessionAttention::WaitingForPermission,
            },
            KalVoiceIntent::FocusPrevious,
            KalVoiceIntent::WhichSessions {
                state: SessionAttention::Failed,
            },
        ]
    }

    #[test]
    fn browser_controls_round_trip_without_widening_authority() {
        let controls = [
            BrowserControl::Open {
                url: Some("http://localhost:3000/".into()),
                new_pane: true,
            },
            BrowserControl::Navigate {
                url: "https://example.com/docs".into(),
                browser_id: Some("0192f3c4-0000-7000-8000-00000000000c".into()),
            },
            BrowserControl::Back { browser_id: None },
            BrowserControl::Forward { browser_id: None },
            BrowserControl::Reload { browser_id: None },
            BrowserControl::Stop { browser_id: None },
        ];
        for command in controls {
            let intent = KalVoiceIntent::ControlBrowser {
                command,
                workspace_id: None,
            };
            let json = serde_json::to_value(&intent).expect("json");
            assert_eq!(json["kind"], "control_browser");
            assert!(json.get("script").is_none());
            assert_eq!(
                serde_json::from_value::<KalVoiceIntent>(json).expect("back"),
                intent
            );
        }
    }

    #[test]
    fn ca1_intents_are_deterministic_and_named_by_their_tag() {
        for intent in ca1_intents() {
            assert!(!intent.needs_reasoning(), "{intent:?}");
            let json = serde_json::to_value(&intent).expect("json");
            assert_eq!(json["kind"], intent.kind_name());
            let back: KalVoiceIntent = serde_json::from_value(json).expect("back");
            assert_eq!(back, intent);
        }
    }

    #[test]
    fn a_permission_mode_request_can_never_be_bypass() {
        let bypass = serde_json::from_value::<KalVoiceIntent>(serde_json::json!({
            "kind": "request_permission_mode", "mode": "bypass", "threadQuery": null
        }));
        assert!(bypass.is_err(), "bypass must not be representable");
        for mode in [
            RequestableMode::Plan,
            RequestableMode::Approve,
            RequestableMode::Auto,
            RequestableMode::Custom,
        ] {
            assert_ne!(mode.permission_mode(), PermissionMode::Bypass);
            assert_eq!(
                serde_json::to_value(mode).expect("json"),
                serde_json::to_value(mode.permission_mode()).expect("json")
            );
        }
    }

    #[test]
    fn talk_is_the_mode_and_old_modes_still_decode() {
        assert_eq!(
            serde_json::to_value(KalVoiceMode::Talk).expect("json"),
            "talk"
        );
        for old in ["dictation", "command"] {
            assert!(serde_json::from_value::<KalVoiceMode>(serde_json::json!(old)).is_ok());
        }
        assert_eq!(
            serde_json::to_value(TalkRoute::Dictation).expect("json"),
            "dictation"
        );
    }

    #[test]
    fn switch_account_intents_use_stable_names_and_old_create_threads_still_decode() {
        let rebind = serde_json::to_value(KalVoiceIntent::RebindThreadAccount {
            thread_query: None,
            provider_id: None,
            account_query: "Gemini B".into(),
        })
        .expect("json");
        assert_eq!(rebind["kind"], "rebind_thread_account");
        assert_eq!(rebind["accountQuery"], "Gemini B");
        let workspace = serde_json::to_value(KalVoiceIntent::SetWorkspaceAccount {
            provider_id: ProviderId::new(ProviderId::GEMINI_CLI),
            account_query: "Gemini A".into(),
            workspace_id: Some("ws".into()),
        })
        .expect("json");
        assert_eq!(workspace["kind"], "set_workspace_account");
        assert_eq!(workspace["workspaceId"], "ws");
        let old: KalVoiceIntent = serde_json::from_value(serde_json::json!({
            "kind": "create_threads", "providerId": "codex", "count": 2, "workspaceId": null
        }))
        .expect("pre-0.1.5 create_threads decodes");
        assert!(matches!(
            old,
            KalVoiceIntent::CreateThreads {
                account_query: None,
                model: None,
                ..
            }
        ));

        let modeled = serde_json::to_value(KalVoiceIntent::CreateThreads {
            provider_id: ProviderId::new(ProviderId::CLAUDE_CODE),
            count: 6,
            workspace_id: None,
            account_query: Some("Claude A".into()),
            model: Some("opus".into()),
            effort: Some("high".into()),
            assignments: Vec::new(),
        })
        .expect("modeled launch");
        assert_eq!(modeled["model"], "opus");
        assert_eq!(modeled["effort"], "high");
    }

    #[test]
    fn terminal_kalvoice_intents_use_stable_names_and_keep_the_prompt_verbatim() {
        let direct = serde_json::to_value(KalVoiceIntent::DirectPrompt {
            target: "Authentication".into(),
            prompt: "Review the latest login failure, and don't send secrets.".into(),
        })
        .expect("json");
        assert_eq!(direct["kind"], "direct_prompt");
        assert_eq!(direct["target"], "Authentication");
        assert_eq!(
            direct["prompt"],
            "Review the latest login failure, and don't send secrets."
        );
        assert_eq!(
            serde_json::to_value(KalVoiceIntent::SubmitFocused).expect("json"),
            serde_json::json!({ "kind": "submit_focused" })
        );
        assert_eq!(
            serde_json::to_value(KalVoiceIntent::FocusPrevious).expect("json"),
            serde_json::json!({ "kind": "focus_previous" })
        );
        let by_state = serde_json::to_value(KalVoiceIntent::FocusByState {
            state: SessionAttention::Stuck,
        })
        .expect("json");
        assert_eq!(by_state["state"], "stuck");
        let which: KalVoiceIntent = serde_json::from_value(serde_json::json!({
            "kind": "which_sessions", "state": "waiting_for_permission"
        }))
        .expect("decodes");
        assert_eq!(
            which,
            KalVoiceIntent::WhichSessions {
                state: SessionAttention::WaitingForPermission
            }
        );
    }

    #[test]
    fn only_send_that_and_clear_that_are_free_of_the_allowance() {
        assert!(!KalVoiceIntent::SubmitFocused.requires_execution_claim());
        assert!(!KalVoiceIntent::ClearFocused.requires_execution_claim());
        for intent in ca1_intents() {
            let free = matches!(
                intent,
                KalVoiceIntent::SubmitFocused | KalVoiceIntent::ClearFocused
            );
            assert_eq!(intent.requires_execution_claim(), !free, "{intent:?}");
        }
        assert!(KalVoiceIntent::StatusReport.requires_execution_claim());
    }

    #[test]
    fn intents_are_tagged() {
        let json = serde_json::to_value(KalVoiceIntent::PauseThreads {
            scope: ThreadScope::All,
        })
        .expect("json");
        assert_eq!(json["kind"], "pause_threads");
        assert_eq!(json["scope"]["kind"], "all");

        let legacy: KalVoiceIntent = serde_json::from_value(serde_json::json!({
            "kind": "stop_threads",
            "scope": { "kind": "all" }
        }))
        .expect("legacy stop intent");
        assert_eq!(
            legacy,
            KalVoiceIntent::StopThreads {
                scope: ThreadScope::All,
                expected_count: None,
            }
        );
        let counted = serde_json::to_value(KalVoiceIntent::StopThreads {
            scope: ThreadScope::All,
            expected_count: Some(6),
        })
        .expect("counted stop intent");
        assert_eq!(counted["expectedCount"], 6);
    }
}
