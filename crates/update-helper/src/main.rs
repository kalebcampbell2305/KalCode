//! Post-exit macOS updater helper. It is bundled inside the signed KalCode app and has no network
//! authority. The desktop process records the complete target-bound swap plan before launch.
//!
//! `--journal <updater.json>` applies an update the user chose to restart into: swap, relaunch,
//! and roll back unless the new build records its health. `--no-relaunch` applies a same-version
//! build after the user closed KalCode: swap, probe the new build without opening it, and roll
//! back if the probe fails. KalCode stays closed unless a launch stepped aside meanwhile.

#[cfg(any(target_os = "macos", test))]
use std::ffi::{OsStr, OsString};
#[cfg(target_os = "macos")]
use std::fs::File;
#[cfg(target_os = "macos")]
use std::io::Read;
#[cfg(target_os = "macos")]
use std::path::Path;
#[cfg(any(target_os = "macos", test))]
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use std::process::{Child, Command, ExitCode, Output, Stdio};
#[cfg(target_os = "macos")]
use std::thread;
#[cfg(target_os = "macos")]
use std::time::{Duration, Instant};

#[cfg(target_os = "macos")]
use kalcode_updater::mac_swap::{app_executable, atomic_swap_apps, process_identity_sha256};
#[cfg(any(target_os = "macos", test))]
use kalcode_updater::{MacSwapAttempt, MacSwapPhase};
#[cfg(target_os = "macos")]
use kalcode_updater::{UpdateJournal, UpdateTarget};
#[cfg(target_os = "macos")]
use sha2::{Digest, Sha256};

#[cfg(target_os = "macos")]
const PARENT_EXIT_TIMEOUT: Duration = Duration::from_secs(5 * 60);
#[cfg(target_os = "macos")]
const HEALTH_TIMEOUT: Duration = Duration::from_secs(45);
/// How long the swapped-in build may take to answer `--build-info` after a no-relaunch swap.
#[cfg(target_os = "macos")]
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(target_os = "macos")]
const POLL_INTERVAL: Duration = Duration::from_millis(200);

#[cfg(target_os = "macos")]
fn main() -> ExitCode {
    let Ok(arguments) = parse_arguments(std::env::args_os().skip(1)) else {
        eprintln!("KalCode couldn't safely apply the macOS update.");
        return ExitCode::FAILURE;
    };
    keep_inherited_descriptors_private();
    let result = run(&arguments);
    if !arguments.relaunch {
        reopen_if_requested(&arguments.journal);
    }
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(()) => {
            eprintln!("KalCode couldn't safely apply the macOS update.");
            ExitCode::FAILURE
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn main() -> std::process::ExitCode {
    eprintln!("The KalCode update helper is available only on macOS.");
    std::process::ExitCode::FAILURE
}

#[cfg(target_os = "macos")]
fn run(arguments: &HelperArguments) -> Result<(), ()> {
    let journal_path = arguments.journal.clone();
    let initial = UpdateJournal::load(&journal_path).map_err(|_| ())?;
    let (attempt, swap) = pending_mac_swap(&initial)?;
    wait_for_exact_parent_exit(&swap)?;

    let mut journal = UpdateJournal::load(&journal_path).map_err(|_| ())?;
    let (fresh_attempt, fresh_swap) = pending_mac_swap(&journal)?;
    if fresh_attempt != attempt || fresh_swap != swap || fresh_swap.phase != MacSwapPhase::Prepared
    {
        return Err(());
    }
    validate_existing_app(&swap.current_app)?;
    validate_existing_app(&swap.staged_app)?;
    verify_swap_inputs(&fresh_attempt, &swap)?;

    atomic_swap_apps(&swap.current_app, &swap.staged_app).map_err(|_| ())?;
    if journal
        .mark_mac_swap_phase(MacSwapPhase::Prepared, MacSwapPhase::Swapped)
        .is_err()
    {
        let _ = atomic_swap_apps(&swap.current_app, &swap.staged_app);
        return Err(());
    }

    if !arguments.relaunch {
        // The attempt stays `Swapped`; the next launch of the new build records its result.
        return finish_without_relaunch(
            || probe_build(&swap.current_app, &attempt.to_version),
            || remove_verified_previous_app(&attempt, &swap),
            || rollback(&journal_path, &attempt, &swap, None, false),
        );
    }

    if journal
        .mark_mac_swap_phase(MacSwapPhase::Swapped, MacSwapPhase::Launched)
        .is_err()
    {
        return rollback(&journal_path, &attempt, &swap, None, true);
    }
    // Commit the launch phase before starting the new executable. The new app acknowledges the
    // attempt during startup; recording this transition first prevents that acknowledgement from
    // racing the helper's phase write. A launch failure still atomically restores the old app.
    let mut child = match launch_app(&swap.current_app) {
        Ok(child) => child,
        Err(()) => return rollback(&journal_path, &attempt, &swap, None, true),
    };

    let started = Instant::now();
    while started.elapsed() < HEALTH_TIMEOUT {
        let observed = UpdateJournal::load(&journal_path).map_err(|_| ())?;
        if observed.state().install_attempt.is_none()
            && observed.state().last_successful_version.as_deref() == Some(&attempt.to_version)
        {
            remove_verified_previous_app(&attempt, &swap)?;
            return Ok(());
        }
        if child.try_wait().map_err(|_| ())?.is_some() {
            return rollback(&journal_path, &attempt, &swap, None, true);
        }
        thread::sleep(POLL_INTERVAL);
    }
    rollback(&journal_path, &attempt, &swap, Some(&mut child), true)
}

#[cfg(any(target_os = "macos", test))]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, PartialEq, Eq)]
struct HelperArguments {
    journal: PathBuf,
    /// `false` (`--no-relaunch`): the user closed KalCode, so apply without opening it.
    relaunch: bool,
}

#[cfg(any(target_os = "macos", test))]
fn parse_arguments(arguments: impl IntoIterator<Item = OsString>) -> Result<HelperArguments, ()> {
    let mut arguments = arguments.into_iter();
    if arguments.next().as_deref() != Some(OsStr::new("--journal")) {
        return Err(());
    }
    let journal = PathBuf::from(arguments.next().ok_or(())?);
    let relaunch = match arguments.next() {
        None => true,
        Some(flag) if flag == "--no-relaunch" => false,
        Some(_) => return Err(()),
    };
    if arguments.next().is_some()
        || !journal.is_absolute()
        || journal.file_name().and_then(|name| name.to_str()) != Some("updater.json")
    {
        return Err(());
    }
    Ok(HelperArguments { journal, relaunch })
}

/// The end of a no-relaunch swap: the swapped-in build must answer its launch probe, or the
/// previous build is restored. Nothing is opened either way.
#[cfg(any(target_os = "macos", test))]
fn finish_without_relaunch(
    probe: impl FnOnce() -> Result<(), ()>,
    remove_previous: impl FnOnce() -> Result<(), ()>,
    roll_back: impl FnOnce() -> Result<(), ()>,
) -> Result<(), ()> {
    if probe().is_ok() {
        remove_previous()
    } else {
        let _ = roll_back();
        Err(())
    }
}

/// Runs the installed build's read-only `--build-info` probe, which exits before any window,
/// store or runtime starts. It proves the swapped-in bundle launches (signature, libraries,
/// architecture) and is exactly `expected_version`.
#[cfg(target_os = "macos")]
fn probe_build(app: &Path, expected_version: &str) -> Result<(), ()> {
    let mut child = Command::new(app_executable(app))
        .arg("--build-info")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| ())?;
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|_| ())? {
            if !status.success() {
                return Err(());
            }
            break;
        }
        if started.elapsed() >= PROBE_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err(());
        }
        thread::sleep(POLL_INTERVAL);
    }
    let mut output = String::new();
    child
        .stdout
        .take()
        .ok_or(())?
        .take(64 * 1024)
        .read_to_string(&mut output)
        .map_err(|_| ())?;
    build_info_reports(&output, expected_version)
}

#[cfg(any(target_os = "macos", test))]
fn build_info_reports(output: &str, expected_version: &str) -> Result<(), ()> {
    let info: serde_json::Value = serde_json::from_str(output.trim()).map_err(|_| ())?;
    if info["schemaVersion"] == 1 && info["version"].as_str() == Some(expected_version) {
        Ok(())
    } else {
        Err(())
    }
}

/// KalCode passes its apply lease to this helper. Keep every inherited descriptor for this
/// helper's whole run, but never let the tools or the KalCode build it starts inherit them.
#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
fn keep_inherited_descriptors_private() {
    let Ok(entries) = std::fs::read_dir("/dev/fd") else {
        return;
    };
    let descriptors: Vec<i32> = entries
        .flatten()
        .filter_map(|entry| entry.file_name().to_str()?.parse().ok())
        .filter(|descriptor| *descriptor > 2)
        .collect();
    for descriptor in descriptors {
        // SAFETY: `fcntl` only reads and sets the close-on-exec flag; a descriptor that has
        // closed since the listing (the listing's own) fails harmlessly with EBADF.
        unsafe {
            let flags = libc::fcntl(descriptor, libc::F_GETFD);
            if flags >= 0 {
                libc::fcntl(descriptor, libc::F_SETFD, flags | libc::FD_CLOEXEC);
            }
        }
    }
}

/// A KalCode launch that found this helper still applying the update stepped aside and asked to
/// be reopened. Open the installed build, whichever it now is.
#[cfg(target_os = "macos")]
fn reopen_if_requested(journal: &Path) {
    let marker = journal.with_file_name(kalcode_updater::mac_swap::REOPEN_MARKER);
    if std::fs::remove_file(marker).is_err() {
        return;
    }
    // This helper runs from `<KalCode.app>/Contents/MacOS/`.
    let installed = std::env::current_exe().ok().and_then(|helper| {
        let app = helper.parent()?.parent()?.parent()?.to_path_buf();
        (app.file_name() == Some(OsStr::new("KalCode.app"))).then_some(app)
    });
    if let Some(app) = installed
        && validate_existing_app(&app).is_ok()
    {
        let _ = launch_app(&app);
    }
}

#[cfg(target_os = "macos")]
fn pending_mac_swap(
    journal: &UpdateJournal,
) -> Result<(kalcode_updater::InstallAttempt, MacSwapAttempt), ()> {
    let attempt = journal.state().install_attempt.clone().ok_or(())?;
    if attempt.binding.as_ref().map(|binding| binding.target) != Some(UpdateTarget::DarwinAarch64) {
        return Err(());
    }
    let swap = attempt.mac_swap.clone().ok_or(())?;
    Ok((attempt, swap))
}

#[cfg(target_os = "macos")]
fn wait_for_exact_parent_exit(swap: &MacSwapAttempt) -> Result<(), ()> {
    let started = Instant::now();
    while started.elapsed() < PARENT_EXIT_TIMEOUT {
        match process_identity_sha256(swap.parent_pid) {
            Ok(identity) if identity == swap.parent_identity_sha256 => thread::sleep(POLL_INTERVAL),
            Ok(_) | Err(_) => return Ok(()),
        }
    }
    Err(())
}

#[cfg(target_os = "macos")]
fn validate_existing_app(path: &Path) -> Result<(), ()> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| ())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() || !app_executable(path).is_file() {
        return Err(());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn launch_app(app: &Path) -> Result<Child, ()> {
    Command::new(app_executable(app)).spawn().map_err(|_| ())
}

#[cfg(target_os = "macos")]
fn verify_swap_inputs(
    attempt: &kalcode_updater::InstallAttempt,
    swap: &MacSwapAttempt,
) -> Result<(), ()> {
    let binding = attempt.binding.as_ref().ok_or(())?;
    if binding.target != UpdateTarget::DarwinAarch64
        || digest_file(&app_executable(&swap.current_app))? != binding.source_sha256
        || verify_app_identity(&swap.current_app, &attempt.from_version)?
            != binding.signing_requirement_sha256
        || verify_app_identity(&swap.staged_app, &attempt.to_version)?
            != binding.signing_requirement_sha256
    {
        return Err(());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn remove_verified_previous_app(
    attempt: &kalcode_updater::InstallAttempt,
    swap: &MacSwapAttempt,
) -> Result<(), ()> {
    let binding = attempt.binding.as_ref().ok_or(())?;
    if binding.target != UpdateTarget::DarwinAarch64
        || digest_file(&app_executable(&swap.staged_app))? != binding.source_sha256
        || verify_app_identity(&swap.staged_app, &attempt.from_version)?
            != binding.signing_requirement_sha256
        || verify_app_identity(&swap.current_app, &attempt.to_version)?
            != binding.signing_requirement_sha256
    {
        return Err(());
    }
    kalcode_updater::mac_swap::remove_swapped_out_app(&swap.current_app, &swap.staged_app)
        .map_err(|_| ())
}

#[cfg(target_os = "macos")]
fn remove_verified_failed_app(
    attempt: &kalcode_updater::InstallAttempt,
    swap: &MacSwapAttempt,
) -> Result<(), ()> {
    let binding = attempt.binding.as_ref().ok_or(())?;
    if binding.target != UpdateTarget::DarwinAarch64
        || digest_file(&app_executable(&swap.current_app))? != binding.source_sha256
        || verify_app_identity(&swap.current_app, &attempt.from_version)?
            != binding.signing_requirement_sha256
        || verify_app_identity(&swap.staged_app, &attempt.to_version)?
            != binding.signing_requirement_sha256
    {
        return Err(());
    }
    kalcode_updater::mac_swap::remove_swapped_out_app(&swap.current_app, &swap.staged_app)
        .map_err(|_| ())
}

#[cfg(target_os = "macos")]
fn verify_app_identity(app: &Path, expected_version: &str) -> Result<String, ()> {
    checked(
        Command::new("/usr/bin/codesign")
            .args(["--verify", "--deep", "--strict", "--verbose=2"])
            .arg(app),
    )?;
    let assessment = checked(
        Command::new("/usr/sbin/spctl")
            .args(["--assess", "--type", "execute", "--verbose=4"])
            .arg(app),
    )?;
    if !combined_text(&assessment)?
        .lines()
        .any(|line| line.trim() == "source=Notarized Developer ID")
    {
        return Err(());
    }
    let details = checked(
        Command::new("/usr/bin/codesign")
            .args(["-d", "--verbose=4"])
            .arg(app),
    )?;
    if !combined_text(&details)?.lines().any(|line| {
        line.trim().strip_prefix("Identifier=") == Some(kalcode_contracts::identity::IDENTIFIER)
    }) {
        return Err(());
    }
    let requirement = checked(
        Command::new("/usr/bin/codesign")
            .args(["-d", "-r-"])
            .arg(app),
    )?;
    let requirement_text = combined_text(&requirement)?;
    let requirement = requirement_text
        .lines()
        .find_map(|line| line.strip_prefix("designated => "))
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 16 * 1024)
        .ok_or(())?;
    let plist = app.join("Contents").join("Info.plist");
    let plist_value = |key: &str| -> Result<String, ()> {
        let output = checked(
            Command::new("/usr/bin/plutil")
                .args(["-extract", key, "raw", "-o", "-"])
                .arg(&plist),
        )?;
        Ok(std::str::from_utf8(&output.stdout)
            .map_err(|_| ())?
            .trim()
            .to_owned())
    };
    let short_version = plist_value("CFBundleShortVersionString")?;
    let bundle_version = plist_value("CFBundleVersion")?;
    if !kalcode_updater::mac_swap::bundle_version_matches(
        &short_version,
        &bundle_version,
        expected_version,
    ) {
        return Err(());
    }
    // Read from the Mach-O header, never `/usr/bin/lipo`: that is an xcrun shim that fails on Macs
    // without Xcode or the Command Line Tools, which would refuse every update there.
    let architectures =
        kalcode_updater::macho::architectures(&app_executable(app)).map_err(|_| ())?;
    if !kalcode_updater::macho::is_exactly_arm64(&architectures) {
        return Err(());
    }
    Ok(format!("{:x}", Sha256::digest(requirement.as_bytes())))
}

#[cfg(target_os = "macos")]
fn digest_file(path: &Path) -> Result<String, ()> {
    let mut file = File::open(path).map_err(|_| ())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|_| ())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(target_os = "macos")]
fn checked(command: &mut Command) -> Result<Output, ()> {
    let output = command.output().map_err(|_| ())?;
    if output.status.success()
        && output.stdout.len() <= 64 * 1024
        && output.stderr.len() <= 64 * 1024
    {
        Ok(output)
    } else {
        Err(())
    }
}

#[cfg(target_os = "macos")]
fn combined_text(output: &Output) -> Result<String, ()> {
    let mut bytes = output.stdout.clone();
    bytes.extend_from_slice(&output.stderr);
    String::from_utf8(bytes).map_err(|_| ())
}

#[cfg(any(target_os = "macos", test))]
fn finish_health_rollback(
    cancel_attempt: impl FnOnce() -> Result<(), ()>,
    launch_restored: impl FnOnce() -> Result<(), ()>,
    cleanup_failed: impl FnOnce() -> Result<(), ()>,
) -> Result<(), ()> {
    cancel_attempt()?;
    launch_restored()?;
    cleanup_failed()
}

/// Whether the journal still holds exactly the attempt this helper swapped in, at a phase it may
/// roll back from. Any other change (the new build acknowledged the install, or fenced it before
/// a forward-only database migration) means the previous build must not come back. Both helper
/// modes share it: a restart apply rolls back from `Launched`, a no-relaunch apply from `Swapped`.
#[cfg(any(target_os = "macos", test))]
fn rollback_still_owned(
    observed: &kalcode_updater::InstallAttempt,
    attempt: &kalcode_updater::InstallAttempt,
    swap: &MacSwapAttempt,
) -> bool {
    let Some(observed_swap) = observed.mac_swap.as_ref() else {
        return false;
    };
    let mut expected_swap = swap.clone();
    expected_swap.phase = observed_swap.phase;
    let mut expected_attempt = attempt.clone();
    expected_attempt.mac_swap = Some(expected_swap.clone());
    matches!(
        observed_swap.phase,
        MacSwapPhase::Swapped | MacSwapPhase::Launched
    ) && *observed_swap == expected_swap
        && *observed == expected_attempt
}

/// Restores the previous build. `relaunch` reopens it (the user chose to restart into the
/// update); a no-relaunch apply leaves KalCode closed.
#[cfg(target_os = "macos")]
fn rollback(
    journal_path: &Path,
    attempt: &kalcode_updater::InstallAttempt,
    swap: &MacSwapAttempt,
    child: Option<&mut Child>,
    relaunch: bool,
) -> Result<(), ()> {
    if let Some(child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
    let observed = UpdateJournal::load(journal_path).map_err(|_| ())?;
    let (observed_attempt, _) = pending_mac_swap(&observed)?;
    if !rollback_still_owned(&observed_attempt, attempt, swap)
        || digest_file(&app_executable(&swap.staged_app))?
            != attempt.binding.as_ref().ok_or(())?.source_sha256
        || verify_app_identity(&swap.staged_app, &attempt.from_version)?
            != attempt
                .binding
                .as_ref()
                .ok_or(())?
                .signing_requirement_sha256
        || verify_app_identity(&swap.current_app, &attempt.to_version)?
            != attempt
                .binding
                .as_ref()
                .ok_or(())?
                .signing_requirement_sha256
    {
        return Err(());
    }
    atomic_swap_apps(&swap.current_app, &swap.staged_app).map_err(|_| ())?;
    if digest_file(&app_executable(&swap.current_app))?
        != attempt.binding.as_ref().ok_or(())?.source_sha256
        || verify_app_identity(&swap.current_app, &attempt.from_version)?
            != attempt
                .binding
                .as_ref()
                .ok_or(())?
                .signing_requirement_sha256
    {
        return Err(());
    }
    finish_health_rollback(
        || {
            let mut journal = UpdateJournal::load(journal_path).map_err(|_| ())?;
            journal
                .cancel_install_attempt("mac_update_health_check_failed")
                .map_err(|_| ())
        },
        || {
            if relaunch {
                let restored = launch_app(&swap.current_app)?;
                drop(restored);
            }
            Ok(())
        },
        || remove_verified_failed_app(attempt, swap),
    )?;
    Err(())
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::ffi::OsString;

    use kalcode_updater::{
        InstallAttempt, InstallBinding, InstallKind, MacSwapAttempt, MacSwapPhase, UpdateJournal,
        UpdateTarget,
    };

    use super::{
        HelperArguments, build_info_reports, finish_health_rollback, finish_without_relaunch,
        parse_arguments, rollback_still_owned,
    };

    /// A journaled macOS upgrade from 0.1.8+5 to 0.1.8+6, advanced to `phase` the way the helper
    /// advances it, and the attempt the helper captured before its swap.
    fn swapped_journal(
        dir: &std::path::Path,
        phase: MacSwapPhase,
    ) -> (UpdateJournal, InstallAttempt) {
        let mut journal = UpdateJournal::load(dir.join("updater.json")).unwrap();
        journal
            .record_install_attempt(InstallAttempt {
                kind: InstallKind::Upgrade,
                from_version: "0.1.8+5".into(),
                to_version: "0.1.8+6".into(),
                sha256: "a".repeat(64),
                binding: Some(InstallBinding {
                    target: UpdateTarget::DarwinAarch64,
                    source_sha256: "c".repeat(64),
                    signing_requirement_sha256: "d".repeat(64),
                }),
                mac_swap: Some(MacSwapAttempt {
                    current_app: dir.join("KalCode.app"),
                    staged_app: dir.join(".KalCode-update-test.app"),
                    parent_pid: 42,
                    parent_identity_sha256: "e".repeat(64),
                    phase: MacSwapPhase::Prepared,
                }),
                started_at: "2026-10-01T12:00:00Z".into(),
            })
            .unwrap();
        let captured = journal.state().install_attempt.clone().unwrap();
        journal
            .mark_mac_swap_phase(MacSwapPhase::Prepared, MacSwapPhase::Swapped)
            .unwrap();
        if phase == MacSwapPhase::Launched {
            journal
                .mark_mac_swap_phase(MacSwapPhase::Swapped, MacSwapPhase::Launched)
                .unwrap();
        }
        (journal, captured)
    }

    /// Rollback protection and silent installs together: whichever mode applied the update
    /// (`Swapped` for a no-relaunch apply after KalCode closed, `Launched` for a restart apply),
    /// once the new build fences the attempt before migrating its database, the helper's rollback
    /// no longer owns it and fails closed instead of restoring a build that can't open the data.
    #[test]
    fn a_forward_only_fence_stops_the_rollback_of_both_helper_modes() {
        for phase in [MacSwapPhase::Swapped, MacSwapPhase::Launched] {
            let temp = tempfile::tempdir().unwrap();
            let (mut journal, captured) = swapped_journal(temp.path(), phase);
            let swap = captured.mac_swap.clone().unwrap();
            let observed = journal.state().install_attempt.clone().unwrap();
            assert!(
                rollback_still_owned(&observed, &captured, &swap),
                "{phase:?}"
            );

            journal.fence_forward_only_mac_install("0.1.8+6").unwrap();
            let fenced = UpdateJournal::load(temp.path().join("updater.json"))
                .unwrap()
                .state()
                .install_attempt
                .clone()
                .unwrap();
            assert!(
                !rollback_still_owned(&fenced, &captured, &swap),
                "{phase:?}"
            );
        }
    }

    #[test]
    fn a_rollback_is_owned_only_from_a_swapped_phase_of_the_same_attempt() {
        let temp = tempfile::tempdir().unwrap();
        let (_journal, captured) = swapped_journal(temp.path(), MacSwapPhase::Swapped);
        let swap = captured.mac_swap.clone().unwrap();
        // Not yet swapped: nothing to roll back.
        assert!(!rollback_still_owned(&captured, &captured, &swap));
        // Another attempt replaced it.
        let mut other = captured.clone();
        other.to_version = "0.1.8+7".into();
        if let Some(other_swap) = other.mac_swap.as_mut() {
            other_swap.phase = MacSwapPhase::Swapped;
        }
        assert!(!rollback_still_owned(&other, &captured, &swap));
        let mut no_swap = captured.clone();
        no_swap.mac_swap = None;
        assert!(!rollback_still_owned(&no_swap, &captured, &swap));
    }

    fn journal() -> std::path::PathBuf {
        std::env::temp_dir().join("updates").join("updater.json")
    }

    fn arguments(values: &[&std::ffi::OsStr]) -> Result<HelperArguments, ()> {
        parse_arguments(values.iter().map(OsString::from))
    }

    #[test]
    fn arguments_select_the_relaunch_or_the_no_relaunch_apply() {
        let path = journal();
        assert_eq!(
            arguments(&["--journal".as_ref(), path.as_os_str()]),
            Ok(HelperArguments {
                journal: path.clone(),
                relaunch: true
            })
        );
        assert_eq!(
            arguments(&[
                "--journal".as_ref(),
                path.as_os_str(),
                "--no-relaunch".as_ref()
            ]),
            Ok(HelperArguments {
                journal: path.clone(),
                relaunch: false
            })
        );
    }

    #[test]
    fn arguments_reject_anything_else() {
        let path = journal();
        let other = std::env::temp_dir().join("other.json");
        for invalid in [
            vec![],
            vec![path.as_os_str()],
            vec!["--journal".as_ref()],
            vec![
                "--no-relaunch".as_ref(),
                "--journal".as_ref(),
                path.as_os_str(),
            ],
            vec!["--journal".as_ref(), "updater.json".as_ref()],
            vec!["--journal".as_ref(), other.as_os_str()],
            vec![
                "--journal".as_ref(),
                path.as_os_str(),
                "--relaunch".as_ref(),
            ],
            vec![
                "--journal".as_ref(),
                path.as_os_str(),
                "--no-relaunch".as_ref(),
                "--no-relaunch".as_ref(),
            ],
        ] {
            assert_eq!(arguments(&invalid), Err(()), "{invalid:?}");
        }
    }

    #[test]
    fn a_no_relaunch_swap_keeps_a_healthy_build_and_rolls_back_a_failed_probe() {
        for (probe_ok, remove_ok) in [(true, true), (true, false), (false, true)] {
            let order = RefCell::new(Vec::new());
            let result = finish_without_relaunch(
                || {
                    order.borrow_mut().push("probe");
                    if probe_ok { Ok(()) } else { Err(()) }
                },
                || {
                    order.borrow_mut().push("remove previous");
                    if remove_ok { Ok(()) } else { Err(()) }
                },
                || {
                    order.borrow_mut().push("roll back");
                    Err(())
                },
            );
            let expected = if probe_ok {
                vec!["probe", "remove previous"]
            } else {
                vec!["probe", "roll back"]
            };
            assert_eq!(*order.borrow(), expected);
            assert_eq!(result.is_ok(), probe_ok && remove_ok);
        }
    }

    #[test]
    fn the_probe_must_report_exactly_the_swapped_in_build() {
        let info =
            r#"{"schemaVersion":1,"version":"0.1.8+6","channel":"stable","testHooks":false}"#;
        assert_eq!(build_info_reports(info, "0.1.8+6"), Ok(()));
        assert_eq!(build_info_reports(&format!("{info}\n"), "0.1.8+6"), Ok(()));
        assert_eq!(build_info_reports(info, "0.1.8+5"), Err(()));
        assert_eq!(
            build_info_reports(r#"{"schemaVersion":2,"version":"0.1.8+6"}"#, "0.1.8+6"),
            Err(())
        );
        assert_eq!(build_info_reports("", "0.1.8+6"), Err(()));
        assert_eq!(build_info_reports("0.1.8+6", "0.1.8+6"), Err(()));
    }

    #[test]
    fn failed_health_rollback_cleans_only_after_cancel_and_relaunch() {
        for failure in [Some("cancel"), Some("launch"), None] {
            let order = RefCell::new(Vec::new());
            let result = finish_health_rollback(
                || {
                    order.borrow_mut().push("cancel");
                    if failure == Some("cancel") {
                        Err(())
                    } else {
                        Ok(())
                    }
                },
                || {
                    order.borrow_mut().push("launch");
                    if failure == Some("launch") {
                        Err(())
                    } else {
                        Ok(())
                    }
                },
                || {
                    order.borrow_mut().push("cleanup");
                    Ok(())
                },
            );
            if failure.is_some() {
                assert!(result.is_err());
            } else {
                assert!(result.is_ok());
            }
            let expected = match failure {
                Some("cancel") => vec!["cancel"],
                Some("launch") => vec!["cancel", "launch"],
                None => vec!["cancel", "launch", "cleanup"],
                Some(_) => unreachable!(),
            };
            assert_eq!(*order.borrow(), expected);
        }
    }
}
