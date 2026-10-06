//! KalCode Live Update: how a newer build reaches a running KalCode.
//!
//! Every published build carries, next to its signed installer, a signed *live descriptor*. It
//! names the build's native fingerprint (a hash of every input to the desktop shell binary) and
//! its UI bundle (the web frontend, by size and SHA-256). Comparing the running shell's
//! fingerprint with the new build's gives the update plan:
//!
//! - [`UpdateClass::Ui`]: the native shell is identical, so the new UI is fully compatible with
//!   the running process. It is downloaded, verified, staged and atomically activated, and only
//!   the renderer reloads; terminals and coding agents keep running in the shell.
//! - [`UpdateClass::Core`]: anything native changed (shell, services, PTY, updater, WebView
//!   integration). The signed installer applies it through a controlled handoff instead.
//!
//! Nothing here trusts the network: the descriptor must carry a Minisign signature from the
//! updater key bound to the exact version, target and channel, and every UI file is checked
//! against the signed hashes before activation and again whenever it is served.

use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use flate2::read::GzDecoder;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    MAX_UPDATE_STATE_BYTES, UpdateChannel, UpdateError, UpdateTarget,
    verify_updater_signature_for_target_and_channel,
};

pub const LIVE_SCHEMA_VERSION: u8 = 1;
/// The envelope holds a small descriptor and its signature.
pub const MAX_LIVE_ENVELOPE_BYTES: u64 = 64 * 1024;
/// Compressed UI bundle.
pub const MAX_UI_BUNDLE_BYTES: u64 = 64 * 1024 * 1024;
/// Expanded UI bundle.
pub const MAX_UI_EXPANDED_BYTES: u64 = 256 * 1024 * 1024;
const MAX_UI_FILES: usize = 4096;
const MAX_UI_INDEX_BYTES: usize = 1024 * 1024;
const BUNDLE_MAGIC: &[u8] = b"KALUI1\n";
const DESCRIPTOR_FILE_SUFFIX: &str = "-live.json";
/// Startups of an activated UI that never reported ready before it is abandoned.
pub const MAX_UNHEALTHY_BOOTS: u8 = 2;
const ACTIVE_FILE: &str = "active.json";
const REJECTED_FILE: &str = "rejected.json";
const BUNDLE_MANIFEST_FILE: &str = "kalcode-ui.json";
const MAX_REJECTED: usize = 32;

/// How a newer build applies to the running KalCode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateClass {
    /// Level 1: only the UI changed. Reload the renderer; everything else keeps running.
    Ui,
    /// Level 3: native code changed. Apply through the installer with a controlled handoff.
    Core,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiveEnvelope {
    pub schema_version: u8,
    /// Base64 of the exact descriptor bytes the signature covers.
    pub descriptor: String,
    /// Minisign signature (base64, as in the updater feed) over the descriptor bytes.
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiveDescriptor {
    pub schema_version: u8,
    pub version: String,
    pub channel: UpdateChannel,
    pub target: UpdateTarget,
    pub commit: String,
    pub shell: ShellContract,
    pub ui: UiArtifact,
}

/// The compatibility contract a UI bundle needs from the running shell: the exact native build
/// inputs it was built against. Equal fingerprints mean an identical IPC surface, permission set,
/// protocol schema, terminal/session bridge and updater.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShellContract {
    pub native_fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UiArtifact {
    pub file: String,
    pub size: u64,
    pub sha256: String,
    pub expanded_size: u64,
    pub files: u32,
}

fn live_error(code: &'static str, message: &'static str) -> UpdateError {
    UpdateError::new(code, message)
}

fn descriptor_invalid() -> UpdateError {
    live_error(
        "live_descriptor_invalid",
        "The live update description is invalid.",
    )
}

fn bundle_invalid() -> UpdateError {
    live_error(
        "live_bundle_invalid",
        "The live update bundle did not pass verification.",
    )
}

fn store_unavailable() -> UpdateError {
    live_error(
        "live_state_unavailable",
        "KalCode couldn't save its live update state.",
    )
}

fn is_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_safe_file_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && !value.contains("..")
        && !value.starts_with('.')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// A canonical fingerprint is 64 lowercase hex characters. Development builds carry none and
/// therefore never live-apply anything.
#[must_use]
pub fn valid_fingerprint(value: &str) -> bool {
    is_lower_hex(value, 64)
}

/// Verifies the envelope's signature and binds the descriptor to the version the canonical feed
/// announced, this target and this channel.
pub fn verify_envelope(
    raw: &[u8],
    public_key: &str,
    expected_version: &str,
    target: UpdateTarget,
    channel: UpdateChannel,
) -> Result<LiveDescriptor, UpdateError> {
    if raw.len() as u64 > MAX_LIVE_ENVELOPE_BYTES {
        return Err(descriptor_invalid());
    }
    let envelope: LiveEnvelope = serde_json::from_slice(raw).map_err(|_| descriptor_invalid())?;
    if envelope.schema_version != LIVE_SCHEMA_VERSION {
        return Err(descriptor_invalid());
    }
    let bytes = STANDARD
        .decode(envelope.descriptor.as_bytes())
        .map_err(|_| descriptor_invalid())?;
    verify_updater_signature_for_target_and_channel(
        &bytes,
        &envelope.signature,
        public_key,
        expected_version,
        target,
        channel,
    )?;
    // The updater key also signs installers. Only a signature made for a live descriptor file
    // may authorize a live update.
    if !signed_file_name(&envelope.signature)
        .is_some_and(|file| file.ends_with(DESCRIPTOR_FILE_SUFFIX))
    {
        return Err(live_error(
            "live_signature_purpose_mismatch",
            "The live update signature was not made for a live update.",
        ));
    }
    let descriptor: LiveDescriptor =
        serde_json::from_slice(&bytes).map_err(|_| descriptor_invalid())?;
    validate_descriptor(&descriptor, expected_version, target, channel)?;
    Ok(descriptor)
}

fn signed_file_name(signature_base64: &str) -> Option<String> {
    let text = String::from_utf8(STANDARD.decode(signature_base64).ok()?).ok()?;
    let signature = minisign_verify::Signature::decode(&text).ok()?;
    signature
        .trusted_comment()
        .split('\t')
        .find_map(|field| field.strip_prefix("file:"))
        .map(str::to_owned)
}

fn validate_descriptor(
    descriptor: &LiveDescriptor,
    expected_version: &str,
    target: UpdateTarget,
    channel: UpdateChannel,
) -> Result<(), UpdateError> {
    let valid = descriptor.schema_version == LIVE_SCHEMA_VERSION
        && descriptor.version == expected_version
        && descriptor.target == target
        && descriptor.channel == channel
        && is_lower_hex(&descriptor.commit, 40)
        && valid_fingerprint(&descriptor.shell.native_fingerprint)
        && is_safe_file_name(&descriptor.ui.file)
        && descriptor.ui.file.ends_with(".kui")
        && is_lower_hex(&descriptor.ui.sha256, 64)
        && descriptor.ui.size > 0
        && descriptor.ui.size <= MAX_UI_BUNDLE_BYTES
        && descriptor.ui.expanded_size > 0
        && descriptor.ui.expanded_size <= MAX_UI_EXPANDED_BYTES
        && descriptor.ui.files > 0
        && descriptor.ui.files as usize <= MAX_UI_FILES
        && Version::parse(&descriptor.version).is_ok();
    if valid {
        Ok(())
    } else {
        Err(descriptor_invalid())
    }
}

/// The update plan for `descriptor` against the running shell. Anything short of an exact native
/// match escalates to a core update: compatibility is never guessed.
#[must_use]
pub fn classify(
    running_native_fingerprint: Option<&str>,
    descriptor: &LiveDescriptor,
) -> UpdateClass {
    match running_native_fingerprint {
        Some(running)
            if valid_fingerprint(running) && running == descriptor.shell.native_fingerprint =>
        {
            UpdateClass::Ui
        }
        _ => UpdateClass::Core,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UiFile {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BundleIndex {
    files: Vec<UiFile>,
}

/// The manifest written beside an unpacked bundle: what it is and the hash of every file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BundleManifest {
    pub version: String,
    pub commit: String,
    pub native_fingerprint: String,
    pub bundle_sha256: String,
    pub files: Vec<UiFile>,
}

/// Paths are `/`-separated, relative, and made of plain names only.
fn is_safe_bundle_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 256
        && !path.starts_with('/')
        && path.split('/').all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && part.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'@' | b'+')
                })
        })
        && path != BUNDLE_MANIFEST_FILE
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Verifies the downloaded bundle against the signed descriptor and unpacks it into `dest`,
/// which must not exist yet. Nothing is written unless every check passes; a failure removes
/// `dest`.
pub fn unpack_bundle(
    bytes: &[u8],
    descriptor: &LiveDescriptor,
    dest: &Path,
) -> Result<BundleManifest, UpdateError> {
    if bytes.len() as u64 != descriptor.ui.size || sha256_hex(bytes) != descriptor.ui.sha256 {
        return Err(live_error(
            "live_bundle_integrity",
            "The live update bundle did not match its signed checksum.",
        ));
    }
    let mut expanded = Vec::new();
    GzDecoder::new(bytes)
        .take(descriptor.ui.expanded_size + 1)
        .read_to_end(&mut expanded)
        .map_err(|_| bundle_invalid())?;
    if expanded.len() as u64 != descriptor.ui.expanded_size {
        return Err(bundle_invalid());
    }
    let (index, body) = parse_bundle(&expanded)?;
    if index.files.len() != descriptor.ui.files as usize
        || !index.files.iter().any(|file| file.path == "index.html")
    {
        return Err(bundle_invalid());
    }
    let mut offsets = Vec::with_capacity(index.files.len());
    let mut offset = 0usize;
    let mut seen = std::collections::BTreeSet::new();
    for file in &index.files {
        if !is_safe_bundle_path(&file.path)
            || !is_lower_hex(&file.sha256, 64)
            || !seen.insert(file.path.to_ascii_lowercase())
        {
            return Err(bundle_invalid());
        }
        let size = usize::try_from(file.size).map_err(|_| bundle_invalid())?;
        let end = offset.checked_add(size).ok_or_else(bundle_invalid)?;
        let content = body.get(offset..end).ok_or_else(bundle_invalid)?;
        if sha256_hex(content) != file.sha256 {
            return Err(bundle_invalid());
        }
        offsets.push((offset, end));
        offset = end;
    }
    if offset != body.len() {
        return Err(bundle_invalid());
    }
    if dest.exists() {
        return Err(store_unavailable());
    }
    let manifest = BundleManifest {
        version: descriptor.version.clone(),
        commit: descriptor.commit.clone(),
        native_fingerprint: descriptor.shell.native_fingerprint.clone(),
        bundle_sha256: descriptor.ui.sha256.clone(),
        files: index.files,
    };
    let written = (|| -> std::io::Result<()> {
        fs::create_dir_all(dest)?;
        for (file, (start, end)) in manifest.files.iter().zip(offsets) {
            let path = dest.join(file.path.replace('/', std::path::MAIN_SEPARATOR_STR));
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            write_synced(&path, &body[start..end])?;
        }
        // The manifest goes last: a directory without one is an interrupted staging.
        write_synced(
            &dest.join(BUNDLE_MANIFEST_FILE),
            &serde_json::to_vec(&manifest).map_err(std::io::Error::other)?,
        )
    })();
    if written.is_err() {
        let _ = fs::remove_dir_all(dest);
        return Err(store_unavailable());
    }
    Ok(manifest)
}

fn parse_bundle(expanded: &[u8]) -> Result<(BundleIndex, &[u8]), UpdateError> {
    let rest = expanded
        .strip_prefix(BUNDLE_MAGIC)
        .ok_or_else(bundle_invalid)?;
    let (length, rest) = rest.split_at_checked(4).ok_or_else(bundle_invalid)?;
    let length = u32::from_le_bytes(length.try_into().map_err(|_| bundle_invalid())?) as usize;
    if length > MAX_UI_INDEX_BYTES {
        return Err(bundle_invalid());
    }
    let (index, body) = rest.split_at_checked(length).ok_or_else(bundle_invalid)?;
    let index: BundleIndex = serde_json::from_slice(index).map_err(|_| bundle_invalid())?;
    if index.files.is_empty() || index.files.len() > MAX_UI_FILES {
        return Err(bundle_invalid());
    }
    Ok((index, body))
}

fn write_synced(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = File::create(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

/// Reads a bundle's manifest and proves every file is present with its signed hash. Used before
/// a bundle is served again after a restart.
pub fn verify_unpacked(dir: &Path) -> Result<BundleManifest, UpdateError> {
    let manifest = read_bounded(&dir.join(BUNDLE_MANIFEST_FILE), MAX_UI_INDEX_BYTES as u64)
        .and_then(|bytes| serde_json::from_slice::<BundleManifest>(&bytes).ok())
        .ok_or_else(bundle_invalid)?;
    for file in &manifest.files {
        if !is_safe_bundle_path(&file.path) {
            return Err(bundle_invalid());
        }
        let bytes = read_bounded(&dir.join(&file.path), file.size).ok_or_else(bundle_invalid)?;
        if bytes.len() as u64 != file.size || sha256_hex(&bytes) != file.sha256 {
            return Err(bundle_invalid());
        }
    }
    Ok(manifest)
}

fn read_bounded(path: &Path, limit: u64) -> Option<Vec<u8>> {
    let file = File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 <= limit).then_some(bytes)
}

/// The UI a live update activated, as recorded in `active.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActiveUi {
    pub version: String,
    /// Directory name under `ui/`.
    pub dir: String,
    pub bundle_sha256: String,
    pub native_fingerprint: String,
    /// Consecutive starts of this UI without a ready report. At [`MAX_UNHEALTHY_BOOTS`] the next
    /// startup rejects it.
    pub unhealthy_boots: u8,
    /// The UI reported ready at least once; only such a UI is kept for rollback.
    pub healthy: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActiveRecord {
    schema_version: u8,
    current: Option<ActiveUi>,
    /// The last healthy live UI, kept for rollback.
    previous: Option<ActiveUi>,
}

/// What the store decided at startup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartupUi {
    /// Serve the UI embedded in the shell binary.
    Embedded,
    /// Serve this verified live UI.
    Live(ActiveUi, Box<BundleManifest>),
}

/// Why a startup went back to an earlier UI, for observability.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StartupRecovery {
    None,
    /// The installed shell is now as new as the live UI (the installer applied it).
    Superseded,
    /// The live UI never reported ready; KalCode went back to the previous good UI.
    RolledBack,
    /// The live UI on disk no longer matched its signed hashes.
    Damaged,
}

/// On-disk state of live UI updates: `<root>/active.json`, `<root>/rejected.json` and one
/// directory per unpacked bundle under `<root>/ui/`.
pub struct LiveStore {
    root: PathBuf,
}

impl LiveStore {
    #[must_use]
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    #[must_use]
    pub fn ui_root(&self) -> PathBuf {
        self.root.join("ui")
    }

    #[must_use]
    pub fn bundle_dir(&self, dir: &str) -> PathBuf {
        self.ui_root().join(dir)
    }

    /// A fresh staging directory for `descriptor`'s bundle.
    #[must_use]
    pub fn staging_dir_name(descriptor: &LiveDescriptor) -> String {
        format!(
            "{}-{}",
            descriptor.version.replace('+', "_b"),
            &descriptor.ui.sha256[..16]
        )
    }

    fn load(&self) -> ActiveRecord {
        read_bounded(&self.root.join(ACTIVE_FILE), MAX_UPDATE_STATE_BYTES)
            .and_then(|bytes| serde_json::from_slice::<ActiveRecord>(&bytes).ok())
            .filter(|record| record.schema_version == LIVE_SCHEMA_VERSION)
            .unwrap_or_default()
    }

    fn save(&self, record: &ActiveRecord) -> Result<(), UpdateError> {
        let record = ActiveRecord {
            schema_version: LIVE_SCHEMA_VERSION,
            ..record.clone()
        };
        atomic_write(
            &self.root,
            ACTIVE_FILE,
            &serde_json::to_vec_pretty(&record).map_err(|_| store_unavailable())?,
        )
    }

    #[must_use]
    pub fn rejected(&self) -> Vec<String> {
        read_bounded(&self.root.join(REJECTED_FILE), MAX_UPDATE_STATE_BYTES)
            .and_then(|bytes| serde_json::from_slice::<Vec<String>>(&bytes).ok())
            .unwrap_or_default()
    }

    /// Records a bundle that failed its health check so it is never activated again.
    pub fn reject(&self, bundle_sha256: &str) -> Result<(), UpdateError> {
        let mut rejected = self.rejected();
        if !rejected.iter().any(|known| known == bundle_sha256) {
            rejected.push(bundle_sha256.to_owned());
        }
        let excess = rejected.len().saturating_sub(MAX_REJECTED);
        rejected.drain(..excess);
        atomic_write(
            &self.root,
            REJECTED_FILE,
            &serde_json::to_vec(&rejected).map_err(|_| store_unavailable())?,
        )
    }

    #[must_use]
    pub fn is_rejected(&self, bundle_sha256: &str) -> bool {
        self.rejected().iter().any(|known| known == bundle_sha256)
    }

    #[must_use]
    pub fn current(&self) -> Option<ActiveUi> {
        self.load().current
    }

    /// Decides which UI this shell start serves, recovering from interrupted or failed updates:
    /// - a live UI built for another native fingerprint, or not newer than the shell, is retired;
    /// - a live UI that started [`MAX_UNHEALTHY_BOOTS`] times without reporting ready is rejected
    ///   and the previous healthy one (or the embedded UI) is used;
    /// - a live UI whose files fail verification is dropped.
    ///
    /// The chosen live UI's boot is counted before it is served; [`Self::mark_healthy`] clears it.
    pub fn startup(
        &self,
        running_native_fingerprint: Option<&str>,
        running_version: &str,
    ) -> (StartupUi, StartupRecovery) {
        let mut record = self.load();
        let mut recovery = StartupRecovery::None;
        let running = Version::parse(running_version).ok();
        let usable = |ui: &ActiveUi| {
            running_native_fingerprint.is_some_and(|native| native == ui.native_fingerprint)
                && Version::parse(&ui.version)
                    .ok()
                    .zip(running.as_ref())
                    .is_some_and(|(live, running)| live > *running)
        };
        if record.current.as_ref().is_some_and(|ui| !usable(ui)) {
            record.current = None;
            record.previous = None;
            recovery = StartupRecovery::Superseded;
        }
        if let Some(current) = record.current.clone()
            && current.unhealthy_boots >= MAX_UNHEALTHY_BOOTS
        {
            let _ = self.reject(&current.bundle_sha256);
            record.current = record.previous.take().filter(|ui| ui.healthy && usable(ui));
            recovery = StartupRecovery::RolledBack;
        }
        let chosen = match record.current.clone() {
            Some(current) => match verify_unpacked(&self.bundle_dir(&current.dir)) {
                Ok(manifest) if manifest.bundle_sha256 == current.bundle_sha256 => {
                    let mut counted = current.clone();
                    counted.unhealthy_boots = counted.unhealthy_boots.saturating_add(1);
                    record.current = Some(counted.clone());
                    StartupUi::Live(counted, Box::new(manifest))
                }
                _ => {
                    record.current = None;
                    recovery = StartupRecovery::Damaged;
                    StartupUi::Embedded
                }
            },
            None => StartupUi::Embedded,
        };
        let _ = self.save(&record);
        self.collect_garbage(&record);
        (chosen, recovery)
    }

    /// Makes `ui` the active UI in one atomic write, keeping the current healthy UI for
    /// rollback. The boot counter starts at one: the reload that follows must report ready.
    pub fn activate(&self, ui: ActiveUi) -> Result<(), UpdateError> {
        let mut record = self.load();
        let previous = record.current.take().filter(|current| current.healthy);
        record.previous = previous.or(record.previous.take());
        record.current = Some(ActiveUi {
            unhealthy_boots: 1,
            healthy: false,
            ..ui
        });
        self.save(&record)
    }

    /// The active UI loaded and reported ready.
    pub fn mark_healthy(&self, bundle_sha256: &str) -> Result<bool, UpdateError> {
        let mut record = self.load();
        match record.current.as_mut() {
            Some(current) if current.bundle_sha256 == bundle_sha256 => {
                current.healthy = true;
                current.unhealthy_boots = 0;
                self.save(&record)?;
                self.collect_garbage(&record);
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    /// The active UI failed while running: reject it and fall back to the previous healthy live
    /// UI, or to the embedded one. Returns what is active afterwards.
    pub fn roll_back(&self) -> Result<Option<ActiveUi>, UpdateError> {
        let mut record = self.load();
        if let Some(current) = record.current.take() {
            self.reject(&current.bundle_sha256)?;
        }
        record.current = record.previous.take();
        self.save(&record)?;
        Ok(record.current)
    }

    /// Removes staged bundles that are neither current nor kept for rollback, and interrupted
    /// stagings.
    fn collect_garbage(&self, record: &ActiveRecord) {
        let keep: Vec<&str> = [record.current.as_ref(), record.previous.as_ref()]
            .into_iter()
            .flatten()
            .map(|ui| ui.dir.as_str())
            .collect();
        let Ok(entries) = fs::read_dir(self.ui_root()) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if !keep.contains(&name) {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }

    /// Removes every live UI: the installed shell now carries a newer UI itself.
    pub fn clear(&self) -> Result<(), UpdateError> {
        let record = ActiveRecord::default();
        self.save(&record)?;
        self.collect_garbage(&record);
        Ok(())
    }
}

fn atomic_write(dir: &Path, name: &str, bytes: &[u8]) -> Result<(), UpdateError> {
    fs::create_dir_all(dir).map_err(|_| store_unavailable())?;
    let temp = dir.join(format!("{name}.{}.tmp", std::process::id()));
    write_synced(&temp, bytes).map_err(|_| store_unavailable())?;
    fs::rename(&temp, dir.join(name)).map_err(|_| {
        let _ = fs::remove_file(&temp);
        store_unavailable()
    })
}

/// The file index of a verified bundle, keyed the way the webview requests assets
/// (`/assets/app.js`).
#[must_use]
pub fn asset_index(manifest: &BundleManifest) -> BTreeMap<String, UiFile> {
    manifest
        .files
        .iter()
        .map(|file| (format!("/{}", file.path), file.clone()))
        .collect()
}

/// Reads one asset of a verified bundle and re-checks its hash, so a file changed on disk after
/// activation is never served.
#[must_use]
pub fn read_verified_asset(dir: &Path, file: &UiFile) -> Option<Vec<u8>> {
    let bytes = read_bounded(&dir.join(&file.path), file.size)?;
    (bytes.len() as u64 == file.size && sha256_hex(&bytes) == file.sha256).then_some(bytes)
}

/// Encodes a bundle in the format [`unpack_bundle`] reads. The release tooling has its own
/// encoder (`tooling/release/live-update.mjs`); this one serves tests and keeps the format
/// documented in one place: gzip(`KALUI1\n` + u32-LE index length + index JSON + file bytes).
#[must_use]
pub fn encode_bundle(files: &[(&str, &[u8])]) -> Vec<u8> {
    use flate2::Compression;
    use flate2::write::GzEncoder;
    let index = BundleIndex {
        files: files
            .iter()
            .map(|(path, bytes)| UiFile {
                path: (*path).to_owned(),
                size: bytes.len() as u64,
                sha256: sha256_hex(bytes),
            })
            .collect(),
    };
    let index = serde_json::to_vec(&index).unwrap_or_default();
    let mut raw = Vec::new();
    raw.extend_from_slice(BUNDLE_MAGIC);
    raw.extend_from_slice(&(index.len() as u32).to_le_bytes());
    raw.extend_from_slice(&index);
    for (_, bytes) in files {
        raw.extend_from_slice(bytes);
    }
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    let _ = encoder.write_all(&raw);
    encoder.finish().unwrap_or_default()
}

/// The expanded size of an encoded bundle, for building test descriptors.
#[must_use]
pub fn expanded_len(bundle: &[u8]) -> u64 {
    let mut expanded = Vec::new();
    let _ = GzDecoder::new(bundle).read_to_end(&mut expanded);
    expanded.len() as u64
}
