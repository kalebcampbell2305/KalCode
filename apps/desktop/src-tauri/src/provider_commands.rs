//! Provider IPC commands (campaign Z2): cached provider status and on-demand detection.
//!
//! Detection is read-only: it runs each provider's `--version` and its documented sign-in
//! status command (never a prompt, never a login). It does not need the database, so it also
//! works when the core failed to start; the resulting `provider.*` events are then simply not
//! recorded.

use std::sync::Arc;

use kalcode_core::events::{Correlation, EventPayload, EventSource, NewEvent};
use kalcode_core::{Core, IpcError, KalError};
use kalcode_providers::{DetectEnv, ProviderRegistry, ProviderStatus};
use tauri::State;

use crate::AppState;
use crate::provider_auth_commands::ProviderRuntimeAuthority;
use crate::thread_commands::ThreadsState;

/// Managed state: the provider registry, shared with detection's blocking worker and with the
/// thread runtime (which offers only the providers detection reports usable).
pub struct ProviderState(Arc<ProviderRegistry>);

impl ProviderState {
    pub fn from_process(runtime: &ProviderRuntimeAuthority) -> Result<Self, &'static str> {
        let guardian = runtime
            .probe_guardian()
            .map_err(|_| "provider_guardian_unavailable")?;
        Ok(Self(Arc::new(ProviderRegistry::installation_only_guarded(
            DetectEnv::from_process(),
            guardian,
        ))))
    }

    pub fn registry(&self) -> Arc<ProviderRegistry> {
        Arc::clone(&self.0)
    }
}

/// Runs detection (blocking) and records the resulting `provider.*` events when the core is
/// available. Shared by `providers_detect` and the thread runtime's first use.
pub fn detect_and_record(
    core: Option<&Arc<Core>>,
    registry: &ProviderRegistry,
) -> Vec<ProviderStatus> {
    let (statuses, events) = registry.detect_all();
    record(core, events);
    statuses
}

/// The cached status of every provider (`detection` is null until the first check).
#[tauri::command(async)]
pub fn providers_list(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    providers: crate::runtime_coordinator::RuntimeState<ProviderState>,
) -> Vec<ProviderStatus> {
    providers.0.list()
}

/// Detects every provider off the main thread, records what changed, and returns the statuses.
#[tauri::command]
pub async fn providers_detect(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    providers: crate::runtime_coordinator::RuntimeState<ProviderState>,
    threads: crate::runtime_coordinator::RuntimeState<ThreadsState>,
) -> Result<Vec<ProviderStatus>, IpcError> {
    _runtime_access.revalidate()?;
    let registry = Arc::clone(&providers.0);
    let (statuses, events) = tauri::async_runtime::spawn_blocking(move || {
        _runtime_access.revalidate()?;
        Ok::<_, IpcError>(registry.detect_all())
    })
    .await
    .map_err(|e| {
        KalError::internal(
            "detection_interrupted",
            "Checking providers was interrupted.",
        )
        .with_source(e)
        .log_and_convert("providers_detect")
    })??;
    threads.revalidate()?;
    record(state.core.as_ref(), events);
    // Threads offer exactly the providers this detection found usable.
    threads.sync_providers();
    Ok(statuses)
}

fn record(core: Option<&Arc<Core>>, events: Vec<EventPayload>) {
    match core {
        Some(core) => {
            for event in events {
                let provider_id = provider_of(&event);
                let recorded = core.emit(NewEvent {
                    source: EventSource::Core,
                    correlation: Correlation {
                        provider_id,
                        ..Correlation::default()
                    },
                    event,
                });
                if let Err(error) = recorded {
                    // Detection still succeeded; only the history entry is missing.
                    tracing::warn!(
                        event = "provider.event_not_recorded",
                        error_code = error.code,
                        error = %error.diagnostic()
                    );
                }
            }
        }
        None if !events.is_empty() => {
            tracing::warn!(
                event = "provider.events_skipped",
                reason = "core_unavailable",
                count = events.len()
            );
        }
        None => {}
    }
}

fn provider_of(event: &EventPayload) -> Option<String> {
    match event {
        EventPayload::ProviderDetected { provider_id, .. }
        | EventPayload::ProviderError { provider_id, .. } => Some(provider_id.as_str().to_owned()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_events_are_correlated_with_their_provider() {
        let detected: EventPayload = serde_json::from_value(serde_json::json!({
            "type": "provider.detected",
            "payload": { "providerId": "codex", "installed": true, "version": "0.155.1" }
        }))
        .expect("provider.detected");
        assert_eq!(provider_of(&detected).as_deref(), Some("codex"));

        let other: EventPayload = serde_json::from_value(serde_json::json!({
            "type": "settings.changed",
            "payload": { "keys": ["appearance.theme"] }
        }))
        .expect("settings.changed");
        assert_eq!(provider_of(&other), None);
    }
}
