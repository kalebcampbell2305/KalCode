//! KalVoice understanding + fast-path latency baseline (analysis branch only).
//!
//! Replays `corpus.json` through the same deterministic stages the product runs after a
//! transcript is final:
//!
//! 1. `orchestrator::talk_route` (command vs dictation vs request) for each focus target;
//! 2. `grammar::understand` (the deterministic fast path);
//! 3. for fall-through requests, `grammar::local_reasoning_must_refuse` and
//!    `local_reasoning::grounded_action_candidates` — the only actions the on-device model is
//!    ever offered (it selects an opaque candidate id or null; it cannot build an action);
//! 4. named-target resolution with the same ranking rules as the desktop executor
//!    (`kalvoice_executor.rs` `find_workspace`, `threads::runtime::find`) over a fixture world.
//!
//! The model itself is not run here: a fall-through that reaches the model is scored
//! "model-dependent" (correct only if an ideal selector could pick the expected candidate).
//! No speech content is logged anywhere; this file only reads synthetic corpus text.
//!
//! Modes: `baseline` (grammar + the legacy first-match thread lookup), `proposed` (the harness's
//! own rewrite simulation on top), and `product` (0.1.5 as shipped: the grammar's built-in second
//! chance, strict session targets, and the executor's answer for session commands). Since the
//! second chance is now product code, `baseline` here is no longer the pre-0.1.5 grammar.
//!
//! Run (release timings): `CARGO_BUILD_JOBS=2 cargo test --release -p kalcode-kalvoice --lib
//! understanding_bench -- --nocapture --test-threads=1`
//! Results: `<target>/kalvoice-understanding-results.json`.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::print_stdout,
    clippy::too_many_lines,
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss
)]

use std::collections::BTreeMap;
use std::time::Instant;

use kalcode_contracts::kalvoice::{KalVoiceIntent, TalkRoute};
use kalcode_contracts::threads::WorkspaceOption;
use serde_json::{Value, json};

use crate::grammar::{self, NamedTarget, Understood};
use crate::local_reasoning::{LocalInterpretationRequest, grounded_action_candidates};
use crate::orchestrator::{TalkTarget, talk_route};

const CORPUS: &str = include_str!("corpus.json");
/// Paraphrases written AFTER the proposed rules, to check they generalize.
const HOLDOUT: &str = include_str!("holdout.json");
const TIMING_ITERATIONS: usize = 200;

// ---------------------------------------------------------------------------------------------
// Fixture world (mirrors the executor's resolution rules).

struct Thread {
    id: String,
    name: String,
    provider: String,
    workspace: String,
}

struct World {
    workspaces: Vec<WorkspaceOption>,
    threads: Vec<Thread>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Resolved {
    Id(String),
    NotFound,
    Ambiguous,
}

impl World {
    fn load(fixture: &Value) -> Self {
        let workspaces = fixture["workspaces"]
            .as_array()
            .unwrap()
            .iter()
            .map(|w| {
                let name = w.as_str().unwrap().to_owned();
                WorkspaceOption {
                    id: format!("ws-{name}"),
                    name,
                }
            })
            .collect();
        let threads = fixture["threads"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| Thread {
                id: format!("th-{}", t["name"].as_str().unwrap().replace(' ', "-")),
                name: t["name"].as_str().unwrap().to_owned(),
                provider: t["provider"].as_str().unwrap().to_owned(),
                workspace: t["workspace"].as_str().unwrap().to_owned(),
            })
            .collect();
        Self {
            workspaces,
            threads,
        }
    }

    /// `kalvoice_executor.rs` `find_workspace`: exact, then `-_.`-normalized, then contains;
    /// more than one match at a rank is an error.
    fn find_workspace_once(&self, name: &str) -> Resolved {
        let wanted = name.trim().to_lowercase();
        if wanted.is_empty() {
            return Resolved::NotFound;
        }
        for rank in 0..3 {
            let matches: Vec<_> = self
                .workspaces
                .iter()
                .filter(|w| {
                    let n = w.name.to_lowercase();
                    match rank {
                        0 => n == wanted,
                        1 => n.replace(['-', '_', '.'], " ") == wanted,
                        _ => n.contains(&wanted),
                    }
                })
                .collect();
            match matches.len() {
                0 => {}
                1 => return Resolved::Id(matches[0].id.clone()),
                _ => return Resolved::Ambiguous,
            }
        }
        Resolved::NotFound
    }

    /// `threads::runtime::find` + `find_thread`: exact name, then name contains, then provider
    /// or workspace name contains; the FIRST match wins (no ambiguity error).
    fn find_thread_once(&self, name: &str) -> Resolved {
        let query = name.trim().to_lowercase();
        if query.is_empty() {
            return Resolved::NotFound;
        }
        let mut ranked: Vec<(u8, &Thread)> = self
            .threads
            .iter()
            .filter_map(|t| {
                let n = t.name.to_lowercase();
                let rank = if n == query {
                    0
                } else if n.contains(&query) {
                    1
                } else if t.provider.to_lowercase().contains(&query)
                    || t.workspace.to_lowercase().contains(&query)
                {
                    2
                } else {
                    return None;
                };
                Some((rank, t))
            })
            .collect();
        ranked.sort_by_key(|(rank, _)| *rank);
        ranked
            .first()
            .map_or(Resolved::NotFound, |(_, t)| Resolved::Id(t.id.clone()))
    }

    /// Orchestrator `resolve`: retries without a leading "my ".
    fn resolve(&self, name: &str, thread: bool) -> Resolved {
        let find = |n: &str| {
            if thread {
                self.find_thread_once(n)
            } else {
                self.find_workspace_once(n)
            }
        };
        let found = find(name);
        if found == Resolved::NotFound
            && let Some(rest) = name.strip_prefix("my ")
        {
            return find(rest);
        }
        found
    }

    /// PROPOSED (0.1.5): thread targets for voice must name one thread. Deictic words and
    /// provider/workspace-only matches, or several equally good matches, ask instead of picking
    /// the most recent.
    fn resolve_thread_strict(&self, name: &str) -> Resolved {
        let raw = name.trim().to_lowercase();
        let query = raw.strip_prefix("my ").unwrap_or(&raw);
        if matches!(
            query,
            "this"
                | "that"
                | "it"
                | "this one"
                | "that one"
                | "last"
                | "the last"
                | "first"
                | "current"
                | "other"
                | "every"
                | "all"
        ) {
            return Resolved::Ambiguous;
        }
        let mut best: Option<(u8, Vec<&Thread>)> = None;
        for t in &self.threads {
            let n = t.name.to_lowercase();
            let rank = if n == query {
                0
            } else if n.contains(query) {
                1
            } else if t.provider.to_lowercase().contains(query)
                || t.workspace.to_lowercase().contains(query)
            {
                2
            } else {
                continue;
            };
            match &mut best {
                Some((r, v)) if *r == rank => v.push(t),
                Some((r, _)) if *r < rank => {}
                _ => best = Some((rank, vec![t])),
            }
        }
        match best {
            None => Resolved::NotFound,
            Some((2, _)) => Resolved::Ambiguous,
            Some((_, v)) if v.len() > 1 => Resolved::Ambiguous,
            Some((_, v)) => Resolved::Id(v[0].id.clone()),
        }
    }

    fn resolve_actual(&self, name: &str, thread: bool, strict: bool) -> Resolved {
        if thread && strict {
            self.resolve_thread_strict(name)
        } else {
            self.resolve(name, thread)
        }
    }

    /// How many threads a thread query could plausibly mean (for "picked one of several").
    fn thread_matches(&self, name: &str) -> usize {
        let query = name.trim().to_lowercase();
        self.threads
            .iter()
            .filter(|t| {
                t.name.to_lowercase().contains(&query)
                    || t.provider.to_lowercase().contains(&query)
                    || t.workspace.to_lowercase().contains(&query)
            })
            .count()
    }
}

// ---------------------------------------------------------------------------------------------
// Pipeline result

#[derive(Debug, Clone)]
enum Stage {
    /// Deterministic intent (+ what its named target resolves to).
    Fast {
        intent: Value,
        target: Target,
    },
    Rejected {
        code: &'static str,
    },
    /// Negation/compound guard before any inference.
    Refused,
    /// The model would be consulted with these offered actions.
    Grounded {
        candidates: Vec<Value>,
    },
    /// No grounded candidate: "couldn't determine a safe local action".
    Uncertain,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Target {
    None,
    Workspace(String, Resolved),
    Thread(String, Resolved),
    Providers(Vec<String>),
}

fn intent_json(intent: &KalVoiceIntent) -> Value {
    serde_json::to_value(intent).unwrap()
}

fn run_pipeline(text: &str, world: &World, proposed: bool) -> Stage {
    let stage = run_once(text, world, proposed);
    if !proposed || !matches!(stage, Stage::Grounded { .. } | Stage::Uncertain) {
        return stage;
    }
    // PROPOSED (0.1.5): a second deterministic chance for fall-throughs only. The original
    // text already passed the negation/compound guard (a refusal returns above), and a request
    // the grammar understood is never rewritten, so existing fast-path results cannot change.
    match normalize_proposed(text) {
        Some(rewritten) if rewritten != text => match run_once(&rewritten, world, proposed) {
            s @ (Stage::Fast { .. } | Stage::Rejected { .. }) => s,
            _ => stage,
        },
        _ => stage,
    }
}

/// PRODUCT (0.1.5 as shipped): the grammar already includes the second chance (P2), so no
/// harness rewrite runs; thread targets use the strict resolution the session resolver enforces
/// (P3); session commands are scored by what the desktop executor does with them in this
/// fixture world, where no thread is focused and no thread carries a state.
fn run_product(text: &str, world: &World) -> Stage {
    match run_once(text, world, true) {
        Stage::Fast { intent, target } => session_effect(intent, target, world),
        other => other,
    }
}

fn session_effect(intent: Value, target: Target, world: &World) -> Stage {
    match intent["kind"].as_str() {
        // Nothing is focused in the fixture: "Click a thread first".
        Some("submit_focused" | "clear_focused") => Stage::Rejected {
            code: "thread_not_focused",
        },
        Some("direct_prompt") => {
            let name = intent["target"].as_str().unwrap_or_default().to_owned();
            // A prompt goes direct only to an exact name; a partial name is confirmed first.
            let exact = world
                .threads
                .iter()
                .any(|t| t.name.eq_ignore_ascii_case(name.trim_start_matches("my ")));
            match world.resolve_thread_strict(&name) {
                Resolved::Id(_) if !exact => Stage::Rejected {
                    code: "target_unconfirmed",
                },
                Resolved::Id(id) => Stage::Fast {
                    intent,
                    target: Target::Thread(name, Resolved::Id(id)),
                },
                Resolved::Ambiguous => Stage::Rejected {
                    code: "target_ambiguous",
                },
                Resolved::NotFound => Stage::Rejected {
                    code: "thread_not_found",
                },
            }
        }
        // No fixture thread is failed, stuck or waiting: "No thread has failed."
        Some("focus_by_state") => Stage::Rejected {
            code: "session_not_found",
        },
        // The readback's visible part: the approvals panel or the Dashboard filter.
        Some("which_sessions") => Stage::Fast {
            intent: match intent["state"].as_str() {
                Some("waiting_for_permission") => json!({ "kind": "show_approvals" }),
                Some("stuck") => intent,
                _ => json!({ "kind": "filter_dashboard", "chip": "waiting_for_you" }),
            },
            target: Target::None,
        },
        // "Focus on that" / "open it" with nothing focused and nothing remembered.
        Some("focus" | "open_thread")
            if matches!(
                intent["query"].as_str(),
                Some("it" | "this" | "that" | "this one" | "that one" | "there")
            ) =>
        {
            Stage::Rejected {
                code: "target_unclear",
            }
        }
        // Destructive commands never act on a partial name (session resolver, P3).
        Some("pause_threads" | "resume_threads" | "stop_threads")
            if matches!(&target, Target::Thread(name, Resolved::Id(_))
                if !world.threads.iter().any(|t| t.name.eq_ignore_ascii_case(name.trim_start_matches("my ")))) =>
        {
            Stage::Rejected {
                code: "target_unconfirmed",
            }
        }
        _ => Stage::Fast { intent, target },
    }
}

fn run_once(text: &str, world: &World, strict: bool) -> Stage {
    let stage = run_grammar(text, world, strict);
    // A target that is ambiguous fails with a clarification (the executor already does this
    // for workspaces; strict mode extends it to threads).
    if let Stage::Fast {
        target: Target::Workspace(_, Resolved::Ambiguous) | Target::Thread(_, Resolved::Ambiguous),
        ..
    } = stage
    {
        return Stage::Rejected {
            code: "target_ambiguous",
        };
    }
    stage
}

fn run_grammar(text: &str, world: &World, strict: bool) -> Stage {
    match grammar::understand(text) {
        Understood::Rejected { code, .. } => Stage::Rejected { code },
        Understood::Intent {
            intent: KalVoiceIntent::Reasoning { .. },
            ..
        } => {
            if grammar::local_reasoning_must_refuse(text) {
                return Stage::Refused;
            }
            let request = LocalInterpretationRequest {
                request: text.to_owned(),
                workspace_id: None,
                workspaces: world.workspaces.clone(),
            };
            let candidates: Vec<Value> = grounded_action_candidates(&request)
                .into_iter()
                .map(|c| intent_json(&c.intent))
                .collect();
            if candidates.is_empty() {
                Stage::Uncertain
            } else {
                Stage::Grounded { candidates }
            }
        }
        Understood::Intent { intent, target } => {
            let json = intent_json(&intent);
            let target = match target {
                None => implicit_target_with(&json, world, strict),
                Some(NamedTarget::Workspace(name)) => {
                    let r = world.resolve_actual(&name, false, strict);
                    Target::Workspace(name, r)
                }
                Some(NamedTarget::Thread(name)) => {
                    let r = world.resolve_actual(&name, true, strict);
                    Target::Thread(name, r)
                }
                Some(NamedTarget::Providers(p)) => {
                    Target::Providers(p.iter().map(|p| p.as_str().to_owned()).collect())
                }
            };
            Stage::Fast {
                intent: json,
                target,
            }
        }
    }
}

/// `open_workspace` / `open_thread` carry their name in `query`; the executor resolves it.
fn implicit_target(intent: &Value, world: &World) -> Target {
    implicit_target_with(intent, world, false)
}

fn implicit_target_with(intent: &Value, world: &World, strict: bool) -> Target {
    match intent["kind"].as_str() {
        Some("open_workspace") => {
            let q = intent["query"].as_str().unwrap_or_default().to_owned();
            let r = world.resolve(&q, false);
            Target::Workspace(q, r)
        }
        Some("open_thread") => {
            let q = intent["query"].as_str().unwrap_or_default().to_owned();
            let r = world.resolve_actual(&q, true, strict);
            Target::Thread(q, r)
        }
        // The executor resolves the thread before asking for the mode change.
        Some("request_permission_mode") if intent["threadQuery"].is_string() => {
            let q = intent["threadQuery"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            let r = world.resolve_actual(&q, true, strict);
            Target::Thread(q, r)
        }
        _ => Target::None,
    }
}

// ---------------------------------------------------------------------------------------------
// Scoring

/// Every key in `expected` equals the value in `actual` (recursively; arrays element-wise).
fn subset(expected: &Value, actual: &Value) -> bool {
    match (expected, actual) {
        (Value::Object(e), Value::Object(a)) => e.iter().all(|(k, ev)| {
            if k == "_target" {
                return true;
            }
            a.get(k).is_some_and(|av| subset(ev, av))
        }),
        (Value::Array(e), Value::Array(a)) => {
            e.len() == a.len() && e.iter().zip(a).all(|(ev, av)| subset(ev, av))
        }
        (Value::Null, Value::Null) => true,
        (Value::Null, _) => false,
        (e, a) => e == a,
    }
}

fn expected_target(option: &Value, world: &World) -> Target {
    let Some(t) = option.get("_target") else {
        return Target::None;
    };
    if let Some(ws) = t.get("workspace").and_then(Value::as_str) {
        return Target::Workspace(ws.to_owned(), world.resolve(ws, false));
    }
    if let Some(th) = t.get("thread").and_then(Value::as_str) {
        return Target::Thread(th.to_owned(), world.resolve(th, true));
    }
    if let Some(p) = t.get("providers").and_then(Value::as_array) {
        return Target::Providers(p.iter().map(|v| v.as_str().unwrap().to_owned()).collect());
    }
    Target::None
}

fn target_matches(expected: &Target, actual: &Target) -> bool {
    match (expected, actual) {
        (Target::None, Target::None) => true,
        (Target::Workspace(_, e), Target::Workspace(_, a))
        | (Target::Thread(_, e), Target::Thread(_, a)) => matches!(e, Resolved::Id(_)) && e == a,
        (Target::Providers(e), Target::Providers(a)) => e == a,
        _ => false,
    }
}

/// Did an executed command act on something other than what the user meant?
fn target_resolves_to_real_entity(target: &Target) -> bool {
    match target {
        Target::Workspace(_, r) | Target::Thread(_, r) => matches!(r, Resolved::Id(_)),
        _ => true,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Verdict {
    /// Deterministic fast path ran the right action with the right arguments.
    CorrectFast,
    /// Correct only if the on-device selector picks the right offered candidate.
    CorrectViaModel,
    /// Right action kind, wrong/garbled argument that fails closed (not found / ambiguous).
    WrongArgsFailsClosed,
    /// Right action kind, argument resolves to a DIFFERENT real entity (unsafe).
    WrongTargetExecuted,
    /// Right action kind executed with a wrong non-target argument (count, query, axis…).
    WrongArgsExecuted,
    /// Wrong action kind executed (unsafe incorrect execution).
    WrongActionExecuted,
    /// Executed something when the user should have been asked / refused (unsafe).
    UnwantedExecution,
    /// Executed with a target that fails to resolve (fails closed, but it tried).
    UnwantedAttemptFailsClosed,
    /// A specific clarification/refusal message ("Say which provider…", "bypass not allowed").
    Clarified,
    /// Correctly did nothing (negation/compound guard, uncertain) where nothing was wanted.
    CorrectlyDeclined,
    /// Declined with a generic "couldn't determine a safe local action" where a specific
    /// clarification was the better answer (safe, unhelpful).
    DeclinedGeneric,
    /// Model consulted for something that should be refused or clarified (depends on model).
    ModelRisk,
    /// Understood nothing for a real command (safe miss; user must rephrase).
    Miss,
}

impl Verdict {
    fn name(self) -> &'static str {
        match self {
            Self::CorrectFast => "correct_fast",
            Self::CorrectViaModel => "correct_via_model",
            Self::WrongArgsFailsClosed => "wrong_args_fails_closed",
            Self::WrongTargetExecuted => "wrong_target_executed",
            Self::WrongArgsExecuted => "wrong_args_executed",
            Self::WrongActionExecuted => "wrong_action_executed",
            Self::UnwantedExecution => "unwanted_execution",
            Self::UnwantedAttemptFailsClosed => "unwanted_attempt_fails_closed",
            Self::Clarified => "clarified",
            Self::CorrectlyDeclined => "correctly_declined",
            Self::DeclinedGeneric => "declined_generic",
            Self::ModelRisk => "model_risk",
            Self::Miss => "miss",
        }
    }
    fn acceptable(self) -> bool {
        matches!(
            self,
            Self::CorrectFast | Self::CorrectViaModel | Self::Clarified | Self::CorrectlyDeclined
        )
    }
    fn unsafe_(self) -> bool {
        matches!(
            self,
            Self::WrongTargetExecuted
                | Self::WrongArgsExecuted
                | Self::WrongActionExecuted
                | Self::UnwantedExecution
        )
    }
}

fn score(expect: &[Value], stage: &Stage, world: &World) -> Verdict {
    let intents: Vec<&Value> = expect.iter().filter(|v| v.is_object()).collect();
    let wants_clarify = expect.iter().any(|v| v == "clarify");
    let wants_none = expect.iter().any(|v| v == "none");
    let matches_option = |actual: &Value, target: &Target| {
        intents
            .iter()
            .any(|opt| subset(opt, actual) && target_matches(&expected_target(opt, world), target))
    };
    match stage {
        Stage::Fast { intent, target } => {
            if matches_option(intent, target) {
                return Verdict::CorrectFast;
            }
            let same_kind = intents.iter().any(|o| o["kind"] == intent["kind"]);
            if same_kind {
                return if target_resolves_to_real_entity(target) {
                    // Kind matched; either a wrong argument or a different real target.
                    match target {
                        Target::Workspace(..) | Target::Thread(..) => Verdict::WrongTargetExecuted,
                        _ => Verdict::WrongArgsExecuted,
                    }
                } else {
                    Verdict::WrongArgsFailsClosed
                };
            }
            if !intents.is_empty() {
                return if target_resolves_to_real_entity(target) {
                    Verdict::WrongActionExecuted
                } else {
                    Verdict::WrongArgsFailsClosed
                };
            }
            if target_resolves_to_real_entity(target) {
                Verdict::UnwantedExecution
            } else {
                Verdict::UnwantedAttemptFailsClosed
            }
        }
        Stage::Grounded { candidates } => {
            if candidates
                .iter()
                .any(|c| matches_option(c, &implicit_target(c, world)))
            {
                Verdict::CorrectViaModel
            } else if intents.is_empty() {
                Verdict::ModelRisk
            } else {
                Verdict::Miss
            }
        }
        Stage::Rejected { .. } => {
            if wants_clarify || wants_none {
                Verdict::Clarified
            } else {
                Verdict::Miss
            }
        }
        Stage::Refused | Stage::Uncertain => {
            if wants_none {
                Verdict::CorrectlyDeclined
            } else if wants_clarify {
                Verdict::DeclinedGeneric
            } else {
                Verdict::Miss
            }
        }
    }
}

fn stage_summary(stage: &Stage) -> Value {
    match stage {
        Stage::Fast { intent, target } => json!({
            "stage": "fast",
            "intent": intent,
            "target": format!("{target:?}"),
        }),
        Stage::Rejected { code } => json!({ "stage": "rejected", "code": code }),
        Stage::Refused => json!({ "stage": "refused" }),
        Stage::Grounded { candidates } => json!({ "stage": "model", "candidates": candidates }),
        Stage::Uncertain => json!({ "stage": "uncertain" }),
    }
}

fn percentiles(values: &mut [f64]) -> Value {
    values.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p = |q: f64| {
        let i = ((values.len() as f64 - 1.0) * q).round() as usize;
        (values[i] * 1000.0).round() / 1000.0
    };
    json!({ "n": values.len(), "p50": p(0.50), "p95": p(0.95), "p99": p(0.99), "max": p(1.0) })
}

// ---------------------------------------------------------------------------------------------
// PROPOSED 0.1.5 normalization (simulated here; nothing in product uses it).
//
// Rules only ever run on a request the grammar did NOT understand and the negation/compound
// guard did NOT refuse. Anchored (start-of-utterance) rewrites may produce any intent;
// unanchored "contains" rewrites only produce read-only intents (navigate, status, approvals,
// dashboard filters). Output is re-parsed by the unchanged grammar, so every existing guard,
// count limit and target resolution still applies.

const DISFLUENCY: &[&str] = &[
    "um",
    "uh",
    "er",
    "erm",
    "hmm",
    "so",
    "well",
    "okay so",
    "ok so",
    "alright",
    "all right",
];

fn words_of(text: &str) -> String {
    let lowered = text.to_lowercase().replace(['\u{2019}', '\u{2018}'], "'");
    let cleaned: String = lowered
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '\'' || c == '-' {
                c
            } else {
                ' '
            }
        })
        .collect();
    let mut out = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    for (from, to) in [
        ("what's", "what is"),
        ("whats", "what is"),
        ("who's", "who is"),
        ("how's", "how is"),
        ("that's", "that is"),
        ("let's", "let us"),
        ("i'd", "i would"),
        ("i'm", "i am"),
        ("where's", "where is"),
        ("everything's", "everything is"),
    ] {
        out = format!(" {out} ")
            .replace(&format!(" {from} "), &format!(" {to} "))
            .trim()
            .to_owned();
    }
    out
}

fn strip_prefix_words<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    if s == prefix {
        return Some("");
    }
    s.strip_prefix(prefix).and_then(|r| r.strip_prefix(' '))
}

fn normalize_proposed(text: &str) -> Option<String> {
    if text.contains("://") {
        return None;
    }
    let mut s = words_of(text);
    // 1. Disfluencies (leading, and "uh"/"um" anywhere).
    loop {
        let before = s.clone();
        for d in DISFLUENCY {
            if let Some(rest) = strip_prefix_words(&s, d)
                && !rest.is_empty()
            {
                s = rest.to_owned();
            }
        }
        if s == before {
            break;
        }
    }
    for d in [" uh ", " um ", " er "] {
        s = format!(" {s} ").replace(d, " ").trim().to_owned();
    }
    // 2. Speech-recognition vocabulary (closed list of KalCode names).
    let mut padded = format!(" {s} ");
    for (from, to) in [
        (" local host ", " localhost "),
        (" localhost colon ", " localhost "),
        (" dash board ", " dashboard "),
        (" cal voice ", " kalvoice "),
        (" kal voice ", " kalvoice "),
        (" cloud code ", " claude code "),
        (" clawed ", " claude "),
        (" clod ", " claude "),
        (" jemini ", " gemini "),
        (" code decks ", " codex "),
    ] {
        padded = padded.replace(from, to);
    }
    let provider_context = [
        " codex ",
        " gemini ",
        " thread ",
        " threads ",
        " agent ",
        " agents ",
        " pane ",
        " panes ",
    ]
    .iter()
    .any(|w| padded.contains(w));
    if provider_context {
        padded = padded.replace(" cloud ", " claude ");
    }
    s = padded.trim().to_owned();
    // The grammar strips a trailing "kalvoice" as a wake word; name the surface another way.
    for verb in ["to", "open", "show"] {
        if let Some(head) = s.strip_suffix(&format!("{verb} kalvoice")) {
            s = format!("{head}{verb} voice");
        }
    }
    // Politeness the grammar would strip anyway, so anchored rules see the verb.
    for p in [
        "can you ",
        "could you ",
        "would you ",
        "please ",
        "hey kalvoice ",
        "hey ",
    ] {
        if let Some(rest) = s.strip_prefix(p) {
            s = rest.to_owned();
        }
    }

    // 3. Anchored verb-phrase canonicalization.
    const ANCHORED: &[(&str, &str)] = &[
        ("take me back to", "go to"),
        ("take me over to", "go to"),
        ("take me to", "go to"),
        ("bring me back to", "go to"),
        ("bring me to", "go to"),
        ("head over to", "go to"),
        ("head to", "go to"),
        ("jump over to", "go to"),
        ("get me to", "go to"),
        ("go back to", "go to"),
        ("back to", "go to"),
        ("return to", "go to"),
        ("put me in", "go to"),
        ("i want to see", "show me"),
        ("i would like to see", "show me"),
        ("let me see", "show me"),
        ("pull up", "show"),
        ("bring up", "show"),
        ("open up", "open"),
        ("switch over to", "switch to"),
        ("freeze", "pause"),
        ("keep going with", "resume"),
        ("filter to", "show"),
        ("find anything about", "search for"),
        ("find everything about", "search for"),
        ("make me", "open"),
        ("i would like a", "open a"),
        ("i want a", "open a"),
        ("can i get", "give me"),
        ("can i have", "give me"),
        ("get rid of", "close"),
        ("i need", "open"),
    ];
    for (from, to) in ANCHORED {
        if let Some(rest) = strip_prefix_words(&s, from) {
            s = format!("{to} {rest}").trim().to_owned();
            break;
        }
    }
    // "where is/are [my|the] X" -> "go to X"
    for p in ["where is ", "where are "] {
        if let Some(rest) = s.strip_prefix(p) {
            s = format!("go to {rest}");
        }
    }
    // Browser phrasing.
    for (from, to) in [
        ("go to the browser", "open the browser"),
        ("show me the browser", "open the browser"),
        ("show the browser", "open the browser"),
        ("go to browser", "open the browser"),
        ("refresh the browser", "reload the browser"),
        ("go back a page", "go back"),
        ("go back one page", "go back"),
        ("open a new browser pane", "open new browser pane"),
        ("open a new browser", "open new browser"),
        ("open another browser tab", "open another browser"),
    ] {
        if s == from {
            s = to.to_owned();
        }
    }
    if let Some(rest) = s.strip_prefix("open the browser to ") {
        s = format!("open {rest}");
    }
    // Thread control qualifiers: "pause everything that is currently running" -> "pause everything".
    let control = ["pause ", "stop ", "resume ", "hold ", "kill ", "cancel "]
        .iter()
        .any(|v| s.starts_with(v));
    if control {
        for tail in [
            " that is currently running",
            " that is running",
            " currently running",
            " that are running",
            " that are currently running",
            " right now",
        ] {
            if let Some(head) = s.strip_suffix(tail) {
                s = head.to_owned();
            }
        }
        s = s.replacen(" everything in ", " all threads in ", 1);
    }
    for (from, to) in [
        ("put everything on hold", "pause everything"),
        ("shut everything down", "stop everything"),
        ("shut it all down", "stop everything"),
        ("start everything back up", "resume everything"),
        ("make it bigger", "make this pane bigger"),
        ("make it smaller", "make this pane smaller"),
    ] {
        if s == from {
            s = to.to_owned();
        }
    }
    // Creation phrasing: "let us get a codex thread going" -> "start a codex thread".
    if let Some(mid) = s
        .strip_prefix("let us get ")
        .and_then(|r| r.strip_suffix(" going"))
    {
        s = format!("start {mid}");
    }
    // Workspace/thread naming.
    s = s
        .replacen(" thread called ", " thread ", 1)
        .replacen(" thread named ", " thread ", 1);
    if (s.starts_with("show me the ") || s.starts_with("show the "))
        && (s.ends_with(" workspace") || s.ends_with(" project"))
    {
        s = s
            .replacen("show me the ", "open the ", 1)
            .replacen("show the ", "open the ", 1);
    }
    if let Some(rest) = s
        .strip_prefix("go to the ")
        .filter(|r| r.ends_with(" thread"))
    {
        s = format!("open the {rest}");
    }
    // Switch provider: "use gemini from now on".
    if let Some(p) = s
        .strip_prefix("use ")
        .and_then(|r| r.strip_suffix(" from now on"))
    {
        s = format!("switch to {p}");
    }
    // Recent work.
    if let Some(when) = s.strip_prefix("show me what i worked on ") {
        s = format!("what did i work on {when}");
    }

    // 4. Unanchored read-only rewrites (whole request -> one read-only command).
    if s.contains("what all my") || s.contains("what all the") {
        s = s
            .replace("what all my", "what my")
            .replace("what all the", "what the");
    }
    let has = |needles: &[&str]| needles.iter().any(|n| s.contains(n));
    let short = s.split(' ').count() <= 10;
    if short {
        if has(&[
            "needs permission",
            "need permission",
            "blocked on me",
            "approve anything",
            "approval queue",
            "waiting for approval",
            "waiting on approval",
            "waiting on me",
            "waiting for me",
            "who is waiting",
            "what is pending",
            "anything pending",
            "need my attention",
            "needs my attention",
            "need my approval",
        ]) && !s.starts_with("show only")
            && !s.starts_with("only")
        {
            return Some("show approvals".into());
        }
        if has(&[
            "what is the status",
            "how is everything",
            "how is it going",
            "update on my",
            "what is everybody",
            "what is everyone",
            "summarize what",
            "status of everything",
            "how are things",
            "any agents still running",
            "anything still running",
        ]) {
            return Some("status report".into());
        }
        if (s.starts_with("which ") || s.starts_with("what "))
            && has(&["agents", "threads", "sessions"])
        {
            for (state, chip) in [
                (" done", "completed"),
                (" finished", "completed"),
                (" completed", "completed"),
                (" idle", "idle"),
            ] {
                if s.ends_with(state) {
                    return Some(format!("show {chip} agents"));
                }
            }
        }
    }
    Some(s)
}

// ---------------------------------------------------------------------------------------------
// Scoring loop

struct Scored {
    summary: Value,
    totals: BTreeMap<&'static str, usize>,
    details: Vec<Value>,
    routing: Value,
}

/// PROPOSED 0.1.5 routing guard: a fall-through that starts like a KalCode command and names a
/// KalCode noun is held ("Did you mean…?" / inserted without Enter) instead of being
/// auto-submitted as a provider prompt.
fn command_shaped(text: &str) -> bool {
    let s = words_of(text);
    let verb = [
        "open",
        "show",
        "go",
        "take",
        "bring",
        "pause",
        "stop",
        "resume",
        "kill",
        "close",
        "switch",
        "start",
        "launch",
        "spin",
        "split",
        "focus",
        "search",
        "find",
        "pull",
        "freeze",
        "cancel",
        "halt",
        "unpause",
        "hold",
        "put",
        "make",
        "head",
        "jump",
        "back",
        "return",
        "let",
        "give",
        "can",
        "could",
        "please",
        "hey",
        "which",
        "what",
        "how",
        "where",
        "who",
        "is",
        "are",
        "do",
        "does",
        "anything",
        "i",
        "shut",
        "keep",
        "summarize",
        "refresh",
        "reload",
        "filter",
        "get",
        "use",
    ];
    let noun = [
        "thread",
        "threads",
        "agent",
        "agents",
        "pane",
        "panes",
        "workspace",
        "project",
        "settings",
        "dashboard",
        "approvals",
        "approval",
        "permission",
        "browser",
        "terminal",
        "everything",
        "providers",
        "provider",
        "status",
        "kalvoice",
        "codex",
        "claude",
        "gemini",
        "page",
    ];
    let words: Vec<&str> = s.split(' ').collect();
    words.first().is_some_and(|w| verb.contains(w))
        && words.len() <= 12
        && words.iter().any(|w| noun.contains(w))
}

fn is_reasoning(understood: &Understood) -> bool {
    matches!(
        understood,
        Understood::Intent {
            intent: KalVoiceIntent::Reasoning { .. },
            ..
        }
    )
}

fn score_corpus(cases: &[Value], world: &World, proposed: bool) -> Scored {
    score_corpus_mode(cases, world, proposed, false)
}

fn score_corpus_mode(cases: &[Value], world: &World, proposed: bool, product: bool) -> Scored {
    let mut by_cat: BTreeMap<String, BTreeMap<&'static str, usize>> = BTreeMap::new();
    let mut totals: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut details = Vec::new();
    let (mut intended, mut dict_terminal, mut after_guard, mut guard_held_nonintent) =
        (0usize, 0usize, 0usize, 0usize);
    for case in cases {
        let id = case["id"].as_str().unwrap();
        let cat = case["cat"].as_str().unwrap().to_owned();
        let text = case["text"].as_str().unwrap();
        let expect = case["expect"].as_array().unwrap();
        let stage = if product {
            run_product(text, world)
        } else {
            run_pipeline(text, world, proposed)
        };
        let verdict = score(expect, &stage, world);

        // Routing when a terminal/provider pane has focus: production dictates (and, for a
        // provider pane, auto-submits with "\r") anything that is not a command-like grammar
        // result with high confidence. In the proposed mode a normalized fall-through that
        // became a command routes as a command.
        let baseline_command = talk_route(text, TalkTarget::Terminal) == TalkRoute::Command;
        let command_now = if proposed {
            baseline_command
                || (is_reasoning(&grammar::understand(text))
                    && matches!(stage, Stage::Fast { .. } | Stage::Rejected { .. }))
        } else {
            baseline_command
        };
        // The product routes command-shaped fall-throughs away from a terminal itself (P1).
        let dictated = if product {
            talk_route(text, TalkTarget::Terminal) == TalkRoute::Dictation
        } else {
            !command_now
        };
        let wants_intent = expect.iter().any(Value::is_object);
        if wants_intent {
            intended += 1;
            if dictated {
                dict_terminal += 1;
                if product || !command_shaped(text) {
                    after_guard += 1;
                }
            }
        } else if !product && dictated && command_shaped(text) {
            guard_held_nonintent += 1;
        }
        let counts = by_cat.entry(cat.clone()).or_default();
        *counts.entry(verdict.name()).or_default() += 1;
        *counts.entry("n").or_default() += 1;
        *totals.entry(verdict.name()).or_default() += 1;
        *totals.entry("n").or_default() += 1;
        details.push(json!({
            "id": id, "cat": cat, "text": text, "verdict": verdict.name(),
            "acceptable": verdict.acceptable(), "unsafe": verdict.unsafe_(),
            "rewritten": if proposed { normalize_proposed(text).map_or(Value::Null, Value::from) } else { Value::Null },
            "dictated_if_terminal_focused": dictated,
            "result": stage_summary(&stage),
        }));
    }
    let mut summary = BTreeMap::new();
    for (cat, counts) in &by_cat {
        let get = |k: &str| counts.get(k).copied().unwrap_or(0);
        summary.insert(
            cat.clone(),
            json!({
                "n": get("n"),
                "acceptable": get("correct_fast") + get("correct_via_model") + get("clarified") + get("correctly_declined"),
                "fast_correct": get("correct_fast"),
                "model_correct": get("correct_via_model"),
                "clarified": get("clarified"),
                "declined_generic": get("declined_generic"),
                "miss": get("miss") + get("wrong_args_fails_closed"),
                "unsafe": get("wrong_target_executed") + get("wrong_args_executed") + get("wrong_action_executed") + get("unwanted_execution"),
            }),
        );
    }
    Scored {
        summary: json!(summary),
        totals,
        details,
        routing: json!({
            "command_intended_cases": intended,
            "dictated_or_submitted_when_terminal_focused": dict_terminal,
            "still_submitted_with_command_shaped_guard": after_guard,
            "non_command_cases_held_by_guard": guard_held_nonintent,
        }),
    }
}

#[test]
fn understanding_bench() {
    // Cold: first grammar call in this process compiles the rule table (OnceLock).
    let cold_started = Instant::now();
    let _ = grammar::understand("open settings");
    let cold_rules_ms = cold_started.elapsed().as_secs_f64() * 1000.0;
    let cold_and_started = Instant::now();
    let _ = grammar::understand("split claude and codex side by side");
    let cold_and_rules_ms = cold_and_started.elapsed().as_secs_f64() * 1000.0;

    let corpus: Value = serde_json::from_str(CORPUS).expect("corpus.json parses");
    let holdout: Value = serde_json::from_str(HOLDOUT).expect("holdout.json parses");
    let world = World::load(&corpus["fixture"]);
    let cases = corpus["cases"].as_array().unwrap();
    let holdout_cases = holdout["cases"].as_array().unwrap();
    assert!(cases.len() >= 300, "corpus has {} cases", cases.len());

    let baseline = score_corpus(cases, &world, false);
    let proposed = score_corpus(cases, &world, true);
    let holdout_baseline = score_corpus(holdout_cases, &world, false);
    let holdout_proposed = score_corpus(holdout_cases, &world, true);
    let product = score_corpus_mode(cases, &world, false, true);
    let holdout_product = score_corpus_mode(holdout_cases, &world, false, true);

    // Timing: the deterministic work production does per utterance.
    let mut understand_ms = Vec::new();
    let mut production_path_ms = Vec::new();
    let mut fallthrough_prep_ms = Vec::new();
    let mut normalize_ms = Vec::new();
    let mut thread_picks = Vec::new();
    for case in cases {
        let text = case["text"].as_str().unwrap();
        if let Stage::Fast {
            target: Target::Thread(name, Resolved::Id(_)),
            ..
        } = run_pipeline(text, &world, false)
            && world.thread_matches(&name) > 1
        {
            thread_picks.push(
                json!({ "id": case["id"], "query": name, "matches": world.thread_matches(&name) }),
            );
        }
        for _ in 0..TIMING_ITERATIONS {
            let t = Instant::now();
            let r = grammar::understand_with_confidence(text);
            understand_ms.push(t.elapsed().as_secs_f64() * 1000.0);
            std::hint::black_box(r);

            // talk_route (1x understand) + handle_with_stages (1x understand) + fall-through
            // guard/grounding when it applies.
            let t = Instant::now();
            let route = talk_route(text, TalkTarget::None);
            let understood = grammar::understand(text);
            if is_reasoning(&understood) {
                let tp = Instant::now();
                let refuse = grammar::local_reasoning_must_refuse(text);
                let c = if refuse {
                    Vec::new()
                } else {
                    grounded_action_candidates(&LocalInterpretationRequest {
                        request: text.to_owned(),
                        workspace_id: None,
                        workspaces: world.workspaces.clone(),
                    })
                };
                std::hint::black_box(c);
                fallthrough_prep_ms.push(tp.elapsed().as_secs_f64() * 1000.0);
                let tn = Instant::now();
                let n = normalize_proposed(text).map(|n| grammar::understand(&n));
                std::hint::black_box(n);
                normalize_ms.push(tn.elapsed().as_secs_f64() * 1000.0);
            }
            production_path_ms.push(t.elapsed().as_secs_f64() * 1000.0);
            std::hint::black_box((route, understood));
        }
    }

    let results = json!({
        "corpus_cases": cases.len(),
        "holdout_cases": holdout_cases.len(),
        "timing_iterations_per_case": TIMING_ITERATIONS,
        "build_profile": if cfg!(debug_assertions) { "debug" } else { "release" },
        "cold_rule_table_ms": cold_rules_ms,
        "cold_and_rule_table_ms": cold_and_rules_ms,
        "understand_ms": percentiles(&mut understand_ms),
        "production_deterministic_path_ms": percentiles(&mut production_path_ms),
        "fallthrough_guard_and_grounding_ms": percentiles(&mut fallthrough_prep_ms),
        "proposed_normalize_and_reparse_ms": percentiles(&mut normalize_ms),
        "baseline": { "summary": baseline.summary, "totals": baseline.totals, "routing": baseline.routing },
        "proposed": { "summary": proposed.summary, "totals": proposed.totals, "routing": proposed.routing },
        "holdout_baseline": { "summary": holdout_baseline.summary, "totals": holdout_baseline.totals, "routing": holdout_baseline.routing },
        "holdout_proposed": { "summary": holdout_proposed.summary, "totals": holdout_proposed.totals, "routing": holdout_proposed.routing },
        "product": { "summary": product.summary, "totals": product.totals, "routing": product.routing },
        "holdout_product": { "summary": holdout_product.summary, "totals": holdout_product.totals, "routing": holdout_product.routing },
        "thread_target_picked_one_of_several": thread_picks,
        "cases_baseline": baseline.details,
        "cases_proposed": proposed.details,
        "cases_holdout_baseline": holdout_baseline.details,
        "cases_holdout_proposed": holdout_proposed.details,
        "cases_product": product.details,
        "cases_holdout_product": holdout_product.details,
    });
    let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/kalvoice-understanding-results.json");
    std::fs::create_dir_all(out.parent().unwrap()).unwrap();
    std::fs::write(&out, serde_json::to_string_pretty(&results).unwrap()).unwrap();

    println!(
        "KALVOICE UNDERSTANDING BASELINE ({} cases, {} holdout)",
        cases.len(),
        holdout_cases.len()
    );
    for key in [
        "baseline",
        "proposed",
        "holdout_baseline",
        "holdout_proposed",
        "product",
        "holdout_product",
    ] {
        println!("== {key}");
        println!(
            "{}",
            serde_json::to_string(&results[key]["summary"]).unwrap()
        );
        println!(
            "totals: {}",
            serde_json::to_string(&results[key]["totals"]).unwrap()
        );
        println!(
            "routing: {}",
            serde_json::to_string(&results[key]["routing"]).unwrap()
        );
    }
    println!(
        "timing ({}): cold {:.3} ms, understand {}, production path {}, fallthrough prep {}, proposed normalize {}",
        results["build_profile"],
        cold_rules_ms,
        results["understand_ms"],
        results["production_deterministic_path_ms"],
        results["fallthrough_guard_and_grounding_ms"],
        results["proposed_normalize_and_reparse_ms"],
    );
    println!("results: {}", out.display());
}
