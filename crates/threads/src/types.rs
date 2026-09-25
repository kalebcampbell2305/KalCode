//! Thread-runtime types that cross IPC in addition to the shared contracts
//! (`ThreadSummary`, `ThreadMessage`). Exported to TypeScript with ts-rs.
//!
//! `ThreadOptions`, `ProviderOption`, `WorkspaceOption`, `ToolCallRecord` and `ToolCallStatus`
//! moved to `kalcode_contracts::threads` in CA-1 (identical JSON) and are re-exported here.

use kalcode_contracts::permissions::PermissionMode;
pub use kalcode_contracts::threads::{
    ProviderOption, ThreadOptions, ToolCallRecord, ToolCallStatus, WorkspaceOption,
};
use kalcode_contracts::threads::{ThreadStatus, ThreadSummary};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

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

/// Input for creating a thread that starts without a task and waits for input (for example,
/// "create three Claude Code threads" from the voice layer).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateIdleThread {
    pub provider_id: String,
    pub workspace_id: String,
    pub model: Option<String>,
    pub permission_mode: PermissionMode,
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
