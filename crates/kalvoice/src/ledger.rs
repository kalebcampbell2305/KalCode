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
    /// This client request id was already claimed (a retry); not counted again.
    AlreadyRecorded {
        usage: KalVoiceUsage,
        execution: RequestExecution,
    },
    /// The allowance is used up; nothing was recorded.
    LimitReached(KalVoiceUsage),
}

impl Consumption {
    pub fn usage(&self) -> &KalVoiceUsage {
        match self {
            Self::Recorded(u) | Self::LimitReached(u) => u,
            Self::AlreadyRecorded { usage, .. } => usage,
        }
    }
}

/// Durable state of a request that already owns its usage claim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestExecution {
    /// The executor has not recorded a terminal result. The owner is absent only for malformed
    /// legacy/manual data; callers must treat that as indeterminate and never execute it.
    Claimed {
        owner: Option<String>,
    },
    Completed,
    Failed {
        code: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedRequest {
    pub intent: String,
    pub execution: RequestExecution,
}

/// Terminal result written after the executor returns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionResult<'a> {
    Completed,
    Failed { code: &'a str },
}

/// Immutable request facts bound to one durable execution claim.
#[derive(Debug, Clone, Copy)]
pub struct RequestClaim<'a> {
    pub request_id: &'a str,
    pub input: KalVoiceInput,
    pub intent_kind: &'a str,
    pub execution_owner: &'a str,
}

/// Usage policy and clock values evaluated atomically with a request claim.
#[derive(Debug, Clone, Copy)]
pub struct ConsumptionContext {
    pub now: OffsetDateTime,
    pub anchor_day: u8,
    pub allowance: Option<u32>,
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

/// Reads the durable execution state for a previously claimed request.
pub fn execution(conn: &Connection, request_id: &str) -> Result<Option<RequestExecution>> {
    Ok(recorded_request(conn, request_id)?.map(|request| request.execution))
}

/// Reads the non-content metadata needed to answer an idempotent retry truthfully.
pub fn recorded_request(conn: &Connection, request_id: &str) -> Result<Option<RecordedRequest>> {
    let row: Option<(String, String, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT intent, execution_state, execution_owner, outcome_code
               FROM kalvoice_requests WHERE request_id = ?1",
            [request_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    row.map(|(intent, state, owner, code)| {
        let execution = match state.as_str() {
            "claimed" => RequestExecution::Claimed { owner },
            "completed" => RequestExecution::Completed,
            "failed" => RequestExecution::Failed {
                code: code.unwrap_or_else(|| "execution_failed".into()),
            },
            _ => {
                return Err(KalError::internal(
                    "invalid_kalvoice_request_state",
                    "KalVoice's request ledger contains an invalid execution state.",
                ));
            }
        };
        Ok(RecordedRequest { intent, execution })
    })
    .transpose()
}

/// Intents whose effect the UI can undo ("Type it instead" after a spoken command).
pub const REVERSIBLE_INTENTS: &[&str] = &["navigate"];

/// Un-counts a request the user turned into typing, when its command was reversible and it was
/// counted within `max_age`. Returns whether it was un-counted.
pub fn refund(
    conn: &Connection,
    request_id: &str,
    now: OffsetDateTime,
    max_age: time::Duration,
) -> Result<bool> {
    let row: Option<(String, String, String)> = conn
        .query_row(
            "SELECT intent, recorded_at, execution_state
               FROM kalvoice_requests WHERE request_id = ?1",
            [request_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((intent, recorded_at, execution_state)) = row else {
        return Ok(false);
    };
    let recent =
        OffsetDateTime::parse(&recorded_at, &time::format_description::well_known::Rfc3339)
            .is_ok_and(|at| now - at <= max_age);
    if execution_state != "completed" || !recent || !REVERSIBLE_INTENTS.contains(&intent.as_str()) {
        return Ok(false);
    }
    conn.execute(
        "DELETE FROM kalvoice_requests WHERE request_id = ?1",
        [request_id],
    )?;
    Ok(true)
}

/// Counts one top-level request, atomically with the allowance check. Call inside the
/// transaction that records the request's events.
pub fn consume(
    conn: &Connection,
    claim: RequestClaim<'_>,
    context: ConsumptionContext,
) -> Result<Consumption> {
    if !is_valid_id(claim.request_id) {
        return Err(KalError::validation(
            "invalid_request_id",
            "KalVoice received an invalid request id.",
        ));
    }
    if !is_valid_id(claim.execution_owner) {
        return Err(KalError::validation(
            "invalid_execution_owner",
            "KalVoice received an invalid execution owner.",
        ));
    }
    let existing = execution(conn, claim.request_id)?;
    let current = usage(conn, context.now, context.anchor_day, context.allowance)?;
    if let Some(execution) = existing {
        return Ok(Consumption::AlreadyRecorded {
            usage: current,
            execution,
        });
    }
    if current.exhausted() {
        return Ok(Consumption::LimitReached(current));
    }
    conn.execute(
        "INSERT INTO kalvoice_requests (
             request_id, period_start, recorded_at, input, intent,
             execution_state, execution_owner, outcome_code
         ) VALUES (?1, ?2, ?3, ?4, ?5, 'claimed', ?6, NULL)",
        params![
            claim.request_id,
            current.period_start,
            format_rfc3339(context.now),
            match claim.input {
                KalVoiceInput::Voice => "voice",
                KalVoiceInput::Text => "text",
            },
            claim.intent_kind,
            claim.execution_owner,
        ],
    )?;
    Ok(Consumption::Recorded(KalVoiceUsage {
        used: current.used.saturating_add(1),
        ..current
    }))
}

/// Records the terminal executor result for a claim owned by this orchestrator instance.
/// Returns false instead of overwriting a row whose owner/state changed.
pub fn finish(
    conn: &Connection,
    request_id: &str,
    execution_owner: &str,
    result: ExecutionResult<'_>,
) -> Result<bool> {
    if !is_valid_id(request_id) || !is_valid_id(execution_owner) {
        return Err(KalError::validation(
            "invalid_request_claim",
            "KalVoice received an invalid request claim.",
        ));
    }
    let (state, code) = match result {
        ExecutionResult::Completed => ("completed", None),
        ExecutionResult::Failed { code } => (
            "failed",
            Some(if valid_outcome_code(code) {
                code
            } else {
                "execution_failed"
            }),
        ),
    };
    Ok(conn.execute(
        "UPDATE kalvoice_requests
            SET execution_state = ?1, outcome_code = ?2
          WHERE request_id = ?3 AND execution_state = 'claimed' AND execution_owner = ?4",
        params![state, code, request_id, execution_owner],
    )? == 1)
}

fn valid_outcome_code(code: &str) -> bool {
    !code.is_empty()
        && code.len() <= 128
        && code
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;
    use kalcode_contracts::ids::new_id;
    use kalcode_core::db;
    use time::macros::datetime;

    fn conn() -> Connection {
        let mut conn = db::open_in_memory().expect("open");
        db::migrate(&mut conn, kalcode_core::db::MIGRATIONS, None).expect("migrate");
        conn
    }

    const NOW: OffsetDateTime = datetime!(2026-09-24 18:00 UTC);
    const OWNER: &str = "0192f3c4-0000-7000-8000-0000000000ee";

    fn take(
        conn: &Connection,
        id: &str,
        now: OffsetDateTime,
        allowance: Option<u32>,
    ) -> Consumption {
        consume(
            conn,
            RequestClaim {
                request_id: id,
                input: KalVoiceInput::Text,
                intent_kind: "navigate",
                execution_owner: OWNER,
            },
            ConsumptionContext {
                now,
                anchor_day: 1,
                allowance,
            },
        )
        .expect("consume")
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
        assert!(matches!(take(&conn, &id, NOW, Some(25)), Consumption::Recorded(u) if u.used == 1));
        match take(&conn, &id, NOW, Some(25)) {
            Consumption::AlreadyRecorded { usage, execution } => {
                assert_eq!(usage.used, 1);
                assert_eq!(
                    execution,
                    RequestExecution::Claimed {
                        owner: Some(OWNER.into())
                    }
                );
            }
            other => panic!("{other:?}"),
        }
        let u = usage(&conn, NOW, 1, Some(25)).expect("usage");
        assert_eq!(u.used, 1);
        assert_eq!(u.remaining(), Some(74));
    }

    #[test]
    fn terminal_results_are_owner_bound_and_replayable_without_content() {
        let conn = conn();
        let completed = new_id();
        assert!(matches!(
            take(&conn, &completed, NOW, Some(25)),
            Consumption::Recorded(_)
        ));
        assert!(finish(&conn, &completed, OWNER, ExecutionResult::Completed).expect("finish"));
        assert_eq!(
            execution(&conn, &completed).expect("state"),
            Some(RequestExecution::Completed)
        );
        assert!(
            !finish(
                &conn,
                &completed,
                OWNER,
                ExecutionResult::Failed { code: "too_late" }
            )
            .expect("terminal state cannot change")
        );

        let failed = new_id();
        take(&conn, &failed, NOW, Some(25));
        assert!(
            finish(
                &conn,
                &failed,
                OWNER,
                ExecutionResult::Failed {
                    code: "unsafe code with spaces"
                }
            )
            .expect("finish failed")
        );
        assert_eq!(
            execution(&conn, &failed).expect("state"),
            Some(RequestExecution::Failed {
                code: "execution_failed".into()
            })
        );
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
            RequestClaim {
                request_id: &id,
                input: KalVoiceInput::Voice,
                intent_kind: "create_threads",
                execution_owner: OWNER,
            },
            ConsumptionContext {
                now: NOW,
                anchor_day: 1,
                allowance: Some(25),
            },
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
    fn only_recent_reversible_requests_are_refunded() {
        let conn = conn();
        let nav = new_id();
        consume(
            &conn,
            RequestClaim {
                request_id: &nav,
                input: KalVoiceInput::Voice,
                intent_kind: "navigate",
                execution_owner: OWNER,
            },
            ConsumptionContext {
                now: NOW,
                anchor_day: 1,
                allowance: Some(25),
            },
        )
        .expect("nav");
        finish(&conn, &nav, OWNER, ExecutionResult::Completed).expect("finish nav");
        let stop = new_id();
        consume(
            &conn,
            RequestClaim {
                request_id: &stop,
                input: KalVoiceInput::Voice,
                intent_kind: "stop_threads",
                execution_owner: OWNER,
            },
            ConsumptionContext {
                now: NOW,
                anchor_day: 1,
                allowance: Some(25),
            },
        )
        .expect("stop");
        finish(&conn, &stop, OWNER, ExecutionResult::Completed).expect("finish stop");
        let later = NOW + time::Duration::minutes(10);
        assert!(!refund(&conn, &nav, later, time::Duration::minutes(2)).expect("old"));
        assert!(!refund(&conn, &stop, NOW, time::Duration::minutes(2)).expect("irreversible"));
        assert!(refund(&conn, &nav, NOW, time::Duration::minutes(2)).expect("refund"));
        assert!(!refund(&conn, &nav, NOW, time::Duration::minutes(2)).expect("twice"));
        assert_eq!(usage(&conn, NOW, 1, Some(25)).expect("usage").used, 1);
    }

    #[test]
    fn invalid_request_ids_are_refused() {
        let conn = conn();
        for bad in ["", "abc", "../../x", "'; DROP TABLE kalvoice_requests; --"] {
            let err = consume(
                &conn,
                RequestClaim {
                    request_id: bad,
                    input: KalVoiceInput::Text,
                    intent_kind: "x",
                    execution_owner: OWNER,
                },
                ConsumptionContext {
                    now: NOW,
                    anchor_day: 1,
                    allowance: None,
                },
            )
            .expect_err("bad");
            assert_eq!(err.code, "invalid_request_id");
        }
    }
}
