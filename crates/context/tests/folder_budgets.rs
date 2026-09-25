//! Folder analysis on a large synthetic tree: budgets, ignore files, never-share directories,
//! links, binaries, relevance ordering, pruning — and performance against ADVANCED.md §10
//! (CTX/FW: ≤ 50 ms per MiB scanned; default package cap 2 MiB).
//!
//! The strict timing checks are `#[ignore]`d and meant for release builds:
//! `cargo test --release -p kalcode-context --test folder_budgets -- --ignored --nocapture`.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod common;

use std::sync::OnceLock;
use std::time::Instant;

use common::{Ws, body, token};
use kalcode_context::folder::{ExclusionReason, FolderBudget, analyze_folder};
use kalcode_context::package::{ContextItem, ContextPackage, PackageOptions};
use kalcode_context::provider::TextOnlyDefaults;
use kalcode_context::redact::{PlaceholderStyle, redact_text};
use kalcode_context::secrets::ScanContext;
use kalcode_context::{
    ContextPurpose, DefaultRelevance, Firewall, FirewallVerdict, RelevanceScorer,
};

const DIRS: usize = 100;
const FILES_PER_DIR: usize = 100;
const IGNORED_FILES: usize = 3_000;

/// 10,000 source files in 100 directories, 3,000 files under an ignored `node_modules`, a
/// `.git` directory, never-share files and directories, binaries, oversized files, a link out
/// of the workspace, a lockfile and a README. Built once per test binary.
fn tree() -> &'static Ws {
    static TREE: OnceLock<Ws> = OnceLock::new();
    TREE.get_or_init(|| {
        let ws = Ws::new();
        let started = Instant::now();
        ws.write(".gitignore", "node_modules/\n*.tmp\n");
        ws.write("README.md", "# Synthetic project\n");
        ws.write("Cargo.toml", "[package]\nname = \"synthetic\"\n");
        ws.write(
            "Cargo.lock",
            format!("checksum = \"{}\"\n", common::hex(1, 64)),
        );
        let line = "pub fn compute(value: u64) -> u64 { value.wrapping_mul(31).rotate_left(7) }\n";
        for d in 0..DIRS {
            for f in 0..FILES_PER_DIR {
                let lines = 8 + (d * 7 + f * 13) % 40;
                ws.write(
                    &format!("src/mod_{d:03}/file_{f:03}.rs"),
                    line.repeat(lines),
                );
            }
        }
        for i in 0..IGNORED_FILES {
            ws.write(
                &format!("node_modules/pkg_{:02}/f_{i}.js", i % 50),
                "module.exports = 1;\n",
            );
        }
        ws.write(".git/config", "[remote \"origin\"]\n");
        ws.write(".git/objects/aa/bbbb", "blob");
        ws.write(".env", format!("TOKEN={}\n", token("ghp_", 5, 36)));
        ws.write("src/mod_000/.env.local", "X=1\n");
        ws.write(".ssh/id_ed25519", "key");
        ws.write(".aws/credentials", "[default]\n");
        ws.write("certs/server.pem", "pem");
        ws.write("exports/customers_export.csv", "id\n");
        ws.write("assets/logo.png", b"\x89PNG\r\n\x1a\n0000");
        ws.write("assets/blob.dat2", [0u8, 1, 2, 3, 0, 5].repeat(100));
        ws.write("big/huge.log", "x".repeat(400 * 1024));
        ws.write("scratch/a.tmp", "tmp");
        let outside = ws.outside();
        std::fs::write(outside.join("stolen.txt"), "outside").expect("write");
        let _ = common::link_dir(&ws.path().join("linked_out"), &outside);
        eprintln!(
            "synthetic tree: {} files written in {} ms",
            DIRS * FILES_PER_DIR + IGNORED_FILES + 20,
            started.elapsed().as_millis()
        );
        ws
    })
}

#[test]
fn default_budgets_hold_on_a_large_tree() {
    let ws = tree();
    let firewall = Firewall::for_root(ws.path());
    let budget = FolderBudget::default();
    let preview = analyze_folder(&firewall, ".", &budget, &DefaultRelevance).expect("analyze");
    eprintln!(
        "folder analysis: {} entries scanned, {} included ({} bytes), {} ms, counts {:?}",
        preview.entries_scanned,
        preview.included.len(),
        preview.total_bytes,
        preview.elapsed_ms,
        preview.excluded_counts
    );

    assert!(preview.included.len() <= budget.max_files);
    assert!(preview.total_bytes <= budget.max_total_bytes);
    assert_eq!(
        preview.included.len(),
        budget.max_files,
        "the file budget is the binding one here"
    );
    assert!(!preview.walk_truncated);
    assert!(
        preview
            .excluded_counts
            .get("over_file_budget")
            .copied()
            .unwrap_or(0)
            > 9_000
    );
    assert!(preview.excluded.len() <= budget.max_listed_exclusions);

    let included: Vec<&str> = preview.included_paths().collect();
    assert_eq!(included[0], "README.md", "relevance puts the README first");
    assert_eq!(included[1], "Cargo.toml");
    for path in &included {
        assert!(!path.starts_with("node_modules/"), "{path}");
        assert!(!path.starts_with(".git/"), "{path}");
        assert!(!path.contains(".env"), "{path}");
        assert!(
            !path.starts_with(".ssh/") && !path.starts_with(".aws/"),
            "{path}"
        );
        assert!(!path.ends_with(".pem") && !path.ends_with(".png"), "{path}");
        assert!(!path.starts_with("linked_out"), "{path}");
        assert!(!path.ends_with(".tmp"), "{path}");
    }
    // Ignored trees are never walked: far fewer entries than files on disk.
    assert!(preview.entries_scanned < (DIRS * FILES_PER_DIR + IGNORED_FILES) as u64);

    let reasons: Vec<(&str, &ExclusionReason)> = preview
        .excluded
        .iter()
        .map(|e| (e.relative.as_str(), &e.reason))
        .collect();
    let has = |path: &str, code: &str| reasons.iter().any(|(p, r)| *p == path && r.code() == code);
    assert!(has(".git", "never_share"), "{reasons:?}");
    assert!(has(".ssh", "never_share"));
    assert!(has(".aws", "never_share"));
    assert!(has(".env", "never_share"));
    assert!(has("certs/server.pem", "never_share"));
    assert!(has("exports/customers_export.csv", "never_share"));
    assert!(has("assets/logo.png", "binary"));
    assert!(has("big/huge.log", "too_large"));
    if ws.path().join("linked_out").exists() {
        assert!(has("linked_out", "link"), "{reasons:?}");
    }
}

#[test]
fn byte_budget_binds_when_files_are_large() {
    let ws = tree();
    let firewall = Firewall::for_root(ws.path());
    let budget = FolderBudget {
        max_files: 10_000,
        max_total_bytes: 256 * 1024,
        ..FolderBudget::default()
    };
    let preview = analyze_folder(&firewall, "src", &budget, &DefaultRelevance).expect("analyze");
    assert!(preview.total_bytes <= 256 * 1024);
    assert!(
        preview
            .excluded_counts
            .get("over_byte_budget")
            .copied()
            .unwrap_or(0)
            > 0
    );
}

#[test]
fn entry_cap_truncates_the_walk() {
    let ws = tree();
    let firewall = Firewall::for_root(ws.path());
    let budget = FolderBudget {
        max_entries_scanned: 1_000,
        ..FolderBudget::default()
    };
    let preview = analyze_folder(&firewall, ".", &budget, &DefaultRelevance).expect("analyze");
    assert!(preview.walk_truncated);
    assert!(preview.entries_scanned <= 1_001);
}

#[test]
fn never_share_or_outside_folders_are_refused() {
    let ws = tree();
    let firewall = Firewall::for_root(ws.path());
    for folder in [".ssh", ".git", "..", "linked_out", "node_modules"] {
        let result = analyze_folder(
            &firewall,
            folder,
            &FolderBudget::default(),
            &DefaultRelevance,
        );
        assert!(result.is_err(), "{folder}");
    }
}

#[test]
fn pruning_and_package_conversion() {
    let ws = tree();
    let firewall = Firewall::for_root(ws.path());
    let budget = FolderBudget {
        max_files: 30,
        ..FolderBudget::default()
    };
    let mut preview =
        analyze_folder(&firewall, "src/mod_001", &budget, &DefaultRelevance).expect("analyze");
    assert_eq!(preview.included.len(), 30);
    let first = preview.included[0].relative.clone();
    let bytes = preview.total_bytes;
    assert!(preview.prune(&first));
    assert!(!preview.prune(&first), "already pruned");
    assert!(preview.total_bytes < bytes);
    assert!(
        preview
            .excluded
            .iter()
            .any(|e| e.relative == first && e.reason == ExclusionReason::UserPruned)
    );
    let removed = preview
        .prune_matching("src/mod_001/file_0[0-4]*")
        .expect("glob");
    assert!(
        preview
            .included_paths()
            .all(|p| !p.starts_with("src/mod_001/file_0"))
    );
    eprintln!("pruned {removed} by pattern");

    let items = ContextItem::from_folder(&preview);
    assert_eq!(items.len(), preview.included.len() + 1);
    let package = ContextPackage::build(
        &firewall,
        &TextOnlyDefaults::new("provider-x"),
        PackageOptions::new(ContextPurpose::Drop),
        items,
    );
    let rendered = package.render().expect("render").text();
    assert!(rendered.contains("folder listing"));
    assert!(rendered.contains(&format!(
        "Folder src/mod_001 — {} file(s)",
        preview.included.len()
    )));
    assert!(
        package
            .items
            .iter()
            .all(|i| i.decision.verdict == FirewallVerdict::Allow)
    );
}

#[test]
fn custom_relevance_scorer_controls_order() {
    struct Reverse;
    impl RelevanceScorer for Reverse {
        fn score(&self, file: &kalcode_context::folder::FileFacts<'_>) -> i64 {
            -(file.relative.len() as i64)
        }
    }
    let ws = tree();
    let firewall = Firewall::for_root(ws.path());
    let preview = analyze_folder(
        &firewall,
        ".",
        &FolderBudget {
            max_files: 3,
            ..FolderBudget::default()
        },
        &Reverse,
    )
    .expect("analyze");
    let lengths: Vec<usize> = preview.included.iter().map(|e| e.relative.len()).collect();
    assert!(lengths.windows(2).all(|w| w[0] <= w[1]), "{lengths:?}");
}

/// Budget check (debug builds are ~10x slower, so this bound is lenient; the strict check is
/// the ignored release test below).
#[test]
fn scanning_is_fast_enough_in_debug() {
    let text = realistic_text(2 * 1024 * 1024);
    let started = Instant::now();
    let red = redact_text(
        &text,
        ScanContext {
            file_name: Some("big.rs"),
            no_entropy: false,
        },
        PlaceholderStyle::Labelled,
    );
    let ms = started.elapsed().as_secs_f64() * 1000.0;
    eprintln!(
        "debug scan: 2 MiB in {ms:.1} ms ({} redactions)",
        red.spans.len()
    );
    assert!(ms < 20_000.0);
}

#[test]
#[ignore = "performance: run in release with --ignored"]
fn performance_budgets_release() {
    // Secret scan + redaction throughput (the per-MiB budget).
    let text = realistic_text(4 * 1024 * 1024);
    let mib = text.len() as f64 / (1024.0 * 1024.0);
    let mut best = f64::MAX;
    for _ in 0..5 {
        let started = Instant::now();
        let red = redact_text(
            &text,
            ScanContext {
                file_name: Some("big.rs"),
                no_entropy: false,
            },
            PlaceholderStyle::Labelled,
        );
        std::hint::black_box(&red);
        best = best.min(started.elapsed().as_secs_f64() * 1000.0);
    }
    let per_mib = best / mib;
    eprintln!("PERF scan+redact: {mib:.1} MiB in {best:.1} ms = {per_mib:.1} ms/MiB (budget 50)");

    // Full package at the default 2 MiB cap: firewall + translation + render + hash.
    let ws = Ws::new();
    let chunk = realistic_text(64 * 1024);
    for i in 0..32 {
        ws.write(&format!("src/f{i:02}.rs"), &chunk);
    }
    let firewall = Firewall::for_root(ws.path());
    let items: Vec<ContextItem> = (0..32)
        .map(|i| ContextItem::file(format!("src/f{i:02}.rs")))
        .collect();
    let mut runs = Vec::new();
    let mut package = None;
    for _ in 0..5 {
        let started = Instant::now();
        package = Some(ContextPackage::build(
            &firewall,
            &TextOnlyDefaults::new("provider-x"),
            PackageOptions::new(ContextPurpose::Drop),
            items.clone(),
        ));
        runs.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    let package = package.expect("built");
    eprintln!("PERF package build runs (ms, first is cold): {runs:.1?}");
    let build_ms = runs[1..].iter().copied().fold(f64::MAX, f64::min);
    let sent = package.render().expect("render").bytes_sent as f64 / (1024.0 * 1024.0);
    eprintln!(
        "PERF package build (32 files, {sent:.2} MiB sent): {build_ms:.1} ms = {:.1} ms/MiB",
        build_ms / sent
    );

    // Folder analysis on the 13k-file synthetic tree.
    let tree = tree();
    let firewall = Firewall::for_root(tree.path());
    let mut times = Vec::new();
    for _ in 0..3 {
        let preview = analyze_folder(&firewall, ".", &FolderBudget::default(), &DefaultRelevance)
            .expect("analyze");
        times.push(preview.elapsed_ms);
    }
    times.sort_unstable();
    eprintln!(
        "PERF folder analysis (10k files + 3k ignored): median {} ms",
        times[1]
    );

    assert!(per_mib <= 50.0, "scan budget exceeded: {per_mib:.1} ms/MiB");
    assert!(build_ms / sent <= 50.0, "package budget exceeded");
}

/// Code-like text with a realistic density of secrets, assignments, hashes and identifiers.
fn realistic_text(target: usize) -> String {
    let mut out = String::with_capacity(target + 256);
    let mut i = 0u64;
    while out.len() < target {
        i += 1;
        match i % 20 {
            0 => out.push_str(&format!("const TOKEN: &str = \"{}\";\n", token("ghp_", i, 36))),
            1 => out.push_str(&format!("let checksum = \"{}\";\n", common::hex(i, 64))),
            2 => out.push_str("    let user_account_settings = load_settings(&config.path)?;\n"),
            3 => out.push_str(&format!("password = \"{}\"\n", body(i, 20))),
            4 => out.push_str("// Computes the next state of the scheduler from the event queue.\n"),
            5 => out.push_str(&format!("url = \"https://example.com/api/v1/items/{}\"\n", i)),
            _ => out.push_str("    fn handle(&mut self, event: Event) -> Result<(), Error> { self.queue.push(event); Ok(()) }\n"),
        }
    }
    out
}
