//! Codex in a pane with the selected provider-native sandbox and approval policy
//! (docs/PROVIDER_PANES.md §3). Approvals stay in Codex's own prompt. KalCode's status comes
//! from Codex's own hooks (UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, Stop,
//! Interrupt; asynchronous, so Codex never waits for KalCode), added for this session only with
//! `-c` overrides and trusted for this session only ([`kalcode_hook_bridge::codex`]), and from
//! Codex's `notify` program (turn completion with the thread id), plus process state. The hooks observe: the helper exits 0 with
//! no output, so they never block, approve or deny. Codex's hook feature is on in panes, so the
//! user's own hooks run as they do in a native terminal. KalCode never passes
//! `--dangerously-bypass-hook-trust`: other hooks keep Codex's own trust review. Terminal escape
//! sequences are untrusted output and cannot change canonical status.
//!
//! Verified on 2026-10-03 against the installed `codex --help` (codex-cli 0.160.0; supported
//! minimum 0.155.1): `-C/--cd`,
//! `-s/--sandbox` (`read-only`, `workspace-write`, `danger-full-access`), `-a/--ask-for-approval`
//! (`on-request`, `never`), `-m/--model`, `-c key=value` (TOML value), `codex resume <id>`.
//! `notify` and `tui.notifications*` keys: https://learn.chatgpt.com/docs/config-file/config-advanced
//! (via PROVIDER_PANES.md [5]; confirm in the owner-approved smoke run).

use std::ffi::OsString;
use std::path::Path;

use kalcode_contracts::agent::{
    InteractiveSupport, MappingFidelity, PermissionMapping, StatusChannel,
};
use kalcode_contracts::permissions::PermissionMode;

/// Flags and values KalCode never passes to Codex.
pub const FORBIDDEN: &[&str] = &[
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust",
    "--approve-for-me",
    "--add-dir",
];

/// Sandbox and approval policy per KalCode mode. Execution decisions remain in Codex's native
/// sandbox and prompt; KalCode does not synthesize provider approvals.
pub fn permission_args(mode: PermissionMode) -> [&'static str; 4] {
    match mode {
        PermissionMode::Plan => ["-s", "read-only", "-a", "never"],
        PermissionMode::Approve | PermissionMode::Auto | PermissionMode::Custom => {
            ["-s", "workspace-write", "-a", "on-request"]
        }
        PermissionMode::Bypass => ["-s", "danger-full-access", "-a", "never"],
    }
}

/// A TOML array of literal strings (`'...'`: no escapes are interpreted). Refuses values a
/// literal string can't hold.
fn toml_literal_array(values: &[&str]) -> Option<String> {
    let mut items = Vec::with_capacity(values.len());
    for value in values {
        if value.contains(['\'', '\n', '\r']) || value.chars().any(char::is_control) {
            return None;
        }
        items.push(format!("'{value}'"));
    }
    Some(format!("[{}]", items.join(",")))
}

#[derive(Debug, Clone)]
pub struct CodexArgs<'a> {
    pub mode: PermissionMode,
    pub workspace: &'a Path,
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
    pub resume_session_id: Option<&'a str>,
    /// The helper and its `codex-notify` arguments.
    pub hook_program: &'a Path,
    /// Arguments before `codex-notify` (empty for `kalcode-hook`; tests use a stand-in).
    pub hook_prefix_args: &'a [String],
    pub endpoint: &'a str,
    pub session: &'a str,
    /// Add KalCode's observing Codex hooks (a Codex line verified for them,
    /// [`crate::codex::observing_hooks_verified`]). Without them status is `notify` only.
    pub observe_hooks: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CodexArgsError {
    #[error("a path can't be passed to Codex safely")]
    UnsafePath,
    #[error("the model name is not valid")]
    InvalidModel,
    #[error("the reasoning effort is not supported")]
    InvalidEffort,
    #[error("the session id is not valid")]
    InvalidSessionId,
}

/// The argv (after the program) for an interactive Codex pane.
pub fn interactive_args(args: &CodexArgs<'_>) -> Result<Vec<OsString>, CodexArgsError> {
    interactive_args_with_overrides(args, &[])
}

/// Managed-profile variant. `overrides` must come from
/// [`crate::codex::managed_policy::prepare_session`], which binds the complete repository path
/// as untrusted without relying on Codex's dotted override parser.
pub fn interactive_args_with_overrides(
    args: &CodexArgs<'_>,
    overrides: &[OsString],
) -> Result<Vec<OsString>, CodexArgsError> {
    let mut out: Vec<OsString> = Vec::new();
    if let Some(id) = args.resume_session_id {
        if !kalcode_contracts::ids::is_valid_id(id) {
            return Err(CodexArgsError::InvalidSessionId);
        }
        out.push("resume".into());
    }
    // A shared daemon may still run an older binary after the CLI is upgraded. Keep Windows
    // panes on the verified console-free runtime and inside this pane's supervised process tree.
    // Codex 0.160's public --no-daemon flag preserves provider auth and resume behavior.
    #[cfg(windows)]
    out.push("--no-daemon".into());
    out.push("-C".into());
    out.push(args.workspace.as_os_str().to_owned());
    out.extend(permission_args(args.mode).into_iter().map(OsString::from));
    let program = args
        .hook_program
        .to_str()
        .ok_or(CodexArgsError::UnsafePath)?;
    let hooks = if args.observe_hooks {
        // A path the shell can't take safely keeps `notify`-only status rather than failing.
        kalcode_hook_bridge::codex::session_overrides(
            program,
            args.hook_prefix_args,
            args.endpoint,
            args.session,
        )
        .inspect_err(|error| tracing::warn!(event = "pane.codex_hooks_unavailable", %error))
        .ok()
    } else {
        None
    };
    // Codex's hook feature stays as the person configured it, as in a native terminal (never
    // forced on or off): KalCode's observing hooks run wherever Codex runs hooks at all.
    for value in crate::codex::argv::POLICY_CONFIG {
        out.extend([OsString::from("-c"), OsString::from(*value)]);
    }
    out.extend_from_slice(overrides);
    out.extend([
        OsString::from("-c"),
        OsString::from(crate::codex::argv::SUBAGENT_CONFIG),
    ]);
    if let Some(model) = args.model {
        if !crate::codex::argv::valid_model_name(model) {
            return Err(CodexArgsError::InvalidModel);
        }
        out.push("-m".into());
        out.push(model.into());
    }
    if let Some(effort) = args.effort {
        if !crate::codex::argv::valid_effort_name(effort) {
            return Err(CodexArgsError::InvalidEffort);
        }
        out.push("-c".into());
        out.push(format!("model_reasoning_effort='{effort}'").into());
    }
    let mut notify_argv: Vec<&str> = vec![program];
    notify_argv.extend(args.hook_prefix_args.iter().map(String::as_str));
    notify_argv.extend(["codex-notify", args.endpoint, args.session]);
    let notify = toml_literal_array(&notify_argv).ok_or(CodexArgsError::UnsafePath)?;
    for config in [
        format!("notify={notify}"),
        // Notifications remain available to the terminal, but never authorize status changes.
        "tui.notifications=['approval-requested']".to_owned(),
        "tui.notification_method='osc9'".to_owned(),
        "tui.notification_condition='always'".to_owned(),
    ]
    .into_iter()
    .chain(hooks.into_iter().flatten())
    {
        out.push("-c".into());
        out.push(config.into());
    }
    if let Some(id) = args.resume_session_id {
        out.push(id.into());
    }
    Ok(out)
}

/// What a Codex pane reports through: its own hooks (on a verified Codex line), `notify`, and the
/// process.
pub fn interactive_support() -> InteractiveSupport {
    InteractiveSupport {
        launch_mappings: [
            PermissionMode::Plan,
            PermissionMode::Approve,
            PermissionMode::Auto,
            PermissionMode::Bypass,
            PermissionMode::Custom,
        ]
        .into_iter()
        .map(|mode| PermissionMapping {
            mode,
            fidelity: MappingFidelity::ApproximateStricter,
            provider_setting: permission_args(mode).join(" "),
            notes: "Approvals are answered in Codex's own prompt. KalCode observes Codex's own \
                    hooks (prompt, tool start and end, approval prompt, stop) and turn completion \
                    notifications; they never decide anything."
                .into(),
        })
        .collect(),
        status_channels: vec![
            StatusChannel::Hooks,
            StatusChannel::Notify,
            StatusChannel::ProcessOnly,
        ],
        kalcode_answers_approvals: false,
        resume: Some("codex resume <session id>".into()),
    }
}

/// Finds OSC 9 notifications (`ESC ] 9 ; text BEL` or `ESC ] 9 ; text ESC \`) in a PTY byte
/// stream, across chunk boundaries. Structural terminal parsing only: the text is reported as a
/// count, never interpreted, because it can contain model-generated content.
#[derive(Debug, Default)]
pub struct Osc9Scanner {
    state: ScanState,
    body_len: usize,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum ScanState {
    #[default]
    Ground,
    Esc,
    OscStart,
    Nine,
    Body,
    BodyEsc,
    /// An OSC that isn't 9: skipped to its terminator.
    OtherOsc,
    OtherOscEsc,
}

/// Longest notification body tracked before the sequence is abandoned.
const MAX_OSC_BODY: usize = 4096;

impl Osc9Scanner {
    /// Feeds bytes; returns how many complete OSC 9 notifications ended in them.
    pub fn feed(&mut self, bytes: &[u8]) -> usize {
        let mut found = 0;
        for &b in bytes {
            use ScanState::*;
            self.state = match (self.state, b) {
                (Ground, 0x1b) => Esc,
                (Ground, _) => Ground,
                (Esc, b']') => OscStart,
                (Esc, 0x1b) => Esc,
                (Esc, _) => Ground,
                (OscStart, b'9') => Nine,
                (OscStart, 0x07) => Ground,
                (OscStart, _) => OtherOsc,
                (Nine, b';') => {
                    self.body_len = 0;
                    Body
                }
                (Nine, 0x07) => Ground,
                (Nine, _) => OtherOsc,
                (Body, 0x07) => {
                    found += 1;
                    Ground
                }
                (Body, 0x1b) => BodyEsc,
                (Body, _) => {
                    self.body_len += 1;
                    if self.body_len > MAX_OSC_BODY {
                        Ground
                    } else {
                        Body
                    }
                }
                (BodyEsc, b'\\') => {
                    found += 1;
                    Ground
                }
                (BodyEsc, b']') => OscStart,
                (BodyEsc, _) => Ground,
                (OtherOsc, 0x07) => Ground,
                (OtherOsc, 0x1b) => OtherOscEsc,
                (OtherOsc, _) => OtherOsc,
                (OtherOscEsc, b']') => OscStart,
                (OtherOscEsc, _) => Ground,
            };
        }
        found
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_subagents_are_ten_for_new_and_resumed_panes() {
        for resume in [None, Some("01234567-89ab-4cde-8fab-0123456789ab")] {
            for previous in [3, 15, 30] {
                let launch = CodexArgs {
                    mode: PermissionMode::Approve,
                    workspace: Path::new("C:/work/repo"),
                    model: None,
                    effort: None,
                    resume_session_id: resume,
                    hook_program: Path::new("kalcode-hook.exe"),
                    hook_prefix_args: &[],
                    endpoint: "test-endpoint",
                    session: "test-session",
                    observe_hooks: true,
                };
                let args = interactive_args_with_overrides(
                    &launch,
                    &[
                        "-c".into(),
                        format!("agents.max_concurrent_threads_per_session={previous}").into(),
                    ],
                )
                .expect("args");
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

    fn args(mode: PermissionMode, resume: Option<&str>) -> Vec<String> {
        interactive_args(&CodexArgs {
            mode,
            workspace: Path::new("C:/work/repo"),
            model: Some("gpt-5"),
            effort: Some("high"),
            resume_session_id: resume,
            hook_program: Path::new(r"C:\Program Files\KalCode\kalcode-hook.exe"),
            hook_prefix_args: &[],
            endpoint: r"\\.\pipe\kalcode-hook-0123",
            session: "abcd",
            observe_hooks: true,
        })
        .expect("args")
        .into_iter()
        .map(|a| a.into_string().expect("utf8"))
        .collect()
    }

    #[test]
    fn codex_interactive_never_uses_forbidden_flags() {
        for mode in [
            PermissionMode::Plan,
            PermissionMode::Approve,
            PermissionMode::Auto,
            PermissionMode::Bypass,
            PermissionMode::Custom,
        ] {
            let args = args(mode, None);
            for forbidden in FORBIDDEN {
                assert!(
                    !args.iter().any(|a| a == forbidden),
                    "{mode:?}: {forbidden}"
                );
            }
            let sandbox = &args[args.iter().position(|a| a == "-s").expect("-s") + 1];
            let expected = match mode {
                PermissionMode::Plan => "read-only",
                PermissionMode::Approve | PermissionMode::Auto | PermissionMode::Custom => {
                    "workspace-write"
                }
                PermissionMode::Bypass => "danger-full-access",
            };
            assert_eq!(sandbox, expected, "{mode:?}");
            let expected_approval = match mode {
                PermissionMode::Approve | PermissionMode::Auto | PermissionMode::Custom => {
                    "on-request"
                }
                PermissionMode::Plan | PermissionMode::Bypass => "never",
            };
            assert_eq!(
                args[args.iter().position(|a| a == "-a").expect("-a") + 1],
                expected_approval
            );
        }
    }

    #[test]
    fn notify_is_a_toml_literal_array_and_unsafe_paths_are_refused() {
        let args = args(PermissionMode::Approve, None);
        let notify = args
            .iter()
            .find(|a| a.starts_with("notify="))
            .expect("notify");
        assert_eq!(
            notify,
            r"notify=['C:\Program Files\KalCode\kalcode-hook.exe','codex-notify','\\.\pipe\kalcode-hook-0123','abcd']"
        );
        let bad = interactive_args(&CodexArgs {
            mode: PermissionMode::Approve,
            workspace: Path::new("C:/w"),
            model: None,
            effort: None,
            resume_session_id: None,
            hook_program: Path::new("C:/it's/kalcode-hook.exe"),
            hook_prefix_args: &[],
            endpoint: "e",
            session: "s",
            observe_hooks: true,
        });
        assert_eq!(bad, Err(CodexArgsError::UnsafePath));
    }

    #[test]
    fn resume_uses_the_subcommand() {
        let id = "0192f3c4-0000-7000-8000-000000000000";
        let args = args(PermissionMode::Approve, Some(id));
        assert_eq!(args[0], "resume");
        assert_eq!(args.last().map(String::as_str), Some(id));
        assert!(
            args.windows(2)
                .any(|pair| pair == ["-c", "model_reasoning_effort='high'"])
        );
    }

    #[test]
    fn code_host_is_available_for_new_and_resumed_panes_in_every_mode() {
        for mode in [
            PermissionMode::Plan,
            PermissionMode::Approve,
            PermissionMode::Auto,
            PermissionMode::Bypass,
            PermissionMode::Custom,
        ] {
            for resume in [None, Some("0192f3c4-0000-7000-8000-000000000000")] {
                let argv = args(mode, resume);
                assert!(
                    argv.windows(2)
                        .any(|p| p == ["-c", "features.code_mode_host=true"])
                );
                assert!(!argv.iter().any(|a| a == "features.code_mode_host=false"));
                assert!(!argv.iter().any(|a| a == "features.code_mode=false"));
                assert_eq!(
                    argv.windows(2)
                        .any(|p| p == ["-c", "windows.sandbox='unelevated'"]),
                    cfg!(target_os = "windows"),
                    "{mode:?} must use the same Windows sandbox backend as headless turns"
                );
            }
        }
    }

    #[test]
    fn osc9_is_found_across_chunks_and_other_sequences_are_ignored() {
        let mut scanner = Osc9Scanner::default();
        assert_eq!(
            scanner.feed(b"plain \x1b]0;title\x07 text"),
            0,
            "OSC 0 is a title"
        );
        assert_eq!(scanner.feed(b"\x1b]9;Approval requested\x07"), 1);
        assert_eq!(scanner.feed(b"\x1b]9;Turn com"), 0);
        assert_eq!(
            scanner.feed(b"plete\x1b\\"),
            1,
            "ST terminator, split across chunks"
        );
        assert_eq!(scanner.feed(b"\x1b]99;x\x07"), 0, "OSC 99 is not OSC 9");
        assert_eq!(
            scanner.feed(b"PERMISSION REQUIRED Status: done"),
            0,
            "prose is ignored"
        );
        let long = [
            b"\x1b]9;".as_slice(),
            &vec![b'x'; MAX_OSC_BODY + 10],
            b"\x07",
        ]
        .concat();
        assert_eq!(scanner.feed(&long), 0, "oversized bodies are abandoned");
    }

    #[test]
    fn observing_hooks_are_session_flags_that_never_bypass_trust() {
        let argv = args(PermissionMode::Approve, None);
        // The person's own hook setting is kept: never forced on, never stripped.
        assert!(!argv.iter().any(|a| a.starts_with("features.hooks=")));
        assert!(!argv.iter().any(|a| a.contains("bypass_hook_trust")));
        for event in kalcode_hook_bridge::HookEvent::CODEX {
            assert_eq!(
                argv.iter()
                    .any(|a| a.starts_with(&format!("hooks.{}=[", event.as_str()))),
                kalcode_hook_bridge::codex::pane_plan(event).is_some(),
                "{event:?}"
            );
        }
        assert!(
            argv.iter()
                .filter(|a| a.starts_with("hooks.") && !a.starts_with("hooks.state"))
                .all(|a| a.contains("async=true")),
            "Codex never waits for KalCode's hooks"
        );
        let state = argv
            .iter()
            .find(|a| a.starts_with("hooks.state={"))
            .expect("trust for KalCode's own hooks");
        assert_eq!(
            state.matches("<session-flags>").count(),
            kalcode_hook_bridge::HookEvent::CODEX
                .into_iter()
                .filter(|event| kalcode_hook_bridge::codex::pane_plan(*event).is_some())
                .count()
        );

        // Without verified hooks the pane keeps the policy floor and `notify` only.
        let notify_only = interactive_args(&CodexArgs {
            mode: PermissionMode::Approve,
            workspace: Path::new("C:/w"),
            model: None,
            effort: None,
            resume_session_id: None,
            hook_program: Path::new("C:/kalcode-hook.exe"),
            hook_prefix_args: &[],
            endpoint: "endpoint",
            session: "session",
            observe_hooks: false,
        })
        .expect("args")
        .into_iter()
        .map(|a| a.into_string().expect("utf8"))
        .collect::<Vec<_>>();
        assert!(!notify_only.iter().any(|a| a.starts_with("features.hooks=")));
        assert!(!notify_only.iter().any(|a| a.starts_with("hooks.")));
        assert!(notify_only.iter().any(|a| a.starts_with("notify=")));
    }

    #[test]
    fn support_keeps_approval_decisions_in_codex() {
        let support = interactive_support();
        assert!(!support.kalcode_answers_approvals);
        assert!(support.status_channels.contains(&StatusChannel::Hooks));
        assert!(support.status_channels.contains(&StatusChannel::Notify));
        let disclosed: Vec<(PermissionMode, &str)> = support
            .launch_mappings
            .iter()
            .map(|mapping| (mapping.mode, mapping.provider_setting.as_str()))
            .collect();
        assert_eq!(
            disclosed,
            [
                (PermissionMode::Plan, "-s read-only -a never"),
                (PermissionMode::Approve, "-s workspace-write -a on-request"),
                (PermissionMode::Auto, "-s workspace-write -a on-request"),
                (PermissionMode::Bypass, "-s danger-full-access -a never"),
                (PermissionMode::Custom, "-s workspace-write -a on-request"),
            ],
            "Provider Health and the mode picker must disclose the exact native launch pair"
        );
        assert!(
            support
                .launch_mappings
                .iter()
                .all(|mapping| mapping.notes.contains("Codex's own prompt"))
        );
    }

    #[test]
    fn panes_use_native_approval_policy_and_disable_connected_web_and_workspace_network() {
        for mode in [
            PermissionMode::Plan,
            PermissionMode::Approve,
            PermissionMode::Auto,
            PermissionMode::Custom,
            PermissionMode::Bypass,
        ] {
            let args = args(mode, None);
            let approval = args.iter().position(|arg| arg == "-a").expect("approval");
            let expected = match mode {
                PermissionMode::Approve | PermissionMode::Auto | PermissionMode::Custom => {
                    "on-request"
                }
                PermissionMode::Plan | PermissionMode::Bypass => "never",
            };
            assert_eq!(args[approval + 1], expected);
            // The pane keeps Codex's native tools and the person's own config.
            for stripping in crate::codex::argv::TOOL_STRIPPING {
                assert!(
                    !args.iter().any(|arg| arg == stripping),
                    "{mode:?} strips a native tool with {stripping}"
                );
            }
        }
    }

    #[test]
    fn managed_repository_override_is_forwarded_without_reparsing() {
        let base = CodexArgs {
            mode: PermissionMode::Plan,
            workspace: Path::new("C:/work/repo.with.dots"),
            model: None,
            effort: None,
            resume_session_id: None,
            hook_program: Path::new("C:/kalcode-hook.exe"),
            hook_prefix_args: &[],
            endpoint: "endpoint",
            session: "session",
            observe_hooks: false,
        };
        let overrides = [
            OsString::from("-c"),
            OsString::from(r#"projects={"C:\\work\\repo.with.dots"={trust_level="untrusted"}}"#),
        ];
        let args = interactive_args_with_overrides(&base, &overrides).expect("args");
        assert!(args.windows(2).any(|pair| pair == overrides));
        let mut future = base.clone();
        future.effort = Some("ultra");
        let future_args = interactive_args_with_overrides(&future, &[]).expect("future effort");
        assert!(
            future_args
                .windows(2)
                .any(|pair| pair == ["-c", "model_reasoning_effort='ultra'"])
        );

        let mut invalid = base.clone();
        invalid.effort = Some("ultra' -c web_search='live");
        assert_eq!(
            interactive_args_with_overrides(&invalid, &[]),
            Err(CodexArgsError::InvalidEffort)
        );

        let model = "m".repeat(512);
        let mut future_model = base.clone();
        future_model.model = Some(&model);
        assert!(interactive_args_with_overrides(&future_model, &[]).is_ok());

        future_model.model = Some("future+tools");
        let future_model_args =
            interactive_args_with_overrides(&future_model, &[]).expect("future runtime model");
        assert!(
            future_model_args
                .windows(2)
                .any(|pair| pair == ["-m", "future+tools"])
        );
    }
}
