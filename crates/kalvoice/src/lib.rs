//! KalVoice: the coding assistant and voice layer inside KalCode (docs/KALVOICE.md).
//!
//! - [`grammar`]: deterministic command grammar (text to `KalVoiceIntent`), no model.
//! - [`normalize`]: deterministic second chance for paraphrases and speech-recognition variants.
//! - [`ledger`]: provisional local count of KalVoice Requests (dictation is never counted).
//! - [`local_reasoning`]: validated structured actions from an optional on-device interpreter.
//! - [`plan`]: allowances per entitlement tier (mirrors `packages/protocol/src/plans.ts`).
//! - [`prefs`]: shortcuts, legacy intelligence selection, speech model, spoken replies.
//! - [`shortcuts`]: shortcut parsing and conflict detection.
//! - [`models`]: on-device speech model catalog and consented, verified downloads.
//! - [`audio`]: microphone capture into memory, resampled to 16 kHz.
//! - [`stt`]: on-device speech recognition (whisper.cpp behind the `whisper` feature).
//! - [`voice`]: listening sessions (microphone, transcription, audio dropped afterwards).
//! - [`orchestrator`]: request pipeline (allowance, grammar/local interpretation, check, execute).
//! - [`speech_output`]: optional spoken replies through the OS voice.
//! - [`signals`]: status snapshot and live signals for the KalVoice UI.
//!
//! Zero company AI cost: nothing here calls a hosted AI or speech service. Speech runs on the
//! device. Requests outside the deterministic grammar require an explicitly wired local runtime;
//! this crate never falls back to an external provider.

pub mod accounting;
pub mod audio;
pub mod component_acquisition;
pub mod component_catalog;
pub mod component_floor;
#[cfg(test)]
mod component_floor_tests;
pub mod component_manifest;
pub mod component_store;
pub mod grammar;
pub mod guarded_worker;
pub mod latency;
pub mod ledger;
pub mod llama_worker;
pub mod local_reasoning;
pub mod models;
pub mod normalize;
pub mod orchestrator;
pub mod plan;
pub mod prefs;
pub mod schema;
pub mod shortcuts;
pub mod signals;
pub mod speech_output;
pub mod streaming;
pub mod stt;
pub mod voice;

// Analysis branch only: understanding + fast-path latency baseline (test builds only).
#[cfg(test)]
#[path = "../benches/understanding/harness.rs"]
mod understanding_bench;
