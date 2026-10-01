//! Read-only Operations projections over canonical records.
//!
//! These functions do not probe processes, networks, deployment providers, or the ambient
//! environment. Callers supply already-observed service and variable-name evidence. A completed
//! deploy command is kept distinct from a current health probe, and file evidence is limited to
//! safe workspace-relative paths.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use kalcode_contracts::events::{EventEnvelope, EventPayload, EventSource};
use kalcode_contracts::operations::{
    DevelopmentService, EnvironmentVariablePresence, OperationActivity, OperationArtifact,
    OperationDeploymentRelationship, OperationEnvironment, OperationEnvironmentKind, OperationKind,
    OperationMoment, OperationRecord, OperationServiceRelationship, OperationStatus,
    OperationTestResult,
};
use kalcode_contracts::threads::ThreadStatus;
use kalcode_core::operations::OperationActivityMoment;
use kalcode_core::workspaces::Workspace;

const MAX_ACTIVITY_ENTRIES: usize = 5_000;
const MAX_LABEL_CHARS: usize = 160;

/// Projects all four environment rows for every known workspace.
///
/// `local_env_names` contains names only, from a separately governed native listing. Values are
/// neither accepted nor returned. Remote variable presence remains unknown until a provider
/// adapter supplies authoritative evidence.
pub fn environments(
    runs: &[OperationRecord],
    services: &[DevelopmentService],
    workspaces: &[Workspace],
    local_env_names: &[String],
    now: &str,
) -> Vec<OperationEnvironment> {
    let local_names: BTreeSet<&str> = local_env_names.iter().map(String::as_str).collect();
    let mut ordered: Vec<&Workspace> = workspaces.iter().collect();
    ordered.sort_by(|left, right| left.id.cmp(&right.id));

    let mut result = Vec::with_capacity(ordered.len().saturating_mul(4));
    for workspace in ordered {
        for kind in [
            OperationEnvironmentKind::Local,
            OperationEnvironmentKind::Preview,
            OperationEnvironmentKind::Staging,
            OperationEnvironmentKind::Production,
        ] {
            let workspace_runs: Vec<&OperationRecord> = runs
                .iter()
                .filter(|run| run.spec.workspace_id == workspace.id && run.spec.environment == kind)
                .collect();
            let workspace_services: Vec<&DevelopmentService> = services
                .iter()
                .filter(|service| service.workspace_id == workspace.id)
                .collect();
            let defining_runs = if kind == OperationEnvironmentKind::Local {
                local_defining_runs(&workspace_runs, &workspace_services)
            } else {
                remote_defining_run(&workspace_runs).into_iter().collect()
            };
            let expected_keys = expected_env_keys(&defining_runs);
            let variables = expected_keys
                .into_iter()
                .map(|name| EnvironmentVariablePresence {
                    present: (kind == OperationEnvironmentKind::Local)
                        .then(|| local_names.contains(name.as_str())),
                    name,
                })
                .collect();

            let row = if kind == OperationEnvironmentKind::Local {
                local_environment(
                    &workspace.id,
                    &defining_runs,
                    workspace_services.iter().copied(),
                    variables,
                    now,
                )
            } else {
                remote_environment(&workspace.id, kind, &workspace_runs, variables, now)
            };
            result.push(row);
        }
    }
    result
}

fn local_defining_runs<'a>(
    runs: &[&'a OperationRecord],
    services: &[&DevelopmentService],
) -> Vec<&'a OperationRecord> {
    let active_run_ids: BTreeSet<&str> = services
        .iter()
        .filter(|service| service.status.eq_ignore_ascii_case("running"))
        .filter_map(|service| service.run_id.as_deref())
        .collect();
    runs.iter()
        .copied()
        .filter(|run| {
            active_run_ids.contains(run.id.as_str())
                && matches!(
                    run.status,
                    OperationStatus::Starting | OperationStatus::Running
                )
        })
        .collect()
}

fn remote_defining_run<'a>(runs: &[&'a OperationRecord]) -> Option<&'a OperationRecord> {
    let deploys = runs
        .iter()
        .copied()
        .filter(|run| has_deployment_execution_evidence(run));
    let latest_attempt = latest_run(deploys.clone());
    let latest_success = latest_run(deploys.filter(|run| run.status == OperationStatus::Succeeded));
    latest_success.or(latest_attempt)
}

/// Marks a failed listening-port observation without erasing process evidence supplied by the
/// Operations runtime. Call this only when the platform port probe was unavailable.
pub fn mark_local_port_observation_unavailable(environments: &mut [OperationEnvironment]) {
    for environment in environments
        .iter_mut()
        .filter(|environment| environment.kind == OperationEnvironmentKind::Local)
    {
        if environment.deployment_status == "not_detected" {
            environment.deployment_status = "observation_unavailable".to_owned();
            environment.health = "unknown".to_owned();
            environment
                .notes
                .retain(|note| !note.starts_with("No local service"));
            environment.notes.push(
                "Local process and port observation failed. Whether services are running is unknown."
                    .to_owned(),
            );
        } else {
            environment.notes.push(
                "Listening-port observation was unavailable; shown process state comes from known Operations runtime evidence."
                    .to_owned(),
            );
        }
    }
}

fn expected_env_keys(runs: &[&OperationRecord]) -> Vec<String> {
    runs.iter()
        .flat_map(|run| run.spec.env_keys.iter())
        .filter_map(|name| safe_env_name(name))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn safe_env_name(name: &str) -> Option<String> {
    let trimmed = name.trim();
    (!trimmed.is_empty()
        && trimmed.len() <= 256
        && !trimmed.chars().any(char::is_control)
        && trimmed
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_')
        && kalcode_context::secrets::scan(trimmed).is_empty())
    .then(|| trimmed.to_owned())
}

fn local_environment<'a>(
    workspace_id: &str,
    runs: &[&OperationRecord],
    services: impl Iterator<Item = &'a DevelopmentService>,
    variables: Vec<EnvironmentVariablePresence>,
    now: &str,
) -> OperationEnvironment {
    let services: Vec<&DevelopmentService> = services.collect();
    let running = services
        .iter()
        .any(|service| service.status.eq_ignore_ascii_case("running"));
    let failed = services
        .iter()
        .any(|service| service.status.eq_ignore_ascii_case("failed"));
    let stopped = services
        .iter()
        .any(|service| service.status.eq_ignore_ascii_case("stopped"));
    let listening_port_observed = services
        .iter()
        .any(|service| service.status.eq_ignore_ascii_case("running") && !service.ports.is_empty());
    let (deployment_status, health) = if running {
        ("running", "process_observed")
    } else if failed {
        ("failed", "failed")
    } else if stopped {
        ("stopped", "stopped")
    } else {
        ("not_detected", "unknown")
    };

    let latest = latest_run(runs.iter().copied());
    let mut urls = services
        .iter()
        .flat_map(|service| service.urls.iter())
        .filter_map(|url| safe_url(url))
        .collect::<BTreeSet<_>>();
    let declared: Vec<String> = runs
        .iter()
        .flat_map(|run| run.spec.urls.iter())
        .filter_map(|url| safe_url(url))
        .collect();
    urls.extend(declared.iter().cloned());

    let mut notes = Vec::new();
    if listening_port_observed {
        notes.push(
            "A workspace process and listening port were observed; HTTP health was not probed."
                .to_owned(),
        );
    } else if running {
        notes.push(
            "A workspace process was observed; no listening port or HTTP health was proven."
                .to_owned(),
        );
    }
    if !declared.is_empty() {
        notes.push(
            "Declared URLs are configuration, not proof that an endpoint is live.".to_owned(),
        );
    }
    if services.is_empty() {
        notes.push("No local service process was observed for this workspace.".to_owned());
    }
    if !variables.is_empty() {
        notes.push(
            "Variable presence reflects KalCode's inherited environment only; workspace files and provider environments were not inspected."
                .to_owned(),
        );
    }

    OperationEnvironment {
        workspace_id: workspace_id.to_owned(),
        kind: OperationEnvironmentKind::Local,
        branch: latest.and_then(|run| run.branch.clone()),
        version: latest.and_then(|run| run.version.clone()),
        urls: urls.into_iter().collect(),
        deployment_status: deployment_status.to_owned(),
        health: health.to_owned(),
        platform: Some("local_process".to_owned()),
        last_deploy: None,
        run_id: latest.map(|run| run.id.clone()),
        variables,
        observed_at: now.to_owned(),
        notes,
    }
}

fn remote_environment(
    workspace_id: &str,
    kind: OperationEnvironmentKind,
    runs: &[&OperationRecord],
    variables: Vec<EnvironmentVariablePresence>,
    now: &str,
) -> OperationEnvironment {
    let deploys: Vec<&OperationRecord> = runs
        .iter()
        .copied()
        .filter(|run| has_deployment_execution_evidence(run))
        .collect();
    let latest_attempt = latest_run(deploys.iter().copied());
    let latest_success = latest_run(
        deploys
            .iter()
            .copied()
            .filter(|run| run.status == OperationStatus::Succeeded),
    );
    let deployed = latest_success.or(latest_attempt);
    let mut notes = Vec::new();

    let deployment_status = match (latest_success, latest_attempt) {
        (Some(success), Some(attempt)) if record_is_later(attempt, success) => {
            notes.push(latest_attempt_note(attempt));
            match attempt.status {
                OperationStatus::Starting | OperationStatus::Running => "deploying",
                _ => "deployed_unverified",
            }
        }
        (Some(_), _) => "deployed_unverified",
        (None, Some(attempt)) => status_without_deployment(attempt.status),
        (None, None) => "unknown",
    };

    if latest_success.is_some() {
        notes.push(
            "The deploy command completed, but no current bounded service-health probe is attached."
                .to_owned(),
        );
    } else if latest_attempt.is_some_and(|run| run.status == OperationStatus::Unknown) {
        notes.push(
            "The historical deployment observation has no durable completion evidence.".to_owned(),
        );
    } else if latest_attempt.is_none() {
        notes
            .push("No canonical deployment run has been recorded for this environment.".to_owned());
    }

    let urls = deployed
        .into_iter()
        .flat_map(|run| run.spec.urls.iter())
        .filter_map(|url| safe_url(url))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    if !urls.is_empty() {
        notes.push("URLs are declared targets; they are not current liveness evidence.".to_owned());
    }

    OperationEnvironment {
        workspace_id: workspace_id.to_owned(),
        kind,
        branch: deployed.and_then(|run| run.branch.clone()),
        version: deployed.and_then(|run| run.version.clone()),
        urls,
        deployment_status: deployment_status.to_owned(),
        health: if latest_success.is_some() {
            "not_probed".to_owned()
        } else {
            "unknown".to_owned()
        },
        platform: deployed.and_then(|run| run.spec.provider_id.clone()),
        last_deploy: latest_success.and_then(|run| run.ended_at.clone()),
        run_id: deployed.map(|run| run.id.clone()),
        variables,
        observed_at: now.to_owned(),
        notes,
    }
}

fn latest_attempt_note(run: &OperationRecord) -> String {
    match run.status {
        OperationStatus::Starting | OperationStatus::Running => {
            "A newer deployment attempt is currently running.".to_owned()
        }
        OperationStatus::Failed => {
            "The latest deployment attempt failed; the preceding completed deployment remains shown."
                .to_owned()
        }
        OperationStatus::Cancelled => {
            "The latest deployment attempt was cancelled; the preceding completed deployment remains shown."
                .to_owned()
        }
        OperationStatus::Interrupted => {
            "The latest deployment attempt was interrupted; the preceding completed deployment remains shown."
                .to_owned()
        }
        OperationStatus::Paused => {
            "A newer deployment attempt is paused; the preceding completed deployment remains shown."
                .to_owned()
        }
        OperationStatus::Blocked => {
            "A newer deployment attempt is blocked; the preceding completed deployment remains shown."
                .to_owned()
        }
        OperationStatus::Queued => {
            "A newer deployment is queued; the preceding completed deployment remains shown."
                .to_owned()
        }
        OperationStatus::Succeeded => {
            "The latest deployment command completed without a current health probe.".to_owned()
        }
        OperationStatus::Unknown => {
            "A newer historical deployment attempt has no durable completion evidence; the preceding completed deployment remains shown."
                .to_owned()
        }
    }
}

fn status_without_deployment(status: OperationStatus) -> &'static str {
    match status {
        OperationStatus::Queued => "queued",
        OperationStatus::Starting | OperationStatus::Running => "deploying",
        OperationStatus::Paused => "paused",
        OperationStatus::Blocked => "blocked",
        OperationStatus::Succeeded => "deployed_unverified",
        OperationStatus::Failed => "failed",
        OperationStatus::Cancelled => "cancelled",
        OperationStatus::Interrupted => "interrupted",
        OperationStatus::Unknown => "unknown",
    }
}

/// Resolves the Services and Environments created by one run without persisting a second model.
///
/// A matching current projection is returned verbatim. Once a restart or later deployment
/// supersedes the run, conservative historical evidence is rebuilt only from its durable
/// specification, ownership bindings, and terminal state. Historical evidence never carries a
/// PID, observed port, process uptime, action authority, or endpoint-health claim.
pub fn detail_relationships(
    run: &OperationRecord,
    current_services: &[DevelopmentService],
    current_environments: &[OperationEnvironment],
) -> (
    Vec<OperationServiceRelationship>,
    Vec<OperationDeploymentRelationship>,
) {
    let mut related_services = current_services
        .iter()
        .filter(|service| {
            service.run_id.as_deref() == Some(run.id.as_str())
                && service.workspace_id == run.spec.workspace_id
        })
        .cloned()
        .map(|service| OperationServiceRelationship {
            service,
            is_current: true,
        })
        .collect::<Vec<_>>();
    related_services.sort_by(|left, right| left.service.id.cmp(&right.service.id));

    if related_services.is_empty()
        && run.spec.kind == OperationKind::Service
        && run.source == "operations"
        && run.terminal_id.is_some()
    {
        let status = match run.status {
            OperationStatus::Succeeded | OperationStatus::Cancelled => "stopped",
            OperationStatus::Failed | OperationStatus::Interrupted => "failed",
            _ => "unknown",
        };
        related_services.push(OperationServiceRelationship {
            service: DevelopmentService {
                id: run.id.clone(),
                run_id: Some(run.id.clone()),
                name: run.spec.name.clone(),
                status: status.to_owned(),
                pid: None,
                process_name: "Operation service".to_owned(),
                uptime_seconds: None,
                ports: Vec::new(),
                urls: run.spec.urls.iter().filter_map(|url| safe_url(url)).collect(),
                workspace_id: run.spec.workspace_id.clone(),
                workspace_name: run.workspace_name.clone(),
                terminal_id: run.terminal_id.clone(),
                can_stop: false,
                can_restart: false,
                action_reason: Some(
                    "Historical service ownership from this run. No current process is linked; declared URLs are not liveness evidence."
                        .to_owned(),
                ),
            },
            is_current: false,
        });
    }

    let deployment_run = has_deployment_execution_evidence(run);
    let mut related_deployments = if deployment_run {
        current_environments
            .iter()
            .filter(|environment| {
                environment.run_id.as_deref() == Some(run.id.as_str())
                    && environment.workspace_id == run.spec.workspace_id
                    && environment.kind == run.spec.environment
            })
            .cloned()
            .map(|environment| OperationDeploymentRelationship {
                environment,
                is_current: true,
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };

    if related_deployments.is_empty() && deployment_run {
        let succeeded = run.status == OperationStatus::Succeeded;
        let mut notes = vec![if succeeded {
            "This run's deployment command completed, but it no longer defines the current environment and endpoint health was not probed."
                .to_owned()
        } else if run.status == OperationStatus::Unknown {
            "This historical deployment has no durable completion or endpoint-health evidence."
                .to_owned()
        } else {
            "This run records a deployment attempt that no longer defines the current environment; endpoint health is unknown."
                .to_owned()
        }];
        let urls = run
            .spec
            .urls
            .iter()
            .filter_map(|url| safe_url(url))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        if !urls.is_empty() {
            notes.push(
                "URLs are declared targets; they are not current liveness evidence.".to_owned(),
            );
        }
        let variables = run
            .spec
            .env_keys
            .iter()
            .filter_map(|name| safe_env_name(name))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .map(|name| EnvironmentVariablePresence {
                name,
                present: None,
            })
            .collect();
        related_deployments.push(OperationDeploymentRelationship {
            environment: OperationEnvironment {
                workspace_id: run.spec.workspace_id.clone(),
                kind: run.spec.environment,
                branch: run.branch.clone(),
                version: run.version.clone(),
                urls,
                deployment_status: status_without_deployment(run.status).to_owned(),
                health: if succeeded { "not_probed" } else { "unknown" }.to_owned(),
                platform: run.spec.provider_id.clone(),
                last_deploy: succeeded.then(|| run.ended_at.clone()).flatten(),
                run_id: Some(run.id.clone()),
                variables,
                observed_at: record_time(run).to_owned(),
                notes,
            },
            is_current: false,
        });
    }

    (related_services, related_deployments)
}

fn latest_run<'a>(runs: impl Iterator<Item = &'a OperationRecord>) -> Option<&'a OperationRecord> {
    runs.max_by(|left, right| {
        record_time(left)
            .cmp(record_time(right))
            .then_with(|| left.id.cmp(&right.id))
    })
}

fn has_deployment_execution_evidence(run: &OperationRecord) -> bool {
    matches!(
        run.spec.kind,
        OperationKind::Deploy | OperationKind::Release
    ) && (run.terminal_id.is_some() || run.thread_id.is_some())
}

fn record_time(run: &OperationRecord) -> &str {
    run.ended_at
        .as_deref()
        .or(run.started_at.as_deref())
        .unwrap_or(&run.created_at)
}

fn record_is_later(candidate: &OperationRecord, existing: &OperationRecord) -> bool {
    record_time(candidate) > record_time(existing)
        || (record_time(candidate) == record_time(existing) && candidate.id > existing.id)
}

/// Projects bounded, deduplicated activity from typed events and canonical run records.
pub fn activity(events: &[EventEnvelope], runs: &[OperationRecord]) -> Vec<OperationActivity> {
    activity_with_moments(events, runs, &[])
}

/// Projects bounded Activity with each Operations-owned lifecycle sourced from its persisted
/// moment ledger. Observed foreign runtimes keep the existing captured-status projection.
pub fn activity_with_moments(
    events: &[EventEnvelope],
    runs: &[OperationRecord],
    operation_moments: &[OperationActivityMoment],
) -> Vec<OperationActivity> {
    let mut by_id = BTreeMap::<String, OperationActivity>::new();
    let run_windows = activity_run_windows(runs);
    for event in events {
        let matched_run = run_for_event(event, runs, &run_windows);
        let Some((kind, name, area)) = event_activity(event) else {
            continue;
        };
        let workspace_id = event_workspace_id(event)
            .map(str::to_owned)
            .or_else(|| matched_run.map(|run| run.spec.workspace_id.clone()));
        let run_id = matched_run
            .map(|run| run.id.clone())
            .or_else(|| exact_artifact_run_id(event));
        by_id
            .entry(format!("event:{}", event.id))
            .or_insert_with(|| OperationActivity {
                id: format!("event:{}", event.id),
                at: event.occurred_at.clone(),
                kind: kind.to_owned(),
                name,
                area,
                workspace_id,
                run_id,
            });
    }

    let operations_with_moments: HashSet<&str> = operation_moments
        .iter()
        .map(|entry| entry.operation_id.as_str())
        .collect();
    for entry in operation_moments {
        let id = format!("moment:{}", entry.moment.id);
        let kind = if entry.moment.kind == "failed" {
            "failure".to_owned()
        } else {
            safe_label(&entry.moment.kind, "activity").to_ascii_lowercase()
        };
        let operation_name = safe_label(&entry.operation_name, "Run");
        let moment_name = operation_moment_title(&entry.moment.kind)
            .map(str::to_owned)
            .unwrap_or_else(|| safe_label(&entry.moment.message, "Updated"));
        by_id
            .entry(id.clone())
            .or_insert_with(|| OperationActivity {
                id,
                at: entry.moment.at.clone(),
                kind,
                name: format!("{moment_name} · {operation_name}"),
                area: operation_area(entry.operation_kind).to_owned(),
                workspace_id: Some(entry.workspace_id.clone()),
                run_id: Some(entry.operation_id.clone()),
            });
    }

    for run in runs {
        if run.source == "operations" && operations_with_moments.contains(run.id.as_str()) {
            continue;
        }
        let status = status_word(run.status);
        let id = format!("run:{}:{status}", run.id);
        by_id
            .entry(id.clone())
            .or_insert_with(|| OperationActivity {
                id,
                at: record_time(run).to_owned(),
                kind: if run.status == OperationStatus::Failed {
                    "failure".to_owned()
                } else {
                    operation_kind(run.spec.kind).to_owned()
                },
                name: format!(
                    "{} · {}",
                    status_title(run.status),
                    safe_label(&run.spec.name, "Run")
                ),
                area: operation_area(run.spec.kind).to_owned(),
                workspace_id: Some(run.spec.workspace_id.clone()),
                run_id: Some(run.id.clone()),
            });
    }

    let mut projected: Vec<OperationActivity> = by_id.into_values().collect();
    projected.sort_by(|left, right| right.at.cmp(&left.at).then_with(|| left.id.cmp(&right.id)));
    projected.truncate(MAX_ACTIVITY_ENTRIES);
    projected
}

fn operation_moment_title(kind: &str) -> Option<&'static str> {
    match kind {
        "queued" => Some("Queued"),
        "starting" => Some("Starting"),
        "running" => Some("Running"),
        "paused" => Some("Paused"),
        "blocked" => Some("Blocked"),
        "succeeded" => Some("Succeeded"),
        "failed" => Some("Failed"),
        "cancelled" => Some("Cancelled"),
        "interrupted" => Some("Interrupted"),
        _ => None,
    }
}

fn exact_artifact_run_id(event: &EventEnvelope) -> Option<String> {
    if event.source != EventSource::Core
        || !matches!(
            event.event,
            EventPayload::OperationArtifactReported { .. }
                | EventPayload::OperationArtifactReportRejected { .. }
        )
        || !event
            .correlation
            .workspace_id
            .as_deref()
            .is_some_and(kalcode_contracts::ids::is_valid_id)
    {
        return None;
    }
    event
        .correlation
        .task_id
        .as_deref()
        .filter(|id| kalcode_contracts::ids::is_valid_id(id))
        .map(str::to_owned)
}

/// A run timeline contains only exact run, thread, or terminal correlations. Workspace-wide
/// events are deliberately excluded because concurrent runs can share a workspace. Lifecycle
/// timestamps are synthesized only for observed runs, which have no persisted Operations ledger.
pub fn timeline(events: &[EventEnvelope], run: &OperationRecord) -> Vec<OperationMoment> {
    let mut moments = BTreeMap::<String, OperationMoment>::new();
    // Owned Operations runs already have an append-only persisted moment ledger. Observed
    // thread/terminal runs do not, so their captured record timestamps form the lifecycle rows.
    if run.source != "operations" {
        moments.insert(
            format!("run:{}:created", run.id),
            OperationMoment {
                id: format!("run:{}:created", run.id),
                at: run.created_at.clone(),
                kind: "run.created".to_owned(),
                message: "Run created".to_owned(),
            },
        );
        if let Some(at) = &run.started_at {
            moments.insert(
                format!("run:{}:started", run.id),
                OperationMoment {
                    id: format!("run:{}:started", run.id),
                    at: at.clone(),
                    kind: "run.started".to_owned(),
                    message: "Run started".to_owned(),
                },
            );
        }
        if let Some(at) = &run.ended_at {
            moments.insert(
                format!("run:{}:ended", run.id),
                OperationMoment {
                    id: format!("run:{}:ended", run.id),
                    at: at.clone(),
                    kind: "run.ended".to_owned(),
                    message: status_title(run.status).to_owned(),
                },
            );
        }
    }
    for event in events.iter().filter(|event| event_matches_run(event, run)) {
        moments
            .entry(format!("event:{}", event.id))
            .or_insert_with(|| OperationMoment {
                id: format!("event:{}", event.id),
                at: event.occurred_at.clone(),
                kind: event.event.type_name().to_owned(),
                message: event_message(event),
            });
    }
    let mut projected: Vec<OperationMoment> = moments.into_values().collect();
    projected.sort_by(|left, right| left.at.cmp(&right.at).then_with(|| left.id.cmp(&right.id)));
    projected
}

/// Extracts only evidence directly supported by typed file and terminal events. The projection
/// never parses tool prose, invents test counts, or treats arbitrary output as an artifact.
pub fn detail_evidence(
    events: &[EventEnvelope],
    run: &OperationRecord,
) -> (
    Vec<String>,
    Vec<OperationArtifact>,
    Vec<OperationTestResult>,
) {
    let mut files = BTreeSet::new();
    let mut artifacts = BTreeMap::<String, OperationArtifact>::new();
    for event in events.iter().filter(|event| event_matches_run(event, run)) {
        if let EventPayload::OperationArtifactReported { path } = &event.event {
            let Some(path) = safe_relative_path(path) else {
                continue;
            };
            let name = path.rsplit('/').next().unwrap_or("File").to_owned();
            artifacts.entry(path.clone()).or_insert(OperationArtifact {
                name,
                location: path,
                kind: "reported_file".to_owned(),
            });
            continue;
        }
        let (path, created) = match &event.event {
            EventPayload::FileCreated { path, .. } => (path, true),
            EventPayload::FileModified { path, .. } | EventPayload::FileDeleted { path, .. } => {
                (path, false)
            }
            _ => continue,
        };
        let Some(path) = safe_relative_path(path) else {
            continue;
        };
        files.insert(path.clone());
        if created {
            let name = path.rsplit('/').next().unwrap_or("File").to_owned();
            artifacts.entry(path.clone()).or_insert(OperationArtifact {
                name,
                location: path,
                kind: "file_created".to_owned(),
            });
        }
    }

    let tests = if run.spec.kind == OperationKind::Test {
        test_result(events, run).into_iter().collect()
    } else {
        Vec::new()
    };
    (
        files.into_iter().collect(),
        artifacts.into_values().collect(),
        tests,
    )
}

fn test_result(events: &[EventEnvelope], run: &OperationRecord) -> Option<OperationTestResult> {
    let event = events
        .iter()
        .filter(|event| event_matches_run(event, run))
        .filter(|event| {
            matches!(
                event.event,
                EventPayload::ShellCompleted { .. } | EventPayload::ShellFailed { .. }
            )
        })
        .max_by(|left, right| {
            left.occurred_at
                .cmp(&right.occurred_at)
                .then_with(|| left.seq.cmp(&right.seq))
                .then_with(|| left.id.cmp(&right.id))
        })?;
    let exit_code = match &event.event {
        EventPayload::ShellCompleted { exit_code, .. }
        | EventPayload::ShellFailed { exit_code, .. } => *exit_code,
        _ => return None,
    };
    Some(OperationTestResult {
        name: safe_label(&run.spec.name, "Test command"),
        status: if exit_code == 0 { "passed" } else { "failed" }.to_owned(),
        detail: format!("Test command exited with code {exit_code}."),
    })
}

#[derive(Clone, Copy)]
struct ActivityRunWindow {
    start: time::OffsetDateTime,
    end: Option<time::OffsetDateTime>,
}

fn activity_run_windows(runs: &[OperationRecord]) -> HashMap<&str, Option<ActivityRunWindow>> {
    runs.iter()
        .map(|run| {
            let window =
                activity_timestamp(run.started_at.as_deref().unwrap_or(run.created_at.as_str()))
                    .and_then(|start| {
                        let end = match run.ended_at.as_deref() {
                            Some(end) => Some(activity_timestamp(end)?),
                            None => None,
                        };
                        end.is_none_or(|end| end >= start)
                            .then_some(ActivityRunWindow { start, end })
                    });
            (run.id.as_str(), window)
        })
        .collect()
}

fn activity_timestamp(value: &str) -> Option<time::OffsetDateTime> {
    time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).ok()
}

fn run_for_event<'a>(
    event: &EventEnvelope,
    runs: &'a [OperationRecord],
    windows: &HashMap<&str, Option<ActivityRunWindow>>,
) -> Option<&'a OperationRecord> {
    let mut payload_exact = runs
        .iter()
        .filter(|run| event_payload_identifies_run(event, run));
    if let Some(run) = payload_exact.next() {
        return payload_exact.next().is_none().then_some(run);
    }

    let mut correlation_exact = runs.iter().filter(|run| {
        [
            event.correlation.task_id.as_deref(),
            event.correlation.mission_id.as_deref(),
            event.correlation.automation_id.as_deref(),
        ]
        .into_iter()
        .flatten()
        .any(|id| id == run.id)
    });
    if let Some(run) = correlation_exact.next() {
        return correlation_exact.next().is_none().then_some(run);
    }

    let event_at = activity_timestamp(&event.occurred_at)?;
    let mut bounded = runs.iter().filter(|run| {
        if !event_matches_run(event, run) {
            return false;
        }
        let Some(window) = windows.get(run.id.as_str()).copied().flatten() else {
            return false;
        };
        event_at >= window.start && window.end.is_none_or(|end| event_at <= end)
    });
    let matched = bounded.next()?;
    bounded.next().is_none().then_some(matched)
}

fn event_payload_identifies_run(event: &EventEnvelope, run: &OperationRecord) -> bool {
    match &event.event {
        EventPayload::AgentMessage { message_id, .. } => {
            run.source == "thread" && run.id.strip_prefix("turn:") == Some(message_id.as_str())
        }
        EventPayload::ToolRequested { tool_call_id, .. }
        | EventPayload::ToolStarted { tool_call_id, .. }
        | EventPayload::ToolCompleted { tool_call_id, .. }
        | EventPayload::ToolFailed { tool_call_id, .. } => {
            run.source == "tool" && run.id.strip_prefix("tool:") == Some(tool_call_id.as_str())
        }
        EventPayload::ShellStarted { .. } => {
            run.source == "terminal" && run.id.strip_prefix("shell:") == Some(event.id.as_str())
        }
        EventPayload::DoctorRunStarted { run_id, .. }
        | EventPayload::DoctorRunCompleted { run_id, .. } => {
            run.source == "background"
                && run.id.strip_prefix("background:doctor:") == Some(run_id.as_str())
        }
        EventPayload::DoctorFixApplied { run_id, .. }
        | EventPayload::DoctorFixFailed { run_id, .. } => run_id.as_deref().is_some_and(|id| {
            run.source == "background" && run.id.strip_prefix("background:doctor:") == Some(id)
        }),
        _ => false,
    }
}

fn event_matches_run(event: &EventEnvelope, run: &OperationRecord) -> bool {
    if run.source == "tool" {
        return run
            .id
            .strip_prefix("tool:")
            .is_some_and(|tool_call_id| event_tool_call_id(event) == Some(tool_call_id));
    }
    if run.source == "background" {
        return run
            .id
            .strip_prefix("background:doctor:")
            .is_some_and(|doctor_run_id| event_doctor_run_id(event) == Some(doctor_run_id));
    }
    let correlation = &event.correlation;
    [
        correlation.task_id.as_deref(),
        correlation.mission_id.as_deref(),
        correlation.automation_id.as_deref(),
    ]
    .into_iter()
    .flatten()
    .any(|id| id == run.id)
        || run.thread_id.as_deref().is_some_and(|thread_id| {
            correlation.thread_id.as_deref() == Some(thread_id)
                || event_thread_id(event) == Some(thread_id)
        })
        || run
            .terminal_id
            .as_deref()
            .is_some_and(|terminal_id| event_terminal_id(event) == Some(terminal_id))
}

fn event_tool_call_id(event: &EventEnvelope) -> Option<&str> {
    match &event.event {
        EventPayload::ToolRequested { tool_call_id, .. }
        | EventPayload::ToolStarted { tool_call_id, .. }
        | EventPayload::ToolCompleted { tool_call_id, .. }
        | EventPayload::ToolFailed { tool_call_id, .. } => Some(tool_call_id),
        _ => None,
    }
}

fn event_doctor_run_id(event: &EventEnvelope) -> Option<&str> {
    match &event.event {
        EventPayload::DoctorRunStarted { run_id, .. }
        | EventPayload::DoctorRunCompleted { run_id, .. } => Some(run_id),
        EventPayload::DoctorFixApplied { run_id, .. }
        | EventPayload::DoctorFixFailed { run_id, .. } => run_id.as_deref(),
        _ => None,
    }
}

fn event_thread_id(event: &EventEnvelope) -> Option<&str> {
    match &event.event {
        EventPayload::ThreadCreated { thread_id, .. }
        | EventPayload::ThreadStarted { thread_id }
        | EventPayload::ThreadStatusChanged { thread_id, .. }
        | EventPayload::ThreadRenamed { thread_id, .. }
        | EventPayload::ThreadCompleted { thread_id }
        | EventPayload::ThreadFailed { thread_id, .. }
        | EventPayload::ThreadArchived { thread_id }
        | EventPayload::ThreadUnarchived { thread_id }
        | EventPayload::ThreadAccountChanged { thread_id, .. }
        | EventPayload::AgentMessage { thread_id, .. }
        | EventPayload::AgentTurnCompleted { thread_id, .. }
        | EventPayload::ToolRequested { thread_id, .. }
        | EventPayload::ToolStarted { thread_id, .. }
        | EventPayload::ToolCompleted { thread_id, .. }
        | EventPayload::ToolFailed { thread_id, .. }
        | EventPayload::ApprovalRequested { thread_id, .. }
        | EventPayload::ApprovalApproved { thread_id, .. }
        | EventPayload::ApprovalDenied { thread_id, .. }
        | EventPayload::ApprovalExpired { thread_id, .. } => Some(thread_id),
        EventPayload::FileCreated { thread_id, .. }
        | EventPayload::FileModified { thread_id, .. }
        | EventPayload::FileDeleted { thread_id, .. }
        | EventPayload::PermissionModeChanged { thread_id, .. }
        | EventPayload::ContextShared { thread_id, .. } => thread_id.as_deref(),
        _ => None,
    }
}

fn event_terminal_id(event: &EventEnvelope) -> Option<&str> {
    match &event.event {
        EventPayload::ShellStarted { terminal_id, .. }
        | EventPayload::ShellCompleted { terminal_id, .. }
        | EventPayload::ShellFailed { terminal_id, .. } => Some(terminal_id),
        _ => None,
    }
}

fn event_workspace_id(event: &EventEnvelope) -> Option<&str> {
    event
        .correlation
        .workspace_id
        .as_deref()
        .or_else(|| match &event.event {
            EventPayload::WorkspaceCreated { workspace_id, .. }
            | EventPayload::WorkspaceOpened { workspace_id, .. }
            | EventPayload::WorkspaceRemoved { workspace_id, .. }
            | EventPayload::ThreadCreated { workspace_id, .. }
            | EventPayload::GitBranchChanged { workspace_id, .. }
            | EventPayload::GitDiffChanged { workspace_id, .. }
            | EventPayload::GitCommitCreated { workspace_id, .. }
            | EventPayload::GitWorktreeCreated { workspace_id, .. }
            | EventPayload::GitWorktreeRemoved { workspace_id, .. }
            | EventPayload::TimelineCheckpointCreated { workspace_id, .. } => Some(workspace_id),
            _ => None,
        })
}

fn event_activity(event: &EventEnvelope) -> Option<(&'static str, String, String)> {
    let item = match &event.event {
        EventPayload::ThreadCreated { .. } => (
            "agent",
            "Agent task created".to_owned(),
            "Agents".to_owned(),
        ),
        EventPayload::ThreadStarted { .. } => (
            "agent",
            "Agent task started".to_owned(),
            "Agents".to_owned(),
        ),
        EventPayload::ThreadStatusChanged { to, .. } => {
            let (kind, area) = if *to == ThreadStatus::Testing {
                ("test", "Tests")
            } else {
                ("agent", "Agents")
            };
            (
                kind,
                format!("Agent status · {}", thread_status(*to)),
                area.to_owned(),
            )
        }
        EventPayload::ThreadCompleted { .. } => (
            "agent",
            "Agent task completed".to_owned(),
            "Agents".to_owned(),
        ),
        EventPayload::ThreadFailed { .. } => (
            "failure",
            "Agent task failed".to_owned(),
            "Agents".to_owned(),
        ),
        EventPayload::AgentTurnCompleted {
            ok, interrupted, ..
        } => {
            if *interrupted {
                (
                    "agent",
                    "Agent task interrupted".to_owned(),
                    "Agents".to_owned(),
                )
            } else if *ok {
                (
                    "agent",
                    "Agent task completed".to_owned(),
                    "Agents".to_owned(),
                )
            } else {
                (
                    "failure",
                    "Agent task failed".to_owned(),
                    "Agents".to_owned(),
                )
            }
        }
        EventPayload::ToolRequested { tool, .. } => (
            "agent",
            format!("Tool requested · {}", safe_label(tool, "Tool")),
            "Agents".to_owned(),
        ),
        EventPayload::ToolStarted { .. } => {
            ("agent", "Tool started".to_owned(), "Agents".to_owned())
        }
        EventPayload::ToolCompleted { .. } => {
            ("agent", "Tool completed".to_owned(), "Agents".to_owned())
        }
        EventPayload::ToolFailed { .. } => {
            ("failure", "Tool failed".to_owned(), "Agents".to_owned())
        }
        EventPayload::FileCreated { path, .. } => file_activity("File created", path),
        EventPayload::FileModified { path, .. } => file_activity("File changed", path),
        EventPayload::FileDeleted { path, .. } => file_activity("File deleted", path),
        EventPayload::OperationArtifactReported { path } => {
            artifact_activity("Artifact reported", path)
        }
        EventPayload::OperationArtifactReportRejected { .. } => (
            "failure",
            "Artifact report rejected".to_owned(),
            "Artifacts".to_owned(),
        ),
        EventPayload::GitDiffChanged { files, .. } => (
            "file",
            format!("Working tree changed · {files} file(s)"),
            "Git".to_owned(),
        ),
        EventPayload::GitCommitCreated { oid, .. } => (
            "commit",
            format!("Commit recorded · {}", safe_oid(oid)),
            "Git".to_owned(),
        ),
        EventPayload::TimelineCheckpointCreated { files, .. } => (
            "commit",
            format!("Checkpoint created · {files} file(s)"),
            "Git".to_owned(),
        ),
        EventPayload::ShellStarted { .. } => (
            "script",
            "Terminal process started".to_owned(),
            "Scripts".to_owned(),
        ),
        EventPayload::ShellCompleted { .. } => (
            "script",
            "Terminal process completed".to_owned(),
            "Scripts".to_owned(),
        ),
        EventPayload::ShellFailed { .. } => (
            "failure",
            "Terminal process failed".to_owned(),
            "Scripts".to_owned(),
        ),
        EventPayload::DoctorRunStarted { .. } => (
            "background",
            "Environment check started".to_owned(),
            "Environment".to_owned(),
        ),
        EventPayload::DoctorRunCompleted { cancelled, .. } => (
            "background",
            if *cancelled {
                "Environment check cancelled".to_owned()
            } else {
                "Environment check completed".to_owned()
            },
            "Environment".to_owned(),
        ),
        EventPayload::DoctorFixFailed { .. } => (
            "failure",
            "Environment fix failed".to_owned(),
            "Environment".to_owned(),
        ),
        EventPayload::ProviderHealthChanged { .. }
        | EventPayload::ProviderCapacityChanged { .. }
        | EventPayload::ApprovalRequested { .. }
        | EventPayload::ApprovalApproved { .. }
        | EventPayload::ApprovalDenied { .. }
        | EventPayload::ApprovalExpired { .. }
        | EventPayload::ContextPackageCreated { .. }
        | EventPayload::ContextBlocked { .. }
        | EventPayload::ContextRedacted { .. }
        | EventPayload::ContextShared { .. } => (
            "agent",
            "Agent runtime activity".to_owned(),
            "Agents".to_owned(),
        ),
        EventPayload::ResourceTaskHeld { .. } | EventPayload::ResourceTaskReleased { .. } => (
            "background",
            "Background work scheduling changed".to_owned(),
            "Scheduler".to_owned(),
        ),
        _ => return None,
    };
    Some(item)
}

fn file_activity(action: &str, path: &str) -> (&'static str, String, String) {
    match safe_relative_path(path) {
        Some(path) => ("file", format!("{action} · {path}"), file_area(&path)),
        None => (
            "file",
            format!("{action} · path withheld"),
            "Workspace".to_owned(),
        ),
    }
}

fn artifact_activity(action: &str, path: &str) -> (&'static str, String, String) {
    match safe_relative_path(path) {
        Some(path) => ("artifact", format!("{action} · {path}"), file_area(&path)),
        None => (
            "artifact",
            format!("{action} · path withheld"),
            "Workspace".to_owned(),
        ),
    }
}

fn event_message(event: &EventEnvelope) -> String {
    match &event.event {
        EventPayload::ThreadCreated { .. } => "Agent task created".to_owned(),
        EventPayload::ThreadStarted { .. } => "Agent task started".to_owned(),
        EventPayload::ThreadStatusChanged { to, .. } => {
            format!("Status changed to {}", thread_status(*to))
        }
        EventPayload::ThreadCompleted { .. } => "Agent task completed".to_owned(),
        EventPayload::ThreadFailed { .. } => "Agent task failed".to_owned(),
        EventPayload::AgentTurnCompleted {
            ok, interrupted, ..
        } => {
            if *interrupted {
                "Agent task interrupted".to_owned()
            } else if *ok {
                "Agent task completed".to_owned()
            } else {
                "Agent task failed".to_owned()
            }
        }
        EventPayload::ToolRequested { tool, .. } => {
            format!("Tool requested: {}", safe_label(tool, "Tool"))
        }
        EventPayload::ToolStarted { .. } => "Tool started".to_owned(),
        EventPayload::ToolCompleted { .. } => "Tool completed".to_owned(),
        EventPayload::ToolFailed { .. } => "Tool failed".to_owned(),
        EventPayload::FileCreated { path, .. } => file_message("File created", path),
        EventPayload::FileModified { path, .. } => file_message("File changed", path),
        EventPayload::FileDeleted { path, .. } => file_message("File deleted", path),
        EventPayload::OperationArtifactReported { path } => file_message("Artifact reported", path),
        EventPayload::OperationArtifactReportRejected { .. } => {
            "Artifact report rejected".to_owned()
        }
        EventPayload::ShellStarted { .. } => "Terminal process started".to_owned(),
        EventPayload::ShellCompleted { exit_code, .. } => {
            format!("Terminal process exited with code {exit_code}")
        }
        EventPayload::ShellFailed { exit_code, .. } => {
            format!("Terminal process failed with code {exit_code}")
        }
        EventPayload::GitCommitCreated { oid, .. } => format!("Commit recorded: {}", safe_oid(oid)),
        EventPayload::GitDiffChanged { files, .. } => {
            format!("Working tree changed: {files} file(s)")
        }
        EventPayload::DoctorRunStarted { checks, .. } => {
            format!("Environment check started: {checks} checks")
        }
        EventPayload::DoctorRunCompleted {
            checks, cancelled, ..
        } => {
            if *cancelled {
                format!("Environment check cancelled after {checks} checks")
            } else {
                format!("Environment check completed: {checks} checks")
            }
        }
        _ => event.event.type_name().replace('.', " "),
    }
}

fn file_message(action: &str, path: &str) -> String {
    safe_relative_path(path)
        .map(|path| format!("{action}: {path}"))
        .unwrap_or_else(|| format!("{action}: path withheld"))
}

fn safe_url(value: &str) -> Option<String> {
    let mut parsed = url::Url::parse(value).ok()?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return None;
    }
    parsed.set_query(None);
    parsed.set_fragment(None);
    Some(parsed.to_string())
}

/// Normalizes a workspace-relative path only when it is safe to persist in Operations evidence.
/// Callers must still prove filesystem containment before opening or reporting the path.
pub fn safe_relative_path(value: &str) -> Option<String> {
    let path = value.trim();
    if path.is_empty()
        || path.len() > 1_024
        || path.starts_with('/')
        || path.starts_with('\\')
        || path.chars().any(char::is_control)
    {
        return None;
    }
    let normalized = path.replace('\\', "/");
    let parts: Vec<&str> = normalized.split('/').collect();
    if parts.is_empty()
        || parts
            .iter()
            .any(|part| part.is_empty() || *part == "." || *part == ".." || part.contains(':'))
        || sensitive_path(&parts)
    {
        return None;
    }
    let normalized = parts.join("/");
    let redacted = kalcode_context::redact::redact_text(
        &normalized,
        kalcode_context::secrets::ScanContext::default(),
        kalcode_context::redact::PlaceholderStyle::Plain,
    );
    (!redacted.is_redacted()).then_some(normalized)
}

fn sensitive_path(parts: &[&str]) -> bool {
    parts.iter().any(|part| {
        let name = part.to_ascii_lowercase();
        name == ".env"
            || name.starts_with(".env.")
            || matches!(
                name.as_str(),
                ".npmrc"
                    | ".pypirc"
                    | "credentials"
                    | "credentials.json"
                    | "secrets.json"
                    | "id_rsa"
                    | "id_ed25519"
            )
            || name.ends_with(".pem")
            || name.ends_with(".key")
            || name.ends_with(".p12")
            || name.ends_with(".pfx")
    })
}

fn file_area(path: &str) -> String {
    let parts: Vec<&str> = path.split('/').collect();
    match parts.as_slice() {
        [
            root @ ("apps" | "crates" | "packages" | "tooling" | "docs"),
            module,
            ..,
        ] => {
            format!("{root}/{module}")
        }
        [root, ..] if parts.len() > 1 => (*root).to_owned(),
        _ => "Workspace".to_owned(),
    }
}

fn safe_label(value: &str, fallback: &str) -> String {
    let redacted = kalcode_context::redact::redact_text(
        value,
        kalcode_context::secrets::ScanContext::default(),
        kalcode_context::redact::PlaceholderStyle::Plain,
    );
    let single_line: String = redacted
        .text
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .take(MAX_LABEL_CHARS)
        .collect();
    let trimmed = single_line.trim();
    if trimmed.is_empty() {
        fallback.to_owned()
    } else {
        trimmed.to_owned()
    }
}

fn safe_oid(oid: &str) -> String {
    if oid.len() >= 7 && oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        oid[..7].to_ascii_lowercase()
    } else {
        "unknown".to_owned()
    }
}

fn operation_kind(kind: OperationKind) -> &'static str {
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

fn operation_area(kind: OperationKind) -> &'static str {
    match kind {
        OperationKind::Agent => "Agents",
        OperationKind::Build => "Builds",
        OperationKind::Test => "Tests",
        OperationKind::Script => "Scripts",
        OperationKind::Deploy => "Deployments",
        OperationKind::Release => "Releases",
        OperationKind::Background => "Background",
        OperationKind::Service => "Services",
    }
}

fn status_word(status: OperationStatus) -> &'static str {
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
        OperationStatus::Unknown => "unknown",
    }
}

fn status_title(status: OperationStatus) -> &'static str {
    match status {
        OperationStatus::Queued => "Queued",
        OperationStatus::Starting => "Starting",
        OperationStatus::Running => "Running",
        OperationStatus::Paused => "Paused",
        OperationStatus::Blocked => "Blocked",
        OperationStatus::Succeeded => "Succeeded",
        OperationStatus::Failed => "Failed",
        OperationStatus::Cancelled => "Cancelled",
        OperationStatus::Interrupted => "Interrupted",
        OperationStatus::Unknown => "Unknown",
    }
}

fn thread_status(status: ThreadStatus) -> &'static str {
    match status {
        ThreadStatus::Starting => "starting",
        ThreadStatus::Active => "active",
        ThreadStatus::Thinking => "thinking",
        ThreadStatus::RunningTool => "running tool",
        ThreadStatus::RunningCommand => "running command",
        ThreadStatus::Editing => "editing",
        ThreadStatus::Testing => "testing",
        ThreadStatus::Reviewing => "reviewing",
        ThreadStatus::Idle => "idle",
        ThreadStatus::WaitingForPermission => "waiting for permission",
        ThreadStatus::WaitingForUser => "waiting for user",
        ThreadStatus::WaitingForDependency => "waiting for dependency",
        ThreadStatus::Paused => "paused",
        ThreadStatus::Completed => "completed",
        ThreadStatus::Failed => "failed",
        ThreadStatus::Interrupted => "interrupted",
        ThreadStatus::Recovering => "recovering",
        ThreadStatus::Offline => "offline",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kalcode_contracts::events::{Correlation, EventSource};
    use kalcode_contracts::operations::{OperationLane, OperationSpec};

    fn workspace() -> Workspace {
        Workspace {
            id: "workspace-1".to_owned(),
            name: "KalCode".to_owned(),
            root_path: r"C:\Users\owner\private\KalCode".to_owned(),
            display_path: "~/private/KalCode".to_owned(),
            created_at: "2026-09-30T09:00:00Z".to_owned(),
            last_opened_at: "2026-09-30T09:00:00Z".to_owned(),
            active_terminal_id: None,
            available: true,
        }
    }

    fn run(
        id: &str,
        kind: OperationKind,
        environment: OperationEnvironmentKind,
    ) -> OperationRecord {
        OperationRecord {
            id: id.to_owned(),
            spec: OperationSpec {
                name: "Run checks".to_owned(),
                workspace_id: "workspace-1".to_owned(),
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
                environment,
                urls: Vec::new(),
                env_keys: Vec::new(),
            },
            source: "operations".to_owned(),
            status: OperationStatus::Queued,
            workspace_name: "KalCode".to_owned(),
            branch: Some("feature/operations".to_owned()),
            version: None,
            account_label: None,
            terminal_id: None,
            thread_id: None,
            created_at: "2026-09-30T10:00:00Z".to_owned(),
            started_at: None,
            ended_at: None,
            current_action: None,
            outcome: None,
            position: 0,
            blockers: Vec::new(),
        }
    }

    fn event(id: &str, at: &str, correlation: Correlation, event: EventPayload) -> EventEnvelope {
        EventEnvelope {
            id: id.to_owned(),
            seq: 1,
            version: 1,
            occurred_at: at.to_owned(),
            source: EventSource::Core,
            correlation,
            event,
        }
    }

    #[test]
    fn environments_emit_four_truthful_rows_without_values_or_fake_health() {
        let mut local = run(
            "local",
            OperationKind::Service,
            OperationEnvironmentKind::Local,
        );
        let secret_name = format!("{}{}", "ghp_", "0123456789abcdefghijklmnopqrstuvwxyzAB");
        local.spec.env_keys = vec![
            "DATABASE_URL".to_owned(),
            "OPTIONAL_KEY".to_owned(),
            secret_name.clone(),
        ];
        local.status = OperationStatus::Running;
        local.spec.urls = vec!["http://localhost:3000/configured?token=withheld".to_owned()];
        let service = DevelopmentService {
            id: "service-1".to_owned(),
            run_id: Some(local.id.clone()),
            name: "Frontend".to_owned(),
            status: "running".to_owned(),
            pid: Some(42),
            process_name: "node".to_owned(),
            uptime_seconds: Some(12),
            ports: vec![3000],
            urls: vec!["http://127.0.0.1:3000/".to_owned()],
            workspace_id: "workspace-1".to_owned(),
            workspace_name: "KalCode".to_owned(),
            terminal_id: None,
            can_stop: true,
            can_restart: true,
            action_reason: None,
        };
        let mut historic = run(
            "historic-local",
            OperationKind::Service,
            OperationEnvironmentKind::Local,
        );
        historic.status = OperationStatus::Succeeded;
        historic.spec.env_keys = vec!["OLD_LOCAL_KEY".to_owned()];
        historic.spec.urls = vec!["http://localhost:1000/old".to_owned()];
        let mut future = run(
            "future-local",
            OperationKind::Service,
            OperationEnvironmentKind::Local,
        );
        future.created_at = "2026-09-30T13:00:00Z".to_owned();
        future.spec.env_keys = vec!["FUTURE_LOCAL_KEY".to_owned()];
        future.spec.urls = vec!["http://localhost:9000/future".to_owned()];
        let rows = environments(
            &[historic, local, future],
            &[service],
            &[workspace()],
            &["DATABASE_URL".to_owned(), secret_name.clone()],
            "2026-09-30T12:00:00Z",
        );
        assert_eq!(rows.len(), 4);
        let local = &rows[0];
        assert_eq!(local.deployment_status, "running");
        assert_eq!(local.health, "process_observed");
        assert_ne!(local.health, "live");
        assert_eq!(local.variables[0].present, Some(true));
        assert_eq!(local.variables[1].present, Some(false));
        assert!(
            local
                .notes
                .iter()
                .any(|note| note.contains("inherited environment only"))
        );
        assert!(local.urls.iter().all(|url| !url.contains("token")));
        assert!(
            rows[1..]
                .iter()
                .all(|row| row.deployment_status == "unknown"
                    && row.health == "unknown"
                    && row.platform.is_none()
                    && row.variables.is_empty())
        );
        let json = serde_json::to_string(&rows).expect("json");
        assert!(!json.contains("withheld"));
        assert!(!json.contains("C:\\Users"));
        assert!(!json.contains(&secret_name));
        assert!(!json.contains("OLD_LOCAL_KEY"));
        assert!(!json.contains("FUTURE_LOCAL_KEY"));
        assert!(!json.contains("localhost:1000"));
        assert!(!json.contains("localhost:9000"));
    }

    #[test]
    fn running_worker_without_a_port_only_proves_its_process() {
        let service = DevelopmentService {
            id: "service-worker".to_owned(),
            run_id: None,
            name: "Worker".to_owned(),
            status: "running".to_owned(),
            pid: Some(43),
            process_name: "worker".to_owned(),
            uptime_seconds: Some(20),
            ports: Vec::new(),
            urls: Vec::new(),
            workspace_id: "workspace-1".to_owned(),
            workspace_name: "KalCode".to_owned(),
            terminal_id: None,
            can_stop: true,
            can_restart: true,
            action_reason: None,
        };
        let rows = environments(&[], &[service], &[workspace()], &[], "2026-09-30T12:00:00Z");
        let local = &rows[0];
        assert_eq!(local.health, "process_observed");
        assert!(
            local
                .notes
                .iter()
                .any(|note| note.contains("no listening port or HTTP health was proven"))
        );
        assert!(
            !local
                .notes
                .iter()
                .any(|note| note.contains("and listening"))
        );
    }

    #[test]
    fn unavailable_port_probe_preserves_known_running_process_evidence() {
        let service = DevelopmentService {
            id: "service-worker".to_owned(),
            run_id: Some("worker-run".to_owned()),
            name: "Worker".to_owned(),
            status: "running".to_owned(),
            pid: Some(43),
            process_name: "worker".to_owned(),
            uptime_seconds: Some(20),
            ports: Vec::new(),
            urls: Vec::new(),
            workspace_id: "workspace-1".to_owned(),
            workspace_name: "KalCode".to_owned(),
            terminal_id: None,
            can_stop: true,
            can_restart: true,
            action_reason: None,
        };
        let mut known = environments(&[], &[service], &[workspace()], &[], "2026-09-30T12:00:00Z");
        mark_local_port_observation_unavailable(&mut known);
        assert_eq!(known[0].deployment_status, "running");
        assert_eq!(known[0].health, "process_observed");
        assert!(
            known[0]
                .notes
                .iter()
                .any(|note| note.contains("shown process state"))
        );

        let mut unknown = environments(&[], &[], &[workspace()], &[], "2026-09-30T12:00:00Z");
        mark_local_port_observation_unavailable(&mut unknown);
        assert_eq!(unknown[0].deployment_status, "observation_unavailable");
        assert_eq!(unknown[0].health, "unknown");
    }

    #[test]
    fn failed_attempt_does_not_erase_the_preceding_deployment() {
        let mut succeeded = run(
            "deploy-good",
            OperationKind::Deploy,
            OperationEnvironmentKind::Production,
        );
        succeeded.status = OperationStatus::Succeeded;
        succeeded.version = Some("0.1.7".to_owned());
        succeeded.branch = Some("main".to_owned());
        succeeded.spec.provider_id = Some("cloudflare".to_owned());
        succeeded.terminal_id = Some(succeeded.id.clone());
        succeeded.started_at = Some("2026-09-30T10:00:00Z".to_owned());
        succeeded.ended_at = Some("2026-09-30T10:05:00Z".to_owned());
        succeeded.spec.urls = vec!["https://kalcoded.com/".to_owned()];
        let mut failed = run(
            "deploy-bad",
            OperationKind::Deploy,
            OperationEnvironmentKind::Production,
        );
        failed.status = OperationStatus::Failed;
        failed.terminal_id = Some(failed.id.clone());
        failed.version = Some("0.1.8".to_owned());
        failed.started_at = Some("2026-09-30T11:00:00Z".to_owned());
        failed.ended_at = Some("2026-09-30T11:01:00Z".to_owned());
        failed.outcome = Some("token=super-secret-value".to_owned());
        let rows = environments(
            &[succeeded, failed],
            &[],
            &[workspace()],
            &[],
            "2026-09-30T12:00:00Z",
        );
        let production = &rows[3];
        assert_eq!(production.deployment_status, "deployed_unverified");
        assert_eq!(production.health, "not_probed");
        assert_eq!(production.run_id.as_deref(), Some("deploy-good"));
        assert_eq!(production.version.as_deref(), Some("0.1.7"));
        assert_eq!(production.branch.as_deref(), Some("main"));
        assert_eq!(production.platform.as_deref(), Some("cloudflare"));
        assert_eq!(
            production.last_deploy.as_deref(),
            Some("2026-09-30T10:05:00Z")
        );
        assert!(
            production
                .notes
                .iter()
                .any(|note| note.contains("latest deployment attempt failed"))
        );
        assert!(
            !serde_json::to_string(production)
                .expect("json")
                .contains("super-secret-value")
        );
    }

    #[test]
    fn claimed_deployment_without_runtime_binding_creates_no_deployment_evidence() {
        let mut succeeded = run(
            "deploy-good",
            OperationKind::Deploy,
            OperationEnvironmentKind::Production,
        );
        succeeded.status = OperationStatus::Succeeded;
        succeeded.terminal_id = Some(succeeded.id.clone());
        succeeded.started_at = Some("2026-09-30T10:00:00Z".to_owned());
        succeeded.ended_at = Some("2026-09-30T10:05:00Z".to_owned());
        succeeded.spec.urls = vec!["https://stable.example.com/".to_owned()];

        let mut failed_before_launch = run(
            "deploy-unbound",
            OperationKind::Deploy,
            OperationEnvironmentKind::Production,
        );
        failed_before_launch.status = OperationStatus::Failed;
        failed_before_launch.created_at = "2026-09-30T11:00:00Z".to_owned();
        failed_before_launch.started_at = Some(failed_before_launch.created_at.clone());
        failed_before_launch.ended_at = Some("2026-09-30T11:01:00Z".to_owned());

        let rows = environments(
            &[succeeded.clone(), failed_before_launch.clone()],
            &[],
            &[workspace()],
            &[],
            "2026-09-30T12:00:00Z",
        );
        let production = &rows[3];
        assert_eq!(production.run_id.as_deref(), Some("deploy-good"));
        assert!(
            production
                .notes
                .iter()
                .all(|note| !note.contains("latest deployment attempt failed"))
        );
        assert!(
            detail_relationships(&failed_before_launch, &[], &[])
                .1
                .is_empty(),
            "claiming scheduler capacity is not deployment execution evidence"
        );

        failed_before_launch.terminal_id = Some(failed_before_launch.id.clone());
        let rows = environments(
            &[succeeded, failed_before_launch.clone()],
            &[],
            &[workspace()],
            &[],
            "2026-09-30T12:00:00Z",
        );
        assert!(
            rows[3]
                .notes
                .iter()
                .any(|note| note.contains("latest deployment attempt failed"))
        );
        let related = detail_relationships(&failed_before_launch, &[], &[]).1;
        assert_eq!(related.len(), 1);
        assert!(!related[0].is_current);
        assert_eq!(related[0].environment.deployment_status, "failed");
    }

    #[test]
    fn remote_configuration_comes_only_from_the_current_successful_deployment() {
        let mut old = run(
            "deploy-old",
            OperationKind::Deploy,
            OperationEnvironmentKind::Production,
        );
        old.status = OperationStatus::Succeeded;
        old.terminal_id = Some(old.id.clone());
        old.branch = Some("release/old".to_owned());
        old.version = Some("0.1.6".to_owned());
        old.ended_at = Some("2026-09-30T09:00:00Z".to_owned());
        old.spec.env_keys = vec!["OLD_KEY".to_owned()];
        old.spec.urls = vec!["https://old.example.com/".to_owned()];

        let mut current = run(
            "deploy-current",
            OperationKind::Deploy,
            OperationEnvironmentKind::Production,
        );
        current.status = OperationStatus::Succeeded;
        current.terminal_id = Some(current.id.clone());
        current.branch = Some("main".to_owned());
        current.version = Some("0.1.7".to_owned());
        current.ended_at = Some("2026-09-30T10:00:00Z".to_owned());
        current.spec.env_keys = vec!["CURRENT_KEY".to_owned()];
        current.spec.urls = vec!["https://current.example.com/".to_owned()];

        let mut future = run(
            "deploy-future",
            OperationKind::Deploy,
            OperationEnvironmentKind::Production,
        );
        future.created_at = "2026-09-30T11:00:00Z".to_owned();
        future.spec.env_keys = vec!["FUTURE_KEY".to_owned()];
        future.spec.urls = vec!["https://future.example.com/".to_owned()];

        let rows = environments(
            &[old, current, future],
            &[],
            &[workspace()],
            &[],
            "2026-09-30T12:00:00Z",
        );
        let production = &rows[3];
        assert_eq!(production.run_id.as_deref(), Some("deploy-current"));
        assert_eq!(production.branch.as_deref(), Some("main"));
        assert_eq!(production.version.as_deref(), Some("0.1.7"));
        assert_eq!(production.urls, vec!["https://current.example.com/"]);
        assert_eq!(production.variables.len(), 1);
        assert_eq!(production.variables[0].name, "CURRENT_KEY");
        assert_eq!(production.variables[0].present, None);
        let json = serde_json::to_string(production).expect("json");
        assert!(!json.contains("OLD_KEY"));
        assert!(!json.contains("FUTURE_KEY"));
        assert!(!json.contains("old.example.com"));
        assert!(!json.contains("future.example.com"));
    }

    #[test]
    fn unknown_history_never_becomes_a_failure_or_deployment_claim() {
        let mut unknown = run(
            "historical-deploy",
            OperationKind::Deploy,
            OperationEnvironmentKind::Production,
        );
        unknown.status = OperationStatus::Unknown;
        unknown.source = "terminal".to_owned();
        unknown.terminal_id = Some(unknown.id.clone());
        unknown.started_at = Some("2026-09-30T10:00:00Z".to_owned());
        unknown.ended_at = None;
        unknown.spec.urls = vec!["https://target.example.com/".to_owned()];

        let rows = environments(
            std::slice::from_ref(&unknown),
            &[],
            &[workspace()],
            &[],
            "2026-09-30T12:00:00Z",
        );
        let production = &rows[3];
        assert_eq!(production.deployment_status, "unknown");
        assert_eq!(production.health, "unknown");
        assert_eq!(production.last_deploy, None);
        assert!(
            production
                .notes
                .iter()
                .any(|note| note.contains("no durable completion evidence"))
        );

        let projected = activity(&[], std::slice::from_ref(&unknown));
        let item = projected
            .iter()
            .find(|item| item.run_id.as_deref() == Some("historical-deploy"))
            .expect("unknown activity");
        assert_eq!(item.kind, "deploy");
        assert!(item.name.starts_with("Unknown · "));
        assert_ne!(item.kind, "failure");

        let timeline = timeline(&[], &unknown);
        assert!(
            timeline
                .iter()
                .all(|moment| moment.id != "run:historical-deploy:ended")
        );
    }

    #[test]
    fn detail_relationships_preserve_superseded_service_and_deployment_evidence() {
        let mut first_service = run(
            "service-first",
            OperationKind::Service,
            OperationEnvironmentKind::Local,
        );
        first_service.spec.name = "Frontend".to_owned();
        first_service.spec.command = Some("pnpm dev".to_owned());
        first_service.spec.urls = vec!["http://localhost:3000/".to_owned()];
        first_service.status = OperationStatus::Succeeded;
        first_service.terminal_id = Some(first_service.id.clone());
        first_service.started_at = Some("2026-09-30T09:00:00Z".to_owned());
        first_service.ended_at = Some("2026-09-30T09:30:00Z".to_owned());

        let mut successor = first_service.clone();
        successor.id = "service-successor".to_owned();
        successor.status = OperationStatus::Running;
        successor.terminal_id = Some(successor.id.clone());
        successor.created_at = "2026-09-30T10:00:00Z".to_owned();
        successor.started_at = Some(successor.created_at.clone());
        successor.ended_at = None;
        let current_service = DevelopmentService {
            id: "service-successor:42:1".to_owned(),
            run_id: Some(successor.id.clone()),
            name: "Frontend".to_owned(),
            status: "running".to_owned(),
            pid: Some(42),
            process_name: "node".to_owned(),
            uptime_seconds: Some(60),
            ports: vec![3000],
            urls: vec!["http://localhost:3000/".to_owned()],
            workspace_id: "workspace-1".to_owned(),
            workspace_name: "KalCode".to_owned(),
            terminal_id: Some(successor.id.clone()),
            can_stop: true,
            can_restart: true,
            action_reason: None,
        };
        let cross_workspace_collision = DevelopmentService {
            id: "foreign-service".to_owned(),
            run_id: Some(first_service.id.clone()),
            workspace_id: "workspace-2".to_owned(),
            workspace_name: "Other".to_owned(),
            ..current_service.clone()
        };

        let (first_services, first_deployments) = detail_relationships(
            &first_service,
            &[current_service.clone(), cross_workspace_collision],
            &[],
        );
        assert!(first_deployments.is_empty());
        assert_eq!(first_services.len(), 1);
        assert!(!first_services[0].is_current);
        assert_eq!(
            first_services[0].service.run_id.as_deref(),
            Some("service-first")
        );
        assert_eq!(first_services[0].service.status, "stopped");
        assert_eq!(first_services[0].service.pid, None);
        assert!(first_services[0].service.ports.is_empty());
        assert!(!first_services[0].service.can_stop);
        assert!(!first_services[0].service.can_restart);
        assert!(
            first_services[0]
                .service
                .action_reason
                .as_deref()
                .is_some_and(|reason| reason.contains("Historical service ownership"))
        );

        let (successor_services, _) =
            detail_relationships(&successor, std::slice::from_ref(&current_service), &[]);
        assert_eq!(successor_services.len(), 1);
        assert!(successor_services[0].is_current);
        assert_eq!(successor_services[0].service, current_service);

        let mut failed_launch = first_service.clone();
        failed_launch.id = "service-launch-failed".to_owned();
        failed_launch.status = OperationStatus::Failed;
        failed_launch.terminal_id = None;
        failed_launch.outcome = Some("The service process could not be created.".to_owned());
        let (failed_launch_services, _) = detail_relationships(&failed_launch, &[], &[]);
        assert!(
            failed_launch_services.is_empty(),
            "a claimed run without a recorded terminal binding did not create a service"
        );

        let mut observed_spoof = first_service.clone();
        observed_spoof.id = "observed-service".to_owned();
        observed_spoof.source = "terminal".to_owned();
        let (observed_services, _) = detail_relationships(&observed_spoof, &[], &[]);
        assert!(
            observed_services.is_empty(),
            "observed records cannot manufacture Operations service ownership"
        );

        let mut first_deploy = run(
            "deploy-first",
            OperationKind::Deploy,
            OperationEnvironmentKind::Production,
        );
        first_deploy.status = OperationStatus::Succeeded;
        first_deploy.terminal_id = Some(first_deploy.id.clone());
        first_deploy.branch = Some("release/first".to_owned());
        first_deploy.version = Some("0.1.7+2".to_owned());
        first_deploy.spec.provider_id = Some("cloudflare".to_owned());
        first_deploy.spec.urls = vec!["https://first.example.com/".to_owned()];
        first_deploy.started_at = Some("2026-09-30T11:00:00Z".to_owned());
        first_deploy.ended_at = Some("2026-09-30T11:05:00Z".to_owned());

        let mut later_deploy = first_deploy.clone();
        later_deploy.id = "deploy-later".to_owned();
        later_deploy.terminal_id = Some(later_deploy.id.clone());
        later_deploy.branch = Some("release/later".to_owned());
        later_deploy.version = Some("0.1.7+3".to_owned());
        later_deploy.spec.urls = vec!["https://later.example.com/".to_owned()];
        later_deploy.created_at = "2026-09-30T12:00:00Z".to_owned();
        later_deploy.started_at = Some(later_deploy.created_at.clone());
        later_deploy.ended_at = Some("2026-09-30T12:05:00Z".to_owned());
        let current_environment = OperationEnvironment {
            workspace_id: "workspace-1".to_owned(),
            kind: OperationEnvironmentKind::Production,
            branch: later_deploy.branch.clone(),
            version: later_deploy.version.clone(),
            urls: later_deploy.spec.urls.clone(),
            deployment_status: "deployed_unverified".to_owned(),
            health: "not_probed".to_owned(),
            platform: later_deploy.spec.provider_id.clone(),
            last_deploy: later_deploy.ended_at.clone(),
            run_id: Some(later_deploy.id.clone()),
            variables: Vec::new(),
            observed_at: "2026-09-30T12:06:00Z".to_owned(),
            notes: vec!["Endpoint health was not probed.".to_owned()],
        };
        let cross_workspace_environment = OperationEnvironment {
            workspace_id: "workspace-2".to_owned(),
            run_id: Some(first_deploy.id.clone()),
            ..current_environment.clone()
        };

        let (_, first_deployments) = detail_relationships(
            &first_deploy,
            &[],
            &[current_environment.clone(), cross_workspace_environment],
        );
        assert_eq!(first_deployments.len(), 1);
        assert!(!first_deployments[0].is_current);
        assert_eq!(
            first_deployments[0].environment.deployment_status,
            "deployed_unverified"
        );
        assert_eq!(first_deployments[0].environment.health, "not_probed");
        assert_eq!(
            first_deployments[0].environment.run_id.as_deref(),
            Some("deploy-first")
        );
        assert_eq!(
            first_deployments[0].environment.urls,
            vec!["https://first.example.com/"]
        );

        let (_, later_deployments) = detail_relationships(
            &later_deploy,
            &[],
            std::slice::from_ref(&current_environment),
        );
        assert_eq!(later_deployments.len(), 1);
        assert!(later_deployments[0].is_current);
        assert_eq!(later_deployments[0].environment, current_environment);
    }

    #[test]
    fn activity_deduplicates_and_withholds_private_paths_and_secret_shaped_names() {
        let correlation = Correlation {
            workspace_id: Some("workspace-1".to_owned()),
            task_id: Some("test-run".to_owned()),
            ..Correlation::default()
        };
        let safe = event(
            "file-safe",
            "2026-09-30T10:02:00Z",
            correlation.clone(),
            EventPayload::FileModified {
                thread_id: None,
                path: "apps/desktop/src/App.tsx".to_owned(),
            },
        );
        let private = event(
            "file-private",
            "2026-09-30T10:01:00Z",
            correlation.clone(),
            EventPayload::FileCreated {
                thread_id: None,
                path: r"C:\Users\owner\private\.env".to_owned(),
            },
        );
        let secret = format!("{}{}", "ghp_", "0123456789abcdefghijklmnopqrstuvwxyzAB");
        let secret_file = event(
            "file-secret-name",
            "2026-09-30T10:01:30Z",
            correlation.clone(),
            EventPayload::FileCreated {
                thread_id: None,
                path: format!("target/{secret}.json"),
            },
        );
        let secret_tool = event(
            "tool-secret-name",
            "2026-09-30T10:01:45Z",
            correlation,
            EventPayload::ToolRequested {
                thread_id: "thread-1".to_owned(),
                tool_call_id: "tool-secret".to_owned(),
                tool: format!("runner-{secret}"),
                summary: String::new(),
            },
        );
        let mut test_run = run(
            "test-run",
            OperationKind::Test,
            OperationEnvironmentKind::Local,
        );
        test_run.spec.name = "API_KEY=ghp_0123456789abcdefghijklmnopqrstuvwxyzAB".to_owned();
        test_run.status = OperationStatus::Failed;
        test_run.ended_at = Some("2026-09-30T10:03:00Z".to_owned());
        let projected = activity(
            &[safe.clone(), safe, private, secret_file, secret_tool],
            &[test_run],
        );
        assert_eq!(
            projected
                .iter()
                .filter(|item| item.id == "event:file-safe")
                .count(),
            1
        );
        assert!(projected.iter().any(|item| item.area == "apps/desktop"));
        let json = serde_json::to_string(&projected).expect("json");
        assert!(!json.contains("C:\\Users"));
        assert!(!json.contains(".env"));
        assert!(!json.contains("ghp_"));
        assert!(!json.contains(&secret));
        assert!(json.contains("[REDACTED]"));
    }

    #[test]
    fn activity_uses_canonical_moments_for_owned_runs_and_preserves_observed_runs() {
        let mut owned = run(
            "owned-run",
            OperationKind::Build,
            OperationEnvironmentKind::Local,
        );
        owned.status = OperationStatus::Succeeded;
        owned.ended_at = Some("2026-09-30T10:03:00Z".to_owned());
        let moments = [
            kalcode_core::operations::OperationActivityMoment {
                operation_id: owned.id.clone(),
                workspace_id: owned.spec.workspace_id.clone(),
                operation_name: owned.spec.name.clone(),
                operation_kind: owned.spec.kind,
                moment: OperationMoment {
                    id: "moment-queued".to_owned(),
                    at: "2026-09-30T10:00:00Z".to_owned(),
                    kind: "queued".to_owned(),
                    message: "Added to the Operations queue.".to_owned(),
                },
            },
            kalcode_core::operations::OperationActivityMoment {
                operation_id: owned.id.clone(),
                workspace_id: owned.spec.workspace_id.clone(),
                operation_name: owned.spec.name.clone(),
                operation_kind: owned.spec.kind,
                moment: OperationMoment {
                    id: "moment-starting".to_owned(),
                    at: "2026-09-30T10:01:00Z".to_owned(),
                    kind: "starting".to_owned(),
                    message: "Execution claimed and starting.".to_owned(),
                },
            },
            kalcode_core::operations::OperationActivityMoment {
                operation_id: owned.id.clone(),
                workspace_id: owned.spec.workspace_id.clone(),
                operation_name: owned.spec.name.clone(),
                operation_kind: owned.spec.kind,
                moment: OperationMoment {
                    id: "moment-running".to_owned(),
                    at: "2026-09-30T10:02:00Z".to_owned(),
                    kind: "running".to_owned(),
                    message: "Execution is running.".to_owned(),
                },
            },
            kalcode_core::operations::OperationActivityMoment {
                operation_id: owned.id.clone(),
                workspace_id: owned.spec.workspace_id.clone(),
                operation_name: owned.spec.name.clone(),
                operation_kind: owned.spec.kind,
                moment: OperationMoment {
                    id: "moment-succeeded".to_owned(),
                    at: "2026-09-30T10:03:00Z".to_owned(),
                    kind: "succeeded".to_owned(),
                    message: "Completed successfully.".to_owned(),
                },
            },
        ];
        let mut observed = run(
            "observed-run",
            OperationKind::Script,
            OperationEnvironmentKind::Local,
        );
        observed.source = "terminal".to_owned();
        observed.status = OperationStatus::Succeeded;
        observed.ended_at = Some("2026-09-30T10:04:00Z".to_owned());

        let projected = activity_with_moments(&[], &[owned.clone(), observed.clone()], &moments);
        let owned_rows = projected
            .iter()
            .filter(|item| item.run_id.as_deref() == Some(owned.id.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(owned_rows.len(), 4);
        assert!(owned_rows.iter().all(|item| {
            item.workspace_id.as_deref() == Some(owned.spec.workspace_id.as_str())
        }));
        assert_eq!(
            owned_rows
                .iter()
                .map(|item| item.kind.as_str())
                .collect::<BTreeSet<_>>(),
            BTreeSet::from(["queued", "running", "starting", "succeeded"])
        );
        assert!(
            projected
                .iter()
                .all(|item| item.id != "run:owned-run:succeeded"),
            "the persisted ledger replaces the owned run's synthetic latest-only row"
        );
        assert!(projected.iter().any(|item| {
            item.id == "run:observed-run:succeeded"
                && item.run_id.as_deref() == Some(observed.id.as_str())
        }));
    }

    #[test]
    fn canonical_moment_activity_is_deduplicated_and_redacted() {
        let secret = format!("{}{}", "ghp_", "0123456789abcdefghijklmnopqrstuvwxyzAB");
        let entry = kalcode_core::operations::OperationActivityMoment {
            operation_id: "owned-run".to_owned(),
            workspace_id: "workspace-1".to_owned(),
            operation_name: format!("Build {secret}"),
            operation_kind: OperationKind::Build,
            moment: OperationMoment {
                id: "moment-progress".to_owned(),
                at: "2026-09-30T10:02:00Z".to_owned(),
                kind: "progress".to_owned(),
                message: format!("Provider returned {secret}"),
            },
        };
        let projected = activity_with_moments(&[], &[], &[entry.clone(), entry]);
        assert_eq!(projected.len(), 1);
        assert_eq!(projected[0].run_id.as_deref(), Some("owned-run"));
        assert_eq!(projected[0].workspace_id.as_deref(), Some("workspace-1"));
        let json = serde_json::to_string(&projected).expect("json");
        assert!(!json.contains(&secret));
        assert!(!json.contains("ghp_"));
        assert!(json.contains("[REDACTED]"));
    }

    #[test]
    fn activity_correlates_repeated_thread_turns_to_their_execution_windows() {
        let mut first = run(
            "turn:first",
            OperationKind::Agent,
            OperationEnvironmentKind::Local,
        );
        first.source = "thread".to_owned();
        first.thread_id = Some("thread-shared".to_owned());
        first.status = OperationStatus::Succeeded;
        first.created_at = "2026-09-30T10:00:00Z".to_owned();
        first.started_at = Some(first.created_at.clone());
        first.ended_at = Some("2026-09-30T10:05:00Z".to_owned());

        let mut second = first.clone();
        second.id = "turn:second".to_owned();
        second.created_at = "2026-09-30T10:10:00Z".to_owned();
        second.started_at = Some(second.created_at.clone());
        second.ended_at = Some("2026-09-30T10:15:00Z".to_owned());

        let first_completion = event(
            "first-completion",
            "2026-09-30T10:05:00Z",
            Correlation::default(),
            EventPayload::AgentTurnCompleted {
                thread_id: "thread-shared".to_owned(),
                ok: true,
                interrupted: false,
            },
        );
        let second_completion = event(
            "second-completion",
            "2026-09-30T10:15:00Z",
            Correlation::default(),
            EventPayload::AgentTurnCompleted {
                thread_id: "thread-shared".to_owned(),
                ok: true,
                interrupted: false,
            },
        );

        let projected = activity(&[first_completion, second_completion], &[first, second]);
        let by_id = projected
            .iter()
            .map(|item| (item.id.as_str(), item.run_id.as_deref()))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(by_id["event:first-completion"], Some("turn:first"));
        assert_eq!(by_id["event:second-completion"], Some("turn:second"));
    }

    #[test]
    fn activity_correlates_reused_terminal_generations_without_guessing_overlap() {
        let mut first = run(
            "shell:first-start",
            OperationKind::Script,
            OperationEnvironmentKind::Local,
        );
        first.source = "terminal".to_owned();
        first.terminal_id = Some("terminal-shared".to_owned());
        first.status = OperationStatus::Succeeded;
        first.created_at = "2026-09-30T11:00:00Z".to_owned();
        first.started_at = Some(first.created_at.clone());
        first.ended_at = Some("2026-09-30T11:05:00Z".to_owned());

        let mut second = first.clone();
        second.id = "shell:second-start".to_owned();
        second.created_at = "2026-09-30T11:10:00Z".to_owned();
        second.started_at = Some(second.created_at.clone());
        second.ended_at = Some("2026-09-30T11:15:00Z".to_owned());

        let first_completion = event(
            "first-completion",
            "2026-09-30T11:05:00Z",
            Correlation::default(),
            EventPayload::ShellCompleted {
                terminal_id: "terminal-shared".to_owned(),
                exit_code: 0,
                closed_by_user: false,
            },
        );
        let second_completion = event(
            "second-completion",
            "2026-09-30T11:15:00Z",
            Correlation::default(),
            EventPayload::ShellCompleted {
                terminal_id: "terminal-shared".to_owned(),
                exit_code: 0,
                closed_by_user: false,
            },
        );

        let projected = activity(&[first_completion, second_completion], &[first, second]);
        let by_id = projected
            .iter()
            .map(|item| (item.id.as_str(), item.run_id.as_deref()))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(by_id["event:first-completion"], Some("shell:first-start"));
        assert_eq!(by_id["event:second-completion"], Some("shell:second-start"));

        let mut overlapping_first = run(
            "shell:ambiguous-first",
            OperationKind::Script,
            OperationEnvironmentKind::Local,
        );
        overlapping_first.source = "terminal".to_owned();
        overlapping_first.terminal_id = Some("terminal-ambiguous".to_owned());
        overlapping_first.started_at = Some("2026-09-30T12:00:00Z".to_owned());
        overlapping_first.ended_at = Some("2026-09-30T12:10:00Z".to_owned());
        let mut overlapping_second = overlapping_first.clone();
        overlapping_second.id = "shell:ambiguous-second".to_owned();
        overlapping_second.started_at = Some("2026-09-30T12:10:00Z".to_owned());
        overlapping_second.ended_at = Some("2026-09-30T12:20:00Z".to_owned());
        let ambiguous = event(
            "ambiguous-completion",
            "2026-09-30T12:10:00Z",
            Correlation::default(),
            EventPayload::ShellCompleted {
                terminal_id: "terminal-ambiguous".to_owned(),
                exit_code: 0,
                closed_by_user: false,
            },
        );
        let projected = activity(&[ambiguous], &[overlapping_first, overlapping_second]);
        assert_eq!(
            projected
                .iter()
                .find(|item| item.id == "event:ambiguous-completion")
                .and_then(|item| item.run_id.as_deref()),
            None,
            "an event inside two execution windows must remain unlinked"
        );
    }

    #[test]
    fn timeline_requires_exact_run_correlation() {
        let mut selected = run(
            "run-1",
            OperationKind::Agent,
            OperationEnvironmentKind::Local,
        );
        selected.thread_id = Some("thread-1".to_owned());
        let shared_workspace = Some("workspace-1".to_owned());
        let relevant = event(
            "relevant",
            "2026-09-30T10:01:00Z",
            Correlation {
                workspace_id: shared_workspace.clone(),
                thread_id: Some("thread-1".to_owned()),
                ..Correlation::default()
            },
            EventPayload::ThreadStarted {
                thread_id: "thread-1".to_owned(),
            },
        );
        let unrelated = event(
            "unrelated",
            "2026-09-30T10:02:00Z",
            Correlation {
                workspace_id: shared_workspace,
                thread_id: Some("thread-2".to_owned()),
                ..Correlation::default()
            },
            EventPayload::ThreadStarted {
                thread_id: "thread-2".to_owned(),
            },
        );
        let projected = timeline(&[relevant, unrelated], &selected);
        assert!(projected.iter().any(|moment| moment.id == "event:relevant"));
        assert!(
            !projected
                .iter()
                .any(|moment| moment.id == "event:unrelated")
        );
        assert!(
            projected
                .iter()
                .all(|moment| !moment.id.starts_with("run:")),
            "owned Operations runs use their persisted moment ledger"
        );
    }

    #[test]
    fn observed_run_timeline_uses_captured_lifecycle_timestamps() {
        let mut observed = run(
            "observed-terminal",
            OperationKind::Script,
            OperationEnvironmentKind::Local,
        );
        observed.source = "terminal".to_owned();
        observed.status = OperationStatus::Succeeded;
        observed.started_at = Some("2026-09-30T10:01:00Z".to_owned());
        observed.ended_at = Some("2026-09-30T10:02:00Z".to_owned());
        let projected = timeline(&[], &observed);
        assert_eq!(projected.len(), 3);
        assert_eq!(projected[0].id, "run:observed-terminal:created");
        assert_eq!(projected[1].id, "run:observed-terminal:started");
        assert_eq!(projected[2].id, "run:observed-terminal:ended");
    }

    #[test]
    fn observed_tool_timeline_uses_only_its_exact_tool_call_id() {
        let mut selected = run(
            "tool:tool-1",
            OperationKind::Script,
            OperationEnvironmentKind::Local,
        );
        selected.source = "tool".to_owned();
        selected.thread_id = Some("shared-thread".to_owned());
        let requested = event(
            "tool-1-requested",
            "2026-09-30T10:01:00Z",
            Correlation::default(),
            EventPayload::ToolRequested {
                thread_id: "shared-thread".to_owned(),
                tool_call_id: "tool-1".to_owned(),
                tool: "shell".to_owned(),
                summary: "Run checks".to_owned(),
            },
        );
        let completed = event(
            "tool-1-completed",
            "2026-09-30T10:02:00Z",
            Correlation::default(),
            EventPayload::ToolCompleted {
                thread_id: "shared-thread".to_owned(),
                tool_call_id: "tool-1".to_owned(),
            },
        );
        let sibling = event(
            "tool-2-requested",
            "2026-09-30T10:01:30Z",
            Correlation::default(),
            EventPayload::ToolRequested {
                thread_id: "shared-thread".to_owned(),
                tool_call_id: "tool-2".to_owned(),
                tool: "shell".to_owned(),
                summary: "Other work".to_owned(),
            },
        );
        let sibling_file = event(
            "shared-thread-file",
            "2026-09-30T10:01:45Z",
            Correlation::default(),
            EventPayload::FileModified {
                thread_id: Some("shared-thread".to_owned()),
                path: "src/sibling.rs".to_owned(),
            },
        );
        let events = [requested, completed, sibling, sibling_file];
        let projected = timeline(&events, &selected);
        assert!(
            projected
                .iter()
                .any(|moment| moment.id == "event:tool-1-requested")
        );
        assert!(
            projected
                .iter()
                .any(|moment| moment.id == "event:tool-1-completed")
        );
        assert!(
            projected
                .iter()
                .all(|moment| moment.id != "event:tool-2-requested"
                    && moment.id != "event:shared-thread-file")
        );
        let (files, artifacts, tests) = detail_evidence(&events, &selected);
        assert!(files.is_empty());
        assert!(artifacts.is_empty());
        assert!(tests.is_empty());

        let mut parent = run(
            "parent-thread",
            OperationKind::Agent,
            OperationEnvironmentKind::Local,
        );
        parent.source = "thread".to_owned();
        parent.thread_id = Some("shared-thread".to_owned());
        parent.ended_at = Some("2026-09-30T11:00:00Z".to_owned());
        let activity = activity(&events, &[selected, parent]);
        assert_eq!(
            activity
                .iter()
                .find(|item| item.id == "event:tool-1-requested")
                .and_then(|item| item.run_id.as_deref()),
            Some("tool:tool-1"),
            "the exact tool identity wins over its newer parent thread"
        );
    }

    #[test]
    fn doctor_timeline_uses_only_its_payload_run_id() {
        let mut selected = run(
            "background:doctor:doctor-1",
            OperationKind::Background,
            OperationEnvironmentKind::Local,
        );
        selected.source = "background".to_owned();
        let own = event(
            "doctor-1-started",
            "2026-09-30T10:01:00Z",
            Correlation::default(),
            EventPayload::DoctorRunStarted {
                run_id: "doctor-1".to_owned(),
                checks: 10,
            },
        );
        let sibling = event(
            "doctor-2-started",
            "2026-09-30T10:01:30Z",
            Correlation::default(),
            EventPayload::DoctorRunStarted {
                run_id: "doctor-2".to_owned(),
                checks: 12,
            },
        );
        let projected = timeline(&[own, sibling], &selected);
        assert!(
            projected
                .iter()
                .any(|moment| moment.id == "event:doctor-1-started")
        );
        assert!(
            projected
                .iter()
                .all(|moment| moment.id != "event:doctor-2-started")
        );
    }

    #[test]
    fn agent_turn_completion_preserves_success_failure_and_interruption() {
        let completed = event(
            "turn-ok",
            "2026-09-30T10:01:00Z",
            Correlation::default(),
            EventPayload::AgentTurnCompleted {
                thread_id: "thread-ok".to_owned(),
                ok: true,
                interrupted: false,
            },
        );
        let failed = event(
            "turn-failed",
            "2026-09-30T10:02:00Z",
            Correlation::default(),
            EventPayload::AgentTurnCompleted {
                thread_id: "thread-failed".to_owned(),
                ok: false,
                interrupted: false,
            },
        );
        let interrupted = event(
            "turn-interrupted",
            "2026-09-30T10:03:00Z",
            Correlation::default(),
            EventPayload::AgentTurnCompleted {
                thread_id: "thread-interrupted".to_owned(),
                ok: false,
                interrupted: true,
            },
        );
        let projected = activity(&[completed, failed, interrupted], &[]);
        let by_id = projected
            .iter()
            .map(|item| (item.id.as_str(), (item.kind.as_str(), item.name.as_str())))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(by_id["event:turn-ok"], ("agent", "Agent task completed"));
        assert_eq!(by_id["event:turn-failed"], ("failure", "Agent task failed"));
        assert_eq!(
            by_id["event:turn-interrupted"],
            ("agent", "Agent task interrupted")
        );

        let mut thread_run = run(
            "observed-thread",
            OperationKind::Agent,
            OperationEnvironmentKind::Local,
        );
        thread_run.source = "thread".to_owned();
        thread_run.thread_id = Some("thread-ok".to_owned());
        let turn = event(
            "turn-timeline",
            "2026-09-30T10:04:00Z",
            Correlation::default(),
            EventPayload::AgentTurnCompleted {
                thread_id: "thread-ok".to_owned(),
                ok: true,
                interrupted: false,
            },
        );
        let timeline = timeline(&[turn], &thread_run);
        assert!(timeline.iter().any(|moment| {
            moment.id == "event:turn-timeline" && moment.message == "Agent task completed"
        }));
    }

    #[test]
    fn detail_evidence_uses_typed_files_and_one_terminal_test_outcome() {
        let mut test_run = run(
            "test-run",
            OperationKind::Test,
            OperationEnvironmentKind::Local,
        );
        test_run.status = OperationStatus::Succeeded;
        test_run.terminal_id = Some("terminal-1".to_owned());
        let correlation = Correlation {
            task_id: Some("test-run".to_owned()),
            ..Correlation::default()
        };
        let safe = event(
            "created-safe",
            "2026-09-30T10:01:00Z",
            correlation.clone(),
            EventPayload::FileCreated {
                thread_id: None,
                path: "target/report.json".to_owned(),
            },
        );
        let traversal = event(
            "created-unsafe",
            "2026-09-30T10:02:00Z",
            correlation.clone(),
            EventPayload::FileCreated {
                thread_id: None,
                path: "target/../../private.txt".to_owned(),
            },
        );
        let tool = event(
            "tool-secret",
            "2026-09-30T10:03:00Z",
            correlation,
            EventPayload::ToolRequested {
                thread_id: "thread-1".to_owned(),
                tool_call_id: "tool-1".to_owned(),
                tool: "shell".to_owned(),
                summary: "PASSWORD=should-never-appear".to_owned(),
            },
        );
        let command = event(
            "test-command",
            "2026-09-30T10:04:00Z",
            Correlation::default(),
            EventPayload::ShellCompleted {
                terminal_id: "terminal-1".to_owned(),
                exit_code: 0,
                closed_by_user: false,
            },
        );
        let (files, artifacts, tests) =
            detail_evidence(&[safe, traversal, tool, command], &test_run);
        assert_eq!(files, vec!["target/report.json"]);
        assert_eq!(artifacts.len(), 1);
        assert_eq!(artifacts[0].location, "target/report.json");
        assert_eq!(tests.len(), 1);
        assert_eq!(tests[0].status, "passed");
        let json = serde_json::to_string(&(files, artifacts, tests)).expect("json");
        assert!(!json.contains("should-never-appear"));
        assert!(!json.contains("private.txt"));
        assert!(!json.contains("tests passed"));
    }

    #[test]
    fn reported_operation_artifact_is_not_fabricated_as_a_created_file() {
        let run = run(
            "artifact-run",
            OperationKind::Build,
            OperationEnvironmentKind::Local,
        );
        let reported = event(
            "artifact-reported",
            "2026-09-30T10:01:00Z",
            Correlation {
                workspace_id: Some("workspace-1".to_owned()),
                task_id: Some(run.id.clone()),
                ..Correlation::default()
            },
            EventPayload::OperationArtifactReported {
                path: "dist/app.zip".to_owned(),
            },
        );

        let (files, artifacts, tests) = detail_evidence(std::slice::from_ref(&reported), &run);
        assert!(
            files.is_empty(),
            "a report does not prove a file was created"
        );
        assert!(tests.is_empty());
        assert_eq!(artifacts.len(), 1);
        assert_eq!(artifacts[0].name, "app.zip");
        assert_eq!(artifacts[0].location, "dist/app.zip");
        assert_eq!(artifacts[0].kind, "reported_file");

        let projected = activity(&[reported], &[run]);
        assert_eq!(projected.len(), 2, "run lifecycle plus artifact report");
        assert!(projected.iter().any(|item| {
            item.kind == "artifact"
                && item.name == "Artifact reported · dist/app.zip"
                && item.area == "dist"
                && item.run_id.as_deref() == Some("artifact-run")
        }));
    }

    #[test]
    fn reported_artifact_keeps_exact_run_link_after_run_leaves_snapshot() {
        let workspace_id = kalcode_contracts::ids::new_id();
        let run_id = kalcode_contracts::ids::new_id();
        let reported = event(
            "late-artifact",
            "2026-09-30T11:00:00Z",
            Correlation {
                workspace_id: Some(workspace_id.clone()),
                task_id: Some(run_id.clone()),
                ..Correlation::default()
            },
            EventPayload::OperationArtifactReported {
                path: "dist/archive.zip".to_owned(),
            },
        );

        let projected = activity(&[reported], &[]);
        assert_eq!(projected.len(), 1);
        assert_eq!(projected[0].run_id.as_deref(), Some(run_id.as_str()));
        assert_eq!(
            projected[0].workspace_id.as_deref(),
            Some(workspace_id.as_str())
        );
    }

    #[test]
    fn a_test_run_without_a_correlated_terminal_exit_has_no_invented_result() {
        let mut test_run = run(
            "test-run",
            OperationKind::Test,
            OperationEnvironmentKind::Local,
        );
        test_run.status = OperationStatus::Succeeded;
        test_run.outcome = Some("All 248 tests passed".to_owned());
        let (_, _, tests) = detail_evidence(&[], &test_run);
        assert!(tests.is_empty());
    }
}
