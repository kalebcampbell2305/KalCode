//! The locator's query language: free text in, search terms plus filters out.
//!
//! Deterministic and local ("semantic-ish", ADVANCED.md D9): words that name a kind ("threads"),
//! a status ("waiting", "failed"), a provider ("codex") or a time ("yesterday") become filters;
//! the rest are search terms, each widened with a light stem and a fixed alias table so "auth"
//! finds "Authentication Refactor" and "login" finds it too. Nothing leaves the machine and
//! nothing is stored.

use kalcode_contracts::agent::ProviderId;

use crate::types::{LocatorEntityKind, LocatorInterpretation, LocatorRecency, LocatorStatusFilter};

/// Longest query text accepted (characters); longer text is cut.
pub const MAX_QUERY_CHARS: usize = 256;
/// At most this many search terms are used.
pub const MAX_TERMS: usize = 8;

/// One search word and the words that count as matching it (OR); all groups must match (AND).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TermGroup {
    /// As typed (lowercase).
    pub term: String,
    /// `term` first, then its stem and aliases; all lowercase, de-duplicated.
    pub alternatives: Vec<String>,
}

impl TermGroup {
    /// Whether `alternative` is the typed word itself or its stem (vs. an alias).
    pub fn is_direct(&self, alternative: &str) -> bool {
        alternative == self.term || stem(&self.term).as_deref() == Some(alternative)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedQuery {
    pub groups: Vec<TermGroup>,
    pub kinds: Vec<LocatorEntityKind>,
    pub statuses: Vec<LocatorStatusFilter>,
    pub provider_id: Option<ProviderId>,
    pub recency: Option<LocatorRecency>,
    pub active_only: bool,
    /// Words taken as filters, in the order typed (used when a filtered search finds nothing and
    /// the words are retried as plain search terms).
    pub filter_words: Vec<String>,
}

impl ParsedQuery {
    pub fn interpretation(&self) -> LocatorInterpretation {
        let terms: Vec<String> = self.groups.iter().map(|g| g.term.clone()).collect();
        let mut expanded = Vec::new();
        for group in &self.groups {
            for alt in &group.alternatives {
                if !group.is_direct(alt) && !expanded.contains(alt) {
                    expanded.push(alt.clone());
                }
            }
        }
        LocatorInterpretation {
            terms,
            expanded,
            kinds: self.kinds.clone(),
            statuses: self.statuses.clone(),
            recency: self.recency,
            provider_id: self.provider_id.clone(),
            active_only: self.active_only,
        }
    }

    pub fn has_filters(&self) -> bool {
        !self.kinds.is_empty()
            || !self.statuses.is_empty()
            || self.provider_id.is_some()
            || self.recency.is_some()
            || self.active_only
    }
}

/// Alias groups: every word in a group matches every other. Kept small and product-specific.
const ALIASES: &[&[&str]] = &[
    &[
        "auth",
        "authentication",
        "authorization",
        "login",
        "log in",
        "sign in",
        "signin",
        "oauth",
        "sso",
        "credentials",
    ],
    &[
        "database",
        "db",
        "sql",
        "sqlite",
        "postgres",
        "mysql",
        "schema",
        "migration",
    ],
    &["test", "testing", "spec", "e2e", "coverage"],
    &["bug", "fix", "issue", "regression", "defect"],
    &[
        "ui",
        "frontend",
        "front end",
        "interface",
        "css",
        "styling",
        "layout",
    ],
    &["api", "endpoint", "backend", "server", "route", "graphql"],
    &[
        "deploy",
        "deployment",
        "release",
        "ship",
        "publish",
        "pipeline",
    ],
    &["docs", "documentation", "readme", "guide"],
    &[
        "perf",
        "performance",
        "latency",
        "slow",
        "optimize",
        "optimise",
        "speed",
    ],
    &["refactor", "cleanup", "clean up", "restructure", "rewrite"],
    &[
        "config",
        "configuration",
        "settings",
        "setup",
        "environment",
    ],
    &[
        "deps",
        "dependency",
        "dependencies",
        "package",
        "upgrade",
        "bump",
    ],
    &[
        "billing",
        "payment",
        "stripe",
        "checkout",
        "subscription",
        "invoice",
    ],
    &["notification", "alert", "email"],
    &["error", "exception", "crash", "panic"],
    &["security", "vulnerability", "xss", "csrf"],
    &["terminal", "shell", "console", "powershell", "bash"],
];

/// Words that never carry meaning in a search.
const STOP_WORDS: &[&str] = &[
    "a", "an", "the", "my", "me", "i", "was", "were", "is", "are", "be", "been", "on", "in", "of",
    "to", "for", "about", "with", "that", "which", "what", "where", "when", "find", "show", "open",
    "search", "look", "looking", "all", "any", "some", "and", "or", "it", "its", "this", "from",
    "did", "do", "does", "had", "have", "has", "we", "you", "our", "your", "one", "ones", "thing",
    "things", "stuff", "please", "can", "could", "would", "at", "by", "up",
];

/// Multi-word phrases removed before anything else (they would otherwise read as filters).
const PHRASES_DROPPED: &[&str] = &[
    "working on",
    "worked on",
    "work on",
    "was doing",
    "been doing",
    "left off",
];

const KIND_WORDS: &[(&str, LocatorEntityKind)] = &[
    ("thread", LocatorEntityKind::Thread),
    ("threads", LocatorEntityKind::Thread),
    ("session", LocatorEntityKind::Thread),
    ("sessions", LocatorEntityKind::Thread),
    ("conversation", LocatorEntityKind::Thread),
    ("conversations", LocatorEntityKind::Thread),
    ("chat", LocatorEntityKind::Thread),
    ("chats", LocatorEntityKind::Thread),
    ("workspace", LocatorEntityKind::Workspace),
    ("workspaces", LocatorEntityKind::Workspace),
    ("project", LocatorEntityKind::Workspace),
    ("projects", LocatorEntityKind::Workspace),
    ("folder", LocatorEntityKind::Workspace),
    ("folders", LocatorEntityKind::Workspace),
    ("repo", LocatorEntityKind::Workspace),
    ("repos", LocatorEntityKind::Workspace),
    ("repository", LocatorEntityKind::Workspace),
    ("repositories", LocatorEntityKind::Workspace),
    ("terminals", LocatorEntityKind::Terminal),
    ("shells", LocatorEntityKind::Terminal),
    ("provider", LocatorEntityKind::Provider),
    ("providers", LocatorEntityKind::Provider),
    ("activity", LocatorEntityKind::Activity),
    ("history", LocatorEntityKind::Activity),
];

const STATUS_WORDS: &[(&str, LocatorStatusFilter)] = &[
    ("working", LocatorStatusFilter::Working),
    ("running", LocatorStatusFilter::Working),
    ("busy", LocatorStatusFilter::Working),
    ("active", LocatorStatusFilter::Working),
    ("waiting", LocatorStatusFilter::NeedsYou),
    ("blocked", LocatorStatusFilter::NeedsYou),
    ("stuck", LocatorStatusFilter::NeedsYou),
    ("approval", LocatorStatusFilter::NeedsYou),
    ("approvals", LocatorStatusFilter::NeedsYou),
    ("permission", LocatorStatusFilter::NeedsYou),
    ("done", LocatorStatusFilter::Done),
    ("completed", LocatorStatusFilter::Done),
    ("complete", LocatorStatusFilter::Done),
    ("finished", LocatorStatusFilter::Done),
    ("failed", LocatorStatusFilter::Failed),
    ("failing", LocatorStatusFilter::Failed),
    ("broken", LocatorStatusFilter::Failed),
    ("crashed", LocatorStatusFilter::Failed),
    ("idle", LocatorStatusFilter::Idle),
    ("paused", LocatorStatusFilter::Idle),
    ("stopped", LocatorStatusFilter::Idle),
    ("archived", LocatorStatusFilter::Archived),
];

/// Multi-word filter phrases (checked before single words).
const STATUS_PHRASES: &[(&str, LocatorStatusFilter)] = &[
    ("needs me", LocatorStatusFilter::NeedsYou),
    ("needs you", LocatorStatusFilter::NeedsYou),
    ("need me", LocatorStatusFilter::NeedsYou),
    ("waiting for me", LocatorStatusFilter::NeedsYou),
    ("in progress", LocatorStatusFilter::Working),
];

const RECENCY_PHRASES: &[(&str, LocatorRecency)] = &[
    ("this week", LocatorRecency::ThisWeek),
    ("last week", LocatorRecency::LastWeek),
    ("past week", LocatorRecency::ThisWeek),
    ("this month", LocatorRecency::ThisMonth),
    ("today", LocatorRecency::Today),
    ("tonight", LocatorRecency::Today),
    ("yesterday", LocatorRecency::Yesterday),
    ("recently", LocatorRecency::ThisWeek),
    ("recent", LocatorRecency::ThisWeek),
    ("lately", LocatorRecency::ThisWeek),
];

const ACTIVE_PHRASES: &[&str] = &["right now", "currently", "now"];

const PROVIDER_PHRASES: &[(&str, &str)] = &[
    ("claude code", ProviderId::CLAUDE_CODE),
    ("claude", ProviderId::CLAUDE_CODE),
    ("codex", ProviderId::CODEX),
    ("gemini cli", ProviderId::GEMINI_CLI),
    ("gemini", ProviderId::GEMINI_CLI),
];

/// A light English stem (suffix strip) used as an extra alternative; `None` if unchanged or too
/// short to search with.
pub fn stem(word: &str) -> Option<String> {
    let chars = word.chars().count();
    let strip = |suffix: &str, min: usize| {
        word.strip_suffix(suffix)
            .filter(|base| base.chars().count() >= min && chars > suffix.len())
            .map(str::to_owned)
    };
    let stemmed = strip("ing", 4)
        .or_else(|| strip("ied", 3).map(|b| format!("{b}y")))
        .or_else(|| strip("ies", 3).map(|b| format!("{b}y")))
        .or_else(|| strip("ed", 4))
        .or_else(|| strip("es", 3).filter(|b| b.ends_with(['s', 'x', 'z', 'h'])))
        .or_else(|| {
            strip("s", 3).filter(|b| !b.ends_with('s') && !b.ends_with("u") && !b.ends_with('i'))
        })?;
    (stemmed != word && stemmed.chars().count() >= 3).then_some(stemmed)
}

fn aliases_for(word: &str) -> Vec<&'static str> {
    let stemmed = stem(word);
    ALIASES
        .iter()
        .find(|group| {
            group
                .iter()
                .any(|a| *a == word || stemmed.as_deref() == Some(*a))
        })
        .map(|group| group.to_vec())
        .unwrap_or_default()
}

/// Replaces every whole-word occurrence of `phrase` in `text` (space-separated words) with
/// spaces, returning whether it occurred.
fn take_phrase(text: &mut String, phrase: &str) -> bool {
    let padded = format!(" {text} ");
    let needle = format!(" {phrase} ");
    if !padded.contains(&needle) {
        return false;
    }
    let replaced = padded.replace(&needle, &" ".repeat(needle.len()));
    *text = replaced.trim().to_owned();
    true
}

/// Normalizes free text: lowercase, punctuation to spaces (keeping letters, digits and
/// quotes), cut to [`MAX_QUERY_CHARS`].
fn normalize(text: &str) -> String {
    let lowered: String = text
        .chars()
        .take(MAX_QUERY_CHARS)
        .flat_map(char::to_lowercase)
        .map(|c| {
            if c.is_alphanumeric() || c == '"' {
                c
            } else {
                ' '
            }
        })
        .collect();
    lowered.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Parses free text into term groups and filters.
pub fn parse(text: &str) -> ParsedQuery {
    let mut parsed = ParsedQuery::default();
    let mut rest = normalize(text);

    // "Quoted phrases" are searched as typed, with no filters or aliases.
    let mut quoted = Vec::new();
    while let Some(start) = rest.find('"') {
        let after = &rest[start + 1..];
        let Some(len) = after.find('"') else {
            rest = rest.replace('"', " ");
            break;
        };
        let phrase = after[..len].trim().to_owned();
        rest = format!("{} {}", &rest[..start], &after[len + 1..]);
        if !phrase.is_empty() {
            quoted.push(phrase);
        }
    }
    rest = rest.replace('"', " ");
    rest = rest.split_whitespace().collect::<Vec<_>>().join(" ");

    for phrase in PHRASES_DROPPED {
        take_phrase(&mut rest, phrase);
    }
    for (phrase, status) in STATUS_PHRASES {
        if take_phrase(&mut rest, phrase) {
            push_unique(&mut parsed.statuses, *status);
            parsed.filter_words.push((*phrase).to_owned());
        }
    }
    for (phrase, recency) in RECENCY_PHRASES {
        if take_phrase(&mut rest, phrase) {
            parsed.recency.get_or_insert(*recency);
            parsed.filter_words.push((*phrase).to_owned());
        }
    }
    for phrase in ACTIVE_PHRASES {
        if take_phrase(&mut rest, phrase) {
            parsed.active_only = true;
            parsed.filter_words.push((*phrase).to_owned());
        }
    }
    for (phrase, provider) in PROVIDER_PHRASES {
        if take_phrase(&mut rest, phrase) {
            parsed
                .provider_id
                .get_or_insert_with(|| ProviderId::new(*provider));
            parsed.filter_words.push((*phrase).to_owned());
        }
    }

    let mut words = Vec::new();
    for word in rest.split_whitespace() {
        if let Some((_, kind)) = KIND_WORDS.iter().find(|(w, _)| *w == word) {
            push_unique(&mut parsed.kinds, *kind);
            parsed.filter_words.push(word.to_owned());
        } else if let Some((_, status)) = STATUS_WORDS.iter().find(|(w, _)| *w == word) {
            push_unique(&mut parsed.statuses, *status);
            parsed.filter_words.push(word.to_owned());
        } else if !STOP_WORDS.contains(&word) {
            words.push(word.to_owned());
        }
    }

    for phrase in quoted {
        push_group(
            &mut parsed.groups,
            TermGroup {
                alternatives: vec![phrase.clone()],
                term: phrase,
            },
        );
    }
    for word in words {
        push_group(&mut parsed.groups, group_for(&word));
    }
    parsed.groups.truncate(MAX_TERMS);
    parsed
}

/// The term group for one word: itself, its stem, then its aliases.
pub fn group_for(word: &str) -> TermGroup {
    let mut alternatives = vec![word.to_owned()];
    if let Some(stemmed) = stem(word) {
        push_unique(&mut alternatives, stemmed);
    }
    for alias in aliases_for(word) {
        push_unique(&mut alternatives, alias.to_owned());
    }
    TermGroup {
        term: word.to_owned(),
        alternatives,
    }
}

fn push_group(groups: &mut Vec<TermGroup>, group: TermGroup) {
    if !groups.iter().any(|g| g.term == group.term) {
        groups.push(group);
    }
}

fn push_unique<T: PartialEq>(items: &mut Vec<T>, item: T) {
    if !items.contains(&item) {
        items.push(item);
    }
}

/// The same text with every filter word searched as a plain term (the retry when a filtered
/// search finds nothing: "error handling" is a title, not "failed" + "handling").
pub fn without_filters(parsed: &ParsedQuery) -> ParsedQuery {
    let mut plain = ParsedQuery {
        groups: parsed.groups.clone(),
        ..ParsedQuery::default()
    };
    for word in &parsed.filter_words {
        push_group(&mut plain.groups, group_for(word));
    }
    plain.groups.truncate(MAX_TERMS);
    plain
}

#[cfg(test)]
mod tests {
    use super::*;

    fn terms(parsed: &ParsedQuery) -> Vec<&str> {
        parsed.groups.iter().map(|g| g.term.as_str()).collect()
    }

    #[test]
    fn auth_is_widened_to_its_aliases() {
        let parsed = parse("auth");
        assert_eq!(terms(&parsed), vec!["auth"]);
        let alts = &parsed.groups[0].alternatives;
        assert!(alts.contains(&"authentication".to_owned()));
        assert!(alts.contains(&"login".to_owned()));
        assert!(alts.contains(&"sign in".to_owned()));
        let login = parse("Login");
        assert!(login.groups[0].alternatives.contains(&"auth".to_owned()));
    }

    #[test]
    fn filter_words_become_filters() {
        let parsed = parse("Codex threads waiting on approval yesterday");
        assert_eq!(parsed.kinds, vec![LocatorEntityKind::Thread]);
        assert_eq!(parsed.statuses, vec![LocatorStatusFilter::NeedsYou]);
        assert_eq!(parsed.recency, Some(LocatorRecency::Yesterday));
        assert_eq!(parsed.provider_id, Some(ProviderId::new(ProviderId::CODEX)));
        assert!(parsed.groups.is_empty());
    }

    #[test]
    fn what_was_i_working_on_yesterday_is_a_recency_question() {
        let parsed = parse("find what I was working on yesterday");
        assert!(parsed.groups.is_empty(), "{:?}", parsed.groups);
        assert!(parsed.statuses.is_empty(), "\"working on\" is not a status");
        assert_eq!(parsed.recency, Some(LocatorRecency::Yesterday));
    }

    #[test]
    fn quoted_phrases_are_literal() {
        let parsed = parse("\"failed login\" today");
        assert_eq!(terms(&parsed), vec!["failed login"]);
        assert_eq!(parsed.groups[0].alternatives, vec!["failed login"]);
        assert_eq!(parsed.recency, Some(LocatorRecency::Today));
        assert!(parsed.statuses.is_empty());
    }

    #[test]
    fn stems_are_conservative() {
        assert_eq!(stem("tests").as_deref(), Some("test"));
        assert_eq!(stem("refactoring").as_deref(), Some("refactor"));
        assert_eq!(stem("dependencies").as_deref(), Some("dependency"));
        assert_eq!(stem("fixes").as_deref(), Some("fix"));
        assert_eq!(stem("bus"), None);
        assert_eq!(stem("status"), None);
        assert_eq!(stem("css"), None);
        assert_eq!(stem("api"), None);
    }

    #[test]
    fn retrying_without_filters_keeps_every_word() {
        let parsed = parse("error handling failed");
        let plain = without_filters(&parsed);
        assert_eq!(terms(&plain), vec!["error", "handling", "failed"]);
        assert!(!plain.has_filters());
    }

    #[test]
    fn long_and_odd_input_is_bounded() {
        let long = "word ".repeat(400);
        let parsed = parse(&long);
        assert!(parsed.groups.len() <= MAX_TERMS);
        let parsed = parse("\u{202E}\0 <script> ;DROP TABLE; ' \" ");
        for group in &parsed.groups {
            assert!(group.term.chars().all(char::is_alphanumeric));
        }
        let many: String = (0..50).map(|i| format!("w{i}x ")).collect();
        assert_eq!(parse(&many).groups.len(), MAX_TERMS);
    }
}
