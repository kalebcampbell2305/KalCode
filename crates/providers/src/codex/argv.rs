//! `codex exec` argument vectors and the KalCode permission mapping for headless Codex turns.
//!
//! Verified 2026-09-25 against the installed `codex exec --help` and `codex exec resume --help`
//! (codex-cli 0.157.0; the supported minimum remains 0.155.1) and the official docs
//! (docs/PROVIDERS.md §11 [5][7][13][14]):
//!
//! - `--json` prints events as JSON Lines; the prompt is read from stdin when it is `-`.
//! - `-s/--sandbox read-only|workspace-write|danger-full-access`; exec's default is read-only.
//! - `codex exec` has no `--ask-for-approval` flag; the approval policy is the documented
//!   `approval_policy` config key, set with `-c` exactly as the official TypeScript SDK does
//!   (`--config approval_policy="…"`). `never`: "Execution failures are immediately returned to
//!   the model" — nothing waits for a person KalCode can't reach.
//! - `sandbox_workspace_write.network_access`, `web_search` and
//!   `shell_environment_policy.inherit` are documented config keys (config reference).
//! - `--ignore-rules`: "Do not load user or project execpolicy `.rules` files".
//! - `--skip-git-repo-check`: allow running outside a Git repository.
//! - `exec … resume <SESSION_ID> -` continues a thread by the id `thread.started` reported.
//!
//! Every value is its own argv element and every config value is a TOML literal string, so no
//! shell or quoting is involved. The message never appears on the command line.

use std::ffi::OsString;

use kalcode_contracts::agent::{MappingFidelity, PermissionMapping};
use kalcode_contracts::permissions::PermissionMode;

use crate::version::Version;

/// The oldest Codex CLI KalCode's headless adapter was verified against (`exec --json`,
/// `exec resume`, `--ignore-rules`).
#[cfg(not(windows))]
pub const MINIMUM_VERSION: Version = Version::new(0, 155, 1);
/// Windows needs the upstream detached-process console suppression fixes shipped in 0.160.
/// See openai/codex#48483 and openai/codex#49164. Older providers can open desktop windows
/// for piped tools even when KalCode correctly starts their root in an integrated PTY.
#[cfg(windows)]
pub const MINIMUM_VERSION: Version = Version::new(0, 160, 0);

/// Shared scalar floor for panes and headless turns. The empty MCP table is defense in depth:
/// Codex merges maps across layers, so managed profile reset, repository trust binding, and the
/// cloud-eligibility gate remain required boundaries.
pub(crate) const POLICY_CONFIG: &[&str] = &[
    "mcp_servers={}",
    "web_search='disabled'",
    "shell_environment_policy.inherit='core'",
    "sandbox_workspace_write.network_access=false",
    "sandbox_workspace_write.writable_roots=[]",
    "features.apps=false",
    "features.plugins=false",
    "features.remote_plugin=false",
    "features.hooks=false",
    "features.multi_agent=false",
    "features.multi_agent_v2=false",
    "features.skill_mcp_dependency_install=false",
    "features.browser_use=false",
    "features.browser_use_external=false",
    "features.computer_use=false",
    "features.in_app_browser=false",
    "features.image_generation=false",
    // The local execution host is stable and starts automatically. Disabling it prevents
    // model-selected Code Mode tools from running; it is not a permission boundary. Leave
    // experimental code_mode selection to Codex while preserving the sandbox below.
    "features.code_mode_host=true",
    "features.auth_elicitation=false",
    "features.tool_call_mcp_elicitation=false",
];

/// Flags and values KalCode never passes to Codex, in any mode.
pub const FORBIDDEN: &[&str] = &[
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust",
    "--approve-for-me",
    "--search",
    "--add-dir",
    "--oss",
    "--worktree",
    "network_access=true",
    "web_search='live'",
];

/// Set for every turn, in every mode.
const COMMON: &[&str] = &[
    "exec",
    "--json",
    // Repository-supplied execpolicy rules never grant anything (K4); see PROVIDERS.md §5.
    "--ignore-rules",
    // Authentication remains in CODEX_HOME; user config cannot grant independent authority.
    "--ignore-user-config",
];

/// Provider-native sandbox and approval mapping. `Custom` uses the same bounded prompt policy
/// as `Approve` until custom provider-native controls are part of the contract.
pub fn sandbox_args(mode: PermissionMode) -> Vec<&'static str> {
    match mode {
        PermissionMode::Plan => vec![
            "--sandbox",
            "read-only",
            "--skip-git-repo-check",
            "-c",
            "approval_policy='never'",
        ],
        PermissionMode::Approve | PermissionMode::Custom => vec![
            "--sandbox",
            "workspace-write",
            "-c",
            "approval_policy='on-request'",
        ],
        PermissionMode::Auto => vec![
            "--sandbox",
            "workspace-write",
            "-c",
            "approval_policy='never'",
        ],
        PermissionMode::Bypass => vec![
            "--sandbox",
            "danger-full-access",
            "-c",
            "approval_policy='never'",
        ],
    }
}

/// The permission-relevant flags as shown on the Providers page (generated from the argv, so
/// the display can't drift from what runs).
pub fn permission_setting(mode: PermissionMode) -> String {
    let mut parts: Vec<&str> = sandbox_args(mode);
    parts.extend(COMMON.iter().skip(2).copied());
    for value in POLICY_CONFIG {
        parts.extend(["-c", value]);
    }
    parts.join(" ")
}

const NOT_ENFORCED: &str = "Codex has no deny-rule flag: KalCode can't stop reads of credential \
                            files that its native sandbox permits.";

pub fn permission_mappings() -> Vec<PermissionMapping> {
    let map = |mode, notes: String| PermissionMapping {
        mode,
        fidelity: MappingFidelity::ApproximateStricter,
        provider_setting: permission_setting(mode),
        notes,
    };
    vec![
        map(
            PermissionMode::Plan,
            format!(
                "Reads and read-only commands inside Codex's read-only sandbox; edits, network \
                 and anything that would ask are refused. {NOT_ENFORCED}"
            ),
        ),
        map(
            PermissionMode::Approve,
            format!(
                "Workspace writes use Codex's native on-request approval prompt; connected tools \
                 and web search remain disabled. {NOT_ENFORCED}"
            ),
        ),
        map(
            PermissionMode::Auto,
            format!(
                "Workspace writes run without approval prompts inside Codex's native sandbox; \
                 connected tools and web search remain disabled. {NOT_ENFORCED}"
            ),
        ),
        map(
            PermissionMode::Bypass,
            format!(
                "Uses Codex's explicit danger-full-access sandbox with approval prompts disabled; \
                 connected tools and web search remain disabled. {NOT_ENFORCED}"
            ),
        ),
    ]
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CodexExecError {
    #[error("the model name is not valid")]
    InvalidModel,
    #[error("the reasoning effort is not supported")]
    InvalidEffort,
    #[error("the session id is not valid")]
    InvalidSessionId,
}

/// Codex reasoning-effort values certified for the CLI config override.
pub const EFFORT_LEVELS: &[&str] = &["minimal", "low", "medium", "high", "xhigh"];

pub fn valid_effort_name(effort: &str) -> bool {
    EFFORT_LEVELS.contains(&effort)
}

/// The argv (after the program) for one headless turn. The prompt is written to stdin (`-`).
pub fn exec_args(
    mode: PermissionMode,
    model: Option<&str>,
    effort: Option<&str>,
    resume: Option<&str>,
) -> Result<Vec<OsString>, CodexExecError> {
    exec_args_with_overrides(mode, model, effort, resume, &[])
}

/// Managed variant with already-tokenized root CLI overrides (`-c`, value pairs). The caller is
/// responsible for producing these through [`crate::codex::managed_policy`].
pub(crate) fn exec_args_with_overrides(
    mode: PermissionMode,
    model: Option<&str>,
    effort: Option<&str>,
    resume: Option<&str>,
    overrides: &[OsString],
) -> Result<Vec<OsString>, CodexExecError> {
    let mut out: Vec<OsString> = COMMON.iter().map(OsString::from).collect();
    for value in POLICY_CONFIG {
        out.extend([OsString::from("-c"), OsString::from(value)]);
    }
    out.extend_from_slice(overrides);
    out.extend(sandbox_args(mode).into_iter().map(OsString::from));
    if let Some(model) = model {
        if !crate::claude::argv::valid_model_name(model) {
            return Err(CodexExecError::InvalidModel);
        }
        out.push("--model".into());
        out.push(model.into());
    }
    if let Some(effort) = effort {
        if !valid_effort_name(effort) {
            return Err(CodexExecError::InvalidEffort);
        }
        out.push("-c".into());
        out.push(format!("model_reasoning_effort='{effort}'").into());
    }
    if let Some(id) = resume {
        if !kalcode_contracts::ids::is_valid_id(id) {
            return Err(CodexExecError::InvalidSessionId);
        }
        out.push("resume".into());
        out.push(id.into());
    }
    out.push("-".into());
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [PermissionMode; 5] = [
        PermissionMode::Plan,
        PermissionMode::Approve,
        PermissionMode::Auto,
        PermissionMode::Bypass,
        PermissionMode::Custom,
    ];

    fn args(mode: PermissionMode, resume: Option<&str>) -> Vec<String> {
        exec_args(mode, Some("gpt-5"), None, resume)
            .expect("args")
            .into_iter()
            .map(|a| a.into_string().expect("utf8"))
            .collect()
    }

    fn after<'a>(args: &'a [String], flag: &str) -> Vec<&'a str> {
        args.iter()
            .enumerate()
            .filter(|(_, a)| *a == flag)
            .filter_map(|(i, _)| args.get(i + 1).map(String::as_str))
            .collect()
    }

    #[test]
    fn code_host_is_available_for_new_and_resumed_turns_in_every_mode() {
        for mode in ALL {
            for resume in [None, Some("0192f3c4-0000-7000-8000-000000000000")] {
                let argv = args(mode, resume);
                let configs = after(&argv, "-c");
                assert!(
                    configs.contains(&"features.code_mode_host=true"),
                    "{mode:?}"
                );
                assert!(!configs.contains(&"features.code_mode_host=false"));
                assert!(!configs.contains(&"features.code_mode=false"));
            }
        }
    }

    #[test]
    fn no_mode_is_ever_broader_than_its_kalcode_mode() {
        for mode in ALL {
            let args = args(mode, None);
            for forbidden in FORBIDDEN {
                assert!(
                    !args.iter().any(|a| a == forbidden || a.contains(forbidden)),
                    "{mode:?} passes {forbidden}: {args:?}"
                );
            }
            let sandbox = after(&args, "--sandbox");
            assert_eq!(sandbox.len(), 1, "{mode:?}");
            let expected = match mode {
                PermissionMode::Plan => "read-only",
                PermissionMode::Approve | PermissionMode::Auto | PermissionMode::Custom => {
                    "workspace-write"
                }
                PermissionMode::Bypass => "danger-full-access",
            };
            assert_eq!(sandbox[0], expected, "{mode:?}");
            let configs = after(&args, "-c");
            let expected_approval = match mode {
                PermissionMode::Approve | PermissionMode::Custom => "approval_policy='on-request'",
                PermissionMode::Plan | PermissionMode::Auto | PermissionMode::Bypass => {
                    "approval_policy='never'"
                }
            };
            assert!(configs.contains(&expected_approval), "{mode:?}");
            assert!(configs.contains(&"web_search='disabled'"), "{mode:?}");
            assert!(configs.contains(&"shell_environment_policy.inherit='core'"));
            assert!(args.iter().any(|a| a == "--ignore-rules"));
            if mode != PermissionMode::Plan {
                assert!(configs.contains(&"sandbox_workspace_write.network_access=false"));
                // Codex's own "is this a Git repository" guard stays on whenever it can write.
                assert!(!args.iter().any(|a| a == "--skip-git-repo-check"));
            }
            assert_eq!(
                args.last().map(String::as_str),
                Some("-"),
                "prompt on stdin"
            );
        }
    }

    #[test]
    fn modes_rank_in_order_and_custom_runs_as_approve() {
        assert_eq!(
            args(PermissionMode::Custom, None),
            args(PermissionMode::Approve, None)
        );
        assert_ne!(
            args(PermissionMode::Plan, None),
            args(PermissionMode::Auto, None)
        );
        assert_ne!(
            args(PermissionMode::Auto, None),
            args(PermissionMode::Bypass, None)
        );
    }

    #[test]
    fn mappings_are_stricter_and_generated_from_the_argv() {
        for mapping in permission_mappings() {
            assert_eq!(mapping.fidelity, MappingFidelity::ApproximateStricter);
            let argv = args(mapping.mode, None).join(" ");
            for part in mapping.provider_setting.split(' ') {
                assert!(argv.contains(part), "{part} not in {argv}");
            }
        }
    }

    #[test]
    fn resume_and_model_are_validated() {
        let id = "0192f3c4-0000-7000-8000-000000000000";
        let args = args(PermissionMode::Approve, Some(id));
        let at = args.iter().position(|a| a == "resume").expect("resume");
        assert_eq!(args[at + 1], id);
        assert_eq!(args[at + 2], "-");
        assert_eq!(
            exec_args(PermissionMode::Approve, None, None, Some("--last")),
            Err(CodexExecError::InvalidSessionId)
        );
        assert_eq!(
            exec_args(PermissionMode::Approve, Some("-c"), None, None),
            Err(CodexExecError::InvalidModel)
        );
        let args = exec_args(PermissionMode::Approve, None, Some("high"), None).expect("effort");
        let args: Vec<String> = args
            .into_iter()
            .map(|arg| arg.into_string().expect("utf8"))
            .collect();
        assert!(
            args.windows(2)
                .any(|pair| { pair == ["-c", "model_reasoning_effort='high'"] })
        );
        for effort in EFFORT_LEVELS {
            assert!(exec_args(PermissionMode::Approve, None, Some(effort), None).is_ok());
        }
        for effort in ["", "HIGH", "max", "ultra", "high' -c web_search='live"] {
            assert_eq!(
                exec_args(PermissionMode::Approve, None, Some(effort), None),
                Err(CodexExecError::InvalidEffort)
            );
        }
    }
}
