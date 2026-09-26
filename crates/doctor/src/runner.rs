//! Bounded, cancelable execution of the fixed Doctor check catalog.

use std::collections::HashSet;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::checks::{CheckDef, CheckOutput, Ended, clean};
use crate::context::RunContext;
use crate::types::{
    CheckResult, CheckStatus, DoctorFinding, FindingCounts, FindingSeverity, RunStatus,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunBatch {
    pub status: RunStatus,
    pub checks: Vec<CheckResult>,
    pub findings: Vec<DoctorFinding>,
    pub counts: FindingCounts,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Runner {
    timeout: Duration,
    max_checks: usize,
}

impl Runner {
    pub fn production() -> Self {
        Self::new(crate::CHECK_TIMEOUT, 64)
    }

    pub fn new(timeout: Duration, max_checks: usize) -> Self {
        Self {
            timeout: timeout.max(Duration::from_millis(1)),
            max_checks: max_checks.max(1),
        }
    }

    pub fn run(&self, ctx: Arc<RunContext>, plan: Vec<CheckDef>) -> RunBatch {
        self.run_with_progress(ctx, plan, |_, _| {})
    }

    pub fn run_with_progress(
        &self,
        ctx: Arc<RunContext>,
        plan: Vec<CheckDef>,
        mut progress: impl FnMut(&[CheckResult], &[DoctorFinding]),
    ) -> RunBatch {
        if plan.len() > self.max_checks {
            return RunBatch {
                status: RunStatus::Completed,
                checks: Vec::new(),
                findings: Vec::new(),
                counts: FindingCounts::default(),
                error: Some("check_limit_exceeded".into()),
            };
        }

        let mut checks: Vec<CheckResult> = plan
            .iter()
            .map(|check| CheckResult {
                id: check.id.clone(),
                area: check.area,
                title: check.title.clone(),
                status: CheckStatus::Running,
                summary: "Running".into(),
                reason: None,
                duration_ms: None,
                finding_codes: Vec::new(),
            })
            .collect();
        let (sender, receiver) = mpsc::channel();
        let started = Instant::now();
        for (index, check) in plan.into_iter().enumerate() {
            let sender = sender.clone();
            let ctx = Arc::clone(&ctx);
            let timeout = self.timeout;
            std::thread::Builder::new()
                .name(format!(
                    "doctor-{}",
                    check.id.chars().take(40).collect::<String>()
                ))
                .spawn(move || {
                    let check_started = Instant::now();
                    let _deadline = ctx.budget.enter_check(timeout);
                    let result = catch_unwind(AssertUnwindSafe(|| (check.run)(&ctx)));
                    let _ = sender.send((index, check_started.elapsed(), result));
                })
                .ok();
        }
        drop(sender);

        let deadline = started + self.timeout;
        let mut pending: HashSet<usize> = (0..checks.len()).collect();
        let mut findings = Vec::new();

        while !pending.is_empty() {
            if ctx.budget.is_cancelled() {
                mark_cancelled(&mut pending, &mut checks, started.elapsed());
                progress(&checks, &findings);
                break;
            }
            while let Ok(message) = receiver.try_recv() {
                if ctx.budget.is_cancelled() {
                    mark_cancelled(&mut pending, &mut checks, started.elapsed());
                    progress(&checks, &findings);
                    break;
                }
                if record_result(
                    message,
                    self.timeout,
                    &mut pending,
                    &mut checks,
                    &mut findings,
                ) {
                    progress(&checks, &findings);
                }
            }
            if pending.is_empty() {
                break;
            }
            let now = Instant::now();
            if now >= deadline {
                // Give workers whose own deadline just expired one bounded scheduling turn to
                // publish their terminal result. Its measured duration still decides whether it
                // timed out. This prevents an already-completed panic from being mislabeled merely
                // because the coordinator was descheduled until the shared deadline.
                match receiver.recv_timeout(Duration::from_millis(1)) {
                    Ok(message) => {
                        if ctx.budget.is_cancelled() {
                            mark_cancelled(&mut pending, &mut checks, started.elapsed());
                            progress(&checks, &findings);
                            break;
                        }
                        if record_result(
                            message,
                            self.timeout,
                            &mut pending,
                            &mut checks,
                            &mut findings,
                        ) {
                            progress(&checks, &findings);
                        }
                        continue;
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        mark_stopped(&mut pending, &mut checks);
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        for index in pending.drain() {
                            checks[index].status = CheckStatus::CouldNotCheck;
                            checks[index].summary = "Couldn't check".into();
                            checks[index].reason = Some("The check timed out.".into());
                            checks[index].duration_ms = Some(elapsed_ms(self.timeout));
                        }
                    }
                }
                progress(&checks, &findings);
                break;
            }
            let wait = deadline
                .saturating_duration_since(now)
                .min(Duration::from_millis(10));
            match receiver.recv_timeout(wait) {
                Ok(message) => {
                    if ctx.budget.is_cancelled() {
                        mark_cancelled(&mut pending, &mut checks, started.elapsed());
                        progress(&checks, &findings);
                        break;
                    }
                    if record_result(
                        message,
                        self.timeout,
                        &mut pending,
                        &mut checks,
                        &mut findings,
                    ) {
                        progress(&checks, &findings);
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    mark_stopped(&mut pending, &mut checks);
                    progress(&checks, &findings);
                }
            }
        }

        let status = if ctx.budget.is_cancelled() {
            RunStatus::Cancelled
        } else {
            RunStatus::Completed
        };
        let counts = counts(&checks, &findings);
        RunBatch {
            status,
            checks,
            findings,
            counts,
            error: None,
        }
    }
}

fn record_result(
    (index, duration, result): (usize, Duration, std::thread::Result<CheckOutput>),
    timeout: Duration,
    pending: &mut HashSet<usize>,
    checks: &mut [CheckResult],
    findings: &mut Vec<DoctorFinding>,
) -> bool {
    if !pending.remove(&index) {
        return false;
    }
    checks[index].duration_ms = Some(elapsed_ms(duration));
    if duration > timeout {
        checks[index].status = CheckStatus::CouldNotCheck;
        checks[index].summary = "Couldn't check".into();
        checks[index].reason = Some("The check timed out.".into());
    } else {
        match result {
            Ok(output) => finish_check(&mut checks[index], output, findings),
            Err(_) => {
                checks[index].status = CheckStatus::CouldNotCheck;
                checks[index].summary = "Couldn't check".into();
                checks[index].reason = Some("The check stopped unexpectedly.".into());
            }
        }
    }
    true
}

fn mark_stopped(pending: &mut HashSet<usize>, checks: &mut [CheckResult]) {
    for index in pending.drain() {
        checks[index].status = CheckStatus::CouldNotCheck;
        checks[index].summary = "Couldn't check".into();
        checks[index].reason = Some("The check stopped unexpectedly.".into());
    }
}

fn mark_cancelled(pending: &mut HashSet<usize>, checks: &mut [CheckResult], elapsed: Duration) {
    for index in pending.drain() {
        checks[index].status = CheckStatus::Cancelled;
        checks[index].summary = "Cancelled".into();
        checks[index].reason = Some("The run was cancelled.".into());
        checks[index].duration_ms = Some(elapsed_ms(elapsed));
    }
}

fn elapsed_ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn finish_check(result: &mut CheckResult, output: CheckOutput, findings: &mut Vec<DoctorFinding>) {
    result.summary = clean(&output.summary, 200);
    match output.ended {
        Ended::Checked => {
            result.status = if output.findings.is_empty() {
                CheckStatus::Passed
            } else {
                CheckStatus::Finding
            };
        }
        Ended::CouldNotCheck(_) => {
            result.status = CheckStatus::CouldNotCheck;
            // Probe failures may embed stderr, system paths, or provider text. The UI receives a
            // bounded catalog message while the check implementation can retain detail locally.
            result.reason = Some("The check could not be completed safely.".into());
        }
        Ended::Skipped(reason) => {
            result.status = CheckStatus::Skipped;
            result.reason = Some(clean(&reason, 300));
        }
    }
    for mut finding in output.findings {
        finding.check_id = result.id.clone();
        finding.area = result.area;
        finding.version = kalcode_contracts::ids::new_id();
        finding.code = clean(&finding.code, 128);
        finding.title = clean(&finding.title, 200);
        finding.explanation = clean(&finding.explanation, 1_000);
        result.finding_codes.push(finding.code.clone());
        findings.push(finding);
    }
}

fn counts(checks: &[CheckResult], findings: &[DoctorFinding]) -> FindingCounts {
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
