//! Thread-runtime types that cross IPC in addition to the shared contracts
//! (`ThreadSummary`, `ThreadMessage`). Exported to TypeScript with ts-rs.

use kalcode_contracts::agent::{ModelInfo, PermissionMapping, ProviderId};
use kalcode_contracts::permissions::PermissionMode;
use kalcode_contracts::threads::{ThreadStatus, ThreadSummary};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A provider the user can start a thread with (from the provider registry).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProviderOption {
    pub id: ProviderId,
    pub display_name: String,
    /// Account label such as "Personal"; never a credential.
    pub account_label: Option<String>,
    pub models: Vec<ModelInfo>,
    pub supports_resume: bool,
    pub supports_interrupt: bool,
    /// The provider routes permission prompts to KalCode for a decision.
    pub host_approvals: bool,
    pub permission_mappings: Vec<PermissionMapping>,
}

/// A workspace a thread can run in (from the workspace resolver). Paths never cross IPC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WorkspaceOption {
    pub id: String,
    pub name: String,
}

/// Everything the New thread flow needs to offer valid choices.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ThreadOptions {
    pub providers: Vec<ProviderOption>,
    pub workspaces: Vec<WorkspaceOption>,
    /// Modes a thread can be created with. Bypass and Custom are set later, through the
    /// permission engine, by an explicit user action.
    pub permission_modes: Vec<PermissionMode>,
    pub default_permission_mode: PermissionMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ToolCallStatus {
    Requested,
    Running,
    Completed,
    Failed,
    /// The session ended (stop, crash, interrupt) before the tool finished.
    Cancelled,
}

/// One tool call a thread's provider made, from structured tool events.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ToolCallRecord {
    pub id: String,
    pub thread_id: String,
    pub tool: String,
    pub summary: String,
    pub status: ToolCallStatus,
    pub result_summary: Option<String>,
    pub requested_at: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

/// Input for creating a thread (IPC `thread_create`, and non-UI callers).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateThread {
    pub provider_id: String,
    pub workspace_id: String,
    pub model: Option<String>,
    pub permission_mode: PermissionMode,
    pub prompt: String,
    pub name: Option<String>,
}

/// Counts of threads by status, for non-UI callers that report what threads are doing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StatusCount {
    pub status: ThreadStatus,
    pub count: u32,
}

/// A snapshot of every open (non-archived) thread.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ThreadsStatusSummary {
    pub total: u32,
    /// Threads whose provider is working now.
    pub working: u32,
    /// Threads that cannot continue until someone acts (approval, input, failure).
    pub needs_attention: u32,
    pub pending_approvals: u32,
    pub by_status: Vec<StatusCount>,
    pub threads: Vec<ThreadSummary>,
}

/// Outcome of a bulk operation on one thread.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BulkOutcome {
    pub thread_id: String,
    pub ok: bool,
    /// User-safe reason when `ok` is false.
    pub message: Option<String>,
}
