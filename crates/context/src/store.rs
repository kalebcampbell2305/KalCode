//! SQLite persistence for context schemas v8 and v18.
//!
//! The migrations are registered in `kalcode_core::db::MIGRATIONS` as v8 and v18; their SQL lives
//! in `crates/native-core/migrations` (native-core cannot depend on this crate), and this module
//! re-exports the typed core constants. Every function here takes a `rusqlite::Connection` so it
//! works on the core's writer connection.
//!
//! Stored: package headers, item *references* (kind, redacted owner-visible path label, line range,
//! redacted label, size, verdict), the append-only decision log, and never-share patterns.
//! Never stored: item content, excerpts, secret values.

use rusqlite::{Connection, OptionalExtension, params};

use crate::error::{ContextError, Result};
use crate::log::{DecisionLog, FirewallLogEntry};
use crate::model::Sensitivity;
use crate::never_share::{NeverSharePattern, PatternScope, validate_pattern};
use crate::package::{ContextPackage, ItemSource};

/// Schema v8 (CTX/FW), registered in `kalcode_core::db::MIGRATIONS`.
pub use kalcode_core::db::CONTEXT_MIGRATION as MIGRATION_V8;

/// Schema v18: durable one-shot delivery authority and interrupted-send recovery evidence.
pub use kalcode_core::db::CONTEXT_DELIVERY_MIGRATION as MIGRATION_V18;

/// Compatibility alias for the pre-registration draft constant. The canonical authority is the
/// typed [`MIGRATION_V18`] entry in native-core's ordered registry.
#[deprecated(note = "use the typed MIGRATION_V18 migration")]
pub const MIGRATION_V18_DRAFT: &str = MIGRATION_V18.sql;

/// Lifecycle status of a stored package.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackageStatus {
    Previewed,
    Sent,
    Discarded,
    Blocked,
}

/// Durable one-shot delivery state introduced by schema v18.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeliveryState {
    Sending,
    Sent,
    FailedUncertain,
}

impl DeliveryState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Sending => "sending",
            Self::Sent => "sent",
            Self::FailedUncertain => "failed_uncertain",
        }
    }

    fn parse(value: &str) -> Result<Self> {
        match value {
            "sending" => Ok(Self::Sending),
            "sent" => Ok(Self::Sent),
            "failed_uncertain" => Ok(Self::FailedUncertain),
            _ => Err(ContextError::DeliveryState),
        }
    }
}

impl PackageStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Previewed => "previewed",
            Self::Sent => "sent",
            Self::Discarded => "discarded",
            Self::Blocked => "blocked",
        }
    }
}

/// Inserts or updates a previewed package and replaces its item references.
pub fn save_preview(conn: &mut Connection, package: &ContextPackage) -> Result<()> {
    let tx = conn.transaction()?;
    save_preview_in(&tx, package)?;
    tx.commit()?;
    Ok(())
}

/// Inserts or updates a previewed package on a caller-owned transaction/connection.
///
/// This is the variant IPC and service layers use from `Core::write_with_events`, so package
/// references, firewall facts and their public events can commit atomically.
pub fn save_preview_in(conn: &Connection, package: &ContextPackage) -> Result<()> {
    let preview = package.preview();
    conn.execute(
        "INSERT INTO context_packages
           (id, workspace_id, purpose, target_thread_id, target_provider_id, status,
            content_sha256, total_bytes, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'previewed', ?6, ?7, ?8)
         ON CONFLICT (id) DO UPDATE SET
           content_sha256 = excluded.content_sha256,
           total_bytes = excluded.total_bytes",
        params![
            package.id,
            package.options.workspace_id,
            package.options.purpose.as_str(),
            package.options.target_thread_id,
            package.capabilities.provider_id,
            package.content_sha256(),
            preview.total_bytes as i64,
            package.created_at,
        ],
    )?;
    conn.execute(
        "DELETE FROM context_items WHERE package_id = ?1",
        params![package.id],
    )?;
    {
        let mut insert = conn.prepare(
            "INSERT INTO context_items
               (package_id, position, source, bytes, sensitivity, verdict, redactions, included)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )?;
        for item in &package.items {
            let (path, lines) = match &item.item.source {
                ItemSource::WorkspaceFile { lines, .. } => {
                    (item.decision.relative_path.clone(), *lines)
                }
                ItemSource::FolderListing { path, .. } => (Some(path.clone()), None),
                _ => (None, None),
            };
            // A filename is user-controlled metadata and can itself contain a credential. The
            // live package keeps the canonical path for its send-time re-open; the durable
            // audit reference keeps only a safe owner-visible label.
            let path = path.map(|value| crate::package::sanitize_label(&value));
            let source = serde_json::json!({
                "kind": item.item.kind,
                "sourceKind": item.item.source.kind(),
                "origin": item.item.origin,
                "path": path,
                "lines": lines,
                "label": crate::package::sanitize_label(&item.item.label),
                "missionId": item.item.mission_id,
                "bytes": item.bytes,
            });
            insert.execute(params![
                package.id,
                item.position,
                serde_json::to_string(&source)?,
                item.bytes as i64,
                item.decision.sensitivity.as_str(),
                item.decision.verdict.as_str(),
                item.decision.redaction_count(),
                i64::from(item.included),
            ])?;
        }
    }
    Ok(())
}

/// Moves a previewed package to a final status. Finished packages are immutable (trigger).
pub fn finish_package(
    conn: &Connection,
    package_id: &str,
    status: PackageStatus,
    at: &str,
) -> Result<()> {
    let changed = conn.execute(
        "UPDATE context_packages SET status = ?2, sent_at = CASE WHEN ?2 = 'sent' THEN ?3 ELSE sent_at END
         WHERE id = ?1 AND status = 'previewed'",
        params![package_id, status.as_str(), at],
    )?;
    if changed == 0 {
        return Err(ContextError::NotFound);
    }
    Ok(())
}

pub fn package_status(conn: &Connection, package_id: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT status FROM context_packages WHERE id = ?1",
            params![package_id],
            |row| row.get(0),
        )
        .optional()?)
}

/// Atomically claims a previewed package for its only delivery attempt.
///
/// The v18 table is intentionally referenced directly: if the migration is absent, SQLite
/// returns an error and delivery fails closed.
pub fn claim_delivery(
    conn: &Connection,
    package_id: &str,
    target_account_id: Option<&str>,
    claimed_at: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO context_delivery_attempts
           (package_id, state, target_account_id, claimed_at, finished_at)
         SELECT id, 'sending', ?2, ?3, NULL
           FROM context_packages
          WHERE id = ?1 AND status = 'previewed'",
        params![package_id, target_account_id, claimed_at],
    )
    .and_then(|changed| {
        if changed == 1 {
            Ok(changed)
        } else {
            Err(rusqlite::Error::QueryReturnedNoRows)
        }
    })?;
    Ok(())
}

/// Finalizes a claimed delivery. Final rows are immutable and cannot be replayed.
pub fn finish_delivery(
    conn: &Connection,
    package_id: &str,
    state: DeliveryState,
    finished_at: &str,
) -> Result<()> {
    if state == DeliveryState::Sending {
        return Err(ContextError::DeliveryState);
    }
    let changed = conn.execute(
        "UPDATE context_delivery_attempts
            SET state = ?2, finished_at = ?3
          WHERE package_id = ?1 AND state = 'sending'",
        params![package_id, state.as_str(), finished_at],
    )?;
    if changed != 1 {
        return Err(ContextError::DeliveryState);
    }
    Ok(())
}

/// On startup, unresolved `sending` attempts become uncertain. They are never replayed because
/// source content is intentionally not durable.
pub fn recover_sending_deliveries(conn: &Connection, finished_at: &str) -> Result<usize> {
    let valid_timestamp: i64 = conn.query_row(
        "SELECT length(?1) = 24
             AND strftime('%Y-%m-%dT%H:%M:%fZ', ?1) IS ?1",
        params![finished_at],
        |row| row.get(0),
    )?;
    if valid_timestamp != 1 {
        return Err(ContextError::DeliveryState);
    }
    Ok(conn.execute(
        "UPDATE context_delivery_attempts
            SET state = 'failed_uncertain',
                finished_at = CASE
                  WHEN ?1 < claimed_at THEN claimed_at
                  ELSE ?1
                END
          WHERE state = 'sending'",
        params![finished_at],
    )?)
}

pub fn delivery_state(conn: &Connection, package_id: &str) -> Result<Option<DeliveryState>> {
    conn.query_row(
        "SELECT state FROM context_delivery_attempts WHERE package_id = ?1",
        params![package_id],
        |row| row.get::<_, String>(0),
    )
    .optional()?
    .map(|state| DeliveryState::parse(&state))
    .transpose()
}

/// The decision log on a SQLite connection (v8 `context_firewall_log`).
pub struct SqliteDecisionLog<'c> {
    conn: std::sync::Mutex<&'c mut Connection>,
}

impl<'c> SqliteDecisionLog<'c> {
    pub fn new(conn: &'c mut Connection) -> Self {
        Self {
            conn: std::sync::Mutex::new(conn),
        }
    }
}

impl DecisionLog for SqliteDecisionLog<'_> {
    fn append(&self, entries: &[FirewallLogEntry]) -> Result<()> {
        let mut guard = self
            .conn
            .lock()
            .map_err(|_| ContextError::Io(std::io::Error::other("decision log lock poisoned")))?;
        append_log(&mut guard, entries)
    }
}

/// Appends entries in one transaction.
pub fn append_log(conn: &mut Connection, entries: &[FirewallLogEntry]) -> Result<()> {
    let tx = conn.transaction()?;
    append_log_in(&tx, entries)?;
    tx.commit()?;
    Ok(())
}

/// Appends decision facts on a caller-owned transaction/connection.
///
/// Entries contain rule codes, counts and redacted canonical references only. The context crate
/// never persists excerpts or source content here.
pub fn append_log_in(conn: &Connection, entries: &[FirewallLogEntry]) -> Result<()> {
    {
        let mut insert = conn.prepare(
            "INSERT INTO context_firewall_log (id, occurred_at, package_id, position, rule, action, detail)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )?;
        for entry in entries {
            insert.execute(params![
                entry.id,
                entry.occurred_at,
                entry.package_id,
                entry.position,
                entry.rule,
                entry.action.as_str(),
                serde_json::to_string(&entry.detail)?,
            ])?;
        }
    }
    Ok(())
}

/// Log rows for a package, in order: `(rule, action, detail JSON)`.
pub fn log_for_package(
    conn: &Connection,
    package_id: &str,
) -> Result<Vec<(String, String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT rule, action, detail FROM context_firewall_log WHERE package_id = ?1 ORDER BY seq",
    )?;
    let rows = stmt
        .query_map(params![package_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Never-share patterns for a scope.
pub fn never_share_list(conn: &Connection, scope: &PatternScope) -> Result<Vec<NeverSharePattern>> {
    let mut stmt = conn.prepare(
        "SELECT pattern, sensitivity FROM context_never_share WHERE scope_id = ?1 ORDER BY pattern",
    )?;
    let rows = stmt
        .query_map(params![scope.scope_id()], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows
        .into_iter()
        .map(|(pattern, sensitivity)| NeverSharePattern {
            scope: scope.clone(),
            pattern,
            sensitivity: if sensitivity == "secret" {
                Sensitivity::Secret
            } else {
                Sensitivity::Confidential
            },
        })
        .collect())
}

/// Patterns that apply to a workspace: global ones plus the workspace's own.
pub fn never_share_for_workspace(
    conn: &Connection,
    workspace_id: &str,
) -> Result<Vec<NeverSharePattern>> {
    let mut out = never_share_list(conn, &PatternScope::Global)?;
    out.extend(never_share_list(
        conn,
        &PatternScope::Workspace {
            workspace_id: workspace_id.to_owned(),
        },
    )?);
    Ok(out)
}

/// Replaces a scope's patterns (validated first; nothing is written if one is invalid).
pub fn never_share_set(
    conn: &mut Connection,
    scope: &PatternScope,
    patterns: &[(String, Sensitivity)],
    at: &str,
) -> Result<()> {
    for (pattern, _) in patterns {
        validate_pattern(pattern)?;
    }
    let tx = conn.transaction()?;
    tx.execute(
        "DELETE FROM context_never_share WHERE scope_id = ?1",
        params![scope.scope_id()],
    )?;
    {
        let mut insert = tx.prepare(
            "INSERT OR REPLACE INTO context_never_share (scope_id, pattern, sensitivity, created_at)
             VALUES (?1, ?2, ?3, ?4)",
        )?;
        for (pattern, sensitivity) in patterns {
            let level = if *sensitivity >= Sensitivity::Secret {
                "secret"
            } else {
                "confidential"
            };
            insert.execute(params![scope.scope_id(), pattern.trim(), level, at])?;
        }
    }
    tx.commit()?;
    Ok(())
}
