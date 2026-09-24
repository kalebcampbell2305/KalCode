//! KalVoice: the coding assistant and voice layer inside KalCode (docs/KALVOICE.md).
//!
//! - [`grammar`]: deterministic command grammar (text to `KalVoiceIntent`), no model.
//! - [`ledger`]: provisional local count of KalVoice Requests (dictation is never counted).
//! - [`plan`]: allowances per entitlement tier (mirrors `packages/protocol/src/plans.ts`).
//! - [`prefs`]: shortcuts, reasoning provider, speech model, spoken replies.
//! - [`shortcuts`]: shortcut parsing and conflict detection.
//! - [`models`]: on-device speech model catalog and consented, verified downloads.
//!
//! Zero company AI cost: nothing here calls a hosted AI or speech service. Speech runs on the
//! device; reasoning runs on the user's own connected provider.

pub mod grammar;
pub mod ledger;
pub mod models;
pub mod plan;
pub mod prefs;
pub mod shortcuts;
