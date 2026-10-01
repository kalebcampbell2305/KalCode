//! The Context Firewall's detector layer on top of the shared catalogue (see
//! [`crate::secrets`]): extra credential formats, whole-value extraction, whole-token extension
//! of fixed-length matches, and the linear entropy heuristic.
//!
//! Every function here is linear in the input: regexes run once over the text (the `regex`
//! crate has no backtracking), value readers scan forward from a match, and range lookups use
//! sorted vectors.

use std::{collections::HashSet, sync::LazyLock};

use regex::Regex;

use crate::secrets::{Confidence, ENTROPY_DETECTOR, Finding, ScanContext, is_code_file};

/// Ids of detectors added by this layer (the rest come from the shared catalogue).
pub const EXTRA_DETECTOR_IDS: &[&str] = &["cloud_secret_key", "webhook_url", "auth_header"];

// ---- the catalogue ------------------------------------------------------------------------

/// What a regex match means.
#[derive(Clone, Copy)]
enum Kind {
    /// Capture `group` is the secret.
    Group(usize),
    /// Capture 1 is a base64 run that is a secret only if it decodes to a PEM private key.
    Base64Pem,
    /// Capture 1 is a name; the value starts at the end of the match (read by [`read_value`]).
    NamedValue,
    /// Capture 1 is an XML element name; capture 2 is the value; the closing tag must match.
    XmlElement,
    /// Capture 1 is a YAML key introducing a block scalar; the value is the indented block.
    YamlBlock,
}

struct Extra {
    id: &'static str,
    pattern: &'static str,
    kind: Kind,
    /// Cheap literal prefilter: skip the regex when none of these occur (ASCII, any case).
    needles: &'static [&'static str],
    /// Apply the placeholder / reference filter to `Group` values.
    filter: bool,
    /// Values must contain something other than letters, `_`, `-` and spaces (used where the
    /// "value" may just be the next word of a list).
    strict: bool,
}

const fn group(
    id: &'static str,
    pattern: &'static str,
    g: usize,
    needles: &'static [&'static str],
) -> Extra {
    Extra {
        id,
        pattern,
        kind: Kind::Group(g),
        needles,
        filter: false,
        strict: false,
    }
}

const EXTRAS: &[Extra] = &[
    // Private keys the shared catalogue misses: RFC 4716 (SSH2) blocks and age identities.
    group(
        "private_key",
        r"---- BEGIN SSH2 (?:ENCRYPTED )?PRIVATE KEY ----([\s\S]*?)(?:---- END SSH2[^\r\n]*----|\z)",
        1,
        &["---- begin ssh2"],
    ),
    group(
        "private_key",
        r"AGE-SECRET-KEY-1[0-9A-Za-z]{58}",
        0,
        &["age-secret-key-1"],
    ),
    // A PEM private key encoded as base64 (kubeconfig `client-key-data`, Kubernetes secrets).
    Extra {
        id: "private_key",
        pattern: r"(LS0tLS1CRUdJTi[A-Za-z0-9+/=]{16,})",
        kind: Kind::Base64Pem,
        needles: &["ls0tls1crudjti"],
        filter: false,
        strict: false,
    },
    // Cloud key id followed by its secret (console `accessKeys.csv`, pasted pairs).
    group(
        "cloud_secret_key",
        r"(?:AKIA|ASIA)[0-9A-Z]{16}[ \t]*[,;:|\t][ \t]*([A-Za-z0-9/+=]{40})(?:[^A-Za-z0-9/+=]|$)",
        1,
        &["akia", "asia"],
    ),
    // Incoming-webhook URLs whose path is the credential.
    group(
        "webhook_url",
        r"hooks\.slack\.com/(?:services|workflows|triggers)/([A-Za-z0-9_/-]{16,})",
        1,
        &["hooks.slack.com"],
    ),
    group(
        "webhook_url",
        r"discord(?:app)?\.com/api/webhooks/(\d+/[A-Za-z0-9_-]{20,})",
        1,
        &["/api/webhooks/"],
    ),
    group(
        "webhook_url",
        r"webhook\.office\.com/webhookb2/([A-Za-z0-9@/_-]{20,})",
        1,
        &["webhook.office.com"],
    ),
    // URL credentials with an empty user (`redis://:pw@`) or `/` in the password.
    Extra {
        id: "url_credentials",
        pattern: r#"\b[a-zA-Z][a-zA-Z0-9+.-]*://[^\s:@/"'<>]*:([^\s@"'<>]+)@[^\s@"'<>]"#,
        kind: Kind::Group(1),
        needles: &["://"],
        filter: true,
        strict: false,
    },
    // Authorization schemes other than Bearer/Basic (handled by the shared catalogue).
    group(
        "auth_header",
        r#"(?i)\bauthorization\\?["']?[ \t]*[:=][ \t]*(?:\\?["'])?[ \t]*(?:token|digest|apikey|api-key|key|sso-key|ssws|splunk|dsn|oauth|mac|negotiate|ntlm|aws4-hmac-sha256|hmac[\w-]*)[ \t]+([^\r\n"'\\]{6,})"#,
        1,
        &["authorization"],
    ),
    // `curl -u user:password`, `--user=user:password`.
    Extra {
        id: "basic_auth",
        pattern: r#"(?:^|[\s'"])(?:-u|--user|--proxy-user)(?:[ \t]+|=)['"]?[^\s:'"]+:([^\s'"]{4,})"#,
        kind: Kind::Group(1),
        needles: &["-u", "--user", "--proxy-user"],
        filter: true,
        strict: false,
    },
    // `mysql -pSECRET` (the password glued to `-p`).
    Extra {
        id: "sensitive_assignment",
        pattern: r#"(?i)\b(?:mysql|mysqldump|mysqladmin|mysqlimport|mysqlcheck|mysqlshow|mariadb|mariadb-dump)\b[^\r\n]*?[ \t]-p((?:'[^'\r\n]+'|"[^"\r\n]+"|[^\s'"-][^\s'"]*))"#,
        kind: Kind::Group(1),
        needles: &["mysql", "mariadb"],
        filter: true,
        strict: false,
    },
    // `--password value`, `-password value`, `--token value` (space-separated flags).
    Extra {
        id: "sensitive_assignment",
        pattern: r#"(?i)(?:^|[\s'"])--?(?:password|passwd|pass|pwd|token|secret|api-?key|access-?token|auth-?token|client-?secret|private-?key|passphrase)[ \t]+(['"]?[^\s'"-][^\s'"]*['"]?)"#,
        kind: Kind::Group(1),
        needles: &["pass", "pwd", "token", "secret", "key"],
        filter: true,
        strict: false,
    },
    // `NAME = value` / `"name": "value"` with a sensitive name the shared catalogue does not
    // cover, or a value it cuts short (spaces in quotes, `&`, `(`, `$` in config values).
    Extra {
        id: "sensitive_assignment",
        pattern: r#"(?:^|[^A-Za-z0-9_.-])([A-Za-z0-9_.-]*(?i:pass|pw|secret|key|token|auth|cred|sig)[A-Za-z0-9_.-]*)\\?["']?[ \t]*(?::=|=>|:|=)[ \t]*"#,
        kind: Kind::NamedValue,
        needles: &[],
        filter: true,
        strict: false,
    },
    // Dockerfile `ENV NAME value` / `ARG NAME value` (space syntax).
    Extra {
        id: "sensitive_assignment",
        pattern: r"(?m)^[ \t]*(?:ENV|ARG)[ \t]+([A-Za-z0-9_.-]*(?i:pass|pw|secret|key|token|auth|cred|sig)[A-Za-z0-9_.-]*)[ \t]+",
        kind: Kind::NamedValue,
        needles: &["env ", "arg ", "env\t", "arg\t"],
        filter: true,
        strict: false,
    },
    // `name: DB_PASSWORD` followed by `value: …` (Kubernetes env, JSON name/value lists,
    // XML `key="ApiKey" value="…"`).
    Extra {
        id: "sensitive_assignment",
        pattern: r#"\b(?:name|key|Name|Key|NAME|KEY)\\?["']?[ \t]*[:=][ \t]*\\?["']?([A-Za-z0-9_.-]*(?i:pass|pw|secret|key|token|auth|cred|sig)[A-Za-z0-9_.-]*)\\?["']?[\s,]{1,40}?(?:-[ \t]+)?\\?["']?(?:value|Value|VALUE)\\?["']?[ \t]*[:=][ \t]*"#,
        kind: Kind::NamedValue,
        needles: &["value"],
        filter: true,
        strict: false,
    },
    // Quoted call arguments: `define('DB_PASSWORD', '…')`, `setdefault("API_KEY", "…")`.
    Extra {
        id: "sensitive_assignment",
        pattern: r#"['"]([A-Za-z0-9_.-]*(?i:pass|pw|secret|key|token|auth|cred|sig)[A-Za-z0-9_.-]*)['"][ \t]*,[ \t]*"#,
        kind: Kind::NamedValue,
        needles: &[","],
        filter: true,
        strict: true,
    },
    // XML elements: `<password>…</password>`, `<ApiKey>…</ApiKey>`.
    Extra {
        id: "sensitive_assignment",
        pattern: r"<([A-Za-z0-9_:.-]*(?i:pass|pw|secret|key|token|auth|cred|sig|connectionstring)[A-Za-z0-9_:.-]*)(?:[ \t][^<>]*)?>([^<>\r\n]{4,})</([A-Za-z_][A-Za-z0-9_:.-]*)[ \t]*>",
        kind: Kind::XmlElement,
        needles: &["</"],
        filter: true,
        strict: false,
    },
    // YAML block scalars: `password: |` followed by an indented block.
    Extra {
        id: "sensitive_assignment",
        pattern: r"(?m)^[ \t]*(?:-[ \t]+)?([A-Za-z0-9_.-]*(?i:pass|pw|secret|key|token|auth|cred|sig)[A-Za-z0-9_.-]*)[ \t]*:[ \t]*[|>][+-]?[0-9]?[+-]?[ \t]*(?:#[^\r\n]*)?\r?$",
        kind: Kind::YamlBlock,
        needles: &["|", ">"],
        filter: true,
        strict: false,
    },
];

struct Compiled {
    extra: &'static Extra,
    regex: Regex,
}

static COMPILED: LazyLock<Vec<Compiled>> = LazyLock::new(|| {
    EXTRAS
        .iter()
        .filter_map(|extra| {
            Regex::new(extra.pattern)
                .ok()
                .map(|regex| Compiled { extra, regex })
        })
        .collect()
});

/// `(compiled, declared)` — an invalid pattern would silently weaken detection.
pub fn compiled_extra_count() -> (usize, usize) {
    (COMPILED.len(), EXTRAS.len())
}

/// Findings of the extra detectors (unsorted, possibly overlapping).
pub fn findings(text: &str, context: ScanContext<'_>) -> Vec<Finding> {
    let lower_needles = NeedleIndex::new(text);
    let code = context.file_name.is_some_and(is_code_file);
    let mut out = Vec::new();
    for compiled in COMPILED.iter() {
        let extra = compiled.extra;
        if !extra.needles.is_empty() && !extra.needles.iter().any(|n| lower_needles.contains(n)) {
            continue;
        }
        for caps in compiled.regex.captures_iter(text) {
            match extra.kind {
                Kind::Group(g) => {
                    let Some(value) = caps.get(g) else { continue };
                    let (start, end) = trim_quotes(text, value.start(), value.end());
                    if start >= end {
                        continue;
                    }
                    let v = &text[start..end];
                    if extra.filter
                        && is_reference_or_placeholder(v, quote_before(text, start), true, code)
                    {
                        continue;
                    }
                    if extra.id == "url_credentials" && looks_like_port_and_path(v) {
                        continue;
                    }
                    if extra.filter && v.bytes().all(|b| b.is_ascii_digit()) {
                        continue;
                    }
                    out.push(finding(extra.id, start, end, Confidence::High));
                }
                Kind::Base64Pem => {
                    let Some(value) = caps.get(1) else { continue };
                    if decodes_to_private_key(value.as_str()) {
                        out.push(finding(
                            extra.id,
                            value.start(),
                            value.end(),
                            Confidence::High,
                        ));
                    }
                }
                Kind::NamedValue => {
                    let (Some(name), Some(whole)) = (caps.get(1), caps.get(0)) else {
                        continue;
                    };
                    let Some(confidence) = sensitive_name(name.as_str()) else {
                        continue;
                    };
                    if let Some((start, end, quoted)) = read_value(text, whole.end())
                        && accept_value(&text[start..end], quoted, confidence, code)
                        && !(extra.strict && is_plain_words(&text[start..end]))
                    {
                        out.push(finding(extra.id, start, end, confidence));
                    }
                }
                Kind::XmlElement => {
                    let (Some(open), Some(value), Some(close)) =
                        (caps.get(1), caps.get(2), caps.get(3))
                    else {
                        continue;
                    };
                    if !open.as_str().eq_ignore_ascii_case(close.as_str()) {
                        continue;
                    }
                    let local = open.as_str().rsplit(':').next().unwrap_or(open.as_str());
                    let Some(confidence) = sensitive_name(local) else {
                        continue;
                    };
                    let (start, end) = trim_spaces(text, value.start(), value.end());
                    if start < end && accept_value(&text[start..end], None, confidence, code) {
                        out.push(finding(extra.id, start, end, confidence));
                    }
                }
                Kind::YamlBlock => {
                    let (Some(name), Some(whole)) = (caps.get(1), caps.get(0)) else {
                        continue;
                    };
                    let Some(confidence) = sensitive_name(name.as_str()) else {
                        continue;
                    };
                    let key_column = name.start() - line_start(text, name.start());
                    if let Some((start, end)) = yaml_block(text, whole.end(), key_column)
                        && text[start..end].trim().len() >= 6
                    {
                        out.push(finding(extra.id, start, end, confidence));
                    }
                }
            }
        }
    }
    out
}

fn finding(detector: &'static str, start: usize, end: usize, confidence: Confidence) -> Finding {
    Finding {
        detector,
        start,
        end,
        confidence,
    }
}

/// Lower-cased copy for the literal prefilter (ASCII only; cheap and linear).
struct NeedleIndex(String);

impl NeedleIndex {
    fn new(text: &str) -> Self {
        Self(text.to_ascii_lowercase())
    }

    fn contains(&self, needle: &str) -> bool {
        self.0.contains(needle)
    }
}

// ---- names ----------------------------------------------------------------------------------

/// Words ending a name that describe *about* a secret, not the secret (`PASSWORD_MIN_LENGTH`,
/// `SECRET_NAME`, `KEY_PATH`, `TOKEN_URL`).
const NOT_A_VALUE: &[&str] = &[
    "path",
    "file",
    "filename",
    "files",
    "dir",
    "directory",
    "folder",
    "name",
    "names",
    "url",
    "uri",
    "urls",
    "endpoint",
    "host",
    "id",
    "ids",
    "type",
    "types",
    "length",
    "len",
    "min",
    "max",
    "env",
    "var",
    "variable",
    "ref",
    "arn",
    "version",
    "policy",
    "rotation",
    "expiry",
    "expires",
    "expiration",
    "expire",
    "ttl",
    "hint",
    "prompt",
    "label",
    "field",
    "header",
    "param",
    "count",
    "size",
    "format",
    "algorithm",
    "alg",
    "mode",
    "required",
    "enabled",
    "disabled",
    "strength",
    "reset",
    "regex",
    "pattern",
    "placeholder",
    "template",
    "location",
    "store",
    "provider",
    "source",
    "method",
    "strategy",
    "kind",
    "usage",
    "chars",
    "rules",
    "validator",
    "validation",
    "input",
    "form",
    "button",
    "error",
    "message",
    "msg",
    "text",
    "prefix",
    "suffix",
    "length",
    "timeout",
    "lifetime",
    "duration",
    "age",
    "limit",
    "count",
    "question",
    "manager",
    "service",
    "class",
    "schema",
    "id_env",
    "fingerprint",
    "helper",
];

/// Suffixes that still carry the secret (`SECRET_KEY_BASE`, `CLIENT_KEY_DATA`, `API_KEY_2`).
const CARRIER: &[&str] = &[
    "base",
    "b64",
    "base64",
    "hex",
    "value",
    "data",
    "raw",
    "str",
    "string",
    "enc",
    "encrypted",
    "plain",
    "plaintext",
    "prod",
    "production",
    "live",
    "test",
    "dev",
    "staging",
    "current",
    "new",
    "old",
    "json",
    "pem",
    "der",
    "bytes",
    "1",
    "2",
    "3",
    "v1",
    "v2",
];

const STRONG_WORDS: &[&str] = &[
    "secret",
    "secrets",
    "password",
    "passwords",
    "passwd",
    "passphrase",
    "credential",
    "credentials",
    "creds",
    "pwd",
    "pw",
    "pass",
    "passcode",
    "privatekey",
    "apikey",
    "secretkey",
    "accesskey",
    "authtoken",
    "accesstoken",
    "refreshtoken",
    "clientsecret",
];

const STRONG_PAIRS: &[(&str, &str)] = &[
    ("api", "key"),
    ("access", "key"),
    ("private", "key"),
    ("secret", "key"),
    ("master", "key"),
    ("signing", "key"),
    ("encryption", "key"),
    ("auth", "token"),
    ("access", "token"),
    ("refresh", "token"),
    ("session", "token"),
    ("bot", "token"),
    ("client", "secret"),
    ("client", "key"),
    ("app", "secret"),
    ("webhook", "secret"),
];

const WEAK_LAST: &[&str] = &[
    "key",
    "token",
    "auth",
    "signature",
    "sig",
    "cred",
    "keydata",
];

/// Splits `DB_PASSWORD`, `apiKey`, `client-key-data`, `x.api.key` into lower-case words.
fn words(name: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut prev_lower = false;
    for c in name.chars() {
        if !c.is_ascii_alphanumeric() {
            if !current.is_empty() {
                out.push(std::mem::take(&mut current));
            }
            prev_lower = false;
            continue;
        }
        if c.is_ascii_uppercase() && prev_lower && !current.is_empty() {
            out.push(std::mem::take(&mut current));
        }
        prev_lower = c.is_ascii_lowercase() || c.is_ascii_digit();
        current.push(c.to_ascii_lowercase());
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// Whether a key name labels a secret value, and how sure that is.
pub(crate) fn sensitive_name(name: &str) -> Option<Confidence> {
    let mut words = words(name);
    if words
        .last()
        .is_some_and(|w| NOT_A_VALUE.contains(&w.as_str()))
    {
        return None;
    }
    let before = words.len();
    while words.len() > 1 && words.last().is_some_and(|w| CARRIER.contains(&w.as_str())) {
        words.pop();
    }
    let stripped = words.len() < before;
    let last = words.last()?.as_str();
    let prev = words.len().checked_sub(2).map(|i| words[i].as_str());
    if STRONG_WORDS.contains(&last) {
        return Some(Confidence::High);
    }
    if let Some(prev) = prev
        && STRONG_PAIRS.contains(&(prev, last))
    {
        return Some(Confidence::High);
    }
    if words.iter().any(|w| {
        matches!(
            w.as_str(),
            "secret" | "password" | "passwd" | "passphrase" | "credential" | "credentials"
        )
    }) {
        return Some(Confidence::High);
    }
    if WEAK_LAST.contains(&last) {
        return Some(if stripped {
            Confidence::High
        } else {
            Confidence::Medium
        });
    }
    None
}

// ---- values ---------------------------------------------------------------------------------

/// Reads the value starting at `from` (after optional spaces): a quoted string to its closing
/// quote on the same line (spaces included; `\"` and doubled quotes stay inside), or an
/// unquoted token to the next space or delimiter. Returns `(start, end, quote)` of the value
/// without its quotes.
fn read_value(text: &str, from: usize) -> Option<(usize, usize, Option<u8>)> {
    let bytes = text.as_bytes();
    let mut i = from;
    while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
        i += 1;
    }
    // JSON-escaped quotes: `\"value\"`.
    let escaped = bytes.get(i) == Some(&b'\\') && matches!(bytes.get(i + 1), Some(b'"' | b'\''));
    if escaped {
        i += 1;
    }
    match bytes.get(i) {
        Some(&q @ (b'"' | b'\'' | b'`')) => {
            let start = i + 1;
            let mut j = start;
            while j < bytes.len() {
                let b = bytes[j];
                if b == b'\n' || b == b'\r' {
                    break;
                }
                if b == b'\\' && !escaped && q != b'\'' {
                    j += 2;
                    continue;
                }
                if escaped && b == b'\\' && bytes.get(j + 1) == Some(&q) {
                    break;
                }
                if b == q {
                    if bytes.get(j + 1) == Some(&q) && q != b'`' {
                        j += 2;
                        continue;
                    }
                    break;
                }
                j += 1;
            }
            let end = j.min(bytes.len());
            (start < end).then_some((start, end, Some(q)))
        }
        Some(_) => {
            let start = i;
            let mut j = start;
            while j < bytes.len() {
                let b = bytes[j];
                if b.is_ascii_whitespace()
                    || matches!(
                        b,
                        b'"' | b'\'' | b'`' | b',' | b';' | b'}' | b']' | b'<' | b'>' | b'\\'
                    )
                {
                    break;
                }
                j += 1;
            }
            let mut end = j;
            // An unbalanced closing parenthesis belongs to the surrounding code.
            while end > start
                && bytes[end - 1] == b')'
                && bytes[start..end].iter().filter(|b| **b == b'(').count()
                    < bytes[start..end].iter().filter(|b| **b == b')').count()
            {
                end -= 1;
            }
            (start < end).then_some((start, end, None))
        }
        None => None,
    }
}

/// Minimum length and false-positive controls for a value read after a sensitive name.
fn accept_value(value: &str, quote: Option<u8>, confidence: Confidence, code: bool) -> bool {
    let trimmed = value.trim();
    if trimmed.chars().count() < 6 {
        return false;
    }
    // A YAML block indicator (`password: |`) is handled by the block detector.
    if matches!(trimmed, "|" | ">" | "|-" | ">-" | "|+" | ">+") {
        return false;
    }
    if is_reference_or_placeholder(trimmed, quote, confidence == Confidence::High, code) {
        return false;
    }
    // In source code an unquoted value is an expression, not a literal.
    if code && quote.is_none() {
        return false;
    }
    if confidence == Confidence::Medium {
        // Weak names (`key`, `token`) holding identifiers name something; they are not secrets.
        if is_word_list(trimmed) || is_identifier_like(trimmed) || is_member_path(trimmed) {
            return false;
        }
        if trimmed.contains(' ') {
            return false;
        }
    }
    true
}

/// Placeholders, empty-ish values and references to a secret rather than the secret itself.
/// `quote` is the quote the value was read from (`'` makes `$…` literal); `strong` relaxes the
/// member-path rule outside code; `code` applies code-only rules.
fn is_reference_or_placeholder(value: &str, quote: Option<u8>, strong: bool, code: bool) -> bool {
    let v = value.trim_matches(|c| c == '"' || c == '\'' || c == '`');
    let lower = v.to_ascii_lowercase();
    const KEYWORDS: &[&str] = &[
        "null",
        "none",
        "nil",
        "true",
        "false",
        "undefined",
        "empty",
        "string",
        "optional",
        "required",
        "changeme",
        "change_me",
        "password",
        "passwd",
        "secret",
        "example",
        "placeholder",
        "redacted",
        "your_api_key",
        "your-api-key",
        "your_token",
        "<redacted>",
        "********",
        "str",
        "bool",
        "number",
        "int",
        "bytes",
        "hidden",
        "masked",
        "unset",
    ];
    if v.is_empty() || KEYWORDS.contains(&lower.as_str()) || lower.starts_with("[redacted") {
        return true;
    }
    let mut chars = v.chars();
    if let Some(first) = chars.next()
        && chars.all(|c| c == first)
    {
        return true;
    }
    // Templates and environment references. In single quotes `$…` is literal.
    if v.starts_with("${") || v.starts_with("$(") || v.starts_with("{{") || v.starts_with("#{") {
        return true;
    }
    if quote != Some(b'\'')
        && let Some(rest) = v.strip_prefix('$')
        && is_env_name(rest)
    {
        return true;
    }
    if v.len() > 2 && v.starts_with('%') && v.ends_with('%') && is_env_name(&v[1..v.len() - 1]) {
        return true;
    }
    if v.starts_with('<') && v.ends_with('>') {
        return true;
    }
    const REFERENCES: &[&str] = &[
        "process.env",
        "os.environ",
        "os.getenv",
        "env(",
        "env::",
        "std::env",
        "secrets.",
        "vars.",
        "import.meta",
        "system.getenv",
        "environment.getenvironmentvariable",
        "getenv(",
    ];
    if REFERENCES.iter().any(|r| lower.starts_with(r)) {
        return true;
    }
    // Calls (`get_password()`, `vault.read("x");`) and paths (`Settings::KEY`).
    if is_call(v) || (v.contains("::") && is_identifier_like(&v.replace("::", "_"))) {
        return true;
    }
    if (code || !strong) && is_member_path(v) {
        return true;
    }
    if code && quote.is_none() && is_identifier_like(v) {
        return true;
    }
    false
}

fn is_env_name(text: &str) -> bool {
    !text.is_empty()
        && text.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !text.starts_with(|c: char| c.is_ascii_digit())
        && (text
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
            || text
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'))
}

/// `name(…)`, `a.b(…);` — an identifier path followed by a parenthesised argument list that
/// closes the value.
fn is_call(v: &str) -> bool {
    let Some(open) = v.find('(') else {
        return false;
    };
    let head = &v[..open];
    let tail = v.trim_end_matches([';', ',']);
    !head.is_empty()
        && head
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '$'))
        && head.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_' || c == '$')
        && tail.ends_with(')')
}

fn is_identifier_like(v: &str) -> bool {
    let mut chars = v.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !looks_random(v)
}

fn is_member_path(v: &str) -> bool {
    let parts: Vec<&str> = v.split('.').collect();
    parts.len() >= 2
        && parts.iter().all(|p| {
            let mut chars = p.chars();
            chars
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
                && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        })
        && parts.iter().all(|p| p.len() <= 40 && !looks_random(p))
}

fn looks_random(part: &str) -> bool {
    part.len() >= 12
        && part.chars().any(|c| c.is_ascii_digit())
        && part.chars().any(|c| c.is_ascii_uppercase())
        && part.chars().any(|c| c.is_ascii_lowercase())
}

/// Three or more word-like segments joined by `_` or `-` (`MAX_RETRY_ATTEMPTS_2`).
fn is_word_list(value: &str) -> bool {
    let segments: Vec<&str> = value.split(['_', '-']).filter(|s| !s.is_empty()).collect();
    segments.len() >= 3
        && segments.iter().all(|s| {
            let letters = s.trim_end_matches(|c: char| c.is_ascii_digit());
            s.bytes().all(|b| b.is_ascii_digit())
                || (s.len() >= 2
                    && !letters.is_empty()
                    && letters.chars().all(|c| c.is_ascii_alphabetic()))
        })
}

/// Only letters, digits-free words, `_`, `-` and spaces: the next word of a list, not a secret.
fn is_plain_words(v: &str) -> bool {
    v.chars()
        .all(|c| c.is_ascii_alphabetic() || matches!(c, '_' | '-' | ' ' | '.'))
}

/// `8080/path` after `host:` is a port and a path, not a password.
fn looks_like_port_and_path(v: &str) -> bool {
    let digits = v.bytes().take_while(u8::is_ascii_digit).count();
    digits > 0 && (digits == v.len() || v.as_bytes().get(digits) == Some(&b'/'))
}

fn quote_before(text: &str, start: usize) -> Option<u8> {
    match text.as_bytes().get(start.wrapping_sub(1)) {
        Some(&q @ (b'"' | b'\'' | b'`')) => Some(q),
        _ => None,
    }
}

/// Strips one layer of surrounding quotes from a captured value.
fn trim_quotes(text: &str, start: usize, end: usize) -> (usize, usize) {
    let bytes = text.as_bytes();
    if end >= start + 2 && matches!(bytes[start], b'"' | b'\'') && bytes[end - 1] == bytes[start] {
        return (start + 1, end - 1);
    }
    if end > start && matches!(bytes[start], b'"' | b'\'') {
        return (start + 1, end);
    }
    (start, end)
}

fn trim_spaces(text: &str, mut start: usize, mut end: usize) -> (usize, usize) {
    let bytes = text.as_bytes();
    while start < end && bytes[start].is_ascii_whitespace() {
        start += 1;
    }
    while end > start && bytes[end - 1].is_ascii_whitespace() {
        end -= 1;
    }
    (start, end)
}

fn line_start(text: &str, at: usize) -> usize {
    text[..at].rfind('\n').map_or(0, |i| i + 1)
}

/// The indented block after a YAML block-scalar key at `key_column`: from the first content
/// character to the end of the last content line (blank lines inside are included).
fn yaml_block(text: &str, after_header: usize, key_column: usize) -> Option<(usize, usize)> {
    let bytes = text.as_bytes();
    let mut i = after_header;
    // Skip the header's line break.
    if bytes.get(i) == Some(&b'\r') {
        i += 1;
    }
    if bytes.get(i) == Some(&b'\n') {
        i += 1;
    } else if i < bytes.len() {
        return None;
    }
    let mut start = None;
    let mut end = None;
    while i < bytes.len() {
        let line_end = text[i..].find('\n').map_or(bytes.len(), |p| i + p);
        let line = &text[i..line_end];
        let content = line.trim_end_matches('\r');
        let indent = content.len() - content.trim_start_matches([' ', '\t']).len();
        if content.trim().is_empty() {
            i = line_end + 1;
            continue;
        }
        if indent <= key_column {
            break;
        }
        if start.is_none() {
            start = Some(i + indent);
        }
        end = Some(i + content.len());
        i = line_end + 1;
    }
    match (start, end) {
        (Some(s), Some(e)) if s < e => Some((s, e)),
        _ => None,
    }
}

/// Decodes the start of a base64 run and checks for a PEM private-key header.
fn decodes_to_private_key(run: &str) -> bool {
    let head: String = run.chars().take(96).collect();
    let decoded = decode_base64_prefix(&head);
    let text = String::from_utf8_lossy(&decoded);
    text.starts_with("-----BEGIN") && text.contains("PRIVATE KEY")
}

fn decode_base64_prefix(text: &str) -> Vec<u8> {
    let value = |c: u8| -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some(u32::from(c - b'A')),
            b'a'..=b'z' => Some(u32::from(c - b'a') + 26),
            b'0'..=b'9' => Some(u32::from(c - b'0') + 52),
            b'+' | b'-' => Some(62),
            b'/' | b'_' => Some(63),
            _ => None,
        }
    };
    let mut out = Vec::new();
    let mut acc = 0u32;
    let mut bits = 0u32;
    for c in text.bytes() {
        let Some(v) = value(c) else { break };
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xFF) as u8);
        }
    }
    out
}

// ---- whole tokens (M6) ------------------------------------------------------------------------

/// Extends single-line format matches over the rest of their token, so a fixed-length pattern
/// (`npm_` + 36, `AIza` + 35) never leaves a suffix or prefix of a longer credential behind.
/// Assignment-style findings extend forward only (their key name stays); multi-line blocks and
/// URL credentials are left as they are.
pub fn whole_tokens(text: &str, mut findings: Vec<Finding>) -> Vec<Finding> {
    let bytes = text.as_bytes();
    let token = |b: u8| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'+' | b'/' | b'=');
    for f in &mut findings {
        if f.end > bytes.len() || f.start >= f.end {
            continue;
        }
        if text[f.start..f.end].contains('\n') {
            continue;
        }
        match f.detector {
            "private_key"
            | "url_credentials"
            | "webhook_url"
            | "auth_header"
            | "basic_auth"
            | "connection_string_key" => {}
            "sensitive_assignment" | "bearer_token" | ENTROPY_DETECTOR => {
                while f.end < bytes.len() && token(bytes[f.end]) && bytes[f.end] != b'[' {
                    f.end += 1;
                }
            }
            _ => {
                while f.end < bytes.len() && token(bytes[f.end]) {
                    f.end += 1;
                }
                while f.start > 0 && bytes[f.start - 1].is_ascii_alphanumeric() {
                    f.start -= 1;
                }
            }
        }
    }
    findings
}

// ---- entropy heuristic (linear) ---------------------------------------------------------------

/// Minimum candidate length.
const ENTROPY_MIN_LEN: usize = 20;
/// Longer runs are data (embedded images, blobs), not credentials.
const ENTROPY_MAX_LEN: usize = 200;
/// Minimum Shannon entropy (bits per character) for a base64-like candidate.
const ENTROPY_THRESHOLD: f64 = 4.0;

/// The shared entropy heuristic with the same false-positive controls, in one linear pass:
/// `data:` URI ranges are sorted and walked with a cursor instead of being searched for every
/// candidate.
pub fn entropy_findings(text: &str, format_findings: &[Finding]) -> Vec<Finding> {
    let bytes = text.as_bytes();
    let data_uris = data_uri_ranges(text);
    let format_starts: HashSet<usize> = format_findings
        .iter()
        .map(|finding| finding.start)
        .collect();
    let mut uri = 0usize;
    let mut findings = Vec::new();
    let mut i = 0;
    let mut previous_end = 0usize;
    while i < bytes.len() {
        if !is_token_byte(bytes[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < bytes.len() && is_token_byte(bytes[i]) {
            i += 1;
        }
        let end = i;
        let after_previous = previous_end;
        previous_end = end;
        if end - start < ENTROPY_MIN_LEN {
            continue;
        }
        while uri < data_uris.len() && data_uris[uri].1 < end {
            uri += 1;
        }
        if uri < data_uris.len() && start >= data_uris[uri].0 && end <= data_uris[uri].1 {
            continue;
        }
        if !in_value_position(bytes, after_previous, start, end) {
            continue;
        }
        if is_integrity_prefixed(bytes, start) {
            continue;
        }
        // A placeholder cut this token short: the scan that wrote it judged the whole token, so
        // its remnant is not a new candidate (redaction stays idempotent).
        if text[end..].starts_with("[REDACTED") {
            continue;
        }
        if end - start <= ENTROPY_MAX_LEN && !is_non_secret_token(&text[start..end]) {
            findings.push(finding(ENTROPY_DETECTOR, start, end, Confidence::Medium));
        } else {
            let Some(prefix_end) =
                exposed_format_prefix(text, after_previous, start, end, &format_starts)
            else {
                continue;
            };
            // A format finding will replace the suffix with `[REDACTED:...]`, which terminates
            // this token. Detect the high-entropy prefix now so that the first and second
            // redaction passes agree without splitting all opaque tokens at internal `=`.
            findings.push(finding(
                ENTROPY_DETECTOR,
                start,
                prefix_end,
                Confidence::Medium,
            ));
        }
    }
    findings
}

fn is_token_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'_' | b'-' | b'=')
}

fn exposed_format_prefix(
    text: &str,
    floor: usize,
    start: usize,
    end: usize,
    format_starts: &HashSet<usize>,
) -> Option<usize> {
    let bytes = text.as_bytes();
    let before = bytes[floor..start]
        .iter()
        .rev()
        .find(|byte| **byte != b' ' && **byte != b'\t');
    if !matches!(before, Some(b'=') | Some(b':')) {
        return None;
    }
    let mut longest = None;
    for separator in start..end {
        let prefix_len = separator + 1 - start;
        if bytes[separator] != b'=' || !(ENTROPY_MIN_LEN..=ENTROPY_MAX_LEN).contains(&prefix_len) {
            continue;
        }
        if !format_starts.contains(&(separator + 1))
            || is_non_secret_token(&text[start..=separator])
        {
            continue;
        }
        longest = Some(separator + 1);
    }
    longest
}

/// Quoted literal or the value after `=` / `:`. Looks back only to the previous token, so the
/// whole pass stays linear.
fn in_value_position(bytes: &[u8], floor: usize, start: usize, end: usize) -> bool {
    let before = bytes[floor..start]
        .iter()
        .rev()
        .find(|b| **b != b' ' && **b != b'\t');
    let after = bytes.get(end).copied();
    match before {
        Some(b'"') | Some(b'\'') | Some(b'`') => {
            matches!(after, Some(b'"') | Some(b'\'') | Some(b'`'))
        }
        Some(b'=') | Some(b':') => true,
        _ => false,
    }
}

fn is_integrity_prefixed(bytes: &[u8], start: usize) -> bool {
    let head = &bytes[start..bytes.len().min(start + 7)];
    let lower: Vec<u8> = head.iter().map(u8::to_ascii_lowercase).collect();
    lower.starts_with(b"sha1-")
        || lower.starts_with(b"sha256-")
        || lower.starts_with(b"sha384-")
        || lower.starts_with(b"sha512-")
        || lower.starts_with(b"md5-")
}

fn is_non_secret_token(token: &str) -> bool {
    let core = token.trim_end_matches('=');
    if core.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
        return true;
    }
    if is_uuid_like(core) {
        return true;
    }
    if core.matches('/').count() >= 2
        && core
            .split('/')
            .all(|seg| seg.chars().all(|c| !c.is_ascii_uppercase()))
    {
        return true;
    }
    let has_lower = core.bytes().any(|b| b.is_ascii_lowercase());
    let has_upper = core.bytes().any(|b| b.is_ascii_uppercase());
    let has_digit = core.bytes().any(|b| b.is_ascii_digit());
    if !(has_lower && has_upper && has_digit) {
        return true;
    }
    let segments: Vec<&str> = core.split(['_', '-']).filter(|s| !s.is_empty()).collect();
    if segments.len() >= 3 && segments.iter().all(|s| s.len() >= 3 && is_wordish(s)) {
        return true;
    }
    if segments.iter().all(|s| is_camel_identifier(s)) {
        return true;
    }
    crate::secrets::shannon_entropy(core) < ENTROPY_THRESHOLD
}

fn is_camel_identifier(segment: &str) -> bool {
    let letters = segment.trim_end_matches(|c: char| c.is_ascii_digit());
    if letters.len() < 4 || !letters.chars().all(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    let mut words: Vec<String> = Vec::new();
    for c in letters.chars() {
        match words.last_mut() {
            Some(word) if !c.is_ascii_uppercase() => word.push(c),
            _ => words.push(c.to_string()),
        }
    }
    words.iter().all(|w| w.len() >= 2)
}

fn is_wordish(segment: &str) -> bool {
    let letters = segment.trim_end_matches(|c: char| c.is_ascii_digit());
    !letters.is_empty() && letters.chars().all(|c| c.is_ascii_alphabetic())
}

fn is_uuid_like(token: &str) -> bool {
    let parts: Vec<&str> = token.split('-').collect();
    parts.len() == 5
        && [8, 4, 4, 4, 12]
            .iter()
            .zip(&parts)
            .all(|(n, p)| p.len() == *n && p.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Sorted, disjoint byte ranges covered by `data:<mime>;base64,<payload>` URIs.
fn data_uri_ranges(text: &str) -> Vec<(usize, usize)> {
    static DATA_URI: LazyLock<Option<Regex>> =
        LazyLock::new(|| Regex::new(r"data:[a-zA-Z0-9.+/-]+;base64,[A-Za-z0-9+/=]+").ok());
    match DATA_URI.as_ref() {
        Some(re) if text.contains("base64,") => {
            re.find_iter(text).map(|m| (m.start(), m.end())).collect()
        }
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_extra_detector_compiles() {
        let (compiled, total) = compiled_extra_count();
        assert_eq!(
            compiled, total,
            "an extra detector pattern failed to compile"
        );
    }

    #[test]
    fn names_are_classified() {
        for name in [
            "DB_PASS",
            "SMTP_PW",
            "SECRET_KEY_BASE",
            "client-key-data",
            "apiKey",
            "db_password",
            "API_KEY_2",
            "AWS_SECRET_ACCESS_KEY",
        ] {
            assert_eq!(sensitive_name(name), Some(Confidence::High), "{name}");
        }
        for name in [
            "PASSWORD_MIN_LENGTH",
            "SECRET_NAME",
            "KEY_PATH",
            "TOKEN_URL",
            "author",
            "bypass",
            "monkey",
            "label",
        ] {
            assert_eq!(sensitive_name(name), None, "{name}");
        }
        assert_eq!(sensitive_name("token"), Some(Confidence::Medium));
    }

    #[test]
    fn values_are_read_whole() {
        let t = "A=\"correct horse battery\" B";
        let (s, e, q) = read_value(t, 2).expect("value");
        assert_eq!(&t[s..e], "correct horse battery");
        assert_eq!(q, Some(b'"'));
        let t = "A=Tr0ub4dor&3xyz; next";
        let (s, e, _) = read_value(t, 2).expect("value");
        assert_eq!(&t[s..e], "Tr0ub4dor&3xyz");
        let t = "f(password=abc123)";
        let (s, e, _) = read_value(t, 11).expect("value");
        assert_eq!(&t[s..e], "abc123");
    }

    #[test]
    fn base64_pem_is_recognised() {
        // base64("-----BEGIN RSA PRIVATE KEY-----")
        assert!(decodes_to_private_key(
            "LS0tLS1CRUdJTiBSU0EgUFJJVkFURSBLRVktLS0tLQ=="
        ));
        // base64("-----BEGIN CERTIFICATE-----")
        assert!(!decodes_to_private_key(
            "LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0t"
        ));
    }
}
