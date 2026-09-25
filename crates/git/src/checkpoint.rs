//! The checkpoint store (docs/campaigns/ADVANCED.md §3 D2, option C).
//!
//! Each workspace gets a **self-contained shadow repository** in KalCode's data folder
//! (`<checkpoints>/<workspace-id>.git`, bare, used with `--work-tree=<workspace root>`). A
//! checkpoint is a root commit of the workspace's non-ignored files, kept alive by the private
//! ref `refs/kalcode/checkpoints/<checkpoint-id>` **inside the shadow repository**. Nothing is
//! ever written to the user's repository, index, HEAD or refs by creating, listing, diffing or
//! pruning checkpoints; the user's `git gc` cannot corrupt them; non-Git folders work too.
//!
//! * `.gitignore` files, the global excludes file and the repository's `info/exclude` are
//!   respected (the same walker as the file index); ignored files are never snapshotted and
//!   never touched by a restore. Links are never followed ([`crate::snapshot`]).
//! * Files larger than [`CheckpointOptions::large_file_bytes`] (default 50 MiB) are skipped and
//!   counted; a restore never overwrites them.
//! * Snapshots store exact bytes, and restores write them back exactly: the shadow repository's
//!   `info/attributes` disables line-ending conversion, filters, `ident` and encodings, and no
//!   filter or hook can run.
//! * Speed: a stat manifest in the shadow repository lets unchanged files reuse their object id
//!   and new content is streamed into one packfile per snapshot. (The plan suggested seeding a
//!   temporary index from the *user's* index; that would reference blobs the self-contained
//!   shadow repository does not have — it would need `alternates`, which D2 rejected — so the
//!   manifest plays that role.)
//!
//! Destructiveness of each operation:
//!
//! | Operation | Effect |
//! | --- | --- |
//! | [`CheckpointStore::create`] | KalCode-private write (shadow repository only). |
//! | [`CheckpointStore::plan_restore`] | KalCode-private write (hashes the current files into the shadow repository to compare); changes no user file. |
//! | [`CheckpointStore::execute_restore`] | **Destructive** to the working tree: overwrites/creates files, and deletes files only if the plan says so. Requires a [`RestoreConfirmation`] for the exact plan and **always** takes a safety checkpoint first, so everything it overwrites or deletes stays recoverable. Never touches ignored or oversized files, the user's index, HEAD or refs. |
//! | [`CheckpointStore::export_branch`] | **Additive** to the user's repository: fetches the checkpoint's objects and creates one new commit and one new branch (refuses an existing branch). The working tree, index and HEAD are unchanged. |
//! | [`CheckpointStore::diff`] | Read-only for the user (may hash current files into the shadow repository). |
//! | [`CheckpointStore::delete_ref`] / [`CheckpointStore::collect_garbage`] | KalCode-private deletes (prune). |

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use kalcode_contracts::ids::is_valid_id;
use kalcode_core::{ErrorCategory, KalError, Result};

use crate::diff::{Diff, DiffOptions, DiffTarget, run_diff};
use crate::handles::HandleRegistry;
use crate::paths::{RelPath, WorkspaceRoot};
use crate::repo::{Repo, is_object_id, validate_branch_name};
use crate::runner::{Cmd, Git, git_error};
pub use crate::types::PlannedChange;

/// Checkpoint store limits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CheckpointOptions {
    /// Files larger than this are not snapshotted.
    pub large_file_bytes: u64,
    /// Per-workspace disk quota for the shadow repository (pruning target).
    pub quota_bytes: u64,
}

impl Default for CheckpointOptions {
    fn default() -> Self {
        Self {
            large_file_bytes: 50 * 1024 * 1024,
            quota_bytes: 2 * 1024 * 1024 * 1024,
        }
    }
}

/// Commit identity for snapshot commits (never the user's).
const IDENTITY_NAME: &str = "KalCode";
const IDENTITY_EMAIL: &str = "checkpoints@kalcode.invalid";
const ATTRIBUTES: &str = "* -text -eol -filter -ident -working-tree-encoding\n";
const REF_PREFIX: &str = "refs/kalcode/checkpoints/";

/// What [`CheckpointStore::create`] produced.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedCheckpoint {
    pub id: String,
    pub commit_oid: String,
    pub tree_oid: String,
    /// Files in the snapshot.
    pub files: u32,
    /// Approximate new bytes stored (loose objects added).
    pub bytes_added: u64,
    /// Files skipped because they exceed the size limit.
    pub skipped_large: u32,
    /// The user's HEAD when the snapshot was taken (for "branch from checkpoint").
    pub user_head: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CreateOutcome {
    Created(CreatedCheckpoint),
    /// Nothing changed since `unchanged_since` (the commit passed as `skip_if_unchanged_from`).
    Unchanged {
        unchanged_since: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedFileChange {
    /// Workspace-relative.
    pub path: String,
    pub change: PlannedChange,
}

/// A restore preview. Executing it requires a [`RestoreConfirmation`] bound to `digest`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePlan {
    pub workspace_id: String,
    pub checkpoint_oid: String,
    /// The working tree when the plan was made (checked again before writing).
    pub current_tree: String,
    pub target_tree: String,
    pub changes: Vec<PlannedFileChange>,
    pub delete_added: bool,
    /// SHA-256 over everything above.
    pub digest: String,
}

/// Proof that the user confirmed this exact plan through a **native** confirmation dialog
/// (ADVANCED.md §3 D8: "restoring files over the working tree"). Construct it only in the native
/// confirmation handler, never from WebView input.
#[derive(Debug)]
pub struct RestoreConfirmation {
    digest: String,
}

impl RestoreConfirmation {
    /// Call only after the native dialog showing `plan` returned "Restore".
    pub fn confirmed_natively(plan: &RestorePlan) -> Self {
        Self {
            digest: plan.digest.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum RestoreResult {
    Applied {
        written: u32,
        deleted: u32,
    },
    /// The working tree changed after the plan was made; nothing was written. Make a new plan.
    PlanStale,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOutcome {
    /// Always taken before anything is written; record it (pinned) even when the plan was stale.
    pub safety: CreatedCheckpoint,
    pub result: RestoreResult,
}

/// Per-workspace shadow repositories under one folder.
#[derive(Debug)]
pub struct CheckpointStore {
    base_dir: PathBuf,
    options: CheckpointOptions,
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

fn fs_error(code: &'static str, message: &'static str) -> impl FnOnce(std::io::Error) -> KalError {
    move |e| KalError::new(ErrorCategory::Filesystem, code, message).with_source(e)
}

impl CheckpointStore {
    pub fn new(base_dir: PathBuf, options: CheckpointOptions) -> Self {
        Self {
            base_dir,
            options,
            locks: Mutex::new(HashMap::new()),
        }
    }

    pub fn options(&self) -> CheckpointOptions {
        self.options
    }

    /// The shadow repository of a workspace.
    pub fn shadow_dir(&self, workspace_id: &str) -> Result<PathBuf> {
        if !is_valid_id(workspace_id) {
            return Err(KalError::validation(
                "invalid_id",
                "That workspace id isn't valid.",
            ));
        }
        Ok(self.base_dir.join(format!("{workspace_id}.git")))
    }

    fn lock(&self, workspace_id: &str) -> Arc<Mutex<()>> {
        let mut locks = self.locks.lock().unwrap_or_else(PoisonError::into_inner);
        Arc::clone(locks.entry(workspace_id.to_owned()).or_default())
    }

    fn shadow_cmd<'g>(&self, git: &'g Git, ws: &WorkspaceRoot, shadow: &Path) -> Cmd<'g> {
        git.cmd()
            .current_dir(ws.path())
            .git_dir(shadow, Some(ws.path()))
            .configs([
                "core.autocrlf=false".to_owned(),
                "core.safecrlf=false".to_owned(),
            ])
    }

    /// The store and the workspace must never overlap, in either direction: a store inside
    /// the workspace would be snapshotted into itself and could be overwritten by a restore; a
    /// workspace inside the store could overwrite shadow repositories. Checked on **every**
    /// use, including the first one when the store folder doesn't exist yet: the nearest
    /// existing ancestor is canonicalized (links, junctions, letter case) and the missing rest
    /// appended ([`crate::paths::resolve_nearest`]); the plain lexical form is checked too.
    fn check_location(&self, ws: &WorkspaceRoot) -> Result<()> {
        let candidates = [
            crate::paths::resolve_nearest(&self.base_dir),
            crate::paths::resolve_nearest(&crate::paths::lexical(&self.base_dir)),
        ];
        let overlaps = candidates.iter().any(|base| {
            crate::paths::is_within(base, ws.path()) || crate::paths::is_within(ws.path(), base)
        });
        if overlaps {
            return Err(git_error(
                "checkpoint_store_inside_workspace",
                "KalCode's checkpoint folder is inside this workspace, so checkpoints are unavailable here.",
            ));
        }
        Ok(())
    }

    /// Creates the shadow repository on first use.
    fn prepare(&self, git: &Git, ws: &WorkspaceRoot) -> Result<PathBuf> {
        let shadow = self.shadow_dir(ws.id())?;
        // Before anything is created: on first use the folder doesn't exist yet.
        self.check_location(ws)?;
        if !shadow.join("HEAD").exists() {
            std::fs::create_dir_all(&self.base_dir).map_err(fs_error(
                "checkpoint_store_unavailable",
                "KalCode couldn't create its checkpoint folder.",
            ))?;
            // Again now that it exists (a link swapped in meanwhile resolves differently).
            self.check_location(ws)?;
            git.cmd()
                .args(["init", "--bare", "--quiet"])
                .arg(crate::paths::plain(&shadow))
                .run_ok("checkpoint")?;
            for setting in [
                ["core.logAllRefUpdates", "false"],
                ["gc.auto", "0"],
                ["core.autocrlf", "false"],
                ["core.fsmonitor", "false"],
            ] {
                git.cmd()
                    .git_dir(&shadow, None)
                    .args(["config", setting[0], setting[1]])
                    .run_ok("checkpoint")?;
            }
        }
        let info = shadow.join("info");
        std::fs::create_dir_all(&info).map_err(fs_error(
            "checkpoint_store_unavailable",
            "KalCode couldn't prepare its checkpoint folder.",
        ))?;
        // Restores write exact bytes: no line-ending conversion, filters, ident or encodings.
        write_if_changed(&info.join("attributes"), ATTRIBUTES.as_bytes())?;
        Ok(shadow)
    }

    /// Snapshots the current workspace; returns (tree, files, large files skipped).
    fn snapshot_tree(
        &self,
        git: &Git,
        ws: &WorkspaceRoot,
        shadow: &Path,
    ) -> Result<(String, u32, Vec<String>)> {
        let snap = crate::snapshot::snapshot(git, ws, shadow, self.options.large_file_bytes)?;
        Ok((snap.tree, snap.files, snap.large))
    }

    /// Bytes stored in the shadow repository's object database.
    fn object_bytes(shadow: &Path) -> u64 {
        dir_size(&shadow.join("objects"))
    }

    /// Takes a checkpoint. `id` is the checkpoint's UUIDv7 (the caller's row id). When
    /// `skip_if_unchanged_from` names the latest checkpoint's commit and the files are the same,
    /// nothing is committed.
    pub fn create(
        &self,
        git: &Git,
        ws: &WorkspaceRoot,
        id: &str,
        user_repo: Option<&Repo>,
        skip_if_unchanged_from: Option<&str>,
    ) -> Result<CreateOutcome> {
        if !is_valid_id(id) {
            return Err(KalError::validation(
                "invalid_id",
                "That checkpoint id isn't valid.",
            ));
        }
        let lock = self.lock(ws.id());
        let _guard = lock.lock().unwrap_or_else(PoisonError::into_inner);
        let shadow = self.prepare(git, ws)?;
        self.create_locked(git, ws, &shadow, id, user_repo, skip_if_unchanged_from)
    }

    fn create_locked(
        &self,
        git: &Git,
        ws: &WorkspaceRoot,
        shadow: &Path,
        id: &str,
        user_repo: Option<&Repo>,
        skip_if_unchanged_from: Option<&str>,
    ) -> Result<CreateOutcome> {
        let before = Self::object_bytes(shadow);
        let (tree, files, large) = self.snapshot_tree(git, ws, shadow)?;
        if let Some(previous) = skip_if_unchanged_from {
            if !is_object_id(previous) {
                return Err(KalError::validation(
                    "invalid_revision",
                    "That checkpoint commit isn't valid.",
                ));
            }
            let prev_tree = git
                .cmd()
                .git_dir(shadow, None)
                .args(["rev-parse", "--verify", "--quiet"])
                .arg(format!("{previous}^{{tree}}"))
                .run()?;
            if prev_tree.status.success() && prev_tree.stdout_text().trim() == tree {
                return Ok(CreateOutcome::Unchanged {
                    unchanged_since: previous.to_owned(),
                });
            }
        }
        let user_head = match user_repo {
            Some(repo) => {
                let out = repo
                    .cmd(git)
                    .args(["rev-parse", "--verify", "--quiet", "HEAD"])
                    .read_only()
                    .run()?;
                let head = out.stdout_text().trim().to_owned();
                (out.status.success() && is_object_id(&head)).then_some(head)
            }
            None => None,
        };
        let message = format!(
            "KalCode checkpoint\n\nKalCode-Checkpoint: {id}\nKalCode-Workspace-Head: {}\nKalCode-Skipped-Large: {}\n",
            user_head.as_deref().unwrap_or("none"),
            large.len()
        );
        let commit = git
            .cmd()
            .git_dir(shadow, None)
            .env("GIT_AUTHOR_NAME", IDENTITY_NAME)
            .env("GIT_AUTHOR_EMAIL", IDENTITY_EMAIL)
            .env("GIT_COMMITTER_NAME", IDENTITY_NAME)
            .env("GIT_COMMITTER_EMAIL", IDENTITY_EMAIL)
            .args(["commit-tree", &tree, "-F", "-"])
            .stdin(message.into_bytes())
            .run_ok("checkpoint")?
            .stdout_text()
            .trim()
            .to_owned();
        if !is_object_id(&commit) {
            return Err(git_error(
                "checkpoint_failed",
                "Git didn't return the checkpoint commit.",
            ));
        }
        git.cmd()
            .git_dir(shadow, None)
            .args(["update-ref", &format!("{REF_PREFIX}{id}"), &commit, ""])
            .run_ok("checkpoint")?;
        let after = Self::object_bytes(shadow);
        Ok(CreateOutcome::Created(CreatedCheckpoint {
            id: id.to_owned(),
            commit_oid: commit,
            tree_oid: tree,
            files,
            bytes_added: after.saturating_sub(before),
            skipped_large: u32::try_from(large.len()).unwrap_or(u32::MAX),
            user_head,
        }))
    }

    fn checkpoint_tree(&self, git: &Git, shadow: &Path, commit: &str) -> Result<String> {
        if !is_object_id(commit) {
            return Err(KalError::validation(
                "invalid_revision",
                "That checkpoint commit isn't valid.",
            ));
        }
        let out = git
            .cmd()
            .git_dir(shadow, None)
            .args(["rev-parse", "--verify", "--quiet"])
            .arg(format!("{commit}^{{tree}}"))
            .run()?;
        let tree = out.stdout_text().trim().to_owned();
        if !out.status.success() || !is_object_id(&tree) {
            return Err(git_error(
                "checkpoint_missing",
                "That checkpoint is no longer available.",
            ));
        }
        Ok(tree)
    }

    /// Previews restoring `checkpoint_oid` (optionally only `paths`). Changes no user file.
    pub fn plan_restore(
        &self,
        git: &Git,
        ws: &WorkspaceRoot,
        checkpoint_oid: &str,
        paths: Option<&[RelPath]>,
        delete_added: bool,
    ) -> Result<RestorePlan> {
        let lock = self.lock(ws.id());
        let _guard = lock.lock().unwrap_or_else(PoisonError::into_inner);
        let shadow = self.prepare(git, ws)?;
        let target_tree = self.checkpoint_tree(git, &shadow, checkpoint_oid)?;
        let (current_tree, _, _) = self.snapshot_tree(git, ws, &shadow)?;
        let mut cmd = git.cmd().git_dir(&shadow, None).args([
            "diff-tree",
            "-r",
            "-z",
            "--no-renames",
            "--name-status",
            &current_tree,
            &target_tree,
            "--",
        ]);
        if let Some(paths) = paths {
            cmd = cmd.args(paths.iter().map(|p| format!(":(literal){p}")));
        }
        let out = cmd.run_ok("restore")?;
        let mut changes = Vec::new();
        let mut fields = out.stdout.split(|b| *b == 0).filter(|f| !f.is_empty());
        while let (Some(status), Some(path)) = (fields.next(), fields.next()) {
            let Ok(path) = std::str::from_utf8(path) else {
                continue;
            };
            let change = match status.first() {
                Some(b'A') => {
                    // In the checkpoint, not in the current snapshot. If a file is there anyway,
                    // it is ignored or oversized now: never overwrite what we cannot protect.
                    if std::fs::symlink_metadata(ws.path().join(path)).is_ok() {
                        PlannedChange::KeepExisting
                    } else {
                        PlannedChange::Create
                    }
                }
                Some(b'D') if delete_added => PlannedChange::Delete,
                Some(b'D') => PlannedChange::KeepUntracked,
                _ => PlannedChange::Overwrite,
            };
            changes.push(PlannedFileChange {
                path: path.to_owned(),
                change,
            });
        }
        let mut plan = RestorePlan {
            workspace_id: ws.id().to_owned(),
            checkpoint_oid: checkpoint_oid.to_owned(),
            current_tree,
            target_tree,
            changes,
            delete_added,
            digest: String::new(),
        };
        plan.digest = plan_digest(&plan);
        Ok(plan)
    }

    /// Executes a confirmed restore plan. Takes the safety checkpoint `safety_id` first; if
    /// the working tree changed since the plan, writes nothing and reports
    /// [`RestoreResult::PlanStale`].
    pub fn execute_restore(
        &self,
        git: &Git,
        ws: &WorkspaceRoot,
        plan: &RestorePlan,
        confirmation: RestoreConfirmation,
        safety_id: &str,
        user_repo: Option<&Repo>,
    ) -> Result<RestoreOutcome> {
        if confirmation.digest != plan.digest || plan_digest(plan) != plan.digest {
            return Err(KalError::new(
                ErrorCategory::Permission,
                "restore_not_confirmed",
                "This restore wasn't confirmed. Nothing was changed.",
            ));
        }
        if plan.workspace_id != ws.id() {
            return Err(KalError::validation(
                "restore_wrong_workspace",
                "That restore belongs to another workspace.",
            ));
        }
        let lock = self.lock(ws.id());
        let _guard = lock.lock().unwrap_or_else(PoisonError::into_inner);
        let shadow = self.prepare(git, ws)?;
        let CreateOutcome::Created(safety) =
            self.create_locked(git, ws, &shadow, safety_id, user_repo, None)?
        else {
            return Err(git_error(
                "checkpoint_failed",
                "KalCode couldn't take the safety checkpoint.",
            ));
        };
        if safety.tree_oid != plan.current_tree {
            return Ok(RestoreOutcome {
                safety,
                result: RestoreResult::PlanStale,
            });
        }

        let mut write: Vec<&str> = Vec::new();
        let mut delete: Vec<&str> = Vec::new();
        for change in &plan.changes {
            match change.change {
                PlannedChange::Overwrite | PlannedChange::Create => write.push(&change.path),
                PlannedChange::Delete => delete.push(&change.path),
                PlannedChange::KeepUntracked | PlannedChange::KeepExisting => {}
            }
        }
        // Validate every path before touching anything.
        for path in write.iter().chain(delete.iter()) {
            check_write_path(ws, path)?;
        }

        if !write.is_empty() {
            let index = shadow.join(format!("kalcode-restore-{safety_id}.index"));
            let result = (|| {
                self.shadow_cmd(git, ws, &shadow)
                    .env("GIT_INDEX_FILE", index.as_os_str())
                    .args(["read-tree", &plan.target_tree])
                    .run_ok("restore")?;
                let list: Vec<u8> = write
                    .iter()
                    .flat_map(|p| format!("{p}\0").into_bytes())
                    .collect();
                self.shadow_cmd(git, ws, &shadow)
                    .env("GIT_INDEX_FILE", index.as_os_str())
                    .args(["checkout-index", "--force", "-z", "--stdin"])
                    .stdin(list)
                    .timeout(Duration::from_secs(600))
                    .run_ok("restore")
            })();
            let _ = std::fs::remove_file(&index);
            result?;
        }
        let mut deleted = 0u32;
        for path in &delete {
            if remove_entry(ws, path)? {
                deleted += 1;
            }
        }
        Ok(RestoreOutcome {
            safety,
            result: RestoreResult::Applied {
                written: u32::try_from(write.len()).unwrap_or(u32::MAX),
                deleted,
            },
        })
    }

    /// Diffs a checkpoint against another checkpoint or (when `to` is `None`) the current files.
    pub fn diff(
        &self,
        git: &Git,
        ws: &WorkspaceRoot,
        from_oid: &str,
        to_oid: Option<&str>,
        options: &DiffOptions,
        handles: &HandleRegistry,
    ) -> Result<Diff> {
        let lock = self.lock(ws.id());
        let _guard = lock.lock().unwrap_or_else(PoisonError::into_inner);
        let shadow = self.prepare(git, ws)?;
        let from = self.checkpoint_tree(git, &shadow, from_oid)?;
        let to = match to_oid {
            Some(oid) => self.checkpoint_tree(git, &shadow, oid)?,
            None => self.snapshot_tree(git, ws, &shadow)?.0,
        };
        let raw = run_diff(
            || git.cmd().git_dir(&shadow, None),
            &DiffTarget::Commits { from, to },
            &[],
            options,
        )?;
        Ok(raw.into_view(ws.id(), handles, |p| RelPath::parse(p).ok()))
    }

    /// Creates branch `branch` in the user's repository at the checkpoint: one new commit whose
    /// parent is the user's HEAD at checkpoint time (when it still exists) and whose tree is the
    /// checkpointed workspace. Additive only. Returns the new commit id.
    pub fn export_branch(
        &self,
        git: &Git,
        ws: &WorkspaceRoot,
        repo: &Repo,
        checkpoint_id: &str,
        checkpoint_oid: &str,
        branch: &str,
    ) -> Result<String> {
        validate_branch_name(branch)?;
        if !is_valid_id(checkpoint_id) {
            return Err(KalError::validation(
                "invalid_id",
                "That checkpoint id isn't valid.",
            ));
        }
        let lock = self.lock(ws.id());
        let _guard = lock.lock().unwrap_or_else(PoisonError::into_inner);
        let shadow = self.prepare(git, ws)?;
        let tree = self.checkpoint_tree(git, &shadow, checkpoint_oid)?;
        let body = git
            .cmd()
            .git_dir(&shadow, None)
            .args(["cat-file", "commit", checkpoint_oid])
            .run_ok("checkpoint")?
            .stdout_text();
        let recorded_head = body
            .lines()
            .find_map(|l| l.strip_prefix("KalCode-Workspace-Head: "))
            .map(str::trim)
            .filter(|h| is_object_id(h))
            .map(str::to_owned);

        let exists = repo
            .cmd(git)
            .args([
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ])
            .read_only()
            .run()?;
        if exists.status.success() {
            return Err(git_error(
                "already_exists",
                "A branch with that name already exists.",
            ));
        }
        repo.cmd(git)
            .args([
                "fetch",
                "--quiet",
                "--no-tags",
                "--no-write-fetch-head",
                "--no-recurse-submodules",
            ])
            .arg(crate::paths::plain(&shadow))
            .arg(format!("{REF_PREFIX}{checkpoint_id}"))
            .timeout(Duration::from_secs(600))
            .run_ok("checkpoint")?;
        let parent = match recorded_head {
            Some(head) => repo
                .cmd(git)
                .args(["cat-file", "-e", &format!("{head}^{{commit}}")])
                .read_only()
                .run()?
                .status
                .success()
                .then_some(head),
            None => None,
        };
        let tree = if repo.prefix().is_empty() {
            tree
        } else {
            self.graft_subtree(git, repo, parent.as_deref(), &tree, checkpoint_id)?
        };
        let mut commit = repo
            .cmd(git)
            .env("GIT_AUTHOR_NAME", IDENTITY_NAME)
            .env("GIT_AUTHOR_EMAIL", IDENTITY_EMAIL)
            .env("GIT_COMMITTER_NAME", IDENTITY_NAME)
            .env("GIT_COMMITTER_EMAIL", IDENTITY_EMAIL)
            .args(["commit-tree", &tree]);
        if let Some(parent) = &parent {
            commit = commit.args(["-p", parent]);
        }
        let oid = commit
            .args(["-F", "-"])
            .stdin(
                format!("Workspace state from KalCode checkpoint {checkpoint_id}\n").into_bytes(),
            )
            .run_ok("checkpoint")?
            .stdout_text()
            .trim()
            .to_owned();
        if !is_object_id(&oid) {
            return Err(git_error(
                "checkpoint_failed",
                "Git didn't return the new commit.",
            ));
        }
        repo.cmd(git)
            .args([
                "update-ref",
                "-m",
                "KalCode: branch from checkpoint",
                &format!("refs/heads/{branch}"),
                &oid,
                "",
            ])
            .run_ok("checkpoint")?;
        Ok(oid)
    }

    /// For a workspace below the repository top level: the parent's tree with the workspace
    /// subtree replaced, built in a temporary index (the user's index is untouched).
    fn graft_subtree(
        &self,
        git: &Git,
        repo: &Repo,
        parent: Option<&str>,
        subtree: &str,
        id: &str,
    ) -> Result<String> {
        let index = self.base_dir.join(format!("kalcode-graft-{id}.index"));
        let result = (|| {
            fn with_index<'g>(cmd: Cmd<'g>, index: &Path) -> Cmd<'g> {
                cmd.env("GIT_INDEX_FILE", index.as_os_str())
            }
            let with_index = |cmd| with_index(cmd, &index);
            match parent {
                Some(p) => with_index(repo.cmd(git))
                    .args(["read-tree", p])
                    .run_ok("checkpoint")?,
                None => with_index(repo.cmd(git))
                    .args(["read-tree", "--empty"])
                    .run_ok("checkpoint")?,
            };
            with_index(repo.cmd(git))
                .args(["rm", "--cached", "-r", "-f", "-q", "--ignore-unmatch", "--"])
                .arg(format!(":(top,literal){}", repo.prefix()))
                .run_ok("checkpoint")?;
            with_index(repo.cmd(git))
                .args([
                    "read-tree",
                    &format!("--prefix={}/", repo.prefix()),
                    subtree,
                ])
                .run_ok("checkpoint")?;
            Ok(with_index(repo.cmd(git))
                .arg("write-tree")
                .run_ok("checkpoint")?
                .stdout_text()
                .trim()
                .to_owned())
        })();
        let _ = std::fs::remove_file(&index);
        result
    }

    /// Deletes a checkpoint's ref (its objects go at the next [`Self::collect_garbage`]).
    pub fn delete_ref(&self, git: &Git, workspace_id: &str, checkpoint_id: &str) -> Result<()> {
        if !is_valid_id(checkpoint_id) {
            return Err(KalError::validation(
                "invalid_id",
                "That checkpoint id isn't valid.",
            ));
        }
        let shadow = self.shadow_dir(workspace_id)?;
        if !shadow.exists() {
            return Ok(());
        }
        git.cmd()
            .git_dir(&shadow, None)
            .args(["update-ref", "-d", &format!("{REF_PREFIX}{checkpoint_id}")])
            .run_ok("checkpoint")?;
        Ok(())
    }

    /// Removes objects no checkpoint references any more.
    pub fn collect_garbage(&self, git: &Git, workspace_id: &str) -> Result<()> {
        let shadow = self.shadow_dir(workspace_id)?;
        if !shadow.exists() {
            return Ok(());
        }
        let lock = self.lock(workspace_id);
        let _guard = lock.lock().unwrap_or_else(PoisonError::into_inner);
        git.cmd()
            .git_dir(&shadow, None)
            .args(["gc", "--prune=now", "--quiet"])
            .timeout(Duration::from_secs(600))
            .run_ok("checkpoint")?;
        Ok(())
    }

    /// Disk used by a workspace's shadow repository (visible usage, quota checks).
    pub fn usage_bytes(&self, workspace_id: &str) -> Result<u64> {
        let shadow = self.shadow_dir(workspace_id)?;
        Ok(dir_size(&shadow))
    }

    /// Prunes the oldest unpinned checkpoints until usage is within the quota. `candidates` are
    /// `(checkpoint_id)` in pruning order (oldest unpinned first, from `store::prune_candidates`).
    /// Returns the ids whose refs were deleted; mark them pruned in the database.
    pub fn prune_to_quota(
        &self,
        git: &Git,
        workspace_id: &str,
        candidates: &[String],
    ) -> Result<Vec<String>> {
        let mut pruned = Vec::new();
        let mut remaining = candidates.iter();
        while self.usage_bytes(workspace_id)? > self.options.quota_bytes {
            let batch: Vec<&String> = remaining
                .by_ref()
                .take(candidates.len().div_ceil(10).max(1))
                .collect();
            if batch.is_empty() {
                break;
            }
            for id in batch {
                self.delete_ref(git, workspace_id, id)?;
                pruned.push(id.clone());
            }
            self.collect_garbage(git, workspace_id)?;
        }
        Ok(pruned)
    }

    /// Deletes a workspace's whole checkpoint store (workspace removed).
    pub fn remove_store(&self, workspace_id: &str) -> Result<()> {
        let shadow = self.shadow_dir(workspace_id)?;
        if shadow.exists() {
            std::fs::remove_dir_all(&shadow).map_err(fs_error(
                "checkpoint_store_unavailable",
                "KalCode couldn't remove the workspace's checkpoints.",
            ))?;
        }
        Ok(())
    }
}

fn plan_digest(plan: &RestorePlan) -> String {
    let mut hasher = Sha256::new();
    for part in [
        &plan.workspace_id,
        &plan.checkpoint_oid,
        &plan.current_tree,
        &plan.target_tree,
    ] {
        hasher.update(part.as_bytes());
        hasher.update([0]);
    }
    hasher.update([u8::from(plan.delete_added)]);
    for change in &plan.changes {
        hasher.update(change.path.as_bytes());
        hasher.update([0, change.change as u8, 0]);
    }
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn write_if_changed(path: &Path, content: &[u8]) -> Result<()> {
    if std::fs::read(path).is_ok_and(|existing| existing == content) {
        return Ok(());
    }
    std::fs::write(path, content).map_err(fs_error(
        "checkpoint_store_unavailable",
        "KalCode couldn't prepare its checkpoint folder.",
    ))
}

fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .filter_map(std::result::Result::ok)
        .map(|entry| match entry.file_type() {
            Ok(t) if t.is_dir() => dir_size(&entry.path()),
            Ok(t) if t.is_file() => entry.metadata().map(|m| m.len()).unwrap_or(0),
            _ => 0,
        })
        .sum()
}

/// Refuses a restore path unless every existing ancestor below the root is a real directory
/// (not a symlink or junction) and the path is a valid workspace path.
fn check_write_path(ws: &WorkspaceRoot, path: &str) -> Result<()> {
    let unsafe_path = || {
        KalError::new(
            ErrorCategory::Permission,
            "restore_path_unsafe",
            "A file in this restore goes through a link to another folder, so nothing was restored.",
        )
    };
    let rel = RelPath::parse(path).map_err(|_| unsafe_path())?;
    let mut current = ws.path().to_path_buf();
    let parts: Vec<&str> = rel.components().collect();
    for part in &parts[..parts.len().saturating_sub(1)] {
        current.push(part);
        match std::fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => return Err(unsafe_path()),
            Ok(meta) if !meta.is_dir() => return Err(unsafe_path()),
            Ok(_) => {}
            Err(_) => break, // Missing: git creates real directories.
        }
    }
    ws.resolve(&rel).map(|_| ()).map_err(|_| unsafe_path())
}

/// Deletes one planned file (a link is removed as a link). Empty parent folders up to the root
/// are removed too. Returns whether something was deleted.
fn remove_entry(ws: &WorkspaceRoot, path: &str) -> Result<bool> {
    let rel = RelPath::parse(path)?;
    let native = rel.to_native(ws.path());
    let Ok(meta) = std::fs::symlink_metadata(&native) else {
        return Ok(false);
    };
    let removed = if meta.file_type().is_symlink() {
        std::fs::remove_file(&native).or_else(|_| std::fs::remove_dir(&native))
    } else if meta.is_file() {
        std::fs::remove_file(&native)
    } else {
        return Ok(false);
    };
    removed.map_err(fs_error(
        "restore_delete_failed",
        "KalCode couldn't delete a file during the restore.",
    ))?;
    let mut parent = rel.parent();
    while let Some(dir) = parent {
        if std::fs::remove_dir(dir.to_native(ws.path())).is_err() {
            break; // Not empty (or not ours to remove).
        }
        parent = dir.parent();
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digest_covers_every_decision() {
        let mut plan = RestorePlan {
            workspace_id: "w".into(),
            checkpoint_oid: "c".into(),
            current_tree: "a".into(),
            target_tree: "b".into(),
            changes: vec![PlannedFileChange {
                path: "x".into(),
                change: PlannedChange::KeepUntracked,
            }],
            delete_added: false,
            digest: String::new(),
        };
        let first = plan_digest(&plan);
        plan.changes[0].change = PlannedChange::Delete;
        assert_ne!(first, plan_digest(&plan));
        plan.changes[0].change = PlannedChange::KeepUntracked;
        plan.delete_added = true;
        assert_ne!(first, plan_digest(&plan));
    }
}
