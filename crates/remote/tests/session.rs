//! End-to-end sessions over in-memory pipes: the real responder ([`server::accept`] +
//! [`server::serve_connection`]) against the real initiator ([`client::connect`]).

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::future::Future;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use kalcode_remote::client::{self, ClientConnection};
use kalcode_remote::noise::{self, StaticKeypair};
use kalcode_remote::pairing::{Clock, Pairing};
use kalcode_remote::registry::{Device, Registry};
use kalcode_remote::server::{self, CloseReason, HostIdentity, Hub, RemoteHost};
use kalcode_remote::transport;
use kalcode_remote::wire::{
    ByeReason, DeviceHello, DeviceMessage, ErrorCode, HostBuild, HostMessage, Notification,
    NotifyKind, RejectReason, RemoteError, RemoteService, RemoteState, Workstation,
};
use kalcode_remote::{Error, ops};
use serde_json::{Value, json};
use tokio::io::DuplexStream;
use tokio::task::JoinHandle;

// ---- fixtures -------------------------------------------------------------------------------

struct TestHost {
    state: Mutex<RemoteState>,
    calls: AtomicUsize,
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
        async move {
            match op.as_str() {
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
        hub: Hub::new(),
        host: Arc::new(TestHost {
            state: Mutex::new(state),
            calls: AtomicUsize::new(0),
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
    let (device_end, host_end) = tokio::io::duplex(4 << 20);
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
    let device = StaticKeypair::generate().unwrap();
    let ticket = env.pairing.open().unwrap();
    let mut conn = connect(env, &device, Some(&ticket.code)).await.unwrap();
    assert!(matches!(
        recv(&mut conn).await,
        HostMessage::Snapshot { rev: 1, .. }
    ));
    (device, conn)
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
    connect(&env, &first, Some(&ticket.code)).await.unwrap();
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

    // A repeat while the first is still running, then a repeat after it finished.
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
    let HostMessage::Res(a) = recv(&mut conn).await else {
        panic!("expected res")
    };
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
