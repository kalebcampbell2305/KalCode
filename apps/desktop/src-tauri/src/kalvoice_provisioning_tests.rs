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

#[derive(Default)]
struct MemorySecrets(Mutex<HashMap<SecretKey, SecretString>>);
impl SecretStore for MemorySecrets {
    fn backend(&self) -> &'static str {
        "synthetic component floor"
    }
    fn get(&self, key: &SecretKey) -> Result<Option<SecretString>, SecretStoreError> {
        Ok(self.0.lock().unwrap().get(key).cloned())
    }
    fn set(&self, key: &SecretKey, value: &SecretString) -> Result<(), SecretStoreError> {
        self.0.lock().unwrap().insert(key.clone(), value.clone());
        Ok(())
    }
    fn delete(&self, key: &SecretKey) -> Result<bool, SecretStoreError> {
        Ok(self.0.lock().unwrap().remove(key).is_some())
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
        self.tokens.lock().unwrap().push(token.into());
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
fn sign(value: &impl serde::Serialize, key: &SigningKey, token_type: &str) -> String {
    let header = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(
            &serde_json::json!({"alg":"EdDSA", "typ":token_type, "kid":"synthetic-test"}),
        )
        .unwrap(),
    );
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(value).unwrap());
    let input = format!("{header}.{payload}");
    format!(
        "{input}.{}",
        URL_SAFE_NO_PAD.encode(key.sign(input.as_bytes()).to_bytes())
    )
}
fn token(key: &SigningKey, now: i64) -> String {
    let host = host_local_reasoning_contract().unwrap();
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
            ),
        },
        CatalogEntry {
            role: CatalogRole::ReasoningModel,
            token: make(
                LOCAL_REASONING_MODEL_ID,
                ComponentKind::Model,
                LOCAL_REASONING_RUNTIME_ABI,
            ),
        },
    ];
    entries.extend(SPEECH_COMPONENT_IDS.iter().map(|id| CatalogEntry {
        role: CatalogRole::SpeechModel,
        token: make(id, ComponentKind::Model, WHISPER_GGML_ABI),
    }));
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

pub(crate) fn empty_manager() -> (tempfile::TempDir, Arc<KalVoiceComponentManager>) {
    let (temp, manager, _, _) = fixture();
    (temp, manager)
}
fn fixture() -> (
    tempfile::TempDir,
    Arc<KalVoiceComponentManager>,
    Arc<AcquisitionSpy>,
    Arc<AtomicUsize>,
) {
    let temp = tempfile::tempdir().unwrap();
    let root = TrustedComponentDirectory::open_existing(temp.path()).unwrap();
    let key = SigningKey::from_bytes(&[71; 32]);
    let public_key = URL_SAFE_NO_PAD.encode(key.verifying_key().as_bytes());
    let verifier =
        ComponentVerifier::from_keys([("synthetic-test", public_key.as_str())], ["kalcoded.com"])
            .unwrap();
    let host = host_local_reasoning_contract().unwrap();
    let track = CatalogFloorTrack::new("stable", host.runtime.platform, host.runtime.arch).unwrap();
    let floor = Arc::new(
        ComponentFloorAuthority::new(Arc::new(MemorySecrets::default()), root.clone(), track)
            .unwrap(),
    );
    let mut manager = KalVoiceComponentManager::new(ComponentManagerConfig {
        root,
        verifier,
        floor,
        resources: Arc::new(ResourceGovernorState::start()),
        channel: "stable",
        platform: host.runtime.platform,
        arch: host.runtime.arch,
    })
    .unwrap();
    let acquisition = Arc::new(AcquisitionSpy::default());
    let reservations = Arc::new(AtomicUsize::new(0));
    let inner = Arc::get_mut(&mut manager).unwrap();
    inner.fetcher = Arc::new(FakeFetcher(token(&key, unix_seconds())));
    inner.acquisition = acquisition.clone();
    inner.admission = Arc::new(AdmissionSpy(reservations.clone()));
    (temp, manager, acquisition, reservations)
}

#[test]
fn reasoning_quote_only_fetches_signed_metadata_and_exact_consent_precedes_acquisition() {
    let (_temp, manager, acquisition, reservations) = fixture();
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

#[test]
fn cancelled_runtime_download_cannot_start_reasoning_model_and_releases_reservation() {
    let (_temp, manager, acquisition, reservations) = fixture();
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
    let (_temp, manager, acquisition, reservations) = fixture();
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
    let (_temp, mut manager, acquisition, _) = fixture();
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
