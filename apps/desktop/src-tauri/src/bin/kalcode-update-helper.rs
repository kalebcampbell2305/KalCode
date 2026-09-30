//! Post-exit macOS updater helper. It is bundled inside the signed KalCode app and has no network
//! authority. The desktop process records the complete target-bound swap plan before launch.

#[cfg(target_os = "macos")]
use std::fs::File;
#[cfg(target_os = "macos")]
use std::io::Read;
#[cfg(target_os = "macos")]
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::{Child, Command, ExitCode, Output};
#[cfg(target_os = "macos")]
use std::thread;
#[cfg(target_os = "macos")]
use std::time::{Duration, Instant};

#[cfg(target_os = "macos")]
use kalcode_updater::mac_swap::{app_executable, atomic_swap_apps, process_identity_sha256};
#[cfg(target_os = "macos")]
use kalcode_updater::{MacSwapAttempt, MacSwapPhase, UpdateJournal, UpdateTarget};
#[cfg(target_os = "macos")]
use sha2::{Digest, Sha256};

#[cfg(target_os = "macos")]
const PARENT_EXIT_TIMEOUT: Duration = Duration::from_secs(5 * 60);
#[cfg(target_os = "macos")]
const HEALTH_TIMEOUT: Duration = Duration::from_secs(45);
#[cfg(target_os = "macos")]
const POLL_INTERVAL: Duration = Duration::from_millis(200);

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
    let bundle_version = if short_version == expected_version {
        None
    } else {
        Some(plist_value("CFBundleVersion")?)
    };
    if !kalcode_updater::mac_swap::bundle_version_matches(
        &short_version,
        bundle_version.as_deref(),
        expected_version,
    ) {
        return Err(());
    }
    let architectures = checked(
        Command::new("/usr/bin/lipo")
            .arg("-archs")
            .arg(app_executable(app)),
    )?;
    if std::str::from_utf8(&architectures.stdout)
        .map_err(|_| ())?
        .split_whitespace()
        .collect::<Vec<_>>()
        .as_slice()
        != ["arm64"]
    {
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
    let (observed_attempt, observed_swap) = pending_mac_swap(&observed)?;
    let mut expected_swap = swap.clone();
    expected_swap.phase = observed_swap.phase;
    let mut expected_attempt = attempt.clone();
    expected_attempt.mac_swap = Some(expected_swap.clone());
    if !matches!(
        observed_swap.phase,
        MacSwapPhase::Swapped | MacSwapPhase::Launched
    ) || observed_swap != expected_swap
        || observed_attempt != expected_attempt
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

    use super::finish_health_rollback;

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
