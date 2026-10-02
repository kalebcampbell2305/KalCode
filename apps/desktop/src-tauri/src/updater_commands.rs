//! Signed, channel-bound desktop updates. The WebView receives only redacted lifecycle state;
//! feed parsing, bounded download, updater signature verification, recovery cache, and installer
//! launch stay native.

use std::collections::HashMap;
use std::io::{Read as _, Write as _};
use std::str::FromStr;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use futures_util::future::{AbortHandle, AbortRegistration, Abortable};
use kalcode_core::{ErrorCategory, IpcError, KalError};
use kalcode_updater::{
    ArtifactFormat, Candidate, InstallAttempt, InstallBinding, InstallKind, InstallOutcome,
    JournalState, MAX_UPDATE_BYTES, MacSwapAttempt, MacSwapPhase, OperationToken, RollbackCache,
    UpdateChannel, UpdateError, UpdateJournal, UpdateMachine, UpdatePhase, UpdateStatus,
    UpdateTarget, same_public_build, validate_candidate_for_target,
    validate_retained_candidate_for_target, verify_download, verify_signature_for_metadata,
};
use reqwest::header::ACCEPT;
use reqwest::redirect::Policy;
use semver::Version;
use serde::Deserialize;
use tauri::{AppHandle, State, WebviewWindow};
use url::Url;

mod apply_lease;
mod installer;
mod silent_fallback;
use apply_lease::ApplyLease;
use installer::PreparedInstaller;
use silent_fallback::SilentInstallRecord;

const NETWORK_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const USER_AGENT: &str = concat!("KalCode/", env!("CARGO_PKG_VERSION"));
const MAX_FEED_BYTES: u64 = 64 * 1024;
/// The build that most recently raised this data folder's database schema. Every migration is
/// forward-only, so recovery may only restore a build at or after this floor.
const ROLLBACK_FLOOR_FILE: &str = "rollback-floor";
const MAX_ROLLBACK_FLOOR_BYTES: u64 = 256;

fn require_stable_installer() -> Result<(), UpdateError> {
    if cfg!(debug_assertions) {
        return Err(UpdateError::new(
            "dev_update_unavailable",
            "KalCode Dev cannot install Stable updates. Rebuild the development app instead.",
        ));
    }
    Ok(())
}
/// While KalCode runs, the signed feed is re-checked about this often (the launch check covers
/// startup), jittered by `PERIODIC_CHECK_JITTER_PERCENT` either way.
const PERIODIC_CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const PERIODIC_CHECK_JITTER_PERCENT: u64 = 10;
/// The periodic timer re-reads the wall clock at least this often, so a machine that slept
/// through the due time re-checks soon after it wakes.
const PERIODIC_CHECK_POLL: Duration = Duration::from_secs(60);

/// Quiesces active work before an installer can be launched. `false` means at least one runtime
/// could not prove it stopped within its bounded shutdown window, so installation must abort.
pub type BeforeUpdaterExit = Arc<dyn Fn() -> bool + Send + Sync + 'static>;

struct PreparedUpdate {
    candidate: Candidate,
    bytes: Vec<u8>,
    signature: String,
    /// A newer build of the running public version, already verified and staged. It installs
    /// when KalCode closes (`install_staged_on_exit`); dropping it removes the staged files.
    installer: Option<PreparedInstaller>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoteFeed {
    version: String,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default)]
    pub_date: Option<String>,
    platforms: HashMap<String, RemotePlatform>,
    kalcode: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RemotePlatform {
    url: String,
    signature: String,
}

#[derive(Debug)]
struct ReleaseDescriptor {
    candidate: Candidate,
    download_url: Url,
    signature: String,
}

struct Runtime {
    machine: UpdateMachine,
    prepared: Option<PreparedUpdate>,
    active_check: Option<(OperationToken, AbortHandle)>,
}

impl Runtime {
    /// Begins a check only when `allowed` accepts the current phase. The gate and the transition
    /// share one lock, so a phase the gate refuses (a staged Ready update) is left untouched,
    /// prepared bytes included.
    fn begin_check_if(
        &mut self,
        allowed: fn(UpdatePhase) -> bool,
    ) -> Result<Option<(OperationToken, UpdateChannel, AbortRegistration)>, UpdateError> {
        if !allowed(self.machine.status().phase) {
            return Ok(None);
        }
        self.discard_prepared();
        self.begin_cancellable_check().map(Some)
    }

    fn begin_cancellable_check(
        &mut self,
    ) -> Result<(OperationToken, UpdateChannel, AbortRegistration), UpdateError> {
        let token = self.machine.begin_check()?;
        let channel = self.machine.status().channel;
        let (handle, registration) = AbortHandle::new_pair();
        self.active_check = Some((token, handle));
        Ok((token, channel, registration))
    }

    fn abort_check(&mut self) {
        if let Some((_token, handle)) = self.active_check.take() {
            handle.abort();
        }
    }

    fn finish_check(&mut self, token: OperationToken) {
        if self
            .active_check
            .as_ref()
            .is_some_and(|(active, _handle)| *active == token)
        {
            self.active_check = None;
        }
    }

    fn cancel(&mut self) -> Result<(), UpdateError> {
        self.abort_check();
        self.discard_prepared();
        self.machine.cancel()
    }

    fn set_channel(&mut self, channel: UpdateChannel) -> Result<(), UpdateError> {
        self.abort_check();
        self.discard_prepared();
        self.machine.set_channel(channel)
    }

    /// Admits one install of the staged update. `Err` is a refusal and changes nothing. Once
    /// `Ok`, the caller owns the updater; the inner result says whether the staged bytes still
    /// match the verified release (a mismatch is the owner's failure to record).
    fn admit_install(
        &mut self,
    ) -> Result<(OperationToken, Result<PreparedUpdate, UpdateError>), UpdateError> {
        let (expected, token) = self.machine.begin_install()?;
        let prepared = match self.prepared.take() {
            None => Err(UpdateError::new(
                "update_not_ready",
                "No verified update is ready to install.",
            )),
            Some(prepared) if prepared.candidate != expected => Err(UpdateError::new(
                "update_state_invalid",
                "The prepared update no longer matches the verified release.",
            )),
            Some(prepared) => Ok(prepared),
        };
        Ok((token, prepared))
    }

    /// Admits the install of a staged same-version build as KalCode closes. Refuses, changing
    /// nothing, unless an installer is staged for the Ready release.
    fn admit_exit_install(
        &mut self,
    ) -> Result<(OperationToken, Result<PreparedUpdate, UpdateError>), UpdateError> {
        if !self.staged_for_exit() {
            return Err(UpdateError::new(
                "update_not_ready",
                "No verified update is ready to install.",
            ));
        }
        self.admit_install()
    }

    /// Admits one restore of the verified previous version. `Err` is a refusal and changes
    /// nothing.
    fn admit_recovery(&mut self) -> Result<(OperationToken, ()), UpdateError> {
        self.machine.begin_recovery().map(|token| (token, ()))
    }

    fn staged_for_exit(&self) -> bool {
        self.machine.status().phase == UpdatePhase::Ready
            && self
                .prepared
                .as_ref()
                .is_some_and(|prepared| prepared.installer.is_some())
    }

    fn status(&self) -> UpdateStatus {
        let mut status = self.machine.status().clone();
        status.install_on_quit = self.staged_for_exit();
        status
    }

    /// Drops the prepared update and any staged installer (see `discard_staged`).
    fn discard_prepared(&mut self) {
        if let Some(installer) = self.prepared.take().and_then(|prepared| prepared.installer) {
            discard_staged(installer);
        }
    }
}

/// Records the previous install's result whatever the preparation sweep reported: a sweep
/// failure must never hide that result or trigger a rollback of a good update. The sweep only
/// gates new preparations, and only while an earlier one is still running (`Ok(false)`).
fn reconcile_after_cleanup(
    journal: &mut UpdateJournal,
    cleanup: Result<bool, UpdateError>,
    target_matches: bool,
    startup_healthy: bool,
    current_version: &str,
) -> (bool, Result<Option<InstallOutcome>, UpdateError>) {
    let preparation_ready = cleanup.unwrap_or_else(|error| {
        // A preparation re-validates its own storage, so this failure is reported there.
        tracing::warn!(
            event = "updater.startup_cleanup_failed",
            error_code = error.code()
        );
        true
    });
    // An unhealthy startup must not acknowledge the install: on macOS the helper then restores
    // the previous app, which a forward-only migration has fenced off when it would be unsafe.
    let outcome = (target_matches && startup_healthy)
        .then(|| journal.reconcile_startup(current_version))
        .transpose();
    (preparation_ready, outcome)
}

fn lock_runtime(runtime: &Mutex<Runtime>) -> MutexGuard<'_, Runtime> {
    runtime.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Runs an install or restore that must first win the updater's exclusive admission. A refused
/// admission returns its error without touching the machine: the phase it was refused for
/// belongs to another worker's operation. Once admitted, only this owner's token can record the
/// failure, so a refused or stale request can never fail (and so reopen) an operation it does
/// not own.
fn run_owned_operation<A, T>(
    runtime: &Mutex<Runtime>,
    admit: impl FnOnce(&mut Runtime) -> Result<(OperationToken, A), UpdateError>,
    operation: impl FnOnce(OperationToken, A) -> Result<T, UpdateError>,
) -> Result<T, UpdateError> {
    let (token, admitted) = admit(&mut lock_runtime(runtime))?;
    let result = operation(token, admitted);
    if let Err(error) = &result {
        // A stale token means the operation was already replaced; nothing is ours to fail.
        let _ = lock_runtime(runtime)
            .machine
            .fail_operation(token, error.to_string());
    }
    result
}

struct Inner {
    app: AppHandle,
    current_version: String,
    target: Option<UpdateTarget>,
    public_key: Option<String>,
    runtime: Mutex<Runtime>,
    journal: Mutex<Option<UpdateJournal>>,
    rollback: RollbackCache,
    /// See [`ROLLBACK_FLOOR_FILE`]; `None` (missing or unreadable) offers no recovery.
    rollback_floor: Option<String>,
    update_dir: std::path::PathBuf,
    prepared_dir: std::path::PathBuf,
    before_exit: BeforeUpdaterExit,
    preparation: crate::update_preparation::UpdatePreparation,
    preparation_ready: bool,
    /// See `silent_fallback`: same-version builds whose silent install failed.
    silent_record: Mutex<Option<SilentInstallRecord>>,
    /// A staging failure counts once per session.
    staging_failure_counted: std::sync::atomic::AtomicBool,
    /// Dropping the sender stops the periodic re-check timer.
    periodic_stop: Mutex<Option<Sender<()>>>,
}

#[derive(Clone)]
pub struct DesktopUpdaterState(Arc<Inner>);

impl DesktopUpdaterState {
    pub fn start(
        app: AppHandle,
        data_dir: &std::path::Path,
        current_version: &str,
        startup_healthy: bool,
        public_key: Option<&str>,
        before_exit: BeforeUpdaterExit,
    ) -> Self {
        let update_dir = data_dir.join("updates");
        let rollback_floor = read_rollback_floor(&update_dir);
        let target = UpdateTarget::current().ok();
        let mut preparation_ready = false;
        let (journal, mut machine) = match UpdateJournal::load(update_dir.join("updater.json")) {
            Ok(mut journal) => {
                let channel = journal.state().channel;
                let mut machine = UpdateMachine::new(channel, current_version);
                let target_matches = journal
                    .state()
                    .install_attempt
                    .as_ref()
                    .and_then(|attempt| attempt.binding.as_ref())
                    .is_none_or(|binding| Some(binding.target) == target);
                // The helper still owns any journaled macOS swap. Preserve it while sweeping
                // abandoned preparations, before reconciliation changes the pending record.
                let cleanup = installer::cleanup_startup(
                    &update_dir.join("prepared"),
                    journal
                        .state()
                        .install_attempt
                        .as_ref()
                        .and_then(|attempt| attempt.mac_swap.as_ref()),
                );
                let superseded = superseded_mac_bundle(journal.state(), current_version);
                let (ready, outcome) = reconcile_after_cleanup(
                    &mut journal,
                    cleanup,
                    target_matches,
                    startup_healthy,
                    current_version,
                );
                preparation_ready = ready;
                if matches!(outcome, Ok(Some(InstallOutcome::Updated)))
                    && let Some(swap) = superseded
                    && apply_lease::applying_from(&update_dir.join(apply_lease::LEASE_FILE))
                        .is_none()
                {
                    // The helper removes the previous bundle after an update applied while
                    // KalCode was closed. If it was stopped first (a logout right after quitting),
                    // the build it installed removes it here, off the startup path.
                    let _ = std::thread::Builder::new()
                        .name("kalcode-updater-superseded".into())
                        .spawn(move || {
                            if let Err(error) = installer::remove_superseded_app(&swap) {
                                tracing::warn!(
                                    event = "updater.superseded_bundle_kept",
                                    error_code = error.code()
                                );
                            }
                        });
                }
                match outcome {
                    Ok(None) if !startup_healthy => {
                        if journal.state().install_attempt.is_some() {
                            machine.mark_failed(
                                "KalCode couldn't confirm the previous update because startup did not complete.",
                            );
                        }
                    }
                    Ok(None) => {
                        machine.mark_failed("KalCode couldn't verify the previous update target.");
                    }
                    Ok(Some(
                        InstallOutcome::NoPendingInstall
                        | InstallOutcome::Updated
                        | InstallOutcome::RolledBack,
                    )) => {}
                    Ok(Some(InstallOutcome::PreviousVersionPreserved)) => {
                        machine.mark_failed(
                            "The update did not complete. Your previous version was preserved.",
                        );
                    }
                    Ok(Some(InstallOutcome::UnexpectedVersion)) | Err(_) => {
                        machine.mark_failed("KalCode couldn't verify the previous update result.");
                    }
                }
                (Some(journal), machine)
            }
            Err(_) => {
                let mut machine = UpdateMachine::new(UpdateChannel::Stable, current_version);
                machine.mark_failed("KalCode's update recovery record is damaged.");
                (None, machine)
            }
        };
        let silent_record_path = update_dir.join(silent_fallback::RECORD_FILE);
        let loaded = silent_fallback::load(&silent_record_path);
        // Count a skipped exit from the previous session first, then settle the record on the
        // same healthy-startup gate the journal and the rollback protection use.
        let silent_record = silent_fallback::reconcile_at_launch(
            silent_fallback::count_skipped_exit(loaded.clone()),
            current_version,
            startup_healthy,
        );
        if silent_record != loaded {
            let _ = silent_fallback::save(&silent_record_path, silent_record.as_ref());
        }
        let rollback = RollbackCache::new(update_dir.join("rollback"));
        if let Some(key) = public_key {
            match rollback.load_verified(key) {
                Ok(Some(artifact)) => machine.set_recovery_available(
                    target == Some(artifact.receipt().target())
                        && schema_compatible_recovery(
                            current_version,
                            &artifact.receipt().version,
                            rollback_floor.as_deref(),
                        ),
                ),
                Ok(None) => {}
                Err(_) => {
                    machine.mark_failed("The saved recovery package did not pass verification.")
                }
            }
        } else {
            machine.mark_failed("Automatic updates aren't configured in this build.");
        }
        if target.is_none() {
            machine.mark_failed("Automatic updates aren't available for this platform.");
        }
        Self(Arc::new(Inner {
            app,
            current_version: current_version.to_owned(),
            target,
            public_key: public_key.map(str::to_owned),
            runtime: Mutex::new(Runtime {
                machine,
                prepared: None,
                active_check: None,
            }),
            journal: Mutex::new(journal),
            rollback,
            rollback_floor,
            prepared_dir: update_dir.join("prepared"),
            update_dir,
            before_exit,
            preparation: crate::update_preparation::UpdatePreparation::default(),
            preparation_ready,
            silent_record: Mutex::new(silent_record),
            staging_failure_counted: std::sync::atomic::AtomicBool::new(false),
            periodic_stop: Mutex::new(None),
        }))
    }

    pub fn check_in_background(&self) {
        self.spawn_background_check(any_phase);
    }

    pub fn cancel_preparation_for_exit(&self, timeout: Duration) -> bool {
        self.0.preparation.cancel_and_wait(timeout)
    }

    pub fn reopen_preparation(&self) {
        self.0.preparation.reopen();
    }

    fn begin_preparation(&self) -> Result<crate::update_preparation::Preparation<'_>, UpdateError> {
        if !self.0.preparation_ready {
            return Err(UpdateError::new(
                "update_cleanup_failed",
                "KalCode couldn't safely recover an earlier update preparation. Restart KalCode and try again.",
            ));
        }
        self.0.preparation.begin().ok_or_else(preparation_cancelled)
    }

    /// The launch check's pipeline, gated on `periodic_recheck_allowed`.
    fn recheck_in_background(&self) {
        self.spawn_background_check(periodic_recheck_allowed);
    }

    fn spawn_background_check(&self, allowed: fn(UpdatePhase) -> bool) {
        let updater = self.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = updater.check_when(allowed).await {
                tracing::warn!(
                    event = "updater.background_check_failed",
                    error_code = error.code()
                );
            }
        });
    }

    /// Re-checks the signed feed about every six hours (plus or minus 10%) while KalCode runs,
    /// through the same check as launch. Idempotent; `stop_periodic_checks` ends it on shutdown.
    pub fn start_periodic_checks(&self) {
        let (stop, stopped) = mpsc::channel();
        {
            let mut slot = self
                .0
                .periodic_stop
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if slot.is_some() {
                return;
            }
            *slot = Some(stop);
        }
        let updater = self.clone();
        let spawned = std::thread::Builder::new()
            .name("kalcode-updater-periodic".into())
            .spawn(move || {
                run_periodic_checks(
                    &stopped,
                    PERIODIC_CHECK_POLL,
                    || jittered_interval(PERIODIC_CHECK_INTERVAL, jitter_sample()),
                    || updater.recheck_in_background(),
                );
            });
        if spawned.is_err() {
            tracing::warn!(event = "updater.periodic_check_unavailable");
            self.stop_periodic_checks();
        }
    }

    pub fn stop_periodic_checks(&self) {
        drop(
            self.0
                .periodic_stop
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .take(),
        );
    }

    fn runtime(&self) -> MutexGuard<'_, Runtime> {
        lock_runtime(&self.0.runtime)
    }

    fn journal(&self) -> MutexGuard<'_, Option<UpdateJournal>> {
        self.0
            .journal
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn key(&self) -> Result<&str, UpdateError> {
        self.0.public_key.as_deref().ok_or_else(|| {
            UpdateError::new(
                "updater_not_configured",
                "Automatic updates aren't configured in this build.",
            )
        })
    }

    fn target(&self) -> Result<UpdateTarget, UpdateError> {
        self.0.target.ok_or_else(|| {
            UpdateError::new(
                "update_target_unsupported",
                "Automatic updates aren't available for this platform.",
            )
        })
    }

    pub fn status(&self) -> UpdateStatus {
        self.runtime().status()
    }

    pub fn set_channel(&self, channel: UpdateChannel) -> Result<UpdateStatus, UpdateError> {
        let mut journal = self.journal();
        let journal = journal.as_mut().ok_or_else(|| {
            UpdateError::new(
                "update_state_unavailable",
                "KalCode's update settings are unavailable.",
            )
        })?;
        let mut runtime = self.runtime();
        runtime.set_channel(channel)?;
        if let Err(error) = journal.set_channel(channel) {
            runtime.machine.mark_failed(error.to_string());
            return Err(error);
        }
        Ok(runtime.status())
    }

    pub fn cancel(&self) -> Result<UpdateStatus, UpdateError> {
        let mut runtime = self.runtime();
        runtime.cancel()?;
        Ok(runtime.status())
    }

    async fn check(&self) -> Result<UpdateStatus, UpdateError> {
        self.check_when(any_phase).await
    }

    /// Returns the unchanged status when `allowed` refuses the current phase.
    async fn check_when(
        &self,
        allowed: fn(UpdatePhase) -> bool,
    ) -> Result<UpdateStatus, UpdateError> {
        let public_key = self.key()?.to_owned();
        let _target = self.target()?;
        let (token, channel, registration) = {
            let mut runtime = self.runtime();
            match runtime.begin_check_if(allowed)? {
                Some(begun) => begun,
                None => return Ok(runtime.status()),
            }
        };
        let result =
            Abortable::new(self.check_inner(token, channel, &public_key), registration).await;
        let mut runtime = self.runtime();
        runtime.finish_check(token);
        match result {
            Err(_) => Ok(runtime.status()),
            Ok(Ok(_)) => Ok(runtime.status()),
            Ok(Err(error)) => {
                runtime.discard_prepared();
                if runtime.machine.check_token(token).is_err() {
                    return Ok(runtime.status());
                }
                let _ = runtime.machine.fail(token, error.to_string());
                Err(error)
            }
        }
    }

    async fn check_inner(
        &self,
        token: kalcode_updater::OperationToken,
        channel: UpdateChannel,
        public_key: &str,
    ) -> Result<UpdateStatus, UpdateError> {
        let Some(release) = self
            .fetch_newer_release(channel.endpoint(), channel, token)
            .await?
        else {
            let mut runtime = self.runtime();
            runtime.machine.no_update(token)?;
            return Ok(runtime.status());
        };
        let candidate = release.candidate;

        let recovery_available = self.ensure_recovery_baseline(public_key, token).await?;
        {
            let mut runtime = self.runtime();
            runtime.machine.set_recovery_available(recovery_available);
            runtime.machine.begin_download(token, candidate.clone())?;
        }
        let bytes = self
            .download_bounded(
                &release.download_url,
                &release.signature,
                &candidate,
                public_key,
                |chunk, total| {
                    self.runtime()
                        .machine
                        .download_progress(token, chunk, total)
                },
            )
            .await?;
        // A newer build of the running public version installs when KalCode closes, with no
        // prompt. Stage it now, while KalCode runs, so closing only has to start it. A build
        // whose silent install already failed is offered with the restart prompt instead.
        let silent = same_public_build(&self.0.current_version, &candidate.version)
            && !silent_fallback::prompt_instead(self.silent_record().as_ref(), &candidate.version);
        let (bytes, installer) = if silent {
            match self.stage_for_exit(token, candidate.clone(), bytes).await {
                Ok((bytes, installer)) => {
                    self.update_silent_record(|record| {
                        silent_fallback::after_staging_success(record, &candidate.version)
                    });
                    (bytes, Some(installer))
                }
                Err(error) => {
                    if counts_as_staging_failure(&error)
                        && !self
                            .0
                            .staging_failure_counted
                            .swap(true, std::sync::atomic::Ordering::AcqRel)
                    {
                        self.update_silent_record(|record| {
                            Some(silent_fallback::after_staging_failure(
                                record,
                                &candidate.version,
                            ))
                        });
                    }
                    return Err(error);
                }
            }
        } else {
            (bytes, None)
        };
        let mut runtime = self.runtime();
        if let Err(error) = runtime.machine.ready(token, candidate.clone()) {
            drop(runtime);
            if let Some(installer) = installer {
                discard_staged(installer);
            }
            return Err(error);
        }
        runtime.prepared = Some(PreparedUpdate {
            candidate,
            bytes,
            signature: release.signature,
            installer,
        });
        Ok(runtime.status())
    }

    /// Stages a verified same-version build for `install_staged_on_exit`, off the async
    /// executor. Staging holds the preparation gate, so quitting cancels it (and waits for its
    /// cleanup); a staged build holds nothing, so quitting never waits on it.
    async fn stage_for_exit(
        &self,
        token: OperationToken,
        candidate: Candidate,
        bytes: Vec<u8>,
    ) -> Result<(Vec<u8>, PreparedInstaller), UpdateError> {
        require_stable_installer()?;
        let updater = self.clone();
        run_blocking_update(move || {
            let installer = updater.stage_blocking(token, &candidate, &bytes)?;
            Ok((bytes, installer))
        })
        .await
    }

    fn stage_blocking(
        &self,
        token: OperationToken,
        candidate: &Candidate,
        bytes: &[u8],
    ) -> Result<PreparedInstaller, UpdateError> {
        let preparation = self.begin_preparation()?;
        // A cancelled or replaced check stops staging as promptly as quitting does.
        let cancel = || {
            if preparation.cancelled() {
                return Err(preparation_cancelled());
            }
            self.runtime().machine.check_token(token)
        };
        PreparedInstaller::prepare(
            &self.0.prepared_dir,
            &prepared_installer_name(kalcode_contracts::ids::new_id(), candidate.metadata.format),
            bytes,
            &candidate.metadata,
            &candidate.version,
            &self.0.current_version,
            &cancel,
        )
    }

    /// Called once from `RunEvent::Exit`, only after a proven clean drain (see `lib.rs`).
    /// Starts the staged same-version build's installer (Windows) or swap helper (macOS), which
    /// applies it after KalCode exits, silently, and leaves KalCode closed. Without a staged
    /// build this does nothing. A failure leaves the current build installed and is logged; the
    /// update downloads again on the next launch.
    pub fn install_staged_on_exit(&self) {
        if session_ending() {
            // Logoff or shutdown would stop the installer part-way. Install on a later quit.
            return;
        }
        let result = run_owned_operation(
            &self.0.runtime,
            Runtime::admit_exit_install,
            |token, staged| self.install_staged_owned(token, staged?),
        );
        if let Err(error) = result
            && error.code() != "update_not_ready"
        {
            tracing::warn!(
                event = "updater.exit_install_failed",
                error_code = error.code()
            );
        }
    }

    /// The admitted exit install. Only its owner reaches here; see `run_owned_operation`.
    fn install_staged_owned(
        &self,
        token: OperationToken,
        update: PreparedUpdate,
    ) -> Result<(), UpdateError> {
        require_stable_installer()?;
        let installer = update.installer.ok_or_else(|| {
            UpdateError::new(
                "update_not_ready",
                "No verified update is ready to install.",
            )
        })?;
        let binding = installer.binding().clone();
        let mac_swap = installer.mac_swap_attempt();
        self.runtime().machine.check_token(token)?;
        // Recorded first: if this build is not running at the next launch, for any reason, it is
        // offered with the restart prompt rather than silently retried.
        self.update_silent_record(|record| {
            Some(silent_fallback::after_exit_attempt(
                record,
                &update.candidate.version,
            ))
        });
        // The lease only lets a KalCode launched during the install step aside instead of
        // recording a false result; installing without it is still correct.
        let lease = ApplyLease::acquire(
            &self.0.update_dir.join(apply_lease::LEASE_FILE),
            &self.0.current_version,
        )
        .inspect_err(|error| {
            tracing::warn!(
                event = "updater.apply_lease_unavailable",
                error_code = error.code()
            );
        })
        .ok();
        self.record_attempt(
            InstallKind::Upgrade,
            &self.0.current_version,
            &update.candidate.version,
            &update.candidate.metadata.sha256,
            binding,
            mac_swap,
        )?;
        if let Err(error) = installer.launch_after_exit(lease.as_ref()) {
            // Nothing will apply the update, so the journal must not report it pending.
            let _ = self.cancel_attempt("update_launch_failed");
            return Err(error);
        }
        Ok(())
    }

    fn silent_record(&self) -> Option<SilentInstallRecord> {
        self.0
            .silent_record
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn update_silent_record(
        &self,
        next: impl FnOnce(Option<SilentInstallRecord>) -> Option<SilentInstallRecord>,
    ) {
        let mut record = self
            .0
            .silent_record
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let updated = next(record.clone());
        if updated == *record {
            return;
        }
        if let Err(error) = silent_fallback::save(
            &self.0.update_dir.join(silent_fallback::RECORD_FILE),
            updated.as_ref(),
        ) {
            tracing::warn!(event = "updater.silent_record_unsaved", error = %error);
        }
        *record = updated;
    }

    async fn ensure_recovery_baseline(
        &self,
        public_key: &str,
        token: OperationToken,
    ) -> Result<bool, UpdateError> {
        self.runtime().machine.check_token(token)?;
        if let Some(existing) = self.0.rollback.load_verified(public_key)? {
            self.runtime().machine.check_token(token)?;
            let current = Version::parse(&self.0.current_version)
                .map_err(|_| UpdateError::invalid_manifest("current version"))?;
            if existing.receipt().target() == self.target()?
                && (existing.receipt().version == self.0.current_version || !current.pre.is_empty())
            {
                return Ok(schema_compatible_recovery(
                    &self.0.current_version,
                    &existing.receipt().version,
                    self.0.rollback_floor.as_deref(),
                ));
            }
        }
        let current = self.0.current_version.clone();
        let archive_endpoint =
            format!("https://kalcoded.com/releases/updater/stable/{current}.json");
        let release = self
            .fetch_retained_release(&archive_endpoint, &current, token)
            .await?
            .ok_or_else(|| {
                UpdateError::new(
                    "rollback_baseline_unavailable",
                    "KalCode couldn't prepare a verified recovery version.",
                )
            })?;
        let bytes = self
            .download_bounded(
                &release.download_url,
                &release.signature,
                &release.candidate,
                public_key,
                |_chunk, _total| self.runtime().machine.check_token(token),
            )
            .await?;
        self.runtime().machine.check_token(token)?;
        self.0.rollback.store_verified(
            &current,
            &bytes,
            &release.candidate.metadata,
            &release.signature,
            public_key,
        )?;
        self.runtime().machine.check_token(token)?;
        Ok(false)
    }

    async fn fetch_newer_release(
        &self,
        endpoint: &str,
        channel: UpdateChannel,
        token: kalcode_updater::OperationToken,
    ) -> Result<Option<ReleaseDescriptor>, UpdateError> {
        let raw = self
            .fetch_feed(endpoint, || self.runtime().machine.check_token(token))
            .await?;
        let target = self.target()?;
        let Some((feed, value, platform)) = parse_feed(&raw, target)? else {
            return Ok(None);
        };
        let current = Version::parse(&self.0.current_version)
            .map_err(|_| UpdateError::invalid_manifest("current version"))?;
        let announced = Version::parse(feed.version.trim_start_matches('v'))
            .map_err(|_| UpdateError::invalid_manifest("version"))?;
        if announced <= current {
            return Ok(None);
        }
        let mut candidate = validate_candidate_for_target(
            target,
            channel,
            &self.0.current_version,
            &feed.version,
            &platform.url,
            &value,
        )?;
        candidate.notes = feed.notes;
        descriptor(candidate, platform, target)
    }

    async fn fetch_retained_release(
        &self,
        endpoint: &str,
        expected_version: &str,
        token: OperationToken,
    ) -> Result<Option<ReleaseDescriptor>, UpdateError> {
        let raw = self
            .fetch_feed(endpoint, || self.runtime().machine.check_token(token))
            .await?;
        let target = self.target()?;
        let Some((feed, value, platform)) = parse_feed(&raw, target)? else {
            return Ok(None);
        };
        let mut candidate = validate_retained_candidate_for_target(
            target,
            expected_version,
            &feed.version,
            &platform.url,
            &value,
        )?;
        candidate.notes = feed.notes;
        descriptor(candidate, platform, target)
    }

    async fn fetch_feed(
        &self,
        endpoint: &str,
        mut still_current: impl FnMut() -> Result<(), UpdateError>,
    ) -> Result<Option<Vec<u8>>, UpdateError> {
        let endpoint =
            Url::parse(endpoint).map_err(|_| UpdateError::invalid_manifest("endpoint"))?;
        if endpoint.scheme() != "https"
            || endpoint.host_str() != Some("kalcoded.com")
            || endpoint.port().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || !endpoint.path().starts_with("/releases/updater/")
        {
            return Err(UpdateError::invalid_manifest("endpoint"));
        }
        let client = reqwest::Client::builder()
            .redirect(Policy::none())
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(30))
            .user_agent(USER_AGENT)
            .build()
            .map_err(|_| network_error())?;
        let response = client
            .get(endpoint)
            .header(ACCEPT, "application/json")
            .send()
            .await
            .map_err(|_| network_error())?;
        if response.status() == reqwest::StatusCode::NO_CONTENT {
            return Ok(None);
        }
        if !response.status().is_success()
            || response
                .content_length()
                .is_some_and(|size| size > MAX_FEED_BYTES)
        {
            return Err(network_error());
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            still_current()?;
            let chunk = chunk.map_err(|_| network_error())?;
            append_bounded(
                &mut bytes,
                &chunk,
                MAX_FEED_BYTES,
                "update_feed_too_large",
                "The update feed exceeded its safety limit.",
            )?;
        }
        still_current()?;
        Ok(Some(bytes))
    }

    async fn download_bounded<F>(
        &self,
        download_url: &Url,
        signature: &str,
        candidate: &Candidate,
        public_key: &str,
        mut on_chunk: F,
    ) -> Result<Vec<u8>, UpdateError>
    where
        F: FnMut(usize, Option<u64>) -> Result<(), UpdateError>,
    {
        let client = reqwest::Client::builder()
            .redirect(Policy::none())
            .timeout(NETWORK_TIMEOUT)
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(30))
            .user_agent(USER_AGENT)
            .build()
            .map_err(|_| network_error())?;
        let response = client
            .get(download_url.clone())
            .header(ACCEPT, "application/octet-stream")
            .send()
            .await
            .map_err(|_| network_error())?;
        if !response.status().is_success() {
            return Err(network_error());
        }
        let content_length = response.content_length();
        if content_length
            .is_some_and(|size| size != candidate.metadata.size || size > MAX_UPDATE_BYTES)
        {
            return Err(UpdateError::new(
                "update_size_mismatch",
                "The update server reported the wrong size.",
            ));
        }
        let capacity = usize::try_from(candidate.metadata.size).map_err(|_| {
            UpdateError::new(
                "update_too_large",
                "The update is larger than KalCode's safety limit.",
            )
        })?;
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(capacity).map_err(|_| {
            UpdateError::new(
                "update_memory_unavailable",
                "There isn't enough memory to download this update safely.",
            )
        })?;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| network_error())?;
            let next_size = bytes.len().checked_add(chunk.len()).ok_or_else(|| {
                UpdateError::new(
                    "update_too_large",
                    "The update exceeded KalCode's safety limit.",
                )
            })?;
            if next_size as u64 > candidate.metadata.size || next_size as u64 > MAX_UPDATE_BYTES {
                return Err(UpdateError::new(
                    "update_too_large",
                    "The update exceeded KalCode's safety limit.",
                ));
            }
            on_chunk(chunk.len(), content_length)?;
            bytes.extend_from_slice(&chunk);
        }
        verify_download(&bytes, &candidate.metadata)?;
        verify_signature_for_metadata(
            &bytes,
            signature,
            public_key,
            &candidate.version,
            &candidate.metadata,
        )?;
        Ok(bytes)
    }

    fn install(&self) -> Result<(), UpdateError> {
        require_stable_installer()?;
        run_owned_operation(
            &self.0.runtime,
            Runtime::admit_install,
            |token, prepared| self.install_owned(token, prepared?),
        )
    }

    /// The admitted install. Only its owner reaches here; see `run_owned_operation`.
    fn install_owned(
        &self,
        token: OperationToken,
        update: PreparedUpdate,
    ) -> Result<(), UpdateError> {
        let preparation = self.begin_preparation()?;
        let cancel = || {
            if preparation.cancelled() {
                Err(preparation_cancelled())
            } else {
                Ok(())
            }
        };
        let public_key = self.key()?;
        verify_download(&update.bytes, &update.candidate.metadata)?;
        verify_signature_for_metadata(
            &update.bytes,
            &update.signature,
            public_key,
            &update.candidate.version,
            &update.candidate.metadata,
        )?;
        let installer = PreparedInstaller::prepare(
            &self.0.prepared_dir,
            &prepared_installer_name(
                kalcode_contracts::ids::new_id(),
                update.candidate.metadata.format,
            ),
            &update.bytes,
            &update.candidate.metadata,
            &update.candidate.version,
            &self.0.current_version,
            &cancel,
        )?;
        let binding = installer.binding().clone();
        let mac_swap = installer.mac_swap_attempt();
        cancel()?;
        self.runtime().machine.check_token(token)?;
        self.record_attempt(
            InstallKind::Upgrade,
            &self.0.current_version,
            &update.candidate.version,
            &update.candidate.metadata.sha256,
            binding,
            mac_swap,
        )?;
        match launch_after_quiescence(&self.0.before_exit, || installer.launch()) {
            Ok(()) => {
                self.0.app.cleanup_before_exit();
                std::process::exit(0);
            }
            Err(error) if error.code() == "update_shutdown_failed" => {
                let _ = self.cancel_attempt("update_shutdown_failed");
                Err(error)
            }
            Err(error) => {
                tracing::error!(event = "updater.launch_failed", error_code = error.code());
                // The installer never started, so record why instead of letting the restarted
                // build report `install_did_not_advance` (the log may already be closed).
                #[cfg(windows)]
                let _ = self.cancel_attempt("update_launch_failed");
                // Active work was already quiesced. Restart the preserved current build instead
                // of leaving a visible but inert application running.
                self.0.app.restart();
            }
        }
    }

    fn restore_previous(&self) -> Result<(), UpdateError> {
        require_stable_installer()?;
        let public_key = self.key()?.to_owned();
        run_owned_operation(&self.0.runtime, Runtime::admit_recovery, |token, ()| {
            self.restore_owned(token, &public_key)
        })
    }

    /// The admitted restore. Only its owner reaches here; see `run_owned_operation`.
    fn restore_owned(&self, token: OperationToken, public_key: &str) -> Result<(), UpdateError> {
        let (artifact, bytes) = self
            .0
            .rollback
            .load_bytes_verified(public_key)?
            .ok_or_else(|| {
                UpdateError::new(
                    "rollback_unavailable",
                    "No verified previous version is available.",
                )
            })?;
        let version = artifact.receipt().version.clone();
        if artifact.receipt().target() != self.target()? {
            return Err(UpdateError::new(
                "rollback_target_mismatch",
                "The recovery package is for another platform.",
            ));
        }
        let metadata = kalcode_updater::FeedMetadata {
            schema_version: artifact.receipt().updater_schema_version(),
            channel: artifact.receipt().channel(),
            target: artifact.receipt().target(),
            format: artifact.receipt().format(),
            size: artifact.receipt().size,
            sha256: artifact.receipt().sha256.clone(),
            commit: artifact.receipt().commit.clone(),
        };
        verify_download(&bytes, &metadata)?;
        verify_signature_for_metadata(
            &bytes,
            artifact.receipt().signature(),
            public_key,
            &version,
            &metadata,
        )?;
        // Refuse a build that can't open this data before any installer preparation or launch.
        require_schema_compatible_recovery(
            &self.0.current_version,
            &version,
            self.0.rollback_floor.as_deref(),
        )?;
        let preparation = self.begin_preparation()?;
        let cancel = || {
            if preparation.cancelled() {
                Err(preparation_cancelled())
            } else {
                Ok(())
            }
        };
        let installer = PreparedInstaller::prepare(
            &self.0.prepared_dir,
            &prepared_installer_name(kalcode_contracts::ids::new_id(), metadata.format),
            &bytes,
            &metadata,
            &version,
            &self.0.current_version,
            &cancel,
        )?;
        let binding = installer.binding().clone();
        let mac_swap = installer.mac_swap_attempt();
        cancel()?;
        self.runtime().machine.check_token(token)?;
        self.record_attempt(
            InstallKind::Rollback,
            &self.0.current_version,
            &version,
            &metadata.sha256,
            binding,
            mac_swap,
        )?;
        match launch_after_quiescence(&self.0.before_exit, || installer.launch()) {
            Ok(()) => {
                self.0.app.cleanup_before_exit();
                std::process::exit(0);
            }
            Err(error) if error.code() == "update_shutdown_failed" => {
                let _ = self.cancel_attempt("rollback_shutdown_failed");
                Err(error)
            }
            Err(error) => {
                tracing::error!(
                    event = "updater.rollback_launch_failed",
                    error_code = error.code()
                );
                #[cfg(windows)]
                let _ = self.cancel_attempt("rollback_launch_failed");
                self.0.app.restart();
            }
        }
    }

    fn record_attempt(
        &self,
        kind: InstallKind,
        from_version: &str,
        to_version: &str,
        sha256: &str,
        binding: InstallBinding,
        mac_swap: Option<MacSwapAttempt>,
    ) -> Result<(), UpdateError> {
        let started_at = SystemTime::now().duration_since(UNIX_EPOCH).map_or_else(
            |_| "unknown".to_owned(),
            |value| value.as_secs().to_string(),
        );
        let mut journal = self.journal();
        let journal = journal.as_mut().ok_or_else(|| {
            UpdateError::new(
                "update_state_unavailable",
                "KalCode's update settings are unavailable.",
            )
        })?;
        journal.record_install_attempt(InstallAttempt {
            kind,
            from_version: from_version.to_owned(),
            to_version: to_version.to_owned(),
            sha256: sha256.to_owned(),
            binding: Some(binding),
            mac_swap,
            started_at,
        })
    }

    fn cancel_attempt(&self, failure: &'static str) -> Result<(), UpdateError> {
        let mut journal = self.journal();
        journal
            .as_mut()
            .ok_or_else(|| {
                UpdateError::new(
                    "update_state_unavailable",
                    "KalCode's update settings are unavailable.",
                )
            })?
            .cancel_install_attempt(failure)
    }
}

/// The macOS swap that installed `current_version` but left the previous bundle at its staged
/// path: a swap the helper did not finish with a relaunch (`Launched`), whose own health check
/// would otherwise remove that bundle.
fn superseded_mac_bundle(state: &JournalState, current_version: &str) -> Option<MacSwapAttempt> {
    let attempt = state.install_attempt.as_ref()?;
    let swap = attempt.mac_swap.as_ref()?;
    (attempt.to_version == current_version && swap.phase != MacSwapPhase::Launched)
        .then(|| swap.clone())
}

/// Called first at launch, before any state is touched. `true` means this build is the one a
/// post-exit update is replacing right now: the user reopened KalCode while the installer or
/// helper still ran. The caller exits at once; the installer or helper opens the new build when
/// it finishes. Any other launch clears a leftover reopen request, which it satisfies.
pub fn step_aside_for_running_update(data_dir: &std::path::Path, current_version: &str) -> bool {
    let update_dir = data_dir.join("updates");
    let applying = apply_lease::applying_from(&update_dir.join(apply_lease::LEASE_FILE));
    let marker = apply_lease::reopen_marker(&update_dir);
    if apply_lease::superseded_while_applying(applying.as_deref(), current_version) {
        if let Some(marker) = marker {
            let _ = std::fs::File::create(marker);
        }
        return true;
    }
    if let Some(marker) = marker {
        let _ = std::fs::remove_file(marker);
    }
    false
}

/// Quitting, cancelling or replacing a check stops staging on purpose; only a real failure counts
/// toward offering the build with the restart prompt.
fn counts_as_staging_failure(error: &UpdateError) -> bool {
    !matches!(error.code(), "update_cancelled" | "stale_update_operation")
}

/// Drops a staged installer off the caller's thread: removing a staged macOS bundle takes a
/// moment, and callers may be UI or async threads.
fn discard_staged(installer: PreparedInstaller) {
    let _ = std::thread::Builder::new()
        .name("kalcode-updater-discard".into())
        .spawn(move || drop(installer));
}

/// Whether Windows is logging off or shutting down, which would stop an installer part-way.
#[cfg(windows)]
#[allow(unsafe_code)]
fn session_ending() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SHUTTINGDOWN};
    // SAFETY: a side-effect-free query of a documented system metric.
    unsafe { GetSystemMetrics(SM_SHUTTINGDOWN) != 0 }
}

/// The macOS helper is crash-safe at every step (an atomic swap and a journaled phase), so a
/// logout part-way leaves either build installed and the next launch reconciles it.
#[cfg(not(windows))]
const fn session_ending() -> bool {
    false
}

/// Launch and manual checks may start from any phase (the state machine refuses busy ones).
fn any_phase(_phase: UpdatePhase) -> bool {
    true
}

/// Only a settled updater re-checks on its own: never while a check, download or install is
/// running, and never while a verified update is Ready (a re-check would drop the staged bytes).
fn periodic_recheck_allowed(phase: UpdatePhase) -> bool {
    match phase {
        UpdatePhase::Idle | UpdatePhase::UpToDate | UpdatePhase::Failed => true,
        UpdatePhase::Checking
        | UpdatePhase::Downloading
        | UpdatePhase::Ready
        | UpdatePhase::Installing => false,
    }
}

/// `base` spread uniformly over plus or minus `PERIODIC_CHECK_JITTER_PERCENT`, chosen by `sample`.
fn jittered_interval(base: Duration, sample: u64) -> Duration {
    let base_ms = u64::try_from(base.as_millis()).unwrap_or(u64::MAX / 4);
    let span = base_ms / 100 * PERIODIC_CHECK_JITTER_PERCENT;
    let offset = sample % (2 * span + 1);
    Duration::from_millis(base_ms - span + offset)
}

fn jitter_sample() -> u64 {
    let mut bytes = [0_u8; 8];
    if getrandom::fill(&mut bytes).is_ok() {
        return u64::from_le_bytes(bytes);
    }
    // Jitter only spreads load, so the clock is an acceptable fallback source.
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| u64::from(elapsed.subsec_nanos()))
}

/// Calls `due` each time the wall clock passes the next deadline (`delay()` after the previous
/// one), until `stop` is signalled or its sender is dropped. Each wait is capped at `poll` so a
/// machine that slept past the deadline catches up after waking; a clock moved backwards
/// re-arms one delay from now instead of waiting out the jump.
fn run_periodic_checks(
    stop: &Receiver<()>,
    poll: Duration,
    mut delay: impl FnMut() -> Duration,
    mut due: impl FnMut(),
) {
    let mut interval = delay();
    let mut deadline = SystemTime::now() + interval;
    loop {
        let wait = deadline
            .duration_since(SystemTime::now())
            .unwrap_or(Duration::ZERO)
            .min(poll);
        match stop.recv_timeout(wait) {
            Err(RecvTimeoutError::Timeout) => {}
            Ok(()) | Err(RecvTimeoutError::Disconnected) => return,
        }
        let now = SystemTime::now();
        if now >= deadline {
            due();
            interval = delay();
            deadline = now + interval;
        } else if deadline.duration_since(now).unwrap_or(Duration::ZERO) > interval {
            deadline = now + interval;
        }
    }
}

fn launch_after_quiescence<T>(
    before_exit: &BeforeUpdaterExit,
    launch: impl FnOnce() -> Result<T, UpdateError>,
) -> Result<T, UpdateError> {
    if !(before_exit)() {
        return Err(UpdateError::new(
            "update_shutdown_failed",
            "KalCode couldn't safely stop active work, so the update didn't start. Close sign-in or file dialogs and finish running work, then try again.",
        ));
    }
    launch()
}

async fn run_blocking_update<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, UpdateError> + Send + 'static,
) -> Result<T, UpdateError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| {
            UpdateError::new(
                "update_worker_failed",
                "KalCode couldn't safely run the update operation.",
            )
        })?
}

/// Runs an install or restore whose command admission (`revalidate` and `require_main`) has
/// already been checked. The admission lease is released first: the quiescence preflight seals
/// admission and waits for every outstanding lease, so one held here would always time out.
/// A command admitted in the gap is either waited for by that drain or, if it outlives it,
/// fails the update closed with `update_shutdown_failed`; nothing is admitted once it begins.
async fn run_update_after_admission<T: Send + 'static>(
    // By value, never `&RuntimeAccess`: a borrowed lease stays held across the drain below.
    admission: crate::runtime_coordinator::RuntimeAccess,
    work: impl FnOnce() -> Result<T, UpdateError> + Send + 'static,
) -> Result<T, UpdateError> {
    release_then_update(admission, work).await
}

/// An owned lease the exit drain counts. Never implemented for references, so a borrowed lease
/// cannot reach `release_then_update`. Tests use the lifecycle leases a `RuntimeAccess` wraps.
trait OwnedAdmission: Send {}
impl OwnedAdmission for crate::runtime_coordinator::RuntimeAccess {}
#[cfg(test)]
impl OwnedAdmission for crate::runtime_lifecycle::Lease {}
#[cfg(test)]
impl OwnedAdmission for crate::runtime_lifecycle::MutationLease {}

async fn release_then_update<A: OwnedAdmission, T: Send + 'static>(
    admission: A,
    work: impl FnOnce() -> Result<T, UpdateError> + Send + 'static,
) -> Result<T, UpdateError> {
    drop(admission);
    run_blocking_update(work).await
}

fn parse_feed(
    raw: &Option<Vec<u8>>,
    target: UpdateTarget,
) -> Result<Option<(RemoteFeed, serde_json::Value, RemotePlatform)>, UpdateError> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let value: serde_json::Value =
        serde_json::from_slice(raw).map_err(|_| UpdateError::invalid_manifest("json"))?;
    let mut feed: RemoteFeed = serde_json::from_value(value.clone())
        .map_err(|_| UpdateError::invalid_manifest("shape"))?;
    if feed
        .notes
        .as_ref()
        .is_some_and(|notes| notes.len() > 10_000)
        || feed.pub_date.as_ref().is_some_and(|date| date.len() > 64)
    {
        return Err(UpdateError::invalid_manifest("feed limits"));
    }
    let schema_version = value["kalcode"]["schemaVersion"]
        .as_u64()
        .ok_or_else(|| UpdateError::invalid_manifest("schema version"))?;
    match schema_version {
        1 => {
            if target != UpdateTarget::WindowsX86_64
                || feed.platforms.len() != 1
                || !feed
                    .platforms
                    .contains_key(UpdateTarget::WindowsX86_64.as_str())
            {
                return Err(UpdateError::new(
                    "update_target_mismatch",
                    "The update feed returned a build for another platform.",
                ));
            }
        }
        2 => {
            if feed.platforms.is_empty() || feed.platforms.len() > 2 {
                return Err(UpdateError::invalid_manifest("platform count"));
            }
            for key in feed.platforms.keys() {
                UpdateTarget::from_str(key)?;
            }
            let artifacts = value["kalcode"]["artifacts"]
                .as_object()
                .ok_or_else(|| UpdateError::invalid_manifest("artifacts"))?;
            let mut platform_keys = feed
                .platforms
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>();
            let mut artifact_keys = artifacts.keys().map(String::as_str).collect::<Vec<_>>();
            platform_keys.sort_unstable();
            artifact_keys.sort_unstable();
            if platform_keys != artifact_keys {
                return Err(UpdateError::invalid_manifest("platform artifact set"));
            }
        }
        _ => return Err(UpdateError::invalid_manifest("schema version")),
    }
    let platform = feed.platforms.remove(target.as_str()).ok_or_else(|| {
        UpdateError::new(
            "update_target_unavailable",
            "No update is available for this platform.",
        )
    })?;
    // Keep the metadata in the original JSON so the core's deny-unknown-fields parser validates
    // the exact bytes received rather than a reconstructed subset.
    if feed.kalcode != value["kalcode"] {
        return Err(UpdateError::invalid_manifest("metadata"));
    }
    Ok(Some((feed, value, platform)))
}

fn descriptor(
    candidate: Candidate,
    platform: RemotePlatform,
    target: UpdateTarget,
) -> Result<Option<ReleaseDescriptor>, UpdateError> {
    if candidate.metadata.target != target || !candidate.metadata.format.supports(target) {
        return Err(UpdateError::new(
            "update_target_mismatch",
            "The update feed returned a build for another platform.",
        ));
    }
    let download_url =
        Url::parse(&platform.url).map_err(|_| UpdateError::invalid_manifest("download url"))?;
    let expected_suffix = match candidate.metadata.format {
        ArtifactFormat::Nsis => ".exe",
        ArtifactFormat::Dmg => ".dmg",
    };
    if !download_url.path().ends_with(expected_suffix) || platform.signature.len() > 16 * 1024 {
        return Err(UpdateError::invalid_manifest("raw update artifact"));
    }
    Ok(Some(ReleaseDescriptor {
        candidate,
        download_url,
        signature: platform.signature,
    }))
}

fn prepared_installer_name(id: String, format: ArtifactFormat) -> String {
    let extension = match format {
        ArtifactFormat::Nsis => "exe",
        ArtifactFormat::Dmg => "dmg",
    };
    format!("prepared-{id}.{extension}")
}

fn is_previous_version(current: &str, cached: &str) -> bool {
    let (Ok(current), Ok(cached)) = (Version::parse(current), Version::parse(cached)) else {
        return false;
    };
    cached.pre.is_empty() && cached < current
}

/// Recovery is offered and performed only for an older stable build at or after the rollback
/// floor: an earlier build can't open data this build's migrations have already advanced.
fn schema_compatible_recovery(current: &str, cached: &str, floor: Option<&str>) -> bool {
    let (Some(floor), Ok(cached_version)) = (floor, Version::parse(cached)) else {
        return false;
    };
    let Ok(floor) = Version::parse(floor) else {
        return false;
    };
    is_previous_version(current, cached) && cached_version >= floor
}

fn require_schema_compatible_recovery(
    current: &str,
    cached: &str,
    floor: Option<&str>,
) -> Result<(), UpdateError> {
    if schema_compatible_recovery(current, cached, floor) {
        return Ok(());
    }
    Err(UpdateError::new(
        "rollback_schema_incompatible",
        "The previous version can't open data saved by this version, so it can't be restored. Your data has not been changed.",
    ))
}

fn read_rollback_floor(update_dir: &std::path::Path) -> Option<String> {
    let file = std::fs::File::open(update_dir.join(ROLLBACK_FLOOR_FILE)).ok()?;
    let mut raw = String::new();
    file.take(MAX_ROLLBACK_FLOOR_BYTES)
        .read_to_string(&mut raw)
        .ok()?;
    let floor = raw.trim();
    Version::parse(floor).ok().map(|_| floor.to_owned())
}

fn update_state_unavailable(_error: std::io::Error) -> UpdateError {
    UpdateError::new(
        "update_state_unavailable",
        "KalCode couldn't save its update state.",
    )
}

fn write_rollback_floor(update_dir: &std::path::Path, version: &str) -> Result<(), UpdateError> {
    Version::parse(version).map_err(|_| UpdateError::invalid_manifest("current version"))?;
    std::fs::create_dir_all(update_dir).map_err(update_state_unavailable)?;
    let path = update_dir.join(ROLLBACK_FLOOR_FILE);
    let next = update_dir.join(format!("{ROLLBACK_FLOOR_FILE}.next"));
    let mut file = std::fs::File::create(&next).map_err(update_state_unavailable)?;
    file.write_all(version.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(update_state_unavailable)?;
    drop(file);
    std::fs::rename(&next, &path).map_err(update_state_unavailable)
}

/// Runs before Core can apply a forward-only migration. It raises the rollback floor to this
/// build and, on macOS, fences a swapped-in upgrade so the helper can't swap back to a build
/// that would refuse the migrated data. Both are durable before the migration runs.
pub(crate) fn guard_forward_only_schema_upgrade(
    data_dir: &std::path::Path,
    current_version: &str,
    migration_pending: bool,
) -> Result<(), UpdateError> {
    if !migration_pending {
        return Ok(());
    }
    let update_dir = data_dir.join("updates");
    write_rollback_floor(&update_dir, current_version)?;
    if cfg!(target_os = "macos") {
        fence_swapped_macos_upgrade(&update_dir, current_version)?;
    }
    Ok(())
}

/// Fences the helper's rollback in both of its modes: a restart apply waits for this build's
/// health with the attempt `Launched`; a no-relaunch apply (a same-version build installed when
/// KalCode closed) probes it with the attempt `Swapped`, and this build can be opened during
/// that probe. Either helper compares the whole attempt before it swaps back, so once this build
/// may migrate the data, neither can restore the build that would refuse it.
fn fence_swapped_macos_upgrade(
    update_dir: &std::path::Path,
    current_version: &str,
) -> Result<(), UpdateError> {
    let mut journal = UpdateJournal::load(update_dir.join("updater.json"))?;
    let swapped_upgrade = journal
        .state()
        .install_attempt
        .as_ref()
        .is_some_and(|attempt| {
            attempt.kind == InstallKind::Upgrade
                && attempt.to_version == current_version
                && attempt.mac_swap.as_ref().is_some_and(|swap| {
                    matches!(swap.phase, MacSwapPhase::Swapped | MacSwapPhase::Launched)
                })
        });
    if !swapped_upgrade {
        return Ok(());
    }
    journal.fence_forward_only_mac_install(current_version)
}

fn append_bounded(
    target: &mut Vec<u8>,
    chunk: &[u8],
    maximum: u64,
    code: &'static str,
    message: &'static str,
) -> Result<(), UpdateError> {
    let next = target
        .len()
        .checked_add(chunk.len())
        .ok_or_else(|| UpdateError::new(code, message))?;
    if next as u64 > maximum {
        return Err(UpdateError::new(code, message));
    }
    target.extend_from_slice(chunk);
    Ok(())
}

fn network_error() -> UpdateError {
    UpdateError::new(
        "update_network_failed",
        "KalCode couldn't download the update. Check your connection and try again.",
    )
}

fn preparation_cancelled() -> UpdateError {
    UpdateError::new(
        "update_cancelled",
        "KalCode is closing. The update preparation was cancelled.",
    )
}

fn into_ipc(error: UpdateError, command: &'static str) -> IpcError {
    KalError::new(ErrorCategory::Update, error.code(), error.to_string()).log_and_convert(command)
}

fn require_main(window: &WebviewWindow, command: &'static str) -> Result<(), IpcError> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err(KalError::new(
            ErrorCategory::Permission,
            "updater_window_not_allowed",
            "Updates can only be managed from the main KalCode window.",
        )
        .log_and_convert(command))
    }
}

#[tauri::command]
pub fn updater_status(
    window: WebviewWindow,
    state: State<'_, DesktopUpdaterState>,
) -> Result<UpdateStatus, IpcError> {
    require_main(&window, "updater_status")?;
    Ok(state.status())
}

#[tauri::command(async)]
pub fn updater_set_channel(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    window: WebviewWindow,
    channel: String,
    state: State<'_, DesktopUpdaterState>,
) -> Result<UpdateStatus, IpcError> {
    _runtime_access.revalidate()?;
    require_main(&window, "updater_set_channel")?;
    let channel = UpdateChannel::from_str(&channel)
        .map_err(|error| into_ipc(error, "updater_set_channel"))?;
    state
        .set_channel(channel)
        .map_err(|error| into_ipc(error, "updater_set_channel"))
}

#[tauri::command(async)]
pub async fn updater_check(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    window: WebviewWindow,
    state: State<'_, DesktopUpdaterState>,
) -> Result<UpdateStatus, IpcError> {
    _runtime_access.revalidate()?;
    require_main(&window, "updater_check")?;
    state
        .check()
        .await
        .map_err(|error| into_ipc(error, "updater_check"))
}

#[tauri::command]
pub fn updater_cancel(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    window: WebviewWindow,
    state: State<'_, DesktopUpdaterState>,
) -> Result<UpdateStatus, IpcError> {
    _runtime_access.revalidate()?;
    require_main(&window, "updater_cancel")?;
    state
        .cancel()
        .map_err(|error| into_ipc(error, "updater_cancel"))
}

#[tauri::command(async)]
pub async fn updater_install(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    window: WebviewWindow,
    state: State<'_, DesktopUpdaterState>,
) -> Result<(), IpcError> {
    _runtime_access.revalidate()?;
    require_main(&window, "updater_install")?;
    let updater = state.inner().clone();
    run_update_after_admission(_runtime_access, move || updater.install())
        .await
        .map_err(|error| into_ipc(error, "updater_install"))
}

#[tauri::command(async)]
pub async fn updater_restore_previous(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    window: WebviewWindow,
    state: State<'_, DesktopUpdaterState>,
) -> Result<(), IpcError> {
    _runtime_access.revalidate()?;
    require_main(&window, "updater_restore_previous")?;
    let updater = state.inner().clone();
    run_update_after_admission(_runtime_access, move || updater.restore_previous())
        .await
        .map_err(|error| into_ipc(error, "updater_restore_previous"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_stable_builds_can_launch_update_installers() {
        assert_eq!(
            super::require_stable_installer().is_ok(),
            !cfg!(debug_assertions)
        );
    }
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Instant;

    use super::*;
    use crate::runtime_lifecycle::Phase;

    #[test]
    fn startup_cleanup_failure_never_skips_reconciling_the_previous_install() {
        let attempt = || InstallAttempt {
            kind: InstallKind::Upgrade,
            from_version: "0.1.5".into(),
            to_version: "0.1.6".into(),
            sha256: "a".repeat(64),
            binding: Some(InstallBinding {
                target: UpdateTarget::WindowsX86_64,
                source_sha256: "c".repeat(64),
                signing_requirement_sha256: "d".repeat(64),
            }),
            mac_swap: None,
            started_at: "2026-09-30T12:00:00Z".into(),
        };
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("updater.json");
        // A failed sweep (for example an unusable prepared directory) and a live earlier
        // preparation both still record the previous install's result.
        for (cleanup, expected_ready) in [
            (
                Err(UpdateError::new("update_installer_storage_failed", "x")),
                true,
            ),
            (Ok(false), false),
            (Ok(true), true),
        ] {
            let mut journal = UpdateJournal::load(&path).unwrap();
            journal.record_install_attempt(attempt()).unwrap();

            let (ready, outcome) =
                reconcile_after_cleanup(&mut journal, cleanup, true, true, "0.1.6");

            assert_eq!(ready, expected_ready);
            assert!(matches!(outcome, Ok(Some(InstallOutcome::Updated))));
            let reloaded = UpdateJournal::load(&path).unwrap();
            assert!(reloaded.state().install_attempt.is_none());
        }
    }

    #[test]
    fn repeated_failed_shutdown_preflight_never_launches_an_installer() {
        let preflight_calls = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&preflight_calls);
        let preflight: BeforeUpdaterExit = Arc::new(move || {
            observed.fetch_add(1, Ordering::SeqCst);
            false
        });
        let installer_calls = AtomicUsize::new(0);

        for _ in 0..2 {
            let error = launch_after_quiescence(&preflight, || {
                installer_calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .expect_err("a failed quiescence proof must block the installer");
            assert_eq!(error.code(), "update_shutdown_failed");
            // The UI shows this message as-is; it must say what to do next.
            assert!(error.to_string().ends_with(
                "Close sign-in or file dialogs and finish running work, then try again."
            ));
        }

        assert_eq!(preflight_calls.load(Ordering::SeqCst), 2);
        assert_eq!(installer_calls.load(Ordering::SeqCst), 0);
    }

    /// A coordinator whose runtime is `Ready`, so commands can be admitted as in production.
    fn ready_coordinator() -> Arc<crate::runtime_coordinator::RuntimeCoordinator> {
        let coordinator = crate::runtime_coordinator::tests::test_coordinator();
        let epoch = coordinator.lifecycle.begin_start(7).expect("start epoch");
        assert!(coordinator.lifecycle.publish(epoch));
        coordinator
    }

    /// The production preflight (`shutdown_runtime_once`) over the real coordinator, bounded
    /// short so a lease that is never released fails fast instead of after 30 s.
    fn exit_preflight(
        coordinator: &Arc<crate::runtime_coordinator::RuntimeCoordinator>,
        timeout: Duration,
    ) -> BeforeUpdaterExit {
        let coordinator = Arc::clone(coordinator);
        Arc::new(move || coordinator.drain_for_exit(timeout))
    }

    /// Runs the update body that `run_update_after_admission` delegates to while `admission`
    /// is the only outstanding lease, and asserts that the production preflight drains.
    fn assert_admission_released_before_preflight<A: OwnedAdmission>(
        coordinator: &Arc<crate::runtime_coordinator::RuntimeCoordinator>,
        admission: A,
        kind: &str,
    ) {
        assert_eq!(coordinator.lifecycle.pending(), (false, 1));
        let preflight = exit_preflight(coordinator, Duration::from_secs(2));
        let launched = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&launched);
        let started = Instant::now();

        let result = tauri::async_runtime::block_on(release_then_update(admission, move || {
            launch_after_quiescence(&preflight, || {
                observed.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
        }));

        assert!(
            result.is_ok(),
            "{kind} admission blocked the preflight: {:?}",
            result.err().map(|error| error.code())
        );
        assert_eq!(launched.load(Ordering::SeqCst), 1);
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(coordinator.lifecycle.pending(), (false, 0));
        assert_eq!(coordinator.lifecycle.phase(), Phase::AppExiting);
    }

    #[test]
    fn install_and_restore_release_their_admission_before_the_shutdown_preflight() {
        // `RuntimeAccess` holds an epoch lease; account admission holds a mutation lease. The
        // exit drain counts both, so either one held across the preflight could never drain.
        let coordinator = ready_coordinator();
        let epoch = coordinator.lifecycle.acquire(7).expect("command lease");
        assert_admission_released_before_preflight(&coordinator, epoch, "epoch");

        let coordinator = ready_coordinator();
        let mutation = coordinator
            .lifecycle
            .acquire_mutation()
            .expect("mutation lease");
        assert_admission_released_before_preflight(&coordinator, mutation, "mutation");
    }

    #[test]
    fn a_command_admitted_after_the_release_is_waited_for_or_fails_the_update_closed() {
        // (other command's run time, preflight bound, launches?)
        for (busy, bound, launches) in [
            (Duration::from_millis(50), Duration::from_secs(2), true),
            (
                Duration::from_millis(400),
                Duration::from_millis(100),
                false,
            ),
        ] {
            let coordinator = ready_coordinator();
            let admission = coordinator.lifecycle.acquire(7).expect("command lease");
            let preflight = exit_preflight(&coordinator, bound);
            let concurrent = Arc::clone(&coordinator);
            let launched = Arc::new(AtomicUsize::new(0));
            let observed = Arc::clone(&launched);

            let result =
                tauri::async_runtime::block_on(release_then_update(admission, move || {
                    // Another command is admitted in the gap after the updater's release.
                    let other = concurrent.lifecycle.acquire(7).expect("concurrent lease");
                    let running = std::thread::spawn(move || {
                        std::thread::sleep(busy);
                        drop(other);
                    });
                    let outcome = launch_after_quiescence(&preflight, || {
                        observed.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    });
                    // Once draining, admission is closed to every new command.
                    assert!(concurrent.lifecycle.acquire(7).is_none());
                    assert!(concurrent.lifecycle.acquire_mutation().is_none());
                    running.join().unwrap();
                    outcome
                }));

            if launches {
                assert!(result.is_ok());
            } else {
                assert_eq!(
                    result.err().map(|error| error.code()),
                    Some("update_shutdown_failed")
                );
            }
            assert_eq!(launched.load(Ordering::SeqCst), usize::from(launches));
            assert_eq!(coordinator.lifecycle.pending(), (false, 0));
        }
    }

    #[test]
    fn feed_parser_accepts_only_one_raw_windows_installer() {
        let valid = serde_json::json!({
            "version": "1.2.3",
            "notes": "Update",
            "pub_date": "2026-09-25T12:00:00Z",
            "platforms": {
                "windows-x86_64": {
                    "url": "https://kalcoded.com/releases/updater/stable/1.2.3/KalCode.exe",
                    "signature": "signed"
                }
            },
            "kalcode": {
                "schemaVersion": 1,
                "channel": "stable",
                "size": 2,
                "sha256": "a".repeat(64),
                "commit": "b".repeat(40)
            }
        });
        let parsed = parse_feed(
            &Some(serde_json::to_vec(&valid).unwrap()),
            UpdateTarget::WindowsX86_64,
        )
        .unwrap()
        .unwrap();
        assert_eq!(parsed.0.version, "1.2.3");

        let candidate = Candidate {
            version: "1.2.3".into(),
            notes: None,
            metadata: kalcode_updater::FeedMetadata {
                schema_version: 1,
                channel: UpdateChannel::Stable,
                target: UpdateTarget::WindowsX86_64,
                format: ArtifactFormat::Nsis,
                size: 2,
                sha256: "a".repeat(64),
                commit: "b".repeat(40),
            },
        };
        assert!(
            descriptor(candidate.clone(), parsed.2, UpdateTarget::WindowsX86_64)
                .unwrap()
                .is_some()
        );
        assert_eq!(
            descriptor(
                candidate,
                RemotePlatform {
                    url: "https://kalcoded.com/releases/updater/stable/1.2.3/KalCode.nsis.zip"
                        .into(),
                    signature: "signed".into(),
                },
                UpdateTarget::WindowsX86_64,
            )
            .unwrap_err()
            .code(),
            "update_manifest_invalid"
        );
    }

    #[test]
    fn feed_parser_selects_only_the_exact_macos_arm64_artifact() {
        let valid = serde_json::json!({
            "version": "1.2.3",
            "notes": "Update",
            "pub_date": "2026-09-25T12:00:00Z",
            "platforms": {
                "windows-x86_64": {
                    "url": "https://kalcoded.com/releases/updater/stable/1.2.3/windows.exe",
                    "signature": "windows-signed"
                },
                "darwin-aarch64": {
                    "url": "https://kalcoded.com/releases/updater/stable/1.2.3/macos.dmg",
                    "signature": "mac-signed"
                }
            },
            "kalcode": {
                "schemaVersion": 2,
                "channel": "stable",
                "commit": "b".repeat(40),
                "artifacts": {
                    "windows-x86_64": {
                        "target": "windows-x86_64",
                        "format": "nsis",
                        "size": 2,
                        "sha256": "a".repeat(64)
                    },
                    "darwin-aarch64": {
                        "target": "darwin-aarch64",
                        "format": "dmg",
                        "size": 3,
                        "sha256": "c".repeat(64)
                    }
                }
            }
        });
        let raw = Some(serde_json::to_vec(&valid).unwrap());
        let parsed = parse_feed(&raw, UpdateTarget::DarwinAarch64)
            .unwrap()
            .unwrap();
        assert!(parsed.2.url.ends_with("macos.dmg"));
        assert_eq!(parsed.2.signature, "mac-signed");

        let mut missing_mac = valid;
        missing_mac["platforms"]
            .as_object_mut()
            .unwrap()
            .remove("darwin-aarch64");
        missing_mac["kalcode"]["artifacts"]
            .as_object_mut()
            .unwrap()
            .remove("darwin-aarch64");
        assert_eq!(
            parse_feed(
                &Some(serde_json::to_vec(&missing_mac).unwrap()),
                UpdateTarget::DarwinAarch64,
            )
            .unwrap_err()
            .code(),
            "update_target_unavailable"
        );
    }

    #[test]
    fn chunked_feed_limit_fails_before_extending_the_buffer() {
        let mut bytes = vec![0_u8; 4];
        let error = append_bounded(
            &mut bytes,
            &[1, 2],
            5,
            "update_feed_too_large",
            "The update feed exceeded its safety limit.",
        )
        .unwrap_err();
        assert_eq!(error.code(), "update_feed_too_large");
        assert_eq!(bytes.len(), 4);
    }

    #[test]
    fn recovery_is_exposed_only_for_an_older_stable_build() {
        assert!(!is_previous_version("1.2.3", "1.2.3"));
        assert!(is_previous_version("1.2.3", "1.2.2"));
        assert!(!is_previous_version("1.2.3", "1.2.4"));
        assert!(!is_previous_version("1.2.3", "1.2.2-beta.1"));
        assert!(!is_previous_version("invalid", "1.2.2"));
        assert!(is_previous_version("0.1.7+780", "0.1.7"));
        assert!(is_previous_version("0.1.7+780", "0.1.7+779"));
        assert!(!is_previous_version("0.1.7+780", "0.1.7+780"));
        assert!(!is_previous_version("0.1.7+999", "0.1.7+1000"));
    }

    #[test]
    fn rollback_floor_gates_recovery_visibility_and_execution() {
        let floor = Some("0.1.8+820");
        // A build from before the floor can't open data the floor build migrated.
        assert!(!schema_compatible_recovery("0.1.8+830", "0.1.7+800", floor));
        assert!(!schema_compatible_recovery("0.1.8+830", "0.1.7", floor));
        assert!(schema_compatible_recovery("0.1.8+830", "0.1.8+820", floor));
        assert!(schema_compatible_recovery("0.1.8+830", "0.1.8+825", floor));
        // Build revisions compare numerically, not lexically.
        assert!(!schema_compatible_recovery(
            "0.1.7+1001",
            "0.1.7+999",
            Some("0.1.7+1000")
        ));
        // Still only an older stable build.
        assert!(!schema_compatible_recovery("0.1.8+830", "0.1.8+830", floor));
        assert!(!schema_compatible_recovery("0.1.8+830", "0.1.8+840", floor));
        // An unknown floor fails closed.
        assert!(!schema_compatible_recovery("0.1.8+830", "0.1.8+825", None));
        assert!(!schema_compatible_recovery(
            "0.1.8+830",
            "0.1.8+825",
            Some("garbage")
        ));

        assert!(require_schema_compatible_recovery("0.1.8+830", "0.1.8+825", floor).is_ok());
        assert_eq!(
            require_schema_compatible_recovery("0.1.8+830", "0.1.7+800", floor)
                .unwrap_err()
                .code(),
            "rollback_schema_incompatible"
        );
    }

    #[test]
    fn a_pending_migration_raises_the_rollback_floor_before_it_runs() {
        let data_dir = tempfile::tempdir().unwrap();
        let update_dir = data_dir.path().join("updates");
        assert_eq!(read_rollback_floor(&update_dir), None);

        guard_forward_only_schema_upgrade(data_dir.path(), "0.1.7+800", false).unwrap();
        assert_eq!(read_rollback_floor(&update_dir), None);

        guard_forward_only_schema_upgrade(data_dir.path(), "0.1.8+820", true).unwrap();
        assert_eq!(
            read_rollback_floor(&update_dir).as_deref(),
            Some("0.1.8+820")
        );

        // A later build without a migration keeps the floor; a later migration raises it.
        guard_forward_only_schema_upgrade(data_dir.path(), "0.1.8+830", false).unwrap();
        assert_eq!(
            read_rollback_floor(&update_dir).as_deref(),
            Some("0.1.8+820")
        );
        guard_forward_only_schema_upgrade(data_dir.path(), "0.1.8+900", true).unwrap();
        assert_eq!(
            read_rollback_floor(&update_dir).as_deref(),
            Some("0.1.8+900")
        );

        std::fs::write(update_dir.join(ROLLBACK_FLOOR_FILE), "not a version").unwrap();
        assert_eq!(read_rollback_floor(&update_dir), None);
    }

    #[test]
    fn startup_failure_never_acknowledges_a_pending_install() {
        let temp = tempfile::tempdir().unwrap();
        let mut journal = UpdateJournal::load(temp.path().join("updater.json")).unwrap();
        journal
            .record_install_attempt(InstallAttempt {
                kind: InstallKind::Upgrade,
                from_version: "0.1.7".into(),
                to_version: "0.1.8+820".into(),
                sha256: "a".repeat(64),
                binding: Some(InstallBinding {
                    target: UpdateTarget::WindowsX86_64,
                    source_sha256: "c".repeat(64),
                    signing_requirement_sha256: "d".repeat(64),
                }),
                mac_swap: None,
                started_at: "2026-10-01T12:00:00Z".into(),
            })
            .unwrap();

        let (ready, outcome) =
            reconcile_after_cleanup(&mut journal, Ok(true), true, false, "0.1.8+820");

        assert!(ready);
        assert_eq!(outcome.unwrap(), None);
        assert!(journal.state().install_attempt.is_some());
        assert!(journal.state().last_successful_version.is_none());
    }

    #[test]
    fn launched_macos_upgrade_is_fenced_before_migration_and_healthy_ack_clears_it() {
        let data_dir = tempfile::tempdir().unwrap();
        let update_dir = data_dir.path().join("updates");
        std::fs::create_dir_all(&update_dir).unwrap();
        let journal_path = update_dir.join("updater.json");

        // No pending install: nothing to fence.
        fence_swapped_macos_upgrade(&update_dir, "0.1.8+820").unwrap();

        let mut journal = UpdateJournal::load(&journal_path).unwrap();
        journal
            .record_install_attempt(InstallAttempt {
                kind: InstallKind::Upgrade,
                from_version: "0.1.7".into(),
                to_version: "0.1.8+820".into(),
                sha256: "a".repeat(64),
                binding: Some(InstallBinding {
                    target: UpdateTarget::DarwinAarch64,
                    source_sha256: "c".repeat(64),
                    signing_requirement_sha256: "d".repeat(64),
                }),
                mac_swap: Some(MacSwapAttempt {
                    current_app: data_dir.path().join("KalCode.app"),
                    staged_app: data_dir.path().join(".KalCode-update-previous.app"),
                    parent_pid: 42,
                    parent_identity_sha256: "e".repeat(64),
                    phase: kalcode_updater::MacSwapPhase::Prepared,
                }),
                started_at: "2026-10-01T12:00:00Z".into(),
            })
            .unwrap();
        journal
            .mark_mac_swap_phase(
                kalcode_updater::MacSwapPhase::Prepared,
                kalcode_updater::MacSwapPhase::Swapped,
            )
            .unwrap();
        journal
            .mark_mac_swap_phase(
                kalcode_updater::MacSwapPhase::Swapped,
                kalcode_updater::MacSwapPhase::Launched,
            )
            .unwrap();
        // What the helper captured and compares again before it swaps back.
        let captured = journal.state().install_attempt.clone().unwrap();
        drop(journal);

        fence_swapped_macos_upgrade(&update_dir, "0.1.8+820").unwrap();
        let fenced = UpdateJournal::load(&journal_path)
            .unwrap()
            .state()
            .install_attempt
            .clone()
            .unwrap();
        assert_ne!(fenced, captured);

        fence_swapped_macos_upgrade(&update_dir, "0.1.8+820").unwrap();
        let mut reopened = UpdateJournal::load(&journal_path).unwrap();
        assert_eq!(reopened.state().install_attempt.as_ref(), Some(&fenced));

        let (_, outcome) =
            reconcile_after_cleanup(&mut reopened, Ok(true), true, true, "0.1.8+820");
        assert_eq!(outcome.unwrap(), Some(InstallOutcome::Updated));
        assert!(reopened.state().install_attempt.is_none());
        assert_eq!(
            reopened.state().last_successful_version.as_deref(),
            Some("0.1.8+820")
        );
    }

    /// A same-version build applied after KalCode closed (macOS `--no-relaunch`) leaves the
    /// attempt `Swapped` while the helper probes it. If that build is opened during the probe and
    /// must migrate the database, it raises the rollback floor and fences the attempt before Core
    /// opens, so the helper's rollback fails closed; its healthy startup then acknowledges the
    /// install and removes the previous bundle the helper left behind.
    #[test]
    fn a_no_relaunch_apply_is_fenced_and_floored_before_its_migration() {
        let data_dir = tempfile::tempdir().unwrap();
        let update_dir = data_dir.path().join("updates");
        let journal_path = update_dir.join("updater.json");
        let mut journal = UpdateJournal::load(&journal_path).unwrap();
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
                    current_app: data_dir.path().join("KalCode.app"),
                    staged_app: data_dir.path().join(".KalCode-update-previous.app"),
                    parent_pid: 42,
                    parent_identity_sha256: "e".repeat(64),
                    phase: MacSwapPhase::Prepared,
                }),
                started_at: "2026-10-01T12:00:00Z".into(),
            })
            .unwrap();
        journal
            .mark_mac_swap_phase(MacSwapPhase::Prepared, MacSwapPhase::Swapped)
            .unwrap();
        let captured = journal.state().install_attempt.clone().unwrap();
        drop(journal);

        // `guard_forward_only_schema_upgrade` fences only on macOS; run both of its steps here.
        guard_forward_only_schema_upgrade(data_dir.path(), "0.1.8+6", true).unwrap();
        fence_swapped_macos_upgrade(&update_dir, "0.1.8+6").unwrap();
        assert_eq!(read_rollback_floor(&update_dir).as_deref(), Some("0.1.8+6"));
        let mut reopened = UpdateJournal::load(&journal_path).unwrap();
        let fenced = reopened.state().install_attempt.clone().unwrap();
        assert_ne!(
            fenced, captured,
            "the helper's rollback must no longer match"
        );
        assert_eq!(
            fenced.mac_swap.as_ref().unwrap().phase,
            MacSwapPhase::Swapped
        );

        let superseded = superseded_mac_bundle(reopened.state(), "0.1.8+6");
        let (_, outcome) = reconcile_after_cleanup(&mut reopened, Ok(true), true, true, "0.1.8+6");
        assert_eq!(outcome.unwrap(), Some(InstallOutcome::Updated));
        assert_eq!(superseded, fenced.mac_swap);
        // The previous build can never be offered back over the migrated data.
        assert!(!schema_compatible_recovery(
            "0.1.8+6",
            "0.1.8+5",
            read_rollback_floor(&update_dir).as_deref()
        ));
    }

    /// The update journal and the silent-install record agree on success: only a healthy startup
    /// of the new build. An unhealthy one acknowledges nothing and settles nothing; a healthy
    /// launch that is still the old build settles nothing either, and that build gets the
    /// restart prompt.
    #[test]
    fn the_journal_and_the_silent_record_share_one_definition_of_success() {
        let silent = silent_fallback::after_exit_attempt(None, "0.1.8+6");
        let journal_with_attempt = |dir: &std::path::Path| {
            let mut journal = UpdateJournal::load(dir.join("updater.json")).unwrap();
            journal
                .record_install_attempt(InstallAttempt {
                    kind: InstallKind::Upgrade,
                    from_version: "0.1.8+5".into(),
                    to_version: "0.1.8+6".into(),
                    sha256: "a".repeat(64),
                    binding: Some(windows_binding()),
                    mac_swap: None,
                    started_at: "2026-10-01T12:00:00Z".into(),
                })
                .unwrap();
            journal
        };

        for (running, healthy, acknowledged, settled) in [
            ("0.1.8+6", false, None, false),
            ("0.1.8+6", true, Some(InstallOutcome::Updated), true),
            ("0.1.8+5", false, None, false),
            (
                "0.1.8+5",
                true,
                Some(InstallOutcome::PreviousVersionPreserved),
                false,
            ),
        ] {
            let temp = tempfile::tempdir().unwrap();
            let mut journal = journal_with_attempt(temp.path());
            let (_, outcome) =
                reconcile_after_cleanup(&mut journal, Ok(true), true, healthy, running);
            let record =
                silent_fallback::reconcile_at_launch(Some(silent.clone()), running, healthy);
            let case = format!("{running} healthy={healthy}");
            assert_eq!(outcome.unwrap(), acknowledged, "{case}");
            assert_eq!(record.is_none(), settled, "{case}");
            assert_eq!(
                journal.state().install_attempt.is_none(),
                acknowledged.is_some(),
                "{case}"
            );
            if running == "0.1.8+5" {
                assert!(
                    silent_fallback::prompt_instead(record.as_ref(), "0.1.8+6"),
                    "{case}"
                );
            }
        }
    }

    #[test]
    fn a_build_recovery_endpoint_keeps_its_build_separator() {
        let endpoint =
            Url::parse("https://kalcoded.com/releases/updater/stable/0.1.7+780.json").unwrap();
        assert_eq!(endpoint.path(), "/releases/updater/stable/0.1.7+780.json");
        assert_eq!(
            endpoint.as_str(),
            "https://kalcoded.com/releases/updater/stable/0.1.7+780.json"
        );
    }

    #[test]
    fn cancelling_a_check_aborts_its_in_flight_transport_future() {
        let mut runtime = Runtime {
            machine: UpdateMachine::new(UpdateChannel::Stable, "1.2.3"),
            prepared: None,
            active_check: None,
        };
        let (_token, _channel, registration) = runtime.begin_cancellable_check().unwrap();

        runtime.cancel().unwrap();

        let result = tauri::async_runtime::block_on(futures_util::future::Abortable::new(
            std::future::pending::<()>(),
            registration,
        ));
        assert!(result.is_err());
        assert_eq!(
            runtime.machine.status().phase,
            kalcode_updater::UpdatePhase::Idle
        );
    }

    #[test]
    fn a_cancelled_check_cannot_drop_a_replacement_checks_abort_handle() {
        let mut runtime = Runtime {
            machine: UpdateMachine::new(UpdateChannel::Stable, "1.2.3"),
            prepared: None,
            active_check: None,
        };
        let (cancelled, _, _) = runtime.begin_cancellable_check().unwrap();
        runtime.cancel().unwrap();
        let (_replacement, _, replacement_registration) =
            runtime.begin_cancellable_check().unwrap();

        runtime.finish_check(cancelled);
        runtime.cancel().unwrap();

        let result = tauri::async_runtime::block_on(Abortable::new(
            std::future::pending::<()>(),
            replacement_registration,
        ));
        assert!(result.is_err());
    }

    fn candidate(version: &str) -> Candidate {
        Candidate {
            version: version.into(),
            notes: None,
            metadata: kalcode_updater::FeedMetadata {
                schema_version: 1,
                channel: UpdateChannel::Stable,
                target: UpdateTarget::WindowsX86_64,
                format: ArtifactFormat::Nsis,
                size: 2,
                sha256: "a".repeat(64),
                commit: "b".repeat(40),
            },
        }
    }

    /// A runtime holding a verified, staged update (phase Ready, prepared bytes present).
    fn staged_runtime() -> Runtime {
        let mut runtime = Runtime {
            machine: UpdateMachine::new(UpdateChannel::Stable, "1.2.3"),
            prepared: None,
            active_check: None,
        };
        let (token, _, _) = runtime.begin_cancellable_check().unwrap();
        runtime.finish_check(token);
        runtime
            .machine
            .begin_download(token, candidate("1.2.4"))
            .unwrap();
        runtime.machine.ready(token, candidate("1.2.4")).unwrap();
        runtime.prepared = Some(PreparedUpdate {
            candidate: candidate("1.2.4"),
            bytes: vec![1, 2],
            signature: "signed".into(),
            installer: None,
        });
        runtime
    }

    fn windows_binding() -> InstallBinding {
        InstallBinding {
            target: UpdateTarget::WindowsX86_64,
            source_sha256: "c".repeat(64),
            signing_requirement_sha256: "d".repeat(64),
        }
    }

    #[test]
    fn only_a_staged_build_installs_on_exit_and_a_refusal_changes_nothing() {
        // Ready but not staged (a new public version, or a build still staging): refused, and
        // the update stays exactly as it was for the user's own restart-and-install.
        let runtime = Mutex::new(staged_runtime());
        let before = lock_runtime(&runtime).status();
        assert!(!before.install_on_quit);
        let refused = run_owned_operation(&runtime, Runtime::admit_exit_install, never_runs);
        assert_eq!(refused.unwrap_err().code(), "update_not_ready");
        assert_eq!(lock_runtime(&runtime).status(), before);
        assert!(lock_runtime(&runtime).prepared.is_some());

        // Staged: reported to the UI, then admitted once, as the owner of the updater.
        let mut staged = staged_runtime();
        if let Some(prepared) = staged.prepared.as_mut() {
            prepared.installer = Some(PreparedInstaller::test_stub(windows_binding()));
        }
        assert!(staged.status().install_on_quit);
        let runtime = Mutex::new(staged);
        let (token, admitted) = lock_runtime(&runtime).admit_exit_install().unwrap();
        assert!(admitted.unwrap().installer.is_some());
        {
            let runtime = lock_runtime(&runtime);
            assert_eq!(runtime.status().phase, UpdatePhase::Installing);
            assert!(!runtime.status().install_on_quit);
            runtime.machine.check_token(token).unwrap();
        }
        let refused = run_owned_operation(&runtime, Runtime::admit_exit_install, never_runs);
        assert_eq!(refused.unwrap_err().code(), "update_not_ready");
        lock_runtime(&runtime).machine.check_token(token).unwrap();
    }

    #[test]
    fn only_a_real_staging_failure_moves_a_build_to_the_prompt() {
        assert!(!counts_as_staging_failure(&preparation_cancelled()));
        assert!(!counts_as_staging_failure(&UpdateError::new(
            "stale_update_operation",
            "x"
        )));
        assert!(counts_as_staging_failure(&UpdateError::new(
            "update_installer_storage_failed",
            "x"
        )));
    }

    #[test]
    fn a_staged_build_is_discarded_with_its_update() {
        let mut runtime = staged_runtime();
        if let Some(prepared) = runtime.prepared.as_mut() {
            prepared.installer = Some(PreparedInstaller::test_stub(windows_binding()));
        }
        runtime.cancel().unwrap();
        assert!(runtime.prepared.is_none());
        assert!(!runtime.status().install_on_quit);
    }

    #[test]
    fn only_a_swap_left_without_its_health_relaunch_has_a_bundle_to_remove() {
        let swap = |phase| MacSwapAttempt {
            current_app: std::env::temp_dir().join("KalCode.app"),
            staged_app: std::env::temp_dir().join(".KalCode-update-test.app"),
            parent_pid: 42,
            parent_identity_sha256: "e".repeat(64),
            phase,
        };
        let state = |phase| {
            let mut state = JournalState::default();
            state.install_attempt = Some(InstallAttempt {
                kind: InstallKind::Upgrade,
                from_version: "0.1.8+5".into(),
                to_version: "0.1.8+6".into(),
                sha256: "a".repeat(64),
                binding: None,
                mac_swap: Some(swap(phase)),
                started_at: "1".into(),
            });
            state
        };
        for phase in [MacSwapPhase::Prepared, MacSwapPhase::Swapped] {
            assert_eq!(
                superseded_mac_bundle(&state(phase), "0.1.8+6"),
                Some(swap(phase))
            );
            // The build being replaced keeps the bundle it may still need.
            assert_eq!(superseded_mac_bundle(&state(phase), "0.1.8+5"), None);
        }
        // A relaunched swap's helper removes the bundle after the health check itself.
        assert_eq!(
            superseded_mac_bundle(&state(MacSwapPhase::Launched), "0.1.8+6"),
            None
        );
        assert_eq!(
            superseded_mac_bundle(&JournalState::default(), "0.1.8+6"),
            None
        );
    }

    /// `staged_runtime` with a verified previous version available, behind the updater's mutex.
    fn staged_runtime_with_recovery() -> Mutex<Runtime> {
        let mut runtime = staged_runtime();
        runtime.machine.set_recovery_available(true);
        Mutex::new(runtime)
    }

    fn never_runs<A>(_: OperationToken, _: A) -> Result<(), UpdateError> {
        panic!("a refused install or restore must not run its operation")
    }

    #[test]
    fn a_refused_install_or_restore_never_fails_the_operation_that_owns_the_updater() {
        // Install A is admitted and still preparing its installer.
        let runtime = staged_runtime_with_recovery();
        let (install, prepared) = lock_runtime(&runtime).admit_install().unwrap();
        assert_eq!(prepared.unwrap().candidate, candidate("1.2.4"));
        let owned = lock_runtime(&runtime).machine.status().clone();
        assert_eq!(owned.phase, UpdatePhase::Installing);

        // B: a second install and a restore are refused through the production wrapper.
        let refused = run_owned_operation(&runtime, Runtime::admit_install, never_runs);
        assert_eq!(refused.unwrap_err().code(), "update_not_ready");
        let refused = run_owned_operation(&runtime, Runtime::admit_recovery, never_runs);
        assert_eq!(refused.unwrap_err().code(), "rollback_unavailable");
        // C: the follow-up restore is still refused, because A still owns the updater.
        let refused = run_owned_operation(&runtime, Runtime::admit_recovery, never_runs);
        assert_eq!(refused.unwrap_err().code(), "rollback_unavailable");
        {
            let runtime = lock_runtime(&runtime);
            assert_eq!(runtime.machine.status(), &owned);
            runtime.machine.check_token(install).unwrap();
        }

        // Restore A: a refused install cannot invalidate its token (it would cancel a valid
        // restore at its pre-record `check_token`).
        let runtime = staged_runtime_with_recovery();
        let restored = run_owned_operation(&runtime, Runtime::admit_recovery, |token, ()| {
            let refused = run_owned_operation(&runtime, Runtime::admit_install, never_runs);
            assert_eq!(refused.unwrap_err().code(), "update_not_ready");
            lock_runtime(&runtime).machine.check_token(token)
        });
        assert_eq!(restored, Ok(()));

        // The admitted owner's own failure is recorded, and only then may a restore start.
        let runtime = staged_runtime_with_recovery();
        let failed =
            run_owned_operation(&runtime, Runtime::admit_install, |_, _| -> Result<(), _> {
                Err(UpdateError::new(
                    "update_launch_failed",
                    "The installer didn't start.",
                ))
            });
        assert_eq!(failed.unwrap_err().code(), "update_launch_failed");
        {
            let runtime = lock_runtime(&runtime);
            assert_eq!(runtime.machine.status().phase, UpdatePhase::Failed);
            assert_eq!(
                runtime.machine.status().last_error.as_deref(),
                Some("The installer didn't start.")
            );
        }
        assert!(lock_runtime(&runtime).admit_recovery().is_ok());
    }

    #[test]
    fn periodic_recheck_runs_only_from_a_settled_phase() {
        for (phase, allowed) in [
            (UpdatePhase::Idle, true),
            (UpdatePhase::UpToDate, true),
            (UpdatePhase::Failed, true),
            (UpdatePhase::Checking, false),
            (UpdatePhase::Downloading, false),
            (UpdatePhase::Ready, false),
            (UpdatePhase::Installing, false),
        ] {
            assert_eq!(periodic_recheck_allowed(phase), allowed, "{phase:?}");
        }
    }

    #[test]
    fn periodic_recheck_never_replaces_a_staged_update() {
        let mut runtime = staged_runtime();
        assert_eq!(runtime.machine.status().phase, UpdatePhase::Ready);

        assert!(
            runtime
                .begin_check_if(periodic_recheck_allowed)
                .unwrap()
                .is_none()
        );

        assert_eq!(runtime.machine.status().phase, UpdatePhase::Ready);
        assert_eq!(
            runtime.machine.status().available_version.as_deref(),
            Some("1.2.4")
        );
        assert!(runtime.active_check.is_none());
        let prepared = runtime.prepared.as_ref().expect("staged bytes kept");
        assert_eq!(prepared.candidate, candidate("1.2.4"));
        assert_eq!(
            runtime.machine.begin_install().unwrap().0,
            candidate("1.2.4")
        );
    }

    #[test]
    fn periodic_recheck_never_interrupts_a_running_check_or_download() {
        let mut runtime = Runtime {
            machine: UpdateMachine::new(UpdateChannel::Stable, "1.2.3"),
            prepared: None,
            active_check: None,
        };
        let (token, _, _) = runtime.begin_cancellable_check().unwrap();
        assert!(
            runtime
                .begin_check_if(periodic_recheck_allowed)
                .unwrap()
                .is_none()
        );
        runtime
            .machine
            .begin_download(token, candidate("1.2.4"))
            .unwrap();
        assert!(
            runtime
                .begin_check_if(periodic_recheck_allowed)
                .unwrap()
                .is_none()
        );
        // The original operation is still current and can finish.
        runtime.machine.check_token(token).unwrap();
        assert_eq!(runtime.machine.status().phase, UpdatePhase::Downloading);
    }

    #[test]
    fn periodic_recheck_starts_from_idle_up_to_date_and_failed() {
        let mut runtime = Runtime {
            machine: UpdateMachine::new(UpdateChannel::Stable, "1.2.3"),
            prepared: None,
            active_check: None,
        };
        let (token, _, _) = runtime
            .begin_check_if(periodic_recheck_allowed)
            .unwrap()
            .expect("idle re-checks");
        runtime.finish_check(token);
        runtime.machine.no_update(token).unwrap();
        assert_eq!(runtime.machine.status().phase, UpdatePhase::UpToDate);
        let (token, _, _) = runtime
            .begin_check_if(periodic_recheck_allowed)
            .unwrap()
            .expect("up-to-date re-checks");
        runtime.finish_check(token);
        runtime.machine.fail(token, "offline").unwrap();
        assert!(
            runtime
                .begin_check_if(periodic_recheck_allowed)
                .unwrap()
                .is_some(),
            "failed re-checks"
        );
        assert_eq!(runtime.machine.status().phase, UpdatePhase::Checking);
    }

    #[test]
    fn manual_check_still_starts_from_a_staged_update() {
        let mut runtime = staged_runtime();
        assert!(runtime.begin_check_if(any_phase).unwrap().is_some());
        assert!(runtime.prepared.is_none());
        assert_eq!(runtime.machine.status().phase, UpdatePhase::Checking);
    }

    #[test]
    fn periodic_interval_is_six_hours_jittered_by_ten_percent() {
        let base = PERIODIC_CHECK_INTERVAL;
        assert_eq!(base, Duration::from_secs(6 * 60 * 60));
        let low = Duration::from_secs(6 * 60 * 60 * 9 / 10);
        let high = Duration::from_secs(6 * 60 * 60 * 11 / 10);
        assert_eq!(jittered_interval(base, 0), low);
        assert_eq!(jittered_interval(base, 2 * 2_160_000), high);
        for sample in [1, 12_345, u64::MAX, u64::MAX / 3, 2_160_000] {
            let interval = jittered_interval(base, sample);
            assert!(interval >= low && interval <= high, "{interval:?}");
        }
        assert_eq!(jittered_interval(base, 2_160_000), base);
        for _ in 0..32 {
            let interval = jittered_interval(base, jitter_sample());
            assert!(interval >= low && interval <= high, "{interval:?}");
        }
    }

    #[test]
    fn periodic_timer_fires_repeatedly_and_stops_on_shutdown() {
        let (stop, stopped) = mpsc::channel::<()>();
        let (fired, fires) = mpsc::channel::<()>();
        let timer = std::thread::spawn(move || {
            run_periodic_checks(
                &stopped,
                Duration::from_millis(5),
                || Duration::from_millis(1),
                || fired.send(()).unwrap(),
            );
        });
        for _ in 0..3 {
            fires
                .recv_timeout(Duration::from_secs(5))
                .expect("the timer fires");
        }
        drop(stop);
        timer.join().unwrap();
    }

    #[test]
    fn periodic_timer_is_cancelled_before_its_first_deadline() {
        let (stop, stopped) = mpsc::channel::<()>();
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&calls);
        let started = Instant::now();
        let timer = std::thread::spawn(move || {
            run_periodic_checks(
                &stopped,
                PERIODIC_CHECK_POLL,
                || PERIODIC_CHECK_INTERVAL,
                || {
                    observed.fetch_add(1, Ordering::SeqCst);
                },
            );
        });
        stop.send(()).unwrap();
        timer.join().unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn installer_preparation_runs_off_the_async_command_executor() {
        let started = Instant::now();
        let (_, heartbeat_ms) = tauri::async_runtime::block_on(futures_util::future::join(
            run_blocking_update(|| {
                std::thread::sleep(Duration::from_millis(150));
                Ok::<_, UpdateError>(())
            }),
            async { started.elapsed().as_millis() },
        ));

        assert!(
            heartbeat_ms < 100,
            "async heartbeat was delayed {heartbeat_ms}ms"
        );
    }
}
