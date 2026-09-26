mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use kalcode_contracts::permissions::NormalizedAction;
use kalcode_core::flags::BuildChannel;
use kalcode_core::{Core, CoreConfig, Paths};
use kalcode_doctor::context::{MicrophonePermissionSource, MicrophonePermissionState};
use kalcode_doctor::gate::{FixGate, GateDecision};
use kalcode_doctor::{
    CheckStatus, DOCTOR_MIGRATION, Doctor, DoctorArea, DoctorConfig, FixRequest, HostFacts,
    IgnoreRequest, IgnoreScope, RunRequest,
};

struct DenyGate;

#[derive(Default)]
struct ChangingMicrophonePermission {
    reads: AtomicUsize,
}

impl MicrophonePermissionSource for ChangingMicrophonePermission {
    fn current(&self) -> MicrophonePermissionState {
        if self.reads.fetch_add(1, Ordering::SeqCst) == 0 {
            MicrophonePermissionState::NotDetermined
        } else {
            MicrophonePermissionState::Granted
        }
    }
}

impl FixGate for DenyGate {
    fn request(&self, _: NormalizedAction) -> Result<GateDecision, String> {
        Ok(GateDecision::Denied {
            reason: "test".into(),
        })
    }

    fn confirm(&self, _: &str, _: &NormalizedAction) -> Result<GateDecision, String> {
        Ok(GateDecision::Denied {
            reason: "test".into(),
        })
    }
}

#[test]
fn microphone_permission_is_read_fresh_for_each_doctor_run() {
    let dir = tempfile::tempdir().expect("dir");
    let source = Arc::new(ChangingMicrophonePermission::default());
    let doctor = Doctor::open(DoctorConfig {
        core: common::core(dir.path()),
        host: HostFacts {
            vars: Vec::new(),
            windows: cfg!(windows),
            webview_version: Err("not supplied".into()),
            migrations: kalcode_core::db::MIGRATIONS,
        },
        providers: None,
        git: None,
        microphone_permission: Some(source.clone()),
        gate: Arc::new(DenyGate),
        require_persistent: false,
    })
    .expect("doctor");
    let request = RunRequest {
        areas: vec![DoctorArea::System],
        checks: vec!["system.microphone_permission".into()],
        workspace_id: None,
    };

    let first = doctor.run(request.clone(), None).expect("first run");
    assert_eq!(first.checks.len(), 1);
    assert_eq!(first.checks[0].status, CheckStatus::Finding);
    assert_eq!(
        first.findings[0].code,
        "system.microphone_permission.not_determined"
    );

    let second = doctor.run(request, None).expect("second run");
    assert_eq!(second.checks.len(), 1);
    assert_eq!(second.checks[0].status, CheckStatus::Passed);
    assert_eq!(second.checks[0].summary, "Granted");
    assert_eq!(source.reads.load(Ordering::SeqCst), 2);
}

#[test]
fn missing_tools_are_truthful_and_ignores_apply_to_later_runs() {
    let dir = tempfile::tempdir().expect("dir");
    let core = common::core(dir.path());
    let doctor = Doctor::open(DoctorConfig {
        core,
        host: HostFacts {
            vars: Vec::new(),
            windows: cfg!(windows),
            webview_version: Err("not supplied".into()),
            migrations: kalcode_core::db::MIGRATIONS,
        },
        providers: None,
        git: None,
        microphone_permission: None,
        gate: Arc::new(DenyGate),
        require_persistent: false,
    })
    .expect("doctor");
    let request = RunRequest {
        areas: vec![DoctorArea::DevTools],
        checks: vec!["tools.node".into()],
        workspace_id: None,
    };
    let first = doctor.run(request.clone(), None).expect("run");
    assert_eq!(first.findings.len(), 1);
    assert_eq!(first.findings[0].code, "tools.node.missing");
    let stale_fix = FixRequest {
        run_id: first.id.clone(),
        finding_code: first.findings[0].code.clone(),
        finding_version: first.findings[0].version.clone(),
        fix_code: first.findings[0].fixes[0].fix_code.clone(),
        approval_id: None,
    };
    doctor
        .ignore(IgnoreRequest {
            finding_code: first.findings[0].code.clone(),
            scope: IgnoreScope::Global,
            ignored: true,
        })
        .expect("ignore");
    let second = doctor.run(request, None).expect("rerun");
    assert_eq!(second.counts.ignored, 1);
    assert_eq!(second.findings[0].ignored, Some(IgnoreScope::Global));
    assert_eq!(doctor.last().expect("last").id, second.id);
    let current_fix = FixRequest {
        run_id: second.id.clone(),
        finding_code: second.findings[0].code.clone(),
        finding_version: second.findings[0].version.clone(),
        fix_code: second.findings[0].fixes[0].fix_code.clone(),
        approval_id: None,
    };
    let preview = doctor
        .fix_preview(&current_fix)
        .expect("show-only fixes do not require a workspace");
    assert!(!preview.needs_approval);
    assert!(preview.fix.show_command_only);
    assert!(matches!(
        doctor.fix(&current_fix).expect("show command"),
        kalcode_doctor::FixOutcome::ShowCommand { .. }
    ));
    let offline = doctor
        .run(
            RunRequest {
                areas: vec![DoctorArea::Providers],
                checks: Vec::new(),
                workspace_id: None,
            },
            None,
        )
        .expect("offline provider run");
    assert_eq!(offline.checks.len(), 1);
    assert_eq!(
        offline.checks[0].status,
        kalcode_doctor::CheckStatus::CouldNotCheck
    );
    assert_eq!(
        offline.checks[0].reason.as_deref(),
        Some("The check could not be completed safely.")
    );
    assert_eq!(
        doctor
            .fix_preview(&stale_fix)
            .expect_err("an older run cannot authorize a fix")
            .code,
        "stale_run"
    );
}

#[test]
fn production_mode_refuses_session_only_history() {
    let dir = tempfile::tempdir().expect("dir");
    let doctor_migration = kalcode_core::db::MIGRATIONS
        .iter()
        .position(|migration| migration.version == DOCTOR_MIGRATION.version)
        .expect("Doctor migration is registered");
    let core = Arc::new(
        Core::open_with_migrations(
            CoreConfig {
                paths: Paths::new(dir.path()),
                app_version: "0.0.0-doctor-test".into(),
                channel: BuildChannel::Development,
            },
            &kalcode_core::db::MIGRATIONS[..doctor_migration],
        )
        .expect("open core before the Doctor migration"),
    );
    let error = match Doctor::open(DoctorConfig {
        core,
        host: HostFacts {
            vars: Vec::new(),
            windows: cfg!(windows),
            webview_version: Err("not supplied".into()),
            migrations: kalcode_core::db::MIGRATIONS,
        },
        providers: None,
        git: None,
        microphone_permission: None,
        gate: Arc::new(DenyGate),
        require_persistent: true,
    }) {
        Ok(_) => panic!("schema v16 should be required"),
        Err(error) => error,
    };
    assert_eq!(error.code, "doctor_schema_missing");
}

#[test]
fn abandoned_run_releases_the_single_run_slot() {
    let dir = tempfile::tempdir().expect("dir");
    let doctor = Doctor::open(DoctorConfig {
        core: common::core(dir.path()),
        host: HostFacts {
            vars: Vec::new(),
            windows: cfg!(windows),
            webview_version: Err("not supplied".into()),
            migrations: kalcode_core::db::MIGRATIONS,
        },
        providers: None,
        git: None,
        microphone_permission: None,
        gate: Arc::new(DenyGate),
        require_persistent: false,
    })
    .expect("doctor");
    let request = RunRequest {
        areas: vec![DoctorArea::DevTools],
        checks: vec!["tools.node".into()],
        workspace_id: None,
    };
    let (started, _prepared) = doctor.begin(request.clone(), None).expect("begin");

    doctor
        .abandon_run(&started.id)
        .expect("release a run whose retained worker could not accept it");
    assert!(doctor.last().is_none());

    doctor
        .run(request, None)
        .expect("a later run is admitted after the abandoned job is cleared");
}
