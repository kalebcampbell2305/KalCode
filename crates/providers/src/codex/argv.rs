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
//! - `--ignore-rules` ("Do not load user or project execpolicy `.rules` files") is never passed:
//!   the person's own rules (`~/.codex/rules`) apply as in a native terminal, and Codex loads a
//!   project's `.codex/rules` only for a project the person trusted (verified 2026-10-04 with
//!   codex-cli 0.160.0: a user `forbidden` rule rejected the command without the flag and was
//!   skipped with it; an untrusted checkout's project rule was not loaded).
//! - `--skip-git-repo-check`: allow running outside a Git repository.
//! - `exec … resume <SESSION_ID> -` continues a thread by the id `thread.started` reported.
//!
//! Every value is its own argv element and every config value is a TOML literal string, so no
//! shell or quoting is involved. The message never appears on the command line.

use std::ffi::OsString;

use kalcode_contracts::agent::{MappingFidelity, PermissionMapping, safe_model_selector};
use kalcode_contracts::permissions::PermissionMode;

use crate::version::Version;

/// Owner policy: ten concurrent child agents for each Codex parent session.
/// This does not limit KalCode's top-level terminals or coding agents.
/// https://developers.openai.com/codex/config-reference/
pub const SUBAGENT_CONFIG: &str = "agents.max_concurrent_threads_per_session=10";

/// The oldest Codex CLI KalCode's headless adapter was verified against (`exec --json`,
/// `exec resume`).
#[cfg(not(windows))]
pub const MINIMUM_VERSION: Version = Version::new(0, 155, 1);
/// Windows needs the upstream detached-process console suppression fixes shipped in 0.160.
/// See openai/codex#48483 and openai/codex#49164. Older providers can open desktop windows
/// for piped tools even when KalCode correctly starts their root in an integrated PTY.
#[cfg(windows)]
pub const MINIMUM_VERSION: Version = Version::new(0, 160, 0);

/// Config KalCode sets for panes and headless turns. Deliberately small: Codex keeps its native
/// tools and the person's own config (MCP servers, web search, plugins, apps, skills, shell
/// environment, sandbox network settings), as in a native terminal (AGENTS.md "Permanent
/// provider tool capability rule"). The selected sandbox and approval policy still apply.
pub(crate) const POLICY_CONFIG: &[&str] = &[
    // Without a Windows backend selection Codex downgrades workspace-write to read-only. Use its
    // restricted-token backend without elevation; the selected sandbox/approval mode still applies.
    #[cfg(target_os = "windows")]
    "windows.sandbox='unelevated'",
    // The local execution host is stable and starts automatically. Disabling it prevents
    // model-selected Code Mode tools from running; it is not a permission boundary.
    "features.code_mode_host=true",
];

/// Config for KalCode's own account probes (sign-in, account and usage reads through
/// app-server). No model turn runs there, so nothing is lost by not starting the person's MCP
/// servers, apps or plugins for every probe. Never used for a session or pane.
pub(crate) const PROBE_CONFIG: &[&str] = &[
    #[cfg(target_os = "windows")]
    "windows.sandbox='unelevated'",
    "mcp_servers={}",
    "features.apps=false",
    "features.plugins=false",
    "features.hooks=false",
];

/// Overrides KalCode no longer passes because they removed native Codex tools. Tests keep them out.
pub const TOOL_STRIPPING: &[&str] = &[
    "mcp_servers={}",
    "web_search='disabled'",
    "shell_environment_policy.inherit='core'",
    "sandbox_workspace_write.network_access=false",
    "features.apps=false",
    "features.plugins=false",
    "features.hooks=false",
    "features.skill_mcp_dependency_install=false",
    "features.multi_agent=false",
    "features.multi_agent_v2=false",
    "features.browser_use=false",
    "features.computer_use=false",
    "features.in_app_browser=false",
    "features.image_generation=false",
    "--ignore-user-config",
    "--ignore-rules",
];

/// Flags and values KalCode never passes to Codex, in any mode.
pub const FORBIDDEN: &[&str] = &[
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust",
    "--approve-for-me",
    "--add-dir",
    "--oss",
    "--worktree",
];

/// Set for every turn, in every mode.
const COMMON: &[&str] = &["exec", "--json"];

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
    for value in POLICY_CONFIG {
        parts.extend(["-c", value]);
    }
    parts.join(" ")
}

/// Codex keeps the person's own tools, config and rules in every mode (native provider parity).
const NATIVE: &str =
    "Your Codex tools, MCP servers, web search and rules work as in your terminal.";

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
                "Workspace writes use Codex's native on-request approval prompt. {NATIVE} \
                 {NOT_ENFORCED}"
            ),
        ),
        map(
            PermissionMode::Auto,
            format!(
                "Workspace writes run without approval prompts inside Codex's native sandbox. \
                 {NATIVE} {NOT_ENFORCED}"
            ),
        ),
        map(
            PermissionMode::Bypass,
            format!(
                "Uses Codex's explicit danger-full-access sandbox with approval prompts disabled. \
                 {NATIVE} {NOT_ENFORCED}"
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

/// Codex reasoning-effort values shown when runtime model metadata is unavailable. Runtime model
/// catalogs remain authoritative and may advertise newer bounded tokens.
pub const EFFORT_LEVELS: &[&str] = &["minimal", "low", "medium", "high", "xhigh"];

pub fn valid_effort_name(effort: &str) -> bool {
    !effort.is_empty()
        && effort.len() <= 32
        && effort.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
        })
}

/// Whether `model` is a Codex runtime model selector. The supported app-server catalog bounds
/// selectors to 512 bytes; launch passes this as one direct argv element without a shell.
pub fn valid_model_name(model: &str) -> bool {
    safe_model_selector(model)
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
    // Apply after inherited profile/project overrides so stale limits cannot win.
    out.extend([OsString::from("-c"), OsString::from(SUBAGENT_CONFIG)]);
    out.extend(sandbox_args(mode).into_iter().map(OsString::from));
    if let Some(model) = model {
        if !valid_model_name(model) {
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

    #[test]
    fn codex_subagents_are_ten_for_new_and_resumed_turns() {
        for resume in [None, Some("01234567-89ab-4cde-8fab-0123456789ab")] {
            for previous in [3, 15, 30] {
                let args = exec_args_with_overrides(
                    PermissionMode::Approve,
                    None,
                    None,
                    resume,
                    &[
                        "-c".into(),
                        format!("agents.max_concurrent_threads_per_session={previous}").into(),
                    ],
                )
                .expect("args");
                assert!(!args.iter().any(|value| {
                    value == "features.multi_agent=false"
                        || value == "features.multi_agent_v2=false"
                }));
                let effective = args
                    .windows(2)
                    .filter(|pair| pair[0] == "-c")
                    .filter_map(|pair| pair[1].to_str())
                    .rfind(|value| value.starts_with("agents.max_concurrent_threads_per_session="));
                assert_eq!(
                    effective,
                    Some("agents.max_concurrent_threads_per_session=10")
                );
            }
        }
    }

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
    fn windows_sandbox_backend_is_available_for_new_and_resumed_turns() {
        for mode in ALL {
            for resume in [None, Some("0192f3c4-0000-7000-8000-000000000000")] {
                let argv = args(mode, resume);
                let configs = after(&argv, "-c");
                assert_eq!(
                    configs.contains(&"windows.sandbox='unelevated'"),
                    cfg!(target_os = "windows"),
                    "{mode:?} must select the Windows sandbox without changing its permission mode"
                );
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
            // Native tools and the person's own config stay (MCP, web search, plugins, env).
            for stripping in TOOL_STRIPPING {
                assert!(
                    !args.iter().any(|a| a == stripping),
                    "{mode:?} strips a native tool with {stripping}"
                );
            }
            // The person's own execpolicy rules apply, as in a native terminal.
            assert!(!args.iter().any(|a| a == "--ignore-rules"), "{mode:?}");
            if mode != PermissionMode::Plan {
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
        let future_model_args =
            exec_args(PermissionMode::Approve, Some("future+tools"), None, None)
                .expect("future runtime model");
        assert!(
            future_model_args
                .windows(2)
                .any(|pair| pair == ["--model", "future+tools"])
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
        for effort in
            EFFORT_LEVELS
                .iter()
                .copied()
                .chain(["max", "ultra", "future-fast", "reasoning_7"])
        {
            assert!(exec_args(PermissionMode::Approve, None, Some(effort), None).is_ok());
        }
        for effort in ["", "HIGH", "high' -c web_search='live", "future.effort"] {
            assert_eq!(
                exec_args(PermissionMode::Approve, None, Some(effort), None),
                Err(CodexExecError::InvalidEffort)
            );
        }
        let too_long_effort = "e".repeat(33);
        assert_eq!(
            exec_args(PermissionMode::Approve, None, Some(&too_long_effort), None),
            Err(CodexExecError::InvalidEffort)
        );

        let catalog_limit_model = "m".repeat(512);
        assert!(
            exec_args(
                PermissionMode::Approve,
                Some(&catalog_limit_model),
                None,
                None
            )
            .is_ok()
        );
        let oversized_model = "m".repeat(513);
        assert_eq!(
            exec_args(PermissionMode::Approve, Some(&oversized_model), None, None),
            Err(CodexExecError::InvalidModel)
        );
    }
}
