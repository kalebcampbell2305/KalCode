//! The bounded, filtered record the helper forwards for one hook call.
//!
//! Only the fields KalCode uses leave the helper. Tool output, transcripts, assistant messages
//! and everything else in the hook payload are dropped here, before anything is sent. Input
//! shapes follow the Claude Code hooks reference (https://code.claude.com/docs/en/hooks) and
//! Codex's `notify` payload (https://learn.chatgpt.com/docs/config-file/config-advanced).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Largest hook payload the helper reads from stdin.
pub const MAX_STDIN_BYTES: usize = 1024 * 1024;
/// Largest tool input forwarded for classification (serialized). Larger inputs are dropped and
/// the call is classified as an opaque tool, which always asks.
pub const MAX_TOOL_INPUT_BYTES: usize = 64 * 1024;
/// The first prompt is forwarded only so KalCode's deterministic namer can title the thread.
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
    CodexNotify,
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
            Self::CodexNotify => "codex-notify",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        Self::CLAUDE
            .into_iter()
            .chain([Self::CodexNotify])
            .find(|e| e.as_str() == name)
    }

    /// Only `PreToolUse` carries a decision KalCode enforces; it fails closed. Every other
    /// event is a status signal and fails open.
    pub fn is_blocking(self) -> bool {
        matches!(self, Self::PreToolUse)
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
    /// UserPromptSubmit only, clipped. Used for the title, never stored or put in an event.
    pub prompt: Option<String>,
    /// Codex notify `type` (e.g. `agent-turn-complete`).
    pub codex_type: Option<String>,
    /// Opaque Codex root-turn id used only to correlate and deduplicate completion status.
    pub codex_turn_id: Option<String>,
    /// Only explicitly labelled durable facts, bounded; never a transcript or terminal stream.
    /// Native memory rejects secrets before persistence. This is not an activity event.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_candidate: Option<String>,
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
            !matches!(
                event,
                HookEvent::Stop | HookEvent::CodexNotify | HookEvent::UserPromptSubmit
            ) || durable_lines(text).as_ref() != Some(text)
        }) {
            return Err(RecordError::Invalid);
        }
        if !valid_id(self.provider_session_id.as_deref(), MAX_ID_CHARS)
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
        if event != HookEvent::CodexNotify && self.codex_turn_id.is_some() {
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

        let unexpected = match event {
            HookEvent::SessionStart => {
                self.notification_type.is_some()
                    || self.error_type.is_some()
                    || self.end_reason.is_some()
                    || self.prompt.is_some()
                    || self.codex_type.is_some()
            }
            HookEvent::UserPromptSubmit => {
                self.notification_type.is_some()
                    || self.source.is_some()
                    || self.error_type.is_some()
                    || self.end_reason.is_some()
                    || self.codex_type.is_some()
            }
            HookEvent::Notification => {
                self.source.is_some()
                    || self.error_type.is_some()
                    || self.end_reason.is_some()
                    || self.prompt.is_some()
                    || self.codex_type.is_some()
            }
            HookEvent::StopFailure => {
                self.notification_type.is_some()
                    || self.source.is_some()
                    || self.end_reason.is_some()
                    || self.prompt.is_some()
                    || self.codex_type.is_some()
            }
            HookEvent::SessionEnd => {
                self.notification_type.is_some()
                    || self.source.is_some()
                    || self.error_type.is_some()
                    || self.prompt.is_some()
                    || self.codex_type.is_some()
            }
            HookEvent::CodexNotify => {
                self.in_subagent
                    || self.notification_type.is_some()
                    || self.source.is_some()
                    || self.error_type.is_some()
                    || self.end_reason.is_some()
                    || self.prompt.is_some()
            }
            HookEvent::PreToolUse
            | HookEvent::PermissionRequest
            | HookEvent::PostToolUse
            | HookEvent::PostToolUseFailure => {
                self.notification_type.is_some()
                    || self.source.is_some()
                    || self.error_type.is_some()
                    || self.end_reason.is_some()
                    || self.prompt.is_some()
                    || self.codex_type.is_some()
            }
            HookEvent::Stop | HookEvent::SubagentStart | HookEvent::SubagentStop => {
                self.notification_type.is_some()
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
        HookEvent::SessionStart => record.source = clean_id(get("source"), MAX_WORD_CHARS),
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
