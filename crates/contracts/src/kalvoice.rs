//! KalVoice: the conversational coding assistant and voice layer inside KalCode (docs/KALVOICE.md).
//!
//! One push-to-talk gesture (**Talk**, CA-1) routes each utterance: a clear command runs as a
//! KalCode action, words for a focused text box or terminal are dictated, and anything else is a
//! request for the user's provider (`kalvoice.talk_routed`). Dictation is local, unlimited on
//! every plan and never counted; each top-level command or request counts as one KalVoice
//! Request against the plan allowance, however many internal steps it takes.
//!
//! Zero-cost rule: KalVoice never uses company-funded AI. Deterministic commands run locally;
//! requests that need reasoning use the user's own connected provider, or ask them to connect one.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::agent::ProviderId;
use crate::app::SurfaceId;
use crate::permissions::PermissionMode;
use crate::workspace_ui::SplitAxis;

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
    /// Sent to the user's provider for reasoning, or refused asking to connect one.
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

/// Which intelligence powers KalVoice reasoning. Always the user's own; never KalCode-funded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum KalVoiceIntelligence {
    /// A provider the user connected (their account, their usage).
    Provider { provider_id: ProviderId },
    /// A downloadable on-device model (future; never downloaded without consent).
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

/// A structured command. Everything except `Reasoning` executes deterministically without any
/// model; `Reasoning` needs a connected provider.
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
    },
    ShowApprovals,
    /// "What are my threads doing?" — answered from runtime state, no model needed.
    StatusReport,
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
}

impl KalVoiceIntent {
    /// Stable name for events and analytics (never includes user text).
    pub fn kind_name(&self) -> &'static str {
        match self {
            Self::Navigate { .. } => "navigate",
            Self::OpenWorkspace { .. } => "open_workspace",
            Self::CreateTerminal { .. } => "create_terminal",
            Self::CreateThreads { .. } => "create_threads",
            Self::OpenThread { .. } => "open_thread",
            Self::PauseThreads { .. } => "pause_threads",
            Self::ResumeThreads { .. } => "resume_threads",
            Self::StopThreads { .. } => "stop_threads",
            Self::ShowApprovals => "show_approvals",
            Self::StatusReport => "status_report",
            Self::Reasoning { .. } => "reasoning",
            Self::Split { .. } => "split",
            Self::Resize { .. } => "resize",
            Self::Focus { .. } => "focus",
            Self::Search { .. } => "search",
            Self::Close { .. } => "close",
            Self::SwitchProvider { .. } => "switch_provider",
            Self::RequestPermissionMode { .. } => "request_permission_mode",
        }
    }

    /// True when the intent needs a model (the user's connected provider).
    pub fn needs_reasoning(&self) -> bool {
        matches!(self, Self::Reasoning { .. })
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
    /// Reasoning was needed and no usable provider is connected.
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
                workspace_id: None
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
            allowance: Some(2500),
            period_start: String::new(),
            resets_at: String::new(),
        };
        assert_eq!(usage.remaining(), Some(2088));
        assert!(!usage.exhausted());
        let owner = KalVoiceUsage {
            used: 99_999,
            allowance: None,
            ..usage.clone()
        };
        assert_eq!(owner.remaining(), None);
        assert!(!owner.exhausted());
        let full = KalVoiceUsage {
            used: 250,
            allowance: Some(250),
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
        ]
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
    fn intents_are_tagged() {
        let json = serde_json::to_value(KalVoiceIntent::PauseThreads {
            scope: ThreadScope::All,
        })
        .expect("json");
        assert_eq!(json["kind"], "pause_threads");
        assert_eq!(json["scope"]["kind"], "all");
    }
}
