//! A Claude Code headless session: one supervised `claude -p` process speaking stream-JSON on
//! stdin/stdout (https://code.claude.com/docs/en/headless,
//! https://code.claude.com/docs/en/agent-sdk/typescript#sdkusermessage).

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
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
    /// The interrupt awaiting its control response: (request id, reply channel).
    pending_interrupt: Mutex<Option<(String, Sender<bool>)>>,
    /// Set when KalCode ends the session on purpose, so the exit isn't reported as a crash.
    stopping: AtomicBool,
    ended: AtomicBool,
    timeouts: SessionTimeouts,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
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
                let mut pending = lock(&self.pending_interrupt);
                let matches = match (pending.as_ref(), request_id) {
                    (Some((expected, _)), Some(id)) => expected == id,
                    _ => false,
                };
                if matches && let Some((_, reply)) = pending.take() {
                    let _ = reply.send(*ok);
                }
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
        if let Some((_, reply)) = lock(&self.pending_interrupt).take() {
            let _ = reply.send(false);
        }
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
        let supported = self.shared.interrupt_supported.load(Ordering::SeqCst);
        if supported {
            let request_id = uuid::Uuid::new_v4().to_string();
            let (tx, rx) = mpsc::channel();
            *lock(&self.shared.pending_interrupt) = Some((request_id.clone(), tx));
            // The `control_request` envelope is documented in the Agent SDK reference; the CLI
            // advertises `interrupt_receipt_v1` when it answers the `interrupt` request.
            let sent = self.shared.write(&json!({
                "type": "control_request",
                "request_id": request_id,
                "request": { "subtype": "interrupt" },
            }));
            if sent.is_ok() && rx.recv_timeout(self.shared.timeouts.interrupt_ack) == Ok(true) {
                self.shared.sink.emit(AgentEvent::Status {
                    status: ThreadStatus::Interrupted,
                    detail: None,
                });
                return Ok(());
            }
            lock(&self.shared.pending_interrupt).take();
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
