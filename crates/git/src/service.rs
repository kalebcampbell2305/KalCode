//! [`GitCore`]: the one object the desktop shell holds. It owns the located `git`, the handle
//! registry, the checkpoint store and per-workspace file indexes, and lays out KalCode's data
//! folder:
//!
//! ```text
//! <data>/git/no-hooks/               empty; core.hooksPath for every KalCode git command
//! <data>/checkpoints/<workspace>.git  shadow repositories (D2)
//! <data>/worktrees/<workspace>/<id>/  KalCode-managed worktrees
//! ```
//!
//! If Git is missing or too old, `GitCore` still starts: Git features report an honest
//! `git_not_found` / `git_too_old` error and the file index keeps working (failure isolation).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use kalcode_core::{IpcError, KalError, Result};

use crate::checkpoint::{CheckpointOptions, CheckpointStore};
use crate::diff::{Diff, DiffOptions, DiffTarget, files_from_handles};
use crate::handles::HandleRegistry;
use crate::index::FileIndex;
use crate::log::{Branch, Commit};
use crate::paths::WorkspaceRoot;
use crate::repo::Repo;
use crate::runner::Git;
use crate::status::{StatusView, status};
use crate::types::{FileEntry, FileHandle, Page, PageRequest};

/// Most workspace indexes kept in memory at once (least recently used is dropped).
const MAX_INDEXES: usize = 16;

pub struct GitCore {
    git: std::result::Result<Arc<Git>, IpcError>,
    handles: HandleRegistry,
    checkpoints: CheckpointStore,
    worktrees_root: PathBuf,
    indexes: Mutex<Vec<(String, Arc<FileIndex>)>>,
}

impl std::fmt::Debug for GitCore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GitCore")
            .field("git", &self.git.as_ref().map(|g| g.version()).ok())
            .finish_non_exhaustive()
    }
}

impl GitCore {
    /// Locates `git` on PATH and prepares the data-folder layout.
    pub fn new(data_dir: &Path) -> Self {
        let git = Git::locate(&data_dir.join("git").join("no-hooks"));
        Self::with_git(data_dir, git)
    }

    /// Uses an explicit git result (tests).
    pub fn with_git(data_dir: &Path, git: Result<Git>) -> Self {
        let git = git.map(Arc::new).map_err(|error| {
            tracing::warn!(event = "git.unavailable", error_code = error.code);
            error.to_ipc()
        });
        Self {
            git,
            handles: HandleRegistry::default(),
            checkpoints: CheckpointStore::new(
                data_dir.join("checkpoints"),
                CheckpointOptions::default(),
            ),
            worktrees_root: data_dir.join("worktrees"),
            indexes: Mutex::new(Vec::new()),
        }
    }

    /// The located git, or why Git features are unavailable.
    pub fn git(&self) -> Result<&Arc<Git>> {
        self.git.as_ref().map_err(|ipc| {
            KalError::new(
                kalcode_core::ErrorCategory::Git,
                static_code(&ipc.code),
                ipc.message.clone(),
            )
        })
    }

    pub fn handles(&self) -> &HandleRegistry {
        &self.handles
    }

    pub fn checkpoints(&self) -> &CheckpointStore {
        &self.checkpoints
    }

    pub fn worktrees_root(&self) -> &Path {
        &self.worktrees_root
    }

    /// The repository of a workspace (`None` for a plain folder).
    pub fn repo(&self, ws: &WorkspaceRoot) -> Result<Option<Repo>> {
        Repo::discover(self.git()?, ws)
    }

    /// The workspace's file index, built on first use and cached.
    pub fn index(&self, ws: &WorkspaceRoot) -> Result<Arc<FileIndex>> {
        {
            let mut indexes = self.indexes.lock().unwrap_or_else(PoisonError::into_inner);
            if let Some(pos) = indexes
                .iter()
                .position(|(id, index)| id == ws.id() && index.workspace().path() == ws.path())
            {
                let entry = indexes.remove(pos);
                let index = Arc::clone(&entry.1);
                indexes.push(entry);
                return Ok(index);
            }
        }
        // Build without holding the lock: a large workspace must not block other workspaces.
        let index = Arc::new(FileIndex::build(ws.clone())?);
        let mut indexes = self.indexes.lock().unwrap_or_else(PoisonError::into_inner);
        indexes.retain(|(id, _)| id != ws.id());
        indexes.push((ws.id().to_owned(), Arc::clone(&index)));
        if indexes.len() > MAX_INDEXES {
            indexes.remove(0);
        }
        Ok(index)
    }

    /// Forgets a workspace's index and handles (workspace removed).
    pub fn forget_workspace(&self, workspace_id: &str) {
        self.indexes
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .retain(|(id, _)| id != workspace_id);
        self.handles.revoke_workspace(workspace_id);
    }

    /// `files_list`: one folder of the workspace (a handle from an earlier listing, or the root).
    pub fn list_files(
        &self,
        ws: &WorkspaceRoot,
        dir: Option<&FileHandle>,
        page: &PageRequest,
    ) -> Result<Page<FileEntry>> {
        let dir = match dir {
            Some(handle) => Some(self.handles.resolve(ws, handle)?.rel),
            None => None,
        };
        self.index(ws)?.list_dir(dir.as_ref(), page, &self.handles)
    }

    /// `git_status`. `None` when the workspace isn't in a repository.
    pub fn status(&self, ws: &WorkspaceRoot) -> Result<Option<StatusView>> {
        let git = self.git()?;
        let Some(repo) = Repo::discover(git, ws)? else {
            return Ok(None);
        };
        Ok(Some(status(git, &repo)?.view(&repo, &self.handles)))
    }

    /// `git_diff`, optionally limited to files named by handles.
    pub fn diff(
        &self,
        ws: &WorkspaceRoot,
        target: &DiffTarget,
        files: &[FileHandle],
        options: &DiffOptions,
    ) -> Result<Diff> {
        let git = self.git()?;
        let repo = Repo::discover(git, ws)?.ok_or_else(not_a_repository)?;
        let files = files_from_handles(&self.handles, ws.id(), files)?;
        crate::diff::diff(git, &repo, target, &files, options, &self.handles)
    }

    /// `git_log`.
    pub fn log(
        &self,
        ws: &WorkspaceRoot,
        limit: u32,
        cursor: Option<&str>,
    ) -> Result<Page<Commit>> {
        let git = self.git()?;
        let repo = Repo::discover(git, ws)?.ok_or_else(not_a_repository)?;
        crate::log::log(git, &repo, None, limit, cursor)
    }

    /// `git_branches`.
    pub fn branches(&self, ws: &WorkspaceRoot) -> Result<Vec<Branch>> {
        let git = self.git()?;
        let repo = Repo::discover(git, ws)?.ok_or_else(not_a_repository)?;
        crate::log::branches(git, &repo)
    }
}

fn not_a_repository() -> KalError {
    KalError::new(
        kalcode_core::ErrorCategory::Git,
        "not_a_repository",
        "This folder isn't a Git repository.",
    )
}

/// Error codes are `&'static str`; map the stored availability error back to its constant.
fn static_code(code: &str) -> &'static str {
    const KNOWN: &[&str] = &[
        "git_not_found",
        "git_too_old",
        "git_version_unknown",
        "git_start_failed",
        "git_path_invalid",
        "git_hooks_dir_invalid",
        "git_hooks_dir_unavailable",
        "git_timed_out",
    ];
    KNOWN
        .iter()
        .copied()
        .find(|k| *k == code)
        .unwrap_or("git_unavailable")
}
