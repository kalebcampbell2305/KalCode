//! Admission wrapper for managed provider sessions.
//!
//! This is deliberately attached only to the provider adapters registered for thread execution.
//! Provider detection, sign-in, account maintenance, and status probes do not acquire a slot.

use std::sync::{Arc, Mutex, PoisonError};

use kalcode_contracts::agent::{
    AgentEvent, AgentEventSink, AgentInput, AgentProvider, AgentSession, ProviderCapabilities,
    ProviderDetection, ProviderError, ProviderId, SessionConfig,
};
use kalcode_contracts::permissions::ApprovalDecision;

use super::{ProviderTaskReservation, ResourceGovernorState};

pub(super) trait ProviderAdmissionPermit: Send + Sync {}

pub(super) trait ProviderAdmission: Send + Sync {
    fn reserve(
        &self,
        provider: ProviderId,
    ) -> Result<Box<dyn ProviderAdmissionPermit>, ProviderError>;
}

struct GovernorAdmission {
    governor: Arc<ResourceGovernorState>,
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
        match self.governor.reserve_provider_task(provider.clone()) {
            Ok(reservation) => Ok(Box::new(GovernorPermit {
                _reservation: reservation,
            })),
            Err(decision) => {
                tracing::info!(
                    event = "resources.provider_launch_held",
                    provider_id = %provider,
                    snapshot_seq = ?decision.snapshot_seq,
                    reasons = decision.reasons.len(),
                    "resource admission held a managed provider start"
                );
                Err(ProviderError::Start(
                    "KalCode held this provider start until current resource telemetry and capacity are available."
                        .into(),
                ))
            }
        }
    }
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
        Self::with_admission(inner, Arc::new(GovernorAdmission { governor }))
    }

    pub(super) fn with_admission(
        inner: Arc<dyn AgentProvider>,
        admission: Arc<dyn ProviderAdmission>,
    ) -> Arc<dyn AgentProvider> {
        Arc::new(Self { inner, admission })
    }
}

struct AdmissionLifecycle {
    permit: Mutex<Option<Box<dyn ProviderAdmissionPermit>>>,
}

impl AdmissionLifecycle {
    fn new(permit: Box<dyn ProviderAdmissionPermit>) -> Self {
        Self {
            permit: Mutex::new(Some(permit)),
        }
    }

    fn release(&self) {
        self.permit
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
    }
}

struct AdmissionSink {
    inner: Box<dyn AgentEventSink>,
    lifecycle: Arc<AdmissionLifecycle>,
}

impl AgentEventSink for AdmissionSink {
    fn emit(&self, event: AgentEvent) {
        if matches!(event, AgentEvent::Exited { .. }) {
            // Provider adapters emit Exited only after their supervised child/PTY exit path has
            // completed. Update capacity before downstream state observes that terminal event.
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
    _lifecycle: Arc<AdmissionLifecycle>,
}

impl AgentSession for AdmissionSession {
    fn provider_session_id(&self) -> Option<String> {
        self.inner.provider_session_id()
    }

    fn send(&self, input: AgentInput) -> Result<(), ProviderError> {
        self.inner.send(input)
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
            self.admission.reserve(self.inner.id())?,
        ));
        let admitted_sink = Box::new(AdmissionSink {
            inner: sink,
            lifecycle: Arc::clone(&lifecycle),
        });
        match self.inner.start_session(config, admitted_sink) {
            Ok(session) => Ok(Box::new(AdmissionSession {
                inner: session,
                _lifecycle: lifecycle,
            })),
            Err(error) => {
                lifecycle.release();
                Err(error)
            }
        }
    }
}
