//! Provider Health + Capacity (PH, `docs/PROVIDER_HEALTH.md`, `docs/campaigns/PROVIDERS-2.md`).
//!
//! One [`HealthMonitor`] per app. It combines:
//!
//! - **detection** (Z2): installed, version against the adapter's minimum, sign-in state as the
//!   provider's documented status command reports it — pushed by [`crate::ProviderRegistry`]
//!   after every detection;
//! - **observations from real sessions** ([`observe::ObservedProvider`] wraps each adapter):
//!   active sessions, time from sending input to the first model output, failures, and rate
//!   limits **only when the provider reported one in a structured shape** (Claude Code
//!   `api_rate_limit` / `StopFailure rate_limit`, Gemini CLI `RetryableQuotaError` /
//!   `TerminalQuotaError`). Codex's exec stream has no such shape, so a Codex rate limit is
//!   never reported. No quota, limit or retry time is ever estimated.
//!
//! Cost and isolation:
//! - Recording an observation is a short, bounded update under one lock; it never calls out.
//!   Sinks forward the provider's event **before** observing it, so health can't delay or drop
//!   thread events.
//! - Transitions (`provider.health_changed`, `provider.capacity_changed`) and re-detection
//!   requests are delivered by one driver thread that sleeps until something changes or the
//!   next observation ages out of its window. There is no polling and no provider process is
//!   ever started by health itself; a re-check is requested only after a session couldn't
//!   start or the provider reported a sign-in failure, at most once a minute per provider,
//!   backing off to 30 minutes.
//! - The code does not panic by construction (no indexing or unwraps; poison-tolerant locks).
//!   If the monitor is missing or broken, callers show "unknown" and threads run unaffected.

pub mod observe;

use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError, Weak};
use std::time::{Duration, Instant, SystemTime};

use kalcode_contracts::agent::{
    AgentEvent, AuthState, DetectionState, ModelInfo, ProviderDetection, ProviderError, ProviderId,
};
use kalcode_contracts::events::EventPayload;
use kalcode_contracts::health::{
    CapacityState, HealthFailure, HealthRollup, HealthState, HealthTrend, ProviderHealth,
    Recoverability,
};

use crate::model::ProviderStatus;

/// Latency samples considered for p50/p95.
pub const LATENCY_WINDOW: Duration = Duration::from_secs(15 * 60);
/// Failures considered "recent".
pub const FAILURE_WINDOW: Duration = Duration::from_secs(60 * 60);
/// Hourly rollups kept in memory (30 days).
pub const ROLLUP_HOURS: usize = 30 * 24;
/// Failures since the last successful turn that make a provider degraded.
pub const DEGRADED_AFTER_FAILURES: u32 = 2;
const MAX_LATENCY_SAMPLES: usize = 256;
const MAX_FAILURES: usize = 64;
const RECHECK_MIN: Duration = Duration::from_secs(60);
const RECHECK_MAX: Duration = Duration::from_secs(30 * 60);

/// Error codes that mean the provider reported a rate limit or quota error in a structured
/// shape. Adapters produce exactly these codes only from structured fields.
pub fn is_rate_limit_code(code: &str) -> bool {
    matches!(
        code,
        "api_rate_limit" | "provider_rate_limit" | "rate_limited" | "quota_exhausted"
    )
}

/// Error codes that mean the provider rejected its sign-in (structured, adapter-produced).
pub fn is_auth_code(code: &str) -> bool {
    matches!(
        code,
        "api_authentication_failed"
            | "provider_authentication_failed"
            | "provider_oauth_org_not_allowed"
    )
}

/// Error codes that count as a session failure. Warnings, reconnect notices, user-initiated
/// stops and "limited status" notices don't.
pub fn is_failure_code(code: &str) -> bool {
    if is_rate_limit_code(code) {
        return false;
    }
    matches!(
        code,
        "process_exited"
            | "turn_failed"
            | "turn_error"
            | "protocol_error"
            | "unexpected_host_request"
            | "provider_error"
            | "start_failed"
    ) || code.starts_with("turn_error")
        || code.starts_with("api_")
        || (code.starts_with("provider_") && code != "provider_warning")
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn rfc3339(at: SystemTime) -> String {
    kalcode_core::time::format_rfc3339(time::OffsetDateTime::from(at))
}

fn hour_start(at: SystemTime) -> u64 {
    at.duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs() / 3600 * 3600)
        .unwrap_or(0)
}

/// Receives what the monitor decides. Called only from the driver thread, never while a
/// provider event is being delivered.
pub trait HealthListener: Send + Sync {
    /// A `provider.health_changed` or `provider.capacity_changed` event to record.
    fn transition(&self, event: EventPayload);
    /// Health wants `provider` detected again (a session couldn't start, or the provider
    /// reported a sign-in failure). Run the read-only detection off the calling thread.
    fn recheck(&self, provider: &ProviderId);
}

#[derive(Debug, Clone, Default)]
struct Bucket {
    hour: u64,
    sessions_started: u32,
    failures: u32,
    backoffs: u32,
    latencies: Vec<u32>,
}

#[derive(Debug, Clone)]
struct Backoff {
    code: String,
    since: Instant,
}

#[derive(Debug)]
struct ProviderState {
    display_name: String,
    models: Vec<ModelInfo>,
    detection: Option<ProviderDetection>,
    active_sessions: u32,
    latency: VecDeque<(Instant, u32)>,
    failures: VecDeque<(Instant, SystemTime, String)>,
    last_success: Option<Instant>,
    backoff: Option<Backoff>,
    rollups: VecDeque<Bucket>,
    reported: Option<(HealthState, CapacityState)>,
    recheck_due: Option<Instant>,
    last_recheck: Option<Instant>,
    recheck_interval: Duration,
}

impl ProviderState {
    fn new(display_name: String, models: Vec<ModelInfo>) -> Self {
        Self {
            display_name,
            models,
            detection: None,
            active_sessions: 0,
            latency: VecDeque::new(),
            failures: VecDeque::new(),
            last_success: None,
            backoff: None,
            rollups: VecDeque::new(),
            reported: None,
            recheck_due: None,
            last_recheck: None,
            recheck_interval: RECHECK_MIN,
        }
    }

    /// Updates the current hour's rollup.
    fn with_bucket(&mut self, now: SystemTime, f: impl FnOnce(&mut Bucket)) {
        let hour = hour_start(now);
        if self.rollups.back().is_none_or(|b| b.hour != hour) {
            self.rollups.push_back(Bucket {
                hour,
                ..Bucket::default()
            });
            while self.rollups.len() > ROLLUP_HOURS {
                self.rollups.pop_front();
            }
        }
        if let Some(bucket) = self.rollups.back_mut() {
            f(bucket);
        }
    }

    /// Asks for a re-detection: now the first time, then no more often than the backoff.
    fn request_recheck(&mut self) {
        if self.recheck_due.is_some() {
            return;
        }
        let now = Instant::now();
        self.recheck_due = Some(
            self.last_recheck
                .map_or(now, |last| (last + self.recheck_interval).max(now)),
        );
    }

    fn prune(&mut self, now: Instant) {
        while self
            .latency
            .front()
            .is_some_and(|(at, _)| now.saturating_duration_since(*at) > LATENCY_WINDOW)
        {
            self.latency.pop_front();
        }
        while self
            .failures
            .front()
            .is_some_and(|(at, _, _)| now.saturating_duration_since(*at) > FAILURE_WINDOW)
        {
            self.failures.pop_front();
        }
        if self
            .backoff
            .as_ref()
            .is_some_and(|b| now.saturating_duration_since(b.since) > FAILURE_WINDOW)
        {
            // A reported limit with no later observation is stale after an hour.
            self.backoff = None;
        }
    }

    fn failures_since_success(&self) -> u32 {
        let count = self
            .failures
            .iter()
            .filter(|(at, _, _)| self.last_success.is_none_or(|s| *at > s))
            .count();
        u32::try_from(count).unwrap_or(u32::MAX)
    }

    /// The next moment an observation ages out and could change the assessment.
    fn next_expiry(&self) -> Option<Instant> {
        let failure = self.failures.front().map(|(at, _, _)| *at + FAILURE_WINDOW);
        let backoff = self.backoff.as_ref().map(|b| b.since + FAILURE_WINDOW);
        [failure, backoff, self.recheck_due]
            .into_iter()
            .flatten()
            .min()
    }
}

fn percentile(sorted: &[u32], p: usize) -> Option<u32> {
    if sorted.is_empty() {
        return None;
    }
    let rank = (sorted.len() * p).div_ceil(100).saturating_sub(1);
    sorted.get(rank.min(sorted.len() - 1)).copied()
}

/// The assessment of one provider at one moment (pure).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Assessment {
    state: HealthState,
    capacity: CapacityState,
    recoverability: Recoverability,
    reason_code: Option<&'static str>,
    reason: Option<String>,
}

fn assess(p: &ProviderState) -> Assessment {
    let name = &p.display_name;
    let unavailable = |recoverability, code: &'static str, reason: String| Assessment {
        state: HealthState::Unavailable,
        capacity: CapacityState::Unknown,
        recoverability,
        reason_code: Some(code),
        reason: Some(reason),
    };
    let Some(detection) = &p.detection else {
        return Assessment {
            state: HealthState::Unknown,
            capacity: CapacityState::Unknown,
            recoverability: Recoverability::Unknown,
            reason_code: Some("not_checked"),
            reason: Some(format!("{name} hasn't been checked yet.")),
        };
    };
    match detection.state {
        DetectionState::NotInstalled => {
            return unavailable(
                Recoverability::Install,
                "not_installed",
                format!("{name} isn't installed."),
            );
        }
        DetectionState::Outdated => {
            return unavailable(
                Recoverability::Update,
                "outdated",
                detection
                    .message
                    .clone()
                    .unwrap_or_else(|| format!("{name} needs an update.")),
            );
        }
        DetectionState::Error => {
            return unavailable(
                Recoverability::Restart,
                "detection_failed",
                format!("KalCode couldn't check {name}. Choose Check again."),
            );
        }
        DetectionState::Installed => {}
    }
    if detection.auth == AuthState::NotAuthenticated {
        return unavailable(
            Recoverability::SignIn,
            "signed_out",
            format!("{name} is signed out. Sign in with its own command, then check again."),
        );
    }
    if let Some(backoff) = &p.backoff {
        let quota = backoff.code == "quota_exhausted";
        return Assessment {
            state: HealthState::Degraded,
            capacity: CapacityState::BackingOff,
            recoverability: if quota {
                Recoverability::Unknown
            } else {
                Recoverability::Automatic
            },
            reason_code: Some(if quota {
                "quota_exhausted"
            } else {
                "rate_limited"
            }),
            reason: Some(if quota {
                format!("{name} reported that your quota is used up.")
            } else {
                format!("{name} reported a rate limit. New work should wait.")
            }),
        };
    }
    let failing = p.failures_since_success();
    if failing >= DEGRADED_AFTER_FAILURES {
        return Assessment {
            state: HealthState::Degraded,
            capacity: CapacityState::Available,
            recoverability: Recoverability::Restart,
            reason_code: Some("recent_failures"),
            reason: Some(format!(
                "{failing} recent {name} sessions failed without a successful turn since."
            )),
        };
    }
    let auth_unknown = detection.auth == AuthState::Unknown;
    Assessment {
        state: HealthState::Healthy,
        capacity: CapacityState::Available,
        recoverability: Recoverability::None,
        reason_code: auth_unknown.then_some("auth_unknown"),
        reason: auth_unknown.then(|| {
            format!("{name} has no documented way to check sign-in, so it shows as unknown.")
        }),
    }
}

fn trend(p: &ProviderState) -> HealthTrend {
    let with_data: Vec<&Bucket> = p
        .rollups
        .iter()
        .rev()
        .take(6)
        .filter(|b| b.sessions_started > 0 || !b.latencies.is_empty() || b.failures > 0)
        .collect();
    let (Some(latest), Some(_)) = (with_data.first(), with_data.get(1)) else {
        return HealthTrend::InsufficientData;
    };
    let rate =
        |b: &Bucket| f64::from(b.failures + b.backoffs) / f64::from(b.sessions_started.max(1));
    let earlier: Vec<&&Bucket> = with_data.iter().skip(1).collect();
    let earlier_rate = earlier.iter().map(|b| rate(b)).sum::<f64>() / earlier.len() as f64;
    let now_rate = rate(latest);
    if now_rate > earlier_rate + 0.2 {
        HealthTrend::Worsening
    } else if now_rate + 0.2 < earlier_rate {
        HealthTrend::Improving
    } else {
        HealthTrend::Stable
    }
}

#[derive(Default)]
struct Monitor {
    providers: BTreeMap<ProviderId, ProviderState>,
    shutdown: bool,
}

/// The live health model. See the module docs.
pub struct HealthMonitor {
    inner: Mutex<Monitor>,
    wake: Condvar,
    listener: Mutex<Option<Arc<dyn HealthListener>>>,
}

impl Default for HealthMonitor {
    fn default() -> Self {
        Self::new()
    }
}

impl HealthMonitor {
    /// A monitor for every provider in the catalog.
    pub fn new() -> Self {
        let providers = crate::catalog::statuses()
            .into_iter()
            .map(|s| {
                (
                    s.id.clone(),
                    ProviderState::new(s.display_name, s.capabilities.models),
                )
            })
            .collect();
        Self {
            inner: Mutex::new(Monitor {
                providers,
                ..Monitor::default()
            }),
            wake: Condvar::new(),
            listener: Mutex::new(None),
        }
    }

    pub fn set_listener(&self, listener: Arc<dyn HealthListener>) {
        *lock(&self.listener) = Some(listener);
        self.wake.notify_all();
    }

    fn with_provider(&self, id: &ProviderId, f: impl FnOnce(&mut ProviderState)) {
        let mut inner = lock(&self.inner);
        if let Some(p) = inner.providers.get_mut(id) {
            f(p);
        }
        drop(inner);
        self.wake.notify_all();
    }

    /// Detection results (from [`crate::ProviderRegistry`]).
    pub fn detected(&self, statuses: &[ProviderStatus]) {
        let mut inner = lock(&self.inner);
        for status in statuses {
            let Some(detection) = &status.detection else {
                continue;
            };
            let p = inner.providers.entry(status.id.clone()).or_insert_with(|| {
                ProviderState::new(
                    status.display_name.clone(),
                    status.capabilities.models.clone(),
                )
            });
            let usable = detection.state == DetectionState::Installed
                && detection.auth != AuthState::NotAuthenticated;
            if usable {
                p.recheck_interval = RECHECK_MIN;
            }
            p.detection = Some(detection.clone());
            p.recheck_due = None;
        }
        drop(inner);
        self.wake.notify_all();
    }

    pub(crate) fn session_started(&self, id: &ProviderId) {
        self.with_provider(id, |p| {
            p.active_sessions = p.active_sessions.saturating_add(1);
            p.with_bucket(SystemTime::now(), |b| b.sessions_started += 1);
        });
    }

    pub(crate) fn session_ended(&self, id: &ProviderId) {
        self.with_provider(id, |p| {
            p.active_sessions = p.active_sessions.saturating_sub(1);
        });
    }

    fn record_failure(p: &mut ProviderState, code: &str) {
        let now = Instant::now();
        let wall = SystemTime::now();
        p.failures.push_back((now, wall, code.to_owned()));
        while p.failures.len() > MAX_FAILURES {
            p.failures.pop_front();
        }
        p.with_bucket(wall, |b| b.failures += 1);
    }

    /// A session couldn't start.
    pub(crate) fn start_failed(&self, id: &ProviderId, error: &ProviderError) {
        let code = match error {
            ProviderError::NotInstalled => "not_installed",
            ProviderError::NotAuthenticated => "not_authenticated",
            ProviderError::Unsupported => return,
            _ => "start_failed",
        };
        self.with_provider(id, |p| {
            Self::record_failure(p, code);
            // Detection may be stale (signed out, uninstalled, updated): check again, gently.
            p.request_recheck();
        });
    }

    /// Input was sent; the next model output measures latency.
    pub(crate) fn input_sent(&self, id: &ProviderId) {
        self.with_provider(id, |p| p.with_bucket(SystemTime::now(), |_| {}));
    }

    pub(crate) fn first_output(&self, id: &ProviderId, latency: Duration) {
        let ms = u32::try_from(latency.as_millis()).unwrap_or(u32::MAX);
        self.with_provider(id, |p| {
            p.latency.push_back((Instant::now(), ms));
            while p.latency.len() > MAX_LATENCY_SAMPLES {
                p.latency.pop_front();
            }
            p.with_bucket(SystemTime::now(), |b| b.latencies.push(ms));
        });
    }

    /// One provider event of a session (already delivered to the thread runtime).
    pub(crate) fn event(&self, id: &ProviderId, event: &AgentEvent) {
        match event {
            AgentEvent::Error { code, .. } => self.with_provider(id, |p| {
                if is_rate_limit_code(code) {
                    p.backoff = Some(Backoff {
                        code: code.clone(),
                        since: Instant::now(),
                    });
                    p.with_bucket(SystemTime::now(), |b| b.backoffs += 1);
                } else if is_failure_code(code) {
                    Self::record_failure(p, code);
                }
                if is_auth_code(code) {
                    p.request_recheck();
                }
            }),
            AgentEvent::TurnCompleted { ok: true } => self.with_provider(id, |p| {
                p.last_success = Some(Instant::now());
                p.backoff = None;
            }),
            _ => {}
        }
    }

    fn snapshot(id: &ProviderId, p: &ProviderState, now: Instant) -> ProviderHealth {
        let a = assess(p);
        let mut latencies: Vec<u32> = p
            .latency
            .iter()
            .filter(|(at, _)| now.saturating_duration_since(*at) <= LATENCY_WINDOW)
            .map(|(_, ms)| *ms)
            .collect();
        latencies.sort_unstable();
        let recent: Vec<&(Instant, SystemTime, String)> = p
            .failures
            .iter()
            .filter(|(at, _, _)| now.saturating_duration_since(*at) <= FAILURE_WINDOW)
            .collect();
        ProviderHealth {
            provider_id: id.clone(),
            display_name: p.display_name.clone(),
            state: a.state,
            detection: p.detection.as_ref().map(|d| d.state),
            auth: p.detection.as_ref().map_or(AuthState::Unknown, |d| d.auth),
            account_label: None,
            version: p.detection.as_ref().and_then(|d| d.version.clone()),
            minimum_version: p.detection.as_ref().and_then(|d| d.minimum_version.clone()),
            models: p.models.clone(),
            process_running: p.active_sessions > 0,
            active_sessions: p.active_sessions,
            latency_p50_ms: percentile(&latencies, 50),
            latency_p95_ms: percentile(&latencies, 95),
            latency_samples: u32::try_from(latencies.len()).unwrap_or(u32::MAX),
            recent_failures: u32::try_from(recent.len()).unwrap_or(u32::MAX),
            last_failure: recent.last().map(|(_, wall, code)| HealthFailure {
                code: code.clone(),
                at: rfc3339(*wall),
            }),
            capacity: a.capacity,
            // No provider KalCode runs reports a retry time in a documented shape today.
            backoff_until: None,
            trend: trend(p),
            recoverability: a.recoverability,
            reason_code: a.reason_code.map(str::to_owned),
            reason: a.reason,
            checked_at: p.detection.as_ref().map(|d| d.checked_at.clone()),
            observed_at: kalcode_core::time::now_rfc3339(),
        }
    }

    /// Every provider's health, catalog order.
    pub fn list(&self) -> Vec<ProviderHealth> {
        let now = Instant::now();
        let mut inner = lock(&self.inner);
        let mut out: Vec<ProviderHealth> = Vec::with_capacity(inner.providers.len());
        for (id, p) in &mut inner.providers {
            p.prune(now);
            out.push(Self::snapshot(id, p, now));
        }
        let order: Vec<ProviderId> = crate::catalog::statuses()
            .into_iter()
            .map(|s| s.id)
            .collect();
        out.sort_by_key(|h| {
            order
                .iter()
                .position(|id| *id == h.provider_id)
                .unwrap_or(usize::MAX)
        });
        out
    }

    pub fn get(&self, id: &ProviderId) -> Option<ProviderHealth> {
        let now = Instant::now();
        let mut inner = lock(&self.inner);
        let p = inner.providers.get_mut(id)?;
        p.prune(now);
        Some(Self::snapshot(id, p, now))
    }

    /// Hourly rollups for the last `hours` hours (at most 30 days), oldest first.
    pub fn trend(&self, id: &ProviderId, hours: u32) -> Vec<HealthRollup> {
        let hours = usize::try_from(hours)
            .unwrap_or(ROLLUP_HOURS)
            .min(ROLLUP_HOURS);
        let oldest = hour_start(SystemTime::now()).saturating_sub(hours as u64 * 3600);
        let inner = lock(&self.inner);
        let Some(p) = inner.providers.get(id) else {
            return Vec::new();
        };
        p.rollups
            .iter()
            .filter(|b| b.hour >= oldest)
            .map(|b| {
                let mut sorted = b.latencies.clone();
                sorted.sort_unstable();
                HealthRollup {
                    provider_id: id.clone(),
                    hour_start: rfc3339(SystemTime::UNIX_EPOCH + Duration::from_secs(b.hour)),
                    sessions_started: b.sessions_started,
                    failures: b.failures,
                    backoffs: b.backoffs,
                    latency_p50_ms: percentile(&sorted, 50),
                    latency_p95_ms: percentile(&sorted, 95),
                    samples: u32::try_from(sorted.len()).unwrap_or(u32::MAX),
                }
            })
            .collect()
    }

    /// Re-assesses every provider; returns the transition events and due re-checks, and the
    /// next time something could change on its own.
    fn evaluate(&self) -> (Vec<EventPayload>, Vec<ProviderId>, Option<Instant>) {
        let now = Instant::now();
        let mut events = Vec::new();
        let mut inner = lock(&self.inner);
        let mut due: Vec<ProviderId> = Vec::new();
        let mut next: Option<Instant> = None;
        for (id, p) in &mut inner.providers {
            p.prune(now);
            let a = assess(p);
            let current = (a.state, a.capacity);
            let previous = p.reported;
            if previous != Some(current) {
                let (from_state, from_capacity) =
                    previous.unwrap_or((HealthState::Unknown, CapacityState::Unknown));
                if from_state != a.state {
                    events.push(EventPayload::ProviderHealthChanged {
                        provider_id: id.clone(),
                        from: from_state,
                        to: a.state,
                        reason: a.reason_code.unwrap_or("healthy").to_owned(),
                    });
                }
                // Capacity events cover available / saturated / backing_off only.
                if from_capacity != a.capacity && a.capacity != CapacityState::Unknown {
                    events.push(EventPayload::ProviderCapacityChanged {
                        provider_id: id.clone(),
                        state: a.capacity,
                        active_sessions: p.active_sessions,
                        limit: None,
                        retry_at: None,
                    });
                }
                p.reported = Some(current);
            }
            if p.recheck_due.is_some_and(|at| at <= now) {
                due.push(id.clone());
                p.recheck_due = None;
                p.last_recheck = Some(now);
                p.recheck_interval = (p.recheck_interval * 2).min(RECHECK_MAX);
            }
            if let Some(at) = p.next_expiry() {
                next = Some(next.map_or(at, |n| n.min(at)));
            }
        }
        (events, due, next)
    }

    /// Starts the driver thread. It holds the monitor weakly and ends when it is dropped or
    /// [`Self::shutdown`] is called.
    pub fn spawn_driver(self: &Arc<Self>) -> std::io::Result<()> {
        let weak: Weak<Self> = Arc::downgrade(self);
        std::thread::Builder::new()
            .name("kalcode-provider-health".into())
            .spawn(move || {
                loop {
                    let Some(monitor) = weak.upgrade() else {
                        return;
                    };
                    let (events, due, next) = monitor.evaluate();
                    let listener = lock(&monitor.listener).clone();
                    if let Some(listener) = &listener {
                        for event in events {
                            listener.transition(event);
                        }
                        for id in &due {
                            listener.recheck(id);
                        }
                    }
                    let inner = lock(&monitor.inner);
                    if inner.shutdown {
                        return;
                    }
                    // Sleep until an observation arrives or the next one ages out. A cap keeps
                    // a dropped monitor from pinning this thread forever.
                    let wait = next
                        .map(|at| at.saturating_duration_since(Instant::now()))
                        .unwrap_or(Duration::from_secs(3600))
                        .clamp(Duration::from_millis(50), Duration::from_secs(3600));
                    let _ = monitor.wake.wait_timeout(inner, wait);
                }
            })
            .map(|_| ())
    }

    pub fn shutdown(&self) {
        lock(&self.inner).shutdown = true;
        self.wake.notify_all();
    }

    /// For tests: runs one evaluation and returns what the driver would deliver.
    pub fn evaluate_now(&self) -> (Vec<EventPayload>, Vec<ProviderId>) {
        let (events, due, _) = self.evaluate();
        (events, due)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn detection(id: &str, state: DetectionState, auth: AuthState) -> ProviderStatus {
        let mut status = crate::catalog::statuses()
            .into_iter()
            .find(|s| s.id.as_str() == id)
            .expect("catalog");
        status.detection = Some(ProviderDetection {
            provider_id: ProviderId::new(id),
            display_name: status.display_name.clone(),
            state,
            display_path: None,
            version: Some("0.155.1".into()),
            minimum_version: Some("0.155.0".into()),
            auth,
            message: None,
            checked_at: "t".into(),
        });
        status
    }

    fn codex() -> ProviderId {
        ProviderId::new(ProviderId::CODEX)
    }

    fn health(m: &HealthMonitor) -> ProviderHealth {
        m.get(&codex()).expect("codex")
    }

    #[test]
    fn unknown_until_detected_then_follows_detection() {
        let m = HealthMonitor::new();
        assert_eq!(health(&m).state, HealthState::Unknown);
        assert_eq!(health(&m).capacity, CapacityState::Unknown);
        m.detected(&[detection(
            "codex",
            DetectionState::Installed,
            AuthState::Authenticated,
        )]);
        let h = health(&m);
        assert_eq!(h.state, HealthState::Healthy);
        assert_eq!(h.capacity, CapacityState::Available);
        assert_eq!(h.version.as_deref(), Some("0.155.1"));
        m.detected(&[detection(
            "codex",
            DetectionState::Installed,
            AuthState::NotAuthenticated,
        )]);
        let h = health(&m);
        assert_eq!(h.state, HealthState::Unavailable);
        assert_eq!(h.recoverability, Recoverability::SignIn);
        m.detected(&[detection(
            "codex",
            DetectionState::Outdated,
            AuthState::Unknown,
        )]);
        assert_eq!(health(&m).recoverability, Recoverability::Update);
        m.detected(&[detection(
            "codex",
            DetectionState::NotInstalled,
            AuthState::Unknown,
        )]);
        assert_eq!(health(&m).recoverability, Recoverability::Install);
    }

    #[test]
    fn unknown_sign_in_is_healthy_but_says_so() {
        let m = HealthMonitor::new();
        m.detected(&[detection(
            "gemini-cli",
            DetectionState::Installed,
            AuthState::Unknown,
        )]);
        let h = m
            .get(&ProviderId::new(ProviderId::GEMINI_CLI))
            .expect("gemini");
        assert_eq!(h.state, HealthState::Healthy);
        assert_eq!(h.auth, AuthState::Unknown);
        assert_eq!(h.reason_code.as_deref(), Some("auth_unknown"));
    }

    #[test]
    fn sessions_latency_and_failures_come_from_observations() {
        let m = HealthMonitor::new();
        m.detected(&[detection(
            "codex",
            DetectionState::Installed,
            AuthState::Authenticated,
        )]);
        m.session_started(&codex());
        m.session_started(&codex());
        for ms in [100, 200, 300, 400, 1000] {
            m.first_output(&codex(), Duration::from_millis(ms));
        }
        let h = health(&m);
        assert_eq!(h.active_sessions, 2);
        assert!(h.process_running);
        assert_eq!(h.latency_p50_ms, Some(300));
        assert_eq!(h.latency_p95_ms, Some(1000));
        assert_eq!(h.latency_samples, 5);

        m.event(
            &codex(),
            &AgentEvent::Error {
                code: "process_exited".into(),
                message: "x".into(),
                recoverable: true,
            },
        );
        assert_eq!(
            health(&m).state,
            HealthState::Healthy,
            "one failure is not a trend"
        );
        m.event(
            &codex(),
            &AgentEvent::Error {
                code: "turn_failed".into(),
                message: "x".into(),
                recoverable: true,
            },
        );
        let h = health(&m);
        assert_eq!(h.state, HealthState::Degraded);
        assert_eq!(h.recent_failures, 2);
        assert_eq!(
            h.last_failure.as_ref().map(|f| f.code.as_str()),
            Some("turn_failed")
        );
        m.event(&codex(), &AgentEvent::TurnCompleted { ok: true });
        assert_eq!(health(&m).state, HealthState::Healthy, "a success recovers");
        assert_eq!(
            health(&m).recent_failures,
            2,
            "failures stay counted for the window"
        );

        // Warnings, reconnect notices and user stops are not failures.
        for code in [
            "provider_warning",
            "stream_error",
            "interrupt_unconfirmed",
            "hooks_inactive",
            "codex_item_error",
        ] {
            m.event(
                &codex(),
                &AgentEvent::Error {
                    code: code.into(),
                    message: "x".into(),
                    recoverable: true,
                },
            );
        }
        assert_eq!(health(&m).recent_failures, 2);
        m.session_ended(&codex());
        m.session_ended(&codex());
        m.session_ended(&codex());
        assert_eq!(health(&m).active_sessions, 0, "never below zero");
    }

    #[test]
    fn rate_limits_only_from_structured_codes_and_clear_on_success() {
        let m = HealthMonitor::new();
        m.detected(&[detection(
            "codex",
            DetectionState::Installed,
            AuthState::Authenticated,
        )]);
        m.event(
            &codex(),
            &AgentEvent::Error {
                code: "turn_failed".into(),
                message: "429 rate limit exceeded, quota".into(),
                recoverable: true,
            },
        );
        assert_ne!(
            health(&m).capacity,
            CapacityState::BackingOff,
            "text never means a rate limit"
        );
        m.event(
            &codex(),
            &AgentEvent::Error {
                code: "rate_limited".into(),
                message: "x".into(),
                recoverable: true,
            },
        );
        let h = health(&m);
        assert_eq!(h.capacity, CapacityState::BackingOff);
        assert_eq!(h.state, HealthState::Degraded);
        assert_eq!(h.recoverability, Recoverability::Automatic);
        assert_eq!(h.backoff_until, None, "no retry time is invented");
        m.event(&codex(), &AgentEvent::TurnCompleted { ok: true });
        assert_eq!(health(&m).capacity, CapacityState::Available);
        m.event(
            &codex(),
            &AgentEvent::Error {
                code: "quota_exhausted".into(),
                message: "x".into(),
                recoverable: true,
            },
        );
        assert_eq!(health(&m).reason_code.as_deref(), Some("quota_exhausted"));
    }

    #[test]
    fn transitions_are_emitted_once_per_change() {
        let m = HealthMonitor::new();
        let (events, _) = m.evaluate_now();
        assert!(
            events.is_empty(),
            "unknown → unknown is not a transition: {events:?}"
        );
        m.detected(&[detection(
            "codex",
            DetectionState::Installed,
            AuthState::Authenticated,
        )]);
        let (events, _) = m.evaluate_now();
        assert_eq!(events.len(), 2, "{events:?}");
        assert!(matches!(
            &events[0],
            EventPayload::ProviderHealthChanged {
                from: HealthState::Unknown,
                to: HealthState::Healthy,
                ..
            }
        ));
        assert!(matches!(
            &events[1],
            EventPayload::ProviderCapacityChanged {
                state: CapacityState::Available,
                ..
            }
        ));
        assert!(m.evaluate_now().0.is_empty(), "no samples as events");
        m.first_output(&codex(), Duration::from_millis(10));
        assert!(
            m.evaluate_now().0.is_empty(),
            "latency samples are not transitions"
        );
        m.event(
            &codex(),
            &AgentEvent::Error {
                code: "api_rate_limit".into(),
                message: "x".into(),
                recoverable: true,
            },
        );
        let (events, _) = m.evaluate_now();
        assert!(events.iter().any(|e| matches!(e, EventPayload::ProviderHealthChanged { to: HealthState::Degraded, reason, .. } if reason == "rate_limited")));
        assert!(events.iter().any(|e| matches!(
            e,
            EventPayload::ProviderCapacityChanged {
                state: CapacityState::BackingOff,
                ..
            }
        )));
    }

    #[test]
    fn start_failures_request_a_gentle_recheck() {
        let m = HealthMonitor::new();
        m.detected(&[detection(
            "codex",
            DetectionState::Installed,
            AuthState::Authenticated,
        )]);
        m.evaluate_now();
        m.start_failed(&codex(), &ProviderError::NotAuthenticated);
        let (_, due) = m.evaluate_now();
        assert_eq!(due, [codex()], "the first failure re-checks right away");
        m.start_failed(&codex(), &ProviderError::NotAuthenticated);
        let (_, due) = m.evaluate_now();
        assert!(due.is_empty(), "repeats wait (backoff)");
        // A detection clears the pending request.
        m.detected(&[detection(
            "codex",
            DetectionState::Installed,
            AuthState::NotAuthenticated,
        )]);
        assert_eq!(health(&m).state, HealthState::Unavailable);
    }

    #[test]
    fn trend_needs_two_hours_of_data() {
        let m = HealthMonitor::new();
        m.session_started(&codex());
        assert_eq!(health(&m).trend, HealthTrend::InsufficientData);
        let rollups = m.trend(&codex(), 24);
        assert_eq!(rollups.len(), 1);
        assert_eq!(rollups[0].sessions_started, 1);
        let mut p = ProviderState::new("Codex".into(), Vec::new());
        p.rollups.push_back(Bucket {
            hour: 0,
            sessions_started: 4,
            ..Bucket::default()
        });
        p.rollups.push_back(Bucket {
            hour: 3600,
            sessions_started: 2,
            failures: 2,
            ..Bucket::default()
        });
        assert_eq!(trend(&p), HealthTrend::Worsening);
        p.rollups.push_back(Bucket {
            hour: 7200,
            sessions_started: 5,
            ..Bucket::default()
        });
        assert_eq!(trend(&p), HealthTrend::Improving);
    }

    #[test]
    fn codes_are_classified_conservatively() {
        assert!(is_rate_limit_code("api_rate_limit"));
        assert!(!is_failure_code("api_rate_limit"));
        assert!(is_failure_code("api_overloaded"));
        assert!(is_failure_code("turn_error_max_turns"));
        assert!(!is_failure_code("provider_warning"));
        assert!(is_auth_code("api_authentication_failed"));
    }
}
