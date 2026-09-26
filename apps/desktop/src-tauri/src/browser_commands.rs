//! Real, isolated child-webview browser panes.
//!
//! Only the trusted `main` webview can call these commands. Remote child webviews receive no
//! capability grants, may navigate only to credential-free HTTP(S), and cannot open popups or
//! download files. Each authenticated account/workspace pair receives a separate WebView data directory.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
#[cfg(feature = "e2e")]
use std::sync::atomic::AtomicU16;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use kalcode_contracts::ids::is_valid_id;
use kalcode_core::{ErrorCategory, IpcError, KalError};
use serde::{Deserialize, Serialize};
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, State, Webview, WebviewUrl};
use tauri_plugin_opener::OpenerExt;

use crate::AppState;
use crate::browser_policy::{
    BrowserBounds, BrowserPolicyError, normalize_browser_url, safe_runtime_url, validate_bounds,
    validate_browser_id,
};

const MAX_BROWSER_VIEWS: usize = 8;
const FOCUS_EVENT: &str = "kalcode://browser-focus";
const HIDDEN_CHILD_POSITION: f64 = 16_000.0;
#[cfg(feature = "e2e")]
static NEXT_E2E_DEBUG_PORT: AtomicU16 = AtomicU16::new(0);

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
    #[cfg(feature = "e2e")]
    debug_port: Option<u16>,
}

#[derive(Clone)]
pub struct BrowserViews {
    records: Arc<Mutex<HashMap<String, BrowserRecord>>>,
    page_lease: Arc<AtomicU64>,
}

impl Default for BrowserViews {
    fn default() -> Self {
        Self {
            records: Arc::new(Mutex::new(HashMap::new())),
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

    fn rotate_page_lease(&self) -> u64 {
        // Native child labels include this generation, so queued work from a prior trusted page
        // cannot address a replacement child that reuses the same durable Browser identity.
        let _records = self.lock();
        let current = self.page_lease.load(Ordering::Acquire);
        let Some(next) = current.checked_add(1) else {
            // Reusing a generation would permit an ABA visibility bypass. This limit cannot be
            // reached in a real process lifetime, so fail closed instead of wrapping.
            std::process::abort();
        };
        self.page_lease.store(next, Ordering::Release);
        next
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
    #[cfg(feature = "e2e")]
    #[serde(skip_serializing_if = "Option::is_none")]
    debug_port: Option<u16>,
}

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
            #[cfg(feature = "e2e")]
            debug_port: record.debug_port,
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
    browser_id: &str,
    page_lease: u64,
    primary_error: IpcError,
) -> IpcError {
    if child.close().is_ok() {
        let mut records = views.lock();
        if records
            .get(browser_id)
            .is_some_and(|record| record.page_lease == page_lease)
        {
            records.remove(browser_id);
        }
        primary_error
    } else {
        if let Some(record) = views
            .lock()
            .get_mut(browser_id)
            .filter(|record| record.page_lease == page_lease)
        {
            record.creating = false;
            record.closing = false;
            record.visible = false;
        }
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
    browser_id: &str,
    page_lease: u64,
    succeeded: bool,
    previous_visible: bool,
) {
    let mut records = views.lock();
    let matches_lease = records
        .get(browser_id)
        .is_some_and(|record| record.page_lease == page_lease);
    if !matches_lease {
        return;
    }
    if succeeded {
        records.remove(browser_id);
    } else if let Some(record) = records.get_mut(browser_id) {
        record.closing = false;
        record.visible = previous_visible;
    }
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
            b"com.kalcode.desktop/browser-account/v1\0".as_slice(),
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

/// Begins a new trusted main-webview lifecycle. The lease is native authority,
/// so delayed requests from an older page cannot rebind a Browser child.
pub fn begin_page_load(views: &BrowserViews) -> u64 {
    views.rotate_page_lease()
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
    _runtime_access.revalidate()?;
    let child_label = label(
        &request.browser_id,
        request.page_lease,
        _runtime_access.generation(),
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
    let builder = crate::browser_profile::configure(
        WebviewBuilder::new(child_label, WebviewUrl::External(url)),
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
    .on_new_window(|_, _| NewWindowResponse::Deny)
    .on_download(|_, _| false)
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
        return Err(cleanup_failed_attach(
            &child,
            &views,
            &request.browser_id,
            request.page_lease,
            error,
        ));
    }
    if child.hide().is_err() {
        return Err(cleanup_failed_attach(
            &child,
            &views,
            &request.browser_id,
            request.page_lease,
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
        finish_attach_close(
            &views,
            &request.browser_id,
            request.page_lease,
            closed,
            false,
        );
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
    if let Err(error) = bind_native_focus(
        &child,
        request.browser_id.clone(),
        request.page_lease,
        views.inner().clone(),
    )
    .await
    {
        return Err(cleanup_failed_attach(
            &child,
            &views,
            &request.browser_id,
            request.page_lease,
            error,
        ));
    }

    match _runtime_access
        .revalidate()
        .and_then(|()| require_current_page_lease(&views, request.page_lease))
    {
        Ok(()) => {}
        Err(error) => {
            return Err(cleanup_failed_attach(
                &child,
                &views,
                &request.browser_id,
                request.page_lease,
                error,
            ));
        }
    }
    let mut records = views.lock();
    let Some(record) = records.get_mut(&request.browser_id) else {
        drop(records);
        return Err(cleanup_failed_attach(
            &child,
            &views,
            &request.browser_id,
            request.page_lease,
            unavailable("browser_state_missing", "That browser pane is unavailable."),
        ));
    };
    if request.page_lease != views.current_page_lease() || record.page_lease != request.page_lease {
        drop(records);
        return Err(cleanup_failed_attach(
            &child,
            &views,
            &request.browser_id,
            request.page_lease,
            retryable_unavailable(
                "browser_page_lease_expired",
                "The Browser request belongs to an expired trusted page.",
            ),
        ));
    }
    if record.closing {
        drop(records);
        let closed = child.close().is_ok();
        finish_attach_close(
            &views,
            &request.browser_id,
            request.page_lease,
            closed,
            false,
        );
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
        return Err(cleanup_failed_attach(
            &child,
            &views,
            &request.browser_id,
            request.page_lease,
            error,
        ));
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

#[tauri::command]
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
        require_record_page(record, page_lease)?;
    }
    let current_url = webview
        .app_handle()
        .get_webview(&label(
            &browser_id,
            page_lease,
            _runtime_access.generation(),
        ))
        .and_then(|child| child.url().ok())
        .filter(safe_runtime_url);
    let mut records = views.lock();
    let record = records
        .get_mut(&browser_id)
        .ok_or_else(|| unavailable("browser_not_found", "That browser pane is not open."))?;
    require_record_page(record, page_lease)?;
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
    let Some((creating, previous_visible)) =
        mark_renderer_close_started(&views, &browser_id, page_lease)?
    else {
        if let Some(child) = webview.app_handle().get_webview(&label(
            &browser_id,
            page_lease,
            _runtime_access.generation(),
        )) {
            child.close().map_err(|_| {
                unavailable(
                    "browser_close_failed",
                    "KalCode couldn't close that browser pane.",
                )
            })?;
        }
        return Ok(false);
    };
    if let Some(child) = webview.app_handle().get_webview(&label(
        &browser_id,
        page_lease,
        _runtime_access.generation(),
    )) {
        let closed = child.close().is_ok();
        finish_attach_close(&views, &browser_id, page_lease, closed, previous_visible);
        if !closed {
            return Err(unavailable(
                "browser_close_failed",
                "KalCode couldn't close that browser pane.",
            ));
        }
    } else if !creating {
        finish_attach_close(&views, &browser_id, page_lease, true, previous_visible);
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

#[tauri::command]
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

pub fn close_all(app: &tauri::AppHandle, views: &BrowserViews) -> Result<usize, IpcError> {
    // Cleanup runs after account leases drain. Invalidate the page even when the main WebView
    // stays loaded, so callbacks/queued requests from the prior account cannot address new views.
    views.rotate_page_lease();
    let ids: Vec<(String, u64, u64)> = views
        .lock()
        .iter()
        .map(|(id, record)| (id.clone(), record.page_lease, record.account_generation))
        .collect();
    let mut closed = 0;
    let mut failed = false;
    for (id, page_lease, account_generation) in ids {
        let Ok(Some((creating, previous_visible))) =
            mark_renderer_close_started(views, &id, page_lease)
        else {
            continue;
        };
        if let Some(child) = app.get_webview(&label(&id, page_lease, account_generation)) {
            let succeeded = child.close().is_ok();
            finish_attach_close(views, &id, page_lease, succeeded, previous_visible);
            if succeeded {
                closed += 1;
            } else {
                failed = true;
            }
        } else if creating {
            closed += 1;
        } else {
            finish_attach_close(views, &id, page_lease, true, previous_visible);
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
            #[cfg(feature = "e2e")]
            debug_port: None,
        }
    }

    #[test]
    fn an_old_page_cannot_rebind_or_show_a_newer_page_record() {
        let views = BrowserViews::default();
        let stale_lease = views.current_page_lease();
        let current_lease = views.rotate_page_lease();
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
        finish_attach_close(&views, &id, stale_lease, true, false);
        let current = views.lock().get(&id).cloned().unwrap();
        assert_eq!(current.page_lease, current_lease);
        assert!(!current.visible);
        assert_eq!(current.url, "https://current.example/");
        assert_eq!(current.visibility_version, 50);
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
        // This rotation is the first action of close_all, even if native close must retry.
        let next_page = views.rotate_page_lease();
        assert!(require_current_page_lease(&views, old_page).is_err());
        finish_attach_close(&views, &id, old_page, true, false);
        let mut new = record("https://new.example/");
        new.page_lease = next_page;
        new.account_generation = 42;
        views.reserve(id.clone(), new).unwrap();
        finish_attach_close(&views, &id, old_page, true, false);
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
        finish_attach_close(&views, &id, 1, false, prior_visible);
        let retained = views.lock().get(&id).cloned().unwrap();
        assert!(!retained.closing);
        assert!(retained.visible);

        let (_, prior_visible) = mark_renderer_close_started(&views, &id, 1)
            .unwrap()
            .unwrap();
        finish_attach_close(&views, &id, 1, true, prior_visible);
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
        finish_attach_close(&views, &id, 1, true, prior_visible);
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
}
