//! KalVoice: the coding assistant and voice layer inside KalCode (docs/KALVOICE.md).
//!
//! - [`grammar`]: deterministic command grammar (text → `KalVoiceIntent`), no model.
//!
//! Zero company AI cost: nothing here calls a hosted AI or speech service. Speech runs on the
//! device; reasoning runs on the user's own connected provider.

pub mod grammar;
