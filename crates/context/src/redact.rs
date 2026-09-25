//! Structure-preserving redaction. Moved to the shared redactor `kalcode_core::redact` in L-1;
//! re-exported here so the crate's paths keep working.

pub use kalcode_core::redact::{
    PlaceholderStyle, Redacted, RedactedSpan, apply, redact_log_line, redact_text,
};
