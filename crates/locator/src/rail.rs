//! The workspace rail: pinned, recent and folder groups over Z1's workspaces, each with its
//! threads grouped by provider (live counts), plus the rail's own persisted state (pin, folder,
//! order, archive, rail name, collapse, message-text search opt-in).
//!
//! Z1 owns `workspaces` (read through `Core::workspaces`); Z3 owns `threads` (read through its
//! API by the caller). This module owns `workspace_rail` and `workspace_groups`. Removing a
//! workspace from KalCode is Z1's `workspace_remove` (files are never touched); archiving only
//! hides it from the rail.

use std::collections::{BTreeMap, HashMap, HashSet};

use kalcode_contracts::agent::ProviderId;
use kalcode_contracts::agent_state::AgentState;
use kalcode_contracts::ids::{is_valid_id, new_id};
use kalcode_contracts::threads::ThreadSummary;
use kalcode_core::time::now_rfc3339;
use kalcode_core::workspaces::Workspace;
use kalcode_core::{KalError, Result};
use rusqlite::{Connection, OptionalExtension, Transaction, params};

use crate::store::invalid_id;
use crate::types::{
    ProviderRow, RailGroupView, RailSection, RailState, RailThread, RailUpdate, WorkspaceGroup,
    WorkspaceRailEntry,
};

/// Threads listed under one provider row (the row's count is the full number).
pub const MAX_ROW_ITEMS: usize = 25;
/// Most folders a person can make.
pub const MAX_GROUPS: usize = 50;

/// One `workspace_rail` row.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RailRow {
    pub name: Option<String>,
    pub group_id: Option<String>,
    pub pinned_at: Option<String>,
    pub archived_at: Option<String>,
    pub position: Option<i64>,
    pub collapsed: bool,
    pub index_messages: bool,
}

/// Validates a rail or folder name: trimmed, 1–80 characters, no control or invisible
/// formatting characters. `Ok(None)` for an empty value.
pub fn normalize_name(raw: &str) -> Result<Option<String>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > 80 {
        return Err(KalError::validation(
            "name_too_long",
            "Names can be at most 80 characters.",
        ));
    }
    let forbidden = |c: char| {
        c.is_control()
            || matches!(
                c,
                '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}'
            )
    };
    if trimmed.chars().any(forbidden) {
        return Err(KalError::validation(
            "name_invalid",
            "Names can't contain control or invisible formatting characters.",
        ));
    }
    Ok(Some(trimmed.to_owned()))
}

pub fn load_rows(conn: &Connection) -> Result<HashMap<String, RailRow>> {
    let mut stmt = conn.prepare(
        "SELECT workspace_id, name, group_id, pinned_at, archived_at, position, collapsed, index_messages
         FROM workspace_rail",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            RailRow {
                name: r.get(1)?,
                group_id: r.get(2)?,
                pinned_at: r.get(3)?,
                archived_at: r.get(4)?,
                position: r.get(5)?,
                collapsed: r.get::<_, i64>(6)? == 1,
                index_messages: r.get::<_, i64>(7)? == 1,
            },
        ))
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

pub fn load_row(conn: &Connection, workspace_id: &str) -> Result<RailRow> {
    Ok(load_rows(conn)?.remove(workspace_id).unwrap_or_default())
}

pub fn load_groups(conn: &Connection) -> Result<Vec<WorkspaceGroup>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, position, collapsed FROM workspace_groups ORDER BY position, created_at",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(WorkspaceGroup {
            id: r.get(0)?,
            name: r.get(1)?,
            position: u32::try_from(r.get::<_, i64>(2)?).unwrap_or(0),
            collapsed: r.get::<_, i64>(3)? == 1,
        })
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

fn ensure_row(tx: &Transaction<'_>, workspace_id: &str, now: &str) -> Result<()> {
    tx.execute(
        "INSERT INTO workspace_rail (workspace_id, updated_at) VALUES (?1, ?2)
         ON CONFLICT(workspace_id) DO NOTHING",
        params![workspace_id, now],
    )?;
    Ok(())
}

fn next_position(tx: &Transaction<'_>, sql: &str, arg: Option<&str>) -> Result<i64> {
    let max: Option<i64> = match arg {
        Some(arg) => tx.query_row(sql, [arg], |r| r.get(0))?,
        None => tx.query_row(sql, [], |r| r.get(0))?,
    };
    Ok(max.map_or(0, |m| m + 1))
}

/// Applies one rail change. `workspace_exists` comes from Z1 (the caller checked the id).
/// Returns the list of fields that changed (for `workspace.updated` once it exists).
pub fn apply_update(tx: &Transaction<'_>, update: &RailUpdate) -> Result<Vec<&'static str>> {
    if !is_valid_id(&update.workspace_id) {
        return Err(invalid_id());
    }
    let now = now_rfc3339();
    let id = update.workspace_id.as_str();
    ensure_row(tx, id, &now)?;
    let before = load_row(tx, id)?;
    let mut fields = Vec::new();

    if let Some(raw) = &update.name {
        let name = normalize_name(raw)?;
        if name != before.name {
            tx.execute(
                "UPDATE workspace_rail SET name = ?2 WHERE workspace_id = ?1",
                params![id, name],
            )?;
            fields.push("name");
        }
    }
    if let Some(raw) = &update.group_id {
        let group: Option<String> = (!raw.is_empty()).then(|| raw.clone());
        if let Some(group_id) = &group {
            if !is_valid_id(group_id) {
                return Err(invalid_id());
            }
            let exists: Option<i64> = tx
                .query_row(
                    "SELECT 1 FROM workspace_groups WHERE id = ?1",
                    [group_id],
                    |r| r.get(0),
                )
                .optional()?;
            if exists.is_none() {
                return Err(KalError::validation(
                    "group_not_found",
                    "That folder no longer exists.",
                ));
            }
        }
        if group != before.group_id {
            let position = match &group {
                Some(group_id) => Some(next_position(
                    tx,
                    "SELECT MAX(position) FROM workspace_rail WHERE group_id = ?1",
                    Some(group_id),
                )?),
                None => None,
            };
            tx.execute(
                "UPDATE workspace_rail SET group_id = ?2, position = ?3 WHERE workspace_id = ?1",
                params![id, group, position],
            )?;
            fields.push("group");
        }
    }
    if let Some(pinned) = update.pinned
        && pinned != before.pinned_at.is_some()
    {
        if pinned {
            let position = next_position(
                tx,
                "SELECT MAX(position) FROM workspace_rail WHERE pinned_at IS NOT NULL",
                None,
            )?;
            tx.execute(
                "UPDATE workspace_rail SET pinned_at = ?2, position = ?3, archived_at = NULL
                 WHERE workspace_id = ?1",
                params![id, now, position],
            )?;
        } else {
            tx.execute(
                "UPDATE workspace_rail SET pinned_at = NULL WHERE workspace_id = ?1",
                [id],
            )?;
        }
        fields.push("pinned");
    }
    if let Some(position) = update.position {
        reposition(tx, id, i64::from(position))?;
        fields.push("position");
    }
    if let Some(collapsed) = update.collapsed
        && collapsed != before.collapsed
    {
        tx.execute(
            "UPDATE workspace_rail SET collapsed = ?2 WHERE workspace_id = ?1",
            params![id, i64::from(collapsed)],
        )?;
        fields.push("collapsed");
    }
    if let Some(archived) = update.archived
        && archived != before.archived_at.is_some()
    {
        if archived {
            // Archiving hides it: it leaves the pinned section too.
            tx.execute(
                "UPDATE workspace_rail SET archived_at = ?2, pinned_at = NULL WHERE workspace_id = ?1",
                params![id, now],
            )?;
        } else {
            tx.execute(
                "UPDATE workspace_rail SET archived_at = NULL WHERE workspace_id = ?1",
                [id],
            )?;
        }
        fields.push("archived");
    }
    if let Some(index_messages) = update.index_messages
        && index_messages != before.index_messages
    {
        tx.execute(
            "UPDATE workspace_rail SET index_messages = ?2 WHERE workspace_id = ?1",
            params![id, i64::from(index_messages)],
        )?;
        fields.push("index_messages");
    }
    if !fields.is_empty() {
        tx.execute(
            "UPDATE workspace_rail SET updated_at = ?2 WHERE workspace_id = ?1",
            params![id, now],
        )?;
    }
    Ok(fields)
}

/// Moves a workspace to `position` among its siblings (pinned section or its folder),
/// renumbering the siblings 0..n.
fn reposition(tx: &Transaction<'_>, id: &str, position: i64) -> Result<()> {
    let row = load_row(tx, id)?;
    let siblings_sql = if row.pinned_at.is_some() {
        "SELECT workspace_id FROM workspace_rail WHERE pinned_at IS NOT NULL
         ORDER BY position, pinned_at"
            .to_owned()
    } else if row.group_id.is_some() {
        "SELECT workspace_id FROM workspace_rail WHERE group_id = ?1 AND pinned_at IS NULL
         ORDER BY position, updated_at"
            .to_owned()
    } else {
        // Recent is ordered by use; there is nothing to reorder.
        return Ok(());
    };
    let mut ids: Vec<String> = {
        let mut stmt = tx.prepare(&siblings_sql)?;
        if let (None, Some(group)) = (&row.pinned_at, &row.group_id) {
            stmt.query_map([group], |r| r.get(0))?
                .collect::<std::result::Result<Vec<String>, _>>()?
        } else {
            stmt.query_map([], |r| r.get(0))?
                .collect::<std::result::Result<Vec<String>, _>>()?
        }
    };
    ids.retain(|other| other != id);
    let at = usize::try_from(position.max(0)).unwrap_or(0).min(ids.len());
    ids.insert(at, id.to_owned());
    for (index, workspace_id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE workspace_rail SET position = ?2 WHERE workspace_id = ?1",
            params![workspace_id, i64::try_from(index).unwrap_or(i64::MAX)],
        )?;
    }
    Ok(())
}

pub fn create_group(tx: &Transaction<'_>, name: &str) -> Result<WorkspaceGroup> {
    let name = normalize_name(name)?
        .ok_or_else(|| KalError::validation("name_required", "Give the folder a name."))?;
    let count: i64 = tx.query_row("SELECT COUNT(*) FROM workspace_groups", [], |r| r.get(0))?;
    if usize::try_from(count).unwrap_or(usize::MAX) >= MAX_GROUPS {
        return Err(KalError::validation(
            "too_many_groups",
            "You can have at most 50 folders in the rail.",
        ));
    }
    let position = next_position(tx, "SELECT MAX(position) FROM workspace_groups", None)?;
    let id = new_id();
    tx.execute(
        "INSERT INTO workspace_groups (id, name, position, collapsed, created_at)
         VALUES (?1, ?2, ?3, 0, ?4)",
        params![id, name, position, now_rfc3339()],
    )?;
    Ok(WorkspaceGroup {
        id,
        name,
        position: u32::try_from(position).unwrap_or(0),
        collapsed: false,
    })
}

fn group(tx: &Transaction<'_>, id: &str) -> Result<WorkspaceGroup> {
    if !is_valid_id(id) {
        return Err(invalid_id());
    }
    load_groups(tx)?
        .into_iter()
        .find(|g| g.id == id)
        .ok_or_else(|| KalError::validation("group_not_found", "That folder no longer exists."))
}

pub fn update_group(
    tx: &Transaction<'_>,
    id: &str,
    name: Option<&str>,
    collapsed: Option<bool>,
) -> Result<WorkspaceGroup> {
    group(tx, id)?;
    if let Some(name) = name {
        let name = normalize_name(name)?
            .ok_or_else(|| KalError::validation("name_required", "Give the folder a name."))?;
        tx.execute(
            "UPDATE workspace_groups SET name = ?2 WHERE id = ?1",
            params![id, name],
        )?;
    }
    if let Some(collapsed) = collapsed {
        tx.execute(
            "UPDATE workspace_groups SET collapsed = ?2 WHERE id = ?1",
            params![id, i64::from(collapsed)],
        )?;
    }
    group(tx, id)
}

/// Deletes a folder. Its workspaces go back to Recent (nothing else changes).
pub fn delete_group(tx: &Transaction<'_>, id: &str) -> Result<()> {
    group(tx, id)?;
    tx.execute(
        "UPDATE workspace_rail SET group_id = NULL, position = NULL WHERE group_id = ?1",
        [id],
    )?;
    tx.execute("DELETE FROM workspace_groups WHERE id = ?1", [id])?;
    Ok(())
}

/// Orders the folders as given (every folder id exactly once).
pub fn reorder_groups(tx: &Transaction<'_>, ids: &[String]) -> Result<Vec<WorkspaceGroup>> {
    let existing: HashSet<String> = load_groups(tx)?.into_iter().map(|g| g.id).collect();
    let given: HashSet<&String> = ids.iter().collect();
    if given.len() != ids.len()
        || ids.len() != existing.len()
        || ids.iter().any(|id| !existing.contains(id))
    {
        return Err(KalError::validation(
            "groups_mismatch",
            "The folder list changed. Try again.",
        ));
    }
    for (index, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE workspace_groups SET position = ?2 WHERE id = ?1",
            params![id, i64::try_from(index).unwrap_or(i64::MAX)],
        )?;
    }
    load_groups(tx)
}

/// Deletes rail rows of workspaces Z1 no longer has (removed from KalCode).
pub fn prune(tx: &Transaction<'_>, known: &HashSet<&str>) -> Result<usize> {
    let ids: Vec<String> = {
        let mut stmt = tx.prepare("SELECT workspace_id FROM workspace_rail")?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        rows.collect::<std::result::Result<_, _>>()?
    };
    let mut removed = 0;
    for id in ids.iter().filter(|id| !known.contains(id.as_str())) {
        removed += tx.execute("DELETE FROM workspace_rail WHERE workspace_id = ?1", [id])?;
    }
    Ok(removed)
}

/// The shared agent state of a thread (the same projection every surface uses, for every
/// provider): see `kalcode_contracts::agent_state`.
fn agent_state(thread: &ThreadSummary) -> AgentState {
    AgentState::of(
        thread.status,
        thread.current_activity.as_deref(),
        thread.pending_approvals,
    )
}

/// Starting, working or testing.
pub fn is_working(thread: &ThreadSummary) -> bool {
    agent_state(thread).is_busy()
}

/// Waiting on the person (an approval or a reply). A failure is a decision, not a question, so
/// it never counts here (the Fleet's Needs you group).
pub fn needs_you(thread: &ThreadSummary) -> bool {
    agent_state(thread) == AgentState::NeedsYou
}

/// Builds one workspace's rail entry from Z1's record, the rail row and its open threads.
pub fn entry_for(
    workspace: &Workspace,
    row: &RailRow,
    threads: &[&ThreadSummary],
    active_id: Option<&str>,
) -> WorkspaceRailEntry {
    let mut by_provider: BTreeMap<String, (String, Vec<&ThreadSummary>)> = BTreeMap::new();
    for thread in threads {
        by_provider
            .entry(thread.provider_id.as_str().to_owned())
            .or_insert_with(|| (thread.provider_name.clone(), Vec::new()))
            .1
            .push(thread);
    }
    let mut providers: Vec<ProviderRow> = by_provider
        .into_iter()
        .map(|(id, (name, mut list))| {
            list.sort_by(|a, b| b.last_activity_at.cmp(&a.last_activity_at));
            ProviderRow {
                provider_id: ProviderId::new(id),
                provider_name: name,
                threads: u32::try_from(list.len()).unwrap_or(u32::MAX),
                working: count(&list, is_working),
                needs_you: count(&list, needs_you),
                items: list
                    .iter()
                    .take(MAX_ROW_ITEMS)
                    .map(|t| RailThread {
                        id: t.id.clone(),
                        name: t.name.clone(),
                        status: t.status,
                        resumable: Some(t.resumable),
                        last_activity_at: t.last_activity_at.clone(),
                        pending_approvals: t.pending_approvals,
                    })
                    .collect(),
            }
        })
        .collect();
    // Busiest provider first, then by name.
    providers.sort_by(|a, b| {
        (b.needs_you + b.working)
            .cmp(&(a.needs_you + a.working))
            .then_with(|| a.provider_name.cmp(&b.provider_name))
    });
    let last_thread = threads.iter().map(|t| t.last_activity_at.as_str()).max();
    let last_activity_at = match last_thread {
        Some(at) if at > workspace.last_opened_at.as_str() => at.to_owned(),
        _ => workspace.last_opened_at.clone(),
    };
    WorkspaceRailEntry {
        workspace_id: workspace.id.clone(),
        name: row.name.clone().unwrap_or_else(|| workspace.name.clone()),
        folder_name: workspace.name.clone(),
        display_path: workspace.display_path.clone(),
        location: "local".to_owned(),
        available: workspace.available,
        active: active_id == Some(workspace.id.as_str()),
        pinned: row.pinned_at.is_some(),
        archived: row.archived_at.is_some(),
        group_id: row.group_id.clone(),
        collapsed: row.collapsed,
        index_messages: row.index_messages,
        working: providers.iter().map(|p| p.working).sum(),
        needs_you: providers.iter().map(|p| p.needs_you).sum(),
        threads: u32::try_from(threads.len()).unwrap_or(u32::MAX),
        providers,
        last_opened_at: workspace.last_opened_at.clone(),
        last_activity_at,
    }
}

fn count(list: &[&ThreadSummary], pred: impl Fn(&ThreadSummary) -> bool) -> u32 {
    u32::try_from(list.iter().filter(|t| pred(t)).count()).unwrap_or(u32::MAX)
}

/// The whole rail. Pure: every input is passed in (tested without a database).
pub fn build_state(
    workspaces: &[Workspace],
    active_id: Option<&str>,
    threads: &[ThreadSummary],
    rows: &HashMap<String, RailRow>,
    groups: &[WorkspaceGroup],
    collapsed_sections: Vec<RailSection>,
    persistent: bool,
) -> RailState {
    let mut threads_by_ws: HashMap<&str, Vec<&ThreadSummary>> = HashMap::new();
    for thread in threads.iter().filter(|t| t.archived_at.is_none()) {
        threads_by_ws
            .entry(thread.workspace_id.as_str())
            .or_default()
            .push(thread);
    }
    let default_row = RailRow::default();
    let mut pinned: Vec<(i64, String, WorkspaceRailEntry)> = Vec::new();
    let mut recent = Vec::new();
    let mut archived = Vec::new();
    let mut grouped: HashMap<String, Vec<(i64, WorkspaceRailEntry)>> = HashMap::new();
    let group_ids: HashSet<&str> = groups.iter().map(|g| g.id.as_str()).collect();
    for workspace in workspaces {
        let row = rows.get(&workspace.id).unwrap_or(&default_row);
        let list = threads_by_ws
            .get(workspace.id.as_str())
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let entry = entry_for(workspace, row, list, active_id);
        if entry.archived {
            archived.push(entry);
        } else if let Some(pinned_at) = &row.pinned_at {
            pinned.push((row.position.unwrap_or(i64::MAX), pinned_at.clone(), entry));
        } else if let Some(group) = row.group_id.as_deref().filter(|g| group_ids.contains(g)) {
            grouped
                .entry(group.to_owned())
                .or_default()
                .push((row.position.unwrap_or(i64::MAX), entry));
        } else {
            recent.push(entry);
        }
    }
    pinned.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    recent.sort_by(|a, b| b.last_activity_at.cmp(&a.last_activity_at));
    archived.sort_by_key(|e| e.name.to_lowercase());
    let groups = groups
        .iter()
        .map(|group| {
            let mut members = grouped.remove(&group.id).unwrap_or_default();
            members.sort_by(|a, b| {
                a.0.cmp(&b.0)
                    .then_with(|| a.1.name.to_lowercase().cmp(&b.1.name.to_lowercase()))
            });
            RailGroupView {
                group: group.clone(),
                workspaces: members.into_iter().map(|(_, e)| e).collect(),
            }
        })
        .collect();
    RailState {
        pinned: pinned.into_iter().map(|(_, _, e)| e).collect(),
        recent,
        groups,
        archived,
        collapsed_sections,
        persistent,
    }
}
