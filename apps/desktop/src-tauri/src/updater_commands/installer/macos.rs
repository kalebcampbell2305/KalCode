use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use kalcode_updater::mac_swap::{app_executable, process_identity_sha256};
use kalcode_updater::{
    ArtifactFormat, FeedMetadata, InstallBinding, MacSwapAttempt, MacSwapPhase, UpdateError,
    UpdateTarget, verify_download_reader,
};
use sha2::{Digest, Sha256};

use super::{
    cleanup_prepared, ensure_prepared_directory, installer_invalid, installer_storage_failed,
    is_safe_name, reject_reparse,
};

const BUNDLE_IDENTIFIER: &str = "com.kalcode.desktop";
const NOTARIZED_SOURCE: &str = "source=Notarized Developer ID";

pub(super) struct PreparedMacInstaller {
    dmg_path: PathBuf,
    staged_app: PathBuf,
    current_app: PathBuf,
    helper_path: PathBuf,
    journal_path: PathBuf,
    parent_pid: u32,
    parent_identity_sha256: String,
    designated_requirement: String,
    from_version: String,
    to_version: String,
    binding: InstallBinding,
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
    ) -> Result<Self, UpdateError> {
        if metadata.target != UpdateTarget::DarwinAarch64
            || metadata.format != ArtifactFormat::Dmg
            || !name.ends_with(".dmg")
        {
            return Err(installer_invalid());
        }
        ensure_prepared_directory(root)?;
        cleanup_prepared(root);
        if !is_safe_name(name) {
            return Err(installer_invalid());
        }
        let dmg_path = root.join(name);
        if dmg_path.parent() != Some(root) {
            return Err(installer_invalid());
        }
        let mut dmg = OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(&dmg_path)
            .map_err(|_| installer_storage_failed())?;
        let mut staged_created: Option<(PathBuf, PathBuf)> = None;
        let prepared = (|| {
            reject_reparse(root)?;
            dmg.write_all(bytes)
                .map_err(|_| installer_storage_failed())?;
            dmg.sync_all().map_err(|_| installer_storage_failed())?;
            dmg.seek(SeekFrom::Start(0))
                .map_err(|_| installer_storage_failed())?;
            verify_download_reader(&mut dmg, metadata)?;
            verify_dmg(&dmg_path)?;

            let current_app = current_app_bundle()?;
            let current_identity = verify_app(&current_app, current_version)?;
            let current_executable = app_executable(&current_app);
            let source_sha256 = digest_file(&current_executable)?;
            let helper_path = current_app
                .join("Contents")
                .join("MacOS")
                .join("kalcode-update-helper");
            require_regular_file(&helper_path)?;

            let mount_path = root.join(format!("{name}.mount"));
            let mounted = MountedDmg::attach(&dmg_path, &mount_path)?;
            let candidate_app = mounted.path().join("KalCode.app");
            let candidate_identity = verify_app(&candidate_app, expected_version)?;
            if candidate_identity != current_identity {
                return Err(identity_mismatch());
            }

            let id = name
                .strip_prefix("prepared-")
                .and_then(|value| value.strip_suffix(".dmg"))
                .ok_or_else(installer_invalid)?;
            if id.is_empty()
                || id.len() > 64
                || !id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            {
                return Err(installer_invalid());
            }
            let parent = current_app.parent().ok_or_else(installer_invalid)?;
            let staged_app = parent.join(format!(".KalCode-update-{id}.app"));
            kalcode_updater::mac_swap::validate_swap_paths(&current_app, &staged_app)?;
            if fs::symlink_metadata(&staged_app).is_ok() {
                return Err(installer_storage_failed());
            }
            staged_created = Some((current_app.clone(), staged_app.clone()));
            let copy = Command::new("/usr/bin/ditto")
                .args([OsStr::new("--rsrc"), OsStr::new("--extattr")])
                .arg(&candidate_app)
                .arg(&staged_app)
                .output()
                .map_err(|_| installer_storage_failed())?;
            if !copy.status.success() {
                return Err(installer_storage_failed());
            }
            if verify_app(&staged_app, expected_version)? != current_identity {
                return Err(identity_mismatch());
            }

            let parent_pid = std::process::id();
            let parent_identity_sha256 = process_identity_sha256(parent_pid)?;
            let signing_requirement_sha256 =
                format!("{:x}", Sha256::digest(current_identity.as_bytes()));
            let journal_path = root
                .parent()
                .ok_or_else(installer_storage_failed)?
                .join("updater.json");
            Ok(Self {
                dmg_path: dmg_path.clone(),
                staged_app,
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
                launched: false,
            })
        })();
        if prepared.is_err() {
            drop(dmg);
            let _ = fs::remove_file(&dmg_path);
            if let Some((current, staged)) = staged_created {
                let _ = remove_staged_app(&current, &staged);
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
        if process_identity_sha256(self.parent_pid)? != self.parent_identity_sha256
            || verify_app(&self.current_app, &self.from_version)? != self.designated_requirement
            || verify_app(&self.staged_app, &self.to_version)? != self.designated_requirement
        {
            return Err(identity_mismatch());
        }
        let child = Command::new(&self.helper_path)
            .arg("--journal")
            .arg(&self.journal_path)
            .spawn()
            .map_err(|_| {
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
            let _ = remove_staged_app(&self.current_app, &self.staged_app);
        }
    }
}

struct MountedDmg {
    path: PathBuf,
}

impl MountedDmg {
    fn attach(dmg: &Path, mount_path: &Path) -> Result<Self, UpdateError> {
        if fs::symlink_metadata(mount_path).is_ok() {
            return Err(installer_storage_failed());
        }
        fs::create_dir(mount_path).map_err(|_| installer_storage_failed())?;
        let output = Command::new("/usr/bin/hdiutil")
            .args([
                "attach",
                "-readonly",
                "-nobrowse",
                "-noautoopen",
                "-mountpoint",
            ])
            .arg(mount_path)
            .arg(dmg)
            .output()
            .map_err(|_| installer_invalid())?;
        if !output.status.success() {
            let _ = fs::remove_dir(mount_path);
            return Err(installer_invalid());
        }
        Ok(Self {
            path: mount_path.to_path_buf(),
        })
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for MountedDmg {
    fn drop(&mut self) {
        let _ = Command::new("/usr/bin/hdiutil")
            .arg("detach")
            .arg(&self.path)
            .arg("-quiet")
            .status();
        let _ = fs::remove_dir(&self.path);
    }
}

fn verify_dmg(path: &Path) -> Result<(), UpdateError> {
    checked(Command::new("/usr/bin/hdiutil").arg("verify").arg(path))?;
    let assessment = checked(
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
    )?;
    require_notarized(&assessment)
}

fn verify_app(path: &Path, expected_version: &str) -> Result<String, UpdateError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| installer_invalid())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(installer_invalid());
    }
    checked(
        Command::new("/usr/bin/codesign")
            .args(["--verify", "--deep", "--strict", "--verbose=2"])
            .arg(path),
    )?;
    let assessment = checked(
        Command::new("/usr/sbin/spctl")
            .args(["--assess", "--type", "execute", "--verbose=4"])
            .arg(path),
    )?;
    require_notarized(&assessment)?;

    let details = checked(
        Command::new("/usr/bin/codesign")
            .args(["-d", "--verbose=4"])
            .arg(path),
    )?;
    let details = combined_text(&details)?;
    let identifier = details
        .lines()
        .find_map(|line| line.strip_prefix("Identifier="))
        .ok_or_else(installer_invalid)?;
    if identifier != BUNDLE_IDENTIFIER {
        return Err(identity_mismatch());
    }
    let version = checked(
        Command::new("/usr/bin/plutil")
            .args(["-extract", "CFBundleShortVersionString", "raw", "-o", "-"])
            .arg(path.join("Contents").join("Info.plist")),
    )?;
    if std::str::from_utf8(&version.stdout)
        .map_err(|_| installer_invalid())?
        .trim()
        != expected_version
    {
        return Err(installer_invalid());
    }

    let requirement = checked(
        Command::new("/usr/bin/codesign")
            .args(["-d", "-r-"])
            .arg(path),
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
    let architectures = checked(Command::new("/usr/bin/lipo").arg("-archs").arg(&executable))?;
    let architectures = std::str::from_utf8(&architectures.stdout)
        .map_err(|_| installer_invalid())?
        .split_whitespace()
        .collect::<Vec<_>>();
    if architectures.as_slice() != ["arm64"] {
        return Err(installer_invalid());
    }
    Ok(requirement)
}

fn checked(command: &mut Command) -> Result<Output, UpdateError> {
    let output = command.output().map_err(|_| installer_invalid())?;
    if output.status.success()
        && output.stdout.len() <= 64 * 1024
        && output.stderr.len() <= 64 * 1024
    {
        Ok(output)
    } else {
        Err(installer_invalid())
    }
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

fn digest_file(path: &Path) -> Result<String, UpdateError> {
    let mut file = File::open(path).map_err(|_| installer_invalid())?;
    super::digest_reader(&mut file)
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

fn identity_mismatch() -> UpdateError {
    UpdateError::new(
        "update_signing_identity_mismatch",
        "The update isn't signed by the installed KalCode identity.",
    )
}
