//! The locator index: entries (names and statuses, already redacted) plus a contentless FTS5
//! trigram table, and the search over them (filters in SQL, ranking in Rust).
//!
//! Performance (LOC-06, ≤ 30 ms p95 at 100k entries): the FTS5 match is limited to
//! [`MAX_CANDIDATES`] rows ordered by bm25 before the Rust ranking, filters are plain indexed SQL,
//! and a query with no text reads the recency index only. See `tests/locator_perf.rs`.

use std::collections::HashSet;
use std::time::Instant;

use kalcode_core::redact::secrets::ScanContext;
use kalcode_core::redact::{PlaceholderStyle, redact_text};
use kalcode_core::{KalError, Result};
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension, Transaction, params, params_from_iter};

use time::{Duration, OffsetDateTime, UtcOffset};

use crate::query::{ParsedQuery, TermGroup};
use crate::types::{
    LocatorEntityKind, LocatorRecency, LocatorResult, LocatorSort, LocatorStatusFilter, MatchRange,
};

/// Most FTS matches considered for ranking.
pub const MAX_CANDIDATES: usize = 800;
/// Most rows considered for a query without text.
pub const MAX_RECENT_CANDIDATES: usize = 600;
/// Longest title / subtitle stored (characters).
const MAX_FIELD_CHARS: usize = 300;
/// Most message text indexed per thread (opt-in only), in bytes.
pub const MAX_BODY_BYTES: usize = 64 * 1024;
/// Activity entries kept (oldest are pruned).
pub const MAX_ACTIVITY_ENTRIES: i64 = 500;

/// One thing the index can find.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexEntry {
    pub kind: LocatorEntityKind,
    pub entity_id: String,
    pub workspace_id: Option<String>,
    pub provider_id: Option<String>,
    pub title: String,
    pub subtitle: Option<String>,
    pub status: Option<String>,
    pub updated_at: String,
    /// Message text; only for workspaces that opted in, `None` otherwise.
    pub body: Option<String>,
}

fn clip(text: &str, max: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max {
        trimmed.to_owned()
    } else {
        let mut out: String = trimmed.chars().take(max.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}

/// Names can come from a first prompt: every stored string passes the shared redactor
/// (high-signal detectors only, so ordinary names aren't mangled by the entropy heuristic).
pub fn redact_name(text: &str) -> String {
    let context = ScanContext {
        file_name: None,
        no_entropy: true,
    };
    let clean: String = text
        .chars()
        .filter(|c| !c.is_control() || *c == ' ')
        .collect();
    clip(
        &redact_text(&clean, context, PlaceholderStyle::Plain).text,
        MAX_FIELD_CHARS,
    )
}

/// Message text (opt-in): the full redactor, including the entropy heuristic.
pub fn redact_body(text: &str) -> String {
    let mut out = redact_text(text, ScanContext::default(), PlaceholderStyle::Plain).text;
    if out.len() > MAX_BODY_BYTES {
        let mut end = MAX_BODY_BYTES;
        while !out.is_char_boundary(end) {
            end -= 1;
        }
        out.truncate(end);
    }
    out
}

impl IndexEntry {
    /// Applies the redactor and length limits to every stored field.
    pub fn sanitized(mut self) -> Self {
        self.title = redact_name(&self.title);
        if self.title.is_empty() {
            self.title = "Untitled".to_owned();
        }
        self.subtitle = self
            .subtitle
            .map(|s| redact_name(&s))
            .filter(|s| !s.is_empty());
        self.body = self.body.map(|b| redact_body(&b)).filter(|b| !b.is_empty());
        self
    }
}

/// Inserts or replaces one entry. Unchanged entries are left alone, and the FTS row is only
/// rewritten when searchable text changed (a status change touches `locator_entries` only).
pub fn upsert(tx: &Transaction<'_>, entry: &IndexEntry) -> Result<()> {
    type Row = (
        i64,
        String,
        Option<String>,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
        bool,
    );
    let existing: Option<Row> = tx
        .query_row(
            "SELECT id, title, subtitle, status, updated_at, workspace_id, provider_id, has_body
             FROM locator_entries WHERE entity_kind = ?1 AND entity_id = ?2",
            params![entry.kind.as_str(), entry.entity_id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get::<_, i64>(7)? == 1,
                ))
            },
        )
        .optional()?;
    let has_body = i64::from(entry.body.is_some());
    let id = match existing {
        Some((id, title, subtitle, status, updated_at, workspace_id, provider_id, had_body)) => {
            let same_text = entry.body.is_none()
                && !had_body
                && title == entry.title
                && subtitle == entry.subtitle;
            let same_facts = status == entry.status
                && updated_at == entry.updated_at
                && workspace_id == entry.workspace_id
                && provider_id == entry.provider_id;
            if same_text && same_facts {
                return Ok(());
            }
            tx.execute(
                "UPDATE locator_entries SET workspace_id = ?2, provider_id = ?3, title = ?4,
                   subtitle = ?5, status = ?6, updated_at = ?7, has_body = ?8 WHERE id = ?1",
                params![
                    id,
                    entry.workspace_id,
                    entry.provider_id,
                    entry.title,
                    entry.subtitle,
                    entry.status,
                    entry.updated_at,
                    has_body
                ],
            )?;
            if same_text {
                return Ok(());
            }
            tx.execute("DELETE FROM locator_fts WHERE rowid = ?1", [id])?;
            id
        }
        None => {
            tx.execute(
                "INSERT INTO locator_entries
                   (entity_kind, entity_id, workspace_id, provider_id, title, subtitle, status, updated_at, has_body)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    entry.kind.as_str(),
                    entry.entity_id,
                    entry.workspace_id,
                    entry.provider_id,
                    entry.title,
                    entry.subtitle,
                    entry.status,
                    entry.updated_at,
                    has_body
                ],
            )?;
            tx.last_insert_rowid()
        }
    };
    tx.execute(
        "INSERT INTO locator_fts (rowid, title, subtitle, body) VALUES (?1, ?2, ?3, ?4)",
        params![
            id,
            entry.title,
            entry.subtitle.as_deref().unwrap_or(""),
            entry.body.as_deref().unwrap_or("")
        ],
    )?;
    Ok(())
}

/// Removes one entry. Returns whether it existed.
pub fn remove(tx: &Transaction<'_>, kind: LocatorEntityKind, entity_id: &str) -> Result<bool> {
    let id: Option<i64> = tx
        .query_row(
            "SELECT id FROM locator_entries WHERE entity_kind = ?1 AND entity_id = ?2",
            params![kind.as_str(), entity_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(id) = id else { return Ok(false) };
    tx.execute("DELETE FROM locator_fts WHERE rowid = ?1", [id])?;
    tx.execute("DELETE FROM locator_entries WHERE id = ?1", [id])?;
    Ok(true)
}

/// Rewrites every opted-in thread row for a workspace without its message body.
///
/// The rail opt-out calls this in the same transaction that flips `index_messages`, so returning
/// from the update is the linearization point after which old message matches are gone.
pub fn purge_workspace_bodies(tx: &Transaction<'_>, workspace_id: &str) -> Result<usize> {
    let entries: Vec<(i64, String, Option<String>)> = {
        let mut stmt = tx.prepare(
            "SELECT id, title, subtitle FROM locator_entries
             WHERE entity_kind = 'thread' AND workspace_id = ?1 AND has_body = 1",
        )?;
        let rows = stmt.query_map([workspace_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
        rows.collect::<std::result::Result<_, _>>()?
    };
    for (id, title, subtitle) in &entries {
        tx.execute("DELETE FROM locator_fts WHERE rowid = ?1", [id])?;
        tx.execute(
            "INSERT INTO locator_fts (rowid, title, subtitle, body) VALUES (?1, ?2, ?3, '')",
            params![id, title, subtitle.as_deref().unwrap_or("")],
        )?;
        tx.execute(
            "UPDATE locator_entries SET has_body = 0 WHERE id = ?1",
            [id],
        )?;
    }
    Ok(entries.len())
}

/// Removes every derived locator row owned by a workspace, including threads and activity.
pub fn remove_workspace_entries(tx: &Transaction<'_>, workspace_id: &str) -> Result<usize> {
    let ids: Vec<i64> = {
        let mut stmt = tx.prepare("SELECT id FROM locator_entries WHERE workspace_id = ?1")?;
        let rows = stmt.query_map([workspace_id], |row| row.get(0))?;
        rows.collect::<std::result::Result<_, _>>()?
    };
    for id in &ids {
        tx.execute("DELETE FROM locator_fts WHERE rowid = ?1", [id])?;
        tx.execute("DELETE FROM locator_entries WHERE id = ?1", [id])?;
    }
    Ok(ids.len())
}

/// Every indexed `(kind, entity_id)` of `kind`.
pub fn ids_of_kind(conn: &Connection, kind: LocatorEntityKind) -> Result<HashSet<String>> {
    let mut stmt = conn.prepare("SELECT entity_id FROM locator_entries WHERE entity_kind = ?1")?;
    let rows = stmt.query_map([kind.as_str()], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

/// Drops everything (corruption recovery before a rebuild).
pub fn clear(tx: &Transaction<'_>) -> Result<()> {
    tx.execute(
        "INSERT INTO locator_fts (locator_fts) VALUES ('delete-all')",
        [],
    )?;
    tx.execute("DELETE FROM locator_entries", [])?;
    Ok(())
}

/// Keeps the newest [`MAX_ACTIVITY_ENTRIES`] activity entries.
pub fn prune_activity(tx: &Transaction<'_>) -> Result<usize> {
    let ids: Vec<i64> = {
        let mut stmt = tx.prepare(
            "SELECT id FROM locator_entries WHERE entity_kind = 'activity'
             ORDER BY updated_at DESC, id DESC LIMIT -1 OFFSET ?1",
        )?;
        let rows = stmt.query_map([MAX_ACTIVITY_ENTRIES], |r| r.get(0))?;
        rows.collect::<std::result::Result<_, _>>()?
    };
    for id in &ids {
        tx.execute("DELETE FROM locator_fts WHERE rowid = ?1", [id])?;
        tx.execute("DELETE FROM locator_entries WHERE id = ?1", [id])?;
    }
    Ok(ids.len())
}

pub fn count(conn: &Connection) -> Result<u32> {
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM locator_entries", [], |r| r.get(0))?;
    Ok(u32::try_from(n).unwrap_or(u32::MAX))
}

// ------------------------------------------------------------------------------------------
// Search
// ------------------------------------------------------------------------------------------

/// Filters applied in SQL.
#[derive(Debug, Clone, Default)]
pub struct Filters {
    pub kinds: Vec<LocatorEntityKind>,
    pub statuses: Vec<LocatorStatusFilter>,
    pub provider_id: Option<String>,
    pub workspace_id: Option<String>,
    /// RFC 3339 lower bound (inclusive) on `updated_at`.
    pub since: Option<String>,
    /// RFC 3339 upper bound (exclusive) on `updated_at`.
    pub until: Option<String>,
    pub active_only: bool,
}

/// The stored status values that belong to a filter class.
pub fn statuses_of(filter: LocatorStatusFilter) -> &'static [&'static str] {
    match filter {
        LocatorStatusFilter::Working => &[
            "starting",
            "working",
            "testing",
            "reviewing",
            "recovering",
            "running",
        ],
        LocatorStatusFilter::NeedsYou => &["permission_required", "waiting_for_you", "needs_you"],
        LocatorStatusFilter::Done => &["done"],
        LocatorStatusFilter::Failed => &["failed"],
        LocatorStatusFilter::Idle => &["idle", "paused", "offline", "ended"],
        LocatorStatusFilter::Archived => &["archived"],
    }
}

/// The class a stored status belongs to.
pub fn class_of(status: &str) -> Option<LocatorStatusFilter> {
    [
        LocatorStatusFilter::Working,
        LocatorStatusFilter::NeedsYou,
        LocatorStatusFilter::Done,
        LocatorStatusFilter::Failed,
        LocatorStatusFilter::Idle,
        LocatorStatusFilter::Archived,
    ]
    .into_iter()
    .find(|class| statuses_of(*class).contains(&status))
}

/// `[start, end)` in UTC for a local calendar window. `now` is UTC; `offset_minutes` the
/// person's offset. Weeks start on Monday.
pub fn recency_window(
    recency: LocatorRecency,
    now: OffsetDateTime,
    offset_minutes: i32,
) -> (OffsetDateTime, OffsetDateTime) {
    let offset = UtcOffset::from_whole_seconds(offset_minutes.clamp(-840, 840) * 60)
        .unwrap_or(UtcOffset::UTC);
    let local = now.to_offset(offset);
    let midnight = local.replace_time(time::Time::MIDNIGHT);
    let tomorrow = midnight + Duration::days(1);
    let weekday = i64::from(local.weekday().number_days_from_monday());
    let week_start = midnight - Duration::days(weekday);
    let (start, end) = match recency {
        LocatorRecency::Today => (midnight, tomorrow),
        LocatorRecency::Yesterday => (midnight - Duration::days(1), midnight),
        LocatorRecency::ThisWeek => (week_start, tomorrow),
        LocatorRecency::LastWeek => (week_start - Duration::days(7), week_start),
        LocatorRecency::ThisMonth => (midnight.replace_day(1).unwrap_or(midnight), tomorrow),
    };
    (
        start.to_offset(UtcOffset::UTC),
        end.to_offset(UtcOffset::UTC),
    )
}

struct Candidate {
    kind: LocatorEntityKind,
    entity_id: String,
    workspace_id: Option<String>,
    provider_id: Option<String>,
    title: String,
    subtitle: Option<String>,
    status: Option<String>,
    updated_at: String,
}

fn fts_phrase(text: &str) -> String {
    format!("\"{}\"", text.replace('"', "\"\""))
}

/// The FTS5 MATCH expression for the term groups (terms of 3+ characters; shorter ones are
/// matched with LIKE, which the trigram index can't serve). `None` if no group can use FTS.
///
/// Matching is by substring, so an alternative that contains another alternative adds nothing
/// ("authentication" when "auth" is searched) and is left out of the expression: long phrases
/// made of common trigrams are what make broad FTS5 queries slow. Scoring still sees them.
fn fts_expression<'a>(
    groups: impl Iterator<Item = &'a TermGroup>,
    direct_only: bool,
) -> Option<String> {
    let parts: Vec<String> = groups
        .filter_map(|group| {
            let usable: Vec<&String> = group
                .alternatives
                .iter()
                .filter(|a| a.chars().count() >= 3)
                .filter(|a| !direct_only || group.is_direct(a))
                .collect();
            let minimal: Vec<String> = usable
                .iter()
                .filter(|a| !usable.iter().any(|b| b != *a && a.contains(b.as_str())))
                .map(|a| fts_phrase(a))
                .collect();
            (!minimal.is_empty()).then(|| format!("({})", minimal.join(" OR ")))
        })
        .collect();
    (!parts.is_empty()).then(|| parts.join(" AND "))
}

fn escape_like(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    for c in text.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn push_filters(filters: &Filters, sql: &mut String, args: &mut Vec<SqlValue>) {
    if !filters.kinds.is_empty() {
        let marks = vec!["?"; filters.kinds.len()].join(", ");
        sql.push_str(&format!(" AND e.entity_kind IN ({marks})"));
        args.extend(
            filters
                .kinds
                .iter()
                .map(|k| SqlValue::Text(k.as_str().to_owned())),
        );
    }
    let mut statuses: Vec<&str> = filters
        .statuses
        .iter()
        .flat_map(|s| statuses_of(*s).iter().copied())
        .collect();
    if filters.active_only {
        let active: Vec<&str> = statuses_of(LocatorStatusFilter::Working)
            .iter()
            .chain(statuses_of(LocatorStatusFilter::NeedsYou))
            .copied()
            .collect();
        statuses = if statuses.is_empty() {
            active
        } else {
            statuses
                .into_iter()
                .filter(|s| active.contains(s))
                .collect()
        };
        if statuses.is_empty() {
            statuses.push("\u{0}none");
        }
    }
    if !statuses.is_empty() {
        let marks = vec!["?"; statuses.len()].join(", ");
        sql.push_str(&format!(" AND e.status IN ({marks})"));
        args.extend(statuses.iter().map(|s| SqlValue::Text((*s).to_owned())));
    } else {
        // Archived entries only show when asked for.
        sql.push_str(" AND (e.status IS NULL OR e.status <> 'archived')");
    }
    if let Some(provider) = &filters.provider_id {
        sql.push_str(" AND e.provider_id = ?");
        args.push(SqlValue::Text(provider.clone()));
    }
    if let Some(workspace) = &filters.workspace_id {
        sql.push_str(
            " AND (e.workspace_id = ? OR (e.entity_kind = 'workspace' AND e.entity_id = ?))",
        );
        args.push(SqlValue::Text(workspace.clone()));
        args.push(SqlValue::Text(workspace.clone()));
    }
    if let Some(since) = &filters.since {
        sql.push_str(" AND e.updated_at >= ?");
        args.push(SqlValue::Text(since.clone()));
    }
    if let Some(until) = &filters.until {
        sql.push_str(" AND e.updated_at < ?");
        args.push(SqlValue::Text(until.clone()));
    }
}

/// Words shorter than three characters (which the trigram index can't serve) are looked for in
/// this many of the most recent entries.
pub const SHORT_TERM_SCAN: usize = 20_000;
/// Aliases are searched only when the typed words themselves find fewer than this.
const ALIAS_WIDEN_BELOW: usize = 40;
/// Longest time the alias-widened query may take.
const ALIAS_BUDGET: std::time::Duration = std::time::Duration::from_millis(12);

/// How many rows a query retrieves before ranking (performance tests).
pub fn candidate_count(
    conn: &Connection,
    parsed: &ParsedQuery,
    filters: &Filters,
) -> Result<usize> {
    Ok(candidates(conn, parsed, filters)?.len())
}

fn candidates(
    conn: &Connection,
    parsed: &ParsedQuery,
    filters: &Filters,
) -> Result<Vec<Candidate>> {
    let direct = candidates_with(conn, parsed, filters, true)?;
    let has_aliases = parsed
        .groups
        .iter()
        .any(|g| g.alternatives.iter().any(|a| !g.is_direct(a)));
    if direct.len() >= ALIAS_WIDEN_BELOW || !has_aliases {
        return Ok(direct);
    }
    // Widened by aliases, best effort: an alias query that would take longer than its time
    // budget is interrupted and the direct matches are used (LOC-06 keeps its bound even when
    // an alias is made of very common trigrams). The direct matches always stay (short words
    // only the scan could find).
    let started = Instant::now();
    conn.progress_handler(1000, Some(move || started.elapsed() > ALIAS_BUDGET))?;
    let widened = candidates_with(conn, parsed, filters, false);
    conn.progress_handler(0, None::<fn() -> bool>)?;
    let mut widened = match widened {
        Ok(widened) => widened,
        Err(error) if error.diagnostic().to_lowercase().contains("interrupt") => {
            tracing::debug!(event = "locator.alias_widening_skipped");
            return Ok(direct);
        }
        Err(error) => return Err(error),
    };
    for candidate in direct {
        if !widened
            .iter()
            .any(|c| c.kind == candidate.kind && c.entity_id == candidate.entity_id)
        {
            widened.push(candidate);
        }
    }
    Ok(widened)
}

fn candidates_with(
    conn: &Connection,
    parsed: &ParsedQuery,
    filters: &Filters,
    direct_only: bool,
) -> Result<Vec<Candidate>> {
    let mut args: Vec<SqlValue> = Vec::new();
    let columns = "e.entity_kind, e.entity_id, e.workspace_id, e.provider_id, e.title, e.subtitle, e.status, e.updated_at";
    let mut sql;
    // A mixed group needs its short alternatives ORed with its FTS matches. Keeping it in
    // the combined MATCH expression would require a long alternative even when "db" matched.
    let (mixed_groups, fts_groups): (Vec<_>, Vec<_>) = parsed.groups.iter().partition(|group| {
        !direct_only
            && group.alternatives.iter().any(|a| a.chars().count() < 3)
            && group.alternatives.iter().any(|a| a.chars().count() >= 3)
    });
    let fts = fts_expression(fts_groups.into_iter(), direct_only);
    if let Some(expression) = &fts {
        // Matching rows only (no bm25: ranking happens in Rust); newest first.
        sql = format!(
            "WITH m(id) AS (SELECT rowid FROM locator_fts WHERE locator_fts MATCH ?)
             SELECT {columns} FROM m JOIN locator_entries e ON e.id = m.id WHERE 1 = 1"
        );
        args.push(SqlValue::Text(expression.clone()));
    } else {
        sql = format!("SELECT {columns} FROM locator_entries e WHERE 1 = 1");
    }
    for group in &mixed_groups {
        let Some(expression) = fts_expression(std::iter::once(*group), false) else {
            continue;
        };
        let short: Vec<&String> = group
            .alternatives
            .iter()
            .filter(|a| a.chars().count() < 3)
            .collect();
        // UNION keeps the long alternatives on FTS (including opted-in message matches),
        // while short aliases scan only bounded, visible title/subtitle fields. Each group
        // remains an AND constraint, and the entire widening stays under ALIAS_BUDGET.
        sql.push_str(&format!(
            " AND e.id IN (SELECT rowid FROM locator_fts WHERE locator_fts MATCH ?
             UNION SELECT id FROM locator_entries
             WHERE id IN (SELECT id FROM locator_entries ORDER BY updated_at DESC LIMIT {SHORT_TERM_SCAN})
             AND ({}))",
            vec![r"(title LIKE ? ESCAPE '\' OR subtitle LIKE ? ESCAPE '\')"; short.len()]
                .join(" OR ")
        ));
        args.push(SqlValue::Text(expression));
        for alt in short {
            let pattern = format!("%{}%", escape_like(alt));
            args.push(SqlValue::Text(pattern.clone()));
            args.push(SqlValue::Text(pattern));
        }
    }
    // Groups the trigram index can't serve (every alternative shorter than 3 characters).
    for group in &parsed.groups {
        let alternatives: Vec<&String> = group
            .alternatives
            .iter()
            .filter(|a| !direct_only || group.is_direct(a))
            .collect();
        if alternatives.iter().all(|a| a.chars().count() < 3) {
            // Scanned, so bounded: the most recent entries only.
            sql.push_str(&format!(
                " AND e.id IN (SELECT id FROM locator_entries ORDER BY updated_at DESC LIMIT {SHORT_TERM_SCAN})"
            ));
            let ors: Vec<&str> = alternatives
                .iter()
                .map(|_| r"(e.title LIKE ? ESCAPE '\' OR e.subtitle LIKE ? ESCAPE '\')")
                .collect();
            sql.push_str(&format!(" AND ({})", ors.join(" OR ")));
            for alt in alternatives {
                let pattern = format!("%{}%", escape_like(alt));
                args.push(SqlValue::Text(pattern.clone()));
                args.push(SqlValue::Text(pattern));
            }
        }
    }
    push_filters(filters, &mut sql, &mut args);
    // Terms too short for the trigram index are matched by scanning, newest first: fewer
    // candidates keep that scan short.
    let limit = if fts.is_some() || !mixed_groups.is_empty() {
        MAX_CANDIDATES
    } else {
        MAX_RECENT_CANDIDATES
    };
    sql.push_str(&format!(" ORDER BY e.updated_at DESC LIMIT {limit}"));
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(args), |r| {
        let kind: String = r.get(0)?;
        Ok(Candidate {
            kind: LocatorEntityKind::parse(&kind).unwrap_or(LocatorEntityKind::Activity),
            entity_id: r.get(1)?,
            workspace_id: r.get(2)?,
            provider_id: r.get(3)?,
            title: r.get(4)?,
            subtitle: r.get(5)?,
            status: r.get(6)?,
            updated_at: r.get(7)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

fn lower_chars(text: &str) -> Option<Vec<char>> {
    // Highlight offsets are character offsets of the original; only exact when lowercasing
    // keeps one character per character (true for almost all names).
    let mut out = Vec::with_capacity(text.len());
    for c in text.chars() {
        let mut lower = c.to_lowercase();
        let first = lower.next()?;
        if lower.next().is_some() {
            return None;
        }
        out.push(first);
    }
    Some(out)
}

fn find_all<'a>(haystack: &'a [char], needle: &'a [char]) -> impl Iterator<Item = usize> + 'a {
    let first = needle.first().copied();
    let last = haystack.len().checked_sub(needle.len());
    (0..=last.unwrap_or(0))
        .take(if needle.is_empty() || last.is_none() {
            0
        } else {
            usize::MAX
        })
        .filter(move |&i| Some(haystack[i]) == first && haystack[i..i + needle.len()] == *needle)
}

/// How well one alternative matches a field (0 = not at all): the whole field, a whole word,
/// the start of a word, or the middle of a word.
fn field_quality(field: &[char], alt: &[char]) -> (f32, Option<usize>) {
    if !alt.is_empty() && field.len() == alt.len() && field == alt {
        return (1.0, Some(0));
    }
    let starts_word = |p: usize| p == 0 || !field[p - 1].is_alphanumeric();
    let ends_word = |p: usize| {
        let end = p + alt.len();
        end >= field.len() || !field[end].is_alphanumeric()
    };
    let mut best = (0.0f32, None);
    for p in find_all(field, alt) {
        let quality = match (starts_word(p), ends_word(p)) {
            (true, true) => 0.95,
            (true, false) => 0.72,
            (false, true) => 0.5,
            (false, false) => 0.45,
        };
        // The first word of a title counts a little more.
        let quality = if p == 0 { quality + 0.03 } else { quality };
        if quality > best.0 {
            best = (quality, Some(p));
        }
    }
    best
}

struct Scored {
    score: f32,
    highlights: Vec<MatchRange>,
    body_only: bool,
}

/// Added to a term's score when the word as typed appears in the title (not only a synonym).
const TYPED_BONUS: f32 = 0.15;

/// A term group ready for scoring: each alternative as lowercase characters with its weight
/// (aliases count a little less than the typed word).
type Prepared = Vec<Vec<(Vec<char>, f32)>>;

fn prepare(groups: &[TermGroup]) -> Prepared {
    groups
        .iter()
        .map(|group| {
            group
                .alternatives
                .iter()
                .map(|alt| {
                    let weight = if group.is_direct(alt) { 1.0 } else { 0.85 };
                    (alt.chars().collect(), weight)
                })
                .collect()
        })
        .collect()
}

fn score_text(candidate: &Candidate, groups: &Prepared) -> Scored {
    if groups.is_empty() {
        return Scored {
            score: 0.0,
            highlights: Vec::new(),
            body_only: false,
        };
    }
    let title = lower_chars(&candidate.title);
    let subtitle = candidate
        .subtitle
        .as_deref()
        .and_then(lower_chars)
        .unwrap_or_default();
    let title_chars: Vec<char> = title
        .clone()
        .unwrap_or_else(|| candidate.title.to_lowercase().chars().collect());
    let mut total = 0.0;
    let mut highlights = Vec::new();
    let mut any_visible = false;
    for group in groups {
        let mut best = 0.0f32;
        let mut best_range = None;
        let mut typed_in_title = false;
        for (alt_chars, weight) in group {
            let weight = *weight;
            let (q, pos) = field_quality(&title_chars, alt_chars);
            // The word as typed (or its stem) in the title beats a synonym match.
            typed_in_title |= q > 0.0 && weight >= 1.0;
            let q = q * weight;
            if q > best {
                best = q;
                best_range = pos.map(|p| (p, p + alt_chars.len()));
            }
            let (qs, _) = field_quality(&subtitle, alt_chars);
            let qs = qs * 0.5 * weight;
            if qs > best {
                best = qs;
                best_range = None;
            }
        }
        if typed_in_title {
            best = (best + TYPED_BONUS).min(1.0);
        }
        if best > 0.0 {
            any_visible = true;
        } else {
            // Matched by FTS, so the only place left is opted-in message text.
            best = 0.25;
        }
        total += best;
        if let (Some((start, end)), Some(_)) = (best_range, &title) {
            highlights.push(MatchRange {
                start: u32::try_from(start).unwrap_or(0),
                end: u32::try_from(end).unwrap_or(0),
            });
        }
    }
    highlights.sort_by_key(|r| r.start);
    Scored {
        score: total / groups.len() as f32,
        highlights,
        body_only: !any_visible,
    }
}

fn status_weight(status: Option<&str>) -> f32 {
    match status.and_then(class_of) {
        Some(LocatorStatusFilter::NeedsYou) => 1.0,
        Some(LocatorStatusFilter::Working) => 0.85,
        Some(LocatorStatusFilter::Failed) => 0.7,
        Some(LocatorStatusFilter::Idle) => 0.45,
        Some(LocatorStatusFilter::Done) => 0.35,
        Some(LocatorStatusFilter::Archived) => 0.0,
        None => 0.5,
    }
}

fn kind_weight(kind: LocatorEntityKind) -> f32 {
    match kind {
        LocatorEntityKind::Thread => 1.0,
        LocatorEntityKind::Workspace | LocatorEntityKind::RemoteWorkspace => 0.9,
        LocatorEntityKind::Terminal => 0.6,
        LocatorEntityKind::Provider => 0.55,
        LocatorEntityKind::Activity => 0.35,
        _ => 0.5,
    }
}

fn recency_weight(updated_at: &str, now: OffsetDateTime) -> f32 {
    let Ok(at) = OffsetDateTime::parse(updated_at, &time::format_description::well_known::Rfc3339)
    else {
        return 0.0;
    };
    let hours = ((now - at).whole_minutes().max(0) as f32) / 60.0;
    // Half-life of three days.
    0.5f32.powf(hours / 72.0)
}

/// A ranked page of results for an already-parsed query. `now` is injectable for tests.
pub fn search(
    conn: &Connection,
    parsed: &ParsedQuery,
    filters: &Filters,
    sort: LocatorSort,
    now: OffsetDateTime,
) -> Result<Vec<LocatorResult>> {
    let found = candidates(conn, parsed, filters)?;
    let has_text = !parsed.groups.is_empty();
    let prepared = prepare(&parsed.groups);
    let mut results: Vec<LocatorResult> = found
        .into_iter()
        .map(|candidate| {
            let text = score_text(&candidate, &prepared);
            let recency = recency_weight(&candidate.updated_at, now);
            let status = status_weight(candidate.status.as_deref());
            let kind = kind_weight(candidate.kind);
            let score = if has_text {
                0.7 * text.score + 0.14 * recency + 0.1 * status + 0.06 * kind
            } else {
                0.6 * recency + 0.25 * status + 0.15 * kind
            };
            let snippet = if text.body_only {
                Some("Matched text in this thread's messages".to_owned())
            } else {
                None
            };
            LocatorResult {
                kind: candidate.kind,
                entity_id: candidate.entity_id,
                title: candidate.title,
                subtitle: candidate.subtitle,
                status: candidate.status,
                workspace_id: candidate.workspace_id,
                provider_id: candidate.provider_id,
                updated_at: candidate.updated_at,
                snippet,
                score: (score * 1000.0).round() / 1000.0,
                semantic: false,
                highlights: text.highlights,
            }
        })
        .collect();
    match sort {
        LocatorSort::Relevance => results.sort_by(|a, b| {
            b.score
                .total_cmp(&a.score)
                .then_with(|| b.updated_at.cmp(&a.updated_at))
        }),
        LocatorSort::Recency => results.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| b.score.total_cmp(&a.score))
        }),
    }
    Ok(results)
}

/// True when `error` means the FTS index is damaged (the index is then rebuilt).
pub fn is_corruption(error: &KalError) -> bool {
    let text = error.diagnostic().to_lowercase();
    text.contains("malformed")
        || text.contains("corrupt")
        || text.contains("no such table: locator")
}
