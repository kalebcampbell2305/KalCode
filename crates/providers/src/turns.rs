//! Sessions for providers whose headless mode runs **one process per turn** (Codex
//! `codex exec --json`, Gemini CLI `--output-format stream-json`).
//!
//! Neither CLI documents a way to send a second message to a running headless process, so a
//! KalCode session is a sequence of supervised turn processes that share the provider's own
//! session id: the first turn starts a new provider session, each later turn resumes it
//! (`codex exec … resume <thread id>`, `gemini --resume <session id>`). This is how the official
//! Codex TypeScript SDK drives `codex exec` (one process per `run`, the prompt on stdin, the
//! thread id from `thread.started` passed to `resume` next time).
//!
//! Every turn process follows Z2's rules ([`crate::process`]): argv only, the sanitized and
//! hardened provider environment, the native-resolved workspace as the working directory,
//! bounded stdout lines, a redacted stderr tail that is only logged, tree kill on stop. The
//! message is written to stdin and never put on the command line.
//!
//! - **Interrupt** kills the running turn's process tree (the SDK's documented cancellation);
//!   the session stays open and the next message resumes the provider session.
//! - **Terminate** kills any running turn and ends the session (`Exited`).
//! - A turn process that exits non-zero without reporting its own failure becomes a
//!   recoverable `process_exited` error and a failed turn; the session stays usable.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::Duration;

use kalcode_contracts::agent::{
    AgentEvent, AgentEventSink, AgentInput, AgentSession, ProviderError,
};
use kalcode_contracts::permissions::ApprovalDecision;
use kalcode_contracts::threads::ThreadStatus;

use crate::managed::SharedProfileLease;
use crate::process::{OutputLine, ProcessSpec, SupervisedChild};

/// Largest single message KalCode sends (as for Claude Code).
pub const MAX_INPUT_BYTES: usize = 1024 * 1024;
/// How long a turn process may linger after closing its output.
const LINGER: Duration = Duration::from_secs(10);
/// Malformed lines reported individually before the adapter goes quiet about them.
const MAX_REPORTED_PARSE_ERRORS: u32 = 5;

/// Parses one provider's output for one turn. Implementations are lenient about additions
/// (unknown event and item types are ignored) and strict about shape.
pub(crate) trait TurnNormalizer: Send {
    /// Events for one stdout line. `Err` means the line couldn't be read (never echoed).
    fn line(&mut self, text: &str) -> Result<Vec<AgentEvent>, String>;
    /// The provider's session id, once this turn reported it.
    fn session_id(&self) -> Option<&str>;
    /// The turn reported its own end (success or failure).
    fn turn_ended(&self) -> bool;
    /// Events that close anything still open when the process ends (tool calls, messages).
    fn close(&mut self) -> Vec<AgentEvent>;
}

/// What differs per provider.
pub(crate) trait TurnAdapter: Send + Sync + 'static {
    fn provider_id(&self) -> &'static str;
    fn display_name(&self) -> &'static str;
    /// The argv (after the program) for one turn; `resume` is the provider session id once
    /// known. The message is sent on stdin.
    fn turn_args(&self, resume: Option<&str>) -> Result<Vec<OsString>, ProviderError>;
    fn normalizer(&self) -> Box<dyn TurnNormalizer>;
    /// A provider-documented, user-safe error for a turn process that exited without ending its
    /// turn (for example a provider's own authentication exit code). `stderr` is the turn's
    /// redacted stderr tail: implementations may only *match* it against a provider's documented
    /// refusal and must return fixed KalCode copy, never text taken from it. `None` keeps the
    /// generic "stopped unexpectedly" error.
    fn exit_error(&self, _exit_code: Option<i32>, _stderr: &str) -> Option<(&'static str, String)> {
        None
    }
}

/// Everything a session needs to launch turns (resolved natively, never from the UI).
pub(crate) struct TurnLaunch {
    pub executable: PathBuf,
    pub env: BTreeMap<OsString, OsString>,
    pub cwd: PathBuf,
    /// Provider session id to resume from the first turn on.
    pub resume_session_id: Option<String>,
    pub guardian_profile: Option<SharedProfileLease>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

struct Shared {
    adapter: Box<dyn TurnAdapter>,
    launch: TurnLaunch,
    sink: Box<dyn AgentEventSink>,
    provider_session_id: Mutex<Option<String>>,
    /// The running turn, if any.
    current: Mutex<Option<CurrentTurn>>,
    turns: AtomicU64,
    /// The last turn whose end the provider reported (its process may still be exiting).
    reported_end: AtomicU64,
    parse_errors: Mutex<u32>,
    ended: AtomicBool,
}

#[derive(Clone)]
struct CurrentTurn {
    id: u64,
    child: Arc<SupervisedChild>,
    /// Bound to this exact reader so a later interrupt cannot change its exit classification.
    interrupted: Arc<AtomicBool>,
}

/// A provider session made of turn processes. Implements the shared `AgentSession` contract.
pub(crate) struct TurnSession {
    shared: Arc<Shared>,
}

impl TurnSession {
    pub(crate) fn start(
        adapter: Box<dyn TurnAdapter>,
        launch: TurnLaunch,
        sink: Box<dyn AgentEventSink>,
    ) -> Self {
        let resume = launch.resume_session_id.clone();
        let shared = Arc::new(Shared {
            adapter,
            launch,
            sink,
            provider_session_id: Mutex::new(resume.clone()),
            current: Mutex::new(None),
            turns: AtomicU64::new(0),
            reported_end: AtomicU64::new(0),
            parse_errors: Mutex::new(0),
            ended: AtomicBool::new(false),
        });
        if let Some(id) = resume {
            // Resuming: the provider session is known before the first turn runs.
            shared.sink.emit(AgentEvent::SessionStarted {
                provider_session_id: id,
                model: None,
                effort: None,
            });
        }
        tracing::info!(
            event = "provider.session_started",
            provider_id = shared.adapter.provider_id(),
            runtime = "turns"
        );
        Self { shared }
    }
}

impl Shared {
    fn name(&self) -> &'static str {
        self.adapter.display_name()
    }

    fn protocol_error(&self, reason: &str) {
        let count = {
            let mut n = lock(&self.parse_errors);
            *n = n.saturating_add(1);
            *n
        };
        tracing::warn!(event = "provider.stream_parse_error", provider_id = self.adapter.provider_id(), error = %reason);
        let message = match count {
            n if n < MAX_REPORTED_PARSE_ERRORS => format!(
                "{} sent a line KalCode couldn't read. It was skipped.",
                self.name()
            ),
            MAX_REPORTED_PARSE_ERRORS => format!(
                "{} keeps sending output KalCode can't read. Further unreadable lines are \
                 skipped silently.",
                self.name()
            ),
            _ => return,
        };
        self.sink.emit(AgentEvent::Error {
            code: "protocol_error".into(),
            message,
            recoverable: true,
        });
    }

    fn run_turn(self: &Arc<Self>, text: &str) -> Result<(), ProviderError> {
        // The previous turn may have reported its end while its process is still exiting:
        // give it a moment (then stop it) instead of refusing the next message.
        let finishing = lock(&self.current).clone().filter(|current| {
            self.reported_end.load(Ordering::SeqCst) == current.id
                || current.interrupted.load(Ordering::SeqCst)
        });
        if let Some(CurrentTurn {
            id: turn, child, ..
        }) = finishing
        {
            if !matches!(child.wait_timeout(LINGER), Ok(Some(_))) {
                child.kill();
            }
            let mut current = lock(&self.current);
            if current.as_ref().is_some_and(|current| current.id == turn) {
                current.take();
            }
        }
        let mut current = lock(&self.current);
        if current.is_some() {
            return Err(ProviderError::Io(format!(
                "{} is still working on the previous message.",
                self.name()
            )));
        }
        let resume = lock(&self.provider_session_id).clone();
        let args = self.adapter.turn_args(resume.as_deref())?;
        let spec = ProcessSpec {
            program: self.launch.executable.clone(),
            args,
            cwd: Some(self.launch.cwd.clone()),
            env: self.launch.env.clone(),
        };
        let spawned = match &self.launch.guardian_profile {
            Some(profile) => {
                let admission = profile.prepare_guarded_job("provider-turn")?;
                SupervisedChild::spawn_guarded(&spec, admission)
            }
            None => SupervisedChild::spawn(&spec),
        };
        let (child, lines) = spawned.map_err(|e| {
            tracing::warn!(event = "provider.session_spawn_failed", provider_id = self.adapter.provider_id(), error = %e);
            ProviderError::Start(format!("{} couldn't be started.", self.name()))
        })?;
        let child = Arc::new(child);
        // The message goes on stdin, then end of input: the CLI reads the whole prompt.
        let written = child.write_line(text);
        child.close_stdin();
        if let Err(error) = written {
            tracing::warn!(event = "provider.session_write_failed", provider_id = self.adapter.provider_id(), error = %error);
            child.kill();
            return Err(ProviderError::Io(format!(
                "KalCode couldn't send the message to {}.",
                self.name()
            )));
        }
        let turn = self.turns.fetch_add(1, Ordering::SeqCst) + 1;
        let interrupted = Arc::new(AtomicBool::new(false));
        *current = Some(CurrentTurn {
            id: turn,
            child: Arc::clone(&child),
            interrupted: Arc::clone(&interrupted),
        });
        drop(current);
        tracing::info!(
            event = "provider.turn_started",
            provider_id = self.adapter.provider_id(),
            turn,
            pid = child.pid()
        );

        let shared = Arc::clone(self);
        let mut normalizer = self.adapter.normalizer();
        let spawned = thread::Builder::new()
            .name(format!("kalcode-{}-turn", self.adapter.provider_id()))
            .spawn(move || {
                while let Ok(line) = lines.recv() {
                    match line {
                        OutputLine::Line(text) if text.trim().is_empty() => {}
                        OutputLine::Line(text) => match normalizer.line(&text) {
                            Ok(events) => {
                                if let Some(id) = normalizer.session_id() {
                                    let mut known = lock(&shared.provider_session_id);
                                    if known.as_deref() != Some(id) {
                                        *known = Some(id.to_owned());
                                    }
                                }
                                // Before the events go out: the runtime may send the next
                                // message as soon as it sees the turn complete.
                                if normalizer.turn_ended() {
                                    shared.reported_end.store(turn, Ordering::SeqCst);
                                }
                                for event in events {
                                    shared.sink.emit(event);
                                }
                            }
                            Err(reason) => shared.protocol_error(&reason),
                        },
                        OutputLine::TooLong { bytes } => {
                            tracing::warn!(
                                event = "provider.stream_line_too_long",
                                provider_id = shared.adapter.provider_id(),
                                bytes
                            );
                            shared.sink.emit(AgentEvent::Error {
                                code: "protocol_error".into(),
                                message: format!(
                                    "{} sent an event larger than KalCode accepts. It was skipped.",
                                    shared.name()
                                ),
                                recoverable: true,
                            });
                        }
                        OutputLine::Closed => break,
                    }
                }
                shared.finish_turn(turn, &child, &interrupted, normalizer.as_mut());
            });
        if spawned.is_err() {
            let failed = {
                let mut current = lock(&self.current);
                if current.as_ref().is_some_and(|current| current.id == turn) {
                    current.take()
                } else {
                    None
                }
            };
            if let Some(failed) = failed {
                failed.child.kill();
            }
            return Err(ProviderError::Start(format!(
                "KalCode couldn't follow {}'s output.",
                self.name()
            )));
        }
        Ok(())
    }

    /// The turn's output closed: collect its exit and report how it ended.
    fn finish_turn(
        &self,
        turn: u64,
        child: &SupervisedChild,
        interrupted: &AtomicBool,
        normalizer: &mut dyn TurnNormalizer,
    ) {
        let status = match child.wait_timeout(LINGER) {
            Ok(Some(status)) => Some(status),
            _ => {
                child.kill();
                child.try_status().ok().flatten()
            }
        };
        {
            let mut current = lock(&self.current);
            if current.as_ref().is_some_and(|current| current.id == turn) {
                current.take();
            }
        }
        let exit_code = status.and_then(|s| s.code());
        let interrupted = interrupted.load(Ordering::SeqCst);
        let ended = self.ended.load(Ordering::SeqCst);
        tracing::info!(event = "provider.turn_exited", provider_id = self.adapter.provider_id(), turn, exit_code = ?exit_code, interrupted, ended);
        if interrupted || ended {
            // KalCode stopped this turn on purpose; its status was reported then.
            for event in normalizer.close() {
                if matches!(event, AgentEvent::ToolCompleted { .. }) {
                    self.sink.emit(event);
                }
            }
            return;
        }
        for event in normalizer.close() {
            self.sink.emit(event);
        }
        if normalizer.turn_ended() {
            return;
        }
        if exit_code == Some(0) {
            // Exited cleanly without its own end marker: the turn is over.
            self.sink.emit(AgentEvent::TurnCompleted { ok: true });
            self.sink.emit(AgentEvent::Status {
                status: ThreadStatus::Idle,
                detail: None,
            });
            return;
        }
        let stderr = child.stderr_tail();
        tracing::warn!(event = "provider.turn_crashed", provider_id = self.adapter.provider_id(), exit_code = ?exit_code, stderr = %stderr);
        let (code, message) = self
            .adapter
            .exit_error(exit_code, &stderr)
            .unwrap_or_else(|| {
                (
                    "process_exited",
                    match exit_code {
                        Some(code) => {
                            format!("{} stopped unexpectedly (exit code {code}).", self.name())
                        }
                        None => format!("{} stopped unexpectedly.", self.name()),
                    },
                )
            });
        self.sink.emit(AgentEvent::Error {
            code: code.into(),
            message,
            recoverable: true,
        });
        self.sink.emit(AgentEvent::TurnCompleted { ok: false });
        self.sink.emit(AgentEvent::Status {
            status: ThreadStatus::Idle,
            detail: None,
        });
    }

    fn kill_current(&self) -> Option<u64> {
        let current = {
            let current = lock(&self.current);
            current.as_ref().map(|current| {
                current.interrupted.store(true, Ordering::SeqCst);
                (current.id, Arc::clone(&current.child))
            })
        };
        current.map(|(turn, child)| {
            child.kill();
            turn
        })
    }
}

impl AgentSession for TurnSession {
    fn provider_session_id(&self) -> Option<String> {
        lock(&self.shared.provider_session_id).clone()
    }

    fn send(&self, input: AgentInput) -> Result<(), ProviderError> {
        if self.shared.ended.load(Ordering::SeqCst) {
            return Err(ProviderError::SessionEnded);
        }
        let AgentInput::Text { text } = input;
        if text.trim().is_empty() {
            return Err(ProviderError::Io("The message is empty.".into()));
        }
        if text.len() > MAX_INPUT_BYTES {
            return Err(ProviderError::Io("The message is too long to send.".into()));
        }
        self.shared.run_turn(&text)
    }

    fn interrupt(&self) -> Result<(), ProviderError> {
        if self.shared.ended.load(Ordering::SeqCst) {
            return Err(ProviderError::SessionEnded);
        }
        if self.shared.kill_current().is_some() {
            self.shared.sink.emit(AgentEvent::Status {
                status: ThreadStatus::Interrupted,
                detail: None,
            });
        }
        Ok(())
    }

    fn terminate(&self) -> Result<(), ProviderError> {
        if self.shared.ended.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        self.shared.kill_current();
        self.shared.sink.emit(AgentEvent::Status {
            status: ThreadStatus::Completed,
            detail: None,
        });
        self.shared
            .sink
            .emit(AgentEvent::Exited { exit_code: None });
        tracing::info!(
            event = "provider.session_exited",
            provider_id = self.shared.adapter.provider_id(),
            deliberate = true
        );
        Ok(())
    }

    fn respond_to_approval(
        &self,
        _request_id: &str,
        _decision: ApprovalDecision,
    ) -> Result<(), ProviderError> {
        // Headless turns never ask the host: prompts are refused by the launch mapping.
        Err(ProviderError::Unsupported)
    }
}

impl Drop for TurnSession {
    fn drop(&mut self) {
        // An abandoned session must never leave a turn process behind.
        if !self.shared.ended.swap(true, Ordering::SeqCst) {
            self.shared.kill_current();
        }
    }
}

/// Clips provider-reported error text for an event: single line, redacted, at most 200
/// characters. Status never comes from this text.
pub(crate) fn provider_message(text: &str) -> String {
    let redacted = kalcode_core::logging::redact(text);
    let line: String = redacted
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .filter(|c| !c.is_control())
        .collect();
    if line.chars().count() <= 200 {
        line
    } else {
        let cut: String = line.chars().take(199).collect();
        format!("{cut}…")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;
    use std::time::Instant;

    /// Hang guard for a test child process and its turn worker: never a latency assertion.
    const HANG_GUARD: Duration = Duration::from_secs(30);

    struct TestAdapter;

    impl TurnAdapter for TestAdapter {
        fn provider_id(&self) -> &'static str {
            "test-turns"
        }

        fn display_name(&self) -> &'static str {
            "Test Turns"
        }

        fn turn_args(&self, _resume: Option<&str>) -> Result<Vec<OsString>, ProviderError> {
            #[cfg(windows)]
            {
                Ok(["/D", "/S", "/C", "more >NUL & ping -t 127.0.0.1 >NUL"]
                    .into_iter()
                    .map(OsString::from)
                    .collect())
            }
            #[cfg(not(windows))]
            {
                Ok([
                    "-c",
                    "while IFS= read -r line; do :; done; while :; do sleep 1; done",
                ]
                .into_iter()
                .map(OsString::from)
                .collect())
            }
        }

        fn normalizer(&self) -> Box<dyn TurnNormalizer> {
            Box::new(EmptyNormalizer)
        }
    }

    struct EmptyNormalizer;

    impl TurnNormalizer for EmptyNormalizer {
        fn line(&mut self, _text: &str) -> Result<Vec<AgentEvent>, String> {
            Ok(Vec::new())
        }

        fn session_id(&self) -> Option<&str> {
            None
        }

        fn turn_ended(&self) -> bool {
            false
        }

        fn close(&mut self) -> Vec<AgentEvent> {
            Vec::new()
        }
    }

    fn test_launch() -> Result<TurnLaunch, io::Error> {
        #[cfg(windows)]
        let executable = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .map(|root| root.join("System32").join("cmd.exe"))
            .ok_or_else(|| io::Error::other("SystemRoot is unavailable"))?;
        #[cfg(not(windows))]
        let executable = PathBuf::from("/bin/sh");

        Ok(TurnLaunch {
            executable,
            env: std::env::vars_os().collect(),
            cwd: std::env::current_dir()?,
            resume_session_id: None,
            guardian_profile: None,
        })
    }

    fn quiesced_child(shared: &Shared) -> Result<Arc<SupervisedChild>, ProviderError> {
        #[cfg(windows)]
        let args = ["/D", "/S", "/C", "exit 7"]
            .into_iter()
            .map(OsString::from)
            .collect();
        #[cfg(not(windows))]
        let args = ["-c", "exit 7"].into_iter().map(OsString::from).collect();
        let spec = ProcessSpec {
            program: shared.launch.executable.clone(),
            args,
            cwd: Some(shared.launch.cwd.clone()),
            env: shared.launch.env.clone(),
        };
        let (child, lines) = SupervisedChild::spawn(&spec)
            .map_err(|error| ProviderError::Start(error.to_string()))?;
        drop(lines);
        child.close_stdin();
        let status = child
            .wait_timeout(HANG_GUARD)
            .map_err(|error| ProviderError::Start(error.to_string()))?
            .ok_or_else(|| ProviderError::Start("test child did not exit".into()))?;
        let _ = status;
        Ok(Arc::new(child))
    }

    #[test]
    fn an_interrupted_quiesced_turn_is_reaped_before_the_next_turn() -> Result<(), ProviderError> {
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&events);
        let session = TurnSession::start(
            Box::new(TestAdapter),
            test_launch().map_err(|error| ProviderError::Start(error.to_string()))?,
            Box::new(move |event: AgentEvent| lock(&captured).push(event)),
        );

        // Model the exact production boundary: tree termination has completed, while the output
        // worker has not yet removed the interrupted turn from `current`.
        let interrupted = quiesced_child(&session.shared)?;
        let first_interrupted = Arc::new(AtomicBool::new(true));
        session.shared.turns.store(1, Ordering::SeqCst);
        *lock(&session.shared.current) = Some(CurrentTurn {
            id: 1,
            child: Arc::clone(&interrupted),
            interrupted: Arc::clone(&first_interrupted),
        });

        session.send(AgentInput::Text {
            text: "next turn".into(),
        })?;

        // Interrupting the new turn must not overwrite the old reader's classification.
        assert_eq!(session.shared.kill_current(), Some(2));
        let mut old_normalizer = EmptyNormalizer;
        let before_old_reader = lock(&events).len();
        session
            .shared
            .finish_turn(1, &interrupted, &first_interrupted, &mut old_normalizer);
        assert_eq!(
            lock(&events).len(),
            before_old_reader,
            "the old interrupted reader must not emit a stale failure"
        );

        let deadline = Instant::now() + HANG_GUARD;
        while lock(&session.shared.current).is_some() {
            if Instant::now() >= deadline {
                return Err(ProviderError::Start("next test turn did not finish".into()));
            }
            thread::yield_now();
        }
        assert!(!lock(&events).iter().any(|event| matches!(
            event,
            AgentEvent::Error { .. } | AgentEvent::TurnCompleted { ok: false }
        )));

        // A retained current turn without either completion authority remains busy.
        let active = quiesced_child(&session.shared)?;
        session.shared.turns.store(3, Ordering::SeqCst);
        session.shared.reported_end.store(0, Ordering::SeqCst);
        *lock(&session.shared.current) = Some(CurrentTurn {
            id: 3,
            child: active,
            interrupted: Arc::new(AtomicBool::new(false)),
        });
        let result = session.send(AgentInput::Text {
            text: "must stay blocked".into(),
        });
        assert!(
            matches!(result, Err(ProviderError::Io(message)) if message == "Test Turns is still working on the previous message.")
        );
        lock(&session.shared.current).take();
        session.terminate()?;
        Ok(())
    }

    #[test]
    fn provider_messages_are_single_line_clipped_and_redacted() {
        assert_eq!(provider_message("a\n b\tc"), "a b c");
        let long = "x".repeat(500);
        assert_eq!(provider_message(&long).chars().count(), 200);
        let secret = provider_message("failed api_key=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123");
        assert!(!secret.contains("abcdefghijklmnop"), "{secret}");
    }
}
