//! Command lines for Claude Code headless sessions, and the KalCode → Claude Code permission
//! mapping. Everything here is derived from the official CLI reference
//! (https://code.claude.com/docs/en/cli-reference) and permission-mode documentation
//! (https://code.claude.com/docs/en/permission-modes); see docs/PROVIDERS.md.
//!
//! Invariant: no KalCode mode maps to broader authority than it implies. KalCode cannot answer
//! Claude Code's permission prompts yet, so every session passes `--permission-prompts none`
//! (anything that would prompt is denied) and KalCode-owned deny rules ([`deny_rules`]) that
//! the user's own Claude Code allow rules and hooks cannot override.
//!
//! What this does **not** do: route each tool call through KalCode's permission engine. Commands
//! other than the denied ones are decided by Claude Code's mode and the user's own Claude Code
//! user settings. Per-action KalCode approvals arrive with provider panes and the hook bridge
//! (docs/PROVIDER_PANES.md).

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

/// Programs that act on remote systems: KalCode classifies every use as `cloud.modify`,
/// `deploy.production` or `messaging.send` (docs/PERMISSIONS.md §2), which no mode allows
/// without an approval. KalCode can't answer Claude Code's prompts yet, so they are denied.
const REMOTE_PROGRAMS: &[&str] = &[
    "gh",
    "vercel",
    "netlify",
    "wrangler",
    "firebase",
    "flyctl",
    "fly",
    "heroku",
    "railway",
    "surge",
    "aws",
    "gcloud",
    "az",
    "azd",
    "doctl",
    "kubectl",
    "helm",
    "terraform",
    "tofu",
    "pulumi",
    "cdk",
    "sam",
    "serverless",
    "sls",
    "eb",
    "stripe",
    "ssh",
    "scp",
    "sftp",
];

/// Subcommands that publish, push or deploy (`git.push`, `deploy.production`).
const REMOTE_COMMANDS: &[&str] = &[
    "git push",
    "git send-pack",
    "git http-push",
    "git svn dcommit",
    "git p4 submit",
    "git subtree push",
    "npm publish",
    "pnpm publish",
    "yarn publish",
    "yarn npm publish",
    "bun publish",
    "cargo publish",
    "twine upload",
    "poetry publish",
    "uv publish",
    "flit publish",
    "hatch publish",
    "gem push",
    "dotnet nuget push",
    "nuget push",
    "mvn deploy",
    "docker push",
    "podman push",
];

/// Git and npm accept options before the subcommand (`git -C . push`, `npm --otp 1 publish`).
/// `git * push *` also denies harmless commands that merely contain the word `push` after
/// another subcommand; stricter is acceptable.
const REMOTE_OPTION_FORMS: &[&str] = &["git * push", "npm * publish"];

/// Credential files (KalCode's `credentials.access` scope, which asks in every mode). A `Read`
/// deny rule also blocks editing the path, and applies to Claude Code's file tools and to the
/// file commands it recognizes in Bash (`cat`, `head`, `sed`, redirections…), not to a script
/// that opens files itself (https://code.claude.com/docs/en/permissions#read-and-edit).
/// `//**/` matches on every drive; `~/` is the home folder.
const CREDENTIAL_PATHS: &[&str] = &[
    "//**/.env",
    "//**/.env.*",
    "//**/.npmrc",
    "//**/.pypirc",
    "//**/.netrc",
    "//**/_netrc",
    "//**/.git-credentials",
    "//**/id_rsa*",
    "//**/id_ecdsa*",
    "//**/id_ed25519*",
    "//**/secrets.json",
    "//**/credentials.json",
    "~/.ssh/**",
    "~/.aws/**",
    "~/.azure/**",
    "~/.config/gcloud/**",
    "~/.kube/**",
    "~/.docker/config.json",
];

/// The shell tools a deny rule must cover. Claude Code canonicalizes PowerShell aliases and
/// matches case-insensitively (https://code.claude.com/docs/en/permissions#powershell).
const SHELL_TOOLS: &[&str] = &["Bash", "PowerShell"];

/// Tools that change files or reach the network. In Approve, Auto and Custom KalCode would ask
/// before these (`filesystem.write`, `network.*`); nobody can answer yet, so they are removed.
/// Plan removes them too (Plan never edits; `--restricted` already drops `WebFetch`).
const ASK_FIRST_TOOLS: &[&str] = &["Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"];

/// KalCode-owned deny rules for a mode, passed with `--disallowedTools`
/// (https://code.claude.com/docs/en/cli-reference). A deny rule from any source wins over
/// allow rules from every other source, including the user's own settings, and over a
/// `PreToolUse` hook that returns "allow"
/// (https://code.claude.com/docs/en/permissions#settings-precedence and
/// #extend-permissions-with-hooks). So whatever the user's Claude Code settings allow, these
/// never run in a KalCode thread.
///
/// Limit (documented, not hidden): a scoped Bash rule matches the command text as Claude writes
/// it, after splitting compound commands and stripping simple wrappers. The same program started
/// another way (`/usr/bin/git push`, `sh -c 'git push'`) is not matched; it is then decided by
/// the Claude Code mode, which refuses it because nobody can approve, unless the user's own
/// Claude Code allow rules cover it (https://code.claude.com/docs/en/permissions#bash-rule-limits).
pub fn deny_rules(mode: PermissionMode) -> Vec<String> {
    let mut rules = Vec::new();
    if !matches!(mode, PermissionMode::Bypass) {
        rules.extend(ASK_FIRST_TOOLS.iter().map(|t| (*t).to_owned()));
    }
    rules.extend(CREDENTIAL_PATHS.iter().map(|p| format!("Read({p})")));
    for tool in SHELL_TOOLS {
        for program in REMOTE_PROGRAMS {
            rules.push(format!("{tool}({program} *)"));
        }
        for command in REMOTE_COMMANDS.iter().chain(REMOTE_OPTION_FORMS) {
            rules.push(format!("{tool}({command} *)"));
        }
        // `git * push *` has two wildcards, so it doesn't match a bare `git -C . push`.
        for command in REMOTE_OPTION_FORMS {
            rules.push(format!("{tool}({command})"));
        }
    }
    rules
}

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

/// How the KalCode deny rules appear in the mapping shown to users: the removed tools by name,
/// then the number of remote-action rules.
fn deny_summary(mode: PermissionMode) -> String {
    let rules = deny_rules(mode);
    let tools: Vec<&str> = rules
        .iter()
        .map(String::as_str)
        .filter(|r| !r.contains('('))
        .collect();
    let credentials = rules.iter().filter(|r| r.starts_with("Read(")).count();
    let scoped = rules.len() - tools.len() - credentials;
    // One token after the flag, so the Providers page shows it as one group.
    let mut parts: Vec<String> = tools.iter().map(|t| (*t).to_owned()).collect();
    parts.push(format!("{credentials}-credential-file-rules"));
    parts.push(format!("{scoped}-remote-action-rules"));
    format!("--disallowedTools {}", parts.join(","))
}

/// What KalCode enforces for Claude Code in every mode today.
const ENFORCED_BY_KALCODE: &str = "KalCode always denies git push, package publishes, deploy and \
                                   cloud CLIs, gh and ssh, and reading credential files such as \
                                   .env and SSH keys, whatever your Claude Code settings allow.";
/// What it does not enforce (docs/PROVIDERS.md §5). States the current build only: no roadmap.
const NOT_YET_ENFORCED: &str = "Other commands follow Claude Code's own rules, including your \
                                Claude Code user settings (allow rules and hooks), and a push \
                                written in an unusual form is decided by them. KalCode doesn't \
                                ask you about each of these actions, and Custom rules don't \
                                apply to them.";

/// The mapping shown to users. `provider_setting` is generated from the argv, so the
/// description can never drift from what KalCode actually runs.
pub fn permission_mappings() -> Vec<PermissionMapping> {
    let setting = |mode| {
        format!(
            "{} --permission-prompts none {}",
            permission_args(mode).join(" "),
            deny_summary(mode)
        )
    };
    vec![
        PermissionMapping {
            mode: PermissionMode::Plan,
            fidelity: MappingFidelity::ApproximateStricter,
            provider_setting: setting(PermissionMode::Plan),
            notes: format!(
                "Claude Code can read and plan but has no tools that run commands, edit files or \
                 fetch web pages, and your Claude Code settings are not loaded. \
                 {ENFORCED_BY_KALCODE}"
            ),
        },
        PermissionMapping {
            mode: PermissionMode::Approve,
            fidelity: MappingFidelity::ApproximateStricter,
            provider_setting: setting(PermissionMode::Approve),
            notes: format!(
                "Reads and Claude Code's read-only commands run. Edits and web access are \
                 removed, and anything else that would ask is refused, because KalCode doesn't \
                 answer Claude Code's approval prompts. {ENFORCED_BY_KALCODE} \
                 {NOT_YET_ENFORCED}"
            ),
        },
        PermissionMapping {
            mode: PermissionMode::Auto,
            fidelity: MappingFidelity::ApproximateStricter,
            provider_setting: setting(PermissionMode::Auto),
            notes: format!(
                "Runs like Approve. Claude Code's own auto mode is not used, because its \
                 classifier's decisions are not your KalCode policy. {ENFORCED_BY_KALCODE} \
                 {NOT_YET_ENFORCED}"
            ),
        },
        PermissionMapping {
            mode: PermissionMode::Bypass,
            fidelity: MappingFidelity::ApproximateStricter,
            provider_setting: setting(PermissionMode::Bypass),
            notes: format!(
                "File edits and common file commands in the workspace run without asking; \
                 anything else that would ask is refused. Claude Code's bypassPermissions mode \
                 is never used. {ENFORCED_BY_KALCODE} {NOT_YET_ENFORCED}"
            ),
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

/// Whether `model` is a model name KalCode passes to a provider (shared with interactive panes).
pub fn valid_model_name(model: &str) -> bool {
    valid_model(model)
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
    // One argv element per rule. The list is variadic; it is always followed by another option
    // (`--session-id` / `--resume` come last), never by a positional argument.
    out.push("--disallowedTools".into());
    out.extend(deny_rules(args.mode).into_iter().map(OsString::from));
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

    /// The KalCode rules exactly as passed: the argv elements after `--disallowedTools`, up to
    /// the next option.
    fn passed_rules(args: &[String]) -> Vec<String> {
        let start = args
            .iter()
            .position(|a| a == "--disallowedTools")
            .expect("--disallowedTools")
            + 1;
        let end = args[start..]
            .iter()
            .position(|a| a.starts_with("--"))
            .map(|i| start + i)
            .expect("the variadic list is followed by another option");
        args[start..end].to_vec()
    }

    /// Claude Code's documented Bash/PowerShell rule matching
    /// (https://code.claude.com/docs/en/permissions#wildcard-patterns): `*` matches any text;
    /// a single trailing ` *` also matches the bare command. Enough to check coverage.
    fn rule_matches(rule: &str, tool: &str, command: &str) -> bool {
        let Some(pattern) = rule
            .strip_prefix(tool)
            .and_then(|r| r.strip_prefix('('))
            .and_then(|r| r.strip_suffix(')'))
        else {
            return rule == tool;
        };
        fn glob(p: &str, t: &str) -> bool {
            match p.split_once('*') {
                None => p == t,
                Some((head, rest)) => {
                    t.starts_with(head)
                        && (head.len()..=t.len())
                            .any(|i| t.is_char_boundary(i) && glob(rest, &t[i..]))
                }
            }
        }
        glob(pattern, command)
            || (pattern.matches('*').count() == 1
                && pattern
                    .strip_suffix(" *")
                    .is_some_and(|bare| bare == command))
    }

    #[test]
    fn every_mode_denies_remote_consequential_commands_in_both_shells() {
        let remote = [
            "git push",
            "git push origin main",
            "git push --force",
            "git -C . push",
            "git -C . push origin main",
            "git --no-pager push",
            "git send-pack origin main",
            "git subtree push --prefix x origin main",
            "git lfs push origin main",
            "npm publish",
            "npm --otp 123 publish",
            "pnpm publish --access public",
            "yarn npm publish",
            "cargo publish",
            "twine upload dist/*",
            "docker push registry/app",
            "gh pr create --fill",
            "gh repo sync",
            "gh api -X POST repos/o/r/issues",
            "vercel --prod",
            "wrangler deploy",
            "netlify deploy --prod",
            "aws s3 sync . s3://bucket",
            "kubectl apply -f deploy.yaml",
            "terraform apply",
            "ssh host rm -rf /",
            "scp secrets host:",
        ];
        for mode in ALL {
            let rules = passed_rules(&args_for(mode));
            assert_eq!(rules, deny_rules(mode), "{mode:?}");
            for tool in ["Bash", "PowerShell"] {
                for command in remote {
                    assert!(
                        rules.iter().any(|r| rule_matches(r, tool, command)),
                        "{mode:?}: {tool} `{command}` is not denied"
                    );
                }
            }
            // Local work is not caught by the remote rules.
            for command in ["git status", "git commit -m fix", "npm test", "cargo build"] {
                assert!(
                    !rules
                        .iter()
                        .filter(|r| r.contains('('))
                        .any(|r| rule_matches(r, "Bash", command)),
                    "{mode:?}: `{command}` should not be denied"
                );
            }
            for rule in &rules {
                assert!(!rule.starts_with('-'), "{rule}");
                assert!(!rule.contains(','), "{rule}");
            }
        }
    }

    #[test]
    fn modes_that_would_ask_remove_edit_and_web_tools() {
        for mode in [
            PermissionMode::Plan,
            PermissionMode::Approve,
            PermissionMode::Auto,
            PermissionMode::Custom,
        ] {
            let rules = deny_rules(mode);
            for tool in ["Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"] {
                assert!(rules.iter().any(|r| r == tool), "{mode:?} keeps {tool}");
            }
        }
        for mode in ALL {
            let rules = deny_rules(mode);
            for path in ["//**/.env", "~/.ssh/**", "~/.aws/**", "//**/.npmrc"] {
                assert!(
                    rules.iter().any(|r| *r == format!("Read({path})")),
                    "{mode:?} can read {path}"
                );
            }
        }
        // Bypass keeps local edits (acceptEdits); remote actions stay denied.
        let bypass = deny_rules(PermissionMode::Bypass);
        assert!(!bypass.iter().any(|r| r == "Edit" || r == "Write"));
        assert!(bypass.iter().any(|r| r == "Bash(git push *)"));
    }

    #[test]
    fn mappings_state_what_is_and_is_not_enforced() {
        for mapping in permission_mappings() {
            assert!(
                mapping.provider_setting.contains("--disallowedTools"),
                "{:?}",
                mapping.mode
            );
            assert!(
                mapping.notes.contains("KalCode always denies git push"),
                "{:?}",
                mapping.mode
            );
            if mapping.mode != PermissionMode::Plan {
                // Plan ignores the user's Claude Code settings (`--restricted`); the other
                // modes load them, and the note must say so.
                assert!(
                    mapping.notes.contains("Claude Code user settings"),
                    "{:?}",
                    mapping.mode
                );
            }
            assert!(!mapping.notes.contains("most restrictive"));
            // States the build the user has, never a roadmap (B8 visual audit D10).
            assert!(!mapping.notes.contains(" yet"), "{:?}", mapping.mode);
            assert!(!mapping.notes.contains("arrive with"), "{:?}", mapping.mode);
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
