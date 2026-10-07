//! KalCode-owned Codex runtime selection and transparent last-known-good recovery.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use kalcode_contracts::agent::{ProviderError, ProviderId};

use super::compatibility::{CodexCapabilities, probe_with_admission};
use crate::compatibility::{CompatibilityStatus, evaluate_active};
use crate::guardian::RegisteredJob;
use crate::managed_runtime::{
    RuntimeLease, RuntimePlatform, RuntimeStore, resolve_codex_runtime_layout,
};
use crate::version::Version;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagedRuntimeSource {
    /// Immutable KalCode-owned copy of the currently installed distribution.
    ValidatedSnapshot,
    /// The installed distribution is compatible but its layout could not be snapshotted. Native
    /// parity remains available; diagnostics can truthfully show that recovery is unavailable.
    InstalledDirect,
    /// A new or missing installed distribution could not be used, so KalCode selected the newest
    /// intact previously validated immutable runtime.
    LastKnownGood,
}

#[derive(Debug, Clone)]
pub struct ManagedCodexRuntime {
    executable: PathBuf,
    capabilities: Arc<CodexCapabilities>,
    runtime_lease: Option<RuntimeLease>,
    source: ManagedRuntimeSource,
}

impl ManagedCodexRuntime {
    pub fn executable(&self) -> &Path {
        &self.executable
    }

    pub fn version(&self) -> &Version {
        &self.capabilities.version
    }

    pub fn capabilities(&self) -> &Arc<CodexCapabilities> {
        &self.capabilities
    }

    pub fn runtime_lease(&self) -> Option<&RuntimeLease> {
        self.runtime_lease.as_ref()
    }

    pub const fn source(&self) -> ManagedRuntimeSource {
        self.source
    }

    /// Applies only credential-free launcher metadata needed by a KalCode-owned immutable
    /// snapshot. Direct installations retain the caller's native provider environment unchanged.
    pub fn configure_environment(&self, environment: &mut BTreeMap<OsString, OsString>) {
        if let Some(lease) = &self.runtime_lease {
            lease.configure_environment(environment);
        }
    }

    pub fn into_parts(
        self,
    ) -> (
        PathBuf,
        Version,
        Arc<CodexCapabilities>,
        Option<RuntimeLease>,
    ) {
        (
            self.executable,
            self.capabilities.version.clone(),
            self.capabilities,
            self.runtime_lease,
        )
    }
}

/// Selects the runtime for a foreground managed Codex process without copying provider bytes on
/// the user path. Existing processes are untouched. An already-prewarmed immutable snapshot is
/// preferred; on a cache miss the exact installed binary receives the complete capability,
/// protocol, and signed-policy checks and runs directly while the background watcher prepares its
/// snapshot. A known-bad or genuinely incompatible candidate falls back to validated snapshots.
pub fn select_managed_runtime(
    installed_executable: Option<&Path>,
    env: &BTreeMap<OsString, OsString>,
    neutral_cwd: &Path,
    store: &RuntimeStore,
    mut prepare_job: impl FnMut(&str) -> Result<RegisteredJob, ProviderError>,
    canceled: Option<&dyn Fn() -> bool>,
) -> Result<ManagedCodexRuntime, ProviderError> {
    let mut candidate_error = None;
    if let Some(installed) = installed_executable {
        if let Ok(Some(selected)) = select_cached_installed(
            installed,
            env,
            neutral_cwd,
            store,
            &mut prepare_job,
            canceled,
        ) {
            return Ok(selected);
        }
        match select_direct(installed, env, neutral_cwd, &mut prepare_job, canceled) {
            Ok(selected) => return Ok(selected),
            Err(error) => candidate_error = Some(error),
        }
    }

    match select_last_known_good(env, neutral_cwd, store, &mut prepare_job, canceled) {
        Ok(Some(selected)) => Ok(selected),
        Ok(None) => Err(candidate_error.unwrap_or(ProviderError::NotInstalled)),
        Err(fallback_error) => Err(candidate_error.unwrap_or(fallback_error)),
    }
}

/// Selects an immutable runtime for a managed session that can launch more than one Codex
/// process. A turn session must not retain a mutable global executable path because a package
/// manager may replace that path between turns. A compatible last-known-good runtime starts
/// immediately while the watcher snapshots a new installation. On first use, the installation is
/// validated before copying, then the exact staged bytes are probed again before promotion.
/// Storage/layout failures never silently return the mutable installation.
pub fn select_managed_runtime_pinned(
    installed_executable: Option<&Path>,
    env: &BTreeMap<OsString, OsString>,
    neutral_cwd: &Path,
    store: &RuntimeStore,
    mut prepare_job: impl FnMut(&str) -> Result<RegisteredJob, ProviderError>,
    canceled: Option<&dyn Fn() -> bool>,
) -> Result<ManagedCodexRuntime, ProviderError> {
    let mut candidate_error = None;
    if let Some(installed) = installed_executable {
        if let Ok(Some(selected)) = select_cached_installed(
            installed,
            env,
            neutral_cwd,
            store,
            &mut prepare_job,
            canceled,
        ) {
            return Ok(selected);
        }
        // A newly installed binary can race the background snapshot watcher. Prefer an existing
        // policy-compatible immutable runtime immediately; the watcher validates and adopts the
        // new bytes without making this session wait on their protocol probe or distribution copy.
        if let Ok(Some(selected)) =
            select_last_known_good(env, neutral_cwd, store, &mut prepare_job, canceled)
        {
            return Ok(selected);
        }
        match select_direct(installed, env, neutral_cwd, &mut prepare_job, canceled) {
            Ok(_) => match select_installed_pinned(
                installed,
                env,
                neutral_cwd,
                store,
                &mut prepare_job,
                canceled,
            ) {
                Ok(selected) => return Ok(selected),
                Err(error) => candidate_error = Some(error),
            },
            Err(error) => candidate_error = Some(error),
        }
    }

    match select_last_known_good(env, neutral_cwd, store, &mut prepare_job, canceled) {
        Ok(Some(selected)) => Ok(selected),
        Ok(None) => Err(candidate_error.unwrap_or(ProviderError::NotInstalled)),
        Err(fallback_error) => Err(candidate_error.unwrap_or(fallback_error)),
    }
}

/// Background-only snapshot preparation. This may copy and hash a large provider distribution,
/// so desktop startup and installation-change watchers call it asynchronously and retain the
/// returned lease. Single-process foreground launches use [`select_managed_runtime`] without
/// copying. A cold multi-turn headless session uses [`select_managed_runtime_pinned`] and must wait
/// for the immutable copy so later turns cannot follow a replaced global executable path.
pub fn prewarm_managed_runtime(
    installed_executable: Option<&Path>,
    env: &BTreeMap<OsString, OsString>,
    neutral_cwd: &Path,
    store: &RuntimeStore,
    mut prepare_job: impl FnMut(&str) -> Result<RegisteredJob, ProviderError>,
    canceled: Option<&dyn Fn() -> bool>,
) -> Result<ManagedCodexRuntime, ProviderError> {
    let mut candidate_error = None;
    if let Some(installed) = installed_executable {
        // Validate the exact installed fingerprint before reading hundreds of megabytes into a
        // snapshot. This both seeds a racing foreground launch's capability cache and prevents a
        // known-bad/incompatible install from consuming copy and hashing work.
        match select_direct(installed, env, neutral_cwd, &mut prepare_job, canceled) {
            Ok(_) => match select_installed(
                installed,
                env,
                neutral_cwd,
                store,
                &mut prepare_job,
                canceled,
            ) {
                Ok(selected) => return Ok(selected),
                Err(error) => candidate_error = Some(error),
            },
            Err(error) => candidate_error = Some(error),
        }
    }
    match select_last_known_good(env, neutral_cwd, store, &mut prepare_job, canceled) {
        Ok(Some(selected)) => Ok(selected),
        Ok(None) => Err(candidate_error.unwrap_or(ProviderError::NotInstalled)),
        Err(fallback_error) => Err(candidate_error.unwrap_or(fallback_error)),
    }
}

fn select_cached_installed(
    executable: &Path,
    env: &BTreeMap<OsString, OsString>,
    neutral_cwd: &Path,
    store: &RuntimeStore,
    prepare_job: &mut impl FnMut(&str) -> Result<RegisteredJob, ProviderError>,
    canceled: Option<&dyn Fn() -> bool>,
) -> Result<Option<ManagedCodexRuntime>, ProviderError> {
    let pinned = match RuntimePlatform::current()
        .and_then(|platform| resolve_codex_runtime_layout(executable, env, platform))
        .and_then(|layout| store.cached_staged(ProviderId::CODEX, &layout))
    {
        Ok(Some(pinned)) => pinned,
        Ok(None) | Err(_) => return Ok(None),
    };
    let mut snapshot_env = env.clone();
    pinned.configure_environment(&mut snapshot_env);
    let capabilities = probe_and_apply_policy(
        pinned.executable(),
        &snapshot_env,
        neutral_cwd,
        prepare_job,
        canceled,
    )?;
    let version = capabilities.version.to_string();
    let lease = match store.promote_validated(&pinned, &version) {
        Ok(lease) => lease,
        Err(_) => return Ok(None),
    };
    Ok(Some(ManagedCodexRuntime {
        executable: lease.executable().to_path_buf(),
        capabilities,
        runtime_lease: Some(lease),
        source: ManagedRuntimeSource::ValidatedSnapshot,
    }))
}

fn select_installed(
    executable: &Path,
    env: &BTreeMap<OsString, OsString>,
    neutral_cwd: &Path,
    store: &RuntimeStore,
    prepare_job: &mut impl FnMut(&str) -> Result<RegisteredJob, ProviderError>,
    canceled: Option<&dyn Fn() -> bool>,
) -> Result<ManagedCodexRuntime, ProviderError> {
    let staged = RuntimePlatform::current()
        .and_then(|platform| resolve_codex_runtime_layout(executable, env, platform))
        .and_then(|layout| store.stage(ProviderId::CODEX, &layout));
    let pinned = match staged {
        Ok(pinned) => pinned,
        Err(_) => {
            return select_direct(executable, env, neutral_cwd, prepare_job, canceled);
        }
    };
    let mut snapshot_env = env.clone();
    pinned.configure_environment(&mut snapshot_env);
    let capabilities = probe_and_apply_policy(
        pinned.executable(),
        &snapshot_env,
        neutral_cwd,
        prepare_job,
        canceled,
    )?;
    let version = capabilities.version.to_string();
    match store.promote_validated(&pinned, &version) {
        Ok(lease) => Ok(ManagedCodexRuntime {
            executable: lease.executable().to_path_buf(),
            capabilities,
            runtime_lease: Some(lease),
            source: ManagedRuntimeSource::ValidatedSnapshot,
        }),
        // Runtime storage is a recovery aid, not a new native-provider capability ceiling. Reprobe
        // the source executable before direct use because it may have changed while staging.
        Err(_) => select_direct(executable, env, neutral_cwd, prepare_job, canceled),
    }
}

fn select_installed_pinned(
    executable: &Path,
    env: &BTreeMap<OsString, OsString>,
    neutral_cwd: &Path,
    store: &RuntimeStore,
    prepare_job: &mut impl FnMut(&str) -> Result<RegisteredJob, ProviderError>,
    canceled: Option<&dyn Fn() -> bool>,
) -> Result<ManagedCodexRuntime, ProviderError> {
    let platform = RuntimePlatform::current().map_err(|_| immutable_runtime_unavailable())?;
    let layout = resolve_codex_runtime_layout(executable, env, platform)
        .map_err(|_| immutable_runtime_unavailable())?;
    let pinned = store
        .stage(ProviderId::CODEX, &layout)
        .map_err(|_| immutable_runtime_unavailable())?;
    let mut snapshot_env = env.clone();
    pinned.configure_environment(&mut snapshot_env);
    let capabilities = probe_and_apply_policy(
        pinned.executable(),
        &snapshot_env,
        neutral_cwd,
        prepare_job,
        canceled,
    )?;
    let version = capabilities.version.to_string();
    let lease = store
        .promote_validated(&pinned, &version)
        .map_err(|_| immutable_runtime_unavailable())?;
    Ok(ManagedCodexRuntime {
        executable: lease.executable().to_path_buf(),
        capabilities,
        runtime_lease: Some(lease),
        source: ManagedRuntimeSource::ValidatedSnapshot,
    })
}

fn immutable_runtime_unavailable() -> ProviderError {
    ProviderError::Start("KalCode could not prepare an immutable managed Codex runtime".into())
}

fn select_direct(
    executable: &Path,
    env: &BTreeMap<OsString, OsString>,
    neutral_cwd: &Path,
    prepare_job: &mut impl FnMut(&str) -> Result<RegisteredJob, ProviderError>,
    canceled: Option<&dyn Fn() -> bool>,
) -> Result<ManagedCodexRuntime, ProviderError> {
    let capabilities = probe_and_apply_policy(executable, env, neutral_cwd, prepare_job, canceled)?;
    Ok(ManagedCodexRuntime {
        executable: executable.to_path_buf(),
        capabilities,
        runtime_lease: None,
        source: ManagedRuntimeSource::InstalledDirect,
    })
}

fn select_last_known_good(
    env: &BTreeMap<OsString, OsString>,
    neutral_cwd: &Path,
    store: &RuntimeStore,
    prepare_job: &mut impl FnMut(&str) -> Result<RegisteredJob, ProviderError>,
    canceled: Option<&dyn Fn() -> bool>,
) -> Result<Option<ManagedCodexRuntime>, ProviderError> {
    let candidates = store.validated_candidates(ProviderId::CODEX).map_err(|_| {
        ProviderError::Start("KalCode's managed Codex runtime is unavailable".into())
    })?;
    if candidates.is_empty() {
        return Ok(None);
    }
    let mut last_error = None;
    for lease in candidates {
        let mut snapshot_env = env.clone();
        lease.configure_environment(&mut snapshot_env);
        let capabilities = match probe_and_apply_policy(
            lease.executable(),
            &snapshot_env,
            neutral_cwd,
            prepare_job,
            canceled,
        ) {
            Ok(capabilities) => capabilities,
            Err(error) => {
                last_error = Some(error);
                continue;
            }
        };
        if capabilities.version.to_string() != lease.version() {
            last_error = Some(ProviderError::Start(
                "KalCode's managed Codex runtime metadata did not match its executable".into(),
            ));
            continue;
        }
        let lease = store.prefer_validated(&lease).unwrap_or(lease);
        return Ok(Some(ManagedCodexRuntime {
            executable: lease.executable().to_path_buf(),
            capabilities,
            runtime_lease: Some(lease),
            source: ManagedRuntimeSource::LastKnownGood,
        }));
    }
    Err(last_error.unwrap_or_else(|| {
        ProviderError::Start("KalCode's managed Codex runtime is incompatible".into())
    }))
}

fn probe_and_apply_policy(
    executable: &Path,
    env: &BTreeMap<OsString, OsString>,
    neutral_cwd: &Path,
    prepare_job: &mut impl FnMut(&str) -> Result<RegisteredJob, ProviderError>,
    canceled: Option<&dyn Fn() -> bool>,
) -> Result<Arc<CodexCapabilities>, ProviderError> {
    let probed = probe_with_admission(
        executable,
        env,
        neutral_cwd,
        |label| prepare_job(label),
        canceled,
    )?;
    let decision = evaluate_active(
        ProviderId::CODEX,
        &probed.version.to_string(),
        &probed.probe_facts(),
    )
    .map_err(|_| {
        ProviderError::Start("Codex compatibility policy could not be evaluated".into())
    })?;
    match decision.status {
        CompatibilityStatus::Usable { .. } => probed
            .with_effective_capabilities(&decision.effective_capabilities)
            .map(Arc::new),
        CompatibilityStatus::KnownBad { .. } => Err(policy_refusal(
            "This Codex build has a verified compatibility issue; KalCode will use its last-known-good managed runtime when available.",
        )),
        CompatibilityStatus::BelowStableFloor { .. } => Err(policy_refusal(
            "This Codex build is below the current managed-runtime compatibility floor.",
        )),
        CompatibilityStatus::ProtocolIncompatible { .. } => Err(policy_refusal(
            "This Codex build does not satisfy the required managed-runtime protocol.",
        )),
    }
}

fn policy_refusal(message: &str) -> ProviderError {
    ProviderError::Refused {
        code: "provider_capability_incompatible".into(),
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn missing_install_and_missing_last_known_good_is_not_installed() {
        let temp = tempfile::tempdir().expect("temp");
        let store = crate::managed_runtime::RuntimeStore::new(temp.path().join("runtimes"));
        let env = BTreeMap::new();
        let error = select_managed_runtime(
            None,
            &env,
            temp.path(),
            &store,
            |_| panic!("a missing runtime starts no probe"),
            None,
        )
        .expect_err("no runtime");
        assert!(matches!(
            error,
            kalcode_contracts::agent::ProviderError::NotInstalled
        ));
    }
}
