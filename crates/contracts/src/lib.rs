//! KalCode shared contracts (v1).
//!
//! Types that more than one campaign depends on live here and nowhere else: identifiers, the
//! event catalog, thread states, normalized agent events, the provider adapter traits, and
//! permission types. Campaign code consumes these; it does not redefine them. Every serializable
//! type is exported to TypeScript (`packages/protocol/src/generated`) with ts-rs.
//!
//! Ownership: the lead / integrator. Changes are additive within v1; breaking changes need a new
//! event `version` or a new contract version and a migration plan. See `docs/CONTRACTS.md`.
//!
//! CA-1 (advanced systems, `docs/CONTRACTS_ADVANCED.md`) added: `refs` (file handles, paging),
//! `git` and `timeline` (Z6a), `context` (CTX/FW), `resources` (RG), `trust` (Trust Kernel
//! phase 1) and `workspace_ui` (Z7 display statuses and pane layouts).

pub mod agent;
pub mod app;
pub mod context;
pub mod events;
pub mod git;
pub mod handoffs;
pub mod health;
pub mod identity;
pub mod ids;
pub mod kalvoice;
pub mod notifications;
pub mod operations;
pub mod permissions;
pub mod provider_accounts;
pub mod refs;
pub mod resources;
pub mod sessions;
pub mod threads;
pub mod timeline;
pub mod trust;
pub mod unified_memory;
pub mod utility;
pub mod workspace_ui;
