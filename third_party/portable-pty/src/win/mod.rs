use crate::{Child, ChildKiller, ExitStatus};
use anyhow::Context as _;
use std::io::{Error as IoError, Result as IoResult};
use std::os::windows::io::AsRawHandle;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::task::{Context, Poll};
use winapi::shared::minwindef::DWORD;
use winapi::shared::winerror::WAIT_TIMEOUT;
use winapi::um::processthreadsapi::*;
use winapi::um::synchapi::WaitForSingleObject;
use winapi::um::winbase::{INFINITE, WAIT_FAILED, WAIT_OBJECT_0};

pub mod conpty;
mod job;
mod procthreadattr;
mod psuedocon;

use filedescriptor::OwnedHandle;

#[derive(Debug)]
pub struct WinChild {
    proc: Mutex<OwnedHandle>,
    job: Arc<job::ProcessTreeJob>,
}

impl WinChild {
    fn clone_process_handle(&self) -> IoResult<OwnedHandle> {
        lock(&self.proc)
            .try_clone()
            .map_err(|error| IoError::other(error.to_string()))
    }

    fn is_complete(&mut self) -> IoResult<Option<ExitStatus>> {
        let proc = self.clone_process_handle()?;
        let wait = unsafe { WaitForSingleObject(proc.as_raw_handle() as _, 0) };
        if wait == WAIT_TIMEOUT {
            return Ok(None);
        }
        if wait == WAIT_FAILED {
            return Err(IoError::last_os_error());
        }
        if wait != WAIT_OBJECT_0 {
            return Err(IoError::other("unexpected process wait result"));
        }
        let mut status: DWORD = 0;
        let res = unsafe { GetExitCodeProcess(proc.as_raw_handle() as _, &mut status) };
        if res != 0 {
            self.job.terminate_and_wait()?;
            Ok(Some(ExitStatus::with_exit_code(status)))
        } else {
            Err(IoError::last_os_error())
        }
    }

    fn do_kill(&mut self) -> IoResult<()> {
        self.job.terminate_and_wait()
    }
}

impl ChildKiller for WinChild {
    fn kill(&mut self) -> IoResult<()> {
        self.do_kill()
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(WinChildKiller {
            job: Arc::clone(&self.job),
        })
    }
}

#[derive(Debug)]
pub struct WinChildKiller {
    job: Arc<job::ProcessTreeJob>,
}

impl ChildKiller for WinChildKiller {
    fn kill(&mut self) -> IoResult<()> {
        self.job.terminate_and_wait()
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(WinChildKiller {
            job: Arc::clone(&self.job),
        })
    }
}

impl Child for WinChild {
    fn try_wait(&mut self) -> IoResult<Option<ExitStatus>> {
        self.is_complete()
    }

    fn wait(&mut self) -> IoResult<ExitStatus> {
        if let Some(status) = self.try_wait()? {
            return Ok(status);
        }
        let proc = self.clone_process_handle()?;
        let waited = unsafe { WaitForSingleObject(proc.as_raw_handle() as _, INFINITE) };
        if waited == WAIT_FAILED {
            return Err(IoError::last_os_error());
        }
        if waited != WAIT_OBJECT_0 {
            return Err(IoError::other("unexpected process wait result"));
        }
        let mut status: DWORD = 0;
        let res = unsafe { GetExitCodeProcess(proc.as_raw_handle() as _, &mut status) };
        if res != 0 {
            self.job.terminate_and_wait()?;
            Ok(ExitStatus::with_exit_code(status))
        } else {
            Err(IoError::last_os_error())
        }
    }

    fn process_id(&self) -> Option<u32> {
        let res = unsafe { GetProcessId(lock(&self.proc).as_raw_handle() as _) };
        if res == 0 {
            None
        } else {
            Some(res)
        }
    }

    fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
        let proc = lock(&self.proc);
        Some(proc.as_raw_handle())
    }

    fn process_birth_time_100ns(&self) -> IoResult<u64> {
        let proc = lock(&self.proc);
        let mut created = unsafe { std::mem::zeroed() };
        let mut exited = unsafe { std::mem::zeroed() };
        let mut kernel = unsafe { std::mem::zeroed() };
        let mut user = unsafe { std::mem::zeroed() };
        let result = unsafe {
            GetProcessTimes(
                proc.as_raw_handle() as _,
                &mut created,
                &mut exited,
                &mut kernel,
                &mut user,
            )
        };
        if result == 0 {
            return Err(IoError::last_os_error());
        }
        Ok((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
    }
}

impl std::future::Future for WinChild {
    type Output = anyhow::Result<ExitStatus>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context) -> Poll<anyhow::Result<ExitStatus>> {
        match self.is_complete() {
            Ok(Some(status)) => Poll::Ready(Ok(status)),
            Err(err) => Poll::Ready(Err(err).context("Failed to retrieve process exit status")),
            Ok(None) => {
                let proc = match self.clone_process_handle() {
                    Ok(proc) => proc,
                    Err(error) => {
                        return Poll::Ready(Err(error).context("Failed to clone process handle"));
                    }
                };
                let waker = cx.waker().clone();
                std::thread::spawn(move || {
                    unsafe {
                        WaitForSingleObject(proc.as_raw_handle() as _, INFINITE);
                    }
                    waker.wake();
                });
                Poll::Pending
            }
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
