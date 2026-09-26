#![allow(clippy::expect_used)]

use kalcode_core::db;
use kalcode_utilities::UTILITY_AUTHORITY_MIGRATION;
use rusqlite::{Connection, params};

const APPROVAL: &str = "018f8d7c-a1b2-7c3d-8e4f-1234567890ab";
const OTHER_APPROVAL: &str = "018f8d7c-a1b2-7c3d-8e4f-1234567890ac";
const OPERATION: &str = "018f8d7c-b1b2-7c3d-8e4f-1234567890ab";
const OTHER_OPERATION: &str = "018f8d7c-b1b2-7c3d-8e4f-1234567890ac";
const CLAIMED_AT: &str = "2026-09-25T18:30:00.000Z";

fn database() -> Connection {
    let mut conn = db::open_in_memory().expect("memory database");
    db::migrate(&mut conn, db::MIGRATIONS, None).expect("canonical migrations");
    let installed: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'utility_approval_claims'",
            [],
            |row| row.get(0),
        )
        .expect("schema query");
    assert_eq!(installed, 1, "canonical migration chain installs v17");
    assert_eq!(
        UTILITY_AUTHORITY_MIGRATION.sql,
        include_str!("../../native-core/migrations/0017_utility_authority.sql")
    );
    conn
}

fn approval(conn: &Connection, id: &str) {
    conn.execute(
        "INSERT INTO approvals (
           id, origin_kind, origin_id, action_id, request, decision, allowed_decisions,
           fingerprint, grant_coverage, permission_mode, status, resolved_decision,
           resolved_at, resolved_by, created_at
         ) VALUES (
           ?1, 'utility', 'api_inspector', ?2, '{}',
           '{\"effect\":\"ask\",\"scopes\":[\"network.other\"],\"reason\":\"review\",\"approvable\":true}',
           '[\"deny\",\"approve_once\"]', 'exact', 'only this request', 'approve',
           'approved', 'approve_once', ?3, 'user', ?3
         )",
        params![id, OPERATION, CLAIMED_AT],
    )
    .expect("approval fixture");
}

fn claim(
    conn: &Connection,
    approval_id: &str,
    operation_id: &str,
    tool: &str,
    effect: &str,
    claimed_at: &str,
) -> rusqlite::Result<usize> {
    conn.execute(
        "INSERT INTO utility_approval_claims (
           approval_id, operation_id, runtime_generation, workspace_id,
           tool, effect_kind, claimed_at
         ) VALUES (?1, ?2, 7, NULL, ?3, ?4, ?5)",
        params![approval_id, operation_id, tool, effect, claimed_at],
    )
}

#[test]
fn claim_tombstones_cannot_be_replaced_by_either_identity() {
    let conn = database();
    approval(&conn, APPROVAL);
    approval(&conn, OTHER_APPROVAL);
    claim(
        &conn,
        APPROVAL,
        OPERATION,
        "api_inspector",
        "http",
        CLAIMED_AT,
    )
    .expect("first claim");

    let replace_approval = conn.execute(
        "INSERT OR REPLACE INTO utility_approval_claims
         (approval_id, operation_id, runtime_generation, tool, effect_kind, claimed_at)
         VALUES (?1, ?2, 8, 'api_inspector', 'http', ?3)",
        params![APPROVAL, OTHER_OPERATION, CLAIMED_AT],
    );
    assert!(replace_approval.is_err(), "approval tombstone is immutable");
    let replace_operation = conn.execute(
        "INSERT OR REPLACE INTO utility_approval_claims
         (approval_id, operation_id, runtime_generation, tool, effect_kind, claimed_at)
         VALUES (?1, ?2, 8, 'api_inspector', 'http', ?3)",
        params![OTHER_APPROVAL, OPERATION, CLAIMED_AT],
    );
    assert!(
        replace_operation.is_err(),
        "operation tombstone is immutable"
    );

    let retained: (String, i64) = conn
        .query_row(
            "SELECT operation_id, runtime_generation FROM utility_approval_claims WHERE approval_id = ?1",
            [APPROVAL],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("retained claim");
    assert_eq!(retained, (OPERATION.to_owned(), 7));
}

#[test]
fn claims_reject_mismatched_catalog_pairs_and_malformed_authority() {
    let conn = database();
    approval(&conn, APPROVAL);

    for (tool, effect) in [
        ("api_inspector", "process_signal"),
        ("processes", "sqlite_write"),
        ("sqlite", "http"),
    ] {
        assert!(
            claim(&conn, APPROVAL, OPERATION, tool, effect, CLAIMED_AT).is_err(),
            "{tool}/{effect}"
        );
    }
    assert!(
        claim(
            &conn,
            APPROVAL,
            OPERATION,
            "api_inspector",
            "http",
            "2026-09-25 18:30:00"
        )
        .is_err(),
        "claimed_at must be exact UTC milliseconds"
    );
    assert!(
        claim(
            &conn,
            APPROVAL,
            "not-a-canonical-uuid",
            "api_inspector",
            "http",
            CLAIMED_AT
        )
        .is_err(),
        "operation id must be a canonical UUID"
    );
    for malformed in [
        "------------------------------------",
        "018f8d7c-a1b2-7c3d-8e4f-123456789-ab",
    ] {
        assert!(
            claim(
                &conn,
                APPROVAL,
                malformed,
                "api_inspector",
                "http",
                CLAIMED_AT
            )
            .is_err(),
            "extra/all hyphens are not UUIDs: {malformed}"
        );
    }
}
