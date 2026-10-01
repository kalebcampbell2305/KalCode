//! The apply lease marks a staged same-version build that is being installed after KalCode
//! closed. KalCode opens the lease, passes it to the installer (Windows) or update helper (macOS)
//! it launches on exit, and exits. That process holds it for exactly as long as it runs, so a
//! KalCode launched meanwhile can tell that its own replacement is still being applied.

use std::fs::File;
#[cfg(any(windows, target_os = "macos"))]
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

use kalcode_updater::UpdateError;

pub(super) const LEASE_FILE: &str = "apply.lock";

/// The open lease. Dropping it after the hand-off is safe: the launched process keeps its own
/// inherited copy until it exits.
pub(super) struct ApplyLease(File);

impl ApplyLease {
    /// Takes the lease and records `from_version`, the build being replaced.
    pub(super) fn acquire(path: &Path, from_version: &str) -> Result<Self, UpdateError> {
        let mut file = open_holder(path)?;
        file.set_len(0).map_err(|_| lease_failed())?;
        file.write_all(format!("{from_version}\n").as_bytes())
            .map_err(|_| lease_failed())?;
        file.sync_all().map_err(|_| lease_failed())?;
        Ok(Self(file))
    }

    /// Lets the process `command` starts inherit the lease.
    ///
    /// Windows marks the handle inheritable, which `std` passes to every child created after
    /// this call. It is called on exit, after the runtime drain, immediately before the one
    /// installer launch, so no other child is started in between.
    #[cfg(windows)]
    #[allow(unsafe_code)]
    pub(super) fn pass_to(&self, _command: &mut Command) -> Result<(), UpdateError> {
        use std::os::windows::io::AsRawHandle as _;
        use windows_sys::Win32::Foundation::{HANDLE_FLAG_INHERIT, SetHandleInformation};

        // SAFETY: the handle is owned by `self.0`, which outlives the call; only its inherit
        // flag changes.
        let changed = unsafe {
            SetHandleInformation(
                self.0.as_raw_handle(),
                HANDLE_FLAG_INHERIT,
                HANDLE_FLAG_INHERIT,
            )
        };
        if changed == 0 {
            return Err(lease_failed());
        }
        Ok(())
    }

    /// Clears close-on-exec on the lease only in `command`'s child, so only that child (and
    /// never an unrelated process) inherits the lock.
    #[cfg(target_os = "macos")]
    #[allow(unsafe_code)]
    pub(super) fn pass_to(&self, command: &mut Command) -> Result<(), UpdateError> {
        use std::os::unix::io::AsRawFd as _;
        use std::os::unix::process::CommandExt as _;

        let descriptor = self.0.as_raw_fd();
        // SAFETY: the closure performs only async-signal-safe `fcntl` calls on a descriptor that
        // `self` keeps open until the spawn completes.
        unsafe {
            command.pre_exec(move || {
                let flags = libc::fcntl(descriptor, libc::F_GETFD);
                if flags < 0
                    || libc::fcntl(descriptor, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        Ok(())
    }

    /// No other platform installs updates.
    #[cfg(not(any(windows, target_os = "macos")))]
    pub(super) fn pass_to(&self, _command: &mut Command) -> Result<(), UpdateError> {
        Err(lease_failed())
    }
}

/// The build that a still-running installer or helper is replacing, or `None` when no process
/// holds the lease.
pub(super) fn applying_from(path: &Path) -> Option<String> {
    let mut held = open_if_held(path)?;
    let mut recorded = String::new();
    Read::by_ref(&mut held)
        .take(256)
        .read_to_string(&mut recorded)
        .ok()?;
    Some(recorded.trim().to_owned())
}

/// Whether a starting build must step aside: the running installer or helper is replacing
/// exactly this build, so it must neither run nor record the update's result (the installer
/// would kill it or fail to replace its files; the helper would swap the bundle under it).
pub(super) fn superseded_while_applying(
    applying_from: Option<&str>,
    current_version: &str,
) -> bool {
    applying_from.is_some_and(|from| from == current_version)
}

/// A launch that stepped aside leaves this marker. The installer (Windows, `NSIS_HOOK_POSTINSTALL`
/// in `windows/installer-hooks.nsh`) or the helper (macOS) opens the new build when it finishes.
pub(super) fn reopen_marker(update_dir: &Path) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let _ = update_dir;
        // The installer knows only its install directory, which holds this executable.
        std::env::current_exe()
            .ok()?
            .parent()
            .map(|install_dir| install_dir.join("kalcode-reopen-after-update"))
    }
    #[cfg(target_os = "macos")]
    {
        Some(update_dir.join(kalcode_updater::mac_swap::REOPEN_MARKER))
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = update_dir;
        None
    }
}

#[cfg(windows)]
fn open_holder(path: &Path) -> Result<File, UpdateError> {
    use std::os::windows::fs::OpenOptionsExt as _;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    // Holders share everything, so a stale inherited handle can never block a new hand-off. Only
    // the probe asks for exclusive access, which any open holder denies.
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .open(path)
        .map_err(|_| lease_failed())
}

#[cfg(windows)]
fn open_if_held(path: &Path) -> Option<File> {
    use std::os::windows::fs::OpenOptionsExt as _;
    use windows_sys::Win32::Foundation::ERROR_SHARING_VIOLATION;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    match OpenOptions::new().read(true).share_mode(0).open(path) {
        Ok(_) => None,
        Err(error) if error.raw_os_error() == Some(ERROR_SHARING_VIOLATION as i32) => {
            OpenOptions::new()
                .read(true)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
                .open(path)
                .ok()
        }
        Err(_) => None,
    }
}

#[cfg(target_os = "macos")]
fn open_holder(path: &Path) -> Result<File, UpdateError> {
    use std::os::unix::fs::OpenOptionsExt as _;

    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| lease_failed())?;
    if lock_nonblocking(&file) == Some(true) {
        Ok(file)
    } else {
        Err(lease_failed())
    }
}

#[cfg(target_os = "macos")]
fn open_if_held(path: &Path) -> Option<File> {
    use std::os::unix::fs::OpenOptionsExt as _;

    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .ok()?;
    // Closing `file` releases a lock this probe took.
    (lock_nonblocking(&file) == Some(false)).then_some(file)
}

/// `Some(true)` when this descriptor took the exclusive lock, `Some(false)` when another holds
/// it, `None` on any other error.
#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
fn lock_nonblocking(file: &File) -> Option<bool> {
    use std::os::unix::io::AsRawFd as _;

    // SAFETY: `file` owns a live descriptor; `flock` changes only its advisory lock state.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        return Some(true);
    }
    (std::io::Error::last_os_error().raw_os_error() == Some(libc::EWOULDBLOCK)).then_some(false)
}

#[cfg(not(any(windows, target_os = "macos")))]
fn open_holder(_path: &Path) -> Result<File, UpdateError> {
    Err(lease_failed())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn open_if_held(_path: &Path) -> Option<File> {
    None
}

fn lease_failed() -> UpdateError {
    UpdateError::new(
        "update_apply_lease_failed",
        "KalCode couldn't mark the update it is installing.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_build_being_replaced_steps_aside() {
        assert!(superseded_while_applying(Some("0.1.8+5"), "0.1.8+5"));
        // The new build (started once the installer replaced the executable) runs normally.
        assert!(!superseded_while_applying(Some("0.1.8+5"), "0.1.8+6"));
        assert!(!superseded_while_applying(None, "0.1.8+5"));
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn a_lease_is_held_only_while_a_process_keeps_it_open() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(LEASE_FILE);
        assert_eq!(applying_from(&path), None);

        let lease = ApplyLease::acquire(&path, "0.1.8+5").unwrap();
        assert_eq!(applying_from(&path).as_deref(), Some("0.1.8+5"));
        drop(lease);
        assert_eq!(applying_from(&path), None);

        // A later hand-off rewrites the record.
        let lease = ApplyLease::acquire(&path, "0.1.8+6").unwrap();
        assert_eq!(applying_from(&path).as_deref(), Some("0.1.8+6"));
        drop(lease);
    }

    /// The real hand-off: the lease outlives this process's own handle for exactly as long as
    /// the child it was passed to runs.
    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn a_passed_lease_is_held_by_the_child_until_it_exits() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(LEASE_FILE);
        let lease = ApplyLease::acquire(&path, "0.1.8+5").unwrap();
        let mut command = long_running_child();
        lease.pass_to(&mut command).unwrap();
        let mut child = command.spawn().unwrap();
        drop(lease);

        assert_eq!(applying_from(&path).as_deref(), Some("0.1.8+5"));
        child.kill().unwrap();
        child.wait().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while applying_from(&path).is_some() {
            assert!(
                std::time::Instant::now() < deadline,
                "the lease outlived its holder"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }

    #[cfg(windows)]
    fn long_running_child() -> Command {
        let mut command = Command::new("ping");
        command
            .args(["-n", "30", "127.0.0.1"])
            .stdout(std::process::Stdio::null());
        command
    }

    #[cfg(target_os = "macos")]
    fn long_running_child() -> Command {
        let mut command = Command::new("/bin/sleep");
        command.arg("30");
        command
    }
}
