//! Claude Code adapter (headless stream-JSON). The only provider with a complete adapter in Z2.

pub mod actions;
pub mod argv;
mod normalize;
pub mod session;
mod stream;

use kalcode_contracts::agent::{
    AgentEventSink, AgentProvider, AgentSession, DetectionState, ProviderCapabilities,
    ProviderDetection, ProviderError, ProviderId, SessionConfig,
};

use crate::catalog;
use crate::detect::{DetectEnv, detect, detect_guarded};
use crate::version::Version;
use session::{ClaudeSession, LaunchSpec, SessionTimeouts};

/// Exact Claude Code release whose managed profile selectors, settings precedence, auth
/// commands, and permission flags were certified together. Standalone compatibility continues
/// to use the catalog minimum; account-isolated launches fail closed on any other release.
pub(crate) const MANAGED_CLAUDE_VERSION: Version = Version::new(2, 1, 282);

pub(crate) fn require_managed_version(reported: Option<&str>) -> Result<(), ProviderError> {
    let version = reported.and_then(Version::parse).ok_or_else(|| {
        ProviderError::Start("Claude Code did not report a version KalCode can verify".into())
    })?;
    if version != MANAGED_CLAUDE_VERSION {
        return Err(ProviderError::Start(format!(
            "managed Claude profiles currently require certified Claude Code {MANAGED_CLAUDE_VERSION}; found {version}"
        )));
    }
    Ok(())
}

/// [`AgentProvider`] for Claude Code.
pub struct ClaudeCodeProvider {
    env: DetectEnv,
    timeouts: SessionTimeouts,
    managed: Option<crate::managed::ManagedProfiles>,
}

impl ClaudeCodeProvider {
    pub fn new(env: DetectEnv) -> Self {
        Self {
            env,
            timeouts: SessionTimeouts::default(),
            managed: None,
        }
    }

    pub fn with_managed_profiles(mut self, profiles: crate::managed::ManagedProfiles) -> Self {
        self.managed = Some(profiles);
        self
    }

    pub fn with_timeouts(mut self, timeouts: SessionTimeouts) -> Self {
        self.timeouts = timeouts;
        self
    }

    fn start_native_session(
        &self,
        config: SessionConfig,
        sink: Box<dyn AgentEventSink>,
        require_managed_version: bool,
        guardian_job: Option<crate::guardian::RegisteredJob>,
        probe_guardian: Option<crate::guardian::ProviderProbeGuardian>,
    ) -> Result<Box<dyn AgentSession>, ProviderError> {
        if config.provider_account_id.is_some() {
            return Err(ProviderError::Start(
                "A managed provider profile is required for this account.".into(),
            ));
        }
        if config.secret_ref.is_some() {
            // API-key accounts (secure-store references) are a later campaign; sessions use the
            // user's own Claude Code sign-in.
            return Err(ProviderError::Unsupported);
        }
        let spec = catalog::claude_spec();
        let detected = match &probe_guardian {
            Some(guardian) => detect_guarded(&spec, &self.env, guardian),
            None => detect(&spec, &self.env),
        };
        let executable = match (detected.detection.state, detected.executable) {
            (DetectionState::Installed, Some(exe)) => exe,
            (DetectionState::NotInstalled, _) => return Err(ProviderError::NotInstalled),
            (DetectionState::Outdated, _) => {
                return Err(ProviderError::Start(
                    detected
                        .detection
                        .message
                        .unwrap_or_else(|| "Claude Code needs to be updated.".into()),
                ));
            }
            _ => {
                return Err(ProviderError::Start(
                    detected
                        .detection
                        .message
                        .unwrap_or_else(|| "Claude Code couldn't be checked.".into()),
                ));
            }
        };
        if require_managed_version {
            self::require_managed_version(detected.detection.version.as_deref())?;
        }
        if detected.detection.auth == kalcode_contracts::agent::AuthState::NotAuthenticated {
            return Err(ProviderError::NotAuthenticated);
        }
        let session = ClaudeSession::start(
            LaunchSpec {
                executable,
                env: self.env.provider_env(&spec.env_policy),
                working_directory: config.working_directory,
                model: config.model,
                mode: config.permission_mode,
                resume_session_id: config.resume_session_id,
                timeouts: self.timeouts,
                guardian_job,
            },
            sink,
        )?;
        Ok(Box::new(session))
    }
}

impl AgentProvider for ClaudeCodeProvider {
    fn id(&self) -> ProviderId {
        ProviderId::new(ProviderId::CLAUDE_CODE)
    }

    fn display_name(&self) -> &str {
        "Claude Code"
    }

    fn detect(&self) -> ProviderDetection {
        let mut spec = catalog::claude_spec();
        if self.managed.is_some() {
            spec.auth = None;
        }
        match self
            .managed
            .as_ref()
            .and_then(|profiles| profiles.probe_guardian().ok())
        {
            Some(guardian) => detect_guarded(&spec, &self.env, &guardian).detection,
            None => detect(&spec, &self.env).detection,
        }
    }

    fn capabilities(&self) -> ProviderCapabilities {
        catalog::claude_capabilities()
    }

    fn start_session(
        &self,
        config: SessionConfig,
        sink: Box<dyn AgentEventSink>,
    ) -> Result<Box<dyn AgentSession>, ProviderError> {
        if let Some(profiles) = &self.managed {
            let account = config
                .provider_account_id
                .as_deref()
                .ok_or(ProviderError::NotAuthenticated)?;
            let lease = profiles.acquire_session_lease(ProviderId::CLAUDE_CODE, account)?;
            let guardian_job = lease.prepare_guarded_job("claude-session")?;
            let probe_guardian = profiles.probe_guardian()?;
            let env = profiles.prepare_env(ProviderId::CLAUDE_CODE, account, &self.env)?;
            let provider = Self::new(env).with_timeouts(self.timeouts);
            let mut isolated_config = config;
            // Account selection is already bound to this launch environment and retained lease.
            isolated_config.provider_account_id = None;
            let session = provider.start_native_session(
                isolated_config,
                sink,
                true,
                Some(guardian_job),
                Some(probe_guardian),
            )?;
            return Ok(crate::managed::hold_session_lease(session, lease));
        }
        self.start_native_session(config, sink, false, None, None)
    }
}
