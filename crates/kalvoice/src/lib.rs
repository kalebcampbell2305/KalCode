//! KalVoice: the coding assistant and voice layer inside KalCode (docs/KALVOICE.md).
//!
//! - [`grammar`]: deterministic command grammar (text to `KalVoiceIntent`), no model.
//! - [`ledger`]: provisional local count of KalVoice Requests (dictation is never counted).
//! - [`plan`]: allowances per entitlement tier (mirrors `packages/protocol/src/plans.ts`).
//! - [`prefs`]: shortcuts, reasoning provider, speech model, spoken replies.
//! - [`shortcuts`]: shortcut parsing and conflict detection.
//! - [`models`]: on-device speech model catalog and consented, verified downloads.
//! - [`audio`]: microphone capture into memory, resampled to 16 kHz.
//! - [`stt`]: on-device speech recognition (whisper.cpp behind the `whisper` feature).
//! - [`voice`]: listening sessions (microphone, transcription, audio dropped afterwards).
//! - [`orchestrator`]: request pipeline (allowance, grammar, provider, permission, execute).
//! - [`speech_output`]: optional spoken replies through the OS voice.
//! - [`signals`]: status snapshot and live signals for the KalVoice UI.
//!
//! Zero company AI cost: nothing here calls a hosted AI or speech service. Speech runs on the
//! device; reasoning runs on the user's own connected provider.

pub mod audio;
pub mod grammar;
pub mod latency;
pub mod ledger;
pub mod models;
pub mod orchestrator;
pub mod plan;
pub mod prefs;
pub mod shortcuts;
pub mod signals;
pub mod speech_output;
pub mod streaming;
pub mod stt;
pub mod voice;
