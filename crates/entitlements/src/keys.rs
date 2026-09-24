//! Entitlement signing keys trusted by this build.
//!
//! The desktop app trusts only the public keys compiled in here — never keys fetched at runtime —
//! so a compromised network path or API response cannot introduce a new signer.
//!
//! **There is no production key yet.** It is generated when the API is first deployed (campaign
//! Z13, docs/BILLING.md §6): `tooling/admin/gen-signing-key.mjs` pipes the private key straight
//! into the Worker secret and prints the public key line to add below. Until then every document
//! is rejected with `unknown_key` and the app runs on Free — it never grants more than Free
//! without a document signed by the API.
//!
//! Rotation: add the new key here and ship that desktop release *before* the API switches to it;
//! remove a retired key only after every document it signed has expired (at most
//! `MAX_DOCUMENT_LIFETIME_SECONDS`) and the minimum supported desktop version includes the new key.

use crate::verify::TrustedKey;

pub const PRODUCTION_KEYS: &[TrustedKey] = &[];
