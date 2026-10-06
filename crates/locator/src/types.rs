//! Wire types for the Session Locator, the workspace rail, the returning-user home and recent
//! work (Z7-W2).
//!
//! These follow the proposed contracts in `docs/CONTRACTS_ADVANCED.md` §6.3 (LOC) and §6.10
//! (`HomeSummary`, `RecentWorkItem`, `WorkspaceGroup`, `ProviderRow`, `WorkspaceRailEntry`,
//! `RailState`). They live in this crate until the lead moves them into `crates/contracts`
//! (campaigns never edit contracts); the JSON shapes are chosen so the move changes nothing on the
//! wire. Differences from the sketch are listed in `docs/campaigns/Z7-W2.md` §7.

use kalcode_contracts::agent::ProviderId;
use kalcode_contracts::refs::{Page, PageRequest};
use kalcode_contracts::threads::ThreadStatus;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

// ---------------------------------------------------------------------------------------------
// Session Locator
// ---------------------------------------------------------------------------------------------

/// What a locator entry names. The first five are indexed today; the rest are reserved for the
/// systems that will feed them (agents, missions, tasks, worktrees, automations, files, commands).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum LocatorEntityKind {
    Thread,
    Workspace,
    RemoteWorkspace,
    Terminal,
    Provider,
    Agent,
    Mission,
    Task,
    Worktree,
    Automation,
    File,
    Command,
    Activity,
}

impl LocatorEntityKind {
    pub const ALL: [LocatorEntityKind; 13] = [
        Self::Thread,
        Self::Workspace,
        Self::RemoteWorkspace,
        Self::Terminal,
        Self::Provider,
        Self::Agent,
        Self::Mission,
        Self::Task,
        Self::Worktree,
        Self::Automation,
        Self::File,
        Self::Command,
        Self::Activity,
    ];

    /// The value stored in `locator_entries.entity_kind` (same as the JSON form).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Thread => "thread",
            Self::Workspace => "workspace",
            Self::RemoteWorkspace => "remote_workspace",
            Self::Terminal => "terminal",
            Self::Provider => "provider",
            Self::Agent => "agent",
            Self::Mission => "mission",
            Self::Task => "task",
            Self::Worktree => "worktree",
            Self::Automation => "automation",
            Self::File => "file",
            Self::Command => "command",
            Self::Activity => "activity",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.as_str() == value)
    }
}

/// Result order.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum LocatorSort {
    #[default]
    Relevance,
    Recency,
}

/// Status filter classes (every indexed status maps to at most one class).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum LocatorStatusFilter {
    /// Starting, working, testing, reviewing, recovering threads; running terminals.
    Working,
    /// Permission required, waiting for you (failed threads are also listed under `failed`).
    NeedsYou,
    Done,
    Failed,
    /// Idle, paused, offline, stopped threads; ended terminals.
    Idle,
    Archived,
}

/// A recency window, in the person's local calendar (see `LocatorQuery::tz_offset_minutes`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum LocatorRecency {
    Today,
    Yesterday,
    ThisWeek,
    LastWeek,
    ThisMonth,
}

/// A search. `text` is never stored, logged or put into events (LOC-05).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct LocatorQuery {
    /// Free text. Words like "yesterday", "threads", "waiting", "codex" become filters.
    pub text: String,
    /// Empty = every kind.
    pub kinds: Vec<LocatorEntityKind>,
    /// Empty = any status.
    pub statuses: Vec<LocatorStatusFilter>,
    pub provider_id: Option<ProviderId>,
    pub workspace_id: Option<String>,
    /// Only entries updated in this window (combined with `since`).
    pub recency: Option<LocatorRecency>,
    /// Only entries updated at or after this RFC 3339 time.
    pub since: Option<String>,
    /// Only what is running or waiting now ("current activity").
    pub active_only: bool,
    pub sort: LocatorSort,
    /// Defaults to 20 results; at most 100.
    pub page: Option<PageRequest>,
    /// The person's UTC offset in minutes, for calendar words (today, yesterday). −840..=840.
    pub tz_offset_minutes: i32,
}

/// A character range `[start, end)` of `title` that matched the query (for highlighting).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MatchRange {
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LocatorResult {
    pub kind: LocatorEntityKind,
    pub entity_id: String,
    /// Already redacted (names can come from a first prompt).
    pub title: String,
    pub subtitle: Option<String>,
    /// The entry's status: a display status for threads (`working`, `permission_required`, …),
    /// `running`/`ended` for terminals, `available`/`missing`/`archived` for workspaces.
    pub status: Option<String>,
    pub workspace_id: Option<String>,
    pub provider_id: Option<String>,
    pub updated_at: String,
    /// Redacted context. Never message text: a match inside opted-in message text says so.
    pub snippet: Option<String>,
    pub score: f32,
    /// True only with an on-device embedding model installed (never today).
    pub semantic: bool,
    pub highlights: Vec<MatchRange>,
}

/// How the free text was understood, so the UI can show it as removable filter chips.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LocatorInterpretation {
    /// The words searched for (after filter words were taken out).
    pub terms: Vec<String>,
    /// Extra words searched because they mean the same thing ("auth" → "login", "sign in").
    pub expanded: Vec<String>,
    pub kinds: Vec<LocatorEntityKind>,
    pub statuses: Vec<LocatorStatusFilter>,
    pub recency: Option<LocatorRecency>,
    pub provider_id: Option<ProviderId>,
    pub active_only: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LocatorResponse {
    pub results: Page<LocatorResult>,
    pub interpreted: LocatorInterpretation,
    pub index: LocatorIndexState,
}

/// The index's health, shown next to results ("Indexing…", entry count).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LocatorIndexState {
    pub entries: u32,
    /// False until the first full index finished.
    pub ready: bool,
    /// False when the index lives in memory for this session only (schema v11 not installed).
    pub persistent: bool,
}

/// Where to go for an opened entry (`locator_open`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LocatorOpenTarget {
    pub kind: LocatorEntityKind,
    pub entity_id: String,
    pub workspace_id: Option<String>,
    pub thread_id: Option<String>,
    pub terminal_id: Option<String>,
    pub provider_id: Option<String>,
}

/// How an entry was opened (`session.located.via`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum LocatorVia {
    Palette,
    Rail,
    Home,
    Voice,
}

// ---------------------------------------------------------------------------------------------
// Workspace rail
// ---------------------------------------------------------------------------------------------

/// A user-made folder of workspaces in the rail.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WorkspaceGroup {
    pub id: String,
    pub name: String,
    pub position: u32,
    pub collapsed: bool,
}

/// One thread under a provider row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RailThread {
    pub id: String,
    pub name: String,
    pub status: ThreadStatus,
    /// Whether the provider can resume its own historical conversation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub resumable: Option<bool>,
    pub last_activity_at: String,
    pub pending_approvals: u32,
}

/// A workspace's threads for one provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProviderRow {
    pub provider_id: ProviderId,
    pub provider_name: String,
    pub threads: u32,
    pub working: u32,
    pub needs_you: u32,
    /// Most recently active first; at most 25 (the count above is the full number).
    pub items: Vec<RailThread>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WorkspaceRailEntry {
    pub workspace_id: String,
    /// The rail name (the folder's name unless renamed in the rail).
    pub name: String,
    /// The folder's own name.
    pub folder_name: String,
    /// The folder with the home directory shown as `~`.
    pub display_path: String,
    /// `local` today; `ssh` with Distributed Workspaces.
    pub location: String,
    /// False when the folder was moved or deleted outside KalCode.
    pub available: bool,
    pub active: bool,
    pub pinned: bool,
    pub archived: bool,
    pub group_id: Option<String>,
    pub collapsed: bool,
    /// Message-text search is on for this workspace (off by default).
    pub index_messages: bool,
    pub providers: Vec<ProviderRow>,
    pub threads: u32,
    pub working: u32,
    pub needs_you: u32,
    pub last_opened_at: String,
    /// Newest thread activity, or `last_opened_at`.
    pub last_activity_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RailGroupView {
    pub group: WorkspaceGroup,
    pub workspaces: Vec<WorkspaceRailEntry>,
}

/// The rail's fixed sections, which can be collapsed — and `rail`, the whole rail column.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum RailSection {
    Pinned,
    Recent,
    Folders,
    Archived,
    /// The rail column itself (hidden with Ctrl+Shift+B).
    Rail,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RailState {
    /// In the order the person arranged them.
    pub pinned: Vec<WorkspaceRailEntry>,
    /// Not pinned, not in a folder, not archived; most recently used first.
    pub recent: Vec<WorkspaceRailEntry>,
    pub groups: Vec<RailGroupView>,
    pub archived: Vec<WorkspaceRailEntry>,
    pub collapsed_sections: Vec<RailSection>,
    /// False when rail changes last only for this session (schema v11 not installed).
    pub persistent: bool,
}

/// A change to one workspace's rail state. Absent fields stay as they are.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct RailUpdate {
    pub workspace_id: String,
    #[serde(default)]
    #[ts(optional)]
    pub pinned: Option<bool>,
    /// A folder id to move the workspace into, or `""` to take it out of its folder.
    #[serde(default)]
    #[ts(optional)]
    pub group_id: Option<String>,
    /// Position within its section (pinned or folder).
    #[serde(default)]
    #[ts(optional)]
    pub position: Option<u32>,
    #[serde(default)]
    #[ts(optional)]
    pub collapsed: Option<bool>,
    #[serde(default)]
    #[ts(optional)]
    pub archived: Option<bool>,
    /// The rail name (1–80 characters); an empty value shows the folder's name again.
    #[serde(default)]
    #[ts(optional)]
    pub name: Option<String>,
    /// Turn message-text search for this workspace on or off.
    #[serde(default)]
    #[ts(optional)]
    pub index_messages: Option<bool>,
}

// ---------------------------------------------------------------------------------------------
// Home and recent work
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum RecentWorkKind {
    Thread,
    File,
    Workspace,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RecentWorkItem {
    pub kind: RecentWorkKind,
    /// Thread or workspace id; for files, the workspace-relative path.
    pub id: String,
    pub title: String,
    pub workspace_id: Option<String>,
    pub workspace_name: Option<String>,
    pub provider_id: Option<ProviderId>,
    pub provider_name: Option<String>,
    /// Threads only.
    pub status: Option<ThreadStatus>,
    /// Threads only; `None` for file and workspace items.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub resumable: Option<bool>,
    pub last_activity_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum RecentWorkWhen {
    Today,
    Yesterday,
    ThisWeek,
}

/// The returning-user home, derived from real state only (ADVANCED.md §16.4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HomeSummary {
    /// Chosen natively from a fixed pool; never one of the last five shown.
    pub greeting: String,
    /// Settings `profile.displayName`; `null` ⇒ the greeting is "Welcome back.".
    pub display_name: Option<String>,
    /// Nothing has happened yet (no workspace and no thread).
    pub first_run: bool,
    /// What was I working on: threads and workspaces active in the previous session.
    pub last_session: Vec<RecentWorkItem>,
    /// What's running now (most recent first, at most 8; `running_count` is the full number).
    pub running: Vec<RecentWorkItem>,
    pub running_count: u32,
    /// What needs me: permission required, waiting for me, failed (at most 8).
    pub needs_you: Vec<RecentWorkItem>,
    pub needs_you_count: u32,
    /// What finished since my last visit (`home.lastSeenSeq`).
    pub finished_since_last_visit: Vec<RecentWorkItem>,
    /// What can I resume: stopped or paused threads the provider can resume.
    pub resumable: Vec<RecentWorkItem>,
    pub recent_workspaces: Vec<WorkspaceRailEntry>,
    pub workspace_count: u32,
    pub thread_count: u32,
}

/// `recent_work` answer.
pub type RecentWorkPage = Page<RecentWorkItem>;

#[cfg(test)]
mod compatibility_tests {
    use super::{RailThread, RecentWorkItem};

    #[test]
    fn older_view_payloads_default_missing_resume_facts() {
        let rail: RailThread = serde_json::from_value(serde_json::json!({
            "id": "t",
            "name": "Historical",
            "status": "interrupted",
            "lastActivityAt": "2026-10-05T12:00:00Z",
            "pendingApprovals": 0
        }))
        .expect("older rail payload");
        assert_eq!(rail.resumable, None);

        let recent: RecentWorkItem = serde_json::from_value(serde_json::json!({
            "kind": "thread",
            "id": "t",
            "title": "Historical",
            "workspaceId": "w",
            "workspaceName": "KalCode",
            "providerId": "codex",
            "providerName": "Codex",
            "status": "interrupted",
            "lastActivityAt": "2026-10-05T12:00:00Z"
        }))
        .expect("older recent-work payload");
        assert_eq!(recent.resumable, None);
    }
}
