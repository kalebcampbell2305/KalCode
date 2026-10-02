//! Starting interactive Claude Code sessions, choosing between the interactive and headless
//! runtime per thread, and the registry pane views attach through.
//!
//! Until `threads.runtime_kind` exists (v12, lead), which runtime a thread uses is decided here:
//! a thread created through [`RuntimeRouter::create_interactive`] is marked interactive by a
//! marker file in its session folder (`<sessions>/<thread>/interactive`), so resuming it later
//! starts a pane again. Every other thread (missions, automations, delegations, handoffs,
//! `thread_create`) stays headless.

use std::cell::Cell;
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError, Weak};
use std::time::Duration;

use kalcode_contracts::agent::{
    AgentEventSink, AgentProvider, AgentSession, AuthState, DetectionState, ProviderCapabilities,
    ProviderDetection, ProviderError, ProviderId, SessionConfig,
};
use kalcode_contracts::ids::is_valid_id;
use kalcode_hook_bridge::KEY_ENV;
use kalcode_hook_bridge::server::BridgeServer;
use kalcode_pty::{AttachId, ProgramSpec, PtySession, TerminalSize};

use super::claude::{HookCommand, InteractiveArgs, interactive_args, settings_json};
use super::session::{
    HandlerRef, InteractiveSession, PaneVoiceWriteError, SessionLimits, SessionParts, Shared,
};
use super::{ApprovalExpiry, DecisionRouting, PaneInfo, TitleSink};
use crate::catalog;
use crate::claude::actions::ActionContext;
use crate::claude::argv::{SessionStart, working_directory};
use crate::detect::{DetectEnv, detect, detect_guarded};
use crate::launch::{LaunchKind, resolve};

/// Default pane size until the view reports its own.
const DEFAULT_SIZE: (u16, u16) = (120, 32);
const MARKER: &str = "interactive";
const SETTINGS_FILE: &str = "claude-settings.json";
/// Panes kept for re-attach after their process exited (scrollback replay).
const MAX_ENDED_PANES: usize = 32;

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// How interactive sessions are launched. Everything here is native-resolved.
#[derive(Clone)]
pub struct InteractiveConfig {
    /// Absolute path of `kalcode-hook` (shipped next to the KalCode executable).
    pub hook_program: PathBuf,
    /// Arguments before `claude <Event> …` (empty for `kalcode-hook`; tests use a stand-in).
    pub hook_prefix_args: Vec<String>,
    /// KalCode's `<data>/sessions` folder: one folder per thread with its settings file.
    pub sessions_dir: PathBuf,
    pub routing: DecisionRouting,
    pub limits: SessionLimits,
}

/// Pane views by thread id.
#[derive(Default)]
pub struct PaneRegistry {
    panes: Mutex<HashMap<String, Arc<Shared>>>,
}

/// Counts the view for exactly its PTY listener lifetime. Registration, accepted
/// replay, and registered-listener removal all run under the PTY delivery lock.
struct RegisteredView {
    shared: Weak<Shared>,
    counted: AtomicBool,
}

impl RegisteredView {
    fn retain(&self, alive: bool) {
        if alive {
            if !self.counted.swap(true, Ordering::SeqCst)
                && let Some(shared) = self.shared.upgrade()
            {
                shared.views.fetch_add(1, Ordering::SeqCst);
            }
        } else {
            self.release();
        }
    }

    fn release(&self) {
        if self.counted.swap(false, Ordering::SeqCst)
            && let Some(shared) = self.shared.upgrade()
        {
            shared.views.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

impl Drop for RegisteredView {
    fn drop(&mut self) {
        self.release();
    }
}

impl PaneRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub(crate) fn insert(&self, thread_id: &str, shared: Arc<Shared>) {
        let mut panes = lock(&self.panes);
        panes.insert(thread_id.to_owned(), shared);
        let ended: Vec<String> = panes
            .iter()
            .filter(|(_, s)| !s.info().running)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ended
            .into_iter()
            .take(panes.len().saturating_sub(MAX_ENDED_PANES))
        {
            panes.remove(&id);
        }
    }

    fn get(&self, thread_id: &str) -> Option<Arc<Shared>> {
        lock(&self.panes).get(thread_id).cloned()
    }

    pub fn info(&self, thread_id: &str) -> Option<PaneInfo> {
        self.get(thread_id).map(|s| s.info())
    }

    /// Replays the pane's scrollback to `listener`, then streams output (Z1 semantics).
    pub fn attach(
        &self,
        thread_id: &str,
        listener: impl Fn(&[u8]) -> bool + Send + Sync + 'static,
    ) -> Option<AttachId> {
        let shared = self.get(thread_id)?;
        let pty = shared.pty()?;
        // A pending attach is not a view yet: the Codex watcher must keep answering
        // cursor requests until this listener accepts replay under the PTY lock.
        let view = RegisteredView {
            shared: Arc::downgrade(&shared),
            counted: AtomicBool::new(false),
        };
        #[cfg(test)]
        view_tests::before_attach();
        Some(pty.attach(move |bytes| {
            let alive = listener(bytes);
            // Release before returning false, including rejected initial replay:
            // that unregistered closure can be dropped after the PTY lock unlocks.
            view.retain(alive);
            alive
        }))
    }

    pub fn detach(&self, thread_id: &str, id: AttachId) -> bool {
        let Some(shared) = self.get(thread_id) else {
            return false;
        };
        let detached = shared.pty().is_some_and(|p| p.detach(id));
        #[cfg(test)]
        view_tests::after_detach();
        detached
    }

    /// The person's keystrokes (or KalVoice dictation, which is typing too).
    pub fn write(&self, thread_id: &str, data: &[u8]) -> Result<(), ProviderError> {
        if data.len() > super::session::MAX_WRITE_BYTES {
            return Err(ProviderError::Io("That input is too large.".into()));
        }
        let shared = self.get(thread_id).ok_or(ProviderError::SessionEnded)?;
        shared.write(data)
    }

    /// Voice input stays in the ordinary pane PTY but holds the registry generation and provider
    /// lifecycle locks through the write. This prevents a replacement session or native prompt
    /// transition from receiving a trusted Enter.
    pub fn write_voice(
        &self,
        thread_id: &str,
        instance_id: &str,
        data: &[u8],
    ) -> Result<(), PaneVoiceWriteError> {
        if data.len() > super::session::MAX_WRITE_BYTES {
            return Err(PaneVoiceWriteError::Io);
        }
        let panes = lock(&self.panes);
        let shared = panes
            .get(thread_id)
            .ok_or(PaneVoiceWriteError::SessionEnded)?;
        if shared.instance_id() != instance_id {
            return Err(PaneVoiceWriteError::TargetChanged);
        }
        shared.write_voice(data)
    }

    pub fn resize(&self, thread_id: &str, cols: u16, rows: u16) -> Result<(), ProviderError> {
        let size = TerminalSize::new(cols, rows)
            .map_err(|_| ProviderError::Io("That pane size is out of range.".into()))?;
        let shared = self.get(thread_id).ok_or(ProviderError::SessionEnded)?;
        let pty = shared.pty().ok_or(ProviderError::SessionEnded)?;
        pty.resize(size)
            .map_err(|e| ProviderError::Io(e.to_string()))
    }

    pub fn contains(&self, thread_id: &str) -> bool {
        lock(&self.panes).contains_key(thread_id)
    }
}

#[cfg(test)]
#[path = "provider_view_tests.rs"]
mod view_tests;

/// Claude Code running interactively in a pane.
pub struct InteractiveClaudeProvider {
    env: DetectEnv,
    managed: Option<crate::managed::ManagedProfiles>,
    bridge: Arc<BridgeServer>,
    config: InteractiveConfig,
    panes: Arc<PaneRegistry>,
    expiry: Option<Arc<dyn ApprovalExpiry>>,
    titles: Option<Arc<dyn TitleSink>>,
}

impl InteractiveClaudeProvider {
    pub fn new(
        env: DetectEnv,
        bridge: Arc<BridgeServer>,
        config: InteractiveConfig,
        panes: Arc<PaneRegistry>,
    ) -> Self {
        Self {
            env,
            managed: None,
            bridge,
            config,
            panes,
            expiry: None,
            titles: None,
        }
    }

    pub fn with_managed_profiles(mut self, profiles: crate::managed::ManagedProfiles) -> Self {
        self.managed = Some(profiles);
        self
    }

    pub fn with_expiry(mut self, expiry: Arc<dyn ApprovalExpiry>) -> Self {
        self.expiry = Some(expiry);
        self
    }

    pub fn with_titles(mut self, titles: Arc<dyn TitleSink>) -> Self {
        self.titles = Some(titles);
        self
    }

    pub fn routing(&self) -> DecisionRouting {
        self.config.routing
    }

    fn session_dir(&self, thread_id: &str) -> Result<PathBuf, ProviderError> {
        if !is_valid_id(thread_id) {
            return Err(ProviderError::Start("The thread id is not valid.".into()));
        }
        Ok(self.config.sessions_dir.join(thread_id))
    }

    fn executable(
        &self,
        require_managed_version: bool,
        probe_guardian: Option<&crate::guardian::ProviderProbeGuardian>,
    ) -> Result<PathBuf, ProviderError> {
        let spec = catalog::claude_spec();
        let detected = match probe_guardian {
            Some(guardian) => detect_guarded(&spec, &self.env, guardian),
            None => detect(&spec, &self.env),
        };
        match (detected.detection.state, detected.executable) {
            (DetectionState::Installed, Some(exe))
                if detected.detection.auth != AuthState::NotAuthenticated =>
            {
                if require_managed_version {
                    crate::claude::require_managed_version(detected.detection.version.as_deref())?;
                }
                Ok(exe)
            }
            (DetectionState::Installed, Some(_)) => Err(ProviderError::NotAuthenticated),
            (DetectionState::NotInstalled, _) => Err(ProviderError::NotInstalled),
            _ => Err(ProviderError::Start(
                detected
                    .detection
                    .message
                    .unwrap_or_else(|| "Claude Code couldn't be checked.".into()),
            )),
        }
    }

    fn start(
        &self,
        config: SessionConfig,
        sink: Box<dyn AgentEventSink>,
        require_managed_version: bool,
        guardian_job: Option<crate::guardian::RegisteredJob>,
        probe_guardian: Option<crate::guardian::ProviderProbeGuardian>,
    ) -> Result<InteractiveSession, ProviderError> {
        if config.secret_ref.is_some() {
            return Err(ProviderError::Unsupported);
        }
        if !self.config.hook_program.is_absolute() || !self.config.hook_program.is_file() {
            tracing::error!(event = "pane.hook_helper_missing");
            return Err(ProviderError::Start(
                "KalCode's hook helper is missing, so the pane can't start safely. Reinstall \
                 KalCode."
                    .into(),
            ));
        }
        let executable = self.executable(require_managed_version, probe_guardian.as_ref())?;
        let cwd = working_directory(&config.working_directory)
            .map_err(|e| ProviderError::Start(e.to_string()))?;
        let dir = self.session_dir(&config.thread_id)?;
        std::fs::create_dir_all(&dir).map_err(|e| {
            tracing::warn!(event = "pane.session_dir_failed", error = %e);
            ProviderError::Start("KalCode couldn't prepare the session folder.".into())
        })?;

        let mut env = self.env.provider_env(&catalog::claude_spec().env_policy);
        for (name, value) in [
            ("TERM", "xterm-256color"),
            ("COLORTERM", "truecolor"),
            ("TERM_PROGRAM", "KalCode"),
        ] {
            env.insert(name.into(), value.into());
        }
        let launch = resolve(&executable, &env);
        if launch.kind == LaunchKind::ShimUnresolved {
            // Only a program KalCode resolved may run in a pane (no cmd.exe interpretation).
            return Err(ProviderError::Start(
                "KalCode couldn't resolve how to start Claude Code safely.".into(),
            ));
        }
        #[cfg(unix)]
        crate::launch::apply_launch_env(&launch, &mut env);

        let start = match config.resume_session_id.clone() {
            Some(session_id) => SessionStart::Resume { session_id },
            None => SessionStart::New {
                session_id: uuid::Uuid::new_v4().to_string(),
            },
        };
        let provider_session_id = match &start {
            SessionStart::New { session_id } | SessionStart::Resume { session_id } => {
                session_id.clone()
            }
        };
        let shared = Shared::new(SessionParts {
            ctx: ActionContext {
                thread_id: config.thread_id.clone(),
                workspace_id: config.workspace_id.clone(),
                working_directory: config.working_directory.clone(),
            },
            provider_id: ProviderId::CLAUDE_CODE.into(),
            routing: self.config.routing,
            sink,
            provider_session_id,
            limits: self.config.limits,
            expiry: self.expiry.clone(),
            titles: self.titles.clone(),
        });
        let registration = self
            .bridge
            .register_channel(
                Arc::new(HandlerRef(Arc::downgrade(&shared))),
                kalcode_hook_bridge::server::HookChannel::Claude,
            )
            .map_err(|e| ProviderError::Start(e.to_string()))?;
        let settings_path = dir.join(SETTINGS_FILE);
        let settings = settings_json(&HookCommand {
            program: &self.config.hook_program,
            prefix_args: &self.config.hook_prefix_args,
            endpoint: self.bridge.endpoint().as_str(),
            session: registration.session_id(),
        });
        write_atomically(&settings_path, settings.to_string().as_bytes()).map_err(|e| {
            tracing::warn!(event = "pane.settings_write_failed", error = %e);
            ProviderError::Start("KalCode couldn't write the session settings.".into())
        })?;
        let args = interactive_args(&InteractiveArgs {
            mode: config.permission_mode,
            start,
            settings_path: &settings_path,
            model: config.model.as_deref(),
            effort: config.effort.as_deref(),
            title: None,
        })
        .map_err(|e| ProviderError::Start(e.to_string()))?;
        env.insert(KEY_ENV.into(), registration.key_hex().into());
        shared.set_registration(registration);

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
            if let Some(shared) = weak.upgrade() {
                shared.on_exit(exit.code, exit.killed);
            }
        };
        let pty = match guardian_job {
            Some(registered) => {
                PtySession::spawn_program_guarded(program, Box::new(registered), on_exit).map_err(
                    |e| {
                        tracing::warn!(event = "pane.spawn_failed", error = %e);
                        ProviderError::Start("Claude Code couldn't be started in a pane.".into())
                    },
                )?
            }
            None => PtySession::spawn_program(program, on_exit).map_err(|e| {
                tracing::warn!(event = "pane.spawn_failed", error = %e);
                ProviderError::Start("Claude Code couldn't be started in a pane.".into())
            })?,
        };
        tracing::info!(event = "pane.started", thread_id = %config.thread_id, pid = ?pty.pid());
        let _ = shared.pty.set(pty);

        let watchdog = Arc::downgrade(&shared);
        let wait = self.config.limits.hooks_expected_within;
        let _ = std::thread::Builder::new()
            .name("kalcode-pane-watchdog".into())
            .spawn(move || {
                std::thread::sleep(wait);
                if let Some(shared) = watchdog.upgrade() {
                    shared.hooks_overdue();
                }
            });
        self.panes.insert(&config.thread_id, shared.clone());
        Ok(InteractiveSession { shared })
    }
}

fn marker_path(sessions_dir: &Path, thread_id: &str) -> Option<PathBuf> {
    is_valid_id(thread_id).then(|| sessions_dir.join(thread_id).join(MARKER))
}

/// Whether `thread_id` was created as a pane (it starts and resumes in one), also after a
/// restart, when its process is gone. `sessions_dir` is KalCode's `<data>/sessions`.
pub fn marked_interactive(sessions_dir: &Path, thread_id: &str) -> bool {
    marked_interactive_checked(sessions_dir, thread_id).unwrap_or(false)
}

/// Fallible form used by authority preflights that must never collapse marker I/O or object-type
/// failures into a false (headless) classification.
pub fn marked_interactive_checked(sessions_dir: &Path, thread_id: &str) -> std::io::Result<bool> {
    let marker = marker_path(sessions_dir, thread_id).ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid thread identity")
    })?;
    match std::fs::symlink_metadata(marker) {
        Ok(metadata) if metadata.file_type().is_file() => Ok(true),
        Ok(_) => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "interactive marker is not a regular file",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn write_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, bytes)?;
    std::fs::rename(&temp, path)
}

impl AgentProvider for InteractiveClaudeProvider {
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
        let mut capabilities = catalog::claude_capabilities();
        capabilities.interactive = Some(super::claude::interactive_support(self.config.routing));
        capabilities
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
            let guardian_job = lease.prepare_guarded_job("claude-pane")?;
            let probe_guardian = profiles.probe_guardian()?;
            let env = profiles.prepare_env(ProviderId::CLAUDE_CODE, account, &self.env)?;
            let provider = Self {
                env,
                managed: None,
                bridge: self.bridge.clone(),
                config: self.config.clone(),
                panes: self.panes.clone(),
                expiry: self.expiry.clone(),
                titles: self.titles.clone(),
            };
            let mut isolated_config = config;
            isolated_config.provider_account_id = None;
            let session = Box::new(provider.start(
                isolated_config,
                sink,
                true,
                Some(guardian_job),
                Some(probe_guardian),
            )?);
            return Ok(crate::managed::hold_session_lease(session, lease));
        }
        if config.provider_account_id.is_some() {
            return Err(ProviderError::Start(
                "A managed provider profile is required for this account.".into(),
            ));
        }
        Ok(Box::new(self.start(config, sink, false, None, None)?))
    }
}

thread_local! {
    /// Set by [`RuntimeRouter::create_interactive`] for the duration of one thread creation on
    /// the calling OS thread; consumed by the session start that creation performs.
    static ARMED: Cell<bool> = const { Cell::new(false) };
}

struct Disarm;

impl Drop for Disarm {
    fn drop(&mut self) {
        ARMED.with(|armed| armed.set(false));
    }
}

/// One `AgentProvider` for Claude Code that starts each thread in the runtime it belongs to:
/// interactive (a pane) or headless (stream-JSON).
pub struct RuntimeRouter {
    headless: Arc<dyn AgentProvider>,
    interactive: Arc<dyn AgentProvider>,
    sessions_dir: PathBuf,
}

impl RuntimeRouter {
    pub fn new(
        headless: Arc<dyn AgentProvider>,
        interactive: Arc<InteractiveClaudeProvider>,
    ) -> Self {
        let sessions_dir = interactive.config.sessions_dir.clone();
        Self {
            headless,
            interactive,
            sessions_dir,
        }
    }

    /// The same router for any interactive provider (Codex and Gemini CLI panes).
    pub fn for_provider(
        headless: Arc<dyn AgentProvider>,
        interactive: Arc<dyn AgentProvider>,
        sessions_dir: PathBuf,
    ) -> Self {
        Self {
            headless,
            interactive,
            sessions_dir,
        }
    }

    /// Runs `create` (a thread-runtime create call on this OS thread) so that the session it
    /// starts is interactive, and the thread stays interactive when resumed.
    pub fn create_interactive<R>(create: impl FnOnce() -> R) -> R {
        ARMED.with(|armed| armed.set(true));
        let _disarm = Disarm;
        create()
    }

    fn marker(&self, thread_id: &str) -> Option<PathBuf> {
        marker_path(&self.sessions_dir, thread_id)
    }

    /// Whether a thread runs in a pane.
    pub fn is_interactive(&self, thread_id: &str) -> bool {
        marked_interactive(&self.sessions_dir, thread_id)
    }

    fn mark(&self, thread_id: &str) -> Result<(), ProviderError> {
        let marker = self
            .marker(thread_id)
            .ok_or_else(|| ProviderError::Start("The thread id is not valid.".into()))?;
        if let Some(dir) = marker.parent() {
            std::fs::create_dir_all(dir).map_err(|_| {
                ProviderError::Start("KalCode couldn't prepare the session.".into())
            })?;
        }
        std::fs::write(&marker, b"")
            .map_err(|_| ProviderError::Start("KalCode couldn't prepare the session.".into()))
    }
}

impl AgentProvider for RuntimeRouter {
    fn id(&self) -> ProviderId {
        self.headless.id()
    }

    fn display_name(&self) -> &str {
        self.headless.display_name()
    }

    fn detect(&self) -> ProviderDetection {
        self.headless.detect()
    }

    fn capabilities(&self) -> ProviderCapabilities {
        let mut capabilities = self.headless.capabilities();
        capabilities.interactive = self.interactive.capabilities().interactive;
        capabilities
    }

    fn start_session(
        &self,
        config: SessionConfig,
        sink: Box<dyn AgentEventSink>,
    ) -> Result<Box<dyn AgentSession>, ProviderError> {
        let armed = ARMED.with(|armed| armed.replace(false));
        if armed {
            self.mark(&config.thread_id)?;
        }
        if armed || self.is_interactive(&config.thread_id) {
            self.interactive.start_session(config, sink)
        } else {
            self.headless.start_session(config, sink)
        }
    }
}

/// Lets tests wait for a pane to exist.
pub fn wait_for_pane(panes: &PaneRegistry, thread_id: &str, timeout: Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if panes.contains(thread_id) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panes.contains(thread_id)
}
