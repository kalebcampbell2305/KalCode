//! Recent work and "what was I working on", derived from the event log (never stored).
//!
//! Events carry ids and names only (never message text or file contents), so recent work shows
//! threads, workspaces and file paths that the log says were touched in a window.

use std::collections::HashMap;

use kalcode_contracts::events::{EventEnvelope, EventPayload, EventQuery, SeqOrder};
use kalcode_contracts::threads::ThreadSummary;
use kalcode_core::workspaces::Workspace;
use kalcode_core::{Core, Result};

use crate::home::thread_item;
use crate::types::{RecentWorkItem, RecentWorkKind};

/// Event types that mean "someone worked on this".
pub const WORK_TYPES: &[&str] = &[
    "thread.*",
    "agent.message",
    "tool.*",
    "file.*",
    "approval.*",
    "workspace.created",
    "workspace.opened",
    "shell.started",
];

/// Events read per window at most (4 pages).
const MAX_EVENTS: usize = 2000;

/// Reads work events in `[from, to)` (RFC 3339) or in a seq range, newest first.
pub fn work_events(
    core: &Core,
    from: Option<&str>,
    to: Option<&str>,
    after_seq: Option<i64>,
    before_seq: Option<i64>,
) -> Result<Vec<EventEnvelope>> {
    let mut out = Vec::new();
    let mut before = before_seq;
    loop {
        let page = core.query_events(&EventQuery {
            types: WORK_TYPES.iter().map(|t| (*t).to_owned()).collect(),
            after_seq,
            before_seq: before,
            from: from.map(str::to_owned),
            to: to.map(str::to_owned),
            order: SeqOrder::Desc,
            limit: 500,
            ..EventQuery::default()
        })?;
        let full = page.next_cursor;
        out.extend(page.events);
        match full {
            Some(cursor) if out.len() < MAX_EVENTS => before = Some(cursor),
            _ => break,
        }
    }
    Ok(out)
}

fn thread_of(event: &EventEnvelope) -> Option<&str> {
    event
        .correlation
        .thread_id
        .as_deref()
        .or(match &event.event {
            EventPayload::ThreadCreated { thread_id, .. }
            | EventPayload::ThreadStarted { thread_id }
            | EventPayload::ThreadCompleted { thread_id }
            | EventPayload::ThreadArchived { thread_id }
            | EventPayload::ThreadUnarchived { thread_id }
            | EventPayload::ThreadRenamed { thread_id, .. }
            | EventPayload::ThreadFailed { thread_id, .. }
            | EventPayload::ThreadStatusChanged { thread_id, .. }
            | EventPayload::AgentMessage { thread_id, .. }
            | EventPayload::ToolRequested { thread_id, .. }
            | EventPayload::ToolStarted { thread_id, .. }
            | EventPayload::ToolCompleted { thread_id, .. }
            | EventPayload::ToolFailed { thread_id, .. }
            | EventPayload::ApprovalRequested { thread_id, .. }
            | EventPayload::ApprovalApproved { thread_id, .. }
            | EventPayload::ApprovalDenied { thread_id, .. }
            | EventPayload::ApprovalExpired { thread_id, .. } => Some(thread_id.as_str()),
            _ => None,
        })
}

/// Groups events into recent-work items (threads, files, workspaces), newest first.
pub fn items_from_events(
    events: &[EventEnvelope],
    threads: &HashMap<&str, &ThreadSummary>,
    workspaces: &HashMap<&str, &Workspace>,
) -> Vec<RecentWorkItem> {
    let mut items: Vec<RecentWorkItem> = Vec::new();
    let mut seen: HashMap<(RecentWorkKind, String), usize> = HashMap::new();
    let mut push = |item: RecentWorkItem| {
        let key = (item.kind, item.id.clone());
        match seen.get(&key) {
            Some(&index) => {
                if item.last_activity_at > items[index].last_activity_at {
                    items[index].last_activity_at = item.last_activity_at;
                }
            }
            None => {
                seen.insert(key, items.len());
                items.push(item);
            }
        }
    };
    for event in events {
        let at = event.occurred_at.clone();
        if let Some(thread) = thread_of(event).and_then(|id| threads.get(id)) {
            let mut item = thread_item(thread);
            item.last_activity_at = at.clone();
            push(item);
        }
        let file = match &event.event {
            EventPayload::FileCreated { path, .. }
            | EventPayload::FileModified { path, .. }
            | EventPayload::FileDeleted { path, .. } => Some(path),
            _ => None,
        };
        let workspace = event
            .correlation
            .workspace_id
            .as_deref()
            .and_then(|id| workspaces.get(id))
            .or_else(|| {
                thread_of(event)
                    .and_then(|id| threads.get(id))
                    .and_then(|t| workspaces.get(t.workspace_id.as_str()))
            });
        if let Some(path) = file {
            push(RecentWorkItem {
                kind: RecentWorkKind::File,
                id: format!("{}:{path}", workspace.map_or("", |w| w.id.as_str())),
                title: path.clone(),
                workspace_id: workspace.map(|w| w.id.clone()),
                workspace_name: workspace.map(|w| w.name.clone()),
                provider_id: None,
                provider_name: None,
                status: None,
                resumable: None,
                last_activity_at: at.clone(),
            });
        }
        if let Some(workspace) = workspace {
            push(RecentWorkItem {
                kind: RecentWorkKind::Workspace,
                id: workspace.id.clone(),
                title: workspace.name.clone(),
                workspace_id: Some(workspace.id.clone()),
                workspace_name: Some(workspace.name.clone()),
                provider_id: None,
                provider_name: None,
                status: None,
                resumable: None,
                last_activity_at: at,
            });
        }
    }
    items.sort_by(|a, b| b.last_activity_at.cmp(&a.last_activity_at));
    items
}

/// The seq range of the previous app session: `(start, end)` where `start` is the previous
/// `app.started` and `end` the current one. `None` on the first session.
pub fn previous_session(core: &Core) -> Result<Option<(i64, i64)>> {
    let page = core.query_events(&EventQuery {
        types: vec!["app.started".to_owned()],
        order: SeqOrder::Desc,
        limit: 2,
        ..EventQuery::default()
    })?;
    Ok(match page.events.as_slice() {
        [current, previous, ..] => Some((previous.seq, current.seq)),
        _ => None,
    })
}

/// The newest event seq (0 for an empty log).
pub fn latest_seq(core: &Core) -> Result<i64> {
    let page = core.query_events(&EventQuery {
        order: SeqOrder::Desc,
        limit: 1,
        ..EventQuery::default()
    })?;
    Ok(page.events.first().map_or(0, |e| e.seq))
}

/// Threads completed after `seq` (newest first, distinct).
pub fn completed_after(core: &Core, seq: i64) -> Result<Vec<(String, String)>> {
    let page = core.query_events(&EventQuery {
        types: vec!["thread.completed".to_owned()],
        after_seq: Some(seq),
        order: SeqOrder::Desc,
        limit: 200,
        ..EventQuery::default()
    })?;
    let mut out: Vec<(String, String)> = Vec::new();
    for event in page.events {
        if let EventPayload::ThreadCompleted { thread_id } = event.event
            && !out.iter().any(|(id, _)| *id == thread_id)
        {
            out.push((thread_id, event.occurred_at));
        }
    }
    Ok(out)
}
