use std::collections::HashMap;
use std::fs;
use std::io;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Barrier, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signer, SigningKey};
use fs2::FileExt as _;
use kalcode_secure_store::{OsSecretStore, SecretKey, SecretStore, SecretStoreError, SecretString};
use serde::Serialize;

use super::component_catalog::{
    CATALOG_TOKEN_TYPE, CatalogContract, CatalogEntry, CatalogRole, ComponentCatalog,
    VerifiedComponentCatalog, WHISPER_GGML_ABI, verify_catalog,
};
use super::component_floor::{
    CatalogFloorTrack, ComponentFloorAuthority, ComponentFloorError, MarkerFailure,
};
use super::component_manifest::{
    ComponentArch, ComponentKind, ComponentLicense, ComponentManifest, ComponentPlatform,
    ComponentProvenance, ComponentVerifier, TrustedKey,
};
use super::component_store::TrustedComponentDirectory;

const NOW: i64 = 1_790_000_000;
const KEY_ID: &str = "floor-test-2026";
const RUNTIME_ID: &str = "kalvoice.runtime.llama-cpp";
const REASONING_ID: &str = "kalvoice.reasoner.qwen3-5-0-8b-q8";
const SPEECH_ID: &str = "kalvoice.speech.whisper.tiny-en";
const REASONING_ABI: &str = "kalvoice-llama-cpp.v1";

#[derive(Default)]
struct TestSecretStore {
    values: Mutex<HashMap<SecretKey, SecretString>>,
    sets: AtomicUsize,
    fail_get: AtomicBool,
    fail_set: AtomicBool,
}

impl TestSecretStore {
    fn raw(&self, key: &SecretKey) -> Option<SecretString> {
        self.values.lock().expect("values").get(key).cloned()
    }
}

impl SecretStore for TestSecretStore {
    fn backend(&self) -> &'static str {
        "catalog floor test store"
    }

    fn set(&self, key: &SecretKey, value: &SecretString) -> Result<(), SecretStoreError> {
        if self.fail_set.load(Ordering::SeqCst) {
            return Err(SecretStoreError::Access(
                "credential=must-not-cross-floor-boundary".into(),
            ));
        }
        self.sets.fetch_add(1, Ordering::SeqCst);
        self.values
            .lock()
            .map_err(|_| SecretStoreError::Access("poisoned".into()))?
            .insert(key.clone(), value.clone());
        Ok(())
    }

    fn get(&self, key: &SecretKey) -> Result<Option<SecretString>, SecretStoreError> {
        if self.fail_get.load(Ordering::SeqCst) {
            return Err(SecretStoreError::Access(
                "credential=must-not-cross-floor-boundary".into(),
            ));
        }
        Ok(self
            .values
            .lock()
            .map_err(|_| SecretStoreError::Access("poisoned".into()))?
            .get(key)
            .cloned())
    }

    fn delete(&self, key: &SecretKey) -> Result<bool, SecretStoreError> {
        Ok(self
            .values
            .lock()
            .map_err(|_| SecretStoreError::Access("poisoned".into()))?
            .remove(key)
            .is_some())
    }
}

#[derive(Default)]
struct MismatchStore {
    written: AtomicBool,
}

impl SecretStore for MismatchStore {
    fn backend(&self) -> &'static str {
        "mismatch test store"
    }

    fn set(&self, _key: &SecretKey, _value: &SecretString) -> Result<(), SecretStoreError> {
        self.written.store(true, Ordering::SeqCst);
        Ok(())
    }

    fn get(&self, _key: &SecretKey) -> Result<Option<SecretString>, SecretStoreError> {
        Ok(self
            .written
            .load(Ordering::SeqCst)
            .then(|| SecretString::new("{}")))
    }

    fn delete(&self, _key: &SecretKey) -> Result<bool, SecretStoreError> {
        Ok(false)
    }
}

fn signing_key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn sign<T: Serialize>(value: &T, key: &SigningKey, token_type: &str) -> String {
    let header = serde_json::json!({"alg":"EdDSA", "typ":token_type, "kid":KEY_ID});
    let header = b64(&serde_json::to_vec(&header).expect("header"));
    let payload = b64(&serde_json::to_vec(value).expect("payload"));
    let input = format!("{header}.{payload}");
    let signature = key.sign(input.as_bytes());
    format!("{input}.{}", b64(&signature.to_bytes()))
}

fn component_token(
    key: &SigningKey,
    id: &str,
    kind: ComponentKind,
    abi: &str,
    seed: u8,
    platform: ComponentPlatform,
    arch: ComponentArch,
) -> String {
    let digest = format!("{seed:02x}").repeat(32);
    let kind_segment = match kind {
        ComponentKind::Model => "model",
        ComponentKind::Runtime => "runtime",
    };
    sign(
        &ComponentManifest {
            schema_version: 1,
            component_id: id.into(),
            kind,
            version: "2026.09.1".into(),
            sequence: 1,
            platform,
            arch,
            runtime_abi: abi.into(),
            size_bytes: 1024 + u64::from(seed),
            sha256: digest.clone(),
            artifact_url: format!(
                "https://kalcoded.com/components/v1/{kind_segment}/{id}/2026.09.1/{digest}/artifact.bin"
            ),
            licenses: vec![ComponentLicense {
                spdx_id: "Apache-2.0".into(),
                notice_sha256: "aa".repeat(32),
            }],
            provenance: ComponentProvenance {
                source_id: "kalcode/floor-test".into(),
                source_revision: "revision-1".into(),
                source_integrity_sha256: "bb".repeat(32),
                build_recipe_sha256: "cc".repeat(32),
            },
            issued_at: NOW - 600,
            expires_at: NOW + 7_200,
            key_id: KEY_ID.into(),
        },
        key,
        super::component_manifest::TOKEN_TYPE,
    )
}

fn verified_catalog(sequence: u64) -> (String, VerifiedComponentCatalog) {
    verified_catalog_for(
        sequence,
        "stable",
        ComponentPlatform::Windows,
        ComponentArch::X86_64,
        73,
    )
}

fn verified_catalog_for(
    sequence: u64,
    channel: &str,
    platform: ComponentPlatform,
    arch: ComponentArch,
    signing_seed: u8,
) -> (String, VerifiedComponentCatalog) {
    let key = signing_key(signing_seed);
    let entries = vec![
        CatalogEntry {
            role: CatalogRole::ReasoningRuntime,
            token: component_token(
                &key,
                RUNTIME_ID,
                ComponentKind::Runtime,
                REASONING_ABI,
                1,
                platform,
                arch,
            ),
        },
        CatalogEntry {
            role: CatalogRole::ReasoningModel,
            token: component_token(
                &key,
                REASONING_ID,
                ComponentKind::Model,
                REASONING_ABI,
                2,
                platform,
                arch,
            ),
        },
        CatalogEntry {
            role: CatalogRole::SpeechModel,
            token: component_token(
                &key,
                SPEECH_ID,
                ComponentKind::Model,
                WHISPER_GGML_ABI,
                3,
                platform,
                arch,
            ),
        },
    ];
    let catalog = ComponentCatalog {
        schema_version: 1,
        channel: channel.into(),
        sequence,
        platform,
        arch,
        reasoning_abi: REASONING_ABI.into(),
        speech_model_abi: WHISPER_GGML_ABI.into(),
        default_speech_component_id: SPEECH_ID.into(),
        entries,
        issued_at: NOW - 300,
        expires_at: NOW + 3_600,
        key_id: KEY_ID.into(),
    };
    let token = sign(&catalog, &key, CATALOG_TOKEN_TYPE);
    let encoded = b64(key.verifying_key().as_bytes());
    let trusted = [TrustedKey {
        kid: KEY_ID,
        x: Box::leak(encoded.into_boxed_str()),
    }];
    let verifier =
        ComponentVerifier::from_trusted(&trusted, &["kalcoded.com"]).expect("component verifier");
    let contract = CatalogContract {
        channel,
        platform,
        arch,
        reasoning_runtime_id: RUNTIME_ID,
        reasoning_model_id: REASONING_ID,
        reasoning_abi: REASONING_ABI,
        speech_model_ids: &[SPEECH_ID],
        default_speech_model_id: SPEECH_ID,
        speech_model_abi: WHISPER_GGML_ABI,
    };
    let verified = verify_catalog(&verifier, &token, NOW, contract).expect("verified catalog");
    (token, verified)
}

fn trusted_root(temp: &tempfile::TempDir) -> TrustedComponentDirectory {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700)).expect("permissions");
    }
    TrustedComponentDirectory::open_existing(temp.path()).expect("trusted root")
}

fn track() -> CatalogFloorTrack {
    CatalogFloorTrack::new("stable", ComponentPlatform::Windows, ComponentArch::X86_64)
        .expect("track")
}

fn make_authority(
    temp: &tempfile::TempDir,
    store: Arc<dyn SecretStore>,
) -> ComponentFloorAuthority {
    ComponentFloorAuthority::new(store, trusted_root(temp), track()).expect("authority")
}

fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(2)
}

#[test]
fn activates_restarts_and_retains_only_the_exact_minimal_floor() {
    let temp = tempfile::tempdir().expect("tempdir");
    let store = Arc::new(TestSecretStore::default());
    let authority = make_authority(&temp, store.clone());
    let cancel = AtomicBool::new(false);
    assert_eq!(authority.load(deadline(), &cancel).expect("fresh"), None);

    let (token, catalog) = verified_catalog(2);
    let floor = authority
        .advance(&catalog, NOW, deadline(), &cancel)
        .expect("activate");
    assert_eq!(floor.sequence(), 2);
    assert_eq!(store.sets.load(Ordering::SeqCst), 1);

    let restarted = make_authority(&temp, store.clone());
    assert_eq!(
        restarted.load(deadline(), &cancel).expect("restart"),
        Some(floor.clone())
    );
    assert_eq!(
        restarted
            .advance(&catalog, NOW, deadline(), &cancel)
            .expect("exact replay"),
        floor
    );
    assert_eq!(store.sets.load(Ordering::SeqCst), 1);
    let raw = store.raw(restarted.credential_key()).expect("stored floor");
    assert!(!raw.expose_secret().contains(&token));
    assert!(!format!("{restarted:?}").contains(raw.expose_secret()));
}

#[test]
fn missing_after_activation_and_one_sided_authorities_fail_closed() {
    let temp = tempfile::tempdir().expect("tempdir");
    let store = Arc::new(TestSecretStore::default());
    let authority = make_authority(&temp, store.clone());
    let cancel = AtomicBool::new(false);
    let (_, catalog) = verified_catalog(1);
    authority
        .advance(&catalog, NOW, deadline(), &cancel)
        .expect("activate");
    store
        .delete(authority.credential_key())
        .expect("delete test credential");
    assert_eq!(
        authority.load(deadline(), &cancel),
        Err(ComponentFloorError::MissingAfterActivation)
    );

    // Marker present with the credential gone stays fail-closed on every restart; adoption
    // never applies in this direction.
    let restarted = make_authority(&temp, store.clone());
    assert_eq!(
        restarted.load(deadline(), &cancel),
        Err(ComponentFloorError::MissingAfterActivation)
    );
    assert!(matches!(
        restarted.advance(&catalog, NOW, deadline(), &cancel),
        Err(ComponentFloorError::MissingAfterActivation)
    ));
    assert!(store.raw(restarted.credential_key()).is_none());
}

/// Uninstall with "Delete app data" (Windows NSIS) or deleting
/// `~/Library/Application Support/com.kalcode.desktop` (macOS) removes the marker but leaves the
/// OS credential. The surviving credential is still the authority: it is adopted exactly, never
/// lowered or rewritten, and the new app-data tree is bound to it with a fresh marker.
#[test]
fn reinstall_with_a_surviving_credential_adopts_the_exact_floor() {
    let cancel = AtomicBool::new(false);
    let store = Arc::new(TestSecretStore::default());
    let (_, one) = verified_catalog(1);
    let (_, two) = verified_catalog(2);
    let (_, three) = verified_catalog(3);

    let original_install = tempfile::tempdir().expect("tempdir");
    let original = make_authority(&original_install, store.clone());
    let floor = original
        .advance(&two, NOW, deadline(), &cancel)
        .expect("activate");
    let credential = store
        .raw(original.credential_key())
        .expect("credential")
        .expose_secret()
        .to_owned();
    drop(original);
    drop(original_install);

    let reinstalled_data = tempfile::tempdir().expect("tempdir");
    let reinstalled = make_authority(&reinstalled_data, store.clone());
    assert!(!reinstalled.marker_path().exists());
    assert_eq!(
        reinstalled.load(deadline(), &cancel).expect("adopt"),
        Some(floor.clone())
    );
    assert!(reinstalled.marker_path().is_file());
    assert_eq!(store.sets.load(Ordering::SeqCst), 1);
    assert_eq!(
        store
            .raw(reinstalled.credential_key())
            .expect("credential")
            .expose_secret(),
        credential
    );

    // Adoption is a binding, not a reset: rollback is still denied and the floor is unchanged.
    assert!(matches!(
        reinstalled.advance(&one, NOW, deadline(), &cancel),
        Err(ComponentFloorError::Transition(
            super::component_catalog::CatalogTransitionError::RollbackDenied
        ))
    ));
    let restarted = make_authority(&reinstalled_data, store.clone());
    assert_eq!(
        restarted.load(deadline(), &cancel).expect("restart"),
        Some(floor.clone())
    );
    assert_eq!(
        restarted
            .advance(&two, NOW, deadline(), &cancel)
            .expect("exact replay"),
        floor
    );
    assert_eq!(store.sets.load(Ordering::SeqCst), 1);
    assert_eq!(
        restarted
            .advance(&three, NOW, deadline(), &cancel)
            .expect("forward")
            .sequence(),
        3
    );

    // A first `advance` straight after reinstall (no prior load) adopts too and refuses rollback.
    let second_reinstall = tempfile::tempdir().expect("tempdir");
    let fresh = make_authority(&second_reinstall, store.clone());
    assert!(matches!(
        fresh.advance(&two, NOW, deadline(), &cancel),
        Err(ComponentFloorError::Transition(
            super::component_catalog::CatalogTransitionError::RollbackDenied
        ))
    ));
    assert!(fresh.marker_path().is_file());
    assert_eq!(
        fresh
            .load(deadline(), &cancel)
            .expect("floor retained")
            .expect("floor")
            .sequence(),
        3
    );

    // Losing only the marker in an otherwise intact app-data tree is the same recoverable state.
    fs::remove_file(fresh.marker_path()).expect("remove marker for test");
    assert_eq!(
        fresh
            .load(deadline(), &cancel)
            .expect("re-adopt")
            .expect("floor")
            .sequence(),
        3
    );
    assert!(fresh.marker_path().is_file());
}

#[test]
fn reinstall_never_adopts_an_invalid_or_unreadable_credential() {
    let cancel = AtomicBool::new(false);
    let (_, catalog) = verified_catalog(2);
    for replacement in [
        "{}".to_owned(),
        "x".repeat(4 * 1024 + 1),
        serde_json::json!({
            "schemaVersion": 1,
            "channel": "beta",
            "platform": "windows",
            "arch": "x86_64",
            "floor": catalog.floor(),
        })
        .to_string(),
    ] {
        let temp = tempfile::tempdir().expect("tempdir");
        let store = Arc::new(TestSecretStore::default());
        let authority = make_authority(&temp, store.clone());
        store
            .set(authority.credential_key(), &SecretString::new(replacement))
            .expect("plant test floor");
        assert_eq!(
            authority.load(deadline(), &cancel),
            Err(ComponentFloorError::Corrupt)
        );
        assert!(matches!(
            authority.advance(&catalog, NOW, deadline(), &cancel),
            Err(ComponentFloorError::Corrupt)
        ));
        assert!(!authority.marker_path().exists());
        assert_eq!(store.sets.load(Ordering::SeqCst), 1);
    }

    let temp = tempfile::tempdir().expect("tempdir");
    let store = Arc::new(TestSecretStore::default());
    store.fail_get.store(true, Ordering::SeqCst);
    let authority = make_authority(&temp, store);
    assert_eq!(
        authority.load(deadline(), &cancel),
        Err(ComponentFloorError::SecureStoreUnavailable)
    );
    assert!(!authority.marker_path().exists());
}

#[test]
fn adoption_marker_failure_fails_closed_without_touching_the_credential() {
    let cancel = AtomicBool::new(false);
    let store = Arc::new(TestSecretStore::default());
    let (_, one) = verified_catalog(1);
    let (_, two) = verified_catalog(2);
    let original = tempfile::tempdir().expect("tempdir");
    let floor = make_authority(&original, store.clone())
        .advance(&two, NOW, deadline(), &cancel)
        .expect("activate");

    for failure in [
        MarkerFailure::Create,
        MarkerFailure::Write,
        MarkerFailure::Sync,
    ] {
        let reinstalled = tempfile::tempdir().expect("tempdir");
        let authority = make_authority(&reinstalled, store.clone()).with_marker_failure(failure);
        assert!(matches!(
            authority.load(deadline(), &cancel),
            Err(ComponentFloorError::Storage(io::ErrorKind::Other))
        ));
        let other_reinstall = tempfile::tempdir().expect("tempdir");
        let advancing =
            make_authority(&other_reinstall, store.clone()).with_marker_failure(failure);
        assert!(matches!(
            advancing.advance(&one, NOW, deadline(), &cancel),
            Err(ComponentFloorError::Storage(io::ErrorKind::Other))
        ));
        assert_eq!(store.sets.load(Ordering::SeqCst), 1);
        if failure == MarkerFailure::Write {
            // A torn (empty) marker is the pre-existing crash-during-marker-write state and
            // stays fail-closed, exactly as it does for a first activation.
            continue;
        }
        let healthy = make_authority(&reinstalled, store.clone());
        assert!(matches!(
            healthy.load(deadline(), &cancel),
            Ok(Some(ref adopted)) if adopted == &floor
        ));
    }
}

#[test]
fn marker_is_durable_first_and_create_write_sync_failures_never_write_a_floor() {
    let (_, catalog) = verified_catalog(1);
    let cancel = AtomicBool::new(false);
    for failure in [
        MarkerFailure::Create,
        MarkerFailure::Write,
        MarkerFailure::Sync,
    ] {
        let temp = tempfile::tempdir().expect("tempdir");
        let store = Arc::new(TestSecretStore::default());
        let authority = make_authority(&temp, store.clone()).with_marker_failure(failure);
        assert!(matches!(
            authority.advance(&catalog, NOW, deadline(), &cancel),
            Err(ComponentFloorError::Storage(io::ErrorKind::Other))
        ));
        assert_eq!(store.sets.load(Ordering::SeqCst), 0);
    }

    let temp = tempfile::tempdir().expect("tempdir");
    let store = Arc::new(TestSecretStore::default());
    store.fail_set.store(true, Ordering::SeqCst);
    let authority = make_authority(&temp, store.clone());
    let error = authority
        .advance(&catalog, NOW, deadline(), &cancel)
        .expect_err("store failure");
    assert_eq!(error, ComponentFloorError::SecureStoreUnavailable);
    assert!(authority.marker_path().is_file());
    store.fail_set.store(false, Ordering::SeqCst);
    assert_eq!(
        authority.load(deadline(), &cancel),
        Err(ComponentFloorError::MissingAfterActivation)
    );
}

#[test]
fn backend_details_are_discarded_and_exact_readback_is_required() {
    let (_, catalog) = verified_catalog(1);
    let cancel = AtomicBool::new(false);

    let temp = tempfile::tempdir().expect("tempdir");
    let failing = Arc::new(TestSecretStore::default());
    failing.fail_get.store(true, Ordering::SeqCst);
    let authority = make_authority(&temp, failing);
    let error = authority
        .load(deadline(), &cancel)
        .expect_err("backend unavailable");
    let rendered = format!("{error:?} {error}");
    assert_eq!(error, ComponentFloorError::SecureStoreUnavailable);
    assert!(!rendered.contains("credential="));

    let temp = tempfile::tempdir().expect("tempdir");
    let authority = make_authority(&temp, Arc::new(MismatchStore::default()));
    assert_eq!(
        authority.advance(&catalog, NOW, deadline(), &cancel),
        Err(ComponentFloorError::ReadbackMismatch)
    );
}

#[test]
fn corrupt_oversized_and_object_swapped_envelopes_fail_closed() {
    let (_, catalog) = verified_catalog(2);
    let cancel = AtomicBool::new(false);
    for replacement in [
        "{}".to_owned(),
        "x".repeat(4 * 1024 + 1),
        serde_json::json!({
            "schemaVersion": 1,
            "channel": "beta",
            "platform": "windows",
            "arch": "x86_64",
            "floor": catalog.floor(),
        })
        .to_string(),
    ] {
        let temp = tempfile::tempdir().expect("tempdir");
        let store = Arc::new(TestSecretStore::default());
        let authority = make_authority(&temp, store.clone());
        authority
            .advance(&catalog, NOW, deadline(), &cancel)
            .expect("activate");
        store
            .set(authority.credential_key(), &SecretString::new(replacement))
            .expect("replace test floor");
        assert_eq!(
            authority.load(deadline(), &cancel),
            Err(ComponentFloorError::Corrupt)
        );
    }
}

#[test]
fn rollback_conflict_and_expiry_never_erase_or_lower_the_floor() {
    let temp = tempfile::tempdir().expect("tempdir");
    let store = Arc::new(TestSecretStore::default());
    let authority = make_authority(&temp, store);
    let cancel = AtomicBool::new(false);
    let (_, one) = verified_catalog(1);
    let (_, two) = verified_catalog(2);
    let (_, conflicting_two) = verified_catalog_for(
        2,
        "stable",
        ComponentPlatform::Windows,
        ComponentArch::X86_64,
        74,
    );
    authority
        .advance(&two, NOW, deadline(), &cancel)
        .expect("sequence two");
    assert!(matches!(
        authority.advance(&one, NOW, deadline(), &cancel),
        Err(ComponentFloorError::Transition(
            super::component_catalog::CatalogTransitionError::RollbackDenied
        ))
    ));
    assert!(matches!(
        authority.advance(&conflicting_two, NOW, deadline(), &cancel),
        Err(ComponentFloorError::Transition(
            super::component_catalog::CatalogTransitionError::ConflictingSequence
        ))
    ));
    assert!(matches!(
        authority.advance(&two, two.catalog().expires_at, deadline(), &cancel),
        Err(ComponentFloorError::Transition(
            super::component_catalog::CatalogTransitionError::Expired
        ))
    ));
    assert_eq!(
        authority
            .load(deadline(), &cancel)
            .expect("floor retained")
            .expect("floor")
            .sequence(),
        2
    );
}

#[test]
fn concurrent_authorities_serialize_and_finish_at_the_highest_sequence() {
    let temp = tempfile::tempdir().expect("tempdir");
    let store = Arc::new(TestSecretStore::default());
    let first = make_authority(&temp, store.clone());
    let second = make_authority(&temp, store);
    let (_, two) = verified_catalog(2);
    let (_, three) = verified_catalog(3);
    let barrier = Arc::new(Barrier::new(3));

    let run = |authority: ComponentFloorAuthority,
               catalog: VerifiedComponentCatalog,
               barrier: Arc<Barrier>| {
        thread::spawn(move || {
            let cancel = AtomicBool::new(false);
            barrier.wait();
            authority.advance(&catalog, NOW, deadline(), &cancel)
        })
    };
    let a = run(first.clone(), two, barrier.clone());
    let b = run(second, three, barrier.clone());
    barrier.wait();
    let a = a.join().expect("thread a");
    let b = b.join().expect("thread b");
    assert!(a.is_ok() || matches!(a, Err(ComponentFloorError::Transition(_))));
    assert!(b.is_ok(), "higher sequence must eventually succeed: {b:?}");
    assert_eq!(
        first
            .load(deadline(), &AtomicBool::new(false))
            .expect("load")
            .expect("floor")
            .sequence(),
        3
    );
}

#[test]
fn lock_wait_is_bounded_and_cancellable() {
    let temp = tempfile::tempdir().expect("tempdir");
    let authority = make_authority(&temp, Arc::new(TestSecretStore::default()));
    // Create the hardened lock file before opening the independent blocking handle.
    authority
        .load(deadline(), &AtomicBool::new(false))
        .expect("initialize lock");
    let held = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(authority.lock_path())
        .expect("lock handle");
    held.lock_exclusive().expect("hold lock");

    let started = Instant::now();
    assert_eq!(
        authority.load(
            Instant::now() + Duration::from_millis(60),
            &AtomicBool::new(false)
        ),
        Err(ComponentFloorError::LockTimeout)
    );
    // Bounded: it gives up at its deadline instead of waiting for the lock. The margin is wide
    // because the shared gate machine is loaded (it measured over 500 ms on gate 37301060462).
    assert!(started.elapsed() < Duration::from_secs(5));

    let cancelled = Arc::new(AtomicBool::new(false));
    let setter = cancelled.clone();
    let worker = thread::spawn(move || {
        thread::sleep(Duration::from_millis(30));
        setter.store(true, Ordering::SeqCst);
    });
    let started = Instant::now();
    assert_eq!(
        authority.load(Instant::now() + Duration::from_secs(30), &cancelled),
        Err(ComponentFloorError::Cancelled)
    );
    worker.join().expect("canceller");
    // Cancellation, not the 30 s deadline, ended the wait.
    assert!(started.elapsed() < Duration::from_secs(10));
    fs2::FileExt::unlock(&held).expect("unlock");
}

#[cfg(unix)]
#[test]
fn linked_lock_file_is_rejected() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().expect("tempdir");
    let authority = make_authority(&temp, Arc::new(TestSecretStore::default()));
    let target = temp.path().join("attacker-lock");
    fs::write(&target, []).expect("target");
    symlink(&target, authority.lock_path()).expect("symlink");
    assert_eq!(
        authority.load(deadline(), &AtomicBool::new(false)),
        Err(ComponentFloorError::UnsafeStorage)
    );
}

#[test]
fn invalid_track_is_rejected_before_path_or_credential_use() {
    assert_eq!(
        CatalogFloorTrack::new(
            "../../stable",
            ComponentPlatform::Windows,
            ComponentArch::X86_64
        ),
        Err(ComponentFloorError::InvalidTrack)
    );

    let temp = tempfile::tempdir().expect("tempdir");
    let store = Arc::new(TestSecretStore::default());
    let authority = make_authority(&temp, store.clone());
    let (_, wrong_track) = verified_catalog_for(
        1,
        "beta",
        ComponentPlatform::Windows,
        ComponentArch::X86_64,
        73,
    );
    assert!(matches!(
        authority.advance(&wrong_track, NOW, deadline(), &AtomicBool::new(false)),
        Err(ComponentFloorError::Transition(
            super::component_catalog::CatalogTransitionError::DifferentTrack
        ))
    ));
    assert_eq!(store.sets.load(Ordering::SeqCst), 0);
    assert!(!authority.marker_path().exists());
}

/// Manual platform proof only. It uses a unique test account, never a production floor key, and
/// always attempts credential cleanup. CI and normal local tests do not touch the OS keychain.
#[test]
#[ignore = "requires KALCODE_RUN_OS_FLOOR_PROBE=1 and an interactive OS credential store"]
fn os_store_round_trip_uses_an_isolated_unique_floor_key() {
    if std::env::var("KALCODE_RUN_OS_FLOOR_PROBE").as_deref() != Ok("1") {
        return;
    }
    let temp = tempfile::tempdir().expect("tempdir");
    let store = Arc::new(OsSecretStore::new());
    let unique = uuid::Uuid::new_v4().simple().to_string();
    let channel = format!("probe{}", &unique[..16]);
    let platform = if cfg!(target_os = "macos") {
        ComponentPlatform::Macos
    } else if cfg!(windows) {
        ComponentPlatform::Windows
    } else {
        ComponentPlatform::Linux
    };
    let arch = if cfg!(target_arch = "aarch64") {
        ComponentArch::Aarch64
    } else {
        ComponentArch::X86_64
    };
    let track = CatalogFloorTrack::new(channel.clone(), platform, arch).expect("probe track");
    let authority = ComponentFloorAuthority::new(store.clone(), trusted_root(&temp), track)
        .expect("probe authority");
    struct Cleanup {
        store: Arc<OsSecretStore>,
        key: SecretKey,
    }
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = self.store.delete(&self.key);
        }
    }
    let _cleanup = Cleanup {
        store,
        key: authority.credential_key().clone(),
    };
    let (_, catalog) = verified_catalog_for(1, &channel, platform, arch, 73);
    let cancel = AtomicBool::new(false);
    let floor = authority
        .advance(&catalog, NOW, deadline(), &cancel)
        .expect("OS-backed floor advance");
    assert_eq!(
        authority
            .load(deadline(), &cancel)
            .expect("OS-backed floor load"),
        Some(floor)
    );
}
