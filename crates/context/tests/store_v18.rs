//! Durable one-shot Context Drop delivery lifecycle (schema v18).

#![allow(clippy::expect_used, clippy::unwrap_used)]

use kalcode_context::store::{
    DeliveryState, MIGRATION_V8, MIGRATION_V18, PackageStatus, claim_delivery, delivery_state,
    finish_delivery, finish_package, package_status, recover_sending_deliveries,
};
use kalcode_core::db::MIGRATIONS;
use rusqlite::{Connection, params};

const CLAIMED: &str = "2026-09-25T12:00:00.000Z";
const FINISHED: &str = "2026-09-25T12:00:01.000Z";
const CLAIMED_LATER: &str = "2026-09-25T12:00:02.000Z";
const PACKAGE_1: &str = "018f6f65-6c6a-7f32-a21b-22600a5d8a01";
const PACKAGE_2: &str = "018f6f65-6c6a-7f32-a21b-22600a5d8a02";
const ACCOUNT_1: &str = "018f6f65-6c6a-7f32-a21b-22600a5d8b01";
const ACCOUNT_2: &str = "018f6f65-6c6a-7f32-a21b-22600a5d8b02";

fn connection(with_v18: bool) -> Connection {
    let conn = Connection::open_in_memory().expect("database");
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .expect("foreign keys");
    conn.execute_batch(MIGRATION_V8.sql).expect("v8");
    if with_v18 {
        conn.execute_batch(MIGRATION_V18.sql).expect("v18");
    }
    conn
}

fn preview(conn: &Connection, id: &str) {
    conn.execute(
        "INSERT INTO context_packages
          (id, purpose, status, content_sha256, total_bytes, created_at)
         VALUES (?1, 'drop', 'previewed', ?2, 1, ?3)",
        params![id, "0".repeat(64), CLAIMED],
    )
    .expect("preview");
}

#[test]
fn delivery_migration_has_one_typed_registered_authority() {
    assert_eq!(MIGRATION_V18.version, 18);
    assert_eq!(MIGRATION_V18.name, "context_delivery");
    let registered = MIGRATIONS
        .iter()
        .find(|migration| migration.version == 18)
        .expect("registered schema v18");
    assert_eq!(registered.name, MIGRATION_V18.name);
    assert_eq!(registered.sql, MIGRATION_V18.sql);
    assert_eq!(
        MIGRATIONS
            .iter()
            .filter(|migration| migration.version == 18)
            .count(),
        1,
        "schema v18 has one canonical registry entry"
    );
}

#[test]
fn claim_and_finish_are_one_shot_and_identity_is_immutable() {
    let conn = connection(true);
    preview(&conn, PACKAGE_1);

    claim_delivery(&conn, PACKAGE_1, Some(ACCOUNT_1), CLAIMED).expect("claim");
    assert_eq!(
        delivery_state(&conn, PACKAGE_1).expect("state"),
        Some(DeliveryState::Sending)
    );
    assert!(
        claim_delivery(&conn, PACKAGE_1, Some(ACCOUNT_1), CLAIMED).is_err(),
        "duplicate claim is denied"
    );
    assert!(
        conn.execute(
            "INSERT OR REPLACE INTO context_delivery_attempts
              (package_id, state, target_account_id, claimed_at, finished_at)
             VALUES (?1, 'sending', ?2, ?3, NULL)",
            params![PACKAGE_1, ACCOUNT_2, CLAIMED],
        )
        .is_err(),
        "replacement cannot reset authority"
    );
    assert!(
        conn.execute(
            "UPDATE context_delivery_attempts SET target_account_id = ?2
              WHERE package_id = ?1",
            params![PACKAGE_1, ACCOUNT_2],
        )
        .is_err(),
        "target identity is immutable"
    );
    assert!(
        conn.execute(
            "DELETE FROM context_delivery_attempts WHERE package_id = ?1",
            params![PACKAGE_1],
        )
        .is_err(),
        "delivery evidence is append-only"
    );
    assert!(
        conn.execute(
            "UPDATE context_packages SET content_sha256 = ?2 WHERE id = ?1",
            params![PACKAGE_1, "1".repeat(64)],
        )
        .is_err(),
        "a claim pins the exact preview hash"
    );
    assert!(
        conn.execute(
            "UPDATE context_packages SET status = 'discarded' WHERE id = ?1",
            params![PACKAGE_1],
        )
        .is_err(),
        "a claimed package cannot be relabelled"
    );

    finish_delivery(&conn, PACKAGE_1, DeliveryState::Sent, FINISHED).expect("finish");
    finish_package(&conn, PACKAGE_1, PackageStatus::Sent, FINISHED).expect("finish package");
    assert_eq!(
        delivery_state(&conn, PACKAGE_1).expect("state"),
        Some(DeliveryState::Sent)
    );
    assert_eq!(
        package_status(&conn, PACKAGE_1).unwrap().as_deref(),
        Some("sent")
    );
    assert!(
        finish_delivery(&conn, PACKAGE_1, DeliveryState::FailedUncertain, FINISHED,).is_err(),
        "final state cannot change"
    );
}

#[test]
fn restart_marks_sending_uncertain_without_replay() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("context-recovery.db");
    {
        let conn = Connection::open(&path).expect("database");
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .expect("foreign keys");
        conn.execute_batch(MIGRATION_V8.sql).expect("v8");
        conn.execute_batch(MIGRATION_V18.sql).expect("v18");
        preview(&conn, PACKAGE_1);
        preview(&conn, PACKAGE_2);
        claim_delivery(&conn, PACKAGE_1, None, CLAIMED).expect("claim one");
        claim_delivery(&conn, PACKAGE_2, Some(ACCOUNT_2), CLAIMED_LATER).expect("claim two");
    }

    let conn = Connection::open(&path).expect("reopen after interrupted send");
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .expect("foreign keys");
    assert_eq!(recover_sending_deliveries(&conn, FINISHED).unwrap(), 2);
    for package in [PACKAGE_1, PACKAGE_2] {
        assert_eq!(
            delivery_state(&conn, package).unwrap(),
            Some(DeliveryState::FailedUncertain)
        );
        assert_eq!(
            package_status(&conn, package).unwrap().as_deref(),
            Some("blocked"),
            "an interrupted package is durably closed"
        );
    }
    let finish_times: Vec<(String, String)> = {
        let mut statement = conn
            .prepare(
                "SELECT package_id, finished_at
                   FROM context_delivery_attempts
                  ORDER BY package_id",
            )
            .expect("prepare finish times");
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("query finish times")
            .collect::<rusqlite::Result<_>>()
            .expect("finish times")
    };
    assert_eq!(
        finish_times,
        vec![
            (PACKAGE_1.to_owned(), FINISHED.to_owned()),
            (PACKAGE_2.to_owned(), CLAIMED_LATER.to_owned()),
        ],
        "recovery clamps each finish time to its claim when the wall clock moves backward"
    );
    assert_eq!(recover_sending_deliveries(&conn, FINISHED).unwrap(), 0);
    assert!(
        claim_delivery(&conn, PACKAGE_1, None, FINISHED).is_err(),
        "recovery evidence cannot be replayed as a second delivery"
    );
}

#[test]
fn missing_schema_and_invalid_initial_state_fail_closed() {
    let conn = connection(false);
    preview(&conn, PACKAGE_1);
    assert!(claim_delivery(&conn, PACKAGE_1, None, CLAIMED).is_err());
    assert!(
        recover_sending_deliveries(&conn, FINISHED).is_err(),
        "startup recovery must fail closed when schema v18 is absent"
    );

    conn.execute_batch(MIGRATION_V18.sql).expect("v18");
    assert!(
        conn.execute(
            "INSERT INTO context_delivery_attempts
              (package_id, state, target_account_id, claimed_at, finished_at)
             VALUES (?1, 'sent', NULL, ?2, ?3)",
            params![PACKAGE_1, CLAIMED, FINISHED],
        )
        .is_err()
    );
    assert!(
        conn.execute(
            "INSERT INTO context_delivery_attempts
              (package_id, state, target_account_id, claimed_at, finished_at)
             VALUES (?1, 'sending', NULL, 'invalid', NULL)",
            params![PACKAGE_1],
        )
        .is_err()
    );
    assert!(
        conn.execute(
            "INSERT INTO context_delivery_attempts
              (package_id, state, target_account_id, claimed_at, finished_at)
             VALUES (?1, 'sending', 'not-an-account-id', ?2, NULL)",
            params![PACKAGE_1, CLAIMED],
        )
        .is_err()
    );
    assert!(
        conn.execute(
            "INSERT INTO context_delivery_attempts
              (package_id, state, target_account_id, claimed_at, finished_at)
             VALUES (?1, 'sending', NULL, '2026-99-99T99:99:99.999Z', NULL)",
            params![PACKAGE_1],
        )
        .is_err()
    );

    claim_delivery(&conn, PACKAGE_1, None, CLAIMED).expect("valid claim");
    assert!(
        recover_sending_deliveries(&conn, "").is_err(),
        "malformed recovery time cannot be disguised as a backward clock"
    );
    assert_eq!(
        delivery_state(&conn, PACKAGE_1).unwrap(),
        Some(DeliveryState::Sending),
        "invalid recovery leaves the one-shot claim unchanged"
    );
    assert_eq!(
        package_status(&conn, PACKAGE_1).unwrap().as_deref(),
        Some("previewed")
    );
    assert!(
        finish_delivery(
            &conn,
            PACKAGE_1,
            DeliveryState::Sent,
            "2026-09-25T11:59:59.999Z",
        )
        .is_err(),
        "completion cannot predate the claim"
    );
}
