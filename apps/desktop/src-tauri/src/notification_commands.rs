//! Notification center IPC (campaign Z7-W3): `notification_list` and `notification_mark`.
//!
//! [`NotificationsState::start`] subscribes to the core's events before the thread runtime
//! starts (so its crash-recovery transitions become a "can be resumed" notification) and
//! [`NotificationsState::bind`] hands it the thread runtime once it exists, for thread names and
//! pending-approval counts. Notifications are derived in `kalcode_notifications` from structured
//! events only; each one names the entity it opens, and the WebView focuses it.
//!
//! Until the lead registers migration v11, the center keeps notifications in memory (they last
//! until KalCode closes); with v11 applied, read and dismissed state persist.
//!
//! OS toasts are deliberately not sent in this build. They would need `tauri-plugin-notification`
//! (a new native dependency tree for cargo-deny review), Windows attributes toasts to the
//! installed app's AUMID (unreliable for portable and development builds), and an opt-in setting
//! (a new Z0 typed settings key). The in-app center covers every notification meanwhile.

use std::sync::Arc;
use std::time::Duration;

use kalcode_contracts::notifications::{NotificationMark, NotificationPage};
use kalcode_core::{Core, IpcError, KalError};
use kalcode_notifications::{Listener, Lookup, NotificationCenter, ThreadInfo};
use kalcode_threads::ThreadRuntime;
use tauri::State;

use crate::AppState;

/// How long early events wait for the thread runtime's names before using neutral ones.
const BIND_TIMEOUT: Duration = Duration::from_secs(5);

/// Managed state: the center and its event listener, when the core started.
pub struct NotificationsState {
    center: Option<Arc<NotificationCenter>>,
    listener: Option<Listener>,
}

/// Thread facts through the thread runtime's API (never its tables).
struct RuntimeLookup {
    threads: Option<Arc<ThreadRuntime>>,
}

impl Lookup for RuntimeLookup {
    fn thread(&self, thread_id: &str) -> Option<ThreadInfo> {
        let summary = self.threads.as_ref()?.get(thread_id).ok()?;
        Some(ThreadInfo {
            name: summary.name,
            provider_name: Some(summary.provider_name),
            workspace_id: Some(summary.workspace_id),
            workspace_name: Some(summary.workspace_name),
            pending_approvals: summary.pending_approvals,
        })
    }

    fn recovered_detail(&self) -> Option<&str> {
        Some(kalcode_threads::runtime::RECOVERED_ACTIVITY)
    }
}

impl NotificationsState {
    /// Opens the center and starts listening. Call before the thread runtime starts.
    pub fn start(core: Option<&Arc<Core>>) -> Self {
        let Some(core) = core else {
            return Self {
                center: None,
                listener: None,
            };
        };
        match NotificationCenter::open(core.clone()) {
            Ok(center) => {
                let center = Arc::new(center);
                let listener = Listener::start(core.clone(), center.clone(), BIND_TIMEOUT);
                Self {
                    center: Some(center),
                    listener: Some(listener),
                }
            }
            Err(error) => {
                tracing::error!(event = "notifications.start_failed", error_code = error.code, error = %error.diagnostic());
                Self {
                    center: None,
                    listener: None,
                }
            }
        }
    }

    /// Hands the listener the thread runtime (thread names, pending approvals).
    pub fn bind(&self, threads: Option<Arc<ThreadRuntime>>) {
        if let Some(listener) = &self.listener {
            listener.bind(Arc::new(RuntimeLookup { threads }));
        }
    }

    pub fn shutdown(&self) {
        if let Some(listener) = &self.listener {
            listener.shutdown();
        }
    }

    fn get(&self, app: &AppState) -> Result<&Arc<NotificationCenter>, IpcError> {
        app.core()?;
        self.center.as_ref().ok_or_else(|| {
            KalError::internal(
                "notifications_unavailable",
                "KalCode's notification center isn't available.",
            )
            .to_ipc()
        })
    }
}

/// A page of notifications, most recently raised first, with the unread count.
#[tauri::command(async)]
pub fn notification_list(
    app: State<'_, AppState>,
    notifications: State<'_, NotificationsState>,
    unread_only: bool,
    limit: u32,
    before: Option<String>,
) -> Result<NotificationPage, IpcError> {
    let center = notifications.get(&app)?;
    center
        .list(unread_only, limit, before.as_deref())
        .map_err(|e| e.log_and_convert("notification_list"))
}

/// Marks notifications read, unread or dismissed; `ids: null` applies to every undismissed one.
/// Returns how many changed.
#[tauri::command(async)]
pub fn notification_mark(
    app: State<'_, AppState>,
    notifications: State<'_, NotificationsState>,
    ids: Option<Vec<String>>,
    mark: NotificationMark,
) -> Result<u32, IpcError> {
    let center = notifications.get(&app)?;
    center
        .mark(ids.as_deref(), mark)
        .map_err(|e| e.log_and_convert("notification_mark"))
}
