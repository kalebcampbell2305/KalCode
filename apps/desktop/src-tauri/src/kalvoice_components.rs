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
    ComponentArch, ComponentKind, ComponentPlatform, ComponentVerifier, VerifyError,
};
use kalcode_kalvoice::component_store::{
    ComponentLease, ComponentReceiptStatus, ComponentSelector, ComponentStore, ComponentStoreError,
    InstallConsent, LOCAL_REASONING_MODEL_ID, LOCAL_REASONING_RUNTIME_ABI,
    LOCAL_REASONING_RUNTIME_ID, TrustedComponentDirectory, host_local_reasoning_contract,
};
use kalcode_kalvoice::models::{self, SpeechModelInfo, SpeechModelState};
use kalcode_kalvoice::signals::LocalReasoningDownload;
use kalcode_resources::{
    AdmissionDecision, AdmissionReason, GovernorUpdate, HoldReason, ResourceKind,
};
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
/// A download the Resource Governor holds waits this long (re-evaluated on every governor
/// sample) before the attempt ends.
const ADMISSION_WAIT: Duration = Duration::from_secs(10 * 60);
/// How often a waiting download looks for cancellation, a deadline, or the end of push to talk.
const WAIT_SLICE: Duration = Duration::from_millis(100);
/// While a download stays deferred for push to talk, it is traced this often (durations only).
const DEFERRAL_HEARTBEAT: Duration = Duration::from_secs(60);
const CAPACITY_EVENT_BUFFER: usize = 16;

pub(crate) const SPEECH_COMPONENT_IDS: [&str; 5] = [
    "kalvoice.speech.whisper.tiny-en",
    "kalvoice.speech.whisper.base-en",
    "kalvoice.speech.whisper.small-en",
    "kalvoice.speech.whisper.base",
    "kalvoice.speech.whisper.small",
];
const DEFAULT_SPEECH_COMPONENT_ID: &str = SPEECH_COMPONENT_IDS[0];
pub(crate) const REASONING_DOWNLOAD_ID: &str = "local-reasoning";

/// Who authorized a component download. The acquisition pipeline (catalog signature, rollback
/// floor, per-component signature, size and SHA-256) is identical for every grant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DownloadConsent {
    /// No consent: nothing is fetched.
    Declined,
    /// The owner confirmed a download dialog.
    User,
    /// System-granted consent for a default component only (the default speech model and the
    /// local-intelligence pair), under KalCode's zero-setup provisioning.
    AutomaticDefault,
}

impl DownloadConsent {
    pub(crate) const fn from_user(consent: bool) -> Self {
        if consent { Self::User } else { Self::Declined }
    }

    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::Declined => "declined",
            Self::User => "user",
            Self::AutomaticDefault => "automatic_default",
        }
    }

    /// The consent recorded on the installed receipt; `None` when nothing may be fetched.
    pub(crate) const fn install(self) -> Option<InstallConsent> {
        match self {
            Self::Declined => None,
            Self::User => Some(InstallConsent::User),
            Self::AutomaticDefault => Some(InstallConsent::AutomaticDefault),
        }
    }
}

/// Where a registered download stands. Every phase is observed, never assumed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DownloadPhase {
    /// Fetching and verifying the signed catalog.
    Preparing,
    /// Held by the Resource Governor, with a safe reason code.
    WaitingForResources(&'static str),
    /// Held while push to talk is in use.
    WaitingForTalk,
    Downloading,
    /// Every byte arrived; the store is verifying and installing it.
    Verifying,
}

/// A running download as the UI may see it: no URL, token or path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DownloadSnapshot {
    pub(crate) model_id: String,
    pub(crate) consent: DownloadConsent,
    pub(crate) phase: DownloadPhase,
    pub(crate) received_bytes: u64,
    pub(crate) total_bytes: u64,
}

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
    CapacityHeld(ComponentCapacityReason),
    AcquisitionFailed(ComponentAcquisitionFailure),
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
            Self::ResourceUnavailable => "KalVoice could not verify enough system capacity. This download attempt ended. Allow resource readings to refresh, then retry the download.",
            Self::CapacityHeld(reason) => reason.message(),
            Self::AcquisitionFailed(reason) => return reason.fmt(formatter),
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
            Self::ResourceUnavailable | Self::CapacityHeld(_) => "resource_capacity_unavailable",
            Self::AcquisitionFailed(_) => "component_acquisition_failed",
            Self::StorageUnavailable => "component_storage_failed",
            Self::InUse => "component_in_use",
            Self::NotInstalled => "model_not_installed",
        }
    }

    /// Why automatic provisioning must stop until the next launch (a manual download still
    /// works), or `None` when a later attempt can succeed unchanged (network, capacity, storage
    /// contention, an expired or not-yet-valid window).
    pub(crate) const fn terminal_reason(self) -> Option<&'static str> {
        match self {
            Self::ConsentRequired | Self::UnknownSpeechModel => Some("consent_required"),
            Self::AcquisitionFailed(ComponentAcquisitionFailure::WrongTarget) => {
                Some("components_unsupported")
            }
            Self::CatalogInvalid
            | Self::CatalogRollback
            | Self::AcquisitionFailed(
                ComponentAcquisitionFailure::Manifest(
                    VerifyError::BadSignature
                    | VerifyError::UnknownKey
                    | VerifyError::UnsupportedHeader
                    | VerifyError::Malformed
                    | VerifyError::InvalidDocument
                    | VerifyError::InvalidUrl,
                )
                | ComponentAcquisitionFailure::UnsafeStaging,
            ) => Some("components_unverified"),
            _ => None,
        }
    }
}

/// Only typed, bounded causes cross into the UI and diagnostic event. Never retain an artifact
/// URL, signed token, filesystem path, or transport error string here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ComponentAcquisitionFailure {
    Manifest(VerifyError),
    WrongTarget,
    InvalidResponse,
    Server(u16),
    Network,
    ChecksumMismatch,
    UnsafeStaging,
}

impl ComponentAcquisitionFailure {
    fn diagnostic(self) -> (&'static str, &'static str, Option<u16>) {
        match self {
            Self::Manifest(reason) => ("manifest_validation", reason.code(), None),
            Self::WrongTarget => ("target_validation", "wrong_target", None),
            Self::InvalidResponse => ("download", "invalid_response", None),
            Self::Server(status) => ("download", "http_status", Some(status)),
            Self::Network => ("download", "network", None),
            Self::ChecksumMismatch => ("integrity_validation", "checksum_mismatch", None),
            Self::UnsafeStaging => ("download_staging", "unsafe_staging", None),
        }
    }
}

impl std::fmt::Display for ComponentAcquisitionFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Manifest(VerifyError::Expired) => "KalVoice rejected expired signed component metadata. Try again after the component catalog is refreshed.",
            Self::Manifest(VerifyError::NotYetValid) => "KalVoice's signed component metadata is not valid yet. Check your system date and time, then retry.",
            Self::Manifest(VerifyError::BadSignature) => "KalVoice rejected the component metadata because its signature verification failed. This component was not installed.",
            Self::Manifest(VerifyError::UnknownKey) => "KalVoice rejected the component metadata because its signing key is not trusted. This component was not installed.",
            Self::Manifest(VerifyError::InvalidUrl) => "KalVoice rejected a component download address that is not authorized by its signed metadata. This component was not installed.",
            Self::Manifest(VerifyError::UnsupportedHeader) => "KalVoice rejected an unsupported component signature format. This component was not installed.",
            Self::Manifest(VerifyError::Malformed | VerifyError::InvalidDocument) => "KalVoice rejected malformed signed component metadata. This component was not installed.",
            Self::WrongTarget => "This component does not support your operating system and processor. This component was not installed.",
            Self::InvalidResponse => "The component server returned an invalid download response. Retry the download.",
            Self::Server(status) => return write!(formatter, "The component server returned HTTP {status}. Try again later."),
            Self::Network => "The component download could not complete over the network. Check your connection, then retry to resume saved download progress.",
            Self::ChecksumMismatch => "KalVoice rejected the downloaded component because its integrity check failed. Retry the download.",
            Self::UnsafeStaging => "KalVoice could not safely use its download storage. This component was not installed.",
        })
    }
}

/// Only bounded reason categories cross into the download error. Probe details, volume paths,
/// process information and provider identities must never be copied from an admission decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ComponentCapacityReason {
    Cpu,
    Memory,
    KalCodeMemory,
    DiskSpace,
    WorkloadLimit,
    TelemetryUnavailable(ResourceKind),
    StaleTelemetry,
    UnverifiedTelemetry,
    SamplerUnavailable,
}

impl ComponentCapacityReason {
    /// A safe code for a download that is waiting for this resource.
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::Cpu => "cpu",
            Self::Memory => "memory",
            Self::KalCodeMemory => "kalcode_memory",
            Self::DiskSpace => "disk_space",
            Self::WorkloadLimit => "workload_limit",
            Self::TelemetryUnavailable(_) | Self::UnverifiedTelemetry | Self::StaleTelemetry => {
                "resource_readings"
            }
            Self::SamplerUnavailable => "resource_monitor",
        }
    }

    fn message(self) -> &'static str {
        match self {
            Self::Cpu => {
                "There is not enough CPU headroom within KalCode's safety limits. This download attempt ended. Let CPU-intensive work finish, then retry the download."
            }
            Self::Memory => {
                "There is not enough memory headroom within KalCode's safety limits. This download attempt ended. Close unneeded memory-heavy applications safely, allow readings to refresh, then retry the download."
            }
            Self::KalCodeMemory => {
                "There is not enough memory headroom within KalCode's memory limit for this download. This download attempt ended. Let active KalCode work finish, then retry the download."
            }
            Self::DiskSpace => {
                "There is not enough available disk space within KalCode's safety limits. This download attempt ended. Free disk space safely, allow readings to refresh, then retry the download."
            }
            Self::WorkloadLimit => {
                "KalCode has reached its concurrent-work limit. This download attempt ended. Let active work finish, then retry the download."
            }
            Self::TelemetryUnavailable(ResourceKind::Cpu) => {
                "KalCode could not verify CPU capacity. This download attempt ended. Allow CPU readings to become available, then retry the download."
            }
            Self::TelemetryUnavailable(ResourceKind::Memory) => {
                "KalCode could not verify available memory. This download attempt ended. Allow memory readings to become available, then retry the download."
            }
            Self::TelemetryUnavailable(ResourceKind::DiskSpace) => {
                "KalCode could not verify available disk space. This download attempt ended. Allow disk readings to become available, then retry the download."
            }
            Self::TelemetryUnavailable(_) | Self::UnverifiedTelemetry => {
                "KalCode could not verify current resource readings. This download attempt ended. Allow resource readings to refresh, then retry the download."
            }
            Self::StaleTelemetry => {
                "KalCode's resource readings are out of date. This download attempt ended. Allow resource readings to refresh, then retry the download."
            }
            Self::SamplerUnavailable => {
                "KalCode's capacity monitoring is not ready. This download attempt ended. Retry the download after monitoring becomes available."
            }
        }
    }
}

fn acquisition_capacity_error(decision: AdmissionDecision) -> ComponentManagerError {
    let reason = decision.reasons.iter().find_map(|reason| match reason {
        AdmissionReason::GovernorNotReady { .. } => {
            Some(ComponentCapacityReason::SamplerUnavailable)
        }
        AdmissionReason::SnapshotStale { .. } => Some(ComponentCapacityReason::StaleTelemetry),
        AdmissionReason::SnapshotMissing
        | AdmissionReason::SnapshotFromFuture { .. }
        | AdmissionReason::SnapshotModeMismatch { .. } => {
            Some(ComponentCapacityReason::UnverifiedTelemetry)
        }
        AdmissionReason::RequiredTelemetryUnknown { resource, .. }
        | AdmissionReason::RequiredTelemetryUnavailable { resource, .. } => {
            Some(ComponentCapacityReason::TelemetryUnavailable(*resource))
        }
        AdmissionReason::Capacity { holds } => holds.iter().find_map(|hold| match hold {
            HoldReason::Pressure {
                resource: ResourceKind::Cpu,
                ..
            }
            | HoldReason::CpuHeadroom { .. } => Some(ComponentCapacityReason::Cpu),
            HoldReason::Pressure {
                resource: ResourceKind::Memory,
                ..
            }
            | HoldReason::MemoryHeadroom { .. } => Some(ComponentCapacityReason::Memory),
            HoldReason::Pressure {
                resource: ResourceKind::DiskSpace,
                ..
            } => Some(ComponentCapacityReason::DiskSpace),
            HoldReason::KalCodeMemoryCap { .. } => Some(ComponentCapacityReason::KalCodeMemory),
            HoldReason::UserLimit { .. } | HoldReason::ProviderLimit { .. } => {
                Some(ComponentCapacityReason::WorkloadLimit)
            }
            _ => None,
        }),
        AdmissionReason::HardPressure { pressure } => Some(match pressure {
            kalcode_resources::HardPressure::MemoryCritical { .. }
            | kalcode_resources::HardPressure::CommitExhausted { .. } => {
                ComponentCapacityReason::Memory
            }
            kalcode_resources::HardPressure::DiskFull { .. } => ComponentCapacityReason::DiskSpace,
        }),
        AdmissionReason::CapacityUnavailable => None,
    });
    reason.map_or(
        ComponentManagerError::ResourceUnavailable,
        ComponentManagerError::CapacityHeld,
    )
}

struct DownloadState {
    cancel: Arc<AtomicBool>,
    received_bytes: u64,
    total_bytes: u64,
    consent: DownloadConsent,
    phase: DownloadPhase,
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
        // The download left the list: the UI must stop showing it as running.
        self.manager.notify();
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
        consent: InstallConsent,
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
        consent: InstallConsent,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64, u64),
    ) -> Result<(), ComponentAcquisitionError> {
        // The consent kind is persisted on the component's receipt.
        self.0
            .acquire_as(token, now_unix, consent, cancel, progress)
            .map(|_| ())
    }
}

trait HeldReservation: Send {}
impl HeldReservation for LocalTaskReservation {}

/// What ended one wait for the governor.
enum CapacityWake {
    /// A fresh sample: evaluate admission again.
    Sample,
    /// Nothing new within the slice.
    Idle,
    /// The sampler is gone; no sample will come.
    Closed,
}

trait CapacityUpdates: Send {
    fn wait(&self, timeout: Duration) -> CapacityWake;
}

impl CapacityUpdates for std::sync::mpsc::Receiver<GovernorUpdate> {
    fn wait(&self, timeout: Duration) -> CapacityWake {
        match self.recv_timeout(timeout) {
            Ok(GovernorUpdate::Sample(_)) => CapacityWake::Sample,
            Ok(_) | Err(std::sync::mpsc::RecvTimeoutError::Timeout) => CapacityWake::Idle,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => CapacityWake::Closed,
        }
    }
}

trait ComponentAdmission: Send + Sync {
    fn reserve_acquisition(
        &self,
        size_bytes: u64,
    ) -> Result<Box<dyn HeldReservation>, ComponentManagerError>;

    /// Governor samples that re-evaluate a held download. `None`: no sampler, so a hold ends
    /// the attempt at once.
    fn updates(&self) -> Option<Box<dyn CapacityUpdates>> {
        None
    }
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
            .map_err(acquisition_capacity_error)
    }

    fn updates(&self) -> Option<Box<dyn CapacityUpdates>> {
        self.0
            .subscribe(CAPACITY_EVENT_BUFFER)
            .map(|updates| Box::new(updates) as Box<dyn CapacityUpdates>)
    }
}

/// Reports whether push to talk is in use right now (the microphone is live).
pub(crate) type InteractiveProbe = Arc<dyn Fn() -> bool + Send + Sync>;
/// Told after any download changes phase or progress (never while a manager lock is held).
pub(crate) type DownloadObserver = Arc<dyn Fn() + Send + Sync>;

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
        catalogs.sort_by_key(|catalog| std::cmp::Reverse(catalog.0));
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
    admission_wait: Duration,
    interactive: Mutex<Option<InteractiveProbe>>,
    observer: Mutex<Option<DownloadObserver>>,
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
        let root = runtime_component_root(&state.paths.data_dir)?;
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
            admission_wait: ADMISSION_WAIT,
            interactive: Mutex::new(None),
            observer: Mutex::new(None),
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
            .filter_map(|spec| {
                // Only advertise speech models with an implemented signed component mapping.
                let component = speech_component(spec.id)?;
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
                Some(SpeechModelInfo {
                    id: spec.id.to_owned(),
                    display_name: spec.display_name.to_owned(),
                    summary: spec.summary.to_owned(),
                    size_bytes: running
                        .map(|running| running.total_bytes)
                        .filter(|size| *size > 0)
                        .unwrap_or(spec.size_bytes),
                    english_only: spec.english_only,
                    state,
                    source: "KalCode's signed component catalog on kalcoded.com".into(),
                })
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
        progress: impl FnMut(u64, u64),
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
        let catalog = verify_catalog(&self.verifier, &token, unix_seconds(), self.contract())
            .map_err(map_catalog_error)?;
        if catalog_identity != Some(catalog.token_sha256()) {
            return Err(ComponentManagerError::ConsentRequired);
        }
        let cancel = self.register(REASONING_DOWNLOAD_ID, DownloadConsent::User)?;
        let _registration = DownloadRegistration {
            manager: self,
            preference_id: REASONING_DOWNLOAD_ID.into(),
        };
        self.install_reasoning(&token, &catalog, InstallConsent::User, &cancel, progress)
    }

    /// Zero-setup provisioning of the local-intelligence pair: the signed catalog is fetched
    /// and verified exactly as the review dialog does, under system-granted consent for this
    /// default component. Already installed components are reused, never fetched again.
    pub(crate) fn download_reasoning_automatic(
        &self,
        progress: impl FnMut(u64, u64),
    ) -> Result<(), ComponentManagerError> {
        if self.reasoning_installed() {
            return Ok(());
        }
        let cancel = self.register(REASONING_DOWNLOAD_ID, DownloadConsent::AutomaticDefault)?;
        let _registration = DownloadRegistration {
            manager: self,
            preference_id: REASONING_DOWNLOAD_ID.into(),
        };
        let token = self.fetcher.fetch(
            &catalog_url(self.channel, self.platform, self.arch)?,
            &cancel,
        )?;
        let catalog = verify_catalog(&self.verifier, &token, unix_seconds(), self.contract())
            .map_err(map_catalog_error)?;
        self.install_reasoning(
            &token,
            &catalog,
            InstallConsent::AutomaticDefault,
            &cancel,
            progress,
        )
    }

    /// The one acquisition path for the reasoning pair, whoever consented.
    fn install_reasoning(
        &self,
        token: &str,
        catalog: &VerifiedComponentCatalog,
        consent: InstallConsent,
        cancel: &Arc<AtomicBool>,
        mut progress: impl FnMut(u64, u64),
    ) -> Result<(), ComponentManagerError> {
        let now = unix_seconds();
        let quote = reasoning_quote(catalog)?;
        self.update(REASONING_DOWNLOAD_ID, |running| {
            running.total_bytes = quote.size_bytes;
        });
        let _reservation =
            self.reserve_admitted(REASONING_DOWNLOAD_ID, quote.size_bytes, cancel)?;
        let retained = self.cache.retain(token, catalog.token_sha256())?;
        let retained_catalog = verify_catalog(&self.verifier, &retained, now, self.contract())
            .map_err(map_catalog_error)?;
        self.floor
            .advance(
                &retained_catalog,
                now,
                Instant::now() + FLOOR_TIMEOUT,
                cancel,
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
            self.set_phase(REASONING_DOWNLOAD_ID, DownloadPhase::Downloading);
            self.acquisition
                .acquire(
                    entry.token(),
                    unix_seconds(),
                    consent,
                    cancel,
                    &mut |received, _| {
                        let received = completed + received;
                        self.progressed(REASONING_DOWNLOAD_ID, received, quote.size_bytes, cancel);
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
        progress: impl FnMut(u64, u64),
    ) -> Result<(), ComponentManagerError> {
        self.download_speech_with(preference_id, DownloadConsent::from_user(consent), progress)
    }

    /// Zero-setup provisioning of the default speech model (`tiny.en`) under system-granted
    /// consent. Any installed speech model is reused: nothing is fetched while one is present.
    pub(crate) fn download_default_speech(
        &self,
        progress: impl FnMut(u64, u64),
    ) -> Result<(), ComponentManagerError> {
        if self.speech_present() {
            return Ok(());
        }
        self.download_speech_with(
            models::DEFAULT_MODEL,
            DownloadConsent::AutomaticDefault,
            progress,
        )
    }

    fn download_speech_with(
        &self,
        preference_id: &str,
        consent: DownloadConsent,
        mut progress: impl FnMut(u64, u64),
    ) -> Result<(), ComponentManagerError> {
        let component = authorize_download(preference_id, consent)?;
        let granted = consent
            .install()
            .ok_or(ComponentManagerError::ConsentRequired)?;
        let cancel = self.register(preference_id, consent)?;
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
        if !self.update(preference_id, |running| running.total_bytes = size_bytes) {
            return Err(ComponentManagerError::Cancelled);
        }

        let _reservation = self.reserve_admitted(preference_id, size_bytes, &cancel)?;
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
        self.set_phase(preference_id, DownloadPhase::Downloading);
        let result = self.acquisition.acquire(
            &signed_manifest,
            now_unix,
            granted,
            &cancel,
            &mut |received, total| {
                self.progressed(preference_id, received, total, &cancel);
                progress(received, total);
            },
        );
        result.map_err(map_acquisition_error)
    }

    /// Registers a download under its consent, or refuses a duplicate or a sealed manager.
    fn register(
        &self,
        preference_id: &str,
        consent: DownloadConsent,
    ) -> Result<Arc<AtomicBool>, ComponentManagerError> {
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
                    consent,
                    phase: DownloadPhase::Preparing,
                },
            );
        }
        // Only the consent kind is recorded: never a URL, token or path.
        tracing::info!(
            event = "kalvoice.component_download_authorized",
            component = preference_id,
            consent = consent.code()
        );
        self.notify();
        Ok(cancel)
    }

    /// Applies `change` to a running download. `false` when it is no longer registered.
    fn update(&self, preference_id: &str, change: impl FnOnce(&mut DownloadState)) -> bool {
        let updated = self
            .downloads
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .running
            .get_mut(preference_id)
            .map(change)
            .is_some();
        if updated {
            self.notify();
        }
        updated
    }

    fn set_phase(&self, preference_id: &str, phase: DownloadPhase) {
        let changed = self
            .downloads
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .running
            .get_mut(preference_id)
            .is_some_and(|running| std::mem::replace(&mut running.phase, phase) != phase);
        if changed {
            self.notify();
        }
    }

    /// Records progress and yields the network while push to talk is in use: the acquirer's
    /// read loop stays parked here until the microphone closes (or the download is cancelled).
    fn progressed(&self, preference_id: &str, received: u64, total: u64, cancel: &AtomicBool) {
        self.update(preference_id, |running| {
            running.received_bytes = received;
            running.total_bytes = total;
            running.phase = if total > 0 && received >= total {
                DownloadPhase::Verifying
            } else {
                DownloadPhase::Downloading
            };
        });
        if self.talk_active() {
            let resume = self.phase(preference_id);
            self.wait_for_talk(preference_id, cancel);
            if let Some(phase) = resume {
                self.set_phase(preference_id, phase);
            }
        }
    }

    fn phase(&self, preference_id: &str) -> Option<DownloadPhase> {
        self.downloads
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .running
            .get(preference_id)
            .map(|running| running.phase)
    }

    fn talk_active(&self) -> bool {
        let probe = self
            .interactive
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        probe.is_some_and(|probe| probe())
    }

    /// Parks while push to talk is in use. Returns `false` if the download was cancelled.
    fn wait_for_talk(&self, preference_id: &str, cancel: &AtomicBool) -> bool {
        let mut deferred: Option<(Instant, Instant)> = None;
        while self.talk_active() {
            if cancel.load(Ordering::SeqCst) {
                return false;
            }
            match deferred.as_mut() {
                None => {
                    let now = Instant::now();
                    deferred = Some((now, now));
                    self.set_phase(preference_id, DownloadPhase::WaitingForTalk);
                    tracing::info!(
                        event = "kalvoice.component_download_deferred",
                        component = preference_id,
                        reason = "push_to_talk"
                    );
                }
                // An indefinitely deferred download stays observable (durations only).
                Some((since, beat)) if beat.elapsed() >= DEFERRAL_HEARTBEAT => {
                    *beat = Instant::now();
                    tracing::info!(
                        event = "kalvoice.component_download_still_deferred",
                        component = preference_id,
                        reason = "push_to_talk",
                        deferred_s = since.elapsed().as_secs()
                    );
                }
                Some(_) => {}
            }
            std::thread::sleep(WAIT_SLICE);
        }
        if let Some((since, _)) = deferred {
            tracing::info!(
                event = "kalvoice.component_download_resumed",
                component = preference_id,
                deferred_ms = u64::try_from(since.elapsed().as_millis()).unwrap_or(u64::MAX)
            );
        }
        !cancel.load(Ordering::SeqCst)
    }

    /// Reserves acquisition capacity, waiting (bounded) while the Resource Governor holds the
    /// download: every fresh governor sample re-evaluates admission, and push to talk always
    /// goes first. With no sampler, or once the bounded wait ends, the hold's reason is returned.
    fn reserve_admitted(
        &self,
        preference_id: &str,
        size_bytes: u64,
        cancel: &AtomicBool,
    ) -> Result<Box<dyn HeldReservation>, ComponentManagerError> {
        // Subscribe before the first evaluation so no sample between a hold and the wait is lost.
        let updates = self.admission.updates();
        let deadline = Instant::now() + self.admission_wait;
        let mut logged = None;
        loop {
            if !self.wait_for_talk(preference_id, cancel) {
                return Err(ComponentManagerError::Cancelled);
            }
            let error = match self.admission.reserve_acquisition(size_bytes) {
                Ok(reservation) => {
                    self.set_phase(preference_id, DownloadPhase::Preparing);
                    return Ok(reservation);
                }
                Err(
                    error @ (ComponentManagerError::CapacityHeld(_)
                    | ComponentManagerError::ResourceUnavailable),
                ) => error,
                Err(error) => return Err(error),
            };
            let Some(updates) = updates.as_ref() else {
                return Err(error);
            };
            let reason = match error {
                ComponentManagerError::CapacityHeld(reason) => reason.code(),
                _ => "capacity_unavailable",
            };
            if logged != Some(reason) {
                logged = Some(reason);
                tracing::info!(
                    event = "kalvoice.component_download_waiting",
                    component = preference_id,
                    reason
                );
            }
            self.set_phase(preference_id, DownloadPhase::WaitingForResources(reason));
            loop {
                if cancel.load(Ordering::SeqCst) {
                    return Err(ComponentManagerError::Cancelled);
                }
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    tracing::info!(
                        event = "kalvoice.component_download_wait_ended",
                        component = preference_id,
                        reason
                    );
                    return Err(error);
                }
                match updates.wait(remaining.min(WAIT_SLICE)) {
                    CapacityWake::Sample => break,
                    CapacityWake::Idle => {}
                    CapacityWake::Closed => return Err(error),
                }
            }
        }
    }

    fn notify(&self) {
        let observer = self
            .observer
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        if let Some(observer) = observer {
            observer();
        }
    }

    /// Push to talk's live state: while it reports `true`, no component bytes are fetched.
    pub(crate) fn set_interactive_probe(&self, probe: InteractiveProbe) {
        *self
            .interactive
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(probe);
    }

    pub(crate) fn set_observer(&self, observer: DownloadObserver) {
        *self.observer.lock().unwrap_or_else(PoisonError::into_inner) = Some(observer);
    }

    /// Every registered download, for truthful progress in the UI.
    pub(crate) fn download_snapshots(&self) -> Vec<DownloadSnapshot> {
        let downloads = self
            .downloads
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let mut snapshots = downloads
            .running
            .iter()
            .map(|(model_id, running)| DownloadSnapshot {
                model_id: model_id.clone(),
                consent: running.consent,
                phase: running.phase,
                received_bytes: running.received_bytes,
                total_bytes: running.total_bytes,
            })
            .collect::<Vec<_>>();
        snapshots.sort_by(|a, b| a.model_id.cmp(&b.model_id));
        snapshots
    }

    /// Whether any speech model has a verified receipt in the signed store. Reads receipts only
    /// (no OS keychain), so a slow credential store can never make an installed model look
    /// missing and trigger a second download.
    pub(crate) fn speech_present(&self) -> bool {
        let now_unix = unix_seconds();
        SPEECH_COMPONENTS.iter().any(|component| {
            matches!(
                self.store
                    .status(&self.speech_selector(*component), now_unix),
                ComponentReceiptStatus::Present { .. }
            )
        })
    }

    /// Bytes of the reasoning pair already on disk (installed or partially downloaded) and the
    /// pair's signed size, so a paused download shows where it will resume. `(0, 0)` before any
    /// catalog was accepted.
    pub(crate) fn reasoning_on_disk(&self) -> (u64, u64) {
        let Some(catalog) = self
            .current_catalog
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
        else {
            return (0, 0);
        };
        let now_unix = unix_seconds();
        [CatalogRole::ReasoningRuntime, CatalogRole::ReasoningModel]
            .into_iter()
            .filter_map(|role| catalog.entry(role))
            .map(|entry| {
                let manifest = entry.component().manifest();
                let selector = ComponentSelector {
                    component_id: manifest.component_id.clone(),
                    kind: manifest.kind,
                    platform: manifest.platform,
                    arch: manifest.arch,
                    runtime_abi: manifest.runtime_abi.clone(),
                };
                let retained = if matches!(
                    self.store.status(&selector, now_unix),
                    ComponentReceiptStatus::Present { .. }
                ) {
                    manifest.size_bytes
                } else {
                    fs::metadata(
                        self.staging_directory
                            .join(format!("{}.partial", manifest.sha256)),
                    )
                    .map(|metadata| metadata.len().min(manifest.size_bytes))
                    .unwrap_or(0)
                };
                (retained, manifest.size_bytes)
            })
            .fold((0, 0), |(retained, total), (part, size)| {
                (retained + part, total + size)
            })
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

/// The owner's confirmation authorizes any catalog speech model. System-granted consent covers
/// only the default model; every other model keeps its download dialog.
fn authorize_download(
    preference_id: &str,
    consent: DownloadConsent,
) -> Result<SpeechComponent, ComponentManagerError> {
    let component =
        speech_component(preference_id).ok_or(ComponentManagerError::UnknownSpeechModel)?;
    match consent {
        DownloadConsent::User => Ok(component),
        DownloadConsent::AutomaticDefault
            if component.component_id == DEFAULT_SPEECH_COMPONENT_ID =>
        {
            Ok(component)
        }
        DownloadConsent::AutomaticDefault | DownloadConsent::Declined => {
            Err(ComponentManagerError::ConsentRequired)
        }
    }
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
    let reason = match error {
        ComponentAcquisitionError::ConsentRequired => {
            return ComponentManagerError::ConsentRequired;
        }
        ComponentAcquisitionError::Cancelled => return ComponentManagerError::Cancelled,
        ComponentAcquisitionError::NotEnoughSpace => {
            return ComponentManagerError::CapacityHeld(ComponentCapacityReason::DiskSpace);
        }
        ComponentAcquisitionError::Install(ComponentStoreError::InUse) => {
            return ComponentManagerError::InUse;
        }
        ComponentAcquisitionError::Install(_) | ComponentAcquisitionError::Storage(_) => {
            return ComponentManagerError::StorageUnavailable;
        }
        ComponentAcquisitionError::Manifest(reason) => {
            ComponentAcquisitionFailure::Manifest(reason)
        }
        ComponentAcquisitionError::WrongTarget => ComponentAcquisitionFailure::WrongTarget,
        ComponentAcquisitionError::InvalidResponse => ComponentAcquisitionFailure::InvalidResponse,
        ComponentAcquisitionError::Server(status) => ComponentAcquisitionFailure::Server(status),
        ComponentAcquisitionError::Network => ComponentAcquisitionFailure::Network,
        ComponentAcquisitionError::ChecksumMismatch => {
            ComponentAcquisitionFailure::ChecksumMismatch
        }
        ComponentAcquisitionError::UnsafeStaging => ComponentAcquisitionFailure::UnsafeStaging,
    };
    let (stage, cause, http_status) = reason.diagnostic();
    tracing::warn!(
        event = "kalvoice.component_acquisition_failed",
        stage,
        cause,
        http_status,
    );
    ComponentManagerError::AcquisitionFailed(reason)
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

fn runtime_component_root(
    data_dir: &Path,
) -> Result<TrustedComponentDirectory, ComponentManagerError> {
    TrustedComponentDirectory::initialize_private_app_data(data_dir)
        .map_err(|_| ComponentManagerError::StorageUnavailable)
}

#[cfg(test)]
fn private_fixture_directory() -> std::io::Result<tempfile::TempDir> {
    let temp = tempfile::tempdir()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        // tempfile follows the process umask; trusted component roots require owner-only access.
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700))?;
    }
    Ok(temp)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn ordinary_macos_app_data_initializes_private_component_storage() {
        use std::os::unix::fs::PermissionsExt as _;

        let temp = tempfile::tempdir().unwrap();
        let data_dir = temp.path().join("com.kalcode.desktop");
        // Reproduce ordinary macOS startup permissions even if the test runner has a
        // restrictive umask. Never pre-tighten this fixture through the private helper.
        fs::create_dir(&data_dir).unwrap();
        fs::set_permissions(&data_dir, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            fs::metadata(&data_dir).unwrap().permissions().mode() & 0o777,
            0o755
        );
        fs::write(data_dir.join("existing-state"), b"preserved").unwrap();

        let root = runtime_component_root(&data_dir).expect("normal macOS app-data initializes");
        assert_eq!(root.path(), fs::canonicalize(&data_dir).unwrap());
        assert_eq!(
            fs::metadata(root.path()).unwrap().permissions().mode() & 0o777,
            0o700
        );
        for name in [
            "components",
            "component-acquisition",
            "catalog-cache",
            "catalog-floor-locks",
        ] {
            let child = root.create_private_child(name).unwrap();
            assert_eq!(child.path(), root.path().join(name));
            assert_eq!(
                fs::metadata(child.path()).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        assert_eq!(
            fs::read(data_dir.join("existing-state")).unwrap(),
            b"preserved"
        );
        runtime_component_root(&data_dir).expect("restart reopens the same private root");
    }

    #[test]
    fn capacity_rejection_reports_an_ended_attempt_with_retry_not_a_wait_queue() {
        let error = ComponentManagerError::ResourceUnavailable;
        assert_eq!(error.code(), "resource_capacity_unavailable");
        let message = error.to_string();
        assert!(message.contains("download attempt ended"), "{message}");
        assert!(message.contains("retry"), "{message}");
        assert!(!message.contains("waiting"), "{message}");
    }

    #[test]
    fn acquisition_disk_space_failure_keeps_its_known_cause() {
        let error = map_acquisition_error(ComponentAcquisitionError::NotEnoughSpace);
        assert_eq!(
            error,
            ComponentManagerError::CapacityHeld(ComponentCapacityReason::DiskSpace)
        );
        assert_eq!(error.code(), "resource_capacity_unavailable");
        assert!(error.to_string().contains("disk space"));
        assert!(error.to_string().contains("download attempt ended"));
    }

    fn denied(reason: AdmissionReason) -> AdmissionDecision {
        AdmissionDecision {
            state: kalcode_resources::AdmissionState::Held,
            mode: Some(kalcode_resources::ModeKind::Balanced),
            additional: 0,
            reasons: vec![reason],
            snapshot_seq: Some(1),
            sampled_at_unix_ms: Some(1),
        }
    }

    #[test]
    fn real_pressure_denials_keep_memory_cpu_and_disk_reasons_without_private_details() {
        use kalcode_resources::{ModeKind, PressureLevel, Signal};
        for (resource, signal, expected, text) in [
            (
                ResourceKind::Memory,
                Signal::MemoryUsedPercent,
                ComponentCapacityReason::Memory,
                "memory headroom",
            ),
            (
                ResourceKind::Cpu,
                Signal::CpuPercent,
                ComponentCapacityReason::Cpu,
                "CPU headroom",
            ),
            (
                ResourceKind::DiskSpace,
                Signal::DiskFreeMb {
                    mount: "private-volume-path".into(),
                },
                ComponentCapacityReason::DiskSpace,
                "disk space",
            ),
        ] {
            for level in [PressureLevel::High, PressureLevel::Critical] {
                let error = acquisition_capacity_error(denied(AdmissionReason::Capacity {
                    holds: vec![HoldReason::Pressure {
                        resource,
                        level,
                        mode: ModeKind::Balanced,
                        signal: signal.clone(),
                        value: 91.8,
                        threshold: Some(88.0),
                    }],
                }));
                assert_eq!(error, ComponentManagerError::CapacityHeld(expected));
                assert_eq!(error.code(), "resource_capacity_unavailable");
                let message = error.to_string();
                assert!(message.contains(text), "{message}");
                assert!(message.contains("download attempt ended"), "{message}");
                assert!(message.contains("retry"), "{message}");
                assert!(!message.contains("private-volume-path"));
                assert!(!message.contains("waiting"));
            }
        }
    }

    #[test]
    fn stale_and_missing_telemetry_are_not_misreported_as_memory_pressure() {
        let stale = acquisition_capacity_error(denied(AdmissionReason::SnapshotStale {
            age_ms: 90_000,
            max_age_ms: 15_000,
        }));
        assert_eq!(
            stale,
            ComponentManagerError::CapacityHeld(ComponentCapacityReason::StaleTelemetry)
        );
        assert!(stale.to_string().contains("out of date"));
        for resource in [
            ResourceKind::Cpu,
            ResourceKind::Memory,
            ResourceKind::DiskSpace,
        ] {
            for reason in [
                AdmissionReason::RequiredTelemetryUnknown {
                    resource,
                    detail: "private-probe-detail".into(),
                },
                AdmissionReason::RequiredTelemetryUnavailable {
                    resource,
                    detail: "private-probe-detail".into(),
                },
            ] {
                let error = acquisition_capacity_error(denied(reason));
                assert_eq!(
                    error,
                    ComponentManagerError::CapacityHeld(
                        ComponentCapacityReason::TelemetryUnavailable(resource)
                    )
                );
                assert!(error.to_string().contains("could not verify"));
                assert!(!error.to_string().contains("private-probe-detail"));
                assert!(!error.to_string().contains("has reached"));
            }
        }
        let unavailable = acquisition_capacity_error(denied(AdmissionReason::GovernorNotReady {
            status: kalcode_resources::GovernorStatus::Failed {
                reason: "private-sampler-detail".into(),
            },
        }));
        assert_eq!(
            unavailable,
            ComponentManagerError::CapacityHeld(ComponentCapacityReason::SamplerUnavailable)
        );
        assert!(!unavailable.to_string().contains("private-sampler-detail"));
        assert_eq!(
            acquisition_capacity_error(denied(AdmissionReason::CapacityUnavailable)),
            ComponentManagerError::ResourceUnavailable
        );
    }

    #[test]
    fn projected_budget_and_concurrency_denials_retain_their_actual_category() {
        use kalcode_resources::ModeKind;
        for (hold, expected) in [
            (
                HoldReason::CpuHeadroom {
                    cpu_percent: 74.0,
                    target_percent: 75.0,
                    per_agent_percent: 2.0,
                    mode: ModeKind::Balanced,
                },
                ComponentCapacityReason::Cpu,
            ),
            (
                HoldReason::MemoryHeadroom {
                    available_mb: 2100,
                    reserve_mb: 2048,
                    per_agent_mb: 96,
                    mode: ModeKind::Balanced,
                },
                ComponentCapacityReason::Memory,
            ),
            (
                HoldReason::KalCodeMemoryCap {
                    used_mb: 2000,
                    cap_mb: 2048,
                    per_agent_mb: 96,
                    mode: ModeKind::Balanced,
                },
                ComponentCapacityReason::KalCodeMemory,
            ),
            (
                HoldReason::UserLimit {
                    running: 4,
                    limit: 4,
                    mode: ModeKind::Balanced,
                },
                ComponentCapacityReason::WorkloadLimit,
            ),
        ] {
            let error =
                acquisition_capacity_error(denied(AdmissionReason::Capacity { holds: vec![hold] }));
            assert_eq!(error, ComponentManagerError::CapacityHeld(expected));
            if expected == ComponentCapacityReason::KalCodeMemory {
                let message = error.to_string();
                assert!(message.contains("not enough memory headroom"), "{message}");
                assert!(!message.contains("has reached"), "{message}");
            }
        }
    }

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
        let temp = private_fixture_directory().unwrap();
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
            authorize_download("tiny.en", DownloadConsent::from_user(false)),
            Err(ComponentManagerError::ConsentRequired)
        );
        assert_eq!(
            authorize_download("not-a-model", DownloadConsent::User),
            Err(ComponentManagerError::UnknownSpeechModel)
        );
        assert_eq!(
            authorize_download("tiny.en", DownloadConsent::from_user(true))
                .expect("authorized")
                .component_id,
            DEFAULT_SPEECH_COMPONENT_ID
        );
    }

    #[test]
    fn system_granted_consent_covers_only_the_default_speech_model() {
        assert_eq!(models::DEFAULT_MODEL, "tiny.en");
        assert_eq!(
            authorize_download("tiny.en", DownloadConsent::AutomaticDefault)
                .expect("the default model is provisioned automatically")
                .component_id,
            DEFAULT_SPEECH_COMPONENT_ID
        );
        for other in ["base.en", "small.en", "base", "small"] {
            assert_eq!(
                authorize_download(other, DownloadConsent::AutomaticDefault),
                Err(ComponentManagerError::ConsentRequired),
                "{other} must keep its download dialog"
            );
            assert!(authorize_download(other, DownloadConsent::User).is_ok());
        }
        assert_eq!(
            DownloadConsent::AutomaticDefault.code(),
            "automatic_default"
        );
        assert_eq!(DownloadConsent::User.code(), "user");
    }

    #[test]
    fn a_governor_hold_ends_after_its_bound_with_the_old_ended_attempt_copy() {
        // The waiting download's final error keeps the truthful "attempt ended" wording.
        let error = ComponentManagerError::CapacityHeld(ComponentCapacityReason::Memory);
        assert_eq!(ComponentCapacityReason::Memory.code(), "memory");
        assert_eq!(ComponentCapacityReason::DiskSpace.code(), "disk_space");
        assert!(error.to_string().contains("download attempt ended"));
    }

    #[test]
    fn catalog_cache_is_hash_addressed_and_read_back_exactly() {
        let temp = private_fixture_directory().unwrap();
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
