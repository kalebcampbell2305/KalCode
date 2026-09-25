//! Wire types for Z6a.
//!
//! Adopted into `crates/contracts` in CA-1 (`refs`, `git`, `timeline`) with identical JSON; this
//! module re-exports them so existing paths (`kalcode_git::types::…`) keep working, and keeps the
//! paging helper that returns KalCode errors.

pub use kalcode_contracts::git::{
    Branch, BranchKind, BranchState, Commit, ConflictKind, Diff, DiffFile, DiffLine, DiffTarget,
    FileDiff, FileEntry, GitFileChange, GitStatusSummary, Hunk, LineKind, StatusFile, Worktree,
    WorktreePurpose, WorktreeStatus,
};
pub use kalcode_contracts::refs::{FileHandle, FileRef, MAX_PAGE, Page, PageRequest};
pub use kalcode_contracts::timeline::{Checkpoint, CheckpointTrigger, PlannedChange};

/// Pages a fully materialized, already ordered list with an offset cursor.
pub fn page_of<T: Clone>(items: &[T], request: &PageRequest) -> kalcode_core::Result<Page<T>> {
    Ok(kalcode_contracts::refs::page_of(items, request)?)
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
