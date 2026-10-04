//! The real `kalcode-hook` binary against the real bridge server: authentication, replay,
//! squatting, fail-closed and fail-open behaviour (docs/campaigns/Z7-W4-THREATS.md §4).

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Barrier, Condvar, Mutex};
use std::time::{Duration, Instant};

use kalcode_hook_bridge::client::{self, Stream};
use kalcode_hook_bridge::helper::ENFORCE_ARG;
use kalcode_hook_bridge::key::{SessionKey, random_id};
use kalcode_hook_bridge::server::{BridgeServer, HookChannel, HookGate, HookHandler, ServerConfig};
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

#[derive(Default)]
struct GateState {
    active: usize,
    max_active: usize,
    started: usize,
    released: bool,
}

#[derive(Default)]
struct Gated {
    state: Mutex<GateState>,
    changed: Condvar,
}

impl Gated {
    fn wait_started(&self, count: usize) {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut state = self.state.lock().expect("lock");
        while state.started < count {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(!remaining.is_zero(), "handler did not start");
            state = self.changed.wait_timeout(state, remaining).expect("wait").0;
        }
    }

    fn release(&self) {
        self.state.lock().expect("lock").released = true;
        self.changed.notify_all();
    }
}

impl HookHandler for Gated {
    fn handle(&self, _record: HookRecord) -> HookReply {
        let mut state = self.state.lock().expect("lock");
        state.active += 1;
        state.started += 1;
        state.max_active = state.max_active.max(state.active);
        self.changed.notify_all();
        while !state.released {
            state = self.changed.wait(state).expect("wait");
        }
        state.active -= 1;
        HookReply::Ack
    }
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
    hide_test_process(&mut command);
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

#[cfg(windows)]
fn hide_test_process(command: &mut Command) {
    use std::os::windows::process::CommandExt as _;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_test_process(_command: &mut Command) {}

const BASH_LS: &[u8] =
    br#"{"session_id":"abc","hook_event_name":"PreToolUse","tool_name":"Bash","tool_use_id":"toolu_1","tool_input":{"command":"ls"}}"#;

/// An enforcing `PreToolUse` (engine routing): KalCode is the decision point and fails closed.
fn pre_tool_use(server: &BridgeServer, session: &str, key: Option<&str>) -> Run {
    helper(
        &[
            "claude",
            "PreToolUse",
            server.endpoint().as_str(),
            session,
            ENFORCE_ARG,
        ],
        key,
        BASH_LS,
        None,
    )
}

/// An observing `PreToolUse` (every ordinary provider session).
fn observe_pre_tool_use(server: &BridgeServer, session: &str, key: Option<&str>) -> Run {
    helper(
        &["claude", "PreToolUse", server.endpoint().as_str(), session],
        key,
        BASH_LS,
        None,
    )
}

fn assert_left_to_the_provider(run: &Run) {
    assert_eq!(run.code, 0, "{}", run.stderr);
    assert!(run.stdout.is_empty(), "{}", run.stdout);
    assert!(run.stderr.is_empty(), "{}", run.stderr);
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
        let reg = server
            .register_channel(handler.clone(), HookChannel::Claude)
            .expect("register");
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
    let reg = server
        .register_channel(handler.clone(), HookChannel::Claude)
        .expect("register");
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
    let reg = server
        .register_channel(handler.clone(), HookChannel::Claude)
        .expect("register");
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

fn send_raw(server: &BridgeServer, reg: &kalcode_hook_bridge::server::Registration, body: &str) {
    let key = SessionKey::from_hex(&reg.key_hex()).expect("key");
    let mut stream = connect(server);
    let (_, request) = raw_request(stream.as_mut(), reg.session_id(), &key, body);
    wire::write_frame(stream.as_mut(), &request).expect("send");
    let mut rest = Vec::new();
    let _ = stream.read_to_end(&mut rest);
}

#[test]
fn authenticated_raw_records_must_match_the_filtered_record_contract() {
    let (_dir, server) = server();
    let handler = Fixed::new(HookReply::Ack);
    let reg = server
        .register_channel(handler.clone(), HookChannel::Claude)
        .expect("register");
    let oversized_id = "x".repeat(129);
    let oversized_input = "x".repeat(64 * 1024 + 1);
    let bodies = [
        serde_json::json!({"event": null}),
        serde_json::json!({"event": "PreToolUse", "toolName": oversized_id}),
        serde_json::json!({"event": "Stop", "prompt": "not valid for Stop"}),
        serde_json::json!({"event": "PreToolUse", "toolInput": {"command": oversized_input}}),
        serde_json::json!({"event": "CodexNotify", "toolName": "Bash"}),
    ];

    for body in bodies {
        send_raw(&server, &reg, &body.to_string());
    }

    assert_eq!(handler.calls.load(Ordering::SeqCst), 0);
    assert_eq!(server.stats().rejected_malformed, 5);
}

#[test]
fn registrations_reject_records_from_the_other_provider_channel() {
    let (_dir, server) = server();
    let handler = Fixed::new(HookReply::Ack);
    let claude = server
        .register_channel(handler.clone(), HookChannel::Claude)
        .expect("claude registration");
    let codex = server
        .register_channel(handler.clone(), HookChannel::Codex)
        .expect("codex registration");

    send_raw(
        &server,
        &claude,
        &serde_json::json!({
            "event": "CodexNotify",
            "providerSessionId": "0192f3c4-0000-7000-8000-000000000001",
            "codexType": "agent-turn-complete",
            "codexTurnId": "turn-1"
        })
        .to_string(),
    );
    send_raw(
        &server,
        &codex,
        &serde_json::json!({"event": "PreToolUse", "toolName": "Bash"}).to_string(),
    );
    send_raw(
        &server,
        &claude,
        &serde_json::json!({"event": "Stop"}).to_string(),
    );
    send_raw(
        &server,
        &codex,
        &serde_json::json!({
            "event": "CodexNotify",
            "providerSessionId": "0192f3c4-0000-7000-8000-000000000001",
            "codexType": "agent-turn-complete",
            "codexTurnId": "turn-1"
        })
        .to_string(),
    );

    assert_eq!(handler.calls.load(Ordering::SeqCst), 2);
    assert_eq!(server.stats().rejected_malformed, 2);
}

#[test]
fn cursor_channel_authenticates_only_its_bounded_lifecycle_records() {
    let (_dir, server) = server();
    let handler = Fixed::new(HookReply::Ack);
    let cursor = server
        .register_channel(handler.clone(), HookChannel::Cursor)
        .unwrap();
    let claude = server
        .register_channel(handler.clone(), HookChannel::Claude)
        .unwrap();
    let record = serde_json::json!({
        "event":"Cursor", "providerSessionId":"native-conversation",
        "cursor":{"event":"stop","generationId":"turn-1","model":"future-9","status":"completed"}
    })
    .to_string();
    send_raw(&server, &claude, &record);
    send_raw(
        &server,
        &cursor,
        &serde_json::json!({"event":"Stop"}).to_string(),
    );
    send_raw(&server, &cursor, &record);
    assert_eq!(handler.calls.load(Ordering::SeqCst), 1);
    assert_eq!(server.stats().rejected_malformed, 2);
}

#[test]
fn codex_notify_requires_a_canonical_thread_id_and_supported_type() {
    let (_dir, server) = server();
    let handler = Fixed::new(HookReply::Ack);
    let reg = server
        .register_channel(handler.clone(), HookChannel::Codex)
        .expect("codex registration");
    let id = "0192f3c4-0000-7000-8000-000000000001";

    for body in [
        serde_json::json!({"event": "CodexNotify", "codexType": "agent-turn-complete"}),
        serde_json::json!({"event": "CodexNotify", "providerSessionId": "not-a-uuid", "codexType": "agent-turn-complete"}),
        serde_json::json!({"event": "CodexNotify", "providerSessionId": id, "codexType": "unknown"}),
    ] {
        send_raw(&server, &reg, &body.to_string());
    }
    send_raw(
        &server,
        &reg,
        &serde_json::json!({"event": "CodexNotify", "providerSessionId": id, "codexType": "agent-turn-complete", "codexTurnId": "turn-1"}).to_string(),
    );

    assert_eq!(handler.calls.load(Ordering::SeqCst), 1);
    assert_eq!(server.stats().rejected_malformed, 3);
}

#[test]
fn status_rate_limits_are_per_registration() {
    let dir = tempfile::tempdir().expect("dir");
    let endpoint = Endpoint::generate(Some(dir.path())).expect("endpoint");
    let mut config = ServerConfig::new(endpoint);
    config.status_burst = 2;
    config.status_window = Duration::from_secs(60);
    let server = BridgeServer::start(config).expect("server");
    let first_handler = Fixed::new(HookReply::Ack);
    let second_handler = Fixed::new(HookReply::Ack);
    let first = server
        .register_channel(first_handler.clone(), HookChannel::Claude)
        .expect("first");
    let second = server
        .register_channel(second_handler.clone(), HookChannel::Claude)
        .expect("second");
    let body = serde_json::json!({"event": "Stop"}).to_string();

    send_raw(&server, &first, &body);
    send_raw(&server, &first, &body);
    send_raw(&server, &first, &body);
    send_raw(&server, &second, &body);

    assert_eq!(first_handler.calls.load(Ordering::SeqCst), 2);
    assert_eq!(second_handler.calls.load(Ordering::SeqCst), 1);
    assert_eq!(server.stats().rejected_rate, 1);
}

#[test]
fn handler_lifetime_limit_is_per_registration() {
    let dir = tempfile::tempdir().expect("dir");
    let endpoint = Endpoint::generate(Some(dir.path())).expect("endpoint");
    let mut config = ServerConfig::new(endpoint);
    config.max_connections = 4;
    config.max_handlers_per_session = 1;
    config.max_hold = Duration::from_millis(40);
    let server = BridgeServer::start(config).expect("server");
    let handler = Arc::new(Gated::default());
    let reg = server
        .register_channel(handler.clone(), HookChannel::Claude)
        .expect("register");
    let key = SessionKey::from_hex(&reg.key_hex()).expect("key");
    let record = HookRecord {
        event: Some(HookEvent::Stop),
        ..HookRecord::default()
    };

    let first_endpoint = server.endpoint().clone();
    let first_session = reg.session_id().to_owned();
    let first_key = key.clone();
    let first_record = record.clone();
    let first = std::thread::spawn(move || {
        client::exchange(
            &first_endpoint,
            &first_session,
            &first_key,
            &first_record,
            Instant::now() + Duration::from_secs(3),
        )
    });
    handler.wait_started(1);
    assert!(matches!(
        first.join().expect("first exchange"),
        Ok(HookReply::Ack)
    ));

    assert!(matches!(
        client::exchange(
            server.endpoint(),
            reg.session_id(),
            &key,
            &record,
            Instant::now() + Duration::from_secs(3),
        ),
        Ok(HookReply::Ack)
    ));
    let state = handler.state.lock().expect("lock");
    assert_eq!(state.started, 1);
    assert_eq!(state.max_active, 1);
    drop(state);
    assert_eq!(server.stats().rejected_busy, 1);
    handler.release();
}

#[test]
fn replayed_and_tampered_requests_are_rejected() {
    let (_dir, server) = server();
    let handler = Fixed::new(HookReply::Allow {
        reason: "ok".into(),
    });
    let reg = server
        .register_channel(handler.clone(), HookChannel::Claude)
        .expect("register");
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
        &[
            "claude",
            "PreToolUse",
            endpoint.as_str(),
            &session,
            ENFORCE_ARG,
        ],
        Some(&key),
        BASH_LS,
        None,
    );
    assert_eq!(run.code, 2);
    assert!(run.stderr.contains("not reachable"), "{}", run.stderr);
    assert!(run.took < Duration::from_secs(10), "{:?}", run.took);

    // KalCode closed, restarting or updating: an ordinary session's tool still runs, quickly.
    let run = helper(
        &["claude", "PreToolUse", endpoint.as_str(), &session],
        Some(&key),
        BASH_LS,
        None,
    );
    assert_left_to_the_provider(&run);
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
    let reg = server
        .register_channel(handler, HookChannel::Claude)
        .expect("register");
    let run = helper(
        &[
            "claude",
            "PreToolUse",
            server.endpoint().as_str(),
            reg.session_id(),
            ENFORCE_ARG,
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
fn timed_out_handlers_keep_their_concurrency_permit_until_they_exit() {
    let dir = tempfile::tempdir().expect("dir");
    let endpoint = Endpoint::generate(Some(dir.path())).expect("endpoint");
    let mut config = ServerConfig::new(endpoint);
    config.max_connections = 1;
    config.max_hold = Duration::from_millis(40);
    let server = BridgeServer::start(config).expect("server");
    let handler = Arc::new(Gated::default());
    let reg = server
        .register_channel(handler.clone(), HookChannel::Claude)
        .expect("register");
    let key = SessionKey::from_hex(&reg.key_hex()).expect("key");
    let record = HookRecord {
        event: Some(HookEvent::Stop),
        ..HookRecord::default()
    };

    let first_endpoint = server.endpoint().clone();
    let first_session = reg.session_id().to_owned();
    let first_key = key.clone();
    let first_record = record.clone();
    let first = std::thread::spawn(move || {
        client::exchange(
            &first_endpoint,
            &first_session,
            &first_key,
            &first_record,
            Instant::now() + Duration::from_secs(3),
        )
    });
    handler.wait_started(1);
    assert!(matches!(
        first.join().expect("first exchange"),
        Ok(HookReply::Ack)
    ));

    let _ = client::exchange(
        server.endpoint(),
        reg.session_id(),
        &key,
        &record,
        Instant::now() + Duration::from_secs(3),
    );
    let state = handler.state.lock().expect("lock");
    assert_eq!(
        state.started, 1,
        "timed-out work must still occupy capacity"
    );
    assert_eq!(state.max_active, 1);
    drop(state);
    handler.release();
}

#[test]
fn oversized_or_garbled_stdin_blocks_pre_tool_use() {
    let (_dir, server) = server();
    let handler = Fixed::new(HookReply::Allow {
        reason: "ok".into(),
    });
    let reg = server
        .register_channel(handler.clone(), HookChannel::Claude)
        .expect("register");
    let args = [
        "claude",
        "PreToolUse",
        server.endpoint().as_str(),
        reg.session_id(),
        ENFORCE_ARG,
    ];
    let big = vec![b' '; 1024 * 1024 + 10];
    assert_eq!(helper(&args, Some(&reg.key_hex()), &big, None).code, 2);
    assert_eq!(
        helper(&args, Some(&reg.key_hex()), b"garbage", None).code,
        2
    );
    // Observing: a huge Write or an unexpected payload never costs the person the tool call.
    let observing = &args[..4];
    assert_left_to_the_provider(&helper(observing, Some(&reg.key_hex()), &big, None));
    assert_left_to_the_provider(&helper(observing, Some(&reg.key_hex()), b"garbage", None));
    assert_eq!(handler.calls.load(Ordering::SeqCst), 0);
}

/// The reported bug: every tool (shell, file, search, MCP, web research) failed inside KalCode
/// whenever its hook channel hiccupped. An observing session never loses a tool call to a
/// KalCode-side failure; explicit KalCode decisions still pass through.
#[test]
fn observing_sessions_never_lose_tool_calls_to_kalcode_failures() {
    let (_dir, server) = server();
    let handler = Fixed::new(HookReply::NoDecision);
    let reg = server
        .register_channel_with(handler.clone(), HookChannel::Claude, HookGate::Observe)
        .expect("register");
    let key = reg.key_hex();
    // Healthy: recorded, no decision.
    assert_left_to_the_provider(&observe_pre_tool_use(&server, reg.session_id(), Some(&key)));
    assert_eq!(handler.calls.load(Ordering::SeqCst), 1);
    // Missing or wrong key, unknown or revoked session (KalCode restarted, pane restored).
    assert_left_to_the_provider(&observe_pre_tool_use(&server, reg.session_id(), None));
    let wrong = SessionKey::generate().expect("key").to_hex();
    assert_left_to_the_provider(&observe_pre_tool_use(
        &server,
        reg.session_id(),
        Some(&wrong),
    ));
    let unknown = random_id().expect("id");
    assert_left_to_the_provider(&observe_pre_tool_use(&server, &unknown, Some(&key)));
    let session = reg.session_id().to_owned();
    drop(reg);
    assert_left_to_the_provider(&observe_pre_tool_use(&server, &session, Some(&key)));

    // A stalled KalCode costs at most the short status deadline, never a blocked tool.
    let slow = Fixed::slow(HookReply::NoDecision, Duration::from_secs(8));
    let reg = server
        .register_channel_with(slow, HookChannel::Claude, HookGate::Observe)
        .expect("register");
    let run = observe_pre_tool_use(&server, reg.session_id(), Some(&reg.key_hex()));
    assert_left_to_the_provider(&run);
    assert!(run.took < Duration::from_secs(6), "{:?}", run.took);

    // An explicit decision still renders.
    let deny = Fixed::new(HookReply::Deny {
        reason: "Refused by KalCode policy".into(),
    });
    let reg = server
        .register_channel_with(deny, HookChannel::Claude, HookGate::Observe)
        .expect("register");
    let run = observe_pre_tool_use(&server, reg.session_id(), Some(&reg.key_hex()));
    assert_eq!(run.code, 2);
}

/// Parallel tool calls (research fans out) beyond the per-session handler limit get no decision
/// in an observing session, never a KalCode-forced prompt.
#[test]
fn a_busy_observing_session_forces_no_prompt() {
    let dir = tempfile::tempdir().expect("dir");
    let endpoint = Endpoint::generate(Some(dir.path())).expect("endpoint");
    let mut config = ServerConfig::new(endpoint);
    config.max_handlers_per_session = 1;
    let server = BridgeServer::start(config).expect("server");
    let handler = Arc::new(Gated::default());
    let reg = server
        .register_channel_with(handler.clone(), HookChannel::Claude, HookGate::Observe)
        .expect("register");
    let key = SessionKey::from_hex(&reg.key_hex()).expect("key");
    let record = HookRecord {
        event: Some(HookEvent::PreToolUse),
        tool_name: Some("WebSearch".into()),
        ..HookRecord::default()
    };
    let first_endpoint = server.endpoint().clone();
    let first_session = reg.session_id().to_owned();
    let first_key = key.clone();
    let first_record = record.clone();
    let first = std::thread::spawn(move || {
        client::exchange(
            &first_endpoint,
            &first_session,
            &first_key,
            &first_record,
            Instant::now() + Duration::from_secs(3),
        )
    });
    handler.wait_started(1);
    let second = client::exchange(
        server.endpoint(),
        reg.session_id(),
        &key,
        &record,
        Instant::now() + Duration::from_secs(3),
    )
    .expect("second exchange");
    assert_eq!(second, HookReply::NoDecision);
    handler.release();
    let _ = first.join();
}

#[test]
fn status_events_are_forwarded_filtered() {
    let (_dir, server) = server();
    let handler = Fixed::new(HookReply::Ack);
    let reg = server
        .register_channel(handler.clone(), HookChannel::Claude)
        .expect("register");
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
fn checked_shutdown_is_concurrent_idempotent_and_releases_the_endpoint() {
    let (dir, server) = server();
    let endpoint = server.endpoint().clone();
    let server = Arc::new(server);
    let ready = Arc::new(Barrier::new(9));
    let callers: Vec<_> = (0..8)
        .map(|_| {
            let server = server.clone();
            let ready = ready.clone();
            std::thread::spawn(move || {
                ready.wait();
                server.shutdown_checked()
            })
        })
        .collect();
    let started = Instant::now();
    ready.wait();
    for caller in callers {
        caller.join().expect("shutdown caller").expect("shutdown");
    }
    server.shutdown_checked().expect("repeat shutdown");
    assert!(started.elapsed() < Duration::from_secs(2));

    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let path = endpoint.path();
        let parent = path.parent().expect("private socket directory");
        assert!(!path.exists(), "shutdown removes the socket");
        assert!(!parent.exists(), "shutdown removes its private directory");
        // Recreate only the fixture's private directory before reusing the exact socket address.
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(parent)
            .expect("fresh private directory for endpoint rebind");
    }
    let rebound = BridgeServer::start(ServerConfig::new(endpoint)).expect("endpoint released");
    rebound.shutdown_checked().expect("rebound shutdown");
    drop(dir);
}
