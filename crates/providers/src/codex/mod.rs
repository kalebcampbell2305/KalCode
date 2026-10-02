//! Codex adapter (headless `codex exec --json`, one supervised process per turn).
//!
//! See [`crate::turns`] for the session model and [`argv`] for the launch mapping. `codex
//! app-server` (JSON-RPC with approval requests to the host) is the long-term surface once it
//! leaves "experimental" in the CLI's own help; the plan is in docs/PROVIDERS.md §8b.

pub mod argv;
pub mod managed_policy;
mod stream;

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use kalcode_contracts::agent::{
    AgentEventSink, AgentProvider, AgentSession, AuthState, DetectionState, ProviderCapabilities,
    ProviderDetection, ProviderError, ProviderId, SessionConfig,
};
use kalcode_contracts::ids::new_id;
use kalcode_contracts::permissions::{ActionKind, NormalizedAction, PermissionMode};
use kalcode_contracts::threads::error_codes;
use serde_json::Value;

use crate::catalog;
use crate::claude::actions::{ActionContext, classify};
use crate::claude::argv::working_directory;
use crate::detect::{DetectEnv, DetectionSpec, detect, detect_guarded};
use crate::managed::{
    ManagedProfiles, ProfileLease, hold_shared_session_lease, share_profile_lease,
};
use crate::turns::{TurnAdapter, TurnLaunch, TurnNormalizer, TurnSession};
use crate::version::Version;
use crate::version_window::VersionWindow;

/// Certified Codex CLI compatibility lines for managed profiles (see [`VersionWindow`]). Each
/// floor was certified on the official npm release with the real-binary isolation and
/// app-server protocol checks (`managed_policy::certifies_codex_config_isolation`,
/// `tests/codex_certification_real.rs`); docs/PROVIDERS.md records the evidence. Add a line only
/// after certifying its first release the same way.
pub const MANAGED_VERSIONS: VersionWindow = VersionWindow {
    cli_name: "Codex CLI",
    profile_name: "Codex",
    npm_package: "@openai/codex",
    floors: &[
        Version::new(0, 155, 1),
        Version::new(0, 156, 0),
        Version::new(0, 157, 0),
        Version::new(0, 158, 0),
    ],
};

fn managed_version_supported(version: &Version) -> bool {
    MANAGED_VERSIONS.supports(version)
}

fn require_managed_version(version: &Version) -> Result<(), ProviderError> {
    if managed_version_supported(version) {
        Ok(())
    } else {
        Err(ProviderError::Refused {
            code: error_codes::PROVIDER_VERSION_UNSUPPORTED.to_owned(),
            message: MANAGED_VERSIONS.refusal(version),
        })
    }
}

/// Verifies an already-resolved Codex executable against the managed-profile version window.
/// Authentication uses this before app-server startup because an unauthenticated profile cannot
/// use the ordinary detection path's login-status probe.
#[cfg(test)]
pub(crate) fn verify_managed_executable_version(
    executable: &Path,
    env: &BTreeMap<OsString, OsString>,
    neutral_cwd: &Path,
) -> Result<(), ProviderError> {
    verify_managed_executable_version_inner(executable, env, neutral_cwd, None)
}

pub(crate) fn verify_managed_executable_version_guarded(
    executable: &Path,
    env: &BTreeMap<OsString, OsString>,
    neutral_cwd: &Path,
    admission: crate::guardian::RegisteredJob,
) -> Result<(), ProviderError> {
    verify_managed_executable_version_inner(executable, env, neutral_cwd, Some(admission))
}

fn verify_managed_executable_version_inner(
    executable: &Path,
    env: &BTreeMap<OsString, OsString>,
    neutral_cwd: &Path,
    admission: Option<crate::guardian::RegisteredJob>,
) -> Result<(), ProviderError> {
    let spec = crate::process::ProcessSpec {
        program: PathBuf::from(executable),
        args: vec!["--version".into()],
        cwd: Some(neutral_cwd.to_path_buf()),
        env: env.clone(),
    };
    let output = match admission {
        Some(admission) => crate::process::run_probe_guarded(
            &spec,
            admission,
            Duration::from_secs(15),
            true,
            16 * 1024,
        ),
        None => crate::process::run_probe(&spec, Duration::from_secs(15), true, 16 * 1024),
    }
    .map_err(|_| {
        ProviderError::Start("Codex did not report a version KalCode can verify".into())
    })?;
    if !output.status.success() {
        return Err(ProviderError::Start(
            "Codex did not report a version KalCode can verify".into(),
        ));
    }
    let version = Version::find_in(&output.stdout).ok_or_else(|| {
        ProviderError::Start("Codex did not report a version KalCode can verify".into())
    })?;
    require_managed_version(&version)
}

/// [`AgentProvider`] for Codex.
pub struct CodexProvider {
    env: DetectEnv,
    managed: Option<ManagedAccount>,
}

struct ManagedAccount {
    profiles: Arc<ManagedProfiles>,
    account_id: String,
    cloud_config: managed_policy::CloudConfigEligibility,
}

impl CodexProvider {
    pub fn new(env: DetectEnv) -> Self {
        Self { env, managed: None }
    }

    /// Creates an account-isolated provider. Every session must carry this exact account id.
    pub fn new_managed(
        env: DetectEnv,
        profiles: Arc<ManagedProfiles>,
        account_id: String,
        cloud_config: managed_policy::CloudConfigEligibility,
    ) -> Result<Self, ProviderError> {
        let env = profiles.prepare_env(ProviderId::CODEX, &account_id, &env)?;
        Ok(Self {
            env,
            managed: Some(ManagedAccount {
                profiles,
                account_id,
                cloud_config,
            }),
        })
    }
}

struct CodexTurns {
    mode: PermissionMode,
    model: Option<String>,
    effort: Option<String>,
    cwd: String,
    policy_overrides: Vec<OsString>,
}

impl TurnAdapter for CodexTurns {
    fn provider_id(&self) -> &'static str {
        ProviderId::CODEX
    }

    fn display_name(&self) -> &'static str {
        "Codex"
    }

    fn turn_args(&self, resume: Option<&str>) -> Result<Vec<OsString>, ProviderError> {
        argv::exec_args_with_overrides(
            self.mode,
            self.model.as_deref(),
            self.effort.as_deref(),
            resume,
            &self.policy_overrides,
        )
        .map_err(|e| ProviderError::Start(e.to_string()))
    }

    fn normalizer(&self) -> Box<dyn TurnNormalizer> {
        Box::new(stream::CodexNormalizer::new(self.cwd.clone()))
    }

    fn exit_error(&self, _exit_code: Option<i32>, stderr: &str) -> Option<(&'static str, String)> {
        approve_requires_git(self.mode, stderr)
    }
}

/// Codex's own guard: outside a Git repository (or another trusted directory) `codex exec`
/// refuses to run unless `--skip-git-repo-check` is passed, which KalCode passes only in the
/// read-only Plan mapping (`argv::sandbox_args`). Codex prints "Not inside a trusted directory
/// and --skip-git-repo-check was not specified." and exits before any JSON event.
fn approve_requires_git(mode: PermissionMode, stderr: &str) -> Option<(&'static str, String)> {
    if !(stderr.contains("--skip-git-repo-check") && stderr.contains("trusted directory")) {
        return None;
    }
    let mode = match mode {
        PermissionMode::Plan => "Plan",
        PermissionMode::Approve | PermissionMode::Custom => "Approve",
        PermissionMode::Auto => "Auto",
        PermissionMode::Bypass => "Bypass",
    };
    Some((
        error_codes::CODEX_APPROVE_REQUIRES_GIT,
        format!(
            "Codex runs in {mode} mode only inside a Git repository. Use Plan, or open a Git folder."
        ),
    ))
}

/// Resolves a usable executable for a turn-based provider, refusing the same states as Claude
/// Code (not installed, outdated, detection error, signed out).
pub(crate) fn usable_executable(
    spec: &DetectionSpec,
    env: &DetectEnv,
) -> Result<std::path::PathBuf, ProviderError> {
    let detected = detect(spec, env);
    match (detected.detection.state, detected.executable) {
        (DetectionState::Installed, Some(exe))
            if detected.detection.auth != AuthState::NotAuthenticated =>
        {
            Ok(exe)
        }
        (DetectionState::Installed, Some(_)) => Err(ProviderError::NotAuthenticated),
        (DetectionState::NotInstalled, _) => Err(ProviderError::NotInstalled),
        _ => Err(ProviderError::Start(
            detected
                .detection
                .message
                .unwrap_or_else(|| format!("{} couldn't be checked.", spec.display_name)),
        )),
    }
}

/// Resolves Codex only when its version is in a compatibility line certified by the isolation
/// policy ([`MANAGED_VERSIONS`]). Patch releases within a certified line are accepted; a new line
/// requires certification first, since a minimum-version check is insufficient for this security
/// boundary. Sign-in uses the same predicate ([`verify_managed_executable_version_guarded`]).
pub(crate) fn managed_executable(
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
                    ProviderError::Start("Codex did not report a version KalCode can verify".into())
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
                .unwrap_or_else(|| "Codex couldn't be checked.".into()),
        )),
    }
}

impl AgentProvider for CodexProvider {
    fn id(&self) -> ProviderId {
        ProviderId::new(ProviderId::CODEX)
    }

    fn display_name(&self) -> &str {
        "Codex"
    }

    fn detect(&self) -> ProviderDetection {
        match self
            .managed
            .as_ref()
            .and_then(|managed| managed.profiles.probe_guardian().ok())
        {
            Some(guardian) => {
                detect_guarded(&catalog::codex_spec(), &self.env, &guardian).detection
            }
            None => detect(&catalog::codex_spec(), &self.env).detection,
        }
    }

    fn capabilities(&self) -> ProviderCapabilities {
        catalog::codex_capabilities()
    }

    fn start_session(
        &self,
        config: SessionConfig,
        sink: Box<dyn AgentEventSink>,
    ) -> Result<Box<dyn AgentSession>, ProviderError> {
        if self.managed.is_none() && config.provider_account_id.is_some() {
            return Err(ProviderError::Start(
                "A managed provider profile is required for this account.".into(),
            ));
        }
        if config.secret_ref.is_some() {
            // API-key accounts are a later campaign; sessions use the user's own Codex sign-in.
            return Err(ProviderError::Unsupported);
        }
        let cwd = working_directory(&config.working_directory)
            .map_err(|e| ProviderError::Start(e.to_string()))?;
        let spec = catalog::codex_spec();
        let (executable, env, policy_overrides, lease): (_, _, _, Option<ProfileLease>) =
            if let Some(managed) = &self.managed {
                match config.provider_account_id.as_deref() {
                    Some(account_id) if account_id == managed.account_id => {}
                    _ => {
                        return Err(ProviderError::Start(
                            "the Codex session account does not match its managed profile".into(),
                        ));
                    }
                }
                let prepared = managed_policy::prepare_session(
                    &managed.profiles,
                    &self.env,
                    &managed.account_id,
                    &cwd,
                    managed.cloud_config,
                )?;
                let probe_guardian = managed.profiles.probe_guardian()?;
                let executable = managed_executable(&spec, &prepared.detect_env, &probe_guardian)?;
                (
                    executable,
                    prepared.env,
                    prepared.cli_overrides,
                    Some(prepared.lease),
                )
            } else {
                (
                    usable_executable(&spec, &self.env)?,
                    self.env.provider_env(&spec.env_policy),
                    Vec::new(),
                    None,
                )
            };
        let adapter = CodexTurns {
            mode: config.permission_mode,
            model: config.model,
            effort: config.effort,
            cwd: config.working_directory,
            policy_overrides,
        };
        // Validate the argv once before anything runs, so a bad model or resume id fails the
        // start instead of the first message.
        adapter.turn_args(config.resume_session_id.as_deref())?;
        let shared_lease = lease.map(share_profile_lease);
        let session: Box<dyn AgentSession> = Box::new(TurnSession::start(
            Box::new(adapter),
            TurnLaunch {
                executable,
                env,
                cwd,
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

/// Builds the [`NormalizedAction`] for a Codex item (`command_execution`, `file_change`,
/// `web_search`, `mcp_tool_call`), for the one policy engine (Z4). `None` for items that are
/// not actions (messages, reasoning, plans).
pub fn normalize_item(
    ctx: &ActionContext,
    item: &Value,
    requested_at: String,
) -> Option<NormalizedAction> {
    let field = |key| item.get(key).and_then(Value::as_str);
    let (action, summary) = match field("type")? {
        "command_execution" => classify(
            "Bash",
            &serde_json::json!({ "command": field("command").unwrap_or("") }),
            &ctx.working_directory,
        ),
        "web_search" => classify(
            "WebSearch",
            &serde_json::json!({ "query": field("query").unwrap_or("") }),
            &ctx.working_directory,
        ),
        "file_change" => {
            let path = item
                .get("changes")
                .and_then(Value::as_array)
                .and_then(|c| c.first())
                .and_then(|c| c.get("path"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            (
                ActionKind::FileWrite { path: path.clone() },
                format!("Edit {path}"),
            )
        }
        "mcp_tool_call" => {
            let tool = format!(
                "mcp:{}/{}",
                field("server").unwrap_or("mcp"),
                field("tool").unwrap_or("tool")
            );
            (
                ActionKind::Tool {
                    tool: tool.clone(),
                    input_summary: "MCP arguments".into(),
                },
                format!("Use {tool}"),
            )
        }
        _ => return None,
    };
    Some(NormalizedAction {
        id: new_id(),
        thread_id: ctx.thread_id.clone(),
        workspace_id: ctx.workspace_id.clone(),
        provider_id: ProviderId::new(ProviderId::CODEX),
        action,
        summary,
        requested_at,
        origin: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use kalcode_contracts::permissions::GitOperation;

    /// Codex's trusted-directory refusal, as `codex exec` prints it outside a Git repository.
    const NOT_A_GIT_FOLDER: &str =
        "Not inside a trusted directory and --skip-git-repo-check was not specified.\n";

    #[test]
    fn codexs_non_git_refusal_is_classified_with_precise_copy() {
        let turns = |mode| CodexTurns {
            mode,
            model: None,
            effort: None,
            cwd: String::new(),
            policy_overrides: Vec::new(),
        };
        let (code, message) = turns(PermissionMode::Approve)
            .exit_error(Some(1), NOT_A_GIT_FOLDER)
            .expect("the guard is recognized");
        assert_eq!(code, "codex_approve_requires_git");
        assert_eq!(
            message,
            "Codex runs in Approve mode only inside a Git repository. Use Plan, or open a Git folder."
        );
        let (_, auto) = turns(PermissionMode::Auto)
            .exit_error(Some(1), NOT_A_GIT_FOLDER)
            .expect("Auto uses the same guard");
        assert!(auto.starts_with("Codex runs in Auto mode"));

        // Plan passes --skip-git-repo-check; other crashes keep the generic exit error.
        assert!(
            argv::sandbox_args(PermissionMode::Plan).contains(&"--skip-git-repo-check")
                && !argv::sandbox_args(PermissionMode::Approve).contains(&"--skip-git-repo-check")
        );
        for other in ["", "Error: stream disconnected", "trusted directory"] {
            assert!(
                turns(PermissionMode::Approve)
                    .exit_error(Some(1), other)
                    .is_none(),
                "{other:?}"
            );
        }
    }

    fn ctx() -> ActionContext {
        ActionContext {
            thread_id: new_id(),
            workspace_id: new_id(),
            working_directory: "/work".into(),
        }
    }

    #[test]
    fn codex_items_become_normalized_actions() {
        let push = normalize_item(
            &ctx(),
            &serde_json::json!({"type": "command_execution", "command": "git push origin main"}),
            "t".into(),
        )
        .expect("action");
        assert!(matches!(
            push.action,
            ActionKind::Git {
                operation: GitOperation::Push,
                ..
            }
        ));
        assert_eq!(push.provider_id.as_str(), "codex");
        let edit = normalize_item(
            &ctx(),
            &serde_json::json!({"type": "file_change", "changes": [{"path": "a.rs", "kind": "update"}], "status": "completed"}),
            "t".into(),
        )
        .expect("action");
        assert_eq!(
            edit.action,
            ActionKind::FileWrite {
                path: "a.rs".into()
            }
        );
        assert!(
            normalize_item(
                &ctx(),
                &serde_json::json!({"type": "agent_message", "text": "x"}),
                "t".into()
            )
            .is_none()
        );
    }

    #[test]
    fn managed_policy_accepts_patch_releases_within_certified_codex_lines() {
        let version = |value| Version::parse(value).expect("version");
        for supported in [
            "0.155.1", "0.155.2", "0.156.0", "0.156.1", "0.156.7", "0.157.0", "0.157.1", "0.158.0",
            "0.158.4",
        ] {
            assert!(
                managed_version_supported(&version(supported)),
                "{supported} is in a certified line at or above its floor"
            );
            require_managed_version(&version(supported)).expect("supported version starts");
        }
    }

    #[test]
    fn managed_policy_refuses_codex_versions_outside_certified_lines() {
        let version = |value| Version::parse(value).expect("version");
        for refused in [
            "0.154.9",
            "0.155.0",
            "0.159.0",
            "0.158.0-alpha.15",
            "0.157.1-alpha.1",
            "0.158.0+build.1",
            "1.0.0",
            "1.155.1",
        ] {
            assert!(
                !managed_version_supported(&version(refused)),
                "{refused} must fail closed"
            );
        }
    }

    #[test]
    fn codex_refusal_names_the_found_version_the_supported_range_and_the_install_command() {
        let found = Version::parse("0.159.0").expect("version");
        let ProviderError::Refused { code, message } =
            require_managed_version(&found).expect_err("0.159.0 must fail closed")
        else {
            panic!("unsupported Codex must be a typed refusal");
        };
        assert_eq!(code, "provider_version_unsupported");
        assert!(message.contains("Codex CLI 0.159.0"), "{message}");
        assert!(
            message.contains("0.155.x (0.155.1 or later), 0.156.x, 0.157.x or 0.158.x"),
            "{message}"
        );
        assert!(
            message.contains("npm install -g @openai/codex@0.158.0"),
            "{message}"
        );

        let pre_release = Version::parse("0.158.0-alpha.15").expect("version");
        let ProviderError::Refused { code, message } =
            require_managed_version(&pre_release).expect_err("pre-release must fail closed")
        else {
            panic!("unsupported Codex must be a typed refusal");
        };
        assert_eq!(code, "provider_version_unsupported");
        assert!(message.contains("0.158.0-alpha.15"), "{message}");
    }

    /// Writes a fake Codex that records its working directory and reports `version`.
    fn fake_codex_reporting(dir: &Path, version: &str) -> PathBuf {
        #[cfg(windows)]
        {
            let script = dir.join("codex-version.cmd");
            std::fs::write(
                &script,
                format!(
                    "@echo off
cd > \"%CWD_MARKER%\"
echo codex-cli {version}
"
                ),
            )
            .expect("version script");
            script
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let script = dir.join("codex-version");
            std::fs::write(
                &script,
                format!(
                    "#!/bin/sh
pwd > \"$CWD_MARKER\"
printf 'codex-cli {version}\n'
"
                ),
            )
            .expect("version script");
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700))
                .expect("executable version script");
            script
        }
    }

    #[test]
    fn sign_in_version_probe_uses_the_same_line_policy_as_thread_start() {
        let temp = tempfile::tempdir().expect("temp");
        let neutral = temp.path().join("neutral");
        std::fs::create_dir(&neutral).expect("neutral directory");
        let source = DetectEnv::from_process();
        let mut env = source.provider_env(&crate::env::EnvPolicy::BASE);
        env.insert(
            "CWD_MARKER".into(),
            temp.path().join("cwd-marker").into_os_string(),
        );
        for (index, (reported, accepted)) in [
            ("0.156.1", true),
            ("0.157.1", true),
            ("0.158.0", true),
            ("0.159.0", false),
            ("0.158.0-alpha.15", false),
        ]
        .into_iter()
        .enumerate()
        {
            let dir = temp.path().join(format!("fake-{index}"));
            std::fs::create_dir(&dir).expect("fake directory");
            let executable = fake_codex_reporting(&dir, reported);
            let result = verify_managed_executable_version(&executable, &env, &neutral);
            assert_eq!(result.is_ok(), accepted, "{reported}: {result:?}");
            if let Err(ProviderError::Start(message)) = result {
                assert!(message.contains(reported), "{message}");
            }
        }
    }

    #[test]
    fn managed_version_probe_runs_only_in_the_supplied_neutral_directory() {
        let temp = tempfile::tempdir().expect("temp");
        let neutral = temp.path().join("neutral");
        std::fs::create_dir(&neutral).expect("neutral directory");
        let marker = temp.path().join("cwd-marker");
        #[cfg(windows)]
        let executable = {
            let script = temp.path().join("codex-version.cmd");
            std::fs::write(
                &script,
                "@echo off\r\ncd > \"%CWD_MARKER%\"\r\necho codex-cli 0.157.0\r\n",
            )
            .expect("version script");
            script
        };
        #[cfg(unix)]
        let executable = {
            use std::os::unix::fs::PermissionsExt;
            let script = temp.path().join("codex-version");
            std::fs::write(
                &script,
                "#!/bin/sh\npwd > \"$CWD_MARKER\"\nprintf 'codex-cli 0.157.0\\n'\n",
            )
            .expect("version script");
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700))
                .expect("executable version script");
            script
        };
        let source = DetectEnv::from_process();
        let mut env = source.provider_env(&crate::env::EnvPolicy::BASE);
        env.insert("CWD_MARKER".into(), marker.clone().into_os_string());

        verify_managed_executable_version(&executable, &env, &neutral).expect("certified version");
        let reported = std::fs::read_to_string(marker).expect("cwd marker");
        assert_eq!(
            std::fs::canonicalize(reported.trim()).expect("reported cwd"),
            std::fs::canonicalize(neutral).expect("neutral cwd")
        );
    }
}
