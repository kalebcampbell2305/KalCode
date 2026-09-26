//! Platform-neutral custody contract for the local KalVoice reasoning process.
//!
//! The desktop platform adapter is the authority that admits the process to the crash guardian
//! and proves the owner of each connected loopback transport. This crate deliberately cannot
//! fall back to spawning a process directly.

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::io::{Read, Write};
use std::net::SocketAddrV4;
use std::path::PathBuf;
use std::time::{Duration, Instant};

pub const LOCAL_REASONER_JOB_LABEL: &str = "kalvoice-local-reasoner";

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum GuardedWorkerError {
    #[error("the guarded worker specification is invalid")]
    InvalidSpecification,
    #[error("the crash guardian could not admit the worker")]
    AdmissionFailed,
    #[error("the guarded worker process failed")]
    ProcessFailed,
    #[error("the connected loopback peer is not the admitted worker")]
    LoopbackOwnerMismatch,
    #[error("the guarded loopback transport failed")]
    TransportFailed,
    #[error("the worker process tree is not proven quiescent")]
    CleanupUnproven,
    #[error("guarded local workers are unsupported on this platform")]
    Unsupported,
}

#[derive(Clone)]
pub struct GuardedWorkerSpec {
    pub executable: PathBuf,
    pub current_dir: PathBuf,
    pub args: Vec<OsString>,
    pub environment: BTreeMap<OsString, OsString>,
    pub endpoint: SocketAddrV4,
}

// Environment values include the per-process bearer. Never expose them through diagnostics.
impl fmt::Debug for GuardedWorkerSpec {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GuardedWorkerSpec")
            .field("executable", &self.executable)
            .field("current_dir", &self.current_dir)
            .field("args", &self.args)
            .field(
                "environment_keys",
                &self.environment.keys().collect::<Vec<_>>(),
            )
            .field("endpoint", &self.endpoint)
            .finish()
    }
}

impl GuardedWorkerSpec {
    pub fn validate(&self) -> Result<(), GuardedWorkerError> {
        if !self.executable.is_absolute()
            || !self.current_dir.is_absolute()
            || self.executable.parent() != Some(self.current_dir.as_path())
            || !self.endpoint.ip().is_loopback()
            || self.endpoint.port() == 0
            || self.args.is_empty()
        {
            return Err(GuardedWorkerError::InvalidSpecification);
        }
        let has_key = self
            .environment
            .get(OsStr::new("LLAMA_API_KEY"))
            .is_some_and(|value| !value.is_empty());
        let allowed_environment = self.environment.keys().all(|name| {
            name == OsStr::new("LLAMA_API_KEY") || cfg!(windows) && name == OsStr::new("SystemRoot")
        });
        if !has_key || !allowed_environment {
            return Err(GuardedWorkerError::InvalidSpecification);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuardedWorkerState {
    Running,
    Exited,
}

/// A still-open connection whose server-side established tuple was proven to belong to the exact
/// admitted process. The bearer may be written only through a value returned by
/// [`GuardedWorkerProcess::connect_verified`].
pub trait GuardedLoopbackConnection: Read + Write + Send {}

impl<T> GuardedLoopbackConnection for T where T: Read + Write + Send {}

/// Custody of one exact process tree.
///
/// Implementations must retain authoritative guardian custody independently of this returned
/// handle until `terminate_and_prove_quiescence` succeeds. Dropping a handle after an uncertain
/// cleanup must therefore leave the process registered in the launcher's retained-work registry.
pub trait GuardedWorkerProcess: Send {
    fn pid(&self) -> u32;

    /// Performs a bounded liveness query. If guardian finalization for an exited process cannot
    /// settle before `deadline`, custody remains retained and `CleanupUnproven` is returned.
    fn try_wait(&mut self, deadline: Instant) -> Result<GuardedWorkerState, GuardedWorkerError>;

    /// Connects without application data, proves that the reverse established tuple belongs to
    /// this exact unreaped process identity, and returns that same still-open connection. A
    /// listener observation followed by a separate connection does not satisfy this contract.
    fn connect_verified(
        &mut self,
        endpoint: SocketAddrV4,
        timeout: Duration,
    ) -> Result<Box<dyn GuardedLoopbackConnection>, GuardedWorkerError>;

    /// Terminates the admitted process tree and returns only after durable CLEAN/quiescence proof.
    /// On error, both the process identity and guardian custody must remain retained for retry.
    fn terminate_and_prove_quiescence(
        &mut self,
        deadline: Instant,
    ) -> Result<(), GuardedWorkerError>;
}

/// Platform authority for guarded local workloads.
pub trait GuardedWorkerLauncher: Send + Sync {
    /// Returns only after durable PREPARED state, nonexecuting child creation, exact child
    /// admission, durable RUNNING state, and activation. No unguarded spawn fallback is allowed.
    fn spawn_guarded(
        &self,
        spec: GuardedWorkerSpec,
    ) -> Result<Box<dyn GuardedWorkerProcess>, GuardedWorkerError>;
}

#[cfg(test)]
#[path = "guarded_worker_tests.rs"]
mod tests;
