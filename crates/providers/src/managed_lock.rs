#![cfg(windows)]
#![allow(unsafe_code)]

//! Windows namespace authority for managed-profile lease files.
//!
//! The directory handle and lock-file handle both deny delete sharing and remain owned by the
//! lease. The lock is opened relative to that exact directory handle, so a concurrent rename,
//! replacement, or reparse substitution cannot split one account across different lock files.

use std::ffi::{OsStr, c_void};
use std::fs::{File, OpenOptions};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::Path;

use windows::Win32::Foundation::HANDLE;
use windows::Win32::Storage::FileSystem::{BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle};

const SYNCHRONIZE: u32 = 0x0010_0000;
const FILE_ATTRIBUTE_NORMAL_RAW: u32 = 0x0000_0080;
const FILE_ATTRIBUTE_REPARSE_POINT_RAW: u32 = 0x0000_0400;
const FILE_FLAG_OPEN_REPARSE_POINT_RAW: u32 = 0x0020_0000;
const FILE_FLAG_BACKUP_SEMANTICS_RAW: u32 = 0x0200_0000;
const FILE_READ_DATA_RAW: u32 = 0x0000_0001;
const FILE_WRITE_DATA_RAW: u32 = 0x0000_0002;
const FILE_READ_ATTRIBUTES_RAW: u32 = 0x0000_0080;
const FILE_WRITE_ATTRIBUTES_RAW: u32 = 0x0000_0100;
const FILE_SHARE_READ_WRITE_RAW: u32 = 0x0000_0003;
const FILE_OPEN_IF_RAW: u32 = 0x0000_0003;
const FILE_NON_DIRECTORY_FILE_RAW: u32 = 0x0000_0040;
const FILE_SYNCHRONOUS_IO_NONALERT_RAW: u32 = 0x0000_0020;
const FILE_OPEN_REPARSE_POINT_RAW: u32 = 0x0020_0000;
const OBJ_CASE_INSENSITIVE_RAW: u32 = 0x0000_0040;

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

/// Owns both objects that define one managed account's lock namespace.
#[derive(Debug)]
pub(super) struct ManagedProfileLock {
    file: File,
    // Keep the exact parent object live after the relative open. Denying delete sharing prevents
    // the directory itself from being renamed or displaced until the profile lease is dropped.
    _directory: File,
}

impl ManagedProfileLock {
    pub(super) fn open(parent: &Path, name: &OsStr) -> std::io::Result<Self> {
        let directory = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ_WRITE_RAW)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS_RAW | FILE_FLAG_OPEN_REPARSE_POINT_RAW)
            .open(parent)?;
        let metadata = directory.metadata()?;
        let directory_info = file_information(&directory)?;
        if !metadata.is_dir()
            || directory_info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT_RAW != 0
        {
            return Err(invalid_namespace(
                "managed profile lock parent is not an ordinary directory",
            ));
        }

        let file = open_relative_lock(&directory, name)?;
        let metadata = file.metadata()?;
        let file_info = file_information(&file)?;
        if !metadata.is_file()
            || file_info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT_RAW != 0
            || file_info.nNumberOfLinks != 1
        {
            return Err(invalid_namespace(
                "managed profile lock is reparse-backed or multiply linked",
            ));
        }

        Ok(Self {
            file,
            _directory: directory,
        })
    }

    pub(super) const fn file(&self) -> &File {
        &self.file
    }
}

fn open_relative_lock(directory: &File, name: &OsStr) -> std::io::Result<File> {
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
        return Err(invalid_namespace("managed profile lock name is invalid"));
    }
    let byte_length = wide
        .len()
        .checked_mul(std::mem::size_of::<u16>())
        .and_then(|length| u16::try_from(length).ok())
        .ok_or_else(|| invalid_namespace("managed profile lock name is oversized"))?;
    let mut unicode = NtUnicodeString {
        length: byte_length,
        maximum_length: byte_length,
        buffer: wide.as_mut_ptr(),
    };
    let mut attributes = NtObjectAttributes {
        length: u32::try_from(std::mem::size_of::<NtObjectAttributes>())
            .map_err(|_| invalid_namespace("managed profile lock attributes are oversized"))?,
        root_directory: directory.as_raw_handle(),
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
    // SAFETY: every pointer refers to initialized storage for the duration of the call. The root
    // is the retained ordinary-directory handle, and the relative name contains no separator,
    // stream, or NUL component.
    let status = unsafe {
        NtCreateFile(
            &raw mut raw,
            FILE_READ_DATA_RAW
                | FILE_WRITE_DATA_RAW
                | FILE_READ_ATTRIBUTES_RAW
                | FILE_WRITE_ATTRIBUTES_RAW
                | SYNCHRONIZE,
            &raw mut attributes,
            &raw mut io,
            std::ptr::null_mut(),
            FILE_ATTRIBUTE_NORMAL_RAW,
            FILE_SHARE_READ_WRITE_RAW,
            FILE_OPEN_IF_RAW,
            FILE_NON_DIRECTORY_FILE_RAW
                | FILE_SYNCHRONOUS_IO_NONALERT_RAW
                | FILE_OPEN_REPARSE_POINT_RAW,
            std::ptr::null_mut(),
            0,
        )
    };
    if status < 0 {
        // SAFETY: this conversion has no memory preconditions and accepts the failed NTSTATUS.
        let code = unsafe { RtlNtStatusToDosError(status) };
        return Err(std::io::Error::from_raw_os_error(
            i32::try_from(code).unwrap_or(i32::MAX),
        ));
    }
    if raw.is_null() {
        return Err(invalid_namespace(
            "managed profile relative lock open returned no handle",
        ));
    }
    // SAFETY: NtCreateFile returned one newly owned kernel file handle.
    Ok(unsafe { File::from_raw_handle(raw) })
}

fn file_information(file: &File) -> std::io::Result<BY_HANDLE_FILE_INFORMATION> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: `file` owns a live handle and `info` is writable storage of the requested shape.
    unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &raw mut info) }
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    Ok(info)
}

fn invalid_namespace(message: &'static str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, message)
}
