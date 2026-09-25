//! A repository whose own configuration tries to run code: fsmonitor, hooks (default folder and
//! a configured `core.hooksPath`), clean/smudge filters (directly and through an included file),
//! an external diff tool, a text-conversion driver, an ssh command, a pager and a signing
//! program. Every KalCode operation runs against it; no marker file may appear.
//!
//! Control tests run the same operations with plain `git` and show the markers *do* appear, so
//! the absence of markers is evidence, not an accident of the platform.

// Test helpers outside `#[test]` functions panic on setup failures by design.
#![allow(clippy::expect_used)]

mod common;

use std::path::PathBuf;

use common::{Fixture, install_hook, run_plain, try_plain};
use kalcode_contracts::ids::new_id;
use kalcode_git::checkpoint::{
    CheckpointOptions, CheckpointStore, CreateOutcome, RestoreConfirmation,
};
use kalcode_git::diff::{DiffOptions, DiffTarget};
use kalcode_git::handles::HandleRegistry;
use kalcode_git::repo::Repo;
use kalcode_git::worktree::{self, RemoveMode, WorktreeStart};

const HOOKS: &[&str] = &[
    "pre-commit",
    "post-commit",
    "post-checkout",
    "post-index-change",
    "reference-transaction",
    "pre-auto-gc",
    "post-rewrite",
    "fsmonitor-watchman",
];

struct Hostile {
    fx: Fixture,
    markers: Vec<(String, PathBuf)>,
}

impl Hostile {
    fn new() -> Self {
        let fx = Fixture::repo();
        let mut markers = Vec::new();
        let mut marker = |name: &str| {
            let (path, text) = fx.marker(name);
            markers.push((name.to_owned(), path));
            text
        };

        // Content that makes filters, text conversion and external diffs apply.
        fx.write(
            ".gitattributes",
            "*.txt filter=evil diff=evil\n*.inc filter=included\n",
        );
        fx.write("a.txt", "one\n");
        fx.write("b.inc", "inc\n");
        fx.commit_all("content");

        // Hooks in the default folder...
        for hook in HOOKS {
            install_hook(
                &fx.path(".git/hooks"),
                hook,
                &marker(&format!("hook-{hook}")),
            );
        }
        // ...and in a configured hooks folder.
        let custom = fx.temp.path().join("custom-hooks");
        for hook in HOOKS {
            install_hook(&custom, hook, &marker(&format!("custom-{hook}")));
        }
        let cmd = |m: &str| format!("echo ran > \"{m}\" #");
        let settings: Vec<(String, String)> = vec![
            (
                "core.hooksPath".into(),
                custom.to_string_lossy().replace('\\', "/"),
            ),
            ("core.fsmonitor".into(), cmd(&marker("fsmonitor"))),
            ("filter.evil.clean".into(), cmd(&marker("filter-clean"))),
            ("filter.evil.smudge".into(), cmd(&marker("filter-smudge"))),
            ("filter.evil.required".into(), "true".into()),
            ("diff.external".into(), cmd(&marker("diff-external"))),
            ("diff.evil.textconv".into(), cmd(&marker("textconv"))),
            ("diff.evil.command".into(), cmd(&marker("diff-command"))),
            ("core.sshCommand".into(), cmd(&marker("ssh"))),
            ("core.pager".into(), cmd(&marker("pager"))),
            ("pager.log".into(), cmd(&marker("pager-log"))),
            ("core.editor".into(), cmd(&marker("editor"))),
            (
                "credential.helper".into(),
                format!("!{}", cmd(&marker("credential"))),
            ),
            ("gpg.program".into(), marker("gpg")),
            ("commit.gpgSign".into(), "true".into()),
            ("log.showSignature".into(), "true".into()),
            ("gc.auto".into(), "1".into()),
            (
                "remote.origin.url".into(),
                "ssh://example.invalid/repo.git".into(),
            ),
        ];
        for (key, value) in &settings {
            run_plain(&fx.root, &["config", key, value]);
        }
        // A filter defined in an included file (still repository configuration).
        let included = fx.temp.path().join("included.config");
        std::fs::write(
            &included,
            format!(
                "[filter \"included\"]\n\tclean = {}\n\tsmudge = {}\n",
                cmd(&marker("included-clean")),
                cmd(&marker("included-smudge"))
            ),
        )
        .expect("include");
        run_plain(
            &fx.root,
            &[
                "config",
                "include.path",
                &included.to_string_lossy().replace('\\', "/"),
            ],
        );

        // Make the index stat-dirty so status must re-read (and would filter) the files.
        fx.write("a.txt", "two\n");
        fx.write("b.inc", "inc2\n");
        Self { fx, markers }
    }

    fn fired(&self) -> Vec<String> {
        self.markers
            .iter()
            .filter(|(_, path)| path.exists())
            .map(|(name, _)| name.clone())
            .collect()
    }

    fn clear(&self) {
        for (_, path) in &self.markers {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[test]
fn kalcode_operations_never_run_repository_code() {
    let h = Hostile::new();
    let fx = &h.fx;
    h.clear();
    let handles = HandleRegistry::default();
    let repo = Repo::discover(&fx.git, &fx.ws)
        .expect("discover")
        .expect("repo");
    assert!(
        !repo.overrides().is_empty(),
        "repository filters are neutralized"
    );

    let st = kalcode_git::status::status(&fx.git, &repo).expect("status");
    assert!(st.entries.iter().any(|e| e.path == "a.txt"));
    for target in [
        DiffTarget::WorkingTree,
        DiffTarget::Head,
        DiffTarget::Staged,
        DiffTarget::Commits {
            from: "HEAD~1".into(),
            to: "HEAD".into(),
        },
    ] {
        kalcode_git::diff::diff(
            &fx.git,
            &repo,
            &target,
            &[],
            &DiffOptions::default(),
            &handles,
        )
        .expect("diff");
    }
    kalcode_git::log::log(&fx.git, &repo, None, 50, None).expect("log");
    kalcode_git::log::branches(&fx.git, &repo).expect("branches");

    // Worktrees: add (checkout → post-checkout, smudge, reference-transaction), list, remove.
    let wt_path = fx.data.join("worktrees").join("hostile");
    worktree::add(
        &fx.git,
        &repo,
        &wt_path,
        &WorktreeStart::NewBranch {
            name: "kal/hostile".into(),
            start: None,
        },
    )
    .expect("worktree add");
    assert_eq!(worktree::list(&fx.git, &repo).expect("list").len(), 2);
    worktree::remove(&fx.git, &repo, &wt_path, RemoveMode::Safe).expect("remove");

    // Checkpoints: create, plan, restore, branch export (fetch + commit-tree + update-ref).
    let store = CheckpointStore::new(fx.data.join("checkpoints"), CheckpointOptions::default());
    let id = new_id();
    let CreateOutcome::Created(cp) = store
        .create(&fx.git, &fx.ws, &id, Some(&repo), None)
        .expect("checkpoint")
    else {
        panic!("created");
    };
    fx.write("a.txt", "three\n");
    let plan = store
        .plan_restore(&fx.git, &fx.ws, &cp.commit_oid, None, false)
        .expect("plan");
    store
        .execute_restore(
            &fx.git,
            &fx.ws,
            &plan,
            RestoreConfirmation::confirmed_natively(&plan),
            &new_id(),
            Some(&repo),
        )
        .expect("restore");
    store
        .export_branch(&fx.git, &fx.ws, &repo, &id, &cp.commit_oid, "kal/export")
        .expect("export");
    store.collect_garbage(&fx.git, fx.ws.id()).expect("gc");

    assert_eq!(
        h.fired(),
        Vec::<String>::new(),
        "repository code ran during KalCode operations"
    );
}

#[test]
fn control_plain_git_does_run_the_same_repository_code() {
    let h = Hostile::new();
    let fx = &h.fx;
    h.clear();
    // Plain git, as a user or a tool without KalCode's hardening would run it.
    let _ = try_plain(&fx.root, &["status"]);
    let _ = try_plain(&fx.root, &["diff"]);
    let _ = try_plain(&fx.root, &["branch", "control-branch"]);
    let wt = fx.temp.path().join("control-wt");
    let _ = try_plain(
        &fx.root,
        &["worktree", "add", &wt.to_string_lossy(), "HEAD"],
    );
    let fired = h.fired();
    eprintln!("control (plain git) fired: {fired:?}");
    for expected in [
        "fsmonitor",
        "filter-clean",
        "diff-external",
        "custom-reference-transaction",
        "custom-post-checkout",
    ] {
        assert!(
            fired.iter().any(|f| f == expected),
            "control: {expected} should run under plain git on this platform; fired: {fired:?}"
        );
    }
}

#[test]
fn repository_filter_names_that_cannot_be_neutralized_are_refused() {
    let fx = Fixture::repo();
    run_plain(&fx.root, &["config", "filter.a=b.clean", "echo x"]);
    let err = Repo::discover(&fx.git, &fx.ws).expect_err("unsafe");
    assert_eq!(err.code, "repository_config_unsafe");
}
