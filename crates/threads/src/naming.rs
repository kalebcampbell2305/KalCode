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

/// Explicit changes of primary task, rather than ordinary replies or refinements.
pub fn new_primary_task(prompt: &str) -> bool {
    task_prefix(prompt.trim()).is_some()
}

/// Raw PTY input is not an authenticated user-prompt hook. Require a clear task
/// instruction so an ordinary multiword password cannot become a visible title.
pub fn has_task_intent(prompt: &str) -> bool {
    if unsafe_title_input(prompt) {
        return false;
    }
    let prompt = task_prefix(prompt.trim()).unwrap_or(prompt.trim());
    first_sentence_words(prompt)
        .iter()
        .map(|word| word.to_lowercase())
        .find(|word| !LEADING_FILLER.contains(&word.as_str()))
        .is_some_and(|word| task_action(&word).is_some())
}

fn unsafe_title_input(prompt: &str) -> bool {
    prompt.chars().any(|c| {
        (c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
            || matches!(c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{feff}')
    })
}

/// Keep titles stable for refinements and routine test/review instructions. A complete
/// implementation request with a different subject can establish a new primary task
/// even when the user does not literally say "new task".
pub fn should_update_task(current_name: &str, prompt: &str) -> bool {
    if new_primary_task(prompt) {
        return true;
    }
    let words = first_sentence_words(prompt);
    if words.iter().any(|word| {
        [
            "it", "its", "this", "that", "these", "those", "too", "also", "again", "same",
            "instead",
        ]
        .contains(&word.to_lowercase().as_str())
    }) {
        return false;
    }
    let Some((index, action)) =
        words.iter().take(10).enumerate().find_map(|(index, word)| {
            task_action(&word.to_lowercase()).map(|action| (index, action))
        })
    else {
        return false;
    };
    if !matches!(
        action,
        "Build" | "Fix" | "Redesign" | "Refactor" | "Migration"
    ) {
        return false;
    }
    let Some(next_name) = task_name_from_prompt(prompt) else {
        return false;
    };
    let topic = |name: &str| -> Vec<String> {
        name.split_whitespace()
            .map(str::to_lowercase)
            .filter(|word| {
                task_action(word).is_none()
                    && ![
                        "new",
                        "page",
                        "screen",
                        "task",
                        "code",
                        "work",
                        "update",
                        "migration",
                    ]
                    .contains(&word.as_str())
            })
            .collect()
    };
    let next = topic(&next_name);
    let current = topic(current_name);
    // A single generic subject ("fix tests") is not sufficient evidence to relabel.
    index < words.len()
        && next.len() >= 2
        && !current.is_empty()
        && !next.iter().any(|word| current.contains(word))
}

fn task_prefix(prompt: &str) -> Option<&str> {
    [
        "new task:",
        "new task ",
        "next task:",
        "next task ",
        "different task:",
        "different task ",
        "switch to ",
        "switch tasks:",
        "instead, ",
        "instead ",
        "now focus on ",
        "let's work on ",
        "lets work on ",
        "now let's ",
        "now lets ",
    ]
    .into_iter()
    .find_map(|prefix| {
        prompt
            .get(..prefix.len())
            .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
            .then(|| prompt[prefix.len()..].trim())
    })
}

/// A local, provider-independent task title. Never stores the prompt, calls a model, or
/// turns authentication input, slash commands and conversational replies into tab names.
/// Existing chat naming remains compatible through `name_from_prompt` below.
pub fn task_name_from_prompt(prompt: &str) -> Option<String> {
    let prompt = prompt.trim();
    if prompt.is_empty()
        || unsafe_title_input(prompt)
        || prompt.starts_with(['/', '<', '{', '[', '`'])
    {
        return None;
    }
    let prompt = task_prefix(prompt).unwrap_or(prompt);
    let words = first_sentence_words(prompt);
    if words.is_empty() {
        return None;
    }
    let first = words[0].to_lowercase();
    if [
        "password",
        "passphrase",
        "secret",
        "token",
        "bearer",
        "authorization",
        "api_key",
        "api-key",
    ]
    .contains(&first.as_str())
    {
        return None;
    }
    // Find the intent after a polite or provider-addressed opening without knowing
    // anything about the provider itself ("Assistant, could you please fix ...").
    let intent =
        words.iter().take(10).enumerate().find_map(|(index, word)| {
            task_action(&word.to_lowercase()).map(|action| (index, action))
        });
    if intent.is_none()
        && [
            "thank", "thanks", "yes", "no", "ok", "okay", "hi", "hello", "looks", "continue",
            "proceed",
        ]
        .contains(&first.as_str())
    {
        return None;
    }
    let (start, action) = intent.map_or((0, None), |(index, action)| (index + 1, Some(action)));
    let mut subject = Vec::new();
    for word in &words[start..] {
        let lower = word.to_lowercase();
        if BOUNDARIES.contains(&lower.as_str()) {
            if !subject.is_empty() {
                break;
            }
            continue;
        }
        if DROPPED.contains(&lower.as_str())
            || LEADING_FILLER.contains(&lower.as_str())
            || [
                "new", "existing", "all", "it", "them", "that", "this", "now", "again", "same",
                "yes", "no", "thanks", "thank", "great", "good", "looks", "continue", "proceed",
                "done", "okay", "sure", "right", "more", "do",
            ]
            .contains(&lower.as_str())
        {
            continue;
        }
        // Identifiers are useful; credentials, URLs, email addresses, command flags,
        // assignments and long opaque tokens are not useful human-readable titles.
        if word.chars().count() > 32
            || word.contains(['@', '=', ':', '/', '\\'])
            || word.starts_with('-')
            || ["sk-", "sk_", "ghp_", "github_pat_", "xoxb-", "xoxp-", "eyJ"]
                .iter()
                .any(|prefix| word.starts_with(prefix))
            || word.chars().filter(char::is_ascii_digit).count() > 6
            || !word.chars().any(char::is_alphabetic)
        {
            continue;
        }
        subject.push(word.as_str());
        if subject.len() == 4 {
            break;
        }
    }
    // A title needs a topic. A single unrecognised token is usually a reply, code,
    // or authentication input, not a task. Non-Latin task phrases need not use spaces.
    if subject.is_empty()
        || (action.is_none()
            && subject.len() < 2
            && !(subject[0].chars().count() >= 6 && !subject[0].is_ascii()))
    {
        return None;
    }
    if action == Some("Redesign")
        && subject.len() > 1
        && subject.last().is_some_and(|word| {
            ["page", "screen", "interface"].contains(&word.to_lowercase().as_str())
        })
    {
        subject.pop();
    }
    // "Provider tool calling" is already described by "Provider Tool Fix";
    // keep meaningful two-word topics such as "Error Handling" intact.
    if action == Some("Fix")
        && subject.len() > 2
        && subject
            .last()
            .is_some_and(|word| word.to_lowercase().ends_with("ing"))
    {
        subject.pop();
    }
    let mut parts: Vec<String> = subject.into_iter().map(task_word).collect();
    match action {
        Some(
            action @ ("Fix" | "Redesign" | "Refactor" | "Optimization" | "Update" | "Removal"
            | "Migration"),
        ) => parts.push(action.to_owned()),
        Some(action) if parts.len() == 1 => parts.insert(0, action.to_owned()),
        _ => {}
    }
    let mut result = String::new();
    for word in parts.into_iter().take(5) {
        let extra = word.chars().count() + usize::from(!result.is_empty());
        if result.chars().count() + extra > MAX_CHARS {
            break;
        }
        if !result.is_empty() {
            result.push(' ');
        }
        result.push_str(&word);
    }
    (!result.is_empty()).then_some(result)
}

fn task_action(word: &str) -> Option<&'static str> {
    Some(match word {
        "fix" | "repair" | "debug" | "resolve" => "Fix",
        "redesign" => "Redesign",
        "refactor" => "Refactor",
        "optimize" => "Optimization",
        "update" | "upgrade" | "change" | "improve" => "Update",
        "remove" | "delete" => "Removal",
        "migrate" => "Migration",
        "review" | "audit" | "inspect" => "Review",
        "build" | "implement" | "create" | "add" | "design" => "Build",
        "write" => "Write",
        "test" | "verify" | "check" => "Test",
        "run" => "Run",
        "deploy" | "release" | "ship" => "Release",
        "investigate" | "research" | "explain" | "find" => "Investigate",
        _ => return None,
    })
}

fn task_word(word: &str) -> String {
    if word.len() > 4 && word.chars().all(|c| c.is_ascii_uppercase()) {
        style(&word.to_lowercase())
    } else {
        style(word)
    }
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
    fn agent_titles_describe_primary_topic_without_copying_the_prompt() {
        for (prompt, expected) in [
            (
                "Redesign the pricing page and update annual plans.",
                "Pricing Redesign",
            ),
            (
                "Fix provider tool calling for all adapters.",
                "Provider Tool Fix",
            ),
            (
                "Review the billing webhooks and fix cancellation sync.",
                "Billing Webhooks",
            ),
            ("Build the new Live Browser.", "Live Browser"),
            (
                "Assistant, could you please fix the OAuth callback race?",
                "OAuth Callback Race Fix",
            ),
            (
                "Add keyboard shortcuts for switching workspaces",
                "Keyboard Shortcuts",
            ),
            ("New task: build the settings page", "Settings Page"),
            ("Run tests", "Run Tests"),
            ("Billing webhooks", "Billing Webhooks"),
            ("修复设置页面中的错误", "修复设置页面中的错误"),
        ] {
            assert_eq!(
                task_name_from_prompt(prompt).as_deref(),
                Some(expected),
                "{prompt}"
            );
        }
    }

    #[test]
    fn agent_titles_ignore_non_tasks_and_sensitive_inputs() {
        for prompt in [
            "",
            "yes",
            "thanks very much",
            "looks good to me",
            "please",
            "continue",
            "continue with that",
            "fix it",
            "/model",
            "/login user@example.com",
            "password secret-value",
            "Bearer eyJhbGciOiJIUzI1NiJ9",
            "sk-proj-1234567890",
            "user@example.com",
            "https://example.com",
            "<environment_context>private setup</environment_context>",
            "Fix foo\u{1b}bar",
            "Fix foo\u{202e}bar",
        ] {
            assert_eq!(task_name_from_prompt(prompt), None, "{prompt}");
        }
        let title = task_name_from_prompt(
            "Fix authentication sk-proj-secret123456789012345678901234567890",
        )
        .unwrap();
        assert!(!title.contains("secret"));
        assert!(!title.contains("sk-proj"));
        assert!(!has_task_intent("correct horse battery staple"));
        assert!(!has_task_intent("correct horse build stable"));
        assert!(!has_task_intent("Fix foo\u{1b}bar"));
        assert!(has_task_intent("Please build the new Live Browser"));
        assert!(has_task_intent("New task: fix billing webhooks"));
    }

    #[test]
    fn agent_titles_are_bounded_and_primary_task_changes_are_explicit() {
        let title = task_name_from_prompt(
            "Implement responsive accessible keyboard navigation controls everywhere",
        )
        .unwrap();
        assert!(title.chars().count() <= MAX_CHARS);
        assert!(title.split_whitespace().count() <= 5);
        for prompt in [
            "New task: build a dashboard",
            "Switch to fixing billing",
            "Instead, review webhooks",
            "Now focus on the browser",
        ] {
            assert!(new_primary_task(prompt), "{prompt}");
        }
        for prompt in [
            "Fix its label too",
            "Run the tests again",
            "Keep working",
            "Can you explain that change?",
            "That next task can wait",
            "New tasK: build the browser",
        ] {
            assert!(!new_primary_task(prompt), "{prompt}");
        }
        assert!(should_update_task(
            "Pricing Redesign",
            "Build the new Live Browser."
        ));
        assert!(should_update_task("Live Browser", "Fix billing webhooks"));
        for prompt in [
            "Run the tests again",
            "Fix its label too",
            "Review billing webhooks",
            "Fix pricing layout",
            "Build this responsive layout",
            "Fix tests",
        ] {
            assert!(!should_update_task("Pricing Redesign", prompt), "{prompt}");
        }
    }

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
