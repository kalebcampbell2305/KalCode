//! Cached provider detection for the desktop shell.
//!
//! Each provider is detected on its own thread; a provider that hangs, crashes or misbehaves
//! only affects its own row. Results are cached until the next detection, and the events worth
//! recording (`provider.detected` on a change, `provider.error` on failure) are returned so the
//! caller can persist them.

use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::thread;

use kalcode_contracts::agent::{AuthState, DetectionState, ProviderDetection, ProviderId};
use kalcode_contracts::events::EventPayload;
use kalcode_core::time::now_rfc3339;

use crate::catalog;
use crate::detect::{DetectEnv, Detected, DetectionSpec, detect};
use crate::health::HealthMonitor;
use crate::model::ProviderStatus;

pub struct ProviderRegistry {
    env: DetectEnv,
    specs: Vec<DetectionSpec>,
    statuses: Mutex<Vec<ProviderStatus>>,
    /// Serializes detections so two "Check again" clicks never probe the same CLI in parallel.
    detecting: Mutex<()>,
    /// Provider Health, told about every detection (PH). Optional: detection works without it.
    health: OnceLock<Arc<HealthMonitor>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl ProviderRegistry {
    pub fn new(env: DetectEnv) -> Self {
        Self::with_specs(env, catalog::specs())
    }

    /// For tests: a registry over custom detection specs (ids must match catalog entries).
    pub fn with_specs(env: DetectEnv, specs: Vec<DetectionSpec>) -> Self {
        Self {
            env,
            specs,
            statuses: Mutex::new(catalog::statuses()),
            detecting: Mutex::new(()),
            health: OnceLock::new(),
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
        let _serialized = lock(&self.detecting);
        let detected = detect(spec, &self.env);
        let mut statuses = lock(&self.statuses);
        let Some(status) = statuses.iter_mut().find(|s| &s.id == id) else {
            return Vec::new();
        };
        let events = changes(status.detection.as_ref(), &detected);
        status.detection = Some(detected.detection);
        status.detection_error_code = detected.error_code.map(str::to_owned);
        let snapshot = statuses.clone();
        drop(statuses);
        if let Some(health) = self.health.get() {
            health.detected(&snapshot);
        }
        events
    }

    /// The cached statuses (detection is `None` for providers not checked yet).
    pub fn list(&self) -> Vec<ProviderStatus> {
        lock(&self.statuses).clone()
    }

    /// Providers that can run a session right now: KalCode has an adapter, the CLI is installed
    /// at a supported version, and it is not known to be signed out. Callers that let the user
    /// pick a provider (threads, KalVoice) choose from this list. Uses the cached detection.
    pub fn usable(&self) -> Vec<ProviderId> {
        lock(&self.statuses)
            .iter()
            .filter(|s| s.adapter == crate::model::AdapterState::Implemented)
            .filter(|s| {
                s.detection.as_ref().is_some_and(|d| {
                    d.state == DetectionState::Installed && d.auth != AuthState::NotAuthenticated
                })
            })
            .map(|s| s.id.clone())
            .collect()
    }

    /// Detects every provider in parallel, updates the cache, and returns the new statuses with
    /// the events to record.
    pub fn detect_all(&self) -> (Vec<ProviderStatus>, Vec<EventPayload>) {
        let _serialized = lock(&self.detecting);
        let results: Vec<(&'static str, Detected)> = thread::scope(|scope| {
            let handles: Vec<_> = self
                .specs
                .iter()
                .map(|spec| {
                    let env = &self.env;
                    (spec, scope.spawn(move || detect(spec, env)))
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
        let snapshot = statuses.clone();
        drop(statuses);
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
        let registry = ProviderRegistry::new(DetectEnv::default());
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
                ("gemini-cli".to_owned(), None)
            ]
        );
    }
}
