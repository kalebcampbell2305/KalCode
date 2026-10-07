//! Cached provider detection for the desktop shell.
//!
//! Each provider is detected on its own thread; a provider that hangs, crashes or misbehaves
//! only affects its own row. Results are cached until the next detection, and the events worth
//! recording (`provider.detected` on a change, `provider.error` on failure) are returned so the
//! caller can persist them.
//!
//! Full checks are single-flight: one runs at a time, requests that arrive while one runs share
//! one follow-up check instead of queueing a check each, and callers that only need *a*
//! completed check (a session launch before the first check finished) wait for the running one
//! instead of starting another.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock, PoisonError};
use std::thread;

use kalcode_contracts::agent::{AuthState, DetectionState, ProviderDetection, ProviderId};
use kalcode_contracts::events::EventPayload;
use kalcode_core::time::now_rfc3339;

use crate::catalog;
use crate::detect::{DetectEnv, Detected, DetectionSpec, detect, detect_guarded};
use crate::guardian::ProviderProbeGuardian;
use crate::health::HealthMonitor;
use crate::model::ProviderStatus;

pub struct ProviderRegistry {
    env: DetectEnv,
    specs: Vec<DetectionSpec>,
    statuses: Mutex<Vec<ProviderStatus>>,
    /// Serializes detections so two "Check again" clicks never probe the same CLI in parallel.
    detecting: Mutex<()>,
    /// Single-flight coordination of full checks ([`Self::detect_all`]).
    checks: Mutex<Checks>,
    check_finished: Condvar,
    probe_guardian: Option<ProviderProbeGuardian>,
    /// Provider Health, told about every detection (PH). Optional: detection works without it.
    health: OnceLock<Arc<HealthMonitor>>,
    installations:
        Mutex<HashMap<&'static str, Option<crate::managed_runtime::InstallationFingerprint>>>,
    managed_runtimes: Mutex<HashMap<ProviderId, crate::model::ManagedRuntimeReadiness>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Full checks started and completed (generation numbers), and whether one is running.
#[derive(Default)]
struct Checks {
    running: bool,
    started: u64,
    completed: u64,
}

/// Marks the running full check finished, even if it unwinds, and wakes the callers sharing it.
struct RunningCheck<'a> {
    registry: &'a ProviderRegistry,
    generation: u64,
}

impl Drop for RunningCheck<'_> {
    fn drop(&mut self) {
        let mut checks = lock(&self.registry.checks);
        checks.running = false;
        checks.completed = checks.completed.max(self.generation);
        drop(checks);
        self.registry.check_finished.notify_all();
    }
}

impl ProviderRegistry {
    /// Unmanaged compatibility constructor retained for isolated library tests. Desktop/runtime
    /// factories must use [`Self::new_guarded`].
    pub fn new(env: DetectEnv) -> Self {
        Self::with_specs(env, catalog::specs())
    }

    pub fn new_guarded(env: DetectEnv, probe_guardian: ProviderProbeGuardian) -> Self {
        Self::with_specs_guarded(env, catalog::specs(), probe_guardian)
    }

    /// Machine-level discovery is installation-only. Authentication belongs to a selected
    /// managed account, never to whichever account the standalone CLI happens to use.
    /// Unmanaged compatibility constructor retained for isolated library tests. Desktop/runtime
    /// factories must use [`Self::installation_only_guarded`].
    pub fn installation_only(mut env: DetectEnv) -> Self {
        env.vars = env
            .provider_env(&crate::env::EnvPolicy::BASE)
            .into_iter()
            .collect();
        let mut specs = catalog::specs();
        for spec in &mut specs {
            spec.auth = None;
        }
        Self::with_specs(env, specs)
    }

    pub fn installation_only_guarded(
        mut env: DetectEnv,
        probe_guardian: ProviderProbeGuardian,
    ) -> Self {
        env.vars = env
            .provider_env(&crate::env::EnvPolicy::BASE)
            .into_iter()
            .collect();
        let mut specs = catalog::specs();
        for spec in &mut specs {
            spec.auth = None;
        }
        Self::with_specs_guarded(env, specs, probe_guardian)
    }

    /// For tests: a registry over custom detection specs (ids must match catalog entries).
    pub fn with_specs(env: DetectEnv, specs: Vec<DetectionSpec>) -> Self {
        Self {
            env,
            specs,
            statuses: Mutex::new(catalog::statuses()),
            detecting: Mutex::new(()),
            checks: Mutex::new(Checks::default()),
            check_finished: Condvar::new(),
            probe_guardian: None,
            health: OnceLock::new(),
            installations: Mutex::new(HashMap::new()),
            managed_runtimes: Mutex::new(HashMap::new()),
        }
    }

    fn with_specs_guarded(
        env: DetectEnv,
        specs: Vec<DetectionSpec>,
        probe_guardian: ProviderProbeGuardian,
    ) -> Self {
        let mut registry = Self::with_specs(env, specs);
        registry.probe_guardian = Some(probe_guardian);
        registry
    }

    /// An explicit check: the next session launch of this executable probes again too.
    /// (Path lookups only; no process.)
    fn forget_launch_detection(&self, spec: &DetectionSpec) {
        if let Some(executable) = self.env.resolve_executable_only(spec) {
            crate::launch_probe::forget_executable(&executable);
        }
    }

    fn detect(&self, spec: &DetectionSpec) -> Detected {
        match &self.probe_guardian {
            Some(guardian) => detect_guarded(spec, &self.env, guardian),
            None => detect(spec, &self.env),
        }
    }

    /// Sends every later detection to Provider Health (and the cached one now).
    pub fn set_health(&self, monitor: Arc<HealthMonitor>) {
        monitor.detected(&self.list());
        let _ = self.health.set(monitor);
    }

    /// Detects one provider again (Provider Health's re-check after a failed start). Returns
    /// the events to record, like [`Self::detect_all`].
    pub fn detect_one(&self, id: &ProviderId) -> Vec<EventPayload> {
        let Some(spec) = self.specs.iter().find(|s| s.provider_id == id.as_str()) else {
            return Vec::new();
        };
        self.forget_launch_detection(spec);
        let _serialized = lock(&self.detecting);
        let detected = self.detect(spec);
        let mut statuses = lock(&self.statuses);
        let Some(status) = statuses.iter_mut().find(|s| &s.id == id) else {
            return Vec::new();
        };
        let events = changes(status.detection.as_ref(), &detected);
        status.detection = Some(detected.detection);
        status.detection_error_code = detected.error_code.map(str::to_owned);
        drop(statuses);
        let snapshot = self.list();
        if let Some(health) = self.health.get() {
            health.detected(&snapshot);
        }
        events
    }

    /// The cached statuses (detection is `None` for providers not checked yet).
    pub fn list(&self) -> Vec<ProviderStatus> {
        let mut statuses = lock(&self.statuses).clone();
        let managed = lock(&self.managed_runtimes);
        for status in &mut statuses {
            status.managed_runtime = managed.get(&status.id).cloned();
        }
        statuses
    }

    /// Published only after the adapter actually probes the selected runtime. The caller keeps
    /// its immutable runtime lease alive until this readiness is replaced or cleared.
    pub fn set_managed_runtime(
        &self,
        id: ProviderId,
        readiness: Option<crate::model::ManagedRuntimeReadiness>,
    ) {
        let mut managed = lock(&self.managed_runtimes);
        if let Some(readiness) = readiness {
            managed.insert(id, readiness);
        } else {
            managed.remove(&id);
        }
        drop(managed);
        if let Some(health) = self.health.get() {
            health.detected(&self.list());
        }
    }

    /// Metadata-only update observation. It never signals or restarts a provider process.
    /// The first observation includes missing installations so adapters can recover an owned runtime.
    pub fn changed_installations(&self) -> Vec<(ProviderId, Option<PathBuf>)> {
        let mut previous = lock(&self.installations);
        let mut changed = Vec::new();
        for spec in &self.specs {
            let executable = self.env.resolve_executable_only(spec);
            let fingerprint = executable.as_deref().and_then(|path| {
                crate::managed_runtime::installation_fingerprint(
                    path,
                    &self.env.provider_env(&spec.env_policy),
                )
            });
            let is_changed = match previous.get(spec.provider_id) {
                Some(old) => old != &fingerprint,
                None => true,
            };
            previous.insert(spec.provider_id, fingerprint);
            if is_changed {
                changed.push((ProviderId::new(spec.provider_id), executable));
            }
        }
        changed
    }

    /// Providers with an installed CLI or a separately validated managed runtime. Managed-account
    /// authentication remains authoritative at session launch. Callers that let the user
    /// pick a provider (threads, KalVoice) choose from this list. Uses the cached detection.
    pub fn usable(&self) -> Vec<ProviderId> {
        self.list()
            .iter()
            .filter(|s| s.adapter == crate::model::AdapterState::Implemented)
            .filter(|s| {
                s.managed_runtime.is_some()
                    || s.detection.as_ref().is_some_and(|d| {
                        d.state == DetectionState::Installed
                            && d.auth != AuthState::NotAuthenticated
                    })
            })
            .map(|s| s.id.clone())
            .collect()
    }

    /// Detects every provider in parallel, updates the cache, and returns the new statuses with
    /// the events to record.
    ///
    /// The result always comes from a check that started after this call. When a check is
    /// already running, this call shares the single follow-up check with every other call that
    /// arrived meanwhile (only the caller that ran it gets the events; the others get none, as
    /// a repeated check reports no change).
    pub fn detect_all(&self) -> (Vec<ProviderStatus>, Vec<EventPayload>) {
        let mut checks = lock(&self.checks);
        let needed = checks.started + 1;
        loop {
            if checks.completed >= needed {
                return (self.list(), Vec::new());
            }
            if !checks.running {
                break;
            }
            checks = self.wait_for_check(checks);
        }
        self.run_check(checks)
    }

    /// Makes sure one full check has completed: returns the cached statuses at once when one
    /// has, waits for a running one rather than starting another, and runs one only when none
    /// ever ran. For callers that only need a detection to exist (a session launch, KalVoice's
    /// first use) so they never queue behind or repeat the startup check.
    pub fn detect_all_once(&self) -> (Vec<ProviderStatus>, Vec<EventPayload>) {
        let mut checks = lock(&self.checks);
        loop {
            if checks.completed > 0 {
                return (self.list(), Vec::new());
            }
            if !checks.running {
                break;
            }
            checks = self.wait_for_check(checks);
        }
        self.run_check(checks)
    }

    /// Full checks this registry ran (tests and diagnostics).
    pub fn checks_run(&self) -> u64 {
        lock(&self.checks).started
    }

    fn wait_for_check<'a>(&self, checks: MutexGuard<'a, Checks>) -> MutexGuard<'a, Checks> {
        self.check_finished
            .wait(checks)
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn run_check(
        &self,
        mut checks: MutexGuard<'_, Checks>,
    ) -> (Vec<ProviderStatus>, Vec<EventPayload>) {
        checks.running = true;
        checks.started += 1;
        let _running = RunningCheck {
            registry: self,
            generation: checks.started,
        };
        drop(checks);
        for spec in &self.specs {
            self.forget_launch_detection(spec);
        }
        let _serialized = lock(&self.detecting);
        let results: Vec<(&'static str, Detected)> = thread::scope(|scope| {
            let handles: Vec<_> = self
                .specs
                .iter()
                .map(|spec| {
                    let env = &self.env;
                    let guardian = self.probe_guardian.as_ref();
                    (
                        spec,
                        scope.spawn(move || match guardian {
                            Some(guardian) => detect_guarded(spec, env, guardian),
                            None => detect(spec, env),
                        }),
                    )
                })
                .collect();
            handles
                .into_iter()
                .map(|(spec, handle)| {
                    let detected = handle.join().unwrap_or_else(|_| crashed(spec));
                    (spec.provider_id, detected)
                })
                .collect()
        });

        let mut events = Vec::new();
        let mut statuses = lock(&self.statuses);
        for (id, detected) in results {
            let Some(status) = statuses.iter_mut().find(|s| s.id.as_str() == id) else {
                continue;
            };
            events.extend(changes(status.detection.as_ref(), &detected));
            status.detection = Some(detected.detection);
            status.detection_error_code = detected.error_code.map(str::to_owned);
        }
        drop(statuses);
        let snapshot = self.list();
        if let Some(health) = self.health.get() {
            health.detected(&snapshot);
        }
        (snapshot, events)
    }
}

/// A detection thread panicked (a bug). Reported as an error for that provider only.
fn crashed(spec: &DetectionSpec) -> Detected {
    tracing::error!(
        event = "provider.detection_panicked",
        provider_id = spec.provider_id
    );
    Detected {
        detection: ProviderDetection {
            provider_id: ProviderId::new(spec.provider_id),
            display_name: spec.display_name.to_owned(),
            state: DetectionState::Error,
            display_path: None,
            version: None,
            minimum_version: spec.minimum_version.as_ref().map(ToString::to_string),
            auth: AuthState::Unknown,
            message: Some("KalCode couldn't finish checking this provider.".into()),
            checked_at: now_rfc3339(),
        },
        error_code: Some("detection_crashed"),
        executable: None,
        duration: std::time::Duration::ZERO,
    }
}

/// Events for a new detection compared with the previous one.
fn changes(previous: Option<&ProviderDetection>, next: &Detected) -> Vec<EventPayload> {
    let detection = &next.detection;
    let mut events = Vec::new();
    let changed =
        previous.is_none_or(|p| p.state != detection.state || p.version != detection.version);
    if changed {
        events.push(EventPayload::ProviderDetected {
            provider_id: detection.provider_id.clone(),
            installed: matches!(
                detection.state,
                DetectionState::Installed | DetectionState::Outdated
            ),
            version: detection.version.clone(),
        });
    }
    if detection.state == DetectionState::Error
        && previous.is_none_or(|p| p.state != DetectionState::Error)
    {
        events.push(EventPayload::ProviderError {
            provider_id: detection.provider_id.clone(),
            code: next.error_code.unwrap_or("detection_failed").to_owned(),
            message: detection
                .message
                .clone()
                .unwrap_or_else(|| "The provider couldn't be checked.".into()),
        });
    }
    events
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validated_managed_runtime_is_launchable_without_faking_machine_installation() {
        let registry = ProviderRegistry::with_specs(DetectEnv::from_process(), vec![]);
        let id = ProviderId::new("codex");
        assert!(!registry.usable().contains(&id));
        registry.set_managed_runtime(
            id.clone(),
            Some(crate::model::ManagedRuntimeReadiness {
                version: "0.161.0".into(),
                source: "last_known_good".into(),
            }),
        );
        assert!(registry.usable().contains(&id));
        let rows = registry.list();
        let row = rows.iter().find(|row| row.id == id).unwrap();
        assert!(
            row.detection.is_none(),
            "machine detection must remain truthful"
        );
        assert_eq!(row.managed_runtime.as_ref().unwrap().version, "0.161.0");
        registry.set_managed_runtime(id.clone(), None);
        assert!(
            !registry.usable().contains(&id),
            "failed revalidation clears availability"
        );
    }

    #[test]
    fn installation_observer_detects_updates_and_removal_without_starting_processes() {
        let dir = tempfile::tempdir().unwrap();
        let executable = dir
            .path()
            .join(if cfg!(windows) { "tool.exe" } else { "tool" });
        let spec = DetectionSpec {
            provider_id: "codex",
            display_name: "Codex",
            executable: "tool",
            install_dirs: &[],
            appdata_dirs: &[],
            local_appdata_dirs: &[],
            minimum_version: None,
            auth: None,
            env_policy: crate::env::EnvPolicy::BASE,
        };
        let env = DetectEnv {
            vars: vec![
                ("PATH".into(), std::env::join_paths([dir.path()]).unwrap()),
                ("PATHEXT".into(), ".EXE".into()),
            ],
            windows: cfg!(windows),
            probe_timeout: None,
            system_root: Some(dir.path().to_owned()),
        };
        let registry = ProviderRegistry::with_specs(env, vec![spec]);
        assert_eq!(
            registry.changed_installations(),
            vec![(ProviderId::new("codex"), None)]
        );
        assert!(registry.changed_installations().is_empty());
        // Deliberately non-executable contents: the observer must only inspect metadata.
        std::fs::write(&executable, b"first runtime").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        assert_eq!(registry.changed_installations().len(), 1);
        assert!(registry.changed_installations().is_empty());
        std::fs::write(&executable, b"new compatible runtime revision").unwrap();
        assert_eq!(registry.changed_installations().len(), 1);
        assert!(registry.changed_installations().is_empty());
        std::fs::remove_file(&executable).unwrap();
        assert_eq!(
            registry.changed_installations(),
            vec![(ProviderId::new("codex"), None)]
        );
        assert!(registry.changed_installations().is_empty());
        assert!(
            registry
                .list()
                .iter()
                .all(|status| status.detection.is_none())
        );
    }

    fn detected(state: DetectionState, version: Option<&str>) -> Detected {
        Detected {
            detection: ProviderDetection {
                provider_id: ProviderId::new("claude-code"),
                display_name: "Claude Code".into(),
                state,
                display_path: None,
                version: version.map(str::to_owned),
                minimum_version: None,
                auth: AuthState::Unknown,
                message: (state == DetectionState::Error).then(|| "failed".into()),
                checked_at: "t".into(),
            },
            error_code: (state == DetectionState::Error).then_some("version_timeout"),
            executable: None,
            duration: std::time::Duration::ZERO,
        }
    }

    #[test]
    fn first_detection_is_recorded_and_repeats_are_quiet() {
        let first = detected(DetectionState::Installed, Some("2.1.282"));
        let events = changes(None, &first);
        assert_eq!(
            events,
            [EventPayload::ProviderDetected {
                provider_id: ProviderId::new("claude-code"),
                installed: true,
                version: Some("2.1.282".into())
            }]
        );
        assert!(changes(Some(&first.detection), &first).is_empty());
        let upgraded = detected(DetectionState::Installed, Some("2.1.300"));
        assert_eq!(changes(Some(&first.detection), &upgraded).len(), 1);
    }

    #[test]
    fn errors_are_recorded_once() {
        let failed = detected(DetectionState::Error, None);
        let events = changes(None, &failed);
        assert_eq!(events.len(), 2);
        assert!(
            matches!(&events[1], EventPayload::ProviderError { code, .. } if code == "version_timeout")
        );
        assert!(changes(Some(&failed.detection), &failed).is_empty());
    }

    #[test]
    fn list_starts_with_every_provider_unchecked() {
        let registry = ProviderRegistry::with_specs(DetectEnv::default(), catalog::specs());
        let ids: Vec<_> = registry
            .list()
            .into_iter()
            .map(|s| (s.id.0, s.detection))
            .collect();
        assert_eq!(
            ids,
            [
                ("claude-code".to_owned(), None),
                ("codex".to_owned(), None),
                ("gemini-cli".to_owned(), None),
                ("cursor".to_owned(), None)
            ]
        );
    }
}
