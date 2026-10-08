//! Agent Handoff Chains over canonical Operations.
//!
//! A chain launch is an ad-hoc Squad launch (no saved template): each step attempt is one
//! ordinary Agent Operation whose `dependencies` encode the chain order, so the Operations runtime
//! owns queueing, the dependency wait, at-most-once delivery, settlement and restart recovery.
//! This store keeps only chain facts (goal, acceptance, intents, reports, the person's decisions)
//! and derives every phase on read.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use kalcode_contracts::chains::{
    Chain, ChainPhase, ChainReportSource, ChainStartRequest, ChainStep, ChainStepDefinition,
    ChainStepIntent, ChainStepPhase, ChainStepReport, ChainStepResult, ChainStepRoute,
    ChainTestRun, ChainWorktree, ChainsSnapshot,
};
use kalcode_contracts::ids::{is_valid_id, new_id};
use kalcode_contracts::operations::{OperationRecord, OperationStatus};
use kalcode_contracts::squads::{SquadDefinition, SquadMemberDefinition};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::Core;
use crate::error::{KalError, Result};
use crate::operations::{OperationsStore, refresh_pending, replace_pending_dependencies};
use crate::plans::PlanLimit;
use crate::squads::{
    LaunchPlan, MemberOperation, bump_operations_revision, fingerprint_of, insert_launch,
    insert_member_operation, next_queue_position, normalize_inline,
};
use crate::time::now_rfc3339;

/// Workspace-relative folder (inside each step's working folder) for structured step reports.
/// KalCode adds it to the repository's `info/exclude`, so a report never appears as a change.
pub const REPORT_DIR: &str = ".kalcode/chain-reports";
pub const REPORT_EXCLUDE_PATTERN: &str = ".kalcode/chain-reports/";

const MAX_STEPS: usize = 12;
const MAX_ACCEPTANCE: usize = 20;
const MAX_ACCEPTANCE_BYTES: usize = 300;
const MAX_INSTRUCTIONS_BYTES: usize = 8 * 1024;
const MAX_REPORT_BYTES: u64 = 64 * 1024;
const MAX_SUMMARY_CHARS: usize = 2_000;
const MAX_TESTS: usize = 20;
const MAX_BLOCKERS: usize = 10;
const MAX_LINE_CHARS: usize = 300;
const MAX_RECENT_CHAINS: i64 = 50;
const FIX_SKIP_REASON: &str = "Review passed; nothing to fix.";

#[derive(Clone)]
pub struct ChainsStore {
    core: Arc<Core>,
}

/// What the Operations runtime needs to run one chain step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepBinding {
    pub chain_id: String,
    pub step_key: String,
    pub intent: ChainStepIntent,
    pub worktree: ChainWorktree,
    /// The shared worktree's branch and owner reference: the chain itself, or the source agent
    /// whose own worktree the chain continues in.
    pub shared_branch: Option<String>,
    pub worktree_owner: Option<String>,
    pub report_path: Option<String>,
    /// This Operation is the step's current attempt (an older attempt is never re-bound).
    pub current: bool,
}

/// A provider account a step could run on, for route validation and alternatives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteAccount {
    pub id: String,
    pub provider_id: String,
    pub label: String,
    pub authenticated: bool,
}

/// Everything the handoff package for one step needs, read in one consistent snapshot.
#[derive(Debug, Clone)]
pub struct DeliveryContext {
    pub chain: Chain,
    pub step: ChainStep,
    pub operations: HashMap<String, OperationRecord>,
    /// Owner reference of the shared worktree (the chain, or the source agent).
    pub worktree_owner: Option<String>,
}

#[derive(Debug, Clone)]
struct ChainRow {
    id: String,
    name: String,
    goal: String,
    workspace_id: String,
    created_at: String,
    acceptance: Vec<String>,
    worktree: ChainWorktree,
    branch: Option<String>,
    worktree_owner: Option<String>,
    paused: bool,
    cancelled: bool,
    superseded_reason: Option<String>,
}

#[derive(Debug, Clone)]
struct StepRow {
    key: String,
    name: String,
    intent: ChainStepIntent,
    instructions: Option<String>,
    depends_on: Vec<String>,
    position: u32,
    operation_id: String,
    attempt: u32,
    skipped: bool,
    skip_reason: Option<String>,
    report: Option<ChainStepReport>,
    awaiting_report: bool,
}

/// The report file an agent writes. Unknown fields are rejected.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReportFile {
    version: u8,
    result: ChainStepResult,
    summary: String,
    #[serde(default)]
    tests: Vec<ReportTest>,
    #[serde(default)]
    blockers: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReportTest {
    command: String,
    passed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartFingerprint<'a> {
    request: &'a ChainStartRequest,
}

impl ChainsStore {
    pub fn new(core: Arc<Core>) -> Self {
        Self { core }
    }

    /// Validates the whole request, then atomically creates the launch, one Agent Operation per
    /// step and the chain rows. Idempotent by `request_id`.
    pub fn start(
        &self,
        request: ChainStartRequest,
        queue_limit: Option<PlanLimit>,
    ) -> Result<Chain> {
        let mut request = normalize_request(request)?;
        let source_worktree = match request.source_thread_id.as_deref() {
            Some(source) => self.source_worktree(&request.workspace_id, source)?,
            None => None,
        };
        if request.source_thread_id.is_some() {
            request.worktree = if source_worktree.is_some() {
                ChainWorktree::Shared
            } else {
                ChainWorktree::Project
            };
            if request.worktree == ChainWorktree::Shared {
                reject_parallel_writers(&request.steps)?;
            }
        }
        if request.worktree == ChainWorktree::Shared
            && source_worktree.is_none()
            && request
                .steps
                .iter()
                .filter(|step| step.depends_on.is_empty())
                .count()
                > 1
        {
            return Err(KalError::validation(
                "chain_shared_single_start",
                "A chain in a shared worktree starts with one step that creates it. Make the other first steps follow it, or use the project checkout.",
            ));
        }
        let fingerprint = fingerprint_of(
            "chain",
            &serde_json::to_string(&StartFingerprint { request: &request })?,
        );
        let snapshot_id = new_id();
        let definition = normalize_inline(SquadDefinition {
            id: snapshot_id.clone(),
            name: request.name.clone(),
            goal: request.goal.clone(),
            members: request
                .steps
                .iter()
                .map(|step| member_for(step, request.worktree, None))
                .collect(),
        })?;
        let (chain_id, _) = self.core.transact(|tx| {
            if let Some((launch_id, existing)) = tx
                .query_row(
                    "SELECT id, request_fingerprint FROM squad_launches WHERE request_id = ?1",
                    [&request.request_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?
            {
                if existing != fingerprint {
                    return Err(KalError::validation(
                        "chain_request_conflict",
                        "That chain start request was already used for different inputs.",
                    ));
                }
                return Ok((launch_id, Vec::new()));
            }
            let goal = request.goal.clone();
            let acceptance = request.acceptance.clone();
            let intents: HashMap<&str, ChainStepIntent> = request
                .steps
                .iter()
                .map(|step| (step.key.as_str(), step.intent))
                .collect();
            let prompt = |goal: &str, member: &SquadMemberDefinition| {
                let intent = intents
                    .get(member.key.as_str())
                    .copied()
                    .ok_or_else(corrupt)?;
                Ok(Some(step_prompt(
                    goal,
                    &acceptance,
                    intent,
                    member.task.as_deref(),
                )))
            };
            let (launch_id, operation_ids) = insert_launch(
                tx,
                &request.request_id,
                &fingerprint,
                LaunchPlan {
                    snapshot_id: &snapshot_id,
                    name: &request.name,
                    goal: &goal,
                    workspace_id: &request.workspace_id,
                    members: definition.members.clone(),
                    prompt: &prompt,
                },
                queue_limit,
            )?;
            let (owner, branch) = match (&source_worktree, request.worktree) {
                (Some((owner, branch)), _) => (Some(owner.clone()), Some(branch.clone())),
                (None, ChainWorktree::Shared) => (
                    Some(launch_id.clone()),
                    Some(chain_branch_name(&request.name, &launch_id)),
                ),
                (None, ChainWorktree::Project) => (None, None),
            };
            tx.execute(
                "INSERT INTO chains (launch_id, acceptance, worktree, worktree_owner_id, branch)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    launch_id,
                    serde_json::to_string(&request.acceptance)?,
                    request.worktree.as_str(),
                    owner,
                    branch
                ],
            )?;
            for (position, step) in request.steps.iter().enumerate() {
                let operation_id = operation_ids.get(&step.key).ok_or_else(corrupt)?;
                tx.execute(
                    "INSERT INTO chain_steps (
                       launch_id, step_key, name, intent, instructions, depends_on, position,
                       operation_id, attempt
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1)",
                    params![
                        launch_id,
                        step.key,
                        step.name,
                        step.intent.as_str(),
                        step.instructions,
                        serde_json::to_string(&step.depends_on)?,
                        i64::try_from(position).map_err(|_| corrupt())?,
                        operation_id
                    ],
                )?;
                tx.execute(
                    "INSERT INTO chain_step_attempts (operation_id, launch_id, step_key, attempt)
                     VALUES (?1, ?2, ?3, 1)",
                    params![operation_id, launch_id, step.key],
                )?;
            }
            Ok((launch_id, Vec::new()))
        })?;
        self.get(&chain_id)
    }

    /// The source agent's own active KalCode worktree (owner and branch), or `None` when it
    /// works in the project checkout. The agent must belong to the chain's workspace.
    fn source_worktree(
        &self,
        workspace_id: &str,
        source: &str,
    ) -> Result<Option<(String, String)>> {
        if !is_valid_id(source) {
            return Err(KalError::validation(
                "invalid_chain_source",
                "That coding agent reference isn't valid.",
            ));
        }
        self.core.read(|conn| {
            let thread_workspace: Option<String> = conn
                .query_row(
                    "SELECT workspace_id FROM threads WHERE id = ?1",
                    [source],
                    |row| row.get(0),
                )
                .optional()?;
            if thread_workspace.as_deref() != Some(workspace_id) {
                return Err(KalError::validation(
                    "chain_source_unavailable",
                    "The coding agent this chain continues is not in this project.",
                ));
            }
            Ok(conn
                .query_row(
                    "SELECT owner_ref, branch FROM git_worktrees
                     WHERE owner_ref = ?1 AND workspace_id = ?2 AND purpose = 'thread'
                       AND status = 'active'
                     ORDER BY created_at DESC LIMIT 1",
                    params![source, workspace_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?)
        })
    }

    pub fn get(&self, id: &str) -> Result<Chain> {
        validate_id(id)?;
        let (row, steps) = self.core.read(|conn| {
            let row = load_chain(conn, id)?.ok_or_else(chain_not_found)?;
            Ok((row, load_steps(conn, id)?))
        })?;
        let operations = self.operations_for(&steps)?;
        Ok(derive_chain(&row, &steps, &operations))
    }

    /// Recent and active chains (optionally one workspace) plus exactly their step Operations.
    pub fn snapshot(&self, workspace_id: Option<&str>) -> Result<ChainsSnapshot> {
        if let Some(id) = workspace_id {
            validate_id(id)?;
        }
        let rows = self.core.read(|conn| {
            let ids = recent_chain_ids(conn, workspace_id)?;
            ids.into_iter()
                .map(|id| {
                    let row = load_chain(conn, &id)?.ok_or_else(corrupt)?;
                    let steps = load_steps(conn, &id)?;
                    Ok((row, steps))
                })
                .collect::<Result<Vec<_>>>()
        })?;
        let all_steps = rows
            .iter()
            .flat_map(|(_, steps)| steps.iter().cloned())
            .collect::<Vec<_>>();
        let operations = self.operations_for(&all_steps)?;
        let chains = rows
            .iter()
            .map(|(row, steps)| derive_chain(row, steps, &operations))
            .collect();
        let mut ids = all_steps
            .iter()
            .map(|step| step.operation_id.as_str())
            .collect::<Vec<_>>();
        ids.sort_unstable();
        ids.dedup();
        Ok(ChainsSnapshot {
            chains,
            operations: ids
                .into_iter()
                .filter_map(|id| operations.get(id).cloned())
                .collect(),
        })
    }

    /// The chain binding of an Operation, when it is a chain step attempt.
    pub fn binding(&self, operation_id: &str) -> Result<Option<StepBinding>> {
        if !is_valid_id(operation_id) {
            return Ok(None);
        }
        self.core.read(|conn| {
            let Some((launch_id, step_key)) = conn
                .query_row(
                    "SELECT launch_id, step_key FROM chain_step_attempts WHERE operation_id = ?1",
                    [operation_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?
            else {
                return Ok(None);
            };
            let chain = load_chain(conn, &launch_id)?.ok_or_else(corrupt)?;
            let (intent, current_id, report_path): (String, String, Option<String>) = conn
                .query_row(
                    "SELECT intent, operation_id, report_path FROM chain_steps
                     WHERE launch_id = ?1 AND step_key = ?2",
                    params![launch_id, step_key],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?;
            Ok(Some(StepBinding {
                chain_id: launch_id,
                step_key,
                intent: parse_intent(&intent)?,
                worktree: chain.worktree,
                shared_branch: chain.branch,
                worktree_owner: chain.worktree_owner,
                current: current_id == operation_id,
                report_path: (current_id == operation_id)
                    .then_some(report_path)
                    .flatten(),
            }))
        })
    }

    pub fn delivery_context(&self, operation_id: &str) -> Result<Option<DeliveryContext>> {
        let Some(binding) = self.binding(operation_id)? else {
            return Ok(None);
        };
        let (row, steps) = self.core.read(|conn| {
            let row = load_chain(conn, &binding.chain_id)?.ok_or_else(corrupt)?;
            Ok((row, load_steps(conn, &binding.chain_id)?))
        })?;
        let operations = self.operations_for(&steps)?;
        let chain = derive_chain(&row, &steps, &operations);
        let step = chain
            .steps
            .iter()
            .find(|step| step.key == binding.step_key)
            .cloned()
            .ok_or_else(corrupt)?;
        Ok(Some(DeliveryContext {
            chain,
            step,
            operations,
            worktree_owner: row.worktree_owner,
        }))
    }

    /// Records where the current attempt was asked to write its report.
    pub fn set_report_path(&self, operation_id: &str, path: &Path) -> Result<()> {
        let path = path.to_string_lossy().into_owned();
        self.write(|tx| {
            tx.execute(
                "UPDATE chain_steps SET report_path = ?2, awaiting_report = 0
                 WHERE operation_id = ?1",
                params![operation_id, path],
            )?;
            Ok(())
        })
    }

    /// The provider turn ended without a report: the step now needs the person.
    pub fn mark_awaiting_report(&self, operation_id: &str) -> Result<bool> {
        self.write(|tx| {
            Ok(tx.execute(
                "UPDATE chain_steps SET awaiting_report = 1
                 WHERE operation_id = ?1 AND awaiting_report = 0 AND report IS NULL",
                [operation_id],
            )? > 0)
        })
    }

    /// Reads and consumes the current attempt's report file, when the agent wrote one.
    pub fn collect_report(&self, operation_id: &str) -> Result<Option<ChainStepReport>> {
        let Some(binding) = self.binding(operation_id)? else {
            return Ok(None);
        };
        let Some(path) = binding.report_path.filter(|_| binding.current) else {
            return Ok(None);
        };
        let path = Path::new(&path);
        let report = match read_report_file(path) {
            Ok(Some(report)) => report,
            Ok(None) => return Ok(None),
            Err(error) => {
                // A malformed report is the agent's output, not a KalCode failure: surface it
                // truthfully as a failed step so the person can see why.
                tracing::info!(event = "chain.report_rejected", code = error.code);
                ChainStepReport {
                    result: ChainStepResult::Failed,
                    summary: format!("The step report could not be read: {}", error.message),
                    tests: Vec::new(),
                    blockers: Vec::new(),
                    source: ChainReportSource::Agent,
                    recorded_at: now_rfc3339(),
                }
            }
        };
        self.store_report(operation_id, &report)?;
        let _ = std::fs::remove_file(path);
        Ok(Some(report))
    }

    /// A report already stored for the current attempt (for example when settling it was
    /// interrupted after the report was read), so it still decides the step.
    pub fn stored_report(&self, operation_id: &str) -> Result<Option<ChainStepReport>> {
        self.core.read(|conn| {
            let encoded: Option<Option<String>> = conn
                .query_row(
                    "SELECT report FROM chain_steps WHERE operation_id = ?1",
                    [operation_id],
                    |row| row.get(0),
                )
                .optional()?;
            Ok(encoded
                .flatten()
                .as_deref()
                .map(serde_json::from_str)
                .transpose()?)
        })
    }

    /// True when an earlier attempt of another step in this chain already started an agent, so
    /// a missing shared worktree means work was lost rather than not yet created.
    pub fn earlier_work_started(&self, operation_id: &str) -> Result<bool> {
        let Some(binding) = self.binding(operation_id)? else {
            return Ok(false);
        };
        self.core.read(|conn| {
            Ok(conn.query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM chain_step_attempts a JOIN operations o ON o.id = a.operation_id
                   WHERE a.launch_id = ?1 AND a.operation_id <> ?2 AND o.thread_id IS NOT NULL)",
                params![binding.chain_id, operation_id],
                |row| row.get(0),
            )?)
        })
    }

    fn store_report(&self, operation_id: &str, report: &ChainStepReport) -> Result<()> {
        let encoded = serde_json::to_string(report)?;
        self.write(|tx| {
            tx.execute(
                "UPDATE chain_steps SET report = ?2, awaiting_report = 0 WHERE operation_id = ?1",
                params![operation_id, encoded],
            )?;
            Ok(())
        })
    }

    /// Every non-archived provider account, for validating a step's route.
    pub fn route_accounts(&self) -> Result<Vec<RouteAccount>> {
        self.core.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, provider_id, display_name, authentication_state FROM provider_accounts
                 WHERE archived_at IS NULL ORDER BY provider_id, display_name",
            )?;
            Ok(stmt
                .query_map([], |row| {
                    Ok(RouteAccount {
                        id: row.get(0)?,
                        provider_id: row.get(1)?,
                        label: row.get(2)?,
                        authenticated: row.get::<_, String>(3)? != "not_authenticated",
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?)
        })
    }

    /// Holds every step that has not started. Running steps keep running.
    pub fn pause(&self, id: &str) -> Result<Vec<String>> {
        self.set_paused(id, true)
    }

    /// Releases held steps; returns the Operations to re-authorize.
    pub fn resume(&self, id: &str) -> Result<Vec<String>> {
        self.set_paused(id, false)
    }

    fn set_paused(&self, id: &str, paused: bool) -> Result<Vec<String>> {
        validate_id(id)?;
        let steps = self.core.read(|conn| {
            let row = load_chain(conn, id)?.ok_or_else(chain_not_found)?;
            if row.cancelled || row.superseded_reason.is_some() {
                return Err(KalError::validation(
                    "chain_finished",
                    "This chain is no longer running.",
                ));
            }
            load_steps(conn, id)
        })?;
        self.write(|tx| {
            tx.execute(
                "UPDATE chains SET paused = ?2 WHERE launch_id = ?1",
                params![id, paused],
            )?;
            Ok(())
        })?;
        let operations = OperationsStore::new(self.core.clone());
        let mut changed = Vec::new();
        for step in steps.iter().filter(|step| !step.skipped) {
            let status = operations.get(&step.operation_id)?.status;
            let held = status == OperationStatus::Paused;
            let pending = matches!(status, OperationStatus::Queued | OperationStatus::Blocked);
            if (paused && pending) || (!paused && held) {
                match operations.hold(&step.operation_id, paused) {
                    Ok(()) => changed.push(step.operation_id.clone()),
                    // Only pending tasks can be held; one that just started keeps running.
                    Err(error) if error.code == "operation_not_pending" => {}
                    Err(error) => return Err(error),
                }
            }
        }
        Ok(changed)
    }

    /// Cancels every step that has not started. Started terminals stay with the person.
    pub fn cancel(&self, id: &str) -> Result<()> {
        validate_id(id)?;
        let steps = self.core.read(|conn| {
            load_chain(conn, id)?.ok_or_else(chain_not_found)?;
            load_steps(conn, id)
        })?;
        self.write(|tx| {
            tx.execute(
                "UPDATE chains SET cancelled = 1, paused = 0 WHERE launch_id = ?1",
                [id],
            )?;
            Ok(())
        })?;
        self.cancel_pending_steps(&steps)
    }

    /// Cancels the unstarted steps of a chain whose branch already landed through newer work.
    pub fn supersede(&self, id: &str, reason: &str) -> Result<()> {
        validate_id(id)?;
        let reason = clean_line(reason, 512);
        let steps = self.core.read(|conn| {
            load_chain(conn, id)?.ok_or_else(chain_not_found)?;
            load_steps(conn, id)
        })?;
        self.write(|tx| {
            tx.execute(
                "UPDATE chains SET superseded_reason = ?2, paused = 0
                 WHERE launch_id = ?1 AND superseded_reason IS NULL",
                params![id, reason],
            )?;
            Ok(())
        })?;
        self.cancel_pending_steps(&steps)
    }

    fn cancel_pending_steps(&self, steps: &[StepRow]) -> Result<()> {
        let operations = OperationsStore::new(self.core.clone());
        for step in steps {
            match operations.cancel_pending(&step.operation_id) {
                Ok(()) => {}
                Err(error) if error.code == "operation_not_pending" => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    /// Starts a new attempt of a failed, cancelled or interrupted step and rewires its
    /// dependents to it. Returns the Operations to authorize.
    pub fn retry_step(
        &self,
        id: &str,
        key: &str,
        route: Option<ChainStepRoute>,
    ) -> Result<Vec<String>> {
        validate_id(id)?;
        let operations = OperationsStore::new(self.core.clone());
        let (row, steps) = self.core.read(|conn| {
            let row = load_chain(conn, id)?.ok_or_else(chain_not_found)?;
            Ok((row, load_steps(conn, id)?))
        })?;
        if row.cancelled || row.superseded_reason.is_some() {
            return Err(KalError::validation(
                "chain_finished",
                "This chain is no longer running.",
            ));
        }
        let step = steps
            .iter()
            .find(|step| step.key == key)
            .ok_or_else(step_not_found)?;
        let current = operations.get(&step.operation_id)?;
        let changes_requested = current.status == OperationStatus::Succeeded
            && step
                .report
                .as_ref()
                .is_some_and(|report| report.result == ChainStepResult::ChangesRequested);
        let awaiting = current.status == OperationStatus::Running && step.awaiting_report;
        let retryable = !step.skipped
            && (changes_requested
                || awaiting
                || matches!(
                    current.status,
                    OperationStatus::Failed
                        | OperationStatus::Cancelled
                        | OperationStatus::Interrupted
                ));
        if !retryable {
            return Err(KalError::validation(
                "chain_step_not_retryable",
                "Only a failed, cancelled, interrupted or unreported step, or a review that asked for changes, can be retried.",
            ));
        }
        if awaiting {
            // The earlier attempt's agent stays open under the person's control; its run ends.
            operations.finish(
                &step.operation_id,
                OperationStatus::Interrupted,
                "Retried in its chain; this attempt never reported.",
            )?;
        }
        let route = match route {
            Some(route) => normalize_route(route)?,
            None => ChainStepRoute {
                provider_id: current.spec.provider_id.clone().unwrap_or_default(),
                provider_account_id: current.spec.provider_account_id.clone().unwrap_or_default(),
                model: current.spec.model.clone().unwrap_or_default(),
                effort: current.spec.effort.clone().unwrap_or_default(),
            },
        };
        let definition = ChainStepDefinition {
            key: step.key.clone(),
            name: step.name.clone(),
            intent: step.intent,
            provider_id: route.provider_id,
            provider_account_id: route.provider_account_id,
            model: route.model,
            effort: route.effort,
            instructions: step.instructions.clone(),
            depends_on: step.depends_on.clone(),
        };
        let member = member_for(&definition, row.worktree, None);
        let new_operation = new_id();
        let attempt = step.attempt + 1;
        let by_key: HashMap<&str, &StepRow> =
            steps.iter().map(|step| (step.key.as_str(), step)).collect();
        self.core.transact(|tx| {
            let dependencies = effective_dependencies(&by_key, &step.depends_on);
            let member_key = format!("{}~{attempt}", step.key);
            insert_member_operation(
                tx,
                MemberOperation {
                    launch_id: id,
                    workspace_id: &row.workspace_id,
                    operation_id: &new_operation,
                    member: &member,
                    member_key: &member_key,
                    prompt: Some(step_prompt(
                        &row.goal,
                        &row.acceptance,
                        step.intent,
                        member.task.as_deref(),
                    )),
                    dependencies,
                    queue_position: next_queue_position(tx)?,
                    member_position: i64::from(step.position),
                    created_at: &now_rfc3339(),
                    moment: "Added by a chain retry.",
                },
            )?;
            tx.execute(
                "UPDATE chain_steps SET operation_id = ?3, attempt = ?4, report = NULL,
                    report_path = NULL, awaiting_report = 0, skipped = 0, skip_reason = NULL
                 WHERE launch_id = ?1 AND step_key = ?2 AND operation_id = ?5",
                params![id, step.key, new_operation, attempt, step.operation_id],
            )?
            .eq(&1)
            .then_some(())
            .ok_or_else(step_changed)?;
            tx.execute(
                "INSERT INTO chain_step_attempts (operation_id, launch_id, step_key, attempt)
                 VALUES (?1, ?2, ?3, ?4)",
                params![new_operation, id, step.key, attempt],
            )?;
            rewire_dependents(
                tx,
                &steps,
                &step.operation_id,
                std::slice::from_ref(&new_operation),
            )?;
            refresh_pending(tx)?;
            Ok(((), Vec::new()))
        })?;
        if row.paused {
            // A paused chain holds every step that has not started, including this new attempt.
            operations.hold(&new_operation, true)?;
            return Ok(Vec::new());
        }
        let mut authorize = vec![new_operation];
        authorize.extend(pending_dependents(&operations, &steps, key)?);
        Ok(authorize)
    }

    /// Lets dependents continue without this step. A pending attempt is cancelled; a running one
    /// is settled as cancelled (its terminal stays open). Returns Operations to re-authorize.
    pub fn skip_step(&self, id: &str, key: &str, reason: &str) -> Result<Vec<String>> {
        validate_id(id)?;
        let operations = OperationsStore::new(self.core.clone());
        let steps = self.core.read(|conn| {
            load_chain(conn, id)?.ok_or_else(chain_not_found)?;
            load_steps(conn, id)
        })?;
        let step = steps
            .iter()
            .find(|step| step.key == key)
            .ok_or_else(step_not_found)?;
        if step.skipped {
            return Ok(Vec::new());
        }
        let current = operations.get(&step.operation_id)?;
        match current.status {
            OperationStatus::Queued | OperationStatus::Blocked | OperationStatus::Paused => {
                operations.cancel_pending(&step.operation_id)?;
            }
            OperationStatus::Running if step.awaiting_report => {
                operations.finish(
                    &step.operation_id,
                    OperationStatus::Cancelled,
                    "Skipped in its chain; the terminal stays open.",
                )?;
            }
            OperationStatus::Starting | OperationStatus::Running => {
                return Err(KalError::validation(
                    "chain_step_running",
                    "This step is working. Wait for it to finish, or open the agent and stop it first.",
                ));
            }
            OperationStatus::Succeeded => {
                return Err(KalError::validation(
                    "chain_step_finished",
                    "This step already finished.",
                ));
            }
            _ => {}
        }
        let by_key: HashMap<&str, &StepRow> =
            steps.iter().map(|step| (step.key.as_str(), step)).collect();
        let replacement = effective_dependencies(&by_key, &step.depends_on);
        let reason = clean_line(reason, 512);
        self.core.transact(|tx| {
            tx.execute(
                "UPDATE chain_steps SET skipped = 1, skip_reason = ?3, awaiting_report = 0
                 WHERE launch_id = ?1 AND step_key = ?2 AND operation_id = ?4 AND skipped = 0",
                params![id, key, reason, step.operation_id],
            )?
            .eq(&1)
            .then_some(())
            .ok_or_else(step_changed)?;
            rewire_dependents(tx, &steps, &step.operation_id, &replacement)?;
            refresh_pending(tx)?;
            Ok(((), Vec::new()))
        })?;
        pending_dependents(&operations, &steps, key)
    }

    /// Changes the route of a step that has not started.
    pub fn reroute_step(&self, id: &str, key: &str, route: ChainStepRoute) -> Result<String> {
        validate_id(id)?;
        let route = normalize_route(route)?;
        let operations = OperationsStore::new(self.core.clone());
        let steps = self.core.read(|conn| {
            load_chain(conn, id)?.ok_or_else(chain_not_found)?;
            load_steps(conn, id)
        })?;
        let step = steps
            .iter()
            .find(|step| step.key == key)
            .ok_or_else(step_not_found)?;
        let current = operations.get(&step.operation_id)?;
        if !matches!(
            current.status,
            OperationStatus::Queued | OperationStatus::Blocked | OperationStatus::Paused
        ) || current.thread_id.is_some()
        {
            return Err(KalError::validation(
                "chain_step_started",
                "Only a step that has not started can be rerouted. Retry it on another agent instead.",
            ));
        }
        let mut spec = current.spec.clone();
        spec.provider_id = Some(route.provider_id);
        spec.provider_account_id = Some(route.provider_account_id);
        spec.model = Some(route.model);
        spec.effort = Some(route.effort);
        let revision = operations.revision()?;
        operations.update(&step.operation_id, spec, revision)?;
        Ok(step.operation_id.clone())
    }

    /// The person's explicit outcome for a step. A running attempt is settled to match.
    pub fn record_step(
        &self,
        id: &str,
        key: &str,
        result: ChainStepResult,
        summary: &str,
    ) -> Result<()> {
        validate_id(id)?;
        let operations = OperationsStore::new(self.core.clone());
        let steps = self.core.read(|conn| {
            load_chain(conn, id)?.ok_or_else(chain_not_found)?;
            load_steps(conn, id)
        })?;
        let step = steps
            .iter()
            .find(|step| step.key == key)
            .ok_or_else(step_not_found)?;
        let current = operations.get(&step.operation_id)?;
        if !matches!(
            current.status,
            OperationStatus::Running | OperationStatus::Starting
        ) && !step.awaiting_report
        {
            return Err(KalError::validation(
                "chain_step_not_running",
                "Only a step that is running or waiting for its report can be recorded.",
            ));
        }
        let summary = clean_text(summary, MAX_SUMMARY_CHARS);
        let report = ChainStepReport {
            result,
            summary: if summary.is_empty() {
                "Recorded by you.".to_owned()
            } else {
                summary
            },
            tests: Vec::new(),
            blockers: Vec::new(),
            source: ChainReportSource::You,
            recorded_at: now_rfc3339(),
        };
        self.store_report(&step.operation_id, &report)?;
        if matches!(
            current.status,
            OperationStatus::Running | OperationStatus::Starting
        ) {
            operations.finish(
                &step.operation_id,
                settlement_status(result),
                settlement_outcome(&report).as_str(),
            )?;
        }
        Ok(())
    }

    /// Automatic, truthful chain rules applied by the Operations tick before dispatch:
    /// a Fix step whose reviews all passed is skipped (never marked passed).
    pub fn apply_rules(&self) -> Result<Vec<String>> {
        let candidates = self.core.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT s.launch_id, s.step_key FROM chain_steps s
                 JOIN chains c ON c.launch_id = s.launch_id
                 JOIN operations o ON o.id = s.operation_id
                 WHERE s.intent = 'fix' AND s.skipped = 0 AND c.cancelled = 0
                   AND c.superseded_reason IS NULL AND o.status = 'queued'
                   AND o.thread_id IS NULL",
            )?;
            Ok(stmt
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?)
        })?;
        let mut authorize = Vec::new();
        for (chain_id, key) in candidates {
            let steps = self.core.read(|conn| load_steps(conn, &chain_id))?;
            let Some(step) = steps.iter().find(|step| step.key == key) else {
                continue;
            };
            let by_key: HashMap<&str, &StepRow> =
                steps.iter().map(|step| (step.key.as_str(), step)).collect();
            // Only when nothing before the Fix asked for changes: every non-skipped dependency
            // passed, and at least one of them was a review.
            let dependencies = step
                .depends_on
                .iter()
                .filter_map(|dep| by_key.get(dep.as_str()))
                .filter(|dep| !dep.skipped)
                .collect::<Vec<_>>();
            let all_passed = dependencies
                .iter()
                .any(|dep| dep.intent == ChainStepIntent::Review)
                && dependencies.iter().all(|dep| {
                    dep.report
                        .as_ref()
                        .is_some_and(|report| report.result == ChainStepResult::Passed)
                });
            if all_passed {
                authorize.extend(self.skip_step(&chain_id, &key, FIX_SKIP_REASON)?);
            }
        }
        Ok(authorize)
    }

    /// Shared-worktree chains that still have unstarted steps, for supersession checks.
    /// `(chain id, workspace id, branch, worktree owner)` for supersession checks.
    pub fn open_shared_chains(&self) -> Result<Vec<(String, String, String, String)>> {
        self.core.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT c.launch_id, l.workspace_id, c.branch, c.worktree_owner_id FROM chains c
                 JOIN squad_launches l ON l.id = c.launch_id
                 WHERE c.worktree = 'shared' AND c.cancelled = 0
                   AND c.superseded_reason IS NULL AND c.branch IS NOT NULL
                   AND c.worktree_owner_id IS NOT NULL
                   AND EXISTS (
                     SELECT 1 FROM chain_steps s JOIN operations o ON o.id = s.operation_id
                     WHERE s.launch_id = c.launch_id AND s.skipped = 0
                       AND o.status IN ('queued', 'paused', 'blocked')
                   )",
            )?;
            Ok(stmt
                .query_map([], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?)
        })
    }

    fn operations_for(&self, steps: &[StepRow]) -> Result<HashMap<String, OperationRecord>> {
        let ids = steps
            .iter()
            .map(|step| step.operation_id.clone())
            .collect::<Vec<_>>();
        Ok(OperationsStore::new(self.core.clone())
            .get_many(&ids)?
            .into_iter()
            .map(|record| (record.id.clone(), record))
            .collect())
    }

    fn write<T>(&self, work: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let (value, _) = self.core.transact(|tx| Ok((work(tx)?, Vec::new())))?;
        Ok(value)
    }
}

/// Operation status a recorded or reported result settles to.
pub fn settlement_status(result: ChainStepResult) -> OperationStatus {
    match result {
        ChainStepResult::Passed | ChainStepResult::ChangesRequested => OperationStatus::Succeeded,
        ChainStepResult::Failed => OperationStatus::Failed,
    }
}

/// Short Run outcome text for a settled step.
pub fn settlement_outcome(report: &ChainStepReport) -> String {
    let lead = match report.result {
        ChainStepResult::Passed => "Step passed.",
        ChainStepResult::ChangesRequested => "Review requested changes.",
        ChainStepResult::Failed => "Step failed.",
    };
    let mut outcome = format!("{lead} {}", report.summary);
    if outcome.chars().count() > 480 {
        outcome = outcome.chars().take(479).collect::<String>() + "…";
    }
    outcome
}

/// Parses one report file. `Ok(None)` when it does not exist yet.
pub fn read_report_file(path: &Path) -> Result<Option<ChainStepReport>> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(report_invalid("it is not readable")),
    };
    if !metadata.is_file() || crate::protected_file::is_link_or_reparse(&metadata) {
        return Err(report_invalid("it is not an ordinary file"));
    }
    // The report folder and its `.kalcode` parent must be real folders, never links elsewhere.
    for folder in path.ancestors().skip(1).take(2) {
        let linked = std::fs::symlink_metadata(folder)
            .map(|metadata| crate::protected_file::is_link_or_reparse(&metadata))
            .unwrap_or(true);
        if linked {
            return Err(report_invalid("its folder is a link"));
        }
    }
    let expected = std::fs::canonicalize(path).map_err(|_| report_invalid("it is not readable"))?;
    let bytes =
        crate::protected_file::read_bounded_ordinary_file(path, &expected, MAX_REPORT_BYTES)
            .ok_or_else(|| report_invalid("it is larger than 64 KiB or not an ordinary file"))?;
    parse_report(&bytes).map(Some)
}

pub fn parse_report(bytes: &[u8]) -> Result<ChainStepReport> {
    let file: ReportFile = serde_json::from_slice(bytes)
        .map_err(|_| report_invalid("it is not the documented JSON shape"))?;
    if file.version != 1 {
        return Err(report_invalid("its version is not 1"));
    }
    Ok(ChainStepReport {
        result: file.result,
        summary: clean_text(&file.summary, MAX_SUMMARY_CHARS),
        tests: file
            .tests
            .into_iter()
            .take(MAX_TESTS)
            .map(|test| ChainTestRun {
                command: clean_line(&test.command, MAX_LINE_CHARS),
                passed: test.passed,
            })
            .filter(|test| !test.command.is_empty())
            .collect(),
        blockers: file
            .blockers
            .into_iter()
            .take(MAX_BLOCKERS)
            .map(|blocker| clean_line(&blocker, MAX_LINE_CHARS))
            .filter(|blocker| !blocker.is_empty())
            .collect(),
        source: ChainReportSource::Agent,
        recorded_at: now_rfc3339(),
    })
}

/// The static task recorded on each step's Operation (what Runs show). The full handoff package,
/// with earlier steps' outcomes, is built at delivery time.
pub fn step_prompt(
    goal: &str,
    acceptance: &[String],
    intent: ChainStepIntent,
    instructions: Option<&str>,
) -> String {
    let mut prompt = format!(
        "{} step of a KalCode handoff chain.\nGoal — {goal}",
        intent.label()
    );
    if !acceptance.is_empty() {
        prompt.push_str("\nAcceptance criteria —");
        for item in acceptance {
            prompt.push_str("\n- ");
            prompt.push_str(item);
        }
    }
    if let Some(instructions) = instructions {
        prompt.push_str("\nInstructions — ");
        prompt.push_str(instructions);
    }
    prompt
}

/// The intent's action line in the delivered package.
pub fn intent_action(intent: ChainStepIntent) -> &'static str {
    match intent {
        ChainStepIntent::Implement => {
            "Implement the goal in this working tree. Run the relevant tests before reporting."
        }
        ChainStepIntent::Review => {
            "Review the changes in this working tree against the goal and acceptance criteria. Do not edit files. Report `passed` when it is ready, `changes_requested` with concrete blockers when it is not."
        }
        ChainStepIntent::Fix => {
            "Address every blocker reported by the earlier steps in this working tree, then run the relevant tests."
        }
        ChainStepIntent::Test => {
            "Run the project's relevant tests and checks for these changes. Do not edit source files. Report `failed` with the failing commands if anything fails."
        }
        ChainStepIntent::Continue => {
            "Continue the work from where the earlier steps left it, in this working tree."
        }
    }
}

fn member_for(
    step: &ChainStepDefinition,
    worktree: ChainWorktree,
    task: Option<String>,
) -> SquadMemberDefinition {
    SquadMemberDefinition {
        key: step.key.clone(),
        name: step.name.clone(),
        provider_id: step.provider_id.clone(),
        provider_account_id: step.provider_account_id.clone(),
        model: step.model.clone(),
        effort: step.effort.clone(),
        role: step.intent.label().to_owned(),
        task: task.or_else(|| {
            Some(
                step.instructions
                    .clone()
                    .unwrap_or_else(|| intent_action(step.intent).to_owned()),
            )
        }),
        worktree: worktree == ChainWorktree::Shared,
        depends_on: step.depends_on.clone(),
        manager_key: None,
        owned_paths: Vec::new(),
    }
}

fn normalize_request(mut request: ChainStartRequest) -> Result<ChainStartRequest> {
    if request.request_id.trim().is_empty() || request.request_id.len() > 128 {
        return Err(KalError::validation(
            "invalid_chain_request",
            "A chain start needs a request identifier.",
        ));
    }
    validate_id(&request.workspace_id)?;
    request.goal = clean_text(&request.goal, 16 * 1024);
    if request.goal.is_empty() {
        return Err(KalError::validation(
            "invalid_chain_goal",
            "Describe the goal for this chain.",
        ));
    }
    request.name = clean_line(&request.name, 120);
    if request.name.is_empty() {
        request.name = clean_line(&request.goal, 60);
    }
    if request.acceptance.len() > MAX_ACCEPTANCE {
        return Err(KalError::validation(
            "invalid_chain_acceptance",
            "A chain can list at most 20 acceptance criteria.",
        ));
    }
    request.acceptance = request
        .acceptance
        .iter()
        .map(|item| clean_line(item, MAX_ACCEPTANCE_BYTES))
        .filter(|item| !item.is_empty())
        .collect();
    if request.steps.is_empty() || request.steps.len() > MAX_STEPS {
        return Err(KalError::validation(
            "invalid_chain_steps",
            "A chain needs between 1 and 12 steps.",
        ));
    }
    let mut seen = HashSet::new();
    for step in &mut request.steps {
        step.key = step.key.trim().to_ascii_lowercase();
        if step.key.is_empty()
            || step.key.len() > 40
            || !step
                .key
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err(KalError::validation(
                "invalid_chain_step_key",
                "Each step needs a short key of letters, numbers, - or _.",
            ));
        }
        if !seen.insert(step.key.clone()) {
            return Err(KalError::validation(
                "chain_step_key_conflict",
                "Every step in a chain needs a distinct key.",
            ));
        }
        step.name = clean_line(&step.name, 120);
        if step.name.is_empty() {
            step.name = step.intent.label().to_owned();
        }
        step.instructions = step
            .instructions
            .as_deref()
            .map(|text| clean_text(text, MAX_INSTRUCTIONS_BYTES))
            .filter(|text| !text.is_empty());
        for dependency in &mut step.depends_on {
            *dependency = dependency.trim().to_ascii_lowercase();
        }
    }
    let keys: HashMap<&str, usize> = request
        .steps
        .iter()
        .enumerate()
        .map(|(index, step)| (step.key.as_str(), index))
        .collect();
    for (index, step) in request.steps.iter().enumerate() {
        for dependency in &step.depends_on {
            match keys.get(dependency.as_str()) {
                Some(position) if *position < index => {}
                _ => {
                    return Err(KalError::validation(
                        "invalid_chain_dependency",
                        "A step can only follow steps listed before it.",
                    ));
                }
            }
        }
    }
    if request.worktree == ChainWorktree::Shared {
        reject_parallel_writers(&request.steps)?;
    }
    Ok(request)
}

/// In one shared tree, two writing steps must be ordered: one has to follow the other.
fn reject_parallel_writers(steps: &[ChainStepDefinition]) -> Result<()> {
    let writers = steps
        .iter()
        .filter(|step| !step.intent.read_only())
        .collect::<Vec<_>>();
    for (index, left) in writers.iter().enumerate() {
        for right in writers.iter().skip(index + 1) {
            if !reaches(steps, &right.key, &left.key) && !reaches(steps, &left.key, &right.key) {
                return Err(KalError::validation(
                    "chain_parallel_writers",
                    format!(
                        "{} and {} would edit the shared worktree at the same time. Make one follow the other, or use the project checkout.",
                        left.name, right.name
                    ),
                ));
            }
        }
    }
    Ok(())
}

fn reaches(steps: &[ChainStepDefinition], from: &str, target: &str) -> bool {
    let by_key: HashMap<&str, &ChainStepDefinition> =
        steps.iter().map(|step| (step.key.as_str(), step)).collect();
    let mut stack = vec![from];
    let mut seen = HashSet::new();
    while let Some(key) = stack.pop() {
        if !seen.insert(key) {
            continue;
        }
        let Some(step) = by_key.get(key) else {
            continue;
        };
        for dependency in &step.depends_on {
            if dependency == target {
                return true;
            }
            stack.push(dependency.as_str());
        }
    }
    false
}

fn normalize_route(mut route: ChainStepRoute) -> Result<ChainStepRoute> {
    route.provider_id = route.provider_id.trim().to_owned();
    route.model = route.model.trim().to_owned();
    route.effort = route.effort.trim().to_owned();
    if route.provider_id.is_empty() || route.provider_id.len() > 64 {
        return Err(KalError::validation(
            "invalid_chain_route",
            "Choose a provider for this step.",
        ));
    }
    if !is_valid_id(&route.provider_account_id) {
        return Err(KalError::validation(
            "invalid_chain_route",
            "Choose a provider account for this step.",
        ));
    }
    if route.model.len() > 128 || route.effort.len() > 32 {
        return Err(KalError::validation(
            "invalid_chain_route",
            "That model or effort isn't valid.",
        ));
    }
    Ok(route)
}

/// Operations a step should wait for: its dependencies' current attempts, looking through
/// skipped dependencies to what they depended on.
fn effective_dependencies(by_key: &HashMap<&str, &StepRow>, depends_on: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = depends_on.iter().rev().cloned().collect::<Vec<_>>();
    let mut seen = HashSet::new();
    while let Some(key) = stack.pop() {
        if !seen.insert(key.clone()) {
            continue;
        }
        let Some(step) = by_key.get(key.as_str()) else {
            continue;
        };
        if step.skipped {
            stack.extend(step.depends_on.iter().rev().cloned());
        } else if !out.contains(&step.operation_id) {
            out.push(step.operation_id.clone());
        }
    }
    out
}

/// Replaces `old` with `replacement` in every pending step attempt that waited for it.
fn rewire_dependents(
    tx: &Connection,
    steps: &[StepRow],
    old: &str,
    replacement: &[String],
) -> Result<()> {
    for step in steps {
        let encoded: Option<String> = tx
            .query_row(
                "SELECT dependencies FROM operations WHERE id = ?1",
                [&step.operation_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(encoded) = encoded else { continue };
        let current: Vec<String> = serde_json::from_str(&encoded)?;
        if !current.iter().any(|id| id == old) {
            continue;
        }
        let mut next = Vec::new();
        for id in current {
            if id == old {
                for new in replacement {
                    if !next.contains(new) {
                        next.push(new.clone());
                    }
                }
            } else if !next.contains(&id) {
                next.push(id);
            }
        }
        replace_pending_dependencies(
            tx,
            &step.operation_id,
            &next,
            "Chain dependency updated by a retry or skip.",
        )?;
    }
    bump_operations_revision(tx)
}

/// Pending attempts that (transitively) follow `key`; their consent must be renewed.
fn pending_dependents(
    operations: &OperationsStore,
    steps: &[StepRow],
    key: &str,
) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for step in steps {
        if step.key == key || step.skipped || !follows(steps, &step.key, key) {
            continue;
        }
        let status = operations.get(&step.operation_id)?.status;
        if matches!(
            status,
            OperationStatus::Queued | OperationStatus::Blocked | OperationStatus::Paused
        ) {
            out.push(step.operation_id.clone());
        }
    }
    Ok(out)
}

fn follows(steps: &[StepRow], from: &str, target: &str) -> bool {
    let by_key: HashMap<&str, &StepRow> = steps.iter().map(|s| (s.key.as_str(), s)).collect();
    let mut stack = vec![from];
    let mut seen = HashSet::new();
    while let Some(key) = stack.pop() {
        if !seen.insert(key) {
            continue;
        }
        if let Some(step) = by_key.get(key) {
            for dependency in &step.depends_on {
                if dependency == target {
                    return true;
                }
                stack.push(dependency.as_str());
            }
        }
    }
    false
}

/// Derives every phase, reason and the chain's next action. Pure; never persisted.
fn derive_chain(
    row: &ChainRow,
    steps: &[StepRow],
    operations: &HashMap<String, OperationRecord>,
) -> Chain {
    let mut phases: HashMap<&str, ChainStepPhase> = HashMap::new();
    let mut derived = Vec::with_capacity(steps.len());
    // Steps are stored in dependency order (dependencies always come first).
    let mut ordered = steps.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|step| step.position);
    for step in &ordered {
        let operation = operations.get(&step.operation_id);
        let (phase, reason) = step_phase(row, step, operation, &phases, steps);
        phases.insert(step.key.as_str(), phase);
        derived.push(ChainStep {
            key: step.key.clone(),
            name: step.name.clone(),
            intent: step.intent,
            instructions: step.instructions.clone(),
            depends_on: step.depends_on.clone(),
            position: step.position,
            operation_id: step.operation_id.clone(),
            attempt: step.attempt,
            phase,
            waiting_reason: reason,
            report: step.report.clone(),
        });
    }
    let phase = chain_phase(row, &derived);
    let next_action = next_action(row, phase, &derived);
    Chain {
        id: row.id.clone(),
        name: row.name.clone(),
        goal: row.goal.clone(),
        acceptance: row.acceptance.clone(),
        workspace_id: row.workspace_id.clone(),
        worktree: row.worktree,
        branch: row.branch.clone(),
        created_at: row.created_at.clone(),
        paused: row.paused,
        cancelled: row.cancelled,
        superseded_reason: row.superseded_reason.clone(),
        phase,
        next_action,
        steps: derived,
    }
}

fn step_phase(
    row: &ChainRow,
    step: &StepRow,
    operation: Option<&OperationRecord>,
    earlier: &HashMap<&str, ChainStepPhase>,
    steps: &[StepRow],
) -> (ChainStepPhase, Option<String>) {
    if step.skipped {
        return (ChainStepPhase::Skipped, step.skip_reason.clone());
    }
    let Some(operation) = operation else {
        return (
            ChainStepPhase::Failed,
            Some("This step's task is no longer available.".to_owned()),
        );
    };
    let name_of = |key: &str| {
        steps
            .iter()
            .find(|step| step.key == key)
            .map_or_else(|| key.to_owned(), |step| step.name.clone())
    };
    match operation.status {
        OperationStatus::Succeeded => match step.report.as_ref().map(|report| report.result) {
            Some(ChainStepResult::ChangesRequested) => (ChainStepPhase::ChangesRequested, None),
            Some(ChainStepResult::Failed) => (ChainStepPhase::Failed, None),
            _ => (ChainStepPhase::Passed, None),
        },
        OperationStatus::Failed => (ChainStepPhase::Failed, operation.outcome.clone()),
        OperationStatus::Interrupted => (
            ChainStepPhase::Failed,
            Some(
                operation
                    .outcome
                    .clone()
                    .unwrap_or_else(|| "Interrupted before it finished.".to_owned()),
            ),
        ),
        OperationStatus::Cancelled => match &row.superseded_reason {
            Some(reason) if operation.thread_id.is_none() => {
                (ChainStepPhase::Superseded, Some(reason.clone()))
            }
            _ => (ChainStepPhase::Cancelled, operation.outcome.clone()),
        },
        OperationStatus::Running if step.awaiting_report => (
            ChainStepPhase::NeedsReport,
            Some("The agent finished its turn without a step report.".to_owned()),
        ),
        OperationStatus::Running => (ChainStepPhase::Working, operation.current_action.clone()),
        OperationStatus::Starting => (ChainStepPhase::Starting, None),
        OperationStatus::Paused if operation.attention_reason.is_some() => {
            (ChainStepPhase::Blocked, operation.attention_reason.clone())
        }
        OperationStatus::Paused => (ChainStepPhase::Paused, Some("Chain paused.".to_owned())),
        OperationStatus::Blocked if operation.attention_reason.is_some() => {
            (ChainStepPhase::Blocked, operation.attention_reason.clone())
        }
        OperationStatus::Blocked | OperationStatus::Queued => {
            let failed = step
                .depends_on
                .iter()
                .filter(|key| {
                    earlier.get(key.as_str()).is_some_and(|phase| {
                        matches!(
                            phase,
                            ChainStepPhase::Failed
                                | ChainStepPhase::Blocked
                                | ChainStepPhase::Cancelled
                                | ChainStepPhase::Superseded
                        )
                    })
                })
                .map(|key| name_of(key))
                .collect::<Vec<_>>();
            if !failed.is_empty() {
                return (
                    ChainStepPhase::Blocked,
                    Some(format!(
                        "Blocked until {} is resolved.",
                        join_names(&failed)
                    )),
                );
            }
            let waiting = step
                .depends_on
                .iter()
                .filter(|key| !earlier.get(key.as_str()).is_some_and(|p| p.satisfied()))
                .map(|key| name_of(key))
                .collect::<Vec<_>>();
            if waiting.is_empty() {
                (
                    ChainStepPhase::Starting,
                    Some("Starting its agent.".to_owned()),
                )
            } else {
                (
                    ChainStepPhase::Waiting,
                    Some(format!("Waiting for {}.", join_names(&waiting))),
                )
            }
        }
        OperationStatus::Unknown => (
            ChainStepPhase::Failed,
            Some("KalCode couldn't read this step's state.".to_owned()),
        ),
    }
}

fn chain_phase(row: &ChainRow, steps: &[ChainStep]) -> ChainPhase {
    if row.cancelled {
        return ChainPhase::Cancelled;
    }
    if row.superseded_reason.is_some() {
        return ChainPhase::Superseded;
    }
    if steps.iter().all(|step| step.phase.satisfied()) {
        if unresolved_changes(steps).is_some() {
            return ChainPhase::NeedsYou;
        }
        return ChainPhase::ReadyToMerge;
    }
    let attention = |step: &ChainStep| {
        step.phase == ChainStepPhase::NeedsReport
            || (step.phase == ChainStepPhase::Blocked
                && step
                    .waiting_reason
                    .as_deref()
                    .is_some_and(|reason| !reason.starts_with("Blocked until")))
    };
    if steps.iter().any(attention) {
        return ChainPhase::NeedsYou;
    }
    let active = steps.iter().any(|step| {
        matches!(
            step.phase,
            ChainStepPhase::Working | ChainStepPhase::Starting
        )
    });
    if steps.iter().any(|step| {
        matches!(
            step.phase,
            ChainStepPhase::Failed | ChainStepPhase::Cancelled
        )
    }) && !active
    {
        return ChainPhase::Blocked;
    }
    if row.paused && !active {
        return ChainPhase::Paused;
    }
    ChainPhase::Running
}

fn next_action(row: &ChainRow, phase: ChainPhase, steps: &[ChainStep]) -> Option<String> {
    let first = |wanted: ChainStepPhase| steps.iter().find(|step| step.phase == wanted);
    match phase {
        ChainPhase::ReadyToMerge => Some(match &row.branch {
            Some(branch) => {
                format!("Ready to merge: {branch} goes through the normal merge and ship pipeline.")
            }
            None => "Ready to merge through the normal merge and ship pipeline.".to_owned(),
        }),
        ChainPhase::NeedsYou => first(ChainStepPhase::NeedsReport)
            .map(|step| {
                format!(
                    "Open {} to check its work, then record the outcome.",
                    step.name
                )
            })
            .or_else(|| {
                first(ChainStepPhase::Blocked).map(|step| {
                    format!(
                        "{}: {}",
                        step.name,
                        step.waiting_reason.clone().unwrap_or_default()
                    )
                })
            })
            .or_else(|| {
                unresolved_changes(steps).map(|step| {
                    format!(
                        "{} asked for changes that no later step made. Make them, then retry {}.",
                        step.name, step.name
                    )
                })
            }),
        ChainPhase::Blocked => first(ChainStepPhase::Failed)
            .map(|step| format!("{} failed. Retry it, reroute it or skip it.", step.name))
            .or_else(|| {
                first(ChainStepPhase::Cancelled)
                    .map(|step| format!("{} was cancelled. Retry it or skip it.", step.name))
            }),
        ChainPhase::Paused => Some("Paused. Resume to continue with the next step.".to_owned()),
        ChainPhase::Cancelled => Some("Cancelled. Started terminals stay open.".to_owned()),
        ChainPhase::Superseded => row.superseded_reason.clone(),
        ChainPhase::Running => {
            let working = steps.iter().find(|step| {
                matches!(
                    step.phase,
                    ChainStepPhase::Working | ChainStepPhase::Starting
                )
            });
            let next = steps
                .iter()
                .find(|step| step.phase == ChainStepPhase::Waiting);
            match (working, next) {
                (Some(working), Some(next)) => {
                    Some(format!("{} is working. Next: {}.", working.name, next.name))
                }
                (Some(working), None) => Some(format!("{} is working.", working.name)),
                (None, Some(next)) => Some(format!("Next: {}.", next.name)),
                (None, None) => None,
            }
        }
    }
}

/// A review that asked for changes no later writing step (Fix, Continue, Implement) addressed.
fn unresolved_changes(steps: &[ChainStep]) -> Option<&ChainStep> {
    steps.iter().find(|review| {
        review.phase == ChainStepPhase::ChangesRequested
            && !steps.iter().any(|later| {
                !later.intent.read_only()
                    && later.phase == ChainStepPhase::Passed
                    && step_follows(steps, &later.key, &review.key)
            })
    })
}

fn step_follows(steps: &[ChainStep], from: &str, target: &str) -> bool {
    let mut stack = vec![from];
    let mut seen = HashSet::new();
    while let Some(key) = stack.pop() {
        if !seen.insert(key) {
            continue;
        }
        if let Some(step) = steps.iter().find(|step| step.key == key) {
            for dependency in &step.depends_on {
                if dependency == target {
                    return true;
                }
                stack.push(dependency.as_str());
            }
        }
    }
    false
}

fn join_names(names: &[String]) -> String {
    match names {
        [] => String::new(),
        [one] => one.clone(),
        [first, second] => format!("{first} and {second}"),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

fn recent_chain_ids(conn: &Connection, workspace_id: Option<&str>) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT c.launch_id FROM chains c JOIN squad_launches l ON l.id = c.launch_id
         WHERE (?1 IS NULL OR l.workspace_id = ?1)
           AND (c.launch_id IN (
                  SELECT l2.id FROM squad_launches l2 JOIN chains c2 ON c2.launch_id = l2.id
                  WHERE (?1 IS NULL OR l2.workspace_id = ?1)
                  ORDER BY l2.created_at DESC, l2.id DESC LIMIT ?2)
                OR EXISTS (
                  SELECT 1 FROM chain_steps s JOIN operations o ON o.id = s.operation_id
                  WHERE s.launch_id = c.launch_id
                    AND o.status IN ('queued', 'starting', 'running', 'paused', 'blocked')))
         ORDER BY l.created_at DESC, l.id DESC",
    )?;
    Ok(stmt
        .query_map(params![workspace_id, MAX_RECENT_CHAINS], |row| row.get(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?)
}

fn load_chain(conn: &Connection, id: &str) -> Result<Option<ChainRow>> {
    let row = conn
        .query_row(
            "SELECT l.id, l.name, l.goal, l.workspace_id, l.created_at, c.acceptance,
                    c.worktree, c.branch, c.paused, c.cancelled, c.superseded_reason,
                    c.worktree_owner_id
             FROM chains c JOIN squad_launches l ON l.id = c.launch_id
             WHERE c.launch_id = ?1",
            [id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, bool>(8)?,
                    row.get::<_, bool>(9)?,
                    row.get::<_, Option<String>>(10)?,
                    row.get::<_, Option<String>>(11)?,
                ))
            },
        )
        .optional()?;
    row.map(
        |(
            id,
            name,
            goal,
            workspace_id,
            created_at,
            acceptance,
            worktree,
            branch,
            paused,
            cancelled,
            superseded_reason,
            worktree_owner,
        )| {
            Ok(ChainRow {
                id,
                name,
                goal,
                workspace_id,
                created_at,
                acceptance: serde_json::from_str(&acceptance)?,
                worktree: match worktree.as_str() {
                    "shared" => ChainWorktree::Shared,
                    "project" => ChainWorktree::Project,
                    _ => return Err(corrupt()),
                },
                branch,
                worktree_owner,
                paused,
                cancelled,
                superseded_reason,
            })
        },
    )
    .transpose()
}

fn load_steps(conn: &Connection, id: &str) -> Result<Vec<StepRow>> {
    let mut stmt = conn.prepare(
        "SELECT step_key, name, intent, instructions, depends_on, position, operation_id,
                attempt, skipped, skip_reason, report, awaiting_report
         FROM chain_steps WHERE launch_id = ?1 ORDER BY position",
    )?;
    let rows = stmt
        .query_map([id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, bool>(8)?,
                row.get::<_, Option<String>>(9)?,
                row.get::<_, Option<String>>(10)?,
                row.get::<_, bool>(11)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(
            |(
                key,
                name,
                intent,
                instructions,
                depends_on,
                position,
                operation_id,
                attempt,
                skipped,
                skip_reason,
                report,
                awaiting_report,
            )| {
                Ok(StepRow {
                    key,
                    name,
                    intent: parse_intent(&intent)?,
                    instructions,
                    depends_on: serde_json::from_str(&depends_on)?,
                    position: u32::try_from(position).map_err(|_| corrupt())?,
                    operation_id,
                    attempt: u32::try_from(attempt).map_err(|_| corrupt())?,
                    skipped,
                    skip_reason,
                    report: report.as_deref().map(serde_json::from_str).transpose()?,
                    awaiting_report,
                })
            },
        )
        .collect()
}

fn parse_intent(value: &str) -> Result<ChainStepIntent> {
    Ok(match value {
        "implement" => ChainStepIntent::Implement,
        "review" => ChainStepIntent::Review,
        "fix" => ChainStepIntent::Fix,
        "test" => ChainStepIntent::Test,
        "continue" => ChainStepIntent::Continue,
        _ => return Err(corrupt()),
    })
}

/// `kal/chain-<slug>-<random tail>`, matching KalCode's thread branch convention.
pub fn chain_branch_name(name: &str, id: &str) -> String {
    let mut slug = String::new();
    for c in name.chars() {
        if slug.len() >= 32 {
            break;
        }
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_end_matches('-');
    let slug = if slug.is_empty() { "work" } else { slug };
    let hex: String = id.chars().filter(char::is_ascii_hexdigit).collect();
    let tail = &hex[hex.len().saturating_sub(8)..];
    format!("kal/chain-{slug}-{tail}")
}

fn clean_text(value: &str, max_chars: usize) -> String {
    value
        .chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
        .take(max_chars)
        .collect::<String>()
        .trim()
        .to_owned()
}

fn clean_line(value: &str, max_chars: usize) -> String {
    value
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(max_chars)
        .collect::<String>()
        .trim()
        .to_owned()
}

fn validate_id(id: &str) -> Result<()> {
    if is_valid_id(id) {
        Ok(())
    } else {
        Err(KalError::validation(
            "invalid_chain_id",
            "That chain reference isn't valid.",
        ))
    }
}

fn report_invalid(why: &str) -> KalError {
    KalError::validation("chain_report_invalid", format!("{why}."))
}

fn step_changed() -> KalError {
    KalError::validation(
        "chain_step_changed",
        "This step changed a moment ago. Check the chain, then try again.",
    )
}

fn chain_not_found() -> KalError {
    KalError::validation("chain_not_found", "That chain no longer exists.")
}

fn step_not_found() -> KalError {
    KalError::validation("chain_step_not_found", "That chain step no longer exists.")
}

fn corrupt() -> KalError {
    KalError::internal(
        "chain_state_corrupt",
        "KalCode found inconsistent chain data and stopped to protect it.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_parsing_is_strict_bounded_and_cleaned() {
        let report = parse_report(
            br#"{"version":1,"result":"changes_requested","summary":"Two\u0007 issues","tests":[{"command":"pnpm test","passed":false}],"blockers":["Null check missing"]}"#,
        )
        .expect("report");
        assert_eq!(report.result, ChainStepResult::ChangesRequested);
        assert_eq!(report.summary, "Two issues");
        assert_eq!(report.tests[0].command, "pnpm test");
        assert_eq!(report.blockers, vec!["Null check missing".to_owned()]);
        assert!(
            parse_report(br#"{"version":1,"result":"passed","summary":"ok","extra":1}"#).is_err()
        );
        assert!(parse_report(br#"{"version":2,"result":"passed","summary":"ok"}"#).is_err());
        assert!(parse_report(br#"{"version":1,"result":"maybe","summary":"ok"}"#).is_err());
    }

    #[test]
    fn branch_names_are_safe_slugs() {
        assert_eq!(
            chain_branch_name("Fix the Login bug!", "0192f3c4-0000-7000-8000-00000000abcd"),
            "kal/chain-fix-the-login-bug-0000abcd"
        );
        assert_eq!(
            chain_branch_name("", "0192f3c4-0000-7000-8000-00000000abcd"),
            "kal/chain-work-0000abcd"
        );
    }

    fn definition(key: &str, intent: ChainStepIntent, depends_on: &[&str]) -> ChainStepDefinition {
        ChainStepDefinition {
            key: key.into(),
            name: key.into(),
            intent,
            provider_id: "claude-code".into(),
            provider_account_id: new_id(),
            model: "m".into(),
            effort: "high".into(),
            instructions: None,
            depends_on: depends_on.iter().map(|key| (*key).to_owned()).collect(),
        }
    }

    #[test]
    fn shared_worktrees_reject_parallel_writers_but_allow_parallel_readers() {
        use ChainStepIntent::*;
        let ok = [
            definition("implement", Implement, &[]),
            definition("review", Review, &["implement"]),
            definition("test", Test, &["implement"]),
            definition("fix", Fix, &["review", "test"]),
        ];
        assert!(reject_parallel_writers(&ok).is_ok());
        let bad = [
            definition("implement", Implement, &[]),
            definition("fix", Fix, &["implement"]),
            definition("continue", Continue, &["implement"]),
        ];
        let error = reject_parallel_writers(&bad).expect_err("parallel writers");
        assert_eq!(error.code, "chain_parallel_writers");
    }

    #[test]
    fn effective_dependencies_look_through_skipped_steps() {
        let step = |key: &str, depends_on: &[&str], skipped: bool| StepRow {
            key: key.into(),
            name: key.into(),
            intent: ChainStepIntent::Review,
            instructions: None,
            depends_on: depends_on.iter().map(|key| (*key).to_owned()).collect(),
            position: 0,
            operation_id: format!("op-{key}"),
            attempt: 1,
            skipped,
            skip_reason: None,
            report: None,
            awaiting_report: false,
        };
        let steps = [
            step("a", &[], false),
            step("b", &["a"], true),
            step("c", &["b"], false),
        ];
        let by_key: HashMap<&str, &StepRow> = steps.iter().map(|s| (s.key.as_str(), s)).collect();
        assert_eq!(
            effective_dependencies(&by_key, &["b".to_owned()]),
            vec!["op-a".to_owned()]
        );
    }

    #[test]
    fn names_join_naturally() {
        assert_eq!(join_names(&["Review".into()]), "Review");
        assert_eq!(
            join_names(&["Review".into(), "Test".into()]),
            "Review and Test"
        );
        assert_eq!(
            join_names(&["A".into(), "B".into(), "C".into()]),
            "A, B and C"
        );
    }
}
