//! Provider IPC commands (campaign Z2): cached provider status and on-demand detection.
//!
//! Detection is read-only: it runs each provider's `--version` and its documented sign-in
//! status command (never a prompt, never a login). It does not need the database, so it also
//! works when the core failed to start; the resulting `provider.*` events are then simply not
//! recorded.

use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::Duration;

use kalcode_core::events::{Correlation, EventPayload, EventSource, NewEvent};
use kalcode_core::{Core, IpcError, KalError};
use kalcode_providers::{DetectEnv, ProviderRegistry, ProviderStatus};
use tauri::State;

use crate::AppState;
use crate::provider_auth_commands::ProviderRuntimeAuthority;
use crate::thread_commands::ThreadsState;

/// Managed state: the provider registry, shared with detection's blocking worker and with the
/// thread runtime (which offers only the providers detection reports usable).
pub struct ProviderState {
    registry: Arc<ProviderRegistry>,
    initial_managed_readiness: Arc<InitialManagedReadiness>,
    watcher: InstallationWatcher,
}

/// How long runtime shutdown waits for the installation watcher to finish an in-flight step.
/// Its provider probes are guardian jobs that the guardian drain terminates, so in practice
/// only an in-progress runtime snapshot copy is waited for.
const INSTALLATION_WATCH_STOP_WAIT: Duration = Duration::from_secs(30);

/// Stop signal for one runtime generation's installation watcher.
#[derive(Default)]
struct WatchStop {
    stopped: Mutex<bool>,
    wake: Condvar,
}

impl WatchStop {
    fn stop(&self) {
        *self.stopped.lock().unwrap_or_else(PoisonError::into_inner) = true;
        self.wake.notify_all();
    }

    fn is_stopped(&self) -> bool {
        *self.stopped.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Waits up to `timeout`; returns whether the watcher must stop.
    fn wait(&self, timeout: Duration) -> bool {
        let stopped = self.stopped.lock().unwrap_or_else(PoisonError::into_inner);
        let (stopped, _) = self
            .wake
            .wait_timeout_while(stopped, timeout, |stopped| !*stopped)
            .unwrap_or_else(PoisonError::into_inner);
        *stopped
    }
}

/// The installation watcher thread holds this runtime generation's probe guardian and managed
/// profiles, which carry the guardian's desktop-epoch fence. The thread must end with its
/// generation: a watcher that outlived sign-out or restart recovery would keep the old guardian
/// epoch alive (the next generation then reports the workspace as owned) and could start
/// provider probes after their owner stopped.
struct InstallationWatcher {
    stop: Arc<WatchStop>,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl InstallationWatcher {
    /// Signals the watcher; it starts no further provider work.
    fn begin_shutdown(&self) {
        self.stop.stop();
    }

    /// Waits for the watcher to release every guardian reference. Called after the guardian
    /// drain, which terminates any probe still running. Returns whether the thread has ended.
    fn finish_shutdown(&self) -> bool {
        self.stop.stop();
        let mut slot = self.thread.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(thread) = slot.take() else {
            return true;
        };
        let deadline = std::time::Instant::now() + INSTALLATION_WATCH_STOP_WAIT;
        while !thread.is_finished() {
            if std::time::Instant::now() >= deadline {
                tracing::warn!(event = "provider.installation_watch_stop_timed_out");
                *slot = Some(thread);
                return false;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        thread.join().is_ok()
    }
}

const INITIAL_MANAGED_READINESS_WAIT: Duration = Duration::from_secs(45);

#[derive(Default)]
struct InitialManagedReadinessState {
    complete: bool,
    callbacks: Vec<Arc<dyn Fn() + Send + Sync>>,
}

/// One runtime generation's startup managed-runtime prewarm. Consumers share this completion
/// instead of starting a second capability probe or observing a temporary false-unavailable row.
pub(crate) struct InitialManagedReadiness {
    state: Mutex<InitialManagedReadinessState>,
    completed: Condvar,
}

impl InitialManagedReadiness {
    fn pending() -> Self {
        Self {
            state: Mutex::new(InitialManagedReadinessState::default()),
            completed: Condvar::new(),
        }
    }

    /// Waits only at a launchability boundary. Provider probes are independently bounded; this
    /// outer bound also prevents a worker failure from delaying shutdown indefinitely.
    pub(crate) fn wait(&self) {
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let (state, timeout) = self
            .completed
            .wait_timeout_while(state, INITIAL_MANAGED_READINESS_WAIT, |state| {
                !state.complete
            })
            .unwrap_or_else(PoisonError::into_inner);
        if timeout.timed_out() && !state.complete {
            tracing::warn!(event = "provider.initial_managed_readiness_timed_out");
        }
    }

    fn on_complete(&self, callback: Arc<dyn Fn() + Send + Sync>) {
        let run_now = {
            let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            let run_now = state.complete;
            state.callbacks.push(callback.clone());
            run_now
        };
        if run_now {
            callback();
        }
    }

    fn complete(&self) {
        let callbacks = {
            let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            if state.complete {
                return;
            }
            state.complete = true;
            state.callbacks.clone()
        };
        self.completed.notify_all();
        for callback in callbacks {
            callback();
        }
    }

    fn notify_subscribers(&self) {
        let callbacks = self
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .callbacks
            .clone();
        for callback in callbacks {
            callback();
        }
    }

    #[cfg(test)]
    pub(crate) fn test_pending() -> Self {
        Self::pending()
    }

    #[cfg(test)]
    pub(crate) fn test_complete(&self) {
        self.complete();
    }
}

struct CompleteInitialManagedReadiness(Arc<InitialManagedReadiness>);

impl Drop for CompleteInitialManagedReadiness {
    fn drop(&mut self) {
        self.0.complete();
    }
}

impl ProviderState {
    pub fn from_process(runtime: &ProviderRuntimeAuthority) -> Result<Self, &'static str> {
        let guardian = runtime
            .probe_guardian()
            .map_err(|_| "provider_guardian_unavailable")?;
        let registry = Arc::new(ProviderRegistry::installation_only_guarded(
            DetectEnv::from_process(),
            guardian.clone(),
        ));
        let (initial_managed_readiness, watcher) =
            watch_installations(&registry, guardian, runtime.managed_profiles());
        Ok(Self {
            registry,
            initial_managed_readiness,
            watcher,
        })
    }

    /// First step of runtime shutdown: the installation watcher starts no further provider work.
    pub(crate) fn begin_shutdown(&self) {
        self.watcher.begin_shutdown();
    }

    /// Last step of runtime shutdown, after the guardian drain: waits until the installation
    /// watcher has released this generation's guardian. Returns whether shutdown is clean.
    pub(crate) fn finish_shutdown(&self) -> bool {
        self.watcher.finish_shutdown()
    }

    pub fn registry(&self) -> Arc<ProviderRegistry> {
        Arc::clone(&self.registry)
    }

    pub(crate) fn initial_managed_readiness(&self) -> Arc<InitialManagedReadiness> {
        Arc::clone(&self.initial_managed_readiness)
    }

    pub(crate) fn bind_threads(&self, threads: &Arc<ThreadsState>) {
        let threads = Arc::downgrade(threads);
        self.initial_managed_readiness
            .on_complete(Arc::new(move || {
                if let Some(threads) = threads.upgrade() {
                    threads.sync_providers();
                }
            }));
    }
}

/// Each runtime generation owns its observer through a weak registry reference. Updates warm
/// new launch state only; active terminals and their immutable runtime leases are never touched.
fn watch_installations(
    registry: &Arc<ProviderRegistry>,
    guardian: kalcode_providers::guardian::ProviderProbeGuardian,
    profiles: kalcode_providers::managed::ManagedProfiles,
) -> (Arc<InitialManagedReadiness>, InstallationWatcher) {
    let initial_managed_readiness = Arc::new(InitialManagedReadiness::pending());
    let completion = Arc::clone(&initial_managed_readiness);
    let registry = Arc::downgrade(registry);
    let stop = Arc::new(WatchStop::default());
    let stopped = Arc::clone(&stop);
    let spawned = std::thread::Builder::new()
        .name("provider-installation-watch".into())
        .spawn(move || {
            let _complete_initial = CompleteInitialManagedReadiness(completion);
            let source = DetectEnv::from_process();
            let spec = kalcode_providers::catalog::codex_spec();
            let env = source.provider_env(&spec.env_policy);
            let store = profiles.runtime_store();
            let mut initial = true;
            let mut policy_revision = None;
            let mut codex_retry_pending = false;
            // Keep the current prewarm pinned so a first user launch can reuse validated bytes
            // without rehashing the distribution. Old active sessions retain their own leases.
            let mut _warm_runtime = None;
            loop {
                if stopped.is_stopped() {
                    break;
                }
                let Some(current) = registry.upgrade() else {
                    break;
                };
                let mut changes = current.changed_installations();
                let next_policy = kalcode_providers::compatibility::active_snapshot().revision();
                if needs_codex_refresh(
                    &changes,
                    next_policy != policy_revision,
                    codex_retry_pending,
                ) {
                    changes.push((
                        kalcode_contracts::agent::ProviderId::new("codex"),
                        source.resolve_executable_only(&spec),
                    ));
                }
                policy_revision = next_policy;
                let provider_status_changed = !changes.is_empty();
                for (provider, executable) in changes {
                    if stopped.is_stopped() {
                        break;
                    }
                    // Startup already has a shared detection job. Later changes refresh its
                    // cached status and health without waiting for a failed user launch.
                    if !initial {
                        current.detect_one(&provider);
                    }
                    if provider.as_str() == kalcode_contracts::agent::ProviderId::CODEX {
                        let Ok(cwd) = profiles.compatibility_probe_dir() else {
                            codex_retry_pending = true;
                            tracing::debug!(
                                event = "provider.compatibility_probe_directory_unavailable"
                            );
                            continue;
                        };
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
                                codex_retry_pending = false;
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
                                if initial {
                                    _complete_initial.0.complete();
                                }
                                // Optional observing hooks warm only after core launchability is
                                // published, with the exact selected environment and guardian.
                                // The bounded probe runs on this watcher thread, so runtime
                                // shutdown (which joins the watcher) also ends it.
                                if let Some(runtime) = _warm_runtime.as_ref() {
                                    let mut hook_env = env.clone();
                                    runtime.configure_environment(&mut hook_env);
                                    let _ = kalcode_providers::codex::hook_compatibility::probe_and_cache(
                                        runtime.executable(),
                                        &hook_env,
                                        Some(&cwd),
                                        Some(guardian.clone()),
                                        Some(runtime.version()),
                                    );
                                }
                            }
                            Err(_) => {
                                codex_retry_pending = true;
                                current.set_managed_runtime(provider.clone(), None);
                                _warm_runtime = None;
                                tracing::debug!(
                                    event = "provider.compatibility_prewarm_unavailable"
                                );
                            }
                        }
                    }
                }
                if initial {
                    _complete_initial.0.complete();
                } else if provider_status_changed {
                    _complete_initial.0.notify_subscribers();
                }
                initial = false;
                drop(current);
                // Background maintenance respects cross-process leases and the current/previous
                // recovery pointers. A finished old session releases its bytes on the next pass.
                if store.prune_unleased("codex", 2).is_err() {
                    tracing::debug!(event = "provider.runtime_maintenance_deferred");
                }
                if stopped.wait(Duration::from_secs(30)) {
                    break;
                }
            }
        });
    let thread = match spawned {
        Ok(thread) => Some(thread),
        Err(_) => {
            initial_managed_readiness.complete();
            tracing::warn!(event = "provider.installation_watch_start_failed");
            None
        }
    };
    (
        initial_managed_readiness,
        InstallationWatcher {
            stop,
            thread: Mutex::new(thread),
        },
    )
}

fn needs_codex_refresh(
    changes: &[(
        kalcode_contracts::agent::ProviderId,
        Option<std::path::PathBuf>,
    )],
    policy_changed: bool,
    retry_pending: bool,
) -> bool {
    (policy_changed || retry_pending)
        && !changes
            .iter()
            .any(|(provider, _)| provider.as_str() == kalcode_contracts::agent::ProviderId::CODEX)
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
    providers.registry.list()
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
    let registry = Arc::clone(&providers.registry);
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
    fn initial_managed_readiness_releases_waiters_and_notifies_every_refresh() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::{Barrier, mpsc};
        use std::time::Duration;

        let readiness = Arc::new(InitialManagedReadiness::pending());
        let notifications = Arc::new(AtomicUsize::new(0));
        readiness.on_complete({
            let notifications = Arc::clone(&notifications);
            Arc::new(move || {
                notifications.fetch_add(1, Ordering::SeqCst);
            })
        });

        let start = Arc::new(Barrier::new(3));
        let (finished, completions) = mpsc::channel();
        let waiters: Vec<_> = (0..2)
            .map(|_| {
                let readiness = Arc::clone(&readiness);
                let start = Arc::clone(&start);
                let finished = finished.clone();
                std::thread::spawn(move || {
                    start.wait();
                    readiness.wait();
                    finished.send(()).expect("completion receiver");
                })
            })
            .collect();
        start.wait();
        assert!(
            completions.recv_timeout(Duration::from_millis(50)).is_err(),
            "first use must wait while managed launchability is unresolved"
        );

        readiness.complete();
        for _ in 0..2 {
            completions
                .recv_timeout(Duration::from_secs(1))
                .expect("shared completion releases every waiter");
        }
        for waiter in waiters {
            waiter.join().expect("readiness waiter");
        }
        readiness.complete();
        assert_eq!(notifications.load(Ordering::SeqCst), 1);
        readiness.notify_subscribers();
        assert_eq!(
            notifications.load(Ordering::SeqCst),
            2,
            "later installation cycles must refresh bound provider consumers"
        );
    }

    #[test]
    fn unchanged_codex_installation_retries_after_a_transient_prewarm_failure() {
        assert!(needs_codex_refresh(&[], false, true));
        assert!(!needs_codex_refresh(&[], false, false));
        assert!(!needs_codex_refresh(
            &[(
                kalcode_contracts::agent::ProviderId::new(
                    kalcode_contracts::agent::ProviderId::CODEX,
                ),
                None,
            )],
            false,
            true,
        ));
    }

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
