//! Threads: persistent units of AI work (campaign Z3). Status is structured runtime truth,
//! never inferred from model prose.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::agent::ProviderId;
use crate::permissions::PermissionMode;

/// Normalized thread states (directive §7.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ThreadStatus {
    Starting,
    Active,
    Thinking,
    RunningTool,
    RunningCommand,
    Editing,
    Testing,
    Reviewing,
    Idle,
    WaitingForPermission,
    WaitingForUser,
    WaitingForDependency,
    Paused,
    Completed,
    Failed,
    Interrupted,
    Recovering,
    Offline,
}

impl ThreadStatus {
    /// A process is (or should be) doing work for this thread.
    pub fn is_live(self) -> bool {
        matches!(
            self,
            Self::Starting
                | Self::Active
                | Self::Thinking
                | Self::RunningTool
                | Self::RunningCommand
                | Self::Editing
                | Self::Testing
                | Self::Reviewing
                | Self::Recovering
        )
    }

    /// The thread cannot continue until someone acts.
    pub fn needs_attention(self) -> bool {
        matches!(
            self,
            Self::WaitingForPermission | Self::WaitingForUser | Self::Failed
        )
    }

    /// No further transitions except an explicit restart/resume.
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Interrupted)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum MessageRole {
    User,
    Assistant,
    System,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ThreadError {
    pub code: String,
    /// User-safe explanation: what failed, what is safe, what to do.
    pub message: String,
}

/// The thread fields every surface shows (Threads list, Dashboard cards, KalVoice status reports).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ThreadSummary {
    pub id: String,
    pub name: String,
    pub provider_id: ProviderId,
    pub provider_name: String,
    pub model: Option<String>,
    /// Account label such as "Personal"; never a credential.
    pub account_label: Option<String>,
    pub workspace_id: String,
    pub workspace_name: String,
    pub permission_mode: PermissionMode,
    pub status: ThreadStatus,
    /// What the thread is doing now, from structured tool/status events (e.g. "Running npm test").
    pub current_activity: Option<String>,
    pub created_at: String,
    pub last_activity_at: String,
    pub pending_approvals: u32,
    pub unread_messages: u32,
    pub files_changed: Option<u32>,
    pub branch: Option<String>,
    pub error: Option<ThreadError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ThreadMessage {
    pub id: String,
    pub thread_id: String,
    pub role: MessageRole,
    pub content: String,
    pub created_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_groups_are_consistent() {
        use ThreadStatus::*;
        let all = [
            Starting,
            Active,
            Thinking,
            RunningTool,
            RunningCommand,
            Editing,
            Testing,
            Reviewing,
            Idle,
            WaitingForPermission,
            WaitingForUser,
            WaitingForDependency,
            Paused,
            Completed,
            Failed,
            Interrupted,
            Recovering,
            Offline,
        ];
        assert_eq!(all.len(), 18);
        for status in all {
            assert!(!(status.is_live() && status.is_terminal()), "{status:?}");
        }
        assert_eq!(
            serde_json::to_string(&WaitingForPermission).expect("json"),
            "\"waiting_for_permission\""
        );
    }
}
