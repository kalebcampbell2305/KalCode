use super::*;
use kalcode_context::store::{self, DeliveryState};

fn config(path: &std::path::Path) -> CoreConfig {
    CoreConfig {
        paths: Paths::new(path),
        app_version: "0.0.0-startup-test".into(),
        channel: BuildChannel::Development,
    }
}

#[test]
fn startup_reconciles_interrupted_context_before_runtime_publication() {
    let directory = tempfile::tempdir().expect("temporary app data");
    let package = "018f6f65-6c6a-7f32-a21b-22600a5d8a01";
    let claimed = "2026-09-25T12:00:00.000Z";
    {
        let core = Core::open(config(directory.path())).expect("first startup");
        core.write_with_events(|transaction| {
            transaction.execute(
                "INSERT INTO context_packages
                 (id, purpose, status, content_sha256, total_bytes, created_at)
                 VALUES (?1, 'drop', 'previewed', ?2, 1, ?3)",
                (package, "0".repeat(64), claimed),
            )?;
            store::claim_delivery(transaction, package, None, claimed).map_err(KalError::from)?;
            Ok(((), Vec::new()))
        })
        .expect("persist in-flight attempt");
        core.shutdown();
    }
    for expected_recovery_count in [1, 0] {
        let core = Arc::new(Core::open(config(directory.path())).expect("reopen"));
        let (recovered, _) = reconcile_core_startup(&core).expect("startup reconciliation");
        assert_eq!(recovered, expected_recovery_count);
        // This assertion precedes the same AppState publication performed by start().
        core.read(|connection| {
            assert_eq!(
                store::delivery_state(connection, package).map_err(KalError::from)?,
                Some(DeliveryState::FailedUncertain)
            );
            assert_eq!(
                store::package_status(connection, package)
                    .map_err(KalError::from)?
                    .as_deref(),
                Some("blocked")
            );
            assert!(store::claim_delivery(connection, package, None, claimed).is_err());
            Ok(())
        })
        .expect("durable recovery evidence");
        core.shutdown();
    }
}

#[test]
fn startup_refuses_missing_delivery_authority() {
    let directory = tempfile::tempdir().expect("temporary app data");
    let before_delivery = kalcode_core::db::MIGRATIONS
        .iter()
        .position(|migration| migration.version == 18)
        .expect("registered delivery migration");
    let core = Arc::new(
        Core::open_with_migrations(
            config(directory.path()),
            &kalcode_core::db::MIGRATIONS[..before_delivery],
        )
        .expect("older store"),
    );
    assert!(reconcile_core_startup(&core).is_err());
    core.shutdown();
}
