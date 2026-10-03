//! Checkpoint store round trips: create, unchanged detection, restore plans and execution,
//! safety checkpoints, ignored and oversized files, exact bytes, branch export, pruning.

// Test helpers outside `#[test]` functions panic on setup failures by design.
#![allow(clippy::expect_used)]

mod common;

use common::Fixture;
use kalcode_contracts::ids::new_id;
use kalcode_git::checkpoint::{
    CheckpointOptions, CheckpointStore, CreateOutcome, CreatedCheckpoint, PlannedChange,
    RestoreConfirmation, RestoreResult,
};
use kalcode_git::diff::DiffOptions;
use kalcode_git::handles::HandleRegistry;
use kalcode_git::repo::Repo;
use kalcode_git::{RelPath, WorkspaceRoot};

fn store(fx: &Fixture) -> CheckpointStore {
    CheckpointStore::new(fx.data.join("checkpoints"), CheckpointOptions::default())
}

fn created(outcome: CreateOutcome) -> CreatedCheckpoint {
    match outcome {
        CreateOutcome::Created(c) => c,
        CreateOutcome::Unchanged { .. } => panic!("expected a new checkpoint"),
    }
}

/// Everything about the user's repository that a checkpoint must never change.
fn user_repo_state(fx: &Fixture) -> (Vec<u8>, Vec<u8>, String) {
    (
        std::fs::read(fx.path(".git/index")).unwrap_or_default(),
        std::fs::read(fx.path(".git/HEAD")).expect("HEAD"),
        fx.git_plain(&["for-each-ref"]),
    )
}

#[test]
fn create_restore_round_trip_never_touches_the_users_repository() {
    let fx = Fixture::repo();
    fx.write("src/a.txt", "alpha\n");
    fx.write("src/b.txt", "bravo\n");
    fx.write(".gitignore", "*.log\n");
    fx.write("debug.log", "ignored at checkpoint time\n");
    fx.commit_all("base");
    fx.write("wip.txt", "uncommitted but snapshotted\n");
    let repo = Repo::discover(&fx.git, &fx.ws)
        .expect("discover")
        .expect("repo");
    let before = user_repo_state(&fx);
    let store = store(&fx);

    let cp = created(
        store
            .create(&fx.git, &fx.ws, &new_id(), Some(&repo), None)
            .expect("create"),
    );
    assert_eq!(
        cp.files, 5,
        "README, .gitignore, a, b, wip — and not debug.log: {cp:?}"
    );
    assert!(cp.bytes_added > 0);
    assert!(cp.user_head.is_some());
    assert_eq!(
        user_repo_state(&fx),
        before,
        "creating a checkpoint changed the user's repository"
    );

    // Unchanged files: nothing new is committed.
    let again = store
        .create(
            &fx.git,
            &fx.ws,
            &new_id(),
            Some(&repo),
            Some(&cp.commit_oid),
        )
        .expect("create");
    assert_eq!(
        again,
        CreateOutcome::Unchanged {
            unchanged_since: cp.commit_oid.clone()
        }
    );

    // Change things: modify, delete, add, and touch an ignored file.
    fx.write("src/a.txt", "ALPHA changed\n");
    std::fs::remove_file(fx.path("src/b.txt")).expect("rm");
    fx.write("added-later.txt", "new\n");
    fx.write("debug.log", "ignored and changed\n");

    let plan = store
        .plan_restore(&fx.git, &fx.ws, &cp.commit_oid, None, false)
        .expect("plan");
    let change = |p: &str| plan.changes.iter().find(|c| c.path == p).map(|c| c.change);
    assert_eq!(change("src/a.txt"), Some(PlannedChange::Overwrite));
    assert_eq!(change("src/b.txt"), Some(PlannedChange::Create));
    assert_eq!(
        change("added-later.txt"),
        Some(PlannedChange::KeepUntracked)
    );
    assert_eq!(
        change("debug.log"),
        None,
        "ignored files are never part of a restore"
    );
    assert_eq!(
        fx.read("src/a.txt"),
        b"ALPHA changed\n",
        "planning changes no file"
    );

    let safety_id = new_id();
    let outcome = store
        .execute_restore(
            &fx.git,
            &fx.ws,
            &plan,
            RestoreConfirmation::confirmed_natively(&plan),
            &safety_id,
            Some(&repo),
        )
        .expect("restore");
    assert_eq!(
        outcome.result,
        RestoreResult::Applied {
            written: 2,
            deleted: 0
        }
    );
    assert_eq!(fx.read("src/a.txt"), b"alpha\n");
    assert_eq!(fx.read("src/b.txt"), b"bravo\n");
    assert!(fx.exists("added-later.txt"), "kept by default");
    assert_eq!(fx.read("debug.log"), b"ignored and changed\n");
    assert_eq!(fx.read("wip.txt"), b"uncommitted but snapshotted\n");
    assert_eq!(user_repo_state(&fx).1, before.1, "HEAD never moves");
    assert_eq!(user_repo_state(&fx).2, before.2, "refs never change");

    // The safety checkpoint makes the restore itself undoable.
    let undo = store
        .plan_restore(&fx.git, &fx.ws, &outcome.safety.commit_oid, None, true)
        .expect("plan undo");
    store
        .execute_restore(
            &fx.git,
            &fx.ws,
            &undo,
            RestoreConfirmation::confirmed_natively(&undo),
            &new_id(),
            Some(&repo),
        )
        .expect("undo");
    assert_eq!(fx.read("src/a.txt"), b"ALPHA changed\n");
    assert!(
        !fx.exists("src/b.txt"),
        "deleted again because the undo plan asked for deletes"
    );
    assert!(fx.exists("added-later.txt"));
}

#[test]
fn restore_requires_confirmation_of_the_exact_plan_and_detects_stale_plans() {
    let fx = Fixture::repo();
    let store = store(&fx);
    let cp = created(
        store
            .create(&fx.git, &fx.ws, &new_id(), None, None)
            .expect("create"),
    );
    fx.write("README.md", "changed\n");
    let plan = store
        .plan_restore(&fx.git, &fx.ws, &cp.commit_oid, None, false)
        .expect("plan");

    // A confirmation for a different plan is refused and changes nothing.
    let other = store
        .plan_restore(&fx.git, &fx.ws, &cp.commit_oid, None, true)
        .expect("plan");
    assert_ne!(other.digest, plan.digest);
    let err = store
        .execute_restore(
            &fx.git,
            &fx.ws,
            &plan,
            RestoreConfirmation::confirmed_natively(&other),
            &new_id(),
            None,
        )
        .expect_err("unconfirmed");
    assert_eq!(err.code, "restore_not_confirmed");
    // Tampering with a confirmed plan's changes is detected too.
    let mut tampered = plan.clone();
    tampered.changes.clear();
    let err = store
        .execute_restore(
            &fx.git,
            &fx.ws,
            &tampered,
            RestoreConfirmation::confirmed_natively(&plan),
            &new_id(),
            None,
        )
        .expect_err("tampered");
    assert_eq!(err.code, "restore_not_confirmed");
    assert_eq!(fx.read("README.md"), b"changed\n");

    // The working tree changes after planning: nothing is written, but the safety checkpoint
    // (which holds the newest work) exists.
    fx.write("README.md", "changed again after the preview\n");
    let outcome = store
        .execute_restore(
            &fx.git,
            &fx.ws,
            &plan,
            RestoreConfirmation::confirmed_natively(&plan),
            &new_id(),
            None,
        )
        .expect("stale");
    assert_eq!(outcome.result, RestoreResult::PlanStale);
    assert_eq!(fx.read("README.md"), b"changed again after the preview\n");
    let back = store
        .plan_restore(&fx.git, &fx.ws, &outcome.safety.commit_oid, None, false)
        .expect("plan");
    assert!(
        back.changes.is_empty(),
        "the safety checkpoint equals the current files"
    );
}

#[test]
fn delete_added_removes_only_files_created_after_the_checkpoint() {
    let fx = Fixture::plain_folder(); // Checkpoints work without Git repositories too.
    fx.write("keep/one.txt", "1");
    let store = store(&fx);
    let cp = created(
        store
            .create(&fx.git, &fx.ws, &new_id(), None, None)
            .expect("create"),
    );
    fx.write("new-dir/deep/two.txt", "2");
    fx.write("keep/three.txt", "3");
    let plan = store
        .plan_restore(&fx.git, &fx.ws, &cp.commit_oid, None, true)
        .expect("plan");
    assert_eq!(plan.changes.len(), 2);
    assert!(
        plan.changes
            .iter()
            .all(|c| c.change == PlannedChange::Delete)
    );
    let outcome = store
        .execute_restore(
            &fx.git,
            &fx.ws,
            &plan,
            RestoreConfirmation::confirmed_natively(&plan),
            &new_id(),
            None,
        )
        .expect("restore");
    assert_eq!(
        outcome.result,
        RestoreResult::Applied {
            written: 0,
            deleted: 2
        }
    );
    assert!(!fx.exists("new-dir"), "emptied folders are removed");
    assert!(fx.exists("keep/one.txt"));
    assert!(!fx.exists("keep/three.txt"));
}

#[test]
fn snapshots_keep_exact_bytes_and_skip_large_files() {
    let fx = Fixture::repo();
    // Attributes that would normally convert line endings or run a filter.
    fx.write(".gitattributes", "*.txt text eol=crlf\n*.bin filter=lfs\n");
    fx.write_bytes("crlf.txt", b"one\r\ntwo\nthree\r\n");
    fx.write_bytes("tiny.bin", &[1, 2, 3]);
    let store = CheckpointStore::new(
        fx.data.join("checkpoints"),
        CheckpointOptions {
            large_file_bytes: 1024,
            ..CheckpointOptions::default()
        },
    );
    fx.write_bytes("big.dat", &vec![7u8; 4096]);
    let cp = created(
        store
            .create(&fx.git, &fx.ws, &new_id(), None, None)
            .expect("create"),
    );
    assert_eq!(cp.skipped_large, 1);

    fx.write_bytes("crlf.txt", b"garbage");
    fx.write_bytes("big.dat", &vec![9u8; 8192]);
    let plan = store
        .plan_restore(&fx.git, &fx.ws, &cp.commit_oid, None, true)
        .expect("plan");
    assert!(
        plan.changes.iter().all(|c| c.path != "big.dat"),
        "oversized files are never restored"
    );
    store
        .execute_restore(
            &fx.git,
            &fx.ws,
            &plan,
            RestoreConfirmation::confirmed_natively(&plan),
            &new_id(),
            None,
        )
        .expect("restore");
    assert_eq!(
        fx.read("crlf.txt"),
        b"one\r\ntwo\nthree\r\n",
        "exact bytes, no line-ending conversion"
    );
    assert_eq!(fx.read("big.dat"), vec![9u8; 8192], "large file untouched");

    // A file that was small at checkpoint time but is large now is kept, not overwritten.
    fx.write_bytes("grows.dat", b"small");
    let cp2 = created(
        store
            .create(&fx.git, &fx.ws, &new_id(), None, None)
            .expect("create"),
    );
    fx.write_bytes("grows.dat", &vec![1u8; 4096]);
    let plan = store
        .plan_restore(&fx.git, &fx.ws, &cp2.commit_oid, None, false)
        .expect("plan");
    let grows = plan
        .changes
        .iter()
        .find(|c| c.path == "grows.dat")
        .expect("grows");
    assert_eq!(grows.change, PlannedChange::KeepExisting);
    store
        .execute_restore(
            &fx.git,
            &fx.ws,
            &plan,
            RestoreConfirmation::confirmed_natively(&plan),
            &new_id(),
            None,
        )
        .expect("restore");
    assert_eq!(fx.read("grows.dat").len(), 4096);
}

#[test]
fn partial_restore_of_selected_paths() {
    let fx = Fixture::repo();
    fx.write("a.txt", "a");
    fx.write("b.txt", "b");
    let store = store(&fx);
    let cp = created(
        store
            .create(&fx.git, &fx.ws, &new_id(), None, None)
            .expect("create"),
    );
    fx.write("a.txt", "A");
    fx.write("b.txt", "B");
    let only = [RelPath::parse("a.txt").expect("rel")];
    let plan = store
        .plan_restore(&fx.git, &fx.ws, &cp.commit_oid, Some(&only), false)
        .expect("plan");
    assert_eq!(plan.changes.len(), 1);
    store
        .execute_restore(
            &fx.git,
            &fx.ws,
            &plan,
            RestoreConfirmation::confirmed_natively(&plan),
            &new_id(),
            None,
        )
        .expect("restore");
    assert_eq!(fx.read("a.txt"), b"a");
    assert_eq!(fx.read("b.txt"), b"B");
}

#[test]
fn checkpoint_diff_against_now_and_between_checkpoints() {
    let fx = Fixture::repo();
    fx.write("x.txt", "1\n2\n");
    let store = store(&fx);
    let handles = HandleRegistry::default();
    let first = created(
        store
            .create(&fx.git, &fx.ws, &new_id(), None, None)
            .expect("create"),
    );
    fx.write("x.txt", "1\ntwo\n");
    let now = store
        .diff(
            &fx.git,
            &fx.ws,
            &first.commit_oid,
            None,
            &DiffOptions::default(),
            &handles,
        )
        .expect("diff");
    assert_eq!(now.files.len(), 1);
    assert_eq!(now.files[0].meta.path, "x.txt");
    assert!(
        now.files[0].meta.file.is_some(),
        "diff entries carry handles"
    );
    let second = created(
        store
            .create(&fx.git, &fx.ws, &new_id(), None, None)
            .expect("create"),
    );
    let between = store
        .diff(
            &fx.git,
            &fx.ws,
            &first.commit_oid,
            Some(&second.commit_oid),
            &DiffOptions::default(),
            &handles,
        )
        .expect("diff");
    assert_eq!(
        (
            between.files[0].meta.additions,
            between.files[0].meta.deletions
        ),
        (1, 1)
    );
}

#[test]
fn export_branch_is_additive_and_leaves_the_working_tree_alone() {
    let fx = Fixture::repo();
    fx.write("feature.txt", "work in progress\n");
    let repo = Repo::discover(&fx.git, &fx.ws)
        .expect("discover")
        .expect("repo");
    let store = store(&fx);
    let id = new_id();
    let cp = created(
        store
            .create(&fx.git, &fx.ws, &id, Some(&repo), None)
            .expect("create"),
    );
    fx.write("feature.txt", "later edits\n");
    let head_before = fx.git_plain(&["rev-parse", "HEAD"]);
    let index_before = std::fs::read(fx.path(".git/index")).expect("index");

    let oid = store
        .export_branch(
            &fx.git,
            &fx.ws,
            &repo,
            &id,
            &cp.commit_oid,
            "kalcode/from-checkpoint",
        )
        .expect("export");
    assert_eq!(
        fx.git_plain(&["rev-parse", "kalcode/from-checkpoint"])
            .trim(),
        oid
    );
    assert_eq!(
        fx.git_plain(&["rev-parse", "HEAD"]),
        head_before,
        "HEAD unchanged"
    );
    assert_eq!(
        std::fs::read(fx.path(".git/index")).expect("index"),
        index_before
    );
    assert_eq!(
        fx.read("feature.txt"),
        b"later edits\n",
        "working tree unchanged"
    );
    let parent = fx.git_plain(&["rev-parse", "kalcode/from-checkpoint^"]);
    assert_eq!(
        parent, head_before,
        "the branch builds on the user's HEAD at checkpoint time"
    );
    let content = fx.git_plain(&["show", "kalcode/from-checkpoint:feature.txt"]);
    assert_eq!(content, "work in progress\n");

    let again = store.export_branch(
        &fx.git,
        &fx.ws,
        &repo,
        &id,
        &cp.commit_oid,
        "kalcode/from-checkpoint",
    );
    assert_eq!(again.expect_err("exists").code, "already_exists");
    assert!(
        store
            .export_branch(&fx.git, &fx.ws, &repo, &id, &cp.commit_oid, "--force")
            .is_err()
    );
}

#[test]
fn export_from_a_subfolder_workspace_grafts_the_subtree() {
    let fx = Fixture::repo();
    fx.write("app/main.txt", "v1\n");
    fx.write("docs/readme.txt", "docs\n");
    fx.commit_all("layout");
    let sub = WorkspaceRoot::new(&new_id(), &fx.path("app")).expect("ws");
    let repo = Repo::discover(&fx.git, &sub)
        .expect("discover")
        .expect("repo");
    let store = store(&fx);
    let id = new_id();
    fx.write("app/main.txt", "v2\n");
    let cp = created(
        store
            .create(&fx.git, &sub, &id, Some(&repo), None)
            .expect("create"),
    );
    store
        .export_branch(&fx.git, &sub, &repo, &id, &cp.commit_oid, "from-sub")
        .expect("export");
    assert_eq!(fx.git_plain(&["show", "from-sub:app/main.txt"]), "v2\n");
    assert_eq!(
        fx.git_plain(&["show", "from-sub:docs/readme.txt"]),
        "docs\n"
    );
}

#[test]
fn pruning_deletes_refs_and_reclaims_space() {
    let fx = Fixture::plain_folder();
    let store = CheckpointStore::new(
        fx.data.join("checkpoints"),
        CheckpointOptions {
            quota_bytes: 0,
            ..CheckpointOptions::default()
        },
    );
    let mut ids = Vec::new();
    for i in 0..3 {
        fx.write_bytes("data.bin", &vec![i as u8; 200_000]);
        let id = new_id();
        created(
            store
                .create(&fx.git, &fx.ws, &id, None, None)
                .expect("create"),
        );
        ids.push(id);
    }
    let before = store.usage_bytes(fx.ws.id()).expect("usage");
    assert!(before > 0);
    let pruned = store
        .prune_to_quota(&fx.git, fx.ws.id(), &ids[..2])
        .expect("prune");
    assert_eq!(pruned, ids[..2].to_vec());
    assert!(store.usage_bytes(fx.ws.id()).expect("usage") < before);
    store.remove_store(fx.ws.id()).expect("remove");
    assert_eq!(store.usage_bytes(fx.ws.id()).expect("usage"), 0);
}

#[test]
fn checkpoints_keep_working_after_pruning_reclaims_every_checkpoint() {
    let fx = Fixture::plain_folder();
    let store = CheckpointStore::new(
        fx.data.join("checkpoints"),
        CheckpointOptions {
            quota_bytes: 0,
            ..CheckpointOptions::default()
        },
    );
    fx.write("a.txt", "unchanged across the prune\n");
    // Old enough that the stat manifest trusts it (not "racy").
    std::fs::File::options()
        .write(true)
        .open(fx.path("a.txt"))
        .expect("open")
        .set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(3600))
        .expect("age the file");
    let first = new_id();
    created(
        store
            .create(&fx.git, &fx.ws, &first, None, None)
            .expect("create"),
    );
    // The workspace is over quota on its own, so every unpinned checkpoint goes.
    let pruned = store
        .prune_to_quota(&fx.git, fx.ws.id(), std::slice::from_ref(&first))
        .expect("prune");
    assert_eq!(pruned, vec![first]);

    fx.write("b.txt", "new after the prune\n");
    store
        .create(&fx.git, &fx.ws, &new_id(), None, None)
        .expect("a checkpoint after pruning still snapshots unchanged files");
}

/// Creates a directory link: a junction on Windows (no privilege needed), a symlink elsewhere.
fn dir_link(link: &std::path::Path, target: &std::path::Path) -> bool {
    #[cfg(windows)]
    {
        let mut command = std::process::Command::new("cmd");
        common::hide_test_process(&mut command);
        command
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .is_ok_and(|o| o.status.success())
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).is_ok()
    }
}

#[test]
fn snapshots_never_follow_links_out_of_the_workspace() {
    let fx = Fixture::plain_folder();
    let outside = fx.temp.path().join("outside");
    std::fs::create_dir_all(&outside).expect("mkdir");
    std::fs::write(outside.join("secret.txt"), "secret").expect("write");
    fx.write("inside.txt", "ok");
    assert!(dir_link(&fx.path("link"), &outside));
    let store = store(&fx);
    let cp = created(
        store
            .create(&fx.git, &fx.ws, &new_id(), None, None)
            .expect("create"),
    );
    let shadow = fx
        .data
        .join("checkpoints")
        .join(format!("{}.git", fx.ws.id()));
    let listed = common::run_plain(
        fx.temp.path(),
        &[
            "--git-dir",
            &shadow.to_string_lossy(),
            "ls-tree",
            "-r",
            "--name-only",
            &cp.commit_oid,
        ],
    );
    assert!(!listed.contains("secret"), "{listed}");
    assert!(listed.contains("inside.txt"));
    // Restoring never writes through the link either.
    std::fs::remove_file(fx.path("inside.txt")).expect("rm");
    let plan = store
        .plan_restore(&fx.git, &fx.ws, &cp.commit_oid, None, true)
        .expect("plan");
    assert!(
        plan.changes.iter().all(|c| !c.path.starts_with("link")),
        "{plan:?}"
    );
    store
        .execute_restore(
            &fx.git,
            &fx.ws,
            &plan,
            RestoreConfirmation::confirmed_natively(&plan),
            &new_id(),
            None,
        )
        .expect("restore");
    assert_eq!(
        std::fs::read(outside.join("secret.txt")).expect("read"),
        b"secret"
    );
    assert!(fx.exists("inside.txt"));
}
