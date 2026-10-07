//! Codex adapter (headless `codex exec --json`, one supervised process per turn).
//!
//! See [`crate::turns`] for the session model and [`argv`] for the launch mapping. `codex
//! app-server` (JSON-RPC with approval requests to the host) is the long-term surface once it
//! leaves "experimental" in the CLI's own help; the plan is in docs/PROVIDERS.md §8b.

pub mod argv;
pub mod compatibility;
pub mod managed_policy;
pub mod runtime;
mod stream;

use std::ffi::OsString;
use std::path::Path;
use std::sync::Arc;

#[cfg(test)]
use std::collections::BTreeMap;
#[cfg(test)]
use std::path::PathBuf;

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
/// Codex release lines whose session-flag hooks KalCode verified end to end: the `-c hooks.*`
/// overrides, the session-flags trust key and hash, the Claude-shaped payloads and the
/// observe-only semantics ([`kalcode_hook_bridge::codex`]). Only the 0.160 line has that evidence;
/// every other line keeps `notify` status until its hook schema is verified, so an unverified
/// trust format can never surface Codex's hook review.
pub(crate) fn observing_hooks_verified(version: &Version) -> bool {
    version.major == 0 && version.minor == 160 && !version.is_prerelease()
}

#[cfg(test)]
fn managed_version_supported(version: &Version) -> bool {
    version >= &argv::MINIMUM_VERSION
}

#[cfg(test)]
fn require_managed_version(version: &Version) -> Result<(), ProviderError> {
    if managed_version_supported(version) {
        Ok(())
    } else {
        Err(ProviderError::Refused {
            code: "provider_capability_incompatible".to_owned(),
            message: format!(
                "Codex {version} lacks platform runtime fixes required by this KalCode build; \
                 version {} or later is required.",
                argv::MINIMUM_VERSION
            ),
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
    let spec = crate::process::ProcessSpec {
        program: PathBuf::from(executable),
        args: vec!["--version".into()],
        cwd: Some(neutral_cwd.to_path_buf()),
        env: env.clone(),
    };
    let output =
        crate::process::run_probe(&spec, std::time::Duration::from_secs(15), true, 16 * 1024)
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
    usable_executable_and_version(spec, env).map(|(executable, _)| executable)
}

/// [`usable_executable`], plus the version detection reported (if it parsed).
pub(crate) fn usable_executable_and_version(
    spec: &DetectionSpec,
    env: &DetectEnv,
) -> Result<(std::path::PathBuf, Option<Version>), ProviderError> {
    let detected = crate::launch_probe::detect_for_launch(spec, env, None);
    match (detected.detection.state, detected.executable) {
        (DetectionState::Installed, Some(exe))
            if detected.detection.auth != AuthState::NotAuthenticated =>
        {
            let version = detected
                .detection
                .version
                .as_deref()
                .and_then(Version::parse);
            Ok((exe, version))
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

/// Resolves a new managed Codex process through capability negotiation, signed compatibility
/// policy, immutable runtime promotion, and last-known-good recovery. Existing processes retain
/// the executable and runtime lease they were launched with.
pub(crate) fn managed_executable_and_version(
    spec: &DetectionSpec,
    env: &DetectEnv,
    guardian: &crate::guardian::ProviderProbeGuardian,
    runtime_store: &crate::managed_runtime::RuntimeStore,
    neutral_cwd: &Path,
    prepare_job: impl FnMut(&str) -> Result<crate::guardian::RegisteredJob, ProviderError>,
) -> Result<runtime::ManagedCodexRuntime, ProviderError> {
    let detected = crate::launch_probe::detect_for_launch(spec, env, Some(guardian));
    if detected.detection.auth == AuthState::NotAuthenticated {
        return Err(ProviderError::NotAuthenticated);
    }
    let provider_env = env.provider_env(&spec.env_policy);
    runtime::select_managed_runtime(
        detected.executable.as_deref(),
        &provider_env,
        neutral_cwd,
        runtime_store,
        prepare_job,
        None,
    )
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
        let (executable, env, policy_overrides, lease, runtime_lease): (
            _,
            _,
            _,
            Option<ProfileLease>,
            Option<crate::managed_runtime::RuntimeLease>,
        ) = if let Some(managed) = &self.managed {
            match config.provider_account_id.as_deref() {
                Some(account_id) if account_id == managed.account_id => {}
                _ => {
                    return Err(ProviderError::Start(
                        "the Codex session account does not match its managed profile".into(),
                    ));
                }
            }
            let mut prepared = managed_policy::prepare_session(
                &managed.profiles,
                &self.env,
                &managed.account_id,
                &cwd,
                managed.cloud_config,
            )?;
            let probe_guardian = managed.profiles.probe_guardian()?;
            let runtime_store = managed.profiles.runtime_store();
            let neutral_cwd = managed.profiles.compatibility_probe_dir()?;
            let selected = managed_executable_and_version(
                &spec,
                &prepared.detect_env,
                &probe_guardian,
                &runtime_store,
                &neutral_cwd,
                |label| prepared.lease.prepare_guarded_job(label),
            )?;
            selected.configure_environment(&mut prepared.env);
            let (executable, _version, _capabilities, runtime_lease) = selected.into_parts();
            (
                executable,
                prepared.env,
                prepared.cli_overrides,
                Some(prepared.lease),
                runtime_lease,
            )
        } else {
            (
                usable_executable(&spec, &self.env)?,
                self.env.provider_env(&spec.env_policy),
                Vec::new(),
                None,
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
                _runtime_lease: runtime_lease,
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
    fn managed_version_floor_accepts_stable_patch_minor_and_future_versions() {
        let version = |value| Version::parse(value).expect("version");
        for supported in [
            "0.155.1", "0.155.2", "0.156.0", "0.156.1", "0.156.7", "0.157.0", "0.157.1", "0.158.0",
            "0.158.4", "0.159.0", "0.159.3", "0.160.0", "0.160.2", "0.161.0", "0.999.0",
        ] {
            if cfg!(windows) && version(supported) < argv::MINIMUM_VERSION {
                assert!(!managed_version_supported(&version(supported)));
                require_managed_version(&version(supported))
                    .expect_err("Windows requires the console-free runtime");
                continue;
            }
            assert!(
                managed_version_supported(&version(supported)),
                "{supported} is at or above the verified platform floor"
            );
            require_managed_version(&version(supported)).expect("supported version starts");
        }
    }

    #[test]
    fn managed_version_floor_refuses_only_versions_below_the_platform_floor() {
        let version = |value| Version::parse(value).expect("version");
        for refused in [
            "0.154.9",
            "0.155.0",
            #[cfg(windows)]
            "0.159.99",
        ] {
            assert!(
                !managed_version_supported(&version(refused)),
                "{refused} must fail closed"
            );
        }
    }

    #[test]
    fn future_stable_and_compatible_prerelease_versions_are_not_rejected_by_name() {
        let found = Version::parse("0.161.0").expect("version");
        require_managed_version(&found).expect("0.161.0 stable is capability-probed");

        let pre_release = Version::parse("0.162.0-alpha.15").expect("version");
        require_managed_version(&pre_release)
            .expect("compatible prereleases use the experimental capability path");
    }

    #[test]
    fn observing_hooks_require_evidence_for_the_exact_schema_line() {
        assert!(observing_hooks_verified(
            &Version::parse("0.160.2").expect("version")
        ));
        assert!(!observing_hooks_verified(
            &Version::parse("0.160.3-rc.1").expect("version")
        ));
        assert!(!observing_hooks_verified(
            &Version::parse("0.161.0").expect("version")
        ));
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
            ("0.156.1", !cfg!(windows)),
            ("0.157.1", !cfg!(windows)),
            ("0.158.0", !cfg!(windows)),
            ("0.159.0", !cfg!(windows)),
            ("0.160.0", true),
            ("0.161.0", true),
            ("0.162.0-alpha.15", true),
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
                "@echo off\r\ncd > \"%CWD_MARKER%\"\r\necho codex-cli 0.160.0\r\n",
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
