//! KalCode Remote's desktop host (`docs/REMOTE_PROTOCOL.md`): a paired phone or tablet mirrors
//! this workstation and acts through the same services as the desktop UI and KalVoice.
//!
//! Account-scoped: it lives in the runtime bundle, so signing out closes every connection and
//! stops the listener. The listener runs only while the person turned Remote on (persisted,
//! default off) and the account is entitled. The protocol (Noise IK, pairing, registry,
//! patches) is `crates/remote`; this module supplies the state, the operations and the socket.

mod actions;
mod host;
mod net;
pub mod snapshot;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use kalcode_contracts::app::FeatureId;
use kalcode_contracts::events::{EventEnvelope, EventPayload};
use kalcode_contracts::threads::ThreadStatus;
use kalcode_core::flags::SurfaceState;
use kalcode_core::plans::PlanTier;
use kalcode_core::{IpcError, KalError};
use kalcode_remote::noise::StaticKeypair;
use kalcode_remote::pairing::Pairing;
use kalcode_remote::registry::Registry;
use kalcode_remote::server::{self, HostIdentity, Hub};
use kalcode_remote::wire::{
    ByeReason, HostBuild, Notification, NotifyKind, RejectReason, Workstation, link,
};
use kalcode_secure_store::{OsSecretStore, SecretKey, SecretStore, SecretString};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use time::OffsetDateTime;

use crate::AppState;
use crate::account::runtime::AccountRuntime;
use crate::runtime_coordinator::RuntimeState;
use crate::thread_commands::ThreadsState;
use host::DesktopHost;

/// Most devices connected at once; one more is answered `busy`.
const MAX_CONNECTIONS: usize = 8;
/// The window's cue to re-read `remote_status`.
pub const CHANGED_EVENT: &str = "remote-changed";
/// The workstation's long-term key in the OS secret store.
const HOST_KEY: &str = "remote:host-key";
/// How often Operations (runs, services, environments) is re-read while a device is connected.
const OPERATIONS_EVERY: Duration = Duration::from_secs(5);
/// Time-based Needs You items (stalled agents) are re-derived at least this often.
const RECHECK_EVERY: Duration = Duration::from_secs(60);

/// Whether this account may use Remote right now: the build ships it and the plan includes it
/// (`FeatureId::Remote.placement()`, MAX and up).
pub fn entitled(app: &AppHandle) -> bool {
    let built = app
        .state::<AppState>()
        .info
        .flags
        .feature(FeatureId::Remote)
        .is_some_and(|flag| {
            flag.visible && matches!(flag.state, SurfaceState::Available | SurfaceState::Preview)
        });
    built
        && app
            .try_state::<Arc<AccountRuntime>>()
            .is_some_and(|account| tier_allows(account.snapshot().plan_tier()))
}

/// The plans that include Remote (see [`entitled`]): its MAX placement, plus OWNER.
pub fn tier_allows(tier: PlanTier) -> bool {
    let rank = match tier {
        PlanTier::Free => 0,
        PlanTier::Pro => 1,
        PlanTier::Max => 2,
        PlanTier::Max2x => 3,
        PlanTier::Owner => return true,
    };
    FeatureId::Remote.placement().included_in(rank)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    workstation_id: Option<String>,
}

/// What Settings › Remote shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    /// This account's plan includes Remote (MAX and up).
    pub available: bool,
    pub enabled: bool,
    pub listening: bool,
    pub port: Option<u16>,
    /// `ip:port` a device can reach.
    pub addresses: Vec<String>,
    pub error: Option<StatusError>,
    pub machine_name: String,
    pub pairing: Option<PairingView>,
    /// Paired devices (revoked ones are left out).
    pub devices: Vec<DeviceView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingView {
    /// `kalcode-remote://pair?d=…`, single use.
    pub link: String,
    /// The link as a QR code (SVG, dark modules on white).
    pub qr_svg: String,
    /// Unix seconds.
    pub expires_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub model: String,
    pub app: String,
    pub paired_at: String,
    pub last_seen_at: Option<String>,
    pub online: bool,
}

#[derive(Default)]
struct Listener {
    task: Option<tauri::async_runtime::JoinHandle<()>>,
    port: Option<u16>,
    addresses: Vec<String>,
    error: Option<StatusError>,
}

enum Signal {
    Event(EventPayload),
    Stop,
}

/// The account's Remote host.
pub struct RemoteState {
    inner: Arc<Inner>,
}

struct Inner {
    app: AppHandle,
    dir: PathBuf,
    registry: Result<Arc<Registry>, String>,
    pairing: Arc<Pairing>,
    hub: Hub,
    host: Arc<DesktopHost>,
    settings: Mutex<Settings>,
    key: Mutex<Option<StaticKeypair>>,
    listener: Mutex<Listener>,
    online: Mutex<HashMap<String, usize>>,
    ticket: Mutex<Option<PairingView>>,
    connections: Arc<tokio::sync::Semaphore>,
    subscription: Mutex<Option<kalcode_core::events::SubscriptionId>>,
    worker: Mutex<Option<mpsc::SyncSender<Signal>>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn failure(code: &'static str, message: impl Into<String>) -> IpcError {
    KalError::validation(code, message.into()).to_ipc()
}

impl RemoteState {
    /// Opens this account's Remote state (`<data>/remote/<account>/`) and, when Remote was left
    /// on and the account is entitled, starts listening.
    pub fn start(app: &AppHandle, state: &AppState, account_id: &str) -> Self {
        let digest = Sha256::digest(account_id.as_bytes());
        let dir = state
            .paths
            .data_dir
            .join("remote")
            .join(&format!("{digest:x}")[..24]);
        let settings: Settings = std::fs::read(dir.join("settings.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        let registry = Registry::open(dir.join("remote-devices.json"))
            .map(Arc::new)
            .map_err(|_| {
                "KalCode couldn't read its list of paired devices. Remote stays off until it can."
                    .to_owned()
            });
        let workstation = Workstation {
            id: settings.workstation_id.clone().unwrap_or_default(),
            name: net::machine_name(),
            platform: platform().into(),
            version: public_version(&state.info.version).into(),
            build: build_number(&state.info.version),
            active_workspace_id: None,
        };
        let inner = Arc::new(Inner {
            app: app.clone(),
            dir,
            registry,
            pairing: Arc::new(Pairing::new()),
            hub: Hub::new(),
            host: Arc::new(DesktopHost {
                app: app.clone(),
                workstation: Mutex::new(workstation),
                operations: Mutex::default(),
            }),
            settings: Mutex::new(settings),
            key: Mutex::new(None),
            listener: Mutex::default(),
            online: Mutex::default(),
            ticket: Mutex::new(None),
            connections: Arc::new(tokio::sync::Semaphore::new(MAX_CONNECTIONS)),
            subscription: Mutex::new(None),
            worker: Mutex::new(None),
        });
        inner.start_worker(state);
        if lock(&inner.settings).enabled && entitled(app) {
            let _ = inner.start_listener();
        }
        Self { inner }
    }

    /// Closes every connection and stops listening (sign-out, account switch, exit).
    pub fn shutdown(&self) {
        let inner = &self.inner;
        inner.hub.close_all(ByeReason::Shutdown);
        inner.stop_listener();
        if let (Some(id), Some(core)) = (
            lock(&inner.subscription).take(),
            inner.app.state::<AppState>().core.clone(),
        ) {
            core.unsubscribe(id);
        }
        if let Some(worker) = lock(&inner.worker).take() {
            let _ = worker.try_send(Signal::Stop);
        }
    }

    pub fn status(&self) -> RemoteStatus {
        self.inner.status()
    }

    pub fn set_enabled(&self, enabled: bool) -> Result<RemoteStatus, IpcError> {
        let inner = &self.inner;
        if enabled {
            if !entitled(&inner.app) {
                return Err(failure(
                    "remote_not_entitled",
                    "KalCode Remote isn't included in this account's plan.",
                ));
            }
            inner
                .registry()
                .map_err(|m| failure("remote_unavailable", m))?;
            inner.save_settings(|s| s.enabled = true)?;
            // A listener failure is part of the status (with its fix), not an IPC error.
            let _ = inner.start_listener();
        } else {
            inner.save_settings(|s| s.enabled = false)?;
            inner.pairing.close();
            *lock(&inner.ticket) = None;
            inner.hub.close_all(ByeReason::Disabled);
            inner.stop_listener();
        }
        inner.changed();
        Ok(inner.status())
    }

    /// Opens a 5-minute single-use pairing window and returns its QR code and link.
    pub fn pair_start(&self) -> Result<RemoteStatus, IpcError> {
        let inner = &self.inner;
        if !entitled(&inner.app) {
            return Err(failure(
                "remote_not_entitled",
                "KalCode Remote isn't included in this account's plan.",
            ));
        }
        let addresses = lock(&inner.listener).addresses.clone();
        if lock(&inner.listener).task.is_none() {
            return Err(failure(
                "remote_off",
                "Turn on Remote first, then pair your device.",
            ));
        }
        if addresses.is_empty() {
            return Err(failure(
                "remote_no_network",
                "This computer has no network address a phone can reach. Connect to Wi-Fi, Ethernet or Tailscale, then try again.",
            ));
        }
        let identity = inner.identity()?;
        let ticket = inner.pairing.open().map_err(|_| {
            failure(
                "remote_pairing_failed",
                "KalCode couldn't start pairing. Try again.",
            )
        })?;
        let link = ticket
            .payload(
                &identity.workstation_id,
                &identity.name,
                &identity.key,
                addresses,
            )
            .to_link()
            .map_err(|_| {
                failure(
                    "remote_pairing_failed",
                    "KalCode couldn't start pairing. Try again.",
                )
            })?;
        let qr_svg = qr_svg(&link).ok_or_else(|| {
            failure(
                "remote_pairing_failed",
                "KalCode couldn't draw the pairing code. Try again.",
            )
        })?;
        *lock(&inner.ticket) = Some(PairingView {
            link,
            qr_svg,
            expires_at: ticket.expires_at,
        });
        inner.changed();
        Ok(inner.status())
    }

    pub fn pair_cancel(&self) -> RemoteStatus {
        self.inner.pairing.close();
        *lock(&self.inner.ticket) = None;
        self.inner.changed();
        self.inner.status()
    }

    /// Removes a device: its key is refused from now on and a live connection is closed.
    pub fn revoke(&self, device_id: &str) -> Result<RemoteStatus, IpcError> {
        let registry = self
            .inner
            .registry()
            .map_err(|m| failure("remote_unavailable", m))?;
        if registry.get(device_id).is_none_or(|d| d.revoked) {
            return Err(failure(
                "remote_device_unknown",
                "That device is no longer paired.",
            ));
        }
        registry.revoke(device_id).map_err(|_| {
            failure(
                "remote_revoke_failed",
                "KalCode couldn't remove that device. Try again.",
            )
        })?;
        self.inner.changed();
        Ok(self.inner.status())
    }
}

impl Inner {
    fn registry(&self) -> Result<&Arc<Registry>, String> {
        self.registry.as_ref().map_err(Clone::clone)
    }

    /// Tells the window to re-read the status.
    fn changed(&self) {
        let _ = self.app.emit_to("main", CHANGED_EVENT, ());
    }

    fn save_settings(&self, change: impl FnOnce(&mut Settings)) -> Result<(), IpcError> {
        let mut settings = lock(&self.settings);
        let mut next = settings.clone();
        change(&mut next);
        let json = serde_json::to_vec_pretty(&next).unwrap_or_default();
        std::fs::create_dir_all(&self.dir)
            .and_then(|()| {
                let tmp = self.dir.join("settings.json.tmp");
                std::fs::write(&tmp, json)?;
                std::fs::rename(tmp, self.dir.join("settings.json"))
            })
            .map_err(|_| {
                failure(
                    "remote_settings_failed",
                    "KalCode couldn't save the Remote setting. Check disk access.",
                )
            })?;
        *settings = next;
        Ok(())
    }

    /// The workstation identity: the long-term key from the OS secret store and the stable
    /// workstation id, both created on first use.
    fn identity(&self) -> Result<HostIdentity, IpcError> {
        let key = {
            let mut key = lock(&self.key);
            if key.is_none() {
                *key = Some(load_host_key()?);
            }
            key.clone().ok_or_else(|| {
                failure("remote_key_failed", "KalCode couldn't open its Remote key.")
            })?
        };
        // Bound first: a guard in the `match` scrutinee would live through `save_settings`.
        let stored = lock(&self.settings).workstation_id.clone();
        let workstation_id = match stored {
            Some(id) => id,
            None => {
                let id = kalcode_remote::random_id("ws_").map_err(|_| {
                    failure(
                        "remote_key_failed",
                        "KalCode couldn't create the workstation id.",
                    )
                })?;
                self.save_settings(|s| s.workstation_id = Some(id.clone()))?;
                id
            }
        };
        let base = {
            let mut workstation = lock(&self.host.workstation);
            workstation.id.clone_from(&workstation_id);
            workstation.clone()
        };
        Ok(HostIdentity {
            key,
            workstation_id,
            name: base.name.clone(),
            build: HostBuild {
                platform: base.platform.clone(),
                version: base.version.clone(),
                build: base.build,
            },
        })
    }

    fn start_listener(self: &Arc<Self>) -> Result<(), ()> {
        if lock(&self.listener).task.is_some() {
            return Ok(());
        }
        let fail = |code: &str, message: String| {
            let mut listener = lock(&self.listener);
            listener.error = Some(StatusError {
                code: code.into(),
                message,
            });
        };
        let registry = match self.registry() {
            Ok(registry) => registry.clone(),
            Err(message) => {
                fail("remote_unavailable", message);
                return Err(());
            }
        };
        let identity = match self.identity() {
            Ok(identity) => identity,
            Err(error) => {
                fail("remote_key_failed", error.message);
                return Err(());
            }
        };
        let socket = match net::bind() {
            Ok(socket) => socket,
            Err(error) => {
                fail(error.code, error.message);
                return Err(());
            }
        };
        let port = socket.local_addr().map(|a| a.port()).unwrap_or_default();
        let weak = Arc::downgrade(self);
        let task = tauri::async_runtime::spawn(accept_loop(
            socket,
            weak,
            identity,
            registry,
            self.host.clone(),
        ));
        let mut listener = lock(&self.listener);
        listener.task = Some(task);
        listener.port = Some(port);
        listener.addresses = net::advertised_addresses(port);
        listener.error = None;
        tracing::info!(
            event = "remote.listening",
            port,
            addresses = listener.addresses.len()
        );
        Ok(())
    }

    fn stop_listener(&self) {
        let mut listener = lock(&self.listener);
        if let Some(task) = listener.task.take() {
            task.abort();
            tracing::info!(event = "remote.stopped");
        }
        listener.port = None;
        listener.addresses.clear();
        listener.error = None;
    }

    fn status(&self) -> RemoteStatus {
        let available = entitled(&self.app);
        let enabled = lock(&self.settings).enabled;
        let listener = lock(&self.listener);
        let mut ticket = lock(&self.ticket);
        if ticket.as_ref().is_some_and(|t| {
            t.expires_at <= OffsetDateTime::now_utc().unix_timestamp() || !self.pairing.is_open()
        }) {
            *ticket = None;
        }
        let online = lock(&self.online);
        let devices = self
            .registry()
            .map(|registry| {
                registry
                    .list()
                    .into_iter()
                    .filter(|d| !d.revoked)
                    .map(|d| DeviceView {
                        online: online.get(&d.id).is_some_and(|n| *n > 0),
                        id: d.id,
                        name: d.name,
                        platform: d.platform,
                        model: d.model,
                        app: d.app,
                        paired_at: rfc3339(d.paired_at),
                        last_seen_at: d.last_seen_at.map(rfc3339),
                    })
                    .collect()
            })
            .unwrap_or_default();
        let error = match (&self.registry, &listener.error) {
            (Err(message), _) => Some(StatusError {
                code: "remote_unavailable".into(),
                message: message.clone(),
            }),
            (_, error) => error.clone(),
        };
        RemoteStatus {
            available,
            enabled,
            listening: listener.task.is_some(),
            port: listener.port,
            addresses: listener.addresses.clone(),
            error: if enabled { error } else { None },
            machine_name: self.host.workstation().name,
            pairing: ticket.clone(),
            devices,
        }
    }

    fn online(&self, device_id: &str, delta: isize) {
        let mut online = lock(&self.online);
        let count = online.entry(device_id.to_owned()).or_default();
        *count = count.saturating_add_signed(delta);
        if *count == 0 {
            online.remove(device_id);
        }
    }

    /// Subscribes to the event bus. The subscriber runs under the core's connection lock, so it
    /// only queues; a worker thread turns events into patches and notifications.
    fn start_worker(self: &Arc<Self>, state: &AppState) {
        let Some(core) = state.core.clone() else {
            return;
        };
        let (tx, rx) = mpsc::sync_channel::<Signal>(256);
        let events = tx.clone();
        let id = core.subscribe(move |envelope: &EventEnvelope| {
            // A full queue drops one event; the next one still triggers a patch.
            let _ = events.try_send(Signal::Event(envelope.event.clone()));
            true
        });
        *lock(&self.subscription) = Some(id);
        *lock(&self.worker) = Some(tx);
        let weak = Arc::downgrade(self);
        let spawned = std::thread::Builder::new()
            .name("kalcode-remote".into())
            .spawn(move || worker(&weak, &rx));
        if spawned.is_err() {
            tracing::warn!(event = "remote.worker_failed");
        }
    }
}

fn worker(weak: &std::sync::Weak<Inner>, rx: &mpsc::Receiver<Signal>) {
    let mut last_operations = std::time::Instant::now() - OPERATIONS_EVERY;
    let mut last_recheck = std::time::Instant::now();
    loop {
        let signal = rx.recv_timeout(OPERATIONS_EVERY);
        let Some(inner) = weak.upgrade() else {
            return;
        };
        match signal {
            Ok(Signal::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => return,
            Ok(Signal::Event(event)) => {
                inner.hub.state_changed();
                if let Some((notification, agent)) = notification_for(&inner.app, &event) {
                    inner.hub.notify(notification, agent.as_deref());
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        // Only while a device is connected: Operations is the heavy part of the state.
        let connected = !lock(&inner.online).is_empty();
        if connected && last_operations.elapsed() >= OPERATIONS_EVERY {
            last_operations = std::time::Instant::now();
            if let Some((previous, next)) = inner.host.refresh_operations() {
                inner.hub.state_changed();
                for run in failed_runs(&previous, &next) {
                    inner.hub.notify(run, None);
                }
            }
        }
        if connected && last_recheck.elapsed() >= RECHECK_EVERY {
            last_recheck = std::time::Instant::now();
            inner.hub.state_changed();
        }
    }
}

/// §6: decisions and outcomes only. An agent that needs the person, failed or finished.
fn notification_for(
    app: &AppHandle,
    event: &EventPayload,
) -> Option<(Notification, Option<String>)> {
    let (thread_id, kind, title, body, target) = match event {
        EventPayload::ApprovalRequested {
            request_id,
            thread_id,
            summary,
            ..
        } => (
            thread_id,
            NotifyKind::NeedsYou,
            "needs your approval",
            summary.clone(),
            link::needs(&format!("approval:{request_id}")),
        ),
        EventPayload::ThreadStatusChanged {
            thread_id,
            to,
            from,
            ..
        } => match to {
            ThreadStatus::WaitingForUser => (
                thread_id,
                NotifyKind::NeedsYou,
                "asked you a question",
                "Open it to reply.".to_owned(),
                link::agent(thread_id),
            ),
            ThreadStatus::Idle if busy(*from) => (
                thread_id,
                NotifyKind::AgentDone,
                "finished",
                "Open it to review its work.".to_owned(),
                link::agent(thread_id),
            ),
            _ => return None,
        },
        EventPayload::ThreadFailed {
            thread_id, message, ..
        } => (
            thread_id,
            NotifyKind::AgentFailed,
            "failed",
            message.clone(),
            link::agent(thread_id),
        ),
        EventPayload::ThreadCompleted { thread_id } => (
            thread_id,
            NotifyKind::AgentDone,
            "finished",
            "Open it to review its work.".to_owned(),
            link::agent(thread_id),
        ),
        _ => return None,
    };
    if thread_id.is_empty() {
        return None;
    }
    let name = RuntimeState::<ThreadsState>::from_app(app)
        .ok()
        .and_then(|threads| threads.runtime().ok()?.get(thread_id).ok())
        .map_or_else(|| "An agent".to_owned(), |t| t.name);
    Some((
        Notification {
            id: kalcode_remote::random_id("ntf_").ok()?,
            kind,
            title: format!("{name} {title}"),
            body,
            link: target,
        },
        Some(thread_id.clone()),
    ))
}

fn busy(status: ThreadStatus) -> bool {
    matches!(
        status,
        ThreadStatus::Active
            | ThreadStatus::Thinking
            | ThreadStatus::RunningTool
            | ThreadStatus::RunningCommand
            | ThreadStatus::Editing
            | ThreadStatus::Testing
            | ThreadStatus::Reviewing
    )
}

/// Runs that turned failed between two Operations reads.
fn failed_runs(previous: &snapshot::Operations, next: &snapshot::Operations) -> Vec<Notification> {
    next.runs
        .iter()
        .filter(|run| run.status == "failed")
        .filter(|run| {
            previous
                .runs
                .iter()
                .find(|p| p.id == run.id)
                .is_some_and(|p| p.status != "failed")
        })
        .filter_map(|run| {
            Some(Notification {
                id: kalcode_remote::random_id("ntf_").ok()?,
                kind: NotifyKind::RunFailed,
                title: format!("{} failed", run.title),
                body: run
                    .outcome
                    .clone()
                    .unwrap_or_else(|| "Open it to see what happened.".into()),
                link: link::run(&run.id),
            })
        })
        .collect()
}

async fn accept_loop(
    socket: std::net::TcpListener,
    weak: std::sync::Weak<Inner>,
    identity: HostIdentity,
    registry: Arc<Registry>,
    host: Arc<DesktopHost>,
) {
    let Ok(listener) = tokio::net::TcpListener::from_std(socket) else {
        return;
    };
    while let Ok((tcp, peer)) = listener.accept().await {
        let Some(inner) = weak.upgrade() else {
            break;
        };
        // Pre-auth limits (all handshakes and per address) before a byte is read: over them,
        // the socket is just dropped.
        let Some(handshake) = inner.hub.admit(peer.ip()) else {
            continue;
        };
        let _ = tcp.set_nodelay(true);
        let identity = identity.clone();
        let Ok(permit) = inner.connections.clone().try_acquire_owned() else {
            tauri::async_runtime::spawn(async move {
                let _ = server::reject(tcp, &identity, RejectReason::Busy).await;
                drop(handshake);
            });
            continue;
        };
        let (registry, host, weak) = (registry.clone(), host.clone(), weak.clone());
        drop(inner);
        tauri::async_runtime::spawn(async move {
            let _permit = permit;
            let Some(inner) = weak.upgrade() else {
                return;
            };
            let entitled = entitled(&inner.app);
            let pairing = inner.pairing.clone();
            let hub = inner.hub.clone();
            drop(inner);
            let accepted = server::accept(tcp, &identity, &registry, &pairing, entitled).await;
            drop(handshake);
            let conn = match accepted {
                Ok(conn) => conn,
                Err(error) => {
                    tracing::debug!(event = "remote.handshake_refused", error = %error);
                    if let Some(inner) = weak.upgrade() {
                        inner.changed();
                    }
                    return;
                }
            };
            let device = conn.device.id.clone();
            // The first device of a session waits for Operations rather than seeing it empty.
            if host.operations() == snapshot::Operations::default() {
                let host = host.clone();
                let _ =
                    tauri::async_runtime::spawn_blocking(move || host.refresh_operations()).await;
            }
            if let Some(inner) = weak.upgrade() {
                inner.online(&device, 1);
                if !pairing.is_open() {
                    *lock(&inner.ticket) = None;
                }
                inner.changed();
            }
            let outcome = server::serve_connection(conn, host.clone(), &hub, &registry).await;
            tracing::info!(event = "remote.disconnected", outcome = ?outcome.as_ref().map_err(ToString::to_string));
            if let Some(inner) = weak.upgrade() {
                inner.online(&device, -1);
                inner.changed();
            }
        });
    }
}

fn load_host_key() -> Result<StaticKeypair, IpcError> {
    let unavailable = || {
        failure(
            "remote_key_failed",
            "KalCode couldn't open its Remote key in the system's secure storage. Check that it's unlocked, then try again.",
        )
    };
    let store = OsSecretStore::new();
    let key = SecretKey::new(HOST_KEY).map_err(|_| unavailable())?;
    if let Some(stored) = store.get(&key).map_err(|_| unavailable())? {
        return StaticKeypair::from_private_base64(stored.expose_secret())
            .map_err(|_| unavailable());
    }
    let generated = StaticKeypair::generate().map_err(|_| unavailable())?;
    store
        .set(
            &key,
            &SecretString::new(generated.private_base64().as_str().to_owned()),
        )
        .map_err(|_| unavailable())?;
    Ok(generated)
}

fn qr_svg(link: &str) -> Option<String> {
    use qrcode::render::svg;
    let code =
        qrcode::QrCode::with_error_correction_level(link.as_bytes(), qrcode::EcLevel::M).ok()?;
    Some(
        code.render::<svg::Color<'_>>()
            .min_dimensions(256, 256)
            .quiet_zone(true)
            .dark_color(svg::Color("#000000"))
            .light_color(svg::Color("#ffffff"))
            .build(),
    )
}

fn rfc3339(at: OffsetDateTime) -> String {
    at.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

fn platform() -> &'static str {
    std::env::consts::OS
}

/// `0.1.9` of `0.1.9+2007`.
fn public_version(version: &str) -> &str {
    version.split('+').next().unwrap_or(version)
}

/// `2007` of `0.1.9+2007`; 0 for a build without an internal number.
fn build_number(version: &str) -> u64 {
    version
        .split_once('+')
        .and_then(|(_, build)| build.parse().ok())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_follows_its_max_placement() {
        for tier in [PlanTier::Max, PlanTier::Max2x, PlanTier::Owner] {
            assert!(tier_allows(tier), "{tier:?}");
        }
        for tier in [PlanTier::Free, PlanTier::Pro] {
            assert!(!tier_allows(tier), "{tier:?}");
        }
        assert_eq!(
            FeatureId::Remote.placement(),
            kalcode_contracts::app::FeaturePlacement::Max
        );
    }

    #[test]
    fn version_and_build_split() {
        assert_eq!(public_version("0.1.9+2007"), "0.1.9");
        assert_eq!(build_number("0.1.9+2007"), 2007);
        assert_eq!(public_version("0.1.9"), "0.1.9");
        assert_eq!(build_number("0.1.9"), 0);
    }

    #[test]
    fn pairing_qr_is_a_scannable_svg() {
        let svg = qr_svg("kalcode-remote://pair?d=eyJ2IjoxfQ").expect("qr");
        assert!(svg.contains("<svg") && svg.contains("#000000") && svg.contains("#ffffff"));
    }

    #[test]
    fn only_newly_failed_runs_notify() {
        let run = |id: &str, status: &str| kalcode_remote::wire::RemoteRun {
            id: id.into(),
            title: format!("Run {id}"),
            kind: "test".into(),
            status: status.into(),
            agent_id: None,
            branch: None,
            current_action: None,
            outcome: None,
            updated_at: OffsetDateTime::UNIX_EPOCH,
        };
        let previous = snapshot::Operations {
            runs: vec![run("a", "running"), run("b", "failed")],
            ..Default::default()
        };
        let next = snapshot::Operations {
            runs: vec![run("a", "failed"), run("b", "failed"), run("c", "failed")],
            ..Default::default()
        };
        let notes = failed_runs(&previous, &next);
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].kind, NotifyKind::RunFailed);
        assert_eq!(notes[0].link, "kalcode-remote://run/a");
    }
}
