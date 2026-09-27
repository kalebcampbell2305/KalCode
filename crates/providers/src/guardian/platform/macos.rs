#![allow(unsafe_code)]

use std::ffi::{CStr, CString, OsStr, OsString};
use std::fs::File;
use std::mem::MaybeUninit;
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::Path;
use std::sync::Arc;

use crate::guardian::{GuardianError, ProcessIdentity};

const LOCK_MODE: libc::mode_t = 0o600;

fn unavailable(error: impl std::fmt::Display) -> GuardianError {
    GuardianError::Unavailable(error.to_string())
}

fn last_error() -> GuardianError {
    unavailable(std::io::Error::last_os_error())
}

fn checked_name(name: &OsStr) -> Result<CString, GuardianError> {
    let bytes = name.as_bytes();
    if bytes.is_empty()
        || bytes.len() > 255
        || bytes == b"."
        || bytes == b".."
        || bytes.iter().any(|byte| matches!(*byte, 0 | b'/'))
    {
        return Err(GuardianError::InvalidIdentity);
    }
    CString::new(bytes).map_err(|_| GuardianError::InvalidIdentity)
}

fn stat_fd(fd: RawFd) -> Result<libc::stat, GuardianError> {
    let mut stat = MaybeUninit::<libc::stat>::zeroed();
    // SAFETY: `stat` points to writable storage of the exact structure requested by fstat.
    if unsafe { libc::fstat(fd, stat.as_mut_ptr()) } != 0 {
        return Err(last_error());
    }
    // SAFETY: successful fstat initialized the complete structure.
    Ok(unsafe { stat.assume_init() })
}

fn validate_regular_owner(fd: RawFd) -> Result<(), GuardianError> {
    let stat = stat_fd(fd)?;
    // SAFETY: getuid has no memory preconditions.
    let uid = unsafe { libc::getuid() };
    if stat.st_mode & libc::S_IFMT != libc::S_IFREG
        || stat.st_nlink != 1
        || stat.st_uid != uid
        || stat.st_mode & 0o077 != 0
    {
        return Err(GuardianError::Unavailable(
            "guardian evidence file is not a private owner-controlled regular file".into(),
        ));
    }
    Ok(())
}

#[derive(Debug)]
pub(crate) struct AnchoredDirectory {
    directory: File,
    identity: String,
}

impl AnchoredDirectory {
    pub(crate) fn entry_names(&self) -> Result<Vec<OsString>, GuardianError> {
        // SAFETY: duplicating a live descriptor retains this exact directory authority.
        let fd = unsafe { libc::dup(self.directory.as_raw_fd()) };
        if fd < 0 {
            return Err(last_error());
        }
        // SAFETY: ownership of the duplicate transfers to DIR on success.
        let stream = unsafe { libc::fdopendir(fd) };
        if stream.is_null() {
            let error = last_error();
            // SAFETY: fdopendir failed, so the fresh duplicate remains ours.
            unsafe {
                libc::close(fd);
            }
            return Err(error);
        }
        let result = (|| {
            let mut names = Vec::new();
            // SAFETY: stream is an exclusively borrowed valid DIR; restarting avoids shared offsets.
            unsafe {
                libc::rewinddir(stream);
            }
            loop {
                // SAFETY: thread-local errno and a valid directory stream are used synchronously.
                let entry = unsafe {
                    *libc::__error() = 0;
                    libc::readdir(stream)
                };
                if entry.is_null() {
                    // SAFETY: errno is thread-local and read immediately after readdir.
                    if unsafe { *libc::__error() } != 0 {
                        return Err(last_error());
                    }
                    break;
                }
                // SAFETY: readdir returns a NUL-terminated name valid until the next call.
                let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
                if name != b"." && name != b".." {
                    names.push(OsString::from_vec(name.to_vec()));
                }
                if names.len() > 8192 {
                    return Err(GuardianError::RecoveryPending);
                }
            }
            Ok(names)
        })();
        // SAFETY: this function owns stream and closes it exactly once.
        unsafe {
            libc::closedir(stream);
        }
        result
    }
    pub(crate) fn open(path: &Path) -> Result<Self, GuardianError> {
        let path = CString::new(path.as_os_str().as_bytes())
            .map_err(|_| GuardianError::InvalidIdentity)?;
        // SAFETY: the path is a live NUL-terminated byte string. O_NOFOLLOW rejects a final
        // symlink and O_DIRECTORY rejects every non-directory object.
        let fd = unsafe {
            libc::open(
                path.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(last_error());
        }
        // SAFETY: open returned one newly owned descriptor.
        let directory = unsafe { File::from_raw_fd(fd) };
        let stat = stat_fd(directory.as_raw_fd())?;
        // SAFETY: getuid has no memory preconditions.
        if stat.st_mode & libc::S_IFMT != libc::S_IFDIR
            || stat.st_uid != unsafe { libc::getuid() }
            || stat.st_mode & 0o077 != 0
        {
            return Err(GuardianError::Unavailable(
                "guardian evidence root is not a private owner-controlled directory".into(),
            ));
        }
        Ok(Self {
            directory,
            identity: format!("{:x}:{:x}", stat.st_dev, stat.st_ino),
        })
    }

    pub(crate) fn identity_token(&self) -> &str {
        &self.identity
    }

    pub(crate) fn open_existing(&self, name: &OsStr) -> Result<Option<File>, GuardianError> {
        self.open_relative(name, false)
    }

    pub(crate) fn open_or_create(&self, name: &OsStr) -> Result<File, GuardianError> {
        let file = self.open_relative(name, true)?.ok_or_else(|| {
            GuardianError::Unavailable("guardian relative create returned no descriptor".into())
        })?;
        self.directory.sync_all().map_err(unavailable)?;
        Ok(file)
    }

    fn open_relative(&self, name: &OsStr, create: bool) -> Result<Option<File>, GuardianError> {
        let name = checked_name(name)?;
        let flags = libc::O_RDWR
            | libc::O_CLOEXEC
            | libc::O_NOFOLLOW
            | if create { libc::O_CREAT } else { 0 };
        // SAFETY: `directory` is a retained directory descriptor and `name` is a validated single
        // path component. The mode is used only when O_CREAT creates a new file.
        let fd = unsafe {
            libc::openat(
                self.directory.as_raw_fd(),
                name.as_ptr(),
                flags,
                libc::c_uint::from(LOCK_MODE),
            )
        };
        if fd < 0 {
            let error = std::io::Error::last_os_error();
            if !create && error.kind() == std::io::ErrorKind::NotFound {
                return Ok(None);
            }
            return Err(unavailable(error));
        }
        // SAFETY: openat returned one newly owned descriptor.
        let file = unsafe { File::from_raw_fd(fd) };
        validate_regular_owner(file.as_raw_fd())?;
        Ok(Some(file))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RecoveryLockRole {
    DesktopEpoch,
    HelperDrain,
}

impl RecoveryLockRole {
    fn file_name(self) -> &'static CStr {
        match self {
            Self::DesktopEpoch => c"desktop-epoch.lock",
            Self::HelperDrain => c"helper-drain.lock",
        }
    }
}

#[derive(Debug)]
pub(crate) struct RecoveryLock {
    file: File,
    directory: Arc<AnchoredDirectory>,
    role: RecoveryLockRole,
}

impl RecoveryLock {
    pub(crate) fn protects(&self, directory: &AnchoredDirectory, role: RecoveryLockRole) -> bool {
        self.role == role && self.directory.identity_token() == directory.identity_token()
    }
    pub(crate) fn acquire_expected(
        root: &Path,
        expected_identity: &str,
        role: RecoveryLockRole,
    ) -> Result<Self, GuardianError> {
        let directory = Arc::new(AnchoredDirectory::open(root)?);
        if directory.identity_token() != expected_identity {
            return Err(GuardianError::ObjectMismatch);
        }
        Self::acquire_anchored(directory, role)
    }

    pub(crate) fn acquire_anchored(
        directory: Arc<AnchoredDirectory>,
        role: RecoveryLockRole,
    ) -> Result<Self, GuardianError> {
        let file = directory.open_or_create(OsStr::from_bytes(role.file_name().to_bytes()))?;
        // SAFETY: `file` owns a live descriptor; flock changes only the advisory lock state.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            let error = std::io::Error::last_os_error();
            return Err(if error.raw_os_error() == Some(libc::EWOULDBLOCK) {
                match role {
                    RecoveryLockRole::DesktopEpoch => GuardianError::RecoveryOwned,
                    RecoveryLockRole::HelperDrain => GuardianError::RecoveryPending,
                }
            } else {
                unavailable(error)
            });
        }
        Ok(Self {
            file,
            directory,
            role,
        })
    }
}

impl Drop for RecoveryLock {
    fn drop(&mut self) {
        // SAFETY: `file` remains open through the call; unlock failure cannot be recovered in Drop.
        let _ = unsafe { libc::flock(self.file.as_raw_fd(), libc::LOCK_UN) };
    }
}

pub fn recovery_root_identity(path: &Path) -> Result<String, GuardianError> {
    AnchoredDirectory::open(path).map(|directory| directory.identity)
}

pub(crate) fn current_boot_identifier() -> Result<String, GuardianError> {
    let mut boot = MaybeUninit::<libc::timeval>::zeroed();
    let mut length = std::mem::size_of::<libc::timeval>();
    // SAFETY: the sysctl name is static and the output points to correctly sized writable storage.
    let result = unsafe {
        libc::sysctlbyname(
            c"kern.boottime".as_ptr(),
            boot.as_mut_ptr().cast(),
            &mut length,
            std::ptr::null_mut(),
            0,
        )
    };
    if result != 0 || length != std::mem::size_of::<libc::timeval>() {
        return Err(GuardianError::Unavailable(
            "macOS boot identity could not be proved".into(),
        ));
    }
    // SAFETY: successful sysctlbyname initialized the complete timeval.
    let boot = unsafe { boot.assume_init() };
    if boot.tv_sec <= 0 || boot.tv_usec < 0 {
        return Err(GuardianError::Unavailable(
            "macOS boot identity was invalid".into(),
        ));
    }
    Ok(format!(
        "{:016x}{:016x}",
        boot.tv_sec as u64, boot.tv_usec as u64
    ))
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct MacProcessInfo {
    pub identity: ProcessIdentity,
    pub parent_pid: u32,
    pub process_group: u32,
    pub session_id: u32,
    pub foreground_group: u32,
}

pub(crate) fn current_process_identity() -> Result<ProcessIdentity, GuardianError> {
    // SAFETY: getpid has no memory preconditions.
    process_info(unsafe { libc::getpid() }).map(|info| info.identity)
}

pub(crate) fn exact_process_exited(expected: ProcessIdentity) -> Result<bool, GuardianError> {
    let pid = libc::pid_t::try_from(expected.pid()).map_err(|_| GuardianError::InvalidIdentity)?;
    // SAFETY: signal zero probes existence without delivering a signal or mutating the process.
    if unsafe { libc::kill(pid, 0) } != 0 {
        let error = std::io::Error::last_os_error();
        return if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(true)
        } else {
            Err(unavailable(error))
        };
    }
    process_info(pid).map(|info| info.identity != expected)
}

pub(crate) fn process_info(pid: libc::pid_t) -> Result<MacProcessInfo, GuardianError> {
    if pid <= 0 {
        return Err(GuardianError::InvalidIdentity);
    }
    let mut info = MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let expected = i32::try_from(std::mem::size_of::<libc::proc_bsdinfo>()).map_err(|_| {
        GuardianError::Unavailable("process identity structure is oversized".into())
    })?;
    // SAFETY: the output points to writable storage of the exact size passed to proc_pidinfo.
    let read = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            expected,
        )
    };
    if read != expected {
        return Err(GuardianError::Unavailable(
            "macOS process identity could not be proved".into(),
        ));
    }
    // SAFETY: the successful exact-size read initialized the structure.
    let info = unsafe { info.assume_init() };
    if info.pbi_pid != pid as u32 {
        return Err(GuardianError::ObjectMismatch);
    }
    let birth_time_100ns = info
        .pbi_start_tvsec
        .checked_mul(10_000_000)
        .and_then(|value| value.checked_add(info.pbi_start_tvusec.saturating_mul(10)))
        .ok_or(GuardianError::InvalidIdentity)?;
    let identity = ProcessIdentity::new(info.pbi_pid, birth_time_100ns)?;
    // SAFETY: getsid is a read-only process query for the validated PID.
    let session_id = unsafe { libc::getsid(pid) };
    if session_id <= 0 {
        return Err(last_error());
    }
    Ok(MacProcessInfo {
        identity,
        parent_pid: info.pbi_ppid,
        process_group: info.pbi_pgid,
        session_id: session_id as u32,
        foreground_group: info.e_tpgid,
    })
}
