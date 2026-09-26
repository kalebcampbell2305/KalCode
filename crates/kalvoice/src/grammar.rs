//! Deterministic KalVoice command grammar (docs/KALVOICE.md, "Command pipeline").
//!
//! Turns a request ("open four Codex threads", "pause every active thread", "what needs
//! permission?") into a typed [`KalVoiceIntent`] without any model. The grammar is deliberately
//! conservative: a command is recognized only when a pattern matches the *whole* request, after
//! politeness words are removed. Anything else — including negated or compound requests such as
//! "don't stop the threads" or "stop the threads and then delete the branch" — becomes
//! [`KalVoiceIntent::Reasoning`], which only the bounded on-device interpreter may handle.
//!
//! Matching is case- and punctuation-insensitive. Counts accept digits and the words one to
//! twenty; more than [`MAX_THREADS_PER_REQUEST`] is refused rather than guessed.

use std::sync::OnceLock;

use kalcode_contracts::agent::ProviderId;
use kalcode_contracts::app::SurfaceId;
use kalcode_contracts::kalvoice::{
    BrowserControl, KalVoiceIntent, PaneControl, PaneDirection, ProviderPaneRequest,
    RequestableMode, ThreadScope,
};
use kalcode_contracts::workspace_ui::{DashboardChip, SplitAxis};
use url::Url;

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
    if let Some(intent) = browser_request(trimmed, core) {
        *confidence = Confidence::High;
        return Understood::intent(intent);
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

/// Full-utterance pane commands, including bounded mixed-provider/account groups. This is
/// deliberately separate from general conjunctions: "and delete files" never becomes an
/// executable continuation of a UI command.
fn pane_request(tokens: &[String]) -> Option<Understood> {
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
    if let Some(workspace_at) = words
        .iter()
        .rposition(|w| matches!(w.as_str(), "in" | "inside" | "within"))
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
    if let Some(at) = words
        .iter()
        .rposition(|w| matches!(w.as_str(), "in" | "inside" | "within"))
    {
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
        let model = if provider
            .as_ref()
            .is_some_and(|p| p.as_str() == ProviderId::CLAUDE_CODE)
            && rest
                .first()
                .is_some_and(|w| matches!(w.as_str(), "opus" | "sonnet" | "haiku"))
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
            Err(error) => return Some(error),
        };
        total = total.saturating_add(u32::from(count));
        if let Err(error) = check_count(total) {
            return Some(error);
        }
        let provider_id = provider.or_else(|| previous_provider.clone());
        previous_provider = provider_id.clone();
        groups.push(ProviderPaneRequest {
            provider_id,
            count,
            account_query,
            model,
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
    surface_name(&words.join(" "))
}

fn surface_name(name: &str) -> Option<SurfaceId> {
    Some(match name {
        "dashboard" | "home" | "overview" => SurfaceId::Dashboard,
        "kalvoice" | "kal voice" | "voice" => SurfaceId::KalVoice,
        "code" | "code mode" | "editor" => SurfaceId::Code,
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
const THREAD_WORD: &str =
    "(thread|threads|session|sessions|agent|agents|terminal|terminals|pane|panes)";
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

    // Dashboard filters (Z7-W3). After approvals, so "show what's waiting for me" still opens
    // the approvals panel; before navigation, whose bare "<surface>" forms they never overlap.
    for (chip, patterns) in dashboard_filter_patterns() {
        for p in patterns {
            add(
                p,
                Box::new(move |_| Understood::intent(KalVoiceIntent::FilterDashboard { chip })),
            );
        }
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

    // Change the provider selected for the next thread or provider pane. Provider names are a
    // closed local vocabulary, so this never starts a provider process or guesses an account.
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
    // "What was I working on yesterday?" — recent work, answered from the event log.
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

/// "Show", as a Dashboard filter verb.
const SHOW_VERB: &str = "(show|display|list|filter|give) [me] [only|just]";
/// The things a Dashboard filter shows.
const AGENTS_WORD: &str = "(agents|agent|threads|thread|work|tasks|sessions)";

/// Phrases for each Dashboard chip. Every pattern names the chip's state explicitly, so none of
/// them can read as navigation ("show agents") or as the approvals panel ("show what's waiting").
fn dashboard_filter_patterns() -> Vec<(DashboardChip, Vec<String>)> {
    let noun = AGENTS_WORD;
    let show = SHOW_VERB;
    vec![
        (
            DashboardChip::Working,
            vec![
                format!("{show} [the|my] (working|running|active|busy) {noun}"),
                format!(
                    "{show} [the|my] {noun} (that are|which are|currently|that is|which is) (working|running|busy)"
                ),
                format!(
                    "only (show|display|list) [me] [the|my] (working|running|active|busy) {noun}"
                ),
                format!(
                    "only (show|display|list) [me] [the|my] {noun} (that are|which are) (working|running|busy)"
                ),
                format!("(which|what) {noun} (are|is) (working|running|busy) [right now|now]"),
            ],
        ),
        (
            DashboardChip::WaitingForYou,
            vec![
                // "for me" is trailing filler, so "… waiting for me" arrives as "… waiting".
                format!(
                    "{show} (everything|all|anything|all the things|whatever is|what) [that is|that are] (waiting [for|on] [me]|(that needs|that need|needing) me)"
                ),
                format!(
                    "{show} [the|my] {noun} (waiting [for|on] [me]|(that need|that needs|which need|which needs|needing) me)"
                ),
                format!("{show} [the|my] {noun} (that are|which are) waiting [for|on] [me]"),
                format!("{show} [the|my] {noun} [that|which] (need|needs) [my] attention"),
                format!(
                    "only (show|display|list) [me] (everything|what|the {noun}|{noun}) [that is|that are] waiting [for|on] [me]"
                ),
            ],
        ),
        (
            DashboardChip::Done,
            vec![
                format!("{show} [the|my|all] [the] (completed|finished|done) {noun}"),
                format!(
                    "{show} [the|my] {noun} (that are|which are|that have|which have|that|which) (completed|finished|done)"
                ),
                format!("{show} [me] what (is|has) (completed|finished|done)"),
                format!("only (show|display|list) [me] [the|my] (completed|finished|done) {noun}"),
            ],
        ),
        (
            DashboardChip::Idle,
            vec![
                format!("{show} [the|my|all] [the] idle {noun}"),
                format!("{show} [the|my] {noun} (that are|which are) idle"),
                format!("only (show|display|list) [me] [the|my] idle {noun}"),
            ],
        ),
        (
            DashboardChip::All,
            vec![
                format!(
                    "(show|display|list) [me] (all|every|all the|all of the|all my|all of my) {noun}"
                ),
                "(show|display|list) [me] everything on the dashboard".to_owned(),
                "(clear|reset|remove) [the|my] [dashboard] (filter|filters)".to_owned(),
            ],
        ),
    ]
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
