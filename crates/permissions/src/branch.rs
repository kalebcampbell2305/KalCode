//! **Z4 branch only — delete at integration.**
//!
//! Migrations 0002–0004 belong to Z1–Z3 and are not on this branch, and the migration runner
//! requires a gap-free sequence. To exercise 0005 in tests and in isolated development runs
//! (`KALCODE_DATA_DIR`, never the owner's data), this module fills 0002–0004 with no-op
//! placeholders.
//!
//! Integration plan (see `docs/campaigns/Z4.md`):
//! 1. Merge Z1–Z3 first so `kalcode_core::db::MIGRATIONS` holds 0001–0004.
//! 2. Append `kalcode_core::db::PERMISSIONS_MIGRATION` to `MIGRATIONS`.
//! 3. Delete this module and switch the desktop shell back to `Core::open`.
//!
//! The tripwire test below fails as soon as `MIGRATIONS` grows past 0001, so the placeholders
//! can't silently reach `main`.

use kalcode_core::db::{MIGRATIONS, Migration, PERMISSIONS_MIGRATION};

const PLACEHOLDER_SQL: &str =
    "-- Z4 branch placeholder for a migration owned by another campaign.\nSELECT 1;";

/// 0001, placeholder 0002–0004, then 0005.
pub fn migrations_with_placeholders() -> Vec<Migration> {
    let mut all: Vec<Migration> = MIGRATIONS.to_vec();
    for (version, name) in [(2, "reserved_z1"), (3, "reserved_z2"), (4, "reserved_z3")] {
        if all.iter().all(|m| m.version != version) {
            all.push(Migration {
                version,
                name,
                sql: PLACEHOLDER_SQL,
            });
        }
    }
    all.push(PERMISSIONS_MIGRATION);
    all
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholders_must_not_outlive_the_real_migrations() {
        assert_eq!(
            MIGRATIONS.len(),
            1,
            "Migrations 0002+ are on this branch now: register PERMISSIONS_MIGRATION in \
             kalcode_core::db::MIGRATIONS, delete crates/permissions/src/branch.rs and use Core::open \
             in the desktop shell (docs/campaigns/Z4.md)."
        );
    }

    #[test]
    fn sequence_is_gap_free_and_ends_with_0005() {
        let all = migrations_with_placeholders();
        let versions: Vec<i64> = all.iter().map(|m| m.version).collect();
        assert_eq!(versions, vec![1, 2, 3, 4, 5]);
    }
}
