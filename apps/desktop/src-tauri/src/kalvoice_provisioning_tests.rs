//! Synthetic signed catalog + in-memory credential/acquisition seams. No OS credentials,
//! downloads, provider accounts or executable workers are touched by these tests.
use super::*;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signer, SigningKey};
use kalcode_kalvoice::component_catalog::{CATALOG_TOKEN_TYPE, CatalogEntry, ComponentCatalog};
use kalcode_kalvoice::component_manifest::{
    ComponentLicense, ComponentManifest, ComponentProvenance, TOKEN_TYPE,
};
use kalcode_secure_store::{SecretKey, SecretStoreError, SecretString};
use std::sync::atomic::AtomicUsize;

type FixtureResult<T> = Result<T, Box<dyn std::error::Error>>;

fn assert_safe_acquisition_message(error: ComponentAcquisitionError, expected: &str) {
    let mapped = map_acquisition_error(error);
    assert_eq!(mapped.code(), "component_acquisition_failed");
    let message = mapped.to_string();
    assert!(message.contains(expected), "missing {expected}: {message}");
    assert!(message.len() < 240);
    for sensitive in ["https://", "C:\\", "Bearer", "token=", "signature="] {
        assert!(
            !message.contains(sensitive),
            "message must not expose transport inputs"
        );
    }
}

macro_rules! acquisition_message_test {
    ($name:ident, $error:expr, $expected:literal) => {
        #[test]
        fn $name() {
            assert_safe_acquisition_message($error, $expected);
        }
    };
}

acquisition_message_test!(
    acquisition_signature_failure_is_specific,
    ComponentAcquisitionError::Manifest(
        kalcode_kalvoice::component_manifest::VerifyError::BadSignature
    ),
    "signature"
);
acquisition_message_test!(
    acquisition_expired_manifest_is_specific,
    ComponentAcquisitionError::Manifest(kalcode_kalvoice::component_manifest::VerifyError::Expired),
    "expired"
);
acquisition_message_test!(
    acquisition_not_yet_valid_manifest_is_specific,
    ComponentAcquisitionError::Manifest(
        kalcode_kalvoice::component_manifest::VerifyError::NotYetValid
    ),
    "not valid yet"
);
acquisition_message_test!(
    acquisition_wrong_target_is_specific,
    ComponentAcquisitionError::WrongTarget,
    "operating system"
);
acquisition_message_test!(
    acquisition_invalid_response_is_specific,
    ComponentAcquisitionError::InvalidResponse,
    "invalid download response"
);
acquisition_message_test!(
    acquisition_http_status_is_specific,
    ComponentAcquisitionError::Server(503),
    "503"
);
acquisition_message_test!(
    acquisition_connection_failure_is_specific,
    ComponentAcquisitionError::Network,
    "connection"
);
acquisition_message_test!(
    acquisition_checksum_failure_is_specific,
    ComponentAcquisitionError::ChecksumMismatch,
    "integrity"
);
acquisition_message_test!(
    acquisition_unsafe_staging_is_specific,
    ComponentAcquisitionError::UnsafeStaging,
    "download storage"
);

#[test]
fn acquisition_storage_and_control_failures_keep_their_existing_classification() {
    let cases = [
        (
            ComponentAcquisitionError::ConsentRequired,
            "consent_required",
        ),
        (ComponentAcquisitionError::Cancelled, "download_cancelled"),
        (
            ComponentAcquisitionError::NotEnoughSpace,
            "resource_capacity_unavailable",
        ),
        (
            ComponentAcquisitionError::Install(ComponentStoreError::InUse),
            "component_in_use",
        ),
        (
            ComponentAcquisitionError::Install(ComponentStoreError::UnsafeArchive),
            "component_storage_failed",
        ),
        (
            ComponentAcquisitionError::Storage(io::ErrorKind::PermissionDenied),
            "component_storage_failed",
        ),
    ];
    for (error, expected_code) in cases {
        assert_eq!(map_acquisition_error(error).code(), expected_code);
    }
}

#[test]
fn acquisition_diagnostics_preserve_typed_manifest_causes_and_numeric_http_status() {
    for cause in [
        VerifyError::Malformed,
        VerifyError::UnsupportedHeader,
        VerifyError::UnknownKey,
        VerifyError::BadSignature,
        VerifyError::InvalidDocument,
        VerifyError::InvalidUrl,
        VerifyError::NotYetValid,
        VerifyError::Expired,
    ] {
        let mapped = map_acquisition_error(ComponentAcquisitionError::Manifest(cause));
        let ComponentManagerError::AcquisitionFailed(reason) = mapped else {
            panic!("typed manifest cause was lost");
        };
        assert_eq!(reason, ComponentAcquisitionFailure::Manifest(cause));
        assert_eq!(
            reason.diagnostic(),
            ("manifest_validation", cause.code(), None)
        );
    }
    for status in [0, 403, 404, 429, 500, 503, u16::MAX] {
        let ComponentManagerError::AcquisitionFailed(reason) =
            map_acquisition_error(ComponentAcquisitionError::Server(status))
        else {
            panic!("HTTP status was lost");
        };
        assert_eq!(
            reason.diagnostic(),
            ("download", "http_status", Some(status))
        );
        assert!(reason.to_string().contains(&status.to_string()));
    }
}

#[test]
fn acquisition_diagnostic_fields_have_only_allowlisted_stage_and_cause_values() {
    let cases = [
        (
            ComponentAcquisitionError::WrongTarget,
            "target_validation",
            "wrong_target",
        ),
        (
            ComponentAcquisitionError::InvalidResponse,
            "download",
            "invalid_response",
        ),
        (ComponentAcquisitionError::Network, "download", "network"),
        (
            ComponentAcquisitionError::ChecksumMismatch,
            "integrity_validation",
            "checksum_mismatch",
        ),
        (
            ComponentAcquisitionError::UnsafeStaging,
            "download_staging",
            "unsafe_staging",
        ),
    ];
    for (error, expected_stage, expected_cause) in cases {
        let ComponentManagerError::AcquisitionFailed(reason) = map_acquisition_error(error) else {
            panic!("acquisition cause was lost");
        };
        assert_eq!(reason.diagnostic(), (expected_stage, expected_cause, None));
    }
}

#[derive(Default)]
struct MemorySecrets(Mutex<HashMap<SecretKey, SecretString>>);
impl SecretStore for MemorySecrets {
    fn backend(&self) -> &'static str {
        "synthetic component floor"
    }
    fn get(&self, key: &SecretKey) -> Result<Option<SecretString>, SecretStoreError> {
        Ok(self
            .0
            .lock()
            .map_err(|_| SecretStoreError::Unavailable("synthetic lock poisoned".into()))?
            .get(key)
            .cloned())
    }
    fn set(&self, key: &SecretKey, value: &SecretString) -> Result<(), SecretStoreError> {
        self.0
            .lock()
            .map_err(|_| SecretStoreError::Unavailable("synthetic lock poisoned".into()))?
            .insert(key.clone(), value.clone());
        Ok(())
    }
    fn delete(&self, key: &SecretKey) -> Result<bool, SecretStoreError> {
        Ok(self
            .0
            .lock()
            .map_err(|_| SecretStoreError::Unavailable("synthetic lock poisoned".into()))?
            .remove(key)
            .is_some())
    }
}
struct FakeFetcher(String);
impl CatalogFetcher for FakeFetcher {
    fn fetch(&self, _: &str, _: &AtomicBool) -> Result<String, ComponentManagerError> {
        Ok(self.0.clone())
    }
}
#[derive(Default)]
struct AcquisitionSpy {
    tokens: Mutex<Vec<String>>,
    cancel_first: AtomicBool,
}
impl AcquisitionService for AcquisitionSpy {
    fn acquire(
        &self,
        token: &str,
        _: i64,
        consent: bool,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64, u64),
    ) -> Result<(), ComponentAcquisitionError> {
        assert!(consent);
        if cancel.load(Ordering::SeqCst) {
            return Err(ComponentAcquisitionError::Cancelled);
        }
        self.tokens
            .lock()
            .map_err(|_| ComponentAcquisitionError::Storage(std::io::ErrorKind::Other))?
            .push(token.into());
        progress(1024, 1024);
        if self.cancel_first.load(Ordering::SeqCst) {
            cancel.store(true, Ordering::SeqCst);
        }
        Ok(())
    }
}
struct Permit(Arc<AtomicUsize>);
impl Drop for Permit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}
impl HeldReservation for Permit {}
struct AdmissionSpy(Arc<AtomicUsize>);
impl ComponentAdmission for AdmissionSpy {
    fn reserve_acquisition(
        &self,
        bytes: u64,
    ) -> Result<Box<dyn HeldReservation>, ComponentManagerError> {
        assert_eq!(bytes, 2048);
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(Box::new(Permit(self.0.clone())))
    }
}
fn sign(
    value: &impl serde::Serialize,
    key: &SigningKey,
    token_type: &str,
) -> FixtureResult<String> {
    let header = URL_SAFE_NO_PAD.encode(serde_json::to_vec(
        &serde_json::json!({"alg":"EdDSA", "typ":token_type, "kid":"synthetic-test"}),
    )?);
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(value)?);
    let input = format!("{header}.{payload}");
    Ok(format!(
        "{input}.{}",
        URL_SAFE_NO_PAD.encode(key.sign(input.as_bytes()).to_bytes())
    ))
}
fn token(key: &SigningKey, now: i64) -> FixtureResult<String> {
    let host = host_local_reasoning_contract()
        .ok_or_else(|| std::io::Error::other("unsupported synthetic fixture host"))?;
    let make = |id: &str, kind, abi: &str| {
        sign(
            &ComponentManifest {
                schema_version: 1,
                component_id: id.into(),
                kind,
                version: "2026.09.1".into(),
                sequence: 1,
                platform: host.runtime.platform,
                arch: host.runtime.arch,
                runtime_abi: abi.into(),
                size_bytes: 1024,
                sha256: "aa".repeat(32),
                artifact_url: format!(
                    "https://kalcoded.com/components/v1/{}/{id}/2026.09.1/{}/artifact.bin",
                    if kind == ComponentKind::Runtime {
                        "runtime"
                    } else {
                        "model"
                    },
                    "aa".repeat(32)
                ),
                licenses: vec![ComponentLicense {
                    spdx_id: "MIT".into(),
                    notice_sha256: "bb".repeat(32),
                }],
                provenance: ComponentProvenance {
                    source_id: "synthetic/test".into(),
                    source_revision: "test-1".into(),
                    source_integrity_sha256: "cc".repeat(32),
                    build_recipe_sha256: "dd".repeat(32),
                },
                issued_at: now - 30,
                expires_at: now + 3600,
                key_id: "synthetic-test".into(),
            },
            key,
            TOKEN_TYPE,
        )
    };
    let mut entries = vec![
        CatalogEntry {
            role: CatalogRole::ReasoningRuntime,
            token: make(
                LOCAL_REASONING_RUNTIME_ID,
                ComponentKind::Runtime,
                LOCAL_REASONING_RUNTIME_ABI,
            )?,
        },
        CatalogEntry {
            role: CatalogRole::ReasoningModel,
            token: make(
                LOCAL_REASONING_MODEL_ID,
                ComponentKind::Model,
                LOCAL_REASONING_RUNTIME_ABI,
            )?,
        },
    ];
    for id in SPEECH_COMPONENT_IDS {
        entries.push(CatalogEntry {
            role: CatalogRole::SpeechModel,
            token: make(id, ComponentKind::Model, WHISPER_GGML_ABI)?,
        });
    }
    sign(
        &ComponentCatalog {
            schema_version: 1,
            channel: "stable".into(),
            sequence: 1,
            platform: host.runtime.platform,
            arch: host.runtime.arch,
            reasoning_abi: LOCAL_REASONING_RUNTIME_ABI.into(),
            speech_model_abi: WHISPER_GGML_ABI.into(),
            default_speech_component_id: DEFAULT_SPEECH_COMPONENT_ID.into(),
            entries,
            issued_at: now - 30,
            expires_at: now + 1800,
            key_id: "synthetic-test".into(),
        },
        key,
        CATALOG_TOKEN_TYPE,
    )
}

pub(crate) fn empty_manager() -> FixtureResult<(tempfile::TempDir, Arc<KalVoiceComponentManager>)> {
    let (temp, manager, _, _) = fixture()?;
    Ok((temp, manager))
}
type ProvisioningFixture = (
    tempfile::TempDir,
    Arc<KalVoiceComponentManager>,
    Arc<AcquisitionSpy>,
    Arc<AtomicUsize>,
);

fn fixture() -> FixtureResult<ProvisioningFixture> {
    let temp = private_fixture_directory()?;
    let root = TrustedComponentDirectory::open_existing(temp.path())?;
    let key = SigningKey::from_bytes(&[71; 32]);
    let public_key = URL_SAFE_NO_PAD.encode(key.verifying_key().as_bytes());
    let verifier =
        ComponentVerifier::from_keys([("synthetic-test", public_key.as_str())], ["kalcoded.com"])?;
    let host = host_local_reasoning_contract()
        .ok_or_else(|| std::io::Error::other("unsupported synthetic fixture host"))?;
    let track = CatalogFloorTrack::new("stable", host.runtime.platform, host.runtime.arch)?;
    let floor = Arc::new(ComponentFloorAuthority::new(
        Arc::new(MemorySecrets::default()),
        root.clone(),
        track,
    )?);
    let mut manager = KalVoiceComponentManager::new(ComponentManagerConfig {
        root,
        verifier,
        floor,
        resources: Arc::new(ResourceGovernorState::start()),
        channel: "stable",
        platform: host.runtime.platform,
        arch: host.runtime.arch,
    })?;
    let acquisition = Arc::new(AcquisitionSpy::default());
    let reservations = Arc::new(AtomicUsize::new(0));
    let inner = Arc::get_mut(&mut manager)
        .ok_or_else(|| std::io::Error::other("fixture unexpectedly shared"))?;
    inner.fetcher = Arc::new(FakeFetcher(token(&key, unix_seconds())?));
    inner.acquisition = acquisition.clone();
    inner.admission = Arc::new(AdmissionSpy(reservations.clone()));
    Ok((temp, manager, acquisition, reservations))
}

#[test]
fn reasoning_quote_only_fetches_signed_metadata_and_exact_consent_precedes_acquisition() {
    let (_temp, manager, acquisition, reservations) = fixture().unwrap();
    let quote = manager.prepare_reasoning().unwrap();
    assert_eq!(quote.size_bytes, 2048);
    assert_eq!(quote.runtime_version, "2026.09.1");
    assert!(acquisition.tokens.lock().unwrap().is_empty());
    assert!(
        manager
            .floor
            .load(Instant::now() + FLOOR_TIMEOUT, &AtomicBool::new(false))
            .unwrap()
            .is_none()
    );
    for (consent, identity) in [
        (false, Some(quote.catalog_identity.as_str())),
        (true, None),
        (true, Some("wrong-catalog")),
    ] {
        assert_eq!(
            manager.download_reasoning(consent, identity, |_, _| {}),
            Err(ComponentManagerError::ConsentRequired)
        );
    }
    assert!(acquisition.tokens.lock().unwrap().is_empty());
    manager
        .download_reasoning(true, Some(&quote.catalog_identity), |_, _| {
            assert_eq!(reservations.load(Ordering::SeqCst), 1);
        })
        .unwrap();
    let tokens = acquisition.tokens.lock().unwrap();
    assert_eq!(tokens.len(), 2);
    for (token, expected_id) in tokens
        .iter()
        .zip([LOCAL_REASONING_RUNTIME_ID, LOCAL_REASONING_MODEL_ID])
    {
        assert_eq!(
            manager
                .verifier
                .verify(token, unix_seconds())
                .unwrap()
                .manifest()
                .component_id,
            expected_id
        );
    }
    assert_eq!(reservations.load(Ordering::SeqCst), 0);
    assert!(
        !manager.reasoning_installed(),
        "a mock acquisition must not report real installation"
    );
    assert!(manager.acquire_reasoning().is_err());
}

struct DeniedAdmission;
impl ComponentAdmission for DeniedAdmission {
    fn reserve_acquisition(
        &self,
        _: u64,
    ) -> Result<Box<dyn HeldReservation>, ComponentManagerError> {
        Err(acquisition_capacity_error(AdmissionDecision {
            state: kalcode_resources::AdmissionState::Held,
            mode: Some(kalcode_resources::ModeKind::Balanced),
            additional: 0,
            reasons: vec![AdmissionReason::RequiredTelemetryUnavailable {
                resource: ResourceKind::DiskSpace,
                detail: "private-data-volume-path".into(),
            }],
            snapshot_seq: Some(1),
            sampled_at_unix_ms: Some(1),
        }))
    }
}

#[test]
fn held_download_keeps_specific_reason_starts_no_acquisition_and_can_be_retried() {
    let (_temp, mut manager, acquisition, reservations) = fixture().unwrap();
    Arc::get_mut(&mut manager).unwrap().admission = Arc::new(DeniedAdmission);
    let quote = manager.prepare_reasoning().unwrap();
    let speech_error = manager
        .download_speech("tiny.en", true, |_, _| {
            panic!("held speech download reported progress")
        })
        .unwrap_err();
    assert_eq!(
        speech_error,
        ComponentManagerError::CapacityHeld(ComponentCapacityReason::TelemetryUnavailable(
            ResourceKind::DiskSpace
        ))
    );
    assert!(manager.downloads.lock().unwrap().running.is_empty());
    assert!(acquisition.tokens.lock().unwrap().is_empty());
    let error = manager
        .download_reasoning(true, Some(&quote.catalog_identity), |_, _| {
            panic!("held download reported progress")
        })
        .unwrap_err();
    assert_eq!(
        error,
        ComponentManagerError::CapacityHeld(ComponentCapacityReason::TelemetryUnavailable(
            ResourceKind::DiskSpace
        ))
    );
    assert_eq!(error.code(), "resource_capacity_unavailable");
    assert!(
        error
            .to_string()
            .contains("could not verify available disk space")
    );
    assert!(!error.to_string().contains("private-data-volume-path"));
    assert!(acquisition.tokens.lock().unwrap().is_empty());
    assert!(manager.downloads.lock().unwrap().running.is_empty());
    assert_eq!(reservations.load(Ordering::SeqCst), 0);
    assert!(
        manager.cache.read(&quote.catalog_identity).is_err(),
        "held download must not retain a catalog or advance its floor"
    );

    Arc::get_mut(&mut manager).unwrap().admission = Arc::new(AdmissionSpy(reservations.clone()));
    manager
        .download_reasoning(true, Some(&quote.catalog_identity), |_, _| {})
        .unwrap();
    assert_eq!(acquisition.tokens.lock().unwrap().len(), 2);
    assert!(manager.downloads.lock().unwrap().running.is_empty());
    assert_eq!(reservations.load(Ordering::SeqCst), 0);
}

#[test]
fn cancelled_runtime_download_cannot_start_reasoning_model_and_releases_reservation() {
    let (_temp, manager, acquisition, reservations) = fixture().unwrap();
    let quote = manager.prepare_reasoning().unwrap();
    acquisition.cancel_first.store(true, Ordering::SeqCst);
    assert_eq!(
        manager.download_reasoning(true, Some(&quote.catalog_identity), |_, _| {}),
        Err(ComponentManagerError::Cancelled)
    );
    assert_eq!(acquisition.tokens.lock().unwrap().len(), 1);
    assert_eq!(reservations.load(Ordering::SeqCst), 0);
    assert!(!manager.cancel(REASONING_DOWNLOAD_ID));
}

#[test]
fn shutdown_seals_downloads_before_a_queued_background_task_can_register() {
    let (_temp, manager, acquisition, reservations) = fixture().unwrap();
    let quote = manager.prepare_reasoning().unwrap();
    manager.cancel_all();
    assert_eq!(
        manager.download_reasoning(true, Some(&quote.catalog_identity), |_, _| {}),
        Err(ComponentManagerError::Cancelled)
    );
    assert_eq!(
        manager.download_speech("tiny.en", true, |_, _| {}),
        Err(ComponentManagerError::Cancelled)
    );
    assert!(acquisition.tokens.lock().unwrap().is_empty());
    assert_eq!(reservations.load(Ordering::SeqCst), 0);
    assert!(manager.cancel_all_and_wait(Duration::ZERO));
}

#[test]
fn invalid_signed_metadata_never_opens_a_download_or_advances_the_floor() {
    let (_temp, mut manager, acquisition, _) = fixture().unwrap();
    Arc::get_mut(&mut manager).unwrap().fetcher =
        Arc::new(FakeFetcher("invalid.signed.catalog".into()));
    assert_eq!(
        manager.prepare_reasoning(),
        Err(ComponentManagerError::CatalogInvalid)
    );
    assert!(acquisition.tokens.lock().unwrap().is_empty());
    assert!(
        manager
            .floor
            .load(Instant::now() + FLOOR_TIMEOUT, &AtomicBool::new(false))
            .unwrap()
            .is_none()
    );
}
