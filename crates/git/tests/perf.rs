//! Large-repository timings against ADVANCED.md §10 (TM checkpoint: ≤ 1 s for a 10k-file
//! repository with no changes, ≤ 5 s for 1k changed files).
//!
//! The full measurement is ignored by default (it writes 20,000 files):
//! `cargo test -p kalcode-git --release --test perf -- --ignored --nocapture`
//! (`KALCODE_PERF_FILES` overrides the file count). A small always-on variant guards against
//! gross regressions with loose bounds.

// Test helpers outside `#[test]` functions panic on setup failures by design.
#![allow(clippy::expect_used)]

mod common;

use std::time::{Duration, Instant};

use common::Fixture;
use kalcode_contracts::ids::new_id;
use kalcode_git::RelPath;
use kalcode_git::checkpoint::{CheckpointOptions, CheckpointStore, CreateOutcome};
use kalcode_git::diff::{DiffOptions, DiffTarget};
use kalcode_git::handles::HandleRegistry;
use kalcode_git::index::FileIndex;
use kalcode_git::repo::Repo;
use kalcode_git::types::PageRequest;

struct Timings(Vec<(String, Duration)>);

impl Timings {
    fn time<T>(&mut self, name: &str, f: impl FnOnce() -> T) -> T {
        let start = Instant::now();
        let value = f();
        self.0.push((name.to_owned(), start.elapsed()));
        value
    }

    fn get(&self, name: &str) -> Duration {
        self.0
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, d)| *d)
            .unwrap_or_default()
    }

    fn print(&self, files: usize) {
        eprintln!("\n| Operation ({files} files) | ms |\n| --- | ---: |");
        for (name, d) in &self.0 {
            eprintln!("| {name} | {} |", d.as_millis());
        }
    }
}

fn populate(fx: &Fixture, files: usize) {
    for i in 0..files {
        fx.write(
            &format!("pkg{:03}/mod{:02}/file{i:05}.txt", i / 1000, (i / 100) % 10),
            &format!("line {i}\nsecond line\n"),
        );
    }
    fx.commit_all("bulk");
}

fn measure(files: usize) -> Timings {
    let fx = Fixture::repo();
    populate(&fx, files);
    let mut t = Timings(Vec::new());
    let handles = HandleRegistry::default();

    let index = t.time("file index: initial build", || {
        FileIndex::build(fx.ws.clone()).expect("index")
    });
    assert!(index.len() >= files);
    t.time("file index: list root folder", || {
        index
            .list_dir(
                None,
                &PageRequest {
                    limit: 500,
                    cursor: None,
                },
                &handles,
            )
            .expect("list")
    });
    fx.write("pkg000/mod00/extra.txt", "x");
    t.time("file index: incremental update (1 file)", || {
        index
            .apply_changes(&[RelPath::parse("pkg000/mod00/extra.txt").expect("rel")])
            .expect("apply")
    });
    t.time("file index: find (substring)", || {
        index.find("file0123", 50)
    });

    let repo = t.time("git: discover repository", || {
        Repo::discover(&fx.git, &fx.ws)
            .expect("discover")
            .expect("repo")
    });
    t.time("git: status (clean tree, warm)", || {
        kalcode_git::status::status(&fx.git, &repo).expect("status")
    });
    for i in 0..100 {
        fx.write(&format!("pkg000/mod00/file{i:05}.txt"), "changed\n");
    }
    let st = t.time("git: status (100 modified)", || {
        kalcode_git::status::status(&fx.git, &repo).expect("status")
    });
    assert!(st.entries.len() >= 100);
    t.time("git: diff HEAD with hunks (100 modified)", || {
        kalcode_git::diff::diff(
            &fx.git,
            &repo,
            &DiffTarget::Head,
            &[],
            &DiffOptions::default(),
            &handles,
        )
        .expect("diff")
    });
    t.time("git: log first page (50)", || {
        kalcode_git::log::log(&fx.git, &repo, None, 50, None).expect("log")
    });

    let store = CheckpointStore::new(fx.data.join("checkpoints"), CheckpointOptions::default());
    let first = t.time("checkpoint: first (cold shadow repository)", || {
        store
            .create(&fx.git, &fx.ws, &new_id(), Some(&repo), None)
            .expect("checkpoint")
    });
    let CreateOutcome::Created(first) = first else {
        panic!("created")
    };
    t.time("checkpoint: no content changes", || {
        store
            .create(&fx.git, &fx.ws, &new_id(), Some(&repo), None)
            .expect("checkpoint")
    });
    t.time("checkpoint: no changes, skip-if-unchanged", || {
        store
            .create(
                &fx.git,
                &fx.ws,
                &new_id(),
                Some(&repo),
                Some(&first.commit_oid),
            )
            .expect("checkpoint")
    });
    let changed = files.min(1000);
    for i in 0..changed {
        fx.write(
            &format!("pkg{:03}/mod{:02}/file{i:05}.txt", i / 1000, (i / 100) % 10),
            &format!("changed {i}\n"),
        );
    }
    t.time(&format!("checkpoint: {changed} changed files"), || {
        store
            .create(&fx.git, &fx.ws, &new_id(), Some(&repo), None)
            .expect("checkpoint")
    });
    t.time("checkpoint: restore plan", || {
        store
            .plan_restore(&fx.git, &fx.ws, &first.commit_oid, None, false)
            .expect("plan")
    });
    t
}

#[test]
#[ignore = "writes 20,000 files; run with --ignored --nocapture for the timing table"]
fn large_repository_timings() {
    let files = std::env::var("KALCODE_PERF_FILES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(20_000);
    let t = measure(files);
    t.print(files);
    // §10 budgets (they are stated for 10k files; this runs 20k by default).
    assert!(
        t.get("checkpoint: no content changes") <= Duration::from_secs(2),
        "no-change checkpoint budget"
    );
    assert!(
        t.get("checkpoint: 1000 changed files") <= Duration::from_secs(5),
        "1k-changed checkpoint budget"
    );
}

#[test]
fn small_repository_stays_fast() {
    let t = measure(1_000);
    assert!(t.get("checkpoint: no content changes") <= Duration::from_secs(10));
    assert!(t.get("file index: initial build") <= Duration::from_secs(10));
}
