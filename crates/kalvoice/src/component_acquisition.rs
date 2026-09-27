//! Explicit, resumable acquisition for signed KalVoice components.
//!
//! The caller supplies a compact JWS obtained through the authenticated KalCode control plane or
//! bundled with the application. This module verifies that signature and its immutable HTTPS URL
//! before making a request. Artifact bytes are size bounded while streaming, hashed before install,
//! and then handed to [`ComponentStore`], whose pointer transition is atomic and rollback aware.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use fs2::FileExt as _;
use sha2::{Digest as _, Sha256};

use crate::component_manifest::{
    ComponentArch, ComponentPlatform, ComponentVerifier, VerifiedComponentManifest, VerifyError,
};
use crate::component_store::{
    ComponentStore, ComponentStoreError, InstalledComponent, TrustedComponentDirectory,
};

const BUFFER_BYTES: usize = 1024 * 1024;
const MAX_REDIRECTS: usize = 3;
const MAX_RESPONSE_HEADER_BYTES: usize = 64 * 1024;
const LOCK_POLL_INTERVAL: Duration = Duration::from_millis(25);
const DOWNLOAD_ADMISSION_MARGIN: u64 = 64 * 1024 * 1024;

#[cfg(test)]
type LockConflictObserver = Arc<dyn Fn() + Send + Sync>;

#[derive(Debug, thiserror::Error)]
pub enum ComponentAcquisitionError {
    #[error("explicit component download consent is required")]
    ConsentRequired,
    #[error("the component acquisition was cancelled")]
    Cancelled,
    #[error("the signed component manifest is invalid: {0}")]
    Manifest(#[from] VerifyError),
    #[error("the component is not built for this operating system and architecture")]
    WrongTarget,
    #[error("the component server returned an invalid response")]
    InvalidResponse,
    #[error("the component server returned status {0}")]
    Server(u16),
    #[error("the component download failed")]
    Network,
    #[error("the component artifact does not match its signed digest")]
    ChecksumMismatch,
    #[error("the component staging path is unsafe")]
    UnsafeStaging,
    #[error("the staging volume does not have enough free space")]
    NotEnoughSpace,
    #[error("component staging failed: {0}")]
    Storage(io::ErrorKind),
    #[error("component installation failed: {0}")]
    Install(#[from] ComponentStoreError),
}

fn storage(error: io::Error) -> ComponentAcquisitionError {
    ComponentAcquisitionError::Storage(error.kind())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TransportFailure {
    Network,
}

struct ArtifactResponse {
    status: u16,
    location: Option<String>,
    content_length: Option<u64>,
    content_range: Option<String>,
    body: Box<dyn Read + Send>,
}

trait ArtifactTransport: Send + Sync {
    fn get(
        &self,
        url: &str,
        range_start: Option<u64>,
    ) -> Result<ArtifactResponse, TransportFailure>;
}

struct UreqTransport {
    agent: ureq::Agent,
}

impl UreqTransport {
    fn new() -> Self {
        let agent = ureq::Agent::config_builder()
            .https_only(true)
            .http_status_as_error(false)
            .max_redirects(0)
            .timeout_connect(Some(Duration::from_secs(20)))
            .timeout_recv_response(Some(Duration::from_secs(30)))
            // A blocked body read must return to the cancellation loop within a bounded window.
            .timeout_recv_body(Some(Duration::from_secs(5)))
            .max_response_header_size(MAX_RESPONSE_HEADER_BYTES)
            .user_agent("KalCode")
            .build()
            .into();
        Self { agent }
    }
}

impl ArtifactTransport for UreqTransport {
    fn get(
        &self,
        url: &str,
        range_start: Option<u64>,
    ) -> Result<ArtifactResponse, TransportFailure> {
        let mut request = self.agent.get(url);
        if let Some(start) = range_start {
            request = request.header("Range", &format!("bytes={start}-"));
        }
        let response = request.call().map_err(|_| TransportFailure::Network)?;
        let status = response.status().as_u16();
        let header = |name: &str| {
            response
                .headers()
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned)
        };
        let location = header("location");
        let content_length = header("content-length").and_then(|value| value.parse().ok());
        let content_range = header("content-range");
        let body = response.into_body().into_reader();
        Ok(ArtifactResponse {
            status,
            location,
            content_length,
            content_range,
            body: Box::new(body),
        })
    }
}

/// Blocking acquisition service. Invoke it from a bounded background worker, never the UI thread.
#[derive(Clone)]
pub struct ComponentAcquirer {
    store: ComponentStore,
    verifier: ComponentVerifier,
    staging_root: TrustedComponentDirectory,
    transport: Arc<dyn ArtifactTransport>,
    #[cfg(test)]
    lock_conflict_observer: Option<LockConflictObserver>,
}

impl ComponentAcquirer {
    pub fn new(
        store: ComponentStore,
        verifier: ComponentVerifier,
        staging_root: TrustedComponentDirectory,
    ) -> Self {
        Self {
            store,
            verifier,
            staging_root,
            transport: Arc::new(UreqTransport::new()),
            #[cfg(test)]
            lock_conflict_observer: None,
        }
    }

    #[cfg(test)]
    fn with_transport(
        store: ComponentStore,
        verifier: ComponentVerifier,
        staging_root: TrustedComponentDirectory,
        transport: Arc<dyn ArtifactTransport>,
    ) -> Self {
        Self {
            store,
            verifier,
            staging_root,
            transport,
            lock_conflict_observer: None,
        }
    }

    #[cfg(test)]
    fn observe_lock_conflict(&mut self, observer: LockConflictObserver) {
        self.lock_conflict_observer = Some(observer);
    }

    /// Downloads and installs one component after explicit user consent.
    ///
    /// Signature, time window, URL, platform, architecture, byte count, and digest are all bound
    /// by `signed_manifest`. Cancellation preserves a bounded partial file so a later explicit
    /// acquisition can resume it. A successful or rejected store transition removes staging bytes.
    pub fn acquire(
        &self,
        signed_manifest: &str,
        now_unix: i64,
        consent: bool,
        cancel: &AtomicBool,
        mut progress: impl FnMut(u64, u64),
    ) -> Result<InstalledComponent, ComponentAcquisitionError> {
        if !consent {
            return Err(ComponentAcquisitionError::ConsentRequired);
        }
        let verified = self.verifier.verify(signed_manifest, now_unix)?;
        if verified.manifest().platform != host_platform()
            || verified.manifest().arch != host_arch()
        {
            return Err(ComponentAcquisitionError::WrongTarget);
        }
        if cancel.load(Ordering::SeqCst) {
            return Err(ComponentAcquisitionError::Cancelled);
        }

        let staging_metadata = fs::symlink_metadata(self.staging_root.path()).map_err(storage)?;
        if !safe_staging_directory(&staging_metadata) {
            return Err(ComponentAcquisitionError::UnsafeStaging);
        }
        protect_staging_directory(self.staging_root.path())?;
        let staging_root = fs::canonicalize(self.staging_root.path()).map_err(storage)?;
        let digest = &verified.manifest().sha256;
        let partial = staging_root.join(format!("{digest}.partial"));
        let retained = fs::metadata(&partial)
            .ok()
            .map(|metadata| metadata.len().min(verified.manifest().size_bytes))
            .unwrap_or(0);
        let required = verified
            .manifest()
            .size_bytes
            .saturating_sub(retained)
            .saturating_add(DOWNLOAD_ADMISSION_MARGIN);
        if fs2::available_space(&staging_root).map_err(storage)? < required {
            return Err(ComponentAcquisitionError::NotEnoughSpace);
        }
        let lock_path = staging_root.join(format!("{digest}.lock"));
        let lock = open_acquisition_lock(&lock_path)?;
        loop {
            match lock.try_lock_exclusive() {
                Ok(()) => break,
                Err(error) if lock_conflict(&error) => {
                    #[cfg(test)]
                    if let Some(observer) = &self.lock_conflict_observer {
                        observer();
                    }
                    if cancel.load(Ordering::SeqCst) {
                        return Err(ComponentAcquisitionError::Cancelled);
                    }
                    thread::sleep(LOCK_POLL_INTERVAL);
                }
                Err(error) => return Err(storage(error)),
            }
        }

        let result = self.acquire_locked(
            signed_manifest,
            &verified,
            &partial,
            now_unix,
            cancel,
            &mut progress,
        );
        let _ = lock.unlock();
        result
    }

    fn acquire_locked(
        &self,
        signed_manifest: &str,
        verified: &VerifiedComponentManifest,
        partial: &Path,
        now_unix: i64,
        cancel: &AtomicBool,
        progress: &mut impl FnMut(u64, u64),
    ) -> Result<InstalledComponent, ComponentAcquisitionError> {
        self.download(verified, partial, cancel, progress)?;
        let result = self
            .store
            .install_from_file(signed_manifest, partial, now_unix)
            .map_err(ComponentAcquisitionError::Install);
        let _ = fs::remove_file(partial);
        result
    }

    fn download(
        &self,
        verified: &VerifiedComponentManifest,
        partial: &Path,
        cancel: &AtomicBool,
        progress: &mut impl FnMut(u64, u64),
    ) -> Result<(), ComponentAcquisitionError> {
        let manifest = verified.manifest();
        let (mut file, mut received) = open_partial(partial, manifest.size_bytes)?;
        let mut hasher = Sha256::new();
        if received > 0 {
            hash_existing_prefix(&mut file, &mut hasher, cancel)?;
            progress(received, manifest.size_bytes);
        }

        if received < manifest.size_bytes {
            let mut url = manifest.artifact_url.clone();
            let mut redirects = 0;
            let mut response = loop {
                if cancel.load(Ordering::SeqCst) {
                    return Err(ComponentAcquisitionError::Cancelled);
                }
                let response = self
                    .transport
                    .get(&url, (received > 0).then_some(received))
                    .map_err(|_| ComponentAcquisitionError::Network)?;
                if matches!(response.status, 301 | 302 | 303 | 307 | 308) {
                    if redirects >= MAX_REDIRECTS {
                        return Err(ComponentAcquisitionError::InvalidResponse);
                    }
                    let destination = response
                        .location
                        .as_deref()
                        .ok_or(ComponentAcquisitionError::InvalidResponse)?;
                    self.verifier.validate_redirect(verified, destination)?;
                    url = destination.to_owned();
                    redirects += 1;
                    continue;
                }
                break response;
            };

            match response.status {
                200 => {
                    received = 0;
                    hasher = Sha256::new();
                    file.set_len(0).map_err(storage)?;
                    file.seek(SeekFrom::Start(0)).map_err(storage)?;
                }
                206 if valid_content_range(
                    response.content_range.as_deref(),
                    received,
                    manifest.size_bytes,
                ) =>
                {
                    file.seek(SeekFrom::End(0)).map_err(storage)?;
                }
                status if (200..=299).contains(&status) => {
                    return Err(ComponentAcquisitionError::InvalidResponse);
                }
                status => return Err(ComponentAcquisitionError::Server(status)),
            }
            let remaining = manifest.size_bytes.saturating_sub(received);
            if response
                .content_length
                .is_some_and(|content_length| content_length != remaining)
            {
                return Err(ComponentAcquisitionError::InvalidResponse);
            }
            let mut buffer = vec![0_u8; BUFFER_BYTES];
            loop {
                if cancel.load(Ordering::SeqCst) {
                    file.flush().map_err(storage)?;
                    return Err(ComponentAcquisitionError::Cancelled);
                }
                let count = response
                    .body
                    .read(&mut buffer)
                    .map_err(|_| ComponentAcquisitionError::Network)?;
                if count == 0 {
                    break;
                }
                if received.saturating_add(count as u64) > manifest.size_bytes {
                    drop(file);
                    let _ = fs::remove_file(partial);
                    return Err(ComponentAcquisitionError::InvalidResponse);
                }
                file.write_all(&buffer[..count]).map_err(storage)?;
                hasher.update(&buffer[..count]);
                received += count as u64;
                progress(received, manifest.size_bytes);
            }
            file.sync_all().map_err(storage)?;
        }

        if received != manifest.size_bytes {
            return Err(ComponentAcquisitionError::Network);
        }
        let actual = format!("{:x}", hasher.finalize());
        if actual != manifest.sha256 {
            // Windows does not permit deleting an open file. Close the anchored handle before
            // removing bytes that failed the signed digest check.
            drop(file);
            let _ = fs::remove_file(partial);
            return Err(ComponentAcquisitionError::ChecksumMismatch);
        }
        Ok(())
    }
}

fn lock_conflict(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::WouldBlock
        || (cfg!(windows) && matches!(error.raw_os_error(), Some(32 | 33)))
}

#[cfg(target_os = "windows")]
fn host_platform() -> ComponentPlatform {
    ComponentPlatform::Windows
}

#[cfg(target_os = "macos")]
fn host_platform() -> ComponentPlatform {
    ComponentPlatform::Macos
}

#[cfg(target_os = "linux")]
fn host_platform() -> ComponentPlatform {
    ComponentPlatform::Linux
}

#[cfg(target_arch = "x86_64")]
fn host_arch() -> ComponentArch {
    ComponentArch::X86_64
}

#[cfg(target_arch = "aarch64")]
fn host_arch() -> ComponentArch {
    ComponentArch::Aarch64
}

fn hash_existing_prefix(
    file: &mut File,
    hasher: &mut Sha256,
    cancel: &AtomicBool,
) -> Result<(), ComponentAcquisitionError> {
    file.seek(SeekFrom::Start(0)).map_err(storage)?;
    let mut buffer = vec![0_u8; BUFFER_BYTES];
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(ComponentAcquisitionError::Cancelled);
        }
        let count = file.read(&mut buffer).map_err(storage)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    file.seek(SeekFrom::End(0)).map_err(storage)?;
    Ok(())
}

fn open_partial(path: &Path, maximum: u64) -> Result<(File, u64), ComponentAcquisitionError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !safe_staging_metadata(&metadata) {
                return Err(ComponentAcquisitionError::UnsafeStaging);
            }
            let mut file = open_existing_staging_file(path)?;
            if !same_open_file(path, &file)? {
                return Err(ComponentAcquisitionError::UnsafeStaging);
            }
            let mut length = file.metadata().map_err(storage)?.len();
            if length > maximum {
                file.set_len(0).map_err(storage)?;
                file.sync_all().map_err(storage)?;
                length = 0;
            }
            file.seek(SeekFrom::Start(0)).map_err(storage)?;
            Ok((file, length))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let file = create_private_partial(path)?;
            if !same_open_file(path, &file)? {
                return Err(ComponentAcquisitionError::UnsafeStaging);
            }
            Ok((file, 0))
        }
        Err(error) => Err(storage(error)),
    }
}

fn open_acquisition_lock(path: &Path) -> Result<File, ComponentAcquisitionError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !safe_staging_metadata(&metadata) || metadata.len() != 0 {
                return Err(ComponentAcquisitionError::UnsafeStaging);
            }
            let file = open_existing_staging_file(path)?;
            if !same_open_file(path, &file)? {
                return Err(ComponentAcquisitionError::UnsafeStaging);
            }
            Ok(file)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let file = create_private_partial(path)?;
            if !same_open_file(path, &file)? {
                return Err(ComponentAcquisitionError::UnsafeStaging);
            }
            Ok(file)
        }
        Err(error) => Err(storage(error)),
    }
}

#[cfg(unix)]
fn open_existing_staging_file(path: &Path) -> Result<File, ComponentAcquisitionError> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(storage)
}

#[cfg(windows)]
fn open_existing_staging_file(path: &Path) -> Result<File, ComponentAcquisitionError> {
    use std::os::windows::fs::OpenOptionsExt as _;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    OpenOptions::new()
        .read(true)
        .write(true)
        // Retain the name while this handle is live and inspect the final object rather than
        // following a final-component reparse point.
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(storage)
}

#[cfg(not(any(unix, windows)))]
fn open_existing_staging_file(_path: &Path) -> Result<File, ComponentAcquisitionError> {
    Err(ComponentAcquisitionError::UnsafeStaging)
}

#[cfg(unix)]
fn create_private_partial(path: &Path) -> Result<File, ComponentAcquisitionError> {
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
fn create_private_partial(path: &Path) -> Result<File, ComponentAcquisitionError> {
    use std::os::windows::fs::OpenOptionsExt as _;
    use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};

    let mut options = OpenOptions::new();
    options.create_new(true).read(true).write(true);
    options.share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE);
    options.open(path).map_err(storage)
}

#[cfg(not(any(unix, windows)))]
fn create_private_partial(_path: &Path) -> Result<File, ComponentAcquisitionError> {
    Err(ComponentAcquisitionError::UnsafeStaging)
}

#[cfg(unix)]
fn safe_staging_metadata(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt as _;

    metadata.is_file() && !metadata.file_type().is_symlink() && metadata.nlink() == 1
}

#[cfg(unix)]
fn safe_staging_directory(metadata: &fs::Metadata) -> bool {
    metadata.is_dir() && !metadata.file_type().is_symlink()
}

#[cfg(unix)]
fn protect_staging_directory(path: &Path) -> Result<(), ComponentAcquisitionError> {
    use std::os::unix::fs::PermissionsExt as _;

    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(storage)
}

#[cfg(windows)]
fn safe_staging_metadata(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt as _;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.is_file()
        && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0
        && !metadata.file_type().is_symlink()
}

#[cfg(windows)]
fn safe_staging_directory(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt as _;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.is_dir()
        && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0
        && !metadata.file_type().is_symlink()
}

#[cfg(windows)]
fn protect_staging_directory(_path: &Path) -> Result<(), ComponentAcquisitionError> {
    // Windows ACL ownership belongs to the canonical per-user data-directory initializer. This
    // layer still rejects final-component reparse points and unsafe staging files before use.
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn safe_staging_metadata(_metadata: &fs::Metadata) -> bool {
    false
}

#[cfg(not(any(unix, windows)))]
fn safe_staging_directory(_metadata: &fs::Metadata) -> bool {
    false
}

#[cfg(not(any(unix, windows)))]
fn protect_staging_directory(_path: &Path) -> Result<(), ComponentAcquisitionError> {
    Err(ComponentAcquisitionError::UnsafeStaging)
}

#[cfg(unix)]
fn same_open_file(path: &Path, file: &File) -> Result<bool, ComponentAcquisitionError> {
    use std::os::unix::fs::MetadataExt as _;

    let path_metadata = fs::symlink_metadata(path).map_err(storage)?;
    let file_metadata = file.metadata().map_err(storage)?;
    Ok(safe_staging_metadata(&path_metadata)
        && file_metadata.nlink() == 1
        && path_metadata.dev() == file_metadata.dev()
        && path_metadata.ino() == file_metadata.ino())
}

#[cfg(windows)]
fn same_open_file(path: &Path, file: &File) -> Result<bool, ComponentAcquisitionError> {
    let path_metadata = fs::symlink_metadata(path).map_err(storage)?;
    if !safe_staging_metadata(&path_metadata) {
        return Ok(false);
    }
    let current = open_existing_staging_file(path)?;
    let expected = windows_file_identity(file)?;
    let actual = windows_file_identity(&current)?;
    Ok(expected == actual)
}

#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WindowsFileIdentity {
    volume: u32,
    index: u64,
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn windows_file_identity(file: &File) -> Result<WindowsFileIdentity, ComponentAcquisitionError> {
    use std::os::windows::io::AsRawHandle as _;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT, GetFileInformationByHandle,
    };

    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: `file` owns a live Windows handle, and `information` is exact writable storage for
    // the structure requested by GetFileInformationByHandle.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as HANDLE, &raw mut information) }
        == 0
    {
        return Err(storage(io::Error::last_os_error()));
    }
    if information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || information.nNumberOfLinks != 1
    {
        return Err(ComponentAcquisitionError::UnsafeStaging);
    }
    Ok(WindowsFileIdentity {
        volume: information.dwVolumeSerialNumber,
        index: (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow),
    })
}

#[cfg(not(any(unix, windows)))]
fn same_open_file(_path: &Path, _file: &File) -> Result<bool, ComponentAcquisitionError> {
    Ok(false)
}

fn valid_content_range(value: Option<&str>, start: u64, total: u64) -> bool {
    let Some(value) = value else {
        return false;
    };
    let Some(value) = value.strip_prefix("bytes ") else {
        return false;
    };
    let Some((range, parsed_total)) = value.split_once('/') else {
        return false;
    };
    let Some((parsed_start, parsed_end)) = range.split_once('-') else {
        return false;
    };
    let Ok(parsed_start) = parsed_start.parse::<u64>() else {
        return false;
    };
    let Ok(parsed_end) = parsed_end.parse::<u64>() else {
        return false;
    };
    let Ok(parsed_total) = parsed_total.parse::<u64>() else {
        return false;
    };
    parsed_start == start
        && parsed_total == total
        && parsed_end.checked_add(1) == Some(total)
        && parsed_start <= parsed_end
}

#[cfg(test)]
#[path = "component_acquisition_tests.rs"]
mod tests;
