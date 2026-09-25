//! Wire types for Z6a.
//!
//! These mirror the PROPOSED contract types in `docs/CONTRACTS_ADVANCED.md` §4 / §5.3 so the
//! lead can move them into `crates/contracts` (with `TS` derives) at CA-0 without changing
//! their JSON shape. Until then they live here and are **not** exported to TypeScript (no
//! `ts-rs`), so this campaign never touches `packages/protocol/src/generated`.

use serde::{Deserialize, Serialize};

/// Opaque, session-scoped reference to a file native code listed (ADVANCED.md §3 D4).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHandle {
    pub id: String,
}

/// What the UI may display about a handle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRef {
    pub handle: FileHandle,
    pub workspace_id: String,
    /// Workspace-relative, `/`-separated.
    pub display_path: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageRequest {
    /// 1..=500.
    pub limit: u32,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
    pub total_estimate: Option<u64>,
}

/// Largest page any list returns.
pub const MAX_PAGE: u32 = 500;

impl PageRequest {
    /// Validates the limit (1..=500) and parses an offset cursor.
    pub fn offset(&self) -> kalcode_core::Result<(usize, usize)> {
        if self.limit == 0 || self.limit > MAX_PAGE {
            return Err(kalcode_core::KalError::validation(
                "invalid_page",
                "Page size must be between 1 and 500.",
            ));
        }
        let offset = match &self.cursor {
            None => 0,
            Some(cursor) => cursor.parse::<usize>().map_err(|_| {
                kalcode_core::KalError::validation(
                    "invalid_cursor",
                    "That page cursor isn't valid.",
                )
            })?,
        };
        Ok((offset, self.limit as usize))
    }
}

/// Pages a fully materialized, already ordered list with an offset cursor.
pub fn page_of<T: Clone>(items: &[T], request: &PageRequest) -> kalcode_core::Result<Page<T>> {
    let (offset, limit) = request.offset()?;
    let end = offset.saturating_add(limit).min(items.len());
    let slice = items
        .get(offset.min(items.len())..end)
        .unwrap_or(&[])
        .to_vec();
    Ok(Page {
        items: slice,
        next_cursor: (end < items.len()).then(|| end.to_string()),
        total_estimate: Some(items.len() as u64),
    })
}

/// One entry of a directory listing (`files_list`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub file: FileRef,
    pub is_dir: bool,
    pub bytes: Option<u64>,
    /// Matched by `.gitignore`, `.git/info/exclude` or the global excludes file.
    pub ignored: bool,
}

/// Compact status for badges and the Dashboard (`GitStatusSummary`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusSummary {
    pub workspace_id: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub changed: u32,
    pub untracked: u32,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorktreePurpose {
    Task,
    Thread,
    BranchFromCheckpoint,
    User,
}

impl WorktreePurpose {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Task => "task",
            Self::Thread => "thread",
            Self::BranchFromCheckpoint => "branch_from_checkpoint",
            Self::User => "user",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "task" => Self::Task,
            "thread" => Self::Thread,
            "branch_from_checkpoint" => Self::BranchFromCheckpoint,
            "user" => Self::User,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeStatus {
    Active,
    Merged,
    Abandoned,
    Removed,
}

impl WorktreeStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Merged => "merged",
            Self::Abandoned => "abandoned",
            Self::Removed => "removed",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "active" => Self::Active,
            "merged" => Self::Merged,
            "abandoned" => Self::Abandoned,
            "removed" => Self::Removed,
            _ => return None,
        })
    }
}

/// A KalCode-managed worktree (`git_worktrees`). The path is native-only and never serialized.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub id: String,
    pub workspace_id: String,
    pub branch: String,
    pub base_commit: String,
    pub purpose: WorktreePurpose,
    pub owner_ref: Option<String>,
    pub status: WorktreeStatus,
    pub created_at: String,
    pub removed_at: Option<String>,
}

/// How a file changed in a diff. Superset of `contracts::agent::FileChange`
/// (created/modified/deleted); a contract addition is requested (`GitFileChange`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GitFileChange {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Unmerged,
}

/// One file of a diff, for lists (`DiffFile`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffFile {
    /// `None` when the file lies outside the workspace (a workspace opened on a subfolder of a
    /// repository) or its name isn't valid UTF-8.
    pub file: Option<FileRef>,
    pub path: String,
    pub old_path: Option<String>,
    pub change: GitFileChange,
    pub additions: u32,
    pub deletions: u32,
    pub binary: bool,
}

/// Why a checkpoint was taken.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum CheckpointTrigger {
    User,
    ThreadTurn { thread_id: String },
    TaskStart { task_id: String },
    BeforeRestore { restore_id: String },
    AutomationRun { run_id: String },
    BeforeDoctorFix { finding_code: String },
}

/// A checkpoint row (`checkpoints`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub id: String,
    pub workspace_id: String,
    pub commit_oid: String,
    pub parent_id: Option<String>,
    pub trigger: CheckpointTrigger,
    pub event_seq: i64,
    pub files: u32,
    pub bytes_added: u64,
    pub pinned: bool,
    pub created_at: String,
    pub pruned_at: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trigger_json_matches_the_proposed_contract() {
        let json = serde_json::to_value(CheckpointTrigger::ThreadTurn {
            thread_id: "t".into(),
        })
        .expect("json");
        assert_eq!(
            json,
            serde_json::json!({"kind": "thread_turn", "threadId": "t"})
        );
        let user = serde_json::to_value(CheckpointTrigger::User).expect("json");
        assert_eq!(user, serde_json::json!({"kind": "user"}));
    }

    #[test]
    fn pages_validate_limits_and_cursors() {
        let items: Vec<u32> = (0..7).collect();
        let first = page_of(
            &items,
            &PageRequest {
                limit: 3,
                cursor: None,
            },
        )
        .expect("page");
        assert_eq!(first.items, [0, 1, 2]);
        assert_eq!(first.next_cursor.as_deref(), Some("3"));
        let last = page_of(
            &items,
            &PageRequest {
                limit: 5,
                cursor: Some("5".into()),
            },
        )
        .expect("page");
        assert_eq!(last.items, [5, 6]);
        assert_eq!(last.next_cursor, None);
        assert!(
            page_of(
                &items,
                &PageRequest {
                    limit: 0,
                    cursor: None
                }
            )
            .is_err()
        );
        assert!(
            page_of(
                &items,
                &PageRequest {
                    limit: 501,
                    cursor: None
                }
            )
            .is_err()
        );
        assert!(
            page_of(
                &items,
                &PageRequest {
                    limit: 1,
                    cursor: Some("-1".into())
                }
            )
            .is_err()
        );
        let beyond = page_of(
            &items,
            &PageRequest {
                limit: 2,
                cursor: Some("99".into()),
            },
        )
        .expect("page");
        assert!(beyond.items.is_empty());
    }
}
