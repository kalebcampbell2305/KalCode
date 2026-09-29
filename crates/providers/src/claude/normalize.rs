//! Turns parsed Claude Code stream lines into normalized [`AgentEvent`]s.
//!
//! Status is derived only from structured stream events (message start, tool use, tool result,
//! result), never from model prose. Subagent traffic (`parent_tool_use_id` set) is folded into the
//! parent tool call and not surfaced as top-level messages.

use std::collections::{HashMap, HashSet};

use kalcode_contracts::agent::{AgentEvent, FileChange, Usage};
use kalcode_contracts::threads::ThreadStatus;
use serde_json::Value;

use super::actions::classify;
use super::stream::{Block, ClaudeLine, ParseError, StreamEvent};

/// Malformed lines reported individually before the adapter goes quiet about them.
const MAX_REPORTED_PARSE_ERRORS: u32 = 5;

#[derive(Debug, Clone)]
struct PendingTool {
    name: String,
    input: Value,
}

/// Per-session normalization state.
#[derive(Debug, Default)]
pub(crate) struct Normalizer {
    working_directory: String,
    provider_session_id: Option<String>,
    capabilities: Vec<String>,
    /// Message id of the assistant message currently streaming (from `message_start`).
    streaming_message: Option<String>,
    tools: HashMap<String, PendingTool>,
    denied: HashSet<String>,
    parse_errors: u32,
}

impl Normalizer {
    pub(crate) fn new(working_directory: String) -> Self {
        Self {
            working_directory,
            ..Self::default()
        }
    }

    pub(crate) fn provider_session_id(&self) -> Option<&str> {
        self.provider_session_id.as_deref()
    }

    /// Whether Claude Code advertised a protocol capability in `system/init`.
    pub(crate) fn has_capability(&self, name: &str) -> bool {
        self.capabilities.iter().any(|c| c == name)
    }

    /// Reports a line that could not be parsed. The line itself is never echoed: it may contain
    /// project content.
    pub(crate) fn parse_error(&mut self, error: &ParseError) -> Vec<AgentEvent> {
        self.parse_errors = self.parse_errors.saturating_add(1);
        tracing::warn!(event = "provider.stream_parse_error", provider_id = "claude-code", error = %error);
        match self.parse_errors {
            n if n < MAX_REPORTED_PARSE_ERRORS => vec![protocol_error(
                "Claude Code sent a line KalCode couldn't read. It was skipped.",
            )],
            MAX_REPORTED_PARSE_ERRORS => vec![protocol_error(
                "Claude Code keeps sending output KalCode can't read. Further unreadable lines \
                 are skipped silently.",
            )],
            _ => Vec::new(),
        }
    }

    pub(crate) fn line_too_long(&mut self, bytes: usize) -> Vec<AgentEvent> {
        tracing::warn!(
            event = "provider.stream_line_too_long",
            provider_id = "claude-code",
            bytes
        );
        vec![protocol_error(
            "Claude Code sent an event larger than KalCode accepts. It was skipped.",
        )]
    }

    pub(crate) fn normalize(&mut self, line: ClaudeLine) -> Vec<AgentEvent> {
        match line {
            ClaudeLine::Init {
                session_id,
                model,
                capabilities,
                ..
            } => {
                self.provider_session_id = Some(session_id.clone());
                self.capabilities = capabilities;
                vec![
                    AgentEvent::SessionStarted {
                        provider_session_id: session_id,
                        model,
                    },
                    status(ThreadStatus::Active, None),
                ]
            }
            ClaudeLine::ApiRetry {
                attempt,
                max_retries,
                error,
            } => vec![status(
                ThreadStatus::Recovering,
                Some(match max_retries {
                    Some(max) => format!(
                        "Retrying after {} (attempt {attempt} of {max})",
                        api_error_label(&error)
                    ),
                    None => format!(
                        "Retrying after {} (attempt {attempt})",
                        api_error_label(&error)
                    ),
                }),
            )],
            ClaudeLine::PermissionDenied {
                tool_name,
                tool_use_id,
            } => {
                self.denied.insert(tool_use_id);
                vec![AgentEvent::Error {
                    code: "permission_denied".into(),
                    message: format!("{tool_name} was denied by this thread's permission mode."),
                    recoverable: true,
                }]
            }
            ClaudeLine::System { .. } | ClaudeLine::Unknown { .. } => Vec::new(),
            ClaudeLine::Stream {
                parent_tool_use_id: Some(_),
                ..
            } => Vec::new(),
            ClaudeLine::Stream { event, .. } => match event {
                StreamEvent::MessageStart { message_id } => {
                    self.streaming_message = Some(message_id);
                    vec![status(ThreadStatus::Thinking, None)]
                }
                StreamEvent::TextDelta { text } => match &self.streaming_message {
                    Some(message_id) => vec![AgentEvent::MessageDelta {
                        message_id: message_id.clone(),
                        text,
                    }],
                    None => Vec::new(),
                },
                StreamEvent::Other => Vec::new(),
            },
            ClaudeLine::Assistant {
                parent_tool_use_id: Some(_),
                ..
            } => Vec::new(),
            ClaudeLine::Assistant {
                message_id,
                blocks,
                error,
                ..
            } => self.assistant(message_id, blocks, error),
            ClaudeLine::User {
                parent_tool_use_id: Some(_),
                ..
            } => Vec::new(),
            ClaudeLine::User { tool_results, .. } => {
                let mut events = Vec::new();
                for result in tool_results {
                    let denied = self.denied.remove(&result.tool_use_id);
                    let ok = !result.is_error && !denied;
                    let tool = self.tools.remove(&result.tool_use_id);
                    events.push(AgentEvent::ToolCompleted {
                        tool_call_id: result.tool_use_id,
                        ok,
                        summary: denied.then(|| "Denied by the permission mode".to_owned()),
                    });
                    if ok && let Some(change) = tool.as_ref().and_then(file_change) {
                        events.push(change);
                    }
                }
                if !events.is_empty() {
                    events.push(status(ThreadStatus::Thinking, None));
                }
                events
            }
            ClaudeLine::Result {
                subtype,
                is_error,
                session_id,
                usage,
                total_cost_usd,
                ..
            } => {
                if let Some(id) = session_id {
                    self.provider_session_id.get_or_insert(id);
                }
                self.streaming_message = None;
                let ok = subtype == "success" && !is_error;
                let mut events = vec![AgentEvent::Usage {
                    usage: Usage {
                        input_tokens: usage.input,
                        output_tokens: usage.output,
                        cost_usd_micros: total_cost_usd
                            .filter(|c| c.is_finite() && *c >= 0.0)
                            .map(|c| (c * 1_000_000.0).round() as u64),
                    },
                }];
                if !ok {
                    // `subtype: "success"` with `is_error: true` is a turn that completed with an
                    // error result (an API or account error). It is not a "turn_success" code.
                    let (code, message) = if subtype == "success" {
                        (
                            "turn_error_result".to_owned(),
                            "Claude Code reported an error for this turn.".to_owned(),
                        )
                    } else {
                        (
                            format!("turn_{}", sanitize_code(&subtype)),
                            result_error_message(&subtype),
                        )
                    };
                    events.push(AgentEvent::Error {
                        code,
                        message,
                        recoverable: true,
                    });
                }
                events.push(AgentEvent::TurnCompleted { ok });
                events.push(status(ThreadStatus::Idle, None));
                events
            }
            // Control traffic is handled by the session, not surfaced as agent events.
            ClaudeLine::ControlResponse { .. } | ClaudeLine::ControlRequest { .. } => Vec::new(),
        }
    }

    fn assistant(
        &mut self,
        message_id: String,
        blocks: Vec<Block>,
        error: Option<String>,
    ) -> Vec<AgentEvent> {
        let mut events = Vec::new();
        if let Some(error) = error {
            events.push(AgentEvent::Error {
                code: format!("api_{}", sanitize_code(&error)),
                message: api_error_message(&error),
                recoverable: matches!(
                    error.as_str(),
                    "rate_limit" | "overloaded" | "server_error" | "max_output_tokens" | "unknown"
                ),
            });
        }
        let text: String = blocks
            .iter()
            .filter_map(|b| match b {
                Block::Text(t) => Some(t.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("");
        if !text.is_empty() {
            events.push(AgentEvent::MessageCompleted { message_id, text });
        }
        for block in blocks {
            if let Block::ToolUse { id, name, input } = block {
                let (action, summary) = classify(&name, &input, &self.working_directory);
                let tool_state = tool_status(&name, &action);
                events.push(AgentEvent::ToolRequested {
                    tool_call_id: id.clone(),
                    tool: name.clone(),
                    summary: summary.clone(),
                });
                self.tools.insert(id, PendingTool { name, input });
                events.push(status(tool_state, Some(summary)));
            }
        }
        events
    }
}

fn status(status: ThreadStatus, detail: Option<String>) -> AgentEvent {
    AgentEvent::Status { status, detail }
}

fn protocol_error(message: &str) -> AgentEvent {
    AgentEvent::Error {
        code: "protocol_error".into(),
        message: message.into(),
        recoverable: true,
    }
}

fn tool_status(tool: &str, action: &kalcode_contracts::permissions::ActionKind) -> ThreadStatus {
    use kalcode_contracts::permissions::ActionKind;
    match action {
        ActionKind::FileWrite { .. } | ActionKind::FileDelete { .. } => ThreadStatus::Editing,
        ActionKind::Command { .. } | ActionKind::PackageInstall { .. } | ActionKind::Git { .. } => {
            ThreadStatus::RunningCommand
        }
        _ if tool == "Bash" || tool == "PowerShell" => ThreadStatus::RunningCommand,
        _ => ThreadStatus::RunningTool,
    }
}

fn file_change(tool: &PendingTool) -> Option<AgentEvent> {
    let key = match tool.name.as_str() {
        "Edit" | "Write" => "file_path",
        "NotebookEdit" => "notebook_path",
        _ => return None,
    };
    let path = tool.input.get(key)?.as_str()?.to_owned();
    Some(AgentEvent::FileChanged {
        path,
        // Claude Code doesn't say whether Write created the file; report it as modified.
        change: FileChange::Modified,
    })
}

/// Codes embedded in event codes: lowercase ASCII, digits and `_` only.
fn sanitize_code(raw: &str) -> String {
    raw.chars()
        .take(48)
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect()
}

fn api_error_label(error: &str) -> &'static str {
    match error {
        "rate_limit" => "a rate limit",
        "overloaded" => "the service being overloaded",
        "server_error" => "a server error",
        "authentication_failed" => "an authentication failure",
        _ => "an API error",
    }
}

/// User-safe copy for `SDKAssistantMessageError` values (Agent SDK reference).
fn api_error_message(error: &str) -> String {
    match error {
        "authentication_failed" | "oauth_org_not_allowed" => {
            "Claude Code isn't signed in. Run `claude` in a terminal to sign in, then try again."
        }
        "account_on_hold" => "Your Claude account is on hold.",
        "billing_error" => "Claude reported a billing problem with your account.",
        "rate_limit" => "Claude's usage limit was reached. Try again later.",
        "overloaded" => "Claude is overloaded right now. Try again shortly.",
        "model_not_found" => "The selected model isn't available to your account.",
        "invalid_request" => "Claude rejected the request.",
        "server_error" => "Claude had a server error.",
        "max_output_tokens" => "The reply hit the maximum output length.",
        "cloud_credential_error" => "Claude Code couldn't load its cloud credentials.",
        _ => "Claude reported an error.",
    }
    .to_owned()
}

/// User-safe copy for `SDKResultMessage` error subtypes.
fn result_error_message(subtype: &str) -> String {
    match subtype {
        "error_max_turns" => "The turn stopped at its turn limit.",
        "error_max_budget_usd" => "The turn stopped at its spending limit.",
        "error_during_execution" => "The turn ended with an error or was interrupted.",
        _ => "The turn ended with an error.",
    }
    .to_owned()
}

#[cfg(test)]
mod tests {
    use super::super::stream::parse_line;
    use super::*;

    fn run(lines: &[&str]) -> Vec<AgentEvent> {
        let mut n = Normalizer::new("/work".into());
        lines
            .iter()
            .flat_map(|l| match parse_line(l) {
                Ok(line) => n.normalize(line),
                Err(e) => n.parse_error(&e),
            })
            .collect()
    }

    #[test]
    fn deltas_use_the_streaming_message_id() {
        let events = run(&[
            r#"{"type":"stream_event","parent_tool_use_id":null,"uuid":"u","session_id":"s","event":{"type":"message_start","message":{"id":"msg_1"}}}"#,
            r#"{"type":"stream_event","parent_tool_use_id":null,"uuid":"u","session_id":"s","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}}"#,
        ]);
        assert_eq!(
            events,
            [
                status(ThreadStatus::Thinking, None),
                AgentEvent::MessageDelta {
                    message_id: "msg_1".into(),
                    text: "Hel".into()
                }
            ]
        );
    }

    #[test]
    fn denied_tools_complete_as_not_ok() {
        let events = run(&[
            r#"{"type":"assistant","parent_tool_use_id":null,"message":{"id":"m","content":[{"type":"tool_use","id":"t1","name":"Write","input":{"file_path":"/work/a"}}]}}"#,
            r#"{"type":"system","subtype":"permission_denied","tool_name":"Write","tool_use_id":"t1","message":"denied","uuid":"u","session_id":"s"}"#,
            r#"{"type":"user","parent_tool_use_id":null,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":"denied"}]}}"#,
        ]);
        assert!(events.contains(&AgentEvent::ToolCompleted {
            tool_call_id: "t1".into(),
            ok: false,
            summary: Some("Denied by the permission mode".into())
        }));
        assert!(
            !events
                .iter()
                .any(|e| matches!(e, AgentEvent::FileChanged { .. }))
        );
    }

    #[test]
    fn successful_edits_report_file_changes() {
        let events = run(&[
            r#"{"type":"assistant","parent_tool_use_id":null,"message":{"id":"m","content":[{"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"/work/a.rs","old_string":"a","new_string":"b"}}]}}"#,
            r#"{"type":"user","parent_tool_use_id":null,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}"#,
        ]);
        assert!(events.contains(&status(
            ThreadStatus::Editing,
            Some("Edit /work/a.rs".into())
        )));
        assert!(events.contains(&AgentEvent::FileChanged {
            path: "/work/a.rs".into(),
            change: FileChange::Modified
        }));
    }

    #[test]
    fn subagent_traffic_is_not_surfaced() {
        let events = run(&[
            r#"{"type":"assistant","parent_tool_use_id":"toolu_parent","message":{"id":"m2","content":[{"type":"text","text":"sub"}]}}"#,
            r#"{"type":"stream_event","parent_tool_use_id":"toolu_parent","event":{"type":"message_start","message":{"id":"m2"}}}"#,
        ]);
        assert!(events.is_empty());
    }

    #[test]
    fn parse_errors_are_reported_then_throttled() {
        let garbage = vec!["garbage"; 12];
        let events = run(&garbage);
        assert_eq!(events.len(), MAX_REPORTED_PARSE_ERRORS as usize);
        assert!(events.iter().all(|e| matches!(e, AgentEvent::Error { code, recoverable: true, .. } if code == "protocol_error")));
    }

    #[test]
    fn error_results_complete_the_turn_as_failed() {
        let events = run(&[
            r#"{"type":"result","subtype":"error_max_turns","is_error":true,"session_id":"s","usage":{"input_tokens":5,"output_tokens":7},"total_cost_usd":0.0123,"permission_denials":[]}"#,
        ]);
        assert_eq!(
            events,
            [
                AgentEvent::Usage {
                    usage: Usage {
                        input_tokens: Some(5),
                        output_tokens: Some(7),
                        cost_usd_micros: Some(12_300)
                    }
                },
                AgentEvent::Error {
                    code: "turn_error_max_turns".into(),
                    message: "The turn stopped at its turn limit.".into(),
                    recoverable: true
                },
                AgentEvent::TurnCompleted { ok: false },
                status(ThreadStatus::Idle, None),
            ]
        );
    }

    #[test]
    fn a_success_subtype_with_an_error_result_is_not_a_turn_success_code() {
        let events = run(&[
            r#"{"type":"result","subtype":"success","is_error":true,"session_id":"s","usage":{"input_tokens":1,"output_tokens":0},"total_cost_usd":0.0,"permission_denials":[]}"#,
        ]);
        assert!(events.contains(&AgentEvent::Error {
            code: "turn_error_result".into(),
            message: "Claude Code reported an error for this turn.".into(),
            recoverable: true
        }));
        assert!(events.contains(&AgentEvent::TurnCompleted { ok: false }));
        assert!(!events.iter().any(
            |event| matches!(event, AgentEvent::Error { code, .. } if code == "turn_success")
        ));
    }

    #[test]
    fn hostile_error_codes_are_sanitized() {
        let events = run(&[
            r#"{"type":"assistant","parent_tool_use_id":null,"error":"<script>alert(1)</script>","message":{"id":"m","content":[]}}"#,
        ]);
        let AgentEvent::Error { code, message, .. } = &events[0] else {
            panic!("expected error");
        };
        assert!(
            code.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'),
            "{code}"
        );
        assert_eq!(message, "Claude reported an error.");
    }
}
