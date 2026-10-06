//! Threads: persistent units of AI work (campaign Z3). Status is structured runtime truth,
//! never inferred from model prose.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::agent::{ModelInfo, PermissionMapping, ProviderId};
use crate::permissions::PermissionMode;
use crate::workspace_ui::{DashboardChip, DisplayQualifier, DisplayStatus};

/// Normalized thread states (directive §7.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ThreadStatus {
    Starting,
    Active,
    Thinking,
    RunningTool,
    RunningCommand,
    Editing,
    Testing,
    Reviewing,
    Idle,
    WaitingForPermission,
    WaitingForUser,
    WaitingForDependency,
    Paused,
    Completed,
    Failed,
    Interrupted,
    Recovering,
    Offline,
}

impl ThreadStatus {
    /// A process is (or should be) doing work for this thread.
    pub fn is_live(self) -> bool {
        matches!(
            self,
            Self::Starting
                | Self::Active
                | Self::Thinking
                | Self::RunningTool
                | Self::RunningCommand
                | Self::Editing
                | Self::Testing
                | Self::Reviewing
                | Self::Recovering
        )
    }

    /// The thread cannot continue until someone acts.
    pub fn needs_attention(self) -> bool {
        matches!(
            self,
            Self::WaitingForPermission | Self::WaitingForUser | Self::Failed
        )
    }

    /// No further transitions except an explicit restart/resume.
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Interrupted)
    }

    /// Every status, in declaration order.
    pub const ALL: [ThreadStatus; 18] = [
        Self::Starting,
        Self::Active,
        Self::Thinking,
        Self::RunningTool,
        Self::RunningCommand,
        Self::Editing,
        Self::Testing,
        Self::Reviewing,
        Self::Idle,
        Self::WaitingForPermission,
        Self::WaitingForUser,
        Self::WaitingForDependency,
        Self::Paused,
        Self::Completed,
        Self::Failed,
        Self::Interrupted,
        Self::Recovering,
        Self::Offline,
    ];

    /// The normalized display status (ADVANCED.md §16.3), a pure function of the runtime status.
    /// `interrupted` shows as IDLE with a qualifier (there is no STOPPED display status).
    /// `waiting_for_dependency` shows as WAITING, never IDLE: its provider process has not
    /// started (owner directive 2026-10-04). Mirrored by `displayStatusOf` in `packages/protocol`.
    pub fn display(self) -> (DisplayStatus, Option<DisplayQualifier>) {
        use DisplayStatus as D;
        match self {
            Self::Starting => (D::Starting, None),
            Self::Active
            | Self::Thinking
            | Self::RunningTool
            | Self::RunningCommand
            | Self::Editing => (D::Working, None),
            Self::Testing => (D::Testing, None),
            Self::Reviewing => (D::Reviewing, None),
            Self::WaitingForPermission => (D::PermissionRequired, None),
            Self::WaitingForUser => (D::WaitingForYou, None),
            Self::Idle => (D::Idle, None),
            Self::WaitingForDependency => (D::Waiting, Some(DisplayQualifier::WaitingOnDependency)),
            Self::Interrupted => (D::Idle, Some(DisplayQualifier::StoppedResumable)),
            Self::Paused => (D::Paused, None),
            Self::Completed => (D::Done, None),
            Self::Failed => (D::Failed, None),
            Self::Recovering => (D::Recovering, None),
            Self::Offline => (D::Offline, None),
        }
    }

    /// The Dashboard chip a thread counts under. FAILED counts under "Waiting for you" because
    /// it needs attention.
    pub fn chip(self) -> DashboardChip {
        match self.display().0 {
            DisplayStatus::Starting
            | DisplayStatus::Working
            | DisplayStatus::Testing
            | DisplayStatus::Reviewing
            | DisplayStatus::Waiting
            | DisplayStatus::Recovering => DashboardChip::Working,
            DisplayStatus::PermissionRequired
            | DisplayStatus::WaitingForYou
            | DisplayStatus::Failed => DashboardChip::WaitingForYou,
            DisplayStatus::Idle | DisplayStatus::Paused | DisplayStatus::Offline => {
                DashboardChip::Idle
            }
            DisplayStatus::Done => DashboardChip::Done,
        }
    }
}

/// How a thread's provider runs (ADVANCED.md §16.1): the real CLI in a PTY pane, or the headless
/// stream runtime (missions, automations, delegations, handoffs).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ThreadRuntimeKind {
    Headless,
    InteractivePty,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum MessageRole {
    User,
    Assistant,
    System,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ThreadError {
    pub code: String,
    /// User-safe explanation: what failed, what is safe, what to do.
    pub message: String,
}

/// Stable `ThreadError.code` values the runtime and the provider adapters write. Codes persisted
/// by older builds keep their meaning; [`ThreadErrorKind::of_code`] classifies both.
pub mod error_codes {
    /// The Resource Governor is holding the launch or turn; KalCode re-checks on each sample.
    pub const WAITING_FOR_RESOURCES: &str = "waiting_for_resources";
    /// The bounded wait for system resources ended; nothing was started. Resume retries.
    pub const RESOURCES_UNAVAILABLE: &str = "resources_unavailable";
    pub const PROVIDER_START_FAILED: &str = "provider_start_failed";
    /// The session's provider process ended unexpectedly.
    pub const PROVIDER_EXITED: &str = "provider_exited";
    /// One turn's provider process ended unexpectedly (turn-based providers).
    pub const PROCESS_EXITED: &str = "process_exited";
    pub const PROVIDER_NOT_AUTHENTICATED: &str = "provider_not_authenticated";
    pub const PROVIDER_NOT_INSTALLED: &str = "provider_not_installed";
    pub const PROVIDER_VERSION_UNSUPPORTED: &str = "provider_version_unsupported";
    /// Codex refused Approve/Auto outside a Git repository (its own trusted-directory guard).
    pub const CODEX_APPROVE_REQUIRES_GIT: &str = "codex_approve_requires_git";
    /// The provider's service no longer accepts this account type (e.g. Gemini CLI for
    /// "Gemini Code Assist for individuals").
    pub const PROVIDER_ACCOUNT_INELIGIBLE: &str = "provider_account_ineligible";
    pub const PROVIDER_ACCOUNT_BUSY: &str = "provider_account_busy";
    pub const PROVIDER_ACCOUNT_PLAN_UNSUPPORTED: &str = "provider_account_plan_unsupported";
    pub const PROVIDER_ACCOUNT_PLAN_UNVERIFIED: &str = "provider_account_plan_unverified";
    pub const PROVIDER_ACCOUNT_CHECK_FAILED: &str = "provider_account_check_failed";
}

/// What kind of problem a `ThreadError` reports, derived from its stable code. Surfaces use it
/// to title and tone the problem; the message itself always comes from the runtime. Mirrored by
/// `threadErrorKindOf` in `packages/protocol` (a Rust test keeps the two identical).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ThreadErrorKind {
    /// Waiting for system resources (not a failure; KalCode keeps checking).
    WaitingForResources,
    /// The wait for system resources ended without starting anything; Resume retries.
    ResourcesUnavailable,
    /// The provider process could not be started.
    ProviderStartFailed,
    /// The provider process ended unexpectedly.
    ProviderProcessExited,
    /// The account is not signed in for this provider.
    AuthRequired,
    /// KalCode or the provider's service refused this account (in use, plan, account type).
    AccountRefused,
    /// The installed provider version is not supported.
    UnsupportedVersion,
    /// Codex refused Approve mode outside a Git repository.
    NonGitApproveGuard,
    /// The provider is not installed.
    ProviderNotInstalled,
    /// Any other problem the provider or KalCode reported.
    Other,
}

impl ThreadErrorKind {
    pub fn of_code(code: &str) -> Self {
        use error_codes as c;
        match code {
            c::WAITING_FOR_RESOURCES => Self::WaitingForResources,
            c::RESOURCES_UNAVAILABLE => Self::ResourcesUnavailable,
            c::PROVIDER_START_FAILED => Self::ProviderStartFailed,
            c::PROVIDER_EXITED | c::PROCESS_EXITED => Self::ProviderProcessExited,
            c::PROVIDER_NOT_AUTHENTICATED => Self::AuthRequired,
            c::PROVIDER_ACCOUNT_INELIGIBLE
            | c::PROVIDER_ACCOUNT_BUSY
            | c::PROVIDER_ACCOUNT_PLAN_UNSUPPORTED
            | c::PROVIDER_ACCOUNT_PLAN_UNVERIFIED
            | c::PROVIDER_ACCOUNT_CHECK_FAILED => Self::AccountRefused,
            c::PROVIDER_VERSION_UNSUPPORTED => Self::UnsupportedVersion,
            c::CODEX_APPROVE_REQUIRES_GIT => Self::NonGitApproveGuard,
            c::PROVIDER_NOT_INSTALLED => Self::ProviderNotInstalled,
            _ => Self::Other,
        }
    }

    /// Nothing reached the provider: the launch was held or refused before a provider process
    /// received the message.
    pub fn before_delivery(self) -> bool {
        matches!(
            self,
            Self::WaitingForResources
                | Self::ResourcesUnavailable
                | Self::ProviderStartFailed
                | Self::AuthRequired
                | Self::AccountRefused
                | Self::UnsupportedVersion
                | Self::ProviderNotInstalled
        )
    }
}

/// The thread fields every surface shows (Threads list, Dashboard cards, KalVoice status reports).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ThreadSummary {
    /// Whether this conversation can safely move to another workspace right now.
    #[serde(default)]
    #[ts(optional)]
    pub can_move_workspace: Option<bool>,
    pub id: String,
    pub name: String,
    pub provider_id: ProviderId,
    pub provider_name: String,
    pub model: Option<String>,
    /// Provider-native reasoning effort. Missing means the provider default.
    #[serde(default)]
    pub effort: Option<String>,
    /// Stable selected provider-account metadata id; never a credential.
    #[serde(default)]
    pub provider_account_id: Option<String>,
    /// Account label such as "Personal"; never a credential.
    pub account_label: Option<String>,
    pub workspace_id: String,
    pub workspace_name: String,
    pub permission_mode: PermissionMode,
    pub status: ThreadStatus,
    /// What the thread is doing now, from structured tool/status events (e.g. "Running npm test").
    pub current_activity: Option<String>,
    pub created_at: String,
    pub last_activity_at: String,
    pub pending_approvals: u32,
    pub unread_messages: u32,
    pub files_changed: Option<u32>,
    /// The Git branch of the thread's own worktree (see `worktree_id`); `null` for a thread that
    /// runs in the workspace folder.
    pub branch: Option<String>,
    pub error: Option<ThreadError>,
    // ---- Adopted in CA-1 (Z3 / Z4 / Z7 requests). Defaulted so older JSON still decodes. ----
    /// When the thread was archived; `null` for open threads.
    #[serde(default)]
    pub archived_at: Option<String>,
    /// Resuming restores the provider's own conversation (the provider supports resume and a
    /// provider session id is stored). `false`: resume starts a fresh provider session.
    #[serde(default)]
    pub resumable: bool,
    /// This interactive coding-agent pane was interrupted because KalCode exited and is safe to
    /// offer through startup recovery. The desktop stamps this only after it has established the
    /// durable `interactive_pty` identity; core thread summaries default to `false`.
    #[serde(default)]
    #[ts(optional)]
    pub restart_recoverable: Option<bool>,
    /// The Custom permission profile a Custom-mode thread uses (`threads.permission_profile_id`).
    #[serde(default)]
    pub permission_profile_id: Option<String>,
    /// How the provider runs. `null` until L-2 stores it (today every thread is headless).
    #[serde(default)]
    pub runtime_kind: Option<ThreadRuntimeKind>,
    /// The PTY terminal of an interactive provider pane (L-2 / Z7-W4).
    #[serde(default)]
    pub terminal_id: Option<String>,
    /// The KalCode-managed Git worktree the thread runs in (`git_worktrees` row with purpose
    /// `thread`, owned by this thread, still active). `null`: the thread runs in the workspace
    /// folder.
    #[serde(default)]
    pub worktree_id: Option<String>,
}

/// Git facts about a thread's own worktree (`thread_worktree_states`), from which the UI decides
/// whether the agent's work is ready to merge and whether agents edit the same files. Computed
/// natively on request; filesystem locations never cross IPC (only repository-relative file
/// names do).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ThreadWorktreeState {
    pub thread_id: String,
    pub worktree_id: String,
    /// The worktree's branch (`kal/...`).
    pub branch: String,
    /// The branch checked out in the workspace's main folder, which the worktree branch would
    /// merge into; `null` when that folder is on a detached HEAD.
    pub base_branch: Option<String>,
    /// Commits on the worktree branch that the base branch doesn't have; `null` when unknown.
    pub ahead: Option<u32>,
    /// Commits on the base branch that the worktree branch doesn't have; `null` when unknown.
    pub behind: Option<u32>,
    /// Uncommitted changes (modified, staged, deleted, renamed, conflicted) in the worktree.
    pub changed: u32,
    /// Untracked (not ignored) files in the worktree.
    pub untracked: u32,
    /// Whether merging the worktree branch into the base branch would conflict. `null` when
    /// unknown (no base branch, Git older than 2.38, or a repository-defined merge driver).
    pub conflicts: Option<bool>,
    /// Files the agent touched, relative to the repository top level: committed on the branch
    /// since it forked from the base, plus uncommitted and untracked files. Sorted, at most 200.
    #[serde(default)]
    pub changed_paths: Vec<String>,
    /// More files changed than `changed_paths` lists.
    #[serde(default)]
    pub changed_paths_truncated: bool,
    /// When these facts were read (RFC 3339).
    pub observed_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ThreadMessage {
    pub id: String,
    pub thread_id: String,
    pub role: MessageRole,
    pub content: String,
    pub created_at: String,
}

/// A provider the user can start a thread with (from the provider registry). Moved from
/// `kalcode_threads::types` in CA-1 with identical JSON.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProviderOption {
    pub id: ProviderId,
    pub display_name: String,
    /// Account label such as "Personal"; never a credential.
    pub account_label: Option<String>,
    pub models: Vec<ModelInfo>,
    pub supports_resume: bool,
    pub supports_interrupt: bool,
    /// The provider routes permission prompts to KalCode for a decision.
    pub host_approvals: bool,
    pub permission_mappings: Vec<PermissionMapping>,
}

/// A workspace a thread can run in (from the workspace resolver). Paths never cross IPC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WorkspaceOption {
    pub id: String,
    pub name: String,
}

/// Everything the New thread flow needs to offer valid choices (`thread_options`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ThreadOptions {
    pub providers: Vec<ProviderOption>,
    pub workspaces: Vec<WorkspaceOption>,
    /// Modes a thread can be created with. Bypass and Custom are set later, through the
    /// permission engine, by an explicit user action.
    pub permission_modes: Vec<PermissionMode>,
    pub default_permission_mode: PermissionMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ToolCallStatus {
    Requested,
    Running,
    Completed,
    Failed,
    /// The session ended (stop, crash, interrupt) before the tool finished.
    Cancelled,
}

/// One tool call a thread's provider made, from structured tool events (`thread_tool_calls`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ToolCallRecord {
    pub id: String,
    pub thread_id: String,
    pub tool: String,
    pub summary: String,
    pub status: ToolCallStatus,
    pub result_summary: Option<String>,
    pub requested_at: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

/// `thread_create` input. `confirm_bypass` and `profile_id` were added in CA-1: Bypass may only be
/// chosen by a user action with `confirmBypass: true`, and Custom needs a profile. The runtime
/// still refuses Bypass and Custom at creation (they are set afterwards through
/// `thread_set_permission_mode`) until it supports them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ThreadCreateInput {
    pub provider_id: String,
    /// Explicit account selection. The desktop resolves and validates this id before creation.
    #[serde(default)]
    pub provider_account_id: Option<String>,
    pub workspace_id: String,
    pub model: Option<String>,
    pub permission_mode: PermissionMode,
    pub prompt: String,
    pub name: Option<String>,
    #[serde(default)]
    pub confirm_bypass: Option<bool>,
    #[serde(default)]
    pub profile_id: Option<String>,
    /// `true`: the thread gets its own Git worktree and branch (`kal/<name>-<id>`) so parallel
    /// agents never share a folder; refused with `worktree_unavailable` when the workspace isn't
    /// in a Git repository. Absent or `false`: the thread runs in the workspace folder.
    #[serde(default)]
    pub isolate: Option<bool>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_groups_are_consistent() {
        use ThreadStatus::*;
        let all = [
            Starting,
            Active,
            Thinking,
            RunningTool,
            RunningCommand,
            Editing,
            Testing,
            Reviewing,
            Idle,
            WaitingForPermission,
            WaitingForUser,
            WaitingForDependency,
            Paused,
            Completed,
            Failed,
            Interrupted,
            Recovering,
            Offline,
        ];
        assert_eq!(all.len(), 18);
        for status in all {
            assert!(!(status.is_live() && status.is_terminal()), "{status:?}");
        }
        assert_eq!(
            serde_json::to_string(&WaitingForPermission).expect("json"),
            "\"waiting_for_permission\""
        );
    }

    /// Exhaustive: every runtime status maps to exactly one display status, and the mapping is
    /// the documented table (ADVANCED.md §16.3).
    #[test]
    fn display_mapping_is_total_and_matches_the_table() {
        use DisplayQualifier as Q;
        use DisplayStatus as D;
        use ThreadStatus::*;
        let table = [
            (Starting, D::Starting, None, DashboardChip::Working),
            (Active, D::Working, None, DashboardChip::Working),
            (Thinking, D::Working, None, DashboardChip::Working),
            (RunningTool, D::Working, None, DashboardChip::Working),
            (RunningCommand, D::Working, None, DashboardChip::Working),
            (Editing, D::Working, None, DashboardChip::Working),
            (Testing, D::Testing, None, DashboardChip::Working),
            (Reviewing, D::Reviewing, None, DashboardChip::Working),
            (Idle, D::Idle, None, DashboardChip::Idle),
            (
                WaitingForPermission,
                D::PermissionRequired,
                None,
                DashboardChip::WaitingForYou,
            ),
            (
                WaitingForUser,
                D::WaitingForYou,
                None,
                DashboardChip::WaitingForYou,
            ),
            (
                WaitingForDependency,
                D::Waiting,
                Some(Q::WaitingOnDependency),
                DashboardChip::Working,
            ),
            (Paused, D::Paused, None, DashboardChip::Idle),
            (Completed, D::Done, None, DashboardChip::Done),
            (Failed, D::Failed, None, DashboardChip::WaitingForYou),
            (
                Interrupted,
                D::Idle,
                Some(Q::StoppedResumable),
                DashboardChip::Idle,
            ),
            (Recovering, D::Recovering, None, DashboardChip::Working),
            (Offline, D::Offline, None, DashboardChip::Idle),
        ];
        assert_eq!(table.len(), ThreadStatus::ALL.len());
        for ((status, display, qualifier, chip), listed) in table.into_iter().zip(ThreadStatus::ALL)
        {
            assert_eq!(status, listed, "table order");
            assert_eq!(status.display(), (display, qualifier), "{status:?}");
            assert_eq!(status.chip(), chip, "{status:?}");
        }
        // Every one of the 13 display statuses is reachable.
        let reached: std::collections::HashSet<_> =
            ThreadStatus::ALL.iter().map(|s| s.display().0).collect();
        assert_eq!(reached.len(), DisplayStatus::ALL.len());
        // Needs-attention runtime statuses all land on "Waiting for you".
        for status in ThreadStatus::ALL {
            if status.needs_attention() {
                assert_eq!(status.chip(), DashboardChip::WaitingForYou, "{status:?}");
            }
        }
    }

    /// `packages/protocol/src/thread-errors.ts` mirrors `ThreadErrorKind::of_code` row for row,
    /// and codes persisted by older builds keep their kinds.
    #[test]
    fn thread_error_kinds_match_the_protocol_mirror_and_old_codes() {
        let ts = include_str!("../../../packages/protocol/src/thread-errors.ts");
        let start = ts
            .find("export const THREAD_ERROR_KIND_OF_CODE = {")
            .expect("table");
        let body = &ts[start..];
        let body = &body[..body.find("} as const").expect("end of table")];
        let rows: Vec<(String, String)> = body
            .lines()
            .skip(1)
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(|line| {
                let (code, kind) = line.split_once(':').expect("row");
                (
                    code.trim().to_owned(),
                    kind.trim()
                        .trim_end_matches(',')
                        .trim_matches('"')
                        .to_owned(),
                )
            })
            .collect();
        use error_codes as c;
        let codes = [
            c::WAITING_FOR_RESOURCES,
            c::RESOURCES_UNAVAILABLE,
            c::PROVIDER_START_FAILED,
            c::PROVIDER_EXITED,
            c::PROCESS_EXITED,
            c::PROVIDER_NOT_AUTHENTICATED,
            c::PROVIDER_ACCOUNT_INELIGIBLE,
            c::PROVIDER_ACCOUNT_BUSY,
            c::PROVIDER_ACCOUNT_PLAN_UNSUPPORTED,
            c::PROVIDER_ACCOUNT_PLAN_UNVERIFIED,
            c::PROVIDER_ACCOUNT_CHECK_FAILED,
            c::PROVIDER_VERSION_UNSUPPORTED,
            c::CODEX_APPROVE_REQUIRES_GIT,
            c::PROVIDER_NOT_INSTALLED,
        ];
        assert_eq!(rows.len(), codes.len(), "every known code is mirrored");
        for ((code, kind), expected) in rows.iter().zip(codes) {
            assert_eq!(code, expected, "table order");
            let wire = serde_json::to_value(ThreadErrorKind::of_code(code)).expect("json");
            assert_eq!(wire.as_str(), Some(kind.as_str()), "{code}");
        }
        // Persisted before this build: still classified, and unknown codes are "other".
        assert_eq!(
            ThreadErrorKind::of_code("provider_start_failed"),
            ThreadErrorKind::ProviderStartFailed
        );
        assert_eq!(
            ThreadErrorKind::of_code("provider_exited"),
            ThreadErrorKind::ProviderProcessExited
        );
        assert_eq!(
            ThreadErrorKind::of_code("turn_success"),
            ThreadErrorKind::Other
        );
        assert!(ThreadErrorKind::ResourcesUnavailable.before_delivery());
        assert!(!ThreadErrorKind::ProviderProcessExited.before_delivery());
    }

    #[test]
    fn summaries_without_ca1_fields_still_decode() {
        let json = serde_json::json!({
            "id": "t", "name": "n", "providerId": "claude-code", "providerName": "Claude Code",
            "model": null, "accountLabel": null, "workspaceId": "w", "workspaceName": "ws",
            "permissionMode": "approve", "status": "idle", "currentActivity": null,
            "createdAt": "", "lastActivityAt": "", "pendingApprovals": 0, "unreadMessages": 0,
            "filesChanged": null, "branch": null, "error": null
        });
        let summary: ThreadSummary = serde_json::from_value(json).expect("decode");
        assert_eq!(summary.archived_at, None);
        assert_eq!(summary.provider_account_id, None);
        assert_eq!(summary.effort, None);
        assert!(!summary.resumable);
        assert_eq!(summary.restart_recoverable, None);
        assert_eq!(summary.permission_profile_id, None);
        assert_eq!(summary.runtime_kind, None);
        let input: ThreadCreateInput = serde_json::from_value(serde_json::json!({
            "providerId": "claude-code", "workspaceId": "w", "model": null,
            "permissionMode": "approve", "prompt": "p", "name": null
        }))
        .expect("input");
        assert_eq!(input.provider_account_id, None);
        assert_eq!(input.confirm_bypass, None);
    }
}
