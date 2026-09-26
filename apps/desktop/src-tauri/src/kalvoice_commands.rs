//! KalVoice in the desktop shell (campaign Z12): IPC commands, the push-to-talk key, the
//! listening lifecycle (streaming recognition, latency timings), speech model downloads,
//! spoken replies, and the runtime seams KalVoice drives.
//!
//! Push to talk: one key (F8 by default), registered through the official global-shortcut plugin
//! only while a KalCode window has focus, so other apps keep the key. Press opens the
//! microphone; release finishes recognition. A release that can't arrive (the window lost focus
//! while the key was held) and the two-minute recording cap both finish the session.
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
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::{Duration, Instant};

use kalcode_contracts::agent::{AgentProvider, ProviderId, SessionConfig};
use kalcode_contracts::app::SurfaceId;
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
    RequestStage, TalkRequest, TalkResponse, provider_display_name,
};
use kalcode_kalvoice::plan::ProvisionalEntitlement;
use kalcode_kalvoice::prefs::{KalVoicePreferences, KalVoicePreferencesPatch};
use kalcode_kalvoice::shortcuts;
use kalcode_kalvoice::signals::{KalVoiceSignal, KalVoiceStatus, ListeningSession, ShortcutIssue};
use kalcode_kalvoice::speech_output::{SpeechOutput, spoken_text};
use kalcode_kalvoice::stt::{ENGINE_AVAILABLE, RecognizerCache, SpeechRecognizer, SttError};
use kalcode_kalvoice::voice::{RecognizerSource, VoiceController, VoiceError};
use kalcode_providers::ProviderRegistry;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Webview};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

use crate::kalvoice_components::{
    ComponentManagerError, KalVoiceComponentManager, REASONING_DOWNLOAD_ID,
};
use kalcode_kalvoice::signals::LocalReasoningDownload;
#[path = "kalvoice_reasoning.rs"]
mod reasoning;
use reasoning::DesktopLocalInterpreter;

/// Tauri-managed state. `None` when the core failed to start or KalVoice is off in this
/// build channel (then no shortcut is registered and every command explains why).
pub struct KalVoiceState(pub Option<Arc<KalVoiceRuntime>>, &'static str);

impl kalcode_doctor::context::LocalVoiceSource for KalVoiceState {
    fn current(&self) -> kalcode_doctor::context::LocalVoiceState {
        use kalcode_doctor::context::LocalVoiceState as DoctorState;
        use kalcode_kalvoice::signals::LocalReasoningStatus;
        let Some(runtime) = &self.0 else {
            return DoctorState::Unavailable;
        };
        match runtime.reasoning.status() {
            LocalReasoningStatus::Ready => DoctorState::Ready,
            LocalReasoningStatus::Warming => DoctorState::Warming,
            LocalReasoningStatus::Installed => DoctorState::Installed,
            LocalReasoningStatus::NotInstalled => DoctorState::NotInstalled,
            LocalReasoningStatus::Unavailable => DoctorState::Unavailable,
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
}

#[derive(Default)]
struct Registered {
    /// The push-to-talk key while it is registered (only while KalCode has focus).
    talk: Option<Shortcut>,
    issues: Vec<ShortcutIssue>,
}

pub struct KalVoiceRuntime {
    providers: Arc<DesktopProviders>,
    orchestrator: Orchestrator,
    voice: VoiceController,
    components: Arc<KalVoiceComponentManager>,
    reasoning: Arc<DesktopLocalInterpreter>,
    recognizers: Arc<DesktopRecognizers>,
    /// The OS voice, started on first use.
    speech: std::sync::OnceLock<Arc<dyn SpeechOutput>>,
    microphone_supported: bool,
    channels: Mutex<HashMap<String, Channel<KalVoiceSignal>>>,
    shortcuts: Mutex<Registered>,
    /// Whether a KalCode window has focus (the talk key is registered only then).
    focused: AtomicBool,
    shutting_down: AtomicBool,
    background: Arc<BackgroundTasks>,
    latency: LatencyLog,
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
        let mut channels = self.channels.lock().unwrap_or_else(PoisonError::into_inner);
        channels.retain(|_, channel| channel.send(signal.clone()).is_ok());
    }

    fn status(&self) -> Result<KalVoiceStatus, KalError> {
        let preferences = self.orchestrator.preferences()?;
        let active_model = self.recognizers.active_model(&preferences);
        let registered = self
            .shortcuts
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        Ok(KalVoiceStatus {
            usage: self.orchestrator.usage()?,
            preferences,
            models: self.components.speech_models(),
            local_reasoning: Some(self.reasoning.status()),
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
        })
    }

    fn shutdown(&self, app: &AppHandle, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        self.shutting_down.store(true, Ordering::SeqCst);
        self.background.stop();
        self.reasoning.seal();
        // Seal local inference immediately; retain its custody until the bounded drain below.
        let _ = self
            .orchestrator
            .shutdown_local_interpretation(Duration::ZERO);

        // Stop new shortcut events first, without holding the state lock over plugin work.
        let shortcut = self
            .shortcuts
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .talk
            .take();
        if let Some(shortcut) = shortcut {
            let _ = app.global_shortcut().unregister(shortcut);
        }
        self.focused.store(false, Ordering::SeqCst);

        self.voice.cancel(None);
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
        if downloads_settled && background_settled && local_settled && reasoning_settled {
            self.recognizers.shutdown();
        }
        self.channels
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clear();
        downloads_settled && background_settled && local_settled && reasoning_settled
    }
}

/// Picks the recognizer for the selected model, or another installed model.
struct DesktopRecognizers {
    core: Arc<Core>,
    components: Arc<KalVoiceComponentManager>,
    cache: RecognizerCache,
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
    fn transcribe(&self, audio: &[f32]) -> Result<String, SttError> {
        self.0.recognizer.transcribe(audio)
    }
}

impl DesktopRecognizers {
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
        let mut loaded = self.loaded.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some((loaded_id, recognizer)) = loaded.as_ref()
            && loaded_id == &id
        {
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
        if !ENGINE_AVAILABLE {
            return Err(SttError::EngineUnavailable);
        }
        self.load_recognizer().map(|_| ())
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
}

impl DesktopProviders {
    fn ensure_detected(&self) {
        if self.registry.list().iter().all(|s| s.detection.is_none()) {
            // First use before the Providers page ran detection: read-only version and
            // sign-in checks.
            let _ = self.registry.detect_all();
        }
    }
}

impl ProviderDirectory for DesktopProviders {
    fn connected(&self) -> Vec<ProviderChoice> {
        let usable = self.registry.usable();
        let accounts = self.runtime.account_store();
        self.registry
            .list()
            .into_iter()
            .filter(|s| s.adapter == kalcode_providers::AdapterState::Implemented)
            .filter(|s| {
                s.detection
                    .as_ref()
                    .is_some_and(|d| d.state == kalcode_contracts::agent::DetectionState::Installed)
            })
            .filter_map(|s| {
                let _account = accounts
                    .resolve(s.id.as_str(), &ProviderAccountScopes::default())
                    .ok()
                    .flatten()?;
                Some(ProviderChoice {
                    available: usable.contains(&s.id),
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
        self.ensure_detected();
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
        permission_mode: PermissionMode::Plan,
        resume_session_id: None,
        secret_ref: None,
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

/// Builds the KalVoice runtime over the workspace, thread and permission runtimes and registers
/// the push-to-talk key.
pub fn init(
    app: &AppHandle,
    core: Option<Arc<Core>>,
    info: &AppInfo,
    registry: Arc<ProviderRegistry>,
    provider_runtime: crate::provider_auth_commands::ProviderRuntimeAuthority,
    threads: Option<Arc<kalcode_threads::ThreadRuntime>>,
    permissions: Option<Arc<kalcode_permissions::PermissionService>>,
    locator: Option<Arc<kalcode_locator::Locator>>,
    components: Arc<KalVoiceComponentManager>,
    resources: Arc<crate::resource_commands::ResourceGovernorState>,
) -> KalVoiceState {
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
    let reasoning = DesktopLocalInterpreter::new(components.clone(), resources, launcher);
    let providers = Arc::new(DesktopProviders {
        registry,
        runtime: provider_runtime,
        reasoning_dir: core.paths().data_dir.join("kalvoice").join("reasoning"),
    });
    let recognizers = Arc::new(DesktopRecognizers {
        core: core.clone(),
        components: components.clone(),
        cache: RecognizerCache::default(),
        loaded: Mutex::new(None),
    });
    let visible = info
        .flags
        .surfaces
        .iter()
        .filter(|s| s.visible)
        .map(|s| s.id)
        .collect();
    let orchestrator = Orchestrator::new(
        core.clone(),
        Arc::new(ProvisionalEntitlement),
        Arc::new(crate::kalvoice_executor::DesktopExecutor {
            visible,
            provider_panes_enabled: info
                .flags
                .feature(kalcode_contracts::app::FeatureId::ProviderPanes)
                .is_some_and(|flag| flag.visible),
            core: core.clone(),
            threads,
            permissions,
            locator,
        }),
        providers.clone(),
    )
    .with_local_interpreter(reasoning.clone());
    let voice = VoiceController::new(
        core.clone(),
        Arc::new(MicrophoneSource),
        recognizers.clone(),
    );
    let focused = app
        .get_webview_window("main")
        .and_then(|w| w.is_focused().ok())
        .unwrap_or(false);
    let runtime = Arc::new(KalVoiceRuntime {
        providers,
        orchestrator,
        voice,
        components,
        reasoning,
        recognizers,
        speech: std::sync::OnceLock::new(),
        microphone_supported: cfg!(any(windows, target_os = "macos")),
        channels: Mutex::new(HashMap::new()),
        shortcuts: Mutex::new(Registered::default()),
        focused: AtomicBool::new(focused),
        shutting_down: AtomicBool::new(false),
        background: Arc::new(BackgroundTasks::default()),
        latency: LatencyLog::new(200),
    });
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
    refresh_talk_key(app, &runtime);
    follow_focus(app, &runtime);
    keep_warm(&runtime);
    KalVoiceState(Some(runtime), "")
}

fn parse_shortcut(accelerator: &str) -> Option<Shortcut> {
    Shortcut::from_str(accelerator).ok()
}

/// Loads the speech model in the background so the first key press doesn't wait for it.
fn keep_warm(runtime: &Arc<KalVoiceRuntime>) {
    let Some(task) = runtime.background.start() else {
        return;
    };
    let runtime = runtime.clone();
    let _ = std::thread::Builder::new()
        .name("kalvoice-warm".into())
        .spawn(move || {
            let _task = task;
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
            runtime.reasoning.warm();
            runtime.signal(&KalVoiceSignal::LocalReasoningStatus {
                status: runtime.reasoning.status(),
            });
        });
}

/// Registers the talk key while KalCode has focus; releases it (and finishes any session whose
/// key-up could now be missed) when focus goes elsewhere.
fn follow_focus(app: &AppHandle, runtime: &Arc<KalVoiceRuntime>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let handle = app.clone();
    let weak = Arc::downgrade(runtime);
    window.on_window_event(move |event| {
        let tauri::WindowEvent::Focused(focused) = event else {
            return;
        };
        let Some(runtime) = weak.upgrade() else {
            return;
        };
        runtime.focused.store(*focused, Ordering::SeqCst);
        if !*focused && let Some((id, mode)) = runtime.voice.listening() {
            // The key-up will go to another app: finish with what was said so far.
            finish_listening(runtime.clone(), id, mode);
        }
        refresh_talk_key(&handle, &runtime);
    });
}

/// Registers or releases the push-to-talk key to match focus and preferences. A key the OS
/// refuses (another app registered it globally) is reported as an issue for Settings.
fn refresh_talk_key(app: &AppHandle, runtime: &KalVoiceRuntime) {
    let Ok(prefs) = runtime.orchestrator.preferences() else {
        return;
    };
    let want = !runtime.shutting_down.load(Ordering::SeqCst)
        && runtime.focused.load(Ordering::SeqCst)
        && prefs.talk_enabled;
    let manager = app.global_shortcut();
    let mut registered = runtime
        .shortcuts
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let desired = parse_shortcut(&prefs.talk_key);
    if (!want || registered.talk != desired)
        && let Some(old) = registered.talk.take()
    {
        let _ = manager.unregister(old);
    }
    if !want || registered.talk.is_some() {
        return;
    }
    registered.issues.clear();
    let result = desired
        .ok_or_else(|| "KalCode couldn't read this key.".to_owned())
        .and_then(|shortcut| {
            manager
                .register(shortcut)
                .map(|()| shortcut)
                .map_err(|_| "Another app is using this key. Choose a different one.".to_owned())
        });
    match result {
        Ok(shortcut) => registered.talk = Some(shortcut),
        Err(message) => {
            tracing::warn!(event = "kalvoice.talk_key_unavailable");
            registered.issues.push(ShortcutIssue {
                mode: KalVoiceMode::Talk,
                accelerator: prefs.talk_key.clone(),
                message,
            });
        }
    }
}

/// Global shortcut handler (registered with the plugin in `lib.rs`): hold to talk.
pub fn on_shortcut(app: &AppHandle, shortcut: &Shortcut, event: ShortcutEvent) {
    let pressed = Instant::now();
    let Ok(state) = crate::runtime_coordinator::RuntimeState::<KalVoiceState>::from_app(app) else {
        return;
    };
    let Some(runtime) = state.0.clone() else {
        return;
    };
    if runtime.shutting_down.load(Ordering::SeqCst) {
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
        return;
    }
    match event.state {
        ShortcutState::Pressed => {
            // Key repeat and a second press while listening are ignored (one session at a time).
            if runtime.voice.listening().is_some() {
                return;
            }
            if let Ok(id) = start_listening_at(&runtime, KalVoiceMode::Talk, false, pressed) {
                // Bring the widget back if it was hidden; the key works either way.
                runtime.signal(&KalVoiceSignal::Reveal);
                watchdog(runtime.clone(), id);
            }
        }
        ShortcutState::Released => {
            if let Some((id, mode)) = runtime.voice.listening() {
                finish_listening(runtime, id, mode);
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
    if runtime.shutting_down.load(Ordering::SeqCst) {
        return Err(VoiceError::NotListening);
    }
    match runtime.voice.begin_at(mode, pressed) {
        Ok(session_id) => {
            runtime.signal(&KalVoiceSignal::ListeningStarted {
                session_id: session_id.clone(),
                mode,
            });
            stream_level(runtime.clone(), session_id.clone());
            Ok(session_id)
        }
        Err(VoiceError::AlreadyListening) => Err(VoiceError::AlreadyListening),
        Err(error) => {
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
    let Some(task) = runtime.background.start() else {
        runtime.voice.cancel(Some(&session_id));
        return;
    };
    runtime.signal(&KalVoiceSignal::Transcribing {
        session_id: session_id.clone(),
        mode,
    });
    let _ = std::thread::Builder::new()
        .name("kalvoice-transcribe".into())
        .spawn(move || {
            let _task = task;
            let signal = match runtime.voice.end_timed(&session_id) {
                Ok(finished) => {
                    runtime.latency.record(finished.timings.clone());
                    KalVoiceSignal::Result {
                        result: finished.result,
                        timings: finished.timings,
                    }
                }
                Err(error) => KalVoiceSignal::ListeningFailed {
                    session_id: Some(session_id),
                    mode,
                    code: error.code().to_owned(),
                    message: error.to_string(),
                },
            };
            runtime.signal(&signal);
        });
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
#[tauri::command]
pub fn kalvoice_subscribe(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    webview: Webview,
    state: crate::runtime_coordinator::RuntimeState<KalVoiceState>,
    on_signal: Channel<KalVoiceSignal>,
) -> Result<(), IpcError> {
    _runtime_access.revalidate()?;
    let runtime = state.runtime()?;
    runtime
        .channels
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(webview.label().to_owned(), on_signal);
    Ok(())
}

#[tauri::command(async)]
pub fn kalvoice_status(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<KalVoiceState>,
) -> Result<KalVoiceStatus, IpcError> {
    _runtime_access.revalidate()?;
    state.runtime()?.status().map_err(to_ipc("kalvoice_status"))
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
        let talked = runtime
            .orchestrator
            .talk(request, &on_stage)
            .map_err(to_ipc("kalvoice_talk"))?;
        runtime.latency.record_recognized(talked.recognized_ms);
        if let Some(response) = &talked.response {
            speak_reply(&runtime, response);
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
    if !enabled || !runtime.speech().available() {
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
    let done_runtime = runtime.clone();
    let done_id = request_id.clone();
    let done = Box::new(move || {
        done_runtime
            .orchestrator
            .record_voice_output(&done_id, false);
        done_runtime.signal(&KalVoiceSignal::Speaking {
            request_id: done_id,
            active: false,
        });
    });
    if runtime.speech().speak(&spoken_text(&text), done).is_ok() {
        runtime.orchestrator.record_voice_output(&request_id, true);
        runtime.signal(&KalVoiceSignal::Speaking {
            request_id,
            active: true,
        });
    }
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
        let saved = runtime
            .orchestrator
            .update_preferences(&patch)
            .map_err(|e| e.to_ipc())?;
        if saved.talk_key != before.talk_key || saved.talk_enabled != before.talk_enabled {
            refresh_talk_key(&app, &runtime);
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
                refresh_talk_key(&app, &runtime);
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
        runtime
            .status()
            .map_err(to_ipc("kalvoice_preferences_update"))
    })
    .await
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
    start_listening(runtime, mode, false).map_err(|e| voice_ipc(&e))
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

/// Escape: discards the recording (if any) and stops a spoken reply.
#[tauri::command(async)]
pub fn kalvoice_listen_cancel(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<KalVoiceState>,
) -> Result<bool, IpcError> {
    _runtime_access.revalidate()?;
    let runtime = state.runtime()?;
    if let Some(speech) = runtime.speech.get() {
        speech.stop();
    }
    let listening = runtime.voice.listening();
    let cancelled = runtime.voice.cancel(None);
    if let (true, Some((session_id, mode))) = (cancelled, listening) {
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
    Ok(state.runtime()?.components.cancel(&model_id))
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
    Ok(runtime.components.speech_models())
}

#[cfg(test)]
mod tests {
    use super::*;

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
