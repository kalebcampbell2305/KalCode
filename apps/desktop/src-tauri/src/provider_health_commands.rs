//! Provider Health IPC (PH, PROVIDERS-2): `provider_health_list`, `provider_health_get`,
//! `provider_health_trend`.
//!
//! One [`HealthMonitor`] for the app, fed by detection (the shared provider registry) and by
//! every thread session (adapters are wrapped in `ObservedProvider` when they're registered).
//! Its driver thread records `provider.health_changed` / `provider.capacity_changed` on
//! transitions and asks for a read-only re-detection when a session couldn't start. If the
//! monitor is missing, the commands answer "unknown" for every provider and threads are
//! unaffected (PH-06).

use std::sync::{Arc, OnceLock, Weak};

use kalcode_contracts::agent::ProviderId;
use kalcode_contracts::events::EventPayload;
use kalcode_contracts::health::{HealthRollup, ProviderHealth};
use kalcode_core::events::{Correlation, EventSource, NewEvent};
use kalcode_core::{Core, IpcError, KalError};
use kalcode_providers::ProviderRegistry;
use kalcode_providers::health::{HealthListener, HealthMonitor, ROLLUP_HOURS};
use tauri::{AppHandle, Manager, State};

use crate::thread_commands::ThreadsState;

/// The app's monitor, once started. Read by `thread_commands::adapter` when it registers an
/// adapter, so every session is observed.
static MONITOR: OnceLock<Arc<HealthMonitor>> = OnceLock::new();

pub fn monitor() -> Option<&'static Arc<HealthMonitor>> {
    MONITOR.get()
}

struct Listener {
    core: Option<Arc<Core>>,
    registry: Weak<ProviderRegistry>,
    app: OnceLock<AppHandle>,
}

impl Listener {
    fn record(&self, event: EventPayload) {
        let Some(core) = &self.core else {
            return;
        };
        let provider_id = match &event {
            EventPayload::ProviderHealthChanged { provider_id, .. }
            | EventPayload::ProviderCapacityChanged { provider_id, .. }
            | EventPayload::ProviderDetected { provider_id, .. }
            | EventPayload::ProviderError { provider_id, .. } => {
                Some(provider_id.as_str().to_owned())
            }
            _ => None,
        };
        if let Err(error) = core.emit(NewEvent {
            source: EventSource::Core,
            correlation: Correlation {
                provider_id,
                ..Correlation::default()
            },
            event,
        }) {
            tracing::warn!(event = "provider.health_event_not_recorded", error_code = error.code, error = %error.diagnostic());
        }
    }
}

impl HealthListener for Listener {
    fn transition(&self, event: EventPayload) {
        self.record(event);
    }

    fn recheck(&self, provider: &ProviderId) {
        let Some(registry) = self.registry.upgrade() else {
            return;
        };
        let provider = provider.clone();
        let core = self.core.clone();
        let app = self.app.get().cloned();
        // Detection runs `--version` and the documented status command: off this thread.
        let spawned = std::thread::Builder::new()
            .name("kalcode-provider-recheck".into())
            .spawn(move || {
                tracing::info!(
                    event = "provider.health_recheck",
                    provider_id = provider.as_str()
                );
                let events = registry.detect_one(&provider);
                let listener = Listener {
                    core,
                    registry: Weak::new(),
                    app: OnceLock::new(),
                };
                for event in events {
                    listener.record(event);
                }
                if let Some(threads) = app.as_ref().and_then(|a| a.try_state::<ThreadsState>()) {
                    threads.sync_providers();
                }
            });
        if let Err(error) = spawned {
            tracing::warn!(event = "provider.health_recheck_failed", error = %error);
        }
    }
}

/// Managed state. `monitor` is `None` only if the health subsystem couldn't start.
pub struct ProviderHealthState {
    monitor: Option<Arc<HealthMonitor>>,
    listener: Option<Arc<Listener>>,
}

impl ProviderHealthState {
    /// Starts the monitor over the shared detection registry, before the thread runtime
    /// registers its adapters.
    pub fn start(core: Option<Arc<Core>>, registry: &Arc<ProviderRegistry>) -> Self {
        let monitor = Arc::new(HealthMonitor::new());
        let listener = Arc::new(Listener {
            core,
            registry: Arc::downgrade(registry),
            app: OnceLock::new(),
        });
        monitor.set_listener(listener.clone());
        registry.set_health(monitor.clone());
        if let Err(error) = monitor.spawn_driver() {
            // Snapshots still work on request; only transition events and re-checks stop.
            tracing::error!(event = "provider.health_driver_failed", error = %error);
        }
        let _ = MONITOR.set(monitor.clone());
        tracing::info!(event = "provider.health_started");
        Self {
            monitor: Some(monitor),
            listener: Some(listener),
        }
    }

    /// Lets re-checks refresh the thread runtime's providers.
    pub fn bind(&self, app: &AppHandle) {
        if let Some(listener) = &self.listener {
            let _ = listener.app.set(app.clone());
        }
    }

    pub fn shutdown(&self) {
        if let Some(monitor) = &self.monitor {
            monitor.shutdown();
        }
    }

    fn list(&self) -> Vec<ProviderHealth> {
        match &self.monitor {
            Some(monitor) => monitor.list(),
            None => HealthMonitor::unavailable(),
        }
    }
}

fn validate_provider(provider_id: &str) -> Result<ProviderId, IpcError> {
    let known = [
        ProviderId::CLAUDE_CODE,
        ProviderId::CODEX,
        ProviderId::GEMINI_CLI,
    ];
    if known.contains(&provider_id) {
        Ok(ProviderId::new(provider_id))
    } else {
        Err(
            KalError::validation("unknown_provider", "KalCode doesn't know that provider.")
                .to_ipc(),
        )
    }
}

/// Every provider's health. Cheap: an in-memory snapshot, no provider process is started.
#[tauri::command(async)]
pub fn provider_health_list(health: State<'_, ProviderHealthState>) -> Vec<ProviderHealth> {
    health.list()
}

#[tauri::command(async)]
pub fn provider_health_get(
    health: State<'_, ProviderHealthState>,
    provider_id: String,
) -> Result<ProviderHealth, IpcError> {
    let id = validate_provider(&provider_id)?;
    health
        .list()
        .into_iter()
        .find(|h| h.provider_id == id)
        .ok_or_else(|| {
            KalError::validation("unknown_provider", "KalCode doesn't know that provider.").to_ipc()
        })
}

/// Hourly rollups for the last `hours` hours (at most 720, 30 days).
#[tauri::command(async)]
pub fn provider_health_trend(
    health: State<'_, ProviderHealthState>,
    provider_id: String,
    hours: u32,
) -> Result<Vec<HealthRollup>, IpcError> {
    let id = validate_provider(&provider_id)?;
    if hours == 0 || hours as usize > ROLLUP_HOURS {
        return Err(
            KalError::validation("invalid_hours", "Choose between 1 and 720 hours.").to_ipc(),
        );
    }
    Ok(health
        .monitor
        .as_ref()
        .map(|m| m.trend(&id, hours))
        .unwrap_or_default())
}
