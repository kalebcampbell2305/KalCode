//! Read-only Operations projections over canonical thread-tool and application-event evidence.
//! These rows are never persisted or executable; their source records remain authoritative.

use std::collections::BTreeMap;

use kalcode_contracts::events::{EventEnvelope, EventPayload};
use kalcode_contracts::operations::{
    OperationEnvironmentKind, OperationKind, OperationLane, OperationRecord, OperationSpec,
    OperationStatus,
};
use kalcode_contracts::threads::{ThreadSummary, ToolCallRecord, ToolCallStatus};
use kalcode_core::operations::{BackgroundRunRecord, ShellRunRecord};
use kalcode_threads::store::AgentTurnRecord;

pub(crate) fn agent_turn_run(thread: &ThreadSummary, turn: &AgentTurnRecord) -> OperationRecord {
    let mut spec = observed_spec(
        safe(&thread.name),
        turn.workspace_id.clone(),
        OperationKind::Agent,
    );
    spec.provider_id = Some(thread.provider_id.to_string());
    spec.provider_account_id = thread.provider_account_id.clone();
    spec.model = thread.model.clone();
    let (status, current_action, outcome) = match (turn.ok, turn.interrupted) {
        (_, Some(true)) => (
            OperationStatus::Interrupted,
            None,
            Some("The provider turn was interrupted.".into()),
        ),
        (Some(true), _) => (
            OperationStatus::Succeeded,
            None,
            Some("The provider completed the turn.".into()),
        ),
        (Some(false), _) => (
            OperationStatus::Failed,
            None,
            Some("The provider reported an unsuccessful turn.".into()),
        ),
        _ if !turn.has_later_turn => match thread.status {
            kalcode_contracts::threads::ThreadStatus::Starting
            | kalcode_contracts::threads::ThreadStatus::Recovering => (
                OperationStatus::Starting,
                thread.current_activity.as_deref().map(safe),
                None,
            ),
            kalcode_contracts::threads::ThreadStatus::WaitingForPermission
            | kalcode_contracts::threads::ThreadStatus::WaitingForUser
            | kalcode_contracts::threads::ThreadStatus::WaitingForDependency => (
                OperationStatus::Blocked,
                thread.current_activity.as_deref().map(safe),
                None,
            ),
            kalcode_contracts::threads::ThreadStatus::Active
            | kalcode_contracts::threads::ThreadStatus::Thinking
            | kalcode_contracts::threads::ThreadStatus::Editing
            | kalcode_contracts::threads::ThreadStatus::Testing
            | kalcode_contracts::threads::ThreadStatus::Reviewing
            | kalcode_contracts::threads::ThreadStatus::RunningCommand
            | kalcode_contracts::threads::ThreadStatus::RunningTool => (
                OperationStatus::Running,
                thread.current_activity.as_deref().map(safe),
                None,
            ),
            _ => (
                OperationStatus::Unknown,
                None,
                Some("No durable completion outcome was recorded for this turn.".into()),
            ),
        },
        _ => (
            OperationStatus::Unknown,
            None,
            Some("No durable completion outcome was recorded for this turn.".into()),
        ),
    };
    OperationRecord {
        id: format!("turn:{}", turn.message_id),
        spec,
        source: "thread".into(),
        status,
        workspace_name: thread.workspace_name.clone(),
        branch: thread.branch.clone(),
        version: None,
        account_label: thread.account_label.clone(),
        terminal_id: thread.terminal_id.clone(),
        thread_id: Some(thread.id.clone()),
        created_at: turn.created_at.clone(),
        started_at: Some(turn.created_at.clone()),
        ended_at: turn.completed_at.clone(),
        current_action,
        outcome,
        position: 0,
        blockers: Vec::new(),
    }
}

pub(crate) fn tool_run(thread: &ThreadSummary, tool: ToolCallRecord) -> OperationRecord {
    let status = match tool.status {
        ToolCallStatus::Requested => OperationStatus::Starting,
        ToolCallStatus::Running => OperationStatus::Running,
        ToolCallStatus::Completed => OperationStatus::Succeeded,
        ToolCallStatus::Failed => OperationStatus::Failed,
        ToolCallStatus::Cancelled => OperationStatus::Cancelled,
    };
    let ended = matches!(
        status,
        OperationStatus::Succeeded | OperationStatus::Failed | OperationStatus::Cancelled
    );
    let summary = safe(&tool.summary);
    let mut spec = observed_spec(
        if summary.trim().is_empty() {
            safe(&tool.tool)
        } else {
            summary.clone()
        },
        thread.workspace_id.clone(),
        tool_kind(&tool.tool, &tool.summary),
    );
    spec.provider_id = Some(thread.provider_id.to_string());
    spec.provider_account_id = thread.provider_account_id.clone();
    spec.model = thread.model.clone();
    let outcome = tool
        .result_summary
        .as_deref()
        .map(safe)
        .or_else(|| match status {
            OperationStatus::Failed => Some("The provider reported that this tool failed.".into()),
            OperationStatus::Cancelled => {
                Some("The tool ended before completion was observed.".into())
            }
            _ => None,
        });
    OperationRecord {
        id: format!("tool:{}", tool.id),
        spec,
        source: "tool".into(),
        status,
        workspace_name: thread.workspace_name.clone(),
        branch: thread.branch.clone(),
        version: None,
        account_label: thread.account_label.clone(),
        terminal_id: thread.terminal_id.clone(),
        thread_id: Some(thread.id.clone()),
        created_at: tool.requested_at.clone(),
        started_at: tool.started_at,
        ended_at: ended.then_some(tool.completed_at).flatten(),
        current_action: matches!(status, OperationStatus::Starting | OperationStatus::Running)
            .then_some(summary),
        outcome,
        position: 0,
        blockers: Vec::new(),
    }
}

pub(crate) fn shell_run(run: &ShellRunRecord) -> OperationRecord {
    let (status, outcome) = if run.completed_at.is_none() {
        (
            OperationStatus::Unknown,
            Some("No durable shell completion outcome was recorded.".into()),
        )
    } else if run.closed_by_user == Some(true) {
        (
            OperationStatus::Cancelled,
            Some("The terminal session was closed by the user.".into()),
        )
    } else if run.failed == Some(true) || run.exit_code.is_some_and(|code| code != 0) {
        (
            OperationStatus::Failed,
            Some(match run.exit_code {
                Some(code) => format!("The shell exited with code {code}."),
                None => "The shell reported a failure.".into(),
            }),
        )
    } else if run.exit_code == Some(0) || run.failed == Some(false) {
        (
            OperationStatus::Succeeded,
            Some("The shell exited successfully.".into()),
        )
    } else {
        (
            OperationStatus::Unknown,
            Some("The shell ended without a durable outcome.".into()),
        )
    };
    OperationRecord {
        id: format!("shell:{}", run.start_event_id),
        spec: observed_spec(
            if run.shell_name.trim().is_empty() {
                "Terminal session".into()
            } else {
                safe(&run.shell_name)
            },
            run.workspace_id.clone(),
            OperationKind::Script,
        ),
        source: "terminal".into(),
        status,
        workspace_name: run
            .workspace_name
            .clone()
            .unwrap_or_else(|| "Workspace".into()),
        branch: None,
        version: None,
        account_label: None,
        terminal_id: Some(run.terminal_id.clone()),
        thread_id: None,
        created_at: run.started_at.clone(),
        started_at: Some(run.started_at.clone()),
        ended_at: run.completed_at.clone(),
        current_action: None,
        outcome,
        position: 0,
        blockers: Vec::new(),
    }
}

pub(crate) fn background_run(run: &BackgroundRunRecord) -> OperationRecord {
    let (status, outcome) = match run.completed_at.as_ref() {
        None => (
            OperationStatus::Unknown,
            Some("No durable Environment Doctor completion was recorded.".into()),
        ),
        Some(_) if run.cancelled == Some(true) => (
            OperationStatus::Cancelled,
            Some("Environment Doctor was cancelled before it finished.".into()),
        ),
        Some(_) => {
            let critical = run.critical.unwrap_or_default();
            let warning = run.warning.unwrap_or_default();
            let could_not_check = run.could_not_check.unwrap_or_default();
            let unhealthy = critical > 0 || warning > 0 || could_not_check > 0;
            (
                if unhealthy {
                    OperationStatus::Failed
                } else {
                    OperationStatus::Succeeded
                },
                Some(format!(
                    "{} checks: {} critical, {} warning, {} info, {} could not check, {} ignored.",
                    run.checks,
                    critical,
                    warning,
                    run.info.unwrap_or_default(),
                    could_not_check,
                    run.ignored.unwrap_or_default()
                )),
            )
        }
    };
    OperationRecord {
        id: format!("background:doctor:{}", run.run_id),
        spec: observed_spec(
            "Environment Doctor".into(),
            run.workspace_id.clone().unwrap_or_default(),
            OperationKind::Background,
        ),
        source: "background".into(),
        status,
        workspace_name: run.workspace_name.clone().unwrap_or_else(|| {
            if run.workspace_id.is_some() {
                "Workspace".into()
            } else {
                "Global".into()
            }
        }),
        branch: None,
        version: None,
        account_label: None,
        terminal_id: None,
        thread_id: None,
        created_at: run.started_at.clone(),
        started_at: Some(run.started_at.clone()),
        ended_at: run.completed_at.clone(),
        current_action: None,
        outcome,
        position: 0,
        blockers: Vec::new(),
    }
}

#[derive(Default)]
struct DoctorObservation {
    workspace_id: Option<String>,
    checks: u32,
    started_at: Option<String>,
    completed: Option<DoctorCompletion>,
}

struct DoctorCompletion {
    at: String,
    critical: u32,
    warning: u32,
    info: u32,
    could_not_check: u32,
    ignored: u32,
    cancelled: bool,
}

pub(crate) fn background_runs(events: &[EventEnvelope]) -> Vec<OperationRecord> {
    let mut runs: BTreeMap<String, DoctorObservation> = BTreeMap::new();
    for envelope in events {
        match &envelope.event {
            EventPayload::DoctorRunStarted { run_id, checks } => {
                let run = runs.entry(run_id.clone()).or_default();
                run.checks = *checks;
                run.workspace_id = envelope
                    .correlation
                    .workspace_id
                    .clone()
                    .or_else(|| run.workspace_id.clone());
                run.started_at = Some(envelope.occurred_at.clone());
            }
            EventPayload::DoctorRunCompleted {
                run_id,
                checks,
                critical,
                warning,
                info,
                could_not_check,
                ignored,
                cancelled,
            } => {
                let run = runs.entry(run_id.clone()).or_default();
                run.checks = *checks;
                run.workspace_id = envelope
                    .correlation
                    .workspace_id
                    .clone()
                    .or_else(|| run.workspace_id.clone());
                run.completed = Some(DoctorCompletion {
                    at: envelope.occurred_at.clone(),
                    critical: *critical,
                    warning: *warning,
                    info: *info,
                    could_not_check: *could_not_check,
                    ignored: *ignored,
                    cancelled: *cancelled,
                });
            }
            _ => {}
        }
    }

    let mut rows = runs
        .into_iter()
        .map(|(run_id, run)| doctor_record(run_id, run))
        .collect::<Vec<_>>();
    rows.sort_by(|left, right| {
        right
            .created_at
            .cmp(&left.created_at)
            .then(left.id.cmp(&right.id))
    });
    rows
}

fn doctor_record(run_id: String, run: DoctorObservation) -> OperationRecord {
    let workspace_id = run.workspace_id.unwrap_or_default();
    let created_at = run
        .started_at
        .clone()
        .or_else(|| {
            run.completed
                .as_ref()
                .map(|completion| completion.at.clone())
        })
        .unwrap_or_default();
    let (status, ended_at, current_action, outcome) = match run.completed {
        None => (
            OperationStatus::Running,
            None,
            Some(format!("Running {} environment checks.", run.checks)),
            None,
        ),
        Some(completion) if completion.cancelled => (
            OperationStatus::Cancelled,
            Some(completion.at),
            None,
            Some("Environment Doctor was cancelled before it finished.".into()),
        ),
        Some(completion) => {
            let unhealthy =
                completion.critical > 0 || completion.warning > 0 || completion.could_not_check > 0;
            let outcome = format!(
                "{} checks: {} critical, {} warning, {} info, {} could not check, {} ignored.",
                run.checks,
                completion.critical,
                completion.warning,
                completion.info,
                completion.could_not_check,
                completion.ignored
            );
            (
                if unhealthy {
                    OperationStatus::Failed
                } else {
                    OperationStatus::Succeeded
                },
                Some(completion.at),
                None,
                Some(outcome),
            )
        }
    };
    OperationRecord {
        id: format!("background:doctor:{run_id}"),
        spec: observed_spec(
            "Environment Doctor".into(),
            workspace_id.clone(),
            OperationKind::Background,
        ),
        source: "background".into(),
        status,
        workspace_name: if workspace_id.is_empty() {
            "Global".into()
        } else {
            "Workspace".into()
        },
        branch: None,
        version: None,
        account_label: None,
        terminal_id: None,
        thread_id: None,
        created_at,
        started_at: run.started_at,
        ended_at,
        current_action,
        outcome,
        position: 0,
        blockers: Vec::new(),
    }
}

fn tool_kind(tool: &str, summary: &str) -> OperationKind {
    let tool = tool.trim().to_ascii_lowercase();
    let summary = summary.trim().to_ascii_lowercase();
    let test_tool = matches!(
        tool.as_str(),
        "test" | "tests" | "run_test" | "run_tests" | "pytest" | "vitest"
    );
    let test_command = summary.starts_with("run ")
        && [
            " test",
            "test ",
            "cargo test",
            "go test",
            "pytest",
            "vitest",
            "jest",
        ]
        .iter()
        .any(|needle| summary.contains(needle));
    if test_tool || test_command {
        OperationKind::Test
    } else if matches!(
        tool.as_str(),
        "bash" | "shell" | "command" | "command_execution" | "exec" | "powershell" | "terminal"
    ) {
        OperationKind::Script
    } else {
        OperationKind::Agent
    }
}

fn observed_spec(name: String, workspace_id: String, kind: OperationKind) -> OperationSpec {
    OperationSpec {
        name,
        workspace_id,
        kind,
        command: None,
        prompt: None,
        provider_id: None,
        provider_account_id: None,
        model: None,
        effort: None,
        dependencies: Vec::new(),
        priority: 0,
        lane: OperationLane::Next,
        environment: OperationEnvironmentKind::Local,
        urls: Vec::new(),
        env_keys: Vec::new(),
    }
}

fn safe(text: &str) -> String {
    kalcode_core::redact::redact_log_line(text).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use kalcode_contracts::agent::ProviderId;
    use kalcode_contracts::events::{Correlation, EventSource};
    use kalcode_contracts::permissions::PermissionMode;
    use kalcode_contracts::threads::ThreadStatus;

    fn thread() -> ThreadSummary {
        ThreadSummary {
            id: "thread-1".into(),
            name: "Agent task".into(),
            provider_id: ProviderId::new(ProviderId::CODEX),
            provider_name: "Codex".into(),
            model: Some("gpt-6".into()),
            effort: None,
            provider_account_id: Some("account-1".into()),
            account_label: Some("Work".into()),
            workspace_id: "workspace-1".into(),
            workspace_name: "KalCode".into(),
            permission_mode: PermissionMode::Approve,
            status: ThreadStatus::Testing,
            current_activity: None,
            created_at: "2026-09-30T10:00:00Z".into(),
            last_activity_at: "2026-09-30T10:01:00Z".into(),
            pending_approvals: 0,
            unread_messages: 0,
            files_changed: None,
            branch: Some("feat/operations".into()),
            error: None,
            archived_at: None,
            resumable: false,
            permission_profile_id: None,
            runtime_kind: None,
            terminal_id: None,
        }
    }

    fn event(id: &str, at: &str, workspace_id: Option<&str>, event: EventPayload) -> EventEnvelope {
        EventEnvelope {
            id: id.into(),
            seq: 1,
            version: 1,
            occurred_at: at.into(),
            source: EventSource::Core,
            correlation: Correlation {
                workspace_id: workspace_id.map(str::to_owned),
                ..Correlation::default()
            },
            event,
        }
    }

    #[test]
    fn tool_projection_preserves_real_lifecycle_and_parent_metadata() {
        let row = tool_run(
            &thread(),
            ToolCallRecord {
                id: "tool-1".into(),
                thread_id: "thread-1".into(),
                tool: "Bash".into(),
                summary: "Run cargo test".into(),
                status: ToolCallStatus::Failed,
                result_summary: Some("2 tests failed".into()),
                requested_at: "2026-09-30T10:00:01Z".into(),
                started_at: Some("2026-09-30T10:00:02Z".into()),
                completed_at: Some("2026-09-30T10:00:05Z".into()),
            },
        );
        assert_eq!(row.id, "tool:tool-1");
        assert_eq!(row.source, "tool");
        assert_eq!(row.spec.kind, OperationKind::Test);
        assert_eq!(row.status, OperationStatus::Failed);
        assert_eq!(row.thread_id.as_deref(), Some("thread-1"));
        assert_eq!(row.outcome.as_deref(), Some("2 tests failed"));
    }

    #[test]
    fn historical_agent_turn_without_completion_stays_unknown() {
        let mut summary = thread();
        summary.status = ThreadStatus::Idle;
        let row = agent_turn_run(
            &summary,
            &AgentTurnRecord {
                message_id: "message-1".into(),
                thread_id: summary.id.clone(),
                workspace_id: summary.workspace_id.clone(),
                created_at: "2026-09-30T10:00:00Z".into(),
                started_event_seq: Some(10),
                next_started_event_seq: Some(20),
                completed_event_seq: None,
                completed_at: None,
                ok: None,
                interrupted: None,
                has_later_turn: true,
                operation_id: None,
            },
        );
        assert_eq!(row.id, "turn:message-1");
        assert_eq!(row.status, OperationStatus::Unknown);
        assert_eq!(row.ended_at, None);
        assert!(
            row.outcome
                .as_deref()
                .is_some_and(|outcome| outcome.contains("No durable completion"))
        );
    }

    #[test]
    fn closed_shell_projection_uses_durable_outcome_and_never_invents_logs() {
        let row = shell_run(&ShellRunRecord {
            start_event_id: "event-1".into(),
            start_event_seq: 10,
            completed_event_seq: Some(11),
            terminal_id: "terminal-1".into(),
            workspace_id: "workspace-1".into(),
            workspace_name: Some("KalCode".into()),
            shell_name: "PowerShell".into(),
            started_at: "2026-09-30T10:00:00Z".into(),
            completed_at: Some("2026-09-30T10:01:00Z".into()),
            exit_code: Some(0),
            closed_by_user: Some(false),
            failed: Some(false),
        });
        assert_eq!(row.id, "shell:event-1");
        assert_eq!(row.status, OperationStatus::Succeeded);
        assert_eq!(row.terminal_id.as_deref(), Some("terminal-1"));
        assert_eq!(row.ended_at.as_deref(), Some("2026-09-30T10:01:00Z"));
    }

    #[test]
    fn incomplete_shell_and_background_records_are_unknown() {
        let shell = shell_run(&ShellRunRecord {
            start_event_id: "event-1".into(),
            start_event_seq: 10,
            completed_event_seq: None,
            terminal_id: "terminal-1".into(),
            workspace_id: "workspace-1".into(),
            workspace_name: Some("KalCode".into()),
            shell_name: "zsh".into(),
            started_at: "2026-09-30T10:00:00Z".into(),
            completed_at: None,
            exit_code: None,
            closed_by_user: None,
            failed: None,
        });
        let background = background_run(&BackgroundRunRecord {
            start_event_id: "event-2".into(),
            start_event_seq: 20,
            completed_event_seq: None,
            run_id: "doctor-1".into(),
            workspace_id: Some("workspace-1".into()),
            workspace_name: Some("KalCode".into()),
            checks: 3,
            started_at: "2026-09-30T10:00:00Z".into(),
            completed_at: None,
            critical: None,
            warning: None,
            info: None,
            could_not_check: None,
            ignored: None,
            cancelled: None,
        });
        assert_eq!(shell.status, OperationStatus::Unknown);
        assert_eq!(background.status, OperationStatus::Unknown);
    }

    #[test]
    fn doctor_projection_joins_out_of_order_events_and_never_calls_findings_success() {
        let rows = background_runs(&[
            event(
                "completed",
                "2026-09-30T10:00:05Z",
                Some("workspace-1"),
                EventPayload::DoctorRunCompleted {
                    run_id: "doctor-1".into(),
                    checks: 3,
                    critical: 1,
                    warning: 1,
                    info: 0,
                    could_not_check: 0,
                    ignored: 0,
                    cancelled: false,
                },
            ),
            event(
                "started",
                "2026-09-30T10:00:00Z",
                Some("workspace-1"),
                EventPayload::DoctorRunStarted {
                    run_id: "doctor-1".into(),
                    checks: 3,
                },
            ),
        ]);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "background:doctor:doctor-1");
        assert_eq!(rows[0].source, "background");
        assert_eq!(rows[0].status, OperationStatus::Failed);
        assert_eq!(rows[0].started_at.as_deref(), Some("2026-09-30T10:00:00Z"));
        assert_eq!(rows[0].ended_at.as_deref(), Some("2026-09-30T10:00:05Z"));
    }
}
