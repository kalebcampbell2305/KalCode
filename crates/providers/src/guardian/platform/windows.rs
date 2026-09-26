#![allow(unsafe_code)]

use std::ffi::{OsStr, c_void};
use std::fs::{File, OpenOptions};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::{AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use windows::Win32::Foundation::{
    DUPLICATE_HANDLE_OPTIONS, DuplicateHandle, ERROR_LOCK_VIOLATION, FILETIME, HANDLE,
    WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle, LOCKFILE_EXCLUSIVE_LOCK,
    LOCKFILE_FAIL_IMMEDIATELY, LockFileEx, UnlockFileEx,
};
use windows::Win32::System::IO::OVERLAPPED;
#[cfg(test)]
use windows::Win32::System::JobObjects::OpenJobObjectW;
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
};
use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
use windows::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, CreateProcessW, GetCurrentProcess, GetCurrentProcessId,
    GetProcessTimes, OpenProcess, PROCESS_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION,
    ResumeThread, STARTUPINFOW, TerminateProcess, WaitForSingleObject,
};
use windows::core::{PCSTR, PCWSTR, PWSTR};

use super::super::{GuardianError, ProcessIdentity};

const JOB_OBJECT_QUERY: u32 = 0x0004;
const JOB_OBJECT_TERMINATE: u32 = 0x0008;
const SYNCHRONIZE: u32 = 0x0010_0000;
const FILE_ATTRIBUTE_REPARSE_POINT_RAW: u32 = 0x0000_0400;
const FILE_FLAG_OPEN_REPARSE_POINT_RAW: u32 = 0x0020_0000;
const FILE_FLAG_BACKUP_SEMANTICS_RAW: u32 = 0x0200_0000;
const FILE_READ_DATA_RAW: u32 = 0x0000_0001;
const FILE_WRITE_DATA_RAW: u32 = 0x0000_0002;
const FILE_READ_ATTRIBUTES_RAW: u32 = 0x0000_0080;
const FILE_WRITE_ATTRIBUTES_RAW: u32 = 0x0000_0100;
const FILE_SHARE_READ_WRITE_RAW: u32 = 0x0000_0003;
const FILE_SHARE_READ_WRITE_DELETE_RAW: u32 = 0x0000_0007;
const FILE_OPEN_RAW: u32 = 0x0000_0001;
const FILE_OPEN_IF_RAW: u32 = 0x0000_0003;
const FILE_NON_DIRECTORY_FILE_RAW: u32 = 0x0000_0040;
const FILE_SYNCHRONOUS_IO_NONALERT_RAW: u32 = 0x0000_0020;
const FILE_OPEN_REPARSE_POINT_RAW: u32 = 0x0020_0000;
const OBJ_CASE_INSENSITIVE_RAW: u32 = 0x0000_0040;
const STATUS_OBJECT_NAME_NOT_FOUND_RAW: i32 = 0xC000_0034_u32 as i32;
const STATUS_OBJECT_PATH_NOT_FOUND_RAW: i32 = 0xC000_003A_u32 as i32;
const HELPER_RECOVERY_LOCK_TIMEOUT: Duration = Duration::from_secs(15);
const RECOVERY_LOCK_RETRY: Duration = Duration::from_millis(10);
const SYSTEM_BOOT_ENVIRONMENT_INFORMATION: u32 = 90;

#[repr(C)]
struct NtUnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: *mut u16,
}

#[repr(C)]
struct NtObjectAttributes {
    length: u32,
    root_directory: *mut c_void,
    object_name: *mut NtUnicodeString,
    attributes: u32,
    security_descriptor: *mut c_void,
    security_quality_of_service: *mut c_void,
}

#[repr(C)]
struct NtIoStatusBlock {
    status: isize,
    information: usize,
}

#[repr(C)]
struct SystemBootEnvironmentInformation {
    boot_identifier: [u8; 16],
    firmware_type: u32,
    _alignment: u32,
    boot_flags: u64,
}

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtCreateFile(
        file_handle: *mut *mut c_void,
        desired_access: u32,
        object_attributes: *mut NtObjectAttributes,
        io_status_block: *mut NtIoStatusBlock,
        allocation_size: *mut i64,
        file_attributes: u32,
        share_access: u32,
        create_disposition: u32,
        create_options: u32,
        ea_buffer: *mut c_void,
        ea_length: u32,
    ) -> i32;

    fn RtlNtStatusToDosError(status: i32) -> u32;
}

/// One of two independent kernel-file leases that fence a data root across desktop epochs.
#[derive(Debug, Clone, Copy)]
pub(crate) enum RecoveryLockRole {
    /// Held by the desktop for its complete lifetime. A helper crash cannot release it.
    DesktopEpoch,
    /// Held by the helper until it has drained and dropped every Job Object handle.
    HelperDrain,
}

#[derive(Debug)]
pub(crate) struct RecoveryLock {
    file: File,
    // Retain the exact directory object for the full lease. Its handle denies delete sharing, so
    // neither the recovery file nor its parent namespace can be swapped behind this lock.
    _directory: Arc<AnchoredDirectory>,
}

impl RecoveryLock {
    #[cfg(test)]
    pub(crate) fn acquire(root: &Path, role: RecoveryLockRole) -> Result<Self, GuardianError> {
        let directory = Arc::new(AnchoredDirectory::open(root)?);
        Self::acquire_anchored(directory, role)
    }

    pub(crate) fn acquire_expected(
        root: &Path,
        expected_identity: &str,
        role: RecoveryLockRole,
    ) -> Result<Self, GuardianError> {
        let directory = Arc::new(AnchoredDirectory::open(root)?);
        if directory.identity_token() != expected_identity {
            return Err(GuardianError::Unavailable(
                "provider guardian recovery root identity changed".into(),
            ));
        }
        Self::acquire_anchored(directory, role)
    }

    pub(crate) fn acquire_anchored(
        directory: Arc<AnchoredDirectory>,
        role: RecoveryLockRole,
    ) -> Result<Self, GuardianError> {
        let name = match role {
            RecoveryLockRole::DesktopEpoch => OsStr::new("desktop-epoch.v1.lock"),
            RecoveryLockRole::HelperDrain => OsStr::new("helper-drain.v1.lock"),
        };
        let file = directory.open_recovery_lock(name)?;
        let deadline = match role {
            RecoveryLockRole::DesktopEpoch => None,
            RecoveryLockRole::HelperDrain => {
                Some(std::time::Instant::now() + HELPER_RECOVERY_LOCK_TIMEOUT)
            }
        };
        loop {
            let mut overlapped = OVERLAPPED::default();
            // SAFETY: `file` is a live non-reparse, singly-linked regular file handle and the
            // OVERLAPPED storage remains live through this synchronous nonblocking call.
            match unsafe {
                LockFileEx(
                    HANDLE(file.as_raw_handle()),
                    LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                    None,
                    1,
                    0,
                    &raw mut overlapped,
                )
            } {
                Ok(()) => {
                    return Ok(Self {
                        file,
                        _directory: directory,
                    });
                }
                Err(error)
                    if error.code()
                        == windows::core::HRESULT::from_win32(ERROR_LOCK_VIOLATION.0)
                        && deadline
                            .is_some_and(|deadline| std::time::Instant::now() < deadline) =>
                {
                    std::thread::sleep(RECOVERY_LOCK_RETRY);
                }
                Err(error)
                    if error.code()
                        == windows::core::HRESULT::from_win32(ERROR_LOCK_VIOLATION.0) =>
                {
                    let reason = match role {
                        RecoveryLockRole::DesktopEpoch => {
                            "a prior desktop generation still owns the provider data root"
                        }
                        RecoveryLockRole::HelperDrain => {
                            "the prior provider guardian did not quiesce before restart"
                        }
                    };
                    return Err(GuardianError::Unavailable(reason.into()));
                }
                Err(error) => return Err(windows_unavailable(error)),
            }
        }
    }
}

impl Drop for RecoveryLock {
    fn drop(&mut self) {
        let mut overlapped = OVERLAPPED::default();
        // SAFETY: this object owns the exact byte-range lock on the live file handle. Closing the
        // handle also releases it on process death; explicit unlock keeps normal teardown clear.
        let _ = unsafe {
            UnlockFileEx(
                HANDLE(self.file.as_raw_handle()),
                None,
                1,
                0,
                &raw mut overlapped,
            )
        };
    }
}

/// Directory authority retained by kernel handle. Slot names are opened relative to this handle,
/// so path replacement or ancestor reparse changes after startup cannot redirect marker I/O.
#[derive(Debug)]
pub(crate) struct AnchoredDirectory {
    directory: File,
    identity: String,
}

impl AnchoredDirectory {
    pub(crate) fn open(path: &Path) -> Result<Self, GuardianError> {
        let directory = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ_WRITE_RAW)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS_RAW | FILE_FLAG_OPEN_REPARSE_POINT_RAW)
            .open(path)
            .map_err(io_unavailable)?;
        let metadata = directory.metadata().map_err(io_unavailable)?;
        if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT_RAW != 0
        {
            return Err(GuardianError::Unavailable(
                "marker storage handle is not an ordinary directory".into(),
            ));
        }
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        // SAFETY: `directory` is a live directory handle and `info` is exact writable output.
        unsafe { GetFileInformationByHandle(HANDLE(directory.as_raw_handle()), &raw mut info) }
            .map_err(windows_unavailable)?;
        let file_index = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
        let identity = format!("{:08x}:{file_index:016x}", info.dwVolumeSerialNumber);
        Ok(Self {
            directory,
            identity,
        })
    }

    pub(crate) fn identity_token(&self) -> &str {
        &self.identity
    }

    pub(crate) fn open_existing(&self, name: &OsStr) -> Result<Option<File>, GuardianError> {
        self.open_relative(name, false, false, true)
    }

    pub(crate) fn open_or_create(&self, name: &OsStr) -> Result<File, GuardianError> {
        self.open_relative(name, true, true, true)?.ok_or_else(|| {
            GuardianError::Unavailable("relative marker create returned no handle".into())
        })
    }

    fn open_recovery_lock(&self, name: &OsStr) -> Result<File, GuardianError> {
        self.open_relative(name, true, true, false)?.ok_or_else(|| {
            GuardianError::Unavailable("relative recovery lock create returned no handle".into())
        })
    }

    fn open_relative(
        &self,
        name: &OsStr,
        create: bool,
        write: bool,
        share_delete: bool,
    ) -> Result<Option<File>, GuardianError> {
        let mut wide: Vec<u16> = name.encode_wide().collect();
        if wide.is_empty()
            || wide.iter().any(|value| {
                *value == 0
                    || *value == u16::from(b'/')
                    || *value == u16::from(b'\\')
                    || *value == u16::from(b':')
            })
            || wide.len() > 255
        {
            return Err(GuardianError::InvalidIdentity);
        }
        let byte_length = wide
            .len()
            .checked_mul(std::mem::size_of::<u16>())
            .and_then(|length| u16::try_from(length).ok())
            .ok_or(GuardianError::InvalidIdentity)?;
        let mut unicode = NtUnicodeString {
            length: byte_length,
            maximum_length: byte_length,
            buffer: wide.as_mut_ptr(),
        };
        let mut attributes = NtObjectAttributes {
            length: u32::try_from(std::mem::size_of::<NtObjectAttributes>()).map_err(|_| {
                GuardianError::Unavailable("object attributes are oversized".into())
            })?,
            root_directory: self.directory.as_raw_handle(),
            object_name: &raw mut unicode,
            attributes: OBJ_CASE_INSENSITIVE_RAW,
            security_descriptor: std::ptr::null_mut(),
            security_quality_of_service: std::ptr::null_mut(),
        };
        let mut raw = std::ptr::null_mut();
        let mut io = NtIoStatusBlock {
            status: 0,
            information: 0,
        };
        let desired_access = FILE_READ_DATA_RAW
            | FILE_READ_ATTRIBUTES_RAW
            | SYNCHRONIZE
            | if write {
                FILE_WRITE_DATA_RAW | FILE_WRITE_ATTRIBUTES_RAW
            } else {
                0
            };
        // SAFETY: every pointer refers to initialized storage for the duration of the call.
        // `root_directory` is a live retained directory handle, and the relative UTF-16 name is
        // validated to contain no separator, stream, or NUL component.
        let status = unsafe {
            NtCreateFile(
                &raw mut raw,
                desired_access,
                &raw mut attributes,
                &raw mut io,
                std::ptr::null_mut(),
                0x80,
                if share_delete {
                    FILE_SHARE_READ_WRITE_DELETE_RAW
                } else {
                    FILE_SHARE_READ_WRITE_RAW
                },
                if create {
                    FILE_OPEN_IF_RAW
                } else {
                    FILE_OPEN_RAW
                },
                FILE_NON_DIRECTORY_FILE_RAW
                    | FILE_SYNCHRONOUS_IO_NONALERT_RAW
                    | FILE_OPEN_REPARSE_POINT_RAW,
                std::ptr::null_mut(),
                0,
            )
        };
        if status < 0 {
            if !create
                && matches!(
                    status,
                    STATUS_OBJECT_NAME_NOT_FOUND_RAW | STATUS_OBJECT_PATH_NOT_FOUND_RAW
                )
            {
                return Ok(None);
            }
            // SAFETY: conversion has no memory preconditions and accepts the failed NTSTATUS.
            let code = unsafe { RtlNtStatusToDosError(status) };
            return Err(io_unavailable(std::io::Error::from_raw_os_error(
                i32::try_from(code).unwrap_or(i32::MAX),
            )));
        }
        if raw.is_null() {
            return Err(GuardianError::Unavailable(
                "relative marker open returned no handle".into(),
            ));
        }
        // SAFETY: NtCreateFile returned one newly owned kernel file handle.
        let file = unsafe { File::from_raw_handle(raw) };
        let metadata = file.metadata().map_err(io_unavailable)?;
        let mut handle_info = BY_HANDLE_FILE_INFORMATION::default();
        // SAFETY: `file` owns a live file handle and `handle_info` is writable storage of the
        // exact structure requested by GetFileInformationByHandle.
        unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &raw mut handle_info) }
            .map_err(windows_unavailable)?;
        if !metadata.is_file()
            || handle_info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT_RAW != 0
            || handle_info.nNumberOfLinks != 1
        {
            return Err(GuardianError::Unavailable(
                "marker slot is reparse-backed or multiply linked".into(),
            ));
        }
        Ok(Some(file))
    }
}

/// Returns the stable volume/file identity of an ordinary recovery-root directory.
pub fn recovery_root_identity(path: &Path) -> Result<String, GuardianError> {
    AnchoredDirectory::open(path).map(|directory| directory.identity)
}

/// Returns the kernel boot GUID used solely to decide whether an unclean process generation could
/// still exist. `NtQuerySystemInformation` is dynamically resolved because Microsoft classifies
/// this interface as internal and subject to change; any lookup/status/shape failure blocks
/// recovery rather than fabricating a new identifier.
pub(crate) fn current_boot_identifier() -> Result<String, GuardianError> {
    let ntdll = wide_null(OsStr::new("ntdll.dll"));
    // SAFETY: the UTF-16 module name is NUL terminated and ntdll is loaded in every process.
    let module =
        unsafe { GetModuleHandleW(PCWSTR(ntdll.as_ptr())) }.map_err(windows_unavailable)?;
    // SAFETY: the ASCII export name is NUL terminated and the module handle is live.
    let address =
        unsafe { GetProcAddress(module, PCSTR(c"NtQuerySystemInformation".as_ptr().cast())) }
            .ok_or_else(|| {
                GuardianError::Unavailable("Windows boot-identity query is unavailable".into())
            })?;
    type NtQuerySystemInformation =
        unsafe extern "system" fn(u32, *mut c_void, u32, *mut u32) -> i32;
    // SAFETY: the resolved export has the documented NtQuerySystemInformation ABI. A runtime
    // shape/status check below fails closed if this internal interface changes.
    let query: NtQuerySystemInformation = unsafe { std::mem::transmute(address) };
    let mut info = SystemBootEnvironmentInformation {
        boot_identifier: [0; 16],
        firmware_type: 0,
        _alignment: 0,
        boot_flags: 0,
    };
    let mut returned = 0_u32;
    let expected = u32::try_from(std::mem::size_of_val(&info))
        .map_err(|_| GuardianError::Unavailable("boot identity structure is oversized".into()))?;
    // SAFETY: buffer and returned-length pointers refer to initialized writable storage of the
    // exact size supplied to the dynamically resolved system call.
    let status = unsafe {
        query(
            SYSTEM_BOOT_ENVIRONMENT_INFORMATION,
            std::ptr::from_mut(&mut info).cast(),
            expected,
            &raw mut returned,
        )
    };
    if status < 0 || returned < 16 || info.boot_identifier.iter().all(|byte| *byte == 0) {
        return Err(GuardianError::Unavailable(
            "Windows boot identity could not be proved".into(),
        ));
    }
    Ok(info
        .boot_identifier
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

#[derive(Debug)]
pub struct WindowsJob {
    handle: OwnedHandle,
}

impl WindowsJob {
    /// Creates an unnamed Job Object. No peer can regain authority through the object namespace;
    /// the desktop explicitly duplicates only the rights each trusted consumer needs.
    pub fn create(_evidence_label: &str) -> Result<Self, GuardianError> {
        // SAFETY: null security attributes and name request a private, non-inheritable object.
        let raw = unsafe { CreateJobObjectW(None, PCWSTR::null()) }.map_err(windows_unavailable)?;
        // SAFETY: CreateJobObjectW returned a newly owned valid handle. Ownership moves exactly
        // once into OwnedHandle, which closes it on drop.
        let handle = unsafe { OwnedHandle::from_raw_handle(raw.0) };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: the pointer and byte count describe a live initialized value of the exact
        // information class, and `handle` remains valid through the call.
        unsafe {
            SetInformationJobObject(
                as_win_handle(&handle),
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&limits).cast(),
                u32::try_from(std::mem::size_of_val(&limits))
                    .map_err(|_| GuardianError::Unavailable("job limits are oversized".into()))?,
            )
        }
        .map_err(windows_unavailable)?;

        Ok(Self { handle })
    }

    /// Duplicates query/terminate/synchronize authority directly into the trusted helper process.
    /// The target receives no assign or set-attributes rights.
    pub fn duplicate_for_helper(
        &self,
        helper_process: BorrowedHandle<'_>,
    ) -> Result<u64, GuardianError> {
        // SAFETY: GetCurrentProcess returns a pseudo handle that is valid for this call.
        let current = unsafe { GetCurrentProcess() };
        let mut duplicated = HANDLE::default();
        // SAFETY: source and target process handles are live; `duplicated` is writable output.
        unsafe {
            DuplicateHandle(
                current,
                as_win_handle(&self.handle),
                HANDLE(helper_process.as_raw_handle()),
                &raw mut duplicated,
                JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE | SYNCHRONIZE,
                false,
                DUPLICATE_HANDLE_OPTIONS(0),
            )
        }
        .map_err(windows_unavailable)?;
        let value = duplicated.0 as usize;
        u64::try_from(value)
            .map_err(|_| GuardianError::Unavailable("duplicated job handle overflowed".into()))
    }

    /// Creates a least-rights duplicate in the current process. This is used by the contract test
    /// to exercise the same ownership handoff without exposing unsafe handle borrowing to tests.
    pub fn duplicate_for_current_process(&self) -> Result<Self, GuardianError> {
        // SAFETY: GetCurrentProcess returns the documented always-valid pseudo handle and it is
        // borrowed only for the synchronous DuplicateHandle call.
        let current = unsafe { GetCurrentProcess() };
        // SAFETY: the pseudo handle remains valid for the lifetime of this process.
        let borrowed = unsafe { BorrowedHandle::borrow_raw(current.0) };
        let transferred = self.duplicate_for_helper(borrowed)?;
        Self::from_transferred_handle(transferred)
    }

    /// Takes ownership of a handle already duplicated into this process and verifies it is a
    /// queryable kill-on-close Job Object before retaining it.
    pub fn from_transferred_handle(value: u64) -> Result<Self, GuardianError> {
        let value = usize::try_from(value)
            .map_err(|_| GuardianError::Unavailable("transferred job handle overflowed".into()))?;
        if value == 0 || value == usize::MAX {
            return Err(GuardianError::Unavailable(
                "transferred job handle was invalid".into(),
            ));
        }
        // SAFETY: DuplicateHandle created one owned handle value in this process. This function is
        // the unique protocol consumer and therefore takes ownership exactly once.
        let handle = unsafe { OwnedHandle::from_raw_handle(value as *mut c_void) };
        let job = Self { handle };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        // SAFETY: output points at a live value and the transferred handle must carry query rights.
        unsafe {
            QueryInformationJobObject(
                Some(as_win_handle(&job.handle)),
                JobObjectExtendedLimitInformation,
                std::ptr::from_mut(&mut limits).cast(),
                u32::try_from(std::mem::size_of_val(&limits))
                    .map_err(|_| GuardianError::Unavailable("job limits are oversized".into()))?,
                None,
            )
        }
        .map_err(windows_unavailable)?;
        if !limits
            .BasicLimitInformation
            .LimitFlags
            .contains(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
        {
            return Err(GuardianError::Unavailable(
                "transferred job lacks kill-on-close ownership".into(),
            ));
        }
        Ok(job)
    }

    pub(crate) fn raw_handle_value(&self) -> usize {
        self.handle.as_raw_handle() as usize
    }

    pub fn active_processes(&self) -> Result<u32, GuardianError> {
        let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        // SAFETY: the output pointer and byte count describe a live value of the requested class;
        // the owned job handle remains valid and is opened with query rights.
        unsafe {
            QueryInformationJobObject(
                Some(as_win_handle(&self.handle)),
                JobObjectBasicAccountingInformation,
                std::ptr::from_mut(&mut accounting).cast(),
                u32::try_from(std::mem::size_of_val(&accounting)).map_err(|_| {
                    GuardianError::Unavailable("job accounting value is oversized".into())
                })?,
                None,
            )
        }
        .map_err(windows_unavailable)?;
        Ok(accounting.ActiveProcesses)
    }

    pub fn terminate(&self) -> Result<(), GuardianError> {
        // SAFETY: the owned handle is a live Job Object with terminate rights.
        unsafe { TerminateJobObject(as_win_handle(&self.handle), 1) }.map_err(windows_unavailable)
    }

    /// Assigns an already-created, still-suspended process to this job and derives its
    /// PID/creation-time identity from the same kernel handle. The returned identity therefore
    /// cannot name an unrelated or PID-reused process.
    pub(crate) fn assign_suspended_process(
        &self,
        process: BorrowedHandle<'_>,
        pid: u32,
    ) -> Result<ProcessIdentity, GuardianError> {
        let process_handle = HANDLE(process.as_raw_handle());
        // SAFETY: `process` is a live borrowed process handle. The caller keeps its primary
        // thread suspended until this method returns, so provider code cannot race admission.
        unsafe { AssignProcessToJobObject(as_win_handle(&self.handle), process_handle) }
            .map_err(windows_unavailable)?;
        let mut member = false.into();
        // SAFETY: both handles are live for the call and `member` is valid writable storage.
        unsafe {
            IsProcessInJob(
                process_handle,
                Some(as_win_handle(&self.handle)),
                &raw mut member,
            )
        }
        .map_err(windows_unavailable)?;
        if !member.as_bool() {
            return Err(GuardianError::ObjectMismatch);
        }
        process_identity_from_handle(process, pid)
    }

    pub(crate) fn identify_member_process(
        &self,
        expected: ProcessIdentity,
    ) -> Result<ProcessIdentity, GuardianError> {
        let pid = expected.pid();
        if pid == 0 {
            return Err(GuardianError::InvalidIdentity);
        }
        // SAFETY: OpenProcess performs all PID validation. The non-inheritable handle has only
        // the query right needed for creation-time identity and job-membership verification.
        let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }
            .map_err(windows_unavailable)?;
        // SAFETY: OpenProcess returned a newly owned valid process handle.
        let process = unsafe { OwnedHandle::from_raw_handle(raw.0) };
        let mut member = false.into();
        // SAFETY: both handles are live and `member` is writable for the duration of the call.
        unsafe {
            IsProcessInJob(
                as_win_handle(&process),
                Some(as_win_handle(&self.handle)),
                &raw mut member,
            )
        }
        .map_err(windows_unavailable)?;
        if !member.as_bool() {
            return Err(GuardianError::ObjectMismatch);
        }
        let observed = process_identity(&process, pid)?;
        if observed != expected {
            return Err(GuardianError::ObjectMismatch);
        }
        Ok(observed)
    }

    pub fn spawn_hidden_suspended_then_assign(
        &self,
        program: &Path,
        args: &[&str],
    ) -> Result<GuardedChild, GuardianError> {
        if !program.is_absolute() {
            return Err(GuardianError::Unavailable(
                "guarded process executable must be absolute".into(),
            ));
        }
        let application = wide_null(program.as_os_str());
        let mut command_line = command_line(program.as_os_str(), args)?;
        let startup = STARTUPINFOW {
            cb: u32::try_from(std::mem::size_of::<STARTUPINFOW>()).map_err(|_| {
                GuardianError::Unavailable("startup information is oversized".into())
            })?,
            ..Default::default()
        };
        let mut information = PROCESS_INFORMATION::default();
        // SAFETY: all pointers reference initialized storage valid through the call; the mutable
        // command line is NUL terminated as required by CreateProcessW. No handles are inherited.
        unsafe {
            CreateProcessW(
                PCWSTR(application.as_ptr()),
                Some(PWSTR(command_line.as_mut_ptr())),
                None,
                None,
                false,
                CREATE_NO_WINDOW | CREATE_SUSPENDED,
                None,
                PCWSTR::null(),
                &raw const startup,
                &raw mut information,
            )
        }
        .map_err(windows_unavailable)?;

        // SAFETY: CreateProcessW returned distinct owned process and primary-thread handles.
        let process = unsafe { OwnedHandle::from_raw_handle(information.hProcess.0) };
        // SAFETY: same as above; ownership is transferred exactly once.
        let thread = unsafe { OwnedHandle::from_raw_handle(information.hThread.0) };

        // SAFETY: both handles are live; the primary thread is suspended, so no provider code can
        // execute before the process is admitted to the guardian-owned Job Object.
        if let Err(error) = unsafe {
            AssignProcessToJobObject(as_win_handle(&self.handle), as_win_handle(&process))
        } {
            terminate_process_and_wait(&process);
            return Err(windows_unavailable(error));
        }
        let identity = match process_identity(&process, information.dwProcessId) {
            Ok(identity) => identity,
            Err(error) => {
                terminate_process_and_wait(&process);
                return Err(error);
            }
        };
        // SAFETY: `thread` is the still-suspended primary thread returned by CreateProcessW.
        if unsafe { ResumeThread(as_win_handle(&thread)) } == u32::MAX {
            terminate_process_and_wait(&process);
            return Err(windows_unavailable(windows::core::Error::from_thread()));
        }

        Ok(GuardedChild {
            process,
            thread,
            identity,
        })
    }
}

#[derive(Debug)]
pub struct GuardedChild {
    process: OwnedHandle,
    #[allow(dead_code)]
    thread: OwnedHandle,
    identity: ProcessIdentity,
}

impl GuardedChild {
    pub const fn identity(&self) -> ProcessIdentity {
        self.identity
    }

    pub fn wait(&self, timeout: Duration) -> Result<(), GuardianError> {
        let milliseconds = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX - 1);
        // SAFETY: the owned process handle is live for the duration of the wait.
        match unsafe { WaitForSingleObject(as_win_handle(&self.process), milliseconds) } {
            WAIT_OBJECT_0 => Ok(()),
            WAIT_TIMEOUT => Err(GuardianError::QuiescencePending),
            _ => Err(windows_unavailable(windows::core::Error::from_thread())),
        }
    }
}

impl Drop for GuardedChild {
    fn drop(&mut self) {
        // SAFETY: the owned process handle remains live during Drop. A zero-duration wait does not
        // mutate caller memory. If it is still running, deterministic cleanup terminates it.
        if unsafe { WaitForSingleObject(as_win_handle(&self.process), 0) } == WAIT_TIMEOUT {
            terminate_process_and_wait(&self.process);
        }
    }
}

fn process_identity(process: &OwnedHandle, pid: u32) -> Result<ProcessIdentity, GuardianError> {
    // SAFETY: the owned process handle remains live for the duration of this borrow.
    let borrowed = unsafe { BorrowedHandle::borrow_raw(process.as_raw_handle()) };
    process_identity_from_handle(borrowed, pid)
}

pub(crate) fn process_identity_from_handle(
    process: BorrowedHandle<'_>,
    pid: u32,
) -> Result<ProcessIdentity, GuardianError> {
    let mut created = FILETIME::default();
    let mut exited = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    // SAFETY: every output pointer targets a live initialized FILETIME and the process handle has
    // query rights from CreateProcessW.
    unsafe {
        GetProcessTimes(
            HANDLE(process.as_raw_handle()),
            &raw mut created,
            &raw mut exited,
            &raw mut kernel,
            &raw mut user,
        )
    }
    .map_err(windows_unavailable)?;
    let birth_time_100ns =
        (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
    ProcessIdentity::new(pid, birth_time_100ns)
}

pub(crate) fn current_process_identity() -> Result<ProcessIdentity, GuardianError> {
    // SAFETY: GetCurrentProcess returns the documented always-valid pseudo handle for this
    // process. It is borrowed only for the synchronous creation-time query and must not be closed.
    let raw = unsafe { GetCurrentProcess() };
    // SAFETY: the pseudo handle is valid for the lifetime of the current process.
    let borrowed = unsafe { BorrowedHandle::borrow_raw(raw.0) };
    // SAFETY: GetCurrentProcessId has no memory-safety preconditions.
    process_identity_from_handle(borrowed, unsafe { GetCurrentProcessId() })
}

fn terminate_process_and_wait(process: &OwnedHandle) {
    // SAFETY: best-effort cleanup uses a live process handle returned by CreateProcessW. Failures
    // are deliberately ignored only after the primary operation already failed.
    let _ = unsafe { TerminateProcess(as_win_handle(process), 1) };
    // SAFETY: the handle remains live, and the bounded wait has no memory-safety preconditions.
    let _ = unsafe { WaitForSingleObject(as_win_handle(process), 5_000) };
}

fn as_win_handle(handle: &OwnedHandle) -> HANDLE {
    HANDLE(handle.as_raw_handle())
}

fn wide_null(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}

fn command_line(program: &OsStr, args: &[&str]) -> Result<Vec<u16>, GuardianError> {
    let mut command = quote_argument(&program.to_string_lossy());
    for argument in args {
        if argument.contains('\0') {
            return Err(GuardianError::InvalidIdentity);
        }
        command.push(' ');
        command.push_str(&quote_argument(argument));
    }
    Ok(OsStr::new(&command)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect())
}

fn quote_argument(argument: &str) -> String {
    if !argument.is_empty()
        && !argument
            .chars()
            .any(|character| character.is_whitespace() || character == '"')
    {
        return argument.into();
    }
    let mut quoted = String::from("\"");
    let mut backslashes = 0_usize;
    for character in argument.chars() {
        if character == '\\' {
            backslashes += 1;
        } else if character == '"' {
            quoted.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
            quoted.push('"');
            backslashes = 0;
        } else {
            quoted.extend(std::iter::repeat_n('\\', backslashes));
            backslashes = 0;
            quoted.push(character);
        }
    }
    quoted.extend(std::iter::repeat_n('\\', backslashes * 2));
    quoted.push('"');
    quoted
}

fn windows_unavailable(error: windows::core::Error) -> GuardianError {
    GuardianError::Unavailable(error.to_string())
}

fn io_unavailable(error: std::io::Error) -> GuardianError {
    GuardianError::Unavailable(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const JOB_OBJECT_SET_ATTRIBUTES: u32 = 0x0002;

    #[test]
    fn boot_identifier_query_returns_a_nonzero_kernel_guid() {
        let identifier = current_boot_identifier().expect("kernel boot identifier");
        assert_eq!(identifier.len(), 32);
        assert!(identifier.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert!(identifier.bytes().any(|byte| byte != b'0'));
    }

    #[test]
    fn recovery_fence_prevents_lock_file_replacement() {
        let temp = tempfile::tempdir().expect("temp");
        let root = temp.path().join("markers");
        std::fs::create_dir(&root).expect("marker root");
        let _first = RecoveryLock::acquire(&root, RecoveryLockRole::DesktopEpoch)
            .expect("first desktop fence");

        let original = root.join("desktop-epoch.v1.lock");
        let displaced = root.join("desktop-epoch.v1.lock.old");
        assert!(
            std::fs::rename(&original, &displaced).is_err(),
            "a live recovery lock file must not be renameable out of its anchored namespace"
        );
        assert!(
            RecoveryLock::acquire(&root, RecoveryLockRole::DesktopEpoch).is_err(),
            "a second desktop epoch must never acquire a replacement lock file"
        );
    }

    #[test]
    fn recovery_fence_prevents_marker_root_replacement() {
        let temp = tempfile::tempdir().expect("temp");
        let root = temp.path().join("markers");
        let displaced = temp.path().join("markers.old");
        std::fs::create_dir(&root).expect("marker root");
        let _first = RecoveryLock::acquire(&root, RecoveryLockRole::DesktopEpoch)
            .expect("first desktop fence");

        assert!(
            std::fs::rename(&root, &displaced).is_err(),
            "a live anchored marker root must not be renameable"
        );
        assert!(
            RecoveryLock::acquire(&root, RecoveryLockRole::DesktopEpoch).is_err(),
            "a second desktop epoch must never acquire a recreated marker root"
        );
    }

    #[test]
    fn provider_peer_cannot_reopen_guardian_job_with_mutating_rights() {
        let name = format!(
            "Local\\KalCode.ProviderGuardian.Test.{}",
            uuid::Uuid::new_v4()
        );
        let _job = WindowsJob::create(&name).expect("guardian job");
        let wide = wide_null(OsStr::new(&name));
        // SAFETY: `wide` is a live NUL-terminated name for the duration of this call.
        let reopened = unsafe {
            OpenJobObjectW(
                JOB_OBJECT_SET_ATTRIBUTES | JOB_OBJECT_TERMINATE,
                false,
                PCWSTR(wide.as_ptr()),
            )
        };
        assert!(
            reopened.is_err(),
            "a same-token provider peer must not obtain job mutation or termination rights"
        );
    }
}
