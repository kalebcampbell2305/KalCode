//! On-device speech recognition.
//!
//! [`SpeechRecognizer`] is the seam; the real implementation is whisper.cpp through `whisper-rs`
//! (cargo feature `whisper`). Builds without the feature report the engine as unavailable —
//! they never pretend to transcribe.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

/// Whether this build includes the whisper.cpp engine.
pub const ENGINE_AVAILABLE: bool = cfg!(feature = "whisper");

#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
pub enum SttError {
    #[error("Download a speech model in Settings, KalVoice, to use dictation.")]
    ModelNotInstalled,
    #[error("This build of KalCode doesn't include the on-device speech engine.")]
    EngineUnavailable,
    #[error("KalVoice couldn't load the speech model. Remove it and download it again.")]
    ModelLoadFailed(String),
    #[error("Speech recognition failed. Try again.")]
    Failed(String),
}

impl SttError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::ModelNotInstalled => "model_not_installed",
            Self::EngineUnavailable => "speech_engine_unavailable",
            Self::ModelLoadFailed(_) => "model_load_failed",
            Self::Failed(_) => "transcription_failed",
        }
    }
}

/// Turns 16 kHz mono audio into text, on the device.
pub trait SpeechRecognizer: Send + Sync {
    fn transcribe(&self, audio: &[f32]) -> Result<String, SttError>;
}

/// Minimum audio worth transcribing (a quarter second).
const MIN_SAMPLES: usize = 4_000;

/// True when the audio plausibly contains speech (not silence or a key click).
pub fn heard_speech(audio: &[f32]) -> bool {
    if audio.len() < MIN_SAMPLES {
        return false;
    }
    // Loudest 50 ms window, so a short phrase in a long silence still counts.
    const WINDOW: usize = 800;
    let loudest = audio
        .chunks(WINDOW)
        .map(|w| (w.iter().map(|s| s * s).sum::<f32>() / w.len() as f32).sqrt())
        .fold(0.0f32, f32::max);
    loudest > 0.01
}

/// Removes whisper's non-speech markers and normalizes whitespace.
pub fn clean_transcript(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut depth_square = 0u32;
    let mut depth_round = 0u32;
    let mut marker = String::new();
    for c in raw.chars() {
        match c {
            '[' => depth_square += 1,
            ']' if depth_square > 0 => {
                depth_square -= 1;
                marker.clear();
            }
            '(' if depth_square == 0 => {
                depth_round += 1;
                marker.clear();
            }
            ')' if depth_round > 0 => {
                depth_round -= 1;
                // Keep ordinary parentheses; drop sound annotations like "(music)".
                let lower = marker.to_lowercase();
                let annotation = [
                    "music",
                    "silence",
                    "applause",
                    "laughter",
                    "inaudible",
                    "noise",
                    "sighs",
                    "coughs",
                    "blank",
                ]
                .iter()
                .any(|w| lower.contains(w));
                if !annotation {
                    out.push('(');
                    out.push_str(&marker);
                    out.push(')');
                }
                marker.clear();
            }
            _ if depth_square > 0 => {}
            _ if depth_round > 0 => marker.push(c),
            _ => out.push(c),
        }
    }
    collapse_repeats(&out.split_whitespace().collect::<Vec<_>>().join(" "))
}

/// Removes the repetition loops small speech models sometimes produce: a sentence repeated
/// back to back ("Open Dashboard. Open Dashboard.") and runs of the same word.
fn collapse_repeats(text: &str) -> String {
    let key = |s: &str| -> String {
        s.chars()
            .filter(|c| c.is_alphanumeric() || c.is_whitespace())
            .collect::<String>()
            .to_lowercase()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            // Spellings of the same provider name shouldn't hide a repeat.
            .replace("code x", "codex")
            .replace("codecs", "codex")
    };
    // Sentences keep their closing punctuation.
    let mut sentences: Vec<&str> = Vec::new();
    let mut start = 0;
    for (i, c) in text.char_indices() {
        if matches!(c, '.' | '!' | '?' | ',') {
            let end = i + c.len_utf8();
            sentences.push(&text[start..end]);
            start = end;
        }
    }
    if start < text.len() {
        sentences.push(&text[start..]);
    }
    let mut kept: Vec<&str> = Vec::new();
    for sentence in sentences {
        let k = key(sentence);
        if k.is_empty() {
            continue;
        }
        // Only multi-word sentences: "yes, yes" is speech, not a loop.
        if k.contains(' ') && kept.last().is_some_and(|last| key(last) == k) {
            continue;
        }
        kept.push(sentence);
    }
    // A trailing fragment that starts a sentence we already have is the loop being cut off.
    if kept.len() > 1
        && let Some(last) = kept.last()
        && !last.trim_end().ends_with(['.', '!', '?'])
    {
        let fragment = key(last);
        if kept[..kept.len() - 1]
            .iter()
            .any(|s| key(s).starts_with(&fragment))
        {
            kept.pop();
        }
    }
    let joined = kept.iter().map(|s| s.trim()).collect::<Vec<_>>().join(" ");
    // A word repeated three or more times in a row is a loop, not speech.
    let mut words: Vec<&str> = Vec::new();
    let mut run = 0;
    for word in joined.split_whitespace() {
        let same = words.last().is_some_and(|last| key(last) == key(word));
        run = if same { run + 1 } else { 1 };
        if run < 3 {
            words.push(word);
        }
    }
    words.join(" ")
}

/// Decoder sizing for an utterance of `samples` (16 kHz): whisper's encoder context in frames
/// (50 per second, at least 384 so short clips stay accurate, at most the full 1500) and a cap
/// on generated tokens (speech runs about 3 tokens a second).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodeBudget {
    pub audio_ctx: i32,
    pub max_tokens: i32,
}

pub fn decode_budget(samples: usize) -> DecodeBudget {
    let secs = samples as f64 / 16_000.0;
    let frames = (secs * 50.0).ceil() as i32 + 64;
    let audio_ctx = (((frames + 63) / 64) * 64).clamp(384, 1500);
    let max_tokens = ((secs * 4.0).ceil() as i32 + 8).clamp(8, 224);
    DecodeBudget {
        audio_ctx,
        max_tokens,
    }
}

/// Loads recognizers for model files and keeps the last one warm.
#[derive(Default)]
pub struct RecognizerCache {
    loaded: Mutex<HashMap<PathBuf, Arc<dyn SpeechRecognizer>>>,
}

impl RecognizerCache {
    pub fn get(
        &self,
        path: &Path,
        english_only: bool,
    ) -> Result<Arc<dyn SpeechRecognizer>, SttError> {
        let mut loaded = self.loaded.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(r) = loaded.get(path) {
            return Ok(r.clone());
        }
        let recognizer = load(path, english_only)?;
        // One model in memory at a time.
        loaded.clear();
        loaded.insert(path.to_path_buf(), recognizer.clone());
        Ok(recognizer)
    }

    /// Frees a model (after it is deleted, or the selection changes).
    pub fn evict(&self, path: &Path) {
        self.loaded
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(path);
    }
}

#[cfg(feature = "whisper")]
fn load(path: &Path, english_only: bool) -> Result<Arc<dyn SpeechRecognizer>, SttError> {
    Ok(Arc::new(whisper::WhisperRecognizer::load(
        path,
        english_only,
    )?))
}

#[cfg(not(feature = "whisper"))]
fn load(_path: &Path, _english_only: bool) -> Result<Arc<dyn SpeechRecognizer>, SttError> {
    Err(SttError::EngineUnavailable)
}

#[cfg(feature = "whisper")]
mod whisper {
    use std::path::Path;
    use std::sync::{Mutex, PoisonError};

    use whisper_rs::{
        FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState,
    };

    use super::{SpeechRecognizer, SttError, clean_transcript, decode_budget};

    const VOCABULARY: &str =
        "KalCode, KalVoice, Claude Code, Codex, Gemini CLI, threads, workspace, terminal.";

    pub struct WhisperRecognizer {
        context: WhisperContext,
        /// Reused across passes (allocating a state costs tens of milliseconds).
        state: Mutex<Option<WhisperState>>,
        english_only: bool,
        threads: i32,
    }

    impl WhisperRecognizer {
        pub fn load(path: &Path, english_only: bool) -> Result<Self, SttError> {
            // Route whisper.cpp's console logging away from stdout.
            whisper_rs::install_logging_hooks();
            let context =
                WhisperContext::new_with_params(path, WhisperContextParameters::default())
                    .map_err(|e| SttError::ModelLoadFailed(e.to_string()))?;
            let state = context
                .create_state()
                .map_err(|e| SttError::ModelLoadFailed(e.to_string()))?;
            let threads = std::thread::available_parallelism()
                .map(|n| n.get().saturating_sub(2).clamp(1, 12))
                .unwrap_or(4);
            Ok(Self {
                context,
                state: Mutex::new(Some(state)),
                english_only,
                threads: i32::try_from(threads).unwrap_or(4),
            })
        }
    }

    impl SpeechRecognizer for WhisperRecognizer {
        fn transcribe(&self, audio: &[f32]) -> Result<String, SttError> {
            let mut slot = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            let state = match slot.as_mut() {
                Some(state) => state,
                None => slot.insert(
                    self.context
                        .create_state()
                        .map_err(|e| SttError::Failed(e.to_string()))?,
                ),
            };
            let budget = decode_budget(audio.len());
            let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
            params.set_language(Some(if self.english_only { "en" } else { "auto" }));
            params.set_n_threads(self.threads);
            params.set_translate(false);
            params.set_no_context(true);
            params.set_no_timestamps(true);
            params.set_single_segment(true);
            params.set_suppress_blank(true);
            params.set_suppress_nst(true);
            params.set_temperature_inc(0.0);
            // Short utterances don't need whisper's 30 s window: a context sized to the audio
            // cuts the encoder cost several times; the token cap stops repetition loops.
            params.set_audio_ctx(budget.audio_ctx);
            params.set_max_tokens(budget.max_tokens);
            params.set_print_special(false);
            params.set_print_progress(false);
            params.set_print_realtime(false);
            params.set_print_timestamps(false);
            // Primes the model with KalCode's vocabulary (product and provider names).
            params.set_initial_prompt(VOCABULARY);
            state
                .full(params, audio)
                .map_err(|e| SttError::Failed(e.to_string()))?;
            let mut text = String::new();
            for segment in state.as_iter() {
                if let Ok(part) = segment.to_str_lossy() {
                    text.push_str(&part);
                    text.push(' ');
                }
            }
            Ok(clean_transcript(&text))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_and_clicks_are_not_speech() {
        assert!(!heard_speech(&[]));
        assert!(!heard_speech(&vec![0.0; 32_000]));
        assert!(!heard_speech(&vec![0.001; 32_000]));
        assert!(!heard_speech(&[0.9; 1_000]), "too short");
        let mut phrase = vec![0.0f32; 48_000];
        for (i, s) in phrase.iter_mut().enumerate().skip(20_000).take(4_000) {
            *s = (i as f32 * 0.1).sin() * 0.2;
        }
        assert!(heard_speech(&phrase));
    }

    #[test]
    fn decode_budget_scales_with_audio() {
        assert_eq!(decode_budget(16_000).audio_ctx, 384);
        assert_eq!(decode_budget(16_000).max_tokens, 12);
        assert_eq!(decode_budget(16_000 * 10).audio_ctx, 576);
        assert_eq!(decode_budget(16_000 * 60).audio_ctx, 1500);
        assert_eq!(decode_budget(16_000 * 120).max_tokens, 224);
    }

    #[test]
    fn transcript_cleanup() {
        assert_eq!(clean_transcript(" [BLANK_AUDIO] "), "");
        assert_eq!(
            clean_transcript("(music) Open four codex threads."),
            "Open four codex threads."
        );
        assert_eq!(
            clean_transcript("  fix the bug   in (the) parser [inaudible] "),
            "fix the bug in (the) parser"
        );
        assert_eq!(clean_transcript("hello\nworld"), "hello world");
        assert_eq!(
            clean_transcript("Open Dashboard. Open dashboard. Open Dashboard."),
            "Open Dashboard."
        );
        assert_eq!(
            clean_transcript("Open for Codex threads, Open for Codex threads, Open for Codex"),
            "Open for Codex threads,"
        );
        assert_eq!(
            clean_transcript("Open open open open the thread"),
            "Open open the thread"
        );
        assert_eq!(clean_transcript("Open dashboard. Open"), "Open dashboard.");
        assert_eq!(
            clean_transcript("Open 4 Codex threads. Open 4 Code X threads."),
            "Open 4 Codex threads."
        );
        assert_eq!(
            clean_transcript("Yes, yes. That works."),
            "Yes, yes. That works."
        );
    }

    #[test]
    fn engine_availability_matches_the_build() {
        let cache = RecognizerCache::default();
        let missing = Path::new("definitely-missing-model.bin");
        let expected = if ENGINE_AVAILABLE {
            "model_load_failed"
        } else {
            "speech_engine_unavailable"
        };
        match cache.get(missing, true) {
            Ok(_) => panic!("a missing model must not load"),
            Err(e) => assert_eq!(e.code(), expected),
        }
    }
}
