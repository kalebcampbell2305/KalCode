//! KalCode update policy. Network transport and installer execution live in the desktop shell;
//! this crate owns the fail-closed channel, manifest, download, lifecycle, and recovery rules.

use std::collections::BTreeMap;
use std::fmt::{Display, Formatter};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::str::FromStr;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use minisign_verify::{PublicKey, Signature};
use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use url::Url;

pub mod mac_swap;

pub const MAX_UPDATE_BYTES: u64 = 512 * 1024 * 1024;
/// Authoritative updater JSON is intentionally tiny. Bound reads before allocating so a damaged
/// or locally replaced state file cannot exhaust memory during startup.
pub const MAX_UPDATE_STATE_BYTES: u64 = 64 * 1024;
const LEGACY_JOURNAL_SCHEMA_VERSION: u8 = 1;
const JOURNAL_SCHEMA_VERSION: u8 = 2;
const ROLLBACK_RECEIPT_SCHEMA_VERSION_V1: u8 = 1;
const ROLLBACK_RECEIPT_SCHEMA_VERSION_V2: u8 = 2;
const MAX_PUBLIC_KEY_BASE64_BYTES: usize = 4 * 1024;
const MAX_SIGNATURE_BASE64_BYTES: usize = 16 * 1024;
const MAX_ATTEMPT_IDENTITY_BYTES: usize = 512;
const FORWARD_ONLY_MAC_FENCE_SUFFIX: &str = "|forward-only-schema-upgrade";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    #[default]
    Stable,
    Beta,
    Dev,
}

impl UpdateChannel {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Beta => "beta",
            Self::Dev => "dev",
        }
    }

    #[must_use]
    pub const fn endpoint(self) -> &'static str {
        match self {
            Self::Stable => "https://kalcoded.com/releases/updater/stable.json",
            Self::Beta => "https://kalcoded.com/releases/updater/beta.json",
            Self::Dev => "https://kalcoded.com/releases/updater/dev.json",
        }
    }
}

impl Display for UpdateChannel {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for UpdateChannel {
    type Err = UpdateError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "stable" => Ok(Self::Stable),
            "beta" => Ok(Self::Beta),
            "dev" => Ok(Self::Dev),
            _ => Err(UpdateError::new(
                "update_channel_invalid",
                "Choose Stable, Beta, or Dev.",
            )),
        }
    }
}

/// Exact release target IDs used by both the public updater descriptor and the native client.
/// A target is always selected before download; callers must never fall back to another entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum UpdateTarget {
    #[serde(rename = "windows-x86_64")]
    WindowsX86_64,
    #[serde(rename = "darwin-aarch64")]
    DarwinAarch64,
}

impl UpdateTarget {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::WindowsX86_64 => "windows-x86_64",
            Self::DarwinAarch64 => "darwin-aarch64",
        }
    }

    pub fn current() -> Result<Self, UpdateError> {
        #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
        {
            return Ok(Self::WindowsX86_64);
        }
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        {
            return Ok(Self::DarwinAarch64);
        }
        #[allow(unreachable_code)]
        Err(UpdateError::new(
            "update_target_unsupported",
            "Automatic updates aren't available for this platform.",
        ))
    }
}

impl Display for UpdateTarget {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for UpdateTarget {
    type Err = UpdateError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "windows-x86_64" => Ok(Self::WindowsX86_64),
            "darwin-aarch64" => Ok(Self::DarwinAarch64),
            _ => Err(UpdateError::invalid_manifest("target")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArtifactFormat {
    Nsis,
    Dmg,
}

impl ArtifactFormat {
    #[must_use]
    pub const fn supports(self, target: UpdateTarget) -> bool {
        matches!(
            (self, target),
            (Self::Nsis, UpdateTarget::WindowsX86_64) | (Self::Dmg, UpdateTarget::DarwinAarch64)
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateError {
    code: &'static str,
    message: &'static str,
}

impl UpdateError {
    #[must_use]
    pub const fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }

    #[must_use]
    pub const fn code(&self) -> &'static str {
        self.code
    }

    #[must_use]
    pub fn invalid_manifest(_private_detail: impl AsRef<str>) -> Self {
        Self::new("update_manifest_invalid", "The update feed is invalid.")
    }

    fn io(_error: &std::io::Error) -> Self {
        Self::new(
            "update_state_unavailable",
            "KalCode couldn't save its update state.",
        )
    }
}

impl Display for UpdateError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for UpdateError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeedMetadata {
    pub schema_version: u8,
    pub channel: UpdateChannel,
    pub target: UpdateTarget,
    pub format: ArtifactFormat,
    pub size: u64,
    pub sha256: String,
    pub commit: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawFeedMetadataV1 {
    schema_version: u8,
    channel: UpdateChannel,
    size: u64,
    sha256: String,
    commit: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawFeedMetadataV2 {
    schema_version: u8,
    channel: UpdateChannel,
    commit: String,
    artifacts: BTreeMap<String, RawArtifactMetadata>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawArtifactMetadata {
    target: UpdateTarget,
    format: ArtifactFormat,
    size: u64,
    sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Candidate {
    pub version: String,
    pub notes: Option<String>,
    pub metadata: FeedMetadata,
}

fn exact_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn parse_version(value: &str) -> Result<Version, UpdateError> {
    Version::parse(value.trim_start_matches('v'))
        .map_err(|_| UpdateError::invalid_manifest("version"))
}

fn validate_download_url(value: &str) -> Result<(), UpdateError> {
    let url = Url::parse(value).map_err(|_| {
        UpdateError::new(
            "update_url_not_allowed",
            "The update feed returned an untrusted download address.",
        )
    })?;
    let trusted = url.scheme() == "https"
        && url.host_str() == Some("kalcoded.com")
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && url.query().is_none()
        && url.path().starts_with("/releases/updater/");
    if trusted {
        Ok(())
    } else {
        Err(UpdateError::new(
            "update_url_not_allowed",
            "The update feed returned an untrusted download address.",
        ))
    }
}

/// Validates the unsigned feed fields before the signed artifact is downloaded. Artifact bytes
/// still require the updater signature and [`verify_download`] before they become installable.
pub fn validate_candidate(
    selected_channel: UpdateChannel,
    current_version: &str,
    announced_version: &str,
    download_url: &str,
    raw_manifest: &Value,
) -> Result<Candidate, UpdateError> {
    validate_candidate_for_target(
        UpdateTarget::WindowsX86_64,
        selected_channel,
        current_version,
        announced_version,
        download_url,
        raw_manifest,
    )
}

/// Validates and selects only the artifact for `target`. Schema v1 is intentionally retained as
/// Windows-only compatibility; schema v2 never falls back to an artifact for another platform.
pub fn validate_candidate_for_target(
    target: UpdateTarget,
    selected_channel: UpdateChannel,
    current_version: &str,
    announced_version: &str,
    download_url: &str,
    raw_manifest: &Value,
) -> Result<Candidate, UpdateError> {
    validate_download_url(download_url)?;
    let current = parse_version(current_version)?;
    let announced = parse_version(announced_version)?;
    if announced <= current {
        return Err(UpdateError::new(
            "update_not_newer",
            "The update is not newer than this build.",
        ));
    }
    if selected_channel == UpdateChannel::Stable && !announced.pre.is_empty() {
        return Err(UpdateError::new(
            "prerelease_on_stable",
            "A preview build cannot be installed from Stable.",
        ));
    }
    let metadata = validate_feed_metadata(target, selected_channel, raw_manifest)?;
    Ok(Candidate {
        version: announced.to_string(),
        notes: None,
        metadata,
    })
}

/// Validates the signed installer retained as the one-version recovery baseline. Recovery
/// baselines are stable-only and must match the running version exactly.
pub fn validate_retained_candidate(
    expected_version: &str,
    announced_version: &str,
    download_url: &str,
    raw_manifest: &Value,
) -> Result<Candidate, UpdateError> {
    validate_retained_candidate_for_target(
        UpdateTarget::WindowsX86_64,
        expected_version,
        announced_version,
        download_url,
        raw_manifest,
    )
}

pub fn validate_retained_candidate_for_target(
    target: UpdateTarget,
    expected_version: &str,
    announced_version: &str,
    download_url: &str,
    raw_manifest: &Value,
) -> Result<Candidate, UpdateError> {
    validate_download_url(download_url)?;
    let expected = parse_version(expected_version)?;
    let announced = parse_version(announced_version)?;
    if !expected.pre.is_empty() || !announced.pre.is_empty() {
        return Err(UpdateError::new(
            "rollback_not_stable",
            "Only a stable build can be retained for recovery.",
        ));
    }
    if expected != announced {
        return Err(UpdateError::new(
            "rollback_version_mismatch",
            "The recovery package does not match this version.",
        ));
    }
    Ok(Candidate {
        version: announced.to_string(),
        notes: None,
        metadata: validate_feed_metadata(target, UpdateChannel::Stable, raw_manifest)?,
    })
}

fn validate_feed_metadata(
    target: UpdateTarget,
    selected_channel: UpdateChannel,
    raw_manifest: &Value,
) -> Result<FeedMetadata, UpdateError> {
    let metadata = raw_manifest
        .get("kalcode")
        .cloned()
        .ok_or_else(|| UpdateError::invalid_manifest("missing kalcode metadata"))?;
    let schema_version = metadata
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| UpdateError::invalid_manifest("schema version"))?;
    match schema_version {
        1 => validate_feed_metadata_v1(target, selected_channel, metadata),
        2 => validate_feed_metadata_v2(target, selected_channel, metadata),
        _ => Err(UpdateError::invalid_manifest("schema version")),
    }
}

fn validate_feed_metadata_v1(
    target: UpdateTarget,
    selected_channel: UpdateChannel,
    metadata: Value,
) -> Result<FeedMetadata, UpdateError> {
    if target != UpdateTarget::WindowsX86_64 {
        return Err(UpdateError::new(
            "update_target_mismatch",
            "The update feed returned a build for another platform.",
        ));
    }
    let raw: RawFeedMetadataV1 = serde_json::from_value(metadata)
        .map_err(|_| UpdateError::invalid_manifest("kalcode metadata"))?;
    validate_common_metadata(
        raw.schema_version,
        raw.channel,
        selected_channel,
        raw.size,
        &raw.sha256,
        &raw.commit,
    )?;
    Ok(FeedMetadata {
        schema_version: 1,
        channel: raw.channel,
        target,
        format: ArtifactFormat::Nsis,
        size: raw.size,
        sha256: raw.sha256,
        commit: raw.commit,
    })
}

fn validate_feed_metadata_v2(
    target: UpdateTarget,
    selected_channel: UpdateChannel,
    metadata: Value,
) -> Result<FeedMetadata, UpdateError> {
    let raw: RawFeedMetadataV2 = serde_json::from_value(metadata)
        .map_err(|_| UpdateError::invalid_manifest("kalcode metadata"))?;
    if raw.schema_version != 2 || !exact_lower_hex(&raw.commit, 40) || raw.artifacts.is_empty() {
        return Err(UpdateError::invalid_manifest("metadata values"));
    }
    if raw.artifacts.len() > 2 {
        return Err(UpdateError::invalid_manifest("artifact count"));
    }
    if raw.channel != selected_channel {
        return Err(UpdateError::new(
            "update_channel_mismatch",
            "The update feed returned a build from another channel.",
        ));
    }
    for (key, artifact) in &raw.artifacts {
        let key_target = UpdateTarget::from_str(key)?;
        if artifact.target != key_target {
            return Err(UpdateError::new(
                "update_target_mismatch",
                "The update feed returned a build for another platform.",
            ));
        }
        if !artifact.format.supports(key_target) {
            return Err(UpdateError::invalid_manifest("artifact format"));
        }
    }
    let artifact = raw.artifacts.get(target.as_str()).ok_or_else(|| {
        UpdateError::new(
            "update_target_unavailable",
            "No update is available for this platform.",
        )
    })?;
    validate_common_metadata(
        raw.schema_version,
        raw.channel,
        selected_channel,
        artifact.size,
        &artifact.sha256,
        &raw.commit,
    )?;
    Ok(FeedMetadata {
        schema_version: 2,
        channel: raw.channel,
        target,
        format: artifact.format,
        size: artifact.size,
        sha256: artifact.sha256.clone(),
        commit: raw.commit,
    })
}

fn validate_common_metadata(
    schema_version: u8,
    channel: UpdateChannel,
    selected_channel: UpdateChannel,
    size: u64,
    sha256: &str,
    commit: &str,
) -> Result<(), UpdateError> {
    if !matches!(schema_version, 1 | 2)
        || !exact_lower_hex(sha256, 64)
        || !exact_lower_hex(commit, 40)
        || size == 0
    {
        return Err(UpdateError::invalid_manifest("metadata values"));
    }
    if channel != selected_channel {
        return Err(UpdateError::new(
            "update_channel_mismatch",
            "The update feed returned a build from another channel.",
        ));
    }
    if size > MAX_UPDATE_BYTES {
        return Err(UpdateError::new(
            "update_too_large",
            "The update is larger than KalCode's safety limit.",
        ));
    }
    Ok(())
}

pub fn verify_download(bytes: &[u8], metadata: &FeedMetadata) -> Result<(), UpdateError> {
    if bytes.len() as u64 != metadata.size {
        return Err(UpdateError::new(
            "update_size_mismatch",
            "The downloaded update has the wrong size.",
        ));
    }
    let actual = hex::encode(Sha256::digest(bytes));
    if actual != metadata.sha256 {
        return Err(UpdateError::new(
            "update_checksum_mismatch",
            "The downloaded update failed its checksum.",
        ));
    }
    Ok(())
}

/// Re-verifies prepared bytes through their held file object before launch. This prevents a path
/// swap between the in-memory signature check and execution.
pub fn verify_download_reader(
    reader: &mut impl Read,
    metadata: &FeedMetadata,
) -> Result<(), UpdateError> {
    let mut hasher = Sha256::new();
    let mut length = 0_u64;
    let mut buffer = vec![0_u8; 1 << 20];
    loop {
        let read = reader.read(&mut buffer).map_err(|_| {
            UpdateError::new(
                "update_installer_storage_failed",
                "KalCode couldn't safely prepare the update installer.",
            )
        })?;
        if read == 0 {
            break;
        }
        length = length.checked_add(read as u64).ok_or_else(|| {
            UpdateError::new(
                "update_too_large",
                "The update exceeded KalCode's safety limit.",
            )
        })?;
        if length > MAX_UPDATE_BYTES || length > metadata.size {
            return Err(UpdateError::new(
                "update_size_mismatch",
                "The downloaded update has the wrong size.",
            ));
        }
        hasher.update(&buffer[..read]);
    }
    if length != metadata.size || hex::encode(hasher.finalize()) != metadata.sha256 {
        return Err(UpdateError::new(
            "update_checksum_mismatch",
            "The downloaded update failed its checksum.",
        ));
    }
    Ok(())
}

fn decode_updater_signature(
    signature_base64: &str,
    public_key_base64: &str,
    expected_version: &str,
    expected_binding: Option<(UpdateTarget, UpdateChannel)>,
) -> Result<(PublicKey, Signature), UpdateError> {
    if public_key_base64.is_empty()
        || public_key_base64.len() > MAX_PUBLIC_KEY_BASE64_BYTES
        || signature_base64.is_empty()
        || signature_base64.len() > MAX_SIGNATURE_BASE64_BYTES
    {
        return Err(UpdateError::new(
            "update_signature_invalid",
            "The update signature is invalid.",
        ));
    }
    let public_key_text = STANDARD
        .decode(public_key_base64)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .ok_or_else(|| {
            UpdateError::new(
                "update_signature_invalid",
                "The update signature is invalid.",
            )
        })?;
    let signature_text = STANDARD
        .decode(signature_base64)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .ok_or_else(|| {
            UpdateError::new(
                "update_signature_invalid",
                "The update signature is invalid.",
            )
        })?;
    let public_key = PublicKey::decode(&public_key_text).map_err(|_| {
        UpdateError::new(
            "update_signature_invalid",
            "The update signature is invalid.",
        )
    })?;
    let signature = Signature::decode(&signature_text).map_err(|_| {
        UpdateError::new(
            "update_signature_invalid",
            "The update signature is invalid.",
        )
    })?;
    let trusted_fields = signature.trusted_comment().split('\t').collect::<Vec<_>>();
    let signed_versions = trusted_fields
        .iter()
        .filter_map(|field| field.strip_prefix("version:"))
        .collect::<Vec<_>>();
    if signed_versions.as_slice() != [expected_version] {
        return Err(UpdateError::new(
            "update_signature_version_mismatch",
            "The update signature does not match this version.",
        ));
    }
    if let Some((expected_target, expected_channel)) = expected_binding {
        let canonical_identity = match trusted_fields.as_slice() {
            [
                timestamp_field,
                file_field,
                version_field,
                target_field,
                _channel_field,
            ] => {
                let timestamp = timestamp_field.strip_prefix("timestamp:");
                let file = file_field.strip_prefix("file:");
                let version = version_field.strip_prefix("version:");
                let target = target_field.strip_prefix("target:");
                timestamp.is_some_and(|value| {
                    value.len() >= 10
                        && !value.starts_with('0')
                        && value.bytes().all(|byte| byte.is_ascii_digit())
                }) && file.is_some_and(|value| {
                    !value.is_empty()
                        && value.len() <= 128
                        && !value.contains("..")
                        && value.bytes().all(|byte| {
                            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')
                        })
                }) && version == Some(expected_version)
                    && target == Some(expected_target.as_str())
            }
            _ => false,
        };
        if !canonical_identity {
            return Err(UpdateError::new(
                "update_signature_target_mismatch",
                "The update signature does not match this platform.",
            ));
        }
        let signed_channel = trusted_fields[4].strip_prefix("channel:");
        if signed_channel != Some(expected_channel.as_str()) {
            return Err(UpdateError::new(
                "update_signature_channel_mismatch",
                "The update signature does not match this update channel.",
            ));
        }
    }
    Ok((public_key, signature))
}

/// Verifies the Tauri updater signature and binds its trusted comment to the exact release
/// version. This signature is independent from the Windows Authenticode signature.
pub fn verify_updater_signature(
    bytes: &[u8],
    signature_base64: &str,
    public_key_base64: &str,
    expected_version: &str,
) -> Result<(), UpdateError> {
    let (public_key, signature) =
        decode_updater_signature(signature_base64, public_key_base64, expected_version, None)?;
    public_key.verify(bytes, &signature, false).map_err(|_| {
        UpdateError::new(
            "update_signature_invalid",
            "The update signature is invalid.",
        )
    })
}

/// Verifies schema-v2 artifact bytes and binds the Minisign trusted comment to the release
/// version, exact selected target, and exact channel. This does not alter schema-v1 Windows
/// verification.
pub fn verify_updater_signature_for_target_and_channel(
    bytes: &[u8],
    signature_base64: &str,
    public_key_base64: &str,
    expected_version: &str,
    expected_target: UpdateTarget,
    expected_channel: UpdateChannel,
) -> Result<(), UpdateError> {
    let (public_key, signature) = decode_updater_signature(
        signature_base64,
        public_key_base64,
        expected_version,
        Some((expected_target, expected_channel)),
    )?;
    public_key.verify(bytes, &signature, false).map_err(|_| {
        UpdateError::new(
            "update_signature_invalid",
            "The update signature is invalid.",
        )
    })
}

pub fn verify_signature_for_metadata(
    bytes: &[u8],
    signature_base64: &str,
    public_key_base64: &str,
    expected_version: &str,
    metadata: &FeedMetadata,
) -> Result<(), UpdateError> {
    match metadata.schema_version {
        1 if metadata.target == UpdateTarget::WindowsX86_64
            && metadata.format == ArtifactFormat::Nsis =>
        {
            verify_updater_signature(bytes, signature_base64, public_key_base64, expected_version)
        }
        2 if metadata.format.supports(metadata.target) => {
            verify_updater_signature_for_target_and_channel(
                bytes,
                signature_base64,
                public_key_base64,
                expected_version,
                metadata.target,
                metadata.channel,
            )
        }
        _ => Err(UpdateError::invalid_manifest("signature metadata")),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RollbackReceipt {
    schema_version: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    target: Option<UpdateTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    format: Option<ArtifactFormat>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    channel: Option<UpdateChannel>,
    pub version: String,
    pub size: u64,
    pub sha256: String,
    pub commit: String,
    signature: String,
    artifact_file: String,
}

impl RollbackReceipt {
    #[must_use]
    pub fn signature(&self) -> &str {
        &self.signature
    }

    #[must_use]
    pub fn target(&self) -> UpdateTarget {
        self.target.unwrap_or(UpdateTarget::WindowsX86_64)
    }

    #[must_use]
    pub fn format(&self) -> ArtifactFormat {
        self.format.unwrap_or(ArtifactFormat::Nsis)
    }

    #[must_use]
    pub fn channel(&self) -> UpdateChannel {
        self.channel.unwrap_or(UpdateChannel::Stable)
    }

    #[must_use]
    pub const fn updater_schema_version(&self) -> u8 {
        if self.schema_version == ROLLBACK_RECEIPT_SCHEMA_VERSION_V1 {
            1
        } else {
            2
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryArtifact {
    path: PathBuf,
    receipt: RollbackReceipt,
}

impl RecoveryArtifact {
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    #[must_use]
    pub const fn receipt(&self) -> &RollbackReceipt {
        &self.receipt
    }
}

/// A one-version rollback cache. Packages are immutable and selected by a signed, atomically
/// replaced receipt. Every load rechecks the digest and updater signature before exposing a
/// recovery action.
#[derive(Debug, Clone)]
pub struct RollbackCache {
    root: PathBuf,
}

impl RollbackCache {
    #[must_use]
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn receipt_path(&self) -> PathBuf {
        self.root.join("rollback-receipt.json")
    }

    pub fn store_verified(
        &self,
        version: &str,
        bytes: &[u8],
        metadata: &FeedMetadata,
        signature_base64: &str,
        public_key_base64: &str,
    ) -> Result<RollbackReceipt, UpdateError> {
        let parsed_version = parse_version(version)?;
        if !parsed_version.pre.is_empty() || parsed_version.to_string() != version {
            return Err(UpdateError::new(
                "rollback_not_stable",
                "Only a stable build can be retained for recovery.",
            ));
        }
        if metadata.size == 0
            || metadata.size > MAX_UPDATE_BYTES
            || !exact_lower_hex(&metadata.sha256, 64)
            || !exact_lower_hex(&metadata.commit, 40)
            || !matches!(metadata.schema_version, 1 | 2)
            || !metadata.format.supports(metadata.target)
            || metadata.channel != UpdateChannel::Stable
        {
            return Err(UpdateError::new(
                "rollback_cache_invalid",
                "The recovery package is invalid.",
            ));
        }
        verify_download(bytes, metadata).map_err(|_| {
            UpdateError::new("rollback_cache_invalid", "The recovery package is invalid.")
        })?;
        verify_signature_for_metadata(
            bytes,
            signature_base64,
            public_key_base64,
            version,
            metadata,
        )?;

        fs::create_dir_all(&self.root).map_err(|error| UpdateError::io(&error))?;
        let artifact_file = format!("previous-{}.bin", metadata.sha256);
        let artifact_path = self.root.join(&artifact_file);
        if artifact_path.exists() {
            let existing = fs::read(&artifact_path).map_err(|error| UpdateError::io(&error))?;
            verify_download(&existing, metadata).map_err(|_| {
                UpdateError::new("rollback_cache_invalid", "The recovery package is invalid.")
            })?;
        } else {
            let artifact_next = self.root.join(format!("{artifact_file}.next"));
            if artifact_next.exists() {
                fs::remove_file(&artifact_next).map_err(|error| UpdateError::io(&error))?;
            }
            write_new_synced(&artifact_next, bytes)?;
            fs::rename(&artifact_next, &artifact_path).map_err(|error| UpdateError::io(&error))?;
        }

        let receipt = RollbackReceipt {
            schema_version: if metadata.schema_version == 1 {
                ROLLBACK_RECEIPT_SCHEMA_VERSION_V1
            } else {
                ROLLBACK_RECEIPT_SCHEMA_VERSION_V2
            },
            target: (metadata.schema_version == 2).then_some(metadata.target),
            format: (metadata.schema_version == 2).then_some(metadata.format),
            channel: (metadata.schema_version == 2).then_some(metadata.channel),
            version: version.to_owned(),
            size: metadata.size,
            sha256: metadata.sha256.clone(),
            commit: metadata.commit.clone(),
            signature: signature_base64.to_owned(),
            artifact_file,
        };
        replace_json_atomically(&self.receipt_path(), &receipt)?;
        self.remove_unreferenced_artifacts(&receipt.artifact_file)?;
        Ok(receipt)
    }

    pub fn load_verified(
        &self,
        public_key_base64: &str,
    ) -> Result<Option<RecoveryArtifact>, UpdateError> {
        let receipt_path = self.receipt_path();
        if !receipt_path.exists() {
            return Ok(None);
        }
        let receipt_bytes = read_bounded(&receipt_path, MAX_UPDATE_STATE_BYTES)
            .map_err(|_| rollback_cache_invalid())?;
        let receipt: RollbackReceipt =
            serde_json::from_slice(&receipt_bytes).map_err(|_| rollback_cache_invalid())?;
        let parsed_version =
            parse_version(&receipt.version).map_err(|_| rollback_cache_invalid())?;
        let expected_file = format!("previous-{}.bin", receipt.sha256);
        let receipt_shape_valid = match receipt.schema_version {
            ROLLBACK_RECEIPT_SCHEMA_VERSION_V1 => {
                receipt.target.is_none() && receipt.format.is_none() && receipt.channel.is_none()
            }
            ROLLBACK_RECEIPT_SCHEMA_VERSION_V2 => receipt
                .target
                .zip(receipt.format)
                .zip(receipt.channel)
                .is_some_and(|((target, format), channel)| {
                    format.supports(target) && channel == UpdateChannel::Stable
                }),
            _ => false,
        };
        if !receipt_shape_valid
            || !parsed_version.pre.is_empty()
            || parsed_version.to_string() != receipt.version
            || receipt.size == 0
            || receipt.size > MAX_UPDATE_BYTES
            || !exact_lower_hex(&receipt.sha256, 64)
            || !exact_lower_hex(&receipt.commit, 40)
            || receipt.artifact_file != expected_file
        {
            return Err(rollback_cache_invalid());
        }
        let path = self.root.join(&receipt.artifact_file);
        verify_cached_file(&path, &receipt, public_key_base64)?;
        Ok(Some(RecoveryArtifact { path, receipt }))
    }

    /// Loads recovery bytes only after a second integrity and signature check. This closes the
    /// verify-then-read gap for installer launchers that must hold the package in memory.
    pub fn load_bytes_verified(
        &self,
        public_key_base64: &str,
    ) -> Result<Option<(RecoveryArtifact, Vec<u8>)>, UpdateError> {
        let Some(artifact) = self.load_verified(public_key_base64)? else {
            return Ok(None);
        };
        let bytes = fs::read(artifact.path()).map_err(|_| rollback_cache_invalid())?;
        let metadata = FeedMetadata {
            schema_version: artifact.receipt.updater_schema_version(),
            channel: artifact.receipt.channel(),
            target: artifact.receipt.target(),
            format: artifact.receipt.format(),
            size: artifact.receipt.size,
            sha256: artifact.receipt.sha256.clone(),
            commit: artifact.receipt.commit.clone(),
        };
        verify_download(&bytes, &metadata).map_err(|_| rollback_cache_invalid())?;
        verify_signature_for_metadata(
            &bytes,
            &artifact.receipt.signature,
            public_key_base64,
            &artifact.receipt.version,
            &metadata,
        )
        .map_err(|_| rollback_cache_invalid())?;
        Ok(Some((artifact, bytes)))
    }

    fn remove_unreferenced_artifacts(&self, retained: &str) -> Result<(), UpdateError> {
        let entries = fs::read_dir(&self.root).map_err(|error| UpdateError::io(&error))?;
        for entry in entries {
            let entry = entry.map_err(|error| UpdateError::io(&error))?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if name != retained
                && name.starts_with("previous-")
                && (name.ends_with(".bin") || name.ends_with(".bin.next"))
            {
                fs::remove_file(entry.path()).map_err(|error| UpdateError::io(&error))?;
            }
        }
        Ok(())
    }
}

fn rollback_cache_invalid() -> UpdateError {
    UpdateError::new("rollback_cache_invalid", "The recovery package is invalid.")
}

fn verify_cached_file(
    path: &Path,
    receipt: &RollbackReceipt,
    public_key_base64: &str,
) -> Result<(), UpdateError> {
    let metadata = fs::metadata(path).map_err(|_| rollback_cache_invalid())?;
    if !metadata.is_file() || metadata.len() != receipt.size {
        return Err(rollback_cache_invalid());
    }
    let expected_binding =
        (receipt.updater_schema_version() == 2).then_some((receipt.target(), receipt.channel()));
    let (public_key, signature) = decode_updater_signature(
        &receipt.signature,
        public_key_base64,
        &receipt.version,
        expected_binding,
    )?;
    let mut verifier = public_key
        .verify_stream(&signature)
        .map_err(|_| rollback_cache_invalid())?;
    let mut hasher = Sha256::new();
    let mut file = File::open(path).map_err(|_| rollback_cache_invalid())?;
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| rollback_cache_invalid())?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(read as u64)
            .ok_or_else(rollback_cache_invalid)?;
        if total > receipt.size || total > MAX_UPDATE_BYTES {
            return Err(rollback_cache_invalid());
        }
        hasher.update(&buffer[..read]);
        verifier.update(&buffer[..read]);
    }
    if total != receipt.size || hex::encode(hasher.finalize()) != receipt.sha256 {
        return Err(rollback_cache_invalid());
    }
    verifier.finalize().map_err(|_| rollback_cache_invalid())
}

fn write_new_synced(path: &Path, bytes: &[u8]) -> Result<(), UpdateError> {
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|error| UpdateError::io(&error))?;
    file.write_all(bytes)
        .map_err(|error| UpdateError::io(&error))?;
    file.sync_all().map_err(|error| UpdateError::io(&error))
}

fn replace_json_atomically<T: Serialize>(path: &Path, value: &T) -> Result<(), UpdateError> {
    let next = sibling(path, "next");
    let previous = sibling(path, "previous");
    if next.exists() {
        fs::remove_file(&next).map_err(|error| UpdateError::io(&error))?;
    }
    let bytes = serde_json::to_vec_pretty(value).map_err(|_| {
        UpdateError::new(
            "update_state_unavailable",
            "KalCode couldn't save its update state.",
        )
    })?;
    write_new_synced(&next, &bytes)?;
    if previous.exists() {
        fs::remove_file(&previous).map_err(|error| UpdateError::io(&error))?;
    }
    if path.exists() {
        fs::rename(path, &previous).map_err(|error| UpdateError::io(&error))?;
    }
    if let Err(error) = fs::rename(&next, path) {
        if previous.exists() && !path.exists() {
            let _ = fs::rename(&previous, path);
        }
        return Err(UpdateError::io(&error));
    }
    if previous.exists() {
        fs::remove_file(previous).map_err(|error| UpdateError::io(&error))?;
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdatePhase {
    Idle,
    Checking,
    Downloading,
    Ready,
    UpToDate,
    Installing,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub channel: UpdateChannel,
    pub phase: UpdatePhase,
    pub current_version: String,
    pub available_version: Option<String>,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub last_error: Option<String>,
    pub recovery_available: bool,
    /// A newer build of the running public version is verified and staged: it installs, without
    /// a prompt, when KalCode closes. The machine never sets this; the desktop owner of the
    /// staged installer does.
    #[serde(default)]
    pub install_on_quit: bool,
}

/// Whether `next` is an internal build of `current`'s public version (`X.Y.Z` or `X.Y.Z+N` to
/// `X.Y.Z+M`): the same major, minor, patch and pre-release, and a plain numeric build number on
/// `next`. Callers have already proved `next` is newer. Such builds install silently when KalCode
/// closes; any other update is a new public version and keeps the in-app prompt. Mirrors
/// `sameVersionBuild` in the desktop UI.
#[must_use]
pub fn same_public_build(current: &str, next: &str) -> bool {
    let (Ok(current), Ok(next)) = (parse_version(current), parse_version(next)) else {
        return false;
    };
    let build = next.build.as_str();
    current.major == next.major
        && current.minor == next.minor
        && current.patch == next.patch
        && current.pre == next.pre
        && (1..=16).contains(&build.len())
        && !build.starts_with('0')
        && build.bytes().all(|byte| byte.is_ascii_digit())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OperationToken(u64);

pub struct UpdateMachine {
    generation: u64,
    status: UpdateStatus,
    candidate: Option<Candidate>,
}

impl UpdateMachine {
    #[must_use]
    pub fn new(channel: UpdateChannel, current_version: impl Into<String>) -> Self {
        Self {
            generation: 0,
            status: UpdateStatus {
                channel,
                phase: UpdatePhase::Idle,
                current_version: current_version.into(),
                available_version: None,
                downloaded_bytes: 0,
                total_bytes: None,
                last_error: None,
                recovery_available: false,
                install_on_quit: false,
            },
            candidate: None,
        }
    }

    #[must_use]
    pub const fn status(&self) -> &UpdateStatus {
        &self.status
    }

    pub fn set_channel(&mut self, channel: UpdateChannel) -> Result<(), UpdateError> {
        if self.status.phase == UpdatePhase::Installing {
            return Err(UpdateError::new(
                "update_busy",
                "An update operation is already running.",
            ));
        }
        self.generation = self.generation.wrapping_add(1);
        self.status.channel = channel;
        self.status.phase = UpdatePhase::Idle;
        self.status.available_version = None;
        self.status.downloaded_bytes = 0;
        self.status.total_bytes = None;
        self.status.last_error = None;
        self.candidate = None;
        Ok(())
    }

    pub fn set_recovery_available(&mut self, available: bool) {
        self.status.recovery_available = available;
    }

    pub fn mark_failed(&mut self, public_message: impl Into<String>) {
        self.generation = self.generation.wrapping_add(1);
        self.status.phase = UpdatePhase::Failed;
        self.status.last_error = Some(public_message.into());
        self.status.downloaded_bytes = 0;
        self.status.total_bytes = None;
        self.candidate = None;
    }

    pub fn begin_check(&mut self) -> Result<OperationToken, UpdateError> {
        if matches!(
            self.status.phase,
            UpdatePhase::Checking | UpdatePhase::Downloading | UpdatePhase::Installing
        ) {
            return Err(UpdateError::new(
                "update_busy",
                "An update operation is already running.",
            ));
        }
        self.generation = self.generation.wrapping_add(1);
        self.status.phase = UpdatePhase::Checking;
        self.status.available_version = None;
        self.status.downloaded_bytes = 0;
        self.status.total_bytes = None;
        self.status.last_error = None;
        self.candidate = None;
        Ok(OperationToken(self.generation))
    }

    pub fn check_token(&self, token: OperationToken) -> Result<(), UpdateError> {
        if token.0 == self.generation {
            Ok(())
        } else {
            Err(UpdateError::new(
                "stale_update_operation",
                "An older update operation finished after it was replaced.",
            ))
        }
    }

    pub fn no_update(&mut self, token: OperationToken) -> Result<(), UpdateError> {
        self.check_token(token)?;
        self.status.phase = UpdatePhase::UpToDate;
        Ok(())
    }

    pub fn begin_download(
        &mut self,
        token: OperationToken,
        candidate: Candidate,
    ) -> Result<(), UpdateError> {
        self.check_token(token)?;
        if self.status.phase != UpdatePhase::Checking {
            return Err(UpdateError::new(
                "update_state_invalid",
                "The update operation is in the wrong state.",
            ));
        }
        self.status.phase = UpdatePhase::Downloading;
        self.status.available_version = Some(candidate.version.clone());
        self.status.total_bytes = Some(candidate.metadata.size);
        self.candidate = Some(candidate);
        Ok(())
    }

    pub fn download_progress(
        &mut self,
        token: OperationToken,
        chunk_length: usize,
        content_length: Option<u64>,
    ) -> Result<(), UpdateError> {
        self.check_token(token)?;
        if self.status.phase != UpdatePhase::Downloading {
            return Err(UpdateError::new(
                "update_state_invalid",
                "The update operation is in the wrong state.",
            ));
        }
        if let Some(content_length) = content_length {
            let declared = self
                .candidate
                .as_ref()
                .map(|candidate| candidate.metadata.size)
                .unwrap_or(0);
            if content_length > MAX_UPDATE_BYTES || content_length != declared {
                return Err(UpdateError::new(
                    "update_size_mismatch",
                    "The update server reported the wrong size.",
                ));
            }
            self.status.total_bytes = Some(content_length);
        }
        self.status.downloaded_bytes = self
            .status
            .downloaded_bytes
            .saturating_add(chunk_length as u64);
        if self.status.downloaded_bytes > MAX_UPDATE_BYTES
            || self
                .status
                .total_bytes
                .is_some_and(|total| self.status.downloaded_bytes > total)
        {
            return Err(UpdateError::new(
                "update_too_large",
                "The update exceeded KalCode's safety limit.",
            ));
        }
        Ok(())
    }

    pub fn ready(
        &mut self,
        token: OperationToken,
        candidate: Candidate,
    ) -> Result<(), UpdateError> {
        self.check_token(token)?;
        if self.status.phase != UpdatePhase::Downloading
            || self.candidate.as_ref() != Some(&candidate)
        {
            return Err(UpdateError::new(
                "update_state_invalid",
                "The update operation is in the wrong state.",
            ));
        }
        self.status.phase = UpdatePhase::Ready;
        self.status.downloaded_bytes = candidate.metadata.size;
        self.status.total_bytes = Some(candidate.metadata.size);
        Ok(())
    }

    pub fn fail(
        &mut self,
        token: OperationToken,
        public_message: impl Into<String>,
    ) -> Result<(), UpdateError> {
        self.check_token(token)?;
        self.status.phase = UpdatePhase::Failed;
        self.status.last_error = Some(public_message.into());
        self.candidate = None;
        Ok(())
    }

    pub fn cancel(&mut self) -> Result<(), UpdateError> {
        if self.status.phase == UpdatePhase::Installing {
            return Err(UpdateError::new(
                "update_busy",
                "An update operation is already running.",
            ));
        }
        self.generation = self.generation.wrapping_add(1);
        self.status.phase = UpdatePhase::Idle;
        self.status.available_version = None;
        self.status.downloaded_bytes = 0;
        self.status.total_bytes = None;
        self.status.last_error = None;
        self.candidate = None;
        Ok(())
    }

    /// Fails the operation `token` owns. A caller that never won admission, or whose operation
    /// was already replaced, holds no current token: it gets `stale_update_operation` and the
    /// machine is left untouched, so it can never fail (and reopen) another worker's operation.
    pub fn fail_operation(
        &mut self,
        token: OperationToken,
        public_message: impl Into<String>,
    ) -> Result<(), UpdateError> {
        self.check_token(token)?;
        self.mark_failed(public_message);
        Ok(())
    }

    /// Admits one install. The returned token identifies the owning operation; only it may fail
    /// the install (`fail_operation`). A refusal changes nothing.
    pub fn begin_install(&mut self) -> Result<(Candidate, OperationToken), UpdateError> {
        if self.status.phase != UpdatePhase::Ready {
            return Err(UpdateError::new(
                "update_not_ready",
                "No verified update is ready to install.",
            ));
        }
        let candidate = self.candidate.clone().ok_or_else(|| {
            UpdateError::new(
                "update_not_ready",
                "No verified update is ready to install.",
            )
        })?;
        self.generation = self.generation.wrapping_add(1);
        self.status.phase = UpdatePhase::Installing;
        Ok((candidate, OperationToken(self.generation)))
    }

    pub fn begin_recovery(&mut self) -> Result<OperationToken, UpdateError> {
        if !self.status.recovery_available
            || matches!(
                self.status.phase,
                UpdatePhase::Checking | UpdatePhase::Downloading | UpdatePhase::Installing
            )
        {
            return Err(UpdateError::new(
                "rollback_unavailable",
                "No verified previous version is available.",
            ));
        }
        self.generation = self.generation.wrapping_add(1);
        self.status.phase = UpdatePhase::Installing;
        self.status.last_error = None;
        self.candidate = None;
        Ok(OperationToken(self.generation))
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallKind {
    #[default]
    Upgrade,
    Rollback,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallBinding {
    pub target: UpdateTarget,
    pub source_sha256: String,
    pub signing_requirement_sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MacSwapPhase {
    Prepared,
    Swapped,
    Launched,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MacSwapAttempt {
    pub current_app: PathBuf,
    pub staged_app: PathBuf,
    pub parent_pid: u32,
    pub parent_identity_sha256: String,
    pub phase: MacSwapPhase,
}

fn valid_install_binding(binding: &InstallBinding) -> bool {
    exact_lower_hex(&binding.source_sha256, 64)
        && exact_lower_hex(&binding.signing_requirement_sha256, 64)
}

fn valid_mac_swap(swap: &MacSwapAttempt) -> bool {
    let Some(current_parent) = swap.current_app.parent() else {
        return false;
    };
    let Some(staged_parent) = swap.staged_app.parent() else {
        return false;
    };
    let current_name = swap.current_app.file_name().and_then(|name| name.to_str());
    let staged_name = swap.staged_app.file_name().and_then(|name| name.to_str());
    swap.current_app.is_absolute()
        && swap.staged_app.is_absolute()
        && current_parent == staged_parent
        && swap.current_app != swap.staged_app
        && current_name.is_some_and(|name| name == "KalCode.app")
        && staged_name.is_some_and(|name| {
            name.starts_with(".KalCode-update-")
                && name.ends_with(".app")
                && name.len() <= 96
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
        })
        && swap.parent_pid > 0
        && exact_lower_hex(&swap.parent_identity_sha256, 64)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallAttempt {
    #[serde(default)]
    pub kind: InstallKind,
    pub from_version: String,
    pub to_version: String,
    pub sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding: Option<InstallBinding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mac_swap: Option<MacSwapAttempt>,
    /// Opaque durable attempt identity. New attempts begin with their creation time; the
    /// forward-only schema fence may append a bounded marker before a database migration.
    pub started_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JournalState {
    schema_version: u8,
    pub channel: UpdateChannel,
    pub install_attempt: Option<InstallAttempt>,
    pub last_successful_version: Option<String>,
    pub last_failure: Option<String>,
}

impl Default for JournalState {
    fn default() -> Self {
        Self {
            schema_version: JOURNAL_SCHEMA_VERSION,
            channel: UpdateChannel::Stable,
            install_attempt: None,
            last_successful_version: None,
            last_failure: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallOutcome {
    NoPendingInstall,
    Updated,
    RolledBack,
    PreviousVersionPreserved,
    UnexpectedVersion,
}

#[derive(Debug)]
pub struct UpdateJournal {
    path: PathBuf,
    state: JournalState,
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let extension = path.extension().map_or_else(
        || suffix.to_owned(),
        |value| format!("{}.{suffix}", value.to_string_lossy()),
    );
    path.with_extension(extension)
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, std::io::Error> {
    let file = File::open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "state file exceeds its safety limit",
        ));
    }
    let capacity = usize::try_from(metadata.len()).unwrap_or(0);
    let mut bytes = Vec::with_capacity(capacity);
    file.take(limit.saturating_add(1)).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "state file grew beyond its safety limit",
        ));
    }
    Ok(bytes)
}

fn read_state(path: &Path) -> Result<JournalState, UpdateError> {
    let bytes = read_bounded(path, MAX_UPDATE_STATE_BYTES).map_err(|_| {
        UpdateError::new(
            "update_journal_corrupt",
            "KalCode's update recovery record is damaged.",
        )
    })?;
    let state: JournalState = serde_json::from_slice(&bytes).map_err(|_| {
        UpdateError::new(
            "update_journal_corrupt",
            "KalCode's update recovery record is damaged.",
        )
    })?;
    if !matches!(
        state.schema_version,
        LEGACY_JOURNAL_SCHEMA_VERSION | JOURNAL_SCHEMA_VERSION
    ) || (state.schema_version == LEGACY_JOURNAL_SCHEMA_VERSION
        && state
            .install_attempt
            .as_ref()
            .is_some_and(|attempt| attempt.binding.is_some() || attempt.mac_swap.is_some()))
        || (state.schema_version == JOURNAL_SCHEMA_VERSION
            && state
                .install_attempt
                .as_ref()
                .is_some_and(|attempt| !valid_attempt_binding(attempt)))
    {
        return Err(UpdateError::new(
            "update_journal_corrupt",
            "KalCode's update recovery record is damaged.",
        ));
    }
    Ok(state)
}

impl UpdateJournal {
    pub fn load(path: impl Into<PathBuf>) -> Result<Self, UpdateError> {
        let path = path.into();
        let next = sibling(&path, "next");
        let previous = sibling(&path, "previous");
        let any_exists = path.exists() || next.exists() || previous.exists();
        if !any_exists {
            return Ok(Self {
                path,
                state: JournalState::default(),
            });
        }
        let mut corrupt = false;
        for candidate in [path.clone(), next, previous] {
            if !candidate.exists() {
                continue;
            }
            match read_state(&candidate) {
                Ok(state) => {
                    let recovered_primary = candidate != path;
                    let mut journal = Self { path, state };
                    if recovered_primary {
                        journal.save()?;
                    }
                    return Ok(journal);
                }
                Err(error) if error.code() == "update_journal_corrupt" => corrupt = true,
                Err(error) => return Err(error),
            }
        }
        if corrupt {
            Err(UpdateError::new(
                "update_journal_corrupt",
                "KalCode's update recovery record is damaged.",
            ))
        } else {
            Err(UpdateError::new(
                "update_state_unavailable",
                "KalCode couldn't read its update state.",
            ))
        }
    }

    #[must_use]
    pub const fn state(&self) -> &JournalState {
        &self.state
    }

    pub fn set_channel(&mut self, channel: UpdateChannel) -> Result<(), UpdateError> {
        self.state.channel = channel;
        self.save()
    }

    pub fn record_install_attempt(&mut self, attempt: InstallAttempt) -> Result<(), UpdateError> {
        let from = parse_version(&attempt.from_version)?;
        let to = parse_version(&attempt.to_version)?;
        let direction_is_valid = match attempt.kind {
            InstallKind::Upgrade => to > from,
            InstallKind::Rollback => to < from,
        };
        if !direction_is_valid
            || !exact_lower_hex(&attempt.sha256, 64)
            || attempt.started_at.trim().is_empty()
            || !valid_attempt_binding(&attempt)
            || attempt
                .mac_swap
                .as_ref()
                .is_some_and(|swap| swap.phase != MacSwapPhase::Prepared)
        {
            return Err(UpdateError::new(
                "update_install_record_invalid",
                "KalCode couldn't create a safe update recovery record.",
            ));
        }
        self.state.schema_version = JOURNAL_SCHEMA_VERSION;
        self.state.install_attempt = Some(attempt);
        self.state.last_failure = None;
        self.save()
    }

    pub fn cancel_install_attempt(&mut self, failure: &'static str) -> Result<(), UpdateError> {
        self.state.install_attempt = None;
        self.state.last_failure = Some(failure.to_owned());
        self.save()
    }

    pub fn mark_mac_swap_phase(
        &mut self,
        expected: MacSwapPhase,
        next: MacSwapPhase,
    ) -> Result<(), UpdateError> {
        let valid_transition = matches!(
            (expected, next),
            (MacSwapPhase::Prepared, MacSwapPhase::Swapped)
                | (MacSwapPhase::Swapped, MacSwapPhase::Launched)
        );
        let swap = self
            .state
            .install_attempt
            .as_mut()
            .and_then(|attempt| attempt.mac_swap.as_mut())
            .ok_or_else(|| {
                UpdateError::new(
                    "update_install_record_invalid",
                    "KalCode couldn't create a safe update recovery record.",
                )
            })?;
        if !valid_transition || swap.phase != expected {
            return Err(UpdateError::new(
                "update_install_record_invalid",
                "KalCode couldn't create a safe update recovery record.",
            ));
        }
        swap.phase = next;
        self.save()
    }

    /// Fences a launched macOS upgrade against rollback by the helper before a forward-only
    /// schema migration begins. Shipped helpers capture the complete attempt before the swap and
    /// compare it again immediately before swapping back, so this durable marker makes that
    /// rollback fail closed without changing the journal schema. Their success path still
    /// observes normal startup reconciliation and cleans up the verified previous app.
    pub fn fence_forward_only_mac_install(
        &mut self,
        current_version: &str,
    ) -> Result<(), UpdateError> {
        parse_version(current_version)?;
        let invalid = || {
            UpdateError::new(
                "update_install_record_invalid",
                "KalCode couldn't create a safe update recovery record.",
            )
        };
        let attempt = self.state.install_attempt.as_mut().ok_or_else(invalid)?;
        let launched_macos_upgrade = attempt.kind == InstallKind::Upgrade
            && attempt.to_version == current_version
            && attempt.binding.as_ref().map(|binding| binding.target)
                == Some(UpdateTarget::DarwinAarch64)
            && attempt.mac_swap.as_ref().map(|swap| swap.phase) == Some(MacSwapPhase::Launched);
        if !launched_macos_upgrade {
            return Err(invalid());
        }
        if attempt.started_at.ends_with(FORWARD_ONLY_MAC_FENCE_SUFFIX) {
            return Ok(());
        }
        if attempt.started_at.len() + FORWARD_ONLY_MAC_FENCE_SUFFIX.len()
            > MAX_ATTEMPT_IDENTITY_BYTES
        {
            return Err(invalid());
        }
        attempt.started_at.push_str(FORWARD_ONLY_MAC_FENCE_SUFFIX);
        self.save()
    }

    pub fn reconcile_startup(
        &mut self,
        current_version: &str,
    ) -> Result<InstallOutcome, UpdateError> {
        parse_version(current_version)?;
        let Some(attempt) = self.state.install_attempt.clone() else {
            return Ok(InstallOutcome::NoPendingInstall);
        };
        let outcome = if current_version == attempt.to_version {
            self.state.last_successful_version = Some(current_version.to_owned());
            self.state.last_failure = None;
            match attempt.kind {
                InstallKind::Upgrade => InstallOutcome::Updated,
                InstallKind::Rollback => InstallOutcome::RolledBack,
            }
        } else if current_version == attempt.from_version {
            self.state.last_failure = Some("install_did_not_advance".to_owned());
            InstallOutcome::PreviousVersionPreserved
        } else {
            self.state.last_failure = Some("installed_version_unexpected".to_owned());
            InstallOutcome::UnexpectedVersion
        };
        self.state.install_attempt = None;
        self.save()?;
        Ok(outcome)
    }

    fn save(&mut self) -> Result<(), UpdateError> {
        if self.state.install_attempt.is_none()
            || self
                .state
                .install_attempt
                .as_ref()
                .and_then(|attempt| attempt.binding.as_ref())
                .is_some_and(valid_install_binding)
        {
            self.state.schema_version = JOURNAL_SCHEMA_VERSION;
        }
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| UpdateError::io(&error))?;
        }
        let next = sibling(&self.path, "next");
        let previous = sibling(&self.path, "previous");
        if next.exists() {
            fs::remove_file(&next).map_err(|error| UpdateError::io(&error))?;
        }
        let bytes = serde_json::to_vec_pretty(&self.state).map_err(|_| {
            UpdateError::new(
                "update_state_unavailable",
                "KalCode couldn't save its update state.",
            )
        })?;
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&next)
            .map_err(|error| UpdateError::io(&error))?;
        file.write_all(&bytes)
            .map_err(|error| UpdateError::io(&error))?;
        file.sync_all().map_err(|error| UpdateError::io(&error))?;
        drop(file);
        if previous.exists() {
            fs::remove_file(&previous).map_err(|error| UpdateError::io(&error))?;
        }
        if self.path.exists() {
            fs::rename(&self.path, &previous).map_err(|error| UpdateError::io(&error))?;
        }
        if let Err(error) = fs::rename(&next, &self.path) {
            if previous.exists() && !self.path.exists() {
                let _ = fs::rename(&previous, &self.path);
            }
            return Err(UpdateError::io(&error));
        }
        if let Some(parent) = self.path.parent()
            && let Ok(directory) = File::open(parent)
        {
            let _ = directory.sync_all();
        }
        if previous.exists() {
            fs::remove_file(previous).map_err(|error| UpdateError::io(&error))?;
        }
        Ok(())
    }
}

fn valid_attempt_binding(attempt: &InstallAttempt) -> bool {
    let Some(binding) = attempt.binding.as_ref() else {
        return false;
    };
    if !valid_install_binding(binding) {
        return false;
    }
    match binding.target {
        UpdateTarget::WindowsX86_64 => attempt.mac_swap.is_none(),
        UpdateTarget::DarwinAarch64 => attempt.mac_swap.as_ref().is_some_and(valid_mac_swap),
    }
}
