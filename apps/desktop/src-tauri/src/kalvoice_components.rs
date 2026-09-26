//! Desktop authority for KalVoice's signed local components.
//!
//! The UI keeps the original five speech-model preference ids, but bytes are installed and
//! loaded only through the signed component catalog/store. The catalog rollback floor remains
//! in the OS credential store; this module retains only public signed catalog tokens in a
//! hash-addressed, private app-data cache.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use kalcode_contracts::app::BuildChannel;
use kalcode_kalvoice::component_acquisition::{ComponentAcquirer, ComponentAcquisitionError};
use kalcode_kalvoice::component_catalog::{
    CatalogContract, CatalogRole, CatalogVerifyError, MAX_CATALOG_TOKEN_LENGTH,
    VerifiedComponentCatalog, WHISPER_GGML_ABI, verify_catalog,
};
use kalcode_kalvoice::component_floor::{CatalogFloorTrack, ComponentFloorAuthority};
use kalcode_kalvoice::component_manifest::{
    ComponentArch, ComponentKind, ComponentPlatform, ComponentVerifier,
};
use kalcode_kalvoice::component_store::{
    ComponentLease, ComponentReceiptStatus, ComponentSelector, ComponentStore, ComponentStoreError,
    LOCAL_REASONING_MODEL_ID, LOCAL_REASONING_RUNTIME_ABI, LOCAL_REASONING_RUNTIME_ID,
    TrustedComponentDirectory, host_local_reasoning_contract,
};
use kalcode_kalvoice::models::{self, SpeechModelInfo, SpeechModelState};
use kalcode_kalvoice::signals::LocalReasoningDownload;
use kalcode_secure_store::SecretStore;
use sha2::{Digest as _, Sha256};

use crate::resource_commands::{
    LocalTaskReservation, LocalWorkloadEstimate, ResourceGovernorState,
};

const CATALOG_ORIGIN: &str = "https://kalcoded.com";
const FLOOR_TIMEOUT: Duration = Duration::from_secs(3);
const CATALOG_CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const CATALOG_RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
const CATALOG_BODY_TIMEOUT: Duration = Duration::from_secs(5);
const ACQUISITION_CPU_MILLICORES: u32 = 500;
const ACQUISITION_MEMORY_MIB: u64 = 96;
const ACQUISITION_DISK_MARGIN_BYTES: u64 = 64 * 1024 * 1024;
const MAX_RETAINED_CATALOGS: usize = 8;
const CATALOG_PRUNE_MINIMUM_AGE: Duration = Duration::from_secs(24 * 60 * 60);

pub(crate) const SPEECH_COMPONENT_IDS: [&str; 5] = [
    "kalvoice.speech.whisper.tiny-en",
    "kalvoice.speech.whisper.base-en",
    "kalvoice.speech.whisper.small-en",
    "kalvoice.speech.whisper.base",
    "kalvoice.speech.whisper.small",
];
const DEFAULT_SPEECH_COMPONENT_ID: &str = SPEECH_COMPONENT_IDS[0];
pub(crate) const REASONING_DOWNLOAD_ID: &str = "local-reasoning";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SpeechComponent {
    preference_id: &'static str,
    component_id: &'static str,
}

const SPEECH_COMPONENTS: [SpeechComponent; 5] = [
    SpeechComponent {
        preference_id: "tiny.en",
        component_id: SPEECH_COMPONENT_IDS[0],
    },
    SpeechComponent {
        preference_id: "base.en",
        component_id: SPEECH_COMPONENT_IDS[1],
    },
    SpeechComponent {
        preference_id: "small.en",
        component_id: SPEECH_COMPONENT_IDS[2],
    },
    SpeechComponent {
        preference_id: "base",
        component_id: SPEECH_COMPONENT_IDS[3],
    },
    SpeechComponent {
        preference_id: "small",
        component_id: SPEECH_COMPONENT_IDS[4],
    },
];

pub(crate) struct ComponentManagerConfig {
    pub(crate) root: TrustedComponentDirectory,
    pub(crate) verifier: ComponentVerifier,
    pub(crate) floor: Arc<ComponentFloorAuthority>,
    pub(crate) resources: Arc<ResourceGovernorState>,
    pub(crate) channel: &'static str,
    pub(crate) platform: ComponentPlatform,
    pub(crate) arch: ComponentArch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ComponentManagerError {
    ConsentRequired,
    UnknownSpeechModel,
    AlreadyDownloading,
    Cancelled,
    CatalogUnavailable,
    CatalogInvalid,
    CatalogStorage,
    CatalogRollback,
    ResourceUnavailable,
    AcquisitionFailed,
    StorageUnavailable,
    InUse,
    NotInstalled,
}

impl std::fmt::Display for ComponentManagerError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::ConsentRequired => "Downloading a speech model needs your permission first.",
            Self::UnknownSpeechModel => "That speech model isn't in KalVoice's catalog.",
            Self::AlreadyDownloading => "A download for this model is already running.",
            Self::Cancelled => "The download was cancelled. It can resume where it stopped.",
            Self::CatalogUnavailable => "KalVoice's signed component catalog isn't available yet.",
            Self::CatalogInvalid => "KalVoice rejected an invalid signed component catalog.",
            Self::CatalogStorage => "KalVoice couldn't safely retain the signed component catalog.",
            Self::CatalogRollback => "KalVoice blocked a component catalog rollback.",
            Self::ResourceUnavailable => "KalVoice is waiting for enough verified system capacity.",
            Self::AcquisitionFailed => "The signed component download failed. Try again.",
            Self::StorageUnavailable => "KalVoice's signed component storage is unavailable.",
            Self::InUse => "That speech model is still in use.",
            Self::NotInstalled => "That speech model isn't installed.",
        })
    }
}

impl std::error::Error for ComponentManagerError {}

impl ComponentManagerError {
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::ConsentRequired => "consent_required",
            Self::UnknownSpeechModel => "unknown_speech_model",
            Self::AlreadyDownloading => "download_in_progress",
            Self::Cancelled => "download_cancelled",
            Self::CatalogUnavailable => "component_catalog_unavailable",
            Self::CatalogInvalid => "component_catalog_invalid",
            Self::CatalogStorage => "component_catalog_storage_failed",
            Self::CatalogRollback => "component_catalog_rollback",
            Self::ResourceUnavailable => "resource_capacity_unavailable",
            Self::AcquisitionFailed => "component_acquisition_failed",
            Self::StorageUnavailable => "component_storage_failed",
            Self::InUse => "component_in_use",
            Self::NotInstalled => "model_not_installed",
        }
    }
}

struct DownloadState {
    cancel: Arc<AtomicBool>,
    received_bytes: u64,
    total_bytes: u64,
}

#[derive(Default)]
struct Downloads {
    stopping: bool,
    running: HashMap<String, DownloadState>,
}

struct DownloadRegistration<'a> {
    manager: &'a KalVoiceComponentManager,
    preference_id: String,
}

impl Drop for DownloadRegistration<'_> {
    fn drop(&mut self) {
        self.manager
            .downloads
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .running
            .remove(&self.preference_id);
        self.manager.downloads_settled.notify_all();
    }
}

trait CatalogFetcher: Send + Sync {
    fn fetch(&self, url: &str, cancel: &AtomicBool) -> Result<String, ComponentManagerError>;
}

struct HttpsCatalogFetcher {
    agent: ureq::Agent,
}

impl HttpsCatalogFetcher {
    fn new() -> Self {
        let agent = ureq::Agent::config_builder()
            .https_only(true)
            .http_status_as_error(false)
            .max_redirects(0)
            .timeout_connect(Some(CATALOG_CONNECT_TIMEOUT))
            .timeout_recv_response(Some(CATALOG_RESPONSE_TIMEOUT))
            .timeout_recv_body(Some(CATALOG_BODY_TIMEOUT))
            .max_response_header_size(64 * 1024)
            .user_agent("KalCode")
            .build()
            .into();
        Self { agent }
    }
}

impl CatalogFetcher for HttpsCatalogFetcher {
    fn fetch(&self, url: &str, cancel: &AtomicBool) -> Result<String, ComponentManagerError> {
        if cancel.load(Ordering::SeqCst) {
            return Err(ComponentManagerError::Cancelled);
        }
        let response = self
            .agent
            .get(url)
            .call()
            .map_err(|_| ComponentManagerError::CatalogUnavailable)?;
        if response.status().as_u16() != 200 || response.headers().contains_key("location") {
            return Err(ComponentManagerError::CatalogUnavailable);
        }
        if response
            .headers()
            .get("content-length")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<usize>().ok())
            .is_some_and(|length| length > MAX_CATALOG_TOKEN_LENGTH)
        {
            return Err(ComponentManagerError::CatalogInvalid);
        }
        let mut reader = response
            .into_body()
            .into_with_config()
            .limit(MAX_CATALOG_TOKEN_LENGTH.saturating_add(1) as u64)
            .reader();
        let mut bytes = Vec::with_capacity(16 * 1024);
        reader
            .read_to_end(&mut bytes)
            .map_err(|_| ComponentManagerError::CatalogUnavailable)?;
        if cancel.load(Ordering::SeqCst) {
            return Err(ComponentManagerError::Cancelled);
        }
        if bytes.is_empty() || bytes.len() > MAX_CATALOG_TOKEN_LENGTH {
            return Err(ComponentManagerError::CatalogInvalid);
        }
        String::from_utf8(bytes).map_err(|_| ComponentManagerError::CatalogInvalid)
    }
}

trait AcquisitionService: Send + Sync {
    fn acquire(
        &self,
        token: &str,
        now_unix: i64,
        consent: bool,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64, u64),
    ) -> Result<(), ComponentAcquisitionError>;
}

struct SignedAcquisitionService(ComponentAcquirer);

impl AcquisitionService for SignedAcquisitionService {
    fn acquire(
        &self,
        token: &str,
        now_unix: i64,
        consent: bool,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64, u64),
    ) -> Result<(), ComponentAcquisitionError> {
        self.0
            .acquire(token, now_unix, consent, cancel, progress)
            .map(|_| ())
    }
}

trait HeldReservation: Send {}
impl HeldReservation for LocalTaskReservation {}

trait ComponentAdmission: Send + Sync {
    fn reserve_acquisition(
        &self,
        size_bytes: u64,
    ) -> Result<Box<dyn HeldReservation>, ComponentManagerError>;
}

struct GovernorAdmission(Arc<ResourceGovernorState>);

impl ComponentAdmission for GovernorAdmission {
    fn reserve_acquisition(
        &self,
        size_bytes: u64,
    ) -> Result<Box<dyn HeldReservation>, ComponentManagerError> {
        let disk_bytes = size_bytes
            .checked_mul(2)
            .and_then(|bytes| bytes.checked_add(ACQUISITION_DISK_MARGIN_BYTES))
            .ok_or(ComponentManagerError::ResourceUnavailable)?;
        let disk_mib = disk_bytes
            .checked_add((1 << 20) - 1)
            .map(|bytes| bytes >> 20)
            .ok_or(ComponentManagerError::ResourceUnavailable)?;
        let estimate = LocalWorkloadEstimate::acquisition(
            Some(ACQUISITION_CPU_MILLICORES),
            Some(ACQUISITION_MEMORY_MIB),
            Some(disk_mib),
        )
        .map_err(|_| ComponentManagerError::ResourceUnavailable)?;
        self.0
            .reserve_local_task(estimate)
            .map(|reservation| Box::new(reservation) as Box<dyn HeldReservation>)
            .map_err(|_| ComponentManagerError::ResourceUnavailable)
    }
}

struct CatalogCache {
    directory: PathBuf,
    write_lock: Mutex<()>,
}

impl CatalogCache {
    fn new(
        root: &TrustedComponentDirectory,
        channel: &str,
        platform: ComponentPlatform,
        arch: ComponentArch,
    ) -> Result<Self, ComponentManagerError> {
        let directory = root
            .create_private_child("catalog-cache")
            .and_then(|directory| directory.create_private_child("v1"))
            .and_then(|directory| directory.create_private_child(channel))
            .and_then(|directory| {
                directory.create_private_child(&format!(
                    "{}-{}",
                    platform_segment(platform),
                    arch_segment(arch)
                ))
            })
            .map_err(|_| ComponentManagerError::CatalogStorage)?;
        Ok(Self {
            directory: directory.path().to_owned(),
            write_lock: Mutex::new(()),
        })
    }

    fn path(&self, token_sha256: &str) -> Result<PathBuf, ComponentManagerError> {
        if token_sha256.len() != 64
            || !token_sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        {
            return Err(ComponentManagerError::CatalogInvalid);
        }
        Ok(self.directory.join(format!("catalog-{token_sha256}.jws")))
    }

    fn read(&self, token_sha256: &str) -> Result<String, ComponentManagerError> {
        let path = self.path(token_sha256)?;
        read_catalog_file(&path, token_sha256)
    }

    fn retain(&self, token: &str, token_sha256: &str) -> Result<String, ComponentManagerError> {
        if token.is_empty() || token.len() > MAX_CATALOG_TOKEN_LENGTH {
            return Err(ComponentManagerError::CatalogInvalid);
        }
        if sha256_hex(token.as_bytes()) != token_sha256 {
            return Err(ComponentManagerError::CatalogInvalid);
        }
        let _guard = self
            .write_lock
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let final_path = self.path(token_sha256)?;
        if final_path.exists() {
            return read_catalog_file(&final_path, token_sha256);
        }

        let mut entropy = [0_u8; 16];
        getrandom::fill(&mut entropy).map_err(|_| ComponentManagerError::CatalogStorage)?;
        let suffix = entropy
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let temporary = self.directory.join(format!(".catalog-{suffix}.tmp"));
        let write_result = (|| {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt as _;
                options.mode(0o600);
            }
            let mut file = options
                .open(&temporary)
                .map_err(|_| ComponentManagerError::CatalogStorage)?;
            file.write_all(token.as_bytes())
                .and_then(|()| file.sync_all())
                .map_err(|_| ComponentManagerError::CatalogStorage)?;
            atomic_publish(&temporary, &final_path)?;
            sync_parent(&self.directory)?;
            read_catalog_file(&final_path, token_sha256)
        })();
        if write_result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        write_result
    }

    /// Bounds old, publisher-signed candidates without racing a currently written catalog in
    /// another process. A candidate younger than one day is retained even above the normal cap.
    fn prune(&self, current_sha256: &str) {
        let _guard = self
            .write_lock
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let Ok(entries) = fs::read_dir(&self.directory) else {
            return;
        };
        let mut catalogs = entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                let digest = name.strip_prefix("catalog-")?.strip_suffix(".jws")?;
                if digest == current_sha256
                    || digest.len() != 64
                    || !digest
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
                {
                    return None;
                }
                Some((entry.metadata().ok()?.modified().ok()?, entry.path()))
            })
            .collect::<Vec<_>>();
        catalogs.sort_by(|left, right| right.0.cmp(&left.0));
        for (modified, path) in catalogs.into_iter().skip(MAX_RETAINED_CATALOGS - 1) {
            if SystemTime::now()
                .duration_since(modified)
                .is_ok_and(|age| age >= CATALOG_PRUNE_MINIMUM_AGE)
            {
                let _ = fs::remove_file(path);
            }
        }
    }
}

pub(crate) struct KalVoiceComponentManager {
    verifier: ComponentVerifier,
    floor: Arc<ComponentFloorAuthority>,
    store: ComponentStore,
    acquisition: Arc<dyn AcquisitionService>,
    admission: Arc<dyn ComponentAdmission>,
    fetcher: Arc<dyn CatalogFetcher>,
    cache: CatalogCache,
    staging_directory: PathBuf,
    channel: &'static str,
    platform: ComponentPlatform,
    arch: ComponentArch,
    current_catalog: Mutex<Option<VerifiedComponentCatalog>>,
    prepared_reasoning: Mutex<Option<String>>,
    downloads: Mutex<Downloads>,
    downloads_settled: Condvar,
}

impl KalVoiceComponentManager {
    pub(crate) fn for_runtime(
        state: &crate::AppState,
        resources: Arc<ResourceGovernorState>,
    ) -> Result<Arc<Self>, ComponentManagerError> {
        let channel = match state.info.channel {
            BuildChannel::Stable => "stable",
            BuildChannel::Beta => "beta",
            BuildChannel::Development => "dev",
        };
        let host =
            host_local_reasoning_contract().ok_or(ComponentManagerError::CatalogUnavailable)?;
        let platform = host.runtime.platform;
        let arch = host.runtime.arch;
        let root = TrustedComponentDirectory::open_existing(&state.paths.data_dir)
            .map_err(|_| ComponentManagerError::StorageUnavailable)?;
        let verifier = crate::kalvoice_component_trust::production_verifier()
            .map_err(|_| ComponentManagerError::CatalogInvalid)?;
        let track = CatalogFloorTrack::new(channel, platform, arch)
            .map_err(|_| ComponentManagerError::CatalogInvalid)?;
        // The monotonic catalog floor is OS-held authority, never an app-data plaintext file.
        // Tests inject their own in-memory authority through ComponentManagerConfig.
        let store: Arc<dyn SecretStore> = Arc::new(kalcode_secure_store::OsSecretStore::new());
        let floor = Arc::new(
            ComponentFloorAuthority::new(store, root.clone(), track)
                .map_err(|_| ComponentManagerError::CatalogStorage)?,
        );
        Self::new(ComponentManagerConfig {
            root,
            verifier,
            floor,
            resources,
            channel,
            platform,
            arch,
        })
    }

    pub(crate) fn new(config: ComponentManagerConfig) -> Result<Arc<Self>, ComponentManagerError> {
        validate_track(config.channel, config.platform, config.arch)?;
        let cache = CatalogCache::new(&config.root, config.channel, config.platform, config.arch)?;
        let component_root = config
            .root
            .create_private_child("components")
            .map_err(|_| ComponentManagerError::StorageUnavailable)?;
        let staging = config
            .root
            .create_private_child("component-acquisition")
            .map_err(|_| ComponentManagerError::StorageUnavailable)?;
        let runtime_policies = host_local_reasoning_contract()
            .map(|contract| contract.runtime_policy)
            .into_iter();
        let store = ComponentStore::new(component_root, config.verifier.clone(), runtime_policies)
            .map_err(|_| ComponentManagerError::StorageUnavailable)?;
        let acquisition =
            ComponentAcquirer::new(store.clone(), config.verifier.clone(), staging.clone());
        let manager = Arc::new(Self {
            verifier: config.verifier,
            floor: config.floor,
            store,
            acquisition: Arc::new(SignedAcquisitionService(acquisition)),
            admission: Arc::new(GovernorAdmission(config.resources)),
            fetcher: Arc::new(HttpsCatalogFetcher::new()),
            cache,
            staging_directory: staging.path().to_owned(),
            channel: config.channel,
            platform: config.platform,
            arch: config.arch,
            current_catalog: Mutex::new(None),
            prepared_reasoning: Mutex::new(None),
            downloads: Mutex::new(Downloads::default()),
            downloads_settled: Condvar::new(),
        });
        manager.restore_current_catalog();
        Ok(manager)
    }

    fn contract(&self) -> CatalogContract<'_> {
        CatalogContract {
            channel: self.channel,
            platform: self.platform,
            arch: self.arch,
            reasoning_runtime_id: LOCAL_REASONING_RUNTIME_ID,
            reasoning_model_id: LOCAL_REASONING_MODEL_ID,
            reasoning_abi: LOCAL_REASONING_RUNTIME_ABI,
            speech_model_ids: &SPEECH_COMPONENT_IDS,
            default_speech_model_id: DEFAULT_SPEECH_COMPONENT_ID,
            speech_model_abi: WHISPER_GGML_ABI,
        }
    }

    fn restore_current_catalog(&self) {
        let cancellation = AtomicBool::new(false);
        let Ok(Some(floor)) = self
            .floor
            .load(Instant::now() + FLOOR_TIMEOUT, &cancellation)
        else {
            return;
        };
        let Ok(token) = self.cache.read(floor.token_sha256()) else {
            return;
        };
        let now_unix = unix_seconds();
        let Ok(catalog) = verify_catalog(&self.verifier, &token, now_unix, self.contract()) else {
            // An expired acquisition window does not revoke installed component receipts.
            return;
        };
        if catalog.floor() == floor {
            *self
                .current_catalog
                .lock()
                .unwrap_or_else(PoisonError::into_inner) = Some(catalog);
        }
    }

    pub(crate) fn speech_models(&self) -> Vec<SpeechModelInfo> {
        let now_unix = unix_seconds();
        let installed_allowed = self.installed_catalog_identity().is_ok();
        let downloads = self
            .downloads
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        models::CATALOG
            .iter()
            .map(|spec| {
                let component = speech_component(spec.id).expect("compiled speech mapping");
                let selector = self.speech_selector(component);
                let running = downloads.running.get(spec.id);
                let state = if installed_allowed
                    && matches!(
                        self.store.status(&selector, now_unix),
                        ComponentReceiptStatus::Present { .. }
                    ) {
                    SpeechModelState::Installed
                } else if let Some(running) = running {
                    SpeechModelState::Downloading {
                        received_bytes: running.received_bytes,
                    }
                } else if let Some(received_bytes) = self.partial_bytes(component.component_id) {
                    SpeechModelState::Paused { received_bytes }
                } else {
                    SpeechModelState::NotInstalled
                };
                SpeechModelInfo {
                    id: spec.id.to_owned(),
                    display_name: spec.display_name.to_owned(),
                    summary: spec.summary.to_owned(),
                    size_bytes: running
                        .map(|running| running.total_bytes)
                        .filter(|size| *size > 0)
                        .unwrap_or(spec.size_bytes),
                    english_only: spec.english_only,
                    state,
                    source: "KalCode signed components (official whisper.cpp models)".into(),
                }
            })
            .collect()
    }

    pub(crate) fn acquire_speech(
        &self,
        preference_id: &str,
    ) -> Result<ComponentLease, ComponentManagerError> {
        let component =
            speech_component(preference_id).ok_or(ComponentManagerError::UnknownSpeechModel)?;
        self.installed_catalog_identity()?;
        self.store
            .acquire(&self.speech_selector(component), unix_seconds())
            .map_err(map_store_error)
    }

    pub(crate) fn acquire_reasoning(
        &self,
    ) -> Result<(ComponentLease, ComponentLease), ComponentManagerError> {
        self.installed_catalog_identity()?;
        let contract =
            host_local_reasoning_contract().ok_or(ComponentManagerError::CatalogUnavailable)?;
        let runtime = self
            .store
            .acquire(&contract.runtime, unix_seconds())
            .map_err(map_store_error)?;
        let model = self
            .store
            .acquire(&contract.model, unix_seconds())
            .map_err(map_store_error)?;
        Ok((runtime, model))
    }

    pub(crate) fn reasoning_installed(&self) -> bool {
        let Some(contract) = host_local_reasoning_contract() else {
            return false;
        };
        matches!(
            self.store.status(&contract.runtime, unix_seconds()),
            ComponentReceiptStatus::Present { .. }
        ) && matches!(
            self.store.status(&contract.model, unix_seconds()),
            ComponentReceiptStatus::Present { .. }
        )
    }

    /// Fetches signed metadata only. No artifact, rollback-floor update or runtime launch occurs.
    pub(crate) fn prepare_reasoning(
        &self,
    ) -> Result<LocalReasoningDownload, ComponentManagerError> {
        let token = self.fetcher.fetch(
            &catalog_url(self.channel, self.platform, self.arch)?,
            &AtomicBool::new(false),
        )?;
        let catalog = verify_catalog(&self.verifier, &token, unix_seconds(), self.contract())
            .map_err(map_catalog_error)?;
        let quote = reasoning_quote(&catalog)?;
        *self
            .prepared_reasoning
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(token);
        Ok(quote)
    }

    pub(crate) fn download_reasoning(
        &self,
        consent: bool,
        catalog_identity: Option<&str>,
        mut progress: impl FnMut(u64, u64),
    ) -> Result<(), ComponentManagerError> {
        if !consent {
            return Err(ComponentManagerError::ConsentRequired);
        }
        let token = self
            .prepared_reasoning
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
            .ok_or(ComponentManagerError::ConsentRequired)?;
        let now = unix_seconds();
        let catalog = verify_catalog(&self.verifier, &token, now, self.contract())
            .map_err(map_catalog_error)?;
        if catalog_identity != Some(catalog.token_sha256()) {
            return Err(ComponentManagerError::ConsentRequired);
        }
        let quote = reasoning_quote(&catalog)?;
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut downloads = self
                .downloads
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if downloads.stopping {
                return Err(ComponentManagerError::Cancelled);
            }
            if downloads.running.contains_key(REASONING_DOWNLOAD_ID) {
                return Err(ComponentManagerError::AlreadyDownloading);
            }
            downloads.running.insert(
                REASONING_DOWNLOAD_ID.into(),
                DownloadState {
                    cancel: cancel.clone(),
                    received_bytes: 0,
                    total_bytes: quote.size_bytes,
                },
            );
        }
        let _registration = DownloadRegistration {
            manager: self,
            preference_id: REASONING_DOWNLOAD_ID.into(),
        };
        let _reservation = self.admission.reserve_acquisition(quote.size_bytes)?;
        let retained = self.cache.retain(&token, catalog.token_sha256())?;
        let retained_catalog = verify_catalog(&self.verifier, &retained, now, self.contract())
            .map_err(map_catalog_error)?;
        self.floor
            .advance(
                &retained_catalog,
                now,
                Instant::now() + FLOOR_TIMEOUT,
                &cancel,
            )
            .map_err(|_| {
                if cancel.load(Ordering::SeqCst) {
                    ComponentManagerError::Cancelled
                } else {
                    ComponentManagerError::CatalogRollback
                }
            })?;
        self.cache.prune(retained_catalog.token_sha256());
        *self
            .current_catalog
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(retained_catalog.clone());
        let mut completed = 0;
        for role in [CatalogRole::ReasoningRuntime, CatalogRole::ReasoningModel] {
            let entry = retained_catalog
                .entry(role)
                .ok_or(ComponentManagerError::CatalogInvalid)?;
            self.acquisition
                .acquire(
                    entry.token(),
                    unix_seconds(),
                    true,
                    &cancel,
                    &mut |received, _| {
                        let received = completed + received;
                        if let Some(running) = self
                            .downloads
                            .lock()
                            .unwrap_or_else(PoisonError::into_inner)
                            .running
                            .get_mut(REASONING_DOWNLOAD_ID)
                        {
                            running.received_bytes = received;
                        }
                        progress(received, quote.size_bytes);
                    },
                )
                .map_err(map_acquisition_error)?;
            completed += entry.component().manifest().size_bytes;
        }
        Ok(())
    }

    pub(crate) fn download_speech(
        &self,
        preference_id: &str,
        consent: bool,
        mut progress: impl FnMut(u64, u64),
    ) -> Result<(), ComponentManagerError> {
        let component = authorize_download(preference_id, consent)?;
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut downloads = self
                .downloads
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if downloads.stopping {
                return Err(ComponentManagerError::Cancelled);
            }
            if downloads.running.contains_key(preference_id) {
                return Err(ComponentManagerError::AlreadyDownloading);
            }
            downloads.running.insert(
                preference_id.to_owned(),
                DownloadState {
                    cancel: Arc::clone(&cancel),
                    received_bytes: 0,
                    total_bytes: 0,
                },
            );
        }
        let _registration = DownloadRegistration {
            manager: self,
            preference_id: preference_id.to_owned(),
        };

        let url = catalog_url(self.channel, self.platform, self.arch)?;
        let token = self.fetcher.fetch(&url, &cancel)?;
        let now_unix = unix_seconds();
        let catalog = verify_catalog(&self.verifier, &token, now_unix, self.contract())
            .map_err(map_catalog_error)?;
        let entry = catalog
            .speech_models()
            .find(|entry| entry.component().manifest().component_id == component.component_id)
            .ok_or(ComponentManagerError::CatalogInvalid)?;
        let size_bytes = entry.component().manifest().size_bytes;
        {
            let mut downloads = self
                .downloads
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            let running = downloads
                .running
                .get_mut(preference_id)
                .ok_or(ComponentManagerError::Cancelled)?;
            running.total_bytes = size_bytes;
        }

        let _reservation = self.admission.reserve_acquisition(size_bytes)?;
        if cancel.load(Ordering::SeqCst) {
            return Err(ComponentManagerError::Cancelled);
        }
        let retained = self.cache.retain(&token, catalog.token_sha256())?;
        let retained_catalog = verify_catalog(&self.verifier, &retained, now_unix, self.contract())
            .map_err(map_catalog_error)?;
        self.floor
            .advance(
                &retained_catalog,
                now_unix,
                Instant::now() + FLOOR_TIMEOUT,
                &cancel,
            )
            .map_err(|error| {
                if cancel.load(Ordering::SeqCst) {
                    ComponentManagerError::Cancelled
                } else if matches!(
                    error,
                    kalcode_kalvoice::component_floor::ComponentFloorError::Transition(_)
                ) {
                    ComponentManagerError::CatalogRollback
                } else {
                    ComponentManagerError::CatalogStorage
                }
            })?;
        self.cache.prune(retained_catalog.token_sha256());
        *self
            .current_catalog
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(retained_catalog.clone());
        let exact_entry = retained_catalog
            .speech_models()
            .find(|candidate| {
                candidate.component().manifest().component_id == component.component_id
            })
            .ok_or(ComponentManagerError::CatalogInvalid)?;
        let signed_manifest = exact_entry.token().to_owned();
        let result = self.acquisition.acquire(
            &signed_manifest,
            now_unix,
            consent,
            &cancel,
            &mut |received, total| {
                if let Some(running) = self
                    .downloads
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .running
                    .get_mut(preference_id)
                {
                    running.received_bytes = received;
                    running.total_bytes = total;
                }
                progress(received, total);
            },
        );
        result.map_err(map_acquisition_error)
    }

    pub(crate) fn cancel(&self, preference_id: &str) -> bool {
        self.downloads
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .running
            .get(preference_id)
            .is_some_and(|running| {
                running.cancel.store(true, Ordering::SeqCst);
                true
            })
    }

    pub(crate) fn cancel_all(&self) -> usize {
        let mut downloads = self
            .downloads
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        downloads.stopping = true;
        for running in downloads.running.values() {
            running.cancel.store(true, Ordering::SeqCst);
        }
        downloads.running.len()
    }

    pub(crate) fn cancel_all_and_wait(&self, timeout: Duration) -> bool {
        self.cancel_all();
        let deadline = Instant::now() + timeout;
        let mut downloads = self
            .downloads
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        while !downloads.running.is_empty() {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            let (next, result) = self
                .downloads_settled
                .wait_timeout(downloads, remaining)
                .unwrap_or_else(PoisonError::into_inner);
            downloads = next;
            if result.timed_out() && !downloads.running.is_empty() {
                return false;
            }
        }
        true
    }

    pub(crate) fn delete_speech(&self, preference_id: &str) -> Result<(), ComponentManagerError> {
        let component =
            speech_component(preference_id).ok_or(ComponentManagerError::UnknownSpeechModel)?;
        if self
            .downloads
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .running
            .contains_key(preference_id)
        {
            return Err(ComponentManagerError::AlreadyDownloading);
        }
        self.store
            .delete(&self.speech_selector(component))
            .map_err(map_store_error)?;
        let partial_digest = self
            .current_catalog
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .and_then(|catalog| {
                catalog
                    .speech_models()
                    .find(|entry| {
                        entry.component().manifest().component_id == component.component_id
                    })
                    .map(|entry| entry.component().manifest().sha256.clone())
            });
        if let Some(digest) = partial_digest {
            let partial = self.staging_directory.join(format!("{digest}.partial"));
            match fs::remove_file(partial) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(_) => return Err(ComponentManagerError::StorageUnavailable),
            }
        }
        Ok(())
    }

    fn installed_catalog_identity(&self) -> Result<(), ComponentManagerError> {
        let cancellation = AtomicBool::new(false);
        let floor = self
            .floor
            .load(Instant::now() + FLOOR_TIMEOUT, &cancellation)
            .map_err(|_| ComponentManagerError::CatalogStorage)?
            .ok_or(ComponentManagerError::CatalogUnavailable)?;
        // The OS-backed floor names the one public token that was accepted while current. Its
        // acquisition-window expiry does not revoke independently verified installed receipts.
        self.cache.read(floor.token_sha256()).map(|_| ())
    }

    fn speech_selector(&self, component: SpeechComponent) -> ComponentSelector {
        ComponentSelector {
            component_id: component.component_id.to_owned(),
            kind: ComponentKind::Model,
            platform: self.platform,
            arch: self.arch,
            runtime_abi: WHISPER_GGML_ABI.to_owned(),
        }
    }

    fn partial_bytes(&self, component_id: &str) -> Option<u64> {
        let catalog = self
            .current_catalog
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()?;
        let digest = catalog
            .speech_models()
            .find(|entry| entry.component().manifest().component_id == component_id)?
            .component()
            .manifest()
            .sha256
            .clone();
        fs::metadata(self.staging_directory.join(format!("{digest}.partial")))
            .ok()
            .filter(|metadata| metadata.is_file())
            .map(|metadata| metadata.len())
            .filter(|length| *length > 0)
    }
}

fn reasoning_quote(
    catalog: &VerifiedComponentCatalog,
) -> Result<LocalReasoningDownload, ComponentManagerError> {
    let runtime = catalog
        .entry(CatalogRole::ReasoningRuntime)
        .ok_or(ComponentManagerError::CatalogInvalid)?
        .component()
        .manifest();
    let model = catalog
        .entry(CatalogRole::ReasoningModel)
        .ok_or(ComponentManagerError::CatalogInvalid)?
        .component()
        .manifest();
    Ok(LocalReasoningDownload {
        catalog_identity: catalog.token_sha256().to_owned(),
        runtime_version: runtime.version.clone(),
        model_version: model.version.clone(),
        size_bytes: runtime
            .size_bytes
            .checked_add(model.size_bytes)
            .ok_or(ComponentManagerError::CatalogInvalid)?,
    })
}

#[cfg(all(
    test,
    any(
        all(windows, target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64")
    )
))]
#[path = "kalvoice_provisioning_tests.rs"]
pub(crate) mod provisioning_tests;

fn speech_component(preference_id: &str) -> Option<SpeechComponent> {
    SPEECH_COMPONENTS
        .iter()
        .copied()
        .find(|component| component.preference_id == preference_id)
}

fn authorize_download(
    preference_id: &str,
    consent: bool,
) -> Result<SpeechComponent, ComponentManagerError> {
    let component =
        speech_component(preference_id).ok_or(ComponentManagerError::UnknownSpeechModel)?;
    if !consent {
        return Err(ComponentManagerError::ConsentRequired);
    }
    Ok(component)
}

fn validate_track(
    channel: &str,
    platform: ComponentPlatform,
    arch: ComponentArch,
) -> Result<(), ComponentManagerError> {
    if !matches!(channel, "stable" | "beta" | "dev")
        || !matches!(
            (platform, arch),
            (ComponentPlatform::Windows, ComponentArch::X86_64)
                | (ComponentPlatform::Macos, ComponentArch::Aarch64)
        )
    {
        return Err(ComponentManagerError::CatalogInvalid);
    }
    Ok(())
}

fn catalog_url(
    channel: &str,
    platform: ComponentPlatform,
    arch: ComponentArch,
) -> Result<String, ComponentManagerError> {
    validate_track(channel, platform, arch)?;
    Ok(format!(
        "{CATALOG_ORIGIN}/components/v1/catalog/{channel}/{}/{}.jws",
        platform_segment(platform),
        arch_segment(arch)
    ))
}

const fn platform_segment(platform: ComponentPlatform) -> &'static str {
    match platform {
        ComponentPlatform::Windows => "windows",
        ComponentPlatform::Macos => "macos",
        ComponentPlatform::Linux => "linux",
    }
}

const fn arch_segment(arch: ComponentArch) -> &'static str {
    match arch {
        ComponentArch::X86_64 => "x86_64",
        ComponentArch::Aarch64 => "aarch64",
    }
}

fn map_catalog_error(error: CatalogVerifyError) -> ComponentManagerError {
    match error {
        CatalogVerifyError::WrongChannel
        | CatalogVerifyError::WrongTarget
        | CatalogVerifyError::ComponentMismatch
        | CatalogVerifyError::InvalidContract
        | CatalogVerifyError::InvalidDocument
        | CatalogVerifyError::Signature(_)
        | CatalogVerifyError::NestedComponent(_) => ComponentManagerError::CatalogInvalid,
    }
}

fn map_acquisition_error(error: ComponentAcquisitionError) -> ComponentManagerError {
    match error {
        ComponentAcquisitionError::ConsentRequired => ComponentManagerError::ConsentRequired,
        ComponentAcquisitionError::Cancelled => ComponentManagerError::Cancelled,
        ComponentAcquisitionError::NotEnoughSpace => ComponentManagerError::ResourceUnavailable,
        ComponentAcquisitionError::Install(ComponentStoreError::InUse) => {
            ComponentManagerError::InUse
        }
        ComponentAcquisitionError::Install(_) | ComponentAcquisitionError::Storage(_) => {
            ComponentManagerError::StorageUnavailable
        }
        _ => ComponentManagerError::AcquisitionFailed,
    }
}

fn map_store_error(error: ComponentStoreError) -> ComponentManagerError {
    match error {
        ComponentStoreError::InUse => ComponentManagerError::InUse,
        ComponentStoreError::NotInstalled => ComponentManagerError::NotInstalled,
        _ => ComponentManagerError::StorageUnavailable,
    }
}

fn unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn read_catalog_file(path: &Path, expected_sha256: &str) -> Result<String, ComponentManagerError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            ComponentManagerError::CatalogUnavailable
        } else {
            ComponentManagerError::CatalogStorage
        }
    })?;
    if !safe_regular_file(&metadata)
        || metadata.len() == 0
        || metadata.len() > MAX_CATALOG_TOKEN_LENGTH as u64
    {
        return Err(ComponentManagerError::CatalogStorage);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)
        .and_then(|mut file| file.read_to_end(&mut bytes))
        .map_err(|_| ComponentManagerError::CatalogStorage)?;
    if bytes.len() as u64 != metadata.len() || sha256_hex(&bytes) != expected_sha256 {
        return Err(ComponentManagerError::CatalogStorage);
    }
    String::from_utf8(bytes).map_err(|_| ComponentManagerError::CatalogStorage)
}

#[cfg(unix)]
fn safe_regular_file(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
    metadata.file_type().is_file()
        && metadata.nlink() == 1
        && metadata.permissions().mode() & 0o077 == 0
}

#[cfg(windows)]
fn safe_regular_file(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt as _;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_type().is_file() && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0
}

#[cfg(not(any(unix, windows)))]
fn safe_regular_file(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_file()
}

fn atomic_publish(source: &Path, destination: &Path) -> Result<(), ComponentManagerError> {
    match fs::hard_link(source, destination) {
        Ok(()) => fs::remove_file(source).map_err(|_| ComponentManagerError::CatalogStorage),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            fs::remove_file(source).map_err(|_| ComponentManagerError::CatalogStorage)?;
            Ok(())
        }
        Err(_) => Err(ComponentManagerError::CatalogStorage),
    }
}

#[cfg(unix)]
fn sync_parent(directory: &Path) -> Result<(), ComponentManagerError> {
    File::open(directory)
        .and_then(|file| file.sync_all())
        .map_err(|_| ComponentManagerError::CatalogStorage)
}

#[cfg(not(unix))]
fn sync_parent(_directory: &Path) -> Result<(), ComponentManagerError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speech_preferences_map_to_the_exact_signed_component_set() {
        assert_eq!(models::DEFAULT_MODEL, "tiny.en");
        assert_eq!(
            SPEECH_COMPONENTS
                .iter()
                .map(|component| component.preference_id)
                .collect::<Vec<_>>(),
            models::CATALOG
                .iter()
                .map(|model| model.id)
                .collect::<Vec<_>>()
        );
        assert_eq!(
            SPEECH_COMPONENTS
                .iter()
                .map(|component| component.component_id)
                .collect::<Vec<_>>(),
            SPEECH_COMPONENT_IDS
        );
        assert_eq!(DEFAULT_SPEECH_COMPONENT_ID, SPEECH_COMPONENT_IDS[0]);
    }

    #[test]
    fn catalog_urls_are_exact_and_wrong_targets_fail_closed() {
        assert_eq!(
            catalog_url("stable", ComponentPlatform::Windows, ComponentArch::X86_64).unwrap(),
            "https://kalcoded.com/components/v1/catalog/stable/windows/x86_64.jws"
        );
        assert_eq!(
            catalog_url("beta", ComponentPlatform::Macos, ComponentArch::Aarch64).unwrap(),
            "https://kalcoded.com/components/v1/catalog/beta/macos/aarch64.jws"
        );
        assert!(
            catalog_url(
                "production",
                ComponentPlatform::Macos,
                ComponentArch::Aarch64
            )
            .is_err()
        );
        assert!(catalog_url("stable", ComponentPlatform::Macos, ComponentArch::X86_64).is_err());
    }

    #[test]
    fn cache_paths_accept_only_lowercase_sha256_identities() {
        let temp = tempfile::tempdir().unwrap();
        let root = TrustedComponentDirectory::open_existing(temp.path()).unwrap();
        let cache = CatalogCache::new(
            &root,
            "stable",
            ComponentPlatform::Windows,
            ComponentArch::X86_64,
        )
        .unwrap();
        let digest = "a".repeat(64);
        assert!(
            cache
                .path(&digest)
                .unwrap()
                .ends_with(format!("catalog-{digest}.jws"))
        );
        for invalid in [
            "a".to_owned(),
            "A".repeat(64),
            format!("{}g", "a".repeat(63)),
        ] {
            assert!(cache.path(&invalid).is_err());
        }
    }

    #[test]
    fn consent_and_exact_model_validation_happen_before_acquisition() {
        assert_eq!(
            authorize_download("tiny.en", false),
            Err(ComponentManagerError::ConsentRequired)
        );
        assert_eq!(
            authorize_download("not-a-model", true),
            Err(ComponentManagerError::UnknownSpeechModel)
        );
        assert_eq!(
            authorize_download("tiny.en", true)
                .expect("authorized")
                .component_id,
            DEFAULT_SPEECH_COMPONENT_ID
        );
    }

    #[test]
    fn catalog_cache_is_hash_addressed_and_read_back_exactly() {
        let temp = tempfile::tempdir().unwrap();
        let root = TrustedComponentDirectory::open_existing(temp.path()).unwrap();
        let cache = CatalogCache::new(
            &root,
            "stable",
            ComponentPlatform::Windows,
            ComponentArch::X86_64,
        )
        .unwrap();
        let token = "header.payload.signature";
        let digest = sha256_hex(token.as_bytes());
        assert_eq!(cache.retain(token, &digest).unwrap(), token);
        assert_eq!(cache.read(&digest).unwrap(), token);
        assert_eq!(cache.retain(token, &digest).unwrap(), token);
        assert!(cache.retain("different", &digest).is_err());
    }
}
