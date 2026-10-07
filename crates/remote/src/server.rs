//! The desktop side of a connection.
//!
//! The desktop owns the listener. For each accepted TCP stream it first asks [`Hub::admit`]
//! for a handshake slot (before reading a byte; over the limit it just drops the socket), then
//! calls [`accept`] (Noise IK handshake and the §3 accept/reject rules), releases the slot, and
//! runs [`serve_connection`] until the device leaves, goes silent, stops reading, is revoked,
//! is replaced by a newer session, or the desktop calls [`Hub::close_all`].
//!
//! ```ignore
//! let hub = Hub::new(); // or Hub::with_limits(..)
//! loop {
//!     let (tcp, peer) = listener.accept().await?;
//!     let Some(permit) = hub.admit(peer.ip()) else {
//!         continue; // over the pre-auth limit: drop the socket, no Noise work
//!     };
//!     let (host, hub, identity, registry, pairing) = (host.clone(), hub.clone(), identity.clone(), registry.clone(), pairing.clone());
//!     tokio::spawn(async move {
//!         let conn = accept(tcp, &identity, &registry, &pairing, entitled()).await;
//!         drop(permit);
//!         serve_connection(conn?, host, &hub, &registry).await
//!     });
//! }
//! // Elsewhere: hub.state_changed() on every state change, hub.notify(..) for §6 events,
//! // registry.revoke(id) to remove a device, hub.close_all(ByeReason::Disabled) to stop.
//! ```

use std::collections::HashMap;
use std::future::Future;
use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde_json::Value;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, WriteHalf};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, broadcast, mpsc, oneshot, watch};
use tokio::task::JoinSet;
use tokio::time::{Duration, Instant};

use crate::admission::{Admission, AdmissionPermit};
use crate::dedupe::{Begin, Dedupe};
use crate::limits::{Limits, Rate};
use crate::noise::{self, StaticKeypair, to_key};
use crate::pairing::Pairing;
use crate::registry::{Device, Registry};
use crate::transport::{self, MAX_HANDSHAKE_FRAME, MAX_INBOUND_MESSAGE, NoiseReader, NoiseWriter};
use crate::wire::{
    ByeReason, DeviceHello, DeviceMessage, HandshakeAccepted, HandshakeReply, HostBuild,
    HostMessage, Notification, RejectReason, RemoteError, RemoteState, Response,
};
use crate::{Error, HANDSHAKE_TIMEOUT, PROTOCOL_VERSION, diff, ops};

/// Minimum spacing between notifications about the same agent (§6).
pub const NOTIFY_COALESCE: Duration = Duration::from_secs(10);

/// Longest request id accepted.
pub const MAX_REQUEST_ID: usize = 128;

/// What the desktop integration provides.
pub trait RemoteHost: Send + Sync + 'static {
    /// The current canonical state (§4.1). Called on connect and after each debounced change.
    fn snapshot(&self) -> RemoteState;

    /// Runs one operation for `device`. `op` is always in [`ops::ALL`]; [`ops::Op::parse`]
    /// parses the arguments. Runs on its own task, so slow operations never block keepalive.
    /// The returned future may be dropped before completion when the device is revoked or the
    /// desktop closes all connections.
    fn handle(
        &self,
        device: &Device,
        op: &str,
        args: Value,
    ) -> impl Future<Output = Result<Value, RemoteError>> + Send;
}

/// The workstation's identity: static key plus what the handshake reply reports.
#[derive(Debug, Clone)]
pub struct HostIdentity {
    pub key: StaticKeypair,
    /// `ws_...`, stable.
    pub workstation_id: String,
    /// Desktop machine name.
    pub name: String,
    pub build: HostBuild,
}

/// A device that completed the handshake and proved its keys with an encrypted `hello`.
pub struct AuthenticatedConnection<S> {
    pub device: Device,
    /// The device's handshake payload (app version, model, ...).
    pub hello: DeviceHello,
    pub handshake_hash: Vec<u8>,
    pub reader: NoiseReader<tokio::io::ReadHalf<S>>,
    pub writer: NoiseWriter<WriteHalf<S>>,
}

impl<S> std::fmt::Debug for AuthenticatedConnection<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthenticatedConnection")
            .field("device", &self.device.id)
            .finish_non_exhaustive()
    }
}

/// Performs the Noise IK handshake as responder and applies §3:
///
/// - wrong protocol version or unreadable payload → `version`;
/// - a name, platform, model or app field over 64 characters or with control characters →
///   `invalid`;
/// - revoked key → `revoked`;
/// - unknown key without a code → `unpaired`;
/// - not entitled → `not_entitled` (checked before a code is looked at);
/// - unknown key with a used, expired or wrong code → `pairing_expired`;
/// - unknown key with the valid code → accepted; the code is burnt and the device registered
///   only once its encrypted `hello` arrives (of two handshakes racing with one code, exactly
///   one registers; the other is dropped);
/// - known key → accepted without a code.
///
/// A rejection is sent encrypted, the stream is closed and `Err(Error::Rejected(_))` returned.
/// On acceptance the device must send its encrypted `hello` (key confirmation) before this
/// returns; a replayed first message therefore never yields a connection or spends a code.
/// The whole exchange is bounded by [`HANDSHAKE_TIMEOUT`]; handshake frames are capped at
/// [`MAX_HANDSHAKE_FRAME`]. Call it only with a permit from [`Hub::admit`].
pub async fn accept<S>(
    stream: S,
    host: &HostIdentity,
    registry: &Registry,
    pairing: &Pairing,
    entitled: bool,
) -> Result<AuthenticatedConnection<S>, Error>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    tokio::time::timeout(
        HANDSHAKE_TIMEOUT,
        accept_inner(stream, host, registry, pairing, entitled),
    )
    .await
    .unwrap_or(Err(Error::HandshakeTimeout))
}

/// What message 1 earned, before the device's `hello` confirms it.
enum Admitted {
    Known(Device),
    /// The code checked out; it is burnt and the device registered as `id` after `hello`.
    Pairing {
        id: String,
        code: String,
    },
}

async fn accept_inner<S>(
    mut stream: S,
    host: &HostIdentity,
    registry: &Registry,
    pairing: &Pairing,
    entitled: bool,
) -> Result<AuthenticatedConnection<S>, Error>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut handshake = noise::responder(&host.key)?;
    let payload = transport::read_handshake(&mut stream, &mut handshake).await?;
    let remote = to_key(
        handshake
            .get_remote_static()
            .ok_or_else(|| Error::BadHandshake("no static key".into()))?,
    )?;
    let hello = serde_json::from_slice::<DeviceHello>(&payload)
        .ok()
        .filter(|h| h.v == PROTOCOL_VERSION);

    let outcome = match hello {
        None => Err(RejectReason::Version),
        Some(hello) if !hello.fields_are_valid() => Err(RejectReason::Invalid),
        Some(hello) => {
            decide(&remote, &hello, registry, pairing, entitled)?.map(|admitted| (admitted, hello))
        }
    };
    let (admitted, hello) = match outcome {
        Ok(accepted) => accepted,
        Err(reason) => {
            let reply = serde_json::to_vec(&HandshakeReply::Rejected(reason))?;
            transport::write_handshake(&mut stream, &mut handshake, &reply).await?;
            let _ = stream.shutdown().await;
            tracing::info!(%reason, "remote: handshake rejected");
            return Err(Error::Rejected(reason));
        }
    };

    let device_id = match &admitted {
        Admitted::Known(device) => device.id.clone(),
        Admitted::Pairing { id, .. } => id.clone(),
    };
    let reply = HandshakeReply::Accepted(HandshakeAccepted {
        wid: host.workstation_id.clone(),
        name: host.name.clone(),
        device_id,
        host: host.build.clone(),
    });
    transport::write_handshake(&mut stream, &mut handshake, &serde_json::to_vec(&reply)?).await?;
    let handshake_hash = handshake.get_handshake_hash().to_vec();
    let (mut reader, writer) = transport::split(stream, handshake.into_transport_mode()?);

    // Key confirmation: only the holder of the device's ephemeral and static keys can produce
    // a transport message that decrypts. `hello` is tiny; nothing bigger is buffered yet.
    reader.set_max_message(MAX_HANDSHAKE_FRAME);
    match reader.recv::<DeviceMessage>().await? {
        DeviceMessage::Hello {} => {}
        _ => return Err(Error::Malformed("the first message must be hello".into())),
    }
    reader.set_max_message(MAX_INBOUND_MESSAGE);

    let device = match admitted {
        Admitted::Known(device) => {
            let (id, seen) = (device.id.clone(), hello.clone());
            registry
                .blocking(move |r| r.touch(&id, &seen))
                .await?
                .unwrap_or(device)
        }
        Admitted::Pairing { id, code } => {
            // Commit point (§8): the code is spent only now, atomically.
            if pairing.redeem(&code).is_err() {
                tracing::info!("remote: pairing code was spent by another handshake");
                return Err(Error::Rejected(RejectReason::PairingExpired));
            }
            let paired = hello.clone();
            registry
                .blocking(move |r| r.register_as(id, &remote, &paired))
                .await?
        }
    };
    tracing::info!(device = %device.id, "remote: device connected");
    Ok(AuthenticatedConnection {
        device,
        hello,
        handshake_hash,
        reader,
        writer,
    })
}

fn decide(
    remote: &[u8; noise::KEY_LEN],
    hello: &DeviceHello,
    registry: &Registry,
    pairing: &Pairing,
    entitled: bool,
) -> Result<Result<Admitted, RejectReason>, Error> {
    Ok(match registry.find_by_public_key(remote) {
        Some(device) if device.revoked => Err(RejectReason::Revoked),
        Some(_) if !entitled => Err(RejectReason::NotEntitled),
        Some(device) => Ok(Admitted::Known(device)),
        None => match &hello.pair {
            None => Err(RejectReason::Unpaired),
            Some(_) if !entitled => Err(RejectReason::NotEntitled),
            Some(code) => match pairing.verify(code) {
                Ok(()) => Ok(Admitted::Pairing {
                    id: crate::random_id("dev_")?,
                    code: code.clone(),
                }),
                Err(_) => Err(RejectReason::PairingExpired),
            },
        },
    })
}

/// Answers a handshake with `reason` without consulting the registry.
///
/// This costs a full Noise DH. Never use it for load shedding: over the handshake limit,
/// drop the socket instead (see [`Hub::admit`]).
pub async fn reject<S>(
    mut stream: S,
    host: &HostIdentity,
    reason: RejectReason,
) -> Result<(), Error>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
        let mut handshake = noise::responder(&host.key)?;
        transport::read_handshake(&mut stream, &mut handshake).await?;
        let reply = serde_json::to_vec(&HandshakeReply::Rejected(reason))?;
        transport::write_handshake(&mut stream, &mut handshake, &reply).await?;
        let _ = stream.shutdown().await;
        Ok(())
    })
    .await
    .unwrap_or(Err(Error::HandshakeTimeout))
}

/// Shared by every connection: limits and admission, change signals, notification fan-out,
/// closing, per-device sessions and rate limits, and the request de-duplication memory.
/// Cheap to clone.
#[derive(Clone)]
pub struct Hub {
    inner: Arc<HubInner>,
}

struct HubInner {
    limits: Limits,
    admission: Admission,
    changes: watch::Sender<u64>,
    notifications: broadcast::Sender<Notification>,
    bye: watch::Sender<Option<ByeReason>>,
    dedupe: Dedupe,
    last_notified: Mutex<HashMap<String, Instant>>,
    sessions: Mutex<HashMap<String, Vec<Session>>>,
    next_session: AtomicU64,
    buckets: Mutex<HashMap<(String, RateClass), Bucket>>,
}

struct Session {
    id: u64,
    replaced: oneshot::Sender<()>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum RateClass {
    Launch,
    Action,
    Read,
}

struct Bucket {
    tokens: f64,
    at: Instant,
}

impl Default for Hub {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for Hub {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Hub")
            .field("limits", &self.inner.limits)
            .finish_non_exhaustive()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Hub {
    /// A hub with the production [`Limits`].
    pub fn new() -> Self {
        Self::with_limits(Limits::default())
    }

    pub fn with_limits(limits: Limits) -> Self {
        Self {
            inner: Arc::new(HubInner {
                admission: Admission::new(limits.max_handshakes, limits.max_handshakes_per_ip),
                limits,
                changes: watch::channel(0).0,
                notifications: broadcast::channel(64).0,
                bye: watch::channel(None).0,
                dedupe: Dedupe::new(),
                last_notified: Mutex::new(HashMap::new()),
                sessions: Mutex::new(HashMap::new()),
                next_session: AtomicU64::new(0),
                buckets: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub fn limits(&self) -> &Limits {
        &self.inner.limits
    }

    /// A handshake slot for a connection from `peer`, or `None` when [`Limits::max_handshakes`]
    /// or [`Limits::max_handshakes_per_ip`] is reached. Ask right after `accept()`, before
    /// reading; on `None` drop the socket. Hold the permit until [`accept`] returns.
    pub fn admit(&self, peer: IpAddr) -> Option<AdmissionPermit> {
        self.inner.admission.try_admit(peer)
    }

    /// Signals that [`RemoteHost::snapshot`] may have changed. Connections coalesce signals
    /// for [`Limits::patch_debounce`] and send one patch.
    pub fn state_changed(&self) {
        self.inner.changes.send_modify(|n| *n = n.wrapping_add(1));
    }

    /// Sends `notification` to every live connection. When `agent_id` is given, at most one
    /// notification per agent is sent per [`NOTIFY_COALESCE`]; returns false when coalesced.
    pub fn notify(&self, notification: Notification, agent_id: Option<&str>) -> bool {
        if let Some(agent) = agent_id {
            let now = Instant::now();
            let mut last = lock(&self.inner.last_notified);
            last.retain(|_, at| now.duration_since(*at) < NOTIFY_COALESCE);
            if last.contains_key(agent) {
                return false;
            }
            last.insert(agent.to_owned(), now);
        }
        // No live connection means no receiver; that is fine.
        let _ = self.inner.notifications.send(notification);
        true
    }

    /// Closes every live connection with `bye reason`, cancelling their running operations.
    /// Connections accepted afterwards are unaffected (stop accepting them separately).
    pub fn close_all(&self, reason: ByeReason) {
        self.inner.bye.send_replace(Some(reason));
    }

    pub fn dedupe(&self) -> &Dedupe {
        &self.inner.dedupe
    }

    /// Registers a live session for `device`; closes the oldest beyond
    /// [`Limits::max_sessions_per_device`]. The receiver fires when this one is replaced.
    fn open_session(&self, device: &str) -> (SessionGuard, oneshot::Receiver<()>) {
        let id = self.inner.next_session.fetch_add(1, Ordering::Relaxed);
        let (replaced, on_replaced) = oneshot::channel();
        let max = self.inner.limits.max_sessions_per_device.max(1);
        let mut sessions = lock(&self.inner.sessions);
        let live = sessions.entry(device.to_owned()).or_default();
        live.push(Session { id, replaced });
        while live.len() > max {
            let oldest = live.remove(0);
            let _ = oldest.replaced.send(());
        }
        (
            SessionGuard {
                hub: self.clone(),
                device: device.to_owned(),
                id,
            },
            on_replaced,
        )
    }

    /// Takes one token from `device`'s bucket for `op`; false when rate limited.
    fn allow(&self, device: &str, op: &str) -> bool {
        let limits = &self.inner.limits;
        let (class, rate) = match op {
            ops::AGENT_LAUNCH => (RateClass::Launch, limits.launch_rate),
            ops::AGENT_DETAIL
            | ops::AGENT_DIFF
            | ops::AGENT_LOG
            | ops::LAUNCH_OPTIONS
            | ops::RUN_DETAIL => (RateClass::Read, limits.read_rate),
            _ => (RateClass::Action, limits.action_rate),
        };
        take_token(
            &mut lock(&self.inner.buckets),
            (device.to_owned(), class),
            rate,
        )
    }
}

fn take_token(
    buckets: &mut HashMap<(String, RateClass), Bucket>,
    key: (String, RateClass),
    rate: Rate,
) -> bool {
    let now = Instant::now();
    let burst = f64::from(rate.burst);
    let bucket = buckets.entry(key).or_insert(Bucket {
        tokens: burst,
        at: now,
    });
    if !rate.refill.is_zero() {
        let earned = now.duration_since(bucket.at).as_secs_f64() / rate.refill.as_secs_f64();
        bucket.tokens = (bucket.tokens + earned).min(burst);
    } else {
        bucket.tokens = burst;
    }
    bucket.at = now;
    if bucket.tokens >= 1.0 {
        bucket.tokens -= 1.0;
        true
    } else {
        false
    }
}

struct SessionGuard {
    hub: Hub,
    device: String,
    id: u64,
}

impl Drop for SessionGuard {
    fn drop(&mut self) {
        let mut sessions = lock(&self.hub.inner.sessions);
        if let Some(live) = sessions.get_mut(&self.device) {
            live.retain(|s| s.id != self.id);
            if live.is_empty() {
                sessions.remove(&self.device);
            }
        }
    }
}

/// Why [`serve_connection`] ended normally.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseReason {
    /// The desktop sent `bye`.
    Bye(ByeReason),
    /// The device closed the connection.
    PeerClosed,
    /// Nothing arrived for [`Limits::silence_timeout`].
    Silent,
}

struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Drives an accepted connection until it ends.
///
/// Sends the snapshot (rev 1), then a patch (rev + 1) at most every [`Limits::patch_debounce`]
/// after [`Hub::state_changed`]; answers `ping` itself; runs each `req` on its own task through
/// [`RemoteHost::handle`] with de-duplication, an in-flight cap and per-device rate limits;
/// forwards [`Hub::notify`]; sends `bye revoked` as soon as the device is revoked and
/// `bye <reason>` on [`Hub::close_all`] (both cancel the connection's running operations; the
/// cancelled ids are remembered as `unavailable`), and `bye replaced` when the device opens a
/// session beyond [`Limits::max_sessions_per_device`].
///
/// Writes run on their own task, so a device that stops reading never stalls this loop: it is
/// dropped with [`Error::PeerStalled`] after [`Limits::write_timeout`] without progress, and a
/// closing connection gets at most that long to flush its `bye`.
pub async fn serve_connection<S, H>(
    conn: AuthenticatedConnection<S>,
    host: Arc<H>,
    hub: &Hub,
    registry: &Registry,
) -> Result<CloseReason, Error>
where
    S: AsyncRead + AsyncWrite + Send + 'static,
    H: RemoteHost,
{
    match serve(conn, host, hub, registry).await {
        Err(Error::Closed) => Ok(CloseReason::PeerClosed),
        other => other,
    }
}

async fn serve<S, H>(
    conn: AuthenticatedConnection<S>,
    host: Arc<H>,
    hub: &Hub,
    registry: &Registry,
) -> Result<CloseReason, Error>
where
    S: AsyncRead + AsyncWrite + Send + 'static,
    H: RemoteHost,
{
    let limits = hub.limits().clone();
    let AuthenticatedConnection {
        device,
        mut reader,
        mut writer,
        ..
    } = conn;
    reader.set_max_message(limits.max_inbound_message);
    writer.set_stall_timeout(Some(limits.write_timeout));
    let mut revocations = registry.revocations();
    let mut changes = hub.inner.changes.subscribe();
    let mut notifications = hub.inner.notifications.subscribe();
    let mut bye = hub.inner.bye.subscribe();
    let mut out = Outbox::start(writer, limits.max_outbound_queue);

    if registry.get(&device.id).is_none_or(|d| d.revoked) {
        return out.close(ByeReason::Revoked, limits.write_timeout).await;
    }
    let (_session, mut replaced) = hub.open_session(&device.id);
    let mut replaceable = true;

    let (incoming_tx, mut incoming) = mpsc::channel::<Result<Vec<u8>, Error>>(2);
    let _reader = AbortOnDrop(tokio::spawn(read_loop(reader, incoming_tx)));
    let mut running = InFlight::default();

    let mut rev: u64 = 1;
    let mut last = host.snapshot();
    out.push(&HostMessage::Snapshot {
        rev,
        state: Box::new(last.clone()),
    })?;

    let silence = tokio::time::sleep(limits.silence_timeout);
    tokio::pin!(silence);
    let mut flush_at: Option<Instant> = None;

    loop {
        tokio::select! {
            // Closing beats everything else: nothing new starts after a revocation or bye.
            biased;
            Ok(()) = bye.changed() => {
                let reason = *bye.borrow_and_update();
                if let Some(reason) = reason {
                    running.cancel_all().await;
                    return out.close(reason, limits.write_timeout).await;
                }
            }
            revoked = revocations.recv() => {
                let ours = match revoked {
                    Ok(id) => id == device.id,
                    Err(broadcast::error::RecvError::Lagged(_)) => registry.get(&device.id).is_none_or(|d| d.revoked),
                    Err(broadcast::error::RecvError::Closed) => false,
                };
                if ours {
                    running.cancel_all().await;
                    return out.close(ByeReason::Revoked, limits.write_timeout).await;
                }
            }
            signal = &mut replaced, if replaceable => {
                replaceable = false;
                if signal.is_ok() {
                    // The device reconnected; let this session's operations finish and store
                    // their results for its retries.
                    tracing::info!(device = %device.id, "remote: session replaced by a newer one");
                    return out.close(ByeReason::Replaced, limits.write_timeout).await;
                }
            }
            failed = &mut out.task => {
                return Err(match failed {
                    Ok(Err(error)) => error,
                    _ => Error::Closed,
                });
            }
            () = &mut silence => {
                tracing::info!(device = %device.id, "remote: connection silent");
                return Ok(CloseReason::Silent);
            }
            Some(response) = running.next(), if !running.is_empty() => {
                out.push(&HostMessage::Res(response))?;
            }
            message = incoming.recv() => {
                let bytes = match message {
                    None | Some(Err(Error::Closed)) => return Ok(CloseReason::PeerClosed),
                    Some(Err(error)) => return Err(error),
                    Some(Ok(bytes)) => bytes,
                };
                silence.as_mut().reset(Instant::now() + limits.silence_timeout);
                let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
                    tracing::debug!("remote: ignoring a message that is not JSON");
                    continue;
                };
                // A malformed request still gets exactly one answer when its id is readable.
                let req_id = (value.get("t").and_then(Value::as_str) == Some("req"))
                    .then(|| value.get("id").and_then(Value::as_str).map(str::to_owned))
                    .flatten();
                match serde_json::from_value::<DeviceMessage>(value) {
                    Ok(DeviceMessage::Ping { n }) => out.push(&HostMessage::Pong { n })?,
                    Ok(DeviceMessage::Hello {}) => {
                        tracing::debug!(device = %device.id, "remote: ignoring a repeated hello");
                    }
                    Ok(DeviceMessage::Req { id, op, args }) => {
                        match start_request(&host, hub, registry, &device, &mut running, id, op, args) {
                            Started::Running => {}
                            Started::Reply(response) => out.push(&HostMessage::Res(response))?,
                            Started::Revoked => {
                                running.cancel_all().await;
                                return out.close(ByeReason::Revoked, limits.write_timeout).await;
                            }
                        }
                    }
                    Err(error) => match req_id {
                        Some(id) => {
                            let response = Response::failure(id, RemoteError::invalid(error.to_string()));
                            out.push(&HostMessage::Res(response))?;
                        }
                        None => tracing::debug!(%error, "remote: ignoring unknown message"),
                    },
                }
            }
            Ok(()) = changes.changed() => {
                flush_at.get_or_insert_with(|| Instant::now() + limits.patch_debounce);
            }
            () = tokio::time::sleep_until(flush_at.unwrap_or_else(Instant::now)), if flush_at.is_some() => {
                flush_at = None;
                let next = host.snapshot();
                if let Some(mut patch) = diff::diff(&last, &next) {
                    rev += 1;
                    patch.rev = rev;
                    out.push(&HostMessage::Patch(Box::new(patch)))?;
                }
                last = next;
            }
            notification = notifications.recv() => match notification {
                Ok(notification) => out.push(&HostMessage::Notify(notification))?,
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    tracing::warn!(skipped, "remote: notifications dropped for a slow device");
                }
                Err(broadcast::error::RecvError::Closed) => {}
            },
        }
    }
}

async fn read_loop<R: AsyncRead + Unpin>(
    mut reader: NoiseReader<R>,
    tx: mpsc::Sender<Result<Vec<u8>, Error>>,
) {
    loop {
        let message = reader.recv_bytes().await;
        let fatal = message.is_err();
        if tx.send(message).await.is_err() || fatal {
            return;
        }
    }
}

type Queued = (Vec<u8>, OwnedSemaphorePermit);

/// The connection's outgoing side: a writer task fed through a queue bounded in bytes.
struct Outbox {
    tx: Option<mpsc::UnboundedSender<Queued>>,
    budget: Arc<Semaphore>,
    task: tokio::task::JoinHandle<Result<(), Error>>,
}

impl Outbox {
    fn start<W>(writer: NoiseWriter<W>, max_queued_bytes: usize) -> Self
    where
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (tx, rx) = mpsc::unbounded_channel();
        Self {
            tx: Some(tx),
            budget: Arc::new(Semaphore::new(max_queued_bytes.min(Semaphore::MAX_PERMITS))),
            task: tokio::spawn(write_loop(writer, rx)),
        }
    }

    /// Queues `message` without waiting. A device that lets the queue exceed its byte budget
    /// is not reading: [`Error::PeerStalled`].
    fn push(&self, message: &HostMessage) -> Result<(), Error> {
        let json = serde_json::to_vec(message)?;
        let size = u32::try_from(json.len()).map_err(|_| Error::MessageTooLarge(json.len()))?;
        let permit = Arc::clone(&self.budget)
            .try_acquire_many_owned(size)
            .map_err(|_| Error::PeerStalled)?;
        self.tx
            .as_ref()
            .ok_or(Error::Closed)?
            .send((json, permit))
            .map_err(|_| Error::Closed)
    }

    /// Sends `bye reason` after whatever is queued and shuts the stream down, giving the
    /// device at most `limit` to take it; past that the stream is simply dropped.
    async fn close(mut self, reason: ByeReason, limit: Duration) -> Result<CloseReason, Error> {
        let _ = self.push(&HostMessage::Bye { reason });
        self.tx = None;
        if tokio::time::timeout(limit, &mut self.task).await.is_err() {
            tracing::info!(?limit, "remote: device did not take its bye in time");
        }
        Ok(CloseReason::Bye(reason))
    }
}

impl Drop for Outbox {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn write_loop<W: AsyncWrite + Unpin>(
    mut writer: NoiseWriter<W>,
    mut rx: mpsc::UnboundedReceiver<Queued>,
) -> Result<(), Error> {
    while let Some((json, _permit)) = rx.recv().await {
        writer.send_bytes(&json).await?;
    }
    let _ = writer.shutdown().await;
    Ok(())
}

/// The connection's running operations. Dropping it detaches them (they finish and store
/// their results for retries); [`InFlight::cancel_all`] aborts them.
#[derive(Default)]
struct InFlight {
    tasks: JoinSet<Response>,
    ids: HashMap<tokio::task::Id, String>,
}

impl InFlight {
    fn len(&self) -> usize {
        self.tasks.len()
    }

    fn is_empty(&self) -> bool {
        self.tasks.is_empty()
    }

    fn spawn<F>(&mut self, id: String, task: F)
    where
        F: Future<Output = Response> + Send + 'static,
    {
        let handle = self.tasks.spawn(task);
        self.ids.insert(handle.id(), id);
    }

    /// The next finished operation's response.
    async fn next(&mut self) -> Option<Response> {
        Some(match self.tasks.join_next_with_id().await? {
            Ok((task, response)) => {
                self.ids.remove(&task);
                response
            }
            Err(error) => {
                let id = self.ids.remove(&error.id()).unwrap_or_default();
                if error.is_panic() {
                    tracing::error!(%id, "remote: operation panicked");
                    Response::failure(id, RemoteError::internal("the operation failed"))
                } else {
                    Response::failure(id, RemoteError::unavailable("the operation was cancelled"))
                }
            }
        })
    }

    /// Aborts every running operation and waits until they are gone.
    async fn cancel_all(&mut self) {
        self.tasks.shutdown().await;
        self.ids.clear();
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        self.tasks.detach_all();
    }
}

/// Finishes a de-duplication entry exactly once: with the result, or `unavailable` when the
/// operation is cancelled (`internal` if it panicked).
struct PendingGuard {
    hub: Hub,
    device: String,
    id: String,
    armed: bool,
}

impl PendingGuard {
    fn finish(mut self, response: Response) {
        self.armed = false;
        self.hub.dedupe().finish(&self.device, &self.id, response);
    }
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        if self.armed {
            let error = if std::thread::panicking() {
                RemoteError::internal("the operation failed")
            } else {
                RemoteError::unavailable("the operation was cancelled")
            };
            let response = Response::failure(self.id.clone(), error);
            self.hub.dedupe().finish(&self.device, &self.id, response);
        }
    }
}

enum Started {
    /// Running; the response arrives through [`InFlight::next`].
    Running,
    /// Answer right away (invalid, refused, conflict, or a stored result).
    Reply(Response),
    /// The device was revoked: close the connection, run nothing.
    Revoked,
}

#[allow(clippy::too_many_arguments)]
fn start_request<H: RemoteHost>(
    host: &Arc<H>,
    hub: &Hub,
    registry: &Registry,
    device: &Device,
    running: &mut InFlight,
    id: String,
    op: String,
    args: Value,
) -> Started {
    if registry.get(&device.id).is_none_or(|d| d.revoked) {
        return Started::Revoked;
    }
    if id.is_empty() || id.len() > MAX_REQUEST_ID {
        return Started::Reply(Response::failure(
            id,
            RemoteError::invalid("request ids are 1-128 characters"),
        ));
    }
    if !ops::is_known(&op) {
        return Started::Reply(Response::failure(
            id,
            RemoteError::invalid(format!("unknown operation {op}")),
        ));
    }
    match hub.dedupe().begin(&device.id, &id) {
        Begin::Done(response) => Started::Reply(response),
        Begin::Pending => {
            let message = format!("request {id} is still running");
            Started::Reply(Response::failure(id, RemoteError::conflict(message)))
        }
        Begin::Full => Started::Reply(Response::failure(
            id,
            RemoteError::unavailable("too many requests are running"),
        )),
        Begin::Run => {
            if running.len() >= hub.limits().max_in_flight {
                hub.dedupe().abandon(&device.id, &id);
                return Started::Reply(Response::failure(
                    id,
                    RemoteError::unavailable("too many requests are running"),
                ));
            }
            if !hub.allow(&device.id, &op) {
                hub.dedupe().abandon(&device.id, &id);
                return Started::Reply(Response::failure(id, RemoteError::refused("rate limited")));
            }
            let guard = PendingGuard {
                hub: hub.clone(),
                device: device.id.clone(),
                id: id.clone(),
                armed: true,
            };
            let (host, device) = (Arc::clone(host), device.clone());
            running.spawn(id.clone(), async move {
                // `handle` is first called here, so an operation cancelled before this task
                // runs never reaches the host.
                let result = host.handle(&device, &op, args).await;
                let response = Response::from_result(id, result);
                guard.finish(response.clone());
                response
            });
            Started::Running
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn token_bucket_refills() {
        let mut buckets = HashMap::new();
        let key = || ("dev".to_owned(), RateClass::Launch);
        let rate = Rate::per_minute(5);
        for _ in 0..5 {
            assert!(take_token(&mut buckets, key(), rate));
        }
        assert!(!take_token(&mut buckets, key(), rate));
        tokio::time::advance(Duration::from_secs(12)).await;
        assert!(take_token(&mut buckets, key(), rate));
        assert!(!take_token(&mut buckets, key(), rate));
    }
}
