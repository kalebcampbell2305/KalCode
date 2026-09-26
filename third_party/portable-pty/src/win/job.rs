use filedescriptor::OwnedHandle;
use std::io::{Error as IoError, ErrorKind, Result as IoResult};
use std::mem;
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::ptr;
use std::thread;
use std::time::{Duration, Instant};
use winapi::um::handleapi::INVALID_HANDLE_VALUE;
use winapi::um::jobapi2::{
    AssignProcessToJobObject, CreateJobObjectW, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject,
};
use winapi::um::winnt::{
    HANDLE, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectBasicAccountingInformation,
    JobObjectExtendedLimitInformation,
};

const QUIESCENCE_TIMEOUT: Duration = Duration::from_secs(5);
const QUIESCENCE_POLL: Duration = Duration::from_millis(10);
/// A private, non-breakaway Job Object for one pseudo-terminal process tree.
///
/// Guarded creation first assigns the root to the external generation job atomically, then attaches
/// this local kill/wait job immediately after `CreateProcessW`. Unguarded compatibility launches
/// attach only this job. Children inherit membership because this job deliberately enables neither
/// Windows breakaway limit.
#[derive(Debug)]
pub struct ProcessTreeJob {
    handle: OwnedHandle,
}

impl ProcessTreeJob {
    pub fn new() -> IoResult<Self> {
        let raw = unsafe { CreateJobObjectW(ptr::null_mut(), ptr::null()) };
        if raw.is_null() || raw == INVALID_HANDLE_VALUE {
            return Err(IoError::last_os_error());
        }
        let handle = unsafe { OwnedHandle::from_raw_handle(raw as _) };
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle.as_raw_handle() as HANDLE,
                JobObjectExtendedLimitInformation,
                &mut limits as *mut _ as *mut _,
                mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            return Err(IoError::last_os_error());
        }
        Ok(Self { handle })
    }

    pub fn raw_handle(&self) -> HANDLE {
        self.handle.as_raw_handle() as HANDLE
    }

    pub fn assign_process(&self, process: HANDLE) -> IoResult<()> {
        let assigned = unsafe { AssignProcessToJobObject(self.raw_handle(), process) };
        if assigned == 0 {
            return Err(IoError::last_os_error());
        }
        Ok(())
    }

    pub fn terminate_and_wait(&self) -> IoResult<()> {
        if self.active_processes()? == 0 {
            return Ok(());
        }
        let terminated = unsafe { TerminateJobObject(self.raw_handle(), 1) };
        if terminated == 0 && self.active_processes()? != 0 {
            return Err(IoError::last_os_error());
        }
        self.wait_for_empty(QUIESCENCE_TIMEOUT)
    }

    fn wait_for_empty(&self, timeout: Duration) -> IoResult<()> {
        let deadline = Instant::now() + timeout;
        loop {
            if self.active_processes()? == 0 {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(IoError::new(
                    ErrorKind::TimedOut,
                    "pseudo-terminal process tree did not quiesce",
                ));
            }
            thread::sleep(QUIESCENCE_POLL);
        }
    }

    fn active_processes(&self) -> IoResult<u32> {
        let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { mem::zeroed() };
        let queried = unsafe {
            QueryInformationJobObject(
                self.raw_handle(),
                JobObjectBasicAccountingInformation,
                &mut accounting as *mut _ as *mut _,
                mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                ptr::null_mut(),
            )
        };
        if queried == 0 {
            return Err(IoError::last_os_error());
        }
        Ok(accounting.ActiveProcesses)
    }
}
