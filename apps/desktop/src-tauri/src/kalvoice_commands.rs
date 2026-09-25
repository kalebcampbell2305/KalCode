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
//! - Providers: [`DesktopProviders`] over the provider runtime (Z2): KalVoice reasoning runs on
//!   the user's own signed-in Claude Code, read-only, in an empty KalVoice folder.
//! - Permissions (Z4): commands that add work (create or resume threads) are filed with the
//!   permission engine as KalVoice-origin approval requests
//!   (`PermissionService::request_for_origin`: evaluated under Approve, `origin_kind =
//!   'kalvoice'`, Approve once or Deny). The person answers them like any approval — in the
//!   KalVoice widget or the Approvals panel, both through `approval_decide` — and KalVoice runs
//!   the command when it sees `approval.approved` ([`watch_approvals`]). Pausing and stopping
//!   make things safer and run directly. KalVoice never answers approvals and never changes
//!   permission modes.

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError, Weak, mpsc};
use std::time::{Duration, Instant};

use kalcode_contracts::agent::{AgentProvider, ProviderId, SessionConfig};
use kalcode_contracts::app::SurfaceId;
use kalcode_contracts::events::EventPayload;
use kalcode_contracts::kalvoice::{KalVoiceMode, KalVoiceOutcome};
use kalcode_contracts::permissions::{ApprovalDecision, NormalizedAction, PermissionMode};
use kalcode_core::{AppInfo, Core, IpcError, KalError};
use kalcode_kalvoice::audio::MAX_RECORDING;
use kalcode_kalvoice::audio::MicrophoneSource;
use kalcode_kalvoice::latency::{LatencyLog, LatencySnapshot};
use kalcode_kalvoice::models::{self, ModelError, ModelStore, SpeechModelInfo};
use kalcode_kalvoice::orchestrator::{
    CommandRequest, GateOutcome, KalVoiceResponse, Orchestrator, OriginGate, ProviderChoice,
    ProviderDirectory, RequestStage, TalkRequest, TalkResponse, provider_display_name,
};
use kalcode_kalvoice::plan::ProvisionalEntitlement;
use kalcode_kalvoice::prefs::{KalVoicePreferences, KalVoicePreferencesPatch};
use kalcode_kalvoice::shortcuts;
use kalcode_kalvoice::signals::{KalVoiceSignal, KalVoiceStatus, ListeningSession, ShortcutIssue};
use kalcode_kalvoice::speech_output::{SpeechOutput, spoken_text};
use kalcode_kalvoice::stt::{ENGINE_AVAILABLE, RecognizerCache, SpeechRecognizer, SttError};
use kalcode_kalvoice::voice::{RecognizerSource, VoiceController, VoiceError};
use kalcode_providers::{ClaudeCodeProvider, DetectEnv, ProviderRegistry};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State, Webview};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

/// Tauri-managed state. `None` when the core failed to start or KalVoice is off in this
/// build channel (then no shortcut is registered and every command explains why).
pub struct KalVoiceState(pub Option<Arc<KalVoiceRuntime>>, &'static str);

impl KalVoiceState {
    fn runtime(&self) -> Result<&Arc<KalVoiceRuntime>, IpcError> {
        self.0
            .as_ref()
            .ok_or_else(|| KalError::internal("kalvoice_unavailable", self.1).to_ipc())
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
    models: Arc<ModelStore>,
    recognizers: Arc<DesktopRecognizers>,
    /// The OS voice, started on first use.
    speech: std::sync::OnceLock<Arc<dyn SpeechOutput>>,
    microphone_supported: bool,
    channels: Mutex<HashMap<String, Channel<KalVoiceSignal>>>,
    shortcuts: Mutex<Registered>,
    /// Whether a KalCode window has focus (the talk key is registered only then).
    focused: AtomicBool,
    latency: LatencyLog,
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
            models: self.models.list(),
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
}

/// Picks the recognizer for the selected model, or another installed model.
struct DesktopRecognizers {
    core: Arc<Core>,
    models: Arc<ModelStore>,
    cache: RecognizerCache,
}

impl DesktopRecognizers {
    fn active_model(&self, prefs: &KalVoicePreferences) -> Option<String> {
        std::iter::once(prefs.speech_model.as_str())
            .chain(models::CATALOG.iter().map(|m| m.id))
            .find(|id| self.models.installed_path(id).is_some())
            .map(str::to_owned)
    }
}

impl RecognizerSource for DesktopRecognizers {
    fn ready(&self) -> Result<(), SttError> {
        if !ENGINE_AVAILABLE {
            return Err(SttError::EngineUnavailable);
        }
        let prefs = self
            .core
            .read(kalcode_kalvoice::prefs::load)
            .map_err(|e| SttError::Failed(e.message))?;
        self.active_model(&prefs)
            .map(|_| ())
            .ok_or(SttError::ModelNotInstalled)
    }

    fn recognizer(&self) -> Result<Arc<dyn SpeechRecognizer>, SttError> {
        let prefs = self
            .core
            .read(kalcode_kalvoice::prefs::load)
            .map_err(|e| SttError::Failed(e.message))?;
        let id = self
            .active_model(&prefs)
            .ok_or(SttError::ModelNotInstalled)?;
        let path = self
            .models
            .installed_path(&id)
            .ok_or(SttError::ModelNotInstalled)?;
        let english_only = models::find(&id).is_some_and(|m| m.english_only);
        self.cache.get(&path, english_only)
    }
}

/// The user's providers, from the provider runtime's cached detection.
pub struct DesktopProviders {
    registry: Arc<ProviderRegistry>,
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
        self.registry
            .list()
            .into_iter()
            .filter(|s| s.adapter == kalcode_providers::AdapterState::Implemented)
            .filter(|s| {
                s.detection
                    .as_ref()
                    .is_some_and(|d| d.state == kalcode_contracts::agent::DetectionState::Installed)
            })
            .map(|s| ProviderChoice {
                available: usable.contains(&s.id),
                display_name: provider_display_name(&s.id),
                id: s.id,
            })
            .collect()
    }

    fn provider(&self, id: &ProviderId) -> Option<Arc<dyn AgentProvider>> {
        self.ensure_detected();
        if !self.registry.usable().contains(id) {
            return None;
        }
        match id.as_str() {
            ProviderId::CLAUDE_CODE => {
                Some(Arc::new(ClaudeCodeProvider::new(DetectEnv::from_process())))
            }
            // PROVIDERS-2: detection now reports Codex and Gemini CLI usable.
            ProviderId::CODEX => Some(Arc::new(kalcode_providers::CodexProvider::new(
                DetectEnv::from_process(),
            ))),
            ProviderId::GEMINI_CLI => Some(Arc::new(kalcode_providers::GeminiProvider::new(
                DetectEnv::from_process(),
            ))),
            _ => None,
        }
    }

    fn session_config(
        &self,
        request_id: &str,
        workspace_id: Option<&str>,
    ) -> Option<SessionConfig> {
        // Until workspaces land, reasoning runs in an empty KalVoice folder, read-only.
        std::fs::create_dir_all(&self.reasoning_dir).ok()?;
        Some(SessionConfig {
            thread_id: request_id.to_owned(),
            workspace_id: workspace_id.unwrap_or_default().to_owned(),
            working_directory: self.reasoning_dir.to_string_lossy().into_owned(),
            model: None,
            permission_mode: PermissionMode::Plan,
            resume_session_id: None,
            secret_ref: None,
        })
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

/// Used when the permission engine didn't start: commands that add work can't be approved, so
/// they're refused (uncounted) instead of running unasked.
struct NoPermissionEngine;

impl OriginGate for NoPermissionEngine {
    fn request(&self, _action: NormalizedAction) -> Result<GateOutcome, String> {
        Err("KalCode's permission engine isn't running, so KalVoice can't ask for your approval. Restart KalCode; if this keeps happening, export diagnostics.".into())
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
    threads: Option<Arc<kalcode_threads::ThreadRuntime>>,
    permissions: Option<Arc<kalcode_permissions::PermissionService>>,
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
    let providers = Arc::new(DesktopProviders {
        registry,
        reasoning_dir: core.paths().data_dir.join("kalvoice").join("reasoning"),
    });
    let models = Arc::new(ModelStore::new(&core.paths().data_dir));
    let recognizers = Arc::new(DesktopRecognizers {
        core: core.clone(),
        models: models.clone(),
        cache: RecognizerCache::default(),
    });
    let visible = info
        .flags
        .surfaces
        .iter()
        .filter(|s| s.visible)
        .map(|s| s.id)
        .collect();
    let gate: Arc<dyn OriginGate> = match &permissions {
        Some(service) => service.clone(),
        None => Arc::new(NoPermissionEngine),
    };
    let orchestrator = Orchestrator::new(
        core.clone(),
        Arc::new(ProvisionalEntitlement),
        Arc::new(crate::kalvoice_executor::DesktopExecutor {
            visible,
            core: core.clone(),
            threads,
            permissions,
        }),
        gate,
        providers.clone(),
    );
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
        models,
        recognizers,
        speech: std::sync::OnceLock::new(),
        microphone_supported: cfg!(any(windows, target_os = "macos")),
        channels: Mutex::new(HashMap::new()),
        shortcuts: Mutex::new(Registered::default()),
        focused: AtomicBool::new(focused),
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
    watch_approvals(&core, Arc::downgrade(&runtime));
    refresh_talk_key(app, &runtime);
    follow_focus(app, &runtime);
    keep_warm(&runtime);
    KalVoiceState(Some(runtime), "")
}

/// The person's answers to KalVoice's approval requests arrive as ordinary approval events
/// (from the widget or the Approvals panel, both `approval_decide`, actor = user). A worker
/// thread continues the waiting command — runs it after `approval.approved`, drops it after
/// `approval.denied` or `approval.expired` — and sends the result to the widget. Work never runs
/// on the event bus's thread (publishing holds the bus lock).
fn watch_approvals(core: &Arc<Core>, runtime: Weak<KalVoiceRuntime>) {
    let (tx, rx) = mpsc::channel::<(String, Option<ApprovalDecision>)>();
    core.subscribe(move |envelope| {
        let answer = match &envelope.event {
            EventPayload::ApprovalApproved {
                request_id,
                decision,
                ..
            } => (request_id.clone(), Some(*decision)),
            EventPayload::ApprovalDenied { request_id, .. } => {
                (request_id.clone(), Some(ApprovalDecision::Deny))
            }
            EventPayload::ApprovalExpired { request_id, .. } => (request_id.clone(), None),
            _ => return true,
        };
        // Unsubscribes once the worker is gone.
        tx.send(answer).is_ok()
    });
    let _ = std::thread::Builder::new()
        .name("kalvoice-approvals".into())
        .spawn(move || {
            for (approval_id, decision) in rx {
                let Some(runtime) = runtime.upgrade() else {
                    break;
                };
                if !runtime.orchestrator.is_waiting_for(&approval_id) {
                    continue;
                }
                if let Some(response) = runtime
                    .orchestrator
                    .resolve_approval(&approval_id, decision)
                {
                    speak_reply(&runtime, &response);
                    runtime.signal(&KalVoiceSignal::RequestResolved { response });
                }
            }
        });
}

fn parse_shortcut(accelerator: &str) -> Option<Shortcut> {
    Shortcut::from_str(accelerator).ok()
}

/// Loads the speech model in the background so the first key press doesn't wait for it.
fn keep_warm(runtime: &Arc<KalVoiceRuntime>) {
    let runtime = runtime.clone();
    let _ = std::thread::Builder::new()
        .name("kalvoice-warm".into())
        .spawn(move || {
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
    let want = runtime.focused.load(Ordering::SeqCst) && prefs.talk_enabled;
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
    let Some(state) = app.try_state::<KalVoiceState>() else {
        return;
    };
    let Some(runtime) = state.0.clone() else {
        return;
    };
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
    let _ = std::thread::Builder::new()
        .name("kalvoice-watchdog".into())
        .spawn(move || {
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
    let _ = std::thread::Builder::new()
        .name("kalvoice-level".into())
        .spawn(move || {
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
    runtime.signal(&KalVoiceSignal::Transcribing {
        session_id: session_id.clone(),
        mode,
    });
    let _ = std::thread::Builder::new()
        .name("kalvoice-transcribe".into())
        .spawn(move || {
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
    command: &'static str,
    work: impl FnOnce() -> Result<T, IpcError> + Send + 'static,
) -> Result<T, IpcError> {
    tauri::async_runtime::spawn_blocking(work)
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
    webview: Webview,
    state: State<'_, KalVoiceState>,
    on_signal: Channel<KalVoiceSignal>,
) -> Result<(), IpcError> {
    let runtime = state.runtime()?;
    runtime
        .channels
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(webview.label().to_owned(), on_signal);
    Ok(())
}

#[tauri::command(async)]
pub fn kalvoice_status(state: State<'_, KalVoiceState>) -> Result<KalVoiceStatus, IpcError> {
    state.runtime()?.status().map_err(to_ipc("kalvoice_status"))
}

/// Handles one command bar request. Spoken replies (when enabled) read the result aloud.
#[tauri::command]
pub async fn kalvoice_request(
    state: State<'_, KalVoiceState>,
    request: CommandRequest,
) -> Result<KalVoiceResponse, IpcError> {
    let runtime = state.runtime()?.clone();
    blocking("kalvoice_request", move || {
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
    state: State<'_, KalVoiceState>,
    request: TalkRequest,
) -> Result<TalkResponse, IpcError> {
    let runtime = state.runtime()?.clone();
    blocking("kalvoice_talk", move || {
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
    state: State<'_, KalVoiceState>,
    request_id: String,
) -> Result<bool, IpcError> {
    state
        .runtime()?
        .orchestrator
        .type_instead(&request_id)
        .map_err(|e| e.to_ipc())
}

/// Rolling latency percentiles and recent stage waterfalls (developer diagnostics).
#[tauri::command(async)]
pub fn kalvoice_latency(state: State<'_, KalVoiceState>) -> Result<LatencySnapshot, IpcError> {
    Ok(state.runtime()?.latency.snapshot())
}

/// Records the last stage (command → visible action), measured in the UI.
#[tauri::command(async)]
pub fn kalvoice_latency_record(
    state: State<'_, KalVoiceState>,
    action_ms: f64,
) -> Result<(), IpcError> {
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
        KalVoiceOutcome::PermissionRequired { .. } => "That needs your approval first.".into(),
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
    app: AppHandle,
    state: State<'_, KalVoiceState>,
    patch: KalVoicePreferencesPatch,
) -> Result<KalVoiceStatus, IpcError> {
    let runtime = state.runtime()?.clone();
    blocking("kalvoice_preferences_update", move || {
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
    state: State<'_, KalVoiceState>,
    mode: KalVoiceMode,
) -> Result<String, IpcError> {
    let runtime = state.runtime()?;
    start_listening(runtime, mode, false).map_err(|e| voice_ipc(&e))
}

/// Stops listening and transcribes; the transcript arrives as a signal.
#[tauri::command(async)]
pub fn kalvoice_listen_stop(
    state: State<'_, KalVoiceState>,
    session_id: String,
) -> Result<(), IpcError> {
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
pub fn kalvoice_listen_cancel(state: State<'_, KalVoiceState>) -> Result<bool, IpcError> {
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

/// Downloads a speech model. `consent` must come from the consent dialog; progress and the
/// outcome arrive as signals.
#[tauri::command(async)]
pub fn kalvoice_model_download(
    state: State<'_, KalVoiceState>,
    model_id: String,
    consent: bool,
) -> Result<(), IpcError> {
    let runtime = state.runtime()?.clone();
    if models::find(&model_id).is_none() {
        return Err(
            KalError::validation("unknown_speech_model", ModelError::Unknown.to_string()).to_ipc(),
        );
    }
    if !consent {
        return Err(KalError::validation(
            "consent_required",
            ModelError::ConsentRequired.to_string(),
        )
        .to_ipc());
    }
    let started = Arc::new(AtomicBool::new(false));
    let flag = started.clone();
    std::thread::Builder::new()
        .name("kalvoice-model-download".into())
        .spawn(move || {
            flag.store(true, Ordering::SeqCst);
            let mut last = Instant::now() - Duration::from_secs(1);
            let result = runtime
                .models
                .download(&model_id, consent, |received, total| {
                    if last.elapsed() >= Duration::from_millis(200) || received == total {
                        last = Instant::now();
                        runtime.signal(&KalVoiceSignal::ModelProgress {
                            model_id: model_id.clone(),
                            received_bytes: received,
                            total_bytes: total,
                        });
                    }
                });
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
    state: State<'_, KalVoiceState>,
    model_id: String,
) -> Result<bool, IpcError> {
    Ok(state.runtime()?.models.cancel(&model_id))
}

#[tauri::command(async)]
pub fn kalvoice_model_delete(
    state: State<'_, KalVoiceState>,
    model_id: String,
) -> Result<Vec<SpeechModelInfo>, IpcError> {
    let runtime = state.runtime()?;
    if let Some(path) = runtime.models.installed_path(&model_id) {
        runtime.recognizers.cache.evict(&path);
    }
    runtime
        .models
        .delete(&model_id)
        .map_err(|e| KalError::validation(e.code(), e.to_string()).to_ipc())?;
    Ok(runtime.models.list())
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
