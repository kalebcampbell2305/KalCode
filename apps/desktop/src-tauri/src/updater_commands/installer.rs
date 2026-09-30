#[cfg(windows)]
use std::fs::OpenOptions;
use std::fs::{self, File};
#[cfg(any(windows, target_os = "macos"))]
use std::io::Write;
#[cfg(any(windows, target_os = "macos"))]
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::process::Command;

use kalcode_updater::{FeedMetadata, InstallBinding, MacSwapAttempt, UpdateError};
#[cfg(windows)]
use kalcode_updater::{UpdateTarget, verify_download_reader};
#[cfg(any(windows, target_os = "macos"))]
use sha2::{Digest, Sha256};

#[cfg(target_os = "macos")]
mod macos;

#[cfg(windows)]
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use windows_sys::Win32::Security::WinTrust::{
    WINTRUST_DATA, WINTRUST_DATA_0, WINTRUST_FILE_INFO, WTD_CACHE_ONLY_URL_RETRIEVAL,
    WTD_CHOICE_FILE, WTD_DISABLE_MD2_MD4, WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT,
    WTD_REVOKE_WHOLECHAIN, WTD_STATEACTION_CLOSE, WTD_STATEACTION_VERIFY, WTD_UI_NONE,
    WTD_UICONTEXT_INSTALL,
};

#[cfg(windows)]
const AUTHENTICODE_IDENTITY_OIDS: Option<&str> = option_env!("KALCODE_AUTHENTICODE_IDENTITY_OIDS");
#[cfg(windows)]
const ARTIFACT_SIGNING_IDENTITY_PREFIX: &str = "1.3.6.1.4.1.311.97.";
#[cfg(windows)]
const GENERIC_ARTIFACT_SIGNING_IDENTITY: &str = "1.3.6.1.4.1.311.97.1.0";
#[cfg(windows)]
const CODE_SIGNING_EKU: &str = "1.3.6.1.5.5.7.3.3";
#[cfg(windows)]
const REQUIRED_PUBLISHER_IDENTITIES: usize = 1;
#[cfg(windows)]
const MAX_IDENTITY_POLICY_BYTES: usize = 1_024;
#[cfg(windows)]
const MAX_CERTIFICATE_EKU_BYTES: usize = 64 * 1_024;
#[cfg(windows)]
const MAX_CERTIFICATE_EKUS: usize = 64;
#[cfg(windows)]
const MAX_OID_BYTES: usize = 128;
#[cfg(windows)]
const REVOCATION_REFRESH_TIMEOUT_MS: u32 = 5_000;
#[cfg(windows)]
const MAX_TIMESTAMP_SIGNERS: usize = 1;
#[cfg(windows)]
const CRYPT_E_REVOCATION_OFFLINE: i32 = 0x8009_2013_u32 as i32;
#[cfg(windows)]
const CERT_E_REVOCATION_FAILURE: i32 = 0x800b_010e_u32 as i32;

/// A verified raw NSIS installer held open without write/delete sharing from preparation until
/// process launch. Verification and launch therefore refer to the same immutable file object.
pub struct PreparedInstaller {
    path: PathBuf,
    file: Option<File>,
    binding: InstallBinding,
    #[cfg(target_os = "macos")]
    macos: Option<macos::PreparedMacInstaller>,
}

impl PreparedInstaller {
    #[cfg(windows)]
    pub fn prepare(
        root: &Path,
        name: &str,
        bytes: &[u8],
        metadata: &FeedMetadata,
        _expected_version: &str,
        _current_version: &str,
        cancel: &dyn Fn() -> Result<(), UpdateError>,
    ) -> Result<Self, UpdateError> {
        cancel()?;
        if !cfg!(windows) || bytes.get(..2) != Some(b"MZ") {
            return Err(installer_invalid());
        }
        ensure_prepared_directory(root)?;
        cleanup_prepared(root);
        cancel()?;

        let path = root.join(name);
        if path.parent() != Some(root) || !is_safe_name(name) {
            return Err(installer_invalid());
        }
        let writer = open_prepared_writer(&path)?;
        let held = (|mut writer: File| {
            // Recheck after the create-new open. If an attacker raced a parent swap, never write
            // or execute through the replacement path.
            reject_reparse(root)?;
            write_all_cancellable(&mut writer, bytes, cancel)?;
            writer.sync_all().map_err(|_| installer_storage_failed())?;
            cancel()?;
            // Windows can't start an image while any handle has write access to it
            // (ERROR_SHARING_VIOLATION). Close the writer and verify and launch through a
            // read-only handle that still denies writers, so nothing can change the bytes
            // between verification and launch.
            drop(writer);
            let mut file = open_prepared_for_launch(&path)?;
            reject_reparse(root)?;
            verify_download_reader(&mut file, metadata)?;
            cancel()?;
            verify_authenticode(&file, &path)?;
            cancel()?;
            reject_reparse(root)?;
            Ok(file)
        })(writer);
        let file = match held {
            Ok(file) => file,
            Err(error) => {
                let _ = fs::remove_file(&path);
                return Err(error);
            }
        };
        let binding = match (|| {
            cancel()?;
            let binding = installation_binding()?;
            cancel()?;
            Ok(binding)
        })() {
            Ok(binding) => binding,
            Err(error) => {
                drop(file);
                let _ = fs::remove_file(&path);
                return Err(error);
            }
        };
        Ok(Self {
            path,
            file: Some(file),
            binding,
        })
    }

    #[must_use]
    pub const fn binding(&self) -> &InstallBinding {
        &self.binding
    }

    #[cfg(not(target_os = "macos"))]
    #[must_use]
    pub fn mac_swap_attempt(&self) -> Option<MacSwapAttempt> {
        None
    }

    #[cfg(target_os = "macos")]
    #[must_use]
    pub fn mac_swap_attempt(&self) -> Option<MacSwapAttempt> {
        self.macos
            .as_ref()
            .map(macos::PreparedMacInstaller::swap_attempt)
    }

    #[cfg(target_os = "macos")]
    pub fn prepare(
        root: &Path,
        name: &str,
        bytes: &[u8],
        metadata: &FeedMetadata,
        expected_version: &str,
        current_version: &str,
        cancel: &dyn Fn() -> Result<(), UpdateError>,
    ) -> Result<Self, UpdateError> {
        let prepared = macos::PreparedMacInstaller::prepare(
            root,
            name,
            bytes,
            metadata,
            expected_version,
            current_version,
            cancel,
        )?;
        Ok(Self {
            path: prepared.dmg_path().to_path_buf(),
            file: None,
            binding: prepared.binding().clone(),
            macos: Some(prepared),
        })
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    pub fn prepare(
        _root: &Path,
        _name: &str,
        _bytes: &[u8],
        _metadata: &FeedMetadata,
        _expected_version: &str,
        _current_version: &str,
        cancel: &dyn Fn() -> Result<(), UpdateError>,
    ) -> Result<Self, UpdateError> {
        cancel()?;
        Err(installer_invalid())
    }

    /// Launches the exact held installer. The caller must quiesce application work first and exit
    /// promptly after success. No shell command string or artifact-controlled argument is used.
    #[cfg(windows)]
    pub fn launch(mut self) -> Result<(), UpdateError> {
        let child = installer_command(&self.path).spawn().map_err(|_| {
            UpdateError::new(
                "update_launch_failed",
                "The verified installer couldn't start.",
            )
        })?;
        drop(child);
        // Keep the deny-write handle and installer path alive until this process exits. The next
        // KalCode start removes stale files from this dedicated directory.
        std::mem::forget(self.file.take());
        std::mem::forget(self);
        Ok(())
    }

    #[cfg(target_os = "macos")]
    pub fn launch(mut self) -> Result<(), UpdateError> {
        let prepared = self.macos.take().ok_or_else(installer_invalid)?;
        prepared.launch()?;
        std::mem::forget(self);
        Ok(())
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    pub fn launch(self) -> Result<(), UpdateError> {
        Err(installer_invalid())
    }
}

/// Removes only preparation artifacts whose platform-specific ownership checks succeed. A valid
/// pending macOS swap is protected because the post-exit helper still owns its staged bundle.
/// `false` preserves a live native worker and temporarily denies another preparation.
pub(super) fn cleanup_startup(
    root: &Path,
    protected: Option<&MacSwapAttempt>,
) -> Result<bool, UpdateError> {
    #[cfg(target_os = "macos")]
    {
        macos::cleanup_startup(root, protected)
    }
    #[cfg(windows)]
    {
        let _ = protected;
        ensure_prepared_directory(root)?;
        cleanup_prepared(root);
        Ok(true)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (root, protected);
        Ok(true)
    }
}

#[cfg(any(windows, target_os = "macos"))]
fn write_all_cancellable(
    writer: &mut File,
    bytes: &[u8],
    cancel: &dyn Fn() -> Result<(), UpdateError>,
) -> Result<(), UpdateError> {
    for chunk in bytes.chunks(64 * 1024) {
        cancel()?;
        writer
            .write_all(chunk)
            .map_err(|_| installer_storage_failed())?;
    }
    cancel()
}

#[cfg(windows)]
fn installer_command(path: &Path) -> Command {
    let mut command = Command::new(path);
    // Matches Tauri's documented passive NSIS update mode and restart behavior.
    command.args(["/P", "/UPDATE", "/R"]);
    command
}

/// Creates the prepared installer for writing. Readers only; no writer or deleter can share it.
#[cfg(windows)]
fn open_prepared_writer(path: &Path) -> Result<File, UpdateError> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    options.share_mode(windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ);
    options.open(path).map_err(|_| installer_storage_failed())
}

/// Reopens the written installer read-only, denying writers and deletion until launch. The path
/// itself is opened (never a reparse point's target), and it must be a plain file.
#[cfg(windows)]
fn open_prepared_for_launch(path: &Path) -> Result<File, UpdateError> {
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
    };

    let mut options = OpenOptions::new();
    options.read(true);
    options.share_mode(FILE_SHARE_READ);
    options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    let file = options.open(path).map_err(|_| installer_storage_failed())?;
    let metadata = file.metadata().map_err(|_| installer_storage_failed())?;
    if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(installer_storage_failed());
    }
    Ok(file)
}

#[cfg(windows)]
fn installation_binding() -> Result<InstallBinding, UpdateError> {
    let current_exe = std::env::current_exe().map_err(|_| installer_invalid())?;
    let mut current = File::open(&current_exe).map_err(|_| installer_invalid())?;
    verify_authenticode(&current, &current_exe)?;
    let source_sha256 = digest_reader(&mut current)?;
    let publisher_policy = AUTHENTICODE_IDENTITY_OIDS.ok_or_else(publisher_policy_invalid)?;
    Ok(InstallBinding {
        target: UpdateTarget::WindowsX86_64,
        source_sha256,
        signing_requirement_sha256: format!("{:x}", Sha256::digest(publisher_policy.as_bytes())),
    })
}

#[cfg(any(windows, target_os = "macos"))]
fn digest_reader(reader: &mut File) -> Result<String, UpdateError> {
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|_| installer_invalid())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer).map_err(|_| installer_invalid())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|_| installer_invalid())?;
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(any(windows, target_os = "macos"))]
fn ensure_prepared_directory(root: &Path) -> Result<(), UpdateError> {
    if !root.is_absolute() {
        return Err(installer_storage_failed());
    }
    let parent = root.parent().ok_or_else(installer_storage_failed)?;
    let base = parent.parent().ok_or_else(installer_storage_failed)?;
    ensure_existing_plain_directory(base)?;
    ensure_one_plain_child(parent)?;
    ensure_one_plain_child(root)
}

#[cfg(any(windows, target_os = "macos"))]
fn ensure_existing_plain_directory(path: &Path) -> Result<(), UpdateError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| installer_storage_failed())?;
    if !metadata.is_dir() {
        return Err(installer_storage_failed());
    }
    reject_reparse(path)
}

#[cfg(any(windows, target_os = "macos"))]
fn ensure_one_plain_child(path: &Path) -> Result<(), UpdateError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.is_dir() {
                return Err(installer_storage_failed());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(path).map_err(|_| installer_storage_failed())?;
        }
        Err(_) => return Err(installer_storage_failed()),
    }
    reject_reparse(path)
}

impl Drop for PreparedInstaller {
    fn drop(&mut self) {
        drop(self.file.take());
        #[cfg(not(target_os = "macos"))]
        let _ = fs::remove_file(&self.path);
    }
}

#[cfg(any(windows, target_os = "macos"))]
fn is_safe_name(name: &str) -> bool {
    name.starts_with("prepared-")
        && (name.ends_with(".exe") || name.ends_with(".dmg"))
        && name.len() <= 96
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
}

#[cfg(any(windows, target_os = "macos"))]
fn cleanup_prepared(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let path = entry.path();
        if is_safe_name(name)
            && path.parent() == Some(root)
            && fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.is_file())
        {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(any(windows, target_os = "macos"))]
fn reject_reparse(path: &Path) -> Result<(), UpdateError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| installer_storage_failed())?;
    #[cfg(windows)]
    if metadata.file_attributes()
        & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
        != 0
    {
        return Err(installer_storage_failed());
    }
    #[cfg(not(windows))]
    if metadata.file_type().is_symlink() {
        return Err(installer_storage_failed());
    }
    Ok(())
}

#[cfg(windows)]
fn verify_authenticode(file: &File, path: &Path) -> Result<(), UpdateError> {
    let result = run_win_verify_trust(file, path, PublisherRequirement::CompileTime);
    if result.status != 0 {
        return Err(authenticode_invalid());
    }
    match result.publisher {
        PublisherCheck::Matched => Ok(()),
        PublisherCheck::PolicyInvalid => Err(publisher_policy_invalid()),
        PublisherCheck::NotChecked | PublisherCheck::Mismatch | PublisherCheck::EvidenceInvalid => {
            Err(authenticode_invalid())
        }
    }
}

#[cfg(windows)]
#[derive(Clone, Debug, PartialEq, Eq)]
struct PublisherPolicy {
    identities: Vec<String>,
}

#[cfg(windows)]
enum PublisherRequirement {
    #[cfg(test)]
    None,
    CompileTime,
    #[cfg(test)]
    Parsed(PublisherPolicy),
}

#[cfg(windows)]
#[derive(Debug, PartialEq, Eq)]
enum PublisherCheck {
    NotChecked,
    Matched,
    Mismatch,
    EvidenceInvalid,
    PolicyInvalid,
}

#[cfg(windows)]
struct WinTrustResult {
    status: i32,
    publisher: PublisherCheck,
}

#[cfg(all(test, windows))]
#[derive(Debug, PartialEq, Eq)]
enum TrustDecision {
    TrustedPublisher,
    SignatureInvalid,
    PublisherMismatch,
    PublisherEvidenceInvalid,
}

#[cfg(windows)]
fn parse_publisher_policy(raw: Option<&str>) -> Result<PublisherPolicy, UpdateError> {
    let raw = raw.ok_or_else(publisher_policy_invalid)?;
    if raw.is_empty() || raw.len() > MAX_IDENTITY_POLICY_BYTES || !raw.is_ascii() {
        return Err(publisher_policy_invalid());
    }

    let identities: Vec<String> = raw.split(',').map(str::to_owned).collect();
    if identities.is_empty()
        || identities.len() != REQUIRED_PUBLISHER_IDENTITIES
        || identities.iter().any(|identity| {
            identity.is_empty()
                || identity.len() > MAX_OID_BYTES
                || identity.trim() != identity
                || identity == GENERIC_ARTIFACT_SIGNING_IDENTITY
                || !is_canonical_subscriber_identity(identity)
        })
        || !identities.windows(2).all(|pair| pair[0] < pair[1])
    {
        return Err(publisher_policy_invalid());
    }

    Ok(PublisherPolicy { identities })
}

#[cfg(windows)]
fn is_canonical_subscriber_identity(identity: &str) -> bool {
    let Some(suffix) = identity.strip_prefix(ARTIFACT_SIGNING_IDENTITY_PREFIX) else {
        return false;
    };
    !suffix.is_empty()
        && suffix.split('.').all(|component| {
            !component.is_empty()
                && component.bytes().all(|byte| byte.is_ascii_digit())
                && (component == "0" || component.as_bytes()[0] != b'0')
        })
}

#[cfg(windows)]
fn publisher_identity_matches<T: AsRef<str>>(policy: &PublisherPolicy, observed: &[T]) -> bool {
    let has_code_signing = observed
        .iter()
        .any(|identity| identity.as_ref() == CODE_SIGNING_EKU);
    let has_public_trust_marker = observed
        .iter()
        .any(|identity| identity.as_ref() == GENERIC_ARTIFACT_SIGNING_IDENTITY);
    let mut subscriber_identity = None;
    for identity in observed.iter().map(AsRef::as_ref).filter(|identity| {
        identity.starts_with(ARTIFACT_SIGNING_IDENTITY_PREFIX)
            && *identity != GENERIC_ARTIFACT_SIGNING_IDENTITY
    }) {
        if !is_canonical_subscriber_identity(identity)
            || subscriber_identity.is_some_and(|existing| existing != identity)
        {
            return false;
        }
        subscriber_identity = Some(identity);
    }
    has_code_signing
        && has_public_trust_marker
        && subscriber_identity.is_some_and(|observed_identity| {
            policy
                .identities
                .iter()
                .any(|allowed| allowed == observed_identity)
        })
}

#[cfg(windows)]
fn wintrust_policy(file_info: &mut WINTRUST_FILE_INFO) -> WINTRUST_DATA {
    WINTRUST_DATA {
        cbStruct: u32::try_from(std::mem::size_of::<WINTRUST_DATA>()).unwrap_or(u32::MAX),
        dwUIChoice: WTD_UI_NONE,
        fdwRevocationChecks: WTD_REVOKE_WHOLECHAIN,
        dwUnionChoice: WTD_CHOICE_FILE,
        Anonymous: WINTRUST_DATA_0 {
            pFile: std::ptr::addr_of_mut!(*file_info),
        },
        dwStateAction: WTD_STATEACTION_VERIFY,
        // Cache-only retrieval keeps verification bounded. Missing or stale revocation evidence
        // fails closed instead of allowing an unbounded network lookup on the update path.
        dwProvFlags: WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT
            | WTD_CACHE_ONLY_URL_RETRIEVAL
            | WTD_DISABLE_MD2_MD4,
        dwUIContext: WTD_UICONTEXT_INSTALL,
        ..WINTRUST_DATA::default()
    }
}

#[cfg(all(test, windows))]
fn win_verify_trust(held_file: &File, path: &Path) -> i32 {
    run_win_verify_trust(held_file, path, PublisherRequirement::None).status
}

#[cfg(all(test, windows))]
fn win_verify_trust_and_publisher(
    held_file: &File,
    path: &Path,
    policy: &PublisherPolicy,
) -> TrustDecision {
    let result = run_win_verify_trust(
        held_file,
        path,
        PublisherRequirement::Parsed(policy.clone()),
    );
    if result.status != 0 {
        return match result.publisher {
            PublisherCheck::Mismatch => TrustDecision::PublisherMismatch,
            PublisherCheck::EvidenceInvalid | PublisherCheck::PolicyInvalid => {
                TrustDecision::PublisherEvidenceInvalid
            }
            PublisherCheck::Matched | PublisherCheck::NotChecked => TrustDecision::SignatureInvalid,
        };
    }
    match result.publisher {
        PublisherCheck::Matched => TrustDecision::TrustedPublisher,
        PublisherCheck::Mismatch => TrustDecision::PublisherMismatch,
        PublisherCheck::EvidenceInvalid | PublisherCheck::PolicyInvalid => {
            TrustDecision::PublisherEvidenceInvalid
        }
        PublisherCheck::NotChecked => TrustDecision::PublisherEvidenceInvalid,
    }
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn run_win_verify_trust(
    held_file: &File,
    path: &Path,
    publisher_requirement: PublisherRequirement,
) -> WinTrustResult {
    run_win_verify_trust_once(held_file, path, &publisher_requirement, true)
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn run_win_verify_trust_once(
    held_file: &File,
    path: &Path,
    publisher_requirement: &PublisherRequirement,
    allow_bounded_refresh: bool,
) -> WinTrustResult {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Security::WinTrust::{
        WINTRUST_ACTION_GENERIC_VERIFY_V2, WinVerifyTrust,
    };

    let path_wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut file_info = WINTRUST_FILE_INFO {
        cbStruct: u32::try_from(std::mem::size_of::<WINTRUST_FILE_INFO>()).unwrap_or(u32::MAX),
        pcwszFilePath: path_wide.as_ptr(),
        hFile: held_file.as_raw_handle(),
        pgKnownSubject: std::ptr::null_mut(),
    };
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    let mut trust = wintrust_policy(&mut file_info);

    // SAFETY: both structures have their documented sizes and remain pinned on this stack for the
    // calls; the file and UTF-16 path outlive them. WinVerifyTrust only receives the held file's
    // valid Windows handle and no WebView-controlled pointers.
    let status = unsafe {
        WinVerifyTrust(
            std::ptr::null_mut(),
            std::ptr::addr_of_mut!(action),
            std::ptr::addr_of_mut!(trust).cast(),
        )
    };
    let may_refresh_revocation = revocation_status_allows_refresh(status);
    let publisher = if status != 0 && !may_refresh_revocation {
        PublisherCheck::NotChecked
    } else {
        match publisher_requirement {
            #[cfg(test)]
            PublisherRequirement::None => PublisherCheck::NotChecked,
            PublisherRequirement::CompileTime => {
                match parse_publisher_policy(AUTHENTICODE_IDENTITY_OIDS) {
                    Ok(policy) => verified_publisher_check(&trust, &policy),
                    Err(_) => PublisherCheck::PolicyInvalid,
                }
            }
            #[cfg(test)]
            PublisherRequirement::Parsed(policy) => verified_publisher_check(&trust, policy),
        }
    };
    // Never perform certificate-directed network retrieval until Windows has reduced the only
    // trust failure to unavailable revocation data and the embedded signer has the exact
    // release-bound publisher identity. This keeps untrusted certificates from becoming an SSRF
    // primitive even if the independent update-signing key were compromised.
    let refreshed = allow_bounded_refresh
        && revocation_refresh_allowed(status, &publisher)
        && refresh_verified_signer_revocation(&trust);
    trust.dwStateAction = WTD_STATEACTION_CLOSE;
    // SAFETY: closes only the provider state created by the immediately preceding verify call;
    // the same initialized structures remain alive and unchanged otherwise.
    let _ = unsafe {
        WinVerifyTrust(
            std::ptr::null_mut(),
            std::ptr::addr_of_mut!(action),
            std::ptr::addr_of_mut!(trust).cast(),
        )
    };
    if refreshed {
        // The online chain builder only warms Windows' revocation cache. Trust is decided by a
        // second cache-only WinVerifyTrust pass, so network responses never become direct proof.
        return run_win_verify_trust_once(held_file, path, publisher_requirement, false);
    }
    WinTrustResult { status, publisher }
}

#[cfg(windows)]
fn revocation_status_allows_refresh(status: i32) -> bool {
    matches!(
        status,
        CRYPT_E_REVOCATION_OFFLINE | CERT_E_REVOCATION_FAILURE
    )
}

#[cfg(windows)]
fn revocation_refresh_allowed(status: i32, publisher: &PublisherCheck) -> bool {
    revocation_status_allows_refresh(status) && *publisher == PublisherCheck::Matched
}

#[cfg(windows)]
fn revocation_refresh_policy() -> windows_sys::Win32::Security::Cryptography::CERT_CHAIN_PARA {
    use windows_sys::Win32::Security::Cryptography::CERT_CHAIN_PARA;

    CERT_CHAIN_PARA {
        cbSize: u32::try_from(std::mem::size_of::<CERT_CHAIN_PARA>()).unwrap_or(u32::MAX),
        dwUrlRetrievalTimeout: REVOCATION_REFRESH_TIMEOUT_MS,
        ..CERT_CHAIN_PARA::default()
    }
}

#[cfg(windows)]
fn revocation_refresh_flags() -> u32 {
    use windows_sys::Win32::Security::Cryptography::{
        CERT_CHAIN_CACHE_END_CERT, CERT_CHAIN_DISABLE_AIA,
        CERT_CHAIN_DISABLE_AUTH_ROOT_AUTO_UPDATE, CERT_CHAIN_REVOCATION_ACCUMULATIVE_TIMEOUT,
        CERT_CHAIN_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT,
    };

    CERT_CHAIN_CACHE_END_CERT
        | CERT_CHAIN_DISABLE_AIA
        | CERT_CHAIN_DISABLE_AUTH_ROOT_AUTO_UPDATE
        | CERT_CHAIN_REVOCATION_ACCUMULATIVE_TIMEOUT
        | CERT_CHAIN_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn refresh_verified_signer_revocation(trust: &WINTRUST_DATA) -> bool {
    use windows_sys::Win32::Security::WinTrust::{
        WTHelperGetProvCertFromChain, WTHelperGetProvSignerFromChain, WTHelperProvDataFromStateData,
    };

    // SAFETY: the provider state belongs to the immediately preceding WinVerifyTrust call and is
    // kept open until this function returns. Counts are bounded before indexing any signer.
    let certificates = unsafe {
        if trust.hWVTStateData.is_null() {
            return false;
        }
        let provider = WTHelperProvDataFromStateData(trust.hWVTStateData);
        if provider.is_null() {
            return false;
        }
        let primary_signer = WTHelperGetProvSignerFromChain(provider, 0, 0, 0);
        if primary_signer.is_null()
            || usize::try_from((*primary_signer).csCounterSigners).unwrap_or(usize::MAX)
                > MAX_TIMESTAMP_SIGNERS
        {
            return false;
        }
        let primary = WTHelperGetProvCertFromChain(primary_signer, 0);
        if primary.is_null() || (*primary).pCert.is_null() {
            return false;
        }
        let mut certificates = vec![(*primary).pCert];
        for index in 0..(*primary_signer).csCounterSigners {
            let timestamp_signer = WTHelperGetProvSignerFromChain(provider, 0, 1, index);
            if timestamp_signer.is_null() {
                return false;
            }
            let timestamp = WTHelperGetProvCertFromChain(timestamp_signer, 0);
            if timestamp.is_null() || (*timestamp).pCert.is_null() {
                return false;
            }
            certificates.push((*timestamp).pCert);
        }
        certificates
    };

    certificates.into_iter().all(refresh_certificate_chain)
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn refresh_certificate_chain(
    certificate: *const windows_sys::Win32::Security::Cryptography::CERT_CONTEXT,
) -> bool {
    use windows_sys::Win32::Security::Cryptography::{
        CERT_CHAIN_CONTEXT, CertFreeCertificateChain, CertGetCertificateChain,
    };

    if certificate.is_null() {
        return false;
    }
    let policy = revocation_refresh_policy();
    let mut chain: *mut CERT_CHAIN_CONTEXT = std::ptr::null_mut();
    // SAFETY: the certificate comes from the still-open WinTrust provider state. The chain
    // parameter is fully initialized, network time is cumulatively bounded, and every returned
    // chain context is released before this function returns.
    let refreshed = unsafe {
        CertGetCertificateChain(
            std::ptr::null_mut(),
            certificate,
            std::ptr::null(),
            (*certificate).hCertStore,
            std::ptr::addr_of!(policy),
            revocation_refresh_flags(),
            std::ptr::null(),
            std::ptr::addr_of_mut!(chain),
        )
    } != 0;
    if !chain.is_null() {
        // SAFETY: `chain` was returned by CertGetCertificateChain and has not been released.
        unsafe { CertFreeCertificateChain(chain) };
    }
    refreshed
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn verified_publisher_check(trust: &WINTRUST_DATA, policy: &PublisherPolicy) -> PublisherCheck {
    use windows_sys::Win32::Security::Cryptography::{
        CERT_FIND_EXT_ONLY_ENHKEY_USAGE_FLAG, CTL_USAGE, CertGetEnhancedKeyUsage,
    };
    use windows_sys::Win32::Security::WinTrust::{
        WTHelperGetProvCertFromChain, WTHelperGetProvSignerFromChain, WTHelperProvDataFromStateData,
    };

    // SAFETY: these helpers consume the provider state produced by the successful WinVerifyTrust
    // call immediately above. We reject every null pointer, bound all OS-reported counts/sizes,
    // and extract only EKU OID bytes while that state remains open.
    let certificate = unsafe {
        if trust.hWVTStateData.is_null() {
            return PublisherCheck::EvidenceInvalid;
        }
        let provider = WTHelperProvDataFromStateData(trust.hWVTStateData);
        if provider.is_null() {
            return PublisherCheck::EvidenceInvalid;
        }
        let signer = WTHelperGetProvSignerFromChain(provider, 0, 0, 0);
        if signer.is_null() {
            return PublisherCheck::EvidenceInvalid;
        }
        let provider_certificate = WTHelperGetProvCertFromChain(signer, 0);
        if provider_certificate.is_null() || (*provider_certificate).pCert.is_null() {
            return PublisherCheck::EvidenceInvalid;
        }
        (*provider_certificate).pCert
    };

    let mut required_bytes = 0u32;
    // SAFETY: `certificate` belongs to the still-open verified provider state. The first call asks
    // only for the bounded output size and writes to a valid u32.
    let size_ok = unsafe {
        CertGetEnhancedKeyUsage(
            certificate,
            CERT_FIND_EXT_ONLY_ENHKEY_USAGE_FLAG,
            std::ptr::null_mut(),
            std::ptr::addr_of_mut!(required_bytes),
        )
    } != 0;
    let Ok(required_bytes) = usize::try_from(required_bytes) else {
        return PublisherCheck::EvidenceInvalid;
    };
    if !size_ok
        || required_bytes < std::mem::size_of::<CTL_USAGE>()
        || required_bytes > MAX_CERTIFICATE_EKU_BYTES
    {
        return PublisherCheck::EvidenceInvalid;
    }

    let mut buffer = vec![0u8; required_bytes];
    let usage = buffer.as_mut_ptr().cast::<CTL_USAGE>();
    let mut actual_bytes = u32::try_from(required_bytes).unwrap_or(u32::MAX);
    // SAFETY: the output buffer has the exact bounded size requested by Crypt32 and remains alive
    // while every returned usage pointer is inspected below.
    let usage_ok = unsafe {
        CertGetEnhancedKeyUsage(
            certificate,
            CERT_FIND_EXT_ONLY_ENHKEY_USAGE_FLAG,
            usage,
            std::ptr::addr_of_mut!(actual_bytes),
        )
    } != 0;
    if !usage_ok || usize::try_from(actual_bytes).ok() != Some(required_bytes) {
        return PublisherCheck::EvidenceInvalid;
    }

    // SAFETY: Crypt32 initialized `usage` in the caller-owned buffer. Its pointer array has the
    // validated count below and remains valid until the provider state and buffer are released.
    let identifiers = unsafe {
        let count = (*usage).cUsageIdentifier as usize;
        let pointers = (*usage).rgpszUsageIdentifier;
        if count == 0 || count > MAX_CERTIFICATE_EKUS || pointers.is_null() {
            return PublisherCheck::EvidenceInvalid;
        }
        std::slice::from_raw_parts(pointers, count)
    };

    let mut observed = Vec::with_capacity(identifiers.len());
    for identifier in identifiers {
        if identifier.is_null() {
            return PublisherCheck::EvidenceInvalid;
        }
        let mut length = 0usize;
        // SAFETY: each pointer is returned by Crypt32 for the lifetime of the still-open provider
        // state. Reads are strictly capped and stop at the required NUL terminator.
        while length <= MAX_OID_BYTES && unsafe { *identifier.add(length) } != 0 {
            length += 1;
        }
        if length == 0 || length > MAX_OID_BYTES {
            return PublisherCheck::EvidenceInvalid;
        }
        // SAFETY: the bounded scan above established `length` readable non-NUL bytes.
        let bytes = unsafe { std::slice::from_raw_parts(*identifier, length) };
        let Ok(oid) = std::str::from_utf8(bytes) else {
            return PublisherCheck::EvidenceInvalid;
        };
        if !oid
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'.')
        {
            return PublisherCheck::EvidenceInvalid;
        }
        observed.push(oid.to_owned());
    }

    if publisher_identity_matches(policy, &observed) {
        PublisherCheck::Matched
    } else {
        PublisherCheck::Mismatch
    }
}

fn installer_invalid() -> UpdateError {
    UpdateError::new(
        "update_installer_invalid",
        "The update installer is invalid.",
    )
}

#[cfg(any(windows, target_os = "macos"))]
fn installer_storage_failed() -> UpdateError {
    UpdateError::new(
        "update_installer_storage_failed",
        "KalCode couldn't safely prepare the update installer.",
    )
}

#[cfg(windows)]
fn authenticode_invalid() -> UpdateError {
    UpdateError::new(
        "update_authenticode_invalid",
        "The update's Windows signature is invalid.",
    )
}

#[cfg(windows)]
fn publisher_policy_invalid() -> UpdateError {
    UpdateError::new(
        "update_publisher_policy_invalid",
        "This KalCode build cannot verify the update publisher.",
    )
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn authenticode_verification_has_no_environment_or_powershell_authority() {
        let source = include_str!("installer.rs");
        let cmdlet = ["Get-Authenti", "codeSignature"].concat();
        let environment = ["System", "Root"].concat();
        let old_resolver = ["resolve_", "powershell"].concat();
        assert!(!source.contains(&cmdlet));
        assert!(!source.contains(&environment));
        assert!(!source.contains(&old_resolver));
    }

    #[test]
    fn authenticode_policy_requires_revocation_and_forbids_no_revocation() {
        let source = include_str!("installer.rs");
        let disabled = ["WTD_REVOKE", "_NONE"].concat();
        assert!(!source.contains(&disabled));

        let mut file_info = WINTRUST_FILE_INFO::default();
        let trust = wintrust_policy(&mut file_info);
        assert_eq!(trust.fdwRevocationChecks, WTD_REVOKE_WHOLECHAIN);
        assert_ne!(
            trust.dwProvFlags & WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT,
            0
        );
        assert_ne!(trust.dwProvFlags & WTD_CACHE_ONLY_URL_RETRIEVAL, 0);
    }

    #[test]
    fn revocation_cache_refresh_is_narrow_and_cumulatively_bounded() {
        use windows_sys::Win32::Security::Cryptography::{
            CERT_CHAIN_CACHE_END_CERT, CERT_CHAIN_DISABLE_AIA,
            CERT_CHAIN_DISABLE_AUTH_ROOT_AUTO_UPDATE, CERT_CHAIN_REVOCATION_ACCUMULATIVE_TIMEOUT,
            CERT_CHAIN_REVOCATION_CHECK_CACHE_ONLY, CERT_CHAIN_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT,
        };

        let policy = revocation_refresh_policy();
        let flags = revocation_refresh_flags();

        assert_eq!(policy.dwUrlRetrievalTimeout, REVOCATION_REFRESH_TIMEOUT_MS);
        assert_ne!(flags & CERT_CHAIN_REVOCATION_ACCUMULATIVE_TIMEOUT, 0);
        assert_ne!(flags & CERT_CHAIN_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT, 0);
        assert_ne!(flags & CERT_CHAIN_CACHE_END_CERT, 0);
        assert_ne!(flags & CERT_CHAIN_DISABLE_AIA, 0);
        assert_ne!(flags & CERT_CHAIN_DISABLE_AUTH_ROOT_AUTO_UPDATE, 0);
        assert_eq!(flags & CERT_CHAIN_REVOCATION_CHECK_CACHE_ONLY, 0);
        assert!(revocation_status_allows_refresh(CRYPT_E_REVOCATION_OFFLINE));
        assert!(revocation_status_allows_refresh(CERT_E_REVOCATION_FAILURE));
        assert!(!revocation_status_allows_refresh(0));
        assert!(!revocation_status_allows_refresh(0x8009_200d_u32 as i32));
        assert!(revocation_refresh_allowed(
            CRYPT_E_REVOCATION_OFFLINE,
            &PublisherCheck::Matched
        ));
        assert!(!revocation_refresh_allowed(
            CRYPT_E_REVOCATION_OFFLINE,
            &PublisherCheck::Mismatch
        ));
        assert!(!revocation_refresh_allowed(
            0x800b_0109_u32 as i32,
            &PublisherCheck::Matched
        ));
    }

    #[test]
    fn publisher_policy_accepts_only_canonical_configured_subscriber_identity_oids() {
        let policy = parse_publisher_policy(Some("1.3.6.1.4.1.311.97.42.7")).unwrap();
        assert!(publisher_identity_matches(
            &policy,
            &[
                "1.3.6.1.5.5.7.3.3",
                "1.3.6.1.4.1.311.97.1.0",
                "1.3.6.1.4.1.311.97.42.7",
            ]
        ));
        assert!(!publisher_identity_matches(
            &policy,
            &["1.3.6.1.5.5.7.3.3", "1.3.6.1.4.1.311.97.42.7",]
        ));
        assert!(!publisher_identity_matches(
            &policy,
            &[
                "1.3.6.1.5.5.7.3.3",
                "1.3.6.1.4.1.311.97.1.0",
                "1.3.6.1.4.1.311.97.42.7",
                "1.3.6.1.4.1.311.97.9001",
            ]
        ));
        assert!(!publisher_identity_matches(
            &policy,
            &["1.3.6.1.4.1.311.97.1.0"]
        ));
        assert!(parse_publisher_policy(None).is_err());
        assert!(parse_publisher_policy(Some("1.3.6.1.4.1.311.97.1.0")).is_err());
        assert!(parse_publisher_policy(Some("1.3.6.1.4.1.311.97.042.7")).is_err());
        assert!(parse_publisher_policy(Some("1.3.6.1.4.1.311.97.42.0.7")).is_ok());
        assert!(
            parse_publisher_policy(Some("1.3.6.1.4.1.311.97.42.7,1.3.6.1.4.1.311.97.9001"))
                .is_err()
        );
    }

    #[test]
    fn native_authenticode_verifier_rejects_an_unsigned_file() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("unsigned.exe");
        fs::write(&path, b"MZ unsigned fixture").unwrap();
        let file = File::open(&path).unwrap();

        let error = verify_authenticode(&file, &path).unwrap_err();

        assert_eq!(error.code(), "update_authenticode_invalid");
    }

    #[test]
    fn native_wintrust_primitive_accepts_an_embedded_signed_binary() {
        let path = signed_signtool_path().expect("signed Windows SDK fixture");
        let file = File::open(&path).unwrap();

        let status = win_verify_trust(&file, &path);

        assert_eq!(status, 0, "WinVerifyTrust status 0x{:08x}", status as u32);
    }

    #[test]
    fn a_different_windows_trusted_publisher_fails_kalcode_identity_policy() {
        let path = signed_signtool_path().expect("signed Windows SDK fixture");
        let file = File::open(&path).unwrap();
        let policy = parse_publisher_policy(Some("1.3.6.1.4.1.311.97.4294967295")).unwrap();

        let result = win_verify_trust_and_publisher(&file, &path, &policy);

        assert_eq!(result, TrustDecision::PublisherMismatch);
    }

    fn signed_signtool_path() -> std::io::Result<PathBuf> {
        let program_files = std::env::var_os("ProgramFiles(x86)").ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "Windows SDK installation root is unavailable",
            )
        })?;
        let bin = Path::new(&program_files)
            .join("Windows Kits")
            .join("10")
            .join("bin");
        let mut candidates = fs::read_dir(bin)?
            .take(128)
            .flatten()
            .map(|entry| entry.path().join("x64").join("signtool.exe"))
            .filter(|path| path.is_file())
            .collect::<Vec<_>>();
        candidates.sort();
        candidates.pop().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "an embedded-signed Windows SDK SignTool is unavailable",
            )
        })
    }

    #[test]
    fn prepared_directory_is_created_one_component_below_a_verified_parent() {
        let temp = tempfile::tempdir().unwrap();
        let prepared = temp.path().join("updates").join("prepared");

        ensure_prepared_directory(&prepared).unwrap();

        assert!(prepared.is_dir());
        reject_reparse(prepared.parent().unwrap()).unwrap();
        reject_reparse(&prepared).unwrap();
    }

    #[test]
    fn prepared_installer_starts_only_once_its_writer_is_closed() {
        let temp = tempfile::tempdir().unwrap();
        let prepared = temp.path().join("updates").join("prepared");
        ensure_prepared_directory(&prepared).unwrap();
        let installer = prepared.join("prepared-launch.exe");
        let windows = std::env::var_os("windir").expect("Windows directory");
        let image = fs::read(Path::new(&windows).join("System32").join("whoami.exe")).unwrap();

        let mut writer = open_prepared_writer(&installer).unwrap();
        writer.write_all(&image).unwrap();
        writer.sync_all().unwrap();
        // 0.1.6 kept this writer open through launch, so Windows refused to start the image.
        let refused = quiet_installer_command(&installer).spawn().unwrap_err();
        assert_eq!(
            refused.raw_os_error(),
            Some(i32::try_from(windows_sys::Win32::Foundation::ERROR_SHARING_VIOLATION).unwrap())
        );

        drop(writer);
        let held = open_prepared_for_launch(&installer).unwrap();
        assert!(
            OpenOptions::new().write(true).open(&installer).is_err(),
            "the held installer must deny writers"
        );
        assert!(
            fs::remove_file(&installer).is_err(),
            "the held installer must deny deletion"
        );
        let status = quiet_installer_command(&installer)
            .spawn()
            .expect("the held read-only installer starts")
            .wait()
            .unwrap();
        assert!(status.code().is_some());
        drop(held);
    }

    fn quiet_installer_command(path: &Path) -> Command {
        let mut command = installer_command(path);
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        command
    }

    #[test]
    fn held_installer_file_prevents_parent_directory_swap() {
        let temp = tempfile::tempdir().unwrap();
        let prepared = temp.path().join("updates").join("prepared");
        ensure_prepared_directory(&prepared).unwrap();
        let installer = prepared.join("prepared-lock.exe");
        fs::write(&installer, b"fixture").unwrap();
        let mut options = OpenOptions::new();
        options.read(true);
        options.share_mode(windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ);
        let held = options.open(&installer).unwrap();

        let replacement = temp.path().join("updates").join("replacement");
        let rename = fs::rename(&prepared, &replacement);

        assert!(
            rename.is_err(),
            "a held installer must deny its parent rename"
        );
        drop(held);
    }

    #[test]
    fn windows_startup_cleanup_removes_only_strict_prepared_files() {
        let temp = tempfile::tempdir().unwrap();
        let prepared = temp.path().join("updates").join("prepared");
        ensure_prepared_directory(&prepared).unwrap();
        let owned = prepared.join("prepared-stale.exe");
        let unrelated = prepared.join("keep.exe");
        let owned_name_directory = prepared.join("prepared-directory.exe");
        fs::write(&owned, b"stale installer").unwrap();
        fs::write(&unrelated, b"owner data").unwrap();
        fs::create_dir(&owned_name_directory).unwrap();
        fs::write(owned_name_directory.join("keep"), b"owner data").unwrap();

        cleanup_startup(&prepared, None).unwrap();

        assert!(!owned.exists());
        assert_eq!(fs::read(&unrelated).unwrap(), b"owner data");
        assert_eq!(
            fs::read(owned_name_directory.join("keep")).unwrap(),
            b"owner data"
        );
    }

    #[test]
    fn cancellable_installer_write_stops_between_bounded_chunks() {
        use std::cell::Cell;

        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("prepared-cancelled.exe");
        let mut file = File::create(&path).unwrap();
        let calls = Cell::new(0_u8);
        let cancel = || {
            calls.set(calls.get() + 1);
            if calls.get() >= 2 {
                Err(UpdateError::new(
                    "update_preparation_cancelled",
                    "Update preparation was cancelled.",
                ))
            } else {
                Ok(())
            }
        };

        let error = write_all_cancellable(&mut file, &[7_u8; 128 * 1024], &cancel).unwrap_err();

        assert_eq!(error.code(), "update_preparation_cancelled");
        assert_eq!(file.metadata().unwrap().len(), 64 * 1024);
    }
}
