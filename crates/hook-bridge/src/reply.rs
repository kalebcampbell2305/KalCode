//! KalCode's answer to one hook call, and how the helper renders it for the provider.
//!
//! Claude Code `PreToolUse` output (https://code.claude.com/docs/en/hooks): exit 2 blocks the
//! call before permission rules are evaluated; exit 0 with `hookSpecificOutput.permissionDecision`
//! `"allow"` skips the prompt (deny and ask rules still apply) or `"ask"` forces the provider's own
//! prompt; exit 0 with no output leaves the normal permission flow in charge.

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::record::clean_text;

const MAX_REASON_CHARS: usize = 300;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum HookReply {
    /// A status event was recorded. Nothing is printed.
    Ack,
    /// No decision: the provider's normal permission flow decides (flag off, see
    /// `DecisionRouting::ProviderPrompt`).
    NoDecision,
    /// KalCode policy (or the person) allowed the call.
    Allow { reason: String },
    /// KalCode policy (or the person) refused the call.
    Deny { reason: String },
    /// Hand the call to the provider's own prompt in the pane (e.g. the KalCode approval went
    /// unanswered for the whole ask window).
    Ask { reason: String },
}

/// What the helper prints and how it exits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rendered {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl Rendered {
    pub fn silent() -> Self {
        Self {
            exit_code: 0,
            stdout: String::new(),
            stderr: String::new(),
        }
    }

    /// Blocks a `PreToolUse` call (exit 2). `stderr` is shown to the model as the reason.
    pub fn block(reason: &str) -> Self {
        Self {
            exit_code: 2,
            stdout: String::new(),
            stderr: clean_text(reason, MAX_REASON_CHARS),
        }
    }
}

fn decision(kind: &str, reason: &str) -> Rendered {
    let output = json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": kind,
            "permissionDecisionReason": clean_text(reason, MAX_REASON_CHARS),
        }
    });
    Rendered {
        exit_code: 0,
        stdout: output.to_string(),
        stderr: String::new(),
    }
}

impl HookReply {
    /// Output for a Claude Code `PreToolUse` hook. A deny is rendered as exit 2 (not JSON), so it
    /// blocks even if the JSON schema ever changes. `Ack` is not a valid answer to a PreToolUse
    /// call and blocks.
    pub fn render_pre_tool_use(&self) -> Rendered {
        match self {
            Self::NoDecision => Rendered::silent(),
            Self::Allow { reason } => decision("allow", reason),
            Self::Ask { reason } => decision("ask", reason),
            Self::Deny { reason } => Rendered::block(reason),
            Self::Ack => {
                Rendered::block("KalCode sent an unexpected answer, so the tool call was blocked.")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pre_tool_use_rendering_follows_the_hooks_reference() {
        let allow = HookReply::Allow {
            reason: "Reads are allowed".into(),
        }
        .render_pre_tool_use();
        assert_eq!(allow.exit_code, 0);
        let json: serde_json::Value = serde_json::from_str(&allow.stdout).expect("json");
        assert_eq!(json["hookSpecificOutput"]["hookEventName"], "PreToolUse");
        assert_eq!(json["hookSpecificOutput"]["permissionDecision"], "allow");

        let ask = HookReply::Ask {
            reason: "Answer in Claude Code".into(),
        }
        .render_pre_tool_use();
        let json: serde_json::Value = serde_json::from_str(&ask.stdout).expect("json");
        assert_eq!(json["hookSpecificOutput"]["permissionDecision"], "ask");

        let deny = HookReply::Deny {
            reason: "No\nway\u{202e}".into(),
        }
        .render_pre_tool_use();
        assert_eq!(deny.exit_code, 2);
        assert!(deny.stdout.is_empty());
        assert_eq!(deny.stderr, "Noway");

        assert_eq!(
            HookReply::NoDecision.render_pre_tool_use(),
            Rendered::silent()
        );
        assert_eq!(HookReply::Ack.render_pre_tool_use().exit_code, 2);
    }

    #[test]
    fn replies_have_a_stable_wire_form() {
        let text = serde_json::to_string(&HookReply::Deny { reason: "r".into() }).expect("json");
        assert_eq!(text, r#"{"kind":"deny","reason":"r"}"#);
        assert!(
            serde_json::from_str::<HookReply>(r#"{"kind":"allow","reason":"r","x":1}"#).is_err()
        );
    }
}
