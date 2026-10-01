//! Post-exit macOS updater helper. It is bundled inside the signed KalCode app and has no network
//! authority. The desktop process records the complete target-bound swap plan before launch.

#[cfg(target_os = "macos")]
use std::fs::File;
#[cfg(target_os = "macos")]
use std::io::{self, Read};
#[cfg(target_os = "macos")]
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::{Child, Command, ExitCode, Output, Stdio};
#[cfg(target_os = "macos")]
use std::thread;
#[cfg(target_os = "macos")]
use std::time::{Duration, Instant};

#[cfg(target_os = "macos")]
use kalcode_updater::mac_swap::{app_executable, atomic_swap_apps, process_identity_sha256};
#[cfg(any(target_os = "macos", test))]
use kalcode_updater::{InstallAttempt, MacSwapAttempt, MacSwapPhase};
#[cfg(target_os = "macos")]
use kalcode_updater::{
    MAX_BUILD_INFO_BYTES, MacBundleVersionEvidence, UpdateJournal, UpdateTarget,
    mac_bundle_version_evidence, validate_compiled_build_info,
};
#[cfg(target_os = "macos")]
use sha2::{Digest, Sha256};

#[cfg(target_os = "macos")]
const PARENT_EXIT_TIMEOUT: Duration = Duration::from_secs(5 * 60);
#[cfg(target_os = "macos")]
const HEALTH_TIMEOUT: Duration = Duration::from_secs(45);
#[cfg(target_os = "macos")]
const POLL_INTERVAL: Duration = Duration::from_millis(200);
#[cfg(target_os = "macos")]
const BUILD_INFO_TIMEOUT: Duration = Duration::from_secs(5);

#[cfg(target_os = "macos")]
fn main() -> ExitCode {
    match run() {
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
fn run() -> Result<(), ()> {
    let journal_path = parse_journal_argument()?;
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

    if journal
        .mark_mac_swap_phase(MacSwapPhase::Swapped, MacSwapPhase::Launched)
        .is_err()
    {
        return rollback(&journal_path, &attempt, &swap, None);
    }
    // Commit the launch phase before starting the new executable. The new app acknowledges the
    // attempt during startup; recording this transition first prevents that acknowledgement from
    // racing the helper's phase write. A launch failure still atomically restores the old app.
    let mut child = match launch_app(&swap.current_app) {
        Ok(child) => child,
        Err(()) => return rollback(&journal_path, &attempt, &swap, None),
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
            return rollback(&journal_path, &attempt, &swap, None);
        }
        thread::sleep(POLL_INTERVAL);
    }
    rollback(&journal_path, &attempt, &swap, Some(&mut child))
}

#[cfg(target_os = "macos")]
fn parse_journal_argument() -> Result<PathBuf, ()> {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new("--journal")) {
        return Err(());
    }
    let path = PathBuf::from(args.next().ok_or(())?);
    if args.next().is_some()
        || !path.is_absolute()
        || path.file_name().and_then(|name| name.to_str()) != Some("updater.json")
    {
        return Err(());
    }
    Ok(path)
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
        || verify_app_identity(
            &swap.current_app,
            &attempt.from_version,
            &binding.signing_requirement_sha256,
        )
        .is_err()
        || verify_app_identity(
            &swap.staged_app,
            &attempt.to_version,
            &binding.signing_requirement_sha256,
        )
        .is_err()
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
        || verify_app_identity(
            &swap.staged_app,
            &attempt.from_version,
            &binding.signing_requirement_sha256,
        )
        .is_err()
        || verify_app_identity(
            &swap.current_app,
            &attempt.to_version,
            &binding.signing_requirement_sha256,
        )
        .is_err()
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
        || verify_app_identity(
            &swap.current_app,
            &attempt.from_version,
            &binding.signing_requirement_sha256,
        )
        .is_err()
        || verify_app_identity(
            &swap.staged_app,
            &attempt.to_version,
            &binding.signing_requirement_sha256,
        )
        .is_err()
    {
        return Err(());
    }
    kalcode_updater::mac_swap::remove_swapped_out_app(&swap.current_app, &swap.staged_app)
        .map_err(|_| ())
}

#[cfg(target_os = "macos")]
fn verify_app_identity(
    app: &Path,
    expected_version: &str,
    expected_requirement_sha256: &str,
) -> Result<(), ()> {
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
    if format!("{:x}", Sha256::digest(requirement.as_bytes())) != expected_requirement_sha256 {
        return Err(());
    }
    let executable = app_executable(app);
    let architectures = checked(Command::new("/usr/bin/lipo").arg("-archs").arg(&executable))?;
    if std::str::from_utf8(&architectures.stdout)
        .map_err(|_| ())?
        .split_whitespace()
        .collect::<Vec<_>>()
        .as_slice()
        != ["arm64"]
    {
        return Err(());
    }
    let plist = app.join("Contents").join("Info.plist");
    let version = checked(
        Command::new("/usr/bin/plutil")
            .args(["-extract", "CFBundleShortVersionString", "raw", "-o", "-"])
            .arg(plist),
    )?;
    let bundle_short_version = std::str::from_utf8(&version.stdout).map_err(|_| ())?.trim();
    if mac_bundle_version_evidence(bundle_short_version, expected_version).map_err(|_| ())?
        == MacBundleVersionEvidence::CompiledBuildInfo
    {
        let build_info = checked_bounded(
            Command::new(&executable).arg("--build-info"),
            BUILD_INFO_TIMEOUT,
        )?;
        if !build_info.stderr.is_empty() {
            return Err(());
        }
        validate_compiled_build_info(&build_info.stdout, expected_version).map_err(|_| ())?;
    }
    Ok(())
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
fn checked_bounded(command: &mut Command, timeout: Duration) -> Result<Output, ()> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| ())?;
    let stdout = child.stdout.take().ok_or(())?;
    let stderr = child.stderr.take().ok_or(())?;
    let stdout_reader = thread::spawn(move || read_bounded_output(stdout));
    let stderr_reader = thread::spawn(move || read_bounded_output(stderr));
    let started = Instant::now();
    let status = loop {
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(());
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => thread::sleep(POLL_INTERVAL),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(());
            }
        }
    };
    let stdout = stdout_reader.join().map_err(|_| ())?.map_err(|_| ())?;
    let stderr = stderr_reader.join().map_err(|_| ())?.map_err(|_| ())?;
    if !status.success()
        || stdout.len() > MAX_BUILD_INFO_BYTES
        || stderr.len() > MAX_BUILD_INFO_BYTES
    {
        return Err(());
    }
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

#[cfg(target_os = "macos")]
fn read_bounded_output(mut reader: impl Read) -> io::Result<Vec<u8>> {
    let mut kept = Vec::new();
    let mut buffer = [0_u8; 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            return Ok(kept);
        }
        let remaining = MAX_BUILD_INFO_BYTES
            .saturating_add(1)
            .saturating_sub(kept.len());
        kept.extend_from_slice(&buffer[..read.min(remaining)]);
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

#[cfg(any(target_os = "macos", test))]
fn exact_attempt_still_owns_legacy_rollback(
    captured: &InstallAttempt,
    observed: &InstallAttempt,
    observed_swap: &MacSwapAttempt,
) -> bool {
    let Some(mut expected_swap) = captured.mac_swap.clone() else {
        return false;
    };
    expected_swap.phase = observed_swap.phase;
    let mut expected_attempt = captured.clone();
    expected_attempt.mac_swap = Some(expected_swap.clone());
    matches!(
        observed_swap.phase,
        MacSwapPhase::Swapped | MacSwapPhase::Launched
    ) && observed_swap == &expected_swap
        && observed == &expected_attempt
}

#[cfg(target_os = "macos")]
fn rollback(
    journal_path: &Path,
    attempt: &kalcode_updater::InstallAttempt,
    swap: &MacSwapAttempt,
    child: Option<&mut Child>,
) -> Result<(), ()> {
    if let Some(child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
    let observed = UpdateJournal::load(journal_path).map_err(|_| ())?;
    let binding = attempt.binding.as_ref().ok_or(())?;
    let (observed_attempt, observed_swap) = pending_mac_swap(&observed)?;
    if !exact_attempt_still_owns_legacy_rollback(attempt, &observed_attempt, &observed_swap)
        || digest_file(&app_executable(&swap.staged_app))? != binding.source_sha256
        || verify_app_identity(
            &swap.staged_app,
            &attempt.from_version,
            &binding.signing_requirement_sha256,
        )
        .is_err()
        || verify_app_identity(
            &swap.current_app,
            &attempt.to_version,
            &binding.signing_requirement_sha256,
        )
        .is_err()
    {
        return Err(());
    }
    atomic_swap_apps(&swap.current_app, &swap.staged_app).map_err(|_| ())?;
    if digest_file(&app_executable(&swap.current_app))? != binding.source_sha256
        || verify_app_identity(
            &swap.current_app,
            &attempt.from_version,
            &binding.signing_requirement_sha256,
        )
        .is_err()
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
            let restored = launch_app(&swap.current_app)?;
            drop(restored);
            Ok(())
        },
        || remove_verified_failed_app(attempt, swap),
    )?;
    Err(())
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::fs;

    #[cfg(target_os = "macos")]
    use std::process::Command;
    #[cfg(target_os = "macos")]
    use std::time::{Duration, Instant};

    use kalcode_updater::{
        InstallAttempt, InstallBinding, InstallKind, MacSwapAttempt, MacSwapPhase, UpdateJournal,
        UpdateTarget,
    };
    use tempfile::tempdir;

    use super::{exact_attempt_still_owns_legacy_rollback, finish_health_rollback};

    #[cfg(target_os = "macos")]
    use super::checked_bounded;

    #[test]
    fn forward_only_fence_blocks_legacy_swap_before_new_app_or_user_data_changes() {
        let temp = tempdir().unwrap();
        let journal_path = temp.path().join("updater.json");
        let current_app = temp.path().join("KalCode.app");
        let staged_app = temp.path().join(".KalCode-update-test.app");
        let user_data = temp.path().join("owner-data.sqlite");
        fs::create_dir(&current_app).unwrap();
        fs::create_dir(&staged_app).unwrap();
        fs::write(current_app.join("version"), b"schema20-capable").unwrap();
        fs::write(staged_app.join("version"), b"schema19-only").unwrap();
        fs::write(&user_data, b"schema20-owner-data").unwrap();
        let mut journal = UpdateJournal::load(&journal_path).unwrap();
        journal
            .record_install_attempt(InstallAttempt {
                kind: InstallKind::Upgrade,
                from_version: "0.1.7".into(),
                to_version: "0.1.7+1".into(),
                sha256: "a".repeat(64),
                binding: Some(InstallBinding {
                    target: UpdateTarget::DarwinAarch64,
                    source_sha256: "c".repeat(64),
                    signing_requirement_sha256: "d".repeat(64),
                }),
                mac_swap: Some(MacSwapAttempt {
                    current_app: current_app.clone(),
                    staged_app: staged_app.clone(),
                    parent_pid: 42,
                    parent_identity_sha256: "e".repeat(64),
                    phase: MacSwapPhase::Prepared,
                }),
                started_at: "2026-09-30T12:00:00Z".into(),
            })
            .unwrap();
        journal
            .mark_mac_swap_phase(MacSwapPhase::Prepared, MacSwapPhase::Swapped)
            .unwrap();
        journal
            .mark_mac_swap_phase(MacSwapPhase::Swapped, MacSwapPhase::Launched)
            .unwrap();
        let captured = journal.state().install_attempt.clone().unwrap();
        journal.fence_forward_only_mac_install("0.1.7+1").unwrap();
        let observed = journal.state().install_attempt.as_ref().unwrap();
        let observed_swap = observed.mac_swap.as_ref().unwrap();

        let swap_was_called =
            exact_attempt_still_owns_legacy_rollback(&captured, observed, observed_swap);

        assert!(!swap_was_called);
        assert_eq!(
            fs::read(current_app.join("version")).unwrap(),
            b"schema20-capable"
        );
        assert_eq!(
            fs::read(staged_app.join("version")).unwrap(),
            b"schema19-only"
        );
        assert_eq!(fs::read(user_data).unwrap(), b"schema20-owner-data");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn compiled_identity_probe_rejects_nonzero_oversized_and_timed_out_processes() {
        assert!(
            checked_bounded(
                Command::new("/bin/sh").args(["-c", "exit 7"]),
                Duration::from_secs(1),
            )
            .is_err()
        );
        assert!(
            checked_bounded(
                Command::new("/bin/sh").args(["-c", "dd if=/dev/zero bs=4097 count=1 2>/dev/null"]),
                Duration::from_secs(1),
            )
            .is_err()
        );

        let started = Instant::now();
        assert!(
            checked_bounded(
                Command::new("/bin/sleep").arg("10"),
                Duration::from_millis(50),
            )
            .is_err()
        );
        assert!(started.elapsed() < Duration::from_secs(2));
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
