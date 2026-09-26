//! Persistence for remembered ignores and the non-replayable fix journal.

use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use kalcode_contracts::events::{Correlation, EventPayload, EventSource, NewEvent};
use kalcode_contracts::ids::{is_valid_id, new_id};
use kalcode_core::{Core, ErrorCategory, KalError, Result};
use rusqlite::{Connection, OptionalExtension, Transaction, params};

use crate::DOCTOR_MIGRATION;
use crate::types::{
    DoctorRun, FixLogEntry, FixStatus, IgnoreScope, IgnoredFinding, IgnoredList, RunStatus,
};

pub enum Store {
    Core(Arc<Core>),
    Memory(Mutex<Connection>),
    #[doc(hidden)]
    Standalone(Mutex<Connection>),
}

#[derive(Debug, Clone)]
pub struct NewFixLog {
    pub run_id: String,
    pub finding_code: String,
    pub finding_version: String,
    pub fix_code: String,
    pub workspace_id: Option<String>,
    pub summary: String,
    pub target_ref: String,
    pub approval_id: Option<String>,
    pub undo_json: String,
}

#[derive(Debug, Clone)]
pub struct StoredFix {
    pub view: FixLogEntry,
    pub run_id: String,
    pub finding_version: String,
    pub target_ref: String,
    pub undo_json: String,
}

pub fn has_schema(conn: &Connection) -> Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_master
         WHERE type = 'table'
           AND name IN (
             'doctor_ignores', 'doctor_runs', 'doctor_fix_log', 'doctor_approval_claims'
           )",
        [],
        |row| row.get(0),
    )?;
    Ok(count == 4)
}

impl Store {
    pub fn open(core: &Arc<Core>) -> Result<Self> {
        if has_schema(&core.reader())? {
            Ok(Self::Core(Arc::clone(core)))
        } else {
            tracing::warn!(
                event = "doctor.session_only_store",
                "schema v16 is not installed; Doctor history lasts for this session"
            );
            Self::memory()
        }
    }

    pub fn memory() -> Result<Self> {
        let conn = kalcode_core::db::open_in_memory()?;
        conn.execute_batch(DOCTOR_MIGRATION.sql)?;
        Ok(Self::Memory(Mutex::new(conn)))
    }

    /// A file-backed store used by migration/restart certification without touching owner data.
    #[doc(hidden)]
    pub fn standalone(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        if !has_schema(&conn)? {
            conn.execute_batch(DOCTOR_MIGRATION.sql)?;
        }
        Ok(Self::Standalone(Mutex::new(conn)))
    }

    pub fn persistent(&self) -> bool {
        matches!(self, Self::Core(_) | Self::Standalone(_))
    }

    fn locked(conn: &Mutex<Connection>) -> MutexGuard<'_, Connection> {
        conn.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn read<T>(&self, read: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        match self {
            Self::Core(core) => read(&core.reader()),
            Self::Memory(conn) | Self::Standalone(conn) => read(&Self::locked(conn)),
        }
    }

    fn write<T>(&self, write: impl FnOnce(&Transaction<'_>) -> Result<T>) -> Result<T> {
        self.write_events(|tx| Ok((write(tx)?, Vec::new())))
    }

    fn write_events<T>(
        &self,
        write: impl FnOnce(&Transaction<'_>) -> Result<(T, Vec<NewEvent>)>,
    ) -> Result<T> {
        match self {
            Self::Core(core) => core.write_with_events(write).map(|(value, _)| value),
            Self::Memory(conn) | Self::Standalone(conn) => {
                let mut conn = Self::locked(conn);
                let tx = conn.transaction()?;
                let (value, _events) = write(&tx)?;
                tx.commit()?;
                Ok(value)
            }
        }
    }

    pub fn set_ignore(
        &self,
        finding_code: &str,
        scope: &IgnoreScope,
        title: &str,
        ignored: bool,
    ) -> Result<()> {
        validate_code(finding_code, 128, "finding")?;
        validate_scope(scope)?;
        let title = crate::checks::clean(title, 200);
        let now = kalcode_core::time::now_rfc3339();
        self.write_events(|tx| {
            if ignored {
                tx.execute(
                    "INSERT INTO doctor_ignores
                       (finding_code, scope_kind, scope_id, title, ignored_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT(finding_code, scope_kind, scope_id)
                     DO UPDATE SET title = excluded.title, ignored_at = excluded.ignored_at",
                    params![finding_code, scope.kind(), scope.id(), title, now],
                )?;
            } else {
                tx.execute(
                    "DELETE FROM doctor_ignores
                     WHERE finding_code = ?1 AND scope_kind = ?2 AND scope_id = ?3",
                    params![finding_code, scope.kind(), scope.id()],
                )?;
            }
            let event = if ignored {
                EventPayload::DoctorFindingIgnored {
                    finding_code: finding_code.to_owned(),
                    scope_kind: scope.kind().to_owned(),
                }
            } else {
                EventPayload::DoctorFindingUnignored {
                    finding_code: finding_code.to_owned(),
                    scope_kind: scope.kind().to_owned(),
                }
            };
            Ok((
                (),
                vec![doctor_event(
                    match scope {
                        IgnoreScope::Global => None,
                        IgnoreScope::Workspace { workspace_id } => Some(workspace_id),
                    },
                    event,
                )],
            ))
        })
    }

    pub fn ignored_scope(
        &self,
        finding_code: &str,
        workspace_id: Option<&str>,
    ) -> Result<Option<IgnoreScope>> {
        validate_code(finding_code, 128, "finding")?;
        if let Some(id) = workspace_id
            && !is_valid_id(id)
        {
            return Err(invalid_id("workspace"));
        }
        self.read(|conn| {
            if let Some(id) = workspace_id {
                let found: Option<String> = conn
                    .query_row(
                        "SELECT scope_id FROM doctor_ignores
                         WHERE finding_code = ?1 AND scope_kind = 'workspace' AND scope_id = ?2",
                        params![finding_code, id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if let Some(workspace_id) = found {
                    return Ok(Some(IgnoreScope::Workspace { workspace_id }));
                }
            }
            let global: Option<i64> = conn
                .query_row(
                    "SELECT 1 FROM doctor_ignores
                     WHERE finding_code = ?1 AND scope_kind = 'global' AND scope_id = ''",
                    [finding_code],
                    |row| row.get(0),
                )
                .optional()?;
            Ok(global.map(|_| IgnoreScope::Global))
        })
    }

    pub fn ignored(&self) -> Result<IgnoredList> {
        self.read(|conn| {
            let mut statement = conn.prepare(
                "SELECT finding_code, scope_kind, scope_id, title, ignored_at
                 FROM doctor_ignores ORDER BY ignored_at DESC, finding_code ASC",
            )?;
            let rows = statement.query_map([], |row| {
                let kind: String = row.get(1)?;
                let id: String = row.get(2)?;
                Ok(IgnoredFinding {
                    finding_code: row.get(0)?,
                    scope: if kind == "workspace" {
                        IgnoreScope::Workspace { workspace_id: id }
                    } else {
                        IgnoreScope::Global
                    },
                    workspace_name: None,
                    title: row.get(3)?,
                    ignored_at: row.get(4)?,
                })
            })?;
            let items = rows.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(IgnoredList {
                items,
                persistent: self.persistent(),
            })
        })
    }

    pub fn save_run(&self, run: &DoctorRun) -> Result<()> {
        let status = match run.status {
            RunStatus::Completed => "completed",
            RunStatus::Cancelled => "cancelled",
            RunStatus::Running => {
                return Err(KalError::validation(
                    "run_not_finished",
                    "Only completed diagnostic runs can be saved.",
                ));
            }
        };
        if !is_valid_id(&run.id) {
            return Err(invalid_id("run"));
        }
        if let Some(workspace_id) = run.workspace_id.as_deref()
            && !is_valid_id(workspace_id)
        {
            return Err(invalid_id("workspace"));
        }
        let finished_at = run.finished_at.as_deref().ok_or_else(|| {
            KalError::validation("run_not_finished", "The diagnostic run is incomplete.")
        })?;
        let snapshot = serde_json::to_string(run).map_err(|_| {
            KalError::internal(
                "run_encode_failed",
                "The diagnostic result could not be saved.",
            )
        })?;
        if snapshot.len() > 2_000_000 {
            return Err(KalError::validation(
                "run_too_large",
                "The diagnostic result is too large to save.",
            ));
        }
        let stored_at = kalcode_core::time::now_rfc3339();
        self.write_events(|tx| {
            tx.execute(
                "INSERT INTO doctor_runs
                   (id, workspace_id, status, snapshot, started_at, finished_at, stored_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    run.id,
                    run.workspace_id,
                    status,
                    snapshot,
                    run.started_at,
                    finished_at,
                    stored_at
                ],
            )?;
            // Bounded local history. Fix evidence has its own journal and is never pruned here.
            tx.execute(
                "DELETE FROM doctor_runs WHERE id IN (
                   SELECT id FROM doctor_runs
                   ORDER BY finished_at DESC, id DESC LIMIT -1 OFFSET 100
                 )",
                [],
            )?;
            Ok((
                (),
                vec![doctor_event(
                    run.workspace_id.as_deref(),
                    EventPayload::DoctorRunCompleted {
                        run_id: run.id.clone(),
                        checks: u32::try_from(run.checks.len()).unwrap_or(u32::MAX),
                        critical: run.counts.critical,
                        warning: run.counts.warning,
                        info: run.counts.info,
                        could_not_check: run.counts.could_not_check,
                        ignored: run.counts.ignored,
                        cancelled: run.status == RunStatus::Cancelled,
                    },
                )],
            ))
        })
    }

    pub fn latest_run(&self) -> Result<Option<DoctorRun>> {
        self.read(|conn| {
            let encoded: Option<(String, String)> = conn
                .query_row(
                    "SELECT status, snapshot FROM doctor_runs
                     ORDER BY finished_at DESC, id DESC LIMIT 1",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            encoded
                .map(|(status, encoded)| {
                    let run: DoctorRun = serde_json::from_str(&encoded).map_err(|_| {
                        KalError::new(
                            ErrorCategory::Database,
                            "doctor_history_invalid",
                            "Environment Doctor history is damaged.",
                        )
                    })?;
                    let expected = match run.status {
                        RunStatus::Completed => "completed",
                        RunStatus::Cancelled => "cancelled",
                        RunStatus::Running => "running",
                    };
                    if expected != status
                        || run.finished_at.is_none()
                        || !is_valid_id(&run.id)
                        || run
                            .workspace_id
                            .as_deref()
                            .is_some_and(|id| !is_valid_id(id))
                    {
                        return Err(KalError::new(
                            ErrorCategory::Database,
                            "doctor_history_invalid",
                            "Environment Doctor history is damaged.",
                        ));
                    }
                    Ok(run)
                })
                .transpose()
        })
    }

    pub fn reserve_fix(&self, fix: &NewFixLog) -> Result<String> {
        validate_fix(fix)?;
        let id = new_id();
        let now = kalcode_core::time::now_rfc3339();
        self.write(|tx| {
            let already: Option<i64> = tx
                .query_row(
                    "SELECT 1 FROM doctor_fix_log
                     WHERE run_id = ?1 AND finding_code = ?2
                       AND finding_version = ?3 AND fix_code = ?4
                     LIMIT 1",
                    params![
                        fix.run_id,
                        fix.finding_code,
                        fix.finding_version,
                        fix.fix_code
                    ],
                    |row| row.get(0),
                )
                .optional()?;
            let approval_used = match fix.approval_id.as_deref() {
                Some(approval_id) => tx
                    .query_row(
                        "SELECT 1 FROM doctor_approval_claims WHERE approval_id = ?1",
                        [approval_id],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()?
                    .is_some(),
                None => false,
            };
            if already.is_some() || approval_used {
                return Err(KalError::new(
                    ErrorCategory::Permission,
                    "fix_replayed",
                    "That exact fix request was already used.",
                ));
            }
            tx.execute(
                "INSERT INTO doctor_fix_log
                   (id, run_id, finding_code, finding_version, fix_code, workspace_id,
                    summary, target_ref, status, undo, approval_id, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'applying', ?9, ?10, ?11)",
                params![
                    id,
                    fix.run_id,
                    fix.finding_code,
                    fix.finding_version,
                    fix.fix_code,
                    fix.workspace_id,
                    fix.summary,
                    fix.target_ref,
                    fix.undo_json,
                    fix.approval_id,
                    now
                ],
            )?;
            if let Some(approval_id) = fix.approval_id.as_deref() {
                tx.execute(
                    "INSERT INTO doctor_approval_claims
                       (approval_id, fix_log_id, phase, claimed_at)
                     VALUES (?1, ?2, 'apply', ?3)",
                    params![approval_id, id, now],
                )?;
            }
            Ok(id.clone())
        })
    }

    pub fn approval_claimed(&self, approval_id: &str) -> Result<bool> {
        if !is_valid_id(approval_id) {
            return Err(invalid_id("approval"));
        }
        self.read(|connection| {
            Ok(connection
                .query_row(
                    "SELECT 1 FROM doctor_approval_claims WHERE approval_id = ?1",
                    [approval_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .is_some())
        })
    }

    pub fn mark_applied(&self, id: &str) -> Result<()> {
        self.set_status(id, "applying", "applied", None, true)
    }

    pub fn mark_failed(&self, id: &str, code: &str) -> Result<()> {
        validate_code(code, 64, "error")?;
        self.set_status(id, "applying", "failed", Some(code), false)
    }

    pub fn begin_revert(&self, id: &str, approval_id: Option<&str>) -> Result<()> {
        if !is_valid_id(id) {
            return Err(invalid_id("fix log"));
        }
        if let Some(approval_id) = approval_id
            && !is_valid_id(approval_id)
        {
            return Err(invalid_id("approval"));
        }
        self.write(|tx| {
            if let Some(approval_id) = approval_id {
                let used: Option<i64> = tx
                    .query_row(
                        "SELECT 1 FROM doctor_approval_claims WHERE approval_id = ?1",
                        [approval_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if used.is_some() {
                    return Err(KalError::new(
                        ErrorCategory::Permission,
                        "fix_replayed",
                        "That exact fix approval was already used.",
                    ));
                }
            }
            if tx.execute(
                "UPDATE doctor_fix_log
                 SET status = 'reverting', revert_approval_id = ?2, error = NULL
                 WHERE id = ?1 AND status = 'applied'",
                params![id, approval_id],
            )? != 1
            {
                return Err(KalError::new(
                    ErrorCategory::Verification,
                    "fix_state_changed",
                    "The fix is no longer in the expected state.",
                ));
            }
            if let Some(approval_id) = approval_id {
                tx.execute(
                    "INSERT INTO doctor_approval_claims
                       (approval_id, fix_log_id, phase, claimed_at)
                     VALUES (?1, ?2, 'revert', ?3)",
                    params![approval_id, id, kalcode_core::time::now_rfc3339()],
                )?;
            }
            Ok(())
        })
    }

    pub fn mark_reverted(&self, id: &str) -> Result<()> {
        self.set_status(id, "reverting", "reverted", None, false)
    }

    pub fn mark_interrupted_failed(&self, id: &str, from: FixStatus, code: &str) -> Result<()> {
        validate_code(code, 64, "error")?;
        let from = match from {
            FixStatus::Applying => "applying",
            FixStatus::Reverting => "reverting",
            _ => {
                return Err(KalError::validation(
                    "invalid_fix_state",
                    "Only interrupted changes can be reconciled.",
                ));
            }
        };
        self.set_status(id, from, "failed", Some(code), false)
    }

    pub fn restore_applied_after_interrupted_revert(&self, id: &str) -> Result<()> {
        if !is_valid_id(id) {
            return Err(invalid_id("fix log"));
        }
        self.write(|tx| {
            if tx.execute(
                "UPDATE doctor_fix_log
                 SET status = 'applied', error = 'undo_interrupted_retryable',
                     revert_approval_id = NULL
                 WHERE id = ?1 AND status = 'reverting'",
                [id],
            )? != 1
            {
                return Err(KalError::new(
                    ErrorCategory::Verification,
                    "fix_state_changed",
                    "The fix is no longer in the expected state.",
                ));
            }
            Ok(())
        })
    }

    fn set_status(
        &self,
        id: &str,
        from: &str,
        to: &str,
        error: Option<&str>,
        applied: bool,
    ) -> Result<()> {
        if !is_valid_id(id) {
            return Err(invalid_id("fix log"));
        }
        let now = kalcode_core::time::now_rfc3339();
        self.write_events(|tx| {
            let changed = if applied {
                tx.execute(
                    "UPDATE doctor_fix_log
                     SET status = ?2, error = ?3, applied_at = ?4
                     WHERE id = ?1 AND status = ?5",
                    params![id, to, error, now, from],
                )?
            } else if to == "reverted" {
                tx.execute(
                    "UPDATE doctor_fix_log
                     SET status = ?2, error = ?3, reverted_at = ?4
                     WHERE id = ?1 AND status = ?5",
                    params![id, to, error, now, from],
                )?
            } else {
                tx.execute(
                    "UPDATE doctor_fix_log SET status = ?2, error = ?3
                     WHERE id = ?1 AND status = ?4",
                    params![id, to, error, from],
                )?
            };
            if changed != 1 {
                return Err(KalError::new(
                    ErrorCategory::Verification,
                    "fix_state_changed",
                    "The fix is no longer in the expected state.",
                ));
            }
            let row: (String, String, String, Option<String>) = tx.query_row(
                "SELECT run_id, finding_code, fix_code, workspace_id
                 FROM doctor_fix_log WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            let event = match to {
                "applied" => EventPayload::DoctorFixApplied {
                    run_id: Some(row.0),
                    finding_code: row.1,
                    fix_code: row.2,
                },
                "failed" => EventPayload::DoctorFixFailed {
                    run_id: Some(row.0),
                    finding_code: row.1,
                    fix_code: row.2,
                    code: error.unwrap_or("fix_failed").to_owned(),
                },
                "reverted" => EventPayload::DoctorFixReverted {
                    run_id: Some(row.0),
                    finding_code: row.1,
                    fix_code: row.2,
                },
                _ => return Ok(((), Vec::new())),
            };
            Ok(((), vec![doctor_event(row.3.as_deref(), event)]))
        })
    }

    pub fn fix(&self, id: &str) -> Result<Option<StoredFix>> {
        if !is_valid_id(id) {
            return Err(invalid_id("fix log"));
        }
        self.read(|conn| {
            conn.query_row(
                "SELECT id, run_id, finding_code, finding_version, fix_code, workspace_id,
                        summary, target_ref, status, undo, approval_id, error,
                        created_at, applied_at, reverted_at
                 FROM doctor_fix_log WHERE id = ?1",
                [id],
                row_fix,
            )
            .optional()
            .map_err(Into::into)
        })
    }

    pub fn fixes(&self, limit: usize) -> Result<Vec<FixLogEntry>> {
        let limit = i64::try_from(limit.clamp(1, 500)).unwrap_or(500);
        self.read(|conn| {
            let mut statement = conn.prepare(
                "SELECT id, run_id, finding_code, finding_version, fix_code, workspace_id,
                        summary, target_ref, status, undo, approval_id, error,
                        created_at, applied_at, reverted_at
                 FROM doctor_fix_log ORDER BY created_at DESC LIMIT ?1",
            )?;
            let rows = statement.query_map([limit], row_fix)?;
            Ok(rows
                .collect::<rusqlite::Result<Vec<_>>>()?
                .into_iter()
                .map(|fix| fix.view)
                .collect())
        })
    }

    pub fn interrupted(&self, workspace_id: &str) -> Result<Vec<StoredFix>> {
        if !is_valid_id(workspace_id) {
            return Err(invalid_id("workspace"));
        }
        self.read(|conn| {
            let mut statement = conn.prepare(
                "SELECT id, run_id, finding_code, finding_version, fix_code, workspace_id,
                        summary, target_ref, status, undo, approval_id, error,
                        created_at, applied_at, reverted_at
                 FROM doctor_fix_log
                 WHERE workspace_id = ?1 AND status IN ('applying', 'reverting')
                 ORDER BY created_at ASC",
            )?;
            let rows = statement.query_map([workspace_id], row_fix)?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }
}

fn row_fix(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredFix> {
    let status: String = row.get(8)?;
    let status = match status.as_str() {
        "applying" => FixStatus::Applying,
        "applied" => FixStatus::Applied,
        "reverting" => FixStatus::Reverting,
        "reverted" => FixStatus::Reverted,
        _ => FixStatus::Failed,
    };
    Ok(StoredFix {
        view: FixLogEntry {
            id: Some(row.get(0)?),
            finding_code: row.get(2)?,
            fix_code: row.get(4)?,
            workspace_id: row.get(5)?,
            summary: row.get(6)?,
            status,
            approval_id: row.get(10)?,
            applied_at: row.get(13)?,
            reverted_at: row.get(14)?,
            can_undo: status == FixStatus::Applied,
            error: row.get(11)?,
        },
        run_id: row.get(1)?,
        finding_version: row.get(3)?,
        target_ref: row.get(7)?,
        undo_json: row.get(9)?,
    })
}

fn validate_fix(fix: &NewFixLog) -> Result<()> {
    for (id, what) in [
        (&fix.run_id, "run"),
        (&fix.finding_version, "finding version"),
    ] {
        if !is_valid_id(id) {
            return Err(invalid_id(what));
        }
    }
    if let Some(id) = &fix.workspace_id
        && !is_valid_id(id)
    {
        return Err(invalid_id("workspace"));
    }
    if let Some(id) = &fix.approval_id
        && !is_valid_id(id)
    {
        return Err(invalid_id("approval"));
    }
    validate_code(&fix.finding_code, 128, "finding")?;
    validate_code(&fix.fix_code, 64, "fix")?;
    if fix.summary.is_empty()
        || fix.summary.len() > 300
        || fix.target_ref.is_empty()
        || fix.target_ref.len() > 200
    {
        return Err(KalError::validation(
            "invalid_fix",
            "The fix description is invalid.",
        ));
    }
    if fix.undo_json.len() > 600_000
        || serde_json::from_str::<serde_json::Value>(&fix.undo_json).is_err()
    {
        return Err(KalError::validation(
            "invalid_undo",
            "The fix cannot be undone safely.",
        ));
    }
    Ok(())
}

fn validate_scope(scope: &IgnoreScope) -> Result<()> {
    if let IgnoreScope::Workspace { workspace_id } = scope
        && !is_valid_id(workspace_id)
    {
        return Err(invalid_id("workspace"));
    }
    Ok(())
}

fn validate_code(code: &str, max: usize, what: &str) -> Result<()> {
    if code.is_empty()
        || code.len() > max
        || !code
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "._-".contains(c))
    {
        return Err(KalError::validation(
            "invalid_code",
            format!("That {what} code is invalid."),
        ));
    }
    Ok(())
}

fn invalid_id(what: &str) -> KalError {
    KalError::validation("invalid_id", format!("That {what} id is invalid."))
}

fn doctor_event(workspace_id: Option<&str>, event: EventPayload) -> NewEvent {
    NewEvent {
        source: EventSource::Core,
        correlation: Correlation {
            workspace_id: workspace_id.map(str::to_owned),
            ..Correlation::default()
        },
        event,
    }
}
