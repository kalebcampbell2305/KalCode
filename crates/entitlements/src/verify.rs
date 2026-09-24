//! Verification of signed entitlement documents (compact JWS, EdDSA/Ed25519).
//!
//! ```text
//! token = base64url(header) "." base64url(payload) "." base64url(signature)
//! header = {"alg":"EdDSA","kid":"…","typ":"kalcode-entitlement.v1"}
//! ```
//!
//! The signature covers the transmitted `header.payload` bytes. Checks run in the same order as
//! the TypeScript verifier (`apps/api/worker/lib/token.ts`) and produce the same error codes:
//! shape → header → key → signature → document → time.

use std::collections::BTreeMap;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signature, VerifyingKey};

use crate::document::{CLOCK_SKEW_SECONDS, Entitlement, is_valid_key_id};
use crate::usage::UsageReceipt;

pub const TOKEN_TYPE: &str = "kalcode-entitlement.v1";
/// Header `typ` of signed KalVoice usage receipts. Covered by the signature, so an entitlement
/// can never be accepted as a receipt or the reverse.
pub const USAGE_TOKEN_TYPE: &str = "kalcode-usage.v1";
pub const TOKEN_ALGORITHM: &str = "EdDSA";
/// Upper bound on an accepted token, checked before any decoding.
pub const MAX_TOKEN_LENGTH: usize = 8192;

/// Why a token was rejected. `code()` matches the TypeScript verifier's error strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum VerifyError {
    #[error("the entitlement token is malformed")]
    Malformed,
    #[error("the entitlement token uses an unsupported algorithm or type")]
    UnsupportedHeader,
    #[error("the entitlement token was signed by an unknown key")]
    UnknownKey,
    #[error("the entitlement token signature is invalid")]
    BadSignature,
    #[error("the entitlement document is invalid")]
    InvalidDocument,
    #[error("the entitlement document is not valid yet")]
    NotYetValid,
    #[error("the entitlement document has expired")]
    Expired,
}

impl VerifyError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Malformed => "malformed",
            Self::UnsupportedHeader => "unsupported_header",
            Self::UnknownKey => "unknown_key",
            Self::BadSignature => "bad_signature",
            Self::InvalidDocument => "invalid_document",
            Self::NotYetValid => "not_yet_valid",
            Self::Expired => "expired",
        }
    }
}

/// A trusted public key, as embedded in the binary: key id and base64url raw Ed25519 key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrustedKey {
    pub kid: &'static str,
    pub x: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum KeyError {
    #[error("invalid key id {0:?}")]
    InvalidKeyId(String),
    #[error("key {0:?} is not a valid Ed25519 public key")]
    InvalidKey(String),
    #[error("key id {0:?} is listed twice")]
    DuplicateKeyId(String),
}

/// Verifies entitlement tokens against a fixed set of trusted keys.
#[derive(Debug, Clone)]
pub struct Verifier {
    keys: BTreeMap<String, VerifyingKey>,
}

impl Verifier {
    /// Builds a verifier from base64url raw public keys. Weak (small-order) keys are refused.
    pub fn from_keys<'a>(
        keys: impl IntoIterator<Item = (&'a str, &'a str)>,
    ) -> Result<Self, KeyError> {
        let mut map = BTreeMap::new();
        for (kid, x) in keys {
            if !is_valid_key_id(kid) {
                return Err(KeyError::InvalidKeyId(kid.to_owned()));
            }
            let key = decode(x)
                .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
                .and_then(|bytes| VerifyingKey::from_bytes(&bytes).ok())
                .filter(|key| !key.is_weak())
                .ok_or_else(|| KeyError::InvalidKey(kid.to_owned()))?;
            if map.insert(kid.to_owned(), key).is_some() {
                return Err(KeyError::DuplicateKeyId(kid.to_owned()));
            }
        }
        Ok(Self { keys: map })
    }

    /// Builds a verifier from keys embedded at compile time.
    pub fn from_trusted(keys: &[TrustedKey]) -> Result<Self, KeyError> {
        Self::from_keys(keys.iter().map(|key| (key.kid, key.x)))
    }

    pub fn key_ids(&self) -> impl Iterator<Item = &str> {
        self.keys.keys().map(String::as_str)
    }

    /// Verifies an entitlement token at `now_unix` (epoch seconds) and returns its entitlement.
    pub fn verify(&self, token: &str, now_unix: i64) -> Result<Entitlement, VerifyError> {
        let (kid, payload) = self.verify_jws(token, TOKEN_TYPE)?;
        let entitlement = parse_payload::<Entitlement>(&payload)
            .filter(|entitlement| entitlement.validate() && entitlement.key_id == kid)
            .ok_or(VerifyError::InvalidDocument)?;
        check_time(entitlement.issued_at, entitlement.expires_at, now_unix)?;
        Ok(entitlement)
    }

    /// Verifies a KalVoice usage receipt token at `now_unix` (epoch seconds).
    pub fn verify_usage_receipt(
        &self,
        token: &str,
        now_unix: i64,
    ) -> Result<UsageReceipt, VerifyError> {
        let (kid, payload) = self.verify_jws(token, USAGE_TOKEN_TYPE)?;
        let receipt = parse_payload::<UsageReceipt>(&payload)
            .filter(|receipt| receipt.validate() && receipt.key_id == kid)
            .ok_or(VerifyError::InvalidDocument)?;
        check_time(receipt.issued_at, receipt.expires_at, now_unix)?;
        Ok(receipt)
    }

    /// Shape → header → key → signature. Returns the key id and the signed payload bytes.
    fn verify_jws(&self, token: &str, typ: &str) -> Result<(String, Vec<u8>), VerifyError> {
        if token.len() > MAX_TOKEN_LENGTH {
            return Err(VerifyError::Malformed);
        }
        let segments: Vec<&str> = token.split('.').collect();
        let [header_segment, payload_segment, signature_segment] = segments.as_slice() else {
            return Err(VerifyError::Malformed);
        };
        let signature = decode(signature_segment)
            .and_then(|bytes| <[u8; 64]>::try_from(bytes).ok())
            .map(|bytes| Signature::from_bytes(&bytes))
            .ok_or(VerifyError::Malformed)?;
        let header = json_segment(header_segment).ok_or(VerifyError::Malformed)?;
        let payload = decode(payload_segment).ok_or(VerifyError::Malformed)?;

        let kid = check_header(&header, typ).ok_or(VerifyError::UnsupportedHeader)?;
        let key = self.keys.get(kid).ok_or(VerifyError::UnknownKey)?;

        let signing_input = format!("{header_segment}.{payload_segment}");
        key.verify_strict(signing_input.as_bytes(), &signature)
            .map_err(|_| VerifyError::BadSignature)?;
        Ok((kid.to_owned(), payload))
    }
}

fn parse_payload<T: serde::de::DeserializeOwned>(payload: &[u8]) -> Option<T> {
    serde_json::from_str(std::str::from_utf8(payload).ok()?).ok()
}

/// Document → time: not yet valid (beyond the clock-skew tolerance), then expired.
fn check_time(issued_at: i64, expires_at: i64, now_unix: i64) -> Result<(), VerifyError> {
    if now_unix.saturating_add(CLOCK_SKEW_SECONDS) < issued_at {
        return Err(VerifyError::NotYetValid);
    }
    if now_unix >= expires_at {
        return Err(VerifyError::Expired);
    }
    Ok(())
}

/// Strict unpadded base64url: padding and non-zero trailing bits are rejected.
fn decode(segment: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(segment).ok()
}

fn json_segment(segment: &str) -> Option<serde_json::Value> {
    let bytes = decode(segment)?;
    serde_json::from_str(std::str::from_utf8(&bytes).ok()?).ok()
}

/// Returns the key id when the header is `{"alg":"EdDSA","typ":<typ>,"kid":…}`.
fn check_header<'a>(header: &'a serde_json::Value, expected_typ: &str) -> Option<&'a str> {
    let object = header.as_object()?;
    let alg = object.get("alg")?.as_str()?;
    let typ = object.get("typ")?.as_str()?;
    let kid = object.get("kid")?.as_str()?;
    (alg == TOKEN_ALGORITHM && typ == expected_typ && is_valid_key_id(kid)).then_some(kid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::{MAX_DOCUMENT_LIFETIME_SECONDS, Tier};
    use ed25519_dalek::{Signer, SigningKey};

    const NOW: i64 = 1_790_000_000;

    fn signing_key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    fn b64(bytes: &[u8]) -> String {
        URL_SAFE_NO_PAD.encode(bytes)
    }

    fn sign(key: &SigningKey, header: &serde_json::Value, payload: &serde_json::Value) -> String {
        let input = format!(
            "{}.{}",
            b64(header.to_string().as_bytes()),
            b64(payload.to_string().as_bytes())
        );
        let signature = key.sign(input.as_bytes());
        format!("{input}.{}", b64(&signature.to_bytes()))
    }

    fn header(kid: &str) -> serde_json::Value {
        serde_json::json!({ "alg": "EdDSA", "kid": kid, "typ": TOKEN_TYPE })
    }

    fn owner_payload(kid: &str) -> serde_json::Value {
        serde_json::json!({
            "version": 1, "accountId": "acct-1", "tier": "owner", "unrestricted": true,
            "features": [], "limits": {}, "issuedAt": NOW, "expiresAt": NOW + 3600, "keyId": kid
        })
    }

    fn verifier(key: &SigningKey, kid: &str) -> Verifier {
        let x = b64(key.verifying_key().as_bytes());
        Verifier::from_keys([(kid, x.as_str())]).expect("valid key")
    }

    #[test]
    fn verifies_a_document_signed_by_a_trusted_key() {
        let key = signing_key(7);
        let token = sign(&key, &header("k1"), &owner_payload("k1"));
        let entitlement = verifier(&key, "k1").verify(&token, NOW).expect("valid");
        assert_eq!(entitlement.tier, Tier::Owner);
        assert!(entitlement.has_feature("anything"));
    }

    #[test]
    fn rejects_tampering_and_untrusted_keys() {
        let key = signing_key(7);
        let trusted = verifier(&key, "k1");
        let token = sign(&key, &header("k1"), &owner_payload("k1"));

        let mut pro = owner_payload("k1");
        pro["tier"] = "pro".into();
        pro["unrestricted"] = false.into();
        let pro_token = sign(&key, &header("k1"), &pro);
        let owner_segment = token.split('.').nth(1).expect("segment");
        let parts: Vec<&str> = pro_token.split('.').collect();
        let forged = format!("{}.{}.{}", parts[0], owner_segment, parts[2]);
        assert_eq!(trusted.verify(&forged, NOW), Err(VerifyError::BadSignature));

        let other = signing_key(9);
        let foreign = sign(&other, &header("k1"), &owner_payload("k1"));
        assert_eq!(
            trusted.verify(&foreign, NOW),
            Err(VerifyError::BadSignature)
        );
        let unknown = sign(&other, &header("k2"), &owner_payload("k2"));
        assert_eq!(trusted.verify(&unknown, NOW), Err(VerifyError::UnknownKey));
    }

    #[test]
    fn rejects_other_algorithms_and_types() {
        let key = signing_key(7);
        let trusted = verifier(&key, "k1");
        for header in [
            serde_json::json!({ "alg": "none", "kid": "k1", "typ": TOKEN_TYPE }),
            serde_json::json!({ "alg": "EdDSA", "kid": "k1", "typ": "JWT" }),
            serde_json::json!({ "alg": "EdDSA", "typ": TOKEN_TYPE }),
            serde_json::json!(["EdDSA"]),
        ] {
            let token = sign(&key, &header, &owner_payload("k1"));
            assert_eq!(
                trusted.verify(&token, NOW),
                Err(VerifyError::UnsupportedHeader)
            );
        }
    }

    #[test]
    fn enforces_validity_window_and_document_rules() {
        let key = signing_key(7);
        let trusted = verifier(&key, "k1");
        let token = sign(&key, &header("k1"), &owner_payload("k1"));
        assert!(trusted.verify(&token, NOW + 3599).is_ok());
        assert_eq!(
            trusted.verify(&token, NOW + 3600),
            Err(VerifyError::Expired)
        );
        assert!(trusted.verify(&token, NOW - CLOCK_SKEW_SECONDS).is_ok());
        assert_eq!(
            trusted.verify(&token, NOW - CLOCK_SKEW_SECONDS - 1),
            Err(VerifyError::NotYetValid)
        );

        let mut long = owner_payload("k1");
        long["expiresAt"] = (NOW + MAX_DOCUMENT_LIFETIME_SECONDS + 1).into();
        assert_eq!(
            trusted.verify(&sign(&key, &header("k1"), &long), NOW),
            Err(VerifyError::InvalidDocument)
        );
        let mismatched = owner_payload("k2");
        assert_eq!(
            trusted.verify(&sign(&key, &header("k1"), &mismatched), NOW),
            Err(VerifyError::InvalidDocument)
        );
    }

    #[test]
    fn rejects_malformed_tokens() {
        let key = signing_key(7);
        let trusted = verifier(&key, "k1");
        let token = sign(&key, &header("k1"), &owner_payload("k1"));
        for bad in [
            String::new(),
            "a.b".to_owned(),
            format!("{token}.x"),
            format!("{token}=="),
            "x".repeat(MAX_TOKEN_LENGTH + 1),
        ] {
            assert_eq!(
                trusted.verify(&bad, NOW),
                Err(VerifyError::Malformed),
                "{bad:.40}"
            );
        }
    }

    #[test]
    fn strict_base64url() {
        assert_eq!(decode("AQ"), Some(vec![1]));
        assert_eq!(decode("AQ=="), None);
        assert_eq!(decode("AR"), None);
        assert_eq!(decode("A+/B"), None);
        assert_eq!(decode("A"), None);
    }

    #[test]
    fn refuses_invalid_trusted_keys() {
        assert!(matches!(
            Verifier::from_keys([("K", "AAAA")]),
            Err(KeyError::InvalidKeyId(_))
        ));
        assert!(matches!(
            Verifier::from_keys([("k", "AAAA")]),
            Err(KeyError::InvalidKey(_))
        ));
        // The identity point is a small-order (weak) key.
        let mut identity = [0u8; 32];
        identity[0] = 1;
        assert!(matches!(
            Verifier::from_keys([("k", b64(&identity).as_str())]),
            Err(KeyError::InvalidKey(_))
        ));
        let x = b64(signing_key(1).verifying_key().as_bytes());
        assert!(matches!(
            Verifier::from_keys([("k", x.as_str()), ("k", x.as_str())]),
            Err(KeyError::DuplicateKeyId(_))
        ));
    }
}
