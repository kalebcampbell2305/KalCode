//! KalCode entitlements on the desktop.
//!
//! The KalCode API decides every account's entitlement server-side and hands the desktop a
//! document signed with Ed25519. This crate verifies such documents against public keys
//! embedded in the binary, applies bounded offline grace, and evaluates features and limits.
//!
//! Nothing on the device can raise an entitlement: without a valid, unexpired document signed
//! by a trusted key and issued to the signed-in account, the result is Free.
//!
//! The OWNER tier is `unrestricted`: it grants every feature and unlimited limits by
//! construction, including features that do not exist yet — there is no list to keep in sync.
//!
//! Semantics match `packages/protocol/src/entitlements.ts` and the API signer
//! (`apps/api/worker/lib/token.ts`); `testdata/vectors.json` (signed in TypeScript) pins both.
//! See docs/BILLING.md.

mod document;
mod effective;
pub mod keys;
mod verify;

pub use document::{
    CLOCK_SKEW_SECONDS, DOCUMENT_VERSION, Entitlement, Grants, Limit,
    MAX_DOCUMENT_LIFETIME_SECONDS, Tier, features, is_valid_key_id, limits,
};
pub use effective::{
    CachedEntitlement, EffectiveEntitlement, EntitlementStatus, effective_entitlement,
};
pub use verify::{
    KeyError, MAX_TOKEN_LENGTH, TOKEN_ALGORITHM, TOKEN_TYPE, TrustedKey, Verifier, VerifyError,
};
