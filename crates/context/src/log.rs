//! The firewall decision log (FW-03): every block, redaction, override and prompt warning.
//!
//! Design:
//!
//! * **Append-only.** The trait has no update or delete. The SQLite table
//!   (`context_firewall_log`, migration v8) has triggers that abort any `UPDATE` or `DELETE`, so
//!   not even KalCode's own code can rewrite history.
//! * **No content.** Entries hold rule codes, detector ids, counts, byte offsets, canonical
//!   workspace-relative paths and hashes — never file contents, secret values or excerpts. Tests
//!   assert that a logged package contains none of its secrets.
//! * **Ordered.** `seq` is assigned by the store; ids are UUIDv7, so they also sort by time.
//! * **Allow is not logged** (it is the absence of a rule); the package record already lists
//!   what was sent.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::Result;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogAction {
    Blocked,
    Redacted,
    OverriddenByUser,
    Warned,
}

impl LogAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Blocked => "blocked",
            Self::Redacted => "redacted",
            Self::OverriddenByUser => "overridden_by_user",
            Self::Warned => "warned",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FirewallLogEntry {
    pub id: String,
    pub occurred_at: String,
    pub package_id: String,
    /// Item position, or `None` for package-level entries (prompt warnings).
    pub position: Option<u32>,
    /// [`crate::model::FirewallRule::code`].
    pub rule: String,
    pub action: LogAction,
    /// Structured facts (JSON object). Never content.
    pub detail: serde_json::Value,
}

/// Where decision-log entries go.
pub trait DecisionLog: Send + Sync {
    fn append(&self, entries: &[FirewallLogEntry]) -> Result<()>;
}

/// In-memory log for tests and for callers without a database.
#[derive(Debug, Default)]
pub struct MemoryDecisionLog {
    entries: Mutex<Vec<FirewallLogEntry>>,
}

impl MemoryDecisionLog {
    pub fn entries(&self) -> Vec<FirewallLogEntry> {
        self.entries.lock().map(|e| e.clone()).unwrap_or_default()
    }
}

impl DecisionLog for MemoryDecisionLog {
    fn append(&self, entries: &[FirewallLogEntry]) -> Result<()> {
        if let Ok(mut log) = self.entries.lock() {
            log.extend_from_slice(entries);
        }
        Ok(())
    }
}
