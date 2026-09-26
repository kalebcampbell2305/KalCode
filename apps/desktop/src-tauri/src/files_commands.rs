//! Workspace file IPC commands (campaign Z6a): folder listings from the ignore-aware file index,
//! returning opaque file handles (ADVANCED.md §3 D4).
//!
//! **Not wired yet.** See `docs/campaigns/Z6a.md` §6 for the lines the lead adds to `lib.rs`,
//! `build.rs` and `capabilities/main.json`. Uses `GitState` from `git_commands.rs` (the file
//! index and handle registry live in `kalcode_git::GitCore`, which works without Git).
//!
//! The WebView never sends a path: it lists the workspace root, then descends with the handles
//! it received. Every handle is re-validated natively on use (containment, links, `.git`).

use std::sync::Arc;

use kalcode_core::IpcError;
use kalcode_git::types::{FileEntry, FileHandle, Page, PageRequest};
use serde::Deserialize;
use tauri::State;

use crate::AppState;
use crate::git_commands::{GitState, workspace_root};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesListArgs {
    pub workspace_id: String,
    /// A folder handle from an earlier listing; the workspace root when absent.
    pub dir: Option<FileHandle>,
    pub page: PageRequest,
}

/// One folder of a workspace: folders first, then files; ignored entries are included and
/// flagged. The first call for a workspace builds its index (off the main thread).
#[tauri::command(async)]
pub async fn files_list(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    git: crate::runtime_coordinator::RuntimeState<GitState>,
    args: FilesListArgs,
) -> Result<Page<FileEntry>, IpcError> {
    _runtime_access.revalidate()?;
    let root =
        workspace_root(&state, &args.workspace_id).map_err(|e| e.log_and_convert("files_list"))?;
    let core = Arc::clone(&git.0);
    tauri::async_runtime::spawn_blocking(move || {
        _runtime_access.revalidate_core()?;
        core.list_files(&root, args.dir.as_ref(), &args.page)
    })
    .await
    .map_err(|e| {
        kalcode_core::KalError::internal("files_interrupted", "Listing files was interrupted.")
            .with_source(e)
            .log_and_convert("files_list")
    })?
    .map_err(|e| e.log_and_convert("files_list"))
}
