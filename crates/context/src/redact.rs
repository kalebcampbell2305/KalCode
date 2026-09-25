//! Structure-preserving redaction. Placeholder rendering and [`redact_log_line`] come from the
//! shared redactor `kalcode_core::redact`; [`redact_text`] here scans with the Context
//! Firewall's detector set ([`crate::secrets::scan_with`]), which extends the shared catalogue.

pub use kalcode_core::redact::{PlaceholderStyle, Redacted, RedactedSpan, apply, redact_log_line};

use crate::secrets::{ScanContext, scan_with};

/// Scans `text` with the firewall's detectors and replaces every finding with a placeholder.
pub fn redact_text(text: &str, context: ScanContext<'_>, style: PlaceholderStyle) -> Redacted {
    let findings = scan_with(text, context);
    apply(text, &findings, style)
}
