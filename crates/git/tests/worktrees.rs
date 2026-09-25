//! Worktrees: create (managed, recorded in `git_worktrees`), list, and removal that refuses to
//! lose uncommitted work unless explicitly forced.

// Test helpers outside `#[test]` functions panic on setup failures by design.
#![allow(clippy::expect_used)]

mod common;

use common::Fixture;
use kalcode_core::db::Migration;
use kalcode_git::repo::Repo;
use kalcode_git::store::{self, GIT_MIGRATION};
use kalcode_git::types::{WorktreePurpose, WorktreeStatus};
use kalcode_git::worktree::{self, RemoveMode, WorktreeStart};

fn db() -> rusqlite::Connection {
    let mut conn = kalcode_core::db::open_in_memory().expect("db");
    let mut all = kalcode_core::db::MIGRATIONS.to_vec();
    for version in (all.len() as i64 + 1)..7 {
        all.push(Migration {
            version,
            name: "reserved",
            sql: "SELECT 1;",
        });
    }
    all.push(GIT_MIGRATION);
    kalcode_core::db::migrate(&mut conn, &all, None).expect("migrate");
    conn
}

#[test]
fn managed_worktree_lifecycle_with_safe_removal() {
    let fx = Fixture::repo();
    let repo = Repo::discover(&fx.git, &fx.ws)
        .expect("discover")
        .expect("repo");
    let conn = db();
    let root = fx.data.join("worktrees");

    let new = worktree::create_managed(
        &fx.git,
        &repo,
        &root,
        "kal/task-1",
        None,
        WorktreePurpose::Task,
        Some("task-1".into()),
    )
    .expect("create");
    assert!(
        new.path.starts_with(root.join(fx.ws.id())),
        "native path under the data folder"
    );
    assert!(new.path.join("README.md").exists());
    let row = store::insert_worktree(&conn, &new).expect("record");
    assert_eq!(row.branch, "kal/task-1");
    assert_eq!(row.base_commit, fx.git_plain(&["rev-parse", "HEAD"]).trim());

    let listed = worktree::list(&fx.git, &repo).expect("list");
    assert_eq!(listed.len(), 2);
    assert!(listed[0].main);
    assert_eq!(listed[1].branch.as_deref(), Some("kal/task-1"));

    // Uncommitted work: safe removal refuses and nothing is lost.
    std::fs::write(new.path.join("work.txt"), "unsaved thoughts").expect("write");
    let err = worktree::remove(&fx.git, &repo, &new.path, RemoveMode::Safe).expect_err("dirty");
    assert_eq!(err.code, "worktree_dirty");
    assert!(new.path.join("work.txt").exists());
    // A modified tracked file counts too.
    std::fs::remove_file(new.path.join("work.txt")).expect("rm");
    std::fs::write(new.path.join("README.md"), "edited").expect("write");
    let dirty = worktree::dirty_state(&fx.git, &repo, &new.path).expect("dirty");
    assert_eq!((dirty.changed, dirty.untracked), (1, 0));
    assert_eq!(
        worktree::remove(&fx.git, &repo, &new.path, RemoveMode::Safe)
            .expect_err("dirty")
            .code,
        "worktree_dirty"
    );

    // The explicit destructive choice removes it; the branch is kept.
    worktree::remove(&fx.git, &repo, &new.path, RemoveMode::ForceDiscardChanges).expect("force");
    assert!(!new.path.exists());
    assert!(common::try_plain(
        &fx.root,
        &["rev-parse", "--verify", "kal/task-1"]
    ));
    let removed =
        store::set_worktree_status(&conn, &row.id, WorktreeStatus::Removed).expect("status");
    assert!(removed.removed_at.is_some());
}

#[test]
fn clean_worktree_is_removed_safely_and_the_main_folder_never() {
    let fx = Fixture::repo();
    let repo = Repo::discover(&fx.git, &fx.ws)
        .expect("discover")
        .expect("repo");
    let path = fx.data.join("wt-clean");
    worktree::add(
        &fx.git,
        &repo,
        &path,
        &WorktreeStart::Detached {
            revision: "HEAD".into(),
        },
    )
    .expect("add");
    worktree::remove(&fx.git, &repo, &path, RemoveMode::Safe).expect("safe remove");
    assert!(!path.exists());

    let err = worktree::remove(&fx.git, &repo, &fx.root, RemoveMode::ForceDiscardChanges)
        .expect_err("main");
    assert_eq!(err.code, "worktree_is_main");
    let err =
        worktree::remove(&fx.git, &repo, fx.temp.path(), RemoveMode::Safe).expect_err("unknown");
    assert_eq!(err.code, "worktree_unknown");
}

#[test]
fn worktree_inputs_are_validated() {
    let fx = Fixture::repo();
    let repo = Repo::discover(&fx.git, &fx.ws)
        .expect("discover")
        .expect("repo");
    let path = fx.data.join("wt-bad");
    for start in [
        WorktreeStart::NewBranch {
            name: "--orphan".into(),
            start: None,
        },
        WorktreeStart::NewBranch {
            name: "ok".into(),
            start: Some("--detach".into()),
        },
        WorktreeStart::Detached {
            revision: "HEAD:secret".into(),
        },
    ] {
        assert!(
            worktree::add(&fx.git, &repo, &path, &start).is_err(),
            "{start:?}"
        );
    }
    assert!(!path.exists());
    // An existing folder is never reused.
    std::fs::create_dir_all(&path).expect("mkdir");
    let err = worktree::add(
        &fx.git,
        &repo,
        &path,
        &WorktreeStart::Detached {
            revision: "HEAD".into(),
        },
    )
    .expect_err("exists");
    assert_eq!(err.code, "already_exists");
}
