//! KalCode Remote protocol v1 (`docs/REMOTE_PROTOCOL.md`).
//!
//! KalCode Remote lets a phone or tablet mirror and drive the user's live desktop workstation.
//! This crate is the pure, host-agnostic half of the desktop side (and the reference initiator
//! used by tests and tooling). It knows nothing about Tauri, threads or providers: the desktop
//! supplies its state and actions through [`server::RemoteHost`].
//!
//! Layers, bottom up:
//! - [`noise`]: `Noise_IK_25519_ChaChaPoly_SHA256` with prologue `kalcode-remote/1` and the
//!   long-term X25519 [`noise::StaticKeypair`].
//! - [`transport`]: 2-byte big-endian Noise frames; application messages are a 4-byte
//!   big-endian length plus UTF-8 JSON (max 8 MiB), split across frames of at most 65519
//!   plaintext bytes.
//! - [`wire`]: every message, the state model, handshake and pairing payloads (§2–§4).
//! - [`ops`]: the operation allowlist (§5) with typed arguments and results.
//! - [`pairing`]: the single pairing window (single-use 32-byte code, 5-minute expiry).
//! - [`registry`]: the persisted device registry (`remote-devices.json`).
//! - [`dedupe`]: per-device memory of the last 512 request results.
//! - [`diff`]: snapshot-to-patch differ.
//! - [`server`]: [`server::accept`] (handshake + §3 accept/reject rules) and
//!   [`server::serve_connection`] (snapshot, debounced patches, requests, notify, keepalive).
//! - [`client`]: the initiator side, for tests, the dev host and tooling.

pub mod client;
pub mod dedupe;
pub mod diff;
mod error;
pub mod noise;
pub mod ops;
pub mod pairing;
pub mod registry;
pub mod server;
pub mod transport;
pub mod wire;

pub use error::Error;

use std::time::Duration;

/// Protocol version carried in the pairing payload and the handshake (`v`).
pub const PROTOCOL_VERSION: u32 = 1;

/// Default listening port; the desktop tries the next free port up to [`MAX_PORT`].
pub const DEFAULT_PORT: u16 = 47820;

/// Highest port the desktop falls back to.
pub const MAX_PORT: u16 = 47829;

/// The whole handshake (both Noise messages and the device's first `hello`) must finish in this.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// Either side treats this much silence as a dead connection.
pub const SILENCE_TIMEOUT: Duration = Duration::from_secs(35);

/// State changes are coalesced into one patch per this window.
pub const PATCH_DEBOUNCE: Duration = Duration::from_millis(150);

/// Generates a random identifier: `prefix` + 24 lowercase hex characters (96 bits).
pub fn random_id(prefix: &str) -> Result<String, Error> {
    let mut bytes = [0u8; 12];
    getrandom::fill(&mut bytes).map_err(|e| Error::Random(e.to_string()))?;
    let mut id = String::with_capacity(prefix.len() + 24);
    id.push_str(prefix);
    for byte in bytes {
        id.push(char::from(HEX[usize::from(byte >> 4)]));
        id.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    Ok(id)
}

const HEX: &[u8; 16] = b"0123456789abcdef";

/// Current time as Unix seconds.
pub(crate) fn unix_now() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}
