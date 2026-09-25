//! Where the rail and locator tables live.
//!
//! With schema v10 installed ([`crate::RAIL_LOCATOR_MIGRATION`], registered by the lead at
//! integration) they are tables of KalCode's database: writes go through the core's single writer
//! ([`Core::write_with_events`], so a future `workspace.updated` event commits with the change) and
//! reads through its read-only WAL connection ([`Core::reader`]). Before v10 is registered — this
//! branch's development builds — the same SQL runs in a private in-memory database, so every
//! feature works for the session and nothing is written to the user's database under a schema
//! version it doesn't know. [`Store::persistent`] tells the UI which case it is.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use kalcode_core::db::Migration;
use kalcode_core::{Core, KalError, Result};
use rusqlite::{Connection, OptionalExtension, Transaction};

use crate::RAIL_LOCATOR_MIGRATION;

pub enum Store {
    /// Tables in KalCode's database (schema v10 applied).
    Core(Arc<Core>),
    /// Tables in a private in-memory database for this session.
    Memory(Mutex<Connection>),
}

/// True when schema v10's tables exist in `conn`'s database.
pub fn has_schema(conn: &Connection) -> Result<bool> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspace_rail'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    Ok(found.is_some())
}

impl Store {
    /// Uses KalCode's database when v10 is installed, otherwise a session-only database.
    pub fn open(core: &Arc<Core>) -> Result<Self> {
        if has_schema(&core.reader())? {
            return Ok(Self::Core(Arc::clone(core)));
        }
        tracing::warn!(
            event = "locator.session_only_store",
            "schema v10 is not installed; rail changes and the search index last for this session"
        );
        Self::memory()
    }

    /// A private in-memory database with the v10 tables.
    pub fn memory() -> Result<Self> {
        let conn = kalcode_core::db::open_in_memory()?;
        conn.execute_batch(RAIL_LOCATOR_MIGRATION.sql)?;
        Ok(Self::Memory(Mutex::new(conn)))
    }

    pub fn persistent(&self) -> bool {
        matches!(self, Self::Core(_))
    }

    fn memory_conn(conn: &Mutex<Connection>) -> MutexGuard<'_, Connection> {
        conn.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Runs `read` on a connection that sees committed data (the core's read-only connection).
    pub fn read<T>(&self, read: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        match self {
            Self::Core(core) => read(&core.reader()),
            Self::Memory(conn) => read(&Self::memory_conn(conn)),
        }
    }

    /// Runs `write` in one transaction on the writer.
    pub fn write<T>(&self, write: impl FnOnce(&Transaction<'_>) -> Result<T>) -> Result<T> {
        match self {
            Self::Core(core) => core
                .write_with_events(|tx| Ok((write(tx)?, Vec::new())))
                .map(|(value, _)| value),
            Self::Memory(conn) => {
                let mut conn = Self::memory_conn(conn);
                let tx = conn.transaction()?;
                let value = write(&tx)?;
                tx.commit()?;
                Ok(value)
            }
        }
    }
}

/// The migration's shape, for tests and the lead's registration check.
pub fn migration() -> &'static Migration {
    &RAIL_LOCATOR_MIGRATION
}

pub(crate) fn invalid_id() -> KalError {
    KalError::validation("invalid_id", "That id isn't valid.")
}
