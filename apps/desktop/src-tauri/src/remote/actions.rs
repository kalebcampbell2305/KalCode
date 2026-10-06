//! Operations (§5). Reads come from the same services the desktop UI reads; every agent action
//! is a `KalVoiceIntent` run by the KalVoice orchestrator's executor, so Remote shares the
//! desktop's action bus and safety rules. Blocking: called on a blocking thread.

use std::collections::HashMap;

use kalcode_contracts::agent::ProviderId;
use kalcode_contracts::agent_state::{AgentFilter, AgentState as DeskState};
use kalcode_contracts::git::{GitFileChange, LineKind};
use kalcode_contracts::ids::{is_valid_id, new_id};
use kalcode_contracts::kalvoice::{
    AgentLaunchAssignment, KalVoiceInput, KalVoiceIntent, KalVoiceOutcome, ThreadScope,
};
use kalcode_contracts::permissions::{ActionOrigin, ApprovalDecision, ApprovalStatus};
use kalcode_contracts::threads::{
    MessageRole, ThreadRuntimeKind, ThreadStatus, ThreadSummary, ToolCallStatus,
};
use kalcode_core::{IpcError, KalError};
use kalcode_git::diff::{DiffOptions, DiffTarget};
use kalcode_kalvoice::orchestrator::{CommandRequest, KalVoiceResponse, UiDirective};
use kalcode_permissions::Actor;
use kalcode_remote::ops::{
    self, AgentDetail, AgentMessage, Decision, DiffFile, DiffHunk, DiffLineKind, DiffResult,
    LaunchAccount, LaunchModel, LaunchOptions, LaunchProvider, LogEntry, LogPage, Op, RunDetail,
    Summary, TestResult, ToolCall, VoiceResult, WorktreeInfo,
};
use kalcode_remote::registry::Device;
use kalcode_remote::wire::{RemoteError, RemoteWorkspace};
use serde_json::Value;
use tauri::{AppHandle, Manager};
use time::OffsetDateTime;

use super::snapshot::{self, parse_time};
use crate::AppState;
use crate::git_commands::GitState;
use crate::kalvoice_commands::KalVoiceState;
use crate::notification_commands::NotificationsState;
use crate::operations_commands::OperationsState;
use crate::permission_commands::PermissionState;
use crate::provider_pane_commands::ProviderPanesState;
use crate::runtime_coordinator::{RuntimeService, RuntimeState};
use crate::thread_commands::ThreadsState;

/// Messages and tool calls shown in an agent's detail; older ones load through `agent.log`.
const DETAIL_PAGE: u32 = 50;
/// The longest prompt a device may send (the desktop composer's practical limit).
const MAX_PROMPT_CHARS: usize = 8_000;
/// Diff byte cap when the device names none, and the most it may ask for.
const DEFAULT_DIFF_BYTES: u64 = 512 * 1024;
const MAX_DIFF_BYTES: u64 = 4 * 1024 * 1024;
/// Effort ids a provider may accept; each provider's adapter decides which it does.
const EFFORT_CANDIDATES: [&str; 6] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/// Runs one parsed operation for `device`.
pub fn run(app: &AppHandle, device: &Device, op: Op) -> Result<Value, RemoteError> {
    match op {
        Op::AgentDetail(a) => to_value(agent_detail(app, &a.agent_id)?),
        Op::AgentDiff(a) => to_value(agent_diff(app, &a.agent_id, a.max_bytes)?),
        Op::AgentLog(a) => to_value(agent_log(app, &a.agent_id, a.before_id.as_deref())?),
        Op::AgentPrompt(p) => {
            let text = prompt_text(&p.text)?;
            let thread = agent(app, &p.agent_id)?;
            let intent = intent_of(&Op::AgentPrompt(ops::PromptArgs {
                agent_id: p.agent_id,
                text: text.clone(),
            }))?;
            // The executor's check (an open approval refuses, a stopped agent resumes) passed;
            // the desktop window would now press Send, so the host sends natively.
            match act(app, &intent, &thread)?.1 {
                Some(UiDirective::ComposeInThread {
                    thread_id, submit, ..
                }) if thread_id == thread.id => deliver_prompt(app, &thread, &text, submit)?,
                _ => return Err(RemoteError::internal("KalCode couldn't send that prompt.")),
            }
            to_value(Summary {
                summary: format!("Sent to {}.", thread.name),
            })
        }
        Op::AgentStop(ref a) | Op::AgentRetry(ref a) => {
            let thread = agent(app, &a.agent_id)?;
            let (summary, _) = act(app, &intent_of(&op)?, &thread)?;
            to_value(Summary { summary })
        }
        Op::AgentLaunch(ref launch) => {
            if !workspace_exists(app, &launch.workspace_id)? {
                return Err(RemoteError::not_found("That workspace no longer exists."));
            }
            if launch
                .account_id
                .as_deref()
                .is_some_and(|id| !is_valid_id(id))
            {
                return Err(RemoteError::invalid("That account id is invalid."));
            }
            let response = kalvoice(
                app,
                intent_of(&op)?,
                Some(launch.workspace_id.clone()),
                None,
            )?;
            let (summary, directive) = completed(response)?;
            let agent_id = match &directive {
                Some(UiDirective::OpenProviderPanes { thread_ids, .. }) => {
                    thread_ids.first().cloned()
                }
                _ => None,
            };
            tell_window(app, directive, Vec::new());
            to_value(ops::LaunchResult { agent_id, summary })
        }
        Op::LaunchOptions => to_value(launch_options(app)?),
        Op::NeedsDecide(d) => to_value(decide(app, device, &d.approval_id, d.decision)?),
        Op::VoiceCommand(v) => to_value(voice_command(app, &v.text, v.agent_id.as_deref())?),
        Op::RunDetail(r) => to_value(run_detail(app, &r.run_id)?),
        Op::TidyCloseIdle => {
            let response = kalvoice(app, intent_of(&op)?, None, None)?;
            let (summary, directive) = completed(response)?;
            let summary = match directive {
                Some(UiDirective::CloseIdleAgents { .. }) => close_idle(app)?,
                _ => summary,
            };
            to_value(Summary { summary })
        }
    }
}

/// The KalVoice intent behind an agent action. Agent-addressed intents name the agent itself
/// (`Thread` scope, or "it" with the agent as the focused thread), never a name to look up.
pub fn intent_of(op: &Op) -> Result<KalVoiceIntent, RemoteError> {
    Ok(match op {
        Op::AgentStop(a) => KalVoiceIntent::StopThreads {
            scope: ThreadScope::Thread {
                thread_id: a.agent_id.clone(),
            },
            expected_count: Some(1),
        },
        Op::AgentRetry(a) => KalVoiceIntent::ResumeThreads {
            scope: ThreadScope::Thread {
                thread_id: a.agent_id.clone(),
            },
        },
        Op::AgentPrompt(p) => KalVoiceIntent::DirectPrompt {
            target: "it".into(),
            prompt: p.text.clone(),
        },
        Op::AgentLaunch(l) => KalVoiceIntent::CreateThreads {
            provider_id: ProviderId::new(l.provider_id.trim()),
            count: 1,
            workspace_id: Some(l.workspace_id.clone()),
            // An exact account id resolves to that account (never a label guess).
            account_query: l.account_id.clone(),
            model: l.model.clone().filter(|m| !m.trim().is_empty()),
            effort: l.effort.clone().filter(|e| !e.trim().is_empty()),
            assignments: l
                .prompt
                .as_deref()
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .map(|task| {
                    vec![AgentLaunchAssignment {
                        count: 1,
                        task: task.to_owned(),
                    }]
                })
                .unwrap_or_default(),
        },
        Op::TidyCloseIdle => KalVoiceIntent::CloseIdleAgents { provider_id: None },
        _ => {
            return Err(RemoteError::internal(
                "That operation is not an agent action.",
            ));
        }
    })
}

fn to_value<T: serde::Serialize>(value: T) -> Result<Value, RemoteError> {
    serde_json::to_value(value)
        .map_err(|_| RemoteError::internal("KalCode couldn't encode the result."))
}

/// A native error, as the device sees it. Messages are already user-safe.
fn from_ipc(error: IpcError) -> RemoteError {
    let code = error.code.as_str();
    if code == "runtime_not_ready" || code.ends_with("_unavailable") {
        RemoteError::unavailable(error.message)
    } else if code.ends_with("not_found")
        || code.ends_with("_unknown")
        || code.starts_with("invalid_")
    {
        RemoteError::not_found(error.message)
    } else {
        RemoteError::refused(error.message)
    }
}

fn from_kal(error: KalError) -> RemoteError {
    from_ipc(error.to_ipc())
}

/// Borrows one account-scoped service for the duration of a call.
fn service<T: RuntimeService>(app: &AppHandle) -> Result<RuntimeState<T>, RemoteError> {
    let state = RuntimeState::<T>::from_app(app).map_err(from_ipc)?;
    state.revalidate().map_err(from_ipc)?;
    Ok(state)
}

fn core(app: &AppHandle) -> Result<std::sync::Arc<kalcode_core::Core>, RemoteError> {
    app.state::<AppState>().core().cloned().map_err(from_ipc)
}

/// The agent, or `not_found` when it ended or never existed (never a substitute).
pub fn agent(app: &AppHandle, id: &str) -> Result<ThreadSummary, RemoteError> {
    let gone = || RemoteError::not_found("This agent no longer exists.");
    if !is_valid_id(id) {
        return Err(gone());
    }
    let threads = service::<ThreadsState>(app)?;
    let mut thread = threads.runtime().map_err(from_ipc)?.get(id).map_err(|e| {
        if e.code.ends_with("not_found") {
            gone()
        } else {
            from_kal(e)
        }
    })?;
    if thread.archived_at.is_some() {
        return Err(gone());
    }
    service::<ProviderPanesState>(app)?.stamp_runtime_kind(&mut thread);
    Ok(thread)
}

fn workspace_exists(app: &AppHandle, id: &str) -> Result<bool, RemoteError> {
    Ok(is_valid_id(id)
        && core(app)?
            .workspaces()
            .map_err(from_kal)?
            .iter()
            .any(|w| w.id == id))
}

fn prompt_text(text: &str) -> Result<String, RemoteError> {
    // Terminal control characters never reach an agent; newlines and tabs are kept.
    let clean: String = text
        .replace("\r\n", "\n")
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .collect();
    let clean = clean.trim().to_owned();
    if clean.is_empty() {
        return Err(RemoteError::invalid("Type a prompt to send."));
    }
    if clean.chars().count() > MAX_PROMPT_CHARS {
        return Err(RemoteError::invalid(format!(
            "Prompts can be up to {MAX_PROMPT_CHARS} characters."
        )));
    }
    Ok(clean)
}

/// Runs `intent` through the orchestrator (claim, safety check, executor). The request names
/// the agent as the focused thread so "it" resolves to exactly that agent.
fn kalvoice(
    app: &AppHandle,
    intent: KalVoiceIntent,
    workspace_id: Option<String>,
    thread_id: Option<String>,
) -> Result<KalVoiceResponse, RemoteError> {
    let voice = service::<KalVoiceState>(app)?;
    voice
        .remote_intent(
            CommandRequest {
                request_id: new_id(),
                text: String::new(),
                input: KalVoiceInput::Text,
                workspace_id,
                thread_id,
            },
            intent,
        )
        .map_err(from_ipc)
}

fn act(
    app: &AppHandle,
    intent: &KalVoiceIntent,
    thread: &ThreadSummary,
) -> Result<(String, Option<UiDirective>), RemoteError> {
    completed(kalvoice(
        app,
        intent.clone(),
        Some(thread.workspace_id.clone()),
        Some(thread.id.clone()),
    )?)
}

/// A completed response's summary and directive; any other outcome as the device's error.
fn completed(response: KalVoiceResponse) -> Result<(String, Option<UiDirective>), RemoteError> {
    match response.outcome {
        KalVoiceOutcome::Completed { summary } => Ok((summary, response.directive)),
        KalVoiceOutcome::Failed { code, message } => Err(failure(&code, message)),
        KalVoiceOutcome::PermissionRequired { .. } => Err(RemoteError::refused(
            "This needs your approval first. Answer it in Needs You.",
        )),
        KalVoiceOutcome::NeedsProvider { message } => Err(RemoteError::refused(message)),
        KalVoiceOutcome::LimitReached { .. } => Err(RemoteError::refused(
            "KalVoice's limit is reached for now. Try again later.",
        )),
    }
}

/// An executor refusal as a §5 error: a vanished target is `not_found`, a request already in
/// flight or a changed state is `conflict`, every other safety rule is `refused`.
pub fn failure(code: &str, message: String) -> RemoteError {
    if code.contains("not_found") || code.ends_with("_unknown") || code == "thread_gone" {
        RemoteError::not_found(message)
    } else if code.contains("in_progress")
        || code.contains("indeterminate")
        || code.contains("changed")
    {
        RemoteError::conflict(message)
    } else {
        RemoteError::refused(message)
    }
}

/// Shows what Remote changed in the desktop window right away (best effort).
fn tell_window(app: &AppHandle, directive: Option<UiDirective>, closed: Vec<String>) {
    let directive = directive.filter(|d| matches!(d, UiDirective::OpenProviderPanes { .. }));
    if directive.is_none() && closed.is_empty() {
        return;
    }
    if let Ok(voice) = RuntimeState::<KalVoiceState>::from_app(app) {
        voice.remote_acted(directive, closed);
    }
}

/// Sends a prompt the executor admitted, the way the desktop's own Send does: into a coding
/// agent's terminal as one guarded paste + Enter (refused while it works, shows a provider
/// prompt or has unsent input), or to a headless thread through the thread runtime.
fn deliver_prompt(
    app: &AppHandle,
    thread: &ThreadSummary,
    text: &str,
    submit: bool,
) -> Result<(), RemoteError> {
    let panes = service::<ProviderPanesState>(app)?;
    if panes.is_interactive_thread(&thread.id).map_err(from_kal)? {
        let ended = || {
            RemoteError::refused(
                "This agent's terminal isn't running. Retry it, then send your prompt.",
            )
        };
        if !submit {
            return Err(ended());
        }
        let instance = panes
            .handoff_info(&thread.id)
            .filter(|info| info.running)
            .and_then(|info| info.instance_id)
            .ok_or_else(ended)?;
        use kalcode_providers::interactive::provider::HandoffDeliveryError as E;
        return panes
            .deliver_handoff(&thread.id, &instance, text, || Ok(()))
            .map_err(|error| match error {
                E::TargetChanged | E::SessionEnded => RemoteError::conflict(error.to_string()),
                E::InvalidText => RemoteError::invalid(error.to_string()),
                E::Io => RemoteError::unavailable(error.to_string()),
                _ => RemoteError::refused(error.to_string()),
            });
    }
    let threads = service::<ThreadsState>(app)?;
    let runtime = threads.runtime().map_err(from_ipc)?;
    if submit {
        runtime.send_reviewed(&thread.id, text, None)
    } else {
        // "Resume and send", as the desktop composer does for a stopped thread.
        runtime.resume(&thread.id, Some(text))
    }
    .map(|_| ())
    .map_err(from_kal)
}

/// KalTidy's idle-agent close, natively: every coding agent idle at its prompt is removed the
/// way the desktop's `removeAgent` does (archive; a running one is stopped, then archived).
/// Returns the summary; the window closes their panes.
fn close_idle(app: &AppHandle) -> Result<String, RemoteError> {
    let threads = service::<ThreadsState>(app)?;
    let panes = service::<ProviderPanesState>(app)?;
    let runtime = threads.runtime().map_err(from_ipc)?;
    let mut targets = runtime.list(None, false).map_err(from_kal)?;
    for thread in &mut targets {
        panes.stamp_runtime_kind(thread);
    }
    targets.retain(idle_closable);
    let (mut closed, mut failed) = (Vec::new(), 0usize);
    for thread in &targets {
        let removed = match runtime.archive(&thread.id) {
            Err(e) if e.code == "thread_running" => {
                let _ = runtime.stop(&thread.id);
                runtime.archive(&thread.id)
            }
            other => other,
        };
        match removed {
            Ok(_) => closed.push(thread.id.clone()),
            Err(_) => failed += 1,
        }
    }
    let count = closed.len();
    tell_window(app, None, closed);
    Ok(match (count, failed) {
        (0, 0) => "No idle agents to close.".into(),
        (n, 0) => format!(
            "Closed {n} idle {}.",
            if n == 1 { "agent" } else { "agents" }
        ),
        (n, f) => format!(
            "Closed {n} idle {}; {f} couldn't be closed.",
            if n == 1 { "agent" } else { "agents" }
        ),
    })
}

/// Exactly KalTidy's (and the executor's) idle-agent rule: a coding agent idle at its prompt.
pub fn idle_closable(thread: &ThreadSummary) -> bool {
    let coding_agent = thread.runtime_kind == Some(ThreadRuntimeKind::InteractivePty)
        || thread.terminal_id.is_some();
    coding_agent
        && thread.archived_at.is_none()
        && thread.status == ThreadStatus::Idle
        && DeskState::of_status(thread.status, thread.current_activity.as_deref()).filter()
            == AgentFilter::Idle
}

fn agent_detail(app: &AppHandle, id: &str) -> Result<AgentDetail, RemoteError> {
    let thread = agent(app, id)?;
    let now = OffsetDateTime::now_utc();
    let threads = service::<ThreadsState>(app)?;
    let runtime = threads.runtime().map_err(from_ipc)?;
    let messages = runtime
        .messages(id, DETAIL_PAGE, None)
        .map_err(from_kal)?
        .into_iter()
        .map(|m| AgentMessage {
            role: snapshot::snake(&m.role),
            text: m.content,
            at: parse_time(&m.created_at).unwrap_or(now),
        })
        .collect();
    let tools = runtime
        .tool_calls(id, DETAIL_PAGE)
        .map_err(from_kal)?
        .into_iter()
        .map(|t| ToolCall {
            name: t.tool,
            summary: t.summary,
            status: match t.status {
                ToolCallStatus::Requested | ToolCallStatus::Running => "running",
                ToolCallStatus::Completed => "succeeded",
                ToolCallStatus::Failed | ToolCallStatus::Cancelled => "failed",
            }
            .into(),
            at: [&t.completed_at, &t.started_at]
                .into_iter()
                .flatten()
                .find_map(|at| parse_time(at))
                .or_else(|| parse_time(&t.requested_at))
                .unwrap_or(now),
        })
        .collect();
    drop(threads);
    let worktree = worktree(app, &thread);
    Ok(AgentDetail {
        agent: snapshot::agent(&thread, now),
        messages,
        tools,
        worktree,
    })
}

/// The agent's own worktree: folder, branch and the branch it would merge into.
fn worktree(app: &AppHandle, thread: &ThreadSummary) -> Option<WorktreeInfo> {
    let worktree_id = thread.worktree_id.as_deref()?;
    let core = core(app).ok()?;
    let (row, path) = core
        .read(|conn| {
            Ok((
                kalcode_git::store::get_worktree(conn, worktree_id)?,
                kalcode_git::store::worktree_path(conn, worktree_id)?,
            ))
        })
        .ok()?;
    let base_branch = service::<GitState>(app).ok().and_then(|git| {
        let root = crate::git_commands::workspace_root_in(&core, &thread.workspace_id).ok()?;
        crate::git_commands::thread_worktree_states_for(
            &git.0,
            vec![(thread.id.clone(), row.clone(), path.clone(), root)],
        )
        .into_iter()
        .next()
        .and_then(|state| state.base_branch)
    });
    Some(WorktreeInfo {
        path: path.to_string_lossy().into_owned(),
        branch: row.branch,
        base_branch,
    })
}

/// The agent's changes: everything since its worktree branched (committed or not), or the
/// uncommitted changes of the workspace it works in.
fn agent_diff(
    app: &AppHandle,
    id: &str,
    max_bytes: Option<u64>,
) -> Result<DiffResult, RemoteError> {
    let thread = agent(app, id)?;
    let state = app.state::<AppState>();
    let root = crate::git_commands::target_root(
        &state,
        &thread.workspace_id,
        thread.worktree_id.as_deref(),
    )
    .map_err(from_kal)?;
    let target = match thread.worktree_id.as_deref() {
        Some(worktree_id) => {
            let base = core(app)?
                .read(|conn| kalcode_git::store::get_worktree(conn, worktree_id))
                .map_err(from_kal)?
                .base_commit;
            DiffTarget::Base { base }
        }
        None => DiffTarget::Head,
    };
    let cap = max_bytes
        .unwrap_or(DEFAULT_DIFF_BYTES)
        .clamp(4 * 1024, MAX_DIFF_BYTES);
    let git = service::<GitState>(app)?;
    let diff = git
        .0
        .diff(
            &root,
            &target,
            &[],
            &DiffOptions {
                max_patch_bytes: usize::try_from(cap).unwrap_or(usize::MAX),
                ..DiffOptions::default()
            },
        )
        .map_err(|e| {
            if e.code == "not_a_repository" {
                RemoteError::unavailable("This agent's folder isn't a Git repository.")
            } else {
                from_kal(e)
            }
        })?;
    let truncated = diff.truncated || diff.files.iter().any(|f| f.hunks_truncated);
    let files = diff
        .files
        .into_iter()
        .map(|file| DiffFile {
            path: file.meta.path,
            status: match file.meta.change {
                GitFileChange::Added => "added",
                GitFileChange::Deleted => "deleted",
                GitFileChange::Renamed | GitFileChange::Copied => "renamed",
                _ => "modified",
            }
            .into(),
            additions: file.meta.additions,
            deletions: file.meta.deletions,
            hunks: file
                .hunks
                .into_iter()
                .map(|hunk| DiffHunk {
                    header: hunk.header,
                    lines: hunk
                        .lines
                        .into_iter()
                        .filter_map(|line| {
                            let kind = match line.kind {
                                LineKind::Add => DiffLineKind::Add,
                                LineKind::Delete => DiffLineKind::Del,
                                LineKind::Context => DiffLineKind::Ctx,
                                LineKind::NoNewline => return None,
                            };
                            Some((kind, line.text))
                        })
                        .collect(),
                })
                .collect(),
        })
        .collect();
    Ok(DiffResult { files, truncated })
}

/// One page of the agent's transcript, newest last; `more` when an older page exists.
fn agent_log(app: &AppHandle, id: &str, before: Option<&str>) -> Result<LogPage, RemoteError> {
    agent(app, id)?;
    if before.is_some_and(|b| !is_valid_id(b)) {
        return Err(RemoteError::invalid("That log cursor is invalid."));
    }
    let threads = service::<ThreadsState>(app)?;
    let page = threads
        .runtime()
        .map_err(from_ipc)?
        .messages(id, DETAIL_PAGE, before)
        .map_err(from_kal)?;
    let now = OffsetDateTime::now_utc();
    let more = u32::try_from(page.len()).is_ok_and(|n| n >= DETAIL_PAGE);
    Ok(LogPage {
        entries: page
            .into_iter()
            .map(|m| LogEntry {
                id: m.id,
                kind: "message".into(),
                text: match m.role {
                    MessageRole::User => format!("You: {}", m.content),
                    _ => m.content,
                },
                at: parse_time(&m.created_at).unwrap_or(now),
            })
            .collect(),
        more,
    })
}

/// Providers, their accounts (labels only) and models, and the workspaces, for the launch sheet.
fn launch_options(app: &AppHandle) -> Result<LaunchOptions, RemoteError> {
    let core = core(app)?;
    let threads = service::<ThreadsState>(app)?;
    threads.ensure_providers(Some(&core));
    let options = threads
        .runtime()
        .map_err(from_ipc)?
        .options()
        .map_err(from_kal)?;
    drop(threads);
    let mut accounts: HashMap<String, Vec<LaunchAccount>> = HashMap::new();
    for account in kalcode_providers::accounts::AccountStore::new(core.clone())
        .list(None)
        .map_err(from_kal)?
    {
        accounts
            .entry(account.provider_id.as_str().to_owned())
            .or_default()
            .push(LaunchAccount {
                id: account.id,
                label: account.display_name,
            });
    }
    let providers = options
        .providers
        .into_iter()
        .map(|provider| {
            let id = provider.id.as_str().to_owned();
            let efforts: Vec<String> = EFFORT_CANDIDATES
                .into_iter()
                .filter(|effort| {
                    crate::provider_pane_commands::pane_effort(&id, Some((*effort).to_owned()))
                        .is_ok_and(|e| e.is_some())
                })
                .map(str::to_owned)
                .collect();
            LaunchProvider {
                accounts: accounts.remove(&id).unwrap_or_default(),
                models: provider
                    .models
                    .into_iter()
                    .map(|model| LaunchModel {
                        id: model.id,
                        name: model.display_name,
                        efforts: efforts.clone(),
                    })
                    .collect(),
                name: provider.display_name,
                id,
            }
        })
        .collect();
    Ok(LaunchOptions {
        workspaces: workspaces(&core)?,
        providers,
    })
}

pub fn workspaces(core: &kalcode_core::Core) -> Result<Vec<RemoteWorkspace>, RemoteError> {
    Ok(core
        .workspaces()
        .map_err(from_kal)?
        .into_iter()
        .filter(|w| w.available)
        .map(|w| RemoteWorkspace {
            last_active_at: parse_time(&w.last_opened_at),
            id: w.id,
            name: w.name,
            path: w.root_path,
        })
        .collect())
}

/// Approve once or Deny, as the user, audited as coming from this device. An approval that was
/// already answered (here, on the desktop or by expiry) is `already_answered`, never re-applied.
fn decide(
    app: &AppHandle,
    device: &Device,
    approval_id: &str,
    decision: Decision,
) -> Result<ops::DecideResult, RemoteError> {
    let permissions = service::<PermissionState>(app)?;
    let service = permissions
        .service()
        .ok_or_else(|| RemoteError::unavailable("Approvals aren't available right now."))?;
    let decision = match decision {
        Decision::ApproveOnce => ApprovalDecision::ApproveOnce,
        Decision::Deny => ApprovalDecision::Deny,
    };
    let via = ActionOrigin::Remote {
        host_id: device.id.clone(),
    };
    let outcome = service
        .decide_from(approval_id, decision, Actor::User, Some(&via))
        .map(|view| view.status);
    Ok(ops::DecideResult {
        status: decided(outcome)?.into(),
    })
}

/// The §8 `needs.decide` status of the permission engine's answer.
pub fn decided(outcome: Result<ApprovalStatus, KalError>) -> Result<&'static str, RemoteError> {
    match outcome {
        Ok(ApprovalStatus::Denied) => Ok("denied"),
        Ok(_) => Ok("approved"),
        Err(e) if e.code == "approval_already_decided" || e.code == "approval_expired" => {
            Ok("already_answered")
        }
        Err(e) if e.code == "approval_not_found" || e.code.starts_with("invalid") => Err(
            RemoteError::not_found("That approval request doesn't exist."),
        ),
        Err(e) if e.code == "decision_not_allowed" => Err(RemoteError::refused(e.message)),
        Err(e) => Err(from_kal(e)),
    }
}

/// The device's transcript through the KalVoice pipeline, with the agent it is looking at (if
/// any) as the focused thread. What the desktop window would show is done natively instead:
/// a prompt is sent, launched agents appear, idle agents close.
fn voice_command(
    app: &AppHandle,
    text: &str,
    agent_id: Option<&str>,
) -> Result<VoiceResult, RemoteError> {
    let text = text.trim();
    if text.is_empty() {
        return Err(RemoteError::invalid("Say a command."));
    }
    let thread = agent_id.map(|id| agent(app, id)).transpose()?;
    let workspace_id = match &thread {
        Some(thread) => Some(thread.workspace_id.clone()),
        None => core(app)?
            .active_workspace()
            .map_err(from_kal)?
            .map(|w| w.id),
    };
    let voice = service::<KalVoiceState>(app)?;
    let response = voice
        .remote_command(CommandRequest {
            request_id: new_id(),
            text: text.to_owned(),
            input: KalVoiceInput::Voice,
            workspace_id,
            thread_id: thread.map(|t| t.id),
        })
        .map_err(from_ipc)?;
    drop(voice);
    let result = |outcome: &str, summary: String| VoiceResult {
        summary,
        outcome: outcome.into(),
    };
    Ok(match response.outcome {
        KalVoiceOutcome::Completed { summary } => match response.directive {
            Some(UiDirective::ComposeInThread {
                thread_id,
                text,
                submit,
            }) => {
                let target = agent(app, &thread_id)?;
                match deliver_prompt(app, &target, &text, submit) {
                    Ok(()) => result("done", format!("Sent to {}.", target.name)),
                    Err(error) => result("refused", error.message),
                }
            }
            Some(UiDirective::CloseIdleAgents { .. }) => result("done", close_idle(app)?),
            directive => {
                tell_window(app, directive, Vec::new());
                result("done", summary)
            }
        },
        KalVoiceOutcome::Failed { code, message } => {
            let clarify = code.contains("ambiguous")
                || code.ends_with("_not_specified")
                || code == "prompt_missing";
            result(if clarify { "clarify" } else { "refused" }, message)
        }
        KalVoiceOutcome::PermissionRequired { .. } => result(
            "partial",
            "Waiting for your approval. Answer it in Needs You.".into(),
        ),
        KalVoiceOutcome::NeedsProvider { message } => result("refused", message),
        KalVoiceOutcome::LimitReached { .. } => result(
            "refused",
            "KalVoice's limit is reached for now. Try again later.".into(),
        ),
    })
}

fn run_detail(app: &AppHandle, id: &str) -> Result<RunDetail, RemoteError> {
    let operations = service::<OperationsState>(app)?;
    let detail = operations.detail(id).map_err(|e| {
        if e.code.ends_with("not_found") {
            RemoteError::not_found("That run no longer exists.")
        } else {
            from_kal(e)
        }
    })?;
    drop(operations);
    let core = core(app)?;
    let names: HashMap<String, String> = core
        .workspaces()
        .map_err(from_kal)?
        .into_iter()
        .map(|w| (w.id, w.name))
        .collect();
    let snapshot = kalcode_contracts::operations::OperationsSnapshot {
        revision: 0,
        paused: false,
        items: vec![detail.run],
        services: Vec::new(),
        environments: Vec::new(),
        activity: Vec::new(),
        observed_at: String::new(),
        warnings: Vec::new(),
    };
    let run = snapshot::operations(&snapshot, &names, OffsetDateTime::now_utc())
        .runs
        .pop()
        .ok_or_else(|| RemoteError::not_found("That run no longer exists."))?;
    let logs: Vec<String> = detail
        .logs
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect();
    let start = logs.len().saturating_sub(200);
    Ok(RunDetail {
        run,
        logs: logs[start..].to_vec(),
        tests: detail
            .tests
            .into_iter()
            .map(|t| TestResult {
                name: t.name,
                status: t.status,
                duration_ms: None,
            })
            .collect(),
    })
}

/// Unread "provider signed out" notices, for Needs You.
pub fn sign_outs(app: &AppHandle) -> Vec<snapshot::SignOut> {
    let Ok(notifications) = RuntimeState::<NotificationsState>::from_app(app) else {
        return Vec::new();
    };
    let state = app.state::<AppState>();
    let Ok(center) = notifications.get(&state) else {
        return Vec::new();
    };
    center
        .list(true, 100, None)
        .map(|page| {
            page.notifications
                .into_iter()
                .filter(|n| {
                    n.kind
                        == kalcode_contracts::notifications::NotificationKind::ProviderDisconnected
                        && n.read_at.is_none()
                })
                .map(|n| snapshot::SignOut {
                    id: n.id,
                    provider_id: n.entity_id.unwrap_or_default(),
                    title: n.title,
                    body: n.body,
                    updated_at: n.updated_at,
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use kalcode_remote::ops::{AgentRef, LaunchArgs, PromptArgs};
    use kalcode_remote::wire::ErrorCode;

    use super::*;

    fn agent_ref() -> AgentRef {
        AgentRef {
            agent_id: "0192f3c4-0000-7000-8000-00000000000b".into(),
        }
    }

    #[test]
    fn agent_actions_map_to_their_kalvoice_intents() {
        let thread = ThreadScope::Thread {
            thread_id: "0192f3c4-0000-7000-8000-00000000000b".into(),
        };
        assert_eq!(
            intent_of(&Op::AgentStop(agent_ref())).expect("stop"),
            KalVoiceIntent::StopThreads {
                scope: thread.clone(),
                expected_count: Some(1)
            }
        );
        assert_eq!(
            intent_of(&Op::AgentRetry(agent_ref())).expect("retry"),
            KalVoiceIntent::ResumeThreads { scope: thread }
        );
        // The prompt goes to the agent the request focuses, never to a name lookup.
        assert_eq!(
            intent_of(&Op::AgentPrompt(PromptArgs {
                agent_id: agent_ref().agent_id,
                text: "run the tests".into()
            }))
            .expect("prompt"),
            KalVoiceIntent::DirectPrompt {
                target: "it".into(),
                prompt: "run the tests".into()
            }
        );
        assert_eq!(
            intent_of(&Op::AgentLaunch(LaunchArgs {
                workspace_id: "w".into(),
                provider_id: " codex ".into(),
                account_id: Some("0192f3c4-0000-7000-8000-0000000000aa".into()),
                model: Some(" ".into()),
                effort: Some("high".into()),
                prompt: Some("  Fix the flaky test ".into()),
            }))
            .expect("launch"),
            KalVoiceIntent::CreateThreads {
                provider_id: ProviderId::new("codex"),
                count: 1,
                workspace_id: Some("w".into()),
                account_query: Some("0192f3c4-0000-7000-8000-0000000000aa".into()),
                model: None,
                effort: Some("high".into()),
                assignments: vec![AgentLaunchAssignment {
                    count: 1,
                    task: "Fix the flaky test".into()
                }],
            }
        );
        assert_eq!(
            intent_of(&Op::TidyCloseIdle).expect("tidy"),
            KalVoiceIntent::CloseIdleAgents { provider_id: None }
        );
        assert!(intent_of(&Op::LaunchOptions).is_err());
    }

    #[test]
    fn an_answered_approval_is_reported_never_reapplied() {
        use kalcode_core::ErrorCategory;
        let err = |code: &'static str| KalError::new(ErrorCategory::Permission, code, "x");
        assert_eq!(
            decided(Ok(ApprovalStatus::Approved)).expect("ok"),
            "approved"
        );
        assert_eq!(decided(Ok(ApprovalStatus::Denied)).expect("ok"), "denied");
        for code in ["approval_already_decided", "approval_expired"] {
            assert_eq!(
                decided(Err(err(code))).expect("answered"),
                "already_answered"
            );
        }
        assert_eq!(
            decided(Err(err("approval_not_found")))
                .expect_err("gone")
                .code,
            ErrorCode::NotFound
        );
        assert_eq!(
            decided(Err(err("decision_not_allowed")))
                .expect_err("deny only")
                .code,
            ErrorCode::Refused
        );
    }

    #[test]
    fn refusals_keep_their_meaning() {
        assert_eq!(
            failure("thread_not_found", "gone".into()).code,
            ErrorCode::NotFound
        );
        assert_eq!(
            failure("request_in_progress", "busy".into()).code,
            ErrorCode::Conflict
        );
        assert_eq!(
            failure("permission_pending", "Answer its approval first.".into()).code,
            ErrorCode::Refused
        );
    }

    #[test]
    fn prompts_lose_terminal_controls_but_keep_lines() {
        assert_eq!(
            prompt_text("  fix it\r\n\u{1b}[31mnow\tplease\u{7} ").expect("clean"),
            "fix it\n[31mnow\tplease"
        );
        assert_eq!(
            prompt_text(" \u{1b} ").expect_err("empty").code,
            ErrorCode::Invalid
        );
        assert_eq!(
            prompt_text(&"x".repeat(MAX_PROMPT_CHARS + 1))
                .expect_err("long")
                .code,
            ErrorCode::Invalid
        );
    }

    #[test]
    fn only_idle_coding_agents_are_closed() {
        let thread = |status: &str, kind: &str, activity: Option<&str>| -> ThreadSummary {
            serde_json::from_value(serde_json::json!({
                "id": "t", "name": "n", "providerId": "codex", "providerName": "Codex",
                "model": null, "accountLabel": null, "workspaceId": "w", "workspaceName": "W",
                "permissionMode": "bypass", "status": status, "currentActivity": activity,
                "createdAt": "2026-10-06T11:00:00Z", "lastActivityAt": "2026-10-06T11:00:00Z",
                "pendingApprovals": 0, "unreadMessages": 0, "filesChanged": null, "branch": null,
                "error": null, "runtimeKind": kind,
            }))
            .expect("thread")
        };
        assert!(idle_closable(&thread("idle", "interactive_pty", None)));
        assert!(idle_closable(&thread(
            "idle",
            "interactive_pty",
            Some("Ready for a task")
        )));
        assert!(!idle_closable(&thread(
            "idle",
            "interactive_pty",
            Some("Last turn failed")
        )));
        assert!(!idle_closable(&thread("idle", "headless", None)));
        assert!(!idle_closable(&thread("thinking", "interactive_pty", None)));
        assert!(!idle_closable(&thread("paused", "interactive_pty", None)));
    }
}
