//! KalCode Event Protocol v1 — envelope and catalog (docs/EVENT_PROTOCOL.md).
//! Storage and delivery live in native-core; the types live here.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::agent::ProviderId;
use crate::app::BuildChannel;
use crate::context::ContextPurpose;
use crate::git::WorktreePurpose;
use crate::health::{CapacityState, HealthState};
use crate::kalvoice::{KalVoiceInput, KalVoiceIntelligence, TalkRoute};
use crate::notifications::{NotificationEntityKind, NotificationKind, Severity};
use crate::permissions::{ApprovalDecision, PermissionMode, PermissionScope};
use crate::resources::{
    GovernorMode, PressureLevel, ResourceHoldReason, ResourceKind, ResourceReleaseCause, Signal,
};
use crate::threads::ThreadStatus;

/// Where an event originated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum EventSource {
    Core,
    Ui,
    Provider,
    Supervisor,
    Automation,
    #[serde(rename = "kalvoice")]
    KalVoice,
}

impl EventSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Core => "core",
            Self::Ui => "ui",
            Self::Provider => "provider",
            Self::KalVoice => "kalvoice",
            Self::Supervisor => "supervisor",
            Self::Automation => "automation",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "ui" => Self::Ui,
            "provider" => Self::Provider,
            "kalvoice" => Self::KalVoice,
            "supervisor" => Self::Supervisor,
            "automation" => Self::Automation,
            _ => Self::Core,
        }
    }
}

/// Optional identifiers that relate an event to KalCode entities. Indexed in storage.
///
/// `agent_id`, `task_id`, `automation_id` and `causation_id` were added in CA-1 / L-1 (protocol
/// v1-compatible, EVENT_PROTOCOL.md §6; stored by schema v5). They default to `null` when absent.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Correlation {
    pub workspace_id: Option<String>,
    pub thread_id: Option<String>,
    pub mission_id: Option<String>,
    pub provider_id: Option<String>,
    pub request_id: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub automation_id: Option<String>,
    /// Id of the event that directly caused this one (Time Machine causality, automation loop
    /// detection). Set when a domain operation is a reaction to an event.
    #[serde(default)]
    pub causation_id: Option<String>,
}

/// Seq ordering for [`EventQuery`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SeqOrder {
    Asc,
    #[default]
    Desc,
}

/// Correlation filter for [`EventQuery`]: every given field must match.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct CorrelationFilter {
    pub workspace_id: Option<String>,
    pub thread_id: Option<String>,
    pub mission_id: Option<String>,
    pub provider_id: Option<String>,
    pub request_id: Option<String>,
    pub agent_id: Option<String>,
    pub task_id: Option<String>,
    pub automation_id: Option<String>,
    pub causation_id: Option<String>,
}

/// Maximum number of type filters in one [`EventQuery`].
pub const MAX_QUERY_TYPES: usize = 32;
/// Maximum page size of [`EventQuery`].
pub const MAX_QUERY_LIMIT: u32 = 500;

/// A filtered, paged read of the event log (`events_query`). Missing fields take their defaults.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct EventQuery {
    /// Exact types (`thread.created`) or `domain.*` prefixes (`thread.*`); at most 32;
    /// empty = every type.
    pub types: Vec<String>,
    pub correlation: CorrelationFilter,
    /// Only events with `seq > afterSeq`.
    pub after_seq: Option<i64>,
    /// Only events with `seq < beforeSeq`.
    pub before_seq: Option<i64>,
    /// Only events that occurred at or after this RFC 3339 UTC time.
    pub from: Option<String>,
    /// Only events that occurred before this RFC 3339 UTC time.
    pub to: Option<String>,
    pub order: SeqOrder,
    /// 1..=500.
    pub limit: u32,
}

impl Default for EventQuery {
    fn default() -> Self {
        Self {
            types: Vec::new(),
            correlation: CorrelationFilter::default(),
            after_seq: None,
            before_seq: None,
            from: None,
            to: None,
            order: SeqOrder::Desc,
            limit: 100,
        }
    }
}

/// One page of [`EventQuery`] results. `next_cursor` is the `seq` to pass as `beforeSeq`
/// (descending) or `afterSeq` (ascending) for the next page; `null` when this page is the last.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EventPage {
    pub events: Vec<EventEnvelope>,
    pub next_cursor: Option<i64>,
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
    /// PH: a provider's health changed state (transitions only, never samples).
    #[serde(rename = "provider.health_changed")]
    ProviderHealthChanged {
        provider_id: ProviderId,
        from: HealthState,
        to: HealthState,
        /// Stable reason code, e.g. `signed_out`, `recent_failures`, `rate_limited`.
        reason: String,
    },
    /// PH: capacity moved between available / saturated / backing_off (transitions only).
    #[serde(rename = "provider.capacity_changed")]
    ProviderCapacityChanged {
        provider_id: ProviderId,
        state: CapacityState,
        active_sessions: u32,
        limit: Option<u32>,
        /// Only when the provider reported when to retry.
        retry_at: Option<String>,
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
    /// The default mode for new threads changed (CA-1; `permission.mode_changed` with
    /// `threadId: null` is still emitted for compatibility until Z4 switches).
    #[serde(rename = "permission.default_mode_changed")]
    PermissionDefaultModeChanged {
        from: PermissionMode,
        to: PermissionMode,
    },

    // ---- Git and checkpoints (Z6a; declared in CA-1) ----
    /// HEAD moved to another branch (`to = "(detached)"` when detached).
    #[serde(rename = "git.branch_changed")]
    GitBranchChanged {
        workspace_id: String,
        from: Option<String>,
        to: String,
    },
    /// The set of changed files differs from the last report (debounced ≥ 1 s, transitions only).
    #[serde(rename = "git.diff_changed")]
    GitDiffChanged {
        workspace_id: String,
        worktree_id: Option<String>,
        files: u32,
    },
    /// A commit created by KalCode (branch from checkpoint) or observed.
    #[serde(rename = "git.commit_created")]
    GitCommitCreated {
        workspace_id: String,
        worktree_id: Option<String>,
        oid: String,
        by_kal_code: bool,
    },
    #[serde(rename = "git.worktree_created")]
    GitWorktreeCreated {
        workspace_id: String,
        worktree_id: String,
        branch: String,
        purpose: WorktreePurpose,
    },
    #[serde(rename = "git.worktree_removed")]
    GitWorktreeRemoved {
        workspace_id: String,
        worktree_id: String,
        branch: String,
        purpose: WorktreePurpose,
    },
    #[serde(rename = "timeline.checkpoint_created")]
    TimelineCheckpointCreated {
        checkpoint_id: String,
        workspace_id: String,
        /// The trigger's kind (`user`, `thread_turn`, …).
        trigger: String,
        files: u32,
        bytes_added: u64,
    },
    #[serde(rename = "timeline.checkpoint_pruned")]
    TimelineCheckpointPruned {
        checkpoint_id: String,
        reason: String,
    },

    // ---- Context and firewall (CTX/FW; declared in CA-1; never content) ----
    #[serde(rename = "context.package_created")]
    ContextPackageCreated {
        package_id: String,
        purpose: ContextPurpose,
        items: u32,
        bytes: u64,
    },
    #[serde(rename = "context.blocked")]
    ContextBlocked {
        package_id: String,
        /// The most frequent blocking rule code.
        rule: String,
        items: u32,
    },
    #[serde(rename = "context.redacted")]
    ContextRedacted {
        package_id: String,
        items: u32,
        spans: u32,
    },
    /// The user confirmed an overridable item (FW-03).
    #[serde(rename = "context.override_confirmed")]
    ContextOverrideConfirmed {
        package_id: String,
        position: u32,
        rule: String,
    },
    #[serde(rename = "context.shared")]
    ContextShared {
        package_id: String,
        thread_id: Option<String>,
        provider_id: ProviderId,
        items: u32,
        bytes: u64,
        redactions: u32,
    },
    #[serde(rename = "context.discarded")]
    ContextDiscarded { package_id: String },

    // ---- Resource Governor (RG; declared in CA-1; transitions only) ----
    #[serde(rename = "resource.pressure_changed")]
    ResourcePressureChanged {
        resource: ResourceKind,
        from: PressureLevel,
        to: PressureLevel,
        mode: GovernorMode,
        #[serde(default)]
        signal: Option<Signal>,
        #[serde(default)]
        value: Option<f64>,
        #[serde(default)]
        threshold: Option<f64>,
    },
    #[serde(rename = "resource.mode_changed")]
    ResourceModeChanged {
        from: GovernorMode,
        to: GovernorMode,
    },
    /// A task was held for resource reasons (emitted by the Scheduler, P4).
    #[serde(rename = "resource.task_held")]
    ResourceTaskHeld {
        task_id: String,
        reasons: Vec<ResourceHoldReason>,
        mode: GovernorMode,
    },
    #[serde(rename = "resource.task_released")]
    ResourceTaskReleased {
        task_id: String,
        held_ms: u64,
        cause: ResourceReleaseCause,
    },

    // ---- KalVoice (never carries transcripts or audio) ----
    #[serde(rename = "kalvoice.dictation_started")]
    KalVoiceDictationStarted { session_id: String },
    #[serde(rename = "kalvoice.dictation_completed")]
    KalVoiceDictationCompleted {
        session_id: String,
        duration_ms: u64,
        characters: u32,
    },
    #[serde(rename = "kalvoice.dictation_failed")]
    KalVoiceDictationFailed { session_id: String, code: String },
    #[serde(rename = "kalvoice.request_started")]
    KalVoiceRequestStarted {
        request_id: String,
        input: KalVoiceInput,
    },
    #[serde(rename = "kalvoice.command_recognized")]
    KalVoiceCommandRecognized { request_id: String, intent: String },
    #[serde(rename = "kalvoice.command_executed")]
    KalVoiceCommandExecuted { request_id: String, intent: String },
    #[serde(rename = "kalvoice.request_completed")]
    KalVoiceRequestCompleted { request_id: String },
    #[serde(rename = "kalvoice.request_failed")]
    KalVoiceRequestFailed { request_id: String, code: String },
    #[serde(rename = "kalvoice.limit_reached")]
    KalVoiceLimitReached { allowance: u32, resets_at: String },
    #[serde(rename = "kalvoice.provider_selected")]
    KalVoiceProviderSelected {
        intelligence: KalVoiceIntelligence,
        scope: String,
    },
    #[serde(rename = "kalvoice.voice_output_started")]
    KalVoiceVoiceOutputStarted { request_id: String },
    #[serde(rename = "kalvoice.voice_output_completed")]
    KalVoiceVoiceOutputCompleted { request_id: String },
    /// Which way a push-to-talk utterance went (CA-1). Ids and the outcome only — never words.
    #[serde(rename = "kalvoice.talk_routed")]
    KalVoiceTalkRouted {
        request_id: String,
        outcome: TalkRoute,
    },

    // ---- Notification center (Z7-W3) ----
    /// A notification was created, or re-raised by coalescing a repeat into it. Ids and enums
    /// only; the title and body live in the `notifications` table.
    #[serde(rename = "notification.created")]
    NotificationCreated {
        notification_id: String,
        kind: NotificationKind,
        severity: Severity,
        entity_kind: Option<NotificationEntityKind>,
        entity_id: Option<String>,
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
            Self::ProviderHealthChanged { .. } => "provider.health_changed",
            Self::ProviderCapacityChanged { .. } => "provider.capacity_changed",
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
            Self::PermissionDefaultModeChanged { .. } => "permission.default_mode_changed",
            Self::GitBranchChanged { .. } => "git.branch_changed",
            Self::GitDiffChanged { .. } => "git.diff_changed",
            Self::GitCommitCreated { .. } => "git.commit_created",
            Self::GitWorktreeCreated { .. } => "git.worktree_created",
            Self::GitWorktreeRemoved { .. } => "git.worktree_removed",
            Self::TimelineCheckpointCreated { .. } => "timeline.checkpoint_created",
            Self::TimelineCheckpointPruned { .. } => "timeline.checkpoint_pruned",
            Self::ContextPackageCreated { .. } => "context.package_created",
            Self::ContextBlocked { .. } => "context.blocked",
            Self::ContextRedacted { .. } => "context.redacted",
            Self::ContextOverrideConfirmed { .. } => "context.override_confirmed",
            Self::ContextShared { .. } => "context.shared",
            Self::ContextDiscarded { .. } => "context.discarded",
            Self::ResourcePressureChanged { .. } => "resource.pressure_changed",
            Self::ResourceModeChanged { .. } => "resource.mode_changed",
            Self::ResourceTaskHeld { .. } => "resource.task_held",
            Self::ResourceTaskReleased { .. } => "resource.task_released",
            Self::KalVoiceDictationStarted { .. } => "kalvoice.dictation_started",
            Self::KalVoiceDictationCompleted { .. } => "kalvoice.dictation_completed",
            Self::KalVoiceDictationFailed { .. } => "kalvoice.dictation_failed",
            Self::KalVoiceRequestStarted { .. } => "kalvoice.request_started",
            Self::KalVoiceCommandRecognized { .. } => "kalvoice.command_recognized",
            Self::KalVoiceCommandExecuted { .. } => "kalvoice.command_executed",
            Self::KalVoiceRequestCompleted { .. } => "kalvoice.request_completed",
            Self::KalVoiceRequestFailed { .. } => "kalvoice.request_failed",
            Self::KalVoiceLimitReached { .. } => "kalvoice.limit_reached",
            Self::KalVoiceProviderSelected { .. } => "kalvoice.provider_selected",
            Self::KalVoiceVoiceOutputStarted { .. } => "kalvoice.voice_output_started",
            Self::KalVoiceVoiceOutputCompleted { .. } => "kalvoice.voice_output_completed",
            Self::KalVoiceTalkRouted { .. } => "kalvoice.talk_routed",
            Self::NotificationCreated { .. } => "notification.created",
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
            EventPayload::ProviderHealthChanged {
                provider_id: p(),
                from: HealthState::Unknown,
                to: HealthState::Healthy,
                reason: s(),
            },
            EventPayload::ProviderCapacityChanged {
                provider_id: p(),
                state: CapacityState::BackingOff,
                active_sessions: 1,
                limit: None,
                retry_at: None,
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
            EventPayload::PermissionDefaultModeChanged {
                from: PermissionMode::Approve,
                to: PermissionMode::Plan,
            },
            EventPayload::GitBranchChanged {
                workspace_id: s(),
                from: None,
                to: s(),
            },
            EventPayload::GitDiffChanged {
                workspace_id: s(),
                worktree_id: None,
                files: 2,
            },
            EventPayload::GitCommitCreated {
                workspace_id: s(),
                worktree_id: None,
                oid: s(),
                by_kal_code: true,
            },
            EventPayload::GitWorktreeCreated {
                workspace_id: s(),
                worktree_id: s(),
                branch: s(),
                purpose: WorktreePurpose::User,
            },
            EventPayload::GitWorktreeRemoved {
                workspace_id: s(),
                worktree_id: s(),
                branch: s(),
                purpose: WorktreePurpose::Task,
            },
            EventPayload::TimelineCheckpointCreated {
                checkpoint_id: s(),
                workspace_id: s(),
                trigger: "user".into(),
                files: 3,
                bytes_added: 10,
            },
            EventPayload::TimelineCheckpointPruned {
                checkpoint_id: s(),
                reason: "quota".into(),
            },
            EventPayload::ContextPackageCreated {
                package_id: s(),
                purpose: ContextPurpose::Drop,
                items: 1,
                bytes: 2,
            },
            EventPayload::ContextBlocked {
                package_id: s(),
                rule: "secret_detected".into(),
                items: 1,
            },
            EventPayload::ContextRedacted {
                package_id: s(),
                items: 1,
                spans: 2,
            },
            EventPayload::ContextOverrideConfirmed {
                package_id: s(),
                position: 0,
                rule: "ignored_path.gitignore".into(),
            },
            EventPayload::ContextShared {
                package_id: s(),
                thread_id: None,
                provider_id: p(),
                items: 1,
                bytes: 2,
                redactions: 0,
            },
            EventPayload::ContextDiscarded { package_id: s() },
            EventPayload::ResourcePressureChanged {
                resource: ResourceKind::Memory,
                from: PressureLevel::Normal,
                to: PressureLevel::High,
                mode: GovernorMode::Balanced,
                signal: Some(Signal::MemoryAvailableMb),
                value: Some(512.0),
                threshold: Some(1024.0),
            },
            EventPayload::ResourceModeChanged {
                from: GovernorMode::Balanced,
                to: GovernorMode::Performance,
            },
            EventPayload::ResourceTaskHeld {
                task_id: s(),
                reasons: vec![ResourceHoldReason::UserLimit {
                    running: 4,
                    limit: 4,
                    mode: GovernorMode::Balanced,
                }],
                mode: GovernorMode::Balanced,
            },
            EventPayload::ResourceTaskReleased {
                task_id: s(),
                held_ms: 1500,
                cause: ResourceReleaseCause::LimitFreed,
            },
            EventPayload::KalVoiceDictationStarted { session_id: s() },
            EventPayload::KalVoiceDictationCompleted {
                session_id: s(),
                duration_ms: 1,
                characters: 1,
            },
            EventPayload::KalVoiceDictationFailed {
                session_id: s(),
                code: s(),
            },
            EventPayload::KalVoiceRequestStarted {
                request_id: s(),
                input: KalVoiceInput::Voice,
            },
            EventPayload::KalVoiceCommandRecognized {
                request_id: s(),
                intent: s(),
            },
            EventPayload::KalVoiceCommandExecuted {
                request_id: s(),
                intent: s(),
            },
            EventPayload::KalVoiceRequestCompleted { request_id: s() },
            EventPayload::KalVoiceRequestFailed {
                request_id: s(),
                code: s(),
            },
            EventPayload::KalVoiceLimitReached {
                allowance: 250,
                resets_at: s(),
            },
            EventPayload::KalVoiceProviderSelected {
                intelligence: KalVoiceIntelligence::Local,
                scope: s(),
            },
            EventPayload::KalVoiceVoiceOutputStarted { request_id: s() },
            EventPayload::KalVoiceVoiceOutputCompleted { request_id: s() },
            EventPayload::KalVoiceTalkRouted {
                request_id: s(),
                outcome: TalkRoute::Dictation,
            },
            EventPayload::NotificationCreated {
                notification_id: s(),
                kind: NotificationKind::ThreadCompleted,
                severity: Severity::Info,
                entity_kind: Some(NotificationEntityKind::Thread),
                entity_id: Some(s()),
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
        assert_eq!(samples.len(), 71);
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

    #[test]
    fn ca1_payloads_use_the_documented_field_names() {
        let json = serde_json::to_value(EventPayload::GitCommitCreated {
            workspace_id: "w".into(),
            worktree_id: None,
            oid: "a".into(),
            by_kal_code: true,
        })
        .expect("json");
        assert_eq!(json["payload"]["byKalCode"], true);
        let json = serde_json::to_value(EventPayload::ResourcePressureChanged {
            resource: ResourceKind::DiskSpace,
            from: PressureLevel::Normal,
            to: PressureLevel::Elevated,
            mode: GovernorMode::Conservative,
            signal: Some(Signal::DiskFreeMb {
                mount: "C:\\".into(),
            }),
            value: Some(1.0),
            threshold: None,
        })
        .expect("json");
        assert_eq!(json["payload"]["signal"]["signal"], "disk_free_mb");
        // The optional facts may be absent in stored payloads.
        let minimal: EventPayload = serde_json::from_value(serde_json::json!({
            "type": "resource.pressure_changed",
            "payload": {"resource": "cpu", "from": "normal", "to": "high", "mode": "balanced"}
        }))
        .expect("minimal");
        assert!(matches!(
            minimal,
            EventPayload::ResourcePressureChanged {
                signal: None,
                value: None,
                ..
            }
        ));
    }

    #[test]
    fn correlation_is_v1_compatible() {
        // An envelope's correlation as stored before CA-1 has only five fields.
        let old: Correlation = serde_json::from_value(serde_json::json!({
            "workspaceId": "w", "threadId": null, "missionId": null, "providerId": null,
            "requestId": null
        }))
        .expect("old correlation");
        assert_eq!(old.workspace_id.as_deref(), Some("w"));
        assert_eq!(old.causation_id, None);
        let json = serde_json::to_value(Correlation {
            causation_id: Some("e".into()),
            ..Correlation::default()
        })
        .expect("json");
        assert_eq!(json["causationId"], "e");
        assert!(json["agentId"].is_null());
    }

    #[test]
    fn event_query_defaults_fill_missing_fields() {
        let query: EventQuery =
            serde_json::from_value(serde_json::json!({"types": ["thread.*"], "limit": 20}))
                .expect("query");
        assert_eq!(query.order, SeqOrder::Desc);
        assert_eq!(query.correlation, CorrelationFilter::default());
        assert_eq!(query.limit, 20);
        let asc: EventQuery = serde_json::from_value(
            serde_json::json!({"order": "asc", "correlation": {"agentId": "a"}}),
        )
        .expect("asc");
        assert_eq!(asc.order, SeqOrder::Asc);
        assert_eq!(asc.correlation.agent_id.as_deref(), Some("a"));
        assert_eq!(asc.limit, 100);
    }
}
