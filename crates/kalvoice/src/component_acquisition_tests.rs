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

// The real production ureq agent/connector and HTTP body reader, with HTTP permitted ONLY for
// this test's loopback request. Signed manifest verification and ComponentStore remain real.
struct LoopbackArtifactTransport {
    agent: ureq::Agent,
    url: String,
}

impl ArtifactTransport for LoopbackArtifactTransport {
    fn get(&self, _: &str, _: Option<u64>) -> Result<ArtifactResponse, TransportFailure> {
        let response = self
            .agent
            .get(&self.url)
            .config()
            .https_only(false)
            .build()
            .call()
            .map_err(|_| TransportFailure::Network)?;
        Ok(ArtifactResponse {
            status: response.status().as_u16(),
            location: None,
            content_length: response
                .headers()
                .get("content-length")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse().ok()),
            content_range: None,
            body: Box::new(response.into_body().into_reader()),
        })
    }
}

fn loopback_body(
    bytes: &'static [u8],
    between_bytes: Duration,
) -> (LoopbackArtifactTransport, std::thread::JoinHandle<()>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("loopback bind");
    let url = format!(
        "http://{}/component",
        listener.local_addr().expect("address")
    );
    listener
        .set_nonblocking(true)
        .expect("bounded fixture accept");
    let worker = std::thread::spawn(move || {
        let accept_deadline = std::time::Instant::now() + Duration::from_secs(3);
        let mut socket = loop {
            match listener.accept() {
                Ok((socket, _)) => break socket,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    assert!(
                        std::time::Instant::now() < accept_deadline,
                        "fixture accept timed out"
                    );
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("fixture accept failed: {error:?}"),
            }
        };
        // macOS can inherit the listener's nonblocking mode on accepted sockets.
        // Restore blocking I/O so the bounded read/write timeouts below govern the fixture.
        socket.set_nonblocking(false).expect("blocking fixture I/O");
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .expect("read bound");
        socket
            .set_write_timeout(Some(Duration::from_secs(3)))
            .expect("write bound");
        let mut request = [0; 4096];
        let mut received = 0;
        while !request[..received].windows(4).any(|end| end == b"\r\n\r\n") {
            assert!(received < request.len(), "fixture request exceeded bound");
            let count = socket.read(&mut request[received..]).expect("request");
            assert!(count > 0, "fixture request ended early");
            received += count;
        }
        write!(
            socket,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            bytes.len()
        )
        .expect("headers");
        for (index, byte) in bytes.iter().enumerate() {
            if index > 0 {
                std::thread::sleep(between_bytes);
            }
            if socket.write_all(&[*byte]).is_err() {
                break;
            }
        }
    });
    (
        LoopbackArtifactTransport {
            agent: UreqTransport::new().agent,
            url,
        },
        worker,
    )
}

#[test]
fn production_transport_installs_a_verified_body_progressing_longer_than_five_seconds() {
    let temp = TempDir::new().expect("temp");
    let key = signing_key(7);
    let bytes = b"12345678";
    let (mut acquirer, store, _) = harness(&temp, &key, FakeTransport::new(vec![]));
    let (transport, worker) = loopback_body(bytes, Duration::from_millis(900));
    acquirer.transport = Arc::new(transport);
    let started = std::time::Instant::now();
    let result = acquirer.acquire(
        &token(&key, bytes),
        NOW,
        true,
        &AtomicBool::new(false),
        |_, _| {},
    );
    worker.join().expect("joined loopback fixture");
    assert!(started.elapsed() >= Duration::from_secs(6));
    result.expect("steady progress must not exhaust a five-second total body budget");
    let lease = store
        .acquire(&selector(), NOW)
        .expect("verified installed lease");
    assert_eq!(
        lease.model_path().and_then(|path| std::fs::read(path).ok()),
        Some(bytes.to_vec())
    );
}

#[test]
fn production_transport_stalled_body_is_bounded_and_cancel_is_not_a_network_failure() {
    for cancelled in [false, true] {
        let temp = TempDir::new().expect("temp");
        let key = signing_key(7);
        let bytes = b"ab";
        let (mut acquirer, store, _) = harness(&temp, &key, FakeTransport::new(vec![]));
        let (transport, worker) = loopback_body(bytes, Duration::from_secs(7));
        acquirer.transport = Arc::new(transport);
        let cancel = Arc::new(AtomicBool::new(false));
        let cancellation = cancel.clone();
        let (progress_tx, progress_rx) = std::sync::mpsc::sync_channel(1);
        let canceller = std::thread::spawn(move || {
            progress_rx
                .recv_timeout(Duration::from_secs(3))
                .expect("first byte received");
            std::thread::sleep(Duration::from_millis(250));
            if cancelled {
                cancellation.store(true, Ordering::SeqCst);
            }
        });
        let started = std::time::Instant::now();
        let result = acquirer.acquire(&token(&key, bytes), NOW, true, &cancel, |received, _| {
            if received == 1 {
                let _ = progress_tx.try_send(());
            }
        });
        let elapsed = started.elapsed();
        canceller.join().expect("joined canceller");
        worker.join().expect("joined loopback fixture");
        assert!(
            elapsed < Duration::from_millis(6500),
            "blocked read was not bounded: {elapsed:?}"
        );
        if cancelled {
            assert!(
                matches!(result, Err(ComponentAcquisitionError::Cancelled)),
                "{result:?}"
            );
        } else {
            assert!(
                matches!(result, Err(ComponentAcquisitionError::Network)),
                "{result:?}"
            );
        }
        assert_eq!(
            store.status(&selector(), NOW),
            ComponentReceiptStatus::Missing
        );
        let digest = format!("{:x}", Sha256::digest(bytes));
        assert_eq!(
            std::fs::read(
                temp.path()
                    .join("acquisition")
                    .join(format!("{digest}.partial"))
            )
            .expect("bounded partial"),
            b"a"
        );
        let lock = open_acquisition_lock(
            &temp
                .path()
                .join("acquisition")
                .join(format!("{digest}.lock")),
        )
        .expect("lock");
        lock.try_lock_exclusive()
            .expect("acquisition releases ownership after failure/cancel");
        lock.unlock().expect("unlock test handle");
    }
}

#[test]
fn production_transport_retains_https_only() {
    let response = UreqTransport::new()
        .agent
        .get("http://127.0.0.1:1/component")
        .call();
    assert!(matches!(response, Err(ureq::Error::RequireHttpsOnly(_))));
}

#[test]
fn input_wait_wrapper_preserves_tls_and_earlier_phase_deadlines() {
    use ureq::unversioned::transport::{LazyBuffers, time::Duration as TransportDuration};

    #[derive(Debug)]
    struct ProbeTransport {
        buffers: LazyBuffers,
        observed: Arc<Mutex<Vec<NextTimeout>>>,
    }
    impl Transport for ProbeTransport {
        fn buffers(&mut self) -> &mut dyn Buffers {
            &mut self.buffers
        }
        fn transmit_output(&mut self, _: usize, _: NextTimeout) -> Result<(), ureq::Error> {
            Ok(())
        }
        fn await_input(&mut self, timeout: NextTimeout) -> Result<bool, ureq::Error> {
            self.observed.lock().expect("observed").push(timeout);
            Ok(true)
        }
        fn is_open(&mut self) -> bool {
            false
        }
        fn is_tls(&self) -> bool {
            true
        }
    }
    let observed = Arc::new(Mutex::new(Vec::new()));
    let mut transport = BoundedInputTransport {
        inner: Box::new(ProbeTransport {
            buffers: LazyBuffers::new(1024, 1024),
            observed: observed.clone(),
        }),
    };
    assert!(transport.is_tls());
    assert!(!transport.is_open());
    let earlier = NextTimeout {
        after: TransportDuration::from_millis(80),
        reason: ureq::Timeout::RecvResponse,
    };
    transport.await_input(earlier).expect("earlier bound");
    // With no configured total body timeout, ureq supplies Global/NotHappening.
    transport
        .await_input(NextTimeout {
            after: TransportDuration::NotHappening,
            reason: ureq::Timeout::Global,
        })
        .expect("idle bound");
    assert_eq!(
        *observed.lock().expect("observed"),
        vec![
            earlier,
            NextTimeout {
                after: TransportDuration::from_secs(5),
                reason: ureq::Timeout::RecvBody,
            }
        ]
    );
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
