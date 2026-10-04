//! Admission wrapper for managed provider sessions.
//!
//! This is deliberately attached only to the provider adapters registered for thread execution.
//! Provider detection, sign-in, account maintenance, and status probes do not acquire a slot.
//!
//! Admission is accounted per **turn**, not per session. A slot (and its projected budget) is
//! taken when a session starts and when a message is sent, and it is returned when the turn ends
//! (`TurnCompleted`, an interrupted/finished status, or `Exited`). An idle session between turns
//! therefore holds no capacity: turn-based providers (Codex, Gemini CLI) have no process then, and
//! an idle persistent process (Claude Code) is measured by the sampler like any other process.
//! This is admission accounting only; process custody and lifetime are unchanged.

use std::sync::{Arc, Mutex, PoisonError};

use kalcode_contracts::agent::{
    AgentEvent, AgentEventSink, AgentInput, AgentProvider, AgentSession, ProviderCapabilities,
    ProviderDetection, ProviderError, ProviderId, SessionConfig,
};
use kalcode_contracts::permissions::ApprovalDecision;
use kalcode_contracts::threads::ThreadStatus;
use kalcode_resources::AdmissionDecision;

use super::{ProviderTaskReservation, ResourceGovernorState};

pub(super) trait ProviderAdmissionPermit: Send + Sync {}

pub(super) trait ProviderAdmission: Send + Sync {
    /// Reserves one turn's capacity. A hold is `ProviderError::ResourcesHeld`, never `Start`.
    fn reserve(
        &self,
        provider: ProviderId,
    ) -> Result<Box<dyn ProviderAdmissionPermit>, ProviderError>;
}

struct GovernorAdmission {
    governor: Arc<ResourceGovernorState>,
    interactive: bool,
}

struct GovernorPermit {
    _reservation: ProviderTaskReservation,
}

impl ProviderAdmissionPermit for GovernorPermit {}

impl ProviderAdmission for GovernorAdmission {
    fn reserve(
        &self,
        provider: ProviderId,
    ) -> Result<Box<dyn ProviderAdmissionPermit>, ProviderError> {
        let reservation = if self.interactive {
            self.governor
                .reserve_interactive_provider_task(provider.clone())
        } else {
            self.governor.reserve_provider_task(provider.clone())
        };
        match reservation {
            Ok(reservation) => Ok(Box::new(GovernorPermit {
                _reservation: reservation,
            })),
            Err(decision) => {
                log_launch_hold(&provider, &decision);
                Err(ProviderError::ResourcesHeld(
                    kalcode_resources::launch_hold(
                        &decision,
                        self.governor.admission_retry_interval(),
                        kalcode_resources::ADMISSION_WAIT_LIMIT,
                    ),
                ))
            }
        }
    }
}

/// Logs every hold reason with the values the governor used. The payload is the governor's own
/// typed decision: percentages, MiB, sample ages, counts, the mode and fixed telemetry notes. It
/// never contains paths, prompts, account data or credentials.
pub(super) fn log_launch_hold(provider: &ProviderId, decision: &AdmissionDecision) {
    let codes = kalcode_resources::decision_codes(decision).join(",");
    let detail = serde_json::to_string(&decision.reasons).unwrap_or_default();
    tracing::info!(
        event = "resources.provider_launch_held",
        provider_id = %provider,
        snapshot_seq = ?decision.snapshot_seq,
        sampled_at_unix_ms = ?decision.sampled_at_unix_ms,
        mode = ?decision.mode,
        reason_count = decision.reasons.len(),
        reasons = %codes,
        detail = %detail,
        "resource admission held a managed provider start"
    );
}

/// Wraps one registered provider adapter with the process-wide resource admission authority.
pub(crate) struct ResourceAdmissionProvider {
    inner: Arc<dyn AgentProvider>,
    admission: Arc<dyn ProviderAdmission>,
}

impl ResourceAdmissionProvider {
    pub(crate) fn wrap(
        inner: Arc<dyn AgentProvider>,
        governor: Arc<ResourceGovernorState>,
    ) -> Arc<dyn AgentProvider> {
        Self::with_admission(
            inner,
            Arc::new(GovernorAdmission {
                governor,
                interactive: false,
            }),
        )
    }

    /// User-requested coding terminals outrank optional background CPU work.
    pub(crate) fn wrap_interactive(
        inner: Arc<dyn AgentProvider>,
        governor: Arc<ResourceGovernorState>,
    ) -> Arc<dyn AgentProvider> {
        Self::with_admission(
            inner,
            Arc::new(GovernorAdmission {
                governor,
                interactive: true,
            }),
        )
    }

    pub(super) fn with_admission(
        inner: Arc<dyn AgentProvider>,
        admission: Arc<dyn ProviderAdmission>,
    ) -> Arc<dyn AgentProvider> {
        Arc::new(Self { inner, admission })
    }
}

/// The capacity one session holds for its current turn, if any.
struct AdmissionLifecycle {
    provider: ProviderId,
    admission: Arc<dyn ProviderAdmission>,
    permit: Mutex<Option<Box<dyn ProviderAdmissionPermit>>>,
}

impl AdmissionLifecycle {
    fn new(provider: ProviderId, admission: Arc<dyn ProviderAdmission>) -> Self {
        Self {
            provider,
            admission,
            permit: Mutex::new(None),
        }
    }

    /// Reserves capacity for a turn unless this session already holds it. Returns whether this
    /// call took the reservation.
    fn acquire(&self) -> Result<bool, ProviderError> {
        let mut permit = self.permit.lock().unwrap_or_else(PoisonError::into_inner);
        if permit.is_some() {
            return Ok(false);
        }
        *permit = Some(self.admission.reserve(self.provider.clone())?);
        Ok(true)
    }

    fn release(&self) {
        let permit = self
            .permit
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        drop(permit);
    }
}

/// The provider reports that no turn is running any more (or never will again).
fn ends_turn(event: &AgentEvent) -> bool {
    match event {
        AgentEvent::TurnCompleted { .. } | AgentEvent::Exited { .. } => true,
        AgentEvent::Status { status, .. } => matches!(
            status,
            ThreadStatus::Interrupted | ThreadStatus::Completed | ThreadStatus::Failed
        ),
        _ => false,
    }
}

struct AdmissionSink {
    inner: Box<dyn AgentEventSink>,
    lifecycle: Arc<AdmissionLifecycle>,
}

impl AgentEventSink for AdmissionSink {
    fn project_context(&self) -> Option<String> {
        self.inner.project_context()
    }
    fn project_context_for(&self, query: &str) -> Option<String> {
        self.inner.project_context_for(query)
    }
    fn remember(&self, text: &str) {
        self.inner.remember(text);
    }
    fn remember_user(&self, text: &str) {
        self.inner.remember_user(text);
    }
    fn emit(&self, event: AgentEvent) {
        if ends_turn(&event) {
            // Provider adapters report a turn's end only after its process work is done, and
            // `Exited` only after the supervised child/PTY exit path completed. Update capacity
            // before downstream state observes the event, so the next turn can be admitted.
            self.lifecycle.release();
        }
        self.inner.emit(event);
    }
}

struct AdmissionSession {
    // Drop the provider session before this wrapper's lifecycle reference. A provider reader or
    // pane registry may still own the admitted sink while asynchronous cleanup finishes; that
    // sink retains another lifecycle reference until canonical process exit.
    // Struct fields drop in declaration order. Keep this owning session first.
    inner: Box<dyn AgentSession>,
    lifecycle: Arc<AdmissionLifecycle>,
}

impl AgentSession for AdmissionSession {
    fn provider_session_id(&self) -> Option<String> {
        self.inner.provider_session_id()
    }

    fn send(&self, input: AgentInput) -> Result<(), ProviderError> {
        let acquired = self.lifecycle.acquire()?;
        match self.inner.send(input) {
            Ok(()) => Ok(()),
            Err(error) => {
                // No turn started: return the capacity this call took (never a running turn's).
                if acquired {
                    self.lifecycle.release();
                }
                Err(error)
            }
        }
    }

    fn interrupt(&self) -> Result<(), ProviderError> {
        self.inner.interrupt()
    }

    fn terminate(&self) -> Result<(), ProviderError> {
        // A successful request is not process-exit proof. The canonical Exited event, or dropping
        // the underlying process-owning session, releases the reservation.
        self.inner.terminate()
    }

    fn respond_to_approval(
        &self,
        request_id: &str,
        decision: ApprovalDecision,
    ) -> Result<(), ProviderError> {
        self.inner.respond_to_approval(request_id, decision)
    }
}

// No explicit release on drop: a process-owned sink can retain the lifecycle while its
// provider session completes asynchronous shutdown. Field order drops the session first.

impl AgentProvider for ResourceAdmissionProvider {
    fn id(&self) -> ProviderId {
        self.inner.id()
    }

    fn display_name(&self) -> &str {
        self.inner.display_name()
    }

    fn detect(&self) -> ProviderDetection {
        self.inner.detect()
    }

    fn capabilities(&self) -> ProviderCapabilities {
        self.inner.capabilities()
    }

    fn start_session(
        &self,
        config: SessionConfig,
        sink: Box<dyn AgentEventSink>,
    ) -> Result<Box<dyn AgentSession>, ProviderError> {
        let lifecycle = Arc::new(AdmissionLifecycle::new(
            self.inner.id(),
            Arc::clone(&self.admission),
        ));
        // Starting may spawn a process (Claude Code's persistent session), so it is admitted
        // like a turn. A hold returns before anything is spawned.
        lifecycle.acquire()?;
        let admitted_sink = Box::new(AdmissionSink {
            inner: sink,
            lifecycle: Arc::clone(&lifecycle),
        });
        let started = self.inner.start_session(config, admitted_sink);
        // The session is up (or failed) and no turn runs yet: an idle session holds nothing.
        // The first message is admitted by `send`.
        lifecycle.release();
        started.map(|session| {
            Box::new(AdmissionSession {
                inner: session,
                lifecycle,
            }) as Box<dyn AgentSession>
        })
    }
}
