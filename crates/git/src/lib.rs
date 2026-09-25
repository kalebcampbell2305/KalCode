//! KalCode Git and workspace files core (campaign Z6a).
//!
//! * [`runner`] — invokes the **user's installed `git`** by argv with a sanitized environment,
//!   hooks and every repository-configurable code path disabled, timeouts and output caps.
//! * [`repo`], [`status`], [`diff`], [`log`], [`worktree`] — repository discovery, status
//!   (porcelain v2: renames, untracked, conflicts), diffs with hunks and numstat, paged history,
//!   branches, and worktrees with safe removal.
//! * [`checkpoint`] — the checkpoint store: a self-contained shadow repository per workspace in
//!   KalCode's data folder (ADVANCED.md §3 D2). Never writes to the user's repository except the
//!   explicit, additive "branch from checkpoint".
//! * [`paths`], [`handles`], [`index`], [`watch`] — workspace containment, opaque file handles
//!   (D4), the ignore-aware file index and its incremental watcher.
//! * [`store`] — SQLite migration v7 ([`store::GIT_MIGRATION`], not yet registered) and its
//!   tables `git_worktrees` and `checkpoints`.
//! * [`events`] — the proposed `git.*` / `timeline.checkpoint_*` event facts.
//! * [`service`] — [`service::GitCore`], what the desktop shell holds.
//!
//! Every operation documents its destructiveness in its module docs; the summary table is in
//! `docs/campaigns/Z6a.md`.

pub mod checkpoint;
pub mod diff;
pub mod env;
pub mod events;
pub mod handles;
pub mod index;
pub mod log;
pub mod paths;
pub mod repo;
pub mod runner;
pub mod service;
mod snapshot;
pub mod status;
pub mod store;
pub mod types;
pub mod watch;
pub mod worktree;

pub use paths::{RelPath, WorkspaceRoot};
pub use runner::Git;
pub use service::GitCore;
