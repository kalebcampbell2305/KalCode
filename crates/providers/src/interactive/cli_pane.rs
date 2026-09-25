//! Codex and Gemini CLI in a pane (PROVIDERS-2, docs/PROVIDER_PANES.md §3), read-only first.
//!
//! The real, unmodified CLI runs in a Z1 PTY. KalCode never answers these providers' approvals:
//! the person answers in the provider's own prompt.
//!
//! - **Codex**: `codex -C <ws> -s <sandbox> -a on-request … -c notify=[kalcode-hook …]
//!   -c tui.notifications=['approval-requested'] -c tui.notification_method='osc9'`
//!   ([`super::codex::interactive_args`]). Status: `notify` (`agent-turn-complete`, with the
//!   thread id for resume) through the authenticated hook bridge, and OSC 9 escape sequences in
//!   the PTY stream (only approval requests are configured to raise one, so the sequence itself
//!   means "Codex is asking" and its text is never read). Keystrokes after that prompt mean the
//!   person answered it.
//! - **Gemini CLI**: `gemini --approval-mode <mapping> [--model] [--resume]`; process and PTY
//!   state only ("limited status"), because a per-session way to add KalCode's hooks without
//!   writing the user's or the project's settings is unverified.

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError, Weak};

use kalcode_contracts::agent::{
    AgentEventSink, AgentProvider, AgentSession, ProviderCapabilities, ProviderDetection,
    ProviderError, ProviderId, SessionConfig,
};
use kalcode_hook_bridge::KEY_ENV;
use kalcode_hook_bridge::server::BridgeServer;
use kalcode_pty::{ProgramSpec, PtySession, TerminalSize};

use super::codex::{CodexArgs, Osc9Scanner, interactive_args as codex_args};
use super::provider::{InteractiveConfig, PaneRegistry};
use super::session::{HandlerRef, InteractiveSession, PaneProfile, SessionParts, Shared};
use crate::catalog;
use crate::claude::actions::ActionContext;
use crate::claude::argv::working_directory;
use crate::codex::usable_executable;
use crate::detect::{DetectEnv, DetectionSpec, detect};
use crate::launch::{LaunchKind, resolve};

const DEFAULT_SIZE: (u16, u16) = (120, 32);

/// Which CLI a pane runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaneCli {
    Codex,
    Gemini,
}

impl PaneCli {
    fn spec(self) -> DetectionSpec {
        match self {
            Self::Codex => catalog::codex_spec(),
            Self::Gemini => catalog::gemini_spec(),
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::Codex => ProviderId::CODEX,
            Self::Gemini => ProviderId::GEMINI_CLI,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Codex => "Codex",
            Self::Gemini => "Gemini CLI",
        }
    }

    fn profile(self) -> PaneProfile {
        match self {
            Self::Codex => PaneProfile {
                answer_in: "Answer in Codex",
                kalcode_answers: false,
                input_answers_prompt: true,
            },
            Self::Gemini => PaneProfile {
                answer_in: "Answer in Gemini CLI",
                kalcode_answers: false,
                input_answers_prompt: false,
            },
        }
    }
}

/// Codex or Gemini CLI running interactively in a pane.
pub struct InteractiveCliProvider {
    cli: PaneCli,
    env: DetectEnv,
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
            bridge,
            config,
            panes,
        }
    }

    pub fn sessions_dir(&self) -> PathBuf {
        self.config.sessions_dir.clone()
    }

    fn start(
        &self,
        config: SessionConfig,
        sink: Box<dyn AgentEventSink>,
    ) -> Result<InteractiveSession, ProviderError> {
        if config.secret_ref.is_some() {
            return Err(ProviderError::Unsupported);
        }
        let spec = self.cli.spec();
        let executable = usable_executable(&spec, &self.env)?;
        let cwd = working_directory(&config.working_directory)
            .map_err(|e| ProviderError::Start(e.to_string()))?;
        let mut env = self.env.provider_env(&spec.env_policy);
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

        let args: Vec<OsString> = match self.cli {
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
                    .register(Arc::new(HandlerRef(Arc::downgrade(&shared))))
                    .map_err(|e| ProviderError::Start(e.to_string()))?;
                let args = codex_args(&CodexArgs {
                    mode: config.permission_mode,
                    workspace: &cwd,
                    model: config.model.as_deref(),
                    resume_session_id: config.resume_session_id.as_deref(),
                    hook_program: &self.config.hook_program,
                    hook_prefix_args: &self.config.hook_prefix_args,
                    endpoint: bridge.endpoint().as_str(),
                    session: registration.session_id(),
                })
                .map_err(|e| ProviderError::Start(e.to_string()))?;
                // The notify helper inherits Codex's environment, which holds the session key.
                env.insert(KEY_ENV.into(), registration.key_hex().into());
                shared.set_registration(registration);
                args
            }
            PaneCli::Gemini => {
                shared.mark_limited();
                crate::gemini::interactive_args(
                    config.permission_mode,
                    config.model.as_deref(),
                    config.resume_session_id.as_deref(),
                )
                .map_err(|e| ProviderError::Start(e.to_string()))?
            }
        };

        let weak: Weak<Shared> = Arc::downgrade(&shared);
        let mut argv: Vec<OsString> = launch.prefix_args.clone();
        argv.extend(args);
        let pty = PtySession::spawn_program(
            ProgramSpec {
                program: launch.program,
                args: argv,
                cwd,
                env: env.into_iter().collect(),
                size: TerminalSize::new(DEFAULT_SIZE.0, DEFAULT_SIZE.1)
                    .map_err(|e| ProviderError::Start(e.to_string()))?,
            },
            move |exit| {
                if let Some(shared) = weak.upgrade() {
                    shared.on_exit(exit.code, exit.killed);
                }
            },
        )
        .map_err(|e| {
            tracing::warn!(event = "pane.spawn_failed", provider_id = self.cli.id(), error = %e);
            ProviderError::Start(format!(
                "{} couldn't be started in a pane.",
                self.cli.name()
            ))
        })?;
        tracing::info!(event = "pane.started", provider_id = self.cli.id(), thread_id = %config.thread_id, pid = ?pty.pid());

        let _ = shared.pty.set(pty);
        if self.cli == PaneCli::Codex
            && let Some(pty) = shared.pty()
        {
            // OSC 9 scanner on the output stream: structural, bounded, never reads the text.
            // Attaching makes this a listener, so the PTY no longer answers cursor-position
            // requests itself: answer them here while no terminal view is attached (a view
            // answers them otherwise), or the TUI waits forever.
            let scanner = Mutex::new(Osc9Scanner::default());
            let watcher = Arc::downgrade(&shared);
            pty.attach(move |bytes| {
                let Some(shared) = watcher.upgrade() else {
                    return false;
                };
                let requests = bytes.windows(4).filter(|w| *w == b"[6n").count();
                if requests > 0
                    && shared.views.load(std::sync::atomic::Ordering::SeqCst) == 0
                    && let Some(pty) = shared.pty()
                {
                    for _ in 0..requests {
                        let _ = pty.write(b"[1;1R");
                    }
                }
                let found = scanner
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .feed(bytes);
                if found > 0 {
                    shared.provider_prompt();
                }
                true
            });
        }
        self.panes.insert(&config.thread_id, shared.clone());
        Ok(InteractiveSession { shared })
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
        detect(&self.cli.spec(), &self.env).detection
    }

    fn capabilities(&self) -> ProviderCapabilities {
        match self.cli {
            PaneCli::Codex => catalog::codex_capabilities(),
            PaneCli::Gemini => catalog::gemini_capabilities(),
        }
    }

    fn start_session(
        &self,
        config: SessionConfig,
        sink: Box<dyn AgentEventSink>,
    ) -> Result<Box<dyn AgentSession>, ProviderError> {
        Ok(Box::new(self.start(config, sink)?))
    }
}
