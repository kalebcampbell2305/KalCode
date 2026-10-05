//! Feeds Provider Health from real sessions without touching the adapters.
//!
//! [`ObservedProvider`] wraps any [`AgentProvider`]: sessions it starts report to the
//! [`HealthMonitor`] (started, first output after each input, errors, successful turns, end).
//! Every provider event is forwarded to the thread runtime **first**; the observation after it
//! is a short in-memory update, so health can't delay, reorder or drop a thread's events.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Instant;

use kalcode_contracts::agent::{
    AgentEvent, AgentEventSink, AgentInput, AgentProvider, AgentSession, LaunchOrigin,
    ProviderCapabilities, ProviderDetection, ProviderError, ProviderId, SessionConfig,
};
use kalcode_contracts::permissions::ApprovalDecision;

use super::HealthMonitor;

/// An adapter whose sessions report to Provider Health.
pub struct ObservedProvider {
    inner: Arc<dyn AgentProvider>,
    monitor: Arc<HealthMonitor>,
}

impl ObservedProvider {
    pub fn new(inner: Arc<dyn AgentProvider>, monitor: Arc<HealthMonitor>) -> Self {
        Self { inner, monitor }
    }

    /// Wraps `inner` when a monitor exists; otherwise returns it unchanged (health is optional).
    pub fn wrap(
        inner: Arc<dyn AgentProvider>,
        monitor: Option<&Arc<HealthMonitor>>,
    ) -> Arc<dyn AgentProvider> {
        match monitor {
            Some(monitor) => Arc::new(Self::new(inner, Arc::clone(monitor))),
            None => inner,
        }
    }
}

/// Per-session observation state shared by the sink and the session wrapper.
struct Observer {
    provider: ProviderId,
    monitor: Arc<HealthMonitor>,
    /// When the last input was sent, until the first model output arrives.
    awaiting: Mutex<Option<Instant>>,
    ended: AtomicBool,
    /// `Exited` was seen (possibly before `start_session` returned).
    exited: AtomicBool,
}

impl Observer {
    fn end(&self) {
        if !self.ended.swap(true, Ordering::SeqCst) {
            self.monitor.session_ended(&self.provider);
        }
    }

    fn observe(&self, event: &AgentEvent) {
        match event {
            // Model output: the first after an input measures latency.
            AgentEvent::MessageDelta { .. }
            | AgentEvent::MessageCompleted { .. }
            | AgentEvent::ToolRequested { .. } => {
                let sent = self
                    .awaiting
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .take();
                if let Some(sent) = sent {
                    self.monitor.first_output(&self.provider, sent.elapsed());
                }
            }
            AgentEvent::Exited { .. } => {
                self.exited.store(true, Ordering::SeqCst);
                self.end();
            }
            AgentEvent::Error { .. } | AgentEvent::TurnCompleted { .. } => {
                self.monitor.event(&self.provider, event);
            }
            _ => {}
        }
    }
}

struct ObservedSink {
    inner: Box<dyn AgentEventSink>,
    observer: Arc<Observer>,
}

impl AgentEventSink for ObservedSink {
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
        // Observe a cheap summary first only where needed, then forward the event itself.
        let observed = matches!(
            event,
            AgentEvent::MessageDelta { .. }
                | AgentEvent::MessageCompleted { .. }
                | AgentEvent::ToolRequested { .. }
                | AgentEvent::Exited { .. }
                | AgentEvent::Error { .. }
                | AgentEvent::TurnCompleted { .. }
        );
        if observed {
            let copy = summary(&event);
            self.inner.emit(event);
            self.observer.observe(&copy);
        } else {
            self.inner.emit(event);
        }
    }
}

/// The parts of an event health reads (no message text is kept).
fn summary(event: &AgentEvent) -> AgentEvent {
    match event {
        AgentEvent::MessageDelta { .. } | AgentEvent::MessageCompleted { .. } => {
            AgentEvent::MessageDelta {
                message_id: String::new(),
                text: String::new(),
            }
        }
        AgentEvent::ToolRequested { .. } => AgentEvent::ToolRequested {
            tool_call_id: String::new(),
            tool: String::new(),
            summary: String::new(),
        },
        AgentEvent::Error {
            code, recoverable, ..
        } => AgentEvent::Error {
            code: code.clone(),
            message: String::new(),
            recoverable: *recoverable,
        },
        other => other.clone(),
    }
}

struct ObservedSession {
    inner: Box<dyn AgentSession>,
    observer: Arc<Observer>,
}

impl AgentSession for ObservedSession {
    fn provider_session_id(&self) -> Option<String> {
        self.inner.provider_session_id()
    }

    fn send(&self, input: AgentInput) -> Result<(), ProviderError> {
        *self
            .observer
            .awaiting
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(Instant::now());
        self.observer.monitor.input_sent(&self.observer.provider);
        self.inner.send(input)
    }

    fn interrupt(&self) -> Result<(), ProviderError> {
        self.observer
            .awaiting
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        self.inner.interrupt()
    }

    fn terminate(&self) -> Result<(), ProviderError> {
        let result = self.inner.terminate();
        self.observer.end();
        result
    }

    fn set_launch_origin(&self, origin: LaunchOrigin) {
        self.inner.set_launch_origin(origin);
    }

    fn respond_to_approval(
        &self,
        request_id: &str,
        decision: ApprovalDecision,
    ) -> Result<(), ProviderError> {
        self.inner.respond_to_approval(request_id, decision)
    }
}

impl Drop for ObservedSession {
    fn drop(&mut self) {
        self.observer.end();
    }
}

impl AgentProvider for ObservedProvider {
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
        let provider = self.inner.id();
        let observer = Arc::new(Observer {
            provider: provider.clone(),
            monitor: Arc::clone(&self.monitor),
            awaiting: Mutex::new(None),
            // Not counted until the start succeeds.
            ended: AtomicBool::new(true),
            exited: AtomicBool::new(false),
        });
        let observed_sink = Box::new(ObservedSink {
            inner: sink,
            observer: Arc::clone(&observer),
        });
        match self.inner.start_session(config, observed_sink) {
            Ok(session) => {
                if !observer.exited.load(Ordering::SeqCst) {
                    observer.ended.store(false, Ordering::SeqCst);
                    self.monitor.session_started(&provider);
                }
                Ok(Box::new(ObservedSession {
                    inner: session,
                    observer,
                }))
            }
            Err(error) => {
                self.monitor.start_failed(&provider, &error);
                Err(error)
            }
        }
    }
}
