//! `git.*` and `timeline.checkpoint_*` event facts.
//!
//! This crate describes each event with [`GitEvent`], whose JSON is exactly the contract wire
//! form. CA-1 declared the matching `EventPayload` variants; `EventPayload::from(GitEvent)` maps
//! one-to-one (tested). Payloads carry ids and short facts only — never file contents, paths of
//! files, or commit messages.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use kalcode_contracts::events::EventPayload;
use serde::{Deserialize, Serialize};

use crate::types::{CheckpointTrigger, WorktreePurpose};

/// Proposed event variants (all `version: 1`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload", rename_all_fields = "camelCase")]
pub enum GitEvent {
    /// HEAD moved to another branch (or detached: `to` = `"(detached)"`).
    #[serde(rename = "git.branch_changed")]
    BranchChanged {
        workspace_id: String,
        from: Option<String>,
        to: String,
    },
    /// The set of changed files differs from the last report (debounced ≥ 1 s).
    #[serde(rename = "git.diff_changed")]
    DiffChanged {
        workspace_id: String,
        worktree_id: Option<String>,
        files: u32,
    },
    #[serde(rename = "git.commit_created")]
    CommitCreated {
        workspace_id: String,
        worktree_id: Option<String>,
        oid: String,
        by_kal_code: bool,
    },
    #[serde(rename = "git.worktree_created")]
    WorktreeCreated {
        workspace_id: String,
        worktree_id: String,
        branch: String,
        purpose: WorktreePurpose,
    },
    #[serde(rename = "git.worktree_removed")]
    WorktreeRemoved {
        workspace_id: String,
        worktree_id: String,
        branch: String,
        purpose: WorktreePurpose,
    },
    #[serde(rename = "timeline.checkpoint_created")]
    CheckpointCreated {
        checkpoint_id: String,
        workspace_id: String,
        /// The trigger's kind (`user`, `thread_turn`, …).
        trigger: String,
        files: u32,
        bytes_added: u64,
    },
    #[serde(rename = "timeline.checkpoint_pruned")]
    CheckpointPruned {
        checkpoint_id: String,
        reason: String,
    },
}

impl GitEvent {
    pub fn event_type(&self) -> &'static str {
        match self {
            Self::BranchChanged { .. } => "git.branch_changed",
            Self::DiffChanged { .. } => "git.diff_changed",
            Self::CommitCreated { .. } => "git.commit_created",
            Self::WorktreeCreated { .. } => "git.worktree_created",
            Self::WorktreeRemoved { .. } => "git.worktree_removed",
            Self::CheckpointCreated { .. } => "timeline.checkpoint_created",
            Self::CheckpointPruned { .. } => "timeline.checkpoint_pruned",
        }
    }

    pub fn workspace_id(&self) -> Option<&str> {
        match self {
            Self::BranchChanged { workspace_id, .. }
            | Self::DiffChanged { workspace_id, .. }
            | Self::CommitCreated { workspace_id, .. }
            | Self::WorktreeCreated { workspace_id, .. }
            | Self::WorktreeRemoved { workspace_id, .. }
            | Self::CheckpointCreated { workspace_id, .. } => Some(workspace_id),
            Self::CheckpointPruned { .. } => None,
        }
    }
}

impl From<GitEvent> for EventPayload {
    fn from(event: GitEvent) -> Self {
        match event {
            GitEvent::BranchChanged {
                workspace_id,
                from,
                to,
            } => EventPayload::GitBranchChanged {
                workspace_id,
                from,
                to,
            },
            GitEvent::DiffChanged {
                workspace_id,
                worktree_id,
                files,
            } => EventPayload::GitDiffChanged {
                workspace_id,
                worktree_id,
                files,
            },
            GitEvent::CommitCreated {
                workspace_id,
                worktree_id,
                oid,
                by_kal_code,
            } => EventPayload::GitCommitCreated {
                workspace_id,
                worktree_id,
                oid,
                by_kal_code,
            },
            GitEvent::WorktreeCreated {
                workspace_id,
                worktree_id,
                branch,
                purpose,
            } => EventPayload::GitWorktreeCreated {
                workspace_id,
                worktree_id,
                branch,
                purpose,
            },
            GitEvent::WorktreeRemoved {
                workspace_id,
                worktree_id,
                branch,
                purpose,
            } => EventPayload::GitWorktreeRemoved {
                workspace_id,
                worktree_id,
                branch,
                purpose,
            },
            GitEvent::CheckpointCreated {
                checkpoint_id,
                workspace_id,
                trigger,
                files,
                bytes_added,
            } => EventPayload::TimelineCheckpointCreated {
                checkpoint_id,
                workspace_id,
                trigger,
                files,
                bytes_added,
            },
            GitEvent::CheckpointPruned {
                checkpoint_id,
                reason,
            } => EventPayload::TimelineCheckpointPruned {
                checkpoint_id,
                reason,
            },
        }
    }
}

/// The `kind` tag of a trigger, for the event payload.
pub fn trigger_kind(trigger: &CheckpointTrigger) -> &'static str {
    trigger.kind()
}

/// Turns observed Git state into transition events: `git.branch_changed` when the branch
/// differs from the last observation, `git.diff_changed` when the changed-file count differs and
/// at least `min_interval` passed since the last one for that workspace (≥ 1 s by contract).
#[derive(Debug)]
pub struct Transitions {
    min_interval: Duration,
    branches: HashMap<String, Option<String>>,
    diffs: HashMap<String, (u32, Instant)>,
}

impl Default for Transitions {
    fn default() -> Self {
        Self::new(Duration::from_secs(1))
    }
}

impl Transitions {
    pub fn new(min_interval: Duration) -> Self {
        Self {
            min_interval: min_interval.max(Duration::from_secs(1)),
            branches: HashMap::new(),
            diffs: HashMap::new(),
        }
    }

    /// The first observation of a workspace sets the baseline and emits nothing.
    pub fn observe_branch(&mut self, workspace_id: &str, branch: Option<&str>) -> Option<GitEvent> {
        let branch = branch.map(str::to_owned);
        match self
            .branches
            .insert(workspace_id.to_owned(), branch.clone())
        {
            Some(previous) if previous != branch => Some(GitEvent::BranchChanged {
                workspace_id: workspace_id.to_owned(),
                from: previous,
                to: branch.unwrap_or_else(|| "(detached)".to_owned()),
            }),
            _ => None,
        }
    }

    pub fn observe_changed_files(
        &mut self,
        workspace_id: &str,
        files: u32,
        now: Instant,
    ) -> Option<GitEvent> {
        match self.diffs.get(workspace_id) {
            None => {
                self.diffs.insert(workspace_id.to_owned(), (files, now));
                None
            }
            Some((last, at)) if *last != files && now.duration_since(*at) >= self.min_interval => {
                self.diffs.insert(workspace_id.to_owned(), (files, now));
                Some(GitEvent::DiffChanged {
                    workspace_id: workspace_id.to_owned(),
                    worktree_id: None,
                    files,
                })
            }
            Some(_) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_form_matches_the_proposed_catalog() {
        let event = GitEvent::CommitCreated {
            workspace_id: "w".into(),
            worktree_id: None,
            oid: "o".into(),
            by_kal_code: true,
        };
        assert_eq!(
            serde_json::to_value(&event).expect("json"),
            serde_json::json!({
                "type": "git.commit_created",
                "payload": {"workspaceId": "w", "worktreeId": null, "oid": "o", "byKalCode": true}
            })
        );
        let created = GitEvent::CheckpointCreated {
            checkpoint_id: "c".into(),
            workspace_id: "w".into(),
            trigger: trigger_kind(&CheckpointTrigger::User).into(),
            files: 2,
            bytes_added: 3,
        };
        let value = serde_json::to_value(&created).expect("json");
        assert_eq!(value["type"], "timeline.checkpoint_created");
        assert_eq!(value["payload"]["bytesAdded"], 3);
        assert_eq!(created.event_type(), "timeline.checkpoint_created");
    }

    #[test]
    fn transitions_only_and_debounced() {
        let mut t = Transitions::default();
        assert_eq!(t.observe_branch("w", Some("main")), None);
        assert_eq!(t.observe_branch("w", Some("main")), None);
        assert!(matches!(
            t.observe_branch("w", None),
            Some(GitEvent::BranchChanged { ref to, .. }) if to == "(detached)"
        ));
        let start = Instant::now();
        assert_eq!(t.observe_changed_files("w", 1, start), None);
        assert_eq!(
            t.observe_changed_files("w", 2, start + Duration::from_millis(300)),
            None
        );
        assert!(
            t.observe_changed_files("w", 2, start + Duration::from_millis(1100))
                .is_some()
        );
        assert_eq!(
            t.observe_changed_files("w", 2, start + Duration::from_secs(5)),
            None
        );
    }

    #[test]
    fn every_git_event_maps_to_the_identical_contract_payload() {
        let events = [
            GitEvent::BranchChanged {
                workspace_id: "w".into(),
                from: Some("main".into()),
                to: "dev".into(),
            },
            GitEvent::DiffChanged {
                workspace_id: "w".into(),
                worktree_id: Some("t".into()),
                files: 3,
            },
            GitEvent::CommitCreated {
                workspace_id: "w".into(),
                worktree_id: None,
                oid: "o".into(),
                by_kal_code: true,
            },
            GitEvent::WorktreeCreated {
                workspace_id: "w".into(),
                worktree_id: "t".into(),
                branch: "b".into(),
                purpose: WorktreePurpose::User,
            },
            GitEvent::WorktreeRemoved {
                workspace_id: "w".into(),
                worktree_id: "t".into(),
                branch: "b".into(),
                purpose: WorktreePurpose::Task,
            },
            GitEvent::CheckpointCreated {
                checkpoint_id: "c".into(),
                workspace_id: "w".into(),
                trigger: "user".into(),
                files: 1,
                bytes_added: 2,
            },
            GitEvent::CheckpointPruned {
                checkpoint_id: "c".into(),
                reason: "quota".into(),
            },
        ];
        for event in events {
            let ours = serde_json::to_value(&event).expect("json");
            let payload = EventPayload::from(event.clone());
            assert_eq!(payload.type_name(), event.event_type());
            assert_eq!(serde_json::to_value(&payload).expect("json"), ours);
        }
    }
}
