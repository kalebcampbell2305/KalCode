//! The one shared redactor (L-1): secret detection ([`secrets`]) and structure-preserving
//! redaction. Used for log lines ([`crate::logging`]), the Context Firewall (`kalcode_context`),
//! and later the Utility Dock, session-locator snippets and memory.
//!
//! Only the secret value is replaced; key names, quotes, separators, indentation and — because
//! each placeholder carries the newlines of the span it replaces — every line number stay the
//! same. Redaction is idempotent: a placeholder never matches a detector again.
//!
//! [`redact_log_line`] is the log format: plain `[REDACTED]` placeholders, high-signal detectors
//! only (no entropy heuristic), borrowed when nothing matched. Extracted from `kalcode_context`,
//! where it was built as a drop-in for the previous `logging::redact` rules and replays every
//! logging redaction test vector.

pub mod secrets;

use std::borrow::Cow;

use serde::Serialize;

use self::secrets::{Finding, ScanContext, scan_with};

/// Placeholder text style.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PlaceholderStyle {
    /// `[REDACTED:<detector>]` — tells the reader what kind of value was removed.
    #[default]
    Labelled,
    /// `[REDACTED]` — the log format.
    Plain,
}

/// One replaced span, in byte offsets of the **original** text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactedSpan {
    pub detector: &'static str,
    pub start: usize,
    pub end: usize,
}

/// Redacted text plus what was removed (offsets only, never content).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Redacted {
    pub text: String,
    pub spans: Vec<RedactedSpan>,
}

impl Redacted {
    pub fn is_redacted(&self) -> bool {
        !self.spans.is_empty()
    }
}

/// Scans and redacts `text`.
pub fn redact_text(text: &str, context: ScanContext<'_>, style: PlaceholderStyle) -> Redacted {
    let findings = scan_with(text, context);
    apply(text, &findings, style)
}

/// Replaces `findings` (sorted, non-overlapping, on char boundaries — as returned by
/// [`secrets::scan`]) with placeholders.
pub fn apply(text: &str, findings: &[Finding], style: PlaceholderStyle) -> Redacted {
    let mut out = String::with_capacity(text.len());
    let mut spans = Vec::with_capacity(findings.len());
    let mut cursor = 0;
    for finding in findings {
        // Defensive: skip anything out of order, out of range or off a char boundary rather
        // than panic; such a finding would be a detector bug and is covered by property tests.
        if finding.start < cursor
            || finding.end > text.len()
            || finding.start >= finding.end
            || !text.is_char_boundary(finding.start)
            || !text.is_char_boundary(finding.end)
        {
            continue;
        }
        out.push_str(&text[cursor..finding.start]);
        push_placeholder(
            &mut out,
            &text[finding.start..finding.end],
            finding.detector,
            style,
        );
        spans.push(RedactedSpan {
            detector: finding.detector,
            start: finding.start,
            end: finding.end,
        });
        cursor = finding.end;
    }
    out.push_str(&text[cursor..]);
    Redacted { text: out, spans }
}

/// The placeholder keeps the span's leading line break and all its line breaks, so text after
/// a multi-line secret (a private key body) stays on the same line numbers.
fn push_placeholder(out: &mut String, span: &str, detector: &str, style: PlaceholderStyle) {
    let newlines: Vec<&str> = line_breaks(span);
    let leading = span.starts_with(['\n', '\r']);
    let mut breaks = newlines.into_iter();
    if leading && let Some(first) = breaks.next() {
        out.push_str(first);
    }
    match style {
        PlaceholderStyle::Labelled => {
            out.push_str("[REDACTED:");
            out.push_str(detector);
            out.push(']');
        }
        PlaceholderStyle::Plain => out.push_str("[REDACTED]"),
    }
    for br in breaks {
        out.push_str(br);
    }
}

fn line_breaks(span: &str) -> Vec<&str> {
    let bytes = span.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' if bytes.get(i + 1) == Some(&b'\n') => {
                out.push("\r\n");
                i += 2;
            }
            b'\r' => {
                out.push("\r");
                i += 1;
            }
            b'\n' => {
                out.push("\n");
                i += 1;
            }
            _ => i += 1,
        }
    }
    out
}

/// Log-line redaction: plain placeholders, high-signal detectors only, borrowed when clean.
/// What [`crate::logging::redact`] applies to every formatted log line.
pub fn redact_log_line(input: &str) -> Cow<'_, str> {
    let findings = scan_with(
        input,
        ScanContext {
            file_name: None,
            no_entropy: true,
        },
    );
    if findings.is_empty() {
        return Cow::Borrowed(input);
    }
    Cow::Owned(apply(input, &findings, PlaceholderStyle::Plain).text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_key_names_quotes_and_lines() {
        let secret = format!("{}{}", "ghp_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8");
        let text = format!("line1\nTOKEN=\"{secret}\"\nline3\n");
        let red = redact_text(&text, ScanContext::default(), PlaceholderStyle::Labelled);
        assert_eq!(red.text.lines().count(), text.lines().count());
        assert!(red.text.contains("TOKEN=\"[REDACTED:"));
        assert!(red.text.ends_with("\"\nline3\n"));
        assert!(!red.text.contains(&secret));
    }

    #[test]
    fn multi_line_key_body_keeps_line_count() {
        let body = "MIIEowIBAAKCAQEA0\nabcdefghijklmnop\nqrstuvwxyz012345\n";
        let text = format!(
            "before\n-----BEGIN RSA PRIVATE KEY-----\n{body}-----END RSA PRIVATE KEY-----\nafter\n"
        );
        let red = redact_text(&text, ScanContext::default(), PlaceholderStyle::Labelled);
        assert_eq!(
            red.text.lines().count(),
            text.lines().count(),
            "{}",
            red.text
        );
        assert!(red.text.contains("-----BEGIN RSA PRIVATE KEY-----"));
        assert!(red.text.contains("-----END RSA PRIVATE KEY-----"));
        assert!(!red.text.contains("MIIEow"));
    }

    #[test]
    fn log_line_is_borrowed_when_clean() {
        assert!(matches!(
            redact_log_line(r#"{"event":"app.started","seq":42}"#),
            Cow::Borrowed(_)
        ));
    }
}
