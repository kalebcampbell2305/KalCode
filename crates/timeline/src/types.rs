use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;
pub const MAX_PLAN_JSON_BYTES: usize = 16 * 1024;
pub const MAX_EVIDENCE_JSON_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RestoreKind {
    Files,
    NewBranch,
    NewWorktree,
    ResetBranch,
}

impl RestoreKind {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Files => "files",
            Self::NewBranch => "new_branch",
            Self::NewWorktree => "new_worktree",
            Self::ResetBranch => "reset_branch",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "files" => Some(Self::Files),
            "new_branch" => Some(Self::NewBranch),
            "new_worktree" => Some(Self::NewWorktree),
            "reset_branch" => Some(Self::ResetBranch),
            _ => None,
        }
    }

    pub const fn destructive(self) -> bool {
        matches!(self, Self::Files | Self::ResetBranch)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RestoreStatus {
    Planned,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl RestoreStatus {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Planned => "planned",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "planned" => Some(Self::Planned),
            "running" => Some(Self::Running),
            "completed" => Some(Self::Completed),
            "failed" => Some(Self::Failed),
            "cancelled" => Some(Self::Cancelled),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReplayStatus {
    Planned,
    Running,
    Completed,
    Stopped,
    Failed,
}

impl ReplayStatus {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Planned => "planned",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Stopped => "stopped",
            Self::Failed => "failed",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "planned" => Some(Self::Planned),
            "running" => Some(Self::Running),
            "completed" => Some(Self::Completed),
            "stopped" => Some(Self::Stopped),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }
}

/// Bounded plan metadata. It intentionally contains counts and flags only, never paths, file
/// content, patches, model output, provider output, or approval material.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePlanSummary {
    pub schema_version: u32,
    pub changes_total: u32,
    pub overwrite: u32,
    pub create: u32,
    pub delete: u32,
    pub keep: u32,
    pub reset_branch: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayPlanSummary {
    pub schema_version: u32,
    pub steps_total: u32,
    pub replayable: u32,
    pub not_replayable: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceOutcome {
    Completed,
    Failed,
    Cancelled,
    Stopped,
    RestartInterrupted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationStage {
    Planned,
    SafetyCheckpoint,
    Execution,
    Verification,
    Recovery,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectsState {
    None,
    Partial,
    Complete,
    Unknown,
}

/// Closed, bounded terminal evidence. References are canonical KalCode entity ids; there is no
/// free-form message or source-content field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationEvidence {
    pub schema_version: u32,
    pub outcome: EvidenceOutcome,
    pub stage: OperationStage,
    pub effects: EffectsState,
    pub affected_items: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retained_checkpoint_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewRestoreOperation {
    pub id: String,
    pub workspace_id: String,
    pub checkpoint_id: String,
    pub kind: RestoreKind,
    pub plan_fingerprint: String,
    pub plan_summary: RestorePlanSummary,
    /// SHA-256 over the canonical, non-secret approval decision/object/version binding (approval
    /// id, domain, action, workspace, plan and expiry), encoded as lowercase hexadecimal. Only a
    /// Trust Kernel validated binding belongs here. A bearer token, approval secret, or digest of
    /// either is never accepted or persisted; this store records authority but cannot grant it.
    pub approval_binding_digest: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewReplayRun {
    pub id: String,
    pub workspace_id: String,
    pub checkpoint_id: String,
    pub from_seq: i64,
    pub to_seq: i64,
    pub steps_total: u32,
    pub plan_fingerprint: String,
    pub plan_summary: ReplayPlanSummary,
    /// The same canonical, non-secret Trust Kernel decision binding described by
    /// [`NewRestoreOperation::approval_binding_digest`]. It is an authority reference, never a
    /// bearer token, token digest, approval secret, or independent permission grant.
    pub approval_binding_digest: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoreOperation {
    pub id: String,
    pub schema_version: u32,
    pub workspace_id: String,
    pub checkpoint_id: String,
    pub kind: RestoreKind,
    pub plan_fingerprint: String,
    pub plan_summary: RestorePlanSummary,
    pub expires_at: String,
    pub safety_checkpoint_id: Option<String>,
    pub status: RestoreStatus,
    pub recovery_required: bool,
    pub planned_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub evidence: Option<OperationEvidence>,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplayRun {
    pub id: String,
    pub schema_version: u32,
    pub workspace_id: String,
    pub checkpoint_id: String,
    pub from_seq: i64,
    pub to_seq: i64,
    pub steps_total: u32,
    pub steps_done: u32,
    pub plan_fingerprint: String,
    pub plan_summary: ReplayPlanSummary,
    pub expires_at: String,
    pub safety_checkpoint_id: Option<String>,
    pub status: ReplayStatus,
    pub recovery_required: bool,
    pub planned_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub evidence: Option<OperationEvidence>,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartOutcome<T> {
    Started(T),
    Expired(T),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RecoveryReport {
    pub restore_operations: u32,
    pub replay_runs: u32,
}
