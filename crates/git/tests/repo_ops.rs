//! Status, diff, log and branches against real temporary repositories.

// Test helpers outside `#[test]` functions panic on setup failures by design.
#![allow(clippy::expect_used)]

mod common;

use common::{Fixture, run_plain};
use kalcode_git::diff::{DiffOptions, DiffTarget, LineKind};
use kalcode_git::handles::HandleRegistry;
use kalcode_git::repo::Repo;
use kalcode_git::status::{ConflictKind, status};
use kalcode_git::types::GitFileChange;
use kalcode_git::{RelPath, WorkspaceRoot};

#[test]
fn plain_folder_is_not_a_repository() {
    let fx = Fixture::plain_folder();
    assert!(Repo::discover(&fx.git, &fx.ws).expect("discover").is_none());
}

#[test]
fn status_reports_staged_unstaged_renames_untracked_and_conflicts() {
    let fx = Fixture::repo();
    fx.write("keep.txt", "one\ntwo\nthree\n");
    fx.write(
        "move-me.txt",
        "a fairly long line so rename detection has content to match\n",
    );
    fx.commit_all("files");

    fx.write("keep.txt", "one\nTWO\nthree\n"); // unstaged modification
    fx.write("staged.txt", "new\n");
    fx.git_plain(&["add", "staged.txt"]);
    fx.git_plain(&["mv", "move-me.txt", "moved.txt"]);
    fx.write("dir with space/untracked.txt", "u\n");

    let repo = Repo::discover(&fx.git, &fx.ws)
        .expect("discover")
        .expect("repo");
    let st = status(&fx.git, &repo).expect("status");
    assert_eq!(st.branch.branch.as_deref(), Some("main"));
    let find = |p: &str| {
        st.entries
            .iter()
            .find(|e| e.path == p)
            .unwrap_or_else(|| panic!("{p} in {st:?}"))
    };
    assert_eq!(find("keep.txt").unstaged, Some(GitFileChange::Modified));
    assert_eq!(find("staged.txt").staged, Some(GitFileChange::Added));
    let moved = find("moved.txt");
    assert_eq!(moved.staged, Some(GitFileChange::Renamed));
    assert_eq!(moved.orig_path.as_deref(), Some("move-me.txt"));
    assert!(find("dir with space/untracked.txt").untracked);
    let summary = st.summary(fx.ws.id());
    assert_eq!((summary.changed, summary.untracked), (3, 1));

    // A merge conflict.
    fx.commit_all("more");
    fx.git_plain(&["checkout", "-q", "-b", "other"]);
    fx.write("keep.txt", "other side\n");
    fx.commit_all("other");
    fx.git_plain(&["checkout", "-q", "main"]);
    fx.write("keep.txt", "main side\n");
    fx.commit_all("main");
    assert!(!common::try_plain(
        &fx.root,
        &["merge", "-q", "--no-edit", "other"]
    ));
    let st = status(&fx.git, &repo).expect("status");
    let conflict = st
        .entries
        .iter()
        .find(|e| e.path == "keep.txt")
        .expect("conflict");
    assert_eq!(conflict.conflict, Some(ConflictKind::BothModified));
}

#[test]
fn status_view_issues_handles_and_leaves_the_users_index_alone() {
    let fx = Fixture::repo();
    fx.write("a.txt", "x\n");
    let index_before = std::fs::read(fx.path(".git/index")).expect("index");
    let repo = Repo::discover(&fx.git, &fx.ws)
        .expect("discover")
        .expect("repo");
    let handles = HandleRegistry::default();
    let view = status(&fx.git, &repo)
        .expect("status")
        .view(&repo, &handles);
    let file = view.files[0].file.clone().expect("handle");
    assert_eq!(file.display_path, "a.txt");
    let resolved = handles.resolve(&fx.ws, &file.handle).expect("resolve");
    assert!(resolved.location.exists);
    assert_eq!(
        std::fs::read(fx.path(".git/index")).expect("index"),
        index_before
    );
    assert!(!fx.exists(".git/index.lock"));
}

#[test]
fn diffs_have_numstat_hunks_and_line_numbers() {
    let fx = Fixture::repo();
    fx.write("f.txt", "1\n2\n3\n4\n5\n");
    fx.write_bytes("bin.dat", &[0, 1, 2, 3, 0, 255]);
    fx.commit_all("base");
    fx.write("f.txt", "1\n2\nthree\n4\n5\n6\n");
    fx.write_bytes("bin.dat", &[0, 9, 9, 9, 0, 255]);
    fx.write("new.txt", "brand new\n");
    fx.git_plain(&["add", "new.txt"]);

    let repo = Repo::discover(&fx.git, &fx.ws)
        .expect("discover")
        .expect("repo");
    let handles = HandleRegistry::default();
    let opts = DiffOptions::default();

    let unstaged = kalcode_git::diff::diff(
        &fx.git,
        &repo,
        &DiffTarget::WorkingTree,
        &[],
        &opts,
        &handles,
    )
    .expect("diff");
    let f = unstaged
        .files
        .iter()
        .find(|f| f.meta.path == "f.txt")
        .expect("f.txt");
    assert_eq!((f.meta.additions, f.meta.deletions), (2, 1));
    let hunk = &f.hunks[0];
    let deleted = hunk
        .lines
        .iter()
        .find(|l| l.kind == LineKind::Delete)
        .expect("delete");
    assert_eq!((deleted.old_line, deleted.text.as_str()), (Some(3), "3"));
    let added = hunk
        .lines
        .iter()
        .find(|l| l.kind == LineKind::Add)
        .expect("add");
    assert_eq!((added.new_line, added.text.as_str()), (Some(3), "three"));
    let bin = unstaged
        .files
        .iter()
        .find(|f| f.meta.path == "bin.dat")
        .expect("bin");
    assert!(bin.meta.binary && bin.hunks.is_empty());
    assert!(
        unstaged.files.iter().all(|f| f.meta.path != "new.txt"),
        "staged file isn't unstaged"
    );

    let staged = kalcode_git::diff::diff(&fx.git, &repo, &DiffTarget::Staged, &[], &opts, &handles)
        .expect("diff");
    assert_eq!(staged.files.len(), 1);
    assert_eq!(staged.files[0].meta.change, GitFileChange::Added);

    let head = kalcode_git::diff::diff(&fx.git, &repo, &DiffTarget::Head, &[], &opts, &handles)
        .expect("diff");
    assert_eq!(head.files.len(), 3);

    // Limited to one file through its handle.
    let only = handles
        .issue(&fx.ws, &RelPath::parse("f.txt").expect("rel"))
        .expect("issue");
    let files =
        kalcode_git::diff::files_from_handles(&handles, fx.ws.id(), &[only.handle]).expect("files");
    let one = kalcode_git::diff::diff(&fx.git, &repo, &DiffTarget::Head, &files, &opts, &handles)
        .expect("diff");
    assert_eq!(one.files.len(), 1);

    // Commit range, and the byte cap marks truncation.
    fx.commit_all("next");
    let range = kalcode_git::diff::diff(
        &fx.git,
        &repo,
        &DiffTarget::Commits {
            from: "HEAD~1".into(),
            to: "HEAD".into(),
        },
        &[],
        &DiffOptions {
            max_patch_bytes: 64,
            ..DiffOptions::default()
        },
        &handles,
    )
    .expect("diff");
    assert_eq!(range.files.len(), 3);
    assert!(range.truncated);

    // Revisions that look like options never reach git.
    let bad = kalcode_git::diff::diff(
        &fx.git,
        &repo,
        &DiffTarget::Base {
            base: "--output=pwned.txt".into(),
        },
        &[],
        &opts,
        &handles,
    );
    assert!(bad.is_err());
    assert!(!fx.exists("pwned.txt"));
}

#[test]
fn log_pages_are_stable_and_branches_track_upstreams() {
    let fx = Fixture::repo();
    for i in 0..7 {
        fx.write("n.txt", &format!("{i}\n"));
        fx.commit_all(&format!("commit {i}"));
    }
    let repo = Repo::discover(&fx.git, &fx.ws)
        .expect("discover")
        .expect("repo");
    let first = kalcode_git::log::log(&fx.git, &repo, None, 3, None).expect("log");
    assert_eq!(first.items.len(), 3);
    assert_eq!(first.items[0].subject, "commit 6");
    // A new commit must not shift the next page.
    fx.write("n.txt", "late\n");
    fx.commit_all("late");
    let second =
        kalcode_git::log::log(&fx.git, &repo, None, 3, first.next_cursor.as_deref()).expect("log");
    assert_eq!(second.items[0].subject, "commit 3");
    let mut cursor = second.next_cursor.clone();
    let mut total = 6;
    while let Some(c) = cursor {
        let page = kalcode_git::log::log(&fx.git, &repo, None, 3, Some(&c)).expect("log");
        total += page.items.len();
        cursor = page.next_cursor;
    }
    assert_eq!(total, 8, "7 commits + initial");

    // Branches: a local branch with an upstream in a clone.
    let clone_dir = fx.temp.path().join("clone");
    run_plain(
        fx.temp.path(),
        &[
            "clone",
            "-q",
            &fx.root.to_string_lossy(),
            &clone_dir.to_string_lossy(),
        ],
    );
    common::init_repo(&clone_dir);
    std::fs::write(clone_dir.join("c.txt"), "c").expect("write");
    run_plain(&clone_dir, &["add", "-A"]);
    run_plain(&clone_dir, &["commit", "-q", "-m", "ahead"]);
    let clone_ws = WorkspaceRoot::new(&kalcode_contracts::ids::new_id(), &clone_dir).expect("ws");
    let clone_repo = Repo::discover(&fx.git, &clone_ws)
        .expect("discover")
        .expect("repo");
    let branches = kalcode_git::log::branches(&fx.git, &clone_repo).expect("branches");
    let main = branches.iter().find(|b| b.name == "main").expect("main");
    assert!(main.current);
    assert_eq!(main.upstream.as_deref(), Some("origin/main"));
    assert_eq!((main.ahead, main.behind), (Some(1), Some(0)));
    assert!(branches.iter().any(|b| b.name == "origin/main"));
}

#[test]
fn empty_repository_has_empty_history() {
    let fx = Fixture::plain_folder();
    common::init_repo(&fx.root);
    let repo = Repo::discover(&fx.git, &fx.ws)
        .expect("discover")
        .expect("repo");
    let page = kalcode_git::log::log(&fx.git, &repo, None, 10, None).expect("log");
    assert!(page.items.is_empty());
    let st = status(&fx.git, &repo).expect("status");
    assert_eq!(st.branch.head_oid, None);
}

#[test]
fn workspace_in_a_subfolder_sees_only_its_files() {
    let fx = Fixture::repo();
    fx.write("app/src/main.rs", "fn main() {}\n");
    fx.write("other/x.txt", "x\n");
    fx.commit_all("layout");
    fx.write("app/src/main.rs", "fn main() { println!(); }\n");
    fx.write("other/x.txt", "changed\n");
    let sub = WorkspaceRoot::new(&kalcode_contracts::ids::new_id(), &fx.path("app")).expect("ws");
    let repo = Repo::discover(&fx.git, &sub)
        .expect("discover")
        .expect("repo");
    assert_eq!(repo.prefix(), "app");
    let handles = HandleRegistry::default();
    let view = status(&fx.git, &repo)
        .expect("status")
        .view(&repo, &handles);
    assert_eq!(view.files.len(), 1);
    assert_eq!(view.files[0].path, "src/main.rs");
    let diff = kalcode_git::diff::diff(
        &fx.git,
        &repo,
        &DiffTarget::WorkingTree,
        &[],
        &DiffOptions::default(),
        &handles,
    )
    .expect("diff");
    assert_eq!(diff.files.len(), 1);
    assert_eq!(diff.files[0].meta.path, "src/main.rs");
}

#[test]
fn hostile_core_worktree_outside_the_workspace_is_refused() {
    let fx = Fixture::repo();
    let elsewhere = fx.temp.path().join("elsewhere");
    std::fs::create_dir_all(&elsewhere).expect("mkdir");
    fx.git_plain(&["config", "core.worktree", &elsewhere.to_string_lossy()]);
    let err = Repo::discover(&fx.git, &fx.ws).expect_err("refused");
    assert_eq!(err.code, "repository_outside_workspace");
}
