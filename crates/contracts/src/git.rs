//! Git and workspace-files wire types (campaign Z6a; adopted in CA-1 from
//! `docs/CONTRACTS_ADVANCED.md` §5.3 and `docs/campaigns/Z6a.md` §7). Moved from `kalcode_git`
//! with identical JSON; `kalcode_git` re-exports them. Paths shown here are display paths only:
//! the WebView addresses files through [`FileHandle`](crate::refs::FileHandle)s.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::refs::FileRef;

/// One entry of a directory listing (`files_list`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FileEntry {
    pub file: FileRef,
    pub is_dir: bool,
    pub bytes: Option<u64>,
    /// Matched by `.gitignore`, `.git/info/exclude` or the global excludes file.
    pub ignored: bool,
}

/// Compact status for badges and the Dashboard.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GitStatusSummary {
    pub workspace_id: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub changed: u32,
    pub untracked: u32,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
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

/// A KalCode-managed worktree (`git_worktrees`). Its folder is native-only and never serialized.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
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

/// How a file changed in a diff or status. A superset of
/// [`FileChange`](crate::agent::FileChange) (which has no renames or copies).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum GitFileChange {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Unmerged,
}

/// One file of a diff, for lists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
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

/// What to compare.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum DiffTarget {
    /// Index → working tree (unstaged changes).
    WorkingTree,
    /// HEAD → index (staged changes).
    Staged,
    /// HEAD → working tree (everything not committed).
    Head,
    /// A commit → working tree.
    Base { base: String },
    /// Commit → commit.
    Commits { from: String, to: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum LineKind {
    Context,
    Add,
    Delete,
    /// `\ No newline at end of file`.
    NoNewline,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DiffLine {
    pub kind: LineKind,
    pub old_line: Option<u32>,
    pub new_line: Option<u32>,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Hunk {
    /// The `@@ -a,b +c,d @@ section` line.
    pub header: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<DiffLine>,
}

/// A file with its hunks (the [`DiffFile`] fields, flattened).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FileDiff {
    #[serde(flatten)]
    pub meta: DiffFile,
    pub hunks: Vec<Hunk>,
    /// Some hunks or lines of this file were left out (size caps).
    pub hunks_truncated: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Diff {
    pub files: Vec<FileDiff>,
    /// The patch exceeded the byte cap; files after the cut have no hunks.
    pub truncated: bool,
}

/// Which side of a merge conflict changed what.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ConflictKind {
    BothDeleted,
    AddedByUs,
    DeletedByThem,
    AddedByThem,
    DeletedByUs,
    BothAdded,
    BothModified,
}

/// Branch facts from `git status`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BranchState {
    /// `None` before the first commit.
    pub head_oid: Option<String>,
    /// `None` when HEAD is detached.
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
}

/// A status line as the UI receives it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StatusFile {
    /// `None` when the file is outside the workspace or its name isn't a valid path.
    pub file: Option<FileRef>,
    /// Workspace-relative when inside the workspace, otherwise repository-relative.
    pub path: String,
    pub orig_path: Option<String>,
    pub staged: Option<GitFileChange>,
    pub unstaged: Option<GitFileChange>,
    pub untracked: bool,
    pub conflict: Option<ConflictKind>,
    pub submodule: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Commit {
    pub oid: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub authored_at: String,
    pub committed_at: String,
    pub subject: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum BranchKind {
    Local,
    Remote,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Branch {
    /// Short name (`main`, `origin/main`).
    pub name: String,
    pub kind: BranchKind,
    pub oid: String,
    pub upstream: Option<String>,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    /// The upstream branch no longer exists.
    pub upstream_gone: bool,
    /// HEAD points at this branch.
    pub current: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::refs::FileHandle;

    #[test]
    fn enums_use_snake_case_and_round_trip_as_str() {
        for purpose in [
            WorktreePurpose::Task,
            WorktreePurpose::Thread,
            WorktreePurpose::BranchFromCheckpoint,
            WorktreePurpose::User,
        ] {
            let json = serde_json::to_value(purpose).expect("json");
            assert_eq!(json, purpose.as_str());
            assert_eq!(WorktreePurpose::parse(purpose.as_str()), Some(purpose));
        }
        for status in [
            WorktreeStatus::Active,
            WorktreeStatus::Merged,
            WorktreeStatus::Abandoned,
            WorktreeStatus::Removed,
        ] {
            assert_eq!(serde_json::to_value(status).expect("json"), status.as_str());
            assert_eq!(WorktreeStatus::parse(status.as_str()), Some(status));
        }
        assert_eq!(WorktreePurpose::parse("other"), None);
        assert_eq!(
            serde_json::to_value(GitFileChange::TypeChanged).expect("json"),
            "type_changed"
        );
    }

    #[test]
    fn diff_targets_are_tagged_by_kind() {
        assert_eq!(
            serde_json::to_value(DiffTarget::Commits {
                from: "a".into(),
                to: "b".into()
            })
            .expect("json"),
            serde_json::json!({"kind": "commits", "from": "a", "to": "b"})
        );
        assert_eq!(
            serde_json::to_value(DiffTarget::WorkingTree).expect("json"),
            serde_json::json!({"kind": "working_tree"})
        );
    }

    #[test]
    fn file_diff_flattens_its_file_fields() {
        let diff = FileDiff {
            meta: DiffFile {
                file: Some(FileRef {
                    handle: FileHandle { id: "h".into() },
                    workspace_id: "w".into(),
                    display_path: "a".into(),
                }),
                path: "a".into(),
                old_path: None,
                change: GitFileChange::Modified,
                additions: 1,
                deletions: 0,
                binary: false,
            },
            hunks: vec![],
            hunks_truncated: false,
        };
        let json = serde_json::to_value(&diff).expect("json");
        assert_eq!(json["path"], "a");
        assert_eq!(json["change"], "modified");
        assert_eq!(json["hunksTruncated"], false);
        let back: FileDiff = serde_json::from_value(json).expect("back");
        assert_eq!(back, diff);
    }
}
