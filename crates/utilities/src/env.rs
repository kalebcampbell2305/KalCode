//! The Environment Viewer (UD-04): variable names and the *shape* of their values, for KalCode's
//! own environment and for what a terminal or a provider CLI actually receives after KalCode's
//! sanitization. Values are never part of a listing; one is revealed only after a native
//! confirmation (the desktop shell's job), is never logged, and never goes to a provider.

use std::collections::BTreeMap;
use std::ffi::OsString;

use crate::types::{EnvEntry, EnvListing, EnvSource, EnvValueKind};

/// Name prefixes KalCode removes from a terminal's environment (mirrors
/// `kalcode_core::workspaces::SHELL_ENV_REMOVE_PREFIXES`, which is private to the core: its own
/// settings and the browser-runtime overrides test builds may keep).
pub const TERMINAL_REMOVED_PREFIXES: &[&str] =
    &["KALCODE_", "WEBVIEW2_", "COREWEBVIEW2_", "WEBKIT_INSPECTOR"];

/// Variables KalCode sets for every terminal (after removing the prefixes above).
pub fn terminal_additions(version: &str) -> Vec<(String, String)> {
    vec![
        ("TERM".into(), "xterm-256color".into()),
        ("COLORTERM".into(), "truecolor".into()),
        ("TERM_PROGRAM".into(), "KalCode".into()),
        ("TERM_PROGRAM_VERSION".into(), version.to_owned()),
    ]
}

/// Parts of a name that mark it as a credential.
const SECRET_NAME_WORDS: &[&str] = &[
    "KEY",
    "TOKEN",
    "SECRET",
    "PASS",
    "PASSWD",
    "PASSWORD",
    "CRED",
    "AUTH",
    "SESSION",
    "COOKIE",
    "PRIVATE",
    "API",
    "SIGNATURE",
    "CERT",
];

/// Names that contain a secret word but are ordinary (`PWD` is the working folder).
const NOT_SECRET_NAMES: &[&str] = &[
    "PWD",
    "OLDPWD",
    "SSH_AUTH_SOCK",
    "XAUTHORITY",
    "KEYBOARD",
    "APIPA",
];

/// Whether a name looks like it holds a credential.
pub fn is_secret_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    if NOT_SECRET_NAMES.contains(&upper.as_str()) {
        return false;
    }
    upper
        .split(|c: char| !c.is_ascii_alphanumeric())
        .any(|part| {
            SECRET_NAME_WORDS
                .iter()
                .any(|w| part == *w || part.ends_with(w) || part.starts_with(w))
        })
}

fn plural(n: usize, one: &str, many: &str) -> String {
    if n == 1 {
        format!("1 {one}")
    } else {
        format!("{n} {many}")
    }
}

fn looks_absolute(text: &str) -> bool {
    text.starts_with('/')
        || text.starts_with("\\\\")
        || (text.len() > 2
            && text.as_bytes()[1] == b':'
            && text.as_bytes()[0].is_ascii_alphabetic()
            && matches!(text.as_bytes()[2], b'\\' | b'/'))
}

/// The shape of one variable, without its value.
pub fn describe(name: &str, value: &str) -> EnvEntry {
    let length = u32::try_from(value.chars().count()).unwrap_or(u32::MAX);
    let chars = plural(length as usize, "character", "characters");
    let (kind, hint) = if value.is_empty() {
        (EnvValueKind::Empty, "Empty".to_owned())
    } else if is_secret_name(name) {
        (
            EnvValueKind::Secret,
            format!("{chars}; the name marks it as a credential"),
        )
    } else if let Some(finding) = kalcode_context::secrets::scan(&format!("{name}={value}")).first()
    {
        (
            EnvValueKind::Secret,
            format!(
                "{chars}; looks like a credential ({})",
                finding.detector.replace('_', " ")
            ),
        )
    } else if value.starts_with("http://") || value.starts_with("https://") {
        if url::Url::parse(value).is_ok_and(|u| !u.username().is_empty() || u.password().is_some())
        {
            (
                EnvValueKind::Secret,
                format!("{chars}; a URL with credentials"),
            )
        } else {
            (EnvValueKind::Url, "A URL".to_owned())
        }
    } else if matches!(
        value.to_ascii_lowercase().as_str(),
        "0" | "1" | "true" | "false" | "yes" | "no" | "on" | "off"
    ) {
        (EnvValueKind::Flag, "A switch (on/off)".to_owned())
    } else if value.parse::<f64>().is_ok() {
        (EnvValueKind::Number, "A number".to_owned())
    } else {
        let separator = if cfg!(windows) { ';' } else { ':' };
        let parts: Vec<&str> = value.split(separator).filter(|p| !p.is_empty()).collect();
        if parts.len() > 1 && parts.iter().filter(|p| looks_absolute(p)).count() * 2 >= parts.len()
        {
            (
                EnvValueKind::PathList,
                plural(parts.len(), "folder", "folders"),
            )
        } else if looks_absolute(value) {
            (EnvValueKind::Path, "A path".to_owned())
        } else {
            (EnvValueKind::Text, chars)
        }
    };
    EnvEntry {
        name: name.to_owned(),
        redacted: true,
        kind,
        length,
        hint,
    }
}

/// An environment as a name → value map (non-UTF-8 names dropped; values lossy).
pub fn from_os<I>(vars: I) -> BTreeMap<String, String>
where
    I: IntoIterator<Item = (OsString, OsString)>,
{
    vars.into_iter()
        .filter_map(|(name, value)| {
            name.into_string()
                .ok()
                .map(|n| (n, value.to_string_lossy().into_owned()))
        })
        .collect()
}

/// What a new terminal receives: KalCode's environment minus the removed prefixes, plus the
/// terminal variables.
pub fn terminal_env(kalcode: &BTreeMap<String, String>, version: &str) -> BTreeMap<String, String> {
    let mut env: BTreeMap<String, String> = kalcode
        .iter()
        .filter(|(name, _)| {
            let upper = name.to_ascii_uppercase();
            !TERMINAL_REMOVED_PREFIXES
                .iter()
                .any(|p| upper.starts_with(p))
        })
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    for (name, value) in terminal_additions(version) {
        env.retain(|k, _| !k.eq_ignore_ascii_case(&name));
        env.insert(name, value);
    }
    env
}

/// A listing of `env` (sorted by name, case-insensitively), with the names KalCode's own
/// environment has that this source does not receive.
pub fn listing(
    source: EnvSource,
    env: &BTreeMap<String, String>,
    kalcode: &BTreeMap<String, String>,
    note: String,
) -> EnvListing {
    let mut entries: Vec<EnvEntry> = env.iter().map(|(n, v)| describe(n, v)).collect();
    entries.sort_by(|a, b| {
        a.name
            .to_ascii_lowercase()
            .cmp(&b.name.to_ascii_lowercase())
    });
    let mut withheld: Vec<String> = kalcode
        .keys()
        .filter(|k| !env.keys().any(|e| e.eq_ignore_ascii_case(k)))
        .cloned()
        .collect();
    withheld.sort_by_key(|k| k.to_ascii_lowercase());
    EnvListing {
        source,
        entries,
        withheld,
        note,
    }
}

/// The value of `name` in `env` (case-insensitively on Windows).
pub fn value_of(env: &BTreeMap<String, String>, name: &str) -> Option<String> {
    env.get(name).cloned().or_else(|| {
        cfg!(windows)
            .then(|| {
                env.iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case(name))
                    .map(|(_, v)| v.clone())
            })
            .flatten()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn listings_never_contain_values() {
        let token = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";
        let kalcode = env(&[
            ("GITHUB_TOKEN", token),
            ("PLAIN_LOOKING", token),
            ("HOME", "/home/me"),
            ("EDITOR", "vim"),
        ]);
        let listing = listing(EnvSource::KalCode, &kalcode, &kalcode, "n".into());
        let json = serde_json::to_string(&listing).expect("json");
        assert!(!json.contains(token), "{json}");
        assert!(!json.contains("vim"), "{json}");
        assert!(!json.contains("/home/me"), "{json}");
        assert!(listing.entries.iter().all(|e| e.redacted));
        let by_name = |n: &str| {
            listing
                .entries
                .iter()
                .find(|e| e.name == n)
                .expect("entry")
                .kind
        };
        assert_eq!(by_name("GITHUB_TOKEN"), EnvValueKind::Secret);
        // Detected by content even though the name is innocent.
        assert_eq!(by_name("PLAIN_LOOKING"), EnvValueKind::Secret);
        assert_eq!(by_name("HOME"), EnvValueKind::Path);
        assert_eq!(by_name("EDITOR"), EnvValueKind::Text);
    }

    #[test]
    fn shapes_are_described() {
        assert_eq!(describe("A", "").kind, EnvValueKind::Empty);
        assert_eq!(describe("A", "1").kind, EnvValueKind::Flag);
        assert_eq!(describe("A", "8080").kind, EnvValueKind::Number);
        assert_eq!(describe("A", "https://example.com").kind, EnvValueKind::Url);
        assert_eq!(
            describe("A", "https://me:pw@example.com").kind,
            EnvValueKind::Secret
        );
        let list = if cfg!(windows) {
            r"C:\Windows;C:\Tools;C:\bin"
        } else {
            "/usr/bin:/bin:/opt/x"
        };
        let path = describe("PATH", list);
        assert_eq!(path.kind, EnvValueKind::PathList);
        assert_eq!(path.hint, "3 folders");
        assert!(!is_secret_name("PWD"));
        assert!(is_secret_name("AWS_SECRET_ACCESS_KEY"));
        assert!(is_secret_name("OPENAI_API_KEY"));
        assert!(is_secret_name("DB_PASSWORD"));
        assert!(!is_secret_name("PATH"));
        assert!(!is_secret_name("NUMBER_OF_PROCESSORS"));
    }

    #[test]
    fn terminals_receive_the_sanitized_environment() {
        let kalcode = env(&[
            ("KALCODE_DATA_DIR", "/tmp/x"),
            ("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--x"),
            ("PATH", "/usr/bin"),
            ("TERM", "dumb"),
        ]);
        let terminal = terminal_env(&kalcode, "1.2.3");
        assert!(!terminal.contains_key("KALCODE_DATA_DIR"));
        assert!(!terminal.contains_key("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"));
        assert_eq!(
            terminal.get("TERM").map(String::as_str),
            Some("xterm-256color")
        );
        assert_eq!(
            terminal.get("TERM_PROGRAM_VERSION").map(String::as_str),
            Some("1.2.3")
        );
        let listing = listing(EnvSource::Terminal, &terminal, &kalcode, "n".into());
        assert_eq!(
            listing.withheld,
            vec![
                "KALCODE_DATA_DIR".to_owned(),
                "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS".to_owned()
            ]
        );
        assert_eq!(value_of(&terminal, "PATH").as_deref(), Some("/usr/bin"));
        assert_eq!(value_of(&terminal, "MISSING"), None);
    }
}
