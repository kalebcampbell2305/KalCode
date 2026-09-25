//! Model download tests against a local HTTP server (no network access).

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;

/// Serves `body` for any path, honouring `Range: bytes=N-` unless `ignore_range`.
struct TestServer {
    url: String,
    requests: Arc<AtomicUsize>,
}

fn serve(body: Vec<u8>, ignore_range: bool) -> TestServer {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let requests = Arc::new(AtomicUsize::new(0));
    let counter = requests.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            counter.fetch_add(1, Ordering::SeqCst);
            let mut reader = BufReader::new(stream.try_clone().expect("clone"));
            let mut start = 0usize;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("range: bytes=") {
                    start = v.trim().trim_end_matches('-').parse().unwrap_or(0);
                }
            }
            let (status, slice) = if start > 0 && !ignore_range {
                if start > body.len() {
                    ("416 Range Not Satisfiable", &body[..0])
                } else {
                    ("206 Partial Content", &body[start..])
                }
            } else {
                ("200 OK", &body[..])
            };
            let head = format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                slice.len()
            );
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(slice);
            let _ = stream.flush();
        }
    });
    TestServer {
        url: format!("http://127.0.0.1:{port}/ggml-test.bin"),
        requests,
    }
}

fn body() -> Vec<u8> {
    (0..300_000u32).map(|i| (i % 251) as u8).collect()
}

fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn source(server: &TestServer, bytes: &[u8]) -> Source {
    Source {
        url: server.url.clone(),
        file_name: "ggml-test.bin".into(),
        size_bytes: bytes.len() as u64,
        sha256: sha(bytes),
    }
}

#[test]
fn catalog_is_pinned_and_complete() {
    assert_eq!(find(DEFAULT_MODEL).map(|m| m.id), Some("tiny.en"));
    for spec in CATALOG {
        assert_eq!(spec.sha256.len(), 64, "{}", spec.id);
        assert!(spec.sha256.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(spec.size_bytes > 30_000_000);
        let url = official_url(spec);
        assert!(url.starts_with(
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/"
        ));
        assert!(url.ends_with(spec.file_name));
    }
    assert!(find("../../etc/passwd").is_none());
}

#[test]
fn nothing_downloads_without_consent() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = ModelStore::new(dir.path());
    let bytes = body();
    let server = serve(bytes.clone(), false);
    let err = store
        .download_from("test", &source(&server, &bytes), false, |_, _| {})
        .expect_err("consent");
    assert_eq!(err, ModelError::ConsentRequired);
    assert_eq!(
        server.requests.load(Ordering::SeqCst),
        0,
        "no network request"
    );
    assert!(!store.dir().exists());
}

#[test]
fn downloads_verifies_and_installs_atomically() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = ModelStore::new(dir.path());
    let bytes = body();
    let server = serve(bytes.clone(), false);
    let mut last = (0, 0);
    let path = store
        .download_from("test", &source(&server, &bytes), true, |got, total| {
            last = (got, total)
        })
        .expect("download");
    assert_eq!(std::fs::read(&path).expect("read"), bytes);
    assert_eq!(last, (bytes.len() as u64, bytes.len() as u64));
    assert!(!store.dir().join("ggml-test.bin.partial").exists());
    // Already installed: no second request.
    let before = server.requests.load(Ordering::SeqCst);
    store
        .download_from("test", &source(&server, &bytes), true, |_, _| {})
        .expect("again");
    assert_eq!(server.requests.load(Ordering::SeqCst), before);
}

#[test]
fn checksum_mismatch_discards_the_download() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = ModelStore::new(dir.path());
    let bytes = body();
    let server = serve(bytes.clone(), false);
    let mut bad = source(&server, &bytes);
    bad.sha256 = sha(b"something else");
    let err = store
        .download_from("test", &bad, true, |_, _| {})
        .expect_err("mismatch");
    assert_eq!(err, ModelError::ChecksumMismatch);
    assert!(!store.dir().join("ggml-test.bin").exists());
    assert!(!store.dir().join("ggml-test.bin.partial").exists());
}

#[test]
fn cancel_keeps_the_partial_file_and_resume_completes() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = Arc::new(ModelStore::new(dir.path()));
    let bytes = body();
    let server = serve(bytes.clone(), false);
    let src = source(&server, &bytes);

    let canceller = store.clone();
    let err = store
        .download_from("test", &src, true, |got, _| {
            if got > 0 {
                canceller.cancel("test");
            }
        })
        .expect_err("cancelled");
    assert_eq!(err, ModelError::Cancelled);
    let partial = store.dir().join("ggml-test.bin.partial");
    let kept = std::fs::metadata(&partial).expect("partial kept").len();
    assert!(kept > 0 && kept < bytes.len() as u64, "kept {kept}");

    let mut first_progress = None;
    let path = store
        .download_from("test", &src, true, |got, _| {
            first_progress.get_or_insert(got);
        })
        .expect("resume");
    assert!(
        first_progress.expect("progress") > kept,
        "resumed after the kept bytes"
    );
    assert_eq!(std::fs::read(path).expect("read"), bytes);
}

#[test]
fn a_server_that_ignores_ranges_restarts_cleanly() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = ModelStore::new(dir.path());
    let bytes = body();
    std::fs::create_dir_all(store.dir()).expect("dir");
    std::fs::write(store.dir().join("ggml-test.bin.partial"), &bytes[..1000]).expect("partial");
    let server = serve(bytes.clone(), true);
    let path = store
        .download_from("test", &source(&server, &bytes), true, |_, _| {})
        .expect("download");
    assert_eq!(std::fs::read(path).expect("read"), bytes);
}

#[test]
fn corrupt_partial_file_fails_verification_and_is_removed() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = ModelStore::new(dir.path());
    let bytes = body();
    std::fs::create_dir_all(store.dir()).expect("dir");
    std::fs::write(
        store.dir().join("ggml-test.bin.partial"),
        vec![0xFFu8; 1000],
    )
    .expect("partial");
    let server = serve(bytes.clone(), false);
    let err = store
        .download_from("test", &source(&server, &bytes), true, |_, _| {})
        .expect_err("mismatch");
    assert_eq!(err, ModelError::ChecksumMismatch);
    assert!(!store.dir().join("ggml-test.bin.partial").exists());
    // The next attempt starts from zero and succeeds.
    store
        .download_from("test", &source(&server, &bytes), true, |_, _| {})
        .expect("retry");
}

#[test]
fn list_reports_states_and_delete_removes_files() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = ModelStore::new(dir.path());
    let states = store.list();
    assert_eq!(states.len(), CATALOG.len());
    assert!(
        states
            .iter()
            .all(|m| m.state == SpeechModelState::NotInstalled)
    );

    std::fs::create_dir_all(store.dir()).expect("dir");
    std::fs::write(store.dir().join("ggml-base.en.bin.partial"), [1u8; 10]).expect("partial");
    let base = store
        .list()
        .into_iter()
        .find(|m| m.id == "base.en")
        .expect("base");
    assert_eq!(base.state, SpeechModelState::Paused { received_bytes: 10 });

    store.delete("base.en").expect("delete");
    assert!(!store.dir().join("ggml-base.en.bin.partial").exists());
    assert_eq!(store.delete("nope"), Err(ModelError::Unknown));
    assert_eq!(store.installed_path("base.en"), None);
}
