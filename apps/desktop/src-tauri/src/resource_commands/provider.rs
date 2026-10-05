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
//!
//! A coding agent the person asked for (a pane, New agent, KalVoice, a user-initiated Squad or
//! Handoff, Resume) uses the user-requested policy, provider-agnostic: CPU load never holds a
//! launch; only genuine hard pressure, an explicit Custom limit, or the OS refusing to create the
//! process does, with the real reason and Start Anyway. A session the Operations scheduler starts
//! (`SessionConfig::launch_origin` = `Background`) uses the strict background policy instead and
//! yields to CPU load first (`LaunchHoldKind::BackgroundYield`). The origin is per turn: once the
//! person sends a message on a scheduled session (`AgentSession::set_launch_origin`), its turns
//! are theirs and use the user-requested policy.

use std::sync::{Arc, Mutex, PoisonError};

use kalcode_contracts::agent::{
    AgentEvent, AgentEventSink, AgentInput, AgentProvider, AgentSession, LaunchOrigin,
    ProviderCapabilities, ProviderDetection, ProviderError, ProviderId, SessionConfig,
};
use kalcode_contracts::permissions::ApprovalDecision;
use kalcode_contracts::resources::{LaunchHold, LaunchHoldKind};
use kalcode_contracts::threads::ThreadStatus;
use kalcode_resources::AdmissionDecision;

use super::{AgentLaunch, ProviderTaskReservation, ResourceGovernorState};

pub(super) trait ProviderAdmissionPermit: Send + Sync {}

/// Admitted without a slot: the governor had nothing that may hold a user-requested agent but
/// could not record the reservation (a counter overflow). The agent starts anyway.
struct UnaccountedPermit;

impl ProviderAdmissionPermit for UnaccountedPermit {}

pub(super) trait ProviderAdmission: Send + Sync {
    /// Reserves one turn's capacity. A hold is `ProviderError::ResourcesHeld`, never `Start`.
    fn reserve(
        &self,
        provider: ProviderId,
        launch: &AgentLaunch,
    ) -> Result<Box<dyn ProviderAdmissionPermit>, ProviderError>;

    /// How soon a held launch re-checks, and how long it may wait in total.
    fn hold_timing(&self) -> (std::time::Duration, std::time::Duration) {
        (
            kalcode_resources::ADMISSION_RETRY_MAX,
            kalcode_resources::ADMISSION_WAIT_LIMIT,
        )
    }
}

pub(super) struct GovernorAdmission {
    governor: Arc<ResourceGovernorState>,
}

impl GovernorAdmission {
    pub(super) fn new(governor: Arc<ResourceGovernorState>) -> Self {
        Self { governor }
    }
}

struct GovernorPermit {
    _reservation: ProviderTaskReservation,
}

impl ProviderAdmissionPermit for GovernorPermit {}

impl ProviderAdmission for GovernorAdmission {
    fn reserve(
        &self,
        provider: ProviderId,
        launch: &AgentLaunch,
    ) -> Result<Box<dyn ProviderAdmissionPermit>, ProviderError> {
        match self
            .governor
            .reserve_provider_task(provider.clone(), launch)
        {
            Ok(reservation) => Ok(Box::new(GovernorPermit {
                _reservation: reservation,
            })),
            Err(decision) => {
                log_launch_hold(&provider, &decision);
                let (retry_after, wait_limit) = self.hold_timing();
                match kalcode_resources::launch_hold(&decision, retry_after, wait_limit) {
                    Some(hold) => Err(ProviderError::ResourcesHeld(hold)),
                    // Background work held by soft load (CPU, headroom, an old sample) yields.
                    None if launch.origin == LaunchOrigin::Background => {
                        Err(ProviderError::ResourcesHeld(LaunchHold::new(
                            LaunchHoldKind::BackgroundYield,
                            retry_after,
                            wait_limit,
                        )))
                    }
                    // Nothing that may hold a user-requested agent: start it.
                    None => Ok(Box::new(UnaccountedPermit)),
                }
            }
        }
    }

    fn hold_timing(&self) -> (std::time::Duration, std::time::Duration) {
        (
            self.governor.admission_retry_interval(),
            kalcode_resources::ADMISSION_WAIT_LIMIT,
        )
    }
}

/// The OS refused to create the provider's process (out of memory, commit, or process slots):
/// a hard-pressure hold the thread waits on with the real reason, not a provider failure.
fn process_exhaustion_hold(
    error: ProviderError,
    admission: &dyn ProviderAdmission,
    provider: &ProviderId,
) -> ProviderError {
    match error {
        ProviderError::Start(detail) if kalcode_resources::process_creation_exhausted(&detail) => {
            tracing::warn!(
                event = "resources.process_creation_refused",
                provider_id = %provider,
                "the operating system refused to create a provider process"
            );
            let (retry_after, wait_limit) = admission.hold_timing();
            ProviderError::ResourcesHeld(LaunchHold::new(
                LaunchHoldKind::ProcessLimit,
                retry_after,
                wait_limit,
            ))
        }
        other => other,
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
        Self::with_admission(inner, Arc::new(GovernorAdmission::new(governor)))
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
    /// Who asks for the next turn. A person's message on a scheduled session makes it theirs
    /// (`AgentSession::set_launch_origin`), so their turns are never held for CPU load.
    launch: Mutex<AgentLaunch>,
    admission: Arc<dyn ProviderAdmission>,
    permit: Mutex<Option<Box<dyn ProviderAdmissionPermit>>>,
}

impl AdmissionLifecycle {
    fn new(
        provider: ProviderId,
        launch: AgentLaunch,
        admission: Arc<dyn ProviderAdmission>,
    ) -> Self {
        Self {
            provider,
            launch: Mutex::new(launch),
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
        let launch = self
            .launch
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        *permit = Some(self.admission.reserve(self.provider.clone(), &launch)?);
        Ok(true)
    }

    fn set_origin(&self, origin: LaunchOrigin) {
        self.launch
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .origin = origin;
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
                Err(process_exhaustion_hold(
                    error,
                    self.lifecycle.admission.as_ref(),
                    &self.lifecycle.provider,
                ))
            }
        }
    }

    fn interrupt(&self) -> Result<(), ProviderError> {
        self.inner.interrupt()
    }

    fn set_launch_origin(&self, origin: LaunchOrigin) {
        self.lifecycle.set_origin(origin);
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
            AgentLaunch {
                thread_id: Some(config.thread_id.clone()),
                workspace_id: Some(config.workspace_id.clone()),
                origin: config.launch_origin,
            },
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
        let started = started.map_err(|error| {
            process_exhaustion_hold(error, self.admission.as_ref(), &self.inner.id())
        });
        started.map(|session| {
            Box::new(AdmissionSession {
                inner: session,
                lifecycle,
            }) as Box<dyn AgentSession>
        })
    }
}
