//! Deterministic second chance for paraphrases and speech-recognition variants (0.1.5, P2), and
//! the command-shaped guard for text that would otherwise be typed into a terminal (P1).
//!
//! [`second_chance`] runs only on a request the grammar did **not** understand and that the
//! negation/compound guard did **not** refuse. It rewrites the request into canonical command
//! wording, which the unchanged grammar then parses again, so every guard, count limit and
//! target resolution still applies. Rewrites anchored at the start of the request ("take me back
//! to …", "pull up …") may yield any intent; the unanchored ones ("… needs permission …") only
//! ever yield a read-only intent, and only for a request shaped like a question or an
//! instruction ("the dashboard is waiting for me to fix the chart" is neither). No model, no
//! network, static tables only.

/// A rewritten request. `read_only` rewrites may only produce read-only intents.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Rewrite {
    pub(crate) text: String,
    pub(crate) read_only: bool,
}

/// Opening disfluencies ("um", "so", "okay so").
const DISFLUENCY: &[&str] = &[
    "um",
    "umm",
    "uh",
    "er",
    "erm",
    "hmm",
    "so",
    "well",
    "okay so",
    "ok so",
    "okay",
    "ok",
    "alright",
    "all right",
    "right",
];

/// Lower-cased words, punctuation as spaces, common contractions expanded.
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

/// Starts like a question or an instruction to KalCode (required of unanchored rewrites).
fn question_or_imperative(s: &str) -> bool {
    const OPENERS: &[&str] = &[
        "what",
        "which",
        "who",
        "whose",
        "how",
        "is",
        "are",
        "any",
        "anything",
        "anybody",
        "anyone",
        "does",
        "do",
        "has",
        "have",
        "where",
        "show",
        "tell",
        "give",
        "list",
        "check",
        "let",
        "can",
        "could",
        "would",
        "summarize",
        "display",
        "open",
        "pull",
        "bring",
    ];
    s.split(' ').next().is_some_and(|w| OPENERS.contains(&w))
}

/// Disfluencies and speech-recognition vocabulary only (no rephrasing).
fn clean_speech(text: &str) -> String {
    let mut s = words_of(text);
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
    for d in [" uh ", " um ", " umm ", " er "] {
        s = format!(" {s} ").replace(d, " ").trim().to_owned();
    }
    // Speech-recognition vocabulary: a closed list of KalCode names.
    let mut padded = format!(" {s} ");
    for (from, to) in [
        (" local host ", " localhost "),
        (" localhost colon ", " localhost "),
        (" dash board ", " dashboard "),
        (" cal voice ", " kalvoice "),
        (" kal voice ", " kalvoice "),
        (" cloud code ", " claude code "),
        (" clawed code ", " claude code "),
        (" clawed ", " claude "),
        (" clod ", " claude "),
        (" jemini ", " gemini "),
        (" code decks ", " codex "),
    ] {
        padded = padded.replace(from, to);
    }
    // "Cloud" is "Claude" only next to a provider word.
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
    padded.trim().to_owned()
}

/// Canonical wording for a request the grammar fell through on, or `None` when nothing
/// applies. The caller re-parses the text with the grammar.
pub(crate) fn second_chance(text: &str) -> Option<Rewrite> {
    if text.contains("://") {
        return None;
    }
    let mut s = clean_speech(text);
    // Politeness the grammar strips anyway, so anchored rules see the verb.
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

    // Anchored verb phrases.
    const ANCHORED: &[(&str, &str)] = &[
        ("take me back to", "go to"),
        ("take me over to", "go to"),
        ("take me to", "go to"),
        ("bring me back to", "go to"),
        ("bring me to", "go to"),
        ("head over to", "go to"),
        ("head to", "go to"),
        ("jump over to", "go to"),
        ("get me back to", "go to"),
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
    // "go back to the thread I was using" is its own command; never rewrite it to "go to".
    let previous_session = s.starts_with("go back to the ") || s.starts_with("go back to my ");
    if !previous_session {
        for (from, to) in ANCHORED {
            if let Some(rest) = strip_prefix_words(&s, from) {
                s = format!("{to} {rest}").trim().to_owned();
                break;
            }
        }
    }
    // "Pull up thread status" -> "show thread status", which is the status report, never a
    // thread named "status".
    if matches!(
        s.as_str(),
        "show thread status"
            | "show threads status"
            | "show agent status"
            | "show agents status"
            | "show me thread status"
            | "show me threads status"
            | "show me agent status"
            | "show me agents status"
            | "show the thread status"
            | "show me the thread status"
    ) {
        s = "status report".into();
    }
    for p in ["where is ", "where are "] {
        if let Some(rest) = s.strip_prefix(p) {
            s = format!("go to {rest}");
        }
    }
    // Browser phrasing. "Go back" alone is the previous thread; a page is "in the browser".
    for (from, to) in [
        ("go to the browser", "open the browser"),
        ("show me the browser", "open the browser"),
        ("show the browser", "open the browser"),
        ("go to browser", "open the browser"),
        ("refresh the browser", "reload the browser"),
        ("go back a page", "go back in the browser"),
        ("go back one page", "go back in the browser"),
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
    // Thread-control qualifiers: "pause everything that is currently running".
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
    ] {
        if s == from {
            s = to.to_owned();
        }
    }
    if let Some(mid) = s
        .strip_prefix("let us get ")
        .and_then(|r| r.strip_suffix(" going"))
    {
        s = format!("start {mid}");
    }
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
    if let Some(p) = s
        .strip_prefix("use ")
        .and_then(|r| r.strip_suffix(" from now on"))
    {
        s = format!("switch to {p}");
    }
    if let Some(when) = s.strip_prefix("show me what i worked on ") {
        s = format!("what did i work on {when}");
    }

    // Unanchored read-only rewrites: a whole question or instruction becomes one read-only
    // command. Never for statements ("the dashboard is waiting for me to fix the chart").
    if s.contains("what all my") || s.contains("what all the") {
        s = s
            .replace("what all my", "what my")
            .replace("what all the", "what the");
    }
    let has = |needles: &[&str]| needles.iter().any(|n| s.contains(n));
    let short = s.split(' ').count() <= 10;
    if short && question_or_imperative(&s) {
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
            return Some(Rewrite {
                text: "show approvals".into(),
                read_only: true,
            });
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
            return Some(Rewrite {
                text: "status report".into(),
                read_only: true,
            });
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
                    return Some(Rewrite {
                        text: format!("show {chip} agents"),
                        read_only: true,
                    });
                }
            }
        }
    }
    Some(Rewrite {
        text: s,
        read_only: false,
    })
}

/// P1: a fall-through that starts like a KalCode command and names a KalCode noun (at most 12
/// words). Such words are never typed into a focused terminal or provider pane, where a
/// provider pane would submit them to the agent as a prompt; KalVoice treats them as a request
/// instead ("couldn't determine a safe local action" / the local interpreter).
pub fn command_shaped(text: &str) -> bool {
    const VERB: &[&str] = &[
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
    const NOUN: &[&str] = &[
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
    let s = clean_speech(text);
    let words: Vec<&str> = s.split(' ').collect();
    words.first().is_some_and(|w| VERB.contains(w))
        && words.len() <= 12
        && words.iter().any(|w| NOUN.contains(w))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rewritten(text: &str) -> String {
        second_chance(text).expect("rewrite").text
    }

    #[test]
    fn disfluencies_and_speech_vocabulary_are_cleaned() {
        assert_eq!(
            rewritten("Um, so, open the dash board"),
            "open the dashboard"
        );
        assert_eq!(
            rewritten("okay so open local host 3000"),
            "open localhost 3000"
        );
        assert_eq!(
            rewritten("open two cloud code threads"),
            "open two claude code threads"
        );
        // "cloud" stays "cloud" without a provider word nearby.
        assert_eq!(
            rewritten("open the cloud console"),
            "open the cloud console"
        );
    }

    #[test]
    fn anchored_rewrites_keep_the_rest_of_the_request() {
        assert_eq!(
            rewritten("Can you take me back to settings?"),
            "go to settings"
        );
        assert_eq!(rewritten("pull up the approvals"), "show the approvals");
        assert_eq!(rewritten("go back a page"), "go back in the browser");
        // The previous-session phrase is left for the grammar.
        assert_eq!(
            rewritten("go back to the thread I was just using"),
            "go back to the thread i was just using"
        );
    }

    #[test]
    fn unanchored_rewrites_need_a_question_or_instruction_and_are_read_only() {
        let rewrite = second_chance("Is anything waiting on me?").expect("rewrite");
        assert_eq!(rewrite.text, "show approvals");
        assert!(rewrite.read_only);
        // A statement is never turned into a command.
        assert_eq!(
            rewritten("The dashboard is waiting for me to fix the chart"),
            "the dashboard is waiting for me to fix the chart"
        );
        assert!(second_chance("open https://example.com/x").is_none());
    }

    #[test]
    fn command_shaped_text_is_recognized() {
        assert!(command_shaped("Pause everything that's currently running."));
        assert!(command_shaped("um, show me the dash board"));
        assert!(!command_shaped("refactor the login module to use sessions"));
        assert!(!command_shaped("git status"));
        assert!(!command_shaped(
            "open the file and then explain every single function in it to me in detail please"
        ));
    }
}
