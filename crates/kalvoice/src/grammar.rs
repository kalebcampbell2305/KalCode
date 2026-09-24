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
use kalcode_contracts::kalvoice::{KalVoiceIntent, ThreadScope};

/// The most threads one request may open.
pub const MAX_THREADS_PER_REQUEST: u32 = 20;

/// Requests longer than this are never parsed as commands (they go to reasoning).
const MAX_COMMAND_CHARS: usize = 300;
const MAX_COMMAND_TOKENS: usize = 40;

/// A workspace or thread the user named. The orchestrator resolves it to an id (through the
/// runtime) and binds it into the intent before anything runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NamedTarget {
    Workspace(String),
    Thread(String),
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

/// Understands one request. Pure and deterministic.
pub fn understand(text: &str) -> Understood {
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
    // Negations and compound requests are never deterministic commands.
    if tokens.iter().any(|t| is_negation(t) || is_conjunction(t)) {
        return Understood::reasoning(trimmed);
    }
    let core = strip_filler(&tokens);
    if core.is_empty() {
        return Understood::reasoning(trimmed);
    }
    for rule in rules() {
        if let Some(caps) = match_nodes(&rule.nodes, core, &Caps::default()) {
            return (rule.build)(&caps);
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
                    out.push((len, Box::new(move |c: &mut Caps| c.provider = Some(id))));
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
        "codex" => ProviderId::CODEX,
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
}

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

fn build_rules() -> Vec<Rule> {
    let mut rules = Vec::new();
    let mut add = |pattern: String, build: Build| {
        rules.push(Rule {
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

    rules
}

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
