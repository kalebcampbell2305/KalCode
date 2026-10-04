//! The `kalcode-hook` helper's logic (the binary is a thin wrapper, so this is testable).
//!
//! Invocations (exec form, set up by KalCode's session settings; never a shell):
//!
//! ```text
//! kalcode-hook claude <HookEvent> <endpoint> <session>     # hook JSON on stdin
//! kalcode-hook codex-notify <endpoint> <session> <json>    # Codex appends its JSON payload
//! ```
//!
//! The session key comes from [`crate::KEY_ENV`] in the environment the provider passes to its
//! hooks. `PreToolUse` fails closed (exit 2) on every error and on its own deadline, which is
//! shorter than the hook timeout KalCode configures (a timed-out hook would not block). Every
//! other event fails open (exit 0, no output).

use std::io::Read;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crate::record::{self, HookEvent, MAX_STDIN_BYTES};
use crate::reply::Rendered;
use crate::{BridgeError, DEADLINE_ENV, Endpoint, HookRecord, HookReply, KEY_ENV, SessionKey};

/// The hook timeout KalCode sets for `PreToolUse` in the session settings, in seconds.
pub const PRE_TOOL_USE_HOOK_TIMEOUT_SECS: u64 = 600;
/// The hook timeout for status events, in seconds.
pub const STATUS_HOOK_TIMEOUT_SECS: u64 = 10;
/// The helper's own deadline for `PreToolUse`: well inside the hook timeout.
pub const PRE_TOOL_USE_DEADLINE: Duration =
    Duration::from_secs(PRE_TOOL_USE_HOOK_TIMEOUT_SECS - 10);
/// How long KalCode may hold a `PreToolUse` call waiting for the person before it hands the call
/// to the provider's own prompt. Shorter than [`PRE_TOOL_USE_DEADLINE`].
pub const ASK_WINDOW: Duration = Duration::from_secs(PRE_TOOL_USE_HOOK_TIMEOUT_SECS - 60);
const PRE_TOOL_USE_CONNECT: Duration = Duration::from_secs(3);
const STATUS_DEADLINE: Duration = Duration::from_secs(4);
const STATUS_CONNECT: Duration = Duration::from_secs(1);

const BLOCK_HINT: &str = "Check that KalCode is running, then try again from the KalCode pane.";

/// What the helper reads from its environment.
#[derive(Debug, Clone, Default)]
pub struct HelperEnv {
    pub key_hex: Option<String>,
    /// [`DEADLINE_ENV`]: lowers (never raises) the deadlines.
    pub deadline_ms: Option<u64>,
}

impl HelperEnv {
    pub fn from_process() -> Self {
        Self {
            key_hex: std::env::var(KEY_ENV).ok(),
            deadline_ms: std::env::var(DEADLINE_ENV)
                .ok()
                .and_then(|v| v.trim().parse().ok()),
        }
    }

    fn cap(&self, limit: Duration) -> Duration {
        match self.deadline_ms {
            Some(ms) => limit.min(Duration::from_millis(ms)),
            None => limit,
        }
    }
}

/// Whether this invocation must fail closed. Decided from the arguments alone, before anything
/// else can fail, so the panic hook in the binary knows which exit code to use.
pub fn is_blocking_invocation(args: &[String]) -> bool {
    args.first().map(String::as_str) == Some("claude")
        && args
            .get(1)
            .and_then(|e| HookEvent::parse(e))
            .is_some_and(HookEvent::is_blocking)
}

/// Runs the helper and returns what to print and the exit code.
pub fn run(args: &[String], stdin: &mut dyn Read, env: &HelperEnv) -> Rendered {
    match args.first().map(String::as_str) {
        Some("claude") => run_claude(args, stdin, env),
        Some("codex-notify") => run_codex_notify(args, env),
        _ => {
            // Not an invocation KalCode configures. If it looks like a PreToolUse call, block.
            if is_blocking_invocation(args) {
                Rendered::block("KalCode's hook was called with unexpected arguments.")
            } else {
                Rendered::silent()
            }
        }
    }
}

fn run_claude(args: &[String], stdin: &mut dyn Read, env: &HelperEnv) -> Rendered {
    let event = args.get(1).and_then(|e| HookEvent::parse(e));
    let blocking = event.is_some_and(HookEvent::is_blocking);
    let fail = |why: &str| {
        if blocking {
            Rendered::block(&format!(
                "KalCode couldn't check this tool call ({why}), so it was blocked. {BLOCK_HINT}"
            ))
        } else {
            Rendered::silent()
        }
    };
    let Some(event) = event else {
        return fail("unknown hook event");
    };
    let (Some(endpoint), Some(session)) = (
        args.get(2).and_then(|e| Endpoint::parse(e)),
        args.get(3).filter(|s| crate::key::is_hex_of_len(s, 32)),
    ) else {
        return fail("invalid hook configuration");
    };
    let Some(key) = env.key_hex.as_deref().and_then(SessionKey::from_hex) else {
        return fail("no session key");
    };

    let mut bytes = Vec::new();
    if stdin
        .take(MAX_STDIN_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return fail("unreadable hook input");
    }
    let record = match record::from_claude_stdin(event, &bytes) {
        Ok(record) => record,
        Err(error) => return fail(&error.to_string()),
    };

    let (deadline, connect) = if blocking {
        (PRE_TOOL_USE_DEADLINE, PRE_TOOL_USE_CONNECT)
    } else {
        (STATUS_DEADLINE, STATUS_CONNECT)
    };
    match exchange_within(
        endpoint,
        session.clone(),
        key,
        record,
        env.cap(deadline),
        env.cap(connect),
    ) {
        Ok(reply) if blocking => reply.render_pre_tool_use(),
        Ok(reply) if event == HookEvent::UserPromptSubmit => reply.render_user_prompt(),
        Ok(_) => Rendered::silent(),
        Err(BridgeError::TimedOut) => fail("KalCode did not answer in time"),
        Err(BridgeError::BadReply) => fail("KalCode's answer could not be verified"),
        Err(_) => fail("KalCode is not reachable"),
    }
}

fn run_codex_notify(args: &[String], env: &HelperEnv) -> Rendered {
    // Status only: whatever happens, Codex continues.
    let (Some(endpoint), Some(session), Some(payload)) = (
        args.get(1).and_then(|e| Endpoint::parse(e)),
        args.get(2).filter(|s| crate::key::is_hex_of_len(s, 32)),
        args.get(3),
    ) else {
        return Rendered::silent();
    };
    let Some(key) = env.key_hex.as_deref().and_then(SessionKey::from_hex) else {
        return Rendered::silent();
    };
    if let Ok(record) = record::from_codex_notify(payload) {
        let _ = exchange_within(
            endpoint,
            session.clone(),
            key,
            record,
            env.cap(STATUS_DEADLINE),
            env.cap(STATUS_CONNECT),
        );
    }
    Rendered::silent()
}

/// Runs the exchange on a worker thread so a stalled server can't hold the helper past
/// `deadline` (blocking pipe reads have no timeout of their own).
fn exchange_within(
    endpoint: Endpoint,
    session: String,
    key: SessionKey,
    record: HookRecord,
    deadline: Duration,
    connect: Duration,
) -> Result<HookReply, BridgeError> {
    let started = Instant::now();
    let (tx, rx) = mpsc::channel();
    std::thread::Builder::new()
        .name("kalcode-hook-exchange".into())
        .spawn(move || {
            let result = crate::client::exchange(
                &endpoint,
                &session,
                &key,
                &record,
                started + connect.min(deadline),
            );
            let _ = tx.send(result);
        })
        .map_err(BridgeError::Io)?;
    match rx.recv_timeout(deadline) {
        Ok(result) => result,
        Err(_) => Err(BridgeError::TimedOut),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn deadlines_nest_inside_the_hook_timeout() {
        assert!(ASK_WINDOW + Duration::from_secs(30) < PRE_TOOL_USE_DEADLINE);
        assert!(PRE_TOOL_USE_DEADLINE < Duration::from_secs(PRE_TOOL_USE_HOOK_TIMEOUT_SECS));
        assert!(STATUS_DEADLINE < Duration::from_secs(STATUS_HOOK_TIMEOUT_SECS));
    }

    #[test]
    fn the_deadline_knob_only_lowers() {
        let env = HelperEnv {
            key_hex: None,
            deadline_ms: Some(10_000_000),
        };
        assert_eq!(env.cap(STATUS_DEADLINE), STATUS_DEADLINE);
        let env = HelperEnv {
            key_hex: None,
            deadline_ms: Some(5),
        };
        assert_eq!(env.cap(STATUS_DEADLINE), Duration::from_millis(5));
    }

    #[test]
    fn only_pre_tool_use_invocations_are_blocking() {
        assert!(is_blocking_invocation(&args(&["claude", "PreToolUse"])));
        assert!(!is_blocking_invocation(&args(&["claude", "Stop"])));
        assert!(!is_blocking_invocation(&args(&["codex-notify"])));
        assert!(!is_blocking_invocation(&args(&[])));
    }

    #[test]
    fn misconfigured_pre_tool_use_blocks_and_status_stays_silent() {
        let key = SessionKey::generate().expect("key").to_hex();
        let env = HelperEnv {
            key_hex: Some(key),
            deadline_ms: Some(200),
        };
        let stdin = br#"{"session_id":"s","tool_name":"Bash","tool_input":{"command":"ls"}}"#;
        for bad in [
            args(&["claude", "PreToolUse"]),
            args(&["claude", "PreToolUse", "not-an-endpoint", "0123"]),
        ] {
            let out = run(&bad, &mut stdin.as_slice(), &env);
            assert_eq!(out.exit_code, 2, "{bad:?}");
            assert!(out.stdout.is_empty());
        }
        let out = run(&args(&["claude", "Stop"]), &mut stdin.as_slice(), &env);
        assert_eq!(out, Rendered::silent());
    }

    #[test]
    fn missing_key_blocks_pre_tool_use() {
        let endpoint = Endpoint::generate(Some(&std::env::temp_dir())).expect("endpoint");
        let session = crate::key::random_id().expect("id");
        let out = run(
            &args(&["claude", "PreToolUse", endpoint.as_str(), &session]),
            &mut br#"{}"#.as_slice(),
            &HelperEnv::default(),
        );
        assert_eq!(out.exit_code, 2);
        assert!(out.stderr.contains("no session key"), "{}", out.stderr);
    }
}
