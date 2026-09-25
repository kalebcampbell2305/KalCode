//! KalVoice's tables: schema migration v6 (`migrations/0006_kalvoice.sql`).
//!
//! [`KALVOICE_MIGRATION`] is deliberately **not** registered in `kalcode_core::db::MIGRATIONS`
//! on this branch: v5 belongs to the event-platform upgrade, which lands first, and the lead
//! appends v6 after it at integration. Until then a database without KalVoice's tables simply
//! has no KalVoice ([`installed`] says so and the app explains it).
//!
//! Tests, and end-to-end runs against their own temporary data folder, use
//! [`migrations_with_kalvoice`], which fills the reserved gap with an empty stand-in. That
//! stand-in must never reach a real data folder: the real v5 would then fail its checksum.

use kalcode_core::Result;
use kalcode_core::db::{MIGRATIONS, Migration};
use rusqlite::Connection;

/// Migration v6 (campaign Z12). No foreign keys to another campaign's tables.
pub const KALVOICE_MIGRATION: Migration = Migration {
    version: 6,
    name: "kalvoice",
    sql: include_str!("../migrations/0006_kalvoice.sql"),
};

/// The core's migrations plus KalVoice's, with an empty stand-in for any reserved version in
/// between that isn't registered yet. Tests and isolated end-to-end data folders only.
pub fn migrations_with_kalvoice() -> Vec<Migration> {
    let mut all = MIGRATIONS.to_vec();
    if all.iter().any(|m| m.version == KALVOICE_MIGRATION.version) {
        return all;
    }
    let next = all.last().map_or(1, |m| m.version + 1);
    for version in next..KALVOICE_MIGRATION.version {
        all.push(Migration {
            version,
            name: "reserved",
            sql: "SELECT 1;",
        });
    }
    all.push(KALVOICE_MIGRATION);
    all
}

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
    use super::*;

    #[test]
    fn migration_is_isolated_and_numbered_six() {
        assert_eq!(KALVOICE_MIGRATION.version, 6);
        assert!(
            MIGRATIONS.iter().all(|m| m.version != 6),
            "v6 is registered by the lead at integration, after v5"
        );
        let all = migrations_with_kalvoice();
        let versions: Vec<i64> = all.iter().map(|m| m.version).collect();
        assert_eq!(versions, (1..=6).collect::<Vec<_>>());
    }
}
