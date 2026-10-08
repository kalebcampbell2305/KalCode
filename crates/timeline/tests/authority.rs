#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::path::Path;
use std::sync::{Arc, Barrier};

use kalcode_contracts::ids::new_id;
use kalcode_core::flags::BuildChannel;
use kalcode_core::{Core, CoreConfig, Paths};
use kalcode_timeline::{
    EffectsState, EvidenceOutcome, MIGRATION_V15_SQL, NewReplayRun, NewRestoreOperation,
    OperationEvidence, OperationStage, ReplayPlanSummary, ReplayStatus, RestoreKind,
    RestorePlanSummary, RestoreStatus, SCHEMA_VERSION, StartOutcome, TimelineStore,
};
use rusqlite::params;

const FUTURE: &str = "2099-01-01T00:00:00.000Z";
const DIGEST: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_DIGEST: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

struct Harness {
    core: Arc<Core>,
    store: TimelineStore,
    workspace_id: String,
    checkpoint_id: String,
    safety_checkpoint_id: String,
    // Last: fields drop in declaration order, so Core closes kalcode.lock and the db first.
    // Dropped earlier, the TempDir silently survives on Windows.
    _temp: tempfile::TempDir,
}

fn config(path: &Path) -> CoreConfig {
    CoreConfig {
        paths: Paths::new(path),
        app_version: "0.1.5-timeline-test".into(),
        channel: BuildChannel::Development,
    }
}

fn add_checkpoint(core: &Arc<Core>, workspace_id: &str, checkpoint_id: &str) {
    core.write_with_events(|tx| {
        tx.execute(
            "INSERT INTO checkpoints
               (id, workspace_id, commit_oid, parent_id, trigger, event_seq, files,
                bytes_added, pinned, created_at, pruned_at)
             VALUES (?1, ?2, ?3, NULL, '{\"kind\":\"user\"}', 0, 0, 0, 0,
                     '2026-09-25T00:00:00.000Z', NULL)",
            params![checkpoint_id, workspace_id, "1".repeat(40)],
        )?;
        Ok(((), Vec::new()))
    })
    .expect("checkpoint");
}

fn harness() -> Harness {
    let temp = tempfile::tempdir().expect("temp");
    let core = Arc::new(Core::open(config(temp.path())).expect("core"));
    let workspace_id = new_id();
    let checkpoint_id = new_id();
    let safety_checkpoint_id = new_id();
    add_checkpoint(&core, &workspace_id, &checkpoint_id);
    add_checkpoint(&core, &workspace_id, &safety_checkpoint_id);
    let store = TimelineStore::open(Arc::clone(&core)).expect("store");
    Harness {
        _temp: temp,
        core,
        store,
        workspace_id,
        checkpoint_id,
        safety_checkpoint_id,
    }
}

#[test]
fn crate_owned_sql_matches_the_canonical_native_core_migration() {
    assert_eq!(
        MIGRATION_V15_SQL.as_bytes(),
        include_bytes!("../migrations/0015_time_machine.sql")
    );
}

fn restore_plan(h: &Harness, kind: RestoreKind) -> NewRestoreOperation {
    NewRestoreOperation {
        id: new_id(),
        workspace_id: h.workspace_id.clone(),
        checkpoint_id: h.checkpoint_id.clone(),
        kind,
        plan_fingerprint: OTHER_DIGEST.into(),
        plan_summary: RestorePlanSummary {
            schema_version: SCHEMA_VERSION,
            changes_total: 3,
            overwrite: 1,
            create: 1,
            delete: 1,
            keep: 0,
            reset_branch: kind == RestoreKind::ResetBranch,
        },
        approval_binding_digest: DIGEST.into(),
        expires_at: FUTURE.into(),
    }
}

fn replay_plan(h: &Harness, steps: u32) -> NewReplayRun {
    NewReplayRun {
        id: new_id(),
        workspace_id: h.workspace_id.clone(),
        checkpoint_id: h.checkpoint_id.clone(),
        from_seq: 10,
        to_seq: 20,
        steps_total: steps,
        plan_fingerprint: OTHER_DIGEST.into(),
        plan_summary: ReplayPlanSummary {
            schema_version: SCHEMA_VERSION,
            steps_total: steps,
            replayable: steps,
            not_replayable: 0,
        },
        approval_binding_digest: DIGEST.into(),
        expires_at: FUTURE.into(),
    }
}

fn evidence(outcome: EvidenceOutcome, affected_items: u32) -> OperationEvidence {
    OperationEvidence {
        schema_version: SCHEMA_VERSION,
        outcome,
        stage: OperationStage::Verification,
        effects: match outcome {
            EvidenceOutcome::Completed => EffectsState::Complete,
            EvidenceOutcome::Cancelled | EvidenceOutcome::Stopped => EffectsState::None,
            EvidenceOutcome::Failed | EvidenceOutcome::RestartInterrupted => EffectsState::Unknown,
        },
        affected_items,
        result_ref: None,
        retained_checkpoint_id: None,
    }
}

#[test]
fn restore_requires_bound_safety_and_retains_terminal_failure_evidence() {
    let h = harness();
    let plan = restore_plan(&h, RestoreKind::Files);
    let planned = h.store.plan_restore(&plan).expect("plan");
    assert_eq!(planned.status, RestoreStatus::Planned);

    let no_safety = h.store.start_restore(&plan.id, DIGEST, None).unwrap_err();
    assert_eq!(no_safety.code, "safety_checkpoint_required");
    let wrong_binding = h
        .store
        .start_restore(&plan.id, OTHER_DIGEST, Some(&h.safety_checkpoint_id))
        .unwrap_err();
    assert_eq!(wrong_binding.code, "operation_not_runnable");

    let StartOutcome::Started(running) = h
        .store
        .start_restore(&plan.id, DIGEST, Some(&h.safety_checkpoint_id))
        .expect("start")
    else {
        panic!("future plan expired")
    };
    assert_eq!(running.status, RestoreStatus::Running);
    assert_eq!(
        running.safety_checkpoint_id.as_deref(),
        Some(h.safety_checkpoint_id.as_str())
    );

    let failed_evidence = evidence(EvidenceOutcome::Failed, 1);
    let failed = h
        .store
        .fail_restore(
            &plan.id,
            DIGEST,
            "restore_verification_failed",
            true,
            &failed_evidence,
        )
        .expect("fail");
    assert_eq!(failed.status, RestoreStatus::Failed);
    assert!(failed.recovery_required);
    assert_eq!(failed.evidence.as_ref(), Some(&failed_evidence));

    let retry = h
        .store
        .start_restore(&plan.id, DIGEST, Some(&h.safety_checkpoint_id));
    assert_eq!(retry.unwrap_err().code, "operation_not_runnable");
    let overwrite =
        h.store
            .complete_restore(&plan.id, DIGEST, &evidence(EvidenceOutcome::Completed, 3));
    assert_eq!(overwrite.unwrap_err().code, "operation_not_runnable");
    assert_eq!(
        h.store.restore(&plan.id).unwrap().evidence,
        Some(failed_evidence)
    );
}

#[test]
fn replay_progress_is_cas_monotonic_and_completion_requires_every_step() {
    let h = harness();
    let plan = replay_plan(&h, 3);
    h.store.plan_replay(&plan).expect("plan");
    let StartOutcome::Started(_) = h
        .store
        .start_replay(&plan.id, DIGEST, &h.safety_checkpoint_id)
        .expect("start")
    else {
        panic!("future plan expired")
    };

    assert_eq!(
        h.store
            .advance_replay(&plan.id, DIGEST, 0, 1)
            .unwrap()
            .steps_done,
        1
    );
    assert_eq!(
        h.store
            .advance_replay(&plan.id, DIGEST, 0, 2)
            .unwrap_err()
            .code,
        "operation_not_runnable"
    );
    assert_eq!(
        h.store
            .complete_replay(&plan.id, DIGEST, &evidence(EvidenceOutcome::Completed, 1))
            .unwrap_err()
            .code,
        "operation_not_runnable"
    );
    h.store
        .advance_replay(&plan.id, DIGEST, 1, 3)
        .expect("advance");
    let completed = h
        .store
        .complete_replay(&plan.id, DIGEST, &evidence(EvidenceOutcome::Completed, 3))
        .expect("complete");
    assert_eq!(completed.status, ReplayStatus::Completed);
    assert_eq!(completed.steps_done, 3);
}

#[test]
fn planned_destructive_work_can_fail_or_cancel_before_a_safety_checkpoint_exists() {
    let h = harness();
    let failed_plan = restore_plan(&h, RestoreKind::Files);
    h.store.plan_restore(&failed_plan).unwrap();
    let failed = h
        .store
        .fail_restore(
            &failed_plan.id,
            DIGEST,
            "preflight_failed",
            false,
            &evidence(EvidenceOutcome::Failed, 0),
        )
        .unwrap();
    assert_eq!(failed.status, RestoreStatus::Failed);
    assert!(failed.started_at.is_none());
    assert!(failed.safety_checkpoint_id.is_none());
    assert!(!failed.recovery_required);

    let cancelled_plan = restore_plan(&h, RestoreKind::Files);
    h.store.plan_restore(&cancelled_plan).unwrap();
    let cancelled = h
        .store
        .cancel_restore(
            &cancelled_plan.id,
            DIGEST,
            &evidence(EvidenceOutcome::Cancelled, 0),
        )
        .unwrap();
    assert_eq!(cancelled.status, RestoreStatus::Cancelled);
    assert!(cancelled.started_at.is_none());
    assert!(cancelled.safety_checkpoint_id.is_none());
}

#[test]
fn a_concurrent_claim_has_exactly_one_winner() {
    let h = harness();
    let plan = restore_plan(&h, RestoreKind::Files);
    h.store.plan_restore(&plan).expect("plan");
    let barrier = Arc::new(Barrier::new(3));
    let mut workers = Vec::new();
    for _ in 0..2 {
        let store = h.store.clone();
        let barrier = Arc::clone(&barrier);
        let id = plan.id.clone();
        let safety = h.safety_checkpoint_id.clone();
        workers.push(std::thread::spawn(move || {
            barrier.wait();
            store.start_restore(&id, DIGEST, Some(&safety)).is_ok()
        }));
    }
    barrier.wait();
    let winners = workers
        .into_iter()
        .map(|worker| worker.join().expect("worker"))
        .filter(|won| *won)
        .count();
    assert_eq!(winners, 1);
    assert_eq!(
        h.store.restore(&plan.id).unwrap().status,
        RestoreStatus::Running
    );
}

#[test]
fn restart_marks_running_work_failed_and_never_advances_replay() {
    let temp = tempfile::tempdir().expect("temp");
    let workspace_id = new_id();
    let checkpoint_id = new_id();
    let safety_checkpoint_id = new_id();
    let restore_id;
    let replay_id;
    {
        let core = Arc::new(Core::open(config(temp.path())).expect("core"));
        add_checkpoint(&core, &workspace_id, &checkpoint_id);
        add_checkpoint(&core, &workspace_id, &safety_checkpoint_id);
        let store = TimelineStore::open(Arc::clone(&core)).unwrap();
        let synthetic = Harness {
            _temp: tempfile::tempdir().unwrap(),
            core: Arc::clone(&core),
            store: store.clone(),
            workspace_id: workspace_id.clone(),
            checkpoint_id: checkpoint_id.clone(),
            safety_checkpoint_id: safety_checkpoint_id.clone(),
        };
        let restore = restore_plan(&synthetic, RestoreKind::Files);
        restore_id = restore.id.clone();
        store.plan_restore(&restore).unwrap();
        store
            .start_restore(&restore.id, DIGEST, Some(&safety_checkpoint_id))
            .unwrap();
        let replay = replay_plan(&synthetic, 4);
        replay_id = replay.id.clone();
        store.plan_replay(&replay).unwrap();
        store
            .start_replay(&replay.id, DIGEST, &safety_checkpoint_id)
            .unwrap();
        store.advance_replay(&replay.id, DIGEST, 0, 2).unwrap();
    }

    let core = Arc::new(Core::open(config(temp.path())).expect("reopen core"));
    let store = TimelineStore::open(core).expect("reopen store");
    let report = store.recover_interrupted().expect("recover");
    assert_eq!(report.restore_operations, 1);
    assert_eq!(report.replay_runs, 1);
    let restore = store.restore(&restore_id).unwrap();
    assert_eq!(restore.status, RestoreStatus::Failed);
    assert!(restore.recovery_required);
    assert_eq!(restore.error_code.as_deref(), Some("interrupted_restart"));
    assert_eq!(
        restore.evidence.unwrap().outcome,
        EvidenceOutcome::RestartInterrupted
    );
    let replay = store.replay(&replay_id).unwrap();
    assert_eq!(replay.status, ReplayStatus::Failed);
    assert!(replay.recovery_required);
    assert_eq!(
        replay.steps_done, 2,
        "restart must never replay or advance a step"
    );
    assert_eq!(store.recover_interrupted().unwrap().replay_runs, 0);
}

#[test]
fn sql_guards_reject_replace_delete_mutation_terminal_insert_and_foreign_safety() {
    let h = harness();
    let plan = restore_plan(&h, RestoreKind::Files);
    h.store.plan_restore(&plan).unwrap();

    let checks = h
        .core
        .write_with_events(|tx| {
            let mutate = tx
                .execute(
                    "UPDATE restore_operations SET plan_fingerprint = ?2 WHERE id = ?1",
                    params![plan.id, DIGEST],
                )
                .is_err();
            let replace = tx
                .execute(
                    "INSERT OR REPLACE INTO restore_operations
                     SELECT * FROM restore_operations WHERE id = ?1",
                    [&plan.id],
                )
                .is_err();
            let delete = tx.execute("DELETE FROM restore_operations WHERE id = ?1", [&plan.id]).is_err();
            let terminal_insert = tx
                .execute(
                    "INSERT INTO restore_operations
                       (id, schema_version, workspace_id, checkpoint_id, kind, plan_fingerprint,
                        plan_summary, approval_binding_digest, expires_at, safety_checkpoint_id,
                        status, recovery_required, planned_at, started_at, finished_at, evidence, error_code)
                     SELECT ?2, schema_version, workspace_id, checkpoint_id, kind, plan_fingerprint,
                            plan_summary, approval_binding_digest, expires_at, NULL,
                            'completed', 0, planned_at, planned_at, planned_at,
                            '{\"schemaVersion\":1,\"outcome\":\"completed\",\"stage\":\"verification\",\"effects\":\"complete\",\"affectedItems\":0}', NULL
                     FROM restore_operations WHERE id = ?1",
                    params![plan.id, new_id()],
                )
                .is_err();
            let foreign_safety = tx
                .execute(
                    "UPDATE restore_operations
                     SET status = 'running', safety_checkpoint_id = ?2,
                         started_at = '2026-09-25T01:00:00.000Z'
                     WHERE id = ?1",
                    params![plan.id, new_id()],
                )
                .is_err();
            Ok(((mutate, replace, delete, terminal_insert, foreign_safety), Vec::new()))
        })
        .unwrap()
        .0;
    assert_eq!(checks, (true, true, true, true, true));
    assert_eq!(
        h.store.restore(&plan.id).unwrap().status,
        RestoreStatus::Planned
    );
}

#[test]
fn sql_guards_reject_duplicate_or_missing_closed_json_fields() {
    let h = harness();
    let plan = restore_plan(&h, RestoreKind::Files);
    h.store.plan_restore(&plan).unwrap();
    let duplicate_and_missing = r#"{"schemaVersion":1,"schemaVersion":1,"changesTotal":0,"overwrite":0,"create":0,"delete":0,"keep":0}"#;
    let invalid_plan = h
        .core
        .write_with_events(|tx| {
            let rejected = tx
                .execute(
                    "INSERT INTO restore_operations
                       (id, schema_version, workspace_id, checkpoint_id, kind, plan_fingerprint,
                        plan_summary, approval_binding_digest, expires_at, safety_checkpoint_id,
                        status, recovery_required, planned_at, started_at, finished_at, evidence, error_code)
                     SELECT ?2, 1, workspace_id, checkpoint_id, kind, plan_fingerprint,
                            ?3, approval_binding_digest, expires_at, NULL,
                            'planned', 0, planned_at, NULL, NULL, NULL, NULL
                     FROM restore_operations WHERE id = ?1",
                    params![plan.id, new_id(), duplicate_and_missing],
                )
                .is_err();
            Ok((rejected, Vec::new()))
        })
        .unwrap()
        .0;
    assert!(invalid_plan);

    let missing_outcome_duplicate_stage = r#"{"schemaVersion":1,"stage":"execution","stage":"verification","effects":"unknown","affectedItems":0}"#;
    let invalid_evidence = h
        .core
        .write_with_events(|tx| {
            let rejected = tx
                .execute(
                    "UPDATE restore_operations
                     SET status = 'failed', finished_at = '2026-09-25T01:00:00.000Z',
                         evidence = ?2, error_code = 'forced_failure'
                     WHERE id = ?1",
                    params![plan.id, missing_outcome_duplicate_stage],
                )
                .is_err();
            Ok((rejected, Vec::new()))
        })
        .unwrap()
        .0;
    assert!(invalid_evidence);
    assert_eq!(
        h.store.restore(&plan.id).unwrap().status,
        RestoreStatus::Planned
    );
}

#[test]
fn sql_guards_freeze_start_time_require_failure_codes_and_revalidate_target_at_start() {
    let h = harness();
    let running_plan = restore_plan(&h, RestoreKind::Files);
    h.store.plan_restore(&running_plan).unwrap();
    h.store
        .start_restore(&running_plan.id, DIGEST, Some(&h.safety_checkpoint_id))
        .unwrap();
    let start_time_rewrite = h
        .core
        .write_with_events(|tx| {
            let rejected = tx
                .execute(
                    "UPDATE restore_operations
                     SET started_at = '2098-01-01T00:00:00.000Z' WHERE id = ?1",
                    [&running_plan.id],
                )
                .is_err();
            Ok((rejected, Vec::new()))
        })
        .unwrap()
        .0;
    assert!(start_time_rewrite);

    let failed_plan = restore_plan(&h, RestoreKind::Files);
    h.store.plan_restore(&failed_plan).unwrap();
    let no_error_code = h
        .core
        .write_with_events(|tx| {
            let rejected = tx
                .execute(
                    "UPDATE restore_operations
                     SET status = 'failed', finished_at = '2098-01-01T00:00:00.000Z',
                         evidence = '{\"schemaVersion\":1,\"outcome\":\"failed\",\"stage\":\"planned\",\"effects\":\"none\",\"affectedItems\":0}'
                     WHERE id = ?1",
                    [&failed_plan.id],
                )
                .is_err();
            Ok((rejected, Vec::new()))
        })
        .unwrap()
        .0;
    assert!(no_error_code);

    let pruned_plan = restore_plan(&h, RestoreKind::Files);
    h.store.plan_restore(&pruned_plan).unwrap();
    let pruned_target_start = h
        .core
        .write_with_events(|tx| {
            tx.execute(
                "UPDATE checkpoints SET pruned_at = '2026-09-25T22:00:00.000Z'
                 WHERE id = ?1",
                [&h.checkpoint_id],
            )?;
            let rejected = tx
                .execute(
                    "UPDATE restore_operations
                     SET status = 'running', safety_checkpoint_id = ?2,
                         started_at = '2098-01-01T00:00:00.000Z'
                     WHERE id = ?1",
                    params![pruned_plan.id, h.safety_checkpoint_id],
                )
                .is_err();
            Ok((rejected, Vec::new()))
        })
        .unwrap()
        .0;
    assert!(pruned_target_start);
}

#[test]
fn expired_and_invalid_plans_never_start() {
    let h = harness();
    let mut past = restore_plan(&h, RestoreKind::Files);
    past.expires_at = "2020-01-01T00:00:00.000Z".into();
    assert_eq!(
        h.store.plan_restore(&past).unwrap_err().code,
        "plan_expiry_invalid"
    );

    let plan = restore_plan(&h, RestoreKind::Files);
    h.store.plan_restore(&plan).unwrap();
    let direct_expired_start = h
        .core
        .write_with_events(|tx| {
            let rejected = tx
                .execute(
                    "UPDATE restore_operations
                     SET status = 'running', safety_checkpoint_id = ?2, started_at = expires_at
                     WHERE id = ?1",
                    params![plan.id, h.safety_checkpoint_id],
                )
                .is_err();
            Ok((rejected, Vec::new()))
        })
        .unwrap()
        .0;
    assert!(direct_expired_start);

    let persisted_expired_id = new_id();
    h.core
        .write_with_events(|tx| {
            tx.execute(
                "INSERT INTO restore_operations
                   (id, schema_version, workspace_id, checkpoint_id, kind, plan_fingerprint,
                    plan_summary, approval_binding_digest, expires_at, safety_checkpoint_id,
                    status, recovery_required, planned_at, started_at, finished_at, evidence, error_code)
                 SELECT ?2, schema_version, workspace_id, checkpoint_id, kind, plan_fingerprint,
                        plan_summary, approval_binding_digest, '2026-01-02T00:00:00.000Z', NULL,
                        'planned', 0, '2026-01-01T00:00:00.000Z', NULL, NULL, NULL, NULL
                 FROM restore_operations WHERE id = ?1",
                params![plan.id, persisted_expired_id],
            )?;
            Ok(((), Vec::new()))
        })
        .unwrap();
    let StartOutcome::Expired(expired) = h
        .store
        .start_restore(&persisted_expired_id, DIGEST, Some(&h.safety_checkpoint_id))
        .expect("classify expiry")
    else {
        panic!("expired persisted plan started")
    };
    assert_eq!(expired.status, RestoreStatus::Cancelled);
    assert_eq!(expired.error_code.as_deref(), Some("plan_expired"));
    assert!(expired.started_at.is_none());
}
