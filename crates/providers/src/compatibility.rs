//! Signed, provider-neutral compatibility policy.
//!
//! Local capability probing remains the primary authority. This module can only narrow a probe's
//! result with signed declarative data: known-bad versions, protocol constraints, a stable floor,
//! and capability disables. A policy cannot grant a capability or execute downloaded content.
//!
//! Accepted revisions are monotonic within a running store and are retained as immutable signed
//! cache entries. That makes interrupted writes, corrupt newest entries, and offline startup
//! recoverable from a verified last-known-good entry. The cache is not a machine trust anchor: a
//! local attacker able to delete application data can remove the newest entries and cause an older
//! signed policy to load. Callers that need rollback resistance against such a local attacker must
//! additionally retain the highest revision in an OS-protected monotonic authority.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, RwLock};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signature, VerifyingKey};
use fs2::FileExt as _;
use semver::{Version, VersionReq};
use serde::{Deserialize, Serialize};

pub const TOKEN_TYPE: &str = "kalcode-provider-compatibility.v1";
pub const TOKEN_ALGORITHM: &str = "EdDSA";

const SCHEMA_VERSION: u32 = 1;
const MAX_TOKEN_BYTES: usize = 64 * 1024;
const MAX_DOCUMENT_BYTES: usize = 48 * 1024;
const MAX_POLICY_LIFETIME_SECONDS: i64 = 30 * 24 * 60 * 60;
const CLOCK_SKEW_SECONDS: i64 = 5 * 60;
const MAX_CACHE_ENTRIES: usize = 128;
const CACHE_RETAINED_ENTRIES: usize = 8;
const MAX_PROVIDERS: usize = 32;
const MAX_TESTED_VERSIONS: usize = 128;
const MAX_RULES: usize = 64;
const MAX_CAPABILITIES_PER_OVERRIDE: usize = 128;
const MAX_TOKEN_NAME_BYTES: usize = 64;
const MAX_VERSION_EXPRESSION_BYTES: usize = 128;
const MAX_REASON_BYTES: usize = 160;
const MAX_FEATURE_NAME_BYTES: usize = 128;
const CACHE_PREFIX: &str = "provider-compatibility-v1-";
const CACHE_SUFFIX: &str = ".jws";
const CACHE_LOCK_FILE: &str = ".provider-compatibility-v1.lock";

static CACHE_WRITE_LOCK: Mutex<()> = Mutex::new(());
static ACTIVE_STORE: OnceLock<RwLock<Option<CompatibilityStore>>> = OnceLock::new();

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CompatibilityError {
    #[error("at least one trusted compatibility signing key is required")]
    NoTrustedKeys,
    #[error("compatibility signing key id is invalid")]
    InvalidKeyId,
    #[error("compatibility signing key is invalid")]
    InvalidKey,
    #[error("compatibility signing key id is duplicated")]
    DuplicateKeyId,
    #[error("the compatibility token is malformed")]
    MalformedToken,
    #[error("the compatibility token uses an unsupported header")]
    UnsupportedHeader,
    #[error("the compatibility token uses an unknown signing key")]
    UnknownKey,
    #[error("the compatibility token signature is invalid")]
    BadSignature,
    #[error("the compatibility policy document is invalid")]
    InvalidDocument,
    #[error("the compatibility policy is not valid yet")]
    NotYetValid,
    #[error("the compatibility policy has expired")]
    Expired,
    #[error("compatibility policy revision {candidate} would roll back revision {current}")]
    RevisionRollback { current: u64, candidate: u64 },
    #[error("compatibility policy revision conflicts with an accepted document")]
    RevisionConflict,
    #[error("provider or protocol version is invalid")]
    InvalidVersion,
    #[error("compatibility policy cache error: {0}")]
    Cache(String),
}

#[derive(Debug, Clone)]
pub struct CompatibilityVerifier {
    keys: BTreeMap<String, VerifyingKey>,
}

impl CompatibilityVerifier {
    /// Builds a verifier from application-trusted raw Ed25519 public keys encoded as strict,
    /// unpadded base64url. Keys must be compiled/configured by the application, never read from a
    /// downloaded policy.
    pub fn from_keys<'a>(
        keys: impl IntoIterator<Item = (&'a str, &'a str)>,
    ) -> Result<Self, CompatibilityError> {
        let mut trusted = BTreeMap::new();
        for (kid, encoded) in keys {
            if !valid_name(kid) {
                return Err(CompatibilityError::InvalidKeyId);
            }
            let bytes = decode_base64url(encoded).ok_or(CompatibilityError::InvalidKey)?;
            let bytes: [u8; 32] = bytes
                .try_into()
                .map_err(|_| CompatibilityError::InvalidKey)?;
            let key = VerifyingKey::from_bytes(&bytes)
                .ok()
                .filter(|key| !key.is_weak())
                .ok_or(CompatibilityError::InvalidKey)?;
            if trusted.insert(kid.to_owned(), key).is_some() {
                return Err(CompatibilityError::DuplicateKeyId);
            }
        }
        if trusted.is_empty() {
            return Err(CompatibilityError::NoTrustedKeys);
        }
        Ok(Self { keys: trusted })
    }

    fn verify(
        &self,
        token: &str,
        now_unix: i64,
        time_mode: TimeMode,
    ) -> Result<VerifiedPolicy, CompatibilityError> {
        if token.is_empty() || token.len() > MAX_TOKEN_BYTES || !token.is_ascii() {
            return Err(CompatibilityError::MalformedToken);
        }
        let mut segments = token.split('.');
        let (Some(header_segment), Some(payload_segment), Some(signature_segment), None) = (
            segments.next(),
            segments.next(),
            segments.next(),
            segments.next(),
        ) else {
            return Err(CompatibilityError::MalformedToken);
        };
        let header_bytes =
            decode_base64url(header_segment).ok_or(CompatibilityError::MalformedToken)?;
        let header: Header = serde_json::from_slice(&header_bytes)
            .map_err(|_| CompatibilityError::UnsupportedHeader)?;
        if header.alg != TOKEN_ALGORITHM || header.typ != TOKEN_TYPE || !valid_name(&header.kid) {
            return Err(CompatibilityError::UnsupportedHeader);
        }
        let key = self
            .keys
            .get(&header.kid)
            .ok_or(CompatibilityError::UnknownKey)?;
        let signature = decode_base64url(signature_segment)
            .and_then(|bytes| <[u8; 64]>::try_from(bytes).ok())
            .map(|bytes| Signature::from_bytes(&bytes))
            .ok_or(CompatibilityError::MalformedToken)?;
        let signing_input = format!("{header_segment}.{payload_segment}");
        key.verify_strict(signing_input.as_bytes(), &signature)
            .map_err(|_| CompatibilityError::BadSignature)?;

        let payload = decode_base64url(payload_segment)
            .filter(|bytes| bytes.len() <= MAX_DOCUMENT_BYTES)
            .ok_or(CompatibilityError::InvalidDocument)?;
        let document: PolicyDocument =
            serde_json::from_slice(&payload).map_err(|_| CompatibilityError::InvalidDocument)?;
        let compiled = CompiledPolicy::compile(document, &header.kid)?;
        let freshness = check_time(&compiled.document, now_unix, time_mode)?;
        Ok(VerifiedPolicy {
            compiled,
            token: token.to_owned(),
            freshness,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    alg: String,
    typ: String,
    kid: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PolicyDocument {
    schema_version: u32,
    revision: u64,
    issued_at: i64,
    expires_at: i64,
    key_id: String,
    providers: Vec<ProviderRuleDocument>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderRuleDocument {
    provider: String,
    stable_floor: Option<String>,
    tested_versions: Vec<String>,
    known_bad: Vec<KnownBadDocument>,
    protocol_constraints: Vec<ProtocolConstraintDocument>,
    capability_disables: Vec<CapabilityDisableDocument>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KnownBadDocument {
    versions: String,
    reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProtocolConstraintDocument {
    cli_versions: String,
    protocol: String,
    protocol_versions: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CapabilityDisableDocument {
    cli_versions: String,
    capabilities: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CompiledPolicy {
    document: PolicyDocument,
    providers: BTreeMap<String, CompiledProviderRule>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CompiledProviderRule {
    stable_floor: Option<Version>,
    tested_versions: BTreeSet<Version>,
    known_bad: Vec<KnownBadRule>,
    protocol_constraints: Vec<ProtocolConstraint>,
    capability_disables: Vec<CapabilityDisable>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct KnownBadRule {
    versions: VersionReq,
    reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProtocolConstraint {
    cli_versions: VersionReq,
    protocol: String,
    protocol_versions: VersionReq,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CapabilityDisable {
    cli_versions: VersionReq,
    capabilities: BTreeSet<String>,
}

impl CompiledPolicy {
    fn compile(document: PolicyDocument, signing_key_id: &str) -> Result<Self, CompatibilityError> {
        if document.schema_version != SCHEMA_VERSION
            || document.revision == 0
            || document.key_id != signing_key_id
            || !valid_name(&document.key_id)
            || document.issued_at < 0
            || document.expires_at <= document.issued_at
            || document.expires_at - document.issued_at > MAX_POLICY_LIFETIME_SECONDS
            || document.providers.is_empty()
            || document.providers.len() > MAX_PROVIDERS
        {
            return Err(CompatibilityError::InvalidDocument);
        }
        let mut providers = BTreeMap::new();
        for source in &document.providers {
            if !valid_name(&source.provider)
                || source.tested_versions.len() > MAX_TESTED_VERSIONS
                || source.known_bad.len() > MAX_RULES
                || source.protocol_constraints.len() > MAX_RULES
                || source.capability_disables.len() > MAX_RULES
            {
                return Err(CompatibilityError::InvalidDocument);
            }
            let stable_floor = source
                .stable_floor
                .as_deref()
                .map(parse_version)
                .transpose()?;
            if stable_floor
                .as_ref()
                .is_some_and(|version| !version.pre.is_empty() || !version.build.is_empty())
            {
                return Err(CompatibilityError::InvalidDocument);
            }
            let tested_versions = source
                .tested_versions
                .iter()
                .map(|value| parse_version(value))
                .collect::<Result<BTreeSet<_>, _>>()?;
            if tested_versions.len() != source.tested_versions.len() {
                return Err(CompatibilityError::InvalidDocument);
            }
            let known_bad = source
                .known_bad
                .iter()
                .map(|rule| {
                    if !valid_reason(&rule.reason) {
                        return Err(CompatibilityError::InvalidDocument);
                    }
                    Ok(KnownBadRule {
                        versions: parse_requirement(&rule.versions)?,
                        reason: rule.reason.clone(),
                    })
                })
                .collect::<Result<Vec<_>, _>>()?;
            if known_bad
                .iter()
                .map(|rule| (rule.versions.to_string(), rule.reason.as_str()))
                .collect::<BTreeSet<_>>()
                .len()
                != known_bad.len()
            {
                return Err(CompatibilityError::InvalidDocument);
            }
            let protocol_constraints = source
                .protocol_constraints
                .iter()
                .map(|rule| {
                    if !valid_feature_name(&rule.protocol) {
                        return Err(CompatibilityError::InvalidDocument);
                    }
                    Ok(ProtocolConstraint {
                        cli_versions: parse_requirement(&rule.cli_versions)?,
                        protocol: rule.protocol.clone(),
                        protocol_versions: parse_requirement(&rule.protocol_versions)?,
                    })
                })
                .collect::<Result<Vec<_>, _>>()?;
            if protocol_constraints
                .iter()
                .map(|rule| {
                    (
                        rule.cli_versions.to_string(),
                        rule.protocol.as_str(),
                        rule.protocol_versions.to_string(),
                    )
                })
                .collect::<BTreeSet<_>>()
                .len()
                != protocol_constraints.len()
            {
                return Err(CompatibilityError::InvalidDocument);
            }
            let capability_disables = source
                .capability_disables
                .iter()
                .map(|rule| {
                    if rule.capabilities.is_empty()
                        || rule.capabilities.len() > MAX_CAPABILITIES_PER_OVERRIDE
                        || !rule
                            .capabilities
                            .iter()
                            .all(|value| valid_feature_name(value))
                    {
                        return Err(CompatibilityError::InvalidDocument);
                    }
                    let capabilities = rule.capabilities.iter().cloned().collect::<BTreeSet<_>>();
                    if capabilities.len() != rule.capabilities.len() {
                        return Err(CompatibilityError::InvalidDocument);
                    }
                    Ok(CapabilityDisable {
                        cli_versions: parse_requirement(&rule.cli_versions)?,
                        capabilities,
                    })
                })
                .collect::<Result<Vec<_>, _>>()?;
            if capability_disables
                .iter()
                .map(|rule| rule.cli_versions.to_string())
                .collect::<BTreeSet<_>>()
                .len()
                != capability_disables.len()
            {
                return Err(CompatibilityError::InvalidDocument);
            }
            let compiled = CompiledProviderRule {
                stable_floor,
                tested_versions,
                known_bad,
                protocol_constraints,
                capability_disables,
            };
            if providers
                .insert(source.provider.clone(), compiled)
                .is_some()
            {
                return Err(CompatibilityError::InvalidDocument);
            }
        }
        Ok(Self {
            document,
            providers,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TimeMode {
    NewDownload,
    Cached,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyFreshness {
    Empty,
    Current,
    Stale,
}

fn check_time(
    document: &PolicyDocument,
    now_unix: i64,
    mode: TimeMode,
) -> Result<PolicyFreshness, CompatibilityError> {
    if now_unix.saturating_add(CLOCK_SKEW_SECONDS) < document.issued_at {
        return match mode {
            TimeMode::NewDownload => Err(CompatibilityError::NotYetValid),
            TimeMode::Cached => Ok(PolicyFreshness::Stale),
        };
    }
    if now_unix >= document.expires_at {
        return match mode {
            TimeMode::NewDownload => Err(CompatibilityError::Expired),
            TimeMode::Cached => Ok(PolicyFreshness::Stale),
        };
    }
    Ok(PolicyFreshness::Current)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct VerifiedPolicy {
    compiled: CompiledPolicy,
    token: String,
    freshness: PolicyFreshness,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProbeFacts {
    /// Capabilities established by local adapter probes. Policy evaluation can only remove items.
    pub capabilities: BTreeSet<String>,
    /// Locally observed named protocol/schema versions.
    pub protocols: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompatibilityStatus {
    /// The signed policy does not veto this CLI. This never proves that required local probes
    /// passed; callers must combine it with their adapter-owned capability/startup result.
    Usable {
        tested: bool,
    },
    BelowStableFloor {
        floor: String,
    },
    KnownBad {
        reason: String,
    },
    ProtocolIncompatible {
        protocol: String,
        required: String,
        found: Option<String>,
    },
}

impl CompatibilityStatus {
    pub fn is_usable(&self) -> bool {
        matches!(self, Self::Usable { .. })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompatibilityDecision {
    pub status: CompatibilityStatus,
    pub policy_revision: Option<u64>,
    pub effective_capabilities: BTreeSet<String>,
    pub disabled_by_policy: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompatibilitySnapshot {
    policy: Option<Arc<CompiledPolicy>>,
    token: Option<Arc<str>>,
    freshness: PolicyFreshness,
    recovered_from_invalid_cache: bool,
}

impl CompatibilitySnapshot {
    fn empty() -> Self {
        Self {
            policy: None,
            token: None,
            freshness: PolicyFreshness::Empty,
            recovered_from_invalid_cache: false,
        }
    }

    fn from_verified(verified: VerifiedPolicy, recovered_from_invalid_cache: bool) -> Self {
        Self {
            policy: Some(Arc::new(verified.compiled)),
            token: Some(Arc::from(verified.token)),
            freshness: verified.freshness,
            recovered_from_invalid_cache,
        }
    }

    pub fn revision(&self) -> Option<u64> {
        self.policy.as_ref().map(|policy| policy.document.revision)
    }

    pub fn freshness(&self) -> PolicyFreshness {
        self.freshness
    }

    /// True when startup skipped a newer-looking corrupt or unverifiable cache entry and retained
    /// an older verified policy. This is diagnostic state only and must not interrupt users.
    pub fn recovered_from_invalid_cache(&self) -> bool {
        self.recovered_from_invalid_cache
    }

    pub fn evaluate(
        &self,
        provider: &str,
        cli_version: &str,
        facts: &ProbeFacts,
    ) -> Result<CompatibilityDecision, CompatibilityError> {
        if !valid_name(provider) {
            return Err(CompatibilityError::InvalidDocument);
        }
        let version =
            Version::parse(cli_version).map_err(|_| CompatibilityError::InvalidVersion)?;
        let mut effective = facts.capabilities.clone();
        let mut disabled = BTreeSet::new();
        let revision = self.revision();
        let Some(rule) = self
            .policy
            .as_ref()
            .and_then(|policy| policy.providers.get(provider))
        else {
            return Ok(CompatibilityDecision {
                status: CompatibilityStatus::Usable { tested: false },
                policy_revision: revision,
                effective_capabilities: effective,
                disabled_by_policy: disabled,
            });
        };

        for override_rule in &rule.capability_disables {
            if override_rule.cli_versions.matches(&version) {
                for capability in &override_rule.capabilities {
                    if effective.remove(capability) {
                        disabled.insert(capability.clone());
                    }
                }
            }
        }
        let status = if let Some(known_bad) = rule
            .known_bad
            .iter()
            .find(|known_bad| known_bad.versions.matches(&version))
        {
            CompatibilityStatus::KnownBad {
                reason: known_bad.reason.clone(),
            }
        } else if let Some(floor) = rule.stable_floor.as_ref().filter(|floor| version < **floor) {
            CompatibilityStatus::BelowStableFloor {
                floor: floor.to_string(),
            }
        } else if let Some(incompatible) = first_protocol_mismatch(rule, &version, facts)? {
            incompatible
        } else {
            CompatibilityStatus::Usable {
                tested: rule.tested_versions.contains(&version),
            }
        };
        Ok(CompatibilityDecision {
            status,
            policy_revision: revision,
            effective_capabilities: effective,
            disabled_by_policy: disabled,
        })
    }
}

fn first_protocol_mismatch(
    rule: &CompiledProviderRule,
    cli_version: &Version,
    facts: &ProbeFacts,
) -> Result<Option<CompatibilityStatus>, CompatibilityError> {
    for constraint in &rule.protocol_constraints {
        if !constraint.cli_versions.matches(cli_version) {
            continue;
        }
        let found = facts.protocols.get(&constraint.protocol);
        let compatible = found
            .map(|value| Version::parse(value).map_err(|_| CompatibilityError::InvalidVersion))
            .transpose()?
            .is_some_and(|version| constraint.protocol_versions.matches(&version));
        if !compatible {
            return Ok(Some(CompatibilityStatus::ProtocolIncompatible {
                protocol: constraint.protocol.clone(),
                required: constraint.protocol_versions.to_string(),
                found: found.cloned(),
            }));
        }
    }
    Ok(None)
}

#[derive(Debug, Clone)]
pub struct CompatibilityStore {
    cache_root: Arc<PathBuf>,
    verifier: Arc<CompatibilityVerifier>,
    snapshot: Arc<RwLock<Arc<CompatibilitySnapshot>>>,
}

impl CompatibilityStore {
    pub fn open(
        cache_root: impl AsRef<Path>,
        verifier: CompatibilityVerifier,
        now_unix: i64,
    ) -> Result<Self, CompatibilityError> {
        let cache_root = cache_root.as_ref().to_path_buf();
        ensure_cache_directory(&cache_root)?;
        let verifier = Arc::new(verifier);
        let snapshot = load_cached_snapshot(&cache_root, &verifier, now_unix)?;
        Ok(Self {
            cache_root: Arc::new(cache_root),
            verifier,
            snapshot: Arc::new(RwLock::new(Arc::new(snapshot))),
        })
    }

    pub fn cached_snapshot(&self) -> Arc<CompatibilitySnapshot> {
        self.snapshot
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub fn evaluate(
        &self,
        provider: &str,
        cli_version: &str,
        facts: &ProbeFacts,
    ) -> Result<CompatibilityDecision, CompatibilityError> {
        self.cached_snapshot()
            .evaluate(provider, cli_version, facts)
    }

    /// Installs a newly downloaded signed policy. Verification and persistence finish before the
    /// in-memory snapshot changes, so readers always see either the old or the new full policy.
    pub fn refresh(
        &self,
        token: &str,
        now_unix: i64,
    ) -> Result<Arc<CompatibilitySnapshot>, CompatibilityError> {
        let verified = self
            .verifier
            .verify(token, now_unix, TimeMode::NewDownload)?;
        let candidate_revision = verified.compiled.document.revision;
        let _cache_guard = CACHE_WRITE_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let _file_lock = lock_cache(&self.cache_root)?;
        let mut guard = self
            .snapshot
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let disk_snapshot = load_cached_snapshot(&self.cache_root, &self.verifier, now_unix)?;
        if disk_snapshot.revision() > guard.revision() {
            *guard = Arc::new(disk_snapshot);
        }
        if let Some(current_revision) = guard.revision() {
            if candidate_revision < current_revision {
                return Err(CompatibilityError::RevisionRollback {
                    current: current_revision,
                    candidate: candidate_revision,
                });
            }
            if candidate_revision == current_revision {
                if guard.token.as_deref() == Some(token) {
                    return Ok(guard.clone());
                }
                return Err(CompatibilityError::RevisionConflict);
            }
        }
        persist_verified(&self.cache_root, &verified, &self.verifier, now_unix)?;
        prune_cache(&self.cache_root, &self.verifier, now_unix);
        let accepted = Arc::new(CompatibilitySnapshot::from_verified(verified, false));
        *guard = accepted.clone();
        Ok(accepted)
    }

    #[cfg(test)]
    fn cache_entry_path_for_test(&self, revision: u64) -> PathBuf {
        cache_entry_path(&self.cache_root, revision)
    }
}

/// Installs the process-wide policy store used by provider launch paths. Replacing the store is
/// intentional: desktop startup can first expose the verified cache, then install an equivalent
/// refreshed store without interrupting active provider processes.
pub fn set_active_store(store: CompatibilityStore) {
    *active_store_slot()
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(store);
}

/// Returns the process-wide immutable snapshot. No configured store means an empty policy, which
/// keeps local capability probes authoritative and never blocks a provider merely due to offline
/// or unavailable remote compatibility data.
pub fn active_snapshot() -> Arc<CompatibilitySnapshot> {
    active_store_slot()
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
        .map(CompatibilityStore::cached_snapshot)
        .unwrap_or_else(|| Arc::new(CompatibilitySnapshot::empty()))
}

pub fn evaluate_active(
    provider: &str,
    cli_version: &str,
    facts: &ProbeFacts,
) -> Result<CompatibilityDecision, CompatibilityError> {
    active_snapshot().evaluate(provider, cli_version, facts)
}

fn active_store_slot() -> &'static RwLock<Option<CompatibilityStore>> {
    ACTIVE_STORE.get_or_init(|| RwLock::new(None))
}

#[cfg(test)]
fn clear_active_store_for_test() {
    *active_store_slot()
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
}

fn load_cached_snapshot(
    root: &Path,
    verifier: &CompatibilityVerifier,
    now_unix: i64,
) -> Result<CompatibilitySnapshot, CompatibilityError> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(root).map_err(cache_error)? {
        let entry = entry.map_err(cache_error)?;
        let Some(revision) = cache_revision(&entry.file_name().to_string_lossy()) else {
            continue;
        };
        entries.push((revision, entry.path()));
        if entries.len() > MAX_CACHE_ENTRIES {
            let mut snapshot = CompatibilitySnapshot::empty();
            snapshot.recovered_from_invalid_cache = true;
            return Ok(snapshot);
        }
    }
    entries.sort_unstable_by_key(|entry| std::cmp::Reverse(entry.0));
    let mut recovered_from_invalid_cache = false;
    for (file_revision, path) in entries {
        let Ok(bytes) = read_bounded(&path) else {
            recovered_from_invalid_cache = true;
            continue;
        };
        let Ok(token) = String::from_utf8(bytes) else {
            recovered_from_invalid_cache = true;
            continue;
        };
        let Ok(verified) = verifier.verify(&token, now_unix, TimeMode::Cached) else {
            recovered_from_invalid_cache = true;
            continue;
        };
        if verified.compiled.document.revision == file_revision {
            return Ok(CompatibilitySnapshot::from_verified(
                verified,
                recovered_from_invalid_cache,
            ));
        }
        recovered_from_invalid_cache = true;
    }
    let mut snapshot = CompatibilitySnapshot::empty();
    snapshot.recovered_from_invalid_cache = recovered_from_invalid_cache;
    Ok(snapshot)
}

fn ensure_cache_directory(path: &Path) -> Result<(), CompatibilityError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !is_link_or_reparse(&metadata) => Ok(()),
        Ok(_) => Err(CompatibilityError::Cache(
            "cache root is not an ordinary directory".to_owned(),
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(path).map_err(cache_error)?;
            let metadata = fs::symlink_metadata(path).map_err(cache_error)?;
            if metadata.is_dir() && !is_link_or_reparse(&metadata) {
                Ok(())
            } else {
                Err(CompatibilityError::Cache(
                    "cache root is not an ordinary directory".to_owned(),
                ))
            }
        }
        Err(error) => Err(cache_error(error)),
    }
}

struct CacheFileLock(File);

impl Drop for CacheFileLock {
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&self.0);
    }
}

fn lock_cache(root: &Path) -> Result<CacheFileLock, CompatibilityError> {
    let path = root.join(CACHE_LOCK_FILE);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if !metadata.is_file() || is_link_or_reparse(&metadata) => {
            return Err(CompatibilityError::Cache(
                "cache lock is not an ordinary file".to_owned(),
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(cache_error(error)),
    }
    let file = open_cache_lock_file(&path)?;
    let metadata = file.metadata().map_err(cache_error)?;
    if !metadata.is_file() {
        return Err(CompatibilityError::Cache(
            "cache lock is not an ordinary file".to_owned(),
        ));
    }
    file.lock_exclusive().map_err(cache_error)?;
    Ok(CacheFileLock(file))
}

#[cfg(unix)]
fn open_cache_lock_file(path: &Path) -> Result<File, CompatibilityError> {
    use std::os::unix::fs::OpenOptionsExt as _;

    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(cache_error)
}

#[cfg(windows)]
fn open_cache_lock_file(path: &Path) -> Result<File, CompatibilityError> {
    use std::os::windows::fs::OpenOptionsExt as _;

    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(cache_error)
}

#[cfg(not(any(unix, windows)))]
fn open_cache_lock_file(path: &Path) -> Result<File, CompatibilityError> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(cache_error)
}

fn persist_verified(
    root: &Path,
    candidate: &VerifiedPolicy,
    verifier: &CompatibilityVerifier,
    now_unix: i64,
) -> Result<(), CompatibilityError> {
    let revision = candidate.compiled.document.revision;
    let token = candidate.token.as_str();
    let destination = cache_entry_path(root, revision);
    let quarantine = match fs::symlink_metadata(&destination) {
        Ok(metadata) => {
            if !metadata.is_file() || is_link_or_reparse(&metadata) {
                return Err(CompatibilityError::Cache(
                    "cache entry is not a bounded ordinary file".to_owned(),
                ));
            }
            if metadata.len() > MAX_TOKEN_BYTES as u64 {
                quarantine_invalid_entry(root, revision, &destination)?
            } else {
                let existing = read_bounded(&destination)?;
                if existing == token.as_bytes() {
                    return Ok(());
                }
                let existing_is_valid_same_revision = String::from_utf8(existing)
                    .ok()
                    .and_then(|existing| {
                        verifier.verify(&existing, now_unix, TimeMode::Cached).ok()
                    })
                    .is_some_and(|verified| verified.compiled.document.revision == revision);
                if existing_is_valid_same_revision {
                    return Err(CompatibilityError::RevisionConflict);
                }
                quarantine_invalid_entry(root, revision, &destination)?
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(cache_error(error)),
    };
    let result = write_new_cache_entry(root, revision, token, &destination);
    if result.is_err()
        && let Some(quarantine) = &quarantine
        && !destination.exists()
    {
        let _ = fs::rename(quarantine, &destination);
    }
    if result.is_ok()
        && let Some(quarantine) = quarantine
    {
        let _ = fs::remove_file(quarantine);
    }
    result
}

fn quarantine_invalid_entry(
    root: &Path,
    revision: u64,
    destination: &Path,
) -> Result<Option<PathBuf>, CompatibilityError> {
    let quarantine = root.join(format!(
        ".{CACHE_PREFIX}{revision:020}-{}.corrupt",
        uuid::Uuid::new_v4().simple()
    ));
    fs::rename(destination, &quarantine).map_err(cache_error)?;
    Ok(Some(quarantine))
}

fn write_new_cache_entry(
    root: &Path,
    revision: u64,
    token: &str,
    destination: &Path,
) -> Result<(), CompatibilityError> {
    let temp = root.join(format!(
        ".{CACHE_PREFIX}{revision:020}-{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(cache_error)?;
        file.write_all(token.as_bytes()).map_err(cache_error)?;
        file.sync_all().map_err(cache_error)?;
        drop(file);
        fs::rename(&temp, destination).map_err(cache_error)?;
        sync_cache_directory(root)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(unix)]
fn sync_cache_directory(path: &Path) -> Result<(), CompatibilityError> {
    File::open(path)
        .map_err(cache_error)?
        .sync_all()
        .map_err(cache_error)
}

#[cfg(not(unix))]
fn sync_cache_directory(_path: &Path) -> Result<(), CompatibilityError> {
    Ok(())
}

fn cache_entry_path(root: &Path, revision: u64) -> PathBuf {
    root.join(format!("{CACHE_PREFIX}{revision:020}{CACHE_SUFFIX}"))
}

fn prune_cache(root: &Path, verifier: &CompatibilityVerifier, now_unix: i64) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let mut entries = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let revision = cache_revision(&entry.file_name().to_string_lossy())?;
            let path = entry.path();
            let verified = read_bounded(&path)
                .ok()
                .and_then(|bytes| String::from_utf8(bytes).ok())
                .and_then(|token| verifier.verify(&token, now_unix, TimeMode::Cached).ok())
                .is_some_and(|policy| policy.compiled.document.revision == revision);
            if verified {
                Some((revision, path))
            } else {
                let _ = fs::remove_file(path);
                None
            }
        })
        .collect::<Vec<_>>();
    entries.sort_unstable_by_key(|entry| std::cmp::Reverse(entry.0));
    for (_, path) in entries.into_iter().skip(CACHE_RETAINED_ENTRIES) {
        let _ = fs::remove_file(path);
    }
}

fn cache_revision(name: &str) -> Option<u64> {
    let revision = name
        .strip_prefix(CACHE_PREFIX)?
        .strip_suffix(CACHE_SUFFIX)?;
    (revision.len() == 20 && revision.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| revision.parse().ok())
        .flatten()
}

fn read_bounded(path: &Path) -> Result<Vec<u8>, CompatibilityError> {
    let metadata = fs::symlink_metadata(path).map_err(cache_error)?;
    if !metadata.is_file()
        || is_link_or_reparse(&metadata)
        || metadata.len() > MAX_TOKEN_BYTES as u64
    {
        return Err(CompatibilityError::Cache(
            "cache entry is not a bounded ordinary file".to_owned(),
        ));
    }
    let mut file = open_cache_read_file(path)?;
    let opened = file.metadata().map_err(cache_error)?;
    if !opened.is_file() || opened.len() > MAX_TOKEN_BYTES as u64 {
        return Err(CompatibilityError::Cache(
            "cache entry is not a bounded ordinary file".to_owned(),
        ));
    }
    let mut bytes = Vec::with_capacity(usize::try_from(opened.len()).unwrap_or(0));
    std::io::Read::by_ref(&mut file)
        .take(MAX_TOKEN_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(cache_error)?;
    if bytes.len() > MAX_TOKEN_BYTES {
        return Err(CompatibilityError::Cache(
            "cache entry is not a bounded ordinary file".to_owned(),
        ));
    }
    Ok(bytes)
}

#[cfg(unix)]
fn open_cache_read_file(path: &Path) -> Result<File, CompatibilityError> {
    use std::os::unix::fs::OpenOptionsExt as _;

    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(cache_error)
}

#[cfg(windows)]
fn open_cache_read_file(path: &Path) -> Result<File, CompatibilityError> {
    use std::os::windows::fs::OpenOptionsExt as _;

    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(cache_error)
}

#[cfg(not(any(unix, windows)))]
fn open_cache_read_file(path: &Path) -> Result<File, CompatibilityError> {
    File::open(path).map_err(cache_error)
}

fn cache_error(error: std::io::Error) -> CompatibilityError {
    CompatibilityError::Cache(error.to_string())
}

fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt as _;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn parse_version(value: &str) -> Result<Version, CompatibilityError> {
    if value.is_empty() || value.len() > MAX_VERSION_EXPRESSION_BYTES {
        return Err(CompatibilityError::InvalidDocument);
    }
    Version::parse(value).map_err(|_| CompatibilityError::InvalidDocument)
}

fn parse_requirement(value: &str) -> Result<VersionReq, CompatibilityError> {
    if value.is_empty()
        || value.len() > MAX_VERSION_EXPRESSION_BYTES
        || value.bytes().any(|byte| byte.is_ascii_whitespace())
        || value.contains(['*', 'x', 'X', '+'])
        || !(1..=8).contains(&value.split(',').count())
        || !value.split(',').all(|comparator| {
            [">=", "<=", ">", "<", "=", "~", "^"]
                .iter()
                .find_map(|prefix| comparator.strip_prefix(prefix))
                .and_then(|version| Version::parse(version).ok())
                .is_some_and(|version| version.build.is_empty())
        })
    {
        return Err(CompatibilityError::InvalidDocument);
    }
    VersionReq::parse(value).map_err(|_| CompatibilityError::InvalidDocument)
}

fn valid_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_TOKEN_NAME_BYTES
        && value.as_bytes()[0].is_ascii_lowercase()
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
        })
}

fn valid_feature_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_FEATURE_NAME_BYTES
        && value.as_bytes()[0].is_ascii_lowercase()
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
        })
}

fn valid_reason(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_REASON_BYTES
        && value.as_bytes()[0].is_ascii_lowercase()
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
        })
}

fn decode_base64url(value: &str) -> Option<Vec<u8>> {
    let decoded = URL_SAFE_NO_PAD.decode(value).ok()?;
    (URL_SAFE_NO_PAD.encode(&decoded) == value).then_some(decoded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use ed25519_dalek::{Signer as _, SigningKey};
    use serde_json::{Value, json};
    use std::collections::{BTreeMap, BTreeSet};

    const NOW: i64 = 1_790_000_000;
    const KID: &str = "component-2026-1";

    fn key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    fn verifier(key: &SigningKey) -> CompatibilityVerifier {
        let encoded = URL_SAFE_NO_PAD.encode(key.verifying_key().as_bytes());
        CompatibilityVerifier::from_keys([(KID, encoded.as_str())]).expect("valid key")
    }

    fn header(typ: &str) -> Value {
        json!({ "alg": "EdDSA", "typ": typ, "kid": KID })
    }

    fn policy(revision: u64) -> Value {
        json!({
            "schemaVersion": 1,
            "revision": revision,
            "issuedAt": NOW - 60,
            "expiresAt": NOW + 86_400,
            "keyId": KID,
            "providers": [{
                "provider": "codex",
                "stableFloor": "0.160.0",
                "testedVersions": ["0.160.0", "0.161.0"],
                "knownBad": [{
                    "versions": "=0.162.2",
                    "reason": "codex-0.162.2-session-regression"
                }],
                "protocolConstraints": [{
                    "cliVersions": ">=0.160.0",
                    "protocol": "session",
                    "protocolVersions": ">=1.0.0,<2.0.0"
                }],
                "capabilityDisables": [{
                    "cliVersions": ">=0.161.0,<0.162.0",
                    "capabilities": ["structured_output"]
                }]
            }]
        })
    }

    fn sign(key: &SigningKey, header: &Value, body: &Value) -> String {
        let encoded_header = URL_SAFE_NO_PAD.encode(header.to_string());
        let encoded_body = URL_SAFE_NO_PAD.encode(body.to_string());
        let signing_input = format!("{encoded_header}.{encoded_body}");
        let signature = key.sign(signing_input.as_bytes());
        format!(
            "{signing_input}.{}",
            URL_SAFE_NO_PAD.encode(signature.to_bytes())
        )
    }

    fn facts() -> ProbeFacts {
        ProbeFacts {
            capabilities: BTreeSet::from([
                "managed_profiles".to_owned(),
                "sessions".to_owned(),
                "structured_output".to_owned(),
            ]),
            protocols: BTreeMap::from([("session".to_owned(), "1.2.0".to_owned())]),
        }
    }

    fn open_store(root: &std::path::Path, key: &SigningKey) -> CompatibilityStore {
        CompatibilityStore::open(root, verifier(key), NOW).expect("store opens")
    }

    #[test]
    fn verifies_domain_separated_policy_and_disables_only_probed_capabilities() {
        let signing_key = key(7);
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(dir.path(), &signing_key);
        store
            .refresh(&sign(&signing_key, &header(TOKEN_TYPE), &policy(4)), NOW)
            .unwrap();

        let decision = store.evaluate("codex", "0.161.0", &facts()).unwrap();
        assert_eq!(
            decision.status,
            CompatibilityStatus::Usable { tested: true }
        );
        assert_eq!(decision.policy_revision, Some(4));
        assert!(decision.effective_capabilities.contains("sessions"));
        assert!(
            !decision
                .effective_capabilities
                .contains("structured_output")
        );
        assert_eq!(
            decision.disabled_by_policy,
            BTreeSet::from(["structured_output".to_owned()])
        );

        let future_stable = store.evaluate("codex", "0.170.0", &facts()).unwrap();
        assert_eq!(
            future_stable.status,
            CompatibilityStatus::Usable { tested: false },
            "an unknown newer stable CLI remains governed by its local capability probes"
        );
    }

    #[test]
    fn rejects_tamper_wrong_key_wrong_domain_and_unknown_fields() {
        let signing_key = key(7);
        let foreign_key = key(9);
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(dir.path(), &signing_key);
        let good = sign(&signing_key, &header(TOKEN_TYPE), &policy(1));

        let mut tampered = good.clone().into_bytes();
        let index = tampered.len() / 2;
        tampered[index] = if tampered[index] == b'a' { b'b' } else { b'a' };
        let tampered = String::from_utf8(tampered).unwrap();
        assert!(matches!(
            store.refresh(&tampered, NOW),
            Err(CompatibilityError::BadSignature | CompatibilityError::InvalidDocument)
        ));
        assert_eq!(
            store.refresh(&sign(&foreign_key, &header(TOKEN_TYPE), &policy(1)), NOW),
            Err(CompatibilityError::BadSignature)
        );
        assert_eq!(
            store.refresh(
                &sign(
                    &signing_key,
                    &header("kalcode-local-component.v1"),
                    &policy(1)
                ),
                NOW
            ),
            Err(CompatibilityError::UnsupportedHeader)
        );
        let mut extra = policy(1);
        extra["script"] = json!("run-me");
        assert_eq!(
            store.refresh(&sign(&signing_key, &header(TOKEN_TYPE), &extra), NOW),
            Err(CompatibilityError::InvalidDocument)
        );
    }

    #[test]
    fn known_bad_floor_and_protocol_constraints_are_declarative_denials() {
        let signing_key = key(7);
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(dir.path(), &signing_key);
        store
            .refresh(&sign(&signing_key, &header(TOKEN_TYPE), &policy(1)), NOW)
            .unwrap();

        assert!(matches!(
            store.evaluate("codex", "0.162.2", &facts()).unwrap().status,
            CompatibilityStatus::KnownBad { .. }
        ));
        assert!(matches!(
            store.evaluate("codex", "0.159.9", &facts()).unwrap().status,
            CompatibilityStatus::BelowStableFloor { .. }
        ));
        let mut missing_protocol = facts();
        missing_protocol.protocols.clear();
        assert!(matches!(
            store
                .evaluate("codex", "0.161.0", &missing_protocol)
                .unwrap()
                .status,
            CompatibilityStatus::ProtocolIncompatible { .. }
        ));
    }

    #[test]
    fn empty_or_unknown_policy_never_blocks_primary_local_probes() {
        let signing_key = key(7);
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(dir.path(), &signing_key);

        for provider in ["codex", "future_cli"] {
            let decision = store.evaluate(provider, "99.1.0", &facts()).unwrap();
            assert_eq!(
                decision.status,
                CompatibilityStatus::Usable { tested: false }
            );
            assert_eq!(decision.effective_capabilities, facts().capabilities);
            assert_eq!(decision.policy_revision, None);
        }
    }

    #[test]
    fn newer_signed_revision_can_revert_rules_but_older_revision_is_rejected() {
        let signing_key = key(7);
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(dir.path(), &signing_key);
        let token4 = sign(&signing_key, &header(TOKEN_TYPE), &policy(4));
        store.refresh(&token4, NOW).unwrap();
        assert_eq!(
            store.refresh(&sign(&signing_key, &header(TOKEN_TYPE), &policy(3)), NOW),
            Err(CompatibilityError::RevisionRollback {
                current: 4,
                candidate: 3
            })
        );

        let mut reverted = policy(5);
        reverted["providers"][0]["knownBad"] = json!([]);
        store
            .refresh(&sign(&signing_key, &header(TOKEN_TYPE), &reverted), NOW)
            .unwrap();
        assert_eq!(
            store.evaluate("codex", "0.162.2", &facts()).unwrap().status,
            CompatibilityStatus::Usable { tested: false }
        );
    }

    #[test]
    fn offline_reopen_uses_verified_cache_and_recovers_from_corrupt_newest_entry() {
        let signing_key = key(7);
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(dir.path(), &signing_key);
        store
            .refresh(&sign(&signing_key, &header(TOKEN_TYPE), &policy(7)), NOW)
            .unwrap();
        let token8 = sign(&signing_key, &header(TOKEN_TYPE), &policy(8));
        store.refresh(&token8, NOW).unwrap();
        drop(store);

        let reopened = open_store(dir.path(), &signing_key);
        assert_eq!(reopened.cached_snapshot().revision(), Some(8));

        std::fs::write(reopened.cache_entry_path_for_test(8), b"corrupt").unwrap();
        drop(reopened);
        let recovered = open_store(dir.path(), &signing_key);
        assert_eq!(recovered.cached_snapshot().revision(), Some(7));
        assert!(
            recovered.cached_snapshot().recovered_from_invalid_cache(),
            "diagnostics retain the silent last-known-good recovery fact"
        );
        assert_eq!(
            recovered
                .evaluate("codex", "0.161.0", &facts())
                .unwrap()
                .status,
            CompatibilityStatus::Usable { tested: true }
        );

        recovered
            .refresh(&token8, NOW)
            .expect("a freshly verified download replaces only the corrupt same-revision entry");
        assert_eq!(recovered.cached_snapshot().revision(), Some(8));
    }

    #[test]
    fn malformed_versions_tokens_and_expired_new_documents_fail_closed() {
        let signing_key = key(7);
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(dir.path(), &signing_key);
        assert_eq!(
            store.refresh("not-a-token", NOW),
            Err(CompatibilityError::MalformedToken)
        );
        assert_eq!(
            store.evaluate("codex", "version-next", &facts()),
            Err(CompatibilityError::InvalidVersion)
        );
        let mut malformed = policy(1);
        malformed["providers"][0]["knownBad"][0]["versions"] = json!("not semver");
        assert_eq!(
            store.refresh(&sign(&signing_key, &header(TOKEN_TYPE), &malformed), NOW),
            Err(CompatibilityError::InvalidDocument)
        );
        let mut expired = policy(1);
        expired["expiresAt"] = json!(NOW - 1);
        assert_eq!(
            store.refresh(&sign(&signing_key, &header(TOKEN_TYPE), &expired), NOW),
            Err(CompatibilityError::Expired)
        );
    }

    #[test]
    fn separate_store_instances_cannot_race_a_revision_rollback() {
        let signing_key = key(7);
        let dir = tempfile::tempdir().unwrap();
        let first = open_store(dir.path(), &signing_key);
        let stale = open_store(dir.path(), &signing_key);
        first
            .refresh(&sign(&signing_key, &header(TOKEN_TYPE), &policy(12)), NOW)
            .unwrap();

        assert_eq!(
            stale.refresh(&sign(&signing_key, &header(TOKEN_TYPE), &policy(11)), NOW),
            Err(CompatibilityError::RevisionRollback {
                current: 12,
                candidate: 11
            })
        );
    }

    #[test]
    fn active_store_is_process_wide_and_unconfigured_state_is_permissive() {
        clear_active_store_for_test();
        let unconfigured = evaluate_active("codex", "0.161.0", &facts()).unwrap();
        assert_eq!(
            unconfigured.status,
            CompatibilityStatus::Usable { tested: false }
        );

        let signing_key = key(7);
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(dir.path(), &signing_key);
        store
            .refresh(&sign(&signing_key, &header(TOKEN_TYPE), &policy(14)), NOW)
            .unwrap();
        set_active_store(store);
        assert_eq!(active_snapshot().revision(), Some(14));
        assert_eq!(
            evaluate_active("codex", "0.162.2", &facts())
                .unwrap()
                .status,
            CompatibilityStatus::KnownBad {
                reason: "codex-0.162.2-session-regression".to_owned()
            }
        );
        clear_active_store_for_test();
    }

    #[test]
    fn accepted_policy_cache_retains_a_bounded_recovery_window() {
        let signing_key = key(7);
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(dir.path(), &signing_key);
        for revision in 1..=12 {
            store
                .refresh(
                    &sign(&signing_key, &header(TOKEN_TYPE), &policy(revision)),
                    NOW,
                )
                .unwrap();
        }
        let retained = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| cache_revision(&entry.file_name().to_string_lossy()).is_some())
            .count();
        assert_eq!(retained, CACHE_RETAINED_ENTRIES);
        assert_eq!(
            open_store(dir.path(), &signing_key)
                .cached_snapshot()
                .revision(),
            Some(12)
        );
    }
}
