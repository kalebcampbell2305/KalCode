//! Desktop adapter between KalVoice's neutral local-worker contract and the canonical provider
//! crash guardian. This is an internal local workload; it never creates or borrows a provider
//! account identity.

use std::collections::BTreeMap;
use std::net::{SocketAddr, SocketAddrV4, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex, TryLockError};
use std::thread;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use kalcode_kalvoice::guarded_worker::{
    GuardedLoopbackConnection, GuardedWorkerError, GuardedWorkerLauncher, GuardedWorkerProcess,
    GuardedWorkerSpec, GuardedWorkerState, LOCAL_REASONER_JOB_LABEL,
};
use kalcode_providers::guardian::ProviderProbeGuardian;
use kalcode_providers::process::{ProcessSpec, SupervisedChild};

#[cfg(windows)]
const MAX_TCP_TABLE_BYTES: u32 = 16 * 1024 * 1024;
#[cfg(windows)]
const OWNER_PROBE_INTERVAL: Duration = Duration::from_millis(5);

type RetainedMap = BTreeMap<u64, Arc<RetainedChild>>;

/// Cloneable manager-owned authority. The retained map deliberately outlives individual worker
/// handles; uncertain cleanup cannot discard guardian custody through `Drop`.
#[derive(Clone)]
pub struct KalVoiceGuardianLauncher {
    guardian: ProviderProbeGuardian,
    retained: Arc<Mutex<RetainedMap>>,
    next_id: Arc<AtomicU64>,
}

impl KalVoiceGuardianLauncher {
    pub fn new(guardian: ProviderProbeGuardian) -> Self {
        Self {
            guardian,
            retained: Arc::new(Mutex::new(BTreeMap::new())),
            next_id: Arc::new(AtomicU64::new(1)),
        }
    }

    pub fn retained_processes(&self) -> usize {
        self.retained.lock().map_or(usize::MAX, |items| items.len())
    }

    /// Retries cleanup of retained uncertain processes. The manager must keep this launcher alive
    /// and refuse guardian shutdown while this returns an error.
    pub fn retry_retained_cleanup(&self, deadline: Instant) -> Result<(), GuardedWorkerError> {
        let children = self
            .retained
            .lock()
            .map_err(|_| GuardedWorkerError::CleanupUnproven)?
            .iter()
            .map(|(id, child)| (*id, Arc::clone(child)))
            .collect::<Vec<_>>();
        for (id, child) in children {
            run_cleanup(&child, deadline)?;
            remove_retained(&self.retained, id)?;
        }
        Ok(())
    }
}

impl GuardedWorkerLauncher for KalVoiceGuardianLauncher {
    fn spawn_guarded(
        &self,
        spec: GuardedWorkerSpec,
    ) -> Result<Box<dyn GuardedWorkerProcess>, GuardedWorkerError> {
        spec.validate()?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        if id == 0 {
            return Err(GuardedWorkerError::AdmissionFailed);
        }
        // Hold the retention authority before preparing or spawning. Once a child exists, there is
        // always a manager-owned strong reference until a positive CLEAN proof removes it.
        let mut retained = self
            .retained
            .lock()
            .map_err(|_| GuardedWorkerError::AdmissionFailed)?;
        let admission = self
            .guardian
            .prepare_job(LOCAL_REASONER_JOB_LABEL)
            .map_err(|_| GuardedWorkerError::AdmissionFailed)?;
        let process_spec = ProcessSpec {
            program: spec.executable,
            args: spec.args,
            cwd: Some(spec.current_dir),
            env: spec.environment,
        };
        let (child, output) = SupervisedChild::spawn_guarded(&process_spec, admission)
            .map_err(|_| GuardedWorkerError::AdmissionFailed)?;
        // llama-server is launched with logging disabled. Retain no output channel or private model
        // response; the provider reader threads remain bounded if the executable violates policy.
        drop(output);
        let child = Arc::new(RetainedChild {
            child: Arc::new(child),
            operation: Mutex::new(None),
            clean: AtomicBool::new(false),
        });
        retained.insert(id, Arc::clone(&child));
        Ok(Box::new(DesktopGuardedWorker {
            id,
            expected_endpoint: spec.endpoint,
            child,
            retained: Arc::clone(&self.retained),
            clean: false,
        }))
    }
}

struct DesktopGuardedWorker {
    id: u64,
    expected_endpoint: SocketAddrV4,
    child: Arc<RetainedChild>,
    retained: Arc<Mutex<RetainedMap>>,
    clean: bool,
}

impl GuardedWorkerProcess for DesktopGuardedWorker {
    fn pid(&self) -> u32 {
        self.child.child.pid()
    }

    fn try_wait(&mut self, deadline: Instant) -> Result<GuardedWorkerState, GuardedWorkerError> {
        if run_status(&self.child, deadline)? == GuardedWorkerState::Exited {
            remove_retained(&self.retained, self.id)?;
            self.clean = true;
            Ok(GuardedWorkerState::Exited)
        } else {
            Ok(GuardedWorkerState::Running)
        }
    }

    fn connect_verified(
        &mut self,
        endpoint: SocketAddrV4,
        timeout: Duration,
    ) -> Result<Box<dyn GuardedLoopbackConnection>, GuardedWorkerError> {
        if endpoint != self.expected_endpoint || timeout.is_zero() {
            return Err(GuardedWorkerError::InvalidSpecification);
        }
        let deadline = Instant::now() + timeout;
        if self.try_wait(deadline)? != GuardedWorkerState::Running {
            return Err(GuardedWorkerError::ProcessFailed);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(GuardedWorkerError::TransportFailed);
        }
        let stream = TcpStream::connect_timeout(&SocketAddr::V4(endpoint), remaining)
            .map_err(|_| GuardedWorkerError::TransportFailed)?;
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(GuardedWorkerError::TransportFailed);
        }
        stream
            .set_read_timeout(Some(remaining))
            .and_then(|()| stream.set_write_timeout(Some(remaining)))
            .map_err(|_| GuardedWorkerError::TransportFailed)?;
        prove_established_server_owner(&stream, endpoint, self.child.child.pid(), deadline)?;
        // Recheck the retained process handle after kernel-table discovery. An exited original
        // process cannot be replaced by a PID-reuse winner between proof and bearer transmission.
        if self.try_wait(deadline)? != GuardedWorkerState::Running {
            return Err(GuardedWorkerError::ProcessFailed);
        }
        Ok(Box::new(stream))
    }

    fn terminate_and_prove_quiescence(
        &mut self,
        deadline: Instant,
    ) -> Result<(), GuardedWorkerError> {
        if self.clean {
            return Ok(());
        }
        run_cleanup(&self.child, deadline)?;
        remove_retained(&self.retained, self.id)?;
        self.clean = true;
        Ok(())
    }
}

impl Drop for DesktopGuardedWorker {
    fn drop(&mut self) {
        if !self.clean {
            let _ = self.terminate_and_prove_quiescence(Instant::now() + Duration::from_secs(5));
        }
    }
}

fn remove_retained(retained: &Mutex<RetainedMap>, id: u64) -> Result<(), GuardedWorkerError> {
    retained
        .lock()
        .map_err(|_| GuardedWorkerError::CleanupUnproven)?
        .remove(&id);
    Ok(())
}

struct RetainedChild {
    child: Arc<SupervisedChild>,
    operation: Mutex<Option<BackgroundOperation>>,
    clean: AtomicBool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum OperationKind {
    Status,
    Cleanup,
}

struct BackgroundOperation {
    kind: OperationKind,
    receiver: Receiver<Result<bool, ()>>,
    task: JoinHandle<()>,
}

fn run_status(
    retained: &Arc<RetainedChild>,
    deadline: Instant,
) -> Result<GuardedWorkerState, GuardedWorkerError> {
    if retained.clean.load(Ordering::Acquire) {
        return Ok(GuardedWorkerState::Exited);
    }
    let exited = run_background_operation(retained, OperationKind::Status, deadline)?;
    Ok(if exited {
        GuardedWorkerState::Exited
    } else {
        GuardedWorkerState::Running
    })
}

fn run_cleanup(retained: &Arc<RetainedChild>, deadline: Instant) -> Result<(), GuardedWorkerError> {
    if retained.clean.load(Ordering::Acquire) {
        return Ok(());
    }
    if run_background_operation(retained, OperationKind::Cleanup, deadline)? {
        Ok(())
    } else {
        Err(GuardedWorkerError::CleanupUnproven)
    }
}

fn run_background_operation(
    retained: &Arc<RetainedChild>,
    requested: OperationKind,
    deadline: Instant,
) -> Result<bool, GuardedWorkerError> {
    loop {
        if retained.clean.load(Ordering::Acquire) {
            return Ok(true);
        }
        let mut operation = match retained.operation.try_lock() {
            Ok(operation) => operation,
            Err(TryLockError::WouldBlock) | Err(TryLockError::Poisoned(_)) => {
                return Err(GuardedWorkerError::CleanupUnproven);
            }
        };
        if operation.is_none() {
            let (sender, receiver) = mpsc::sync_channel(1);
            let child = Arc::clone(&retained.child);
            let kind = requested;
            let task = thread::Builder::new()
                .name("kalvoice-guardian-operation".into())
                .spawn(move || {
                    let result = match kind {
                        OperationKind::Status => child
                            .try_status()
                            .map(|status| status.is_some())
                            .map_err(|_| ()),
                        // A zero graceful wait asks the canonical supervisor to terminate now.
                        // Only a reaped root plus guardian CLEAN proof is accepted as completion.
                        OperationKind::Cleanup => child
                            .terminate(Duration::ZERO)
                            .map(|status| status.is_some())
                            .map_err(|_| ()),
                    };
                    let _ = sender.send(result);
                })
                .map_err(|_| GuardedWorkerError::CleanupUnproven)?;
            *operation = Some(BackgroundOperation {
                kind,
                receiver,
                task,
            });
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(GuardedWorkerError::CleanupUnproven);
        }
        let active = operation
            .as_ref()
            .ok_or(GuardedWorkerError::CleanupUnproven)?;
        let result = match active.receiver.recv_timeout(remaining) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                return Err(GuardedWorkerError::CleanupUnproven);
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(()),
        };
        let completed = operation
            .take()
            .ok_or(GuardedWorkerError::CleanupUnproven)?;
        let _ = completed.task.join();
        if result == Ok(true) {
            retained.clean.store(true, Ordering::Release);
        }
        if completed.kind != requested {
            result.map_err(|_| GuardedWorkerError::CleanupUnproven)?;
            continue;
        }
        return result.map_err(|_| match requested {
            OperationKind::Status => GuardedWorkerError::ProcessFailed,
            OperationKind::Cleanup => GuardedWorkerError::CleanupUnproven,
        });
    }
}

#[cfg(windows)]
fn prove_established_server_owner(
    stream: &TcpStream,
    endpoint: SocketAddrV4,
    expected_pid: u32,
    deadline: Instant,
) -> Result<(), GuardedWorkerError> {
    let client = match stream
        .local_addr()
        .map_err(|_| GuardedWorkerError::TransportFailed)?
    {
        SocketAddr::V4(address) => address,
        SocketAddr::V6(_) => return Err(GuardedWorkerError::LoopbackOwnerMismatch),
    };
    let server = match stream
        .peer_addr()
        .map_err(|_| GuardedWorkerError::TransportFailed)?
    {
        SocketAddr::V4(address) => address,
        SocketAddr::V6(_) => return Err(GuardedWorkerError::LoopbackOwnerMismatch),
    };
    if server != endpoint || !client.ip().is_loopback() {
        return Err(GuardedWorkerError::LoopbackOwnerMismatch);
    }
    loop {
        let owners = windows_established_tuple_owners(server, client)?;
        match owners.as_slice() {
            [pid] if *pid == expected_pid => return Ok(()),
            [] if Instant::now() < deadline => thread::sleep(OWNER_PROBE_INTERVAL),
            _ => return Err(GuardedWorkerError::LoopbackOwnerMismatch),
        }
    }
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn windows_established_tuple_owners(
    server: SocketAddrV4,
    client: SocketAddrV4,
) -> Result<Vec<u32>, GuardedWorkerError> {
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::ptr;

    use windows_sys::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, NO_ERROR};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCP_STATE_ESTAB, MIB_TCPROW_OWNER_PID, TCP_TABLE_OWNER_PID_ALL,
    };
    use windows_sys::Win32::Networking::WinSock::AF_INET;

    let mut size = 0_u32;
    // SAFETY: a null first buffer is the documented size query; `size` is writable.
    let first = unsafe {
        GetExtendedTcpTable(
            ptr::null_mut(),
            &mut size,
            0,
            u32::from(AF_INET),
            TCP_TABLE_OWNER_PID_ALL,
            0,
        )
    };
    if first != ERROR_INSUFFICIENT_BUFFER
        || size < size_of::<u32>() as u32
        || size > MAX_TCP_TABLE_BYTES
    {
        return Err(GuardedWorkerError::TransportFailed);
    }
    let mut table = vec![0_u8; size as usize];
    // SAFETY: `table` is writable for `size` bytes and the API does not retain its pointer.
    let result = unsafe {
        GetExtendedTcpTable(
            table.as_mut_ptr().cast::<c_void>(),
            &mut size,
            0,
            u32::from(AF_INET),
            TCP_TABLE_OWNER_PID_ALL,
            0,
        )
    };
    if result != NO_ERROR || size as usize > table.len() || size < size_of::<u32>() as u32 {
        return Err(GuardedWorkerError::TransportFailed);
    }
    // SAFETY: the returned table begins with the documented DWORD count. `read_unaligned` avoids
    // assuming the byte vector's allocation has DWORD alignment.
    let count = unsafe { ptr::read_unaligned(table.as_ptr().cast::<u32>()) } as usize;
    let row_size = size_of::<MIB_TCPROW_OWNER_PID>();
    let bytes_needed = size_of::<u32>()
        .checked_add(
            count
                .checked_mul(row_size)
                .ok_or(GuardedWorkerError::TransportFailed)?,
        )
        .ok_or(GuardedWorkerError::TransportFailed)?;
    if bytes_needed > size as usize {
        return Err(GuardedWorkerError::TransportFailed);
    }
    let expected_server_addr = u32::from_ne_bytes(server.ip().octets());
    let expected_client_addr = u32::from_ne_bytes(client.ip().octets());
    let expected_server_port = u32::from(server.port().to_be());
    let expected_client_port = u32::from(client.port().to_be());
    let mut owners = Vec::new();
    for index in 0..count {
        let offset = size_of::<u32>() + index * row_size;
        // SAFETY: `bytes_needed` proved the full row lies inside the initialized returned table;
        // unaligned access is required because `Vec<u8>` has no row alignment guarantee.
        let row = unsafe {
            ptr::read_unaligned(table.as_ptr().add(offset).cast::<MIB_TCPROW_OWNER_PID>())
        };
        if row.dwState == MIB_TCP_STATE_ESTAB as u32
            && row.dwLocalAddr == expected_server_addr
            && row.dwLocalPort == expected_server_port
            && row.dwRemoteAddr == expected_client_addr
            && row.dwRemotePort == expected_client_port
        {
            owners.push(row.dwOwningPid);
        }
    }
    Ok(owners)
}

#[cfg(not(windows))]
fn prove_established_server_owner(
    _stream: &TcpStream,
    _endpoint: SocketAddrV4,
    _expected_pid: u32,
    _deadline: Instant,
) -> Result<(), GuardedWorkerError> {
    // macOS uses its separately owned proc_pidinfo adapter. Other platforms remain fail-closed.
    Err(GuardedWorkerError::Unsupported)
}

#[cfg(all(test, windows))]
mod tests {
    use std::io::Read as _;
    use std::net::{Ipv4Addr, TcpListener};

    use super::*;

    #[test]
    fn established_tuple_proof_finds_the_exact_server_owner() {
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).expect("bind");
        let endpoint = match listener.local_addr().expect("endpoint") {
            SocketAddr::V4(endpoint) => endpoint,
            SocketAddr::V6(_) => panic!("IPv4 fixture"),
        };
        let server = thread::spawn(move || {
            let (mut accepted, _) = listener.accept().expect("accept");
            let mut byte = [0_u8; 1];
            let _ = accepted.read(&mut byte);
        });
        let stream = TcpStream::connect(endpoint).expect("connect");
        assert_eq!(
            prove_established_server_owner(
                &stream,
                endpoint,
                std::process::id(),
                Instant::now() + Duration::from_secs(2),
            ),
            Ok(())
        );
        drop(stream);
        server.join().expect("server");
    }

    #[test]
    fn established_tuple_proof_rejects_an_impostor_pid() {
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).expect("bind");
        let endpoint = match listener.local_addr().expect("endpoint") {
            SocketAddr::V4(endpoint) => endpoint,
            SocketAddr::V6(_) => panic!("IPv4 fixture"),
        };
        let server = thread::spawn(move || {
            let (mut accepted, _) = listener.accept().expect("accept");
            let mut byte = [0_u8; 1];
            let _ = accepted.read(&mut byte);
        });
        let stream = TcpStream::connect(endpoint).expect("connect");
        let impossible_pid = std::process::id().wrapping_add(1).max(1);
        assert_eq!(
            prove_established_server_owner(
                &stream,
                endpoint,
                impossible_pid,
                Instant::now() + Duration::from_secs(2),
            ),
            Err(GuardedWorkerError::LoopbackOwnerMismatch)
        );
        drop(stream);
        server.join().expect("server");
    }
}
