//! Provider-independent interpretation boundary for requests outside KalVoice's fixed grammar.
//!
//! The on-device runtime implements [`LocalInterpreter`]. Its output remains untrusted: the
//! orchestrator validates the typed action here, then routes it through the same canonical
//! executor check, allowance count, and execution path as grammar-produced actions. This module
//! exposes no shell, filesystem, deployment, script/DOM automation, or general tool-call
//! operation; its browser authority is limited to the typed visible-pane controls below.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use kalcode_contracts::agent::ProviderId;
use kalcode_contracts::ids::is_valid_id;
use kalcode_contracts::kalvoice::{
    BrowserControl, KalVoiceIntent, PaneControl, ProviderPaneRequest, ThreadScope,
};
use kalcode_contracts::threads::WorkspaceOption;

use crate::grammar::{self, MAX_THREADS_PER_REQUEST};

/// Maximum size of any model-produced label, name, query, or selector.
const MAX_ACTION_TEXT_CHARS: usize = 512;
const MAX_WORKSPACE_NAME_CHARS: usize = 256;
pub const MAX_LOCAL_WORKSPACES: usize = 64;
pub const MAX_GROUNDED_ACTION_CANDIDATES: usize = 8;

pub const LOCAL_REASONING_UNAVAILABLE_MESSAGE: &str = "The on-device KalVoice interpreter is not ready. Open KalVoice settings to check setup or startup.";
pub const LOCAL_REASONING_UNCERTAIN_MESSAGE: &str =
    "KalVoice couldn't determine a safe local action. Try a more specific command.";
pub const LOCAL_REASONING_FAILED_MESSAGE: &str =
    "The on-device KalVoice interpreter couldn't process this request.";
pub const LOCAL_REASONING_INVALID_OUTPUT_MESSAGE: &str =
    "The on-device KalVoice interpreter returned an invalid action.";

/// Minimal input for a local interpreter. No provider, account, credential, or environment data
/// crosses this boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalInterpretationRequest {
    pub request: String,
    /// Current workspace only when it belongs to `workspaces`.
    pub workspace_id: Option<String>,
    /// Bounded native-resolved choices. Paths never cross this boundary.
    pub workspaces: Vec<WorkspaceOption>,
}

/// A local interpreter may propose one typed KalVoice action or decline when confidence is low.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocalInterpretation {
    Action(KalVoiceIntent),
    Uncertain,
}

/// One host-constructed action the local model may select. The opaque ID is scoped to one request;
/// the model never constructs an intent or any of its arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GroundedActionCandidate {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) intent: KalVoiceIntent,
}

/// Produces a closed, bounded candidate set from canonical deterministic grammar evidence. A
/// named target must resolve uniquely inside the path-free request snapshot. Unsupported,
/// negated, compound, unknown, or ambiguous requests offer the model no executable choice.
pub(crate) fn grounded_action_candidates(
    request: &LocalInterpretationRequest,
) -> Vec<GroundedActionCandidate> {
    grammar::local_reasoning_groundings(&request.request)
        .into_iter()
        .filter_map(|grounding| match grounding {
            grammar::LocalReasoningGrounding::ShowApprovals => Some((
                "Show pending approvals".to_owned(),
                KalVoiceIntent::ShowApprovals,
            )),
            grammar::LocalReasoningGrounding::StatusReport => Some((
                "Show thread status".to_owned(),
                KalVoiceIntent::StatusReport,
            )),
            grammar::LocalReasoningGrounding::Navigate(surface) => Some((
                format!("Open {}", surface_label(surface)),
                KalVoiceIntent::Navigate { surface },
            )),
            grammar::LocalReasoningGrounding::OpenWorkspace(name) => {
                let workspace = unique_workspace(&name, &request.workspaces)?;
                Some((
                    format!("Open workspace: {}", workspace.name),
                    KalVoiceIntent::OpenWorkspace {
                        query: workspace.name.clone(),
                    },
                ))
            }
        })
        .filter(|(_, intent)| validate_action(intent.clone(), &request.workspaces).is_ok())
        .fold(Vec::new(), |mut candidates, (label, intent)| {
            if candidates.len() < MAX_GROUNDED_ACTION_CANDIDATES
                && !candidates
                    .iter()
                    .any(|candidate: &GroundedActionCandidate| candidate.intent == intent)
            {
                candidates.push(GroundedActionCandidate {
                    id: format!("c{}", candidates.len()),
                    label,
                    intent,
                });
            }
            candidates
        })
}

fn surface_label(surface: kalcode_contracts::app::SurfaceId) -> &'static str {
    use kalcode_contracts::app::SurfaceId;

    match surface {
        SurfaceId::Dashboard => "dashboard",
        SurfaceId::KalVoice => "KalVoice",
        SurfaceId::Code => "Code Mode",
        SurfaceId::Threads => "threads",
        SurfaceId::Agents => "agents",
        SurfaceId::Missions => "missions",
        SurfaceId::Automations => "automations",
        SurfaceId::Skills => "skills",
        SurfaceId::Plugins => "plugins",
        SurfaceId::Memory => "memory",
        SurfaceId::Providers => "providers",
        SurfaceId::Settings => "settings",
        SurfaceId::CommandCenter => "Command Center",
    }
}

fn unique_workspace<'a>(
    name: &str,
    workspaces: &'a [WorkspaceOption],
) -> Option<&'a WorkspaceOption> {
    let name = name.trim();
    let name = name.strip_prefix("my ").unwrap_or(name);
    let mut matching = workspaces
        .iter()
        .filter(|workspace| workspace.name.eq_ignore_ascii_case(name));
    let workspace = matching.next()?;
    matching.next().is_none().then_some(workspace)
}

/// Bounded failures from the local runtime. Raw model/runtime errors are deliberately excluded
/// so they cannot become user-visible output, logs, or events through the orchestrator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalInterpretationError {
    Unavailable,
    Failed,
}

/// Shared cancellation for one bounded local inference. The request owner supplies both this
/// token and an absolute deadline so timeout and shutdown stop the same operation instead of
/// abandoning detached model work.
#[derive(Clone, Default)]
pub struct LocalInterpretationCancellation {
    cancelled: Arc<AtomicBool>,
}

impl LocalInterpretationCancellation {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    pub(crate) fn same_operation(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.cancelled, &other.cancelled)
    }
}

/// Injectable provider-independent structured-action interpreter.
pub trait LocalInterpreter: Send + Sync {
    fn interpret(
        &self,
        request: LocalInterpretationRequest,
        deadline: Instant,
        cancellation: &LocalInterpretationCancellation,
    ) -> Result<LocalInterpretation, LocalInterpretationError>;
}

/// Default until a supported on-device runtime is explicitly wired by the application.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoLocalInterpreter;

impl LocalInterpreter for NoLocalInterpreter {
    fn interpret(
        &self,
        _request: LocalInterpretationRequest,
        _deadline: Instant,
        _cancellation: &LocalInterpretationCancellation,
    ) -> Result<LocalInterpretation, LocalInterpretationError> {
        Err(LocalInterpretationError::Unavailable)
    }
}

pub(crate) struct ValidatedLocalAction(KalVoiceIntent);

impl ValidatedLocalAction {
    pub(crate) fn into_intent(self) -> KalVoiceIntent {
        self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct InvalidLocalOutput;

/// Validates every model-controlled field before the canonical runtime sees the action.
pub(crate) fn validate_action(
    intent: KalVoiceIntent,
    workspaces: &[WorkspaceOption],
) -> Result<ValidatedLocalAction, InvalidLocalOutput> {
    let valid = match &intent {
        KalVoiceIntent::Navigate { .. }
        | KalVoiceIntent::ShowApprovals
        | KalVoiceIntent::StatusReport
        | KalVoiceIntent::Split { .. }
        | KalVoiceIntent::FilterDashboard { .. } => true,
        KalVoiceIntent::OpenWorkspace { query } => {
            valid_text(query) && workspace_name_is_offered(query, workspaces)
        }
        KalVoiceIntent::OpenThread { query }
        | KalVoiceIntent::Focus { query }
        | KalVoiceIntent::Search { query } => valid_text(query),
        KalVoiceIntent::CreateTerminal { workspace_id } => {
            valid_workspace_id(workspace_id, workspaces)
        }
        KalVoiceIntent::CreateThreads {
            provider_id,
            count,
            workspace_id,
        } => {
            valid_provider(provider_id)
                && (1..=MAX_THREADS_PER_REQUEST).contains(&u32::from(*count))
                && valid_workspace_id(workspace_id, workspaces)
        }
        KalVoiceIntent::CreateProviderPanes {
            groups,
            workspace_id,
        } => valid_workspace_id(workspace_id, workspaces) && valid_provider_groups(groups),
        KalVoiceIntent::ControlPane {
            command,
            workspace_id,
        } => valid_workspace_id(workspace_id, workspaces) && valid_pane_control(command),
        KalVoiceIntent::ControlBrowser {
            command,
            workspace_id,
        } => valid_workspace_id(workspace_id, workspaces) && valid_browser_control(command),
        KalVoiceIntent::PauseThreads { scope }
        | KalVoiceIntent::ResumeThreads { scope }
        | KalVoiceIntent::StopThreads { scope } => valid_scope(scope, workspaces),
        // A local interpretation cannot recursively request reasoning or reach a provider.
        KalVoiceIntent::Reasoning { .. } => false,
        KalVoiceIntent::Resize { steps, .. } => (1..=10).contains(steps),
        KalVoiceIntent::Close { query } => valid_optional_text(query),
        KalVoiceIntent::SwitchProvider { provider_id } => valid_provider(provider_id),
        KalVoiceIntent::RequestPermissionMode { thread_query, .. } => {
            valid_optional_text(thread_query)
        }
    };
    if valid {
        Ok(ValidatedLocalAction(intent))
    } else {
        Err(InvalidLocalOutput)
    }
}

/// Removes malformed, duplicate, and excess entries before a snapshot crosses into a local
/// interpreter. Order remains the canonical resolver's display order.
pub(crate) fn bounded_workspace_snapshot(workspaces: Vec<WorkspaceOption>) -> Vec<WorkspaceOption> {
    let mut ids = std::collections::HashSet::new();
    workspaces
        .into_iter()
        .filter(|workspace| {
            is_valid_id(&workspace.id)
                && valid_workspace_name(&workspace.name)
                && ids.insert(workspace.id.clone())
        })
        .take(MAX_LOCAL_WORKSPACES)
        .collect()
}

fn valid_browser_control(command: &BrowserControl) -> bool {
    let valid_browser_id = |id: &Option<String>| valid_optional_id(id);
    match command {
        BrowserControl::Open { url, .. } => url.as_ref().is_none_or(valid_browser_url),
        BrowserControl::Navigate { url, browser_id } => {
            valid_browser_url(url) && valid_browser_id(browser_id)
        }
        BrowserControl::Back { browser_id }
        | BrowserControl::Forward { browser_id }
        | BrowserControl::Reload { browser_id }
        | BrowserControl::Stop { browser_id } => valid_browser_id(browser_id),
    }
}

fn valid_browser_url(value: &String) -> bool {
    crate::grammar::normalize_spoken_browser_url(value).as_ref() == Some(value)
}

fn valid_provider_groups(groups: &[ProviderPaneRequest]) -> bool {
    if groups.is_empty() || groups.len() > MAX_THREADS_PER_REQUEST as usize {
        return false;
    }
    let mut total = 0u32;
    for group in groups {
        let count = u32::from(group.count);
        total = total.saturating_add(count);
        if count == 0
            || total > MAX_THREADS_PER_REQUEST
            || !group.provider_id.as_ref().is_none_or(valid_provider)
            || !valid_optional_text(&group.account_query)
            || !valid_optional_text(&group.model)
        {
            return false;
        }
    }
    true
}

fn valid_pane_control(command: &PaneControl) -> bool {
    match command {
        PaneControl::Resize { query, .. } => valid_text(query),
        PaneControl::Move { query, beside } => valid_text(query) && valid_text(beside),
        PaneControl::Maximize { query }
        | PaneControl::Restore { query }
        | PaneControl::Collapse { query }
        | PaneControl::Expand { query } => valid_optional_text(query),
    }
}

fn valid_scope(scope: &ThreadScope, workspaces: &[WorkspaceOption]) -> bool {
    match scope {
        ThreadScope::All => true,
        ThreadScope::Workspace { workspace_id } => {
            workspace_id_is_offered(workspace_id, workspaces)
        }
        ThreadScope::Thread { thread_id } => is_valid_id(thread_id),
    }
}

fn valid_optional_id(id: &Option<String>) -> bool {
    id.as_ref().is_none_or(|id| is_valid_id(id))
}

fn valid_workspace_id(id: &Option<String>, workspaces: &[WorkspaceOption]) -> bool {
    id.as_ref()
        .is_none_or(|id| workspace_id_is_offered(id, workspaces))
}

fn workspace_id_is_offered(id: &str, workspaces: &[WorkspaceOption]) -> bool {
    is_valid_id(id) && workspaces.iter().any(|workspace| workspace.id == id)
}

fn workspace_name_is_offered(name: &str, workspaces: &[WorkspaceOption]) -> bool {
    let name = name.trim();
    workspaces
        .iter()
        .any(|workspace| workspace.name.eq_ignore_ascii_case(name))
}

fn valid_workspace_name(name: &str) -> bool {
    !name.is_empty()
        && name == name.trim()
        && name.chars().count() <= MAX_WORKSPACE_NAME_CHARS
        && !name.chars().any(disallowed_text_character)
}

fn valid_provider(provider: &ProviderId) -> bool {
    matches!(
        provider.as_str(),
        ProviderId::CLAUDE_CODE | ProviderId::CODEX | ProviderId::GEMINI_CLI
    )
}

fn valid_optional_text(value: &Option<String>) -> bool {
    value.as_ref().is_none_or(|value| valid_text(value))
}

fn valid_text(value: &str) -> bool {
    !value.is_empty()
        && value == value.trim()
        && value.chars().count() <= MAX_ACTION_TEXT_CHARS
        && !value.chars().any(disallowed_text_character)
}

fn disallowed_text_character(character: char) -> bool {
    character.is_control()
        || matches!(
            character,
            '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}'
        )
}

#[cfg(test)]
#[path = "local_reasoning_tests.rs"]
mod tests;
