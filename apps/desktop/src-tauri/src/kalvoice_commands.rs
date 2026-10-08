//! KalVoice in the desktop shell (campaign Z12): IPC commands, the push-to-talk key, the
//! listening lifecycle (streaming recognition, latency timings), speech model downloads,
//! spoken replies, and the runtime seams KalVoice drives.
//!
//! Push to talk: one key (F8 by default), registered through the official global-shortcut plugin
//! only while KalCode is the foreground app, so other apps keep the key. "Foreground" is the OS
//! fact (on Windows, the foreground window belongs to this process; elsewhere, a KalCode window
//! is key), not one webview's focus events, so focus moving into child views or KalCode's own
//! dialogs keeps the key. Every lifecycle transition reconciles the registration
//! ([`talk_key`]). Press opens the microphone; release finishes recognition. A release that
//! can't arrive (KalCode left the foreground while the key was held) and the two-minute
//! recording cap both finish the session.
//!
//! Runtimes KalVoice drives:
//! - [`DesktopExecutor`](crate::kalvoice_executor::DesktopExecutor): workspaces and terminals
//!   (Z1), threads and their status (Z3), pending approvals (Z4, read-only).
//! - Providers: [`DesktopProviders`] exposes connected-provider status and a dormant compatibility
//!   seam. KalVoice interpretation is local-only and never launches provider inference.
//! - Deterministic workspace and UI commands run directly through [`DesktopExecutor`]. Provider
//!   sessions keep their native permission experience for consequential operations; KalVoice
//!   does not create a second app-control approval layer.

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, LazyLock, Mutex, PoisonError};
use std::time::{Duration, Instant};

use kalcode_contracts::agent::{AgentProvider, LaunchOrigin, ProviderId, SessionConfig};
use kalcode_contracts::app::{FeatureId, SurfaceId};
use kalcode_contracts::kalvoice::{KalVoiceMode, KalVoiceOutcome};
use kalcode_contracts::permissions::PermissionMode;
use kalcode_contracts::provider_accounts::ProviderAccountScopes;
use kalcode_core::{AppInfo, Core, IpcError, KalError};
use kalcode_kalvoice::audio::MAX_RECORDING;
use kalcode_kalvoice::audio::MicrophoneSource;
use kalcode_kalvoice::component_store::ComponentLease;
use kalcode_kalvoice::latency::{LatencyLog, LatencySnapshot};
use kalcode_kalvoice::models::{self, SpeechModelInfo, SpeechModelState};
use kalcode_kalvoice::orchestrator::{
    CommandRequest, KalVoiceResponse, Orchestrator, ProviderChoice, ProviderDirectory,
    RequestStage, TalkRequest, TalkResponse, UiCommandRequest, UiDirective, provider_display_name,
};
use kalcode_kalvoice::prefs::{KalVoicePreferences, KalVoicePreferencesPatch};
use kalcode_kalvoice::shortcuts;
use kalcode_kalvoice::signals::{KalVoiceSignal, KalVoiceStatus, ListeningSession, ShortcutIssue};
use kalcode_kalvoice::speech_output::{SpeechOutput, spoken_text};
use kalcode_kalvoice::stt::{
    ENGINE_AVAILABLE, RecognitionVocabulary, RecognizerCache, SpeechRecognizer, SttError,
};
use kalcode_kalvoice::voice::{
    RecognizerSource, VoiceController, VoiceError, VoiceResult, VoiceStart,
};
use kalcode_providers::ProviderRegistry;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Webview};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

use crate::kalvoice_callbacks::{
    Announcement, Callbacks, DeliveryDone, OperationAnnouncer, delivery_allowed,
};
use crate::kalvoice_components::{
    ComponentManagerError, KalVoiceComponentManager, REASONING_DOWNLOAD_ID,
};
use crate::kalvoice_executor::feature_enabled;
use kalcode_kalvoice::signals::{LocalReasoningDownload, LocalReasoningStatus};
#[path = "kalvoice_reasoning.rs"]
mod reasoning;
use reasoning::DesktopLocalInterpreter;
// The reducer also owns shared session reset state; only Windows/macOS have Fn input adapters.
#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
#[path = "kalvoice_fn_key.rs"]
// Linux has no Fn adapter, so only the platform-independent gesture tests reach it there.
#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
mod fn_key;
#[cfg(target_os = "macos")]
#[path = "kalvoice_fn_macos.rs"]
mod fn_macos;
#[path = "kalvoice_provisioning.rs"]
mod provisioning;
#[path = "kalvoice_talk_key.rs"]
mod talk_key;
use fn_key::{Action as FnAction, FnGesture, SessionOwners, Source as PttSource};
use talk_key::{Held, KeyRegistry, RegisterError, Status, TalkPrefs, Unavailable};

/// The KalVoice signal channel of each subscribed webview (one per webview; a new subscription
/// replaces it). App-level state managed in `lib.rs`, not part of a runtime: KalVoice runtimes
/// are rebuilt per account generation (sign-in, restore, account change) on a background thread,
/// and a page usually subscribes once, possibly before the first runtime is published. Keeping
/// the channels here means every runtime generation reaches the same, already-subscribed UI.
/// Signals carry no generation tag: this relies on `runtime_coordinator` publishing a new
/// generation only after the previous runtime's `shutdown` settled its background threads
/// (`reconcile_retained_bundle` keeps an unclean bundle), so an old account's transcript can't
/// arrive after a new account's runtime is live. Relaxing that gating requires tagging signals.
#[derive(Default)]
pub struct KalVoiceSignals(Mutex<HashMap<String, Channel<KalVoiceSignal>>>);

impl KalVoiceSignals {
    fn subscribe(&self, webview: &str, channel: Channel<KalVoiceSignal>) {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(webview.to_owned(), channel);
    }

    /// A page (re)load: that page's callbacks are gone; its next subscription replaces this.
    /// Browser child webviews never subscribe, so their loads report `NotSubscribed`.
    fn unsubscribe(&self, webview: &str) -> Unsubscribed {
        let mut channels = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if channels.remove(webview).is_none() {
            Unsubscribed::NotSubscribed
        } else if channels.is_empty() {
            Unsubscribed::LastGone
        } else {
            Unsubscribed::OthersRemain
        }
    }

    /// Whether any page is subscribed (the talk key is held only then).
    fn connected(&self) -> bool {
        !self
            .0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_empty()
    }

    fn send(&self, signal: &KalVoiceSignal) {
        broadcast(
            &self.0.lock().unwrap_or_else(PoisonError::into_inner),
            signal,
        );
    }
}

/// What removing a webview's subscription changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Unsubscribed {
    /// That webview had no channel (a browser child view): nothing changed.
    NotSubscribed,
    /// Another page is still subscribed: the key and any session stay.
    OthersRemain,
    /// No page is subscribed any more: the key is released until one subscribes.
    LastGone,
}

/// Ends the session the reloading page was driving once no page is subscribed. Returns whether
/// one was ended.
///
/// Cancelled, not finished: finishing (as a foreground change does) exists so the UI can show
/// the transcript and run it through `kalvoice_talk`; here the page that would receive the
/// result is gone, so recognizing the audio would only produce a result nobody can act on.
/// Cancelling closes the microphone at once and discards the audio. Without this, a reload
/// while the key is held released the key, the key-up was never recognized, and the microphone
/// stayed open invisibly until the recording cap.
///
/// The session's interactive priority span ends with it, like every other discard: a span left
/// open kept agent and local-model starts waiting on a session that no longer exists.
fn end_orphaned_session(
    voice: &VoiceController,
    priority_spans: &Mutex<HashMap<String, kalcode_resources::InteractiveSpan>>,
    unsubscribed: Unsubscribed,
) -> bool {
    if unsubscribed != Unsubscribed::LastGone {
        return false;
    }
    let Some((session_id, mode)) = voice.listening() else {
        return false;
    };
    let ended = voice.cancel(Some(&session_id));
    if ended {
        priority_spans
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&session_id);
    }
    tracing::info!(
        event = "kalvoice.session_orphaned",
        mode = match mode {
            KalVoiceMode::Talk => "talk",
            KalVoiceMode::Dictation => "dictation",
            KalVoiceMode::Command => "command",
        },
        ended
    );
    ended
}

/// Tauri-managed state. `None` when the core failed to start or KalVoice is off in this
/// build channel (then no shortcut is registered and every command explains why).
pub struct KalVoiceState(pub Option<Arc<KalVoiceRuntime>>, &'static str);

impl kalcode_doctor::context::LocalVoiceSource for KalVoiceState {
    fn current(&self) -> kalcode_doctor::context::LocalVoiceState {
        use kalcode_doctor::context::LocalVoiceState as DoctorState;
        let Some(runtime) = &self.0 else {
            return DoctorState::Unavailable;
        };
        match runtime.reasoning.status() {
            LocalReasoningStatus::Ready => DoctorState::Ready,
            // A start pending on governor admission is on its way, like one already starting.
            LocalReasoningStatus::Warming | LocalReasoningStatus::Waiting => DoctorState::Warming,
            LocalReasoningStatus::Installed => DoctorState::Installed,
            LocalReasoningStatus::NotInstalled => DoctorState::NotInstalled,
            LocalReasoningStatus::Unavailable | LocalReasoningStatus::Failed => {
                DoctorState::Unavailable
            }
        }
    }
}

impl KalVoiceState {
    pub(crate) const fn unavailable(message: &'static str) -> Self {
        Self(None, message)
    }

    fn runtime(&self) -> Result<&Arc<KalVoiceRuntime>, IpcError> {
        self.0
            .as_ref()
            .ok_or_else(|| KalError::internal("kalvoice_unavailable", self.1).to_ipc())
    }

    /// Stops all KalVoice-owned work before an updater or application exit replaces binaries.
    /// Idempotent and bounded; `false` means a background operation did not quiesce in time.
    pub fn shutdown(&self, app: &AppHandle) -> bool {
        self.0
            .as_ref()
            .is_none_or(|runtime| runtime.shutdown(app, Duration::from_secs(5)))
    }

    /// KalCode Remote: runs a typed agent action through the orchestrator (claim and replay by
    /// request id, the executor's safety check, then the executor). Blocking; never metered.
    pub(crate) fn remote_intent(
        &self,
        request: CommandRequest,
        intent: kalcode_contracts::kalvoice::KalVoiceIntent,
    ) -> Result<KalVoiceResponse, IpcError> {
        self.runtime()?
            .orchestrator
            .handle_intent(request, intent)
            .map_err(to_ipc("remote_intent"))
    }

    /// KalCode Remote's `voice.command`: the device's transcript through the same pipeline as a
    /// typed command bar request. Blocking.
    pub(crate) fn remote_command(
        &self,
        request: CommandRequest,
    ) -> Result<KalVoiceResponse, IpcError> {
        let runtime = self.runtime()?;
        let response = runtime
            .orchestrator
            .handle(request)
            .map_err(to_ipc("remote_command"))?;
        synchronize_usage(runtime);
        Ok(response)
    }

    /// Tells the window what a Remote action changed, so it reconciles at once.
    pub(crate) fn remote_acted(
        &self,
        directive: Option<UiDirective>,
        closed_agent_ids: Vec<String>,
    ) {
        if let Some(runtime) = &self.0 {
            runtime.signal(&KalVoiceSignal::RemoteActed {
                directive,
                closed_agent_ids,
            });
        }
    }

    /// Live-only Operations callback sink. Durable completion details stay in Operations; this
    /// only schedules the concise optional spoken notification after a finish write commits.
    pub(crate) fn operation_announcer(&self) -> Option<OperationAnnouncer> {
        self.0
            .as_ref()?
            .callbacks
            .get()
            .map(Callbacks::operation_announcer)
    }
}

#[derive(Default)]
struct Registered {
    /// The push-to-talk key while it is registered (only while KalCode is the foreground app).
    talk: Option<Shortcut>,
    issues: Vec<ShortcutIssue>,
    /// The last talk-key preferences read successfully (enabled, accelerator), so one failed
    /// read never drops or skips a working key.
    prefs: Option<(bool, String)>,
    /// The key state last told to the UI (active, reason code, accelerator), so repeated
    /// transitions log and signal once per change.
    last: Option<(bool, Option<&'static str>, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PttStart {
    source: PttSource,
    generation: u64,
    voice: VoiceStart,
}

#[derive(Default)]
struct PushToTalkState {
    function: FnGesture,
    sessions: SessionOwners,
    pending: Option<PttStart>,
    generation: u64,
}

impl PushToTalkState {
    fn reserve_start(&mut self, source: PttSource, voice: VoiceStart) -> Option<PttStart> {
        if self.pending.is_some() {
            return None;
        }
        self.generation = self.generation.wrapping_add(1);
        let start = PttStart {
            source,
            generation: self.generation,
            voice,
        };
        self.pending = Some(start.clone());
        Some(start)
    }

    fn cancel_start(&mut self, source: PttSource) -> Option<PttStart> {
        if self
            .pending
            .as_ref()
            .is_some_and(|start| start.source == source)
        {
            self.pending.take()
        } else {
            None
        }
    }

    fn cancel_any_start(&mut self) -> Option<PttStart> {
        self.pending.take()
    }

    fn fail_start(&mut self, start: &PttStart) -> bool {
        if self.pending.as_ref() == Some(start) {
            self.pending = None;
            true
        } else {
            false
        }
    }

    fn promote_start(&mut self, start: &PttStart, session_id: String) -> bool {
        if !self.fail_start(start) {
            return false;
        }
        self.sessions.claim(start.source, session_id);
        true
    }
}

pub struct KalVoiceRuntime {
    providers: Arc<DesktopProviders>,
    orchestrator: Orchestrator,
    accounting: Arc<crate::kalvoice_accounting::AccountKalVoice>,
    voice: VoiceController,
    components: Arc<KalVoiceComponentManager>,
    reasoning: Arc<DesktopLocalInterpreter>,
    /// Zero-setup provisioning of the default speech model and local intelligence.
    provisioning: provisioning::Provisioner,
    recognizers: Arc<DesktopRecognizers>,
    /// The OS voice, started on first use.
    speech: std::sync::OnceLock<Arc<dyn SpeechOutput>>,
    /// Live lifecycle events and Operations completions, scoped to this account generation.
    callbacks: std::sync::OnceLock<Callbacks>,
    microphone_supported: bool,
    /// The app-level signal channels (shared by every runtime generation).
    signals: Arc<KalVoiceSignals>,
    shortcuts: Mutex<Registered>,
    /// Standalone Fn and fallback-key ownership share one lock so simultaneous presses cannot
    /// finish or cancel each other's recording.
    push_to_talk: Mutex<PushToTalkState>,
    shutting_down: AtomicBool,
    background: Arc<BackgroundTasks>,
    latency: LatencyLog,
    /// Push-to-talk priority: heavy background starts wait while a session listens or
    /// transcribes (bounded by the Resource Governor's gate).
    voice_priority: kalcode_resources::InteractivePriority,
    /// The open priority span of each session, by session id, until it is transcribed or
    /// discarded.
    priority_spans: Mutex<HashMap<String, kalcode_resources::InteractiveSpan>>,
}

#[derive(Default)]
struct BackgroundState {
    stopping: bool,
    active: usize,
}

#[derive(Default)]
struct BackgroundTasks {
    state: Mutex<BackgroundState>,
    settled: Condvar,
}

struct BackgroundTask {
    tasks: Arc<BackgroundTasks>,
}

impl BackgroundTasks {
    fn start(self: &Arc<Self>) -> Option<BackgroundTask> {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.stopping {
            return None;
        }
        state.active += 1;
        Some(BackgroundTask {
            tasks: Arc::clone(self),
        })
    }

    fn stop(&self) {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .stopping = true;
    }

    fn wait_until(&self, deadline: Instant) -> bool {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        while state.active != 0 {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            let (next, result) = self
                .settled
                .wait_timeout(state, remaining)
                .unwrap_or_else(PoisonError::into_inner);
            state = next;
            if result.timed_out() && state.active != 0 {
                return false;
            }
        }
        true
    }
}

impl Drop for BackgroundTask {
    fn drop(&mut self) {
        let mut state = self
            .tasks
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        state.active = state.active.saturating_sub(1);
        self.tasks.settled.notify_all();
    }
}

impl KalVoiceRuntime {
    fn speech(&self) -> &Arc<dyn SpeechOutput> {
        self.speech.get_or_init(speech_output)
    }

    fn signal(&self, signal: &KalVoiceSignal) {
        self.signals.send(signal);
    }

    /// A session started listening: heavy background starts wait until it is transcribed or
    /// discarded (each span stops deferring at its bound even if it is never closed).
    fn open_priority(&self, session_id: &str) {
        let mut spans = self
            .priority_spans
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        spans.retain(|_, span| !span.expired());
        spans.insert(session_id.to_owned(), self.voice_priority.begin());
    }

    /// The session's transcript is ready, or the session was discarded.
    fn close_priority(&self, session_id: &str) {
        self.priority_spans
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(session_id);
    }

    fn status(&self) -> Result<KalVoiceStatus, KalError> {
        let preferences = self.orchestrator.preferences()?;
        let active_model = self.recognizers.active_model(&preferences);
        let (local_reasoning, local_reasoning_issue) = self.reasoning.snapshot();
        let registered = self
            .shortcuts
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        Ok(KalVoiceStatus {
            usage: self.orchestrator.usage()?,
            preferences,
            models: self.components.speech_models(),
            local_reasoning: Some(local_reasoning),
            local_reasoning_issue: local_reasoning_issue.map(str::to_owned),
            active_model,
            speech_engine: ENGINE_AVAILABLE,
            microphone_supported: self.microphone_supported,
            voice_output_available: self.speech().available(),
            providers: self.providers.connected(),
            reserved_shortcuts: shortcuts::reserved(),
            talk_keys: shortcuts::allowed_keys(),
            talk_key_active: registered.talk.is_some(),
            shortcut_issues: registered.issues.clone(),
            listening: self
                .voice
                .listening()
                .map(|(session_id, mode)| ListeningSession { session_id, mode }),
            provisioning: Some(provisioning::items(self)),
        })
    }

    fn shutdown(self: &Arc<Self>, app: &AppHandle, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        self.shutting_down.store(true, Ordering::SeqCst);
        self.background.stop();
        self.accounting.stop();
        self.reasoning.seal();
        // Seal local inference immediately; retain its custody until the bounded drain below.
        let _ = self
            .orchestrator
            .shutdown_local_interpretation(Duration::ZERO);

        // Stop new shortcut events first: release the key on the main thread, where every
        // registration change is serialized (a later queued reconcile sees `shutting_down`).
        let released = sync_talk_key(app, self, "shutdown").is_some_and(|done| {
            done.recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .is_ok()
        });
        if !released {
            // Still queued: main-thread tasks run in order, so it releases the key before any
            // successor runtime's first reconcile registers it.
            tracing::warn!(event = "kalvoice.ptt_listener_release_pending");
        }

        reset_push_to_talk(self);
        self.voice.cancel(None);
        if let Some(callbacks) = self.callbacks.get() {
            callbacks.shutdown();
        }
        if let Some(speech) = self.speech.get() {
            speech.stop();
        }
        self.components.cancel_all();

        let downloads_settled = self
            .components
            .cancel_all_and_wait(deadline.saturating_duration_since(Instant::now()));
        let local_settled = self
            .orchestrator
            .shutdown_local_interpretation(deadline.saturating_duration_since(Instant::now()));
        let background_settled = self.background.wait_until(deadline);
        let reasoning_settled =
            background_settled && local_settled && self.reasoning.shutdown_reasoning(deadline);
        let settled = downloads_settled && background_settled && local_settled && reasoning_settled;
        if settled {
            self.recognizers.shutdown();
        } else {
            // Which owner kept KalVoice from stopping in time (an unclean exit names it).
            tracing::warn!(
                event = "kalvoice.shutdown_incomplete",
                downloads_settled,
                background_settled,
                local_settled,
                reasoning_settled,
            );
        }
        settled
    }
}

/// Picks the recognizer for the selected model, or another installed model.
struct DesktopRecognizers {
    core: Arc<Core>,
    threads: Option<Arc<kalcode_threads::ThreadRuntime>>,
    locator: Option<Arc<kalcode_locator::Locator>>,
    components: Arc<KalVoiceComponentManager>,
    cache: RecognizerCache,
    repository_vocabulary: Mutex<RecognitionVocabulary>,
    vocabulary: Mutex<Option<(Instant, RecognitionVocabulary)>>,
    /// The selected recognizer and its signed-store lease. Returned recognizer clones retain the
    /// same owner so deletion cannot remove or replace bytes during transcription.
    loaded: Mutex<Option<(String, Arc<LoadedRecognizer>)>>,
}

struct LoadedRecognizer {
    recognizer: Arc<dyn SpeechRecognizer>,
    path: std::path::PathBuf,
    _lease: ComponentLease,
}

struct LeasedRecognizer(Arc<LoadedRecognizer>);

impl SpeechRecognizer for LeasedRecognizer {
    fn configure_vocabulary(&self, vocabulary: &RecognitionVocabulary) {
        self.0.recognizer.configure_vocabulary(vocabulary);
    }

    fn transcribe(&self, audio: &[f32]) -> Result<String, SttError> {
        self.0.recognizer.transcribe(audio)
    }

    fn transcribe_cancellable(
        &self,
        audio: &[f32],
        cancel: &Arc<AtomicBool>,
    ) -> Result<String, SttError> {
        self.0.recognizer.transcribe_cancellable(audio, cancel)
    }
}

impl DesktopRecognizers {
    /// Refreshes recent repository path vocabulary through Locator's existing recent-work view.
    /// It runs only on KalCode's warm background thread, never in the push-to-talk latency path.
    fn refresh_repository_vocabulary(&self) {
        let Some(locator) = &self.locator else {
            return;
        };
        let page = kalcode_contracts::refs::PageRequest {
            limit: 100,
            cursor: None,
        };
        let Ok(recent) = locator.recent_work(kalcode_locator::RecentWorkWhen::ThisWeek, 0, &page)
        else {
            return;
        };
        let mut names = Vec::with_capacity(96);
        for item in recent.items {
            if item.kind != kalcode_locator::RecentWorkKind::File {
                continue;
            }
            let path = item.title.replace('\\', "/");
            names.push(path.clone());
            names.extend(
                path.split('/')
                    .filter(|part| !part.is_empty())
                    .rev()
                    .take(3)
                    .map(str::to_owned),
            );
            if names.len() >= 96 {
                names.truncate(96);
                break;
            }
        }
        *self
            .repository_vocabulary
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = RecognitionVocabulary::from_terms(names);
        // Force the next preparation to combine these names with the current live scene.
        *self
            .vocabulary
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = None;
    }

    /// Names already present in KalCode's live stores, cached briefly so beginning a take never
    /// walks a repository or performs network work. The recognizer itself ignores identical
    /// snapshots, so its decoder tokens change only when the scene vocabulary changes.
    fn vocabulary_snapshot(&self) -> RecognitionVocabulary {
        const CACHE_FOR: Duration = Duration::from_secs(1);
        let now = Instant::now();
        {
            let cached = self
                .vocabulary
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if let Some((captured_at, vocabulary)) = cached.as_ref()
                && now.saturating_duration_since(*captured_at) < CACHE_FOR
            {
                return vocabulary.clone();
            }
        }

        let mut names = Vec::with_capacity(128);
        if let Ok(Some(active)) = self.core.active_workspace() {
            names.push(active.name);
        }
        if let Some(threads) = &self.threads
            && let Ok(threads) = threads.list(None, false)
        {
            names.extend(threads.iter().take(12).map(|thread| thread.name.clone()));
            names.extend(
                threads
                    .iter()
                    .take(4)
                    .filter_map(|thread| thread.account_label.clone()),
            );
            names.extend(
                threads
                    .iter()
                    .take(4)
                    .filter_map(|thread| thread.model.clone()),
            );
            names.extend(
                threads
                    .iter()
                    .take(4)
                    .filter_map(|thread| thread.branch.clone()),
            );
        }
        names.extend(
            self.repository_vocabulary
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .terms()
                .iter()
                .cloned(),
        );
        if let Ok(terminals) = self.core.running_terminals() {
            names.extend(
                terminals
                    .into_iter()
                    .take(24)
                    .map(|terminal| terminal.title),
            );
        }
        if let Ok(workspaces) = self.core.workspaces() {
            names.extend(
                workspaces
                    .into_iter()
                    .take(24)
                    .map(|workspace| workspace.name),
            );
        }
        let vocabulary = RecognitionVocabulary::from_terms(names);
        *self
            .vocabulary
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some((now, vocabulary.clone()));
        vocabulary
    }

    fn active_model(&self, prefs: &KalVoicePreferences) -> Option<String> {
        let installed = self.components.speech_models();
        std::iter::once(prefs.speech_model.as_str())
            .chain(models::CATALOG.iter().map(|m| m.id))
            .find(|id| {
                installed.iter().any(|model| {
                    model.id == *id && matches!(model.state, SpeechModelState::Installed)
                })
            })
            .map(str::to_owned)
    }

    fn load_recognizer(&self) -> Result<Arc<dyn SpeechRecognizer>, SttError> {
        let prefs = self
            .core
            .read(kalcode_kalvoice::prefs::load)
            .map_err(|e| SttError::Failed(e.message))?;
        let id = self
            .active_model(&prefs)
            .ok_or(SttError::ModelNotInstalled)?;
        let vocabulary = self.vocabulary_snapshot();
        let mut loaded = self.loaded.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some((loaded_id, recognizer)) = loaded.as_ref()
            && loaded_id == &id
        {
            recognizer.recognizer.configure_vocabulary(&vocabulary);
            return Ok(Arc::new(LeasedRecognizer(Arc::clone(recognizer))));
        }

        let lease = self
            .components
            .acquire_speech(&id)
            .map_err(|error| SttError::ModelLoadFailed(error.to_string()))?;
        let path = lease
            .model_path()
            .ok_or_else(|| SttError::ModelLoadFailed("signed component is not a model".into()))?
            .to_owned();
        let english_only = models::find(&id).is_some_and(|model| model.english_only);
        let recognizer = self.cache.get(&path, english_only)?;
        recognizer.configure_vocabulary(&vocabulary);
        let recognizer = Arc::new(LoadedRecognizer {
            recognizer,
            path,
            _lease: lease,
        });
        *loaded = Some((id, Arc::clone(&recognizer)));
        Ok(Arc::new(LeasedRecognizer(recognizer)))
    }

    fn delete_model(&self, id: &str) -> Result<(), ComponentManagerError> {
        let mut loaded = self.loaded.lock().unwrap_or_else(PoisonError::into_inner);
        let active = if loaded
            .as_ref()
            .is_some_and(|(loaded_id, _)| loaded_id == id)
        {
            loaded.take().map(|(_, recognizer)| recognizer)
        } else {
            None
        };
        if let Some(recognizer) = active {
            self.cache.evict(&recognizer.path);
            drop(recognizer);
        }
        drop(loaded);
        self.components.delete_speech(id)
    }

    fn shutdown(&self) {
        let mut loaded = self.loaded.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some((_, recognizer)) = loaded.take() {
            self.cache.evict(&recognizer.path);
            drop(recognizer);
        }
    }
}

impl RecognizerSource for DesktopRecognizers {
    fn ready(&self) -> Result<(), SttError> {
        self.prepare().map(|_| ())
    }

    fn prepare(&self) -> Result<Arc<dyn SpeechRecognizer>, SttError> {
        if !ENGINE_AVAILABLE {
            return Err(SttError::EngineUnavailable);
        }
        self.load_recognizer()
    }

    fn recognizer(&self) -> Result<Arc<dyn SpeechRecognizer>, SttError> {
        self.load_recognizer()
    }
}

/// The user's providers, from the provider runtime's cached detection. The local-only
/// orchestrator reads connection status but never calls the legacy session factory below.
pub struct DesktopProviders {
    registry: Arc<ProviderRegistry>,
    runtime: crate::provider_auth_commands::ProviderRuntimeAuthority,
    reasoning_dir: std::path::PathBuf,
    ensure_providers: Option<crate::kalvoice_executor::ProviderReadiness>,
}

impl DesktopProviders {
    fn ensure_ready(&self) {
        ensure_provider_directory_ready(&self.registry, self.ensure_providers.as_ref());
    }
}

fn ensure_provider_directory_ready(
    registry: &ProviderRegistry,
    ensure_providers: Option<&crate::kalvoice_executor::ProviderReadiness>,
) {
    if let Some(ensure) = ensure_providers {
        ensure(None);
    } else if registry.list().iter().all(|s| s.detection.is_none()) {
        // First use before the Providers page ran detection: read-only version and sign-in
        // checks (or the startup check already running, without a second one).
        let _ = registry.detect_all_once();
    }
}

fn provider_choice_availability(
    status: &kalcode_providers::ProviderStatus,
    launchable: &[ProviderId],
) -> Option<bool> {
    (status.adapter == kalcode_providers::AdapterState::Implemented)
        .then(|| launchable.contains(&status.id))
}

impl ProviderDirectory for DesktopProviders {
    fn connected(&self) -> Vec<ProviderChoice> {
        self.ensure_ready();
        let usable = self.registry.usable();
        let accounts = self.runtime.account_store();
        self.registry
            .list()
            .into_iter()
            .filter_map(|s| {
                let available = provider_choice_availability(&s, &usable)?;
                let _account = accounts
                    .resolve(s.id.as_str(), &ProviderAccountScopes::default())
                    .ok()
                    .flatten()?;
                Some(ProviderChoice {
                    available,
                    display_name: provider_display_name(&s.id),
                    id: s.id,
                })
            })
            .collect()
    }

    fn provider(&self, _id: &ProviderId) -> Option<Arc<dyn AgentProvider>> {
        // The legacy split API cannot bind a provider and account atomically.
        None
    }

    fn session_config(
        &self,
        request_id: &str,
        workspace_id: Option<&str>,
    ) -> Option<SessionConfig> {
        let _ = (request_id, workspace_id);
        // The legacy split API cannot identify which provider account belongs in the config.
        None
    }

    fn provider_session(
        &self,
        id: &ProviderId,
        request_id: &str,
        workspace_id: Option<&str>,
    ) -> Option<(Arc<dyn AgentProvider>, SessionConfig)> {
        // Compatibility for older native consumers only. KalVoice's current local-only
        // orchestrator never calls this method and a stored provider preference cannot reach it.
        self.ensure_ready();
        if !self.registry.usable().contains(id) {
            return None;
        }
        let scopes = ProviderAccountScopes {
            workspace_id: workspace_id.map(str::to_owned),
            ..ProviderAccountScopes::default()
        };
        let account = self
            .runtime
            .account_store()
            .resolve(id.as_str(), &scopes)
            .ok()??;
        self.runtime.prepare_account_launch(id, &account.id).ok()?;
        let provider = self
            .runtime
            .managed_headless_provider(id, &account.id)
            .ok()?;
        std::fs::create_dir_all(&self.reasoning_dir).ok()?;
        let config = account_bound_session_config(
            request_id,
            workspace_id,
            &self.reasoning_dir,
            &account.id,
        );
        Some((provider, config))
    }
}

fn account_bound_session_config(
    request_id: &str,
    workspace_id: Option<&str>,
    reasoning_dir: &std::path::Path,
    account_id: &str,
) -> SessionConfig {
    SessionConfig {
        thread_id: request_id.to_owned(),
        provider_account_id: Some(account_id.to_owned()),
        workspace_id: workspace_id.unwrap_or_default().to_owned(),
        working_directory: reasoning_dir.to_string_lossy().into_owned(),
        model: None,
        effort: None,
        permission_mode: PermissionMode::Plan,
        resume_session_id: None,
        secret_ref: None,
        // KalVoice reasoning answers the person's own request.
        launch_origin: LaunchOrigin::User,
    }
}

pub(crate) fn surface_label(surface: SurfaceId) -> &'static str {
    match surface {
        SurfaceId::Dashboard => "the Dashboard",
        SurfaceId::KalVoice => "KalVoice",
        SurfaceId::Code => "Code",
        SurfaceId::Threads => "Threads",
        SurfaceId::Agents => "Agents",
        SurfaceId::Missions => "Missions",
        SurfaceId::Automations => "Automations",
        SurfaceId::Skills => "Skills",
        SurfaceId::Plugins => "Plugins",
        SurfaceId::Memory => "Memory",
        SurfaceId::Providers => "Providers",
        SurfaceId::Settings => "Settings",
        SurfaceId::CommandCenter => "the Command Center",
        SurfaceId::Operations => "Operations",
    }
}

fn speech_output() -> Arc<dyn SpeechOutput> {
    #[cfg(any(windows, target_os = "macos"))]
    {
        Arc::new(kalcode_kalvoice::speech_output::OsSpeech::start())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        Arc::new(kalcode_kalvoice::speech_output::Silent)
    }
}

/// Native services assembled by the account-owned coordinator.
pub struct KalVoiceServices {
    pub memory: Option<Arc<crate::unified_memory_commands::MemoryService>>,
    pub registry: Arc<ProviderRegistry>,
    pub provider_runtime: crate::provider_auth_commands::ProviderRuntimeAuthority,
    pub threads: Option<Arc<kalcode_threads::ThreadRuntime>>,
    /// Refreshes detected adapters; selected launches may also share provider startup readiness.
    pub ensure_providers: Option<crate::kalvoice_executor::ProviderReadiness>,
    pub permissions: Option<Arc<kalcode_permissions::PermissionService>>,
    pub locator: Option<Arc<kalcode_locator::Locator>>,
    pub components: Arc<KalVoiceComponentManager>,
    pub resources: Arc<crate::resource_commands::ResourceGovernorState>,
    pub account: Arc<crate::account::runtime::AccountRuntime>,
}

/// Builds the KalVoice runtime over the workspace, thread and permission runtimes and registers
/// the push-to-talk key.
pub fn init(
    app: &AppHandle,
    core: Option<Arc<Core>>,
    info: &AppInfo,
    services: KalVoiceServices,
) -> KalVoiceState {
    let KalVoiceServices {
        memory,
        registry,
        provider_runtime,
        threads,
        ensure_providers,
        permissions,
        locator,
        components,
        resources,
        account,
    } = services;
    let enabled = info.flags.surfaces.iter().any(|s| {
        s.id == SurfaceId::KalVoice
            && s.visible
            && s.state != kalcode_core::flags::SurfaceState::Gated
    });
    if !enabled {
        return KalVoiceState(None, "KalVoice isn't enabled in this build.");
    }
    let Some(core) = core else {
        return KalVoiceState(
            None,
            "KalVoice isn't available because KalCode's runtime didn't start.",
        );
    };
    let launcher = provider_runtime.probe_guardian().ok().map(|guardian| {
        Arc::new(crate::kalvoice_guardian::KalVoiceGuardianLauncher::new(
            guardian,
        ))
    });
    let voice_priority = resources.interactive().clone();
    let reasoning = DesktopLocalInterpreter::new(components.clone(), resources, launcher);
    let providers = Arc::new(DesktopProviders {
        registry,
        runtime: provider_runtime.clone(),
        reasoning_dir: core.paths().data_dir.join("kalvoice").join("reasoning"),
        ensure_providers: ensure_providers.clone(),
    });
    let session_locator_enabled = feature_enabled(&info.flags, FeatureId::SessionLocator);
    let recognizers = Arc::new(DesktopRecognizers {
        core: core.clone(),
        threads: threads.clone(),
        locator: locator.clone().filter(|_| session_locator_enabled),
        components: components.clone(),
        cache: RecognizerCache::default(),
        repository_vocabulary: Mutex::new(RecognitionVocabulary::default()),
        vocabulary: Mutex::new(None),
        loaded: Mutex::new(None),
    });
    let callback_threads = threads.clone();
    let visible = info
        .flags
        .surfaces
        .iter()
        .filter(|s| s.visible)
        .map(|s| s.id)
        .collect();
    let Ok(accounting) =
        crate::kalvoice_accounting::AccountKalVoice::new(core.clone(), account.clone())
    else {
        return KalVoiceState(None, "KalVoice Requests need a verified KalCode account.");
    };
    let orchestrator = Orchestrator::new_accounted(
        core.clone(),
        accounting.clone(),
        Arc::new(crate::kalvoice_executor::DesktopExecutor {
            memory,
            visible,
            session_locator_enabled,
            core: core.clone(),
            account: Some(account),
            threads,
            ensure_providers,
            cursor_models: Some(Arc::new(move |account_id| {
                let account_id = account_id.ok_or_else(|| {
                    kalcode_kalvoice::orchestrator::ExecError::new(
                        "cursor_session_expired",
                        "Connect Cursor in Accounts before choosing a model.",
                    )
                })?;
                provider_runtime.cursor_models(account_id).map_err(|error| {
                    use kalcode_contracts::agent::ProviderError;
                    use kalcode_kalvoice::orchestrator::ExecError;
                    match error {
                        ProviderError::Refused { code, message } => ExecError::new(code, message),
                        ProviderError::NotAuthenticated => ExecError::new(
                            "cursor_session_expired",
                            "Cursor session expired. Reconnect Cursor in Accounts.",
                        ),
                        ProviderError::NotInstalled => ExecError::new(
                            "cursor_not_installed",
                            "Cursor integration is not installed. Set up Cursor in Providers.",
                        ),
                        error => ExecError::new("cursor_models_unavailable", error.to_string()),
                    }
                })
            })),
            permissions,
            // A gated Session Locator is never read by voice (it still runs for other callers).
            locator: locator.filter(|_| session_locator_enabled),
        }),
    )
    .with_local_interpreter(reasoning.clone());
    let voice = VoiceController::new(
        core.clone(),
        Arc::new(MicrophoneSource),
        recognizers.clone(),
    );
    #[cfg(not(windows))]
    seed_window_focus(app);
    let runtime = Arc::new(KalVoiceRuntime {
        providers,
        orchestrator,
        accounting,
        voice,
        components,
        reasoning,
        provisioning: provisioning::Provisioner::default(),
        recognizers,
        speech: std::sync::OnceLock::new(),
        callbacks: std::sync::OnceLock::new(),
        microphone_supported: cfg!(any(windows, target_os = "macos")),
        signals: app
            .try_state::<Arc<KalVoiceSignals>>()
            .map_or_else(Arc::default, |signals| signals.inner().clone()),
        shortcuts: Mutex::new(Registered::default()),
        push_to_talk: Mutex::new(PushToTalkState::default()),
        shutting_down: AtomicBool::new(false),
        background: Arc::new(BackgroundTasks::default()),
        latency: LatencyLog::new(200),
        voice_priority,
        priority_spans: Mutex::new(HashMap::new()),
    });
    let callback_runtime = Arc::downgrade(&runtime);
    let callback_speaker = Arc::new(move |announcement: Announcement, done: DeliveryDone| {
        if let Some(runtime) = callback_runtime.upgrade() {
            speak_callback(&runtime, announcement, done)
        } else {
            false
        }
    });
    if let Some(callbacks) = Callbacks::start(core.clone(), callback_threads, callback_speaker) {
        let _ = runtime.callbacks.set(callbacks);
    }
    // Live partial transcripts go to the UI as ghost text.
    let partial_runtime = Arc::downgrade(&runtime);
    runtime
        .voice
        .set_partial_notifier(Arc::new(move |session_id: &str, text: &str| {
            if let Some(runtime) = partial_runtime.upgrade() {
                runtime.signal(&KalVoiceSignal::Partial {
                    session_id: session_id.to_owned(),
                    text: text.to_owned(),
                });
            }
        }));
    provisioning::attach(&runtime);
    sync_talk_key(app, &runtime, "runtime_started");
    keep_warm(&runtime);
    synchronize_usage(&runtime);
    KalVoiceState(Some(runtime), "")
}

fn parse_shortcut(accelerator: &str) -> Option<Shortcut> {
    Shortcut::from_str(accelerator).ok()
}

fn synchronize_usage(runtime: &Arc<KalVoiceRuntime>) {
    let Some(task) = runtime.background.start() else {
        return;
    };
    let runtime = runtime.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _task = task;
        runtime.accounting.synchronize();
    });
}

/// A local interpreter status transition as a signal.
fn reasoning_signal(status: LocalReasoningStatus, issue: Option<&'static str>) -> KalVoiceSignal {
    KalVoiceSignal::LocalReasoningStatus {
        status,
        issue: issue.map(str::to_owned),
    }
}

/// The local interpreter's current state, for a page that subscribes after a transition was
/// published (each transition is published once, as it happens).
fn current_reasoning_signal(reasoning: &DesktopLocalInterpreter) -> KalVoiceSignal {
    let (status, issue) = reasoning.snapshot();
    reasoning_signal(status, issue)
}

/// Loads the speech model in the background so the first key press doesn't wait for it, then
/// drives the installed local interpreter to ready, publishing each status transition. The
/// interpreter keeps a held start pending until the Resource Governor admits it. Also starts (or
/// wakes) zero-setup provisioning of whatever default component is still missing.
fn keep_warm(runtime: &Arc<KalVoiceRuntime>) {
    provisioning::provision(runtime);
    let Some(task) = runtime.background.start() else {
        return;
    };
    let runtime = runtime.clone();
    let _ = std::thread::Builder::new()
        .name("kalvoice-warm".into())
        .spawn(move || {
            let _task = task;
            runtime.recognizers.refresh_repository_vocabulary();
            let started = Instant::now();
            match runtime.voice.warm() {
                Ok(()) => tracing::info!(
                    event = "kalvoice.model_warm",
                    load_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
                ),
                Err(error) => {
                    tracing::info!(event = "kalvoice.model_not_warm", code = error.code())
                }
            }
            if runtime
                .orchestrator
                .preferences()
                .is_ok_and(|preferences| preferences.voice_replies)
            {
                let _ = runtime.speech().available();
            }
            runtime
                .reasoning
                .autostart(&|status, issue| runtime.signal(&reasoning_signal(status, issue)));
        });
}

// ---------------------------------------------------------------------------------------------
// Push-to-talk key lifecycle

/// Each KalCode window's last reported focus, recorded from app start so a runtime built later
/// knows the current state. The foreground source on macOS and Linux, where a window's focus is
/// its key status and child webviews never take it.
static WINDOW_FOCUS: LazyLock<Mutex<HashMap<String, bool>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Window events for every KalCode window (wired in `lib.rs`). A focus change anywhere is a
/// trigger to re-derive the foreground state; on Windows the event's own value is not trusted,
/// because WebView2 focus moves between child views without KalCode leaving the foreground.
pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    match event {
        tauri::WindowEvent::Focused(focused) => {
            WINDOW_FOCUS
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(window.label().to_owned(), *focused);
            foreground_changed(window.app_handle(), "window_focus");
            if *focused {
                provisioning::focus_gained(window.app_handle());
            }
        }
        tauri::WindowEvent::Destroyed => {
            WINDOW_FOCUS
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(window.label());
        }
        _ => {}
    }
}

/// A trusted page started (re)loading: its signal callbacks are gone until it subscribes again.
/// Without a subscriber the key is released until the page subscribes again.
pub fn on_page_load_started(app: &AppHandle, webview: &str) {
    let Some(signals) = app.try_state::<Arc<KalVoiceSignals>>() else {
        return;
    };
    // Browser child navigations (never subscribed) and other pages staying subscribed change
    // nothing: no main-thread preferences read, no "no subscriber" warnings.
    let unsubscribed = signals.unsubscribe(webview);
    if unsubscribed != Unsubscribed::LastGone {
        return;
    }
    let Some(runtime) = crate::runtime_coordinator::RuntimeState::<KalVoiceState>::from_app(app)
        .ok()
        .and_then(|state| state.0.clone())
    else {
        return;
    };
    reset_push_to_talk(&runtime);
    end_orphaned_session(&runtime.voice, &runtime.priority_spans, unsubscribed);
    // Queued rather than inline: this runs inside the webview's page-load callback.
    defer_talk_key_sync(app, &runtime, "unsubscribed");
}

/// A (re)loaded trusted page starts its KalVoice UI fresh: re-derive the key's state.
pub fn on_page_load(app: &AppHandle) {
    foreground_changed(app, "page_load");
}

/// Starts following OS foreground changes (Windows), so the key is registered when KalCode comes
/// to the front even if no webview reports a focus change, with a short poll that repairs any
/// missed change. Called once from `setup`.
pub fn watch_foreground(app: &AppHandle) {
    #[cfg(windows)]
    if !foreground::watch(app) {
        tracing::warn!(event = "kalvoice.foreground_watch_unavailable");
    }
    #[cfg(not(windows))]
    let _ = app;
}

/// Whether KalCode is the foreground app right now.
fn kalcode_foreground() -> bool {
    #[cfg(windows)]
    {
        foreground::is_ours()
    }
    #[cfg(not(windows))]
    {
        WINDOW_FOCUS
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .any(|focused| *focused)
    }
}

/// Records each window's current focus (called off the main thread at runtime start; accurate on
/// macOS, where a window's focus is its key status).
#[cfg(not(windows))]
fn seed_window_focus(app: &AppHandle) {
    let current: Vec<(String, bool)> = app
        .windows()
        .into_iter()
        .map(|(label, window)| (label, window.is_focused().unwrap_or(false)))
        .collect();
    let mut focus = WINDOW_FOCUS.lock().unwrap_or_else(PoisonError::into_inner);
    for (label, focused) in current {
        if focused {
            focus.insert(label, true);
        } else {
            focus.entry(label).or_insert(false);
        }
    }
}

/// KalCode entered or left the foreground (or may have): finish a held session whose key-up
/// could now be missed, then reconcile the key for the current runtime.
fn foreground_changed(app: &AppHandle, trigger: &'static str) {
    let Ok(state) = crate::runtime_coordinator::RuntimeState::<KalVoiceState>::from_app(app) else {
        return;
    };
    let Some(runtime) = state.0.clone() else {
        return;
    };
    if !kalcode_foreground() {
        // Reset under the same lock the hold timer uses before inspecting the microphone. This
        // linearizes focus loss before a pending timer can open it.
        reset_push_to_talk(&runtime);
        if let Some((id, mode)) = runtime.voice.listening() {
            let announced = runtime
                .priority_spans
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .contains_key(&id);
            if announced {
                // The key-up may go to another app: finish with what was said so far.
                finish_listening(runtime.clone(), id, mode);
            } else {
                // A slow direct start committed before its UI announcement. Focus loss must
                // discard it, not publish Transcribing for a take the page never accepted.
                runtime.voice.cancel(Some(&id));
            }
        }
    }
    sync_talk_key(app, &runtime, trigger);
}

fn reset_push_to_talk(runtime: &KalVoiceRuntime) {
    reset_capture_source(&runtime.push_to_talk, &runtime.voice);
}

fn reset_capture_source(source: &Mutex<PushToTalkState>, voice: &VoiceController) {
    let cancelled_start = {
        let mut push_to_talk = source.lock().unwrap_or_else(PoisonError::into_inner);
        let _ = push_to_talk.function.focus_lost();
        push_to_talk.sessions.clear();
        voice.cancel_pending_start();
        push_to_talk.cancel_any_start()
    };
    if let Some(start) = cancelled_start {
        voice.cancel_start(&start.voice);
    }
}

/// Reconciles the talk key on the main thread and returns a receiver for the result (it runs
/// inline when already on the main thread). Every registration change goes through here, so
/// changes are serialized on one thread and no KalVoice lock is held while waiting for the main
/// thread. `None` when the main thread no longer accepts work (exiting). Never call it from the
/// global-shortcut handler, where the plugin holds its own lock: use [`defer_talk_key_sync`].
fn sync_talk_key(
    app: &AppHandle,
    runtime: &Arc<KalVoiceRuntime>,
    trigger: &'static str,
) -> Option<std::sync::mpsc::Receiver<Status<Shortcut>>> {
    // After `RunEvent::Exit` (macOS `terminate:`) the main thread is blocked in the final cleanup,
    // so a queued reconcile would never run and waiting for it would spend the cleanup budget.
    if app
        .try_state::<crate::runtime_shutdown::ExitControl>()
        .is_some_and(|exit| exit.event_loop_ended())
    {
        return None;
    }
    let (done, result) = std::sync::mpsc::sync_channel(1);
    let handle = app.clone();
    let runtime = runtime.clone();
    app.run_on_main_thread(move || {
        let status = reconcile_talk_key(&handle, &runtime, trigger);
        let _ = done.send(status);
    })
    .ok()
    .map(|()| result)
}

/// Reconciles and waits for the result (off the main thread, holding no KalVoice lock).
fn settle_talk_key(app: &AppHandle, runtime: &Arc<KalVoiceRuntime>, trigger: &'static str) {
    if let Some(done) = sync_talk_key(app, runtime, trigger)
        && done.recv_timeout(Duration::from_secs(10)).is_err()
    {
        tracing::warn!(event = "kalvoice.ptt_listener_sync_pending", trigger);
    }
}

/// Queues a reconcile to run after the current (plugin) callback returns.
fn defer_talk_key_sync(app: &AppHandle, runtime: &Arc<KalVoiceRuntime>, trigger: &'static str) {
    let app = app.clone();
    let runtime = runtime.clone();
    tauri::async_runtime::spawn(async move {
        let _ = sync_talk_key(&app, &runtime, trigger);
    });
}

/// The global-shortcut plugin as the reconciler's registry.
struct PluginKeys<'a>(&'a tauri_plugin_global_shortcut::GlobalShortcut<tauri::Wry>);

impl KeyRegistry<Shortcut> for PluginKeys<'_> {
    fn register(&mut self, key: Shortcut) -> Result<(), RegisterError> {
        self.0.register(key).map_err(|error| match error {
            // The OS refused the key: on Windows "already registered"; on macOS the Carbon
            // registration failed, almost always because another app holds the key.
            tauri_plugin_global_shortcut::Error::GlobalHotkey(_) => RegisterError::InUse,
            _ => RegisterError::Failed,
        })
    }
    fn unregister(&mut self, key: Shortcut) -> Result<(), RegisterError> {
        self.0.unregister(key).map_err(|_| RegisterError::Failed)
    }
    fn holds(&self, key: Shortcut) -> bool {
        self.0.is_registered(key)
    }
}

/// Main thread only (see [`sync_talk_key`]). Brings the registration to match foreground,
/// preferences and lifecycle, records any issue for Settings, tells the UI when the key's state
/// changes, and logs each change with a reason code (never user content).
fn reconcile_talk_key(
    app: &AppHandle,
    runtime: &KalVoiceRuntime,
    trigger: &'static str,
) -> Status<Shortcut> {
    let foreground = kalcode_foreground();
    #[cfg(windows)]
    foreground::reconciled(foreground);
    let shutting_down = runtime.shutting_down.load(Ordering::SeqCst);
    let (prefs, mut held) = {
        // Serialize preference snapshots with saved admission, then release before plugin calls.
        let _ptt = runtime
            .push_to_talk
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let read = runtime.orchestrator.preferences();
        let mut registered = runtime
            .shortcuts
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        match &read {
            Ok(prefs) => registered.prefs = Some((prefs.talk_enabled, prefs.talk_key.clone())),
            Err(error) => {
                tracing::warn!(
                    event = "kalvoice.talk_key_prefs_unavailable",
                    code = error.code
                );
            }
        }
        (registered.prefs.clone(), registered.talk)
    };
    let want = talk_key::want(
        shutting_down,
        foreground,
        runtime.signals.connected(),
        prefs.as_ref().map(|(enabled, accelerator)| TalkPrefs {
            enabled: *enabled,
            key: parse_shortcut(accelerator),
        }),
    );
    if let talk_key::Want::Hold(key) = want
        && held != Some(key)
    {
        tracing::info!(event = "kalvoice.ptt_listener_install_started", trigger);
    }
    // The plugin runs inline here (main thread); no KalVoice lock is held across it.
    let outcome = talk_key::reconcile(&mut held, want, &mut PluginKeys(app.global_shortcut()));
    if outcome.released.is_some() {
        let reason = match outcome.result {
            Status::Idle(skip) => skip.code(),
            _ => "key_changed",
        };
        tracing::info!(event = "kalvoice.ptt_listener_disposed", reason, trigger);
    }
    let accelerator = prefs
        .as_ref()
        .map(|(_, accelerator)| accelerator.clone())
        .unwrap_or_default();
    let (active, reason) = match outcome.result {
        Status::Holding(_, change) => {
            if change != Held::Unchanged {
                tracing::info!(
                    event = "kalvoice.ptt_listener_installed",
                    change = if change == Held::Adopted {
                        "adopted"
                    } else {
                        "registered"
                    },
                    trigger
                );
            }
            (true, None)
        }
        Status::Idle(skip) => (false, Some(skip.code())),
        Status::Unavailable(Unavailable::Unparseable) => (false, Some("unparseable")),
        Status::Unavailable(_) => (false, Some("os_refused")),
    };
    let changed = {
        let mut registered = runtime
            .shortcuts
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        registered.talk = held;
        match outcome.result {
            Status::Holding(_, Held::Registered | Held::Adopted) => registered.issues.clear(),
            Status::Unavailable(reason) if reason != Unavailable::ReleaseFailed => {
                registered.issues = vec![ShortcutIssue {
                    mode: KalVoiceMode::Talk,
                    accelerator: accelerator.clone(),
                    message: if reason == Unavailable::Unparseable {
                        "KalCode couldn't read this key.".to_owned()
                    } else {
                        "Another app is using this key. Choose a different one.".to_owned()
                    },
                }];
            }
            _ => {}
        }
        let now = (active, reason, accelerator.clone());
        let changed = registered.last.as_ref() != Some(&now);
        registered.last = Some(now);
        changed
    };
    if changed {
        match outcome.result {
            Status::Idle(skip) => tracing::info!(
                event = "kalvoice.ptt_listener_skipped",
                skip_reason = skip.code(),
                trigger
            ),
            Status::Unavailable(unavailable) => tracing::warn!(
                event = "kalvoice.talk_key_unavailable",
                reason = unavailable.code(),
                trigger
            ),
            Status::Holding(..) => {}
        }
        runtime.signal(&KalVoiceSignal::TalkKey {
            active,
            reason: reason.map(str::to_owned),
            accelerator,
        });
    }
    outcome.result
}

#[cfg(windows)]
#[allow(unsafe_code)]
mod foreground {
    //! Windows foreground ownership: two read-only user32 queries, plus one out-of-context
    //! foreground-change notification and a thread timer (no DLL injection, no input hook, no
    //! other app's content; only whether the foreground window's process is this one).

    use std::ffi::c_void;
    use std::sync::OnceLock;

    use tauri::AppHandle;

    use super::talk_key::{FOREGROUND_POLL, ForegroundBasis};

    type Hwnd = *mut c_void;
    type WinEventHook = *mut c_void;
    type WinEventProc = unsafe extern "system" fn(WinEventHook, u32, Hwnd, i32, i32, u32, u32);
    type TimerProc = unsafe extern "system" fn(Hwnd, u32, usize, u32);

    const EVENT_SYSTEM_FOREGROUND: u32 = 0x0003;
    const WINEVENT_OUTOFCONTEXT: u32 = 0x0000;

    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetForegroundWindow() -> Hwnd;
        fn GetWindowThreadProcessId(window: Hwnd, process_id: *mut u32) -> u32;
        fn SetWinEventHook(
            event_min: u32,
            event_max: u32,
            module: *mut c_void,
            callback: Option<WinEventProc>,
            process_id: u32,
            thread_id: u32,
            flags: u32,
        ) -> WinEventHook;
        fn SetTimer(window: Hwnd, id: usize, elapse_ms: u32, callback: Option<TimerProc>) -> usize;
    }

    static APP: OnceLock<AppHandle> = OnceLock::new();
    /// What the talk key was last reconciled for; written by every reconcile, from any trigger.
    static BASIS: ForegroundBasis = ForegroundBasis::new();

    /// Whether the foreground window belongs to this process: the main window (whichever of
    /// its webviews or child views has focus) or one of KalCode's own dialogs.
    pub fn is_ours() -> bool {
        // SAFETY: takes no arguments and returns a handle value (possibly null) that is only
        // passed back to user32 below, never dereferenced.
        let window = unsafe { GetForegroundWindow() };
        if window.is_null() {
            return false;
        }
        let mut process_id = 0_u32;
        // SAFETY: `process_id` is a live local the call writes once; a stale window handle is
        // reported as process 0 rather than faulting.
        unsafe { GetWindowThreadProcessId(window, &raw mut process_id) };
        process_id == std::process::id()
    }

    /// Called by every reconcile with the foreground state it used.
    pub fn reconciled(foreground: bool) {
        BASIS.record(foreground);
    }

    /// Reconciles when KalCode's foreground state differs from what the key was last reconciled
    /// for. Foreground moves between other apps, and repeats, change nothing.
    fn check(trigger: &'static str) {
        if BASIS.stale(is_ours())
            && let Some(app) = APP.get()
        {
            super::foreground_changed(app, trigger);
        }
    }

    unsafe extern "system" fn on_foreground(
        _hook: WinEventHook,
        _event: u32,
        _window: Hwnd,
        _object: i32,
        _child: i32,
        _thread: u32,
        _time: u32,
    ) {
        check("os_foreground");
    }

    /// The level check behind the edges: a focus event or foreground notification that was
    /// missed, or delivered before the activation completed, is repaired within one interval.
    unsafe extern "system" fn on_poll(_window: Hwnd, _message: u32, _id: usize, _time: u32) {
        check("foreground_poll");
    }

    /// Installs the notification and the poll on the calling (main) thread, whose message loop
    /// delivers both.
    pub fn watch(app: &AppHandle) -> bool {
        if APP.set(app.clone()).is_err() {
            return true;
        }
        // SAFETY: `on_foreground` has the WINEVENTPROC signature and lives for the whole
        // process; no module handle is passed (out-of-context delivery on this thread), and the
        // hook stays installed until the process exits.
        let hook = unsafe {
            SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                std::ptr::null_mut(),
                Some(on_foreground),
                0,
                0,
                WINEVENT_OUTOFCONTEXT,
            )
        };
        let interval = u32::try_from(FOREGROUND_POLL.as_millis()).unwrap_or(u32::MAX);
        // SAFETY: a thread timer (no window) on this thread; `on_poll` has the TIMERPROC
        // signature and lives for the whole process, and the timer runs until the process exits.
        let timer = unsafe { SetTimer(std::ptr::null_mut(), 0, interval, Some(on_poll)) };
        !hook.is_null() && timer != 0
    }
}

#[derive(Debug, Clone, Copy)]
pub(super) enum FnInput {
    Down,
    Up,
    Other,
}

/// Installs the permission-free, in-app macOS flagsChanged monitor. Other platforms report Fn
/// only through an exact foreground WebView event and need no native observer.
pub fn install_fn_monitor(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    if !fn_macos::install(app) {
        tracing::warn!(event = "kalvoice.fn_monitor_unavailable");
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Removes the local monitor before AppKit's event loop exits.
pub fn remove_fn_monitor() {
    #[cfg(target_os = "macos")]
    fn_macos::remove();
}

fn ptt_capture_allowed(runtime: &KalVoiceRuntime) -> bool {
    !runtime.shutting_down.load(Ordering::SeqCst)
        && kalcode_foreground()
        && runtime.signals.connected()
        && runtime
            .shortcuts
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .prefs
            .as_ref()
            .is_some_and(|(enabled, _)| *enabled)
}

/// Called by the macOS local monitor and the Windows WebView's exact DOM `Fn` event. The adapter
/// passes no key identity or content for other keys; it reports only that a chord occurred.
#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
pub(super) fn on_fn_input(app: &AppHandle, input: FnInput) -> bool {
    let Ok(state) = crate::runtime_coordinator::RuntimeState::<KalVoiceState>::from_app(app) else {
        return false;
    };
    let Some(runtime) = state.0.clone() else {
        return false;
    };
    let now = Instant::now();
    let action = {
        let mut push_to_talk = runtime
            .push_to_talk
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        match input {
            FnInput::Down => {
                if !ptt_capture_allowed(&runtime) {
                    return false;
                }
                let occupied = runtime.voice.busy() || push_to_talk.pending.is_some();
                push_to_talk.function.down(now, occupied)
            }
            FnInput::Up => push_to_talk.function.up(now),
            FnInput::Other => push_to_talk.function.other_key(),
        }
    };
    match action {
        FnAction::Arm { generation } => arm_fn_hold(runtime, generation),
        FnAction::Finish | FnAction::Cancel => settle_fn_session(runtime, action, now),
        FnAction::None | FnAction::Start { .. } => {}
    }
    true
}

#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
fn arm_fn_hold(runtime: Arc<KalVoiceRuntime>, generation: u64) {
    let Some(task) = runtime.background.start() else {
        return;
    };
    let timer_runtime = runtime.clone();
    if std::thread::Builder::new()
        .name("kalvoice-fn-hold".into())
        .spawn(move || {
            let _task = task;
            std::thread::sleep(fn_key::HOLD_THRESHOLD);
            fn_hold_elapsed(&timer_runtime, generation);
        })
        .is_err()
    {
        runtime
            .push_to_talk
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .function
            .start_failed_or_blocked();
        tracing::warn!(event = "kalvoice.fn_timer_unavailable");
    }
}

#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
fn fn_hold_elapsed(runtime: &Arc<KalVoiceRuntime>, generation: u64) {
    let (start, pressed) = {
        let mut push_to_talk = runtime
            .push_to_talk
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let FnAction::Start { pressed } = push_to_talk.function.tick(generation) else {
            return;
        };
        // Admission and source reservation share the lifecycle-reset lock. The slow model/device
        // work begins only after this lock is released.
        if runtime.voice.busy() || !ptt_capture_allowed(runtime) {
            push_to_talk.function.start_failed_or_blocked();
            tracing::info!(
                event = "kalvoice.fn_ignored",
                reason = "already_listening_or_unavailable"
            );
            return;
        }
        let voice_start = match runtime.voice.reserve_start() {
            Ok(start) => start,
            Err(_) => {
                push_to_talk.function.start_failed_or_blocked();
                return;
            }
        };
        let Some(start) = push_to_talk.reserve_start(PttSource::Function, voice_start.clone())
        else {
            runtime.voice.abandon_start(&voice_start);
            push_to_talk.function.start_failed_or_blocked();
            return;
        };
        (start, pressed)
    };
    tracing::info!(event = "kalvoice.fn_down");
    runtime.signal(&KalVoiceSignal::Reveal);
    tracing::info!(event = "kalvoice.microphone_open_requested");
    spawn_ptt_start(runtime.clone(), start, pressed);
}

fn fail_ptt_start(runtime: &KalVoiceRuntime, start: PttStart) {
    let mut push_to_talk = runtime
        .push_to_talk
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    if push_to_talk.fail_start(&start) && start.source == PttSource::Function {
        push_to_talk.function.start_failed_or_blocked();
    }
}

fn abandon_ptt_start(runtime: &KalVoiceRuntime, start: PttStart) {
    runtime.voice.abandon_start(&start.voice);
    fail_ptt_start(runtime, start);
}

/// Releases the source reservation if the start worker unwinds, so push-to-talk keeps working.
struct SettlePttStartOnPanic {
    runtime: Arc<KalVoiceRuntime>,
    start: PttStart,
}

impl Drop for SettlePttStartOnPanic {
    fn drop(&mut self) {
        if std::thread::panicking() {
            abandon_ptt_start(&self.runtime, self.start.clone());
        }
    }
}

fn spawn_ptt_start(runtime: Arc<KalVoiceRuntime>, start: PttStart, pressed: Instant) {
    let Some(task) = runtime.background.start() else {
        abandon_ptt_start(&runtime, start);
        return;
    };
    let worker_runtime = runtime.clone();
    let worker_start = start.clone();
    if std::thread::Builder::new()
        .name("kalvoice-ptt-start".into())
        .spawn(move || {
            let _task = task;
            let _settle = SettlePttStartOnPanic {
                runtime: worker_runtime.clone(),
                start: worker_start.clone(),
            };
            run_ptt_start(&worker_runtime, worker_start, pressed);
        })
        .is_err()
    {
        abandon_ptt_start(&runtime, start);
        tracing::warn!(event = "kalvoice.ptt_start_thread_unavailable");
    }
}

fn run_ptt_start(runtime: &Arc<KalVoiceRuntime>, start: PttStart, pressed: Instant) {
    match begin_reserved_listening_at(
        runtime,
        start.voice.clone(),
        KalVoiceMode::Talk,
        false,
        pressed,
    ) {
        Ok(session_id) => {
            // Promotion and the started signal are one short source-lock transaction: release,
            // focus loss, and shutdown linearize entirely before or after it.
            let promoted = {
                let mut push_to_talk = runtime
                    .push_to_talk
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner);
                if push_to_talk.promote_start(&start, session_id.clone()) {
                    announce_listening_at(runtime, &session_id, KalVoiceMode::Talk, pressed);
                    true
                } else {
                    false
                }
            };
            if promoted {
                watchdog(runtime.clone(), session_id);
            } else {
                runtime.voice.cancel(Some(&session_id));
            }
        }
        Err(_) => fail_ptt_start(runtime, start),
    }
}

fn cancel_pending_ptt_start(
    state: &Mutex<PushToTalkState>,
    voice: &VoiceController,
    source: PttSource,
) -> bool {
    let cancelled = state
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .cancel_start(source);
    if let Some(start) = &cancelled {
        voice.cancel_start(&start.voice);
    }
    cancelled.is_some()
}

/// Snapshot the active session only after taking the source lock: a key-up may arrive while
/// key-down is still opening the microphone and has not recorded its session owner yet.
fn take_ptt_session(
    state: &Mutex<PushToTalkState>,
    voice: &VoiceController,
    source: PttSource,
) -> Option<(String, KalVoiceMode)> {
    let mut state = state.lock().unwrap_or_else(PoisonError::into_inner);
    let (id, mode) = voice.listening()?;
    state
        .sessions
        .take_if_current(source, Some(&id))
        .map(|id| (id, mode))
}

fn cancel_fn_capture(
    state: &mut PushToTalkState,
    voice: &VoiceController,
) -> Option<(String, KalVoiceMode)> {
    let _ = state.function.focus_lost();
    if let Some(start) = state.cancel_start(PttSource::Function) {
        voice.cancel_start(&start.voice);
        return None;
    }
    let (id, mode) = voice.listening()?;
    let owned = state
        .sessions
        .take_if_current(PttSource::Function, Some(&id))?;
    voice.cancel(Some(&owned)).then_some((owned, mode))
}

fn settle_fn_session(runtime: Arc<KalVoiceRuntime>, action: FnAction, at: Instant) {
    if cancel_pending_ptt_start(&runtime.push_to_talk, &runtime.voice, PttSource::Function) {
        return;
    }
    let Some((session_id, mode)) =
        take_ptt_session(&runtime.push_to_talk, &runtime.voice, PttSource::Function)
    else {
        return;
    };
    match action {
        FnAction::Finish => {
            tracing::info!(event = "kalvoice.fn_up");
            finish_listening_at(runtime, session_id, mode, at);
        }
        FnAction::Cancel => {
            let cancelled = runtime.voice.cancel(Some(&session_id));
            runtime.close_priority(&session_id);
            if cancelled {
                tracing::info!(event = "kalvoice.fn_chord_cancel");
                runtime.signal(&KalVoiceSignal::Cancelled { session_id, mode });
            }
        }
        FnAction::None | FnAction::Arm { .. } | FnAction::Start { .. } => {}
    }
}

/// Global shortcut handler (registered with the plugin in `lib.rs`): hold to talk. It runs inside
/// the plugin's callback (key-down on the main thread, key-up on a plugin thread), so it never
/// changes registration directly.
pub fn on_shortcut(app: &AppHandle, shortcut: &Shortcut, event: ShortcutEvent) {
    let pressed = Instant::now();
    let key_state = match event.state {
        ShortcutState::Pressed => "pressed",
        ShortcutState::Released => "released",
    };
    tracing::info!(event = "kalvoice.ptt_callback_received", state = key_state);
    let Ok(state) = crate::runtime_coordinator::RuntimeState::<KalVoiceState>::from_app(app) else {
        tracing::info!(
            event = "kalvoice.ptt_callback_ignored",
            reason = "runtime_not_ready"
        );
        return;
    };
    let Some(runtime) = state.0.clone() else {
        tracing::info!(
            event = "kalvoice.ptt_callback_ignored",
            reason = "kalvoice_unavailable"
        );
        return;
    };
    if runtime.shutting_down.load(Ordering::SeqCst) {
        tracing::info!(
            event = "kalvoice.ptt_callback_ignored",
            reason = "shutting_down"
        );
        return;
    }
    let is_talk = runtime
        .shortcuts
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .talk
        .as_ref()
        == Some(shortcut);
    if !is_talk {
        tracing::info!(
            event = "kalvoice.ptt_callback_ignored",
            reason = "not_talk_key"
        );
        return;
    }
    match event.state {
        ShortcutState::Pressed => {
            if !kalcode_foreground() {
                // A stale registration: give the key back to the foreground app.
                tracing::info!(
                    event = "kalvoice.ptt_callback_ignored",
                    reason = "not_focused"
                );
                defer_talk_key_sync(app, &runtime, "stale_key_press");
                return;
            }
            // The registered fallback itself is an Fn chord. Report it directly instead of
            // relying on AppKit or WebView event ordering, then cancel only an Fn-owned session.
            let fn_action = runtime
                .push_to_talk
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .function
                .other_key();
            if fn_action == FnAction::Cancel {
                settle_fn_session(runtime.clone(), fn_action, pressed);
            }
            let start = {
                let mut push_to_talk = runtime
                    .push_to_talk
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner);
                // Recheck after acquiring the lock used by lifecycle reset and Fn admission.
                if !ptt_capture_allowed(&runtime) || runtime.voice.busy() {
                    tracing::info!(
                        event = "kalvoice.ptt_callback_ignored",
                        reason = "already_listening_or_unavailable"
                    );
                    return;
                }
                let voice_start = match runtime.voice.reserve_start() {
                    Ok(start) => start,
                    Err(_) => {
                        tracing::info!(
                            event = "kalvoice.ptt_callback_ignored",
                            reason = "capture_lane_occupied"
                        );
                        return;
                    }
                };
                let Some(start) =
                    push_to_talk.reserve_start(PttSource::Fallback, voice_start.clone())
                else {
                    runtime.voice.abandon_start(&voice_start);
                    tracing::info!(
                        event = "kalvoice.ptt_callback_ignored",
                        reason = "start_pending"
                    );
                    return;
                };
                start
            };
            tracing::info!(event = "kalvoice.ptt_key_down");
            // Bring the widget back if it was hidden, before listening starts or fails, so the
            // listening state or the failure shows either way.
            runtime.signal(&KalVoiceSignal::Reveal);
            tracing::info!(event = "kalvoice.microphone_open_requested");
            spawn_ptt_start(runtime, start, pressed);
        }
        ShortcutState::Released => {
            tracing::info!(event = "kalvoice.ptt_key_up");
            if cancel_pending_ptt_start(&runtime.push_to_talk, &runtime.voice, PttSource::Fallback)
            {
                return;
            }
            if let Some((id, mode)) =
                take_ptt_session(&runtime.push_to_talk, &runtime.voice, PttSource::Fallback)
            {
                // `pressed` is when this callback saw the release: key-up timings start there.
                finish_listening_at(runtime, id, mode, pressed);
            } else {
                tracing::info!(
                    event = "kalvoice.ptt_callback_ignored",
                    reason = "not_fallback_session"
                );
            }
        }
    }
}

/// Finishes a session that is still open at the recording cap (a key-up that never came).
fn watchdog(runtime: Arc<KalVoiceRuntime>, session_id: String) {
    let Some(task) = runtime.background.start() else {
        return;
    };
    let _ = std::thread::Builder::new()
        .name("kalvoice-watchdog".into())
        .spawn(move || {
            let _task = task;
            loop {
                std::thread::sleep(Duration::from_millis(250));
                match runtime.voice.listening_for(&session_id) {
                    None => return,
                    Some(held) if held >= MAX_RECORDING => {
                        if let Some((id, mode)) = runtime.voice.listening() {
                            finish_listening(runtime.clone(), id, mode);
                        }
                        return;
                    }
                    Some(_) => {}
                }
            }
        });
}

fn start_listening(
    runtime: &Arc<KalVoiceRuntime>,
    mode: KalVoiceMode,
    quiet: bool,
) -> Result<String, VoiceError> {
    start_listening_at(runtime, mode, quiet, Instant::now())
}

fn start_listening_at(
    runtime: &Arc<KalVoiceRuntime>,
    mode: KalVoiceMode,
    quiet: bool,
    pressed: Instant,
) -> Result<String, VoiceError> {
    let session_id = begin_listening_at(runtime, mode, quiet, pressed)?;
    announce_current_session(
        &runtime.push_to_talk,
        &runtime.voice,
        &session_id,
        mode,
        || {
            !runtime.shutting_down.load(Ordering::SeqCst)
                && runtime.signals.connected()
                && kalcode_foreground()
        },
        || {
            announce_listening_at(runtime, &session_id, mode, pressed);
        },
    )?;
    Ok(session_id)
}

fn announce_current_session(
    source: &Mutex<PushToTalkState>,
    voice: &VoiceController,
    session_id: &str,
    mode: KalVoiceMode,
    allowed: impl FnOnce() -> bool,
    announce: impl FnOnce(),
) -> Result<(), VoiceError> {
    let _source = source.lock().unwrap_or_else(PoisonError::into_inner);
    if !allowed() {
        voice.cancel(Some(session_id));
        return Err(VoiceError::NotListening);
    }
    if voice.listening() != Some((session_id.to_owned(), mode)) {
        return Err(VoiceError::NotListening);
    }
    announce();
    Ok(())
}

/// Performs the potentially slow model/device preparation without publishing a UI listening
/// state. Push-to-talk promotes its exact source reservation before calling
/// [`announce_listening_at`], so a release that won the reservation race cannot be followed by a
/// late `ListeningStarted` signal.
fn begin_listening_at(
    runtime: &Arc<KalVoiceRuntime>,
    mode: KalVoiceMode,
    quiet: bool,
    pressed: Instant,
) -> Result<String, VoiceError> {
    let start = {
        let _source = runtime
            .push_to_talk
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if runtime.shutting_down.load(Ordering::SeqCst)
            || !runtime.signals.connected()
            || !kalcode_foreground()
        {
            return Err(VoiceError::NotListening);
        }
        runtime.voice.reserve_start()?
    };
    begin_reserved_listening_at(runtime, start, mode, quiet, pressed)
}

fn begin_reserved_listening_at(
    runtime: &Arc<KalVoiceRuntime>,
    start: VoiceStart,
    mode: KalVoiceMode,
    quiet: bool,
    pressed: Instant,
) -> Result<String, VoiceError> {
    if runtime.shutting_down.load(Ordering::SeqCst) {
        runtime.voice.abandon_start(&start);
        return Err(VoiceError::NotListening);
    }
    if let Some(speech) = runtime.speech.get() {
        speech.stop();
    }
    report_begin_result(
        runtime,
        mode,
        quiet,
        pressed,
        runtime.voice.begin_reserved_at(start, mode, pressed),
    )
}

fn report_begin_result(
    runtime: &Arc<KalVoiceRuntime>,
    mode: KalVoiceMode,
    quiet: bool,
    pressed: Instant,
    result: Result<String, VoiceError>,
) -> Result<String, VoiceError> {
    match result {
        Ok(session_id) => {
            let key_down_to_mic_ms =
                u64::try_from(pressed.elapsed().as_millis()).unwrap_or(u64::MAX);
            tracing::info!(
                event = "kalvoice.microphone_open_succeeded",
                key_down_to_mic_ms
            );
            tracing::info!(
                event = "kalvoice.latency_stage",
                stage = "mic_open",
                from = "ptt_down",
                ms = pressed.elapsed().as_secs_f64() * 1000.0
            );
            Ok(session_id)
        }
        Err(VoiceError::AlreadyListening) => {
            tracing::info!(
                event = "kalvoice.microphone_open_failed",
                code = VoiceError::AlreadyListening.code()
            );
            Err(VoiceError::AlreadyListening)
        }
        Err(VoiceError::NotListening) => {
            tracing::info!(event = "kalvoice.microphone_open_cancelled");
            Err(VoiceError::NotListening)
        }
        Err(error) => {
            tracing::info!(
                event = "kalvoice.microphone_open_failed",
                code = error.code()
            );
            if !quiet {
                runtime.signal(&KalVoiceSignal::ListeningFailed {
                    session_id: None,
                    mode,
                    code: error.code().to_owned(),
                    message: error.to_string(),
                });
            }
            Err(error)
        }
    }
}

fn announce_listening_at(
    runtime: &Arc<KalVoiceRuntime>,
    session_id: &str,
    mode: KalVoiceMode,
    _pressed: Instant,
) {
    runtime.open_priority(session_id);
    tracing::info!(event = "kalvoice.audio_capture_started");
    tracing::info!(event = "kalvoice.ptt_state_listening");
    runtime.signal(&KalVoiceSignal::ListeningStarted {
        session_id: session_id.to_owned(),
        mode,
    });
    stream_level(runtime.clone(), session_id.to_owned());
}

/// Sends the live input level (not audio) about 20 times a second while the session listens.
fn stream_level(runtime: Arc<KalVoiceRuntime>, session_id: String) {
    let Some(task) = runtime.background.start() else {
        return;
    };
    let _ = std::thread::Builder::new()
        .name("kalvoice-level".into())
        .spawn(move || {
            let _task = task;
            while let Some(level) = runtime.voice.level(&session_id) {
                runtime.signal(&KalVoiceSignal::Level {
                    session_id: session_id.clone(),
                    level,
                });
                std::thread::sleep(Duration::from_millis(50));
            }
        });
}

/// Stops the microphone and finishes recognition on a background thread; the transcript and
/// stage timings arrive as a signal.
fn finish_listening(runtime: Arc<KalVoiceRuntime>, session_id: String, mode: KalVoiceMode) {
    finish_listening_at(runtime, session_id, mode, Instant::now());
}

/// As [`finish_listening`], for a key released at `key_up`.
fn finish_listening_at(
    runtime: Arc<KalVoiceRuntime>,
    session_id: String,
    mode: KalVoiceMode,
    key_up: Instant,
) {
    let Some(task) = runtime.background.start() else {
        runtime.voice.cancel(Some(&session_id));
        runtime.close_priority(&session_id);
        return;
    };
    tracing::info!(event = "kalvoice.audio_capture_stop_requested");
    runtime.signal(&KalVoiceSignal::Transcribing {
        session_id: session_id.clone(),
        mode,
    });
    let fallback = (runtime.clone(), session_id.clone());
    let spawned = std::thread::Builder::new()
        .name("kalvoice-transcribe".into())
        .spawn(move || {
            let _task = task;
            // Ending stops the microphone, then recognizes what was captured.
            tracing::info!(event = "kalvoice.stt_started");
            let started = Instant::now();
            let ended = runtime.voice.end_timed_at(&session_id, key_up);
            runtime.close_priority(&session_id);
            let stt_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
            tracing::info!(event = "kalvoice.audio_capture_stopped");
            tracing::info!(event = "kalvoice.audio_capture_finalized");
            let signal = match ended {
                Ok(finished) => {
                    tracing::info!(event = "kalvoice.stt_completed", outcome = "ok", stt_ms);
                    let timings = &finished.timings;
                    tracing::info!(
                        event = "kalvoice.latency_stage",
                        stage = "transcript_ready",
                        from = "ptt_up",
                        ms = timings.key_up_to_final.unwrap_or_default(),
                        partial_reused = timings.final_source.as_deref() == Some("reused_partial"),
                        final_source = timings.final_source.as_deref().unwrap_or("unknown")
                    );
                    match &finished.result {
                        VoiceResult::Transcript { .. } => {
                            tracing::info!(event = "kalvoice.transcript_ready");
                        }
                        VoiceResult::NothingHeard { .. } => {
                            tracing::info!(event = "kalvoice.transcript_empty");
                        }
                    }
                    runtime.latency.record(finished.timings.clone());
                    KalVoiceSignal::Result {
                        result: finished.result,
                        timings: finished.timings,
                    }
                }
                Err(error) => {
                    tracing::info!(
                        event = "kalvoice.stt_completed",
                        outcome = "failed",
                        code = error.code(),
                        stt_ms
                    );
                    KalVoiceSignal::ListeningFailed {
                        session_id: Some(session_id),
                        mode,
                        code: error.code().to_owned(),
                        message: error.to_string(),
                    }
                }
            };
            runtime.signal(&signal);
        });
    if spawned.is_err() {
        // Never leave the session open (every later key press would be ignored as "already
        // listening" until the recording cap): discard it and say so.
        let (runtime, session_id) = fallback;
        tracing::warn!(event = "kalvoice.stt_thread_unavailable");
        runtime.voice.cancel(Some(&session_id));
        runtime.close_priority(&session_id);
        runtime.signal(&KalVoiceSignal::ListeningFailed {
            session_id: Some(session_id),
            mode,
            code: "listening_failed".to_owned(),
            message: "KalVoice couldn't finish listening. Try again.".to_owned(),
        });
    }
}

/// Sends a signal to every subscribed webview. A failed send keeps the channel: dropping it
/// would silently orphan that window's KalVoice UI (no listening state, transcript or error)
/// until it happened to subscribe again. A channel is replaced when its webview subscribes
/// again (every page load does).
fn broadcast(channels: &HashMap<String, Channel<KalVoiceSignal>>, signal: &KalVoiceSignal) {
    let kind = signal_kind(signal);
    let frequent = matches!(
        signal,
        KalVoiceSignal::Level { .. }
            | KalVoiceSignal::Partial { .. }
            | KalVoiceSignal::Provisioning { .. }
    );
    if channels.is_empty() && !frequent {
        tracing::warn!(
            event = "kalvoice.signal_dropped",
            kind,
            reason = "no_subscriber"
        );
    }
    for channel in channels.values() {
        if channel.send(signal.clone()).is_err() {
            tracing::warn!(
                event = "kalvoice.signal_dropped",
                kind,
                reason = "send_failed"
            );
        }
    }
}

/// A signal's kind for logs (its serialized `kind` tag; never its content).
fn signal_kind(signal: &KalVoiceSignal) -> &'static str {
    match signal {
        KalVoiceSignal::LocalReasoningStatus { .. } => "local_reasoning_status",
        KalVoiceSignal::ListeningStarted { .. } => "listening_started",
        KalVoiceSignal::Level { .. } => "level",
        KalVoiceSignal::Partial { .. } => "partial",
        KalVoiceSignal::Transcribing { .. } => "transcribing",
        KalVoiceSignal::Result { .. } => "result",
        KalVoiceSignal::ListeningFailed { .. } => "listening_failed",
        KalVoiceSignal::Cancelled { .. } => "cancelled",
        KalVoiceSignal::Reveal => "reveal",
        KalVoiceSignal::ModelProgress { .. } => "model_progress",
        KalVoiceSignal::ModelInstalled { .. } => "model_installed",
        KalVoiceSignal::ModelFailed { .. } => "model_failed",
        KalVoiceSignal::Provisioning { .. } => "provisioning",
        KalVoiceSignal::RequestStage { .. } => "request_stage",
        KalVoiceSignal::RequestResolved { .. } => "request_resolved",
        KalVoiceSignal::RemoteActed { .. } => "remote_acted",
        KalVoiceSignal::Speaking { .. } => "speaking",
        KalVoiceSignal::LifecycleCallback { .. } => "lifecycle_callback",
        KalVoiceSignal::TalkKey { .. } => "talk_key",
    }
}

fn to_ipc(command: &'static str) -> impl Fn(KalError) -> IpcError {
    move |e| e.log_and_convert(command)
}

fn voice_ipc(error: &VoiceError) -> IpcError {
    KalError::validation(
        match error {
            VoiceError::AlreadyListening => "already_listening",
            VoiceError::NotListening => "not_listening",
            _ => "listening_failed",
        },
        error.to_string(),
    )
    .to_ipc()
}

async fn blocking<T: Send + 'static>(
    access: crate::runtime_coordinator::RuntimeAccess,
    command: &'static str,
    work: impl FnOnce() -> Result<T, IpcError> + Send + 'static,
) -> Result<T, IpcError> {
    tauri::async_runtime::spawn_blocking(move || {
        access.revalidate()?;
        work()
    })
    .await
    .map_err(|e| {
        KalError::internal("kalvoice_interrupted", "KalVoice was interrupted.")
            .with_source(e)
            .log_and_convert(command)
    })?
}

// ---------------------------------------------------------------------------------------------
// IPC commands

/// Streams KalVoice signals to the calling webview (one channel per webview; replaced on
/// resubscribe).
///
/// Needs no running KalVoice runtime (the account guard still requires an active account): the
/// channel is app-level, so a page that subscribes before the runtime is published, or across a
/// runtime rebuild, still receives every signal.
#[tauri::command]
pub fn kalvoice_subscribe(
    app: AppHandle,
    webview: Webview,
    signals: tauri::State<'_, Arc<KalVoiceSignals>>,
    on_signal: Channel<KalVoiceSignal>,
) -> Result<(), IpcError> {
    signals.subscribe(webview.label(), on_signal);
    let runtime = crate::runtime_coordinator::RuntimeState::<KalVoiceState>::from_app(&app)
        .ok()
        .and_then(|state| state.0.clone());
    tracing::info!(
        event = "kalvoice.subscribed",
        runtime_ready = runtime.is_some()
    );
    if let Some(runtime) = runtime {
        // Tell the new subscriber the key's current state, re-derived now (a fresh page).
        runtime
            .shortcuts
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .last = None;
        sync_talk_key(&app, &runtime, "subscribe");
        // And the local interpreter's current state: a transition published before this page
        // subscribed (a warm that finished first) would otherwise never reach it.
        runtime.signal(&current_reasoning_signal(&runtime.reasoning));
    }
    Ok(())
}

#[tauri::command(async)]
pub fn kalvoice_status(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    app: AppHandle,
    state: crate::runtime_coordinator::RuntimeState<KalVoiceState>,
) -> Result<KalVoiceStatus, IpcError> {
    _runtime_access.revalidate()?;
    let runtime = state.runtime()?;
    // Re-derive the key too; a change arrives as a `talk_key` signal.
    sync_talk_key(&app, runtime, "status");
    runtime.status().map_err(to_ipc("kalvoice_status"))
}

/// Handles one command bar request. Spoken replies (when enabled) read the result aloud.
#[tauri::command]
pub async fn kalvoice_request(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<KalVoiceState>,
    request: CommandRequest,
) -> Result<KalVoiceResponse, IpcError> {
    _runtime_access.revalidate()?;
    let runtime = state.runtime()?.clone();
    blocking(_runtime_access, "kalvoice_request", move || {
        let request_id = request.request_id.clone();
        let stage_runtime = runtime.clone();
        let on_stage = move |stage: RequestStage| {
            stage_runtime.signal(&KalVoiceSignal::RequestStage {
                request_id: request_id.clone(),
                stage,
            });
        };
        let response = runtime
            .orchestrator
            .handle_with_stages(request, &on_stage)
            .map_err(to_ipc("kalvoice_request"))?;
        speak_reply(&runtime, &response);
        synchronize_usage(&runtime);
        Ok(response)
    })
    .await
}

/// Claims one KalVoice Request for a command the UI runs itself (KalTidy, Operations, scene
/// commands). The UI runs it only on a `completed` outcome.
#[tauri::command]
pub async fn kalvoice_meter_ui_command(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<KalVoiceState>,
    request: UiCommandRequest,
) -> Result<KalVoiceResponse, IpcError> {
    _runtime_access.revalidate()?;
    let runtime = state.runtime()?.clone();
    blocking(_runtime_access, "kalvoice_meter_ui_command", move || {
        let response = runtime
            .orchestrator
            .meter_ui_command(request)
            .map_err(to_ipc("kalvoice_meter_ui_command"))?;
        synchronize_usage(&runtime);
        Ok(response)
    })
    .await
}

/// Routes one push-to-talk utterance (command, dictation or request) and runs it.
#[tauri::command]
pub async fn kalvoice_talk(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<KalVoiceState>,
    request: TalkRequest,
) -> Result<TalkResponse, IpcError> {
    _runtime_access.revalidate()?;
    let runtime = state.runtime()?.clone();
    blocking(_runtime_access, "kalvoice_talk", move || {
        let request_id = request.request_id.clone();
        let stage_runtime = runtime.clone();
        let on_stage = move |stage: RequestStage| {
            stage_runtime.signal(&KalVoiceSignal::RequestStage {
                request_id: request_id.clone(),
                stage,
            });
        };
        tracing::info!(event = "kalvoice.command_route_started");
        let started = Instant::now();
        let talked = runtime.orchestrator.talk(request, &on_stage);
        let route_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        match &talked {
            Ok(talk) => {
                tracing::info!(
                    event = "kalvoice.command_route_matched",
                    route = match talk.route {
                        kalcode_contracts::kalvoice::TalkRoute::Command => "command",
                        kalcode_contracts::kalvoice::TalkRoute::Dictation => "dictation",
                        kalcode_contracts::kalvoice::TalkRoute::Request => "request",
                    }
                );
                tracing::info!(
                    event = "kalvoice.command_executed",
                    outcome = "ok",
                    route_ms
                );
            }
            Err(error) => tracing::info!(
                event = "kalvoice.command_executed",
                outcome = "failed",
                code = error.code,
                route_ms
            ),
        }
        let talked = talked.map_err(to_ipc("kalvoice_talk"))?;
        runtime.latency.record_recognized(talked.recognized_ms);
        runtime
            .latency
            .record_resolution(talked.intent_ms, talked.action_ms);
        if let Some(ms) = talked.intent_ms {
            tracing::info!(
                event = "kalvoice.latency_stage",
                stage = "intent_resolved",
                from = "route_decided",
                ms
            );
        }
        if let Some(ms) = talked.action_ms {
            tracing::info!(
                event = "kalvoice.latency_stage",
                stage = "action_started",
                from = "intent_resolved",
                ms
            );
        }
        if let Some(response) = &talked.response {
            speak_reply(&runtime, response);
            synchronize_usage(&runtime);
        }
        Ok(talked)
    })
    .await
}

/// "Type it instead": un-counts a spoken command the UI has undone. Returns whether it was
/// un-counted.
#[tauri::command(async)]
pub fn kalvoice_type_instead(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<KalVoiceState>,
    request_id: String,
) -> Result<bool, IpcError> {
    _runtime_access.revalidate()?;
    state
        .runtime()?
        .orchestrator
        .type_instead(&request_id)
        .map_err(|e| e.to_ipc())
}

/// Rolling latency percentiles and recent stage waterfalls (developer diagnostics).
#[tauri::command(async)]
pub fn kalvoice_latency(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<KalVoiceState>,
) -> Result<LatencySnapshot, IpcError> {
    _runtime_access.revalidate()?;
    Ok(state.runtime()?.latency.snapshot())
}

/// Records the last stage (command → visible action), measured in the UI.
#[tauri::command(async)]
pub fn kalvoice_latency_record(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<KalVoiceState>,
    action_ms: f64,
) -> Result<(), IpcError> {
    _runtime_access.revalidate()?;
    if !action_ms.is_finite() || !(0.0..=60_000.0).contains(&action_ms) {
        return Err(
            KalError::validation("invalid_latency", "That timing is out of range.").to_ipc(),
        );
    }
    state.runtime()?.latency.record_action(action_ms);
    Ok(())
}

fn speak_reply(runtime: &Arc<KalVoiceRuntime>, response: &KalVoiceResponse) {
    let enabled = runtime
        .orchestrator
        .preferences()
        .is_ok_and(|p| p.voice_replies);
    if !delivery_allowed(
        enabled,
        true,
        runtime.voice.listening().is_some(),
        runtime.shutting_down.load(Ordering::Acquire),
    ) || !runtime.speech().available()
    {
        return;
    }
    let text = match &response.outcome {
        KalVoiceOutcome::Completed { summary } => summary.clone(),
        KalVoiceOutcome::NeedsProvider { message } | KalVoiceOutcome::Failed { message, .. } => {
            message.clone()
        }
        KalVoiceOutcome::LimitReached { .. } => {
            "You've used this month's KalVoice Requests.".into()
        }
        KalVoiceOutcome::PermissionRequired { .. } => {
            "The provider session is waiting for permission. Review its native prompt.".into()
        }
    };
    let request_id = response.request_id.clone();
    let started_runtime = runtime.clone();
    let started_id = request_id.clone();
    let started = Box::new(move || {
        started_runtime
            .orchestrator
            .record_voice_output(&started_id, true);
        started_runtime.signal(&KalVoiceSignal::Speaking {
            request_id: started_id,
            active: true,
        });
    });
    let settled_runtime = runtime.clone();
    let settled_id = request_id;
    let settled = Box::new(move |did_start: bool| {
        if !did_start {
            return;
        }
        settled_runtime
            .orchestrator
            .record_voice_output(&settled_id, false);
        settled_runtime.signal(&KalVoiceSignal::Speaking {
            request_id: settled_id,
            active: false,
        });
    });
    let _ = runtime
        .speech()
        .speak(&spoken_text(&text), started, settled);
}

fn speak_callback(
    runtime: &Arc<KalVoiceRuntime>,
    announcement: Announcement,
    delivered: DeliveryDone,
) -> bool {
    let voice_replies = runtime
        .orchestrator
        .preferences()
        .is_ok_and(|preferences| preferences.voice_replies);
    if !delivery_allowed(
        voice_replies,
        true,
        runtime.voice.listening().is_some(),
        runtime.shutting_down.load(Ordering::Acquire),
    ) {
        return false;
    }
    // Do not initialize the native voice when spoken replies are disabled or the microphone is
    // active. OS speech starts lazily only for a callback that is actually eligible to play.
    if !runtime.speech().available() {
        return false;
    }
    let request_id = format!("lifecycle:{}", announcement.request_id);
    let started_runtime = runtime.clone();
    let started_id = request_id.clone();
    let started_class = announcement.class;
    let started_target_kind = announcement.target_kind;
    let started_target_id = announcement.target_id.clone();
    let started_workspace_id = announcement.workspace_id.clone();
    let started = Box::new(move || {
        if let (Some(target_kind), Some(target_id)) =
            (started_target_kind, started_target_id.as_ref())
        {
            started_runtime.signal(&KalVoiceSignal::LifecycleCallback {
                request_id: started_id.clone(),
                class: started_class,
                target_kind,
                target_id: target_id.clone(),
                workspace_id: started_workspace_id.clone(),
            });
        }
        tracing::info!(
            event = "kalvoice.lifecycle_callback_spoken",
            target_id = started_target_id.as_deref().unwrap_or(""),
            workspace_id = started_workspace_id.as_deref().unwrap_or("")
        );
        started_runtime.signal(&KalVoiceSignal::Speaking {
            request_id: started_id,
            active: true,
        });
    });
    let settled_runtime = runtime.clone();
    let settled_id = request_id;
    let settled = Box::new(move |did_start: bool| {
        if did_start {
            settled_runtime.signal(&KalVoiceSignal::Speaking {
                request_id: settled_id,
                active: false,
            });
        }
        delivered();
    });
    runtime
        .speech()
        .speak(&spoken_text(&announcement.text), started, settled)
        .is_ok()
}

/// Saves preferences. A new push-to-talk key is registered with the OS right away (while
/// KalCode has focus); if the OS refuses it, the previous key is restored and nothing is saved.
#[tauri::command]
pub async fn kalvoice_preferences_update(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    app: AppHandle,
    state: crate::runtime_coordinator::RuntimeState<KalVoiceState>,
    patch: KalVoicePreferencesPatch,
) -> Result<KalVoiceStatus, IpcError> {
    _runtime_access.revalidate()?;
    let runtime = state.runtime()?.clone();
    blocking(_runtime_access, "kalvoice_preferences_update", move || {
        let before = runtime
            .orchestrator
            .preferences()
            .map_err(to_ipc("kalvoice_preferences_update"))?;
        // Save and publish admission under the capture lock so a hold timer cannot start from
        // cached enabled preferences after this update commits. Never cancel a manual capture.
        let (saved, cancelled_fn) = {
            let mut ptt = runtime
                .push_to_talk
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            let saved = runtime
                .orchestrator
                .update_preferences(&patch)
                .map_err(|e| e.to_ipc())?;
            runtime
                .shortcuts
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .prefs = Some((saved.talk_enabled, saved.talk_key.clone()));
            let cancelled_fn = if saved.talk_enabled {
                None
            } else {
                cancel_fn_capture(&mut ptt, &runtime.voice)
            };
            (saved, cancelled_fn)
        };
        if let Some((session_id, mode)) = cancelled_fn {
            runtime.close_priority(&session_id);
            runtime.signal(&KalVoiceSignal::Cancelled { session_id, mode });
        }
        if saved.talk_key != before.talk_key || saved.talk_enabled != before.talk_enabled {
            settle_talk_key(&app, &runtime, "preferences");
            let refused = runtime
                .shortcuts
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .issues
                .iter()
                .any(|issue| issue.accelerator == saved.talk_key);
            if refused && saved.talk_key != before.talk_key {
                let _ = runtime
                    .orchestrator
                    .update_preferences(&KalVoicePreferencesPatch {
                        talk_key: Some(before.talk_key.clone()),
                        ..Default::default()
                    });
                settle_talk_key(&app, &runtime, "preferences_restored");
                return Err(KalError::validation(
                    "talk_key_in_use",
                    format!(
                        "{} is already used by another app. Choose a different key.",
                        shortcuts::display(&saved.talk_key)
                    ),
                )
                .to_ipc());
            }
        }
        if saved.speech_model != before.speech_model {
            keep_warm(&runtime);
        }
        provisioning::preferences_changed(&runtime, &before, &saved);
        runtime
            .status()
            .map_err(to_ipc("kalvoice_preferences_update"))
    })
    .await
}

/// A Windows WebView reports the standardized Fn event it actually received. Other platforms
/// return false because macOS uses the native flagsChanged monitor and Linux has no Fn adapter.
#[tauri::command(async)]
pub fn kalvoice_fn_input(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    app: AppHandle,
    input: String,
) -> Result<bool, IpcError> {
    _runtime_access.revalidate()?;
    let input = match input.as_str() {
        "down" => FnInput::Down,
        "up" => FnInput::Up,
        "other" => FnInput::Other,
        _ => {
            return Err(KalError::validation(
                "fn_input_invalid",
                "KalVoice received an invalid Fn transition.",
            )
            .to_ipc());
        }
    };
    #[cfg(windows)]
    {
        Ok(on_fn_input(&app, input))
    }
    #[cfg(not(windows))]
    {
        let _ = (app, input);
        Ok(false)
    }
}

/// Starts listening (the command bar's microphone button). Results arrive as signals.
#[tauri::command(async)]
pub fn kalvoice_listen_start(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<KalVoiceState>,
    mode: KalVoiceMode,
) -> Result<String, IpcError> {
    _runtime_access.revalidate()?;
    let runtime = state.runtime()?;
    let id = start_listening(runtime, mode, false).map_err(|e| voice_ipc(&e))?;
    // The same backstop as the push-to-talk key: a release the page never reports (a closed or
    // reloaded widget) still ends at the recording cap.
    watchdog(runtime.clone(), id.clone());
    Ok(id)
}

/// Stops listening and transcribes; the transcript arrives as a signal.
#[tauri::command(async)]
pub fn kalvoice_listen_stop(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<KalVoiceState>,
    session_id: String,
) -> Result<(), IpcError> {
    _runtime_access.revalidate()?;
    let runtime = state.runtime()?.clone();
    match runtime.voice.listening() {
        Some((id, mode)) if id == session_id => {
            finish_listening(runtime, id, mode);
            Ok(())
        }
        _ => Err(voice_ipc(&VoiceError::NotListening)),
    }
}

/// Whether a cancel also stops a spoken reply. The renderer's background Escape (`keep_speech`,
/// sent when KalVoice is not visibly listening, e.g. Escape closing a menu) stops speech only if
/// it actually cancelled a pending start or a session; an explicit cancel always stops it.
fn cancel_stops_speech(session_id: Option<&str>, keep_speech: bool, cancelled: bool) -> bool {
    cancelled || (session_id.is_none() && !keep_speech)
}

/// Escape: discards the recording (if any) and stops a spoken reply.
#[tauri::command(async)]
pub fn kalvoice_listen_cancel(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<KalVoiceState>,
    session_id: Option<String>,
    keep_speech: Option<bool>,
) -> Result<bool, IpcError> {
    _runtime_access.revalidate()?;
    let runtime = state.runtime()?;
    let _source = runtime
        .push_to_talk
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let listening = runtime.voice.listening();
    let cancelled = runtime.voice.cancel(session_id.as_deref());
    if cancel_stops_speech(
        session_id.as_deref(),
        keep_speech.unwrap_or(false),
        cancelled,
    ) && let Some(speech) = runtime.speech.get()
    {
        speech.stop();
    }
    if let (true, Some((session_id, mode))) = (cancelled, listening) {
        runtime.close_priority(&session_id);
        runtime.signal(&KalVoiceSignal::Cancelled { session_id, mode });
    }
    Ok(cancelled)
}

/// Reviews signed runtime/model metadata without downloading artifacts or launching a process.
#[tauri::command(async)]
pub fn kalvoice_reasoning_prepare(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<KalVoiceState>,
) -> Result<LocalReasoningDownload, IpcError> {
    _runtime_access.revalidate()?;
    state
        .runtime()?
        .components
        .prepare_reasoning()
        .map_err(|error| KalError::validation(error.code(), error.to_string()).to_ipc())
}

/// Retries installed components through the same retained startup and capacity boundary.
#[tauri::command(async)]
pub fn kalvoice_reasoning_retry(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<KalVoiceState>,
) -> Result<(), IpcError> {
    _runtime_access.revalidate()?;
    keep_warm(state.runtime()?);
    Ok(())
}

/// Downloads the explicitly selected speech model or the separately consented reasoning pair.
#[tauri::command(async)]
pub fn kalvoice_model_download(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<KalVoiceState>,
    model_id: String,
    consent: bool,
    catalog_identity: Option<String>,
) -> Result<(), IpcError> {
    _runtime_access.revalidate()?;
    let runtime = state.runtime()?.clone();
    if model_id != REASONING_DOWNLOAD_ID && models::find(&model_id).is_none() {
        return Err(KalError::validation(
            "unknown_speech_model",
            ComponentManagerError::UnknownSpeechModel.to_string(),
        )
        .to_ipc());
    }
    if !consent {
        return Err(KalError::validation(
            "consent_required",
            ComponentManagerError::ConsentRequired.to_string(),
        )
        .to_ipc());
    }
    let task = runtime.background.start().ok_or_else(|| {
        KalError::internal(
            "kalvoice_shutting_down",
            "KalVoice is stopping and can't start another download.",
        )
        .to_ipc()
    })?;
    std::thread::Builder::new()
        .name("kalvoice-model-download".into())
        .spawn(move || {
            let _task = task;
            let mut last = Instant::now() - Duration::from_secs(1);
            let progress = |received, total| {
                if last.elapsed() >= Duration::from_millis(200) || received == total {
                    last = Instant::now();
                    runtime.signal(&KalVoiceSignal::ModelProgress {
                        model_id: model_id.clone(),
                        received_bytes: received,
                        total_bytes: total,
                    });
                }
            };
            let result = if model_id == REASONING_DOWNLOAD_ID {
                runtime.components.download_reasoning(
                    consent,
                    catalog_identity.as_deref(),
                    progress,
                )
            } else {
                runtime
                    .components
                    .download_speech(&model_id, consent, progress)
            };
            let installed = result.is_ok();
            let signal = match result {
                Ok(_) => KalVoiceSignal::ModelInstalled { model_id },
                Err(error) => KalVoiceSignal::ModelFailed {
                    model_id,
                    code: error.code().to_owned(),
                    message: error.to_string(),
                },
            };
            runtime.signal(&signal);
            if installed {
                keep_warm(&runtime);
            }
        })
        .map_err(|e| {
            KalError::internal(
                "download_not_started",
                "KalVoice couldn't start the download.",
            )
            .with_source(e)
            .log_and_convert("kalvoice_model_download")
        })?;
    Ok(())
}

#[tauri::command(async)]
pub fn kalvoice_model_cancel(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<KalVoiceState>,
    model_id: String,
) -> Result<bool, IpcError> {
    _runtime_access.revalidate()?;
    let runtime = state.runtime()?;
    provisioning::before_cancel(runtime, &model_id);
    Ok(runtime.components.cancel(&model_id))
}

#[tauri::command(async)]
pub fn kalvoice_model_delete(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<KalVoiceState>,
    model_id: String,
) -> Result<Vec<SpeechModelInfo>, IpcError> {
    _runtime_access.revalidate()?;
    let runtime = state.runtime()?;
    runtime
        .recognizers
        .delete_model(&model_id)
        .map_err(|e| KalError::validation(e.code(), e.to_string()).to_ipc())?;
    provisioning::speech_removed(runtime);
    Ok(runtime.components.speech_models())
}

/// The operating system's microphone privacy page: the only address
/// [`kalvoice_open_microphone_settings`] can open (no argument reaches the opener).
#[cfg(windows)]
const MICROPHONE_SETTINGS: Option<&str> = Some("ms-settings:privacy-microphone");
#[cfg(target_os = "macos")]
const MICROPHONE_SETTINGS: Option<&str> =
    Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
#[cfg(not(any(windows, target_os = "macos")))]
const MICROPHONE_SETTINGS: Option<&str> = None;

/// Opens the system's microphone privacy settings when access is blocked.
#[tauri::command(async)]
pub fn kalvoice_open_microphone_settings(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    app: AppHandle,
) -> Result<(), IpcError> {
    use tauri_plugin_opener::OpenerExt as _;
    _runtime_access.revalidate()?;
    let unavailable = || {
        KalError::validation(
            "microphone_settings_unavailable",
            "KalCode couldn't open your system's microphone privacy settings.",
        )
        .to_ipc()
    };
    let url = MICROPHONE_SETTINGS.ok_or_else(unavailable)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| unavailable())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_directory_refreshes_managed_readiness_before_listing_choices() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let registry = Arc::new(ProviderRegistry::with_specs(
            kalcode_providers::DetectEnv::default(),
            Vec::new(),
        ));
        let refreshes = Arc::new(AtomicUsize::new(0));
        let ensure: crate::kalvoice_executor::ProviderReadiness = {
            let registry = Arc::clone(&registry);
            let refreshes = Arc::clone(&refreshes);
            Arc::new(move |_| {
                refreshes.fetch_add(1, Ordering::SeqCst);
                registry.set_managed_runtime(
                    ProviderId::new(ProviderId::CODEX),
                    Some(kalcode_providers::model::ManagedRuntimeReadiness {
                        version: "0.161.0".into(),
                        source: "last_known_good".into(),
                    }),
                );
            })
        };

        ensure_provider_directory_ready(&registry, Some(&ensure));

        assert_eq!(refreshes.load(Ordering::SeqCst), 1);
        assert!(
            registry
                .usable()
                .contains(&ProviderId::new(ProviderId::CODEX)),
            "KalVoice must read launchability after the shared readiness refresh"
        );
    }

    #[test]
    fn managed_runtime_readiness_keeps_native_missing_truth_and_remains_launchable() {
        let mut status = kalcode_providers::catalog::statuses()
            .into_iter()
            .find(|status| status.id.as_str() == ProviderId::CODEX)
            .expect("Codex status");
        status.detection = Some(kalcode_contracts::agent::ProviderDetection {
            provider_id: status.id.clone(),
            display_name: status.display_name.clone(),
            state: kalcode_contracts::agent::DetectionState::NotInstalled,
            display_path: None,
            version: None,
            minimum_version: None,
            auth: kalcode_contracts::agent::AuthState::Unknown,
            message: None,
            checked_at: "cached".into(),
        });
        let launchable = vec![ProviderId::new(ProviderId::CODEX)];

        assert_eq!(
            provider_choice_availability(&status, &launchable),
            Some(true)
        );
        assert_eq!(
            status.detection.as_ref().unwrap().state,
            kalcode_contracts::agent::DetectionState::NotInstalled
        );
        assert_eq!(provider_choice_availability(&status, &[]), Some(false));
    }

    #[test]
    fn shutdown_gate_rejects_new_work_and_waits_without_holding_the_task_lock() {
        let tasks = Arc::new(BackgroundTasks::default());
        let active = tasks.start().expect("first task");
        let waiting = tasks.clone();
        let waiter = std::thread::spawn(move || {
            waiting.stop();
            waiting.wait_until(Instant::now() + Duration::from_secs(1))
        });

        let deadline = Instant::now() + Duration::from_secs(1);
        while !tasks
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .stopping
            && Instant::now() < deadline
        {
            std::thread::yield_now();
        }
        assert!(tasks.start().is_none());
        drop(active);
        assert!(waiter.join().expect("shutdown waiter"));
    }

    #[test]
    fn shutdown_gate_is_idempotent_and_bounded() {
        let tasks = Arc::new(BackgroundTasks::default());
        let active = tasks.start().expect("active task");
        tasks.stop();
        tasks.stop();
        assert!(!tasks.wait_until(Instant::now() + Duration::from_millis(1)));
        drop(active);
        assert!(tasks.wait_until(Instant::now() + Duration::from_secs(1)));
    }

    #[test]
    fn every_talk_key_parses_for_the_os_without_modifiers() {
        for key in shortcuts::allowed_keys() {
            let shortcut = parse_shortcut(&key).unwrap_or_else(|| panic!("{key}"));
            assert!(shortcut.mods.is_empty(), "{key}");
        }
        for reserved in shortcuts::reserved() {
            assert!(
                parse_shortcut(&reserved.accelerator).is_some(),
                "{}",
                reserved.accelerator
            );
        }
    }

    /// A channel whose first `fail_first` sends fail (the webview briefly unreachable), then
    /// deliver, counting the signals that arrive.
    fn flaky_channel(fail_first: usize) -> (Channel<KalVoiceSignal>, Arc<Mutex<usize>>) {
        let delivered = Arc::new(Mutex::new(0_usize));
        let attempts = Arc::new(Mutex::new(0_usize));
        let counted = delivered.clone();
        let channel = Channel::new(move |_body| {
            let mut attempt = attempts.lock().unwrap_or_else(PoisonError::into_inner);
            *attempt += 1;
            if *attempt <= fail_first {
                return Err(tauri::Error::WebviewNotFound);
            }
            *counted.lock().unwrap_or_else(PoisonError::into_inner) += 1;
            Ok(())
        });
        (channel, delivered)
    }

    #[test]
    fn one_failed_send_does_not_orphan_the_window_for_later_signals() {
        // 60a17a8 removed a webview's channel after one failed send, so every later signal
        // (listening started, transcript, failure) silently went nowhere until the page
        // happened to subscribe again.
        let (channel, delivered) = flaky_channel(1);
        let channels = HashMap::from([("main".to_owned(), channel)]);
        broadcast(&channels, &KalVoiceSignal::Reveal);
        broadcast(
            &channels,
            &KalVoiceSignal::ListeningStarted {
                session_id: "s1".into(),
                mode: KalVoiceMode::Talk,
            },
        );
        assert!(channels.contains_key("main"));
        assert_eq!(*delivered.lock().unwrap_or_else(PoisonError::into_inner), 1);
    }

    #[test]
    fn a_runtime_built_after_the_page_subscribed_reaches_it_and_so_does_its_successor() {
        // 60a17a8 kept the channels inside each KalVoiceRuntime, so a page that subscribed
        // before the runtime was published (or before a rebuild) was never signalled: the
        // microphone opened and closed but the UI never showed listening or ran the command.
        let signals = Arc::new(KalVoiceSignals::default());
        let (channel, delivered) = flaky_channel(0);
        signals.subscribe("main", channel);
        for _generation in 0..2 {
            // Each runtime generation takes the shared registry at start.
            let runtime_signals = signals.clone();
            runtime_signals.send(&KalVoiceSignal::Reveal);
        }
        assert_eq!(*delivered.lock().unwrap_or_else(PoisonError::into_inner), 2);
    }

    /// A microphone that records until told to stop, counting stops.
    #[derive(Default)]
    struct HeldMic {
        stopped: Arc<std::sync::atomic::AtomicUsize>,
    }
    struct HeldCapture(Arc<std::sync::atomic::AtomicUsize>);
    impl kalcode_kalvoice::audio::ActiveCapture for HeldCapture {
        fn finish(self: Box<Self>) -> Result<Vec<f32>, kalcode_kalvoice::audio::CaptureError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(Vec::new())
        }
        fn cancel(self: Box<Self>) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    impl kalcode_kalvoice::audio::AudioSource for HeldMic {
        fn start(
            &self,
            _max: Duration,
        ) -> Result<
            Box<dyn kalcode_kalvoice::audio::ActiveCapture>,
            kalcode_kalvoice::audio::CaptureError,
        > {
            Ok(Box::new(HeldCapture(self.stopped.clone())))
        }
    }
    struct ReadyModel;
    impl SpeechRecognizer for ReadyModel {
        fn transcribe(&self, _audio: &[f32]) -> Result<String, SttError> {
            Ok(String::new())
        }
    }
    impl RecognizerSource for ReadyModel {
        fn ready(&self) -> Result<(), SttError> {
            Ok(())
        }
        fn recognizer(&self) -> Result<Arc<dyn SpeechRecognizer>, SttError> {
            Ok(Arc::new(Self))
        }
    }

    /// A talk-key session held open, as while the push-to-talk key is down.
    fn held_session(
        dir: &std::path::Path,
    ) -> (VoiceController, Arc<std::sync::atomic::AtomicUsize>) {
        let core = Core::open(kalcode_core::CoreConfig {
            paths: kalcode_core::Paths::new(dir),
            app_version: "0.1.0-test".into(),
            channel: kalcode_core::flags::BuildChannel::Development,
        })
        .unwrap_or_else(|error| panic!("core: {error}"));
        let mic = HeldMic::default();
        let stopped = mic.stopped.clone();
        let voice = VoiceController::new(Arc::new(core), Arc::new(mic), Arc::new(ReadyModel));
        voice
            .begin(KalVoiceMode::Talk)
            .unwrap_or_else(|error| panic!("begin: {error}"));
        (voice, stopped)
    }

    #[test]
    fn reloading_the_page_while_the_key_is_held_closes_the_microphone() {
        // The reload releases the key (no subscriber), so its key-up is never recognized; the
        // session must end here instead of recording invisibly until the two-minute cap.
        let dir = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir: {error}"));
        let (voice, stopped) = held_session(dir.path());
        assert!(end_orphaned_session(
            &voice,
            &Mutex::new(HashMap::new()),
            Unsubscribed::LastGone
        ));
        assert_eq!(voice.listening(), None);
        assert_eq!(stopped.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn reloading_the_page_while_listening_releases_the_background_start_priority() {
        // The announced session holds an interactive span that defers agent and local-model
        // starts. Discarding it on reload must end that span, not leave it to its 10 s bound.
        let dir = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir: {error}"));
        let (voice, _) = held_session(dir.path());
        let (id, _) = voice.listening().unwrap_or_else(|| panic!("listening"));
        let priority = kalcode_resources::InteractivePriority::default();
        let spans = Mutex::new(HashMap::from([(id, priority.begin())]));
        assert!(priority.active());
        assert!(end_orphaned_session(&voice, &spans, Unsubscribed::LastGone));
        assert!(
            !priority.active(),
            "an orphaned session kept deferring background starts"
        );
        assert!(
            spans
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .is_empty()
        );
    }

    #[test]
    fn lifecycle_reset_invalidates_pending_fn_fallback_and_direct_starts() {
        for source in [Some(PttSource::Function), Some(PttSource::Fallback), None] {
            let dir = tempfile::tempdir().unwrap();
            let (voice, _) = held_session(dir.path());
            assert!(voice.cancel(None));
            let state = Mutex::new(PushToTalkState::default());
            let start = voice.reserve_start().unwrap();
            if let Some(source) = source {
                state
                    .lock()
                    .unwrap()
                    .reserve_start(source, start.clone())
                    .unwrap();
            }
            reset_capture_source(&state, &voice);
            assert!(state.lock().unwrap().pending.is_none());
            assert_eq!(
                voice.begin_reserved_at(start, KalVoiceMode::Talk, Instant::now()),
                Err(VoiceError::NotListening)
            );
            assert!(!voice.busy());
        }
    }

    #[test]
    fn a_direct_start_cancelled_before_announcement_cannot_signal_listening() {
        let dir = tempfile::tempdir().unwrap();
        let (voice, _) = held_session(dir.path());
        let (id, mode) = voice.listening().unwrap();
        let source = Mutex::new(PushToTalkState::default());
        let mut announced = false;
        {
            let _source = source.lock().unwrap();
            assert!(voice.cancel(Some(&id)));
        }
        assert_eq!(
            announce_current_session(&source, &voice, &id, mode, || true, || announced = true),
            Err(VoiceError::NotListening)
        );
        assert!(!announced);
        let next = voice.begin(mode).unwrap();
        assert!(
            !voice.cancel(Some(&id)),
            "late cleanup must not cancel a successor"
        );
        assert!(
            announce_current_session(&source, &voice, &next, mode, || true, || announced = true)
                .is_ok()
        );
        assert!(announced);
        assert!(voice.cancel(Some(&next)));
        let disconnected = voice.begin(mode).unwrap();
        announced = false;
        assert_eq!(
            announce_current_session(
                &source,
                &voice,
                &disconnected,
                mode,
                || false,
                || announced = true
            ),
            Err(VoiceError::NotListening)
        );
        assert!(!announced);
        assert_eq!(voice.listening(), None);
    }

    #[test]
    fn shutdown_drains_a_cancelled_microphone_start_before_device_release() {
        struct PendingMic {
            entered: std::sync::mpsc::Sender<()>,
            release: Mutex<std::sync::mpsc::Receiver<()>>,
        }
        impl kalcode_kalvoice::audio::AudioSource for PendingMic {
            fn start(
                &self,
                max: Duration,
            ) -> Result<
                Box<dyn kalcode_kalvoice::audio::ActiveCapture>,
                kalcode_kalvoice::audio::CaptureError,
            > {
                self.start_cancellable(max, &|| false)
            }
            fn start_cancellable(
                &self,
                _max: Duration,
                cancelled: &(dyn Fn() -> bool + Sync),
            ) -> Result<
                Box<dyn kalcode_kalvoice::audio::ActiveCapture>,
                kalcode_kalvoice::audio::CaptureError,
            > {
                self.entered.send(()).unwrap();
                let release = self.release.lock().unwrap();
                while !cancelled() {
                    if !matches!(
                        release.recv_timeout(Duration::from_millis(5)),
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout)
                    ) {
                        break;
                    }
                }
                Err(kalcode_kalvoice::audio::CaptureError::Interrupted)
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let core = Core::open(kalcode_core::CoreConfig {
            paths: kalcode_core::Paths::new(dir.path()),
            app_version: "0.1.0-test".into(),
            channel: kalcode_core::flags::BuildChannel::Development,
        })
        .unwrap();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let voice = Arc::new(VoiceController::new(
            Arc::new(core),
            Arc::new(PendingMic {
                entered: entered_tx,
                release: Mutex::new(release_rx),
            }),
            Arc::new(ReadyModel),
        ));
        let background = Arc::new(BackgroundTasks::default());
        let task = background.start().unwrap();
        let start = voice.reserve_start().unwrap();
        let worker_voice = voice.clone();
        let worker_start = start.clone();
        let worker = std::thread::spawn(move || {
            let _task = task;
            worker_voice.begin_reserved_at(worker_start, KalVoiceMode::Talk, Instant::now())
        });
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        background.stop();
        assert!(voice.cancel_start(&start));
        let drained = background.wait_until(Instant::now() + Duration::from_millis(250));
        // Cleanup remains unconditional on the failing path so the test cannot strand a worker.
        drop(release_tx);
        let result = worker.join().unwrap();
        assert!(
            drained,
            "shutdown must not wait for the device's eight-second timeout"
        );
        assert_eq!(result, Err(VoiceError::NotListening));
        assert!(!voice.busy());
    }

    #[test]
    fn background_escape_keeps_speech_unless_it_cancelled_a_capture() {
        // Escape closing a menu while KalVoice reads a callback aloud: nothing to cancel.
        assert!(!cancel_stops_speech(None, true, false));
        // The same Escape during a pending start (or a session the renderer hasn't seen yet).
        assert!(cancel_stops_speech(None, true, true));
        // The explicit cancel while listening/transcribing/routing always stops speech.
        assert!(cancel_stops_speech(None, false, false));
        assert!(cancel_stops_speech(Some("s1"), false, true));
        // A stale targeted cancel leaves speech alone.
        assert!(!cancel_stops_speech(Some("s1"), false, false));
    }

    #[test]
    fn a_release_during_a_pending_start_cancels_only_its_own_reservation() {
        let dir = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir: {error}"));
        let core = Core::open(kalcode_core::CoreConfig {
            paths: kalcode_core::Paths::new(dir.path()),
            app_version: "0.1.0-test".into(),
            channel: kalcode_core::flags::BuildChannel::Development,
        })
        .unwrap_or_else(|error| panic!("core: {error}"));
        let mic = HeldMic::default();
        let stopped = mic.stopped.clone();
        let voice = VoiceController::new(Arc::new(core), Arc::new(mic), Arc::new(ReadyModel));
        let state = Mutex::new(PushToTalkState::default());

        let reserved = voice
            .reserve_start()
            .unwrap_or_else(|error| panic!("reserve: {error}"));
        let start = state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .reserve_start(PttSource::Fallback, reserved)
            .unwrap_or_else(|| panic!("source reservation"));
        assert!(voice.busy(), "the reservation owns the capture lane");
        assert!(
            state
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .reserve_start(PttSource::Function, start.voice.clone())
                .is_none(),
            "a second source cannot reserve while a start is pending"
        );

        // Fn key-up cannot cancel the fallback key's pending start; the fallback key-up can.
        assert!(!cancel_pending_ptt_start(
            &state,
            &voice,
            PttSource::Function
        ));
        assert!(cancel_pending_ptt_start(
            &state,
            &voice,
            PttSource::Fallback
        ));

        // The worker finishes after the release: the cancelled start never opens the microphone
        // and can no longer be promoted to a live session.
        assert!(matches!(
            voice.begin_reserved_at(start.voice.clone(), KalVoiceMode::Talk, Instant::now()),
            Err(VoiceError::NotListening)
        ));
        assert!(
            !state
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .promote_start(&start, "late".into())
        );
        assert!(!voice.busy());
        assert_eq!(voice.listening(), None);
        assert_eq!(stopped.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn only_the_source_that_opened_capture_can_take_the_live_session() {
        let dir = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir: {error}"));
        let (voice, stopped) = held_session(dir.path());
        let (id, mode) = voice.listening().unwrap_or_else(|| panic!("not listening"));
        let state = Mutex::new(PushToTalkState::default());
        state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .sessions
            .claim(PttSource::Function, id.clone());
        assert_eq!(take_ptt_session(&state, &voice, PttSource::Fallback), None);
        assert_eq!(stopped.load(Ordering::SeqCst), 0);
        assert_eq!(
            take_ptt_session(&state, &voice, PttSource::Function),
            Some((id.clone(), mode))
        );
        assert_eq!(take_ptt_session(&state, &voice, PttSource::Function), None);
        assert!(voice.cancel(Some(&id)));
        assert_eq!(stopped.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn disabling_fn_cancels_only_its_capture_and_invalidates_the_timer() {
        let dir = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir: {error}"));
        let (voice, stopped) = held_session(dir.path());
        let (id, mode) = voice.listening().unwrap_or_else(|| panic!("not listening"));
        let mut state = PushToTalkState::default();
        state.sessions.claim(PttSource::Fallback, id.clone());
        let FnAction::Arm { generation } = state.function.down(Instant::now(), false) else {
            panic!("not armed")
        };
        assert_eq!(cancel_fn_capture(&mut state, &voice), None);
        assert_eq!(state.function.tick(generation), FnAction::None);
        assert_eq!(stopped.load(Ordering::SeqCst), 0);
        state.sessions.claim(PttSource::Function, id.clone());
        assert_eq!(cancel_fn_capture(&mut state, &voice), Some((id, mode)));
        assert_eq!(stopped.load(Ordering::SeqCst), 1);
        assert_eq!(voice.listening(), None);
    }

    #[test]
    fn a_child_webview_load_or_a_remaining_page_leaves_the_session_alone() {
        let dir = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir: {error}"));
        let (voice, stopped) = held_session(dir.path());
        let spans = Mutex::new(HashMap::new());
        assert!(!end_orphaned_session(
            &voice,
            &spans,
            Unsubscribed::NotSubscribed
        ));
        assert!(!end_orphaned_session(
            &voice,
            &spans,
            Unsubscribed::OthersRemain
        ));
        assert!(voice.listening().is_some());
        assert_eq!(stopped.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_webview_has_exactly_one_channel_and_a_new_subscription_replaces_it() {
        let signals = KalVoiceSignals::default();
        assert!(!signals.connected());
        let (first, first_delivered) = flaky_channel(0);
        let (second, second_delivered) = flaky_channel(0);
        signals.subscribe("main", first);
        signals.subscribe("main", second);
        signals.send(&KalVoiceSignal::Reveal);
        assert_eq!(
            *first_delivered
                .lock()
                .unwrap_or_else(PoisonError::into_inner),
            0
        );
        assert_eq!(
            *second_delivered
                .lock()
                .unwrap_or_else(PoisonError::into_inner),
            1
        );
        assert!(signals.connected());
        assert_eq!(
            signals.unsubscribe("browser-1"),
            Unsubscribed::NotSubscribed
        );
        assert!(signals.connected());
        assert_eq!(signals.unsubscribe("main"), Unsubscribed::LastGone);
        assert!(!signals.connected(), "the talk key needs a live subscriber");
        assert_eq!(signals.unsubscribe("main"), Unsubscribed::NotSubscribed);
        signals.send(&KalVoiceSignal::Reveal);
        assert_eq!(
            *second_delivered
                .lock()
                .unwrap_or_else(PoisonError::into_inner),
            1
        );
    }

    #[test]
    fn every_subscribed_window_receives_each_signal() {
        let (main, main_delivered) = flaky_channel(0);
        let (other, other_delivered) = flaky_channel(0);
        let channels = HashMap::from([("main".to_owned(), main), ("other".to_owned(), other)]);
        broadcast(&channels, &KalVoiceSignal::Reveal);
        assert_eq!(
            *main_delivered
                .lock()
                .unwrap_or_else(PoisonError::into_inner),
            1
        );
        assert_eq!(
            *other_delivered
                .lock()
                .unwrap_or_else(PoisonError::into_inner),
            1
        );
    }

    #[test]
    fn talk_key_signal_serializes_with_the_signal_conventions() {
        let signal = KalVoiceSignal::TalkKey {
            active: false,
            reason: Some("not_focused".into()),
            accelerator: "F8".into(),
        };
        assert_eq!(signal_kind(&signal), "talk_key");
        assert_eq!(
            serde_json::to_value(&signal).unwrap_or_default(),
            serde_json::json!({
                "kind": "talk_key",
                "active": false,
                "reason": "not_focused",
                "accelerator": "F8",
            })
        );
    }

    #[test]
    fn microphone_settings_open_only_the_platform_privacy_page() {
        #[cfg(windows)]
        assert_eq!(MICROPHONE_SETTINGS, Some("ms-settings:privacy-microphone"));
        #[cfg(target_os = "macos")]
        assert_eq!(
            MICROPHONE_SETTINGS,
            Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
        );
        #[cfg(not(any(windows, target_os = "macos")))]
        assert_eq!(MICROPHONE_SETTINGS, None);
    }

    #[test]
    fn stt_engine_flag_matches_feature() {
        assert_eq!(ENGINE_AVAILABLE, cfg!(feature = "kalvoice-whisper"));
    }

    #[test]
    fn concurrent_provider_configs_keep_their_selected_account() {
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let spawn = |request: &'static str, account: &'static str| {
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                (0..256)
                    .map(|_| {
                        account_bound_session_config(
                            request,
                            None,
                            std::path::Path::new("C:\\kalcode-test"),
                            account,
                        )
                    })
                    .collect::<Vec<_>>()
            })
        };
        let first = spawn("0199aaaa-0000-7000-8000-000000000101", "account-a");
        let second = spawn("0199aaaa-0000-7000-8000-000000000102", "account-b");
        barrier.wait();
        let first = first.join().expect("first configs");
        let second = second.join().expect("second configs");
        assert!(
            first
                .iter()
                .all(|config| config.provider_account_id.as_deref() == Some("account-a"))
        );
        assert!(
            second
                .iter()
                .all(|config| config.provider_account_id.as_deref() == Some("account-b"))
        );
    }
}
