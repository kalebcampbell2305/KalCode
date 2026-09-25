//! Storage for migration v10 (`notifications`) and the policy that decides whether an event
//! creates a row, re-raises one, or is dropped.
//!
//! [`NOTIFICATIONS_MIGRATION`] is registered in `kalcode_core::db::MIGRATIONS` (v10); the SQL lives
//! in native-core because native-core cannot depend on this crate. A database without the table
//! (an older build's) falls back to the in-memory table (see `center.rs`).
//!
//! Both backends implement [`Table`], and the policy ([`raise`], [`settle`], [`mark`], [`list`])
//! is written once over it, so they behave identically. Parameterized SQL only.

use std::collections::VecDeque;

use kalcode_contracts::ids::{is_valid_id, new_id};
use kalcode_contracts::notifications::{
    Notification, NotificationEntityKind, NotificationKind, NotificationMark, NotificationPage,
    Severity,
};
use kalcode_core::db::Migration;
use kalcode_core::time::format_rfc3339;
use kalcode_core::{KalError, Result};
use rusqlite::{Connection, OptionalExtension, Row, params};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::derive::{Draft, recovery_title};

/// Migration v10 (campaign Z7-W3), registered in `kalcode_core::db::MIGRATIONS`.
pub use kalcode_core::db::NOTIFICATIONS_MIGRATION;

/// Rows kept; older ones are deleted when a new row is created.
pub const RETENTION: usize = 500;
/// A repeat of the same notification within this window re-raises it (even if already read).
pub const COOLDOWN_SECS: i64 = 10;
/// New rows allowed per rolling window.
pub const BUDGET_ROWS: usize = 30;
pub const BUDGET_WINDOW_SECS: i64 = 60;
/// Largest `notification_list` page.
pub const MAX_PAGE: u32 = 200;
/// Most ids in one `notification_mark`.
pub const MAX_MARK_IDS: usize = 500;
const MAX_CURSOR_CHARS: usize = 128;

/// What identifies "the same" notification for coalescing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Key {
    pub kind: NotificationKind,
    pub entity_kind: Option<NotificationEntityKind>,
    pub entity_id: Option<String>,
}

impl Key {
    fn of(draft: &Draft) -> Self {
        Self {
            kind: draft.kind,
            entity_kind: draft.entity_kind,
            entity_id: draft.entity_id.clone(),
        }
    }
}

/// A stored row (a listed notification plus whether it was dismissed).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stored {
    pub notification: Notification,
    pub dismissed: bool,
}

/// Where rows live. Implemented by the SQLite table (inside one transaction) and by the
/// in-memory fallback.
pub trait Table {
    /// The most recently raised, undismissed row with `key`.
    fn latest_open(&mut self, key: &Key) -> Result<Option<Notification>>;
    fn insert(&mut self, row: &Notification) -> Result<()>;
    /// Re-raises a row: new title/body/count/updated_at, unread again.
    fn reraise(&mut self, row: &Notification) -> Result<()>;
    /// Deletes all but the newest `keep` rows.
    fn prune(&mut self, keep: usize) -> Result<()>;
    /// Undismissed rows ordered by `updated_at DESC, id DESC`, strictly after `before`.
    fn page(
        &mut self,
        unread_only: bool,
        limit: usize,
        before: Option<&(String, String)>,
    ) -> Result<Vec<Notification>>;
    fn unread_count(&mut self) -> Result<u32>;
    /// Applies `mark` to `ids` (`None`: every undismissed row). Returns rows changed.
    fn mark(&mut self, ids: Option<&[String]>, mark: NotificationMark, now: &str) -> Result<u32>;
    /// Marks unread, undismissed rows with `key` read. Returns rows changed.
    fn settle(&mut self, key: &Key, now: &str) -> Result<u32>;
}

/// The rolling budget for new rows.
#[derive(Debug, Default)]
pub struct Budget {
    created: VecDeque<OffsetDateTime>,
    /// Rows dropped over the budget since the center started.
    pub suppressed: u64,
    warned_until: Option<OffsetDateTime>,
}

impl Budget {
    fn admit(&mut self, now: OffsetDateTime) -> bool {
        let window = time::Duration::seconds(BUDGET_WINDOW_SECS);
        while self.created.front().is_some_and(|t| now - *t >= window) {
            self.created.pop_front();
        }
        if self.created.len() < BUDGET_ROWS {
            self.created.push_back(now);
            return true;
        }
        self.suppressed += 1;
        if self.warned_until.is_none_or(|until| now >= until) {
            self.warned_until = Some(now + window);
            tracing::warn!(
                event = "notifications.rate_limited",
                limit = BUDGET_ROWS,
                window_secs = BUDGET_WINDOW_SECS,
                suppressed_total = self.suppressed
            );
        }
        false
    }
}

fn parse_time(value: &str) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(value, &Rfc3339).ok()
}

/// Raises `draft`: coalesces it into an open row with the same key (or re-raises a read one
/// inside the cooldown), else creates a row if the budget allows. Returns the notification to
/// announce (`notification.created`), or `None` when it was dropped.
pub fn raise(
    table: &mut dyn Table,
    budget: &mut Budget,
    draft: &Draft,
    now: OffsetDateTime,
) -> Result<Option<Notification>> {
    let stamp = format_rfc3339(now);
    let key = Key::of(draft);
    if let Some(mut existing) = table.latest_open(&key)? {
        let recent = parse_time(&existing.updated_at)
            .is_some_and(|at| now - at < time::Duration::seconds(COOLDOWN_SECS) && now >= at);
        if existing.read_at.is_none() || recent {
            existing.count = existing.count.saturating_add(1);
            existing.title = if draft.kind == NotificationKind::RecoveryAvailable {
                recovery_title(existing.count)
            } else {
                draft.title.clone()
            };
            existing.body.clone_from(&draft.body);
            existing.severity = draft.severity;
            if draft.workspace_id.is_some() {
                existing.workspace_id.clone_from(&draft.workspace_id);
            }
            existing.updated_at = stamp;
            existing.read_at = None;
            table.reraise(&existing)?;
            return Ok(Some(existing));
        }
    }
    if !budget.admit(now) {
        return Ok(None);
    }
    let row = Notification {
        id: new_id(),
        kind: draft.kind,
        severity: draft.severity,
        title: draft.title.clone(),
        body: draft.body.clone(),
        entity_kind: draft.entity_kind,
        entity_id: draft.entity_id.clone(),
        workspace_id: draft.workspace_id.clone(),
        created_at: stamp.clone(),
        updated_at: stamp,
        read_at: None,
        count: 1,
    };
    table.insert(&row)?;
    table.prune(RETENTION)?;
    Ok(Some(row))
}

/// Marks the unread notifications for `key` read (handled elsewhere).
pub fn settle(table: &mut dyn Table, key: &Key, now: OffsetDateTime) -> Result<u32> {
    table.settle(key, &format_rfc3339(now))
}

fn invalid(code: &'static str, message: &str) -> KalError {
    KalError::validation(code, message)
}

fn encode_cursor(row: &Notification) -> String {
    format!("{}|{}", row.updated_at, row.id)
}

fn decode_cursor(cursor: &str) -> Result<(String, String)> {
    let bad = || invalid("invalid_cursor", "That page cursor isn't valid.");
    if cursor.chars().count() > MAX_CURSOR_CHARS {
        return Err(bad());
    }
    let (at, id) = cursor.split_once('|').ok_or_else(bad)?;
    if parse_time(at).is_none() || !is_valid_id(id) {
        return Err(bad());
    }
    Ok((at.to_owned(), id.to_owned()))
}

/// One page of the center, newest first.
pub fn list(
    table: &mut dyn Table,
    unread_only: bool,
    limit: u32,
    before: Option<&str>,
) -> Result<NotificationPage> {
    if limit == 0 || limit > MAX_PAGE {
        return Err(invalid(
            "invalid_page_size",
            "Page size must be between 1 and 200.",
        ));
    }
    let cursor = before.map(decode_cursor).transpose()?;
    let limit = usize::try_from(limit).unwrap_or(usize::MAX);
    // One extra row tells whether another page exists.
    let mut rows = table.page(unread_only, limit + 1, cursor.as_ref())?;
    let more = rows.len() > limit;
    rows.truncate(limit);
    let next_cursor = if more {
        rows.last().map(encode_cursor)
    } else {
        None
    };
    Ok(NotificationPage {
        notifications: rows,
        next_cursor,
        unread_count: table.unread_count()?,
    })
}

/// Marks notifications read, unread or dismissed (`ids: None` = every undismissed one).
pub fn mark(
    table: &mut dyn Table,
    ids: Option<&[String]>,
    mark: NotificationMark,
    now: OffsetDateTime,
) -> Result<u32> {
    if let Some(ids) = ids {
        if ids.len() > MAX_MARK_IDS {
            return Err(invalid(
                "too_many_ids",
                "Mark at most 500 notifications at once.",
            ));
        }
        if !ids.iter().all(|id| is_valid_id(id)) {
            return Err(invalid("invalid_id", "That id isn't valid."));
        }
        if ids.is_empty() {
            return Ok(0);
        }
    }
    table.mark(ids, mark, &format_rfc3339(now))
}

// ---------- SQLite ----------

/// Whether the `notifications` table exists (v10 applied).
pub fn table_exists(conn: &Connection) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'notifications'",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

const COLUMNS: &str = "id, kind, severity, title, body, entity_kind, entity_id, workspace_id, created_at, updated_at, read_at, count";

fn row_to_notification(row: &Row<'_>) -> rusqlite::Result<Option<Notification>> {
    let kind: String = row.get(1)?;
    let severity: String = row.get(2)?;
    let entity_kind: Option<String> = row.get(5)?;
    let count: i64 = row.get(11)?;
    let (Some(kind), Some(severity)) = (NotificationKind::parse(&kind), Severity::parse(&severity))
    else {
        // Written by a newer build: not shown by this one.
        return Ok(None);
    };
    Ok(Some(Notification {
        id: row.get(0)?,
        kind,
        severity,
        title: row.get(3)?,
        body: row.get(4)?,
        entity_kind: entity_kind
            .as_deref()
            .and_then(NotificationEntityKind::parse),
        entity_id: row.get(6)?,
        workspace_id: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        read_at: row.get(10)?,
        count: u32::try_from(count).unwrap_or(1).max(1),
    }))
}

/// The v10 table over a connection or transaction supplied by `Core`.
pub struct SqlTable<'c>(pub &'c Connection);

impl Table for SqlTable<'_> {
    fn latest_open(&mut self, key: &Key) -> Result<Option<Notification>> {
        let found = self
            .0
            .query_row(
                &format!(
                    "SELECT {COLUMNS} FROM notifications
                     WHERE kind = ?1 AND entity_kind IS ?2 AND entity_id IS ?3 AND dismissed_at IS NULL
                     ORDER BY updated_at DESC, id DESC LIMIT 1"
                ),
                params![
                    key.kind.as_str(),
                    key.entity_kind.map(NotificationEntityKind::as_str),
                    key.entity_id
                ],
                row_to_notification,
            )
            .optional()?;
        Ok(found.flatten())
    }

    fn insert(&mut self, row: &Notification) -> Result<()> {
        self.0.execute(
            &format!(
                "INSERT INTO notifications ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)"
            ),
            params![
                row.id,
                row.kind.as_str(),
                row.severity.as_str(),
                row.title,
                row.body,
                row.entity_kind.map(NotificationEntityKind::as_str),
                row.entity_id,
                row.workspace_id,
                row.created_at,
                row.updated_at,
                row.read_at,
                i64::from(row.count),
            ],
        )?;
        Ok(())
    }

    fn reraise(&mut self, row: &Notification) -> Result<()> {
        self.0.execute(
            "UPDATE notifications SET severity = ?2, title = ?3, body = ?4, workspace_id = ?5,
               updated_at = ?6, read_at = NULL, count = ?7
             WHERE id = ?1",
            params![
                row.id,
                row.severity.as_str(),
                row.title,
                row.body,
                row.workspace_id,
                row.updated_at,
                i64::from(row.count),
            ],
        )?;
        Ok(())
    }

    fn prune(&mut self, keep: usize) -> Result<()> {
        self.0.execute(
            "DELETE FROM notifications WHERE id NOT IN
               (SELECT id FROM notifications ORDER BY updated_at DESC, id DESC LIMIT ?1)",
            [i64::try_from(keep).unwrap_or(i64::MAX)],
        )?;
        Ok(())
    }

    fn page(
        &mut self,
        unread_only: bool,
        limit: usize,
        before: Option<&(String, String)>,
    ) -> Result<Vec<Notification>> {
        let (at, id) = before.map_or((None, None), |(a, i)| (Some(a.as_str()), Some(i.as_str())));
        let mut stmt = self.0.prepare(&format!(
            "SELECT {COLUMNS} FROM notifications
             WHERE dismissed_at IS NULL
               AND (?1 = 0 OR read_at IS NULL)
               AND (?2 IS NULL OR updated_at < ?2 OR (updated_at = ?2 AND id < ?3))
             ORDER BY updated_at DESC, id DESC
             LIMIT ?4"
        ))?;
        let rows = stmt.query_map(
            params![
                i64::from(unread_only),
                at,
                id,
                i64::try_from(limit).unwrap_or(i64::MAX)
            ],
            row_to_notification,
        )?;
        let mut out = Vec::new();
        for row in rows {
            if let Some(n) = row? {
                out.push(n);
            }
        }
        Ok(out)
    }

    fn unread_count(&mut self) -> Result<u32> {
        let n: i64 = self.0.query_row(
            "SELECT COUNT(*) FROM notifications WHERE read_at IS NULL AND dismissed_at IS NULL",
            [],
            |row| row.get(0),
        )?;
        Ok(u32::try_from(n).unwrap_or(u32::MAX))
    }

    fn mark(&mut self, ids: Option<&[String]>, mark: NotificationMark, now: &str) -> Result<u32> {
        let set = match mark {
            NotificationMark::Read => "read_at = ?1 WHERE read_at IS NULL AND dismissed_at IS NULL",
            NotificationMark::Unread => {
                "read_at = NULL WHERE read_at IS NOT NULL AND dismissed_at IS NULL AND ?1 IS NOT NULL"
            }
            NotificationMark::Dismissed => {
                "dismissed_at = ?1, read_at = COALESCE(read_at, ?1) WHERE dismissed_at IS NULL"
            }
        };
        let mut changed = 0usize;
        match ids {
            None => {
                changed += self
                    .0
                    .execute(&format!("UPDATE notifications SET {set}"), [now])?;
            }
            Some(ids) => {
                let sql = format!("UPDATE notifications SET {set} AND id = ?2");
                let mut stmt = self.0.prepare(&sql)?;
                for id in ids {
                    changed += stmt.execute(params![now, id])?;
                }
            }
        }
        Ok(u32::try_from(changed).unwrap_or(u32::MAX))
    }

    fn settle(&mut self, key: &Key, now: &str) -> Result<u32> {
        let changed = self.0.execute(
            "UPDATE notifications SET read_at = ?4
             WHERE kind = ?1 AND entity_kind IS ?2 AND entity_id IS ?3
               AND read_at IS NULL AND dismissed_at IS NULL",
            params![
                key.kind.as_str(),
                key.entity_kind.map(NotificationEntityKind::as_str),
                key.entity_id,
                now
            ],
        )?;
        Ok(u32::try_from(changed).unwrap_or(u32::MAX))
    }
}

// ---------- In memory (a database without the v10 table) ----------

/// The same table, bounded to [`RETENTION`] rows, kept in memory.
#[derive(Debug, Default)]
pub struct MemoryTable {
    rows: Vec<Stored>,
}

impl MemoryTable {
    fn sorted_open(&self) -> impl Iterator<Item = &Stored> {
        let mut open: Vec<&Stored> = self.rows.iter().filter(|r| !r.dismissed).collect();
        open.sort_by(|a, b| order(&b.notification, &a.notification));
        open.into_iter()
    }
}

fn order(a: &Notification, b: &Notification) -> std::cmp::Ordering {
    a.updated_at
        .cmp(&b.updated_at)
        .then_with(|| a.id.cmp(&b.id))
}

impl Table for MemoryTable {
    fn latest_open(&mut self, key: &Key) -> Result<Option<Notification>> {
        Ok(self
            .sorted_open()
            .find(|r| {
                r.notification.kind == key.kind
                    && r.notification.entity_kind == key.entity_kind
                    && r.notification.entity_id == key.entity_id
            })
            .map(|r| r.notification.clone()))
    }

    fn insert(&mut self, row: &Notification) -> Result<()> {
        self.rows.push(Stored {
            notification: row.clone(),
            dismissed: false,
        });
        Ok(())
    }

    fn reraise(&mut self, row: &Notification) -> Result<()> {
        if let Some(stored) = self.rows.iter_mut().find(|r| r.notification.id == row.id) {
            stored.notification = row.clone();
        }
        Ok(())
    }

    fn prune(&mut self, keep: usize) -> Result<()> {
        if self.rows.len() > keep {
            self.rows
                .sort_by(|a, b| order(&b.notification, &a.notification));
            self.rows.truncate(keep);
        }
        Ok(())
    }

    fn page(
        &mut self,
        unread_only: bool,
        limit: usize,
        before: Option<&(String, String)>,
    ) -> Result<Vec<Notification>> {
        Ok(self
            .sorted_open()
            .map(|r| &r.notification)
            .filter(|n| !unread_only || n.read_at.is_none())
            .filter(|n| {
                before.is_none_or(|(at, id)| {
                    n.updated_at.as_str() < at.as_str()
                        || (n.updated_at == *at && n.id.as_str() < id.as_str())
                })
            })
            .take(limit)
            .cloned()
            .collect())
    }

    fn unread_count(&mut self) -> Result<u32> {
        let n = self
            .rows
            .iter()
            .filter(|r| !r.dismissed && r.notification.read_at.is_none())
            .count();
        Ok(u32::try_from(n).unwrap_or(u32::MAX))
    }

    fn mark(&mut self, ids: Option<&[String]>, mark: NotificationMark, now: &str) -> Result<u32> {
        let mut changed = 0u32;
        for row in self
            .rows
            .iter_mut()
            .filter(|r| ids.is_none_or(|ids| ids.contains(&r.notification.id)))
        {
            if row.dismissed {
                continue;
            }
            let n = &mut row.notification;
            let did = match mark {
                NotificationMark::Read if n.read_at.is_none() => {
                    n.read_at = Some(now.to_owned());
                    true
                }
                NotificationMark::Unread if n.read_at.is_some() => {
                    n.read_at = None;
                    true
                }
                NotificationMark::Dismissed => {
                    row.dismissed = true;
                    if n.read_at.is_none() {
                        n.read_at = Some(now.to_owned());
                    }
                    true
                }
                _ => false,
            };
            changed += u32::from(did);
        }
        Ok(changed)
    }

    fn settle(&mut self, key: &Key, now: &str) -> Result<u32> {
        let mut changed = 0u32;
        for row in self.rows.iter_mut().filter(|r| {
            !r.dismissed
                && r.notification.read_at.is_none()
                && r.notification.kind == key.kind
                && r.notification.entity_kind == key.entity_kind
                && r.notification.entity_id == key.entity_id
        }) {
            row.notification.read_at = Some(now.to_owned());
            changed += 1;
        }
        Ok(changed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::derive::RECOVERY_BODY;

    pub(crate) fn migrated() -> Connection {
        let mut conn = kalcode_core::db::open_in_memory().expect("db");
        kalcode_core::db::migrate(&mut conn, &with_notifications(), None).expect("migrate");
        conn
    }

    /// Every registered migration (v10 `notifications` included).
    pub(crate) fn with_notifications() -> Vec<Migration> {
        kalcode_core::db::MIGRATIONS.to_vec()
    }

    fn t0() -> OffsetDateTime {
        OffsetDateTime::parse("2026-09-25T10:00:00.000Z", &Rfc3339).expect("t0")
    }

    fn secs(n: i64) -> OffsetDateTime {
        t0() + time::Duration::seconds(n)
    }

    fn draft(kind: NotificationKind, entity: Option<&str>) -> Draft {
        Draft {
            kind,
            severity: Severity::Info,
            title: format!("{} title", kind.as_str()),
            body: "body".into(),
            entity_kind: entity.map(|_| NotificationEntityKind::Thread),
            entity_id: entity.map(str::to_owned),
            workspace_id: None,
        }
    }

    /// The policy scenario, run against any backend.
    fn policy_scenario(table: &mut dyn Table) {
        let mut budget = Budget::default();
        let a = draft(NotificationKind::ThreadCompleted, Some("t1"));
        let first = raise(table, &mut budget, &a, secs(0))
            .expect("raise")
            .expect("created");
        assert_eq!(first.count, 1);
        // Unread repeat: coalesced into the same row.
        let again = raise(table, &mut budget, &a, secs(30))
            .expect("raise")
            .expect("coalesced");
        assert_eq!(again.id, first.id);
        assert_eq!(again.count, 2);
        // Read, then repeated within the cooldown: re-raised as unread.
        mark(
            table,
            Some(std::slice::from_ref(&first.id)),
            NotificationMark::Read,
            secs(31),
        )
        .expect("read");
        let reraised = raise(table, &mut budget, &a, secs(35))
            .expect("raise")
            .expect("reraised");
        assert_eq!(reraised.id, first.id);
        assert!(reraised.read_at.is_none());
        // Read, then repeated after the cooldown: a new row.
        mark(table, None, NotificationMark::Read, secs(36)).expect("read all");
        let fresh = raise(table, &mut budget, &a, secs(60))
            .expect("raise")
            .expect("new");
        assert_ne!(fresh.id, first.id);

        // Recovery coalesces and counts in its title.
        let recovery = Draft {
            title: recovery_title(1),
            body: RECOVERY_BODY.into(),
            ..draft(NotificationKind::RecoveryAvailable, None)
        };
        raise(table, &mut budget, &recovery, secs(61)).expect("r1");
        raise(table, &mut budget, &recovery, secs(61)).expect("r2");
        let third = raise(table, &mut budget, &recovery, secs(61))
            .expect("r3")
            .expect("coalesced");
        assert_eq!(third.count, 3);
        assert_eq!(third.title, "3 threads can be resumed");

        // Settling marks only the matching unread row read.
        let asked = draft(NotificationKind::PermissionRequired, Some("t2"));
        raise(table, &mut budget, &asked, secs(62)).expect("asked");
        let key = Key::of(&asked);
        assert_eq!(settle(table, &key, secs(63)).expect("settle"), 1);
        assert_eq!(settle(table, &key, secs(64)).expect("settle again"), 0);

        // Listing: newest first, unread count, paging with an opaque cursor.
        let page = list(table, false, 2, None).expect("page 1");
        assert_eq!(page.notifications.len(), 2);
        assert_eq!(
            page.notifications[0].kind,
            NotificationKind::PermissionRequired
        );
        assert_eq!(page.unread_count, 2, "fresh completion + recovery");
        let cursor = page.next_cursor.clone().expect("more");
        let rest = list(table, false, 200, Some(&cursor)).expect("page 2");
        assert_eq!(
            rest.notifications.len(),
            2,
            "the fresh completion and the read first one"
        );
        assert_eq!(rest.next_cursor, None);
        let unread = list(table, true, 200, None).expect("unread");
        assert_eq!(unread.notifications.len(), 2);

        // Dismissed rows are never listed; marking all read clears the badge.
        let recovery_id = unread
            .notifications
            .iter()
            .find(|n| n.kind == NotificationKind::RecoveryAvailable)
            .expect("recovery")
            .id
            .clone();
        assert_eq!(
            mark(
                table,
                Some(std::slice::from_ref(&recovery_id)),
                NotificationMark::Dismissed,
                secs(70)
            )
            .expect("dismiss"),
            1
        );
        assert!(
            list(table, false, 200, None)
                .expect("after dismiss")
                .notifications
                .iter()
                .all(|n| n.id != recovery_id)
        );
        assert_eq!(
            mark(table, None, NotificationMark::Read, secs(71)).expect("all"),
            1
        );
        assert_eq!(list(table, false, 1, None).expect("badge").unread_count, 0);
        assert_eq!(
            mark(
                table,
                Some(std::slice::from_ref(&fresh.id)),
                NotificationMark::Unread,
                secs(72)
            )
            .expect("unread"),
            1
        );

        // Validation.
        assert!(list(table, false, 0, None).is_err());
        assert!(list(table, false, 201, None).is_err());
        assert!(list(table, false, 10, Some("garbage")).is_err());
        assert!(
            mark(
                table,
                Some(&["nope".into()]),
                NotificationMark::Read,
                secs(73)
            )
            .is_err()
        );
        assert_eq!(
            mark(table, Some(&[]), NotificationMark::Read, secs(73)).expect("none"),
            0
        );
    }

    fn budget_scenario(table: &mut dyn Table) {
        let mut budget = Budget::default();
        let mut created = 0;
        for i in 0..40 {
            let d = draft(NotificationKind::ThreadFailed, Some(&format!("t{i}")));
            if raise(table, &mut budget, &d, secs(1))
                .expect("raise")
                .is_some()
            {
                created += 1;
            }
        }
        assert_eq!(created, BUDGET_ROWS);
        assert_eq!(budget.suppressed, 10);
        // A coalesced repeat is never budgeted.
        let repeat = draft(NotificationKind::ThreadFailed, Some("t0"));
        assert!(
            raise(table, &mut budget, &repeat, secs(2))
                .expect("r")
                .is_some()
        );
        // The window rolls.
        let later = draft(NotificationKind::ThreadFailed, Some("late"));
        assert!(
            raise(table, &mut budget, &later, secs(62))
                .expect("r")
                .is_some()
        );
    }

    fn retention_scenario(table: &mut dyn Table) {
        let mut budget = Budget::default();
        for i in 0..(RETENTION + 20) {
            // 3 s apart: 20 rows a minute, inside the budget.
            let at = secs(i64::try_from(i).expect("i") * 3);
            let d = draft(NotificationKind::ThreadCompleted, Some(&format!("r{i}")));
            assert!(raise(table, &mut budget, &d, at).expect("raise").is_some());
        }
        let mut seen = 0;
        let mut cursor = None;
        loop {
            let page = list(table, false, 200, cursor.as_deref()).expect("page");
            seen += page.notifications.len();
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        assert_eq!(seen, RETENTION);
    }

    #[test]
    fn migration_is_registered_as_v10() {
        assert_eq!(NOTIFICATIONS_MIGRATION.version, 10);
        assert!(
            kalcode_core::db::MIGRATIONS
                .iter()
                .any(|m| m.version == 10 && m.name == "notifications"),
            "v10 is registered in MIGRATIONS"
        );
        let conn = migrated();
        assert!(table_exists(&conn).expect("exists"));
        let bare = kalcode_core::db::open_in_memory().expect("db");
        assert!(!table_exists(&bare).expect("absent"));
    }

    #[test]
    fn schema_refuses_unknown_kinds_and_half_entities() {
        let conn = migrated();
        let bad_kind = conn.execute(
            "INSERT INTO notifications (id, kind, severity, title, body, created_at, updated_at)
             VALUES ('a', 'party', 'info', 't', 'b', 'x', 'x')",
            [],
        );
        assert!(bad_kind.is_err());
        let half = conn.execute(
            "INSERT INTO notifications (id, kind, severity, title, body, entity_kind, created_at, updated_at)
             VALUES ('b', 'thread_failed', 'info', 't', 'b', 'thread', 'x', 'x')",
            [],
        );
        assert!(half.is_err());
    }

    #[test]
    fn sqlite_and_memory_tables_follow_the_same_policy() {
        let conn = migrated();
        policy_scenario(&mut SqlTable(&conn));
        policy_scenario(&mut MemoryTable::default());
    }

    #[test]
    fn the_budget_limits_new_rows_on_both_backends() {
        let conn = migrated();
        budget_scenario(&mut SqlTable(&conn));
        budget_scenario(&mut MemoryTable::default());
    }

    #[test]
    fn retention_keeps_the_newest_rows_on_both_backends() {
        let conn = migrated();
        retention_scenario(&mut SqlTable(&conn));
        retention_scenario(&mut MemoryTable::default());
    }
}
