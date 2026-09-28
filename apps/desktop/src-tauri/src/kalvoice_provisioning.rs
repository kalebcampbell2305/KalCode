//! Zero-setup provisioning of KalVoice's default components (campaign ZS-Z1).
//!
//! After the runtime starts, KalCode fetches the default speech model (`tiny.en`) and then,
//! once a speech model is ready, the local-intelligence pair, each through the same signed
//! catalog and verified acquisition pipeline as a manual download (catalog signature, rollback
//! floor, per-component signature, size and SHA-256), under system-granted consent recorded as
//! `automatic_default`. Nothing already installed is fetched again. Every download waits for
//! Resource Governor admission and yields to push to talk (in the component manager).
//!
//! The owner stays in charge: removing or cancelling a speech model stores an opt-out, local
//! intelligence has its own "prepare automatically" preference and a Pause that survives restarts.
//! A transient failure is never final: the next attempt follows on a bounded exponential backoff
//! (1, 5, 15, 60 minutes, then hourly), or at once when KalCode comes back to the front. A
//! permanent one (an unsupported system, a component that fails verification, missing consent)
//! stops automatic attempts until the next launch; the manual download stays available.

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use kalcode_kalvoice::models;
use kalcode_kalvoice::prefs::{KalVoicePreferences, KalVoicePreferencesPatch};
use kalcode_kalvoice::signals::{
    ComponentProvisioning, KalVoiceSignal, LocalReasoningStatus, ProvisioningPhase,
};
use tauri::AppHandle;

use super::{KalVoiceRuntime, KalVoiceState};
use crate::kalvoice_components::{
    ComponentManagerError, DownloadConsent, DownloadPhase, DownloadSnapshot, REASONING_DOWNLOAD_ID,
};

/// How often a driver waiting out its backoff looks for shutdown or a retry request.
const WAIT_SLICE: Duration = Duration::from_millis(200);
/// Progress-only updates are published at most this often; phase changes go out at once.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

/// The default components KalCode provisions on its own, in order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Component {
    Speech,
    Intelligence,
}

impl Component {
    pub(super) const fn model_id(self) -> &'static str {
        match self {
            Self::Speech => models::DEFAULT_MODEL,
            Self::Intelligence => REASONING_DOWNLOAD_ID,
        }
    }
}

/// The owner's stored provisioning choices.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Choices {
    /// The default speech model may be fetched automatically (no opt-out recorded).
    pub(super) speech: bool,
    /// "Prepare local intelligence automatically".
    pub(super) intelligence: bool,
    /// The owner paused the automatic local-intelligence download.
    pub(super) paused: bool,
}

/// What provisioning needs from the runtime.
pub(super) trait ProvisioningHost {
    /// The runtime is shutting down: stop at once.
    fn stopping(&self) -> bool;
    fn choices(&self) -> Option<Choices>;
    /// Any speech model has a verified receipt (an installed model is always reused).
    fn speech_installed(&self) -> bool;
    fn reasoning_installed(&self) -> bool;
    /// Fetches one default component through the signed pipeline under automatic consent.
    fn download(&self, component: Component) -> Result<(), ComponentManagerError>;
    /// A component was installed: announce it and warm it.
    fn installed(&self, component: Component);
    /// Provisioning state changed: publish it.
    fn changed(&self);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stage {
    /// About to fetch (or fetching the signed catalog).
    Preparing,
    /// Local intelligence waits for the owner's Resume.
    Paused,
    /// The last attempt failed; the next starts at `at` (or when KalCode is focused).
    Retry { code: &'static str, at: Instant },
    /// A permanent failure: no automatic attempt until the next launch.
    Stopped { code: &'static str },
}

#[derive(Default)]
struct State {
    driving: bool,
    nudged: bool,
    failures: u32,
    current: Option<(Component, Stage)>,
    /// A component whose automatic provisioning stopped for good in this runtime, and why.
    stopped: Option<(Component, &'static str)>,
    /// The last published list and when, so progress is throttled but phases are not.
    published: Option<(Vec<ComponentProvisioning>, Instant)>,
}

enum Step {
    Download(Component),
    Paused,
    Idle,
}

pub(super) struct Provisioner {
    delay: fn(u32) -> Duration,
    state: Mutex<State>,
}

/// Clears `driving` if a driver unwinds, so a later request can start one.
struct Driving<'a>(&'a Provisioner);

impl Drop for Driving<'_> {
    fn drop(&mut self) {
        let mut state = self.0.lock();
        state.driving = false;
        state.nudged = false;
    }
}

impl Default for Provisioner {
    fn default() -> Self {
        Self::with_delay(super::reasoning::backoff_delay)
    }
}

impl Provisioner {
    pub(super) fn with_delay(delay: fn(u32) -> Duration) -> Self {
        Self {
            delay,
            state: Mutex::new(State::default()),
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Provisions whatever is missing, in order, until nothing is left, the owner's choices stop
    /// it, or the runtime shuts down. Blocking: runs on the runtime's retained background task.
    /// A call while a driver is running wakes that driver instead (also mid-backoff).
    pub(super) fn run(&self, host: &dyn ProvisioningHost) {
        {
            let mut state = self.lock();
            if state.driving {
                state.nudged = true;
                return;
            }
            state.driving = true;
        }
        let _driving = Driving(self);
        loop {
            if host.stopping() {
                return;
            }
            self.lock().nudged = false;
            let component = match self.next_step(host) {
                Step::Idle => {
                    self.set(None, host);
                    return;
                }
                Step::Paused => {
                    self.set(Some((Component::Intelligence, Stage::Paused)), host);
                    tracing::info!(event = "kalvoice.provisioning_paused");
                    return;
                }
                Step::Download(component) => component,
            };
            let stopped = self.lock().stopped;
            if let Some((_, code)) = stopped.filter(|(which, _)| *which == component) {
                self.set(Some((component, Stage::Stopped { code })), host);
                return;
            }
            self.set(Some((component, Stage::Preparing)), host);
            tracing::info!(
                event = "kalvoice.provisioning_started",
                component = component.model_id(),
                consent = DownloadConsent::AutomaticDefault.code()
            );
            match host.download(component) {
                Ok(()) => {
                    self.lock().failures = 0;
                    self.set(None, host);
                    tracing::info!(
                        event = "kalvoice.provisioning_installed",
                        component = component.model_id()
                    );
                    host.installed(component);
                }
                // The owner started the same download; its completion starts the next step.
                Err(ComponentManagerError::AlreadyDownloading) => {
                    self.set(None, host);
                    return;
                }
                Err(error) => {
                    if host.stopping() {
                        return;
                    }
                    // A pause or an opt-out cancelled it: follow the owner's new choice.
                    if error == ComponentManagerError::Cancelled
                        && !matches!(self.next_step(host), Step::Download(next) if next == component)
                    {
                        continue;
                    }
                    if let Some(code) = error.terminal_reason() {
                        self.lock().stopped = Some((component, code));
                        self.set(Some((component, Stage::Stopped { code })), host);
                        tracing::warn!(
                            event = "kalvoice.provisioning_stopped",
                            component = component.model_id(),
                            code,
                            cause = error.code()
                        );
                        return;
                    }
                    let round = {
                        let mut state = self.lock();
                        state.failures = state.failures.saturating_add(1);
                        state.failures
                    };
                    let delay = (self.delay)(round);
                    let code = error.code();
                    self.set(
                        Some((
                            component,
                            Stage::Retry {
                                code,
                                at: Instant::now() + delay,
                            },
                        )),
                        host,
                    );
                    tracing::warn!(
                        event = "kalvoice.provisioning_retry_scheduled",
                        component = component.model_id(),
                        code,
                        round,
                        delay_s = delay.as_secs()
                    );
                    if !self.sleep(delay, host) {
                        return;
                    }
                }
            }
        }
    }

    fn next_step(&self, host: &dyn ProvisioningHost) -> Step {
        let Some(choices) = host.choices() else {
            return Step::Idle;
        };
        if !host.speech_installed() {
            return if choices.speech {
                Step::Download(Component::Speech)
            } else {
                Step::Idle
            };
        }
        if !choices.intelligence || host.reasoning_installed() {
            return Step::Idle;
        }
        if choices.paused {
            return Step::Paused;
        }
        Step::Download(Component::Intelligence)
    }

    fn set(&self, current: Option<(Component, Stage)>, host: &dyn ProvisioningHost) {
        let changed = {
            let mut state = self.lock();
            std::mem::replace(&mut state.current, current) != current
        };
        if changed {
            host.changed();
        }
    }

    /// Waits out a backoff. `true`: run the next attempt (the delay elapsed or a retry was
    /// requested); `false`: the runtime is stopping.
    fn sleep(&self, delay: Duration, host: &dyn ProvisioningHost) -> bool {
        let deadline = Instant::now() + delay;
        loop {
            if host.stopping() {
                return false;
            }
            if std::mem::take(&mut self.lock().nudged) {
                tracing::info!(event = "kalvoice.provisioning_retry", trigger = "focus");
                return true;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                tracing::info!(event = "kalvoice.provisioning_retry", trigger = "backoff");
                return true;
            }
            std::thread::sleep(remaining.min(WAIT_SLICE));
        }
    }

    /// Asks a waiting driver to retry now (KalCode came back to the front).
    pub(super) fn nudge(&self) {
        self.lock().nudged = true;
    }

    /// Whether local intelligence is paused and waiting for the owner.
    #[cfg(test)]
    pub(super) fn paused(&self) -> bool {
        matches!(self.lock().current, Some((_, Stage::Paused)))
    }

    /// Everything pending or running, running downloads first (with their observed phase).
    /// `paused_bytes` (bytes on disk, total) is read only while local intelligence is paused.
    pub(super) fn snapshot(
        &self,
        downloads: &[DownloadSnapshot],
        paused_bytes: impl FnOnce() -> (u64, u64),
    ) -> Vec<ComponentProvisioning> {
        let mut items = downloads
            .iter()
            .map(|download| {
                let (phase, reason) = match download.phase {
                    DownloadPhase::Preparing => (ProvisioningPhase::Preparing, None),
                    DownloadPhase::WaitingForResources(reason) => {
                        (ProvisioningPhase::WaitingForResources, Some(reason))
                    }
                    DownloadPhase::WaitingForTalk => {
                        (ProvisioningPhase::WaitingForTalk, Some("push_to_talk"))
                    }
                    DownloadPhase::Downloading => (ProvisioningPhase::Downloading, None),
                    DownloadPhase::Verifying => (ProvisioningPhase::Verifying, None),
                };
                ComponentProvisioning {
                    model_id: download.model_id.clone(),
                    automatic: download.consent == DownloadConsent::AutomaticDefault,
                    phase,
                    received_bytes: download.received_bytes,
                    total_bytes: download.total_bytes,
                    reason: reason.map(str::to_owned),
                    retry_in_seconds: None,
                }
            })
            .collect::<Vec<_>>();
        let current = self.lock().current;
        if let Some((component, stage)) = current
            && !items
                .iter()
                .any(|item| item.model_id == component.model_id())
        {
            let (phase, received_bytes, total_bytes, reason, retry_in_seconds) = match stage {
                Stage::Preparing => (ProvisioningPhase::Preparing, 0, 0, None, None),
                Stage::Paused => {
                    let (received, total) = paused_bytes();
                    (ProvisioningPhase::Paused, received, total, None, None)
                }
                Stage::Stopped { code } => (ProvisioningPhase::Unavailable, 0, 0, Some(code), None),
                Stage::Retry { code, at } => {
                    let remaining = at.saturating_duration_since(Instant::now());
                    let seconds = remaining.as_secs() + u64::from(remaining.subsec_nanos() > 0);
                    (
                        ProvisioningPhase::RetryScheduled,
                        0,
                        0,
                        Some(code),
                        Some(seconds),
                    )
                }
            };
            items.push(ComponentProvisioning {
                model_id: component.model_id().to_owned(),
                automatic: true,
                phase,
                received_bytes,
                total_bytes,
                reason: reason.map(str::to_owned),
                retry_in_seconds,
            });
        }
        items
    }

    /// Whether `items` should be published now: always when a phase, reason or item changed,
    /// otherwise (bytes only) at most every [`PROGRESS_INTERVAL`].
    pub(super) fn should_publish(&self, items: &[ComponentProvisioning]) -> bool {
        let mut state = self.lock();
        let now = Instant::now();
        let publish = state.published.as_ref().is_none_or(|(last, at)| {
            let shape = |list: &[ComponentProvisioning]| {
                list.iter()
                    .map(|item| (item.model_id.clone(), item.phase, item.reason.clone()))
                    .collect::<Vec<_>>()
            };
            if shape(last) != shape(items) {
                return true;
            }
            last != items && now.duration_since(*at) >= PROGRESS_INTERVAL
        });
        if publish {
            state.published = Some((items.to_vec(), now));
        }
        publish
    }
}

// ---------------------------------------------------------------------------------------------
// The desktop runtime as the provisioning host.

/// The live runtime as the provisioning host.
struct RuntimeHost<'a>(&'a Arc<KalVoiceRuntime>);

impl ProvisioningHost for RuntimeHost<'_> {
    fn stopping(&self) -> bool {
        self.0.shutting_down.load(Ordering::SeqCst)
    }

    fn choices(&self) -> Option<Choices> {
        self.0
            .orchestrator
            .preferences()
            .ok()
            .map(|preferences| Choices {
                speech: preferences.speech_model_auto_download,
                intelligence: preferences.local_intelligence_auto,
                paused: preferences.local_intelligence_paused,
            })
    }

    fn speech_installed(&self) -> bool {
        self.0.components.speech_present()
    }

    fn reasoning_installed(&self) -> bool {
        self.0.components.reasoning_installed()
    }

    fn download(&self, component: Component) -> Result<(), ComponentManagerError> {
        // Progress reaches the UI through the manager's observer as `provisioning` signals.
        match component {
            Component::Speech => self.0.components.download_default_speech(|_, _| {}),
            Component::Intelligence => self.0.components.download_reasoning_automatic(|_, _| {}),
        }
    }

    fn installed(&self, component: Component) {
        self.0.signal(&KalVoiceSignal::ModelInstalled {
            model_id: component.model_id().to_owned(),
        });
        // Loads the new speech model or starts the new interpreter (and asks for the next step).
        super::keep_warm(self.0);
    }

    fn changed(&self) {
        publish(self.0);
    }
}

/// Starts (or wakes) provisioning on the runtime's retained background task.
pub(super) fn provision(runtime: &Arc<KalVoiceRuntime>) {
    let Some(task) = runtime.background.start() else {
        return;
    };
    let runtime = runtime.clone();
    let _ = std::thread::Builder::new()
        .name("kalvoice-provisioning".into())
        .spawn(move || {
            let _task = task;
            runtime.provisioning.run(&RuntimeHost(&runtime));
        });
}

/// Every pending or running component download, for status reads.
pub(super) fn items(runtime: &KalVoiceRuntime) -> Vec<ComponentProvisioning> {
    runtime
        .provisioning
        .snapshot(&runtime.components.download_snapshots(), || {
            runtime.components.reasoning_on_disk()
        })
}

/// Publishes the current list when it changed (progress-only changes are throttled).
pub(super) fn publish(runtime: &KalVoiceRuntime) {
    let items = items(runtime);
    if runtime.provisioning.should_publish(&items) {
        runtime.signal(&KalVoiceSignal::Provisioning { items });
    }
}

/// Wires the component manager to this runtime: downloads yield while the microphone is live,
/// and every phase or progress change is published.
pub(super) fn attach(runtime: &Arc<KalVoiceRuntime>) {
    let talk = Arc::downgrade(runtime);
    runtime.components.set_interactive_probe(Arc::new(move || {
        talk.upgrade()
            .is_some_and(|runtime| runtime.voice.listening().is_some())
    }));
    let observed = Arc::downgrade(runtime);
    runtime.components.set_observer(Arc::new(move || {
        if let Some(runtime) = observed.upgrade() {
            publish(&runtime);
        }
    }));
}

/// KalCode came back to the front: a waiting download or interpreter start retries now.
pub(super) fn focus_gained(app: &AppHandle) {
    let Ok(state) = crate::runtime_coordinator::RuntimeState::<KalVoiceState>::from_app(app) else {
        return;
    };
    let Some(runtime) = state.0.clone() else {
        return;
    };
    tauri::async_runtime::spawn_blocking(move || {
        runtime.provisioning.nudge();
        if runtime.reasoning.status() == LocalReasoningStatus::Failed {
            // Coalesces into the waiting driver, which retries at once.
            super::keep_warm(&runtime);
        }
    });
}

/// Applies a change to the provisioning preferences: a pause (or turning automatic preparation
/// off) stops an automatic local-intelligence download where it is; anything else asks the
/// driver for the next step.
pub(super) fn preferences_changed(
    runtime: &Arc<KalVoiceRuntime>,
    before: &KalVoicePreferences,
    saved: &KalVoicePreferences,
) {
    let stop_intelligence = (saved.local_intelligence_paused && !before.local_intelligence_paused)
        || (!saved.local_intelligence_auto && before.local_intelligence_auto);
    if stop_intelligence && automatic_download(runtime, REASONING_DOWNLOAD_ID) {
        runtime.components.cancel(REASONING_DOWNLOAD_ID);
    }
    if saved.local_intelligence_paused != before.local_intelligence_paused
        || saved.local_intelligence_auto != before.local_intelligence_auto
        || saved.speech_model_auto_download != before.speech_model_auto_download
    {
        runtime.provisioning.nudge();
        provision(runtime);
        publish(runtime);
    }
}

fn automatic_download(runtime: &KalVoiceRuntime, model_id: &str) -> bool {
    runtime
        .components
        .download_snapshots()
        .iter()
        .any(|download| {
            download.model_id == model_id && download.consent == DownloadConsent::AutomaticDefault
        })
}

/// The owner cancels a download: a speech model they stopped is not fetched again on its own,
/// and cancelling the automatic local-intelligence download pauses it (Resume continues it).
/// Stored before the cancel reaches the download, so the driver sees the choice.
pub(super) fn before_cancel(runtime: &KalVoiceRuntime, model_id: &str) {
    let patch = if model_id == REASONING_DOWNLOAD_ID {
        if !automatic_download(runtime, model_id) {
            return;
        }
        KalVoicePreferencesPatch {
            local_intelligence_paused: Some(true),
            ..Default::default()
        }
    } else if models::find(model_id).is_some() {
        KalVoicePreferencesPatch {
            speech_model_auto_download: Some(false),
            ..Default::default()
        }
    } else {
        return;
    };
    store(runtime, &patch);
}

/// The owner removed a speech model: never fetch one again on its own (Settings keeps the
/// manual download).
pub(super) fn speech_removed(runtime: &KalVoiceRuntime) {
    store(
        runtime,
        &KalVoicePreferencesPatch {
            speech_model_auto_download: Some(false),
            ..Default::default()
        },
    );
}

fn store(runtime: &KalVoiceRuntime, patch: &KalVoicePreferencesPatch) {
    let unchanged = runtime.orchestrator.preferences().is_ok_and(|current| {
        patch
            .speech_model_auto_download
            .is_none_or(|value| value == current.speech_model_auto_download)
            && patch
                .local_intelligence_paused
                .is_none_or(|value| value == current.local_intelligence_paused)
    });
    if unchanged {
        return;
    }
    if let Err(error) = runtime.orchestrator.update_preferences(patch) {
        tracing::warn!(
            event = "kalvoice.provisioning_choice_not_saved",
            code = %error.code
        );
    }
}

#[cfg(test)]
#[path = "kalvoice_provisioning_driver_tests.rs"]
mod tests;
