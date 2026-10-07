//! The bounded, filtered record the helper forwards for one hook call.
//!
//! Only the fields KalCode uses leave the helper. Tool output, transcripts, assistant messages
//! and everything else in the hook payload are dropped here, before anything is sent. Input
//! shapes follow the Claude Code hooks reference (https://code.claude.com/docs/en/hooks) and
//! Codex's `notify` payload (https://learn.chatgpt.com/docs/config-file/config-advanced).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

/// Largest hook payload the helper reads from stdin.
pub const MAX_STDIN_BYTES: usize = 1024 * 1024;
/// Largest tool input forwarded for classification (serialized). Larger inputs are dropped and
/// the call is classified as an opaque tool, which always asks.
pub const MAX_TOOL_INPUT_BYTES: usize = 64 * 1024;
/// Bounded prompt text for deterministic naming and task-specific local memory retrieval.
pub const MAX_PROMPT_CHARS: usize = 2048;
const MAX_ID_CHARS: usize = 128;
const MAX_WORD_CHARS: usize = 64;
const MAX_PATH_CHARS: usize = 4096;

/// Hook events KalCode configures. `CodexNotify` is Codex's `notify` program call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum HookEvent {
    SessionStart,
    UserPromptSubmit,
    PreToolUse,
    PermissionRequest,
    PostToolUse,
    PostToolUseFailure,
    Notification,
    Stop,
    StopFailure,
    SubagentStart,
    SubagentStop,
    SessionEnd,
    /// Codex: the person interrupted (or declined into) a turn. No Stop or `notify` follows.
    Interrupt,
    CodexNotify,
    Cursor,
}

impl HookEvent {
    /// The Claude Code events KalCode registers, in settings order.
    pub const CLAUDE: [HookEvent; 12] = [
        Self::SessionStart,
        Self::UserPromptSubmit,
        Self::PreToolUse,
        Self::PermissionRequest,
        Self::PostToolUse,
        Self::PostToolUseFailure,
        Self::Notification,
        Self::Stop,
        Self::StopFailure,
        Self::SubagentStart,
        Self::SubagentStop,
        Self::SessionEnd,
    ];

    /// The Codex hook events KalCode registers for a pane (observing only; verified against
    /// codex-cli 0.160.0). Codex's payloads are Claude-shaped; none of these can block or decide.
    pub const CODEX: [HookEvent; 7] = [
        Self::SessionStart,
        Self::UserPromptSubmit,
        Self::PreToolUse,
        Self::PermissionRequest,
        Self::PostToolUse,
        Self::Stop,
        Self::Interrupt,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::SessionStart => "SessionStart",
            Self::UserPromptSubmit => "UserPromptSubmit",
            Self::PreToolUse => "PreToolUse",
            Self::PermissionRequest => "PermissionRequest",
            Self::PostToolUse => "PostToolUse",
            Self::PostToolUseFailure => "PostToolUseFailure",
            Self::Notification => "Notification",
            Self::Stop => "Stop",
            Self::StopFailure => "StopFailure",
            Self::SubagentStart => "SubagentStart",
            Self::SubagentStop => "SubagentStop",
            Self::SessionEnd => "SessionEnd",
            Self::Interrupt => "Interrupt",
            Self::CodexNotify => "codex-notify",
            Self::Cursor => "cursor",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        Self::CLAUDE
            .into_iter()
            .chain([Self::Interrupt, Self::CodexNotify, Self::Cursor])
            .find(|e| e.as_str() == name)
    }

    /// Only `PreToolUse` carries a decision KalCode enforces; it fails closed. Every other
    /// event is a status signal and fails open.
    pub fn is_blocking(self) -> bool {
        matches!(self, Self::PreToolUse)
    }

    /// Events that may carry a Codex turn id: `notify`, and Codex's turn-scoped hooks.
    pub fn carries_codex_turn(self) -> bool {
        matches!(
            self,
            Self::CodexNotify
                | Self::UserPromptSubmit
                | Self::PreToolUse
                | Self::PermissionRequest
                | Self::PostToolUse
                | Self::Stop
                | Self::Interrupt
        )
    }

    /// Events whose matcher is the tool name (a `"*"` matcher registers them for every tool).
    pub fn has_tool_matcher(self) -> bool {
        matches!(
            self,
            Self::PreToolUse
                | Self::PermissionRequest
                | Self::PostToolUse
                | Self::PostToolUseFailure
        )
    }
}

/// What KalCode receives for one hook call. Every string is bounded and printable.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HookRecord {
    pub event: Option<HookEvent>,
    /// The provider's own session id (for resume).
    pub provider_session_id: Option<String>,
    /// Provider-confirmed model from a native root-session identity hook.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub tool_name: Option<String>,
    pub tool_use_id: Option<String>,
    /// Tool input for classification (PreToolUse, PermissionRequest), or only the path fields
    /// (PostToolUse*). `None` when it exceeded [`MAX_TOOL_INPUT_BYTES`].
    pub tool_input: Option<Value>,
    /// The tool input existed but was too large to forward.
    #[serde(default)]
    pub tool_input_dropped: bool,
    /// `true` when the hook fired inside a subagent.
    #[serde(default)]
    pub in_subagent: bool,
    pub notification_type: Option<String>,
    /// SessionStart `source` (startup, resume, clear, compact, fork).
    pub source: Option<String>,
    /// StopFailure `error_type`.
    pub error_type: Option<String>,
    /// SessionEnd `reason`.
    pub end_reason: Option<String>,
    /// Bounded UserPromptSubmit/beforeSubmitPrompt query for naming and local memory retrieval.
    /// Never stored or emitted as an agent event; capture uses filtered memory_candidate only.
    pub prompt: Option<String>,
    /// Codex notify `type` (e.g. `agent-turn-complete`).
    pub codex_type: Option<String>,
    /// Opaque Codex root-turn id used only to correlate and deduplicate completion status
    /// (`notify`, and Codex's own turn-scoped hooks).
    pub codex_turn_id: Option<String>,
    /// Only explicitly labelled durable facts, bounded; never a transcript or terminal stream.
    /// Native memory rejects secrets before persistence. This is not an activity event.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_candidate: Option<String>,
    /// Filtered Cursor lifecycle metadata; no transcripts, tool arguments, or credentials.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<CursorHook>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CursorHook {
    pub event: String,
    pub generation_id: Option<String>,
    pub model: Option<String>,
    pub status: Option<String>,
    /// Exact native prompt correlation, never persisted or emitted as an agent event.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_fingerprint: Option<String>,
}

/// Hash exact UTF-8 bytes without trimming or normalizing the provider's submitted prompt.
pub fn cursor_prompt_fingerprint(prompt: &str) -> String {
    hex::encode(Sha256::digest(prompt.as_bytes()))
}

pub const CURSOR_EVENTS: &[&str] = &[
    "sessionStart",
    "sessionEnd",
    "beforeSubmitPrompt",
    "afterAgentResponse",
    "postToolUse",
    "postToolUseFailure",
    "stop",
];

#[cfg(test)]
mod cursor_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cursor_records_filter_content_and_bind_event_session_and_generation() {
        let value = json!({
            "hook_event_name":"stop", "conversation_id":"session-1", "session_id":"session-1",
            "generation_id":"turn-1", "model":"future-v9-thinking", "status":"completed",
            "transcript_path":"private-path", "tool_input":{"secret":"never forwarded"},
            "user_email":"private@example.test", "text":"private response"
        });
        let record = from_cursor_stdin("stop", value.to_string().as_bytes()).unwrap();
        let wire = serde_json::to_string(&record).unwrap();
        assert!(!wire.contains("private"));
        assert!(!wire.contains("never forwarded"));
        assert_eq!(
            record.cursor.as_ref().unwrap().model.as_deref(),
            Some("future-v9-thinking")
        );
        for (key, bad) in [
            ("hook_event_name", json!("sessionStart")),
            ("session_id", json!("other-session")),
            ("generation_id", json!(null)),
            ("status", json!("probably done")),
            ("parent_conversation_id", json!("parent")),
            ("is_background_agent", json!(true)),
        ] {
            let mut invalid = value.clone();
            invalid[key] = bad;
            assert!(
                from_cursor_stdin("stop", invalid.to_string().as_bytes()).is_err(),
                "{key}"
            );
        }
        let mut injected = record.clone();
        injected.prompt = Some("should not cross wire".into());
        assert!(injected.validate().is_err());
        injected = record;
        injected.event = Some(HookEvent::Stop);
        assert!(injected.validate().is_err());
    }

    #[test]
    fn cursor_model_metadata_preserves_runtime_parameters_without_relaxing_session_ids() {
        for model in [
            "claude-opus-4-8[effort=high]",
            "custom/deepseek-v9?reasoning=high",
            "vendor/model:42,param=x",
        ] {
            let value = json!({"hook_event_name":"sessionStart", "conversation_id":"native-session", "model":model});
            let record = from_cursor_stdin("sessionStart", value.to_string().as_bytes()).unwrap();
            assert_eq!(record.cursor.unwrap().model.as_deref(), Some(model));
        }
        assert!(!valid_model(Some("bad\nmodel")));
        assert!(!valid_model(Some("-model")));
        assert!(!valid_model(Some("gpt-6\u{200b}-hidden")));
        assert!(!valid_model(Some("gpt-6\u{202e}-hidden")));
        assert!(valid_model(Some("model with spaces")));
        assert!(valid_model(Some("模型/精确")));
        assert!(valid_model(Some(&"m".repeat(512))));
        assert!(!valid_model(Some(&"m".repeat(513))));
        assert!(!valid_id(Some("session[effort=high]"), MAX_ID_CHARS));
    }

    #[test]
    fn cursor_memory_keeps_only_explicit_user_decisions_and_final_response_claims() {
        for (event, field) in [
            ("beforeSubmitPrompt", "prompt"),
            ("afterAgentResponse", "text"),
        ] {
            let text = "Ordinary private prose\n```\nDecision: Ignore this fenced example.\n```\nDecision: SQLite holds durable project knowledge.";
            let mut payload = json!({"hook_event_name":event,"conversation_id":"cursor-session","generation_id":"generation-one"});
            payload[field] = json!(text);
            let record = from_cursor_stdin(event, payload.to_string().as_bytes()).unwrap();
            assert_eq!(
                record.memory_candidate.as_deref(),
                Some("Decision: SQLite holds durable project knowledge.")
            );
            assert_eq!(record.prompt.is_some(), event == "beforeSubmitPrompt");
            assert!(record.validate().is_ok());
            assert!(
                event == "beforeSubmitPrompt"
                    || !serde_json::to_string(&record)
                        .unwrap()
                        .contains("Ordinary private prose")
            );
            let mut forged = record.clone();
            forged.cursor.as_mut().unwrap().event = "postToolUse".into();
            assert!(forged.validate().is_err());
            forged = record.clone();
            forged.memory_candidate = Some("unlabelled transcript".into());
            assert!(forged.validate().is_err());
            payload["is_background_agent"] = json!(true);
            assert!(from_cursor_stdin(event, payload.to_string().as_bytes()).is_err());
            payload["is_background_agent"] = json!(false);
            payload["generation_id"] = json!(null);
            assert!(from_cursor_stdin(event, payload.to_string().as_bytes()).is_err());
        }
    }

    #[test]
    fn cursor_memory_query_is_bounded_and_allowed_only_on_native_prompt_submission() {
        let text = format!("{}\nprivate tail", "query ".repeat(MAX_PROMPT_CHARS));
        let payload = json!({"hook_event_name":"beforeSubmitPrompt","conversation_id":"session","generation_id":"turn","prompt":text});
        let record =
            from_cursor_stdin("beforeSubmitPrompt", payload.to_string().as_bytes()).unwrap();
        assert_eq!(
            record.prompt.as_ref().unwrap().chars().count(),
            MAX_PROMPT_CHARS
        );
        assert!(
            !serde_json::to_string(&record)
                .unwrap()
                .contains("private tail")
        );
        assert_eq!(
            record.cursor.as_ref().unwrap().prompt_fingerprint,
            Some(cursor_prompt_fingerprint(&text))
        );
        let mut changed = payload.clone();
        changed["prompt"] = json!(format!("{text} changed beyond bounded query"));
        let changed =
            from_cursor_stdin("beforeSubmitPrompt", changed.to_string().as_bytes()).unwrap();
        assert_eq!(changed.prompt, record.prompt);
        assert_ne!(
            changed.cursor.unwrap().prompt_fingerprint,
            record.cursor.as_ref().unwrap().prompt_fingerprint
        );
        let mut invalid_hash = record.clone();
        invalid_hash.cursor.as_mut().unwrap().prompt_fingerprint = Some("untrusted hash".into());
        assert!(invalid_hash.validate().is_err());
        for query in [
            "x".repeat(MAX_PROMPT_CHARS + 1),
            "query\nwith controls".into(),
            " ".into(),
        ] {
            let mut forged = record.clone();
            forged.prompt = Some(query);
            assert!(forged.validate().is_err());
        }
        for event in ["sessionStart", "afterAgentResponse", "postToolUse"] {
            let mut forged = record.clone();
            forged.cursor.as_mut().unwrap().event = event.into();
            assert!(forged.validate().is_err());
        }
    }
}

impl HookRecord {
    pub fn event(&self) -> Option<HookEvent> {
        self.event
    }

    /// Validates the filtered wire contract at the server trust boundary.
    ///
    /// The helper normally constructs records through [`from_claude_stdin`] or
    /// [`from_codex_notify`], but a process inheriting the per-session key can speak the wire
    /// protocol directly. Such callers must not bypass the helper's field bounds or attach fields
    /// to an event that the helper would have discarded.
    pub fn validate(&self) -> Result<(), RecordError> {
        let Some(event) = self.event else {
            return Err(RecordError::Invalid);
        };
        if self.memory_candidate.as_ref().is_some_and(|text| {
            let memory_event = matches!(
                event,
                HookEvent::Stop | HookEvent::CodexNotify | HookEvent::UserPromptSubmit
            ) || (event == HookEvent::Cursor
                && self.cursor.as_ref().is_some_and(|cursor| {
                    matches!(
                        cursor.event.as_str(),
                        "beforeSubmitPrompt" | "afterAgentResponse"
                    )
                }));
            !memory_event || durable_lines(text).as_ref() != Some(text)
        }) {
            return Err(RecordError::Invalid);
        }
        if event == HookEvent::Cursor {
            let cursor = self.cursor.as_ref().ok_or(RecordError::Invalid)?;
            let valid = CURSOR_EVENTS.contains(&cursor.event.as_str())
                && self.provider_session_id.is_some()
                && valid_id(self.provider_session_id.as_deref(), MAX_ID_CHARS)
                && valid_id(cursor.generation_id.as_deref(), MAX_ID_CHARS)
                && valid_model(cursor.model.as_deref())
                && cursor
                    .prompt_fingerprint
                    .as_deref()
                    .is_none_or(|fingerprint| {
                        cursor.event == "beforeSubmitPrompt"
                            && crate::key::is_hex_of_len(fingerprint, 64)
                    })
                && self.prompt.as_deref().is_none_or(|prompt| {
                    cursor.event == "beforeSubmitPrompt"
                        && !prompt.trim().is_empty()
                        && clean_text(prompt, MAX_PROMPT_CHARS) == prompt
                })
                && matches!(
                    cursor.status.as_deref(),
                    None | Some("completed" | "aborted" | "error")
                )
                && (cursor.event == "stop" || cursor.status.is_none())
                && (cursor.event != "stop"
                    || (cursor.status.is_some() && cursor.generation_id.is_some()))
                && (!matches!(
                    cursor.event.as_str(),
                    "beforeSubmitPrompt" | "afterAgentResponse"
                ) || cursor.generation_id.is_some());
            let mut only_cursor = HookRecord {
                event: Some(HookEvent::Cursor),
                provider_session_id: self.provider_session_id.clone(),
                cursor: self.cursor.clone(),
                memory_candidate: self.memory_candidate.clone(),
                prompt: self.prompt.clone(),
                ..HookRecord::default()
            };
            // Cursor subagent records cannot affect the parent terminal lifecycle.
            only_cursor.in_subagent = false;
            return if valid && *self == only_cursor {
                Ok(())
            } else {
                Err(RecordError::Invalid)
            };
        }
        if self.cursor.is_some() {
            return Err(RecordError::Invalid);
        }
        if !valid_id(self.provider_session_id.as_deref(), MAX_ID_CHARS)
            || !valid_model(self.model.as_deref())
            || !valid_id(self.tool_name.as_deref(), MAX_ID_CHARS)
            || !valid_id(self.tool_use_id.as_deref(), MAX_ID_CHARS)
            || !valid_id(self.notification_type.as_deref(), MAX_WORD_CHARS)
            || !valid_id(self.source.as_deref(), MAX_WORD_CHARS)
            || !valid_id(self.error_type.as_deref(), MAX_WORD_CHARS)
            || !valid_id(self.end_reason.as_deref(), MAX_WORD_CHARS)
            || !valid_id(self.codex_type.as_deref(), MAX_WORD_CHARS)
            || !valid_id(self.codex_turn_id.as_deref(), MAX_ID_CHARS)
        {
            return Err(RecordError::Invalid);
        }
        if self.prompt.as_deref().is_some_and(|prompt| {
            prompt.trim().is_empty()
                || prompt.chars().count() > MAX_PROMPT_CHARS
                || clean_text(prompt, MAX_PROMPT_CHARS) != prompt
        }) {
            return Err(RecordError::Invalid);
        }
        if self.tool_input.as_ref().is_some_and(|input| {
            serde_json::to_vec(input)
                .map(|bytes| bytes.len() > MAX_TOOL_INPUT_BYTES)
                .unwrap_or(true)
        }) || (self.tool_input_dropped && self.tool_input.is_some())
        {
            return Err(RecordError::Invalid);
        }
        if event == HookEvent::CodexNotify
            && (!self
                .provider_session_id
                .as_deref()
                .is_some_and(valid_provider_id)
                || self.codex_type.as_deref() != Some("agent-turn-complete")
                || self.codex_turn_id.is_none())
        {
            return Err(RecordError::Invalid);
        }

        let tool_event = event.has_tool_matcher();
        if self.codex_turn_id.is_some() && !event.carries_codex_turn() {
            return Err(RecordError::Invalid);
        }
        if !tool_event
            && (self.tool_name.is_some()
                || self.tool_use_id.is_some()
                || self.tool_input.is_some()
                || self.tool_input_dropped)
        {
            return Err(RecordError::Invalid);
        }
        if self.tool_input_dropped
            && !matches!(event, HookEvent::PreToolUse | HookEvent::PermissionRequest)
        {
            return Err(RecordError::Invalid);
        }
        if matches!(
            event,
            HookEvent::PostToolUse | HookEvent::PostToolUseFailure
        ) && self
            .tool_input
            .as_ref()
            .is_some_and(|input| !valid_path_fields(input))
        {
            return Err(RecordError::Invalid);
        }

        // Codex includes its exact active model on every native hook. Outside SessionStart, the
        // bounded turn id is the shape marker that distinguishes those authenticated Codex hook
        // records from generic Claude records, whose other native events do not emit a model.
        let unexpected_model = self.model.is_some()
            && event != HookEvent::SessionStart
            && !(HookEvent::CODEX.contains(&event) && self.codex_turn_id.is_some());
        let unexpected = match event {
            HookEvent::SessionStart => {
                self.notification_type.is_some()
                    || self.error_type.is_some()
                    || self.end_reason.is_some()
                    || self.prompt.is_some()
                    || self.codex_type.is_some()
            }
            HookEvent::UserPromptSubmit => {
                unexpected_model
                    || self.notification_type.is_some()
                    || self.source.is_some()
                    || self.error_type.is_some()
                    || self.end_reason.is_some()
                    || self.codex_type.is_some()
            }
            HookEvent::Notification => {
                unexpected_model
                    || self.source.is_some()
                    || self.error_type.is_some()
                    || self.end_reason.is_some()
                    || self.prompt.is_some()
                    || self.codex_type.is_some()
            }
            HookEvent::StopFailure => {
                unexpected_model
                    || self.notification_type.is_some()
                    || self.source.is_some()
                    || self.end_reason.is_some()
                    || self.prompt.is_some()
                    || self.codex_type.is_some()
            }
            HookEvent::SessionEnd => {
                unexpected_model
                    || self.notification_type.is_some()
                    || self.source.is_some()
                    || self.error_type.is_some()
                    || self.prompt.is_some()
                    || self.codex_type.is_some()
            }
            HookEvent::CodexNotify => {
                unexpected_model
                    || self.in_subagent
                    || self.notification_type.is_some()
                    || self.source.is_some()
                    || self.error_type.is_some()
                    || self.end_reason.is_some()
                    || self.prompt.is_some()
            }
            HookEvent::Cursor => true,
            HookEvent::PreToolUse
            | HookEvent::PermissionRequest
            | HookEvent::PostToolUse
            | HookEvent::PostToolUseFailure => {
                unexpected_model
                    || self.notification_type.is_some()
                    || self.source.is_some()
                    || self.error_type.is_some()
                    || self.end_reason.is_some()
                    || self.prompt.is_some()
                    || self.codex_type.is_some()
            }
            HookEvent::Stop
            | HookEvent::SubagentStart
            | HookEvent::SubagentStop
            | HookEvent::Interrupt => {
                unexpected_model
                    || self.notification_type.is_some()
                    || self.source.is_some()
                    || self.error_type.is_some()
                    || self.end_reason.is_some()
                    || self.prompt.is_some()
                    || self.codex_type.is_some()
            }
        };
        if unexpected {
            Err(RecordError::Invalid)
        } else {
            Ok(())
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RecordError {
    #[error("the hook payload is too large")]
    TooLarge,
    #[error("the hook payload is not a JSON object")]
    NotAnObject,
    #[error("the filtered hook record is invalid")]
    Invalid,
}

/// Keeps printable characters, drops control and bidi/zero-width characters, and clips.
pub fn clean_text(text: &str, max_chars: usize) -> String {
    text.chars()
        .filter(|c| {
            !c.is_control()
                && !matches!(
                    *c,
                    '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}'
                )
        })
        .take(max_chars)
        .collect()
}

/// Identifiers (session ids, tool use ids, tool names, enum-like words) keep a conservative
/// character set; anything else makes the field absent rather than altered.
fn clean_id(value: Option<&Value>, max: usize) -> Option<String> {
    let text = value?.as_str()?;
    let ok = !text.is_empty()
        && text.chars().count() <= max
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-.:@/".contains(&b));
    ok.then(|| text.to_owned())
}

fn valid_id(value: Option<&str>, max: usize) -> bool {
    value.is_none_or(|text| {
        !text.is_empty()
            && text.chars().count() <= max
            && text
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-.:@/".contains(&b))
    })
}

fn valid_model(value: Option<&str>) -> bool {
    // Provider-owned exact model ids may contain parameters, spaces, or Unicode. They remain one
    // bounded metadata value and are never reparsed as a command or used as session identity.
    value.is_none_or(|model| {
        !model.is_empty()
            && model.len() <= 512
            && !model.starts_with('-')
            && clean_text(model, 512) == model
    })
}

fn valid_provider_id(id: &str) -> bool {
    if id.len() != 36 {
        return false;
    }
    id.bytes().enumerate().all(|(index, byte)| match index {
        8 | 13 | 18 | 23 => byte == b'-',
        _ => byte.is_ascii_hexdigit(),
    })
}

fn valid_path_fields(input: &Value) -> bool {
    let Some(object) = input.as_object() else {
        return false;
    };
    object.iter().all(|(key, value)| {
        matches!(key.as_str(), "file_path" | "notebook_path" | "path")
            && value.as_str().is_some_and(|path| {
                path.chars().count() <= MAX_PATH_CHARS && clean_text(path, MAX_PATH_CHARS) == path
            })
    })
}

fn path_fields_only(input: &Value) -> Option<Value> {
    let object = input.as_object()?;
    let mut kept = Map::new();
    for key in ["file_path", "notebook_path", "path"] {
        if let Some(Value::String(path)) = object.get(key) {
            kept.insert(
                key.to_owned(),
                Value::String(clean_text(path, MAX_PATH_CHARS)),
            );
        }
    }
    Some(Value::Object(kept))
}

/// Builds the record for a Claude Code hook from its stdin bytes.
pub fn from_cursor_stdin(event: &str, bytes: &[u8]) -> Result<HookRecord, RecordError> {
    if bytes.len() > MAX_STDIN_BYTES {
        return Err(RecordError::TooLarge);
    }
    let value: Value = serde_json::from_slice(bytes).map_err(|_| RecordError::NotAnObject)?;
    let object = value.as_object().ok_or(RecordError::NotAnObject)?;
    let field = |key: &str| object.get(key).and_then(Value::as_str).map(str::to_owned);
    if field("hook_event_name").as_deref() != Some(event)
        || object.get("is_background_agent") == Some(&Value::Bool(true))
        || object
            .get("parent_conversation_id")
            .is_some_and(|value| !value.is_null())
    {
        return Err(RecordError::Invalid);
    }
    let conversation = field("conversation_id").ok_or(RecordError::Invalid)?;
    if field("session_id").is_some_and(|id| id != conversation) {
        return Err(RecordError::Invalid);
    }
    let record = HookRecord {
        event: Some(HookEvent::Cursor),
        provider_session_id: Some(conversation),
        // Retrieval needs only a bounded query, never the complete prompt or transcript.
        prompt: (event == "beforeSubmitPrompt")
            .then(|| field("prompt"))
            .flatten()
            .map(|prompt| clean_text(&prompt, MAX_PROMPT_CHARS))
            .filter(|prompt| !prompt.trim().is_empty()),
        memory_candidate: match event {
            "beforeSubmitPrompt" => field("prompt").as_deref().and_then(durable_lines),
            "afterAgentResponse" => field("text").as_deref().and_then(durable_lines),
            _ => None,
        },
        cursor: Some(CursorHook {
            event: event.to_owned(),
            prompt_fingerprint: (event == "beforeSubmitPrompt")
                .then(|| field("prompt"))
                .flatten()
                .map(|prompt| cursor_prompt_fingerprint(&prompt)),
            generation_id: field("generation_id").filter(|value| !value.is_empty()),
            model: field("model")
                .filter(|value| !value.is_empty())
                .or_else(|| field("model_id").filter(|value| !value.is_empty())),
            status: if event == "stop" {
                field("status")
            } else {
                None
            },
        }),
        ..HookRecord::default()
    };
    record.validate()?;
    Ok(record)
}

/// Builds the record for a Claude Code hook from its stdin bytes.
pub fn from_claude_stdin(event: HookEvent, bytes: &[u8]) -> Result<HookRecord, RecordError> {
    if bytes.len() > MAX_STDIN_BYTES {
        return Err(RecordError::TooLarge);
    }
    let value: Value = serde_json::from_slice(bytes).map_err(|_| RecordError::NotAnObject)?;
    let object = value.as_object().ok_or(RecordError::NotAnObject)?;
    let get = |key: &str| object.get(key);
    let mut record = HookRecord {
        event: Some(event),
        provider_session_id: clean_id(get("session_id"), MAX_ID_CHARS),
        in_subagent: get("agent_id").is_some_and(|v| !v.is_null()),
        ..HookRecord::default()
    };
    if event.has_tool_matcher() {
        record.tool_name = clean_id(get("tool_name"), MAX_ID_CHARS);
        record.tool_use_id = clean_id(get("tool_use_id"), MAX_ID_CHARS);
        if let Some(input) = get("tool_input") {
            match event {
                HookEvent::PreToolUse | HookEvent::PermissionRequest => {
                    let size = serde_json::to_vec(input)
                        .map(|v| v.len())
                        .unwrap_or(usize::MAX);
                    if size <= MAX_TOOL_INPUT_BYTES {
                        record.tool_input = Some(input.clone());
                    } else {
                        record.tool_input_dropped = true;
                    }
                }
                _ => record.tool_input = path_fields_only(input),
            }
        }
    }
    match event {
        HookEvent::SessionStart => {
            record.source = clean_id(get("source"), MAX_WORD_CHARS);
            record.model = get("model")
                .and_then(Value::as_str)
                .filter(|model| valid_model(Some(model)))
                .map(str::to_owned);
        }
        HookEvent::Notification => {
            record.notification_type = clean_id(get("notification_type"), MAX_WORD_CHARS);
        }
        HookEvent::StopFailure => {
            // Claude Code's documented StopFailure field is `error`. Keep the older
            // `error_type` spelling as a compatibility fallback for already-running supported
            // clients, but never let it override the canonical field.
            record.error_type =
                clean_id(get("error").or_else(|| get("error_type")), MAX_WORD_CHARS);
        }
        HookEvent::SessionEnd => record.end_reason = clean_id(get("reason"), MAX_WORD_CHARS),
        HookEvent::UserPromptSubmit => {
            // The current reference names the field `user_prompt`; earlier versions `prompt`.
            record.prompt = get("prompt")
                .or_else(|| get("user_prompt"))
                .and_then(Value::as_str)
                .map(|p| clean_text(p, MAX_PROMPT_CHARS))
                .filter(|p| !p.trim().is_empty());
            record.memory_candidate = get("prompt")
                .or_else(|| get("user_prompt"))
                .and_then(Value::as_str)
                .and_then(durable_lines);
        }
        HookEvent::Stop => {
            record.memory_candidate = get("last_assistant_message")
                .and_then(Value::as_str)
                .and_then(durable_lines);
        }
        _ => {}
    }
    Ok(record)
}

/// Builds the record for a Codex `notify` call. Codex passes the JSON payload as the program's
/// last argument. Only its type and opaque session/turn correlation ids are forwarded; message
/// text is dropped.
pub fn from_codex_notify(json_arg: &str) -> Result<HookRecord, RecordError> {
    if json_arg.len() > MAX_STDIN_BYTES {
        return Err(RecordError::TooLarge);
    }
    let value: Value = serde_json::from_str(json_arg).map_err(|_| RecordError::NotAnObject)?;
    let object = value.as_object().ok_or(RecordError::NotAnObject)?;
    Ok(HookRecord {
        event: Some(HookEvent::CodexNotify),
        memory_candidate: object
            .get("last-assistant-message")
            .and_then(Value::as_str)
            .and_then(durable_lines),
        provider_session_id: clean_id(
            object.get("thread-id").or_else(|| object.get("thread_id")),
            MAX_ID_CHARS,
        ),
        codex_type: clean_id(object.get("type"), MAX_WORD_CHARS),
        codex_turn_id: clean_id(
            object.get("turn-id").or_else(|| object.get("turn_id")),
            MAX_ID_CHARS,
        ),
        ..HookRecord::default()
    })
}

/// Builds the record for one of Codex's own hooks ([`HookEvent::CODEX`]) from its stdin bytes.
///
/// Codex 0.160 sends Claude-shaped JSON (`session_id`, `turn_id`, `tool_name`, `tool_use_id`,
/// `tool_input`, `source`, `model`), so the Claude filter applies, plus the exact active model and
/// turn id that correlate a Stop with the `notify` completion of the same turn. Prompt text and
/// assistant messages are dropped: Codex's `notify` already carries the turn's durable memory,
/// and these records exist for status and provider-reported runtime identity only.
pub fn from_codex_hook_stdin(event: HookEvent, bytes: &[u8]) -> Result<HookRecord, RecordError> {
    if !HookEvent::CODEX.contains(&event) {
        return Err(RecordError::Invalid);
    }
    let mut record = from_claude_stdin(event, bytes)?;
    record.prompt = None;
    record.memory_candidate = None;
    let value: Value = serde_json::from_slice(bytes).map_err(|_| RecordError::NotAnObject)?;
    record.model = value
        .get("model")
        .and_then(Value::as_str)
        .filter(|model| valid_model(Some(model)))
        .map(str::to_owned);
    if event.carries_codex_turn() {
        record.codex_turn_id = clean_id(value.get("turn_id"), MAX_ID_CHARS);
    }
    record.validate()?;
    Ok(record)
}

/// Deliberately conservative: ordinary prose, logs and unlabeled conclusions never leave the
/// helper. Do not clip a claim into a different meaning or retain a partial oversized line.
fn durable_lines(text: &str) -> Option<String> {
    let mut selected = Vec::new();
    let mut bytes = 0;
    let mut fenced = false;
    for line in text.lines().take(256) {
        let line = line.trim().trim_start_matches("- ");
        if line.starts_with("```") || line.starts_with("~~~") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            continue;
        }
        let lower = line.to_ascii_lowercase();
        if line.len() > 1024
            || line.chars().any(char::is_control)
            || ![
                "decision:",
                "technical decision:",
                "architecture:",
                "convention:",
                "release rule:",
                "known issue:",
                "constraint:",
                "project:",
                "product:",
                "product decision:",
                "implementation decision:",
                "handoff context:",
                "remember:",
            ]
            .iter()
            .any(|label| lower.starts_with(label))
        {
            continue;
        }
        if selected.len() == 8 || bytes + line.len() + 1 > 4096 {
            break;
        }
        bytes += line.len() + 1;
        selected.push(line);
    }
    (!selected.is_empty()).then(|| selected.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn record(event: HookEvent, value: Value) -> HookRecord {
        from_claude_stdin(event, value.to_string().as_bytes()).expect("record")
    }

    #[test]
    fn events_round_trip_by_name_and_only_pre_tool_use_blocks() {
        for event in HookEvent::CLAUDE {
            assert_eq!(HookEvent::parse(event.as_str()), Some(event));
            assert_eq!(event.is_blocking(), event == HookEvent::PreToolUse);
        }
        assert_eq!(
            HookEvent::parse("codex-notify"),
            Some(HookEvent::CodexNotify)
        );
        assert_eq!(HookEvent::parse("pretooluse"), None);
    }

    #[test]
    fn drops_fields_kalcode_does_not_need() {
        let r = record(
            HookEvent::PostToolUse,
            json!({
                "session_id": "abc-123",
                "transcript_path": "/home/u/.claude/t.jsonl",
                "cwd": "/w",
                "hook_event_name": "PostToolUse",
                "tool_name": "Write",
                "tool_use_id": "toolu_01",
                "tool_input": {"file_path": "/w/a.rs", "content": "SECRET=1"},
                "tool_output": {"success": true, "stdout": "token=abc"},
                "tool_response": {"filePath": "/w/a.rs"}
            }),
        );
        let text = serde_json::to_string(&r).expect("json");
        for leaked in [
            "transcript",
            "SECRET",
            "token=abc",
            "tool_output",
            "content",
        ] {
            assert!(!text.contains(leaked), "{leaked} in {text}");
        }
        assert_eq!(r.tool_input, Some(json!({"file_path": "/w/a.rs"})));
        assert_eq!(r.tool_use_id.as_deref(), Some("toolu_01"));
    }

    #[test]
    fn pre_tool_use_keeps_bounded_tool_input_for_classification() {
        let r = record(
            HookEvent::PreToolUse,
            json!({"session_id": "s", "tool_name": "Bash", "tool_use_id": "t1",
                   "tool_input": {"command": "npm test", "description": "Run tests"}}),
        );
        assert_eq!(
            r.tool_input.as_ref().and_then(|i| i["command"].as_str()),
            Some("npm test")
        );
        assert!(!r.tool_input_dropped);

        let big = "x".repeat(MAX_TOOL_INPUT_BYTES + 1);
        let r = record(
            HookEvent::PreToolUse,
            json!({"session_id": "s", "tool_name": "Bash", "tool_input": {"command": big}}),
        );
        assert_eq!(r.tool_input, None);
        assert!(
            r.tool_input_dropped,
            "oversized input is flagged, so it is treated as opaque"
        );
    }

    #[test]
    fn odd_identifiers_are_dropped_not_altered() {
        let r = record(
            HookEvent::PreToolUse,
            json!({"session_id": "a b\u{202e}", "tool_name": "Bash\n", "tool_use_id": 5}),
        );
        assert_eq!(r.provider_session_id, None);
        assert_eq!(r.tool_name, None);
        assert_eq!(r.tool_use_id, None);
    }

    #[test]
    fn prompt_is_clipped_cleaned_and_accepted_under_either_name() {
        let long = format!("Fix the build\u{0007}{}", "y".repeat(5000));
        let r = record(HookEvent::UserPromptSubmit, json!({"prompt": long}));
        let prompt = r.prompt.expect("prompt");
        assert!(prompt.starts_with("Fix the build"));
        assert!(!prompt.contains('\u{0007}'));
        assert_eq!(prompt.chars().count(), MAX_PROMPT_CHARS);
        let r = record(
            HookEvent::UserPromptSubmit,
            json!({"user_prompt": "Add tests"}),
        );
        assert_eq!(r.prompt.as_deref(), Some("Add tests"));
        // Prompts only travel with UserPromptSubmit.
        let r = record(
            HookEvent::Stop,
            json!({"prompt": "x", "last_assistant_message": "y"}),
        );
        assert_eq!(r.prompt, None);
    }

    #[test]
    fn oversized_or_invalid_stdin_is_refused() {
        let big = vec![b' '; MAX_STDIN_BYTES + 1];
        assert_eq!(
            from_claude_stdin(HookEvent::PreToolUse, &big),
            Err(RecordError::TooLarge)
        );
        assert_eq!(
            from_claude_stdin(HookEvent::PreToolUse, b"[1,2]"),
            Err(RecordError::NotAnObject)
        );
        assert_eq!(
            from_claude_stdin(HookEvent::PreToolUse, b"not json"),
            Err(RecordError::NotAnObject)
        );
    }

    #[test]
    fn event_specific_words_are_kept() {
        assert_eq!(
            record(
                HookEvent::Notification,
                json!({"notification_type": "permission_prompt"})
            )
            .notification_type
            .as_deref(),
            Some("permission_prompt")
        );
        assert_eq!(
            record(HookEvent::SessionStart, json!({"source": "resume"}))
                .source
                .as_deref(),
            Some("resume")
        );
        assert_eq!(
            record(
                HookEvent::StopFailure,
                json!({"error": "rate_limit", "error_details": "m"})
            )
            .error_type
            .as_deref(),
            Some("rate_limit")
        );
        assert_eq!(
            record(
                HookEvent::StopFailure,
                json!({"error": "authentication_failed", "error_type": "rate_limit"})
            )
            .error_type
            .as_deref(),
            Some("authentication_failed"),
            "the documented field must win over the legacy fallback"
        );
        assert_eq!(
            record(HookEvent::StopFailure, json!({"error_type": "overloaded"}))
                .error_type
                .as_deref(),
            Some("overloaded")
        );
        assert!(record(HookEvent::PreToolUse, json!({"agent_id": "a1"})).in_subagent);
    }

    #[test]
    fn codex_notify_keeps_only_correlation_fields() {
        let r = from_codex_notify(
            r#"{"type":"agent-turn-complete","thread-id":"t-1","turn-id":"turn-1","last-assistant-message":"secret prose","input-messages":["x"]}"#,
        )
        .expect("record");
        assert_eq!(r.codex_type.as_deref(), Some("agent-turn-complete"));
        assert_eq!(r.provider_session_id.as_deref(), Some("t-1"));
        assert_eq!(r.codex_turn_id.as_deref(), Some("turn-1"));
        assert!(
            !serde_json::to_string(&r)
                .expect("json")
                .contains("secret prose")
        );
    }

    /// Payload shapes captured from codex-cli 0.160.0 (`codex exec` with session-flag hooks).
    #[test]
    fn codex_hooks_keep_status_fields_and_the_turn_id_only() {
        let base = json!({
            "session_id": "01a1090f-fb6f-77b2-a41e-3b36de532425",
            "turn_id": "01a1090f-fdb6-7821-9002-291ccb0685b9",
            "transcript_path": "C:\\Users\\u\\.codex\\sessions\\rollout.jsonl",
            "cwd": "C:\\work",
            "model": "gpt-6-astra",
            "permission_mode": "bypassPermissions"
        });
        let with = |event: &str, extra: Value| {
            let mut value = base.clone();
            value["hook_event_name"] = json!(event);
            for (key, field) in extra.as_object().unwrap() {
                value[key] = field.clone();
            }
            value.to_string()
        };

        let pre = from_codex_hook_stdin(
            HookEvent::PreToolUse,
            with(
                "PreToolUse",
                json!({"tool_name":"Bash","tool_input":{"command":"cargo test"},"tool_use_id":"exec-ac67"}),
            )
            .as_bytes(),
        )
        .unwrap();
        assert_eq!(pre.tool_name.as_deref(), Some("Bash"));
        assert_eq!(pre.tool_use_id.as_deref(), Some("exec-ac67"));
        assert_eq!(pre.tool_input, Some(json!({"command":"cargo test"})));
        assert_eq!(
            pre.codex_turn_id.as_deref(),
            Some("01a1090f-fdb6-7821-9002-291ccb0685b9")
        );
        assert_eq!(
            pre.provider_session_id.as_deref(),
            Some("01a1090f-fb6f-77b2-a41e-3b36de532425")
        );
        assert_eq!(
            pre.model.as_deref(),
            Some("gpt-6-astra"),
            "Codex repeats its exact active model on every native hook"
        );

        let post = from_codex_hook_stdin(
            HookEvent::PostToolUse,
            with(
                "PostToolUse",
                json!({"tool_name":"Bash","tool_input":{"command":"echo secret"},"tool_response":"secret output","tool_use_id":"exec-ac67"}),
            )
            .as_bytes(),
        )
        .unwrap();
        let wire = serde_json::to_string(&post).unwrap();
        assert!(!wire.contains("secret"), "{wire}");
        assert!(!wire.contains("transcript"), "{wire}");

        let stop = from_codex_hook_stdin(
            HookEvent::Stop,
            with(
                "Stop",
                json!({"stop_hook_active":false,"last_assistant_message":"Decision: keep it."}),
            )
            .as_bytes(),
        )
        .unwrap();
        assert_eq!(
            stop.memory_candidate, None,
            "notify carries the turn's memory"
        );
        assert!(stop.codex_turn_id.is_some());

        let prompt = from_codex_hook_stdin(
            HookEvent::UserPromptSubmit,
            with("UserPromptSubmit", json!({"prompt":"private prompt"})).as_bytes(),
        )
        .unwrap();
        assert_eq!(prompt.prompt, None);
        assert_eq!(prompt.model.as_deref(), Some("gpt-6-astra"));
        assert!(!serde_json::to_string(&prompt).unwrap().contains("private"));

        let hidden_model = from_codex_hook_stdin(
            HookEvent::UserPromptSubmit,
            with(
                "UserPromptSubmit",
                json!({"prompt":"private prompt", "model":"gpt-6\u{200b}-hidden"}),
            )
            .as_bytes(),
        )
        .unwrap();
        assert_eq!(
            hidden_model.model, None,
            "an invisible model identifier is rejected instead of being altered"
        );

        let claude_prompt = from_claude_stdin(
            HookEvent::UserPromptSubmit,
            with("UserPromptSubmit", json!({"prompt":"private prompt"})).as_bytes(),
        )
        .unwrap();
        assert_eq!(
            claude_prompt.model, None,
            "the generic Claude boundary keeps only fields emitted for that native event"
        );

        let start = from_codex_hook_stdin(
            HookEvent::SessionStart,
            with("SessionStart", json!({"source":"startup"})).as_bytes(),
        )
        .unwrap();
        assert_eq!(start.source.as_deref(), Some("startup"));
        assert_eq!(start.codex_turn_id, None);
        assert_eq!(
            serde_json::to_value(&start).unwrap()["model"],
            "gpt-6-astra",
            "the provider-confirmed SessionStart model crosses the filtered hook boundary"
        );

        let interrupt = from_codex_hook_stdin(
            HookEvent::Interrupt,
            with("Interrupt", json!({})).as_bytes(),
        )
        .unwrap();
        assert_eq!(
            interrupt.codex_turn_id.as_deref(),
            Some("01a1090f-fdb6-7821-9002-291ccb0685b9")
        );

        for event in [
            HookEvent::Notification,
            HookEvent::SessionEnd,
            HookEvent::CodexNotify,
        ] {
            assert_eq!(
                from_codex_hook_stdin(event, base.to_string().as_bytes()),
                Err(RecordError::Invalid)
            );
        }
        let mut forged = start;
        forged.codex_turn_id = Some("turn".into());
        assert_eq!(forged.validate(), Err(RecordError::Invalid));

        let mut forged = prompt;
        forged.codex_turn_id = None;
        assert_eq!(
            forged.validate(),
            Err(RecordError::Invalid),
            "a non-SessionStart model needs Codex's native turn-scoped hook shape"
        );
    }

    #[test]
    fn memory_candidate_keeps_only_complete_labelled_unfenced_claims() {
        let text = format!(
            "Compiled successfully\n```rust\nDecision: An example must not be captured.\n```\n~~~\nArchitecture: Another fenced example.\n~~~\nDecision: {}\n- Decision: SQLite holds project knowledge.\nKnown issue: Retry fails after a network timeout.\n",
            "x".repeat(1024)
        );
        let r = record(HookEvent::Stop, json!({"last_assistant_message": text}));
        assert_eq!(
            r.memory_candidate.as_deref(),
            Some(
                "Decision: SQLite holds project knowledge.\nKnown issue: Retry fails after a network timeout."
            )
        );
        assert!(r.validate().is_ok());
        let many = (0..20)
            .map(|index| format!("Decision: Preserve durable project claim {index}.\n"))
            .collect::<String>();
        let selected = durable_lines(&many).unwrap();
        assert_eq!(selected.lines().count(), 8);
        assert!(selected.len() <= 4096);
    }

    #[test]
    fn memory_candidate_rejects_wrong_event_unlabelled_or_oversized_wire_values() {
        let text = "Decision: SQLite holds project knowledge.";
        for event in [
            HookEvent::PostToolUse,
            HookEvent::PreToolUse,
            HookEvent::SessionStart,
            HookEvent::StopFailure,
        ] {
            let r = record(event, json!({"last_assistant_message": text}));
            assert_eq!(r.memory_candidate, None);
            let mut forged = r;
            forged.memory_candidate = Some(text.into());
            assert_eq!(forged.validate(), Err(RecordError::Invalid));
        }
        for candidate in [
            "unlabelled noise".to_owned(),
            format!("Decision: {}", "x".repeat(1025)),
            "Decision: text\u{0007}".to_owned(),
            "```\nDecision: fenced example\n```".to_owned(),
        ] {
            let mut forged = record(HookEvent::Stop, json!({}));
            forged.memory_candidate = Some(candidate);
            assert_eq!(forged.validate(), Err(RecordError::Invalid));
        }
        let r = record(HookEvent::UserPromptSubmit, json!({"prompt": text}));
        assert_eq!(r.memory_candidate.as_deref(), Some(text));
        let codex = from_codex_notify(
            &json!({"type":"agent-turn-complete", "thread-id":"12345678-1234-1234-1234-123456789abc", "turn-id":"turn-one", "last-assistant-message":text}).to_string(),
        )
        .unwrap();
        assert_eq!(codex.memory_candidate.as_deref(), Some(text));
        assert!(codex.validate().is_ok());
    }
}
