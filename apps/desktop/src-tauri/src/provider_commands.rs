//! Provider IPC commands (campaign Z2): cached provider status and on-demand detection.
//!
//! Detection is read-only: it runs each provider's `--version` and its documented sign-in
//! status command (never a prompt, never a login). It does not need the database, so it also
//! works when the core failed to start; the resulting `provider.*` events are then simply not
//! recorded.

use std::sync::Arc;

use kalcode_core::events::{Correlation, EventPayload, EventSource, NewEvent};
use kalcode_core::{IpcError, KalError};
use kalcode_providers::{DetectEnv, ProviderRegistry, ProviderStatus};
use tauri::State;

use crate::AppState;

/// Managed state: the provider registry, shared with detection's blocking worker.
pub struct ProviderState(Arc<ProviderRegistry>);

impl ProviderState {
    pub fn from_process() -> Self {
        Self(Arc::new(ProviderRegistry::new(DetectEnv::from_process())))
    }

    /// The shared registry (KalVoice picks its reasoning provider from the same cache).
    pub fn registry(&self) -> Arc<ProviderRegistry> {
        Arc::clone(&self.0)
    }
}

/// The cached status of every provider (`detection` is null until the first check).
#[tauri::command(async)]
pub fn providers_list(providers: State<'_, ProviderState>) -> Vec<ProviderStatus> {
    providers.0.list()
}

/// Detects every provider off the main thread, records what changed, and returns the statuses.
#[tauri::command]
pub async fn providers_detect(
    state: State<'_, AppState>,
    providers: State<'_, ProviderState>,
) -> Result<Vec<ProviderStatus>, IpcError> {
    let registry = Arc::clone(&providers.0);
    let (statuses, events) = tauri::async_runtime::spawn_blocking(move || registry.detect_all())
        .await
        .map_err(|e| {
            KalError::internal(
                "detection_interrupted",
                "Checking providers was interrupted.",
            )
            .with_source(e)
            .log_and_convert("providers_detect")
        })?;

    match &state.core {
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
    Ok(statuses)
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
