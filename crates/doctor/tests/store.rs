use kalcode_contracts::ids::new_id;
use kalcode_doctor::store::{NewFixLog, Store};
use kalcode_doctor::{DoctorRun, FindingCounts, FixStatus, IgnoreScope, RunStatus};

#[test]
fn ignores_use_workspace_precedence_and_are_reversible() {
    let store = Store::memory().expect("store");
    let workspace = new_id();
    store
        .set_ignore(
            "tools.node.missing",
            &IgnoreScope::Global,
            "Node missing",
            true,
        )
        .expect("ignore global");
    store
        .set_ignore(
            "tools.node.missing",
            &IgnoreScope::Workspace {
                workspace_id: workspace.clone(),
            },
            "Node missing here",
            true,
        )
        .expect("ignore workspace");
    assert_eq!(
        store
            .ignored_scope("tools.node.missing", Some(&workspace))
            .expect("read"),
        Some(IgnoreScope::Workspace {
            workspace_id: workspace.clone()
        })
    );
    store
        .set_ignore(
            "tools.node.missing",
            &IgnoreScope::Workspace {
                workspace_id: workspace.clone(),
            },
            "",
            false,
        )
        .expect("unignore workspace");
    assert_eq!(
        store
            .ignored_scope("tools.node.missing", Some(&workspace))
            .expect("read"),
        Some(IgnoreScope::Global)
    );
}

#[test]
fn approval_and_finding_versions_are_single_use() {
    let store = Store::memory().expect("store");
    let approval = new_id();
    let log = NewFixLog {
        run_id: new_id(),
        finding_code: "project.env.not_ignored".into(),
        finding_version: new_id(),
        fix_code: "file.gitignore_env".into(),
        workspace_id: Some(new_id()),
        summary: "Add environment files to .gitignore".into(),
        target_ref: "workspace:.gitignore".into(),
        approval_id: Some(approval.clone()),
        undo_json: "{\"before\":[],\"after\":[]}".into(),
    };
    let id = store.reserve_fix(&log).expect("reserve");
    store.mark_applied(&id).expect("applied");
    assert_eq!(
        store.fix(&id).expect("read").expect("entry").view.status,
        FixStatus::Applied
    );
    assert_eq!(
        store.reserve_fix(&log).expect_err("approval replay").code,
        "fix_replayed"
    );
    let mut swapped = log.clone();
    swapped.finding_version = new_id();
    assert_eq!(
        store.reserve_fix(&swapped).expect_err("object swap").code,
        "fix_replayed"
    );

    let revert_approval = new_id();
    store
        .begin_revert(&id, Some(&revert_approval))
        .expect("claim undo approval");
    store
        .restore_applied_after_interrupted_revert(&id)
        .expect("make undo retryable");
    assert_eq!(
        store
            .begin_revert(&id, Some(&revert_approval))
            .expect_err("undo approval replay")
            .code,
        "fix_replayed"
    );
}

#[test]
fn schema_survives_a_real_sqlite_restart() {
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("doctor.sqlite3");
    {
        let store = Store::standalone(&path).expect("first open");
        store
            .set_ignore(
                "tools.git.missing",
                &IgnoreScope::Global,
                "Git missing",
                true,
            )
            .expect("ignore");
        store
            .save_run(&DoctorRun {
                id: new_id(),
                status: RunStatus::Completed,
                started_at: "2026-09-25T00:00:00Z".into(),
                finished_at: Some("2026-09-25T00:00:01Z".into()),
                areas: Vec::new(),
                workspace_id: None,
                workspace_name: None,
                timeout_ms: 15_000,
                checks: Vec::new(),
                findings: Vec::new(),
                counts: FindingCounts::default(),
                persistent: true,
            })
            .expect("save run");
    }
    let reopened = Store::standalone(&path).expect("reopen");
    assert_eq!(
        reopened
            .ignored_scope("tools.git.missing", None)
            .expect("read"),
        Some(IgnoreScope::Global)
    );
    assert!(reopened.persistent());
    assert_eq!(
        reopened
            .latest_run()
            .expect("history")
            .expect("latest")
            .status,
        RunStatus::Completed
    );
}
