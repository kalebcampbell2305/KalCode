//! Durable Operations queue and run history.
//!
//! A queued task and the run it becomes share one [`OperationRecord`] identity. This module is
//! deliberately only an authority/store: `claim` reserves work atomically but never launches a
//! process. Runtime adapters bind the resulting terminal/thread and finish the same record.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use kalcode_contracts::ids::{is_valid_id, new_id};
use kalcode_contracts::operations::{
    OperationArtifact, OperationDetail, OperationEnvironmentKind, OperationKind, OperationLane,
    OperationMoment, OperationRecord, OperationSpec, OperationStatus,
};
use rusqlite::{Connection, OptionalExtension, Row, Transaction, params, params_from_iter};

use crate::Core;
use crate::error::{ErrorCategory, KalError, Result};
use crate::redact::PlaceholderStyle;
use crate::redact::secrets::{self, ScanContext};
use crate::time::now_rfc3339;

const MAX_PENDING: i64 = 2_000;
const MAX_DEPENDENCIES: usize = 64;
const MAX_URLS: usize = 32;
const MAX_ENV_KEYS: usize = 128;
const MAX_COMMAND_BYTES: usize = 16 * 1024;
const MAX_PROMPT_BYTES: usize = 128 * 1024;
const MAX_OUTCOME_BYTES: usize = 8 * 1024;
const MAX_OUTPUT_BYTES: usize = 512 * 1024;
const MAX_FOREGROUND_ACTIVE: i64 = 1;
const MAX_SERVICE_ACTIVE: i64 = 4;
const SNAPSHOT_FINAL_LIMIT: i64 = 200;
const MAX_HISTORY_PAGE: u32 = 200;
pub const ACTIVITY_MOMENT_LIMIT: u32 = 5_000;

const OPERATION_COLUMNS: &str = "
    o.id AS operation_id,
    o.name AS operation_name,
    o.workspace_id,
    o.kind,
    o.command,
    o.prompt,
    o.provider_id,
    o.provider_account_id,
    o.model,
    o.effort,
    o.dependencies,
    o.priority,
    o.lane,
    o.environment,
    o.urls,
    o.env_keys,
    o.source,
    o.status,
    w.name AS workspace_name,
    o.branch,
    o.version,
    o.account_label,
    o.terminal_id,
    o.thread_id,
    o.created_at,
    o.started_at,
    o.ended_at,
    o.current_action,
    o.outcome,
    o.position";

/// The single Operations authority over Core's existing SQLite database.
#[derive(Clone)]
pub struct OperationsStore {
    core: Arc<Core>,
}

/// One canonical Operations lifecycle moment with the exact identity needed by Activity.
/// The joined labels are projection inputs only; the durable authority remains
/// `operation_moments` and its parent `operations` row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperationActivityMoment {
    pub operation_id: String,
    pub workspace_id: String,
    pub operation_name: String,
    pub operation_kind: OperationKind,
    pub moment: OperationMoment,
}

/// One durable shell lifecycle reconstructed from the canonical event log. Commands and output
/// are intentionally absent: the event protocol stores process identity and outcome only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellRunRecord {
    pub start_event_id: String,
    pub start_event_seq: i64,
    pub completed_event_seq: Option<i64>,
    pub terminal_id: String,
    pub workspace_id: String,
    pub workspace_name: Option<String>,
    pub shell_name: String,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub exit_code: Option<i64>,
    pub closed_by_user: Option<bool>,
    pub failed: Option<bool>,
}

/// One Environment Doctor lifecycle reconstructed from canonical start/completion events.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackgroundRunRecord {
    pub start_event_id: String,
    pub start_event_seq: i64,
    pub completed_event_seq: Option<i64>,
    pub run_id: String,
    pub workspace_id: Option<String>,
    pub workspace_name: Option<String>,
    pub checks: u32,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub critical: Option<u32>,
    pub warning: Option<u32>,
    pub info: Option<u32>,
    pub could_not_check: Option<u32>,
    pub ignored: Option<u32>,
    pub cancelled: Option<bool>,
}

impl OperationsStore {
    pub fn new(core: Arc<Core>) -> Self {
        Self { core }
    }

    /// Current optimistic revision, global pause state and all queue/run identities.
    pub fn snapshot(&self) -> Result<(u64, bool, Vec<OperationRecord>)> {
        self.core.read(|conn| {
            let (revision, paused) = state(conn)?;
            Ok((revision, paused, load_snapshot_records(conn)?))
        })
    }

    /// Started run history, newest first. The opaque cursor is an exact operation id from the
    /// previous page; pending queue-only rows are never returned.
    pub fn history(
        &self,
        before: Option<&str>,
        limit: u32,
    ) -> Result<(Vec<OperationRecord>, Option<String>)> {
        if limit == 0 || limit > MAX_HISTORY_PAGE {
            return Err(KalError::validation(
                "invalid_operations_history_limit",
                "Operations history pages must contain between 1 and 200 runs.",
            ));
        }
        if let Some(cursor) = before {
            validate_id(cursor).map_err(|_| invalid_history_cursor())?;
        }
        self.core.read(|conn| {
            let cursor = before
                .map(|id| {
                    conn.query_row(
                        "SELECT started_at, id FROM operations
                         WHERE id = ?1 AND started_at IS NOT NULL",
                        [id],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                    )
                    .optional()?
                    .ok_or_else(invalid_history_cursor)
                })
                .transpose()?;
            let fetch = i64::from(limit) + 1;
            let stored = if let Some((created_at, id)) = cursor {
                load_stored_rows(
                    conn,
                    &format!(
                        "SELECT {OPERATION_COLUMNS} FROM operations o
                         JOIN workspaces w ON w.id = o.workspace_id
                         WHERE o.started_at IS NOT NULL
                           AND (o.started_at < ?1 OR (o.started_at = ?1 AND o.id < ?2))
                         ORDER BY o.started_at DESC, o.id DESC LIMIT ?3"
                    ),
                    params![created_at, id, fetch],
                )?
            } else {
                load_stored_rows(
                    conn,
                    &format!(
                        "SELECT {OPERATION_COLUMNS} FROM operations o
                         JOIN workspaces w ON w.id = o.workspace_id
                         WHERE o.started_at IS NOT NULL
                         ORDER BY o.started_at DESC, o.id DESC LIMIT ?1"
                    ),
                    [fetch],
                )?
            };
            let has_more = stored.len() > limit as usize;
            let stored: Vec<_> = stored.into_iter().take(limit as usize).collect();
            let next = has_more
                .then(|| stored.last().map(|row| row.id.clone()))
                .flatten();
            Ok((records_from_stored(conn, stored, false)?, next))
        })
    }

    /// Newest-first ordinary shell lifecycles from the canonical event log. Shells launched by
    /// Operations are excluded because their durable Operation row is the owner-facing run.
    pub fn shell_history(
        &self,
        workspace_id: Option<&str>,
        before_start_event_id: Option<&str>,
        limit: u32,
    ) -> Result<(Vec<ShellRunRecord>, Option<String>)> {
        validate_event_history_request(workspace_id, before_start_event_id, limit)?;
        self.core.read(|conn| {
            let cursor = before_start_event_id
                .map(|id| shell_cursor(conn, workspace_id, id))
                .transpose()?;
            let fetch = i64::from(limit) + 1;
            let rows = load_shell_runs(
                conn,
                "started.type = 'shell.started'
                 AND started.workspace_id IS NOT NULL
                 AND json_extract(started.payload, '$.shellId') NOT LIKE 'operation:%'
                 AND (?1 IS NULL OR started.workspace_id = ?1)
                 AND (?2 IS NULL OR started.occurred_at < ?2
                      OR (started.occurred_at = ?2 AND started.id < ?3))",
                params![
                    workspace_id,
                    cursor.as_ref().map(|item| item.0.as_str()),
                    cursor.as_ref().map(|item| item.1.as_str()),
                    fetch
                ],
                "ORDER BY started.occurred_at DESC, started.id DESC LIMIT ?4",
            )?;
            let has_more = rows.len() > limit as usize;
            let page: Vec<_> = rows.into_iter().take(limit as usize).collect();
            let next = has_more
                .then(|| page.last().map(|run| run.start_event_id.clone()))
                .flatten();
            Ok((page, next))
        })
    }

    /// Exact ordinary shell lifecycle in the requested canonical workspace scope.
    pub fn shell_run(
        &self,
        start_event_id: &str,
        workspace_id: Option<&str>,
    ) -> Result<Option<ShellRunRecord>> {
        validate_event_history_request(workspace_id, Some(start_event_id), 1)?;
        self.core.read(|conn| {
            Ok(load_shell_runs(
                conn,
                "started.type = 'shell.started'
                 AND started.id = ?1
                 AND started.workspace_id IS NOT NULL
                 AND json_extract(started.payload, '$.shellId') NOT LIKE 'operation:%'
                 AND (?2 IS NULL OR started.workspace_id = ?2)",
                params![start_event_id, workspace_id],
                "LIMIT 1",
            )?
            .into_iter()
            .next())
        })
    }

    /// Latest ordinary shell lifecycle for a retained terminal identity. Snapshot projection uses
    /// this lookup to adopt the same `shell:<start-event-id>` identity as paged history instead
    /// of emitting a second `terminal:<terminal-id>` record for the same execution.
    pub fn shell_run_for_terminal(
        &self,
        terminal_id: &str,
        workspace_id: &str,
    ) -> Result<Option<ShellRunRecord>> {
        if !is_valid_id(terminal_id) {
            return Err(KalError::validation(
                "invalid_terminal_id",
                "That terminal reference isn't valid.",
            ));
        }
        validate_event_history_request(Some(workspace_id), None, 1)?;
        self.core.read(|conn| {
            Ok(load_shell_runs(
                conn,
                "started.type = 'shell.started'
                 AND started.workspace_id = ?1
                 AND json_extract(started.payload, '$.terminalId') = ?2
                 AND json_extract(started.payload, '$.shellId') NOT LIKE 'operation:%'",
                params![workspace_id, terminal_id],
                "ORDER BY started.seq DESC LIMIT 1",
            )?
            .into_iter()
            .next())
        })
    }

    /// Newest-first Environment Doctor lifecycles from the canonical event log.
    pub fn background_history(
        &self,
        workspace_id: Option<&str>,
        before_start_event_id: Option<&str>,
        limit: u32,
    ) -> Result<(Vec<BackgroundRunRecord>, Option<String>)> {
        validate_event_history_request(workspace_id, before_start_event_id, limit)?;
        self.core.read(|conn| {
            let cursor = before_start_event_id
                .map(|id| background_cursor(conn, workspace_id, id))
                .transpose()?;
            let fetch = i64::from(limit) + 1;
            let rows = load_background_runs(
                conn,
                "started.type = 'doctor.run_started'
                 AND (?1 IS NULL OR started.workspace_id = ?1)
                 AND (?2 IS NULL OR started.occurred_at < ?2
                      OR (started.occurred_at = ?2 AND started.id < ?3))",
                params![
                    workspace_id,
                    cursor.as_ref().map(|item| item.0.as_str()),
                    cursor.as_ref().map(|item| item.1.as_str()),
                    fetch
                ],
                "ORDER BY started.occurred_at DESC, started.id DESC LIMIT ?4",
            )?;
            let has_more = rows.len() > limit as usize;
            let page: Vec<_> = rows.into_iter().take(limit as usize).collect();
            let next = has_more
                .then(|| page.last().map(|run| run.start_event_id.clone()))
                .flatten();
            Ok((page, next))
        })
    }

    /// Exact Environment Doctor lifecycle by its stable run id.
    pub fn background_run(
        &self,
        run_id: &str,
        workspace_id: Option<&str>,
    ) -> Result<Option<BackgroundRunRecord>> {
        validate_event_history_request(workspace_id, Some(run_id), 1)?;
        self.core.read(|conn| {
            Ok(load_background_runs(
                conn,
                "started.type = 'doctor.run_started'
                 AND json_extract(started.payload, '$.runId') = ?1
                 AND (?2 IS NULL OR started.workspace_id = ?2)",
                params![run_id, workspace_id],
                "ORDER BY started.seq DESC LIMIT 1",
            )?
            .into_iter()
            .next())
        })
    }

    pub fn get(&self, id: &str) -> Result<OperationRecord> {
        validate_id(id)?;
        self.core.read(|conn| load_record(conn, id))
    }

    pub fn detail(&self, id: &str) -> Result<OperationDetail> {
        validate_id(id)?;
        self.core.read(|conn| {
            let run = load_record(conn, id)?;
            let mut stmt = conn.prepare(
                "SELECT id, at, kind, message
                 FROM operation_moments WHERE operation_id = ?1 ORDER BY seq",
            )?;
            let timeline = stmt
                .query_map([id], |row| {
                    Ok(OperationMoment {
                        id: row.get(0)?,
                        at: row.get(1)?,
                        kind: row.get(2)?,
                        message: row.get(3)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(OperationDetail {
                run,
                timeline,
                logs: load_logs(conn, id)?,
                files: Vec::new(),
                artifacts: Vec::<OperationArtifact>::new(),
                tests: Vec::new(),
                notes: Vec::new(),
            })
        })
    }

    /// Newest-first canonical lifecycle moments for the bounded Activity projection.
    /// Fetching one extra row makes omission explicit without ever loading unbounded history.
    pub fn activity_moments(&self, limit: u32) -> Result<(Vec<OperationActivityMoment>, bool)> {
        if limit == 0 || limit > ACTIVITY_MOMENT_LIMIT {
            return Err(KalError::validation(
                "invalid_operations_activity_limit",
                "Operations Activity must contain between 1 and 5,000 lifecycle moments.",
            ));
        }
        self.core.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT m.id, m.operation_id, m.at, m.kind, m.message,
                        o.workspace_id, o.name, o.kind
                 FROM operation_moments m
                 JOIN operations o ON o.id = m.operation_id
                 ORDER BY m.seq DESC
                 LIMIT ?1",
            )?;
            let fetch = i64::from(limit) + 1;
            let rows = stmt
                .query_map([fetch], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                    ))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            let truncated = rows.len() > limit as usize;
            let moments = rows
                .into_iter()
                .take(limit as usize)
                .map(
                    |(id, operation_id, at, kind, message, workspace_id, name, operation_kind)| {
                        Ok(OperationActivityMoment {
                            operation_id,
                            workspace_id,
                            operation_name: name,
                            operation_kind: parse_kind(&operation_kind)?,
                            moment: OperationMoment {
                                id,
                                at,
                                kind,
                                message,
                            },
                        })
                    },
                )
                .collect::<Result<Vec<_>>>()?;
            Ok((moments, truncated))
        })
    }

    pub fn enqueue(&self, spec: OperationSpec) -> Result<OperationRecord> {
        let spec = normalize_spec(spec)?;
        let id = new_id();
        self.write(|tx| {
            let pending: i64 = tx.query_row(
                "SELECT COUNT(*) FROM operations WHERE status IN ('queued', 'paused', 'blocked')",
                [],
                |row| row.get(0),
            )?;
            if pending >= MAX_PENDING {
                return Err(KalError::validation(
                    "operations_queue_full",
                    "The Operations queue is full. Finish or cancel pending work before adding more.",
                ));
            }
            let (workspace_name, account_label) = validate_references(tx, &spec)?;
            validate_dependency_graph(tx, &id, &spec.dependencies, false)?;
            let position: i64 = tx.query_row(
                "SELECT COALESCE(MAX(position) + 1, 0) FROM operations
                 WHERE status IN ('queued', 'paused', 'blocked')",
                [],
                |row| row.get(0),
            )?;
            let created_at = now_rfc3339();
            tx.execute(
                "INSERT INTO operations (
                    id, workspace_id, name, kind, command, prompt, provider_id,
                    provider_account_id, model, effort, dependencies, priority, lane,
                    environment, urls, env_keys, source, status, account_label, created_at,
                    position
                 ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                    ?14, ?15, ?16, 'operations', 'queued', ?17, ?18, ?19
                 )",
                params![
                    id,
                    spec.workspace_id,
                    spec.name,
                    kind_text(spec.kind),
                    spec.command,
                    spec.prompt,
                    spec.provider_id,
                    spec.provider_account_id,
                    spec.model,
                    spec.effort,
                    json(&spec.dependencies)?,
                    spec.priority,
                    lane_text(spec.lane),
                    environment_text(spec.environment),
                    json(&spec.urls)?,
                    json(&spec.env_keys)?,
                    account_label,
                    created_at,
                    position,
                ],
            )?;
            append_moment(tx, &id, "queued", "Added to the Operations queue.")?;
            auto_order(tx)?;
            bump_revision(tx)?;
            let mut record = load_record(tx, &id)?;
            record.workspace_name = workspace_name;
            Ok(record)
        })
    }

    /// Replaces editable task fields. A started or finished run is immutable.
    pub fn update(&self, id: &str, spec: OperationSpec, revision: u64) -> Result<OperationRecord> {
        validate_id(id)?;
        let spec = normalize_spec(spec)?;
        self.write(|tx| {
            require_revision(tx, revision)?;
            let status = operation_status(tx, id)?;
            if !is_pending(status) {
                return Err(invalid_state(
                    "operation_not_pending",
                    "Only pending Operations tasks can be edited.",
                ));
            }
            let (_workspace_name, account_label) = validate_references(tx, &spec)?;
            validate_dependency_graph(tx, id, &spec.dependencies, true)?;
            let next_status = if status == OperationStatus::Paused {
                "paused"
            } else {
                "queued"
            };
            tx.execute(
                "UPDATE operations SET
                    workspace_id = ?2, name = ?3, kind = ?4, command = ?5, prompt = ?6,
                    provider_id = ?7, provider_account_id = ?8, model = ?9, effort = ?10,
                    dependencies = ?11, priority = ?12, lane = ?13, environment = ?14,
                    urls = ?15, env_keys = ?16, account_label = ?17, status = ?18
                 WHERE id = ?1",
                params![
                    id,
                    spec.workspace_id,
                    spec.name,
                    kind_text(spec.kind),
                    spec.command,
                    spec.prompt,
                    spec.provider_id,
                    spec.provider_account_id,
                    spec.model,
                    spec.effort,
                    json(&spec.dependencies)?,
                    spec.priority,
                    lane_text(spec.lane),
                    environment_text(spec.environment),
                    json(&spec.urls)?,
                    json(&spec.env_keys)?,
                    account_label,
                    next_status,
                ],
            )?;
            refresh_blocked(tx)?;
            auto_order(tx)?;
            append_moment(tx, id, "updated", "Pending task settings changed.")?;
            bump_revision(tx)?;
            load_record(tx, id)
        })
    }

    /// Applies the user's preferred order, then restores dependency/priority constraints.
    pub fn reorder(&self, ids: &[String], revision: u64) -> Result<()> {
        if ids.len() > MAX_PENDING as usize {
            return Err(KalError::validation(
                "invalid_queue_order",
                "The queue order contains too many tasks.",
            ));
        }
        self.write(|tx| {
            require_revision(tx, revision)?;
            let pending = pending_ids(tx)?;
            let provided: HashSet<&str> = ids.iter().map(String::as_str).collect();
            if provided.len() != ids.len()
                || pending.len() != ids.len()
                || !pending.iter().all(|id| provided.contains(id.as_str()))
            {
                return Err(KalError::validation(
                    "invalid_queue_order",
                    "Refresh Operations before reordering; the complete pending queue is required.",
                ));
            }
            for (position, id) in ids.iter().enumerate() {
                validate_id(id)?;
                tx.execute(
                    "UPDATE operations SET position = ?2 WHERE id = ?1",
                    params![id, i64::try_from(position).unwrap_or(i64::MAX)],
                )?;
            }
            auto_order(tx)?;
            bump_revision(tx)?;
            Ok(())
        })
    }

    pub fn set_paused(&self, paused: bool) -> Result<()> {
        self.write(|tx| {
            let current: bool = tx.query_row(
                "SELECT paused FROM operations_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )?;
            if current != paused {
                tx.execute(
                    "UPDATE operations_state SET paused = ?1 WHERE singleton = 1",
                    [paused],
                )?;
                bump_revision(tx)?;
            }
            Ok(())
        })
    }

    pub fn hold(&self, id: &str, held: bool) -> Result<()> {
        validate_id(id)?;
        self.write(|tx| {
            let status = operation_status(tx, id)?;
            let changed = match (held, status) {
                (true, OperationStatus::Queued | OperationStatus::Blocked) => {
                    tx.execute(
                        "UPDATE operations SET status = 'paused' WHERE id = ?1",
                        [id],
                    )?;
                    append_moment(tx, id, "paused", "Task paused before starting.")?;
                    true
                }
                (false, OperationStatus::Paused) => {
                    tx.execute(
                        "UPDATE operations SET status = 'queued' WHERE id = ?1",
                        [id],
                    )?;
                    refresh_blocked(tx)?;
                    append_moment(tx, id, "resumed", "Task returned to the queue.")?;
                    true
                }
                (true, OperationStatus::Paused)
                | (false, OperationStatus::Queued | OperationStatus::Blocked) => false,
                _ => {
                    return Err(invalid_state(
                        "operation_not_pending",
                        "Only pending Operations tasks can be paused or resumed.",
                    ));
                }
            };
            if changed {
                auto_order(tx)?;
                bump_revision(tx)?;
            }
            Ok(())
        })
    }

    /// Atomically reserves one runnable task as `starting`. `Some(id)` is Run now; it can
    /// promote Later work but cannot bypass pause, dependency, hold, or execution-slot policy.
    pub fn claim(&self, id: Option<&str>) -> Result<Option<OperationRecord>> {
        if let Some(id) = id {
            validate_id(id)?;
        }
        self.write(|tx| {
            let (_, paused) = state(tx)?;
            if paused {
                return match id {
                    Some(_) => Err(invalid_state(
                        "operations_paused",
                        "Resume Operations before starting queued work.",
                    )),
                    None => Ok(None),
                };
            }
            refresh_blocked(tx)?;
            let chosen = match id {
                Some(id) => {
                    let stored = load_stored(tx, id)?;
                    let status = parse_status(&stored.status)?;
                    match status {
                        OperationStatus::Paused => {
                            return Err(invalid_state(
                                "operation_paused",
                                "Resume this task before running it.",
                            ));
                        }
                        OperationStatus::Blocked => {
                            return Err(invalid_state(
                                "operation_blocked",
                                "This task is blocked by a dependency.",
                            ));
                        }
                        OperationStatus::Queued => {}
                        _ => {
                            return Err(invalid_state(
                                "operation_not_pending",
                                "This Operations task is no longer pending.",
                            ));
                        }
                    }
                    if !dependencies_succeeded(tx, &stored.dependencies)? {
                        return Err(invalid_state(
                            "operation_blocked",
                            "This task is waiting for dependencies to succeed.",
                        ));
                    }
                    require_provider_account_at_claim(
                        tx,
                        stored.provider_id.as_deref(),
                        stored.provider_account_id.as_deref(),
                    )?;
                    if !slot_available(tx, parse_kind(&stored.kind)?)? {
                        return Err(invalid_state(
                            "operation_slot_unavailable",
                            "Operations is already running the maximum work for this task type.",
                        ));
                    }
                    Some(id.to_owned())
                }
                None => next_claimable(tx)?,
            };
            let Some(id) = chosen else {
                return Ok(None);
            };
            let started_at = now_rfc3339();
            let updated = tx.execute(
                "UPDATE operations SET status = 'starting', started_at = ?2,
                    ended_at = NULL, current_action = 'Starting', outcome = NULL
                 WHERE id = ?1 AND status = 'queued'",
                params![id, started_at],
            )?;
            if updated != 1 {
                return Err(invalid_state(
                    "operation_claim_conflict",
                    "This task was claimed by another Operations worker.",
                ));
            }
            append_moment(tx, &id, "starting", "Execution claimed and starting.")?;
            auto_order(tx)?;
            bump_revision(tx)?;
            Ok(Some(load_record(tx, &id)?))
        })
    }

    /// Reserves the deterministic thread identity for a claimed agent before provider launch.
    /// This is durable crash evidence, but deliberately leaves the run in `starting` until the
    /// canonical thread runtime has committed and returned the created thread.
    pub fn reserve_agent_thread(
        &self,
        id: &str,
        branch: Option<&str>,
        version: Option<&str>,
    ) -> Result<()> {
        validate_id(id)?;
        validate_optional_text(branch, 256, "invalid_operation_branch")?;
        validate_optional_text(version, 128, "invalid_operation_version")?;
        self.write(|tx| {
            let stored = load_stored(tx, id)?;
            if parse_kind(&stored.kind)? != OperationKind::Agent {
                return Err(invalid_state(
                    "operation_agent_required",
                    "Only an agent Operation can reserve a thread identity.",
                ));
            }
            if parse_status(&stored.status)? != OperationStatus::Starting {
                return Err(invalid_state(
                    "operation_not_starting",
                    "Only a starting agent Operation can reserve its thread identity.",
                ));
            }
            let unchanged = stored.thread_id.as_deref() == Some(id)
                && stored.terminal_id.is_none()
                && stored.branch.as_deref() == branch
                && stored.version.as_deref() == version;
            if unchanged {
                return Ok(());
            }
            if stored.thread_id.is_some() || stored.terminal_id.is_some() {
                return Err(invalid_state(
                    "operation_execution_already_bound",
                    "This Operation already has a different execution identity.",
                ));
            }
            tx.execute(
                "UPDATE operations SET thread_id = id, branch = ?2, version = ?3
                 WHERE id = ?1 AND status = 'starting'",
                params![id, branch, version],
            )?;
            append_moment(
                tx,
                id,
                "thread_reserved",
                "Reserved the exact agent thread identity before launch.",
            )?;
            bump_revision(tx)?;
            Ok(())
        })
    }

    /// Connects a claimed operation to its real execution identity and marks it running.
    pub fn bind(
        &self,
        id: &str,
        terminal_id: Option<&str>,
        thread_id: Option<&str>,
        branch: Option<&str>,
        version: Option<&str>,
    ) -> Result<()> {
        validate_id(id)?;
        validate_optional_id(terminal_id)?;
        validate_optional_id(thread_id)?;
        validate_optional_text(branch, 256, "invalid_operation_branch")?;
        validate_optional_text(version, 128, "invalid_operation_version")?;
        self.write(|tx| {
            let stored = load_stored(tx, id)?;
            let status = parse_status(&stored.status)?;
            if !matches!(status, OperationStatus::Starting | OperationStatus::Running) {
                return Err(invalid_state(
                    "operation_not_active",
                    "Only a starting or running Operation can be bound to execution.",
                ));
            }
            let kind = parse_kind(&stored.kind)?;
            let valid_binding = if kind == OperationKind::Agent {
                terminal_id.is_none() && thread_id.is_some()
            } else {
                terminal_id.is_some() && thread_id.is_none()
            };
            if !valid_binding {
                return Err(invalid_state(
                    "operation_execution_binding_invalid",
                    if kind == OperationKind::Agent {
                        "An agent Operation must bind exactly one thread and no terminal."
                    } else {
                        "A command Operation must bind exactly one terminal and no thread."
                    },
                ));
            }
            let unchanged = status == OperationStatus::Running
                && stored.terminal_id.as_deref() == terminal_id
                && stored.thread_id.as_deref() == thread_id
                && stored.branch.as_deref() == branch
                && stored.version.as_deref() == version;
            if unchanged {
                return Ok(());
            }
            if status == OperationStatus::Running {
                return Err(invalid_state(
                    "operation_execution_already_bound",
                    "This Operation is already bound to a different execution identity.",
                ));
            }
            let has_reservation = stored.terminal_id.is_some() || stored.thread_id.is_some();
            if has_reservation
                && (stored.terminal_id.as_deref() != terminal_id
                    || stored.thread_id.as_deref() != thread_id
                    || stored.branch.as_deref() != branch
                    || stored.version.as_deref() != version)
            {
                return Err(invalid_state(
                    "operation_execution_already_bound",
                    "This Operation already reserved a different execution identity.",
                ));
            }
            tx.execute(
                "UPDATE operations SET status = 'running', terminal_id = ?2, thread_id = ?3,
                    branch = ?4, version = ?5, current_action = 'Running'
                 WHERE id = ?1",
                params![id, terminal_id, thread_id, branch, version],
            )?;
            append_moment(tx, id, "running", "Execution is running.")?;
            bump_revision(tx)?;
            Ok(())
        })
    }

    /// Updates the short, user-safe action shown on an active run.
    pub fn annotate(&self, id: &str, current_action: Option<&str>) -> Result<()> {
        validate_id(id)?;
        validate_optional_text(current_action, 512, "invalid_operation_action")?;
        if let Some(action) = current_action {
            reject_secret(action)?;
        }
        self.write(|tx| {
            let status = operation_status(tx, id)?;
            if !matches!(status, OperationStatus::Starting | OperationStatus::Running) {
                return Err(invalid_state(
                    "operation_not_active",
                    "Only an active Operation has a current action.",
                ));
            }
            tx.execute(
                "UPDATE operations SET current_action = ?2 WHERE id = ?1",
                params![id, current_action],
            )?;
            if current_action.is_some() {
                append_moment(tx, id, "progress", "Current action changed.")?;
            }
            bump_revision(tx)?;
            Ok(())
        })
    }

    pub fn finish<'a>(
        &self,
        id: &str,
        status: OperationStatus,
        outcome: impl Into<Option<&'a str>>,
    ) -> Result<()> {
        let ended_at = now_rfc3339();
        self.finish_at(id, status, outcome, &ended_at)
    }

    /// Finishes an active run at an authoritative event boundary. Agent reconciliation uses the
    /// persisted `agent.turn_completed` timestamp so a later prompt submitted before the poller
    /// runs cannot leak into the earlier run's detail interval.
    pub fn finish_at<'a>(
        &self,
        id: &str,
        status: OperationStatus,
        outcome: impl Into<Option<&'a str>>,
        ended_at: &str,
    ) -> Result<()> {
        validate_id(id)?;
        let ended = validate_canonical_timestamp(ended_at)?;
        let outcome = outcome.into();
        if !matches!(
            status,
            OperationStatus::Succeeded
                | OperationStatus::Failed
                | OperationStatus::Cancelled
                | OperationStatus::Interrupted
        ) {
            return Err(KalError::validation(
                "invalid_operation_outcome",
                "An Operation can only finish with a final status.",
            ));
        }
        validate_optional_text(outcome, MAX_OUTCOME_BYTES, "invalid_operation_outcome")?;
        let outcome = outcome.map(|text| {
            crate::redact::redact_text(text, ScanContext::default(), PlaceholderStyle::Plain).text
        });
        self.write(|tx| {
            let stored = load_stored(tx, id)?;
            let current = parse_status(&stored.status)?;
            if current == status && stored.outcome.as_deref() == outcome.as_deref() {
                return Ok(());
            }
            if !matches!(
                current,
                OperationStatus::Starting | OperationStatus::Running
            ) {
                return Err(invalid_state(
                    "operation_not_active",
                    "Only a starting or running Operation can finish.",
                ));
            }
            if let Some(started_at) = stored.started_at.as_deref()
                && validate_canonical_timestamp(started_at)? > ended
            {
                return Err(KalError::validation(
                    "invalid_operation_ended_at",
                    "An Operation cannot finish before it started.",
                ));
            }
            tx.execute(
                "UPDATE operations SET status = ?2, ended_at = ?3,
                    current_action = NULL, outcome = ?4 WHERE id = ?1",
                params![id, status_text(status), ended_at, outcome.as_deref()],
            )?;
            append_moment(tx, id, status_text(status), final_message(status))?;
            refresh_blocked(tx)?;
            auto_order(tx)?;
            bump_revision(tx)?;
            Ok(())
        })
    }

    /// Replaces the run's last complete terminal snapshot. Replacement makes checkpoint retries
    /// idempotent. The full shared redactor runs before the snapshot is durably stored.
    pub fn record_output(&self, id: &str, output: &str) -> Result<()> {
        validate_id(id)?;
        if output.len() > MAX_OUTPUT_BYTES {
            return Err(KalError::validation(
                "operation_output_too_large",
                "An Operations output snapshot cannot exceed 512 KiB.",
            ));
        }
        let redacted =
            crate::redact::redact_text(output, ScanContext::default(), PlaceholderStyle::Plain)
                .text;
        self.write(|tx| {
            if is_pending(operation_status(tx, id)?) {
                return Err(invalid_state(
                    "operation_not_started",
                    "Execution output can only be recorded after an Operation starts.",
                ));
            }
            let logs = if redacted.len() <= MAX_OUTPUT_BYTES {
                redacted
            } else {
                let marker = "[earlier output truncated]\n";
                let tail = tail_utf8(&redacted, MAX_OUTPUT_BYTES - marker.len());
                format!("{marker}{tail}")
            };
            let updated = tx.execute(
                "UPDATE operations SET logs = ?2 WHERE id = ?1",
                params![id, logs],
            )?;
            if updated != 1 {
                return Err(not_found());
            }
            Ok(())
        })
    }

    pub fn cancel_pending(&self, id: &str) -> Result<()> {
        validate_id(id)?;
        self.write(|tx| {
            let status = operation_status(tx, id)?;
            if !is_pending(status) {
                return Err(invalid_state(
                    "operation_not_pending",
                    "Only pending Operations tasks can be cancelled from the queue.",
                ));
            }
            tx.execute(
                "UPDATE operations SET status = 'cancelled', ended_at = ?2,
                    current_action = NULL, outcome = 'Cancelled before starting.' WHERE id = ?1",
                params![id, now_rfc3339()],
            )?;
            append_moment(tx, id, "cancelled", "Cancelled before execution started.")?;
            refresh_blocked(tx)?;
            auto_order(tx)?;
            bump_revision(tx)?;
            Ok(())
        })
    }

    /// Marks process-backed work left active by a previous runtime as interrupted and pauses
    /// the queue. Recovery never launches or retries work automatically.
    pub fn recover(&self) -> Result<usize> {
        self.write(|tx| {
            let active = {
                let mut stmt = tx.prepare(
                    "SELECT id, workspace_id, kind, provider_id, provider_account_id, model,
                            terminal_id, thread_id, started_at
                     FROM operations WHERE status IN ('starting', 'running') ORDER BY created_at",
                )?;
                stmt.query_map([], |row| {
                    Ok(RecoveryActive {
                        id: row.get(0)?,
                        workspace_id: row.get(1)?,
                        kind: row.get(2)?,
                        provider_id: row.get(3)?,
                        provider_account_id: row.get(4)?,
                        model: row.get(5)?,
                        terminal_id: row.get(6)?,
                        thread_id: row.get(7)?,
                        started_at: row.get(8)?,
                    })
                })?
                    .collect::<std::result::Result<Vec<_>, _>>()?
            };
            let was_paused: bool = tx.query_row(
                "SELECT paused FROM operations_state WHERE singleton = 1",
                [],
                |row| row.get::<_, bool>(0),
            )?;
            let ended_at = now_rfc3339();
            for active_run in &active {
                let recovered = recovery_outcome(tx, active_run)?;
                if recovered.link_terminal {
                    tx.execute(
                        "UPDATE operations SET terminal_id = id WHERE id = ?1 AND terminal_id IS NULL",
                        [&active_run.id],
                    )?;
                    append_moment(
                        tx,
                        &active_run.id,
                        "recovered_link",
                        "Recovered the operation terminal identity after restart.",
                    )?;
                }
                if recovered.link_thread {
                    tx.execute(
                        "UPDATE operations SET thread_id = id WHERE id = ?1 AND thread_id IS NULL",
                        [&active_run.id],
                    )?;
                    append_moment(
                        tx,
                        &active_run.id,
                        "recovered_link",
                        "Recovered the exact operation thread identity after restart.",
                    )?;
                }
                tx.execute(
                    "UPDATE operations SET status = ?2, ended_at = ?3,
                        current_action = NULL, outcome = ?4
                     WHERE id = ?1",
                    params![
                        active_run.id,
                        status_text(recovered.status),
                        recovered.ended_at.as_deref().unwrap_or(&ended_at),
                        recovered.outcome
                    ],
                )?;
                append_moment(
                    tx,
                    &active_run.id,
                    status_text(recovered.status),
                    recovery_message(recovered.status),
                )?;
            }
            tx.execute(
                "UPDATE operations_state SET paused = 1 WHERE singleton = 1",
                [],
            )?;
            let blocked_changed = refresh_blocked(tx)?;
            auto_order(tx)?;
            if !active.is_empty() || !was_paused || blocked_changed {
                bump_revision(tx)?;
            }
            Ok(active.len())
        })
    }

    fn write<T>(&self, work: impl FnOnce(&Transaction<'_>) -> Result<T>) -> Result<T> {
        let (value, _) = self.core.transact(|tx| Ok((work(tx)?, Vec::new())))?;
        Ok(value)
    }
}

fn validate_event_history_request(
    workspace_id: Option<&str>,
    cursor: Option<&str>,
    limit: u32,
) -> Result<()> {
    if workspace_id.is_some_and(|id| !is_valid_id(id)) {
        return Err(KalError::validation(
            "invalid_workspace_id",
            "That workspace reference isn't valid.",
        ));
    }
    if cursor.is_some_and(|id| !is_valid_id(id)) {
        return Err(invalid_event_history_cursor());
    }
    if !(1..=MAX_HISTORY_PAGE).contains(&limit) {
        return Err(KalError::validation(
            "invalid_observed_history_limit",
            "Observed Runs history pages must contain between 1 and 200 records.",
        ));
    }
    Ok(())
}

fn invalid_event_history_cursor() -> KalError {
    KalError::validation(
        "invalid_observed_history_cursor",
        "That observed Runs history cursor is invalid for this workspace.",
    )
}

fn validate_canonical_timestamp(value: &str) -> Result<time::OffsetDateTime> {
    let parsed = time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
        .map_err(|_| {
            KalError::validation(
                "invalid_operation_ended_at",
                "The Operation completion time must be a canonical UTC timestamp.",
            )
        })?;
    if crate::time::format_rfc3339(parsed) != value {
        return Err(KalError::validation(
            "invalid_operation_ended_at",
            "The Operation completion time must use canonical UTC millisecond precision.",
        ));
    }
    Ok(parsed)
}

fn shell_cursor(
    conn: &Connection,
    workspace_id: Option<&str>,
    event_id: &str,
) -> Result<(String, String)> {
    conn.query_row(
        "SELECT occurred_at, id FROM events
         WHERE id = ?1 AND type = 'shell.started' AND workspace_id IS NOT NULL
           AND json_extract(payload, '$.shellId') NOT LIKE 'operation:%'
           AND (?2 IS NULL OR workspace_id = ?2)",
        params![event_id, workspace_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()?
    .ok_or_else(invalid_event_history_cursor)
}

fn load_shell_runs(
    conn: &Connection,
    filter: &str,
    query_params: impl rusqlite::Params,
    order_and_limit: &str,
) -> Result<Vec<ShellRunRecord>> {
    let sql = format!(
        "WITH selected AS (
           SELECT started.id AS start_event_id, started.seq AS start_event_seq,
                  json_extract(started.payload, '$.terminalId') AS terminal_id,
                  started.workspace_id, workspaces.name AS workspace_name,
                  json_extract(started.payload, '$.shellName') AS shell_name,
                  started.occurred_at AS started_at
           FROM events started
           LEFT JOIN workspaces ON workspaces.id = started.workspace_id
           WHERE {filter}
           {order_and_limit}
         ), bounded AS (
           SELECT selected.*,
                  (SELECT MIN(finished.seq) FROM events finished
                   WHERE finished.type IN ('shell.completed', 'shell.failed')
                     AND finished.workspace_id IS selected.workspace_id
                     AND json_extract(finished.payload, '$.terminalId') = selected.terminal_id
                     AND finished.seq > selected.start_event_seq
                     AND finished.seq < COALESCE((
                       SELECT MIN(next.seq) FROM events next
                       WHERE next.type = 'shell.started'
                         AND next.workspace_id IS selected.workspace_id
                         AND json_extract(next.payload, '$.terminalId') = selected.terminal_id
                         AND next.seq > selected.start_event_seq
                     ), 9223372036854775807)) AS completed_event_seq
           FROM selected
         )
         SELECT bounded.start_event_id, bounded.start_event_seq,
                bounded.completed_event_seq, bounded.terminal_id, bounded.workspace_id,
                bounded.workspace_name, bounded.shell_name, bounded.started_at,
                completed.occurred_at,
                CAST(json_extract(completed.payload, '$.exitCode') AS INTEGER),
                CASE WHEN completed.seq IS NULL THEN NULL
                     WHEN completed.type = 'shell.completed'
                     THEN CAST(json_extract(completed.payload, '$.closedByUser') AS INTEGER)
                     ELSE 0 END,
                CASE WHEN completed.seq IS NULL THEN NULL
                     WHEN completed.type = 'shell.failed'
                       OR CAST(json_extract(completed.payload, '$.exitCode') AS INTEGER) <> 0
                     THEN 1 ELSE 0 END
         FROM bounded
         LEFT JOIN events completed ON completed.seq = bounded.completed_event_seq
         ORDER BY bounded.started_at DESC, bounded.start_event_id DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    Ok(stmt
        .query_map(query_params, |row| {
            Ok(ShellRunRecord {
                start_event_id: row.get(0)?,
                start_event_seq: row.get(1)?,
                completed_event_seq: row.get(2)?,
                terminal_id: row.get(3)?,
                workspace_id: row.get(4)?,
                workspace_name: row.get(5)?,
                shell_name: row.get(6)?,
                started_at: row.get(7)?,
                completed_at: row.get(8)?,
                exit_code: row.get(9)?,
                closed_by_user: row.get(10)?,
                failed: row.get(11)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?)
}

fn background_cursor(
    conn: &Connection,
    workspace_id: Option<&str>,
    event_id: &str,
) -> Result<(String, String)> {
    conn.query_row(
        "SELECT occurred_at, id FROM events
         WHERE id = ?1 AND type = 'doctor.run_started'
           AND (?2 IS NULL OR workspace_id = ?2)",
        params![event_id, workspace_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()?
    .ok_or_else(invalid_event_history_cursor)
}

fn load_background_runs(
    conn: &Connection,
    filter: &str,
    query_params: impl rusqlite::Params,
    order_and_limit: &str,
) -> Result<Vec<BackgroundRunRecord>> {
    let sql = format!(
        "WITH selected AS (
           SELECT started.id AS start_event_id, started.seq AS start_event_seq,
                  json_extract(started.payload, '$.runId') AS run_id,
                  started.workspace_id, workspaces.name AS workspace_name,
                  CAST(json_extract(started.payload, '$.checks') AS INTEGER) AS checks,
                  started.occurred_at AS started_at
           FROM events started
           LEFT JOIN workspaces ON workspaces.id = started.workspace_id
           WHERE {filter}
           {order_and_limit}
         ), bounded AS (
           SELECT selected.*,
                  (SELECT MIN(finished.seq) FROM events finished
                   WHERE finished.type = 'doctor.run_completed'
                     AND finished.workspace_id IS selected.workspace_id
                     AND json_extract(finished.payload, '$.runId') = selected.run_id
                     AND finished.seq > selected.start_event_seq
                     AND finished.seq < COALESCE((
                       SELECT MIN(next.seq) FROM events next
                       WHERE next.type = 'doctor.run_started'
                         AND next.workspace_id IS selected.workspace_id
                         AND json_extract(next.payload, '$.runId') = selected.run_id
                         AND next.seq > selected.start_event_seq
                     ), 9223372036854775807)) AS completed_event_seq
           FROM selected
         )
         SELECT bounded.start_event_id, bounded.start_event_seq,
                bounded.completed_event_seq, bounded.run_id, bounded.workspace_id,
                bounded.workspace_name, bounded.checks, bounded.started_at,
                completed.occurred_at,
                CAST(json_extract(completed.payload, '$.critical') AS INTEGER),
                CAST(json_extract(completed.payload, '$.warning') AS INTEGER),
                CAST(json_extract(completed.payload, '$.info') AS INTEGER),
                CAST(json_extract(completed.payload, '$.couldNotCheck') AS INTEGER),
                CAST(json_extract(completed.payload, '$.ignored') AS INTEGER),
                CAST(json_extract(completed.payload, '$.cancelled') AS INTEGER)
         FROM bounded
         LEFT JOIN events completed ON completed.seq = bounded.completed_event_seq
         ORDER BY bounded.started_at DESC, bounded.start_event_id DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    Ok(stmt
        .query_map(query_params, |row| {
            Ok(BackgroundRunRecord {
                start_event_id: row.get(0)?,
                start_event_seq: row.get(1)?,
                completed_event_seq: row.get(2)?,
                run_id: row.get(3)?,
                workspace_id: row.get(4)?,
                workspace_name: row.get(5)?,
                checks: row.get(6)?,
                started_at: row.get(7)?,
                completed_at: row.get(8)?,
                critical: row.get(9)?,
                warning: row.get(10)?,
                info: row.get(11)?,
                could_not_check: row.get(12)?,
                ignored: row.get(13)?,
                cancelled: row.get(14)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?)
}

struct RecoveryActive {
    id: String,
    workspace_id: String,
    kind: String,
    provider_id: Option<String>,
    provider_account_id: Option<String>,
    model: Option<String>,
    terminal_id: Option<String>,
    thread_id: Option<String>,
    started_at: Option<String>,
}

struct RecoveryOutcome {
    status: OperationStatus,
    outcome: String,
    ended_at: Option<String>,
    link_terminal: bool,
    link_thread: bool,
}

struct RecoveryTerminal {
    shell_id: String,
    end_reason: Option<String>,
    exit_code: Option<i64>,
    ended_at: Option<String>,
}

fn recovery_outcome(conn: &Connection, active: &RecoveryActive) -> Result<RecoveryOutcome> {
    let kind = parse_kind(&active.kind)?;
    if kind != OperationKind::Agent {
        let terminal_id = active.terminal_id.as_deref().unwrap_or(&active.id);
        let terminal: Option<RecoveryTerminal> = conn
            .query_row(
                "SELECT shell_id, end_reason, exit_code, ended_at FROM terminals
                 WHERE id = ?1 AND workspace_id = ?2",
                params![terminal_id, active.workspace_id],
                |row| {
                    Ok(RecoveryTerminal {
                        shell_id: row.get(0)?,
                        end_reason: row.get(1)?,
                        exit_code: row.get(2)?,
                        ended_at: row.get(3)?,
                    })
                },
            )
            .optional()?;
        if let Some(terminal) = terminal
            && terminal.shell_id.starts_with("operation:")
        {
            let link_terminal = active.terminal_id.is_none() && terminal_id == active.id;
            return Ok(match (terminal.end_reason.as_deref(), terminal.exit_code) {
                (Some("exited"), Some(0)) => RecoveryOutcome {
                    status: OperationStatus::Succeeded,
                    outcome: "Recovered a completed command with exit code 0.".into(),
                    ended_at: terminal.ended_at,
                    link_terminal,
                    link_thread: false,
                },
                (Some("exited"), Some(code)) => RecoveryOutcome {
                    status: OperationStatus::Failed,
                    outcome: format!("Recovered a command that exited with code {code}."),
                    ended_at: terminal.ended_at,
                    link_terminal,
                    link_thread: false,
                },
                _ => RecoveryOutcome {
                    status: OperationStatus::Interrupted,
                    outcome: "Interrupted when KalCode stopped; not restarted automatically."
                        .into(),
                    ended_at: terminal.ended_at,
                    link_terminal,
                    link_thread: false,
                },
            });
        }
    }

    let mut link_thread = false;
    let thread_id = if kind == OperationKind::Agent {
        match active.thread_id.as_deref() {
            Some(thread_id) if exact_agent_thread(conn, active, thread_id)? => Some(thread_id),
            Some(_) => None,
            None if exact_agent_thread(conn, active, &active.id)? => {
                link_thread = true;
                Some(active.id.as_str())
            }
            None => None,
        }
    } else {
        None
    };
    if let (Some(thread_id), Some(started_at)) = (thread_id, active.started_at.as_deref()) {
        let completed: Option<(bool, bool, String)> = conn
            .query_row(
                "SELECT
                    CAST(json_extract(payload, '$.ok') AS INTEGER),
                    CAST(json_extract(payload, '$.interrupted') AS INTEGER),
                    occurred_at
                 FROM events
                 WHERE type = 'agent.turn_completed'
                   AND thread_id = ?1
                   AND json_extract(payload, '$.threadId') = ?1
                   AND occurred_at >= ?2
                 ORDER BY seq ASC LIMIT 1",
                params![thread_id, started_at],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        if let Some((ok, interrupted, ended_at)) = completed {
            let status = if interrupted {
                OperationStatus::Interrupted
            } else if ok {
                OperationStatus::Succeeded
            } else {
                OperationStatus::Failed
            };
            return Ok(RecoveryOutcome {
                status,
                outcome: match status {
                    OperationStatus::Succeeded => {
                        "Recovered a provider turn that completed successfully.".into()
                    }
                    OperationStatus::Failed => "Recovered a provider turn that failed.".into(),
                    _ => "Recovered a provider turn that was interrupted.".into(),
                },
                ended_at: Some(ended_at),
                link_terminal: false,
                link_thread,
            });
        }
    }

    Ok(RecoveryOutcome {
        status: OperationStatus::Interrupted,
        outcome: "Interrupted when KalCode stopped; not restarted automatically.".into(),
        ended_at: None,
        link_terminal: false,
        link_thread,
    })
}

fn exact_agent_thread(conn: &Connection, active: &RecoveryActive, thread_id: &str) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM threads
            WHERE id = ?1
              AND workspace_id = ?2
              AND provider_id IS ?3
              AND provider_account_id IS ?4
              AND model IS ?5
              AND permission_mode = 'approve'
         )",
        params![
            thread_id,
            active.workspace_id,
            active.provider_id,
            active.provider_account_id,
            active.model,
        ],
        |row| row.get(0),
    )?)
}

fn recovery_message(status: OperationStatus) -> &'static str {
    match status {
        OperationStatus::Succeeded => "Recovered verified successful completion after restart.",
        OperationStatus::Failed => "Recovered verified failed completion after restart.",
        _ => "Recovered as interrupted; automatic execution remains paused.",
    }
}

#[derive(Debug)]
struct StoredOperation {
    id: String,
    name: String,
    workspace_id: String,
    kind: String,
    command: Option<String>,
    prompt: Option<String>,
    provider_id: Option<String>,
    provider_account_id: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    dependencies: String,
    priority: i32,
    lane: String,
    environment: String,
    urls: String,
    env_keys: String,
    source: String,
    status: String,
    workspace_name: String,
    branch: Option<String>,
    version: Option<String>,
    account_label: Option<String>,
    terminal_id: Option<String>,
    thread_id: Option<String>,
    created_at: String,
    started_at: Option<String>,
    ended_at: Option<String>,
    current_action: Option<String>,
    outcome: Option<String>,
    position: i64,
}

fn stored_from_row(row: &Row<'_>) -> rusqlite::Result<StoredOperation> {
    Ok(StoredOperation {
        id: row.get("operation_id")?,
        name: row.get("operation_name")?,
        workspace_id: row.get("workspace_id")?,
        kind: row.get("kind")?,
        command: row.get("command")?,
        prompt: row.get("prompt")?,
        provider_id: row.get("provider_id")?,
        provider_account_id: row.get("provider_account_id")?,
        model: row.get("model")?,
        effort: row.get("effort")?,
        dependencies: row.get("dependencies")?,
        priority: row.get("priority")?,
        lane: row.get("lane")?,
        environment: row.get("environment")?,
        urls: row.get("urls")?,
        env_keys: row.get("env_keys")?,
        source: row.get("source")?,
        status: row.get("status")?,
        workspace_name: row.get("workspace_name")?,
        branch: row.get("branch")?,
        version: row.get("version")?,
        account_label: row.get("account_label")?,
        terminal_id: row.get("terminal_id")?,
        thread_id: row.get("thread_id")?,
        created_at: row.get("created_at")?,
        started_at: row.get("started_at")?,
        ended_at: row.get("ended_at")?,
        current_action: row.get("current_action")?,
        outcome: row.get("outcome")?,
        position: row.get("position")?,
    })
}

fn load_stored(conn: &Connection, id: &str) -> Result<StoredOperation> {
    conn.query_row(
        &format!(
            "SELECT {OPERATION_COLUMNS} FROM operations o
             JOIN workspaces w ON w.id = o.workspace_id WHERE o.id = ?1"
        ),
        [id],
        stored_from_row,
    )
    .optional()?
    .ok_or_else(not_found)
}

fn load_record(conn: &Connection, id: &str) -> Result<OperationRecord> {
    let stored = load_stored(conn, id)?;
    let statuses = dependency_status_map(conn, &parse_list(&stored.dependencies)?)?;
    stored_to_record(stored, &statuses)
}

fn load_logs(conn: &Connection, id: &str) -> Result<Option<String>> {
    conn.query_row("SELECT logs FROM operations WHERE id = ?1", [id], |row| {
        row.get(0)
    })
    .optional()?
    .ok_or_else(not_found)
}

fn load_stored_rows(
    conn: &Connection,
    sql: &str,
    params: impl rusqlite::Params,
) -> Result<Vec<StoredOperation>> {
    let mut stmt = conn.prepare(sql)?;
    Ok(stmt
        .query_map(params, stored_from_row)?
        .collect::<std::result::Result<Vec<_>, _>>()?)
}

fn load_snapshot_records(conn: &Connection) -> Result<Vec<OperationRecord>> {
    let mut seen = HashSet::new();
    let mut stored = Vec::new();
    let mut append = |rows: Vec<StoredOperation>| {
        for row in rows {
            if seen.insert(row.id.clone()) {
                stored.push(row);
            }
        }
    };
    append(load_stored_rows(
        conn,
        &format!(
            "SELECT {OPERATION_COLUMNS} FROM operations o
             JOIN workspaces w ON w.id = o.workspace_id
             WHERE o.status IN ('queued', 'paused', 'blocked', 'starting', 'running')"
        ),
        [],
    )?);
    append(load_stored_rows(
        conn,
        &format!(
            "SELECT {OPERATION_COLUMNS} FROM operations o
             JOIN workspaces w ON w.id = o.workspace_id
             WHERE o.status IN ('succeeded', 'failed', 'cancelled', 'interrupted')
             ORDER BY o.created_at DESC, o.id DESC LIMIT ?1"
        ),
        [SNAPSHOT_FINAL_LIMIT],
    )?);
    // Retain both the latest deployment attempt and the last successful deployment. A newer
    // failed attempt must not erase the older version that is still the best evidence of what is
    // deployed in that environment.
    append(load_stored_rows(
        conn,
        &format!(
            "SELECT {OPERATION_COLUMNS} FROM operations o
             JOIN workspaces w ON w.id = o.workspace_id
             WHERE o.kind IN ('deploy', 'release')
               AND o.status IN ('succeeded', 'failed', 'cancelled', 'interrupted')
               AND NOT EXISTS (
                 SELECT 1 FROM operations newer
                 WHERE newer.workspace_id = o.workspace_id
                   AND newer.environment = o.environment
                   AND newer.kind = o.kind
                   AND newer.status IN ('succeeded', 'failed', 'cancelled', 'interrupted')
                   AND (newer.created_at > o.created_at
                        OR (newer.created_at = o.created_at AND newer.id > o.id))
               )"
        ),
        [],
    )?);
    append(load_stored_rows(
        conn,
        &format!(
            "SELECT {OPERATION_COLUMNS} FROM operations o
             JOIN workspaces w ON w.id = o.workspace_id
             WHERE o.kind IN ('deploy', 'release')
               AND o.status = 'succeeded'
               AND NOT EXISTS (
                 SELECT 1 FROM operations newer
                 WHERE newer.workspace_id = o.workspace_id
                   AND newer.environment = o.environment
                   AND newer.kind = o.kind
                   AND newer.status = 'succeeded'
                   AND (newer.created_at > o.created_at
                        OR (newer.created_at = o.created_at AND newer.id > o.id))
               )"
        ),
        [],
    )?);
    // Services are projected by the same identity used by utilities::services. Preserve the
    // latest completed attempt for every named command rather than collapsing all services in a
    // workspace to one generic `service` record.
    append(load_stored_rows(
        conn,
        &format!(
            "SELECT {OPERATION_COLUMNS} FROM operations o
             JOIN workspaces w ON w.id = o.workspace_id
             WHERE o.kind = 'service'
               AND o.status IN ('succeeded', 'failed', 'cancelled', 'interrupted')
               AND NOT EXISTS (
                 SELECT 1 FROM operations newer
                 WHERE newer.workspace_id = o.workspace_id
                   AND newer.kind = 'service'
                   AND newer.name = o.name
                   AND newer.command IS o.command
                   AND newer.status IN ('succeeded', 'failed', 'cancelled', 'interrupted')
                   AND (newer.created_at > o.created_at
                        OR (newer.created_at = o.created_at AND newer.id > o.id))
               )"
        ),
        [],
    )?);
    records_from_stored(conn, stored, true)
}

fn records_from_stored(
    conn: &Connection,
    stored: Vec<StoredOperation>,
    sort_snapshot: bool,
) -> Result<Vec<OperationRecord>> {
    let mut status_map: HashMap<String, OperationStatus> = stored
        .iter()
        .map(|item| Ok((item.id.clone(), parse_status(&item.status)?)))
        .collect::<Result<_>>()?;
    let mut unresolved = HashSet::new();
    for item in &stored {
        for dependency in parse_list(&item.dependencies)? {
            if !status_map.contains_key(&dependency) {
                unresolved.insert(dependency);
            }
        }
    }
    let unresolved: Vec<String> = unresolved.into_iter().collect();
    for chunk in unresolved.chunks(400) {
        let placeholders = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        let mut stmt = conn.prepare(&format!(
            "SELECT id, status FROM operations WHERE id IN ({placeholders})"
        ))?;
        let rows = stmt.query_map(params_from_iter(chunk.iter()), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (id, status) = row?;
            status_map.insert(id, parse_status(&status)?);
        }
    }
    let mut records = stored
        .into_iter()
        .map(|item| stored_to_record(item, &status_map))
        .collect::<Result<Vec<_>>>()?;
    if sort_snapshot {
        records.sort_by(|left, right| {
            let left_rank = status_rank(left.status);
            let right_rank = status_rank(right.status);
            left_rank.cmp(&right_rank).then_with(|| {
                if left_rank == 1 {
                    left.position
                        .cmp(&right.position)
                        .then_with(|| left.created_at.cmp(&right.created_at))
                } else {
                    right
                        .created_at
                        .cmp(&left.created_at)
                        .then_with(|| right.id.cmp(&left.id))
                }
            })
        });
    }
    Ok(records)
}

fn stored_to_record(
    stored: StoredOperation,
    statuses: &HashMap<String, OperationStatus>,
) -> Result<OperationRecord> {
    let dependencies: Vec<String> = parse_list(&stored.dependencies)?;
    let blockers = dependencies
        .iter()
        .filter(|id| statuses.get(*id) != Some(&OperationStatus::Succeeded))
        .cloned()
        .collect();
    Ok(OperationRecord {
        id: stored.id,
        spec: OperationSpec {
            name: stored.name,
            workspace_id: stored.workspace_id,
            kind: parse_kind(&stored.kind)?,
            command: stored.command,
            prompt: stored.prompt,
            provider_id: stored.provider_id,
            provider_account_id: stored.provider_account_id,
            model: stored.model,
            effort: stored.effort,
            dependencies,
            priority: stored.priority,
            lane: parse_lane(&stored.lane)?,
            environment: parse_environment(&stored.environment)?,
            urls: parse_list(&stored.urls)?,
            env_keys: parse_list(&stored.env_keys)?,
        },
        source: stored.source,
        status: parse_status(&stored.status)?,
        workspace_name: stored.workspace_name,
        branch: stored.branch,
        version: stored.version,
        account_label: stored.account_label,
        terminal_id: stored.terminal_id,
        thread_id: stored.thread_id,
        created_at: stored.created_at,
        started_at: stored.started_at,
        ended_at: stored.ended_at,
        current_action: stored.current_action,
        outcome: stored.outcome,
        position: stored.position,
        blockers,
    })
}

fn state(conn: &Connection) -> Result<(u64, bool)> {
    let (revision, paused): (i64, bool) = conn.query_row(
        "SELECT revision, paused FROM operations_state WHERE singleton = 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    Ok((u64::try_from(revision).map_err(|_| corrupt())?, paused))
}

fn require_revision(conn: &Connection, expected: u64) -> Result<()> {
    let (actual, _) = state(conn)?;
    if actual == expected {
        Ok(())
    } else {
        Err(KalError::new(
            ErrorCategory::Validation,
            "stale_operations_revision",
            "Operations changed. Refresh before editing the queue.",
        )
        .retryable())
    }
}

fn bump_revision(conn: &Connection) -> Result<()> {
    conn.execute(
        "UPDATE operations_state SET revision = revision + 1 WHERE singleton = 1",
        [],
    )?;
    Ok(())
}

fn operation_status(conn: &Connection, id: &str) -> Result<OperationStatus> {
    dependency_status(conn, id)?.ok_or_else(not_found)
}

fn dependency_status(conn: &Connection, id: &str) -> Result<Option<OperationStatus>> {
    let status: Option<String> = conn
        .query_row("SELECT status FROM operations WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .optional()?;
    status.map(|status| parse_status(&status)).transpose()
}

fn append_moment(conn: &Connection, operation_id: &str, kind: &str, message: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO operation_moments (id, operation_id, at, kind, message)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![new_id(), operation_id, now_rfc3339(), kind, message],
    )?;
    Ok(())
}

fn pending_ids(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM operations WHERE status IN ('queued', 'paused', 'blocked')
         ORDER BY position, created_at, id",
    )?;
    Ok(stmt
        .query_map([], |row| row.get(0))?
        .collect::<std::result::Result<_, _>>()?)
}

#[derive(Clone)]
struct QueueNode {
    id: String,
    dependencies: Vec<String>,
    priority: i32,
    position: i64,
    created_at: String,
}

fn auto_order(conn: &Connection) -> Result<()> {
    let nodes = {
        let mut stmt = conn.prepare(
            "SELECT id, dependencies, priority, position, created_at
             FROM operations WHERE status IN ('queued', 'paused', 'blocked')",
        )?;
        stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i32>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?
        .into_iter()
        .map(|(id, dependencies, priority, position, created_at)| {
            Ok(QueueNode {
                id,
                dependencies: parse_list(&dependencies)?,
                priority,
                position,
                created_at,
            })
        })
        .collect::<Result<Vec<_>>>()?
    };
    if nodes.is_empty() {
        return Ok(());
    }
    let pending: HashSet<&str> = nodes.iter().map(|node| node.id.as_str()).collect();
    let mut remaining: HashMap<String, usize> = nodes
        .iter()
        .map(|node| {
            (
                node.id.clone(),
                node.dependencies
                    .iter()
                    .filter(|dependency| pending.contains(dependency.as_str()))
                    .count(),
            )
        })
        .collect();
    let mut dependents: HashMap<&str, Vec<&str>> = HashMap::new();
    for node in &nodes {
        for dependency in &node.dependencies {
            if pending.contains(dependency.as_str()) {
                dependents.entry(dependency).or_default().push(&node.id);
            }
        }
    }
    let by_id: HashMap<&str, &QueueNode> =
        nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let mut ready: Vec<&QueueNode> = nodes
        .iter()
        .filter(|node| remaining.get(&node.id) == Some(&0))
        .collect();
    let mut ordered = Vec::with_capacity(nodes.len());
    while !ready.is_empty() {
        ready.sort_by(|left, right| {
            right
                .priority
                .cmp(&left.priority)
                .then_with(|| left.position.cmp(&right.position))
                .then_with(|| left.created_at.cmp(&right.created_at))
                .then_with(|| left.id.cmp(&right.id))
        });
        let next = ready.remove(0);
        ordered.push(next.id.as_str());
        for dependent in dependents.get(next.id.as_str()).into_iter().flatten() {
            let count = remaining.get_mut(*dependent).ok_or_else(corrupt)?;
            *count = count.saturating_sub(1);
            if *count == 0 {
                ready.push(by_id.get(*dependent).copied().ok_or_else(corrupt)?);
            }
        }
    }
    if ordered.len() != nodes.len() {
        return Err(corrupt());
    }
    for (position, id) in ordered.iter().enumerate() {
        conn.execute(
            "UPDATE operations SET position = ?2 WHERE id = ?1",
            params![id, i64::try_from(position).unwrap_or(i64::MAX)],
        )?;
    }
    Ok(())
}

/// Re-evaluates durable failure propagation. Held tasks keep their held presentation until the
/// owner resumes them, at which point the failed dependency becomes explicit.
fn refresh_blocked(conn: &Connection) -> Result<bool> {
    let mut changed_any = false;
    loop {
        let candidates = {
            let mut stmt = conn.prepare(
                "SELECT id, status, dependencies FROM operations
                 WHERE status IN ('queued', 'blocked')",
            )?;
            stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?
        };
        let mut changes = Vec::new();
        for (id, status, dependencies) in candidates {
            let failed = has_failed_dependency(conn, &parse_list(&dependencies)?)?;
            let desired = if failed { "blocked" } else { "queued" };
            if status != desired {
                changes.push((id, desired));
            }
        }
        if changes.is_empty() {
            break;
        }
        changed_any = true;
        for (id, desired) in changes {
            conn.execute(
                "UPDATE operations SET status = ?2 WHERE id = ?1",
                params![id, desired],
            )?;
            append_moment(
                conn,
                &id,
                desired,
                if desired == "blocked" {
                    "Blocked because a dependency did not succeed."
                } else {
                    "Dependency blocker cleared; task returned to the queue."
                },
            )?;
        }
    }
    Ok(changed_any)
}

fn next_claimable(conn: &Connection) -> Result<Option<String>> {
    let candidates = {
        let mut stmt = conn.prepare(
            "SELECT id, kind, dependencies, provider_id, provider_account_id FROM operations
             WHERE status = 'queued' AND lane = 'next' ORDER BY position, created_at, id",
        )?;
        stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?
    };
    for (id, kind, dependencies, provider_id, provider_account_id) in candidates {
        if provider_account_available(conn, provider_id.as_deref(), provider_account_id.as_deref())?
            && dependencies_succeeded(conn, &dependencies)?
            && slot_available(conn, parse_kind(&kind)?)?
        {
            return Ok(Some(id));
        }
    }
    Ok(None)
}

fn require_provider_account_at_claim(
    conn: &Connection,
    provider_id: Option<&str>,
    provider_account_id: Option<&str>,
) -> Result<()> {
    if provider_account_available(conn, provider_id, provider_account_id)? {
        Ok(())
    } else {
        Err(KalError::validation(
            "operation_provider_account_missing",
            "The selected provider account is unavailable. Edit the queued task before running it.",
        ))
    }
}

fn provider_account_available(
    conn: &Connection,
    provider_id: Option<&str>,
    provider_account_id: Option<&str>,
) -> Result<bool> {
    let Some(account_id) = provider_account_id else {
        return Ok(true);
    };
    let Some(provider_id) = provider_id else {
        return Ok(false);
    };
    Ok(conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM provider_accounts
            WHERE id = ?1 AND provider_id = ?2 AND archived_at IS NULL
         )",
        params![account_id, provider_id],
        |row| row.get(0),
    )?)
}

fn dependencies_succeeded(conn: &Connection, encoded: &str) -> Result<bool> {
    let dependencies: Vec<String> = parse_list(encoded)?;
    for dependency in dependencies {
        if dependency_status(conn, &dependency)? != Some(OperationStatus::Succeeded) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn has_failed_dependency(conn: &Connection, dependencies: &[String]) -> Result<bool> {
    for dependency in dependencies {
        let status = dependency_status(conn, dependency)?;
        if status.is_none()
            || matches!(
                status,
                Some(
                    OperationStatus::Failed
                        | OperationStatus::Cancelled
                        | OperationStatus::Interrupted
                        | OperationStatus::Blocked
                )
            )
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn slot_available(conn: &Connection, kind: OperationKind) -> Result<bool> {
    let (services, foreground): (i64, i64) = conn.query_row(
        "SELECT
            COALESCE(SUM(CASE WHEN kind = 'service' THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN kind <> 'service' THEN 1 ELSE 0 END), 0)
         FROM operations WHERE status IN ('starting', 'running')",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    Ok(if kind == OperationKind::Service {
        services < MAX_SERVICE_ACTIVE
    } else {
        foreground < MAX_FOREGROUND_ACTIVE
    })
}

fn validate_dependency_graph(
    conn: &Connection,
    operation_id: &str,
    dependencies: &[String],
    replacing: bool,
) -> Result<()> {
    if dependencies.iter().any(|id| id == operation_id) {
        return Err(KalError::validation(
            "operation_dependency_self",
            "An Operations task cannot depend on itself.",
        ));
    }
    let mut graph = {
        let mut stmt = conn.prepare("SELECT id, dependencies FROM operations")?;
        stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?
        .into_iter()
        .map(|(id, encoded)| Ok((id, parse_list(&encoded)?)))
        .collect::<Result<HashMap<_, _>>>()?
    };
    for dependency in dependencies {
        if !graph.contains_key(dependency) {
            return Err(KalError::validation(
                "operation_dependency_missing",
                "A dependency no longer exists. Refresh Operations and choose it again.",
            ));
        }
    }
    if replacing && !graph.contains_key(operation_id) {
        return Err(not_found());
    }
    graph.insert(operation_id.to_owned(), dependencies.to_vec());
    // Historical cross-workspace dependencies can become dangling when their workspace is
    // forgotten. They remain permanent blockers, but must not poison validation for healthy
    // queue edits or be misclassified as a cycle.
    let known_ids: HashSet<String> = graph.keys().cloned().collect();
    for node_dependencies in graph.values_mut() {
        node_dependencies.retain(|dependency| known_ids.contains(dependency));
    }
    let mut indegree: HashMap<&str, usize> = graph
        .iter()
        .map(|(id, dependencies)| (id.as_str(), dependencies.len()))
        .collect();
    let mut dependents: HashMap<&str, Vec<&str>> = HashMap::new();
    for (id, node_dependencies) in &graph {
        for dependency in node_dependencies {
            dependents.entry(dependency).or_default().push(id);
        }
    }
    let mut ready: Vec<&str> = indegree
        .iter()
        .filter_map(|(id, count)| (*count == 0).then_some(*id))
        .collect();
    let mut visited = 0usize;
    while let Some(id) = ready.pop() {
        visited += 1;
        for dependent in dependents.get(id).into_iter().flatten() {
            let count = indegree.get_mut(*dependent).ok_or_else(corrupt)?;
            *count = count.saturating_sub(1);
            if *count == 0 {
                ready.push(dependent);
            }
        }
    }
    if visited != graph.len() {
        return Err(KalError::validation(
            "operation_dependency_cycle",
            "This dependency would create a cycle in the Operations queue.",
        ));
    }
    Ok(())
}

fn validate_references(
    conn: &Connection,
    spec: &OperationSpec,
) -> Result<(String, Option<String>)> {
    let workspace_name: Option<String> = conn
        .query_row(
            "SELECT name FROM workspaces WHERE id = ?1",
            [&spec.workspace_id],
            |row| row.get(0),
        )
        .optional()?;
    let workspace_name = workspace_name.ok_or_else(|| {
        KalError::validation(
            "operation_workspace_missing",
            "The selected workspace no longer exists.",
        )
    })?;
    let account_label = match (&spec.provider_id, &spec.provider_account_id) {
        (_, None) => None,
        (None, Some(_)) => {
            return Err(KalError::validation(
                "operation_provider_required",
                "Choose a provider before choosing a provider account.",
            ));
        }
        (Some(provider_id), Some(account_id)) => conn
            .query_row(
                "SELECT display_name FROM provider_accounts
                 WHERE id = ?1 AND provider_id = ?2 AND archived_at IS NULL",
                params![account_id, provider_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| {
                KalError::validation(
                    "operation_provider_account_missing",
                    "The selected provider account is unavailable.",
                )
            })?
            .into(),
    };
    Ok((workspace_name, account_label))
}

/// Canonicalizes and validates owner-authored Operations input before it is displayed for native
/// confirmation. Callers persist and execute this exact returned value, never the raw request.
pub fn normalize_spec(mut spec: OperationSpec) -> Result<OperationSpec> {
    normalize_and_validate_spec(&mut spec)?;
    Ok(spec)
}

fn normalize_and_validate_spec(spec: &mut OperationSpec) -> Result<()> {
    spec.name = spec.name.trim().to_owned();
    validate_text(&spec.name, 160, false, "invalid_operation_name")?;
    reject_secret(&spec.name)?;
    if !is_valid_id(&spec.workspace_id) {
        return Err(KalError::validation(
            "invalid_operation_workspace",
            "The Operations workspace identifier is invalid.",
        ));
    }
    normalize_optional(&mut spec.command);
    normalize_optional(&mut spec.prompt);
    normalize_optional(&mut spec.provider_id);
    normalize_optional(&mut spec.provider_account_id);
    normalize_optional(&mut spec.model);
    normalize_optional(&mut spec.effort);
    validate_optional_multiline(
        &spec.command,
        MAX_COMMAND_BYTES,
        "invalid_operation_command",
    )?;
    validate_optional_multiline(&spec.prompt, MAX_PROMPT_BYTES, "invalid_operation_prompt")?;
    if let Some(command) = &spec.command {
        reject_secret(command)?;
    }
    if let Some(prompt) = &spec.prompt {
        reject_secret(prompt)?;
    }
    if let Some(provider) = &spec.provider_id {
        validate_slug(provider, 64, "invalid_operation_provider")?;
    }
    if let Some(account) = &spec.provider_account_id {
        validate_id(account).map_err(|_| {
            KalError::validation(
                "invalid_operation_provider_account",
                "The provider account identifier is invalid.",
            )
        })?;
    }
    validate_optional_text(spec.model.as_deref(), 128, "invalid_operation_model")?;
    validate_optional_text(spec.effort.as_deref(), 32, "invalid_operation_effort")?;
    if spec
        .effort
        .as_deref()
        .is_some_and(|effort| effort != "default")
    {
        return Err(KalError::validation(
            "unsupported_operation_effort",
            "This runtime currently supports provider-default effort only.",
        ));
    }
    match spec.kind {
        OperationKind::Agent => {
            if spec.prompt.is_none() {
                return Err(KalError::validation(
                    "operation_prompt_required",
                    "Enter a prompt for this agent task.",
                ));
            }
            if spec.command.is_some() {
                return Err(KalError::validation(
                    "operation_command_not_allowed",
                    "An agent task cannot also contain a shell command.",
                ));
            }
        }
        _ => {
            if spec.command.is_none() {
                return Err(KalError::validation(
                    "operation_command_required",
                    "Enter a command for this task.",
                ));
            }
            if spec.prompt.is_some()
                || spec.provider_id.is_some()
                || spec.provider_account_id.is_some()
                || spec.model.is_some()
                || spec.effort.is_some()
            {
                return Err(KalError::validation(
                    "operation_agent_fields_not_allowed",
                    "Command tasks cannot contain agent provider, model, effort, or prompt fields.",
                ));
            }
        }
    }
    if !(i32::from(-1_000i16)..=i32::from(1_000i16)).contains(&spec.priority) {
        return Err(KalError::validation(
            "invalid_operation_priority",
            "Operation priority must be between -1000 and 1000.",
        ));
    }
    validate_id_list(&spec.dependencies)?;
    if spec.urls.len() > MAX_URLS {
        return Err(KalError::validation(
            "too_many_operation_urls",
            "An Operation can declare at most 32 URLs.",
        ));
    }
    ensure_unique(
        &spec.urls,
        "duplicate_operation_url",
        "Operation URLs must be unique.",
    )?;
    for url in &spec.urls {
        validate_url(url)?;
    }
    if spec.env_keys.len() > MAX_ENV_KEYS {
        return Err(KalError::validation(
            "too_many_environment_keys",
            "An Operation can declare at most 128 environment variable names.",
        ));
    }
    ensure_unique(
        &spec.env_keys,
        "duplicate_environment_key",
        "Environment variable names must be unique.",
    )?;
    for key in &spec.env_keys {
        validate_environment_key(key)?;
    }
    Ok(())
}

fn normalize_optional(value: &mut Option<String>) {
    if let Some(text) = value {
        *text = text.trim().to_owned();
        if text.is_empty() {
            *value = None;
        }
    }
}

fn tail_utf8(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut start = value.len() - max_bytes;
    while start < value.len() && !value.is_char_boundary(start) {
        start += 1;
    }
    &value[start..]
}

fn validate_id_list(ids: &[String]) -> Result<()> {
    if ids.len() > MAX_DEPENDENCIES {
        return Err(KalError::validation(
            "too_many_operation_dependencies",
            "An Operation can have at most 64 dependencies.",
        ));
    }
    ensure_unique(
        ids,
        "duplicate_operation_dependency",
        "Operation dependencies must be unique.",
    )?;
    for id in ids {
        validate_id(id).map_err(|_| {
            KalError::validation(
                "invalid_operation_dependency",
                "An Operation dependency identifier is invalid.",
            )
        })?;
    }
    Ok(())
}

fn ensure_unique(values: &[String], code: &'static str, message: &'static str) -> Result<()> {
    let unique: HashSet<&str> = values.iter().map(String::as_str).collect();
    if unique.len() == values.len() {
        Ok(())
    } else {
        Err(KalError::validation(code, message))
    }
}

fn validate_url(url: &str) -> Result<()> {
    if url.is_empty()
        || url.len() > 2_048
        || !url.is_ascii()
        || url.chars().any(char::is_whitespace)
        || url.chars().any(char::is_control)
    {
        return Err(invalid_url());
    }
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .ok_or_else(invalid_url)?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.is_empty() || authority.contains('@') || authority.starts_with(':') {
        return Err(invalid_url());
    }
    if !secrets::scan(url).is_empty() {
        return Err(invalid_url());
    }
    Ok(())
}

fn validate_environment_key(key: &str) -> Result<()> {
    let mut chars = key.chars();
    let valid = key.len() <= 128
        && chars
            .next()
            .is_some_and(|first| first == '_' || first.is_ascii_alphabetic())
        && chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
        && secrets::scan(key).is_empty();
    if valid {
        Ok(())
    } else {
        Err(KalError::validation(
            "invalid_environment_key",
            "Environment entries must contain names only, such as PUBLIC_API_URL.",
        ))
    }
}

fn validate_slug(value: &str, max: usize, code: &'static str) -> Result<()> {
    if !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        Ok(())
    } else {
        Err(KalError::validation(
            code,
            "An Operations selector is invalid.",
        ))
    }
}

fn validate_text(value: &str, max: usize, multiline: bool, code: &'static str) -> Result<()> {
    let controls_valid = value
        .chars()
        .all(|c| !c.is_control() || (multiline && matches!(c, '\n' | '\r' | '\t')));
    if !value.is_empty() && value.len() <= max && controls_valid {
        Ok(())
    } else {
        Err(KalError::validation(
            code,
            "An Operations field is invalid.",
        ))
    }
}

fn validate_optional_text(value: Option<&str>, max: usize, code: &'static str) -> Result<()> {
    match value {
        Some(value) => validate_text(value, max, false, code),
        None => Ok(()),
    }
}

fn validate_optional_multiline(
    value: &Option<String>,
    max: usize,
    code: &'static str,
) -> Result<()> {
    match value {
        Some(value) => validate_text(value, max, true, code),
        None => Ok(()),
    }
}

fn reject_secret(value: &str) -> Result<()> {
    if secrets::scan(value).is_empty() {
        Ok(())
    } else {
        Err(KalError::validation(
            "operation_contains_secret",
            "Remove credentials from the Operations task and reference a managed account or environment variable instead.",
        ))
    }
}

fn validate_id(id: &str) -> Result<()> {
    if is_valid_id(id) {
        Ok(())
    } else {
        Err(KalError::validation("invalid_id", "Invalid identifier."))
    }
}

fn validate_optional_id(id: Option<&str>) -> Result<()> {
    id.map_or(Ok(()), validate_id)
}

fn dependency_status_map(
    conn: &Connection,
    dependencies: &[String],
) -> Result<HashMap<String, OperationStatus>> {
    dependencies
        .iter()
        .map(|id| {
            Ok((
                id.clone(),
                dependency_status(conn, id)?.unwrap_or(OperationStatus::Interrupted),
            ))
        })
        .collect()
}

fn json<T: serde::Serialize>(value: &T) -> Result<String> {
    Ok(serde_json::to_string(value)?)
}

fn parse_list(encoded: &str) -> Result<Vec<String>> {
    Ok(serde_json::from_str(encoded)?)
}

fn kind_text(kind: OperationKind) -> &'static str {
    match kind {
        OperationKind::Agent => "agent",
        OperationKind::Build => "build",
        OperationKind::Test => "test",
        OperationKind::Script => "script",
        OperationKind::Deploy => "deploy",
        OperationKind::Release => "release",
        OperationKind::Background => "background",
        OperationKind::Service => "service",
    }
}

fn parse_kind(value: &str) -> Result<OperationKind> {
    match value {
        "agent" => Ok(OperationKind::Agent),
        "build" => Ok(OperationKind::Build),
        "test" => Ok(OperationKind::Test),
        "script" => Ok(OperationKind::Script),
        "deploy" => Ok(OperationKind::Deploy),
        "release" => Ok(OperationKind::Release),
        "background" => Ok(OperationKind::Background),
        "service" => Ok(OperationKind::Service),
        _ => Err(corrupt()),
    }
}

fn lane_text(lane: OperationLane) -> &'static str {
    match lane {
        OperationLane::Next => "next",
        OperationLane::Later => "later",
    }
}

fn parse_lane(value: &str) -> Result<OperationLane> {
    match value {
        "next" => Ok(OperationLane::Next),
        "later" => Ok(OperationLane::Later),
        _ => Err(corrupt()),
    }
}

fn environment_text(environment: OperationEnvironmentKind) -> &'static str {
    match environment {
        OperationEnvironmentKind::Local => "local",
        OperationEnvironmentKind::Preview => "preview",
        OperationEnvironmentKind::Staging => "staging",
        OperationEnvironmentKind::Production => "production",
    }
}

fn parse_environment(value: &str) -> Result<OperationEnvironmentKind> {
    match value {
        "local" => Ok(OperationEnvironmentKind::Local),
        "preview" => Ok(OperationEnvironmentKind::Preview),
        "staging" => Ok(OperationEnvironmentKind::Staging),
        "production" => Ok(OperationEnvironmentKind::Production),
        _ => Err(corrupt()),
    }
}

fn status_text(status: OperationStatus) -> &'static str {
    match status {
        OperationStatus::Queued => "queued",
        OperationStatus::Starting => "starting",
        OperationStatus::Running => "running",
        OperationStatus::Paused => "paused",
        OperationStatus::Blocked => "blocked",
        OperationStatus::Succeeded => "succeeded",
        OperationStatus::Failed => "failed",
        OperationStatus::Cancelled => "cancelled",
        OperationStatus::Interrupted => "interrupted",
        // Projection-only. Public durable writes reject this status before reaching SQL.
        OperationStatus::Unknown => "unknown",
    }
}

fn parse_status(value: &str) -> Result<OperationStatus> {
    match value {
        "queued" => Ok(OperationStatus::Queued),
        "starting" => Ok(OperationStatus::Starting),
        "running" => Ok(OperationStatus::Running),
        "paused" => Ok(OperationStatus::Paused),
        "blocked" => Ok(OperationStatus::Blocked),
        "succeeded" => Ok(OperationStatus::Succeeded),
        "failed" => Ok(OperationStatus::Failed),
        "cancelled" => Ok(OperationStatus::Cancelled),
        "interrupted" => Ok(OperationStatus::Interrupted),
        _ => Err(corrupt()),
    }
}

fn is_pending(status: OperationStatus) -> bool {
    matches!(
        status,
        OperationStatus::Queued | OperationStatus::Paused | OperationStatus::Blocked
    )
}

fn status_rank(status: OperationStatus) -> u8 {
    match status {
        OperationStatus::Starting | OperationStatus::Running => 0,
        OperationStatus::Queued | OperationStatus::Paused | OperationStatus::Blocked => 1,
        OperationStatus::Succeeded
        | OperationStatus::Failed
        | OperationStatus::Cancelled
        | OperationStatus::Interrupted
        | OperationStatus::Unknown => 2,
    }
}

fn final_message(status: OperationStatus) -> &'static str {
    match status {
        OperationStatus::Succeeded => "Execution succeeded.",
        OperationStatus::Failed => "Execution failed.",
        OperationStatus::Cancelled => "Execution was cancelled.",
        OperationStatus::Interrupted => "Execution was interrupted.",
        _ => "Execution finished.",
    }
}

fn invalid_url() -> KalError {
    KalError::validation(
        "invalid_operation_url",
        "Operation URLs must be credential-free HTTP or HTTPS addresses.",
    )
}

fn invalid_history_cursor() -> KalError {
    KalError::validation(
        "invalid_operations_history_cursor",
        "The Operations history cursor is invalid or no longer available.",
    )
}

fn not_found() -> KalError {
    KalError::validation(
        "operation_not_found",
        "The Operations task no longer exists.",
    )
}

fn invalid_state(code: &'static str, message: &'static str) -> KalError {
    KalError::new(ErrorCategory::Validation, code, message)
}

fn corrupt() -> KalError {
    KalError::new(
        ErrorCategory::Database,
        "operations_data_invalid",
        "KalCode found invalid Operations data and stopped before running work.",
    )
}
