//! Secret detection. Moved to the shared redactor `kalcode_core::redact::secrets` in L-1 (one
//! redactor for logs, the Context Firewall and later tools); re-exported here so the crate's
//! paths keep working.

pub use kalcode_core::redact::secrets::*;
