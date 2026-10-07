//! End-to-end sessions over in-memory pipes: the real responder ([`server::accept`] +
//! [`server::serve_connection`]) against the real initiator ([`client::connect`]).

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::future::Future;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use kalcode_remote::client::{self, ClientConnection};
use kalcode_remote::limits::Limits;
use kalcode_remote::noise::{self, StaticKeypair};
use kalcode_remote::pairing::{Clock, Pairing};
use kalcode_remote::registry::{Device, Registry};
use kalcode_remote::server::{self, CloseReason, HostIdentity, Hub, RemoteHost};
use kalcode_remote::transport;
use kalcode_remote::wire::{
    ByeReason, DeviceHello, DeviceMessage, ErrorCode, HandshakeReply, HostBuild, HostMessage,
    Notification, NotifyKind, PairingPayload, RejectReason, RemoteError, RemoteService,
    RemoteState, Workstation,
};
use kalcode_remote::{Error, ops};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, DuplexStream};
use tokio::sync::Semaphore;
use tokio::task::JoinHandle;

// ---- fixtures -------------------------------------------------------------------------------

struct TestHost {
    state: Mutex<RemoteState>,
    /// Operations the host was asked to run.
    calls: AtomicUsize,
    /// `agent.retry` waits on this gate, then counts as executed.
    gate: Arc<Semaphore>,
    executed: Arc<AtomicUsize>,
}

impl TestHost {
    fn set_service(&self, id: &str, status: &str) {
        let mut state = self.state.lock().unwrap();
        state.services.retain(|s| s.id != id);
        state.services.push(RemoteService {
            id: id.into(),
            name: id.into(),
            status: status.into(),
            url: None,
        });
    }
}

impl RemoteHost for TestHost {
    fn snapshot(&self) -> RemoteState {
        self.state.lock().unwrap().clone()
    }

    fn handle(
        &self,
        _device: &Device,
        op: &str,
        args: Value,
    ) -> impl Future<Output = Result<Value, RemoteError>> + Send {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let op = op.to_owned();
        let (gate, executed) = (self.gate.clone(), self.executed.clone());
        async move {
            match op.as_str() {
                ops::AGENT_RETRY => {
                    let _permit = gate.acquire().await.unwrap();
                    executed.fetch_add(1, Ordering::SeqCst);
                    Ok(json!({"summary": "Retried"}))
                }
                ops::AGENT_STOP => {
                    // Slow enough that a repeat arrives while it is still running.
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    Ok(
                        json!({"summary": format!("Stopped {}", args["agentId"].as_str().unwrap_or("?"))}),
                    )
                }
                ops::AGENT_DIFF => {
                    Ok(json!({"files": [], "truncated": false, "pad": "d".repeat(1024 * 1024)}))
                }
                _ => Err(RemoteError::not_found("This agent has finished")),
            }
        }
    }
}

struct FakeClock(AtomicI64);
impl Clock for FakeClock {
    fn now_unix(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

struct Env {
    _dir: tempfile::TempDir,
    identity: HostIdentity,
    registry: Arc<Registry>,
    pairing: Arc<Pairing>,
    clock: Arc<FakeClock>,
    hub: Hub,
    host: Arc<TestHost>,
    entitled: bool,
}

fn env() -> Env {
    env_with(Limits::default())
}

fn env_with(limits: Limits) -> Env {
    let dir = tempfile::tempdir().unwrap();
    let registry = Arc::new(Registry::open(dir.path().join("remote-devices.json")).unwrap());
    let clock = Arc::new(FakeClock(AtomicI64::new(kalcode_remote_now())));
    let state = RemoteState {
        workstation: Workstation {
            id: "ws_test".into(),
            name: "Test Workstation".into(),
            platform: "windows".into(),
            version: "0.1.9".into(),
            build: 2007,
            active_workspace_id: None,
        },
        workspaces: vec![],
        agents: vec![],
        needs_you: vec![],
        runs: vec![],
        services: vec![],
        environments: vec![],
    };
    Env {
        _dir: dir,
        identity: HostIdentity {
            key: StaticKeypair::generate().unwrap(),
            workstation_id: "ws_test".into(),
            name: "Test Workstation".into(),
            build: HostBuild {
                platform: "windows".into(),
                version: "0.1.9".into(),
                build: 2007,
            },
        },
        registry,
        pairing: Arc::new(Pairing::with_clock(clock.clone())),
        clock,
        hub: Hub::with_limits(limits),
        host: Arc::new(TestHost {
            state: Mutex::new(state),
            calls: AtomicUsize::new(0),
            gate: Arc::new(Semaphore::new(0)),
            executed: Arc::new(AtomicUsize::new(0)),
        }),
        entitled: true,
    }
}

fn kalcode_remote_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn hello(pair: Option<&str>) -> DeviceHello {
    DeviceHello {
        v: 1,
        device: "Test iPhone".into(),
        platform: "ios".into(),
        model: "iPhone17,1".into(),
        app: "1.0 (1)".into(),
        pair: pair.map(str::to_owned),
        ts: kalcode_remote_now(),
    }
}

/// Starts accept + serve on one end of a pipe; returns the other end and the server task.
fn serve(env: &Env) -> (DuplexStream, JoinHandle<Result<CloseReason, Error>>) {
    serve_piped(env, 4 << 20)
}

/// [`serve`] over a pipe that buffers `capacity` bytes per direction.
fn serve_piped(
    env: &Env,
    capacity: usize,
) -> (DuplexStream, JoinHandle<Result<CloseReason, Error>>) {
    let (device_end, host_end) = tokio::io::duplex(capacity);
    let (identity, registry, pairing, hub, host, entitled) = (
        env.identity.clone(),
        env.registry.clone(),
        env.pairing.clone(),
        env.hub.clone(),
        env.host.clone(),
        env.entitled,
    );
    let task = tokio::spawn(async move {
        let conn = server::accept(host_end, &identity, &registry, &pairing, entitled).await?;
        server::serve_connection(conn, host, &hub, &registry).await
    });
    (device_end, task)
}

async fn connect(
    env: &Env,
    device: &StaticKeypair,
    pair: Option<&str>,
) -> Result<ClientConnection<DuplexStream>, Error> {
    let (stream, _task) = serve(env);
    client::connect(stream, device, env.identity.key.public(), &hello(pair)).await
}

/// Pairs a fresh device and returns its key plus an open, snapshot-drained session.
async fn paired(env: &Env) -> (StaticKeypair, ClientConnection<DuplexStream>) {
    let (device, conn, _task) = paired_piped(env, 4 << 20).await;
    (device, conn)
}

/// [`paired`] over a pipe of `capacity` bytes, also returning the server task.
async fn paired_piped(
    env: &Env,
    capacity: usize,
) -> (
    StaticKeypair,
    ClientConnection<DuplexStream>,
    JoinHandle<Result<CloseReason, Error>>,
) {
    let device = StaticKeypair::generate().unwrap();
    let ticket = env.pairing.open().unwrap();
    let (stream, task) = serve_piped(env, capacity);
    let mut conn = client::connect(
        stream,
        &device,
        env.identity.key.public(),
        &hello(Some(&ticket.code)),
    )
    .await
    .unwrap();
    assert!(matches!(
        recv(&mut conn).await,
        HostMessage::Snapshot { rev: 1, .. }
    ));
    (device, conn, task)
}

/// Reconnects an already paired device; returns the snapshot-drained session and its task.
async fn reconnect(
    env: &Env,
    device: &StaticKeypair,
) -> (
    ClientConnection<DuplexStream>,
    JoinHandle<Result<CloseReason, Error>>,
) {
    let (stream, task) = serve(env);
    let mut conn = client::connect(stream, device, env.identity.key.public(), &hello(None))
        .await
        .unwrap();
    assert!(matches!(
        recv(&mut conn).await,
        HostMessage::Snapshot { .. }
    ));
    (conn, task)
}

async fn finished(
    task: JoinHandle<Result<CloseReason, Error>>,
    within: Duration,
) -> Result<CloseReason, Error> {
    tokio::time::timeout(within, task)
        .await
        .expect("the connection ended in time")
        .unwrap()
}

/// Collects `n` responses, keyed by request id.
async fn responses(
    conn: &mut ClientConnection<DuplexStream>,
    n: usize,
) -> std::collections::HashMap<String, kalcode_remote::wire::Response> {
    let mut all = std::collections::HashMap::new();
    while all.len() < n {
        if let HostMessage::Res(res) = recv(conn).await {
            all.insert(res.id.clone(), res);
        }
    }
    all
}

async fn recv(conn: &mut ClientConnection<DuplexStream>) -> HostMessage {
    tokio::time::timeout(Duration::from_secs(5), conn.recv())
        .await
        .expect("message in time")
        .unwrap()
}

async fn request(conn: &mut ClientConnection<DuplexStream>, id: &str, op: &str, args: Value) {
    conn.send(&DeviceMessage::Req {
        id: id.into(),
        op: op.into(),
        args,
    })
    .await
    .unwrap();
}

// ---- handshake and pairing ------------------------------------------------------------------

#[tokio::test]
async fn pairing_handshake_succeeds_and_both_sides_agree() {
    let env = env();
    let device = StaticKeypair::generate().unwrap();
    let ticket = env.pairing.open().unwrap();
    let (device_end, host_end) = tokio::io::duplex(1 << 20);
    let (identity, registry, pairing) = (
        env.identity.clone(),
        env.registry.clone(),
        env.pairing.clone(),
    );
    let server = tokio::spawn(async move {
        server::accept(host_end, &identity, &registry, &pairing, true).await
    });
    let conn = client::connect(
        device_end,
        &device,
        env.identity.key.public(),
        &hello(Some(&ticket.code)),
    )
    .await
    .unwrap();
    let accepted = server.await.unwrap().unwrap();

    assert_eq!(conn.accepted.wid, "ws_test");
    assert_eq!(conn.accepted.host.build, 2007);
    assert_eq!(conn.accepted.device_id, accepted.device.id);
    assert!(accepted.device.id.starts_with("dev_"));
    assert_eq!(conn.handshake_hash, accepted.handshake_hash);
    assert_eq!(conn.handshake_hash.len(), 32);
    let stored = env.registry.get(&accepted.device.id).unwrap();
    assert_eq!(stored.public_key, device.public_base64());
    assert_eq!(stored.name, "Test iPhone");
    assert!(!env.pairing.is_open(), "the code is burnt");
}

#[tokio::test]
async fn paired_device_reconnects_without_a_code() {
    let env = env();
    let (device, _first) = paired(&env).await;
    let mut again = connect(&env, &device, None).await.unwrap();
    assert!(matches!(
        recv(&mut again).await,
        HostMessage::Snapshot { rev: 1, .. }
    ));
    assert_eq!(env.registry.list().len(), 1);
}

#[tokio::test]
async fn wrong_host_key_fails() {
    let env = env();
    let device = StaticKeypair::generate().unwrap();
    let ticket = env.pairing.open().unwrap();
    let impostor = StaticKeypair::generate().unwrap();
    let (stream, task) = serve(&env);
    let result = client::connect(
        stream,
        &device,
        impostor.public(),
        &hello(Some(&ticket.code)),
    )
    .await;
    assert!(matches!(result, Err(Error::Closed)), "{result:?}");
    assert!(matches!(task.await.unwrap(), Err(Error::Noise(_))));
    assert!(env.registry.list().is_empty());
    assert!(env.pairing.is_open(), "a failed handshake spends nothing");
}

#[tokio::test]
async fn unpaired_device_is_rejected() {
    let env = env();
    let device = StaticKeypair::generate().unwrap();
    let (stream, task) = serve(&env);
    let result = client::connect(stream, &device, env.identity.key.public(), &hello(None)).await;
    assert!(
        matches!(result, Err(Error::Rejected(RejectReason::Unpaired))),
        "{result:?}"
    );
    assert!(matches!(
        task.await.unwrap(),
        Err(Error::Rejected(RejectReason::Unpaired))
    ));
    assert!(env.registry.list().is_empty());
}

#[tokio::test]
async fn pairing_code_is_single_use() {
    let env = env();
    let ticket = env.pairing.open().unwrap();
    let first = StaticKeypair::generate().unwrap();
    let mut live = connect(&env, &first, Some(&ticket.code)).await.unwrap();
    // The snapshot means the pairing was committed (after hello).
    assert!(matches!(
        recv(&mut live).await,
        HostMessage::Snapshot { .. }
    ));
    let second = StaticKeypair::generate().unwrap();
    let result = connect(&env, &second, Some(&ticket.code)).await;
    assert!(
        matches!(result, Err(Error::Rejected(RejectReason::PairingExpired))),
        "{result:?}"
    );
    assert_eq!(env.registry.list().len(), 1);
}

#[tokio::test]
async fn pairing_code_expires_after_five_minutes() {
    let env = env();
    let ticket = env.pairing.open().unwrap();
    env.clock.0.fetch_add(5 * 60, Ordering::SeqCst);
    let device = StaticKeypair::generate().unwrap();
    let result = connect(&env, &device, Some(&ticket.code)).await;
    assert!(
        matches!(result, Err(Error::Rejected(RejectReason::PairingExpired))),
        "{result:?}"
    );
    let wrong = connect(&env, &device, Some("AAAA")).await;
    assert!(
        matches!(wrong, Err(Error::Rejected(RejectReason::PairingExpired))),
        "{wrong:?}"
    );
}

#[tokio::test]
async fn not_entitled_is_rejected_without_spending_the_code() {
    let mut env = env();
    env.entitled = false;
    let ticket = env.pairing.open().unwrap();
    let device = StaticKeypair::generate().unwrap();
    let result = connect(&env, &device, Some(&ticket.code)).await;
    assert!(
        matches!(result, Err(Error::Rejected(RejectReason::NotEntitled))),
        "{result:?}"
    );
    assert!(env.pairing.is_open());
}

#[tokio::test]
async fn wrong_protocol_version_is_rejected() {
    let env = env();
    let device = StaticKeypair::generate().unwrap();
    let (stream, _task) = serve(&env);
    let mut old = hello(None);
    old.v = 2;
    let result = client::connect(stream, &device, env.identity.key.public(), &old).await;
    assert!(
        matches!(result, Err(Error::Rejected(RejectReason::Version))),
        "{result:?}"
    );
}

#[tokio::test]
async fn busy_rejection() {
    let env = env();
    let device = StaticKeypair::generate().unwrap();
    let (device_end, host_end) = tokio::io::duplex(1 << 16);
    let identity = env.identity.clone();
    tokio::spawn(async move { server::reject(host_end, &identity, RejectReason::Busy).await });
    let result =
        client::connect(device_end, &device, env.identity.key.public(), &hello(None)).await;
    assert!(
        matches!(result, Err(Error::Rejected(RejectReason::Busy))),
        "{result:?}"
    );
}

#[tokio::test]
async fn revoked_device_is_disconnected_and_then_refused() {
    let env = env();
    let (device, mut live) = paired(&env).await;
    let id = live.accepted.device_id.clone();
    assert!(env.registry.revoke(&id).unwrap());
    assert_eq!(
        recv(&mut live).await,
        HostMessage::Bye {
            reason: ByeReason::Revoked
        }
    );
    assert!(matches!(live.recv().await, Err(Error::Closed)));

    let result = connect(&env, &device, None).await;
    assert!(
        matches!(result, Err(Error::Rejected(RejectReason::Revoked))),
        "{result:?}"
    );
    // Even with a fresh valid code: the key stays revoked.
    let ticket = env.pairing.open().unwrap();
    let result = connect(&env, &device, Some(&ticket.code)).await;
    assert!(
        matches!(result, Err(Error::Rejected(RejectReason::Revoked))),
        "{result:?}"
    );
    assert!(env.registry.get(&id).unwrap().revoked);
}

#[tokio::test]
async fn replayed_first_message_cannot_complete_a_session() {
    let env = env();
    let (device, _live) = paired(&env).await;
    let device_id = env.registry.list()[0].id.clone();
    let seen_before = env.registry.get(&device_id).unwrap().last_seen_at;

    // A legitimate connection; an eavesdropper records its first handshake frame.
    let (mut stream, _task) = serve(&env);
    let mut handshake = noise::initiator(&device, env.identity.key.public()).unwrap();
    let payload = serde_json::to_vec(&hello(None)).unwrap();
    let first = transport::write_handshake(&mut stream, &mut handshake, &payload)
        .await
        .unwrap();
    transport::read_handshake(&mut stream, &mut handshake)
        .await
        .unwrap();

    // The attacker replays it on a new connection.
    let (mut attacker, task) = serve(&env);
    transport::write_frame(&mut attacker, &first).await.unwrap();
    let mut reply = Vec::new();
    transport::read_frame(&mut attacker, &mut reply)
        .await
        .unwrap();
    // Without the device's ephemeral private key the reply cannot be read: a fresh initiator
    // state (new ephemeral) fails to decrypt it.
    let mut fresh = noise::initiator(&device, env.identity.key.public()).unwrap();
    let mut scratch = vec![0u8; 65535];
    let mut throwaway = vec![0u8; 65535];
    let _ = fresh.write_message(&payload, &mut throwaway).unwrap();
    assert!(fresh.read_message(&reply, &mut scratch).is_err());
    // Anything the attacker sends next fails authentication, so the host never yields a session.
    transport::write_frame(&mut attacker, &[0u8; 40])
        .await
        .unwrap();
    let result = task.await.unwrap();
    assert!(matches!(result, Err(Error::Noise(_))), "{result:?}");
    // The legitimate device was not marked seen by the replay.
    let seen_after_replay = env.registry.get(&device_id).unwrap().last_seen_at;
    assert_eq!(seen_before, seen_after_replay);
}

// ---- the connection loop --------------------------------------------------------------------

#[tokio::test]
async fn snapshot_patch_request_ping_notify_and_bye() {
    let env = env();
    env.host.set_service("web", "running");
    let (_device, mut conn) = paired(&env).await;

    // A burst of changes becomes one patch.
    env.host.set_service("web", "stopped");
    env.hub.state_changed();
    env.host.set_service("api", "running");
    env.hub.state_changed();
    let HostMessage::Patch(patch) = recv(&mut conn).await else {
        panic!("expected a patch")
    };
    assert_eq!(patch.rev, 2);
    let mut ids: Vec<_> = patch
        .upsert
        .services
        .iter()
        .map(|s| (s.id.as_str(), s.status.as_str()))
        .collect();
    ids.sort_unstable();
    assert_eq!(ids, [("api", "running"), ("web", "stopped")]);

    // A signal without a change sends nothing; the next real change is rev 3.
    env.hub.state_changed();
    tokio::time::sleep(Duration::from_millis(300)).await;
    env.host
        .state
        .lock()
        .unwrap()
        .services
        .retain(|s| s.id != "web");
    env.hub.state_changed();
    let HostMessage::Patch(patch) = recv(&mut conn).await else {
        panic!("expected a patch")
    };
    assert_eq!(
        (patch.rev, patch.remove.services.clone()),
        (3, vec!["web".to_owned()])
    );

    request(
        &mut conn,
        "r1",
        ops::AGENT_STOP,
        json!({"agentId": "thr_1"}),
    )
    .await;
    conn.send(&DeviceMessage::Ping { n: 7 }).await.unwrap();
    // The ping is answered while the slow request is still running.
    assert_eq!(recv(&mut conn).await, HostMessage::Pong { n: 7 });
    let HostMessage::Res(res) = recv(&mut conn).await else {
        panic!("expected res")
    };
    assert_eq!((res.id.as_str(), res.ok), ("r1", true));
    assert_eq!(res.result.unwrap()["summary"], "Stopped thr_1");

    request(
        &mut conn,
        "r2",
        ops::AGENT_DETAIL,
        json!({"agentId": "thr_gone"}),
    )
    .await;
    let HostMessage::Res(res) = recv(&mut conn).await else {
        panic!("expected res")
    };
    assert!(!res.ok);
    assert_eq!(res.error.unwrap().code, ErrorCode::NotFound);

    // Ops outside the allowlist never reach the host.
    let calls = env.host.calls.load(Ordering::SeqCst);
    request(&mut conn, "r3", "shell.exec", json!({"cmd": "rm -rf /"})).await;
    let HostMessage::Res(res) = recv(&mut conn).await else {
        panic!("expected res")
    };
    assert_eq!(res.error.unwrap().code, ErrorCode::Invalid);
    assert_eq!(env.host.calls.load(Ordering::SeqCst), calls);

    let note = Notification {
        id: "n1".into(),
        kind: NotifyKind::NeedsYou,
        title: "Approval needed".into(),
        body: "Run cargo test?".into(),
        link: "kalcode-remote://needs/approval:apr_1".into(),
    };
    assert!(env.hub.notify(note.clone(), Some("thr_1")));
    assert!(
        !env.hub.notify(note.clone(), Some("thr_1")),
        "coalesced per agent for 10 s"
    );
    assert_eq!(recv(&mut conn).await, HostMessage::Notify(note));

    env.hub.close_all(ByeReason::Shutdown);
    assert_eq!(
        recv(&mut conn).await,
        HostMessage::Bye {
            reason: ByeReason::Shutdown
        }
    );
}

#[tokio::test]
async fn repeated_request_ids_run_once() {
    let env = env();
    let (device, mut conn) = paired(&env).await;
    let before = env.host.calls.load(Ordering::SeqCst);

    // A repeat while the first is still running is a conflict (no second run, no waiter);
    // a repeat after it finished gets the stored result.
    request(
        &mut conn,
        "dup",
        ops::AGENT_STOP,
        json!({"agentId": "thr_9"}),
    )
    .await;
    request(
        &mut conn,
        "dup",
        ops::AGENT_STOP,
        json!({"agentId": "thr_9"}),
    )
    .await;
    let HostMessage::Res(conflict) = recv(&mut conn).await else {
        panic!("expected res")
    };
    assert_eq!(conflict.id, "dup");
    assert_eq!(conflict.error.unwrap().code, ErrorCode::Conflict);
    let HostMessage::Res(a) = recv(&mut conn).await else {
        panic!("expected res")
    };
    assert!(a.ok);
    request(
        &mut conn,
        "dup",
        ops::AGENT_STOP,
        json!({"agentId": "thr_9"}),
    )
    .await;
    let HostMessage::Res(b) = recv(&mut conn).await else {
        panic!("expected res")
    };
    assert_eq!(a, b);

    // And after a reconnect (offline queue resend keeps the id).
    drop(conn);
    let mut again = connect(&env, &device, None).await.unwrap();
    assert!(matches!(
        recv(&mut again).await,
        HostMessage::Snapshot { .. }
    ));
    request(
        &mut again,
        "dup",
        ops::AGENT_STOP,
        json!({"agentId": "thr_9"}),
    )
    .await;
    let HostMessage::Res(c) = recv(&mut again).await else {
        panic!("expected res")
    };
    assert_eq!(a, c);
    assert_eq!(env.host.calls.load(Ordering::SeqCst) - before, 1);
}

#[tokio::test]
async fn one_mebibyte_result_crosses_the_session() {
    let env = env();
    let (_device, mut conn) = paired(&env).await;
    request(
        &mut conn,
        "big",
        ops::AGENT_DIFF,
        json!({"agentId": "thr_1"}),
    )
    .await;
    let HostMessage::Res(res) = recv(&mut conn).await else {
        panic!("expected res")
    };
    assert_eq!(
        res.result.unwrap()["pad"].as_str().unwrap().len(),
        1024 * 1024
    );
}

#[tokio::test]
async fn malformed_request_gets_an_invalid_answer() {
    let env = env();
    let (_device, mut conn) = paired(&env).await;
    conn.writer
        .send(&json!({"t": "req", "id": "bad", "op": 5}))
        .await
        .unwrap();
    let HostMessage::Res(res) = recv(&mut conn).await else {
        panic!("expected res")
    };
    assert_eq!(
        (res.id.as_str(), res.error.unwrap().code),
        ("bad", ErrorCode::Invalid)
    );
    // Unknown message types are ignored; the session continues.
    conn.writer
        .send(&json!({"t": "future-thing"}))
        .await
        .unwrap();
    conn.send(&DeviceMessage::Ping { n: 1 }).await.unwrap();
    assert_eq!(recv(&mut conn).await, HostMessage::Pong { n: 1 });
}

#[tokio::test]
async fn peer_close_ends_the_connection() {
    let env = env();
    let device = StaticKeypair::generate().unwrap();
    let ticket = env.pairing.open().unwrap();
    let (stream, task) = serve(&env);
    let conn = client::connect(
        stream,
        &device,
        env.identity.key.public(),
        &hello(Some(&ticket.code)),
    )
    .await
    .unwrap();
    drop(conn);
    let reason = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(reason, CloseReason::PeerClosed);
}

// ---- hardening ------------------------------------------------------------------------------

/// Runs an accept loop the way the desktop does: admission before any read.
async fn listener(env: &Env) -> std::net::SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (identity, registry, pairing, hub) = (
        env.identity.clone(),
        env.registry.clone(),
        env.pairing.clone(),
        env.hub.clone(),
    );
    tokio::spawn(async move {
        loop {
            let (tcp, peer) = listener.accept().await.unwrap();
            let Some(permit) = hub.admit(peer.ip()) else {
                drop(tcp);
                continue;
            };
            let (identity, registry, pairing) =
                (identity.clone(), registry.clone(), pairing.clone());
            tokio::spawn(async move {
                let _ = server::accept(tcp, &identity, &registry, &pairing, true).await;
                drop(permit);
            });
        }
    });
    addr
}

#[tokio::test]
async fn handshakes_over_the_per_ip_limit_are_dropped_without_noise_work() {
    let env = env();
    let addr = listener(&env).await;
    // Four silent handshakes from one address hold every per-IP slot.
    let mut held = Vec::new();
    for _ in 0..4 {
        held.push(tokio::net::TcpStream::connect(addr).await.unwrap());
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    // The fifth is closed at once: EOF, not a single byte of Noise.
    let mut fifth = tokio::net::TcpStream::connect(addr).await.unwrap();
    let mut buf = [0u8; 1];
    let read = tokio::time::timeout(Duration::from_secs(2), fifth.read(&mut buf))
        .await
        .expect("dropped promptly");
    assert!(matches!(read, Ok(0) | Err(_)), "{read:?}");
    // Freeing one slot admits the next handshake, which completes normally.
    drop(held.pop());
    tokio::time::sleep(Duration::from_millis(100)).await;
    let device = StaticKeypair::generate().unwrap();
    let ticket = env.pairing.open().unwrap();
    let tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
    client::connect(
        tcp,
        &device,
        env.identity.key.public(),
        &hello(Some(&ticket.code)),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn the_33rd_pending_handshake_is_dropped() {
    let env = env();
    let held: Vec<_> = (0..32u8)
        .map(|n| {
            let ip = IpAddr::V4(Ipv4Addr::new(10, 0, n / 4, 1 + n % 4));
            env.hub.admit(ip).expect("under the limit")
        })
        .collect();
    assert!(
        env.hub
            .admit(IpAddr::V4(Ipv4Addr::new(10, 9, 9, 9)))
            .is_none()
    );
    drop(held);
    assert!(
        env.hub
            .admit(IpAddr::V4(Ipv4Addr::new(10, 9, 9, 9)))
            .is_some()
    );
}

fn fast_limits() -> Limits {
    Limits {
        write_timeout: Duration::from_millis(300),
        ..Limits::default()
    }
}

#[tokio::test]
async fn a_device_that_never_reads_is_disconnected() {
    let env = env_with(fast_limits());
    let (_device, mut conn, task) = paired_piped(&env, 64 * 1024).await;
    // Ask for a few 1 MiB results and never read them.
    for i in 0..3 {
        request(
            &mut conn,
            &format!("big{i}"),
            ops::AGENT_DIFF,
            json!({"agentId": "thr_1"}),
        )
        .await;
    }
    let result = finished(task, Duration::from_secs(5)).await;
    assert!(matches!(result, Err(Error::PeerStalled)), "{result:?}");
}

#[tokio::test]
async fn revocation_closes_a_non_reading_session_within_the_bound() {
    let env = env_with(Limits {
        write_timeout: Duration::from_secs(1),
        ..Limits::default()
    });
    let (_device, mut conn, task) = paired_piped(&env, 64 * 1024).await;
    request(
        &mut conn,
        "big",
        ops::AGENT_DIFF,
        json!({"agentId": "thr_1"}),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let started = Instant::now();
    assert!(env.registry.revoke(&conn.accepted.device_id).unwrap());
    let result = finished(task, Duration::from_secs(5)).await;
    assert_eq!(result.unwrap(), CloseReason::Bye(ByeReason::Revoked));
    assert!(
        started.elapsed() < Duration::from_millis(2500),
        "closed after {:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn revoking_cancels_running_operations() {
    let env = env();
    let (_device, mut conn, task) = paired_piped(&env, 4 << 20).await;
    let device_id = conn.accepted.device_id.clone();
    for i in 0..5 {
        request(
            &mut conn,
            &format!("q{i}"),
            ops::AGENT_RETRY,
            json!({"agentId": "thr_1"}),
        )
        .await;
    }
    // Every request reached the host and is parked on the gate.
    let deadline = Instant::now() + Duration::from_secs(5);
    while env.host.calls.load(Ordering::SeqCst) < 5 {
        assert!(Instant::now() < deadline, "requests did not start");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(env.registry.revoke(&device_id).unwrap());
    assert_eq!(
        finished(task, Duration::from_secs(5)).await.unwrap(),
        CloseReason::Bye(ByeReason::Revoked)
    );
    // Opening the gate now runs nothing: the operations were cancelled.
    env.host.gate.add_permits(100);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(env.host.executed.load(Ordering::SeqCst), 0);
    for i in 0..5 {
        let stored = env.hub.dedupe().get(&device_id, &format!("q{i}")).unwrap();
        assert_eq!(stored.error.unwrap().code, ErrorCode::Unavailable);
    }
}

#[tokio::test]
async fn launch_flood_is_refused_after_five() {
    let env = env();
    let (_device, mut conn) = paired(&env).await;
    let args = json!({"workspaceId": "ws_1", "providerId": "claude-code"});
    for i in 0..7 {
        request(&mut conn, &format!("l{i}"), ops::AGENT_LAUNCH, args.clone()).await;
    }
    let all = responses(&mut conn, 7).await;
    let refused: Vec<_> = (0..7)
        .filter(|i| {
            all[&format!("l{i}")]
                .error
                .as_ref()
                .is_some_and(|e| e.code == ErrorCode::Refused && e.message == "rate limited")
        })
        .collect();
    assert_eq!(refused, [5, 6]);
    assert_eq!(env.host.calls.load(Ordering::SeqCst), 5);
    // A refused id was not remembered: it is not answered from the store later.
    assert!(
        env.hub
            .dedupe()
            .get(&conn.accepted.device_id, "l6")
            .is_none()
    );
}

#[tokio::test]
async fn in_flight_requests_are_capped_per_connection() {
    let env = env();
    let (_device, mut conn) = paired(&env).await;
    for i in 0..17 {
        request(
            &mut conn,
            &format!("f{i}"),
            ops::AGENT_RETRY,
            json!({"agentId": "thr_1"}),
        )
        .await;
    }
    let HostMessage::Res(res) = recv(&mut conn).await else {
        panic!("expected res")
    };
    assert_eq!(res.id, "f16");
    assert_eq!(res.error.unwrap().code, ErrorCode::Unavailable);
    env.host.gate.add_permits(100);
    let all = responses(&mut conn, 16).await;
    assert!(all.values().all(|r| r.ok));
}

#[tokio::test]
async fn a_third_session_closes_the_oldest() {
    let env = env();
    let (device, mut first) = paired(&env).await;
    let (mut second, _t2) = reconnect(&env, &device).await;
    let (mut third, _t3) = reconnect(&env, &device).await;
    assert_eq!(
        recv(&mut first).await,
        HostMessage::Bye {
            reason: ByeReason::Replaced
        }
    );
    for conn in [&mut second, &mut third] {
        conn.send(&DeviceMessage::Ping { n: 3 }).await.unwrap();
        assert_eq!(recv(conn).await, HostMessage::Pong { n: 3 });
    }
}

#[tokio::test]
async fn oversize_inbound_message_closes_the_connection() {
    let env = env();
    let (_device, mut conn, task) = paired_piped(&env, 4 << 20).await;
    conn.writer
        .send(&json!({"t": "ping", "n": 1, "pad": "x".repeat(300 * 1024)}))
        .await
        .unwrap();
    let result = finished(task, Duration::from_secs(5)).await;
    assert!(
        matches!(result, Err(Error::MessageTooLarge(_))),
        "{result:?}"
    );
    assert!(conn.recv().await.is_err());
}

#[tokio::test]
async fn repeated_hello_is_ignored() {
    let env = env();
    let (_device, mut conn) = paired(&env).await;
    conn.send(&DeviceMessage::Hello {}).await.unwrap();
    conn.send(&DeviceMessage::Ping { n: 9 }).await.unwrap();
    assert_eq!(recv(&mut conn).await, HostMessage::Pong { n: 9 });
}

/// Message 1 and the reply of a pairing handshake, by hand; `hello` not yet sent.
async fn half_open(
    env: &Env,
    device: &StaticKeypair,
    code: &str,
) -> (
    DuplexStream,
    snow::HandshakeState,
    HandshakeReply,
    JoinHandle<Result<CloseReason, Error>>,
) {
    let (mut stream, task) = serve(env);
    let mut handshake = noise::initiator(device, env.identity.key.public()).unwrap();
    let payload = serde_json::to_vec(&hello(Some(code))).unwrap();
    transport::write_handshake(&mut stream, &mut handshake, &payload)
        .await
        .unwrap();
    let reply = transport::read_handshake(&mut stream, &mut handshake)
        .await
        .unwrap();
    let reply = serde_json::from_slice(&reply).unwrap();
    (stream, handshake, reply, task)
}

#[tokio::test]
async fn racing_pairings_with_one_code_register_exactly_one() {
    let env = env();
    let ticket = env.pairing.open().unwrap();
    let (a, b) = (
        StaticKeypair::generate().unwrap(),
        StaticKeypair::generate().unwrap(),
    );
    // Both pass the check at message 1: nothing is spent yet.
    let (sa, ha, ra, ta) = half_open(&env, &a, &ticket.code).await;
    let (sb, hb, rb, tb) = half_open(&env, &b, &ticket.code).await;
    assert!(matches!(ra, HandshakeReply::Accepted(_)));
    assert!(matches!(rb, HandshakeReply::Accepted(_)));
    assert!(env.pairing.is_open());
    assert!(env.registry.list().is_empty());
    // Both confirm at once; the first to commit wins.
    let mut connections = Vec::new();
    for (stream, handshake) in [(sa, ha), (sb, hb)] {
        let (reader, mut writer) =
            transport::split(stream, handshake.into_transport_mode().unwrap());
        writer.send(&DeviceMessage::Hello {}).await.unwrap();
        connections.push((reader, writer));
    }
    // Hang up: the winner's session then ends as well.
    drop(connections);
    let results = [
        finished(ta, Duration::from_secs(5)).await,
        finished(tb, Duration::from_secs(5)).await,
    ];
    let lost = results
        .iter()
        .filter(|r| matches!(r, Err(Error::Rejected(RejectReason::PairingExpired))))
        .count();
    assert_eq!(lost, 1, "{results:?}");
    assert_eq!(env.registry.list().len(), 1);
    assert!(!env.pairing.is_open());
}

#[tokio::test]
async fn an_abandoned_pairing_handshake_spends_nothing() {
    let env = env();
    let ticket = env.pairing.open().unwrap();
    let device = StaticKeypair::generate().unwrap();
    let (stream, _handshake, reply, task) = half_open(&env, &device, &ticket.code).await;
    assert!(matches!(reply, HandshakeReply::Accepted(_)));
    drop(stream);
    assert!(finished(task, Duration::from_secs(5)).await.is_err());
    assert!(env.pairing.is_open(), "the code is spent only after hello");
    assert!(env.registry.list().is_empty());
}

#[tokio::test]
async fn invalid_device_metadata_is_rejected() {
    let env = env();
    let ticket = env.pairing.open().unwrap();
    let device = StaticKeypair::generate().unwrap();
    for bad in [
        "x".repeat(65),
        "Kaleb\u{7}s phone".into(),
        "line\nbreak".into(),
    ] {
        let mut h = hello(Some(&ticket.code));
        h.device = bad;
        let (stream, _task) = serve(&env);
        let result = client::connect(stream, &device, env.identity.key.public(), &h).await;
        assert!(
            matches!(result, Err(Error::Rejected(RejectReason::Invalid))),
            "{result:?}"
        );
    }
    assert!(env.pairing.is_open());
    assert!(env.registry.list().is_empty());
}

#[test]
fn debug_output_never_contains_secrets() {
    let ticket = Pairing::new().open().unwrap();
    let key = StaticKeypair::generate().unwrap();
    let payload: PairingPayload = ticket.payload("ws_1", "Desk", &key, vec![]);
    let hello = hello(Some(&ticket.code));
    for printed in [
        format!("{ticket:?}"),
        format!("{payload:?}"),
        format!("{hello:?}"),
        format!("{key:?}"),
    ] {
        assert!(!printed.contains(ticket.code.as_str()), "{printed}");
        assert!(
            !printed.contains(key.private_base64().as_str()),
            "{printed}"
        );
    }
}
