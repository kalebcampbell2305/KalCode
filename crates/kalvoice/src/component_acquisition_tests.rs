use std::collections::VecDeque;
use std::io::Cursor;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signer as _, SigningKey};
use tempfile::TempDir;

use super::*;
use crate::component_manifest::{
    ComponentArch, ComponentKind, ComponentPlatform, ComponentVerifier, TOKEN_TYPE,
};
use crate::component_store::{
    ComponentReceiptStatus, ComponentSelector, ComponentStore, TrustedComponentDirectory,
};

const NOW: i64 = 1_790_000_000;
const KEY_ID: &str = "component-2026-1";
type RecordedRequests = Arc<Mutex<Vec<(String, Option<u64>)>>>;

fn signing_key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn verifier(key: &SigningKey) -> ComponentVerifier {
    let encoded = URL_SAFE_NO_PAD.encode(key.verifying_key().as_bytes());
    ComponentVerifier::from_keys(
        [(KEY_ID, encoded.as_str())],
        ["models.kalcoded.com", "components.kalcoded.com"],
    )
    .expect("test verifier")
}

fn token(key: &SigningKey, artifact: &[u8]) -> String {
    token_for_target(key, artifact, host_platform(), host_arch())
}

fn token_for_target(
    key: &SigningKey,
    artifact: &[u8],
    platform: ComponentPlatform,
    arch: ComponentArch,
) -> String {
    let digest = format!("{:x}", Sha256::digest(artifact));
    let payload = serde_json::json!({
        "schemaVersion": 1,
        "componentId": "kalvoice.reasoner.test",
        "kind": "model",
        "version": "1.0.0",
        "sequence": 1,
        "platform": platform,
        "arch": arch,
        "runtimeAbi": "kalvoice-llama-cpp.v1",
        "sizeBytes": artifact.len(),
        "sha256": digest,
        "artifactUrl": format!(
            "https://models.kalcoded.com/components/v1/model/kalvoice.reasoner.test/1.0.0/{digest}/reasoner.gguf"
        ),
        "licenses": [{
            "spdxId": "Apache-2.0",
            "noticeSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        }],
        "provenance": {
            "sourceId": "ggml-org/test",
            "sourceRevision": "0123456789abcdef",
            "sourceIntegritySha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "buildRecipeSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
        },
        "issuedAt": NOW,
        "expiresAt": NOW + 86_400,
        "keyId": KEY_ID
    });
    let header = serde_json::json!({ "alg": "EdDSA", "kid": KEY_ID, "typ": TOKEN_TYPE });
    let input = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(header.to_string()),
        URL_SAFE_NO_PAD.encode(payload.to_string())
    );
    let signature = key.sign(input.as_bytes());
    format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature.to_bytes()))
}

#[derive(Clone)]
struct FakeTransport {
    calls: Arc<AtomicUsize>,
    requests: RecordedRequests,
    responses: Arc<Mutex<VecDeque<Result<ArtifactResponse, TransportFailure>>>>,
}

impl FakeTransport {
    fn new(responses: Vec<Result<ArtifactResponse, TransportFailure>>) -> Self {
        Self {
            calls: Arc::new(AtomicUsize::new(0)),
            requests: Arc::new(Mutex::new(Vec::new())),
            responses: Arc::new(Mutex::new(responses.into())),
        }
    }
}

impl ArtifactTransport for FakeTransport {
    fn get(
        &self,
        url: &str,
        range_start: Option<u64>,
    ) -> Result<ArtifactResponse, TransportFailure> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.requests
            .lock()
            .expect("requests")
            .push((url.to_owned(), range_start));
        self.responses
            .lock()
            .expect("responses")
            .pop_front()
            .expect("a fake response")
    }
}

fn response(status: u16, bytes: &[u8]) -> ArtifactResponse {
    ArtifactResponse {
        status,
        location: None,
        content_length: Some(bytes.len() as u64),
        content_range: None,
        body: Box::new(Cursor::new(bytes.to_vec())),
    }
}

fn create_private_dir(path: &std::path::Path) {
    std::fs::create_dir_all(path).expect("private test directory");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;

        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .expect("private test directory mode");
    }
}

fn harness(
    temp: &TempDir,
    key: &SigningKey,
    transport: FakeTransport,
) -> (ComponentAcquirer, ComponentStore, ComponentVerifier) {
    let verifier = verifier(key);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;

        std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o700))
            .expect("private test authority mode");
    }
    let authority = TrustedComponentDirectory::open_existing(temp.path()).expect("test authority");
    let store_root = authority
        .create_private_child("store")
        .expect("store directory");
    let staging_root = authority
        .create_private_child("acquisition")
        .expect("staging directory");
    let store = ComponentStore::new(store_root, verifier.clone(), []).expect("component store");
    let acquirer = ComponentAcquirer::with_transport(
        store.clone(),
        verifier.clone(),
        staging_root,
        Arc::new(transport),
    );
    (acquirer, store, verifier)
}

fn selector() -> ComponentSelector {
    ComponentSelector {
        component_id: "kalvoice.reasoner.test".into(),
        kind: ComponentKind::Model,
        platform: host_platform(),
        arch: host_arch(),
        runtime_abi: "kalvoice-llama-cpp.v1".into(),
    }
}

fn staging_is_empty(temp: &TempDir) -> bool {
    std::fs::read_dir(temp.path().join("acquisition"))
        .expect("trusted staging directory")
        .next()
        .is_none()
}

#[test]
fn a_valid_signature_for_another_platform_is_rejected_before_fetch() {
    let temp = TempDir::new().expect("temp");
    let key = signing_key(7);
    let bytes = b"bounded artifact";
    let other_platform = match host_platform() {
        ComponentPlatform::Windows => ComponentPlatform::Macos,
        ComponentPlatform::Macos | ComponentPlatform::Linux => ComponentPlatform::Windows,
    };
    let transport = FakeTransport::new(vec![Ok(response(200, bytes))]);
    let calls = Arc::clone(&transport.calls);
    let (acquirer, _, _) = harness(&temp, &key, transport);

    assert!(matches!(
        acquirer.acquire(
            &token_for_target(&key, bytes, other_platform, host_arch()),
            NOW,
            true,
            &AtomicBool::new(false),
            |_, _| {}
        ),
        Err(ComponentAcquisitionError::WrongTarget)
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(staging_is_empty(&temp));
}

#[test]
fn consent_and_signature_are_required_before_any_network_or_disk_effect() {
    let temp = TempDir::new().expect("temp");
    let key = signing_key(7);
    let bytes = b"bounded artifact";
    let transport = FakeTransport::new(vec![Ok(response(200, bytes))]);
    let calls = Arc::clone(&transport.calls);
    let (acquirer, _, _) = harness(&temp, &key, transport);
    let cancel = AtomicBool::new(false);

    assert!(matches!(
        acquirer.acquire(&token(&key, bytes), NOW, false, &cancel, |_, _| {}),
        Err(ComponentAcquisitionError::ConsentRequired)
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(staging_is_empty(&temp));

    let mut damaged = token(&key, bytes);
    damaged.pop();
    damaged.push('A');
    assert!(matches!(
        acquirer.acquire(&damaged, NOW, true, &cancel, |_, _| {}),
        Err(ComponentAcquisitionError::Manifest(_))
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(staging_is_empty(&temp));
}

#[test]
fn verified_bytes_install_atomically_and_the_staging_file_is_removed() {
    let temp = TempDir::new().expect("temp");
    let key = signing_key(7);
    let bytes = b"bounded artifact";
    let transport = FakeTransport::new(vec![Ok(response(200, bytes))]);
    let calls = Arc::clone(&transport.calls);
    let (acquirer, store, _) = harness(&temp, &key, transport);
    let cancel = AtomicBool::new(false);
    let mut progress = Vec::new();

    let installed = acquirer
        .acquire(
            &token(&key, bytes),
            NOW,
            true,
            &cancel,
            |received, total| {
                progress.push((received, total));
            },
        )
        .expect("verified install");

    assert_eq!(installed.version, "1.0.0");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        progress.last().copied(),
        Some((bytes.len() as u64, bytes.len() as u64))
    );
    assert!(matches!(
        store.status(&selector(), NOW),
        ComponentReceiptStatus::Present { sequence: 1, .. }
    ));
    assert_eq!(
        std::fs::read_dir(temp.path().join("acquisition"))
            .expect("staging directory")
            .filter_map(Result::ok)
            .filter(|entry| entry
                .path()
                .extension()
                .is_some_and(|value| value == "partial"))
            .count(),
        0
    );
}

#[test]
fn exact_partial_is_resumed_only_with_a_matching_content_range() {
    let temp = TempDir::new().expect("temp");
    let key = signing_key(7);
    let bytes = b"resume this artifact";
    let signed = token(&key, bytes);
    let digest = format!("{:x}", Sha256::digest(bytes));
    let partial_dir = temp.path().join("acquisition");
    create_private_dir(&partial_dir);
    std::fs::write(partial_dir.join(format!("{digest}.partial")), &bytes[..7])
        .expect("partial fixture");
    let mut resumed = response(206, &bytes[7..]);
    resumed.content_range = Some(format!(
        "bytes 7-{}/{total}",
        bytes.len() - 1,
        total = bytes.len()
    ));
    let transport = FakeTransport::new(vec![Ok(resumed)]);
    let requests = Arc::clone(&transport.requests);
    let (acquirer, store, _) = harness(&temp, &key, transport);

    acquirer
        .acquire(&signed, NOW, true, &AtomicBool::new(false), |_, _| {})
        .expect("resumed install");
    assert_eq!(requests.lock().expect("requests")[0].1, Some(7));
    let lease = store.acquire(&selector(), NOW).expect("installed lease");
    assert_eq!(
        lease.model_path().and_then(|path| std::fs::read(path).ok()),
        Some(bytes.to_vec())
    );
}

#[test]
fn redirect_must_preserve_the_signed_immutable_path_and_allowed_host() {
    let temp = TempDir::new().expect("temp");
    let key = signing_key(7);
    let bytes = b"artifact";
    let signed = token(&key, bytes);
    let mut redirect = response(302, b"");
    redirect.content_length = None;
    redirect.location = Some("https://evil.example/components/v1/model/x/y/z/file".into());
    let transport = FakeTransport::new(vec![Ok(redirect)]);
    let calls = Arc::clone(&transport.calls);
    let (acquirer, _, _) = harness(&temp, &key, transport);

    assert!(matches!(
        acquirer.acquire(&signed, NOW, true, &AtomicBool::new(false), |_, _| {}),
        Err(ComponentAcquisitionError::Manifest(VerifyError::InvalidUrl))
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn an_allowed_mirror_redirect_preserves_the_exact_signed_path() {
    let temp = TempDir::new().expect("temp");
    let key = signing_key(7);
    let bytes = b"artifact";
    let signed = token(&key, bytes);
    let verified = verifier(&key)
        .verify(&signed, NOW)
        .expect("signed manifest");
    let redirected_url = verified.manifest().artifact_url.replacen(
        "models.kalcoded.com",
        "components.kalcoded.com",
        1,
    );
    let mut redirect = response(307, b"");
    redirect.content_length = None;
    redirect.location = Some(redirected_url.clone());
    let transport = FakeTransport::new(vec![Ok(redirect), Ok(response(200, bytes))]);
    let requests = Arc::clone(&transport.requests);
    let (acquirer, _, _) = harness(&temp, &key, transport);

    acquirer
        .acquire(&signed, NOW, true, &AtomicBool::new(false), |_, _| {})
        .expect("allowed mirror redirect");
    let requests = requests.lock().expect("requests");
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1], (redirected_url, None));
}

#[test]
fn a_partial_response_requires_an_exact_content_range() {
    let temp = TempDir::new().expect("temp");
    let key = signing_key(7);
    let bytes = b"resume this artifact";
    let signed = token(&key, bytes);
    let digest = format!("{:x}", Sha256::digest(bytes));
    let partial_dir = temp.path().join("acquisition");
    create_private_dir(&partial_dir);
    std::fs::write(partial_dir.join(format!("{digest}.partial")), &bytes[..7])
        .expect("partial fixture");
    let mut resumed = response(206, &bytes[7..]);
    resumed.content_range = Some(format!(
        "bytes 8-{}/{total}",
        bytes.len() - 1,
        total = bytes.len()
    ));
    let transport = FakeTransport::new(vec![Ok(resumed)]);
    let (acquirer, _, _) = harness(&temp, &key, transport);

    assert!(matches!(
        acquirer.acquire(&signed, NOW, true, &AtomicBool::new(false), |_, _| {}),
        Err(ComponentAcquisitionError::InvalidResponse)
    ));
}

#[test]
fn a_server_that_ignores_range_restarts_instead_of_appending() {
    let temp = TempDir::new().expect("temp");
    let key = signing_key(7);
    let bytes = b"resume this artifact";
    let signed = token(&key, bytes);
    let digest = format!("{:x}", Sha256::digest(bytes));
    let partial_dir = temp.path().join("acquisition");
    create_private_dir(&partial_dir);
    std::fs::write(partial_dir.join(format!("{digest}.partial")), b"wrong!!")
        .expect("partial fixture");
    let transport = FakeTransport::new(vec![Ok(response(200, bytes))]);
    let requests = Arc::clone(&transport.requests);
    let (acquirer, store, _) = harness(&temp, &key, transport);

    acquirer
        .acquire(&signed, NOW, true, &AtomicBool::new(false), |_, _| {})
        .expect("clean restart");
    assert_eq!(requests.lock().expect("requests")[0].1, Some(7));
    let lease = store.acquire(&selector(), NOW).expect("installed lease");
    assert_eq!(
        lease.model_path().and_then(|path| std::fs::read(path).ok()),
        Some(bytes.to_vec())
    );
}

#[test]
fn checksum_mismatch_removes_untrusted_partial_bytes() {
    let temp = TempDir::new().expect("temp");
    let key = signing_key(7);
    let expected = b"expected bytes";
    let same_size_tamper = b"tampered bytes";
    assert_eq!(expected.len(), same_size_tamper.len());
    let transport = FakeTransport::new(vec![Ok(response(200, same_size_tamper))]);
    let (acquirer, _, _) = harness(&temp, &key, transport);

    assert!(matches!(
        acquirer.acquire(
            &token(&key, expected),
            NOW,
            true,
            &AtomicBool::new(false),
            |_, _| {}
        ),
        Err(ComponentAcquisitionError::ChecksumMismatch)
    ));
    let digest = format!("{:x}", Sha256::digest(expected));
    assert!(
        !temp
            .path()
            .join("acquisition")
            .join(format!("{digest}.partial"))
            .exists()
    );
}

#[test]
fn cancellation_preserves_a_bounded_partial_for_an_explicit_resume() {
    struct CancellingReader {
        bytes: Cursor<Vec<u8>>,
        cancel: Arc<AtomicBool>,
    }
    impl Read for CancellingReader {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            let limit = buffer.len().min(4);
            let count = self.bytes.read(&mut buffer[..limit])?;
            if count > 0 {
                self.cancel.store(true, Ordering::SeqCst);
            }
            Ok(count)
        }
    }

    let temp = TempDir::new().expect("temp");
    let key = signing_key(7);
    let bytes = b"long enough artifact bytes";
    let cancel = Arc::new(AtomicBool::new(false));
    let response = ArtifactResponse {
        status: 200,
        location: None,
        content_length: Some(bytes.len() as u64),
        content_range: None,
        body: Box::new(CancellingReader {
            bytes: Cursor::new(bytes.to_vec()),
            cancel: Arc::clone(&cancel),
        }),
    };
    let transport = FakeTransport::new(vec![Ok(response)]);
    let (acquirer, _, _) = harness(&temp, &key, transport);

    assert!(matches!(
        acquirer.acquire(&token(&key, bytes), NOW, true, &cancel, |_, _| {}),
        Err(ComponentAcquisitionError::Cancelled)
    ));
    let digest = format!("{:x}", Sha256::digest(bytes));
    let partial = temp
        .path()
        .join("acquisition")
        .join(format!("{digest}.partial"));
    assert!(
        std::fs::metadata(partial)
            .is_ok_and(|metadata| { metadata.len() > 0 && metadata.len() < bytes.len() as u64 })
    );
}

#[test]
fn cancellation_interrupts_waiting_for_an_acquisition_lock() {
    let temp = TempDir::new().expect("temp");
    let key = signing_key(7);
    let bytes = b"bounded artifact";
    let signed = token(&key, bytes);
    let digest = format!("{:x}", Sha256::digest(bytes));
    let transport = FakeTransport::new(vec![Ok(response(200, bytes))]);
    let calls = Arc::clone(&transport.calls);
    let (mut acquirer, _, _) = harness(&temp, &key, transport);
    let lock = open_acquisition_lock(
        &temp
            .path()
            .join("acquisition")
            .join(format!("{digest}.lock")),
    )
    .expect("acquisition lock");
    lock.lock_exclusive().expect("hold acquisition lock");
    let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
    let (resume_tx, resume_rx) = std::sync::mpsc::sync_channel(1);
    let resume_rx = Arc::new(Mutex::new(resume_rx));
    let first_conflict = Arc::new(AtomicBool::new(true));
    acquirer.observe_lock_conflict(Arc::new(move || {
        if first_conflict.swap(false, Ordering::SeqCst) {
            let _ = entered_tx.try_send(());
            if let Ok(receiver) = resume_rx.lock() {
                let _ = receiver.recv_timeout(Duration::from_secs(5));
            }
        }
    }));
    let cancel = Arc::new(AtomicBool::new(false));
    let worker_cancel = Arc::clone(&cancel);
    let (result_tx, result_rx) = std::sync::mpsc::sync_channel(1);
    let task = std::thread::spawn(move || {
        let result = acquirer.acquire(&signed, NOW, true, &worker_cancel, |_, _| {});
        let _ = result_tx.send(result);
    });

    let entered = entered_rx.recv_timeout(Duration::from_secs(5));
    let started = std::time::Instant::now();
    cancel.store(true, Ordering::SeqCst);
    let _ = resume_tx.try_send(());
    let result = result_rx.recv_timeout(Duration::from_secs(2));
    let elapsed = started.elapsed();
    drop(lock);
    let joined = task.join();

    entered.expect("worker reached the held acquisition lock");
    joined.expect("acquisition task");
    let result = result.expect("cancellation completed while the lock remained held");
    assert!(matches!(result, Err(ComponentAcquisitionError::Cancelled)));
    assert!(elapsed < Duration::from_secs(1));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[cfg(unix)]
#[test]
fn staging_symlinks_and_hardlinks_are_refused_without_touching_their_targets() {
    use std::os::unix::fs::symlink;

    let key = signing_key(7);
    let bytes = b"bounded artifact";
    let signed = token(&key, bytes);
    let digest = format!("{:x}", Sha256::digest(bytes));

    let linked_root = TempDir::new().expect("temp");
    let real_staging = linked_root.path().join("real-staging");
    create_private_dir(&real_staging);
    symlink(&real_staging, linked_root.path().join("acquisition")).expect("staging symlink");
    assert!(matches!(
        TrustedComponentDirectory::open_existing(linked_root.path().join("acquisition")),
        Err(ComponentStoreError::UnsafeStorage)
    ));
    assert_eq!(
        std::fs::read_dir(&real_staging)
            .expect("real staging")
            .count(),
        0
    );

    let linked_file = TempDir::new().expect("temp");
    let acquisition = linked_file.path().join("acquisition");
    create_private_dir(&acquisition);
    let outside = linked_file.path().join("outside");
    std::fs::write(&outside, b"outside").expect("outside fixture");
    std::fs::hard_link(&outside, acquisition.join(format!("{digest}.partial")))
        .expect("hardlink fixture");
    let transport = FakeTransport::new(vec![Ok(response(200, bytes))]);
    let calls = Arc::clone(&transport.calls);
    let (acquirer, _, _) = harness(&linked_file, &key, transport);
    assert!(matches!(
        acquirer.acquire(&signed, NOW, true, &AtomicBool::new(false), |_, _| {}),
        Err(ComponentAcquisitionError::UnsafeStaging)
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(std::fs::read(outside).expect("outside remains"), b"outside");
}

#[cfg(windows)]
#[test]
fn staging_hardlinks_are_refused_without_touching_their_targets_on_windows() {
    let key = signing_key(7);
    let bytes = b"bounded artifact";
    let signed = token(&key, bytes);
    let digest = format!("{:x}", Sha256::digest(bytes));

    let linked_partial = TempDir::new().expect("temp");
    let acquisition = linked_partial.path().join("acquisition");
    create_private_dir(&acquisition);
    let outside = linked_partial.path().join("outside");
    std::fs::write(&outside, b"outside").expect("outside fixture");
    std::fs::hard_link(&outside, acquisition.join(format!("{digest}.partial")))
        .expect("hardlink fixture");
    let transport = FakeTransport::new(vec![Ok(response(200, bytes))]);
    let calls = Arc::clone(&transport.calls);
    let (acquirer, _, _) = harness(&linked_partial, &key, transport);
    assert!(matches!(
        acquirer.acquire(&signed, NOW, true, &AtomicBool::new(false), |_, _| {}),
        Err(ComponentAcquisitionError::UnsafeStaging)
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(std::fs::read(outside).expect("outside remains"), b"outside");

    let linked_lock = TempDir::new().expect("temp");
    let acquisition = linked_lock.path().join("acquisition");
    create_private_dir(&acquisition);
    let outside = linked_lock.path().join("outside");
    std::fs::write(&outside, b"").expect("outside fixture");
    std::fs::hard_link(&outside, acquisition.join(format!("{digest}.lock")))
        .expect("hardlink fixture");
    let transport = FakeTransport::new(vec![Ok(response(200, bytes))]);
    let calls = Arc::clone(&transport.calls);
    let (acquirer, _, _) = harness(&linked_lock, &key, transport);
    assert!(matches!(
        acquirer.acquire(&signed, NOW, true, &AtomicBool::new(false), |_, _| {}),
        Err(ComponentAcquisitionError::UnsafeStaging)
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(std::fs::read(outside).expect("outside remains"), b"");
}
