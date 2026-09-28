//! Terminal-aware KalVoice phrases (0.1.5): addressing ("Hey Kal, …"), "send that" / "clear
//! that", "tell <session> to <prompt>", "go back", and looking sessions up by name or state.
//!
//! Three families run **before** the negation and compound guards, because their own wording
//! contains negations and conjunctions: "don't send that" clears, "never mind" clears, and the
//! prompt in "tell Auth to not delete the tests and rerun them" is the person's words, which
//! KalVoice passes on verbatim (never lower-cased, trimmed of meaning or re-worded). Everything
//! else here is ordinary pattern rules or a last-resort name lookup the desktop resolves with the
//! session resolver (which clarifies instead of guessing).

use kalcode_contracts::kalvoice::KalVoiceIntent;
use kalcode_contracts::sessions::SessionAttention;

use super::{
    Build, Caps, Confidence, MAX_COMMAND_TOKENS, Understood, count_word, strip_filler,
    surface_words,
};

/// Words that address KalVoice itself. An addressed utterance is never dictated.
const ADDRESS: &[&[&str]] = &[
    &["hey", "kal", "code"],
    &["hey", "kal", "voice"],
    &["hey", "kalcode"],
    &["hey", "kalvoice"],
    &["hey", "kal"],
    &["hey", "cal"],
    &["okay", "kal"],
    &["ok", "kal"],
    &["kal", "code"],
    &["kal", "voice"],
    &["kalcode"],
    &["kalvoice"],
    &["kal"],
];

/// One word of the original text: its byte span and its lower-cased form.
struct Word {
    start: usize,
    end: usize,
    lower: String,
}

/// Words of `text` (letters, digits and inner apostrophes), with their spans in `text`.
fn words(text: &str) -> Vec<Word> {
    let mut out = Vec::new();
    let mut start = None;
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    for (i, &(at, c)) in chars.iter().enumerate() {
        let apostrophe = matches!(c, '\'' | '\u{2019}')
            && start.is_some()
            && chars.get(i + 1).is_some_and(|(_, n)| n.is_alphanumeric());
        if c.is_alphanumeric() || apostrophe {
            start.get_or_insert(at);
        } else if let Some(s) = start.take() {
            out.push(word(text, s, at));
        }
    }
    if let Some(s) = start {
        out.push(word(text, s, text.len()));
    }
    out
}

fn word(text: &str, start: usize, end: usize) -> Word {
    Word {
        start,
        end,
        lower: text[start..end].to_lowercase().replace('\u{2019}', "'"),
    }
}

/// Splits an addressing prefix off `text`: `(true, "open settings")` for "Hey Kal, open
/// settings". The rest keeps the original casing and punctuation.
pub(super) fn strip_address(text: &str) -> (bool, &str) {
    let found = words(text);
    for phrase in ADDRESS {
        if found.len() >= phrase.len()
            && found.iter().zip(phrase.iter()).all(|(w, p)| w.lower == *p)
        {
            let end = found[phrase.len() - 1].end;
            let rest = text[end..].trim_start_matches(|c: char| {
                c.is_whitespace() || matches!(c, ',' | ':' | ';' | '!' | '.' | '-' | '\u{2014}')
            });
            return (true, rest.trim_end());
        }
    }
    (false, text)
}

/// Phrases matched before the negation/compound guards. `tokens` is the grammar's normalized
/// form of `original`.
pub(super) fn before_guards(original: &str, tokens: &[String]) -> Option<(Understood, Confidence)> {
    if tokens.len() <= MAX_COMMAND_TOKENS {
        let core = strip_filler(tokens);
        let words: Vec<&str> = core.iter().map(String::as_str).collect();
        if let Some(intent) = focused_composer(&words) {
            return Some((Understood::intent(intent), Confidence::High));
        }
        if go_back(&words) {
            return Some((
                Understood::intent(KalVoiceIntent::FocusPrevious),
                Confidence::High,
            ));
        }
    }
    direct_prompt(original).map(|understood| (understood, Confidence::Low))
}

/// "Send that" / "clear that" for the thread composer KalVoice last dictated into.
fn focused_composer(words: &[&str]) -> Option<KalVoiceIntent> {
    let submit = matches!(
        words,
        ["send" | "submit", "that" | "it" | "this"]
            | [
                "send" | "submit",
                "that" | "this" | "the",
                "message" | "prompt"
            ]
            | ["press" | "hit" | "click", "send"]
    );
    if submit {
        return Some(KalVoiceIntent::SubmitFocused);
    }
    let clear = matches!(
        words,
        [
            "clear" | "cancel" | "scratch" | "delete",
            "that" | "this" | "it"
        ] | ["never", "mind"]
            | ["never", "mind", "that"]
            | ["nevermind"]
            | ["don't" | "dont", "send", "that" | "it" | "this"]
            | ["do", "not", "send", "that" | "it" | "this"]
    );
    clear.then_some(KalVoiceIntent::ClearFocused)
}

/// "Go back", "go back to the thread I was just using", "go back to the previous terminal".
/// A browser page is "go back in the browser" (or "back").
fn go_back(words: &[&str]) -> bool {
    const THING: &[&str] = &[
        "thread", "terminal", "session", "one", "pane", "agent", "tab",
    ];
    let rest = match words {
        ["go", "back"] => return true,
        [
            "go" | "switch" | "jump" | "take" | "head",
            "back",
            "to",
            rest @ ..,
        ] => rest,
        ["back", "to", rest @ ..] => rest,
        ["previous" | "last", thing] if THING.contains(thing) => return true,
        _ => return false,
    };
    let rest = match rest {
        ["the" | "my", rest @ ..] => rest,
        _ => return false,
    };
    let rest = match rest {
        ["previous" | "last", rest @ ..] => rest,
        rest => rest,
    };
    match rest {
        [thing] => THING.contains(thing),
        [thing, "i", "was", tail @ ..] if THING.contains(thing) => matches!(
            tail,
            ["using" | "in" | "on" | "at"]
                | ["just", "using" | "in" | "on" | "at"]
                | ["working", "in" | "on"]
                | ["just", "working", "in" | "on"]
                | ["looking", "at"]
                | ["just", "looking", "at"]
        ),
        _ => false,
    }
}

/// Longest spoken session name before the prompt ("tell Gemini B Research to …").
const MAX_TARGET_WORDS: usize = 6;

/// "Tell <target> [to|that|,] <prompt>" / "ask <target> <question>". The prompt is the person's
/// words exactly as spoken; the target is resolved later by the session resolver.
fn direct_prompt(original: &str) -> Option<Understood> {
    let found = words(original);
    let mut i = 0;
    // Politeness in front of the verb ("please tell …", "can you ask …").
    loop {
        let lower = |k: usize| found.get(k).map(|w| w.lower.as_str());
        match (lower(i), lower(i + 1)) {
            (Some("please" | "okay" | "ok" | "now" | "so" | "um" | "uh"), _) => i += 1,
            (Some("can" | "could" | "would" | "will"), Some("you")) => i += 2,
            (Some("go"), Some("ahead")) if lower(i + 2) == Some("and") => i += 3,
            _ => break,
        }
    }
    let verb = found.get(i)?;
    if !matches!(verb.lower.as_str(), "tell" | "ask") {
        return None;
    }
    let target_start = i + 1;
    let first = found.get(target_start)?;
    if matches!(
        first.lower.as_str(),
        "me" | "us"
            | "you"
            | "yourself"
            | "everyone"
            | "everybody"
            | "someone"
            | "somebody"
            | "anyone"
            | "anybody"
            | "them"
            | "him"
            | "her"
            | "people"
            | "user"
            | "about"
            | "for"
            | "if"
            | "whether"
    ) {
        return None;
    }
    let limit = (target_start + MAX_TARGET_WORDS + 1).min(found.len());
    for j in target_start + 1..limit {
        let w = &found[j];
        let gap = &original[found[j - 1].end..w.start];
        let prompt_start = if gap.contains([',', ':', ';']) {
            Some(w.start)
        } else {
            match question_word(&w.lower) {
                Some(true) => Some(w.start),
                Some(false) => Some(found.get(j + 1).map_or(original.len(), |next| next.start)),
                None => None,
            }
        };
        let Some(prompt_start) = prompt_start else {
            continue;
        };
        let target = original[first.start..found[j - 1].end].trim();
        let prompt = original[prompt_start..].trim();
        if prompt.is_empty() {
            return Some(Understood::Rejected {
                code: "prompt_missing",
                message: format!(
                    "Say what to tell {target}, for example \u{201c}tell {target} to run the tests\u{201d}."
                ),
            });
        }
        return Some(Understood::intent(KalVoiceIntent::DirectPrompt {
            target: target.to_owned(),
            prompt: prompt.to_owned(),
        }));
    }
    None
}

/// Where the prompt starts: `Some(true)` at this word (a question: "ask Codex why …"),
/// `Some(false)` after it ("tell Auth to …", "tell Auth that …"), `None` inside the name.
fn question_word(word: &str) -> Option<bool> {
    let base = word.strip_suffix("'s").unwrap_or(word);
    match base {
        "to" | "that" => Some(false),
        "what" | "why" | "how" | "when" | "where" | "which" | "who" | "whose" | "whether"
        | "if" | "whats" | "hows" | "wheres" => Some(true),
        _ => None,
    }
}

// ---------------------------------------------------------------------------------------------
// Pattern rules: sessions by state. Added ahead of the approvals rules so "what needs
// permission" reads back the sessions (and opens the approvals panel) rather than only the panel.

const FOCUS_VERB: &str =
    "(open|show|show me|focus|focus on|go to|take me to|switch to|jump to|bring up|pull up|find)";
const ONE: &str =
    "(the one|the thread|the agent|the session|the terminal|the provider|the pane|whichever one)";
const WHICH: &str = "(which|what) (one|ones|agent|agents|thread|threads|session|sessions|provider|providers|terminal|terminals)";
const BE: &str =
    "[is|are|has|have|was|were|that is|which is|that are|that|which] [currently|still]";

/// "failed", "is waiting for permission", "stuck", "waiting" (… for me: trailing filler).
fn state_phrases(state: SessionAttention) -> &'static [&'static str] {
    match state {
        SessionAttention::Failed => &[
            "(failed|failing|errored|crashed|broke|broken)",
            "(failed|errored|crashed) [out]",
            "(hit|got|has) an error",
            "with an error",
        ],
        SessionAttention::Stuck => &["stuck"],
        SessionAttention::WaitingForPermission => &[
            "(waiting|asking) (for|on) [my] (permission|approval)",
            "(needs|need|needing|wants|want|requires|require) [my] permission",
            "(needs|need|needing) approval",
        ],
        SessionAttention::WaitingForYou => &[
            "waiting",
            "waiting on me",
            "waiting (for|on) (input|my input|an answer|a reply|my answer)",
            "(needs|need|needing) (me|input|my input|an answer)",
        ],
    }
}

/// Adjectives for "the failed thread", "the stuck agent".
fn state_adjectives(state: SessionAttention) -> Option<&'static str> {
    match state {
        SessionAttention::Failed => Some("(failed|failing|broken|crashed)"),
        SessionAttention::Stuck => Some("stuck"),
        SessionAttention::WaitingForPermission | SessionAttention::WaitingForYou => None,
    }
}

/// Words every state phrase contains one of.
pub(super) fn is_state_word(word: &str) -> bool {
    matches!(
        word,
        "failed"
            | "failing"
            | "errored"
            | "crashed"
            | "broke"
            | "broken"
            | "error"
            | "stuck"
            | "permission"
            | "approval"
            | "waiting"
            | "needs"
            | "need"
            | "needing"
    )
}

const ATTENTION: [SessionAttention; 4] = [
    SessionAttention::WaitingForPermission,
    SessionAttention::Failed,
    SessionAttention::Stuck,
    SessionAttention::WaitingForYou,
];

pub(super) fn state_rules(add: &mut impl FnMut(String, Build)) {
    for state in ATTENTION {
        let focus = move |_: &Caps| Understood::intent(KalVoiceIntent::FocusByState { state });
        let which = move |_: &Caps| Understood::intent(KalVoiceIntent::WhichSessions { state });
        for phrase in state_phrases(state) {
            add(format!("{FOCUS_VERB} {ONE} {BE} {phrase}"), Box::new(focus));
            add(format!("{WHICH} {BE} {phrase}"), Box::new(which));
            add(
                format!(
                    "(is|are|has|did) (anything|anyone|anybody|any thread|any agent|any session) {BE} {phrase}"
                ),
                Box::new(which),
            );
            add(format!("who {BE} {phrase}"), Box::new(which));
        }
        if let Some(adjective) = state_adjectives(state) {
            add(
                format!(
                    "{FOCUS_VERB} [me] the {adjective} (one|thread|agent|session|terminal|pane)"
                ),
                Box::new(focus),
            );
            add(
                format!("(what|which) {adjective} (threads|agents|sessions) [are there|do i have]"),
                Box::new(which),
            );
        }
    }
    // "What needs permission?" (a question about sessions), "what failed?", "what's stuck?".
    add(
        "what (needs|need|requires|require|wants) permission".into(),
        Box::new(|_: &Caps| {
            Understood::intent(KalVoiceIntent::WhichSessions {
                state: SessionAttention::WaitingForPermission,
            })
        }),
    );
    add(
        "what (is|are) (waiting|asking) (for|on) permission".into(),
        Box::new(|_: &Caps| {
            Understood::intent(KalVoiceIntent::WhichSessions {
                state: SessionAttention::WaitingForPermission,
            })
        }),
    );
    add(
        "what (failed|crashed|broke|errored)".into(),
        Box::new(|_: &Caps| {
            Understood::intent(KalVoiceIntent::WhichSessions {
                state: SessionAttention::Failed,
            })
        }),
    );
    add(
        "what (is|are) stuck".into(),
        Box::new(|_: &Caps| {
            Understood::intent(KalVoiceIntent::WhichSessions {
                state: SessionAttention::Stuck,
            })
        }),
    );
}

// ---------------------------------------------------------------------------------------------
// Last resort: "open Authentication", "focus Release Mac", "take me to Research". Only after
// every other rule (and pane layout) fell through. Low confidence, so a focused text box still
// receives such words as dictation unless the person addressed KalVoice.

/// Words that make a spoken "name" something other than a session name.
const NOT_A_SESSION_NAME: &[&str] = &[
    "thread",
    "threads",
    "terminal",
    "terminals",
    "pane",
    "panes",
    "agent",
    "agents",
    "session",
    "sessions",
    "workspace",
    "workspaces",
    "project",
    "projects",
    "browser",
    "page",
    "tab",
    "tabs",
    "window",
    "file",
    "files",
    "folder",
    "url",
    "link",
    "app",
    "shell",
    "console",
    "mode",
    "account",
    "new",
    "another",
    "up",
    "some",
    "all",
    "every",
    "any",
    "more",
    "less",
    // A clause, not a name ("show me anything that needs permission").
    "anything",
    "everything",
    "something",
    "nothing",
    "what",
    "which",
    "who",
    "why",
    "how",
    "is",
    "are",
    "was",
    "were",
    "needs",
    "need",
    "waiting",
    "for",
    "with",
    "about",
    "of",
    "if",
    "when",
];

const MAX_LOCATOR_WORDS: usize = 4;

pub(super) fn locator(original: &str, tokens: &[String]) -> Option<Understood> {
    // Addresses, paths and schemes are never session names ("open javascript:alert(1)").
    if original.contains([':', '/', '\\', '@']) {
        return None;
    }
    let words: Vec<&str> = tokens.iter().map(String::as_str).collect();
    let (focus, name) = match words.as_slice() {
        ["focus", "on", name @ ..] | ["focus", name @ ..] => (true, name),
        ["show", "me", name @ ..]
        | ["open" | "show" | "view", name @ ..]
        | ["go" | "switch" | "jump", "to", name @ ..]
        | ["take" | "bring", "me", "to", name @ ..] => (false, name),
        _ => return None,
    };
    if name.is_empty()
        || name.len() > MAX_LOCATOR_WORDS
        || matches!(name[0], "the" | "a" | "an" | "me" | "my" | "to" | "on")
        || count_word(name[0]).is_some()
        || name.iter().any(|w| NOT_A_SESSION_NAME.contains(w))
        || (name.contains(&"that") && !matches!(name, ["that"] | ["that", "one"]))
        || surface_words(tokens.get(tokens.len() - name.len()..)?).is_some()
    {
        return None;
    }
    let query = name.join(" ");
    Some(Understood::intent(if focus {
        KalVoiceIntent::Focus { query }
    } else {
        KalVoiceIntent::OpenThread { query }
    }))
}
