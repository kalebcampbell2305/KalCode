use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

#[cfg(windows)]
use std::os::windows::io::BorrowedHandle;

use kalcode_contracts::agent::ProviderId;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[cfg(target_os = "macos")]
pub mod custodian;
pub mod marker;
pub mod platform;
pub mod protocol;
pub mod server;
mod store;
mod supervisor;

use store::FileMarkerStore;
pub use supervisor::GuardianSupervisor;

use marker::{JobId, MarkerState, ProfileMarker};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct DesktopGeneration(Uuid);

impl DesktopGeneration {
    pub const fn from_uuid(value: Uuid) -> Self {
        Self(value)
    }

    pub const fn as_uuid(self) -> Uuid {
        self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct ProfileGeneration(Uuid);

impl ProfileGeneration {
    pub const fn from_uuid(value: Uuid) -> Self {
        Self(value)
    }

    pub const fn as_uuid(self) -> Uuid {
        self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct ProfileIdentity {
    subject_kind: GuardianSubjectKind,
    provider_id: ProviderId,
    account_id: Uuid,
    generation: ProfileGeneration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GuardianSubjectKind {
    ProviderAccount,
    InternalTerminal,
    InternalProbe,
}

impl ProfileIdentity {
    pub fn new(
        provider_id: ProviderId,
        account_id: Uuid,
        generation: ProfileGeneration,
    ) -> Result<Self, GuardianError> {
        let identity = Self {
            subject_kind: GuardianSubjectKind::ProviderAccount,
            provider_id,
            account_id,
            generation,
        };
        identity.validate()?;
        Ok(identity)
    }

    pub fn internal_terminal(
        desktop_generation: DesktopGeneration,
        generation: ProfileGeneration,
    ) -> Result<Self, GuardianError> {
        let identity = Self {
            subject_kind: GuardianSubjectKind::InternalTerminal,
            provider_id: ProviderId::new("kalcode-terminal"),
            account_id: desktop_generation.as_uuid(),
            generation,
        };
        identity.validate()?;
        Ok(identity)
    }

    pub fn internal_probe(
        desktop_generation: DesktopGeneration,
        generation: ProfileGeneration,
    ) -> Result<Self, GuardianError> {
        let identity = Self {
            subject_kind: GuardianSubjectKind::InternalProbe,
            provider_id: ProviderId::new("kalcode-probe"),
            account_id: desktop_generation.as_uuid(),
            generation,
        };
        identity.validate()?;
        Ok(identity)
    }

    pub const fn subject_kind(&self) -> GuardianSubjectKind {
        self.subject_kind
    }

    pub fn provider_id(&self) -> &ProviderId {
        &self.provider_id
    }

    pub const fn account_id(&self) -> Uuid {
        self.account_id
    }

    pub const fn generation(&self) -> ProfileGeneration {
        self.generation
    }

    fn validate(&self) -> Result<(), GuardianError> {
        let subject_valid = match self.subject_kind {
            GuardianSubjectKind::ProviderAccount => {
                self.provider_id.as_str() != "kalcode-terminal"
                    && self.provider_id.as_str() != "kalcode-probe"
            }
            GuardianSubjectKind::InternalTerminal => {
                self.provider_id.as_str() == "kalcode-terminal"
            }
            GuardianSubjectKind::InternalProbe => self.provider_id.as_str() == "kalcode-probe",
        };
        if !subject_valid
            || self.provider_id.as_str().is_empty()
            || self.provider_id.as_str().len() > 128
            || !self
                .provider_id
                .as_str()
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            || self.account_id.is_nil()
            || self.generation.0.is_nil()
        {
            return Err(GuardianError::InvalidIdentity);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessIdentity {
    pid: u32,
    birth_time_100ns: u64,
}

impl ProcessIdentity {
    pub const fn new(pid: u32, birth_time_100ns: u64) -> Result<Self, GuardianError> {
        if pid == 0 || birth_time_100ns == 0 {
            return Err(GuardianError::InvalidIdentity);
        }
        Ok(Self {
            pid,
            birth_time_100ns,
        })
    }

    pub const fn pid(self) -> u32 {
        self.pid
    }

    const fn is_valid(self) -> bool {
        self.pid != 0 && self.birth_time_100ns != 0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProfileCapability {
    SharedSession,
    ExclusiveAuth,
    ExclusiveLifecycle,
}

#[derive(Debug, thiserror::Error)]
pub enum GuardianError {
    #[error("the provider guardian has sealed this desktop generation")]
    Sealed,
    #[error("the managed provider profile is in use")]
    ProfileInUse,
    #[error("the provider guardian lease is no longer active")]
    LeaseExpired,
    #[error("the provider guardian rejected a replay")]
    Replay,
    #[error("the provider guardian object identity does not match")]
    ObjectMismatch,
    #[error("the provider guardian job is unknown")]
    UnknownJob,
    #[error("the provider guardian state transition is invalid")]
    InvalidTransition,
    #[error("the provider guardian identity is invalid")]
    InvalidIdentity,
    #[error("the provider guardian marker schema {0} is unsupported")]
    UnknownSchema(u16),
    #[error("the provider guardian marker is internally inconsistent")]
    CorruptMarker,
    #[error("the provider guardian marker could not be encoded: {0}")]
    MarkerEncoding(serde_json::Error),
    #[error("provider process quiescence is not yet proved")]
    QuiescencePending,
    #[error("the provider guardian cannot prove the prior process tree clean")]
    BlockedUnclean,
    #[error("the provider guardian is unavailable: {0}")]
    Unavailable(String),
    #[error("the provider guardian mutex was poisoned")]
    Poisoned,
}

pub(crate) trait MarkerStore: Send + Sync {
    fn persist(&self, marker: &ProfileMarker) -> Result<(), GuardianError>;
}

pub(crate) trait JobControl: Send + Sync {
    fn prepare(&self, job: JobId, label: &str) -> Result<String, GuardianError>;
    fn seal(&self) -> Result<(), GuardianError>;
    fn terminate(&self, job: JobId) -> Result<(), GuardianError>;
    fn active_processes(&self, job: JobId) -> Result<u32, GuardianError>;
    fn release(&self, job: JobId) -> Result<(), GuardianError>;
    #[cfg(target_os = "macos")]
    fn macos_command(
        &self,
        job: JobId,
        launch: custodian::MacLaunch,
    ) -> Result<std::process::Command, GuardianError>;
    #[cfg(target_os = "macos")]
    fn macos_spawn(
        &self,
        job: JobId,
        command: std::process::Command,
    ) -> Result<MacSpawned, GuardianError>;
    #[cfg(target_os = "macos")]
    fn macos_activate(&self, job: JobId) -> Result<(), GuardianError>;
    #[cfg(windows)]
    fn raw_job_handle(&self, job: JobId) -> Result<usize, GuardianError>;
    #[cfg(windows)]
    fn assign_suspended_process(
        &self,
        job: JobId,
        process: BorrowedHandle<'_>,
        pid: u32,
    ) -> Result<ProcessIdentity, GuardianError>;
    fn identify_process(
        &self,
        job: JobId,
        expected: ProcessIdentity,
    ) -> Result<ProcessIdentity, GuardianError>;
    fn complete(&self) -> Result<(), GuardianError>;
}

#[cfg(target_os = "macos")]
pub(crate) struct MacSpawned {
    pub child: std::process::Child,
    pub root: ProcessIdentity,
}

#[derive(Clone)]
pub struct GuardianAuthority {
    inner: Arc<GuardianInner>,
}

struct GuardianInner {
    boot_id: Uuid,
    desktop_generation: DesktopGeneration,
    desktop_process: ProcessIdentity,
    guardian_process: ProcessIdentity,
    marker_store: Arc<dyn MarkerStore>,
    jobs: Arc<dyn JobControl>,
    state: Mutex<AuthorityState>,
    // Keep this last so provider/job authority drops before the desktop epoch fence is released.
    _desktop_recovery: Option<Arc<platform::RecoveryLock>>,
}

#[derive(Default)]
struct AuthorityState {
    sealed: bool,
    seal_complete: bool,
    blocked_unclean: bool,
    profiles: BTreeMap<ProfileIdentity, ProfileMarker>,
}

impl GuardianAuthority {
    pub(crate) fn new<S, J>(
        boot_id: Uuid,
        desktop_generation: DesktopGeneration,
        desktop_process: ProcessIdentity,
        guardian_process: ProcessIdentity,
        marker_store: Arc<S>,
        jobs: Arc<J>,
        desktop_recovery: Option<Arc<platform::RecoveryLock>>,
    ) -> Self
    where
        S: MarkerStore + 'static,
        J: JobControl + 'static,
    {
        Self {
            inner: Arc::new(GuardianInner {
                boot_id,
                desktop_generation,
                desktop_process,
                guardian_process,
                marker_store,
                jobs,
                state: Mutex::new(AuthorityState::default()),
                _desktop_recovery: desktop_recovery,
            }),
        }
    }

    pub fn acquire(
        &self,
        profile: ProfileIdentity,
        capability: ProfileCapability,
    ) -> Result<GuardianLease, GuardianError> {
        let lease_id = Uuid::new_v4();
        let mut state = self.lock()?;
        if state.blocked_unclean {
            return Err(GuardianError::BlockedUnclean);
        }
        if state.sealed {
            return Err(GuardianError::Sealed);
        }
        let marker = state.profiles.entry(profile.clone()).or_insert_with(|| {
            ProfileMarker::new(
                self.inner.boot_id,
                self.inner.desktop_generation,
                profile.clone(),
                self.inner.desktop_process,
                self.inner.guardian_process,
            )
        });
        marker.acquire(lease_id, capability)?;
        if let Err(error) = self.inner.marker_store.persist(marker) {
            marker.release(lease_id);
            return Err(error);
        }
        Ok(GuardianLease {
            inner: Arc::clone(&self.inner),
            profile,
            lease_id,
        })
    }

    /// Creates the runtime-owned guardian namespace used by ordinary Core terminal sessions.
    /// This identity is explicitly not a provider account and is never stored in AccountStore.
    pub fn terminal_guardian(
        &self,
        profile_generation: ProfileGeneration,
    ) -> Result<Arc<dyn kalcode_pty::PtyGuardian>, GuardianError> {
        let profile =
            ProfileIdentity::internal_terminal(self.inner.desktop_generation, profile_generation)?;
        let lease = self.acquire(profile, ProfileCapability::SharedSession)?;
        Ok(Arc::new(GuardianTerminalAuthority { lease }))
    }

    pub fn probe_guardian(
        &self,
        profile_generation: ProfileGeneration,
    ) -> Result<ProviderProbeGuardian, GuardianError> {
        Ok(ProviderProbeGuardian {
            authority: self.clone(),
            profile: ProfileIdentity::internal_probe(
                self.inner.desktop_generation,
                profile_generation,
            )?,
        })
    }

    pub fn seal(&self) -> Result<(), GuardianError> {
        let mut state = self.lock()?;
        state.sealed = true;
        if state.seal_complete {
            return Ok(());
        }
        let mut failure = None;
        for marker in state.profiles.values_mut() {
            marker.seal();
            if let Err(error) = self.inner.marker_store.persist(marker) {
                marker.block();
                failure = Some(error);
                break;
            }
        }
        if let Some(error) = failure {
            state.blocked_unclean = true;
            return Err(error);
        }
        if let Err(error) = self.inner.jobs.seal() {
            state.blocked_unclean = true;
            return Err(error);
        }
        state.seal_complete = true;
        Ok(())
    }

    pub fn drain(&self) -> Result<GenerationQuiescenceProof, GuardianError> {
        let mut state = self.lock()?;
        if !state.seal_complete {
            return Err(GuardianError::InvalidTransition);
        }
        let mut profiles = Vec::with_capacity(state.profiles.len());
        for (profile, marker) in &mut state.profiles {
            profiles.push(profile.clone());
            let jobs: Vec<_> = marker.jobs().map(|job| (job.id(), job.state())).collect();
            for (job, job_state) in jobs {
                if job_state == MarkerState::Clean {
                    continue;
                }
                if matches!(job_state, MarkerState::Prepared | MarkerState::Running) {
                    if let Err(error) = marker.begin_quiescence(profile.clone(), job) {
                        state.blocked_unclean = true;
                        return Err(error);
                    }
                    if let Err(error) = self.inner.marker_store.persist(marker) {
                        marker.block();
                        state.blocked_unclean = true;
                        return Err(error);
                    }
                } else if job_state != MarkerState::Quiescing {
                    state.blocked_unclean = true;
                    return Err(GuardianError::InvalidTransition);
                }
                if let Err(error) = self.inner.jobs.terminate(job) {
                    marker.block();
                    let _ = self.inner.marker_store.persist(marker);
                    state.blocked_unclean = true;
                    return Err(error);
                }
                match self.inner.jobs.active_processes(job) {
                    Ok(0) => {}
                    Ok(_) => {
                        state.blocked_unclean = true;
                        return Err(GuardianError::QuiescencePending);
                    }
                    Err(error) => {
                        marker.block();
                        let _ = self.inner.marker_store.persist(marker);
                        state.blocked_unclean = true;
                        return Err(error);
                    }
                }
                if let Err(error) = marker.prove_clean(profile.clone(), job) {
                    state.blocked_unclean = true;
                    return Err(error);
                }
            }
            if let Err(error) = self.inner.marker_store.persist(marker) {
                marker.block();
                state.blocked_unclean = true;
                return Err(error);
            }
        }
        if let Err(error) = self.inner.jobs.complete() {
            state.blocked_unclean = true;
            return Err(error);
        }
        state.blocked_unclean = false;
        Ok(GenerationQuiescenceProof {
            desktop_generation: self.inner.desktop_generation,
            profiles,
        })
    }

    pub fn is_blocked_unclean(&self) -> bool {
        self.lock()
            .map(|state| state.blocked_unclean)
            .unwrap_or(true)
    }

    fn lock(&self) -> Result<MutexGuard<'_, AuthorityState>, GuardianError> {
        self.inner.state.lock().map_err(|_| GuardianError::Poisoned)
    }
}

struct GuardianTerminalAuthority {
    lease: GuardianLease,
}

impl kalcode_pty::PtyGuardian for GuardianTerminalAuthority {
    fn prepare(
        &self,
        label: &str,
    ) -> Result<Box<dyn kalcode_pty::PreparedPtyAdmission>, kalcode_pty::PtyError> {
        let registered = self
            .lease
            .prepare_job(label.to_owned())
            .map_err(|error| kalcode_pty::PtyError::Spawn(error.to_string()))?;
        Ok(Box::new(registered))
    }
}

/// Fully-owned crash guardian for one fresh desktop generation.
///
/// Platform guardians retain independent cleanup authority for every admitted job. Callers must
/// retain this value for the entire runtime epoch and use its authority when constructing
/// `ManagedProfiles`.
pub struct GuardianRuntime {
    authority: GuardianAuthority,
    supervisor: Arc<GuardianSupervisor>,
    desktop_generation: DesktopGeneration,
    profile_generation: ProfileGeneration,
    marker_store: Arc<FileMarkerStore>,
    boot_identifier: String,
    // Last owner released after the runtime's supervisor handle. Authority clones retain another
    // reference, so a live profile/job can never outlive the desktop epoch fence.
    _desktop_recovery: Arc<platform::RecoveryLock>,
}

impl GuardianRuntime {
    pub fn launch(helper: &Path, data_dir: &Path) -> Result<Self, GuardianError> {
        if !data_dir.is_absolute() {
            return Err(GuardianError::Unavailable(
                "guardian data directory must be absolute".into(),
            ));
        }
        let desktop_generation = DesktopGeneration::from_uuid(Uuid::new_v4());
        let profile_generation = ProfileGeneration::from_uuid(Uuid::new_v4());
        let desktop_process = platform::current_process_identity()?;
        let boot_identifier = platform::current_boot_identifier()?;
        let marker_root = data_dir.join("provider-guardian-markers");
        let marker_store = Arc::new(FileMarkerStore::open(marker_root.clone())?);
        let desktop_recovery =
            Arc::new(marker_store.acquire_recovery_lock(platform::RecoveryLockRole::DesktopEpoch)?);
        marker_store.begin_epoch(desktop_generation, &boot_identifier)?;
        let supervisor = match GuardianSupervisor::launch(
            helper,
            desktop_generation,
            marker_store.recovery_root(),
            marker_store.root_identity(),
        ) {
            Ok(supervisor) => Arc::new(supervisor),
            Err(error) => {
                // No job can be prepared before a healthy supervisor is returned. A controlled
                // construction failure therefore has an exact empty-generation witness.
                marker_store.prove_epoch_clean(desktop_generation, &boot_identifier)?;
                return Err(error);
            }
        };
        let authority = GuardianAuthority::new(
            Uuid::new_v4(),
            desktop_generation,
            desktop_process,
            supervisor.process_identity(),
            Arc::clone(&marker_store),
            Arc::clone(&supervisor),
            Some(Arc::clone(&desktop_recovery)),
        );
        Ok(Self {
            authority,
            supervisor,
            desktop_generation,
            profile_generation,
            marker_store,
            boot_identifier,
            _desktop_recovery: desktop_recovery,
        })
    }

    pub fn authority(&self) -> GuardianAuthority {
        self.authority.clone()
    }

    pub fn supervisor(&self) -> Arc<GuardianSupervisor> {
        Arc::clone(&self.supervisor)
    }

    pub const fn desktop_generation(&self) -> DesktopGeneration {
        self.desktop_generation
    }

    pub const fn profile_generation(&self) -> ProfileGeneration {
        self.profile_generation
    }

    pub fn terminal_guardian(&self) -> Result<Arc<dyn kalcode_pty::PtyGuardian>, GuardianError> {
        self.authority.terminal_guardian(self.profile_generation)
    }

    pub fn probe_guardian(&self) -> Result<ProviderProbeGuardian, GuardianError> {
        self.authority.probe_guardian(self.profile_generation)
    }

    pub fn seal_and_drain(&self) -> Result<GenerationQuiescenceProof, GuardianError> {
        self.authority.seal()?;
        let proof = self.authority.drain()?;
        self.marker_store
            .prove_epoch_clean(self.desktop_generation, &self.boot_identifier)?;
        Ok(proof)
    }
}

/// Runtime-owned admission authority for provider installation and authentication probes.
/// It has no AccountStore row and cannot be selected as a provider account.
#[derive(Clone)]
pub struct ProviderProbeGuardian {
    authority: GuardianAuthority,
    profile: ProfileIdentity,
}

impl ProviderProbeGuardian {
    pub fn prepare_job(&self, label: &str) -> Result<RegisteredJob, GuardianError> {
        let lease = self
            .authority
            .acquire(self.profile.clone(), ProfileCapability::SharedSession)?;
        lease.prepare_job(label.to_owned())
    }
}

pub struct GuardianLease {
    inner: Arc<GuardianInner>,
    profile: ProfileIdentity,
    lease_id: Uuid,
}

impl GuardianLease {
    pub fn prepare_job(&self, name: String) -> Result<RegisteredJob, GuardianError> {
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| GuardianError::Poisoned)?;
        if state.sealed {
            return Err(GuardianError::Sealed);
        }
        if state.blocked_unclean {
            return Err(GuardianError::BlockedUnclean);
        }
        let marker = state
            .profiles
            .get_mut(&self.profile)
            .ok_or(GuardianError::LeaseExpired)?;
        let job = JobId::new();
        let job_name = self.inner.jobs.prepare(job, &name)?;
        marker.prepare_job(self.lease_id, self.profile.clone(), job, job_name.clone())?;
        self.inner.marker_store.persist(marker)?;
        Ok(RegisteredJob {
            inner: Arc::clone(&self.inner),
            profile: self.profile.clone(),
            job,
            job_name,
        })
    }
}

impl Drop for GuardianLease {
    fn drop(&mut self) {
        let Ok(mut state) = self.inner.state.lock() else {
            return;
        };
        let Some(marker) = state.profiles.get_mut(&self.profile) else {
            return;
        };
        marker.release(self.lease_id);
        if self.inner.marker_store.persist(marker).is_err() {
            marker.block();
            state.blocked_unclean = true;
        }
    }
}

pub struct RegisteredJob {
    inner: Arc<GuardianInner>,
    profile: ProfileIdentity,
    job: JobId,
    job_name: String,
}

impl RegisteredJob {
    pub const fn job_id(&self) -> JobId {
        self.job
    }

    pub fn job_name(&self) -> &str {
        &self.job_name
    }

    #[cfg(windows)]
    pub(crate) fn raw_job_handle(&self) -> Result<usize, GuardianError> {
        self.inner.jobs.raw_job_handle(self.job)
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn macos_command(
        &self,
        launch: custodian::MacLaunch,
    ) -> Result<std::process::Command, GuardianError> {
        self.inner.jobs.macos_command(self.job, launch)
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn spawn_macos(
        self,
        command: std::process::Command,
    ) -> Result<(std::process::Child, GuardedJob, u32), GuardianError> {
        let spawned = match self.inner.jobs.macos_spawn(self.job, command) {
            Ok(spawned) => spawned,
            Err(_) => {
                let _ = self.inner.jobs.terminate(self.job);
                let _ = self.inner.jobs.active_processes(self.job);
                mark_job_blocked(&self.inner, self.job);
                return Err(GuardianError::BlockedUnclean);
            }
        };
        let root_pid = spawned.root.pid();
        let mut child = spawned.child;
        let job = self.job;
        let inner = Arc::clone(&self.inner);
        let guarded = match self.commit_assigned_root(spawned.root) {
            Ok(guarded) => guarded,
            Err(_) => {
                let _ = inner.jobs.terminate(job);
                let _ = inner.jobs.active_processes(job);
                let _ = child.wait();
                mark_job_blocked(&inner, job);
                return Err(GuardianError::BlockedUnclean);
            }
        };
        if inner.jobs.macos_activate(job).is_err() {
            let _ = guarded.cancel_and_prove_quiescence();
            let _ = child.wait();
            mark_job_blocked(&inner, job);
            return Err(GuardianError::BlockedUnclean);
        }
        Ok((child, guarded, root_pid))
    }

    /// Commits a process that was atomically admitted by an external launcher such as ConPTY.
    /// The PID is accepted only when a newly opened handle is a member of this exact prepared job;
    /// PID reuse therefore cannot bind an unrelated process.
    pub fn commit_assigned_process(
        self,
        pid: u32,
        birth_time_100ns: u64,
    ) -> Result<GuardedJob, GuardianError> {
        let expected = ProcessIdentity::new(pid, birth_time_100ns)?;
        let root = self.inner.jobs.identify_process(self.job, expected)?;
        self.commit_assigned_root(root)
    }

    #[cfg(windows)]
    pub(crate) fn assign_suspended_process(
        self,
        process: BorrowedHandle<'_>,
        pid: u32,
    ) -> Result<GuardedJob, GuardianError> {
        let root = self
            .inner
            .jobs
            .assign_suspended_process(self.job, process, pid)?;
        self.commit_assigned_root(root)
    }

    fn commit_assigned_root(self, root: ProcessIdentity) -> Result<GuardedJob, GuardianError> {
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| GuardianError::Poisoned)?;
        if state.sealed {
            return Err(GuardianError::Sealed);
        }
        let marker = state
            .profiles
            .get_mut(&self.profile)
            .ok_or(GuardianError::UnknownJob)?;
        marker.commit_root(self.profile.clone(), self.job, root)?;
        self.inner.marker_store.persist(marker)?;
        drop(state);
        Ok(GuardedJob {
            inner: Arc::clone(&self.inner),
            profile: self.profile.clone(),
            job: self.job,
        })
    }
}

impl kalcode_pty::PreparedPtyAdmission for RegisteredJob {
    #[cfg(windows)]
    fn raw_job_handle(&self) -> Result<usize, kalcode_pty::PtyError> {
        RegisteredJob::raw_job_handle(self)
            .map_err(|error| kalcode_pty::PtyError::Spawn(error.to_string()))
    }

    #[cfg(windows)]
    fn commit(
        self: Box<Self>,
        identity: kalcode_pty::PtyProcessIdentity,
    ) -> Result<Box<dyn kalcode_pty::PtyAdmissionGuard>, kalcode_pty::PtyError> {
        let guarded = (*self)
            .commit_assigned_process(identity.pid, identity.birth_time_100ns)
            .map_err(|error| kalcode_pty::PtyError::Spawn(error.to_string()))?;
        Ok(Box::new(guarded))
    }

    #[cfg(target_os = "macos")]
    fn spawn_custodied(
        self: Box<Self>,
        launch: kalcode_pty::MacPtyLaunch,
        slave: std::fs::File,
    ) -> Result<kalcode_pty::MacCustodiedPty, kalcode_pty::PtyError> {
        use std::process::Stdio;

        let target = custodian::MacLaunch {
            program: launch.program,
            args: launch.args,
            cwd: Some(launch.cwd),
            env: launch.env,
            pty: true,
        };
        let mut command = self
            .macos_command(target)
            .map_err(|error| kalcode_pty::PtyError::Spawn(error.to_string()))?;
        let stdout = slave
            .try_clone()
            .map_err(|error| kalcode_pty::PtyError::Spawn(error.to_string()))?;
        let stderr = slave
            .try_clone()
            .map_err(|error| kalcode_pty::PtyError::Spawn(error.to_string()))?;
        command
            .stdin(Stdio::from(slave))
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr));
        let (child, guarded, root_pid) = (*self)
            .spawn_macos(command)
            .map_err(|error| kalcode_pty::PtyError::Spawn(error.to_string()))?;
        kalcode_pty::MacCustodiedPty::new(child, root_pid, Box::new(guarded))
    }
}

#[cfg(target_os = "macos")]
fn mark_job_blocked(inner: &Arc<GuardianInner>, job: JobId) {
    let Ok(mut state) = inner.state.lock() else {
        return;
    };
    for marker in state.profiles.values_mut() {
        if marker.job_state(job).is_ok() {
            marker.block();
            let _ = inner.marker_store.persist(marker);
            state.blocked_unclean = true;
            return;
        }
    }
    state.blocked_unclean = true;
}

impl kalcode_pty::PtyAdmissionGuard for GuardedJob {
    fn complete(&self) -> Result<(), kalcode_pty::PtyError> {
        self.cancel_and_prove_quiescence()
            .map_err(|error| kalcode_pty::PtyError::Io(error.to_string()))
    }
}

pub struct GuardedJob {
    inner: Arc<GuardianInner>,
    profile: ProfileIdentity,
    job: JobId,
}

impl GuardedJob {
    pub fn cancel_and_prove_quiescence(&self) -> Result<(), GuardianError> {
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| GuardianError::Poisoned)?;
        let marker = state
            .profiles
            .get_mut(&self.profile)
            .ok_or(GuardianError::UnknownJob)?;
        let result = (|| {
            match marker.job_state(self.job)? {
                MarkerState::Prepared | MarkerState::Running => {
                    marker.begin_quiescence(self.profile.clone(), self.job)?;
                    self.inner.marker_store.persist(marker)?;
                }
                MarkerState::Quiescing => {}
                MarkerState::Clean => {}
                MarkerState::Blocked => return Err(GuardianError::BlockedUnclean),
            }
            if marker.job_state(self.job)? != MarkerState::Clean {
                self.inner.jobs.terminate(self.job)?;
                if self.inner.jobs.active_processes(self.job)? != 0 {
                    return Err(GuardianError::QuiescencePending);
                }
                marker.prove_clean(self.profile.clone(), self.job)?;
                self.inner.marker_store.persist(marker)?;
            }
            // CLEAN is durable before either trusted owner releases its handle.
            self.inner.jobs.release(self.job)?;
            let mut retired = marker.clone();
            retired.retire_clean(self.job)?;
            self.inner.marker_store.persist(&retired)?;
            *marker = retired;
            Ok(())
        })();
        #[cfg(target_os = "macos")]
        if result.is_err() {
            marker.block();
            let _ = self.inner.marker_store.persist(marker);
            state.blocked_unclean = true;
        }
        result
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GenerationQuiescenceProof {
    desktop_generation: DesktopGeneration,
    profiles: Vec<ProfileIdentity>,
}

impl GenerationQuiescenceProof {
    pub const fn desktop_generation(&self) -> DesktopGeneration {
        self.desktop_generation
    }

    pub fn profiles(&self) -> &[ProfileIdentity] {
        &self.profiles
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    use kalcode_contracts::agent::ProviderId;

    use super::*;

    #[derive(Default)]
    struct RecordingStore {
        states: Mutex<Vec<MarkerState>>,
    }

    impl MarkerStore for RecordingStore {
        fn persist(&self, marker: &ProfileMarker) -> Result<(), GuardianError> {
            self.states.lock().expect("store lock").push(marker.state());
            Ok(())
        }
    }

    #[derive(Default)]
    struct FailRetirementOnceStore {
        armed: AtomicBool,
        failed: AtomicBool,
    }

    impl MarkerStore for FailRetirementOnceStore {
        fn persist(&self, marker: &ProfileMarker) -> Result<(), GuardianError> {
            if self.armed.load(Ordering::Acquire)
                && marker.state() == MarkerState::Clean
                && marker.jobs().next().is_none()
                && !self.failed.swap(true, Ordering::AcqRel)
            {
                return Err(GuardianError::Unavailable(
                    "injected clean-record retirement failure".into(),
                ));
            }
            Ok(())
        }
    }

    #[derive(Default)]
    struct FakeJobs {
        active: Mutex<BTreeMap<JobId, Result<u32, &'static str>>>,
        terminated: Mutex<Vec<JobId>>,
        fail_seal_once: AtomicBool,
    }

    impl FakeJobs {
        fn set_active(&self, job: JobId, active: Result<u32, &'static str>) {
            self.active.lock().expect("jobs lock").insert(job, active);
        }
    }

    impl JobControl for FakeJobs {
        fn prepare(&self, _job: JobId, label: &str) -> Result<String, GuardianError> {
            Ok(format!("Local\\KalCode.Test.{label}"))
        }

        fn seal(&self) -> Result<(), GuardianError> {
            if self.fail_seal_once.swap(false, Ordering::AcqRel) {
                return Err(GuardianError::Unavailable("injected seal failure".into()));
            }
            Ok(())
        }

        fn terminate(&self, job: JobId) -> Result<(), GuardianError> {
            self.terminated.lock().expect("terminate lock").push(job);
            Ok(())
        }

        fn active_processes(&self, job: JobId) -> Result<u32, GuardianError> {
            match self
                .active
                .lock()
                .expect("jobs lock")
                .get(&job)
                .copied()
                .unwrap_or(Ok(0))
            {
                Ok(active) => Ok(active),
                Err(message) => Err(GuardianError::Unavailable(message.into())),
            }
        }

        fn release(&self, job: JobId) -> Result<(), GuardianError> {
            self.active.lock().expect("jobs lock").remove(&job);
            Ok(())
        }

        #[cfg(target_os = "macos")]
        fn macos_command(
            &self,
            _job: JobId,
            _launch: custodian::MacLaunch,
        ) -> Result<std::process::Command, GuardianError> {
            Err(GuardianError::Unavailable(
                "fake jobs do not launch processes".into(),
            ))
        }

        #[cfg(target_os = "macos")]
        fn macos_spawn(
            &self,
            _job: JobId,
            _command: std::process::Command,
        ) -> Result<MacSpawned, GuardianError> {
            Err(GuardianError::Unavailable(
                "fake jobs do not launch processes".into(),
            ))
        }

        #[cfg(target_os = "macos")]
        fn macos_activate(&self, _job: JobId) -> Result<(), GuardianError> {
            Err(GuardianError::Unavailable(
                "fake jobs do not launch processes".into(),
            ))
        }

        #[cfg(windows)]
        fn raw_job_handle(&self, _job: JobId) -> Result<usize, GuardianError> {
            Err(GuardianError::Unavailable(
                "fake jobs do not expose kernel handles".into(),
            ))
        }

        #[cfg(windows)]
        fn assign_suspended_process(
            &self,
            _job: JobId,
            _process: BorrowedHandle<'_>,
            _pid: u32,
        ) -> Result<ProcessIdentity, GuardianError> {
            Err(GuardianError::Unavailable(
                "fake jobs do not launch processes".into(),
            ))
        }

        fn identify_process(
            &self,
            _job: JobId,
            _expected: ProcessIdentity,
        ) -> Result<ProcessIdentity, GuardianError> {
            Err(GuardianError::Unavailable(
                "fake jobs do not launch processes".into(),
            ))
        }

        fn complete(&self) -> Result<(), GuardianError> {
            Ok(())
        }
    }

    fn desktop_generation() -> DesktopGeneration {
        DesktopGeneration::from_uuid(
            Uuid::parse_str("0199aaaa-0000-7000-8000-000000000001").expect("desktop generation"),
        )
    }

    fn profile() -> ProfileIdentity {
        ProfileIdentity::new(
            ProviderId::new(ProviderId::CODEX),
            Uuid::parse_str("0199aaaa-0000-7000-8000-000000000003").expect("account"),
            ProfileGeneration::from_uuid(
                Uuid::parse_str("0199aaaa-0000-7000-8000-000000000002")
                    .expect("profile generation"),
            ),
        )
        .expect("profile")
    }

    fn process(pid: u32, birth_time_100ns: u64) -> ProcessIdentity {
        ProcessIdentity::new(pid, birth_time_100ns).expect("process identity")
    }

    fn authority(store: Arc<RecordingStore>, jobs: Arc<FakeJobs>) -> GuardianAuthority {
        GuardianAuthority::new(
            Uuid::parse_str("0199aaaa-0000-7000-8000-000000000005").expect("boot"),
            desktop_generation(),
            process(100, 101),
            process(200, 201),
            store,
            jobs,
            None,
        )
    }

    #[test]
    fn sealing_blocks_new_leases_and_prepared_admissions() {
        let guardian = authority(
            Arc::new(RecordingStore::default()),
            Arc::new(FakeJobs::default()),
        );
        let lease = guardian
            .acquire(profile(), ProfileCapability::SharedSession)
            .expect("lease");

        guardian.seal().expect("seal");
        assert!(matches!(
            guardian.acquire(profile(), ProfileCapability::SharedSession),
            Err(GuardianError::Sealed)
        ));
        assert!(matches!(
            lease.prepare_job("late-job".into()),
            Err(GuardianError::Sealed)
        ));
    }

    #[test]
    fn partially_failed_seal_must_retry_before_drain() {
        let store = Arc::new(RecordingStore::default());
        let jobs = Arc::new(FakeJobs::default());
        let guardian = authority(Arc::clone(&store), Arc::clone(&jobs));
        guardian
            .acquire(profile(), ProfileCapability::SharedSession)
            .expect("lease");
        jobs.fail_seal_once.store(true, Ordering::Release);

        assert!(guardian.seal().is_err());
        assert!(matches!(
            guardian.drain(),
            Err(GuardianError::InvalidTransition)
        ));
        guardian.seal().expect("seal retry");
        guardian.drain().expect("drain after complete seal");
    }

    #[test]
    fn generation_clean_proof_includes_prepared_jobs_and_is_persisted_last() {
        let store = Arc::new(RecordingStore::default());
        let jobs = Arc::new(FakeJobs::default());
        let guardian = authority(Arc::clone(&store), Arc::clone(&jobs));
        let lease = guardian
            .acquire(profile(), ProfileCapability::SharedSession)
            .expect("lease");
        let registered = lease.prepare_job("fixture-job".into()).expect("prepared");
        let job = registered.job_id();
        jobs.set_active(job, Ok(0));

        guardian.seal().expect("seal");
        let proof = guardian.drain().expect("drain");
        assert_eq!(proof.desktop_generation(), desktop_generation());
        assert_eq!(proof.profiles(), &[profile()]);
        assert_eq!(
            jobs.terminated.lock().expect("terminate lock").as_slice(),
            &[job],
            "a PREPARED job with no committed root still belongs to the generation"
        );
        assert_eq!(
            store.states.lock().expect("states lock").last(),
            Some(&MarkerState::Clean),
            "CLEAN must be durably persisted before the proof is returned"
        );
    }

    #[test]
    fn clean_job_retirement_is_retryable_after_release_ack() {
        let store = Arc::new(FailRetirementOnceStore::default());
        let jobs = Arc::new(FakeJobs::default());
        let guardian = GuardianAuthority::new(
            Uuid::new_v4(),
            desktop_generation(),
            process(100, 101),
            process(200, 201),
            Arc::clone(&store),
            Arc::clone(&jobs),
            None,
        );
        let lease = guardian
            .acquire(profile(), ProfileCapability::SharedSession)
            .expect("lease");
        let registered = lease.prepare_job("retirement-retry".into()).expect("job");
        let job_id = registered.job_id();
        jobs.set_active(job_id, Ok(0));
        let guarded = registered
            .commit_assigned_root(process(300, 301))
            .expect("running job");
        store.armed.store(true, Ordering::Release);

        assert!(guarded.cancel_and_prove_quiescence().is_err());
        guarded
            .cancel_and_prove_quiescence()
            .expect("retirement retry");
        let state = guardian.lock().expect("authority state");
        assert_eq!(
            state
                .profiles
                .get(&profile())
                .expect("profile marker")
                .jobs()
                .count(),
            0
        );
    }

    #[test]
    fn unproved_job_count_blocks_clean_and_retains_authority() {
        let store = Arc::new(RecordingStore::default());
        let jobs = Arc::new(FakeJobs::default());
        let guardian = authority(Arc::clone(&store), Arc::clone(&jobs));
        let lease = guardian
            .acquire(profile(), ProfileCapability::SharedSession)
            .expect("lease");
        let registered = lease.prepare_job("fixture-job".into()).expect("prepared");
        jobs.set_active(registered.job_id(), Err("job query failed"));

        guardian.seal().expect("seal");
        assert!(guardian.drain().is_err());
        assert_ne!(
            store.states.lock().expect("states lock").last(),
            Some(&MarkerState::Clean)
        );
        assert!(guardian.is_blocked_unclean());
    }

    #[test]
    fn pending_drain_is_retryable_and_only_zero_persists_clean() {
        let store = Arc::new(RecordingStore::default());
        let jobs = Arc::new(FakeJobs::default());
        let guardian = authority(Arc::clone(&store), Arc::clone(&jobs));
        let lease = guardian
            .acquire(profile(), ProfileCapability::SharedSession)
            .expect("lease");
        let registered = lease.prepare_job("retry-job".into()).expect("prepared");
        jobs.set_active(registered.job_id(), Ok(1));

        guardian.seal().expect("seal");
        assert!(matches!(
            guardian.drain(),
            Err(GuardianError::QuiescencePending)
        ));
        assert_ne!(
            store.states.lock().expect("states lock").last(),
            Some(&MarkerState::Clean)
        );

        jobs.set_active(registered.job_id(), Ok(0));
        guardian.drain().expect("retry reaches clean");
        assert!(!guardian.is_blocked_unclean());
        assert_eq!(
            store.states.lock().expect("states lock").last(),
            Some(&MarkerState::Clean)
        );
    }
}
