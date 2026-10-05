//! KalCode hook bridge (campaign Z7-W4).
//!
//! A provider CLI running interactively in a pane (Claude Code first) is started with
//! KalCode-owned hooks that run the small `kalcode-hook` helper. The helper reads the hook's JSON
//! from stdin, keeps only the fields KalCode needs ([`record`]), and asks KalCode over a
//! per-user local endpoint ([`endpoint`]): a named pipe on Windows, a Unix socket elsewhere,
//! never TCP. Both sides prove they hold the session's key with a nonce challenge
//! ([`wire`]); the key never crosses the wire. KalCode's [`server`] hands each authenticated
//! record to the session's [`server::HookHandler`] and returns its [`reply::HookReply`].
//!
//! Failure policy (docs/campaigns/Z7-W4-THREATS.md §3, AGENTS.md "Permanent provider tool
//! capability rule"):
//! - Ordinary provider sessions **observe**: the provider's own permission system decides, so
//!   every event, `PreToolUse` included, fails **open** (exit 0, no output) on a KalCode-side
//!   error. KalCode being slow, busy, restarted or unreachable never costs a tool call.
//! - Only an enforcing `PreToolUse` (engine routing, [`helper::ENFORCE_ARG`]) fails **closed**:
//!   every error, timeout, bad reply or panic exits 2, the only exit code that blocks a tool.

pub mod client;
pub mod codex;
pub mod endpoint;
pub mod helper;
pub mod key;
pub mod record;
pub mod reply;
#[cfg(feature = "server")]
pub mod server;
pub mod wire;

pub use endpoint::Endpoint;
pub use key::SessionKey;
pub use record::{HookEvent, HookRecord};
pub use reply::HookReply;

/// Environment variable carrying the session key (hex) from KalCode to the provider process,
/// which hooks inherit. Never logged, never written to disk.
pub const KEY_ENV: &str = "KALCODE_HOOK_KEY";

/// Test-only knob: lowers (never raises) the helper's deadlines, in milliseconds. A provider
/// that lowers it only makes the helper fail closed sooner.
pub const DEADLINE_ENV: &str = "KALCODE_HOOK_DEADLINE_MS";

/// Errors talking to the bridge. The helper maps every one of them to its failure policy.
#[derive(Debug, thiserror::Error)]
pub enum BridgeError {
    #[error("KalCode could not be reached: {0}")]
    Unreachable(String),
    #[error("KalCode did not answer in time")]
    TimedOut,
    #[error("the reply could not be verified")]
    BadReply,
    #[error("the request was malformed: {0}")]
    Malformed(String),
    #[error("i/o failed: {0}")]
    Io(#[from] std::io::Error),
}
