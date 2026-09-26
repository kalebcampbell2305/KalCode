use std::sync::Arc;

use kalcode_contracts::ids::is_valid_id;
use kalcode_core::{Core, ErrorCategory, KalError, Result};
use rusqlite::{Connection, OptionalExtension, Transaction, params};

use crate::types::{
    EffectsState, EvidenceOutcome, MAX_EVIDENCE_JSON_BYTES, MAX_PLAN_JSON_BYTES, NewReplayRun,
    NewRestoreOperation, OperationEvidence, OperationStage, RecoveryReport, ReplayPlanSummary,
    ReplayRun, ReplayStatus, RestoreKind, RestoreOperation, RestorePlanSummary, RestoreStatus,
    SCHEMA_VERSION, StartOutcome,
};

const RESTORE_COLUMNS: &str = "id, schema_version, workspace_id, checkpoint_id, kind,
    plan_fingerprint, plan_summary, expires_at, safety_checkpoint_id, status,
    recovery_required, planned_at, started_at, finished_at, evidence, error_code";
const REPLAY_COLUMNS: &str = "id, schema_version, workspace_id, checkpoint_id, from_seq, to_seq,
    steps_total, steps_done, plan_fingerprint, plan_summary, expires_at, safety_checkpoint_id,
    status, recovery_required, planned_at, started_at, finished_at, evidence, error_code";

#[derive(Clone)]
pub struct TimelineStore {
    core: Arc<Core>,
}

impl TimelineStore {
    pub fn open(core: Arc<Core>) -> Result<Self> {
        let ready = core.read(has_schema)?;
        if !ready {
            return Err(KalError::new(
                ErrorCategory::Database,
                "timeline_schema_missing",
                "Time Machine storage is unavailable until the database upgrade completes.",
            ));
        }
        Ok(Self { core })
    }

    pub fn plan_restore(&self, new: &NewRestoreOperation) -> Result<RestoreOperation> {
        validate_new_restore(new)?;
        let summary = encode_plan(&new.plan_summary)?;
        let now = kalcode_core::time::now_rfc3339();
        validate_expiry(&new.expires_at, &now)?;
        self.write(|tx| {
            require_checkpoint(tx, &new.workspace_id, &new.checkpoint_id, "checkpoint_unavailable")?;
            tx.execute(
                "INSERT INTO restore_operations
                   (id, schema_version, workspace_id, checkpoint_id, kind, plan_fingerprint,
                    plan_summary, approval_binding_digest, expires_at, safety_checkpoint_id,
                    status, recovery_required, planned_at, started_at, finished_at, evidence, error_code)
                 VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL,
                         'planned', 0, ?9, NULL, NULL, NULL, NULL)",
                params![
                    new.id,
                    new.workspace_id,
                    new.checkpoint_id,
                    new.kind.as_str(),
                    new.plan_fingerprint,
                    summary,
                    new.approval_binding_digest,
                    new.expires_at,
                    now
                ],
            )?;
            get_restore_in(tx, &new.id)
        })
    }

    pub fn plan_replay(&self, new: &NewReplayRun) -> Result<ReplayRun> {
        validate_new_replay(new)?;
        let summary = encode_plan(&new.plan_summary)?;
        let now = kalcode_core::time::now_rfc3339();
        validate_expiry(&new.expires_at, &now)?;
        self.write(|tx| {
            require_checkpoint(
                tx,
                &new.workspace_id,
                &new.checkpoint_id,
                "checkpoint_unavailable",
            )?;
            tx.execute(
                "INSERT INTO replay_runs
                   (id, schema_version, workspace_id, checkpoint_id, from_seq, to_seq,
                    steps_total, steps_done, plan_fingerprint, plan_summary,
                    approval_binding_digest, expires_at, safety_checkpoint_id, status,
                    recovery_required, planned_at, started_at, finished_at, evidence, error_code)
                 VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9, ?10, NULL,
                         'planned', 0, ?11, NULL, NULL, NULL, NULL)",
                params![
                    new.id,
                    new.workspace_id,
                    new.checkpoint_id,
                    new.from_seq,
                    new.to_seq,
                    i64::from(new.steps_total),
                    new.plan_fingerprint,
                    summary,
                    new.approval_binding_digest,
                    new.expires_at,
                    now
                ],
            )?;
            get_replay_in(tx, &new.id)
        })
    }

    pub fn restore(&self, id: &str) -> Result<RestoreOperation> {
        validate_id(id, "operation")?;
        self.core.read(|conn| get_restore_in(conn, id))
    }

    pub fn replay(&self, id: &str) -> Result<ReplayRun> {
        validate_id(id, "replay")?;
        self.core.read(|conn| get_replay_in(conn, id))
    }

    pub fn start_restore(
        &self,
        id: &str,
        approval_binding_digest: &str,
        safety_checkpoint_id: Option<&str>,
    ) -> Result<StartOutcome<RestoreOperation>> {
        validate_id(id, "operation")?;
        validate_digest(approval_binding_digest, "approval_binding")?;
        if let Some(safety) = safety_checkpoint_id {
            validate_id(safety, "safety_checkpoint")?;
        }
        let now = kalcode_core::time::now_rfc3339();
        self.write(|tx| {
            let authority = restore_authority(tx, id, approval_binding_digest)?;
            if authority.status != RestoreStatus::Planned {
                return Err(not_runnable());
            }
            if authority.expires_at <= now {
                let evidence = expiry_evidence(EvidenceOutcome::Cancelled);
                terminal_restore(
                    tx,
                    TerminalUpdate {
                        id,
                        digest: approval_binding_digest,
                        status: RestoreStatus::Cancelled,
                        evidence: &evidence,
                        error_code: Some("plan_expired"),
                        recovery_required: false,
                        now: &now,
                    },
                )?;
                return Ok(StartOutcome::Expired(get_restore_in(tx, id)?));
            }
            require_checkpoint(
                tx,
                &authority.workspace_id,
                &authority.checkpoint_id,
                "checkpoint_unavailable",
            )?;
            if authority.kind.destructive() && safety_checkpoint_id.is_none() {
                return Err(KalError::validation(
                    "safety_checkpoint_required",
                    "A safety checkpoint is required before this restore can start.",
                ));
            }
            if let Some(safety) = safety_checkpoint_id {
                if safety == authority.checkpoint_id {
                    return Err(KalError::validation(
                        "safety_checkpoint_invalid",
                        "The safety checkpoint must be distinct from the restore checkpoint.",
                    ));
                }
                require_checkpoint(tx, &authority.workspace_id, safety, "safety_checkpoint_unavailable")?;
            }
            let changed = tx.execute(
                "UPDATE restore_operations
                 SET status = 'running', safety_checkpoint_id = ?3, started_at = ?4
                 WHERE id = ?1 AND approval_binding_digest = ?2 AND status = 'planned' AND expires_at > ?4",
                params![id, approval_binding_digest, safety_checkpoint_id, now],
            )?;
            require_cas(changed)?;
            Ok(StartOutcome::Started(get_restore_in(tx, id)?))
        })
    }

    pub fn start_replay(
        &self,
        id: &str,
        approval_binding_digest: &str,
        safety_checkpoint_id: &str,
    ) -> Result<StartOutcome<ReplayRun>> {
        validate_id(id, "replay")?;
        validate_digest(approval_binding_digest, "approval_binding")?;
        validate_id(safety_checkpoint_id, "safety_checkpoint")?;
        let now = kalcode_core::time::now_rfc3339();
        self.write(|tx| {
            let authority = replay_authority(tx, id, approval_binding_digest)?;
            if authority.status != ReplayStatus::Planned {
                return Err(not_runnable());
            }
            if authority.expires_at <= now {
                let evidence = expiry_evidence(EvidenceOutcome::Stopped);
                terminal_replay(
                    tx,
                    TerminalUpdate {
                        id,
                        digest: approval_binding_digest,
                        status: ReplayStatus::Stopped,
                        evidence: &evidence,
                        error_code: Some("plan_expired"),
                        recovery_required: false,
                        now: &now,
                    },
                )?;
                return Ok(StartOutcome::Expired(get_replay_in(tx, id)?));
            }
            require_checkpoint(
                tx,
                &authority.workspace_id,
                &authority.checkpoint_id,
                "checkpoint_unavailable",
            )?;
            if safety_checkpoint_id == authority.checkpoint_id {
                return Err(KalError::validation(
                    "safety_checkpoint_invalid",
                    "The safety checkpoint must be distinct from the replay checkpoint.",
                ));
            }
            require_checkpoint(
                tx,
                &authority.workspace_id,
                safety_checkpoint_id,
                "safety_checkpoint_unavailable",
            )?;
            let changed = tx.execute(
                "UPDATE replay_runs
                 SET status = 'running', safety_checkpoint_id = ?3, started_at = ?4
                 WHERE id = ?1 AND approval_binding_digest = ?2 AND status = 'planned' AND expires_at > ?4",
                params![id, approval_binding_digest, safety_checkpoint_id, now],
            )?;
            require_cas(changed)?;
            Ok(StartOutcome::Started(get_replay_in(tx, id)?))
        })
    }

    pub fn advance_replay(
        &self,
        id: &str,
        approval_binding_digest: &str,
        expected_done: u32,
        next_done: u32,
    ) -> Result<ReplayRun> {
        validate_id(id, "replay")?;
        validate_digest(approval_binding_digest, "approval_binding")?;
        if next_done <= expected_done {
            return Err(KalError::validation(
                "replay_progress_invalid",
                "Replay progress must move forward.",
            ));
        }
        self.write(|tx| {
            let changed = tx.execute(
                "UPDATE replay_runs SET steps_done = ?4
                 WHERE id = ?1 AND approval_binding_digest = ?2 AND status = 'running'
                   AND steps_done = ?3 AND ?4 <= steps_total",
                params![
                    id,
                    approval_binding_digest,
                    i64::from(expected_done),
                    i64::from(next_done)
                ],
            )?;
            require_cas(changed)?;
            get_replay_in(tx, id)
        })
    }

    pub fn complete_restore(
        &self,
        id: &str,
        approval_binding_digest: &str,
        evidence: &OperationEvidence,
    ) -> Result<RestoreOperation> {
        require_outcome(evidence, EvidenceOutcome::Completed)?;
        self.finish_restore(
            id,
            approval_binding_digest,
            RestoreStatus::Completed,
            evidence,
            None,
            false,
        )
    }

    pub fn fail_restore(
        &self,
        id: &str,
        approval_binding_digest: &str,
        error_code: &str,
        recovery_required: bool,
        evidence: &OperationEvidence,
    ) -> Result<RestoreOperation> {
        require_outcome(evidence, EvidenceOutcome::Failed)?;
        validate_error_code(error_code)?;
        self.finish_restore(
            id,
            approval_binding_digest,
            RestoreStatus::Failed,
            evidence,
            Some(error_code),
            recovery_required,
        )
    }

    pub fn cancel_restore(
        &self,
        id: &str,
        approval_binding_digest: &str,
        evidence: &OperationEvidence,
    ) -> Result<RestoreOperation> {
        require_outcome(evidence, EvidenceOutcome::Cancelled)?;
        self.finish_restore(
            id,
            approval_binding_digest,
            RestoreStatus::Cancelled,
            evidence,
            None,
            false,
        )
    }

    pub fn complete_replay(
        &self,
        id: &str,
        approval_binding_digest: &str,
        evidence: &OperationEvidence,
    ) -> Result<ReplayRun> {
        require_outcome(evidence, EvidenceOutcome::Completed)?;
        self.finish_replay(
            id,
            approval_binding_digest,
            ReplayStatus::Completed,
            evidence,
            None,
            false,
        )
    }

    pub fn fail_replay(
        &self,
        id: &str,
        approval_binding_digest: &str,
        error_code: &str,
        recovery_required: bool,
        evidence: &OperationEvidence,
    ) -> Result<ReplayRun> {
        require_outcome(evidence, EvidenceOutcome::Failed)?;
        validate_error_code(error_code)?;
        self.finish_replay(
            id,
            approval_binding_digest,
            ReplayStatus::Failed,
            evidence,
            Some(error_code),
            recovery_required,
        )
    }

    pub fn stop_replay(
        &self,
        id: &str,
        approval_binding_digest: &str,
        evidence: &OperationEvidence,
    ) -> Result<ReplayRun> {
        require_outcome(evidence, EvidenceOutcome::Stopped)?;
        self.finish_replay(
            id,
            approval_binding_digest,
            ReplayStatus::Stopped,
            evidence,
            None,
            false,
        )
    }

    /// Atomically classifies work left running by a previous process. This persists evidence and
    /// a recovery requirement only; it never calls a coordinator or resumes an action.
    pub fn recover_interrupted(&self) -> Result<RecoveryReport> {
        let now = kalcode_core::time::now_rfc3339();
        self.write(|tx| {
            let restore_operations = tx.execute(
                "UPDATE restore_operations
                 SET status = 'failed', recovery_required = 1, finished_at = ?1,
                     error_code = 'interrupted_restart',
                     evidence = json_object(
                       'schemaVersion', 1, 'outcome', 'restart_interrupted',
                       'stage', 'recovery', 'effects', 'unknown', 'affectedItems', 0)
                 WHERE status = 'running'",
                [&now],
            )?;
            let replay_runs = tx.execute(
                "UPDATE replay_runs
                 SET status = 'failed', recovery_required = 1, finished_at = ?1,
                     error_code = 'interrupted_restart',
                     evidence = json_object(
                       'schemaVersion', 1, 'outcome', 'restart_interrupted',
                       'stage', 'recovery', 'effects', 'unknown', 'affectedItems', steps_done)
                 WHERE status = 'running'",
                [&now],
            )?;
            Ok(RecoveryReport {
                restore_operations: u32::try_from(restore_operations).unwrap_or(u32::MAX),
                replay_runs: u32::try_from(replay_runs).unwrap_or(u32::MAX),
            })
        })
    }

    fn finish_restore(
        &self,
        id: &str,
        approval_binding_digest: &str,
        status: RestoreStatus,
        evidence: &OperationEvidence,
        error_code: Option<&str>,
        recovery_required: bool,
    ) -> Result<RestoreOperation> {
        validate_id(id, "operation")?;
        validate_digest(approval_binding_digest, "approval_binding")?;
        validate_evidence(evidence)?;
        let now = kalcode_core::time::now_rfc3339();
        self.write(|tx| {
            terminal_restore(
                tx,
                TerminalUpdate {
                    id,
                    digest: approval_binding_digest,
                    status,
                    evidence,
                    error_code,
                    recovery_required,
                    now: &now,
                },
            )?;
            get_restore_in(tx, id)
        })
    }

    fn finish_replay(
        &self,
        id: &str,
        approval_binding_digest: &str,
        status: ReplayStatus,
        evidence: &OperationEvidence,
        error_code: Option<&str>,
        recovery_required: bool,
    ) -> Result<ReplayRun> {
        validate_id(id, "replay")?;
        validate_digest(approval_binding_digest, "approval_binding")?;
        validate_evidence(evidence)?;
        let now = kalcode_core::time::now_rfc3339();
        self.write(|tx| {
            terminal_replay(
                tx,
                TerminalUpdate {
                    id,
                    digest: approval_binding_digest,
                    status,
                    evidence,
                    error_code,
                    recovery_required,
                    now: &now,
                },
            )?;
            get_replay_in(tx, id)
        })
    }

    fn write<T>(&self, work: impl FnOnce(&Transaction<'_>) -> Result<T>) -> Result<T> {
        self.core
            .write_with_events(|tx| Ok((work(tx)?, Vec::new())))
            .map(|(value, _)| value)
    }
}

fn has_schema(conn: &Connection) -> Result<bool> {
    let tables: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_master
         WHERE type = 'table' AND name IN ('restore_operations', 'replay_runs')",
        [],
        |row| row.get(0),
    )?;
    let guards: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_master
         WHERE type = 'trigger' AND name IN (
           'restore_operations_no_replace', 'replay_runs_no_replace',
           'restore_operations_immutable_authority', 'replay_runs_immutable_authority',
           'restore_operations_no_delete', 'replay_runs_no_delete')",
        [],
        |row| row.get(0),
    )?;
    Ok(tables == 2 && guards == 6)
}

struct TerminalUpdate<'a, Status> {
    id: &'a str,
    digest: &'a str,
    status: Status,
    evidence: &'a OperationEvidence,
    error_code: Option<&'a str>,
    recovery_required: bool,
    now: &'a str,
}

fn terminal_restore(tx: &Transaction<'_>, update: TerminalUpdate<'_, RestoreStatus>) -> Result<()> {
    let evidence_json = encode_evidence(update.evidence)?;
    let changed = tx.execute(
        "UPDATE restore_operations
         SET status = ?3, finished_at = ?4, evidence = ?5, error_code = ?6, recovery_required = ?7
         WHERE id = ?1 AND approval_binding_digest = ?2
           AND ((?3 = 'completed' AND status = 'running') OR
                (?3 IN ('failed', 'cancelled') AND status IN ('planned', 'running')))",
        params![
            update.id,
            update.digest,
            update.status.as_str(),
            update.now,
            evidence_json,
            update.error_code,
            i64::from(update.recovery_required)
        ],
    )?;
    require_cas(changed)
}

fn terminal_replay(tx: &Transaction<'_>, update: TerminalUpdate<'_, ReplayStatus>) -> Result<()> {
    let evidence_json = encode_evidence(update.evidence)?;
    let changed = tx.execute(
        "UPDATE replay_runs
         SET status = ?3, finished_at = ?4, evidence = ?5, error_code = ?6, recovery_required = ?7
         WHERE id = ?1 AND approval_binding_digest = ?2
           AND ((?3 = 'completed' AND status = 'running') OR
                (?3 IN ('failed', 'stopped') AND status IN ('planned', 'running')))
           AND (?3 <> 'completed' OR steps_done = steps_total)",
        params![
            update.id,
            update.digest,
            update.status.as_str(),
            update.now,
            evidence_json,
            update.error_code,
            i64::from(update.recovery_required)
        ],
    )?;
    require_cas(changed)
}

struct RestoreAuthority {
    workspace_id: String,
    checkpoint_id: String,
    kind: RestoreKind,
    status: RestoreStatus,
    expires_at: String,
}

fn restore_authority(conn: &Connection, id: &str, digest: &str) -> Result<RestoreAuthority> {
    let row: Option<(String, String, String, String, String)> = conn
        .query_row(
            "SELECT workspace_id, checkpoint_id, kind, status, expires_at
             FROM restore_operations WHERE id = ?1 AND approval_binding_digest = ?2",
            params![id, digest],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()?;
    let (workspace_id, checkpoint_id, kind, status, expires_at) = row.ok_or_else(not_runnable)?;
    Ok(RestoreAuthority {
        workspace_id,
        checkpoint_id,
        kind: RestoreKind::parse(&kind).ok_or_else(corrupt_row)?,
        status: RestoreStatus::parse(&status).ok_or_else(corrupt_row)?,
        expires_at,
    })
}

struct ReplayAuthority {
    workspace_id: String,
    checkpoint_id: String,
    status: ReplayStatus,
    expires_at: String,
}

fn replay_authority(conn: &Connection, id: &str, digest: &str) -> Result<ReplayAuthority> {
    let row: Option<(String, String, String, String)> = conn
        .query_row(
            "SELECT workspace_id, checkpoint_id, status, expires_at
             FROM replay_runs WHERE id = ?1 AND approval_binding_digest = ?2",
            params![id, digest],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let (workspace_id, checkpoint_id, status, expires_at) = row.ok_or_else(not_runnable)?;
    Ok(ReplayAuthority {
        workspace_id,
        checkpoint_id,
        status: ReplayStatus::parse(&status).ok_or_else(corrupt_row)?,
        expires_at,
    })
}

fn get_restore_in(conn: &Connection, id: &str) -> Result<RestoreOperation> {
    let sql = format!("SELECT {RESTORE_COLUMNS} FROM restore_operations WHERE id = ?1");
    let raw = conn
        .query_row(&sql, [id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, Option<String>>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, i64>(10)?,
                row.get::<_, String>(11)?,
                row.get::<_, Option<String>>(12)?,
                row.get::<_, Option<String>>(13)?,
                row.get::<_, Option<String>>(14)?,
                row.get::<_, Option<String>>(15)?,
            ))
        })
        .optional()?
        .ok_or_else(|| unknown("restore_unknown"))?;
    Ok(RestoreOperation {
        id: raw.0,
        schema_version: u32::try_from(raw.1).map_err(|_| corrupt_row())?,
        workspace_id: raw.2,
        checkpoint_id: raw.3,
        kind: RestoreKind::parse(&raw.4).ok_or_else(corrupt_row)?,
        plan_fingerprint: raw.5,
        plan_summary: serde_json::from_str(&raw.6).map_err(|_| corrupt_row())?,
        expires_at: raw.7,
        safety_checkpoint_id: raw.8,
        status: RestoreStatus::parse(&raw.9).ok_or_else(corrupt_row)?,
        recovery_required: raw.10 != 0,
        planned_at: raw.11,
        started_at: raw.12,
        finished_at: raw.13,
        evidence: decode_evidence(raw.14)?,
        error_code: raw.15,
    })
}

fn get_replay_in(conn: &Connection, id: &str) -> Result<ReplayRun> {
    let sql = format!("SELECT {REPLAY_COLUMNS} FROM replay_runs WHERE id = ?1");
    let raw = conn
        .query_row(&sql, [id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, String>(10)?,
                row.get::<_, Option<String>>(11)?,
                row.get::<_, String>(12)?,
                row.get::<_, i64>(13)?,
                row.get::<_, String>(14)?,
                row.get::<_, Option<String>>(15)?,
                row.get::<_, Option<String>>(16)?,
                row.get::<_, Option<String>>(17)?,
                row.get::<_, Option<String>>(18)?,
            ))
        })
        .optional()?
        .ok_or_else(|| unknown("replay_unknown"))?;
    Ok(ReplayRun {
        id: raw.0,
        schema_version: u32::try_from(raw.1).map_err(|_| corrupt_row())?,
        workspace_id: raw.2,
        checkpoint_id: raw.3,
        from_seq: raw.4,
        to_seq: raw.5,
        steps_total: u32::try_from(raw.6).map_err(|_| corrupt_row())?,
        steps_done: u32::try_from(raw.7).map_err(|_| corrupt_row())?,
        plan_fingerprint: raw.8,
        plan_summary: serde_json::from_str(&raw.9).map_err(|_| corrupt_row())?,
        expires_at: raw.10,
        safety_checkpoint_id: raw.11,
        status: ReplayStatus::parse(&raw.12).ok_or_else(corrupt_row)?,
        recovery_required: raw.13 != 0,
        planned_at: raw.14,
        started_at: raw.15,
        finished_at: raw.16,
        evidence: decode_evidence(raw.17)?,
        error_code: raw.18,
    })
}

fn require_checkpoint(
    conn: &Connection,
    workspace_id: &str,
    checkpoint_id: &str,
    code: &'static str,
) -> Result<()> {
    let exists: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM checkpoints
             WHERE id = ?1 AND workspace_id = ?2 AND pruned_at IS NULL",
            params![checkpoint_id, workspace_id],
            |row| row.get(0),
        )
        .optional()?;
    if exists.is_some() {
        Ok(())
    } else {
        Err(KalError::new(
            ErrorCategory::Verification,
            code,
            "The required checkpoint is unavailable for this workspace.",
        ))
    }
}

fn validate_new_restore(new: &NewRestoreOperation) -> Result<()> {
    validate_id(&new.id, "operation")?;
    validate_id(&new.workspace_id, "workspace")?;
    validate_id(&new.checkpoint_id, "checkpoint")?;
    validate_digest(&new.plan_fingerprint, "plan_fingerprint")?;
    validate_digest(&new.approval_binding_digest, "approval_binding")?;
    validate_restore_summary(new.kind, &new.plan_summary)
}

fn validate_new_replay(new: &NewReplayRun) -> Result<()> {
    validate_id(&new.id, "replay")?;
    validate_id(&new.workspace_id, "workspace")?;
    validate_id(&new.checkpoint_id, "checkpoint")?;
    validate_digest(&new.plan_fingerprint, "plan_fingerprint")?;
    validate_digest(&new.approval_binding_digest, "approval_binding")?;
    if new.from_seq < 0
        || new.to_seq < new.from_seq
        || new.plan_summary.steps_total != new.steps_total
    {
        return Err(KalError::validation(
            "replay_plan_invalid",
            "The replay sequence range or step count is invalid.",
        ));
    }
    validate_replay_summary(&new.plan_summary)
}

fn validate_restore_summary(kind: RestoreKind, summary: &RestorePlanSummary) -> Result<()> {
    let total = summary
        .overwrite
        .checked_add(summary.create)
        .and_then(|v| v.checked_add(summary.delete))
        .and_then(|v| v.checked_add(summary.keep));
    if summary.schema_version != SCHEMA_VERSION
        || total != Some(summary.changes_total)
        || summary.reset_branch != (kind == RestoreKind::ResetBranch)
    {
        return Err(KalError::validation(
            "restore_plan_invalid",
            "The restore plan metadata is invalid.",
        ));
    }
    Ok(())
}

fn validate_replay_summary(summary: &ReplayPlanSummary) -> Result<()> {
    if summary.schema_version != SCHEMA_VERSION
        || summary.replayable.checked_add(summary.not_replayable) != Some(summary.steps_total)
    {
        return Err(KalError::validation(
            "replay_plan_invalid",
            "The replay plan metadata is invalid.",
        ));
    }
    Ok(())
}

fn validate_evidence(evidence: &OperationEvidence) -> Result<()> {
    if evidence.schema_version != SCHEMA_VERSION {
        return Err(KalError::validation(
            "operation_evidence_invalid",
            "The operation evidence version is invalid.",
        ));
    }
    if let Some(id) = evidence.result_ref.as_deref() {
        validate_id(id, "result")?;
    }
    if let Some(id) = evidence.retained_checkpoint_id.as_deref() {
        validate_id(id, "retained_checkpoint")?;
    }
    let _ = encode_evidence(evidence)?;
    Ok(())
}

fn validate_expiry(expires_at: &str, now: &str) -> Result<()> {
    if expires_at.len() < 20
        || expires_at.len() > 64
        || !expires_at.is_ascii()
        || !expires_at.ends_with('Z')
        || !expires_at.contains('T')
        || expires_at <= now
    {
        return Err(KalError::validation(
            "plan_expiry_invalid",
            "The operation plan expiry must be a future UTC timestamp.",
        ));
    }
    Ok(())
}

fn validate_id(id: &str, what: &'static str) -> Result<()> {
    if is_valid_id(id) {
        Ok(())
    } else {
        Err(KalError::validation(
            "invalid_id",
            format!("The {what} id is invalid."),
        ))
    }
}

fn validate_digest(value: &str, what: &'static str) -> Result<()> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(KalError::validation(
            "invalid_digest",
            format!("The {what} digest is invalid."),
        ))
    }
}

fn validate_error_code(code: &str) -> Result<()> {
    if !code.is_empty()
        && code.len() <= 64
        && code
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    {
        Ok(())
    } else {
        Err(KalError::validation(
            "error_code_invalid",
            "The operation error code is invalid.",
        ))
    }
}

fn require_outcome(evidence: &OperationEvidence, expected: EvidenceOutcome) -> Result<()> {
    validate_evidence(evidence)?;
    if evidence.outcome == expected {
        Ok(())
    } else {
        Err(KalError::validation(
            "operation_evidence_invalid",
            "The evidence outcome does not match the operation transition.",
        ))
    }
}

fn encode_plan<T: serde::Serialize>(value: &T) -> Result<String> {
    let encoded = serde_json::to_string(value)?;
    if encoded.len() > MAX_PLAN_JSON_BYTES {
        return Err(KalError::validation(
            "plan_metadata_too_large",
            "The operation plan metadata is too large.",
        ));
    }
    Ok(encoded)
}

fn encode_evidence(evidence: &OperationEvidence) -> Result<String> {
    let encoded = serde_json::to_string(evidence)?;
    if encoded.len() > MAX_EVIDENCE_JSON_BYTES {
        return Err(KalError::validation(
            "operation_evidence_too_large",
            "The operation evidence is too large.",
        ));
    }
    Ok(encoded)
}

fn decode_evidence(value: Option<String>) -> Result<Option<OperationEvidence>> {
    value
        .map(|json| serde_json::from_str(&json).map_err(|_| corrupt_row()))
        .transpose()
}

fn expiry_evidence(outcome: EvidenceOutcome) -> OperationEvidence {
    OperationEvidence {
        schema_version: SCHEMA_VERSION,
        outcome,
        stage: OperationStage::Planned,
        effects: EffectsState::None,
        affected_items: 0,
        result_ref: None,
        retained_checkpoint_id: None,
    }
}

fn require_cas(changed: usize) -> Result<()> {
    if changed == 1 {
        Ok(())
    } else {
        Err(not_runnable())
    }
}

fn not_runnable() -> KalError {
    KalError::new(
        ErrorCategory::Verification,
        "operation_not_runnable",
        "The operation is unavailable, expired, already claimed, or no longer active.",
    )
}

fn unknown(code: &'static str) -> KalError {
    KalError::new(
        ErrorCategory::Verification,
        code,
        "That Time Machine operation no longer exists.",
    )
}

fn corrupt_row() -> KalError {
    KalError::new(
        ErrorCategory::Database,
        "timeline_record_invalid",
        "Time Machine found an invalid durable operation record.",
    )
}
