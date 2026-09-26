//! Account-bound Environment Doctor IPC. WebView inputs are catalog ids only; native code
//! resolves workspace roots and retains the sole long-running worker through shutdown.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError, mpsc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use kalcode_core::{Core, ErrorCategory, IpcError, KalError, Result};
use kalcode_doctor::context::{HealthSource, ProviderSource};
use kalcode_doctor::gate::FixGate;
use kalcode_doctor::{
    Doctor, DoctorConfig, DoctorRun, FixLogEntry, FixOutcome, FixPreview, FixRequest, HostFacts,
    IgnoreRequest, IgnoredList, ProjectFacts, RevertRequest, RunRequest, RunStatus,
};
use kalcode_git::GitCore;
use kalcode_permissions::PermissionService;
use kalcode_providers::{HealthMonitor, ProviderRegistry};

use crate::runtime_coordinator::{RuntimeAccess, RuntimeState};

const WORKER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);

#[cfg(target_os = "macos")]
#[derive(Debug)]
struct KalVoiceMicrophonePermissionSource;

#[cfg(target_os = "macos")]
impl kalcode_doctor::context::MicrophonePermissionSource for KalVoiceMicrophonePermissionSource {
    fn current(&self) -> kalcode_doctor::context::MicrophonePermissionState {
        use kalcode_doctor::context::MicrophonePermissionState as DoctorState;
        use kalcode_kalvoice::audio::MicrophonePermission as NativeState;

        match kalcode_kalvoice::audio::microphone_permission() {
            NativeState::Granted => DoctorState::Granted,
            NativeState::Denied => DoctorState::Denied,
            NativeState::NotDetermined => DoctorState::NotDetermined,
            NativeState::Unknown => DoctorState::Unknown,
            NativeState::Unsupported => DoctorState::Unsupported,
        }
    }
}

fn microphone_permission_source()
-> Option<Arc<dyn kalcode_doctor::context::MicrophonePermissionSource>> {
    #[cfg(target_os = "macos")]
    {
        Some(Arc::new(KalVoiceMicrophonePermissionSource))
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

struct RunJob {
    run_id: String,
    prepared: kalcode_doctor::service::PreparedRun,
    runtime_access: RuntimeAccess,
    state: RuntimeState<DoctorState>,
}

struct WorkerControl {
    sender: Option<mpsc::SyncSender<RunJob>>,
    handle: Option<JoinHandle<()>>,
    failed: bool,
}

/// One account-runtime-owned Doctor service. A missing prerequisite is retained as a stable
/// unavailable state; production never substitutes a memory or standalone history store.
pub struct DoctorState {
    core: Option<Arc<Core>>,
    doctor: Option<Arc<Doctor>>,
    unavailable_code: &'static str,
    worker: Mutex<WorkerControl>,
}

impl DoctorState {
    pub fn start(
        core: Option<Arc<Core>>,
        providers: Arc<ProviderRegistry>,
        monitor: Option<Arc<HealthMonitor>>,
        permissions: Option<Arc<PermissionService>>,
        git: Arc<GitCore>,
    ) -> Self {
        let Some(core) = core else {
            return Self::unavailable(None, "core_unavailable");
        };
        let Some(monitor) = monitor else {
            return Self::unavailable(Some(core), "provider_health_unavailable");
        };
        let Some(permissions) = permissions else {
            return Self::unavailable(Some(core), "permissions_unavailable");
        };
        let provider_source: Arc<dyn ProviderSource> = Arc::new(HealthSource {
            monitor,
            registry: providers,
        });
        let gate: Arc<dyn FixGate> = permissions;
        let config = DoctorConfig {
            core: Arc::clone(&core),
            host: HostFacts::from_process(
                tauri::webview_version()
                    .map_err(|_| "The desktop runtime did not report its WebView version.".into()),
                kalcode_core::db::MIGRATIONS,
            ),
            providers: Some(provider_source),
            git: Some(git),
            microphone_permission: microphone_permission_source(),
            gate,
            // A missing/corrupt registered v16 schema disables production Doctor state.
            require_persistent: true,
        };
        let doctor = match Doctor::open(config) {
            Ok(doctor) => Arc::new(doctor),
            Err(error) => {
                tracing::error!(
                    event = "doctor.start_failed",
                    error_code = error.code,
                    error = %error.diagnostic()
                );
                return Self::unavailable(Some(core), "doctor_unavailable");
            }
        };
        let (sender, receiver) = mpsc::sync_channel::<RunJob>(1);
        let worker_doctor = Arc::clone(&doctor);
        let handle = match std::thread::Builder::new()
            .name("kalcode-environment-doctor".into())
            .spawn(move || worker_loop(worker_doctor, receiver))
        {
            Ok(handle) => handle,
            Err(error) => {
                tracing::error!(event = "doctor.worker_start_failed", error = %error);
                return Self::unavailable(Some(core), "doctor_worker_unavailable");
            }
        };
        Self {
            core: Some(core),
            doctor: Some(doctor),
            unavailable_code: "",
            worker: Mutex::new(WorkerControl {
                sender: Some(sender),
                handle: Some(handle),
                failed: false,
            }),
        }
    }

    fn unavailable(core: Option<Arc<Core>>, code: &'static str) -> Self {
        Self {
            core,
            doctor: None,
            unavailable_code: code,
            worker: Mutex::new(WorkerControl {
                sender: None,
                handle: None,
                failed: false,
            }),
        }
    }

    fn doctor(&self) -> Result<Arc<Doctor>> {
        self.doctor.clone().ok_or_else(|| {
            KalError::new(
                ErrorCategory::Internal,
                self.unavailable_code,
                "Environment Doctor is unavailable in this account runtime.",
            )
        })
    }

    fn core(&self) -> Result<&Arc<Core>> {
        self.core.as_ref().ok_or_else(|| {
            KalError::internal(
                "core_unavailable",
                "KalCode's account runtime is unavailable.",
            )
        })
    }

    fn sender(&self) -> Result<mpsc::SyncSender<RunJob>> {
        let worker = self.worker.lock().unwrap_or_else(PoisonError::into_inner);
        if worker.failed {
            return Err(KalError::internal(
                "doctor_worker_failed",
                "The Environment Doctor worker stopped unexpectedly. Restart KalCode.",
            ));
        }
        worker.sender.clone().ok_or_else(|| {
            KalError::internal(
                "doctor_worker_unavailable",
                "The Environment Doctor worker is stopping.",
            )
        })
    }

    /// Cancels the active run, closes the queue and joins the retained worker. On timeout the
    /// handle stays owned by this state so the coordinator can retry instead of losing proof.
    pub fn shutdown_checked(&self) -> Result<()> {
        if let Some(doctor) = &self.doctor
            && let Some(run) = doctor.last()
            && run.status == RunStatus::Running
        {
            let _ = doctor.cancel(&run.id);
        }
        let mut worker = self.worker.lock().unwrap_or_else(PoisonError::into_inner);
        worker.sender.take();
        if worker.failed {
            return Err(KalError::internal(
                "doctor_worker_failed",
                "The Environment Doctor worker stopped unexpectedly.",
            ));
        }
        let Some(handle) = worker.handle.as_ref() else {
            return Ok(());
        };
        let deadline = Instant::now() + WORKER_SHUTDOWN_TIMEOUT;
        while !handle.is_finished() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        if !handle.is_finished() {
            return Err(KalError::internal(
                "doctor_shutdown_timeout",
                "Environment Doctor did not stop before the shutdown deadline.",
            ));
        }
        let Some(handle) = worker.handle.take() else {
            return Ok(());
        };
        if handle.join().is_err() {
            worker.failed = true;
            return Err(KalError::internal(
                "doctor_worker_failed",
                "The Environment Doctor worker stopped unexpectedly.",
            ));
        }
        Ok(())
    }
}

fn worker_loop(doctor: Arc<Doctor>, receiver: mpsc::Receiver<RunJob>) {
    while let Ok(job) = receiver.recv() {
        let run_id = job.run_id.clone();
        if job.runtime_access.revalidate_core().is_err() || job.state.revalidate_core().is_err() {
            let _ = doctor.abandon_run(&run_id);
            continue;
        }
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            doctor.execute(job.prepared)
        }));
        match result {
            Ok(Ok(_)) => {}
            Ok(Err(error)) => tracing::warn!(
                event = "doctor.run_failed",
                error_code = error.code,
                error = %error.diagnostic()
            ),
            Err(_) => {
                let _ = doctor.abandon_run(&run_id);
                tracing::error!(event = "doctor.worker_panicked", run_id = %run_id);
            }
        }
    }
}

fn convert<T>(command: &'static str, result: Result<T>) -> std::result::Result<T, IpcError> {
    result.map_err(|error| error.log_and_convert(command))
}

fn resolve_project(core: &Core, requested: Option<&str>) -> Result<Option<ProjectFacts>> {
    let Some(requested) = requested else {
        return Ok(None);
    };
    if !kalcode_contracts::ids::is_valid_id(requested) {
        return Err(KalError::validation(
            "invalid_id",
            "That workspace id is invalid.",
        ));
    }
    let workspace = core
        .workspaces()?
        .into_iter()
        .find(|workspace| workspace.id == requested)
        .ok_or_else(|| {
            KalError::validation("workspace_unknown", "That workspace no longer exists.")
        })?;
    if !workspace.available {
        return Err(KalError::new(
            ErrorCategory::Filesystem,
            "workspace_unavailable",
            "That workspace folder is unavailable.",
        ));
    }
    Ok(Some(ProjectFacts {
        workspace_id: workspace.id,
        name: workspace.name,
        root: PathBuf::from(workspace.root_path),
    }))
}

async fn blocking<T: Send + 'static>(
    runtime_access: RuntimeAccess,
    state: RuntimeState<DoctorState>,
    command: &'static str,
    work: impl FnOnce(Arc<Doctor>) -> Result<T> + Send + 'static,
) -> std::result::Result<T, IpcError> {
    tauri::async_runtime::spawn_blocking(move || {
        runtime_access.revalidate_core()?;
        state.revalidate_core()?;
        work(state.doctor()?)
    })
    .await
    .map_err(|error| {
        KalError::internal("doctor_worker_interrupted", "The Doctor worker stopped.")
            .with_source(error)
            .log_and_convert(command)
    })?
    .map_err(|error| error.log_and_convert(command))
}

/// Returns a running snapshot immediately; the retained worker owns the immutable run plan.
#[tauri::command]
pub async fn doctor_run(
    runtime_access: RuntimeAccess,
    state: RuntimeState<DoctorState>,
    request: RunRequest,
) -> std::result::Result<DoctorRun, IpcError> {
    runtime_access.revalidate()?;
    state.revalidate()?;
    let doctor = convert("doctor_run", state.doctor())?;
    let project = convert(
        "doctor_run",
        resolve_project(
            convert("doctor_run", state.core())?.as_ref(),
            request.workspace_id.as_deref(),
        ),
    )?;
    let sender = convert("doctor_run", state.sender())?;
    let (snapshot, prepared) = convert("doctor_run", doctor.begin(request, project))?;
    let job = RunJob {
        run_id: snapshot.id.clone(),
        prepared,
        runtime_access,
        state,
    };
    if let Err(error) = sender.try_send(job) {
        let (code, message, job) = match error {
            mpsc::TrySendError::Full(job) => (
                "doctor_queue_full",
                "Environment Doctor already has a queued run. Wait for it to finish or cancel it.",
                job,
            ),
            mpsc::TrySendError::Disconnected(job) => (
                "doctor_worker_unavailable",
                "The Environment Doctor worker is unavailable. Restart KalCode.",
                job,
            ),
        };
        let _ = doctor.abandon_run(&snapshot.id);
        drop(job);
        return Err(KalError::internal(code, message).log_and_convert("doctor_run"));
    }
    Ok(snapshot)
}

#[tauri::command(async)]
pub fn doctor_cancel(
    runtime_access: RuntimeAccess,
    state: RuntimeState<DoctorState>,
    run_id: String,
) -> std::result::Result<DoctorRun, IpcError> {
    runtime_access.revalidate()?;
    state.revalidate()?;
    convert("doctor_cancel", state.doctor()?.cancel(&run_id))
}

#[tauri::command(async)]
pub fn doctor_last(
    runtime_access: RuntimeAccess,
    state: RuntimeState<DoctorState>,
) -> std::result::Result<Option<DoctorRun>, IpcError> {
    runtime_access.revalidate()?;
    state.revalidate()?;
    Ok(state.doctor()?.last())
}

#[tauri::command]
pub async fn doctor_fix_preview(
    runtime_access: RuntimeAccess,
    state: RuntimeState<DoctorState>,
    request: FixRequest,
) -> std::result::Result<FixPreview, IpcError> {
    blocking(runtime_access, state, "doctor_fix_preview", move |doctor| {
        doctor.fix_preview(&request)
    })
    .await
}

#[tauri::command]
pub async fn doctor_fix(
    runtime_access: RuntimeAccess,
    state: RuntimeState<DoctorState>,
    request: FixRequest,
) -> std::result::Result<FixOutcome, IpcError> {
    blocking(runtime_access, state, "doctor_fix", move |doctor| {
        doctor.fix(&request)
    })
    .await
}

#[tauri::command]
pub async fn doctor_revert(
    runtime_access: RuntimeAccess,
    state: RuntimeState<DoctorState>,
    request: RevertRequest,
) -> std::result::Result<FixOutcome, IpcError> {
    blocking(runtime_access, state, "doctor_revert", move |doctor| {
        doctor.revert(&request)
    })
    .await
}

#[tauri::command(async)]
pub fn doctor_ignore(
    runtime_access: RuntimeAccess,
    state: RuntimeState<DoctorState>,
    request: IgnoreRequest,
) -> std::result::Result<DoctorRun, IpcError> {
    runtime_access.revalidate()?;
    state.revalidate()?;
    convert("doctor_ignore", state.doctor()?.ignore(request))
}

#[tauri::command(async)]
pub fn doctor_ignored(
    runtime_access: RuntimeAccess,
    state: RuntimeState<DoctorState>,
) -> std::result::Result<IgnoredList, IpcError> {
    runtime_access.revalidate()?;
    state.revalidate()?;
    convert("doctor_ignored", state.doctor()?.ignored())
}

#[tauri::command(async)]
pub fn doctor_fix_log(
    runtime_access: RuntimeAccess,
    state: RuntimeState<DoctorState>,
    limit: usize,
) -> std::result::Result<Vec<FixLogEntry>, IpcError> {
    runtime_access.revalidate()?;
    state.revalidate()?;
    convert("doctor_fix_log", state.doctor()?.fix_log(limit))
}
