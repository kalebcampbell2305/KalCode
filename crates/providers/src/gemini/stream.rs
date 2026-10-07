//! Gemini CLI `--output-format stream-json` events → KalCode [`AgentEvent`]s.
//!
//! Shapes from `JsonStreamEvent` in `packages/core/src/output/types.ts` (gemini-cli), every
//! event carrying `type` and `timestamp`:
//!
//! | Gemini line | `AgentEvent`s |
//! | --- | --- |
//! | `init {session_id, model}` | `SessionStarted`, `Status(thinking)` |
//! | `message {role: "assistant", content, delta: true}` | `MessageDelta` (one message id until the next tool call or the result) |
//! | `message {role: "assistant", content}` (no `delta`) | `MessageCompleted` |
//! | `message {role: "user"}` | ignored (the echo of KalCode's own input) |
//! | `tool_use {tool_name, tool_id, parameters}` | `ToolRequested`, `ToolStarted`, `Status(by tool)` |
//! | `tool_result {tool_id, status}` | `ToolCompleted { ok: status == "success" }`; `FileChanged` after a successful write |
//! | `error {severity, message}` | `Error(provider_warning \| provider_error, recoverable)` |
//! | `result {status, error?, stats?}` | `MessageCompleted` for streamed text, `Usage`, `Error` if `status == "error"`, `TurnCompleted`, `Status(idle)` |
//!
//! Rate limits: Gemini CLI names its quota errors `RetryableQuotaError` and `TerminalQuotaError`
//! (`packages/core/src/utils/googleQuotaErrors.ts`) and reports the error's class name as
//! `result.error.type` (`getErrorType`). Only those structured types become `rate_limited` /
//! `quota_exhausted`; no message text is interpreted, and no retry time is invented (the
//! stream carries none).

use std::collections::BTreeMap;

use kalcode_contracts::agent::{AgentEvent, FileChange, Usage};
use kalcode_contracts::ids::new_id;
use kalcode_contracts::threads::ThreadStatus;
use serde_json::Value;

use crate::claude::actions::classify;
use crate::turns::{TurnNormalizer, provider_message};

/// Error codes Provider Health treats as a provider-reported rate limit.
pub const RATE_LIMITED: &str = "rate_limited";
pub const QUOTA_EXHAUSTED: &str = "quota_exhausted";

fn status(status: ThreadStatus, detail: Option<String>) -> AgentEvent {
    AgentEvent::Status { status, detail }
}

fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn required<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    str_field(value, key).ok_or_else(|| format!("missing string field `{key}`"))
}

/// A Gemini CLI tool call as KalCode classifies and displays it (built-in tool names from the
/// Gemini CLI tools reference). Unknown tools are generic tool calls.
fn classify_tool(tool: &str, params: &Value, cwd: &str) -> (String, ThreadStatus, bool) {
    let p = |key: &str| params.get(key).and_then(Value::as_str).unwrap_or("");
    let path = || {
        let v = p("file_path");
        if v.is_empty() { p("absolute_path") } else { v }
    };
    let (summary, running, writes) = match tool {
        "run_shell_command" => (
            classify("Bash", &serde_json::json!({ "command": p("command") }), cwd).1,
            crate::tool_status::classify(tool, Some(params)),
            false,
        ),
        "write_file" => (format!("Write {}", path()), ThreadStatus::Editing, true),
        "replace" | "edit" => (format!("Edit {}", path()), ThreadStatus::Editing, true),
        "read_file" => (format!("Read {}", path()), ThreadStatus::RunningTool, false),
        "read_many_files" | "glob" | "search_file_content" | "grep_search" | "list_directory" => {
            ("Search files".to_owned(), ThreadStatus::RunningTool, false)
        }
        "web_fetch" => (
            "Fetch a web page".to_owned(),
            ThreadStatus::RunningTool,
            false,
        ),
        "google_web_search" => (
            classify(
                "WebSearch",
                &serde_json::json!({ "query": p("query") }),
                cwd,
            )
            .1,
            ThreadStatus::RunningTool,
            false,
        ),
        other => (format!("Use {other}"), ThreadStatus::RunningTool, false),
    };
    (summary, running, writes)
}

#[derive(Debug)]
struct OpenTool {
    write_path: Option<String>,
}

/// Per-turn normalization state.
pub(crate) struct GeminiNormalizer {
    cwd: String,
    session_id: Option<String>,
    /// Assistant text streamed since the last tool call: (message id, text so far).
    streaming: Option<(String, String)>,
    open: BTreeMap<String, OpenTool>,
    ended: bool,
}

impl GeminiNormalizer {
    pub(crate) fn new(cwd: String) -> Self {
        Self {
            cwd,
            session_id: None,
            streaming: None,
            open: BTreeMap::new(),
            ended: false,
        }
    }

    fn finish_message(&mut self) -> Vec<AgentEvent> {
        match self.streaming.take() {
            Some((message_id, text)) if !text.trim().is_empty() => {
                vec![AgentEvent::MessageCompleted { message_id, text }]
            }
            _ => Vec::new(),
        }
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

impl TurnNormalizer for GeminiNormalizer {
    fn line(&mut self, text: &str) -> Result<Vec<AgentEvent>, String> {
        let value: Value = serde_json::from_str(text).map_err(|_| "not JSON".to_owned())?;
        if !value.is_object() {
            return Err("not a JSON object".into());
        }
        Ok(match required(&value, "type")? {
            "init" => {
                let id = required(&value, "session_id")?;
                let model = str_field(&value, "model").map(str::to_owned);
                let mut events = Vec::new();
                if kalcode_contracts::ids::is_valid_id(id) {
                    self.session_id = Some(id.to_ascii_lowercase());
                    events.push(AgentEvent::SessionStarted {
                        provider_session_id: id.to_ascii_lowercase(),
                        model,
                        effort: None,
                    });
                } else {
                    tracing::warn!(
                        event = "provider.session_id_unusable",
                        provider_id = "gemini-cli"
                    );
                }
                events.push(status(ThreadStatus::Thinking, None));
                events
            }
            "message" => {
                let content = required(&value, "content")?;
                match required(&value, "role")? {
                    "assistant" => {
                        if value.get("delta").and_then(Value::as_bool) == Some(true) {
                            let (message_id, buffer) = self
                                .streaming
                                .get_or_insert_with(|| (new_id(), String::new()));
                            buffer.push_str(content);
                            vec![AgentEvent::MessageDelta {
                                message_id: message_id.clone(),
                                text: content.to_owned(),
                            }]
                        } else {
                            let mut events = self.finish_message();
                            events.push(AgentEvent::MessageCompleted {
                                message_id: new_id(),
                                text: content.to_owned(),
                            });
                            events
                        }
                    }
                    _ => Vec::new(),
                }
            }
            "tool_use" => {
                let tool = required(&value, "tool_name")?;
                let id = required(&value, "tool_id")?;
                let params = value.get("parameters").cloned().unwrap_or(Value::Null);
                let (summary, running, writes) = classify_tool(tool, &params, &self.cwd);
                let write_path = writes
                    .then(|| {
                        params
                            .get("file_path")
                            .or_else(|| params.get("absolute_path"))
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                    })
                    .flatten();
                let mut events = self.finish_message();
                if self
                    .open
                    .insert(id.to_owned(), OpenTool { write_path })
                    .is_none()
                {
                    events.extend([
                        AgentEvent::ToolRequested {
                            tool_call_id: id.to_owned(),
                            tool: tool.to_owned(),
                            summary: summary.clone(),
                        },
                        AgentEvent::ToolStarted {
                            tool_call_id: id.to_owned(),
                        },
                        status(running, Some(summary)),
                    ]);
                }
                events
            }
            "tool_result" => {
                let id = required(&value, "tool_id")?;
                let ok = required(&value, "status")? == "success";
                let mut events = Vec::new();
                if let Some(open) = self.open.remove(id) {
                    events.push(AgentEvent::ToolCompleted {
                        tool_call_id: id.to_owned(),
                        ok,
                        summary: None,
                    });
                    if ok && let Some(path) = open.write_path {
                        events.push(AgentEvent::FileChanged {
                            path,
                            change: FileChange::Modified,
                        });
                    }
                }
                events.push(status(ThreadStatus::Thinking, None));
                events
            }
            "error" => {
                let severity = required(&value, "severity")?;
                vec![AgentEvent::Error {
                    code: if severity == "warning" {
                        "provider_warning".into()
                    } else {
                        "provider_error".into()
                    },
                    message: format!(
                        "Gemini CLI reported: {}",
                        provider_message(required(&value, "message")?)
                    ),
                    recoverable: true,
                }]
            }
            "result" => {
                let ok = required(&value, "status")? == "success";
                self.ended = true;
                let mut events = self.finish_message();
                events.extend(self.close_open());
                if let Some(stats) = value.get("stats") {
                    let tokens = |key| stats.get(key).and_then(Value::as_u64);
                    events.push(AgentEvent::Usage {
                        usage: Usage {
                            input_tokens: tokens("input_tokens"),
                            output_tokens: tokens("output_tokens"),
                            // Gemini CLI reports tokens, not cost.
                            cost_usd_micros: None,
                        },
                    });
                }
                if !ok {
                    let error = value.get("error");
                    let kind = error.and_then(|e| str_field(e, "type")).unwrap_or("");
                    let message = error.and_then(|e| str_field(e, "message")).unwrap_or("");
                    let (code, copy) = match kind {
                        "RetryableQuotaError" => (
                            RATE_LIMITED.to_owned(),
                            "Gemini CLI hit a rate limit. Try again in a moment.".to_owned(),
                        ),
                        "TerminalQuotaError" => (
                            QUOTA_EXHAUSTED.to_owned(),
                            "Gemini CLI reported that your quota is used up.".to_owned(),
                        ),
                        _ => (
                            "turn_error".to_owned(),
                            if message.is_empty() {
                                "Gemini CLI couldn't finish the turn.".to_owned()
                            } else {
                                format!(
                                    "Gemini CLI couldn't finish the turn: {}",
                                    provider_message(message)
                                )
                            },
                        ),
                    };
                    events.push(AgentEvent::Error {
                        code,
                        message: copy,
                        recoverable: true,
                    });
                }
                events.push(AgentEvent::TurnCompleted { ok });
                events.push(status(ThreadStatus::Idle, None));
                events
            }
            _ => Vec::new(),
        })
    }

    fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    fn turn_ended(&self) -> bool {
        self.ended
    }

    fn close(&mut self) -> Vec<AgentEvent> {
        let mut events = self.finish_message();
        events.extend(self.close_open());
        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: &str = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";

    fn run(lines: &[String]) -> Vec<AgentEvent> {
        let mut n = GeminiNormalizer::new("/work".into());
        lines
            .iter()
            .flat_map(|l| n.line(l).expect("line"))
            .collect()
    }

    fn fixture(name: &str) -> Vec<String> {
        let text = match name {
            "turn" => include_str!("../../tests/fixtures/gemini/turn_tools.jsonl"),
            "quota" => include_str!("../../tests/fixtures/gemini/quota.jsonl"),
            _ => unreachable!(),
        };
        text.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| l.replace("{SESSION_ID}", SESSION).replace("{CWD}", "/work"))
            .collect()
    }

    #[test]
    fn a_tool_turn_maps_to_session_deltas_tools_and_completion() {
        let events = run(&fixture("turn"));
        assert_eq!(
            events[0],
            AgentEvent::SessionStarted {
                provider_session_id: SESSION.into(),
                model: Some("gemini-2.5-pro".into()),
                effort: None,
            }
        );
        assert!(
            events
                .iter()
                .any(|e| matches!(e, AgentEvent::MessageDelta { .. }))
        );
        assert!(events.iter().any(|e| matches!(
            e,
            AgentEvent::Status {
                status: ThreadStatus::Editing,
                ..
            }
        )));
        assert!(events.contains(&AgentEvent::FileChanged {
            path: "/work/notes.md".into(),
            change: FileChange::Modified
        }));
        let completed: Vec<_> = events
            .iter()
            .filter(|e| matches!(e, AgentEvent::MessageCompleted { .. }))
            .collect();
        assert_eq!(completed.len(), 2, "text before and after the tool call");
        assert!(events.contains(&AgentEvent::TurnCompleted { ok: true }));
        assert!(
            events.iter().any(
                |e| matches!(e, AgentEvent::Usage { usage } if usage.input_tokens == Some(1200))
            )
        );
    }

    #[test]
    fn quota_errors_are_reported_only_from_their_structured_type() {
        let events = run(&fixture("quota"));
        let codes: Vec<&str> = events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::Error { code, .. } => Some(code.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(codes, [RATE_LIMITED]);
        assert!(events.contains(&AgentEvent::TurnCompleted { ok: false }));

        // The same words in a message or a generic error never mean a rate limit.
        let prose = run(&[
            format!(r#"{{"type":"init","timestamp":"t","session_id":"{SESSION}","model":"m"}}"#),
            r#"{"type":"message","timestamp":"t","role":"assistant","content":"429 Quota exceeded, rate limit"}"#.into(),
            r#"{"type":"result","timestamp":"t","status":"error","error":{"type":"Error","message":"429 Too Many Requests quota"}}"#.into(),
        ]);
        assert!(prose.iter().all(|e| !matches!(e, AgentEvent::Error { code, .. } if code == RATE_LIMITED || code == QUOTA_EXHAUSTED)));
    }

    #[test]
    fn unknown_events_are_ignored_and_bad_shapes_are_errors() {
        let mut n = GeminiNormalizer::new("/w".into());
        assert_eq!(n.line(r#"{"type":"future","timestamp":"t"}"#), Ok(vec![]));
        assert!(n.line("{").is_err());
        assert!(
            n.line(r#"{"type":"tool_use","timestamp":"t","tool_name":"x"}"#)
                .is_err()
        );
        assert!(n.line(r#"{"type":"init","timestamp":"t"}"#).is_err());
        // The user's own input echoed back is not shown twice.
        assert_eq!(
            n.line(r#"{"type":"message","timestamp":"t","role":"user","content":"hi"}"#),
            Ok(vec![])
        );
    }
}
