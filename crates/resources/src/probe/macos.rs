//! macOS kernel memory status, read with `sysctlbyname` (no process is spawned).
//!
//! - `kern.memorystatus_level`: the percentage of memory the kernel considers available (what
//!   `memory_pressure` prints as "System-wide memory free percentage").
//! - `kern.memorystatus_vm_pressure_level`: the kernel's pressure level (1 normal, 2 warning,
//!   4 critical).
//!
//! Either value is `None` when the kernel does not answer; callers then keep the conservative
//! `sysinfo` figure ([`super::reconcile_available_memory`]).

#![allow(unsafe_code)]

use std::ffi::CStr;

fn sysctl_u32(name: &CStr) -> Option<u32> {
    let mut value: libc::c_int = 0;
    let mut length = std::mem::size_of::<libc::c_int>();
    // SAFETY: the name is a valid NUL-terminated string and the output points to writable
    // storage whose size is passed in `length`.
    let result = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            (&mut value as *mut libc::c_int).cast(),
            &mut length,
            std::ptr::null_mut(),
            0,
        )
    };
    if result != 0 || length != std::mem::size_of::<libc::c_int>() {
        return None;
    }
    u32::try_from(value).ok()
}

pub(super) fn memorystatus_level() -> Option<u32> {
    sysctl_u32(c"kern.memorystatus_level").filter(|percent| *percent <= 100)
}

pub(super) fn memorystatus_pressure_level() -> Option<u32> {
    sysctl_u32(c"kern.memorystatus_vm_pressure_level")
}
