//! Scratchpads and saved API requests (schema v14, [`crate::UTILITY_MIGRATION`]).
//!
//! With v14 installed (registered by the lead at integration) the tables live in KalCode's
//! database: writes go through the core's single writer and reads through its read-only WAL
//! connection. Missing or unreadable authoritative schema fails closed; tests use an explicitly
//! constructed private in-memory store.

use std::sync::Arc;
#[cfg(test)]
use std::sync::{Mutex, MutexGuard, PoisonError};

use kalcode_contracts::ids::is_valid_id;
use kalcode_core::{Core, KalError, Result};
use rusqlite::{Connection, OptionalExtension, Transaction, params};

use crate::UTILITY_MIGRATION;
use crate::http::redact::redact_request;
use crate::types::{HttpRequestSpec, HttpSavedRequest, Scratchpad};
use crate::{invalid, invalid_id};

/// Most scratchpads per workspace (and not tied to one).
pub const MAX_SCRATCHPADS: usize = 200;
pub const MAX_SCRATCHPAD_BYTES: usize = 1024 * 1024;
pub const MAX_SAVED_REQUESTS: usize = 500;
const MAX_TITLE_CHARS: usize = 120;

pub enum Store {
    /// Tables in KalCode's database (schema v14 applied).
    Core(Arc<Core>),
    /// Test-only private database; production never substitutes it for authoritative state.
    #[cfg(test)]
    Memory(Mutex<Connection>),
}

/// True when schema v14's tables exist in `conn`'s database.
pub fn has_schema(conn: &Connection) -> Result<bool> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scratchpads'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    Ok(found.is_some())
}

fn now() -> String {
    kalcode_core::time::now_rfc3339()
}

fn clean_title(title: &str, fallback: &str) -> Result<String> {
    let cleaned: String = title
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let cleaned = if cleaned.is_empty() {
        fallback.to_owned()
    } else {
        cleaned
    };
    if cleaned.chars().count() > MAX_TITLE_CHARS {
        return Err(invalid(
            "title_too_long",
            "Names can be up to 120 characters.",
        ));
    }
    Ok(cleaned)
}

fn check_workspace(workspace_id: Option<&str>) -> Result<()> {
    match workspace_id {
        Some(id) if !is_valid_id(id) => Err(invalid_id()),
        _ => Ok(()),
    }
}

fn scratchpad_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Scratchpad> {
    Ok(Scratchpad {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        title: row.get(2)?,
        content: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

const SCRATCHPAD_COLUMNS: &str = "id, workspace_id, title, content, created_at, updated_at";

impl Store {
    /// Uses KalCode's database only when the allocated migration is present.
    pub fn open(core: &Arc<Core>) -> Result<Self> {
        if has_schema(&core.reader())? {
            return Ok(Self::Core(Arc::clone(core)));
        }
        Err(KalError::new(
            kalcode_core::ErrorCategory::Database,
            "utility_schema_missing",
            "The Utility Dock store is unavailable until its database migration is installed.",
        ))
    }

    /// A private in-memory database with the v14 tables for isolated tests.
    #[cfg(test)]
    pub fn memory() -> Result<Self> {
        let conn = kalcode_core::db::open_in_memory()?;
        conn.execute_batch(UTILITY_MIGRATION.sql)?;
        Ok(Self::Memory(Mutex::new(conn)))
    }

    pub fn persistent(&self) -> bool {
        matches!(self, Self::Core(_))
    }

    #[cfg(test)]
    fn memory_conn(conn: &Mutex<Connection>) -> MutexGuard<'_, Connection> {
        conn.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn read<T>(&self, read: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        match self {
            Self::Core(core) => read(&core.reader()),
            #[cfg(test)]
            Self::Memory(conn) => read(&Self::memory_conn(conn)),
        }
    }

    fn write<T>(&self, write: impl FnOnce(&Transaction<'_>) -> Result<T>) -> Result<T> {
        match self {
            Self::Core(core) => core
                .write_with_events(|tx| Ok((write(tx)?, Vec::new())))
                .map(|(value, _)| value),
            #[cfg(test)]
            Self::Memory(conn) => {
                let mut conn = Self::memory_conn(conn);
                let tx = conn.transaction()?;
                let value = write(&tx)?;
                tx.commit()?;
                Ok(value)
            }
        }
    }

    // ---- scratchpads ----

    /// Scratchpads of a workspace (`None`: the ones not tied to a workspace), newest first.
    pub fn scratchpads(&self, workspace_id: Option<&str>) -> Result<Vec<Scratchpad>> {
        check_workspace(workspace_id)?;
        self.read(|conn| {
            let mut stmt = conn.prepare(&format!(
                "SELECT {SCRATCHPAD_COLUMNS} FROM scratchpads WHERE workspace_id IS ?1
                 ORDER BY updated_at DESC, id DESC LIMIT {MAX_SCRATCHPADS}"
            ))?;
            let rows = stmt.query_map([workspace_id], scratchpad_row)?;
            Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
        })
    }

    /// Creates (`id: None`) or updates a scratchpad.
    pub fn save_scratchpad(
        &self,
        id: Option<&str>,
        workspace_id: Option<&str>,
        title: &str,
        content: &str,
    ) -> Result<Scratchpad> {
        check_workspace(workspace_id)?;
        if content.len() > MAX_SCRATCHPAD_BYTES {
            return Err(invalid(
                "scratchpad_too_large",
                "A scratchpad can hold up to 1 MiB of text.",
            ));
        }
        let title = clean_title(title, "Untitled")?;
        let at = now();
        match id {
            Some(id) => {
                if !is_valid_id(id) {
                    return Err(invalid_id());
                }
                self.write(|tx| {
                    let changed = tx.execute(
                        "UPDATE scratchpads SET title = ?2, content = ?3, updated_at = ?4
                         WHERE id = ?1 AND workspace_id IS ?5",
                        params![id, title, content, at, workspace_id],
                    )?;
                    if changed == 0 {
                        return Err(invalid("scratchpad_not_found", "That scratchpad is gone."));
                    }
                    Ok(tx.query_row(
                        &format!("SELECT {SCRATCHPAD_COLUMNS} FROM scratchpads WHERE id = ?1"),
                        [id],
                        scratchpad_row,
                    )?)
                })
            }
            None => {
                let id = uuid::Uuid::now_v7().to_string();
                self.write(|tx| {
                    let count: i64 = tx.query_row(
                        "SELECT count(*) FROM scratchpads WHERE workspace_id IS ?1",
                        [workspace_id],
                        |r| r.get(0),
                    )?;
                    if count as usize >= MAX_SCRATCHPADS {
                        return Err(invalid(
                            "scratchpads_full",
                            "This workspace already has 200 scratchpads. Delete some first.",
                        ));
                    }
                    tx.execute(
                        "INSERT INTO scratchpads (id, workspace_id, title, content, created_at, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                        params![id, workspace_id, title, content, at],
                    )?;
                    Ok(Scratchpad {
                        id: id.clone(),
                        workspace_id: workspace_id.map(str::to_owned),
                        title: title.clone(),
                        content: content.to_owned(),
                        created_at: at.clone(),
                        updated_at: at.clone(),
                    })
                })
            }
        }
    }

    pub fn delete_scratchpad(&self, id: &str) -> Result<()> {
        if !is_valid_id(id) {
            return Err(invalid_id());
        }
        self.write(|tx| {
            tx.execute("DELETE FROM scratchpads WHERE id = ?1", [id])?;
            Ok(())
        })
    }

    // ---- saved requests ----

    pub fn saved_requests(&self) -> Result<Vec<HttpSavedRequest>> {
        self.read(|conn| {
            let mut stmt = conn.prepare(&format!(
                "SELECT id, name, request, redactions, created_at, updated_at
                 FROM http_saved_requests ORDER BY name COLLATE NOCASE, id LIMIT {MAX_SAVED_REQUESTS}"
            ))?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })?;
            let mut out = Vec::new();
            for row in rows {
                let (id, name, request, redactions, created_at, updated_at) = row?;
                let Ok(request) = serde_json::from_str::<HttpRequestSpec>(&request) else {
                    tracing::warn!(event = "utility.saved_request_unreadable", id = %id);
                    continue;
                };
                out.push(HttpSavedRequest {
                    id,
                    name,
                    request,
                    redactions: u32::try_from(redactions).unwrap_or(0),
                    created_at,
                    updated_at,
                });
            }
            Ok(out)
        })
    }

    /// Saves a request. Sensitive header values and secret-looking values are removed first
    /// ([`redact_request`]); `redactions` says how many.
    pub fn save_request(
        &self,
        id: Option<&str>,
        name: &str,
        request: &HttpRequestSpec,
    ) -> Result<HttpSavedRequest> {
        let name = clean_title(name, "Untitled request")?;
        crate::http::prepare(request)?;
        let (stored, redactions) = redact_request(request);
        let json = serde_json::to_string(&stored).map_err(|e| {
            KalError::internal("saved_request_invalid", "Couldn't save that request.")
                .with_source(e)
        })?;
        let at = now();
        let id = match id {
            Some(id) if !is_valid_id(id) => return Err(invalid_id()),
            Some(id) => id.to_owned(),
            None => uuid::Uuid::now_v7().to_string(),
        };
        self.write(|tx| {
            let existing: Option<String> = tx
                .query_row(
                    "SELECT created_at FROM http_saved_requests WHERE id = ?1",
                    [&id],
                    |r| r.get(0),
                )
                .optional()?;
            if existing.is_none() {
                let count: i64 =
                    tx.query_row("SELECT count(*) FROM http_saved_requests", [], |r| r.get(0))?;
                if count as usize >= MAX_SAVED_REQUESTS {
                    return Err(invalid(
                        "saved_requests_full",
                        "You have 500 saved requests. Delete some first.",
                    ));
                }
            }
            let created_at = existing.unwrap_or_else(|| at.clone());
            tx.execute(
                "INSERT INTO http_saved_requests (id, name, method, url, request, redactions, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT (id) DO UPDATE SET name = ?2, method = ?3, url = ?4, request = ?5,
                   redactions = ?6, updated_at = ?8",
                params![
                    id,
                    name,
                    stored.method.as_str(),
                    stored.url,
                    json,
                    i64::from(redactions),
                    created_at,
                    at
                ],
            )?;
            Ok(HttpSavedRequest {
                id: id.clone(),
                name: name.clone(),
                request: stored.clone(),
                redactions,
                created_at,
                updated_at: at.clone(),
            })
        })
    }

    pub fn delete_request(&self, id: &str) -> Result<()> {
        if !is_valid_id(id) {
            return Err(invalid_id());
        }
        self.write(|tx| {
            tx.execute("DELETE FROM http_saved_requests WHERE id = ?1", [id])?;
            Ok(())
        })
    }
}

/// The migration's shape, for tests and the lead's registration check.
pub fn migration() -> &'static kalcode_core::db::Migration {
    &UTILITY_MIGRATION
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{HttpHeader, HttpMethod};

    fn ws() -> String {
        uuid::Uuid::now_v7().to_string()
    }

    #[test]
    fn migration_is_isolated_and_registration_cannot_change_its_identity() {
        let m = migration();
        assert_eq!(m.version, 14);
        if let Some(registered) = kalcode_core::db::MIGRATIONS
            .iter()
            .find(|registered| registered.version == m.version)
        {
            assert_eq!(registered.name, m.name);
            assert_eq!(registered.sql, m.sql);
        }
        let lower = m.sql.to_ascii_lowercase();
        assert!(
            !lower.contains("references"),
            "no foreign keys to other tables"
        );
        let conn = kalcode_core::db::open_in_memory().expect("db");
        conn.execute_batch(m.sql).expect("applies");
        assert!(has_schema(&conn).expect("schema"));
    }

    #[test]
    fn scratchpads_are_per_workspace() {
        let store = Store::memory().expect("store");
        assert!(!store.persistent());
        let (a, b) = (ws(), ws());
        let note = store
            .save_scratchpad(None, Some(&a), "  Plan\n", "- ship it")
            .expect("saved");
        assert_eq!(note.title, "Plan");
        store
            .save_scratchpad(None, Some(&b), "", "other")
            .expect("saved");
        store
            .save_scratchpad(None, None, "Loose", "x")
            .expect("saved");
        assert_eq!(store.scratchpads(Some(&a)).expect("list").len(), 1);
        assert_eq!(
            store.scratchpads(Some(&b)).expect("list")[0].title,
            "Untitled"
        );
        assert_eq!(store.scratchpads(None).expect("list").len(), 1);
        let edited = store
            .save_scratchpad(Some(&note.id), Some(&a), "Plan", "- shipped")
            .expect("updated");
        assert_eq!(edited.content, "- shipped");
        // Saving through another workspace can't touch it.
        assert!(
            store
                .save_scratchpad(Some(&note.id), Some(&b), "x", "y")
                .is_err()
        );
        store.delete_scratchpad(&note.id).expect("deleted");
        assert!(store.scratchpads(Some(&a)).expect("list").is_empty());
        assert!(store.scratchpads(Some("nope")).is_err());
        assert!(
            store
                .save_scratchpad(None, Some(&a), "big", &"x".repeat(MAX_SCRATCHPAD_BYTES + 1))
                .is_err()
        );
    }

    #[test]
    fn saved_requests_never_store_secrets() {
        let store = Store::memory().expect("store");
        let spec = HttpRequestSpec {
            method: HttpMethod::Get,
            url: "http://localhost:3000/api?token=abc".into(),
            query: Vec::new(),
            headers: vec![HttpHeader {
                name: "Authorization".into(),
                value: "Bearer s3cr3t-value".into(),
                sensitive: false,
            }],
            body: None,
            timeout_ms: None,
            follow_redirects: false,
        };
        let saved = store
            .save_request(None, "List items", &spec)
            .expect("saved");
        assert_eq!(saved.redactions, 2);
        let listed = store.saved_requests().expect("list");
        assert_eq!(listed.len(), 1);
        let json = serde_json::to_string(&listed).expect("json");
        assert!(!json.contains("s3cr3t-value"), "{json}");
        assert!(!json.contains("token=abc"), "{json}");
        assert_eq!(listed[0].request.headers[0].name, "Authorization");
        let renamed = store
            .save_request(Some(&saved.id), "Items", &spec)
            .expect("renamed");
        assert_eq!(renamed.created_at, saved.created_at);
        assert_eq!(store.saved_requests().expect("list")[0].name, "Items");
        store.delete_request(&saved.id).expect("deleted");
        assert!(store.saved_requests().expect("list").is_empty());
        let mut bad = spec.clone();
        bad.url = "ftp://x".into();
        assert!(store.save_request(None, "bad", &bad).is_err());
    }
}
