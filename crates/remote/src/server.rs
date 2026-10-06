//! The desktop side of a connection.
//!
//! The desktop owns the listener. For each accepted TCP stream it calls [`accept`] (Noise IK
//! handshake and the §3 accept/reject rules), then [`serve_connection`], which runs until the
//! device leaves, goes silent for 35 s, is revoked, or the desktop calls [`Hub::close_all`].
//!
//! ```ignore
//! let hub = Hub::new();
//! loop {
//!     let (tcp, _) = listener.accept().await?;
//!     let (host, hub, identity, registry, pairing) = (host.clone(), hub.clone(), identity.clone(), registry.clone(), pairing.clone());
//!     tokio::spawn(async move {
//!         let conn = accept(tcp, &identity, &registry, &pairing, entitled()).await?;
//!         serve_connection(conn, host, &hub, &registry).await
//!     });
//! }
//! // Elsewhere: hub.state_changed() on every state change, hub.notify(..) for §6 events,
//! // registry.revoke(id) to remove a device, hub.close_all(ByeReason::Disabled) to stop.
//! ```

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, PoisonError};

use serde_json::Value;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, ReadHalf, WriteHalf};
use tokio::sync::{broadcast, mpsc, watch};
use tokio::time::{Duration, Instant};

use crate::dedupe::{Begin, Dedupe};
use crate::noise::{self, StaticKeypair, to_key};
use crate::pairing::Pairing;
use crate::registry::{Device, Registry};
use crate::transport::{self, NoiseReader, NoiseWriter};
use crate::wire::{
    ByeReason, DeviceHello, DeviceMessage, HandshakeAccepted, HandshakeReply, HostBuild,
    HostMessage, Notification, RejectReason, RemoteError, RemoteState, Response,
};
use crate::{
    Error, HANDSHAKE_TIMEOUT, PATCH_DEBOUNCE, PROTOCOL_VERSION, SILENCE_TIMEOUT, diff, ops,
};

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
    pub reader: NoiseReader<ReadHalf<S>>,
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
/// - revoked key → `revoked`;
/// - unknown key without a code → `unpaired`;
/// - not entitled → `not_entitled` (checked before a code is spent);
/// - unknown key with a used, expired or wrong code → `pairing_expired`;
/// - unknown key with the valid code → registered, code burnt;
/// - known key → accepted without a code.
///
/// A rejection is sent encrypted, the stream is closed and `Err(Error::Rejected(_))` returned.
/// On acceptance the device must send its encrypted `hello` (key confirmation) before this
/// returns; a replayed first message therefore never yields a connection. The whole exchange
/// is bounded by [`HANDSHAKE_TIMEOUT`].
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
        Some(hello) => {
            decide(&remote, &hello, registry, pairing, entitled)?.map(|device| (device, hello))
        }
    };
    let (device, hello) = match outcome {
        Ok(accepted) => accepted,
        Err(reason) => {
            let reply = serde_json::to_vec(&HandshakeReply::Rejected(reason))?;
            transport::write_handshake(&mut stream, &mut handshake, &reply).await?;
            let _ = stream.shutdown().await;
            tracing::info!(%reason, "remote: handshake rejected");
            return Err(Error::Rejected(reason));
        }
    };

    let reply = HandshakeReply::Accepted(HandshakeAccepted {
        wid: host.workstation_id.clone(),
        name: host.name.clone(),
        device_id: device.id.clone(),
        host: host.build.clone(),
    });
    transport::write_handshake(&mut stream, &mut handshake, &serde_json::to_vec(&reply)?).await?;
    let handshake_hash = handshake.get_handshake_hash().to_vec();
    let (mut reader, writer) = transport::split(stream, handshake.into_transport_mode()?);

    // Key confirmation: only the holder of the device's ephemeral and static keys can produce
    // a transport message that decrypts.
    match reader.recv::<DeviceMessage>().await? {
        DeviceMessage::Hello {} => {}
        _ => return Err(Error::Malformed("the first message must be hello".into())),
    }
    let device = registry.touch(&device.id, &hello)?.unwrap_or(device);
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
) -> Result<Result<Device, RejectReason>, Error> {
    Ok(match registry.find_by_public_key(remote) {
        Some(device) if device.revoked => Err(RejectReason::Revoked),
        Some(_) if !entitled => Err(RejectReason::NotEntitled),
        Some(device) => Ok(device),
        None => match &hello.pair {
            None => Err(RejectReason::Unpaired),
            Some(_) if !entitled => Err(RejectReason::NotEntitled),
            Some(code) => match pairing.redeem(code) {
                Ok(()) => Ok(registry.register(remote, hello)?),
                Err(_) => Err(RejectReason::PairingExpired),
            },
        },
    })
}

/// Answers a handshake with `reason` (for example `busy`) without consulting the registry.
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

/// Shared by every connection: change signals, notification fan-out, closing, and the
/// request de-duplication memory. Cheap to clone.
#[derive(Clone)]
pub struct Hub {
    inner: Arc<HubInner>,
}

struct HubInner {
    changes: watch::Sender<u64>,
    notifications: broadcast::Sender<Notification>,
    bye: watch::Sender<Option<ByeReason>>,
    dedupe: Dedupe,
    last_notified: Mutex<HashMap<String, Instant>>,
}

impl Default for Hub {
    fn default() -> Self {
        Self::new()
    }
}

impl Hub {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(HubInner {
                changes: watch::channel(0).0,
                notifications: broadcast::channel(64).0,
                bye: watch::channel(None).0,
                dedupe: Dedupe::new(),
                last_notified: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Signals that [`RemoteHost::snapshot`] may have changed. Connections coalesce signals
    /// for [`PATCH_DEBOUNCE`] and send one patch.
    pub fn state_changed(&self) {
        self.inner.changes.send_modify(|n| *n = n.wrapping_add(1));
    }

    /// Sends `notification` to every live connection. When `agent_id` is given, at most one
    /// notification per agent is sent per [`NOTIFY_COALESCE`]; returns false when coalesced.
    pub fn notify(&self, notification: Notification, agent_id: Option<&str>) -> bool {
        if let Some(agent) = agent_id {
            let now = Instant::now();
            let mut last = self
                .inner
                .last_notified
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
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

    /// Closes every live connection with `bye reason`. Connections accepted afterwards are
    /// unaffected (stop accepting them separately).
    pub fn close_all(&self, reason: ByeReason) {
        self.inner.bye.send_replace(Some(reason));
    }

    pub fn dedupe(&self) -> &Dedupe {
        &self.inner.dedupe
    }
}

/// Why [`serve_connection`] ended normally.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseReason {
    /// The desktop sent `bye`.
    Bye(ByeReason),
    /// The device closed the connection.
    PeerClosed,
    /// Nothing arrived for [`SILENCE_TIMEOUT`].
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
/// Sends the snapshot (rev 1), then a patch (rev + 1) at most every [`PATCH_DEBOUNCE`] after
/// [`Hub::state_changed`]; answers `ping` itself; runs each `req` on its own task through
/// [`RemoteHost::handle`] with de-duplication; forwards [`Hub::notify`]; sends `bye revoked`
/// as soon as the device is revoked and `bye <reason>` on [`Hub::close_all`].
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
    let AuthenticatedConnection {
        device,
        reader,
        mut writer,
        ..
    } = conn;
    let mut revocations = registry.revocations();
    let mut changes = hub.inner.changes.subscribe();
    let mut notifications = hub.inner.notifications.subscribe();
    let mut bye = hub.inner.bye.subscribe();

    if registry.get(&device.id).is_none_or(|d| d.revoked) {
        return say_bye(&mut writer, ByeReason::Revoked).await;
    }

    let (incoming_tx, mut incoming) = mpsc::channel::<Result<Vec<u8>, Error>>(8);
    let _reader = AbortOnDrop(tokio::spawn(read_loop(reader, incoming_tx)));
    let (responses_tx, mut responses) = mpsc::unbounded_channel::<Response>();

    let mut rev: u64 = 1;
    let mut last = host.snapshot();
    writer
        .send(&HostMessage::Snapshot {
            rev,
            state: Box::new(last.clone()),
        })
        .await?;

    let silence = tokio::time::sleep(SILENCE_TIMEOUT);
    tokio::pin!(silence);
    let mut flush_at: Option<Instant> = None;

    loop {
        tokio::select! {
            message = incoming.recv() => {
                let bytes = match message {
                    None | Some(Err(Error::Closed)) => return Ok(CloseReason::PeerClosed),
                    Some(Err(error)) => return Err(error),
                    Some(Ok(bytes)) => bytes,
                };
                silence.as_mut().reset(Instant::now() + SILENCE_TIMEOUT);
                match serde_json::from_slice::<DeviceMessage>(&bytes) {
                    Ok(DeviceMessage::Ping { n }) => writer.send(&HostMessage::Pong { n }).await?,
                    Ok(DeviceMessage::Hello {}) => {
                        rev += 1;
                        last = host.snapshot();
                        writer.send(&HostMessage::Snapshot { rev, state: Box::new(last.clone()) }).await?;
                    }
                    Ok(DeviceMessage::Req { id, op, args }) => {
                        if let Some(response) = start_request(&host, hub, &device, id, op, args, &responses_tx) {
                            writer.send(&HostMessage::Res(response)).await?;
                        }
                    }
                    Err(error) => {
                        // A malformed request still gets exactly one answer when its id is readable.
                        let value = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
                        match value.get("id").and_then(Value::as_str).filter(|_| value["t"] == "req") {
                            Some(id) => {
                                let response = Response::failure(id, RemoteError::invalid(error.to_string()));
                                writer.send(&HostMessage::Res(response)).await?;
                            }
                            None => tracing::debug!(%error, "remote: ignoring unknown message"),
                        }
                    }
                }
            }
            Some(response) = responses.recv() => writer.send(&HostMessage::Res(response)).await?,
            Ok(()) = changes.changed() => {
                flush_at.get_or_insert_with(|| Instant::now() + PATCH_DEBOUNCE);
            }
            () = tokio::time::sleep_until(flush_at.unwrap_or_else(Instant::now)), if flush_at.is_some() => {
                flush_at = None;
                let next = host.snapshot();
                if let Some(mut patch) = diff::diff(&last, &next) {
                    rev += 1;
                    patch.rev = rev;
                    writer.send(&HostMessage::Patch(Box::new(patch))).await?;
                }
                last = next;
            }
            notification = notifications.recv() => match notification {
                Ok(notification) => writer.send(&HostMessage::Notify(notification)).await?,
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    tracing::warn!(skipped, "remote: notifications dropped for a slow device");
                }
                Err(broadcast::error::RecvError::Closed) => {}
            },
            Ok(()) = bye.changed() => {
                let reason = *bye.borrow_and_update();
                if let Some(reason) = reason {
                    return say_bye(&mut writer, reason).await;
                }
            }
            revoked = revocations.recv() => {
                let ours = match revoked {
                    Ok(id) => id == device.id,
                    Err(broadcast::error::RecvError::Lagged(_)) => registry.get(&device.id).is_none_or(|d| d.revoked),
                    Err(broadcast::error::RecvError::Closed) => false,
                };
                if ours {
                    return say_bye(&mut writer, ByeReason::Revoked).await;
                }
            }
            () = &mut silence => {
                tracing::info!(device = %device.id, "remote: connection silent for 35 s");
                return Ok(CloseReason::Silent);
            }
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

async fn say_bye<W: AsyncWrite + Unpin>(
    writer: &mut NoiseWriter<W>,
    reason: ByeReason,
) -> Result<CloseReason, Error> {
    writer.send(&HostMessage::Bye { reason }).await?;
    let _ = writer.shutdown().await;
    Ok(CloseReason::Bye(reason))
}

/// Starts request `id`. Returns a response to send right away (invalid, or a stored result);
/// otherwise the result arrives on `responses` later.
fn start_request<H: RemoteHost>(
    host: &Arc<H>,
    hub: &Hub,
    device: &Device,
    id: String,
    op: String,
    args: Value,
    responses: &mpsc::UnboundedSender<Response>,
) -> Option<Response> {
    if id.is_empty() || id.len() > MAX_REQUEST_ID {
        return Some(Response::failure(
            id,
            RemoteError::invalid("request ids are 1-128 characters"),
        ));
    }
    if !ops::is_known(&op) {
        return Some(Response::failure(
            id,
            RemoteError::invalid(format!("unknown operation {op}")),
        ));
    }
    match hub.dedupe().begin(&device.id, &id) {
        Begin::Done(response) => Some(response),
        Begin::Pending(mut waiter) => {
            let responses = responses.clone();
            tokio::spawn(async move {
                if let Ok(response) = waiter.wait_for(Option::is_some).await
                    && let Some(response) = response.clone()
                {
                    let _ = responses.send(response);
                }
            });
            None
        }
        Begin::Run => {
            let (host, hub, device, responses) = (
                Arc::clone(host),
                hub.clone(),
                device.clone(),
                responses.clone(),
            );
            tokio::spawn(async move {
                let run = {
                    let (device, op) = (device.clone(), op.clone());
                    tokio::spawn(async move { host.handle(&device, &op, args).await })
                };
                let result = match run.await {
                    Ok(result) => result,
                    Err(error) if error.is_panic() => {
                        tracing::error!(%op, "remote: operation panicked");
                        Err(RemoteError::internal("the operation failed"))
                    }
                    Err(_) => Err(RemoteError::unavailable("the operation was cancelled")),
                };
                let response = Response::from_result(id.clone(), result);
                hub.dedupe().finish(&device.id, &id, response.clone());
                // The connection may be gone; the stored result answers the retry.
                let _ = responses.send(response);
            });
            None
        }
    }
}
