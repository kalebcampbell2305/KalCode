//! Streaming recognition while the talk key is held (docs/KALVOICE.md, "Latency").
//!
//! whisper.cpp is not a streaming model, so KalVoice streams it the way its own examples do:
//! while the key is held a worker re-decodes the audio captured so far (a context sized to the
//! audio keeps each pass short) and publishes a partial transcript. On release, if everything
//! after the last partial is silence — the common "speak, pause, release" — that partial *is*
//! the final transcript and nothing is decoded again. Otherwise only one more pass runs.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::stt::{SpeechRecognizer, SttError, clean_transcript, heard_speech};

/// Audio the worker needs before its first pass and between passes.
const MIN_NEW_SAMPLES: usize = 4_000; // 250 ms
/// Loudest 30 ms window below this RMS counts as silence for tail reuse.
const TAIL_SILENCE_RMS: f32 = 0.012;

pub type Snapshot = Arc<dyn Fn() -> Option<Vec<f32>> + Send + Sync>;
pub type PartialSink = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Debug, Clone, Default)]
struct Partial {
    text: String,
    covered: usize,
}

#[derive(Default)]
struct Shared {
    stop: AtomicBool,
    last: Mutex<Option<Partial>>,
    first_voice: Mutex<Option<Instant>>,
    first_partial: Mutex<Option<Instant>>,
}

/// How the final transcript was produced, for latency diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FinalSource {
    /// The last partial already covered all the speech.
    ReusedPartial,
    /// One pass over the whole utterance after release.
    FinalPass,
    /// No speech at all.
    Silence,
}

#[derive(Debug, Clone)]
pub struct FinalTranscript {
    pub text: String,
    pub source: FinalSource,
    pub first_voice: Option<Instant>,
    pub first_partial: Option<Instant>,
}

pub struct Streamer {
    shared: Arc<Shared>,
    worker: Option<JoinHandle<()>>,
}

impl Streamer {
    /// Starts publishing partials for the audio `snapshot` returns (None ends the stream).
    pub fn start(
        recognizer: Arc<dyn SpeechRecognizer>,
        snapshot: Snapshot,
        on_partial: PartialSink,
        interval: Duration,
    ) -> Self {
        let shared = Arc::new(Shared::default());
        let worker_shared = shared.clone();
        let worker = std::thread::Builder::new()
            .name("kalvoice-stream".into())
            .spawn(move || {
                run(
                    &worker_shared,
                    recognizer.as_ref(),
                    &snapshot,
                    &on_partial,
                    interval,
                )
            })
            .ok();
        Self { shared, worker }
    }

    /// Stops streaming and returns the final transcript for `audio` (the complete recording).
    pub fn finish(
        mut self,
        audio: &[f32],
        recognizer: &dyn SpeechRecognizer,
    ) -> Result<FinalTranscript, SttError> {
        self.shared.stop.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        let first_voice = *self
            .shared
            .first_voice
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let first_partial = *self
            .shared
            .first_partial
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let done = |text: String, source| FinalTranscript {
            text,
            source,
            first_voice,
            first_partial,
        };
        if !heard_speech(audio) {
            return Ok(done(String::new(), FinalSource::Silence));
        }
        let last = self
            .shared
            .last
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        if let Some(partial) = last
            && !partial.text.is_empty()
            && partial.covered <= audio.len()
            && is_silent(&audio[partial.covered..])
        {
            return Ok(done(partial.text, FinalSource::ReusedPartial));
        }
        let text = clean_transcript(&recognizer.transcribe(audio)?);
        Ok(done(text, FinalSource::FinalPass))
    }

    /// Stops streaming without a final transcript (cancel).
    pub fn cancel(mut self) {
        self.shared.stop.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Drop for Streamer {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::SeqCst);
    }
}

fn run(
    shared: &Shared,
    recognizer: &dyn SpeechRecognizer,
    snapshot: &Snapshot,
    on_partial: &PartialSink,
    interval: Duration,
) {
    let step = Duration::from_millis(20);
    let mut covered = 0usize;
    loop {
        let wait_until = Instant::now() + interval;
        while Instant::now() < wait_until {
            if shared.stop.load(Ordering::SeqCst) {
                return;
            }
            std::thread::sleep(step);
        }
        let Some(mut audio) = snapshot() else { return };
        if audio.len() < covered + MIN_NEW_SAMPLES {
            audio.fill(0.0);
            continue;
        }
        if !heard_speech(&audio) {
            audio.fill(0.0);
            continue;
        }
        {
            let mut first = shared
                .first_voice
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            first.get_or_insert_with(Instant::now);
        }
        let result = recognizer.transcribe(&audio);
        let len = audio.len();
        audio.fill(0.0);
        let Ok(raw) = result else { continue };
        let text = clean_transcript(&raw);
        covered = len;
        let changed = {
            let mut last = shared.last.lock().unwrap_or_else(PoisonError::into_inner);
            let changed = last.as_ref().is_none_or(|p| p.text != text);
            *last = Some(Partial {
                text: text.clone(),
                covered: len,
            });
            changed
        };
        if !text.is_empty() {
            shared
                .first_partial
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .get_or_insert_with(Instant::now);
            if changed && !shared.stop.load(Ordering::SeqCst) {
                on_partial(&text);
            }
        }
    }
}

/// True when no 30 ms window of `tail` is louder than quiet background.
pub fn is_silent(tail: &[f32]) -> bool {
    const WINDOW: usize = 480;
    tail.chunks(WINDOW)
        .map(|w| (w.iter().map(|s| s * s).sum::<f32>() / w.len() as f32).sqrt())
        .all(|rms| rms < TAIL_SILENCE_RMS)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;

    use super::*;

    /// Test double: "recognizes" by reporting how many seconds of voiced audio it saw.
    struct CountingRecognizer {
        calls: AtomicUsize,
    }

    impl SpeechRecognizer for CountingRecognizer {
        fn transcribe(&self, audio: &[f32]) -> Result<String, SttError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let voiced = audio.iter().filter(|s| s.abs() > 0.05).count();
            Ok(format!("voiced {}", voiced / 1_600))
        }
    }

    fn tone(samples: usize) -> Vec<f32> {
        (0..samples)
            .map(|i| (i as f32 * 0.07).sin() * 0.3)
            .collect()
    }

    #[test]
    fn silence_tail_detection() {
        assert!(is_silent(&[]));
        assert!(is_silent(&vec![0.001; 16_000]));
        assert!(!is_silent(&tone(2_000)));
    }

    #[test]
    fn a_partial_covering_all_speech_becomes_the_final_without_another_pass() {
        let recognizer = Arc::new(CountingRecognizer {
            calls: AtomicUsize::new(0),
        });
        let audio = Arc::new(Mutex::new(Vec::<f32>::new()));
        let source = audio.clone();
        let snapshot: Snapshot = Arc::new(move || Some(source.lock().expect("lock").clone()));
        let partials = Arc::new(Mutex::new(Vec::new()));
        let seen = partials.clone();
        let streamer = Streamer::start(
            recognizer.clone(),
            snapshot,
            Arc::new(move |t: &str| seen.lock().expect("lock").push(t.to_owned())),
            Duration::from_millis(30),
        );
        // Speak for a second, then pause.
        audio.lock().expect("lock").extend(tone(16_000));
        std::thread::sleep(Duration::from_millis(250));
        audio.lock().expect("lock").extend(vec![0.0; 8_000]);
        std::thread::sleep(Duration::from_millis(250));
        let calls_before = recognizer.calls.load(Ordering::SeqCst);
        let full = audio.lock().expect("lock").clone();
        let done = streamer.finish(&full, recognizer.as_ref()).expect("final");
        assert_eq!(done.source, FinalSource::ReusedPartial);
        assert_eq!(
            recognizer.calls.load(Ordering::SeqCst),
            calls_before,
            "no pass after release"
        );
        assert!(done.first_partial.is_some() && done.first_voice.is_some());
        assert!(!partials.lock().expect("lock").is_empty());
    }

    #[test]
    fn speech_after_the_last_partial_runs_one_final_pass() {
        let recognizer = Arc::new(CountingRecognizer {
            calls: AtomicUsize::new(0),
        });
        let snapshot: Snapshot = Arc::new(|| None);
        let streamer = Streamer::start(
            recognizer.clone(),
            snapshot,
            Arc::new(|_: &str| {}),
            Duration::from_millis(10),
        );
        let done = streamer
            .finish(&tone(16_000), recognizer.as_ref())
            .expect("final");
        assert_eq!(done.source, FinalSource::FinalPass);
        assert_eq!(recognizer.calls.load(Ordering::SeqCst), 1);
        let silent = Streamer::start(
            recognizer.clone(),
            Arc::new(|| None),
            Arc::new(|_: &str| {}),
            Duration::from_millis(10),
        )
        .finish(&vec![0.0; 16_000], recognizer.as_ref())
        .expect("final");
        assert_eq!(silent.source, FinalSource::Silence);
    }
}
