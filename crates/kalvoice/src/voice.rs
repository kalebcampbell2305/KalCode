//! Listening sessions: microphone on, then on-device transcription, then the audio is dropped.
//!
//! One session at a time. The microphone starts before anything else, so nothing said right
//! after the shortcut is lost; the only checks before it opens are the ones that would make the
//! recording useless (no speech engine, no model). Dictation sessions emit
//! `kalvoice.dictation_*` events with ids and counts only — never the transcript. Command
//! sessions return their transcript to the command bar, which submits it as a request.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use kalcode_contracts::events::{EventPayload, EventSource, NewEvent};
use kalcode_contracts::ids::new_id;
use kalcode_contracts::kalvoice::KalVoiceMode;
use kalcode_core::Core;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::audio::{ActiveCapture, AudioSource, CaptureError, MAX_RECORDING};
use crate::stt::{SpeechRecognizer, SttError, clean_transcript, heard_speech};

/// Provides the recognizer for the selected speech model.
pub trait RecognizerSource: Send + Sync {
    /// Cheap check run before the microphone opens (engine compiled in, model installed).
    fn ready(&self) -> Result<(), SttError>;
    /// Loads (or reuses) the recognizer. May take a moment the first time.
    fn recognizer(&self) -> Result<Arc<dyn SpeechRecognizer>, SttError>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum VoiceResult {
    Transcript {
        session_id: String,
        mode: KalVoiceMode,
        text: String,
    },
    NothingHeard {
        session_id: String,
        mode: KalVoiceMode,
    },
}

#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
pub enum VoiceError {
    #[error("KalVoice is already listening.")]
    AlreadyListening,
    #[error("KalVoice isn't listening.")]
    NotListening,
    #[error(transparent)]
    Speech(#[from] SttError),
    #[error(transparent)]
    Capture(#[from] CaptureError),
}

impl VoiceError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::AlreadyListening => "already_listening",
            Self::NotListening => "not_listening",
            Self::Speech(e) => e.code(),
            Self::Capture(e) => e.code(),
        }
    }
}

struct Session {
    id: String,
    mode: KalVoiceMode,
    capture: Box<dyn ActiveCapture>,
    started: Instant,
}

pub struct VoiceController {
    core: Arc<Core>,
    audio: Arc<dyn AudioSource>,
    recognizers: Arc<dyn RecognizerSource>,
    active: Mutex<Option<Session>>,
    max: Duration,
}

impl VoiceController {
    pub fn new(
        core: Arc<Core>,
        audio: Arc<dyn AudioSource>,
        recognizers: Arc<dyn RecognizerSource>,
    ) -> Self {
        Self {
            core,
            audio,
            recognizers,
            active: Mutex::new(None),
            max: MAX_RECORDING,
        }
    }

    fn emit(&self, event: EventPayload) {
        let event = NewEvent {
            source: EventSource::KalVoice,
            correlation: Default::default(),
            event,
        };
        if let Err(error) = self.core.emit(event) {
            tracing::warn!(event = "kalvoice.event_failed", error = %error.diagnostic());
        }
    }

    /// The session currently listening, if any.
    pub fn listening(&self) -> Option<(String, KalVoiceMode)> {
        self.active
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .map(|s| (s.id.clone(), s.mode))
    }

    /// Live input level (0–1) of the session listening now, for the waveform.
    pub fn level(&self, session_id: &str) -> Option<f32> {
        self.active
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .filter(|s| s.id == session_id)
            .map(|s| s.capture.level())
    }

    /// Opens the microphone. Returns the session id.
    pub fn begin(&self, mode: KalVoiceMode) -> Result<String, VoiceError> {
        let mut active = self.active.lock().unwrap_or_else(PoisonError::into_inner);
        if active.is_some() {
            return Err(VoiceError::AlreadyListening);
        }
        let id = new_id();
        if let Err(e) = self.recognizers.ready() {
            if mode == KalVoiceMode::Dictation {
                self.emit(EventPayload::KalVoiceDictationFailed {
                    session_id: id,
                    code: e.code().to_owned(),
                });
            }
            return Err(e.into());
        }
        let capture = match self.audio.start(self.max) {
            Ok(capture) => capture,
            Err(e) => {
                if mode == KalVoiceMode::Dictation {
                    self.emit(EventPayload::KalVoiceDictationFailed {
                        session_id: id,
                        code: e.code().to_owned(),
                    });
                }
                return Err(e.into());
            }
        };
        *active = Some(Session {
            id: id.clone(),
            mode,
            capture,
            started: Instant::now(),
        });
        drop(active);
        if mode == KalVoiceMode::Dictation {
            self.emit(EventPayload::KalVoiceDictationStarted {
                session_id: id.clone(),
            });
        }
        Ok(id)
    }

    fn take(&self, session_id: Option<&str>) -> Option<Session> {
        let mut active = self.active.lock().unwrap_or_else(PoisonError::into_inner);
        match (&*active, session_id) {
            (Some(s), Some(id)) if s.id != id => None,
            (Some(_), _) => active.take(),
            (None, _) => None,
        }
    }

    /// Stops listening and transcribes on the device. The audio is zeroed and dropped before
    /// this returns, whatever the outcome. Blocking; call from a background thread.
    pub fn end(&self, session_id: &str) -> Result<VoiceResult, VoiceError> {
        let session = self
            .take(Some(session_id))
            .ok_or(VoiceError::NotListening)?;
        let duration_ms = u64::try_from(session.started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let result = self.transcribe(session.capture, &session.id, session.mode);
        if session.mode == KalVoiceMode::Dictation {
            match &result {
                Ok(VoiceResult::Transcript { text, .. }) => {
                    self.emit(EventPayload::KalVoiceDictationCompleted {
                        session_id: session.id.clone(),
                        duration_ms,
                        characters: u32::try_from(text.chars().count()).unwrap_or(u32::MAX),
                    })
                }
                Ok(VoiceResult::NothingHeard { .. }) => {
                    self.emit(EventPayload::KalVoiceDictationCompleted {
                        session_id: session.id.clone(),
                        duration_ms,
                        characters: 0,
                    })
                }
                Err(e) => self.emit(EventPayload::KalVoiceDictationFailed {
                    session_id: session.id.clone(),
                    code: e.code().to_owned(),
                }),
            }
        }
        result
    }

    fn transcribe(
        &self,
        capture: Box<dyn ActiveCapture>,
        id: &str,
        mode: KalVoiceMode,
    ) -> Result<VoiceResult, VoiceError> {
        let mut audio = capture.finish()?;
        let outcome = if heard_speech(&audio) {
            self.recognizers
                .recognizer()
                .and_then(|r| r.transcribe(&audio))
                .map(|raw| clean_transcript(&raw))
        } else {
            Ok(String::new())
        };
        // The recording never outlives transcription.
        audio.fill(0.0);
        drop(audio);
        let text = outcome?;
        Ok(if text.is_empty() {
            VoiceResult::NothingHeard {
                session_id: id.to_owned(),
                mode,
            }
        } else {
            VoiceResult::Transcript {
                session_id: id.to_owned(),
                mode,
                text,
            }
        })
    }

    /// Stops listening and discards the audio (Escape). `None` cancels whatever is listening.
    pub fn cancel(&self, session_id: Option<&str>) -> bool {
        let Some(session) = self.take(session_id) else {
            return false;
        };
        session.capture.cancel();
        if session.mode == KalVoiceMode::Dictation {
            self.emit(EventPayload::KalVoiceDictationFailed {
                session_id: session.id,
                code: "cancelled".into(),
            });
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use kalcode_core::flags::BuildChannel;
    use kalcode_core::{CoreConfig, Paths};

    /// Test double: "records" a fixed buffer.
    struct FakeAudio {
        samples: Vec<f32>,
        error: Option<CaptureError>,
        starts: AtomicUsize,
    }

    struct FakeCapture(Vec<f32>);

    impl ActiveCapture for FakeCapture {
        fn finish(self: Box<Self>) -> Result<Vec<f32>, CaptureError> {
            Ok(self.0)
        }
        fn cancel(self: Box<Self>) {}
    }

    impl AudioSource for FakeAudio {
        fn start(&self, _max: Duration) -> Result<Box<dyn ActiveCapture>, CaptureError> {
            self.starts.fetch_add(1, Ordering::SeqCst);
            match &self.error {
                Some(e) => Err(e.clone()),
                None => Ok(Box::new(FakeCapture(self.samples.clone()))),
            }
        }
    }

    /// Test double recognizer.
    struct FakeRecognizer(Result<String, SttError>);

    impl SpeechRecognizer for FakeRecognizer {
        fn transcribe(&self, _audio: &[f32]) -> Result<String, SttError> {
            self.0.clone()
        }
    }

    struct FakeSource {
        ready: Result<(), SttError>,
        text: Result<String, SttError>,
    }

    impl RecognizerSource for FakeSource {
        fn ready(&self) -> Result<(), SttError> {
            self.ready.clone()
        }
        fn recognizer(&self) -> Result<Arc<dyn SpeechRecognizer>, SttError> {
            Ok(Arc::new(FakeRecognizer(self.text.clone())))
        }
    }

    fn speech() -> Vec<f32> {
        (0..16_000).map(|i| (i as f32 * 0.05).sin() * 0.3).collect()
    }

    fn setup(
        dir: &std::path::Path,
        samples: Vec<f32>,
        capture_error: Option<CaptureError>,
        ready: Result<(), SttError>,
        text: Result<String, SttError>,
    ) -> (Arc<Core>, Arc<FakeAudio>, VoiceController) {
        let core = Arc::new(
            Core::open(CoreConfig {
                paths: Paths::new(dir),
                app_version: "test".into(),
                channel: BuildChannel::Development,
            })
            .expect("core"),
        );
        let audio = Arc::new(FakeAudio {
            samples,
            error: capture_error,
            starts: AtomicUsize::new(0),
        });
        let controller = VoiceController::new(
            core.clone(),
            audio.clone(),
            Arc::new(FakeSource { ready, text }),
        );
        (core, audio, controller)
    }

    fn kalvoice_events(core: &Core) -> Vec<serde_json::Value> {
        core.recent_events(50, None)
            .expect("events")
            .into_iter()
            .rev()
            .filter(|e| e.event.type_name().starts_with("kalvoice."))
            .map(|e| serde_json::to_value(&e).expect("json"))
            .collect()
    }

    #[test]
    fn dictation_transcribes_and_records_only_facts() {
        let dir = tempfile::tempdir().expect("tempdir");
        let secret = "open the vault combination 1234";
        let (core, _, voice) = setup(
            dir.path(),
            speech(),
            None,
            Ok(()),
            Ok(format!(" {secret} ")),
        );
        let id = voice.begin(KalVoiceMode::Dictation).expect("begin");
        assert_eq!(
            voice.listening(),
            Some((id.clone(), KalVoiceMode::Dictation))
        );
        match voice.end(&id).expect("end") {
            VoiceResult::Transcript { text, .. } => assert_eq!(text, secret),
            other => panic!("{other:?}"),
        }
        assert_eq!(voice.listening(), None);
        let events = kalvoice_events(&core);
        let types: Vec<&str> = events
            .iter()
            .map(|e| e["type"].as_str().unwrap_or(""))
            .collect();
        assert_eq!(
            types,
            ["kalvoice.dictation_started", "kalvoice.dictation_completed"]
        );
        assert_eq!(events[1]["payload"]["characters"], secret.len());
        let all = serde_json::to_string(&events).expect("json");
        assert!(!all.contains("vault"), "events never carry the transcript");
        assert!(!all.contains("1234"));
        // Dictation is never a KalVoice Request.
        let counted: i64 = core
            .read(|c| Ok(c.query_row("SELECT COUNT(*) FROM kalvoice_requests", [], |r| r.get(0))?))
            .expect("count");
        assert_eq!(counted, 0);
    }

    #[test]
    fn silence_is_nothing_heard_without_running_the_model() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (_, _, voice) = setup(
            dir.path(),
            vec![0.0; 16_000],
            None,
            Ok(()),
            Err(SttError::Failed("must not run".into())),
        );
        let id = voice.begin(KalVoiceMode::Command).expect("begin");
        assert!(matches!(
            voice.end(&id),
            Ok(VoiceResult::NothingHeard { .. })
        ));
    }

    #[test]
    fn missing_model_or_engine_fails_before_the_microphone_opens() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (core, audio, voice) = setup(
            dir.path(),
            speech(),
            None,
            Err(SttError::ModelNotInstalled),
            Ok("x".into()),
        );
        let err = voice.begin(KalVoiceMode::Dictation).expect_err("no model");
        assert_eq!(err.code(), "model_not_installed");
        assert_eq!(audio.starts.load(Ordering::SeqCst), 0);
        assert_eq!(
            kalvoice_events(&core)[0]["payload"]["code"],
            "model_not_installed"
        );
    }

    #[test]
    fn microphone_denied_is_reported() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (_, _, voice) = setup(
            dir.path(),
            speech(),
            Some(CaptureError::PermissionDenied),
            Ok(()),
            Ok("x".into()),
        );
        assert_eq!(
            voice
                .begin(KalVoiceMode::Dictation)
                .expect_err("denied")
                .code(),
            "microphone_denied"
        );
        assert_eq!(voice.listening(), None);
    }

    #[test]
    fn one_session_at_a_time_and_cancel() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (core, _, voice) = setup(dir.path(), speech(), None, Ok(()), Ok("x".into()));
        let id = voice.begin(KalVoiceMode::Dictation).expect("begin");
        assert_eq!(
            voice.begin(KalVoiceMode::Command),
            Err(VoiceError::AlreadyListening)
        );
        assert_eq!(voice.end("someone-else"), Err(VoiceError::NotListening));
        assert!(!voice.cancel(Some("someone-else")));
        assert!(voice.cancel(Some(&id)));
        assert_eq!(voice.end(&id), Err(VoiceError::NotListening));
        let last = kalvoice_events(&core).pop().expect("event");
        assert_eq!(last["type"], "kalvoice.dictation_failed");
        assert_eq!(last["payload"]["code"], "cancelled");
    }

    #[test]
    fn command_sessions_emit_no_dictation_events() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (core, _, voice) = setup(
            dir.path(),
            speech(),
            None,
            Ok(()),
            Ok("go to settings".into()),
        );
        let id = voice.begin(KalVoiceMode::Command).expect("begin");
        assert!(matches!(
            voice.end(&id),
            Ok(VoiceResult::Transcript {
                mode: KalVoiceMode::Command,
                ..
            })
        ));
        assert!(kalvoice_events(&core).is_empty());
    }
}
