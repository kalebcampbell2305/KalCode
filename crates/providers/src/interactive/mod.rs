//! Interactive provider panes (campaign Z7-W4, docs/PROVIDER_PANES.md).
//!
//! A thread the person creates can run the provider's real, unmodified CLI in a PTY pane. KalCode
//! does not imitate the TUI. What KalCode knows about the session comes only from structured
//! channels the CLI officially supports (Claude Code hooks through `kalcode-hook`, Codex `notify`
//! and OSC 9) and from process state. Model prose is never parsed.
//!
//! - [`claude`]: launch mapping, deny floor and the session settings file (hooks).
//! - [`codex`]: read-only-first launch mapping and the OSC 9 scanner (not wired to a runtime
//!   yet: Codex has no registered provider entry).
//! - [`session`]: [`session::InteractiveSession`], an `AgentSession` over a PTY whose hook calls
//!   become `AgentEvent`s for the one Z3 status machine.
//! - [`provider`]: the Claude Code interactive provider, the per-thread runtime router and the
//!   pane registry the IPC layer uses to attach views.
//!
//! Decisions are behind [`DecisionRouting`]: until the classifier fixes on
//! `sec/latent-hardening` merge, hook calls never route approve/deny through the engine.

pub mod claude;
pub mod codex;
pub mod provider;
pub mod session;

use kalcode_contracts::agent::{InteractiveSupport, StatusChannel};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

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

/// The routing shipped builds use. Flip to [`DecisionRouting::Engine`] only after the classifier
/// fixes (`sec/latent-hardening`, ADVANCED.md §14b) merge and are re-reviewed.
pub const DEFAULT_DECISION_ROUTING: DecisionRouting = DecisionRouting::ProviderPrompt;

/// Gemini CLI: hooks exist but a per-session way to inject KalCode's without writing user or
/// project settings is unverified (not installed on the verification machine). Process state
/// only, approvals in the provider.
pub fn gemini_interactive_support() -> InteractiveSupport {
    InteractiveSupport {
        launch_mappings: Vec::new(),
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

/// Receives the first prompt of an interactive session so the deterministic namer can title the
/// thread. The prompt must not be stored or put in an event.
pub trait TitleSink: Send + Sync {
    fn first_prompt(&self, thread_id: &str, prompt: &str);
}
