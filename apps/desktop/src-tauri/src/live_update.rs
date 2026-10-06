//! KalCode Live Update, desktop side. The policy (signed descriptor, update classification,
//! verified bundles, activation, rollback, boot-loop protection) lives in
//! `kalcode_updater::live`; this module wires it into the running shell:
//!
//! - **UI updates (level 1).** [`LiveAssets`] serves the WebView from the active verified UI
//!   bundle, falling back to the UI embedded in the binary. Activating a newer bundle and
//!   reloading only the renderer gives the user the new UI while every terminal and coding agent
//!   keeps running in this process (a page load only detaches their views; they re-attach with
//!   scrollback replay).
//! - **Core updates (level 3).** Native changes need a new process. The signed installer is
//!   already staged by the updater; [`HandoffWatcher`] applies it with a silent install that
//!   relaunches KalCode and restores the window, but only at a moment when no terminal or coding
//!   agent would be lost (their processes end with the shell), with no other KalCode window open
//!   and while the person is away from the keyboard. Otherwise it installs when KalCode closes.
//!
//! Every new UI must report ready (`live_update_ui_ready`) shortly after loading, or it is
//! rolled back and never activated again.

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt as _;
use kalcode_updater::live::{
    self, ActiveUi, LiveStore, StartupRecovery, StartupUi, UiFile, UpdateClass,
};
use kalcode_updater::{UpdateChannel, UpdateError, UpdateTarget};
use reqwest::header::ACCEPT;
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
use tauri::{App, AppHandle, Emitter, Manager, Wry};

use crate::updater_commands::DesktopUpdaterState;

/// The UI must report ready this soon after a live reload or a start on a live UI.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(45);
/// How often the handoff gate is re-evaluated while a core update waits.
const HANDOFF_POLL: Duration = Duration::from_secs(30);
/// A core handoff only starts after this long without keyboard or mouse input.
const HANDOFF_IDLE: Duration = Duration::from_secs(120);
/// How long the UI gets to save its state before a handoff proceeds without it.
const HANDOFF_SNAPSHOT_WAIT: Duration = Duration::from_secs(5);
/// A handoff record older than this is not restored (the relaunch did not happen promptly).
const HANDOFF_RESTORE_WINDOW: Duration = Duration::from_secs(10 * 60);
const HANDOFF_FILE: &str = "handoff.json";
/// Failed handoffs of one build before it is left to install on close.
const MAX_HANDOFF_FAILURES: u32 = 3;
const USER_AGENT: &str = concat!("KalCode/", env!("CARGO_PKG_VERSION"));

pub const STAGED_EVENT: &str = "live-update://ui-staged";
pub const HANDOFF_EVENT: &str = "live-update://handoff";
pub const STATUS_EVENT: &str = "live-update://status";

/// The updater key that every live UI must be signed with: the release key compiled into this
/// shell. Test builds (debug and `e2e`) may name a throwaway key instead, for the end-to-end
/// suite's local live updates.
fn trusted_public_key() -> Option<String> {
    #[cfg(any(debug_assertions, feature = "e2e"))]
    if let Ok(key) = std::env::var("KALCODE_TEST_UPDATER_PUBLIC_KEY") {
        return Some(key);
    }
    option_env!("KALCODE_UPDATER_PUBLIC_KEY").map(str::to_owned)
}

/// The native fingerprint compiled into this shell, or `None` in development builds.
#[must_use]
pub fn native_fingerprint() -> Option<&'static str> {
    let value = env!("KALCODE_NATIVE_FINGERPRINT");
    live::valid_fingerprint(value).then_some(value)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LivePhase {
    Idle,
    Checking,
    Downloading,
    Verifying,
    Staged,
    LiveApplying,
    HandoffPreparing,
    Handoff,
    Updated,
    RolledBack,
    Failed,
    Superseded,
}

/// Milliseconds spent in each step of the most recent update.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTimings {
    pub detect_ms: Option<u64>,
    pub download_ms: Option<u64>,
    pub verify_ms: Option<u64>,
    pub activate_ms: Option<u64>,
    pub renderer_refresh_ms: Option<u64>,
    pub core_handoff_ms: Option<u64>,
    pub state_restore_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveUpdated {
    pub version: String,
    pub class: UpdateClass,
    /// Unix milliseconds.
    pub at: u64,
}

/// User-safe Live Update state for the UI and diagnostics.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveStatus {
    pub phase: LivePhase,
    /// The running native build.
    pub shell_version: String,
    /// The build whose UI is on screen: a live UI, or the shell's own.
    pub ui_version: String,
    /// A newer build that is staged or being applied.
    pub pending_version: Option<String>,
    pub pending_class: Option<UpdateClass>,
    /// Why a staged core update hasn't been applied yet, in plain words.
    pub waiting_for: Option<String>,
    pub last_updated: Option<LiveUpdated>,
    pub timings: LiveTimings,
    pub last_error: Option<String>,
}

struct ServedBundle {
    bundle_sha256: String,
    version: String,
    dir: PathBuf,
    files: BTreeMap<String, UiFile>,
}

/// State shared by the asset provider, the commands and the update flows.
pub struct LiveShared {
    store: OnceLock<LiveStore>,
    served: RwLock<Option<Arc<ServedBundle>>>,
    /// A verified, activated UI waiting for the page to reload. It is served only from that
    /// reload on: the running page may still load its own code-split chunks until then.
    staged: Mutex<Option<ServedBundle>>,
    /// Which UI last served the entry page: a bundle hash, or `None` for the embedded UI.
    served_index: Mutex<Option<Option<String>>>,
    status: Mutex<LiveStatus>,
    /// The UI being health-checked, and when its check started.
    health: Mutex<Option<(Option<String>, Instant)>>,
    /// Set when the UI saved its state for a handoff.
    handoff_snapshot: (Mutex<bool>, Condvar),
    /// A UI update applied this session, announced once to the reloaded UI.
    announce: Mutex<Option<LiveUpdated>>,
    applying: AtomicBool,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

fn elapsed_ms(since: Instant) -> Option<u64> {
    u64::try_from(since.elapsed().as_millis()).ok()
}

impl LiveShared {
    #[must_use]
    pub fn new(shell_version: &str) -> Arc<Self> {
        Arc::new(Self {
            store: OnceLock::new(),
            served: RwLock::new(None),
            staged: Mutex::new(None),
            served_index: Mutex::new(None),
            status: Mutex::new(LiveStatus {
                phase: LivePhase::Idle,
                shell_version: shell_version.to_owned(),
                ui_version: shell_version.to_owned(),
                pending_version: None,
                pending_class: None,
                waiting_for: None,
                last_updated: None,
                timings: LiveTimings::default(),
                last_error: None,
            }),
            health: Mutex::new(None),
            handoff_snapshot: (Mutex::new(false), Condvar::new()),
            announce: Mutex::new(None),
            applying: AtomicBool::new(false),
        })
    }

    fn status_mut(&self) -> std::sync::MutexGuard<'_, LiveStatus> {
        self.status
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    #[must_use]
    pub fn status(&self) -> LiveStatus {
        self.status_mut().clone()
    }

    fn update(&self, app: &AppHandle, change: impl FnOnce(&mut LiveStatus)) {
        let status = {
            let mut status = self.status_mut();
            change(&mut status);
            status.clone()
        };
        let _ = app.emit_to("main", STATUS_EVENT, status);
    }

    fn served(&self) -> Option<Arc<ServedBundle>> {
        self.served
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    fn serve(&self, bundle: Option<ServedBundle>) {
        let version = bundle.as_ref().map(|bundle| bundle.version.clone());
        *self
            .served
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = bundle.map(Arc::new);
        let mut status = self.status_mut();
        status.ui_version = version.unwrap_or_else(|| status.shell_version.clone());
    }

    /// The newest UI this session has: staged for the next reload, or on screen.
    fn newest_ui(&self) -> String {
        self.staged
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .map_or_else(|| self.status().ui_version, |staged| staged.version.clone())
    }

    fn arm_health(&self, bundle: Option<String>) {
        *self
            .health
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some((bundle, Instant::now()));
    }
}

fn served_bundle(
    store: &LiveStore,
    ui: &ActiveUi,
    manifest: &live::BundleManifest,
) -> ServedBundle {
    ServedBundle {
        bundle_sha256: ui.bundle_sha256.clone(),
        version: ui.version.clone(),
        dir: store.bundle_dir(&ui.dir),
        files: live::asset_index(manifest),
    }
}

/// The WebView's asset provider: the active verified live UI when there is one, else the UI
/// embedded in this binary. Files of a live UI are re-hashed on every read. A missing or changed
/// file is never replaced by an embedded one (mixing builds); the page then fails its health
/// check and rolls back.
pub struct LiveAssets {
    embedded: Box<dyn tauri::Assets<Wry>>,
    shared: Arc<LiveShared>,
}

impl LiveAssets {
    #[must_use]
    pub fn new(embedded: Box<dyn tauri::Assets<Wry>>, shared: Arc<LiveShared>) -> Self {
        Self { embedded, shared }
    }
}

impl tauri::Assets<Wry> for LiveAssets {
    fn setup(&self, app: &App<Wry>) {
        self.embedded.setup(app);
        // Runs after the main window is created and before its first page request is served:
        // decide which UI this start serves.
        let Ok(data_dir) = crate::resolve_data_dir(app) else {
            return;
        };
        let store = LiveStore::new(data_dir.join("updates").join("live"));
        let shell_version = app.package_info().version.to_string();
        let Ok(target) = UpdateTarget::current() else {
            return;
        };
        let public_key = trusted_public_key();
        let (chosen, recovery) = store.startup(&live::StartupTrust {
            native_fingerprint: native_fingerprint(),
            version: &shell_version,
            public_key: public_key.as_deref(),
            target,
        });
        if let StartupUi::Live(ui, manifest) = &chosen {
            self.shared.serve(Some(served_bundle(&store, ui, manifest)));
            self.shared.arm_health(Some(ui.bundle_sha256.clone()));
        }
        if recovery != StartupRecovery::None {
            tracing::warn!(event = "live_update.startup_recovery", recovery = ?recovery);
            if recovery == StartupRecovery::RolledBack || recovery == StartupRecovery::Damaged {
                let mut status = self.shared.status_mut();
                status.phase = LivePhase::RolledBack;
                status.last_error = Some(
                    "A KalCode UI update didn't start correctly, so the previous one is back."
                        .into(),
                );
            }
        }
        let _ = self.shared.store.set(store);
    }

    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        let bundle = self.shared.served();
        let asset = match &bundle {
            Some(bundle) => bundle
                .files
                .get(key.as_ref())
                .and_then(|file| live::read_verified_asset(&bundle.dir, file))
                .map(Cow::Owned),
            None => self.embedded.get(key),
        };
        if asset.is_some() && key.as_ref() == "/index.html" {
            *self
                .shared
                .served_index
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) =
                Some(bundle.map(|bundle| bundle.bundle_sha256.clone()));
        }
        asset
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        self.embedded.iter()
    }

    fn csp_hashes(&self, html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        // Release UI bundles carry no inline scripts or styles, so the embedded entry page's
        // hashes (if any) are all a live entry page could need; anything else stays blocked.
        self.embedded.csp_hashes(html_path)
    }
}

/// Holds the context's asset slot for the instant the embedded assets move into [`LiveAssets`].
struct NoAssets;

impl tauri::Assets<Wry> for NoAssets {
    fn get(&self, _key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        None
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }

    fn csp_hashes(&self, _html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}

/// Wraps the context's embedded UI in [`LiveAssets`]. Returns the state to `manage`.
pub fn install_assets(context: &mut tauri::Context<Wry>) -> Arc<LiveShared> {
    let shared = LiveShared::new(&context.package_info().version.to_string());
    let embedded = context.set_assets(Box::new(NoAssets));
    context.set_assets(Box::new(LiveAssets::new(embedded, shared.clone())));
    shared
}

fn shared(app: &AppHandle) -> Option<Arc<LiveShared>> {
    app.try_state::<Arc<LiveShared>>()
        .map(|state| state.inner().clone())
}

// ---------------------------------------------------------------------------------------------
// Level 1: live UI updates.

fn envelope_url(channel: UpdateChannel, version: &str, target: UpdateTarget) -> String {
    format!(
        "https://kalcoded.com/releases/updater/{}/{version}/live/{}.json",
        channel.as_str(),
        target.as_str()
    )
}

fn bundle_url(channel: UpdateChannel, version: &str, file: &str) -> String {
    format!(
        "https://kalcoded.com/releases/updater/{}/{version}/live/{file}",
        channel.as_str()
    )
}

fn network_error() -> UpdateError {
    UpdateError::new(
        "live_network",
        "KalCode couldn't download the live update. Check your connection.",
    )
}

/// Downloads at most `limit` bytes. `Ok(None)` when the server has no such file.
async fn fetch_bounded(url: &str, limit: u64) -> Result<Option<Vec<u8>>, UpdateError> {
    #[cfg(any(debug_assertions, feature = "e2e"))]
    if let Some(local) = test_source::fetch(url, limit) {
        return local;
    }
    let client = reqwest::Client::builder()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(5 * 60))
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(30))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|_| network_error())?;
    let response = client
        .get(url)
        .header(ACCEPT, "application/octet-stream, application/json")
        .send()
        .await
        .map_err(|_| network_error())?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() || response.content_length().is_some_and(|size| size > limit)
    {
        return Err(network_error());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| network_error())?;
        if (bytes.len() + chunk.len()) as u64 > limit {
            return Err(network_error());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(Some(bytes))
}

fn is_newer(candidate: &str, than: &str) -> bool {
    match (
        semver::Version::parse(candidate),
        semver::Version::parse(than),
    ) {
        (Ok(candidate), Ok(than)) => candidate > than,
        _ => false,
    }
}

/// Called by the updater for every newer build the canonical feed announces. Applies it live
/// when only the UI changed; otherwise records it as a core update. Never fails the updater:
/// the signed installer path stays the fallback for everything.
pub async fn consider(
    app: &AppHandle,
    version: &str,
    channel: UpdateChannel,
    target: UpdateTarget,
    public_key: &str,
) {
    let Some(shared) = shared(app) else { return };
    if shared.applying.swap(true, Ordering::AcqRel) {
        return;
    }
    let started = Instant::now();
    let result = consider_inner(app, &shared, version, channel, target, public_key, started).await;
    shared.applying.store(false, Ordering::Release);
    if let Err(error) = result {
        tracing::warn!(event = "live_update.ui_failed", error_code = error.code());
        shared.update(app, |status| {
            status.phase = LivePhase::Failed;
            status.last_error = Some(error.to_string());
        });
    }
}

async fn consider_inner(
    app: &AppHandle,
    shared: &Arc<LiveShared>,
    version: &str,
    channel: UpdateChannel,
    target: UpdateTarget,
    public_key: &str,
    started: Instant,
) -> Result<(), UpdateError> {
    let Some(store) = shared.store.get() else {
        return Ok(());
    };
    if !is_newer(version, &shared.newest_ui()) {
        return Ok(());
    }
    shared.update(app, |status| {
        status.phase = LivePhase::Checking;
        status.pending_version = Some(version.to_owned());
        status.pending_class = None;
        status.waiting_for = None;
        status.last_error = None;
        status.timings = LiveTimings::default();
    });
    let Some(raw) = fetch_bounded(
        &envelope_url(channel, version, target),
        live::MAX_LIVE_ENVELOPE_BYTES,
    )
    .await?
    else {
        // Builds published before Live Update carry no descriptor: core update.
        shared.update(app, |status| {
            status.phase = LivePhase::Staged;
            status.pending_class = Some(UpdateClass::Core);
        });
        return Ok(());
    };
    let descriptor = live::verify_envelope(&raw, public_key, version, target, channel)?;
    let class = live::classify(native_fingerprint(), &descriptor);
    let detect_ms = elapsed_ms(started);
    shared.update(app, |status| {
        status.pending_class = Some(class);
        status.timings.detect_ms = detect_ms;
    });
    if class == UpdateClass::Core || store.is_rejected(&descriptor.ui.sha256) {
        shared.update(app, |status| status.phase = LivePhase::Staged);
        return Ok(());
    }

    shared.update(app, |status| status.phase = LivePhase::Downloading);
    let download_started = Instant::now();
    let bytes = fetch_bounded(
        &bundle_url(channel, version, &descriptor.ui.file),
        descriptor.ui.size,
    )
    .await?
    .ok_or_else(network_error)?;
    let download_ms = elapsed_ms(download_started);
    shared.update(app, |status| {
        status.phase = LivePhase::Verifying;
        status.timings.download_ms = download_ms;
    });

    let verify_started = Instant::now();
    let root = store.ui_root();
    let final_name = LiveStore::staging_dir_name(&descriptor);
    let verified = {
        let descriptor = descriptor.clone();
        let root = root.clone();
        let final_name = final_name.clone();
        tauri::async_runtime::spawn_blocking(move || {
            stage_bundle(&bytes, &raw, &descriptor, &root, &final_name)
        })
        .await
        .map_err(|_| network_error())??
    };
    let verify_ms = elapsed_ms(verify_started);

    // Newest valid build wins: a slower, older download never replaces a newer UI.
    if !is_newer(version, &shared.newest_ui()) {
        shared.update(app, |status| {
            status.phase = LivePhase::Superseded;
            status.timings.verify_ms = verify_ms;
        });
        return Ok(());
    }

    let activate_started = Instant::now();
    let ui = ActiveUi {
        version: descriptor.version.clone(),
        dir: final_name,
        bundle_sha256: descriptor.ui.sha256.clone(),
        native_fingerprint: descriptor.shell.native_fingerprint.clone(),
        channel,
        unhealthy_boots: 0,
        healthy: false,
    };
    store.activate(ui.clone())?;
    *shared
        .staged
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) =
        Some(served_bundle(store, &ui, &verified));
    let activate_ms = elapsed_ms(activate_started);
    shared.update(app, |status| {
        status.phase = LivePhase::LiveApplying;
        status.timings.verify_ms = verify_ms;
        status.timings.activate_ms = activate_ms;
    });
    *shared
        .announce
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(LiveUpdated {
        version: ui.version.clone(),
        class: UpdateClass::Ui,
        at: now_ms(),
    });
    tracing::info!(event = "live_update.ui_staged", version = %ui.version);
    // The UI reloads itself at a quiet moment (it keeps drafts and the current place), then
    // reports ready. `live_update_begin_reload` arms the health check.
    let _ = app.emit_to("main", STAGED_EVENT, ui.version);
    Ok(())
}

/// Unpacks and verifies `bytes` beside its signed `envelope` (kept so every later start can
/// re-prove it), then makes it appear under its final name in one rename.
fn stage_bundle(
    bytes: &[u8],
    envelope: &[u8],
    descriptor: &live::LiveDescriptor,
    root: &Path,
    final_name: &str,
) -> Result<live::BundleManifest, UpdateError> {
    let final_dir = root.join(final_name);
    if final_dir.exists()
        && let Ok(manifest) = live::verify_unpacked(&final_dir)
        && manifest.bundle_sha256 == descriptor.ui.sha256
    {
        live::seal_bundle(&final_dir, envelope, bytes)?;
        return Ok(manifest);
    }
    let _ = std::fs::remove_dir_all(&final_dir);
    let staging = root.join(format!(".staging-{}", kalcode_contracts::ids::new_id()));
    let manifest = live::unpack_bundle(bytes, descriptor, &staging)?;
    if let Err(error) = live::seal_bundle(&staging, envelope, bytes) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(error);
    }
    // One rename makes the complete, verified bundle appear under its final name.
    std::fs::rename(&staging, &final_dir).map_err(|_| {
        let _ = std::fs::remove_dir_all(&staging);
        UpdateError::new(
            "live_state_unavailable",
            "KalCode couldn't save its live update state.",
        )
    })?;
    Ok(manifest)
}

/// The health check: a UI that does not report ready in time is rolled back.
fn watch_health(app: AppHandle) {
    let _ = std::thread::Builder::new()
        .name("kalcode-live-health".into())
        .spawn(move || {
            loop {
                std::thread::sleep(Duration::from_secs(5));
                let Some(shared) = shared(&app) else { return };
                // Claimed under the lock: a ready report either takes the entry first (and
                // nothing is rolled back) or finds it gone.
                let expired = {
                    let mut health = shared
                        .health
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    match health.as_ref() {
                        Some((_, since)) if since.elapsed() >= HEALTH_TIMEOUT => {
                            health.take().map(|(bundle, _)| bundle)
                        }
                        _ => continue,
                    }
                };
                if let Some(bundle) = expired {
                    roll_back_ui(&app, &shared, bundle.as_deref());
                }
            }
        });
}

fn roll_back_ui(app: &AppHandle, shared: &Arc<LiveShared>, bundle: Option<&str>) {
    // Only a live UI can be rolled back; the embedded UI is the floor.
    let Some(bundle) = bundle else { return };
    let Some(store) = shared.store.get() else {
        return;
    };
    // A UI that reported ready since it started is healthy, however late its report came.
    if store
        .current()
        .is_none_or(|current| current.bundle_sha256 != bundle)
        || store.current_is_ready()
    {
        return;
    }
    tracing::error!(event = "live_update.ui_rolled_back");
    let previous = match store.roll_back() {
        Ok(previous) => previous,
        Err(error) => {
            // The bad UI must not be served again at the next start either.
            tracing::error!(
                event = "live_update.rollback_unrecorded",
                error_code = error.code()
            );
            let _ = store.clear();
            None
        }
    };
    let public_key = trusted_public_key();
    let served = previous.as_ref().and_then(|ui| {
        let target = UpdateTarget::current().ok()?;
        live::verify_sealed(
            &store.bundle_dir(&ui.dir),
            public_key.as_deref()?,
            &ui.version,
            target,
            ui.channel,
        )
        .ok()
        .map(|manifest| served_bundle(store, ui, &manifest))
    });
    if previous.is_some() && served.is_none() {
        let _ = store.clear();
    }
    if let Some(ui) = &previous {
        shared.arm_health(Some(ui.bundle_sha256.clone()));
    }
    shared.serve(served);
    *shared
        .announce
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    shared.update(app, |status| {
        status.phase = LivePhase::RolledBack;
        status.last_error =
            Some("A KalCode UI update didn't start correctly, so the previous one is back.".into());
    });
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval("window.location.reload()");
    }
}

// ---------------------------------------------------------------------------------------------
// Level 3: core handoff.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowGeometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HandoffRecord {
    from_version: String,
    to_version: String,
    started_at_ms: u64,
    window: Option<WindowGeometry>,
}

/// Why a core handoff can't happen right now, in words the Updates page shows. `None`: safe.
fn handoff_blocker(app: &AppHandle) -> Option<&'static str> {
    if crate::updater_commands::session_ending_now() {
        return Some("Windows is signing out");
    }
    let terminals = app
        .try_state::<crate::AppState>()
        .and_then(|state| state.core.clone())
        .and_then(|core| core.running_terminals().ok());
    match terminals {
        Some(terminals) if terminals.is_empty() => {}
        Some(_) => return Some("terminals are running"),
        None => return Some("KalCode is starting"),
    }
    match app
        .try_state::<Arc<crate::runtime_coordinator::RuntimeCoordinator>>()
        .and_then(|coordinator| coordinator.running_provider_work())
    {
        Some(0) => {}
        Some(_) => return Some("coding agents are running"),
        None => return Some("KalCode is starting"),
    }
    if crate::updater_commands::other_instance_running() {
        return Some("another KalCode window is open");
    }
    match user_idle() {
        Some(idle) if idle >= HANDOFF_IDLE => None,
        Some(_) => Some("you're using KalCode"),
        None => Some("core updates on this platform install when KalCode closes"),
    }
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn user_idle() -> Option<Duration> {
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    // SAFETY: `info` is a valid, initialized LASTINPUTINFO with its size set, as required.
    if unsafe { GetLastInputInfo(&mut info) } == 0 {
        return None;
    }
    // SAFETY: GetTickCount has no preconditions.
    let now = unsafe { GetTickCount() };
    Some(Duration::from_millis(u64::from(
        now.wrapping_sub(info.dwTime),
    )))
}

#[cfg(not(windows))]
fn user_idle() -> Option<Duration> {
    None
}

/// Re-evaluates the handoff gate while a core update is staged; applies it once safe.
pub struct HandoffWatcher;

impl HandoffWatcher {
    pub fn start(app: AppHandle) {
        let _ = std::thread::Builder::new()
            .name("kalcode-live-handoff".into())
            .spawn(move || {
                // A handoff that failed is retried later and less often; after
                // MAX_HANDOFF_FAILURES the build installs when KalCode closes instead.
                let mut failures: (String, u32, Instant) = (String::new(), 0, Instant::now());
                loop {
                    std::thread::sleep(HANDOFF_POLL);
                    let Some(shared) = shared(&app) else { return };
                    let Some(updater) = app.try_state::<DesktopUpdaterState>() else {
                        continue;
                    };
                    let status = updater.status();
                    let Some(version) = status.available_version.clone() else {
                        continue;
                    };
                    let staged_core =
                        status.install_on_quit && is_newer(&version, &shared.status().ui_version);
                    if !staged_core {
                        if shared.status().waiting_for.is_some() {
                            shared.update(&app, |status| status.waiting_for = None);
                        }
                        continue;
                    }
                    match handoff_blocker(&app) {
                        Some(reason) => {
                            if shared.status().waiting_for.as_deref() != Some(reason) {
                                shared.update(&app, |status| {
                                    status.pending_version = Some(version.clone());
                                    status.pending_class = Some(UpdateClass::Core);
                                    status.waiting_for = Some(reason.to_owned());
                                });
                            }
                        }
                        None => {
                            if failures.0 != version {
                                failures = (version.clone(), 0, Instant::now());
                            }
                            if failures.1 >= MAX_HANDOFF_FAILURES || Instant::now() < failures.2 {
                                continue;
                            }
                            if hand_off(&app, &shared, &updater, &version) {
                                failures.1 += 1;
                                failures.2 = Instant::now() + handoff_backoff(failures.1);
                            }
                        }
                    }
                }
            });
    }
}

/// After `failures` failed handoffs, how long until the next try: 1, 2, 4 … minutes, capped.
fn handoff_backoff(failures: u32) -> Duration {
    Duration::from_secs(60 * 2_u64.saturating_pow(failures.saturating_sub(1)).min(30))
}

/// Applies the staged core update. On success this process exits; returns `true` when the
/// install could not start (to back off), `false` when it was called off because the gate closed.
fn hand_off(
    app: &AppHandle,
    shared: &Arc<LiveShared>,
    updater: &DesktopUpdaterState,
    version: &str,
) -> bool {
    let started = Instant::now();
    tracing::info!(event = "live_update.handoff_preparing", version);
    shared.update(app, |status| {
        status.phase = LivePhase::HandoffPreparing;
        status.waiting_for = None;
    });
    // Let the UI save drafts and its place, and show "Applying KalCode update…".
    {
        let (saved, signal) = &shared.handoff_snapshot;
        *saved
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = false;
        let _ = app.emit_to("main", HANDOFF_EVENT, version);
        let guard = saved
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let _ = signal.wait_timeout_while(guard, HANDOFF_SNAPSHOT_WAIT, |saved| !*saved);
    }
    // The gate may have closed while the UI saved its state.
    if let Some(reason) = handoff_blocker(app) {
        shared.update(app, |status| {
            status.phase = LivePhase::Staged;
            status.waiting_for = Some(reason.to_owned());
        });
        let _ = app.emit_to("main", HANDOFF_EVENT, Option::<String>::None);
        return false;
    }
    let record = HandoffRecord {
        from_version: shared.status().shell_version,
        to_version: version.to_owned(),
        started_at_ms: now_ms(),
        window: window_geometry(app),
    };
    let handoff_path = handoff_file(app);
    if let Some(path) = &handoff_path {
        let _ = serde_json::to_vec(&record).map(|bytes| std::fs::write(path, bytes));
    }
    shared.update(app, |status| {
        status.phase = LivePhase::Handoff;
        status.timings.core_handoff_ms = elapsed_ms(started);
    });
    // On success this process exits; the installer relaunches the new build.
    if let Err(error) = updater.hand_off() {
        tracing::warn!(
            event = "live_update.handoff_failed",
            error_code = error.code()
        );
        if let Some(path) = &handoff_path {
            let _ = std::fs::remove_file(path);
        }
        shared.update(app, |status| {
            status.phase = LivePhase::Staged;
            status.waiting_for = Some("the update will install when KalCode closes".into());
            status.last_error = Some(error.to_string());
        });
        let _ = app.emit_to("main", HANDOFF_EVENT, Option::<String>::None);
        return true;
    }
    false
}

fn handoff_file(app: &AppHandle) -> Option<PathBuf> {
    let state = app.try_state::<crate::AppState>()?;
    Some(state.paths.data_dir.join("updates").join(HANDOFF_FILE))
}

fn window_geometry(app: &AppHandle) -> Option<WindowGeometry> {
    let window = app.get_webview_window("main")?;
    let maximized = window.is_maximized().unwrap_or(false);
    let position = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    Some(WindowGeometry {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized,
    })
}

/// After a handoff relaunch: put the window back where it was and record the result. Runs in
/// setup, before the window is shown.
fn restore_after_handoff(app: &AppHandle, shared: &Arc<LiveShared>) {
    let Some(path) = handoff_file(app) else {
        return;
    };
    let Ok(bytes) = std::fs::read(&path) else {
        return;
    };
    let _ = std::fs::remove_file(&path);
    let Ok(record) = serde_json::from_slice::<HandoffRecord>(&bytes) else {
        return;
    };
    let age = now_ms().saturating_sub(record.started_at_ms);
    if age > u64::try_from(HANDOFF_RESTORE_WINDOW.as_millis()).unwrap_or(u64::MAX) {
        return;
    }
    let restore_started = Instant::now();
    if let (Some(geometry), Some(window)) = (record.window, app.get_webview_window("main")) {
        let _ = window.set_size(tauri::PhysicalSize::new(geometry.width, geometry.height));
        let _ = window.set_position(tauri::PhysicalPosition::new(geometry.x, geometry.y));
        if geometry.maximized {
            let _ = window.maximize();
        }
    }
    let shell_version = shared.status().shell_version;
    let applied = shell_version == record.to_version;
    let mut status = shared.status_mut();
    if applied {
        status.phase = LivePhase::Updated;
        status.last_updated = Some(LiveUpdated {
            version: record.to_version.clone(),
            class: UpdateClass::Core,
            at: now_ms(),
        });
        status.timings.core_handoff_ms = Some(age);
        status.timings.state_restore_ms = elapsed_ms(restore_started);
        drop(status);
        *shared
            .announce
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(LiveUpdated {
            version: record.to_version,
            class: UpdateClass::Core,
            at: now_ms(),
        });
    } else {
        status.phase = LivePhase::RolledBack;
        status.last_error = Some(
            "The KalCode update didn't finish, so the previous version is still running.".into(),
        );
    }
}

/// Wires Live Update into a started app: restores a handoff, starts the health check and the
/// handoff watcher. Called from setup.
pub fn start(app: &AppHandle) {
    let Some(shared) = shared(app) else { return };
    restore_after_handoff(app, &shared);
    watch_health(app.clone());
    HandoffWatcher::start(app.clone());
    #[cfg(any(debug_assertions, feature = "e2e"))]
    test_source::watch(app.clone());
}

/// Test builds only (debug and `e2e`; never compiled into a release): the end-to-end suite drives
/// a real live update from a local folder instead of kalcoded.com. `KALCODE_TEST_LIVE_SOURCE`
/// names the folder holding `windows-x86_64.json` and the bundle; writing a version to its
/// `trigger` file starts the same path the updater uses, verified against
/// `KALCODE_TEST_UPDATER_PUBLIC_KEY`.
#[cfg(any(debug_assertions, feature = "e2e"))]
mod test_source {
    use super::{AppHandle, Duration, UpdateChannel, UpdateError, UpdateTarget};
    use std::path::PathBuf;

    fn root() -> Option<PathBuf> {
        std::env::var_os("KALCODE_TEST_LIVE_SOURCE")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
    }

    pub(super) fn fetch(url: &str, limit: u64) -> Option<Result<Option<Vec<u8>>, UpdateError>> {
        let root = root()?;
        let name = url.rsplit('/').next()?;
        let path = root.join(name);
        Some(match std::fs::read(&path) {
            Ok(bytes) if bytes.len() as u64 <= limit => Ok(Some(bytes)),
            Ok(_) => Err(super::network_error()),
            Err(_) => Ok(None),
        })
    }

    pub(super) fn watch(app: AppHandle) {
        let (Some(root), Ok(key)) = (root(), std::env::var("KALCODE_TEST_UPDATER_PUBLIC_KEY"))
        else {
            return;
        };
        let _ = std::thread::Builder::new()
            .name("kalcode-live-test-source".into())
            .spawn(move || {
                let mut last = String::new();
                loop {
                    std::thread::sleep(Duration::from_millis(500));
                    let Ok(version) = std::fs::read_to_string(root.join("trigger")) else {
                        continue;
                    };
                    let version = version.trim().to_owned();
                    if version.is_empty() || version == last {
                        continue;
                    }
                    last.clone_from(&version);
                    let app = app.clone();
                    let key = key.clone();
                    tauri::async_runtime::block_on(super::consider(
                        &app,
                        &version,
                        UpdateChannel::Stable,
                        UpdateTarget::WindowsX86_64,
                        &key,
                    ));
                }
            });
    }
}

// ---------------------------------------------------------------------------------------------
// Commands.

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiReady {
    /// The page came from a different UI than the one now active: load it again.
    pub reload: bool,
    /// An update applied since the last ready report, to announce once.
    pub updated: Option<LiveUpdated>,
}

#[tauri::command]
pub fn live_update_status(app: AppHandle) -> Option<LiveStatus> {
    shared(&app).map(|shared| shared.status())
}

/// The UI loaded and rendered. Marks a live UI healthy and ends its health check.
#[tauri::command]
pub fn live_update_ui_ready(app: AppHandle) -> UiReady {
    let Some(shared) = shared(&app) else {
        return UiReady {
            reload: false,
            updated: None,
        };
    };
    let active = shared.served().map(|bundle| bundle.bundle_sha256.clone());
    let served_index = shared
        .served_index
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    if served_index.is_some_and(|served| served != active) {
        return UiReady {
            reload: true,
            updated: None,
        };
    }
    let reload_started = shared
        .health
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take()
        .map(|(_, since)| since);
    if let (Some(sha), Some(store)) = (&active, shared.store.get())
        && let Err(error) = store.mark_healthy(sha)
    {
        tracing::warn!(
            event = "live_update.health_unrecorded",
            error_code = error.code()
        );
    }
    let updated = shared
        .announce
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take();
    if let Some(updated) = &updated {
        let refresh_ms = reload_started.and_then(elapsed_ms);
        let updated = updated.clone();
        shared.update(&app, |status| {
            status.phase = LivePhase::Updated;
            status.pending_version = None;
            status.pending_class = None;
            status.last_updated = Some(updated.clone());
            if updated.class == UpdateClass::Ui {
                status.timings.renderer_refresh_ms = refresh_ms;
            }
        });
        tracing::info!(event = "live_update.updated", version = %updated.version, class = ?updated.class);
    }
    UiReady {
        reload: false,
        updated,
    }
}

/// The UI saved its state and is reloading into the staged UI: serve it from this reload on and
/// start its health check.
#[tauri::command]
pub fn live_update_begin_reload(app: AppHandle) {
    if let Some(shared) = shared(&app) {
        let staged = shared
            .staged
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some(staged) = staged {
            shared.serve(Some(staged));
        }
        let bundle = shared.served().map(|bundle| bundle.bundle_sha256.clone());
        shared.arm_health(bundle);
    }
}

/// The UI saved its state for a core handoff.
#[tauri::command]
pub fn live_update_handoff_ready(app: AppHandle) {
    if let Some(shared) = shared(&app) {
        let (saved, signal) = &shared.handoff_snapshot;
        *saved
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = true;
        signal.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn development_builds_have_no_fingerprint_and_never_live_apply() {
        // Test builds are compiled without KALCODE_NATIVE_FINGERPRINT.
        if env!("KALCODE_NATIVE_FINGERPRINT").is_empty() {
            assert_eq!(native_fingerprint(), None);
        }
    }

    #[test]
    fn live_files_are_served_from_the_canonical_feed_host_only() {
        assert_eq!(
            envelope_url(
                UpdateChannel::Stable,
                "0.1.9+1900",
                UpdateTarget::WindowsX86_64
            ),
            "https://kalcoded.com/releases/updater/stable/0.1.9+1900/live/windows-x86_64.json"
        );
        assert_eq!(
            bundle_url(
                UpdateChannel::Stable,
                "0.1.9+1900",
                "KalCode_0.1.9_build1900_ui.kui"
            ),
            "https://kalcoded.com/releases/updater/stable/0.1.9+1900/live/KalCode_0.1.9_build1900_ui.kui"
        );
    }

    #[test]
    fn a_failing_handoff_backs_off_and_caps() {
        assert_eq!(handoff_backoff(1), Duration::from_secs(60));
        assert_eq!(handoff_backoff(2), Duration::from_secs(120));
        assert_eq!(handoff_backoff(3), Duration::from_secs(240));
        assert_eq!(handoff_backoff(40), Duration::from_secs(30 * 60));
    }

    #[test]
    fn only_a_strictly_newer_build_is_considered() {
        assert!(is_newer("0.1.9+1900", "0.1.9+1873"));
        assert!(is_newer("0.1.10", "0.1.9+1873"));
        assert!(!is_newer("0.1.9+1873", "0.1.9+1873"));
        assert!(!is_newer("0.1.9+1800", "0.1.9+1873"));
        assert!(!is_newer("garbage", "0.1.9+1873"));
    }

    #[test]
    fn a_handoff_record_round_trips_and_rejects_unknown_fields() {
        let record = HandoffRecord {
            from_version: "0.1.9+1873".into(),
            to_version: "0.1.9+1900".into(),
            started_at_ms: 1,
            window: Some(WindowGeometry {
                x: -8,
                y: 0,
                width: 1360,
                height: 860,
                maximized: true,
            }),
        };
        let bytes = serde_json::to_vec(&record).unwrap();
        assert_eq!(
            serde_json::from_slice::<HandoffRecord>(&bytes).unwrap(),
            record
        );
        assert!(
            serde_json::from_str::<HandoffRecord>(
                r#"{"fromVersion":"a","toVersion":"b","startedAtMs":1,"window":null,"x":1}"#
            )
            .is_err()
        );
    }
}
