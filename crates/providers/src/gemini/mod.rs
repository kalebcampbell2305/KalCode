//! Gemini CLI adapter (headless `--output-format stream-json`, one supervised process per
//! turn; see [`crate::turns`]).
//!
//! Sources (docs/PROVIDERS.md §11 [9][10][15][16]): the headless-mode guide and CLI reference
//! (geminicli.com), and the stream-JSON event types the CLI defines in
//! `packages/core/src/output/types.ts` (github.com/google-gemini/gemini-cli). Managed launches
//! accept the certified 0.61 line (0.61.0 or a later 0.61 patch release; see
//! [`MANAGED_VERSIONS`]). Deterministic tests use a fake
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
use kalcode_contracts::threads::error_codes;

use crate::catalog;
use crate::claude::argv::working_directory;
use crate::codex::usable_executable;
use crate::detect::{DetectEnv, DetectionSpec, detect, detect_guarded};
use crate::managed::{
    ManagedProfiles, ProfileLease, hold_shared_session_lease, share_profile_lease,
};
use crate::turns::{TurnAdapter, TurnLaunch, TurnNormalizer, TurnSession};
use crate::version::Version;
use crate::version_window::VersionWindow;

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
        map(
            PermissionMode::Auto,
            "File edits are approved automatically; shell commands and other tools still require \
             confirmation. yolo mode is never used.",
        ),
        map(
            PermissionMode::Bypass,
            "Everything runs without approval prompts (Gemini CLI's yolo mode).",
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

/// Certified Gemini CLI compatibility lines for managed profiles (see [`VersionWindow`]). The
/// floor was certified on the official npm release with `tests/gemini_sign_in_real.rs`; add a
/// line only after certifying its first release the same way.
pub const MANAGED_VERSIONS: VersionWindow = VersionWindow {
    cli_name: "Gemini CLI",
    profile_name: "Gemini",
    npm_package: "@google/gemini-cli",
    floors: &[Version::new(0, 61, 0)],
};

/// The one predicate thread start, panes and sign-in use for managed Gemini.
pub(crate) fn managed_version_supported(version: &Version) -> bool {
    MANAGED_VERSIONS.supports(version)
}

pub(crate) fn require_managed_version(version: &Version) -> Result<(), ProviderError> {
    if managed_version_supported(version) {
        Ok(())
    } else {
        Err(ProviderError::Refused {
            code: error_codes::PROVIDER_VERSION_UNSUPPORTED.to_owned(),
            message: MANAGED_VERSIONS.refusal(version),
        })
    }
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
    let detected = crate::launch_probe::detect_for_launch(spec, env, Some(guardian));
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
            require_managed_version(&version)?;
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

    fn exit_error(&self, exit_code: Option<i32>, stderr: &str) -> Option<(&'static str, String)> {
        if exit_code == Some(FATAL_AUTHENTICATION_EXIT) {
            return Some((
                error_codes::PROVIDER_NOT_AUTHENTICATED,
                NOT_SIGNED_IN_MESSAGE.to_owned(),
            ));
        }
        ineligible_account(stderr)
    }
}

/// Google's Code Assist setup refuses some account tiers for Gemini CLI with an
/// `IneligibleTierError` (reason `UNSUPPORTED_CLIENT`), then the CLI exits 1. The tier name is
/// only repeated when Google named that exact tier; nothing else from stderr is used.
fn ineligible_account(stderr: &str) -> Option<(&'static str, String)> {
    if !(stderr.contains("IneligibleTierError") || stderr.contains("UNSUPPORTED_CLIENT")) {
        return None;
    }
    let account = if stderr.contains(INDIVIDUAL_TIER) {
        format!("this account type ({INDIVIDUAL_TIER})")
    } else {
        "this account type".to_owned()
    };
    Some((
        error_codes::PROVIDER_ACCOUNT_INELIGIBLE,
        format!("Google no longer lets Gemini CLI use {account}. Use Claude Code or Codex."),
    ))
}

const INDIVIDUAL_TIER: &str = "Gemini Code Assist for individuals";

/// Gemini CLI's `ExitCodes.FATAL_AUTHENTICATION_ERROR` (packages/cli/src/utils/exitCodes.ts).
const FATAL_AUTHENTICATION_EXIT: i32 = 41;
const NOT_SIGNED_IN_MESSAGE: &str =
    "Gemini session expired. Reconnect this Gemini account to continue.";

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
                _runtime_lease: None,
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
        let (code, message) = turns
            .exit_error(Some(41), "")
            .expect("auth exit is recognized");
        assert_eq!(code, "provider_not_authenticated");
        assert_eq!(
            message,
            "Gemini session expired. Reconnect this Gemini account to continue."
        );
        for other in [None, Some(0), Some(1), Some(42), Some(130)] {
            assert!(turns.exit_error(other, "").is_none(), "{other:?}");
        }
    }

    /// The B7 stderr (docs/release/certification-B5/evidence-main-B7/gemini-a2-diagnosis.txt):
    /// Google refused the account tier and the CLI exited 1.
    const B7_INELIGIBLE_STDERR: &str = "Warning: 256-color support not detected.\n\
        Error authenticating: IneligibleTierError: This client is no longer supported for Gemini \
        Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity \
        suite of products: https://antigravity.google\n    at throwIneligibleOrProjectIdError \
        (file:///C:/Users/[REDACTED]/chunk.js:311090:11)\n  ineligibleTiers: [\n    {\n      \
        reasonCode: 'UNSUPPORTED_CLIENT',\n      tierId: 'free-tier',\n      tierName: 'Gemini \
        Code Assist for individuals'\n    }\n  ]\n}\nAn unexpected critical error occurred:\
        IneligibleTierError: This client is no longer supported";

    #[test]
    fn googles_ineligible_tier_refusal_is_classified_with_fixed_copy() {
        let turns = GeminiTurns {
            mode: PermissionMode::Approve,
            model: None,
            cwd: String::new(),
            managed: None,
        };
        let (code, message) = turns
            .exit_error(Some(1), B7_INELIGIBLE_STDERR)
            .expect("the tier refusal is recognized");
        assert_eq!(code, "provider_account_ineligible");
        assert_eq!(
            message,
            "Google no longer lets Gemini CLI use this account type (Gemini Code Assist for \
             individuals). Use Claude Code or Codex."
        );
        // Fixed copy only: nothing from stderr (URLs, paths, Google's own wording) is echoed.
        assert!(!message.contains("antigravity"));
        assert!(!message.contains("chunk.js"));

        // Negative: an ordinary crash stays a generic exit, and an unrelated stderr that merely
        // mentions an account is not treated as a refusal.
        assert!(
            turns
                .exit_error(Some(1), "TypeError: fetch failed")
                .is_none()
        );
        assert!(
            turns
                .exit_error(Some(1), "Loaded cached credentials for this account.")
                .is_none()
        );
        let (_, generic) = turns
            .exit_error(Some(1), "reasonCode: 'UNSUPPORTED_CLIENT'")
            .expect("the reason code alone is recognized");
        assert!(generic.contains("use this account type. Use Claude Code or Codex."));
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
            "yolo" => 3,
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
                    PermissionMode::Auto => 2,
                    // Bypass runs without approvals (owner directive 2026-10-03).
                    PermissionMode::Bypass => 3,
                    _ => 1,
                };
                assert!(rank(&args[at + 1]) <= cap, "{mode:?}");
            }
        }
        assert_eq!(
            strings(headless_args(PermissionMode::Plan, None, None).expect("args")),
            ["--output-format", "stream-json", "--approval-mode", "plan"]
        );
        assert_eq!(approval_mode(PermissionMode::Approve), "default");
        assert_eq!(approval_mode(PermissionMode::Auto), "auto_edit");
        assert_eq!(approval_mode(PermissionMode::Bypass), "yolo");
        assert!(FORBIDDEN.contains(&"--approval-mode=yolo"));
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
        for model in ["gemini-4.0-pro+tools", "模型/gemini:exact"] {
            let args = strings(
                headless_args(PermissionMode::Approve, Some(model), None).expect("exact model"),
            );
            let at = args.iter().position(|arg| arg == "--model").expect("model");
            assert_eq!(args[at + 1], model);
        }
        for model in ["model\u{200b}name", "bidi\u{202e}override"] {
            assert_eq!(
                headless_args(PermissionMode::Approve, Some(model), None),
                Err(GeminiArgsError::InvalidModel)
            );
        }
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
                effort: None,
                permission_mode: PermissionMode::Approve,
                resume_session_id: None,
                secret_ref: None,
                launch_origin: Default::default(),
            },
            Box::new(|_| {}),
        ) {
            Ok(_) => panic!("managed Gemini must not inherit a machine account"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("account"), "{error}");
    }

    #[test]
    fn managed_policy_accepts_patch_releases_within_the_certified_gemini_line() {
        let version = |value| crate::version::Version::parse(value).expect("version");
        assert!(managed_version_supported(&version("0.61.0")));
        assert!(managed_version_supported(&version("0.61.3")));
        assert!(managed_version_supported(&version("0.61.9")));
    }

    #[test]
    fn managed_policy_refuses_gemini_versions_outside_the_certified_line() {
        let version = |value| crate::version::Version::parse(value).expect("version");
        for refused in [
            "0.60.99",
            "0.62.0",
            "0.61.0-preview.1",
            "0.61.1-nightly.20260930.gabc",
            "1.0.0",
            "1.61.0",
        ] {
            assert!(
                !managed_version_supported(&version(refused)),
                "{refused} must fail closed"
            );
        }
    }

    #[test]
    fn gemini_refusal_names_the_found_version_the_supported_range_and_the_install_command() {
        let found = crate::version::Version::parse("0.62.0").expect("version");
        let ProviderError::Refused { code, message } =
            require_managed_version(&found).expect_err("0.62.0 must fail closed")
        else {
            panic!("unsupported Gemini CLI must be a typed refusal");
        };
        assert_eq!(code, "provider_version_unsupported");
        assert!(message.contains("Gemini CLI 0.62.0"), "{message}");
        assert!(message.contains("0.61.x"), "{message}");
        assert!(
            message.contains("npm install -g @google/gemini-cli@0.61.0"),
            "{message}"
        );
        require_managed_version(&crate::version::Version::parse("0.61.3").expect("version"))
            .expect("a 0.61 patch release starts");
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
            system_root: None,
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
