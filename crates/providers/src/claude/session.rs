//! A Claude Code headless session: one supervised `claude -p` process speaking stream-JSON on
//! stdin/stdout (https://code.claude.com/docs/en/headless,
//! https://code.claude.com/docs/en/agent-sdk/typescript#sdkusermessage).

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::Duration;

use kalcode_contracts::agent::{
    AgentEvent, AgentEventSink, AgentInput, AgentSession, ProviderError,
};
use kalcode_contracts::permissions::ApprovalDecision;
use kalcode_contracts::threads::ThreadStatus;
use serde_json::json;

use super::argv::{SessionArgs, SessionStart, session_args, working_directory};
use super::normalize::Normalizer;
use super::stream::{ClaudeLine, parse_line};
use crate::guardian::RegisteredJob;
use crate::process::{OutputLine, ProcessSpec, SupervisedChild};

/// Documented in the Agent SDK reference (`SDKSystemMessage.capabilities`): the CLI answers the
/// `interrupt` control request with a receipt.
const INTERRUPT_CAPABILITY: &str = "interrupt_receipt_v1";

/// Largest single message KalCode sends to a session.
pub const MAX_INPUT_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy)]
pub struct SessionTimeouts {
    /// How long Claude Code has to confirm an interrupt before KalCode stops the process.
    pub interrupt_ack: Duration,
    /// How long Claude Code has to exit after its input closes before it is killed.
    pub terminate_grace: Duration,
}

impl Default for SessionTimeouts {
    fn default() -> Self {
        Self {
            interrupt_ack: Duration::from_secs(5),
            terminate_grace: Duration::from_secs(3),
        }
    }
}

/// Everything needed to launch a session (resolved natively, never from the UI).
pub struct LaunchSpec {
    pub executable: PathBuf,
    pub env: BTreeMap<OsString, OsString>,
    pub working_directory: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub mode: kalcode_contracts::permissions::PermissionMode,
    pub resume_session_id: Option<String>,
    pub timeouts: SessionTimeouts,
    pub guardian_job: Option<RegisteredJob>,
}

struct Shared {
    child: SupervisedChild,
    sink: Box<dyn AgentEventSink>,
    provider_session_id: Mutex<Option<String>>,
    interrupt_supported: AtomicBool,
    /// Serializes the full interrupt attempt through either acknowledgement or fallback stop.
    interrupt_in_flight: AtomicBool,
    /// The one interrupt request whose exact response may still affect session state.
    pending_interrupt: Mutex<Option<PendingInterrupt>>,
    /// Set when KalCode ends the session on purpose, so the exit isn't reported as a crash.
    stopping: AtomicBool,
    ended: AtomicBool,
    timeouts: SessionTimeouts,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
enum InterruptResolution {
    Awaiting = 0,
    ClaimedTrue = 1,
    ClaimedFalse = 2,
    Cancelled = 3,
}

impl InterruptResolution {
    fn load(value: &AtomicU8) -> Self {
        match value.load(Ordering::SeqCst) {
            0 => Self::Awaiting,
            1 => Self::ClaimedTrue,
            2 => Self::ClaimedFalse,
            _ => Self::Cancelled,
        }
    }
}

struct PendingInterrupt {
    request_id: String,
    reply: Option<Sender<bool>>,
    resolution: Arc<AtomicU8>,
}

struct InterruptWait {
    request_id: String,
    reply: Receiver<bool>,
    resolution: Arc<AtomicU8>,
}

enum BeginInterrupt {
    Started(InterruptWait),
    WriteFailed,
}

struct InterruptClaim {
    request_id: String,
    outcome: bool,
    reply: Sender<bool>,
    resolution: Arc<AtomicU8>,
}

struct InterruptClaimCleanup<'a> {
    pending: &'a Mutex<Option<PendingInterrupt>>,
    request_id: &'a str,
    resolution: &'a Arc<AtomicU8>,
}

impl Drop for InterruptClaimCleanup<'_> {
    fn drop(&mut self) {
        clear_interrupt_claim(self.pending, self.request_id, self.resolution);
    }
}

struct InterruptInFlight<'a>(&'a AtomicBool);

impl<'a> InterruptInFlight<'a> {
    fn acquire(flag: &'a AtomicBool) -> Result<Self, ProviderError> {
        flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| ProviderError::Io("An interrupt is already in progress.".into()))?;
        Ok(Self(flag))
    }
}

impl Drop for InterruptInFlight<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn begin_interrupt_request(
    pending: &Mutex<Option<PendingInterrupt>>,
    request_id: String,
    write: impl FnOnce() -> Result<(), ProviderError>,
) -> Result<BeginInterrupt, ProviderError> {
    let (reply_tx, reply_rx) = mpsc::channel();
    let resolution = Arc::new(AtomicU8::new(InterruptResolution::Awaiting as u8));
    let mut pending = lock(pending);
    if pending.is_some() {
        return Err(ProviderError::Io(
            "An interrupt is already in progress.".into(),
        ));
    }
    *pending = Some(PendingInterrupt {
        request_id: request_id.clone(),
        reply: Some(reply_tx),
        resolution: Arc::clone(&resolution),
    });
    if write().is_err() {
        resolution.store(InterruptResolution::Cancelled as u8, Ordering::SeqCst);
        if pending
            .as_ref()
            .is_some_and(|current| current.request_id == request_id)
        {
            pending.take();
        }
        return Ok(BeginInterrupt::WriteFailed);
    }
    drop(pending);
    Ok(BeginInterrupt::Started(InterruptWait {
        request_id,
        reply: reply_rx,
        resolution,
    }))
}

fn claim_interrupt_response(
    pending: &Mutex<Option<PendingInterrupt>>,
    request_id: Option<&str>,
    outcome: bool,
) -> Option<InterruptClaim> {
    let mut pending = lock(pending);
    let current = pending.as_mut()?;
    if request_id != Some(current.request_id.as_str())
        || InterruptResolution::load(&current.resolution) != InterruptResolution::Awaiting
    {
        return None;
    }
    let reply = current.reply.take()?;
    current.resolution.store(
        if outcome {
            InterruptResolution::ClaimedTrue
        } else {
            InterruptResolution::ClaimedFalse
        } as u8,
        Ordering::SeqCst,
    );
    Some(InterruptClaim {
        request_id: current.request_id.clone(),
        outcome,
        reply,
        resolution: Arc::clone(&current.resolution),
    })
}

fn clear_interrupt_claim(
    pending: &Mutex<Option<PendingInterrupt>>,
    request_id: &str,
    resolution: &Arc<AtomicU8>,
) {
    let mut pending = lock(pending);
    if pending.as_ref().is_some_and(|current| {
        current.request_id == request_id && Arc::ptr_eq(&current.resolution, resolution)
    }) {
        pending.take();
    }
}

fn deliver_interrupt_response(
    pending: &Mutex<Option<PendingInterrupt>>,
    sink: &dyn AgentEventSink,
    request_id: Option<&str>,
    ok: bool,
) -> bool {
    let Some(claim) = claim_interrupt_response(pending, request_id, ok) else {
        return false;
    };
    let _cleanup = InterruptClaimCleanup {
        pending,
        request_id: &claim.request_id,
        resolution: &claim.resolution,
    };
    if claim.outcome {
        sink.emit(AgentEvent::Status {
            status: ThreadStatus::Interrupted,
            detail: None,
        });
    }
    let _ = claim.reply.send(claim.outcome);
    true
}

fn finish_pending_interrupt(pending: &Mutex<Option<PendingInterrupt>>) {
    let claim = {
        let mut pending = lock(pending);
        let Some(current) = pending.as_mut() else {
            return;
        };
        if InterruptResolution::load(&current.resolution) != InterruptResolution::Awaiting {
            return;
        }
        current
            .resolution
            .store(InterruptResolution::ClaimedFalse as u8, Ordering::SeqCst);
        current.reply.take().map(|reply| InterruptClaim {
            request_id: current.request_id.clone(),
            outcome: false,
            reply,
            resolution: Arc::clone(&current.resolution),
        })
    };
    if let Some(claim) = claim {
        let _ = claim.reply.send(false);
        clear_interrupt_claim(pending, &claim.request_id, &claim.resolution);
    }
}

fn interrupt_confirmed(
    pending: &Mutex<Option<PendingInterrupt>>,
    wait: InterruptWait,
    timeout: Duration,
) -> bool {
    match wait.reply.recv_timeout(timeout) {
        Ok(outcome) => outcome,
        Err(RecvTimeoutError::Disconnected) => false,
        Err(RecvTimeoutError::Timeout) => {
            let mut pending = lock(pending);
            let exact = pending.as_ref().is_some_and(|current| {
                current.request_id == wait.request_id
                    && Arc::ptr_eq(&current.resolution, &wait.resolution)
            });
            let resolution = InterruptResolution::load(&wait.resolution);
            if exact && resolution == InterruptResolution::Awaiting {
                wait.resolution
                    .store(InterruptResolution::Cancelled as u8, Ordering::SeqCst);
                pending.take();
                false
            } else {
                resolution == InterruptResolution::ClaimedTrue
            }
        }
    }
}

pub struct ClaudeSession {
    shared: Arc<Shared>,
}

impl ClaudeSession {
    /// Starts the process and its reader thread. Events flow to `sink` until `Exited`.
    pub fn start(spec: LaunchSpec, sink: Box<dyn AgentEventSink>) -> Result<Self, ProviderError> {
        let cwd = working_directory(&spec.working_directory)
            .map_err(|e| ProviderError::Start(e.to_string()))?;
        let start = match spec.resume_session_id {
            Some(session_id) => SessionStart::Resume { session_id },
            None => SessionStart::New {
                session_id: uuid::Uuid::new_v4().to_string(),
            },
        };
        let known_id = match &start {
            SessionStart::New { session_id } | SessionStart::Resume { session_id } => {
                session_id.clone()
            }
        };
        let args = session_args(&SessionArgs {
            model: spec.model,
            effort: spec.effort,
            mode: spec.mode,
            start,
        })
        .map_err(|e| ProviderError::Start(e.to_string()))?;
        let process = ProcessSpec {
            program: spec.executable,
            args,
            cwd: Some(cwd),
            env: spec.env,
        };
        let spawned = match spec.guardian_job {
            Some(admission) => SupervisedChild::spawn_guarded(&process, admission),
            None => SupervisedChild::spawn(&process),
        };
        let (child, lines) = spawned.map_err(|e| {
            tracing::warn!(event = "provider.session_spawn_failed", provider_id = "claude-code", error = %e);
            ProviderError::Start("Claude Code couldn't be started.".into())
        })?;
        tracing::info!(
            event = "provider.session_started",
            provider_id = "claude-code",
            pid = child.pid()
        );

        let shared = Arc::new(Shared {
            child,
            sink,
            provider_session_id: Mutex::new(Some(known_id)),
            interrupt_supported: AtomicBool::new(false),
            interrupt_in_flight: AtomicBool::new(false),
            pending_interrupt: Mutex::new(None),
            stopping: AtomicBool::new(false),
            ended: AtomicBool::new(false),
            timeouts: spec.timeouts,
        });
        shared.sink.emit(AgentEvent::Status {
            status: ThreadStatus::Starting,
            detail: None,
        });

        let reader = Arc::clone(&shared);
        let mut normalizer = Normalizer::new(spec.working_directory);
        thread::spawn(move || {
            while let Ok(line) = lines.recv() {
                match line {
                    OutputLine::Line(text) if text.trim().is_empty() => {}
                    OutputLine::Line(text) => reader.handle_line(&mut normalizer, &text),
                    OutputLine::TooLong { bytes } => {
                        for event in normalizer.line_too_long(bytes) {
                            reader.sink.emit(event);
                        }
                    }
                    OutputLine::Closed => break,
                }
            }
            reader.finish();
        });
        Ok(Self { shared })
    }
}

impl Shared {
    fn handle_line(&self, normalizer: &mut Normalizer, text: &str) {
        let line = match parse_line(text) {
            Ok(line) => line,
            Err(error) => {
                for event in normalizer.parse_error(&error) {
                    self.sink.emit(event);
                }
                return;
            }
        };
        match &line {
            ClaudeLine::ControlResponse { request_id, ok } => {
                deliver_interrupt_response(
                    &self.pending_interrupt,
                    self.sink.as_ref(),
                    request_id.as_deref(),
                    *ok,
                );
                return;
            }
            ClaudeLine::ControlRequest { subtype, .. } => {
                // KalCode passes `--permission-prompts none`, so Claude Code should never ask
                // the host anything. If it does, fail closed: nobody may silently approve.
                tracing::warn!(
                    event = "provider.unexpected_control_request",
                    provider_id = "claude-code",
                    subtype = subtype.as_deref().unwrap_or("")
                );
                self.sink.emit(AgentEvent::Error {
                    code: "unexpected_host_request".into(),
                    message: "Claude Code asked KalCode for a decision KalCode can't make yet, so \
                              the session was stopped. Nothing was approved."
                        .into(),
                    recoverable: false,
                });
                self.stopping.store(true, Ordering::SeqCst);
                self.child.kill();
                return;
            }
            _ => {}
        }
        for event in normalizer.normalize(line) {
            self.sink.emit(event);
        }
        if let Some(id) = normalizer.provider_session_id() {
            let mut current = lock(&self.provider_session_id);
            if current.as_deref() != Some(id) {
                *current = Some(id.to_owned());
            }
        }
        if normalizer.has_capability(INTERRUPT_CAPABILITY) {
            self.interrupt_supported.store(true, Ordering::SeqCst);
        }
    }

    /// stdout closed: collect the exit status and report how the session ended.
    fn finish(&self) {
        let status = match self.child.wait_timeout(Duration::from_secs(10)) {
            Ok(Some(status)) => Some(status),
            _ => {
                self.child.kill();
                self.child.try_status().ok().flatten()
            }
        };
        self.ended.store(true, Ordering::SeqCst);
        // Any interrupt still waiting gets its answer now.
        finish_pending_interrupt(&self.pending_interrupt);
        let exit_code = status.and_then(|s| s.code());
        let deliberate = self.stopping.load(Ordering::SeqCst);
        if !deliberate && exit_code != Some(0) {
            let stderr = self.child.stderr_tail();
            tracing::warn!(event = "provider.session_crashed", provider_id = "claude-code", exit_code = ?exit_code, stderr = %stderr);
            self.sink.emit(AgentEvent::Error {
                code: "process_exited".into(),
                message: match exit_code {
                    Some(code) => format!("Claude Code stopped unexpectedly (exit code {code})."),
                    None => "Claude Code stopped unexpectedly.".into(),
                },
                recoverable: true,
            });
        }
        self.sink.emit(AgentEvent::Status {
            status: if deliberate || exit_code == Some(0) {
                ThreadStatus::Completed
            } else {
                ThreadStatus::Failed
            },
            detail: None,
        });
        self.sink.emit(AgentEvent::Exited { exit_code });
        tracing::info!(event = "provider.session_exited", provider_id = "claude-code", exit_code = ?exit_code, deliberate);
    }

    fn ensure_running(&self) -> Result<(), ProviderError> {
        if self.ended.load(Ordering::SeqCst) || self.stopping.load(Ordering::SeqCst) {
            Err(ProviderError::SessionEnded)
        } else {
            Ok(())
        }
    }

    fn write(&self, value: &serde_json::Value) -> Result<(), ProviderError> {
        self.child.write_line(&value.to_string()).map_err(|e| {
            tracing::warn!(event = "provider.session_write_failed", provider_id = "claude-code", error = %e);
            ProviderError::Io("KalCode couldn't send input to Claude Code.".into())
        })
    }

    fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        if let Err(error) = self.child.terminate(self.timeouts.terminate_grace) {
            tracing::warn!(event = "provider.session_terminate_failed", provider_id = "claude-code", error = %error);
            self.child.kill();
        }
    }
}

impl AgentSession for ClaudeSession {
    fn provider_session_id(&self) -> Option<String> {
        lock(&self.shared.provider_session_id).clone()
    }

    fn send(&self, input: AgentInput) -> Result<(), ProviderError> {
        self.shared.ensure_running()?;
        let AgentInput::Text { text } = input;
        if text.trim().is_empty() {
            return Err(ProviderError::Io("The message is empty.".into()));
        }
        if text.len() > MAX_INPUT_BYTES {
            return Err(ProviderError::Io("The message is too long to send.".into()));
        }
        // SDKUserMessage: { type: "user", message: MessageParam, parent_tool_use_id }.
        self.shared.write(&json!({
            "type": "user",
            "message": { "role": "user", "content": text },
            "parent_tool_use_id": null,
        }))
    }

    fn interrupt(&self) -> Result<(), ProviderError> {
        self.shared.ensure_running()?;
        let _in_flight = InterruptInFlight::acquire(&self.shared.interrupt_in_flight)?;
        let supported = self.shared.interrupt_supported.load(Ordering::SeqCst);
        if supported {
            let request_id = uuid::Uuid::new_v4().to_string();
            // The `control_request` envelope is documented in the Agent SDK reference; the CLI
            // advertises `interrupt_receipt_v1` when it answers the `interrupt` request.
            let message = json!({
                "type": "control_request",
                "request_id": request_id.clone(),
                "request": { "subtype": "interrupt" },
            });
            match begin_interrupt_request(&self.shared.pending_interrupt, request_id, || {
                self.shared.write(&message)
            })? {
                BeginInterrupt::Started(wait) => {
                    if interrupt_confirmed(
                        &self.shared.pending_interrupt,
                        wait,
                        self.shared.timeouts.interrupt_ack,
                    ) {
                        return Ok(());
                    }
                }
                BeginInterrupt::WriteFailed => {}
            }
        }
        // Not confirmed (or not supported by this CLI): stop the process instead. Stricter, and
        // the conversation can be resumed by its session id.
        self.shared.sink.emit(AgentEvent::Error {
            code: "interrupt_unconfirmed".into(),
            message: "Claude Code didn't confirm the interrupt, so KalCode stopped the session. \
                      You can resume it."
                .into(),
            recoverable: true,
        });
        self.shared.stop();
        Ok(())
    }

    fn terminate(&self) -> Result<(), ProviderError> {
        if self.shared.ended.load(Ordering::SeqCst) {
            return Ok(());
        }
        self.shared.stop();
        Ok(())
    }

    fn respond_to_approval(
        &self,
        _request_id: &str,
        _decision: ApprovalDecision,
    ) -> Result<(), ProviderError> {
        // Host approvals arrive with the permission engine (Z4). Until then sessions run with
        // `--permission-prompts none` and never raise `ApprovalRequired`.
        Err(ProviderError::Unsupported)
    }
}

impl Drop for ClaudeSession {
    fn drop(&mut self) {
        // An abandoned session must never leave a process behind. The reader thread keeps the
        // shared state alive until stdout closes, so stop the process explicitly (off the
        // dropping thread: termination waits for a grace period).
        if self.shared.ended.load(Ordering::SeqCst) {
            return;
        }
        let shared = Arc::clone(&self.shared);
        thread::spawn(move || shared.stop());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn begin(pending: &Mutex<Option<PendingInterrupt>>, request_id: &str) -> InterruptWait {
        match begin_interrupt_request(pending, request_id.to_owned(), || Ok(()))
            .expect("begin interrupt")
        {
            BeginInterrupt::Started(wait) => wait,
            BeginInterrupt::WriteFailed => panic!("fixture write must succeed"),
        }
    }

    #[test]
    fn positive_response_delivery_orders_interrupted_before_ack_consumer_completion() {
        let pending = Mutex::new(None);
        let wait = begin(&pending, "request");
        let events = Arc::new(Mutex::new(Vec::new()));

        let worker_events = Arc::clone(&events);
        let worker = thread::spawn(move || {
            assert_eq!(wait.reply.recv(), Ok(true));
            lock(&worker_events).push("completion");
        });

        let sink_events = Arc::clone(&events);
        let sink = move |event| {
            assert!(matches!(
                event,
                AgentEvent::Status {
                    status: ThreadStatus::Interrupted,
                    detail: None,
                }
            ));
            lock(&sink_events).push("interrupted");
        };

        assert!(deliver_interrupt_response(
            &pending,
            &sink,
            Some("request"),
            true
        ));
        worker.join().expect("completion worker");
        assert_eq!(*lock(&events), ["interrupted", "completion"]);
        assert!(lock(&pending).is_none());
    }

    #[test]
    fn wrong_negative_unsolicited_and_duplicate_responses_never_emit_interrupted() {
        let pending = Mutex::new(None);
        let wait = begin(&pending, "expected");
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink_events = Arc::clone(&events);
        let sink = move |event| lock(&sink_events).push(event);

        assert!(!deliver_interrupt_response(
            &pending,
            &sink,
            Some("wrong"),
            true
        ));
        assert_eq!(
            InterruptResolution::load(&wait.resolution),
            InterruptResolution::Awaiting
        );
        assert!(deliver_interrupt_response(
            &pending,
            &sink,
            Some("expected"),
            false
        ));
        assert!(!interrupt_confirmed(&pending, wait, Duration::from_secs(1)));
        assert!(!deliver_interrupt_response(
            &pending,
            &sink,
            Some("expected"),
            true
        ));
        assert!(!deliver_interrupt_response(&pending, &sink, None, true));
        assert!(lock(&events).is_empty());
    }

    #[test]
    fn timeout_wins_exact_request_and_late_positive_response_is_unsolicited() {
        let pending = Mutex::new(None);
        let in_flight = AtomicBool::new(false);
        let attempt = InterruptInFlight::acquire(&in_flight).expect("first interrupt attempt");
        let wait = begin(&pending, "request");
        let resolution = Arc::clone(&wait.resolution);
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink_events = Arc::clone(&events);
        let sink = move |event| lock(&sink_events).push(event);

        assert!(!interrupt_confirmed(&pending, wait, Duration::ZERO));
        assert_eq!(
            InterruptResolution::load(&resolution),
            InterruptResolution::Cancelled
        );
        assert!(lock(&pending).is_none());
        assert!(matches!(
            InterruptInFlight::acquire(&in_flight),
            Err(ProviderError::Io(message)) if message == "An interrupt is already in progress."
        ));
        assert!(!deliver_interrupt_response(
            &pending,
            &sink,
            Some("request"),
            true
        ));
        assert!(lock(&events).is_empty());
        drop(attempt);
        let later_attempt =
            InterruptInFlight::acquire(&in_flight).expect("fallback completion releases attempt");
        drop(later_attempt);
    }

    #[test]
    fn claimed_response_wins_timeout_and_rejects_concurrent_interrupt_until_delivery() {
        let pending = Arc::new(Mutex::new(None));
        let wait = begin(&pending, "first");
        let events = Arc::new(Mutex::new(Vec::new()));
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let release_rx = Mutex::new(release_rx);
        let reader_pending = Arc::clone(&pending);
        let reader_events = Arc::clone(&events);
        let reader = thread::spawn(move || {
            let sink = move |event| {
                entered_tx.send(()).expect("sink entered");
                lock(&release_rx).recv().expect("sink released");
                lock(&reader_events).push(event);
            };
            deliver_interrupt_response(&reader_pending, &sink, Some("first"), true)
        });

        entered_rx.recv().expect("reader claimed response");
        assert!(matches!(
            wait.reply.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
        assert!(interrupt_confirmed(&pending, wait, Duration::ZERO));
        assert!(matches!(
            begin_interrupt_request(&pending, "second".into(), || {
                panic!("a concurrent interrupt must not write")
            }),
            Err(ProviderError::Io(message)) if message == "An interrupt is already in progress."
        ));
        release_tx.send(()).expect("release ordered delivery");
        assert!(reader.join().expect("reader"));
        assert_eq!(
            *lock(&events),
            [AgentEvent::Status {
                status: ThreadStatus::Interrupted,
                detail: None,
            }]
        );
        assert!(lock(&pending).is_none());

        let later = begin(&pending, "later");
        assert!(!interrupt_confirmed(&pending, later, Duration::ZERO));
    }

    #[test]
    fn write_failure_cancels_exact_slot_before_a_queued_response_can_claim_it() {
        let pending = Arc::new(Mutex::new(None));
        let events = Arc::new(Mutex::new(Vec::new()));
        let (started_tx, started_rx) = mpsc::channel();
        let worker = Mutex::new(None);

        let result = begin_interrupt_request(&pending, "request".into(), || {
            let worker_pending = Arc::clone(&pending);
            let worker_events = Arc::clone(&events);
            let handle = thread::spawn(move || {
                started_tx.send(()).expect("response started");
                let sink = move |event| lock(&worker_events).push(event);
                deliver_interrupt_response(&worker_pending, &sink, Some("request"), true)
            });
            *lock(&worker) = Some(handle);
            started_rx.recv().expect("response waiting on slot");
            Err(ProviderError::Io("fixture write failed".into()))
        })
        .expect("write failure falls back");

        assert!(matches!(result, BeginInterrupt::WriteFailed));
        assert!(
            !lock(&worker)
                .take()
                .expect("worker")
                .join()
                .expect("worker")
        );
        assert!(lock(&pending).is_none());
        assert!(lock(&events).is_empty());

        let later = begin(&pending, "later");
        assert!(!interrupt_confirmed(&pending, later, Duration::ZERO));
    }

    #[test]
    fn panicking_sink_clears_exact_claim_and_disconnects_the_waiter() {
        let pending = Mutex::new(None);
        let wait = begin(&pending, "request");

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let sink = |_event| panic!("fixture sink panic");
            deliver_interrupt_response(&pending, &sink, Some("request"), true)
        }));

        assert!(result.is_err());
        assert!(lock(&pending).is_none());
        assert!(!interrupt_confirmed(&pending, wait, Duration::from_secs(1)));

        let later = begin(&pending, "later");
        assert!(!interrupt_confirmed(&pending, later, Duration::ZERO));
    }

    #[test]
    fn session_finish_resolves_only_the_current_pending_interrupt_as_false() {
        let pending = Mutex::new(None);
        let wait = begin(&pending, "request");
        finish_pending_interrupt(&pending);
        assert!(!interrupt_confirmed(&pending, wait, Duration::from_secs(1)));
        assert!(lock(&pending).is_none());
    }
}
