//! Gemini CLI adapter (headless `--output-format stream-json`, one supervised process per
//! turn; see [`crate::turns`]).
//!
//! Sources (docs/PROVIDERS.md §11 [9][10][15][16]): the headless-mode guide and CLI reference
//! (geminicli.com), and the stream-JSON event types the CLI defines in
//! `packages/core/src/output/types.ts` (github.com/google-gemini/gemini-cli). Managed launches
//! are certified against exact official package version 0.61.0. Deterministic tests use a fake
//! provider and recorded official-format fixtures; bounded real probes cover version detection
//! and profile-home isolation without making an inference request.
//!
//! argv (the prompt is written to stdin; headless mode applies to non-TTY input):
//!
//! ```text
//! gemini --output-format stream-json --approval-mode <plan|default|auto_edit>
//!        [--model <alias>] [--resume <session uuid>]
//! ```
//!
//! Never passed: `yolo` / `--yolo`, `--allowed-tools` (deprecated), or ACP. Managed profiles set
//! trust before settings load, run from a neutral directory, and include the real repository.

mod argv;
pub mod managed_policy;
pub mod stream;

pub use argv::{
    FORBIDDEN, GeminiArgsError, approval_mode, headless_args, interactive_args, permission_setting,
};

use std::ffi::OsString;
use std::sync::Arc;

use kalcode_contracts::agent::{
    AgentEventSink, AgentProvider, AgentSession, AuthState, DetectionState, MappingFidelity,
    PermissionMapping, ProviderCapabilities, ProviderDetection, ProviderError, ProviderId,
    SessionConfig,
};
use kalcode_contracts::permissions::PermissionMode;

use crate::catalog;
use crate::claude::argv::working_directory;
use crate::codex::usable_executable;
use crate::detect::{DetectEnv, DetectionSpec, detect, detect_guarded};
use crate::managed::{
    ManagedProfiles, ProfileLease, hold_shared_session_lease, share_profile_lease,
};
use crate::turns::{TurnAdapter, TurnLaunch, TurnNormalizer, TurnSession};
use crate::version::Version;

const NOT_ENFORCED: &str = "Gemini Plan retains core project read tools, so it is not a \
                            secret-file privacy boundary. Managed profiles accept only the \
                            certified Gemini CLI 0.61.0 configuration behavior.";

pub fn permission_mappings() -> Vec<PermissionMapping> {
    let map = |mode, notes: &str| PermissionMapping {
        mode,
        fidelity: MappingFidelity::ApproximateStricter,
        provider_setting: permission_setting(mode),
        notes: format!("{notes} {NOT_ENFORCED}"),
    };
    vec![
        map(PermissionMode::Plan, "Gemini CLI's read-only plan mode."),
        map(
            PermissionMode::Approve,
            "Tool calls that need confirmation can't be answered in headless mode, so they \
             don't run.",
        ),
        map(PermissionMode::Auto, "Runs like Approve."),
        map(
            PermissionMode::Bypass,
            "File edits are approved automatically; other tools that need confirmation don't \
             run. yolo mode is never used.",
        ),
    ]
}

/// [`AgentProvider`] for Gemini CLI.
pub struct GeminiProvider {
    env: DetectEnv,
    managed_profiles: Option<ManagedProfiles>,
}

impl GeminiProvider {
    /// Unmanaged compatibility constructor retained for isolated adapter tests. Desktop/runtime
    /// factories use [`Self::new_managed`] so they never inherit a standalone Gemini account.
    pub fn new(env: DetectEnv) -> Self {
        Self {
            env,
            managed_profiles: None,
        }
    }

    pub fn new_managed(env: DetectEnv, managed_profiles: ManagedProfiles) -> Self {
        Self {
            env,
            managed_profiles: Some(managed_profiles),
        }
    }
}

fn managed_version_supported(version: &Version) -> bool {
    version == &Version::new(0, 61, 0)
}

fn managed_detection_env(
    profiles: &ManagedProfiles,
    account_id: &str,
    source: &DetectEnv,
) -> Result<DetectEnv, ProviderError> {
    profiles.prepare_env(ProviderId::GEMINI_CLI, account_id, source)
}

fn managed_executable(
    spec: &DetectionSpec,
    env: &DetectEnv,
    guardian: &crate::guardian::ProviderProbeGuardian,
) -> Result<std::path::PathBuf, ProviderError> {
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
            if managed_version_supported(&version) {
                Ok(executable)
            } else {
                Err(ProviderError::Start(format!(
                    "managed Gemini profiles currently require certified Gemini CLI 0.61.0; found {version}"
                )))
            }
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

struct GeminiTurns {
    mode: PermissionMode,
    model: Option<String>,
    cwd: String,
    managed: Option<Arc<managed_policy::ManagedGeminiLaunch>>,
}

impl TurnAdapter for GeminiTurns {
    fn provider_id(&self) -> &'static str {
        ProviderId::GEMINI_CLI
    }

    fn display_name(&self) -> &'static str {
        "Gemini CLI"
    }

    fn turn_args(&self, resume: Option<&str>) -> Result<Vec<OsString>, ProviderError> {
        let mut args = headless_args(self.mode, self.model.as_deref(), resume)
            .map_err(|e| ProviderError::Start(e.to_string()))?;
        if let Some(managed) = &self.managed {
            managed.append_security_args(&mut args)?;
        }
        Ok(args)
    }

    fn normalizer(&self) -> Box<dyn TurnNormalizer> {
        Box::new(stream::GeminiNormalizer::new(self.cwd.clone()))
    }

    fn exit_error(&self, exit_code: Option<i32>) -> Option<(&'static str, String)> {
        (exit_code == Some(FATAL_AUTHENTICATION_EXIT)).then(|| {
            (
                "provider_not_authenticated",
                NOT_SIGNED_IN_MESSAGE.to_owned(),
            )
        })
    }
}

/// Gemini CLI's `ExitCodes.FATAL_AUTHENTICATION_ERROR` (packages/cli/src/utils/exitCodes.ts).
const FATAL_AUTHENTICATION_EXIT: i32 = 41;
const NOT_SIGNED_IN_MESSAGE: &str = "Gemini CLI isn't signed in for this account. Sign in to this \
     Gemini account in Providers, then resume this thread.";

impl AgentProvider for GeminiProvider {
    fn id(&self) -> ProviderId {
        ProviderId::new(ProviderId::GEMINI_CLI)
    }

    fn display_name(&self) -> &str {
        "Gemini CLI"
    }

    fn detect(&self) -> ProviderDetection {
        match self
            .managed_profiles
            .as_ref()
            .and_then(|profiles| profiles.probe_guardian().ok())
        {
            Some(guardian) => {
                detect_guarded(&catalog::gemini_spec(), &self.env, &guardian).detection
            }
            None => detect(&catalog::gemini_spec(), &self.env).detection,
        }
    }

    fn capabilities(&self) -> ProviderCapabilities {
        catalog::gemini_capabilities()
    }

    fn start_session(
        &self,
        config: SessionConfig,
        sink: Box<dyn AgentEventSink>,
    ) -> Result<Box<dyn AgentSession>, ProviderError> {
        if self.managed_profiles.is_none() && config.provider_account_id.is_some() {
            return Err(ProviderError::Start(
                "A managed provider profile is required for this account.".into(),
            ));
        }
        if config.secret_ref.is_some() {
            return Err(ProviderError::Unsupported);
        }
        let account_id = match &self.managed_profiles {
            Some(_) => Some(config.provider_account_id.as_deref().ok_or_else(|| {
                ProviderError::Start(
                    "a managed Gemini session requires an explicit provider account".into(),
                )
            })?),
            None => None,
        };
        let spec = catalog::gemini_spec();
        let managed_detection = match (&self.managed_profiles, account_id) {
            (Some(profiles), Some(account_id)) => {
                Some(managed_detection_env(profiles, account_id, &self.env)?)
            }
            _ => None,
        };
        let executable = match (&managed_detection, &self.managed_profiles) {
            (Some(environment), Some(profiles)) => {
                let guardian = profiles.probe_guardian()?;
                managed_executable(&spec, environment, &guardian)?
            }
            _ => usable_executable(&spec, &self.env)?,
        };
        let workspace = working_directory(&config.working_directory)
            .map_err(|e| ProviderError::Start(e.to_string()))?;
        let mut managed = match (&self.managed_profiles, account_id) {
            (Some(profiles), Some(account_id)) => {
                Some(managed_policy::ManagedGeminiLaunch::prepare(
                    profiles,
                    &self.env,
                    account_id,
                    &config.thread_id,
                    &workspace,
                    config.permission_mode,
                )?)
            }
            _ => None,
        };
        let lease: Option<ProfileLease> = managed
            .as_mut()
            .map(managed_policy::ManagedGeminiLaunch::take_session_lease)
            .transpose()?;
        if let (Some(profiles), Some(account_id)) = (&self.managed_profiles, account_id) {
            // Checked while the shared account lease is held, so sign-out cannot race it. A
            // profile with no Gemini credential refuses up front instead of starting a turn
            // Gemini can only fail.
            if crate::gemini_account_auth::credential_state(profiles, account_id)?
                == AuthState::NotAuthenticated
            {
                return Err(ProviderError::NotAuthenticated);
            }
        }
        let mut launch_env = managed.as_ref().map_or_else(
            || self.env.provider_env(&spec.env_policy),
            |launch| launch.environment().clone(),
        );
        if managed.is_some() {
            // A headless turn must never start Gemini's browser sign-in: its consent question
            // would read the person's prompt from stdin. With the browser suppressed, a missing
            // or expired sign-in fails with Gemini's own authentication exit code instead.
            launch_env.insert(OsString::from("NO_BROWSER"), OsString::from("true"));
        }
        let launch_cwd = managed
            .as_ref()
            .map_or_else(|| workspace.clone(), |launch| launch.cwd().to_path_buf());
        let managed = managed.map(Arc::new);
        let adapter = GeminiTurns {
            mode: config.permission_mode,
            model: config.model,
            cwd: config.working_directory,
            managed,
        };
        adapter.turn_args(config.resume_session_id.as_deref())?;
        let shared_lease = lease.map(share_profile_lease);
        let session: Box<dyn AgentSession> = Box::new(TurnSession::start(
            Box::new(adapter),
            TurnLaunch {
                executable,
                env: launch_env,
                cwd: launch_cwd,
                resume_session_id: config.resume_session_id,
                guardian_profile: shared_lease.clone(),
            },
            sink,
        ));
        Ok(match shared_lease {
            Some(lease) => hold_shared_session_lease(session, lease),
            None => session,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn geminis_authentication_exit_is_reported_as_an_actionable_sign_in() {
        let turns = GeminiTurns {
            mode: PermissionMode::Plan,
            model: None,
            cwd: String::new(),
            managed: None,
        };
        let (code, message) = turns.exit_error(Some(41)).expect("auth exit is recognized");
        assert_eq!(code, "provider_not_authenticated");
        assert!(message.contains("Sign in to this Gemini account in Providers"));
        for other in [None, Some(0), Some(1), Some(42), Some(130)] {
            assert!(turns.exit_error(other).is_none(), "{other:?}");
        }
    }

    const ALL: [PermissionMode; 5] = [
        PermissionMode::Plan,
        PermissionMode::Approve,
        PermissionMode::Auto,
        PermissionMode::Bypass,
        PermissionMode::Custom,
    ];

    fn strings(args: Vec<OsString>) -> Vec<String> {
        args.into_iter()
            .map(|a| a.into_string().expect("utf8"))
            .collect()
    }

    #[test]
    fn no_mode_is_ever_broader_than_its_kalcode_mode() {
        let rank = |m: &str| match m {
            "plan" => 0,
            "default" => 1,
            "auto_edit" => 2,
            other => panic!("unexpected approval mode {other}"),
        };
        for mode in ALL {
            for args in [
                strings(headless_args(mode, Some("flash"), None).expect("args")),
                strings(interactive_args(mode, Some("flash"), None).expect("args")),
            ] {
                for forbidden in FORBIDDEN {
                    assert!(!args.iter().any(|a| a == forbidden), "{mode:?}: {args:?}");
                }
                let at = args
                    .iter()
                    .position(|a| a == "--approval-mode")
                    .expect("mode");
                let cap = match mode {
                    PermissionMode::Plan => 0,
                    PermissionMode::Bypass => 2,
                    _ => 1,
                };
                assert!(rank(&args[at + 1]) <= cap, "{mode:?}");
            }
        }
        assert_eq!(
            strings(headless_args(PermissionMode::Plan, None, None).expect("args")),
            ["--output-format", "stream-json", "--approval-mode", "plan"]
        );
    }

    #[test]
    fn resume_takes_only_a_session_uuid() {
        let id = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
        let args = strings(headless_args(PermissionMode::Approve, None, Some(id)).expect("args"));
        assert_eq!(&args[args.len() - 2..], ["--resume", id]);
        for bad in ["latest", "5", "--yolo"] {
            assert_eq!(
                headless_args(PermissionMode::Approve, None, Some(bad)),
                Err(GeminiArgsError::InvalidSessionId)
            );
        }
        assert_eq!(
            headless_args(PermissionMode::Approve, Some("--yolo"), None),
            Err(GeminiArgsError::InvalidModel)
        );
    }

    #[test]
    fn mappings_are_stricter_and_match_the_argv() {
        for mapping in permission_mappings() {
            assert_eq!(mapping.fidelity, MappingFidelity::ApproximateStricter);
            let argv = strings(headless_args(mapping.mode, None, None).expect("args")).join(" ");
            assert!(argv.contains(&mapping.provider_setting), "{argv}");
        }
    }

    #[test]
    fn a_managed_provider_requires_an_explicit_account_before_detection_or_launch() {
        let temp = tempfile::tempdir().expect("temp");
        let temp_root = if cfg!(target_os = "macos") {
            temp.path().canonicalize().expect("canonical temp")
        } else {
            temp.path().to_path_buf()
        };
        let workspace = temp_root.join("workspace");
        std::fs::create_dir(&workspace).expect("workspace");
        let profiles =
            crate::managed::ManagedProfiles::new(temp_root.join("managed")).expect("profiles");
        let provider = GeminiProvider::new_managed(DetectEnv::default(), profiles);
        let error = match provider.start_session(
            SessionConfig {
                thread_id: kalcode_contracts::ids::new_id(),
                workspace_id: kalcode_contracts::ids::new_id(),
                provider_account_id: None,
                working_directory: workspace.display().to_string(),
                model: None,
                permission_mode: PermissionMode::Approve,
                resume_session_id: None,
                secret_ref: None,
            },
            Box::new(|_| {}),
        ) {
            Ok(_) => panic!("managed Gemini must not inherit a machine account"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("account"), "{error}");
    }

    #[test]
    fn managed_policy_accepts_only_the_certified_gemini_version() {
        let version = |value| crate::version::Version::parse(value).expect("version");
        assert!(managed_version_supported(&version("0.61.0")));
        assert!(!managed_version_supported(&version("0.61.9")));
        assert!(!managed_version_supported(&version("0.60.99")));
        assert!(!managed_version_supported(&version("0.62.0")));
        assert!(!managed_version_supported(&version("1.61.0")));
    }

    #[test]
    fn managed_detection_uses_only_the_selected_profile_environment() {
        let temp = tempfile::tempdir().expect("temp");
        let temp_root = if cfg!(target_os = "macos") {
            temp.path().canonicalize().expect("canonical temp")
        } else {
            temp.path().to_path_buf()
        };
        let profiles =
            crate::managed::ManagedProfiles::new(temp_root.join("managed")).expect("profiles");
        let account_id = kalcode_contracts::ids::new_id();
        let source = DetectEnv {
            vars: vec![
                ("HOME".into(), temp_root.join("standalone").into_os_string()),
                ("PATH".into(), temp_root.as_os_str().to_os_string()),
                ("GEMINI_API_KEY".into(), "synthetic-secret".into()),
                (
                    "GEMINI_CLI_HOME".into(),
                    temp_root.join("old").into_os_string(),
                ),
            ],
            windows: false,
            probe_timeout: None,
        };

        let isolated = managed_detection_env(&profiles, &account_id, &source).expect("environment");
        let find = |name: &str| {
            isolated
                .vars
                .iter()
                .find_map(|(key, value)| (key == name).then_some(value.as_os_str()))
        };
        assert!(find("GEMINI_API_KEY").is_none());
        assert_eq!(
            find("GEMINI_CLI_HOME"),
            Some(
                crate::managed::plain_path(
                    &profiles
                        .profile_home("gemini-cli", &account_id)
                        .expect("profile")
                )
                .as_os_str()
            )
        );
    }
}
