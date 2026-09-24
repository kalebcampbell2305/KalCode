//! KalVoice in the desktop shell (campaign Z12): IPC commands, global shortcuts, the listening
//! lifecycle, speech model downloads, spoken replies, and the runtime seams KalVoice drives.
//!
//! Seams for other campaigns (each returns an honest "not available in this build" today):
//! - [`DesktopExecutor`]: workspaces and terminals (Z1), threads and status (Z3), approvals (Z4).
//! - Providers: [`DesktopProviders`] over the provider runtime (Z2): KalVoice reasoning runs on
//!   the user's own signed-in Claude Code, read-only, in an empty KalVoice folder.
//! - Permissions: [`AskUnlessReadGate`] until the permission engine (Z4) supplies a gate.

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use kalcode_contracts::agent::{AgentProvider, ProviderId, SessionConfig};
use kalcode_contracts::app::SurfaceId;
use kalcode_contracts::events::EventPayload;
use kalcode_contracts::kalvoice::{KalVoiceIntent, KalVoiceMode, KalVoiceOutcome};
use kalcode_contracts::permissions::PermissionMode;
use kalcode_contracts::permissions::{ApprovalDecision, AskUnlessReadGate};
use kalcode_core::{AppInfo, Core, IpcError, KalError};
use kalcode_kalvoice::audio::MicrophoneSource;
use kalcode_kalvoice::models::{self, ModelError, ModelStore, SpeechModelInfo};
use kalcode_kalvoice::orchestrator::{
    CommandRequest, ExecContext, ExecError, Executed, Executor, KalVoiceResponse, Orchestrator,
    ProviderChoice, ProviderDirectory, RequestStage, UiDirective, provider_display_name,
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

/// A press of the command shortcut shorter than this opens the bar for typing; holding it
/// longer records a spoken command.
const TAP: Duration = Duration::from_millis(400);

/// Tauri-managed state. `None` when the core failed to start.
pub struct KalVoiceState(pub Option<Arc<KalVoiceRuntime>>);

impl KalVoiceState {
    fn runtime(&self) -> Result<&Arc<KalVoiceRuntime>, IpcError> {
        self.0.as_ref().ok_or_else(|| {
            KalError::internal(
                "kalvoice_unavailable",
                "KalVoice isn't available because KalCode's runtime didn't start.",
            )
            .to_ipc()
        })
    }
}

#[derive(Default)]
struct Registered {
    dictation: Option<Shortcut>,
    command: Option<Shortcut>,
    issues: Vec<ShortcutIssue>,
}

pub struct KalVoiceRuntime {
    core: Arc<Core>,
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
    command_pressed_at: Mutex<Option<Instant>>,
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

/// Runs KalVoice commands through the runtime APIs present in this build.
struct DesktopExecutor {
    visible: Vec<SurfaceId>,
}

impl DesktopExecutor {
    fn unavailable(intent: &KalVoiceIntent) -> Option<ExecError> {
        match intent {
            KalVoiceIntent::Navigate { .. } => None,
            KalVoiceIntent::OpenWorkspace { .. } | KalVoiceIntent::CreateTerminal { .. } => {
                Some(ExecError::new(
                    "workspaces_unavailable",
                    "Workspaces and terminals aren't available in this build yet, so KalVoice can't open them.",
                ))
            }
            KalVoiceIntent::ShowApprovals => Some(ExecError::new(
                "approvals_unavailable",
                "Approvals aren't available in this build yet, so there's nothing KalVoice can show.",
            )),
            KalVoiceIntent::Reasoning { .. } => {
                Some(ExecError::new("not_a_command", "That isn't a command."))
            }
            _ => Some(ExecError::new(
                "threads_unavailable",
                "Threads aren't available in this build yet, so KalVoice can't manage them.",
            )),
        }
    }
}

impl Executor for DesktopExecutor {
    fn find_workspace(&self, _name: &str) -> Result<Option<String>, ExecError> {
        Err(ExecError::new(
            "workspaces_unavailable",
            "Workspaces aren't available in this build yet, so KalVoice can't find that workspace.",
        ))
    }

    fn find_thread(&self, _name: &str) -> Result<Option<String>, ExecError> {
        Err(ExecError::new(
            "threads_unavailable",
            "Threads aren't available in this build yet, so KalVoice can't find that thread.",
        ))
    }

    fn check(&self, intent: &KalVoiceIntent) -> Result<(), ExecError> {
        if let Some(error) = Self::unavailable(intent) {
            return Err(error);
        }
        if let KalVoiceIntent::Navigate { surface } = intent
            && !self.visible.contains(surface)
        {
            return Err(ExecError::new(
                "surface_unavailable",
                "That page isn't available in this build.",
            ));
        }
        Ok(())
    }

    fn execute(&self, intent: &KalVoiceIntent, _ctx: &ExecContext) -> Result<Executed, ExecError> {
        match intent {
            KalVoiceIntent::Navigate { surface } => Ok(Executed {
                summary: format!("Opened {}.", surface_label(*surface)),
                directive: Some(UiDirective::Navigate { surface: *surface }),
            }),
            other => Err(Self::unavailable(other)
                .unwrap_or_else(|| ExecError::new("unsupported", "KalVoice can't do that yet."))),
        }
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

fn surface_label(surface: SurfaceId) -> &'static str {
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

/// Builds the KalVoice runtime, registers the shortcuts, and follows approval decisions.
pub fn init(
    app: &AppHandle,
    core: Option<Arc<Core>>,
    info: &AppInfo,
    registry: Arc<ProviderRegistry>,
) -> KalVoiceState {
    let Some(core) = core else {
        return KalVoiceState(None);
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
    let orchestrator = Orchestrator::new(
        core.clone(),
        Arc::new(ProvisionalEntitlement),
        Arc::new(DesktopExecutor { visible }),
        Arc::new(AskUnlessReadGate),
        providers.clone(),
    );
    let voice = VoiceController::new(
        core.clone(),
        Arc::new(MicrophoneSource),
        recognizers.clone(),
    );
    let runtime = Arc::new(KalVoiceRuntime {
        core: core.clone(),
        providers,
        orchestrator,
        voice,
        models,
        recognizers,
        speech: std::sync::OnceLock::new(),
        microphone_supported: cfg!(any(windows, target_os = "macos")),
        channels: Mutex::new(HashMap::new()),
        shortcuts: Mutex::new(Registered::default()),
        command_pressed_at: Mutex::new(None),
    });
    if let Ok(prefs) = runtime.orchestrator.preferences() {
        register_shortcuts(app, &runtime, &prefs);
    }
    follow_approvals(&runtime);
    KalVoiceState(Some(runtime))
}

/// Resumes KalVoice commands that waited for approval. The bus delivers events while the
/// database lock is held, so decisions are handed to a worker thread.
fn follow_approvals(runtime: &Arc<KalVoiceRuntime>) {
    let (tx, rx) = mpsc::channel::<(String, Option<ApprovalDecision>)>();
    runtime.core.subscribe(move |envelope| {
        let decided = match &envelope.event {
            EventPayload::ApprovalApproved {
                request_id,
                decision,
                ..
            } => Some((request_id.clone(), Some(*decision))),
            EventPayload::ApprovalDenied { request_id, .. }
            | EventPayload::ApprovalExpired { request_id, .. } => {
                Some((request_id.clone(), Some(ApprovalDecision::Deny)))
            }
            _ => None,
        };
        match decided {
            Some(item) => tx.send(item).is_ok(),
            None => true,
        }
    });
    let weak = Arc::downgrade(runtime);
    let _ = std::thread::Builder::new()
        .name("kalvoice-approvals".into())
        .spawn(move || {
            while let Ok((id, decision)) = rx.recv() {
                let Some(runtime) = weak.upgrade() else { break };
                if let Some(response) = runtime.orchestrator.resolve_approval(&id, decision) {
                    runtime.signal(&KalVoiceSignal::RequestResolved { response });
                }
            }
        });
}

fn parse_shortcut(accelerator: &str) -> Option<Shortcut> {
    Shortcut::from_str(accelerator).ok()
}

/// (Re)registers both shortcuts. Failures (another app owns the combination) are recorded as
/// issues for Settings instead of failing startup.
fn register_shortcuts(app: &AppHandle, runtime: &KalVoiceRuntime, prefs: &KalVoicePreferences) {
    let manager = app.global_shortcut();
    let mut registered = runtime
        .shortcuts
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    for old in [registered.dictation.take(), registered.command.take()]
        .into_iter()
        .flatten()
    {
        let _ = manager.unregister(old);
    }
    registered.issues.clear();
    for (mode, accelerator) in [
        (KalVoiceMode::Dictation, &prefs.dictation_shortcut),
        (KalVoiceMode::Command, &prefs.command_shortcut),
    ] {
        let result = parse_shortcut(accelerator)
            .ok_or_else(|| "KalCode couldn't read this shortcut.".to_owned())
            .and_then(|shortcut| {
                manager.register(shortcut).map(|()| shortcut).map_err(|_| {
                    "Another app is already using this shortcut. Choose a different one.".to_owned()
                })
            });
        match result {
            Ok(shortcut) => match mode {
                KalVoiceMode::Dictation => registered.dictation = Some(shortcut),
                KalVoiceMode::Command => registered.command = Some(shortcut),
            },
            Err(message) => {
                tracing::warn!(event = "kalvoice.shortcut_unavailable", mode = ?mode);
                registered.issues.push(ShortcutIssue {
                    mode,
                    accelerator: accelerator.clone(),
                    message,
                });
            }
        }
    }
}

/// Global shortcut handler (registered with the plugin in `lib.rs`).
pub fn on_shortcut(app: &AppHandle, shortcut: &Shortcut, event: ShortcutEvent) {
    let Some(state) = app.try_state::<KalVoiceState>() else {
        return;
    };
    let Some(runtime) = state.0.clone() else {
        return;
    };
    let mode = {
        let registered = runtime
            .shortcuts
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if registered.dictation.as_ref() == Some(shortcut) {
            KalVoiceMode::Dictation
        } else if registered.command.as_ref() == Some(shortcut) {
            KalVoiceMode::Command
        } else {
            return;
        }
    };
    match (mode, event.state) {
        (KalVoiceMode::Dictation, ShortcutState::Pressed) => {
            // Dictation only goes into KalCode's own inputs: ignore it while another app is in
            // front, so the microphone never opens for a window the user isn't looking at.
            let focused = app
                .get_webview_window("main")
                .and_then(|w| w.is_focused().ok())
                .unwrap_or(false);
            if focused {
                let _ = start_listening(&runtime, KalVoiceMode::Dictation, false);
            }
        }
        (KalVoiceMode::Dictation, ShortcutState::Released) => {
            if let Some((id, KalVoiceMode::Dictation)) = runtime.voice.listening() {
                finish_listening(runtime, id, KalVoiceMode::Dictation);
            }
        }
        (KalVoiceMode::Command, ShortcutState::Pressed) => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            runtime.signal(&KalVoiceSignal::OpenCommandBar);
            *runtime
                .command_pressed_at
                .lock()
                .unwrap_or_else(PoisonError::into_inner) = Some(Instant::now());
            // Holding the shortcut speaks a command; quietly skip when speech isn't set up
            // (the bar is open for typing either way).
            let _ = start_listening(&runtime, KalVoiceMode::Command, true);
        }
        (KalVoiceMode::Command, ShortcutState::Released) => {
            let pressed = runtime
                .command_pressed_at
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .take();
            if let Some((id, KalVoiceMode::Command)) = runtime.voice.listening() {
                if pressed.is_some_and(|at| at.elapsed() < TAP) {
                    runtime.voice.cancel(Some(&id));
                    runtime.signal(&KalVoiceSignal::Cancelled {
                        session_id: id,
                        mode: KalVoiceMode::Command,
                    });
                } else {
                    finish_listening(runtime, id, KalVoiceMode::Command);
                }
            }
        }
    }
}

fn start_listening(
    runtime: &Arc<KalVoiceRuntime>,
    mode: KalVoiceMode,
    quiet: bool,
) -> Result<String, VoiceError> {
    match runtime.voice.begin(mode) {
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

/// Stops the microphone and transcribes on a background thread; the result arrives as a signal.
fn finish_listening(runtime: Arc<KalVoiceRuntime>, session_id: String, mode: KalVoiceMode) {
    runtime.signal(&KalVoiceSignal::Transcribing {
        session_id: session_id.clone(),
        mode,
    });
    let _ = std::thread::Builder::new()
        .name("kalvoice-transcribe".into())
        .spawn(move || {
            let signal = match runtime.voice.end(&session_id) {
                Ok(result) => KalVoiceSignal::Result { result },
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

/// Saves preferences. Shortcut changes are registered with the OS first; if the OS refuses a
/// new combination, nothing is saved.
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
        let shortcuts_changed = saved.dictation_shortcut != before.dictation_shortcut
            || saved.command_shortcut != before.command_shortcut;
        if shortcuts_changed {
            register_shortcuts(&app, &runtime, &saved);
            let refused = runtime
                .shortcuts
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .issues
                .iter()
                .find(|issue| {
                    issue.accelerator == saved.dictation_shortcut
                        || issue.accelerator == saved.command_shortcut
                })
                .cloned();
            if let Some(issue) = refused {
                // Put the previous shortcuts back, in storage and with the OS.
                let _ = runtime
                    .orchestrator
                    .update_preferences(&KalVoicePreferencesPatch {
                        dictation_shortcut: Some(before.dictation_shortcut.clone()),
                        command_shortcut: Some(before.command_shortcut.clone()),
                        ..Default::default()
                    });
                register_shortcuts(&app, &runtime, &before);
                return Err(KalError::validation(
                    "shortcut_in_use",
                    format!(
                        "{} {}",
                        shortcuts::display(&issue.accelerator),
                        issue.message
                    ),
                )
                .to_ipc());
            }
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
            let signal = match result {
                Ok(_) => KalVoiceSignal::ModelInstalled { model_id },
                Err(error) => KalVoiceSignal::ModelFailed {
                    model_id,
                    code: error.code().to_owned(),
                    message: error.to_string(),
                },
            };
            runtime.signal(&signal);
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
    fn every_valid_kalvoice_shortcut_parses_for_the_os() {
        for accelerator in [
            shortcuts::DEFAULT_DICTATION,
            shortcuts::DEFAULT_COMMAND,
            "CommandOrControl+Alt+J",
            "Alt+F5",
            "CommandOrControl+Shift+Backquote",
            "CommandOrControl+Alt+Slash",
        ] {
            assert!(parse_shortcut(accelerator).is_some(), "{accelerator}");
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
    fn this_build_reports_unavailable_runtimes_honestly() {
        let executor = DesktopExecutor {
            visible: vec![SurfaceId::Dashboard, SurfaceId::Settings],
        };
        let settings = KalVoiceIntent::Navigate {
            surface: SurfaceId::Settings,
        };
        assert!(executor.check(&settings).is_ok());
        assert_eq!(
            executor
                .check(&KalVoiceIntent::Navigate {
                    surface: SurfaceId::Missions
                })
                .map_err(|e| e.code),
            Err("surface_unavailable".into())
        );
        assert_eq!(
            executor
                .check(&KalVoiceIntent::StatusReport)
                .map_err(|e| e.code),
            Err("threads_unavailable".into())
        );
        assert_eq!(
            executor
                .check(&KalVoiceIntent::ShowApprovals)
                .map_err(|e| e.code),
            Err("approvals_unavailable".into())
        );
        let done = executor
            .execute(
                &settings,
                &ExecContext {
                    request_id: String::new(),
                    workspace_id: None,
                },
            )
            .expect("navigate");
        assert_eq!(done.summary, "Opened Settings.");
    }

    #[test]
    fn stt_engine_flag_matches_feature() {
        assert_eq!(ENGINE_AVAILABLE, cfg!(feature = "kalvoice-whisper"));
    }
}
