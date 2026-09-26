//! Signed component-bundle catalogs for KalVoice's local reasoning and speech models.
//!
//! A catalog contains only signed component tokens and bundle compatibility metadata. It never
//! supplies trust keys, allowed hosts, arbitrary download URLs, or executable arguments. The
//! caller supplies one compiled [`CatalogContract`], and every nested component token is verified
//! independently by the existing [`ComponentVerifier`].

use std::collections::BTreeSet;
use std::fmt;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::component_manifest::{
    ComponentArch, ComponentKind, ComponentPlatform, ComponentVerifier, MAX_ID_LENGTH,
    VerifiedComponentManifest, VerifyError, check_time,
};

pub const CATALOG_TOKEN_TYPE: &str = "kalcode-local-component-catalog.v1";
pub const MAX_CATALOG_TOKEN_LENGTH: usize = 192 * 1024;
pub const MAX_CATALOG_LIFETIME_SECONDS: i64 = 30 * 24 * 60 * 60;
pub const MAX_CATALOG_ENTRIES: usize = 7;
pub const MAX_SPEECH_MODELS: usize = 5;
pub const WHISPER_GGML_ABI: &str = "kalvoice-whisper-ggml.v1";

const MAX_CHANNEL_LENGTH: usize = 32;
const MAX_ABI_LENGTH: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum CatalogRole {
    #[serde(rename = "reason-runtime")]
    ReasoningRuntime,
    #[serde(rename = "reason-model")]
    ReasoningModel,
    #[serde(rename = "speech-model")]
    SpeechModel,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogEntry {
    pub role: CatalogRole,
    pub token: String,
}

impl fmt::Debug for CatalogEntry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CatalogEntry")
            .field("role", &self.role)
            .field("token", &"[SIGNED]")
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComponentCatalog {
    pub schema_version: u32,
    pub channel: String,
    pub sequence: u64,
    pub platform: ComponentPlatform,
    pub arch: ComponentArch,
    pub reasoning_abi: String,
    pub speech_model_abi: String,
    pub default_speech_component_id: String,
    pub entries: Vec<CatalogEntry>,
    pub issued_at: i64,
    pub expires_at: i64,
    pub key_id: String,
}

impl fmt::Debug for ComponentCatalog {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ComponentCatalog")
            .field("schema_version", &self.schema_version)
            .field("channel", &self.channel)
            .field("sequence", &self.sequence)
            .field("platform", &self.platform)
            .field("arch", &self.arch)
            .field("reasoning_abi", &self.reasoning_abi)
            .field("speech_model_abi", &self.speech_model_abi)
            .field(
                "default_speech_component_id",
                &self.default_speech_component_id,
            )
            .field("entry_count", &self.entries.len())
            .field("issued_at", &self.issued_at)
            .field("expires_at", &self.expires_at)
            .field("key_id", &self.key_id)
            .finish()
    }
}

impl ComponentCatalog {
    fn validate(&self, header_key_id: &str) -> bool {
        let reasoning_runtimes = self
            .entries
            .iter()
            .filter(|entry| entry.role == CatalogRole::ReasoningRuntime)
            .count();
        let reasoning_models = self
            .entries
            .iter()
            .filter(|entry| entry.role == CatalogRole::ReasoningModel)
            .count();
        let speech_models = self
            .entries
            .iter()
            .filter(|entry| entry.role == CatalogRole::SpeechModel)
            .count();
        self.schema_version == 1
            && valid_token(&self.channel, MAX_CHANNEL_LENGTH)
            && self.sequence > 0
            && valid_token(&self.reasoning_abi, MAX_ABI_LENGTH)
            && valid_token(&self.speech_model_abi, MAX_ABI_LENGTH)
            && valid_token(&self.default_speech_component_id, MAX_ID_LENGTH)
            && (3..=MAX_CATALOG_ENTRIES).contains(&self.entries.len())
            && reasoning_runtimes == 1
            && reasoning_models == 1
            && (1..=MAX_SPEECH_MODELS).contains(&speech_models)
            && self.entries.iter().all(|entry| {
                !entry.token.is_empty()
                    && entry.token.len() <= crate::component_manifest::MAX_TOKEN_LENGTH
            })
            && self.issued_at >= 0
            && self.expires_at > self.issued_at
            && self.expires_at - self.issued_at <= MAX_CATALOG_LIFETIME_SECONDS
            && self.key_id == header_key_id
    }
}

/// The exact local compatibility profile compiled into the caller.
///
/// Production passes the fixed reasoning component ids, all five allowed speech component ids,
/// and [`WHISPER_GGML_ABI`]. A catalog cannot add or remove a component from this profile.
#[derive(Debug, Clone, Copy)]
pub struct CatalogContract<'a> {
    pub channel: &'a str,
    pub platform: ComponentPlatform,
    pub arch: ComponentArch,
    pub reasoning_runtime_id: &'a str,
    pub reasoning_model_id: &'a str,
    pub reasoning_abi: &'a str,
    pub speech_model_ids: &'a [&'a str],
    pub default_speech_model_id: &'a str,
    pub speech_model_abi: &'a str,
}

impl CatalogContract<'_> {
    fn validate(&self) -> bool {
        let speech_ids: BTreeSet<&str> = self.speech_model_ids.iter().copied().collect();
        valid_token(self.channel, MAX_CHANNEL_LENGTH)
            && valid_token(self.reasoning_runtime_id, MAX_ID_LENGTH)
            && valid_token(self.reasoning_model_id, MAX_ID_LENGTH)
            && self.reasoning_runtime_id != self.reasoning_model_id
            && valid_token(self.reasoning_abi, MAX_ABI_LENGTH)
            && (1..=MAX_SPEECH_MODELS).contains(&self.speech_model_ids.len())
            && speech_ids.len() == self.speech_model_ids.len()
            && speech_ids.iter().all(|id| valid_token(id, MAX_ID_LENGTH))
            && !speech_ids.contains(self.reasoning_runtime_id)
            && !speech_ids.contains(self.reasoning_model_id)
            && speech_ids.contains(self.default_speech_model_id)
            && valid_token(self.speech_model_abi, MAX_ABI_LENGTH)
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct VerifiedCatalogEntry {
    role: CatalogRole,
    token: String,
    component: VerifiedComponentManifest,
}

impl VerifiedCatalogEntry {
    pub fn role(&self) -> CatalogRole {
        self.role
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn component(&self) -> &VerifiedComponentManifest {
        &self.component
    }
}

impl fmt::Debug for VerifiedCatalogEntry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("VerifiedCatalogEntry")
            .field("role", &self.role)
            .field("token", &"[SIGNED]")
            .field("component", &self.component)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct VerifiedComponentCatalog {
    catalog: ComponentCatalog,
    entries: Vec<VerifiedCatalogEntry>,
    token_sha256: String,
}

impl VerifiedComponentCatalog {
    pub fn catalog(&self) -> &ComponentCatalog {
        &self.catalog
    }

    pub fn entries(&self) -> &[VerifiedCatalogEntry] {
        &self.entries
    }

    pub fn entry(&self, role: CatalogRole) -> Option<&VerifiedCatalogEntry> {
        self.entries.iter().find(|entry| entry.role == role)
    }

    pub fn speech_models(&self) -> impl Iterator<Item = &VerifiedCatalogEntry> {
        self.entries
            .iter()
            .filter(|entry| entry.role == CatalogRole::SpeechModel)
    }

    pub fn token_sha256(&self) -> &str {
        &self.token_sha256
    }

    pub fn floor(&self) -> CatalogFloor {
        CatalogFloor {
            schema_version: 1,
            channel: self.catalog.channel.clone(),
            platform: self.catalog.platform,
            arch: self.catalog.arch,
            sequence: self.catalog.sequence,
            token_sha256: self.token_sha256.clone(),
            issued_at: self.catalog.issued_at,
            expires_at: self.catalog.expires_at,
        }
    }
}

impl fmt::Debug for VerifiedComponentCatalog {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("VerifiedComponentCatalog")
            .field("catalog", &self.catalog)
            .field("entries", &self.entries)
            .field("token_sha256", &self.token_sha256)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CatalogVerifyError {
    #[error("the signed component catalog could not be verified")]
    Signature(VerifyError),
    #[error("the signed component catalog document is invalid")]
    InvalidDocument,
    #[error("the compiled component catalog contract is invalid")]
    InvalidContract,
    #[error("the component catalog channel does not match this build")]
    WrongChannel,
    #[error("the component catalog target does not match this build")]
    WrongTarget,
    #[error("a nested component token could not be verified")]
    NestedComponent(VerifyError),
    #[error("the catalog component set does not match this build")]
    ComponentMismatch,
}

/// Verifies a catalog and every nested component token without performing network or disk I/O.
pub fn verify_catalog(
    verifier: &ComponentVerifier,
    token: &str,
    now_unix: i64,
    contract: CatalogContract<'_>,
) -> Result<VerifiedComponentCatalog, CatalogVerifyError> {
    if !contract.validate() {
        return Err(CatalogVerifyError::InvalidContract);
    }
    let (header_key_id, payload) = verifier
        .verify_typed_jws(token, CATALOG_TOKEN_TYPE, MAX_CATALOG_TOKEN_LENGTH)
        .map_err(CatalogVerifyError::Signature)?;
    let catalog: ComponentCatalog =
        serde_json::from_slice(&payload).map_err(|_| CatalogVerifyError::InvalidDocument)?;
    if !catalog.validate(&header_key_id) {
        return Err(CatalogVerifyError::InvalidDocument);
    }
    check_time(catalog.issued_at, catalog.expires_at, now_unix)
        .map_err(CatalogVerifyError::Signature)?;
    if catalog.channel != contract.channel {
        return Err(CatalogVerifyError::WrongChannel);
    }
    if catalog.platform != contract.platform || catalog.arch != contract.arch {
        return Err(CatalogVerifyError::WrongTarget);
    }
    if catalog.reasoning_abi != contract.reasoning_abi
        || catalog.speech_model_abi != contract.speech_model_abi
        || catalog.default_speech_component_id != contract.default_speech_model_id
    {
        return Err(CatalogVerifyError::ComponentMismatch);
    }

    let expected_speech_ids: BTreeSet<String> = contract
        .speech_model_ids
        .iter()
        .map(|id| (*id).to_owned())
        .collect();
    let mut actual_component_ids = BTreeSet::new();
    let mut actual_speech_ids = BTreeSet::new();
    let mut nested_tokens = BTreeSet::new();
    let mut entries = Vec::with_capacity(catalog.entries.len());
    for entry in &catalog.entries {
        if !nested_tokens.insert(entry.token.as_str()) {
            return Err(CatalogVerifyError::ComponentMismatch);
        }
        let component = verifier
            .verify(&entry.token, now_unix)
            .map_err(CatalogVerifyError::NestedComponent)?;
        let manifest = component.manifest();
        if manifest.platform != catalog.platform
            || manifest.arch != catalog.arch
            || manifest.key_id != catalog.key_id
            || manifest.issued_at > catalog.issued_at
            || manifest.expires_at < catalog.expires_at
            || !actual_component_ids.insert(manifest.component_id.clone())
        {
            return Err(CatalogVerifyError::ComponentMismatch);
        }
        let compatible = match entry.role {
            CatalogRole::ReasoningRuntime => {
                manifest.kind == ComponentKind::Runtime
                    && manifest.component_id == contract.reasoning_runtime_id
                    && manifest.runtime_abi == catalog.reasoning_abi
            }
            CatalogRole::ReasoningModel => {
                manifest.kind == ComponentKind::Model
                    && manifest.component_id == contract.reasoning_model_id
                    && manifest.runtime_abi == catalog.reasoning_abi
            }
            CatalogRole::SpeechModel => {
                manifest.kind == ComponentKind::Model
                    && expected_speech_ids.contains(&manifest.component_id)
                    && manifest.runtime_abi == catalog.speech_model_abi
                    && actual_speech_ids.insert(manifest.component_id.clone())
            }
        };
        if !compatible {
            return Err(CatalogVerifyError::ComponentMismatch);
        }
        entries.push(VerifiedCatalogEntry {
            role: entry.role,
            token: entry.token.clone(),
            component,
        });
    }
    if actual_speech_ids != expected_speech_ids
        || !actual_speech_ids.contains(&catalog.default_speech_component_id)
    {
        return Err(CatalogVerifyError::ComponentMismatch);
    }

    Ok(VerifiedComponentCatalog {
        catalog,
        entries,
        token_sha256: sha256_hex(token.as_bytes()),
    })
}

/// Minimal rollback floor persisted by the platform secret-store integration. Expiry never
/// erases a floor: a fresh catalog must still advance its sequence rather than rolling back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogFloor {
    schema_version: u32,
    channel: String,
    platform: ComponentPlatform,
    arch: ComponentArch,
    sequence: u64,
    token_sha256: String,
    issued_at: i64,
    expires_at: i64,
}

impl CatalogFloor {
    pub fn channel(&self) -> &str {
        &self.channel
    }

    pub fn platform(&self) -> ComponentPlatform {
        self.platform
    }

    pub fn arch(&self) -> ComponentArch {
        self.arch
    }

    pub fn sequence(&self) -> u64 {
        self.sequence
    }

    pub fn token_sha256(&self) -> &str {
        &self.token_sha256
    }

    pub fn issued_at(&self) -> i64 {
        self.issued_at
    }

    pub fn expires_at(&self) -> i64 {
        self.expires_at
    }

    pub(crate) fn is_valid(&self) -> bool {
        self.schema_version == 1
            && valid_token(&self.channel, MAX_CHANNEL_LENGTH)
            && self.sequence > 0
            && is_sha256(&self.token_sha256)
            && self.issued_at >= 0
            && self.expires_at > self.issued_at
            && self.expires_at - self.issued_at <= MAX_CATALOG_LIFETIME_SECONDS
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum CatalogTransitionError {
    #[error("the stored component catalog floor is invalid")]
    InvalidFloor,
    #[error("the candidate component catalog is not valid yet")]
    NotYetValid,
    #[error("the candidate component catalog has expired")]
    Expired,
    #[error("the candidate belongs to a different component catalog track")]
    DifferentTrack,
    #[error("a component catalog rollback is not authorized")]
    RollbackDenied,
    #[error("the candidate conflicts with the stored component catalog sequence")]
    ConflictingSequence,
}

/// Applies the pure monotonic transition policy and returns the exact floor to persist atomically.
/// The platform integration must fail closed if loading or storing the authoritative floor fails.
pub fn advance_catalog_floor(
    current: Option<&CatalogFloor>,
    candidate: &VerifiedComponentCatalog,
    now_unix: i64,
) -> Result<CatalogFloor, CatalogTransitionError> {
    match check_time(
        candidate.catalog.issued_at,
        candidate.catalog.expires_at,
        now_unix,
    ) {
        Ok(()) => {}
        Err(VerifyError::NotYetValid) => return Err(CatalogTransitionError::NotYetValid),
        Err(VerifyError::Expired) => return Err(CatalogTransitionError::Expired),
        Err(_) => return Err(CatalogTransitionError::InvalidFloor),
    }
    let candidate_floor = candidate.floor();
    let Some(current) = current else {
        return Ok(candidate_floor);
    };
    if !current.is_valid() {
        return Err(CatalogTransitionError::InvalidFloor);
    }
    if current.channel != candidate_floor.channel
        || current.platform != candidate_floor.platform
        || current.arch != candidate_floor.arch
    {
        return Err(CatalogTransitionError::DifferentTrack);
    }
    match candidate_floor.sequence.cmp(&current.sequence) {
        std::cmp::Ordering::Greater => Ok(candidate_floor),
        std::cmp::Ordering::Equal if current == &candidate_floor => Ok(current.clone()),
        std::cmp::Ordering::Equal => Err(CatalogTransitionError::ConflictingSequence),
        std::cmp::Ordering::Less => Err(CatalogTransitionError::RollbackDenied),
    }
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

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
#[path = "component_catalog_tests.rs"]
mod tests;
