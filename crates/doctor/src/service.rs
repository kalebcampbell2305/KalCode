//! Stateful Environment Doctor service held by the desktop shell.

use std::sync::{Arc, Mutex, PoisonError};

use kalcode_contracts::events::{Correlation, EventPayload, EventSource, NewEvent};
use kalcode_contracts::ids::is_valid_id;
use kalcode_core::{Core, ErrorCategory, KalError, Result};
use kalcode_git::GitCore;

use crate::checks::{self, CheckDef};
use crate::context::{
    Budget, HostFacts, MicrophonePermissionSource, ProjectFacts, ProviderSource, RunContext,
};
use crate::fixes::FixExecutor;
use crate::gate::FixGate;
use crate::runner::Runner;
use crate::store::Store;
use crate::types::{
    CheckResult, CheckStatus, DoctorArea, DoctorFinding, DoctorRun, FindingCounts, FindingSeverity,
    FixLogEntry, FixOutcome, FixPreview, FixRequest, IgnoreRequest, IgnoredList, RevertRequest,
    RunRequest, RunStatus,
};

pub struct DoctorConfig {
    pub core: Arc<Core>,
    pub host: HostFacts,
    pub providers: Option<Arc<dyn ProviderSource>>,
    pub git: Option<Arc<GitCore>>,
    pub microphone_permission: Option<Arc<dyn MicrophonePermissionSource>>,
    pub gate: Arc<dyn FixGate>,
    /// Stable/production sets this true so the capability cannot activate before v16.
    pub require_persistent: bool,
}

struct ActiveRun {
    snapshot: DoctorRun,
    budget: Budget,
}

#[derive(Clone)]
struct CompletedRun {
    run: DoctorRun,
    project: Option<ProjectFacts>,
}

#[derive(Default)]
struct State {
    active: Option<ActiveRun>,
    last: Option<CompletedRun>,
}

/// Native-only work prepared by Doctor::begin. It contains canonical roots and is never
/// serialized or accepted from IPC.
pub struct PreparedRun {
    id: String,
    ctx: Arc<RunContext>,
    plan: Vec<CheckDef>,
    areas: Vec<DoctorArea>,
    project: Option<ProjectFacts>,
    started_at: String,
}

pub struct Doctor {
    core: Arc<Core>,
    host: HostFacts,
    providers: Option<Arc<dyn ProviderSource>>,
    git: Option<Arc<GitCore>>,
    microphone_permission: Option<Arc<dyn MicrophonePermissionSource>>,
    store: Arc<Store>,
    fixes: FixExecutor,
    runner: Runner,
    state: Mutex<State>,
}

impl Doctor {
    pub fn open(config: DoctorConfig) -> Result<Self> {
        let store = Arc::new(Store::open(&config.core)?);
        if config.require_persistent && !store.persistent() {
            return Err(KalError::new(
                ErrorCategory::Database,
                "doctor_schema_missing",
                "Environment Doctor history is unavailable in this build.",
            ));
        }
        let last = store
            .latest_run()?
            .map(|run| CompletedRun { run, project: None });
        Ok(Self {
            core: config.core,
            host: config.host,
            providers: config.providers,
            git: config.git,
            microphone_permission: config.microphone_permission,
            fixes: FixExecutor::new(Arc::clone(&store), config.gate),
            store,
            runner: Runner::production(),
            state: Mutex::new(State { active: None, last }),
        })
    }

    /// Creates the immutable native run plan and returns its truthful running snapshot. Desktop
    /// returns this snapshot immediately, then invokes Self::execute off the UI thread.
    pub fn begin(
        &self,
        mut request: RunRequest,
        project: Option<ProjectFacts>,
    ) -> Result<(DoctorRun, PreparedRun)> {
        validate_project_request(&request, project.as_ref())?;
        if let Some(project) = project.as_ref() {
            self.fixes.reconcile(project)?;
        }
        request.areas.sort();
        request.areas.dedup();
        request.checks.sort();
        request.checks.dedup();
        let areas = if request.areas.is_empty() {
            DoctorArea::ALL.to_vec()
        } else {
            request.areas.clone()
        };
        let id = kalcode_contracts::ids::new_id();
        let budget = Budget::new(crate::CHECK_TIMEOUT);
        let ctx = Arc::new(RunContext::new(
            Arc::clone(&self.core),
            self.host.clone(),
            project.clone(),
            self.providers.clone(),
            self.git.clone(),
            self.microphone_permission.clone(),
            budget.clone(),
        ));
        let mut plan = checks::plan(&ctx, &areas);
        if !request.checks.is_empty() {
            let requested: std::collections::HashSet<&str> =
                request.checks.iter().map(String::as_str).collect();
            let known: std::collections::HashSet<&str> =
                plan.iter().map(|check| check.id.as_str()).collect();
            if requested.iter().any(|check| !known.contains(check)) {
                return Err(KalError::validation(
                    "unknown_check",
                    "That Environment Doctor check isn't available.",
                ));
            }
            plan.retain(|check| requested.contains(check.id.as_str()));
        }
        let started_at = kalcode_core::time::now_rfc3339();
        let snapshot = DoctorRun {
            id: id.clone(),
            status: RunStatus::Running,
            started_at: started_at.clone(),
            finished_at: None,
            areas: areas.clone(),
            workspace_id: project.as_ref().map(|project| project.workspace_id.clone()),
            workspace_name: project.as_ref().map(|project| project.name.clone()),
            timeout_ms: u64::try_from(crate::CHECK_TIMEOUT.as_millis()).unwrap_or(u64::MAX),
            checks: plan.iter().map(running_check).collect(),
            findings: Vec::new(),
            counts: FindingCounts::default(),
            persistent: self.store.persistent(),
        };
        {
            let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            if state.active.is_some() {
                return Err(KalError::new(
                    ErrorCategory::Validation,
                    "doctor_busy",
                    "An Environment Doctor run is already active.",
                ));
            }
            state.active = Some(ActiveRun {
                snapshot: snapshot.clone(),
                budget,
            });
        }
        if let Err(error) = self.core.emit(NewEvent {
            source: EventSource::Core,
            correlation: Correlation {
                workspace_id: project.as_ref().map(|project| project.workspace_id.clone()),
                ..Correlation::default()
            },
            event: EventPayload::DoctorRunStarted {
                run_id: id.clone(),
                checks: u32::try_from(plan.len()).unwrap_or(u32::MAX),
            },
        }) {
            let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            if state
                .active
                .as_ref()
                .is_some_and(|active| active.snapshot.id == id)
            {
                state.active = None;
            }
            return Err(error);
        }
        Ok((
            snapshot,
            PreparedRun {
                id,
                ctx,
                plan,
                areas,
                project,
                started_at,
            },
        ))
    }

    pub fn execute(&self, prepared: PreparedRun) -> Result<DoctorRun> {
        let PreparedRun {
            id,
            ctx,
            plan,
            areas,
            project,
            started_at,
        } = prepared;
        {
            let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            if state
                .active
                .as_ref()
                .is_none_or(|active| active.snapshot.id != id)
            {
                return Err(KalError::new(
                    ErrorCategory::Validation,
                    "stale_run",
                    "That Environment Doctor run is no longer active.",
                ));
            }
        }
        let result = (|| {
            let progress_id = id.clone();
            let mut batch = self
                .runner
                .run_with_progress(ctx, plan, |checks, _findings| {
                    let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
                    if let Some(active) = state
                        .active
                        .as_mut()
                        .filter(|active| active.snapshot.id == progress_id)
                    {
                        active.snapshot.checks = checks.to_vec();
                        // Findings are published together after ignore scopes are read from the
                        // canonical store; partial progress never flashes a remembered finding.
                        active.snapshot.counts = count_results(checks, &[]);
                    }
                });
            for finding in &mut batch.findings {
                finding.ignored = self
                    .store
                    .ignored_scope(&finding.code, finding.workspace_id.as_deref())?;
            }
            batch.counts = count_results(&batch.checks, &batch.findings);
            let run = DoctorRun {
                id: id.clone(),
                status: batch.status,
                started_at,
                finished_at: Some(kalcode_core::time::now_rfc3339()),
                areas,
                workspace_id: project.as_ref().map(|project| project.workspace_id.clone()),
                workspace_name: project.as_ref().map(|project| project.name.clone()),
                timeout_ms: u64::try_from(crate::CHECK_TIMEOUT.as_millis()).unwrap_or(u64::MAX),
                checks: batch.checks,
                findings: batch.findings,
                counts: batch.counts,
                persistent: self.store.persistent(),
            };
            self.store.save_run(&run)?;
            Ok(run)
        })();

        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state
            .active
            .as_ref()
            .is_some_and(|active| active.snapshot.id == id)
        {
            state.active = None;
        }
        if let Ok(run) = &result {
            state.last = Some(CompletedRun {
                run: run.clone(),
                project,
            });
        }
        result
    }

    /// Synchronous convenience for native tests and bounded callers.
    pub fn run(&self, request: RunRequest, project: Option<ProjectFacts>) -> Result<DoctorRun> {
        let (_, prepared) = self.begin(request, project)?;
        self.execute(prepared)
    }

    pub fn cancel(&self, run_id: &str) -> Result<DoctorRun> {
        if !is_valid_id(run_id) {
            return Err(KalError::validation(
                "invalid_id",
                "That run id is invalid.",
            ));
        }
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let active = state.active.as_mut().ok_or_else(|| {
            KalError::new(
                ErrorCategory::Validation,
                "doctor_not_running",
                "No Environment Doctor run is active.",
            )
        })?;
        if active.snapshot.id != run_id {
            return Err(KalError::new(
                ErrorCategory::Validation,
                "stale_run",
                "That is not the active Environment Doctor run.",
            ));
        }
        active.budget.cancel();
        active.snapshot.status = RunStatus::Cancelled;
        for check in &mut active.snapshot.checks {
            if check.status == CheckStatus::Running {
                check.status = CheckStatus::Cancelled;
                check.summary = "Cancelling".into();
                check.reason = Some("The run was cancelled.".into());
            }
        }
        Ok(active.snapshot.clone())
    }

    /// Releases a prepared run that the desktop's retained worker could not accept. This is an
    /// infrastructure recovery path: no checks or effects ran, so the incomplete snapshot is not
    /// promoted to history. The immutable run id prevents an older failure from clearing a newer
    /// active run.
    #[doc(hidden)]
    pub fn abandon_run(&self, run_id: &str) -> Result<()> {
        if !is_valid_id(run_id) {
            return Err(KalError::validation(
                "invalid_id",
                "That run id is invalid.",
            ));
        }
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let active = state.active.as_ref().ok_or_else(|| {
            KalError::validation("doctor_not_running", "No Environment Doctor run is active.")
        })?;
        if active.snapshot.id != run_id {
            return Err(KalError::validation(
                "stale_run",
                "That is not the active Environment Doctor run.",
            ));
        }
        active.budget.cancel();
        state.active = None;
        Ok(())
    }

    pub fn last(&self) -> Option<DoctorRun> {
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state
            .active
            .as_ref()
            .map(|active| active.snapshot.clone())
            .or_else(|| state.last.as_ref().map(|last| last.run.clone()))
    }

    pub fn ignore(&self, request: IgnoreRequest) -> Result<DoctorRun> {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let completed = state.last.as_mut().ok_or_else(|| {
            KalError::new(
                ErrorCategory::Validation,
                "doctor_no_run",
                "Run the Environment Doctor before changing a finding.",
            )
        })?;
        let finding = completed
            .run
            .findings
            .iter()
            .find(|finding| finding.code == request.finding_code);
        let title = if request.ignored {
            let finding = finding.ok_or_else(|| {
                KalError::new(
                    ErrorCategory::Validation,
                    "stale_finding",
                    "That finding is not part of the latest run.",
                )
            })?;
            if let crate::types::IgnoreScope::Workspace { workspace_id } = &request.scope
                && finding.workspace_id.as_deref() != Some(workspace_id)
            {
                return Err(KalError::new(
                    ErrorCategory::Permission,
                    "workspace_mismatch",
                    "That finding belongs to a different workspace.",
                ));
            }
            finding.title.as_str()
        } else {
            ""
        };
        self.store.set_ignore(
            &request.finding_code,
            &request.scope,
            title,
            request.ignored,
        )?;
        for finding in &mut completed.run.findings {
            if finding.code == request.finding_code
                && (matches!(&request.scope, crate::types::IgnoreScope::Global)
                    || finding.workspace_id.as_deref() == Some(request.scope.id()))
            {
                finding.ignored = request.ignored.then(|| request.scope.clone());
            }
        }
        completed.run.counts = count_results(&completed.run.checks, &completed.run.findings);
        Ok(completed.run.clone())
    }

    pub fn ignored(&self) -> Result<IgnoredList> {
        self.store.ignored()
    }

    pub fn fix_preview(&self, request: &FixRequest) -> Result<FixPreview> {
        let (finding, project) = self.fix_context(request)?;
        self.fixes.preview(request, &finding, project.as_ref())
    }

    pub fn fix(&self, request: &FixRequest) -> Result<FixOutcome> {
        let (finding, project) = self.fix_context(request)?;
        self.fixes.apply(request, &finding, project.as_ref())
    }

    pub fn revert(&self, request: &RevertRequest) -> Result<FixOutcome> {
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let project = state
            .last
            .as_ref()
            .and_then(|last| last.project.clone())
            .ok_or_else(|| {
                KalError::new(
                    ErrorCategory::Validation,
                    "doctor_no_project",
                    "Open the fix's workspace before undoing it.",
                )
            })?;
        drop(state);
        self.fixes.reconcile(&project)?;
        self.fixes.revert(request, &project)
    }

    pub fn fix_log(&self, limit: usize) -> Result<Vec<FixLogEntry>> {
        self.store.fixes(limit)
    }

    fn fix_context(&self, request: &FixRequest) -> Result<(DoctorFinding, Option<ProjectFacts>)> {
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let completed = state.last.as_ref().ok_or_else(|| {
            KalError::new(
                ErrorCategory::Validation,
                "doctor_no_run",
                "Run the Environment Doctor before applying a fix.",
            )
        })?;
        if completed.run.id != request.run_id {
            return Err(KalError::new(
                ErrorCategory::Validation,
                "stale_run",
                "That fix belongs to an older Environment Doctor run.",
            ));
        }
        let finding = completed
            .run
            .findings
            .iter()
            .find(|finding| {
                finding.code == request.finding_code && finding.version == request.finding_version
            })
            .cloned()
            .ok_or_else(|| {
                KalError::new(
                    ErrorCategory::Validation,
                    "stale_finding",
                    "That finding or finding version is no longer current.",
                )
            })?;
        Ok((finding, completed.project.clone()))
    }
}

fn running_check(check: &CheckDef) -> CheckResult {
    CheckResult {
        id: check.id.clone(),
        area: check.area,
        title: check.title.clone(),
        status: CheckStatus::Running,
        summary: "Waiting".into(),
        reason: None,
        duration_ms: None,
        finding_codes: Vec::new(),
    }
}

fn validate_project_request(request: &RunRequest, project: Option<&ProjectFacts>) -> Result<()> {
    match (&request.workspace_id, project) {
        (Some(requested), Some(project)) if requested == &project.workspace_id => Ok(()),
        (None, None) => Ok(()),
        (None, Some(_)) => Err(KalError::validation(
            "workspace_not_requested",
            "The resolved workspace was not requested.",
        )),
        _ => Err(KalError::new(
            ErrorCategory::Permission,
            "workspace_mismatch",
            "The requested workspace could not be resolved exactly.",
        )),
    }
}

fn count_results(checks: &[CheckResult], findings: &[DoctorFinding]) -> FindingCounts {
    let mut counts = FindingCounts::default();
    for check in checks {
        match check.status {
            CheckStatus::Passed => counts.passed += 1,
            CheckStatus::CouldNotCheck => counts.could_not_check += 1,
            CheckStatus::Skipped => counts.skipped += 1,
            CheckStatus::Running | CheckStatus::Finding | CheckStatus::Cancelled => {}
        }
    }
    for finding in findings {
        if finding.ignored.is_some() {
            counts.ignored += 1;
        } else {
            match finding.severity {
                FindingSeverity::Critical => counts.critical += 1,
                FindingSeverity::Warning => counts.warning += 1,
                FindingSeverity::Info => counts.info += 1,
            }
        }
    }
    counts
}
