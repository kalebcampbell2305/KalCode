//! Event persistence. Events are written before they are published; `seq` (the SQLite rowid)
//! is the ordering authority.

use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, Row, params, params_from_iter};
use serde_json::{Value, json};

use super::{Correlation, EventEnvelope, EventPayload, EventSource, NewEvent};
use crate::error::{KalError, Result};
use crate::time::now_rfc3339;
use kalcode_contracts::events::{
    CorrelationFilter, EventPage, EventQuery, MAX_QUERY_LIMIT, MAX_QUERY_TYPES, SeqOrder,
};

/// Maximum page size for history queries.
pub const MAX_PAGE: u32 = 500;

/// Columns every read selects, in `row_to_envelope` order (schema v5 and later).
const COLUMNS: &str = "seq, id, type, version, occurred_at, source, workspace_id, thread_id, \
    mission_id, provider_id, request_id, payload, agent_id, task_id, automation_id, causation_id";

/// The same columns on a database older than v5 (only reachable when a test opens the core with
/// an older migration set; a shipped build always migrates to its latest schema first).
const COLUMNS_BEFORE_V5: &str = "seq, id, type, version, occurred_at, source, workspace_id, \
    thread_id, mission_id, provider_id, request_id, payload, NULL, NULL, NULL, NULL";

/// Whether `events` has the v5 correlation columns.
fn has_v5_columns(conn: &Connection) -> Result<bool> {
    let count: i64 = conn
        .prepare_cached(
            "SELECT COUNT(*) FROM pragma_table_info('events') WHERE name = 'causation_id'",
        )?
        .query_row([], |row| row.get(0))?;
    Ok(count == 1)
}

fn columns(conn: &Connection) -> Result<&'static str> {
    Ok(if has_v5_columns(conn)? {
        COLUMNS
    } else {
        COLUMNS_BEFORE_V5
    })
}

/// Longest type filter, correlation id or time bound accepted from a query.
const MAX_FILTER_LEN: usize = 128;

pub struct EventStore;

impl EventStore {
    /// Persists an event and returns the stored envelope with its assigned `seq`.
    pub fn append(conn: &Connection, new: NewEvent) -> Result<EventEnvelope> {
        let wire = serde_json::to_value(&new.event)?;
        let payload = wire
            .get("payload")
            .cloned()
            .unwrap_or(Value::Object(Default::default()));
        let id = uuid::Uuid::now_v7().to_string();
        let occurred_at = now_rfc3339();
        let version = new.event.version();
        let c = &new.correlation;
        let v5_ids = c.agent_id.is_some()
            || c.task_id.is_some()
            || c.automation_id.is_some()
            || c.causation_id.is_some();
        if !v5_ids {
            // Only the v1 columns: works on every schema version (the v5 columns default NULL).
            conn.execute(
                "INSERT INTO events (id, type, version, occurred_at, source, workspace_id,
                   thread_id, mission_id, provider_id, request_id, payload)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    id,
                    new.event.type_name(),
                    version,
                    occurred_at,
                    new.source.as_str(),
                    c.workspace_id,
                    c.thread_id,
                    c.mission_id,
                    c.provider_id,
                    c.request_id,
                    payload.to_string(),
                ],
            )?;
        } else {
            conn.execute(
            "INSERT INTO events (id, type, version, occurred_at, source, workspace_id, thread_id,
               mission_id, provider_id, request_id, payload, agent_id, task_id, automation_id,
               causation_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![
                id,
                new.event.type_name(),
                version,
                occurred_at,
                new.source.as_str(),
                c.workspace_id,
                c.thread_id,
                c.mission_id,
                c.provider_id,
                c.request_id,
                payload.to_string(),
                c.agent_id,
                c.task_id,
                c.automation_id,
                c.causation_id,
            ],
        )?;
        }
        let seq = conn.last_insert_rowid();
        Ok(EventEnvelope {
            id,
            seq,
            version,
            occurred_at,
            source: new.source,
            correlation: new.correlation,
            event: new.event,
        })
    }

    /// Newest-first page of events, optionally strictly older than `before_seq`.
    pub fn recent(
        conn: &Connection,
        limit: u32,
        before_seq: Option<i64>,
    ) -> Result<Vec<EventEnvelope>> {
        if limit == 0 || limit > MAX_PAGE {
            return Err(KalError::validation(
                "invalid_page_size",
                format!("Page size must be between 1 and {MAX_PAGE}."),
            ));
        }
        let columns = columns(conn)?;
        let mut stmt = conn.prepare(&format!(
            "SELECT {columns} FROM events WHERE (?1 IS NULL OR seq < ?1) ORDER BY seq DESC LIMIT ?2"
        ))?;
        let rows = stmt.query_map(params![before_seq, limit], row_to_envelope)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// A filtered page of the log (`events_query`): exact types or `domain.*` prefixes, a
    /// correlation filter (every given id must match), a seq window, an occurred-at window, and
    /// ascending or descending order. `next_cursor` is the last `seq` of a full page.
    pub fn query(conn: &Connection, query: &EventQuery) -> Result<EventPage> {
        validate_query(query)?;
        let mut clauses: Vec<String> = Vec::new();
        let mut args: Vec<SqlValue> = Vec::new();

        if !query.types.is_empty() {
            let mut any = Vec::with_capacity(query.types.len());
            for filter in &query.types {
                if let Some(domain) = filter.strip_suffix(".*") {
                    // `domain.` + anything. Domains are validated to [a-z0-9_.], so no LIKE
                    // wildcard can be smuggled in; `_` is escaped anyway.
                    any.push("type LIKE ? ESCAPE '\\'".to_owned());
                    args.push(SqlValue::Text(format!("{}.%", domain.replace('_', "\\_"))));
                } else {
                    any.push("type = ?".to_owned());
                    args.push(SqlValue::Text(filter.clone()));
                }
            }
            clauses.push(format!("({})", any.join(" OR ")));
        }
        for (column, value) in correlation_filters(&query.correlation) {
            clauses.push(format!("{column} = ?"));
            args.push(SqlValue::Text(value.to_owned()));
        }
        if let Some(after) = query.after_seq {
            clauses.push("seq > ?".to_owned());
            args.push(SqlValue::Integer(after));
        }
        if let Some(before) = query.before_seq {
            clauses.push("seq < ?".to_owned());
            args.push(SqlValue::Integer(before));
        }
        if let Some(from) = &query.from {
            clauses.push("occurred_at >= ?".to_owned());
            args.push(SqlValue::Text(from.clone()));
        }
        if let Some(to) = &query.to {
            clauses.push("occurred_at < ?".to_owned());
            args.push(SqlValue::Text(to.clone()));
        }
        let filter = if clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", clauses.join(" AND "))
        };
        let order = match query.order {
            SeqOrder::Asc => "ASC",
            SeqOrder::Desc => "DESC",
        };
        args.push(SqlValue::Integer(i64::from(query.limit)));
        let columns = columns(conn)?;
        let mut stmt = conn.prepare(&format!(
            "SELECT {columns} FROM events {filter} ORDER BY seq {order} LIMIT ?"
        ))?;
        let events = stmt
            .query_map(params_from_iter(args), row_to_envelope)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let full = u32::try_from(events.len()).unwrap_or(u32::MAX) == query.limit;
        let next_cursor = if full {
            events.last().map(|e| e.seq)
        } else {
            None
        };
        Ok(EventPage {
            events,
            next_cursor,
        })
    }

    pub fn count(conn: &Connection) -> Result<i64> {
        Ok(conn.query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))?)
    }
}

fn row_to_envelope(row: &Row<'_>) -> rusqlite::Result<EventEnvelope> {
    let event_type: String = row.get(2)?;
    let version: u32 = row.get(3)?;
    let payload_text: String = row.get(11)?;
    Ok(EventEnvelope {
        seq: row.get(0)?,
        id: row.get(1)?,
        version,
        occurred_at: row.get(4)?,
        source: EventSource::parse(&row.get::<_, String>(5)?),
        correlation: Correlation {
            workspace_id: row.get(6)?,
            thread_id: row.get(7)?,
            mission_id: row.get(8)?,
            provider_id: row.get(9)?,
            request_id: row.get(10)?,
            agent_id: row.get(12)?,
            task_id: row.get(13)?,
            automation_id: row.get(14)?,
            causation_id: row.get(15)?,
        },
        event: decode_payload(&event_type, version, &payload_text),
    })
}

fn invalid_query(message: &str) -> KalError {
    KalError::validation("invalid_event_query", message.to_owned())
}

/// `domain.verb` or `domain.*`: lowercase letters, digits and `_`, dot-separated.
fn valid_type_filter(filter: &str) -> bool {
    let name = filter.strip_suffix(".*").unwrap_or(filter);
    !name.is_empty()
        && filter.len() <= MAX_FILTER_LEN
        && name.split('.').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        })
}

fn validate_query(query: &EventQuery) -> Result<()> {
    if query.limit == 0 || query.limit > MAX_QUERY_LIMIT {
        return Err(KalError::validation(
            "invalid_page_size",
            format!("Page size must be between 1 and {MAX_QUERY_LIMIT}."),
        ));
    }
    if query.types.len() > MAX_QUERY_TYPES {
        return Err(invalid_query("Too many event types in one query."));
    }
    if !query.types.iter().all(|t| valid_type_filter(t)) {
        return Err(invalid_query("An event type filter isn't valid."));
    }
    if query.after_seq.is_some_and(|s| s < 0) || query.before_seq.is_some_and(|s| s < 1) {
        return Err(invalid_query("The history cursor is invalid."));
    }
    for bound in [&query.from, &query.to].into_iter().flatten() {
        if bound.len() > MAX_FILTER_LEN
            || time::OffsetDateTime::parse(bound, &time::format_description::well_known::Rfc3339)
                .is_err()
        {
            return Err(invalid_query("A time bound isn't a valid RFC 3339 time."));
        }
    }
    for (_, value) in correlation_filters(&query.correlation) {
        if value.is_empty() || value.len() > MAX_FILTER_LEN || value.chars().any(char::is_control) {
            return Err(invalid_query("A correlation filter isn't valid."));
        }
    }
    Ok(())
}

/// The given correlation filters as (column, value) pairs. Column names are fixed here, never
/// taken from the query.
fn correlation_filters(filter: &CorrelationFilter) -> Vec<(&'static str, &str)> {
    [
        ("workspace_id", &filter.workspace_id),
        ("thread_id", &filter.thread_id),
        ("mission_id", &filter.mission_id),
        ("provider_id", &filter.provider_id),
        ("request_id", &filter.request_id),
        ("agent_id", &filter.agent_id),
        ("task_id", &filter.task_id),
        ("automation_id", &filter.automation_id),
        ("causation_id", &filter.causation_id),
    ]
    .into_iter()
    .filter_map(|(column, value)| value.as_deref().map(|v| (column, v)))
    .collect()
}

/// Decodes a stored payload; unknown or undecodable types become `Unrecognized` so one odd
/// row never breaks history.
fn decode_payload(event_type: &str, version: u32, payload_text: &str) -> EventPayload {
    let unrecognized = || EventPayload::Unrecognized {
        original_type: event_type.to_owned(),
        original_version: version,
    };
    if version != 1 || event_type == "unrecognized" {
        return unrecognized();
    }
    let Ok(payload) = serde_json::from_str::<Value>(payload_text) else {
        return unrecognized();
    };
    serde_json::from_value(json!({ "type": event_type, "payload": payload }))
        .unwrap_or_else(|_| unrecognized())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn conn() -> Connection {
        let mut conn = db::open_in_memory().expect("open");
        db::migrate(&mut conn, db::MIGRATIONS, None).expect("migrate");
        conn
    }

    fn settings_changed(key: &str) -> NewEvent {
        NewEvent::core(EventPayload::SettingsChanged {
            keys: vec![key.into()],
        })
    }

    #[test]
    fn append_assigns_monotonic_seq() {
        let conn = conn();
        let a = EventStore::append(&conn, settings_changed("a")).expect("a");
        let b = EventStore::append(&conn, settings_changed("b")).expect("b");
        assert!(b.seq > a.seq);
        assert_ne!(a.id, b.id);
        assert_eq!(EventStore::count(&conn).expect("count"), 2);
    }

    #[test]
    fn recent_pages_newest_first() {
        let conn = conn();
        let appended: Vec<_> = (0..5)
            .map(|i| EventStore::append(&conn, settings_changed(&i.to_string())).expect("append"))
            .collect();
        let page1 = EventStore::recent(&conn, 2, None).expect("page1");
        assert_eq!(
            page1.iter().map(|e| e.seq).collect::<Vec<_>>(),
            vec![appended[4].seq, appended[3].seq]
        );
        let page2 = EventStore::recent(&conn, 2, Some(page1[1].seq)).expect("page2");
        assert_eq!(
            page2.iter().map(|e| e.seq).collect::<Vec<_>>(),
            vec![appended[2].seq, appended[1].seq]
        );
        assert_eq!(page2[0], appended[2]);
    }

    #[test]
    fn page_size_is_validated() {
        let conn = conn();
        assert_eq!(
            EventStore::recent(&conn, 0, None).expect_err("zero").code,
            "invalid_page_size"
        );
        assert_eq!(
            EventStore::recent(&conn, MAX_PAGE + 1, None)
                .expect_err("big")
                .code,
            "invalid_page_size"
        );
        assert!(EventStore::recent(&conn, MAX_PAGE, None).is_ok());
    }

    #[test]
    fn correlation_ids_are_persisted() {
        let conn = conn();
        let mut event = settings_changed("x");
        event.correlation.thread_id = Some("thread-1".into());
        event.source = EventSource::Ui;
        EventStore::append(&conn, event).expect("append");
        let stored = &EventStore::recent(&conn, 1, None).expect("recent")[0];
        assert_eq!(stored.correlation.thread_id.as_deref(), Some("thread-1"));
        assert_eq!(stored.source, EventSource::Ui);
    }

    #[test]
    fn unknown_types_decode_as_unrecognized() {
        let conn = conn();
        conn.execute(
            "INSERT INTO events (id, type, version, occurred_at, source, payload) VALUES ('x', 'thread.teleported', 3, '2026-01-01T00:00:00.000Z', 'core', '{}')",
            [],
        )
        .expect("insert");
        conn.execute(
            "INSERT INTO events (id, type, version, occurred_at, source, payload) VALUES ('y', 'settings.changed', 1, '2026-01-01T00:00:00.000Z', 'core', '{\"wrong\":1}')",
            [],
        )
        .expect("insert");
        let events = EventStore::recent(&conn, 10, None).expect("recent");
        assert_eq!(
            events[1].event,
            EventPayload::Unrecognized {
                original_type: "thread.teleported".into(),
                original_version: 3
            }
        );
        assert_eq!(
            events[0].event,
            EventPayload::Unrecognized {
                original_type: "settings.changed".into(),
                original_version: 1
            }
        );
    }

    fn with(event: NewEvent, correlation: Correlation) -> NewEvent {
        event.with_correlation(correlation)
    }

    #[test]
    fn new_correlation_ids_round_trip() {
        let conn = conn();
        let correlation = Correlation {
            agent_id: Some("agent".into()),
            task_id: Some("task".into()),
            automation_id: Some("auto".into()),
            causation_id: Some("cause".into()),
            ..Correlation::default()
        };
        let stored = EventStore::append(&conn, with(settings_changed("x"), correlation.clone()))
            .expect("append");
        let read = &EventStore::recent(&conn, 1, None).expect("recent")[0];
        assert_eq!(read, &stored);
        assert_eq!(read.correlation, correlation);
    }

    /// Seeds: 3 thread events for thread A (one caused by another), 2 settings events, 1
    /// approval event with an agent id.
    fn seeded() -> (Connection, Vec<EventEnvelope>) {
        let conn = conn();
        let thread = |t: &str| Correlation {
            thread_id: Some(t.into()),
            workspace_id: Some("ws".into()),
            ..Correlation::default()
        };
        let mut out = Vec::new();
        out.push(
            EventStore::append(
                &conn,
                with(
                    NewEvent::core(EventPayload::ThreadStarted {
                        thread_id: "A".into(),
                    }),
                    thread("A"),
                ),
            )
            .expect("1"),
        );
        out.push(EventStore::append(&conn, settings_changed("a")).expect("2"));
        let cause = out[0].id.clone();
        out.push(
            EventStore::append(
                &conn,
                with(
                    NewEvent::core(EventPayload::ThreadCompleted {
                        thread_id: "A".into(),
                    }),
                    Correlation {
                        causation_id: Some(cause),
                        ..thread("A")
                    },
                ),
            )
            .expect("3"),
        );
        out.push(EventStore::append(&conn, settings_changed("b")).expect("4"));
        out.push(
            EventStore::append(
                &conn,
                with(
                    NewEvent::core(EventPayload::ApprovalDenied {
                        request_id: "r".into(),
                        thread_id: "B".into(),
                    }),
                    Correlation {
                        agent_id: Some("agent-1".into()),
                        request_id: Some("r".into()),
                        ..thread("B")
                    },
                ),
            )
            .expect("5"),
        );
        out.push(
            EventStore::append(
                &conn,
                with(
                    NewEvent::core(EventPayload::ThreadArchived {
                        thread_id: "A".into(),
                    }),
                    thread("A"),
                ),
            )
            .expect("6"),
        );
        (conn, out)
    }

    fn seqs(page: &EventPage) -> Vec<i64> {
        page.events.iter().map(|e| e.seq).collect()
    }

    #[test]
    fn query_filters_by_type_prefix_and_correlation() {
        let (conn, all) = seeded();
        let s = |i: usize| all[i].seq;
        let q = |q: EventQuery| EventStore::query(&conn, &q).expect("query");

        let threads = q(EventQuery {
            types: vec!["thread.*".into()],
            ..EventQuery::default()
        });
        assert_eq!(seqs(&threads), vec![s(5), s(2), s(0)]);

        let exact = q(EventQuery {
            types: vec!["settings.changed".into(), "approval.denied".into()],
            order: SeqOrder::Asc,
            ..EventQuery::default()
        });
        assert_eq!(seqs(&exact), vec![s(1), s(3), s(4)]);

        let thread_a = q(EventQuery {
            correlation: CorrelationFilter {
                thread_id: Some("A".into()),
                ..CorrelationFilter::default()
            },
            ..EventQuery::default()
        });
        assert_eq!(seqs(&thread_a), vec![s(5), s(2), s(0)]);

        let caused = q(EventQuery {
            correlation: CorrelationFilter {
                causation_id: Some(all[0].id.clone()),
                ..CorrelationFilter::default()
            },
            ..EventQuery::default()
        });
        assert_eq!(seqs(&caused), vec![s(2)]);

        let agent = q(EventQuery {
            correlation: CorrelationFilter {
                agent_id: Some("agent-1".into()),
                workspace_id: Some("ws".into()),
                ..CorrelationFilter::default()
            },
            ..EventQuery::default()
        });
        assert_eq!(seqs(&agent), vec![s(4)]);

        // Every given field must match.
        let none = q(EventQuery {
            correlation: CorrelationFilter {
                agent_id: Some("agent-1".into()),
                thread_id: Some("A".into()),
                ..CorrelationFilter::default()
            },
            ..EventQuery::default()
        });
        assert!(none.events.is_empty());
        assert_eq!(none.next_cursor, None);

        // A prefix never matches a longer domain that merely starts the same way.
        let prefix_only = q(EventQuery {
            types: vec!["thread_x.*".into()],
            ..EventQuery::default()
        });
        assert!(prefix_only.events.is_empty());
    }

    #[test]
    fn query_pages_with_cursors_in_both_orders() {
        let (conn, all) = seeded();
        let seq_of: Vec<i64> = all.iter().map(|e| e.seq).collect();
        // Descending: pages of 4 then 2.
        let first = EventStore::query(
            &conn,
            &EventQuery {
                limit: 4,
                ..EventQuery::default()
            },
        )
        .expect("first");
        assert_eq!(
            seqs(&first),
            vec![seq_of[5], seq_of[4], seq_of[3], seq_of[2]]
        );
        assert_eq!(first.next_cursor, Some(seq_of[2]));
        let second = EventStore::query(
            &conn,
            &EventQuery {
                limit: 4,
                before_seq: first.next_cursor,
                ..EventQuery::default()
            },
        )
        .expect("second");
        assert_eq!(seqs(&second), vec![seq_of[1], seq_of[0]]);
        assert_eq!(second.next_cursor, None);
        // Ascending from a cursor, bounded above.
        let window = EventStore::query(
            &conn,
            &EventQuery {
                order: SeqOrder::Asc,
                after_seq: Some(seq_of[0]),
                before_seq: Some(seq_of[4]),
                limit: 2,
                ..EventQuery::default()
            },
        )
        .expect("window");
        assert_eq!(seqs(&window), vec![seq_of[1], seq_of[2]]);
        assert_eq!(window.next_cursor, Some(seq_of[2]));
        // Time window: everything happened now, so a future lower bound matches nothing.
        let future = EventStore::query(
            &conn,
            &EventQuery {
                from: Some("2999-01-01T00:00:00Z".into()),
                ..EventQuery::default()
            },
        )
        .expect("future");
        assert!(future.events.is_empty());
    }

    #[test]
    fn invalid_queries_are_refused() {
        let conn = conn();
        let refused = |q: EventQuery| {
            EventStore::query(&conn, &q)
                .expect_err("must be refused")
                .code
        };
        assert_eq!(
            refused(EventQuery {
                limit: 0,
                ..EventQuery::default()
            }),
            "invalid_page_size"
        );
        assert_eq!(
            refused(EventQuery {
                limit: MAX_QUERY_LIMIT + 1,
                ..EventQuery::default()
            }),
            "invalid_page_size"
        );
        for bad in [
            "",
            "Thread.created",
            "thread.",
            ".x",
            "thread.%",
            "a b",
            "thread.*.*",
            "*",
        ] {
            assert_eq!(
                refused(EventQuery {
                    types: vec![bad.into()],
                    ..EventQuery::default()
                }),
                "invalid_event_query",
                "{bad:?}"
            );
        }
        assert_eq!(
            refused(EventQuery {
                types: vec!["thread.created".into(); MAX_QUERY_TYPES + 1],
                ..EventQuery::default()
            }),
            "invalid_event_query"
        );
        assert_eq!(
            refused(EventQuery {
                from: Some("yesterday".into()),
                ..EventQuery::default()
            }),
            "invalid_event_query"
        );
        assert_eq!(
            refused(EventQuery {
                before_seq: Some(0),
                ..EventQuery::default()
            }),
            "invalid_event_query"
        );
        assert_eq!(
            refused(EventQuery {
                correlation: CorrelationFilter {
                    thread_id: Some(String::new()),
                    ..CorrelationFilter::default()
                },
                ..EventQuery::default()
            }),
            "invalid_event_query"
        );
        // A hostile value is only ever a bound parameter.
        let injection = EventStore::query(
            &conn,
            &EventQuery {
                correlation: CorrelationFilter {
                    thread_id: Some("x' OR 1=1 --".into()),
                    ..CorrelationFilter::default()
                },
                ..EventQuery::default()
            },
        )
        .expect("query");
        assert!(injection.events.is_empty());
    }
}
