//! Shapes the desktop shell sends to the KalVoice UI: a status snapshot, and live signals over
//! a per-window channel. Signals are transient UI data (never persisted as events); a
//! transcript travels here only to reach the input the user is dictating into.

use kalcode_contracts::kalvoice::{KalVoiceMode, KalVoiceUsage};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::latency::StageTimings;
use crate::models::SpeechModelInfo;
use crate::orchestrator::RequestStage;
use crate::orchestrator::{KalVoiceResponse, ProviderChoice};
use crate::prefs::KalVoicePreferences;
use crate::shortcuts::ReservedShortcut;
use crate::voice::VoiceResult;

/// A KalVoice shortcut the operating system refused (usually because another app owns it).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ShortcutIssue {
    pub mode: KalVoiceMode,
    pub accelerator: String,
    pub message: String,
}

/// Everything the KalVoice UI needs to render.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KalVoiceStatus {
    pub usage: KalVoiceUsage,
    pub preferences: KalVoicePreferences,
    pub models: Vec<SpeechModelInfo>,
    #[serde(default)]
    #[ts(optional)]
    pub local_reasoning: Option<LocalReasoningStatus>,
    /// The model dictation will use (the selected one, or another installed one).
    pub active_model: Option<String>,
    /// Whether this build includes the on-device speech engine.
    pub speech_engine: bool,
    /// Whether this platform build can capture from a microphone.
    pub microphone_supported: bool,
    /// Whether the OS voice is available for spoken replies.
    pub voice_output_available: bool,
    /// Connected coding providers available as action targets, never as a reasoning fallback.
    pub providers: Vec<ProviderChoice>,
    pub reserved_shortcuts: Vec<ReservedShortcut>,
    /// Keys that can be the push-to-talk key on this system.
    pub talk_keys: Vec<String>,
    /// Whether the push-to-talk key is registered right now (only while KalCode is focused).
    pub talk_key_active: bool,
    pub shortcut_issues: Vec<ShortcutIssue>,
    /// The session listening right now, if any.
    pub listening: Option<ListeningSession>,
}

/// Readiness of the separately consented on-device interpreter. Dictation is independent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum LocalReasoningStatus {
    NotInstalled,
    Installed,
    Warming,
    Ready,
    Unavailable,
}

/// Verified catalog metadata shown before consenting to the runtime and model download.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LocalReasoningDownload {
    pub catalog_identity: String,
    pub runtime_version: String,
    pub model_version: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ListeningSession {
    pub session_id: String,
    pub mode: KalVoiceMode,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum KalVoiceSignal {
    LocalReasoningStatus {
        status: LocalReasoningStatus,
    },
    /// The microphone is live.
    ListeningStarted {
        session_id: String,
        mode: KalVoiceMode,
    },
    /// Microphone input level (0–1), about 20 times a second while listening. Only this
    /// number is sent; the audio stays in native memory.
    Level {
        session_id: String,
        level: f32,
    },
    /// A partial transcript while the key is still held (shown as ghost text; never stored).
    Partial {
        session_id: String,
        text: String,
    },
    /// Recording stopped; recognizing on the device.
    Transcribing {
        session_id: String,
        mode: KalVoiceMode,
    },
    /// Recognition finished.
    Result {
        result: VoiceResult,
        /// Stage timings measured natively (key-down to final transcript).
        timings: StageTimings,
    },
    /// Listening could not start or finish.
    ListeningFailed {
        session_id: Option<String>,
        mode: KalVoiceMode,
        code: String,
        message: String,
    },
    /// Listening was cancelled (Escape, or a quick tap of the command shortcut).
    Cancelled {
        session_id: String,
        mode: KalVoiceMode,
    },
    /// The push-to-talk key was pressed: bring the widget back if it was hidden.
    Reveal,
    ModelProgress {
        model_id: String,
        received_bytes: u64,
        total_bytes: u64,
    },
    ModelInstalled {
        model_id: String,
    },
    ModelFailed {
        model_id: String,
        code: String,
        message: String,
    },
    /// A request moved to a new stage of the pipeline.
    RequestStage {
        request_id: String,
        stage: RequestStage,
    },
    /// A command that waited for approval finished.
    RequestResolved {
        response: KalVoiceResponse,
    },
    /// A spoken reply started or ended.
    Speaking {
        request_id: String,
        active: bool,
    },
}
