use std::sync::{Arc, Mutex};

use kalcode_contracts::ids::new_id;
use kalcode_contracts::permissions::NormalizedAction;
use kalcode_doctor::fixes::{FixExecutor, GITIGNORE_ENV};
use kalcode_doctor::gate::{FixGate, GateDecision};
use kalcode_doctor::store::{NewFixLog, Store};
use kalcode_doctor::{
    DoctorArea, DoctorFinding, FindingSeverity, FixOption, FixOutcome, FixRequest, FixStatus,
    ProjectFacts, Reversibility, RevertRequest,
};

#[derive(Default)]
struct Gate {
    requested: Mutex<Vec<NormalizedAction>>,
    approved: Mutex<Option<(String, NormalizedAction)>>,
}

impl FixGate for Gate {
    fn request(&self, action: NormalizedAction) -> Result<GateDecision, String> {
        self.requested
            .lock()
            .map_err(|_| "test requested-actions lock poisoned".to_owned())?
            .push(action);
        Ok(GateDecision::Asked {
            approval_id: new_id(),
        })
    }

    fn confirm(
        &self,
        approval_id: &str,
        action: &NormalizedAction,
    ) -> Result<GateDecision, String> {
        match self
            .approved
            .lock()
            .map_err(|_| "test approvals lock poisoned".to_owned())?
            .as_ref()
        {
            Some((id, expected)) if id == approval_id && expected == action => {
                Ok(GateDecision::Allowed)
            }
            _ => Ok(GateDecision::Denied {
                reason: "Approval doesn't match this exact fix.".into(),
            }),
        }
    }
}

fn finding(workspace_id: &str) -> DoctorFinding {
    DoctorFinding {
        code: "project.env.not_ignored".into(),
        version: new_id(),
        check_id: "project.env_files".into(),
        area: DoctorArea::Project,
        severity: FindingSeverity::Warning,
        title: "Environment file is not ignored".into(),
        explanation: "test".into(),
        details: Vec::new(),
        subjects: vec![".env".into()],
        fixes: vec![FixOption {
            fix_code: GITIGNORE_ENV.into(),
            label: "Add to .gitignore".into(),
            description: "Add /.env".into(),
            scopes: vec![],
            reversible: Reversibility::Reversible {
                how: "Remove the exact line".into(),
            },
            show_command_only: false,
            command: None,
            command_shell: None,
        }],
        ignored: None,
        workspace_id: Some(workspace_id.into()),
    }
}

#[test]
fn mutable_fix_requires_exact_approval_and_rechecks_file_version() {
    let dir = tempfile::tempdir().expect("dir");
    std::fs::create_dir(dir.path().join(".git")).expect("git dir");
    let workspace_id = new_id();
    let project = ProjectFacts {
        workspace_id: workspace_id.clone(),
        name: "safe".into(),
        root: dir.path().to_path_buf(),
    };
    let finding = finding(&workspace_id);
    let request = FixRequest {
        run_id: new_id(),
        finding_code: finding.code.clone(),
        finding_version: finding.version.clone(),
        fix_code: GITIGNORE_ENV.into(),
        approval_id: None,
    };
    let gate = Arc::new(Gate::default());
    let executor = FixExecutor::new(Arc::new(Store::memory().expect("store")), gate.clone());
    let first = executor
        .apply(&request, &finding, Some(&project))
        .expect("ask");
    let approval_id = match first {
        FixOutcome::AwaitingApproval { approval_id } => approval_id,
        other => panic!("{other:?}"),
    };
    let action = gate.requested.lock().unwrap()[0].clone();
    *gate.approved.lock().unwrap() = Some((approval_id.clone(), action));
    std::fs::write(dir.path().join(".gitignore"), b"# changed after approval\n").expect("change");
    let mut resume = request.clone();
    resume.approval_id = Some(approval_id);
    let error = executor
        .apply(&resume, &finding, Some(&project))
        .expect_err("stale");
    assert_eq!(error.code, "stale_target");
    assert_eq!(
        std::fs::read_to_string(dir.path().join(".gitignore")).unwrap(),
        "# changed after approval\n"
    );
}

#[test]
fn applied_fix_is_reversible_and_cannot_be_replayed() {
    let dir = tempfile::tempdir().expect("dir");
    std::fs::create_dir(dir.path().join(".git")).expect("git dir");
    std::fs::write(dir.path().join(".gitignore"), b"target/\n").expect("seed");
    let workspace_id = new_id();
    let project = ProjectFacts {
        workspace_id: workspace_id.clone(),
        name: "safe".into(),
        root: dir.path().to_path_buf(),
    };
    let finding = finding(&workspace_id);
    let mut request = FixRequest {
        run_id: new_id(),
        finding_code: finding.code.clone(),
        finding_version: finding.version.clone(),
        fix_code: GITIGNORE_ENV.into(),
        approval_id: None,
    };
    let gate = Arc::new(Gate::default());
    let store = Arc::new(Store::memory().expect("store"));
    let executor = FixExecutor::new(store, gate.clone());
    let asked = executor
        .apply(&request, &finding, Some(&project))
        .expect("ask");
    let approval_id = match asked {
        FixOutcome::AwaitingApproval { approval_id } => approval_id,
        _ => panic!("ask"),
    };
    *gate.approved.lock().unwrap() = Some((
        approval_id.clone(),
        gate.requested.lock().unwrap()[0].clone(),
    ));
    request.approval_id = Some(approval_id);
    let done = executor
        .apply(&request, &finding, Some(&project))
        .expect("apply");
    let log_id = match done {
        FixOutcome::Done { fix_log_id, .. } => fix_log_id,
        _ => panic!("done"),
    };
    assert_eq!(
        std::fs::read_to_string(dir.path().join(".gitignore")).unwrap(),
        "target/\n/.env\n"
    );
    assert_eq!(
        executor
            .apply(&request, &finding, Some(&project))
            .expect_err("replay")
            .code,
        "fix_replayed"
    );
    let mut revert = RevertRequest {
        fix_log_id: log_id,
        approval_id: None,
    };
    let asked = executor.revert(&revert, &project).expect("ask undo");
    let approval_id = match asked {
        FixOutcome::AwaitingApproval { approval_id } => approval_id,
        _ => panic!("ask"),
    };
    *gate.approved.lock().unwrap() = Some((
        approval_id.clone(),
        gate.requested.lock().unwrap().last().unwrap().clone(),
    ));
    revert.approval_id = Some(approval_id);
    executor.revert(&revert, &project).expect("revert");
    assert_eq!(
        std::fs::read_to_string(dir.path().join(".gitignore")).unwrap(),
        "target/\n"
    );
}

#[test]
fn restart_reconciles_interrupted_apply_and_undo_without_rewriting_the_target() {
    let dir = tempfile::tempdir().expect("dir");
    std::fs::create_dir(dir.path().join(".git")).expect("git dir");
    let before = b"target/\n".to_vec();
    let after = b"target/\n/.env\n".to_vec();
    std::fs::write(dir.path().join(".gitignore"), &after).expect("completed write");
    let workspace_id = new_id();
    let project = ProjectFacts {
        workspace_id: workspace_id.clone(),
        name: "safe".into(),
        root: dir.path().to_path_buf(),
    };
    let database = dir.path().join("doctor.sqlite3");
    let run_id = new_id();
    let finding_version = new_id();
    let log_id = {
        let store = Store::standalone(&database).expect("store");
        store
            .reserve_fix(&NewFixLog {
                run_id,
                finding_code: "project.env.not_ignored".into(),
                finding_version,
                fix_code: GITIGNORE_ENV.into(),
                workspace_id: Some(workspace_id.clone()),
                summary: "Add environment files to .gitignore".into(),
                target_ref: "workspace:.gitignore".into(),
                approval_id: Some(new_id()),
                undo_json: serde_json::json!({
                    "relativePath": ".gitignore",
                    "before": before,
                    "after": after,
                })
                .to_string(),
            })
            .expect("reserve")
    };

    let store = Arc::new(Store::standalone(&database).expect("reopen apply"));
    let executor = FixExecutor::new(store.clone(), Arc::new(Gate::default()));
    assert_eq!(executor.reconcile(&project).expect("reconcile apply"), 1);
    assert_eq!(
        store
            .fix(&log_id)
            .expect("read")
            .expect("entry")
            .view
            .status,
        FixStatus::Applied
    );

    store
        .begin_revert(&log_id, Some(&new_id()))
        .expect("begin interrupted undo");
    drop(executor);
    drop(store);
    let store = Arc::new(Store::standalone(&database).expect("reopen undo"));
    let executor = FixExecutor::new(store.clone(), Arc::new(Gate::default()));
    assert_eq!(executor.reconcile(&project).expect("reconcile undo"), 1);
    let retryable = store.fix(&log_id).expect("read").expect("entry");
    assert_eq!(retryable.view.status, FixStatus::Applied);
    assert_eq!(
        retryable.view.error.as_deref(),
        Some("undo_interrupted_retryable")
    );
    assert!(retryable.view.can_undo);

    store
        .begin_revert(&log_id, Some(&new_id()))
        .expect("begin completed undo");
    std::fs::write(dir.path().join(".gitignore"), b"target/\n").expect("completed undo");
    drop(executor);
    drop(store);
    let store = Arc::new(Store::standalone(&database).expect("reopen completed undo"));
    let executor = FixExecutor::new(store.clone(), Arc::new(Gate::default()));
    assert_eq!(
        executor
            .reconcile(&project)
            .expect("reconcile completed undo"),
        1
    );
    assert_eq!(
        store
            .fix(&log_id)
            .expect("read")
            .expect("entry")
            .view
            .status,
        FixStatus::Reverted
    );
    assert_eq!(
        std::fs::read(dir.path().join(".gitignore")).expect("read target"),
        b"target/\n"
    );
}
