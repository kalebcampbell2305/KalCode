use std::ffi::OsStr;
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use crate::guardian::{GuardianError, ProcessIdentity};

#[derive(Debug)]
pub(crate) struct RecoveryLock;

#[derive(Debug, Clone, Copy)]
pub(crate) enum RecoveryLockRole {
    DesktopEpoch,
    HelperDrain,
}

impl RecoveryLock {
    pub(crate) fn acquire_expected(
        _root: &Path,
        _expected_identity: &str,
        _role: RecoveryLockRole,
    ) -> Result<Self, GuardianError> {
        Err(GuardianError::Unavailable(
            "the provider guardian recovery lock requires Windows".into(),
        ))
    }

    pub(crate) fn acquire_anchored(
        _directory: Arc<AnchoredDirectory>,
        _role: RecoveryLockRole,
    ) -> Result<Self, GuardianError> {
        Err(GuardianError::Unavailable(
            "the provider guardian recovery lock requires Windows".into(),
        ))
    }
}

#[derive(Debug)]
pub(crate) struct AnchoredDirectory {
    root: PathBuf,
    identity: String,
}

impl AnchoredDirectory {
    pub(crate) fn open(path: &Path) -> Result<Self, GuardianError> {
        Ok(Self {
            root: path.to_path_buf(),
            identity: path.to_string_lossy().into_owned(),
        })
    }

    pub(crate) fn identity_token(&self) -> &str {
        &self.identity
    }

    pub(crate) fn open_existing(&self, name: &OsStr) -> Result<Option<File>, GuardianError> {
        match File::open(self.root.join(name)) {
            Ok(file) => Ok(Some(file)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(GuardianError::Unavailable(error.to_string())),
        }
    }

    pub(crate) fn open_or_create(&self, name: &OsStr) -> Result<File, GuardianError> {
        OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.root.join(name))
            .map_err(|error| GuardianError::Unavailable(error.to_string()))
    }
}

pub fn recovery_root_identity(_path: &Path) -> Result<String, GuardianError> {
    Err(GuardianError::Unavailable(
        "the provider guardian requires Windows directory identities".into(),
    ))
}

pub(crate) fn current_boot_identifier() -> Result<String, GuardianError> {
    Err(GuardianError::Unavailable(
        "the provider guardian requires a Windows boot identity".into(),
    ))
}

pub(crate) fn current_process_identity() -> Result<ProcessIdentity, GuardianError> {
    Err(GuardianError::Unavailable(
        "the provider guardian requires Windows process handles".into(),
    ))
}

#[derive(Debug)]
pub struct WindowsJob;

impl WindowsJob {
    /// Rejects a Windows Job Object handle received on an unsupported platform.
    ///
    /// Non-Windows processes cannot validate or own the transferred Windows kernel handle, so the
    /// guardian must fail closed instead of treating the opaque integer as process authority.
    pub fn from_transferred_handle(_value: u64) -> Result<Self, GuardianError> {
        Err(GuardianError::Unavailable(
            "the provider guardian requires Windows Job Objects".into(),
        ))
    }

    pub fn create(_name: &str) -> Result<Self, GuardianError> {
        Err(GuardianError::Unavailable(
            "the provider guardian requires Windows Job Objects".into(),
        ))
    }

    pub fn open(_name: &str) -> Result<Self, GuardianError> {
        Err(GuardianError::Unavailable(
            "the provider guardian requires Windows Job Objects".into(),
        ))
    }

    pub fn active_processes(&self) -> Result<u32, GuardianError> {
        Err(GuardianError::Unavailable(
            "the provider guardian requires Windows Job Objects".into(),
        ))
    }

    pub fn terminate(&self) -> Result<(), GuardianError> {
        Err(GuardianError::Unavailable(
            "the provider guardian requires Windows Job Objects".into(),
        ))
    }

    pub fn spawn_hidden_suspended_then_assign(
        &self,
        _program: &Path,
        _args: &[&str],
    ) -> Result<GuardedChild, GuardianError> {
        Err(GuardianError::Unavailable(
            "the provider guardian requires Windows Job Objects".into(),
        ))
    }
}

#[derive(Debug)]
pub struct GuardedChild;

impl GuardedChild {
    pub fn identity(&self) -> ProcessIdentity {
        unreachable!("Windows-only type cannot be constructed")
    }

    pub fn wait(&self, _timeout: Duration) -> Result<(), GuardianError> {
        Err(GuardianError::Unavailable(
            "the provider guardian requires Windows Job Objects".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transferred_windows_job_handle_is_rejected() {
        let error = WindowsJob::from_transferred_handle(1).expect_err("unsupported transfer");
        assert!(matches!(
            error,
            GuardianError::Unavailable(message)
                if message == "the provider guardian requires Windows Job Objects"
        ));
    }
}
