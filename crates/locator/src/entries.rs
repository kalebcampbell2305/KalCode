//! What each kind of entity puts into the index. Names and statuses only; message text only for
//! workspaces that opted in. Every field passes the shared redactor ([`IndexEntry::sanitized`]).

use kalcode_contracts::events::{EventEnvelope, EventPayload};
use kalcode_contracts::threads::ThreadSummary;
use kalcode_contracts::workspace_ui::DisplayStatus;
use kalcode_core::workspaces::{TerminalInfo, TerminalStatus, Workspace};

use crate::index::IndexEntry;
use crate::rail::RailRow;
use crate::types::LocatorEntityKind;

/// A provider as the locator shows it (from Z2's registry, supplied by the app).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderInfo {
    pub id: String,
    pub name: String,
    /// `ready`, `signed_out`, `outdated`, `not_installed`, `unknown`.
    pub status: String,
    /// Plain words for the subtitle, e.g. "Installed · signed in".
    pub detail: String,
}

pub fn display_status_str(status: DisplayStatus) -> &'static str {
    match status {
        DisplayStatus::Starting => "starting",
        DisplayStatus::Working => "working",
        DisplayStatus::Testing => "testing",
        DisplayStatus::Reviewing => "reviewing",
        DisplayStatus::PermissionRequired => "permission_required",
        DisplayStatus::WaitingForYou => "waiting_for_you",
        DisplayStatus::Waiting => "waiting",
        DisplayStatus::Idle => "idle",
        DisplayStatus::Paused => "paused",
        DisplayStatus::Done => "done",
        DisplayStatus::Failed => "failed",
        DisplayStatus::Recovering => "recovering",
        DisplayStatus::Offline => "offline",
    }
}

pub fn thread_entry(thread: &ThreadSummary, body: Option<String>) -> IndexEntry {
    let mut subtitle = format!("{} · {}", thread.provider_name, thread.workspace_name);
    if let Some(model) = thread.model.as_deref().filter(|m| !m.is_empty()) {
        subtitle.push_str(" · ");
        subtitle.push_str(model);
    }
    let status = if thread.archived_at.is_some() {
        "archived"
    } else {
        display_status_str(thread.status.display().0)
    };
    IndexEntry {
        kind: LocatorEntityKind::Thread,
        entity_id: thread.id.clone(),
        workspace_id: Some(thread.workspace_id.clone()),
        provider_id: Some(thread.provider_id.as_str().to_owned()),
        title: thread.name.clone(),
        subtitle: Some(subtitle),
        status: Some(status.to_owned()),
        updated_at: thread.last_activity_at.clone(),
        body,
    }
    .sanitized()
}

pub fn workspace_entry(workspace: &Workspace, row: &RailRow) -> IndexEntry {
    let name = row.name.clone().unwrap_or_else(|| workspace.name.clone());
    let mut subtitle = format!("Workspace · {}", workspace.display_path);
    if row.name.is_some() {
        subtitle.push_str(" · folder ");
        subtitle.push_str(&workspace.name);
    }
    let status = if row.archived_at.is_some() {
        "archived"
    } else if workspace.available {
        "available"
    } else {
        "missing"
    };
    IndexEntry {
        kind: LocatorEntityKind::Workspace,
        entity_id: workspace.id.clone(),
        workspace_id: Some(workspace.id.clone()),
        provider_id: None,
        title: name,
        subtitle: Some(subtitle),
        status: Some(status.to_owned()),
        updated_at: workspace.last_opened_at.clone(),
        body: None,
    }
    .sanitized()
}

pub fn terminal_entry(terminal: &TerminalInfo, workspace: &Workspace) -> IndexEntry {
    let running = terminal.status == TerminalStatus::Running;
    IndexEntry {
        kind: LocatorEntityKind::Terminal,
        entity_id: terminal.id.clone(),
        workspace_id: Some(terminal.workspace_id.clone()),
        provider_id: None,
        title: terminal.title.clone(),
        subtitle: Some(format!(
            "Terminal · {} · {}",
            workspace.name,
            if running { "running" } else { "ended" }
        )),
        status: Some(if running { "running" } else { "ended" }.to_owned()),
        updated_at: terminal
            .ended_at
            .clone()
            .or_else(|| terminal.started_at.clone())
            .unwrap_or_else(|| workspace.last_opened_at.clone()),
        body: None,
    }
    .sanitized()
}

pub fn provider_entry(provider: &ProviderInfo, updated_at: &str) -> IndexEntry {
    IndexEntry {
        kind: LocatorEntityKind::Provider,
        entity_id: provider.id.clone(),
        workspace_id: None,
        provider_id: Some(provider.id.clone()),
        title: provider.name.clone(),
        subtitle: Some(format!("Provider · {}", provider.detail)),
        status: Some(provider.status.clone()),
        updated_at: updated_at.to_owned(),
        body: None,
    }
    .sanitized()
}

/// Activity worth finding later ("the approval this morning"). Names come from the current
/// thread/workspace records; events without a known subject are skipped.
pub fn activity_entry(
    event: &EventEnvelope,
    thread: Option<&ThreadSummary>,
    workspace_name: Option<&str>,
) -> Option<IndexEntry> {
    let (verb, subject) = match &event.event {
        EventPayload::ThreadCompleted { .. } => ("Completed", thread?.name.clone()),
        EventPayload::ThreadFailed { .. } => ("Failed", thread?.name.clone()),
        EventPayload::ApprovalRequested { .. } => ("Approval requested", thread?.name.clone()),
        EventPayload::WorkspaceCreated { name, .. } => ("Added workspace", name.clone()),
        EventPayload::WorkspaceOpened { name, .. } => ("Opened workspace", name.clone()),
        _ => return None,
    };
    let workspace_id = event
        .correlation
        .workspace_id
        .clone()
        .or_else(|| thread.map(|t| t.workspace_id.clone()));
    let place = workspace_name
        .map(str::to_owned)
        .or_else(|| thread.map(|t| t.workspace_name.clone()));
    Some(
        IndexEntry {
            kind: LocatorEntityKind::Activity,
            entity_id: event.id.clone(),
            workspace_id,
            provider_id: event
                .correlation
                .provider_id
                .clone()
                .or_else(|| thread.map(|t| t.provider_id.as_str().to_owned())),
            title: format!("{verb} · {subject}"),
            subtitle: Some(match place {
                Some(place) => format!("Activity · {place}"),
                None => "Activity".to_owned(),
            }),
            status: None,
            updated_at: event.occurred_at.clone(),
            body: None,
        }
        .sanitized(),
    )
}

/// The thread an activity event is about.
pub fn activity_thread_id(event: &EventEnvelope) -> Option<&str> {
    match &event.event {
        EventPayload::ThreadCompleted { thread_id }
        | EventPayload::ThreadFailed { thread_id, .. } => Some(thread_id.as_str()),
        EventPayload::ApprovalRequested { thread_id, .. } => Some(thread_id.as_str()),
        _ => None,
    }
}

/// Event types that create activity entries.
pub const ACTIVITY_TYPES: &[&str] = &[
    "thread.completed",
    "thread.failed",
    "approval.requested",
    "workspace.created",
    "workspace.opened",
];
