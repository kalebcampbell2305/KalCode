//! Shapes the desktop shell sends to the KalVoice UI: a status snapshot, and live signals over
//! a per-window channel. Signals are transient UI data (never persisted as events); a
//! transcript travels here only to reach the input the user is dictating into.

use kalcode_contracts::kalvoice::{KalVoiceMode, KalVoiceUsage};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::models::SpeechModelInfo;
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
    /// The model dictation will use (the selected one, or another installed one).
    pub active_model: Option<String>,
    /// Whether this build includes the on-device speech engine.
    pub speech_engine: bool,
    /// Whether this platform build can capture from a microphone.
    pub microphone_supported: bool,
    /// Whether the OS voice is available for spoken replies.
    pub voice_output_available: bool,
    /// Connected providers that can power KalVoice reasoning.
    pub providers: Vec<ProviderChoice>,
    pub reserved_shortcuts: Vec<ReservedShortcut>,
    pub shortcut_issues: Vec<ShortcutIssue>,
    /// The session listening right now, if any.
    pub listening: Option<ListeningSession>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ListeningSession {
    pub session_id: String,
    pub mode: KalVoiceMode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum KalVoiceSignal {
    /// The microphone is live.
    ListeningStarted {
        session_id: String,
        mode: KalVoiceMode,
    },
    /// Recording stopped; recognizing on the device.
    Transcribing {
        session_id: String,
        mode: KalVoiceMode,
    },
    /// Recognition finished.
    Result {
        result: VoiceResult,
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
    /// The command shortcut was pressed.
    OpenCommandBar,
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
