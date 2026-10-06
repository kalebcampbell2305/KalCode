//! Interactive provider panes (campaign Z7-W4, docs/PROVIDER_PANES.md).
//!
//! A thread the person creates can run the provider's real, unmodified CLI in a PTY pane. KalCode
//! does not imitate the TUI. What KalCode knows about the session comes only from structured
//! channels the CLI officially supports (Claude Code hooks through `kalcode-hook`, Codex hooks and
//! `notify`, Cursor plugin hooks) and from process state. Model prose is never parsed.
//!
//! - [`claude`]: launch mapping, deny floor and the session settings file (hooks).
//! - [`codex`]: read-only-first launch mapping and the OSC 9 scanner.
//! - [`cli_pane`]: Codex (hooks + notify), Cursor (plugin hooks) and Gemini CLI (process state
//!   only) panes.
//! - [`session`]: [`session::InteractiveSession`], an `AgentSession` over a PTY whose hook calls
//!   become `AgentEvent`s for the one Z3 status machine.
//! - [`provider`]: the Claude Code interactive provider, the per-thread runtime router and the
//!   pane registry the IPC layer uses to attach views.
//!
//! Hosted sessions keep provider-native permission decisions and prompts. Hooks report
//! structured activity without introducing a second KalCode approval flow.

pub mod claude;
pub mod cli_pane;
pub mod codex;
pub mod cursor_hooks;
mod cursor_input;
pub mod integrations;
pub mod provider;
pub mod session;

use kalcode_contracts::agent::{InteractiveSupport, StatusChannel};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Normalizes the exact provider-native effort selected for an interactive coding pane.
/// `None`, empty, and `default` retain the provider's own default. Provider adapters remain the
/// capability authority, so orchestration and direct pane launch cannot drift into separate
/// Claude/Codex policy tables.
pub fn normalize_effort(
    provider_id: &str,
    effort: Option<&str>,
) -> Result<Option<String>, &'static str> {
    let Some(effort) = effort
        .map(|effort| effort.trim().to_ascii_lowercase())
        .filter(|effort| !effort.is_empty() && effort != "default")
    else {
        return Ok(None);
    };
    let supported = match provider_id {
        kalcode_contracts::agent::ProviderId::CLAUDE_CODE => {
            crate::claude::argv::valid_effort_name(&effort)
        }
        kalcode_contracts::agent::ProviderId::CODEX => {
            crate::codex::argv::valid_effort_name(&effort)
        }
        _ => false,
    };
    supported
        .then_some(Some(effort))
        .ok_or("That provider doesn't support this effort level.")
}

#[cfg(test)]
mod effort_tests {
    use super::normalize_effort;
    use kalcode_contracts::agent::ProviderId;

    #[test]
    fn one_effort_capability_path_serves_direct_and_orchestrated_panes() {
        for provider in [ProviderId::CLAUDE_CODE, ProviderId::CODEX] {
            assert_eq!(
                normalize_effort(provider, Some(" HIGH ")).expect("supported effort"),
                Some("high".into())
            );
            assert_eq!(
                normalize_effort(provider, Some("default")).expect("provider default"),
                None
            );
        }
        for provider in [
            ProviderId::GEMINI_CLI,
            ProviderId::CURSOR,
            "future-provider",
        ] {
            assert!(normalize_effort(provider, Some("high")).is_err());
        }
    }
}

/// Who decides a tool call an interactive session reports through its `PreToolUse` hook.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum DecisionRouting {
    /// The hook still has to reach KalCode (so an unreachable KalCode blocks), and the call is
    /// recorded for status, but KalCode returns no decision: Claude Code's own permission flow
    /// and its prompt in the pane decide, under KalCode's deny floor.
    #[default]
    ProviderPrompt,
    /// Every call becomes `ApprovalRequired` for the Z3 runtime and the Z4 engine: allow, deny,
    /// or a KalCode approval the person answers.
    Engine,
}

/// Ordinary hosted sessions leave execution decisions with the provider's native permission
/// system. Engine routing is retained for explicit adapter tests, not app-control approval.
pub const DEFAULT_DECISION_ROUTING: DecisionRouting = DecisionRouting::ProviderPrompt;

#[cfg(test)]
mod native_permission_tests {
    use super::*;

    #[test]
    fn ordinary_provider_sessions_keep_the_provider_permission_prompt() {
        assert_eq!(DEFAULT_DECISION_ROUTING, DecisionRouting::ProviderPrompt);
        assert!(!claude::interactive_support(DEFAULT_DECISION_ROUTING).kalcode_answers_approvals);
    }
}

/// Gemini CLI: process state only ("limited status"), approvals in the provider. Gemini CLI
/// 0.61 has hooks, but no per-session way to add KalCode's without writing the user's or the
/// project's settings or hiding the user's own (verified 2026-10-04): there is no settings flag;
/// `GEMINI_CLI_HOME` replaces the user's whole home; the system settings and system-defaults
/// paths load only files owned by Administrators/SYSTEM, which a per-user KalCode install can't
/// provide; extensions load only from the user's `~/.gemini/extensions`; and settings-file hooks
/// run only in trusted folders.
pub fn gemini_interactive_support() -> InteractiveSupport {
    use kalcode_contracts::agent::{MappingFidelity, PermissionMapping};
    use kalcode_contracts::permissions::PermissionMode;
    InteractiveSupport {
        launch_mappings: [
            PermissionMode::Plan,
            PermissionMode::Approve,
            PermissionMode::Auto,
            PermissionMode::Bypass,
            PermissionMode::Custom,
        ]
        .into_iter()
        .map(|mode| PermissionMapping {
            mode,
            fidelity: MappingFidelity::ApproximateStricter,
            provider_setting: crate::gemini::permission_setting(mode),
            notes: "Approvals are answered in Gemini CLI's own prompt; KalCode shows process \
                    state only (limited status)."
                .into(),
        })
        .collect(),
        status_channels: vec![StatusChannel::ProcessOnly],
        kalcode_answers_approvals: false,
        resume: None,
    }
}

/// Where a pane's hook channel stands, for the pane header and info panel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum HookChannelState {
    /// Started; no hook call has arrived yet.
    Waiting,
    /// Hook calls are arriving and authenticated.
    Active,
    /// No hook call arrived in time (hooks disabled by user or managed settings, or broken):
    /// status comes from the process only, and approvals happen in the provider.
    Limited,
    /// The provider process has ended.
    Ended,
}

/// What the pane header and info panel show about one interactive session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PaneInfo {
    pub thread_id: String,
    pub provider_id: String,
    /// Opaque identity of this exact provider process/PTY instance. Changes on resume/restart.
    #[serde(default)]
    pub instance_id: Option<String>,
    pub hook_channel: HookChannelState,
    pub decision_routing: DecisionRouting,
    /// `true` only when KalCode answers approvals (engine routing) and hooks are active.
    pub kalcode_answers_approvals: bool,
    pub running: bool,
    pub exit_code: Option<i64>,
}

/// Records KalCode no longer waits on because the person answers in the provider's own prompt.
/// Implemented by the desktop over `PermissionService` (expire reason `answered_in_provider`).
pub trait ApprovalExpiry: Send + Sync {
    fn answered_in_provider(&self, thread_id: &str, action_id: &str);
}

/// Receives submitted user tasks for the shared deterministic namer. The historical method name
/// is retained; the durable naming authority chooses the first meaningful task and explicit task
/// changes, never overwriting manual names. Prompts must not be stored or put in an event.
pub trait TitleSink: Send + Sync {
    fn first_prompt(&self, thread_id: &str, prompt: &str);

    /// Raw terminal input may be an authentication response rather than a task. Receivers must
    /// require explicit task intent; without a receiver implementing that policy it is ignored.
    fn terminal_prompt(&self, _thread_id: &str, _prompt: &str) {}
}
