//! Durable handoff regression proof uses only temporary canonical databases.
use std::sync::{Arc, Barrier};

use kalcode_contracts::handoffs::{HandoffStatus, HandoffTask};
use kalcode_core::db::MIGRATIONS;
use kalcode_core::flags::BuildChannel;
use kalcode_core::handoffs::{HandoffStore, NewHandoff};
use kalcode_core::{Core, CoreConfig, KalError, Paths};
use rusqlite::params;

const ID: &str = "30000000-0000-4000-8000-000000000001";

fn config(path: &std::path::Path) -> CoreConfig {
    CoreConfig {
        paths: Paths::new(path),
        app_version: "0.1.9-test".into(),
        channel: BuildChannel::Development,
    }
}

fn create(core: &Core, store: &HandoffStore) -> Result<(), KalError> {
    let hash = "a".repeat(64);
    core.write_with_events(|tx| {
        tx.execute(
            "INSERT INTO context_packages
             (id,workspace_id,purpose,target_thread_id,target_provider_id,status,
              content_sha256,total_bytes,created_at,sent_at)
             VALUES (?1,NULL,'handoff',NULL,NULL,'previewed',?2,10,?3,NULL)",
            params![ID, hash, kalcode_core::time::now_rfc3339()],
        )?;
        Ok(((), vec![]))
    })?;
    store.create(&NewHandoff {
        id: ID,
        context_package_id: ID,
        source_thread_id: "10000000-0000-4000-8000-000000000001",
        target_thread_id: "10000000-0000-4000-8000-000000000002",
        source_workspace_id: "20000000-0000-4000-8000-000000000001",
        target_workspace_id: "20000000-0000-4000-8000-000000000001",
        source_name: "Claude A",
        target_name: "Codex A",
        task: HandoffTask::Review,
        target_instance_id: "exact-process-1",
        preview_hash: &hash,
        source_commit: None,
        source_branch: Some("main"),
        source_dirty: false,
        return_of_id: None,
    })?;
    Ok(())
}

#[test]
fn concurrent_dispatchers_can_claim_exactly_once_and_failure_rolls_back() {
    let dir = tempfile::tempdir().unwrap();
    let core = Arc::new(Core::open(config(dir.path())).unwrap());
    let store = HandoffStore::new(core.clone());
    create(&core, &store).expect("queued handoff fixture");
    assert!(
        store
            .claim_delivery(ID, |_| Err(KalError::validation("test-denied", "Denied")))
            .is_err()
    );
    let barrier = Arc::new(Barrier::new(3));
    let workers: Vec<_> = (0..2)
        .map(|_| {
            let store = store.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                store.claim_delivery(ID, |_| Ok(())).is_ok()
            })
        })
        .collect();
    barrier.wait();
    let accepted: usize = workers
        .into_iter()
        .map(|worker| usize::from(worker.join().expect("claim worker")))
        .sum();
    assert_eq!(
        accepted, 1,
        "only one dispatcher may obtain the durable claim"
    );
    assert!(store.claim_delivery(ID, |_| Ok(())).is_err());
}

#[test]
fn restart_interrupts_claimed_work_without_replaying_or_erasing_it() {
    let dir = tempfile::tempdir().unwrap();
    {
        let core = Arc::new(Core::open(config(dir.path())).unwrap());
        let store = HandoffStore::new(core.clone());
        create(&core, &store).expect("queued handoff fixture");
        store.claim_delivery(ID, |_| Ok(())).unwrap();
        core.shutdown();
    }
    let core = Arc::new(Core::open(config(dir.path())).unwrap());
    let store = HandoffStore::new(core.clone());
    assert_eq!(store.recover_interrupted().unwrap(), 1);
    assert_eq!(store.recover_interrupted().unwrap(), 0);
    let row = store.get(ID).unwrap();
    assert_eq!(row.status, HandoffStatus::Interrupted);
    assert_eq!(row.target_name, "Codex A");
    assert!(store.claim_delivery(ID, |_| Ok(())).is_err());
    let states: (String, String) = core.read(|connection| {
        Ok(connection.query_row(
            "SELECT h.delivery_state,c.status FROM handoffs h JOIN context_packages c ON c.id=h.context_package_id WHERE h.id=?1",
            [ID], |row| Ok((row.get(0)?, row.get(1)?)),
        )?)
    }).unwrap();
    assert_eq!(states, ("uncertain".into(), "blocked".into()));
}

#[test]
fn delivered_work_requires_an_explicit_result_and_cannot_be_cancelled_as_queued() {
    let dir = tempfile::tempdir().unwrap();
    let core = Arc::new(Core::open(config(dir.path())).unwrap());
    let store = HandoffStore::new(core.clone());
    create(&core, &store).expect("queued handoff fixture");
    assert!(
        store
            .complete(ID, HandoffStatus::Completed, "Premature")
            .is_err()
    );
    store.claim_delivery(ID, |_| Ok(())).unwrap();
    store.finish_delivery(ID, |_| Ok(())).unwrap();
    assert!(store.cancel(ID).is_err());
    assert_eq!(store.get(ID).unwrap().status, HandoffStatus::Delivered);
    assert!(store.complete(ID, HandoffStatus::Completed, " ").is_err());
    let row = store
        .complete(ID, HandoffStatus::Completed, "Reviewed: no findings.")
        .unwrap();
    assert_eq!(row.result.as_deref(), Some("Reviewed: no findings."));
    assert!(
        store
            .complete(ID, HandoffStatus::Failed, "Late overwrite")
            .is_err()
    );
}

#[test]
fn handoff_migration_preserves_existing_state_and_allows_canonical_retention() {
    let dir = tempfile::tempdir().unwrap();
    {
        let core = Core::open_with_migrations(config(dir.path()), &MIGRATIONS[..21]).unwrap();
        core.write_with_events(|tx| {
            tx.execute("INSERT INTO workspaces(id,name,root_path,created_at,last_opened_at) VALUES('existing','Existing project','fixture/project','t','t')", [])?;
            Ok(((), vec![]))
        }).unwrap();
        core.shutdown();
    }
    let core = Arc::new(Core::open(config(dir.path())).unwrap());
    let store = HandoffStore::new(core.clone());
    let name: String = core
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT name FROM workspaces WHERE id='existing'",
                [],
                |row| row.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(name, "Existing project");
    create(&core, &store).expect("queued handoff fixture");
    store.cancel(ID).unwrap();
    core.write_with_events(|tx| {
        tx.execute("DELETE FROM context_packages WHERE id=?1", [ID])?;
        Ok(((), vec![]))
    })
    .expect("canonical retention can remove context and its dependent handoff");
    assert!(store.list(None).unwrap().is_empty());
}
