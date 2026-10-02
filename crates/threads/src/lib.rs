//! KalCode thread runtime (campaign Z3).
//!
//! A thread is a persistent unit of AI work: one provider session (Claude Code, Codex, …)
//! running in one workspace under one permission mode. This crate owns thread persistence
//! (schema v3, migration 0003), drives sessions through the shared `AgentProvider` contract, derives
//! status from structured events only, routes provider actions through the `PermissionGate`,
//! and recovers threads after a crash. See docs/AGENT_RUNTIME.md.
//!
//! Integration seams (implemented elsewhere, injected here):
//! - [`ProviderRegistry`] — provider adapters (Z2).
//! - [`WorkspaceResolver`] — workspaces (Z1; [`CoreWorkspaces`]).
//! - `PermissionGate` — the permission engine (Z4); `AskUnlessReadGate` until then.

pub mod naming;
pub mod registry;
pub mod runtime;
pub mod store;
pub mod types;
pub mod validate;

pub use registry::{
    CoreWorkspaces, NoWorkspaces, ProviderEntry, ProviderRegistry, ResolvedWorkspace,
    WorkspaceResolver,
};
pub use runtime::{AgentLimitSource, StreamId, ThreadRuntime, ThreadWorktrees};
pub use types::{
    BulkOutcome, CreateIdleThread, CreateThread, ProviderOption, StatusCount, ThreadOptions,
    ThreadsStatusSummary, ToolCallRecord, ToolCallStatus, WorkspaceOption,
};
