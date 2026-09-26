//! Durable rollback authority for signed KalVoice component catalogs.
//!
//! The catalog high-water mark is metadata, but it is security authoritative: losing it could
//! make an older, still-valid catalog acceptable again. The exact floor therefore lives in the
//! current OS user's credential store (Windows Credential Manager or macOS Keychain in
//! production). A nonsecret marker in the trusted app-data tree records that a track has ever
//! been activated, so a missing credential after activation fails closed instead of looking like
//! first use.
//!
//! A hardened file lock serializes every read/transition/write across KalCode processes. The
//! lock wait has an absolute deadline and observes caller cancellation. OS credential operations
//! themselves are synchronous platform calls and are not made falsely cancellable here.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use fs2::FileExt as _;
use kalcode_secure_store::{SecretKey, SecretStore, SecretString};
use serde::{Deserialize, Serialize};

use crate::component_catalog::{
    CatalogFloor, CatalogTransitionError, VerifiedComponentCatalog, advance_catalog_floor,
};
use crate::component_manifest::{ComponentArch, ComponentPlatform};
use crate::component_store::TrustedComponentDirectory;

const STORED_SCHEMA_VERSION: u32 = 1;
const MAX_STORED_FLOOR_BYTES: usize = 4 * 1024;
const LOCK_POLL_INTERVAL: Duration = Duration::from_millis(10);
const LOCK_FILENAME: &str = "authority.lock";
const ACTIVATION_MARKER_FILENAME: &str = "activated-v1";
const ACTIVATION_MARKER: &[u8] = b"kalcode-component-catalog-floor-activated-v1\n";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogFloorTrack {
    channel: String,
    platform: ComponentPlatform,
    arch: ComponentArch,
}

impl CatalogFloorTrack {
    pub fn new(
        channel: impl Into<String>,
        platform: ComponentPlatform,
        arch: ComponentArch,
    ) -> Result<Self, ComponentFloorError> {
        let channel = channel.into();
        if !valid_channel(&channel) {
            return Err(ComponentFloorError::InvalidTrack);
        }
        Ok(Self {
            channel,
            platform,
            arch,
        })
    }

    pub fn channel(&self) -> &str {
        &self.channel
    }

    pub fn platform(&self) -> ComponentPlatform {
        self.platform
    }

    pub fn arch(&self) -> ComponentArch {
        self.arch
    }

    fn matches(&self, floor: &CatalogFloor) -> bool {
        floor.channel() == self.channel
            && floor.platform() == self.platform
            && floor.arch() == self.arch
    }

    fn credential_account(&self) -> String {
        format!(
            "kalvoice:catalog-floor:{}:{}:{}",
            self.channel,
            platform_segment(self.platform),
            arch_segment(self.arch)
        )
    }

    fn target_segment(&self) -> String {
        format!(
            "{}-{}",
            platform_segment(self.platform),
            arch_segment(self.arch)
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ComponentFloorError {
    #[error("the component catalog floor track is invalid")]
    InvalidTrack,
    #[error("component catalog floor access was cancelled")]
    Cancelled,
    #[error("component catalog floor access timed out")]
    LockTimeout,
    #[error("the component catalog floor storage path is unsafe")]
    UnsafeStorage,
    #[error("component catalog floor storage failed: {0:?}")]
    Storage(io::ErrorKind),
    #[error("the operating-system catalog floor store is unavailable")]
    SecureStoreUnavailable,
    #[error("the stored component catalog floor is corrupt")]
    Corrupt,
    #[error("the component catalog floor is missing after activation")]
    MissingAfterActivation,
    #[error("the component catalog floor transition was rejected: {0}")]
    Transition(#[from] CatalogTransitionError),
    #[error("the component catalog floor write could not be verified")]
    ReadbackMismatch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredFloorEnvelope {
    schema_version: u32,
    channel: String,
    platform: ComponentPlatform,
    arch: ComponentArch,
    floor: CatalogFloor,
}

impl StoredFloorEnvelope {
    fn new(track: &CatalogFloorTrack, floor: CatalogFloor) -> Self {
        Self {
            schema_version: STORED_SCHEMA_VERSION,
            channel: track.channel.clone(),
            platform: track.platform,
            arch: track.arch,
            floor,
        }
    }

    fn is_valid_for(&self, track: &CatalogFloorTrack) -> bool {
        self.schema_version == STORED_SCHEMA_VERSION
            && self.channel == track.channel
            && self.platform == track.platform
            && self.arch == track.arch
            && self.floor.is_valid()
            && track.matches(&self.floor)
    }
}

/// Current-user, per-channel and per-target high-water authority.
///
/// `private_app_data` must be the canonical OS-owned application-data capability. This type
/// creates only validated direct children below it. It deliberately offers no reset or delete
/// operation: clearing an activated floor is a separate owner recovery operation, not a normal
/// catalog transition.
#[derive(Clone)]
pub struct ComponentFloorAuthority {
    store: Arc<dyn SecretStore>,
    key: SecretKey,
    track: CatalogFloorTrack,
    lock_directory: TrustedComponentDirectory,
    #[cfg(test)]
    marker_failure: Option<MarkerFailure>,
}

impl std::fmt::Debug for ComponentFloorAuthority {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ComponentFloorAuthority")
            .field("track", &self.track)
            .finish_non_exhaustive()
    }
}

impl ComponentFloorAuthority {
    pub fn new(
        store: Arc<dyn SecretStore>,
        private_app_data: TrustedComponentDirectory,
        track: CatalogFloorTrack,
    ) -> Result<Self, ComponentFloorError> {
        let key = SecretKey::new(track.credential_account())
            .map_err(|_| ComponentFloorError::InvalidTrack)?;
        let lock_directory = private_app_data
            .create_private_child("catalog-floor-locks")
            .and_then(|directory| directory.create_private_child("v1"))
            .and_then(|directory| directory.create_private_child(track.channel()))
            .and_then(|directory| directory.create_private_child(&track.target_segment()))
            .map_err(|_| ComponentFloorError::UnsafeStorage)?;
        Ok(Self {
            store,
            key,
            track,
            lock_directory,
            #[cfg(test)]
            marker_failure: None,
        })
    }

    /// Loads and validates the authoritative floor. Both a missing marker and a missing
    /// credential mean the track has never been activated. Any one-sided absence fails closed.
    pub fn load(
        &self,
        deadline: Instant,
        cancellation: &AtomicBool,
    ) -> Result<Option<CatalogFloor>, ComponentFloorError> {
        let lock = self.acquire_lock(deadline, cancellation)?;
        let result = self.load_locked();
        drop(lock);
        result
    }

    /// Applies the existing pure monotonic policy and persists the resulting exact identity.
    /// The first activation marker is made durable before the credential write, so a crash or
    /// backend failure cannot turn a partially activated track back into apparent first use.
    pub fn advance(
        &self,
        candidate: &VerifiedComponentCatalog,
        now_unix: i64,
        deadline: Instant,
        cancellation: &AtomicBool,
    ) -> Result<CatalogFloor, ComponentFloorError> {
        let lock = self.acquire_lock(deadline, cancellation)?;
        if cancellation.load(Ordering::SeqCst) {
            return Err(ComponentFloorError::Cancelled);
        }
        let current = self.load_locked()?;
        let next = advance_catalog_floor(current.as_ref(), candidate, now_unix)?;
        if !self.track.matches(&next) {
            return Err(ComponentFloorError::Transition(
                CatalogTransitionError::DifferentTrack,
            ));
        }
        if current.as_ref() == Some(&next) {
            return Ok(next);
        }
        if current.is_none() {
            self.create_activation_marker()?;
        }
        self.store_exact(&next)?;
        drop(lock);
        Ok(next)
    }

    fn acquire_lock(
        &self,
        deadline: Instant,
        cancellation: &AtomicBool,
    ) -> Result<FloorLock, ComponentFloorError> {
        let verified = TrustedComponentDirectory::open_existing(self.lock_directory.path())
            .map_err(|_| ComponentFloorError::UnsafeStorage)?;
        if verified.path() != self.lock_directory.path() {
            return Err(ComponentFloorError::UnsafeStorage);
        }
        let path = self.lock_directory.path().join(LOCK_FILENAME);
        let file = open_lock_file(&path)?;
        loop {
            if cancellation.load(Ordering::SeqCst) {
                return Err(ComponentFloorError::Cancelled);
            }
            if Instant::now() >= deadline {
                return Err(ComponentFloorError::LockTimeout);
            }
            match file.try_lock_exclusive() {
                Ok(()) => return Ok(FloorLock(file)),
                Err(error) if lock_conflict(&error) => {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        return Err(ComponentFloorError::LockTimeout);
                    }
                    thread::sleep(LOCK_POLL_INTERVAL.min(remaining));
                }
                Err(error) => return Err(storage(error)),
            }
        }
    }

    fn load_locked(&self) -> Result<Option<CatalogFloor>, ComponentFloorError> {
        let activated = self.activation_marker_exists()?;
        let stored = self
            .store
            .get(&self.key)
            .map_err(|_| ComponentFloorError::SecureStoreUnavailable)?;
        match (activated, stored) {
            (false, None) => Ok(None),
            (true, None) => Err(ComponentFloorError::MissingAfterActivation),
            (false, Some(_)) => Err(ComponentFloorError::Corrupt),
            (true, Some(value)) => self.decode(&value).map(Some),
        }
    }

    fn decode(&self, value: &SecretString) -> Result<CatalogFloor, ComponentFloorError> {
        let encoded = value.expose_secret();
        if encoded.len() > MAX_STORED_FLOOR_BYTES {
            return Err(ComponentFloorError::Corrupt);
        }
        let envelope: StoredFloorEnvelope =
            serde_json::from_str(encoded).map_err(|_| ComponentFloorError::Corrupt)?;
        if !envelope.is_valid_for(&self.track) {
            return Err(ComponentFloorError::Corrupt);
        }
        Ok(envelope.floor)
    }

    fn store_exact(&self, floor: &CatalogFloor) -> Result<(), ComponentFloorError> {
        let envelope = StoredFloorEnvelope::new(&self.track, floor.clone());
        let encoded = serde_json::to_string(&envelope).map_err(|_| ComponentFloorError::Corrupt)?;
        if encoded.len() > MAX_STORED_FLOOR_BYTES {
            return Err(ComponentFloorError::Corrupt);
        }
        let value = SecretString::new(encoded.clone());
        self.store
            .set(&self.key, &value)
            .map_err(|_| ComponentFloorError::SecureStoreUnavailable)?;
        let readback = self
            .store
            .get(&self.key)
            .map_err(|_| ComponentFloorError::SecureStoreUnavailable)?
            .ok_or(ComponentFloorError::ReadbackMismatch)?;
        if readback.expose_secret() != encoded {
            return Err(ComponentFloorError::ReadbackMismatch);
        }
        let decoded = self.decode(&readback)?;
        if &decoded != floor {
            return Err(ComponentFloorError::ReadbackMismatch);
        }
        Ok(())
    }

    fn activation_marker_exists(&self) -> Result<bool, ComponentFloorError> {
        let path = self.lock_directory.path().join(ACTIVATION_MARKER_FILENAME);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(storage(error)),
        };
        if !safe_marker_metadata(&metadata) || metadata.len() != ACTIVATION_MARKER.len() as u64 {
            return Err(ComponentFloorError::Corrupt);
        }
        let file = open_existing_marker(&path)?;
        if !same_open_marker(&path, &file)? {
            return Err(ComponentFloorError::UnsafeStorage);
        }
        let mut bytes = Vec::with_capacity(ACTIVATION_MARKER.len() + 1);
        file.take((ACTIVATION_MARKER.len() + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(storage)?;
        if bytes == ACTIVATION_MARKER {
            Ok(true)
        } else {
            Err(ComponentFloorError::Corrupt)
        }
    }

    fn create_activation_marker(&self) -> Result<(), ComponentFloorError> {
        #[cfg(test)]
        if self.marker_failure == Some(MarkerFailure::Create) {
            return Err(ComponentFloorError::Storage(io::ErrorKind::Other));
        }
        let path = self.lock_directory.path().join(ACTIVATION_MARKER_FILENAME);
        let mut file = match create_marker(&path) {
            Ok(file) => file,
            Err(ComponentFloorError::Storage(io::ErrorKind::AlreadyExists)) => {
                return if self.activation_marker_exists()? {
                    Ok(())
                } else {
                    Err(ComponentFloorError::Corrupt)
                };
            }
            Err(error) => return Err(error),
        };
        #[cfg(test)]
        if self.marker_failure == Some(MarkerFailure::Write) {
            return Err(ComponentFloorError::Storage(io::ErrorKind::Other));
        }
        file.write_all(ACTIVATION_MARKER).map_err(storage)?;
        #[cfg(test)]
        if self.marker_failure == Some(MarkerFailure::Sync) {
            return Err(ComponentFloorError::Storage(io::ErrorKind::Other));
        }
        file.sync_all().map_err(storage)?;
        if !same_open_marker(&path, &file)? {
            return Err(ComponentFloorError::UnsafeStorage);
        }
        sync_directory(self.lock_directory.path())?;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn with_marker_failure(mut self, failure: MarkerFailure) -> Self {
        self.marker_failure = Some(failure);
        self
    }

    #[cfg(test)]
    pub(crate) fn credential_key(&self) -> &SecretKey {
        &self.key
    }

    #[cfg(test)]
    pub(crate) fn marker_path(&self) -> std::path::PathBuf {
        self.lock_directory.path().join(ACTIVATION_MARKER_FILENAME)
    }

    #[cfg(test)]
    pub(crate) fn lock_path(&self) -> std::path::PathBuf {
        self.lock_directory.path().join(LOCK_FILENAME)
    }
}

struct FloorLock(File);

impl Drop for FloorLock {
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&self.0);
    }
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MarkerFailure {
    Create,
    Write,
    Sync,
}

fn valid_channel(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'.' | b'_' | b'+' | b'-')
        })
}

fn platform_segment(platform: ComponentPlatform) -> &'static str {
    match platform {
        ComponentPlatform::Windows => "windows",
        ComponentPlatform::Macos => "macos",
        ComponentPlatform::Linux => "linux",
    }
}

fn arch_segment(arch: ComponentArch) -> &'static str {
    match arch {
        ComponentArch::X86_64 => "x86_64",
        ComponentArch::Aarch64 => "aarch64",
    }
}

fn storage(error: io::Error) -> ComponentFloorError {
    ComponentFloorError::Storage(error.kind())
}

fn lock_conflict(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::WouldBlock
        || (cfg!(windows) && matches!(error.raw_os_error(), Some(32 | 33)))
}

fn open_lock_file(path: &Path) -> Result<File, ComponentFloorError> {
    let file = match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !safe_lock_metadata(&metadata) || metadata.len() != 0 {
                return Err(ComponentFloorError::UnsafeStorage);
            }
            open_existing_lock(path)?
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => match create_lock(path) {
            Ok(file) => file,
            Err(ComponentFloorError::Storage(io::ErrorKind::AlreadyExists)) => {
                open_existing_lock(path)?
            }
            Err(error) => return Err(error),
        },
        Err(error) => return Err(storage(error)),
    };
    if !same_open_lock(path, &file)? {
        return Err(ComponentFloorError::UnsafeStorage);
    }
    Ok(file)
}

#[cfg(unix)]
fn open_existing_lock(path: &Path) -> Result<File, ComponentFloorError> {
    use std::os::unix::fs::OpenOptionsExt as _;

    #[cfg(target_os = "macos")]
    const O_NOFOLLOW: i32 = 0x0000_0100;
    #[cfg(not(target_os = "macos"))]
    const O_NOFOLLOW: i32 = 0x0002_0000;
    OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(O_NOFOLLOW)
        .open(path)
        .map_err(storage)
}

#[cfg(windows)]
fn open_existing_lock(path: &Path) -> Result<File, ComponentFloorError> {
    use std::os::windows::fs::OpenOptionsExt as _;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(storage)
}

#[cfg(unix)]
fn create_lock(path: &Path) -> Result<File, ComponentFloorError> {
    use std::os::unix::fs::OpenOptionsExt as _;

    OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .mode(0o600)
        .open(path)
        .map_err(storage)
}

#[cfg(windows)]
fn create_lock(path: &Path) -> Result<File, ComponentFloorError> {
    use std::os::windows::fs::OpenOptionsExt as _;
    use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};

    OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(path)
        .map_err(storage)
}

#[cfg(not(any(unix, windows)))]
fn open_existing_lock(_path: &Path) -> Result<File, ComponentFloorError> {
    Err(ComponentFloorError::UnsafeStorage)
}

#[cfg(not(any(unix, windows)))]
fn create_lock(_path: &Path) -> Result<File, ComponentFloorError> {
    Err(ComponentFloorError::UnsafeStorage)
}

#[cfg(unix)]
fn create_marker(path: &Path) -> Result<File, ComponentFloorError> {
    use std::os::unix::fs::OpenOptionsExt as _;

    OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .mode(0o600)
        .open(path)
        .map_err(storage)
}

#[cfg(windows)]
fn create_marker(path: &Path) -> Result<File, ComponentFloorError> {
    use std::os::windows::fs::OpenOptionsExt as _;
    use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};

    OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(path)
        .map_err(storage)
}

#[cfg(not(any(unix, windows)))]
fn create_marker(_path: &Path) -> Result<File, ComponentFloorError> {
    Err(ComponentFloorError::UnsafeStorage)
}

#[cfg(unix)]
fn open_existing_marker(path: &Path) -> Result<File, ComponentFloorError> {
    use std::os::unix::fs::OpenOptionsExt as _;

    #[cfg(target_os = "macos")]
    const O_NOFOLLOW: i32 = 0x0000_0100;
    #[cfg(not(target_os = "macos"))]
    const O_NOFOLLOW: i32 = 0x0002_0000;
    OpenOptions::new()
        .read(true)
        .custom_flags(O_NOFOLLOW)
        .open(path)
        .map_err(storage)
}

#[cfg(windows)]
fn open_existing_marker(path: &Path) -> Result<File, ComponentFloorError> {
    use std::os::windows::fs::OpenOptionsExt as _;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(storage)
}

#[cfg(not(any(unix, windows)))]
fn open_existing_marker(_path: &Path) -> Result<File, ComponentFloorError> {
    Err(ComponentFloorError::UnsafeStorage)
}

#[cfg(unix)]
fn safe_lock_metadata(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt as _;

    metadata.is_file() && !metadata.file_type().is_symlink() && metadata.nlink() == 1
}

#[cfg(windows)]
fn safe_lock_metadata(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt as _;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.is_file()
        && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0
        && !metadata.file_type().is_symlink()
}

#[cfg(not(any(unix, windows)))]
fn safe_lock_metadata(_metadata: &fs::Metadata) -> bool {
    false
}

fn safe_marker_metadata(metadata: &fs::Metadata) -> bool {
    safe_lock_metadata(metadata)
}

#[cfg(unix)]
fn same_open_lock(path: &Path, file: &File) -> Result<bool, ComponentFloorError> {
    use std::os::unix::fs::MetadataExt as _;

    let path_metadata = fs::symlink_metadata(path).map_err(storage)?;
    let file_metadata = file.metadata().map_err(storage)?;
    Ok(safe_lock_metadata(&path_metadata)
        && file_metadata.nlink() == 1
        && path_metadata.dev() == file_metadata.dev()
        && path_metadata.ino() == file_metadata.ino())
}

#[cfg(windows)]
fn same_open_lock(path: &Path, file: &File) -> Result<bool, ComponentFloorError> {
    let path_metadata = fs::symlink_metadata(path).map_err(storage)?;
    if !safe_lock_metadata(&path_metadata) {
        return Ok(false);
    }
    let current = open_existing_lock(path)?;
    Ok(windows_file_identity(file)? == windows_file_identity(&current)?)
}

#[cfg(not(any(unix, windows)))]
fn same_open_lock(_path: &Path, _file: &File) -> Result<bool, ComponentFloorError> {
    Ok(false)
}

#[cfg(unix)]
fn same_open_marker(path: &Path, file: &File) -> Result<bool, ComponentFloorError> {
    same_open_lock(path, file)
}

#[cfg(windows)]
fn same_open_marker(path: &Path, file: &File) -> Result<bool, ComponentFloorError> {
    let path_metadata = fs::symlink_metadata(path).map_err(storage)?;
    if !safe_marker_metadata(&path_metadata) {
        return Ok(false);
    }
    let current = open_existing_marker(path)?;
    Ok(windows_file_identity(file)? == windows_file_identity(&current)?)
}

#[cfg(not(any(unix, windows)))]
fn same_open_marker(_path: &Path, _file: &File) -> Result<bool, ComponentFloorError> {
    Ok(false)
}

#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WindowsFileIdentity {
    volume: u32,
    index: u64,
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn windows_file_identity(file: &File) -> Result<WindowsFileIdentity, ComponentFloorError> {
    use std::os::windows::io::AsRawHandle as _;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT, GetFileInformationByHandle,
    };

    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: `file` owns a live handle and `information` is exact writable storage for the
    // structure requested by GetFileInformationByHandle.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as HANDLE, &raw mut information) }
        == 0
    {
        return Err(storage(io::Error::last_os_error()));
    }
    if information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || information.nNumberOfLinks != 1
    {
        return Err(ComponentFloorError::UnsafeStorage);
    }
    Ok(WindowsFileIdentity {
        volume: information.dwVolumeSerialNumber,
        index: (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow),
    })
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), ComponentFloorError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(storage)
}

#[cfg(windows)]
fn sync_directory(_path: &Path) -> Result<(), ComponentFloorError> {
    // `File::sync_all` above flushes the marker handle. Opening directory handles for flushing on
    // Windows requires FILE_FLAG_BACKUP_SEMANTICS and varies by filesystem; Credential Manager is
    // still the authoritative floor. A marker missing after a crash fails closed once observed.
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn sync_directory(_path: &Path) -> Result<(), ComponentFloorError> {
    Err(ComponentFloorError::UnsafeStorage)
}
