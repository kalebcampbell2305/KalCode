//! Secret detection for the Context Firewall.
//!
//! The base catalogue is the shared redactor `kalcode_core::redact::secrets` (L-1: one
//! redactor for logs, the Context Firewall and later tools). The firewall adds a stricter
//! layer on top (SEC-LATENT, `docs/campaigns/SEC-LATENT.md`), kept in this crate so the shared
//! log redactor is unchanged until it adopts it:
//!
//! * **more formats** ([`crate::detectors`]): AWS console key pairs, chat webhooks, RFC 4716
//!   (SSH2) and age private keys, base64-encoded PEM private keys (kubeconfig
//!   `client-key-data`, Kubernetes secrets), short password names (`DB_PASS`, `SMTP_PW`),
//!   secret names with a carrier suffix (`SECRET_KEY_BASE`, `client-key-data`), XML elements
//!   and `key`/`value` attribute pairs, `name`/`value` pairs (Kubernetes env, JSON), quoted
//!   call arguments (`define('DB_PASSWORD', '…')`), `curl -u`, `mysql -p…`,
//!   `--password <value>`, Dockerfile `ENV NAME value`, `Authorization: Token …` and other
//!   schemes, YAML block scalars (`password: |`), URL credentials with an empty user or `/` in
//!   the password;
//! * **whole values** (M6): quoted values are redacted to the closing quote (spaces included),
//!   unquoted values to the end of the token (`&`, `(`, `$` included), fixed-length format
//!   matches are extended over the rest of the token, and multi-line values are redacted as a
//!   block;
//! * **a linear entropy pass** (the shared pass checked every candidate against every
//!   `data:` URI range, which was quadratic).
//!
//! Detector ids name the credential *format*, not a vendor.

use std::sync::LazyLock;

use regex::Regex;

pub use kalcode_core::redact::secrets::{
    Confidence, ENTROPY_DETECTOR, Finding, ScanContext, is_code_file, is_hash_manifest, merge,
    shannon_entropy,
};

use kalcode_core::redact::secrets as core;

/// Scans `text` with every detector and the entropy heuristic. Findings are sorted, merged
/// where they overlap, and lie on UTF-8 boundaries.
pub fn scan(text: &str) -> Vec<Finding> {
    scan_with(text, ScanContext::default())
}

/// [`scan`] with a context (file name for false-positive controls, entropy switch).
pub fn scan_with(text: &str, context: ScanContext<'_>) -> Vec<Finding> {
    // The shared catalogue without its entropy pass (replaced by the linear one below).
    let code = context.file_name.is_some_and(is_code_file);
    let mut findings = core::scan_with(
        text,
        ScanContext {
            file_name: context.file_name,
            no_entropy: true,
        },
    );
    // In source code an unquoted assignment value is an expression (`request.form[…]`,
    // `cfg->key`); quoted literals are still found by the assignment detector of this layer.
    findings.retain(|f| {
        !(code
            && f.detector == "sensitive_assignment"
            && !matches!(
                text.as_bytes().get(f.start.wrapping_sub(1)),
                Some(b'"' | b'\'' | b'`')
            )
            && text
                .get(f.start..f.end)
                .is_some_and(|v| v.contains(['[', '(', '.']) || v.contains("->")))
    });
    // Weak names (`key`, `token`) holding a capitalised word (`key="Timeout"`,
    // `key="ApiKey"`) name a setting.
    findings.retain(|f| {
        !(f.detector == "sensitive_assignment"
            && f.confidence == Confidence::Medium
            && text.get(f.start..f.end).is_some_and(is_pascal_words))
    });
    findings.extend(crate::detectors::findings(text, context));
    let entropy_allowed = !context.no_entropy && !context.file_name.is_some_and(is_hash_manifest);
    if entropy_allowed {
        findings.extend(crate::detectors::entropy_findings(text));
    }
    let findings = crate::detectors::whole_tokens(text, findings);
    let placeholders = placeholder_ranges(text);
    let findings: Vec<Finding> = findings
        .into_iter()
        .filter(|f| {
            f.start < f.end
                && f.end <= text.len()
                && text.is_char_boundary(f.start)
                && text.is_char_boundary(f.end)
                && !inside_any(&placeholders, f.start, f.end)
        })
        .collect();
    merge(findings)
}

/// `(compiled, declared)` detector patterns across the shared catalogue and this layer; an
/// invalid pattern would silently weaken detection.
pub fn compiled_detector_count() -> (usize, usize) {
    let (core_compiled, core_total) = core::compiled_detector_count();
    let (extra_compiled, extra_total) = crate::detectors::compiled_extra_count();
    (core_compiled + extra_compiled, core_total + extra_total)
}

/// Every detector id, for documentation and the preview legend.
pub fn detector_ids() -> Vec<&'static str> {
    let mut ids = core::detector_ids();
    ids.extend(crate::detectors::EXTRA_DETECTOR_IDS);
    ids.sort_unstable();
    ids.dedup();
    ids
}

/// `Timeout`, `ApiKey`, `MaxRetryCount`: capitalised words of two or more letters each.
fn is_pascal_words(value: &str) -> bool {
    let mut words = 0;
    let mut current = 0;
    for (i, c) in value.chars().enumerate() {
        if !c.is_ascii_alphabetic() || (i == 0 && !c.is_ascii_uppercase()) {
            return false;
        }
        if c.is_ascii_uppercase() {
            if i > 0 && current < 2 {
                return false;
            }
            words += 1;
            current = 1;
        } else {
            current += 1;
        }
    }
    words > 0 && current >= 2
}

/// Byte ranges of existing placeholders (`[REDACTED]`, `[REDACTED:id]`): redaction is
/// idempotent, so nothing inside one is ever a finding.
fn placeholder_ranges(text: &str) -> Vec<(usize, usize)> {
    static PLACEHOLDER: LazyLock<Option<Regex>> =
        LazyLock::new(|| Regex::new(r"\[REDACTED(?::[a-z_]+)?\]").ok());
    match PLACEHOLDER.as_ref() {
        Some(re) if text.contains("[REDACTED") => {
            re.find_iter(text).map(|m| (m.start(), m.end())).collect()
        }
        _ => Vec::new(),
    }
}

/// Whether `start..end` lies entirely inside one of the sorted, disjoint `ranges`.
fn inside_any(ranges: &[(usize, usize)], start: usize, end: usize) -> bool {
    if ranges.is_empty() {
        return false;
    }
    let index = ranges.partition_point(|(s, _)| *s <= start);
    index > 0 && {
        let (s, e) = ranges[index - 1];
        start >= s && end <= e
    }
}
