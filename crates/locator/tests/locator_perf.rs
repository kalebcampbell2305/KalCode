//! LOC-06: a query over 100k entries answers in ≤ 30 ms (p95). Incremental indexing ≤ 2 ms per
//! event (ADVANCED.md §10).
//!
//! Release only (debug SQLite is several times slower):
//! `cargo test --release -p kalcode-locator --test locator_perf -- --ignored --nocapture`

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod common;

use std::time::Instant;

use kalcode_contracts::ids::new_id;
use kalcode_core::time::format_rfc3339;
use kalcode_locator::index::{self, Filters, IndexEntry};
use kalcode_locator::query;
use kalcode_locator::store::Store;
use kalcode_locator::{LocatorEntityKind, LocatorRecency, LocatorSort, LocatorStatusFilter};
use time::OffsetDateTime;

const ENTRIES: usize = 100_000;

const WORDS: &[&str] = &[
    "auth",
    "refactor",
    "billing",
    "upload",
    "retry",
    "cache",
    "search",
    "rail",
    "pane",
    "layout",
    "migration",
    "schema",
    "tests",
    "flaky",
    "docs",
    "release",
    "pipeline",
    "webhook",
    "ledger",
    "invoice",
    "login",
    "session",
    "token",
    "router",
    "graph",
    "metrics",
    "latency",
    "worker",
    "queue",
    "sync",
    "export",
    "import",
    "theme",
    "palette",
    "voice",
    "terminal",
    "shell",
    "profile",
    "provider",
    "handoff",
];
const STATUSES: &[&str] = &[
    "working",
    "idle",
    "done",
    "failed",
    "permission_required",
    "waiting_for_you",
    "paused",
];

fn entry(i: usize, now: OffsetDateTime, workspaces: &[String]) -> IndexEntry {
    let w = |n: usize| WORDS[(i * 7 + n * 13) % WORDS.len()];
    let kind = match i % 10 {
        0..=6 => LocatorEntityKind::Thread,
        7 => LocatorEntityKind::Terminal,
        8 => LocatorEntityKind::Activity,
        _ => LocatorEntityKind::Workspace,
    };
    IndexEntry {
        kind,
        entity_id: new_id(),
        workspace_id: Some(workspaces[i % workspaces.len()].clone()),
        provider_id: Some(
            if i.is_multiple_of(3) {
                "codex"
            } else {
                "claude-code"
            }
            .to_owned(),
        ),
        title: format!("{} {} {} #{i}", w(0), w(1), w(2)),
        subtitle: Some(format!("Claude Code · workspace-{}", i % workspaces.len())),
        status: Some(STATUSES[i % STATUSES.len()].to_owned()),
        updated_at: format_rfc3339(now - time::Duration::minutes((i % 20_000) as i64 * 7)),
        body: None,
    }
}

fn p95(mut samples: Vec<f64>) -> f64 {
    samples.sort_by(f64::total_cmp);
    samples[(samples.len() as f64 * 0.95) as usize - 1]
}

#[test]
#[ignore = "performance budget: run in release"]
fn a_query_over_100k_entries_answers_within_30ms_p95() {
    let dir = tempfile::tempdir().unwrap();
    let core = common::core_with_v10(dir.path());
    let store = Store::open(&core).unwrap();
    assert!(store.persistent());
    let now = OffsetDateTime::now_utc();
    let workspaces: Vec<String> = (0..40).map(|_| new_id()).collect();

    let started = Instant::now();
    let entries: Vec<IndexEntry> = (0..ENTRIES).map(|i| entry(i, now, &workspaces)).collect();
    for chunk in entries.chunks(2000) {
        store
            .write(|tx| {
                for e in chunk {
                    index::upsert(tx, e)?;
                }
                Ok(())
            })
            .unwrap();
    }
    println!("indexed {ENTRIES} entries in {:?}", started.elapsed());

    // Incremental: one entry per event (a status change), on the writer. The worker applies the
    // events of a 40 ms window in one transaction; a lone event pays a whole commit.
    let mut single = Vec::new();
    for (n, e) in entries.iter().take(200).enumerate() {
        let mut changed = e.clone();
        changed.status = Some(STATUSES[(n + 1) % STATUSES.len()].to_owned());
        let t = Instant::now();
        store.write(|tx| index::upsert(tx, &changed)).unwrap();
        single.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    let mut batched = Vec::new();
    for (n, chunk) in entries[200..1200].chunks(10).enumerate() {
        let t = Instant::now();
        store
            .write(|tx| {
                for e in chunk {
                    let mut changed = e.clone();
                    changed.status = Some(STATUSES[(n + 2) % STATUSES.len()].to_owned());
                    index::upsert(tx, &changed)?;
                }
                Ok(())
            })
            .unwrap();
        batched.push(t.elapsed().as_secs_f64() * 1000.0 / chunk.len() as f64);
    }
    let lone = p95(single);
    let incremental = p95(batched);
    println!(
        "incremental: lone event p95 {lone:.3} ms (one commit each); per event in a batch of 10 p95 {incremental:.3} ms"
    );

    let cases: Vec<(&str, Filters)> = vec![
        ("auth", Filters::default()),
        ("billing retry", Filters::default()),
        ("login", Filters::default()),
        (
            "flaky tests",
            Filters {
                kinds: vec![LocatorEntityKind::Thread],
                ..Filters::default()
            },
        ),
        ("ui", Filters::default()),
        ("#4242", Filters::default()),
        ("zebracorn nothing matches", Filters::default()),
        (
            "",
            Filters {
                statuses: vec![LocatorStatusFilter::NeedsYou],
                ..Filters::default()
            },
        ),
        (
            "webhook",
            Filters {
                workspace_id: Some(workspaces[3].clone()),
                ..Filters::default()
            },
        ),
        (
            "rail",
            Filters {
                provider_id: Some("codex".into()),
                active_only: true,
                ..Filters::default()
            },
        ),
    ];
    let mut all = Vec::new();
    for (text, filters) in &cases {
        let parsed = query::parse(text);
        let mut filters = filters.clone();
        if text.is_empty() {
            let (from, to) = index::recency_window(LocatorRecency::ThisWeek, now, 0);
            filters.since = Some(format_rfc3339(from));
            filters.until = Some(format_rfc3339(to));
        }
        let mut samples = Vec::new();
        for _ in 0..60 {
            let t = Instant::now();
            let results = store
                .read(|conn| index::search(conn, &parsed, &filters, LocatorSort::Relevance, now))
                .unwrap();
            samples.push(t.elapsed().as_secs_f64() * 1000.0);
            std::hint::black_box(results);
        }
        let t = Instant::now();
        let n = store
            .read(|conn| index::candidate_count(conn, &parsed, &filters))
            .unwrap();
        let sql_ms = t.elapsed().as_secs_f64() * 1000.0;
        let mut sorted = samples.clone();
        sorted.sort_by(f64::total_cmp);
        println!(
            "{text:>28?}: p50 {:.2} ms, p95 {:.2} ms ({n} candidates, retrieval {sql_ms:.2} ms)",
            sorted[sorted.len() / 2],
            p95(samples.clone())
        );
        all.extend(samples);
    }
    let overall = p95(all);
    println!("overall p95 {overall:.2} ms");
    assert!(
        overall <= 30.0,
        "LOC-06 budget: p95 {overall:.2} ms > 30 ms"
    );
    assert!(
        incremental <= 2.0,
        "incremental budget: p95 {incremental:.3} ms > 2 ms"
    );
}
