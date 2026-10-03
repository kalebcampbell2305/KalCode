//! Canonical durable authority for interactive coding-agent handoffs.
//!
//! This store persists identities, lifecycle and bounded results only. The actual context capsule
//! stays in the process-local ContextPackage registry, so a restart can interrupt but never replay
//! a queued or uncertain terminal write.

use std::sync::Arc;

use kalcode_contracts::handoffs::{HandoffRecord, HandoffStatus, HandoffTask};
use rusqlite::{OptionalExtension, Row, Transaction, params};

use crate::Core;
use crate::error::{KalError, Result};
use crate::time::now_rfc3339;

const RECORD_COLUMNS: &str = "
    id, source_thread_id, target_thread_id, source_workspace_id, target_workspace_id,
    source_name, target_name, task, status, created_at, updated_at, result, blocker,
    source_commit, source_branch, return_of_id";
const MAX_RESULT_BYTES: usize = 32 * 1024;
const MAX_BLOCKER_BYTES: usize = 1024;

#[derive(Debug, Clone)]
pub struct NewHandoff<'a> {
    pub id: &'a str,
    pub context_package_id: &'a str,
    pub source_thread_id: &'a str,
    pub target_thread_id: &'a str,
    pub source_workspace_id: &'a str,
    pub target_workspace_id: &'a str,
    pub source_name: &'a str,
    pub target_name: &'a str,
    pub task: HandoffTask,
    pub target_instance_id: &'a str,
    pub preview_hash: &'a str,
    pub source_commit: Option<&'a str>,
    pub source_branch: Option<&'a str>,
    pub source_dirty: bool,
    pub return_of_id: Option<&'a str>,
}

#[derive(Clone)]
pub struct HandoffStore {
    core: Arc<Core>,
}

impl HandoffStore {
    pub fn new(core: Arc<Core>) -> Self {
        Self { core }
    }

    pub fn create(&self, input: &NewHandoff<'_>) -> Result<HandoffRecord> {
        self.create_with(input, |_| Ok(()))
    }

    /// Creates a queued handoff in the same transaction as its content-free ContextPackage facts.
    pub fn create_with(
        &self,
        input: &NewHandoff<'_>,
        prepare_context: impl FnOnce(&Transaction<'_>) -> Result<()>,
    ) -> Result<HandoffRecord> {
        validate_new(input)?;
        let now = now_rfc3339();
        let (record, _) = self.core.write_with_events(|tx| {
            prepare_context(tx)?;
            tx.execute(
                "INSERT INTO handoffs (
                   id, context_package_id, source_thread_id, target_thread_id,
                   source_workspace_id, target_workspace_id, source_name, target_name,
                   task, status, delivery_state, target_instance_id, preview_hash,
                   source_commit, source_branch, source_dirty, return_of_id, created_at, updated_at
                 ) VALUES (
                   ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'queued', 'pending', ?10, ?11,
                   ?12, ?13, ?14, ?15, ?16, ?16
                 )",
                params![
                    input.id,
                    input.context_package_id,
                    input.source_thread_id,
                    input.target_thread_id,
                    input.source_workspace_id,
                    input.target_workspace_id,
                    input.source_name,
                    input.target_name,
                    input.task.as_str(),
                    input.target_instance_id,
                    input.preview_hash,
                    input.source_commit,
                    input.source_branch,
                    i64::from(input.source_dirty),
                    input.return_of_id,
                    now,
                ],
            )?;
            Ok((load_required(tx, input.id)?, vec![]))
        })?;
        Ok(record)
    }

    pub fn get(&self, id: &str) -> Result<HandoffRecord> {
        validate_id(id)?;
        self.core
            .read(|conn| load(conn, id)?.ok_or_else(|| not_found(id)))
    }

    /// Returns an already-created record only when it is bound to the same reviewed preview.
    /// This makes a retried `handoff_send` idempotent without accepting a substituted hash.
    pub fn get_if_preview(&self, id: &str, preview_hash: &str) -> Result<Option<HandoffRecord>> {
        validate_id(id)?;
        self.core.read(|conn| {
            let matches: bool = conn
                .query_row(
                    "SELECT preview_hash = ?2 FROM handoffs WHERE id = ?1",
                    params![id, preview_hash],
                    |row| row.get(0),
                )
                .optional()?
                .unwrap_or(false);
            if matches { load(conn, id) } else { Ok(None) }
        })
    }

    pub fn list(&self, thread_id: Option<&str>) -> Result<Vec<HandoffRecord>> {
        Ok(self
            .list_with_target_instances(thread_id)?
            .into_iter()
            .map(|(record, _)| record)
            .collect())
    }

    /// Open-record process identity stays native-only; it is used to reject replacement panes.
    pub fn list_with_target_instances(
        &self,
        thread_id: Option<&str>,
    ) -> Result<Vec<(HandoffRecord, String)>> {
        if let Some(id) = thread_id {
            validate_id(id)?;
        }
        self.core.read(|conn| {
            let sql = if thread_id.is_some() {
                format!(
                    "SELECT {RECORD_COLUMNS}, target_instance_id FROM handoffs
                     WHERE source_thread_id = ?1 OR target_thread_id = ?1
                     ORDER BY created_at DESC, id DESC LIMIT 500"
                )
            } else {
                format!(
                    "SELECT {RECORD_COLUMNS}, target_instance_id FROM handoffs
                     ORDER BY created_at DESC, id DESC LIMIT 500"
                )
            };
            let mut statement = conn.prepare(&sql)?;
            let rows = if let Some(id) = thread_id {
                statement.query_map([id], record_with_target_from_row)?
            } else {
                statement.query_map([], record_with_target_from_row)?
            };
            rows.collect::<std::result::Result<Vec<_>, _>>()
                .map_err(Into::into)
        })
    }

    /// Atomically claims the one allowed terminal delivery and any companion ContextPackage claim.
    /// `claim_context` runs in the same transaction and therefore before the pane writes a byte.
    pub fn claim_delivery(
        &self,
        id: &str,
        claim_context: impl FnOnce(&Transaction<'_>) -> Result<()>,
    ) -> Result<()> {
        validate_id(id)?;
        self.core.write_with_events(|tx| {
            let changed = tx.execute(
                "UPDATE handoffs SET delivery_state = 'dispatching', updated_at = ?2, blocker = NULL
                 WHERE id = ?1 AND status = 'queued' AND delivery_state = 'pending'",
                params![id, now_rfc3339()],
            )?;
            if changed != 1 {
                return Err(KalError::validation(
                    "handoff_delivery_already_claimed",
                    "This handoff has already been claimed or is no longer queued.",
                ));
            }
            claim_context(tx)?;
            Ok(((), vec![]))
        })?;
        Ok(())
    }

    pub fn finish_delivery(
        &self,
        id: &str,
        finish_context: impl FnOnce(&Transaction<'_>) -> Result<()>,
    ) -> Result<HandoffRecord> {
        validate_id(id)?;
        let now = now_rfc3339();
        let (record, _) = self.core.write_with_events(|tx| {
            let changed = tx.execute(
                "UPDATE handoffs
                    SET delivery_state = 'sent', status = 'delivered', delivered_at = ?2,
                        updated_at = ?2, blocker = NULL
                  WHERE id = ?1 AND status = 'queued' AND delivery_state = 'dispatching'",
                params![id, now],
            )?;
            if changed != 1 {
                return Err(invalid_state(
                    "Handoff delivery is not awaiting confirmation.",
                ));
            }
            finish_context(tx)?;
            Ok((load_required(tx, id)?, vec![]))
        })?;
        Ok(record)
    }

    pub fn fail_uncertain(
        &self,
        id: &str,
        blocker: &str,
        finish_context: impl FnOnce(&Transaction<'_>) -> Result<()>,
    ) -> Result<HandoffRecord> {
        validate_id(id)?;
        validate_text(blocker, MAX_BLOCKER_BYTES, "invalid_handoff_blocker")?;
        let now = now_rfc3339();
        let (record, _) = self.core.write_with_events(|tx| {
            let changed = tx.execute(
                "UPDATE handoffs
                    SET delivery_state = 'uncertain', status = 'interrupted', blocker = ?2,
                        updated_at = ?3, completed_at = ?3
                  WHERE id = ?1 AND status = 'queued' AND delivery_state = 'dispatching'",
                params![id, blocker, now],
            )?;
            if changed != 1 {
                return Err(invalid_state("Handoff delivery is not in progress."));
            }
            finish_context(tx)?;
            Ok((load_required(tx, id)?, vec![]))
        })?;
        Ok(record)
    }

    pub fn set_queue_blocker(&self, id: &str, blocker: Option<&str>) -> Result<HandoffRecord> {
        validate_id(id)?;
        if let Some(value) = blocker {
            validate_text(value, MAX_BLOCKER_BYTES, "invalid_handoff_blocker")?;
        }
        let (record, _) = self.core.write_with_events(|tx| {
            let changed = tx.execute(
                "UPDATE handoffs SET blocker = ?2, updated_at = ?3
                 WHERE id = ?1 AND status = 'queued' AND delivery_state = 'pending'
                   AND blocker IS NOT ?2",
                params![id, blocker, now_rfc3339()],
            )?;
            if changed == 0 {
                let pending: bool = tx
                    .query_row(
                        "SELECT status = 'queued' AND delivery_state = 'pending'
                     FROM handoffs WHERE id = ?1",
                        [id],
                        |row| row.get(0),
                    )
                    .optional()?
                    .unwrap_or(false);
                if pending {
                    return Ok((load_required(tx, id)?, vec![]));
                }
                return Err(invalid_state("Handoff is no longer queued."));
            }
            Ok((load_required(tx, id)?, vec![]))
        })?;
        Ok(record)
    }

    pub fn cancel(&self, id: &str) -> Result<HandoffRecord> {
        validate_id(id)?;
        let now = now_rfc3339();
        let (record, _) = self.core.write_with_events(|tx| {
            let changed = tx.execute(
                "UPDATE handoffs
                    SET status = 'cancelled', updated_at = ?2, completed_at = ?2,
                        blocker = 'Cancelled by the user.'
                  WHERE id = ?1 AND status = 'queued' AND delivery_state = 'pending'",
                params![id, now],
            )?;
            if changed != 1 {
                return Err(invalid_state(
                    "Only a queued handoff can be cancelled. Delivered work must be completed or failed explicitly.",
                ));
            }
            tx.execute(
                "UPDATE context_packages SET status = 'blocked'
                 WHERE id = (SELECT context_package_id FROM handoffs WHERE id = ?1)
                   AND status = 'previewed'",
                [id],
            )?;
            Ok((load_required(tx, id)?, vec![]))
        })?;
        Ok(record)
    }

    pub fn interrupt_pending(&self, id: &str, blocker: &str) -> Result<HandoffRecord> {
        validate_id(id)?;
        validate_text(blocker, MAX_BLOCKER_BYTES, "invalid_handoff_blocker")?;
        let now = now_rfc3339();
        let (record, _) = self.core.write_with_events(|tx| {
            let changed = tx.execute(
                "UPDATE handoffs
                    SET status = 'interrupted', blocker = ?2, updated_at = ?3, completed_at = ?3
                  WHERE id = ?1 AND status = 'queued' AND delivery_state = 'pending'",
                params![id, blocker, now],
            )?;
            if changed != 1 {
                return Err(invalid_state("Handoff is no longer waiting for delivery."));
            }
            tx.execute(
                "UPDATE context_packages SET status = 'blocked'
                 WHERE id = (SELECT context_package_id FROM handoffs WHERE id = ?1)
                   AND status = 'previewed'",
                [id],
            )?;
            Ok((load_required(tx, id)?, vec![]))
        })?;
        Ok(record)
    }

    pub fn interrupt_open(&self, id: &str, blocker: &str) -> Result<HandoffRecord> {
        validate_id(id)?;
        validate_text(blocker, MAX_BLOCKER_BYTES, "invalid_handoff_blocker")?;
        let now = now_rfc3339();
        let (record, _) = self.core.write_with_events(|tx| {
            let changed = tx.execute(
                "UPDATE handoffs
                    SET status = 'interrupted', blocker = ?2, updated_at = ?3, completed_at = ?3
                  WHERE id = ?1 AND status IN ('delivered', 'working', 'needs_you')
                    AND delivery_state = 'sent'",
                params![id, blocker, now],
            )?;
            if changed == 0 {
                return Ok((load_required(tx, id)?, vec![]));
            }
            Ok((load_required(tx, id)?, vec![]))
        })?;
        Ok(record)
    }

    pub fn complete(
        &self,
        id: &str,
        outcome: HandoffStatus,
        result: &str,
    ) -> Result<HandoffRecord> {
        validate_id(id)?;
        if !matches!(outcome, HandoffStatus::Completed | HandoffStatus::Failed) {
            return Err(KalError::validation(
                "invalid_handoff_outcome",
                "A handoff can only be completed or failed.",
            ));
        }
        validate_text(result, MAX_RESULT_BYTES, "invalid_handoff_result")?;
        let now = now_rfc3339();
        let (record, _) = self.core.write_with_events(|tx| {
            let changed = tx.execute(
                "UPDATE handoffs
                    SET status = ?2, result = ?3, blocker = NULL,
                        updated_at = ?4, completed_at = ?4
                  WHERE id = ?1 AND status IN ('delivered', 'working', 'needs_you')",
                params![id, outcome.as_str(), result, now],
            )?;
            if changed != 1 {
                return Err(invalid_state(
                    "Only a delivered, working, or waiting handoff can be completed.",
                ));
            }
            Ok((load_required(tx, id)?, vec![]))
        })?;
        Ok(record)
    }

    pub fn mark_working(&self, id: &str) -> Result<HandoffRecord> {
        self.transition_observed(id, "working")
    }

    pub fn mark_needs_you(&self, id: &str) -> Result<HandoffRecord> {
        self.transition_observed(id, "needs_you")
    }

    fn transition_observed(&self, id: &str, status: &str) -> Result<HandoffRecord> {
        validate_id(id)?;
        let (record, _) = self.core.write_with_events(|tx| {
            tx.execute(
                "UPDATE handoffs SET status = ?2, updated_at = ?3
                 WHERE id = ?1 AND status IN ('delivered', 'working', 'needs_you')
                   AND status <> ?2",
                params![id, status, now_rfc3339()],
            )?;
            Ok((load_required(tx, id)?, vec![]))
        })?;
        Ok(record)
    }

    /// Marks every process-local handoff as interrupted. No pending capsule is replayable afterward.
    pub fn recover_interrupted(&self) -> Result<usize> {
        let now = now_rfc3339();
        let (count, _) = self.core.write_with_events(|tx| {
            let count = tx.execute(
                "UPDATE handoffs
                    SET status = 'interrupted',
                        delivery_state = CASE
                          WHEN delivery_state = 'dispatching' THEN 'uncertain'
                          ELSE delivery_state
                        END,
                        blocker = 'KalCode restarted before this handoff was explicitly finished.',
                        updated_at = ?1,
                        completed_at = ?1
                  WHERE status IN ('queued', 'delivered', 'working', 'needs_you')",
                [&now],
            )?;
            tx.execute(
                "UPDATE context_packages SET status = 'blocked'
                 WHERE id IN (SELECT context_package_id FROM handoffs WHERE status = 'interrupted')
                   AND status = 'previewed'",
                [],
            )?;
            Ok((count, vec![]))
        })?;
        Ok(count)
    }
}

fn load(conn: &rusqlite::Connection, id: &str) -> Result<Option<HandoffRecord>> {
    let mut statement = conn.prepare(&format!(
        "SELECT {RECORD_COLUMNS} FROM handoffs WHERE id = ?1"
    ))?;
    statement
        .query_row([id], record_from_row)
        .optional()
        .map_err(Into::into)
}

fn load_required(conn: &rusqlite::Connection, id: &str) -> Result<HandoffRecord> {
    load(conn, id)?.ok_or_else(|| not_found(id))
}

fn record_from_row(row: &Row<'_>) -> rusqlite::Result<HandoffRecord> {
    let task: String = row.get(7)?;
    let status: String = row.get(8)?;
    Ok(HandoffRecord {
        id: row.get(0)?,
        source_thread_id: row.get(1)?,
        target_thread_id: row.get(2)?,
        source_workspace_id: row.get(3)?,
        target_workspace_id: row.get(4)?,
        source_name: row.get(5)?,
        target_name: row.get(6)?,
        task: parse_task(&task)?,
        status: parse_status(&status)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        result: row.get(11)?,
        blocker: row.get(12)?,
        source_commit: row.get(13)?,
        source_branch: row.get(14)?,
        return_of_id: row.get(15)?,
    })
}

fn record_with_target_from_row(row: &Row<'_>) -> rusqlite::Result<(HandoffRecord, String)> {
    Ok((record_from_row(row)?, row.get(16)?))
}

fn parse_task(value: &str) -> rusqlite::Result<HandoffTask> {
    match value {
        "review" => Ok(HandoffTask::Review),
        "test" => Ok(HandoffTask::Test),
        "fix" => Ok(HandoffTask::Fix),
        "continue" => Ok(HandoffTask::Continue),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}

fn parse_status(value: &str) -> rusqlite::Result<HandoffStatus> {
    match value {
        "queued" => Ok(HandoffStatus::Queued),
        "delivered" => Ok(HandoffStatus::Delivered),
        "working" => Ok(HandoffStatus::Working),
        "needs_you" => Ok(HandoffStatus::NeedsYou),
        "completed" => Ok(HandoffStatus::Completed),
        "failed" => Ok(HandoffStatus::Failed),
        "cancelled" => Ok(HandoffStatus::Cancelled),
        "interrupted" => Ok(HandoffStatus::Interrupted),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}

fn validate_new(input: &NewHandoff<'_>) -> Result<()> {
    for id in [
        input.id,
        input.context_package_id,
        input.source_thread_id,
        input.target_thread_id,
        input.source_workspace_id,
        input.target_workspace_id,
    ] {
        validate_id(id)?;
    }
    if let Some(id) = input.return_of_id {
        validate_id(id)?;
    }
    if input.source_thread_id == input.target_thread_id {
        return Err(KalError::validation(
            "handoff_same_thread",
            "Choose another coding agent for this handoff.",
        ));
    }
    validate_text(input.source_name, 200, "invalid_handoff_name")?;
    validate_text(input.target_name, 200, "invalid_handoff_name")?;
    validate_text(input.target_instance_id, 200, "invalid_handoff_instance")?;
    if input.preview_hash.len() != 64
        || !input
            .preview_hash
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(KalError::validation(
            "invalid_handoff_hash",
            "The handoff preview hash is invalid.",
        ));
    }
    Ok(())
}

fn validate_id(id: &str) -> Result<()> {
    uuid::Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| KalError::validation("invalid_handoff_id", "Invalid handoff identifier."))
}

fn validate_text(value: &str, max_bytes: usize, code: &'static str) -> Result<()> {
    if value.trim().is_empty() || value.len() > max_bytes || value.contains('\0') {
        return Err(KalError::validation(
            code,
            "Handoff text is empty or too long.",
        ));
    }
    Ok(())
}

fn not_found(id: &str) -> KalError {
    KalError::validation("handoff_not_found", format!("Handoff {id} was not found."))
}

fn invalid_state(message: &'static str) -> KalError {
    KalError::validation("invalid_handoff_state", message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flags::BuildChannel;
    use crate::{CoreConfig, Paths};

    fn core(temp: &tempfile::TempDir) -> Arc<Core> {
        Arc::new(
            Core::open(CoreConfig {
                paths: Paths::new(temp.path()),
                app_version: "0.1.9-test".into(),
                channel: BuildChannel::Development,
            })
            .expect("core"),
        )
    }

    fn seed_context(core: &Core, id: &str, hash: &str) {
        core.write_with_events(|tx| {
            tx.execute(
                "INSERT INTO context_packages
                 (id, workspace_id, purpose, target_thread_id, target_provider_id, status,
                  content_sha256, total_bytes, created_at, sent_at)
                 VALUES (?1, NULL, 'handoff', NULL, NULL, 'previewed', ?2, 10, ?3, NULL)",
                params![id, hash, now_rfc3339()],
            )?;
            Ok(((), vec![]))
        })
        .expect("seed context");
    }

    fn input<'a>(id: &'a str, hash: &'a str) -> NewHandoff<'a> {
        NewHandoff {
            id,
            context_package_id: id,
            source_thread_id: "10000000-0000-4000-8000-000000000001",
            target_thread_id: "10000000-0000-4000-8000-000000000002",
            source_workspace_id: "20000000-0000-4000-8000-000000000001",
            target_workspace_id: "20000000-0000-4000-8000-000000000001",
            source_name: "Claude A",
            target_name: "Codex A",
            task: HandoffTask::Review,
            target_instance_id: "pane-instance",
            preview_hash: hash,
            source_commit: Some("8506936"),
            source_branch: Some("feat/source"),
            source_dirty: true,
            return_of_id: None,
        }
    }

    #[test]
    fn one_shot_claim_and_explicit_completion_are_enforced() {
        let temp = tempfile::tempdir().expect("tempdir");
        let core = core(&temp);
        let store = HandoffStore::new(core.clone());
        let id = "30000000-0000-4000-8000-000000000001";
        let hash = "a".repeat(64);
        seed_context(&core, id, &hash);
        let record = store.create(&input(id, &hash)).expect("create");
        assert_eq!(record.status, HandoffStatus::Queued);
        assert_eq!(
            store
                .get_if_preview(id, &hash)
                .expect("idempotent lookup")
                .expect("record")
                .id,
            id
        );
        assert!(
            store
                .get_if_preview(id, &"c".repeat(64))
                .expect("mismatch lookup")
                .is_none()
        );

        store.claim_delivery(id, |_| Ok(())).expect("claim");
        assert!(store.claim_delivery(id, |_| Ok(())).is_err());
        let delivered = store.finish_delivery(id, |_| Ok(())).expect("sent");
        assert_eq!(delivered.status, HandoffStatus::Delivered);
        let completed = store
            .complete(id, HandoffStatus::Completed, "Review passed.")
            .expect("complete");
        assert_eq!(completed.status, HandoffStatus::Completed);
        assert!(store.cancel(id).is_err());
    }

    #[test]
    fn restart_interrupts_pending_without_storing_prompt_text() {
        let temp = tempfile::tempdir().expect("tempdir");
        let core = core(&temp);
        let store = HandoffStore::new(core.clone());
        let id = "30000000-0000-4000-8000-000000000002";
        let hash = "b".repeat(64);
        seed_context(&core, id, &hash);
        store.create(&input(id, &hash)).expect("create");
        assert_eq!(store.recover_interrupted().expect("recover"), 1);
        assert_eq!(
            store.get(id).expect("get").status,
            HandoffStatus::Interrupted
        );
        core.read(|conn| {
            let columns: Vec<String> = conn
                .prepare("PRAGMA table_info(handoffs)")?
                .query_map([], |row| row.get(1))?
                .collect::<std::result::Result<_, _>>()?;
            assert!(
                !columns
                    .iter()
                    .any(|name| name == "text" || name == "instructions")
            );
            Ok(())
        })
        .expect("inspect schema");
    }

    #[test]
    fn observed_working_needs_you_and_instance_end_never_imply_completion() {
        let temp = tempfile::tempdir().expect("tempdir");
        let core = core(&temp);
        let store = HandoffStore::new(core.clone());
        let id = "30000000-0000-4000-8000-000000000003";
        let hash = "d".repeat(64);
        seed_context(&core, id, &hash);
        store.create(&input(id, &hash)).expect("create");
        store.claim_delivery(id, |_| Ok(())).expect("claim");
        assert_eq!(
            store
                .finish_delivery(id, |_| Ok(()))
                .expect("delivered")
                .status,
            HandoffStatus::Delivered
        );
        assert_eq!(
            store.mark_working(id).expect("working").status,
            HandoffStatus::Working
        );
        assert_eq!(
            store.mark_needs_you(id).expect("needs you").status,
            HandoffStatus::NeedsYou
        );
        assert_eq!(
            store
                .interrupt_open(id, "The bound provider instance ended.")
                .expect("interrupted")
                .status,
            HandoffStatus::Interrupted
        );
    }
}
