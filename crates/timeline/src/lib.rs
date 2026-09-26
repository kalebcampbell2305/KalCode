//! Durable operation authority for Time Machine restore and action replay.
//!
//! This crate records authority and lifecycle only. It never reads or writes workspace files,
//! moves Git references, invokes providers, or replays an action. The integration coordinator
//! must first create an immutable plan, atomically claim it, perform the bounded external work,
//! and then persist terminal evidence. A process restart classifies every running operation as a
//! retained failure that requires recovery; it never resumes work automatically.

mod store;
mod types;

pub use store::TimelineStore;
pub use types::*;

/// The canonical v15 migration registered by native-core. The crate-local SQL source is retained
/// for ownership and byte-parity review; native-core is the runtime migration authority.
pub use kalcode_core::db::TIME_MACHINE_MIGRATION;
pub const MIGRATION_V15_SQL: &str = TIME_MACHINE_MIGRATION.sql;
