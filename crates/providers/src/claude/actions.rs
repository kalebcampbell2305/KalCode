//! Translates Claude Code tool calls into KalCode [`NormalizedAction`]s, so one policy engine
//! (Z4) can judge every provider. Tool input shapes follow the Agent SDK reference
//! (https://code.claude.com/docs/en/agent-sdk/typescript#tool-input-types). Anything KalCode can't
//! classify precisely becomes `ActionKind::Tool`, which the engine evaluates conservatively.

use kalcode_contracts::agent::ProviderId;
use kalcode_contracts::ids::new_id;
use kalcode_contracts::permissions::{ActionKind, GitOperation, NormalizedAction};
use serde_json::Value;

/// Identifies whose action this is.
#[derive(Debug, Clone)]
pub struct ActionContext {
    pub thread_id: String,
    pub workspace_id: String,
    pub working_directory: String,
}

/// Summaries are for display; keep them short and single-line.
const SUMMARY_MAX: usize = 160;

fn short(text: &str) -> String {
    let line = text.lines().next().unwrap_or("").trim();
    if line.chars().count() <= SUMMARY_MAX {
        let multi = text.trim().lines().nth(1).is_some();
        return if multi {
            format!("{line} …")
        } else {
            line.to_owned()
        };
    }
    let cut: String = line.chars().take(SUMMARY_MAX - 1).collect();
    format!("{cut}…")
}

fn field<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input.get(key).and_then(Value::as_str)
}

/// Classifies a shell command. Only the leading program and subcommand are inspected; the
/// command is never executed or expanded here.
fn classify_command(command: &str, cwd: &str) -> ActionKind {
    let words: Vec<&str> = command.split_whitespace().collect();
    let simple = !command.contains(['|', ';', '&', '>', '<', '`', '$', '\n']);
    if simple {
        match words.as_slice() {
            ["git", sub, rest @ ..] => {
                let operation = match *sub {
                    "status" => GitOperation::Status,
                    "diff" => GitOperation::Diff,
                    "log" => GitOperation::Log,
                    "commit" => GitOperation::Commit,
                    "branch" => GitOperation::Branch,
                    "checkout" | "switch" => GitOperation::Checkout,
                    "push" => GitOperation::Push,
                    "pull" => GitOperation::Pull,
                    "reset" => GitOperation::Reset,
                    _ => GitOperation::Other,
                };
                let remote = matches!(operation, GitOperation::Push | GitOperation::Pull)
                    .then(|| {
                        rest.iter()
                            .find(|w| !w.starts_with('-'))
                            .map(|w| (*w).to_owned())
                    })
                    .flatten();
                return ActionKind::Git { operation, remote };
            }
            [
                manager @ ("npm" | "pnpm" | "yarn" | "bun"),
                verb @ ("install" | "i" | "add"),
                packages @ ..,
            ]
            | [
                manager @ ("pip" | "pip3" | "cargo"),
                verb @ ("install" | "add"),
                packages @ ..,
            ] => {
                let _ = verb;
                return ActionKind::PackageInstall {
                    manager: (*manager).to_owned(),
                    packages: packages
                        .iter()
                        .filter(|p| !p.starts_with('-'))
                        .map(|p| (*p).to_owned())
                        .collect(),
                };
            }
            _ => {}
        }
    }
    ActionKind::Command {
        command: command.to_owned(),
        // Claude Code reports a command string, not an argv; KalCode never guesses a split.
        argv: Vec::new(),
        cwd: cwd.to_owned(),
    }
}

fn host_of(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    host.split(':').next().unwrap_or("").to_ascii_lowercase()
}

/// The action kind and display summary for one tool call.
pub fn classify(tool: &str, input: &Value, cwd: &str) -> (ActionKind, String) {
    let path = |key| field(input, key).unwrap_or("").to_owned();
    match tool {
        "Read" => {
            let p = path("file_path");
            (
                ActionKind::FileRead { path: p.clone() },
                format!("Read {}", short(&p)),
            )
        }
        "Glob" | "Grep" => {
            let p = field(input, "path").unwrap_or(cwd).to_owned();
            let pattern = field(input, "pattern").unwrap_or("");
            (
                ActionKind::FileRead { path: p },
                format!("Search files for {}", short(pattern)),
            )
        }
        "Edit" | "Write" => {
            let p = path("file_path");
            let verb = if tool == "Write" { "Write" } else { "Edit" };
            (
                ActionKind::FileWrite { path: p.clone() },
                format!("{verb} {}", short(&p)),
            )
        }
        "NotebookEdit" => {
            let p = path("notebook_path");
            (
                ActionKind::FileWrite { path: p.clone() },
                format!("Edit {}", short(&p)),
            )
        }
        "Bash" | "PowerShell" => {
            let command = field(input, "command").unwrap_or("");
            (
                classify_command(command, cwd),
                format!("Run {}", short(command)),
            )
        }
        "WebFetch" => {
            let url = field(input, "url").unwrap_or("");
            (
                ActionKind::Network {
                    host: host_of(url),
                    url: Some(url.to_owned()),
                },
                format!("Fetch {}", short(url)),
            )
        }
        "WebSearch" => {
            let query = field(input, "query").unwrap_or("");
            (
                ActionKind::Network {
                    host: "web search".into(),
                    url: None,
                },
                format!("Search the web for {}", short(query)),
            )
        }
        other => {
            let summary = input
                .as_object()
                .map(|o| o.keys().map(String::as_str).collect::<Vec<_>>().join(", "))
                .unwrap_or_default();
            (
                ActionKind::Tool {
                    tool: other.to_owned(),
                    input_summary: short(&summary),
                },
                format!("Use {other}"),
            )
        }
    }
}

/// Builds the [`NormalizedAction`] for a tool call.
pub fn normalize(
    ctx: &ActionContext,
    tool: &str,
    input: &Value,
    requested_at: String,
) -> NormalizedAction {
    let (action, summary) = classify(tool, input, &ctx.working_directory);
    NormalizedAction {
        id: new_id(),
        thread_id: ctx.thread_id.clone(),
        workspace_id: ctx.workspace_id.clone(),
        provider_id: ProviderId::new(ProviderId::CLAUDE_CODE),
        action,
        summary,
        requested_at,
        origin: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn kind(tool: &str, input: Value) -> ActionKind {
        classify(tool, &input, "/work").0
    }

    #[test]
    fn file_tools() {
        assert_eq!(
            kind("Read", json!({"file_path": "/work/a.rs"})),
            ActionKind::FileRead {
                path: "/work/a.rs".into()
            }
        );
        assert_eq!(
            kind(
                "Edit",
                json!({"file_path": "/work/a.rs", "old_string": "x", "new_string": "y"})
            ),
            ActionKind::FileWrite {
                path: "/work/a.rs".into()
            }
        );
        assert_eq!(
            kind("Grep", json!({"pattern": "TODO"})),
            ActionKind::FileRead {
                path: "/work".into()
            }
        );
    }

    #[test]
    fn git_and_package_commands_are_recognized() {
        assert_eq!(
            kind("Bash", json!({"command": "git push origin main"})),
            ActionKind::Git {
                operation: GitOperation::Push,
                remote: Some("origin".into())
            }
        );
        assert_eq!(
            kind("Bash", json!({"command": "git status"})),
            ActionKind::Git {
                operation: GitOperation::Status,
                remote: None
            }
        );
        assert_eq!(
            kind("Bash", json!({"command": "npm install -D lodash"})),
            ActionKind::PackageInstall {
                manager: "npm".into(),
                packages: vec!["lodash".into()]
            }
        );
    }

    #[test]
    fn compound_commands_are_never_downgraded_to_a_harmless_kind() {
        // "git status; git push" must not be classified as a read-only git status.
        for command in [
            "git status; git push",
            "git log | sh",
            "npm install x && rm -rf /",
        ] {
            assert!(
                matches!(
                    kind("Bash", json!({"command": command})),
                    ActionKind::Command { .. }
                ),
                "{command}"
            );
        }
    }

    #[test]
    fn network_and_unknown_tools() {
        assert_eq!(
            kind(
                "WebFetch",
                json!({"url": "https://user:pw@Docs.Example.com:443/a?b", "prompt": "p"})
            ),
            ActionKind::Network {
                host: "docs.example.com".into(),
                url: Some("https://user:pw@Docs.Example.com:443/a?b".into())
            }
        );
        assert_eq!(
            kind(
                "mcp__github__create_issue",
                json!({"title": "t", "body": "b"})
            ),
            ActionKind::Tool {
                tool: "mcp__github__create_issue".into(),
                input_summary: "body, title".into()
            }
        );
    }

    #[test]
    fn summaries_are_short_single_lines() {
        let (_, summary) = classify("Bash", &json!({"command": "echo 1\necho 2"}), "/w");
        assert_eq!(summary, "Run echo 1 …");
        let long = "x".repeat(500);
        let (_, summary) = classify("Bash", &json!({ "command": long }), "/w");
        assert!(summary.chars().count() <= SUMMARY_MAX + 4);
        let (_, summary) = classify("Read", &json!({}), "/w");
        assert_eq!(summary, "Read ");
    }

    #[test]
    fn normalized_actions_carry_context() {
        let ctx = ActionContext {
            thread_id: "t".into(),
            workspace_id: "w".into(),
            working_directory: "/w".into(),
        };
        let action = normalize(&ctx, "Read", &json!({"file_path": "/w/x"}), "now".into());
        assert_eq!(action.provider_id.as_str(), "claude-code");
        assert_eq!(action.thread_id, "t");
        assert!(kalcode_contracts::ids::is_valid_id(&action.id));
    }
}
