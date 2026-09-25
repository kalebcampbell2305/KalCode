//! KalCode permission engine (campaign Z4). See `docs/PERMISSIONS.md`.
//!
//! Layers, from pure to stateful:
//!
//! * [`paths`], [`network`], [`command`] — classify what an action touches (workspace
//!   containment, hosts, shell commands) and fail closed on anything they cannot interpret.
//! * [`classify`] — turns a provider's [`ActionKind`](kalcode_contracts::permissions::ActionKind)
//!   into scopes, a grant fingerprint and rule subjects.
//! * [`policy`] — the deterministic decision: modes, profiles, rules, grants.
//! * [`grants`], [`profiles`] — standing approvals and built-in profiles.
//! * [`store`], [`service`] — persistence (schema v4, migration 0004), the audit trail, and the
//!   [`PermissionGate`](kalcode_contracts::permissions::PermissionGate) implementation.
//!
//! Every permission mode is available on every plan. Bypass can only be enabled by the user,
//! with confirmation; agents and KalVoice are refused.

pub mod classify;
pub mod command;
pub mod grants;
pub mod network;
pub mod paths;
pub mod policy;
pub mod profiles;
pub mod scopes;
pub mod service;
pub mod store;

pub use service::{
    Actor, Clock, CoreWorkspaceRoots, NoThreads, NoWorkspaces, OriginDecision, PermissionService,
    SystemClock, ThreadModeStore, WorkspaceRoots,
};
pub use store::{ApprovalContext, ApprovalView, PermissionSettings};
