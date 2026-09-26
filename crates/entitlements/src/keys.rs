//! Entitlement signing keys trusted by this build.
//!
//! The desktop app trusts only the public keys compiled in here — never keys fetched at runtime —
//! so a compromised network path or API response cannot introduce a new signer.
//!
//! The first production public key was provisioned on 2026-09-25 (docs/BILLING.md §6).
//! `tooling/admin/gen-signing-key.mjs` piped its private key directly into the API Worker secret;
//! only the public key is stored here. Provisioning is not live entitlement verification:
//! desktop account admission still requires an authenticated, account-bound signed document.
//!
//! Rotation: add the new key here and ship that desktop release *before* the API switches to it;
//! remove a retired key only after every document it signed has expired (at most
//! `MAX_DOCUMENT_LIFETIME_SECONDS`) and the minimum supported desktop version includes the new key.

use crate::verify::TrustedKey;

pub const PRODUCTION_KEYS: &[TrustedKey] = &[TrustedKey {
    kid: "k2026-09-25",
    x: "LFsgRL6gAUIHn9aaM4jaAIKrTix-LRzYb-KVwPFs30M",
}];
