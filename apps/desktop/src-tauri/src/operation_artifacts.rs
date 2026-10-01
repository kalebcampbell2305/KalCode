//! Bounded command-to-Operations artifact evidence handoff.
//!
//! Operations commands may atomically rename one JSON report to the native path in
//! `KALCODE_OPERATION_ARTIFACT_REPORT`. Reports are optional and contain workspace-relative
//! regular-file paths only. Native code never scans the workspace or parses terminal output.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use kalcode_contracts::events::{
    Correlation, CorrelationFilter, EventPayload, EventQuery, EventSource, NewEvent, SeqOrder,
};
use kalcode_contracts::operations::{OPERATION_ARTIFACT_REPORT_ENV, OperationRecord};
use kalcode_core::protected_file::{
    consume_operation_artifact_report_file, is_link_or_reparse,
    open_ordinary_file_without_following, read_bounded_ordinary_file,
};
use kalcode_core::{Core, KalError, Result};
use kalcode_git::{RelPath, WorkspaceRoot};
use serde::Deserialize;

pub const REPORT_ENV: &str = OPERATION_ARTIFACT_REPORT_ENV;
const REPORT_VERSION: u8 = 1;
const MAX_REPORT_BYTES: u64 = 64 * 1024;
const MAX_ARTIFACTS: usize = 256;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ArtifactReport {
    version: u8,
    artifacts: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Collection {
    Missing,
    Imported,
    Rejected,
}

pub fn prepare(core: &Core, operation_id: &str) -> Result<PathBuf> {
    let path = report_path(core, operation_id)?;
    remove_owned_report(&path)?;
    Ok(path)
}

pub fn collect(core: &Core, run: &OperationRecord) -> Result<Collection> {
    if run.source != "operations"
        || run.terminal_id.as_deref() != Some(run.id.as_str())
        || run.spec.workspace_id.is_empty()
    {
        return Err(KalError::internal(
            "operation_artifact_identity_invalid",
            "Artifact evidence was not linked to an exact Operations terminal.",
        ));
    }
    let report = report_path(core, &run.id)?;
    let metadata = match std::fs::symlink_metadata(&report) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let consumed = consumed_path(&report);
            match std::fs::symlink_metadata(&consumed) {
                Ok(_) => {
                    let existing = existing_evidence(core, run)?;
                    if consume_operation_artifact_report_file(&consumed, &report) {
                        return Ok(if existing.rejected {
                            Collection::Rejected
                        } else {
                            Collection::Imported
                        });
                    }
                    if existing.rejected {
                        return Ok(Collection::Rejected);
                    }
                    return reject(core, run, &consumed, "report_invalid_file", None);
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(Collection::Missing);
                }
                Err(error) => {
                    return reject(core, run, &consumed, "report_unavailable", Some(error));
                }
            }
        }
        Err(error) => return reject(core, run, &report, "report_unavailable", Some(error)),
    };
    let existing = existing_evidence(core, run)?;
    if existing.rejected {
        return Ok(Collection::Rejected);
    }
    if !metadata.is_file() || is_link_or_reparse(&metadata) || metadata.len() > MAX_REPORT_BYTES {
        return reject(core, run, &report, "report_invalid_file", None);
    }
    let expected = match std::fs::canonicalize(&report) {
        Ok(expected) if expected == report => expected,
        _ => return reject(core, run, &report, "report_invalid_file", None),
    };
    let Some(bytes) = read_bounded_ordinary_file(&report, &expected, MAX_REPORT_BYTES) else {
        return reject(core, run, &report, "report_changed", None);
    };
    let parsed: ArtifactReport = match serde_json::from_slice(&bytes) {
        Ok(parsed) => parsed,
        Err(_) => return reject(core, run, &report, "report_invalid_json", None),
    };
    if parsed.version != REPORT_VERSION || parsed.artifacts.len() > MAX_ARTIFACTS {
        return reject(core, run, &report, "report_invalid_schema", None);
    }

    let Some(workspace) = core
        .workspaces()?
        .into_iter()
        .find(|workspace| workspace.id == run.spec.workspace_id)
    else {
        return reject(core, run, &report, "artifact_workspace_missing", None);
    };
    let root = match WorkspaceRoot::new(&workspace.id, Path::new(&workspace.root_path)) {
        Ok(root) => root,
        Err(_) => return reject(core, run, &report, "artifact_workspace_unavailable", None),
    };
    let mut paths = BTreeSet::new();
    for raw in parsed.artifacts {
        let Some(normalized) = kalcode_utilities::operation_evidence::safe_relative_path(&raw)
        else {
            return reject(core, run, &report, "artifact_path_rejected", None);
        };
        if existing.reported.contains(&normalized) {
            continue;
        }
        let Some(canonical) = verified_artifact(&root, &raw) else {
            return reject(core, run, &report, "artifact_not_regular_file", None);
        };
        if existing.reported.contains(&canonical) {
            continue;
        }
        paths.insert(canonical);
    }

    for path in paths {
        core.emit(NewEvent {
            source: EventSource::Core,
            correlation: Correlation {
                workspace_id: Some(run.spec.workspace_id.clone()),
                task_id: Some(run.id.clone()),
                ..Correlation::default()
            },
            event: EventPayload::OperationArtifactReported { path },
        })?;
    }
    remove_owned_report(&report)?;
    Ok(Collection::Imported)
}

struct ExistingEvidence {
    reported: BTreeSet<String>,
    rejected: bool,
}

fn existing_evidence(core: &Core, run: &OperationRecord) -> Result<ExistingEvidence> {
    let events = core
        .query_events(&EventQuery {
            types: vec![
                "operation.artifact_reported".to_owned(),
                "operation.artifact_report_rejected".to_owned(),
            ],
            correlation: CorrelationFilter {
                workspace_id: Some(run.spec.workspace_id.clone()),
                task_id: Some(run.id.clone()),
                ..CorrelationFilter::default()
            },
            order: SeqOrder::Asc,
            limit: 500,
            ..EventQuery::default()
        })?
        .events;
    let mut reported = BTreeSet::new();
    let mut rejected = false;
    for event in events {
        match event.event {
            EventPayload::OperationArtifactReported { path } => {
                reported.insert(path);
            }
            EventPayload::OperationArtifactReportRejected { .. } => rejected = true,
            _ => {}
        }
    }
    Ok(ExistingEvidence { reported, rejected })
}

fn reject(
    core: &Core,
    run: &OperationRecord,
    report: &Path,
    code: &'static str,
    source: Option<std::io::Error>,
) -> Result<Collection> {
    if let Some(source) = source {
        tracing::warn!(event = "operations.artifact_report_rejected", code, error = %source);
    } else {
        tracing::warn!(event = "operations.artifact_report_rejected", code);
    }
    if !existing_evidence(core, run)?.rejected {
        core.emit(NewEvent {
            source: EventSource::Core,
            correlation: Correlation {
                workspace_id: Some(run.spec.workspace_id.clone()),
                task_id: Some(run.id.clone()),
                ..Correlation::default()
            },
            event: EventPayload::OperationArtifactReportRejected {
                code: code.to_owned(),
            },
        })?;
    }
    // Rejection evidence is the durable consumption marker. Cleanup is best effort because an
    // invalid report may itself be a directory/link, which must never be removed through here.
    let _ = remove_owned_report(report);
    Ok(Collection::Rejected)
}

fn report_path(core: &Core, operation_id: &str) -> Result<PathBuf> {
    kalcode_core::workspaces::validate_id(operation_id)?;
    let mut directory = core.paths().data_dir.clone();
    for component in ["operations", "artifact-reports"] {
        directory.push(component);
        match std::fs::create_dir(&directory) {
            Ok(()) => set_private_permissions(&directory)?,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(storage_error(error)),
        }
        let metadata = std::fs::symlink_metadata(&directory).map_err(storage_error)?;
        if !metadata.is_dir() || is_link_or_reparse(&metadata) {
            return Err(KalError::internal(
                "operation_artifact_storage_unsafe",
                "The artifact report directory is not an ordinary private directory.",
            ));
        }
    }
    let directory = std::fs::canonicalize(&directory).map_err(storage_error)?;
    let data = std::fs::canonicalize(&core.paths().data_dir).map_err(storage_error)?;
    if !directory.starts_with(data) {
        return Err(KalError::internal(
            "operation_artifact_storage_unsafe",
            "The artifact report directory left KalCode's data directory.",
        ));
    }
    Ok(directory.join(format!("{operation_id}.json")))
}

fn reject_link_components(root: &WorkspaceRoot, relative: &RelPath) -> Result<()> {
    let mut current = root.path().to_path_buf();
    for component in relative.components() {
        current.push(component);
        let metadata = std::fs::symlink_metadata(&current).map_err(storage_error)?;
        if is_link_or_reparse(&metadata) {
            return Err(artifact_rejected());
        }
    }
    Ok(())
}

fn verified_artifact(root: &WorkspaceRoot, raw: &str) -> Option<String> {
    let safe = kalcode_utilities::operation_evidence::safe_relative_path(raw)?;
    let relative = RelPath::parse(&safe).ok()?;
    reject_link_components(root, &relative).ok()?;
    let file = open_ordinary_file_without_following(&relative.to_native(root.path()))?;
    let opened = root.verify_opened(&relative, &file).ok()?;
    if !file.metadata().is_ok_and(|metadata| metadata.is_file()) {
        return None;
    }
    let canonical = root.relativize(&opened)?;
    kalcode_utilities::operation_evidence::safe_relative_path(canonical.as_str())
}

fn remove_owned_report(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !is_link_or_reparse(&metadata) => {
            let expected = std::fs::canonicalize(path).map_err(storage_error)?;
            if expected != path || open_ordinary_file_without_following(path).is_none() {
                return Err(KalError::internal(
                    "operation_artifact_report_replaced",
                    "The artifact report changed before cleanup.",
                ));
            }
            let quarantine = consumed_path(path);
            if consume_operation_artifact_report_file(path, &quarantine) {
                Ok(())
            } else {
                Err(KalError::internal(
                    "operation_artifact_report_replaced",
                    "The artifact report changed before cleanup.",
                ))
            }
        }
        Ok(_) => Err(KalError::internal(
            "operation_artifact_report_replaced",
            "The artifact report path is not an ordinary file.",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(storage_error(error)),
    }
}

fn consumed_path(path: &Path) -> PathBuf {
    path.with_extension("json.consumed")
}

fn artifact_rejected() -> KalError {
    KalError::validation(
        "operation_artifact_rejected",
        "A reported artifact was not a safe regular file in this workspace.",
    )
}

fn storage_error(error: std::io::Error) -> KalError {
    KalError::internal(
        "operation_artifact_storage_failed",
        "KalCode could not verify artifact report storage.",
    )
    .with_source(error)
}

#[cfg(unix)]
fn set_private_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt as _;

    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).map_err(storage_error)
}

#[cfg(not(unix))]
fn set_private_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use kalcode_contracts::operations::{
        OperationEnvironmentKind, OperationKind, OperationLane, OperationSpec, OperationStatus,
    };
    use kalcode_core::flags::BuildChannel;
    use kalcode_core::workspaces::{TerminalSize, TerminalStatus};
    use kalcode_core::{CoreConfig, Paths};

    fn fixture() -> (
        tempfile::TempDir,
        tempfile::TempDir,
        Arc<Core>,
        OperationRecord,
    ) {
        let data = tempfile::tempdir().expect("data");
        let project = tempfile::tempdir().expect("project");
        let core = Arc::new(
            Core::open(CoreConfig {
                paths: Paths::new(data.path()),
                app_version: "0.1.7-test".into(),
                channel: BuildChannel::Development,
            })
            .expect("core"),
        );
        let workspace = core.open_workspace(project.path()).expect("workspace");
        let id = kalcode_contracts::ids::new_id();
        let run = OperationRecord {
            id: id.clone(),
            spec: OperationSpec {
                name: "Artifact-producing command".into(),
                workspace_id: workspace.id,
                kind: OperationKind::Build,
                command: Some("fixture".into()),
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
            },
            source: "operations".into(),
            status: OperationStatus::Succeeded,
            workspace_name: workspace.name,
            branch: None,
            version: None,
            account_label: None,
            terminal_id: Some(id),
            thread_id: None,
            created_at: "2026-09-30T12:00:00.000Z".into(),
            started_at: Some("2026-09-30T12:00:01.000Z".into()),
            ended_at: Some("2026-09-30T12:00:02.000Z".into()),
            current_action: None,
            outcome: Some("Succeeded".into()),
            position: 0,
            blockers: Vec::new(),
        };
        (data, project, core, run)
    }

    fn emit_reported(core: &Core, run: &OperationRecord, path: &str) {
        core.emit(NewEvent {
            source: EventSource::Core,
            correlation: Correlation {
                workspace_id: Some(run.spec.workspace_id.clone()),
                task_id: Some(run.id.clone()),
                ..Correlation::default()
            },
            event: EventPayload::OperationArtifactReported {
                path: path.to_owned(),
            },
        })
        .expect("emit reported event");
    }

    fn evidence(core: &Core, run: &OperationRecord) -> Vec<EventPayload> {
        core.query_events(&EventQuery {
            types: vec![
                "operation.artifact_reported".into(),
                "operation.artifact_report_rejected".into(),
            ],
            correlation: CorrelationFilter {
                workspace_id: Some(run.spec.workspace_id.clone()),
                task_id: Some(run.id.clone()),
                ..CorrelationFilter::default()
            },
            order: SeqOrder::Asc,
            limit: 20,
            ..EventQuery::default()
        })
        .expect("events")
        .events
        .into_iter()
        .map(|event| event.event)
        .collect()
    }

    fn report_command(core: &Core) -> &'static str {
        match core.shells().first().map(|shell| shell.id.as_str()) {
            Some("pwsh" | "powershell") => {
                r#"New-Item -ItemType Directory -Force dist | Out-Null; [System.IO.File]::WriteAllText('dist/app.zip','artifact'); $report=$env:KALCODE_OPERATION_ARTIFACT_REPORT; $tmp="$report.tmp"; [System.IO.File]::WriteAllText($tmp,'{"version":1,"artifacts":["dist/app.zip"]}'); Move-Item -LiteralPath $tmp -Destination $report"#
            }
            Some("cmd") => {
                r#"if not exist dist mkdir dist & <nul set /p "=artifact">dist\app.zip & >"%KALCODE_OPERATION_ARTIFACT_REPORT%.tmp" echo {"version":1,"artifacts":["dist/app.zip"]} & move /Y "%KALCODE_OPERATION_ARTIFACT_REPORT%.tmp" "%KALCODE_OPERATION_ARTIFACT_REPORT%" >nul"#
            }
            _ => {
                r#"mkdir -p dist; printf artifact > dist/app.zip; tmp="${KALCODE_OPERATION_ARTIFACT_REPORT}.tmp"; printf '%s' '{"version":1,"artifacts":["dist/app.zip"]}' > "$tmp"; mv "$tmp" "$KALCODE_OPERATION_ARTIFACT_REPORT""#
            }
        }
    }

    fn wait_for_exit(core: &Core, terminal_id: &str) {
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            if core
                .terminal(terminal_id)
                .is_ok_and(|terminal| terminal.status == TerminalStatus::Exited)
            {
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        panic!("operation terminal did not exit");
    }

    #[test]
    fn real_operation_command_atomically_reports_a_verified_artifact() {
        let (_data, project, core, run) = fixture();
        let report = prepare(&core, &run.id).expect("report path");
        core.create_operation_terminal_with_artifact_report(
            &run.spec.workspace_id,
            &run.id,
            report_command(&core),
            &report,
            TerminalSize::new(120, 30).expect("size"),
        )
        .expect("start command");
        wait_for_exit(&core, &run.id);
        let terminal = core.terminal(&run.id).expect("terminal");
        assert_eq!(terminal.exit_code, Some(0));

        assert_eq!(collect(&core, &run).expect("collect"), Collection::Imported);
        assert_eq!(
            std::fs::read(project.path().join("dist/app.zip")).expect("artifact"),
            b"artifact"
        );
        assert!(evidence(&core, &run).iter().any(|event| matches!(
            event,
            EventPayload::OperationArtifactReported { path } if path == "dist/app.zip"
        )));
        assert!(!report.exists());
    }

    #[test]
    fn replay_skips_durable_artifact_before_filesystem_verification() {
        let (_data, project, core, run) = fixture();
        emit_reported(&core, &run, "dist/app.zip");
        let report = prepare(&core, &run.id).expect("report path");
        std::fs::write(&report, br#"{"version":1,"artifacts":["dist/app.zip"]}"#).expect("report");
        assert!(!project.path().join("dist/app.zip").exists());

        assert_eq!(collect(&core, &run).expect("replay"), Collection::Imported);
        assert!(!report.exists());
        let events = evidence(&core, &run);
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, EventPayload::OperationArtifactReported { .. }))
                .count(),
            1
        );
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, EventPayload::OperationArtifactReportRejected { .. }))
        );
    }

    #[test]
    fn restart_recovers_consumed_report_after_durable_import() {
        let (_data, _project, core, run) = fixture();
        emit_reported(&core, &run, "dist/app.zip");
        let report = prepare(&core, &run.id).expect("report path");
        let consumed = consumed_path(&report);
        std::fs::write(&consumed, b"crash-window-content").expect("consumed report");

        assert_eq!(collect(&core, &run).expect("recover"), Collection::Imported);
        assert!(!report.exists());
        assert!(!consumed.exists());
    }

    #[test]
    fn restart_consumes_an_empty_accepted_report_marker() {
        let (_data, _project, core, run) = fixture();
        let report = prepare(&core, &run.id).expect("report path");
        let consumed = consumed_path(&report);
        std::fs::write(&consumed, br#"{"version":1,"artifacts":[]}"#).expect("consumed report");

        assert_eq!(collect(&core, &run).expect("recover"), Collection::Imported);
        assert!(!report.exists());
        assert!(!consumed.exists());
        assert!(evidence(&core, &run).is_empty());
    }

    #[test]
    fn restart_consumes_rejected_report_marker_without_duplicate_evidence() {
        let (_data, _project, core, run) = fixture();
        core.emit(NewEvent {
            source: EventSource::Core,
            correlation: Correlation {
                workspace_id: Some(run.spec.workspace_id.clone()),
                task_id: Some(run.id.clone()),
                ..Correlation::default()
            },
            event: EventPayload::OperationArtifactReportRejected {
                code: "report_invalid_json".into(),
            },
        })
        .expect("emit rejection");
        let report = prepare(&core, &run.id).expect("report path");
        let consumed = consumed_path(&report);
        std::fs::write(&consumed, b"invalid").expect("consumed report");

        assert_eq!(collect(&core, &run).expect("recover"), Collection::Rejected);
        assert!(!report.exists());
        assert!(!consumed.exists());
        assert_eq!(
            evidence(&core, &run)
                .iter()
                .filter(|event| matches!(
                    event,
                    EventPayload::OperationArtifactReportRejected { .. }
                ))
                .count(),
            1
        );
    }

    #[cfg(windows)]
    #[test]
    fn replay_deduplicates_case_variant_against_verified_canonical_path() {
        let (_data, project, core, run) = fixture();
        std::fs::create_dir(project.path().join("dist")).expect("dist");
        std::fs::write(project.path().join("dist/app.zip"), b"artifact").expect("artifact");
        emit_reported(&core, &run, "dist/app.zip");
        let report = prepare(&core, &run.id).expect("report path");
        std::fs::write(&report, br#"{"version":1,"artifacts":["DIST/App.zip"]}"#).expect("report");

        assert_eq!(collect(&core, &run).expect("replay"), Collection::Imported);
        assert_eq!(
            evidence(&core, &run)
                .iter()
                .filter(|event| matches!(event, EventPayload::OperationArtifactReported { .. }))
                .count(),
            1
        );
    }

    #[test]
    fn invalid_nonordinary_report_is_rejected_once_and_then_quiet() {
        let (_data, _project, core, run) = fixture();
        let report = prepare(&core, &run.id).expect("report path");
        std::fs::create_dir(&report).expect("invalid report directory");

        assert_eq!(collect(&core, &run).expect("first"), Collection::Rejected);
        assert_eq!(collect(&core, &run).expect("second"), Collection::Rejected);
        assert_eq!(
            evidence(&core, &run)
                .iter()
                .filter(|event| matches!(
                    event,
                    EventPayload::OperationArtifactReportRejected { .. }
                ))
                .count(),
            1
        );
        assert!(report.is_dir());
    }

    #[test]
    fn unavailable_workspace_rejects_once_and_consumes_the_report() {
        let (_data, project, core, run) = fixture();
        let report = prepare(&core, &run.id).expect("report path");
        std::fs::write(&report, br#"{"version":1,"artifacts":["dist/app.zip"]}"#).expect("report");
        std::fs::remove_dir_all(project.path()).expect("remove workspace root");

        assert_eq!(collect(&core, &run).expect("first"), Collection::Rejected);
        assert_eq!(collect(&core, &run).expect("second"), Collection::Missing);
        assert!(!report.exists());
        assert_eq!(
            evidence(&core, &run)
                .iter()
                .filter(|event| matches!(
                    event,
                    EventPayload::OperationArtifactReportRejected { .. }
                ))
                .count(),
            1
        );
    }
}
