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
/// the result and removes the worktree again if recording fails. If `git worktree add` fails
/// partway (a timeout, a path Windows can't check out), its partial folder and registration are
/// removed, and so is the branch when this call created it and nothing was committed on it.
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
    let branch_ref = format!("refs/heads/{branch}");
    let existed = resolve_commit(git, repo, &branch_ref)?.is_some();
    let start = start.unwrap_or("HEAD");
    validate_revision(start)?;
    let start_oid = resolve_commit(git, repo, start)?.ok_or_else(|| {
        git_error(
            "unknown_revision",
            "Git doesn't know that commit or branch.",
        )
    })?;
    let id = new_id();
    let path = worktrees_root.join(repo.workspace().id()).join(&id);
    let added = add(
        git,
        repo,
        &path,
        &WorktreeStart::NewBranch {
            name: branch.to_owned(),
            start: Some(start_oid.clone()),
        },
    );
    let base_commit = match added {
        Ok(base_commit) => base_commit,
        Err(error) => {
            undo_partial_add(git, repo, &path);
            if !existed {
                // Fails harmlessly when git never created the branch.
                let _ = discard_new_branch(git, repo, branch, &start_oid);
            }
            return Err(error);
        }
    };
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

/// Checks an **existing** branch out into a new managed worktree (`git worktree add <path>
/// <branch>`, no new branch), for example to bring back a thread's worktree whose folder is gone.
/// Git refuses when the branch is checked out in another worktree. A partial folder and
/// registration are removed on failure; the branch is never touched.
pub fn attach_managed(
    git: &Git,
    repo: &Repo,
    worktrees_root: &Path,
    branch: &str,
    purpose: WorktreePurpose,
    owner_ref: Option<String>,
) -> Result<NewWorktree> {
    validate_branch_name(branch)?;
    if resolve_commit(git, repo, &format!("refs/heads/{branch}"))?.is_none() {
        return Err(git_error("branch_missing", "That branch no longer exists."));
    }
    let id = new_id();
    let path = worktrees_root.join(repo.workspace().id()).join(&id);
    let base_commit = match add(
        git,
        repo,
        &path,
        &WorktreeStart::ExistingBranch {
            name: branch.to_owned(),
        },
    ) {
        Ok(head) => head,
        Err(error) => {
            undo_partial_add(git, repo, &path);
            return Err(error);
        }
    };
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

/// The commit `rev` names, `None` when it names none. Read-only.
fn resolve_commit(git: &Git, repo: &Repo, rev: &str) -> Result<Option<String>> {
    validate_revision(rev)?;
    let out = repo
        .cmd(git)
        .args(["rev-parse", "--verify", "--quiet", "--end-of-options"])
        .arg(format!("{rev}^{{commit}}"))
        .read_only()
        .run()?;
    let oid = out.stdout_text().trim().to_owned();
    Ok((out.status.success() && is_object_id(&oid)).then_some(oid))
}

/// The commit checked out in the workspace's main folder (`None` before the first commit).
/// Comparisons use it rather than the branch name, which may hold characters
/// [`validate_revision`] refuses. Read-only.
pub fn head_commit(git: &Git, repo: &Repo) -> Result<Option<String>> {
    resolve_commit(git, repo, "HEAD")
}

/// Removes what a failed `git worktree add` left: the new folder (KalCode's own, under its data
/// folder, holding nothing of the user's) and its registration.
fn undo_partial_add(git: &Git, repo: &Repo, path: &Path) {
    if path.exists() {
        let removed = repo
            .cmd(git)
            .args(["worktree", "remove", "--force"])
            .arg(plain(path))
            .run_ok("worktree")
            .is_ok();
        if !removed {
            let _ = std::fs::remove_dir_all(path);
        }
    }
    if let Err(error) = forget_missing(git, repo, path) {
        tracing::warn!(event = "git.worktree_cleanup_failed", error = %error.diagnostic());
    }
}

fn same_path(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| {
        let text = plain(p).to_string_lossy().replace('\\', "/");
        let text = text.trim_end_matches('/').to_owned();
        if cfg!(windows) {
            text.to_lowercase()
        } else {
            text
        }
    };
    norm(a) == norm(b)
}

/// Drops git's registration of a worktree whose folder no longer exists, so its branch can be
/// checked out again. Targets that one worktree (`git worktree remove --force` on a missing
/// folder loses nothing); only if git still lists it afterwards does it fall back to
/// `git worktree prune`, which clears registrations of missing folders (locked ones are kept).
/// Does nothing when the folder exists or git doesn't list it.
pub fn forget_missing(git: &Git, repo: &Repo, path: &Path) -> Result<()> {
    if path.exists() {
        return Ok(());
    }
    let listed = |git: &Git| -> Result<bool> {
        Ok(list(git, repo)?
            .iter()
            .any(|wt| !wt.main && same_path(&wt.path, path)))
    };
    if !listed(git)? {
        return Ok(());
    }
    let _ = repo
        .cmd(git)
        .args(["worktree", "remove", "--force"])
        .arg(plain(path))
        .run();
    if listed(git)? {
        repo.cmd(git)
            .args(["worktree", "prune"])
            .run_ok("worktree")?;
    }
    Ok(())
}

/// Undoes the branch [`create_managed`] created, for a worktree being rolled back: deletes
/// `refs/heads/<branch>` only while it still points at `expected` (nothing was committed on it),
/// atomically (`git update-ref -d <ref> <old>`). Call after the worktree itself is removed.
pub fn discard_new_branch(git: &Git, repo: &Repo, branch: &str, expected: &str) -> Result<()> {
    validate_branch_name(branch)?;
    if !is_object_id(expected) {
        return Err(KalError::validation(
            "invalid_revision",
            "That commit or branch name isn't valid.",
        ));
    }
    repo.cmd(git)
        .args(["update-ref", "-d"])
        .arg(format!("refs/heads/{branch}"))
        .arg(expected)
        .run_ok("worktree")?;
    Ok(())
}

/// The branch checked out in the workspace's main folder (the repository top level), `None` on
/// a detached HEAD. Read-only.
pub fn current_branch(git: &Git, repo: &Repo) -> Result<Option<String>> {
    let out = repo
        .cmd(git)
        .args(["symbolic-ref", "--quiet", "--short", "HEAD"])
        .read_only()
        .run()?;
    if out.status.success() {
        let name = out.stdout_text().trim().to_owned();
        return Ok((!name.is_empty()).then_some(name));
    }
    // `--quiet`: exit 1 with no message means HEAD is detached.
    if out.status.code() == Some(1) && out.stderr.trim().is_empty() {
        return Ok(None);
    }
    Err(crate::runner::classify_failure("branches", &out))
}

/// Commits only on `base` and only on `branch` (`(behind, ahead)` of `branch` relative to
/// `base`), from `git rev-list --left-right --count base...branch`. Read-only.
pub fn ahead_behind(git: &Git, repo: &Repo, base: &str, branch: &str) -> Result<(u32, u32)> {
    validate_revision(base)?;
    validate_revision(branch)?;
    let out = repo
        .cmd(git)
        .args(["rev-list", "--left-right", "--count"])
        .arg(format!("{base}...{branch}"))
        .arg("--")
        .read_only()
        .run_ok("log")?;
    parse_left_right(&out.stdout_text())
        .ok_or_else(|| git_error("log_failed", "Git didn't report how the branches differ."))
}

/// Parses `<left> <right>` (tab-separated) from `rev-list --left-right --count`.
pub(crate) fn parse_left_right(text: &str) -> Option<(u32, u32)> {
    let mut parts = text.split_whitespace();
    let left = parts.next()?.parse().ok()?;
    let right = parts.next()?.parse().ok()?;
    parts.next().is_none().then_some((left, right))
}

/// `merge-tree --write-tree` needs Git 2.38.
const MERGE_TREE_WRITE_TREE: GitVersion = GitVersion {
    major: 2,
    minor: 38,
    patch: 0,
};

/// Predicts whether merging `branch` into `base` would conflict, without touching any work tree,
/// index or ref: `git merge-tree --write-tree` (exit 0 clean, 1 conflicts). It may add
/// unreachable objects (the would-be merge trees) to the object store, which `git gc` prunes.
/// `None` when the answer is unknown: Git older than 2.38, a merge driver defined by the
/// repository's own config (an arbitrary command KalCode won't run), or any other outcome
/// (for example unrelated histories).
pub fn merge_conflicts(git: &Git, repo: &Repo, base: &str, branch: &str) -> Result<Option<bool>> {
    validate_revision(base)?;
    validate_revision(branch)?;
    if git.version() < MERGE_TREE_WRITE_TREE || repo.defines_merge_driver() {
        return Ok(None);
    }
    let out = repo
        .cmd(git)
        .args([
            "merge-tree",
            "--write-tree",
            "--name-only",
            "--no-messages",
            base,
            branch,
        ])
        .run()?;
    Ok(match out.status.code() {
        Some(0) => Some(false),
        Some(1) => Some(true),
        code => {
            tracing::warn!(
                event = "git.merge_prediction_unknown",
                exit_code = code,
                stderr = %out.stderr
            );
            None
        }
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

    #[test]
    fn parses_left_right_counts() {
        assert_eq!(
            parse_left_right(
                "3	5
"
            ),
            Some((3, 5))
        );
        assert_eq!(parse_left_right("0	0"), Some((0, 0)));
        assert_eq!(parse_left_right(""), None);
        assert_eq!(parse_left_right("1"), None);
        assert_eq!(parse_left_right("1	2	3"), None);
        assert_eq!(parse_left_right("x	2"), None);
    }
}
