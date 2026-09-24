//! Event persistence. Events are written before they are published; `seq` (the SQLite rowid)
//! is the ordering authority.

use rusqlite::{Connection, Row, params};
use serde_json::{Value, json};

use super::{Correlation, EventEnvelope, EventPayload, EventSource, NewEvent};
use crate::error::{KalError, Result};
use crate::time::now_rfc3339;

/// Maximum page size for history queries.
pub const MAX_PAGE: u32 = 500;

pub struct EventStore;

impl EventStore {
    /// Persists an event and returns the stored envelope with its assigned `seq`.
    pub fn append(conn: &Connection, new: NewEvent) -> Result<EventEnvelope> {
        let wire = serde_json::to_value(&new.event)?;
        let payload = wire.get("payload").cloned().unwrap_or(Value::Object(Default::default()));
        let id = uuid::Uuid::now_v7().to_string();
        let occurred_at = now_rfc3339();
        let version = new.event.version();
        let c = &new.correlation;
        conn.execute(
            "INSERT INTO events (id, type, version, occurred_at, source, workspace_id, thread_id, mission_id, provider_id, request_id, payload)
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
        let seq = conn.last_insert_rowid();
        Ok(EventEnvelope { id, seq, version, occurred_at, source: new.source, correlation: new.correlation, event: new.event })
    }

    /// Newest-first page of events, optionally strictly older than `before_seq`.
    pub fn recent(conn: &Connection, limit: u32, before_seq: Option<i64>) -> Result<Vec<EventEnvelope>> {
        if limit == 0 || limit > MAX_PAGE {
            return Err(KalError::validation("invalid_page_size", format!("Page size must be between 1 and {MAX_PAGE}.")));
        }
        let mut stmt = conn.prepare(
            "SELECT seq, id, type, version, occurred_at, source, workspace_id, thread_id, mission_id, provider_id, request_id, payload
             FROM events WHERE (?1 IS NULL OR seq < ?1) ORDER BY seq DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![before_seq, limit], row_to_envelope)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
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
        },
        event: decode_payload(&event_type, version, &payload_text),
    })
}

/// Decodes a stored payload; unknown or undecodable types become `Unrecognized` so one odd
/// row never breaks history.
fn decode_payload(event_type: &str, version: u32, payload_text: &str) -> EventPayload {
    let unrecognized = || EventPayload::Unrecognized { original_type: event_type.to_owned(), original_version: version };
    if version != 1 || event_type == "unrecognized" {
        return unrecognized();
    }
    let Ok(payload) = serde_json::from_str::<Value>(payload_text) else {
        return unrecognized();
    };
    serde_json::from_value(json!({ "type": event_type, "payload": payload })).unwrap_or_else(|_| unrecognized())
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
        NewEvent::core(EventPayload::SettingsChanged { keys: vec![key.into()] })
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
        let appended: Vec<_> = (0..5).map(|i| EventStore::append(&conn, settings_changed(&i.to_string())).expect("append")).collect();
        let page1 = EventStore::recent(&conn, 2, None).expect("page1");
        assert_eq!(page1.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![appended[4].seq, appended[3].seq]);
        let page2 = EventStore::recent(&conn, 2, Some(page1[1].seq)).expect("page2");
        assert_eq!(page2.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![appended[2].seq, appended[1].seq]);
        assert_eq!(page2[0], appended[2]);
    }

    #[test]
    fn page_size_is_validated() {
        let conn = conn();
        assert_eq!(EventStore::recent(&conn, 0, None).expect_err("zero").code, "invalid_page_size");
        assert_eq!(EventStore::recent(&conn, MAX_PAGE + 1, None).expect_err("big").code, "invalid_page_size");
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
        assert_eq!(events[1].event, EventPayload::Unrecognized { original_type: "thread.teleported".into(), original_version: 3 });
        assert_eq!(events[0].event, EventPayload::Unrecognized { original_type: "settings.changed".into(), original_version: 1 });
    }
}
