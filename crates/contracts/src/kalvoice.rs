//! KalVoice: the conversational coding assistant and voice layer inside KalCode (docs/KALVOICE.md).
//!
//! Two modes. **Dictation** turns speech into text in the focused input using local speech
//! recognition; it is unlimited on every plan and never counted. **Command** turns speech or
//! text into a KalCode action; each top-level request counts as one KalVoice Request against the
//! plan allowance, however many internal steps it takes.
//!
//! Zero-cost rule: KalVoice never uses company-funded AI. Deterministic commands run locally;
//! requests that need reasoning use the user's own connected provider, or ask them to connect one.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::agent::ProviderId;
use crate::app::SurfaceId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum KalVoiceMode {
    Dictation,
    Command,
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
