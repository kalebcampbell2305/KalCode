//! Optional spoken replies through the operating system's speech synthesis (Windows speech,
//! macOS AVSpeechSynthesizer via the `tts` crate). Off by default; never a cloud voice.

/// Runs after the operating-system backend accepts speech for playback.
pub type SpeechStarted = Box<dyn FnOnce() + Send>;
/// Runs when accepted speech settles (`true`) or the backend rejects it (`false`).
pub type SpeechSettled = Box<dyn FnOnce(bool) + Send>;
#[cfg(any(windows, target_os = "macos", test))]
type SpeechCompletion = Box<dyn FnOnce() + Send>;

/// Speaks short replies.
pub trait SpeechOutput: Send + Sync {
    /// Whether the OS voice could be initialized on this machine.
    fn available(&self) -> bool;
    /// Queues `text`, interrupting anything already speaking. `started` runs only after the OS
    /// backend accepts playback. `settled` reports whether accepted speech later ended or the
    /// backend rejected it before playback began.
    fn speak(
        &self,
        text: &str,
        started: SpeechStarted,
        settled: SpeechSettled,
    ) -> Result<(), String>;
    fn stop(&self);
}

#[cfg(any(windows, target_os = "macos", test))]
fn admit_backend_start<T, E>(
    result: Result<T, E>,
    started: SpeechStarted,
    settled: SpeechSettled,
) -> Result<SpeechCompletion, E> {
    match result {
        Ok(_) => {
            started();
            Ok(Box::new(move || settled(true)))
        }
        Err(error) => {
            settled(false);
            Err(error)
        }
    }
}

/// Longest reply KalVoice will read aloud.
pub const MAX_SPOKEN_CHARS: usize = 400;

/// Trims a reply to something reasonable to say out loud.
pub fn spoken_text(summary: &str) -> String {
    let flat = summary.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= MAX_SPOKEN_CHARS {
        return flat;
    }
    let cut: String = flat.chars().take(MAX_SPOKEN_CHARS).collect();
    match cut.rfind(['.', '!', '?']) {
        Some(end) if end > MAX_SPOKEN_CHARS / 2 => cut[..=end].to_owned(),
        _ => format!("{}…", cut.trim_end()),
    }
}

/// No speech output (platforms without an OS voice backend in this build, and tests).
#[derive(Debug, Default, Clone, Copy)]
pub struct Silent;

impl SpeechOutput for Silent {
    fn available(&self) -> bool {
        false
    }
    fn speak(
        &self,
        _text: &str,
        _started: SpeechStarted,
        _settled: SpeechSettled,
    ) -> Result<(), String> {
        Err("Spoken replies aren't available on this system.".into())
    }
    fn stop(&self) {}
}

#[cfg(any(windows, target_os = "macos"))]
pub use os::OsSpeech;

#[cfg(any(windows, target_os = "macos"))]
mod os {
    use std::sync::Mutex;
    use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
    use std::time::Duration;

    use super::{SpeechOutput, SpeechSettled, SpeechStarted, admit_backend_start};

    enum Command {
        Speak(String, SpeechStarted, SpeechSettled),
        Stop,
    }

    /// The OS voice, driven from its own thread (the backend is not thread-safe).
    pub struct OsSpeech {
        commands: Mutex<Option<Sender<Command>>>,
        available: bool,
    }

    impl OsSpeech {
        pub fn start() -> Self {
            let (tx, rx) = mpsc::channel::<Command>();
            let (ready_tx, ready_rx) = mpsc::sync_channel::<bool>(1);
            let spawned = std::thread::Builder::new()
                .name("kalvoice-speech".into())
                .spawn(move || run(rx, ready_tx));
            let available = spawned.is_ok()
                && ready_rx
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap_or(false);
            Self {
                commands: Mutex::new(available.then_some(tx)),
                available,
            }
        }

        fn send(&self, command: Command) -> Result<(), String> {
            let guard = self
                .commands
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            match guard.as_ref() {
                Some(tx) => tx
                    .send(command)
                    .map_err(|_| "The system voice stopped.".to_owned()),
                None => Err("Spoken replies aren't available on this system.".to_owned()),
            }
        }
    }

    fn run(rx: Receiver<Command>, ready: mpsc::SyncSender<bool>) {
        let mut tts = match tts::Tts::default() {
            Ok(tts) => {
                let _ = ready.send(true);
                tts
            }
            Err(error) => {
                tracing::warn!(event = "kalvoice.speech_output_unavailable", error = %error);
                let _ = ready.send(false);
                return;
            }
        };
        let mut pending: Option<Box<dyn FnOnce() + Send>> = None;
        loop {
            // While speaking, poll for the end of speech between commands.
            let wait = if pending.is_some() {
                Duration::from_millis(100)
            } else {
                Duration::from_secs(3600)
            };
            match rx.recv_timeout(wait) {
                Ok(Command::Speak(text, started, settled)) => {
                    if let Some(previous) = pending.take() {
                        previous();
                    }
                    match admit_backend_start(tts.speak(text, true), started, settled) {
                        Ok(done) => pending = Some(done),
                        Err(error) => {
                            tracing::warn!(event = "kalvoice.speech_output_failed", error = %error);
                        }
                    }
                }
                Ok(Command::Stop) => {
                    let _ = tts.stop();
                    if let Some(done) = pending.take() {
                        done();
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    if !tts.is_speaking().unwrap_or(false)
                        && let Some(done) = pending.take()
                    {
                        done();
                    }
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
    }

    impl SpeechOutput for OsSpeech {
        fn available(&self) -> bool {
            self.available
        }

        fn speak(
            &self,
            text: &str,
            started: SpeechStarted,
            settled: SpeechSettled,
        ) -> Result<(), String> {
            self.send(Command::Speak(text.to_owned(), started, settled))
        }

        fn stop(&self) {
            let _ = self.send(Command::Stop);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_replies_are_trimmed_at_a_sentence() {
        assert_eq!(
            spoken_text("  Opened   four\nthreads. "),
            "Opened four threads."
        );
        let long = format!("{} Final sentence here.", "Word ".repeat(120));
        let spoken = spoken_text(&long);
        assert!(spoken.chars().count() <= MAX_SPOKEN_CHARS + 1);
        let sentences = "This is a sentence. ".repeat(40);
        assert!(spoken_text(&sentences).ends_with('.'));
    }

    #[test]
    fn silent_output_is_honest() {
        assert!(!Silent.available());
        assert!(
            Silent
                .speak("hi", Box::new(|| {}), Box::new(|_| {}))
                .is_err()
        );
    }

    #[test]
    fn backend_start_ack_is_truthful_and_ordered() {
        use std::sync::{Arc, Mutex};

        let events = Arc::new(Mutex::new(Vec::new()));
        let started_events = Arc::clone(&events);
        let settled_events = Arc::clone(&events);
        let failed = admit_backend_start(
            Err::<(), _>("backend rejected speech"),
            Box::new(move || started_events.lock().unwrap().push("started")),
            Box::new(move |started| {
                settled_events
                    .lock()
                    .unwrap()
                    .push(if started { "finished" } else { "failed" })
            }),
        );
        match failed {
            Ok(_) => panic!("backend rejection must not return a completion callback"),
            Err(error) => assert_eq!(error, "backend rejected speech"),
        }
        assert_eq!(*events.lock().unwrap(), ["failed"]);

        events.lock().unwrap().clear();
        let started_events = Arc::clone(&events);
        let settled_events = Arc::clone(&events);
        let completion = admit_backend_start(
            Ok::<(), &str>(()),
            Box::new(move || started_events.lock().unwrap().push("started")),
            Box::new(move |started| {
                settled_events
                    .lock()
                    .unwrap()
                    .push(if started { "finished" } else { "failed" })
            }),
        )
        .unwrap();
        assert_eq!(*events.lock().unwrap(), ["started"]);
        completion();
        assert_eq!(*events.lock().unwrap(), ["started", "finished"]);
    }
}
