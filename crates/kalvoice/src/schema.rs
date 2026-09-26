//! KalVoice's tables: schema migration v6 (`crates/native-core/migrations/0006_kalvoice.sql`)
//! and durable request lifecycle migration v13.
//!
//! The migration is registered in `kalcode_core::db::MIGRATIONS` after the event platform's v5
//! (like every migration: embedded, numbered, checksummed, backed up before it runs). KalVoice
//! owns the tables; other code reads them through this crate's API.

use kalcode_core::Result;
use rusqlite::Connection;

/// The schema version that adds KalVoice's tables.
pub const KALVOICE_SCHEMA_VERSION: i64 = 6;

/// The schema version that makes each request claim recoverably stateful.
pub const KALVOICE_REQUEST_LIFECYCLE_SCHEMA_VERSION: i64 = 13;

/// Whether this database has KalVoice's tables.
pub fn installed(conn: &Connection) -> Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'
           AND name IN ('kalvoice_requests', 'kalvoice_preferences')",
        [],
        |r| r.get(0),
    )?;
    Ok(count == 2)
}

#[cfg(test)]
mod tests {
    use kalcode_core::db::MIGRATIONS;

    use super::*;

    #[test]
    fn migration_is_registered_as_v6_after_the_event_platform() {
        let versions: Vec<i64> = MIGRATIONS.iter().map(|m| m.version).collect();
        assert_eq!(versions[..6], [1, 2, 3, 4, 5, 6]);
        let v5 = MIGRATIONS[4];
        assert_eq!((v5.version, v5.name), (5, "event_correlation"));
        let v6 = MIGRATIONS[5];
        assert_eq!((v6.version, v6.name), (KALVOICE_SCHEMA_VERSION, "kalvoice"));
        assert!(v6.sql.contains("CREATE TABLE kalvoice_requests"));
        assert!(v6.sql.contains("CREATE TABLE kalvoice_preferences"));

        let lifecycle = MIGRATIONS
            .iter()
            .find(|migration| migration.version == KALVOICE_REQUEST_LIFECYCLE_SCHEMA_VERSION)
            .expect("KalVoice request lifecycle migration");
        assert_eq!(lifecycle.name, "kalvoice_request_lifecycle");
        assert!(lifecycle.sql.contains("execution_state"));
    }
}
