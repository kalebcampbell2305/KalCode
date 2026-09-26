//! Verification contract for signed, locally executed KalVoice components.
//!
//! This module deliberately stops at verification and transition policy. It does not download,
//! load, execute, or update a component. The download layer must disable automatic redirects and
//! call [`ComponentVerifier::validate_redirect`] for every proposed redirect before following it.

use std::collections::{BTreeMap, BTreeSet};
use std::net::IpAddr;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use url::Url;

pub const TOKEN_TYPE: &str = "kalcode-local-component.v1";
pub const TOKEN_ALGORITHM: &str = "EdDSA";
pub const MAX_TOKEN_LENGTH: usize = 32 * 1024;
pub const MAX_ID_LENGTH: usize = 128;
pub const MAX_COMPONENT_SIZE_BYTES: u64 = 8 * 1024 * 1024 * 1024;
pub const MAX_MANIFEST_LIFETIME_SECONDS: i64 = 30 * 24 * 60 * 60;
pub const CLOCK_SKEW_SECONDS: i64 = 5 * 60;

const MAX_VERSION_LENGTH: usize = 64;
const MAX_ABI_LENGTH: usize = 128;
const MAX_URL_LENGTH: usize = 2048;
const MAX_FILE_NAME_LENGTH: usize = 160;
const MAX_LICENSES: usize = 16;
const MAX_LICENSE_ID_LENGTH: usize = 64;
const MAX_SOURCE_ID_LENGTH: usize = 256;
const MAX_SOURCE_REVISION_LENGTH: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComponentKind {
    Model,
    Runtime,
}

impl ComponentKind {
    fn path_segment(self) -> &'static str {
        match self {
            Self::Model => "model",
            Self::Runtime => "runtime",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComponentPlatform {
    Windows,
    Macos,
    Linux,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComponentArch {
    X86_64,
    Aarch64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComponentLicense {
    pub spdx_id: String,
    pub notice_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComponentProvenance {
    /// Stable upstream repository/model identifier, not a URL or a command.
    pub source_id: String,
    pub source_revision: String,
    pub source_integrity_sha256: String,
    pub build_recipe_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComponentManifest {
    pub schema_version: u32,
    pub component_id: String,
    pub kind: ComponentKind,
    pub version: String,
    /// Monotonic within one component/platform/architecture/runtime-ABI track.
    pub sequence: u64,
    pub platform: ComponentPlatform,
    pub arch: ComponentArch,
    pub runtime_abi: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub artifact_url: String,
    pub licenses: Vec<ComponentLicense>,
    pub provenance: ComponentProvenance,
    pub issued_at: i64,
    pub expires_at: i64,
    pub key_id: String,
}

impl ComponentManifest {
    fn validate(&self) -> bool {
        self.schema_version == 1
            && valid_token(&self.component_id, MAX_ID_LENGTH)
            && valid_token(&self.version, MAX_VERSION_LENGTH)
            && self.sequence > 0
            && valid_token(&self.runtime_abi, MAX_ABI_LENGTH)
            && (1..=MAX_COMPONENT_SIZE_BYTES).contains(&self.size_bytes)
            && is_sha256(&self.sha256)
            && self.artifact_url.len() <= MAX_URL_LENGTH
            && !self.licenses.is_empty()
            && self.licenses.len() <= MAX_LICENSES
            && licenses_are_valid(&self.licenses)
            && self.provenance.validate()
            && self.issued_at >= 0
            && self.expires_at > self.issued_at
            && self.expires_at - self.issued_at <= MAX_MANIFEST_LIFETIME_SECONDS
            && is_valid_key_id(&self.key_id)
    }
}

impl ComponentProvenance {
    fn validate(&self) -> bool {
        valid_source_id(&self.source_id)
            && valid_token(&self.source_revision, MAX_SOURCE_REVISION_LENGTH)
            && is_sha256(&self.source_integrity_sha256)
            && is_sha256(&self.build_recipe_sha256)
    }
}

/// A manifest whose JWS signature, schema, time window, fields, and artifact URL were verified.
/// The private field prevents callers from manufacturing this proof from untrusted JSON.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedComponentManifest {
    manifest: ComponentManifest,
}

impl VerifiedComponentManifest {
    pub fn manifest(&self) -> &ComponentManifest {
        &self.manifest
    }
}

/// Time state of a cryptographically valid manifest already installed on this device.
///
/// Manifest time bounds authorize acquisition. They do not revoke bytes that were acquired and
/// verified while the manifest was current. Trusted-key removal still revokes the receipt because
/// installed verification always rechecks the signature against the application's current key set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstalledManifestFreshness {
    Current,
    /// The local clock is before the signed issue window. This can happen after a clock rollback.
    ClockBeforeIssue,
    /// The signed acquisition window has elapsed. Offline use remains valid but is reported stale.
    Expired,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedInstalledManifest {
    verified: VerifiedComponentManifest,
    freshness: InstalledManifestFreshness,
}

impl VerifiedInstalledManifest {
    pub fn manifest(&self) -> &VerifiedComponentManifest {
        &self.verified
    }

    pub fn freshness(&self) -> InstalledManifestFreshness {
        self.freshness
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrustedKey {
    pub kid: &'static str,
    pub x: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum KeyError {
    #[error("at least one trusted component signing key is required")]
    NoTrustedKeys,
    #[error("invalid component signing key id {0:?}")]
    InvalidKeyId(String),
    #[error("component signing key {0:?} is not a valid Ed25519 public key")]
    InvalidKey(String),
    #[error("component signing key id {0:?} is listed twice")]
    DuplicateKeyId(String),
    #[error("invalid component download host {0:?}")]
    InvalidAllowedHost(String),
    #[error("at least one component download host is required")]
    NoAllowedHosts,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum VerifyError {
    #[error("the component manifest token is malformed")]
    Malformed,
    #[error("the component manifest token uses an unsupported algorithm or type")]
    UnsupportedHeader,
    #[error("the component manifest token was signed by an unknown key")]
    UnknownKey,
    #[error("the component manifest token signature is invalid")]
    BadSignature,
    #[error("the component manifest document is invalid")]
    InvalidDocument,
    #[error("the component artifact URL is not an allowed immutable KalCode URL")]
    InvalidUrl,
    #[error("the component manifest is not valid yet")]
    NotYetValid,
    #[error("the component manifest has expired")]
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
            Self::InvalidUrl => "invalid_url",
            Self::NotYetValid => "not_yet_valid",
            Self::Expired => "expired",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ComponentVerifier {
    keys: BTreeMap<String, VerifyingKey>,
    allowed_hosts: BTreeSet<String>,
}

impl ComponentVerifier {
    /// Constructs a verifier from application-trusted inputs. Neither keys nor hosts may come
    /// from a downloaded manifest.
    pub fn from_keys<'a, 'b>(
        keys: impl IntoIterator<Item = (&'a str, &'a str)>,
        allowed_hosts: impl IntoIterator<Item = &'b str>,
    ) -> Result<Self, KeyError> {
        let mut key_map = BTreeMap::new();
        for (kid, encoded) in keys {
            if !is_valid_key_id(kid) {
                return Err(KeyError::InvalidKeyId(kid.to_owned()));
            }
            let key = decode(encoded)
                .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
                .and_then(|bytes| VerifyingKey::from_bytes(&bytes).ok())
                .filter(|key| !key.is_weak())
                .ok_or_else(|| KeyError::InvalidKey(kid.to_owned()))?;
            if key_map.insert(kid.to_owned(), key).is_some() {
                return Err(KeyError::DuplicateKeyId(kid.to_owned()));
            }
        }
        if key_map.is_empty() {
            return Err(KeyError::NoTrustedKeys);
        }

        let mut host_set = BTreeSet::new();
        for host in allowed_hosts {
            if !is_valid_allowed_host(host) {
                return Err(KeyError::InvalidAllowedHost(host.to_owned()));
            }
            host_set.insert(host.to_owned());
        }
        if host_set.is_empty() {
            return Err(KeyError::NoAllowedHosts);
        }

        Ok(Self {
            keys: key_map,
            allowed_hosts: host_set,
        })
    }

    pub fn from_trusted(keys: &[TrustedKey], allowed_hosts: &[&str]) -> Result<Self, KeyError> {
        Self::from_keys(
            keys.iter().map(|key| (key.kid, key.x)),
            allowed_hosts.iter().copied(),
        )
    }

    pub fn verify(
        &self,
        token: &str,
        now_unix: i64,
    ) -> Result<VerifiedComponentManifest, VerifyError> {
        let (kid, payload) = self.verify_typed_jws(token, TOKEN_TYPE, MAX_TOKEN_LENGTH)?;
        let manifest: ComponentManifest =
            serde_json::from_slice(&payload).map_err(|_| VerifyError::InvalidDocument)?;
        if !manifest.validate() || manifest.key_id != kid {
            return Err(VerifyError::InvalidDocument);
        }
        self.validate_artifact_url(&manifest, &manifest.artifact_url)?;
        check_time(manifest.issued_at, manifest.expires_at, now_unix)?;
        Ok(VerifiedComponentManifest { manifest })
    }

    /// Revalidates a stored receipt without treating acquisition-window expiry as revocation.
    ///
    /// Signature, trusted key, schema, immutable URL, and every provenance field are checked on
    /// every call. Callers must use [`Self::verify`] for new installs and upgrades; this method is
    /// only for bytes already retained by the component store.
    pub fn verify_installed(
        &self,
        token: &str,
        now_unix: i64,
    ) -> Result<VerifiedInstalledManifest, VerifyError> {
        let (kid, payload) = self.verify_typed_jws(token, TOKEN_TYPE, MAX_TOKEN_LENGTH)?;
        let manifest: ComponentManifest =
            serde_json::from_slice(&payload).map_err(|_| VerifyError::InvalidDocument)?;
        if !manifest.validate() || manifest.key_id != kid {
            return Err(VerifyError::InvalidDocument);
        }
        self.validate_artifact_url(&manifest, &manifest.artifact_url)?;
        let freshness = if now_unix.saturating_add(CLOCK_SKEW_SECONDS) < manifest.issued_at {
            InstalledManifestFreshness::ClockBeforeIssue
        } else if now_unix >= manifest.expires_at {
            InstalledManifestFreshness::Expired
        } else {
            InstalledManifestFreshness::Current
        };
        Ok(VerifiedInstalledManifest {
            verified: VerifiedComponentManifest { manifest },
            freshness,
        })
    }

    /// Validates a redirect destination against the signed manifest. Downloaders must disable
    /// automatic redirects and invoke this method for each hop. The destination may change only
    /// to another preconfigured KalCode host; the immutable path must remain byte-for-byte equal.
    pub fn validate_redirect(
        &self,
        verified: &VerifiedComponentManifest,
        destination: &str,
    ) -> Result<(), VerifyError> {
        let manifest = verified.manifest();
        self.validate_artifact_url(manifest, destination)?;
        let original = Url::parse(&manifest.artifact_url).map_err(|_| VerifyError::InvalidUrl)?;
        let redirected = Url::parse(destination).map_err(|_| VerifyError::InvalidUrl)?;
        if original.path() != redirected.path() {
            return Err(VerifyError::InvalidUrl);
        }
        Ok(())
    }

    /// Verifies one domain-separated compact JWS with the same application-compiled authority
    /// used for component manifests. Sibling signed-document modules may select their own exact
    /// type and tighter document bound; downloaded documents can never supply keys.
    pub(crate) fn verify_typed_jws(
        &self,
        token: &str,
        expected_type: &str,
        max_token_length: usize,
    ) -> Result<(String, Vec<u8>), VerifyError> {
        if token.len() > max_token_length {
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
        let header_bytes = decode(header_segment).ok_or(VerifyError::Malformed)?;
        let header: Header =
            serde_json::from_slice(&header_bytes).map_err(|_| VerifyError::UnsupportedHeader)?;
        if header.alg != TOKEN_ALGORITHM
            || header.typ != expected_type
            || !is_valid_key_id(&header.kid)
        {
            return Err(VerifyError::UnsupportedHeader);
        }
        let key = self.keys.get(&header.kid).ok_or(VerifyError::UnknownKey)?;
        let payload = decode(payload_segment).ok_or(VerifyError::Malformed)?;
        let signing_input = format!("{header_segment}.{payload_segment}");
        key.verify_strict(signing_input.as_bytes(), &signature)
            .map_err(|_| VerifyError::BadSignature)?;
        Ok((header.kid, payload))
    }

    fn validate_artifact_url(
        &self,
        manifest: &ComponentManifest,
        raw: &str,
    ) -> Result<(), VerifyError> {
        if raw.len() > MAX_URL_LENGTH
            || !raw.starts_with("https://")
            || !raw.is_ascii()
            || raw.bytes().any(|byte| byte.is_ascii_control())
            || raw.contains(['%', '\\'])
            || raw["https://".len()..]
                .split('/')
                .next()
                .is_none_or(|authority| authority.contains(':'))
        {
            return Err(VerifyError::InvalidUrl);
        }
        let parsed = Url::parse(raw).map_err(|_| VerifyError::InvalidUrl)?;
        if parsed.scheme() != "https"
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.port().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
            || !parsed
                .host_str()
                .is_some_and(|host| self.allowed_hosts.contains(host))
        {
            return Err(VerifyError::InvalidUrl);
        }
        let segments: Vec<&str> = parsed
            .path_segments()
            .ok_or(VerifyError::InvalidUrl)?
            .collect();
        let [
            components,
            schema,
            kind,
            component_id,
            version,
            digest,
            file_name,
        ] = segments.as_slice()
        else {
            return Err(VerifyError::InvalidUrl);
        };
        if *components != "components"
            || *schema != "v1"
            || *kind != manifest.kind.path_segment()
            || *component_id != manifest.component_id
            || *version != manifest.version
            || *digest != manifest.sha256
            || !valid_file_name(file_name)
        {
            return Err(VerifyError::InvalidUrl);
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    alg: String,
    typ: String,
    kid: String,
}

#[derive(Debug, Clone, Copy)]
pub enum RollbackAllowance<'a> {
    Disallow,
    /// The exact component revision previously verified and retained by KalCode.
    PreviousVerified(&'a VerifiedComponentManifest),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum TransitionError {
    #[error("the candidate belongs to a different component track")]
    DifferentTrack,
    #[error("a component downgrade is not authorized")]
    DowngradeDenied,
    #[error("the candidate conflicts with the installed sequence")]
    ConflictingRevision,
    #[error("the rollback candidate is not the explicitly retained previous verified revision")]
    RollbackMismatch,
}

/// Applies monotonic component sequencing. A lower sequence is accepted only when it matches the
/// exact sealed previous verified manifest supplied by the caller as the rollback allowance.
pub fn authorize_transition(
    current: Option<&VerifiedComponentManifest>,
    candidate: &VerifiedComponentManifest,
    rollback: RollbackAllowance<'_>,
) -> Result<(), TransitionError> {
    let candidate = candidate.manifest();
    let Some(current) = current else {
        return Ok(());
    };
    let current = current.manifest();
    if !same_track(current, candidate) {
        return Err(TransitionError::DifferentTrack);
    }
    match candidate.sequence.cmp(&current.sequence) {
        std::cmp::Ordering::Greater => Ok(()),
        std::cmp::Ordering::Equal => same_revision(current, candidate)
            .then_some(())
            .ok_or(TransitionError::ConflictingRevision),
        std::cmp::Ordering::Less => match rollback {
            RollbackAllowance::Disallow => Err(TransitionError::DowngradeDenied),
            RollbackAllowance::PreviousVerified(previous)
                if same_track(current, previous.manifest())
                    && same_revision(candidate, previous.manifest()) =>
            {
                Ok(())
            }
            RollbackAllowance::PreviousVerified(_) => Err(TransitionError::RollbackMismatch),
        },
    }
}

fn same_track(left: &ComponentManifest, right: &ComponentManifest) -> bool {
    left.component_id == right.component_id
        && left.kind == right.kind
        && left.platform == right.platform
        && left.arch == right.arch
        && left.runtime_abi == right.runtime_abi
}

fn same_revision(left: &ComponentManifest, right: &ComponentManifest) -> bool {
    // A revision pins all signed metadata, including trust and validity. Renewing a signing
    // key or time window requires a higher sequence even when artifact bytes are unchanged.
    left == right
}

fn licenses_are_valid(licenses: &[ComponentLicense]) -> bool {
    let mut ids = BTreeSet::new();
    licenses.iter().all(|license| {
        valid_token(&license.spdx_id, MAX_LICENSE_ID_LENGTH)
            && is_sha256(&license.notice_sha256)
            && ids.insert(&license.spdx_id)
    })
}

fn valid_source_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_SOURCE_ID_LENGTH
        && !value.starts_with('/')
        && !value.ends_with('/')
        && !value.contains("..")
        && !value.contains("://")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'/'))
}

fn valid_token(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'+' | b'-'))
}

fn valid_file_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_FILE_NAME_LENGTH
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_valid_key_id(value: &str) -> bool {
    value.len() <= 64
        && value.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
        })
}

fn is_valid_allowed_host(host: &str) -> bool {
    host.len() <= 253
        && host.is_ascii()
        && host == host.to_ascii_lowercase()
        && host.parse::<IpAddr>().is_err()
        && host.split('.').count() >= 2
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label
                    .as_bytes()
                    .first()
                    .is_some_and(u8::is_ascii_alphanumeric)
                && label
                    .as_bytes()
                    .last()
                    .is_some_and(u8::is_ascii_alphanumeric)
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
}

pub(crate) fn check_time(
    issued_at: i64,
    expires_at: i64,
    now_unix: i64,
) -> Result<(), VerifyError> {
    if now_unix.saturating_add(CLOCK_SKEW_SECONDS) < issued_at {
        return Err(VerifyError::NotYetValid);
    }
    if now_unix >= expires_at {
        return Err(VerifyError::Expired);
    }
    Ok(())
}

fn decode(segment: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(segment).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use ed25519_dalek::{Signer, SigningKey};

    const NOW: i64 = 1_790_000_000;

    fn signing_key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    fn b64(bytes: &[u8]) -> String {
        URL_SAFE_NO_PAD.encode(bytes)
    }

    fn header(kid: &str) -> serde_json::Value {
        serde_json::json!({ "alg": "EdDSA", "kid": kid, "typ": TOKEN_TYPE })
    }

    fn payload(kid: &str) -> serde_json::Value {
        let digest = "57d1997790d1744fba5b40a7317df71ea5e2acee28c47e78f0cce39c0703f8cf";
        serde_json::json!({
            "schemaVersion": 1,
            "componentId": "kalvoice.reasoner.qwen3-5-0-8b-q4",
            "kind": "model",
            "version": "2026.09.1",
            "sequence": 4,
            "platform": "windows",
            "arch": "x86_64",
            "runtimeAbi": "kalvoice-llama-cpp.v1",
            "sizeBytes": 563_000_000_u64,
            "sha256": digest,
            "artifactUrl": format!(
                "https://models.kalcoded.com/components/v1/model/kalvoice.reasoner.qwen3-5-0-8b-q4/2026.09.1/{digest}/reasoner.gguf"
            ),
            "licenses": [{
                "spdxId": "Apache-2.0",
                "noticeSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            }],
            "provenance": {
                "sourceId": "Qwen/Qwen3.5-0.8B",
                "sourceRevision": "112d51429c6afaee530e92f97ca2659dbe7cf875",
                "sourceIntegritySha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                "buildRecipeSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
            },
            "issuedAt": NOW,
            "expiresAt": NOW + 86_400,
            "keyId": kid
        })
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

    fn verifier(key: &SigningKey) -> ComponentVerifier {
        let encoded = b64(key.verifying_key().as_bytes());
        ComponentVerifier::from_keys(
            [("component-2026-1", encoded.as_str())],
            ["models.kalcoded.com", "mirror.kalcoded.com"],
        )
        .expect("valid verifier")
    }

    fn verified(key: &SigningKey, payload: &serde_json::Value) -> VerifiedComponentManifest {
        verifier(key)
            .verify(&sign(key, &header("component-2026-1"), payload), NOW)
            .expect("valid manifest")
    }

    #[test]
    fn verifies_a_domain_separated_manifest_from_a_trusted_key() {
        let key = signing_key(7);
        let manifest = verified(&key, &payload("component-2026-1"));

        assert_eq!(manifest.manifest().schema_version, 1);
        assert_eq!(manifest.manifest().kind, ComponentKind::Model);
        assert_eq!(manifest.manifest().platform, ComponentPlatform::Windows);
        assert_eq!(manifest.manifest().arch, ComponentArch::X86_64);
        assert_eq!(manifest.manifest().sequence, 4);
    }

    #[test]
    fn rejects_wrong_keys_types_and_manifest_supplied_keys() {
        let trusted = signing_key(7);
        let foreign = signing_key(9);
        let verifier = verifier(&trusted);
        let body = payload("component-2026-1");

        assert_eq!(
            verifier.verify(&sign(&foreign, &header("component-2026-1"), &body), NOW),
            Err(VerifyError::BadSignature)
        );

        let wrong_domain = serde_json::json!({
            "alg": "EdDSA", "kid": "component-2026-1", "typ": "kalcode-entitlement.v1"
        });
        assert_eq!(
            verifier.verify(&sign(&trusted, &wrong_domain, &body), NOW),
            Err(VerifyError::UnsupportedHeader)
        );

        let mut supplied_key = body.clone();
        supplied_key["publicKey"] = serde_json::json!(b64(foreign.verifying_key().as_bytes()));
        assert_eq!(
            verifier.verify(
                &sign(&trusted, &header("component-2026-1"), &supplied_key),
                NOW
            ),
            Err(VerifyError::InvalidDocument)
        );

        let header_with_key = serde_json::json!({
            "alg": "EdDSA", "kid": "component-2026-1", "typ": TOKEN_TYPE,
            "jwk": { "x": b64(foreign.verifying_key().as_bytes()) }
        });
        assert_eq!(
            verifier.verify(&sign(&trusted, &header_with_key, &body), NOW),
            Err(VerifyError::UnsupportedHeader)
        );
    }

    #[test]
    fn rejects_unsafe_or_mutable_artifact_urls_and_redirects() {
        let key = signing_key(7);
        let verifier = verifier(&key);
        let valid = payload("component-2026-1");
        let good_url = valid["artifactUrl"].as_str().expect("url");

        for bad in [
            good_url.replacen("https://", "http://", 1),
            good_url.replacen("models.kalcoded.com", "evil.example", 1),
            good_url.replacen("models.kalcoded.com", "models.kalcoded.com@evil.example", 1),
            good_url.replacen("models.kalcoded.com", "models.kalcoded.com:443", 1),
            format!("{good_url}?download=1"),
            format!("{good_url}#fragment"),
            good_url.replace("/components/", "/other/"),
            good_url.replace("/model/", "/model/%2e%2e/"),
            good_url.replace("57d199", "67d199"),
        ] {
            let mut body = valid.clone();
            body["artifactUrl"] = bad.into();
            assert_eq!(
                verifier.verify(&sign(&key, &header("component-2026-1"), &body), NOW),
                Err(VerifyError::InvalidUrl),
                "{body}"
            );
        }

        let manifest = verified(&key, &valid);
        let allowed_mirror = good_url.replacen("models.kalcoded.com", "mirror.kalcoded.com", 1);
        assert!(
            verifier
                .validate_redirect(&manifest, &allowed_mirror)
                .is_ok()
        );
        assert_eq!(
            verifier.validate_redirect(
                &manifest,
                &good_url.replacen("models.kalcoded.com", "evil.example", 1)
            ),
            Err(VerifyError::InvalidUrl)
        );
        assert_eq!(
            verifier.validate_redirect(
                &manifest,
                &good_url.replace("/reasoner.gguf", "/other.gguf")
            ),
            Err(VerifyError::InvalidUrl)
        );
    }

    #[test]
    fn enforces_schema_time_size_and_field_bounds() {
        let key = signing_key(7);
        let verifier = verifier(&key);
        let base = payload("component-2026-1");

        assert_eq!(
            verifier.verify(
                &sign(&key, &header("component-2026-1"), &base),
                NOW + 86_400
            ),
            Err(VerifyError::Expired)
        );
        assert_eq!(
            verifier.verify(
                &sign(&key, &header("component-2026-1"), &base),
                NOW - CLOCK_SKEW_SECONDS - 1
            ),
            Err(VerifyError::NotYetValid)
        );

        let cases = [
            ("schemaVersion", serde_json::json!(2)),
            ("sizeBytes", serde_json::json!(MAX_COMPONENT_SIZE_BYTES + 1)),
            (
                "componentId",
                serde_json::json!("a".repeat(MAX_ID_LENGTH + 1)),
            ),
            ("sha256", serde_json::json!("A".repeat(64))),
            ("sequence", serde_json::json!(0)),
        ];
        for (field, value) in cases {
            let mut body = base.clone();
            body[field] = value;
            assert_eq!(
                verifier.verify(&sign(&key, &header("component-2026-1"), &body), NOW),
                Err(VerifyError::InvalidDocument),
                "{field}"
            );
        }

        let mut too_long_lived = base.clone();
        too_long_lived["expiresAt"] = serde_json::json!(NOW + MAX_MANIFEST_LIFETIME_SECONDS + 1);
        assert_eq!(
            verifier.verify(
                &sign(&key, &header("component-2026-1"), &too_long_lived),
                NOW
            ),
            Err(VerifyError::InvalidDocument)
        );
    }

    #[test]
    fn installed_receipts_keep_expired_bytes_usable_but_explicitly_stale() {
        let key = signing_key(7);
        let verifier = verifier(&key);
        let body = payload("component-2026-1");
        let token = sign(&key, &header("component-2026-1"), &body);

        assert_eq!(
            verifier.verify(&token, NOW + 86_400),
            Err(VerifyError::Expired)
        );
        let installed = verifier
            .verify_installed(&token, NOW + 86_400)
            .expect("a trusted installed receipt remains usable offline");
        assert_eq!(installed.freshness(), InstalledManifestFreshness::Expired);
        assert_eq!(installed.manifest().manifest().sequence, 4);

        let before_issue = verifier
            .verify_installed(&token, NOW - CLOCK_SKEW_SECONDS - 1)
            .expect("clock rollback is surfaced without silently revoking installed bytes");
        assert_eq!(
            before_issue.freshness(),
            InstalledManifestFreshness::ClockBeforeIssue
        );
    }

    #[test]
    fn installed_receipts_still_require_a_current_trusted_signature() {
        let trusted = signing_key(7);
        let foreign = signing_key(9);
        let verifier = verifier(&trusted);
        let body = payload("component-2026-1");
        let forged = sign(&foreign, &header("component-2026-1"), &body);

        assert_eq!(
            verifier.verify_installed(&forged, NOW + 86_400),
            Err(VerifyError::BadSignature)
        );
    }

    #[test]
    fn rejects_unknown_top_level_and_nested_fields() {
        let key = signing_key(7);
        let verifier = verifier(&key);

        let mut top = payload("component-2026-1");
        top["unexpected"] = serde_json::json!(true);
        assert_eq!(
            verifier.verify(&sign(&key, &header("component-2026-1"), &top), NOW),
            Err(VerifyError::InvalidDocument)
        );

        let mut nested = payload("component-2026-1");
        nested["provenance"]["downloadCommand"] = serde_json::json!("run me");
        assert_eq!(
            verifier.verify(&sign(&key, &header("component-2026-1"), &nested), NOW),
            Err(VerifyError::InvalidDocument)
        );
    }

    #[test]
    fn downgrade_requires_the_exact_previous_verified_manifest() {
        let key = signing_key(7);
        let mut previous_payload = payload("component-2026-1");
        previous_payload["sequence"] = serde_json::json!(3);
        previous_payload["version"] = serde_json::json!("2026.08.1");
        let digest = previous_payload["sha256"].as_str().expect("digest");
        previous_payload["artifactUrl"] = serde_json::json!(format!(
            "https://models.kalcoded.com/components/v1/model/kalvoice.reasoner.qwen3-5-0-8b-q4/2026.08.1/{digest}/reasoner.gguf"
        ));

        let previous = verified(&key, &previous_payload);
        let current = verified(&key, &payload("component-2026-1"));
        let mut upgrade_payload = payload("component-2026-1");
        upgrade_payload["sequence"] = serde_json::json!(5);
        upgrade_payload["version"] = serde_json::json!("2026.10.1");
        let digest = upgrade_payload["sha256"].as_str().expect("digest");
        upgrade_payload["artifactUrl"] = serde_json::json!(format!(
            "https://models.kalcoded.com/components/v1/model/kalvoice.reasoner.qwen3-5-0-8b-q4/2026.10.1/{digest}/reasoner.gguf"
        ));
        let upgrade = verified(&key, &upgrade_payload);

        assert!(authorize_transition(None, &current, RollbackAllowance::Disallow).is_ok());
        assert!(
            authorize_transition(Some(&current), &upgrade, RollbackAllowance::Disallow).is_ok()
        );
        assert_eq!(
            authorize_transition(Some(&current), &previous, RollbackAllowance::Disallow),
            Err(TransitionError::DowngradeDenied)
        );
        assert!(
            authorize_transition(
                Some(&current),
                &previous,
                RollbackAllowance::PreviousVerified(&previous)
            )
            .is_ok()
        );

        let unrelated = verified(&key, &upgrade_payload);
        assert_eq!(
            authorize_transition(
                Some(&current),
                &previous,
                RollbackAllowance::PreviousVerified(&unrelated)
            ),
            Err(TransitionError::RollbackMismatch)
        );
    }

    #[test]
    fn same_sequence_must_be_idempotently_identical() {
        let key = signing_key(7);
        let current = verified(&key, &payload("component-2026-1"));
        assert!(
            authorize_transition(Some(&current), &current, RollbackAllowance::Disallow).is_ok()
        );

        let mut conflict_payload = payload("component-2026-1");
        conflict_payload["sizeBytes"] = serde_json::json!(562_000_000_u64);
        let conflict = verified(&key, &conflict_payload);
        assert_eq!(
            authorize_transition(Some(&current), &conflict, RollbackAllowance::Disallow),
            Err(TransitionError::ConflictingRevision)
        );
    }

    #[test]
    fn same_sequence_cannot_replace_trust_or_validity_metadata() {
        let key = signing_key(7);
        let current = verified(&key, &payload("component-2026-1"));
        let mutations: [fn(&mut ComponentManifest); 4] = [
            |manifest| manifest.schema_version += 1,
            |manifest| manifest.issued_at += 1,
            |manifest| manifest.expires_at += 1,
            |manifest| manifest.key_id = "component-2026-2".to_owned(),
        ];
        for mutate in mutations {
            let mut conflict = current.clone();
            mutate(&mut conflict.manifest);
            assert_eq!(
                authorize_transition(Some(&current), &conflict, RollbackAllowance::Disallow),
                Err(TransitionError::ConflictingRevision)
            );
            let mut newer = current.clone();
            newer.manifest.sequence += 1;
            assert_eq!(
                authorize_transition(
                    Some(&newer),
                    &conflict,
                    RollbackAllowance::PreviousVerified(&current)
                ),
                Err(TransitionError::RollbackMismatch)
            );
        }
    }

    #[test]
    fn refuses_empty_or_invalid_trust_configuration_and_oversized_tokens() {
        let key = signing_key(7);
        let encoded = b64(key.verifying_key().as_bytes());
        assert!(matches!(
            ComponentVerifier::from_keys(
                std::iter::empty::<(&str, &str)>(),
                ["models.kalcoded.com"]
            ),
            Err(KeyError::NoTrustedKeys)
        ));
        assert!(matches!(
            ComponentVerifier::from_keys(
                [("component-2026-1", encoded.as_str())],
                ["*.kalcoded.com"]
            ),
            Err(KeyError::InvalidAllowedHost(_))
        ));
        assert!(matches!(
            ComponentVerifier::from_keys([("component-2026-1", encoded.as_str())], ["127.0.0.1"]),
            Err(KeyError::InvalidAllowedHost(_))
        ));

        let verifier = verifier(&key);
        assert_eq!(
            verifier.verify(&"x".repeat(MAX_TOKEN_LENGTH + 1), NOW),
            Err(VerifyError::Malformed)
        );
    }
}
