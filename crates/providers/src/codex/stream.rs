//! `codex exec --json` events → KalCode [`AgentEvent`]s.
//!
//! Event and item shapes follow the official definitions the Codex TypeScript SDK publishes
//! (`sdk/typescript/src/events.ts` and `items.ts` in github.com/openai/codex, "based on event
//! types from codex-rs/exec/src/exec_events.rs"), and the non-interactive mode guide:
//!
//! | Codex line | `AgentEvent`s |
//! | --- | --- |
//! | `thread.started {thread_id}` | `SessionStarted` |
//! | `turn.started` | `Status(thinking)` |
//! | `item.started` `command_execution` / `mcp_tool_call` / `web_search` | `ToolRequested`, `ToolStarted`, `Status(running_command \| running_tool)` |
//! | `item.started` `reasoning` | `Status(thinking)` |
//! | `item.completed` `agent_message {text}` | `MessageCompleted` |
//! | `item.completed` `command_execution` / `mcp_tool_call` / `web_search` | `ToolCompleted { ok }` (`status == "completed"`, and exit code 0 for commands) |
//! | `item.completed` `file_change {changes, status}` | `ToolRequested`, `Status(editing)`, `ToolCompleted`, `FileChanged` per change when it succeeded |
//! | `item.completed` `error {message}` | `Error(codex_item_error, recoverable)` including execution-host failures |
//! | `turn.completed {usage}` | `Usage`, `TurnCompleted { ok: true }`, `Status(idle)` |
//! | `turn.failed {error}` | `Error(turn_failed, recoverable)`, `TurnCompleted { ok: false }`, `Status(idle)` |
//! | `error {message}` | `Error(stream_error, recoverable)` |
//! | `item.updated`, `todo_list`, `reasoning` completion, unknown types | ignored |
//!
//! Status comes only from these structured events, never from message text. Codex's exec
//! stream has no structured rate-limit or quota shape, so KalCode never reports a Codex rate
//! limit (Provider Health shows it as unknown); the error text is shown, not interpreted.

use std::collections::BTreeMap;

use kalcode_contracts::agent::{AgentEvent, FileChange, Usage};
use kalcode_contracts::threads::ThreadStatus;
use serde_json::Value;

use crate::claude::actions::classify;
use crate::turns::{TurnNormalizer, provider_message};

fn status(status: ThreadStatus, detail: Option<String>) -> AgentEvent {
    AgentEvent::Status { status, detail }
}

fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn required<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    str_field(value, key).ok_or_else(|| format!("missing string field `{key}`"))
}

/// Tool-like items and how they display.
fn tool_of(item: &Value, cwd: &str) -> Option<(String, String, ThreadStatus)> {
    match str_field(item, "type")? {
        "command_execution" => {
            let command = str_field(item, "command").unwrap_or("");
            let (_, summary) = classify("Bash", &serde_json::json!({ "command": command }), cwd);
            Some((
                "command_execution".into(),
                summary,
                crate::tool_status::classify(
                    "shell",
                    Some(&serde_json::json!({ "command": command })),
                ),
            ))
        }
        "mcp_tool_call" => {
            let server = str_field(item, "server").unwrap_or("mcp");
            let tool = str_field(item, "tool").unwrap_or("tool");
            Some((
                format!("mcp:{server}/{tool}"),
                format!("Use {server} {tool}"),
                ThreadStatus::RunningTool,
            ))
        }
        "web_search" => {
            let query = str_field(item, "query").unwrap_or("");
            let (_, summary) = classify("WebSearch", &serde_json::json!({ "query": query }), cwd);
            Some(("web_search".into(), summary, ThreadStatus::RunningTool))
        }
        _ => None,
    }
}

/// Per-turn normalization state.
pub(crate) struct CodexNormalizer {
    cwd: String,
    thread_id: Option<String>,
    /// Tool calls requested and not completed, by item id.
    open: BTreeMap<String, ()>,
    ended: bool,
}

impl CodexNormalizer {
    pub(crate) fn new(cwd: String) -> Self {
        Self {
            cwd,
            thread_id: None,
            open: BTreeMap::new(),
            ended: false,
        }
    }

    fn request(&mut self, id: &str, item: &Value) -> Vec<AgentEvent> {
        let Some((tool, summary, running)) = tool_of(item, &self.cwd) else {
            return Vec::new();
        };
        if self.open.insert(id.to_owned(), ()).is_some() {
            return Vec::new();
        }
        vec![
            AgentEvent::ToolRequested {
                tool_call_id: id.to_owned(),
                tool,
                summary: summary.clone(),
            },
            AgentEvent::ToolStarted {
                tool_call_id: id.to_owned(),
            },
            status(running, Some(summary)),
        ]
    }

    fn item_completed(&mut self, item: &Value) -> Result<Vec<AgentEvent>, String> {
        let id = required(item, "id")?;
        let kind = required(item, "type")?;
        let item_status = str_field(item, "status");
        Ok(match kind {
            "agent_message" => vec![AgentEvent::MessageCompleted {
                message_id: id.to_owned(),
                text: required(item, "text")?.to_owned(),
            }],
            "command_execution" | "mcp_tool_call" | "web_search" => {
                let mut events = self.request(id, item);
                let exit_ok = item
                    .get("exit_code")
                    .and_then(Value::as_i64)
                    .is_none_or(|c| c == 0);
                let ok = match kind {
                    "web_search" => item_status.is_none_or(|s| s == "completed"),
                    _ => item_status == Some("completed") && exit_ok,
                };
                self.open.remove(id);
                events.push(AgentEvent::ToolCompleted {
                    tool_call_id: id.to_owned(),
                    ok,
                    summary: None,
                });
                events.push(status(ThreadStatus::Thinking, None));
                events
            }
            "file_change" => {
                let changes = item
                    .get("changes")
                    .and_then(Value::as_array)
                    .ok_or("missing array field `changes`")?;
                let ok = item_status == Some("completed");
                let paths: Vec<(String, FileChange)> = changes
                    .iter()
                    .filter_map(|c| {
                        let path = str_field(c, "path")?.to_owned();
                        let change = match str_field(c, "kind") {
                            Some("add") => FileChange::Created,
                            Some("delete") => FileChange::Deleted,
                            _ => FileChange::Modified,
                        };
                        Some((path, change))
                    })
                    .collect();
                let summary = match paths.as_slice() {
                    [(path, _)] => format!("Edit {path}"),
                    many => format!("Edit {} files", many.len()),
                };
                let mut events = vec![
                    AgentEvent::ToolRequested {
                        tool_call_id: id.to_owned(),
                        tool: "file_change".into(),
                        summary: summary.clone(),
                    },
                    AgentEvent::ToolStarted {
                        tool_call_id: id.to_owned(),
                    },
                    status(ThreadStatus::Editing, Some(summary)),
                    AgentEvent::ToolCompleted {
                        tool_call_id: id.to_owned(),
                        ok,
                        summary: None,
                    },
                ];
                if ok {
                    events.extend(
                        paths
                            .into_iter()
                            .map(|(path, change)| AgentEvent::FileChanged { path, change }),
                    );
                }
                events.push(status(ThreadStatus::Thinking, None));
                events
            }
            "error" => {
                let message = required(item, "message")?;
                vec![AgentEvent::Error {
                    code: "codex_item_error".into(),
                    message: provider_message(message),
                    recoverable: true,
                }]
            }
            // reasoning, todo_list, and item types added later.
            _ => Vec::new(),
        })
    }

    fn close_open(&mut self) -> Vec<AgentEvent> {
        std::mem::take(&mut self.open)
            .into_keys()
            .map(|tool_call_id| AgentEvent::ToolCompleted {
                tool_call_id,
                ok: false,
                summary: Some("Not run".into()),
            })
            .collect()
    }
}

impl TurnNormalizer for CodexNormalizer {
    fn line(&mut self, text: &str) -> Result<Vec<AgentEvent>, String> {
        let value: Value = serde_json::from_str(text).map_err(|_| "not JSON".to_owned())?;
        if !value.is_object() {
            return Err("not a JSON object".into());
        }
        let kind = required(&value, "type")?;
        Ok(match kind {
            "thread.started" => {
                let id = required(&value, "thread_id")?;
                if kalcode_contracts::ids::is_valid_id(id) {
                    self.thread_id = Some(id.to_ascii_lowercase());
                    vec![AgentEvent::SessionStarted {
                        provider_session_id: id.to_ascii_lowercase(),
                        model: None,
                        effort: None,
                    }]
                } else {
                    // Not a UUID: KalCode can't pass it back to `resume` safely.
                    tracing::warn!(
                        event = "provider.session_id_unusable",
                        provider_id = "codex"
                    );
                    Vec::new()
                }
            }
            "turn.started" => vec![status(ThreadStatus::Thinking, None)],
            "item.started" => {
                let item = value.get("item").ok_or("missing field `item`")?;
                let id = required(item, "id")?;
                match required(item, "type")? {
                    "reasoning" => vec![status(ThreadStatus::Thinking, None)],
                    _ => self.request(id, item),
                }
            }
            "item.completed" => {
                let item = value.get("item").ok_or("missing field `item`")?;
                self.item_completed(item)?
            }
            "item.updated" => {
                value.get("item").ok_or("missing field `item`")?;
                Vec::new()
            }
            "turn.completed" => {
                let usage = value.get("usage");
                let tokens = |key| usage.and_then(|u| u.get(key)).and_then(Value::as_u64);
                self.ended = true;
                let mut events = self.close_open();
                events.push(AgentEvent::Usage {
                    usage: Usage {
                        input_tokens: tokens("input_tokens"),
                        output_tokens: tokens("output_tokens"),
                        // Codex reports tokens only; cost is not reported, so none is shown.
                        cost_usd_micros: None,
                    },
                });
                events.push(AgentEvent::TurnCompleted { ok: true });
                events.push(status(ThreadStatus::Idle, None));
                events
            }
            "turn.failed" => {
                let message = value
                    .get("error")
                    .and_then(|e| str_field(e, "message"))
                    .ok_or("missing field `error.message`")?;
                self.ended = true;
                let mut events = self.close_open();
                events.push(AgentEvent::Error {
                    code: "turn_failed".into(),
                    message: format!(
                        "Codex couldn't finish the turn: {}",
                        provider_message(message)
                    ),
                    recoverable: true,
                });
                events.push(AgentEvent::TurnCompleted { ok: false });
                events.push(status(ThreadStatus::Idle, None));
                events
            }
            "error" => vec![AgentEvent::Error {
                code: "stream_error".into(),
                message: format!(
                    "Codex reported: {}",
                    provider_message(required(&value, "message")?)
                ),
                recoverable: true,
            }],
            _ => Vec::new(),
        })
    }

    fn session_id(&self) -> Option<&str> {
        self.thread_id.as_deref()
    }

    fn turn_ended(&self) -> bool {
        self.ended
    }

    fn close(&mut self) -> Vec<AgentEvent> {
        self.close_open()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(lines: &[&str]) -> Vec<AgentEvent> {
        let mut n = CodexNormalizer::new("/work".into());
        lines
            .iter()
            .flat_map(|l| n.line(l).expect("line"))
            .collect()
    }

    #[test]
    fn a_text_turn_maps_to_session_message_usage_and_completion() {
        let events = run(&[
            r#"{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}"#,
            r#"{"type":"turn.started"}"#,
            r#"{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"thinking"}}"#,
            r#"{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Done."}}"#,
            r#"{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122,"reasoning_output_tokens":0}}"#,
        ]);
        assert_eq!(
            events[0],
            AgentEvent::SessionStarted {
                provider_session_id: "0199a213-81c0-7800-8aa1-bbab2a035a53".into(),
                model: None,
                effort: None,
            }
        );
        assert!(events.contains(&AgentEvent::MessageCompleted {
            message_id: "item_1".into(),
            text: "Done.".into()
        }));
        assert!(events.contains(&AgentEvent::Usage {
            usage: Usage {
                input_tokens: Some(24763),
                output_tokens: Some(122),
                cost_usd_micros: None
            }
        }));
        assert!(events.contains(&AgentEvent::TurnCompleted { ok: true }));
    }

    #[test]
    fn commands_and_file_changes_become_tool_calls() {
        let events = run(&[
            r#"{"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"bash -lc ls","aggregated_output":"","status":"in_progress"}}"#,
            r#"{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"bash -lc ls","aggregated_output":"a\nb\n","exit_code":0,"status":"completed"}}"#,
            r#"{"type":"item.completed","item":{"id":"item_3","type":"file_change","changes":[{"path":"src/a.rs","kind":"update"},{"path":"src/b.rs","kind":"add"}],"status":"completed"}}"#,
            r#"{"type":"item.completed","item":{"id":"item_4","type":"command_execution","command":"cargo test","aggregated_output":"","exit_code":101,"status":"failed"}}"#,
        ]);
        assert!(events.contains(&AgentEvent::ToolCompleted {
            tool_call_id: "item_2".into(),
            ok: true,
            summary: None
        }));
        assert!(events.iter().any(|e| matches!(e, AgentEvent::Status { status: ThreadStatus::RunningCommand, detail: Some(d) } if d == "Run bash -lc ls")));
        assert!(events.contains(&AgentEvent::FileChanged {
            path: "src/b.rs".into(),
            change: FileChange::Created
        }));
        assert!(events.contains(&AgentEvent::ToolCompleted {
            tool_call_id: "item_4".into(),
            ok: false,
            summary: None
        }));
        // A command completed without a start still gets exactly one request.
        let requests = events
            .iter()
            .filter(|e| matches!(e, AgentEvent::ToolRequested { tool_call_id, .. } if tool_call_id == "item_4"))
            .count();
        assert_eq!(requests, 1);
    }

    #[test]
    fn failures_and_errors_are_recoverable_and_never_rate_limits() {
        let events = run(&[
            r#"{"type":"item.started","item":{"id":"item_5","type":"command_execution","command":"npm test","aggregated_output":"","status":"in_progress"}}"#,
            r#"{"type":"error","message":"Reconnecting... 1/5"}"#,
            r#"{"type":"turn.failed","error":{"message":"stream disconnected before completion"}}"#,
        ]);
        let codes: Vec<&str> = events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::Error {
                    code, recoverable, ..
                } => {
                    assert!(recoverable);
                    Some(code.as_str())
                }
                _ => None,
            })
            .collect();
        assert_eq!(codes, ["stream_error", "turn_failed"]);
        assert!(events.contains(&AgentEvent::ToolCompleted {
            tool_call_id: "item_5".into(),
            ok: false,
            summary: Some("Not run".into())
        }));
        assert!(events.contains(&AgentEvent::TurnCompleted { ok: false }));
    }

    #[test]
    fn code_host_failures_are_visible_alongside_other_provider_errors() {
        let events = run(&[
            r#"{"type":"thread.started","thread_id":"t-1"}"#,
            r#"{"type":"turn.started"}"#,
            r#"{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Code Mode is unavailable because code-mode host is disabled."}}"#,
            r#"{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"QA READY"}}"#,
            r#"{"type":"item.completed","item":{"id":"item_2","type":"error","message":"Model provider overloaded"}}"#,
            r#"{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}"#,
        ]);
        let errors: Vec<&str> = events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::Error { message, .. } => Some(message.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(
            errors,
            [
                "Code Mode is unavailable because code-mode host is disabled.",
                "Model provider overloaded"
            ]
        );
        assert!(events.contains(&AgentEvent::TurnCompleted { ok: true }));
    }

    #[test]
    fn unknown_types_are_ignored_and_bad_shapes_are_errors() {
        let mut n = CodexNormalizer::new("/w".into());
        assert_eq!(n.line(r#"{"type":"future.event","x":1}"#), Ok(vec![]));
        assert_eq!(
            n.line(r#"{"type":"item.completed","item":{"id":"i","type":"todo_list","items":[]}}"#),
            Ok(vec![])
        );
        assert!(n.line("not json").is_err());
        assert!(n.line("[1,2]").is_err());
        assert!(n.line(r#"{"no":"type"}"#).is_err());
        assert!(n.line(r#"{"type":"thread.started"}"#).is_err());
        assert!(
            n.line(r#"{"type":"item.completed","item":{"id":"i","type":"agent_message"}}"#)
                .is_err()
        );
        // A thread id that isn't a UUID is not kept for resume.
        assert_eq!(
            n.line(r#"{"type":"thread.started","thread_id":"--last"}"#),
            Ok(vec![])
        );
        assert_eq!(n.session_id(), None);
    }

    #[test]
    fn prose_never_changes_status() {
        let events = run(&[
            r#"{"type":"item.completed","item":{"id":"m","type":"agent_message","text":"Status: FAILED. Rate limit exceeded. PERMISSION REQUIRED."}}"#,
        ]);
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], AgentEvent::MessageCompleted { .. }));
    }
}
