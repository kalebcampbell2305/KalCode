//! Deterministic thread names from the first prompt ("fix the OAuth callback race in login"
//! → "Fix OAuth Callback Race"). No model is involved: the same prompt always yields the same
//! name, and the user can rename the thread at any time.

/// Longest generated name, in characters.
const MAX_CHARS: usize = 48;
/// Content words kept before the name is considered complete.
const MAX_WORDS: usize = 6;
/// After this many content words, a clause boundary ends the name.
const ENOUGH_WORDS: usize = 4;

pub const FALLBACK_NAME: &str = "New thread";
/// An untitled coding agent (a provider pane started without a task) until its first prompt
/// names it. Agents are coding terminals, not threads (AGENTS.md).
pub const AGENT_FALLBACK_NAME: &str = "New agent";

/// Whether `name` is still an untitled placeholder that the first prompt may replace.
pub fn is_placeholder(name: &str) -> bool {
    name == FALLBACK_NAME || name == AGENT_FALLBACK_NAME
}

/// Politeness and framing that precede the actual task.
const LEADING_FILLER: &[&str] = &[
    "please", "pls", "plz", "hey", "hi", "hello", "ok", "okay", "so", "can", "could", "would",
    "will", "you", "i", "i'd", "i'm", "we", "we'd", "want", "wanna", "need", "like", "to", "let's",
    "lets", "help", "me", "us", "kindly", "just", "go", "ahead", "and", "now", "also", "claude",
    "quickly", "try",
];

/// Words that never carry the task: articles, determiners, pronouns.
const DROPPED: &[&str] = &[
    "a", "an", "the", "my", "our", "your", "their", "its", "this", "that", "these", "those",
    "some", "any", "please",
];

/// Clause boundaries: kept lowercase as connectors in short names, or end a long one.
const BOUNDARIES: &[&str] = &[
    "in", "on", "at", "for", "with", "from", "into", "onto", "so", "because", "when", "while",
    "and", "but", "or", "which", "where", "by", "via", "using", "after", "before", "if", "then",
    "to", "of", "about", "without", "since", "until", "as",
];

/// Canonical spellings for common technical abbreviations.
const CANONICAL: &[(&str, &str)] = &[
    ("oauth", "OAuth"),
    ("api", "API"),
    ("apis", "APIs"),
    ("ui", "UI"),
    ("ux", "UX"),
    ("css", "CSS"),
    ("html", "HTML"),
    ("json", "JSON"),
    ("sql", "SQL"),
    ("db", "DB"),
    ("url", "URL"),
    ("urls", "URLs"),
    ("id", "ID"),
    ("ids", "IDs"),
    ("ci", "CI"),
    ("pr", "PR"),
    ("prs", "PRs"),
    ("cli", "CLI"),
    ("sdk", "SDK"),
    ("jwt", "JWT"),
    ("http", "HTTP"),
    ("https", "HTTPS"),
    ("ios", "iOS"),
    ("npm", "npm"),
    ("pnpm", "pnpm"),
    ("csv", "CSV"),
    ("pdf", "PDF"),
    ("xml", "XML"),
    ("yaml", "YAML"),
    ("ssh", "SSH"),
    ("tls", "TLS"),
    ("dns", "DNS"),
    ("llm", "LLM"),
    ("ai", "AI"),
    ("readme", "README"),
    ("github", "GitHub"),
    ("typescript", "TypeScript"),
    ("javascript", "JavaScript"),
    ("sqlite", "SQLite"),
];

/// A short, descriptive, title-cased name for a thread whose first prompt is `prompt`.
pub fn name_from_prompt(prompt: &str) -> String {
    let words = first_sentence_words(prompt);
    let mut index = 0;
    while index < words.len() && LEADING_FILLER.contains(&words[index].to_lowercase().as_str()) {
        index += 1;
    }

    let mut parts: Vec<(String, bool)> = Vec::new(); // (word, is_connector)
    let mut content = 0;
    let mut length = 0;
    for word in &words[index..] {
        let lower = word.to_lowercase();
        if DROPPED.contains(&lower.as_str()) {
            continue;
        }
        let is_boundary = BOUNDARIES.contains(&lower.as_str());
        if is_boundary && (content >= ENOUGH_WORDS || content == 0) {
            if content == 0 {
                continue;
            }
            break;
        }
        let rendered = if is_boundary { lower } else { style(word) };
        let added = rendered.chars().count() + usize::from(!parts.is_empty());
        if length + added > MAX_CHARS {
            if parts.is_empty() {
                // One very long token: truncate it rather than return nothing.
                let cut: String = rendered.chars().take(MAX_CHARS - 1).collect();
                parts.push((format!("{cut}…"), false));
            }
            break;
        }
        length += added;
        parts.push((rendered, is_boundary));
        if !is_boundary {
            content += 1;
            if content >= MAX_WORDS {
                break;
            }
        }
    }
    while parts.last().is_some_and(|(_, connector)| *connector) {
        parts.pop();
    }
    if parts.is_empty() {
        return FALLBACK_NAME.to_owned();
    }
    parts
        .into_iter()
        .map(|(word, _)| word)
        .collect::<Vec<_>>()
        .join(" ")
}

/// Words of the first sentence of the first line that has any letters or digits.
fn first_sentence_words(prompt: &str) -> Vec<String> {
    let line = prompt
        .lines()
        .map(str::trim)
        .find(|line| line.chars().any(char::is_alphanumeric))
        .unwrap_or("");
    let mut sentence = String::new();
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if matches!(c, '.' | '?' | '!' | ';')
            && chars.peek().is_none_or(|next| next.is_whitespace())
        {
            break;
        }
        sentence.push(c);
    }
    sentence
        .split_whitespace()
        .map(|token| {
            token
                .trim_matches(|c: char| !(c.is_alphanumeric() || matches!(c, '_' | '#' | '@')))
                .to_owned()
        })
        .filter(|token| !token.is_empty() && !token.contains("://"))
        .collect()
}

/// Title-cases ordinary words; keeps identifiers, acronyms and mixed-case words as written.
fn style(word: &str) -> String {
    let lower = word.to_lowercase();
    if let Some((_, canonical)) = CANONICAL.iter().find(|(key, _)| *key == lower) {
        return (*canonical).to_owned();
    }
    let codeish = word
        .chars()
        .any(|c| c.is_ascii_digit() || matches!(c, '.' | '_' | '/' | '\\' | '#' | '@' | '-'))
        && word.chars().count() > 1;
    let mixed_case = word.chars().skip(1).any(char::is_uppercase);
    if codeish || mixed_case {
        return word.to_owned();
    }
    let mut chars = word.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_describe_the_task() {
        for (prompt, expected) in [
            (
                "fix the OAuth callback race in the login flow",
                "Fix OAuth Callback Race",
            ),
            (
                "Can you please fix the race condition in our OAuth callback?",
                "Fix Race Condition in OAuth Callback",
            ),
            (
                "I want you to add a dark mode toggle to the settings page",
                "Add Dark Mode Toggle",
            ),
            (
                "write unit tests for the parser module. Then run them.",
                "Write Unit Tests for Parser Module",
            ),
            (
                "Update README with install steps",
                "Update README with Install Steps",
            ),
            (
                "refactor useEffect cleanup in App.tsx",
                "Refactor useEffect Cleanup in App.tsx",
            ),
            ("Help me migrate the api to v2", "Migrate API to v2"),
            ("\n\n  bump deps\nand more", "Bump Deps"),
        ] {
            assert_eq!(name_from_prompt(prompt), expected, "{prompt:?}");
        }
    }

    #[test]
    fn names_are_deterministic_and_bounded() {
        let prompt = "implement extraordinarily comprehensive internationalization infrastructure everywhere immediately";
        let a = name_from_prompt(prompt);
        assert_eq!(a, name_from_prompt(prompt));
        assert!(a.chars().count() <= MAX_CHARS, "{a}");
        let long = "x".repeat(500);
        let name = name_from_prompt(&long);
        assert_eq!(name.chars().count(), MAX_CHARS);
        assert!(name.ends_with('…'));
    }

    #[test]
    fn empty_or_filler_prompts_fall_back() {
        for prompt in [
            "",
            "   ",
            "???",
            "please",
            "can you help me",
            "https://example.com/x",
        ] {
            assert_eq!(name_from_prompt(prompt), FALLBACK_NAME, "{prompt:?}");
        }
    }

    #[test]
    fn trailing_connectors_are_dropped() {
        assert_eq!(name_from_prompt("deploy to"), "Deploy");
        assert_eq!(name_from_prompt("fix it"), "Fix It");
    }
}
