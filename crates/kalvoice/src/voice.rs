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
use crate::latency::StageTimings;
use crate::streaming::{FinalSource, PartialSink, Snapshot, Streamer};
use crate::stt::{SpeechRecognizer, SttError};

/// Provides the recognizer for the selected speech model.
pub trait RecognizerSource: Send + Sync {
    /// Cheap check run before the microphone opens (engine compiled in, model installed).
    fn ready(&self) -> Result<(), SttError>;
    /// Loads (or reuses) the recognizer. May take a moment the first time.
    fn recognizer(&self) -> Result<Arc<dyn SpeechRecognizer>, SttError>;
    /// Validate and retain a recognizer for one take. Sources whose readiness check already
    /// loads the model can override this to avoid repeating that work before capture.
    fn prepare(&self) -> Result<Arc<dyn SpeechRecognizer>, SttError> {
        self.ready()?;
        self.recognizer()
    }
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
        /// How long the key was held, in milliseconds.
        duration_ms: u64,
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

/// Releases a still-pending reservation when `begin_reserved_at` unwinds.
struct SettleStartOnPanic<'a> {
    active: &'a Mutex<VoiceState>,
    id: String,
}

impl Drop for SettleStartOnPanic<'_> {
    fn drop(&mut self) {
        if !std::thread::panicking() {
            return;
        }
        let mut active = self.active.lock().unwrap_or_else(PoisonError::into_inner);
        if matches!(&*active, VoiceState::Starting { id, .. } if id == &self.id) {
            *active = VoiceState::Idle;
        }
    }
}

/// Opaque ownership of the one pending microphone start. Desktop push-to-talk reserves this
/// synchronously before spawning its worker, so only that exact source can cancel the start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VoiceStart {
    id: String,
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
    key_down_to_mic: f64,
    streamer: Streamer,
    recognizer: Arc<dyn SpeechRecognizer>,
}

enum VoiceState {
    Idle,
    /// Exactly one microphone start owns the lane until it returns, even after cancellation.
    /// This prevents a second native device open from overlapping a slow first one.
    Starting {
        id: String,
        cancelled: bool,
    },
    Listening(Session),
}

/// Receives live partial transcripts: `(session_id, text)`.
pub type PartialNotifier = Arc<dyn Fn(&str, &str) + Send + Sync>;

/// A finished listening session and how long each stage took.
#[derive(Debug, Clone, PartialEq)]
pub struct Finished {
    pub result: VoiceResult,
    pub timings: StageTimings,
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

pub struct VoiceController {
    core: Arc<Core>,
    audio: Arc<dyn AudioSource>,
    recognizers: Arc<dyn RecognizerSource>,
    active: Arc<Mutex<VoiceState>>,
    transitions: Mutex<()>,
    max: Duration,
    partials: Mutex<Option<PartialNotifier>>,
    stream_interval: Duration,
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
            active: Arc::new(Mutex::new(VoiceState::Idle)),
            transitions: Mutex::new(()),
            max: MAX_RECORDING,
            partials: Mutex::new(None),
            stream_interval: Duration::from_millis(300),
        }
    }

    /// How often partial transcripts are refreshed while listening.
    pub fn with_stream_interval(mut self, interval: Duration) -> Self {
        self.stream_interval = interval;
        self
    }

    /// Where live partial transcripts go (the desktop forwards them to the UI).
    pub fn set_partial_notifier(&self, notifier: PartialNotifier) {
        *self.partials.lock().unwrap_or_else(PoisonError::into_inner) = Some(notifier);
    }

    /// Loads the speech model ahead of the first key press, so nothing loads on the hot path.
    pub fn warm(&self) -> Result<(), SttError> {
        self.recognizers.prepare().map(|_| ())
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
        match &*self.active.lock().unwrap_or_else(PoisonError::into_inner) {
            VoiceState::Listening(session) => Some((session.id.clone(), session.mode)),
            VoiceState::Idle | VoiceState::Starting { .. } => None,
        }
    }

    /// Whether a microphone start or listening session owns the single capture lane.
    pub fn busy(&self) -> bool {
        !matches!(
            &*self.active.lock().unwrap_or_else(PoisonError::into_inner),
            VoiceState::Idle
        )
    }

    /// Live input level (0–1) of the session listening now, for the waveform.
    pub fn level(&self, session_id: &str) -> Option<f32> {
        let state = self.active.lock().unwrap_or_else(PoisonError::into_inner);
        match &*state {
            VoiceState::Listening(session) if session.id == session_id => {
                Some(session.capture.level())
            }
            VoiceState::Idle | VoiceState::Starting { .. } | VoiceState::Listening(_) => None,
        }
    }

    /// How long the session listening now has been recording.
    pub fn listening_for(&self, session_id: &str) -> Option<Duration> {
        let state = self.active.lock().unwrap_or_else(PoisonError::into_inner);
        match &*state {
            VoiceState::Listening(session) if session.id == session_id => {
                Some(session.started.elapsed())
            }
            VoiceState::Idle | VoiceState::Starting { .. } | VoiceState::Listening(_) => None,
        }
    }

    /// Opens the microphone now. Returns the session id.
    pub fn begin(&self, mode: KalVoiceMode) -> Result<String, VoiceError> {
        self.begin_at(mode, Instant::now())
    }

    /// Opens the microphone for a key pressed at `pressed` (for key-down → mic timing).
    pub fn begin_at(&self, mode: KalVoiceMode, pressed: Instant) -> Result<String, VoiceError> {
        let start = self.reserve_start()?;
        self.begin_reserved_at(start, mode, pressed)
    }

    /// Atomically reserves the single capture lane without performing slow model or device work.
    pub fn reserve_start(&self) -> Result<VoiceStart, VoiceError> {
        let id = new_id();
        let mut active = self.active.lock().unwrap_or_else(PoisonError::into_inner);
        if !matches!(*active, VoiceState::Idle) {
            return Err(VoiceError::AlreadyListening);
        }
        *active = VoiceState::Starting {
            id: id.clone(),
            cancelled: false,
        };
        Ok(VoiceStart { id })
    }

    /// Completes a previously reserved start. Cancellation keeps the lane occupied until this
    /// call observes it, preventing overlapping native microphone opens.
    pub fn begin_reserved_at(
        &self,
        start: VoiceStart,
        mode: KalVoiceMode,
        pressed: Instant,
    ) -> Result<String, VoiceError> {
        let id = start.id;
        // A panic in model preparation or the device open (debug builds unwind) must not leave the
        // single capture lane reserved forever; every normal path settles the reservation itself.
        let _settle_on_panic = SettleStartOnPanic {
            active: &self.active,
            id: id.clone(),
        };
        if !self.start_is_current(&id) {
            return Err(VoiceError::NotListening);
        }
        let recognizer = match self.recognizers.prepare() {
            Ok(recognizer) => recognizer,
            Err(e) => {
                if self.settle_failed_start(&id) {
                    return Err(VoiceError::NotListening);
                }
                if mode == KalVoiceMode::Dictation {
                    self.emit(EventPayload::KalVoiceDictationFailed {
                        session_id: id.clone(),
                        code: e.code().to_owned(),
                    });
                }
                return Err(e.into());
            }
        };
        // Cancellation during model preparation must win before a native device open begins.
        if !self.start_is_current(&id) {
            return Err(VoiceError::NotListening);
        }
        let capture = match self.audio.start_cancellable(self.max, &|| {
            !matches!(
                &*self.active.lock().unwrap_or_else(PoisonError::into_inner),
                VoiceState::Starting { id: current, cancelled: false } if current == &id
            )
        }) {
            Ok(capture) => capture,
            Err(e) => {
                if self.settle_failed_start(&id) {
                    return Err(VoiceError::NotListening);
                }
                if mode == KalVoiceMode::Dictation {
                    self.emit(EventPayload::KalVoiceDictationFailed {
                        session_id: id.clone(),
                        code: e.code().to_owned(),
                    });
                }
                return Err(e.into());
            }
        };
        let key_down_to_mic = ms(pressed.elapsed());
        // Stream partials while the key is held. The model is kept warm, so this doesn't load
        // anything on the hot path after the first use.
        let streamer = {
            let shared = self.active.clone();
            let snapshot_id = id.clone();
            let snapshot: Snapshot = Arc::new(move || {
                let state = shared.lock().unwrap_or_else(PoisonError::into_inner);
                match &*state {
                    VoiceState::Listening(session) if session.id == snapshot_id => {
                        Some(session.capture.snapshot())
                    }
                    VoiceState::Idle | VoiceState::Starting { .. } | VoiceState::Listening(_) => {
                        None
                    }
                }
            });
            let notifier = self
                .partials
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone();
            let partial_id = id.clone();
            let on_partial: PartialSink = Arc::new(move |text: &str| {
                if let Some(notify) = &notifier {
                    notify(&partial_id, text);
                }
            });
            Streamer::start(
                recognizer.clone(),
                snapshot,
                on_partial,
                self.stream_interval,
            )
        };
        let session = Session {
            id: id.clone(),
            mode,
            capture,
            started: Instant::now(),
            key_down_to_mic,
            streamer,
            recognizer,
        };
        // Serialize publication and its durable event with cancellation; subscribers can still
        // inspect `active` after its short state lock is released below.
        let _transition = self
            .transitions
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let mut active = self.active.lock().unwrap_or_else(PoisonError::into_inner);
        let publish = matches!(
            &*active,
            VoiceState::Starting {
                id: starting_id,
                cancelled: false,
            } if starting_id == &id
        );
        if publish {
            *active = VoiceState::Listening(session);
        } else {
            if matches!(&*active, VoiceState::Starting { id: starting_id, .. } if starting_id == &id)
            {
                *active = VoiceState::Idle;
            }
            drop(active);
            session.streamer.cancel();
            session.capture.cancel();
            return Err(VoiceError::NotListening);
        }
        drop(active);
        if mode == KalVoiceMode::Dictation {
            self.emit(EventPayload::KalVoiceDictationStarted {
                session_id: id.clone(),
            });
        }
        Ok(id)
    }

    /// Returns whether this start was cancelled (or superseded) while a slow step failed, and
    /// releases its lane. A normal failure returns `false` so its specific error remains visible.
    fn settle_failed_start(&self, session_id: &str) -> bool {
        let mut active = self.active.lock().unwrap_or_else(PoisonError::into_inner);
        let cancelled = match &*active {
            VoiceState::Starting { id, cancelled } if id == session_id => *cancelled,
            _ => true,
        };
        if matches!(&*active, VoiceState::Starting { id, .. } if id == session_id) {
            *active = VoiceState::Idle;
        }
        cancelled
    }

    /// Revalidates the reservation immediately before native capture. A cancelled preparation
    /// has finished, so it can release the lane without opening the device.
    fn start_is_current(&self, session_id: &str) -> bool {
        let mut active = self.active.lock().unwrap_or_else(PoisonError::into_inner);
        match &*active {
            VoiceState::Starting {
                id,
                cancelled: false,
            } if id == session_id => true,
            VoiceState::Starting { id, .. } if id == session_id => {
                *active = VoiceState::Idle;
                false
            }
            _ => false,
        }
    }

    fn take(&self, session_id: Option<&str>) -> Option<Session> {
        let mut active = self.active.lock().unwrap_or_else(PoisonError::into_inner);
        let take = match (&*active, session_id) {
            (VoiceState::Listening(session), Some(id)) => session.id == id,
            (VoiceState::Listening(_), None) => true,
            (VoiceState::Idle | VoiceState::Starting { .. }, _) => false,
        };
        if !take {
            return None;
        }
        match std::mem::replace(&mut *active, VoiceState::Idle) {
            VoiceState::Listening(session) => Some(session),
            VoiceState::Idle | VoiceState::Starting { .. } => unreachable!(),
        }
    }

    /// Stops listening and finishes recognition on the device. The audio is zeroed and dropped
    /// before this returns, whatever the outcome; a partial pass cancelled by the release zeroes
    /// its own earlier copy the moment the engine stops it. Blocking; call from a background
    /// thread.
    pub fn end(&self, session_id: &str) -> Result<VoiceResult, VoiceError> {
        self.end_timed(session_id).map(|f| f.result)
    }

    /// As [`Self::end`], with the stage timings of this interaction.
    pub fn end_timed(&self, session_id: &str) -> Result<Finished, VoiceError> {
        self.end_timed_at(session_id, Instant::now())
    }

    /// As [`Self::end_timed`], for a key released at `key_up` (taken where the release was
    /// observed, before any thread hand-off, so key-up timings include that hand-off).
    pub fn end_timed_at(&self, session_id: &str, key_up: Instant) -> Result<Finished, VoiceError> {
        let session = {
            let _transition = self
                .transitions
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            self.take(Some(session_id))
                .ok_or(VoiceError::NotListening)?
        };
        let duration_ms = u64::try_from(session.started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let id = session.id.clone();
        let mode = session.mode;
        let result = self.finish(session, key_up);
        if mode == KalVoiceMode::Dictation {
            match &result {
                Ok(Finished {
                    result: VoiceResult::Transcript { text, .. },
                    ..
                }) => self.emit(EventPayload::KalVoiceDictationCompleted {
                    session_id: id.clone(),
                    duration_ms,
                    characters: u32::try_from(text.chars().count()).unwrap_or(u32::MAX),
                }),
                Ok(_) => self.emit(EventPayload::KalVoiceDictationCompleted {
                    session_id: id.clone(),
                    duration_ms,
                    characters: 0,
                }),
                Err(e) => self.emit(EventPayload::KalVoiceDictationFailed {
                    session_id: id.clone(),
                    code: e.code().to_owned(),
                }),
            }
        }
        result
    }

    fn finish(&self, session: Session, key_up: Instant) -> Result<Finished, VoiceError> {
        let Session {
            id,
            mode,
            capture,
            key_down_to_mic,
            streamer,
            recognizer,
            started,
        } = session;
        let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let mut audio = match capture.finish() {
            Ok(audio) => audio,
            Err(e) => {
                streamer.cancel();
                return Err(e.into());
            }
        };
        let key_up_to_audio_final = ms(key_up.elapsed());
        tracing::info!(
            event = "kalvoice.latency_stage",
            stage = "audio_finalized",
            from = "ptt_up",
            ms = key_up_to_audio_final
        );
        // Keep the exact verified model used for partials. Re-selecting it after release adds
        // trust-store I/O and can mix models if preferences changed while the key was held.
        let outcome = streamer.finish(&audio, recognizer.as_ref());
        // The recording never outlives recognition.
        audio.fill(0.0);
        drop(audio);
        let done = outcome?;
        let timings = StageTimings {
            key_down_to_mic: Some(key_down_to_mic),
            speech_to_partial: match (done.first_voice, done.first_partial) {
                (Some(voice), Some(partial)) => Some(ms(partial.saturating_duration_since(voice))),
                _ => None,
            },
            key_up_to_final: Some(ms(key_up.elapsed())),
            final_source: Some(
                match done.source {
                    FinalSource::ReusedPartial => "reused_partial",
                    FinalSource::FinalPass => "final_pass",
                    FinalSource::Silence => "silence",
                }
                .to_owned(),
            ),
            key_up_to_audio_final: Some(key_up_to_audio_final),
            ..StageTimings::default()
        };
        let result = if done.text.is_empty() {
            VoiceResult::NothingHeard {
                session_id: id,
                mode,
            }
        } else {
            VoiceResult::Transcript {
                session_id: id,
                mode,
                text: done.text,
                duration_ms,
            }
        };
        Ok(Finished { result, timings })
    }

    /// Stops listening and discards the audio (Escape). `None` cancels whatever is listening.
    pub fn cancel(&self, session_id: Option<&str>) -> bool {
        let _transition = self
            .transitions
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        {
            let mut active = self.active.lock().unwrap_or_else(PoisonError::into_inner);
            if let VoiceState::Starting { id, cancelled } = &mut *active
                && session_id.is_none_or(|expected| expected == id)
            {
                *cancelled = true;
                return true;
            }
        }
        let Some(session) = self.take(session_id) else {
            return false;
        };
        session.streamer.cancel();
        session.capture.cancel();
        if session.mode == KalVoiceMode::Dictation {
            self.emit(EventPayload::KalVoiceDictationFailed {
                session_id: session.id,
                code: "cancelled".into(),
            });
        }
        true
    }

    /// Cancels only this exact pending start. It cannot affect an orb/direct IPC session that
    /// began later or a reservation owned by another physical source.
    pub fn cancel_start(&self, start: &VoiceStart) -> bool {
        {
            let mut active = self.active.lock().unwrap_or_else(PoisonError::into_inner);
            if let VoiceState::Starting { id, cancelled } = &mut *active
                && id == &start.id
            {
                *cancelled = true;
                return true;
            }
        }
        // The microphone may have committed between a source releasing its reservation and this
        // exact cancellation. The reservation id is also the session id, so this still cannot
        // affect a newer direct/orb take.
        self.cancel(Some(&start.id))
    }

    /// Lifecycle reset invalidates an opening device, while an established take can still be
    /// finished normally (for example when focus loss substitutes for a missed key release).
    pub fn cancel_pending_start(&self) -> bool {
        let mut active = self.active.lock().unwrap_or_else(PoisonError::into_inner);
        if let VoiceState::Starting { cancelled, .. } = &mut *active {
            *cancelled = true;
            true
        } else {
            false
        }
    }

    /// Releases an exact reservation that was never handed to [`Self::begin_reserved_at`].
    /// Callers must only use this when worker creation failed, so no slow start can still be
    /// running for the token.
    pub fn abandon_start(&self, start: &VoiceStart) -> bool {
        let mut active = self.active.lock().unwrap_or_else(PoisonError::into_inner);
        if matches!(&*active, VoiceState::Starting { id, .. } if id == &start.id) {
            *active = VoiceState::Idle;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::thread;

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

    /// A microphone whose open is controlled by the test. This reproduces a slow native device
    /// without relying on a real driver, permission prompt, or wall-clock sleep inside `start`.
    struct ControlledStartAudio {
        entered: mpsc::SyncSender<()>,
        release: Mutex<mpsc::Receiver<()>>,
        result: Result<Vec<f32>, CaptureError>,
    }

    impl AudioSource for ControlledStartAudio {
        fn start(&self, _max: Duration) -> Result<Box<dyn ActiveCapture>, CaptureError> {
            self.entered.send(()).expect("observe microphone start");
            self.release
                .lock()
                .expect("release receiver")
                .recv()
                .expect("release microphone start");
            self.result
                .clone()
                .map(|samples| Box::new(FakeCapture(samples)) as Box<dyn ActiveCapture>)
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

    struct ControlledPrepareSource {
        entered: mpsc::SyncSender<()>,
        release: Mutex<mpsc::Receiver<()>>,
    }

    impl RecognizerSource for ControlledPrepareSource {
        fn ready(&self) -> Result<(), SttError> {
            Ok(())
        }

        fn recognizer(&self) -> Result<Arc<dyn SpeechRecognizer>, SttError> {
            unreachable!("the controlled source overrides prepare")
        }

        fn prepare(&self) -> Result<Arc<dyn SpeechRecognizer>, SttError> {
            self.entered.send(()).expect("observe recognizer prepare");
            self.release
                .lock()
                .expect("prepare release receiver")
                .recv()
                .expect("release recognizer prepare");
            Ok(Arc::new(FakeRecognizer(Ok(String::new()))))
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
            Core::open_with_migrations(
                CoreConfig {
                    paths: Paths::new(dir),
                    app_version: "test".into(),
                    channel: BuildChannel::Development,
                },
                kalcode_core::db::MIGRATIONS,
            )
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
    fn dictation_started_is_persisted_before_concurrent_cancellation() {
        assert_started_before_terminal_transition(true);
    }

    #[test]
    fn dictation_started_is_persisted_before_concurrent_finish() {
        assert_started_before_terminal_transition(false);
    }

    fn assert_started_before_terminal_transition(cancel_take: bool) {
        let dir = tempfile::tempdir().expect("tempdir");
        let (core, _, voice) = setup(dir.path(), Vec::new(), None, Ok(()), Ok(String::new()));
        let voice = Arc::new(voice);
        let (locked_tx, locked_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let locked_core = core.clone();
        let blocker = thread::spawn(move || {
            locked_core.read(|_| {
                locked_tx.send(()).expect("report core lock");
                let _ = release_rx.recv();
                Ok(())
            })
        });
        locked_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("core locked");
        let starting_voice = voice.clone();
        let start = thread::spawn(move || starting_voice.begin(KalVoiceMode::Dictation));
        let deadline = Instant::now() + Duration::from_secs(2);
        while voice.listening().is_none() && Instant::now() < deadline {
            thread::yield_now();
        }
        let published = voice.listening().is_some();
        let id = voice.listening().map(|(id, _)| id).unwrap_or_default();
        let transition_held = voice.transitions.try_lock().is_err();
        let cancelling_voice = voice.clone();
        let (cancel_entered_tx, cancel_entered_rx) = mpsc::channel();
        let (cancelled_tx, cancelled_rx) = mpsc::channel();
        let cancel = thread::spawn(move || {
            cancel_entered_tx.send(()).expect("report cancel entry");
            let result = if cancel_take {
                cancelling_voice.cancel(None)
            } else {
                cancelling_voice.end(&id).is_ok()
            };
            cancelled_tx.send(result).expect("report cancellation");
            result
        });
        cancel_entered_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("cancel entered");
        let waiting = cancelled_rx
            .recv_timeout(Duration::from_millis(100))
            .is_err();
        let retained_until_event = voice.listening().is_some();
        // Release the real Core lock and join every worker before asserting the failing path.
        drop(release_tx);
        blocker.join().expect("core blocker").expect("core read");
        let begun = start.join().expect("begin worker");
        let cancelled = cancel.join().expect("cancel worker");
        assert!(published && transition_held && waiting && retained_until_event);
        assert!(begun.is_ok() && cancelled);
        assert_eq!(voice.listening(), None);
        let events = kalvoice_events(&core);
        let types: Vec<&str> = events
            .iter()
            .map(|e| e["type"].as_str().unwrap_or(""))
            .collect();
        assert_eq!(
            types,
            [
                "kalvoice.dictation_started",
                if cancel_take {
                    "kalvoice.dictation_failed"
                } else {
                    "kalvoice.dictation_completed"
                }
            ]
        );
        if cancel_take {
            assert_eq!(events[1]["payload"]["code"], "cancelled");
        }
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
    fn cancel_returns_promptly_while_microphone_start_is_pending() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (core, _, _) = setup(dir.path(), Vec::new(), None, Ok(()), Ok(String::new()));
        let (entered_tx, entered_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let voice = Arc::new(VoiceController::new(
            core,
            Arc::new(ControlledStartAudio {
                entered: entered_tx,
                release: Mutex::new(release_rx),
                result: Ok(Vec::new()),
            }),
            Arc::new(FakeSource {
                ready: Ok(()),
                text: Ok(String::new()),
            }),
        ));

        let begin_voice = voice.clone();
        let begin = thread::spawn(move || begin_voice.begin(KalVoiceMode::Talk));
        entered_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("begin reached microphone start");

        let cancel_voice = voice.clone();
        let (cancel_started_tx, cancel_started_rx) = mpsc::sync_channel(1);
        let (cancelled_tx, cancelled_rx) = mpsc::sync_channel(1);
        let cancel = thread::spawn(move || {
            cancel_started_tx.send(()).expect("observe cancel thread");
            cancelled_tx
                .send(cancel_voice.cancel(None))
                .expect("report cancel result");
        });
        cancel_started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("cancel thread started");

        let prompt_cancel = cancelled_rx.recv_timeout(Duration::from_millis(250));

        // Release every controlled blocker before asserting, so a failed regression can never
        // strand a test thread or the suite process.
        release_tx.send(()).expect("release microphone start");
        let begin_result = begin.join().expect("begin thread");
        if prompt_cancel.is_err() {
            cancelled_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("blocked cancel settled after microphone start");
        }
        cancel.join().expect("cancel thread");
        let late_session = voice.listening();
        if let Some((session_id, _)) = &late_session {
            let _ = voice.cancel(Some(session_id));
        }

        assert_eq!(
            prompt_cancel,
            Ok(true),
            "cancel must promptly invalidate a pending microphone start"
        );
        assert_eq!(begin_result, Err(VoiceError::NotListening));
        assert_eq!(late_session, None, "a cancelled start cannot publish late");
    }

    #[test]
    fn cancellation_during_recognizer_prepare_skips_microphone_open() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (core, audio, _) = setup(dir.path(), Vec::new(), None, Ok(()), Ok(String::new()));
        let (entered_tx, entered_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let voice = Arc::new(VoiceController::new(
            core,
            audio.clone(),
            Arc::new(ControlledPrepareSource {
                entered: entered_tx,
                release: Mutex::new(release_rx),
            }),
        ));

        let begin_voice = voice.clone();
        let begin = thread::spawn(move || begin_voice.begin(KalVoiceMode::Talk));
        entered_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("begin reached recognizer prepare");
        let cancel_voice = voice.clone();
        let (cancelled_tx, cancelled_rx) = mpsc::sync_channel(1);
        let cancel = thread::spawn(move || {
            cancelled_tx
                .send(cancel_voice.cancel(None))
                .expect("report cancel result");
        });
        let prompt_cancel = cancelled_rx.recv_timeout(Duration::from_millis(250));

        release_tx.send(()).expect("release recognizer prepare");
        let begin_result = begin.join().expect("begin thread");
        if prompt_cancel.is_err() {
            cancelled_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("blocked cancel settled after recognizer prepare");
        }
        cancel.join().expect("cancel thread");

        assert_eq!(prompt_cancel, Ok(true));
        assert_eq!(begin_result, Err(VoiceError::NotListening));
        assert_eq!(
            audio.starts.load(Ordering::SeqCst),
            0,
            "a cancelled preparation must not open the microphone"
        );
    }

    struct PanickingPrepareSource;

    impl RecognizerSource for PanickingPrepareSource {
        fn ready(&self) -> Result<(), SttError> {
            Ok(())
        }

        fn recognizer(&self) -> Result<Arc<dyn SpeechRecognizer>, SttError> {
            unreachable!("the panicking source overrides prepare")
        }

        fn prepare(&self) -> Result<Arc<dyn SpeechRecognizer>, SttError> {
            panic!("recognizer preparation panicked")
        }
    }

    #[test]
    fn a_panicking_start_releases_the_capture_lane() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (core, audio, _) = setup(dir.path(), Vec::new(), None, Ok(()), Ok(String::new()));
        let voice = Arc::new(VoiceController::new(
            core,
            audio.clone(),
            Arc::new(PanickingPrepareSource),
        ));
        let begin_voice = voice.clone();
        assert!(
            thread::spawn(move || begin_voice.begin(KalVoiceMode::Talk))
                .join()
                .is_err(),
            "the start panicked"
        );
        assert!(
            !voice.busy(),
            "push-to-talk must not stay dead after a panic"
        );
        assert!(voice.reserve_start().is_ok());
        assert_eq!(audio.starts.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn capture_failure_after_cancellation_is_silent() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (core, _, _) = setup(dir.path(), Vec::new(), None, Ok(()), Ok(String::new()));
        let (entered_tx, entered_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let voice = Arc::new(VoiceController::new(
            core.clone(),
            Arc::new(ControlledStartAudio {
                entered: entered_tx,
                release: Mutex::new(release_rx),
                result: Err(CaptureError::Busy),
            }),
            Arc::new(FakeSource {
                ready: Ok(()),
                text: Ok(String::new()),
            }),
        ));

        let begin_voice = voice.clone();
        let begin = thread::spawn(move || begin_voice.begin(KalVoiceMode::Dictation));
        entered_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("begin reached microphone start");
        assert!(voice.cancel(None));
        release_tx.send(()).expect("release microphone start");

        assert_eq!(
            begin.join().expect("begin thread"),
            Err(VoiceError::NotListening)
        );
        assert_eq!(voice.listening(), None);
        assert!(
            kalvoice_events(&core).is_empty(),
            "a cancelled start must not publish started or failed events"
        );
    }

    #[test]
    fn a_stale_start_token_cannot_cancel_a_new_direct_session() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (core, _, _) = setup(dir.path(), Vec::new(), None, Ok(()), Ok(String::new()));
        let voice = VoiceController::new(
            core,
            Arc::new(FakeAudio {
                samples: Vec::new(),
                error: None,
                starts: AtomicUsize::new(0),
            }),
            Arc::new(FakeSource {
                ready: Ok(()),
                text: Ok(String::new()),
            }),
        );

        let stale = voice.reserve_start().expect("reserve push-to-talk start");
        assert_eq!(
            voice.begin(KalVoiceMode::Talk),
            Err(VoiceError::AlreadyListening),
            "a direct start cannot overtake the reserved microphone lane"
        );
        assert!(voice.abandon_start(&stale));

        let direct = voice.begin(KalVoiceMode::Talk).expect("direct session");
        assert!(!voice.cancel_start(&stale));
        assert_eq!(
            voice.listening(),
            Some((direct.clone(), KalVoiceMode::Talk)),
            "a stale push-to-talk release cannot cancel a newer direct session"
        );
        assert!(voice.cancel(Some(&direct)));
    }

    #[test]
    fn a_take_keeps_its_recognizer_and_the_next_take_rechecks_the_source() {
        struct ChangingSource(AtomicUsize);
        impl RecognizerSource for ChangingSource {
            fn ready(&self) -> Result<(), SttError> {
                Ok(())
            }
            fn recognizer(&self) -> Result<Arc<dyn SpeechRecognizer>, SttError> {
                let take = self.0.fetch_add(1, Ordering::SeqCst);
                Ok(Arc::new(FakeRecognizer(Ok(format!("model {take}")))))
            }
        }
        let dir = tempfile::tempdir().expect("tempdir");
        let (core, audio, _) = setup(dir.path(), speech(), None, Ok(()), Ok("unused".into()));
        let source = Arc::new(ChangingSource(AtomicUsize::new(0)));
        let voice = VoiceController::new(core, audio, source.clone());
        for take in 0..2 {
            let id = voice.begin(KalVoiceMode::Talk).expect("begin");
            match voice.end(&id).expect("end") {
                VoiceResult::Transcript { text, .. } => assert_eq!(text, format!("model {take}")),
                other => panic!("{other:?}"),
            }
            assert_eq!(source.0.load(Ordering::SeqCst), take + 1);
        }
    }

    #[test]
    fn recognizer_acquisition_failure_does_not_open_the_microphone() {
        struct UnavailableSource;
        impl RecognizerSource for UnavailableSource {
            fn ready(&self) -> Result<(), SttError> {
                Ok(())
            }
            fn recognizer(&self) -> Result<Arc<dyn SpeechRecognizer>, SttError> {
                Err(SttError::ModelNotInstalled)
            }
        }
        let dir = tempfile::tempdir().expect("tempdir");
        let (core, audio, _) = setup(dir.path(), speech(), None, Ok(()), Ok("unused".into()));
        let voice = VoiceController::new(core.clone(), audio.clone(), Arc::new(UnavailableSource));
        assert_eq!(
            voice.begin(KalVoiceMode::Dictation),
            Err(VoiceError::Speech(SttError::ModelNotInstalled))
        );
        assert_eq!(audio.starts.load(Ordering::SeqCst), 0);
        assert!(voice.listening().is_none());
        assert_eq!(
            kalvoice_events(&core)[0]["payload"]["code"],
            "model_not_installed"
        );
    }

    #[test]
    fn cancelling_a_take_releases_its_pinned_recognizer() {
        struct TrackedSource(Mutex<std::sync::Weak<dyn SpeechRecognizer>>);
        impl RecognizerSource for TrackedSource {
            fn ready(&self) -> Result<(), SttError> {
                Ok(())
            }
            fn recognizer(&self) -> Result<Arc<dyn SpeechRecognizer>, SttError> {
                let recognizer: Arc<dyn SpeechRecognizer> =
                    Arc::new(FakeRecognizer(Ok("unused".into())));
                *self.0.lock().expect("track") = Arc::downgrade(&recognizer);
                Ok(recognizer)
            }
        }
        let dir = tempfile::tempdir().expect("tempdir");
        let (core, audio, _) = setup(dir.path(), speech(), None, Ok(()), Ok("unused".into()));
        let initial: Arc<dyn SpeechRecognizer> = Arc::new(FakeRecognizer(Ok("unused".into())));
        let source = Arc::new(TrackedSource(Mutex::new(Arc::downgrade(&initial))));
        drop(initial);
        let voice = VoiceController::new(core, audio, source.clone());
        let id = voice.begin(KalVoiceMode::Talk).expect("begin");
        assert!(source.0.lock().expect("track").upgrade().is_some());
        assert!(voice.cancel(Some(&id)));
        assert!(source.0.lock().expect("track").upgrade().is_none());
        assert!(voice.listening().is_none());
    }

    #[test]
    fn warm_and_takes_use_the_sources_single_preparation_path() {
        struct PreparedSource(AtomicUsize);
        impl RecognizerSource for PreparedSource {
            fn ready(&self) -> Result<(), SttError> {
                panic!("must not repeat legacy readiness")
            }
            fn recognizer(&self) -> Result<Arc<dyn SpeechRecognizer>, SttError> {
                panic!("must not repeat legacy model acquisition")
            }
            fn prepare(&self) -> Result<Arc<dyn SpeechRecognizer>, SttError> {
                self.0.fetch_add(1, Ordering::SeqCst);
                Ok(Arc::new(FakeRecognizer(Ok("open settings".into()))))
            }
        }
        let dir = tempfile::tempdir().expect("tempdir");
        let (core, audio, _) = setup(dir.path(), speech(), None, Ok(()), Ok("unused".into()));
        let source = Arc::new(PreparedSource(AtomicUsize::new(0)));
        let voice = VoiceController::new(core, audio, source.clone());
        voice.warm().expect("warm");
        assert_eq!(source.0.load(Ordering::SeqCst), 1);
        let id = voice.begin(KalVoiceMode::Talk).expect("begin");
        assert_eq!(source.0.load(Ordering::SeqCst), 2);
        voice.end(&id).expect("end");
        assert_eq!(source.0.load(Ordering::SeqCst), 2);
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
    fn key_up_timings_start_where_the_release_was_observed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (_, _, voice) = setup(dir.path(), speech(), None, Ok(()), Ok("go".into()));
        let id = voice.begin(KalVoiceMode::Command).expect("begin");
        let key_up = Instant::now();
        std::thread::sleep(Duration::from_millis(20));
        let timings = voice.end_timed_at(&id, key_up).expect("end").timings;
        let audio_final = timings.key_up_to_audio_final.expect("audio finalized");
        let final_ms = timings.key_up_to_final.expect("final");
        assert!(audio_final >= 20.0, "includes the hand-off: {audio_final}");
        assert!(final_ms >= audio_final);
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
