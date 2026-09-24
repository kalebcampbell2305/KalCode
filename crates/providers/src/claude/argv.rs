//! Command lines for Claude Code headless sessions, and the KalCode → Claude Code permission
//! mapping. Everything here is derived from the official CLI reference
//! (https://code.claude.com/docs/en/cli-reference) and permission-mode documentation
//! (https://code.claude.com/docs/en/permission-modes); see docs/PROVIDERS.md.
//!
//! Invariant: no KalCode mode maps to broader authority than it implies. In Z2 KalCode cannot
//! answer permission prompts yet (host approvals arrive with the permission engine in Z4), so
//! every session passes `--permission-prompts none`: anything that would prompt is denied.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use kalcode_contracts::agent::{MappingFidelity, PermissionMapping};
use kalcode_contracts::permissions::PermissionMode;

use crate::version::Version;

/// `--permission-prompts` needs v2.1.259; `--restricted` needs v2.1.248; the `system/init`
/// `capabilities` list needs v2.1.205.
pub const MINIMUM_VERSION: Version = Version::new(2, 1, 259);

/// Flags every KalCode session passes, in every mode.
const COMMON: &[&str] = &[
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    // Nobody can answer a prompt yet (Z4): deny instead of waiting forever.
    "--permission-prompts",
    "none",
    // MCP servers from a repository's .mcp.json would start with no approval in -p mode and
    // could add tools with authority KalCode can't see; only servers KalCode passes are used.
    "--strict-mcp-config",
];

/// Hooks and allow rules in a repository's `.claude/settings*.json` run without a trust
/// prompt in `-p` mode; KalCode loads only the user's own settings (managed settings always
/// apply).
const USER_SETTINGS_ONLY: &[&str] = &["--setting-sources", "user"];

/// Provider-native flags for a KalCode permission mode.
pub fn permission_args(mode: PermissionMode) -> Vec<&'static str> {
    match mode {
        // Restricted mode removes every tool that runs commands or code, and WebFetch, confines
        // file tools to the working directory and loads no user/project settings; plan mode
        // blocks edits. Reads only.
        PermissionMode::Plan => vec!["--restricted", "--permission-mode", "plan"],
        // Manual mode: reads and Claude Code's built-in read-only commands run; everything that
        // would ask is denied (no host approvals yet). Claude Code's own `auto` classifier is
        // never used: its decisions are not KalCode policy.
        PermissionMode::Approve | PermissionMode::Auto | PermissionMode::Custom => {
            let mut args = USER_SETTINGS_ONLY.to_vec();
            args.extend(["--permission-mode", "default"]);
            args
        }
        // File edits and common filesystem commands inside the working directory. Other
        // commands and network are denied. `bypassPermissions` is never used: it would also
        // allow remote-consequential actions such as `git push`.
        PermissionMode::Bypass => {
            let mut args = USER_SETTINGS_ONLY.to_vec();
            args.extend(["--permission-mode", "acceptEdits"]);
            args
        }
    }
}

/// The mapping shown to users. `provider_setting` is generated from [`permission_args`], so the
/// description can never drift from what KalCode actually runs.
pub fn permission_mappings() -> Vec<PermissionMapping> {
    let setting = |mode| permission_args(mode).join(" ") + " --permission-prompts none";
    vec![
        PermissionMapping {
            mode: PermissionMode::Plan,
            fidelity: MappingFidelity::ApproximateStricter,
            provider_setting: setting(PermissionMode::Plan),
            notes: "Claude Code can read and plan but has no tools that run commands or fetch web \
                    pages, so even read-only commands are unavailable. Edits are blocked."
                .into(),
        },
        PermissionMapping {
            mode: PermissionMode::Approve,
            fidelity: MappingFidelity::ApproximateStricter,
            provider_setting: setting(PermissionMode::Approve),
            notes: "Reads and read-only commands run. Edits and other commands are denied \
                    instead of asking, until KalCode can answer Claude Code's permission prompts."
                .into(),
        },
        PermissionMapping {
            mode: PermissionMode::Auto,
            fidelity: MappingFidelity::ApproximateStricter,
            provider_setting: setting(PermissionMode::Auto),
            notes: "Runs like Approve. Claude Code's own auto mode is not used, because its \
                    classifier's decisions are not your KalCode policy."
                .into(),
        },
        PermissionMapping {
            mode: PermissionMode::Bypass,
            fidelity: MappingFidelity::ApproximateStricter,
            provider_setting: setting(PermissionMode::Bypass),
            notes: "File edits and common file commands in the workspace run without asking. \
                    Other commands and network access are denied. Claude Code's \
                    bypassPermissions mode is never used, because it would also allow actions \
                    like git push."
                .into(),
        },
    ]
}

/// How a session starts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionStart {
    /// A new conversation with the id KalCode assigns (`--session-id`, must be a UUID).
    New { session_id: String },
    /// Continue an earlier conversation (`--resume <id>`).
    Resume { session_id: String },
}

#[derive(Debug, Clone)]
pub struct SessionArgs {
    pub model: Option<String>,
    pub mode: PermissionMode,
    pub start: SessionStart,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ArgsError {
    #[error("the model name is not valid")]
    InvalidModel,
    #[error("the session id is not valid")]
    InvalidSessionId,
    #[error("the working directory must be an existing absolute folder")]
    InvalidWorkingDirectory,
}

/// Model names are provider aliases or full names (`sonnet`, `opus[1m]`, `claude-sonnet-5`).
fn valid_model(model: &str) -> bool {
    !model.is_empty()
        && model.len() <= 128
        && !model.starts_with('-')
        && model
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:[]-".contains(&b))
}

/// Session ids KalCode passes are canonical UUIDs (its own, or ones Claude Code reported).
fn valid_session_id(id: &str) -> bool {
    kalcode_contracts::ids::is_valid_id(id)
}

/// Builds the complete argument vector for a session. Each value is its own argv element; no
/// shell is involved.
pub fn session_args(args: &SessionArgs) -> Result<Vec<OsString>, ArgsError> {
    let mut out: Vec<OsString> = COMMON.iter().map(OsString::from).collect();
    out.extend(permission_args(args.mode).into_iter().map(OsString::from));
    if let Some(model) = &args.model {
        if !valid_model(model) {
            return Err(ArgsError::InvalidModel);
        }
        out.push("--model".into());
        out.push(model.into());
    }
    let (flag, id) = match &args.start {
        SessionStart::New { session_id } => ("--session-id", session_id),
        SessionStart::Resume { session_id } => ("--resume", session_id),
    };
    if !valid_session_id(id) {
        return Err(ArgsError::InvalidSessionId);
    }
    out.push(flag.into());
    out.push(id.into());
    Ok(out)
}

/// The working directory must be native-resolved, absolute and existing.
pub fn working_directory(path: &str) -> Result<PathBuf, ArgsError> {
    let path = Path::new(path);
    if path.is_absolute() && path.is_dir() {
        Ok(path.to_path_buf())
    } else {
        Err(ArgsError::InvalidWorkingDirectory)
    }
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

    fn args_for(mode: PermissionMode) -> Vec<String> {
        session_args(&SessionArgs {
            model: None,
            mode,
            start: SessionStart::New {
                session_id: "0192f3c4-0000-7000-8000-000000000000".into(),
            },
        })
        .expect("args")
        .into_iter()
        .map(|a| a.into_string().expect("utf8"))
        .collect()
    }

    fn value_after(args: &[String], flag: &str) -> Option<String> {
        args.iter()
            .position(|a| a == flag)
            .and_then(|i| args.get(i + 1).cloned())
    }

    /// Claude Code modes ordered by how much runs without a prompt (permission-modes docs).
    fn claude_rank(mode: &str) -> u8 {
        match mode {
            "plan" => 0,
            "dontAsk" => 1,
            "default" | "manual" => 2,
            "acceptEdits" => 3,
            "auto" => 4,
            _ => u8::MAX, // bypassPermissions or anything unknown: broadest.
        }
    }

    #[test]
    fn no_mode_maps_to_broader_authority() {
        // The broadest Claude Code mode each KalCode mode may use.
        let cap = |mode| match mode {
            PermissionMode::Plan => 0,
            PermissionMode::Approve | PermissionMode::Auto | PermissionMode::Custom => 2,
            PermissionMode::Bypass => 3,
        };
        for mode in ALL {
            let args = args_for(mode);
            let claude_mode = value_after(&args, "--permission-mode").expect("mode flag");
            assert!(
                claude_rank(&claude_mode) <= cap(mode),
                "{mode:?} -> {claude_mode}"
            );
            for forbidden in [
                "--dangerously-skip-permissions",
                "--allow-dangerously-skip-permissions",
                "bypassPermissions",
                "--allowedTools",
                "--allowed-tools",
                "--add-dir",
            ] {
                assert!(
                    !args.iter().any(|a| a == forbidden),
                    "{mode:?} uses {forbidden}"
                );
            }
            // Without host approvals, prompts must be denied, never left waiting or auto-run.
            assert_eq!(
                value_after(&args, "--permission-prompts").as_deref(),
                Some("none")
            );
            assert!(args.iter().any(|a| a == "--strict-mcp-config"), "{mode:?}");
        }
    }

    #[test]
    fn plan_removes_command_tools_and_repository_settings() {
        let args = args_for(PermissionMode::Plan);
        assert!(args.iter().any(|a| a == "--restricted"));
        assert_eq!(
            value_after(&args, "--permission-mode").as_deref(),
            Some("plan")
        );
    }

    #[test]
    fn non_plan_modes_ignore_repository_settings() {
        for mode in [
            PermissionMode::Approve,
            PermissionMode::Auto,
            PermissionMode::Bypass,
        ] {
            assert_eq!(
                value_after(&args_for(mode), "--setting-sources").as_deref(),
                Some("user"),
                "{mode:?}"
            );
        }
    }

    #[test]
    fn mapping_descriptions_match_the_flags_actually_used() {
        let mappings = permission_mappings();
        assert_eq!(mappings.len(), 4);
        for mapping in mappings {
            let expected = permission_args(mapping.mode).join(" ");
            assert!(
                mapping.provider_setting.starts_with(&expected),
                "{:?}: {} vs {expected}",
                mapping.mode,
                mapping.provider_setting
            );
            assert_ne!(
                mapping.fidelity,
                MappingFidelity::Exact,
                "no host approvals in Z2"
            );
        }
    }

    #[test]
    fn session_is_headless_stream_json() {
        let args = args_for(PermissionMode::Approve);
        assert_eq!(args[0], "-p");
        assert_eq!(
            value_after(&args, "--input-format").as_deref(),
            Some("stream-json")
        );
        assert_eq!(
            value_after(&args, "--output-format").as_deref(),
            Some("stream-json")
        );
        assert_eq!(
            value_after(&args, "--session-id").as_deref(),
            Some("0192f3c4-0000-7000-8000-000000000000")
        );
    }

    #[test]
    fn resume_uses_the_documented_flag() {
        let args = session_args(&SessionArgs {
            model: Some("sonnet".into()),
            mode: PermissionMode::Approve,
            start: SessionStart::Resume {
                session_id: "5d7a3c0e-8a1b-4c7e-9f00-1234567890ab".into(),
            },
        })
        .expect("args");
        let args: Vec<_> = args
            .into_iter()
            .map(|a| a.into_string().expect("utf8"))
            .collect();
        assert_eq!(
            value_after(&args, "--resume").as_deref(),
            Some("5d7a3c0e-8a1b-4c7e-9f00-1234567890ab")
        );
        assert_eq!(value_after(&args, "--model").as_deref(), Some("sonnet"));
        assert!(!args.iter().any(|a| a == "--session-id"));
    }

    #[test]
    fn rejects_values_that_could_be_read_as_flags() {
        let base = SessionArgs {
            model: None,
            mode: PermissionMode::Approve,
            start: SessionStart::New {
                session_id: "0192f3c4-0000-7000-8000-000000000000".into(),
            },
        };
        for model in [
            "--dangerously-skip-permissions",
            "",
            "sonnet opus",
            "a;b",
            "x\n",
        ] {
            let args = SessionArgs {
                model: Some(model.into()),
                ..base.clone()
            };
            assert_eq!(
                session_args(&args),
                Err(ArgsError::InvalidModel),
                "{model:?}"
            );
        }
        for model in ["sonnet", "opus[1m]", "claude-sonnet-5", "haiku"] {
            let args = SessionArgs {
                model: Some(model.into()),
                ..base.clone()
            };
            assert!(session_args(&args).is_ok(), "{model:?}");
        }
        for id in ["--resume", "latest", "", "../x"] {
            let args = SessionArgs {
                start: SessionStart::Resume {
                    session_id: id.into(),
                },
                ..base.clone()
            };
            assert_eq!(
                session_args(&args),
                Err(ArgsError::InvalidSessionId),
                "{id:?}"
            );
        }
    }

    #[test]
    fn working_directory_must_be_absolute_and_exist() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(working_directory(dir.path().to_str().expect("utf8")).is_ok());
        assert_eq!(
            working_directory("relative/path"),
            Err(ArgsError::InvalidWorkingDirectory)
        );
        assert_eq!(
            working_directory(dir.path().join("missing").to_str().expect("utf8")),
            Err(ArgsError::InvalidWorkingDirectory)
        );
    }
}
