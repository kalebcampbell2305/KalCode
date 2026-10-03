use std::time::Instant;

use kalcode_contracts::agent::ProviderId;
use kalcode_contracts::permissions::PermissionMode;
use kalcode_contracts::sessions::{SessionMatchTier, SessionResolution};
use kalcode_contracts::threads::{ThreadStatus, ThreadSummary};
use serde_json::Value;

use super::*;

const CASES: &str = include_str!("session_resolver_cases.json");

fn thread_id(key: &str) -> String {
    format!("0192f3c4-0000-7000-8000-0000000000{key}")
}

#[test]
fn agent_targets_never_resolve_to_a_chat_with_the_same_name() {
    let chat = summary(
        "01",
        "Release",
        (ProviderId::CODEX, "Codex"),
        None,
        ws1(),
        ThreadStatus::Completed,
        false,
    );
    let mut agent = chat.clone();
    agent.id = thread_id("02");
    agent.runtime_kind = Some(kalcode_contracts::threads::ThreadRuntimeKind::InteractivePty);
    assert!(
        matches!(resolve(&[chat.clone(), agent.clone()], "Release agent", &ResolveContext::default()),
        SessionResolution::Resolved { target, .. } if target.thread_id == agent.id)
    );
    assert!(matches!(
        resolve(
            std::slice::from_ref(&chat),
            "Release agent",
            &ResolveContext::default()
        ),
        SessionResolution::NotFound { .. }
    ));
    assert!(matches!(
        resolve(&[chat], "Release thread", &ResolveContext::default()),
        SessionResolution::Resolved { .. }
    ));
}

fn summary(
    key: &str,
    name: &str,
    (provider, provider_name): (&str, &str),
    account: Option<&str>,
    workspace: (&str, &str),
    status: ThreadStatus,
    archived: bool,
) -> ThreadSummary {
    ThreadSummary {
        can_move_workspace: None,
        id: thread_id(key),
        name: name.into(),
        provider_id: ProviderId::new(provider),
        provider_name: provider_name.into(),
        model: None,
        effort: None,
        provider_account_id: account.map(|_| format!("acct-{key}")),
        account_label: account.map(str::to_owned),
        workspace_id: workspace.0.into(),
        workspace_name: workspace.1.into(),
        permission_mode: PermissionMode::Approve,
        status,
        current_activity: None,
        created_at: "2026-09-28T12:00:00Z".into(),
        last_activity_at: "2026-09-28T12:00:00Z".into(),
        pending_approvals: 0,
        unread_messages: 0,
        files_changed: None,
        branch: None,
        error: None,
        archived_at: archived.then(|| "2026-09-28T12:30:00Z".into()),
        resumable: false,
        permission_profile_id: None,
        runtime_kind: None,
        terminal_id: None,
        worktree_id: None,
    }
}

struct Fixture {
    threads: Vec<ThreadSummary>,
    workspaces: Value,
    cases: Vec<Value>,
}

fn fixture() -> Fixture {
    let doc: Value = serde_json::from_str(CASES).expect("cases json");
    let workspaces = doc["workspaces"].clone();
    let threads = doc["threads"]
        .as_array()
        .expect("threads")
        .iter()
        .map(|t| {
            let ws = &workspaces[t["workspace"].as_str().expect("workspace")];
            let status: ThreadStatus = serde_json::from_value(t["status"].clone()).expect("status");
            summary(
                t["key"].as_str().expect("key"),
                t["name"].as_str().expect("name"),
                (
                    t["provider"].as_str().expect("provider"),
                    t["providerName"].as_str().expect("providerName"),
                ),
                t["account"].as_str(),
                (
                    ws["id"].as_str().expect("ws id"),
                    ws["name"].as_str().expect("ws name"),
                ),
                status,
                t["archived"].as_bool().unwrap_or(false),
            )
        })
        .collect();
    Fixture {
        threads,
        cases: doc["cases"].as_array().expect("cases").clone(),
        workspaces,
    }
}

fn run_case(f: &Fixture, case: &Value) -> SessionResolution {
    let query = match case["queryThread"].as_str() {
        Some(key) => thread_id(key),
        None => case["query"].as_str().expect("query").to_owned(),
    };
    let workspace = case["workspace"]
        .as_str()
        .map(|w| f.workspaces[w]["id"].as_str().expect("ws").to_owned());
    let focused = case["focused"].as_str().map(thread_id);
    let last = case["last"].as_str().map(thread_id);
    resolve(
        &f.threads,
        &query,
        &ResolveContext {
            workspace_id: workspace.as_deref(),
            focused_thread_id: focused.as_deref(),
            last_target_id: last.as_deref(),
        },
    )
}

fn check_case(f: &Fixture, case: &Value) -> Result<(), String> {
    let name = case["name"].as_str().unwrap_or("?");
    let got = run_case(f, case);
    let expect = &case["expect"];
    let fail = |why: String| Err(format!("{name}: {why}; got {got:?}"));
    match (expect["kind"].as_str().expect("kind"), &got) {
        ("resolved", SessionResolution::Resolved { target, tier }) => {
            let want = thread_id(expect["thread"].as_str().expect("thread"));
            let want_tier: SessionMatchTier =
                serde_json::from_value(expect["tier"].clone()).expect("tier");
            if target.thread_id != want || *tier != want_tier {
                return fail(format!("expected {want} via {want_tier:?}"));
            }
        }
        (
            "ambiguous",
            SessionResolution::Ambiguous {
                question,
                choices,
                total,
            },
        ) => {
            let want: Vec<String> = expect["threads"]
                .as_array()
                .expect("threads")
                .iter()
                .map(|k| thread_id(k.as_str().expect("key")))
                .collect();
            let ids: Vec<String> = choices.iter().map(|c| c.thread_id.clone()).collect();
            if ids != want {
                return fail(format!("expected choices {want:?}"));
            }
            if u64::from(*total) != expect["total"].as_u64().expect("total") {
                return fail(format!("expected total {}", expect["total"]));
            }
            if question != expect["question"].as_str().expect("question") {
                return fail(format!("expected question {}", expect["question"]));
            }
        }
        ("not_found", SessionResolution::NotFound { .. }) => {}
        (kind, _) => return fail(format!("expected {kind}")),
    }
    Ok(())
}

#[test]
fn every_shared_case_resolves_as_specified() {
    let f = fixture();
    assert!(f.cases.len() >= 25, "the shared table must stay broad");
    let failures: Vec<String> = f
        .cases
        .iter()
        .filter_map(|case| check_case(&f, case).err())
        .collect();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn every_tier_is_exercised_by_the_shared_cases() {
    let f = fixture();
    let tiers: Vec<SessionMatchTier> = f
        .cases
        .iter()
        .filter_map(|case| match run_case(&f, case) {
            SessionResolution::Resolved { tier, .. } => Some(tier),
            _ => None,
        })
        .collect();
    for tier in [
        SessionMatchTier::ExplicitId,
        SessionMatchTier::ExactNameInWorkspace,
        SessionMatchTier::ExactName,
        SessionMatchTier::ProviderAccountName,
        SessionMatchTier::Focused,
        SessionMatchTier::LastTarget,
        SessionMatchTier::ProviderOnly,
        SessionMatchTier::Fuzzy,
    ] {
        assert!(tiers.contains(&tier), "{tier:?} is never exercised");
    }
}

fn ws1() -> (&'static str, &'static str) {
    ("0192f3c4-0000-7000-8000-00000000a001", "kalcode")
}

fn gemini(key: &str, name: &str, account: &str) -> ThreadSummary {
    summary(
        key,
        name,
        (ProviderId::GEMINI_CLI, "Gemini CLI"),
        Some(account),
        ws1(),
        ThreadStatus::Idle,
        false,
    )
}

#[test]
fn account_disambiguation_labels_every_choice_name_provider_account() {
    let threads = [
        gemini("01", "Research", "Gemini A"),
        gemini("02", "Research", "Gemini B"),
    ];
    let SessionResolution::Ambiguous { choices, .. } =
        resolve(&threads, "Research", &ResolveContext::default())
    else {
        panic!("expected a clarification");
    };
    let labels: Vec<&str> = choices.iter().map(|c| c.label.as_str()).collect();
    assert_eq!(
        labels,
        [
            "Research \u{b7} Gemini CLI \u{b7} Gemini A",
            "Research \u{b7} Gemini CLI \u{b7} Gemini B"
        ]
    );
    assert_eq!(choices[1].account_label.as_deref(), Some("Gemini B"));
}

#[test]
fn a_thread_without_an_account_is_labelled_name_and_provider() {
    let t = summary(
        "01",
        "Release Mac",
        (ProviderId::CODEX, "Codex"),
        None,
        ws1(),
        ThreadStatus::Idle,
        false,
    );
    assert_eq!(session_label(&t), "Release Mac \u{b7} Codex");
    let blank = ThreadSummary {
        account_label: Some("  ".into()),
        ..t
    };
    assert_eq!(session_label(&blank), "Release Mac \u{b7} Codex");
}

#[test]
fn account_words_alone_never_pick_the_other_account() {
    let threads = [gemini("01", "Research", "Gemini A")];
    // Only Gemini A exists: "Gemini B Research" must not resolve to it.
    assert!(matches!(
        resolve(&threads, "Gemini B Research", &ResolveContext::default()),
        SessionResolution::NotFound { .. }
    ));
    assert!(matches!(
        resolve(&threads, "Gemini A Research", &ResolveContext::default()),
        SessionResolution::Resolved {
            tier: SessionMatchTier::ProviderAccountName,
            ..
        }
    ));
}

#[test]
fn live_task_context_resolves_natural_scene_phrases_without_reading_messages() {
    let mut website = summary(
        "01",
        "Website refresh",
        (ProviderId::CLAUDE_CODE, "Claude Code"),
        Some("Claude A"),
        ws1(),
        ThreadStatus::Testing,
        false,
    );
    website.model = Some("claude-opus-4-1".into());
    website.runtime_kind = Some(kalcode_contracts::threads::ThreadRuntimeKind::InteractivePty);
    website.effort = Some("high".into());
    website.current_activity = Some("Running frontend tests for the website".into());
    website.branch = Some("feature/navigation".into());
    let mut api = summary(
        "02",
        "API release",
        (ProviderId::CLAUDE_CODE, "Claude Code"),
        Some("Claude B"),
        ws1(),
        ThreadStatus::Active,
        false,
    );
    api.current_activity = Some("Refactoring authentication middleware".into());

    for query in [
        "find Claude working on the website",
        "open the terminal running frontend tests",
        "show me the feature navigation agent",
        "show me the high Claude website agent",
    ] {
        assert!(
            matches!(
                resolve(&[website.clone(), api.clone()], query, &ResolveContext::default()),
                SessionResolution::Resolved {
                    ref target,
                    tier: SessionMatchTier::Fuzzy,
                } if target.thread_id == website.id
            ),
            "{query}"
        );
    }
    assert!(matches!(
        resolve(
            &[website, api.clone()],
            "the one working on auth",
            &ResolveContext::default(),
        ),
        SessionResolution::Resolved { ref target, .. } if target.thread_id == api.id
    ));
}

#[test]
fn live_task_context_keeps_equal_matches_ambiguous_and_other_excludes_focus() {
    let mut first = summary(
        "01",
        "Browser one",
        (ProviderId::CODEX, "Codex"),
        None,
        ws1(),
        ThreadStatus::Active,
        false,
    );
    first.current_activity = Some("Implementing Browser controls".into());
    first.runtime_kind = Some(kalcode_contracts::threads::ThreadRuntimeKind::InteractivePty);
    let mut second = summary(
        "02",
        "Browser two",
        (ProviderId::CODEX, "Codex"),
        None,
        ws1(),
        ThreadStatus::Active,
        false,
    );
    second.current_activity = Some("Reviewing Browser controls".into());
    second.runtime_kind = Some(kalcode_contracts::threads::ThreadRuntimeKind::InteractivePty);

    assert!(matches!(
        resolve(
            &[first.clone(), second.clone()],
            "open the Codex terminal working on Browser",
            &ResolveContext::default(),
        ),
        SessionResolution::Ambiguous { total: 2, .. }
    ));
    assert!(matches!(
        resolve(
            &[first.clone(), second.clone()],
            "open the other Codex session",
            &ResolveContext {
                focused_thread_id: Some(&first.id),
                ..ResolveContext::default()
            },
        ),
        SessionResolution::Resolved { ref target, .. } if target.thread_id == second.id
    ));
}

#[test]
fn task_context_requires_a_locating_phrase_and_all_meaningful_words() {
    let mut thread = summary(
        "01",
        "Website refresh",
        (ProviderId::CLAUDE_CODE, "Claude Code"),
        None,
        ws1(),
        ThreadStatus::Testing,
        false,
    );
    thread.current_activity = Some("Running website tests".into());

    for query in [
        "refactor the website and run tests",
        "find Claude working on the payments service",
    ] {
        assert!(
            matches!(
                resolve(&[thread.clone()], query, &ResolveContext::default()),
                SessionResolution::NotFound { .. }
            ),
            "{query}"
        );
    }
}

#[test]
fn not_found_never_echoes_the_query_or_names_another_session() {
    let threads = [gemini("01", "Research", "Gemini A")];
    let SessionResolution::NotFound { message } = resolve(
        &threads,
        "sk-live-secret-looking-words",
        &ResolveContext::default(),
    ) else {
        panic!("expected not found");
    };
    assert!(!message.contains("sk-live"));
    assert!(!message.contains("Research"));
}

#[test]
fn an_overlong_query_is_not_a_name() {
    let threads = [gemini("01", "Research", "Gemini A")];
    let long = format!("Research {}", "x".repeat(MAX_SESSION_QUERY_CHARS));
    assert!(matches!(
        resolve(&threads, &long, &ResolveContext::default()),
        SessionResolution::NotFound { .. }
    ));
}

#[test]
fn short_fragments_never_typo_match() {
    let threads = [gemini("01", "Docs", "Gemini A")];
    // "Dogs" is one edit from "Docs", but four letters is too short to tolerate typos.
    assert!(matches!(
        resolve(&threads, "Dogs", &ResolveContext::default()),
        SessionResolution::NotFound { .. }
    ));
    assert_eq!(typo_budget(4), 0);
    assert_eq!(typo_budget(5), 1);
    assert_eq!(typo_budget(10), 2);
}

#[test]
fn typo_distance_counts_swaps_as_one_edit() {
    assert!(within_distance("reelase", "release", 1));
    assert!(within_distance("relase", "release", 1));
    assert!(!within_distance("rlase", "release", 1));
    assert!(within_distance("rlase", "release", 2));
    assert!(!within_distance("windows", "mac", 2));
}

#[test]
fn normalization_folds_case_diacritics_and_punctuation() {
    assert_eq!(normalize("  Café—Menu  "), "cafe menu");
    assert_eq!(normalize("Ærø Straße"), "aero strasse");
    assert_eq!(normalize("Łódź / Œuvre"), "lodz oeuvre");
    assert_eq!(normalize("Cafe\u{301}"), "cafe");
    assert_eq!(normalize("Release_Mac.v2"), "release mac v2");
    assert_eq!(normalize("\u{65e5}\u{672c} Docs"), "\u{65e5}\u{672c} docs");
}

#[test]
fn clarification_prefers_the_current_workspace_then_recency() {
    let ws2 = ("0192f3c4-0000-7000-8000-00000000a002", "atlas-api");
    let threads = [
        summary(
            "01",
            "Release Windows",
            (ProviderId::CODEX, "Codex"),
            None,
            ws2,
            ThreadStatus::Idle,
            false,
        ),
        summary(
            "02",
            "Release Mac",
            (ProviderId::CODEX, "Codex"),
            None,
            ws1(),
            ThreadStatus::Idle,
            false,
        ),
        summary(
            "03",
            "Release Linux",
            (ProviderId::CODEX, "Codex"),
            None,
            ws1(),
            ThreadStatus::Idle,
            false,
        ),
    ];
    let SessionResolution::Ambiguous {
        question, choices, ..
    } = resolve(
        &threads,
        "release",
        &ResolveContext {
            workspace_id: Some(ws1().0),
            ..ResolveContext::default()
        },
    )
    else {
        panic!("expected a clarification");
    };
    let names: Vec<&str> = choices.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["Release Mac", "Release Linux", "Release Windows"]);
    assert_eq!(
        question,
        "Which one \u{2014} Release Mac, Release Linux or Release Windows?"
    );
}

#[test]
fn same_name_in_two_workspaces_is_told_apart_by_workspace() {
    let ws2 = ("0192f3c4-0000-7000-8000-00000000a002", "atlas-api");
    let threads = [
        summary(
            "01",
            "Deploy",
            (ProviderId::CODEX, "Codex"),
            None,
            ws1(),
            ThreadStatus::Idle,
            false,
        ),
        summary(
            "02",
            "Deploy",
            (ProviderId::CODEX, "Codex"),
            None,
            ws2,
            ThreadStatus::Idle,
            false,
        ),
    ];
    let SessionResolution::Ambiguous { question, .. } =
        resolve(&threads, "Deploy", &ResolveContext::default())
    else {
        panic!("expected a clarification");
    };
    assert_eq!(
        question,
        "Which one \u{2014} Deploy in kalcode or Deploy in atlas-api?"
    );
}

#[test]
fn resolving_across_a_large_listing_stays_well_under_50ms() {
    let providers = [
        (ProviderId::CLAUDE_CODE, "Claude Code"),
        (ProviderId::CODEX, "Codex"),
        (ProviderId::GEMINI_CLI, "Gemini CLI"),
    ];
    let threads: Vec<ThreadSummary> = (0..1000)
        .map(|i| {
            let (provider, provider_name) = providers[i % 3];
            let mut t = summary(
                "00",
                &format!("Feature branch number {i}"),
                (provider, provider_name),
                Some(if i % 2 == 0 { "Personal" } else { "Work" }),
                ws1(),
                ThreadStatus::Idle,
                false,
            );
            t.id = format!("0192f3c4-0000-7000-8000-{i:012}");
            t
        })
        .collect();
    let ctx = ResolveContext {
        workspace_id: Some(ws1().0),
        ..ResolveContext::default()
    };
    // Warm up, then time the slowest path (every tier runs and the typo tier scans everything).
    let _ = resolve(&threads, "Nothing like it at all", &ctx);
    let started = Instant::now();
    for query in [
        "Feature branch number 999",
        "Nothing like it at all",
        "Codex",
    ] {
        let _ = resolve(&threads, query, &ctx);
    }
    let elapsed = started.elapsed();
    assert!(
        elapsed.as_millis() < 150,
        "three resolves over 1000 threads took {elapsed:?} (budget 50 ms each)"
    );
}

/// Latency report for voice targets (run with `--ignored --nocapture`): p50/p95 of one resolve
/// over a realistic open-thread listing (60 threads) across every tier.
#[test]
#[ignore = "latency report, not a gate"]
fn resolver_latency_report() {
    let providers = [
        (ProviderId::CLAUDE_CODE, "Claude Code"),
        (ProviderId::CODEX, "Codex"),
        (ProviderId::GEMINI_CLI, "Gemini CLI"),
    ];
    let threads: Vec<ThreadSummary> = (0..60)
        .map(|i| {
            let (provider, provider_name) = providers[i % 3];
            let mut t = summary(
                "00",
                &format!("Feature {i} refactor"),
                (provider, provider_name),
                Some(if i % 2 == 0 { "Personal" } else { "Work" }),
                ws1(),
                ThreadStatus::Idle,
                false,
            );
            t.id = format!("0192f3c4-0000-7000-8000-{i:012}");
            t
        })
        .collect();
    let ctx = ResolveContext {
        workspace_id: Some(ws1().0),
        focused_thread_id: Some("0192f3c4-0000-7000-8000-000000000007"),
        last_target_id: None,
    };
    let queries = [
        "Feature 42 refactor",
        "codex work feature 7 refactor",
        "it",
        "gemini personal",
        "feature 4",
        "featur 42 refactr",
        "nothing like it",
    ];
    let mut samples = Vec::new();
    for _ in 0..200 {
        for query in queries {
            let started = Instant::now();
            std::hint::black_box(resolve(&threads, query, &ctx));
            samples.push(started.elapsed().as_secs_f64() * 1000.0);
        }
    }
    samples.sort_by(f64::total_cmp);
    let at = |q: f64| samples[((samples.len() - 1) as f64 * q).round() as usize];
    println!(
        "session_resolver::resolve over 60 threads: p50 {:.3} ms, p95 {:.3} ms, max {:.3} ms (n={})",
        at(0.5),
        at(0.95),
        at(1.0),
        samples.len()
    );
}
