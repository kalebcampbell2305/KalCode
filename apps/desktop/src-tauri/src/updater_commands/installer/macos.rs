use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{MetadataExt as _, OpenOptionsExt as _};
use std::os::unix::io::{AsRawFd as _, RawFd};
use std::os::unix::process::CommandExt as _;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use kalcode_updater::mac_swap::{app_executable, process_identity_sha256};
use kalcode_updater::{
    ArtifactFormat, FeedMetadata, InstallBinding, MacSwapAttempt, MacSwapPhase, UpdateError,
    UpdateTarget, verify_download_reader,
};
use sha2::{Digest, Sha256};

use super::{
    ensure_prepared_directory, installer_invalid, installer_storage_failed, is_safe_name,
    reject_reparse, write_all_cancellable,
};

const BUNDLE_IDENTIFIER: &str = "com.kalcode.desktop";
const NOTARIZED_SOURCE: &str = "source=Notarized Developer ID";
const OWNERSHIP_MAGIC: &str = "kalcode-macos-preparation-v1";
const OWNERSHIP_SUFFIX: &str = ".owner";
const LEASE_SUFFIX: &str = ".owner.lock";
const CHILD_POLL_INTERVAL: Duration = Duration::from_millis(20);
const CLEANUP_CHILD_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_CHILD_OUTPUT_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FileIdentity {
    device: u64,
    inode: u64,
}

impl FileIdentity {
    fn from_metadata(metadata: &fs::Metadata) -> Self {
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct PreparationOwnership {
    dmg: FileIdentity,
    lease: FileIdentity,
    mount_directory: FileIdentity,
    mounted_volume: Option<FileIdentity>,
    staged_app: Option<FileIdentity>,
}

struct PreparationLease {
    path: PathBuf,
    file: File,
    identity: FileIdentity,
}

impl PreparationLease {
    fn create(path: &Path) -> Result<Self, UpdateError> {
        let file = OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(path)
            .map_err(|_| installer_storage_failed())?;
        let identity = match file.metadata() {
            Ok(metadata) if metadata.is_file() => FileIdentity::from_metadata(&metadata),
            Ok(_) | Err(_) => {
                drop(file);
                return Err(installer_storage_failed());
            }
        };
        if !matches!(lock_exclusive_nonblocking(&file), Ok(true)) {
            drop(file);
            let _ = remove_owned_regular_file(path, identity);
            return Err(installer_storage_failed());
        }
        if file.sync_all().is_err() {
            drop(file);
            let _ = remove_owned_regular_file(path, identity);
            return Err(installer_storage_failed());
        }
        Ok(Self {
            path: path.to_path_buf(),
            file,
            identity,
        })
    }

    fn acquire_existing(path: &Path, expected: FileIdentity) -> Result<Option<Self>, UpdateError> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(path)
            .map_err(|_| installer_storage_failed())?;
        let metadata = file.metadata().map_err(|_| installer_storage_failed())?;
        if !metadata.is_file() || FileIdentity::from_metadata(&metadata) != expected {
            return Err(installer_storage_failed());
        }
        if !lock_exclusive_nonblocking(&file)? {
            return Ok(None);
        }
        Ok(Some(Self {
            path: path.to_path_buf(),
            file,
            identity: expected,
        }))
    }

    const fn identity(&self) -> FileIdentity {
        self.identity
    }

    fn raw_fd(&self) -> RawFd {
        self.file.as_raw_fd()
    }
}

#[allow(unsafe_code)]
fn lock_exclusive_nonblocking(file: &File) -> Result<bool, UpdateError> {
    // SAFETY: `file` owns a live descriptor. `flock` changes only its advisory lock state.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::EWOULDBLOCK) {
        Ok(false)
    } else {
        Err(installer_storage_failed())
    }
}

#[allow(unsafe_code)]
fn inherit_lease(command: &mut Command, lease: &PreparationLease) {
    let descriptor = lease.raw_fd();
    // SAFETY: the closure performs only async-signal-safe `fcntl` calls on a descriptor that
    // remains owned by `lease` until spawn completes. Clearing close-on-exec only in the child
    // makes the advisory lock survive a hard parent crash until that exact child exits.
    unsafe {
        command.pre_exec(move || {
            let flags = libc::fcntl(descriptor, libc::F_GETFD);
            if flags < 0 || libc::fcntl(descriptor, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

pub(super) struct PreparedMacInstaller {
    dmg_path: PathBuf,
    dmg_identity: FileIdentity,
    staged_app: PathBuf,
    staged_identity: FileIdentity,
    current_app: PathBuf,
    helper_path: PathBuf,
    journal_path: PathBuf,
    parent_pid: u32,
    parent_identity_sha256: String,
    designated_requirement: String,
    from_version: String,
    to_version: String,
    binding: InstallBinding,
    ownership_path: PathBuf,
    ownership_identity: FileIdentity,
    lease: Option<PreparationLease>,
    launched: bool,
}

impl PreparedMacInstaller {
    pub(super) fn prepare(
        root: &Path,
        name: &str,
        bytes: &[u8],
        metadata: &FeedMetadata,
        expected_version: &str,
        current_version: &str,
        cancel: &dyn Fn() -> Result<(), UpdateError>,
    ) -> Result<Self, UpdateError> {
        cancel()?;
        if metadata.target != UpdateTarget::DarwinAarch64
            || metadata.format != ArtifactFormat::Dmg
            || !name.ends_with(".dmg")
        {
            return Err(installer_invalid());
        }
        ensure_prepared_directory(root)?;
        cancel()?;
        if !is_safe_name(name) {
            return Err(installer_invalid());
        }
        let id = prepared_id(name).ok_or_else(installer_invalid)?;
        let dmg_path = root.join(name);
        if dmg_path.parent() != Some(root) {
            return Err(installer_invalid());
        }
        let ownership_path = root.join(format!("{name}{OWNERSHIP_SUFFIX}"));
        let lease_path = root.join(format!("{name}{LEASE_SUFFIX}"));
        let mount_path = root.join(format!("{name}.mount"));
        if ownership_path.parent() != Some(root)
            || lease_path.parent() != Some(root)
            || fs::symlink_metadata(&ownership_path).is_ok()
            || fs::symlink_metadata(&lease_path).is_ok()
        {
            return Err(installer_storage_failed());
        }
        let mut dmg = OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .mode(0o600)
            .open(&dmg_path)
            .map_err(|_| installer_storage_failed())?;
        let dmg_identity = match file_identity(&dmg_path, FileKind::RegularFile) {
            Ok(identity) => identity,
            Err(error) => {
                drop(dmg);
                return Err(error);
            }
        };
        let mut lease = match PreparationLease::create(&lease_path) {
            Ok(lease) => Some(lease),
            Err(error) => {
                drop(dmg);
                let _ = remove_owned_regular_file(&dmg_path, dmg_identity);
                return Err(error);
            }
        };
        let mut staged_created: Option<(PathBuf, PathBuf, FileIdentity)> = None;
        let mut ownership_created: Option<FileIdentity> = None;
        let mut current_app_for_cleanup = None;
        let prepared = (|| {
            let active_lease = lease.as_ref().ok_or_else(installer_storage_failed)?;
            reject_reparse(root)?;
            write_all_cancellable(&mut dmg, bytes, cancel)?;
            dmg.sync_all().map_err(|_| installer_storage_failed())?;
            cancel()?;
            dmg.seek(SeekFrom::Start(0))
                .map_err(|_| installer_storage_failed())?;
            verify_download_reader(&mut dmg, metadata)?;
            cancel()?;
            verify_dmg(&dmg_path, active_lease, cancel)?;
            cancel()?;

            let current_app = current_app_bundle()?;
            current_app_for_cleanup = Some(current_app.clone());
            let current_identity = verify_app(&current_app, current_version, active_lease, cancel)?;
            let current_executable = app_executable(&current_app);
            let source_sha256 = digest_file(&current_executable, cancel)?;
            let helper_path = current_app
                .join("Contents")
                .join("MacOS")
                .join("kalcode-update-helper");
            require_regular_file(&helper_path)?;
            cancel()?;

            fs::create_dir(&mount_path).map_err(|_| installer_storage_failed())?;
            let mount_directory = file_identity(&mount_path, FileKind::Directory)?;
            let mut ownership = PreparationOwnership {
                dmg: dmg_identity,
                lease: active_lease.identity(),
                mount_directory,
                mounted_volume: None,
                staged_app: None,
            };
            write_ownership_record(&ownership_path, &ownership)?;
            let mut ownership_identity = file_identity(&ownership_path, FileKind::RegularFile)?;
            ownership_created = Some(ownership_identity);

            let mounted = MountedDmg::attach(
                &dmg_path,
                &mount_path,
                mount_directory,
                active_lease,
                cancel,
            )?;
            ownership.mounted_volume = mounted.volume_identity();
            ownership_identity =
                replace_ownership_record(&ownership_path, ownership_identity, &ownership)?;
            ownership_created = Some(ownership_identity);
            let candidate_app = mounted.path().join("KalCode.app");
            let candidate_identity =
                verify_app(&candidate_app, expected_version, active_lease, cancel)?;
            if candidate_identity != current_identity {
                return Err(identity_mismatch());
            }

            let parent = current_app.parent().ok_or_else(installer_invalid)?;
            let staged_app = parent.join(format!(".KalCode-update-{id}.app"));
            // Claim this exact sibling atomically before copying. Cleanup authority begins only
            // after this succeeds, so a preexisting owner path is never removed on failure.
            create_staged_app(&current_app, &staged_app)?;
            let staged_identity = match file_identity(&staged_app, FileKind::Directory) {
                Ok(identity) => identity,
                Err(error) => {
                    let _ = fs::remove_dir(&staged_app);
                    return Err(error);
                }
            };
            staged_created = Some((current_app.clone(), staged_app.clone(), staged_identity));
            ownership.staged_app = Some(staged_identity);
            ownership_identity =
                replace_ownership_record(&ownership_path, ownership_identity, &ownership)?;
            ownership_created = Some(ownership_identity);
            cancel()?;

            let mut copy = Command::new("/usr/bin/ditto");
            copy.args([OsStr::new("--rsrc"), OsStr::new("--extattr")])
                .arg(&candidate_app)
                .arg(&staged_app);
            if !run_cancellable_status(
                &mut copy,
                Some(active_lease),
                cancel,
                installer_storage_failed,
            )?
            .success()
            {
                return Err(installer_storage_failed());
            }
            cancel()?;
            if verify_app(&staged_app, expected_version, active_lease, cancel)? != current_identity
            {
                return Err(identity_mismatch());
            }
            mounted.detach(active_lease, cancel)?;
            cancel()?;

            let parent_pid = std::process::id();
            let parent_identity_sha256 = process_identity_sha256(parent_pid)?;
            cancel()?;
            let signing_requirement_sha256 =
                format!("{:x}", Sha256::digest(current_identity.as_bytes()));
            let journal_path = root
                .parent()
                .ok_or_else(installer_storage_failed)?
                .join("updater.json");
            Ok(Self {
                dmg_path: dmg_path.clone(),
                dmg_identity,
                staged_app,
                staged_identity,
                current_app,
                helper_path,
                journal_path,
                parent_pid,
                parent_identity_sha256,
                designated_requirement: current_identity,
                from_version: current_version.to_owned(),
                to_version: expected_version.to_owned(),
                binding: InstallBinding {
                    target: UpdateTarget::DarwinAarch64,
                    source_sha256,
                    signing_requirement_sha256,
                },
                ownership_path: ownership_path.clone(),
                ownership_identity,
                lease: lease.take(),
                launched: false,
            })
        })();
        if prepared.is_err() {
            drop(dmg);
            let lease_identity = lease.as_ref().map(PreparationLease::identity);
            let owner_identity = ownership_created;
            let recorded_cleanup = owner_identity.and_then(|owner_identity| {
                let ownership = read_ownership_record(&ownership_path).ok()?;
                let current = current_app_for_cleanup.as_ref()?;
                let staged = current.parent()?.join(format!(".KalCode-update-{id}.app"));
                let cleanup_lease = lease.take()?;
                Some(cleanup_owned_preparation(
                    current,
                    &dmg_path,
                    &mount_path,
                    &staged,
                    &ownership_path,
                    owner_identity,
                    &ownership,
                    cleanup_lease,
                ))
            });
            if !matches!(recorded_cleanup, Some(Ok(())))
                && fs::symlink_metadata(&mount_path)
                    .is_err_and(|error| error.kind() == io::ErrorKind::NotFound)
            {
                if let Some((current, staged, identity)) = staged_created.as_ref() {
                    let _ = remove_owned_staged_app(current, staged, *identity);
                }
                let _ = remove_owned_regular_file(&dmg_path, dmg_identity);
                if let Some(owner_identity) = owner_identity {
                    let _ = remove_owned_regular_file(&ownership_path, owner_identity);
                }
                drop(lease.take());
                if let Some(lease_identity) = lease_identity {
                    let _ = remove_owned_regular_file(&lease_path, lease_identity);
                }
            } else {
                // A mount still exists or recorded cleanup could not prove completion. Keep every
                // surviving identity record for the next startup sweep.
                drop(lease.take());
            }
        }
        prepared
    }

    pub(super) fn dmg_path(&self) -> &Path {
        &self.dmg_path
    }

    pub(super) const fn binding(&self) -> &InstallBinding {
        &self.binding
    }

    pub(super) fn swap_attempt(&self) -> MacSwapAttempt {
        MacSwapAttempt {
            current_app: self.current_app.clone(),
            staged_app: self.staged_app.clone(),
            parent_pid: self.parent_pid,
            parent_identity_sha256: self.parent_identity_sha256.clone(),
            phase: MacSwapPhase::Prepared,
        }
    }

    pub(super) fn launch(mut self) -> Result<(), UpdateError> {
        let lease = self.lease.as_ref().ok_or_else(installer_invalid)?;
        if process_identity_sha256(self.parent_pid)? != self.parent_identity_sha256
            || verify_app(&self.current_app, &self.from_version, lease, &not_cancelled)?
                != self.designated_requirement
            || verify_app(&self.staged_app, &self.to_version, lease, &not_cancelled)?
                != self.designated_requirement
        {
            return Err(identity_mismatch());
        }
        let mut command = Command::new(&self.helper_path);
        command.arg("--journal").arg(&self.journal_path);
        let child = command.spawn().map_err(|_| {
            UpdateError::new(
                "update_launch_failed",
                "The verified installer couldn't start.",
            )
        })?;
        drop(child);
        self.launched = true;
        Ok(())
    }
}

impl Drop for PreparedMacInstaller {
    fn drop(&mut self) {
        if !self.launched {
            let _ =
                remove_owned_staged_app(&self.current_app, &self.staged_app, self.staged_identity);
            let _ = remove_owned_regular_file(&self.dmg_path, self.dmg_identity);
            let _ = remove_owned_regular_file(&self.ownership_path, self.ownership_identity);
            let lease_path = self.lease.as_ref().map(|lease| lease.path.clone());
            let lease_identity = self.lease.as_ref().map(PreparationLease::identity);
            drop(self.lease.take());
            if let (Some(path), Some(identity)) = (lease_path, lease_identity) {
                let _ = remove_owned_regular_file(&path, identity);
            }
        }
    }
}

struct MountedDmg {
    path: PathBuf,
    directory_identity: FileIdentity,
    volume_identity: Option<FileIdentity>,
    may_be_attached: bool,
}

impl MountedDmg {
    fn attach(
        dmg: &Path,
        mount_path: &Path,
        directory_identity: FileIdentity,
        lease: &PreparationLease,
        cancel: &dyn Fn() -> Result<(), UpdateError>,
    ) -> Result<Self, UpdateError> {
        if file_identity(mount_path, FileKind::Directory)? != directory_identity {
            return Err(installer_storage_failed());
        }
        let mut mounted = Self {
            path: mount_path.to_path_buf(),
            directory_identity,
            volume_identity: None,
            // An interrupted attach can complete its mount before the child reports status. The
            // guard therefore always attempts a bounded detach after the child is spawned.
            may_be_attached: true,
        };
        let mut command = Command::new("/usr/bin/hdiutil");
        command
            .args([
                "attach",
                "-readonly",
                "-nobrowse",
                "-noautoopen",
                "-mountpoint",
            ])
            .arg(mount_path)
            .arg(dmg);
        if !run_cancellable_status(&mut command, Some(lease), cancel, installer_invalid)?.success()
        {
            return Err(installer_invalid());
        }
        let volume_identity = file_identity(mount_path, FileKind::Directory)?;
        if volume_identity == mounted.directory_identity {
            return Err(installer_invalid());
        }
        mounted.volume_identity = Some(volume_identity);
        cancel()?;
        Ok(mounted)
    }

    fn path(&self) -> &Path {
        &self.path
    }

    const fn volume_identity(&self) -> Option<FileIdentity> {
        self.volume_identity
    }

    fn detach(
        mut self,
        lease: &PreparationLease,
        cancel: &dyn Fn() -> Result<(), UpdateError>,
    ) -> Result<(), UpdateError> {
        let volume_identity = self.volume_identity.ok_or_else(installer_storage_failed)?;
        if file_identity(&self.path, FileKind::Directory)? != volume_identity {
            return Err(installer_storage_failed());
        }
        detach_mount(&self.path, Some(lease), cancel)?;
        self.may_be_attached = false;
        let identity = file_identity(&self.path, FileKind::Directory)?;
        if identity != self.directory_identity {
            return Err(installer_storage_failed());
        }
        fs::remove_dir(&self.path).map_err(|_| installer_storage_failed())
    }
}

impl Drop for MountedDmg {
    fn drop(&mut self) {
        if self.may_be_attached
            && self.volume_identity.is_some_and(|volume| {
                file_identity(&self.path, FileKind::Directory).ok() == Some(volume)
            })
        {
            let started = Instant::now();
            let bounded = || {
                if started.elapsed() < CLEANUP_CHILD_TIMEOUT {
                    Ok(())
                } else {
                    Err(installer_storage_failed())
                }
            };
            let _ = detach_mount(&self.path, None, &bounded);
        }
        if file_identity(&self.path, FileKind::Directory).ok() == Some(self.directory_identity) {
            let _ = fs::remove_dir(&self.path);
        }
    }
}

#[derive(Clone, Copy)]
enum FileKind {
    RegularFile,
    Directory,
}

fn file_identity(path: &Path, expected: FileKind) -> Result<FileIdentity, UpdateError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| installer_storage_failed())?;
    let matches = match expected {
        FileKind::RegularFile => metadata.is_file(),
        FileKind::Directory => metadata.is_dir(),
    };
    if !matches || metadata.file_type().is_symlink() {
        return Err(installer_storage_failed());
    }
    Ok(FileIdentity::from_metadata(&metadata))
}

fn prepared_id(name: &str) -> Option<&str> {
    let id = name.strip_prefix("prepared-")?.strip_suffix(".dmg")?;
    (!id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'))
    .then_some(id)
}

fn ownership_id(name: &str) -> Option<&str> {
    prepared_id(name.strip_suffix(OWNERSHIP_SUFFIX)?)
}

fn write_ownership_record(
    path: &Path,
    ownership: &PreparationOwnership,
) -> Result<(), UpdateError> {
    let bytes = ownership_record_bytes(ownership);
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)
        .map_err(|_| installer_storage_failed())?;
    file.write_all(bytes.as_bytes())
        .map_err(|_| installer_storage_failed())?;
    file.sync_all().map_err(|_| installer_storage_failed())?;
    sync_parent(path)?;
    Ok(())
}

fn ownership_record_bytes(ownership: &PreparationOwnership) -> String {
    let mounted = ownership.mounted_volume.unwrap_or(FileIdentity {
        device: 0,
        inode: 0,
    });
    let staged = ownership.staged_app.unwrap_or(FileIdentity {
        device: 0,
        inode: 0,
    });
    format!(
        "{OWNERSHIP_MAGIC}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n",
        ownership.dmg.device,
        ownership.dmg.inode,
        ownership.lease.device,
        ownership.lease.inode,
        ownership.mount_directory.device,
        ownership.mount_directory.inode,
        mounted.device,
        mounted.inode,
        staged.device,
        staged.inode,
    )
}

fn sync_parent(path: &Path) -> Result<(), UpdateError> {
    let parent = path.parent().ok_or_else(installer_storage_failed)?;
    let directory = File::open(parent).map_err(|_| installer_storage_failed())?;
    directory.sync_all().map_err(|_| installer_storage_failed())
}

fn replace_ownership_record(
    path: &Path,
    expected: FileIdentity,
    ownership: &PreparationOwnership,
) -> Result<FileIdentity, UpdateError> {
    if file_identity(path, FileKind::RegularFile)? != expected {
        return Err(installer_storage_failed());
    }
    let next = path.with_extension("owner.next");
    if fs::symlink_metadata(&next).is_ok() {
        return Err(installer_storage_failed());
    }
    let bytes = ownership_record_bytes(ownership);
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&next)
        .map_err(|_| installer_storage_failed())?;
    file.write_all(bytes.as_bytes())
        .map_err(|_| installer_storage_failed())?;
    file.sync_all().map_err(|_| installer_storage_failed())?;
    let next_identity =
        FileIdentity::from_metadata(&file.metadata().map_err(|_| installer_storage_failed())?);
    drop(file);
    if file_identity(path, FileKind::RegularFile)? != expected {
        let _ = remove_owned_regular_file(&next, next_identity);
        return Err(installer_storage_failed());
    }
    fs::rename(&next, path).map_err(|_| installer_storage_failed())?;
    sync_parent(path)?;
    file_identity(path, FileKind::RegularFile)
}

fn read_ownership_record(path: &Path) -> Result<PreparationOwnership, UpdateError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| installer_storage_failed())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 512 {
        return Err(installer_storage_failed());
    }
    let mut file = File::open(path).map_err(|_| installer_storage_failed())?;
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(0));
    Read::by_ref(&mut file)
        .take(513)
        .read_to_end(&mut bytes)
        .map_err(|_| installer_storage_failed())?;
    if bytes.len() > 512 {
        return Err(installer_storage_failed());
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| installer_storage_failed())?;
    let mut lines = text.lines();
    if lines.next() != Some(OWNERSHIP_MAGIC) {
        return Err(installer_storage_failed());
    }
    let mut next_number = || {
        lines
            .next()
            .and_then(|line| line.parse::<u64>().ok())
            .ok_or_else(installer_storage_failed)
    };
    let optional_identity = |device, inode| match (device, inode) {
        (0, 0) => Ok(None),
        (0, _) | (_, 0) => Err(installer_storage_failed()),
        (device, inode) => Ok(Some(FileIdentity { device, inode })),
    };
    let ownership = PreparationOwnership {
        dmg: FileIdentity {
            device: next_number()?,
            inode: next_number()?,
        },
        lease: FileIdentity {
            device: next_number()?,
            inode: next_number()?,
        },
        mount_directory: FileIdentity {
            device: next_number()?,
            inode: next_number()?,
        },
        mounted_volume: optional_identity(next_number()?, next_number()?)?,
        staged_app: optional_identity(next_number()?, next_number()?)?,
    };
    if lines.next().is_some()
        || ownership
            .mounted_volume
            .is_some_and(|mounted| mounted == ownership.mount_directory)
    {
        return Err(installer_storage_failed());
    }
    Ok(ownership)
}

pub(super) fn cleanup_startup(
    root: &Path,
    protected: Option<&MacSwapAttempt>,
) -> Result<bool, UpdateError> {
    ensure_prepared_directory(root)?;
    let current_app = current_app_bundle()?;
    let current_parent = current_app.parent().ok_or_else(installer_storage_failed)?;
    // Both the installed bundle and its parent are ancestors of every staged bundle deletion.
    // Refuse cleanup if either can redirect traversal.
    file_identity(current_parent, FileKind::Directory)?;
    file_identity(&current_app, FileKind::Directory)?;

    let entries = fs::read_dir(root).map_err(|_| installer_storage_failed())?;
    let mut live_preparation = false;
    for entry in entries {
        let entry = entry.map_err(|_| installer_storage_failed())?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(id) = ownership_id(name) else {
            continue;
        };
        let ownership_path = entry.path();
        if ownership_path.parent() != Some(root) {
            continue;
        }
        let ownership_file_identity = file_identity(&ownership_path, FileKind::RegularFile)?;
        let ownership = read_ownership_record(&ownership_path)?;
        let dmg_path = root.join(format!("prepared-{id}.dmg"));
        let mount_path = root.join(format!("prepared-{id}.dmg.mount"));
        let lease_path = root.join(format!("prepared-{id}.dmg{LEASE_SUFFIX}"));
        let staged_app = current_parent.join(format!(".KalCode-update-{id}.app"));
        let Some(cleanup_lease) = PreparationLease::acquire_existing(&lease_path, ownership.lease)?
        else {
            // The previous parent or one of its inherited native children is still operating on
            // this exact preparation. Never race its copy, mount, verification, or handoff.
            live_preparation = true;
            continue;
        };
        if is_protected_staged(&current_app, &staged_app, protected) {
            continue;
        }
        cleanup_owned_preparation(
            &current_app,
            &dmg_path,
            &mount_path,
            &staged_app,
            &ownership_path,
            ownership_file_identity,
            &ownership,
            cleanup_lease,
        )?;
    }
    if live_preparation {
        Ok(false)
    } else {
        Ok(true)
    }
}

fn is_protected_staged(
    current_app: &Path,
    staged_app: &Path,
    protected: Option<&MacSwapAttempt>,
) -> bool {
    protected.is_some_and(|swap| {
        swap.current_app == current_app
            && swap.staged_app == staged_app
            && kalcode_updater::mac_swap::validate_swap_paths(&swap.current_app, &swap.staged_app)
                .is_ok()
    })
}

#[allow(clippy::too_many_arguments)]
fn cleanup_owned_preparation(
    current_app: &Path,
    dmg_path: &Path,
    mount_path: &Path,
    staged_app: &Path,
    ownership_path: &Path,
    ownership_file_identity: FileIdentity,
    ownership: &PreparationOwnership,
    cleanup_lease: PreparationLease,
) -> Result<(), UpdateError> {
    kalcode_updater::mac_swap::validate_swap_paths(current_app, staged_app)?;
    let dmg_identity = optional_identity(dmg_path, FileKind::RegularFile)?;
    let mount_identity = optional_identity(mount_path, FileKind::Directory)?;
    let staged_identity = optional_identity(staged_app, FileKind::Directory)?;
    if dmg_identity.is_some_and(|identity| identity != ownership.dmg)
        || mount_identity.is_some_and(|identity| {
            identity != ownership.mount_directory
                && ownership.mounted_volume != Some(identity)
                && ownership.mounted_volume.is_some()
        })
        || staged_identity.is_some_and(|identity| ownership.staged_app != Some(identity))
    {
        return Err(installer_storage_failed());
    }

    let unrecorded_owned_mount = mount_identity.is_some_and(|identity| {
        identity != ownership.mount_directory && ownership.mounted_volume.is_none()
    });
    if unrecorded_owned_mount && !hdiutil_mount_matches(dmg_path, mount_path, &cleanup_lease)? {
        return Err(installer_storage_failed());
    }
    if ownership
        .mounted_volume
        .is_some_and(|owned| mount_identity == Some(owned))
        || unrecorded_owned_mount
    {
        let started = Instant::now();
        let bounded = || {
            if started.elapsed() < CLEANUP_CHILD_TIMEOUT {
                Ok(())
            } else {
                Err(installer_storage_failed())
            }
        };
        detach_mount(mount_path, Some(&cleanup_lease), &bounded)?;
        if file_identity(mount_path, FileKind::Directory)? != ownership.mount_directory {
            return Err(installer_storage_failed());
        }
    }
    if optional_identity(mount_path, FileKind::Directory)? == Some(ownership.mount_directory) {
        fs::remove_dir(mount_path).map_err(|_| installer_storage_failed())?;
    }
    if let Some(staged_identity) = ownership.staged_app
        && optional_identity(staged_app, FileKind::Directory)? == Some(staged_identity)
    {
        remove_owned_staged_app(current_app, staged_app, staged_identity)?;
    }
    remove_owned_regular_file(dmg_path, ownership.dmg)?;
    remove_owned_regular_file(ownership_path, ownership_file_identity)?;
    let lease_path = cleanup_lease.path.clone();
    let lease_identity = cleanup_lease.identity();
    drop(cleanup_lease);
    remove_owned_regular_file(&lease_path, lease_identity)
}

fn optional_identity(path: &Path, expected: FileKind) -> Result<Option<FileIdentity>, UpdateError> {
    match fs::symlink_metadata(path) {
        Ok(_) => file_identity(path, expected).map(Some),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(installer_storage_failed()),
    }
}

fn remove_owned_regular_file(path: &Path, expected: FileIdentity) -> Result<(), UpdateError> {
    let Some(identity) = optional_identity(path, FileKind::RegularFile)? else {
        return Ok(());
    };
    if expected != identity {
        return Err(installer_storage_failed());
    }
    fs::remove_file(path).map_err(|_| installer_storage_failed())
}

fn hdiutil_mount_matches(
    dmg: &Path,
    mount: &Path,
    lease: &PreparationLease,
) -> Result<bool, UpdateError> {
    let safe_text_path = |value: &&str| !value.bytes().any(|byte| matches!(byte, b'\r' | b'\n'));
    let dmg = dmg.to_str().filter(safe_text_path);
    let mount = mount.to_str().filter(safe_text_path);
    let (Some(dmg), Some(mount)) = (dmg, mount) else {
        return Ok(false);
    };
    let started = Instant::now();
    let bounded = || {
        if started.elapsed() < CLEANUP_CHILD_TIMEOUT {
            Ok(())
        } else {
            Err(installer_storage_failed())
        }
    };
    let output = checked_cancellable(
        Command::new("/usr/bin/hdiutil").arg("info"),
        lease,
        &bounded,
    )?;
    let text = combined_text(&output)?;
    Ok(text
        .split("================================================")
        .any(|section| {
            let exact_image = section.lines().any(|line| {
                line.split_once(':')
                    .is_some_and(|(key, value)| key.trim() == "image-path" && value.trim() == dmg)
            });
            let read_only = section.lines().any(|line| {
                line.split_once(':').is_some_and(|(key, value)| {
                    key.trim() == "image-type" && value.trim().contains("read-only")
                })
            });
            let exact_mount = section.lines().any(|line| {
                line.strip_suffix(mount)
                    .and_then(|prefix| prefix.chars().last())
                    .is_some_and(char::is_whitespace)
            });
            exact_image && read_only && exact_mount
        }))
}

fn detach_mount(
    path: &Path,
    lease: Option<&PreparationLease>,
    cancel: &dyn Fn() -> Result<(), UpdateError>,
) -> Result<(), UpdateError> {
    let mut command = Command::new("/usr/bin/hdiutil");
    command.arg("detach").arg(path).arg("-quiet");
    if run_cancellable_status(&mut command, lease, cancel, installer_storage_failed)?.success() {
        Ok(())
    } else {
        Err(installer_storage_failed())
    }
}

fn run_cancellable_status(
    command: &mut Command,
    lease: Option<&PreparationLease>,
    cancel: &dyn Fn() -> Result<(), UpdateError>,
    command_error: fn() -> UpdateError,
) -> Result<ExitStatus, UpdateError> {
    cancel()?;
    if let Some(lease) = lease {
        inherit_lease(command, lease);
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| command_error())?;
    loop {
        if let Err(error) = cancel() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => thread::sleep(CHILD_POLL_INTERVAL),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(command_error());
            }
        }
    }
}

fn checked_cancellable(
    command: &mut Command,
    lease: &PreparationLease,
    cancel: &dyn Fn() -> Result<(), UpdateError>,
) -> Result<Output, UpdateError> {
    cancel()?;
    inherit_lease(command, lease);
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| installer_invalid())?;
    let stdout = child.stdout.take().ok_or_else(installer_invalid)?;
    let stderr = child.stderr.take().ok_or_else(installer_invalid)?;
    let stdout_reader = thread::spawn(move || read_bounded_output(stdout));
    let stderr_reader = thread::spawn(move || read_bounded_output(stderr));

    let status = loop {
        if let Err(error) = cancel() {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(error);
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => thread::sleep(CHILD_POLL_INTERVAL),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(installer_invalid());
            }
        }
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| installer_invalid())?
        .map_err(|_| installer_invalid())?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| installer_invalid())?
        .map_err(|_| installer_invalid())?;
    if status.success()
        && stdout.len() <= MAX_CHILD_OUTPUT_BYTES
        && stderr.len() <= MAX_CHILD_OUTPUT_BYTES
    {
        Ok(Output {
            status,
            stdout,
            stderr,
        })
    } else {
        Err(installer_invalid())
    }
}

fn read_bounded_output(mut reader: impl Read) -> io::Result<Vec<u8>> {
    let mut kept = Vec::new();
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            return Ok(kept);
        }
        let remaining = MAX_CHILD_OUTPUT_BYTES
            .saturating_add(1)
            .saturating_sub(kept.len());
        kept.extend_from_slice(&buffer[..read.min(remaining)]);
    }
}

fn not_cancelled() -> Result<(), UpdateError> {
    Ok(())
}

fn verify_dmg(
    path: &Path,
    lease: &PreparationLease,
    cancel: &dyn Fn() -> Result<(), UpdateError>,
) -> Result<(), UpdateError> {
    checked_cancellable(
        Command::new("/usr/bin/hdiutil").arg("verify").arg(path),
        lease,
        cancel,
    )?;
    let assessment = checked_cancellable(
        Command::new("/usr/sbin/spctl")
            .args([
                "--assess",
                "--type",
                "open",
                "--context",
                "context:primary-signature",
                "--verbose=4",
            ])
            .arg(path),
        lease,
        cancel,
    )?;
    require_notarized(&assessment)
}

fn verify_app(
    path: &Path,
    expected_version: &str,
    lease: &PreparationLease,
    cancel: &dyn Fn() -> Result<(), UpdateError>,
) -> Result<String, UpdateError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| installer_invalid())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(installer_invalid());
    }
    checked_cancellable(
        Command::new("/usr/bin/codesign")
            .args(["--verify", "--deep", "--strict", "--verbose=2"])
            .arg(path),
        lease,
        cancel,
    )?;
    let assessment = checked_cancellable(
        Command::new("/usr/sbin/spctl")
            .args(["--assess", "--type", "execute", "--verbose=4"])
            .arg(path),
        lease,
        cancel,
    )?;
    require_notarized(&assessment)?;

    let details = checked_cancellable(
        Command::new("/usr/bin/codesign")
            .args(["-d", "--verbose=4"])
            .arg(path),
        lease,
        cancel,
    )?;
    let details = combined_text(&details)?;
    let identifier = details
        .lines()
        .find_map(|line| line.strip_prefix("Identifier="))
        .ok_or_else(installer_invalid)?;
    if identifier != BUNDLE_IDENTIFIER {
        return Err(identity_mismatch());
    }
    let version = checked_cancellable(
        Command::new("/usr/bin/plutil")
            .args(["-extract", "CFBundleShortVersionString", "raw", "-o", "-"])
            .arg(path.join("Contents").join("Info.plist")),
        lease,
        cancel,
    )?;
    if std::str::from_utf8(&version.stdout)
        .map_err(|_| installer_invalid())?
        .trim()
        != expected_version
    {
        return Err(installer_invalid());
    }

    let requirement = checked_cancellable(
        Command::new("/usr/bin/codesign")
            .args(["-d", "-r-"])
            .arg(path),
        lease,
        cancel,
    )?;
    let requirement = combined_text(&requirement)?
        .lines()
        .find_map(|line| line.strip_prefix("designated => "))
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 16 * 1024)
        .ok_or_else(installer_invalid)?
        .to_owned();

    let executable = app_executable(path);
    require_regular_file(&executable)?;
    let architectures = checked_cancellable(
        Command::new("/usr/bin/lipo").arg("-archs").arg(&executable),
        lease,
        cancel,
    )?;
    let architectures = std::str::from_utf8(&architectures.stdout)
        .map_err(|_| installer_invalid())?
        .split_whitespace()
        .collect::<Vec<_>>();
    if architectures.as_slice() != ["arm64"] {
        return Err(installer_invalid());
    }
    Ok(requirement)
}

fn combined_text(output: &Output) -> Result<String, UpdateError> {
    let mut bytes = output.stdout.clone();
    bytes.extend_from_slice(&output.stderr);
    String::from_utf8(bytes).map_err(|_| installer_invalid())
}

fn require_notarized(output: &Output) -> Result<(), UpdateError> {
    if combined_text(output)?
        .lines()
        .any(|line| line.trim() == NOTARIZED_SOURCE)
    {
        Ok(())
    } else {
        Err(UpdateError::new(
            "update_notarization_invalid",
            "The macOS update isn't notarized by Apple.",
        ))
    }
}

fn current_app_bundle() -> Result<PathBuf, UpdateError> {
    let executable = std::env::current_exe().map_err(|_| installer_invalid())?;
    executable
        .ancestors()
        .find(|path| path.file_name().and_then(|name| name.to_str()) == Some("KalCode.app"))
        .map(Path::to_path_buf)
        .ok_or_else(installer_invalid)
}

fn require_regular_file(path: &Path) -> Result<(), UpdateError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| installer_invalid())?;
    if metadata.is_file() && !metadata.file_type().is_symlink() {
        Ok(())
    } else {
        Err(installer_invalid())
    }
}

fn digest_file(
    path: &Path,
    cancel: &dyn Fn() -> Result<(), UpdateError>,
) -> Result<String, UpdateError> {
    let mut file = File::open(path).map_err(|_| installer_invalid())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        cancel()?;
        let read = file.read(&mut buffer).map_err(|_| installer_invalid())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    cancel()?;
    Ok(format!("{:x}", hasher.finalize()))
}

fn create_staged_app(current: &Path, staged: &Path) -> Result<(), UpdateError> {
    kalcode_updater::mac_swap::validate_swap_paths(current, staged)?;
    fs::create_dir(staged).map_err(staged_app_create_error)
}

fn staged_app_create_error(error: io::Error) -> UpdateError {
    match error.kind() {
        io::ErrorKind::PermissionDenied | io::ErrorKind::ReadOnlyFilesystem => UpdateError::new(
            "update_install_location_unwritable",
            "KalCode can't update this install location. Standard users should install KalCode in ~/Applications. If KalCode is in /Applications, replace it manually using an administrator account.",
        ),
        _ => installer_storage_failed(),
    }
}

fn remove_staged_app(current: &Path, staged: &Path) -> Result<(), UpdateError> {
    kalcode_updater::mac_swap::validate_swap_paths(current, staged)?;
    let metadata = match fs::symlink_metadata(staged) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(installer_storage_failed()),
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(installer_storage_failed());
    }
    fs::remove_dir_all(staged).map_err(|_| installer_storage_failed())
}

fn remove_owned_staged_app(
    current: &Path,
    staged: &Path,
    expected: FileIdentity,
) -> Result<(), UpdateError> {
    kalcode_updater::mac_swap::validate_swap_paths(current, staged)?;
    let Some(identity) = optional_identity(staged, FileKind::Directory)? else {
        return Ok(());
    };
    if identity != expected {
        return Err(installer_storage_failed());
    }
    // Recheck immediately before recursive removal. `remove_dir_all` removes links as links on
    // macOS; it does not traverse a symlink substituted for the staged root.
    if file_identity(staged, FileKind::Directory)? != expected {
        return Err(installer_storage_failed());
    }
    fs::remove_dir_all(staged).map_err(|_| installer_storage_failed())
}

fn identity_mismatch() -> UpdateError {
    UpdateError::new(
        "update_signing_identity_mismatch",
        "The update isn't signed by the installed KalCode identity.",
    )
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::fs;
    use std::io;
    use std::os::unix::fs::PermissionsExt as _;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::{Duration, Instant};

    use tempfile::tempdir;

    use super::{
        FileIdentity, FileKind, PreparationLease, PreparationOwnership, cleanup_owned_preparation,
        create_staged_app, file_identity, inherit_lease, is_protected_staged,
        read_ownership_record, remove_staged_app, replace_ownership_record, run_cancellable_status,
        staged_app_create_error, write_ownership_record,
    };

    struct RestorePermissions {
        path: PathBuf,
        permissions: fs::Permissions,
    }

    impl RestorePermissions {
        fn restrict(path: &Path) -> io::Result<Self> {
            let permissions = fs::metadata(path)?.permissions();
            fs::set_permissions(path, fs::Permissions::from_mode(0o555))?;
            Ok(Self {
                path: path.to_path_buf(),
                permissions,
            })
        }
    }

    impl Drop for RestorePermissions {
        fn drop(&mut self) {
            let _ = fs::set_permissions(&self.path, self.permissions.clone());
        }
    }

    #[test]
    fn only_unwritable_install_location_errors_are_actionable() {
        for kind in [
            io::ErrorKind::PermissionDenied,
            io::ErrorKind::ReadOnlyFilesystem,
        ] {
            let error = staged_app_create_error(io::Error::from(kind));
            assert_eq!(error.code(), "update_install_location_unwritable");
            let message = error.to_string();
            assert!(message.contains("~/Applications"));
            assert!(message.contains("If KalCode is in /Applications"));
            assert!(message.contains("administrator"));
        }

        for kind in [io::ErrorKind::AlreadyExists, io::ErrorKind::Other] {
            assert_eq!(
                staged_app_create_error(io::Error::from(kind)).code(),
                "update_installer_storage_failed"
            );
        }
    }

    #[test]
    fn staged_creation_never_replaces_or_removes_an_existing_path()
    -> Result<(), Box<dyn std::error::Error>> {
        let temp = tempdir()?;
        let current = temp.path().join("KalCode.app");
        let staged = temp.path().join(".KalCode-update-existing.app");
        fs::create_dir(&current)?;
        fs::create_dir(&staged)?;
        let sentinel = staged.join("owner-data");
        fs::write(&sentinel, b"preserve")?;

        let error = match create_staged_app(&current, &staged) {
            Ok(()) => return Err(io::Error::other("existing path was replaced").into()),
            Err(error) => error,
        };
        assert_eq!(error.code(), "update_installer_storage_failed");
        assert_eq!(fs::read(&sentinel)?, b"preserve");
        Ok(())
    }

    #[test]
    fn unwritable_parent_is_actionable_without_touching_the_installed_app()
    -> Result<(), Box<dyn std::error::Error>> {
        let temp = tempdir()?;
        let install_root = temp.path().join("Applications");
        let current = install_root.join("KalCode.app");
        let staged = install_root.join(".KalCode-update-unwritable.app");
        fs::create_dir(&install_root)?;
        fs::create_dir(&current)?;
        let sentinel = current.join("owner-data");
        fs::write(&sentinel, b"preserve")?;
        let _restore = RestorePermissions::restrict(&install_root)?;

        let error = match create_staged_app(&current, &staged) {
            Ok(()) => return Err(io::Error::other("unwritable parent accepted staging").into()),
            Err(error) => error,
        };
        assert_eq!(error.code(), "update_install_location_unwritable");
        assert_eq!(fs::read(&sentinel)?, b"preserve");
        assert!(!staged.exists());
        Ok(())
    }

    #[test]
    fn precreated_staging_accepts_ditto_and_owned_cleanup_is_bounded()
    -> Result<(), Box<dyn std::error::Error>> {
        let temp = tempdir()?;
        let current = temp.path().join("KalCode.app");
        let candidate = temp.path().join("Candidate.app");
        let staged = temp.path().join(".KalCode-update-readable.app");
        fs::create_dir(&current)?;
        fs::create_dir_all(candidate.join("Contents"))?;
        fs::write(candidate.join("Contents").join("marker"), b"candidate")?;

        create_staged_app(&current, &staged)?;
        let copy = Command::new("/usr/bin/ditto")
            .args(["--rsrc", "--extattr"])
            .arg(&candidate)
            .arg(&staged)
            .output()?;
        if !copy.status.success() {
            return Err(io::Error::other("ditto failed").into());
        }
        assert_eq!(
            fs::read(staged.join("Contents").join("marker"))?,
            b"candidate"
        );

        remove_staged_app(&current, &staged)?;
        assert!(!staged.exists());
        assert!(current.exists());
        assert!(candidate.exists());
        Ok(())
    }

    #[test]
    fn durable_identity_record_allows_only_the_claimed_preparation_to_be_removed()
    -> Result<(), Box<dyn std::error::Error>> {
        let temp = tempdir()?;
        let current = temp.path().join("KalCode.app");
        let staged = temp.path().join(".KalCode-update-owned.app");
        let prepared = temp.path().join("prepared");
        let dmg = prepared.join("prepared-owned.dmg");
        let mount = prepared.join("prepared-owned.dmg.mount");
        let owner = prepared.join("prepared-owned.dmg.owner");
        let lease_path = prepared.join("prepared-owned.dmg.owner.lock");
        fs::create_dir(&current)?;
        fs::create_dir(&staged)?;
        fs::write(staged.join("copied"), b"candidate")?;
        fs::create_dir(&prepared)?;
        fs::write(&dmg, b"verified dmg")?;
        let lease = PreparationLease::create(&lease_path)?;
        let ownership = PreparationOwnership {
            dmg: file_identity(&dmg, FileKind::RegularFile)?,
            lease: lease.identity(),
            mount_directory: FileIdentity {
                device: 41,
                inode: 42,
            },
            mounted_volume: Some(FileIdentity {
                device: 43,
                inode: 44,
            }),
            staged_app: Some(file_identity(&staged, FileKind::Directory)?),
        };
        write_ownership_record(&owner, &ownership)?;
        let owner_identity = file_identity(&owner, FileKind::RegularFile)?;
        let lease_identity = lease.identity();
        drop(lease);
        let cleanup_lease = PreparationLease::acquire_existing(&lease_path, lease_identity)?
            .ok_or_else(|| io::Error::other("cleanup lease stayed busy"))?;

        cleanup_owned_preparation(
            &current,
            &dmg,
            &mount,
            &staged,
            &owner,
            owner_identity,
            &ownership,
            cleanup_lease,
        )?;

        assert!(current.exists());
        assert!(!staged.exists());
        assert!(!dmg.exists());
        assert!(!owner.exists());
        assert!(!lease_path.exists());
        Ok(())
    }

    #[test]
    fn changed_staged_directory_identity_preserves_every_path()
    -> Result<(), Box<dyn std::error::Error>> {
        let temp = tempdir()?;
        let current = temp.path().join("KalCode.app");
        let staged = temp.path().join(".KalCode-update-replaced.app");
        let displaced = temp.path().join("displaced.app");
        let prepared = temp.path().join("prepared");
        let dmg = prepared.join("prepared-replaced.dmg");
        let mount = prepared.join("prepared-replaced.dmg.mount");
        let owner = prepared.join("prepared-replaced.dmg.owner");
        let lease_path = prepared.join("prepared-replaced.dmg.owner.lock");
        fs::create_dir(&current)?;
        fs::create_dir(&staged)?;
        fs::create_dir(&prepared)?;
        fs::write(&dmg, b"verified dmg")?;
        let lease = PreparationLease::create(&lease_path)?;
        let ownership = PreparationOwnership {
            dmg: file_identity(&dmg, FileKind::RegularFile)?,
            lease: lease.identity(),
            mount_directory: FileIdentity {
                device: 51,
                inode: 52,
            },
            mounted_volume: Some(FileIdentity {
                device: 53,
                inode: 54,
            }),
            staged_app: Some(file_identity(&staged, FileKind::Directory)?),
        };
        write_ownership_record(&owner, &ownership)?;
        let owner_identity = file_identity(&owner, FileKind::RegularFile)?;
        let lease_identity = lease.identity();
        drop(lease);
        let cleanup_lease = PreparationLease::acquire_existing(&lease_path, lease_identity)?
            .ok_or_else(|| io::Error::other("cleanup lease stayed busy"))?;
        fs::rename(&staged, &displaced)?;
        fs::create_dir(&staged)?;
        fs::write(staged.join("keep"), b"not ours")?;

        let error = cleanup_owned_preparation(
            &current,
            &dmg,
            &mount,
            &staged,
            &owner,
            owner_identity,
            &ownership,
            cleanup_lease,
        )
        .unwrap_err();

        assert_eq!(error.code(), "update_installer_storage_failed");
        assert_eq!(fs::read(staged.join("keep"))?, b"not ours");
        assert!(displaced.exists());
        assert!(dmg.exists());
        assert!(owner.exists());
        Ok(())
    }

    #[test]
    fn partial_ownership_record_round_trips_and_replaces_atomically()
    -> Result<(), Box<dyn std::error::Error>> {
        let temp = tempdir()?;
        let owner = temp.path().join("prepared-partial.dmg.owner");
        let mut ownership = PreparationOwnership {
            dmg: FileIdentity {
                device: 101,
                inode: 102,
            },
            lease: FileIdentity {
                device: 103,
                inode: 104,
            },
            mount_directory: FileIdentity {
                device: 105,
                inode: 106,
            },
            mounted_volume: None,
            staged_app: None,
        };
        write_ownership_record(&owner, &ownership)?;
        assert_eq!(read_ownership_record(&owner)?, ownership);

        let first_identity = file_identity(&owner, FileKind::RegularFile)?;
        ownership.mounted_volume = Some(FileIdentity {
            device: 107,
            inode: 108,
        });
        let replacement_identity = replace_ownership_record(&owner, first_identity, &ownership)?;

        assert_eq!(read_ownership_record(&owner)?, ownership);
        assert_eq!(
            file_identity(&owner, FileKind::RegularFile)?,
            replacement_identity
        );
        Ok(())
    }

    #[test]
    fn cleanup_is_idempotent_after_owned_resources_are_already_absent()
    -> Result<(), Box<dyn std::error::Error>> {
        let temp = tempdir()?;
        let current = temp.path().join("KalCode.app");
        let staged = temp.path().join(".KalCode-update-partial.app");
        let prepared = temp.path().join("prepared");
        let dmg = prepared.join("prepared-partial.dmg");
        let mount = prepared.join("prepared-partial.dmg.mount");
        let owner = prepared.join("prepared-partial.dmg.owner");
        let lease_path = prepared.join("prepared-partial.dmg.owner.lock");
        fs::create_dir(&current)?;
        fs::create_dir(&staged)?;
        fs::create_dir(&prepared)?;
        fs::write(&dmg, b"verified dmg")?;
        let lease = PreparationLease::create(&lease_path)?;
        let ownership = PreparationOwnership {
            dmg: file_identity(&dmg, FileKind::RegularFile)?,
            lease: lease.identity(),
            mount_directory: FileIdentity {
                device: 111,
                inode: 112,
            },
            mounted_volume: None,
            staged_app: Some(file_identity(&staged, FileKind::Directory)?),
        };
        write_ownership_record(&owner, &ownership)?;
        let owner_identity = file_identity(&owner, FileKind::RegularFile)?;
        let lease_identity = lease.identity();
        fs::remove_file(&dmg)?;
        fs::remove_dir(&staged)?;
        drop(lease);
        let cleanup_lease = PreparationLease::acquire_existing(&lease_path, lease_identity)?
            .ok_or_else(|| io::Error::other("cleanup lease stayed busy"))?;

        cleanup_owned_preparation(
            &current,
            &dmg,
            &mount,
            &staged,
            &owner,
            owner_identity,
            &ownership,
            cleanup_lease,
        )?;

        assert!(current.exists());
        assert!(!owner.exists());
        assert!(!lease_path.exists());
        Ok(())
    }

    #[test]
    fn protected_swap_matches_only_the_exact_valid_staged_bundle() {
        let root = std::env::current_dir().unwrap().join("Applications");
        let current = root.join("KalCode.app");
        let staged = root.join(".KalCode-update-protected.app");
        let protected = super::MacSwapAttempt {
            current_app: current.clone(),
            staged_app: staged.clone(),
            parent_pid: 42,
            parent_identity_sha256: "a".repeat(64),
            phase: super::MacSwapPhase::Prepared,
        };

        assert!(is_protected_staged(&current, &staged, Some(&protected)));
        assert!(!is_protected_staged(
            &current,
            &root.join(".KalCode-update-other.app"),
            Some(&protected)
        ));
        assert!(!is_protected_staged(
            &root.join("Other.app"),
            &staged,
            Some(&protected)
        ));
        assert!(!is_protected_staged(&current, &staged, None));
    }

    #[test]
    fn cancellation_kills_and_reaps_a_native_preparation_child() {
        let calls = Cell::new(0_u8);
        let cancel = || {
            calls.set(calls.get().saturating_add(1));
            if calls.get() >= 3 {
                Err(kalcode_updater::UpdateError::new(
                    "update_preparation_cancelled",
                    "Update preparation was cancelled.",
                ))
            } else {
                Ok(())
            }
        };
        let started = Instant::now();
        let mut command = Command::new("/bin/sleep");
        command.arg("10");

        let error = run_cancellable_status(&mut command, None, &cancel, super::installer_invalid)
            .unwrap_err();

        assert_eq!(error.code(), "update_preparation_cancelled");
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn native_child_holds_the_preparation_lease_after_parent_descriptor_closes()
    -> Result<(), Box<dyn std::error::Error>> {
        let temp = tempdir()?;
        let path = temp.path().join("prepared-live.dmg.owner.lock");
        let lease = PreparationLease::create(&path)?;
        let identity = lease.identity();
        let mut command = Command::new("/bin/sleep");
        command.arg("10");
        inherit_lease(&mut command, &lease);
        let mut child = command.spawn()?;
        drop(lease);

        assert!(PreparationLease::acquire_existing(&path, identity)?.is_none());
        child.kill()?;
        child.wait()?;
        let cleanup = PreparationLease::acquire_existing(&path, identity)?
            .ok_or_else(|| io::Error::other("child did not release inherited lease"))?;
        drop(cleanup);
        Ok(())
    }
}
