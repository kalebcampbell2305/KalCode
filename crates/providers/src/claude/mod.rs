//! Claude Code adapter (headless stream-JSON). The only provider with a complete adapter in Z2.

pub mod actions;
pub mod argv;
mod normalize;
pub(crate) mod onboarding;
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

/// Oldest Claude Code release whose managed profile selectors (`CLAUDE_CONFIG_DIR` and
/// `CLAUDE_SECURESTORAGE_CONFIG_DIR`), settings precedence, `auth` commands, and the session flags
/// and permission modes KalCode passes were certified on the real binary.
pub const MANAGED_CLAUDE_FLOOR: Version = Version::new(2, 1, 282);

/// First release of the next Claude Code compatibility line. Managed profiles never run it
/// until that line is certified; standalone compatibility continues to use the catalog minimum.
pub const MANAGED_CLAUDE_CEILING: Version = Version::new(2, 2, 0);

/// Claude Code's native installer updates itself, so an exact pin fails for real users within
/// days. Managed profiles instead accept the certified floor through the rest of its compatibility
/// line and fail closed everywhere else, including every pre-release or build suffix.
///
/// Certified on real binaries on 2026-09-28: 2.1.282 (floor) and 2.1.283 (the latest published
/// release) have identical `auth`, `auth login` and `auth logout` command surfaces,
/// `auth login --claudeai` browser hand-off with piped stdio under
/// `CLAUDE_CONFIG_DIR` + `CLAUDE_SECURESTORAGE_CONFIG_DIR`, and every session flag and permission
/// mode KalCode passes (top-level `--help` gained only the unrelated `--client-data-url`).
pub(crate) fn managed_version_supported(version: &Version) -> bool {
    version.suffix.is_empty()
        && *version >= MANAGED_CLAUDE_FLOOR
        && *version < MANAGED_CLAUDE_CEILING
}

/// Human-readable supported range, for fail-closed messages.
pub fn certified_managed_versions_label() -> String {
    format!(
        "{MANAGED_CLAUDE_FLOOR} or a later {}.{}.x release",
        MANAGED_CLAUDE_FLOOR.major, MANAGED_CLAUDE_FLOOR.minor
    )
}

/// The npm command that installs the certified floor release. Claude Code's native installer
/// always installs the newest release (which may be outside the certified line), so a refusal
/// names the pinned npm package instead, as the Codex and Gemini refusals do.
pub fn managed_install_command() -> String {
    format!("npm install -g @anthropic-ai/claude-code@{MANAGED_CLAUDE_FLOOR}")
}

pub(crate) fn require_managed_version(reported: Option<&str>) -> Result<(), ProviderError> {
    let refusal = |found: &str| ProviderError::Refused {
        code: kalcode_contracts::threads::error_codes::PROVIDER_VERSION_UNSUPPORTED.to_owned(),
        message: format!(
            "Managed Claude Code accounts need certified Claude Code {}; this computer has {found}. \
             Install a supported version with `{}`, then try again.",
            certified_managed_versions_label(),
            managed_install_command()
        ),
    };
    let Some(version) = reported.and_then(Version::parse) else {
        return Err(refusal("a version KalCode couldn't read"));
    };
    if !managed_version_supported(&version) {
        return Err(refusal(&version.to_string()));
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
                effort: config.effort,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_profiles_accept_the_certified_line_and_fail_closed_outside_it() {
        for supported in ["2.1.282", "2.1.283", "2.1.299", "2.1.1000"] {
            assert!(
                require_managed_version(Some(supported)).is_ok(),
                "{supported} must be accepted for managed profiles"
            );
        }
        for rejected in [
            Some("2.1.281"),
            Some("2.1.259"),
            Some("2.2.0"),
            Some("3.0.0"),
            Some("2.0.999"),
            Some("2.1.283-beta.1"),
            Some("2.1.290+build.7"),
            Some("not a version"),
            None,
        ] {
            assert!(
                require_managed_version(rejected).is_err(),
                "{rejected:?} must fail closed for managed profiles"
            );
        }
        let Err(ProviderError::Refused { code, message }) = require_managed_version(Some("2.2.0"))
        else {
            panic!("the next line must be a typed version refusal");
        };
        assert_eq!(code, "provider_version_unsupported");
        assert!(
            message.contains("2.1.282 or a later 2.1.x release"),
            "{message}"
        );
        assert!(message.contains("this computer has 2.2.0"), "{message}");
        assert!(
            message.contains("`npm install -g @anthropic-ai/claude-code@2.1.282`"),
            "{message}"
        );
        assert!(matches!(
            require_managed_version(None),
            Err(ProviderError::Refused { code, .. }) if code == "provider_version_unsupported"
        ));
    }
}
