//! Operations v1: one work item moves from Queue to Runs. Other views are projections of
//! these identities and canonical runtime evidence, never independent execution stores.
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Native-only handoff path for an optional bounded Operations artifact report.
pub const OPERATION_ARTIFACT_REPORT_ENV: &str = "KALCODE_OPERATION_ARTIFACT_REPORT";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum OperationKind {
    Agent,
    Build,
    Test,
    Script,
    Deploy,
    Release,
    Background,
    Service,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum OperationStatus {
    Queued,
    Starting,
    Running,
    Paused,
    Blocked,
    Succeeded,
    Failed,
    Cancelled,
    Interrupted,
    /// Historical observation without durable completion evidence; never a scheduler state.
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum OperationLane {
    Next,
    Later,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum OperationEnvironmentKind {
    Local,
    Preview,
    Staging,
    Production,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OperationSpec {
    pub name: String,
    pub workspace_id: String,
    pub kind: OperationKind,
    /// Explicit owner-authored shell command. Never filled from untrusted output.
    pub command: Option<String>,
    pub prompt: Option<String>,
    pub provider_id: Option<String>,
    pub provider_account_id: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub dependencies: Vec<String>,
    pub priority: i32,
    pub lane: OperationLane,
    pub environment: OperationEnvironmentKind,
    /// Declared deployment endpoints, not proof of a live deployment.
    pub urls: Vec<String>,
    /// Names only. Secret values never cross the Operations boundary.
    pub env_keys: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OperationRecord {
    pub id: String,
    pub spec: OperationSpec,
    /// operations, thread, terminal, or background; observed records cannot be queued twice.
    pub source: String,
    pub status: OperationStatus,
    pub workspace_name: String,
    pub branch: Option<String>,
    pub version: Option<String>,
    pub account_label: Option<String>,
    pub terminal_id: Option<String>,
    pub thread_id: Option<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub current_action: Option<String>,
    pub outcome: Option<String>,
    pub position: i64,
    pub blockers: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OperationMoment {
    pub id: String,
    pub at: String,
    pub kind: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OperationArtifact {
    pub name: String,
    pub location: String,
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OperationTestResult {
    pub name: String,
    pub status: String,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OperationDetail {
    pub run: OperationRecord,
    pub timeline: Vec<OperationMoment>,
    pub logs: Option<String>,
    pub files: Vec<String>,
    pub artifacts: Vec<OperationArtifact>,
    pub tests: Vec<OperationTestResult>,
    pub notes: Vec<String>,
    /// Services created by this run. Historical entries never imply a live process.
    #[serde(default)]
    pub related_services: Vec<OperationServiceRelationship>,
    /// Deployment outcomes created by this run. Health remains separately evidenced.
    #[serde(default)]
    pub related_deployments: Vec<OperationDeploymentRelationship>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DevelopmentService {
    pub id: String,
    pub run_id: Option<String>,
    pub name: String,
    pub status: String,
    pub pid: Option<u32>,
    pub process_name: String,
    pub uptime_seconds: Option<u64>,
    pub ports: Vec<u16>,
    pub urls: Vec<String>,
    pub workspace_id: String,
    pub workspace_name: String,
    pub terminal_id: Option<String>,
    pub can_stop: bool,
    pub can_restart: bool,
    pub action_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EnvironmentVariablePresence {
    pub name: String,
    pub present: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OperationEnvironment {
    pub workspace_id: String,
    pub kind: OperationEnvironmentKind,
    pub branch: Option<String>,
    pub version: Option<String>,
    pub urls: Vec<String>,
    pub deployment_status: String,
    pub health: String,
    pub platform: Option<String>,
    pub last_deploy: Option<String>,
    pub run_id: Option<String>,
    pub variables: Vec<EnvironmentVariablePresence>,
    pub observed_at: String,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OperationServiceRelationship {
    pub service: DevelopmentService,
    /// True only when this service is present in the current Services projection.
    pub is_current: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OperationDeploymentRelationship {
    pub environment: OperationEnvironment,
    /// True only when this run currently defines the matching Environment projection.
    pub is_current: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OperationActivity {
    pub id: String,
    pub at: String,
    pub kind: String,
    pub name: String,
    pub area: String,
    pub workspace_id: Option<String>,
    pub run_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OperationsSnapshot {
    pub revision: u64,
    pub paused: bool,
    pub items: Vec<OperationRecord>,
    pub services: Vec<DevelopmentService>,
    pub environments: Vec<OperationEnvironment>,
    pub activity: Vec<OperationActivity>,
    pub observed_at: String,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OperationHistoryPage {
    pub items: Vec<OperationRecord>,
    pub next_cursor: Option<String>,
}
