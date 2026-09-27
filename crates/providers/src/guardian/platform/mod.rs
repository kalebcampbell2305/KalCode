#[cfg(target_os = "macos")]
mod macos;
#[cfg(not(windows))]
#[cfg_attr(target_os = "macos", allow(dead_code))]
mod unsupported;
#[cfg(windows)]
mod windows;

#[cfg(target_os = "macos")]
pub use macos::recovery_root_identity;
#[cfg(target_os = "macos")]
pub(crate) use macos::{
    AnchoredDirectory, RecoveryLock, RecoveryLockRole, current_boot_identifier,
    current_process_identity, exact_process_exited, process_info,
};
#[cfg(all(not(windows), not(target_os = "macos")))]
pub use unsupported::recovery_root_identity;
#[cfg(all(not(windows), not(target_os = "macos")))]
pub(crate) use unsupported::{
    AnchoredDirectory, RecoveryLock, RecoveryLockRole, current_boot_identifier,
    current_process_identity, exact_process_exited,
};
#[cfg(not(windows))]
pub use unsupported::{GuardedChild, WindowsJob};
#[cfg(windows)]
pub use windows::recovery_root_identity;
#[cfg(windows)]
pub(crate) use windows::{
    AnchoredDirectory, RecoveryLock, RecoveryLockRole, current_boot_identifier,
    current_process_identity, exact_process_exited, process_identity_from_handle,
};
#[cfg(windows)]
pub use windows::{GuardedChild, WindowsJob};
