//! Deterministic KalVoice command grammar (docs/KALVOICE.md, "Command pipeline").
//!
//! Turns a request ("open four Codex threads", "pause every active thread", "what needs
//! permission?") into a typed [`KalVoiceIntent`] without any model. The grammar is deliberately
//! conservative: a command is recognized only when a pattern matches the *whole* request, after
//! politeness words are removed. Anything else â€” including negated or compound requests such as
//! "don't stop the threads" or "stop the threads and then delete the branch" â€” becomes
//! [`KalVoiceIntent::Reasoning`], which only the bounded on-device interpreter may handle.
//!
//! Matching is case- and punctuation-insensitive. Counts accept digits and the words one to
//! twenty; more than [`MAX_THREADS_PER_REQUEST`] is refused rather than guessed.

use std::sync::OnceLock;

use kalcode_contracts::agent::ProviderId;
use kalcode_contracts::app::SurfaceId;
use kalcode_contracts::kalvoice::{
    AgentLaunchAssignment, BrowserControl, KalVoiceIntent, PaneControl, PaneDirection,
    ProviderPaneRequest, RequestableMode, ThreadScope,
};
use kalcode_contracts::workspace_ui::SplitAxis;
use url::Url;

#[path = "grammar_sessions.rs"]
mod sessions;

#[path = "grammar_agents.rs"]
mod agents;

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
    understand_talk(text).understood
}

/// As [`understand`], with how confidently the utterance reads as a command. Reasoning and
/// empty requests are always `Low`.
pub fn understand_with_confidence(text: &str) -> (Understood, Confidence) {
    let parsed = understand_talk(text);
    (parsed.understood, parsed.confidence)
}

/// What the grammar made of one utterance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parsed {
    pub understood: Understood,
    pub confidence: Confidence,
    /// The person addressed KalVoice ("Hey Kal, â€¦", "Kal, â€¦"). An addressed utterance is a
    /// command or a request, never words to type.
    pub addressed: bool,
}

/// As [`understand`], also reporting confidence and whether KalVoice was addressed.
pub fn understand_talk(text: &str) -> Parsed {
    let (addressed, rest) = sessions::strip_address(text.trim());
    let mut confidence = Confidence::Low;
    let understood = understand_inner(rest, &mut confidence, true);
    Parsed {
        understood,
        confidence,
        addressed,
    }
}

fn understand_inner(text: &str, confidence: &mut Confidence, second_chance: bool) -> Understood {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Understood::Rejected {
            code: "empty_request",
            message: "Say or type what you want KalVoice to do.".into(),
        };
    }
    let tokens = normalize(trimmed);
    // Account chooser retries are transient, machine-produced commands whose hex payload can
    // exceed spoken-command bounds. Decode them before ordinary transcript guards; every field
    // still passes the same typed executor validation and canonical account revalidation.
    if tokens.first().is_some_and(|word| word == "retry")
        && tokens.get(1).is_some_and(|word| word == "launch")
        && let Some(understood) = retry_launch(&tokens)
    {
        *confidence = Confidence::High;
        return understood;
    }
    // "Send that", "don't send that", "tell Auth to â€¦", "go back": before the length, negation
    // and compound checks, because their own words may contain both.
    if let Some((understood, sure)) = sessions::before_guards(trimmed, &tokens) {
        *confidence = sure;
        return understood;
    }
    if trimmed.chars().count() > MAX_COMMAND_CHARS {
        return Understood::reasoning(trimmed);
    }
    if tokens.is_empty() || tokens.len() > MAX_COMMAND_TOKENS {
        return Understood::reasoning(trimmed);
    }
    let understood = understand_rules(trimmed, &tokens, confidence);
    if !second_chance || !is_reasoning(&understood) || local_reasoning_must_refuse(trimmed) {
        return understood;
    }
    if let Some(retried) = retry_rewritten(trimmed, &tokens, confidence) {
        return retried;
    }
    // Last: "open Authentication", a session by the person's own words (never a rewrite).
    // Low confidence: in a focused text box such words stay dictation.
    sessions::locator(trimmed, strip_filler(&tokens)).unwrap_or(understood)
}

/// P2: one deterministic second chance for a paraphrase or speech-recognition variant. The
/// rewrite is parsed by the same grammar; an unanchored rewrite may only yield a read-only
/// intent and never raises confidence.
fn retry_rewritten(
    trimmed: &str,
    tokens: &[String],
    confidence: &mut Confidence,
) -> Option<Understood> {
    let rewrite = crate::normalize::second_chance(trimmed)?;
    if normalize(&rewrite.text) == tokens {
        return None;
    }
    let mut second = Confidence::Low;
    let retried = understand_inner(&rewrite.text, &mut second, false);
    let usable = match &retried {
        // A rewrite never carries rewritten words into a prompt: the prompt-carrying intents
        // come only from the person's original words.
        Understood::Intent {
            intent: KalVoiceIntent::DirectPrompt { .. },
            ..
        } => false,
        Understood::Intent { intent, .. } => {
            !intent.needs_reasoning() && (!rewrite.read_only || is_read_only(intent))
        }
        Understood::Rejected { code, .. } => !rewrite.read_only && *code != "empty_request",
    };
    if !usable {
        return None;
    }
    if !rewrite.read_only {
        *confidence = second;
    }
    Some(retried)
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

/// Intents that only show or read something (safe for an unanchored rewrite).
fn is_read_only(intent: &KalVoiceIntent) -> bool {
    matches!(
        intent,
        KalVoiceIntent::Navigate { .. }
            | KalVoiceIntent::ShowApprovals
            | KalVoiceIntent::StatusReport
            | KalVoiceIntent::FilterDashboard { .. }
            | KalVoiceIntent::FilterAgents { .. }
            | KalVoiceIntent::CountAgents { .. }
            | KalVoiceIntent::WhichAgents { .. }
            | KalVoiceIntent::WhichSessions { .. }
            | KalVoiceIntent::Search { .. }
            | KalVoiceIntent::ReadMemory { .. }
    )
}

fn understand_rules(trimmed: &str, tokens: &[String], confidence: &mut Confidence) -> Understood {
    // Negations and compound requests are never deterministic commands. The one exception is
    // pane arrangement, whose own words include "and" ("split Claude and Codex side by side",
    // "top and bottom"): only those patterns are tried when a conjunction is present.
    if tokens.iter().any(|t| is_negation(t)) {
        return Understood::reasoning(trimmed);
    }
    let compound = tokens.iter().any(|t| is_conjunction(t));
    let core = strip_filler(tokens);
    if core.is_empty() {
        return Understood::reasoning(trimmed);
    }
    if !compound && let Some(intent) = memory_question(core) {
        *confidence = Confidence::High;
        return Understood::intent(intent);
    }
    // Coding agents by status, the same for every provider ("show me all agents that need me",
    // "how many agents are working", "close all idle agents"). "… waiting for me" is tried with
    // its "for me" first: there it means the person, while bare "waiting" is the Waiting group.
    if !compound {
        let with_me = strip_filler_with(tokens, TRAILING_FILLER_KEEPING_ME);
        let mut tried: &[String] = &[];
        for words in [with_me, core] {
            if words == tried {
                continue;
            }
            tried = words;
            for rule in agent_rules() {
                if let Some(caps) = match_nodes(&rule.nodes, words, &Caps::default()) {
                    *confidence = Confidence::High;
                    return (rule.build)(&caps);
                }
            }
        }
    }
    if core.iter().any(|word| word == "cursor")
        && let Some(understood) = pane_request(core)
    {
        *confidence = Confidence::High;
        return understood;
    }
    if let Some(rejected) = standalone_launch_modifier(core) {
        *confidence = Confidence::High;
        return rejected;
    }
    if let Some(intent) = browser_request(trimmed, core) {
        *confidence = Confidence::High;
        return Understood::intent(intent);
    }
    // Sessions by state ("focus the one waiting for permission", "which agent is stuck?", "what
    // needs permission?") before every other rule, so the approvals panel doesn't read the last
    // one; tried only when a state word is present, to keep the common path cheap.
    if !compound && core.iter().any(|w| sessions::is_state_word(w)) {
        for rule in state_rules() {
            if let Some(caps) = match_nodes(&rule.nodes, core, &Caps::default()) {
                *confidence = Confidence::High;
                return (rule.build)(&caps);
            }
        }
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
    if let Some(understood) = pane_request(core) {
        *confidence = Confidence::High;
        return understood;
    }
    Understood::reasoning(trimmed)
}

/// Read-only questions with a clear project-knowledge subject. Generic questions remain on
/// the normal reasoning route; memory never pretends to be a general-purpose assistant.
fn memory_question(tokens: &[String]) -> Option<KalVoiceIntent> {
    let words = tokens.iter().map(String::as_str).collect::<Vec<_>>();
    let query = match words.as_slice() {
        [
            "search" | "read",
            "project" | "unified",
            "memory",
            rest @ ..,
        ]
        | ["search" | "read", "memory", rest @ ..] => rest.join(" "),
        ["what", "did", "we", "decide", rest @ ..] if !rest.is_empty() => rest.join(" "),
        ["why", "did", "we", "use" | "choose", rest @ ..] if !rest.is_empty() => rest.join(" "),
        [
            "which" | "what",
            "file" | "module",
            "owns" | "handles",
            rest @ ..,
        ] if !rest.is_empty() => rest.join(" "),
        ["what", "do", "you", "remember", "about", rest @ ..] if !rest.is_empty() => rest.join(" "),
        _ => return None,
    };
    Some(KalVoiceIntent::ReadMemory { query })
}

const MAX_BROWSER_URL_CHARS: usize = 2_048;

/// Browser commands are parsed before the general surface grammar so `open the browser` refers
/// to a pane rather than a top-level page. URL parsing remains deliberately narrow: speech can
/// open local development addresses or an explicit HTTP(S) URL, never a privileged scheme.
fn browser_request(original: &str, tokens: &[String]) -> Option<KalVoiceIntent> {
    let words = tokens.iter().map(String::as_str).collect::<Vec<_>>();
    let command = match words.as_slice() {
        ["open", "browser"] | ["open", "the", "browser"] | ["open", "browser", "pane"] => {
            Some(BrowserControl::Open {
                url: None,
                new_pane: false,
            })
        }
        ["open", "another", "browser"]
        | ["open", "another", "browser", "pane"]
        | ["open", "new", "browser"]
        | ["open", "new", "browser", "pane"]
        | ["new", "browser"]
        | ["new", "browser", "pane"] => Some(BrowserControl::Open {
            url: None,
            new_pane: true,
        }),
        ["back"]
        | ["go", "back"]
        | ["browser", "back"]
        | ["go", "back", "in", "browser"]
        | ["go", "back", "in", "the", "browser"] => Some(BrowserControl::Back { browser_id: None }),
        ["forward"]
        | ["go", "forward"]
        | ["browser", "forward"]
        | ["go", "forward", "in", "browser"]
        | ["go", "forward", "in", "the", "browser"] => {
            Some(BrowserControl::Forward { browser_id: None })
        }
        ["reload"]
        | ["refresh"]
        | ["reload", "page"]
        | ["reload", "the", "page"]
        | ["refresh", "page"]
        | ["refresh", "the", "page"]
        | ["reload", "browser"]
        | ["reload", "the", "browser"] => Some(BrowserControl::Reload { browser_id: None }),
        ["stop", "loading"]
        | ["stop", "loading", "page"]
        | ["stop", "loading", "the", "page"]
        | ["stop", "loading", "browser"]
        | ["stop", "loading", "the", "browser"] => Some(BrowserControl::Stop { browser_id: None }),
        _ => None,
    };
    if command.is_some() {
        return command.map(|command| KalVoiceIntent::ControlBrowser {
            command,
            workspace_id: None,
        });
    }

    let mut spoken = original.trim();
    if spoken
        .get(.."please ".len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("please "))
    {
        spoken = &spoken["please ".len()..];
    }
    let lower = spoken.to_lowercase();
    let prefix_len = ["navigate to ", "open "]
        .into_iter()
        .find_map(|prefix| lower.starts_with(prefix).then_some(prefix.len()))?;
    let raw_address = spoken.get(prefix_len..)?.trim();
    let address = normalize_spoken_browser_url(raw_address)?;
    Some(KalVoiceIntent::ControlBrowser {
        command: BrowserControl::Navigate {
            url: address,
            browser_id: None,
        },
        workspace_id: None,
    })
}

pub(crate) fn normalize_spoken_browser_url(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty()
        || value.chars().count() > MAX_BROWSER_URL_CHARS
        || value.chars().any(disallowed_browser_url_character)
    {
        return None;
    }
    let lower = value.to_lowercase();
    let candidate = if lower.starts_with("http://") || lower.starts_with("https://") {
        value.to_owned()
    } else if lower == "localhost" {
        "http://localhost/".into()
    } else if let Some(port) = lower.strip_prefix("localhost ") {
        let port = port.trim_end_matches(['.', '!', '?']);
        if port.is_empty() || !port.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        format!("http://localhost:{port}/")
    } else if lower.starts_with("localhost:") {
        format!("http://{value}")
    } else {
        return None;
    };
    let url = Url::parse(&candidate).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.as_str().chars().count() > MAX_BROWSER_URL_CHARS
    {
        return None;
    }
    Some(url.to_string())
}

fn disallowed_browser_url_character(character: char) -> bool {
    character.is_control()
        || matches!(
            character,
            '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}'
        )
}

fn standalone_launch_modifier(tokens: &[String]) -> Option<Understood> {
    if tokens.len() < 9 || tokens[0] != "use" {
        return None;
    }
    let suffix = &tokens[tokens.len() - 7..];
    let [at, effort, effort_word, for_word, all, of, them] = suffix else {
        return None;
    };
    if at != "at"
        || !matches!(
            effort.as_str(),
            "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
        )
        || effort_word != "effort"
        || for_word != "for"
        || all != "all"
        || of != "of"
        || them != "them"
    {
        return None;
    }
    let model_words = &tokens[1..tokens.len() - 7];
    let (provider_id, model_words) = match model_words {
        [alias, ..] if matches!(alias.as_str(), "opus" | "sonnet" | "haiku" | "fable") => {
            (ProviderId::new(ProviderId::CLAUDE_CODE), model_words)
        }
        [claude, code, rest @ ..] if claude == "claude" && code == "code" && !rest.is_empty() => {
            (ProviderId::new(ProviderId::CLAUDE_CODE), rest)
        }
        [claude, ..] if claude == "claude" => {
            (ProviderId::new(ProviderId::CLAUDE_CODE), model_words)
        }
        [provider, rest @ ..] if provider == "codex" && !rest.is_empty() => {
            (ProviderId::new(ProviderId::CODEX), rest)
        }
        [provider, rest @ ..] if provider == "gemini" && !rest.is_empty() => {
            (ProviderId::new(ProviderId::GEMINI_CLI), rest)
        }
        _ => {
            return Some(Understood::Rejected {
                code: "launch_modifier_provider_required",
                message:
                    "Name a Claude, Codex, or Gemini model for the sessions you just launched."
                        .into(),
            });
        }
    };
    Some(Understood::intent(KalVoiceIntent::ConfigureRecentLaunch {
        provider_id,
        model: model_words.join("-"),
        effort: effort.clone(),
    }))
}

/// Full-utterance pane commands, including bounded mixed-provider/account groups. This is
/// deliberately separate from general conjunctions: "and delete files" never becomes an
/// executable continuation of a UI command.
fn pane_request(tokens: &[String]) -> Option<Understood> {
    if tokens.first().is_some_and(|word| word == "retry") {
        return retry_launch(tokens);
    }
    if let Some(rejected) = standalone_launch_modifier(tokens) {
        return Some(rejected);
    }
    if let Some(at) = tokens.windows(2).position(|words| words == ["and", "put"]) {
        let Understood::Intent {
            intent:
                KalVoiceIntent::CreateProviderPanes {
                    mut groups,
                    workspace_id,
                },
            target,
        } = pane_request(&tokens[..at])?
        else {
            return None;
        };
        if groups.len() != 1 {
            return Some(Understood::Rejected {
                code: "launch_assignment_groups_unsupported",
                message: "Name one provider, then say how many agents should work on each task."
                    .into(),
            });
        }
        let mut assignment_words = &tokens[at + 2..];
        if assignment_words.len() >= 9 {
            let suffix = &assignment_words[assignment_words.len() - 9..];
            if suffix[0] == "using"
                && suffix[2] == "at"
                && suffix[4..] == ["effort", "for", "all", "of", "them"]
                && matches!(suffix[1].as_str(), "opus" | "sonnet" | "haiku" | "fable")
                && matches!(
                    suffix[3].as_str(),
                    "low" | "medium" | "high" | "xhigh" | "max"
                )
            {
                if groups[0]
                    .provider_id
                    .as_ref()
                    .is_some_and(|provider| provider.as_str() != ProviderId::CLAUDE_CODE)
                {
                    return Some(Understood::Rejected {
                        code: "model_provider_mismatch",
                        message: "Opus, Sonnet, Haiku, and Fable are Claude Code models.".into(),
                    });
                }
                groups[0].provider_id = Some(ProviderId::new(ProviderId::CLAUDE_CODE));
                groups[0].model = Some(suffix[1].clone());
                groups[0].effort = Some(suffix[3].clone());
                assignment_words = &assignment_words[..assignment_words.len() - 9];
            }
        }
        let assignments = match launch_assignments(assignment_words) {
            Ok(assignments) => assignments,
            Err(rejected) => return Some(*rejected),
        };
        let assigned: u32 = assignments
            .iter()
            .map(|assignment| u32::from(assignment.count))
            .sum();
        if assigned != u32::from(groups[0].count) {
            return Some(Understood::Rejected {
                code: "launch_assignment_count_mismatch",
                message: format!(
                    "The task counts add up to {assigned}, but you asked for {} agents.",
                    groups[0].count
                ),
            });
        }
        groups[0].assignments = assignments;
        return Some(Understood::Intent {
            intent: KalVoiceIntent::CreateProviderPanes {
                groups,
                workspace_id,
            },
            target,
        });
    }
    if tokens.first().is_some_and(|w| w == "use")
        && let Some(at) = tokens.windows(3).position(|w| w == ["to", "work", "on"])
    {
        let mut launch = vec!["open".to_owned()];
        launch.extend_from_slice(&tokens[1..at]);
        launch.push("in".into());
        launch.extend_from_slice(&tokens[at + 3..]);
        return pane_request(&launch);
    }
    let mut words = tokens;
    let mut workspace = None;
    let mut global_account = None;
    let mut global_effort = None;
    if let Some(effort_at) = words.iter().rposition(|word| word == "effort") {
        let suffix = &words[effort_at + 1..];
        let applies_to_all = suffix.is_empty()
            || matches!(suffix, [for_word, all, of, them] if for_word == "for" && all == "all" && of == "of" && them == "them");
        if !applies_to_all || effort_at < 2 || words[effort_at - 2] != "at" {
            return None;
        }
        let effort = words[effort_at - 1].as_str();
        if !matches!(
            effort,
            "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
        ) {
            return Some(Understood::Rejected {
                code: "invalid_effort",
                message: "Choose low, medium, high, xhigh, max, or ultra effort.".into(),
            });
        }
        global_effort = Some(effort.to_owned());
        words = &words[..effort_at - 2];
    }
    let workspace_separator = |candidate: &[String]| {
        candidate.iter().rposition(|word| {
            matches!(word.as_str(), "in" | "inside" | "within")
                || (word == "on"
                    && candidate
                        .last()
                        .is_some_and(|last| matches!(last.as_str(), "workspace" | "project")))
        })
    };
    if let Some(workspace_at) = workspace_separator(words)
        && let Some(account_at) = words.iter().rposition(|w| w == "using")
        && account_at > workspace_at
    {
        let mut account = &words[account_at + 1..];
        if account
            .first()
            .is_some_and(|w| matches!(w.as_str(), "my" | "the"))
        {
            account = &account[1..];
        }
        if account.last().is_some_and(|w| w == "account") {
            account = &account[..account.len() - 1];
        }
        if account.is_empty() || account.iter().any(|w| is_conjunction(w)) {
            return None;
        }
        global_account = Some(account.join(" "));
        words = &words[..account_at];
    }
    if let Some(at) = workspace_separator(words) {
        let mut name = &words[at + 1..];
        if name
            .first()
            .is_some_and(|w| matches!(w.as_str(), "my" | "the"))
        {
            name = &name[1..];
        }
        if name
            .last()
            .is_some_and(|w| matches!(w.as_str(), "workspace" | "project"))
        {
            name = &name[..name.len() - 1];
        }
        if name.is_empty() || name.iter().any(|w| is_conjunction(w)) {
            return None;
        }
        workspace = Some(NamedTarget::Workspace(name.join(" ")));
        words = &words[..at];
    }
    // "Make it bigger" is the focused pane; "make that one bigger" doesn't say which pane.
    if words.first().is_some_and(|w| w == "make")
        && words.len() >= 3
        && let Some(grow) = match words.last()?.as_str() {
            "bigger" | "larger" => Some(true),
            "smaller" => Some(false),
            _ => None,
        }
    {
        match words[1..words.len() - 1].join(" ").as_str() {
            "it" | "this" | "this one" => {
                return Some(Understood::intent(KalVoiceIntent::Resize {
                    direction: if grow {
                        PaneDirection::Right
                    } else {
                        PaneDirection::Left
                    },
                    steps: 2,
                }));
            }
            "that" | "that one" | "them" => {
                return Some(Understood::Rejected {
                    code: "target_unclear",
                    message:
                        "Say which pane, or focus it and say \u{201c}make this bigger\u{201d}."
                            .into(),
                });
            }
            _ => {}
        }
    }
    let control = if words.first().is_some_and(|w| w == "make") && words.len() >= 3 {
        match words.last()?.as_str() {
            "bigger" | "larger" => Some(PaneControl::Resize {
                query: words[1..words.len() - 1].join(" "),
                grow: true,
            }),
            "smaller" => Some(PaneControl::Resize {
                query: words[1..words.len() - 1].join(" "),
                grow: false,
            }),
            _ => None,
        }
    } else if words.first().is_some_and(|w| w == "move") {
        words
            .iter()
            .position(|w| w == "beside")
            .filter(|at| *at > 1 && *at + 1 < words.len())
            .map(|at| PaneControl::Move {
                query: words[1..at].join(" "),
                beside: words[at + 1..].join(" "),
            })
    } else {
        let query = words
            .get(1..)
            .filter(|w| !w.is_empty())
            .map(|w| w.join(" "));
        let query =
            query.filter(|q| !matches!(q.as_str(), "this pane" | "the pane" | "this terminal"));
        match words.first()?.as_str() {
            "maximize" => Some(PaneControl::Maximize { query }),
            "restore" => Some(PaneControl::Restore { query }),
            "collapse" | "minimize" => Some(PaneControl::Collapse { query }),
            "expand" => Some(PaneControl::Expand { query }),
            _ => None,
        }
    };
    if let Some(command) = control {
        if words.iter().any(|w| is_conjunction(w)) {
            return None;
        }
        return Some(Understood::Intent {
            intent: KalVoiceIntent::ControlPane {
                command,
                workspace_id: None,
            },
            target: workspace,
        });
    }
    let prefix = match words {
        [first, second, ..]
            if (first == "give" && second == "me") || (first == "spin" && second == "up") =>
        {
            2
        }
        [first, ..]
            if matches!(
                first.as_str(),
                "open" | "start" | "create" | "launch" | "add" | "new"
            ) =>
        {
            1
        }
        _ => return None,
    };
    words = &words[prefix..];
    if words.is_empty() {
        return None;
    }
    let mut groups = Vec::new();
    let mut previous_provider = None;
    let mut total: u32 = 0;
    for segment in words.split(|w| w == "and") {
        if segment.is_empty() {
            return None;
        }
        let mut rest = segment;
        let count = rest.first().and_then(|w| count_word(w)).unwrap_or(1);
        if rest.first().and_then(|w| count_word(w)).is_some() {
            rest = &rest[1..];
        }
        if rest
            .first()
            .is_some_and(|w| matches!(w.as_str(), "new" | "more" | "additional" | "fresh"))
        {
            rest = &rest[1..];
        }
        let mut provider = None;
        for len in [2, 1] {
            if rest.len() >= len
                && let Some(id) = provider_words(&rest[..len])
            {
                provider = Some(ProviderId::new(id));
                rest = &rest[len..];
                break;
            }
        }
        let mut model = if provider
            .as_ref()
            .is_some_and(|p| p.as_str() == ProviderId::CLAUDE_CODE)
            && rest
                .first()
                .is_some_and(|w| matches!(w.as_str(), "opus" | "sonnet" | "haiku" | "fable"))
        {
            let model = Some(rest[0].clone());
            rest = &rest[1..];
            model
        } else {
            None
        };
        let coding = rest.first().is_some_and(|w| w == "coding");
        if coding {
            rest = &rest[1..];
        }
        let noun = rest.first().is_some_and(|w| {
            matches!(
                w.as_str(),
                "thread"
                    | "threads"
                    | "terminal"
                    | "terminals"
                    | "pane"
                    | "panes"
                    | "agent"
                    | "agents"
                    | "session"
                    | "sessions"
            )
        });
        let default_agents = coding
            || rest
                .first()
                .is_some_and(|w| matches!(w.as_str(), "agent" | "agents"));
        if noun {
            rest = &rest[1..];
        }
        // Keep model and account clauses distinct. Cursor's catalog is discovered at runtime;
        // these words are only a lookup query, never a static assertion of model availability.
        let model_at = rest
            .windows(2)
            .position(|pair| matches!(pair[0].as_str(), "using" | "with") && pair[1] == "model")
            .or_else(|| {
                (provider
                    .as_ref()
                    .is_some_and(|id| id.as_str() == ProviderId::CURSOR))
                .then(|| rest.iter().position(|word| word == "with"))
                .flatten()
                .filter(|at| {
                    rest.get(at + 1)
                        .is_some_and(|word| !matches!(word.as_str(), "cursor" | "my" | "the"))
                        && !rest.last().is_some_and(|word| word == "account")
                })
            });
        if let Some(at) = model_at {
            let start = at
                + if rest.get(at + 1).is_some_and(|word| word == "model") {
                    2
                } else {
                    1
                };
            let end = rest[start..]
                .iter()
                .position(|word| matches!(word.as_str(), "using" | "on"))
                .map_or(rest.len(), |offset| start + offset);
            if start == end || rest[start..end].iter().any(|word| is_conjunction(word)) {
                return None;
            }
            model = Some(rest[start..end].join("-"));
            if at == 0 {
                rest = &rest[end..];
            } else if end == rest.len() {
                rest = &rest[..at];
            } else {
                return None;
            }
        }
        if provider.is_none() && !default_agents && previous_provider.is_none() {
            return None;
        }
        let account_query = if rest.is_empty() {
            global_account.clone()
        } else {
            if !matches!(rest[0].as_str(), "using" | "on" | "with") {
                return None;
            }
            rest = &rest[1..];
            if rest
                .first()
                .is_some_and(|w| matches!(w.as_str(), "my" | "the"))
            {
                rest = &rest[1..];
            }
            if rest.last().is_some_and(|w| w == "account") {
                rest = &rest[..rest.len() - 1];
            }
            if rest.is_empty() || rest.iter().any(|w| is_conjunction(w)) {
                return None;
            }
            Some(rest.join(" "))
        };
        let count = match check_count(count) {
            Ok(count) => count,
            Err(error) => return Some(*error),
        };
        total = total.saturating_add(u32::from(count));
        if let Err(error) = check_count(total) {
            return Some(*error);
        }
        let provider_id = provider.or_else(|| previous_provider.clone());
        previous_provider = provider_id.clone();
        groups.push(ProviderPaneRequest {
            provider_id,
            count,
            account_query,
            model,
            effort: global_effort.clone(),
            assignments: Vec::new(),
        });
    }
    Some(Understood::Intent {
        intent: KalVoiceIntent::CreateProviderPanes {
            groups,
            workspace_id: None,
        },
        target: workspace,
    })
}

fn retry_launch(tokens: &[String]) -> Option<Understood> {
    if tokens.get(2).is_some_and(|token| token == "groups") {
        if tokens.len() != 4
            || tokens[3].is_empty()
            || tokens[3].len() > 8_192
            || !tokens[3].len().is_multiple_of(2)
            || !tokens[3].bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return None;
        }
        let payload = (0..tokens[3].len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&tokens[3][index..index + 2], 16))
            .collect::<Result<Vec<_>, _>>()
            .ok()?;
        let groups = serde_json::from_slice::<Vec<ProviderPaneRequest>>(&payload).ok()?;
        let total = groups
            .iter()
            .map(|group| u32::from(group.count))
            .sum::<u32>();
        if groups.is_empty()
            || groups.len() > usize::try_from(MAX_THREADS_PER_REQUEST).ok()?
            || check_count(total).is_err()
            || groups.iter().any(|group| {
                group.count == 0
                    || (!group.assignments.is_empty()
                        && (group
                            .assignments
                            .iter()
                            .map(|assignment| u32::from(assignment.count))
                            .sum::<u32>()
                            != u32::from(group.count)
                            || group
                                .assignments
                                .iter()
                                .any(|assignment| assignment.task.trim().is_empty())))
            })
        {
            return None;
        }
        return Some(Understood::intent(KalVoiceIntent::CreateProviderPanes {
            groups,
            workspace_id: None,
        }));
    }
    if tokens.len() < 11
        || tokens[1] != "launch"
        || tokens[4] != "account"
        || tokens[6] != "model"
        || tokens[8] != "effort"
        || tokens[10] != "tasks"
    {
        return None;
    }
    let count = tokens[2]
        .parse::<u32>()
        .ok()
        .and_then(|count| check_count(count).ok())?;
    let provider_id = ProviderId::new(match tokens[3].as_str() {
        "claude" => ProviderId::CLAUDE_CODE,
        "codex" => ProviderId::CODEX,
        "cursor" => ProviderId::CURSOR,
        "gemini" => ProviderId::GEMINI_CLI,
        _ => return None,
    });
    let compact_id = &tokens[5];
    if compact_id.len() != 32 || !compact_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let account_query = format!(
        "{}-{}-{}-{}-{}",
        &compact_id[..8],
        &compact_id[8..12],
        &compact_id[12..16],
        &compact_id[16..20],
        &compact_id[20..]
    );
    if !kalcode_contracts::ids::is_valid_id(&account_query) {
        return None;
    }
    let decode = |value: &str| {
        if value == "none" {
            return Some(None);
        }
        if !value.len().is_multiple_of(2) || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        let bytes = (0..value.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&value[index..index + 2], 16))
            .collect::<Result<Vec<_>, _>>()
            .ok()?;
        String::from_utf8(bytes).ok().map(Some)
    };
    let model = decode(&tokens[7])?;
    let effort = decode(&tokens[9])?;
    let mut assignments = Vec::new();
    if tokens[11..] != ["none"] {
        let (chunks, remainder) = tokens[11..].as_chunks::<2>();
        for chunk in chunks {
            let assignment_count = chunk[0].parse::<u32>().ok()?;
            let assignment_count = check_count(assignment_count).ok()?;
            let task = decode(&chunk[1])??;
            assignments.push(AgentLaunchAssignment {
                count: assignment_count,
                task,
            });
        }
        if !remainder.is_empty()
            || assignments
                .iter()
                .map(|assignment| u32::from(assignment.count))
                .sum::<u32>()
                != u32::from(count)
        {
            return None;
        }
    }
    Some(Understood::intent(KalVoiceIntent::CreateProviderPanes {
        groups: vec![ProviderPaneRequest {
            provider_id: Some(provider_id),
            count,
            account_query: Some(account_query),
            model,
            effort,
            assignments,
        }],
        workspace_id: None,
    }))
}

fn launch_assignments(tokens: &[String]) -> Result<Vec<AgentLaunchAssignment>, Box<Understood>> {
    let mut assignments = Vec::new();
    let mut cursor = 0;
    while cursor < tokens.len() {
        if tokens[cursor] == "and" {
            cursor += 1;
        }
        let Some(count) = tokens.get(cursor).and_then(|word| count_word(word)) else {
            return Err(Box::new(Understood::Rejected {
                code: "launch_assignment_invalid",
                message: "Say each assignment like â€œtwo on frontendâ€.".into(),
            }));
        };
        let count = check_count(count)?;
        cursor += 1;
        if !tokens
            .get(cursor)
            .is_some_and(|word| matches!(word.as_str(), "on" | "to"))
        {
            return Err(Box::new(Understood::Rejected {
                code: "launch_assignment_invalid",
                message: "Say each assignment like â€œtwo on frontendâ€.".into(),
            }));
        }
        cursor += 1;
        if tokens
            .get(cursor)
            .is_some_and(|word| matches!(word.as_str(), "the" | "my"))
        {
            cursor += 1;
        }
        let task_start = cursor;
        while cursor < tokens.len() {
            let next_group = tokens[cursor] == "and"
                && tokens
                    .get(cursor + 1)
                    .and_then(|word| count_word(word))
                    .is_some()
                || (count_word(&tokens[cursor]).is_some()
                    && tokens
                        .get(cursor + 1)
                        .is_some_and(|word| matches!(word.as_str(), "on" | "to")));
            if next_group {
                break;
            }
            cursor += 1;
        }
        if task_start == cursor {
            return Err(Box::new(Understood::Rejected {
                code: "launch_assignment_invalid",
                message: "Name the task for every group of agents.".into(),
            }));
        }
        assignments.push(AgentLaunchAssignment {
            count,
            task: tokens[task_start..cursor].join(" "),
        });
    }
    if assignments.is_empty() {
        return Err(Box::new(Understood::Rejected {
            code: "launch_assignment_invalid",
            message: "Name at least one task for the agents.".into(),
        }));
    }
    Ok(assignments)
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
        KalVoiceIntent::CreateProviderPanes { groups, .. } => KalVoiceIntent::CreateProviderPanes {
            groups,
            workspace_id: Some(id),
        },
        KalVoiceIntent::ControlPane { command, .. } => KalVoiceIntent::ControlPane {
            command,
            workspace_id: Some(id),
        },
        KalVoiceIntent::CreateThreads {
            provider_id,
            count,
            account_query,
            model,
            effort,
            assignments,
            ..
        } => KalVoiceIntent::CreateThreads {
            provider_id,
            count,
            workspace_id: Some(id),
            account_query,
            model,
            effort,
            assignments,
        },
        KalVoiceIntent::CreateTerminal { .. } => KalVoiceIntent::CreateTerminal {
            workspace_id: Some(id),
        },
        KalVoiceIntent::SetWorkspaceAccount {
            provider_id,
            account_query,
            ..
        } => KalVoiceIntent::SetWorkspaceAccount {
            provider_id,
            account_query,
            workspace_id: Some(id),
        },
        KalVoiceIntent::PauseThreads { scope } => KalVoiceIntent::PauseThreads {
            scope: bind_scope(scope),
        },
        KalVoiceIntent::ResumeThreads { scope } => KalVoiceIntent::ResumeThreads {
            scope: bind_scope(scope),
        },
        KalVoiceIntent::StopThreads {
            scope,
            expected_count,
        } => KalVoiceIntent::StopThreads {
            scope: bind_scope(scope),
            expected_count,
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

/// Requests with negation or multiple actions must never be turned into an executable action by
/// local model inference. The deterministic grammar may still accept its closed set of safe pane
/// arrangements containing `and`; this guard applies only after a request fell through to local
/// reasoning.
pub(crate) fn local_reasoning_must_refuse(text: &str) -> bool {
    normalize(text)
        .iter()
        .any(|token| is_negation(token) || is_conjunction(token))
}

/// Closed action evidence that the host grammar can prove from the request while still leaving
/// the final choice to the local interpreter. These values contain no executable model output:
/// the host turns them into typed intents only after the model returns an opaque offered ID.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum LocalReasoningGrounding {
    ShowApprovals,
    StatusReport,
    Navigate(SurfaceId),
    OpenWorkspace(String),
}

/// Extracts only exact, whole-request evidence from commands which the deterministic grammar did
/// not already understand. This deliberately remains a small extension of the canonical grammar:
/// it reuses normalization and filler handling, never accepts negation or compound commands, and
/// cannot invent an action, workspace, provider, URL, query, or other argument.
pub(crate) fn local_reasoning_groundings(text: &str) -> Vec<LocalReasoningGrounding> {
    if local_reasoning_must_refuse(text)
        || !matches!(
            understand(text),
            Understood::Intent {
                intent: KalVoiceIntent::Reasoning { .. },
                ..
            }
        )
    {
        return Vec::new();
    }

    let tokens = normalize(text);
    let words = strip_filler(&tokens)
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>();
    match words.as_slice() {
        // "Approval status" is intentionally offered as two closed interpretations. The local
        // model can disambiguate them, but it cannot construct a third action.
        ["pull", "up", "approval", "status"]
        | ["bring", "up", "approval", "status"]
        | ["let", "me", "see", "approval", "status"] => vec![
            LocalReasoningGrounding::ShowApprovals,
            LocalReasoningGrounding::StatusReport,
        ],
        [
            "pull" | "bring",
            "up",
            "approval" | "approvals" | "permission" | "permissions",
        ]
        | [
            "let",
            "me",
            "see",
            "approval" | "approvals" | "permission" | "permissions",
        ] => vec![LocalReasoningGrounding::ShowApprovals],
        [
            "pull" | "bring",
            "up",
            "thread" | "threads" | "agent" | "agents",
            "status",
        ]
        | [
            "let",
            "me",
            "see",
            "thread" | "threads" | "agent" | "agents",
            "status",
        ] => vec![LocalReasoningGrounding::StatusReport],
        _ => local_reasoning_navigation_grounding(&words)
            .or_else(|| local_reasoning_workspace_grounding(&words))
            .into_iter()
            .collect(),
    }
}

fn local_reasoning_navigation_grounding(words: &[&str]) -> Option<LocalReasoningGrounding> {
    let surface = match words {
        ["bring", "me", "to", surface @ ..]
        | ["take", "me", "over", "to", surface @ ..]
        | ["pull", "up", surface @ ..]
        | ["let", "me", "see", surface @ ..] => surface,
        _ => return None,
    };
    surface_name(&surface.join(" ")).map(LocalReasoningGrounding::Navigate)
}

fn local_reasoning_workspace_grounding(words: &[&str]) -> Option<LocalReasoningGrounding> {
    let name = match words {
        [
            "put",
            "me",
            "in",
            "the" | "my",
            "workspace" | "project",
            name @ ..,
        ]
        | [
            "take",
            "me",
            "into",
            "the" | "my",
            "workspace" | "project",
            name @ ..,
        ]
        | [
            "let",
            "me",
            "into",
            "the" | "my",
            "workspace" | "project",
            name @ ..,
        ] => name,
        ["put", "me", "in", "workspace" | "project", name @ ..]
        | ["take", "me", "into", "workspace" | "project", name @ ..]
        | ["let", "me", "into", "workspace" | "project", name @ ..] => name,
        _ => return None,
    };
    (!name.is_empty()).then(|| LocalReasoningGrounding::OpenWorkspace(name.join(" ")))
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

/// [`TRAILING_FILLER`] without "for me", for phrases where it names the person ("agents waiting
/// for me").
const TRAILING_FILLER_KEEPING_ME: &[&[&str]] = &[
    &["please"],
    &["right", "now"],
    &["now"],
    &["thanks"],
    &["thank", "you"],
    &["kalvoice"],
    &["asap"],
];

fn strip_filler(tokens: &[String]) -> &[String] {
    strip_filler_with(tokens, TRAILING_FILLER)
}

fn strip_filler_with<'a>(tokens: &'a [String], trailing: &[&[&str]]) -> &'a [String] {
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
        for phrase in trailing {
            // "Go to KalVoice" names the surface: the wake word is only filler at the end of a
            // request that doesn't point at it ("open settings, KalVoice").
            let names_surface = *phrase == ["kalvoice"]
                && end >= start + 2
                && matches!(
                    tokens[end - 2].as_str(),
                    "to" | "open" | "show" | "the" | "my" | "view" | "display" | "launch"
                );
            if !names_surface && phrase_at(&tokens[start..end], phrase, false) {
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
// Syntax: `word` literal Â· `(a b|c)` alternatives Â· `[a|b c]` optional Â· `<count>`, `<provider>`,
// `<surface>`, `<account>`, `<name>` slots. A pattern must consume every token.

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
    /// A provider-led account label ("gemini b", "codex work"): a provider name followed by at
    /// least one more word that isn't a thread, pane, mode or scope word.
    Account,
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
    /// The provider an `<account>` slot started with, and the whole spoken label.
    account_provider: Option<&'static str>,
    account: Option<String>,
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
                    "account" => Slot::Account,
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
        Slot::Account => {
            // The longest provider name wins, so "gemini cli" never leaves "cli" as a label.
            let provider = [2, 1].into_iter().find_map(|len| {
                (tokens.len() >= len)
                    .then(|| provider_words(&tokens[..len]).map(|id| (len, id)))
                    .flatten()
            });
            if let Some((len, id)) = provider
                && tokens.get(len).is_some_and(|w| !is_account_stop_word(w))
            {
                // Shortest first, so optional trailing words ("â€¦ account") are not swallowed.
                for end in len + 1..=tokens.len() {
                    let label = tokens[..end].join(" ");
                    out.push((
                        end,
                        Box::new(move |c: &mut Caps| {
                            c.account_provider = Some(id);
                            c.account = Some(label.clone());
                        }),
                    ));
                }
            }
        }
        Slot::Name => {
            // Shortest first, so optional trailing words ("â€¦ workspace") are not swallowed.
            for len in 1..=tokens.len() {
                let words = &tokens[..len];
                // A name never starts with an article or pronoun ("show me the X thread"), nor
                // with "up" or "called" ("open up the kalcode project", "the thread called X").
                if matches!(
                    words[0].as_str(),
                    "the" | "a" | "an" | "me" | "up" | "called" | "named"
                ) {
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

/// "twenty one", "thirty five", "one hundred" â€” only so larger numbers are refused clearly.
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
        "cursor" | "cursor cli" => ProviderId::CURSOR,
        "gemini cli" | "gemini" => ProviderId::GEMINI_CLI,
        _ => return None,
    })
}

/// Words that can't start an account label after a provider name: "switch to Codex threads" or
/// "use Gemini in this workspace" name no account.
fn is_account_stop_word(word: &str) -> bool {
    matches!(
        word,
        "thread"
            | "threads"
            | "session"
            | "sessions"
            | "agent"
            | "agents"
            | "terminal"
            | "terminals"
            | "pane"
            | "panes"
            | "mode"
            | "workspace"
            | "project"
            | "account"
            | "accounts"
            | "in"
            | "inside"
            | "for"
            | "on"
            | "to"
            | "with"
            | "using"
    )
}

fn surface_words(words: &[String]) -> Option<SurfaceId> {
    surface_name(&words.join(" "))
}

fn surface_name(name: &str) -> Option<SurfaceId> {
    Some(match name {
        "dashboard" | "home" | "overview" => SurfaceId::Dashboard,
        "operations" => SurfaceId::Operations,
        "kalvoice" | "kal voice" | "voice" => SurfaceId::KalVoice,
        "code" | "code mode" | "editor" => SurfaceId::Code,
        "threads" => SurfaceId::Threads,
        // Agents are coding agents (AGENTS.md); their Fleet is on the Dashboard. The gated
        // Agents page is not where they live.
        "agents" | "agent fleet" | "coding agents" => SurfaceId::Dashboard,
        "missions" => SurfaceId::Missions,
        "automations" => SurfaceId::Automations,
        "skills" => SurfaceId::Skills,
        "plugins" | "integrations" => SurfaceId::Plugins,
        "memory" | "memories" => SurfaceId::Memory,
        "providers" | "provider accounts" => SurfaceId::Providers,
        "command center" => SurfaceId::CommandCenter,
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
    // Provider switching isn't in this build (the executor refuses it), so in a focused text
    // box "switch to Codex" is typed as words rather than run as a command that fails.
    "switch to <provider>",
];

const OPEN_VERB: &str =
    "(open|start|create|launch|spin up|spin|make|add|new|fire up|kick off|begin|give me)";
const IN_WORKSPACE: &str =
    "(in|for|on|inside) [the] [workspace|project] <name> [workspace|project]";
const THREAD_WORD: &str =
    "(thread|threads|session|sessions|agent|agents|terminal|terminals|pane|panes)";
/// States a pause or stop names: every running session. A narrower state ("stop all idle
/// agents", "stop the stuck ones") is never read as "stop everything": idle agents close through
/// KalTidy (`grammar_agents`), and anything else is not a deterministic command.
const RUNNING_STATE: &str = "(active|running|current|open|working|busy)";
/// States a resume names: every paused or stopped session.
const RESUMABLE_STATE: &str = "(paused|stopped|current|open)";

fn rules() -> &'static [Rule] {
    static RULES: OnceLock<Vec<Rule>> = OnceLock::new();
    RULES.get_or_init(build_rules)
}

fn agent_rules() -> &'static [Rule] {
    static RULES: OnceLock<Vec<Rule>> = OnceLock::new();
    RULES.get_or_init(|| {
        let mut rules = Vec::new();
        agents::agent_rules(&mut |pattern: String, build: Build| {
            rules.push(rule(pattern, build));
        });
        rules
    })
}

fn state_rules() -> &'static [Rule] {
    static RULES: OnceLock<Vec<Rule>> = OnceLock::new();
    RULES.get_or_init(|| {
        let mut rules = Vec::new();
        sessions::state_rules(&mut |pattern: String, build: Build| {
            rules.push(rule(pattern, build));
        });
        rules
    })
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

    // Agents-tab filters without an agent noun ("show everything waiting for me"; the noun
    // forms are agent rules). After approvals, so "show what's waiting for me" still opens the
    // approvals panel; before navigation, whose bare "<surface>" forms they never overlap.
    agents::late_filter_rules(&mut add);

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

    // Change the provider selected for the next thread or provider pane. Provider names are a
    // closed local vocabulary, so this never starts a provider process or guesses an account.
    // Low confidence (`LOW_CONFIDENCE`): refused in this build, so dictation keeps the words.
    add(
        "switch to <provider>".into(),
        Box::new(|c| match c.provider {
            Some(provider) => Understood::intent(KalVoiceIntent::SwitchProvider {
                provider_id: ProviderId::new(provider),
            }),
            None => Understood::reasoning(""),
        }),
    );

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
    thread_control(&mut add, "(pause|suspend|hold)", RUNNING_STATE, |scope| {
        KalVoiceIntent::PauseThreads { scope }
    });
    thread_control(
        &mut add,
        "(resume|unpause|continue)",
        RESUMABLE_STATE,
        |scope| KalVoiceIntent::ResumeThreads { scope },
    );
    thread_control(
        &mut add,
        "(stop|halt|kill|end|terminate|cancel|shut down)",
        RUNNING_STATE,
        |scope| KalVoiceIntent::StopThreads {
            scope,
            expected_count: None,
        },
    );
    counted_stop(&mut add, "(stop|halt|kill|end|terminate|cancel|shut down)");

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
            Err(rejected) => *rejected,
            Ok(_) => Understood::Rejected {
                code: "provider_not_specified",
                message: "Say which provider to use: Claude Code, Codex, Cursor or Gemini CLI. For example, \u{201c}open two Codex threads\u{201d}.".into(),
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

    // Search sessions (the Session Locator, Z7-W2). The query goes to the local index only and
    // is never stored; KalVoice reads back names and statuses, never content.
    for p in [
        "(search|look) (for|up) <name>",
        "search [my|the] (threads|sessions|workspaces|everything) (for|about) <name>",
        "find [me] [the|my] (thread|session|workspace|project|terminal) (about|for|called|named) <name>",
        "find [me] [the|my] (thread|session|workspace|project) <name>",
    ] {
        add(
            p.into(),
            Box::new(|c| {
                Understood::intent(KalVoiceIntent::Search {
                    query: c.names.first().cloned().unwrap_or_default(),
                })
            }),
        );
    }
    // "What was I working on yesterday?" â€” recent work, answered from the event log.
    for (when, query) in [
        ("yesterday", "yesterday"),
        ("today", "today"),
        ("this week", "this week"),
        ("last week", "last week"),
        ("lately", "recent"),
        ("recently", "recent"),
    ] {
        for p in [
            format!("what (was|were) (i|we) (working on|doing) {when}"),
            format!("what did (i|we) (work on|do) {when}"),
            format!("(find|show|show me|find me) what (i|we) (was|were) (working on|doing) {when}"),
            format!("(find|show|show me) [my] (recent work|work) [from] {when}"),
        ] {
            let query = query.to_owned();
            add(
                p,
                Box::new(move |_| {
                    Understood::intent(KalVoiceIntent::Search {
                        query: query.clone(),
                    })
                }),
            );
        }
    }
    for p in [
        "what (was|were) (i|we) (working on|doing)",
        "(find|show|show me) what (i|we) (was|were) (working on|doing)",
        "(show|show me) [my] recent work",
    ] {
        add(
            p.into(),
            Box::new(|_| {
                Understood::intent(KalVoiceIntent::Search {
                    query: "recent".into(),
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
        add(p, Box::new(|_| bypass_refused()));
    }

    // Provider accounts (0.1.5). Last, so thread permission modes ("switch the X thread to plan
    // mode"), Bypass refusals and "switch to <provider>" keep their meaning; an account label
    // needs at least one word after the provider ("switch to Gemini B").
    account_rules(&mut add);

    rules
}

/// "This thread", as the focused thread (`thread_query: None`).
const THIS_THREAD: &str = "(this|the|current|the current|this current|my current|my)";
/// "This workspace", as the active workspace (`workspace_id: None`).
const THIS_WORKSPACE: &str =
    "(this|the|current|the current|this current|my current|my) (workspace|project)";

fn account_rules(add: &mut impl FnMut(String, Build)) {
    // Rebinding a thread only ever asks: the person confirms KalCode's Rebind dialog.
    let focused_named = |c: &Caps| {
        rebind(
            None,
            c.provider,
            c.names.first().cloned().unwrap_or_default(),
        )
    };
    let focused_spoken = |c: &Caps| {
        rebind(
            None,
            c.account_provider,
            c.account.clone().unwrap_or_default(),
        )
    };
    // "Switch this Gemini thread to Gemini B." / "switch the thread to my work account"
    add(
        format!("switch [{THIS_THREAD}] [<provider>] thread to [my|the] <name> [account]"),
        Box::new(focused_named),
    );
    // "Switch to Gemini A." / "switch gemini b": a provider-led label, never a bare provider.
    add(
        "switch [to] [my|the] <account> [account]".into(),
        Box::new(focused_spoken),
    );
    // "Switch to my work account." (no provider: the thread's own provider).
    add(
        "switch to [my|the] <name> account".into(),
        Box::new(focused_named),
    );
    // "Switch the login fix thread to Gemini B."
    add(
        "switch [the|my] <name> thread to [my|the] <name> [account]".into(),
        Box::new(|c: &Caps| {
            rebind(
                c.names.first().cloned(),
                None,
                c.names.get(1).cloned().unwrap_or_default(),
            )
        }),
    );
    // "Use Codex work for this thread."
    add(
        format!("use [my|the] <account> [account] (for|in|on) {THIS_THREAD} thread"),
        Box::new(focused_spoken),
    );
    add(
        format!("use [my|the] <name> account (for|in|on) {THIS_THREAD} thread"),
        Box::new(focused_named),
    );

    // A workspace default is metadata only; starting a thread still needs that account signed in.
    // "Use Gemini A in this workspace." (before the named form, which would read "this" as a name)
    add(
        format!("use [my|the] <account> [account] (in|for|on) {THIS_WORKSPACE}"),
        Box::new(|c: &Caps| workspace_account(c, None)),
    );
    add(
        format!("use [my|the] <account> [account] {IN_WORKSPACE}"),
        Box::new(|c: &Caps| workspace_account(c, c.names.first())),
    );
    // Without a provider the account can't be told apart from another provider's: ask.
    for p in [
        format!("use [my|the] <name> account (in|for|on) {THIS_WORKSPACE}"),
        format!("use [my|the] <name> account {IN_WORKSPACE}"),
    ] {
        add(
            p,
            Box::new(|_| {
                Understood::Rejected {
                code: "provider_not_specified",
                message: "Say which provider's account, for example \u{201c}use Gemini A in this workspace\u{201d}.".into(),
            }
            }),
        );
    }

    // "Open a new Codex thread with my work account." Threads only: panes keep the pane grammar.
    add(
        format!(
            "{OPEN_VERB} [up] [<count>] [new|more|additional|fresh] <provider> (thread|threads) (with|using) [my|the] <name> [account] [{IN_WORKSPACE}]"
        ),
        Box::new(|c: &Caps| {
            let count = match check_count(c.count.unwrap_or(1)) {
                Ok(count) => count,
                Err(rejected) => return *rejected,
            };
            let (Some(provider), Some(account)) = (c.provider, c.names.first()) else {
                return Understood::reasoning("");
            };
            if let Some(not_account) = not_an_account(account) {
                return not_account;
            }
            with_workspace(
                KalVoiceIntent::CreateThreads {
                    provider_id: ProviderId::new(provider),
                    count,
                    workspace_id: None,
                    account_query: Some(account.clone()),
                    model: None,
                    effort: None,
                    assignments: Vec::new(),
                },
                c.names.get(1),
            )
        }),
    );
}

/// Words that are never an account label: permission modes and model names. "Switch this
/// thread to plan" keeps its old meaning (not a command) and "â€¦ to bypass" is refused, instead of
/// looking for an account called "plan" or "bypass".
const NOT_AN_ACCOUNT: &[&str] = &[
    "mode",
    "plan",
    "approve",
    "auto",
    "custom",
    "bypass",
    "permission",
    "permissions",
    "pro",
    "flash",
    "opus",
    "sonnet",
    "haiku",
    "mini",
    "model",
];

/// Why an account slot holds no account: `Some(refusal)` for Bypass, `Some(reasoning)` for a mode
/// or model word, `None` when it may be an account label.
fn not_an_account(account_query: &str) -> Option<Understood> {
    let words: Vec<&str> = account_query.split(' ').collect();
    if words.contains(&"bypass") {
        return Some(bypass_refused());
    }
    (account_query.is_empty() || words.iter().any(|w| NOT_AN_ACCOUNT.contains(w)))
        .then(|| Understood::reasoning(""))
}

fn bypass_refused() -> Understood {
    Understood::Rejected {
        code: "bypass_not_allowed",
        message: "KalVoice can't turn on Bypass. Only you can, in the thread's permission menu."
            .into(),
    }
}

/// A rebind request, or reasoning when the "account" is really a mode or model ("â€¦ to fast
/// mode", "â€¦ to plan", "â€¦ to Gemini Pro"); Bypass is refused.
fn rebind(
    thread_query: Option<String>,
    provider: Option<&'static str>,
    account_query: String,
) -> Understood {
    if let Some(not_account) = not_an_account(&account_query) {
        return not_account;
    }
    Understood::intent(KalVoiceIntent::RebindThreadAccount {
        thread_query,
        provider_id: provider.map(ProviderId::new),
        account_query,
    })
}

fn workspace_account(c: &Caps, workspace: Option<&String>) -> Understood {
    let (Some(provider), Some(account)) = (c.account_provider, c.account.clone()) else {
        return Understood::reasoning("");
    };
    if let Some(not_account) = not_an_account(&account) {
        return not_account;
    }
    with_workspace(
        KalVoiceIntent::SetWorkspaceAccount {
            provider_id: ProviderId::new(provider),
            account_query: account,
            workspace_id: None,
        },
        workspace,
    )
}

/// Verbs for asking a thread's permission mode to change.
const MODE_VERB: &str = "(switch|change|put|set|move)";

fn thread_control(
    add: &mut impl FnMut(String, Build),
    verb: &str,
    state: &str,
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
        format!("{verb} (all|every|each) [of] [the|my] [{state}] {THREAD_WORD} [{IN_WORKSPACE}]"),
        Box::new(all_or_workspace),
    );
    add(
        format!("{verb} [the|my] [{state}] (threads|agents|sessions) [{IN_WORKSPACE}]"),
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

fn counted_stop(add: &mut impl FnMut(String, Build), verb: &str) {
    add(
        format!("{verb} [the|my] <count> [{RUNNING_STATE}] {THREAD_WORD} [{IN_WORKSPACE}]"),
        Box::new(|c| {
            let count = match check_count(c.count.unwrap_or_default()) {
                Ok(count) => count,
                Err(rejected) => return *rejected,
            };
            Understood::Intent {
                intent: KalVoiceIntent::StopThreads {
                    scope: if c.names.is_empty() {
                        ThreadScope::All
                    } else {
                        ThreadScope::Workspace {
                            workspace_id: String::new(),
                        }
                    },
                    expected_count: Some(count),
                },
                target: c.names.first().cloned().map(NamedTarget::Workspace),
            }
        }),
    );
}

fn with_workspace(intent: KalVoiceIntent, name: Option<&String>) -> Understood {
    Understood::Intent {
        intent,
        target: name.cloned().map(NamedTarget::Workspace),
    }
}

fn check_count(count: u32) -> Result<u8, Box<Understood>> {
    if count == 0 {
        return Err(Box::new(Understood::Rejected {
            code: "thread_count_invalid",
            message: "Say how many threads to open, from one to twenty.".into(),
        }));
    }
    if count > MAX_THREADS_PER_REQUEST {
        return Err(Box::new(Understood::Rejected {
            code: "thread_count_too_large",
            message: format!(
                "KalVoice opens at most {MAX_THREADS_PER_REQUEST} threads per request. Ask for {MAX_THREADS_PER_REQUEST} or fewer."
            ),
        }));
    }
    u8::try_from(count).map_err(|_| {
        Box::new(Understood::Rejected {
            code: "thread_count_too_large",
            message: String::new(),
        })
    })
}

fn create_threads(c: &Caps) -> Understood {
    let count = match check_count(c.count.unwrap_or(1)) {
        Ok(count) => count,
        Err(rejected) => return *rejected,
    };
    let Some(provider) = c.provider else {
        return Understood::reasoning("");
    };
    with_workspace(
        KalVoiceIntent::CreateThreads {
            provider_id: ProviderId::new(provider),
            count,
            workspace_id: None,
            account_query: None,
            model: None,
            effort: None,
            assignments: Vec::new(),
        },
        c.names.first(),
    )
}

#[cfg(test)]
#[path = "grammar_tests.rs"]
mod tests;
