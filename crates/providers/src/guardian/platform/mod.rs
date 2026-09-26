#[cfg(not(windows))]
mod unsupported;
#[cfg(windows)]
mod windows;

#[cfg(not(windows))]
pub use unsupported::recovery_root_identity;
#[cfg(not(windows))]
pub(crate) use unsupported::{
    AnchoredDirectory, RecoveryLock, RecoveryLockRole, current_boot_identifier,
    current_process_identity,
};
#[cfg(not(windows))]
pub use unsupported::{GuardedChild, WindowsJob};
#[cfg(windows)]
pub use windows::recovery_root_identity;
#[cfg(windows)]
pub(crate) use windows::{
    AnchoredDirectory, RecoveryLock, RecoveryLockRole, current_boot_identifier,
    current_process_identity, process_identity_from_handle,
};
#[cfg(windows)]
pub use windows::{GuardedChild, WindowsJob};
