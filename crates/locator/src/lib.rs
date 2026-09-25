//! KalCode's Universal Session Locator (LOC) and the workspace rail, returning-user home and
//! recent work (campaign Z7-W2).
//!
//! * [`index`] — the local SQLite FTS5 (trigram) index over threads, workspaces, terminals,
//!   providers and activity; filters in SQL, ranking in Rust; rebuilt on damage.
//! * [`query`] — the query language: filter words ("threads", "waiting", "yesterday", "codex")
//!   and alias-widened search terms ("auth" → authentication, login, sign in).
//! * [`rail`] — pinned, recent and folder groups with per-provider thread counts; persistence.
//! * [`home`] — the greeting (Settings display name only; never the OS account) and summaries.
//! * [`recent`] — recent work and "what was I working on", from the event log.
//! * [`service::Locator`] — the running service: background indexing from the event bus.
//!
//! Privacy (LOC-04/05): stored names pass the shared redactor; message text is indexed only for
//! workspaces that opted in; queries are never stored, logged or put into events.
//!
//! Schema: migration v11 ([`RAIL_LOCATOR_MIGRATION`]) is registered in
//! `kalcode_core::db::MIGRATIONS`. A database without it (a core opened with an older list)
//! falls back to [`store::Store`]'s session-only in-memory tables.

pub mod entries;
pub mod home;
pub mod index;
pub mod query;
pub mod rail;
pub mod recent;
pub mod service;
pub mod store;
pub mod types;

pub use entries::ProviderInfo;
pub use service::{Locator, LocatorSources};
pub use types::*;

/// Migration v11 (Z7-W2), registered in `kalcode_core::db::MIGRATIONS`.
pub use kalcode_core::db::RAIL_LOCATOR_MIGRATION;
