//! Codex and Gemini CLI in a pane (PROVIDERS-2, docs/PROVIDER_PANES.md §3), read-only first.
//!
//! The real, unmodified CLI runs in a Z1 PTY. KalCode never answers these providers' approvals:
//! the person answers in the provider's own prompt.
//!
//! - **Codex**: `codex -C <ws> -s <sandbox> -a on-request … -c notify=[kalcode-hook …]
//!   -c tui.notifications=['approval-requested'] -c tui.notification_method='osc9'`
//!   ([`super::codex::interactive_args`]). Status: `notify` (`agent-turn-complete`, with the
//!   thread id for resume) through the authenticated hook bridge. Terminal escape sequences
//!   never change canonical status; a tool can print the same bytes as a provider prompt.
//! - **Gemini CLI**: `gemini --approval-mode <mapping> [--model] [--resume]`; process and PTY
//!   state only ("limited status"), because a per-session way to add KalCode's hooks without
//!   writing the user's or the project's settings is unverified.

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::{Arc, Weak};

use kalcode_contracts::agent::{
    AgentEventSink, AgentProvider, AgentSession, AuthState, DetectionState, ProviderCapabilities,
    ProviderDetection, ProviderError, ProviderId, SessionConfig,
};
use kalcode_hook_bridge::KEY_ENV;
use kalcode_hook_bridge::server::BridgeServer;
use kalcode_pty::{ProgramSpec, PtySession, TerminalSize};

use super::codex::{CodexArgs, interactive_args_with_overrides as codex_args};
use super::provider::{InteractiveConfig, PaneRegistry};
use super::session::{HandlerRef, InteractiveSession, PaneProfile, SessionParts, Shared};
use crate::catalog;
use crate::claude::actions::ActionContext;
use crate::claude::argv::working_directory;
use crate::codex::managed_policy::CloudConfigEligibility;
use crate::codex::{managed_executable as managed_codex_executable, usable_executable};
use crate::detect::{DetectEnv, DetectionSpec, detect, detect_guarded};
use crate::gemini::managed_policy::ManagedGeminiLaunch;
use crate::launch::{LaunchKind, resolve};
use crate::managed::{
    ManagedProfiles, ProfileLease, hold_shared_session_lease, share_profile_lease,
};
use crate::version::Version;

const DEFAULT_SIZE: (u16, u16) = (120, 32);

type CodexCloudConfigResolver =
    dyn Fn(&str) -> Result<CloudConfigEligibility, ProviderError> + Send + Sync;

/// Which CLI a pane runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaneCli {
    Codex,
    Gemini,
    Cursor,
}

impl PaneCli {
    fn spec(self) -> DetectionSpec {
        match self {
            Self::Codex => catalog::codex_spec(),
            Self::Gemini => catalog::gemini_spec(),
            Self::Cursor => catalog::cursor_spec(),
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::Codex => ProviderId::CODEX,
            Self::Gemini => ProviderId::GEMINI_CLI,
            Self::Cursor => ProviderId::CURSOR,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Codex => "Codex",
            Self::Gemini => "Gemini CLI",
            Self::Cursor => "Cursor",
        }
    }

    fn profile(self) -> PaneProfile {
        match self {
            Self::Codex => PaneProfile {
                answer_in: "Answer in Codex",
                kalcode_answers: false,
            },
            Self::Gemini => PaneProfile {
                answer_in: "Answer in Gemini CLI",
                kalcode_answers: false,
            },
            Self::Cursor => PaneProfile {
                answer_in: "Answer in Cursor",
                kalcode_answers: false,
            },
        }
    }
}

/// Codex or Gemini CLI running interactively in a pane.
pub struct InteractiveCliProvider {
    cli: PaneCli,
    env: DetectEnv,
    managed_profiles: Option<ManagedProfiles>,
    codex_cloud_config: Option<Arc<CodexCloudConfigResolver>>,
    integrations: Option<Arc<super::integrations::IntegrationConnector>>,
    /// Codex `notify` reaches KalCode through the bridge; Gemini CLI panes don't use it.
    bridge: Option<Arc<BridgeServer>>,
    config: InteractiveConfig,
    panes: Arc<PaneRegistry>,
}

impl InteractiveCliProvider {
    pub fn new(
        cli: PaneCli,
        env: DetectEnv,
        bridge: Option<Arc<BridgeServer>>,
        config: InteractiveConfig,
        panes: Arc<PaneRegistry>,
    ) -> Self {
        Self {
            cli,
            env,
            managed_profiles: None,
            codex_cloud_config: None,
            integrations: None,
            bridge,
            config,
            panes,
        }
    }

    /// Enables account-scoped profiles. Once configured, every pane must name an account and
    /// launches only through that provider's canonical managed policy.
    pub fn with_managed_profiles(mut self, profiles: ManagedProfiles) -> Self {
        self.managed_profiles = Some(profiles);
        self
    }

    /// Supplies the authoritative account result used by Codex's managed policy. Missing or
    /// unknown results fail closed because enterprise cloud configuration cannot be disabled.
    pub fn with_codex_cloud_config_resolver<F>(mut self, resolver: F) -> Self
    where
        F: Fn(&str) -> Result<CloudConfigEligibility, ProviderError> + Send + Sync + 'static,
    {
        self.codex_cloud_config = Some(Arc::new(resolver));
        self
    }

    pub fn sessions_dir(&self) -> PathBuf {
        self.config.sessions_dir.clone()
    }

    pub fn with_integrations(
        mut self,
        connector: Arc<super::integrations::IntegrationConnector>,
    ) -> Self {
        self.integrations = Some(connector);
        self
    }

    fn start(
        &self,
        config: SessionConfig,
        sink: Box<dyn AgentEventSink>,
    ) -> Result<Box<dyn AgentSession>, ProviderError> {
        let account_id = match (
            self.managed_profiles.as_ref(),
            config.provider_account_id.as_deref(),
        ) {
            (None, Some(_)) if self.cli != PaneCli::Cursor => {
                return Err(ProviderError::Start(
                    "A managed provider profile is required for this account.".into(),
                ));
            }
            (Some(_), None) => {
                return Err(ProviderError::Start(format!(
                    "a managed {} session requires an explicit provider account",
                    self.cli.name()
                )));
            }
            (Some(_), Some(account_id)) => Some(account_id),
            (None, None) => None,
            (None, Some(_)) => None,
        };
        if config.secret_ref.is_some() {
            return Err(ProviderError::Unsupported);
        }
        if self.cli == PaneCli::Cursor && config.effort.is_some() {
            return Err(ProviderError::Refused {
                code: "cursor_effort_unavailable".into(),
                message: "Cursor exposes effort through model variants. Select an available exact model variant, or change effort with /model in its terminal.".into(),
            });
        }
        let spec = self.cli.spec();
        let workspace = working_directory(&config.working_directory)
            .map_err(|e| ProviderError::Start(e.to_string()))?;
        let mut codex_overrides = Vec::new();
        let mut gemini_args = None;
        let mut integration_lifetime = None;
        let mut lease: Option<ProfileLease> = None;
        let (executable, mut env, cwd) = match (self.managed_profiles.as_ref(), account_id) {
            (Some(profiles), Some(account_id)) => match self.cli {
                PaneCli::Cursor => {
                    let guardian = profiles.probe_guardian()?;
                    let detected = detect_guarded(&spec, &self.env, &guardian);
                    let executable = detected.executable.ok_or(ProviderError::NotInstalled)?;
                    if detected.detection.state != DetectionState::Installed {
                        return Err(ProviderError::Start(detected.detection.message.unwrap_or_else(|| "Cursor integration could not be checked. Update Cursor Agent and retry.".into())));
                    }
                    // Metadata/lease isolation only. Cursor keeps its native configuration,
                    // authentication and tool environment; no invented profile selector.
                    lease = Some(profiles.acquire_session_lease(ProviderId::CURSOR, account_id)?);
                    (
                        executable,
                        self.env.provider_env(&spec.env_policy),
                        workspace.clone(),
                    )
                }
                PaneCli::Codex => {
                    let probe_guardian = profiles.probe_guardian()?;
                    let resolve_cloud_config = self.codex_cloud_config.as_ref().ok_or_else(|| {
                            ProviderError::Start(
                                "Codex managed sessions require authoritative cloud-config eligibility"
                                    .into(),
                            )
                        })?;
                    let eligibility = resolve_cloud_config(account_id)?;
                    let prepared = crate::codex::managed_policy::prepare_session(
                        profiles,
                        &self.env,
                        account_id,
                        &workspace,
                        eligibility,
                    )?;
                    let executable =
                        managed_codex_executable(&spec, &prepared.detect_env, &probe_guardian)?;
                    codex_overrides = prepared.cli_overrides;
                    lease = Some(prepared.lease);
                    (executable, prepared.env, workspace.clone())
                }
                PaneCli::Gemini => {
                    let probe_guardian = profiles.probe_guardian()?;
                    let mut prepared = ManagedGeminiLaunch::prepare(
                        profiles,
                        &self.env,
                        account_id,
                        &config.thread_id,
                        &workspace,
                        config.permission_mode,
                    )?;
                    let detection_env = DetectEnv {
                        vars: prepared
                            .environment()
                            .iter()
                            .map(|(name, value)| (name.clone(), value.clone()))
                            .collect(),
                        windows: self.env.windows,
                        probe_timeout: self.env.probe_timeout,
                        system_root: self.env.system_root.clone(),
                    };
                    let executable =
                        managed_gemini_executable(&spec, &detection_env, &probe_guardian)?;
                    let mut args = crate::gemini::interactive_args(
                        config.permission_mode,
                        config.model.as_deref(),
                        config.resume_session_id.as_deref(),
                    )
                    .map_err(|e| ProviderError::Start(e.to_string()))?;
                    prepared.append_security_args(&mut args)?;
                    let env = prepared.environment().clone();
                    let cwd = prepared.cwd().to_path_buf();
                    lease = Some(prepared.take_session_lease()?);
                    gemini_args = Some(args);
                    (executable, env, cwd)
                }
            },
            (None, None) => (
                usable_executable(&spec, &self.env)?,
                self.env.provider_env(&spec.env_policy),
                workspace.clone(),
            ),
            _ => unreachable!("managed account validation is exhaustive"),
        };
        for (name, value) in [
            ("TERM", "xterm-256color"),
            ("COLORTERM", "truecolor"),
            ("TERM_PROGRAM", "KalCode"),
        ] {
            env.insert(name.into(), value.into());
        }
        let launch = resolve(&executable, &env);
        if launch.kind == LaunchKind::ShimUnresolved {
            return Err(ProviderError::Start(format!(
                "KalCode couldn't resolve how to start {} safely.",
                self.cli.name()
            )));
        }
        #[cfg(unix)]
        crate::launch::apply_launch_env(&launch, &mut env);

        let shared = Shared::new(SessionParts {
            ctx: ActionContext {
                thread_id: config.thread_id.clone(),
                workspace_id: config.workspace_id.clone(),
                working_directory: config.working_directory.clone(),
            },
            provider_id: self.cli.id().into(),
            routing: self.config.routing,
            sink,
            provider_session_id: config.resume_session_id.clone().unwrap_or_default(),
            limits: self.config.limits,
            expiry: None,
            titles: None,
        });
        shared.set_profile(self.cli.profile());
        if config.resume_session_id.is_none() {
            shared.forget_session_id();
        }

        if matches!(self.cli, PaneCli::Codex)
            && let Some(connect) = &self.integrations
        {
            let connection = connect(&config)?;
            codex_overrides.extend(super::integrations::codex_config(&connection.url));
            env.insert(
                super::integrations::BEARER_ENV.into(),
                connection.bearer.expose_secret().into(),
            );
            integration_lifetime = Some(connection.lifetime);
        }
        let args: Vec<OsString> = match self.cli {
            PaneCli::Cursor => {
                let mut args = crate::cursor::interactive_args(
                    config.permission_mode,
                    &cwd,
                    config.model.as_deref(),
                    config.resume_session_id.as_deref(),
                )?;
                if let Some(model) = config.model.as_deref() {
                    let guardian = self
                        .managed_profiles
                        .as_ref()
                        .map(ManagedProfiles::probe_guardian)
                        .transpose()?;
                    let models =
                        crate::cursor::discover_models_guarded(&self.env, guardian.as_ref())?;
                    if !models.iter().any(|available| available.id == model) {
                        return Err(ProviderError::Refused {
                            code: "cursor_model_unavailable".into(),
                            message: format!(
                                "Model unavailable for this Cursor account: {model}. Refresh available models or use /model in the Cursor terminal."
                            ),
                        });
                    }
                }
                if let Some(bridge) = &self.bridge {
                    if !self.config.hook_program.is_absolute()
                        || !self.config.hook_program.is_file()
                    {
                        return Err(ProviderError::Start(
                            "KalCode's Cursor session helper is missing. Reinstall KalCode.".into(),
                        ));
                    }
                    if !kalcode_contracts::ids::is_valid_id(&config.thread_id) {
                        return Err(ProviderError::Start(
                            "Cursor requires a valid KalCode session identity.".into(),
                        ));
                    }
                    let registration = bridge
                        .register_channel(
                            Arc::new(HandlerRef(Arc::downgrade(&shared))),
                            kalcode_hook_bridge::server::HookChannel::Cursor,
                        )
                        .map_err(|error| ProviderError::Start(error.to_string()))?;
                    let plugin_dir = self
                        .config
                        .sessions_dir
                        .join(&config.thread_id)
                        .join("cursor-plugin");
                    super::cursor_hooks::write_plugin(
                        &plugin_dir,
                        &self.config.hook_program,
                        bridge.endpoint().as_str(),
                        registration.session_id(),
                        &self
                            .config
                            .hook_prefix_args
                            .iter()
                            .map(OsString::from)
                            .collect::<Vec<_>>(),
                    )?;
                    args.extend(["--plugin-dir".into(), plugin_dir.into_os_string()]);
                    env.insert(KEY_ENV.into(), registration.key_hex().into());
                    shared.set_registration(registration);
                } else {
                    shared.mark_limited();
                }
                args
            }
            PaneCli::Codex => {
                let bridge = self.bridge.as_ref().ok_or_else(|| {
                    ProviderError::Start("KalCode's hook channel isn't available.".into())
                })?;
                if !self.config.hook_program.is_absolute() || !self.config.hook_program.is_file() {
                    return Err(ProviderError::Start(
                        "KalCode's hook helper is missing, so the pane can't start safely. \
                         Reinstall KalCode."
                            .into(),
                    ));
                }
                let registration = bridge
                    .register_channel(
                        Arc::new(HandlerRef(Arc::downgrade(&shared))),
                        kalcode_hook_bridge::server::HookChannel::Codex,
                    )
                    .map_err(|e| ProviderError::Start(e.to_string()))?;
                let args = codex_args(
                    &CodexArgs {
                        mode: config.permission_mode,
                        workspace: &cwd,
                        model: config.model.as_deref(),
                        effort: config.effort.as_deref(),
                        resume_session_id: config.resume_session_id.as_deref(),
                        hook_program: &self.config.hook_program,
                        hook_prefix_args: &self.config.hook_prefix_args,
                        endpoint: bridge.endpoint().as_str(),
                        session: registration.session_id(),
                    },
                    &codex_overrides,
                )
                .map_err(|e| ProviderError::Start(e.to_string()))?;
                // The notify helper inherits Codex's environment, which holds the session key.
                env.insert(KEY_ENV.into(), registration.key_hex().into());
                shared.set_registration(registration);
                args
            }
            PaneCli::Gemini => {
                shared.mark_limited();
                match gemini_args {
                    Some(args) => args,
                    None => crate::gemini::interactive_args(
                        config.permission_mode,
                        config.model.as_deref(),
                        config.resume_session_id.as_deref(),
                    )
                    .map_err(|e| ProviderError::Start(e.to_string()))?,
                }
            }
        };

        let shared_lease = lease.map(share_profile_lease);
        let guardian_job = shared_lease
            .as_ref()
            .map(|lease| lease.prepare_guarded_job("provider-pane"))
            .transpose()?;
        let exit_lease = shared_lease.clone();
        let weak: Weak<Shared> = Arc::downgrade(&shared);
        let mut argv: Vec<OsString> = launch.prefix_args.clone();
        argv.extend(args);
        let program = ProgramSpec {
            program: launch.program,
            args: argv,
            cwd,
            env: env.into_iter().collect(),
            size: TerminalSize::new(DEFAULT_SIZE.0, DEFAULT_SIZE.1)
                .map_err(|e| ProviderError::Start(e.to_string()))?,
        };
        let on_exit = move |exit: kalcode_pty::ExitInfo| {
            drop(integration_lifetime);
            if let Some(shared) = weak.upgrade() {
                shared.on_exit(exit.code, exit.killed);
            }
            drop(exit_lease);
        };
        let spawn_error = |error: kalcode_pty::PtyError| {
            tracing::warn!(event = "pane.spawn_failed", provider_id = self.cli.id(), error = %error);
            ProviderError::Start(format!(
                "{} couldn't be started in a pane.",
                self.cli.name()
            ))
        };
        let pty = match guardian_job {
            Some(registered) => {
                PtySession::spawn_program_guarded(program, Box::new(registered), on_exit)
                    .map_err(spawn_error)?
            }
            None => PtySession::spawn_program(program, on_exit).map_err(spawn_error)?,
        };
        tracing::info!(event = "pane.started", provider_id = self.cli.id(), thread_id = %config.thread_id, pid = ?pty.pid());

        let _ = shared.pty.set(pty);
        if self.cli == PaneCli::Cursor && self.bridge.is_some() {
            let watchdog = Arc::downgrade(&shared);
            let wait = self.config.limits.hooks_expected_within;
            let _ = std::thread::Builder::new()
                .name("kalcode-cursor-watchdog".into())
                .spawn(move || {
                    std::thread::sleep(wait);
                    if let Some(shared) = watchdog.upgrade() {
                        shared.hooks_overdue();
                    }
                });
        }
        self.panes.insert(&config.thread_id, shared.clone());
        let session: Box<dyn AgentSession> = Box::new(InteractiveSession { shared });
        Ok(match shared_lease {
            Some(lease) => hold_shared_session_lease(session, lease),
            None => session,
        })
    }
}

/// Managed Gemini execution accepts the same certified release line as the headless adapter.
/// Detection runs only against the selected account's sanitized environment.
fn managed_gemini_executable(
    spec: &DetectionSpec,
    env: &DetectEnv,
    guardian: &crate::guardian::ProviderProbeGuardian,
) -> Result<PathBuf, ProviderError> {
    let detected = detect_guarded(spec, env, guardian);
    match (detected.detection.state, detected.executable) {
        (DetectionState::Installed, Some(executable))
            if detected.detection.auth != AuthState::NotAuthenticated =>
        {
            let version = detected
                .detection
                .version
                .as_deref()
                .and_then(Version::parse)
                .ok_or_else(|| {
                    ProviderError::Start(
                        "Gemini CLI did not report a version KalCode can verify".into(),
                    )
                })?;
            crate::gemini::require_managed_version(&version)?;
            Ok(executable)
        }
        (DetectionState::Installed, Some(_)) => Err(ProviderError::NotAuthenticated),
        (DetectionState::NotInstalled, _) => Err(ProviderError::NotInstalled),
        _ => Err(ProviderError::Start(
            detected
                .detection
                .message
                .unwrap_or_else(|| "Gemini CLI couldn't be checked.".into()),
        )),
    }
}

impl AgentProvider for InteractiveCliProvider {
    fn id(&self) -> ProviderId {
        ProviderId::new(self.cli.id())
    }

    fn display_name(&self) -> &str {
        self.cli.name()
    }

    fn detect(&self) -> ProviderDetection {
        match self
            .managed_profiles
            .as_ref()
            .and_then(|profiles| profiles.probe_guardian().ok())
        {
            Some(guardian) => detect_guarded(&self.cli.spec(), &self.env, &guardian).detection,
            None => detect(&self.cli.spec(), &self.env).detection,
        }
    }

    fn capabilities(&self) -> ProviderCapabilities {
        match self.cli {
            PaneCli::Codex => catalog::codex_capabilities(),
            PaneCli::Gemini => catalog::gemini_capabilities(),
            PaneCli::Cursor => crate::cursor::capabilities(),
        }
    }

    fn start_session(
        &self,
        config: SessionConfig,
        sink: Box<dyn AgentEventSink>,
    ) -> Result<Box<dyn AgentSession>, ProviderError> {
        self.start(config, sink)
    }
}
