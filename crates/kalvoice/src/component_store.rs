//! Crash-safe storage for signed local KalVoice runtimes and reasoning models.
//!
//! The store never trusts a path, archive entry, or receipt merely because it is local. New
//! artifacts require a currently valid signed manifest. Each load rechecks the signature against
//! the application's current key set and hashes the retained artifact. Runtime archives are
//! extracted through an application-owned exact allowlist; unknown files, links, traversal, case
//! collisions, alternate streams, and archive bombs are rejected.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, SystemTime};

use fs2::FileExt as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use uuid::Uuid;
use zip::ZipArchive;

use crate::component_manifest::{
    ComponentArch, ComponentKind, ComponentManifest, ComponentPlatform, ComponentVerifier,
    InstalledManifestFreshness, RollbackAllowance, TransitionError, VerifiedComponentManifest,
    VerifyError, authorize_transition,
};

const STORE_SCHEMA: u32 = 1;
const POINTER_SCHEMA: u32 = 1;
const MAX_RECEIPT_BYTES: u64 = 64 * 1024;
const MAX_POINTER_BYTES: u64 = 8 * 1024;
const MAX_RUNTIME_ENTRIES: usize = 128;
const MAX_RUNTIME_EXPANDED_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ENTRY_EXPANSION_RATIO: u64 = 256;
const STAGING_STALE_AFTER: Duration = Duration::from_secs(24 * 60 * 60);
const STORAGE_ADMISSION_MARGIN: u64 = 64 * 1024 * 1024;
const PRIVATE_COMPONENT_ROOT: &str = "kalvoice-components";
const POINTER_PRIMARY: &str = "current.json";
const POINTER_BACKUP: &str = "current.backup.json";
const POINTER_PREPARED: &str = "current.next.json";

pub const LOCAL_REASONING_RUNTIME_ID: &str = "kalvoice.runtime.llama-cpp";
pub const LOCAL_REASONING_MODEL_ID: &str = "kalvoice.reasoner.qwen3-5-0-8b-q8";
pub const LOCAL_REASONING_RUNTIME_ABI: &str = "kalvoice-llama-cpp.v1";

/// Exact extraction policy for the pinned Windows x64 llama.cpp b11146 CPU runtime.
///
/// Every upstream archive entry is classified. Ignored programs and RPC modules remain only in
/// the signed outer archive and are never written to the executable payload directory.
pub static LLAMA_B11146_WINDOWS_CPU_POLICY: RuntimeArchivePolicy = RuntimeArchivePolicy {
    // The component track stays stable across upgrades. Version and monotonic sequence live in
    // the signed manifest; embedding b11146 here would create a fresh track and bypass downgrade
    // protection on every runtime update.
    component_id: LOCAL_REASONING_RUNTIME_ID,
    entrypoint: "llama-server.exe",
    executable_entries: &[],
    extract_entries: &[
        "LICENSE-LLVM-OpenMP",
        "ggml-base.dll",
        "ggml-cpu-alderlake.dll",
        "ggml-cpu-cannonlake.dll",
        "ggml-cpu-cascadelake.dll",
        "ggml-cpu-cooperlake.dll",
        "ggml-cpu-haswell.dll",
        "ggml-cpu-icelake.dll",
        "ggml-cpu-ivybridge.dll",
        "ggml-cpu-piledriver.dll",
        "ggml-cpu-sandybridge.dll",
        "ggml-cpu-sapphirerapids.dll",
        "ggml-cpu-skylakex.dll",
        "ggml-cpu-sse42.dll",
        "ggml-cpu-x64.dll",
        "ggml-cpu-zen4.dll",
        "ggml.dll",
        "libomp.dll",
        "llama-common.dll",
        "llama-server-impl.dll",
        "llama-server.exe",
        "llama.dll",
        "mtmd.dll",
    ],
    ignore_entries: &[
        "ggml-rpc-server.exe",
        "ggml-rpc.dll",
        "llama-batched-bench-impl.dll",
        "llama-batched-bench.exe",
        "llama-bench-impl.dll",
        "llama-bench.exe",
        "llama-cli-impl.dll",
        "llama-cli.exe",
        "llama-completion-impl.dll",
        "llama-completion.exe",
        "llama-fit-params-impl.dll",
        "llama-fit-params.exe",
        "llama-gemma3-cli.exe",
        "llama-gguf-split.exe",
        "llama-imatrix.exe",
        "llama-llava-cli.exe",
        "llama-minicpmv-cli.exe",
        "llama-mtmd-cli.exe",
        "llama-mtmd-debug.exe",
        "llama-perplexity-impl.dll",
        "llama-perplexity.exe",
        "llama-quantize-impl.dll",
        "llama-quantize.exe",
        "llama-qwen2vl-cli.exe",
        "llama-results.exe",
        "llama-tokenize.exe",
        "llama-tts.exe",
        "llama.exe",
    ],
};

/// Exact extraction policy for the curated macOS arm64 llama.cpp b11146 runtime ZIP.
///
/// The consumer artifact is not the upstream tarball. Release tooling must take only the
/// attested upstream dependency closure, materialize required dylib aliases as regular files,
/// sign every Mach-O with KalCode's Developer ID identity, normalize modes, and produce a
/// separately signed immutable ZIP. Symlinks and unrelated llama.cpp programs are absent.
pub static LLAMA_B11146_MACOS_ARM64_CPU_POLICY: RuntimeArchivePolicy = RuntimeArchivePolicy {
    component_id: LOCAL_REASONING_RUNTIME_ID,
    entrypoint: "llama-server",
    executable_entries: &["llama-server"],
    extract_entries: &[
        "LICENSE",
        "libggml-base.0.dylib",
        "libggml-blas.0.dylib",
        "libggml-cpu.0.dylib",
        "libggml-metal.0.dylib",
        "libggml-rpc.0.dylib",
        "libggml.0.dylib",
        "libllama-common.0.dylib",
        "libllama-server-impl.dylib",
        "libllama.0.dylib",
        "libmtmd.0.dylib",
        "llama-server",
    ],
    ignore_entries: &[],
};

#[derive(Debug, Clone, Copy)]
pub struct RuntimeArchivePolicy {
    pub component_id: &'static str,
    pub entrypoint: &'static str,
    /// Entries that must carry mode 0755 in the signed ZIP. When nonempty, every other extracted
    /// entry must carry 0644. Windows policies leave this empty because PE executability is not a
    /// Unix permission bit.
    pub executable_entries: &'static [&'static str],
    pub extract_entries: &'static [&'static str],
    pub ignore_entries: &'static [&'static str],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComponentSelector {
    pub component_id: String,
    pub kind: ComponentKind,
    pub platform: ComponentPlatform,
    pub arch: ComponentArch,
    pub runtime_abi: String,
}

/// Exact component tracks supported by this application build on the current host.
///
/// The Q8 model is intentionally the only production reasoner candidate: the pinned Windows
/// benchmark passed the complete 65-case corpus, while the smaller Q4 candidate did not. Model
/// bytes are portable, but manifests remain platform/architecture-specific so a consumer can
/// never be offered an artifact for the wrong target.
#[derive(Debug, Clone)]
pub struct LocalReasoningComponentContract {
    pub runtime: ComponentSelector,
    pub model: ComponentSelector,
    pub runtime_policy: RuntimeArchivePolicy,
}

pub fn host_local_reasoning_contract() -> Option<LocalReasoningComponentContract> {
    #[cfg(all(windows, target_arch = "x86_64"))]
    let (platform, arch, runtime_policy) = (
        ComponentPlatform::Windows,
        ComponentArch::X86_64,
        LLAMA_B11146_WINDOWS_CPU_POLICY,
    );
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    let (platform, arch, runtime_policy) = (
        ComponentPlatform::Macos,
        ComponentArch::Aarch64,
        LLAMA_B11146_MACOS_ARM64_CPU_POLICY,
    );
    #[cfg(not(any(
        all(windows, target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64")
    )))]
    return None;

    #[cfg(any(
        all(windows, target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64")
    ))]
    Some(LocalReasoningComponentContract {
        runtime: ComponentSelector {
            component_id: LOCAL_REASONING_RUNTIME_ID.into(),
            kind: ComponentKind::Runtime,
            platform,
            arch,
            runtime_abi: LOCAL_REASONING_RUNTIME_ABI.into(),
        },
        model: ComponentSelector {
            component_id: LOCAL_REASONING_MODEL_ID.into(),
            kind: ComponentKind::Model,
            platform,
            arch,
            runtime_abi: LOCAL_REASONING_RUNTIME_ABI.into(),
        },
        runtime_policy,
    })
}

impl ComponentSelector {
    pub fn from_manifest(manifest: &ComponentManifest) -> Self {
        Self {
            component_id: manifest.component_id.clone(),
            kind: manifest.kind,
            platform: manifest.platform,
            arch: manifest.arch,
            runtime_abi: manifest.runtime_abi.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComponentPayloadKind {
    Model,
    Runtime,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledComponent {
    pub selector: ComponentSelector,
    pub version: String,
    pub sequence: u64,
    pub freshness: InstalledManifestFreshness,
}

/// Existing canonical directory capability rooted in the application's OS-owned private data
/// directory. Callers must obtain the first authority from the platform app-data initializer;
/// all component store and staging directories are then created as validated direct children.
/// This keeps arbitrary caller paths and pre-existing final symlinks/reparse points outside the
/// component trust boundary. The capability does not claim to defend against an owner who can
/// replace the complete app-data directory while KalCode is running.
#[derive(Debug, Clone)]
pub struct TrustedComponentDirectory {
    path: Arc<PathBuf>,
    anchor: Arc<File>,
    identity: DirectoryIdentity,
}

impl TrustedComponentDirectory {
    /// Creates or reopens KalVoice's private direct child of the canonical OS app-data directory.
    ///
    /// The app-data directory itself may use the operating system's ordinary owner-readable mode.
    /// KalCode never changes that shared parent. A newly created component root is private from its
    /// first directory entry; an existing root must already satisfy the private-directory contract.
    pub fn create_private_root_under_app_data(
        app_data: impl AsRef<Path>,
    ) -> Result<Self, ComponentStoreError> {
        let app_data = AppDataDirectory::open_existing(app_data.as_ref())?;
        let child = app_data.path.join(PRIVATE_COMPONENT_ROOT);
        let created = create_private_directory(&child)?;
        if created {
            sync_directory(&app_data.path)?;
        }
        let child = Self::open_existing(&child)?;
        app_data.verify()?;
        if child.path.parent() != Some(app_data.path.as_path()) {
            return Err(ComponentStoreError::UnsafeStorage);
        }
        Ok(child)
    }

    pub fn open_existing(path: impl AsRef<Path>) -> Result<Self, ComponentStoreError> {
        let path = path.as_ref();
        let metadata = fs::symlink_metadata(path).map_err(storage)?;
        if !safe_store_directory(&metadata) {
            return Err(ComponentStoreError::UnsafeStorage);
        }
        let canonical = fs::canonicalize(path).map_err(storage)?;
        let canonical_metadata = fs::symlink_metadata(&canonical).map_err(storage)?;
        if !safe_store_directory(&canonical_metadata) {
            return Err(ComponentStoreError::UnsafeStorage);
        }
        let anchor = open_directory_anchor(&canonical)?;
        let identity = directory_identity(&anchor)?;
        if !same_directory(&canonical, &anchor, identity, true)? {
            return Err(ComponentStoreError::UnsafeStorage);
        }
        Ok(Self {
            path: Arc::new(canonical),
            anchor: Arc::new(anchor),
            identity,
        })
    }

    pub fn create_private_child(&self, name: &str) -> Result<Self, ComponentStoreError> {
        if !(safe_segment(name) || matches!(name, ".locks" | ".acquisition" | "revisions")) {
            return Err(ComponentStoreError::UnsafeStorage);
        }
        self.verify()?;
        let child = self.path.join(name);
        let created = create_private_directory(&child)?;
        if created {
            sync_directory(self.path.as_path())?;
        }
        let child = Self::open_existing(&child)?;
        self.verify()?;
        if child.path.parent() != Some(self.path.as_path()) {
            return Err(ComponentStoreError::UnsafeStorage);
        }
        Ok(child)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn verify(&self) -> Result<(), ComponentStoreError> {
        if same_directory(
            self.path.as_path(),
            self.anchor.as_ref(),
            self.identity,
            true,
        )? {
            Ok(())
        } else {
            Err(ComponentStoreError::UnsafeStorage)
        }
    }
}

struct AppDataDirectory {
    path: PathBuf,
    anchor: File,
    identity: DirectoryIdentity,
}

impl AppDataDirectory {
    fn open_existing(path: &Path) -> Result<Self, ComponentStoreError> {
        let metadata = fs::symlink_metadata(path).map_err(storage)?;
        if !safe_app_data_directory(&metadata) {
            return Err(ComponentStoreError::UnsafeStorage);
        }
        let canonical = fs::canonicalize(path).map_err(storage)?;
        let canonical_metadata = fs::symlink_metadata(&canonical).map_err(storage)?;
        if !safe_app_data_directory(&canonical_metadata) {
            return Err(ComponentStoreError::UnsafeStorage);
        }
        let anchor = open_directory_anchor(&canonical)?;
        let identity = directory_identity(&anchor)?;
        if !same_directory(&canonical, &anchor, identity, false)? {
            return Err(ComponentStoreError::UnsafeStorage);
        }
        Ok(Self {
            path: canonical,
            anchor,
            identity,
        })
    }

    fn verify(&self) -> Result<(), ComponentStoreError> {
        if same_directory(&self.path, &self.anchor, self.identity, false)? {
            Ok(())
        } else {
            Err(ComponentStoreError::UnsafeStorage)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComponentReceiptStatus {
    Missing,
    Present {
        version: String,
        sequence: u64,
        freshness: InstalledManifestFreshness,
    },
    Invalid,
}

#[derive(Debug, thiserror::Error)]
pub enum ComponentStoreError {
    #[error("the component selector is invalid")]
    InvalidSelector,
    #[error("the component is not built for this operating system and architecture")]
    WrongTarget,
    #[error("the signed component manifest is invalid: {0}")]
    Manifest(#[from] VerifyError),
    #[error("the component transition is not authorized: {0}")]
    Transition(#[from] TransitionError),
    #[error("the component artifact does not match its signed manifest")]
    ArtifactMismatch,
    #[error("the component runtime archive violates its extraction policy")]
    UnsafeArchive,
    #[error("the component runtime has no trusted extraction policy")]
    MissingRuntimePolicy,
    #[error("the component store receipt is invalid")]
    InvalidReceipt,
    #[error("the component store pointer is invalid")]
    InvalidPointer,
    #[error("the component store path is unsafe")]
    UnsafeStorage,
    #[error("the component volume does not have enough free space")]
    NotEnoughSpace,
    #[error("the component is in use")]
    InUse,
    #[error("the component is not installed")]
    NotInstalled,
    #[error("component storage failed: {0}")]
    Storage(io::ErrorKind),
}

fn storage(error: io::Error) -> ComponentStoreError {
    ComponentStoreError::Storage(error.kind())
}

#[derive(Clone)]
pub struct ComponentStore {
    root: PathBuf,
    authority: TrustedComponentDirectory,
    verifier: ComponentVerifier,
    runtime_policies: Arc<BTreeMap<String, RuntimeArchivePolicy>>,
    shared: Arc<Mutex<SharedState>>,
}

#[derive(Default)]
struct SharedState {
    leases: BTreeMap<PathBuf, usize>,
}

pub struct ComponentLease {
    manifest: VerifiedComponentManifest,
    freshness: InstalledManifestFreshness,
    recovered_previous: bool,
    payload: ComponentPayload,
    revision_dir: PathBuf,
    shared: Arc<Mutex<SharedState>>,
    // Held for the complete payload lifetime. Delete takes the corresponding exclusive lock,
    // so independent ComponentStore instances and processes cannot remove live component bytes.
    _revision_lock: File,
}

#[derive(Debug, Clone)]
enum ComponentPayload {
    Model(PathBuf),
    Runtime { root: PathBuf, entrypoint: PathBuf },
}

impl ComponentLease {
    pub fn manifest(&self) -> &ComponentManifest {
        self.manifest.manifest()
    }

    pub fn freshness(&self) -> InstalledManifestFreshness {
        self.freshness
    }

    pub fn recovered_previous(&self) -> bool {
        self.recovered_previous
    }

    pub fn payload_kind(&self) -> ComponentPayloadKind {
        match self.payload {
            ComponentPayload::Model(_) => ComponentPayloadKind::Model,
            ComponentPayload::Runtime { .. } => ComponentPayloadKind::Runtime,
        }
    }

    pub fn model_path(&self) -> Option<&Path> {
        match &self.payload {
            ComponentPayload::Model(path) => Some(path),
            ComponentPayload::Runtime { .. } => None,
        }
    }

    pub fn runtime_root(&self) -> Option<&Path> {
        match &self.payload {
            ComponentPayload::Runtime { root, .. } => Some(root),
            ComponentPayload::Model(_) => None,
        }
    }

    pub fn runtime_entrypoint(&self) -> Option<&Path> {
        match &self.payload {
            ComponentPayload::Runtime { entrypoint, .. } => Some(entrypoint),
            ComponentPayload::Model(_) => None,
        }
    }
}

impl Drop for ComponentLease {
    fn drop(&mut self) {
        let mut shared = self.shared.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(count) = shared.leases.get_mut(&self.revision_dir) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                shared.leases.remove(&self.revision_dir);
            }
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    schema_version: u32,
    token: String,
    artifact_file: String,
    extracted_files: Vec<String>,
    entrypoint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pointer {
    schema_version: u32,
    current: String,
    previous: Option<String>,
}

struct VerifiedRevision {
    manifest: VerifiedComponentManifest,
    freshness: InstalledManifestFreshness,
    payload: ComponentPayload,
    revision_dir: PathBuf,
}

impl ComponentStore {
    pub fn new(
        root: TrustedComponentDirectory,
        verifier: ComponentVerifier,
        runtime_policies: impl IntoIterator<Item = RuntimeArchivePolicy>,
    ) -> Result<Self, ComponentStoreError> {
        root.verify()?;
        let v1 = root.create_private_child("v1")?;
        v1.create_private_child(".locks")?;
        let root_path = root.path().to_owned();
        let mut policies = BTreeMap::new();
        for policy in runtime_policies {
            validate_policy(&policy)?;
            if policies
                .insert(policy.component_id.to_owned(), policy)
                .is_some()
            {
                return Err(ComponentStoreError::MissingRuntimePolicy);
            }
        }
        let store = Self {
            root: root_path,
            authority: root,
            verifier,
            runtime_policies: Arc::new(policies),
            shared: Arc::new(Mutex::new(SharedState::default())),
        };
        store.cleanup_stale_staging()?;
        Ok(store)
    }

    /// Installs bytes already staged by an explicit, consented acquisition flow.
    /// This method performs no network access and never executes the artifact.
    pub fn install_from_file(
        &self,
        token: &str,
        artifact: &Path,
        now_unix: i64,
    ) -> Result<InstalledComponent, ComponentStoreError> {
        let candidate = self.verifier.verify(token, now_unix)?;
        self.authority.verify()?;
        let manifest = candidate.manifest();
        if !manifest_matches_host(manifest) {
            return Err(ComponentStoreError::WrongTarget);
        }
        let selector = ComponentSelector::from_manifest(manifest);
        validate_selector(&selector)?;
        let track = self.ensure_track_dir(&selector)?;
        let lock_file = self.open_track_lock(&selector)?;
        lock_file.lock_exclusive().map_err(storage)?;
        let result = self.install_locked(token, artifact, now_unix, candidate, selector, &track);
        let _ = lock_file.unlock();
        result
    }

    pub fn status(&self, selector: &ComponentSelector, now_unix: i64) -> ComponentReceiptStatus {
        if self.authority.verify().is_err()
            || validate_selector(selector).is_err()
            || !selector_matches_host(selector)
        {
            return ComponentReceiptStatus::Invalid;
        }
        let track = self.track_dir(selector);
        let pointer = match read_pointer(&track) {
            Ok(Some(pointer)) => {
                if self
                    .validate_pointer_against_revisions(&track, &pointer, now_unix)
                    .is_err()
                {
                    return ComponentReceiptStatus::Invalid;
                }
                pointer
            }
            Ok(None) => return ComponentReceiptStatus::Missing,
            Err(_) => return ComponentReceiptStatus::Invalid,
        };
        let revision = track.join(&pointer.current);
        match self.read_verified_receipt(&revision, now_unix) {
            Ok((receipt, verified))
                if selector_matches(selector, verified.manifest().manifest())
                    && receipt_shape_valid(&receipt, verified.manifest().manifest()) =>
            {
                let manifest = verified.manifest().manifest();
                ComponentReceiptStatus::Present {
                    version: manifest.version.clone(),
                    sequence: manifest.sequence,
                    freshness: verified.freshness(),
                }
            }
            _ => ComponentReceiptStatus::Invalid,
        }
    }

    /// Acquires a verified load lease. Artifact hashing and runtime archive comparison occur here,
    /// never in high-frequency UI status polling.
    pub fn acquire(
        &self,
        selector: &ComponentSelector,
        now_unix: i64,
    ) -> Result<ComponentLease, ComponentStoreError> {
        validate_selector(selector)?;
        self.authority.verify()?;
        if !selector_matches_host(selector) {
            return Err(ComponentStoreError::WrongTarget);
        }
        let track = self.track_dir(selector);
        let lock_file = self.open_track_lock(selector)?;
        lock_file.lock_exclusive().map_err(storage)?;
        if !track.exists() {
            let _ = lock_file.unlock();
            return Err(ComponentStoreError::NotInstalled);
        }
        let result = self.acquire_locked(selector, now_unix, &track);
        let _ = lock_file.unlock();
        result
    }

    pub fn delete(&self, selector: &ComponentSelector) -> Result<(), ComponentStoreError> {
        validate_selector(selector)?;
        self.authority.verify()?;
        let track = self.track_dir(selector);
        let lock_file = self.open_track_lock(selector)?;
        lock_file.lock_exclusive().map_err(storage)?;
        if !track.exists() {
            let _ = lock_file.unlock();
            return Ok(());
        }
        let in_use = self
            .shared
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .leases
            .keys()
            .any(|revision| revision.starts_with(&track));
        if in_use {
            Err(ComponentStoreError::InUse)
        } else {
            let revision_locks = self.try_lock_all_revisions(selector, &track)?;
            let result = fs::remove_dir_all(&track).map_err(storage);
            drop(revision_locks);
            let _ = lock_file.unlock();
            result
        }
    }

    fn install_locked(
        &self,
        token: &str,
        artifact: &Path,
        now_unix: i64,
        candidate: VerifiedComponentManifest,
        selector: ComponentSelector,
        track: &Path,
    ) -> Result<InstalledComponent, ComponentStoreError> {
        let current = match read_pointer(track)? {
            Some(pointer) => {
                self.validate_pointer_against_revisions(track, &pointer, now_unix)?;
                let current = self.verify_revision(&track.join(pointer.current), now_unix)?;
                Some(current)
            }
            None => None,
        };
        authorize_transition(
            current.as_ref().map(|revision| &revision.manifest),
            &candidate,
            RollbackAllowance::Disallow,
        )?;
        verify_outer_artifact(artifact, candidate.manifest())?;
        let required = required_install_bytes(candidate.manifest());
        if fs2::available_space(track).map_err(storage)? < required {
            return Err(ComponentStoreError::NotEnoughSpace);
        }

        let revision_id = revision_name(candidate.manifest());
        let final_dir = track.join(&revision_id);
        if final_dir.exists() {
            let existing = self.verify_revision(&final_dir, now_unix)?;
            if existing.manifest != candidate {
                return Err(ComponentStoreError::InvalidReceipt);
            }
            if current
                .as_ref()
                .is_some_and(|revision| revision_name(revision.manifest.manifest()) == revision_id)
            {
                return Ok(installed_component(
                    selector,
                    &candidate,
                    InstalledManifestFreshness::Current,
                ));
            }
            self.activate(
                track,
                &revision_id,
                current
                    .as_ref()
                    .map(|revision| revision_name(revision.manifest.manifest())),
            )?;
            return Ok(installed_component(
                selector,
                &candidate,
                InstalledManifestFreshness::Current,
            ));
        }

        let staging = track.join(format!(".staging-{}", Uuid::now_v7().simple()));
        fs::create_dir(&staging).map_err(storage)?;
        let install_result = self.populate_staging(token, artifact, candidate.manifest(), &staging);
        if let Err(error) = install_result {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
        fs::rename(&staging, &final_dir).map_err(storage)?;
        self.activate(
            track,
            &revision_id,
            current
                .as_ref()
                .map(|revision| revision_name(revision.manifest.manifest())),
        )?;
        Ok(installed_component(
            selector,
            &candidate,
            InstalledManifestFreshness::Current,
        ))
    }

    fn populate_staging(
        &self,
        token: &str,
        artifact: &Path,
        manifest: &ComponentManifest,
        staging: &Path,
    ) -> Result<(), ComponentStoreError> {
        let (artifact_file, extracted_files, entrypoint) = match manifest.kind {
            ComponentKind::Model => {
                let destination = staging.join("model.gguf");
                copy_and_sync(artifact, &destination)?;
                // The caller's source path is outside the store and can change between the
                // preflight verification and this copy. Only bytes re-verified inside our fresh
                // staging directory may receive a signed receipt or become active.
                verify_outer_artifact(&destination, manifest)?;
                ("model.gguf".to_owned(), Vec::new(), None)
            }
            ComponentKind::Runtime => {
                let policy = self
                    .runtime_policies
                    .get(&manifest.component_id)
                    .ok_or(ComponentStoreError::MissingRuntimePolicy)?;
                let destination = staging.join("runtime.zip");
                copy_and_sync(artifact, &destination)?;
                verify_outer_artifact(&destination, manifest)?;
                let payload_dir = staging.join("payload");
                fs::create_dir(&payload_dir).map_err(storage)?;
                let files = extract_runtime(&destination, &payload_dir, policy)?;
                (
                    "runtime.zip".to_owned(),
                    files,
                    Some(policy.entrypoint.to_owned()),
                )
            }
        };
        let receipt = Receipt {
            schema_version: STORE_SCHEMA,
            token: token.to_owned(),
            artifact_file,
            extracted_files,
            entrypoint,
        };
        write_json_synced(&staging.join("receipt.json"), &receipt)
    }

    fn activate(
        &self,
        track: &Path,
        current: &str,
        previous: Option<String>,
    ) -> Result<(), ComponentStoreError> {
        let pointer = Pointer {
            schema_version: POINTER_SCHEMA,
            current: current.to_owned(),
            previous: previous.filter(|value| value != current),
        };
        replace_pointer(track, &pointer)
    }

    fn acquire_locked(
        &self,
        selector: &ComponentSelector,
        now_unix: i64,
        track: &Path,
    ) -> Result<ComponentLease, ComponentStoreError> {
        let pointer = read_pointer(track)?.ok_or(ComponentStoreError::NotInstalled)?;
        self.validate_pointer_against_revisions(track, &pointer, now_unix)?;
        let current_dir = track.join(&pointer.current);
        let current_receipt = self.read_verified_receipt(&current_dir, now_unix)?;
        if !selector_matches(selector, current_receipt.1.manifest().manifest()) {
            return Err(ComponentStoreError::InvalidReceipt);
        }
        let current_manifest = current_receipt.1.manifest().clone();
        match self.verify_revision_from_receipt(current_dir.clone(), current_receipt) {
            Ok(revision) => self.lease(selector, revision, false),
            Err(ComponentStoreError::ArtifactMismatch | ComponentStoreError::UnsafeArchive) => {
                let previous_name = pointer
                    .previous
                    .ok_or(ComponentStoreError::ArtifactMismatch)?;
                let previous_dir = track.join(&previous_name);
                let previous_receipt = self.read_verified_receipt(&previous_dir, now_unix)?;
                if !selector_matches(selector, previous_receipt.1.manifest().manifest()) {
                    return Err(ComponentStoreError::InvalidReceipt);
                }
                authorize_transition(
                    Some(&current_manifest),
                    previous_receipt.1.manifest(),
                    RollbackAllowance::PreviousVerified(previous_receipt.1.manifest()),
                )?;
                let previous = self.verify_revision_from_receipt(previous_dir, previous_receipt)?;
                // Keep the signed highest sequence authoritative. This is a last-good runtime
                // lease, not a pointer downgrade; a later repair can replace the corrupt current
                // revision without losing the monotonic floor.
                self.lease(selector, previous, true)
            }
            Err(error) => Err(error),
        }
    }

    fn verify_revision(
        &self,
        revision_dir: &Path,
        now_unix: i64,
    ) -> Result<VerifiedRevision, ComponentStoreError> {
        let receipt = self.read_verified_receipt(revision_dir, now_unix)?;
        self.verify_revision_from_receipt(revision_dir.to_owned(), receipt)
    }

    fn validate_pointer_against_revisions(
        &self,
        track: &Path,
        pointer: &Pointer,
        now_unix: i64,
    ) -> Result<(), ComponentStoreError> {
        let mut revisions = Vec::new();
        for entry in fs::read_dir(track).map_err(storage)? {
            let entry = entry.map_err(storage)?;
            if !entry.file_type().map_err(storage)?.is_dir() {
                continue;
            }
            let name = entry
                .file_name()
                .to_str()
                .ok_or(ComponentStoreError::InvalidPointer)?
                .to_owned();
            if name.starts_with(".staging-") {
                continue;
            }
            if !valid_revision_name(&name) {
                return Err(ComponentStoreError::InvalidPointer);
            }
            let (_, verified) = self.read_verified_receipt(&entry.path(), now_unix)?;
            revisions.push((verified.manifest().manifest().sequence, name));
        }
        revisions.sort_by_key(|(sequence, _)| *sequence);
        if revisions.is_empty()
            || revisions.windows(2).any(|pair| pair[0].0 == pair[1].0)
            || revisions.last().map(|(_, name)| name.as_str()) != Some(pointer.current.as_str())
        {
            return Err(ComponentStoreError::InvalidPointer);
        }
        let expected_previous = revisions
            .get(revisions.len().saturating_sub(2))
            .filter(|_| revisions.len() >= 2)
            .map(|(_, name)| name.as_str());
        if pointer.previous.as_deref() != expected_previous {
            return Err(ComponentStoreError::InvalidPointer);
        }
        Ok(())
    }

    fn read_verified_receipt(
        &self,
        revision_dir: &Path,
        now_unix: i64,
    ) -> Result<
        (
            Receipt,
            crate::component_manifest::VerifiedInstalledManifest,
        ),
        ComponentStoreError,
    > {
        let receipt: Receipt =
            read_json_limited(&revision_dir.join("receipt.json"), MAX_RECEIPT_BYTES)
                .map_err(|_| ComponentStoreError::InvalidReceipt)?;
        let verified = self.verifier.verify_installed(&receipt.token, now_unix)?;
        if !receipt_shape_valid(&receipt, verified.manifest().manifest())
            || revision_dir.file_name().and_then(|name| name.to_str())
                != Some(revision_name(verified.manifest().manifest()).as_str())
        {
            return Err(ComponentStoreError::InvalidReceipt);
        }
        Ok((receipt, verified))
    }

    fn verify_revision_from_receipt(
        &self,
        revision_dir: PathBuf,
        receipt: (
            Receipt,
            crate::component_manifest::VerifiedInstalledManifest,
        ),
    ) -> Result<VerifiedRevision, ComponentStoreError> {
        let (receipt, installed) = receipt;
        let verified = installed.manifest().clone();
        let manifest = verified.manifest();
        let artifact = revision_dir.join(&receipt.artifact_file);
        verify_outer_artifact(&artifact, manifest)?;
        let payload = match manifest.kind {
            ComponentKind::Model => ComponentPayload::Model(artifact),
            ComponentKind::Runtime => {
                let policy = self
                    .runtime_policies
                    .get(&manifest.component_id)
                    .ok_or(ComponentStoreError::MissingRuntimePolicy)?;
                let payload_root = revision_dir.join("payload");
                verify_runtime(&artifact, &payload_root, policy, &receipt.extracted_files)?;
                let entrypoint = payload_root.join(policy.entrypoint);
                ComponentPayload::Runtime {
                    root: payload_root,
                    entrypoint,
                }
            }
        };
        Ok(VerifiedRevision {
            manifest: verified,
            freshness: installed.freshness(),
            payload,
            revision_dir,
        })
    }

    fn lease(
        &self,
        selector: &ComponentSelector,
        revision: VerifiedRevision,
        recovered_previous: bool,
    ) -> Result<ComponentLease, ComponentStoreError> {
        let revision_name = revision
            .revision_dir
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or(ComponentStoreError::InvalidReceipt)?;
        if !valid_revision_name(revision_name) {
            return Err(ComponentStoreError::InvalidReceipt);
        }
        let revision_lock = self.open_revision_lock(selector, revision_name)?;
        revision_lock.lock_shared().map_err(storage)?;
        let mut shared = self.shared.lock().unwrap_or_else(PoisonError::into_inner);
        *shared
            .leases
            .entry(revision.revision_dir.clone())
            .or_default() += 1;
        drop(shared);
        Ok(ComponentLease {
            manifest: revision.manifest,
            freshness: revision.freshness,
            recovered_previous,
            payload: revision.payload,
            revision_dir: revision.revision_dir,
            shared: Arc::clone(&self.shared),
            _revision_lock: revision_lock,
        })
    }

    fn track_dir(&self, selector: &ComponentSelector) -> PathBuf {
        self.root
            .join("v1")
            .join(kind_segment(selector.kind))
            .join(&selector.component_id)
            .join(format!(
                "{}-{}",
                platform_segment(selector.platform),
                arch_segment(selector.arch)
            ))
            .join(&selector.runtime_abi)
    }

    #[cfg(test)]
    fn track_lock_dir(&self, selector: &ComponentSelector) -> PathBuf {
        self.root
            .join("v1")
            .join(".locks")
            .join(kind_segment(selector.kind))
            .join(&selector.component_id)
            .join(format!(
                "{}-{}",
                platform_segment(selector.platform),
                arch_segment(selector.arch)
            ))
            .join(&selector.runtime_abi)
    }

    fn ensure_track_dir(
        &self,
        selector: &ComponentSelector,
    ) -> Result<PathBuf, ComponentStoreError> {
        let mut directory = self.authority.create_private_child("v1")?;
        for segment in [
            kind_segment(selector.kind),
            selector.component_id.as_str(),
            &format!(
                "{}-{}",
                platform_segment(selector.platform),
                arch_segment(selector.arch)
            ),
            selector.runtime_abi.as_str(),
        ] {
            directory = directory.create_private_child(segment)?;
        }
        Ok(directory.path().to_owned())
    }

    fn ensure_lock_dir(
        &self,
        selector: &ComponentSelector,
    ) -> Result<TrustedComponentDirectory, ComponentStoreError> {
        let mut directory = self
            .authority
            .create_private_child("v1")?
            .create_private_child(".locks")?;
        for segment in [
            kind_segment(selector.kind),
            selector.component_id.as_str(),
            &format!(
                "{}-{}",
                platform_segment(selector.platform),
                arch_segment(selector.arch)
            ),
            selector.runtime_abi.as_str(),
        ] {
            directory = directory.create_private_child(segment)?;
        }
        Ok(directory)
    }

    fn open_track_lock(&self, selector: &ComponentSelector) -> Result<File, ComponentStoreError> {
        let lock_dir = self.ensure_lock_dir(selector)?;
        open_lock_file(&lock_dir.path().join("track.lock"))
    }

    fn open_revision_lock(
        &self,
        selector: &ComponentSelector,
        revision: &str,
    ) -> Result<File, ComponentStoreError> {
        if !valid_revision_name(revision) {
            return Err(ComponentStoreError::InvalidReceipt);
        }
        let lock_dir = self
            .ensure_lock_dir(selector)?
            .create_private_child("revisions")?;
        open_lock_file(&lock_dir.path().join(format!("{revision}.lock")))
    }

    fn try_lock_all_revisions(
        &self,
        selector: &ComponentSelector,
        track: &Path,
    ) -> Result<Vec<File>, ComponentStoreError> {
        let mut locks = Vec::new();
        for entry in fs::read_dir(track).map_err(storage)? {
            let entry = entry.map_err(storage)?;
            let metadata = entry.file_type().map_err(storage)?;
            if !metadata.is_dir() {
                continue;
            }
            let name = entry
                .file_name()
                .to_str()
                .ok_or(ComponentStoreError::InvalidReceipt)?
                .to_owned();
            if name.starts_with(".staging-") {
                continue;
            }
            if !valid_revision_name(&name) {
                return Err(ComponentStoreError::InvalidReceipt);
            }
            let revision_lock = self.open_revision_lock(selector, &name)?;
            match revision_lock.try_lock_exclusive() {
                Ok(()) => locks.push(revision_lock),
                Err(error) if lock_conflict(&error) => {
                    return Err(ComponentStoreError::InUse);
                }
                Err(error) => return Err(storage(error)),
            }
        }
        Ok(locks)
    }

    fn cleanup_stale_staging(&self) -> Result<(), ComponentStoreError> {
        cleanup_staging_below(&self.root.join("v1"), 0)
    }
}

fn required_install_bytes(manifest: &ComponentManifest) -> u64 {
    let payload = match manifest.kind {
        ComponentKind::Model => manifest.size_bytes,
        ComponentKind::Runtime => manifest
            .size_bytes
            .saturating_add(MAX_RUNTIME_EXPANDED_BYTES),
    };
    payload.saturating_add(STORAGE_ADMISSION_MARGIN)
}

fn lock_conflict(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::WouldBlock
        || (cfg!(windows) && matches!(error.raw_os_error(), Some(32 | 33)))
}

fn installed_component(
    selector: ComponentSelector,
    manifest: &VerifiedComponentManifest,
    freshness: InstalledManifestFreshness,
) -> InstalledComponent {
    InstalledComponent {
        selector,
        version: manifest.manifest().version.clone(),
        sequence: manifest.manifest().sequence,
        freshness,
    }
}

fn open_lock_file(path: &Path) -> Result<File, ComponentStoreError> {
    let file = match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !safe_lock_metadata(&metadata) || metadata.len() != 0 {
                return Err(ComponentStoreError::UnsafeStorage);
            }
            open_existing_lock(path)?
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => match create_lock(path) {
            Ok(file) => file,
            Err(ComponentStoreError::Storage(io::ErrorKind::AlreadyExists)) => {
                open_existing_lock(path)?
            }
            Err(error) => return Err(error),
        },
        Err(error) => return Err(storage(error)),
    };
    if !same_open_lock(path, &file)? {
        return Err(ComponentStoreError::UnsafeStorage);
    }
    Ok(file)
}

#[cfg(unix)]
fn safe_store_directory(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt as _;

    metadata.is_dir()
        && !metadata.file_type().is_symlink()
        && metadata.permissions().mode() & 0o077 == 0
}

#[cfg(windows)]
fn safe_store_directory(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt as _;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.is_dir()
        && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0
        && !metadata.file_type().is_symlink()
}

#[cfg(not(any(unix, windows)))]
fn safe_store_directory(_metadata: &fs::Metadata) -> bool {
    false
}

#[cfg(unix)]
fn protect_store_directory(path: &Path) -> Result<(), ComponentStoreError> {
    use std::os::unix::fs::PermissionsExt as _;

    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(storage)
}

#[cfg(windows)]
fn protect_store_directory(_path: &Path) -> Result<(), ComponentStoreError> {
    // The platform app-data initializer owns the per-user ACL. This layer rejects directory
    // reparse points and creates only direct children of that pre-existing authority.
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn protect_store_directory(_path: &Path) -> Result<(), ComponentStoreError> {
    Err(ComponentStoreError::UnsafeStorage)
}

#[cfg(unix)]
fn open_existing_lock(path: &Path) -> Result<File, ComponentStoreError> {
    use std::os::unix::fs::OpenOptionsExt as _;

    #[cfg(target_os = "macos")]
    const O_NOFOLLOW: i32 = 0x0000_0100;
    #[cfg(not(target_os = "macos"))]
    const O_NOFOLLOW: i32 = 0x0002_0000;
    OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(O_NOFOLLOW)
        .open(path)
        .map_err(storage)
}

#[cfg(windows)]
fn open_existing_lock(path: &Path) -> Result<File, ComponentStoreError> {
    use std::os::windows::fs::OpenOptionsExt as _;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(storage)
}

#[cfg(unix)]
fn create_lock(path: &Path) -> Result<File, ComponentStoreError> {
    use std::os::unix::fs::OpenOptionsExt as _;

    OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .mode(0o600)
        .open(path)
        .map_err(storage)
}

#[cfg(windows)]
fn create_lock(path: &Path) -> Result<File, ComponentStoreError> {
    use std::os::windows::fs::OpenOptionsExt as _;
    use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};

    OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(path)
        .map_err(storage)
}

#[cfg(not(any(unix, windows)))]
fn open_existing_lock(_path: &Path) -> Result<File, ComponentStoreError> {
    Err(ComponentStoreError::UnsafeStorage)
}

#[cfg(not(any(unix, windows)))]
fn create_lock(_path: &Path) -> Result<File, ComponentStoreError> {
    Err(ComponentStoreError::UnsafeStorage)
}

#[cfg(unix)]
fn safe_lock_metadata(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt as _;

    metadata.is_file() && !metadata.file_type().is_symlink() && metadata.nlink() == 1
}

#[cfg(windows)]
fn safe_lock_metadata(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt as _;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.is_file()
        && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0
        && !metadata.file_type().is_symlink()
}

#[cfg(not(any(unix, windows)))]
fn safe_lock_metadata(_metadata: &fs::Metadata) -> bool {
    false
}

#[cfg(unix)]
fn same_open_lock(path: &Path, file: &File) -> Result<bool, ComponentStoreError> {
    use std::os::unix::fs::MetadataExt as _;

    let path_metadata = fs::symlink_metadata(path).map_err(storage)?;
    let file_metadata = file.metadata().map_err(storage)?;
    Ok(safe_lock_metadata(&path_metadata)
        && file_metadata.nlink() == 1
        && path_metadata.dev() == file_metadata.dev()
        && path_metadata.ino() == file_metadata.ino())
}

#[cfg(windows)]
fn same_open_lock(path: &Path, file: &File) -> Result<bool, ComponentStoreError> {
    let path_metadata = fs::symlink_metadata(path).map_err(storage)?;
    if !safe_lock_metadata(&path_metadata) {
        return Ok(false);
    }
    let current = open_existing_lock(path)?;
    Ok(windows_lock_identity(file)? == windows_lock_identity(&current)?)
}

#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WindowsLockIdentity {
    volume: u32,
    index: u64,
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn windows_lock_identity(file: &File) -> Result<WindowsLockIdentity, ComponentStoreError> {
    use std::os::windows::io::AsRawHandle as _;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT, GetFileInformationByHandle,
    };

    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: `file` owns a live Windows handle and `information` is exact writable storage for
    // the structure requested by GetFileInformationByHandle.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as HANDLE, &raw mut information) }
        == 0
    {
        return Err(storage(io::Error::last_os_error()));
    }
    if information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || information.nNumberOfLinks != 1
    {
        return Err(ComponentStoreError::UnsafeStorage);
    }
    Ok(WindowsLockIdentity {
        volume: information.dwVolumeSerialNumber,
        index: (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow),
    })
}

#[cfg(not(any(unix, windows)))]
fn same_open_lock(_path: &Path, _file: &File) -> Result<bool, ComponentStoreError> {
    Ok(false)
}

fn validate_policy(policy: &RuntimeArchivePolicy) -> Result<(), ComponentStoreError> {
    if !safe_segment(policy.component_id)
        || !safe_flat_file(policy.entrypoint)
        || policy.extract_entries.is_empty()
        || !policy.extract_entries.contains(&policy.entrypoint)
        || policy
            .executable_entries
            .iter()
            .any(|name| !policy.extract_entries.contains(name))
        || (!policy.executable_entries.is_empty()
            && !policy.executable_entries.contains(&policy.entrypoint))
        || policy.extract_entries.len() + policy.ignore_entries.len() > MAX_RUNTIME_ENTRIES
    {
        return Err(ComponentStoreError::MissingRuntimePolicy);
    }
    let mut names = BTreeSet::new();
    for name in policy
        .extract_entries
        .iter()
        .chain(policy.ignore_entries.iter())
    {
        if !safe_flat_file(name) || !names.insert(name.to_ascii_lowercase()) {
            return Err(ComponentStoreError::MissingRuntimePolicy);
        }
    }
    Ok(())
}

fn validate_selector(selector: &ComponentSelector) -> Result<(), ComponentStoreError> {
    if safe_segment(&selector.component_id) && safe_segment(&selector.runtime_abi) {
        Ok(())
    } else {
        Err(ComponentStoreError::InvalidSelector)
    }
}

fn selector_matches(selector: &ComponentSelector, manifest: &ComponentManifest) -> bool {
    selector.component_id == manifest.component_id
        && selector.kind == manifest.kind
        && selector.platform == manifest.platform
        && selector.arch == manifest.arch
        && selector.runtime_abi == manifest.runtime_abi
}

fn manifest_matches_host(manifest: &ComponentManifest) -> bool {
    let platform_matches = (cfg!(target_os = "windows")
        && manifest.platform == ComponentPlatform::Windows)
        || (cfg!(target_os = "macos") && manifest.platform == ComponentPlatform::Macos)
        || (cfg!(target_os = "linux") && manifest.platform == ComponentPlatform::Linux);
    let arch_matches = (cfg!(target_arch = "x86_64") && manifest.arch == ComponentArch::X86_64)
        || (cfg!(target_arch = "aarch64") && manifest.arch == ComponentArch::Aarch64);
    platform_matches && arch_matches
}

fn selector_matches_host(selector: &ComponentSelector) -> bool {
    let platform_matches = (cfg!(target_os = "windows")
        && selector.platform == ComponentPlatform::Windows)
        || (cfg!(target_os = "macos") && selector.platform == ComponentPlatform::Macos)
        || (cfg!(target_os = "linux") && selector.platform == ComponentPlatform::Linux);
    let arch_matches = (cfg!(target_arch = "x86_64") && selector.arch == ComponentArch::X86_64)
        || (cfg!(target_arch = "aarch64") && selector.arch == ComponentArch::Aarch64);
    platform_matches && arch_matches
}

fn receipt_shape_valid(receipt: &Receipt, manifest: &ComponentManifest) -> bool {
    if receipt.schema_version != STORE_SCHEMA
        || receipt.token.len() > crate::component_manifest::MAX_TOKEN_LENGTH
    {
        return false;
    }
    match manifest.kind {
        ComponentKind::Model => {
            receipt.artifact_file == "model.gguf"
                && receipt.extracted_files.is_empty()
                && receipt.entrypoint.is_none()
        }
        ComponentKind::Runtime => {
            receipt.artifact_file == "runtime.zip"
                && receipt.entrypoint.as_deref().is_some_and(safe_flat_file)
                && receipt
                    .extracted_files
                    .iter()
                    .all(|value| safe_flat_file(value))
        }
    }
}

fn verify_outer_artifact(
    artifact: &Path,
    manifest: &ComponentManifest,
) -> Result<(), ComponentStoreError> {
    let metadata = fs::symlink_metadata(artifact).map_err(storage)?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() != manifest.size_bytes
    {
        return Err(ComponentStoreError::ArtifactMismatch);
    }
    let digest = hash_file(artifact)?;
    if digest != manifest.sha256 {
        return Err(ComponentStoreError::ArtifactMismatch);
    }
    Ok(())
}

fn hash_file(path: &Path) -> Result<String, ComponentStoreError> {
    let mut file = File::open(path).map_err(storage)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(storage)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn copy_and_sync(source: &Path, destination: &Path) -> Result<(), ComponentStoreError> {
    let mut input = File::open(source).map_err(storage)?;
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)
        .map_err(storage)?;
    io::copy(&mut input, &mut output).map_err(storage)?;
    output.sync_all().map_err(storage)
}

fn extract_runtime(
    archive_path: &Path,
    destination: &Path,
    policy: &RuntimeArchivePolicy,
) -> Result<Vec<String>, ComponentStoreError> {
    let file = File::open(archive_path).map_err(storage)?;
    let mut archive = ZipArchive::new(file).map_err(|_| ComponentStoreError::UnsafeArchive)?;
    if archive.len() > MAX_RUNTIME_ENTRIES {
        return Err(ComponentStoreError::UnsafeArchive);
    }
    let extract: BTreeSet<&str> = policy.extract_entries.iter().copied().collect();
    let ignored: BTreeSet<&str> = policy.ignore_entries.iter().copied().collect();
    let mut seen = BTreeSet::new();
    let mut extracted = Vec::new();
    let mut expanded = 0_u64;
    let mut actual_expanded = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|_| ComponentStoreError::UnsafeArchive)?;
        let name = entry.name().to_owned();
        validate_archive_entry(&entry, &name, &mut seen, &mut expanded)?;
        validate_archive_mode(&entry, &name, policy)?;
        if ignored.contains(name.as_str()) {
            continue;
        }
        if !extract.contains(name.as_str()) {
            return Err(ComponentStoreError::UnsafeArchive);
        }
        let path = destination.join(&name);
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .map_err(storage)?;
        let remaining = MAX_RUNTIME_EXPANDED_BYTES.saturating_sub(actual_expanded);
        let limit = entry.size().min(remaining).saturating_add(1);
        let copied = io::copy(&mut entry.by_ref().take(limit), &mut output).map_err(storage)?;
        if copied != entry.size() {
            return Err(ComponentStoreError::UnsafeArchive);
        }
        actual_expanded = actual_expanded.saturating_add(copied);
        output.sync_all().map_err(storage)?;
        apply_extracted_mode(&output, &name, policy)?;
        extracted.push(name);
    }
    let extracted_set: BTreeSet<&str> = extracted.iter().map(String::as_str).collect();
    if extracted_set != extract {
        return Err(ComponentStoreError::UnsafeArchive);
    }
    extracted.sort();
    Ok(extracted)
}

fn verify_runtime(
    archive_path: &Path,
    payload_root: &Path,
    policy: &RuntimeArchivePolicy,
    receipt_files: &[String],
) -> Result<(), ComponentStoreError> {
    let expected: BTreeSet<String> = policy
        .extract_entries
        .iter()
        .map(|value| (*value).to_owned())
        .collect();
    let recorded: BTreeSet<String> = receipt_files.iter().cloned().collect();
    if expected != recorded || receipt_files.len() != recorded.len() {
        return Err(ComponentStoreError::InvalidReceipt);
    }
    let file = File::open(archive_path).map_err(storage)?;
    let mut archive = ZipArchive::new(file).map_err(|_| ComponentStoreError::UnsafeArchive)?;
    if archive.len() > MAX_RUNTIME_ENTRIES {
        return Err(ComponentStoreError::UnsafeArchive);
    }
    let ignored: BTreeSet<&str> = policy.ignore_entries.iter().copied().collect();
    let mut seen = BTreeSet::new();
    let mut expanded = 0_u64;
    let mut verified = BTreeSet::new();
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|_| ComponentStoreError::UnsafeArchive)?;
        let name = entry.name().to_owned();
        validate_archive_entry(&entry, &name, &mut seen, &mut expanded)?;
        validate_archive_mode(&entry, &name, policy)?;
        if ignored.contains(name.as_str()) {
            continue;
        }
        if !expected.contains(&name) {
            return Err(ComponentStoreError::UnsafeArchive);
        }
        let path = payload_root.join(&name);
        let metadata = fs::symlink_metadata(&path).map_err(storage)?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() != entry.size()
            || !extracted_mode_matches(&metadata, &name, policy)
        {
            return Err(ComponentStoreError::ArtifactMismatch);
        }
        let declared_size = entry.size();
        let archive_hash = hash_reader_bounded(&mut entry, declared_size)?;
        if archive_hash.1 != declared_size {
            return Err(ComponentStoreError::UnsafeArchive);
        }
        let mut extracted = File::open(path).map_err(storage)?;
        let extracted_hash = hash_reader_bounded(&mut extracted, declared_size)?;
        if extracted_hash.1 != declared_size || archive_hash.0 != extracted_hash.0 {
            return Err(ComponentStoreError::ArtifactMismatch);
        }
        verified.insert(name);
    }
    if verified != expected {
        return Err(ComponentStoreError::UnsafeArchive);
    }
    Ok(())
}

fn validate_archive_mode<R: Read>(
    entry: &zip::read::ZipFile<'_, R>,
    name: &str,
    policy: &RuntimeArchivePolicy,
) -> Result<(), ComponentStoreError> {
    if policy.executable_entries.is_empty() {
        return Ok(());
    }
    let expected = if policy.executable_entries.contains(&name) {
        0o755
    } else {
        0o644
    };
    let Some(mode) = entry.unix_mode() else {
        return Err(ComponentStoreError::UnsafeArchive);
    };
    if mode & 0o170000 != 0o100000 || mode & 0o777 != expected {
        return Err(ComponentStoreError::UnsafeArchive);
    }
    Ok(())
}

#[cfg(unix)]
fn apply_extracted_mode(
    file: &File,
    name: &str,
    policy: &RuntimeArchivePolicy,
) -> Result<(), ComponentStoreError> {
    use std::os::unix::fs::PermissionsExt as _;

    if policy.executable_entries.is_empty() {
        return Ok(());
    }
    let mode = if policy.executable_entries.contains(&name) {
        0o755
    } else {
        0o644
    };
    file.set_permissions(fs::Permissions::from_mode(mode))
        .map_err(storage)
}

#[cfg(not(unix))]
fn apply_extracted_mode(
    _file: &File,
    _name: &str,
    _policy: &RuntimeArchivePolicy,
) -> Result<(), ComponentStoreError> {
    Ok(())
}

#[cfg(unix)]
fn extracted_mode_matches(
    metadata: &fs::Metadata,
    name: &str,
    policy: &RuntimeArchivePolicy,
) -> bool {
    use std::os::unix::fs::PermissionsExt as _;

    if policy.executable_entries.is_empty() {
        return true;
    }
    let expected = if policy.executable_entries.contains(&name) {
        0o755
    } else {
        0o644
    };
    metadata.permissions().mode() & 0o777 == expected
}

#[cfg(not(unix))]
fn extracted_mode_matches(
    _metadata: &fs::Metadata,
    _name: &str,
    _policy: &RuntimeArchivePolicy,
) -> bool {
    true
}

fn hash_reader_bounded(
    reader: &mut impl Read,
    declared_size: u64,
) -> Result<([u8; 32], u64), ComponentStoreError> {
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut bounded = reader.take(declared_size.saturating_add(1));
    let mut total = 0_u64;
    loop {
        let read = bounded.read(&mut buffer).map_err(storage)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        total = total.saturating_add(read as u64);
    }
    Ok((hasher.finalize().into(), total))
}

fn validate_archive_entry<R: Read>(
    entry: &zip::read::ZipFile<'_, R>,
    name: &str,
    seen: &mut BTreeSet<String>,
    expanded: &mut u64,
) -> Result<(), ComponentStoreError> {
    if entry.is_dir()
        || !safe_flat_file(name)
        || entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        || !seen.insert(name.to_ascii_lowercase())
    {
        return Err(ComponentStoreError::UnsafeArchive);
    }
    *expanded = expanded.saturating_add(entry.size());
    if *expanded > MAX_RUNTIME_EXPANDED_BYTES
        || (entry.compressed_size() == 0 && entry.size() != 0)
        || (entry.compressed_size() != 0
            && entry.size() / entry.compressed_size().max(1) > MAX_ENTRY_EXPANSION_RATIO)
    {
        return Err(ComponentStoreError::UnsafeArchive);
    }
    Ok(())
}

fn safe_flat_file(value: &str) -> bool {
    if value.is_empty()
        || value.len() > 160
        || !value.is_ascii()
        || value.contains(['/', '\\', ':', '\0'])
        || value.ends_with(['.', ' '])
        || Path::new(value)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return false;
    }
    let stem = value
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    !matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

fn safe_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'+' | b'-'))
}

fn revision_name(manifest: &ComponentManifest) -> String {
    format!("{:020}-{}", manifest.sequence, manifest.sha256)
}

fn valid_revision_name(value: &str) -> bool {
    value.len() == 20 + 1 + 64
        && value.as_bytes()[..20].iter().all(u8::is_ascii_digit)
        && value.as_bytes()[20] == b'-'
        && value.as_bytes()[21..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

fn read_pointer(track: &Path) -> Result<Option<Pointer>, ComponentStoreError> {
    let primary = track.join("current.json");
    let backup = track.join("current.backup.json");
    let path = if primary.exists() {
        primary
    } else if backup.exists() {
        backup
    } else {
        return Ok(None);
    };
    let pointer: Pointer = read_json_limited(&path, MAX_POINTER_BYTES)
        .map_err(|_| ComponentStoreError::InvalidPointer)?;
    if pointer.schema_version != POINTER_SCHEMA
        || !valid_revision_name(&pointer.current)
        || pointer
            .previous
            .as_deref()
            .is_some_and(|value| !valid_revision_name(value) || value == pointer.current)
    {
        return Err(ComponentStoreError::InvalidPointer);
    }
    Ok(Some(pointer))
}

fn replace_pointer(track: &Path, pointer: &Pointer) -> Result<(), ComponentStoreError> {
    let primary = track.join("current.json");
    let backup = track.join("current.backup.json");
    let next = track.join(format!("current.{}.next", Uuid::now_v7().simple()));
    write_json_synced(&next, pointer)?;
    if backup.exists() {
        fs::remove_file(&backup).map_err(storage)?;
    }
    if primary.exists() {
        fs::rename(&primary, &backup).map_err(storage)?;
    }
    if let Err(error) = fs::rename(&next, &primary) {
        if backup.exists() && !primary.exists() {
            let _ = fs::rename(&backup, &primary);
        }
        let _ = fs::remove_file(&next);
        return Err(storage(error));
    }
    if backup.exists() {
        fs::remove_file(backup).map_err(storage)?;
    }
    Ok(())
}

fn write_json_synced<T: Serialize>(path: &Path, value: &T) -> Result<(), ComponentStoreError> {
    let bytes = serde_json::to_vec(value).map_err(|_| ComponentStoreError::InvalidReceipt)?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(storage)?;
    file.write_all(&bytes).map_err(storage)?;
    file.sync_all().map_err(storage)
}

fn read_json_limited<T: for<'de> Deserialize<'de>>(
    path: &Path,
    limit: u64,
) -> Result<T, ComponentStoreError> {
    let metadata = fs::symlink_metadata(path).map_err(storage)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > limit {
        return Err(ComponentStoreError::InvalidReceipt);
    }
    let file = File::open(path).map_err(storage)?;
    serde_json::from_reader(file).map_err(|_| ComponentStoreError::InvalidReceipt)
}

fn cleanup_staging_below(path: &Path, depth: usize) -> Result<(), ComponentStoreError> {
    if depth > 8 || !path.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(path).map_err(storage)? {
        let entry = entry.map_err(storage)?;
        let file_type = entry.file_type().map_err(storage)?;
        if !file_type.is_dir() || file_type.is_symlink() {
            continue;
        }
        let entry_path = entry.path();
        let name = entry.file_name();
        if name.to_string_lossy().starts_with(".staging-") {
            let stale = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|modified| SystemTime::now().duration_since(modified).ok())
                .is_some_and(|age| age >= STAGING_STALE_AFTER);
            if stale {
                fs::remove_dir_all(entry_path).map_err(storage)?;
            }
        } else {
            cleanup_staging_below(&entry_path, depth + 1)?;
        }
    }
    Ok(())
}

fn kind_segment(kind: ComponentKind) -> &'static str {
    match kind {
        ComponentKind::Model => "model",
        ComponentKind::Runtime => "runtime",
    }
}

fn platform_segment(platform: ComponentPlatform) -> &'static str {
    match platform {
        ComponentPlatform::Windows => "windows",
        ComponentPlatform::Macos => "macos",
        ComponentPlatform::Linux => "linux",
    }
}

fn arch_segment(arch: ComponentArch) -> &'static str {
    match arch {
        ComponentArch::X86_64 => "x86_64",
        ComponentArch::Aarch64 => "aarch64",
    }
}

#[cfg(test)]
#[path = "component_store_tests.rs"]
mod tests;
