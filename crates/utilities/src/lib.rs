//! KalCode's Developer Utility Dock (UD) — the native half of the dock's tools.
//!
//! * [`http`] — the API Inspector's HTTP client: requests are sent from native code (never the
//!   WebView) with a pinned DNS resolution, timeouts and size caps, no implicit cookies,
//!   credentials or proxy, and every hop gated by a [`http::NetworkGate`] (the permission engine
//!   plus native confirmations, supplied by the desktop shell). History is redacted.
//! * [`processes`] — the Process Monitor: KalCode's process tree (roles from the Resource
//!   Governor's `build_tree`), processes of open workspaces and port owners, with an ownership
//!   classification that decides whether a process may be stopped and how it is confirmed.
//! * [`ports`] — the Port Inspector: listening sockets from the OS's own tool, run by absolute
//!   path with an argument vector (never a shell), parsed without trusting its locale.
//! * [`env`] — the Environment Viewer: names and shapes only; values are revealed one at a
//!   time after a native confirmation and are never logged.
//! * [`sqlite`] — the SQLite Viewer: read-only opens with `query_only`, an authorizer and a
//!   time limit; writes only through a separate, permission-gated call.
//! * [`regex_lab`] — linear-time regular expressions (no catastrophic backtracking).
//! * [`files`] — workspace text reads by file handle for the Diff Tool (ADVANCED.md §3 D4).
//! * [`store`] — scratchpads and saved requests (migration v14, [`UTILITY_MIGRATION`]).
//!
//! JSON formatting, text diffs, and encoding/hashing run locally in bounded WebView operations;
//! they never need native access.
//!
//! Schema: the registered canonical v14 migration is re-exported as [`UTILITY_MIGRATION`].

pub mod env;
pub mod files;
pub mod http;
pub mod operation_evidence;
pub mod ports;
pub mod processes;
pub mod regex_lab;
pub mod services;
pub mod sqlite;
pub mod store;
pub mod types;

use kalcode_core::{ErrorCategory, KalError};

pub use kalcode_core::db::{UTILITY_AUTHORITY_MIGRATION, UTILITY_MIGRATION};
pub use types::*;

pub(crate) fn invalid(code: &'static str, message: impl Into<String>) -> KalError {
    KalError::validation(code, message)
}

pub(crate) fn refused(code: &'static str, message: impl Into<String>) -> KalError {
    KalError::new(ErrorCategory::Permission, code, message)
}

pub(crate) fn invalid_id() -> KalError {
    invalid("invalid_id", "That id isn't valid.")
}

/// Milliseconds since `start`, saturating.
pub(crate) fn elapsed_ms(start: std::time::Instant) -> u32 {
    u32::try_from(start.elapsed().as_millis()).unwrap_or(u32::MAX)
}
