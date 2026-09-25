//! Checkpoints and restore previews (Z6a checkpoint store; the Time Machine builds on these).
//! Adopted in CA-1 from `docs/CONTRACTS_ADVANCED.md` §5.3–5.4 with identical JSON to
//! `kalcode_git`, which re-exports them.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Why a checkpoint was taken.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum CheckpointTrigger {
    User,
    ThreadTurn { thread_id: String },
    TaskStart { task_id: String },
    BeforeRestore { restore_id: String },
    AutomationRun { run_id: String },
    BeforeDoctorFix { finding_code: String },
}

impl CheckpointTrigger {
    /// The `kind` tag (`user`, `thread_turn`, …), as carried by `timeline.checkpoint_created`.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::User => "user",
            Self::ThreadTurn { .. } => "thread_turn",
            Self::TaskStart { .. } => "task_start",
            Self::BeforeRestore { .. } => "before_restore",
            Self::AutomationRun { .. } => "automation_run",
            Self::BeforeDoctorFix { .. } => "before_doctor_fix",
        }
    }
}

/// A checkpoint row (`checkpoints`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
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

/// How one file would change in a restore.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum PlannedChange {
    /// The file exists now and gets the checkpoint's content.
    Overwrite,
    /// The file is missing now and is recreated.
    Create,
    /// The file was added after the checkpoint and is deleted (only when requested).
    Delete,
    /// The file was added after the checkpoint and is kept (the default).
    KeepUntracked,
    /// The checkpoint has this file, but the current file is ignored or too large to snapshot,
    /// so it is kept as it is (restores never touch what they cannot protect). Added in CA-1.
    KeepExisting,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trigger_json_matches_the_git_crate() {
        let json = serde_json::to_value(CheckpointTrigger::ThreadTurn {
            thread_id: "t".into(),
        })
        .expect("json");
        assert_eq!(
            json,
            serde_json::json!({"kind": "thread_turn", "threadId": "t"})
        );
        assert_eq!(
            serde_json::to_value(CheckpointTrigger::User).expect("json"),
            serde_json::json!({"kind": "user"})
        );
    }

    #[test]
    fn trigger_kind_matches_the_wire_tag() {
        for trigger in [
            CheckpointTrigger::User,
            CheckpointTrigger::ThreadTurn {
                thread_id: "t".into(),
            },
            CheckpointTrigger::TaskStart {
                task_id: "t".into(),
            },
            CheckpointTrigger::BeforeRestore {
                restore_id: "r".into(),
            },
            CheckpointTrigger::AutomationRun { run_id: "r".into() },
            CheckpointTrigger::BeforeDoctorFix {
                finding_code: "f".into(),
            },
        ] {
            let json = serde_json::to_value(&trigger).expect("json");
            assert_eq!(json["kind"], trigger.kind());
        }
        assert_eq!(
            serde_json::to_value(PlannedChange::KeepExisting).expect("json"),
            "keep_existing"
        );
    }
}
