//! KalCode provider runtime (campaign Z2).
//!
//! - [`detect`]: read-only detection of provider CLIs (executable, version, sign-in state).
//! - [`catalog`]: the providers KalCode knows, their capabilities and permission mappings.
//! - [`process`]: supervision of provider child processes (argv only, sanitized environment,
//!   bounded output, redacted stderr, timeouts, tree kill on drop, failure isolation).
//! - [`claude`]: the Claude Code adapter, implementing the shared `AgentProvider` /
//!   `AgentSession` contracts (`kalcode_contracts::agent`) over its headless stream-JSON mode.
//! - [`registry`]: cached detection for the desktop shell.
//!
//! Provider-specific wire types stay private to their adapter; everything that leaves this
//! crate uses the shared contract types. See docs/PROVIDERS.md.

pub mod catalog;
pub mod claude;
pub mod detect;
pub mod env;
pub mod launch;
pub mod model;
pub mod process;
pub mod registry;
pub mod version;

pub use claude::ClaudeCodeProvider;
pub use detect::DetectEnv;
pub use model::{AdapterState, ModelSource, ProviderStatus};
pub use registry::ProviderRegistry;
