//! The session resolver (0.1.5, terminal-aware KalVoice): one deterministic answer to "which
//! session does this name mean?" for KalVoice, the command palette and the Dashboard.
//!
//! Pure over the thread store listing (`ThreadRuntime::list`, most recent first). It never uses
//! the Session Locator (a gated surface) and never guesses: the first tier that finds anything
//! decides, and more than one fit is answered with a clarification naming the choices by the
//! first thing that tells them apart. Tiers, in order:
//!
//! 1. an explicit thread id;
//! 2. the exact name in the workspace the person is looking at;
//! 3. the exact name in any workspace;
//! 4. provider and/or account words plus the name ("Gemini B Research", "Claude Backend");
//! 5. "this / that / it": the focused thread, else the last resolved target;
//! 6. only provider and/or account words ("ask Codex"), current workspace first;
//! 7. a locating phrase matched against bounded, owner-visible live task context;
//! 8. bounded fuzzy (a word-start fragment, then one or two typos) — resolved only when exactly
//!    one session fits.
//!
//! Archived threads never match. Names are compared case-insensitively with Latin diacritics
//! folded ("cafe" finds "Café") and punctuation treated as spaces. The mirror used by the
//! in-memory test transport is `apps/desktop/src/ipc/memory/sessionResolve.ts`; both are
//! checked against `session_resolver_cases.json`.

use kalcode_contracts::sessions::{
    MAX_SESSION_CHOICES, MAX_SESSION_QUERY_CHARS, SessionCandidate, SessionMatchTier,
    SessionResolution,
};
use kalcode_contracts::threads::{ThreadRuntimeKind, ThreadSummary};

/// Product nouns constrain the runtime before names or task context are matched.
/// Provider names alone do not prove that a session is a coding terminal.
pub fn matches_requested_runtime(thread: &ThreadSummary, query: &str) -> bool {
    let coding = normalize(query)
        .split_whitespace()
        .any(|word| matches!(word, "agent" | "agents" | "terminal" | "terminals"));
    !coding || thread.runtime_kind == Some(ThreadRuntimeKind::InteractivePty)
}

/// What the person is looking at when they name a session.
#[derive(Debug, Clone, Copy, Default)]
pub struct ResolveContext<'a> {
    /// The workspace in front (exact names there win over the same name elsewhere).
    pub workspace_id: Option<&'a str>,
    /// The thread in front ("this", "it").
    pub focused_thread_id: Option<&'a str>,
    /// The session the previous command resolved to ("it" when nothing is focused).
    pub last_target_id: Option<&'a str>,
}

/// Words that mean "the session I'm on".
const PRONOUNS: &[&str] = &[
    "this",
    "that",
    "it",
    "here",
    "this one",
    "that one",
    "this thread",
    "that thread",
    "this session",
    "that session",
    "current thread",
    "the current thread",
    "current session",
    "the current session",
];

/// Whether `query` only points at a session ("it", "that one") rather than naming one.
pub fn is_pronoun(query: &str) -> bool {
    PRONOUNS.contains(&normalize(query).as_str())
}

/// Leading words dropped from a query ("the Authentication thread").
const LEADING_FILLER: &[&str] = &["the", "my", "our"];
/// Trailing words dropped from a query ("the Authentication thread").
const TRAILING_FILLER: &[&str] = &[
    "thread",
    "session",
    "terminal",
    "agent",
    "chat",
    "conversation",
    "pane",
    "tab",
    "one",
];
/// Words ignored in the provider/account part of a query ("Research on my Gemini B account").
const QUALIFIER_FILLER: &[&str] = &[
    "the", "my", "our", "on", "in", "using", "with", "from", "for", "of", "s", "account", "thread",
    "threads", "session", "agent", "one", "pane", "terminal",
];

/// Words that express the locate action rather than identify a session. Task matching is only
/// entered for an explicit locating phrase, and every remaining word must match owner-visible
/// structured scene metadata.
const TASK_FILLER: &[&str] = &[
    "the",
    "my",
    "our",
    "a",
    "an",
    "me",
    "please",
    "find",
    "locate",
    "open",
    "focus",
    "show",
    "go",
    "take",
    "bring",
    "pull",
    "switch",
    "to",
    "up",
    "on",
    "in",
    "for",
    "with",
    "using",
    "from",
    "currently",
    "working",
    "work",
    "doing",
    "do",
    "is",
    "who",
    "which",
    "what",
    "whats",
    "terminal",
    "thread",
    "session",
    "agent",
    "pane",
    "tab",
    "one",
];

/// Resolves `query` against `threads` (the store listing, most recent first).
pub fn resolve(
    threads: &[ThreadSummary],
    query: &str,
    ctx: &ResolveContext<'_>,
) -> SessionResolution {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return not_found("Say which session, for example \u{201c}Authentication\u{201d}.");
    }
    if trimmed.chars().count() > MAX_SESSION_QUERY_CHARS {
        return missing();
    }
    let open: Vec<Entry<'_>> = threads
        .iter()
        .filter(|t| t.archived_at.is_none() && matches_requested_runtime(t, trimmed))
        .map(Entry::new)
        .collect();
    let in_workspace = |e: &Entry<'_>| ctx.workspace_id.is_some_and(|w| e.t.workspace_id == w);

    // 1. Explicit id.
    if let Some(e) = open.iter().find(|e| e.t.id.eq_ignore_ascii_case(trimmed)) {
        return resolved(e, SessionMatchTier::ExplicitId);
    }

    let raw = normalize(trimmed);
    let cleaned = clean(&raw);

    // 2 + 3. Exact name, the current workspace first.
    let exact: Vec<&Entry<'_>> = open
        .iter()
        .filter(|e| e.name == raw || e.name == cleaned)
        .collect();
    if !exact.is_empty() {
        let here: Vec<&Entry<'_>> = exact.iter().copied().filter(|e| in_workspace(e)).collect();
        if !here.is_empty() {
            return decide(here, SessionMatchTier::ExactNameInWorkspace, ctx);
        }
        return decide(exact, SessionMatchTier::ExactName, ctx);
    }

    let tokens: Vec<&str> = cleaned.split(' ').filter(|w| !w.is_empty()).collect();

    // 4. Provider and/or account words plus the name.
    let qualified: Vec<&Entry<'_>> = open
        .iter()
        .filter(|e| e.matches_qualified_name(&tokens))
        .collect();
    if !qualified.is_empty() {
        return decide(
            prefer_workspace(qualified, &in_workspace),
            SessionMatchTier::ProviderAccountName,
            ctx,
        );
    }

    // 5. "this / that / it".
    if PRONOUNS.contains(&raw.as_str()) {
        let find = |id: Option<&str>| id.and_then(|id| open.iter().find(|e| e.t.id == id));
        if let Some(e) = find(ctx.focused_thread_id) {
            return resolved(e, SessionMatchTier::Focused);
        }
        if let Some(e) = find(ctx.last_target_id) {
            return resolved(e, SessionMatchTier::LastTarget);
        }
        return not_found("No session is open here. Say its name.");
    }

    // 6. Only provider and/or account words.
    let words: Vec<&str> = tokens
        .iter()
        .copied()
        .filter(|w| !QUALIFIER_FILLER.contains(w))
        .collect();
    if !words.is_empty() {
        let by_provider: Vec<&Entry<'_>> = open
            .iter()
            .filter(|e| words.iter().all(|w| e.qualifiers.iter().any(|q| q == w)))
            .collect();
        if !by_provider.is_empty() {
            return decide(
                prefer_workspace(by_provider, &in_workspace),
                SessionMatchTier::ProviderOnly,
                ctx,
            );
        }
    }

    // Live task context. Equal fits stay ambiguous; "other" only removes the session in front
    // (or the immediately previous target) and never chooses by list order.
    if let Some(matches) = task_context_matches(&open, &raw, ctx) {
        return decide(
            prefer_workspace(matches, &in_workspace),
            SessionMatchTier::Fuzzy,
            ctx,
        );
    }

    // Bounded fuzzy: a word-start fragment, then a typo or two. Never workspace-preferred:
    // a partial name must fit exactly one open session anywhere to resolve.
    if !cleaned.is_empty() {
        let needle = format!(" {cleaned}");
        let fragment: Vec<&Entry<'_>> = open
            .iter()
            .filter(|e| format!(" {}", e.name).contains(&needle))
            .collect();
        if !fragment.is_empty() {
            return decide(fragment, SessionMatchTier::Fuzzy, ctx);
        }
        let budget = typo_budget(cleaned.chars().count());
        if budget > 0 {
            let typos: Vec<&Entry<'_>> = open
                .iter()
                .filter(|e| within_distance(&cleaned, &e.name, budget))
                .collect();
            if !typos.is_empty() {
                return decide(typos, SessionMatchTier::Fuzzy, ctx);
            }
        }
    }
    missing()
}

/// A thread with its normalized name and qualifier words, computed once per resolve.
struct Entry<'a> {
    t: &'a ThreadSummary,
    name: String,
    name_tokens: Vec<String>,
    /// Provider name, provider id and account label words ("gemini", "cli", "b").
    qualifiers: Vec<String>,
    /// Owner-visible live scene words. Never includes messages, prompts, output, paths or ids.
    task_context: Vec<String>,
}

impl<'a> Entry<'a> {
    fn new(t: &'a ThreadSummary) -> Self {
        let name = normalize(&t.name);
        let name_tokens = words(&name);
        let mut qualifiers = words(&normalize(&t.provider_name));
        qualifiers.extend(words(&normalize(t.provider_id.as_str())));
        if let Some(label) = &t.account_label {
            qualifiers.extend(words(&normalize(label)));
        }
        qualifiers.sort();
        qualifiers.dedup();
        let mut task_context = name_tokens.clone();
        task_context.extend(qualifiers.iter().cloned());
        for value in [
            Some(t.workspace_name.as_str()),
            t.model.as_deref(),
            t.effort.as_deref(),
            t.current_activity.as_deref(),
            t.branch.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            task_context.extend(words(&normalize(value)));
        }
        task_context.extend(words(&normalize(&format!("{:?}", t.status))));
        task_context.sort();
        task_context.dedup();
        Self {
            t,
            name,
            name_tokens,
            qualifiers,
            task_context,
        }
    }

    /// "Gemini B Research" / "Research on Gemini B": the name at one end, provider/account
    /// words (and filler) for the rest, with at least one real qualifier word.
    fn matches_qualified_name(&self, tokens: &[&str]) -> bool {
        let n = self.name_tokens.len();
        if n == 0 || tokens.len() <= n {
            return false;
        }
        let name_is = |part: &[&str]| part.iter().zip(&self.name_tokens).all(|(a, b)| *a == b);
        let rest = if name_is(&tokens[tokens.len() - n..]) {
            &tokens[..tokens.len() - n]
        } else if name_is(&tokens[..n]) {
            &tokens[n..]
        } else {
            return false;
        };
        let mut real = rest
            .iter()
            .filter(|w| !QUALIFIER_FILLER.contains(*w))
            .peekable();
        real.peek().is_some() && real.all(|w| self.qualifiers.iter().any(|q| q == w))
    }
}

fn task_context_matches<'e, 'a>(
    open: &'e [Entry<'a>],
    query: &str,
    ctx: &ResolveContext<'_>,
) -> Option<Vec<&'e Entry<'a>>> {
    if !is_locating_query(query) {
        return None;
    }
    let query_words = words(query);
    let other = query_words.iter().any(|word| word == "other");
    let signals: Vec<&str> = query_words
        .iter()
        .map(String::as_str)
        .filter(|word| *word != "other" && !TASK_FILLER.contains(word))
        .collect();
    if signals.is_empty() {
        return None;
    }
    let excluded = if other {
        ctx.focused_thread_id.or(ctx.last_target_id)
    } else {
        None
    };
    let matches: Vec<&Entry<'_>> = open
        .iter()
        .filter(|entry| excluded != Some(entry.t.id.as_str()))
        .filter(|entry| {
            signals.iter().all(|signal| {
                entry.task_context.iter().any(|candidate| {
                    candidate == signal
                        || (signal.chars().count() >= 3
                            && candidate.chars().count() >= 3
                            && (candidate.starts_with(signal) || signal.starts_with(candidate)))
                })
            })
        })
        .collect();
    (!matches.is_empty()).then_some(matches)
}

/// Whether an utterance explicitly asks KalVoice to locate/focus an object. Scene candidates are
/// never offered for arbitrary coding prose, even if that prose happens to share task words.
pub fn is_locating_query(query: &str) -> bool {
    let query = normalize(query);
    [
        "find ",
        "locate ",
        "open ",
        "focus ",
        "show ",
        "go to ",
        "take me to ",
        "bring up ",
        "pull up ",
        "switch to ",
        "the one ",
        "one ",
        "the other ",
        "other ",
    ]
    .iter()
    .any(|prefix| query.starts_with(prefix))
}

fn prefer_workspace<'e, 'a>(
    matches: Vec<&'e Entry<'a>>,
    in_workspace: &dyn Fn(&Entry<'a>) -> bool,
) -> Vec<&'e Entry<'a>> {
    let here: Vec<&Entry<'_>> = matches
        .iter()
        .copied()
        .filter(|e| in_workspace(e))
        .collect();
    if here.is_empty() { matches } else { here }
}

fn decide(
    matches: Vec<&Entry<'_>>,
    tier: SessionMatchTier,
    ctx: &ResolveContext<'_>,
) -> SessionResolution {
    match matches.as_slice() {
        [] => missing(),
        [only] => resolved(only, tier),
        _ => ambiguous(matches, ctx),
    }
}

fn resolved(e: &Entry<'_>, tier: SessionMatchTier) -> SessionResolution {
    SessionResolution::Resolved {
        target: candidate(e.t),
        tier,
    }
}

fn missing() -> SessionResolution {
    not_found("KalCode couldn't find an open session with that name.")
}

fn not_found(message: &str) -> SessionResolution {
    SessionResolution::NotFound {
        message: message.into(),
    }
}

/// "Name · Provider · Account" (the account part only when the thread has one).
pub fn session_label(t: &ThreadSummary) -> String {
    match t.account_label.as_deref().map(str::trim) {
        Some(account) if !account.is_empty() => {
            format!("{} \u{b7} {} \u{b7} {account}", t.name, t.provider_name)
        }
        _ => format!("{} \u{b7} {}", t.name, t.provider_name),
    }
}

pub fn candidate(t: &ThreadSummary) -> SessionCandidate {
    SessionCandidate {
        thread_id: t.id.clone(),
        name: t.name.clone(),
        provider_id: t.provider_id.clone(),
        provider_name: t.provider_name.clone(),
        account_label: t.account_label.clone(),
        workspace_id: t.workspace_id.clone(),
        workspace_name: t.workspace_name.clone(),
        status: t.status,
        label: session_label(t),
    }
}

fn ambiguous(mut matches: Vec<&Entry<'_>>, ctx: &ResolveContext<'_>) -> SessionResolution {
    // Current workspace first; otherwise the listing's most-recent-first order (stable sort).
    matches.sort_by_key(|e| !ctx.workspace_id.is_some_and(|w| e.t.workspace_id == w));
    let total = matches.len();
    let shown: Vec<&ThreadSummary> = matches
        .iter()
        .take(MAX_SESSION_CHOICES)
        .map(|e| e.t)
        .collect();
    let mut question = match describe(&shown) {
        Some(names) => format!("Which one \u{2014} {}?", join_or(&names)),
        None => format!("Which one? {total} sessions match that name."),
    };
    if total > shown.len() && !question.contains("sessions match") {
        question.push_str(&format!(" {total} sessions match; say more of the name."));
    }
    SessionResolution::Ambiguous {
        question,
        choices: shown.into_iter().map(candidate).collect(),
        total: u32::try_from(total).unwrap_or(u32::MAX),
    }
}

/// Names each choice by the first thing that tells them apart: the name, then the account,
/// the provider, the workspace. `None` when nothing does.
fn describe(choices: &[&ThreadSummary]) -> Option<Vec<String>> {
    let distinct = |keys: &[String]| {
        let mut seen: Vec<&String> = Vec::with_capacity(keys.len());
        keys.iter().all(|k| {
            let fresh = !seen.contains(&k);
            seen.push(k);
            fresh
        })
    };
    let names: Vec<String> = choices.iter().map(|t| t.name.clone()).collect();
    let folded: Vec<String> = names.iter().map(|n| normalize(n)).collect();
    if distinct(&folded) {
        return Some(names);
    }
    type Field = fn(&ThreadSummary) -> Option<(&'static str, String)>;
    let fields: [Field; 3] = [
        |t| {
            t.account_label
                .as_deref()
                .map(str::trim)
                .filter(|a| !a.is_empty())
                .map(|a| ("on", a.to_owned()))
        },
        |t| Some(("on", t.provider_name.clone())),
        |t| Some(("in", t.workspace_name.clone())),
    ];
    for field in fields {
        let values: Option<Vec<(&str, String)>> = choices.iter().map(|t| field(t)).collect();
        let Some(values) = values else { continue };
        let keys: Vec<String> = folded
            .iter()
            .zip(&values)
            .map(|(name, (_, value))| format!("{name}\u{0}{}", normalize(value)))
            .collect();
        if distinct(&keys) {
            return Some(
                names
                    .iter()
                    .zip(values)
                    .map(|(name, (word, value))| format!("{name} {word} {value}"))
                    .collect(),
            );
        }
    }
    None
}

fn join_or(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} or {last}", rest.join(", ")),
    }
}

fn words(normalized: &str) -> Vec<String> {
    normalized
        .split(' ')
        .filter(|w| !w.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Drops leading "the / my" and trailing "thread / session / …" when something remains.
fn clean(normalized: &str) -> String {
    let mut tokens: Vec<&str> = normalized.split(' ').filter(|w| !w.is_empty()).collect();
    while tokens.len() > 1 && LEADING_FILLER.contains(&tokens[0]) {
        tokens.remove(0);
    }
    while tokens.len() > 1 && tokens.last().is_some_and(|w| TRAILING_FILLER.contains(w)) {
        tokens.pop();
    }
    tokens.join(" ")
}

/// Latin-1 Supplement and Latin Extended-A (U+00C0–U+017F) folded to ASCII, one byte per code
/// point; `.` marks the few that fold to more than one letter or to nothing (see `fold_wide`).
/// Mirrored exactly in `sessionResolve.ts`.
const FOLD: &[u8; 192] = b"aaaaaa.ceeeeiiii.nooooo.ouuuuy..aaaaaa.ceeeeiiii.nooooo.ouuuuy.yaaaaaaccccccccddddeeeeeeeeeegggggggghhhhiiiiiiiiii..jjkk.llllllllllnnnnnnn..oooooo..rrrrrrsssssssstttt..uuuuuuuuuuuuwwyyyzzzzzzs";

fn fold_wide(c: char) -> &'static str {
    match c {
        '\u{c6}' | '\u{e6}' => "ae",
        '\u{d0}' | '\u{f0}' => "d",
        '\u{de}' | '\u{fe}' => "th",
        '\u{df}' => "ss",
        '\u{132}' | '\u{133}' => "ij",
        '\u{138}' => "k",
        '\u{14a}' | '\u{14b}' => "n",
        '\u{152}' | '\u{153}' => "oe",
        '\u{166}' | '\u{167}' => "t",
        // U+00D7 × and U+00F7 ÷ separate words.
        _ => " ",
    }
}

/// Lower-cased, Latin diacritics folded, combining marks dropped, every other non-alphanumeric
/// character a single space, trimmed.
pub fn normalize(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        let cp = c as u32;
        if (0xC0..0x180).contains(&cp) {
            let folded = FOLD[(cp - 0xC0) as usize];
            if folded == b'.' {
                out.push_str(fold_wide(c));
            } else {
                out.push(char::from(folded));
            }
        } else if (0x300..0x370).contains(&cp) {
            // Combining diacritical marks (a decomposed "é").
        } else if c.is_alphanumeric() {
            out.extend(c.to_lowercase());
        } else {
            out.push(' ');
        }
    }
    out.split(' ')
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// How many typos a query of `len` characters may contain: none under 5, one up to 9, two from 10.
fn typo_budget(len: usize) -> usize {
    match len {
        0..=4 => 0,
        5..=9 => 1,
        _ => 2,
    }
}

/// Optimal-string-alignment distance (insert, delete, substitute, swap neighbours) ≤ `max`.
fn within_distance(a: &str, b: &str, max: usize) -> bool {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.len().abs_diff(b.len()) > max {
        return false;
    }
    let width = b.len() + 1;
    let mut rows = vec![vec![0usize; width]; a.len() + 1];
    for (j, cell) in rows[0].iter_mut().enumerate() {
        *cell = j;
    }
    for i in 1..=a.len() {
        rows[i][0] = i;
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            let mut d = (rows[i - 1][j] + 1)
                .min(rows[i][j - 1] + 1)
                .min(rows[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                d = d.min(rows[i - 2][j - 2] + 1);
            }
            rows[i][j] = d;
        }
    }
    rows[a.len()][b.len()] <= max
}

/// Resolves a spoken or typed session name the way KalVoice does, for the command palette and
/// the Dashboard. Reads only the open-thread listing (no Session Locator); changes nothing.
#[tauri::command(async)]
pub fn session_resolve(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<crate::thread_commands::ThreadsState>,
    panes: crate::runtime_coordinator::RuntimeState<
        crate::provider_pane_commands::ProviderPanesState,
    >,
    query: String,
    workspace_id: Option<String>,
    focused_thread_id: Option<String>,
    last_target_id: Option<String>,
) -> Result<SessionResolution, kalcode_core::IpcError> {
    _runtime_access.revalidate()?;
    for id in [&workspace_id, &focused_thread_id, &last_target_id]
        .into_iter()
        .flatten()
    {
        if !kalcode_contracts::ids::is_valid_id(id) {
            return Err(kalcode_core::KalError::validation(
                "invalid_session_context",
                "That workspace or thread id is invalid.",
            )
            .into());
        }
    }
    let mut threads = state
        .runtime()?
        .list(None, false)
        .map_err(|e| e.log_and_convert("session_resolve"))?;
    for thread in &mut threads {
        panes.stamp_runtime_kind(thread);
    }
    Ok(resolve(
        &threads,
        &query,
        &ResolveContext {
            workspace_id: workspace_id.as_deref(),
            focused_thread_id: focused_thread_id.as_deref(),
            last_target_id: last_target_id.as_deref(),
        },
    ))
}

#[cfg(test)]
#[path = "session_resolver_tests.rs"]
mod tests;
