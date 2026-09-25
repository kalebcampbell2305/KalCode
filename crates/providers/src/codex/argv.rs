//! `codex exec` argument vectors and the KalCode permission mapping for headless Codex turns.
//!
//! Verified 2026-09-25 against the installed `codex exec --help` and `codex exec resume --help`
//! (codex-cli 0.155.1) and the official docs (docs/PROVIDERS.md §11 [5][7][13][14]):
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
pub const MINIMUM_VERSION: Version = Version::new(0, 155, 0);

/// Flags and values KalCode never passes to Codex, in any mode.
pub const FORBIDDEN: &[&str] = &[
    "danger-full-access",
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust",
    "--approve-for-me",
    "--search",
    "--add-dir",
    "--oss",
    "--worktree",
    "on-request",
    "untrusted",
    "network_access=true",
    "web_search='live'",
];

/// Set for every turn, in every mode.
const COMMON: &[&str] = &[
    "exec",
    "--json",
    // Nothing can wait for a person: anything that would ask is refused and returned to the
    // model instead.
    "-c",
    "approval_policy='never'",
    // No web search from headless threads (KalCode's Claude Code mapping refuses web tools too).
    "-c",
    "web_search='disabled'",
    // Commands Codex runs get only the core environment (HOME, PATH, …), not provider keys.
    "-c",
    "shell_environment_policy.inherit='core'",
    // Repository-supplied execpolicy rules never grant anything (K4); see PROVIDERS.md §5.
    "--ignore-rules",
];

/// The sandbox part of the mapping. Only Bypass writes, and never with network access.
pub fn sandbox_args(mode: PermissionMode) -> Vec<&'static str> {
    match mode {
        PermissionMode::Bypass => vec![
            "--sandbox",
            "workspace-write",
            "-c",
            "sandbox_workspace_write.network_access=false",
        ],
        PermissionMode::Plan
        | PermissionMode::Approve
        | PermissionMode::Auto
        | PermissionMode::Custom => vec!["--sandbox", "read-only", "--skip-git-repo-check"],
    }
}

/// The permission-relevant flags as shown on the Providers page (generated from the argv, so
/// the display can't drift from what runs).
pub fn permission_setting(mode: PermissionMode) -> String {
    let mut parts: Vec<&str> = sandbox_args(mode);
    parts.extend(COMMON.iter().skip(2).copied());
    parts.join(" ")
}

const NOT_ENFORCED: &str = "Codex has no deny-rule flag: KalCode can't stop reads of credential \
                            files inside the workspace, and remote actions are stopped by the \
                            sandbox's network block, not by KalCode rules.";

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
                "Runs like Plan: edits would need an approval KalCode can't give Codex yet, so \
                 they're refused instead of asking. {NOT_ENFORCED}"
            ),
        ),
        map(
            PermissionMode::Auto,
            format!("Runs like Approve. {NOT_ENFORCED}"),
        ),
        map(
            PermissionMode::Bypass,
            format!(
                "Edits and commands inside the workspace, with network access off. \
                 danger-full-access is never used. {NOT_ENFORCED}"
            ),
        ),
    ]
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CodexExecError {
    #[error("the model name is not valid")]
    InvalidModel,
    #[error("the session id is not valid")]
    InvalidSessionId,
}

/// The argv (after the program) for one headless turn. The prompt is written to stdin (`-`).
pub fn exec_args(
    mode: PermissionMode,
    model: Option<&str>,
    resume: Option<&str>,
) -> Result<Vec<OsString>, CodexExecError> {
    let mut out: Vec<OsString> = COMMON.iter().map(OsString::from).collect();
    out.extend(sandbox_args(mode).into_iter().map(OsString::from));
    if let Some(model) = model {
        if !crate::claude::argv::valid_model_name(model) {
            return Err(CodexExecError::InvalidModel);
        }
        out.push("--model".into());
        out.push(model.into());
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
        exec_args(mode, Some("gpt-5"), resume)
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
            let expected = if mode == PermissionMode::Bypass {
                "workspace-write"
            } else {
                "read-only"
            };
            assert_eq!(sandbox[0], expected, "{mode:?}");
            let configs = after(&args, "-c");
            assert!(configs.contains(&"approval_policy='never'"), "{mode:?}");
            assert!(configs.contains(&"web_search='disabled'"), "{mode:?}");
            assert!(configs.contains(&"shell_environment_policy.inherit='core'"));
            assert!(args.iter().any(|a| a == "--ignore-rules"));
            if mode == PermissionMode::Bypass {
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
        assert_eq!(
            args(PermissionMode::Plan, None),
            args(PermissionMode::Auto, None)
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
            exec_args(PermissionMode::Approve, None, Some("--last")),
            Err(CodexExecError::InvalidSessionId)
        );
        assert_eq!(
            exec_args(PermissionMode::Approve, Some("-c"), None),
            Err(CodexExecError::InvalidModel)
        );
    }
}
