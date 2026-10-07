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
        let registry = Arc::new(ProviderRegistry::installation_only_guarded(
            DetectEnv::from_process(),
            guardian.clone(),
        ));
        watch_installations(&registry, guardian, runtime.managed_profiles());
        Ok(Self(registry))
    }

    pub fn registry(&self) -> Arc<ProviderRegistry> {
        Arc::clone(&self.0)
    }
}

/// Each runtime generation owns its observer through a weak registry reference. Updates warm
/// new launch state only; active terminals and their immutable runtime leases are never touched.
fn watch_installations(
    registry: &Arc<ProviderRegistry>,
    guardian: kalcode_providers::guardian::ProviderProbeGuardian,
    profiles: kalcode_providers::managed::ManagedProfiles,
) {
    let registry = Arc::downgrade(registry);
    let _ = std::thread::Builder::new()
        .name("provider-installation-watch".into())
        .spawn(move || {
            let source = DetectEnv::from_process();
            let spec = kalcode_providers::catalog::codex_spec();
            let env = source.provider_env(&spec.env_policy);
            let store = profiles.runtime_store();
            let mut initial = true;
            let mut policy_revision = None;
            // Keep the current prewarm pinned so a first user launch can reuse validated bytes
            // without rehashing the distribution. Old active sessions retain their own leases.
            let mut _warm_runtime = None;
            loop {
                let Some(current) = registry.upgrade() else {
                    break;
                };
                let mut changes = current.changed_installations();
                let next_policy = kalcode_providers::compatibility::active_snapshot().revision();
                if next_policy != policy_revision
                    && !changes.iter().any(|(id, _)| id.as_str() == "codex")
                {
                    changes.push((
                        kalcode_contracts::agent::ProviderId::new("codex"),
                        source.resolve_executable_only(&spec),
                    ));
                }
                policy_revision = next_policy;
                for (provider, executable) in changes {
                    // Startup already has a shared detection job. Later changes refresh its
                    // cached status and health without waiting for a failed user launch.
                    if !initial {
                        current.detect_one(&provider);
                    }
                    if provider.as_str() == kalcode_contracts::agent::ProviderId::CODEX
                        && let Ok(cwd) = profiles.compatibility_probe_dir()
                    {
                        let warmed = kalcode_providers::codex::runtime::prewarm_managed_runtime(
                            executable.as_deref(),
                            &env,
                            &cwd,
                            &store,
                            |label| {
                                guardian.prepare_job(label).map_err(|_| {
                                    kalcode_contracts::agent::ProviderError::Start(
                                        "Provider compatibility check could not start".into(),
                                    )
                                })
                            },
                            None,
                        );
                        match warmed {
                            Ok(runtime) => {
                                use kalcode_providers::codex::runtime::ManagedRuntimeSource;
                                let source = match runtime.source() {
                                    ManagedRuntimeSource::ValidatedSnapshot => "validated_snapshot",
                                    ManagedRuntimeSource::LastKnownGood => "last_known_good",
                                    ManagedRuntimeSource::InstalledDirect => "installed_direct",
                                };
                                let readiness = kalcode_providers::model::ManagedRuntimeReadiness {
                                    version: runtime.version().to_string(),
                                    source: source.into(),
                                };
                                _warm_runtime = Some(runtime);
                                current.set_managed_runtime(provider.clone(), Some(readiness));
                            }
                            Err(_) => {
                                current.set_managed_runtime(provider.clone(), None);
                                _warm_runtime = None;
                                tracing::debug!(
                                    event = "provider.compatibility_prewarm_unavailable"
                                );
                            }
                        }
                    }
                }
                initial = false;
                drop(current);
                // Background maintenance respects cross-process leases and the current/previous
                // recovery pointers. A finished old session releases its bytes on the next pass.
                if store.prune_unleased("codex", 2).is_err() {
                    tracing::debug!(event = "provider.runtime_maintenance_deferred");
                }
                std::thread::sleep(std::time::Duration::from_secs(30));
            }
        });
}

/// Makes sure a detection exists (blocking) and records the resulting `provider.*` events when
/// the core is available. For the thread runtime's first use (a session launch): returns at
/// once when a check completed, waits for a running one (the startup check) instead of queueing
/// another full check behind it, and checks only when none ever ran.
pub fn detect_once_and_record(
    core: Option<&Arc<Core>>,
    registry: &ProviderRegistry,
) -> Vec<ProviderStatus> {
    let (statuses, events) = registry.detect_all_once();
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
