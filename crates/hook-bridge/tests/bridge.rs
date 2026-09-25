//! The real `kalcode-hook` binary against the real bridge server: authentication, replay,
//! squatting, fail-closed and fail-open behaviour (docs/campaigns/Z7-W4-THREATS.md §4).

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use kalcode_hook_bridge::client::{self, Stream};
use kalcode_hook_bridge::key::{SessionKey, random_id};
use kalcode_hook_bridge::server::{BridgeServer, HookHandler, ServerConfig};
use kalcode_hook_bridge::wire::{self, Hello, PROTOCOL_VERSION, Request, Response};
use kalcode_hook_bridge::{DEADLINE_ENV, Endpoint, HookEvent, HookRecord, HookReply, KEY_ENV};

const HELPER: &str = env!("CARGO_BIN_EXE_kalcode-hook");

/// Answers with a fixed reply and remembers what it saw.
struct Fixed {
    reply: HookReply,
    delay: Duration,
    seen: Mutex<Vec<HookRecord>>,
    calls: AtomicUsize,
}

impl Fixed {
    fn new(reply: HookReply) -> Arc<Self> {
        Self::slow(reply, Duration::ZERO)
    }

    fn slow(reply: HookReply, delay: Duration) -> Arc<Self> {
        Arc::new(Self {
            reply,
            delay,
            seen: Mutex::new(Vec::new()),
            calls: AtomicUsize::new(0),
        })
    }
}

impl HookHandler for Fixed {
    fn handle(&self, record: HookRecord) -> HookReply {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.seen.lock().expect("lock").push(record);
        std::thread::sleep(self.delay);
        self.reply.clone()
    }
}

fn server() -> (tempfile::TempDir, BridgeServer) {
    let dir = tempfile::tempdir().expect("dir");
    let endpoint = Endpoint::generate(Some(dir.path())).expect("endpoint");
    let server = BridgeServer::start(ServerConfig::new(endpoint)).expect("server");
    (dir, server)
}

struct Run {
    code: i32,
    stdout: String,
    stderr: String,
    took: Duration,
}

fn helper(args: &[&str], key: Option<&str>, stdin: &[u8], deadline_ms: Option<u64>) -> Run {
    let mut command = Command::new(HELPER);
    command
        .args(args)
        .env_remove(KEY_ENV)
        .env_remove(DEADLINE_ENV)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(key) = key {
        command.env(KEY_ENV, key);
    }
    if let Some(ms) = deadline_ms {
        command.env(DEADLINE_ENV, ms.to_string());
    }
    let started = Instant::now();
    let mut child = command.spawn().expect("spawn helper");
    let mut input = child.stdin.take().expect("stdin");
    let _ = input.write_all(stdin);
    drop(input);
    let output = child.wait_with_output().expect("wait");
    Run {
        code: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        took: started.elapsed(),
    }
}

const BASH_LS: &[u8] =
    br#"{"session_id":"abc","hook_event_name":"PreToolUse","tool_name":"Bash","tool_use_id":"toolu_1","tool_input":{"command":"ls"}}"#;

fn pre_tool_use(server: &BridgeServer, session: &str, key: Option<&str>) -> Run {
    helper(
        &["claude", "PreToolUse", server.endpoint().as_str(), session],
        key,
        BASH_LS,
        None,
    )
}

#[test]
fn authenticated_round_trip_renders_each_decision() {
    let (_dir, server) = server();
    for (reply, code, decision) in [
        (
            HookReply::Allow {
                reason: "ok".into(),
            },
            0,
            Some("allow"),
        ),
        (
            HookReply::Ask {
                reason: "ask".into(),
            },
            0,
            Some("ask"),
        ),
        (
            HookReply::Deny {
                reason: "Refused by KalCode policy".into(),
            },
            2,
            None,
        ),
        (HookReply::NoDecision, 0, None),
    ] {
        let handler = Fixed::new(reply.clone());
        let reg = server.register(handler.clone()).expect("register");
        let run = pre_tool_use(&server, reg.session_id(), Some(&reg.key_hex()));
        assert_eq!(run.code, code, "{reply:?}: {}", run.stderr);
        match decision {
            Some(kind) => {
                let json: serde_json::Value = serde_json::from_str(&run.stdout).expect("json");
                assert_eq!(json["hookSpecificOutput"]["permissionDecision"], kind);
            }
            None => assert!(run.stdout.is_empty(), "{}", run.stdout),
        }
        if code == 2 {
            assert!(run.stderr.contains("Refused by KalCode policy"));
        }
        let seen = handler.seen.lock().expect("lock");
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].event, Some(HookEvent::PreToolUse));
        assert_eq!(seen[0].tool_name.as_deref(), Some("Bash"));
        assert_eq!(seen[0].tool_use_id.as_deref(), Some("toolu_1"));
    }
    assert!(server.stats().served >= 4);
    assert_eq!(server.stats().rejected_auth, 0);
}

#[test]
fn forged_request_without_the_key_is_rejected_and_blocks() {
    let (_dir, server) = server();
    let handler = Fixed::new(HookReply::Allow {
        reason: "never".into(),
    });
    let reg = server.register(handler.clone()).expect("register");
    // No key at all: the helper refuses before connecting.
    let run = pre_tool_use(&server, reg.session_id(), None);
    assert_eq!(run.code, 2);
    // A wrong key: the server rejects the MAC and closes without a reply.
    let wrong = SessionKey::generate().expect("key").to_hex();
    let run = pre_tool_use(&server, reg.session_id(), Some(&wrong));
    assert_eq!(run.code, 2, "{}", run.stdout);
    assert!(run.stdout.is_empty());
    assert_eq!(
        handler.calls.load(Ordering::SeqCst),
        0,
        "the handler never ran"
    );
    assert_eq!(server.stats().rejected_auth, 1);
}

#[test]
fn unknown_and_revoked_sessions_are_rejected() {
    let (_dir, server) = server();
    let handler = Fixed::new(HookReply::Allow {
        reason: "never".into(),
    });
    let reg = server.register(handler.clone()).expect("register");
    let key = reg.key_hex();
    let unknown = random_id().expect("id");
    assert_eq!(pre_tool_use(&server, &unknown, Some(&key)).code, 2);
    let session = reg.session_id().to_owned();
    drop(reg); // the session ended: its hooks are stale
    assert_eq!(server.session_count(), 0);
    assert_eq!(pre_tool_use(&server, &session, Some(&key)).code, 2);
    assert_eq!(handler.calls.load(Ordering::SeqCst), 0);
    assert_eq!(server.stats().rejected_session, 2);
}

/// Performs the helper's side by hand so a request can be captured and tampered with.
fn raw_request(
    stream: &mut dyn Stream,
    session: &str,
    key: &SessionKey,
    body: &str,
) -> (Hello, Request) {
    let hello: Hello = wire::read_frame(stream).expect("hello");
    let nonce = hex::encode([9u8; 32]);
    let request = Request {
        v: PROTOCOL_VERSION,
        session: session.to_owned(),
        nonce: nonce.clone(),
        body: body.to_owned(),
        mac: wire::request_mac(key, &hello.nonce, &nonce, session, body),
    };
    (hello, request)
}

fn connect(server: &BridgeServer) -> Box<dyn Stream> {
    client::connect(server.endpoint(), Instant::now() + Duration::from_secs(3)).expect("connect")
}

fn record_body() -> String {
    serde_json::to_string(&HookRecord {
        event: Some(HookEvent::PreToolUse),
        tool_name: Some("Bash".into()),
        ..HookRecord::default()
    })
    .expect("json")
}

#[test]
fn replayed_and_tampered_requests_are_rejected() {
    let (_dir, server) = server();
    let handler = Fixed::new(HookReply::Allow {
        reason: "ok".into(),
    });
    let reg = server.register(handler.clone()).expect("register");
    let key = SessionKey::from_hex(&reg.key_hex()).expect("key");

    // A valid request is served once.
    let mut first = connect(&server);
    let (_, request) = raw_request(first.as_mut(), reg.session_id(), &key, &record_body());
    wire::write_frame(first.as_mut(), &request).expect("send");
    let response: Response = wire::read_frame(first.as_mut()).expect("served");
    assert!(!response.body.is_empty());
    assert_eq!(handler.calls.load(Ordering::SeqCst), 1);

    // Replaying it on a new connection fails: the server's nonce is different.
    let mut second = connect(&server);
    let _hello: Hello = wire::read_frame(second.as_mut()).expect("hello");
    wire::write_frame(second.as_mut(), &request).expect("send");
    let mut rest = Vec::new();
    let _ = second.read_to_end(&mut rest);
    assert!(rest.is_empty(), "no reply to a replayed request");

    // Changing the body after MACing fails too.
    let mut third = connect(&server);
    let (_, mut tampered) = raw_request(third.as_mut(), reg.session_id(), &key, &record_body());
    tampered.body = tampered.body.replace("Bash", "Read");
    wire::write_frame(third.as_mut(), &tampered).expect("send");
    let mut rest = Vec::new();
    let _ = third.read_to_end(&mut rest);
    assert!(rest.is_empty());

    assert_eq!(handler.calls.load(Ordering::SeqCst), 1);
    assert_eq!(server.stats().rejected_auth, 2);
}

/// An in-memory stream: reads from `input`, records writes.
struct Scripted {
    input: std::io::Cursor<Vec<u8>>,
    written: Vec<u8>,
}

impl Read for Scripted {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.input.read(buf)
    }
}

impl Write for Scripted {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.written.extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn scripted(frames: &[Vec<u8>]) -> Scripted {
    Scripted {
        input: std::io::Cursor::new(frames.concat()),
        written: Vec::new(),
    }
}

fn frame<T: serde::Serialize>(value: &T) -> Vec<u8> {
    let mut out = Vec::new();
    wire::write_frame(&mut out, value).expect("frame");
    out
}

#[test]
fn helper_rejects_an_impostor_or_replayed_reply() {
    let key = SessionKey::generate().expect("key");
    let record = HookRecord::default();
    let hello = Hello {
        v: PROTOCOL_VERSION,
        nonce: hex::encode([1u8; 32]),
    };
    let allow = serde_json::to_string(&HookReply::Allow { reason: "x".into() }).expect("json");

    // An impostor without the key can only guess a MAC.
    let impostor = Response {
        v: PROTOCOL_VERSION,
        body: allow.clone(),
        mac: hex::encode([0u8; 32]),
    };
    let mut stream = scripted(&[frame(&hello), frame(&impostor)]);
    assert!(matches!(
        client::exchange_on(&mut stream, "s", &key, &record),
        Err(kalcode_hook_bridge::BridgeError::BadReply)
    ));

    // A reply MACed for another exchange (other nonces) is refused.
    let replayed = Response {
        v: PROTOCOL_VERSION,
        body: allow.clone(),
        mac: wire::response_mac(&key, &hello.nonce, &hex::encode([2u8; 32]), &allow),
    };
    let mut stream = scripted(&[frame(&hello), frame(&replayed)]);
    assert!(client::exchange_on(&mut stream, "s", &key, &record).is_err());

    // The key never appears in what the helper writes.
    assert!(!String::from_utf8_lossy(&stream.written).contains(&key.to_hex()));

    // A server that doesn't speak the protocol is refused before anything is sent.
    let mut stream = scripted(&[frame(&Hello {
        v: 99,
        nonce: hello.nonce.clone(),
    })]);
    assert!(client::exchange_on(&mut stream, "s", &key, &record).is_err());
    assert!(stream.written.is_empty());
}

#[test]
fn unreachable_endpoint_blocks_pre_tool_use_and_is_silent_for_status() {
    let dir = tempfile::tempdir().expect("dir");
    let endpoint = Endpoint::generate(Some(dir.path())).expect("endpoint");
    let session = random_id().expect("id");
    let key = SessionKey::generate().expect("key").to_hex();
    let run = helper(
        &["claude", "PreToolUse", endpoint.as_str(), &session],
        Some(&key),
        BASH_LS,
        None,
    );
    assert_eq!(run.code, 2);
    assert!(run.stderr.contains("not reachable"), "{}", run.stderr);
    assert!(run.took < Duration::from_secs(10), "{:?}", run.took);

    for event in [
        "Stop",
        "SessionStart",
        "Notification",
        "PostToolUse",
        "PermissionRequest",
    ] {
        let run = helper(
            &["claude", event, endpoint.as_str(), &session],
            Some(&key),
            br#"{"session_id":"abc"}"#,
            None,
        );
        assert_eq!(run.code, 0, "{event}");
        assert!(run.stdout.is_empty() && run.stderr.is_empty(), "{event}");
    }
    let run = helper(
        &[
            "codex-notify",
            endpoint.as_str(),
            &session,
            r#"{"type":"agent-turn-complete"}"#,
        ],
        Some(&key),
        b"",
        None,
    );
    assert_eq!(run.code, 0);
}

#[test]
fn a_stalled_server_blocks_before_the_deadline() {
    let (_dir, server) = server();
    let handler = Fixed::slow(
        HookReply::Allow {
            reason: "late".into(),
        },
        Duration::from_secs(5),
    );
    let reg = server.register(handler).expect("register");
    let run = helper(
        &[
            "claude",
            "PreToolUse",
            server.endpoint().as_str(),
            reg.session_id(),
        ],
        Some(&reg.key_hex()),
        BASH_LS,
        Some(400),
    );
    assert_eq!(run.code, 2, "a late allow must not count");
    assert!(run.stdout.is_empty());
    assert!(run.took < Duration::from_secs(4), "{:?}", run.took);
}

#[test]
fn oversized_or_garbled_stdin_blocks_pre_tool_use() {
    let (_dir, server) = server();
    let handler = Fixed::new(HookReply::Allow {
        reason: "ok".into(),
    });
    let reg = server.register(handler.clone()).expect("register");
    let args = [
        "claude",
        "PreToolUse",
        server.endpoint().as_str(),
        reg.session_id(),
    ];
    let big = vec![b' '; 1024 * 1024 + 10];
    assert_eq!(helper(&args, Some(&reg.key_hex()), &big, None).code, 2);
    assert_eq!(
        helper(&args, Some(&reg.key_hex()), b"garbage", None).code,
        2
    );
    assert_eq!(handler.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn status_events_are_forwarded_filtered() {
    let (_dir, server) = server();
    let handler = Fixed::new(HookReply::Ack);
    let reg = server.register(handler.clone()).expect("register");
    let run = helper(
        &[
            "claude",
            "UserPromptSubmit",
            server.endpoint().as_str(),
            reg.session_id(),
        ],
        Some(&reg.key_hex()),
        br#"{"session_id":"abc","transcript_path":"/secret/path","prompt":"Refactor the parser"}"#,
        None,
    );
    assert_eq!(run.code, 0);
    assert!(run.stdout.is_empty());
    let seen = handler.seen.lock().expect("lock");
    assert_eq!(seen[0].prompt.as_deref(), Some("Refactor the parser"));
    assert!(
        !serde_json::to_string(&seen[0])
            .expect("json")
            .contains("/secret/path")
    );
}

#[cfg(windows)]
#[test]
fn a_taken_pipe_name_is_refused() {
    let (_dir, first) = server();
    let second = BridgeServer::start(ServerConfig::new(first.endpoint().clone()));
    assert!(
        second.is_err(),
        "FILE_FLAG_FIRST_PIPE_INSTANCE must refuse a squatted name"
    );
}

#[test]
fn shutdown_is_prompt_and_idempotent() {
    let (_dir, server) = server();
    let started = Instant::now();
    server.shutdown();
    server.shutdown();
    assert!(started.elapsed() < Duration::from_secs(2));
}
