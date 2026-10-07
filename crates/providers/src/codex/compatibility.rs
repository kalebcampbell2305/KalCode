//! Bounded Codex CLI capability and managed-profile protocol negotiation.
//!
//! Provider releases are classified with SemVer, then accepted by the behavior KalCode actually
//! needs. A previously unseen stable minor is therefore ordinary; removal of a required command,
//! flag, or isolated app-server protocol behavior is a real incompatibility. Probe results are
//! cached by executable identity and launcher environment facts, so replacing the binary
//! invalidates the result without disturbing processes that are already running. Every protocol
//! smoke test uses a disposable `CODEX_HOME`; account credentials and user configuration are never
//! part of a cached probe.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime};

use kalcode_contracts::agent::ProviderError;
use serde_json::{Value, json};

use crate::guardian::{ProviderProbeGuardian, RegisteredJob};
use crate::process::{OutputLine, ProcessSpec, SupervisedChild, recv_until};
use crate::version::Version;

mod config_schema;

const HELP_TIMEOUT: Duration = Duration::from_secs(5);
const PROTOCOL_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_HELP_BYTES: usize = 128 * 1024;
const MAX_PROTOCOL_LINE_BYTES: usize = 256 * 1024;
const MAX_IGNORED_MESSAGES: usize = 16;
const MAX_CACHE_ENTRIES: usize = 64;
pub const REQUIRED_CAPABILITIES: &[&str] = &[
    "managed_profiles",
    "interactive",
    "sessions",
    "resume",
    "model_selection",
    "skip_git_repo_check",
    "reasoning_effort",
    "app_server",
    "config_override",
    #[cfg(windows)]
    "no_daemon",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexReleaseChannel {
    Stable,
    Alpha,
    Beta,
    ReleaseCandidate,
    Prerelease,
}

impl CodexReleaseChannel {
    fn from_version(version: &Version) -> Self {
        let Some(pre) = version.prerelease() else {
            return Self::Stable;
        };
        match pre
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str()
        {
            "alpha" => Self::Alpha,
            "beta" => Self::Beta,
            "rc" => Self::ReleaseCandidate,
            _ => Self::Prerelease,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CapabilitySupport {
    Supported,
    Unsupported,
    /// The CLI offers no side-effect-free way to prove this capability before a real session.
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexCompatibility {
    Compatible,
    Experimental,
    Incompatible,
}

/// Capabilities observed from the installed binary and isolated managed-profile probes. Reasoning
/// effort here proves the CLI config syntax and accepted value shape; a model catalog remains the
/// authority for model-specific availability. Nothing is inferred from a version number.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexCapabilities {
    pub version: Version,
    pub channel: CodexReleaseChannel,
    pub managed_profiles: bool,
    pub interactive: CapabilitySupport,
    pub sessions: CapabilitySupport,
    pub resume: CapabilitySupport,
    pub model_selection: CapabilitySupport,
    pub skip_git_repo_check: CapabilitySupport,
    pub reasoning_effort: CapabilitySupport,
    /// KalCode effort names accepted by the CLI's generated
    /// `Config.model_reasoning_effort` schema. For an open string schema this is a diagnostic
    /// sample; [`Self::supports_reasoning_effort`] evaluates the retained constraint directly.
    pub reasoning_effort_values: BTreeSet<String>,
    reasoning_effort_schema: Option<config_schema::ReasoningEffortSchema>,
    pub mcp: CapabilitySupport,
    pub tools: CapabilitySupport,
    pub structured_output: CapabilitySupport,
    pub app_server: CapabilitySupport,
    pub no_daemon: CapabilitySupport,
    pub config_override: CapabilitySupport,
    pub missing_required: Vec<&'static str>,
}

impl CodexCapabilities {
    pub fn supports_reasoning_effort(&self, effort: &str) -> bool {
        self.reasoning_effort_schema
            .as_ref()
            .is_some_and(|schema| schema.supports(effort))
    }

    #[cfg(test)]
    pub(crate) fn test_fixture_with_reasoning_efforts(efforts: &[&str]) -> Self {
        let reasoning_effort_schema =
            config_schema::ReasoningEffortSchema::closed_for_test(efforts);
        Self {
            version: Version::parse("0.161.0").expect("test version"),
            channel: CodexReleaseChannel::Stable,
            managed_profiles: true,
            interactive: CapabilitySupport::Supported,
            sessions: CapabilitySupport::Supported,
            resume: CapabilitySupport::Supported,
            model_selection: CapabilitySupport::Supported,
            skip_git_repo_check: CapabilitySupport::Supported,
            reasoning_effort: CapabilitySupport::Supported,
            reasoning_effort_values: reasoning_effort_schema.sampled_values().clone(),
            reasoning_effort_schema: Some(reasoning_effort_schema),
            mcp: CapabilitySupport::Supported,
            tools: CapabilitySupport::Supported,
            structured_output: CapabilitySupport::Supported,
            app_server: CapabilitySupport::Supported,
            no_daemon: CapabilitySupport::Supported,
            config_override: CapabilitySupport::Supported,
            missing_required: Vec::new(),
        }
    }

    pub fn compatibility(&self) -> CodexCompatibility {
        if !self.managed_profiles {
            CodexCompatibility::Incompatible
        } else if self.channel == CodexReleaseChannel::Stable {
            CodexCompatibility::Compatible
        } else {
            CodexCompatibility::Experimental
        }
    }

    /// Provider-neutral facts for the signed compatibility policy. No protocol version is
    /// invented: current app-server initialize responses do not advertise one, so a remote rule
    /// that requires a protocol version safely reports the fact as missing.
    pub fn probe_facts(&self) -> crate::compatibility::ProbeFacts {
        let mut capabilities = BTreeSet::new();
        if self.managed_profiles {
            capabilities.insert("managed_profiles".into());
        }
        let mut add = |name: &str, support: CapabilitySupport| {
            if support == CapabilitySupport::Supported {
                capabilities.insert(name.to_owned());
            }
        };
        add("interactive", self.interactive);
        add("sessions", self.sessions);
        add("resume", self.resume);
        add("model_selection", self.model_selection);
        add("skip_git_repo_check", self.skip_git_repo_check);
        add("reasoning_effort", self.reasoning_effort);
        add("mcp", self.mcp);
        add("tools", self.tools);
        add("structured_output", self.structured_output);
        add("app_server", self.app_server);
        add("no_daemon", self.no_daemon);
        add("config_override", self.config_override);
        crate::compatibility::ProbeFacts {
            capabilities,
            protocols: BTreeMap::new(),
        }
    }

    /// Applies disable-only signed policy output. Required capabilities fail closed; optional
    /// capabilities become Unsupported and can drive adapter fallbacks without pretending support.
    pub fn with_effective_capabilities(
        &self,
        effective: &BTreeSet<String>,
    ) -> Result<Self, ProviderError> {
        let missing = REQUIRED_CAPABILITIES
            .iter()
            .copied()
            .filter(|capability| !effective.contains(*capability))
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            return Err(ProviderError::Refused {
                code: "provider_capability_incompatible".into(),
                message: format!(
                    "Codex compatibility policy disabled required capabilities: {}.",
                    missing.join(", ")
                ),
            });
        }
        let filtered = |name: &str, current: CapabilitySupport| {
            if current == CapabilitySupport::Supported && !effective.contains(name) {
                CapabilitySupport::Unsupported
            } else {
                current
            }
        };
        let mut result = self.clone();
        result.interactive = filtered("interactive", result.interactive);
        result.sessions = filtered("sessions", result.sessions);
        result.resume = filtered("resume", result.resume);
        result.model_selection = filtered("model_selection", result.model_selection);
        result.skip_git_repo_check = filtered("skip_git_repo_check", result.skip_git_repo_check);
        result.reasoning_effort = filtered("reasoning_effort", result.reasoning_effort);
        if result.reasoning_effort != CapabilitySupport::Supported {
            result.reasoning_effort_values.clear();
            result.reasoning_effort_schema = None;
        }
        result.mcp = filtered("mcp", result.mcp);
        result.tools = filtered("tools", result.tools);
        result.structured_output = filtered("structured_output", result.structured_output);
        result.app_server = filtered("app_server", result.app_server);
        result.no_daemon = filtered("no_daemon", result.no_daemon);
        result.config_override = filtered("config_override", result.config_override);
        Ok(result)
    }
}

fn supported(value: bool) -> CapabilitySupport {
    if value {
        CapabilitySupport::Supported
    } else {
        CapabilitySupport::Unsupported
    }
}

fn has_command(help: &str, command: &str) -> bool {
    help.lines().any(|line| {
        line.trim_start()
            .strip_prefix(command)
            .is_some_and(|rest| rest.starts_with(char::is_whitespace))
    })
}

fn has_option(help: &str, option: &str) -> bool {
    help.split_ascii_whitespace().any(|word| {
        word.trim_matches(|character: char| {
            character == ',' || character == '[' || character == ']'
        }) == option
    })
}

fn capabilities_from_help(
    version: Version,
    root_help: &str,
    exec_help: &str,
    resume_help: &str,
    interactive_resume_help: &str,
    app_server_help: &str,
    reasoning_effort_schema: Option<config_schema::ReasoningEffortSchema>,
) -> CodexCapabilities {
    // `ReasoningEffortSchema::read` returns `Some` only for a bounded, structurally understood,
    // nonempty string contract. The provider owns that contract: removing a historical KalCode
    // token is not removal of reasoning support, and selection admission below still checks the
    // exact retained schema before launch.
    let reasoning_effort_available = reasoning_effort_schema.is_some();
    let reasoning_effort_values = reasoning_effort_schema
        .as_ref()
        .map(|schema| schema.sampled_values().clone())
        .unwrap_or_default();
    let exec = has_command(root_help, "exec");
    let headless_resume = has_command(exec_help, "resume")
        && resume_help.contains("codex exec resume")
        && resume_help.contains("[SESSION_ID]")
        && has_option(resume_help, "--json");
    let interactive_resume = has_command(root_help, "resume")
        && interactive_resume_help.contains("codex resume")
        && interactive_resume_help.contains("[SESSION_ID]");
    let resume = headless_resume && interactive_resume;
    let config_override = has_option(root_help, "-c") && has_option(exec_help, "-c");
    // KalCode starts the default stdio app-server and proves its real initialize/account protocol
    // below. Optional transport flags in help are not part of the launch contract.
    let app_server =
        has_command(root_help, "app-server") && app_server_help.contains("codex app-server");
    let exec_json = has_option(exec_help, "--json");
    let headless_sandbox = has_option(exec_help, "--sandbox");
    let interactive_cwd = has_option(root_help, "-C");
    let interactive_sandbox = has_option(root_help, "-s");
    let interactive_approval = has_option(root_help, "-a");
    let interactive_model = has_option(root_help, "-m");
    let headless_model = has_option(exec_help, "--model");
    let skip_git_repo_check = has_option(exec_help, "--skip-git-repo-check");
    let no_daemon = has_option(root_help, "--no-daemon");
    let mut missing_required = Vec::new();
    for (present, name) in [
        (exec, "exec"),
        (resume, "exec resume"),
        (interactive_resume, "interactive resume"),
        (config_override, "config override"),
        (app_server, "app-server"),
        (exec_json, "exec JSON output"),
        (headless_sandbox, "headless sandbox selection"),
        (interactive_cwd, "interactive working directory"),
        (interactive_sandbox, "interactive sandbox selection"),
        (interactive_approval, "interactive approval policy"),
        (interactive_model, "interactive model selection"),
        (headless_model, "headless model selection"),
        (skip_git_repo_check, "headless non-Git workspace support"),
        (reasoning_effort_available, "reasoning effort configuration"),
        #[cfg(windows)]
        (no_daemon, "no-daemon"),
    ] {
        if !present {
            missing_required.push(name);
        }
    }
    CodexCapabilities {
        channel: CodexReleaseChannel::from_version(&version),
        version,
        managed_profiles: missing_required.is_empty(),
        interactive: supported(
            (!cfg!(windows) || no_daemon)
                && interactive_resume
                && interactive_cwd
                && interactive_sandbox
                && interactive_approval,
        ),
        sessions: supported(exec && exec_json && headless_sandbox),
        resume: supported(resume),
        model_selection: supported(interactive_model && headless_model),
        skip_git_repo_check: supported(skip_git_repo_check),
        reasoning_effort: supported(reasoning_effort_available),
        reasoning_effort_values,
        reasoning_effort_schema,
        mcp: supported(has_command(root_help, "mcp")),
        // Tool availability is account, model, config, and workspace dependent.
        tools: CapabilitySupport::Unknown,
        structured_output: supported(has_option(exec_help, "--output-schema")),
        app_server: supported(app_server),
        no_daemon: supported(no_daemon),
        config_override: supported(config_override),
        missing_required,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct BinaryStamp {
    path: PathBuf,
    installation: crate::managed_runtime::InstallationFingerprint,
    len: u64,
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
    /// Launcher-affecting environment only. Account selectors and credentials are intentionally
    /// excluded: account_auth verifies the exact app-server home again for each connection.
    runtime_env: Vec<(OsString, OsString)>,
}

impl BinaryStamp {
    fn of(executable: &Path, env: &BTreeMap<OsString, OsString>) -> Option<Self> {
        let path = std::fs::canonicalize(executable).ok()?;
        let metadata = std::fs::metadata(&path)
            .ok()
            .filter(|metadata| metadata.is_file())?;
        Some(Self {
            path,
            installation: crate::managed_runtime::installation_fingerprint(executable, env)?,
            len: metadata.len(),
            modified: metadata.modified().ok(),
            created: metadata.created().ok(),
            runtime_env: env
                .iter()
                .filter(|(name, _)| {
                    [
                        "PATH",
                        "PATHEXT",
                        "SYSTEMROOT",
                        "COMSPEC",
                        "HOME",
                        "USERPROFILE",
                        "CODEX_MANAGED_PACKAGE_ROOT",
                        "CODEX_MANAGED_BY_NPM",
                        "CODEX_MANAGED_BY_PNPM",
                        "CODEX_MANAGED_BY_BUN",
                        "CODEX_MANAGED_BY_VITE_PLUS",
                    ]
                    .iter()
                    .any(|wanted| name.eq_ignore_ascii_case(wanted))
                })
                .map(|(name, value)| (name.clone(), value.clone()))
                .collect(),
        })
    }
}

enum CacheSlot {
    Ready(Arc<CodexCapabilities>),
    Probing(Arc<ProbeFlight>),
}

struct ProbeFlight {
    outcome: Mutex<Option<Result<(), ProviderError>>>,
    done: Condvar,
}

impl Default for ProbeFlight {
    fn default() -> Self {
        Self {
            outcome: Mutex::new(None),
            done: Condvar::new(),
        }
    }
}

impl ProbeFlight {
    fn finish(&self, outcome: Result<(), ProviderError>) {
        *lock(&self.outcome) = Some(outcome);
        self.done.notify_all();
    }

    fn wait(&self, canceled: Option<&dyn Fn() -> bool>) -> Result<(), ProviderError> {
        let mut outcome = lock(&self.outcome);
        loop {
            if let Some(outcome) = outcome.as_ref() {
                return outcome.clone();
            }
            if canceled.is_some_and(|canceled| canceled()) {
                return Err(canceled_error());
            }
            let (next, _) = self
                .done
                .wait_timeout(outcome, Duration::from_millis(25))
                .unwrap_or_else(PoisonError::into_inner);
            outcome = next;
        }
    }
}

#[derive(Default)]
struct CapabilityCache {
    slots: Mutex<HashMap<BinaryStamp, CacheSlot>>,
}

static CACHE: LazyLock<CapabilityCache> = LazyLock::new(CapabilityCache::default);

struct ProbeLeader {
    stamp: BinaryStamp,
    flight: Arc<ProbeFlight>,
    finished: bool,
}

impl ProbeLeader {
    fn finish(
        mut self,
        capabilities: Option<Arc<CodexCapabilities>>,
        outcome: Result<(), ProviderError>,
    ) {
        let mut slots = lock(&CACHE.slots);
        if slots.get(&self.stamp).is_some_and(
            |slot| matches!(slot, CacheSlot::Probing(flight) if Arc::ptr_eq(flight, &self.flight)),
        ) {
            match capabilities {
                Some(capabilities) => {
                    slots.insert(self.stamp.clone(), CacheSlot::Ready(capabilities));
                }
                None => {
                    slots.remove(&self.stamp);
                }
            }
        }
        self.finished = true;
        drop(slots);
        self.flight.finish(outcome);
    }
}

impl Drop for ProbeLeader {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        let mut slots = lock(&CACHE.slots);
        if slots.get(&self.stamp).is_some_and(
            |slot| matches!(slot, CacheSlot::Probing(flight) if Arc::ptr_eq(flight, &self.flight)),
        ) {
            slots.remove(&self.stamp);
        }
        drop(slots);
        self.flight.finish(Err(ProviderError::Start(
            "Codex compatibility probe ended before it completed".into(),
        )));
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn env_value<'a>(env: &'a BTreeMap<OsString, OsString>, name: &str) -> Option<&'a OsStr> {
    env.iter()
        .find(|(candidate, _)| candidate.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_os_str())
}

/// Negotiates capabilities through guardian-controlled, read-only processes. Unknown future
/// stable versions are accepted when their observed behavior still satisfies the contract.
pub fn probe_guarded(
    executable: &Path,
    env: &BTreeMap<OsString, OsString>,
    neutral_cwd: &Path,
    guardian: &ProviderProbeGuardian,
) -> Result<Arc<CodexCapabilities>, ProviderError> {
    probe_with_admission(
        executable,
        env,
        neutral_cwd,
        |label| {
            guardian
                .prepare_job(label)
                .map_err(|error| ProviderError::Start(error.to_string()))
        },
        None,
    )
}

/// Negotiates capabilities while the caller owns the exact managed-profile lease. The job
/// factory is called once per child process, preserving guardian ownership for every probe.
pub fn probe_with_admission(
    executable: &Path,
    env: &BTreeMap<OsString, OsString>,
    neutral_cwd: &Path,
    mut prepare_job: impl FnMut(&str) -> Result<RegisteredJob, ProviderError>,
    canceled: Option<&dyn Fn() -> bool>,
) -> Result<Arc<CodexCapabilities>, ProviderError> {
    if canceled.is_some_and(|canceled| canceled()) {
        return Err(canceled_error());
    }
    let stamp = BinaryStamp::of(executable, env).ok_or(ProviderError::NotInstalled)?;
    let leader = loop {
        let mut slots = lock(&CACHE.slots);
        match slots.get(&stamp) {
            Some(CacheSlot::Ready(capabilities)) => {
                return Ok(Arc::clone(capabilities));
            }
            Some(CacheSlot::Probing(flight)) => {
                let flight = Arc::clone(flight);
                drop(slots);
                flight.wait(canceled)?;
            }
            None => {
                let flight = Arc::new(ProbeFlight::default());
                slots.insert(stamp.clone(), CacheSlot::Probing(Arc::clone(&flight)));
                break ProbeLeader {
                    stamp: stamp.clone(),
                    flight,
                    finished: false,
                };
            }
        }
    };
    let workspace = SmokeWorkspace::create(neutral_cwd)?;
    let probe_env = workspace.isolated_env(env);

    let result = (|| {
        let version_output = run_probe(
            executable,
            &probe_env,
            &workspace.cwd,
            &["--version"],
            "codex-compat-version",
            &mut prepare_job,
            canceled,
        )?;
        let version = Version::find_in(&version_output).ok_or_else(|| {
            ProviderError::Start("Codex did not report a valid semantic version".into())
        })?;
        if version < crate::codex::argv::MINIMUM_VERSION {
            return Err(ProviderError::Refused {
                code: "provider_capability_incompatible".into(),
                message: format!(
                    "Codex {version} lacks platform runtime fixes required by this KalCode build; \
                 version {} or later is required.",
                    crate::codex::argv::MINIMUM_VERSION
                ),
            });
        }

        let (
            root_help,
            exec_help,
            resume_help,
            interactive_resume_help,
            app_server_help,
            reasoning_effort_schema,
        ) = if canceled.is_none() {
            run_help_probes_parallel(
                executable,
                &probe_env,
                &workspace.cwd,
                &workspace.schema,
                &mut prepare_job,
            )?
        } else {
            (
                run_probe(
                    executable,
                    &probe_env,
                    &workspace.cwd,
                    &["--help"],
                    "codex-compat-root-help",
                    &mut prepare_job,
                    canceled,
                )?,
                run_probe(
                    executable,
                    &probe_env,
                    &workspace.cwd,
                    &["exec", "--help"],
                    "codex-compat-exec-help",
                    &mut prepare_job,
                    canceled,
                )?,
                run_probe(
                    executable,
                    &probe_env,
                    &workspace.cwd,
                    &["exec", "resume", "--help"],
                    "codex-compat-resume-help",
                    &mut prepare_job,
                    canceled,
                )?,
                run_probe(
                    executable,
                    &probe_env,
                    &workspace.cwd,
                    &["resume", "--help"],
                    "codex-compat-interactive-resume-help",
                    &mut prepare_job,
                    canceled,
                )?,
                run_probe(
                    executable,
                    &probe_env,
                    &workspace.cwd,
                    &["app-server", "--help"],
                    "codex-compat-app-server-help",
                    &mut prepare_job,
                    canceled,
                )?,
                run_config_schema_probe(
                    executable,
                    &probe_env,
                    &workspace.cwd,
                    &workspace.schema,
                    prepare_job("codex-compat-config-schema")?,
                    canceled,
                )?,
            )
        };
        let mut capabilities = capabilities_from_help(
            version,
            &root_help,
            &exec_help,
            &resume_help,
            &interactive_resume_help,
            &app_server_help,
            reasoning_effort_schema,
        );
        if capabilities.managed_profiles {
            app_server_smoke(
                executable,
                &probe_env,
                &workspace.cwd,
                prepare_job("codex-compat-app-server")?,
                canceled,
            )?;
        }
        if !capabilities.managed_profiles {
            return Err(capability_refusal(&capabilities));
        }
        capabilities.app_server = CapabilitySupport::Supported;
        Ok(Arc::new(capabilities))
    })();

    let capabilities = match result {
        Ok(capabilities) => capabilities,
        Err(error) => {
            leader.finish(None, Err(error.clone()));
            return Err(error);
        }
    };
    if BinaryStamp::of(executable, env).as_ref() != Some(&stamp) {
        let error = ProviderError::Start(
            "Codex changed while KalCode was checking compatibility; retrying is safe".into(),
        );
        leader.finish(None, Err(error.clone()));
        return Err(error);
    }
    {
        let mut slots = lock(&CACHE.slots);
        if slots.len() >= MAX_CACHE_ENTRIES {
            slots.retain(|_, slot| matches!(slot, CacheSlot::Probing(_)));
        }
        slots.retain(|cached_stamp, _| cached_stamp.path != stamp.path || cached_stamp == &stamp);
    }
    leader.finish(Some(Arc::clone(&capabilities)), Ok(()));
    Ok(capabilities)
}

fn canceled_error() -> ProviderError {
    ProviderError::Start("Codex compatibility probe was canceled".into())
}

struct SmokeWorkspace {
    root: PathBuf,
    home: PathBuf,
    cwd: PathBuf,
    schema: PathBuf,
    config: PathBuf,
    cache: PathBuf,
    data: PathBuf,
    temp: PathBuf,
}

impl SmokeWorkspace {
    fn create(neutral_root: &Path) -> Result<Self, ProviderError> {
        let metadata = std::fs::symlink_metadata(neutral_root).map_err(|_| {
            ProviderError::Start("Codex compatibility probe directory is unavailable".into())
        })?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(ProviderError::Start(
                "Codex compatibility probe directory is not an ordinary directory".into(),
            ));
        }
        let root = neutral_root.join(format!(
            ".kalcode-codex-compat-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir(&root).map_err(|_| {
            ProviderError::Start("Codex compatibility probe directory could not be created".into())
        })?;
        let workspace = Self {
            home: root.join("home"),
            cwd: root.join("cwd"),
            schema: root.join("schema"),
            config: root.join("config"),
            cache: root.join("cache"),
            data: root.join("data"),
            temp: root.join("temp"),
            root,
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&workspace.root, std::fs::Permissions::from_mode(0o700))
                .map_err(|_| {
                    ProviderError::Start(
                        "Codex compatibility probe directory could not be protected".into(),
                    )
                })?;
        }
        std::fs::create_dir(&workspace.home)
            .and_then(|()| std::fs::create_dir(&workspace.cwd))
            .and_then(|()| std::fs::create_dir(&workspace.schema))
            .and_then(|()| std::fs::create_dir(&workspace.config))
            .and_then(|()| std::fs::create_dir(&workspace.cache))
            .and_then(|()| std::fs::create_dir(&workspace.data))
            .and_then(|()| std::fs::create_dir(&workspace.temp))
            .map_err(|_| {
                ProviderError::Start(
                    "Codex compatibility probe directories could not be created".into(),
                )
            })?;
        Ok(workspace)
    }

    fn isolated_env(&self, source: &BTreeMap<OsString, OsString>) -> BTreeMap<OsString, OsString> {
        const PASSTHROUGH: &[&str] = &[
            "PATH",
            "PATHEXT",
            "SYSTEMROOT",
            "WINDIR",
            "COMSPEC",
            "LANG",
            "LC_ALL",
            "LC_CTYPE",
            "TERM",
            "COLORTERM",
            "NO_COLOR",
            "CODEX_MANAGED_PACKAGE_ROOT",
            "CODEX_MANAGED_BY_NPM",
            "CODEX_MANAGED_BY_PNPM",
            "CODEX_MANAGED_BY_BUN",
            "CODEX_MANAGED_BY_VITE_PLUS",
        ];
        let mut env = source
            .iter()
            .filter(|(name, _)| {
                PASSTHROUGH
                    .iter()
                    .any(|allowed| name.eq_ignore_ascii_case(allowed))
            })
            .map(|(name, value)| (name.clone(), value.clone()))
            .collect::<BTreeMap<_, _>>();
        env.insert("CODEX_HOME".into(), self.home.clone().into_os_string());
        env.insert("HOME".into(), self.home.clone().into_os_string());
        env.insert("USERPROFILE".into(), self.home.clone().into_os_string());
        env.insert(
            "XDG_CONFIG_HOME".into(),
            self.config.clone().into_os_string(),
        );
        env.insert("XDG_CACHE_HOME".into(), self.cache.clone().into_os_string());
        env.insert("XDG_DATA_HOME".into(), self.data.clone().into_os_string());
        for name in ["TEMP", "TMP", "TMPDIR"] {
            env.insert(name.into(), self.temp.clone().into_os_string());
        }
        env
    }
}

impl Drop for SmokeWorkspace {
    fn drop(&mut self) {
        let Some(parent) = self.root.parent() else {
            return;
        };
        let safe_name = self
            .root
            .file_name()
            .and_then(OsStr::to_str)
            .is_some_and(|name| name.starts_with(".kalcode-codex-compat-"));
        if safe_name && self.root.starts_with(parent) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
}

fn capability_refusal(capabilities: &CodexCapabilities) -> ProviderError {
    ProviderError::Refused {
        code: "provider_capability_incompatible".into(),
        message: format!(
            "The installed Codex CLI is missing required managed-profile capabilities: {}.",
            capabilities.missing_required.join(", ")
        ),
    }
}

fn run_probe(
    executable: &Path,
    env: &BTreeMap<OsString, OsString>,
    cwd: &Path,
    args: &[&str],
    label: &str,
    prepare_job: &mut impl FnMut(&str) -> Result<RegisteredJob, ProviderError>,
    canceled: Option<&dyn Fn() -> bool>,
) -> Result<String, ProviderError> {
    if canceled.is_some_and(|canceled| canceled()) {
        return Err(ProviderError::Start(
            "Codex compatibility probe was canceled".into(),
        ));
    }
    let admission = prepare_job(label)?;
    run_prepared_probe(executable, env, cwd, args, admission, canceled)
}

fn run_prepared_probe(
    executable: &Path,
    env: &BTreeMap<OsString, OsString>,
    cwd: &Path,
    args: &[&str],
    admission: RegisteredJob,
    canceled: Option<&dyn Fn() -> bool>,
) -> Result<String, ProviderError> {
    run_prepared_probe_args(
        executable,
        env,
        cwd,
        args.iter().map(OsString::from).collect(),
        admission,
        canceled,
        HELP_TIMEOUT,
    )
}

fn run_prepared_probe_args(
    executable: &Path,
    env: &BTreeMap<OsString, OsString>,
    cwd: &Path,
    args: Vec<OsString>,
    admission: RegisteredJob,
    canceled: Option<&dyn Fn() -> bool>,
    timeout: Duration,
) -> Result<String, ProviderError> {
    let spec = ProcessSpec {
        program: executable.to_path_buf(),
        args,
        cwd: Some(cwd.to_path_buf()),
        env: env.clone(),
    };
    let output = match canceled {
        Some(canceled) => crate::process::run_probe_guarded_cancelable(
            &spec,
            admission,
            timeout,
            true,
            MAX_HELP_BYTES,
            canceled,
        ),
        None => crate::process::run_probe_guarded(&spec, admission, timeout, true, MAX_HELP_BYTES),
    }
    .map_err(|_| ProviderError::Start("Codex capability probe could not be completed".into()))?;
    if !output.status.success() {
        return Err(ProviderError::Start(
            "Codex capability probe did not complete successfully".into(),
        ));
    }
    Ok(output.stdout)
}

fn run_config_schema_probe(
    executable: &Path,
    env: &BTreeMap<OsString, OsString>,
    cwd: &Path,
    output_dir: &Path,
    admission: RegisteredJob,
    canceled: Option<&dyn Fn() -> bool>,
) -> Result<Option<config_schema::ReasoningEffortSchema>, ProviderError> {
    run_prepared_probe_args(
        executable,
        env,
        cwd,
        vec![
            "app-server".into(),
            "generate-json-schema".into(),
            "--out".into(),
            output_dir.as_os_str().to_owned(),
        ],
        admission,
        canceled,
        PROTOCOL_TIMEOUT,
    )?;
    Ok(config_schema::ReasoningEffortSchema::read(
        output_dir,
        crate::codex::argv::EFFORT_LEVELS,
    ))
}

type HelpProbeOutputs = (
    String,
    String,
    String,
    String,
    String,
    Option<config_schema::ReasoningEffortSchema>,
);

/// Runs independent, bounded help probes concurrently after the version floor has been checked.
/// Guardian admissions are prepared sequentially and each is immediately transferred to its
/// scoped worker, so an admission failure cannot strand a prepared job. The app-server protocol
/// smoke remains sequential and authoritative after these advertised capabilities are classified.
fn run_help_probes_parallel(
    executable: &Path,
    env: &BTreeMap<OsString, OsString>,
    cwd: &Path,
    schema_dir: &Path,
    prepare_job: &mut impl FnMut(&str) -> Result<RegisteredJob, ProviderError>,
) -> Result<HelpProbeOutputs, ProviderError> {
    std::thread::scope(|scope| {
        let admission = prepare_job("codex-compat-root-help")?;
        let root = scope
            .spawn(move || run_prepared_probe(executable, env, cwd, &["--help"], admission, None));
        let admission = prepare_job("codex-compat-exec-help")?;
        let exec = scope.spawn(move || {
            run_prepared_probe(executable, env, cwd, &["exec", "--help"], admission, None)
        });
        let admission = prepare_job("codex-compat-resume-help")?;
        let resume = scope.spawn(move || {
            run_prepared_probe(
                executable,
                env,
                cwd,
                &["exec", "resume", "--help"],
                admission,
                None,
            )
        });
        let admission = prepare_job("codex-compat-interactive-resume-help")?;
        let interactive_resume = scope.spawn(move || {
            run_prepared_probe(executable, env, cwd, &["resume", "--help"], admission, None)
        });
        let admission = prepare_job("codex-compat-app-server-help")?;
        let app_server = scope.spawn(move || {
            run_prepared_probe(
                executable,
                env,
                cwd,
                &["app-server", "--help"],
                admission,
                None,
            )
        });
        let admission = prepare_job("codex-compat-config-schema")?;
        let config_schema = scope.spawn(move || {
            run_config_schema_probe(executable, env, cwd, schema_dir, admission, None)
        });
        Ok((
            join_probe(root.join())?,
            join_probe(exec.join())?,
            join_probe(resume.join())?,
            join_probe(interactive_resume.join())?,
            join_probe(app_server.join())?,
            join_probe(config_schema.join())?,
        ))
    })
}

fn join_probe<T>(
    result: std::thread::Result<Result<T, ProviderError>>,
) -> Result<T, ProviderError> {
    result.map_err(|_| {
        ProviderError::Start("Codex capability probe worker did not complete".into())
    })?
}

fn app_server_smoke(
    executable: &Path,
    env: &BTreeMap<OsString, OsString>,
    cwd: &Path,
    admission: RegisteredJob,
    canceled: Option<&dyn Fn() -> bool>,
) -> Result<(), ProviderError> {
    let expected_home = env_value(env, "CODEX_HOME")
        .map(PathBuf::from)
        .ok_or_else(|| ProviderError::Start("managed Codex profile has no CODEX_HOME".into()))?;
    let mut args = Vec::new();
    for value in crate::codex::argv::PROBE_CONFIG {
        args.extend([OsString::from("-c"), OsString::from(value)]);
    }
    args.push("app-server".into());
    let spec = ProcessSpec {
        program: executable.to_path_buf(),
        args,
        cwd: Some(cwd.to_path_buf()),
        env: env.clone(),
    };
    let (child, lines) = SupervisedChild::spawn_guarded(&spec, admission).map_err(|_| {
        ProviderError::Start("Codex app-server compatibility smoke could not start".into())
    })?;
    let deadline = Instant::now() + PROTOCOL_TIMEOUT;
    let result = (|| {
        child
            .write_line(
                &json!({
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "clientInfo": {"name":"kalcode","title":null,"version":"compatibility-probe"},
                        "capabilities": {"experimentalApi":false}
                    }
                })
                .to_string(),
            )
            .map_err(|_| protocol_error())?;
        let initialized = response_result(&lines, 1, deadline, canceled)?;
        let reported_home = initialized
            .get("codexHome")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .ok_or_else(protocol_error)?;
        if !same_existing_directory(&reported_home, &expected_home) {
            return Err(protocol_error());
        }
        child
            .write_line(&json!({"method":"initialized"}).to_string())
            .map_err(|_| protocol_error())?;
        child
            .write_line(
                &json!({"id":2,"method":"account/read","params":{"refreshToken":false}})
                    .to_string(),
            )
            .map_err(|_| protocol_error())?;
        let account = response_result(&lines, 2, deadline, canceled)?;
        if !account.is_object() {
            return Err(protocol_error());
        }
        Ok(())
    })();
    let cleanup = child.terminate(Duration::from_millis(250));
    result?;
    cleanup.map(|_| ()).map_err(|_| {
        ProviderError::Start("Codex app-server compatibility smoke cleanup failed".into())
    })
}

fn response_result(
    lines: &std::sync::mpsc::Receiver<OutputLine>,
    id: i64,
    deadline: Instant,
    canceled: Option<&dyn Fn() -> bool>,
) -> Result<Value, ProviderError> {
    let mut ignored = 0usize;
    loop {
        if canceled.is_some_and(|canceled| canceled()) {
            return Err(ProviderError::Start(
                "Codex compatibility probe was canceled".into(),
            ));
        }
        let receive_deadline = deadline.min(Instant::now() + Duration::from_millis(25));
        match recv_until(lines, receive_deadline) {
            Ok(OutputLine::Line(line)) if line.len() <= MAX_PROTOCOL_LINE_BYTES => {
                let message: Value = serde_json::from_str(&line).map_err(|_| protocol_error())?;
                if message.get("id").and_then(Value::as_i64) == Some(id) {
                    return message.get("result").cloned().ok_or_else(protocol_error);
                }
                ignored += 1;
                if ignored > MAX_IGNORED_MESSAGES {
                    return Err(protocol_error());
                }
            }
            Ok(OutputLine::Line(_)) | Ok(OutputLine::TooLong { .. }) => {
                return Err(protocol_error());
            }
            Ok(OutputLine::Closed) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err(protocol_error());
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) if Instant::now() < deadline => {}
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => return Err(protocol_error()),
        }
    }
}

fn protocol_error() -> ProviderError {
    ProviderError::Refused {
        code: "provider_capability_incompatible".into(),
        message: "The installed Codex CLI did not satisfy the managed-profile protocol smoke."
            .into(),
    }
}

fn same_existing_directory(left: &Path, right: &Path) -> bool {
    left.is_dir() && right.is_dir() && same_file::is_same_file(left, right).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::version::Version;

    const ROOT_HELP: &str = r#"
Commands:
  exec        Run Codex non-interactively
  mcp         Manage external MCP servers
  app-server  Run the app server
  resume      Resume an interactive session
Options:
  -c, --config <key=value>
  -m, --model <MODEL>
  -C, --cd <DIR>
  -s, --sandbox <SANDBOX_MODE>
  -a, --ask-for-approval <APPROVAL_POLICY>
      --no-daemon
"#;
    const EXEC_HELP: &str = r#"
Commands:
  resume  Resume a previous session
Options:
  -c, --config <key=value>
  -m, --model <MODEL>
  -s, --sandbox <SANDBOX_MODE>
      --skip-git-repo-check
      --json
      --output-schema <FILE>
"#;
    const RESUME_HELP: &str = r#"
Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]
Options:
  -c, --config <key=value>
  -m, --model <MODEL>
      --json
"#;
    const INTERACTIVE_RESUME_HELP: &str = r#"
Usage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]
Options:
  -c, --config <key=value>
  -m, --model <MODEL>
"#;
    const APP_SERVER_HELP: &str = r#"
Usage: codex app-server [OPTIONS]
Options:
  -c, --config <key=value>
      --listen <URL>
      --stdio
"#;

    fn all_reasoning_efforts() -> Option<config_schema::ReasoningEffortSchema> {
        Some(config_schema::ReasoningEffortSchema::open_for_test(
            crate::codex::argv::EFFORT_LEVELS,
        ))
    }

    fn capabilities(version: &str) -> CodexCapabilities {
        capabilities_from_help(
            Version::parse(version).expect("version"),
            ROOT_HELP,
            EXEC_HELP,
            RESUME_HELP,
            INTERACTIVE_RESUME_HELP,
            APP_SERVER_HELP,
            all_reasoning_efforts(),
        )
    }

    #[test]
    fn normal_stable_minor_updates_are_compatible_by_capability() {
        for version in ["0.160.0", "0.160.9", "0.161.0", "0.999.0"] {
            let found = capabilities(version);
            assert_eq!(found.channel, CodexReleaseChannel::Stable, "{version}");
            assert_eq!(
                found.compatibility(),
                CodexCompatibility::Compatible,
                "{version} must not be blocked because its minor is new"
            );
        }
    }

    #[test]
    fn actual_prereleases_are_classified_without_confusing_unknown_stable_versions() {
        for (version, channel) in [
            ("0.162.0-alpha.16", CodexReleaseChannel::Alpha),
            ("0.162.0-beta.1", CodexReleaseChannel::Beta),
            ("0.162.0-rc.1", CodexReleaseChannel::ReleaseCandidate),
            ("0.162.0-preview.2", CodexReleaseChannel::Prerelease),
        ] {
            let found = capabilities(version);
            assert_eq!(found.channel, channel, "{version}");
            assert_eq!(found.compatibility(), CodexCompatibility::Experimental);
        }
        assert_eq!(
            capabilities("0.161.0+windows.7").channel,
            CodexReleaseChannel::Stable
        );
    }

    #[test]
    fn required_capability_removal_is_a_real_incompatibility() {
        let without_app_server = capabilities_from_help(
            Version::parse("0.162.0").expect("version"),
            &ROOT_HELP.replace("  app-server  Run the app server\n", ""),
            EXEC_HELP,
            RESUME_HELP,
            INTERACTIVE_RESUME_HELP,
            APP_SERVER_HELP,
            all_reasoning_efforts(),
        );
        assert!(!without_app_server.managed_profiles);
        assert_eq!(without_app_server.missing_required, vec!["app-server"]);

        let without_plan_workspace_flag = capabilities_from_help(
            Version::parse("0.162.0").expect("version"),
            ROOT_HELP,
            &EXEC_HELP.replace("      --skip-git-repo-check\n", ""),
            RESUME_HELP,
            INTERACTIVE_RESUME_HELP,
            APP_SERVER_HELP,
            all_reasoning_efforts(),
        );
        assert!(
            without_plan_workspace_flag
                .missing_required
                .contains(&"headless non-Git workspace support")
        );
        assert_eq!(
            without_plan_workspace_flag.compatibility(),
            CodexCompatibility::Incompatible
        );

        for (option, expected) in [
            ("  -C, --cd <DIR>\n", "interactive working directory"),
            (
                "  -s, --sandbox <SANDBOX_MODE>\n",
                "interactive sandbox selection",
            ),
            (
                "  -a, --ask-for-approval <APPROVAL_POLICY>\n",
                "interactive approval policy",
            ),
            ("  -m, --model <MODEL>\n", "interactive model selection"),
        ] {
            let found = capabilities_from_help(
                Version::parse("0.162.0").expect("version"),
                &ROOT_HELP.replace(option, ""),
                EXEC_HELP,
                RESUME_HELP,
                INTERACTIVE_RESUME_HELP,
                APP_SERVER_HELP,
                all_reasoning_efforts(),
            );
            assert!(found.missing_required.contains(&expected), "{option}");
            assert_eq!(
                found.compatibility(),
                CodexCompatibility::Incompatible,
                "KalCode must verify every root flag its interactive grammar uses"
            );
        }
    }

    #[test]
    fn unused_help_aliases_and_transports_are_not_a_compatibility_ceiling() {
        let root = ROOT_HELP
            .replace(", --config", "")
            .replace(", --cd", "")
            .replace(", --sandbox", "")
            .replace(", --ask-for-approval", "")
            .replace(", --model", "");
        let exec = EXEC_HELP.replace(", --config", "");
        let app_server = APP_SERVER_HELP
            .replace("      --listen <URL>\n", "")
            .replace("      --stdio\n", "");
        let found = capabilities_from_help(
            Version::parse("0.162.0").expect("version"),
            &root,
            &exec,
            RESUME_HELP,
            INTERACTIVE_RESUME_HELP,
            &app_server,
            all_reasoning_efforts(),
        );
        assert_eq!(found.compatibility(), CodexCompatibility::Compatible);
    }

    #[test]
    fn future_closed_reasoning_schema_is_authoritative_without_historical_tokens() {
        let future = Some(config_schema::ReasoningEffortSchema::closed_for_test(&[
            "low", "medium", "high", "ultra",
        ]));
        let found = capabilities_from_help(
            Version::parse("0.999.0").expect("version"),
            ROOT_HELP,
            EXEC_HELP,
            RESUME_HELP,
            INTERACTIVE_RESUME_HELP,
            APP_SERVER_HELP,
            future,
        );
        assert_eq!(found.reasoning_effort, CapabilitySupport::Supported);
        assert!(found.supports_reasoning_effort("high"));
        assert!(found.supports_reasoning_effort("ultra"));
        assert!(!found.supports_reasoning_effort("xhigh"));
        assert!(found.managed_profiles);
        assert!(
            !found
                .missing_required
                .contains(&"reasoning effort configuration")
        );
        assert_eq!(found.compatibility(), CodexCompatibility::Compatible);

        let missing = capabilities_from_help(
            Version::parse("0.999.0").expect("version"),
            ROOT_HELP,
            EXEC_HELP,
            RESUME_HELP,
            INTERACTIVE_RESUME_HELP,
            APP_SERVER_HELP,
            None,
        );
        assert_eq!(missing.reasoning_effort, CapabilitySupport::Unsupported);
        assert!(!missing.managed_profiles);
        assert!(
            missing
                .missing_required
                .contains(&"reasoning effort configuration")
        );
    }

    #[test]
    fn descriptor_reports_only_structurally_proven_reasoning_values() {
        let found = capabilities("0.161.0");
        for effort in crate::codex::argv::EFFORT_LEVELS {
            assert!(found.supports_reasoning_effort(effort), "{effort}");
        }
        assert!(
            found.supports_reasoning_effort("ultra"),
            "0.161's open nonempty-string schema must preserve safe future native values"
        );
        assert!(!found.supports_reasoning_effort("bad'value"));
    }

    #[test]
    fn compatibility_probe_environment_excludes_credentials_and_user_state() {
        let neutral = tempfile::tempdir().expect("neutral probe root");
        let neutral = std::fs::canonicalize(neutral.path()).expect("canonical probe root");
        let workspace = SmokeWorkspace::create(&neutral).expect("smoke workspace");
        let source = BTreeMap::from([
            (OsString::from("PATH"), OsString::from("provider-path")),
            (
                OsString::from("CODEX_MANAGED_PACKAGE_ROOT"),
                OsString::from("package-root"),
            ),
            (OsString::from("CODEX_HOME"), OsString::from("real-home")),
            (OsString::from("HOME"), OsString::from("real-user-home")),
            (OsString::from("OPENAI_API_KEY"), OsString::from("secret")),
            (OsString::from("SSH_AUTH_SOCK"), OsString::from("agent")),
            (
                OsString::from("NODE_OPTIONS"),
                OsString::from("--require=hook"),
            ),
        ]);
        let env = workspace.isolated_env(&source);
        assert_eq!(
            env.get(OsStr::new("PATH")),
            Some(&OsString::from("provider-path"))
        );
        assert_eq!(
            env.get(OsStr::new("CODEX_MANAGED_PACKAGE_ROOT")),
            Some(&OsString::from("package-root"))
        );
        assert_eq!(
            env.get(OsStr::new("CODEX_HOME")),
            Some(&workspace.home.clone().into_os_string())
        );
        assert_eq!(
            env.get(OsStr::new("HOME")),
            Some(&workspace.home.clone().into_os_string())
        );
        for secret in ["OPENAI_API_KEY", "SSH_AUTH_SOCK", "NODE_OPTIONS"] {
            assert!(!env.contains_key(OsStr::new(secret)), "{secret}");
        }
    }

    #[test]
    fn single_flight_waiters_receive_the_leaders_failure() {
        let flight = Arc::new(ProbeFlight::default());
        let waiter = {
            let flight = Arc::clone(&flight);
            std::thread::spawn(move || flight.wait(None))
        };
        let expected = ProviderError::Start("bounded probe failed".into());
        flight.finish(Err(expected.clone()));
        assert_eq!(waiter.join().expect("waiter"), Err(expected));
    }
}
