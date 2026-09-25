//! Deterministic KalVoice command grammar (docs/KALVOICE.md, "Command pipeline").
//!
//! Turns a request ("open four Codex threads", "pause every active thread", "what needs
//! permission?") into a typed [`KalVoiceIntent`] without any model. The grammar is deliberately
//! conservative: a command is recognized only when a pattern matches the *whole* request, after
//! politeness words are removed. Anything else — including negated or compound requests such as
//! "don't stop the threads" or "stop the threads and then delete the branch" — becomes
//! [`KalVoiceIntent::Reasoning`], which only the user's own connected provider may handle.
//!
//! Matching is case- and punctuation-insensitive. Counts accept digits and the words one to
//! twenty; more than [`MAX_THREADS_PER_REQUEST`] is refused rather than guessed.

use std::sync::OnceLock;

use kalcode_contracts::agent::ProviderId;
use kalcode_contracts::app::SurfaceId;
use kalcode_contracts::kalvoice::{KalVoiceIntent, PaneDirection, RequestableMode, ThreadScope};
use kalcode_contracts::workspace_ui::SplitAxis;

/// The most threads one request may open.
pub const MAX_THREADS_PER_REQUEST: u32 = 16;

/// Requests longer than this are never parsed as commands (they go to reasoning).
const MAX_COMMAND_CHARS: usize = 300;
const MAX_COMMAND_TOKENS: usize = 40;

/// A workspace or thread the user named. The orchestrator resolves it to an id (through the
/// runtime) and binds it into the intent before anything runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NamedTarget {
    Workspace(String),
    Thread(String),
    /// Providers whose panes a layout command arranges ("split Claude and Codex side by side").
    /// Not resolved to an id: the orchestrator hands them to the executor as they are.
    Providers(Vec<ProviderId>),
}

/// What the grammar understood.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Understood {
    /// A deterministic command, or `Reasoning` for everything else. When `target` is set, the
    /// intent's workspace or thread id is a placeholder to be bound with [`bind_target`].
    Intent {
        intent: KalVoiceIntent,
        target: Option<NamedTarget>,
    },
    /// Recognized as a command that cannot run as said (for example, 40 threads). Nothing runs.
    Rejected { code: &'static str, message: String },
}

impl Understood {
    fn intent(intent: KalVoiceIntent) -> Self {
        Self::Intent {
            intent,
            target: None,
        }
    }

    fn reasoning(text: &str) -> Self {
        Self::intent(KalVoiceIntent::Reasoning {
            request: text.trim().to_owned(),
        })
    }
}

/// How sure the grammar is that an utterance was meant as a command rather than words to type.
/// Verb-led commands ("open four Codex threads", "show approvals") are `High`; bare phrases
/// that could just as well be dictated text ("settings", "status", "pending approvals") are
/// `Low`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Confidence {
    High,
    Low,
}

/// Understands one request. Pure and deterministic.
pub fn understand(text: &str) -> Understood {
    understand_with_confidence(text).0
}

/// As [`understand`], with how confidently the utterance reads as a command. Reasoning and
/// empty requests are always `Low`.
pub fn understand_with_confidence(text: &str) -> (Understood, Confidence) {
    let mut confidence = Confidence::Low;
    let understood = understand_inner(text, &mut confidence);
    (understood, confidence)
}

fn understand_inner(text: &str, confidence: &mut Confidence) -> Understood {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Understood::Rejected {
            code: "empty_request",
            message: "Say or type what you want KalVoice to do.".into(),
        };
    }
    if trimmed.chars().count() > MAX_COMMAND_CHARS {
        return Understood::reasoning(trimmed);
    }
    let tokens = normalize(trimmed);
    if tokens.is_empty() || tokens.len() > MAX_COMMAND_TOKENS {
        return Understood::reasoning(trimmed);
    }
    // Negations and compound requests are never deterministic commands. The one exception is
    // pane arrangement, whose own words include "and" ("split Claude and Codex side by side",
    // "top and bottom"): only those patterns are tried when a conjunction is present.
    if tokens.iter().any(|t| is_negation(t)) {
        return Understood::reasoning(trimmed);
    }
    let compound = tokens.iter().any(|t| is_conjunction(t));
    let core = strip_filler(&tokens);
    if core.is_empty() {
        return Understood::reasoning(trimmed);
    }
    let candidates = if compound { and_rules() } else { rules() };
    for rule in candidates {
        if let Some(caps) = match_nodes(&rule.nodes, core, &Caps::default()) {
            let understood = (rule.build)(&caps);
            let deterministic = !matches!(
                understood,
                Understood::Intent {
                    intent: KalVoiceIntent::Reasoning { .. },
                    ..
                }
            );
            if rule.high && deterministic {
                *confidence = Confidence::High;
            }
            return understood;
        }
    }
    Understood::reasoning(trimmed)
}

/// Binds a resolved workspace or thread id into an intent produced with a [`NamedTarget`].
pub fn bind_target(intent: KalVoiceIntent, id: String) -> KalVoiceIntent {
    let bind_scope = |scope: ThreadScope| match scope {
        ThreadScope::Workspace { .. } => ThreadScope::Workspace {
            workspace_id: id.clone(),
        },
        ThreadScope::Thread { .. } => ThreadScope::Thread {
            thread_id: id.clone(),
        },
        ThreadScope::All => ThreadScope::All,
    };
    match intent {
        KalVoiceIntent::CreateThreads {
            provider_id, count, ..
        } => KalVoiceIntent::CreateThreads {
            provider_id,
            count,
            workspace_id: Some(id),
        },
        KalVoiceIntent::CreateTerminal { .. } => KalVoiceIntent::CreateTerminal {
            workspace_id: Some(id),
        },
        KalVoiceIntent::PauseThreads { scope } => KalVoiceIntent::PauseThreads {
            scope: bind_scope(scope),
        },
        KalVoiceIntent::ResumeThreads { scope } => KalVoiceIntent::ResumeThreads {
            scope: bind_scope(scope),
        },
        KalVoiceIntent::StopThreads { scope } => KalVoiceIntent::StopThreads {
            scope: bind_scope(scope),
        },
        other => other,
    }
}

// ---------------------------------------------------------------------------------------------
// Normalization

/// Lowercases, removes punctuation, splits hyphenated words, expands a few contractions.
fn normalize(text: &str) -> Vec<String> {
    let chars: Vec<char> = text
        .to_lowercase()
        .chars()
        .map(|c| {
            if matches!(c, '\u{2019}' | '\u{2018}') {
                '\''
            } else {
                c
            }
        })
        .collect();
    let mut cleaned = String::with_capacity(chars.len());
    for (i, &c) in chars.iter().enumerate() {
        let prev_alpha = i > 0 && chars[i - 1].is_alphabetic();
        let next_alpha = chars.get(i + 1).is_some_and(|n| n.is_alphabetic());
        let keep = c.is_alphanumeric()
            || (c == '\'' && prev_alpha && next_alpha)
            // A hyphen joining words splits them ("gemini-cli"); any other hyphen stays, so
            // "-3" never reads as a count.
            || (c == '-' && !(prev_alpha && next_alpha));
        cleaned.push(if keep { c } else { ' ' });
    }
    let mut tokens = Vec::new();
    for word in cleaned.split_whitespace() {
        match word {
            "what's" | "whats" => tokens.extend(["what", "is"].map(String::from)),
            "how's" => tokens.extend(["how", "is"].map(String::from)),
            "that's" => tokens.extend(["that", "is"].map(String::from)),
            "let's" => tokens.extend(["let", "us"].map(String::from)),
            "i'd" => tokens.extend(["i", "would"].map(String::from)),
            "i'm" => tokens.extend(["i", "am"].map(String::from)),
            other => tokens.push(other.to_owned()),
        }
    }
    tokens
}

fn is_negation(token: &str) -> bool {
    matches!(
        token,
        "not"
            | "no"
            | "never"
            | "dont"
            | "cant"
            | "cannot"
            | "wont"
            | "isnt"
            | "arent"
            | "doesnt"
            | "didnt"
            | "shouldnt"
            | "wouldnt"
            | "couldnt"
            | "mustnt"
            | "without"
            | "except"
            | "unless"
            | "nor"
            | "neither"
            | "avoid"
            | "undo"
    ) || token.ends_with("n't")
}

fn is_conjunction(token: &str) -> bool {
    matches!(
        token,
        "and"
            | "then"
            | "after"
            | "afterwards"
            | "before"
            | "if"
            | "when"
            | "whenever"
            | "while"
            | "but"
            | "or"
            | "also"
            | "plus"
            | "until"
            | "once"
    )
}

const LEADING_FILLER: &[&[&str]] = &[
    &["hey"],
    &["hi"],
    &["ok"],
    &["okay"],
    &["kalvoice"],
    &["kal", "voice"],
    &["please"],
    &["kindly"],
    &["just"],
    &["quickly"],
    &["now"],
    &["can", "you"],
    &["could", "you"],
    &["would", "you"],
    &["will", "you"],
    &["can", "we"],
    &["could", "we"],
    &["let", "us"],
    &["go", "ahead", "and"],
    &["i", "want", "you", "to"],
    &["i", "would", "like", "you", "to"],
    &["i", "need", "you", "to"],
    &["i", "want", "to"],
    &["i", "would", "like", "to"],
    &["i", "need", "to"],
];

const TRAILING_FILLER: &[&[&str]] = &[
    &["please"],
    &["for", "me"],
    &["right", "now"],
    &["now"],
    &["thanks"],
    &["thank", "you"],
    &["kalvoice"],
    &["asap"],
];

fn strip_filler(tokens: &[String]) -> &[String] {
    let mut start = 0;
    let mut end = tokens.len();
    'leading: loop {
        for phrase in LEADING_FILLER {
            if phrase_at(&tokens[start..end], phrase, true) {
                start += phrase.len();
                continue 'leading;
            }
        }
        break;
    }
    'trailing: loop {
        for phrase in TRAILING_FILLER {
            if phrase_at(&tokens[start..end], phrase, false) {
                end -= phrase.len();
                continue 'trailing;
            }
        }
        break;
    }
    &tokens[start..end]
}

fn phrase_at(tokens: &[String], phrase: &[&str], leading: bool) -> bool {
    // Never strip the whole request away.
    if tokens.len() <= phrase.len() {
        return false;
    }
    let window = if leading {
        &tokens[..phrase.len()]
    } else {
        &tokens[tokens.len() - phrase.len()..]
    };
    window.iter().zip(phrase).all(|(t, p)| t == p)
}

// ---------------------------------------------------------------------------------------------
// Pattern engine: a tiny backtracking matcher over tokens.
//
// Syntax: `word` literal · `(a b|c)` alternatives · `[a|b c]` optional · `<count>`, `<provider>`,
// `<surface>`, `<name>` slots. A pattern must consume every token.

#[derive(Debug, Clone)]
enum Node {
    Lit(String),
    Alt(Vec<Vec<Node>>),
    Opt(Vec<Vec<Node>>),
    Slot(Slot),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Slot {
    Count,
    Provider,
    Surface,
    Name,
}

#[derive(Debug, Clone, Default)]
struct Caps {
    count: Option<u32>,
    provider: Option<&'static str>,
    /// Every provider named, in order (pane arrangement names two).
    providers: Vec<&'static str>,
    surface: Option<SurfaceId>,
    names: Vec<String>,
}

fn compile(pattern: &str) -> Vec<Node> {
    let chars: Vec<char> = pattern.chars().collect();
    let mut pos = 0;
    let alternatives = parse_alternatives(&chars, &mut pos, None);
    // Top level is a single sequence.
    alternatives.into_iter().next().unwrap_or_default()
}

fn parse_alternatives(chars: &[char], pos: &mut usize, close: Option<char>) -> Vec<Vec<Node>> {
    let mut alternatives = Vec::new();
    let mut current = Vec::new();
    while *pos < chars.len() {
        let c = chars[*pos];
        if Some(c) == close {
            *pos += 1;
            break;
        }
        match c {
            ' ' => *pos += 1,
            '|' => {
                *pos += 1;
                alternatives.push(std::mem::take(&mut current));
            }
            '(' | '[' => {
                *pos += 1;
                let closing = if c == '(' { ')' } else { ']' };
                let inner = parse_alternatives(chars, pos, Some(closing));
                current.push(if c == '(' {
                    Node::Alt(inner)
                } else {
                    Node::Opt(inner)
                });
            }
            '<' => {
                let end = chars[*pos..]
                    .iter()
                    .position(|&c| c == '>')
                    .map_or(chars.len(), |i| *pos + i);
                let name: String = chars[*pos + 1..end].iter().collect();
                *pos = end + 1;
                current.push(Node::Slot(match name.as_str() {
                    "count" => Slot::Count,
                    "provider" => Slot::Provider,
                    "surface" => Slot::Surface,
                    _ => Slot::Name,
                }));
            }
            _ => {
                let start = *pos;
                while *pos < chars.len() && !" |()[]<>".contains(chars[*pos]) {
                    *pos += 1;
                }
                current.push(Node::Lit(chars[start..*pos].iter().collect()));
            }
        }
    }
    alternatives.push(current);
    alternatives
}

fn match_nodes(nodes: &[Node], tokens: &[String], caps: &Caps) -> Option<Caps> {
    let Some((first, rest)) = nodes.split_first() else {
        return tokens.is_empty().then(|| caps.clone());
    };
    match first {
        Node::Lit(word) => {
            if tokens.first().is_some_and(|t| t == word) {
                match_nodes(rest, &tokens[1..], caps)
            } else {
                None
            }
        }
        Node::Alt(alternatives) => alternatives.iter().find_map(|alt| {
            let seq: Vec<Node> = alt.iter().chain(rest).cloned().collect();
            match_nodes(&seq, tokens, caps)
        }),
        Node::Opt(alternatives) => alternatives
            .iter()
            .find_map(|alt| {
                let seq: Vec<Node> = alt.iter().chain(rest).cloned().collect();
                match_nodes(&seq, tokens, caps)
            })
            .or_else(|| match_nodes(rest, tokens, caps)),
        Node::Slot(slot) => {
            slot_candidates(*slot, tokens)
                .into_iter()
                .find_map(|(consumed, fill)| {
                    let mut next = caps.clone();
                    fill(&mut next);
                    match_nodes(rest, &tokens[consumed..], &next)
                })
        }
    }
}

type Fill = Box<dyn Fn(&mut Caps)>;

fn slot_candidates(slot: Slot, tokens: &[String]) -> Vec<(usize, Fill)> {
    let mut out: Vec<(usize, Fill)> = Vec::new();
    match slot {
        Slot::Count => {
            if tokens.len() >= 2
                && let Some(n) = compound_number(&tokens[0], &tokens[1])
            {
                out.push((2, Box::new(move |c: &mut Caps| c.count = Some(n))));
            }
            if let Some(n) = tokens.first().and_then(|t| count_word(t)) {
                out.push((1, Box::new(move |c: &mut Caps| c.count = Some(n))));
            }
        }
        Slot::Provider => {
            for len in [2, 1] {
                if tokens.len() >= len
                    && let Some(id) = provider_words(&tokens[..len])
                {
                    out.push((
                        len,
                        Box::new(move |c: &mut Caps| {
                            c.provider = Some(id);
                            c.providers.push(id);
                        }),
                    ));
                }
            }
        }
        Slot::Surface => {
            for len in [2, 1] {
                if tokens.len() >= len
                    && let Some(surface) = surface_words(&tokens[..len])
                {
                    out.push((len, Box::new(move |c: &mut Caps| c.surface = Some(surface))));
                }
            }
        }
        Slot::Name => {
            // Shortest first, so optional trailing words ("… workspace") are not swallowed.
            for len in 1..=tokens.len() {
                let words = &tokens[..len];
                // A name never starts with an article or pronoun ("show me the X thread").
                if matches!(words[0].as_str(), "the" | "a" | "an" | "me") {
                    break;
                }
                let name = words.join(" ");
                out.push((
                    len,
                    Box::new(move |c: &mut Caps| c.names.push(name.clone())),
                ));
            }
        }
    }
    out
}

fn count_word(token: &str) -> Option<u32> {
    if token.chars().all(|c| c.is_ascii_digit()) {
        // Saturate so absurd numbers are refused as "too many", never wrapped.
        return Some(token.parse::<u32>().unwrap_or(u32::MAX));
    }
    Some(match token {
        "a" | "an" | "another" | "single" => 1,
        // How speech recognition often writes "four" and "two" before "Codex threads". Only
        // ever read as counts inside a full command pattern.
        "for" => 4,
        "to" | "too" => 2,
        "zero" => 0,
        other => small_number(other)?,
    })
}

fn small_number(word: &str) -> Option<u32> {
    const WORDS: [&str; 21] = [
        "zero",
        "one",
        "two",
        "three",
        "four",
        "five",
        "six",
        "seven",
        "eight",
        "nine",
        "ten",
        "eleven",
        "twelve",
        "thirteen",
        "fourteen",
        "fifteen",
        "sixteen",
        "seventeen",
        "eighteen",
        "nineteen",
        "twenty",
    ];
    if let Some(i) = WORDS.iter().position(|w| *w == word) {
        return u32::try_from(i).ok();
    }
    Some(match word {
        "thirty" => 30,
        "forty" => 40,
        "fifty" => 50,
        "sixty" => 60,
        "seventy" => 70,
        "eighty" => 80,
        "ninety" => 90,
        "hundred" => 100,
        "thousand" => 1000,
        "million" => 1_000_000,
        _ => return None,
    })
}

/// "twenty one", "thirty five", "one hundred" — only so larger numbers are refused clearly.
fn compound_number(first: &str, second: &str) -> Option<u32> {
    let a = match first {
        "a" | "an" => 1,
        other => small_number(other)?,
    };
    let b = small_number(second)?;
    if a >= 20 && a % 10 == 0 && a < 100 && (1..10).contains(&b) {
        Some(a + b)
    } else if (1..10).contains(&a) && b >= 100 {
        Some(a.saturating_mul(b))
    } else {
        None
    }
}

fn provider_words(words: &[String]) -> Option<&'static str> {
    let joined = words.join(" ");
    Some(match joined.as_str() {
        "claude code" | "claude" => ProviderId::CLAUDE_CODE,
        // "codecs" and "code x": how speech recognition often hears "Codex".
        "codex" | "codecs" | "code x" => ProviderId::CODEX,
        "gemini cli" | "gemini" => ProviderId::GEMINI_CLI,
        _ => return None,
    })
}

fn surface_words(words: &[String]) -> Option<SurfaceId> {
    let joined = words.join(" ");
    Some(match joined.as_str() {
        "dashboard" | "home" | "overview" => SurfaceId::Dashboard,
        "kalvoice" | "kal voice" | "voice" => SurfaceId::KalVoice,
        "code" | "editor" => SurfaceId::Code,
        "threads" => SurfaceId::Threads,
        "agents" => SurfaceId::Agents,
        "missions" => SurfaceId::Missions,
        "automations" => SurfaceId::Automations,
        "skills" => SurfaceId::Skills,
        "plugins" | "integrations" => SurfaceId::Plugins,
        "memory" | "memories" => SurfaceId::Memory,
        "providers" => SurfaceId::Providers,
        "settings" | "preferences" => SurfaceId::Settings,
        _ => return None,
    })
}

// ---------------------------------------------------------------------------------------------
// Rules

type Build = Box<dyn Fn(&Caps) -> Understood + Send + Sync>;

struct Rule {
    nodes: Vec<Node>,
    build: Build,
    /// Verb-led patterns; bare noun phrases are low confidence.
    high: bool,
}

/// Patterns that are plausible as ordinary dictated text.
const LOW_CONFIDENCE: &[&str] = &[
    "[give me] [a|the] [thread|threads] status [report|update]",
    "[are there|is there] any [pending] (approvals|approval requests|permission requests)",
    "[pending] (approvals|approval requests|permission requests)",
    "<surface> [page|view|screen|tab|section]",
];

const OPEN_VERB: &str =
    "(open|start|create|launch|spin up|spin|make|add|new|fire up|kick off|begin|give me)";
const IN_WORKSPACE: &str =
    "(in|for|on|inside) [the] [workspace|project] <name> [workspace|project]";
const THREAD_WORD: &str = "(thread|threads|session|sessions|agent|agents)";
const THREAD_STATE: &str = "(active|running|current|paused|open|idle|working|busy|stuck)";

fn rules() -> &'static [Rule] {
    static RULES: OnceLock<Vec<Rule>> = OnceLock::new();
    RULES.get_or_init(build_rules)
}

/// The only patterns tried on a request containing a conjunction: pane arrangements whose own
/// wording has "and". Layout only; nothing starts or stops.
fn and_rules() -> &'static [Rule] {
    static RULES: OnceLock<Vec<Rule>> = OnceLock::new();
    RULES.get_or_init(build_and_rules)
}

fn rule(pattern: String, build: Build) -> Rule {
    Rule {
        high: !LOW_CONFIDENCE.contains(&pattern.as_str()),
        nodes: compile(&pattern),
        build,
    }
}

const PANE_WORD: &str = "[the|this|my|current|this current] [pane|panes|screen|view|window]";
const ARRANGE_VERB: &str = "(split|put|place|show|arrange|open|lay out)";
const SIDE_BY_SIDE: &str =
    "[side by side|next to each other|beside each other|together|left and right|horizontally]";

fn split(axis: SplitAxis) -> Build {
    Box::new(move |_| Understood::intent(KalVoiceIntent::Split { axis }))
}

/// "Split Claude and Codex side by side": a side-by-side split carrying the named providers.
fn arrange(axis: SplitAxis) -> Build {
    Box::new(move |c: &Caps| {
        let mut providers: Vec<ProviderId> = Vec::new();
        for id in &c.providers {
            let id = ProviderId::new(*id);
            if !providers.contains(&id) {
                providers.push(id);
            }
        }
        if providers.len() < 2 {
            return Understood::reasoning("");
        }
        Understood::Intent {
            intent: KalVoiceIntent::Split { axis },
            target: Some(NamedTarget::Providers(providers)),
        }
    })
}

fn build_and_rules() -> Vec<Rule> {
    vec![
        rule(
            format!("split {PANE_WORD} left and right"),
            split(SplitAxis::Horizontal),
        ),
        rule(
            format!("split {PANE_WORD} top and bottom"),
            split(SplitAxis::Vertical),
        ),
        rule(
            format!("{ARRANGE_VERB} <provider> and <provider> {SIDE_BY_SIDE} [panes]"),
            arrange(SplitAxis::Horizontal),
        ),
        rule(
            format!(
                "{ARRANGE_VERB} <provider> and <provider> [panes] (top and bottom|stacked|vertically|one above the other)"
            ),
            arrange(SplitAxis::Vertical),
        ),
    ]
}

/// Pane layout commands without conjunctions (split, resize, close, arrange with "next to").
fn pane_rules(add: &mut impl FnMut(String, Build)) {
    // Stacked first, so its qualifiers never read as a plain split.
    add(
        format!("split {PANE_WORD} (vertically|down|stacked|below|top to bottom|in rows)"),
        split(SplitAxis::Vertical),
    );
    add(
        format!(
            "split {PANE_WORD} [side by side|horizontally|right|to the right|sideways|in columns]"
        ),
        split(SplitAxis::Horizontal),
    );
    add(
        format!("{ARRANGE_VERB} <provider> (next to|beside|alongside) <provider>"),
        arrange(SplitAxis::Horizontal),
    );
    add(
        format!("{ARRANGE_VERB} <provider> (above|over) <provider>"),
        arrange(SplitAxis::Vertical),
    );

    // Resize: bigger / wider grow to the right, taller downward (the UI grows the other way
    // when there's no pane on that side, so "bigger" always does something).
    const SMALL: &str = "(a bit|a little|a little bit|a tad|slightly)";
    const LARGE: &str = "(a lot|much|way|a lot more|much more)";
    let resize = |direction: PaneDirection, steps: u8| -> Build {
        Box::new(move |_| Understood::intent(KalVoiceIntent::Resize { direction, steps }))
    };
    for (words, direction) in [
        ("(bigger|larger|wider)", PaneDirection::Right),
        ("taller", PaneDirection::Down),
        ("(smaller|narrower)", PaneDirection::Left),
        ("shorter", PaneDirection::Up),
    ] {
        for (before, after, steps) in [
            ("", "", 2u8),
            ("", SMALL, 1),
            (SMALL, "", 1),
            ("", LARGE, 4),
            (LARGE, "", 4),
        ] {
            add(
                format!("make {PANE_WORD} {before} {words} {after}"),
                resize(direction, steps),
            );
        }
    }
    for (verb, direction) in [
        ("(grow|enlarge|expand|widen)", PaneDirection::Right),
        ("shrink", PaneDirection::Left),
    ] {
        for (after, steps) in [("", 2u8), (SMALL, 1), (LARGE, 4)] {
            add(
                format!("{verb} {PANE_WORD} {after}"),
                resize(direction, steps),
            );
        }
    }

    // Close a pane: the focused one, or one by name. Closing never stops what runs in it.
    add(
        "close [the|this|my|current|this current] pane".into(),
        Box::new(|_| Understood::intent(KalVoiceIntent::Close { query: None })),
    );
    add(
        "close [the|my] <name> pane".into(),
        Box::new(|c: &Caps| {
            Understood::intent(KalVoiceIntent::Close {
                query: c.names.first().cloned(),
            })
        }),
    );
}

fn build_rules() -> Vec<Rule> {
    let mut rules = Vec::new();
    let mut add = |pattern: String, build: Build| {
        rules.push(Rule {
            high: !LOW_CONFIDENCE.contains(&pattern.as_str()),
            nodes: compile(&pattern),
            build,
        });
    };
    let status = || -> Build { Box::new(|_| Understood::intent(KalVoiceIntent::StatusReport)) };
    let approvals = || -> Build { Box::new(|_| Understood::intent(KalVoiceIntent::ShowApprovals)) };

    // Status report.
    for p in [
        "[give me] [a|the] [thread|threads] status [report|update]",
        "what (is|are) (my|the|all my|all the|all of my) (threads|agents) (doing|up to|working on)",
        "how (is|are) (my|the|all my|all the) (threads|agents) [doing|going]",
        "what is (running|happening|going on)",
        "what is everyone (doing|working on)",
        "(show|give|tell) [me] [the] status [of (my|the|all) (threads|agents)]",
        "(tell|show) me what (my|the) (threads|agents) are (doing|up to|working on)",
    ] {
        add(p.into(), status());
    }

    // Approvals.
    for p in [
        "(show|open|list|view|see|display|check) [me] [the|my|all|all the|any] [pending|open|waiting] (approvals|approval requests|permission requests|permissions)",
        "what [is|are] (needs|need|requires|require|waiting for) [my] (permission|approval|approvals|approving|me)",
        "[are there|is there] any [pending] (approvals|approval requests|permission requests)",
        "[pending] (approvals|approval requests|permission requests)",
        "(does anything|anything) (need|needs) [my] (approval|permission)",
        "(show|tell) [me] what is waiting [on me]",
        "what is waiting [on me]",
    ] {
        add(p.into(), approvals());
    }

    // Navigation.
    for p in [
        "(go to|go|open|show me|show|switch to|navigate to|take me to|bring up|jump to|view|display) [the|my] <surface> [page|view|screen|tab|section|surface]",
        "<surface> [page|view|screen|tab|section]",
    ] {
        add(
            p.into(),
            Box::new(|c| match c.surface {
                Some(surface) => Understood::intent(KalVoiceIntent::Navigate { surface }),
                None => Understood::reasoning(""),
            }),
        );
    }

    // Create threads with a provider.
    for p in [
        format!(
            "{OPEN_VERB} [up] [<count>] [new|more|additional|fresh] <provider> {THREAD_WORD} [{IN_WORKSPACE}]"
        ),
        format!(
            "{OPEN_VERB} [up] [<count>] [new|more|additional|fresh] {THREAD_WORD} (with|using|running|on) <provider> [{IN_WORKSPACE}]"
        ),
    ] {
        add(p, Box::new(create_threads));
    }

    // Terminals.
    add(
        format!(
            "(open|start|create|launch|new|add|spin up|give me) [a|an|another|one|one more] [new] (terminal|shell|console|terminal tab|terminal window) [{IN_WORKSPACE}]"
        ),
        Box::new(|c| {
            with_workspace(
                KalVoiceIntent::CreateTerminal { workspace_id: None },
                c.names.first(),
            )
        }),
    );

    // Pause / resume / stop.
    thread_control(&mut add, "(pause|suspend|hold)", |scope| {
        KalVoiceIntent::PauseThreads { scope }
    });
    thread_control(&mut add, "(resume|unpause|continue)", |scope| {
        KalVoiceIntent::ResumeThreads { scope }
    });
    thread_control(
        &mut add,
        "(stop|halt|kill|end|terminate|cancel|shut down)",
        |scope| KalVoiceIntent::StopThreads { scope },
    );

    // Workspaces.
    for p in [
        "(open|switch to|go to|show|load|activate|jump to) [the|my] (workspace|project) <name>",
        "(open|switch to|go to|load|activate|jump to) [the|my] <name> (workspace|project)",
    ] {
        add(
            p.into(),
            Box::new(|c| {
                Understood::intent(KalVoiceIntent::OpenWorkspace {
                    query: c.names.first().cloned().unwrap_or_default(),
                })
            }),
        );
    }

    // Threads requested without a provider: ask for one instead of guessing.
    add(
        format!(
            "{OPEN_VERB} [up] [<count>] [new|more|additional|fresh] (thread|threads|session|sessions) [{IN_WORKSPACE}]"
        ),
        Box::new(|c| {
            match check_count(c.count.unwrap_or(1)) {
            Err(rejected) => rejected,
            Ok(_) => Understood::Rejected {
                code: "provider_not_specified",
                message: "Say which provider to use: Claude Code, Codex or Gemini CLI. For example, \u{201c}open two Codex threads\u{201d}.".into(),
            },
        }
        }),
    );

    // Open one thread by name.
    for p in [
        "(open|go to|show me|show|switch to|jump to|view) [the|my] thread <name>",
        "(open|go to|show me|show|switch to|jump to|view) [the|my] <name> thread",
    ] {
        add(
            p.into(),
            Box::new(|c| {
                Understood::intent(KalVoiceIntent::OpenThread {
                    query: c.names.first().cloned().unwrap_or_default(),
                })
            }),
        );
    }

    // Pane layout (Z7-W1): split, arrange providers, resize, close.
    pane_rules(&mut add);

    // Focus a thread by name: its pane when it has one, else the thread in Threads.
    for p in [
        "focus [on] [the|my] thread <name>",
        "focus [on] [the|my] <name> (thread|pane)",
    ] {
        add(
            p.into(),
            Box::new(|c| {
                Understood::intent(KalVoiceIntent::Focus {
                    query: c.names.first().cloned().unwrap_or_default(),
                })
            }),
        );
    }

    // Ask for a thread's permission mode to change. KalVoice only asks: the person confirms the
    // change in KalCode. Bypass can't be requested at all (the contract can't represent it).
    for (word, mode) in [
        ("plan", RequestableMode::Plan),
        ("approve", RequestableMode::Approve),
        ("auto", RequestableMode::Auto),
    ] {
        for p in [
            format!("{MODE_VERB} [the|my] thread <name> (to|into|in) {word} mode"),
            format!("{MODE_VERB} [the|my] <name> thread (to|into|in) {word} mode"),
        ] {
            add(
                p,
                Box::new(move |c| {
                    Understood::intent(KalVoiceIntent::RequestPermissionMode {
                        mode,
                        thread_query: c.names.first().cloned(),
                    })
                }),
            );
        }
    }
    for p in [
        format!("{MODE_VERB} [the|my] thread <name> (to|into|in) bypass [mode]"),
        format!("{MODE_VERB} [the|my] <name> thread (to|into|in) bypass [mode]"),
        "(turn on|enable|use|allow|switch to|go to) bypass [mode]".to_owned(),
    ] {
        add(
            p,
            Box::new(|_| Understood::Rejected {
                code: "bypass_not_allowed",
                message:
                    "KalVoice can't turn on Bypass. Only you can, in the thread's permission menu."
                        .into(),
            }),
        );
    }

    rules
}

/// Verbs for asking a thread's permission mode to change.
const MODE_VERB: &str = "(switch|change|put|set|move)";

fn thread_control(
    add: &mut impl FnMut(String, Build),
    verb: &str,
    make: fn(ThreadScope) -> KalVoiceIntent,
) {
    let all_or_workspace = move |c: &Caps| Understood::Intent {
        intent: make(if c.names.is_empty() {
            ThreadScope::All
        } else {
            ThreadScope::Workspace {
                workspace_id: String::new(),
            }
        }),
        target: c.names.first().cloned().map(NamedTarget::Workspace),
    };
    let one_thread = move |c: &Caps| Understood::Intent {
        intent: make(ThreadScope::Thread {
            thread_id: String::new(),
        }),
        target: c.names.first().cloned().map(NamedTarget::Thread),
    };
    add(
        format!(
            "{verb} (all|every|each) [of] [the|my] [{THREAD_STATE}] {THREAD_WORD} [{IN_WORKSPACE}]"
        ),
        Box::new(all_or_workspace),
    );
    add(
        format!("{verb} [the|my] [{THREAD_STATE}] (threads|agents|sessions) [{IN_WORKSPACE}]"),
        Box::new(all_or_workspace),
    );
    add(
        format!("{verb} (everything|all|all of them|them all)"),
        Box::new(all_or_workspace),
    );
    add(
        format!("{verb} [the|my] thread <name>"),
        Box::new(one_thread),
    );
    add(
        format!("{verb} [the|my] <name> thread"),
        Box::new(one_thread),
    );
}

fn with_workspace(intent: KalVoiceIntent, name: Option<&String>) -> Understood {
    Understood::Intent {
        intent,
        target: name.cloned().map(NamedTarget::Workspace),
    }
}

fn check_count(count: u32) -> Result<u8, Understood> {
    if count == 0 {
        return Err(Understood::Rejected {
            code: "thread_count_invalid",
            message: "Say how many threads to open, from one to twenty.".into(),
        });
    }
    if count > MAX_THREADS_PER_REQUEST {
        return Err(Understood::Rejected {
            code: "thread_count_too_large",
            message: format!(
                "KalVoice opens at most {MAX_THREADS_PER_REQUEST} threads per request. Ask for {MAX_THREADS_PER_REQUEST} or fewer."
            ),
        });
    }
    u8::try_from(count).map_err(|_| Understood::Rejected {
        code: "thread_count_too_large",
        message: String::new(),
    })
}

fn create_threads(c: &Caps) -> Understood {
    let count = match check_count(c.count.unwrap_or(1)) {
        Ok(count) => count,
        Err(rejected) => return rejected,
    };
    let Some(provider) = c.provider else {
        return Understood::reasoning("");
    };
    with_workspace(
        KalVoiceIntent::CreateThreads {
            provider_id: ProviderId::new(provider),
            count,
            workspace_id: None,
        },
        c.names.first(),
    )
}

#[cfg(test)]
#[path = "grammar_tests.rs"]
mod tests;
