//! KalCode provider runtime (campaign Z2).
//!
//! - [`detect`]: read-only detection of provider CLIs (executable, version, sign-in state).
//! - [`catalog`]: the providers KalCode knows, their capabilities and permission mappings.
//! - [`process`]: supervision of provider child processes (argv only, sanitized environment,
//!   bounded output, redacted stderr, timeouts, tree kill on drop, failure isolation).
//! - [`claude`]: the Claude Code adapter, implementing the shared `AgentProvider` /
//!   `AgentSession` contracts (`kalcode_contracts::agent`) over its headless stream-JSON mode.
//! - [`interactive`]: provider panes (Z7-W4): the real CLI in a PTY, with status and approvals
//!   from the `kalcode-hook` bridge (docs/PROVIDER_PANES.md).
//! - [`codex`] / [`gemini`]: the Codex and Gemini CLI adapters over their headless JSON-lines
//!   modes, one supervised process per turn ([`turns`]).
//! - [`health`]: Provider Health + Capacity (PH), fed by detection and real sessions.
//! - [`registry`]: cached detection for the desktop shell.
//!
//! Provider-specific wire types stay private to their adapter; everything that leaves this
//! crate uses the shared contract types. See docs/PROVIDERS.md.

pub mod account_auth;
pub mod accounts;
pub mod catalog;
pub mod claude;
pub mod claude_account_auth;
pub mod codex;
pub mod detect;
pub mod env;
pub mod gemini;
pub mod gemini_account_auth;
pub mod guardian;
pub mod health;
pub mod interactive;
pub mod launch;
pub mod managed;
pub mod model;
#[cfg(unix)]
mod node_managers;
pub mod process;
pub mod registry;
pub(crate) mod turns;
pub mod version;
pub mod version_window;

pub use claude::ClaudeCodeProvider;
pub use codex::CodexProvider;
pub use detect::DetectEnv;
pub use gemini::GeminiProvider;
pub use health::HealthMonitor;
pub use model::{AdapterState, ModelSource, ProviderStatus};
pub use registry::ProviderRegistry;

// These test fixtures recursively launch this crate's large unit-test executable as a fake
// provider. Keep their complete child/RPC/PTY lifecycles from competing for that synthetic
// machine resource while the registered workspace runner executes tests in parallel.
#[cfg(test)]
pub(crate) static RECURSIVE_TEST_EXECUTABLE_SLOT: std::sync::Mutex<()> = std::sync::Mutex::new(());
