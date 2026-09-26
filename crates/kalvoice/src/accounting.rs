//! Native account metering seam and durable offline outbox. Execution idempotency remains in
//! the existing request ledger; account-derived keys keep old/unrelated account claims apart.
use kalcode_contracts::kalvoice::KalVoiceUsage;
use kalcode_core::{KalError, Result};
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};

pub trait RequestAccounting: Send + Sync {
    /// Identity captured from verified native account authority, never renderer input.
    fn account_id(&self) -> &str;
    fn usage(&self) -> Result<KalVoiceUsage>;
    /// Called once, after durable execution ownership, before an executor effect.
    fn authorize(&self, request_id: &str) -> Result<MeterDecision>;
}

#[derive(Debug)]
pub struct MeterDecision {
    pub allowed: bool,
    pub usage: KalVoiceUsage,
}

pub fn execution_id(account_id: &str, request_id: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"kalcode/account-kalvoice-execution/v1\0");
    hash.update((account_id.len() as u64).to_be_bytes());
    hash.update(account_id.as_bytes());
    hash.update(request_id.as_bytes());
    let digest = hash.finalize();
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    uuid::Uuid::from_bytes(bytes).to_string()
}

/// The caller supplies a verified receipt's cycle/count, or an account-only provisional cycle.
/// When a receipt exists only unacknowledged reservations are added; otherwise count every
/// non-denied local admission, including claims which have already synchronized.
pub fn usage(
    conn: &Connection,
    account: &str,
    base: &KalVoiceUsage,
    start: i64,
    end: i64,
    receipt: bool,
) -> Result<KalVoiceUsage> {
    let count: u32 = conn.query_row(
        "SELECT COUNT(*) FROM kalvoice_account_usage WHERE account_id=?1 AND recorded_at>=?2 AND recorded_at<?3 AND status!='denied' AND (?4=0 OR status IN ('pending','unconfirmed'))",
        params![account, start, end, receipt], |row| row.get(0))?;
    let mut value = base.clone();
    value.used = value.used.saturating_add(count);
    Ok(value)
}

/// Must run in the same write transaction as the allowance decision. Reusing an outbox id
/// cannot be treated as new execution authority (even following process loss).
pub fn reserve(
    conn: &Connection,
    account: &str,
    request: &str,
    now: i64,
    offline: bool,
) -> Result<()> {
    let changed = conn.execute("INSERT OR IGNORE INTO kalvoice_account_usage(account_id,request_id,recorded_at,status) VALUES(?1,?2,?3,?4)",
        params![account, request, now, if offline { "pending" } else { "unconfirmed" }])?;
    if changed != 1 {
        return Err(KalError::validation(
            "kalvoice_meter_claim_exists",
            "This KalVoice Request already has a usage claim.",
        ));
    }
    Ok(())
}

pub fn settle(conn: &Connection, account: &str, request: &str, allowed: bool) -> Result<()> {
    conn.execute("UPDATE kalvoice_account_usage SET status=?3 WHERE account_id=?1 AND request_id=?2 AND status IN ('pending','unconfirmed')",
        params![account, request, if allowed { "synced" } else { "denied" }])?;
    Ok(())
}

pub fn admit_offline(conn: &Connection, account: &str, request: &str) -> Result<()> {
    conn.execute("UPDATE kalvoice_account_usage SET status='pending' WHERE account_id=?1 AND request_id=?2 AND status='unconfirmed'", params![account,request])?;
    Ok(())
}

pub fn next_pending(conn: &Connection, account: &str) -> Result<Option<(String, bool)>> {
    Ok(conn.query_row("SELECT request_id,status='pending' FROM kalvoice_account_usage WHERE account_id=?1 AND status IN ('pending','unconfirmed') ORDER BY recorded_at,request_id LIMIT 1",
        [account], |row| Ok((row.get(0)?, row.get(1)?))).optional()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection {
        let conn = Connection::open_in_memory().expect("sqlite");
        conn.execute_batch(include_str!(
            "../../native-core/migrations/0019_kalvoice_account_usage.sql"
        ))
        .expect("migration");
        conn
    }
    fn base() -> KalVoiceUsage {
        KalVoiceUsage {
            used: 74,
            allowance: Some(75),
            period_start: "2026-09-20T12:34:56.000Z".into(),
            resets_at: "2026-10-20T12:34:56.000Z".into(),
        }
    }
    #[test]
    fn exact_cycle_and_account_isolation_survive_replay() {
        let conn = db();
        let id = kalcode_contracts::ids::new_id();
        reserve(&conn, "a", &id, 110, true).expect("reserve");
        assert!(
            usage(&conn, "a", &base(), 100, 200, true)
                .expect("usage")
                .exhausted()
        );
        assert_eq!(
            usage(&conn, "b", &base(), 100, 200, true)
                .expect("other account")
                .used,
            74
        );
        assert_eq!(
            usage(&conn, "a", &base(), 200, 300, true)
                .expect("next cycle")
                .used,
            74
        );
        assert!(reserve(&conn, "a", &id, 110, true).is_err());
        assert_eq!(
            next_pending(&conn, "a").expect("pending"),
            Some((id.clone(), true))
        );
        settle(&conn, "a", &id, true).expect("ack");
        settle(&conn, "a", &id, true).expect("idempotent ack");
        assert!(next_pending(&conn, "a").expect("empty").is_none());
        assert_eq!(
            usage(&conn, "a", &base(), 100, 200, true)
                .expect("receipt")
                .used,
            74
        );
        assert_eq!(
            usage(&conn, "a", &base(), 100, 200, false)
                .expect("provisional")
                .used,
            75
        );
    }
    #[test]
    fn unknown_online_outcome_remains_online_until_offline_execution_admitted() {
        let conn = db();
        let id = kalcode_contracts::ids::new_id();
        reserve(&conn, "a", &id, 110, false).expect("reserve");
        assert_eq!(
            next_pending(&conn, "a").expect("pending"),
            Some((id.clone(), false))
        );
        admit_offline(&conn, "a", &id).expect("offline");
        assert_eq!(
            next_pending(&conn, "a").expect("pending"),
            Some((id.clone(), true))
        );
        settle(&conn, "a", &id, false).expect("denied");
        assert_eq!(
            usage(&conn, "a", &base(), 100, 200, false)
                .expect("usage")
                .used,
            74
        );
    }
    #[test]
    fn scoped_execution_key_is_stable_valid_and_does_not_adopt_legacy_rows() {
        let id = kalcode_contracts::ids::new_id();
        let key = execution_id("a", &id);
        assert!(kalcode_contracts::ids::is_valid_id(&key));
        assert_eq!(key, execution_id("a", &id));
        assert_ne!(key, id);
        assert_ne!(key, execution_id("b", &id));
    }
}
