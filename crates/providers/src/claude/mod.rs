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
use crate::detect::{DetectEnv, detect};
use session::{ClaudeSession, LaunchSpec, SessionTimeouts};

/// [`AgentProvider`] for Claude Code.
pub struct ClaudeCodeProvider {
    env: DetectEnv,
    timeouts: SessionTimeouts,
}

impl ClaudeCodeProvider {
    pub fn new(env: DetectEnv) -> Self {
        Self {
            env,
            timeouts: SessionTimeouts::default(),
        }
    }

    pub fn with_timeouts(mut self, timeouts: SessionTimeouts) -> Self {
        self.timeouts = timeouts;
        self
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
        detect(&catalog::claude_spec(), &self.env).detection
    }

    fn capabilities(&self) -> ProviderCapabilities {
        catalog::claude_capabilities()
    }

    fn start_session(
        &self,
        config: SessionConfig,
        sink: Box<dyn AgentEventSink>,
    ) -> Result<Box<dyn AgentSession>, ProviderError> {
        if config.secret_ref.is_some() {
            // API-key accounts (secure-store references) are a later campaign; sessions use the
            // user's own Claude Code sign-in.
            return Err(ProviderError::Unsupported);
        }
        let spec = catalog::claude_spec();
        let detected = detect(&spec, &self.env);
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
            },
            sink,
        )?;
        Ok(Box::new(session))
    }
}
