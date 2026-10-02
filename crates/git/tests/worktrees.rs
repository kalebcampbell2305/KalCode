//! Worktrees: create (managed, recorded in `git_worktrees`), list, and removal that refuses to
//! lose uncommitted work unless explicitly forced.

// Test helpers outside `#[test]` functions panic on setup failures by design.
#![allow(clippy::expect_used)]

mod common;

use common::Fixture;
use kalcode_git::repo::Repo;
use kalcode_git::store;
use kalcode_git::types::{WorktreePurpose, WorktreeStatus};
use kalcode_git::worktree::{self, RemoveMode, WorktreeStart};

fn db() -> rusqlite::Connection {
    let mut conn = kalcode_core::db::open_in_memory().expect("db");
    kalcode_core::db::migrate(&mut conn, kalcode_core::db::MIGRATIONS, None).expect("migrate");
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

#[test]
fn branch_comparison_and_merge_prediction() {
    let fx = Fixture::repo();
    let repo = Repo::discover(&fx.git, &fx.ws)
        .expect("discover")
        .expect("repo");
    let conn = db();
    let thread_id = kalcode_contracts::ids::new_id();
    let new = worktree::create_managed(
        &fx.git,
        &repo,
        &fx.data.join("worktrees"),
        "kal/agent-1",
        None,
        WorktreePurpose::Thread,
        Some(thread_id.clone()),
    )
    .expect("create");
    let row = store::insert_worktree(&conn, &new).expect("record");
    let (bound, path) = store::active_thread_worktree(&conn, &thread_id)
        .expect("lookup")
        .expect("bound");
    assert_eq!(
        (bound.id.as_str(), path.as_path()),
        (row.id.as_str(), new.path.as_path())
    );
    assert!(
        store::active_thread_worktree(&conn, &kalcode_contracts::ids::new_id())
            .expect("lookup")
            .is_none()
    );

    let (base, branch) = ("refs/heads/main", "refs/heads/kal/agent-1");
    assert_eq!(
        worktree::current_branch(&fx.git, &repo).expect("branch"),
        Some("main".into())
    );
    assert_eq!(
        worktree::ahead_behind(&fx.git, &repo, base, branch).expect("count"),
        (0, 0)
    );
    assert_eq!(
        worktree::merge_conflicts(&fx.git, &repo, base, branch).expect("predict"),
        Some(false)
    );

    // The agent commits in its worktree; the main folder moves on separately.
    std::fs::write(new.path.join("agent.txt"), "agent work\n").expect("write");
    common::run_plain(&new.path, &["add", "-A"]);
    common::run_plain(&new.path, &["commit", "-q", "--no-verify", "-m", "agent"]);
    fx.write("main.txt", "main work\n");
    fx.commit_all("main 1");
    fx.write("main2.txt", "more main work\n");
    fx.commit_all("main 2");
    assert_eq!(
        worktree::ahead_behind(&fx.git, &repo, base, branch).expect("count"),
        (2, 1),
        "(behind, ahead)"
    );
    assert_eq!(
        worktree::merge_conflicts(&fx.git, &repo, base, branch).expect("predict"),
        Some(false)
    );

    // Both sides change the same line: a conflict, and nothing in either folder changes.
    std::fs::write(new.path.join("README.md"), "agent hello\n").expect("write");
    common::run_plain(
        &new.path,
        &["commit", "-q", "--no-verify", "-am", "agent readme"],
    );
    fx.write("README.md", "main hello\n");
    fx.commit_all("main readme");
    let head = fx.git_plain(&["rev-parse", "HEAD"]);
    assert_eq!(
        worktree::merge_conflicts(&fx.git, &repo, base, branch).expect("predict"),
        Some(true)
    );
    assert_eq!(fx.git_plain(&["rev-parse", "HEAD"]), head);
    assert_eq!(fx.read("README.md"), b"main hello\n");
    assert!(
        worktree::dirty_state(&fx.git, &repo, &fx.root)
            .expect("dirty")
            .is_clean()
    );

    // A merge driver defined by the repository's own config is never run: unknown.
    fx.git_plain(&["config", "merge.custom.driver", "false %O %A %B"]);
    let configured = Repo::discover(&fx.git, &fx.ws)
        .expect("discover")
        .expect("repo");
    assert!(configured.defines_merge_driver());
    assert_eq!(
        worktree::merge_conflicts(&fx.git, &configured, base, branch).expect("predict"),
        None
    );

    // Unsafe revisions never reach git.
    assert!(worktree::ahead_behind(&fx.git, &repo, "--all", branch).is_err());
    assert!(worktree::merge_conflicts(&fx.git, &repo, base, "a..b").is_err());

    // Rolling back a new worktree deletes its branch only while nothing was committed on it.
    let rollback = worktree::create_managed(
        &fx.git,
        &repo,
        &fx.data.join("worktrees"),
        "kal/rollback-1",
        None,
        WorktreePurpose::Thread,
        None,
    )
    .expect("create");
    worktree::remove(&fx.git, &repo, &rollback.path, RemoveMode::Safe).expect("remove");
    assert!(
        worktree::discard_new_branch(&fx.git, &repo, "kal/agent-1", &rollback.base_commit).is_err(),
        "a branch that moved on is kept"
    );
    assert!(common::try_plain(
        &fx.root,
        &["rev-parse", "--verify", "kal/agent-1"]
    ));
    worktree::discard_new_branch(&fx.git, &repo, "kal/rollback-1", &rollback.base_commit)
        .expect("discard");
    assert!(!common::try_plain(
        &fx.root,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            "refs/heads/kal/rollback-1"
        ]
    ));

    // A detached main folder has no base branch.
    fx.git_plain(&["checkout", "-q", "--detach"]);
    assert_eq!(
        worktree::current_branch(&fx.git, &repo).expect("branch"),
        None
    );
}

#[test]
fn a_lost_worktree_folder_is_reattached_from_its_branch() {
    let fx = Fixture::repo();
    let repo = Repo::discover(&fx.git, &fx.ws)
        .expect("discover")
        .expect("repo");
    let root = fx.data.join("worktrees");
    let first = worktree::create_managed(
        &fx.git,
        &repo,
        &root,
        "kal/agent-2",
        None,
        WorktreePurpose::Thread,
        None,
    )
    .expect("create");
    std::fs::write(first.path.join("agent.txt"), "committed work\n").expect("write");
    common::run_plain(&first.path, &["add", "-A"]);
    common::run_plain(&first.path, &["commit", "-q", "--no-verify", "-m", "agent"]);

    // While the branch is checked out in a live worktree, git refuses a second one.
    assert!(
        worktree::attach_managed(
            &fx.git,
            &repo,
            &root,
            "kal/agent-2",
            WorktreePurpose::Thread,
            None
        )
        .is_err()
    );
    assert_eq!(worktree::list(&fx.git, &repo).expect("list").len(), 2);

    // The folder disappears (deleted by hand): git still lists it until it is forgotten.
    std::fs::remove_dir_all(&first.path).expect("delete folder");
    worktree::forget_missing(&fx.git, &repo, &first.path).expect("forget");
    assert_eq!(worktree::list(&fx.git, &repo).expect("list").len(), 1);
    let again = worktree::attach_managed(
        &fx.git,
        &repo,
        &root,
        "kal/agent-2",
        WorktreePurpose::Thread,
        Some("owner".into()),
    )
    .expect("reattach");
    assert_ne!(again.path, first.path);
    assert_eq!(
        std::fs::read_to_string(again.path.join("agent.txt")).expect("committed work is back"),
        "committed work\n"
    );
    assert_eq!(
        worktree::attach_managed(
            &fx.git,
            &repo,
            &root,
            "kal/no-such-branch",
            WorktreePurpose::Thread,
            None
        )
        .expect_err("missing")
        .code,
        "branch_missing"
    );
    assert_eq!(
        worktree::head_commit(&fx.git, &repo).expect("head"),
        Some(fx.git_plain(&["rev-parse", "HEAD"]).trim().to_owned())
    );
}

#[test]
fn a_failed_create_leaves_nothing_behind_and_keeps_existing_branches() {
    let fx = Fixture::repo();
    let repo = Repo::discover(&fx.git, &fx.ws)
        .expect("discover")
        .expect("repo");
    let root = fx.data.join("worktrees");
    // A branch the user already has, pointing at HEAD: the failed create must not delete it.
    fx.git_plain(&["branch", "kal/users-own"]);
    let err = worktree::create_managed(
        &fx.git,
        &repo,
        &root,
        "kal/users-own",
        None,
        WorktreePurpose::Thread,
        None,
    )
    .expect_err("branch exists");
    assert_eq!(err.code, "already_exists");
    assert!(common::try_plain(
        &fx.root,
        &["rev-parse", "--verify", "refs/heads/kal/users-own"]
    ));
    assert_eq!(worktree::list(&fx.git, &repo).expect("list").len(), 1);
    let leftovers = std::fs::read_dir(root.join(fx.ws.id()))
        .map(|dir| dir.count())
        .unwrap_or(0);
    assert_eq!(leftovers, 0, "no partial folder");
    // An unknown start revision fails before git creates anything.
    assert!(
        worktree::create_managed(
            &fx.git,
            &repo,
            &root,
            "kal/new",
            Some("no-such-rev"),
            WorktreePurpose::Thread,
            None
        )
        .is_err()
    );
    assert!(!common::try_plain(
        &fx.root,
        &["rev-parse", "--verify", "--quiet", "refs/heads/kal/new"]
    ));
}
