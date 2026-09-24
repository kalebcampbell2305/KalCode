//! KalCode shared contracts (v1).
//!
//! Types that more than one campaign depends on live here and nowhere else: identifiers, the
//! event catalog, thread states, normalized agent events, the provider adapter traits, and
//! permission types. Campaign code consumes these; it does not redefine them. Every serializable
//! type is exported to TypeScript (`packages/protocol/src/generated`) with ts-rs.
//!
//! Ownership: the lead / integrator. Changes are additive within v1; breaking changes need a new
//! event `version` or a new contract version and a migration plan. See `docs/CONTRACTS.md`.

pub mod agent;
pub mod app;
pub mod events;
pub mod ids;
pub mod kalvoice;
pub mod permissions;
pub mod threads;
