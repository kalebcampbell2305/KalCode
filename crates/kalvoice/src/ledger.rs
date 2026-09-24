//! Provisional local KalVoice Request ledger (docs/KALVOICE.md, "KalVoice Requests").
//!
//! One row per top-level request, keyed by the client request id, so retrying a request never
//! counts it twice. Dictation is never recorded. Rows hold ids and facts only. The monthly
//! period runs from the cycle anchor day (the 1st until accounts provide a plan cycle) at
//! 00:00 UTC to the same day next month. The server ledger becomes authoritative once accounts
//! exist; this count is what the app shows until then, and while briefly offline.

use kalcode_contracts::ids::is_valid_id;
use kalcode_contracts::kalvoice::{KalVoiceInput, KalVoiceUsage};
use kalcode_core::time::format_rfc3339;
use kalcode_core::{KalError, Result};
use rusqlite::{Connection, OptionalExtension, params};
use time::{Date, Month, OffsetDateTime, PrimitiveDateTime, Time};

/// The day of the month a provisional cycle starts on. Accounts will supply the real anchor.
pub const DEFAULT_CYCLE_ANCHOR_DAY: u8 = 1;

/// A monthly usage period in UTC.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Period {
    pub start: OffsetDateTime,
    pub resets_at: OffsetDateTime,
}

impl Period {
    /// The period containing `now` for a cycle anchored on `anchor_day` (1–31; short months
    /// use their last day).
    pub fn containing(now: OffsetDateTime, anchor_day: u8) -> Self {
        let now = now.to_offset(time::UtcOffset::UTC);
        let this_month = anchor_in(now.year(), now.month(), anchor_day);
        let start = if now >= this_month {
            this_month
        } else {
            let (y, m) = previous_month(now.year(), now.month());
            anchor_in(y, m, anchor_day)
        };
        let (ny, nm) = next_month(start.year(), start.month());
        Self {
            start,
            resets_at: anchor_in(ny, nm, anchor_day),
        }
    }

    pub fn start_rfc3339(&self) -> String {
        format_rfc3339(self.start)
    }

    pub fn resets_at_rfc3339(&self) -> String {
        format_rfc3339(self.resets_at)
    }
}

fn anchor_in(year: i32, month: Month, anchor_day: u8) -> OffsetDateTime {
    let last = month.length(year);
    let day = anchor_day.clamp(1, last);
    // `day` is within the month, so this cannot fail; fall back to the 1st defensively.
    let date = Date::from_calendar_date(year, month, day)
        .or_else(|_| Date::from_calendar_date(year, month, 1))
        .unwrap_or(Date::MIN);
    PrimitiveDateTime::new(date, Time::MIDNIGHT).assume_utc()
}

fn previous_month(year: i32, month: Month) -> (i32, Month) {
    match month {
        Month::January => (year - 1, Month::December),
        m => (year, m.previous()),
    }
}

fn next_month(year: i32, month: Month) -> (i32, Month) {
    match month {
        Month::December => (year + 1, Month::January),
        m => (year, m.next()),
    }
}

/// Result of trying to count a request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Consumption {
    /// Newly counted.
    Recorded(KalVoiceUsage),
    /// This client request id was already counted (a retry); not counted again.
    AlreadyRecorded(KalVoiceUsage),
    /// The allowance is used up; nothing was recorded.
    LimitReached(KalVoiceUsage),
}

impl Consumption {
    pub fn usage(&self) -> &KalVoiceUsage {
        match self {
            Self::Recorded(u) | Self::AlreadyRecorded(u) | Self::LimitReached(u) => u,
        }
    }
}

/// Usage in the period containing `now`. `allowance` is `None` for unlimited (OWNER).
pub fn usage(
    conn: &Connection,
    now: OffsetDateTime,
    anchor_day: u8,
    allowance: Option<u32>,
) -> Result<KalVoiceUsage> {
    let period = Period::containing(now, anchor_day);
    let used: i64 = conn.query_row(
        "SELECT COUNT(*) FROM kalvoice_requests WHERE period_start = ?1",
        [period.start_rfc3339()],
        |r| r.get(0),
    )?;
    Ok(KalVoiceUsage {
        used: u32::try_from(used).unwrap_or(u32::MAX),
        allowance,
        period_start: period.start_rfc3339(),
        resets_at: period.resets_at_rfc3339(),
    })
}

/// Whether this client request id has already been counted.
pub fn is_recorded(conn: &Connection, request_id: &str) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM kalvoice_requests WHERE request_id = ?1",
            [request_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// Counts one top-level request, atomically with the allowance check. Call inside the
/// transaction that records the request's events.
pub fn consume(
    conn: &Connection,
    request_id: &str,
    input: KalVoiceInput,
    intent_kind: &str,
    now: OffsetDateTime,
    anchor_day: u8,
    allowance: Option<u32>,
) -> Result<Consumption> {
    if !is_valid_id(request_id) {
        return Err(KalError::validation(
            "invalid_request_id",
            "KalVoice received an invalid request id.",
        ));
    }
    let existing: Option<String> = conn
        .query_row(
            "SELECT period_start FROM kalvoice_requests WHERE request_id = ?1",
            [request_id],
            |r| r.get(0),
        )
        .optional()?;
    let current = usage(conn, now, anchor_day, allowance)?;
    if existing.is_some() {
        return Ok(Consumption::AlreadyRecorded(current));
    }
    if current.exhausted() {
        return Ok(Consumption::LimitReached(current));
    }
    conn.execute(
        "INSERT INTO kalvoice_requests (request_id, period_start, recorded_at, input, intent)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            request_id,
            current.period_start,
            format_rfc3339(now),
            match input {
                KalVoiceInput::Voice => "voice",
                KalVoiceInput::Text => "text",
            },
            intent_kind,
        ],
    )?;
    Ok(Consumption::Recorded(KalVoiceUsage {
        used: current.used.saturating_add(1),
        ..current
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use kalcode_contracts::ids::new_id;
    use kalcode_core::db;
    use time::macros::datetime;

    fn conn() -> Connection {
        let mut conn = db::open_in_memory().expect("open");
        db::migrate(&mut conn, db::MIGRATIONS, None).expect("migrate");
        conn
    }

    const NOW: OffsetDateTime = datetime!(2026-09-24 18:00 UTC);

    fn take(
        conn: &Connection,
        id: &str,
        now: OffsetDateTime,
        allowance: Option<u32>,
    ) -> Consumption {
        consume(conn, id, KalVoiceInput::Text, "navigate", now, 1, allowance).expect("consume")
    }

    #[test]
    fn calendar_periods_and_rollover() {
        let p = Period::containing(NOW, 1);
        assert_eq!(p.start_rfc3339(), "2026-09-01T00:00:00.000Z");
        assert_eq!(p.resets_at_rfc3339(), "2026-10-01T00:00:00.000Z");
        let dec = Period::containing(datetime!(2026-12-31 23:59:59 UTC), 1);
        assert_eq!(dec.resets_at_rfc3339(), "2027-01-01T00:00:00.000Z");
        let jan = Period::containing(datetime!(2027-01-01 00:00 UTC), 1);
        assert_eq!(jan.start_rfc3339(), "2027-01-01T00:00:00.000Z");
        // Non-UTC input is interpreted in UTC.
        let local = Period::containing(datetime!(2026-10-01 01:00 +02:00), 1);
        assert_eq!(local.start_rfc3339(), "2026-09-01T00:00:00.000Z");
    }

    #[test]
    fn anchored_periods_clamp_to_short_months() {
        let p = Period::containing(datetime!(2026-02-10 12:00 UTC), 31);
        assert_eq!(p.start_rfc3339(), "2026-01-31T00:00:00.000Z");
        assert_eq!(p.resets_at_rfc3339(), "2026-02-28T00:00:00.000Z");
        let q = Period::containing(datetime!(2026-03-15 00:00 UTC), 15);
        assert_eq!(q.start_rfc3339(), "2026-03-15T00:00:00.000Z");
        assert_eq!(q.resets_at_rfc3339(), "2026-04-15T00:00:00.000Z");
    }

    #[test]
    fn counts_each_request_once() {
        let conn = conn();
        let id = new_id();
        assert!(
            matches!(take(&conn, &id, NOW, Some(250)), Consumption::Recorded(u) if u.used == 1)
        );
        match take(&conn, &id, NOW, Some(250)) {
            Consumption::AlreadyRecorded(u) => assert_eq!(u.used, 1),
            other => panic!("{other:?}"),
        }
        let u = usage(&conn, NOW, 1, Some(250)).expect("usage");
        assert_eq!(u.used, 1);
        assert_eq!(u.remaining(), Some(249));
    }

    #[test]
    fn limit_reached_records_nothing() {
        let conn = conn();
        for _ in 0..3 {
            assert!(matches!(
                take(&conn, &new_id(), NOW, Some(3)),
                Consumption::Recorded(_)
            ));
        }
        match take(&conn, &new_id(), NOW, Some(3)) {
            Consumption::LimitReached(u) => {
                assert_eq!(u.used, 3);
                assert!(u.exhausted());
                assert_eq!(u.resets_at, "2026-10-01T00:00:00.000Z");
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(usage(&conn, NOW, 1, Some(3)).expect("usage").used, 3);
    }

    #[test]
    fn a_new_period_starts_from_zero() {
        let conn = conn();
        for _ in 0..3 {
            take(&conn, &new_id(), NOW, Some(3));
        }
        let october = datetime!(2026-10-01 00:00:01 UTC);
        let u = usage(&conn, october, 1, Some(3)).expect("usage");
        assert_eq!(u.used, 0);
        assert_eq!(u.period_start, "2026-10-01T00:00:00.000Z");
        assert!(matches!(
            take(&conn, &new_id(), october, Some(3)),
            Consumption::Recorded(u) if u.used == 1
        ));
    }

    #[test]
    fn unlimited_is_never_exhausted() {
        let conn = conn();
        for _ in 0..300 {
            assert!(matches!(
                take(&conn, &new_id(), NOW, None),
                Consumption::Recorded(_)
            ));
        }
        let u = usage(&conn, NOW, 1, None).expect("usage");
        assert_eq!(u.used, 300);
        assert_eq!(u.allowance, None);
        assert!(!u.exhausted());
    }

    #[test]
    fn rows_hold_ids_and_facts_only() {
        let conn = conn();
        let id = new_id();
        consume(
            &conn,
            &id,
            KalVoiceInput::Voice,
            "create_threads",
            NOW,
            1,
            Some(250),
        )
        .expect("consume");
        let row: (String, String, String) = conn
            .query_row(
                "SELECT input, intent, period_start FROM kalvoice_requests WHERE request_id = ?1",
                [&id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .expect("row");
        assert_eq!(
            row,
            (
                "voice".into(),
                "create_threads".into(),
                "2026-09-01T00:00:00.000Z".into()
            )
        );
    }

    #[test]
    fn invalid_request_ids_are_refused() {
        let conn = conn();
        for bad in ["", "abc", "../../x", "'; DROP TABLE kalvoice_requests; --"] {
            let err = consume(&conn, bad, KalVoiceInput::Text, "x", NOW, 1, None).expect_err("bad");
            assert_eq!(err.code, "invalid_request_id");
        }
    }
}
