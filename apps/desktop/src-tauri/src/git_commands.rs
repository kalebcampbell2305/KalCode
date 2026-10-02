//! Git IPC commands (campaign Z6a): status, diff, log, branches, KalCode-managed worktrees and
//! checkpoints.
//!
//! **Not wired yet.** `lib.rs`, `build.rs` and `capabilities/main.json` are lead-applied hot
//! files; the exact lines are in `docs/campaigns/Z6a.md` §6. This file is written against the
//! wave-2 `Core` API (`Core::workspaces`, `Core::read`, `Core::write_with_events`).
//!
//! Rules every command follows (ARCHITECTURE.md §3, ADVANCED.md X-04):
//! * ids are validated natively; the WebView supplies **no paths** — files are named by opaque
//!   handles from earlier listings, workspace and worktree folders are resolved natively;
//! * every list is paged (limit 1..=500);
//! * git runs off the main thread and never while a database connection is held;
//! * nothing destructive is reachable from here: worktree removal is the safe mode only
//!   (uncommitted work refuses), and checkpoint *restore* is not exposed (Time Machine, P2,
//!   behind a native confirmation — ADVANCED.md §3 D8).
//!
//! Events: `EventPayload` has no `git.*` / `timeline.checkpoint_*` variants until CA-0. The
//! commands compute the facts (`kalcode_git::events::GitEvent`) and [`record`] turns them into
//! `NewEvent`s once the variants exist; until then they are logged, not persisted.

use std::path::Path;
use std::sync::Arc;

use kalcode_contracts::threads::ThreadWorktreeState;
use kalcode_core::events::NewEvent;
use kalcode_core::{ErrorCategory, IpcError, KalError};
use kalcode_git::checkpoint::CreateOutcome;
use kalcode_git::diff::{Diff, DiffOptions, DiffTarget};
use kalcode_git::events::{GitEvent, trigger_kind};
use kalcode_git::log::{Branch, Commit};
use kalcode_git::status::{BranchState, StatusFile};
use kalcode_git::store;
use kalcode_git::types::{
    Checkpoint, CheckpointTrigger, FileHandle, GitStatusSummary, Page, PageRequest, Worktree,
    WorktreePurpose, WorktreeStatus, page_of,
};
use kalcode_git::worktree::{self, RemoveMode};
use kalcode_git::{GitCore, WorkspaceRoot};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::AppState;

/// Managed state: the Git core (located `git`, handles, indexes, checkpoint store).
pub struct GitState(pub Arc<GitCore>);

impl GitState {
    /// `data_dir` is KalCode's data folder (`AppState::paths.data_dir`).
    pub fn new(data_dir: &Path) -> Self {
        Self(Arc::new(GitCore::new(data_dir)))
    }
}

fn invalid_id() -> KalError {
    KalError::validation("invalid_id", "That id isn't valid.")
}

/// Resolves a workspace id to its canonical root (natively, from the workspace record).
pub(crate) fn workspace_root(
    state: &AppState,
    workspace_id: &str,
) -> Result<WorkspaceRoot, KalError> {
    if !kalcode_contracts::ids::is_valid_id(workspace_id) {
        return Err(invalid_id());
    }
    let core = state.core.as_ref().ok_or_else(|| {
        KalError::internal("core_unavailable", "KalCode's runtime is not available.")
    })?;
    workspace_root_in(core, workspace_id)
}

/// [`workspace_root`] from the `Core` directly.
pub(crate) fn workspace_root_in(
    core: &kalcode_core::Core,
    workspace_id: &str,
) -> Result<WorkspaceRoot, KalError> {
    if !kalcode_contracts::ids::is_valid_id(workspace_id) {
        return Err(invalid_id());
    }
    let workspace = core
        .workspaces()?
        .into_iter()
        .find(|w| w.id == workspace_id)
        .ok_or_else(|| {
            KalError::new(
                ErrorCategory::Validation,
                "workspace_unknown",
                "That workspace no longer exists.",
            )
        })?;
    WorkspaceRoot::new(&workspace.id, Path::new(&workspace.root_path))
}

/// Resolves the folder a Git command runs in: the workspace, or one of its KalCode worktrees.
/// Handles are then scoped to that folder's id.
fn target_root(
    state: &AppState,
    workspace_id: &str,
    worktree_id: Option<&str>,
) -> Result<WorkspaceRoot, KalError> {
    let root = workspace_root(state, workspace_id)?;
    let Some(worktree_id) = worktree_id else {
        return Ok(root);
    };
    let core = state.core.as_ref().ok_or_else(|| {
        KalError::internal("core_unavailable", "KalCode's runtime is not available.")
    })?;
    let (row, path) = core.read(|conn| {
        Ok((
            store::get_worktree(conn, worktree_id)?,
            store::worktree_path(conn, worktree_id)?,
        ))
    })?;
    if row.workspace_id != workspace_id || row.status == WorktreeStatus::Removed {
        return Err(KalError::new(
            ErrorCategory::Git,
            "worktree_unknown",
            "That worktree no longer exists.",
        ));
    }
    WorkspaceRoot::new(&row.id, &path)
}

/// Runs blocking Git work off the async runtime and converts errors for IPC.
async fn blocking<T: Send + 'static>(
    access: crate::runtime_coordinator::RuntimeAccess,
    command: &'static str,
    work: impl FnOnce() -> Result<T, KalError> + Send + 'static,
) -> Result<T, IpcError> {
    tauri::async_runtime::spawn_blocking(move || {
        access.revalidate_core()?;
        work()
    })
    .await
    .map_err(|e| {
        KalError::internal("git_interrupted", "The Git operation was interrupted.")
            .with_source(e)
            .log_and_convert(command)
    })?
    .map_err(|e| e.log_and_convert(command))
}

/// Maps Git event facts to stored events. Returns nothing until CA-0 adds the variants to
/// `EventPayload` (see the table in `docs/campaigns/Z6a.md` §7); the facts are logged meanwhile.
fn record(events: Vec<GitEvent>) -> Vec<NewEvent> {
    for event in &events {
        tracing::info!(
            event = event.event_type(),
            workspace_id = event.workspace_id()
        );
    }
    Vec::new()
}

// ---------- Status, diff, log, branches (read-only) ----------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusArgs {
    pub workspace_id: String,
    pub worktree_id: Option<String>,
    pub page: PageRequest,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusResponse {
    /// False when the folder isn't in a Git repository (not an error).
    pub repository: bool,
    pub summary: Option<GitStatusSummary>,
    pub branch: Option<BranchState>,
    pub files: Page<StatusFile>,
    pub truncated: bool,
}

#[tauri::command(async)]
pub async fn git_status(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    git: crate::runtime_coordinator::RuntimeState<GitState>,
    args: GitStatusArgs,
) -> Result<GitStatusResponse, IpcError> {
    _runtime_access.revalidate()?;
    let root = target_root(&state, &args.workspace_id, args.worktree_id.as_deref())
        .map_err(|e| e.log_and_convert("git_status"))?;
    let core = Arc::clone(&git.0);
    blocking(_runtime_access, "git_status", move || {
        let view = core.status(&root)?;
        Ok(match view {
            None => GitStatusResponse {
                repository: false,
                summary: None,
                branch: None,
                files: page_of::<StatusFile>(&[], &args.page)?,
                truncated: false,
            },
            Some(view) => GitStatusResponse {
                repository: true,
                files: page_of(&view.files, &args.page)?,
                summary: Some(view.summary),
                branch: Some(view.branch),
                truncated: view.truncated,
            },
        })
    })
    .await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffArgs {
    pub workspace_id: String,
    pub worktree_id: Option<String>,
    pub target: DiffTarget,
    /// Limit to these files (handles from a listing, status or an earlier diff); ≤ 500.
    #[serde(default)]
    pub files: Vec<FileHandle>,
    /// 0..=20 (default 3).
    pub context_lines: Option<u32>,
}

#[tauri::command(async)]
pub async fn git_diff(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    git: crate::runtime_coordinator::RuntimeState<GitState>,
    args: GitDiffArgs,
) -> Result<Diff, IpcError> {
    _runtime_access.revalidate()?;
    let root = target_root(&state, &args.workspace_id, args.worktree_id.as_deref())
        .map_err(|e| e.log_and_convert("git_diff"))?;
    let core = Arc::clone(&git.0);
    blocking(_runtime_access, "git_diff", move || {
        let options = DiffOptions {
            context_lines: args.context_lines.unwrap_or(3).min(20),
            ..DiffOptions::default()
        };
        core.diff(&root, &args.target, &args.files, &options)
    })
    .await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLogArgs {
    pub workspace_id: String,
    pub worktree_id: Option<String>,
    pub page: PageRequest,
}

#[tauri::command(async)]
pub async fn git_log(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    git: crate::runtime_coordinator::RuntimeState<GitState>,
    args: GitLogArgs,
) -> Result<Page<Commit>, IpcError> {
    _runtime_access.revalidate()?;
    let root = target_root(&state, &args.workspace_id, args.worktree_id.as_deref())
        .map_err(|e| e.log_and_convert("git_log"))?;
    let core = Arc::clone(&git.0);
    blocking(_runtime_access, "git_log", move || {
        core.log(&root, args.page.limit, args.page.cursor.as_deref())
    })
    .await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceArgs {
    pub workspace_id: String,
}

#[tauri::command(async)]
pub async fn git_branches(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    git: crate::runtime_coordinator::RuntimeState<GitState>,
    args: WorkspaceArgs,
) -> Result<Vec<Branch>, IpcError> {
    _runtime_access.revalidate()?;
    let root = workspace_root(&state, &args.workspace_id)
        .map_err(|e| e.log_and_convert("git_branches"))?;
    let core = Arc::clone(&git.0);
    blocking(_runtime_access, "git_branches", move || {
        core.branches(&root)
    })
    .await
}

// ---------- Agent Fleet: threads in their own worktrees (read-only) ----------

/// Most threads one `thread_worktree_states` call accepts.
pub(crate) const MAX_THREAD_WORKTREE_STATES: usize = 64;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadWorktreeStatesArgs {
    pub thread_ids: Vec<String>,
}

/// At most [`MAX_THREAD_WORKTREE_STATES`] valid thread ids, duplicates dropped (order kept).
pub(crate) fn thread_ids_arg(ids: Vec<String>) -> Result<Vec<String>, KalError> {
    if ids.len() > MAX_THREAD_WORKTREE_STATES
        || ids
            .iter()
            .any(|id| !kalcode_contracts::ids::is_valid_id(id))
    {
        return Err(KalError::validation(
            "invalid_thread_ids",
            "Those thread references aren't valid.",
        ));
    }
    let mut unique: Vec<String> = Vec::with_capacity(ids.len());
    for id in ids {
        if !unique.contains(&id) {
            unique.push(id);
        }
    }
    Ok(unique)
}

/// Git facts for each thread's own worktree, computed without changing any work tree, index or
/// ref (see `kalcode_git::worktree::merge_conflicts`). One repository discovery and base branch
/// per workspace. Threads without an active worktree, whose worktree folder is gone, or whose
/// facts can't be read are left out.
pub(crate) fn thread_worktree_states_for(
    git: &GitCore,
    bound: Vec<(String, Worktree, std::path::PathBuf, WorkspaceRoot)>,
) -> Vec<ThreadWorktreeState> {
    use std::collections::HashMap;

    let Ok(exe) = git.git() else {
        return Vec::new();
    };
    type Base = (kalcode_git::repo::Repo, Option<String>, Option<String>);
    let mut repos: HashMap<String, Option<Base>> = HashMap::new();
    let mut states = Vec::with_capacity(bound.len());
    for (thread_id, row, path, root) in bound {
        if !path.is_dir() {
            continue;
        }
        let entry = repos.entry(row.workspace_id.clone()).or_insert_with(|| {
            let repo = git.repo(&root).ok().flatten()?;
            let base = worktree::current_branch(exe, &repo).unwrap_or_else(|error| {
                tracing::warn!(event = "git.base_branch_unknown", error = %error.diagnostic());
                None
            });
            // Compared by commit id: a branch name may hold characters git revisions allow but
            // KalCode's argv validation doesn't. The name is only displayed.
            let head = worktree::head_commit(exe, &repo).ok().flatten();
            Some((repo, base, head))
        });
        let Some((repo, base, head)) = entry.as_ref() else {
            continue;
        };
        let dirty = match worktree::dirty_state(exe, repo, &path) {
            Ok(dirty) => dirty,
            Err(error) => {
                tracing::warn!(event = "git.thread_worktree_unreadable", thread_id = %thread_id, error = %error.diagnostic());
                continue;
            }
        };
        let (mut ahead, mut behind, mut conflicts) = (None, None, None);
        if let (Some(_), Some(base_ref)) = (base, head) {
            let branch_ref = format!("refs/heads/{}", row.branch);
            if let Ok((left, right)) = worktree::ahead_behind(exe, repo, base_ref, &branch_ref) {
                (behind, ahead) = (Some(left), Some(right));
            }
            conflicts = worktree::merge_conflicts(exe, repo, base_ref, &branch_ref)
                .ok()
                .flatten();
        }
        states.push(ThreadWorktreeState {
            thread_id,
            worktree_id: row.id,
            branch: row.branch,
            base_branch: base.clone(),
            ahead,
            behind,
            changed: dirty.changed,
            untracked: dirty.untracked,
            conflicts,
            observed_at: kalcode_core::time::now_rfc3339(),
        });
    }
    states
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadWorktreeCommitArgs {
    pub thread_id: String,
    pub message: String,
}

/// The agent may still change files: a turn is running or about to, or it is waiting on an
/// approval or on resources, or paused mid-turn.
fn agent_is_busy(status: kalcode_contracts::threads::ThreadStatus) -> bool {
    use kalcode_contracts::threads::ThreadStatus as S;
    status.is_live()
        || matches!(
            status,
            S::WaitingForPermission | S::WaitingForDependency | S::Paused
        )
}

/// Commits everything in a thread's own worktree on its branch (Agent Fleet "Commit changes"),
/// records `git.commit_created` (thread + workspace correlation) and returns the worktree's
/// fresh Git facts. Refuses while the agent is busy, for a thread without an active worktree
/// or whose folder is gone, and when there is nothing to commit. The main checkout and every
/// other branch are untouched (see `kalcode_git::worktree::commit_all`).
pub(crate) fn commit_thread_worktree(
    core: &kalcode_core::Core,
    git: &GitCore,
    runtime: &kalcode_threads::ThreadRuntime,
    thread_id: &str,
    message: &str,
) -> Result<ThreadWorktreeState, KalError> {
    if !kalcode_contracts::ids::is_valid_id(thread_id) {
        return Err(KalError::validation(
            "invalid_thread_id",
            "That thread reference isn't valid.",
        ));
    }
    let message = worktree::validate_commit_message(message)?;
    let thread = runtime.get(thread_id)?;
    if agent_is_busy(thread.status) {
        return Err(KalError::validation(
            "thread_busy",
            "Stop or wait for the agent before committing its work.",
        ));
    }
    let (row, path) = core
        .read(|conn| store::active_thread_worktree(conn, thread_id))?
        .ok_or_else(|| {
            KalError::new(
                ErrorCategory::Git,
                "worktree_unknown",
                "This agent doesn't have a worktree of its own.",
            )
        })?;
    if !path.is_dir() {
        return Err(KalError::new(
            ErrorCategory::Git,
            "worktree_missing",
            "That worktree folder no longer exists.",
        ));
    }
    let root = workspace_root_in(core, &row.workspace_id)?;
    let exe = git.git()?;
    let repo = git.repo(&root)?.ok_or_else(|| {
        KalError::new(
            ErrorCategory::Git,
            "not_a_repository",
            "This folder isn't a Git repository.",
        )
    })?;
    let oid = worktree::commit_all(exe, &repo, &path, &row.branch, &message)?;
    tracing::info!(event = "thread.worktree_committed", thread_id, worktree_id = %row.id);
    let event = NewEvent {
        source: kalcode_contracts::events::EventSource::Ui,
        correlation: kalcode_contracts::events::Correlation {
            workspace_id: Some(row.workspace_id.clone()),
            thread_id: Some(thread_id.to_owned()),
            ..Default::default()
        },
        event: kalcode_contracts::events::EventPayload::GitCommitCreated {
            workspace_id: row.workspace_id.clone(),
            worktree_id: Some(row.id.clone()),
            oid,
            by_kal_code: true,
        },
    };
    // The commit already exists: a failure to record the event is logged, not returned.
    if let Err(error) = core.write_with_events(|_tx| Ok(((), vec![event]))) {
        tracing::warn!(event = "git.commit_event_failed", error = %error.diagnostic());
    }
    thread_worktree_states_for(git, vec![(thread_id.to_owned(), row, path, root)])
        .pop()
        .ok_or_else(|| {
            KalError::new(
                ErrorCategory::Git,
                "worktree_unreadable",
                "KalCode committed the changes but couldn't read the worktree afterwards.",
            )
        })
}

/// Agent Fleet "Commit changes": commits an isolated agent's work on its own branch.
#[tauri::command(async)]
pub async fn thread_worktree_commit(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    git: crate::runtime_coordinator::RuntimeState<GitState>,
    threads: crate::runtime_coordinator::RuntimeState<crate::thread_commands::ThreadsState>,
    args: ThreadWorktreeCommitArgs,
) -> Result<ThreadWorktreeState, IpcError> {
    _runtime_access.revalidate()?;
    let core = Arc::clone(state.core()?);
    let runtime = Arc::clone(threads.runtime()?);
    let gitcore = Arc::clone(&git.0);
    blocking(_runtime_access, "thread_worktree_commit", move || {
        commit_thread_worktree(&core, &gitcore, &runtime, &args.thread_id, &args.message)
    })
    .await
}

/// Read-only: Git facts for the given threads' own worktrees (Agent Fleet "ready to merge").
#[tauri::command(async)]
pub async fn thread_worktree_states(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    git: crate::runtime_coordinator::RuntimeState<GitState>,
    args: ThreadWorktreeStatesArgs,
) -> Result<Vec<ThreadWorktreeState>, IpcError> {
    _runtime_access.revalidate()?;
    let ids = thread_ids_arg(args.thread_ids).map_err(|e| e.to_ipc())?;
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let core = state.core()?;
    let rows = core
        .read(|conn| {
            let mut rows = Vec::new();
            for id in &ids {
                if let Some((row, path)) = store::active_thread_worktree(conn, id)? {
                    rows.push((id.clone(), row, path));
                }
            }
            Ok(rows)
        })
        .map_err(|e| e.log_and_convert("thread_worktree_states"))?;
    let mut bound = Vec::with_capacity(rows.len());
    for (thread_id, row, path) in rows {
        match workspace_root(&state, &row.workspace_id) {
            Ok(root) => bound.push((thread_id, row, path, root)),
            Err(error) => {
                tracing::warn!(event = "git.thread_worktree_workspace_unknown", error = %error.diagnostic());
            }
        }
    }
    let gitcore = Arc::clone(&git.0);
    blocking(_runtime_access, "thread_worktree_states", move || {
        Ok(thread_worktree_states_for(&gitcore, bound))
    })
    .await
}

// ---------- Worktrees ----------

#[tauri::command(async)]
pub async fn worktree_list(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    args: WorkspaceArgs,
) -> Result<Vec<Worktree>, IpcError> {
    _runtime_access.revalidate()?;
    if !kalcode_contracts::ids::is_valid_id(&args.workspace_id) {
        return Err(invalid_id().to_ipc());
    }
    let core = state.core()?;
    core.read(|conn| store::list_worktrees(conn, &args.workspace_id, false))
        .map_err(|e| e.log_and_convert("worktree_list"))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCreateArgs {
    pub workspace_id: String,
    /// The new branch (validated like `git check-ref-format --branch`).
    pub branch: String,
    /// Only `user` from the WebView; task/thread/checkpoint worktrees are created natively.
    pub purpose: WorktreePurpose,
    /// Start revision (default HEAD).
    pub start: Option<String>,
}

/// Additive: a new worktree folder under KalCode's data folder on a new branch.
/// TK-1: evaluate as origin `user`, scope git branch creation, before running.
#[tauri::command(async)]
pub async fn worktree_create(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    git: crate::runtime_coordinator::RuntimeState<GitState>,
    args: WorktreeCreateArgs,
) -> Result<Worktree, IpcError> {
    _runtime_access.revalidate()?;
    if args.purpose != WorktreePurpose::User {
        return Err(KalError::validation(
            "worktree_purpose_not_allowed",
            "Only user worktrees can be created here.",
        )
        .to_ipc());
    }
    let root = workspace_root(&state, &args.workspace_id)
        .map_err(|e| e.log_and_convert("worktree_create"))?;
    let core = Arc::clone(state.core()?);
    let gitcore = Arc::clone(&git.0);
    blocking(_runtime_access, "worktree_create", move || {
        let git = gitcore.git()?;
        let repo = gitcore.repo(&root)?.ok_or_else(|| {
            KalError::new(
                ErrorCategory::Git,
                "not_a_repository",
                "This folder isn't a Git repository.",
            )
        })?;
        let new = worktree::create_managed(
            git,
            &repo,
            gitcore.worktrees_root(),
            &args.branch,
            args.start.as_deref(),
            args.purpose,
            None,
        )?;
        let recorded = core.write_with_events(|tx| {
            let row = store::insert_worktree(tx, &new)?;
            let events = record(vec![GitEvent::WorktreeCreated {
                workspace_id: row.workspace_id.clone(),
                worktree_id: row.id.clone(),
                branch: row.branch.clone(),
                purpose: row.purpose,
            }]);
            Ok((row, events))
        });
        match recorded {
            Ok((row, _)) => Ok(row),
            Err(error) => {
                // Undo the git side so no unrecorded worktree is left behind (it is clean).
                let _ = worktree::remove(git, &repo, &new.path, RemoveMode::Safe);
                Err(error)
            }
        }
    })
    .await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRemoveArgs {
    pub worktree_id: String,
}

/// Safe removal only: refuses when the worktree has uncommitted or untracked work (the branch is
/// kept). Forced removal is destructive and needs TK + a native confirmation (not in Z6a).
#[tauri::command(async)]
pub async fn worktree_remove(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    git: crate::runtime_coordinator::RuntimeState<GitState>,
    args: WorktreeRemoveArgs,
) -> Result<Worktree, IpcError> {
    _runtime_access.revalidate()?;
    if !kalcode_contracts::ids::is_valid_id(&args.worktree_id) {
        return Err(invalid_id().to_ipc());
    }
    let core = Arc::clone(state.core()?);
    let (row, path) = core
        .read(|conn| {
            Ok((
                store::get_worktree(conn, &args.worktree_id)?,
                store::worktree_path(conn, &args.worktree_id)?,
            ))
        })
        .map_err(|e| e.log_and_convert("worktree_remove"))?;
    let root = workspace_root(&state, &row.workspace_id)
        .map_err(|e| e.log_and_convert("worktree_remove"))?;
    let gitcore = Arc::clone(&git.0);
    blocking(_runtime_access, "worktree_remove", move || {
        let git = gitcore.git()?;
        let repo = gitcore.repo(&root)?.ok_or_else(|| {
            KalError::new(
                ErrorCategory::Git,
                "not_a_repository",
                "This folder isn't a Git repository.",
            )
        })?;
        if path.exists() {
            worktree::remove(git, &repo, &path, RemoveMode::Safe)?;
        }
        gitcore.forget_workspace(&row.id);
        let (updated, _) = core.write_with_events(|tx| {
            let updated = store::set_worktree_status(tx, &row.id, WorktreeStatus::Removed)?;
            let events = record(vec![GitEvent::WorktreeRemoved {
                workspace_id: updated.workspace_id.clone(),
                worktree_id: updated.id.clone(),
                branch: updated.branch.clone(),
                purpose: updated.purpose,
            }]);
            Ok((updated, events))
        })?;
        Ok(updated)
    })
    .await
}

// ---------- Checkpoints ----------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointListArgs {
    pub workspace_id: String,
    pub page: PageRequest,
}

#[tauri::command(async)]
pub async fn checkpoint_list(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    args: CheckpointListArgs,
) -> Result<Page<Checkpoint>, IpcError> {
    _runtime_access.revalidate()?;
    let core = state.core()?;
    core.read(|conn| store::list_checkpoints(conn, &args.workspace_id, &args.page))
        .map_err(|e| e.log_and_convert("checkpoint_list"))
}

/// KalCode-private write only (the workspace's shadow repository). A manual checkpoint of an
/// unchanged workspace returns the latest checkpoint instead of a duplicate.
#[tauri::command(async)]
pub async fn checkpoint_create(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    git: crate::runtime_coordinator::RuntimeState<GitState>,
    args: WorkspaceArgs,
) -> Result<Checkpoint, IpcError> {
    _runtime_access.revalidate()?;
    let root = workspace_root(&state, &args.workspace_id)
        .map_err(|e| e.log_and_convert("checkpoint_create"))?;
    let core = Arc::clone(state.core()?);
    let gitcore = Arc::clone(&git.0);
    blocking(_runtime_access, "checkpoint_create", move || {
        let git = gitcore.git()?;
        let repo = gitcore.repo(&root)?;
        let latest = core.read(|conn| store::latest_checkpoint(conn, root.id()))?;
        let id = kalcode_contracts::ids::new_id();
        let outcome = gitcore.checkpoints().create(
            git,
            &root,
            &id,
            repo.as_ref(),
            latest.as_ref().map(|c| c.commit_oid.as_str()),
        )?;
        let created = match outcome {
            CreateOutcome::Created(created) => created,
            CreateOutcome::Unchanged { .. } => {
                return latest.ok_or_else(|| {
                    KalError::internal("checkpoint_missing", "The latest checkpoint is missing.")
                });
            }
        };
        let event_seq = core.recent_events(1, None)?.first().map_or(0, |e| e.seq);
        let trigger = CheckpointTrigger::User;
        let (row, _) = core.write_with_events(|tx| {
            let row =
                store::insert_checkpoint(tx, root.id(), &created, &trigger, event_seq, false)?;
            let events = record(vec![GitEvent::CheckpointCreated {
                checkpoint_id: row.id.clone(),
                workspace_id: row.workspace_id.clone(),
                trigger: trigger_kind(&trigger).to_owned(),
                files: row.files,
                bytes_added: row.bytes_added,
            }]);
            Ok((row, events))
        })?;
        prune_if_over_quota(&core, &gitcore, root.id());
        Ok(row)
    })
    .await
}

/// Keeps the store within its quota (oldest unpinned first). Failures are logged: pruning never
/// fails the checkpoint that triggered it.
fn prune_if_over_quota(core: &kalcode_core::Core, gitcore: &GitCore, workspace_id: &str) {
    let result = (|| -> Result<(), KalError> {
        let store_ = gitcore.checkpoints();
        if store_.usage_bytes(workspace_id)? <= store_.options().quota_bytes {
            return Ok(());
        }
        let candidates = core.read(|conn| store::prune_candidates(conn, workspace_id))?;
        let pruned = store_.prune_to_quota(gitcore.git()?, workspace_id, &candidates)?;
        core.write_with_events(|tx| {
            store::mark_pruned(tx, &pruned)?;
            let events = record(
                pruned
                    .iter()
                    .map(|id| GitEvent::CheckpointPruned {
                        checkpoint_id: id.clone(),
                        reason: "quota".into(),
                    })
                    .collect(),
            );
            Ok(((), events))
        })?;
        Ok(())
    })();
    if let Err(error) = result {
        tracing::warn!(event = "checkpoint.prune_failed", error_code = error.code, error = %error.diagnostic());
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointPinArgs {
    pub checkpoint_id: String,
    pub pinned: bool,
}

#[tauri::command(async)]
pub async fn checkpoint_pin(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    args: CheckpointPinArgs,
) -> Result<Checkpoint, IpcError> {
    _runtime_access.revalidate()?;
    let core = state.core()?;
    core.write_with_events(|tx| {
        Ok((
            store::set_pinned(tx, &args.checkpoint_id, args.pinned)?,
            Vec::new(),
        ))
    })
    .map(|(row, _)| row)
    .map_err(|e| e.log_and_convert("checkpoint_pin"))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointDiffArgs {
    pub checkpoint_id: String,
    /// Compare with another checkpoint; `None` compares with the current files.
    pub to_checkpoint_id: Option<String>,
}

/// Read-only preview of what changed since a checkpoint (for DiffView / the Time Machine).
#[tauri::command(async)]
pub async fn checkpoint_diff(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    git: crate::runtime_coordinator::RuntimeState<GitState>,
    args: CheckpointDiffArgs,
) -> Result<Diff, IpcError> {
    _runtime_access.revalidate()?;
    let core = Arc::clone(state.core()?);
    let (from, to) = core
        .read(|conn| {
            let from = store::get_checkpoint(conn, &args.checkpoint_id)?;
            let to = match &args.to_checkpoint_id {
                Some(id) => Some(store::get_checkpoint(conn, id)?),
                None => None,
            };
            Ok((from, to))
        })
        .map_err(|e| e.log_and_convert("checkpoint_diff"))?;
    if to
        .as_ref()
        .is_some_and(|t| t.workspace_id != from.workspace_id)
    {
        return Err(KalError::validation(
            "checkpoint_workspace_mismatch",
            "Those checkpoints belong to different workspaces.",
        )
        .to_ipc());
    }
    let root = workspace_root(&state, &from.workspace_id)
        .map_err(|e| e.log_and_convert("checkpoint_diff"))?;
    let gitcore = Arc::clone(&git.0);
    blocking(_runtime_access, "checkpoint_diff", move || {
        gitcore.checkpoints().diff(
            gitcore.git()?,
            &root,
            &from.commit_oid,
            to.as_ref().map(|t| t.commit_oid.as_str()),
            &DiffOptions::default(),
            gitcore.handles(),
        )
    })
    .await
}
