//! Provider adapter contract. Z2 implements [`AgentProvider`] per provider; Z3's thread runtime
//! drives sessions through it; Z4 judges the [`crate::permissions::NormalizedAction`]s that
//! sessions report. Provider-specific concepts are translated at the adapter boundary into these
//! shapes and never leak further.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::permissions::{ApprovalDecision, NormalizedAction, PermissionMode};
use crate::threads::ThreadStatus;

/// Stable provider identifier: `claude-code`, `codex`, `gemini-cli`, or a future provider id.
/// Serializes as a plain string (serde newtype).
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProviderId(pub String);

impl ProviderId {
    pub const CLAUDE_CODE: &'static str = "claude-code";
    pub const CODEX: &'static str = "codex";
    pub const GEMINI_CLI: &'static str = "gemini-cli";

    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for ProviderId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum DetectionState {
    Installed,
    NotInstalled,
    Outdated,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum AuthState {
    Authenticated,
    NotAuthenticated,
    /// The provider offers no side-effect-free, documented way to check.
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProviderDetection {
    pub provider_id: ProviderId,
    pub display_name: String,
    pub state: DetectionState,
    /// Executable location for display, with the home folder shown as `~`.
    pub display_path: Option<String>,
    pub version: Option<String>,
    pub minimum_version: Option<String>,
    pub auth: AuthState,
    /// User-safe explanation when `state` is `error` or `outdated`.
    pub message: Option<String>,
    pub checked_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ModelInfo {
    pub id: String,
    pub display_name: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum MappingFidelity {
    Exact,
    /// The provider cannot express the mode exactly; KalCode uses a stricter setting.
    ApproximateStricter,
    Unsupported,
}

/// How a provider realizes one KalCode permission mode. Adapters never map to broader authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PermissionMapping {
    pub mode: PermissionMode,
    pub fidelity: MappingFidelity,
    /// The provider-native setting used, e.g. `--permission-mode plan`.
    pub provider_setting: String,
    pub notes: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProviderCapabilities {
    pub streaming: bool,
    pub interrupt: bool,
    pub resume: bool,
    /// The provider routes permission prompts to the host (KalCode) for a decision.
    pub host_approvals: bool,
    pub models: Vec<ModelInfo>,
    pub permission_mappings: Vec<PermissionMapping>,
    /// How the provider runs in an interactive PTY pane (`docs/PROVIDER_PANES.md` §3–4).
    /// `None` until the adapter declares it. Adopted in CA-1.
    #[serde(default)]
    pub interactive: Option<InteractiveSupport>,
}

/// A structured channel an interactive provider reports status through. Model prose is never
/// parsed for state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum StatusChannel {
    /// The provider's hook system, configured by KalCode at launch.
    Hooks,
    /// A provider notify command.
    Notify,
    /// OSC 9 terminal notifications.
    Osc9,
    /// Process and PTY state only (spawned, exited, exit code).
    ProcessOnly,
}

/// How a provider runs in a pane: the real CLI in a PTY, launched with a KalCode-chosen
/// permission mapping that is never broader than the thread's mode.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct InteractiveSupport {
    /// The interactive launch mapping per KalCode mode; never broader than the mode.
    pub launch_mappings: Vec<PermissionMapping>,
    pub status_channels: Vec<StatusChannel>,
    /// `false`: approvals are answered in the provider's own prompt and KalCode mirrors
    /// PERMISSION REQUIRED.
    pub kalcode_answers_approvals: bool,
    /// Display form of the resume command, e.g. `<cli> --resume <id>`.
    pub resume: Option<String>,
}

/// Everything an adapter needs to start a session. Paths are native-resolved, never from the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SessionConfig {
    pub thread_id: String,
    pub workspace_id: String,
    /// Stable KalCode provider-account metadata id. Credentials remain provider-managed.
    #[serde(default)]
    pub provider_account_id: Option<String>,
    pub working_directory: String,
    pub model: Option<String>,
    pub permission_mode: PermissionMode,
    /// Provider session id to resume, when the provider supports resuming.
    pub resume_session_id: Option<String>,
    /// Opaque reference into the OS secure store for an API-key account; never the key itself.
    pub secret_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum AgentInput {
    Text { text: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Usage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cost_usd_micros: Option<u64>,
}

/// Normalized events every adapter emits. Drives thread state (Z3), approvals (Z4), and the
/// Dashboard (Z5). Streaming text arrives as deltas; lifecycle changes become persisted events.
// `ApprovalRequired` carries a whole `NormalizedAction` (larger since CA-1 added `origin` and the
// Trust Kernel action kinds). Events are moved one at a time through a channel, so boxing would
// only complicate every adapter without a measurable gain.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum AgentEvent {
    /// The provider assigned or confirmed its own session id (for resume).
    SessionStarted {
        provider_session_id: String,
        model: Option<String>,
    },
    Status {
        status: ThreadStatus,
        detail: Option<String>,
    },
    MessageDelta {
        message_id: String,
        text: String,
    },
    MessageCompleted {
        message_id: String,
        text: String,
    },
    ToolRequested {
        tool_call_id: String,
        tool: String,
        summary: String,
    },
    ToolStarted {
        tool_call_id: String,
    },
    ToolCompleted {
        tool_call_id: String,
        ok: bool,
        summary: Option<String>,
    },
    /// The provider is waiting for a decision on `action` (host-approval providers only).
    ApprovalRequired {
        request_id: String,
        action: NormalizedAction,
    },
    FileChanged {
        path: String,
        change: FileChange,
    },
    Usage {
        usage: Usage,
    },
    /// The current turn finished; the session remains available for more input.
    TurnCompleted {
        ok: bool,
    },
    Error {
        code: String,
        message: String,
        recoverable: bool,
    },
    /// The provider process ended.
    Exited {
        exit_code: Option<i32>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum FileChange {
    Created,
    Modified,
    Deleted,
}

#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
pub enum ProviderError {
    #[error("the provider is not installed")]
    NotInstalled,
    #[error("the provider is not signed in")]
    NotAuthenticated,
    #[error("the provider does not support this operation")]
    Unsupported,
    #[error("the session has ended")]
    SessionEnded,
    #[error("the provider failed to start: {0}")]
    Start(String),
    #[error("provider I/O failed: {0}")]
    Io(String),
    #[error("the provider sent output KalCode could not understand: {0}")]
    Protocol(String),
    /// KalCode's Resource Governor held this launch (or turn) before any provider process
    /// started. The thread runtime waits and re-checks; it is never a provider failure.
    #[error("the resource governor held this launch ({})", .0.kind.code())]
    ResourcesHeld(crate::resources::LaunchHold),
    /// KalCode refused the launch for a known reason before starting the provider (account in
    /// use, unsupported plan or version). `code` is stable and `message` is fixed, user-safe
    /// KalCode copy; neither ever contains provider output, paths or credentials.
    #[error("the launch was refused ({code}): {message}")]
    Refused { code: String, message: String },
}

/// Receives a session's events. Implementations must be cheap and non-blocking.
pub trait AgentEventSink: Send + Sync {
    fn emit(&self, event: AgentEvent);
}

impl<F: Fn(AgentEvent) + Send + Sync> AgentEventSink for F {
    fn emit(&self, event: AgentEvent) {
        self(event);
    }
}

/// One provider (Claude Code, Codex, Gemini CLI, …). Implemented by Z2 adapters.
pub trait AgentProvider: Send + Sync {
    fn id(&self) -> ProviderId;
    fn display_name(&self) -> &str;
    /// Read-only detection; never installs or changes anything.
    fn detect(&self) -> ProviderDetection;
    fn capabilities(&self) -> ProviderCapabilities;
    /// Starts a session. Events flow to `sink` from a background thread until `Exited`.
    fn start_session(
        &self,
        config: SessionConfig,
        sink: Box<dyn AgentEventSink>,
    ) -> Result<Box<dyn AgentSession>, ProviderError>;
}

/// A running provider session.
pub trait AgentSession: Send + Sync {
    /// The provider's own session id once known (for resume).
    fn provider_session_id(&self) -> Option<String>;
    fn send(&self, input: AgentInput) -> Result<(), ProviderError>;
    /// Stops the current turn, keeping the session.
    fn interrupt(&self) -> Result<(), ProviderError>;
    /// Ends the session and its process tree.
    fn terminate(&self) -> Result<(), ProviderError>;
    /// Answers an `ApprovalRequired` (host-approval providers only).
    fn respond_to_approval(
        &self,
        request_id: &str,
        decision: ApprovalDecision,
    ) -> Result<(), ProviderError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_id_is_a_plain_string_on_the_wire() {
        assert_eq!(
            serde_json::to_string(&ProviderId::new(ProviderId::CODEX)).expect("json"),
            "\"codex\""
        );
    }

    #[test]
    fn agent_events_are_tagged_by_kind() {
        let event = AgentEvent::Status {
            status: ThreadStatus::RunningTool,
            detail: Some("npm test".into()),
        };
        let json = serde_json::to_value(&event).expect("json");
        assert_eq!(json["kind"], "status");
        assert_eq!(json["status"], "running_tool");
    }

    #[test]
    fn closures_are_event_sinks() {
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink_seen = seen.clone();
        let sink: Box<dyn AgentEventSink> =
            Box::new(move |e: AgentEvent| sink_seen.lock().expect("lock").push(e));
        sink.emit(AgentEvent::TurnCompleted { ok: true });
        assert_eq!(seen.lock().expect("lock").len(), 1);
    }

    #[test]
    fn legacy_session_config_decodes_without_an_account_selection() {
        let config: SessionConfig = serde_json::from_value(serde_json::json!({
            "threadId": "thread",
            "workspaceId": "workspace",
            "workingDirectory": "C:/work",
            "model": null,
            "permissionMode": "approve",
            "resumeSessionId": null,
            "secretRef": null
        }))
        .expect("legacy config");
        assert_eq!(config.provider_account_id, None);
    }
}
