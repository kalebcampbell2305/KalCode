//! Git worktrees: list, add, and safe removal.
//!
//! Destructiveness:
//! * [`list`] — read-only.
//! * [`add`] / [`create_managed`] — **additive** in the user's repository: a new worktree
//!   folder under KalCode's data folder and, for [`WorktreeStart::NewBranch`], a new branch.
//!   Nothing existing is changed. No hook runs (`post-checkout`, `reference-transaction`).
//! * [`remove`] with [`RemoveMode::Safe`] — refuses when the worktree has any modified, staged or
//!   untracked (non-ignored) file, or is locked; the branch is kept.
//! * [`remove`] with [`RemoveMode::ForceDiscardChanges`] — **destructive**: deletes the worktree
//!   folder including uncommitted changes. Only for an explicit, separately confirmed user choice
//!   (not reachable from the WebView in Z6a; see `git_commands.rs`).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use kalcode_contracts::ids::new_id;
use kalcode_core::{ErrorCategory, KalError, Result};

use crate::paths::plain;
use crate::repo::{Repo, is_object_id, validate_branch_name, validate_revision};
use crate::runner::{Git, GitVersion, git_error};
use crate::types::WorktreePurpose;

/// A worktree as git reports it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WorktreeInfo {
    pub path: PathBuf,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub bare: bool,
    pub detached: bool,
    pub locked: bool,
    pub prunable: bool,
    /// The repository's main worktree (listed first by git).
    pub main: bool,
}

/// Where a new worktree starts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum WorktreeStart {
    /// Create `name` at `start` (a revision, default HEAD).
    NewBranch { name: String, start: Option<String> },
    /// Check out an existing local branch (git refuses if it is checked out elsewhere).
    ExistingBranch { name: String },
    /// A detached HEAD at a revision.
    Detached { revision: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoveMode {
    /// Refuse if anything uncommitted would be lost.
    Safe,
    /// Discard uncommitted changes. Destructive: explicit, confirmed user action only.
    ForceDiscardChanges,
}

/// Uncommitted state of a worktree.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirtyState {
    pub changed: u32,
    pub untracked: u32,
}

impl DirtyState {
    pub fn is_clean(&self) -> bool {
        self.changed == 0 && self.untracked == 0
    }
}

const WORKTREE_LIST_Z: GitVersion = GitVersion {
    major: 2,
    minor: 36,
    patch: 0,
};

/// Every worktree of the repository.
pub fn list(git: &Git, repo: &Repo) -> Result<Vec<WorktreeInfo>> {
    let nul = git.version() >= WORKTREE_LIST_Z;
    let mut cmd = repo.cmd(git).args(["worktree", "list", "--porcelain"]);
    if nul {
        cmd = cmd.arg("-z");
    }
    let out = cmd.read_only().run_ok("worktree")?;
    Ok(parse_list(&out.stdout, nul))
}

/// Parses `git worktree list --porcelain` (`-z`: attributes end with NUL, records with an
/// empty field; otherwise newline and blank line).
pub(crate) fn parse_list(bytes: &[u8], nul: bool) -> Vec<WorktreeInfo> {
    let text = String::from_utf8_lossy(bytes);
    let sep = if nul { '\0' } else { '\n' };
    let mut out: Vec<WorktreeInfo> = Vec::new();
    let mut current: Option<WorktreeInfo> = None;
    for field in text.split(sep) {
        if field.is_empty() {
            if let Some(done) = current.take() {
                out.push(done);
            }
            continue;
        }
        let (key, value) = field.split_once(' ').unwrap_or((field, ""));
        if key == "worktree" {
            if let Some(done) = current.take() {
                out.push(done);
            }
            current = Some(WorktreeInfo {
                path: PathBuf::from(value),
                main: out.is_empty(),
                ..WorktreeInfo::default()
            });
            continue;
        }
        let Some(wt) = current.as_mut() else { continue };
        match key {
            "HEAD" => wt.head = Some(value.to_owned()),
            "branch" => {
                wt.branch = Some(
                    value
                        .strip_prefix("refs/heads/")
                        .unwrap_or(value)
                        .to_owned(),
                )
            }
            "bare" => wt.bare = true,
            "detached" => wt.detached = true,
            "locked" => wt.locked = true,
            "prunable" => wt.prunable = true,
            _ => {}
        }
    }
    if let Some(done) = current.take() {
        out.push(done);
    }
    out
}

/// Adds a worktree at `path` (a native path under KalCode's data folder that must not exist
/// yet). Returns the new worktree's HEAD commit.
pub fn add(git: &Git, repo: &Repo, path: &Path, start: &WorktreeStart) -> Result<String> {
    if !path.is_absolute() {
        return Err(git_error(
            "worktree_path_invalid",
            "The worktree folder must be an absolute path.",
        ));
    }
    if path.exists() {
        return Err(git_error(
            "already_exists",
            "That worktree folder already exists.",
        ));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            KalError::new(
                ErrorCategory::Filesystem,
                "worktree_folder_unavailable",
                "KalCode couldn't create the worktree folder.",
            )
            .with_source(e)
        })?;
    }
    let mut cmd = repo.cmd(git).args(["worktree", "add", "--quiet"]);
    match start {
        WorktreeStart::NewBranch { name, start } => {
            validate_branch_name(name)?;
            let start = start.as_deref().unwrap_or("HEAD");
            validate_revision(start)?;
            cmd = cmd
                .args(["--no-track", "-b", name])
                .arg(plain(path))
                .arg(start);
        }
        WorktreeStart::ExistingBranch { name } => {
            validate_branch_name(name)?;
            cmd = cmd.arg(plain(path)).arg(name);
        }
        WorktreeStart::Detached { revision } => {
            validate_revision(revision)?;
            cmd = cmd.arg("--detach").arg(plain(path)).arg(revision);
        }
    }
    cmd.timeout(std::time::Duration::from_secs(300))
        .run_ok("worktree")?;
    let head = git
        .cmd()
        .configs(repo.overrides().iter().cloned())
        .current_dir(path)
        .args(["rev-parse", "--verify", "HEAD"])
        .read_only()
        .run_ok("worktree")?
        .stdout_text()
        .trim()
        .to_owned();
    if !is_object_id(&head) {
        return Err(git_error(
            "worktree_failed",
            "Git didn't report the new worktree's commit.",
        ));
    }
    Ok(head)
}

/// Counts uncommitted changes in a worktree (ignored files are not counted: git removes them
/// with the worktree, which is why [`RemoveMode::Safe`] documents it).
pub fn dirty_state(git: &Git, repo: &Repo, path: &Path) -> Result<DirtyState> {
    let out = git
        .cmd()
        .configs(repo.overrides().iter().cloned())
        .current_dir(path)
        .args([
            "status",
            "--porcelain=v2",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=none",
        ])
        .read_only()
        .run_ok("worktree")?;
    let status = crate::status::parse_porcelain_v2(&out.stdout);
    let untracked = status.entries.iter().filter(|e| e.untracked).count();
    Ok(DirtyState {
        changed: u32::try_from(status.entries.len() - untracked).unwrap_or(u32::MAX),
        untracked: u32::try_from(untracked).unwrap_or(u32::MAX),
    })
}

/// Removes a linked worktree. See the module docs for what each mode may destroy.
pub fn remove(git: &Git, repo: &Repo, path: &Path, mode: RemoveMode) -> Result<()> {
    let target = std::fs::canonicalize(path).map_err(|e| {
        git_error("worktree_missing", "That worktree folder no longer exists.").with_source(e)
    })?;
    let listed = list(git, repo)?;
    let entry = listed
        .iter()
        .find(|wt| std::fs::canonicalize(&wt.path).is_ok_and(|p| p == target))
        .ok_or_else(|| {
            git_error(
                "worktree_unknown",
                "That folder isn't a worktree of this repository.",
            )
        })?;
    if entry.main {
        return Err(git_error(
            "worktree_is_main",
            "The repository's main folder can't be removed.",
        ));
    }
    if entry.locked {
        return Err(git_error(
            "worktree_locked",
            "That worktree is locked. Unlock it with Git first.",
        ));
    }
    let mut cmd = repo.cmd(git).args(["worktree", "remove"]);
    match mode {
        RemoveMode::Safe => {
            let dirty = dirty_state(git, repo, &target)?;
            if !dirty.is_clean() {
                return Err(git_error(
                    "worktree_dirty",
                    format!(
                        "That worktree has {} changed and {} untracked files. Commit or discard them first.",
                        dirty.changed, dirty.untracked
                    ),
                ));
            }
        }
        RemoveMode::ForceDiscardChanges => cmd = cmd.arg("--force"),
    }
    cmd.arg(plain(&target)).run_ok("worktree")?;
    Ok(())
}

/// A KalCode-managed worktree created by [`create_managed`], ready to be recorded in
/// `git_worktrees` (see [`crate::store::insert_worktree`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewWorktree {
    pub id: String,
    pub workspace_id: String,
    pub path: PathBuf,
    pub branch: String,
    pub base_commit: String,
    pub purpose: WorktreePurpose,
    pub owner_ref: Option<String>,
}

/// Creates a worktree with a new branch in `<worktrees_root>/<workspace-id>/<worktree-id>`.
/// Git runs before any database write (never while holding the writer lock); the caller records
/// the result and removes the worktree again if recording fails.
pub fn create_managed(
    git: &Git,
    repo: &Repo,
    worktrees_root: &Path,
    branch: &str,
    start: Option<&str>,
    purpose: WorktreePurpose,
    owner_ref: Option<String>,
) -> Result<NewWorktree> {
    validate_branch_name(branch)?;
    let id = new_id();
    let path = worktrees_root.join(repo.workspace().id()).join(&id);
    let base_commit = add(
        git,
        repo,
        &path,
        &WorktreeStart::NewBranch {
            name: branch.to_owned(),
            start: start.map(str::to_owned),
        },
    )?;
    Ok(NewWorktree {
        id,
        workspace_id: repo.workspace().id().to_owned(),
        path,
        branch: branch.to_owned(),
        base_commit,
        purpose,
        owner_ref,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nul_and_line_formats() {
        let z = b"worktree /repo\0HEAD 1111111111111111111111111111111111111111\0branch refs/heads/main\0\0worktree /data/wt\0HEAD 2222222222222222222222222222222222222222\0detached\0locked reason here\0\0";
        let list = parse_list(z, true);
        assert_eq!(list.len(), 2);
        assert!(list[0].main);
        assert_eq!(list[0].branch.as_deref(), Some("main"));
        assert!(list[1].detached && list[1].locked && !list[1].main);

        let lines = b"worktree /repo\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main\n\nworktree /data/with space\nHEAD 2222222222222222222222222222222222222222\nbranch refs/heads/kal/x\nprunable gitdir file points to non-existent location\n\n";
        let list = parse_list(lines, false);
        assert_eq!(list.len(), 2);
        assert_eq!(list[1].path, PathBuf::from("/data/with space"));
        assert_eq!(list[1].branch.as_deref(), Some("kal/x"));
        assert!(list[1].prunable);
    }
}
