//! Desktop ownership of the persistent, signed local interpreter. Acquiring a worker never
//! downloads anything. Its component leases and capacity reservation survive uncertain cleanup.

use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use kalcode_kalvoice::llama_worker::{LlamaWorker, LlamaWorkerLimits, LlamaWorkerStatus};
use kalcode_kalvoice::local_reasoning::{
    LocalInterpretation, LocalInterpretationCancellation, LocalInterpretationError,
    LocalInterpretationRequest, LocalInterpreter,
};
use kalcode_kalvoice::signals::LocalReasoningStatus;

use crate::kalvoice_components::KalVoiceComponentManager;
use crate::kalvoice_guardian::KalVoiceGuardianLauncher;
use crate::resource_commands::{LocalWorkloadEstimate, ResourceGovernorState};

trait ManagedInterpreter: LocalInterpreter {
    fn warm(&self, cancel: &LocalInterpretationCancellation) -> bool;
    fn stop(&self) -> bool;
    fn status(&self) -> LlamaWorkerStatus;
}

impl ManagedInterpreter for LlamaWorker {
    fn warm(&self, cancel: &LocalInterpretationCancellation) -> bool {
        self.start_with_control(Duration::from_secs(30), cancel)
            .is_ok()
    }
    fn stop(&self) -> bool {
        self.stop().is_ok()
    }
    fn status(&self) -> LlamaWorkerStatus {
        self.status()
    }
}

struct Resident {
    worker: Arc<dyn ManagedInterpreter>,
    // Mutex makes the Send-only owner shareable without ever releasing it during an operation.
    _capacity: Mutex<Box<dyn Send>>,
}

#[derive(Default)]
struct State {
    resident: Option<Arc<Resident>>,
    warming: bool,
    cleanup: Option<JoinHandle<bool>>,
}

pub(super) struct DesktopLocalInterpreter {
    components: Arc<KalVoiceComponentManager>,
    resources: Arc<ResourceGovernorState>,
    launcher: Option<Arc<KalVoiceGuardianLauncher>>,
    cancellation: LocalInterpretationCancellation,
    state: Mutex<State>,
}

impl DesktopLocalInterpreter {
    pub(super) fn new(
        components: Arc<KalVoiceComponentManager>,
        resources: Arc<ResourceGovernorState>,
        launcher: Option<Arc<KalVoiceGuardianLauncher>>,
    ) -> Arc<Self> {
        Arc::new(Self {
            components,
            resources,
            launcher,
            cancellation: LocalInterpretationCancellation::default(),
            state: Mutex::new(State::default()),
        })
    }

    /// Called only by the runtime's retained background task. No request can start a process.
    pub(super) fn warm(&self) {
        let Some(launcher) = &self.launcher else {
            return;
        };
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if self.cancellation.is_cancelled() || state.warming || state.cleanup.is_some() {
            return;
        }
        state.warming = true;
        let existing = state.resident.clone();
        drop(state);
        let resident = existing.or_else(|| {
            let Ok((runtime, model)) = self.components.acquire_reasoning() else {
                return None;
            };
            let limits = LlamaWorkerLimits::default();
            // GGUF bytes plus a bounded context/compute working set; reserve CPU for the actual
            // configured thread count for the entire resident process lifetime.
            let memory_mib = model
                .manifest()
                .size_bytes
                .div_ceil(1 << 20)
                .saturating_add(1024);
            let Ok(estimate) = LocalWorkloadEstimate::inference(
                Some(u32::from(limits.threads) * 1000),
                Some(memory_mib),
            ) else {
                return None;
            };
            let Ok(capacity) = self.resources.reserve_local_task(estimate) else {
                return None;
            };
            let Ok(worker) = LlamaWorker::new(runtime, model, limits, launcher.clone()) else {
                return None;
            };
            Some(Arc::new(Resident {
                worker: Arc::new(worker),
                _capacity: Mutex::new(Box::new(capacity)),
            }))
        });
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.resident = resident.clone();
        drop(state);
        if let Some(resident) = resident {
            let _ = resident.worker.warm(&self.cancellation);
        }
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .warming = false;
    }

    pub(super) fn status(&self) -> LocalReasoningStatus {
        if self.cancellation.is_cancelled() {
            return LocalReasoningStatus::Unavailable;
        }
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.warming {
            return LocalReasoningStatus::Warming;
        }
        let resident = state.resident.clone();
        drop(state);
        match resident.map(|resident| resident.worker.status()) {
            Some(LlamaWorkerStatus::Ready | LlamaWorkerStatus::Busy) => LocalReasoningStatus::Ready,
            Some(LlamaWorkerStatus::Starting) => LocalReasoningStatus::Warming,
            Some(_) => LocalReasoningStatus::Unavailable,
            None if self.components.reasoning_installed() => LocalReasoningStatus::Installed,
            None => LocalReasoningStatus::NotInstalled,
        }
    }

    pub(super) fn seal(&self) {
        self.cancellation.cancel();
    }

    /// Caller first drains request/background owners. A slow or failed stop retains both the
    /// JoinHandle and the resident owner; repeated calls retry without surrendering custody.
    pub(super) fn shutdown_reasoning(&self, deadline: Instant) -> bool {
        self.seal();
        loop {
            let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            if state.warming {
                return false;
            }
            if let Some(cleanup) = state.cleanup.as_ref() {
                if cleanup.is_finished() {
                    let clean = state
                        .cleanup
                        .take()
                        .is_some_and(|handle| handle.join().unwrap_or(false));
                    if clean {
                        state.resident = None;
                    }
                    return clean;
                }
            } else if let Some(resident) = state.resident.clone() {
                if Instant::now() >= deadline {
                    return false;
                }
                let launcher = self.launcher.clone();
                let Ok(handle) = std::thread::Builder::new()
                    .name("kalvoice-reasoning-stop".into())
                    .spawn(move || {
                        let clean = resident.worker.stop();
                        let guardian_clean = launcher.as_ref().is_none_or(|launcher| {
                            launcher
                                .retry_retained_cleanup(Instant::now() + Duration::from_secs(5))
                                .is_ok()
                        });
                        clean && guardian_clean
                    })
                else {
                    return false;
                };
                state.cleanup = Some(handle);
            } else {
                return self
                    .launcher
                    .as_ref()
                    .is_none_or(|launcher| launcher.retained_processes() == 0);
            }
            drop(state);
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(
                Duration::from_millis(5).min(deadline.saturating_duration_since(Instant::now())),
            );
        }
    }
}

impl LocalInterpreter for DesktopLocalInterpreter {
    fn interpret(
        &self,
        request: LocalInterpretationRequest,
        deadline: Instant,
        cancellation: &LocalInterpretationCancellation,
    ) -> Result<LocalInterpretation, LocalInterpretationError> {
        if self.cancellation.is_cancelled() {
            return Err(LocalInterpretationError::Unavailable);
        }
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.warming || state.cleanup.is_some() {
            return Err(LocalInterpretationError::Unavailable);
        }
        let resident = state
            .resident
            .clone()
            .ok_or(LocalInterpretationError::Unavailable)?;
        drop(state);
        resident.worker.interpret(request, deadline, cancellation)
    }
}

#[cfg(all(
    test,
    any(
        all(windows, target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64")
    )
))]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    struct FakeWorker {
        stop_allowed: AtomicBool,
        calls: AtomicUsize,
        stopping: AtomicBool,
    }
    impl LocalInterpreter for FakeWorker {
        fn interpret(
            &self,
            _: LocalInterpretationRequest,
            _: Instant,
            _: &LocalInterpretationCancellation,
        ) -> Result<LocalInterpretation, LocalInterpretationError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(LocalInterpretation::Uncertain)
        }
    }
    impl ManagedInterpreter for FakeWorker {
        fn warm(&self, _: &LocalInterpretationCancellation) -> bool {
            true
        }
        fn status(&self) -> LlamaWorkerStatus {
            LlamaWorkerStatus::Ready
        }
        fn stop(&self) -> bool {
            self.stopping.store(true, Ordering::SeqCst);
            self.stop_allowed.load(Ordering::SeqCst)
        }
    }
    struct Capacity(Arc<AtomicBool>);
    impl Drop for Capacity {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    fn request() -> LocalInterpretationRequest {
        LocalInterpretationRequest {
            request: "show the dashboard please".into(),
            workspace_id: None,
            workspaces: vec![],
        }
    }

    #[test]
    fn missing_provisioning_and_shutdown_never_launch_or_borrow_a_provider() {
        let (_temp, components) = crate::kalvoice_components::provisioning_tests::empty_manager();
        let host = DesktopLocalInterpreter::new(
            components,
            Arc::new(ResourceGovernorState::start()),
            None,
        );
        let cancel = LocalInterpretationCancellation::default();
        assert_eq!(host.status(), LocalReasoningStatus::NotInstalled);
        assert_eq!(
            host.interpret(request(), Instant::now() + Duration::from_secs(1), &cancel),
            Err(LocalInterpretationError::Unavailable)
        );
        host.warm();
        assert!(host.state.lock().unwrap().resident.is_none());
        assert!(host.shutdown_reasoning(Instant::now()));
        assert_eq!(host.status(), LocalReasoningStatus::Unavailable);
    }

    #[test]
    fn failed_cleanup_retains_capacity_and_interpreter_until_proven_retry() {
        let (_temp, components) = crate::kalvoice_components::provisioning_tests::empty_manager();
        let host = DesktopLocalInterpreter::new(
            components,
            Arc::new(ResourceGovernorState::start()),
            None,
        );
        let worker = Arc::new(FakeWorker {
            stop_allowed: AtomicBool::new(false),
            calls: AtomicUsize::new(0),
            stopping: AtomicBool::new(false),
        });
        let released = Arc::new(AtomicBool::new(false));
        host.state.lock().unwrap().resident = Some(Arc::new(Resident {
            worker: worker.clone(),
            _capacity: Mutex::new(Box::new(Capacity(released.clone()))),
        }));
        let cancel = LocalInterpretationCancellation::default();
        assert_eq!(
            host.interpret(request(), Instant::now() + Duration::from_secs(1), &cancel),
            Ok(LocalInterpretation::Uncertain)
        );
        assert!(!host.shutdown_reasoning(Instant::now() + Duration::from_secs(1)));
        assert!(worker.stopping.load(Ordering::SeqCst));
        assert!(!released.load(Ordering::SeqCst));
        assert_eq!(
            host.interpret(request(), Instant::now() + Duration::from_secs(1), &cancel),
            Err(LocalInterpretationError::Unavailable)
        );
        assert_eq!(worker.calls.load(Ordering::SeqCst), 1);
        worker.stop_allowed.store(true, Ordering::SeqCst);
        assert!(host.shutdown_reasoning(Instant::now() + Duration::from_secs(1)));
        assert!(released.load(Ordering::SeqCst));
        assert!(host.shutdown_reasoning(Instant::now()));
    }
}
