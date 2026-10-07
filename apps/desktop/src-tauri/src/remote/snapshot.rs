//! The canonical state a paired device mirrors (§4.1), projected from the same sources every
//! desktop surface reads: the thread runtime's agents with the shared `AgentState` model, the
//! permission engine's pending approvals, the notification center's provider sign-outs and the
//! Operations snapshot. Pure functions over those inputs, so the mapping is unit-tested.

use std::collections::{HashMap, HashSet};

use kalcode_contracts::agent_state::AgentState as DeskState;
use kalcode_contracts::operations::OperationsSnapshot;
use kalcode_contracts::threads::{ThreadRuntimeKind, ThreadStatus, ThreadSummary};
use kalcode_remote::wire::{
    AgentRuntime, AgentState, NeedsYouAction, NeedsYouItem, NeedsYouKind, RemoteAgent,
    RemoteEnvironment, RemoteRun, RemoteService, RemoteState, RemoteWorkspace, Workstation,
};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

/// An agent marked working that has shown no activity for this long is worth a look
/// (`STALLED_AFTER_MS` in the desktop's `shell/attention/model.ts`).
pub const STALLED_AFTER_SECS: i64 = 20 * 60;
/// Failures and finished work stay in Needs You this long (`REVIEW_WINDOW_MS`).
pub const REVIEW_WINDOW_SECS: i64 = 24 * 60 * 60;
/// Runs listed on the device (newest Operations items first).
const MAX_RUNS: usize = 50;

/// A pending approval, reduced to what Needs You shows and offers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingApproval {
    pub id: String,
    /// Empty for approvals that no thread owns (KalVoice, a utility).
    pub thread_id: String,
    pub summary: String,
    pub requested_at: String,
    /// The request may be approved once (otherwise it can only be denied).
    pub approvable: bool,
}

/// An unread "provider signed out" notice.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignOut {
    pub id: String,
    pub provider_id: String,
    pub title: String,
    pub body: String,
    pub updated_at: String,
}

/// Everything the projection reads, already fetched.
pub struct Inputs {
    pub workstation: Workstation,
    pub workspaces: Vec<RemoteWorkspace>,
    /// Open (not archived) threads, runtime kind stamped.
    pub threads: Vec<ThreadSummary>,
    pub approvals: Vec<PendingApproval>,
    pub sign_outs: Vec<SignOut>,
    pub operations: Operations,
    pub now: OffsetDateTime,
}

/// The Operations part of the state; refreshed on its own cadence.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Operations {
    pub runs: Vec<RemoteRun>,
    pub services: Vec<RemoteService>,
    pub environments: Vec<RemoteEnvironment>,
}

pub fn build(inputs: Inputs) -> RemoteState {
    let needs_you = needs_you(
        &inputs.threads,
        &inputs.approvals,
        &inputs.sign_outs,
        inputs.now,
    );
    let mut agents: Vec<RemoteAgent> = inputs
        .threads
        .iter()
        .map(|thread| agent(thread, inputs.now))
        .collect();
    agents.sort_by(|a, b| {
        b.last_activity_at
            .cmp(&a.last_activity_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    RemoteState {
        workstation: inputs.workstation,
        workspaces: inputs.workspaces,
        agents,
        needs_you,
        runs: inputs.operations.runs,
        services: inputs.operations.services,
        environments: inputs.operations.environments,
    }
}

pub fn parse_time(text: &str) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(text, &Rfc3339).ok()
}

/// A thread as a device shows it. The state is the desktop's one provider-agnostic projection.
pub fn agent(thread: &ThreadSummary, now: OffsetDateTime) -> RemoteAgent {
    let state = DeskState::of(
        thread.status,
        thread.current_activity.as_deref(),
        thread.pending_approvals,
    );
    let created_at = parse_time(&thread.created_at).unwrap_or(now);
    RemoteAgent {
        id: thread.id.clone(),
        name: thread.name.clone(),
        workspace_id: thread.workspace_id.clone(),
        workspace_name: thread.workspace_name.clone(),
        provider_id: thread.provider_id.as_str().to_owned(),
        provider_name: thread.provider_name.clone(),
        account_label: thread.account_label.clone(),
        model: thread.model.clone(),
        effort: thread.effort.clone(),
        state: wire_state(state),
        status: snake(&thread.status),
        activity: thread
            .current_activity
            .as_deref()
            .map(str::trim)
            .filter(|a| !a.is_empty())
            .map(str::to_owned),
        branch: thread.branch.clone(),
        worktree: thread.worktree_id.is_some(),
        files_changed: thread.files_changed.unwrap_or(0),
        pending_approvals: thread.pending_approvals,
        error: thread.error.as_ref().map(|e| e.message.clone()),
        created_at,
        last_activity_at: parse_time(&thread.last_activity_at).unwrap_or(created_at),
        runtime: if thread.runtime_kind == Some(ThreadRuntimeKind::InteractivePty) {
            AgentRuntime::Pane
        } else {
            AgentRuntime::Headless
        },
    }
}

pub fn wire_state(state: DeskState) -> AgentState {
    match state {
        DeskState::Starting => AgentState::Starting,
        DeskState::Ready => AgentState::Ready,
        DeskState::Working => AgentState::Working,
        DeskState::Testing => AgentState::Testing,
        DeskState::Waiting => AgentState::Waiting,
        DeskState::NeedsYou => AgentState::NeedsYou,
        DeskState::Idle => AgentState::Idle,
        DeskState::Done => AgentState::Done,
        DeskState::Failed => AgentState::Failed,
        DeskState::Stopped => AgentState::Stopped,
    }
}

/// The snake_case wire name of a serde enum value (`running_command`).
pub fn snake<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

/// "Codex · Billing Fix": the provider, then the agent's own name (`sourceOf` on the desktop).
fn source_of(thread: &ThreadSummary) -> String {
    let name = thread.name.trim();
    if name.is_empty() || name == thread.provider_name {
        thread.provider_name.clone()
    } else {
        format!("{} · {name}", thread.provider_name)
    }
}

fn minutes(secs: i64) -> String {
    let m = (secs + 30).div_euclid(60).max(1);
    if m < 60 {
        format!("{m} min")
    } else if m % 60 == 0 {
        format!("{} h", m / 60)
    } else {
        format!("{} h {} min", m / 60, m % 60)
    }
}

/// Needs You, mirroring the desktop's `attentionItems()`: pending approvals (answerable from the
/// device: Approve once / Deny), agents that need the person (asked a question, or waiting on a
/// permission prompt only the desktop can answer), failures and finished work within a day,
/// agents stalled for 20 minutes and providers that signed out. Ids are `<kind>:<source id>`;
/// most urgent first, newest first within a kind.
pub fn needs_you(
    threads: &[ThreadSummary],
    approvals: &[PendingApproval],
    sign_outs: &[SignOut],
    now: OffsetDateTime,
) -> Vec<NeedsYouItem> {
    let by_id: HashMap<&str, &ThreadSummary> = threads.iter().map(|t| (t.id.as_str(), t)).collect();
    let answered_here: HashSet<&str> = approvals.iter().map(|a| a.thread_id.as_str()).collect();
    let mut items: Vec<(u8, NeedsYouItem)> = Vec::new();
    let item = |id: String,
                kind: NeedsYouKind,
                title: String,
                detail: String,
                agent_id: Option<String>,
                created_at: OffsetDateTime,
                actions: Vec<NeedsYouAction>| NeedsYouItem {
        id,
        kind,
        title,
        detail,
        agent_id,
        approval_id: None,
        created_at,
        actions,
    };

    for approval in approvals {
        let thread = by_id.get(approval.thread_id.as_str()).copied();
        let who = thread.map_or_else(|| "An action".to_owned(), source_of);
        let place = thread
            .map(|t| t.workspace_name.trim())
            .filter(|w| !w.is_empty())
            .map(|w| format!(" in {w}"))
            .unwrap_or_default();
        let mut actions = Vec::new();
        if approval.approvable {
            actions.push(NeedsYouAction::ApproveOnce);
        }
        actions.push(NeedsYouAction::Deny);
        actions.push(NeedsYouAction::Open);
        let summary = approval.summary.trim();
        let mut entry = item(
            format!("approval:{}", approval.id),
            NeedsYouKind::Approval,
            if summary.is_empty() {
                "Waiting for your decision".into()
            } else {
                summary.to_owned()
            },
            format!("{who} is waiting for your decision{place}."),
            thread.map(|t| t.id.clone()),
            parse_time(&approval.requested_at).unwrap_or(now),
            actions,
        );
        entry.approval_id = Some(approval.id.clone());
        items.push((50, entry));
    }

    for thread in threads {
        let state = DeskState::of(
            thread.status,
            thread.current_activity.as_deref(),
            thread.pending_approvals,
        );
        let at = parse_time(&thread.last_activity_at).unwrap_or(now);
        let quiet = (now - at).whole_seconds();
        let why = thread
            .current_activity
            .as_deref()
            .map(str::trim)
            .filter(|a| !a.is_empty());
        let source = source_of(thread);
        let agent = Some(thread.id.clone());
        let open = vec![NeedsYouAction::Open];
        match state {
            DeskState::NeedsYou => {
                if thread.pending_approvals > 0
                    || thread.status == ThreadStatus::WaitingForPermission
                {
                    // Its approval is listed above with Approve once / Deny.
                    if answered_here.contains(thread.id.as_str()) {
                        continue;
                    }
                    // A provider's own permission prompt is answered in its terminal on the
                    // desktop; the device never types into it.
                    items.push((
                        50,
                        item(
                            format!("approval:{}", thread.id),
                            NeedsYouKind::Approval,
                            "Needs your permission".into(),
                            format!(
                                "{source}: {}",
                                why.unwrap_or("It can't continue until you allow or deny its next step on the desktop.")
                            ),
                            agent,
                            at,
                            open,
                        ),
                    ));
                } else {
                    items.push((
                        50,
                        item(
                            format!("question:{}", thread.id),
                            NeedsYouKind::Question,
                            "Asked you a question".into(),
                            format!(
                                "{source}: {}",
                                why.unwrap_or(
                                    "It's waiting for your reply before it can continue."
                                )
                            ),
                            agent,
                            at,
                            open,
                        ),
                    ));
                }
            }
            DeskState::Failed if quiet <= REVIEW_WINDOW_SECS => items.push((
                40,
                item(
                    format!("failed:{}", thread.id),
                    NeedsYouKind::Failed,
                    if thread.status == ThreadStatus::Failed {
                        "Failed".into()
                    } else {
                        "Last turn failed".into()
                    },
                    format!(
                        "{source}: {}",
                        thread
                            .error
                            .as_ref()
                            .map(|e| e.message.trim())
                            .filter(|m| !m.is_empty())
                            .unwrap_or(
                                "Its last run ended with an error. Open it to see what happened."
                            )
                    ),
                    agent,
                    at,
                    open,
                ),
            )),
            DeskState::Working | DeskState::Testing
                if parse_time(&thread.last_activity_at).is_some()
                    && quiet >= STALLED_AFTER_SECS =>
            {
                items.push((
                    20,
                    item(
                        format!("stalled:{}", thread.id),
                        NeedsYouKind::Stalled,
                        format!("No activity for {}", minutes(quiet)),
                        format!(
                            "{source}: still marked working, but nothing has happened since. It may be stuck on a long command or waiting on something."
                        ),
                        agent,
                        at,
                        open,
                    ),
                ));
            }
            DeskState::Done
                if thread.files_changed.unwrap_or(0) > 0 && quiet <= REVIEW_WINDOW_SECS =>
            {
                let files = thread.files_changed.unwrap_or(0);
                items.push((
                    10,
                    item(
                        format!("review:{}", thread.id),
                        NeedsYouKind::Review,
                        format!(
                            "Finished · {files} {} changed",
                            if files == 1 { "file" } else { "files" }
                        ),
                        match &thread.branch {
                            Some(branch) => {
                                format!(
                                    "{source}: its work on {branch} is ready for you to review."
                                )
                            }
                            None => format!("{source}: its changes are ready for you to review."),
                        },
                        agent,
                        at,
                        open,
                    ),
                ));
            }
            _ => {}
        }
    }

    // A provider that signed out blocks every agent that uses it. Newest notice per provider.
    let mut providers = HashSet::new();
    let mut sign_outs: Vec<&SignOut> = sign_outs.iter().collect();
    sign_outs.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    for notice in sign_outs {
        if !providers.insert(notice.provider_id.as_str()) {
            continue;
        }
        let source = notice
            .title
            .strip_suffix(" is signed out")
            .filter(|s| !s.is_empty())
            .unwrap_or("Provider");
        items.push((
            60,
            item(
                format!("auth:{}", notice.id),
                NeedsYouKind::Auth,
                format!("{source} signed out"),
                notice.body.clone(),
                None,
                parse_time(&notice.updated_at).unwrap_or(now),
                vec![NeedsYouAction::Open],
            ),
        ));
    }

    items.sort_by(|(ra, a), (rb, b)| {
        rb.cmp(ra)
            .then_with(|| b.created_at.cmp(&a.created_at))
            .then_with(|| a.id.cmp(&b.id))
    });
    items.into_iter().map(|(_, item)| item).collect()
}

/// Runs, services and environments from the Operations snapshot. Labels and states only:
/// commands, prompts and environment variables never leave the desktop.
pub fn operations(
    snapshot: &OperationsSnapshot,
    workspace_names: &HashMap<String, String>,
    now: OffsetDateTime,
) -> Operations {
    let runs = snapshot
        .items
        .iter()
        .take(MAX_RUNS)
        .map(|run| RemoteRun {
            id: run.id.clone(),
            title: run.spec.name.clone(),
            kind: snake(&run.spec.kind),
            status: snake(&run.status),
            agent_id: run.thread_id.clone(),
            branch: run.branch.clone(),
            current_action: run.current_action.clone(),
            outcome: run.outcome.clone(),
            updated_at: [&run.ended_at, &run.started_at]
                .into_iter()
                .flatten()
                .find_map(|t| parse_time(t))
                .or_else(|| parse_time(&run.created_at))
                .unwrap_or(now),
        })
        .collect();
    let services = snapshot
        .services
        .iter()
        .map(|service| RemoteService {
            id: service.id.clone(),
            name: service.name.clone(),
            status: service.status.clone(),
            url: service.urls.first().cloned(),
        })
        .collect();
    let environments = snapshot
        .environments
        .iter()
        .map(|env| {
            let kind = snake(&env.kind);
            let label = capitalized(&kind);
            RemoteEnvironment {
                id: format!("{}:{kind}", env.workspace_id),
                name: match workspace_names.get(&env.workspace_id) {
                    Some(workspace) => format!("{label} · {workspace}"),
                    None => label,
                },
                kind,
                deployment_status: env.deployment_status.clone(),
                health: Some(env.health.clone()).filter(|h| !h.is_empty()),
                url: env.urls.first().cloned(),
                last_deploy_at: env.last_deploy.as_deref().and_then(parse_time),
            }
        })
        .collect();
    Operations {
        runs,
        services,
        environments,
    }
}

fn capitalized(word: &str) -> String {
    let mut chars = word.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const NOW: &str = "2026-10-06T12:00:00Z";

    fn now() -> OffsetDateTime {
        parse_time(NOW).expect("now")
    }

    fn thread(id: &str, status: &str, extra: serde_json::Value) -> ThreadSummary {
        let mut value = json!({
            "id": id,
            "name": "Fix login redirect",
            "providerId": "claude-code",
            "providerName": "Claude Code",
            "model": "claude-opus-5-5",
            "effort": "high",
            "accountLabel": "Work",
            "workspaceId": "wsp-1",
            "workspaceName": "KalCode",
            "permissionMode": "bypass",
            "status": status,
            "currentActivity": null,
            "createdAt": "2026-10-06T11:00:00Z",
            "lastActivityAt": "2026-10-06T11:59:00Z",
            "pendingApprovals": 0,
            "unreadMessages": 0,
            "filesChanged": null,
            "branch": null,
            "error": null,
            "runtimeKind": "interactive_pty",
        });
        if let (Some(base), Some(extra)) = (value.as_object_mut(), extra.as_object()) {
            for (k, v) in extra {
                base.insert(k.clone(), v.clone());
            }
        }
        serde_json::from_value(value).expect("thread summary")
    }

    #[test]
    fn a_thread_maps_to_an_agent_with_the_shared_state() {
        let t = thread(
            "t1",
            "running_command",
            json!({"currentActivity": " Running npm test ", "filesChanged": 4,
                   "branch": "kal/fix-login", "worktreeId": "wt-1"}),
        );
        let a = agent(&t, now());
        assert_eq!(a.state, AgentState::Working);
        assert_eq!(a.status, "running_command");
        assert_eq!(a.activity.as_deref(), Some("Running npm test"));
        assert_eq!(a.files_changed, 4);
        assert!(a.worktree);
        assert_eq!(a.runtime, AgentRuntime::Pane);
        assert_eq!(a.provider_id, "claude-code");
        assert_eq!(a.account_label.as_deref(), Some("Work"));
        assert_eq!(
            a.last_activity_at,
            parse_time("2026-10-06T11:59:00Z").expect("t")
        );

        // A pending approval wins over the running status; a headless thread says so.
        let waiting = agent(
            &thread(
                "t2",
                "running_tool",
                json!({"pendingApprovals": 1, "runtimeKind": "headless"}),
            ),
            now(),
        );
        assert_eq!(waiting.state, AgentState::NeedsYou);
        assert_eq!(waiting.runtime, AgentRuntime::Headless);
        // The idle markers of the shared model: ready, and a failed last turn.
        let ready = thread("t3", "idle", json!({"currentActivity": "Ready for a task"}));
        assert_eq!(agent(&ready, now()).state, AgentState::Ready);
        let failed_turn = thread("t4", "idle", json!({"currentActivity": "Last turn failed"}));
        assert_eq!(agent(&failed_turn, now()).state, AgentState::Failed);
        assert_eq!(
            agent(&thread("t5", "interrupted", json!({})), now()).state,
            AgentState::Stopped
        );
    }

    #[test]
    fn needs_you_mirrors_the_desktop_inbox() {
        let threads = vec![
            // Covered by its pending approval: no separate agent item.
            thread(
                "a-approval",
                "waiting_for_permission",
                json!({"pendingApprovals": 1}),
            ),
            // A provider's own prompt: open only.
            thread("a-pane-prompt", "waiting_for_permission", json!({})),
            thread(
                "a-question",
                "waiting_for_user",
                json!({"currentActivity": "Which database?"}),
            ),
            thread(
                "a-failed",
                "failed",
                json!({"error": {"code": "x", "message": "Exited with 1"}}),
            ),
            thread(
                "a-old-failure",
                "failed",
                json!({"lastActivityAt": "2026-10-04T11:00:00Z"}),
            ),
            thread(
                "a-stalled",
                "thinking",
                json!({"lastActivityAt": "2026-10-06T11:15:00Z"}),
            ),
            thread("a-working", "thinking", json!({})),
            thread(
                "a-review",
                "completed",
                json!({"filesChanged": 2, "branch": "kal/x"}),
            ),
            thread("a-done-nothing", "completed", json!({"filesChanged": 0})),
            thread("a-idle", "idle", json!({})),
        ];
        let approvals = vec![
            PendingApproval {
                id: "apr-1".into(),
                thread_id: "a-approval".into(),
                summary: "Run cargo test".into(),
                requested_at: "2026-10-06T11:59:30Z".into(),
                approvable: true,
            },
            PendingApproval {
                id: "apr-2".into(),
                thread_id: String::new(),
                summary: "Delete build/".into(),
                requested_at: "2026-10-06T11:50:00Z".into(),
                approvable: false,
            },
        ];
        let sign_outs = vec![
            SignOut {
                id: "n-old".into(),
                provider_id: "codex".into(),
                title: "Codex is signed out".into(),
                body: "Sign in again to keep using Codex.".into(),
                updated_at: "2026-10-06T10:00:00Z".into(),
            },
            SignOut {
                id: "n-new".into(),
                provider_id: "codex".into(),
                title: "Codex is signed out".into(),
                body: "Sign in again to keep using Codex.".into(),
                updated_at: "2026-10-06T11:00:00Z".into(),
            },
        ];
        let items = needs_you(&threads, &approvals, &sign_outs, now());
        let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "auth:n-new",
                "approval:apr-1",
                "approval:a-pane-prompt",
                "question:a-question",
                "approval:apr-2",
                "failed:a-failed",
                "stalled:a-stalled",
                "review:a-review",
            ]
        );
        let approve = &items[1];
        assert_eq!(approve.kind, NeedsYouKind::Approval);
        assert_eq!(approve.approval_id.as_deref(), Some("apr-1"));
        assert_eq!(approve.agent_id.as_deref(), Some("a-approval"));
        assert_eq!(
            approve.actions,
            [
                NeedsYouAction::ApproveOnce,
                NeedsYouAction::Deny,
                NeedsYouAction::Open
            ]
        );
        assert_eq!(approve.title, "Run cargo test");
        assert!(
            approve.detail.contains("Claude Code · Fix login redirect")
                && approve.detail.contains("in KalCode")
        );
        // A provider prompt is never answered from the device.
        assert_eq!(items[2].actions, [NeedsYouAction::Open]);
        assert_eq!(items[2].approval_id, None);
        // Deny-only requests never offer Approve once.
        assert_eq!(
            items[4].actions,
            [NeedsYouAction::Deny, NeedsYouAction::Open]
        );
        assert!(items[3].detail.ends_with("Which database?"));
        assert!(items[5].detail.ends_with("Exited with 1"));
        assert_eq!(items[6].title, "No activity for 45 min");
        assert_eq!(items[7].title, "Finished · 2 files changed");
        assert_eq!(items[0].title, "Codex signed out");
    }

    #[test]
    fn the_state_lists_agents_newest_first() {
        let state = build(Inputs {
            workstation: Workstation {
                id: "ws_1".into(),
                name: "Desk".into(),
                platform: "windows".into(),
                version: "0.1.9".into(),
                build: 2007,
                active_workspace_id: None,
            },
            workspaces: Vec::new(),
            threads: vec![
                thread(
                    "old",
                    "idle",
                    json!({"lastActivityAt": "2026-10-06T10:00:00Z"}),
                ),
                thread("new", "thinking", json!({})),
            ],
            approvals: Vec::new(),
            sign_outs: Vec::new(),
            operations: Operations::default(),
            now: now(),
        });
        let ids: Vec<&str> = state.agents.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, ["new", "old"]);
        assert!(state.needs_you.is_empty());
    }
}
