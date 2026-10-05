//! KalCode's side of the bridge: one listener per KalCode run, many sessions.
//!
//! Each accepted connection gets a fresh nonce, must present a request MACed under a registered
//! session's key within [`ServerConfig::read_timeout`], and is answered by that session's
//! [`HookHandler`] (on the blocking pool, so a held approval never stalls other connections).
//! Unauthenticated connections are closed without a reply. Sessions are revoked by dropping their
//! [`Registration`], after which their hooks are rejected (stale sessions).
//!
//! Windows: the first pipe instance is created with `FILE_FLAG_FIRST_PIPE_INSTANCE`, so starting
//! fails if anything else already owns the name (squatting), and every instance rejects remote
//! clients. Unix: the socket lives in the private directory made by [`Endpoint::generate`].

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::key::{SessionKey, is_hex_of_len, random_bytes, random_id};
use crate::wire::{self, Hello, MAX_FRAME, PROTOCOL_VERSION, Request, Response};
use crate::{Endpoint, HookEvent, HookRecord, HookReply};

/// Answers the hook calls of one session. May block (a held approval) up to the ask window.
pub trait HookHandler: Send + Sync {
    fn handle(&self, record: HookRecord) -> HookReply;
}

/// Provider protocol bound to one registration.
///
/// The session key authenticates possession, not which provider-shaped helper created a record.
/// Production registrations bind the accepted event family explicitly so an inherited key cannot
/// use a Codex notify channel to submit Claude approval events, or vice versa.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookChannel {
    Claude,
    Codex,
    Cursor,
}

impl HookChannel {
    fn accepts(self, record: &HookRecord) -> bool {
        let Some(event) = record.event() else {
            return false;
        };
        match self {
            // Codex correlation ids never travel on a Claude registration.
            Self::Claude => HookEvent::CLAUDE.contains(&event) && record.codex_turn_id.is_none(),
            // `notify`, plus Codex's own observing hooks.
            Self::Codex => event == HookEvent::CodexNotify || HookEvent::CODEX.contains(&event),
            Self::Cursor => event == HookEvent::Cursor,
        }
    }

    /// Whether a record on this channel waits for a KalCode decision. Only Claude Code's
    /// `PreToolUse` does; Codex's hooks only observe, so they share the status rate limit.
    fn blocking(self, record: &HookRecord) -> bool {
        self == Self::Claude && record.event().is_some_and(HookEvent::is_blocking)
    }
}

/// Whether KalCode decides a registration's `PreToolUse` calls or only observes them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookGate {
    /// The provider's own permission system decides; KalCode records activity. When a handler is
    /// busy or overruns, the call gets no decision (never a KalCode-forced prompt).
    Observe,
    /// KalCode decides (engine routing). A busy or overrunning handler hands the call to the
    /// provider's own prompt ("ask").
    Decide,
}

#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub endpoint: Endpoint,
    /// Connections served at once; more are closed immediately.
    pub max_connections: usize,
    /// Time a client has to send its request after connecting.
    pub read_timeout: Duration,
    /// Upper bound on a handler call. A handler that overruns gets a fail-safe reply: "ask" for
    /// PreToolUse (the provider's own prompt), an acknowledgement otherwise.
    pub max_hold: Duration,
    /// Handler calls from one registration that may still be executing at once. The permit stays
    /// held when a blocking-pool call outlives [`Self::max_hold`].
    pub max_handlers_per_session: usize,
    /// Non-blocking status calls admitted per registration in one fixed window.
    pub status_burst: usize,
    pub status_window: Duration,
}

impl ServerConfig {
    pub fn new(endpoint: Endpoint) -> Self {
        Self {
            endpoint,
            max_connections: 64,
            read_timeout: Duration::from_secs(5),
            max_hold: crate::helper::ASK_WINDOW + Duration::from_secs(15),
            max_handlers_per_session: 8,
            status_burst: 128,
            status_window: Duration::from_secs(1),
        }
    }
}

/// Counters for diagnostics and tests.
#[derive(Debug, Default)]
struct Stats {
    accepted: AtomicU64,
    served: AtomicU64,
    rejected_auth: AtomicU64,
    rejected_session: AtomicU64,
    rejected_malformed: AtomicU64,
    rejected_busy: AtomicU64,
    rejected_rate: AtomicU64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct StatsSnapshot {
    pub accepted: u64,
    pub served: u64,
    pub rejected_auth: u64,
    pub rejected_session: u64,
    pub rejected_malformed: u64,
    pub rejected_busy: u64,
    pub rejected_rate: u64,
}

#[derive(Debug)]
struct StatusRate {
    window_started: Instant,
    used: usize,
}

impl StatusRate {
    fn new(now: Instant) -> Self {
        Self {
            window_started: now,
            used: 0,
        }
    }

    fn admit(&mut self, now: Instant, burst: usize, window: Duration) -> bool {
        if now.saturating_duration_since(self.window_started) >= window {
            self.window_started = now;
            self.used = 0;
        }
        if self.used >= burst {
            return false;
        }
        self.used += 1;
        true
    }
}

struct Session {
    key: SessionKey,
    handler: Arc<dyn HookHandler>,
    channel: HookChannel,
    gate: HookGate,
    handler_permits: Arc<tokio::sync::Semaphore>,
    status_rate: Arc<Mutex<StatusRate>>,
}

struct Shared {
    endpoint: Endpoint,
    sessions: Mutex<HashMap<String, Session>>,
    stopping: AtomicBool,
    wake: tokio::sync::Notify,
    stats: Stats,
    config: ServerConfig,
}

impl Shared {
    fn sessions(&self) -> std::sync::MutexGuard<'_, HashMap<String, Session>> {
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// A registered session. Its id and key go to the provider's hook settings and environment.
/// Dropping it revokes the session.
pub struct Registration {
    session_id: String,
    key: SessionKey,
    server: Weak<Shared>,
}

impl std::fmt::Debug for Registration {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Registration")
            .field("session_id", &self.session_id)
            .finish_non_exhaustive()
    }
}

impl Registration {
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// The key in the hex form the helper reads from [`crate::KEY_ENV`].
    pub fn key_hex(&self) -> String {
        self.key.to_hex()
    }

    pub fn endpoint(&self) -> Option<Endpoint> {
        self.server.upgrade().map(|s| s.endpoint.clone())
    }
}

impl Drop for Registration {
    fn drop(&mut self) {
        if let Some(server) = self.server.upgrade() {
            server.sessions().remove(&self.session_id);
        }
    }
}

/// The running bridge. Dropping it stops the listener.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum BridgeShutdownError {
    #[error("the hook bridge listener did not stop before the shutdown deadline")]
    TimedOut,
    #[error("the hook bridge listener thread panicked")]
    ListenerPanicked,
}

const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);

struct ListenerThreadState {
    thread: Option<std::thread::JoinHandle<()>>,
    result: Option<Result<(), BridgeShutdownError>>,
}

struct ListenerThread {
    state: Mutex<ListenerThreadState>,
}

impl ListenerThread {
    fn new(thread: std::thread::JoinHandle<()>) -> Self {
        Self {
            state: Mutex::new(ListenerThreadState {
                thread: Some(thread),
                result: None,
            }),
        }
    }

    /// Waits only up to `timeout`. A timeout leaves the join handle owned for a later retry.
    fn wait(&self, timeout: Duration) -> Result<(), BridgeShutdownError> {
        let started = Instant::now();
        loop {
            {
                let mut state = self
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if let Some(result) = state.result {
                    return result;
                }
                if state
                    .thread
                    .as_ref()
                    .is_some_and(std::thread::JoinHandle::is_finished)
                {
                    let Some(thread) = state.thread.take() else {
                        continue;
                    };
                    let result = thread
                        .join()
                        .map_err(|_| BridgeShutdownError::ListenerPanicked);
                    state.result = Some(result);
                    return result;
                }
            }

            let remaining = timeout.saturating_sub(started.elapsed());
            if remaining.is_zero() {
                return Err(BridgeShutdownError::TimedOut);
            }
            std::thread::sleep(remaining.min(Duration::from_millis(5)));
        }
    }
}

pub struct BridgeServer {
    shared: Arc<Shared>,
    thread: ListenerThread,
}

impl BridgeServer {
    /// Binds the endpoint (failing if it is taken) and starts serving on a background thread.
    pub fn start(config: ServerConfig) -> std::io::Result<Self> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .thread_name("kalcode-hook-bridge")
            .build()?;
        let listener = {
            let _guard = runtime.enter();
            Listener::bind(&config.endpoint)?
        };
        let shared = Arc::new(Shared {
            endpoint: config.endpoint.clone(),
            sessions: Mutex::new(HashMap::new()),
            stopping: AtomicBool::new(false),
            wake: tokio::sync::Notify::new(),
            stats: Stats::default(),
            config,
        });
        let serving = shared.clone();
        let thread = std::thread::Builder::new()
            .name("kalcode-hook-bridge".into())
            .spawn(move || {
                runtime.block_on(accept_loop(listener, serving));
                // Don't wait for handlers still holding a request (a pending approval): their
                // helpers fail closed on their own deadline.
                runtime.shutdown_timeout(Duration::from_millis(500));
            })?;
        tracing::info!(event = "hook_bridge.started");
        Ok(Self {
            shared,
            thread: ListenerThread::new(thread),
        })
    }

    pub fn endpoint(&self) -> &Endpoint {
        &self.shared.endpoint
    }

    /// Registers a session restricted to one provider event family, decided by KalCode.
    pub fn register_channel(
        &self,
        handler: Arc<dyn HookHandler>,
        channel: HookChannel,
    ) -> std::io::Result<Registration> {
        self.register_channel_with(handler, channel, HookGate::Decide)
    }

    /// Registers a session restricted to one provider event family with an explicit gate.
    pub fn register_channel_with(
        &self,
        handler: Arc<dyn HookHandler>,
        channel: HookChannel,
        gate: HookGate,
    ) -> std::io::Result<Registration> {
        let session_id = random_id()?;
        let key = SessionKey::generate()?;
        self.shared.sessions().insert(
            session_id.clone(),
            Session {
                key: key.clone(),
                handler,
                channel,
                gate,
                handler_permits: Arc::new(tokio::sync::Semaphore::new(
                    self.shared.config.max_handlers_per_session,
                )),
                status_rate: Arc::new(Mutex::new(StatusRate::new(Instant::now()))),
            },
        );
        Ok(Registration {
            session_id,
            key,
            server: Arc::downgrade(&self.shared),
        })
    }

    pub fn session_count(&self) -> usize {
        self.shared.sessions().len()
    }

    pub fn stats(&self) -> StatsSnapshot {
        let s = &self.shared.stats;
        StatsSnapshot {
            accepted: s.accepted.load(Ordering::SeqCst),
            served: s.served.load(Ordering::SeqCst),
            rejected_auth: s.rejected_auth.load(Ordering::SeqCst),
            rejected_session: s.rejected_session.load(Ordering::SeqCst),
            rejected_malformed: s.rejected_malformed.load(Ordering::SeqCst),
            rejected_busy: s.rejected_busy.load(Ordering::SeqCst),
            rejected_rate: s.rejected_rate.load(Ordering::SeqCst),
        }
    }

    /// Stops accepting and proves the listener exited within a bounded deadline. Every concurrent
    /// caller waits for the same terminal result; a timeout retains the join handle for retry.
    pub fn shutdown_checked(&self) -> Result<(), BridgeShutdownError> {
        self.shared.stopping.store(true, Ordering::SeqCst);
        // Wakes the accept loop (a stored permit if it isn't waiting yet).
        self.shared.wake.notify_one();
        self.thread.wait(SHUTDOWN_TIMEOUT)?;
        #[cfg(unix)]
        {
            let path = self.shared.endpoint.path();
            let _ = std::fs::remove_file(&path);
            if let Some(dir) = path.parent() {
                let _ = std::fs::remove_dir(dir);
            }
        }
        tracing::info!(event = "hook_bridge.stopped");
        Ok(())
    }

    /// Compatibility wrapper for callers that cannot surface shutdown failure yet.
    pub fn shutdown(&self) {
        if let Err(error) = self.shutdown_checked() {
            tracing::error!(event = "hook_bridge.shutdown_incomplete", error = %error);
        }
    }
}

impl Drop for BridgeServer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(windows)]
mod platform {
    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

    use crate::Endpoint;

    pub struct Listener {
        name: String,
        next: NamedPipeServer,
    }

    pub type Conn = NamedPipeServer;

    impl Listener {
        pub fn bind(endpoint: &Endpoint) -> std::io::Result<Self> {
            let next = ServerOptions::new()
                .first_pipe_instance(true)
                .reject_remote_clients(true)
                .create(endpoint.as_str())?;
            Ok(Self {
                name: endpoint.as_str().to_owned(),
                next,
            })
        }

        pub async fn accept(&mut self) -> std::io::Result<Conn> {
            self.next.connect().await?;
            let fresh = ServerOptions::new()
                .reject_remote_clients(true)
                .create(&self.name)?;
            Ok(std::mem::replace(&mut self.next, fresh))
        }
    }
}

#[cfg(unix)]
mod platform {
    use tokio::net::{UnixListener, UnixStream};

    use crate::Endpoint;

    pub struct Listener(UnixListener);
    pub type Conn = UnixStream;

    impl Listener {
        pub fn bind(endpoint: &Endpoint) -> std::io::Result<Self> {
            Ok(Self(UnixListener::bind(endpoint.path())?))
        }

        pub async fn accept(&mut self) -> std::io::Result<Conn> {
            Ok(self.0.accept().await?.0)
        }
    }
}

use platform::Listener;

async fn accept_loop(mut listener: Listener, shared: Arc<Shared>) {
    let permits = Arc::new(tokio::sync::Semaphore::new(shared.config.max_connections));
    loop {
        let accepted = {
            let mut accept = std::pin::pin!(listener.accept());
            let mut stop = std::pin::pin!(shared.wake.notified());
            std::future::poll_fn(|cx| {
                if let std::task::Poll::Ready(result) = accept.as_mut().poll(cx) {
                    return std::task::Poll::Ready(Some(result));
                }
                if stop.as_mut().poll(cx).is_ready() {
                    return std::task::Poll::Ready(None);
                }
                std::task::Poll::Pending
            })
            .await
        };
        let Some(accepted) = accepted else {
            break;
        };
        let conn = match accepted {
            Ok(conn) => conn,
            Err(error) => {
                if shared.stopping.load(Ordering::SeqCst) {
                    break;
                }
                tracing::warn!(event = "hook_bridge.accept_failed", error = %error);
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            }
        };
        if shared.stopping.load(Ordering::SeqCst) {
            break;
        }
        shared.stats.accepted.fetch_add(1, Ordering::SeqCst);
        let Ok(permit) = permits.clone().try_acquire_owned() else {
            shared.stats.rejected_busy.fetch_add(1, Ordering::SeqCst);
            drop(conn);
            continue;
        };
        let shared = shared.clone();
        tokio::spawn(async move {
            serve(conn, &shared, permit).await;
        });
    }
}

async fn write_frame<W: AsyncWrite + Unpin, T: serde::Serialize>(
    writer: &mut W,
    value: &T,
) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(value).map_err(std::io::Error::other)?;
    if bytes.len() > MAX_FRAME {
        return Err(std::io::Error::other("frame too large"));
    }
    let mut out = Vec::with_capacity(4 + bytes.len());
    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(&bytes);
    writer.write_all(&out).await?;
    writer.flush().await
}

async fn read_frame<R: AsyncRead + Unpin, T: for<'de> serde::Deserialize<'de>>(
    reader: &mut R,
) -> std::io::Result<T> {
    let mut len = [0u8; 4];
    reader.read_exact(&mut len).await?;
    let len = u32::from_be_bytes(len) as usize;
    if len > MAX_FRAME {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "frame too large",
        ));
    }
    let mut bytes = vec![0u8; len];
    reader.read_exact(&mut bytes).await?;
    serde_json::from_slice(&bytes)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

/// The fail-safe reply when a handler can't answer.
fn fallback(channel: HookChannel, record: &HookRecord, gate: HookGate) -> HookReply {
    match (channel.blocking(record), gate) {
        (true, HookGate::Decide) => HookReply::Ask {
            reason: "KalCode couldn't decide in time; answer in the provider.".into(),
        },
        (true, HookGate::Observe) => HookReply::NoDecision,
        (false, _) => HookReply::Ack,
    }
}

async fn serve<C: AsyncRead + AsyncWrite + Unpin>(
    mut conn: C,
    shared: &Shared,
    connection_permit: tokio::sync::OwnedSemaphorePermit,
) {
    let stats = &shared.stats;
    let Ok(nonce) = random_bytes::<32>() else {
        return;
    };
    let server_nonce = hex::encode(nonce);
    let hello = Hello {
        v: PROTOCOL_VERSION,
        nonce: server_nonce.clone(),
    };
    if write_frame(&mut conn, &hello).await.is_err() {
        return;
    }
    let request: Request =
        match tokio::time::timeout(shared.config.read_timeout, read_frame(&mut conn)).await {
            Ok(Ok(request)) => request,
            _ => {
                stats.rejected_malformed.fetch_add(1, Ordering::SeqCst);
                return;
            }
        };
    if request.v != PROTOCOL_VERSION || !is_hex_of_len(&request.nonce, 64) {
        stats.rejected_malformed.fetch_add(1, Ordering::SeqCst);
        return;
    }
    let (key, handler, channel, gate, handler_permits, status_rate) = {
        let sessions = shared.sessions();
        match sessions.get(&request.session) {
            Some(session) => (
                session.key.clone(),
                session.handler.clone(),
                session.channel,
                session.gate,
                session.handler_permits.clone(),
                session.status_rate.clone(),
            ),
            None => {
                stats.rejected_session.fetch_add(1, Ordering::SeqCst);
                tracing::warn!(event = "hook_bridge.unknown_session");
                return;
            }
        }
    };
    if !wire::verify_request(
        &key,
        &server_nonce,
        &request.nonce,
        &request.session,
        &request.body,
        &request.mac,
    ) {
        stats.rejected_auth.fetch_add(1, Ordering::SeqCst);
        tracing::warn!(event = "hook_bridge.auth_failed");
        return;
    }
    let Ok(record) = serde_json::from_str::<HookRecord>(&request.body) else {
        stats.rejected_malformed.fetch_add(1, Ordering::SeqCst);
        return;
    };
    if record.validate().is_err() {
        stats.rejected_malformed.fetch_add(1, Ordering::SeqCst);
        return;
    }
    if !channel.accepts(&record) {
        stats.rejected_malformed.fetch_add(1, Ordering::SeqCst);
        tracing::warn!(event = "hook_bridge.wrong_channel");
        return;
    }
    let safe = fallback(channel, &record, gate);
    let rate_limited = !channel.blocking(&record)
        && !status_rate
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .admit(
                Instant::now(),
                shared.config.status_burst,
                shared.config.status_window,
            );
    let reply = if rate_limited {
        stats.rejected_rate.fetch_add(1, Ordering::SeqCst);
        safe
    } else if let Ok(handler_permit) = handler_permits.try_acquire_owned() {
        let work = tokio::task::spawn_blocking(move || {
            // A timed-out spawn_blocking task cannot be cancelled. Keep both admission permits
            // until the handler really exits so repeated overruns cannot grow the blocking pool
            // or one registration's in-flight work without bound.
            let _permits = (connection_permit, handler_permit);
            handler.handle(record)
        });
        match tokio::time::timeout(shared.config.max_hold, work).await {
            Ok(Ok(reply)) => reply,
            _ => safe,
        }
    } else {
        stats.rejected_busy.fetch_add(1, Ordering::SeqCst);
        safe
    };
    let Ok(body) = serde_json::to_string(&reply) else {
        return;
    };
    let mac = wire::response_mac(&key, &server_nonce, &request.nonce, &body);
    let response = Response {
        v: PROTOCOL_VERSION,
        body,
        mac,
    };
    if write_frame(&mut conn, &response).await.is_ok() {
        stats.served.fetch_add(1, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod shutdown_tests {
    use std::sync::mpsc;

    use super::*;

    #[test]
    fn timeout_retains_listener_ownership_for_a_later_retry() {
        let (release, held) = mpsc::channel();
        let listener = ListenerThread::new(std::thread::spawn(move || {
            held.recv().expect("release listener");
        }));

        assert_eq!(
            listener.wait(Duration::ZERO),
            Err(BridgeShutdownError::TimedOut)
        );
        release.send(()).expect("release");
        assert_eq!(listener.wait(Duration::from_secs(1)), Ok(()));
        assert_eq!(listener.wait(Duration::ZERO), Ok(()));
    }

    #[test]
    fn listener_panic_is_typed_and_repeatable() {
        let listener = ListenerThread::new(std::thread::spawn(|| panic!("listener failed")));

        assert_eq!(
            listener.wait(Duration::from_secs(1)),
            Err(BridgeShutdownError::ListenerPanicked)
        );
        assert_eq!(
            listener.wait(Duration::ZERO),
            Err(BridgeShutdownError::ListenerPanicked)
        );
    }
}
