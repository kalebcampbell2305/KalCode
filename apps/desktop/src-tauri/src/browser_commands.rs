//! Real, isolated child-webview browser panes.
//!
//! Only the trusted `main` webview can call these commands. Remote child webviews receive no
//! capability grants, may navigate only to credential-free HTTP(S), and cannot open popups or
//! download files. Each authenticated account/workspace pair receives a separate WebView data directory.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
#[cfg(feature = "e2e")]
use std::sync::atomic::AtomicU16;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use kalcode_contracts::ids::is_valid_id;
use kalcode_core::{ErrorCategory, IpcError, KalError};
use serde::{Deserialize, Serialize};
#[cfg(windows)]
use tauri::Emitter;
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{LogicalPosition, LogicalSize, Manager, State, Webview, WebviewUrl};
use tauri_plugin_opener::OpenerExt;

use crate::AppState;
use crate::browser_policy::{
    BrowserBounds, BrowserPolicyError, normalize_browser_url, safe_runtime_url, validate_bounds,
    validate_browser_id,
};

const MAX_BROWSER_VIEWS: usize = 8;
#[cfg(windows)]
const FOCUS_EVENT: &str = "kalcode://browser-focus";
const HIDDEN_CHILD_POSITION: f64 = 16_000.0;
#[cfg(feature = "e2e")]
static NEXT_E2E_DEBUG_PORT: AtomicU16 = AtomicU16::new(0);
#[cfg(feature = "e2e")]
static E2E_DOWNLOAD_DENIALS: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone)]
struct BrowserRecord {
    workspace_id: String,
    url: String,
    title: Option<String>,
    loading: bool,
    visible: bool,
    bounds: BrowserBounds,
    creating: bool,
    closing: bool,
    page_lease: u64,
    account_generation: u64,
    visibility_version: u64,
    /// The latest pop-up the page asked for (denied); offered as "open here / in your browser".
    blocked_popup: Option<String>,
    blocked_popup_seq: u64,
    #[cfg(feature = "e2e")]
    debug_port: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct BrowserCloseTarget {
    browser_id: String,
    page_lease: u64,
    account_generation: u64,
}

impl BrowserCloseTarget {
    fn from_record(browser_id: String, record: &BrowserRecord) -> Self {
        Self {
            browser_id,
            page_lease: record.page_lease,
            account_generation: record.account_generation,
        }
    }
}

#[derive(Clone)]
pub struct BrowserViews {
    records: Arc<Mutex<HashMap<String, BrowserRecord>>>,
    pending_closes: Arc<Mutex<HashSet<BrowserCloseTarget>>>,
    page_lease: Arc<AtomicU64>,
}

impl Default for BrowserViews {
    fn default() -> Self {
        Self {
            records: Arc::new(Mutex::new(HashMap::new())),
            pending_closes: Arc::new(Mutex::new(HashSet::new())),
            page_lease: Arc::new(AtomicU64::new(1)),
        }
    }
}

impl BrowserViews {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, BrowserRecord>> {
        self.records
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn current_page_lease(&self) -> u64 {
        self.page_lease.load(Ordering::Acquire)
    }

    fn lock_pending_closes(&self) -> std::sync::MutexGuard<'_, HashSet<BrowserCloseTarget>> {
        self.pending_closes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn rotate_page_lease_and_take_close_targets(&self) -> (u64, Vec<BrowserCloseTarget>) {
        // Publish the replacement page's lease while holding the same lock that detaches every
        // prior-page record. A replacement attach can read the new lease, but its reservation
        // blocks on this lock and therefore cannot be captured by the old page's cleanup.
        let mut records = self.lock();
        let current = self.page_lease.load(Ordering::Acquire);
        let Some(next) = current.checked_add(1) else {
            // Reusing a generation would permit an ABA visibility bypass. This limit cannot be
            // reached in a real process lifetime, so fail closed instead of wrapping.
            std::process::abort();
        };
        self.page_lease.store(next, Ordering::Release);
        let mut targets = std::mem::take(&mut *self.lock_pending_closes());
        targets.extend(
            records
                .drain()
                .map(|(id, record)| BrowserCloseTarget::from_record(id, &record)),
        );
        (next, targets.into_iter().collect())
    }

    fn requeue_failed_close(&self, target: BrowserCloseTarget) {
        self.lock_pending_closes().insert(target);
    }

    fn finish_failed_attach_close(&self, target: &BrowserCloseTarget, succeeded: bool) {
        let mut records = self.lock();
        let matches = records.get(&target.browser_id).is_some_and(|record| {
            record.page_lease == target.page_lease
                && record.account_generation == target.account_generation
        });
        if succeeded {
            if matches {
                records.remove(&target.browser_id);
            }
        } else if let Some(record) = records.get_mut(&target.browser_id).filter(|record| {
            record.page_lease == target.page_lease
                && record.account_generation == target.account_generation
        }) {
            record.creating = false;
            record.closing = true;
            record.visible = false;
        }
        let mut pending = self.lock_pending_closes();
        if succeeded {
            pending.remove(target);
        } else {
            pending.insert(target.clone());
        }
    }

    fn finish_renderer_close(
        &self,
        target: &BrowserCloseTarget,
        succeeded: bool,
        previous_visible: bool,
    ) {
        let mut records = self.lock();
        let matches = records.get(&target.browser_id).is_some_and(|record| {
            record.page_lease == target.page_lease
                && record.account_generation == target.account_generation
        });
        if succeeded {
            if matches {
                records.remove(&target.browser_id);
            }
        } else if let Some(record) = records.get_mut(&target.browser_id).filter(|record| {
            record.page_lease == target.page_lease
                && record.account_generation == target.account_generation
        }) {
            record.closing = false;
            record.visible = previous_visible;
        }
        let mut pending = self.lock_pending_closes();
        if succeeded {
            pending.remove(target);
        } else {
            pending.insert(target.clone());
        }
    }

    fn reserve(&self, browser_id: String, record: BrowserRecord) -> Result<(), IpcError> {
        let mut records = self.lock();
        require_current_page_lease(self, record.page_lease)?;
        if let Some(existing) = records.get(&browser_id) {
            if existing.account_generation != record.account_generation {
                return Err(retryable_unavailable(
                    "browser_account_expired",
                    "That browser pane belongs to a previous account session.",
                ));
            }
            if existing.workspace_id != record.workspace_id {
                return Err(KalError::new(
                    ErrorCategory::Permission,
                    "browser_workspace_mismatch",
                    "That browser pane belongs to another workspace.",
                )
                .to_ipc());
            }
            if existing.closing {
                return Err(retryable_unavailable(
                    "browser_closing",
                    "That browser pane is closing.",
                ));
            }
            if existing.creating {
                return Err(retryable_unavailable(
                    "browser_starting",
                    "That browser pane is still starting.",
                ));
            }
        }
        if records.len() >= MAX_BROWSER_VIEWS && !records.contains_key(&browser_id) {
            return Err(KalError::new(
                ErrorCategory::Internal,
                "browser_limit_reached",
                "Close a browser pane before opening another one.",
            )
            .to_ipc());
        }
        #[cfg(feature = "e2e")]
        let record = {
            let mut record = record;
            if record.debug_port.is_none() {
                record.debug_port = records
                    .values()
                    .find(|existing| existing.workspace_id == record.workspace_id)
                    .and_then(|existing| existing.debug_port)
                    .or_else(reserve_e2e_debug_port);
            }
            record
        };
        records.insert(browser_id, record);
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserAttachRequest {
    browser_id: String,
    workspace_id: String,
    url: String,
    bounds: BrowserBounds,
    visible: bool,
    page_lease: u64,
    #[serde(default)]
    visibility_version: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserViewRequest {
    browser_id: String,
    bounds: BrowserBounds,
    visible: bool,
    page_lease: u64,
    #[serde(default)]
    visibility_version: u64,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserAction {
    Back,
    Forward,
    Reload,
    Stop,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserState {
    browser_id: String,
    workspace_id: String,
    url: String,
    title: Option<String>,
    loading: bool,
    visible: bool,
    bounds: BrowserBounds,
    blocked_popup: Option<String>,
    blocked_popup_seq: u64,
    #[cfg(feature = "e2e")]
    #[serde(skip_serializing_if = "Option::is_none")]
    debug_port: Option<u16>,
    #[cfg(feature = "e2e")]
    debug_download_denials: u64,
}

#[cfg(windows)]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserFocusEvent {
    browser_id: String,
}

impl BrowserState {
    fn from_record(browser_id: &str, record: &BrowserRecord) -> Self {
        Self {
            browser_id: browser_id.to_owned(),
            workspace_id: record.workspace_id.clone(),
            url: record.url.clone(),
            title: record.title.clone(),
            loading: record.loading,
            visible: record.visible,
            bounds: record.bounds,
            blocked_popup: record.blocked_popup.clone(),
            blocked_popup_seq: record.blocked_popup_seq,
            #[cfg(feature = "e2e")]
            debug_port: record.debug_port,
            #[cfg(feature = "e2e")]
            debug_download_denials: E2E_DOWNLOAD_DENIALS.load(Ordering::Acquire),
        }
    }
}

#[cfg(feature = "e2e")]
fn reserve_e2e_debug_port() -> Option<u16> {
    let base = std::env::var("KALCODE_E2E_BROWSER_CDP_BASE")
        .ok()?
        .parse::<u16>()
        .ok()
        .filter(|value| (1_024..=65_000).contains(value))?;
    loop {
        let stored = NEXT_E2E_DEBUG_PORT.load(Ordering::Relaxed);
        let current = if stored == 0 { base } else { stored };
        let next = current.checked_add(1)?;
        if NEXT_E2E_DEBUG_PORT
            .compare_exchange(stored, next, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
        {
            return Some(current);
        }
    }
}

fn policy_error(error: BrowserPolicyError) -> IpcError {
    KalError::validation("invalid_browser_request", error.message()).to_ipc()
}

fn unavailable(code: &'static str, message: &'static str) -> IpcError {
    KalError::internal(code, message).to_ipc()
}

fn retryable_unavailable(code: &'static str, message: &'static str) -> IpcError {
    KalError::internal(code, message).retryable().to_ipc()
}

fn trusted(webview: &Webview) -> Result<(), IpcError> {
    if webview.label() == "main" {
        Ok(())
    } else {
        Err(KalError::new(
            ErrorCategory::Permission,
            "browser_ipc_denied",
            "This browser surface cannot access KalCode commands.",
        )
        .to_ipc())
    }
}

fn label(browser_id: &str, page_lease: u64, account_generation: u64) -> String {
    format!("browser-{account_generation}-{page_lease}-{browser_id}")
}

fn set_native_view(
    webview: &Webview,
    bounds: BrowserBounds,
    visible: bool,
) -> Result<(), IpcError> {
    webview
        .set_position(LogicalPosition::new(bounds.x, bounds.y))
        .and_then(|()| webview.set_size(LogicalSize::new(bounds.width, bounds.height)))
        .and_then(|()| {
            if visible {
                webview.show()
            } else {
                webview.hide()
            }
        })
        .map_err(|_| {
            unavailable(
                "browser_view_failed",
                "KalCode couldn't position that browser pane.",
            )
        })
}

fn cleanup_failed_attach(
    child: &Webview,
    views: &BrowserViews,
    target: &BrowserCloseTarget,
    primary_error: IpcError,
) -> IpcError {
    let closed = child.close().is_ok();
    views.finish_failed_attach_close(target, closed);
    if closed {
        primary_error
    } else {
        unavailable(
            "browser_cleanup_failed",
            "KalCode couldn't safely clean up that browser pane.",
        )
    }
}

fn mark_renderer_close_started(
    views: &BrowserViews,
    browser_id: &str,
    page_lease: u64,
) -> Result<Option<(bool, bool)>, IpcError> {
    let mut records = views.lock();
    let Some(record) = records.get_mut(browser_id) else {
        return Ok(None);
    };
    require_record_page(record, page_lease)?;
    let previous_visible = record.visible;
    record.closing = true;
    record.visible = false;
    Ok(Some((record.creating, previous_visible)))
}

fn finish_attach_close(
    views: &BrowserViews,
    target: &BrowserCloseTarget,
    succeeded: bool,
    previous_visible: bool,
) {
    views.finish_renderer_close(target, succeeded, previous_visible);
}

fn require_current_page_lease(views: &BrowserViews, page_lease: u64) -> Result<(), IpcError> {
    if page_lease == views.current_page_lease() {
        Ok(())
    } else {
        Err(retryable_unavailable(
            "browser_page_lease_expired",
            "The Browser request belongs to an expired trusted page. Retry from the current KalCode page.",
        ))
    }
}

fn require_record_page(record: &BrowserRecord, page_lease: u64) -> Result<(), IpcError> {
    if record.page_lease == page_lease {
        Ok(())
    } else {
        Err(retryable_unavailable(
            "browser_page_lease_expired",
            "That browser pane belongs to another trusted page lifecycle.",
        ))
    }
}

fn require_ready_record(record: &BrowserRecord, page_lease: u64) -> Result<(), IpcError> {
    require_record_page(record, page_lease)?;
    if record.closing {
        return Err(retryable_unavailable(
            "browser_closing",
            "That browser pane is closing.",
        ));
    }
    if record.creating {
        return Err(retryable_unavailable(
            "browser_starting",
            "That browser pane is still starting.",
        ));
    }
    Ok(())
}

fn apply_view_state(
    record: &mut BrowserRecord,
    bounds: BrowserBounds,
    visible: bool,
    visibility_version: u64,
) {
    record.bounds = bounds;
    if visibility_version >= record.visibility_version {
        record.visible = visible;
        record.visibility_version = visibility_version;
    }
}

fn effective_visibility(record: &BrowserRecord, visible: bool, visibility_version: u64) -> bool {
    if visibility_version >= record.visibility_version {
        visible
    } else {
        record.visible
    }
}

fn clean_title(title: String) -> Option<String> {
    let value: String = title
        .chars()
        .filter(|character| !character.is_control() && !is_bidi_format(*character))
        .take(256)
        .collect();
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn is_bidi_format(character: char) -> bool {
    matches!(
        character,
        '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'
    )
}

#[cfg(windows)]
#[allow(unsafe_code)]
async fn bind_native_focus(
    webview: &Webview,
    browser_id: String,
    page_lease: u64,
    views: BrowserViews,
) -> Result<(), IpcError> {
    use webview2_com::FocusChangedEventHandler;

    let app = webview.app_handle().clone();
    let (registered_tx, registered_rx) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform| {
            let controller = platform.controller();
            let id = browser_id.clone();
            let visible_views = views.clone();
            let mut token = 0;
            // SAFETY: `controller` is the live WebView2 controller supplied by Tauri on its UI
            // thread; the COM handler captures only owned, thread-safe values and returns no
            // borrowed data. This is the same registration pattern used by tauri-runtime-wry.
            let result = unsafe {
                controller.add_GotFocus(
                    &FocusChangedEventHandler::create(Box::new(move |_, _| {
                        let visible = visible_views.lock().get(&id).is_some_and(|record| {
                            record.page_lease == page_lease
                                && page_lease == visible_views.current_page_lease()
                                && record.visible
                        });
                        if visible {
                            let _ = app.emit_to(
                                "main",
                                FOCUS_EVENT,
                                BrowserFocusEvent {
                                    browser_id: id.clone(),
                                },
                            );
                        }
                        Ok(())
                    })),
                    &mut token,
                )
            };
            let _ = registered_tx.send(result.is_ok());
        })
        .map_err(|_| {
            unavailable(
                "browser_focus_hook_failed",
                "KalCode couldn't connect browser focus.",
            )
        })?;
    let registered = tauri::async_runtime::spawn_blocking(move || {
        registered_rx.recv_timeout(std::time::Duration::from_secs(5))
    })
    .await
    .map_err(|_| {
        unavailable(
            "browser_focus_hook_failed",
            "KalCode couldn't connect browser focus.",
        )
    })?
    .unwrap_or(false);
    if registered {
        Ok(())
    } else {
        Err(unavailable(
            "browser_focus_hook_failed",
            "KalCode couldn't connect browser focus.",
        ))
    }
}

#[cfg(windows)]
#[allow(unsafe_code)]
async fn bind_native_download_denial(
    webview: &Webview,
    download_sink: PathBuf,
) -> Result<(), IpcError> {
    use webview2_com::{
        IsDefaultDownloadDialogOpenChangedEventHandler,
        Microsoft::Web::WebView2::Win32::{ICoreWebView2_9, ICoreWebView2_13},
    };
    use windows_core::{HSTRING, Interface};

    let (registered_tx, registered_rx) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform| {
            let controller = platform.controller();
            // SAFETY: `controller` and its CoreWebView2 are the live COM objects supplied by
            // Tauri on the WebView2 UI thread. WebView2 retains the owned callback after
            // registration. Tauri's construction-time handler denies the transfer; this hook
            // confines any unexpected write and closes WebView2's separate default-download UI.
            let result = unsafe {
                controller.CoreWebView2().and_then(|webview| {
                    let profile_webview: ICoreWebView2_13 = webview.cast()?;
                    let download_sink = HSTRING::from(download_sink.as_path());
                    profile_webview
                        .Profile()?
                        .SetDefaultDownloadFolderPath(&download_sink)?;
                    let dialog_webview: ICoreWebView2_9 = webview.cast()?;
                    let mut dialog_token = 0;
                    dialog_webview.add_IsDefaultDownloadDialogOpenChanged(
                        &IsDefaultDownloadDialogOpenChangedEventHandler::create(Box::new(
                            move |sender, _| {
                                if let Some(sender) = sender {
                                    let sender: ICoreWebView2_9 = sender.cast()?;
                                    let mut open = windows_core::BOOL::default();
                                    sender.IsDefaultDownloadDialogOpen(&mut open)?;
                                    if open.as_bool() {
                                        sender.CloseDefaultDownloadDialog()?;
                                    }
                                }
                                Ok(())
                            },
                        )),
                        &mut dialog_token,
                    )
                })
            };
            let _ = registered_tx.send(result.is_ok());
        })
        .map_err(|_| {
            unavailable(
                "browser_download_guard_failed",
                "KalCode couldn't secure browser downloads.",
            )
        })?;
    let registered = tauri::async_runtime::spawn_blocking(move || {
        registered_rx.recv_timeout(std::time::Duration::from_secs(5))
    })
    .await
    .map_err(|_| {
        unavailable(
            "browser_download_guard_failed",
            "KalCode couldn't secure browser downloads.",
        )
    })?
    .unwrap_or(false);
    if registered {
        Ok(())
    } else {
        Err(unavailable(
            "browser_download_guard_failed",
            "KalCode couldn't secure browser downloads.",
        ))
    }
}

#[cfg(windows)]
fn is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn ensure_plain_directory(path: &Path) -> Result<(), IpcError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !is_reparse_point(&metadata) => Ok(()),
        Ok(_) => Err(KalError::new(
            ErrorCategory::Filesystem,
            "browser_profile_unsafe",
            "KalCode's browser profile folder is unsafe.",
        )
        .to_ipc()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match std::fs::create_dir(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(_) => {
                    return Err(KalError::new(
                        ErrorCategory::Filesystem,
                        "browser_profile_create_failed",
                        "KalCode couldn't create the browser profile folder.",
                    )
                    .to_ipc());
                }
            }
            let metadata = std::fs::symlink_metadata(path).map_err(|_| {
                KalError::new(
                    ErrorCategory::Filesystem,
                    "browser_profile_verify_failed",
                    "KalCode couldn't verify the browser profile folder.",
                )
                .to_ipc()
            })?;
            if metadata.is_dir() && !is_reparse_point(&metadata) {
                Ok(())
            } else {
                Err(KalError::new(
                    ErrorCategory::Filesystem,
                    "browser_profile_unsafe",
                    "KalCode's browser profile folder is unsafe.",
                )
                .to_ipc())
            }
        }
        Err(_) => Err(KalError::new(
            ErrorCategory::Filesystem,
            "browser_profile_verify_failed",
            "KalCode couldn't verify the browser profile folder.",
        )
        .to_ipc()),
    }
}

fn browser_profile_dir(
    data_dir: &Path,
    account_id: &str,
    workspace_id: &str,
) -> Result<PathBuf, IpcError> {
    use sha2::{Digest, Sha256};
    // Only native authenticated identity reaches this helper. Hash it to avoid identifiers in
    // profile paths; never adopt the old unowned workspace profile across account boundaries.
    if account_id.is_empty() || !is_valid_id(workspace_id) {
        return Err(KalError::validation(
            "browser_profile_unsafe",
            "That browser profile is unavailable.",
        )
        .to_ipc());
    }
    let base = data_dir.join("browser-data");
    ensure_plain_directory(&base)?;
    let digest = Sha256::digest(
        [
            kalcode_contracts::identity::IDENTIFIER.as_bytes(),
            b"/browser-account/v1\0".as_slice(),
            account_id.as_bytes(),
        ]
        .concat(),
    );
    let account = base.join(format!("account-{digest:x}"));
    ensure_plain_directory(&account)?;
    let profile = account.join(workspace_id);
    ensure_plain_directory(&profile)?;
    Ok(profile)
}

#[cfg(not(windows))]
async fn bind_native_focus(
    _webview: &Webview,
    _browser_id: String,
    _page_lease: u64,
    _views: BrowserViews,
) -> Result<(), IpcError> {
    Ok(())
}

#[cfg(not(windows))]
async fn bind_native_download_denial(_webview: &Webview) -> Result<(), IpcError> {
    Ok(())
}

fn close_detached_views(
    app: &tauri::AppHandle,
    views: &BrowserViews,
    detached: Vec<BrowserCloseTarget>,
) -> Result<usize, IpcError> {
    let mut closed = 0;
    let mut failed = false;
    for target in detached {
        if let Some(child) = app.get_webview(&label(
            &target.browser_id,
            target.page_lease,
            target.account_generation,
        )) {
            if child.close().is_ok() {
                closed += 1;
            } else {
                failed = true;
                views.requeue_failed_close(target);
            }
        } else {
            closed += 1;
        }
    }
    if failed {
        Err(unavailable(
            "browser_close_failed",
            "KalCode couldn't close every browser pane.",
        ))
    } else {
        Ok(closed)
    }
}

/// Begins a new trusted main-webview lifecycle and closes only the children detached from its
/// predecessor. Lease rotation and record detachment are one transaction, so replacement JS can
/// never create a child that this cleanup mistakes for an old one.
pub fn begin_page_load(app: &tauri::AppHandle, views: &BrowserViews) -> Result<usize, IpcError> {
    let (_current_page, detached) = views.rotate_page_lease_and_take_close_targets();
    close_detached_views(app, views, detached)
}

#[tauri::command]
pub fn browser_page_lease(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    webview: Webview,
    views: State<'_, BrowserViews>,
) -> Result<u64, IpcError> {
    _runtime_access.revalidate()?;
    trusted(&webview)?;
    Ok(views.current_page_lease())
}

/// Creates or reattaches a native child webview. This command must remain async: WebView2 child
/// creation can deadlock when a synchronous IPC command waits on the main thread.
#[tauri::command]
pub async fn browser_attach(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    webview: Webview,
    state: State<'_, AppState>,
    views: State<'_, BrowserViews>,
    request: BrowserAttachRequest,
) -> Result<BrowserState, IpcError> {
    _runtime_access.revalidate()?;
    trusted(&webview)?;
    validate_browser_id(&request.browser_id).map_err(policy_error)?;
    require_current_page_lease(&views, request.page_lease)?;
    if !is_valid_id(&request.workspace_id) {
        return Err(KalError::validation(
            "invalid_browser_request",
            "That workspace is unavailable.",
        )
        .to_ipc());
    }
    let core = state.core()?;
    let workspace_exists = core
        .workspaces()
        .map_err(|_| {
            unavailable(
                "browser_workspace_lookup_failed",
                "KalCode couldn't verify that workspace.",
            )
        })?
        .iter()
        .any(|workspace| workspace.id == request.workspace_id);
    if !workspace_exists {
        return Err(KalError::validation(
            "browser_workspace_unknown",
            "That workspace is unavailable.",
        )
        .to_ipc());
    }
    validate_bounds(request.bounds).map_err(policy_error)?;
    let url = normalize_browser_url(&request.url).map_err(policy_error)?;
    let account_id = _runtime_access.account_id()?;
    let profile_dir =
        browser_profile_dir(&state.paths.data_dir, &account_id, &request.workspace_id)?;
    #[cfg(windows)]
    let download_sink = {
        let path = profile_dir.join("denied-downloads");
        ensure_plain_directory(&path)?;
        path
    };
    _runtime_access.revalidate()?;
    let attach_target = BrowserCloseTarget {
        browser_id: request.browser_id.clone(),
        page_lease: request.page_lease,
        account_generation: _runtime_access.generation(),
    };
    let child_label = label(
        &attach_target.browser_id,
        attach_target.page_lease,
        attach_target.account_generation,
    );

    if let Some(child) = webview.app_handle().get_webview(&child_label) {
        require_current_page_lease(&views, request.page_lease)?;
        let mut records = views.lock();
        {
            let record = records.get(&request.browser_id).ok_or_else(|| {
                unavailable("browser_state_missing", "That browser pane is unavailable.")
            })?;
            if record.creating {
                return Err(KalError::internal(
                    "browser_starting",
                    "That browser pane is still starting.",
                )
                .retryable()
                .to_ipc());
            }
            if record.workspace_id != request.workspace_id {
                return Err(KalError::new(
                    ErrorCategory::Permission,
                    "browser_workspace_mismatch",
                    "That browser pane belongs to another workspace.",
                )
                .to_ipc());
            }
            if record.closing {
                return Err(retryable_unavailable(
                    "browser_closing",
                    "That browser pane is closing.",
                ));
            }
        }
        let record = records.get_mut(&request.browser_id).ok_or_else(|| {
            unavailable("browser_state_missing", "That browser pane is unavailable.")
        })?;
        if record.page_lease != request.page_lease {
            return Err(retryable_unavailable(
                "browser_page_lease_expired",
                "The Browser child belongs to an expired trusted page.",
            ));
        }
        let effective_visible =
            effective_visibility(record, request.visible, request.visibility_version);
        set_native_view(&child, request.bounds, effective_visible)?;
        let record = records.get_mut(&request.browser_id).ok_or_else(|| {
            unavailable("browser_state_missing", "That browser pane is unavailable.")
        })?;
        apply_view_state(
            record,
            request.bounds,
            request.visible,
            request.visibility_version,
        );
        return Ok(BrowserState::from_record(&request.browser_id, record));
    }

    views.reserve(
        request.browser_id.clone(),
        BrowserRecord {
            workspace_id: request.workspace_id.clone(),
            url: url.to_string(),
            title: None,
            loading: true,
            visible: request.visible,
            bounds: request.bounds,
            creating: true,
            closing: false,
            page_lease: request.page_lease,
            account_generation: _runtime_access.generation(),
            visibility_version: request.visibility_version,
            blocked_popup: None,
            blocked_popup_seq: 0,
            #[cfg(feature = "e2e")]
            debug_port: None,
        },
    )?;
    #[cfg(feature = "e2e")]
    let debug_port = views
        .lock()
        .get(&request.browser_id)
        .and_then(|record| record.debug_port);

    let navigation_views = views.inner().clone();
    let navigation_id = request.browser_id.clone();
    let navigation_lease = request.page_lease;
    let page_views = views.inner().clone();
    let page_id = request.browser_id.clone();
    let page_lease = request.page_lease;
    let title_views = views.inner().clone();
    let title_id = request.browser_id.clone();
    let title_lease = request.page_lease;
    let popup_views = views.inner().clone();
    let popup_id = request.browser_id.clone();
    let popup_lease = request.page_lease;
    #[cfg(windows)]
    let initial_url = WebviewUrl::External(url::Url::parse("about:blank").map_err(|_| {
        unavailable(
            "browser_create_failed",
            "KalCode couldn't create that browser pane.",
        )
    })?);
    #[cfg(not(windows))]
    let initial_url = WebviewUrl::External(url.clone());
    let builder = crate::browser_profile::configure(
        WebviewBuilder::new(child_label, initial_url),
        profile_dir,
    )
    .devtools(false)
    .disable_drag_drop_handler()
    .on_navigation(move |candidate| {
        let allowed = safe_runtime_url(candidate);
        if allowed
            && let Some(record) = navigation_views
                .lock()
                .get_mut(&navigation_id)
                .filter(|record| {
                    record.page_lease == navigation_lease
                        && navigation_lease == navigation_views.current_page_lease()
                })
        {
            record.url = candidate.to_string();
            record.loading = true;
        }
        allowed
    })
    // The page helper only records errors and a picked element; it has no KalCode capability.
    .initialization_script(crate::browser_live::LIVE_SCRIPT)
    // Pop-ups stay denied (they would be unmanaged windows). A safe HTTP(S) target is remembered
    // so the pane can offer it here or in the system browser, e.g. a "Sign in with Google" window.
    .on_new_window(move |candidate, _| {
        if safe_runtime_url(&candidate)
            && let Some(record) = popup_views.lock().get_mut(&popup_id).filter(|record| {
                record.page_lease == popup_lease && popup_lease == popup_views.current_page_lease()
            })
        {
            record.blocked_popup = Some(candidate.to_string());
            record.blocked_popup_seq = record.blocked_popup_seq.saturating_add(1);
        }
        NewWindowResponse::Deny
    })
    .on_download(|_, event| {
        if matches!(event, DownloadEvent::Requested { .. }) {
            #[cfg(feature = "e2e")]
            {
                E2E_DOWNLOAD_DENIALS.fetch_add(1, Ordering::AcqRel);
            }
        }
        false
    })
    // On macOS, wry 0.55.1 calls this handler only from `didCommitNavigation` and
    // `didFinishNavigation`, when `WKWebView.URL` is the committed, non-nil URL. It reads that URL
    // with an unwrap, but failed or cancelled provisional navigations never reach this handler.
    .on_page_load(move |_, payload| {
        if safe_runtime_url(payload.url())
            && let Some(record) = page_views.lock().get_mut(&page_id).filter(|record| {
                record.page_lease == page_lease && page_lease == page_views.current_page_lease()
            })
        {
            record.url = payload.url().to_string();
            record.loading = matches!(payload.event(), PageLoadEvent::Started);
        }
    })
    .on_document_title_changed(move |_, title| {
        if let Some(record) = title_views.lock().get_mut(&title_id).filter(|record| {
            record.page_lease == title_lease && title_lease == title_views.current_page_lease()
        }) {
            record.title = clean_title(title);
        }
    });
    // On Windows the child starts at inert `about:blank`; Tauri's construction-time denial and
    // the additional native guards are all installed before any remote document loads.
    #[cfg(feature = "e2e")]
    let builder = if let Some(port) = debug_port {
        let args = format!(
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={port}"
        );
        builder.additional_browser_args(&args)
    } else {
        builder
    };

    let child = match webview.window().add_child(
        builder,
        LogicalPosition::new(HIDDEN_CHILD_POSITION, HIDDEN_CHILD_POSITION),
        LogicalSize::new(1.0, 1.0),
    ) {
        Ok(child) => child,
        Err(_) => {
            let mut records = views.lock();
            if records
                .get(&request.browser_id)
                .is_some_and(|record| record.page_lease == request.page_lease)
            {
                records.remove(&request.browser_id);
            }
            return Err(unavailable(
                "browser_create_failed",
                "KalCode couldn't create that browser pane.",
            ));
        }
    };
    if let Err(error) = require_current_page_lease(&views, request.page_lease) {
        return Err(cleanup_failed_attach(&child, &views, &attach_target, error));
    }
    if child.hide().is_err() {
        return Err(cleanup_failed_attach(
            &child,
            &views,
            &attach_target,
            unavailable(
                "browser_view_failed",
                "KalCode couldn't safely hide that browser pane while it started.",
            ),
        ));
    }

    let closing = views
        .lock()
        .get(&request.browser_id)
        .is_some_and(|record| record.closing);
    if closing {
        let closed = child.close().is_ok();
        finish_attach_close(&views, &attach_target, closed, false);
        return Err(if closed {
            retryable_unavailable(
                "browser_closed_during_start",
                "That browser pane was closed while it started.",
            )
        } else {
            unavailable(
                "browser_close_failed",
                "KalCode couldn't close that browser pane.",
            )
        });
    }
    #[cfg(windows)]
    if let Err(error) = bind_native_download_denial(&child, download_sink).await {
        return Err(cleanup_failed_attach(&child, &views, &attach_target, error));
    }
    #[cfg(not(windows))]
    if let Err(error) = bind_native_download_denial(&child).await {
        return Err(cleanup_failed_attach(&child, &views, &attach_target, error));
    }
    if let Err(error) = bind_native_focus(
        &child,
        request.browser_id.clone(),
        request.page_lease,
        views.inner().clone(),
    )
    .await
    {
        return Err(cleanup_failed_attach(&child, &views, &attach_target, error));
    }

    match _runtime_access
        .revalidate()
        .and_then(|()| require_current_page_lease(&views, request.page_lease))
    {
        Ok(()) => {}
        Err(error) => {
            return Err(cleanup_failed_attach(&child, &views, &attach_target, error));
        }
    }
    #[cfg(windows)]
    if child.navigate(url).is_err() {
        return Err(cleanup_failed_attach(
            &child,
            &views,
            &attach_target,
            unavailable(
                "browser_navigation_failed",
                "KalCode couldn't open that address.",
            ),
        ));
    }
    let mut records = views.lock();
    let Some(record) = records.get_mut(&request.browser_id) else {
        drop(records);
        return Err(cleanup_failed_attach(
            &child,
            &views,
            &attach_target,
            unavailable("browser_state_missing", "That browser pane is unavailable."),
        ));
    };
    if request.page_lease != views.current_page_lease() || record.page_lease != request.page_lease {
        drop(records);
        return Err(cleanup_failed_attach(
            &child,
            &views,
            &attach_target,
            retryable_unavailable(
                "browser_page_lease_expired",
                "The Browser request belongs to an expired trusted page.",
            ),
        ));
    }
    if record.closing {
        drop(records);
        let closed = child.close().is_ok();
        finish_attach_close(&views, &attach_target, closed, false);
        return Err(if closed {
            retryable_unavailable(
                "browser_closed_during_start",
                "That browser pane was closed while it started.",
            )
        } else {
            unavailable(
                "browser_close_failed",
                "KalCode couldn't close that browser pane.",
            )
        });
    }
    if let Err(error) = set_native_view(&child, record.bounds, record.visible) {
        drop(records);
        return Err(cleanup_failed_attach(&child, &views, &attach_target, error));
    }
    record.creating = false;
    Ok(BrowserState::from_record(&request.browser_id, record))
}

#[tauri::command]
pub fn browser_set_view(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    webview: Webview,
    views: State<'_, BrowserViews>,
    request: BrowserViewRequest,
) -> Result<BrowserState, IpcError> {
    _runtime_access.revalidate()?;
    trusted(&webview)?;
    validate_browser_id(&request.browser_id).map_err(policy_error)?;
    validate_bounds(request.bounds).map_err(policy_error)?;
    let child = webview.app_handle().get_webview(&label(
        &request.browser_id,
        request.page_lease,
        _runtime_access.generation(),
    ));
    require_current_page_lease(&views, request.page_lease)?;
    let mut records = views.lock();
    let record = records
        .get_mut(&request.browser_id)
        .ok_or_else(|| unavailable("browser_not_found", "That browser pane is not open."))?;
    if record.closing {
        return Err(retryable_unavailable(
            "browser_closing",
            "That browser pane is closing.",
        ));
    }
    if record.page_lease != request.page_lease {
        return Err(retryable_unavailable(
            "browser_page_lease_expired",
            "That browser pane belongs to an older page.",
        ));
    }
    let effective_visible =
        effective_visibility(record, request.visible, request.visibility_version);
    if let Some(child) = child {
        set_native_view(&child, request.bounds, effective_visible)?;
    } else if !record.creating {
        return Err(unavailable(
            "browser_not_found",
            "That browser pane is not open.",
        ));
    }
    apply_view_state(
        record,
        request.bounds,
        request.visible,
        request.visibility_version,
    );
    Ok(BrowserState::from_record(&request.browser_id, record))
}

#[tauri::command]
pub fn browser_navigate(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    webview: Webview,
    views: State<'_, BrowserViews>,
    browser_id: String,
    url: String,
    page_lease: u64,
) -> Result<BrowserState, IpcError> {
    _runtime_access.revalidate()?;
    trusted(&webview)?;
    validate_browser_id(&browser_id).map_err(policy_error)?;
    let url = normalize_browser_url(&url).map_err(policy_error)?;
    require_current_page_lease(&views, page_lease)?;
    let child = webview
        .app_handle()
        .get_webview(&label(
            &browser_id,
            page_lease,
            _runtime_access.generation(),
        ))
        .ok_or_else(|| unavailable("browser_not_found", "That browser pane is not open."))?;
    {
        let records = views.lock();
        let record = records
            .get(&browser_id)
            .ok_or_else(|| unavailable("browser_not_found", "That browser pane is not open."))?;
        require_record_page(record, page_lease)?;
        if record.closing {
            return Err(retryable_unavailable(
                "browser_closing",
                "That browser pane is closing.",
            ));
        }
    }
    if child.navigate(url.clone()).is_err() {
        return Err(unavailable(
            "browser_navigation_failed",
            "KalCode couldn't open that address.",
        ));
    }
    let mut records = views.lock();
    let record = records
        .get_mut(&browser_id)
        .ok_or_else(|| unavailable("browser_not_found", "That browser pane is not open."))?;
    require_record_page(record, page_lease)?;
    record.url = url.to_string();
    record.loading = true;
    Ok(BrowserState::from_record(&browser_id, record))
}

#[tauri::command]
pub fn browser_action(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    webview: Webview,
    views: State<'_, BrowserViews>,
    browser_id: String,
    action: BrowserAction,
    page_lease: u64,
) -> Result<BrowserState, IpcError> {
    _runtime_access.revalidate()?;
    trusted(&webview)?;
    validate_browser_id(&browser_id).map_err(policy_error)?;
    require_current_page_lease(&views, page_lease)?;
    let child = webview
        .app_handle()
        .get_webview(&label(
            &browser_id,
            page_lease,
            _runtime_access.generation(),
        ))
        .ok_or_else(|| unavailable("browser_not_found", "That browser pane is not open."))?;
    {
        let records = views.lock();
        let record = records
            .get(&browser_id)
            .ok_or_else(|| unavailable("browser_not_found", "That browser pane is not open."))?;
        require_record_page(record, page_lease)?;
        if record.closing {
            return Err(retryable_unavailable(
                "browser_closing",
                "That browser pane is closing.",
            ));
        }
    }
    let result = match action {
        BrowserAction::Back => child.eval("history.back()"),
        BrowserAction::Forward => child.eval("history.forward()"),
        BrowserAction::Reload => child.reload(),
        BrowserAction::Stop => child.eval("window.stop()"),
    };
    if result.is_err() {
        return Err(unavailable(
            "browser_action_failed",
            "That browser action didn't complete.",
        ));
    }
    let mut records = views.lock();
    let record = records
        .get_mut(&browser_id)
        .ok_or_else(|| unavailable("browser_not_found", "That browser pane is not open."))?;
    require_record_page(record, page_lease)?;
    record.loading = !matches!(action, BrowserAction::Stop);
    Ok(BrowserState::from_record(&browser_id, record))
}

#[tauri::command]
pub fn browser_focus(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    webview: Webview,
    views: State<'_, BrowserViews>,
    browser_id: String,
    page_lease: u64,
) -> Result<bool, IpcError> {
    _runtime_access.revalidate()?;
    trusted(&webview)?;
    validate_browser_id(&browser_id).map_err(policy_error)?;
    require_current_page_lease(&views, page_lease)?;
    let child = webview
        .app_handle()
        .get_webview(&label(
            &browser_id,
            page_lease,
            _runtime_access.generation(),
        ))
        .ok_or_else(|| unavailable("browser_not_found", "That browser pane is not open."))?;
    {
        let records = views.lock();
        let record = records
            .get(&browser_id)
            .ok_or_else(|| unavailable("browser_not_found", "That browser pane is not open."))?;
        require_record_page(record, page_lease)?;
        if record.closing {
            return Err(retryable_unavailable(
                "browser_closing",
                "That browser pane is closing.",
            ));
        }
    }
    child.set_focus().map(|()| true).map_err(|_| {
        unavailable(
            "browser_focus_failed",
            "KalCode couldn't focus that browser pane.",
        )
    })
}

/// Whether `browser_info` may ask the native webview for its current URL.
///
/// Not on macOS. wry 0.55.1 reads `WKWebView.URL` with `Option::unwrap()` (`url_from_webview`,
/// reached through tauri's `Webview::url()`). That property is nil until a navigation commits:
/// for example, when the first load of an unreachable address such as `http://localhost:3000/`
/// fails, or when the navigation policy cancels it. The panic happens inside wry, so `.ok()`
/// can't catch it, and the release profile aborts. On macOS the pane's URL comes only from the
/// navigation and page-load events recorded in `BrowserRecord::url`.
const NATIVE_URL_QUERY_IS_SAFE: bool = !cfg!(target_os = "macos");

/// The native webview's current URL, if it is safe to ask for it and the answer is a URL the
/// Browser may show. `read_native` is never called when `query_is_safe` is false.
fn native_browser_url(
    query_is_safe: bool,
    read_native: impl FnOnce() -> Option<url::Url>,
) -> Option<url::Url> {
    if !query_is_safe {
        return None;
    }
    read_native().filter(safe_runtime_url)
}

/// Polled about every 750 ms per visible Browser pane, so it stays off the main thread; the
/// native URL read still hops to the main thread on its own.
#[tauri::command(async)]
pub fn browser_info(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    webview: Webview,
    views: State<'_, BrowserViews>,
    browser_id: String,
    page_lease: u64,
) -> Result<BrowserState, IpcError> {
    _runtime_access.revalidate()?;
    trusted(&webview)?;
    validate_browser_id(&browser_id).map_err(policy_error)?;
    require_current_page_lease(&views, page_lease)?;
    {
        let records = views.lock();
        let record = records
            .get(&browser_id)
            .ok_or_else(|| unavailable("browser_not_found", "That browser pane is not open."))?;
        require_ready_record(record, page_lease)?;
    }
    let child = webview
        .app_handle()
        .get_webview(&label(
            &browser_id,
            page_lease,
            _runtime_access.generation(),
        ))
        .ok_or_else(|| unavailable("browser_not_found", "That browser pane is not open."))?;
    let current_url = native_browser_url(NATIVE_URL_QUERY_IS_SAFE, || child.url().ok());
    let mut records = views.lock();
    let record = records
        .get_mut(&browser_id)
        .ok_or_else(|| unavailable("browser_not_found", "That browser pane is not open."))?;
    require_ready_record(record, page_lease)?;
    if let Some(url) = current_url {
        record.url = url.to_string();
    }
    Ok(BrowserState::from_record(&browser_id, record))
}

#[tauri::command]
pub fn browser_close(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    webview: Webview,
    views: State<'_, BrowserViews>,
    browser_id: String,
    page_lease: u64,
) -> Result<bool, IpcError> {
    _runtime_access.revalidate()?;
    trusted(&webview)?;
    validate_browser_id(&browser_id).map_err(policy_error)?;
    require_current_page_lease(&views, page_lease)?;
    let close_target = BrowserCloseTarget {
        browser_id: browser_id.clone(),
        page_lease,
        account_generation: _runtime_access.generation(),
    };
    let Some((creating, previous_visible)) =
        mark_renderer_close_started(&views, &browser_id, page_lease)?
    else {
        if let Some(child) = webview.app_handle().get_webview(&label(
            &close_target.browser_id,
            close_target.page_lease,
            close_target.account_generation,
        )) {
            let closed = child.close().is_ok();
            views.finish_renderer_close(&close_target, closed, false);
            if !closed {
                return Err(unavailable(
                    "browser_close_failed",
                    "KalCode couldn't close that browser pane.",
                ));
            }
        }
        return Ok(false);
    };
    if let Some(child) = webview.app_handle().get_webview(&label(
        &close_target.browser_id,
        close_target.page_lease,
        close_target.account_generation,
    )) {
        let closed = child.close().is_ok();
        finish_attach_close(&views, &close_target, closed, previous_visible);
        if !closed {
            return Err(unavailable(
                "browser_close_failed",
                "KalCode couldn't close that browser pane.",
            ));
        }
    } else if !creating {
        finish_attach_close(&views, &close_target, true, previous_visible);
    }
    Ok(true)
}

#[tauri::command]
pub fn browser_hide_all(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    webview: Webview,
    views: State<'_, BrowserViews>,
    page_lease: u64,
) -> Result<usize, IpcError> {
    _runtime_access.revalidate()?;
    trusted(&webview)?;
    require_current_page_lease(&views, page_lease)?;
    let ids: Vec<String> = {
        let records = views.lock();
        for record in records.values() {
            require_record_page(record, page_lease)?;
        }
        records.keys().cloned().collect()
    };
    let mut hidden = 0;
    let mut failed = false;
    for id in ids {
        let child =
            webview
                .app_handle()
                .get_webview(&label(&id, page_lease, _runtime_access.generation()));
        let mut records = views.lock();
        let Some(record) = records.get_mut(&id) else {
            continue;
        };
        if require_record_page(record, page_lease).is_err() {
            failed = true;
            continue;
        }
        if record.closing || !record.visible {
            continue;
        }
        if let Some(child) = child {
            if child.hide().is_ok() {
                record.visible = false;
                record.visibility_version = record.visibility_version.saturating_add(1);
                hidden += 1;
            } else if child.close().is_ok() {
                records.remove(&id);
                hidden += 1;
            } else {
                failed = true;
            }
        } else if record.creating {
            record.visible = false;
            record.visibility_version = record.visibility_version.saturating_add(1);
            hidden += 1;
        } else {
            records.remove(&id);
        }
    }
    if failed {
        Err(unavailable(
            "browser_hide_failed",
            "KalCode couldn't safely hide every browser pane.",
        ))
    } else {
        Ok(hidden)
    }
}

#[tauri::command(async)]
pub fn browser_open_external(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    webview: Webview,
    views: State<'_, BrowserViews>,
    url: String,
    page_lease: u64,
) -> Result<(), IpcError> {
    _runtime_access.revalidate()?;
    trusted(&webview)?;
    let url = normalize_browser_url(&url).map_err(policy_error)?;
    require_current_page_lease(&views, page_lease)?;
    webview
        .app_handle()
        .opener()
        .open_url(url.to_string(), None::<&str>)
        .map_err(|_| {
            unavailable(
                "browser_external_failed",
                "KalCode couldn't open the system browser.",
            )
        })
}

/// The live native child of a ready, current-page Browser record, with its URL and visibility.
fn ready_child(
    runtime_access: &crate::runtime_coordinator::RuntimeAccess,
    webview: &Webview,
    views: &BrowserViews,
    browser_id: &str,
    page_lease: u64,
) -> Result<(Webview, String, bool), IpcError> {
    runtime_access.revalidate()?;
    trusted(webview)?;
    validate_browser_id(browser_id).map_err(policy_error)?;
    require_current_page_lease(views, page_lease)?;
    let (url, visible) = {
        let records = views.lock();
        let record = records
            .get(browser_id)
            .ok_or_else(|| unavailable("browser_not_found", "That browser pane is not open."))?;
        require_ready_record(record, page_lease)?;
        (record.url.clone(), record.visible)
    };
    let child = webview
        .app_handle()
        .get_webview(&label(browser_id, page_lease, runtime_access.generation()))
        .ok_or_else(|| unavailable("browser_not_found", "That browser pane is not open."))?;
    Ok((child, url, visible))
}

/// Evaluates one fixed helper script in the page and waits briefly for its JSON answer.
async fn evaluate_helper(child: &Webview, script: &'static str) -> Option<String> {
    let (sender, receiver) = std::sync::mpsc::sync_channel::<String>(1);
    child
        .eval_with_callback(script, move |answer| {
            let _ = sender.try_send(answer);
        })
        .ok()?;
    tauri::async_runtime::spawn_blocking(move || {
        receiver.recv_timeout(std::time::Duration::from_millis(1500))
    })
    .await
    .ok()?
    .ok()
}

/// Console/load errors and the element the person picked. A page without the helper (an error
/// page, a load still committing, or a slow page) reports `available: false`, never an error.
#[tauri::command(async)]
pub async fn browser_inspect(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    webview: Webview,
    views: State<'_, BrowserViews>,
    browser_id: String,
    page_lease: u64,
) -> Result<crate::browser_live::BrowserInspection, IpcError> {
    let (child, _, _) = ready_child(&_runtime_access, &webview, &views, &browser_id, page_lease)?;
    Ok(evaluate_helper(&child, crate::browser_live::INSPECT_SCRIPT)
        .await
        .map(|answer| crate::browser_live::parse_inspection(&answer))
        .unwrap_or_default())
}

/// Starts or stops element picking in the page. Resolves whether picking is now active.
#[tauri::command(async)]
pub async fn browser_pick(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    webview: Webview,
    views: State<'_, BrowserViews>,
    browser_id: String,
    active: bool,
    page_lease: u64,
) -> Result<bool, IpcError> {
    let (child, _, _) = ready_child(&_runtime_access, &webview, &views, &browser_id, page_lease)?;
    let script = if active {
        crate::browser_live::START_PICK_SCRIPT
    } else {
        crate::browser_live::STOP_PICK_SCRIPT
    };
    match evaluate_helper(&child, script).await.as_deref() {
        Some("true") => Ok(true),
        Some(_) => Ok(false),
        None if !active => Ok(false),
        None => Err(unavailable(
            "browser_pick_unavailable",
            "This page isn't ready for picking yet. Try again once it has loaded.",
        )),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserScreenshot {
    path: String,
    file_name: String,
}

fn screenshot_dir(app: &tauri::AppHandle, data_dir: &Path) -> PathBuf {
    // E2E runs keep every file inside their disposable data root, never the person's Pictures.
    if cfg!(feature = "e2e") {
        return data_dir.join("browser-screenshots");
    }
    app.path()
        .picture_dir()
        .map(|pictures| pictures.join("KalCode"))
        .unwrap_or_else(|_| data_dir.join("browser-screenshots"))
}

fn screenshot_save_failed() -> IpcError {
    unavailable(
        "browser_screenshot_save_failed",
        "KalCode couldn't save the screenshot.",
    )
}

/// Saves a PNG of the visible Browser page in Pictures/KalCode and returns where it went.
#[tauri::command(async)]
pub async fn browser_screenshot(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    webview: Webview,
    state: State<'_, AppState>,
    views: State<'_, BrowserViews>,
    browser_id: String,
    page_lease: u64,
) -> Result<BrowserScreenshot, IpcError> {
    let (child, url, visible) =
        ready_child(&_runtime_access, &webview, &views, &browser_id, page_lease)?;
    if !visible {
        return Err(KalError::validation(
            "browser_screenshot_hidden",
            "Show the browser pane before taking a screenshot.",
        )
        .to_ipc());
    }
    let bytes = crate::browser_live::capture_png(&child)
        .await
        .map_err(|code| unavailable(code, "KalCode couldn't capture this page."))?;
    if !crate::browser_live::is_png(&bytes) {
        return Err(unavailable(
            "browser_screenshot_failed",
            "KalCode couldn't capture this page.",
        ));
    }
    let host = url::Url::parse(&url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .unwrap_or_default();
    let directory = screenshot_dir(webview.app_handle(), &state.paths.data_dir);
    let saved = tauri::async_runtime::spawn_blocking(move || -> std::io::Result<PathBuf> {
        std::fs::create_dir_all(&directory)?;
        let name = crate::browser_live::screenshot_file_name(
            &host,
            &crate::browser_live::screenshot_stamp(),
        );
        let path = crate::browser_live::unique_path(&directory, &name);
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        std::io::Write::write_all(&mut file, &bytes)?;
        Ok(path)
    })
    .await
    .map_err(|_| screenshot_save_failed())?
    .map_err(|_| screenshot_save_failed())?;
    Ok(BrowserScreenshot {
        file_name: saved
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: saved.to_string_lossy().into_owned(),
    })
}

/// Shows a Live Browser screenshot in the file manager. Only files in the screenshot folder.
#[tauri::command(async)]
pub fn browser_reveal_screenshot(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    webview: Webview,
    state: State<'_, AppState>,
    path: String,
) -> Result<(), IpcError> {
    _runtime_access.revalidate()?;
    trusted(&webview)?;
    let refused = || {
        KalError::validation(
            "browser_screenshot_unknown",
            "That screenshot isn't in KalCode's screenshot folder.",
        )
        .to_ipc()
    };
    let directory = screenshot_dir(webview.app_handle(), &state.paths.data_dir)
        .canonicalize()
        .map_err(|_| refused())?;
    let file = Path::new(&path).canonicalize().map_err(|_| refused())?;
    if file.parent() != Some(directory.as_path())
        || file.extension().and_then(|extension| extension.to_str()) != Some("png")
    {
        return Err(refused());
    }
    webview
        .app_handle()
        .opener()
        .reveal_item_in_dir(&file)
        .map_err(|_| {
            unavailable(
                "browser_reveal_failed",
                "KalCode couldn't show the screenshot.",
            )
        })
}

pub fn close_all(app: &tauri::AppHandle, views: &BrowserViews) -> Result<usize, IpcError> {
    // Account/runtime cleanup uses the same atomic authority transition as a page reload. New
    // account work can observe the lease but cannot reserve until every old record is detached.
    let (_current_page, detached) = views.rotate_page_lease_and_take_close_targets();
    close_detached_views(app, views, detached)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(url: &str) -> BrowserRecord {
        BrowserRecord {
            workspace_id: "01992ac0-e385-71a9-9548-bc0a8362133d".into(),
            url: url.into(),
            title: None,
            loading: true,
            visible: false,
            bounds: BrowserBounds {
                x: 0.0,
                y: 0.0,
                width: 800.0,
                height: 600.0,
            },
            creating: true,
            closing: false,
            page_lease: 1,
            account_generation: 41,
            visibility_version: 0,
            blocked_popup: None,
            blocked_popup_seq: 0,
            #[cfg(feature = "e2e")]
            debug_port: None,
        }
    }

    fn close_target(
        browser_id: &str,
        page_lease: u64,
        account_generation: u64,
    ) -> BrowserCloseTarget {
        BrowserCloseTarget {
            browser_id: browser_id.to_owned(),
            page_lease,
            account_generation,
        }
    }

    #[test]
    fn an_old_page_cannot_rebind_or_show_a_newer_page_record() {
        let views = BrowserViews::default();
        let stale_lease = views.current_page_lease();
        let (current_lease, detached) = views.rotate_page_lease_and_take_close_targets();
        assert!(detached.is_empty());
        let id = "01992ac0-e385-71a9-9548-bc0a8362133e".to_owned();
        let mut current = record("https://current.example/");
        current.page_lease = current_lease;
        current.creating = false;
        current.visible = false;
        current.visibility_version = 50;
        views.lock().insert(id.clone(), current);

        let mut delayed_old_page = record("https://stale.example/");
        delayed_old_page.page_lease = stale_lease;
        delayed_old_page.visible = true;
        let error = views.reserve(id.clone(), delayed_old_page).unwrap_err();

        assert_eq!(error.code, "browser_page_lease_expired");
        let stale_command = match require_current_page_lease(&views, stale_lease) {
            Ok(_) => panic!("an expired renderer page acquired Browser authority"),
            Err(error) => error,
        };
        assert_eq!(stale_command.code, "browser_page_lease_expired");
        assert_ne!(label(&id, stale_lease, 41), label(&id, current_lease, 41));
        // Simulate a delayed L1 close finishing after L2 has installed the same durable ID.
        finish_attach_close(&views, &close_target(&id, stale_lease, 41), true, false);
        let current = views.lock().get(&id).cloned().unwrap();
        assert_eq!(current.page_lease, current_lease);
        assert!(!current.visible);
        assert_eq!(current.url, "https://current.example/");
        assert_eq!(current.visibility_version, 50);
    }

    #[test]
    fn in_flight_or_closing_records_are_never_reported_ready() {
        let mut in_flight = record("https://requested.example/");
        let error = require_ready_record(&in_flight, 1).unwrap_err();
        assert_eq!(error.code, "browser_starting");
        assert!(error.retryable);

        in_flight.closing = true;
        let error = require_ready_record(&in_flight, 1).unwrap_err();
        assert_eq!(error.code, "browser_closing");
        assert!(error.retryable);

        in_flight.closing = false;
        in_flight.creating = false;
        require_ready_record(&in_flight, 1).unwrap();
    }

    #[test]
    fn page_transition_detaches_old_records_before_same_id_replacement_can_reserve() {
        let views = BrowserViews::default();
        let old_page = views.current_page_lease();
        let id = "01992ac0-e385-71a9-9548-bc0a8362133e".to_owned();
        views
            .reserve(id.clone(), record("https://old.example/"))
            .unwrap();
        assert!(views.lock().get(&id).unwrap().creating);

        let (new_page, detached) = views.rotate_page_lease_and_take_close_targets();
        assert_eq!(detached.len(), 1);
        assert!(views.lock().is_empty());
        assert_eq!(
            require_current_page_lease(&views, old_page)
                .unwrap_err()
                .code,
            "browser_page_lease_expired"
        );

        let mut replacement = record("https://new.example/");
        replacement.page_lease = new_page;
        replacement.creating = false;
        views.reserve(id.clone(), replacement).unwrap();

        let old_target = detached.into_iter().next().unwrap();
        assert_eq!(old_target.browser_id, id);
        assert_eq!(old_target.page_lease, old_page);
        assert_ne!(
            label(
                &old_target.browser_id,
                old_target.page_lease,
                old_target.account_generation
            ),
            label(&id, new_page, 41),
        );
        // A delayed old close completion is scoped to its captured lease and cannot remove the
        // replacement record that reused the durable Browser identity.
        finish_attach_close(&views, &old_target, true, false);
        let current = views.lock().get(&id).cloned().unwrap();
        assert_eq!(current.page_lease, new_page);
        assert_eq!(current.url, "https://new.example/");
    }

    #[test]
    fn failed_old_close_remains_pending_alongside_a_same_id_replacement() {
        let views = BrowserViews::default();
        let old_page = views.current_page_lease();
        let id = "01992ac0-e385-71a9-9548-bc0a8362133e".to_owned();
        views
            .reserve(id.clone(), record("https://old.example/"))
            .unwrap();
        assert!(views.lock().get(&id).unwrap().creating);

        let (new_page, detached) = views.rotate_page_lease_and_take_close_targets();
        let old_target = detached.into_iter().next().unwrap();
        assert_eq!(old_target.page_lease, old_page);
        let mut replacement = record("https://new.example/");
        replacement.page_lease = new_page;
        replacement.account_generation = 42;
        replacement.creating = false;
        views.reserve(id.clone(), replacement).unwrap();

        // Requeueing is idempotent and independent from the active record map, so a failed old
        // native close cannot overwrite or lose a same-ID replacement.
        views.finish_failed_attach_close(&old_target, false);
        views.finish_failed_attach_close(&old_target, false);
        assert_eq!(views.lock_pending_closes().len(), 1);
        assert_eq!(views.lock().get(&id).unwrap().page_lease, new_page);

        let (_next_page, retry) = views.rotate_page_lease_and_take_close_targets();
        assert_eq!(retry.len(), 2);
        let retry: HashSet<_> = retry.into_iter().collect();
        assert!(retry.contains(&old_target));
        assert!(retry.contains(&BrowserCloseTarget {
            browser_id: id,
            page_lease: new_page,
            account_generation: 42,
        }));
        assert!(views.lock_pending_closes().is_empty());
        assert!(views.lock().is_empty());
    }

    #[test]
    fn a_stale_record_without_a_native_child_can_be_replaced() {
        let views = BrowserViews::default();
        let id = "01992ac0-e385-71a9-9548-bc0a8362133e".to_owned();
        let mut stale = record("https://stale.example/");
        stale.creating = false;
        views.reserve(id.clone(), stale).unwrap();

        views
            .reserve(id.clone(), record("https://replacement.example/"))
            .unwrap();

        let records = views.lock();
        let replacement = records.get(&id).unwrap();
        assert!(replacement.creating);
        assert_eq!(replacement.url, "https://replacement.example/");
    }

    #[test]
    fn browser_reservation_is_exclusive_and_does_not_overwrite() {
        let views = BrowserViews::default();
        let id = "01992ac0-e385-71a9-9548-bc0a8362133e".to_owned();
        views
            .reserve(id.clone(), record("https://first.example/"))
            .unwrap();
        let error = views
            .reserve(id.clone(), record("https://second.example/"))
            .unwrap_err();
        assert_eq!(error.code, "browser_starting");
        assert_eq!(views.lock().get(&id).unwrap().url, "https://first.example/");
    }

    #[cfg(feature = "e2e")]
    #[test]
    fn e2e_children_in_one_workspace_reuse_compatible_debug_options() {
        let views = BrowserViews::default();
        let id = "01992ac0-e385-71a9-9548-bc0a8362133e".to_owned();
        let mut value = record("https://first.example/");
        value.debug_port = Some(19_433);
        views.reserve(id, value).unwrap();
        let second_id = "01992ac0-e385-71a9-9548-bc0a83621340".to_owned();
        views
            .reserve(second_id.clone(), record("https://second.example/"))
            .unwrap();

        assert_eq!(
            views
                .lock()
                .get(&second_id)
                .and_then(|record| record.debug_port),
            Some(19_433)
        );
    }

    #[test]
    fn browser_profile_rejects_non_directory_ancestors() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("browser-data"), b"not a directory").unwrap();
        let error = browser_profile_dir(
            temp.path(),
            "acct_synthetic_a",
            "01992ac0-e385-71a9-9548-bc0a8362133d",
        )
        .unwrap_err();
        assert_eq!(error.code, "browser_profile_unsafe");
    }

    #[test]
    fn browser_profiles_persist_for_one_account_but_isolate_accounts_in_one_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = "01992ac0-e385-71a9-9548-bc0a8362133d";
        let first = browser_profile_dir(temp.path(), "acct_synthetic_a", workspace).unwrap();
        let same_account = browser_profile_dir(temp.path(), "acct_synthetic_a", workspace).unwrap();
        let other_account =
            browser_profile_dir(temp.path(), "acct_synthetic_b", workspace).unwrap();

        assert_eq!(first.as_path(), same_account.as_path());
        assert_ne!(first.as_path(), other_account.as_path());
        assert!(
            !first
                .as_path()
                .to_string_lossy()
                .contains("acct_synthetic_a")
        );
        assert!(
            !other_account
                .as_path()
                .to_string_lossy()
                .contains("acct_synthetic_b")
        );
    }

    #[test]
    fn account_profiles_do_not_adopt_legacy_workspace_cookies() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = "01992ac0-e385-71a9-9548-bc0a8362133d";
        let legacy = temp.path().join("browser-data").join(workspace);
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("cookies"), b"unowned cookies").unwrap();
        let scoped = browser_profile_dir(temp.path(), "acct_synthetic_a", workspace).unwrap();
        assert_ne!(scoped, legacy);
        assert!(!scoped.join("cookies").exists());
        assert_eq!(
            std::fs::read(legacy.join("cookies")).unwrap(),
            b"unowned cookies"
        );
    }

    #[cfg(any(windows, unix))]
    #[test]
    fn account_profile_rejects_linked_workspace_without_touching_target() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = "01992ac0-e385-71a9-9548-bc0a8362133d";
        let profile = browser_profile_dir(temp.path(), "acct_synthetic_a", workspace).unwrap();
        std::fs::remove_dir(&profile).unwrap();
        let outside = temp.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt as _;
            let output = std::process::Command::new("cmd.exe")
                .args(["/C", "mklink", "/J"])
                .arg(&profile)
                .arg(&outside)
                .creation_flags(0x0800_0000)
                .output()
                .unwrap();
            assert!(output.status.success());
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &profile).unwrap();
        assert_eq!(
            browser_profile_dir(temp.path(), "acct_synthetic_a", workspace)
                .unwrap_err()
                .code,
            "browser_profile_unsafe"
        );
        assert!(std::fs::read_dir(&outside).unwrap().next().is_none());
        #[cfg(windows)]
        std::fs::remove_dir(&profile).unwrap();
        #[cfg(unix)]
        std::fs::remove_file(&profile).unwrap();
    }

    #[test]
    fn account_cleanup_fences_old_callbacks_and_preserves_new_account_records() {
        let views = BrowserViews::default();
        let id = "01992ac0-e385-71a9-9548-bc0a8362133e".to_owned();
        let old_page = views.current_page_lease();
        let mut old = record("https://old.example/");
        old.creating = false;
        views.reserve(id.clone(), old).unwrap();
        // This transaction is the first action of close_all, even if native close must retry.
        let (next_page, detached) = views.rotate_page_lease_and_take_close_targets();
        assert_eq!(detached.len(), 1);
        let old_target = detached.into_iter().next().unwrap();
        assert!(require_current_page_lease(&views, old_page).is_err());
        let mut new = record("https://new.example/");
        new.page_lease = next_page;
        new.account_generation = 42;
        views.reserve(id.clone(), new).unwrap();
        // The exact old native handle/label may finish later, after a new account reused the ID.
        finish_attach_close(&views, &old_target, true, false);
        let current = views.lock().get(&id).cloned().unwrap();
        assert_eq!(current.account_generation, 42);
        assert_eq!(current.url, "https://new.example/");
        assert!(require_record_page(&current, old_page).is_err());
    }

    #[test]
    fn account_generation_cannot_overwrite_a_retained_browser_record() {
        let views = BrowserViews::default();
        let id = "01992ac0-e385-71a9-9548-bc0a8362133e".to_owned();
        let mut old = record("https://old.example/");
        old.creating = false;
        views.reserve(id.clone(), old).unwrap();
        let mut new = record("https://new.example/");
        new.account_generation = 42;
        assert_eq!(
            views.reserve(id.clone(), new).unwrap_err().code,
            "browser_account_expired"
        );
        assert_eq!(views.lock().get(&id).unwrap().account_generation, 41);
    }

    #[test]
    fn native_labels_bind_account_generation_as_well_as_page_lease() {
        let id = "01992ac0-e385-71a9-9548-bc0a8362133e";
        assert_ne!(label(id, 7, 41), label(id, 7, 42));
        assert_ne!(label(id, 7, 42), label(id, 8, 42));
    }

    #[test]
    fn failed_native_close_keeps_a_retryable_record() {
        let views = BrowserViews::default();
        let id = "01992ac0-e385-71a9-9548-bc0a8362133e".to_owned();
        let mut value = record("https://first.example/");
        value.creating = false;
        value.visible = true;
        views.reserve(id.clone(), value).unwrap();

        let (_, prior_visible) = mark_renderer_close_started(&views, &id, 1)
            .unwrap()
            .unwrap();
        let target = close_target(&id, 1, 41);
        finish_attach_close(&views, &target, false, prior_visible);
        let retained = views.lock().get(&id).cloned().unwrap();
        assert!(!retained.closing);
        assert!(retained.visible);

        let (_, prior_visible) = mark_renderer_close_started(&views, &id, 1)
            .unwrap()
            .unwrap();
        finish_attach_close(&views, &target, true, prior_visible);
        assert!(!views.lock().contains_key(&id));
    }

    #[test]
    fn close_winning_during_creation_cannot_leave_a_record() {
        let views = BrowserViews::default();
        let id = "01992ac0-e385-71a9-9548-bc0a8362133e".to_owned();
        views
            .reserve(id.clone(), record("https://first.example/"))
            .unwrap();

        let (creating, prior_visible) = mark_renderer_close_started(&views, &id, 1)
            .unwrap()
            .unwrap();
        assert!(creating);
        assert!(views.lock().get(&id).unwrap().closing);
        // Simulates creation observing `closing` and closing the newly created native child.
        finish_attach_close(&views, &close_target(&id, 1, 41), true, prior_visible);
        assert!(!views.lock().contains_key(&id));
    }

    #[test]
    fn older_show_cannot_override_a_priority_hide() {
        let mut value = record("https://first.example/");
        value.visibility_version = 5;
        value.visible = false;
        let moved = BrowserBounds {
            x: 400.0,
            y: 20.0,
            width: 800.0,
            height: 600.0,
        };

        apply_view_state(&mut value, moved, true, 4);
        assert!(!effective_visibility(&value, true, 4));
        assert!(!value.visible);
        assert_eq!(value.visibility_version, 5);
        assert_eq!(value.bounds, moved);
    }

    #[test]
    fn browser_titles_strip_controls_and_bidirectional_formatting() {
        let title = clean_title("Trusted\0evil \u{202e}moc.live \u{2066}x".into()).unwrap();
        assert_eq!(title, "Trustedevil moc.live x");
        assert!(!title.chars().any(char::is_control));
        assert!(!title.chars().any(is_bidi_format));
    }

    #[test]
    fn browser_info_never_asks_macos_webkit_for_its_url() {
        // wry 0.55.1 unwraps a nil `WKWebView.URL` when the first load failed, aborting the app.
        #[cfg(target_os = "macos")]
        const {
            assert!(!NATIVE_URL_QUERY_IS_SAFE)
        };
        #[cfg(windows)]
        const {
            assert!(NATIVE_URL_QUERY_IS_SAFE)
        };
        let current = native_browser_url(false, || {
            panic!("the native URL must not be read when the query is unsafe")
        });
        assert_eq!(current, None);
    }

    #[test]
    fn browser_info_keeps_only_safe_native_urls_where_the_query_is_safe() {
        let page = url::Url::parse("https://example.com/docs").unwrap();
        assert_eq!(native_browser_url(true, || Some(page.clone())), Some(page));
        let file = url::Url::parse("file:///etc/passwd").unwrap();
        assert_eq!(native_browser_url(true, || Some(file)), None);
        assert_eq!(native_browser_url(true, || None), None);
    }

    #[test]
    fn browser_child_url_is_read_only_through_the_platform_guard() {
        let source = include_str!("browser_commands.rs");
        let needle = concat!("child", ".url()");
        let calls: Vec<&str> = source
            .lines()
            .filter(|line| line.contains(needle))
            .collect();
        assert_eq!(calls.len(), 1, "unguarded child URL reads: {calls:?}");
        assert!(calls[0].contains("native_browser_url(NATIVE_URL_QUERY_IS_SAFE"));
    }
}
