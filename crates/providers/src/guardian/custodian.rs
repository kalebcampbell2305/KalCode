#![allow(unsafe_code)]

use std::ffi::{CString, OsStr, OsString};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::GuardianError;

const CONTROL_FD: RawFd = 3;
const FRAME_LIMIT: usize = 16 * 1024 * 1024;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const TERMINATE_GRACE: Duration = Duration::from_secs(3);
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug)]
pub(crate) struct MacLaunch {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub cwd: Option<PathBuf>,
    pub env: Vec<(OsString, OsString)>,
    pub pty: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct WireLaunch {
    program: Vec<u8>,
    args: Vec<Vec<u8>>,
    cwd: Option<Vec<u8>>,
    env: Vec<(Vec<u8>, Vec<u8>)>,
    pty: bool,
}

impl TryFrom<MacLaunch> for WireLaunch {
    type Error = GuardianError;

    fn try_from(value: MacLaunch) -> Result<Self, Self::Error> {
        validate_component(value.program.as_os_str(), false)?;
        if !value.program.is_absolute() || !value.cwd.as_ref().is_none_or(|cwd| cwd.is_absolute()) {
            return Err(GuardianError::InvalidIdentity);
        }
        let args = value
            .args
            .into_iter()
            .map(|arg| {
                validate_component(&arg, true)?;
                Ok(arg.into_vec())
            })
            .collect::<Result<Vec<_>, GuardianError>>()?;
        let mut env = Vec::with_capacity(value.env.len());
        for (key, item) in value.env {
            validate_environment_key(&key)?;
            validate_component(&item, true)?;
            env.push((key.into_vec(), item.into_vec()));
        }
        Ok(Self {
            program: value.program.into_os_string().into_vec(),
            args,
            cwd: value.cwd.map(|cwd| cwd.into_os_string().into_vec()),
            env,
            pty: value.pty,
        })
    }
}

fn validate_component(value: &OsStr, allow_empty: bool) -> Result<(), GuardianError> {
    let bytes = value.as_bytes();
    if (!allow_empty && bytes.is_empty()) || bytes.contains(&0) {
        return Err(GuardianError::InvalidIdentity);
    }
    Ok(())
}

fn validate_environment_key(value: &OsStr) -> Result<(), GuardianError> {
    validate_component(value, false)?;
    if value.as_bytes().contains(&b'=') {
        return Err(GuardianError::InvalidIdentity);
    }
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
enum DesktopFrame {
    Launch { job: Uuid, target: WireLaunch },
    Activate { job: Uuid },
    Terminate { job: Uuid },
}

#[derive(Debug, Serialize, Deserialize)]
pub(crate) enum CustodianFrame {
    Ready {
        job: Uuid,
        custodian_pid: u32,
        anchor_pid: u32,
        root_pid: u32,
    },
    Clean {
        job: Uuid,
        root_wait_status: i32,
    },
    Blocked {
        job: Uuid,
    },
}

pub(crate) fn command(executable: &Path, control: UnixStream) -> Command {
    // SAFETY: sysconf is a read-only process query. Clamp pathological values so the async-safe
    // child close loop is bounded.
    let max_fd = unsafe { libc::sysconf(libc::_SC_OPEN_MAX) }.clamp(4, 65_536) as RawFd;
    let mut command = Command::new(executable);
    command
        .args(["--custodian", "--control-fd", "3"])
        .env_clear();
    // SAFETY: the closure calls only async-signal-safe descriptor functions. `control` is retained
    // by the closure until spawn and its CLOEXEC source is duplicated to the fixed protocol FD.
    unsafe {
        command.pre_exec(move || {
            let source = control.as_raw_fd();
            if source == CONTROL_FD {
                let flags = libc::fcntl(source, libc::F_GETFD);
                if flags < 0 || libc::fcntl(source, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 {
                    return Err(io::Error::last_os_error());
                }
            } else if libc::dup2(source, CONTROL_FD) < 0 {
                return Err(io::Error::last_os_error());
            }
            for fd in 4..max_fd {
                libc::close(fd);
            }
            Ok(())
        });
    }
    command
}

pub(crate) fn send_launch(
    stream: &mut UnixStream,
    job: Uuid,
    launch: MacLaunch,
) -> Result<(), GuardianError> {
    stream
        .set_write_timeout(Some(HANDSHAKE_TIMEOUT))
        .map_err(unavailable)?;
    write_frame(
        stream,
        &DesktopFrame::Launch {
            job,
            target: launch.try_into()?,
        },
    )
    .map_err(unavailable)
}

pub(crate) fn receive_ready(stream: &mut UnixStream) -> Result<CustodianFrame, GuardianError> {
    stream
        .set_read_timeout(Some(HANDSHAKE_TIMEOUT))
        .map_err(unavailable)?;
    read_frame(stream).map_err(unavailable)
}

pub(crate) fn activate(stream: &mut UnixStream, job: Uuid) -> Result<(), GuardianError> {
    write_frame(stream, &DesktopFrame::Activate { job }).map_err(unavailable)
}

pub(crate) fn terminate(stream: &mut UnixStream, job: Uuid) -> Result<(), GuardianError> {
    // Termination is a best-effort wakeup, not the cleanup proof. A naturally exited target can
    // make the custodian publish CLEAN and close its socket before the desktop starts quiescence;
    // Darwin may report EINVAL as well as the usual disconnected-socket errors for this late
    // write. Always continue to `receive_clean`, whose authenticated CLEAN/BLOCKED response is the
    // only authority that can release the durable job marker. A live custodian that did not
    // receive this hint therefore times out and fails closed instead of being mistaken for clean.
    let _ = write_frame(stream, &DesktopFrame::Terminate { job });
    Ok(())
}

pub(crate) fn receive_clean(stream: &mut UnixStream) -> Result<CustodianFrame, GuardianError> {
    receive_clean_with_timeout(stream, CLEANUP_TIMEOUT)
}

fn receive_clean_with_timeout(
    stream: &mut UnixStream,
    timeout: Duration,
) -> Result<CustodianFrame, GuardianError> {
    match read_frame_bounded(stream, timeout) {
        Ok(frame) => Ok(frame),
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::InvalidData
                    | io::ErrorKind::UnexpectedEof
                    | io::ErrorKind::TimedOut
                    | io::ErrorKind::WouldBlock
            ) =>
        {
            Err(GuardianError::BlockedUnclean)
        }
        Err(error) => Err(unavailable_at("receive custodian CLEAN proof", error)),
    }
}

pub fn run(control_fd: RawFd) -> Result<i32, GuardianError> {
    if control_fd != CONTROL_FD {
        return Err(GuardianError::InvalidIdentity);
    }
    // SAFETY: the binary accepts exactly one inherited descriptor at this fixed number and takes
    // ownership exactly once before doing any other work.
    let mut control = unsafe { UnixStream::from_raw_fd(control_fd) };
    let launch: DesktopFrame = read_frame(&mut control).map_err(unavailable)?;
    let DesktopFrame::Launch { job, target } = launch else {
        return Err(GuardianError::InvalidTransition);
    };
    validate_wire_launch(&target)?;

    let pipes = Pipes::new()?;
    // SAFETY: the helper is single-threaded. The forked anchor executes only the bounded anchor
    // routine and never returns into Rust application code.
    let anchor_pid = unsafe { libc::fork() };
    if anchor_pid < 0 {
        return Err(unavailable(io::Error::last_os_error()));
    }
    if anchor_pid == 0 {
        let code = anchor_main(target, pipes);
        // SAFETY: the fork child must not run Rust destructors shared with its parent.
        unsafe { libc::_exit(code) }
    }

    let mut pipes = pipes.into_custodian();
    let root_pid = match read_i32(&mut pipes.ready_read) {
        Ok(root_pid) => root_pid,
        Err(_) => {
            let _ = abort_anchor_and_prove(anchor_pid, pipes);
            return Err(GuardianError::BlockedUnclean);
        }
    };
    if root_pid <= 0 {
        let _ = abort_anchor_and_prove(anchor_pid, pipes);
        return Err(GuardianError::BlockedUnclean);
    }
    // SAFETY: getpid has no memory preconditions.
    let custodian_pid = unsafe { libc::getpid() };
    if write_frame(
        &mut control,
        &CustodianFrame::Ready {
            job,
            custodian_pid: custodian_pid as u32,
            anchor_pid: anchor_pid as u32,
            root_pid: root_pid as u32,
        },
    )
    .is_err()
    {
        let _ = abort_anchor_and_prove(anchor_pid, pipes);
        return Err(GuardianError::BlockedUnclean);
    }

    let activation = match read_frame::<DesktopFrame>(&mut control) {
        Ok(activation) => activation,
        Err(_) => {
            let _ = abort_anchor_and_prove(anchor_pid, pipes);
            return Err(GuardianError::BlockedUnclean);
        }
    };
    match activation {
        DesktopFrame::Activate { job: frame_job } if frame_job == job => {
            if write_byte(&mut pipes.activation_write, b'A').is_err() {
                let _ = abort_anchor_and_prove(anchor_pid, pipes);
                return Err(GuardianError::BlockedUnclean);
            }
        }
        DesktopFrame::Terminate { job: frame_job } if frame_job == job => {
            if write_byte(&mut pipes.anchor_command_write, b'T').is_err() {
                let _ = abort_anchor_and_prove(anchor_pid, pipes);
                return Err(GuardianError::BlockedUnclean);
            }
        }
        _ => {
            let _ = abort_anchor_and_prove(anchor_pid, pipes);
            let _ = write_frame(&mut control, &CustodianFrame::Blocked { job });
            return Err(GuardianError::BlockedUnclean);
        }
    }

    let mut termination_requested = false;
    let mut cleanup_deadline = None;
    let anchor_status = loop {
        let mut status = 0;
        // SAFETY: `anchor_pid` is our exact unreaped direct child.
        let waited = unsafe { libc::waitpid(anchor_pid, &mut status, libc::WNOHANG) };
        if waited == anchor_pid {
            break status;
        }
        if waited < 0 {
            if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }
            let _ = abort_anchor_and_prove(anchor_pid, pipes);
            let _ = write_frame(&mut control, &CustodianFrame::Blocked { job });
            return Err(GuardianError::BlockedUnclean);
        }
        if cleanup_deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            let _ = abort_anchor_and_prove(anchor_pid, pipes);
            let _ = write_frame(&mut control, &CustodianFrame::Blocked { job });
            return Err(GuardianError::BlockedUnclean);
        }

        let mut poll_fd = libc::pollfd {
            fd: control.as_raw_fd(),
            events: libc::POLLIN | libc::POLLHUP | libc::POLLERR,
            revents: 0,
        };
        // SAFETY: `poll_fd` is valid writable storage for one descriptor.
        let polled = unsafe { libc::poll(&mut poll_fd, 1, 25) };
        if polled > 0 && poll_fd.revents != 0 && !termination_requested {
            let _request = read_frame::<DesktopFrame>(&mut control);
            termination_requested = true;
            cleanup_deadline = Some(Instant::now() + CLEANUP_TIMEOUT);
            let _ = write_byte(&mut pipes.anchor_command_write, b'T');
        }
    };

    let report = read_anchor_report(&mut pipes.status_read).ok();
    let anchor_drained = wait_anchor_drained(anchor_status);
    // Prove the reserved group absent even when the evidence pipe failed. Report delivery cannot
    // become a precondition for cleanup or for the custodian's kernel-backed absence check.
    let group_absent = wait_group_absent(anchor_pid, Duration::from_secs(2));
    let Some(report) = report else {
        let _ = write_frame(&mut control, &CustodianFrame::Blocked { job });
        return Err(GuardianError::BlockedUnclean);
    };
    if !report.root_reaped || !anchor_drained || !group_absent {
        let _ = write_frame(&mut control, &CustodianFrame::Blocked { job });
        return Err(GuardianError::BlockedUnclean);
    }
    write_frame(
        &mut control,
        &CustodianFrame::Clean {
            job,
            root_wait_status: report.root_wait_status,
        },
    )
    .map_err(unavailable)?;
    Ok(exit_code(report.root_wait_status))
}

fn validate_wire_launch(target: &WireLaunch) -> Result<(), GuardianError> {
    if target.program.is_empty()
        || target.program.contains(&0)
        || !Path::new(OsStr::from_bytes(&target.program)).is_absolute()
        || target
            .cwd
            .as_ref()
            .is_some_and(|cwd| cwd.contains(&0) || !Path::new(OsStr::from_bytes(cwd)).is_absolute())
        || target.args.iter().any(|arg| arg.contains(&0))
        || target.env.iter().any(|(key, value)| {
            key.is_empty() || key.contains(&0) || key.contains(&b'=') || value.contains(&0)
        })
    {
        return Err(GuardianError::InvalidIdentity);
    }
    Ok(())
}

struct Pipes {
    ready_read: OwnedFd,
    ready_write: OwnedFd,
    activation_read: OwnedFd,
    activation_write: OwnedFd,
    anchor_command_read: OwnedFd,
    anchor_command_write: OwnedFd,
    status_read: OwnedFd,
    status_write: OwnedFd,
}

struct CustodianPipes {
    ready_read: OwnedFd,
    activation_write: OwnedFd,
    anchor_command_write: OwnedFd,
    status_read: OwnedFd,
}

impl Pipes {
    fn new() -> Result<Self, GuardianError> {
        let (ready_read, ready_write) = pipe_cloexec()?;
        let (activation_read, activation_write) = pipe_cloexec()?;
        let (anchor_command_read, anchor_command_write) = pipe_cloexec()?;
        let (status_read, status_write) = pipe_cloexec()?;
        Ok(Self {
            ready_read,
            ready_write,
            activation_read,
            activation_write,
            anchor_command_read,
            anchor_command_write,
            status_read,
            status_write,
        })
    }

    fn into_custodian(self) -> CustodianPipes {
        drop(self.ready_write);
        drop(self.activation_read);
        drop(self.anchor_command_read);
        drop(self.status_write);
        CustodianPipes {
            ready_read: self.ready_read,
            activation_write: self.activation_write,
            anchor_command_write: self.anchor_command_write,
            status_read: self.status_read,
        }
    }
}

fn pipe_cloexec() -> Result<(OwnedFd, OwnedFd), GuardianError> {
    let mut fds = [-1; 2];
    // SAFETY: `fds` is writable storage for exactly two descriptors.
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Err(unavailable(io::Error::last_os_error()));
    }
    for fd in fds {
        // SAFETY: both descriptors were returned by pipe and remain open.
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
            // SAFETY: best-effort cleanup of the two freshly created descriptors.
            unsafe {
                libc::close(fds[0]);
                libc::close(fds[1]);
            }
            return Err(unavailable(io::Error::last_os_error()));
        }
    }
    // SAFETY: ownership of the two distinct fresh descriptors transfers exactly once.
    Ok(unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) })
}

fn anchor_main(target: WireLaunch, pipes: Pipes) -> i32 {
    // SAFETY: only the custodian owns the desktop control endpoint. Neither the anchor nor any
    // provider target may retain this authority-bearing descriptor.
    unsafe { libc::close(CONTROL_FD) };
    // SAFETY: the anchor is a fresh fork child and is not a process-group leader yet.
    if unsafe { libc::setsid() } < 0 {
        return 120;
    }
    // SAFETY: getpid has no memory preconditions.
    let anchor_pid = unsafe { libc::getpid() };
    if target.pty {
        // SAFETY: stdin is the explicitly supplied PTY slave. The anchor owns a fresh session.
        if unsafe { libc::ioctl(0, libc::TIOCSCTTY as _, 0) } < 0
            || unsafe { libc::tcsetpgrp(0, anchor_pid) } < 0
        {
            return 121;
        }
    }
    // SAFETY: ignoring termination in the trusted anchor preserves the PGID until the provider
    // root is exactly reaped. The target resets dispositions before exec.
    unsafe {
        libc::signal(libc::SIGHUP, libc::SIG_IGN);
        libc::signal(libc::SIGINT, libc::SIG_IGN);
        libc::signal(libc::SIGQUIT, libc::SIG_IGN);
        libc::signal(libc::SIGTERM, libc::SIG_IGN);
        // A lost custodian/status reader must never terminate the anchor before it has killed the
        // still-reserved provider group. The provider root restores the default disposition.
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }

    let prepared = match PreparedExec::new(target) {
        Ok(prepared) => prepared,
        Err(_) => return 122,
    };
    // SAFETY: the anchor remains single-threaded. The root runs only async-signal-safe setup before
    // execve and exits immediately on failure.
    let root_pid = unsafe { libc::fork() };
    if root_pid < 0 {
        return 123;
    }
    if root_pid == 0 {
        root_exec(prepared, pipes);
    }

    drop(pipes.ready_read);
    drop(pipes.activation_write);
    drop(pipes.anchor_command_write);
    drop(pipes.status_read);
    drop(pipes.activation_read);
    if write_i32(&pipes.ready_write, root_pid).is_err() {
        let status = drain_root(anchor_pid, root_pid, &pipes.anchor_command_read, true);
        return finish_anchor_group(anchor_pid, &pipes.status_write, status, 124);
    }
    drop(pipes.ready_write);

    let mut terminate = false;
    let status = loop {
        let mut status = 0;
        // SAFETY: root_pid is the anchor's exact direct child.
        let waited = unsafe { libc::waitpid(root_pid, &mut status, libc::WNOHANG) };
        if waited == root_pid {
            break Some(status);
        }
        if waited < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            break drain_root(anchor_pid, root_pid, &pipes.anchor_command_read, true);
        }
        // SAFETY: getppid has no memory preconditions. Reparenting proves custodian loss.
        if unsafe { libc::getppid() } <= 1 {
            terminate = true;
        }
        let mut poll_fd = libc::pollfd {
            fd: pipes.anchor_command_read.as_raw_fd(),
            events: libc::POLLIN | libc::POLLHUP | libc::POLLERR,
            revents: 0,
        };
        // SAFETY: `poll_fd` is valid storage for one live descriptor.
        if unsafe { libc::poll(&mut poll_fd, 1, 25) } > 0 && poll_fd.revents != 0 {
            terminate = true;
        }
        if terminate {
            break drain_root(anchor_pid, root_pid, &pipes.anchor_command_read, false);
        }
    };

    finish_anchor_group(anchor_pid, &pipes.status_write, status, 125)
}

fn finish_anchor_group(
    anchor_pid: libc::pid_t,
    status_write: &OwnedFd,
    root_status: Option<i32>,
    failure_code: i32,
) -> i32 {
    let report = AnchorReport {
        root_wait_status: root_status.unwrap_or_default(),
        root_reaped: root_status.is_some(),
    };
    // Report delivery is evidence only. A dead/disconnected reader must not suppress cleanup.
    let report_written = write_anchor_report(status_write, report).is_ok();
    // SAFETY: root_pid has been exactly reaped and anchor_pid is the still-live nonzero process
    // group reservation. Killing the group now terminates the anchor and every remaining member;
    // the custodian retains exact wait authority for the anchor and then proves ESRCH.
    if unsafe { libc::kill(-anchor_pid, libc::SIGKILL) } != 0 {
        return 126;
    }
    if report_written && root_status.is_some() {
        127
    } else {
        failure_code
    }
}

fn drain_root(
    anchor_pid: libc::pid_t,
    root_pid: libc::pid_t,
    _commands: &OwnedFd,
    immediate: bool,
) -> Option<i32> {
    // SAFETY: anchor_pid is our own reserved process group and is nonzero. The anchor ignores
    // SIGTERM while the target retains its provider-native signal behavior.
    unsafe { libc::kill(-anchor_pid, libc::SIGTERM) };
    let deadline = Instant::now()
        + if immediate {
            Duration::from_millis(100)
        } else {
            TERMINATE_GRACE
        };
    loop {
        let mut status = 0;
        // SAFETY: root_pid is our exact direct child.
        let waited = unsafe { libc::waitpid(root_pid, &mut status, libc::WNOHANG) };
        if waited == root_pid {
            return Some(status);
        }
        if waited < 0 {
            if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return None;
        }
        if Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    // SAFETY: this targets the exact retained provider root, not a reused PID (it is unreaped).
    unsafe { libc::kill(root_pid, libc::SIGKILL) };
    loop {
        let mut status = 0;
        // SAFETY: blocking wait reaps the exact direct child after SIGKILL.
        let waited = unsafe { libc::waitpid(root_pid, &mut status, 0) };
        if waited == root_pid {
            return Some(status);
        }
        if waited < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
            continue;
        }
        return None;
    }
}

struct PreparedExec {
    program: CString,
    argv: Vec<CString>,
    env: Vec<CString>,
    cwd: Option<CString>,
}

impl PreparedExec {
    fn new(target: WireLaunch) -> Result<Self, GuardianError> {
        let program = CString::new(target.program).map_err(|_| GuardianError::InvalidIdentity)?;
        let mut argv = Vec::with_capacity(target.args.len() + 1);
        argv.push(program.clone());
        for arg in target.args {
            argv.push(CString::new(arg).map_err(|_| GuardianError::InvalidIdentity)?);
        }
        let env = target
            .env
            .into_iter()
            .map(|(key, value)| {
                let mut item = key;
                item.push(b'=');
                item.extend(value);
                CString::new(item).map_err(|_| GuardianError::InvalidIdentity)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let cwd = target
            .cwd
            .map(|cwd| CString::new(cwd).map_err(|_| GuardianError::InvalidIdentity))
            .transpose()?;
        Ok(Self {
            program,
            argv,
            env,
            cwd,
        })
    }
}

fn root_exec(prepared: PreparedExec, pipes: Pipes) -> ! {
    drop(pipes.ready_read);
    drop(pipes.anchor_command_read);
    drop(pipes.anchor_command_write);
    drop(pipes.status_read);
    drop(pipes.status_write);
    drop(pipes.ready_write);
    drop(pipes.activation_write);
    let activation_fd = pipes.activation_read.as_raw_fd();
    if let Some(cwd) = &prepared.cwd {
        // SAFETY: cwd is a retained NUL-terminated path prepared before fork.
        if unsafe { libc::chdir(cwd.as_ptr()) } != 0 {
            // SAFETY: fork child must not unwind through parent-owned Rust state.
            unsafe { libc::_exit(127) }
        }
    }
    // SAFETY: signal and sigprocmask are async-signal-safe and reset inherited anchor state.
    unsafe {
        for signal in [
            libc::SIGCHLD,
            libc::SIGHUP,
            libc::SIGINT,
            libc::SIGQUIT,
            libc::SIGTERM,
            libc::SIGPIPE,
            libc::SIGALRM,
        ] {
            libc::signal(signal, libc::SIG_DFL);
        }
        let mut empty = std::mem::zeroed();
        libc::sigemptyset(&mut empty);
        libc::sigprocmask(libc::SIG_SETMASK, &empty, std::ptr::null_mut());
    }
    let mut activation = 0_u8;
    // SAFETY: activation_fd is a live pipe read end. EINTR is handled by retrying.
    loop {
        let read = unsafe { libc::read(activation_fd, (&mut activation as *mut u8).cast(), 1) };
        if read == 1 {
            break;
        }
        if read == 0 || io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
            // SAFETY: fork child exits without touching shared Rust state.
            unsafe { libc::_exit(127) }
        }
    }
    if activation != b'A' {
        // SAFETY: fork child exits without touching shared Rust state.
        unsafe { libc::_exit(127) }
    }
    drop(pipes.activation_read);

    let mut argv: Vec<*const libc::c_char> = prepared.argv.iter().map(|arg| arg.as_ptr()).collect();
    argv.push(std::ptr::null());
    let mut env: Vec<*const libc::c_char> = prepared.env.iter().map(|item| item.as_ptr()).collect();
    env.push(std::ptr::null());
    // SAFETY: every pointer is retained NUL-terminated storage and both arrays end in null.
    unsafe { libc::execve(prepared.program.as_ptr(), argv.as_ptr(), env.as_ptr()) };
    // SAFETY: exec failure cannot return to shared Rust state.
    unsafe { libc::_exit(127) }
}

#[derive(Clone, Copy)]
struct AnchorReport {
    root_wait_status: i32,
    root_reaped: bool,
}

fn write_anchor_report(fd: &OwnedFd, report: AnchorReport) -> io::Result<()> {
    let mut bytes = [0_u8; 8];
    bytes[..4].copy_from_slice(&report.root_wait_status.to_be_bytes());
    bytes[4] = u8::from(report.root_reaped);
    write_all_fd(fd.as_raw_fd(), &bytes)
}

fn read_anchor_report(fd: &mut OwnedFd) -> io::Result<AnchorReport> {
    let mut bytes = [0_u8; 8];
    read_exact_fd(fd.as_raw_fd(), &mut bytes)?;
    Ok(AnchorReport {
        root_wait_status: i32::from_be_bytes(bytes[..4].try_into().unwrap_or_default()),
        root_reaped: bytes[4] == 1,
    })
}

fn write_i32(fd: &OwnedFd, value: i32) -> io::Result<()> {
    write_all_fd(fd.as_raw_fd(), &value.to_be_bytes())
}

fn read_i32(fd: &mut OwnedFd) -> io::Result<i32> {
    let mut bytes = [0_u8; 4];
    read_exact_fd(fd.as_raw_fd(), &mut bytes)?;
    Ok(i32::from_be_bytes(bytes))
}

fn write_byte(fd: &mut OwnedFd, byte: u8) -> io::Result<()> {
    write_all_fd(fd.as_raw_fd(), &[byte])
}

fn write_all_fd(fd: RawFd, mut bytes: &[u8]) -> io::Result<()> {
    while !bytes.is_empty() {
        // SAFETY: bytes points to readable storage and fd is live for the call.
        let written = unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) };
        if written < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        if written == 0 {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "custody pipe write stalled",
            ));
        }
        bytes = &bytes[usize::try_from(written).unwrap_or(bytes.len())..];
    }
    Ok(())
}

fn read_exact_fd(fd: RawFd, mut bytes: &mut [u8]) -> io::Result<()> {
    while !bytes.is_empty() {
        // SAFETY: bytes points to writable storage and fd is live for the call.
        let read = unsafe { libc::read(fd, bytes.as_mut_ptr().cast(), bytes.len()) };
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "custody pipe closed",
            ));
        }
        if read < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        let read = usize::try_from(read).unwrap_or(bytes.len());
        bytes = &mut bytes[read..];
    }
    Ok(())
}

fn abort_anchor_and_prove(anchor_pid: libc::pid_t, mut pipes: CustodianPipes) -> bool {
    let _ = write_byte(&mut pipes.anchor_command_write, b'T');
    // Closing every custody pipe forces the anchor's HUP/EOF paths and deliberately proves that
    // cleanup does not depend on status-report delivery.
    drop(pipes);
    let deadline = Instant::now() + CLEANUP_TIMEOUT;
    let anchor_status = loop {
        let mut status = 0;
        // SAFETY: anchor_pid is the exact direct child.
        let waited = unsafe { libc::waitpid(anchor_pid, &mut status, libc::WNOHANG) };
        if waited == anchor_pid {
            break Some(status);
        }
        if waited < 0 {
            if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }
            break None;
        }
        if Instant::now() >= deadline {
            break None;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let group_absent = wait_group_absent(anchor_pid, Duration::from_secs(2));
    anchor_status.is_some() && group_absent
}

fn wait_group_absent(group: libc::pid_t, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        // SAFETY: group is the retained positive anchor PGID. Signal zero has no side effect.
        let result = unsafe { libc::kill(-group, 0) };
        if result != 0 && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn wait_anchor_drained(status: i32) -> bool {
    libc::WIFSIGNALED(status) && libc::WTERMSIG(status) == libc::SIGKILL
}

fn exit_code(status: i32) -> i32 {
    if libc::WIFEXITED(status) {
        libc::WEXITSTATUS(status)
    } else if libc::WIFSIGNALED(status) {
        128 + libc::WTERMSIG(status)
    } else {
        1
    }
}

fn write_frame<T: Serialize>(stream: &mut UnixStream, value: &T) -> io::Result<()> {
    let bytes = serde_json::to_vec(value).map_err(io::Error::other)?;
    if bytes.len() > FRAME_LIMIT {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "custody frame is oversized",
        ));
    }
    let length = u32::try_from(bytes.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "custody frame is oversized"))?;
    stream.write_all(&length.to_be_bytes())?;
    stream.write_all(&bytes)?;
    stream.flush()
}

fn read_frame<T: for<'de> Deserialize<'de>>(stream: &mut UnixStream) -> io::Result<T> {
    let mut length = [0_u8; 4];
    stream.read_exact(&mut length)?;
    let length = usize::try_from(u32::from_be_bytes(length)).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "custody frame length is invalid",
        )
    })?;
    if length == 0 || length > FRAME_LIMIT {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "custody frame is invalid",
        ));
    }
    let mut bytes = vec![0; length];
    stream.read_exact(&mut bytes)?;
    serde_json::from_slice(&bytes).map_err(io::Error::other)
}

fn read_frame_bounded<T: for<'de> Deserialize<'de>>(
    stream: &UnixStream,
    timeout: Duration,
) -> io::Result<T> {
    let deadline = Instant::now() + timeout;
    let mut length = [0_u8; 4];
    read_exact_bounded(stream.as_raw_fd(), &mut length, deadline)?;
    let length = usize::try_from(u32::from_be_bytes(length)).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "custody frame length is invalid",
        )
    })?;
    if length == 0 || length > FRAME_LIMIT {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "custody frame is invalid",
        ));
    }
    let mut bytes = vec![0; length];
    read_exact_bounded(stream.as_raw_fd(), &mut bytes, deadline)?;
    serde_json::from_slice(&bytes)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

fn read_exact_bounded(fd: RawFd, mut bytes: &mut [u8], deadline: Instant) -> io::Result<()> {
    while !bytes.is_empty() {
        wait_readable(fd, deadline)?;
        // SAFETY: `bytes` points to writable storage and `fd` remains owned by the caller.
        let read = unsafe { libc::read(fd, bytes.as_mut_ptr().cast(), bytes.len()) };
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "custody socket closed before a complete frame",
            ));
        }
        if read < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        let read = usize::try_from(read).unwrap_or(bytes.len());
        bytes = &mut bytes[read..];
    }
    Ok(())
}

fn wait_readable(fd: RawFd, deadline: Instant) -> io::Result<()> {
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "custody CLEAN proof timed out",
            ));
        }
        let timeout_ms = remaining.as_millis().clamp(1, i32::MAX as u128) as i32;
        let mut polled = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: `polled` is writable storage for exactly one live descriptor.
        let result = unsafe { libc::poll(&mut polled, 1, timeout_ms) };
        if result == 0 {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "custody CLEAN proof timed out",
            ));
        }
        if result < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        if polled.revents & libc::POLLNVAL != 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "custody CLEAN descriptor is invalid",
            ));
        }
        if polled.revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0 {
            return Ok(());
        }
    }
}

fn unavailable(error: impl std::fmt::Display) -> GuardianError {
    GuardianError::Unavailable(error.to_string())
}

fn unavailable_at(operation: &str, error: impl std::fmt::Display) -> GuardianError {
    GuardianError::Unavailable(format!("{operation}: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn late_terminate_accepts_buffered_clean_from_an_exited_custodian() {
        let job = Uuid::new_v4();
        let (mut desktop, mut custodian) = UnixStream::pair().expect("private custody socket");
        write_frame(
            &mut custodian,
            &CustodianFrame::Clean {
                job,
                root_wait_status: 0,
            },
        )
        .expect("buffer CLEAN proof");
        drop(custodian);

        terminate(&mut desktop, job).expect("late termination hint is advisory");
        assert!(matches!(
            receive_clean(&mut desktop).expect("buffered CLEAN proof"),
            CustodianFrame::Clean {
                job: frame_job,
                root_wait_status: 0,
            } if frame_job == job
        ));
    }

    #[test]
    fn ignored_termination_write_never_synthesizes_a_clean_proof() {
        let job = Uuid::new_v4();
        let (mut desktop, custodian) = UnixStream::pair().expect("private custody socket");
        drop(custodian);

        terminate(&mut desktop, job).expect("termination hint is advisory");
        let error = receive_clean(&mut desktop).expect_err("CLEAN proof remains mandatory");
        assert!(matches!(error, GuardianError::BlockedUnclean));
    }

    #[test]
    fn partial_clean_frame_is_bounded_and_fails_closed() {
        let (mut desktop, mut custodian) = UnixStream::pair().expect("private custody socket");
        custodian
            .write_all(&[0, 0])
            .expect("partial custody frame length");

        let started = Instant::now();
        let error = receive_clean_with_timeout(&mut desktop, Duration::from_millis(20))
            .expect_err("partial CLEAN proof must fail closed");
        assert!(matches!(error, GuardianError::BlockedUnclean));
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
