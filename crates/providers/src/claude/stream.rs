//! Parser for Claude Code's `--output-format stream-json` lines.
//!
//! Message shapes follow the Agent SDK reference (`SDKMessage` and friends,
//! https://code.claude.com/docs/en/agent-sdk/typescript#message-types) and the headless guide
//! (https://code.claude.com/docs/en/headless). These types are private to the adapter; the rest of
//! KalCode only sees normalized `AgentEvent`s.
//!
//! The parser is deliberately lenient about *additions* (unknown fields are ignored, unknown
//! message types become [`ClaudeLine::Unknown`]) and strict about *shape* (a known type with a
//! missing required field is a typed [`ParseError`]). It never panics.

use serde_json::{Map, Value};

/// One content block of an assistant message.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Block {
    Text(String),
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    /// Thinking and any block type KalCode doesn't render.
    Other,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct TokenUsage {
    pub input: Option<u64>,
    pub output: Option<u64>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ToolResult {
    pub tool_use_id: String,
    pub is_error: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum StreamEvent {
    MessageStart { message_id: String },
    TextDelta { text: String },
    Other,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum ClaudeLine {
    /// `system/init`: first message of a session.
    Init {
        session_id: String,
        model: Option<String>,
        permission_mode: Option<String>,
        capabilities: Vec<String>,
    },
    /// `system/api_retry`.
    ApiRetry {
        attempt: u64,
        max_retries: Option<u64>,
        error: String,
    },
    /// `system/permission_denied`.
    PermissionDenied {
        tool_name: String,
        tool_use_id: String,
    },
    /// Any other `system` subtype (compact boundary, hooks, informational, ...).
    System { subtype: String },
    Assistant {
        message_id: String,
        /// `Some` for subagent messages.
        parent_tool_use_id: Option<String>,
        blocks: Vec<Block>,
        /// `SDKAssistantMessageError` when the API call failed.
        error: Option<String>,
    },
    /// A `user` message. KalCode only cares about its `tool_result` blocks.
    User {
        parent_tool_use_id: Option<String>,
        tool_results: Vec<ToolResult>,
    },
    Stream {
        parent_tool_use_id: Option<String>,
        event: StreamEvent,
    },
    Result {
        subtype: String,
        is_error: bool,
        session_id: Option<String>,
        usage: TokenUsage,
        total_cost_usd: Option<f64>,
        permission_denials: usize,
    },
    /// Reply to a control request KalCode sent (e.g. interrupt).
    ControlResponse {
        request_id: Option<String>,
        ok: bool,
    },
    /// A request from Claude Code to the host (e.g. a permission prompt).
    ControlRequest {
        request_id: Option<String>,
        subtype: Option<String>,
    },
    /// A message type this adapter doesn't know. Ignored, never fatal.
    Unknown { type_name: String },
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub(crate) enum ParseError {
    #[error("line is not valid JSON")]
    InvalidJson,
    #[error("line is not a JSON object")]
    NotAnObject,
    #[error("message has no type")]
    MissingType,
    #[error("{message_type} message is missing `{field}`")]
    MissingField {
        message_type: &'static str,
        field: &'static str,
    },
}

fn str_field(obj: &Map<String, Value>, key: &str) -> Option<String> {
    obj.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn required(
    obj: &Map<String, Value>,
    key: &'static str,
    message_type: &'static str,
) -> Result<String, ParseError> {
    str_field(obj, key).ok_or(ParseError::MissingField {
        message_type,
        field: key,
    })
}

fn usage(value: Option<&Value>) -> TokenUsage {
    let Some(obj) = value.and_then(Value::as_object) else {
        return TokenUsage::default();
    };
    TokenUsage {
        input: obj.get("input_tokens").and_then(Value::as_u64),
        output: obj.get("output_tokens").and_then(Value::as_u64),
    }
}

/// Parses one stdout line. Blank lines are the caller's concern.
pub(crate) fn parse_line(line: &str) -> Result<ClaudeLine, ParseError> {
    let value: Value = serde_json::from_str(line).map_err(|_| ParseError::InvalidJson)?;
    let obj = value.as_object().ok_or(ParseError::NotAnObject)?;
    let kind = obj
        .get("type")
        .and_then(Value::as_str)
        .ok_or(ParseError::MissingType)?;
    let parent = || str_field(obj, "parent_tool_use_id");
    Ok(match kind {
        "system" => parse_system(obj)?,
        "assistant" => {
            let message =
                obj.get("message")
                    .and_then(Value::as_object)
                    .ok_or(ParseError::MissingField {
                        message_type: "assistant",
                        field: "message",
                    })?;
            let message_id = required(message, "id", "assistant")?;
            let blocks = message
                .get("content")
                .and_then(Value::as_array)
                .map(|blocks| blocks.iter().map(parse_block).collect())
                .unwrap_or_default();
            ClaudeLine::Assistant {
                message_id,
                parent_tool_use_id: parent(),
                blocks,
                error: str_field(obj, "error"),
            }
        }
        "user" => {
            let content = obj
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(Value::as_array);
            let tool_results = content
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter_map(Value::as_object)
                        .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))
                        .filter_map(|b| {
                            Some(ToolResult {
                                tool_use_id: str_field(b, "tool_use_id")?,
                                is_error: b
                                    .get("is_error")
                                    .and_then(Value::as_bool)
                                    .unwrap_or(false),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            ClaudeLine::User {
                parent_tool_use_id: parent(),
                tool_results,
            }
        }
        "stream_event" => {
            let event =
                obj.get("event")
                    .and_then(Value::as_object)
                    .ok_or(ParseError::MissingField {
                        message_type: "stream_event",
                        field: "event",
                    })?;
            ClaudeLine::Stream {
                parent_tool_use_id: parent(),
                event: parse_stream_event(event),
            }
        }
        "result" => ClaudeLine::Result {
            subtype: required(obj, "subtype", "result")?,
            is_error: obj.get("is_error").and_then(Value::as_bool).unwrap_or(true),
            session_id: str_field(obj, "session_id"),
            usage: usage(obj.get("usage")),
            total_cost_usd: obj.get("total_cost_usd").and_then(Value::as_f64),
            permission_denials: obj
                .get("permission_denials")
                .and_then(Value::as_array)
                .map_or(0, Vec::len),
        },
        "control_response" => {
            // Envelope per the SDK reference; the reply payload sits under `response`.
            let response = obj.get("response").and_then(Value::as_object);
            let request_id = response
                .and_then(|r| str_field(r, "request_id"))
                .or_else(|| str_field(obj, "request_id"));
            let ok = response
                .and_then(|r| r.get("subtype"))
                .and_then(Value::as_str)
                .is_none_or(|s| s != "error");
            ClaudeLine::ControlResponse { request_id, ok }
        }
        "control_request" => ClaudeLine::ControlRequest {
            request_id: str_field(obj, "request_id"),
            subtype: obj
                .get("request")
                .and_then(|r| r.get("subtype"))
                .and_then(Value::as_str)
                .map(str::to_owned),
        },
        other => ClaudeLine::Unknown {
            type_name: other.chars().take(64).collect(),
        },
    })
}

fn parse_system(obj: &Map<String, Value>) -> Result<ClaudeLine, ParseError> {
    let subtype = obj.get("subtype").and_then(Value::as_str).unwrap_or("");
    Ok(match subtype {
        "init" => ClaudeLine::Init {
            session_id: required(obj, "session_id", "system/init")?,
            model: str_field(obj, "model"),
            permission_mode: str_field(obj, "permissionMode"),
            capabilities: obj
                .get("capabilities")
                .and_then(Value::as_array)
                .map(|caps| {
                    caps.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default(),
        },
        "api_retry" => ClaudeLine::ApiRetry {
            attempt: obj.get("attempt").and_then(Value::as_u64).unwrap_or(0),
            max_retries: obj.get("max_retries").and_then(Value::as_u64),
            error: str_field(obj, "error").unwrap_or_else(|| "unknown".into()),
        },
        "permission_denied" => ClaudeLine::PermissionDenied {
            tool_name: required(obj, "tool_name", "system/permission_denied")?,
            tool_use_id: required(obj, "tool_use_id", "system/permission_denied")?,
        },
        other => ClaudeLine::System {
            subtype: other.chars().take(64).collect(),
        },
    })
}

fn parse_block(block: &Value) -> Block {
    let Some(obj) = block.as_object() else {
        return Block::Other;
    };
    match obj.get("type").and_then(Value::as_str) {
        Some("text") => str_field(obj, "text").map_or(Block::Other, Block::Text),
        Some("tool_use") => match (str_field(obj, "id"), str_field(obj, "name")) {
            (Some(id), Some(name)) => Block::ToolUse {
                id,
                name,
                input: obj.get("input").cloned().unwrap_or(Value::Null),
            },
            _ => Block::Other,
        },
        _ => Block::Other,
    }
}

fn parse_stream_event(event: &Map<String, Value>) -> StreamEvent {
    match event.get("type").and_then(Value::as_str) {
        Some("message_start") => event
            .get("message")
            .and_then(|m| m.get("id"))
            .and_then(Value::as_str)
            .map_or(StreamEvent::Other, |id| StreamEvent::MessageStart {
                message_id: id.to_owned(),
            }),
        Some("content_block_delta") => {
            let delta = event.get("delta");
            match (
                delta.and_then(|d| d.get("type")).and_then(Value::as_str),
                delta.and_then(|d| d.get("text")).and_then(Value::as_str),
            ) {
                (Some("text_delta"), Some(text)) => StreamEvent::TextDelta {
                    text: text.to_owned(),
                },
                _ => StreamEvent::Other,
            }
        }
        _ => StreamEvent::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_init() {
        let line = r#"{"type":"system","subtype":"init","uuid":"u","session_id":"s-1","cwd":"/w","tools":["Read"],"mcp_servers":[],"model":"claude-sonnet-5","permissionMode":"default","slash_commands":[],"output_style":"default","skills":[],"plugins":[],"apiKeySource":"none","claude_code_version":"2.1.282","capabilities":["interrupt_receipt_v1"]}"#;
        assert_eq!(
            parse_line(line),
            Ok(ClaudeLine::Init {
                session_id: "s-1".into(),
                model: Some("claude-sonnet-5".into()),
                permission_mode: Some("default".into()),
                capabilities: vec!["interrupt_receipt_v1".into()],
            })
        );
    }

    #[test]
    fn malformed_lines_are_typed_errors() {
        assert_eq!(parse_line("not json"), Err(ParseError::InvalidJson));
        assert_eq!(parse_line("{\"type\":"), Err(ParseError::InvalidJson));
        assert_eq!(parse_line("[1,2]"), Err(ParseError::NotAnObject));
        assert_eq!(parse_line("42"), Err(ParseError::NotAnObject));
        assert_eq!(parse_line("{}"), Err(ParseError::MissingType));
        assert_eq!(parse_line(r#"{"type":7}"#), Err(ParseError::MissingType));
        assert_eq!(
            parse_line(r#"{"type":"system","subtype":"init"}"#),
            Err(ParseError::MissingField {
                message_type: "system/init",
                field: "session_id"
            })
        );
        assert_eq!(
            parse_line(r#"{"type":"assistant","message":{"content":[]}}"#),
            Err(ParseError::MissingField {
                message_type: "assistant",
                field: "id"
            })
        );
        assert_eq!(
            parse_line(r#"{"type":"result"}"#),
            Err(ParseError::MissingField {
                message_type: "result",
                field: "subtype"
            })
        );
    }

    #[test]
    fn unknown_types_and_fields_are_tolerated() {
        assert_eq!(
            parse_line(r#"{"type":"rate_limit_event","anything":{"deep":[1]}}"#),
            Ok(ClaudeLine::Unknown {
                type_name: "rate_limit_event".into()
            })
        );
        assert_eq!(
            parse_line(r#"{"type":"system","subtype":"compact_boundary","future_field":1}"#),
            Ok(ClaudeLine::System {
                subtype: "compact_boundary".into()
            })
        );
    }

    #[test]
    fn assistant_blocks_keep_text_and_tool_use() {
        let line = r#"{"type":"assistant","uuid":"u","session_id":"s","parent_tool_use_id":null,"message":{"id":"msg_1","content":[{"type":"thinking","thinking":"..."},{"type":"text","text":"Hi"},{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls"}},{"type":"tool_use","name":"broken"}]}}"#;
        let ClaudeLine::Assistant {
            message_id,
            parent_tool_use_id,
            blocks,
            error,
        } = parse_line(line).expect("parse")
        else {
            panic!("not assistant");
        };
        assert_eq!(message_id, "msg_1");
        assert_eq!(parent_tool_use_id, None);
        assert_eq!(error, None);
        assert_eq!(blocks.len(), 4);
        assert_eq!(blocks[0], Block::Other);
        assert_eq!(blocks[1], Block::Text("Hi".into()));
        assert!(matches!(&blocks[2], Block::ToolUse { name, .. } if name == "Bash"));
        assert_eq!(blocks[3], Block::Other);
    }

    #[test]
    fn deeply_nested_or_huge_input_does_not_panic() {
        let nested = format!("{}{}", "[".repeat(10_000), "]".repeat(10_000));
        assert!(parse_line(&nested).is_err());
        let long = format!(r#"{{"type":"x{}"}}"#, "y".repeat(10_000));
        assert!(
            matches!(parse_line(&long), Ok(ClaudeLine::Unknown { type_name }) if type_name.len() == 64)
        );
    }
}
