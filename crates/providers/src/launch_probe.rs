//! Launch-time reuse of a recent provider detection.
//!
//! Starting a session needs the provider's executable, its version (minimum and managed-version
//! checks) and its sign-in state. Detecting those spawns `<cli> --version` and, for providers
//! with a documented status command, `<cli> login status`: 0.75–1.8 s per launch under load
//! (2–4.4 s for Codex). A launch reuses a recent detection instead when all of these hold:
//!
//! - it was made for exactly the same detection inputs: the spec, the whole environment (so
//!   `PATH` and an account's profile selector), the platform, the timeouts and guardian use;
//! - it is younger than [`LAUNCH_REUSE_TTL`];
//! - resolving the executable again (file-system lookups only, no process) finds the same file;
//! - that file, and whatever a launcher starts (a shim's native target, or `node` and the
//!   script), still exists with the same size, modification and creation time;
//! - nothing invalidated it since: an explicit check of that executable
//!   ([`forget_executable`]), a failed start, or an authentication error reported by a running
//!   session ([`forget`]).
//!
//! Only results a session can start with are kept: installed at a supported version and not
//! known to be signed out. Anything else is probed again on every launch, so installing,
//! upgrading or signing in is seen at once, and a binary that disappeared or changed is probed
//! again and reported with the real reason. Concurrent launches with the same inputs share one
//! in-flight probe instead of each spawning their own.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime};

use kalcode_contracts::agent::{AuthState, DetectionState};

use crate::detect::{DetectEnv, Detected, DetectionSpec, detect, detect_guarded};
use crate::guardian::ProviderProbeGuardian;

/// How long a launch may reuse a detection made for the same inputs.
pub const LAUNCH_REUSE_TTL: Duration = Duration::from_secs(60);
/// Distinct inputs kept at once (providers × accounts); older entries are dropped first.
const MAX_ENTRIES: usize = 64;

static CACHE: LazyLock<LaunchProbeCache> = LazyLock::new(LaunchProbeCache::default);

/// The detection a session launch uses: a recent still-valid one when there is one (see the
/// module documentation), otherwise a full probe (shared with concurrent identical launches).
/// Explicit checks (the Providers page, Provider Health) keep calling [`detect`] directly.
pub fn detect_for_launch(
    spec: &DetectionSpec,
    env: &DetectEnv,
    guardian: Option<&ProviderProbeGuardian>,
) -> Detected {
    CACHE.detect(
        spec,
        env,
        guardian.is_some(),
        LAUNCH_REUSE_TTL,
        || match guardian {
            Some(guardian) => detect_guarded(spec, env, guardian),
            None => detect(spec, env),
        },
    )
}

/// Drops every reusable launch detection of `provider_id`, and keeps a probe already running
/// for it from being reused. Called when a session fails to start and when a running session
/// reports an authentication error.
pub fn forget(provider_id: &str) {
    CACHE.forget(provider_id);
}

/// Drops every reusable launch detection of the provider executable at `executable`. Called
/// when that executable is checked explicitly (the Providers page, Provider Health's re-check),
/// so the next launch reflects the same state the check shows.
pub fn forget_executable(executable: &Path) {
    CACHE.forget_executable(executable);
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Everything a detection result depends on.
#[derive(Clone, PartialEq, Eq, Hash)]
struct Key {
    provider_id: &'static str,
    spec: String,
    vars: Vec<(OsString, OsString)>,
    windows: bool,
    probe_timeout: Option<Duration>,
    system_root: Option<PathBuf>,
    guarded: bool,
}

impl Key {
    fn new(spec: &DetectionSpec, env: &DetectEnv, guarded: bool) -> Self {
        Self {
            provider_id: spec.provider_id,
            spec: format!("{spec:?}"),
            vars: env.vars.clone(),
            windows: env.windows,
            probe_timeout: env.probe_timeout,
            system_root: env.system_root.clone(),
            guarded,
        }
    }
}

/// Cheap identity of one file: no process, one metadata read.
#[derive(Debug, Clone, PartialEq, Eq)]
struct FileStamp {
    path: PathBuf,
    len: u64,
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
}

impl FileStamp {
    fn of(path: &Path) -> Option<Self> {
        let metadata = std::fs::metadata(path).ok().filter(|m| m.is_file())?;
        Some(Self {
            path: path.to_path_buf(),
            len: metadata.len(),
            modified: metadata.modified().ok(),
            created: metadata.created().ok(),
        })
    }
}

/// The executable plus what starting it actually runs (a shim's target, `node` and the script).
/// `None` when any of them is missing.
fn stamps(exe: &Path, spec: &DetectionSpec, env: &DetectEnv) -> Option<Vec<FileStamp>> {
    let launch = crate::launch::resolve(exe, &env.provider_env(&spec.env_policy));
    let mut files = vec![exe.to_path_buf()];
    if launch.program != exe {
        files.push(launch.program);
    }
    files.extend(
        launch
            .prefix_args
            .iter()
            .map(PathBuf::from)
            .filter(|p| p.is_absolute() && p.is_file()),
    );
    files.iter().map(|path| FileStamp::of(path)).collect()
}

/// A session can start with this result (everything else is probed again on every launch).
fn launchable(detected: &Detected) -> bool {
    detected.detection.state == DetectionState::Installed
        && detected.detection.auth != AuthState::NotAuthenticated
        && detected.executable.is_some()
}

struct Reusable {
    detected: Detected,
    /// When the probe that produced it started.
    probed_at: Instant,
    stamps: Vec<FileStamp>,
}

impl Reusable {
    fn still_valid(&self, spec: &DetectionSpec, env: &DetectEnv, ttl: Duration) -> bool {
        let Some(exe) = self.detected.executable.as_deref() else {
            return false;
        };
        self.probed_at.elapsed() < ttl
            && env.resolve_executable_only(spec).as_deref() == Some(exe)
            && stamps(exe, spec, env).as_ref() == Some(&self.stamps)
    }
}

/// One probe in progress; identical launches wait for it instead of probing again.
#[derive(Default)]
struct Flight {
    /// `None` while running; `Some(None)` when the probe was abandoned (it panicked).
    result: Mutex<Option<Option<Detected>>>,
    done: Condvar,
    waiters: AtomicUsize,
}

impl Flight {
    fn finish(&self, result: Option<Detected>) {
        *lock(&self.result) = Some(result);
        self.done.notify_all();
    }

    fn wait(&self) -> Option<Detected> {
        self.waiters.fetch_add(1, Ordering::SeqCst);
        let mut result = lock(&self.result);
        while result.is_none() {
            result = self
                .done
                .wait(result)
                .unwrap_or_else(PoisonError::into_inner);
        }
        result.clone().flatten()
    }
}

enum Slot {
    Ready(Arc<Reusable>),
    Probing(Arc<Flight>),
}

#[derive(Default)]
struct State {
    slots: HashMap<Key, Slot>,
    /// Bumped by [`LaunchProbeCache::forget`]; a probe started before is not kept.
    epochs: HashMap<String, u64>,
}

impl State {
    fn epoch(&self, provider_id: &str) -> u64 {
        self.epochs.get(provider_id).copied().unwrap_or(0)
    }

    fn remove_if_same(&mut self, key: &Key, same: impl Fn(&Slot) -> bool) {
        if self.slots.get(key).is_some_and(same) {
            self.slots.remove(key);
        }
    }

    fn prune(&mut self, ttl: Duration) {
        if self.slots.len() <= MAX_ENTRIES {
            return;
        }
        self.slots.retain(|_, slot| match slot {
            Slot::Ready(cached) => cached.probed_at.elapsed() < ttl,
            Slot::Probing(_) => true,
        });
        if self.slots.len() > MAX_ENTRIES {
            self.slots
                .retain(|_, slot| matches!(slot, Slot::Probing(_)));
        }
    }
}

#[derive(Default)]
pub(crate) struct LaunchProbeCache {
    state: Mutex<State>,
}

/// Abandons the flight if the probe unwinds, so waiters probe themselves instead of hanging.
struct Leader<'a> {
    cache: &'a LaunchProbeCache,
    key: &'a Key,
    flight: Arc<Flight>,
    finished: bool,
}

impl Drop for Leader<'_> {
    fn drop(&mut self) {
        if !self.finished {
            lock(&self.cache.state).remove_if_same(
                self.key,
                |s| matches!(s, Slot::Probing(f) if Arc::ptr_eq(f, &self.flight)),
            );
            self.flight.finish(None);
        }
    }
}

impl LaunchProbeCache {
    fn detect(
        &self,
        spec: &DetectionSpec,
        env: &DetectEnv,
        guarded: bool,
        ttl: Duration,
        probe: impl FnOnce() -> Detected,
    ) -> Detected {
        let key = Key::new(spec, env, guarded);
        loop {
            let mut state = lock(&self.state);
            match state.slots.get(&key) {
                Some(Slot::Probing(flight)) => {
                    let flight = Arc::clone(flight);
                    drop(state);
                    return match flight.wait() {
                        Some(detected) => {
                            tracing::info!(
                                event = "provider.launch_detection_shared",
                                provider_id = spec.provider_id
                            );
                            detected
                        }
                        None => probe(),
                    };
                }
                Some(Slot::Ready(cached)) => {
                    let cached = Arc::clone(cached);
                    drop(state);
                    if cached.still_valid(spec, env, ttl) {
                        tracing::info!(
                            event = "provider.launch_detection_reused",
                            provider_id = spec.provider_id,
                            age_ms = u64::try_from(cached.probed_at.elapsed().as_millis())
                                .unwrap_or(u64::MAX)
                        );
                        return cached.detected.clone();
                    }
                    lock(&self.state).remove_if_same(
                        &key,
                        |s| matches!(s, Slot::Ready(c) if Arc::ptr_eq(c, &cached)),
                    );
                }
                None => {
                    let flight = Arc::new(Flight::default());
                    state
                        .slots
                        .insert(key.clone(), Slot::Probing(Arc::clone(&flight)));
                    let epoch = state.epoch(spec.provider_id);
                    state.prune(ttl);
                    drop(state);
                    return self.lead(&key, flight, epoch, spec, env, probe);
                }
            }
        }
    }

    fn lead(
        &self,
        key: &Key,
        flight: Arc<Flight>,
        epoch: u64,
        spec: &DetectionSpec,
        env: &DetectEnv,
        probe: impl FnOnce() -> Detected,
    ) -> Detected {
        let mut leader = Leader {
            cache: self,
            key,
            flight,
            finished: false,
        };
        let probed_at = Instant::now();
        // Stamped before probing: a binary replaced during the probe never matches later.
        let before = env
            .resolve_executable_only(spec)
            .and_then(|exe| stamps(&exe, spec, env).map(|stamps| (exe, stamps)));
        let detected = probe();
        let reusable = before
            .filter(|(exe, _)| {
                launchable(&detected) && detected.executable.as_deref() == Some(exe.as_path())
            })
            .map(|(_, stamps)| Reusable {
                detected: detected.clone(),
                probed_at,
                stamps,
            });
        {
            let mut state = lock(&self.state);
            state.remove_if_same(
                key,
                |s| matches!(s, Slot::Probing(f) if Arc::ptr_eq(f, &leader.flight)),
            );
            if let Some(reusable) = reusable
                && state.epoch(spec.provider_id) == epoch
            {
                state
                    .slots
                    .insert(key.clone(), Slot::Ready(Arc::new(reusable)));
            }
        }
        leader.flight.finish(Some(detected.clone()));
        leader.finished = true;
        detected
    }

    fn forget(&self, provider_id: &str) {
        let mut state = lock(&self.state);
        *state.epochs.entry(provider_id.to_owned()).or_default() += 1;
        state
            .slots
            .retain(|key, slot| key.provider_id != provider_id || matches!(slot, Slot::Probing(_)));
    }

    fn forget_executable(&self, executable: &Path) {
        lock(&self.state).slots.retain(|_, slot| match slot {
            Slot::Ready(cached) => cached.detected.executable.as_deref() != Some(executable),
            Slot::Probing(_) => true,
        });
    }

    #[cfg(test)]
    fn waiters(&self) -> usize {
        lock(&self.state)
            .slots
            .values()
            .map(|slot| match slot {
                Slot::Probing(flight) => flight.waiters.load(Ordering::SeqCst),
                Slot::Ready(_) => 0,
            })
            .sum()
    }
}

#[cfg(test)]
#[path = "launch_probe_tests.rs"]
mod tests;
