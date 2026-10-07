//! Shapes the desktop shell sends to the KalVoice UI: a status snapshot, and live signals over
//! a per-window channel. Signals are transient UI data (never persisted as events); a
//! transcript travels here only to reach the input the user is dictating into.

use kalcode_contracts::kalvoice::{KalVoiceMode, KalVoiceUsage};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::latency::StageTimings;
use crate::models::SpeechModelInfo;
use crate::orchestrator::RequestStage;
use crate::orchestrator::{KalVoiceResponse, ProviderChoice, UiDirective};
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
    /// Safe reason code while local reasoning is `waiting` or `failed` (never a path or message).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub local_reasoning_issue: Option<String>,
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
    /// Component downloads in progress or pending (automatic first-run provisioning and manual
    /// downloads), so the UI never claims "Ready" early.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub provisioning: Option<Vec<ComponentProvisioning>>,
}

/// Where one component download stands. Every phase is a fact native observed, never a guess.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ProvisioningPhase {
    /// Queued: KalCode is fetching the signed catalog or about to start.
    Preparing,
    /// Held by the Resource Governor; `reason` names the resource. Re-evaluated on every sample.
    WaitingForResources,
    /// Held while push to talk is in use, so the download never competes with speech.
    WaitingForTalk,
    Downloading,
    /// Every byte arrived; the signed size and SHA-256 are being checked before install.
    Verifying,
    /// The owner paused it (local intelligence only). Resumes where it stopped.
    Paused,
    /// The last attempt failed (`reason`); KalCode retries on its own after `retry_in_seconds`
    /// and whenever KalCode comes back to the front.
    RetryScheduled,
    /// A permanent failure (`reason`: `components_unsupported`, `components_unverified` or
    /// `consent_required`): no automatic retry until KalCode restarts; a manual download still
    /// works.
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ComponentProvisioning {
    /// A speech model id (`tiny.en`) or `local-reasoning`.
    pub model_id: String,
    /// Started by KalCode's zero-setup provisioning (system-granted consent for a default
    /// component) rather than by the owner's Download click.
    pub automatic: bool,
    pub phase: ProvisioningPhase,
    pub received_bytes: u64,
    pub total_bytes: u64,
    /// Safe reason code while waiting or between retries (never a path or message).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub retry_in_seconds: Option<u64>,
}

/// Readiness of the separately consented on-device interpreter. Dictation is independent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum LocalReasoningStatus {
    NotInstalled,
    Installed,
    /// Installed; the automatic start is pending until the Resource Governor admits it.
    Waiting,
    Warming,
    Ready,
    /// Installed; the automatic start gave up (the issue code says why). Retry is available.
    Failed,
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

/// Why a concise lifecycle callback was spoken. This contains no provider or terminal content.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum LifecycleCallbackClass {
    Completed,
    Failed,
    NeedsUser,
    Permission,
    Oauth,
    Deployment,
}

/// The canonical object a spoken lifecycle callback describes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum LifecycleTargetKind {
    Thread,
    Operation,
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
        /// Safe reason code while `waiting` or `failed`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        issue: Option<String>,
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
    /// Every pending or running component download (replaces the previous list).
    Provisioning {
        items: Vec<ComponentProvisioning>,
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
    /// A paired KalCode Remote device acted on this workstation. The window shows the agents it
    /// launched (`directive`, only `open_provider_panes`) and closes the panes of the agents it
    /// removed, exactly as when the same action runs here.
    RemoteActed {
        directive: Option<UiDirective>,
        closed_agent_ids: Vec<String>,
    },
    /// A spoken reply started or ended.
    Speaking {
        request_id: String,
        active: bool,
    },
    /// A concise lifecycle callback started speaking. The UI uses only this bounded identity to
    /// bind immediate follow-ups such as "open it"; task output stays in its canonical store.
    LifecycleCallback {
        request_id: String,
        class: LifecycleCallbackClass,
        target_kind: LifecycleTargetKind,
        target_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        workspace_id: Option<String>,
    },
    /// The push-to-talk key's registration changed (registered, released, skipped or refused).
    /// When inactive, `reason` is a code: `not_focused`, `disabled`, `shutting_down`,
    /// `prefs_error`, `not_connected` (no KalCode page subscribed yet), `os_refused` or
    /// `unparseable`.
    TalkKey {
        active: bool,
        reason: Option<String>,
        accelerator: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lifecycle_callback_contract_is_typed_and_contains_no_task_content() {
        for (class, expected) in [
            (LifecycleCallbackClass::Completed, "completed"),
            (LifecycleCallbackClass::Failed, "failed"),
            (LifecycleCallbackClass::NeedsUser, "needs_user"),
            (LifecycleCallbackClass::Permission, "permission"),
            (LifecycleCallbackClass::Oauth, "oauth"),
            (LifecycleCallbackClass::Deployment, "deployment"),
        ] {
            let encoded = serde_json::to_value(KalVoiceSignal::LifecycleCallback {
                request_id: "callback-1".into(),
                class,
                target_kind: LifecycleTargetKind::Operation,
                target_id: "run-1".into(),
                workspace_id: Some("kalcode".into()),
            })
            .expect("serialize lifecycle callback");
            assert_eq!(encoded["kind"], "lifecycle_callback");
            assert_eq!(encoded["class"], expected);
            assert_eq!(encoded["targetKind"], "operation");
            assert_eq!(encoded["targetId"], "run-1");
            assert_eq!(encoded["workspaceId"], "kalcode");
            assert!(encoded.get("text").is_none());
            assert!(encoded.get("summary").is_none());
        }
    }
}
