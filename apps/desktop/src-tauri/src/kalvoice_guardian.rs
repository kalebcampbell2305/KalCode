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
#[cfg(target_os = "macos")]
const MAX_FD_LIST_BYTES: usize = 1024 * 1024;
#[cfg(any(windows, target_os = "macos"))]
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

#[cfg(any(windows, target_os = "macos"))]
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
        #[cfg(windows)]
        let owners = windows_established_tuple_owners(server, client)?;
        // macOS has no system-wide owner table. The accepted socket enters the child's descriptor
        // table only after accept(), so an empty result before the deadline is retried like a
        // not-yet-visible Windows row; the LISTEN socket never matches the established tuple.
        #[cfg(target_os = "macos")]
        let owners = macos_established_tuple_owners(expected_pid, server, client)?;
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

/// Returns `[pid]` when the exact process `pid` holds an ESTABLISHED IPv4 TCP socket whose local
/// end is `server` and whose remote end is `client`, and `[]` when it holds none (yet).
///
/// Unlike Windows, which scans the system-wide owner table, this inspects only the expected
/// child's descriptor table. That is sufficient because TCP forbids two kernel sockets from
/// sharing one ESTABLISHED 4-tuple, so a match in the child is the one server end of our
/// connection; another process can hold a descriptor to that same socket only through the
/// child's cooperation (inheritance or descriptor passing), never by binding or accepting it.
/// Several matching descriptors (a dup in the child) are still the one socket and prove once.
#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
fn macos_established_tuple_owners(
    pid: u32,
    server: SocketAddrV4,
    client: SocketAddrV4,
) -> Result<Vec<u32>, GuardedWorkerError> {
    use std::ffi::{c_int, c_void};
    use std::mem::{offset_of, size_of};
    use std::ptr;

    // <sys/proc_info.h> layouts that libc does not export. Only the TCP arm of `soi_proto` is
    // read; the rest of that union (sized by `un_sockinfo`) stays opaque. The assertions below pin
    // the layout, but any change to these structs must still be validated on macOS hardware or CI.
    const PROC_PIDFDSOCKETINFO: c_int = 3;
    const SOCKINFO_TCP: i32 = 2;
    const TSI_S_ESTABLISHED: i32 = 4;
    const INI_IPV4: u8 = 0x1;
    const FD_LIST_HEADROOM: usize = 32;

    #[repr(C)]
    #[allow(dead_code)]
    struct ProcFileInfo {
        fi_openflags: u32,
        fi_status: u32,
        fi_offset: i64,
        fi_type: i32,
        fi_guardflags: u32,
    }
    #[repr(C)]
    #[allow(dead_code)]
    struct SockbufInfo {
        sbi_cc: u32,
        sbi_hiwat: u32,
        sbi_mbcnt: u32,
        sbi_mbmax: u32,
        sbi_lowat: u32,
        sbi_flags: i16,
        sbi_timeo: i16,
    }
    #[repr(C)]
    #[allow(dead_code)]
    struct In4In6Addr {
        i46a_pad32: [u32; 3],
        i46a_addr4: u32,
    }
    #[repr(C)]
    #[allow(dead_code)]
    struct InSockInfo {
        insi_fport: i32,
        insi_lport: i32,
        insi_gencnt: u64,
        insi_flags: u32,
        insi_flow: u32,
        insi_vflag: u8,
        insi_ip_ttl: u8,
        rfu_1: u32,
        insi_faddr: In4In6Addr,
        insi_laddr: In4In6Addr,
        insi_v4: u8,
        insi_v6: [u32; 3],
    }
    #[repr(C)]
    #[allow(dead_code)]
    struct TcpSockInfo {
        tcpsi_ini: InSockInfo,
        tcpsi_state: i32,
        tcpsi_timer: [i32; 4],
        tcpsi_mss: i32,
        tcpsi_flags: u32,
        rfu_1: u32,
        tcpsi_tp: u64,
    }
    #[repr(C)]
    #[allow(dead_code)]
    struct SocketInfo {
        soi_stat: libc::vinfo_stat,
        soi_so: u64,
        soi_pcb: u64,
        soi_type: i32,
        soi_protocol: i32,
        soi_family: i32,
        soi_options: i16,
        soi_linger: i16,
        soi_state: i16,
        soi_qlen: i16,
        soi_incqlen: i16,
        soi_qlimit: i16,
        soi_timeo: i16,
        soi_error: u16,
        soi_oobmark: u32,
        soi_rcv: SockbufInfo,
        soi_snd: SockbufInfo,
        soi_kind: i32,
        rfu_1: u32,
        soi_proto: TcpSockInfo,
        soi_proto_rest: [u8; 528 - size_of::<TcpSockInfo>()],
    }
    #[repr(C)]
    #[allow(dead_code)]
    struct SocketFdInfo {
        pfi: ProcFileInfo,
        psi: SocketInfo,
    }
    const _: () = {
        assert!(size_of::<InSockInfo>() == 80);
        assert!(offset_of!(InSockInfo, insi_faddr) == 32);
        assert!(offset_of!(InSockInfo, insi_laddr) == 48);
        assert!(size_of::<TcpSockInfo>() == 120);
        assert!(offset_of!(TcpSockInfo, tcpsi_state) == 80);
        assert!(offset_of!(SocketInfo, soi_kind) == 232);
        assert!(offset_of!(SocketInfo, soi_proto) == 240);
        assert!(size_of::<SocketInfo>() == 768);
        assert!(size_of::<SocketFdInfo>() == 792);
    };

    let raw_pid = c_int::try_from(pid).map_err(|_| GuardedWorkerError::TransportFailed)?;
    // SAFETY: a null buffer is the documented size query and nothing is written.
    let needed =
        unsafe { libc::proc_pidinfo(raw_pid, libc::PROC_PIDLISTFDS, 0, ptr::null_mut(), 0) };
    let needed = usize::try_from(needed).map_err(|_| GuardedWorkerError::TransportFailed)?;
    let entry = size_of::<libc::proc_fdinfo>();
    // Headroom covers descriptors opened after the size query; a completely filled buffer is
    // treated as possibly truncated rather than as a complete listing.
    let capacity = needed / entry + FD_LIST_HEADROOM;
    let bytes = capacity * entry;
    if needed == 0 || bytes > MAX_FD_LIST_BYTES {
        return Err(GuardedWorkerError::TransportFailed);
    }
    let mut fds = vec![
        libc::proc_fdinfo {
            proc_fd: 0,
            proc_fdtype: 0,
        };
        capacity
    ];
    // SAFETY: `fds` is writable for `bytes` bytes (bounded by MAX_FD_LIST_BYTES, so it fits a
    // c_int) and the kernel does not retain the pointer.
    let written = unsafe {
        libc::proc_pidinfo(
            raw_pid,
            libc::PROC_PIDLISTFDS,
            0,
            fds.as_mut_ptr().cast::<c_void>(),
            bytes as c_int,
        )
    };
    let written = usize::try_from(written).map_err(|_| GuardedWorkerError::TransportFailed)?;
    if written == 0 || written >= bytes || written % entry != 0 {
        return Err(GuardedWorkerError::TransportFailed);
    }
    let expected_server_addr = u32::from_ne_bytes(server.ip().octets());
    let expected_client_addr = u32::from_ne_bytes(client.ip().octets());
    let expected_server_port = i32::from(server.port().to_be());
    let expected_client_port = i32::from(client.port().to_be());
    let info_size = size_of::<SocketFdInfo>() as c_int;
    for fd in &fds[..written / entry] {
        if fd.proc_fdtype != libc::PROX_FDTYPE_SOCKET as u32 {
            continue;
        }
        // SAFETY: SocketFdInfo is plain integer data, for which all-zero bytes are valid.
        let mut info: SocketFdInfo = unsafe { std::mem::zeroed() };
        // SAFETY: `info` is writable for exactly `info_size` bytes and is not retained.
        let copied = unsafe {
            libc::proc_pidfdinfo(
                raw_pid,
                fd.proc_fd,
                PROC_PIDFDSOCKETINFO,
                (&mut info as *mut SocketFdInfo).cast::<c_void>(),
                info_size,
            )
        };
        // A descriptor closed after the listing is evidence of nothing; skip it.
        if copied != info_size {
            continue;
        }
        let tcp = &info.psi.soi_proto;
        let ini = &tcp.tcpsi_ini;
        if info.psi.soi_kind == SOCKINFO_TCP
            && tcp.tcpsi_state == TSI_S_ESTABLISHED
            && ini.insi_vflag & INI_IPV4 != 0
            && ini.insi_laddr.i46a_addr4 == expected_server_addr
            && ini.insi_lport == expected_server_port
            && ini.insi_faddr.i46a_addr4 == expected_client_addr
            && ini.insi_fport == expected_client_port
        {
            return Ok(vec![pid]);
        }
    }
    Ok(Vec::new())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn prove_established_server_owner(
    _stream: &TcpStream,
    _endpoint: SocketAddrV4,
    _expected_pid: u32,
    _deadline: Instant,
) -> Result<(), GuardedWorkerError> {
    // No owner-proof adapter exists for other platforms; they remain fail-closed.
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

#[cfg(all(test, target_os = "macos"))]
mod macos_tests {
    use std::io::{BufRead as _, BufReader, ErrorKind, Read as _};
    use std::net::{Ipv4Addr, TcpListener};
    use std::process::{Child, Command, Stdio};

    use super::*;

    const FIXTURE_ENV: &str = "KALCODE_LOOPBACK_OWNER_FIXTURE";
    const FIXTURE_TEST: &str = "kalvoice_guardian::macos_tests::loopback_owner_fixture_server";
    // Every wait in these tests is bounded so a failure can never leave a hung run or process.
    const FIXTURE_WAIT: Duration = Duration::from_secs(10);

    /// Kills and reaps a spawned process on every exit path, including a failed assertion.
    struct KillOnDrop(Child);

    impl Drop for KillOnDrop {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn loopback_listener() -> (TcpListener, SocketAddrV4) {
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).expect("bind");
        match listener.local_addr().expect("endpoint") {
            SocketAddr::V4(endpoint) => (listener, endpoint),
            SocketAddr::V6(_) => panic!("IPv4 fixture"),
        }
    }

    /// Accepts one connection and holds it until the peer closes, all within `limit`. With
    /// `duplicate`, a second descriptor to the accepted socket stays open alongside the first.
    fn serve_one(listener: &TcpListener, limit: Duration, duplicate: bool) {
        let deadline = Instant::now() + limit;
        listener
            .set_nonblocking(true)
            .expect("nonblocking listener");
        let mut accepted = loop {
            match listener.accept() {
                Ok((accepted, _)) => break accepted,
                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                    assert!(
                        Instant::now() < deadline,
                        "no connection before the deadline"
                    );
                    thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("accept: {error}"),
            }
        };
        accepted.set_nonblocking(false).expect("blocking stream");
        let _duplicate = duplicate.then(|| accepted.try_clone().expect("dup server socket"));
        accepted
            .set_read_timeout(Some(
                deadline
                    .saturating_duration_since(Instant::now())
                    .max(Duration::from_millis(1)),
            ))
            .expect("read timeout");
        let mut byte = [0_u8; 1];
        let _ = accepted.read(&mut byte);
    }

    fn accept_one(listener: TcpListener, duplicate: bool) -> JoinHandle<()> {
        thread::spawn(move || serve_one(&listener, FIXTURE_WAIT, duplicate))
    }

    fn deadline() -> Instant {
        Instant::now() + Duration::from_secs(2)
    }

    /// Re-executes this test binary as a separate process that owns a loopback server.
    fn spawn_fixture_server() -> (KillOnDrop, SocketAddrV4) {
        let mut child = KillOnDrop(
            Command::new(std::env::current_exe().expect("test binary"))
                .args([FIXTURE_TEST, "--exact", "--nocapture", "--test-threads=1"])
                .env(FIXTURE_ENV, "1")
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn fixture"),
        );
        let stdout = child.0.stdout.take().expect("fixture stdout");
        let (sender, receiver) = mpsc::sync_channel(1);
        // libtest prints "test <name> ... " before the body runs, so the marker can follow that
        // prefix on the same line. The reader drains to EOF, which the kill-on-drop guarantees.
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Some((_, rest)) = line.split_once("fixture-port=") {
                    let digits = rest
                        .chars()
                        .take_while(char::is_ascii_digit)
                        .collect::<String>();
                    let _ = sender.try_send(digits.parse::<u16>().ok());
                }
            }
        });
        let port = receiver
            .recv_timeout(FIXTURE_WAIT)
            .ok()
            .flatten()
            .expect("fixture port");
        (child, SocketAddrV4::new(Ipv4Addr::LOCALHOST, port))
    }

    /// Inert unless re-executed by `spawn_fixture_server`.
    #[test]
    fn loopback_owner_fixture_server() {
        if std::env::var_os(FIXTURE_ENV).is_none() {
            return;
        }
        let (listener, endpoint) = loopback_listener();
        println!("fixture-port={}", endpoint.port());
        serve_one(&listener, FIXTURE_WAIT * 2, false);
    }

    #[test]
    fn established_tuple_proof_finds_the_exact_server_owner() {
        let (listener, endpoint) = loopback_listener();
        let server = accept_one(listener, false);
        let stream = TcpStream::connect(endpoint).expect("connect");
        assert_eq!(
            prove_established_server_owner(&stream, endpoint, std::process::id(), deadline()),
            Ok(())
        );
        drop(stream);
        server.join().expect("server");
    }

    #[test]
    fn established_tuple_proof_accepts_a_duplicated_server_descriptor() {
        let (listener, endpoint) = loopback_listener();
        // Two descriptors in the owner refer to the one accepted socket; it still proves once.
        let server = accept_one(listener, true);
        let stream = TcpStream::connect(endpoint).expect("connect");
        assert_eq!(
            prove_established_server_owner(&stream, endpoint, std::process::id(), deadline()),
            Ok(())
        );
        drop(stream);
        server.join().expect("server");
    }

    #[test]
    fn established_tuple_proof_rejects_an_impostor_pid() {
        let (listener, endpoint) = loopback_listener();
        let server = accept_one(listener, false);
        // A live same-user process that does not hold the accepted socket.
        let impostor = KillOnDrop(
            Command::new("/bin/sleep")
                .arg("30")
                .spawn()
                .expect("impostor"),
        );
        let stream = TcpStream::connect(endpoint).expect("connect");
        assert_eq!(
            prove_established_server_owner(&stream, endpoint, impostor.0.id(), deadline()),
            Err(GuardedWorkerError::LoopbackOwnerMismatch)
        );
        drop(stream);
        server.join().expect("server");
    }

    #[test]
    fn established_tuple_proof_finds_a_spawned_child_server_and_rejects_the_client_process() {
        let (child, endpoint) = spawn_fixture_server();
        let stream = TcpStream::connect(endpoint).expect("connect");
        // The child holds the LISTEN socket and the accepted server end; this process holds only
        // the client end (local = client, remote = endpoint), which must never satisfy the proof.
        assert_eq!(
            prove_established_server_owner(&stream, endpoint, child.0.id(), deadline()),
            Ok(())
        );
        assert_eq!(
            prove_established_server_owner(&stream, endpoint, std::process::id(), deadline()),
            Err(GuardedWorkerError::LoopbackOwnerMismatch)
        );
    }

    #[test]
    fn established_tuple_proof_rejects_an_exited_owner() {
        let (listener, endpoint) = loopback_listener();
        let server = accept_one(listener, false);
        let mut exited = Command::new("/usr/bin/true").spawn().expect("spawn");
        let pid = exited.id();
        exited.wait().expect("reap");
        let stream = TcpStream::connect(endpoint).expect("connect");
        assert!(prove_established_server_owner(&stream, endpoint, pid, deadline()).is_err());
        drop(stream);
        server.join().expect("server");
    }
}
