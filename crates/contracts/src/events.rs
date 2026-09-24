//! KalCode Event Protocol v1 — envelope and catalog (docs/EVENT_PROTOCOL.md).
//! Storage and delivery live in native-core; the types live here.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::agent::ProviderId;
use crate::app::BuildChannel;
use crate::permissions::{ApprovalDecision, PermissionMode, PermissionScope};
use crate::threads::ThreadStatus;

/// Where an event originated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum EventSource {
    Core,
    Ui,
    Provider,
    Jarvis,
    Supervisor,
    Automation,
}

impl EventSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Core => "core",
            Self::Ui => "ui",
            Self::Provider => "provider",
            Self::Jarvis => "jarvis",
            Self::Supervisor => "supervisor",
            Self::Automation => "automation",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "ui" => Self::Ui,
            "provider" => Self::Provider,
            "jarvis" => Self::Jarvis,
            "supervisor" => Self::Supervisor,
            "automation" => Self::Automation,
            _ => Self::Core,
        }
    }
}

/// Optional identifiers that relate an event to KalCode entities. Indexed in storage.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Correlation {
    pub workspace_id: Option<String>,
    pub thread_id: Option<String>,
    pub mission_id: Option<String>,
    pub provider_id: Option<String>,
    pub request_id: Option<String>,
}

/// Typed event payloads. The serde tag is the wire `type`; the content is `payload`.
/// Payloads never contain secrets, file contents, prompts or message text — only ids and
/// short structured facts. Message text lives in thread storage.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", content = "payload", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum EventPayload {
    // ---- App (Z0) ----
    #[serde(rename = "app.started")]
    AppStarted {
        version: String,
        channel: BuildChannel,
        platform: String,
        arch: String,
    },
    #[serde(rename = "app.stopped")]
    AppStopped { uptime_ms: u64 },
    /// The previous session ended without `app.stopped` (crash, force quit, power loss).
    #[serde(rename = "app.previous_session_interrupted")]
    PreviousSessionInterrupted { last_event_at: String },
    #[serde(rename = "database.migrated")]
    DatabaseMigrated {
        from_version: i64,
        to_version: i64,
        backup_created: bool,
    },
    #[serde(rename = "settings.changed")]
    SettingsChanged { keys: Vec<String> },
    #[serde(rename = "secure_store.checked")]
    SecureStoreChecked { ok: bool, backend: String },

    // ---- Workspaces and terminals (Z1) ----
    #[serde(rename = "workspace.created")]
    WorkspaceCreated { workspace_id: String, name: String },
    #[serde(rename = "workspace.opened")]
    WorkspaceOpened { workspace_id: String, name: String },
    #[serde(rename = "workspace.removed")]
    WorkspaceRemoved { workspace_id: String, name: String },
    #[serde(rename = "shell.started")]
    ShellStarted {
        terminal_id: String,
        shell_id: String,
        shell_name: String,
    },
    #[serde(rename = "shell.completed")]
    ShellCompleted {
        terminal_id: String,
        exit_code: i64,
        closed_by_user: bool,
    },
    #[serde(rename = "shell.failed")]
    ShellFailed { terminal_id: String, exit_code: i64 },

    // ---- Providers (Z2) ----
    #[serde(rename = "provider.detected")]
    ProviderDetected {
        provider_id: ProviderId,
        installed: bool,
        version: Option<String>,
    },
    #[serde(rename = "provider.connected")]
    ProviderConnected {
        provider_id: ProviderId,
        account_label: Option<String>,
    },
    #[serde(rename = "provider.disconnected")]
    ProviderDisconnected {
        provider_id: ProviderId,
        account_label: Option<String>,
    },
    #[serde(rename = "provider.error")]
    ProviderError {
        provider_id: ProviderId,
        code: String,
        message: String,
    },

    // ---- Threads (Z3) ----
    #[serde(rename = "thread.created")]
    ThreadCreated {
        thread_id: String,
        name: String,
        provider_id: ProviderId,
        workspace_id: String,
    },
    #[serde(rename = "thread.started")]
    ThreadStarted { thread_id: String },
    #[serde(rename = "thread.status_changed")]
    ThreadStatusChanged {
        thread_id: String,
        from: ThreadStatus,
        to: ThreadStatus,
        detail: Option<String>,
    },
    #[serde(rename = "thread.renamed")]
    ThreadRenamed { thread_id: String, name: String },
    #[serde(rename = "thread.completed")]
    ThreadCompleted { thread_id: String },
    #[serde(rename = "thread.failed")]
    ThreadFailed {
        thread_id: String,
        code: String,
        message: String,
    },
    #[serde(rename = "thread.archived")]
    ThreadArchived { thread_id: String },
    /// A message was added to a thread. Content is stored with the thread, not in the event.
    #[serde(rename = "agent.message")]
    AgentMessage {
        thread_id: String,
        message_id: String,
        role: crate::threads::MessageRole,
    },
    #[serde(rename = "tool.requested")]
    ToolRequested {
        thread_id: String,
        tool_call_id: String,
        tool: String,
        summary: String,
    },
    #[serde(rename = "tool.started")]
    ToolStarted {
        thread_id: String,
        tool_call_id: String,
    },
    #[serde(rename = "tool.completed")]
    ToolCompleted {
        thread_id: String,
        tool_call_id: String,
    },
    #[serde(rename = "tool.failed")]
    ToolFailed {
        thread_id: String,
        tool_call_id: String,
        summary: Option<String>,
    },
    #[serde(rename = "file.created")]
    FileCreated {
        thread_id: Option<String>,
        path: String,
    },
    #[serde(rename = "file.modified")]
    FileModified {
        thread_id: Option<String>,
        path: String,
    },
    #[serde(rename = "file.deleted")]
    FileDeleted {
        thread_id: Option<String>,
        path: String,
    },

    // ---- Permissions (Z4) ----
    #[serde(rename = "approval.requested")]
    ApprovalRequested {
        request_id: String,
        thread_id: String,
        scopes: Vec<PermissionScope>,
        summary: String,
    },
    #[serde(rename = "approval.approved")]
    ApprovalApproved {
        request_id: String,
        thread_id: String,
        decision: ApprovalDecision,
    },
    #[serde(rename = "approval.denied")]
    ApprovalDenied {
        request_id: String,
        thread_id: String,
    },
    #[serde(rename = "approval.expired")]
    ApprovalExpired {
        request_id: String,
        thread_id: String,
    },
    #[serde(rename = "permission.mode_changed")]
    PermissionModeChanged {
        thread_id: Option<String>,
        from: PermissionMode,
        to: PermissionMode,
    },

    /// A stored event this build does not understand (written by a newer build or a removed
    /// type). Kept so history stays complete.
    #[serde(rename = "unrecognized")]
    Unrecognized {
        original_type: String,
        original_version: u32,
    },
}

impl EventPayload {
    /// Wire type name.
    pub fn type_name(&self) -> &'static str {
        match self {
            Self::AppStarted { .. } => "app.started",
            Self::AppStopped { .. } => "app.stopped",
            Self::PreviousSessionInterrupted { .. } => "app.previous_session_interrupted",
            Self::DatabaseMigrated { .. } => "database.migrated",
            Self::SettingsChanged { .. } => "settings.changed",
            Self::SecureStoreChecked { .. } => "secure_store.checked",
            Self::WorkspaceCreated { .. } => "workspace.created",
            Self::WorkspaceOpened { .. } => "workspace.opened",
            Self::WorkspaceRemoved { .. } => "workspace.removed",
            Self::ShellStarted { .. } => "shell.started",
            Self::ShellCompleted { .. } => "shell.completed",
            Self::ShellFailed { .. } => "shell.failed",
            Self::ProviderDetected { .. } => "provider.detected",
            Self::ProviderConnected { .. } => "provider.connected",
            Self::ProviderDisconnected { .. } => "provider.disconnected",
            Self::ProviderError { .. } => "provider.error",
            Self::ThreadCreated { .. } => "thread.created",
            Self::ThreadStarted { .. } => "thread.started",
            Self::ThreadStatusChanged { .. } => "thread.status_changed",
            Self::ThreadRenamed { .. } => "thread.renamed",
            Self::ThreadCompleted { .. } => "thread.completed",
            Self::ThreadFailed { .. } => "thread.failed",
            Self::ThreadArchived { .. } => "thread.archived",
            Self::AgentMessage { .. } => "agent.message",
            Self::ToolRequested { .. } => "tool.requested",
            Self::ToolStarted { .. } => "tool.started",
            Self::ToolCompleted { .. } => "tool.completed",
            Self::ToolFailed { .. } => "tool.failed",
            Self::FileCreated { .. } => "file.created",
            Self::FileModified { .. } => "file.modified",
            Self::FileDeleted { .. } => "file.deleted",
            Self::ApprovalRequested { .. } => "approval.requested",
            Self::ApprovalApproved { .. } => "approval.approved",
            Self::ApprovalDenied { .. } => "approval.denied",
            Self::ApprovalExpired { .. } => "approval.expired",
            Self::PermissionModeChanged { .. } => "permission.mode_changed",
            Self::Unrecognized { .. } => "unrecognized",
        }
    }

    /// Payload schema version for this type.
    pub fn version(&self) -> u32 {
        match self {
            Self::Unrecognized {
                original_version, ..
            } => *original_version,
            _ => 1,
        }
    }
}

/// A persisted event as delivered to consumers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EventEnvelope {
    pub id: String,
    pub seq: i64,
    pub version: u32,
    pub occurred_at: String,
    pub source: EventSource,
    pub correlation: Correlation,
    #[serde(flatten)]
    pub event: EventPayload,
}

/// An event before it is persisted (no `seq` yet).
#[derive(Debug, Clone)]
pub struct NewEvent {
    pub source: EventSource,
    pub correlation: Correlation,
    pub event: EventPayload,
}

impl NewEvent {
    pub fn core(event: EventPayload) -> Self {
        Self {
            source: EventSource::Core,
            correlation: Correlation::default(),
            event,
        }
    }

    pub fn with_correlation(mut self, correlation: Correlation) -> Self {
        self.correlation = correlation;
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permissions::ApprovalDecision;
    use crate::threads::MessageRole;

    /// One sample of every variant. Adding a variant without a sample fails `every_variant_…`.
    fn samples() -> Vec<EventPayload> {
        let p = || ProviderId::new(ProviderId::CLAUDE_CODE);
        let s = || String::from("x");
        vec![
            EventPayload::AppStarted {
                version: s(),
                channel: BuildChannel::Stable,
                platform: s(),
                arch: s(),
            },
            EventPayload::AppStopped { uptime_ms: 1 },
            EventPayload::PreviousSessionInterrupted { last_event_at: s() },
            EventPayload::DatabaseMigrated {
                from_version: 0,
                to_version: 1,
                backup_created: false,
            },
            EventPayload::SettingsChanged { keys: vec![] },
            EventPayload::SecureStoreChecked {
                ok: true,
                backend: s(),
            },
            EventPayload::WorkspaceCreated {
                workspace_id: s(),
                name: s(),
            },
            EventPayload::WorkspaceOpened {
                workspace_id: s(),
                name: s(),
            },
            EventPayload::WorkspaceRemoved {
                workspace_id: s(),
                name: s(),
            },
            EventPayload::ShellStarted {
                terminal_id: s(),
                shell_id: s(),
                shell_name: s(),
            },
            EventPayload::ShellCompleted {
                terminal_id: s(),
                exit_code: 0,
                closed_by_user: false,
            },
            EventPayload::ShellFailed {
                terminal_id: s(),
                exit_code: 1,
            },
            EventPayload::ProviderDetected {
                provider_id: p(),
                installed: true,
                version: None,
            },
            EventPayload::ProviderConnected {
                provider_id: p(),
                account_label: None,
            },
            EventPayload::ProviderDisconnected {
                provider_id: p(),
                account_label: None,
            },
            EventPayload::ProviderError {
                provider_id: p(),
                code: s(),
                message: s(),
            },
            EventPayload::ThreadCreated {
                thread_id: s(),
                name: s(),
                provider_id: p(),
                workspace_id: s(),
            },
            EventPayload::ThreadStarted { thread_id: s() },
            EventPayload::ThreadStatusChanged {
                thread_id: s(),
                from: ThreadStatus::Idle,
                to: ThreadStatus::Active,
                detail: None,
            },
            EventPayload::ThreadRenamed {
                thread_id: s(),
                name: s(),
            },
            EventPayload::ThreadCompleted { thread_id: s() },
            EventPayload::ThreadFailed {
                thread_id: s(),
                code: s(),
                message: s(),
            },
            EventPayload::ThreadArchived { thread_id: s() },
            EventPayload::AgentMessage {
                thread_id: s(),
                message_id: s(),
                role: MessageRole::Assistant,
            },
            EventPayload::ToolRequested {
                thread_id: s(),
                tool_call_id: s(),
                tool: s(),
                summary: s(),
            },
            EventPayload::ToolStarted {
                thread_id: s(),
                tool_call_id: s(),
            },
            EventPayload::ToolCompleted {
                thread_id: s(),
                tool_call_id: s(),
            },
            EventPayload::ToolFailed {
                thread_id: s(),
                tool_call_id: s(),
                summary: None,
            },
            EventPayload::FileCreated {
                thread_id: None,
                path: s(),
            },
            EventPayload::FileModified {
                thread_id: None,
                path: s(),
            },
            EventPayload::FileDeleted {
                thread_id: None,
                path: s(),
            },
            EventPayload::ApprovalRequested {
                request_id: s(),
                thread_id: s(),
                scopes: vec![PermissionScope::TerminalExecute],
                summary: s(),
            },
            EventPayload::ApprovalApproved {
                request_id: s(),
                thread_id: s(),
                decision: ApprovalDecision::ApproveOnce,
            },
            EventPayload::ApprovalDenied {
                request_id: s(),
                thread_id: s(),
            },
            EventPayload::ApprovalExpired {
                request_id: s(),
                thread_id: s(),
            },
            EventPayload::PermissionModeChanged {
                thread_id: None,
                from: PermissionMode::Approve,
                to: PermissionMode::Auto,
            },
            EventPayload::Unrecognized {
                original_type: s(),
                original_version: 1,
            },
        ]
    }

    #[test]
    fn every_variant_type_name_matches_its_wire_tag_and_round_trips() {
        let samples = samples();
        let mut names = std::collections::HashSet::new();
        for sample in &samples {
            let json = serde_json::to_value(sample).expect("serialize");
            assert_eq!(json["type"], sample.type_name());
            assert!(
                names.insert(sample.type_name()),
                "duplicate type {}",
                sample.type_name()
            );
            let back: EventPayload = serde_json::from_value(json).expect("deserialize");
            assert_eq!(&back, sample);
        }
        // Keep in step with the enum: the `type_name` match is exhaustive, so a new variant
        // compiles only once named there — and this count must be raised with a new sample.
        assert_eq!(samples.len(), 37);
    }

    #[test]
    fn payload_fields_are_camel_case() {
        let json = serde_json::to_value(EventPayload::ShellCompleted {
            terminal_id: "t".into(),
            exit_code: 0,
            closed_by_user: true,
        })
        .expect("serialize");
        assert_eq!(json["payload"]["closedByUser"], true);
        assert_eq!(json["payload"]["terminalId"], "t");
    }
}
