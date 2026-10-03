//! Typed contracts for handing work between real interactive coding-agent panes.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum HandoffTask {
    Review,
    Test,
    Fix,
    Continue,
}

impl HandoffTask {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Review => "review",
            Self::Test => "test",
            Self::Fix => "fix",
            Self::Continue => "continue",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum HandoffStatus {
    Queued,
    Delivered,
    Working,
    NeedsYou,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}

impl HandoffStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Delivered => "delivered",
            Self::Working => "working",
            Self::NeedsYou => "needs_you",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Interrupted => "interrupted",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum HandoffCompletion {
    Completed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HandoffPreview {
    pub id: String,
    pub source_thread_id: String,
    pub target_thread_id: String,
    pub task: HandoffTask,
    pub text: String,
    pub preview_hash: String,
    pub source_commit: Option<String>,
    pub source_branch: Option<String>,
    pub source_dirty: bool,
    pub warnings: Vec<String>,
    pub expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HandoffRecord {
    pub id: String,
    pub source_thread_id: String,
    pub target_thread_id: String,
    pub source_workspace_id: String,
    pub target_workspace_id: String,
    pub source_name: String,
    pub target_name: String,
    pub task: HandoffTask,
    pub status: HandoffStatus,
    pub created_at: String,
    pub updated_at: String,
    pub result: Option<String>,
    pub blocker: Option<String>,
    pub source_commit: Option<String>,
    pub source_branch: Option<String>,
    pub return_of_id: Option<String>,
}
