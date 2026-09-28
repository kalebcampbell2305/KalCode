//! Secret detection: high-signal patterns for common credential formats, sensitive
//! assignments, and an entropy heuristic with false-positive controls.
//!
//! Part of the shared redactor `kalcode_core::redact` (ADVANCED.md L-1, extracted from
//! `kalcode_context`). It covers every rule of the previous log redactor (the logging test
//! vectors still pass in `logging.rs` and are replayed in `kalcode_context`'s
//! `tests/redaction_roundtrip.rs`) and tolerates JSON-escaped quotes, so it works on formatted
//! log lines.
//!
//! Detector ids name the credential *format*, not a vendor. The redacted span is the secret
//! value only: key names, quotes, separators and line structure are kept (see
//! [`crate::redact`]).

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

/// How sure a detector is. High-signal formats are `High`; heuristics are `Medium`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    Medium,
    High,
}

/// One detected secret: a byte range of the scanned text (on UTF-8 boundaries).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub detector: &'static str,
    pub start: usize,
    pub end: usize,
    pub confidence: Confidence,
}

/// A detector: a regex and the capture group holding the secret (0 = the whole match).
struct Detector {
    id: &'static str,
    pattern: &'static str,
    group: usize,
    confidence: Confidence,
    /// Apply the placeholder / code-reference filter to the captured value.
    filter_values: bool,
}

const fn det(id: &'static str, pattern: &'static str, group: usize) -> Detector {
    Detector {
        id,
        pattern,
        group,
        confidence: Confidence::High,
        filter_values: false,
    }
}

/// The catalogue. Order does not matter: overlapping findings are merged.
///
/// Distinctive prefixes (`ghp_`, `glpat-`, `AKIA`, `xoxb-`, …) match even when glued to a
/// preceding word (`TOKEN_ghp_…`, `keyAKIA…`); short generic prefixes (`sk-`, `hf_`, `npm_`,
/// `eyJ`) keep a word boundary so words like `task-…` or `disk-…` do not match.
const DETECTORS: &[Detector] = &[
    // Private keys (PEM, OpenSSH, PGP, PuTTY), including truncated blocks with no END line.
    // The header and footer stay; the body is redacted.
    det(
        "private_key",
        r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----([\s\S]*?)(?:-----END[^-\r\n]*-----|\z)",
        1,
    ),
    det(
        "private_key",
        r"PuTTY-User-Key-File-\d+:[^\r\n]*[\r\n]+((?:[^\r\n]*[\r\n]+)*?Private-MAC:[^\r\n]*)",
        1,
    ),
    // Credentials embedded in URLs: scheme://user:pass@host and scheme://token@host.
    Detector {
        id: "url_credentials",
        pattern: r#"\b[a-zA-Z][a-zA-Z0-9+.-]*://[^/\s:@"'<>]+:([^/\s@"'<>]+)@"#,
        group: 1,
        confidence: Confidence::High,
        filter_values: true,
    },
    Detector {
        id: "url_credentials",
        pattern: r#"\b[a-zA-Z][a-zA-Z0-9+.-]*://([^/\s:@"'<>]{16,})@"#,
        group: 1,
        confidence: Confidence::High,
        filter_values: true,
    },
    // Authorization headers.
    Detector {
        id: "bearer_token",
        pattern: r"(?i)\bbearer\s+([A-Za-z0-9._~+/=-]{8,})",
        group: 1,
        confidence: Confidence::High,
        filter_values: true,
    },
    det(
        "basic_auth",
        r#"(?i)authorization\\?["']?\s*[:=]?\s*(?:\\?["'])*\s*basic\s+([A-Za-z0-9+/=]{8,})"#,
        1,
    ),
    // JSON Web Tokens.
    det(
        "jwt",
        r"\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}",
        0,
    ),
    // AI provider API keys (sk-…, sk-ant-…, sk-proj-…).
    det("ai_provider_key", r"\bsk-[A-Za-z0-9_-]{16,}", 0),
    // Payment platform keys and webhook signing secrets.
    det("payment_key", r"[spr]k_(?:live|test)_[A-Za-z0-9]{10,}", 0),
    det("payment_key", r"whsec_[A-Za-z0-9]{20,}", 0),
    // Git hosting tokens.
    det(
        "git_host_token",
        r"(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})",
        0,
    ),
    det("git_host_token", r"glpat-[A-Za-z0-9_-]{20,}", 0),
    // Model hub tokens.
    det("model_hub_token", r"\bhf_[A-Za-z0-9]{30,}", 0),
    // Package registry tokens.
    det("package_registry_token", r"\bnpm_[A-Za-z0-9]{36}", 0),
    det("package_registry_token", r"pypi-AgE[A-Za-z0-9_-]{50,}", 0),
    // Cloud access key ids and API keys.
    det("cloud_access_key_id", r"(?:AKIA|ASIA)[0-9A-Z]{16}\b", 0),
    det("cloud_api_key", r"AIza[0-9A-Za-z_-]{35}", 0),
    det("cloud_token", r"do[por]_v1_[a-f0-9]{64}\b", 0),
    // OAuth access and refresh tokens (`ya29.…`, `1//0…`) that appear without a key name.
    det(
        "oauth_access_token",
        r"ya29\.[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+)*",
        0,
    ),
    det("oauth_refresh_token", r"\b1//0[A-Za-z0-9_-]{20,}", 0),
    // KalCode account session tokens (`kcs_` + 43 base64url characters).
    det("session_token", r"kcs_[A-Za-z0-9_-]{43,}", 0),
    // Chat platform tokens.
    det("chat_token", r"xox[abprse]-[A-Za-z0-9-]{10,}", 0),
    det("chat_token", r"xapp-[A-Za-z0-9-]{10,}", 0),
    det("chat_token", r"\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b", 0),
    // Email delivery keys.
    det(
        "messaging_api_key",
        r"\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b",
        0,
    ),
    // Commerce platform tokens.
    det("commerce_token", r"shp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b", 0),
    // Connection strings with embedded keys.
    det(
        "connection_string_key",
        r#"(?i)\b(?:AccountKey|SharedAccessKey|SharedAccessSignature|sig)=([^;"'\s&]{8,})"#,
        1,
    ),
    // OAuth redirect / token parameters in a URL query or fragment (`?code=…`, `#state=…`).
    det(
        "oauth_url_param",
        r#"[?&#](?:code|state|id_token|access_token|refresh_token)=([^&#\s"'<>\\]{8,})"#,
        1,
    ),
    // key=value / "key": "value" where the key name ends in a sensitive word
    // (api_key, AWS_SECRET_ACCESS_KEY, private_key, refresh_token, db_password, _authToken, ...).
    Detector {
        id: "sensitive_assignment",
        pattern: r#"(?i)([\w.-]*(?:key|token|secret|password|passwd|pwd|passphrase|credential|credentials|signature|auth))\\?["'`]?\s*(?::=|=>|[:=])\s*(?:\\?["'`])*([^\s"'`\\,;}&<>]{6,})"#,
        group: 2,
        confidence: Confidence::High,
        filter_values: true,
    },
];

/// Key-name words that make an assignment a high-confidence secret. Other sensitive-looking
/// names (`key`, `token`, `signature`, `auth`) are `Medium`.
const STRONG_NAME_WORDS: &[&str] = &[
    "secret",
    "password",
    "passwd",
    "pwd",
    "passphrase",
    "credential",
    "private_key",
    "privatekey",
    "api_key",
    "apikey",
    "api-key",
    "access_key",
    "accesskey",
    "auth_token",
    "authtoken",
    "access_token",
    "refresh_token",
];

struct Compiled {
    detector: &'static Detector,
    regex: Regex,
}

static COMPILED: LazyLock<Vec<Compiled>> = LazyLock::new(|| {
    // An invalid pattern would silently weaken detection; `every_detector_compiles` guards it.
    DETECTORS
        .iter()
        .filter_map(|detector| {
            Regex::new(detector.pattern)
                .ok()
                .map(|regex| Compiled { detector, regex })
        })
        .collect()
});

// Locate quoted assignments independently of the first word's length. The existing
// token detector remains in place for unquoted values and credential-format overlaps.
static QUOTED_ASSIGNMENT: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)([\w.-]*(?:key|token|secret|password|passwd|pwd|passphrase|credential|credentials|signature|auth))\\*["'`]?\s*(?::=|=>|[:=])\s*"#,
    )
    .ok()
});

/// Number of detectors that compiled (tests compare it with the catalogue size).
pub fn compiled_detector_count() -> (usize, usize) {
    (COMPILED.len(), DETECTORS.len())
}

/// Every detector id, for documentation and the preview legend.
pub fn detector_ids() -> Vec<&'static str> {
    let mut ids: Vec<&'static str> = DETECTORS.iter().map(|d| d.id).collect();
    ids.push(ENTROPY_DETECTOR);
    ids.sort_unstable();
    ids.dedup();
    ids
}

/// Id of the entropy heuristic.
pub const ENTROPY_DETECTOR: &str = "high_entropy_string";

/// What is being scanned, for false-positive controls.
#[derive(Debug, Clone, Copy, Default)]
pub struct ScanContext<'a> {
    /// The file name, when the text is a file. Lockfiles and checksum manifests disable the
    /// entropy heuristic (they are full of integrity hashes); high-signal formats still apply.
    pub file_name: Option<&'a str>,
    /// Disable the entropy heuristic entirely (for example for log lines).
    pub no_entropy: bool,
}

/// Scans `text` with every detector and the entropy heuristic. Findings are sorted, merged
/// where they overlap, and lie on UTF-8 boundaries.
pub fn scan(text: &str) -> Vec<Finding> {
    scan_with(text, ScanContext::default())
}

pub fn scan_with(text: &str, context: ScanContext<'_>) -> Vec<Finding> {
    let mut findings = quoted_assignment_findings(text);
    for compiled in COMPILED.iter() {
        let detector = compiled.detector;
        for captures in compiled.regex.captures_iter(text) {
            let Some(value) = captures.get(detector.group) else {
                continue;
            };
            if value.as_str().is_empty() || is_already_redacted(value.as_str()) {
                continue;
            }
            if detector.filter_values && is_non_secret_value(value.as_str()) {
                continue;
            }
            // Prose such as "bearer authentication": a real token is never only lower-case
            // letters.
            if detector.id == "bearer_token"
                && value.as_str().bytes().all(|b| b.is_ascii_lowercase())
            {
                continue;
            }
            // In source code an unquoted identifier value (`apiKey: apiKey`, `token = token`)
            // is a variable reference, not a literal. Config formats (.env, .ini, YAML) keep
            // unquoted values as literals, so this applies to code files only.
            if detector.id == "sensitive_assignment"
                && context.file_name.is_some_and(is_code_file)
                && !is_quoted(text, value.start())
                && is_identifier(value.as_str())
            {
                continue;
            }
            let mut confidence = detector.confidence;
            if detector.id == "sensitive_assignment" {
                let name = captures
                    .get(1)
                    .map(|m| m.as_str().to_ascii_lowercase())
                    .unwrap_or_default();
                if !STRONG_NAME_WORDS.iter().any(|w| name.contains(w)) {
                    confidence = Confidence::Medium;
                    // Weak names (`key`, `token`, …) holding an identifier-like word list
                    // (`KEY = "MAX_RETRY_ATTEMPTS"`) name something; they are not secrets.
                    if is_word_list(value.as_str()) {
                        continue;
                    }
                }
            }
            findings.push(Finding {
                detector: detector.id,
                start: value.start(),
                end: value.end(),
                confidence,
            });
        }
    }
    let entropy_allowed = !context.no_entropy && !context.file_name.is_some_and(is_hash_manifest);
    if entropy_allowed {
        findings.extend(entropy_findings(text));
    }
    merge(findings)
}

fn quoted_assignment_findings(text: &str) -> Vec<Finding> {
    // Work on the logical contents of actual JSON strings, then map findings back to
    // their original encoded byte ranges. This preserves envelopes even when a logged
    // shell/code fragment contains an unterminated quote. Each recursive layer removes
    // JSON encoding; there is no fixed nesting cutoff or reserialization of the output.
    if !needs_quoted_scan(text) {
        return Vec::new();
    }
    let strings = json_string_contents(text);
    let mut findings = quoted_assignments_in(text, &strings);
    findings.extend(encoded_json_field_findings(text, &strings));
    for string in strings {
        for mut finding in quoted_assignment_findings(&string.decoded) {
            finding.start = string.offsets[finding.start];
            finding.end = string.offsets[finding.end];
            findings.push(finding);
        }
    }
    findings
}

fn needs_quoted_scan(text: &str) -> bool {
    // JSON can encode letters in sensitive field names, including inside nested strings.
    text.contains("\\u")
        || QUOTED_ASSIGNMENT
            .as_ref()
            .is_some_and(|regex| regex.is_match(text))
}

fn encoded_json_field_findings(text: &str, strings: &[JsonString]) -> Vec<Finding> {
    let Some(regex) = QUOTED_ASSIGNMENT.as_ref() else {
        return Vec::new();
    };
    let mut findings = Vec::new();
    for pair in strings.windows(2) {
        let (key, value) = (&pair[0], &pair[1]);
        if !text[key.start..key.end].contains("\\u")
            || text[key.end + 1..value.start - 1].trim() != ":"
        {
            continue;
        }
        let prefix = format!("{}=", key.decoded);
        if !regex
            .find(&prefix)
            .is_some_and(|found| found.start() == 0 && found.end() == prefix.len())
        {
            continue;
        }
        // Reuse the quoted-value confidence and placeholder rules on the logical field.
        // Only the original value span is replaced; key spelling and envelope stay intact.
        let quoted = serde_json::Value::String(value.decoded.clone()).to_string();
        let normalized = format!("{prefix}{quoted}");
        for finding in quoted_assignments_in(&normalized, &[]) {
            findings.push(Finding {
                start: value.start,
                end: value.end,
                ..finding
            });
        }
    }
    findings
}

struct JsonString {
    start: usize,
    end: usize,
    decoded: String,
    // A logical UTF-8 boundary maps to the start/end of its complete JSON escape.
    offsets: Vec<usize>,
}

fn json_string_contents(text: &str) -> Vec<JsonString> {
    if serde_json::from_str::<serde::de::IgnoredAny>(text).is_err() {
        return Vec::new();
    }
    let bytes = text.as_bytes();
    let mut strings = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] != b'"' {
            at += 1;
            continue;
        }
        let opening = at;
        at += 1;
        let start = at;
        while at < bytes.len() && bytes[at] != b'"' {
            at += if bytes[at] == b'\\' { 2 } else { 1 };
        }
        let end = at;
        at += 1;
        let Ok(decoded) = serde_json::from_str::<String>(&text[opening..at]) else {
            continue;
        };
        // Most log fields contain no assignment. Avoid offset tables and recursive
        // scans for those fields (including ordinary keys, timestamps and levels).
        if !needs_quoted_scan(&decoded) {
            // Keep its bounds to distinguish a JSON field value from an embedded
            // assignment, even when decoding eliminates the apparent assignment.
            strings.push(JsonString {
                start,
                end,
                decoded,
                offsets: Vec::new(),
            });
            continue;
        }
        let mut offsets = Vec::with_capacity(decoded.len() + 1);
        offsets.push(start);
        let mut raw = start;
        for ch in decoded.chars() {
            let char_start = raw;
            if bytes[raw] != b'\\' {
                raw += ch.len_utf8();
            } else if bytes[raw + 1] == b'u' {
                // A non-BMP scalar is encoded as two UTF-16 surrogate escapes.
                raw += if ch.len_utf16() == 2 { 12 } else { 6 };
            } else {
                raw += 2;
            }
            offsets.extend(std::iter::repeat_n(char_start, ch.len_utf8() - 1));
            offsets.push(raw);
        }
        strings.push(JsonString {
            start,
            end,
            decoded,
            offsets,
        });
    }
    strings
}

fn quoted_assignments_in(text: &str, strings: &[JsonString]) -> Vec<Finding> {
    let Some(regex) = QUOTED_ASSIGNMENT.as_ref() else {
        return Vec::new();
    };
    let mut findings = Vec::new();
    let mut covered_until = 0;
    for captures in regex.captures_iter(text) {
        let (Some(assignment), Some(name)) = (captures.get(0), captures.get(1)) else {
            continue;
        };
        if assignment.start() < covered_until {
            continue;
        }
        let after_string = strings.partition_point(|string| string.start <= assignment.end());
        if after_string > 0 && assignment.end() <= strings[after_string - 1].end {
            // This assignment belongs to the decoded string's grammar, not the JSON
            // grammar at this level. Its mapped finding is added by the caller.
            continue;
        }
        let Some((start, end, escape_depth)) = quoted_value(text, assignment.end()) else {
            continue;
        };
        // Do not repeatedly scan apparent assignments inside the same quoted value.
        covered_until = end;
        let value = &text[start..end];
        if value.chars().count() < 6
            || is_already_redacted(value)
            || is_non_secret_quoted_value(value, escape_depth)
        {
            continue;
        }
        let name = name.as_str().to_ascii_lowercase();
        let confidence = if STRONG_NAME_WORDS.iter().any(|word| name.contains(word)) {
            Confidence::High
        } else {
            if is_word_list(value) {
                continue;
            }
            Confidence::Medium
        };
        findings.push(Finding {
            detector: "sensitive_assignment",
            start,
            end,
            confidence,
        });
    }
    findings
}

fn is_non_secret_quoted_value(value: &str, escape_depth: u32) -> bool {
    let value = value.trim();
    if !has_quoted_whitespace(value, escape_depth) {
        return is_non_secret_value(value);
    }
    // Punctuation such as `(`, `::` or a leading `$` inside a multiword literal
    // does not make the entire credential a code reference. Preserve full templates only.
    [("${", "}"), ("{{", "}}")].iter().any(|(open, close)| {
        value
            .strip_prefix(open)
            .and_then(|rest| rest.strip_suffix(close))
            .is_some_and(|reference| !reference.contains(['{', '}']))
    })
}

fn has_quoted_whitespace(value: &str, escape_depth: u32) -> bool {
    let mut logical = std::borrow::Cow::Borrowed(value);
    for _ in 0..escape_depth {
        if logical.chars().any(char::is_whitespace) {
            return true;
        }
        if !logical.contains('\\') {
            return false;
        }
        let Ok(decoded) = serde_json::from_str::<String>(&format!("\"{logical}\"")) else {
            return false;
        };
        logical = std::borrow::Cow::Owned(decoded);
    }
    if logical.chars().any(char::is_whitespace) {
        return true;
    }
    // A tracing Debug string is itself a quoted, escaped value inside the JSON field.
    // Decode that explicit wrapper only; a literal `\\n` is not a newline.
    logical.starts_with('"')
        && (serde_json::from_str::<String>(&logical)
            .is_ok_and(|decoded| decoded.chars().any(char::is_whitespace))
            || has_debug_whitespace(&logical))
}

fn has_debug_whitespace(value: &str) -> bool {
    // Rust Debug can mix `\n` with `\0` or `\u{b}`, which are not JSON escapes.
    let Some(inner) = value.strip_prefix('"').and_then(|v| v.strip_suffix('"')) else {
        return false;
    };
    let mut chars = inner.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            continue;
        }
        match chars.next() {
            Some('n' | 'r' | 't') => return true,
            Some('u') if chars.next() == Some('{') => {}
            _ => continue,
        }
        let mut point = 0;
        let mut digits = 0;
        for ch in chars.by_ref() {
            if ch == '}' {
                if digits > 0 && char::from_u32(point).is_some_and(char::is_whitespace) {
                    return true;
                }
                break;
            }
            let Some(digit) = ch.to_digit(16) else {
                break;
            };
            digits += 1;
            if digits > 6 {
                break;
            }
            point = point * 16 + digit;
        }
    }
    false
}

/// Reads raw or JSON-escaped quotes without consuming the surrounding delimiters.
/// Each JSON encoding doubles existing backslashes and adds one before a quote.
fn quoted_value(text: &str, from: usize) -> Option<(usize, usize, u32)> {
    let bytes = text.as_bytes();
    let mut opening = from;
    while bytes.get(opening) == Some(&b'\\') {
        opening += 1;
    }
    let quote = *bytes.get(opening)?;
    if !matches!(quote, b'"' | b'\'' | b'`') {
        return None;
    }
    let delimiter_slashes = opening - from;
    let escape_period = delimiter_slashes.checked_add(1)?.checked_mul(2)?;
    let escape_depth = (delimiter_slashes + 1).ilog2() + 1;
    let start = opening + 1;
    let mut slashes = 0;
    let mut at = start;
    while let Some(&byte) = bytes.get(at) {
        if byte == b'\\' {
            slashes += 1;
            at += 1;
            continue;
        }
        if byte == quote {
            // JSON doubles backslashes but does not escape apostrophes or backticks.
            // Any slash run before these delimiters can therefore be an encoded escape.
            // Retain it as content conservatively: mixed shell/code grammars disagree
            // about literal backslashes, and over-redaction is safer than a leaked suffix.
            let possibly_encoded_escape = quote != b'"' && slashes > 0;
            if !possibly_encoded_escape && slashes % escape_period == delimiter_slashes {
                // YAML/SQL-style doubled quotes are literal content, including when
                // each quote is escaped by one or more surrounding JSON strings.
                let next_quote = at + delimiter_slashes + 1;
                if quote != b'`'
                    && bytes.get(next_quote) == Some(&quote)
                    && bytes[at + 1..next_quote].iter().all(|&b| b == b'\\')
                {
                    at = next_quote + 1;
                    slashes = 0;
                    continue;
                }
                return Some((start, at - delimiter_slashes, escape_depth));
            }
            // A less-escaped quote closes an outer string when the inner value is truncated.
            if slashes < delimiter_slashes {
                return Some((start, at - slashes, escape_depth));
            }
        }
        slashes = 0;
        at += 1;
    }
    Some((start, bytes.len(), escape_depth))
}

/// Sorts by start and merges overlapping or touching findings. The merged finding keeps the
/// detector of the highest-confidence part (earliest on ties).
pub fn merge(mut findings: Vec<Finding>) -> Vec<Finding> {
    findings.sort_by(|a, b| a.start.cmp(&b.start).then(b.end.cmp(&a.end)));
    let mut merged: Vec<Finding> = Vec::with_capacity(findings.len());
    for finding in findings {
        if let Some(last) = merged.last_mut()
            && finding.start <= last.end
        {
            if finding.end > last.end {
                last.end = finding.end;
            }
            if (finding.confidence, specificity(finding.detector))
                > (last.confidence, specificity(last.detector))
            {
                last.confidence = finding.confidence;
                last.detector = finding.detector;
            }
            continue;
        }
        merged.push(finding);
    }
    merged
}

/// Format detectors name the credential better than contextual ones when both match a span.
fn specificity(detector: &str) -> u8 {
    match detector {
        ENTROPY_DETECTOR => 0,
        "sensitive_assignment" => 1,
        "url_credentials"
        | "bearer_token"
        | "basic_auth"
        | "connection_string_key"
        | "oauth_url_param" => 2,
        _ => 3,
    }
}

/// Three or more word-like segments joined by `_` or `-` (`MAX_RETRY_ATTEMPTS_2`).
fn is_word_list(value: &str) -> bool {
    let segments: Vec<&str> = value.split(['_', '-']).filter(|s| !s.is_empty()).collect();
    segments.len() >= 3
        && segments
            .iter()
            .all(|s| s.bytes().all(|b| b.is_ascii_digit()) || (s.len() >= 2 && is_wordish(s)))
}

fn is_quoted(text: &str, start: usize) -> bool {
    matches!(
        text.as_bytes().get(start.wrapping_sub(1)),
        Some(b'"') | Some(b'\'') | Some(b'`')
    )
}

fn is_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Source files, where unquoted values are expressions rather than literals.
pub fn is_code_file(file_name: &str) -> bool {
    const EXTENSIONS: &[&str] = &[
        "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "java", "kt", "kts", "cs", "rb",
        "php", "swift", "c", "h", "cc", "cpp", "hpp", "m", "mm", "scala", "dart", "lua", "vue",
        "svelte", "astro", "ex", "exs", "clj", "fs", "zig",
    ];
    file_name
        .rsplit_once('.')
        .is_some_and(|(_, ext)| EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
}

fn is_already_redacted(value: &str) -> bool {
    value.trim_start().starts_with("[REDACTED")
}

/// False-positive control for assignment-like detectors: placeholders, empty-ish values, and
/// code that *refers to* a secret rather than containing one.
fn is_non_secret_value(value: &str) -> bool {
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
    ];
    if KEYWORDS.contains(&lower.as_str()) {
        return true;
    }
    // All the same character (xxxxxx, ******, 000000).
    let mut chars = v.chars();
    if let Some(first) = chars.next()
        && chars.all(|c| c == first)
    {
        return true;
    }
    // Template / environment references.
    if v.starts_with("${")
        || v.starts_with("{{")
        || v.starts_with('$')
        || v.starts_with('%')
        || v.starts_with('<')
        || v.starts_with("process.env")
        || v.starts_with("os.environ")
        || v.starts_with("os.getenv")
        || v.starts_with("env(")
        || v.starts_with("env::")
        || v.starts_with("std::env")
        || v.starts_with("secrets.")
        || v.starts_with("vars.")
        || v.starts_with("import.meta")
    {
        return true;
    }
    // Calls and member paths (`get_token()`, `self.token`, `config.api_key`, `Settings::KEY`).
    if v.contains('(') || v.contains("::") {
        return true;
    }
    if is_member_path(v) {
        return true;
    }
    false
}

/// `self.token`, `config.auth.key`, `this.password` — identifiers joined by dots.
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
        // A dotted value whose parts are all long random-looking runs is not a member path.
        && parts.iter().all(|p| p.len() <= 40)
        && !parts.iter().any(|p| looks_random(p))
}

fn looks_random(part: &str) -> bool {
    part.len() >= 16 && shannon_entropy(part) >= 3.5 && part.chars().any(|c| c.is_ascii_digit())
}

/// Lockfiles and checksum manifests: full of integrity hashes, so the entropy heuristic is off.
pub fn is_hash_manifest(file_name: &str) -> bool {
    let name = file_name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(file_name)
        .to_ascii_lowercase();
    const NAMES: &[&str] = &[
        "package-lock.json",
        "npm-shrinkwrap.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "bun.lock",
        "bun.lockb",
        "cargo.lock",
        "poetry.lock",
        "pipfile.lock",
        "uv.lock",
        "pdm.lock",
        "composer.lock",
        "gemfile.lock",
        "go.sum",
        "flake.lock",
        "packages.lock.json",
        "podfile.lock",
        "pubspec.lock",
        "mix.lock",
        "deno.lock",
        "gradle.lockfile",
        "sha256sums",
        "sha512sums",
        "checksums.txt",
    ];
    NAMES.contains(&name.as_str()) || name.ends_with(".sha256") || name.ends_with(".sha512")
}

// ---- entropy heuristic ----------------------------------------------------------------------

/// Minimum candidate length.
const ENTROPY_MIN_LEN: usize = 20;
/// Longer runs are data (embedded images, blobs), not credentials; specific formats such as
/// private keys and JWTs are handled by their own detectors.
const ENTROPY_MAX_LEN: usize = 200;
/// Minimum Shannon entropy (bits per character) for a base64-like candidate.
const ENTROPY_THRESHOLD: f64 = 4.0;

/// Candidates are runs of `[A-Za-z0-9+/=_-]` that appear as a quoted string literal or as the
/// value of an assignment (`=`, `:`). False-positive controls:
///
/// * pure hex (commit ids, digests, checksums) and UUIDs are skipped;
/// * runs inside a `data:…;base64,` URI (embedded images) are skipped;
/// * SRI integrity values (`sha256-…`, `sha512-…`) are skipped;
/// * a candidate needs lower case, upper case and digits, and at least 4.0 bits/char;
/// * identifier-like runs (`camelCase`, `snake_case` words) fail the class/entropy test.
fn entropy_findings(text: &str) -> Vec<Finding> {
    let bytes = text.as_bytes();
    let data_uri_ranges = data_uri_ranges(text);
    let mut findings = Vec::new();
    let mut i = 0;
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
        let len = end - start;
        if !(ENTROPY_MIN_LEN..=ENTROPY_MAX_LEN).contains(&len) {
            continue;
        }
        if data_uri_ranges
            .iter()
            .any(|(s, e)| start >= *s && end <= *e)
        {
            continue;
        }
        if !in_value_position(bytes, start, end) {
            continue;
        }
        let token = &text[start..end];
        if is_integrity_prefixed(bytes, start) || is_non_secret_token(token) {
            continue;
        }
        findings.push(Finding {
            detector: ENTROPY_DETECTOR,
            start,
            end,
            confidence: Confidence::Medium,
        });
    }
    findings
}

fn is_token_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=' | b'_' | b'-')
}

/// Quoted literal (`"…"`, `'…'`, `` `…` ``) or the value after `=` / `:` (optionally spaced).
fn in_value_position(bytes: &[u8], start: usize, end: usize) -> bool {
    let before = bytes[..start]
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
    // The run itself includes `sha512-…` because `-` is a token byte; check its head.
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
        return true; // hex digests, commit ids, UUIDs
    }
    if is_uuid_like(core) {
        return true;
    }
    // Paths: several `/` separated lower-case segments.
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
    // Identifier-like: long words separated by `_`/`-` (SOME_CONSTANT_NAME_2, some-css-class-3).
    let segments: Vec<&str> = core.split(['_', '-']).filter(|s| !s.is_empty()).collect();
    if segments.len() >= 3 && segments.iter().all(|s| s.len() >= 3 && is_wordish(s)) {
        return true;
    }
    if segments.iter().all(|s| is_camel_identifier(s)) {
        return true;
    }
    shannon_entropy(core) < ENTROPY_THRESHOLD
}

/// `getUserAccountSettingsById2`: words of two or more letters, each capitalised at most on
/// its first letter, with digits only at the end. Random tokens almost never have this shape.
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

/// A segment that reads like a word: letters with at most a trailing number.
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

/// Byte ranges covered by `data:<mime>;base64,<payload>` URIs.
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

/// Shannon entropy in bits per character.
pub fn shannon_entropy(text: &str) -> f64 {
    let mut counts = [0u32; 256];
    let mut total = 0u32;
    for b in text.bytes() {
        counts[b as usize] += 1;
        total += 1;
    }
    if total == 0 {
        return 0.0;
    }
    let total = f64::from(total);
    counts
        .iter()
        .filter(|c| **c > 0)
        .map(|c| {
            let p = f64::from(*c) / total;
            -p * p.log2()
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_detector_compiles() {
        let (compiled, total) = compiled_detector_count();
        assert_eq!(compiled, total, "a detector pattern failed to compile");
        assert!(
            QUOTED_ASSIGNMENT.is_some(),
            "quoted assignment prefix compiles"
        );
    }

    #[test]
    fn merge_combines_overlaps() {
        let merged = merge(vec![
            Finding {
                detector: "a",
                start: 5,
                end: 10,
                confidence: Confidence::Medium,
            },
            Finding {
                detector: "b",
                start: 8,
                end: 12,
                confidence: Confidence::High,
            },
            Finding {
                detector: "c",
                start: 20,
                end: 25,
                confidence: Confidence::Medium,
            },
        ]);
        assert_eq!(merged.len(), 2);
        assert_eq!((merged[0].start, merged[0].end), (5, 12));
        assert_eq!(merged[0].detector, "b");
    }

    fn log_redact(text: &str) -> String {
        crate::redact::redact_log_line(text).into_owned()
    }

    /// Bare credential shapes that reach logs through provider stderr tails, with no key name.
    #[test]
    fn redacts_bare_oauth_and_session_token_shapes() {
        let google_access = format!("ya29.{}", "a0FakeAccessTokenValue_0123456789-abcdefXYZ");
        let google_refresh = format!("1//0{}", "gFakeRefreshTokenValue_0123456789-abcXYZ");
        let session = format!("kcs_{}", "FakeSessionTokenValue_0123456789-abcdefghij");
        assert_eq!(session.len(), 4 + 43, "kcs_ + 43 base64url chars");
        for (line, secret, detector) in [
            (
                format!("gcloud: request failed with {google_access} (401)"),
                google_access.as_str(),
                "oauth_access_token",
            ),
            (
                format!("stderr tail: refreshing {google_refresh}\n"),
                google_refresh.as_str(),
                "oauth_refresh_token",
            ),
            (
                format!("account: cached {session} expired"),
                session.as_str(),
                "session_token",
            ),
        ] {
            let output = log_redact(&line);
            assert!(!output.contains(secret), "{line:?} -> {output:?}");
            assert!(output.contains("[REDACTED]"), "{line:?} -> {output:?}");
            assert_eq!(log_redact(&output), output, "idempotent");
            assert!(
                scan(&line).iter().any(|f| f.detector == detector),
                "{line:?} names {detector}"
            );
        }
    }

    /// OAuth redirect and token parameters in URLs and fragments, keyed only by the parameter.
    #[test]
    fn redacts_oauth_redirect_query_parameters() {
        let code = format!("4/0{}", "AfFakeAuthorizationCode_0123456789abcdef");
        let state = "FakeStateNonce0123456789abcdef";
        let cases = [
            (
                format!("callback http://127.0.0.1:54545/callback?code={code}&scope=email"),
                vec![code.as_str()],
            ),
            (
                format!("redirect https://example.test/cb?state={state}&code={code}"),
                vec![state, code.as_str()],
            ),
            (
                format!(r#"{{"url":"https://example.test/cb#state={state}&code={code}"}}"#),
                vec![state, code.as_str()],
            ),
            (
                "fragment https://example.test/cb#access_token=FakeAccess0123456789&token_type=bearer".to_string(),
                vec!["FakeAccess0123456789"],
            ),
            (
                "https://example.test/cb?id_token=FakeIdToken0123456789&refresh_token=FakeRefresh0123456789".to_string(),
                vec!["FakeIdToken0123456789", "FakeRefresh0123456789"],
            ),
        ];
        for (line, secrets) in &cases {
            let output = log_redact(line);
            for secret in secrets {
                assert!(!output.contains(secret), "{line:?} -> {output:?}");
            }
            assert!(output.contains("[REDACTED]"), "{line:?} -> {output:?}");
            assert_eq!(log_redact(&output), output, "idempotent");
        }
        // Non-secret parameters and the URL structure survive.
        let output = log_redact(&cases[0].0);
        assert!(output.contains("?code=[REDACTED]&scope=email"), "{output}");
    }

    /// Ordinary log text that merely resembles the new shapes is left alone.
    #[test]
    fn leaves_lookalike_log_text_unchanged() {
        for line in [
            "fetched https://api.example.test/v1/models?limit=20&page=2#section-3 in 120ms",
            "GET https://example.test/search?q=error+code&lang=en returned 200",
            "process exited with code=1 after state=running",
            "turn failed: exit code 1; see https://docs.example.test/errors#code",
            "provider version 1//0 build ya29 kcs_ ok",
            "url https://example.test/cb?code=short&state=abc",
            "path C:\\Users\\dev\\kcs_notes\\ya29.txt",
        ] {
            assert!(
                matches!(
                    crate::redact::redact_log_line(line),
                    std::borrow::Cow::Borrowed(_)
                ),
                "{line:?} -> {:?}",
                log_redact(line)
            );
        }
    }

    /// Credential shapes the redactor already covered, pinned here next to the new ones.
    #[test]
    fn existing_provider_shapes_stay_covered() {
        let jwt = format!(
            "eyJ{}.eyJ{}.{}",
            "hbGciOiJIUzI1NiJ9", "zdWIiOiIxMjM0In0", "FakeSignature0123"
        );
        for (line, secret) in [
            (
                format!(
                    "key {}{} used",
                    "sk-ant-api03-", "FakeAnthropicKey0123456789"
                ),
                "FakeAnthropicKey",
            ),
            (
                format!("key {}{} used", "sk-proj-", "FakeOpenAiKey0123456789ab"),
                "FakeOpenAiKey",
            ),
            (
                format!("key {}{} used", "sk-", "FakeLegacyOpenAiKey0123456789"),
                "FakeLegacyOpenAiKey",
            ),
            (format!("id {jwt} end"), "FakeSignature0123"),
            (
                "Authorization: Bearer FakeOpaqueBearer0123456789".to_string(),
                "FakeOpaqueBearer",
            ),
        ] {
            let output = log_redact(&line);
            assert!(!output.contains(secret), "{line:?} -> {output:?}");
        }
    }

    #[test]
    fn entropy_of_uniform_and_repeated() {
        assert!(shannon_entropy("aaaaaaaa") < 0.01);
        assert!(shannon_entropy("abcdefghijklmnop") > 3.9);
    }
}
