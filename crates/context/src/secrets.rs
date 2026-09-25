//! Secret detection: high-signal patterns for common credential formats, sensitive
//! assignments, and an entropy heuristic with false-positive controls.
//!
//! This module is written to become the shared `kalcode_core::redact` (ADVANCED.md L-1): it has
//! no dependency on the rest of this crate, it covers every rule in `native-core`'s
//! `logging::redact` (the logging test vectors are replayed in `tests/redaction_roundtrip.rs`),
//! and it tolerates JSON-escaped quotes so it works on formatted log lines.
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
    // key=value / "key": "value" where the key name ends in a sensitive word
    // (api_key, AWS_SECRET_ACCESS_KEY, private_key, refresh_token, db_password, _authToken, ...).
    Detector {
        id: "sensitive_assignment",
        pattern: r#"(?i)([\w.-]*(?:key|token|secret|password|passwd|pwd|passphrase|credential|credentials|signature|auth))\\?["']?\s*(?::=|=>|[:=])\s*(?:\\?["'])*([^\s"'\\,;}&<>]{6,})"#,
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
    let mut findings = Vec::new();
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
        "url_credentials" | "bearer_token" | "basic_auth" | "connection_string_key" => 2,
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

    #[test]
    fn entropy_of_uniform_and_repeated() {
        assert!(shannon_entropy("aaaaaaaa") < 0.01);
        assert!(shannon_entropy("abcdefghijklmnop") > 3.9);
    }
}
