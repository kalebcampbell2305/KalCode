//! Streaming recognition while the talk key is held (docs/KALVOICE.md, "Latency").
//!
//! whisper.cpp is not a streaming model, so KalVoice streams it the way its own examples do:
//! while the key is held a worker re-decodes the audio captured so far (a context sized to the
//! audio keeps each pass short) and publishes a partial transcript. On release, if everything
//! after the last partial is silence — the common "speak, pause, release" — that partial *is*
//! the final transcript and nothing is decoded again. Otherwise only one more pass runs.
//!
//! Release never waits for a partial pass that can't be used. If the last finished partial
//! covers all the speech, it is the answer at once and the pass still running is cancelled.
//! If the pass still running covers all the speech, finishing it is cheaper than starting over,
//! so release waits for it. Otherwise that pass is cancelled (the engine stops at its next
//! checkpoint and the result is discarded) and one final pass covers the whole recording, so no
//! trailing words are lost.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
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

/// What the worker has decoded, and what it is decoding now. One lock, so release sees a
/// consistent pair.
#[derive(Debug, Default)]
struct Progress {
    last: Option<Partial>,
    /// Samples the pass running now covers.
    in_flight: Option<usize>,
}

#[derive(Default)]
struct Shared {
    /// No new passes (release or cancel).
    stop: AtomicBool,
    /// Abandon the pass running now; its result is discarded.
    cancel: Arc<AtomicBool>,
    progress: Mutex<Progress>,
    first_voice: Mutex<Option<Instant>>,
    first_partial: Mutex<Option<Instant>>,
}

impl Shared {
    fn progress(&self) -> MutexGuard<'_, Progress> {
        self.progress.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn halt(&self) {
        self.stop.store(true, Ordering::SeqCst);
        self.cancel.store(true, Ordering::SeqCst);
    }
}

/// How the final transcript was produced, for latency diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FinalSource {
    /// A partial already covered all the speech.
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
        // Everything after `covered` is silence: a pass over that much has every word.
        let covers = |covered: usize| covered <= audio.len() && is_silent(&audio[covered..]);
        let usable =
            |partial: Option<Partial>| partial.filter(|p| !p.text.is_empty() && covers(p.covered));
        let (last, in_flight) = {
            let progress = self.shared.progress();
            (progress.last.clone(), progress.in_flight)
        };
        let outcome = if !heard_speech(audio) {
            self.abandon_worker();
            (String::new(), FinalSource::Silence)
        } else if let Some(partial) = usable(last) {
            self.abandon_worker();
            (partial.text, FinalSource::ReusedPartial)
        } else if let Some(partial) = in_flight
            .filter(|covered| covers(*covered))
            .and_then(|_| self.wait_for_worker())
            .and_then(|()| usable(self.shared.progress().last.clone()))
        {
            (partial.text, FinalSource::ReusedPartial)
        } else {
            self.abandon_worker();
            (
                clean_transcript(&recognizer.transcribe(audio)?),
                FinalSource::FinalPass,
            )
        };
        let (text, source) = outcome;
        Ok(FinalTranscript {
            text,
            source,
            first_voice: *self
                .shared
                .first_voice
                .lock()
                .unwrap_or_else(PoisonError::into_inner),
            first_partial: *self
                .shared
                .first_partial
                .lock()
                .unwrap_or_else(PoisonError::into_inner),
        })
    }

    /// Cancels the pass in flight and leaves the worker to exit on its own. Not joined: its
    /// copy of the audio is zeroed as soon as the engine stops the pass.
    fn abandon_worker(&mut self) {
        self.shared.halt();
        drop(self.worker.take());
    }

    /// Lets the pass in flight finish (release already stopped any later one).
    fn wait_for_worker(&mut self) -> Option<()> {
        self.worker.take().map(|worker| {
            let _ = worker.join();
        })
    }

    /// Stops streaming without a final transcript (cancel). Cancels a pass in flight and waits
    /// for the worker, so its copy of the audio is gone when this returns.
    pub fn cancel(mut self) {
        self.shared.halt();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Drop for Streamer {
    fn drop(&mut self) {
        self.shared.halt();
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
        {
            // Checked under the lock release reads: either release sees this pass, or this
            // pass sees the release and never starts.
            let mut progress = shared.progress();
            if shared.stop.load(Ordering::SeqCst) {
                audio.fill(0.0);
                return;
            }
            progress.in_flight = Some(audio.len());
        }
        let result = recognizer.transcribe_cancellable(&audio, &shared.cancel);
        let len = audio.len();
        audio.fill(0.0);
        let text = match result {
            // A cancelled pass may have been cut short: never use it.
            _ if shared.cancel.load(Ordering::SeqCst) => {
                shared.progress().in_flight = None;
                return;
            }
            Err(_) => {
                shared.progress().in_flight = None;
                if shared.stop.load(Ordering::SeqCst) {
                    return;
                }
                continue;
            }
            Ok(raw) => clean_transcript(&raw),
        };
        covered = len;
        let changed = {
            let mut progress = shared.progress();
            let changed = progress.last.as_ref().is_none_or(|p| p.text != text);
            progress.last = Some(Partial {
                text: text.clone(),
                covered: len,
            });
            progress.in_flight = None;
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
        if shared.stop.load(Ordering::SeqCst) {
            return;
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

    /// Test double for a slow engine: the first `fast` streaming passes return at once; later
    /// ones take `slow` unless cancelled first. Final passes (`transcribe`) return at once.
    struct SlowRecognizer {
        fast: usize,
        slow: Duration,
        streaming_passes: AtomicUsize,
        final_passes: AtomicUsize,
        in_slow_pass: AtomicBool,
        cancelled_passes: AtomicUsize,
    }

    impl SlowRecognizer {
        fn new(fast: usize, slow: Duration) -> Arc<Self> {
            Arc::new(Self {
                fast,
                slow,
                streaming_passes: AtomicUsize::new(0),
                final_passes: AtomicUsize::new(0),
                in_slow_pass: AtomicBool::new(false),
                cancelled_passes: AtomicUsize::new(0),
            })
        }

        /// Long enough that a test finishing quickly proves nothing waited for it.
        fn stuck(fast: usize) -> Arc<Self> {
            Self::new(fast, Duration::from_secs(10))
        }

        fn text(audio: &[f32]) -> String {
            let voiced = audio.iter().filter(|s| s.abs() > 0.05).count();
            format!("voiced {}", voiced / 1_600)
        }
    }

    impl SpeechRecognizer for SlowRecognizer {
        fn transcribe(&self, audio: &[f32]) -> Result<String, SttError> {
            self.final_passes.fetch_add(1, Ordering::SeqCst);
            Ok(Self::text(audio))
        }

        fn transcribe_cancellable(
            &self,
            audio: &[f32],
            cancel: &Arc<AtomicBool>,
        ) -> Result<String, SttError> {
            let n = self.streaming_passes.fetch_add(1, Ordering::SeqCst);
            if n < self.fast {
                return Ok(Self::text(audio));
            }
            self.in_slow_pass.store(true, Ordering::SeqCst);
            let deadline = Instant::now() + self.slow;
            while Instant::now() < deadline {
                if cancel.load(Ordering::SeqCst) {
                    self.cancelled_passes.fetch_add(1, Ordering::SeqCst);
                    return Err(SttError::Failed("cancelled".into()));
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            Ok(Self::text(audio))
        }
    }

    fn tone(samples: usize) -> Vec<f32> {
        (0..samples)
            .map(|i| (i as f32 * 0.07).sin() * 0.3)
            .collect()
    }

    fn live_audio() -> (Arc<Mutex<Vec<f32>>>, Snapshot) {
        let audio = Arc::new(Mutex::new(Vec::<f32>::new()));
        let source = audio.clone();
        let snapshot: Snapshot = Arc::new(move || Some(source.lock().expect("lock").clone()));
        (audio, snapshot)
    }

    type Partials = Arc<Mutex<Vec<String>>>;

    fn start(recognizer: Arc<dyn SpeechRecognizer>, snapshot: Snapshot) -> (Streamer, Partials) {
        let partials = Partials::default();
        let seen = partials.clone();
        let streamer = Streamer::start(
            recognizer,
            snapshot,
            Arc::new(move |t: &str| seen.lock().expect("lock").push(t.to_owned())),
            Duration::from_millis(10),
        );
        (streamer, partials)
    }

    /// Polls with a hang guard only: never a latency assertion.
    fn wait_for(what: &str, done: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(30);
        while !done() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(5));
        }
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
        let (audio, snapshot) = live_audio();
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
        // A pass the worker had already started may still land; release starts none.
        assert!(
            recognizer.calls.load(Ordering::SeqCst) <= calls_before + 1,
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

    #[test]
    fn release_mid_decode_cancels_a_pass_that_cannot_cover_the_speech() {
        // No fast pass: the first partial pass is still running at release, and the user kept
        // talking after the audio it decodes.
        let recognizer = SlowRecognizer::stuck(0);
        let (audio, snapshot) = live_audio();
        let (streamer, _) = start(recognizer.clone(), snapshot);
        audio.lock().expect("lock").extend(tone(16_000));
        wait_for("a partial pass in flight", || {
            recognizer.in_slow_pass.load(Ordering::SeqCst)
        });
        audio.lock().expect("lock").extend(tone(8_000));
        let full = audio.lock().expect("lock").clone();
        let released = Instant::now();
        let done = streamer.finish(&full, recognizer.as_ref()).expect("final");
        assert!(
            released.elapsed() < Duration::from_secs(2),
            "release waited {:?} for a partial pass",
            released.elapsed()
        );
        // Exactly one final pass, over the whole recording.
        assert_eq!(done.source, FinalSource::FinalPass);
        assert_eq!(done.text, SlowRecognizer::text(&full));
        assert_eq!(recognizer.final_passes.load(Ordering::SeqCst), 1);
        wait_for("the cancelled pass to stop", || {
            recognizer.cancelled_passes.load(Ordering::SeqCst) == 1
        });
    }

    #[test]
    fn speech_after_the_last_partial_is_never_lost_while_a_pass_is_in_flight() {
        // One fast partial over the first second, then a slow pass over more speech, and the
        // user is still talking at release.
        let recognizer = SlowRecognizer::stuck(1);
        let (audio, snapshot) = live_audio();
        let (streamer, partials) = start(recognizer.clone(), snapshot);
        audio.lock().expect("lock").extend(tone(16_000));
        wait_for("the first partial", || {
            !partials.lock().expect("lock").is_empty()
        });
        audio.lock().expect("lock").extend(tone(16_000));
        wait_for("a partial pass in flight", || {
            recognizer.in_slow_pass.load(Ordering::SeqCst)
        });
        audio.lock().expect("lock").extend(tone(4_000));
        let full = audio.lock().expect("lock").clone();
        let released = Instant::now();
        let done = streamer.finish(&full, recognizer.as_ref()).expect("final");
        assert!(released.elapsed() < Duration::from_secs(2));
        assert_eq!(done.source, FinalSource::FinalPass);
        assert_eq!(
            done.text,
            SlowRecognizer::text(&full),
            "the whole recording"
        );
        assert_ne!(
            done.text,
            partials.lock().expect("lock")[0],
            "not the stale partial"
        );
        assert_eq!(recognizer.final_passes.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_silent_tail_reuses_the_partial_without_waiting_for_a_pass_in_flight() {
        let recognizer = SlowRecognizer::stuck(1);
        let (audio, snapshot) = live_audio();
        let (streamer, partials) = start(recognizer.clone(), snapshot);
        audio.lock().expect("lock").extend(tone(16_000));
        wait_for("the first partial", || {
            !partials.lock().expect("lock").is_empty()
        });
        // A pause: the next pass re-decodes speech plus silence and is slow.
        audio.lock().expect("lock").extend(vec![0.0; 8_000]);
        wait_for("a partial pass in flight", || {
            recognizer.in_slow_pass.load(Ordering::SeqCst)
        });
        let full = audio.lock().expect("lock").clone();
        let released = Instant::now();
        let done = streamer.finish(&full, recognizer.as_ref()).expect("final");
        assert!(released.elapsed() < Duration::from_secs(2));
        assert_eq!(done.source, FinalSource::ReusedPartial);
        assert_eq!(done.text, partials.lock().expect("lock")[0]);
        assert_eq!(recognizer.final_passes.load(Ordering::SeqCst), 0);
        wait_for("the cancelled pass to stop", || {
            recognizer.cancelled_passes.load(Ordering::SeqCst) == 1
        });
    }

    #[test]
    fn a_pass_in_flight_that_covers_all_the_speech_is_finished_not_restarted() {
        // No partial finished yet, but the pass running at release already has every word:
        // finishing it beats cancelling it and decoding everything again.
        let recognizer = SlowRecognizer::new(0, Duration::from_millis(150));
        let (audio, snapshot) = live_audio();
        let (streamer, _) = start(recognizer.clone(), snapshot);
        let mut spoken = tone(16_000);
        spoken.extend(vec![0.0; 4_000]);
        audio.lock().expect("lock").extend(spoken);
        wait_for("a partial pass in flight", || {
            recognizer.in_slow_pass.load(Ordering::SeqCst)
        });
        // Only silence after the audio that pass decodes.
        audio.lock().expect("lock").extend(vec![0.0; 1_600]);
        let full = audio.lock().expect("lock").clone();
        let done = streamer.finish(&full, recognizer.as_ref()).expect("final");
        assert_eq!(done.source, FinalSource::ReusedPartial);
        assert_eq!(done.text, SlowRecognizer::text(&full));
        assert_eq!(recognizer.final_passes.load(Ordering::SeqCst), 0);
        assert_eq!(recognizer.cancelled_passes.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn cancel_stops_a_pass_in_flight_and_waits_for_the_worker() {
        let recognizer = SlowRecognizer::stuck(0);
        let (audio, snapshot) = live_audio();
        let (streamer, _) = start(recognizer.clone(), snapshot);
        audio.lock().expect("lock").extend(tone(16_000));
        wait_for("a partial pass in flight", || {
            recognizer.in_slow_pass.load(Ordering::SeqCst)
        });
        let cancelled = Instant::now();
        streamer.cancel();
        assert!(cancelled.elapsed() < Duration::from_secs(2));
        assert_eq!(recognizer.cancelled_passes.load(Ordering::SeqCst), 1);
        assert_eq!(recognizer.final_passes.load(Ordering::SeqCst), 0);
    }
}
