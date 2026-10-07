//! Immutable KalCode-owned snapshots of provider runtimes.
//!
//! Provider adapters stage the installed distribution here before probing it. A successful
//! capability and startup probe promotes that exact snapshot to last-known-good; failed probes
//! leave the prior runtime authoritative. The user's installation, configuration, and
//! credentials are never written or copied.

use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::ffi::{OsStr, OsString};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError, Weak};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const STORE_SCHEMA: u32 = 1;
const RECEIPT_SCHEMA: u32 = 1;
const POINTER_SCHEMA: u32 = 1;
const MAX_RECEIPT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_POINTER_BYTES: u64 = 16 * 1024;

/// Conservative bounds for a provider-owned runtime distribution. Current Codex packages are
/// hundreds of megabytes because they include sandbox, code-mode, ripgrep, and voice helpers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeStoreLimits {
    pub max_file_bytes: u64,
    pub max_total_bytes: u64,
    pub max_files: usize,
}

impl Default for RuntimeStoreLimits {
    fn default() -> Self {
        Self {
            max_file_bytes: 1024 * 1024 * 1024,
            max_total_bytes: 2 * 1024 * 1024 * 1024,
            max_files: 8_192,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum RuntimeStoreError {
    #[error("the provider runtime layout is unsafe")]
    UnsafeLayout,
    #[error("the provider runtime source is unsafe")]
    UnsafeSource,
    #[error("the provider runtime is missing")]
    RuntimeMissing,
    #[error("the provider runtime exceeds the managed-runtime limits")]
    RuntimeTooLarge,
    #[error("the managed provider runtime receipt is invalid")]
    InvalidReceipt,
    #[error("the managed provider runtime is corrupt")]
    CorruptSnapshot,
    #[error("the managed provider runtime pointer is invalid")]
    InvalidPointer,
    #[error("the managed provider runtime is not owned by this store")]
    ForeignRuntime,
    #[error("provider runtime storage failed")]
    Storage(#[source] io::Error),
}

fn storage(error: io::Error) -> RuntimeStoreError {
    RuntimeStoreError::Storage(error)
}

/// An explicit, credential-free provider distribution to snapshot.
///
/// `includes` are relative files or directories below `source_root`. The store recursively
/// copies only those paths; it never snapshots a provider home/config directory by inference.
#[derive(Debug, Clone)]
pub struct RuntimeLayout {
    source_root: PathBuf,
    executable_relative: PathBuf,
    includes: Vec<PathBuf>,
    environment: RuntimeEnvironmentPlan,
}

impl RuntimeLayout {
    pub fn new(
        source_root: impl AsRef<Path>,
        executable_relative: impl AsRef<Path>,
        includes: impl IntoIterator<Item = PathBuf>,
    ) -> Result<Self, RuntimeStoreError> {
        let source_root = fs::canonicalize(source_root.as_ref())
            .map_err(|_| RuntimeStoreError::RuntimeMissing)?;
        if !safe_directory(&fs::symlink_metadata(&source_root).map_err(storage)?) {
            return Err(RuntimeStoreError::UnsafeSource);
        }
        let executable_relative = executable_relative.as_ref().to_path_buf();
        if !safe_relative(&executable_relative) {
            return Err(RuntimeStoreError::UnsafeLayout);
        }
        let mut includes = includes.into_iter().collect::<Vec<_>>();
        if includes.is_empty() || includes.iter().any(|path| !safe_relative(path)) {
            return Err(RuntimeStoreError::UnsafeLayout);
        }
        includes.sort();
        includes.dedup();
        if !includes.iter().any(|include| {
            executable_relative == *include || executable_relative.starts_with(include)
        }) {
            return Err(RuntimeStoreError::UnsafeLayout);
        }
        let executable = source_root.join(&executable_relative);
        let file = open_regular_file(&executable).map_err(|_| RuntimeStoreError::RuntimeMissing)?;
        let metadata = file.metadata().map_err(storage)?;
        if !safe_file(&metadata) || !same_open_file(&executable, &file) {
            return Err(RuntimeStoreError::UnsafeSource);
        }
        let canonical = fs::canonicalize(&executable).map_err(storage)?;
        if !canonical.starts_with(&source_root) {
            return Err(RuntimeStoreError::UnsafeSource);
        }
        Ok(Self {
            source_root,
            executable_relative,
            includes,
            environment: RuntimeEnvironmentPlan::default(),
        })
    }

    pub fn source_root(&self) -> &Path {
        &self.source_root
    }

    pub fn executable_relative(&self) -> &Path {
        &self.executable_relative
    }

    fn with_environment(mut self, environment: RuntimeEnvironmentPlan) -> Self {
        self.environment = environment;
        self
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct RuntimeEnvironmentPlan {
    clear: Vec<String>,
    set: Vec<RuntimeEnvironmentEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct RuntimeEnvironmentEntry {
    key: String,
    value: RuntimeEnvironmentValue,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum RuntimeEnvironmentValue {
    SnapshotRoot,
    Literal(String),
}

/// Host families for provider-specific distribution resolution. Explicit variants make the
/// Windows and macOS layouts testable on either build host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimePlatform {
    WindowsX64,
    WindowsArm64,
    MacosX64,
    MacosArm64,
    LinuxX64,
    LinuxArm64,
}

impl RuntimePlatform {
    pub fn current() -> Result<Self, RuntimeStoreError> {
        match (std::env::consts::OS, std::env::consts::ARCH) {
            ("windows", "x86_64") => Ok(Self::WindowsX64),
            ("windows", "aarch64") => Ok(Self::WindowsArm64),
            ("macos", "x86_64") => Ok(Self::MacosX64),
            ("macos", "aarch64") => Ok(Self::MacosArm64),
            ("linux", "x86_64") => Ok(Self::LinuxX64),
            ("linux", "aarch64") => Ok(Self::LinuxArm64),
            _ => Err(RuntimeStoreError::UnsafeLayout),
        }
    }

    fn codex_parts(self) -> (&'static str, &'static str, &'static str) {
        match self {
            Self::WindowsX64 => ("codex-win32-x64", "x86_64-pc-windows-msvc", "codex.exe"),
            Self::WindowsArm64 => ("codex-win32-arm64", "aarch64-pc-windows-msvc", "codex.exe"),
            Self::MacosX64 => ("codex-darwin-x64", "x86_64-apple-darwin", "codex"),
            Self::MacosArm64 => ("codex-darwin-arm64", "aarch64-apple-darwin", "codex"),
            Self::LinuxX64 => ("codex-linux-x64", "x86_64-unknown-linux-musl", "codex"),
            Self::LinuxArm64 => ("codex-linux-arm64", "aarch64-unknown-linux-musl", "codex"),
        }
    }
}

/// Resolves the native Codex distribution behind a native binary, npm/pnpm Windows shim, or
/// npm Unix JavaScript entrypoint. The returned layout preserves Codex's native helpers and
/// resources while excluding the user's Codex home, credentials, MCP config, and sessions.
pub fn resolve_codex_runtime_layout(
    executable: &Path,
    provider_env: &BTreeMap<OsString, OsString>,
    platform: RuntimePlatform,
) -> Result<RuntimeLayout, RuntimeStoreError> {
    // Package managers expose Unix CLIs as symlinks (for example
    // `node_modules/.bin/codex -> ../@openai/codex/bin/codex.js`). Resolve only this
    // caller-selected discovery launcher. RuntimeLayout still rejects every symlink/reparse
    // point in the native payload copied into KalCode-owned storage.
    let launcher = fs::canonicalize(executable).map_err(|_| RuntimeStoreError::RuntimeMissing)?;
    if !launcher.is_file() {
        return Err(RuntimeStoreError::RuntimeMissing);
    }
    let (_, triple, native_name) = platform.codex_parts();
    let launch = crate::launch::resolve(executable, provider_env);
    let script = if is_javascript(&launcher) {
        Some(launcher.clone())
    } else if is_javascript(&launch.program) {
        Some(launch.program.clone())
    } else if let Some(target) = crate::launch::shim_target(executable) {
        is_javascript(&target).then_some(target)
    } else {
        launch
            .prefix_args
            .iter()
            .map(PathBuf::from)
            .find(|path| is_javascript(path) && path.is_file())
    };
    if let Some(script) = script {
        let bin = script.parent().ok_or(RuntimeStoreError::UnsafeLayout)?;
        if !bin
            .file_name()
            .and_then(OsStr::to_str)
            .is_some_and(|name| name.eq_ignore_ascii_case("bin"))
            || !script
                .file_name()
                .and_then(OsStr::to_str)
                .is_some_and(|name| name.eq_ignore_ascii_case("codex.js"))
        {
            return Err(RuntimeStoreError::UnsafeLayout);
        }
        let package_root = bin.parent().ok_or(RuntimeStoreError::UnsafeLayout)?;
        let (package, _, _) = platform.codex_parts();
        let nested = package_root
            .join("node_modules/@openai")
            .join(package)
            .join("vendor")
            .join(triple);
        // npm may either nest the optional platform package below `@openai/codex` or hoist it
        // beside that package below the same `@openai` scope (the official macOS 0.161 layout).
        let sibling = package_root
            .parent()
            .ok_or(RuntimeStoreError::UnsafeLayout)?
            .join(package)
            .join("vendor")
            .join(triple);
        let bundled = package_root.join("vendor").join(triple);
        let source_root = [nested, sibling, bundled]
            .into_iter()
            .find_map(|candidate| fs::canonicalize(candidate).ok())
            .ok_or(RuntimeStoreError::RuntimeMissing)?;
        let manager = codex_package_manager(&script, provider_env);
        return codex_native_layout(&source_root.join("bin").join(native_name), triple)
            .map(|layout| layout.with_environment(codex_wrapper_environment(manager)));
    }

    let native = if launch.program != executable && codex_native_name(&launch.program) {
        launch.program
    } else {
        launcher
    };
    codex_native_layout(&native, triple)
}

const CODEX_MANAGER_KEYS: [&str; 4] = [
    "CODEX_MANAGED_BY_NPM",
    "CODEX_MANAGED_BY_PNPM",
    "CODEX_MANAGED_BY_BUN",
    "CODEX_MANAGED_BY_VITE_PLUS",
];

fn codex_package_manager(
    script: &Path,
    environment: &BTreeMap<OsString, OsString>,
) -> &'static str {
    let lookup = |name: &str| {
        environment.iter().find_map(|(key, value)| {
            key.to_str()
                .is_some_and(|key| key.eq_ignore_ascii_case(name))
                .then(|| value.to_string_lossy().to_ascii_lowercase())
        })
    };
    let user_agent = lookup("npm_config_user_agent").unwrap_or_default();
    let exec_path = lookup("npm_execpath").unwrap_or_default();
    let script = script.to_string_lossy().to_ascii_lowercase();
    if user_agent.contains("bun/") || exec_path.contains("bun") || script.contains(".bun") {
        "CODEX_MANAGED_BY_BUN"
    } else if user_agent.contains("pnpm/") || exec_path.contains("pnpm") || script.contains(".pnpm")
    {
        "CODEX_MANAGED_BY_PNPM"
    } else if user_agent.contains("vite-plus")
        || exec_path.contains("vite-plus")
        || script.contains("vite-plus")
    {
        "CODEX_MANAGED_BY_VITE_PLUS"
    } else {
        "CODEX_MANAGED_BY_NPM"
    }
}

fn codex_wrapper_environment(manager: &str) -> RuntimeEnvironmentPlan {
    RuntimeEnvironmentPlan {
        clear: std::iter::once("CODEX_MANAGED_PACKAGE_ROOT")
            .chain(CODEX_MANAGER_KEYS)
            .map(str::to_owned)
            .collect(),
        set: vec![
            RuntimeEnvironmentEntry {
                key: "CODEX_MANAGED_PACKAGE_ROOT".into(),
                value: RuntimeEnvironmentValue::SnapshotRoot,
            },
            RuntimeEnvironmentEntry {
                key: manager.to_owned(),
                value: RuntimeEnvironmentValue::Literal("1".into()),
            },
        ],
    }
}

fn valid_environment(plan: &RuntimeEnvironmentPlan) -> bool {
    plan.clear.len() <= 16
        && plan.set.len() <= 16
        && plan.clear.iter().all(|key| safe_environment_key(key))
        && plan.set.iter().all(|entry| {
            safe_environment_key(&entry.key)
                && match &entry.value {
                    RuntimeEnvironmentValue::SnapshotRoot => true,
                    RuntimeEnvironmentValue::Literal(value) => {
                        value.len() <= 256 && !value.contains('\0')
                    }
                }
        })
}

fn safe_environment_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 64
        && key
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

fn apply_environment(
    plan: &RuntimeEnvironmentPlan,
    snapshot_root: &Path,
    environment: &mut BTreeMap<OsString, OsString>,
) {
    environment.retain(|key, _| {
        key.to_str().is_none_or(|key| {
            !plan
                .clear
                .iter()
                .any(|clear| key.eq_ignore_ascii_case(clear))
        })
    });
    for entry in &plan.set {
        let value = match &entry.value {
            RuntimeEnvironmentValue::SnapshotRoot => snapshot_root.as_os_str().to_owned(),
            RuntimeEnvironmentValue::Literal(value) => OsString::from(value),
        };
        environment.insert(OsString::from(&entry.key), value);
    }
}

fn is_javascript(path: &Path) -> bool {
    path.extension().and_then(OsStr::to_str).is_some_and(|ext| {
        ["js", "cjs", "mjs"]
            .iter()
            .any(|candidate| ext.eq_ignore_ascii_case(candidate))
    })
}

fn codex_native_name(path: &Path) -> bool {
    path.file_name()
        .and_then(OsStr::to_str)
        .is_some_and(|name| {
            name.eq_ignore_ascii_case("codex") || name.eq_ignore_ascii_case("codex.exe")
        })
}

fn codex_native_layout(
    native: &Path,
    expected_triple: &str,
) -> Result<RuntimeLayout, RuntimeStoreError> {
    let native = fs::canonicalize(native).map_err(|_| RuntimeStoreError::RuntimeMissing)?;
    if !codex_native_name(&native) {
        return Err(RuntimeStoreError::UnsafeLayout);
    }
    let bin = native.parent().ok_or(RuntimeStoreError::UnsafeLayout)?;
    let possible_root = bin.parent().ok_or(RuntimeStoreError::UnsafeLayout)?;
    let looks_like_distribution = possible_root
        .file_name()
        .and_then(OsStr::to_str)
        .is_some_and(|name| name == expected_triple)
        || possible_root.join("codex-package.json").is_file()
        || possible_root.join("codex-path").is_dir()
        || possible_root.join("codex-resources").is_dir();
    let (root, executable_relative) = if looks_like_distribution {
        (
            possible_root.to_path_buf(),
            native
                .strip_prefix(possible_root)
                .map_err(|_| RuntimeStoreError::UnsafeLayout)?
                .to_path_buf(),
        )
    } else {
        let name = native.file_name().ok_or(RuntimeStoreError::UnsafeLayout)?;
        (bin.to_path_buf(), PathBuf::from(name))
    };
    let mut includes = vec![executable_relative.clone()];
    if looks_like_distribution {
        for relative in [
            "bin/codex-code-mode-host",
            "bin/codex-code-mode-host.exe",
            "codex-path",
            "codex-resources",
            "codex-package.json",
        ] {
            if root.join(relative).exists() {
                includes.push(PathBuf::from(relative));
            }
        }
    }
    RuntimeLayout::new(root, executable_relative, includes)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ReceiptFile {
    path: String,
    bytes: u64,
    sha256: String,
    executable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Receipt {
    schema: u32,
    store_schema: u32,
    provider_id: String,
    source_fingerprint: String,
    executable: String,
    environment: RuntimeEnvironmentPlan,
    files: Vec<ReceiptFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Pointer {
    schema: u32,
    current: PointerEntry,
    previous: Option<PointerEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct PointerEntry {
    snapshot_id: String,
    version: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SourceStamp {
    path: PathBuf,
    relative: PathBuf,
    bytes: u64,
    modified_nanos: Option<u128>,
    created_nanos: Option<u128>,
    identity: FileIdentity,
    executable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MetadataStamp {
    path: PathBuf,
    bytes: u64,
    modified_nanos: Option<u128>,
    created_nanos: Option<u128>,
    identity: FileIdentity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum FileIdentity {
    #[cfg(windows)]
    Windows { volume: u32, index: u64 },
    #[cfg(unix)]
    Unix { device: u64, inode: u64 },
    #[cfg(not(any(unix, windows)))]
    Unsupported,
}

/// Cheap, opaque identity used by the provider-update watcher. It includes the executable,
/// launcher target, and (for Codex) the nested native distribution and helpers.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct InstallationFingerprint {
    files: Vec<InstallationFileStamp>,
}

type InstallationFileStamp = (PathBuf, u64, Option<u128>, Option<u128>, FileIdentity);

/// Computes a metadata-only installation identity. It performs no provider process, network,
/// or content read and is therefore safe for the background update watcher.
pub fn installation_fingerprint(
    executable: &Path,
    provider_env: &BTreeMap<OsString, OsString>,
) -> Option<InstallationFingerprint> {
    let launch = crate::launch::resolve(executable, provider_env);
    // Discovery launchers and their Node interpreters may legitimately be package-manager or
    // Homebrew symlinks. Fingerprint their canonical targets so a retarget changes the opaque
    // identity, while the runtime payload itself remains subject to nofollow copying below.
    let mut paths = vec![
        fs::canonicalize(executable).ok()?,
        fs::canonicalize(&launch.program).ok()?,
    ];
    paths.extend(
        launch
            .prefix_args
            .iter()
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .map(|path| fs::canonicalize(path).ok())
            .collect::<Option<Vec<_>>>()?,
    );
    let layout =
        resolve_codex_runtime_layout(executable, provider_env, RuntimePlatform::current().ok()?)
            .ok();
    if let Some(layout) = layout {
        paths.extend(
            collect_source_files(&layout, RuntimeStoreLimits::default())
                .ok()?
                .into_iter()
                .map(|source| source.path),
        );
    }
    paths.sort();
    paths.dedup();
    let mut files = paths
        .into_iter()
        .map(|path| {
            let file = open_regular_file(&path).ok()?;
            let metadata = file.metadata().ok()?;
            Some((
                path,
                metadata.len(),
                time_nanos(metadata.modified().ok()),
                time_nanos(metadata.created().ok()),
                file_identity(&file).ok()?,
            ))
        })
        .collect::<Option<Vec<_>>>()?;
    files.sort_by(|left, right| left.0.cmp(&right.0));
    Some(InstallationFingerprint { files })
}

#[derive(Debug)]
struct PinInner {
    store_root: PathBuf,
    provider_id: String,
    snapshot_id: String,
    snapshot_dir: PathBuf,
    executable: PathBuf,
    environment: RuntimeEnvironmentPlan,
    snapshot_stamps: Vec<MetadataStamp>,
    #[allow(dead_code)]
    lease_file: File,
}

/// An immutable staged runtime. Staging proves storage integrity, not protocol compatibility;
/// callers must probe this exact executable before promotion.
#[derive(Debug, Clone)]
pub struct PinnedRuntime {
    inner: Arc<PinInner>,
}

impl PinnedRuntime {
    pub fn executable(&self) -> &Path {
        &self.inner.executable
    }

    pub fn snapshot_id(&self) -> &str {
        &self.inner.snapshot_id
    }

    pub fn snapshot_dir(&self) -> &Path {
        &self.inner.snapshot_dir
    }

    /// Applies the credential-free environment behavior of the original provider launcher,
    /// rebasing runtime-owned paths into this immutable snapshot.
    pub fn configure_environment(&self, environment: &mut BTreeMap<OsString, OsString>) {
        apply_environment(
            &self.inner.environment,
            &self.inner.snapshot_dir,
            environment,
        );
    }
}

/// A staged runtime that passed the caller's provider-specific capability/startup smoke probe
/// and is now the store's current or previous last-known-good runtime.
#[derive(Debug, Clone)]
pub struct RuntimeLease {
    pinned: PinnedRuntime,
    version: Arc<str>,
}

impl RuntimeLease {
    pub fn executable(&self) -> &Path {
        self.pinned.executable()
    }

    pub fn version(&self) -> &str {
        &self.version
    }

    pub fn snapshot_id(&self) -> &str {
        self.pinned.snapshot_id()
    }

    pub fn snapshot_dir(&self) -> &Path {
        self.pinned.snapshot_dir()
    }

    pub fn configure_environment(&self, environment: &mut BTreeMap<OsString, OsString>) {
        self.pinned.configure_environment(environment);
    }
}

#[derive(Debug)]
struct StoreState {
    staged: HashMap<String, Weak<PinInner>>,
    snapshots: HashMap<String, Weak<PinInner>>,
}

/// Generic immutable runtime storage shared by CLI provider adapters. Provider-specific layout
/// discovery stays in adapters; publication, receipts, rollback, leases, and retention are
/// provider-independent.
#[derive(Debug, Clone)]
pub struct RuntimeStore {
    root: PathBuf,
    limits: RuntimeStoreLimits,
    state: Arc<Mutex<StoreState>>,
}

impl RuntimeStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self::with_limits(root, RuntimeStoreLimits::default())
    }

    pub fn with_limits(root: impl Into<PathBuf>, limits: RuntimeStoreLimits) -> Self {
        let root = root.into();
        Self {
            state: state_for(&root),
            root,
            limits,
        }
    }

    /// Returns an already-live immutable copy of this exact installed distribution without
    /// copying or hashing source contents. The background compatibility watcher retains the
    /// returned pin/lease after prewarming. Foreground launches use this cheap lookup to avoid
    /// racing that prewarm with a second hundreds-of-megabytes copy; a miss may safely run the
    /// freshly capability-probed installed CLI directly while background prewarm continues.
    pub fn cached_staged(
        &self,
        provider_id: &str,
        layout: &RuntimeLayout,
    ) -> Result<Option<PinnedRuntime>, RuntimeStoreError> {
        if !safe_identifier(provider_id) {
            return Err(RuntimeStoreError::UnsafeLayout);
        }
        let sources = collect_source_files(layout, self.limits)?;
        let source_fingerprint =
            source_fingerprint(&layout.source_root, &sources, &layout.environment)?;
        let cache_key = format!("{provider_id}\0{source_fingerprint}");
        Ok(lock(&self.state)
            .staged
            .get(&cache_key)
            .and_then(Weak::upgrade)
            .filter(|runtime| pin_intact(runtime))
            .map(|inner| PinnedRuntime { inner }))
    }

    /// Copies a distribution into content-addressed storage without changing last-known-good.
    /// The provider must be probed through the returned executable, then explicitly promoted.
    pub fn stage(
        &self,
        provider_id: &str,
        layout: &RuntimeLayout,
    ) -> Result<PinnedRuntime, RuntimeStoreError> {
        if !safe_identifier(provider_id) {
            return Err(RuntimeStoreError::UnsafeLayout);
        }
        let store_root = self.prepare_provider(provider_id)?;
        let provider_root = store_root.join(provider_id);
        let sources = collect_source_files(layout, self.limits)?;
        let source_fingerprint =
            source_fingerprint(&layout.source_root, &sources, &layout.environment)?;
        let cache_key = format!("{provider_id}\0{source_fingerprint}");
        if let Some(inner) = lock(&self.state)
            .staged
            .get(&cache_key)
            .and_then(Weak::upgrade)
            .filter(|runtime| pin_intact(runtime))
        {
            return Ok(PinnedRuntime { inner });
        }
        if let Some(existing) = self.find_existing(
            &store_root,
            provider_id,
            &source_fingerprint,
            &layout.environment,
        )? {
            lock(&self.state)
                .staged
                .insert(cache_key, Arc::downgrade(&existing.inner));
            return Ok(existing);
        }

        let stage_id = uuid::Uuid::new_v4().simple().to_string();
        let stage_lease_path = provider_root
            .join("leases")
            .join(format!("staging-{stage_id}.lock"));
        let stage_lease = open_lease_file(&stage_lease_path)?;
        fs2::FileExt::lock_shared(&stage_lease).map_err(storage)?;
        let staging = provider_root
            .join("staging")
            .join(format!("{stage_id}.partial"));
        if let Err(error) = fs::create_dir(&staging) {
            release_staging_lease(stage_lease, &stage_lease_path);
            return Err(storage(error));
        }
        let staged = (|| {
            let mut receipt_files = Vec::with_capacity(sources.len());
            for source in &sources {
                receipt_files.push(copy_source(source, &staging, &layout.source_root)?);
            }
            receipt_files.sort_by(|left, right| left.path.cmp(&right.path));
            let receipt = Receipt {
                schema: RECEIPT_SCHEMA,
                store_schema: STORE_SCHEMA,
                provider_id: provider_id.to_owned(),
                source_fingerprint,
                executable: relative_string(&layout.executable_relative)?,
                environment: layout.environment.clone(),
                files: receipt_files,
            };
            let snapshot_id = receipt_snapshot_id(&receipt)?;
            write_json_synced(&staging.join("receipt.json"), &receipt)?;
            sync_directory(&staging)?;
            Ok((receipt, snapshot_id))
        })();
        let (receipt, snapshot_id) = match staged {
            Ok(value) => value,
            Err(error) => {
                let _ = remove_runtime_tree(&staging);
                release_staging_lease(stage_lease, &stage_lease_path);
                return Err(error);
            }
        };
        let final_dir = provider_root.join("snapshots").join(&snapshot_id);
        let pinned = {
            let control = open_control_lock(&provider_root)?;
            fs2::FileExt::lock_exclusive(&control).map_err(storage)?;
            if final_dir.exists() {
                verify_snapshot(&final_dir, provider_id, Some(&snapshot_id), self.limits)?;
                remove_runtime_tree(&staging)?;
            } else {
                fs::rename(&staging, &final_dir).map_err(storage)?;
                let snapshot_parent = final_dir.parent().ok_or(RuntimeStoreError::UnsafeLayout)?;
                sync_directory(snapshot_parent)?;
            }
            let pinned = self.open_pin(&store_root, provider_id, &snapshot_id, &receipt)?;
            drop(control);
            pinned
        };
        lock(&self.state)
            .staged
            .insert(cache_key, Arc::downgrade(&pinned.inner));
        release_staging_lease(stage_lease, &stage_lease_path);
        Ok(pinned)
    }

    /// Makes a successfully probed staged runtime authoritative for future sessions.
    pub fn promote_validated(
        &self,
        runtime: &PinnedRuntime,
        version: &str,
    ) -> Result<RuntimeLease, RuntimeStoreError> {
        if version.is_empty() || version.len() > 128 {
            return Err(RuntimeStoreError::UnsafeLayout);
        }
        let store_root = self.prepare_provider(&runtime.inner.provider_id)?;
        if runtime.inner.store_root != store_root {
            return Err(RuntimeStoreError::ForeignRuntime);
        }
        let provider_root = store_root.join(&runtime.inner.provider_id);
        if !pin_intact(&runtime.inner) {
            verify_snapshot(
                &runtime.inner.snapshot_dir,
                &runtime.inner.provider_id,
                Some(&runtime.inner.snapshot_id),
                self.limits,
            )?;
        }
        let control = open_control_lock(&provider_root)?;
        fs2::FileExt::lock_exclusive(&control).map_err(storage)?;
        let old = read_pointer(&provider_root)?.map(|pointer| pointer.current);
        if old.as_ref().is_none_or(|entry| {
            entry.snapshot_id != runtime.snapshot_id() || entry.version != version
        }) {
            replace_pointer(
                &provider_root,
                &Pointer {
                    schema: POINTER_SCHEMA,
                    current: PointerEntry {
                        snapshot_id: runtime.snapshot_id().to_owned(),
                        version: version.to_owned(),
                    },
                    previous: old.filter(|entry| entry.snapshot_id != runtime.snapshot_id()),
                },
            )?;
        }
        drop(control);
        Ok(RuntimeLease {
            pinned: runtime.clone(),
            version: Arc::from(version),
        })
    }

    /// Opens the newest intact validated runtime. A corrupt current snapshot transparently
    /// rolls back to the previous validated snapshot; staged candidates are never selected.
    pub fn last_known_good(
        &self,
        provider_id: &str,
    ) -> Result<Option<RuntimeLease>, RuntimeStoreError> {
        let store_root = self.prepare_provider(provider_id)?;
        let provider_root = store_root.join(provider_id);
        let control = open_control_lock(&provider_root)?;
        fs2::FileExt::lock_exclusive(&control).map_err(storage)?;
        let Some(pointer) = read_pointer(&provider_root)? else {
            return Ok(None);
        };
        for (index, entry) in std::iter::once(&pointer.current)
            .chain(pointer.previous.iter())
            .enumerate()
        {
            let snapshot_id = &entry.snapshot_id;
            let snapshot = provider_root.join("snapshots").join(snapshot_id);
            if let Some(inner) = lock(&self.state)
                .snapshots
                .get(snapshot_id)
                .and_then(Weak::upgrade)
                .filter(|runtime| pin_intact(runtime))
            {
                if index != 0 {
                    replace_pointer(
                        &provider_root,
                        &Pointer {
                            schema: POINTER_SCHEMA,
                            current: entry.clone(),
                            previous: None,
                        },
                    )?;
                }
                return Ok(Some(RuntimeLease {
                    pinned: PinnedRuntime { inner },
                    version: Arc::from(entry.version.as_str()),
                }));
            }
            if let Ok(receipt) =
                verify_snapshot(&snapshot, provider_id, Some(snapshot_id), self.limits)
            {
                if index != 0 {
                    replace_pointer(
                        &provider_root,
                        &Pointer {
                            schema: POINTER_SCHEMA,
                            current: entry.clone(),
                            previous: None,
                        },
                    )?;
                }
                let pinned = self.open_pin(&store_root, provider_id, snapshot_id, &receipt)?;
                return Ok(Some(RuntimeLease {
                    pinned,
                    version: Arc::from(entry.version.as_str()),
                }));
            }
        }
        Ok(None)
    }

    /// Returns the bounded validated fallback chain (current, then previous), omitting corrupt
    /// snapshots. Callers apply fresh signed policy and capability probes to each candidate;
    /// storage integrity alone never overrides a newly learned known-bad version.
    pub fn validated_candidates(
        &self,
        provider_id: &str,
    ) -> Result<Vec<RuntimeLease>, RuntimeStoreError> {
        let store_root = self.prepare_provider(provider_id)?;
        let provider_root = store_root.join(provider_id);
        let control = open_control_lock(&provider_root)?;
        fs2::FileExt::lock_shared(&control).map_err(storage)?;
        let Some(pointer) = read_pointer(&provider_root)? else {
            return Ok(Vec::new());
        };
        let mut runtimes = Vec::with_capacity(2);
        for entry in std::iter::once(&pointer.current).chain(pointer.previous.iter()) {
            let snapshot_id = &entry.snapshot_id;
            let cached = lock(&self.state)
                .snapshots
                .get(snapshot_id)
                .and_then(Weak::upgrade)
                .filter(|runtime| pin_intact(runtime));
            let pinned = if let Some(inner) = cached {
                Some(PinnedRuntime { inner })
            } else {
                let snapshot = provider_root.join("snapshots").join(snapshot_id);
                verify_snapshot(&snapshot, provider_id, Some(snapshot_id), self.limits)
                    .ok()
                    .and_then(|receipt| {
                        self.open_pin(&store_root, provider_id, snapshot_id, &receipt)
                            .ok()
                    })
            };
            if let Some(pinned) = pinned {
                runtimes.push(RuntimeLease {
                    pinned,
                    version: Arc::from(entry.version.as_str()),
                });
            }
        }
        Ok(runtimes)
    }

    /// Reorders an already validated candidate after the caller has re-probed it against the
    /// current policy. This retains the displaced validated runtime as the previous fallback.
    pub fn prefer_validated(
        &self,
        runtime: &RuntimeLease,
    ) -> Result<RuntimeLease, RuntimeStoreError> {
        self.promote_validated(&runtime.pinned, runtime.version())
    }

    /// Explicit bounded-retention hook. It is intentionally never called by staging or launch:
    /// integration may invoke it during maintenance after all session owners retain leases.
    /// Current/previous LKG and every cross-process leased snapshot are always preserved.
    pub fn prune_unleased(
        &self,
        provider_id: &str,
        retain: usize,
    ) -> Result<usize, RuntimeStoreError> {
        let store_root = self.prepare_provider(provider_id)?;
        let provider_root = store_root.join(provider_id);
        let control = open_control_lock(&provider_root)?;
        fs2::FileExt::lock_exclusive(&control).map_err(storage)?;
        let pointer = read_pointer(&provider_root)?;
        let protected = pointer
            .iter()
            .flat_map(|pointer| {
                std::iter::once(pointer.current.snapshot_id.clone()).chain(
                    pointer
                        .previous
                        .as_ref()
                        .map(|entry| entry.snapshot_id.clone()),
                )
            })
            .collect::<BTreeSet<_>>();
        let snapshots = provider_root.join("snapshots");
        let mut entries = fs::read_dir(&snapshots)
            .map_err(storage)?
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
            .filter_map(|entry| {
                let id = entry.file_name().to_str()?.to_owned();
                let modified = entry.metadata().ok()?.modified().ok()?;
                valid_snapshot_id(&id).then_some((id, entry.path(), modified))
            })
            .collect::<Vec<_>>();
        entries.sort_by_key(|entry| Reverse(entry.2));
        let mut kept = 0usize;
        let mut removed = 0usize;
        for (id, path, _) in entries {
            if protected.contains(&id) || kept < retain {
                kept += 1;
                continue;
            }
            let lease_path = provider_root.join("leases").join(format!("{id}.lock"));
            let lease = open_lease_file(&lease_path)?;
            if fs2::FileExt::try_lock_exclusive(&lease).is_ok() {
                remove_runtime_tree(&path)?;
                removed += 1;
            }
        }
        let staging_root = provider_root.join("staging");
        for entry in fs::read_dir(&staging_root).map_err(storage)? {
            let entry = entry.map_err(storage)?;
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let Some(stage_id) = name.strip_suffix(".partial") else {
                continue;
            };
            if !valid_stage_id(stage_id) || !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            let lease_path = provider_root
                .join("leases")
                .join(format!("staging-{stage_id}.lock"));
            let lease = open_lease_file(&lease_path)?;
            if fs2::FileExt::try_lock_exclusive(&lease).is_ok() {
                remove_runtime_tree(&entry.path())?;
                drop(lease);
                let _ = fs::remove_file(lease_path);
                removed += 1;
            }
        }
        for entry in fs::read_dir(provider_root.join("leases")).map_err(storage)? {
            let entry = entry.map_err(storage)?;
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let Some(stage_id) = name
                .strip_prefix("staging-")
                .and_then(|name| name.strip_suffix(".lock"))
            else {
                continue;
            };
            if !valid_stage_id(stage_id)
                || staging_root.join(format!("{stage_id}.partial")).exists()
            {
                continue;
            }
            let lease = open_lease_file(&entry.path())?;
            if fs2::FileExt::try_lock_exclusive(&lease).is_ok() {
                drop(lease);
                let _ = fs::remove_file(entry.path());
            }
        }
        Ok(removed)
    }

    fn prepare_provider(&self, provider_id: &str) -> Result<PathBuf, RuntimeStoreError> {
        if !safe_identifier(provider_id) {
            return Err(RuntimeStoreError::UnsafeLayout);
        }
        create_safe_dir(&self.root)?;
        let root = fs::canonicalize(&self.root).map_err(storage)?;
        let provider = root.join(provider_id);
        create_safe_dir(&provider)?;
        for child in ["snapshots", "staging", "leases"] {
            create_safe_dir(&provider.join(child))?;
        }
        Ok(root)
    }

    fn find_existing(
        &self,
        store_root: &Path,
        provider_id: &str,
        source_fingerprint: &str,
        environment: &RuntimeEnvironmentPlan,
    ) -> Result<Option<PinnedRuntime>, RuntimeStoreError> {
        let provider_root = store_root.join(provider_id);
        let control = open_control_lock(&provider_root)?;
        fs2::FileExt::lock_shared(&control).map_err(storage)?;
        let snapshots = provider_root.join("snapshots");
        for entry in fs::read_dir(snapshots).map_err(storage)? {
            let entry = entry.map_err(storage)?;
            let Some(id) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if !valid_snapshot_id(&id) || !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            let Ok(candidate) = read_receipt(&entry.path()) else {
                continue;
            };
            if candidate.provider_id != provider_id
                || candidate.source_fingerprint != source_fingerprint
            {
                continue;
            }
            let Ok(receipt) = verify_snapshot(&entry.path(), provider_id, Some(&id), self.limits)
            else {
                continue;
            };
            if receipt.source_fingerprint == source_fingerprint
                && receipt.environment == *environment
            {
                return self
                    .open_pin(store_root, provider_id, &id, &receipt)
                    .map(Some);
            }
        }
        Ok(None)
    }

    fn open_pin(
        &self,
        store_root: &Path,
        provider_id: &str,
        snapshot_id: &str,
        receipt: &Receipt,
    ) -> Result<PinnedRuntime, RuntimeStoreError> {
        let provider_root = store_root.join(provider_id);
        let lease_path = provider_root
            .join("leases")
            .join(format!("{snapshot_id}.lock"));
        let lease_file = open_lease_file(&lease_path)?;
        fs2::FileExt::lock_shared(&lease_file).map_err(storage)?;
        let snapshot_dir = provider_root.join("snapshots").join(snapshot_id);
        let executable = snapshot_dir.join(&receipt.executable);
        let snapshot_stamps = snapshot_stamps(&snapshot_dir, receipt)?;
        let inner = Arc::new(PinInner {
            store_root: store_root.to_path_buf(),
            provider_id: provider_id.to_owned(),
            snapshot_id: snapshot_id.to_owned(),
            snapshot_dir,
            executable,
            environment: receipt.environment.clone(),
            snapshot_stamps,
            lease_file,
        });
        lock(&self.state)
            .snapshots
            .insert(snapshot_id.to_owned(), Arc::downgrade(&inner));
        Ok(PinnedRuntime { inner })
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn state_for(root: &Path) -> Arc<Mutex<StoreState>> {
    static STATES: LazyLock<Mutex<HashMap<PathBuf, Arc<Mutex<StoreState>>>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));
    let mut states = lock(&STATES);
    if let Some(state) = states.get(root) {
        return Arc::clone(state);
    }
    let state = Arc::new(Mutex::new(StoreState {
        staged: HashMap::new(),
        snapshots: HashMap::new(),
    }));
    // Production has one data root. Tests use temporary roots, so cap abandoned empty states
    // without ever evicting one that still has a live store or staged pin.
    if states.len() >= 64 {
        states.retain(|_, state| {
            Arc::strong_count(state) > 1 || {
                let state = lock(state);
                state
                    .staged
                    .values()
                    .chain(state.snapshots.values())
                    .any(|runtime| runtime.strong_count() != 0)
            }
        });
    }
    states.insert(root.to_path_buf(), Arc::clone(&state));
    state
}

fn snapshot_stamps(
    snapshot: &Path,
    receipt: &Receipt,
) -> Result<Vec<MetadataStamp>, RuntimeStoreError> {
    let expected = std::iter::once(PathBuf::from("receipt.json"))
        .chain(receipt.files.iter().map(|file| PathBuf::from(&file.path)))
        .map(|relative| snapshot.join(relative))
        .collect::<BTreeSet<_>>();
    let actual = snapshot_file_paths(snapshot)?;
    if actual.iter().cloned().collect::<BTreeSet<_>>() != expected {
        return Err(RuntimeStoreError::CorruptSnapshot);
    }
    actual
        .into_iter()
        .map(|path| {
            let file = open_regular_file(&path)?;
            let metadata = file.metadata().map_err(storage)?;
            Ok(MetadataStamp {
                path,
                bytes: metadata.len(),
                modified_nanos: time_nanos(metadata.modified().ok()),
                created_nanos: time_nanos(metadata.created().ok()),
                identity: file_identity(&file)?,
            })
        })
        .collect()
}

fn pin_intact(runtime: &PinInner) -> bool {
    let Ok(paths) = snapshot_file_paths(&runtime.snapshot_dir) else {
        return false;
    };
    paths.len() == runtime.snapshot_stamps.len()
        && paths
            .iter()
            .zip(&runtime.snapshot_stamps)
            .all(|(path, stamp)| path == &stamp.path)
        && runtime.snapshot_stamps.iter().all(|stamp| {
            open_regular_file(&stamp.path).is_ok_and(|file| {
                file.metadata().is_ok_and(|metadata| {
                    safe_file(&metadata)
                        && metadata.len() == stamp.bytes
                        && time_nanos(metadata.modified().ok()) == stamp.modified_nanos
                        && time_nanos(metadata.created().ok()) == stamp.created_nanos
                        && file_identity(&file).ok() == Some(stamp.identity)
                })
            })
        })
}

fn snapshot_file_paths(snapshot: &Path) -> Result<Vec<PathBuf>, RuntimeStoreError> {
    let mut stack = vec![snapshot.to_path_buf()];
    let mut files = Vec::new();
    while let Some(directory) = stack.pop() {
        let metadata =
            fs::symlink_metadata(&directory).map_err(|_| RuntimeStoreError::CorruptSnapshot)?;
        if !safe_directory(&metadata) {
            return Err(RuntimeStoreError::CorruptSnapshot);
        }
        for entry in fs::read_dir(&directory).map_err(storage)? {
            let entry = entry.map_err(storage)?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(storage)?;
            if safe_directory(&metadata) {
                stack.push(path);
            } else if safe_file(&metadata) {
                files.push(path);
            } else {
                return Err(RuntimeStoreError::CorruptSnapshot);
            }
        }
    }
    files.sort();
    Ok(files)
}

fn safe_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn safe_relative(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn time_nanos(time: Option<SystemTime>) -> Option<u128> {
    time?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|value| value.as_nanos())
}

fn executable(metadata: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        true
    }
}

fn collect_source_files(
    layout: &RuntimeLayout,
    limits: RuntimeStoreLimits,
) -> Result<Vec<SourceStamp>, RuntimeStoreError> {
    let mut files = BTreeMap::<PathBuf, SourceStamp>::new();
    let mut stack = layout.includes.clone();
    while let Some(relative) = stack.pop() {
        if !safe_relative(&relative) {
            return Err(RuntimeStoreError::UnsafeLayout);
        }
        let path = layout.source_root.join(&relative);
        let metadata =
            fs::symlink_metadata(&path).map_err(|_| RuntimeStoreError::RuntimeMissing)?;
        if safe_directory(&metadata) {
            for entry in fs::read_dir(&path).map_err(storage)? {
                let entry = entry.map_err(storage)?;
                stack.push(relative.join(entry.file_name()));
            }
            continue;
        }
        if !safe_file(&metadata) {
            return Err(RuntimeStoreError::UnsafeSource);
        }
        let file = open_regular_file(&path)?;
        let metadata = file.metadata().map_err(storage)?;
        if !same_open_file(&path, &file) {
            return Err(RuntimeStoreError::UnsafeSource);
        }
        let canonical = fs::canonicalize(&path).map_err(storage)?;
        if !canonical.starts_with(&layout.source_root) {
            return Err(RuntimeStoreError::UnsafeSource);
        }
        if relative == Path::new("receipt.json") {
            return Err(RuntimeStoreError::UnsafeLayout);
        }
        if metadata.len() > limits.max_file_bytes {
            return Err(RuntimeStoreError::RuntimeTooLarge);
        }
        files.insert(
            relative.clone(),
            SourceStamp {
                path,
                relative,
                bytes: metadata.len(),
                modified_nanos: time_nanos(metadata.modified().ok()),
                created_nanos: time_nanos(metadata.created().ok()),
                identity: file_identity(&file)?,
                executable: executable(&metadata),
            },
        );
        if files.len() > limits.max_files
            || files
                .values()
                .try_fold(0u64, |total, file| total.checked_add(file.bytes))
                .is_none_or(|total| total > limits.max_total_bytes)
        {
            return Err(RuntimeStoreError::RuntimeTooLarge);
        }
    }
    if !files.contains_key(&layout.executable_relative) {
        return Err(RuntimeStoreError::UnsafeLayout);
    }
    Ok(files.into_values().collect())
}

fn source_fingerprint(
    root: &Path,
    files: &[SourceStamp],
    environment: &RuntimeEnvironmentPlan,
) -> Result<String, RuntimeStoreError> {
    let mut hasher = Sha256::new();
    hash_field(&mut hasher, root.to_string_lossy().as_bytes());
    let environment =
        serde_json::to_vec(environment).map_err(|_| RuntimeStoreError::UnsafeLayout)?;
    hash_field(&mut hasher, &environment);
    for file in files {
        hash_field(
            &mut hasher,
            relative_string_lossy(&file.relative).as_bytes(),
        );
        hash_field(&mut hasher, &file.bytes.to_le_bytes());
        hash_field(
            &mut hasher,
            &file.modified_nanos.unwrap_or(u128::MAX).to_le_bytes(),
        );
        hash_field(
            &mut hasher,
            &file.created_nanos.unwrap_or(u128::MAX).to_le_bytes(),
        );
        hash_field(&mut hasher, format!("{:?}", file.identity).as_bytes());
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn copy_source(
    source: &SourceStamp,
    staging: &Path,
    source_root: &Path,
) -> Result<ReceiptFile, RuntimeStoreError> {
    let mut input = open_regular_file(&source.path)?;
    let before = input.metadata().map_err(storage)?;
    if !safe_file(&before)
        || before.len() != source.bytes
        || time_nanos(before.modified().ok()) != source.modified_nanos
        || time_nanos(before.created().ok()) != source.created_nanos
        || file_identity(&input)? != source.identity
        || !fs::canonicalize(&source.path)
            .map_err(storage)?
            .starts_with(source_root)
        || !same_open_file(&source.path, &input)
    {
        return Err(RuntimeStoreError::UnsafeSource);
    }
    let destination = staging.join(&source.relative);
    fs::create_dir_all(
        destination
            .parent()
            .ok_or(RuntimeStoreError::UnsafeLayout)?,
    )
    .map_err(storage)?;
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&destination)
        .map_err(storage)?;
    let mut hasher = Sha256::new();
    let mut copied = 0u64;
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = input.read(&mut buffer).map_err(storage)?;
        if read == 0 {
            break;
        }
        copied = copied
            .checked_add(u64::try_from(read).map_err(|_| RuntimeStoreError::RuntimeTooLarge)?)
            .ok_or(RuntimeStoreError::RuntimeTooLarge)?;
        if copied > source.bytes {
            return Err(RuntimeStoreError::UnsafeSource);
        }
        output.write_all(&buffer[..read]).map_err(storage)?;
        hasher.update(&buffer[..read]);
    }
    output.sync_all().map_err(storage)?;
    if copied != source.bytes {
        return Err(RuntimeStoreError::UnsafeSource);
    }
    let after = input.metadata().map_err(storage)?;
    if !safe_file(&after)
        || after.len() != source.bytes
        || time_nanos(after.modified().ok()) != source.modified_nanos
        || time_nanos(after.created().ok()) != source.created_nanos
        || file_identity(&input)? != source.identity
        || !same_open_file(&source.path, &input)
    {
        return Err(RuntimeStoreError::UnsafeSource);
    }
    make_immutable(&destination, source.executable)?;
    Ok(ReceiptFile {
        path: relative_string(&source.relative)?,
        bytes: copied,
        sha256: format!("{:x}", hasher.finalize()),
        executable: source.executable,
    })
}

fn receipt_snapshot_id(receipt: &Receipt) -> Result<String, RuntimeStoreError> {
    let bytes = serde_json::to_vec(receipt).map_err(|_| RuntimeStoreError::InvalidReceipt)?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn verify_snapshot(
    snapshot: &Path,
    provider_id: &str,
    expected_id: Option<&str>,
    limits: RuntimeStoreLimits,
) -> Result<Receipt, RuntimeStoreError> {
    let metadata =
        fs::symlink_metadata(snapshot).map_err(|_| RuntimeStoreError::CorruptSnapshot)?;
    if !safe_directory(&metadata) {
        return Err(RuntimeStoreError::CorruptSnapshot);
    }
    let receipt = read_receipt(snapshot)?;
    if receipt.schema != RECEIPT_SCHEMA
        || receipt.store_schema != STORE_SCHEMA
        || receipt.provider_id != provider_id
        || !safe_relative(Path::new(&receipt.executable))
        || !valid_environment(&receipt.environment)
        || receipt.files.is_empty()
        || receipt.files.len() > limits.max_files
        || expected_id.is_some_and(|expected| {
            !receipt_snapshot_id(&receipt).is_ok_and(|actual| actual == expected)
        })
    {
        return Err(RuntimeStoreError::InvalidReceipt);
    }
    let mut recorded = BTreeSet::new();
    let mut total = 0u64;
    for file in &receipt.files {
        let relative = Path::new(&file.path);
        if !safe_relative(relative)
            || !recorded.insert(file.path.clone())
            || file.bytes > limits.max_file_bytes
        {
            return Err(RuntimeStoreError::InvalidReceipt);
        }
        total = total
            .checked_add(file.bytes)
            .ok_or(RuntimeStoreError::RuntimeTooLarge)?;
        if total > limits.max_total_bytes {
            return Err(RuntimeStoreError::RuntimeTooLarge);
        }
        let path = snapshot.join(relative);
        let metadata =
            fs::symlink_metadata(&path).map_err(|_| RuntimeStoreError::CorruptSnapshot)?;
        if !safe_file(&metadata) || metadata.len() != file.bytes {
            return Err(RuntimeStoreError::CorruptSnapshot);
        }
        let canonical = fs::canonicalize(&path).map_err(storage)?;
        if !canonical.starts_with(snapshot) {
            return Err(RuntimeStoreError::CorruptSnapshot);
        }
        if hash_file(&path, file.bytes)? != file.sha256 {
            return Err(RuntimeStoreError::CorruptSnapshot);
        }
    }
    if !recorded.contains(&receipt.executable) {
        return Err(RuntimeStoreError::InvalidReceipt);
    }
    let actual = snapshot_file_paths(snapshot)?
        .into_iter()
        .filter_map(|path| path.strip_prefix(snapshot).ok().map(relative_string))
        .collect::<Result<BTreeSet<_>, _>>()?;
    let expected = recorded
        .iter()
        .cloned()
        .chain(std::iter::once("receipt.json".to_owned()))
        .collect::<BTreeSet<_>>();
    if actual != expected {
        return Err(RuntimeStoreError::CorruptSnapshot);
    }
    Ok(receipt)
}

fn hash_file(path: &Path, expected_bytes: u64) -> Result<String, RuntimeStoreError> {
    let mut file = open_regular_file(path)?;
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(storage)?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(u64::try_from(read).map_err(|_| RuntimeStoreError::RuntimeTooLarge)?)
            .ok_or(RuntimeStoreError::RuntimeTooLarge)?;
        if total > expected_bytes {
            return Err(RuntimeStoreError::CorruptSnapshot);
        }
        hasher.update(&buffer[..read]);
    }
    if total != expected_bytes {
        return Err(RuntimeStoreError::CorruptSnapshot);
    }
    if !same_open_file(path, &file) {
        return Err(RuntimeStoreError::CorruptSnapshot);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn read_receipt(snapshot: &Path) -> Result<Receipt, RuntimeStoreError> {
    read_json_limited(&snapshot.join("receipt.json"), MAX_RECEIPT_BYTES)
        .map_err(|_| RuntimeStoreError::InvalidReceipt)
}

fn valid_snapshot_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_stage_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn read_pointer(provider_root: &Path) -> Result<Option<Pointer>, RuntimeStoreError> {
    let primary = provider_root.join("current.json");
    let backup = provider_root.join("current.previous.json");
    for path in [primary, backup] {
        if !path.exists() {
            continue;
        }
        let Ok(pointer) = read_json_limited::<Pointer>(&path, MAX_POINTER_BYTES) else {
            continue;
        };
        if pointer.schema == POINTER_SCHEMA
            && valid_pointer_entry(&pointer.current)
            && pointer.previous.as_ref().is_none_or(|previous| {
                valid_pointer_entry(previous) && previous.snapshot_id != pointer.current.snapshot_id
            })
        {
            return Ok(Some(pointer));
        }
    }
    Ok(None)
}

fn valid_pointer_entry(entry: &PointerEntry) -> bool {
    valid_snapshot_id(&entry.snapshot_id) && !entry.version.is_empty() && entry.version.len() <= 128
}

fn replace_pointer(provider_root: &Path, pointer: &Pointer) -> Result<(), RuntimeStoreError> {
    let primary = provider_root.join("current.json");
    let backup = provider_root.join("current.previous.json");
    let next = provider_root.join(format!("current.{}.next", uuid::Uuid::new_v4().simple()));
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
    sync_directory(provider_root)
}

fn read_json_limited<T: for<'de> Deserialize<'de>>(
    path: &Path,
    limit: u64,
) -> Result<T, RuntimeStoreError> {
    let metadata = fs::symlink_metadata(path).map_err(storage)?;
    if !safe_file(&metadata) || metadata.len() > limit {
        return Err(RuntimeStoreError::InvalidReceipt);
    }
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(0));
    let mut file = open_regular_file(path)?;
    (&mut file)
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(storage)?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > limit {
        return Err(RuntimeStoreError::InvalidReceipt);
    }
    if !same_open_file(path, &file) {
        return Err(RuntimeStoreError::InvalidReceipt);
    }
    serde_json::from_slice(&bytes).map_err(|_| RuntimeStoreError::InvalidReceipt)
}

fn write_json_synced<T: Serialize>(path: &Path, value: &T) -> Result<(), RuntimeStoreError> {
    let bytes = serde_json::to_vec(value).map_err(|_| RuntimeStoreError::InvalidReceipt)?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(storage)?;
    file.write_all(&bytes).map_err(storage)?;
    file.sync_all().map_err(storage)
}

fn open_control_lock(provider_root: &Path) -> Result<File, RuntimeStoreError> {
    open_lock_file(&provider_root.join("store.lock"))
}

fn open_regular_file(path: &Path) -> Result<File, RuntimeStoreError> {
    #[cfg(unix)]
    let file = {
        use std::os::unix::fs::OpenOptionsExt as _;

        OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
            .map_err(storage)?
    };
    #[cfg(windows)]
    let file = {
        use std::os::windows::fs::OpenOptionsExt as _;

        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(storage)?
    };
    #[cfg(not(any(unix, windows)))]
    let file = OpenOptions::new().read(true).open(path).map_err(storage)?;
    if !safe_file(&file.metadata().map_err(storage)?) || !same_open_file(path, &file) {
        return Err(RuntimeStoreError::UnsafeSource);
    }
    Ok(file)
}

fn same_open_file(path: &Path, file: &File) -> bool {
    let Ok(opened) = file.try_clone().and_then(same_file::Handle::from_file) else {
        return false;
    };
    same_file::Handle::from_path(path).is_ok_and(|current| current == opened)
}

#[cfg(unix)]
fn file_identity(file: &File) -> Result<FileIdentity, RuntimeStoreError> {
    use std::os::unix::fs::MetadataExt as _;

    let metadata = file.metadata().map_err(storage)?;
    Ok(FileIdentity::Unix {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn file_identity(file: &File) -> Result<FileIdentity, RuntimeStoreError> {
    use std::os::windows::io::AsRawHandle as _;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };

    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: `file` owns a live handle and `information` is writable storage of the exact
    // structure requested by GetFileInformationByHandle.
    unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &raw mut information) }
        .map_err(|error| storage(io::Error::other(error.to_string())))?;
    Ok(FileIdentity::Windows {
        volume: information.dwVolumeSerialNumber,
        index: (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow),
    })
}

#[cfg(not(any(unix, windows)))]
fn file_identity(_file: &File) -> Result<FileIdentity, RuntimeStoreError> {
    Ok(FileIdentity::Unsupported)
}

fn open_lease_file(path: &Path) -> Result<File, RuntimeStoreError> {
    open_lock_file(path)
}

fn release_staging_lease(file: File, path: &Path) {
    let _ = fs2::FileExt::unlock(&file);
    drop(file);
    let _ = fs::remove_file(path);
}

fn open_lock_file(path: &Path) -> Result<File, RuntimeStoreError> {
    #[cfg(unix)]
    let file = {
        use std::os::unix::fs::OpenOptionsExt as _;

        OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
            .map_err(storage)?
    };
    #[cfg(windows)]
    let file = {
        use std::os::windows::fs::OpenOptionsExt as _;

        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(storage)?
    };
    #[cfg(not(any(unix, windows)))]
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(path)
        .map_err(storage)?;
    let metadata = fs::symlink_metadata(path).map_err(storage)?;
    if !safe_file(&metadata) {
        return Err(RuntimeStoreError::UnsafeSource);
    }
    Ok(file)
}

fn create_safe_dir(path: &Path) -> Result<(), RuntimeStoreError> {
    fs::create_dir_all(path).map_err(storage)?;
    let metadata = fs::symlink_metadata(path).map_err(storage)?;
    if safe_directory(&metadata) {
        Ok(())
    } else {
        Err(RuntimeStoreError::UnsafeSource)
    }
}

#[cfg(windows)]
fn safe_directory(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt as _;

    const REPARSE_POINT: u32 = 0x400;
    metadata.is_dir()
        && !metadata.file_type().is_symlink()
        && metadata.file_attributes() & REPARSE_POINT == 0
}

#[cfg(not(windows))]
fn safe_directory(metadata: &fs::Metadata) -> bool {
    metadata.is_dir() && !metadata.file_type().is_symlink()
}

#[cfg(windows)]
fn safe_file(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt as _;

    const REPARSE_POINT: u32 = 0x400;
    metadata.is_file()
        && !metadata.file_type().is_symlink()
        && metadata.file_attributes() & REPARSE_POINT == 0
}

#[cfg(not(windows))]
fn safe_file(metadata: &fs::Metadata) -> bool {
    metadata.is_file() && !metadata.file_type().is_symlink()
}

fn make_immutable(path: &Path, is_executable: bool) -> Result<(), RuntimeStoreError> {
    let mut permissions = fs::metadata(path).map_err(storage)?.permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        permissions.set_mode(if is_executable { 0o500 } else { 0o400 });
    }
    #[cfg(not(unix))]
    {
        let _ = is_executable;
        permissions.set_readonly(true);
    }
    fs::set_permissions(path, permissions).map_err(storage)
}

#[cfg(windows)]
fn clear_windows_readonly(path: &Path, metadata: &fs::Metadata) -> Result<(), RuntimeStoreError> {
    let mut permissions = metadata.permissions();
    if permissions.readonly() {
        // On Windows this toggles the filesystem readonly attribute; it does not broaden Unix
        // mode bits because this helper is not compiled there.
        #[allow(clippy::permissions_set_readonly_false)]
        permissions.set_readonly(false);
        fs::set_permissions(path, permissions).map_err(storage)?;
    }
    Ok(())
}

fn remove_runtime_tree(path: &Path) -> Result<(), RuntimeStoreError> {
    let metadata = fs::symlink_metadata(path).map_err(storage)?;
    if !safe_directory(&metadata) {
        return Err(RuntimeStoreError::UnsafeSource);
    }
    for entry in fs::read_dir(path).map_err(storage)? {
        let entry = entry.map_err(storage)?;
        let child = entry.path();
        let metadata = fs::symlink_metadata(&child).map_err(storage)?;
        if safe_directory(&metadata) {
            remove_runtime_tree(&child)?;
        } else if safe_file(&metadata) {
            #[cfg(windows)]
            clear_windows_readonly(&child, &metadata)?;
            fs::remove_file(child).map_err(storage)?;
        } else {
            return Err(RuntimeStoreError::UnsafeSource);
        }
    }
    fs::remove_dir(path).map_err(storage)
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), RuntimeStoreError> {
    File::open(path)
        .map_err(storage)?
        .sync_all()
        .map_err(storage)
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), RuntimeStoreError> {
    Ok(())
}

fn relative_string(path: &Path) -> Result<String, RuntimeStoreError> {
    path.to_str()
        .map(|value| value.replace('\\', "/"))
        .filter(|value| !value.is_empty())
        .ok_or(RuntimeStoreError::UnsafeLayout)
}

fn relative_string_lossy(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn hash_field(hasher: &mut Sha256, bytes: &[u8]) {
    hasher.update(u64::try_from(bytes.len()).unwrap_or(u64::MAX).to_le_bytes());
    hasher.update(bytes);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::ffi::{OsString, OsString as StringOs};
    use std::path::{Path, PathBuf};

    fn write(path: impl AsRef<Path>, bytes: impl AsRef<[u8]>) {
        let path = path.as_ref();
        std::fs::create_dir_all(path.parent().expect("parent")).expect("create parent");
        std::fs::write(path, bytes).expect("write fixture");
    }

    fn make_fixture_writable(path: &Path) {
        let mut permissions = std::fs::metadata(path).unwrap().permissions();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            permissions.set_mode(permissions.mode() | 0o200);
        }
        #[cfg(windows)]
        {
            // Windows exposes a readonly attribute through Permissions; this does not alter
            // Unix mode bits because this branch is not compiled there.
            #[allow(clippy::permissions_set_readonly_false)]
            permissions.set_readonly(false);
        }
        std::fs::set_permissions(path, permissions).expect("make fixture writable");
    }

    fn fixture(root: &Path, marker: &str) -> RuntimeLayout {
        write(root.join("bin/codex.exe"), format!("codex-{marker}"));
        write(
            root.join("bin/codex-code-mode-host.exe"),
            format!("host-{marker}"),
        );
        write(root.join("codex-path/rg.exe"), format!("rg-{marker}"));
        write(
            root.join("codex-resources/codex-command-runner.exe"),
            format!("runner-{marker}"),
        );
        RuntimeLayout::new(
            root,
            Path::new("bin/codex.exe"),
            [
                PathBuf::from("bin"),
                PathBuf::from("codex-path"),
                PathBuf::from("codex-resources"),
            ],
        )
        .expect("layout")
    }

    #[test]
    fn validated_snapshot_is_owned_and_survives_global_change_or_removal() {
        let temp = tempfile::tempdir().expect("temp");
        let source = temp.path().join("global/vendor/triple");
        let store = RuntimeStore::new(temp.path().join("kalcode"));
        let staged = store
            .stage("codex", &fixture(&source, "old"))
            .expect("stage");
        assert_ne!(staged.executable(), source.join("bin/codex.exe"));
        assert_eq!(std::fs::read(staged.executable()).unwrap(), b"codex-old");
        assert_eq!(
            std::fs::read(staged.snapshot_dir().join("codex-path/rg.exe")).unwrap(),
            b"rg-old"
        );

        let lease = store
            .promote_validated(&staged, "0.161.0")
            .expect("promote");
        std::fs::remove_dir_all(temp.path().join("global")).expect("remove global install");
        assert_eq!(std::fs::read(lease.executable()).unwrap(), b"codex-old");
        let recovered = store
            .last_known_good("codex")
            .expect("recover")
            .expect("lkg");
        assert_eq!(recovered.snapshot_id(), lease.snapshot_id());
    }

    #[test]
    fn old_active_runtime_stays_pinned_while_new_sessions_use_new_runtime() {
        let temp = tempfile::tempdir().expect("temp");
        let source = temp.path().join("global/vendor/triple");
        let store = RuntimeStore::new(temp.path().join("kalcode"));
        let old = store
            .stage("codex", &fixture(&source, "old"))
            .and_then(|staged| store.promote_validated(&staged, "0.160.0"))
            .expect("old");

        std::fs::remove_dir_all(&source).expect("replace global package");
        let new = store
            .stage("codex", &fixture(&source, "new"))
            .and_then(|staged| store.promote_validated(&staged, "0.161.0"))
            .expect("new");

        assert_ne!(old.snapshot_id(), new.snapshot_id());
        assert_eq!(old.version(), "0.160.0");
        assert_eq!(new.version(), "0.161.0");
        assert_eq!(std::fs::read(old.executable()).unwrap(), b"codex-old");
        assert_eq!(std::fs::read(new.executable()).unwrap(), b"codex-new");
    }

    #[test]
    fn corrupt_current_snapshot_rolls_back_to_intact_previous() {
        let temp = tempfile::tempdir().expect("temp");
        let source = temp.path().join("global/vendor/triple");
        let store = RuntimeStore::new(temp.path().join("kalcode"));
        let old = store
            .stage("codex", &fixture(&source, "old"))
            .and_then(|staged| store.promote_validated(&staged, "0.160.0"))
            .expect("old");
        std::fs::remove_dir_all(&source).expect("replace");
        let new = store
            .stage("codex", &fixture(&source, "new"))
            .and_then(|staged| store.promote_validated(&staged, "0.161.0"))
            .expect("new");
        make_fixture_writable(new.executable());
        std::fs::write(new.executable(), b"tampered").expect("tamper");

        let recovered = store
            .last_known_good("codex")
            .expect("recover")
            .expect("previous remains");
        assert_eq!(recovered.snapshot_id(), old.snapshot_id());
        assert_eq!(std::fs::read(recovered.executable()).unwrap(), b"codex-old");
    }

    #[test]
    fn staging_same_unchanged_distribution_reuses_content_addressed_snapshot() {
        let temp = tempfile::tempdir().expect("temp");
        let source = temp.path().join("global/vendor/triple");
        let store = RuntimeStore::new(temp.path().join("kalcode"));
        let layout = fixture(&source, "same");
        assert!(
            store.cached_staged("codex", &layout).unwrap().is_none(),
            "foreground lookup must not copy on a prewarm miss"
        );
        let first = store.stage("codex", &layout).expect("first");
        let cached = store
            .cached_staged("codex", &layout)
            .unwrap()
            .expect("live prewarm");
        assert_eq!(cached.snapshot_id(), first.snapshot_id());
        let receipt_modified = std::fs::metadata(first.snapshot_dir().join("receipt.json"))
            .unwrap()
            .modified()
            .unwrap();
        let second = store.stage("codex", &layout).expect("second");
        assert_eq!(first.snapshot_id(), second.snapshot_id());
        assert_eq!(
            std::fs::metadata(second.snapshot_dir().join("receipt.json"))
                .unwrap()
                .modified()
                .unwrap(),
            receipt_modified,
            "warm staging must not recopy an unchanged runtime"
        );
        drop(cached);
    }

    #[test]
    fn staged_cache_identity_includes_launcher_environment_semantics() {
        let temp = tempfile::tempdir().expect("temp");
        let source = temp.path().join("global/vendor/triple");
        let store = RuntimeStore::new(temp.path().join("kalcode"));
        let base = fixture(&source, "same-native-bytes");
        let npm = base
            .clone()
            .with_environment(codex_wrapper_environment("CODEX_MANAGED_BY_NPM"));
        let pnpm = base.with_environment(codex_wrapper_environment("CODEX_MANAGED_BY_PNPM"));
        let npm_pin = store.stage("codex", &npm).expect("npm stage");

        assert!(
            store.cached_staged("codex", &pnpm).unwrap().is_none(),
            "a live payload pin must not carry stale wrapper environment semantics"
        );
        let pnpm_pin = store.stage("codex", &pnpm).expect("pnpm stage");
        assert_ne!(npm_pin.snapshot_id(), pnpm_pin.snapshot_id());
        let mut environment = BTreeMap::new();
        pnpm_pin.configure_environment(&mut environment);
        assert_eq!(
            environment.get(OsStr::new("CODEX_MANAGED_BY_PNPM")),
            Some(&OsString::from("1"))
        );
        assert!(!environment.contains_key(OsStr::new("CODEX_MANAGED_BY_NPM")));
    }

    #[test]
    fn rejected_candidate_never_replaces_last_known_good() {
        let temp = tempfile::tempdir().expect("temp");
        let source = temp.path().join("global/vendor/triple");
        let store = RuntimeStore::new(temp.path().join("kalcode"));
        let old = store
            .stage("codex", &fixture(&source, "good"))
            .and_then(|staged| store.promote_validated(&staged, "0.160.0"))
            .expect("good");
        std::fs::remove_dir_all(&source).expect("replace");
        let _rejected = store
            .stage("codex", &fixture(&source, "incompatible"))
            .expect("staging itself is not validation");

        assert_eq!(
            store
                .last_known_good("codex")
                .unwrap()
                .unwrap()
                .snapshot_id(),
            old.snapshot_id()
        );
    }

    #[test]
    fn retention_never_deletes_current_previous_or_an_active_staged_snapshot() {
        let temp = tempfile::tempdir().expect("temp");
        let source = temp.path().join("global/vendor/triple");
        let store = RuntimeStore::new(temp.path().join("kalcode"));
        let old = store
            .stage("codex", &fixture(&source, "old"))
            .and_then(|staged| store.promote_validated(&staged, "0.160.0"))
            .expect("old");
        std::fs::remove_dir_all(&source).expect("replace old");
        let current = store
            .stage("codex", &fixture(&source, "current"))
            .and_then(|staged| store.promote_validated(&staged, "0.161.0"))
            .expect("current");
        std::fs::remove_dir_all(&source).expect("replace current");
        let active = store
            .stage("codex", &fixture(&source, "candidate"))
            .expect("active candidate");

        assert_eq!(store.prune_unleased("codex", 0).unwrap(), 0);
        assert!(old.snapshot_dir().is_dir());
        assert!(current.snapshot_dir().is_dir());
        assert!(active.snapshot_dir().is_dir());
        let active_dir = active.snapshot_dir().to_path_buf();
        drop(active);
        assert_eq!(store.prune_unleased("codex", 0).unwrap(), 1);
        assert!(!active_dir.exists());
        assert!(old.snapshot_dir().is_dir());
        assert!(current.snapshot_dir().is_dir());
    }

    #[test]
    fn retention_skips_live_staging_copy_and_recovers_it_after_lease_release() {
        let temp = tempfile::tempdir().expect("temp");
        let store = RuntimeStore::new(temp.path().join("kalcode"));
        let store_root = store.prepare_provider("codex").expect("prepare");
        let provider_root = store_root.join("codex");
        let stage_id = "a".repeat(32);
        let staging = provider_root
            .join("staging")
            .join(format!("{stage_id}.partial"));
        let lease_path = provider_root
            .join("leases")
            .join(format!("staging-{stage_id}.lock"));
        let lease = open_lease_file(&lease_path).expect("lease");
        fs2::FileExt::lock_shared(&lease).expect("shared lease");
        write(staging.join("part"), b"partial runtime");

        assert_eq!(store.prune_unleased("codex", 0).unwrap(), 0);
        assert!(staging.is_dir(), "an active copy must not be pruned");

        fs2::FileExt::unlock(&lease).expect("unlock");
        drop(lease);
        assert_eq!(store.prune_unleased("codex", 0).unwrap(), 1);
        assert!(!staging.exists(), "an abandoned partial must be recovered");
        assert!(!lease_path.exists(), "the orphan staging lease is removed");
    }

    #[test]
    fn layout_rejects_traversal_and_store_rejects_oversized_content() {
        let temp = tempfile::tempdir().expect("temp");
        let source = temp.path().join("source");
        write(source.join("codex.exe"), b"codex");
        assert!(matches!(
            RuntimeLayout::new(&source, Path::new("../codex.exe"), [PathBuf::from(".")]),
            Err(RuntimeStoreError::UnsafeLayout)
        ));
        let layout = RuntimeLayout::new(
            &source,
            Path::new("codex.exe"),
            [PathBuf::from("codex.exe")],
        )
        .unwrap();
        let store = RuntimeStore::with_limits(
            temp.path().join("kalcode"),
            RuntimeStoreLimits {
                max_file_bytes: 3,
                max_total_bytes: 3,
                ..RuntimeStoreLimits::default()
            },
        );
        assert!(matches!(
            store.stage("codex", &layout),
            Err(RuntimeStoreError::RuntimeTooLarge)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn runtime_tree_rejects_symlinks_instead_of_copying_outside_content() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("temp");
        let source = temp.path().join("source");
        let layout = fixture(&source, "safe");
        let outside = temp.path().join("credential");
        write(&outside, b"never copy");
        symlink(&outside, source.join("codex-resources/linked-secret")).expect("symlink");
        let store = RuntimeStore::new(temp.path().join("kalcode"));
        assert!(matches!(
            store.stage("codex", &layout),
            Err(RuntimeStoreError::UnsafeSource)
        ));
    }

    fn npm_fixture(root: &Path, package: &str, triple: &str, exe_name: &str) -> (PathBuf, PathBuf) {
        let shim = root.join("bin/codex.cmd");
        let script = root.join("bin/node_modules/@openai/codex/bin/codex.js");
        let platform_root = root
            .join("bin/node_modules/@openai/codex/node_modules/@openai")
            .join(package)
            .join("vendor")
            .join(triple);
        write(&script, b"#!/usr/bin/env node\n");
        write(platform_root.join("bin").join(exe_name), b"native");
        write(platform_root.join("codex-path/rg"), b"rg");
        let target = r#"@ECHO off
"%dp0%\node.exe" "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
"#;
        write(&shim, target);
        (shim, script)
    }

    #[test]
    fn resolves_windows_npm_wrapper_to_nested_native_distribution() {
        let temp = tempfile::tempdir().expect("temp");
        let (shim, _) = npm_fixture(
            temp.path(),
            "codex-win32-x64",
            "x86_64-pc-windows-msvc",
            "codex.exe",
        );
        let layout = resolve_codex_runtime_layout(
            &shim,
            &BTreeMap::<StringOs, StringOs>::new(),
            RuntimePlatform::WindowsX64,
        )
        .expect("layout");
        assert!(layout.source_root().ends_with("x86_64-pc-windows-msvc"));
        assert_eq!(layout.executable_relative(), Path::new("bin/codex.exe"));
    }

    #[test]
    fn staged_npm_runtime_rebases_package_root_and_normalizes_manager_markers() {
        let temp = tempfile::tempdir().expect("temp");
        let (shim, _) = npm_fixture(
            temp.path(),
            "codex-win32-x64",
            "x86_64-pc-windows-msvc",
            "codex.exe",
        );
        let mut provider_env = BTreeMap::<OsString, OsString>::new();
        provider_env.insert("npm_config_user_agent".into(), "pnpm/10.0.0".into());
        let layout =
            resolve_codex_runtime_layout(&shim, &provider_env, RuntimePlatform::WindowsX64)
                .expect("layout");
        let staged = RuntimeStore::new(temp.path().join("kalcode"))
            .stage("codex", &layout)
            .expect("stage");
        let mut launch_env = BTreeMap::<OsString, OsString>::from([
            (
                OsString::from("codex_managed_package_root"),
                OsString::from("global-package"),
            ),
            (OsString::from("CODEX_MANAGED_BY_NPM"), OsString::from("1")),
            (
                OsString::from("CODEX_MANAGED_BY_PNPM"),
                OsString::from("stale"),
            ),
            (OsString::from("CODEX_MANAGED_BY_BUN"), OsString::from("1")),
            (
                OsString::from("CODEX_MANAGED_BY_VITE_PLUS"),
                OsString::from("1"),
            ),
        ]);

        staged.configure_environment(&mut launch_env);

        assert_eq!(
            launch_env.get(OsStr::new("CODEX_MANAGED_PACKAGE_ROOT")),
            Some(&staged.snapshot_dir().as_os_str().to_owned())
        );
        assert_eq!(
            launch_env.get(OsStr::new("CODEX_MANAGED_BY_PNPM")),
            Some(&OsString::from("1"))
        );
        for stale in [
            "codex_managed_package_root",
            "CODEX_MANAGED_BY_NPM",
            "CODEX_MANAGED_BY_BUN",
            "CODEX_MANAGED_BY_VITE_PLUS",
        ] {
            assert!(!launch_env.contains_key(OsStr::new(stale)));
        }
    }

    #[test]
    fn resolves_macos_npm_script_to_nested_native_distribution() {
        let temp = tempfile::tempdir().expect("temp");
        let (_, script) = npm_fixture(
            temp.path(),
            "codex-darwin-arm64",
            "aarch64-apple-darwin",
            "codex",
        );
        let layout = resolve_codex_runtime_layout(
            &script,
            &BTreeMap::<OsString, OsString>::new(),
            RuntimePlatform::MacosArm64,
        )
        .expect("layout");
        assert!(layout.source_root().ends_with("aarch64-apple-darwin"));
        assert_eq!(layout.executable_relative(), Path::new("bin/codex"));
    }

    #[cfg(unix)]
    #[test]
    fn resolves_and_fingerprints_macos_npm_bin_symlink_without_allowing_payload_links() {
        use std::os::unix::fs::{PermissionsExt as _, symlink};

        let temp = tempfile::tempdir().expect("temp");
        let node_modules = temp.path().join("node_modules");
        let link = node_modules.join(".bin/codex");
        let make_package = |name: &str| {
            let package_root = node_modules.join("@openai").join(name);
            let script = package_root.join("bin/codex.js");
            write(&script, b"#!/usr/bin/env node\n");
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
                .expect("script mode");
            script
        };
        let script = make_package("codex");
        let alternate = make_package("codex-alternate");
        let native_root =
            node_modules.join("@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin");
        write(native_root.join("bin/codex"), b"native");
        write(native_root.join("codex-path/rg"), b"rg");
        std::fs::set_permissions(
            native_root.join("bin/codex"),
            std::fs::Permissions::from_mode(0o755),
        )
        .expect("native mode");
        std::fs::create_dir_all(link.parent().expect("link parent")).expect("link directory");
        symlink(&script, &link).expect("npm bin link");

        let env = BTreeMap::<OsString, OsString>::new();
        let layout = resolve_codex_runtime_layout(&link, &env, RuntimePlatform::MacosArm64)
            .expect("official npm symlink layout");
        assert!(layout.source_root().ends_with("aarch64-apple-darwin"));
        assert_eq!(layout.executable_relative(), Path::new("bin/codex"));
        let staged = RuntimeStore::new(temp.path().join("runtime-store"))
            .stage("codex", &layout)
            .expect("snapshot hoisted runtime");
        assert!(executable(&std::fs::metadata(staged.executable()).unwrap()));
        let before = installation_fingerprint(&link, &env).expect("symlink fingerprint");

        std::fs::remove_file(&link).expect("replace link");
        symlink(&alternate, &link).expect("retarget link");
        let after = installation_fingerprint(&link, &env).expect("retargeted fingerprint");
        assert_ne!(
            before, after,
            "retargeting the launcher must invalidate caches"
        );
    }

    #[test]
    fn installation_fingerprint_changes_when_nested_native_binary_changes() {
        let Ok(platform) = RuntimePlatform::current() else {
            return;
        };
        let (package, triple, executable_name) = platform.codex_parts();
        let temp = tempfile::tempdir().expect("temp");
        let (_, script) = npm_fixture(temp.path(), package, triple, executable_name);
        let env = BTreeMap::<OsString, OsString>::new();
        let before = installation_fingerprint(&script, &env).expect("fingerprint");
        let native = temp
            .path()
            .join("bin/node_modules/@openai/codex/node_modules/@openai")
            .join(package)
            .join("vendor")
            .join(triple)
            .join("bin")
            .join(executable_name);
        let old_modified = std::fs::metadata(&native)
            .expect("metadata")
            .modified()
            .expect("modified");
        std::fs::remove_file(&native).expect("replace native");
        write(&native, b"change");
        std::fs::File::options()
            .write(true)
            .open(&native)
            .expect("reopen")
            .set_modified(old_modified)
            .expect("restore timestamp");
        let after = installation_fingerprint(&script, &env).expect("updated fingerprint");
        assert_ne!(before, after);
    }

    #[test]
    fn missing_global_binary_does_not_prevent_opening_last_known_good() {
        let temp = tempfile::tempdir().expect("temp");
        let source = temp.path().join("global/vendor/triple");
        let store = RuntimeStore::new(temp.path().join("kalcode"));
        let lease = store
            .stage("codex", &fixture(&source, "good"))
            .and_then(|staged| store.promote_validated(&staged, "0.161.0"))
            .expect("validated");
        std::fs::remove_dir_all(temp.path().join("global")).expect("missing global");
        assert!(matches!(
            resolve_codex_runtime_layout(
                &source.join("bin/codex.exe"),
                &BTreeMap::new(),
                RuntimePlatform::WindowsX64
            ),
            Err(RuntimeStoreError::RuntimeMissing)
        ));
        assert_eq!(
            store
                .last_known_good("codex")
                .unwrap()
                .unwrap()
                .snapshot_id(),
            lease.snapshot_id()
        );
    }
}
