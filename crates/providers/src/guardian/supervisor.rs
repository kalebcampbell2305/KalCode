//! Desktop-side owner of the out-of-process guardian and its named Job Objects.

#[cfg(windows)]
mod imp {
    use std::collections::BTreeMap;
    use std::io::{BufReader, BufWriter};
    use std::os::windows::io::{AsHandle, BorrowedHandle};
    use std::os::windows::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, MutexGuard};
    use std::time::{Duration, Instant};

    use uuid::Uuid;

    use super::super::marker::JobId;
    use super::super::platform::{WindowsJob, process_identity_from_handle};
    use super::super::protocol::{
        ChannelNonce, Envelope, Request, Response, read_frame, write_frame,
    };
    use super::super::{DesktopGeneration, GuardianError, JobControl, ProcessIdentity};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const EXIT_TIMEOUT: Duration = Duration::from_secs(10);

    fn isolate_guardian_environment(command: &mut Command) {
        // The guardian receives all authority through inherited stdio and explicit, non-secret
        // recovery arguments. It never needs the desktop's provider credentials, API keys,
        // updater/signing configuration, or diagnostic environment.
        command.env_clear();
    }

    /// One live authenticated helper channel. Access is serialized so request/response sequence
    /// numbers cannot be interleaved by concurrent launchers.
    struct Transport {
        child: Child,
        input: Option<BufWriter<ChildStdin>>,
        output: BufReader<ChildStdout>,
        next_sequence: u64,
        nonce: ChannelNonce,
        desktop_generation: DesktopGeneration,
    }

    impl Transport {
        fn launch(
            executable: &Path,
            desktop_generation: DesktopGeneration,
            recovery_root: &Path,
            recovery_root_identity: &str,
        ) -> Result<(Self, ProcessIdentity), GuardianError> {
            if !executable.is_absolute() || !executable.is_file() {
                return Err(GuardianError::Unavailable(
                    "guardian executable must be an absolute regular file".into(),
                ));
            }
            let executable = std::fs::canonicalize(executable)
                .map_err(|error| GuardianError::Unavailable(error.to_string()))?;
            let mut command = Command::new(executable);
            isolate_guardian_environment(&mut command);
            command
                .arg("--recovery-root")
                .arg(recovery_root)
                .arg("--recovery-root-id")
                .arg(recovery_root_identity)
                .creation_flags(CREATE_NO_WINDOW)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
            let mut child = command
                .spawn()
                .map_err(|error| GuardianError::Unavailable(error.to_string()))?;
            let identity = match process_identity_from_handle(child.as_handle(), child.id()) {
                Ok(identity) => identity,
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(error);
                }
            };
            let input = child.stdin.take().ok_or_else(|| {
                GuardianError::Unavailable("guardian stdin was not created".into())
            })?;
            let output = child.stdout.take().ok_or_else(|| {
                GuardianError::Unavailable("guardian stdout was not created".into())
            })?;
            let id = Uuid::new_v4();
            let nonce = ChannelNonce::from_bytes(*id.as_bytes());
            let mut transport = Self {
                child,
                input: Some(BufWriter::new(input)),
                output: BufReader::new(output),
                next_sequence: 1,
                nonce,
                desktop_generation,
            };
            match transport.request(Request::Health) {
                Ok(Response::Healthy) => Ok((transport, identity)),
                Ok(_) => {
                    transport.abort();
                    Err(GuardianError::Unavailable(
                        "guardian health handshake returned an unexpected response".into(),
                    ))
                }
                Err(error) => {
                    transport.abort();
                    Err(error)
                }
            }
        }

        fn request(&mut self, body: Request) -> Result<Response, GuardianError> {
            let sequence = self.next_sequence;
            let request_id = Uuid::new_v4();
            let request = Envelope::new(
                self.nonce,
                self.desktop_generation,
                sequence,
                request_id,
                body,
            );
            let input = self
                .input
                .as_mut()
                .ok_or_else(|| GuardianError::Unavailable("guardian channel is closed".into()))?;
            write_frame(input, &request)
                .map_err(|error| GuardianError::Unavailable(error.to_string()))?;
            let response: Envelope<Response> = read_frame(&mut self.output)
                .map_err(|error| GuardianError::Unavailable(error.to_string()))?;
            if response.nonce != self.nonce
                || response.desktop_generation != self.desktop_generation
                || response.sequence != sequence
                || response.request_id != request_id
                || response.protocol_version != super::super::protocol::PROTOCOL_VERSION
            {
                return Err(GuardianError::Unavailable(
                    "guardian response was not bound to its request".into(),
                ));
            }
            self.next_sequence = sequence
                .checked_add(1)
                .ok_or_else(|| GuardianError::Unavailable("guardian sequence exhausted".into()))?;
            Ok(response.body)
        }

        fn abort(&mut self) {
            self.input.take();
            let _ = self.child.kill();
            let _ = self.child.wait();
        }

        fn duplicate_job_handle(&self, job: &WindowsJob) -> Result<u64, GuardianError> {
            job.duplicate_for_helper(self.child.as_handle())
        }

        fn finish(&mut self) -> Result<(), GuardianError> {
            self.input.take();
            let deadline = Instant::now() + EXIT_TIMEOUT;
            loop {
                match self.child.try_wait() {
                    Ok(Some(status)) if status.success() => return Ok(()),
                    Ok(Some(status)) => {
                        return Err(GuardianError::Unavailable(format!(
                            "guardian exited without a clean proof: {status}"
                        )));
                    }
                    Ok(None) if Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Ok(None) => return Err(GuardianError::QuiescencePending),
                    Err(error) => return Err(GuardianError::Unavailable(error.to_string())),
                }
            }
        }

        fn has_exited(&mut self) -> Result<bool, GuardianError> {
            self.child
                .try_wait()
                .map(|status| status.is_some())
                .map_err(|error| GuardianError::Unavailable(error.to_string()))
        }
    }

    struct State {
        transport: Transport,
        jobs: BTreeMap<JobId, WindowsJob>,
        sealed: bool,
        seal_complete: bool,
    }

    /// Desktop-side supervisor for exactly one desktop generation.
    ///
    /// The helper receives a second handle to every named Job Object before any root process can
    /// resume. Loss of the desktop pipe therefore makes the helper terminate all admitted process
    /// trees even if the desktop dies between process creation and normal shutdown.
    pub struct GuardianSupervisor {
        executable: PathBuf,
        desktop_generation: DesktopGeneration,
        process_identity: ProcessIdentity,
        state: Mutex<State>,
        completed: AtomicBool,
    }

    impl GuardianSupervisor {
        pub fn launch(
            executable: &Path,
            desktop_generation: DesktopGeneration,
            recovery_root: &Path,
            recovery_root_identity: &str,
        ) -> Result<Self, GuardianError> {
            let executable = std::fs::canonicalize(executable)
                .map_err(|error| GuardianError::Unavailable(error.to_string()))?;
            let (transport, process_identity) = Transport::launch(
                &executable,
                desktop_generation,
                recovery_root,
                recovery_root_identity,
            )?;
            Ok(Self {
                executable,
                desktop_generation,
                process_identity,
                state: Mutex::new(State {
                    transport,
                    jobs: BTreeMap::new(),
                    sealed: false,
                    seal_complete: false,
                }),
                completed: AtomicBool::new(false),
            })
        }

        pub const fn process_identity(&self) -> ProcessIdentity {
            self.process_identity
        }

        pub fn is_completed(&self) -> bool {
            self.completed.load(Ordering::Acquire)
        }

        pub fn executable(&self) -> &Path {
            &self.executable
        }

        pub const fn desktop_generation(&self) -> DesktopGeneration {
            self.desktop_generation
        }

        /// Number of exact jobs still retained by the desktop authority. Healthy completed jobs
        /// retire to zero; a nonzero value is a truthful fail-closed cleanup backlog.
        pub fn retained_job_count(&self) -> Result<usize, GuardianError> {
            Ok(self.lock()?.jobs.len())
        }

        fn lock(&self) -> Result<MutexGuard<'_, State>, GuardianError> {
            self.state.lock().map_err(|_| GuardianError::Poisoned)
        }
    }

    impl JobControl for GuardianSupervisor {
        fn prepare(&self, job: JobId, label: &str) -> Result<String, GuardianError> {
            if label.is_empty() || label.len() > 128 || label.chars().any(char::is_control) {
                return Err(GuardianError::InvalidIdentity);
            }
            let mut state = self.lock()?;
            if state.sealed || self.completed.load(Ordering::Acquire) {
                return Err(GuardianError::Sealed);
            }
            let evidence_label = format!("guardian-job:{}:{label}", job.as_uuid());
            let owned = WindowsJob::create(&evidence_label)?;
            let helper_handle = state.transport.duplicate_job_handle(&owned)?;
            match state.transport.request(Request::HoldJob {
                job,
                handle: helper_handle,
            })? {
                Response::Accepted => {
                    state.jobs.insert(job, owned);
                    Ok(evidence_label)
                }
                Response::Denied { code } => Err(GuardianError::Unavailable(format!(
                    "guardian rejected job admission: {code}"
                ))),
                _ => Err(GuardianError::Unavailable(
                    "guardian returned an unexpected job-admission response".into(),
                )),
            }
        }

        fn seal(&self) -> Result<(), GuardianError> {
            let mut state = self.lock()?;
            state.sealed = true;
            if state.seal_complete {
                return Ok(());
            }
            match state.transport.request(Request::Seal)? {
                Response::Accepted => {
                    state.seal_complete = true;
                    Ok(())
                }
                Response::Denied { code } => Err(GuardianError::Unavailable(format!(
                    "guardian rejected generation seal: {code}"
                ))),
                _ => Err(GuardianError::Unavailable(
                    "guardian returned an unexpected seal response".into(),
                )),
            }
        }

        fn terminate(&self, job: JobId) -> Result<(), GuardianError> {
            self.lock()?
                .jobs
                .get(&job)
                .ok_or(GuardianError::UnknownJob)?
                .terminate()
        }

        fn active_processes(&self, job: JobId) -> Result<u32, GuardianError> {
            self.lock()?
                .jobs
                .get(&job)
                .ok_or(GuardianError::UnknownJob)?
                .active_processes()
        }

        fn release(&self, job: JobId) -> Result<(), GuardianError> {
            let mut state = self.lock()?;
            let Some(owned) = state.jobs.get(&job) else {
                // A previous helper acknowledgment may have been followed by a marker retirement
                // write failure. Local removal proves that exact acknowledgment already occurred.
                return Ok(());
            };
            if owned.active_processes()? != 0 {
                return Err(GuardianError::QuiescencePending);
            }
            let response = state.transport.request(Request::ReleaseJob { job });
            match response {
                Ok(Response::Accepted) => {
                    state.jobs.remove(&job);
                    Ok(())
                }
                Ok(Response::Denied { code }) => Err(GuardianError::Unavailable(format!(
                    "guardian rejected clean job release: {code}"
                ))),
                Ok(_) => Err(GuardianError::Unavailable(
                    "guardian returned an unexpected clean job-release response".into(),
                )),
                Err(error) => {
                    if state.transport.has_exited()? {
                        // Process exit is a kernel close of every handle the helper owned. The
                        // desktop already queried this exact local job handle at zero above.
                        state.jobs.remove(&job);
                        Ok(())
                    } else {
                        Err(error)
                    }
                }
            }
        }

        fn raw_job_handle(&self, job: JobId) -> Result<usize, GuardianError> {
            self.lock()?
                .jobs
                .get(&job)
                .map(WindowsJob::raw_handle_value)
                .ok_or(GuardianError::UnknownJob)
        }

        fn assign_suspended_process(
            &self,
            job: JobId,
            process: BorrowedHandle<'_>,
            pid: u32,
        ) -> Result<ProcessIdentity, GuardianError> {
            let state = self.lock()?;
            if state.sealed || self.completed.load(Ordering::Acquire) {
                return Err(GuardianError::Sealed);
            }
            state
                .jobs
                .get(&job)
                .ok_or(GuardianError::UnknownJob)?
                .assign_suspended_process(process, pid)
        }

        fn identify_process(
            &self,
            job: JobId,
            expected: ProcessIdentity,
        ) -> Result<ProcessIdentity, GuardianError> {
            self.lock()?
                .jobs
                .get(&job)
                .ok_or(GuardianError::UnknownJob)?
                .identify_member_process(expected)
        }

        fn complete(&self) -> Result<(), GuardianError> {
            if self.completed.load(Ordering::Acquire) {
                return Ok(());
            }
            let mut state = self.lock()?;
            state.sealed = true;
            match state.transport.request(Request::Shutdown)? {
                Response::Clean => {}
                Response::Denied { code } => {
                    return Err(GuardianError::Unavailable(format!(
                        "guardian could not prove generation quiescence: {code}"
                    )));
                }
                _ => {
                    return Err(GuardianError::Unavailable(
                        "guardian returned an unexpected shutdown response".into(),
                    ));
                }
            }
            state.transport.finish()?;
            state.jobs.clear();
            self.completed.store(true, Ordering::Release);
            Ok(())
        }
    }

    impl Drop for GuardianSupervisor {
        fn drop(&mut self) {
            if self.completed.load(Ordering::Acquire) {
                return;
            }
            if let Ok(state) = self.state.get_mut() {
                // Closing the authenticated pipe is the crash signal. Do not kill the helper:
                // it must retain its handles until it has terminated and counted every job.
                state.transport.input.take();
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn guardian_helper_does_not_inherit_parent_credentials() {
            const SENTINEL: &str = "KALCODE_GUARDIAN_TEST_CREDENTIAL";
            let system_root = std::env::var_os("SystemRoot").expect("SystemRoot");
            let executable = PathBuf::from(system_root).join("System32").join("cmd.exe");
            let mut command = Command::new(executable);
            command.env(SENTINEL, "synthetic-sentinel");
            isolate_guardian_environment(&mut command);
            command
                .args([
                    "/D",
                    "/S",
                    "/C",
                    "if defined KALCODE_GUARDIAN_TEST_CREDENTIAL (exit /b 23) else (exit /b 0)",
                ])
                .creation_flags(CREATE_NO_WINDOW)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());

            let status = command.status().expect("environment probe");
            assert!(
                status.success(),
                "the guardian helper inherited a parent credential-shaped variable"
            );
        }
    }
}

#[cfg(windows)]
pub use imp::GuardianSupervisor;

#[cfg(not(windows))]
use super::marker::JobId;
#[cfg(not(windows))]
use super::{DesktopGeneration, GuardianError, JobControl, ProcessIdentity};

#[cfg(not(windows))]
const UNSUPPORTED_GUARDIAN: &str = "the provider guardian requires Windows Job Objects";

#[cfg(not(windows))]
fn unsupported_guardian<T>() -> Result<T, GuardianError> {
    Err(GuardianError::Unavailable(UNSUPPORTED_GUARDIAN.into()))
}

/// Compile-time contract for platforms that do not yet have a native crash guardian.
///
/// Construction always fails. The private identity field ensures callers cannot fabricate an
/// instance and accidentally use this type as an unguarded process-control fallback.
#[cfg(not(windows))]
#[derive(Debug)]
pub struct GuardianSupervisor {
    process_identity: ProcessIdentity,
}

#[cfg(not(windows))]
impl GuardianSupervisor {
    pub fn launch(
        _executable: &std::path::Path,
        _desktop_generation: DesktopGeneration,
        _recovery_root: &std::path::Path,
        _recovery_root_identity: &str,
    ) -> Result<Self, GuardianError> {
        unsupported_guardian()
    }

    pub const fn process_identity(&self) -> ProcessIdentity {
        self.process_identity
    }
}

#[cfg(not(windows))]
impl JobControl for GuardianSupervisor {
    fn prepare(&self, _job: JobId, _label: &str) -> Result<String, GuardianError> {
        unsupported_guardian()
    }

    fn seal(&self) -> Result<(), GuardianError> {
        unsupported_guardian()
    }

    fn terminate(&self, _job: JobId) -> Result<(), GuardianError> {
        unsupported_guardian()
    }

    fn active_processes(&self, _job: JobId) -> Result<u32, GuardianError> {
        unsupported_guardian()
    }

    fn release(&self, _job: JobId) -> Result<(), GuardianError> {
        unsupported_guardian()
    }

    fn identify_process(
        &self,
        _job: JobId,
        _expected: ProcessIdentity,
    ) -> Result<ProcessIdentity, GuardianError> {
        unsupported_guardian()
    }

    fn complete(&self) -> Result<(), GuardianError> {
        unsupported_guardian()
    }
}

#[cfg(all(test, not(windows)))]
mod unsupported_tests {
    use super::*;

    fn assert_unavailable<T>(result: Result<T, GuardianError>) {
        assert!(matches!(
            result,
            Err(GuardianError::Unavailable(message)) if message == UNSUPPORTED_GUARDIAN
        ));
    }

    #[test]
    fn unsupported_supervisor_satisfies_job_control_but_every_operation_fails_closed() {
        fn assert_job_control<T: JobControl>() {}
        assert_job_control::<GuardianSupervisor>();

        let generation = DesktopGeneration::from_uuid(uuid::Uuid::from_u128(1));
        assert_unavailable(GuardianSupervisor::launch(
            std::path::Path::new("/synthetic/guardian"),
            generation,
            std::path::Path::new("/synthetic/recovery"),
            "synthetic-root",
        ));

        let identity = ProcessIdentity::new(1, 1).expect("synthetic process identity");
        let supervisor = GuardianSupervisor {
            process_identity: identity,
        };
        let job = JobId::from_uuid(uuid::Uuid::from_u128(2));
        assert_eq!(supervisor.process_identity(), identity);
        assert_unavailable(supervisor.prepare(job, "synthetic"));
        assert_unavailable(supervisor.seal());
        assert_unavailable(supervisor.terminate(job));
        assert_unavailable(supervisor.active_processes(job));
        assert_unavailable(supervisor.release(job));
        assert_unavailable(supervisor.identify_process(job, identity));
        assert_unavailable(supervisor.complete());
    }
}
