//! Real Claude Code tool calls through KalCode's headless adapter (AGENTS.md "Permanent provider
//! tool capability rule"). `#[ignore]`d: needs `KALCODE_REAL_CLAUDE` set to an installed `claude`
//! and a signed-in Claude Code config (`CLAUDE_CONFIG_DIR`, or the default `~/.claude`). Each test
//! sends one short prompt, so it uses a little of that account's usage.
//!
//! `KALCODE_REAL_CLAUDE_MCP_TOOL` names an MCP tool from the person's own config to call (for
//! example `mcp__time__get_current_time`); without it the MCP check is skipped.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use kalcode_contracts::agent::{AgentEvent, AgentInput, AgentSession};
use kalcode_contracts::permissions::PermissionMode;
use kalcode_providers::claude::session::{ClaudeSession, LaunchSpec, SessionTimeouts};

fn real_claude() -> Option<PathBuf> {
    match std::env::var_os("KALCODE_REAL_CLAUDE") {
        Some(path) => Some(PathBuf::from(path)),
        None => {
            eprintln!("skipped: set KALCODE_REAL_CLAUDE to an installed Claude Code executable");
            None
        }
    }
}

/// The person's environment minus the variables that mark a nested Claude Code session.
fn env() -> BTreeMap<OsString, OsString> {
    std::env::vars_os()
        .filter(|(name, _)| {
            let name = name.to_string_lossy().to_ascii_uppercase();
            name != "CLAUDECODE" && !name.starts_with("CLAUDE_CODE_") && name != "KALCODE_HOOK_KEY"
        })
        .collect()
}

struct Turn {
    tools: Vec<(String, String, Option<bool>)>,
    text: String,
}

fn run(mode: PermissionMode, prompt: &str) -> Turn {
    let executable = real_claude().expect("KALCODE_REAL_CLAUDE");
    let workspace = std::env::var_os("CARGO_MANIFEST_DIR").expect("manifest dir");
    let (tx, rx) = mpsc::channel();
    let session = ClaudeSession::start(
        LaunchSpec {
            executable,
            env: env(),
            working_directory: PathBuf::from(workspace).to_string_lossy().into_owned(),
            model: Some("haiku".into()),
            effort: None,
            mode,
            resume_session_id: None,
            timeouts: SessionTimeouts::default(),
            guardian_job: None,
        },
        Box::new(move |event: AgentEvent| {
            let _ = tx.send(event);
        }),
    )
    .expect("start");
    session
        .send(AgentInput::Text {
            text: prompt.into(),
        })
        .expect("send");
    let deadline = Instant::now() + Duration::from_secs(240);
    let mut tools: Vec<(String, String, Option<bool>)> = Vec::new();
    let mut text = String::new();
    while Instant::now() < deadline {
        let Ok(event) = rx.recv_timeout(Duration::from_millis(500)) else {
            continue;
        };
        eprintln!("{event:?}");
        match event {
            AgentEvent::ToolRequested {
                tool_call_id, tool, ..
            } => tools.push((tool_call_id, tool, None)),
            AgentEvent::ToolCompleted {
                tool_call_id, ok, ..
            } => {
                if let Some(entry) = tools.iter_mut().find(|t| t.0 == tool_call_id) {
                    entry.2 = Some(ok);
                }
            }
            AgentEvent::MessageCompleted { text: message, .. } => text.push_str(&message),
            AgentEvent::TurnCompleted { .. } | AgentEvent::Exited { .. } => break,
            _ => {}
        }
    }
    let _ = session.terminate();
    Turn { tools, text }
}

fn ran(turn: &Turn, tool: &str) -> bool {
    turn.tools
        .iter()
        .any(|(_, name, ok)| name == tool && *ok == Some(true))
}

/// "Research X" in Plan, the mode that used to strip web tools entirely.
#[test]
#[ignore = "real Claude Code; set KALCODE_REAL_CLAUDE"]
fn research_runs_in_plan_mode() {
    if real_claude().is_none() {
        return;
    }
    let turn = run(
        PermissionMode::Plan,
        "Use the WebSearch tool once to research the latest Rust stable release. Then reply with \
         one sentence.",
    );
    assert!(ran(&turn, "WebSearch"), "tools: {:?}", turn.tools);
}

/// Shell, file read, repository search and web fetch in an Approve thread, where nobody can
/// answer a prompt: reads and research run; nothing is refused by the harness.
#[test]
#[ignore = "real Claude Code; set KALCODE_REAL_CLAUDE"]
fn approve_thread_reads_searches_and_researches() {
    if real_claude().is_none() {
        return;
    }
    let turn = run(
        PermissionMode::Approve,
        "Do exactly these, one tool call each, in order: 1) Read the file Cargo.toml in the \
         current directory. 2) Use Grep to search for 'fn deny_rules' under src. 3) Use WebFetch \
         on https://www.rust-lang.org with the prompt 'title'. Then reply DONE.",
    );
    for tool in ["Read", "Grep", "WebFetch"] {
        assert!(ran(&turn, tool), "{tool} did not run: {:?}", turn.tools);
    }
}

/// Bypass: shell and an MCP tool from the person's own (native) config.
#[test]
#[ignore = "real Claude Code; set KALCODE_REAL_CLAUDE"]
fn bypass_runs_shell_and_the_users_mcp_tools() {
    if real_claude().is_none() {
        return;
    }
    let mcp = std::env::var("KALCODE_REAL_CLAUDE_MCP_TOOL").ok();
    let prompt = match &mcp {
        Some(tool) => format!(
            "Do exactly these, one tool call each: 1) Run the shell command `git --version`. \
             2) Call the MCP tool {tool} (use any valid arguments). Then reply DONE."
        ),
        None => "Run the shell command `git --version`, then reply DONE.".to_owned(),
    };
    let turn = run(PermissionMode::Bypass, &prompt);
    assert!(
        ran(&turn, "Bash") || ran(&turn, "PowerShell"),
        "no shell: {:?}",
        turn.tools
    );
    if let Some(tool) = mcp {
        assert!(
            ran(&turn, &tool),
            "{tool} did not run: {:?}; {}",
            turn.tools,
            turn.text
        );
    }
}
