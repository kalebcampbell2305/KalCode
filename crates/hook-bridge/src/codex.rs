//! KalCode's observing Codex hooks, added to one Codex session with `-c` config overrides.
//!
//! Verified on 2026-10-04 against codex-cli 0.160.0 (`codex exec` and `codex app-server`
//! `hooks/list`):
//!
//! - `-c hooks.<Event>=[{matcher="*",hooks=[{type="command",command="…",timeout=10}]}]` adds a
//!   hook in Codex's **session-flags** config layer. Nothing is written to the user's
//!   `~/.codex/config.toml` or `hooks.json`, or to the project. Hook discovery is per layer, so
//!   the user's own `hooks.json` and `config.toml` hooks keep running beside KalCode's.
//! - Codex runs only *trusted* hooks. Trust is `hooks.state.<key>.trusted_hash`, merged across
//!   config layers, so `-c hooks.state={…}` trusts exactly KalCode's own session-flag hooks for
//!   this session and leaves the user's trust table intact. KalCode never passes
//!   `--dangerously-bypass-hook-trust`, which would trust every hook.
//! - The key is `<session-flags path>:<event>:<group>:<handler>` with the synthetic path
//!   `C:\<session-flags>\config.toml` (Windows) or `/<session-flags>/config.toml`; the hash is
//!   `sha256:` + hex SHA-256 of the key-sorted, compact JSON of the normalized identity
//!   `{event_name, matcher?, hooks: [{type, command, timeout, async}]}` (Codex's
//!   `hooks::engine::discovery::hook_hash` and `config::fingerprint::version_for_toml`).
//! - Codex runs a hook command through the session's shell, the one its shell tool uses
//!   (`powershell.exe -NoProfile -Command <command>` or pwsh on Windows, `$SHELL -c <command>`
//!   elsewhere; `cmd.exe /C` only when no shell is known), with the session's environment (the
//!   session key included) and the hook's JSON on stdin. A hook that exits 0 with no output
//!   changes nothing. KalCode's command is therefore written in words every one of those shells
//!   reads the same way ([`hook_command`]).
//!
//! - `async = true` hooks are started without Codex waiting for them ([`pane_plan`]).
//!
//! The helper's `codex` invocation always exits 0 with no output ([`crate::helper`]), so these
//! hooks observe only: Codex's sandbox, its own approval prompt and the user's hooks decide.

use serde_json::json;
use sha2::{Digest, Sha256};

use crate::HookEvent;
use crate::helper::STATUS_HOOK_TIMEOUT_SECS;

/// Why KalCode's Codex hooks can't be configured for a session.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CodexHookError {
    #[error("a hook argument can't be passed through the shell safely")]
    UnsafeArgument,
}

/// The synthetic path of Codex's session-flags config layer, as its hook trust keys spell it.
fn session_flags_path() -> &'static str {
    if cfg!(windows) {
        r"C:\<session-flags>\config.toml"
    } else {
        "/<session-flags>/config.toml"
    }
}

/// Codex's snake_case event label used in trust keys and hashes.
fn event_label(event: HookEvent) -> Option<&'static str> {
    Some(match event {
        HookEvent::SessionStart => "session_start",
        HookEvent::UserPromptSubmit => "user_prompt_submit",
        HookEvent::PreToolUse => "pre_tool_use",
        HookEvent::PermissionRequest => "permission_request",
        HookEvent::PostToolUse => "post_tool_use",
        HookEvent::Stop => "stop",
        HookEvent::Interrupt => "interrupt",
        _ => return None,
    })
}

/// The hook timeout KalCode configures, as Codex normalizes it (the trust hash covers the
/// normalized value): Codex caps Interrupt hooks at three seconds.
fn hook_timeout(event: HookEvent) -> u64 {
    if event == HookEvent::Interrupt {
        3
    } else {
        STATUS_HOOK_TIMEOUT_SECS
    }
}

/// A word every shell Codex may use reads literally without quotes: PowerShell, cmd.exe and
/// POSIX shells. Backslashes are literal in all but POSIX shells, which Codex uses only off
/// Windows, where KalCode's paths have none.
fn plain_word(arg: &str) -> bool {
    !arg.is_empty()
        && !arg.starts_with('-')
        && arg.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'_' | b'-' | b'.' | b'/' | b':')
                || (cfg!(windows) && byte == b'\\')
        })
}

/// The command line Codex hands to the session's shell for one event. Plain words when every
/// argument is one (the KalCode install path and the endpoint normally are). Otherwise the
/// quoting of the platform's shell: PowerShell's call operator on Windows (Codex uses PowerShell
/// there whenever it exists), POSIX single quotes elsewhere.
pub fn hook_command(
    program: &str,
    prefix_args: &[String],
    event: HookEvent,
    endpoint: &str,
    session: &str,
) -> Result<String, CodexHookError> {
    let args: Vec<&str> = std::iter::once(program)
        .chain(prefix_args.iter().map(String::as_str))
        .chain(["codex", event.as_str(), endpoint, session])
        .collect();
    if args
        .iter()
        .any(|arg| arg.is_empty() || arg.chars().any(char::is_control))
    {
        return Err(CodexHookError::UnsafeArgument);
    }
    if args.iter().all(|arg| plain_word(arg)) {
        return Ok(args.join(" "));
    }
    Ok(quoted(&args))
}

#[cfg(windows)]
fn quoted(args: &[&str]) -> String {
    let words: Vec<String> = args
        .iter()
        .map(|arg| format!("'{}'", arg.replace('\'', "''")))
        .collect();
    format!("& {}", words.join(" "))
}

#[cfg(not(windows))]
fn quoted(args: &[&str]) -> String {
    args.iter()
        .map(|arg| format!("'{}'", arg.replace('\'', r"'\''")))
        .collect::<Vec<_>>()
        .join(" ")
}

/// How Codex runs one of KalCode's hooks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookRun {
    /// Codex waits for the hook before it continues.
    Sync,
    /// Codex starts the hook and continues at once (`async = true`).
    Async,
}

/// Codex's trust hash for a single-handler hook group.
pub fn trust_hash(
    event: HookEvent,
    matcher: Option<&str>,
    command: &str,
    timeout: u64,
    run: HookRun,
) -> String {
    // Keys in byte order, as Codex sorts them before hashing.
    let handler = json!({
        "async": run == HookRun::Async,
        "command": command,
        "timeout": timeout,
        "type": "command",
    });
    let identity = match matcher {
        Some(matcher) => json!({
            "event_name": event_label(event).unwrap_or_default(),
            "hooks": [handler],
            "matcher": matcher,
        }),
        None => json!({
            "event_name": event_label(event).unwrap_or_default(),
            "hooks": [handler],
        }),
    };
    let bytes = serde_json::to_vec(&identity).unwrap_or_default();
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

/// A TOML basic string.
fn toml_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for character in value.chars() {
        match character {
            '\\' => out.push_str(r"\\"),
            '"' => out.push_str("\\\""),
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

/// Which Codex hooks a pane registers, and how Codex runs them.
///
/// Every hook is `async`: Codex starts it and continues at once, so KalCode never makes Codex
/// slower. On Windows Codex runs hooks through PowerShell, about 0.35 s per start; run
/// synchronously, PreToolUse and PostToolUse alone added about 0.7 s to every tool call
/// (measured with codex-cli 0.160.0). The session restores order from the turn and tool call
/// ids Codex sends. SessionStart is left out: Codex fires it lazily with the first prompt, right
/// before UserPromptSubmit, so it carries nothing the spawn's READY state and the prompt hook
/// don't already say.
pub fn pane_plan(event: HookEvent) -> Option<HookRun> {
    match event {
        HookEvent::SessionStart => None,
        _ => Some(HookRun::Async),
    }
}

/// The `-c` values (each passed after its own `-c`) that add KalCode's observing hooks
/// ([`pane_plan`]) and trust exactly those hooks for this session.
pub fn session_overrides(
    program: &str,
    prefix_args: &[String],
    endpoint: &str,
    session: &str,
) -> Result<Vec<String>, CodexHookError> {
    session_overrides_with(program, prefix_args, endpoint, session, pane_plan)
}

/// [`session_overrides`] for a chosen set of events and how each runs (`None` leaves the event
/// out).
pub fn session_overrides_with(
    program: &str,
    prefix_args: &[String],
    endpoint: &str,
    session: &str,
    plan: impl Fn(HookEvent) -> Option<HookRun>,
) -> Result<Vec<String>, CodexHookError> {
    let mut overrides = Vec::new();
    let mut trusted = Vec::new();
    for event in HookEvent::CODEX {
        let (Some(label), Some(run)) = (event_label(event), plan(event)) else {
            continue;
        };
        let command = hook_command(program, prefix_args, event, endpoint, session)?;
        let matcher = event.has_tool_matcher().then_some("*");
        let timeout = hook_timeout(event);
        let handler = format!(
            "{{type=\"command\",command={},timeout={timeout}{}}}",
            toml_string(&command),
            if run == HookRun::Async {
                ",async=true"
            } else {
                ""
            }
        );
        overrides.push(match matcher {
            Some(matcher) => format!(
                "hooks.{}=[{{matcher={},hooks=[{handler}]}}]",
                event.as_str(),
                toml_string(matcher)
            ),
            None => format!("hooks.{}=[{{hooks=[{handler}]}}]", event.as_str()),
        });
        let key = format!("{}:{label}:0:0", session_flags_path());
        trusted.push(format!(
            "{}={{trusted_hash={}}}",
            toml_string(&key),
            toml_string(&trust_hash(event, matcher, &command, timeout, run))
        ));
    }
    overrides.push(format!("hooks.state={{{}}}", trusted.join(",")));
    Ok(overrides)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Hashes `codex app-server` `hooks/list` reported as `currentHash` (codex-cli 0.160.0); the
    /// async form was verified by Codex running the hooks (it runs only trusted ones).
    #[test]
    fn trust_hash_matches_codex() {
        let command = "node C:/Users/Kaleb/AppData/Local/Temp/claude/C--Users-Kaleb-Downloads-KalCode/489a27c9-898e-464b-9b17-204e00f5268a/scratchpad/codexhook/log.js Stop";
        assert_eq!(
            trust_hash(HookEvent::Stop, None, command, 10, HookRun::Sync),
            "sha256:ed205bc2a8c749a86f98a68271f596a51e8b7637914f43cb6138396356c1ecef"
        );
    }

    #[test]
    fn overrides_cover_the_codex_events_and_trust_only_kalcode_hooks() {
        let overrides = session_overrides(
            if cfg!(windows) {
                r"C:\Program Files\KalCode\kalcode-hook.exe"
            } else {
                "/opt/KalCode/kalcode-hook"
            },
            &[],
            r"\\.\pipe\kalcode-hook-0123",
            "abcd",
        )
        .expect("overrides");
        let registered: Vec<HookEvent> = HookEvent::CODEX
            .into_iter()
            .filter(|event| pane_plan(*event).is_some())
            .collect();
        assert!(!registered.contains(&HookEvent::SessionStart));
        assert_eq!(overrides.len(), registered.len() + 1);
        for event in registered.iter().copied() {
            let line = overrides
                .iter()
                .find(|line| line.starts_with(&format!("hooks.{}=", event.as_str())))
                .expect("event hook");
            assert_eq!(line.contains("matcher=\"*\""), event.has_tool_matcher());
            assert!(line.contains(",async=true}"), "Codex never waits: {line}");
            assert!(line.contains(&format!("codex {}", event.as_str())) || cfg!(windows));
        }
        let state = overrides.last().expect("state");
        assert!(state.starts_with("hooks.state={"));
        assert_eq!(
            state.matches("trusted_hash=\"sha256:").count(),
            registered.len()
        );
        assert!(
            overrides
                .iter()
                .any(|line| line.starts_with("hooks.Interrupt=") && line.contains("timeout=3,"))
        );
        assert!(!overrides.iter().any(|line| line.contains("bypass")));
    }

    #[cfg(windows)]
    #[test]
    fn windows_commands_are_plain_words_or_powershell_calls() {
        // The usual per-user install: plain words, read alike by PowerShell and cmd.exe.
        let command = hook_command(
            r"C:\Users\Kaleb\AppData\Local\KalCode\kalcode-hook.exe",
            &[],
            HookEvent::PreToolUse,
            r"\\.\pipe\kalcode-hook-0123",
            "abcd",
        )
        .expect("command");
        assert_eq!(
            command,
            r"C:\Users\Kaleb\AppData\Local\KalCode\kalcode-hook.exe codex PreToolUse \\.\pipe\kalcode-hook-0123 abcd"
        );
        // Spaces or shell characters: PowerShell's call operator with literal strings.
        let command = hook_command(
            r"C:\Program Files\Kal's Code\kalcode-hook.exe",
            &[],
            HookEvent::Stop,
            r"\\.\pipe\kalcode-hook-0123",
            "abcd",
        )
        .expect("command");
        assert_eq!(
            command,
            r"& 'C:\Program Files\Kal''s Code\kalcode-hook.exe' 'codex' 'Stop' '\\.\pipe\kalcode-hook-0123' 'abcd'"
        );
        assert_eq!(
            hook_command("C:\\a\nb.exe", &[], HookEvent::Stop, "e", "s"),
            Err(CodexHookError::UnsafeArgument)
        );
        // TOML basic strings round-trip Windows paths.
        assert_eq!(toml_string(r#"C:\a "b""#), r#""C:\\a \"b\"""#);
    }

    #[cfg(not(windows))]
    #[test]
    fn unix_commands_are_plain_words_or_single_quoted() {
        let command = hook_command(
            "/opt/KalCode/kalcode-hook",
            &[],
            HookEvent::Stop,
            "/tmp/e",
            "s",
        )
        .unwrap();
        assert_eq!(command, "/opt/KalCode/kalcode-hook codex Stop /tmp/e s");
        let command = hook_command(
            "/opt/it's/kalcode-hook",
            &[],
            HookEvent::Stop,
            "/tmp/e",
            "s",
        )
        .unwrap();
        assert_eq!(
            command,
            r"'/opt/it'\''s/kalcode-hook' 'codex' 'Stop' '/tmp/e' 's'"
        );
    }
}
