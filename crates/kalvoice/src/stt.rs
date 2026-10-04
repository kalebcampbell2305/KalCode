//! On-device speech recognition.
//!
//! [`SpeechRecognizer`] is the seam; the real implementation is whisper.cpp through `whisper-rs`
//! (cargo feature `whisper`). Builds without the feature report the engine as unavailable —
//! they never pretend to transcribe.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, PoisonError};

/// Product words that should be stable even before KalCode has a workspace open.
#[cfg(any(test, feature = "whisper"))]
const PRODUCT_VOCABULARY: &[&str] = &[
    "KalCode",
    "KalVoice",
    "Dashboard",
    "Operations",
    "Runs",
    "Queue",
    "Services",
    "Environments",
    "Activity",
    "Code",
    "terminal",
    "thread",
    "agent",
    "Agent Fleet",
    "workspace",
    "provider account",
    "model",
    "effort",
    "Browser",
    "Favorites",
    "Squads",
    "Recipes",
    "Handoffs",
    "Needs You",
    "Settings",
    "Claude Code",
    "Codex",
    "Cursor",
    "Gemini CLI",
    "Opus",
    "Sonnet",
    "Low effort",
    "Medium effort",
    "High effort",
    "XHigh effort",
    "Max effort",
    "localhost",
    "frontend",
    "backend",
    "tests",
    "review",
    "production",
];

/// The decoder prompt stays small enough for the tiny speech model. Scene names are ordered by
/// relevance by the caller, so the least relevant tail is discarded deterministically.
const MAX_VOCABULARY_TERMS: usize = 64;
const MAX_VOCABULARY_TERM_CHARS: usize = 64;
#[cfg(any(test, feature = "whisper"))]
const MAX_VOCABULARY_PROMPT_BYTES: usize = 768;

/// A bounded, inert set of names used only to bias on-device speech recognition.
///
/// This does not rewrite a transcript. Callers may supply workspace, terminal, thread, account,
/// model, branch, and indexed file names already present in their in-memory scene snapshot.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RecognitionVocabulary {
    terms: Vec<String>,
}

impl RecognitionVocabulary {
    pub fn from_terms<T, S>(terms: T) -> Self
    where
        T: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut accepted = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for raw in terms {
            let Some(term) = sanitize_vocabulary_term(raw.as_ref()) else {
                continue;
            };
            let key = term.to_lowercase();
            if seen.insert(key) {
                accepted.push(term);
            }
            if accepted.len() == MAX_VOCABULARY_TERMS {
                break;
            }
        }
        Self { terms: accepted }
    }

    pub fn terms(&self) -> &[String] {
        &self.terms
    }

    #[cfg(any(test, feature = "whisper"))]
    fn prompt(&self) -> String {
        let mut prompt = String::new();
        let mut seen = std::collections::HashSet::new();
        for term in PRODUCT_VOCABULARY
            .iter()
            .copied()
            .chain(self.terms.iter().map(String::as_str))
        {
            let key = term.to_lowercase();
            if !seen.insert(key) {
                continue;
            }
            let addition = term.len() + usize::from(!prompt.is_empty()) * 2 + 1;
            if prompt.len() + addition > MAX_VOCABULARY_PROMPT_BYTES {
                break;
            }
            if !prompt.is_empty() {
                prompt.push_str(", ");
            }
            prompt.push_str(term);
        }
        if !prompt.is_empty() {
            prompt.push('.');
        }
        prompt
    }
}

fn sanitize_vocabulary_term(raw: &str) -> Option<String> {
    let term = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if term.is_empty()
        || term.chars().count() > MAX_VOCABULARY_TERM_CHARS
        || !term.chars().any(char::is_alphanumeric)
        || !term.chars().all(|character| {
            character.is_alphanumeric()
                || character.is_whitespace()
                || matches!(
                    character,
                    '-' | '_' | '.' | '/' | '\\' | '+' | '#' | '@' | ':' | '\'' | '&'
                )
        })
    {
        return None;
    }
    Some(term)
}

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

    /// Updates decoder-only recognition hints without reloading the speech model. Engines that
    /// do not support hints keep their existing behavior.
    fn configure_vocabulary(&self, _vocabulary: &RecognitionVocabulary) {}

    /// As [`Self::transcribe`], but stops early once `cancel` is set; a pass stopped that way
    /// returns an error and its text must never be used. Engines that cannot stop mid-pass run
    /// it to the end.
    fn transcribe_cancellable(
        &self,
        audio: &[f32],
        cancel: &Arc<AtomicBool>,
    ) -> Result<String, SttError> {
        let _ = cancel;
        self.transcribe(audio)
    }
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
    // A trailing fragment that starts a sentence we already have, or keeps cycling through its
    // first words ("Open 4 Codex threads. Open 4 Open 4 Open"), is the loop being cut off.
    if kept.len() > 1
        && let Some(last) = kept.last()
        && !last.trim_end().ends_with(['.', '!', '?'])
    {
        let fragment = key(last);
        let fragment_words: Vec<&str> = fragment.split_whitespace().collect();
        if kept[..kept.len() - 1].iter().any(|s| {
            let sentence = key(s);
            let words: Vec<&str> = sentence.split_whitespace().collect();
            sentence.starts_with(&fragment) || cycles_through_prefix(&fragment_words, &words)
        }) {
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

/// True when `fragment` is the first `k` words of `sentence` repeated (possibly cut short),
/// for some `k`.
fn cycles_through_prefix(fragment: &[&str], sentence: &[&str]) -> bool {
    if fragment.is_empty() {
        return false;
    }
    (1..=sentence.len().min(fragment.len())).any(|k| {
        fragment
            .iter()
            .enumerate()
            .all(|(i, word)| sentence.get(i % k) == Some(word))
    })
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
    use std::cell::RefCell;
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex, PoisonError};

    use whisper_rs::{
        FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState,
    };

    use super::{
        RecognitionVocabulary, SpeechRecognizer, SttError, clean_transcript, decode_budget,
    };

    const MAX_PROMPT_TOKENS: usize = 224;
    const MAX_TOKENIZED_PROMPT: usize = 1_024;

    thread_local! {
        /// The cancel flag of the pass this thread is running, when that pass can be cancelled.
        static RUNNING_CANCEL: RefCell<Option<Arc<AtomicBool>>> = const { RefCell::new(None) };
    }

    /// whisper.cpp's abort callback: whether the pass running on this thread was cancelled.
    /// whisper.cpp asks on the thread that called `full`, after encoding and after each decoded
    /// token. Asked from any other thread it finds no flag and answers no, so the worst case is
    /// a pass that runs to its end, as it did before cancellation existed.
    fn cancel_requested() -> bool {
        RUNNING_CANCEL
            .try_with(|slot| {
                slot.try_borrow()
                    .ok()
                    .and_then(|flag| flag.as_ref().map(|f| f.load(Ordering::SeqCst)))
                    .unwrap_or(false)
            })
            .unwrap_or(false)
    }

    /// whisper-rs 0.16's `set_abort_callback_safe` stores the closure as a `Box<dyn FnMut>`
    /// but its trampoline reads that pointer as the concrete closure type, which is only sound
    /// for a zero-sized closure (one that captures nothing). This refuses anything else at
    /// compile time; state reaches the callback through `RUNNING_CANCEL` instead.
    fn capture_free<F: FnMut() -> bool + 'static>(callback: F) -> F {
        const {
            assert!(
                std::mem::size_of::<F>() == 0,
                "the abort callback must capture nothing"
            )
        };
        callback
    }

    /// Publishes a pass's cancel flag to the abort callback for as long as it runs.
    struct CancelScope;

    impl CancelScope {
        fn enter(flag: Option<Arc<AtomicBool>>) -> Self {
            let _ = RUNNING_CANCEL.try_with(|slot| {
                if let Ok(mut slot) = slot.try_borrow_mut() {
                    *slot = flag;
                }
            });
            Self
        }
    }

    impl Drop for CancelScope {
        fn drop(&mut self) {
            let _ = RUNNING_CANCEL.try_with(|slot| {
                if let Ok(mut slot) = slot.try_borrow_mut() {
                    *slot = None;
                }
            });
        }
    }

    pub struct WhisperRecognizer {
        context: WhisperContext,
        /// Reused across passes (allocating a state costs tens of milliseconds).
        state: Mutex<Option<WhisperState>>,
        /// Decoder settings, built once and cloned per pass. whisper-rs never frees the strings
        /// or the callback box a `FullParams` allocates (building them per pass leaked a little
        /// on every partial). Built once, they stay valid for as long as any clone can hand
        /// whisper.cpp a pointer to them.
        params: FullParams<'static, 'static>,
        vocabulary: Mutex<VocabularyTokens>,
    }

    struct VocabularyTokens {
        prompt: String,
        tokens: Vec<i32>,
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
            let prompt = RecognitionVocabulary::default().prompt();
            let mut tokens = context
                .tokenize(&prompt, MAX_TOKENIZED_PROMPT)
                .map_err(|e| SttError::ModelLoadFailed(e.to_string()))?;
            tokens.truncate(MAX_PROMPT_TOKENS);
            Ok(Self {
                context,
                state: Mutex::new(Some(state)),
                params: base_params(english_only, i32::try_from(threads).unwrap_or(4)),
                vocabulary: Mutex::new(VocabularyTokens { prompt, tokens }),
            })
        }

        fn run(&self, audio: &[f32], cancel: Option<&Arc<AtomicBool>>) -> Result<String, SttError> {
            let mut slot = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            let state = match slot.as_mut() {
                Some(state) => state,
                None => slot.insert(
                    self.context
                        .create_state()
                        .map_err(|e| SttError::Failed(e.to_string()))?,
                ),
            };
            if cancel.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
                return Err(SttError::Failed("cancelled".into()));
            }
            let budget = decode_budget(audio.len());
            let vocabulary = self
                .vocabulary
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            // Shorten the clone's token lifetime to this guard. whisper.cpp only reads the
            // borrowed slice during `full`, and configuration waits on the same mutex.
            let mut params: FullParams<'static, '_> = self.params.clone();
            params.set_tokens(&vocabulary.tokens);
            // Short utterances don't need whisper's 30 s window: a context sized to the audio
            // cuts the encoder cost several times; the token cap stops repetition loops.
            params.set_audio_ctx(budget.audio_ctx);
            params.set_max_tokens(budget.max_tokens);
            let scope = CancelScope::enter(cancel.cloned());
            let outcome = state.full(params, audio);
            drop(scope);
            drop(vocabulary);
            outcome.map_err(|e| SttError::Failed(e.to_string()))?;
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

    /// Settings shared by every pass.
    fn base_params(english_only: bool, threads: i32) -> FullParams<'static, 'static> {
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some(if english_only { "en" } else { "auto" }));
        params.set_n_threads(threads);
        params.set_translate(false);
        params.set_no_context(true);
        params.set_no_timestamps(true);
        params.set_single_segment(true);
        params.set_suppress_blank(true);
        params.set_suppress_nst(true);
        params.set_temperature_inc(0.0);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_abort_callback_safe(capture_free(cancel_requested));
        params
    }

    impl SpeechRecognizer for WhisperRecognizer {
        fn configure_vocabulary(&self, vocabulary: &RecognitionVocabulary) {
            let prompt = vocabulary.prompt();
            let mut configured = self
                .vocabulary
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if configured.prompt == prompt {
                return;
            }
            let Ok(mut tokens) = self.context.tokenize(&prompt, MAX_TOKENIZED_PROMPT) else {
                return;
            };
            tokens.truncate(MAX_PROMPT_TOKENS);
            *configured = VocabularyTokens { prompt, tokens };
        }

        fn transcribe(&self, audio: &[f32]) -> Result<String, SttError> {
            self.run(audio, None)
        }

        fn transcribe_cancellable(
            &self,
            audio: &[f32],
            cancel: &Arc<AtomicBool>,
        ) -> Result<String, SttError> {
            self.run(audio, Some(cancel))
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn the_abort_callback_sees_only_the_running_passs_flag_on_its_thread() {
            assert!(!cancel_requested(), "no pass running");
            let flag = Arc::new(AtomicBool::new(false));
            let scope = CancelScope::enter(Some(flag.clone()));
            assert!(!cancel_requested());
            flag.store(true, Ordering::SeqCst);
            assert!(cancel_requested());
            // Another thread never sees this pass's flag.
            assert!(!std::thread::spawn(cancel_requested).join().expect("join"));
            drop(scope);
            assert!(!cancel_requested(), "cleared when the pass ends");
            // A pass that can't be cancelled publishes no flag.
            let uncancellable = CancelScope::enter(None);
            assert!(!cancel_requested());
            drop(uncancellable);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognition_vocabulary_is_sanitized_deduplicated_and_code_aware() {
        let vocabulary = RecognitionVocabulary::from_terms([
            " KalCode ",
            "kalcode",
            "kalvoice_commands.rs",
            "feature/voice-control",
            "@scope/package",
            "C++",
            "Kaleb's R&D",
            "Release\nMac",
            "unsafe,separator",
            "hidden\u{202e}name",
            "---",
        ]);

        assert_eq!(
            vocabulary.terms(),
            [
                "KalCode",
                "kalvoice_commands.rs",
                "feature/voice-control",
                "@scope/package",
                "C++",
                "Kaleb's R&D",
                "Release Mac",
            ]
        );
        let prompt = vocabulary.prompt();
        assert!(prompt.starts_with("KalCode, KalVoice, Dashboard"));
        assert_eq!(prompt.matches("KalCode").count(), 1);
        assert!(prompt.contains("kalvoice_commands.rs"));
        assert!(prompt.ends_with('.'));
    }

    #[test]
    fn recognition_vocabulary_prompt_is_bounded_and_keeps_most_relevant_names() {
        let terms: Vec<String> = (0..200)
            .map(|index| format!("workspace-{index:03}-with-a-real-name"))
            .collect();
        let vocabulary = RecognitionVocabulary::from_terms(&terms);
        let prompt = vocabulary.prompt();

        assert_eq!(vocabulary.terms().len(), MAX_VOCABULARY_TERMS);
        assert!(prompt.len() <= MAX_VOCABULARY_PROMPT_BYTES);
        assert!(prompt.contains("workspace-000-with-a-real-name"));
        assert!(!prompt.contains("workspace-199-with-a-real-name"));
    }

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
        // Decoder loops cycling through a sentence's first words (seen on real fixtures).
        assert_eq!(
            clean_transcript("Open 4 Codex threads. Open 4 Open 4 Open 4 Open 4 Open"),
            "Open 4 Codex threads."
        );
        assert_eq!(
            clean_transcript("Split Claude and Codex side by side. Split Split"),
            "Split Claude and Codex side by side."
        );
        // A real second thought is kept.
        assert_eq!(
            clean_transcript("Open dashboard. Then open settings"),
            "Open dashboard. Then open settings"
        );
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
