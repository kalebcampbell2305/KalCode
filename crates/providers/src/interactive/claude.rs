//! Claude Code in a pane: the real, unmodified `claude` TUI, launched with KalCode's settings
//! file (hooks that run `kalcode-hook`), the Z2 deny floor, and a permission mode never broader
//! than the thread's KalCode mode (docs/PROVIDER_PANES.md §3–4).
//!
//! Verified on 2026-10-03 against the installed `claude --help` (2.1.288) and
//! https://code.claude.com/docs/en/cli-reference, /hooks, /permissions and /settings:
//! - `--permission-mode` choices: `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan`
//!   (headless Z2 passes `default`, which the hooks reference reports as the input value of
//!   Manual; the interactive launch uses the listed `manual`).
//! - `--settings <file-or-json>` loads additional settings, applied above user, project and local
//!   settings; `--setting-sources user` keeps project/local files (and their hooks) out;
//!   `--restricted` ignores user/project/local settings but still applies `--settings`.
//! - `--session-id <uuid>`, `-r/--resume`, `-n/--name`, `--model`, `--strict-mcp-config`,
//!   `--disallowedTools <tools...>`.
//! - Command hooks accept exec form (`"args": [...]`: no shell); `timeout` is in seconds (default
//!   10 minutes); only exit 2 blocks; a timed-out PreToolUse hook does not block.

use std::ffi::OsString;
use std::path::Path;

use kalcode_contracts::agent::{
    InteractiveSupport, MappingFidelity, PermissionMapping, StatusChannel,
};
use kalcode_contracts::permissions::PermissionMode;
use kalcode_hook_bridge::HookEvent;
use kalcode_hook_bridge::helper::{PRE_TOOL_USE_HOOK_TIMEOUT_SECS, STATUS_HOOK_TIMEOUT_SECS};
use serde_json::{Value, json};

use super::DecisionRouting;
use crate::claude::argv::{ArgsError, SessionStart, deny_rules};

/// `--permission-mode` values listed by `claude --help` 2.1.282. Tests fail if KalCode ever
/// emits a value outside this list.
pub const VERIFIED_PERMISSION_MODES: &[&str] = &[
    "acceptEdits",
    "auto",
    "bypassPermissions",
    "manual",
    "dontAsk",
    "plan",
];

/// Claude Code modes KalCode never launches with, in any KalCode mode. Auto is intentionally
/// allowed: supported Claude Code sessions use its native classifier and unsupported sessions
/// fall back to Manual rather than broadening authority.
pub const FORBIDDEN_PERMISSION_MODES: &[&str] = &["bypassPermissions", "dontAsk"];

/// Flags KalCode never passes to an interactive session.
pub const FORBIDDEN_FLAGS: &[&str] = &[
    "--dangerously-skip-permissions",
    "--allow-dangerously-skip-permissions",
    "--allowedTools",
    "--allowed-tools",
    "--add-dir",
    "--bare",
    "--safe-mode",
    "-p",
    "--print",
    "--permission-prompt-tool",
];

/// Tools KalCode's deny floor keeps removed in Plan (Plan never edits or fetches).
const PLAN_ONLY_DENIES: &[&str] = &["Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"];

/// The interactive deny floor for a mode: the Z2 credential-file and remote-action rules in every
/// mode, plus the edit and web tools in Plan. Unlike headless sessions, the edit and web tools
/// stay available in Approve/Auto/Custom: a person answers for them (KalCode's approval, or the
/// provider's own prompt in the pane).
pub fn interactive_deny_rules(mode: PermissionMode) -> Vec<String> {
    const ASK_FIRST: &[&str] = &["Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"];
    let mut rules: Vec<String> = deny_rules(mode)
        .into_iter()
        .filter(|rule| !ASK_FIRST.contains(&rule.as_str()))
        .collect();
    if mode == PermissionMode::Plan {
        rules.splice(0..0, PLAN_ONLY_DENIES.iter().map(|t| (*t).to_owned()));
    }
    rules
}

/// Provider-native mode flags for an interactive session.
pub fn permission_args(mode: PermissionMode) -> Vec<&'static str> {
    match mode {
        PermissionMode::Plan => vec!["--restricted", "--permission-mode", "plan"],
        PermissionMode::Approve | PermissionMode::Custom => {
            vec!["--setting-sources", "user", "--permission-mode", "manual"]
        }
        PermissionMode::Auto => {
            vec!["--setting-sources", "user", "--permission-mode", "auto"]
        }
        PermissionMode::Bypass => vec![
            "--setting-sources",
            "user",
            "--permission-mode",
            "acceptEdits",
        ],
    }
}

/// Everything the interactive argv needs.
#[derive(Debug, Clone)]
pub struct InteractiveArgs<'a> {
    pub mode: PermissionMode,
    pub start: SessionStart,
    pub settings_path: &'a Path,
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
    /// Display name passed with `-n`.
    pub title: Option<&'a str>,
}

/// Titles passed with `-n`: printable, bounded, and never read as a flag.
pub fn valid_title(title: &str) -> bool {
    let trimmed = title.trim();
    !trimmed.is_empty()
        && trimmed.chars().count() <= 100
        && !trimmed.starts_with('-')
        && !title.chars().any(char::is_control)
}

/// The complete argv (after the program) for an interactive Claude Code session. Each value is
/// its own element; no shell is involved.
pub fn interactive_args(args: &InteractiveArgs<'_>) -> Result<Vec<OsString>, ArgsError> {
    let mut out: Vec<OsString> = permission_args(args.mode)
        .into_iter()
        .map(OsString::from)
        .collect();
    // No repository MCP servers (K4).
    out.push("--strict-mcp-config".into());
    out.push("--settings".into());
    out.push(args.settings_path.as_os_str().to_owned());
    out.push("--disallowedTools".into());
    out.extend(
        interactive_deny_rules(args.mode)
            .into_iter()
            .map(OsString::from),
    );
    if let Some(model) = args.model {
        if !crate::claude::argv::valid_model_name(model) {
            return Err(ArgsError::InvalidModel);
        }
        out.push("--model".into());
        out.push(model.into());
    }
    if let Some(effort) = args.effort {
        if !crate::claude::argv::valid_effort_name(effort) {
            return Err(ArgsError::InvalidEffort);
        }
        out.push("--effort".into());
        out.push(effort.into());
    }
    if let Some(title) = args.title.filter(|t| valid_title(t)) {
        out.push("-n".into());
        out.push(title.trim().into());
    }
    let (flag, id) = match &args.start {
        SessionStart::New { session_id } => ("--session-id", session_id),
        SessionStart::Resume { session_id } => ("--resume", session_id),
    };
    if !kalcode_contracts::ids::is_valid_id(id) {
        return Err(ArgsError::InvalidSessionId);
    }
    out.push(flag.into());
    out.push(id.into());
    Ok(out)
}

/// How a hook command reaches `kalcode-hook`.
#[derive(Debug, Clone)]
pub struct HookCommand<'a> {
    /// Absolute path of the helper.
    pub program: &'a Path,
    /// Arguments before `claude <Event> ...` (empty for `kalcode-hook`; tests use a stand-in).
    pub prefix_args: &'a [String],
    pub endpoint: &'a str,
    pub session: &'a str,
}

fn hook_entry(hook: &HookCommand<'_>, event: HookEvent) -> Value {
    let mut args: Vec<String> = hook.prefix_args.to_vec();
    args.extend([
        "claude".to_owned(),
        event.as_str().to_owned(),
        hook.endpoint.to_owned(),
        hook.session.to_owned(),
    ]);
    let timeout = if event.is_blocking() {
        PRE_TOOL_USE_HOOK_TIMEOUT_SECS
    } else {
        STATUS_HOOK_TIMEOUT_SECS
    };
    let handler = json!({
        "type": "command",
        "command": hook.program.to_string_lossy(),
        "args": args,
        "timeout": timeout,
    });
    if event.has_tool_matcher() {
        json!({ "matcher": "*", "hooks": [handler] })
    } else {
        json!({ "hooks": [handler] })
    }
}

/// KalCode's session settings: hooks only. The deny floor travels as `--disallowedTools`;
/// nothing here relaxes anything, and nothing here is secret (the key is in the environment).
pub fn settings_json(hook: &HookCommand<'_>) -> Value {
    let mut hooks = serde_json::Map::new();
    for event in HookEvent::CLAUDE {
        hooks.insert(event.as_str().to_owned(), json!([hook_entry(hook, event)]));
    }
    json!({ "hooks": hooks })
}

/// The interactive mapping per mode, generated from the argv so it can't drift.
pub fn interactive_mappings(routing: DecisionRouting) -> Vec<PermissionMapping> {
    let answering = match routing {
        DecisionRouting::Engine => {
            "KalCode checks every tool call and asks you in KalCode when \
                                    its policy says to ask."
        }
        DecisionRouting::ProviderPrompt => {
            "KalCode sees every tool call; approvals are answered \
                                            in Claude Code's own prompt in the pane."
        }
    };
    [
        (PermissionMode::Plan, "Reads and plans only."),
        (
            PermissionMode::Approve,
            "Claude Code asks before edits and commands.",
        ),
        (
            PermissionMode::Auto,
            "Claude Code's background classifier handles routine workspace actions. If Auto is unavailable for the selected account, model, or organization, Claude Code falls back to Manual.",
        ),
        (
            PermissionMode::Bypass,
            "Edits in the workspace run without asking; bypassPermissions is never used.",
        ),
        (
            PermissionMode::Custom,
            "Runs like Approve, with your Custom rules.",
        ),
    ]
    .into_iter()
    .map(|(mode, note)| PermissionMapping {
        mode,
        fidelity: MappingFidelity::ApproximateStricter,
        provider_setting: format!(
            "{} --settings <KalCode hooks> --disallowedTools <{} KalCode rules>",
            permission_args(mode).join(" "),
            interactive_deny_rules(mode).len()
        ),
        notes: format!(
            "{note} {answering} KalCode always denies git push, publishes, deploy and cloud \
             CLIs, gh and ssh, and reading credential files."
        ),
    })
    .collect()
}

/// What the Providers page and the pane show about Claude Code panes.
pub fn interactive_support(routing: DecisionRouting) -> InteractiveSupport {
    InteractiveSupport {
        launch_mappings: interactive_mappings(routing),
        status_channels: vec![StatusChannel::Hooks, StatusChannel::ProcessOnly],
        kalcode_answers_approvals: routing == DecisionRouting::Engine,
        resume: Some("claude --resume <session id>".into()),
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
        interactive_args(&InteractiveArgs {
            mode,
            start: SessionStart::New {
                session_id: "0192f3c4-0000-7000-8000-000000000000".into(),
            },
            settings_path: Path::new("/data/sessions/t/claude-settings.json"),
            model: Some("sonnet"),
            effort: Some("high"),
            title: Some("Fix the build"),
        })
        .expect("args")
        .into_iter()
        .map(|a| a.into_string().expect("utf8"))
        .collect()
    }

    fn value_after(args: &[String], flag: &str) -> Option<String> {
        args.iter()
            .position(|a| a == flag)
            .and_then(|i| args.get(i + 1))
            .cloned()
    }

    /// Claude Code modes ordered by how much runs without a prompt.
    fn rank(mode: &str) -> u8 {
        match mode {
            "plan" => 0,
            "dontAsk" => 1,
            "manual" | "default" => 2,
            "acceptEdits" => 3,
            "auto" => 4,
            _ => u8::MAX,
        }
    }

    #[test]
    fn interactive_modes_are_verified_and_never_broader() {
        let cap = |mode| match mode {
            PermissionMode::Plan => 0,
            PermissionMode::Approve | PermissionMode::Custom => 2,
            PermissionMode::Auto => 4,
            PermissionMode::Bypass => 3,
        };
        for mode in ALL {
            let args = args_for(mode);
            let claude_mode = value_after(&args, "--permission-mode").expect("mode");
            assert!(
                VERIFIED_PERMISSION_MODES.contains(&claude_mode.as_str()),
                "{mode:?} emits unverified mode {claude_mode}"
            );
            assert!(
                !FORBIDDEN_PERMISSION_MODES.contains(&claude_mode.as_str()),
                "{mode:?}"
            );
            assert!(rank(&claude_mode) <= cap(mode), "{mode:?} -> {claude_mode}");
            if mode == PermissionMode::Auto {
                assert_eq!(
                    claude_mode, "auto",
                    "Auto must use Claude Code's background classifier"
                );
            }
        }
    }

    #[test]
    fn forbidden_flags_never_appear() {
        for mode in ALL {
            let args = args_for(mode);
            for flag in FORBIDDEN_FLAGS {
                assert!(!args.iter().any(|a| a == flag), "{mode:?} uses {flag}");
            }
            assert!(args.iter().any(|a| a == "--strict-mcp-config"), "{mode:?}");
            assert!(value_after(&args, "--settings").is_some(), "{mode:?}");
            if mode == PermissionMode::Plan {
                assert!(args.iter().any(|a| a == "--restricted"));
            } else {
                assert_eq!(
                    value_after(&args, "--setting-sources").as_deref(),
                    Some("user")
                );
            }
        }
    }

    #[test]
    fn the_deny_floor_travels_with_every_mode() {
        for mode in ALL {
            let args = args_for(mode);
            let start = args
                .iter()
                .position(|a| a == "--disallowedTools")
                .expect("flag")
                + 1;
            let end = args[start..]
                .iter()
                .position(|a| a.starts_with('-'))
                .map(|i| start + i)
                .expect("the variadic list is followed by an option");
            let rules = &args[start..end];
            assert_eq!(rules, interactive_deny_rules(mode).as_slice());
            for rule in [
                "Bash(git push *)",
                "PowerShell(gh *)",
                "Read(~/.ssh/**)",
                "Read(//**/.env)",
            ] {
                assert!(rules.iter().any(|r| r == rule), "{mode:?} lacks {rule}");
            }
            let removes_edits = rules.iter().any(|r| r == "Edit");
            assert_eq!(removes_edits, mode == PermissionMode::Plan, "{mode:?}");
        }
    }

    #[test]
    fn session_identity_and_title_are_validated() {
        let base = |start, title| InteractiveArgs {
            mode: PermissionMode::Approve,
            start,
            settings_path: Path::new("/s.json"),
            model: None,
            effort: None,
            title,
        };
        let new = || SessionStart::New {
            session_id: "0192f3c4-0000-7000-8000-000000000000".into(),
        };
        for id in ["--resume", "latest", ""] {
            assert_eq!(
                interactive_args(&base(
                    SessionStart::Resume {
                        session_id: id.into()
                    },
                    None
                )),
                Err(ArgsError::InvalidSessionId)
            );
        }
        // A title that could be read as a flag, or holds control characters, is left out.
        for title in ["--dangerously-skip-permissions", "a\u{1b}[2J", "   "] {
            let args = interactive_args(&base(new(), Some(title))).expect("args");
            assert!(!args.iter().any(|a| a == "-n"), "{title:?}");
        }
        let args = interactive_args(&base(new(), Some("Fix login"))).expect("args");
        let args: Vec<String> = args
            .into_iter()
            .map(|a| a.into_string().expect("utf8"))
            .collect();
        assert_eq!(value_after(&args, "-n").as_deref(), Some("Fix login"));
        assert_eq!(
            args.last().map(String::as_str),
            Some("0192f3c4-0000-7000-8000-000000000000")
        );
        assert_eq!(
            value_after(&args_for(PermissionMode::Approve), "--effort").as_deref(),
            Some("high")
        );
        let mut invalid = base(new(), None);
        invalid.effort = Some("ultra");
        assert_eq!(interactive_args(&invalid), Err(ArgsError::InvalidEffort));
    }

    #[test]
    fn settings_register_every_event_in_exec_form_with_explicit_timeouts() {
        let prefix: Vec<String> = Vec::new();
        let settings = settings_json(&HookCommand {
            program: Path::new("C:/Program Files/KalCode/kalcode-hook.exe"),
            prefix_args: &prefix,
            endpoint: r"\\.\pipe\kalcode-hook-0123",
            session: "abcd",
        });
        let hooks = settings["hooks"].as_object().expect("hooks");
        assert_eq!(hooks.len(), HookEvent::CLAUDE.len());
        for event in HookEvent::CLAUDE {
            let group = &hooks[event.as_str()][0];
            let handler = &group["hooks"][0];
            assert_eq!(handler["type"], "command");
            assert_eq!(
                handler["command"],
                "C:/Program Files/KalCode/kalcode-hook.exe"
            );
            let args: Vec<&str> = handler["args"]
                .as_array()
                .expect("exec form")
                .iter()
                .map(|v| v.as_str().expect("str"))
                .collect();
            assert_eq!(
                args,
                [
                    "claude",
                    event.as_str(),
                    r"\\.\pipe\kalcode-hook-0123",
                    "abcd"
                ]
            );
            let timeout = handler["timeout"].as_u64().expect("timeout");
            if event == HookEvent::PreToolUse {
                assert_eq!(timeout, PRE_TOOL_USE_HOOK_TIMEOUT_SECS);
            } else {
                assert_eq!(timeout, STATUS_HOOK_TIMEOUT_SECS);
            }
            assert_eq!(
                group.get("matcher").is_some(),
                event.has_tool_matcher(),
                "{event:?}"
            );
            assert!(handler.get("shell").is_none(), "exec form ignores shell");
        }
        // Nothing in the settings relaxes permissions or carries a secret.
        let text = settings.to_string();
        for word in [
            "allow",
            "permissions",
            "KALCODE_HOOK_KEY",
            "disableAllHooks",
        ] {
            assert!(!text.contains(word), "{word}");
        }
    }

    #[test]
    fn support_reflects_the_decision_routing() {
        let engine = interactive_support(DecisionRouting::Engine);
        assert!(engine.kalcode_answers_approvals);
        let prompt = interactive_support(DecisionRouting::ProviderPrompt);
        assert!(!prompt.kalcode_answers_approvals);
        assert_eq!(prompt.launch_mappings.len(), 5);
        for mapping in prompt.launch_mappings {
            assert!(
                mapping
                    .provider_setting
                    .starts_with(&permission_args(mapping.mode).join(" "))
            );
            assert!(!mapping.provider_setting.contains("bypassPermissions"));
        }
        assert!(prompt.status_channels.contains(&StatusChannel::Hooks));
    }
}
