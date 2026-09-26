//! Signed, channel-bound desktop updates. The WebView receives only redacted lifecycle state;
//! feed parsing, bounded download, updater signature verification, recovery cache, and installer
//! launch stay native.

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use futures_util::future::{AbortHandle, AbortRegistration, Abortable};
use kalcode_core::{ErrorCategory, IpcError, KalError};
use kalcode_updater::{
    ArtifactFormat, Candidate, InstallAttempt, InstallBinding, InstallKind, InstallOutcome,
    MAX_UPDATE_BYTES, MacSwapAttempt, OperationToken, RollbackCache, UpdateChannel, UpdateError,
    UpdateJournal, UpdateMachine, UpdateStatus, UpdateTarget, validate_candidate_for_target,
    validate_retained_candidate_for_target, verify_download, verify_signature_for_metadata,
};
use reqwest::header::ACCEPT;
use reqwest::redirect::Policy;
use semver::Version;
use serde::Deserialize;
use tauri::{AppHandle, State, WebviewWindow};
use url::Url;

mod installer;
use installer::PreparedInstaller;

const NETWORK_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const USER_AGENT: &str = concat!("KalCode/", env!("CARGO_PKG_VERSION"));
const MAX_FEED_BYTES: u64 = 64 * 1024;

/// Quiesces active work before an installer can be launched. `false` means at least one runtime
/// could not prove it stopped within its bounded shutdown window, so installation must abort.
pub type BeforeUpdaterExit = Arc<dyn Fn() -> bool + Send + Sync + 'static>;

struct PreparedUpdate {
    candidate: Candidate,
    bytes: Vec<u8>,
    signature: String,
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
        self.prepared = None;
        self.machine.cancel()
    }

    fn set_channel(&mut self, channel: UpdateChannel) -> Result<(), UpdateError> {
        self.abort_check();
        self.prepared = None;
        self.machine.set_channel(channel)
    }
}

struct Inner {
    app: AppHandle,
    current_version: String,
    target: Option<UpdateTarget>,
    public_key: Option<String>,
    runtime: Mutex<Runtime>,
    journal: Mutex<Option<UpdateJournal>>,
    rollback: RollbackCache,
    prepared_dir: std::path::PathBuf,
    before_exit: BeforeUpdaterExit,
}

#[derive(Clone)]
pub struct DesktopUpdaterState(Arc<Inner>);

impl DesktopUpdaterState {
    pub fn start(
        app: AppHandle,
        data_dir: &std::path::Path,
        current_version: &str,
        public_key: Option<&str>,
        before_exit: BeforeUpdaterExit,
    ) -> Self {
        let update_dir = data_dir.join("updates");
        let target = UpdateTarget::current().ok();
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
                match target_matches
                    .then(|| journal.reconcile_startup(current_version))
                    .transpose()
                {
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
        let rollback = RollbackCache::new(update_dir.join("rollback"));
        if let Some(key) = public_key {
            match rollback.load_verified(key) {
                Ok(Some(artifact)) => machine.set_recovery_available(
                    target == Some(artifact.receipt().target())
                        && is_previous_version(current_version, &artifact.receipt().version),
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
            prepared_dir: update_dir.join("prepared"),
            before_exit,
        }))
    }

    pub fn check_in_background(&self) {
        let updater = self.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = updater.check().await {
                tracing::warn!(
                    event = "updater.background_check_failed",
                    error_code = error.code()
                );
            }
        });
    }

    fn runtime(&self) -> MutexGuard<'_, Runtime> {
        self.0
            .runtime
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
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
        self.runtime().machine.status().clone()
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
        Ok(runtime.machine.status().clone())
    }

    pub fn cancel(&self) -> Result<UpdateStatus, UpdateError> {
        let mut runtime = self.runtime();
        runtime.cancel()?;
        Ok(runtime.machine.status().clone())
    }

    async fn check(&self) -> Result<UpdateStatus, UpdateError> {
        let public_key = self.key()?.to_owned();
        let _target = self.target()?;
        let (token, channel, registration) = {
            let mut runtime = self.runtime();
            runtime.prepared = None;
            runtime.begin_cancellable_check()?
        };
        let result =
            Abortable::new(self.check_inner(token, channel, &public_key), registration).await;
        let mut runtime = self.runtime();
        runtime.finish_check(token);
        match result {
            Err(_) => Ok(runtime.machine.status().clone()),
            Ok(Ok(_)) => Ok(runtime.machine.status().clone()),
            Ok(Err(error)) => {
                runtime.prepared = None;
                if runtime.machine.check_token(token).is_err() {
                    return Ok(runtime.machine.status().clone());
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
            return Ok(runtime.machine.status().clone());
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
        let mut runtime = self.runtime();
        runtime.machine.ready(token, candidate.clone())?;
        runtime.prepared = Some(PreparedUpdate {
            candidate,
            bytes,
            signature: release.signature,
        });
        Ok(runtime.machine.status().clone())
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
                return Ok(is_previous_version(
                    &self.0.current_version,
                    &existing.receipt().version,
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
        let result = self.install_inner();
        if let Err(error) = &result {
            self.runtime().machine.mark_failed(error.to_string());
        }
        result
    }

    fn install_inner(&self) -> Result<(), UpdateError> {
        let update = {
            let mut runtime = self.runtime();
            let expected = runtime.machine.begin_install()?;
            let prepared = runtime.prepared.take().ok_or_else(|| {
                UpdateError::new(
                    "update_not_ready",
                    "No verified update is ready to install.",
                )
            })?;
            if prepared.candidate != expected {
                runtime
                    .machine
                    .mark_failed("The prepared update no longer matches the verified release.");
                return Err(UpdateError::new(
                    "update_state_invalid",
                    "The prepared update no longer matches the verified release.",
                ));
            }
            prepared
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
        )?;
        let binding = installer.binding().clone();
        let mac_swap = installer.mac_swap_attempt();
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
                // Active work was already quiesced. Restart the preserved current build instead
                // of leaving a visible but inert application running.
                self.0.app.restart();
            }
        }
    }

    fn restore_previous(&self) -> Result<(), UpdateError> {
        let result = self.restore_previous_inner();
        if let Err(error) = &result {
            self.runtime().machine.mark_failed(error.to_string());
        }
        result
    }

    fn restore_previous_inner(&self) -> Result<(), UpdateError> {
        let public_key = self.key()?.to_owned();
        let token = self.runtime().machine.begin_recovery()?;
        let (artifact, bytes) = self
            .0
            .rollback
            .load_bytes_verified(&public_key)?
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
            &public_key,
            &version,
            &metadata,
        )?;
        let installer = PreparedInstaller::prepare(
            &self.0.prepared_dir,
            &prepared_installer_name(kalcode_contracts::ids::new_id(), metadata.format),
            &bytes,
            &metadata,
            &version,
            &self.0.current_version,
        )?;
        let binding = installer.binding().clone();
        let mac_swap = installer.mac_swap_attempt();
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

fn launch_after_quiescence<T>(
    before_exit: &BeforeUpdaterExit,
    launch: impl FnOnce() -> Result<T, UpdateError>,
) -> Result<T, UpdateError> {
    if !(before_exit)() {
        return Err(UpdateError::new(
            "update_shutdown_failed",
            "KalCode couldn't safely stop active work. The update was not started.",
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

#[tauri::command]
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
    run_blocking_update(move || updater.install())
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
    run_blocking_update(move || updater.restore_previous())
        .await
        .map_err(|error| into_ipc(error, "updater_restore_previous"))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Instant;

    use super::*;

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
        }

        assert_eq!(preflight_calls.load(Ordering::SeqCst), 2);
        assert_eq!(installer_calls.load(Ordering::SeqCst), 0);
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
