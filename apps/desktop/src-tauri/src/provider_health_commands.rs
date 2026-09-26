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
use tauri::AppHandle;

use crate::{provider_commands::ProviderState, thread_commands::ThreadsState};

/// Identity shared by one monitor and its registry. A detached callback must match both objects
/// in the currently leased runtime before it can detect, emit, or synchronize anything.
#[derive(Clone)]
struct HealthEpoch {
    monitor: Weak<HealthMonitor>,
    registry: Weak<ProviderRegistry>,
}

impl HealthEpoch {
    fn new(monitor: &Arc<HealthMonitor>, registry: &Arc<ProviderRegistry>) -> Self {
        Self {
            monitor: Arc::downgrade(monitor),
            registry: Arc::downgrade(registry),
        }
    }

    fn is_current(
        &self,
        current: &Self,
        current_monitor: &Arc<HealthMonitor>,
        current_registry: &Arc<ProviderRegistry>,
        revalidate: impl FnOnce() -> bool,
    ) -> bool {
        let Some(expected_monitor) = self.monitor.upgrade() else {
            return false;
        };
        let Some(expected_registry) = self.registry.upgrade() else {
            return false;
        };
        let Some(runtime_monitor) = current.monitor.upgrade() else {
            return false;
        };
        let Some(runtime_registry) = current.registry.upgrade() else {
            return false;
        };
        Arc::ptr_eq(&expected_monitor, current_monitor)
            && Arc::ptr_eq(&expected_registry, current_registry)
            && Arc::ptr_eq(&runtime_monitor, current_monitor)
            && Arc::ptr_eq(&runtime_registry, current_registry)
            && revalidate()
    }

    fn run_if_current<T>(
        &self,
        current: &Self,
        current_monitor: &Arc<HealthMonitor>,
        current_registry: &Arc<ProviderRegistry>,
        revalidate: impl FnOnce() -> bool,
        effect: impl FnOnce() -> T,
    ) -> Option<T> {
        self.is_current(current, current_monitor, current_registry, revalidate)
            .then(effect)
    }
}

struct Listener {
    core: Option<Arc<Core>>,
    registry: Weak<ProviderRegistry>,
    epoch: HealthEpoch,
    app: OnceLock<AppHandle>,
}

fn record_event(core: Option<&Arc<Core>>, event: EventPayload) {
    let Some(core) = core else {
        return;
    };
    let provider_id = match &event {
        EventPayload::ProviderHealthChanged { provider_id, .. }
        | EventPayload::ProviderCapacityChanged { provider_id, .. }
        | EventPayload::ProviderDetected { provider_id, .. }
        | EventPayload::ProviderError { provider_id, .. } => Some(provider_id.as_str().to_owned()),
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

impl Listener {
    fn record(&self, event: EventPayload) {
        record_event(self.core.as_ref(), event);
    }
}

impl HealthListener for Listener {
    fn transition(&self, event: EventPayload) {
        let Some(app) = self.app.get() else {
            return;
        };
        let Ok(health) =
            crate::runtime_coordinator::RuntimeState::<ProviderHealthState>::from_app(app)
        else {
            return;
        };
        let Ok(providers) =
            crate::runtime_coordinator::RuntimeState::<ProviderState>::from_app(app)
        else {
            return;
        };
        let Some(current_monitor) = health.monitor() else {
            return;
        };
        let current_registry = providers.registry();
        let _ = self.epoch.run_if_current(
            &health.epoch,
            &current_monitor,
            &current_registry,
            || health.revalidate().is_ok() && providers.revalidate().is_ok(),
            || self.record(event),
        );
    }

    fn recheck(&self, provider: &ProviderId) {
        let Some(registry) = self.registry.upgrade() else {
            return;
        };
        let provider = provider.clone();
        let core = self.core.clone();
        let app = self.app.get().cloned();
        let epoch = self.epoch.clone();
        // Detection runs `--version` and the documented status command: off this thread.
        let spawned = std::thread::Builder::new()
            .name("kalcode-provider-recheck".into())
            .spawn(move || {
                let Some(app) = app else {
                    return;
                };
                let Ok(health) =
                    crate::runtime_coordinator::RuntimeState::<ProviderHealthState>::from_app(&app)
                else {
                    return;
                };
                let Ok(providers) =
                    crate::runtime_coordinator::RuntimeState::<ProviderState>::from_app(&app)
                else {
                    return;
                };
                let Ok(threads) =
                    crate::runtime_coordinator::RuntimeState::<ThreadsState>::from_app(&app)
                else {
                    return;
                };
                let Some(current_monitor) = health.monitor() else {
                    return;
                };
                let current_registry = providers.registry();
                let valid = || {
                    health.revalidate().is_ok()
                        && providers.revalidate().is_ok()
                        && threads.revalidate().is_ok()
                };
                if !epoch.is_current(&health.epoch, &current_monitor, &current_registry, valid) {
                    return;
                }
                tracing::info!(
                    event = "provider.health_recheck",
                    provider_id = provider.as_str()
                );
                let events = registry.detect_one(&provider);
                for event in events {
                    if epoch
                        .run_if_current(
                            &health.epoch,
                            &current_monitor,
                            &current_registry,
                            valid,
                            || record_event(core.as_ref(), event),
                        )
                        .is_none()
                    {
                        return;
                    }
                }
                let _ = epoch.run_if_current(
                    &health.epoch,
                    &current_monitor,
                    &current_registry,
                    valid,
                    || threads.sync_providers(),
                );
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
    epoch: HealthEpoch,
}

impl ProviderHealthState {
    pub fn monitor(&self) -> Option<Arc<HealthMonitor>> {
        self.monitor.clone()
    }

    /// Starts the monitor over the shared detection registry, before the thread runtime
    /// registers its adapters.
    pub fn start(core: Option<Arc<Core>>, registry: &Arc<ProviderRegistry>) -> Self {
        let monitor = Arc::new(HealthMonitor::new());
        let epoch = HealthEpoch::new(&monitor, registry);
        let listener = Arc::new(Listener {
            core,
            registry: Arc::downgrade(registry),
            epoch: epoch.clone(),
            app: OnceLock::new(),
        });
        monitor.set_listener(listener.clone());
        registry.set_health(monitor.clone());
        if let Err(error) = monitor.spawn_driver() {
            // Snapshots still work on request; only transition events and re-checks stop.
            tracing::error!(event = "provider.health_driver_failed", error = %error);
        }
        tracing::info!(event = "provider.health_started");
        Self {
            monitor: Some(monitor),
            listener: Some(listener),
            epoch,
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
pub fn provider_health_list(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    health: crate::runtime_coordinator::RuntimeState<ProviderHealthState>,
) -> Vec<ProviderHealth> {
    health.list()
}

#[tauri::command(async)]
pub fn provider_health_get(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    health: crate::runtime_coordinator::RuntimeState<ProviderHealthState>,
    provider_id: String,
) -> Result<ProviderHealth, IpcError> {
    _runtime_access.revalidate()?;
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
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    health: crate::runtime_coordinator::RuntimeState<ProviderHealthState>,
    provider_id: String,
    hours: u32,
) -> Result<Vec<HealthRollup>, IpcError> {
    _runtime_access.revalidate()?;
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

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    #[test]
    fn stale_epoch_cannot_emit_or_sync_against_a_replacement_registry() {
        let old_registry = Arc::new(ProviderRegistry::new(
            kalcode_providers::DetectEnv::default(),
        ));
        let replacement_registry = Arc::new(ProviderRegistry::new(
            kalcode_providers::DetectEnv::default(),
        ));
        let old_monitor = Arc::new(HealthMonitor::new());
        let replacement_monitor = Arc::new(HealthMonitor::new());
        let old = HealthEpoch::new(&old_monitor, &old_registry);
        let replacement = HealthEpoch::new(&replacement_monitor, &replacement_registry);
        let effects = AtomicUsize::new(0);

        assert_eq!(
            old.run_if_current(
                &replacement,
                &replacement_monitor,
                &replacement_registry,
                || true,
                || effects.fetch_add(1, Ordering::SeqCst),
            ),
            None
        );
        assert_eq!(
            old.run_if_current(
                &old,
                &replacement_monitor,
                &old_registry,
                || true,
                || effects.fetch_add(1, Ordering::SeqCst),
            ),
            None
        );
        assert_eq!(
            old.run_if_current(
                &old,
                &old_monitor,
                &replacement_registry,
                || true,
                || effects.fetch_add(1, Ordering::SeqCst),
            ),
            None
        );
        assert_eq!(
            old.run_if_current(
                &old,
                &old_monitor,
                &old_registry,
                || false,
                || effects.fetch_add(1, Ordering::SeqCst),
            ),
            None
        );
        assert_eq!(effects.load(Ordering::SeqCst), 0);

        assert_eq!(
            old.run_if_current(
                &old,
                &old_monitor,
                &old_registry,
                || true,
                || effects.fetch_add(1, Ordering::SeqCst),
            ),
            Some(0)
        );
        assert_eq!(effects.load(Ordering::SeqCst), 1);
    }
}
