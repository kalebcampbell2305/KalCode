//! What KalVoice commands do in the desktop app: they call the same runtimes the rest of
//! KalCode uses — workspaces and terminals (Z1, `kalcode_core`), threads (Z3,
//! [`ThreadRuntime`]) and pending approvals (Z4, [`PermissionService`], read-only). KalVoice
//! never answers provider approvals. Ordinary app-control commands reach this executor directly;
//! the actual provider CLI retains its native execution permission experience.
//!
//! CA-1 intents: `focus` opens the thread (the UI shows it in its pane when it has one), and
//! `request_permission_mode` opens the thread so the person can change its mode themselves
//! (never Bypass: the contract can't represent it). `split`, `resize` and `close` are pane
//! layout commands (Z7-W1): they return a directive the pane canvas carries out; nothing starts,
//! stops or closes a process. `search` and `switch_provider` aren't in this build, so they're
//! refused before anything is counted.
//!
//! Z7-W3: `filter_dashboard` only changes what the Dashboard shows; its summary counts the
//! runtime's non-archived threads by Dashboard chip (`ThreadStatus::chip`).
//!
//! 0.1.5 switch accounts: `rebind_thread_account` only resolves the thread and account and asks
//! the person to confirm KalCode's Rebind dialog (`confirm_thread_rebind`); KalVoice never
//! rebinds a thread itself. `set_workspace_account` writes the workspace's default account
//! binding (metadata; starting a thread still needs that account signed in). `create_threads`
//! that names an account opens idle headless threads in Threads when provider panes are off.
//! A signed-out account is refused with a sign-in message, and an ambiguous name is answered
//! with a short question rather than a guess.

use std::sync::Arc;

use kalcode_contracts::agent::{AuthState, ProviderId};
use kalcode_contracts::app::SurfaceId;
use kalcode_contracts::kalvoice::{
    BrowserControl, KalVoiceIntent, PaneDirection, ProviderPaneRequest,
};
use kalcode_contracts::permissions::{ApprovalStatus, PermissionMode};
use kalcode_contracts::provider_accounts::{ProviderAccount, ProviderAccountBindingKind};
use kalcode_contracts::threads::ThreadSummary;
use kalcode_contracts::threads::WorkspaceOption;
use kalcode_contracts::workspace_ui::{DashboardChip, SplitAxis};
use kalcode_core::workspaces::TerminalSize;
use kalcode_core::{Core, KalError};
use kalcode_kalvoice::orchestrator::{
    ExecContext, ExecError, Executed, Executor, UiDirective, provider_display_name,
    requestable_mode_label,
};
use kalcode_permissions::PermissionService;
use kalcode_providers::accounts::AccountStore;
use kalcode_threads::{
    BulkOutcome, CoreWorkspaces, CreateIdleThread, ResolvedWorkspace, ThreadRuntime,
    WorkspaceResolver,
};

/// Size a terminal opened by voice starts at; the Code view resizes it when it attaches.
const VOICE_TERMINAL_SIZE: (u16, u16) = (120, 30);

pub struct DesktopExecutor {
    /// Surfaces this build shows (navigation to others is refused).
    pub visible: Vec<SurfaceId>,
    pub provider_panes_enabled: bool,
    pub core: Arc<Core>,
    /// `None` when the thread runtime didn't start (then thread commands explain why).
    pub threads: Option<Arc<ThreadRuntime>>,
    /// `None` when the permission engine didn't start.
    pub permissions: Option<Arc<PermissionService>>,
    /// The Session Locator (Z7-W2), for Search and for Focus by meaning. `None` when it didn't
    /// start.
    pub locator: Option<Arc<kalcode_locator::Locator>>,
}

fn from_core(error: &KalError) -> ExecError {
    ExecError::new(error.code, error.message.clone())
}

fn threads_unavailable() -> ExecError {
    ExecError::new(
        "threads_unavailable",
        "KalCode's thread runtime isn't running, so KalVoice can't manage threads. Restart KalCode; if this keeps happening, export diagnostics.",
    )
}

fn search_unavailable() -> ExecError {
    ExecError::new(
        "search_unavailable",
        "Search isn't available right now, so KalVoice can't look that up.",
    )
}

/// This computer's UTC offset in minutes (for "yesterday"); 0 if it can't be read.
fn local_offset_minutes() -> i32 {
    time::UtcOffset::current_local_offset().map_or(0, |o| i32::from(o.whole_minutes()))
}

/// A locator status as KalVoice says it (names and statuses only, never content).
fn spoken_status(status: &str) -> Option<&'static str> {
    Some(match status {
        "starting" => "starting",
        "working" | "testing" | "reviewing" | "recovering" => "working",
        "permission_required" => "needs your permission",
        "waiting_for_you" => "waiting for you",
        "idle" => "idle",
        "paused" => "paused",
        "done" => "done",
        "failed" => "failed",
        "running" => "running",
        "ended" => "ended",
        "missing" => "folder missing",
        _ => return None,
    })
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// What KalVoice says after filtering the Dashboard. `count` is the number of non-archived
/// threads under `chip` (and `total` all of them) when the thread runtime is available.
fn filter_summary(chip: DashboardChip, counts: Option<(usize, usize)>) -> String {
    let Some((count, total)) = counts else {
        return match chip {
            DashboardChip::All => "Showing every agent on the Dashboard.".into(),
            DashboardChip::Working => "Showing working agents on the Dashboard.".into(),
            DashboardChip::WaitingForYou => {
                "Showing what's waiting for you on the Dashboard.".into()
            }
            DashboardChip::Done => "Showing completed work on the Dashboard.".into(),
            DashboardChip::Idle => "Showing idle agents on the Dashboard.".into(),
        };
    };
    match chip {
        DashboardChip::All if total == 0 => "There are no agents yet.".into(),
        DashboardChip::All => format!("Showing all {}.", plural(total, "agent", "agents")),
        DashboardChip::Working if count == 0 => "No agents are working right now.".into(),
        DashboardChip::Working => format!(
            "Showing {count} working {}.",
            if count == 1 { "agent" } else { "agents" }
        ),
        DashboardChip::WaitingForYou if count == 0 => "Nothing is waiting for you.".into(),
        DashboardChip::WaitingForYou => format!(
            "{} waiting for you.",
            plural(count, "agent is", "agents are")
        ),
        DashboardChip::Done if count == 0 => "No threads have completed yet.".into(),
        DashboardChip::Done => format!(
            "Showing {count} completed {}.",
            if count == 1 { "thread" } else { "threads" }
        ),
        DashboardChip::Idle if count == 0 => "No agents are idle.".into(),
        DashboardChip::Idle => format!(
            "Showing {count} idle {}.",
            if count == 1 { "agent" } else { "agents" }
        ),
    }
}

/// "Paused 3 threads." / "Paused 2 of 3 threads. <first reason>" / "No threads were working…".
fn bulk_summary(
    verb: &str,
    past: &str,
    idle: &str,
    outcomes: &[BulkOutcome],
) -> Result<String, ExecError> {
    if outcomes.is_empty() {
        return Ok(idle.to_owned());
    }
    let ok = outcomes.iter().filter(|o| o.ok).count();
    let first_failure = outcomes
        .iter()
        .find(|o| !o.ok)
        .and_then(|o| o.message.clone())
        .unwrap_or_default();
    if ok == 0 {
        return Err(ExecError::new(
            "threads_failed",
            if first_failure.is_empty() {
                format!("KalVoice couldn't {verb} any threads.")
            } else {
                first_failure
            },
        ));
    }
    Ok(if ok == outcomes.len() {
        format!("{past} {}.", plural(ok, "thread", "threads"))
    } else {
        format!(
            "{past} {ok} of {}. {first_failure}",
            plural(outcomes.len(), "thread", "threads")
        )
        .trim_end()
        .to_owned()
    })
}

impl DesktopExecutor {
    fn threads(&self) -> Result<&Arc<ThreadRuntime>, ExecError> {
        self.threads.as_ref().ok_or_else(threads_unavailable)
    }

    fn workspace_resolver(&self) -> CoreWorkspaces {
        CoreWorkspaces::new(self.core.clone())
    }

    fn workspace(&self, id: &str) -> Result<ResolvedWorkspace, ExecError> {
        self.workspace_resolver()
            .resolve(id)
            .map_err(|error| from_core(&error))
    }

    /// The named workspace, or the active one.
    fn target_workspace(&self, id: Option<&str>) -> Result<ResolvedWorkspace, ExecError> {
        let id = match id {
            Some(id) => id.to_owned(),
            None => self
                .core
                .active_workspace()
                .map_err(|e| from_core(&e))?
                .map(|workspace| workspace.id)
                .ok_or_else(|| {
                    ExecError::new(
                        "no_workspace",
                        "Open a workspace first (Code, Open folder), or name one: “in the website workspace”.",
                    )
                })?,
        };
        self.workspace(&id)
    }

    fn prepare_provider_panes(
        &self,
        groups: &[ProviderPaneRequest],
        workspace_id: Option<&str>,
    ) -> Result<(ResolvedWorkspace, Vec<(u8, CreateIdleThread)>), ExecError> {
        if !self.provider_panes_enabled {
            return Err(ExecError::new(
                "provider_panes_unavailable",
                "Provider panes are unavailable in this build.",
            ));
        }
        let total: usize = groups.iter().map(|g| usize::from(g.count)).sum();
        if total == 0 || total > 16 || groups.iter().any(|g| g.count == 0) {
            return Err(ExecError::new(
                "invalid_thread_count",
                "Open between 1 and 16 provider sessions at a time.",
            ));
        }
        let runtime = self.threads()?;
        let workspace = self.target_workspace(workspace_id)?;
        let options = runtime.options().map_err(|e| from_core(&e))?;
        // Resolve every account before starting anything: an unknown label in a later group
        // must not silently start earlier groups under a different/default account.
        let mut requests = Vec::new();
        for group in groups {
            let provider = group.provider_id.as_ref().ok_or_else(|| {
                ExecError::new(
                    "provider_required",
                    "Choose Claude Code, Codex, or Gemini for these sessions.",
                )
            })?;
            if ![
                ProviderId::CLAUDE_CODE,
                ProviderId::CODEX,
                ProviderId::GEMINI_CLI,
            ]
            .contains(&provider.as_str())
            {
                return Err(ExecError::new(
                    "provider_pane_unsupported",
                    "That provider cannot run in a pane.",
                ));
            }
            let available = options
                .providers
                .iter()
                .find(|p| &p.id == provider)
                .ok_or_else(|| {
                    ExecError::new(
                        "provider_unavailable",
                        "That provider is not ready. Check Providers before opening sessions.",
                    )
                })?;
            let model = kalcode_threads::validate::model(group.model.as_deref())
                .map_err(|e| from_core(&e))?;
            if model.as_ref().is_some_and(|id| {
                !available.models.is_empty() && !available.models.iter().any(|m| &m.id == id)
            }) {
                return Err(ExecError::new(
                    "invalid_model",
                    "That model is not available for this provider.",
                ));
            }
            let account = crate::thread_commands::resolve_creation_account(
                &self.core,
                provider.as_str(),
                &workspace.id,
                None,
                group.account_query.as_deref(),
            )
            .map_err(|e| from_core(&e))?;
            requests.push((
                group.count,
                CreateIdleThread {
                    provider_id: provider.to_string(),
                    provider_account_id: account.as_ref().map(|a| a.id.clone()),
                    account_label: account.map(|a| a.display_name),
                    workspace_id: workspace.id.clone(),
                    model,
                    permission_mode: PermissionMode::Approve,
                    name: None,
                },
            ));
        }
        Ok((workspace, requests))
    }

    fn create_provider_panes(
        &self,
        groups: &[ProviderPaneRequest],
        workspace_id: Option<&str>,
    ) -> Result<Executed, ExecError> {
        let (workspace, requests) = self.prepare_provider_panes(groups, workspace_id)?;
        let runtime = self.threads()?;
        let total: usize = requests.iter().map(|(n, _)| usize::from(*n)).sum();
        let mut ids = Vec::new();
        let mut first_error = None;
        for (count, request) in requests {
            for _ in 0..count {
                match kalcode_providers::interactive::provider::RuntimeRouter::create_interactive(
                    || runtime.create_idle(request.clone()),
                ) {
                    Ok(thread) => ids.push(thread.id),
                    Err(error) => {
                        first_error.get_or_insert(error);
                    }
                }
            }
        }
        if ids.is_empty() {
            return Err(first_error.as_ref().map_or_else(
                || ExecError::new("threads_failed", "KalVoice could not open those sessions."),
                from_core,
            ));
        }
        let summary = if ids.len() == total {
            format!(
                "Opened {} in {}.",
                plural(ids.len(), "session", "sessions"),
                workspace.name
            )
        } else {
            format!(
                "Opened {} of {total} sessions in {}. {}",
                ids.len(),
                workspace.name,
                first_error
                    .as_ref()
                    .map(|e| e.message.as_str())
                    .unwrap_or_default()
            )
        };
        Ok(Executed {
            summary,
            directive: Some(UiDirective::OpenProviderPanes {
                workspace_id: workspace.id,
                thread_ids: ids,
            }),
        })
    }

    fn status_report(&self) -> Result<Executed, ExecError> {
        let summary = self
            .threads()?
            .status_summary()
            .map_err(|e| from_core(&e))?;
        let text = if summary.total == 0 {
            "No threads are open.".to_owned()
        } else {
            let mut parts = vec![format!("{} working", summary.working)];
            if summary.needs_attention > 0 {
                parts.push(format!("{} need you", summary.needs_attention));
            }
            if summary.pending_approvals > 0 {
                parts.push(plural(
                    summary.pending_approvals as usize,
                    "approval waiting",
                    "approvals waiting",
                ));
            }
            format!(
                "{}: {}.",
                plural(summary.total as usize, "thread", "threads"),
                parts.join(", ")
            )
        };
        Ok(Executed {
            summary: text,
            directive: None,
        })
    }
}

impl DesktopExecutor {
    /// The first open thread matching a spoken name — by name first, then by meaning through
    /// the Session Locator ("focus the auth thread" finds "Authentication Refactor") — or a
    /// user-safe "not found".
    fn named_thread(
        &self,
        query: &str,
    ) -> Result<kalcode_contracts::threads::ThreadSummary, ExecError> {
        let threads = self.threads()?;
        if let Some(found) = threads
            .find(query)
            .map_err(|e| from_core(&e))?
            .into_iter()
            .next()
        {
            return Ok(found);
        }
        let located = self.locator.as_ref().and_then(|locator| {
            locator
                .search(&kalcode_locator::LocatorQuery {
                    text: query.to_owned(),
                    kinds: vec![kalcode_locator::LocatorEntityKind::Thread],
                    tz_offset_minutes: local_offset_minutes(),
                    ..kalcode_locator::LocatorQuery::default()
                })
                .ok()
                .and_then(|r| r.results.items.into_iter().next())
        });
        if let Some(hit) = located
            && let Ok(thread) = threads.get(&hit.entity_id)
            && thread.archived_at.is_none()
        {
            return Ok(thread);
        }
        Err(ExecError::new(
            "thread_not_found",
            format!("KalCode has no open thread named \u{201c}{query}\u{201d}."),
        ))
    }

    /// Search by voice: names and statuses are read back, never content (LOC-04).
    fn search(&self, query: &str) -> Result<Executed, ExecError> {
        let locator = self.locator.as_ref().ok_or_else(search_unavailable)?;
        let response = locator
            .search(&kalcode_locator::LocatorQuery {
                text: query.to_owned(),
                tz_offset_minutes: local_offset_minutes(),
                ..kalcode_locator::LocatorQuery::default()
            })
            .map_err(|e| from_core(&e))?;
        // Things, not the activity log: "Added workspace · X" would repeat X.
        let items: Vec<&kalcode_locator::LocatorResult> = response
            .results
            .items
            .iter()
            .filter(|r| r.kind != kalcode_locator::LocatorEntityKind::Activity)
            .collect();
        let hidden = response.results.items.len() - items.len();
        let total = response
            .results
            .total_estimate
            .unwrap_or(response.results.items.len() as u64)
            .saturating_sub(hidden as u64);
        let named: Vec<String> = items
            .iter()
            .take(3)
            .map(|r| match r.status.as_deref().and_then(spoken_status) {
                Some(status) => format!("{} ({status})", r.title),
                None => r.title.clone(),
            })
            .collect();
        let summary = if named.is_empty() {
            format!("Nothing matched \u{201c}{query}\u{201d}.")
        } else {
            let more = total.saturating_sub(named.len() as u64);
            let list = named.join(", ");
            if more > 0 {
                format!("Found {total}: {list}, and {more} more.")
            } else {
                format!("Found {total}: {list}.")
            }
        };
        Ok(Executed {
            summary,
            directive: Some(UiDirective::Search {
                query: query.to_owned(),
            }),
        })
    }
}

/// Lowercase words of a spoken or typed label ("Gemini-B" and "gemini b" are the same).
fn label_words(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_owned)
        .collect()
}

/// `words` without a leading provider name ("gemini cli b" -> "b") or a trailing "account".
fn without_provider<'a>(words: &'a [String], provider: &ProviderId) -> &'a [String] {
    let aliases: &[&[&str]] = match provider.as_str() {
        ProviderId::CLAUDE_CODE => &[&["claude", "code"], &["claude"]],
        ProviderId::CODEX => &[&["codex"]],
        ProviderId::GEMINI_CLI => &[&["gemini", "cli"], &["gemini"]],
        _ => &[],
    };
    let mut rest = words;
    if let Some(alias) = aliases.iter().find(|alias| {
        rest.len() >= alias.len() && rest.iter().zip(alias.iter()).all(|(w, a)| w == a)
    }) {
        rest = &rest[alias.len()..];
    }
    if rest.last().is_some_and(|w| w == "account") {
        rest = &rest[..rest.len() - 1];
    }
    rest
}

/// The accounts a spoken name could mean, best match first: the exact label, the label without
/// its provider name ("Gemini B" for "b"), then labels containing every spoken word ("Codex
/// Work" for "work"). A name that is only the provider ("Gemini") matches all its accounts.
/// Never picks between equal matches.
fn matching_accounts<'a>(
    accounts: &'a [ProviderAccount],
    provider: &ProviderId,
    query: &str,
) -> Vec<&'a ProviderAccount> {
    let spoken = label_words(query);
    let spoken_rest = without_provider(&spoken, provider);
    if spoken_rest.is_empty() {
        return accounts.iter().collect();
    }
    let matches = |rank: u8, label: &[String]| match rank {
        0 => label == spoken.as_slice(),
        1 => without_provider(label, provider) == spoken_rest,
        _ => spoken_rest.iter().all(|w| label.contains(w)),
    };
    for rank in 0..3 {
        let found: Vec<&ProviderAccount> = accounts
            .iter()
            .filter(|a| matches(rank, &label_words(&a.display_name)))
            .collect();
        if !found.is_empty() {
            return found;
        }
    }
    Vec::new()
}

/// "Gemini A or Gemini B" / "A, B or C".
fn or_list(labels: &[&str]) -> String {
    match labels {
        [] => String::new(),
        [one] => (*one).to_owned(),
        [rest @ .., last] => format!("{} or {last}", rest.join(", ")),
    }
}

impl DesktopExecutor {
    /// The one account of `provider` a spoken name means, signed in or not yet checked. Asks
    /// which one when several match; never signs in or bypasses the provider's own auth.
    fn spoken_account(
        &self,
        provider: &ProviderId,
        query: &str,
    ) -> Result<ProviderAccount, ExecError> {
        let provider_name = provider_display_name(provider);
        let accounts = AccountStore::new(self.core.clone())
            .list(Some(provider.as_str()))
            .map_err(|e| from_core(&e))?;
        if accounts.is_empty() {
            return Err(ExecError::new(
                "provider_account_required",
                format!("Connect a {provider_name} account in Providers first."),
            ));
        }
        let found = matching_accounts(&accounts, provider, query);
        let account = match found.as_slice() {
            [] => {
                return Err(ExecError::new(
                    "provider_account_not_found",
                    format!(
                        "KalCode has no {provider_name} account called \u{201c}{}\u{201d}. Connect it in Providers, or say another account.",
                        query.trim()
                    ),
                ));
            }
            [one] => (*one).clone(),
            many => {
                let labels: Vec<&str> = many.iter().map(|a| a.display_name.as_str()).collect();
                return Err(ExecError::new(
                    "provider_account_ambiguous",
                    format!("Which account \u{2014} {}?", or_list(&labels)),
                ));
            }
        };
        if account.authentication_state == AuthState::NotAuthenticated {
            return Err(ExecError::new(
                "provider_account_signed_out",
                format!(
                    "{} isn't signed in. Sign in to it in Providers, then try again.",
                    account.display_name
                ),
            ));
        }
        Ok(account)
    }

    /// The thread a rebind means: the named one, else the one the person is looking at.
    fn rebind_thread(
        &self,
        thread_query: Option<&str>,
        focused: Option<&str>,
    ) -> Result<ThreadSummary, ExecError> {
        let runtime = self.threads()?;
        if let Some(query) = thread_query.map(str::trim).filter(|q| !q.is_empty()) {
            return self.named_thread(query);
        }
        let id = focused.ok_or_else(|| {
            ExecError::new(
                "thread_not_specified",
                "Open the thread first, or say which one, for example \u{201c}switch the login fix thread to Gemini B\u{201d}.",
            )
        })?;
        let thread = runtime.get(id).map_err(|e| from_core(&e))?;
        if thread.archived_at.is_some() {
            return Err(ExecError::new(
                "thread_archived",
                "That thread is archived. Restore it before switching its account.",
            ));
        }
        Ok(thread)
    }

    /// Resolves a rebind without changing anything. The Rebind dialog does the switch.
    fn prepare_rebind(
        &self,
        thread_query: Option<&str>,
        provider_hint: Option<&ProviderId>,
        account_query: &str,
        focused: Option<&str>,
    ) -> Result<(ThreadSummary, ProviderAccount), ExecError> {
        let thread = self.rebind_thread(thread_query, focused)?;
        if let Some(hint) = provider_hint
            && hint != &thread.provider_id
        {
            let provider_name = provider_display_name(&thread.provider_id);
            return Err(ExecError::new(
                "provider_account_mismatch",
                format!(
                    "\u{201c}{}\u{201d} is a {provider_name} thread, so it can only switch to another {provider_name} account.",
                    thread.name
                ),
            ));
        }
        let account = self.spoken_account(&thread.provider_id, account_query)?;
        Ok((thread, account))
    }

    fn prepare_workspace_account(
        &self,
        provider: &ProviderId,
        account_query: &str,
        workspace_id: Option<&str>,
    ) -> Result<(ResolvedWorkspace, ProviderAccount), ExecError> {
        let workspace = self.target_workspace(workspace_id)?;
        let account = self.spoken_account(provider, account_query)?;
        Ok((workspace, account))
    }

    /// Idle headless threads bound to a named account: the Threads-surface path, for builds
    /// without provider panes. Nothing starts until the person sends the thread a message.
    fn prepare_headless_threads(
        &self,
        provider: &ProviderId,
        count: u8,
        workspace_id: Option<&str>,
        account_query: &str,
    ) -> Result<(ResolvedWorkspace, CreateIdleThread), ExecError> {
        if count == 0 || count > 16 {
            return Err(ExecError::new(
                "invalid_thread_count",
                "Open between 1 and 16 threads at a time.",
            ));
        }
        let runtime = self.threads()?;
        let workspace = self.target_workspace(workspace_id)?;
        let options = runtime.options().map_err(|e| from_core(&e))?;
        if !options.providers.iter().any(|p| &p.id == provider) {
            return Err(ExecError::new(
                "provider_unavailable",
                "That provider is not ready. Check Providers before opening threads.",
            ));
        }
        let account = self.spoken_account(provider, account_query)?;
        let request = CreateIdleThread {
            provider_id: provider.to_string(),
            provider_account_id: Some(account.id),
            account_label: Some(account.display_name),
            workspace_id: workspace.id.clone(),
            model: None,
            permission_mode: PermissionMode::Approve,
            name: None,
        };
        Ok((workspace, request))
    }

    fn create_headless_threads(
        &self,
        provider: &ProviderId,
        count: u8,
        workspace_id: Option<&str>,
        account_query: &str,
    ) -> Result<Executed, ExecError> {
        let (workspace, request) =
            self.prepare_headless_threads(provider, count, workspace_id, account_query)?;
        let runtime = self.threads()?;
        let mut ids = Vec::new();
        let mut first_error = None;
        for _ in 0..count {
            match runtime.create_idle(request.clone()) {
                Ok(thread) => ids.push(thread.id),
                Err(error) => {
                    first_error.get_or_insert(error);
                }
            }
        }
        if ids.is_empty() {
            return Err(first_error.as_ref().map_or_else(
                || ExecError::new("threads_failed", "KalVoice could not open those threads."),
                from_core,
            ));
        }
        let provider_name = provider_display_name(provider);
        let label = request.account_label.unwrap_or_default();
        let summary = match &first_error {
            Some(error) if ids.len() < usize::from(count) => format!(
                "Opened {} of {count} {provider_name} threads in {} with {label}. {}",
                ids.len(),
                workspace.name,
                error.message
            ),
            _ if ids.len() == 1 => format!(
                "Opened a new {provider_name} thread in {} with {label}. Send it a message in Threads to start.",
                workspace.name
            ),
            _ => format!(
                "Opened {} {provider_name} threads in {} with {label}. Send each a message in Threads to start.",
                ids.len(),
                workspace.name
            ),
        };
        let directive = if ids.len() == 1 {
            UiDirective::OpenThread {
                thread_id: ids.remove(0),
            }
        } else {
            UiDirective::Navigate {
                surface: SurfaceId::Threads,
            }
        };
        Ok(Executed {
            summary,
            directive: Some(directive),
        })
    }
}

impl Executor for DesktopExecutor {
    fn workspace_options(&self) -> Result<Vec<WorkspaceOption>, ExecError> {
        let resolver = self.workspace_resolver();
        let listed = resolver.list().map_err(|error| from_core(&error))?;
        let mut options = Vec::with_capacity(listed.len());
        for listed_workspace in listed {
            // Listing filters records already known to be unavailable. Resolve again here so
            // stale folders and roots replaced by links never cross the local-model boundary.
            let workspace = match resolver.resolve(&listed_workspace.id) {
                Ok(workspace) => workspace,
                Err(error)
                    if matches!(error.code, "workspace_not_found" | "workspace_unavailable") =>
                {
                    continue;
                }
                Err(error) => return Err(from_core(&error)),
            };
            options.push(WorkspaceOption {
                id: workspace.id,
                name: workspace.name,
            });
        }
        Ok(options)
    }

    fn find_workspace(&self, name: &str) -> Result<Option<String>, ExecError> {
        let wanted = name.trim().to_lowercase();
        if wanted.is_empty() {
            return Ok(None);
        }
        let workspaces = self.workspace_options()?;
        // Rank exact names ahead of normalized names and partial matches, but never use
        // recency/order to break a genuinely ambiguous project identity.
        for rank in 0..3 {
            let mut matches = workspaces.iter().filter(|w| {
                let name = w.name.to_lowercase();
                match rank {
                    0 => name == wanted,
                    1 => name.replace(['-', '_', '.'], " ") == wanted,
                    _ => name.contains(&wanted),
                }
            });
            if let Some(first) = matches.next() {
                if matches.next().is_some() {
                    return Err(ExecError::new(
                        "workspace_ambiguous",
                        "I found more than one matching project. Select the workspace before continuing.",
                    ));
                }
                return Ok(Some(first.id.clone()));
            }
        }
        Ok(None)
    }

    fn find_thread(&self, name: &str) -> Result<Option<String>, ExecError> {
        Ok(self
            .threads()?
            .find(name)
            .map_err(|e| from_core(&e))?
            .into_iter()
            .next()
            .map(|t| t.id))
    }

    fn check(&self, intent: &KalVoiceIntent) -> Result<(), ExecError> {
        match intent {
            KalVoiceIntent::Navigate { surface } if !self.visible.contains(surface) => {
                Err(ExecError::new(
                    "surface_unavailable",
                    "That page isn't available in this build.",
                ))
            }
            KalVoiceIntent::CreateThreads {
                provider_id,
                count,
                workspace_id,
                account_query: Some(account_query),
            } if !self.provider_panes_enabled => self
                .prepare_headless_threads(
                    provider_id,
                    *count,
                    workspace_id.as_deref(),
                    account_query,
                )
                .map(|_| ()),
            KalVoiceIntent::CreateThreads {
                provider_id,
                count,
                workspace_id,
                account_query,
            } => self
                .prepare_provider_panes(
                    &[ProviderPaneRequest {
                        provider_id: Some(provider_id.clone()),
                        count: *count,
                        account_query: account_query.clone(),
                        model: None,
                    }],
                    workspace_id.as_deref(),
                )
                .map(|_| ()),
            KalVoiceIntent::CreateProviderPanes {
                groups,
                workspace_id,
            } => self
                .prepare_provider_panes(groups, workspace_id.as_deref())
                .map(|_| ()),
            KalVoiceIntent::ControlPane { workspace_id, .. } => {
                self.target_workspace(workspace_id.as_deref()).map(|_| ())
            }
            KalVoiceIntent::ControlBrowser { workspace_id, .. } => {
                self.target_workspace(workspace_id.as_deref()).map(|_| ())
            }
            KalVoiceIntent::OpenThread { .. }
            | KalVoiceIntent::Focus { .. }
            | KalVoiceIntent::PauseThreads { .. }
            | KalVoiceIntent::ResumeThreads { .. }
            | KalVoiceIntent::StopThreads { .. }
            | KalVoiceIntent::StatusReport => self.threads().map(|_| ()),
            KalVoiceIntent::RequestPermissionMode { thread_query, .. } => {
                self.threads()?;
                if thread_query.as_deref().is_none_or(|q| q.trim().is_empty()) {
                    return Err(ExecError::new(
                        "thread_not_specified",
                        "Say which thread, for example \u{201c}switch the login fix thread to plan mode\u{201d}.",
                    ));
                }
                Ok(())
            }
            KalVoiceIntent::Search { .. } if self.locator.is_none() => Err(search_unavailable()),
            KalVoiceIntent::SwitchProvider { .. } => Err(ExecError::new(
                "not_in_this_build",
                "Provider switching isn't in this build yet, so KalVoice can't do that.",
            )),
            // The focused thread is only known at execution; a named thread and a provider-led
            // account are checked now, so an unknown name is refused before anything counts.
            KalVoiceIntent::RebindThreadAccount {
                thread_query,
                provider_id,
                account_query,
            } => {
                self.threads()?;
                if let Some(query) = thread_query.as_deref().filter(|q| !q.trim().is_empty()) {
                    self.prepare_rebind(Some(query), provider_id.as_ref(), account_query, None)?;
                } else if let Some(provider) = provider_id {
                    self.spoken_account(provider, account_query)?;
                }
                Ok(())
            }
            KalVoiceIntent::SetWorkspaceAccount {
                provider_id,
                account_query,
                workspace_id,
            } => self
                .prepare_workspace_account(provider_id, account_query, workspace_id.as_deref())
                .map(|_| ()),
            KalVoiceIntent::ShowApprovals if self.permissions.is_none() => Err(ExecError::new(
                "approvals_unavailable",
                "KalCode's permission engine isn't running, so there's nothing KalVoice can show.",
            )),
            KalVoiceIntent::Reasoning { .. } => {
                Err(ExecError::new("not_a_command", "That isn't a command."))
            }
            _ => Ok(()),
        }
    }

    fn execute(&self, intent: &KalVoiceIntent, ctx: &ExecContext) -> Result<Executed, ExecError> {
        match intent {
            // Terminal-aware KalVoice contract only (TK-0); the voice lane replaces this refusal.
            KalVoiceIntent::SubmitFocused
            | KalVoiceIntent::ClearFocused
            | KalVoiceIntent::DirectPrompt { .. }
            | KalVoiceIntent::FocusByState { .. }
            | KalVoiceIntent::FocusPrevious
            | KalVoiceIntent::WhichSessions { .. } => Err(ExecError::new(
                "not_in_this_build",
                "That KalVoice session command isn't in this build yet.",
            )),
            KalVoiceIntent::Navigate { surface } => Ok(Executed {
                summary: format!(
                    "Opened {}.",
                    crate::kalvoice_commands::surface_label(*surface)
                ),
                directive: Some(UiDirective::Navigate { surface: *surface }),
            }),
            KalVoiceIntent::OpenWorkspace { query } => {
                let id = self.find_workspace(query)?.ok_or_else(|| {
                    ExecError::new(
                        "workspace_not_found",
                        format!("KalCode has no workspace named \u{201c}{query}\u{201d}."),
                    )
                })?;
                // Re-resolve immediately before mutation. The local interpreter only receives
                // an id/name snapshot, and workspace roots may change between interpretation
                // and execution.
                self.workspace(&id)?;
                let workspace = self
                    .core
                    .activate_workspace(&id)
                    .map_err(|e| from_core(&e))?;
                Ok(Executed {
                    summary: format!("Opened the {} workspace.", workspace.name),
                    directive: Some(UiDirective::OpenWorkspace {
                        workspace_id: workspace.id,
                    }),
                })
            }
            KalVoiceIntent::CreateTerminal { workspace_id } => {
                let workspace = self.target_workspace(workspace_id.as_deref())?;
                let (cols, rows) = VOICE_TERMINAL_SIZE;
                let size = TerminalSize::new(cols, rows).map_err(|_| {
                    ExecError::new("invalid_size", "KalVoice couldn't size the new terminal.")
                })?;
                let terminal = self
                    .core
                    .create_terminal(&workspace.id, None, size)
                    .map_err(|e| from_core(&e))?;
                Ok(Executed {
                    summary: format!("Opened a terminal in {}.", workspace.name),
                    directive: Some(UiDirective::OpenTerminal {
                        workspace_id: workspace.id,
                        terminal_id: terminal.id,
                    }),
                })
            }
            KalVoiceIntent::CreateThreads {
                provider_id,
                count,
                workspace_id,
                account_query: Some(account_query),
            } if !self.provider_panes_enabled => self.create_headless_threads(
                provider_id,
                *count,
                workspace_id.as_deref(),
                account_query,
            ),
            KalVoiceIntent::CreateThreads {
                provider_id,
                count,
                workspace_id,
                account_query,
            } => self.create_provider_panes(
                &[ProviderPaneRequest {
                    provider_id: Some(provider_id.clone()),
                    count: *count,
                    account_query: account_query.clone(),
                    model: None,
                }],
                workspace_id.as_deref(),
            ),
            KalVoiceIntent::CreateProviderPanes {
                groups,
                workspace_id,
            } => self.create_provider_panes(groups, workspace_id.as_deref()),
            KalVoiceIntent::ControlPane {
                command,
                workspace_id,
            } => {
                let workspace = self.target_workspace(workspace_id.as_deref())?;
                Ok(Executed {
                    summary: "Updating the workspace layout.".into(),
                    directive: Some(UiDirective::ControlPane {
                        workspace_id: workspace.id,
                        command: command.clone(),
                    }),
                })
            }
            KalVoiceIntent::ControlBrowser {
                command,
                workspace_id,
            } => {
                let workspace = self.target_workspace(workspace_id.as_deref())?;
                Ok(Executed {
                    summary: browser_summary(command),
                    directive: Some(UiDirective::ControlBrowser {
                        workspace_id: workspace.id,
                        command: command.clone(),
                    }),
                })
            }
            KalVoiceIntent::OpenThread { query } | KalVoiceIntent::Focus { query } => {
                let thread = self.named_thread(query)?;
                Ok(Executed {
                    summary: format!("Opened \u{201c}{}\u{201d}.", thread.name),
                    directive: Some(UiDirective::OpenThread {
                        thread_id: thread.id,
                    }),
                })
            }
            KalVoiceIntent::RequestPermissionMode { mode, thread_query } => {
                // Only asks: opens the thread; the person changes the mode in its permission
                // menu. KalVoice never calls `thread_set_permission_mode`.
                let thread = self.named_thread(thread_query.as_deref().unwrap_or_default())?;
                Ok(Executed {
                    summary: format!(
                        "Opened \u{201c}{}\u{201d}. To switch it to {}, choose it in the thread's permission menu; KalVoice doesn't change permission modes.",
                        thread.name,
                        requestable_mode_label(*mode)
                    ),
                    directive: Some(UiDirective::OpenThread {
                        thread_id: thread.id,
                    }),
                })
            }
            KalVoiceIntent::PauseThreads { scope } => {
                let outcomes = self.threads()?.pause_threads(scope);
                Ok(Executed {
                    summary: bulk_summary(
                        "pause",
                        "Paused",
                        "No threads were working, so there was nothing to pause.",
                        &outcomes,
                    )?,
                    directive: None,
                })
            }
            KalVoiceIntent::ResumeThreads { scope } => {
                let outcomes = self.threads()?.resume_threads(scope);
                Ok(Executed {
                    summary: bulk_summary(
                        "resume",
                        "Resumed",
                        "No threads were paused, so there was nothing to resume.",
                        &outcomes,
                    )?,
                    directive: None,
                })
            }
            KalVoiceIntent::StopThreads { scope } => {
                let outcomes = self.threads()?.stop_threads(scope);
                Ok(Executed {
                    summary: bulk_summary(
                        "stop",
                        "Stopped",
                        "No threads were running, so there was nothing to stop.",
                        &outcomes,
                    )?,
                    directive: None,
                })
            }
            KalVoiceIntent::ShowApprovals => {
                let permissions = self.permissions.as_ref().ok_or_else(|| {
                    ExecError::new(
                        "approvals_unavailable",
                        "KalCode's permission engine isn't running.",
                    )
                })?;
                let pending = permissions
                    .list_approvals(Some(ApprovalStatus::Pending))
                    .map_err(|e| from_core(&e))?
                    .len();
                Ok(Executed {
                    summary: match pending {
                        0 => "Nothing is waiting for your approval.".into(),
                        1 => "1 approval is waiting for you.".into(),
                        n => format!("{n} approvals are waiting for you."),
                    },
                    directive: Some(UiDirective::ShowApprovals),
                })
            }
            KalVoiceIntent::StatusReport => self.status_report(),
            KalVoiceIntent::Search { query } => self.search(query),
            KalVoiceIntent::FilterDashboard { chip } => {
                // Counting is best effort: the filter works even without the thread runtime.
                let counts = self
                    .threads
                    .as_ref()
                    .and_then(|runtime| runtime.list(None, false).ok())
                    .map(|threads| {
                        let count = threads
                            .iter()
                            .filter(|t| *chip == DashboardChip::All || t.status.chip() == *chip)
                            .count();
                        (count, threads.len())
                    });
                Ok(Executed {
                    summary: filter_summary(*chip, counts),
                    directive: Some(UiDirective::FilterDashboard { chip: *chip }),
                })
            }
            KalVoiceIntent::Reasoning { .. } => {
                Err(ExecError::new("not_a_command", "That isn't a command."))
            }
            KalVoiceIntent::Split { axis } => Ok(pane_split(*axis, &ctx.providers)),
            KalVoiceIntent::Resize { direction, steps } => Ok(Executed {
                summary: format!("Made the pane {}.", resize_word(*direction)),
                directive: Some(UiDirective::ResizePane {
                    direction: *direction,
                    steps: (*steps).clamp(1, 10),
                }),
            }),
            KalVoiceIntent::Close { query } => {
                let query = query
                    .as_deref()
                    .map(str::trim)
                    .filter(|q| !q.is_empty())
                    .map(str::to_owned);
                Ok(Executed {
                    summary: match &query {
                        Some(name) => {
                            format!("Closed the {name} pane. What it runs keeps running.")
                        }
                        None => "Closed the pane. What it runs keeps running.".into(),
                    },
                    directive: Some(UiDirective::ClosePane { query }),
                })
            }
            KalVoiceIntent::SwitchProvider { .. } => Err(ExecError::new(
                "not_in_this_build",
                "Provider switching isn't in this build yet, so KalVoice can't do that.",
            )),
            KalVoiceIntent::RebindThreadAccount {
                thread_query,
                provider_id,
                account_query,
            } => {
                // Never rebinds: the person confirms (or cancels) KalCode's Rebind dialog.
                let (thread, account) = self.prepare_rebind(
                    thread_query.as_deref(),
                    provider_id.as_ref(),
                    account_query,
                    ctx.thread_id.as_deref(),
                )?;
                if thread.provider_account_id.as_deref() == Some(account.id.as_str()) {
                    return Ok(Executed {
                        summary: format!(
                            "\u{201c}{}\u{201d} already uses {}.",
                            thread.name, account.display_name
                        ),
                        directive: Some(UiDirective::OpenThread {
                            thread_id: thread.id,
                        }),
                    });
                }
                Ok(Executed {
                    summary: format!(
                        "Confirm in KalCode to switch \u{201c}{}\u{201d} to {}.",
                        thread.name, account.display_name
                    ),
                    directive: Some(UiDirective::ConfirmThreadRebind {
                        thread_id: thread.id,
                        account_id: account.id,
                    }),
                })
            }
            KalVoiceIntent::SetWorkspaceAccount {
                provider_id,
                account_query,
                workspace_id,
            } => {
                let (workspace, account) = self.prepare_workspace_account(
                    provider_id,
                    account_query,
                    workspace_id.as_deref(),
                )?;
                AccountStore::new(self.core.clone())
                    .bind(
                        provider_id.as_str(),
                        ProviderAccountBindingKind::Workspace,
                        &workspace.id,
                        &account.id,
                    )
                    .map_err(|e| from_core(&e))?;
                Ok(Executed {
                    summary: format!(
                        "New {} threads in {} will use {}.",
                        provider_display_name(provider_id),
                        workspace.name,
                        account.display_name
                    ),
                    directive: None,
                })
            }
        }
    }
}

fn browser_summary(command: &BrowserControl) -> String {
    match command {
        BrowserControl::Open { new_pane: true, .. } => "Opening another browser pane.".into(),
        BrowserControl::Open { .. } => "Opening the browser.".into(),
        BrowserControl::Navigate { url, .. } => format!("Opening {url} in the browser."),
        BrowserControl::Back { .. } => "Going back in the browser.".into(),
        BrowserControl::Forward { .. } => "Going forward in the browser.".into(),
        BrowserControl::Reload { .. } => "Reloading the browser.".into(),
        BrowserControl::Stop { .. } => "Stopping the browser load.".into(),
    }
}

/// "Made the pane bigger." — how a resize direction reads.
fn resize_word(direction: PaneDirection) -> &'static str {
    match direction {
        PaneDirection::Right => "bigger",
        PaneDirection::Left => "smaller",
        PaneDirection::Down => "taller",
        PaneDirection::Up => "shorter",
    }
}

/// A split of the focused pane, or (with named providers) their panes put next to each other.
fn pane_split(axis: SplitAxis, providers: &[ProviderId]) -> Executed {
    let how = match axis {
        SplitAxis::Horizontal => "side by side",
        SplitAxis::Vertical => "top and bottom",
    };
    if providers.len() >= 2 {
        let names: Vec<String> = providers.iter().map(provider_display_name).collect();
        let listed = match names.as_slice() {
            [a, b] => format!("{a} and {b}"),
            [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
            [] => String::new(),
        };
        return Executed {
            summary: format!("Putting {listed} {how}."),
            directive: Some(UiDirective::ArrangePanes {
                axis,
                provider_ids: providers.to_vec(),
            }),
        };
    }
    Executed {
        summary: format!("Split the pane {how}."),
        directive: Some(UiDirective::SplitPane { axis }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kalcode_contracts::kalvoice::BrowserControl;

    fn outcome(ok: bool, message: Option<&str>) -> BulkOutcome {
        BulkOutcome {
            thread_id: "t".into(),
            ok,
            message: message.map(str::to_owned),
        }
    }

    fn executor(dir: &std::path::Path) -> DesktopExecutor {
        let core = Core::open(kalcode_core::CoreConfig {
            paths: kalcode_core::Paths::new(dir),
            app_version: "0.1.0-test".into(),
            channel: kalcode_core::flags::BuildChannel::Development,
        })
        .expect("core");
        DesktopExecutor {
            visible: vec![SurfaceId::Dashboard, SurfaceId::Settings, SurfaceId::Code],
            provider_panes_enabled: false,
            core: Arc::new(core),
            threads: None,
            permissions: None,
            locator: None,
        }
    }

    /// Z3/Z2 stand-ins: no threads, no providers (the locator still indexes workspaces).
    struct NoSources;

    impl kalcode_locator::LocatorSources for NoSources {
        fn threads(&self) -> kalcode_core::Result<Vec<kalcode_contracts::threads::ThreadSummary>> {
            Ok(Vec::new())
        }
        fn thread(
            &self,
            _: &str,
        ) -> kalcode_core::Result<Option<kalcode_contracts::threads::ThreadSummary>> {
            Ok(None)
        }
        fn thread_text(&self, _: &str, _: usize) -> kalcode_core::Result<String> {
            Ok(String::new())
        }
        fn providers(&self) -> Vec<kalcode_locator::ProviderInfo> {
            Vec::new()
        }
    }

    #[test]
    fn search_reads_back_names_only_and_opens_search() {
        let dir = tempfile::tempdir().expect("data");
        let projects = tempfile::tempdir().expect("projects");
        let mut executor = executor(dir.path());
        let search = KalVoiceIntent::Search {
            query: "orbit".into(),
        };
        assert_eq!(
            executor.check(&search).map_err(|e| e.code),
            Err("search_unavailable".into())
        );
        let folder = projects.path().join("orbit-payments");
        std::fs::create_dir_all(&folder).expect("folder");
        executor.core.open_workspace(&folder).expect("open");
        let locator = kalcode_locator::Locator::start(executor.core.clone(), Arc::new(NoSources))
            .expect("locator");
        assert!(locator.wait_ready(std::time::Duration::from_secs(20)));
        executor.locator = Some(locator.clone());
        assert!(executor.check(&search).is_ok());
        let done = executor.execute(&search, &ctx()).expect("search");
        assert!(
            done.summary.starts_with("Found 1: orbit-payments"),
            "{}",
            done.summary
        );
        assert_eq!(
            done.directive,
            Some(UiDirective::Search {
                query: "orbit".into()
            })
        );
        let none = executor
            .execute(
                &KalVoiceIntent::Search {
                    query: "zebracorn".into(),
                },
                &ctx(),
            )
            .expect("search");
        assert_eq!(none.summary, "Nothing matched \u{201c}zebracorn\u{201d}.");
        locator.shutdown();
    }

    fn ctx() -> ExecContext {
        ExecContext {
            request_id: String::new(),
            workspace_id: None,
            thread_id: None,
            providers: Vec::new(),
        }
    }

    #[test]
    fn pane_commands_are_layout_directives() {
        let dir = tempfile::tempdir().expect("data");
        let executor = executor(dir.path());
        let split = KalVoiceIntent::Split {
            axis: SplitAxis::Horizontal,
        };
        assert!(executor.check(&split).is_ok());
        let done = executor.execute(&split, &ctx()).expect("split");
        assert_eq!(done.summary, "Split the pane side by side.");
        assert_eq!(
            done.directive,
            Some(UiDirective::SplitPane {
                axis: SplitAxis::Horizontal
            })
        );
        let stacked = executor
            .execute(
                &KalVoiceIntent::Split {
                    axis: SplitAxis::Vertical,
                },
                &ctx(),
            )
            .expect("split");
        assert_eq!(stacked.summary, "Split the pane top and bottom.");

        let providers = ExecContext {
            providers: vec![
                ProviderId::new(ProviderId::CLAUDE_CODE),
                ProviderId::new(ProviderId::CODEX),
            ],
            ..ctx()
        };
        let arranged = executor.execute(&split, &providers).expect("arrange");
        assert_eq!(arranged.summary, "Putting Claude and Codex side by side.");
        assert_eq!(
            arranged.directive,
            Some(UiDirective::ArrangePanes {
                axis: SplitAxis::Horizontal,
                provider_ids: providers.providers.clone(),
            })
        );

        let bigger = KalVoiceIntent::Resize {
            direction: PaneDirection::Right,
            steps: 2,
        };
        assert!(executor.check(&bigger).is_ok());
        let resized = executor.execute(&bigger, &ctx()).expect("resize");
        assert_eq!(resized.summary, "Made the pane bigger.");
        assert_eq!(
            resized.directive,
            Some(UiDirective::ResizePane {
                direction: PaneDirection::Right,
                steps: 2
            })
        );

        let close = KalVoiceIntent::Close { query: None };
        assert!(executor.check(&close).is_ok());
        let closed = executor.execute(&close, &ctx()).expect("close");
        assert_eq!(
            closed.summary,
            "Closed the pane. What it runs keeps running."
        );
        assert_eq!(
            closed.directive,
            Some(UiDirective::ClosePane { query: None })
        );
        let named = executor
            .execute(
                &KalVoiceIntent::Close {
                    query: Some("codex".into()),
                },
                &ctx(),
            )
            .expect("close");
        assert_eq!(
            named.directive,
            Some(UiDirective::ClosePane {
                query: Some("codex".into())
            })
        );

        // Still not in this build.
        assert_eq!(
            executor
                .check(&KalVoiceIntent::SwitchProvider {
                    provider_id: ProviderId::new(ProviderId::GEMINI_CLI),
                })
                .map_err(|e| e.code),
            Err("not_in_this_build".into())
        );
        // Search is Z7-W2's; this test executor has no locator.
        assert_eq!(
            executor
                .check(&KalVoiceIntent::Search {
                    query: "oauth".into()
                })
                .map_err(|e| e.code),
            Err("search_unavailable".into())
        );
    }

    #[test]
    fn browser_commands_are_scoped_to_the_authoritative_workspace() {
        let data = tempfile::tempdir().expect("data");
        let project = tempfile::tempdir().expect("project");
        let executor = executor(data.path());
        let no_workspace = KalVoiceIntent::ControlBrowser {
            command: BrowserControl::Reload { browser_id: None },
            workspace_id: None,
        };
        assert_eq!(
            executor.check(&no_workspace).map_err(|e| e.code),
            Err("no_workspace".into())
        );

        let workspace = executor.core.open_workspace(project.path()).expect("open");
        assert!(executor.check(&no_workspace).is_ok());
        let done = executor
            .execute(&no_workspace, &ctx())
            .expect("browser control");
        assert_eq!(done.summary, "Reloading the browser.");
        assert_eq!(
            done.directive,
            Some(UiDirective::ControlBrowser {
                workspace_id: workspace.id,
                command: BrowserControl::Reload { browser_id: None },
            })
        );
    }

    #[test]
    fn workspace_resolution_never_guesses_between_equal_or_partial_matches() {
        let data = tempfile::tempdir().expect("data");
        let projects = tempfile::tempdir().expect("projects");
        let executor = executor(data.path());
        for relative in [
            "personal/Dashboard",
            "work/Dashboard",
            "api-client",
            "api-server",
        ] {
            let path = projects.path().join(relative);
            std::fs::create_dir_all(&path).expect("project directory");
            executor.core.open_workspace(&path).expect("open");
        }
        for query in ["Dashboard", "api"] {
            assert_eq!(
                executor.find_workspace(query).map_err(|e| e.code),
                Err("workspace_ambiguous".into())
            );
        }
        assert_eq!(executor.find_workspace(" ").expect("empty"), None);
        assert!(
            executor
                .find_workspace("api client")
                .expect("normalized")
                .is_some()
        );
    }

    #[test]
    fn workspace_resolution_uses_only_available_recanonicalized_records() {
        let data = tempfile::tempdir().expect("data");
        let executor = executor(data.path());
        let stale_id = {
            let removed_parent = tempfile::tempdir().expect("removed parent");
            let removed = removed_parent.path().join("Dashboard");
            std::fs::create_dir_all(&removed).expect("removed workspace");
            executor
                .core
                .open_workspace(&removed)
                .expect("open removed")
                .id
        };
        let available_parent = tempfile::tempdir().expect("available parent");
        let available = available_parent.path().join("Dashboard");
        std::fs::create_dir_all(&available).expect("available workspace");
        let available = executor
            .core
            .open_workspace(&available)
            .expect("open available");

        assert_eq!(
            executor.find_workspace("Dashboard").expect("find"),
            Some(available.id.clone()),
            "an unavailable duplicate must not make the available workspace ambiguous"
        );
        assert_eq!(
            executor.workspace_options().expect("options"),
            vec![kalcode_contracts::threads::WorkspaceOption {
                id: available.id,
                name: "Dashboard".into(),
            }]
        );
        assert_eq!(
            executor
                .target_workspace(Some(&stale_id))
                .map_err(|error| error.code),
            Err("workspace_unavailable".into())
        );
    }

    #[test]
    fn navigation_and_workspaces_use_the_real_core() {
        let dir = tempfile::tempdir().expect("data");
        let project = tempfile::tempdir().expect("project");
        let executor = executor(dir.path());
        let settings = KalVoiceIntent::Navigate {
            surface: SurfaceId::Settings,
        };
        assert!(executor.check(&settings).is_ok());
        assert_eq!(
            executor
                .execute(&settings, &ctx())
                .expect("navigate")
                .summary,
            "Opened Settings."
        );
        assert_eq!(
            executor
                .check(&KalVoiceIntent::Navigate {
                    surface: SurfaceId::Missions
                })
                .map_err(|e| e.code),
            Err("surface_unavailable".into())
        );

        // No workspace yet: a terminal needs one.
        let terminal = executor.execute(
            &KalVoiceIntent::CreateTerminal { workspace_id: None },
            &ctx(),
        );
        assert!(matches!(terminal, Err(e) if e.code == "no_workspace"));

        let workspace = executor.core.open_workspace(project.path()).expect("open");
        let spoken = workspace.name.to_uppercase();
        assert_eq!(
            executor.find_workspace(&spoken).expect("find"),
            Some(workspace.id.clone())
        );
        assert_eq!(executor.find_workspace("atlantis").expect("find"), None);
        let opened = executor
            .execute(&KalVoiceIntent::OpenWorkspace { query: spoken }, &ctx())
            .expect("open workspace");
        assert_eq!(
            opened.directive,
            Some(UiDirective::OpenWorkspace {
                workspace_id: workspace.id
            })
        );
    }

    #[test]
    fn thread_and_approval_commands_say_when_their_runtime_is_missing() {
        let dir = tempfile::tempdir().expect("data");
        let executor = executor(dir.path());
        assert_eq!(
            executor
                .check(&KalVoiceIntent::StatusReport)
                .map_err(|e| e.code),
            Err("threads_unavailable".into())
        );
        assert_eq!(
            executor
                .check(&KalVoiceIntent::ShowApprovals)
                .map_err(|e| e.code),
            Err("approvals_unavailable".into())
        );
    }

    #[test]
    fn dashboard_filters_need_no_runtime_and_count_when_it_runs() {
        let dir = tempfile::tempdir().expect("data");
        let executor = executor(dir.path());
        let intent = KalVoiceIntent::FilterDashboard {
            chip: DashboardChip::Working,
        };
        assert!(executor.check(&intent).is_ok());
        let done = executor.execute(&intent, &ctx()).expect("filter");
        assert_eq!(
            done.directive,
            Some(UiDirective::FilterDashboard {
                chip: DashboardChip::Working
            })
        );
        assert_eq!(done.summary, "Showing working agents on the Dashboard.");

        assert_eq!(
            filter_summary(DashboardChip::Working, Some((2, 21))),
            "Showing 2 working agents."
        );
        assert_eq!(
            filter_summary(DashboardChip::WaitingForYou, Some((0, 21))),
            "Nothing is waiting for you."
        );
        assert_eq!(
            filter_summary(DashboardChip::WaitingForYou, Some((1, 21))),
            "1 agent is waiting for you."
        );
        assert_eq!(
            filter_summary(DashboardChip::Done, Some((3, 21))),
            "Showing 3 completed threads."
        );
        assert_eq!(
            filter_summary(DashboardChip::All, Some((21, 21))),
            "Showing all 21 agents."
        );
        assert_eq!(
            filter_summary(DashboardChip::Idle, Some((1, 4))),
            "Showing 1 idle agent."
        );
    }

    #[test]
    fn bulk_results_read_naturally() {
        let idle = "No threads were working, so there was nothing to pause.";
        assert_eq!(
            bulk_summary("pause", "Paused", idle, &[]).ok().as_deref(),
            Some(idle)
        );
        assert_eq!(
            bulk_summary("pause", "Paused", idle, &[outcome(true, None)])
                .ok()
                .as_deref(),
            Some("Paused 1 thread.")
        );
        assert_eq!(
            bulk_summary(
                "stop",
                "Stopped",
                idle,
                &[
                    outcome(true, None),
                    outcome(false, Some("It already ended."))
                ]
            )
            .ok()
            .as_deref(),
            Some("Stopped 1 of 2 threads. It already ended.")
        );
        let failed = bulk_summary("resume", "Resumed", idle, &[outcome(false, None)]);
        assert!(matches!(failed, Err(e) if e.message == "KalVoice couldn't resume any threads."));
    }

    // ---- 0.1.5 switch accounts ----

    /// A registered provider that never starts a session (idle threads never need one).
    struct IdleProvider(&'static str);

    impl kalcode_contracts::agent::AgentProvider for IdleProvider {
        fn id(&self) -> ProviderId {
            ProviderId::new(self.0)
        }

        fn display_name(&self) -> &str {
            self.0
        }

        fn detect(&self) -> kalcode_contracts::agent::ProviderDetection {
            kalcode_contracts::agent::ProviderDetection {
                provider_id: self.id(),
                display_name: self.0.into(),
                state: kalcode_contracts::agent::DetectionState::Installed,
                display_path: None,
                version: None,
                minimum_version: None,
                auth: AuthState::Authenticated,
                message: None,
                checked_at: String::new(),
            }
        }

        fn capabilities(&self) -> kalcode_contracts::agent::ProviderCapabilities {
            match self.0 {
                ProviderId::GEMINI_CLI => kalcode_providers::catalog::gemini_capabilities(),
                _ => kalcode_providers::catalog::codex_capabilities(),
            }
        }

        fn start_session(
            &self,
            _config: kalcode_contracts::agent::SessionConfig,
            _sink: Box<dyn kalcode_contracts::agent::AgentEventSink>,
        ) -> Result<
            Box<dyn kalcode_contracts::agent::AgentSession>,
            kalcode_contracts::agent::ProviderError,
        > {
            Err(kalcode_contracts::agent::ProviderError::Unsupported)
        }
    }

    struct AccountsFixture {
        _data: tempfile::TempDir,
        _project: tempfile::TempDir,
        executor: DesktopExecutor,
        store: AccountStore,
        workspace_id: String,
        runtime: Arc<ThreadRuntime>,
    }

    /// Stable-like: provider panes off, the thread runtime running with Codex and Gemini.
    fn accounts_fixture() -> AccountsFixture {
        let data = tempfile::tempdir().expect("data");
        let project = tempfile::tempdir().expect("project");
        let mut executor = executor(data.path());
        let registry = Arc::new(kalcode_threads::ProviderRegistry::new());
        registry.register(Arc::new(IdleProvider(ProviderId::CODEX)));
        registry.register(Arc::new(IdleProvider(ProviderId::GEMINI_CLI)));
        let runtime = Arc::new(
            ThreadRuntime::new(
                executor.core.clone(),
                registry,
                Arc::new(CoreWorkspaces::new(executor.core.clone())),
                Arc::new(kalcode_contracts::permissions::AskUnlessReadGate),
            )
            .expect("runtime"),
        );
        executor.threads = Some(runtime.clone());
        executor.visible.push(SurfaceId::Threads);
        let workspace_id = executor
            .core
            .open_workspace(project.path())
            .expect("open")
            .id;
        let store = AccountStore::new(executor.core.clone());
        AccountsFixture {
            _data: data,
            _project: project,
            executor,
            store,
            workspace_id,
            runtime,
        }
    }

    impl AccountsFixture {
        fn account(&self, provider: &str, label: &str, state: AuthState) -> ProviderAccount {
            let account = self.store.create(provider, label).expect("account");
            self.store
                .mark_authentication(&account.id, state, None, None)
                .expect("auth")
        }

        fn thread(&self, provider: &str, account: &ProviderAccount) -> ThreadSummary {
            self.runtime
                .create_idle(CreateIdleThread {
                    provider_id: provider.into(),
                    provider_account_id: Some(account.id.clone()),
                    account_label: Some(account.display_name.clone()),
                    workspace_id: self.workspace_id.clone(),
                    model: None,
                    permission_mode: PermissionMode::Approve,
                    name: Some("Login fix".into()),
                })
                .expect("thread")
        }

        fn run(&self, intent: &KalVoiceIntent, ctx: &ExecContext) -> Result<Executed, ExecError> {
            self.executor.check(intent)?;
            self.executor.execute(intent, ctx)
        }
    }

    fn rebind(thread: Option<&str>, provider: Option<&str>, account: &str) -> KalVoiceIntent {
        KalVoiceIntent::RebindThreadAccount {
            thread_query: thread.map(str::to_owned),
            provider_id: provider.map(ProviderId::new),
            account_query: account.into(),
        }
    }

    fn focused(thread_id: &str) -> ExecContext {
        ExecContext {
            thread_id: Some(thread_id.to_owned()),
            ..ctx()
        }
    }

    #[test]
    fn voice_rebind_only_asks_the_rebind_dialog_and_never_changes_the_thread() {
        let f = accounts_fixture();
        let a = f.account(ProviderId::GEMINI_CLI, "Gemini A", AuthState::Authenticated);
        let b = f.account(ProviderId::GEMINI_CLI, "Gemini B", AuthState::Unknown);
        let thread = f.thread(ProviderId::GEMINI_CLI, &a);

        // "Switch this Gemini thread to Gemini B." (the shown thread)
        let done = f
            .run(
                &rebind(None, Some(ProviderId::GEMINI_CLI), "gemini b"),
                &focused(&thread.id),
            )
            .expect("rebind request");
        assert_eq!(
            done.directive,
            Some(UiDirective::ConfirmThreadRebind {
                thread_id: thread.id.clone(),
                account_id: b.id.clone(),
            })
        );
        assert_eq!(
            done.summary,
            "Confirm in KalCode to switch \u{201c}Login fix\u{201d} to Gemini B."
        );
        // Asking changed nothing: the thread still belongs to Gemini A.
        let unchanged = f.runtime.get(&thread.id).expect("thread");
        assert_eq!(unchanged.provider_account_id, Some(a.id.clone()));
        assert_eq!(unchanged.account_label.as_deref(), Some("Gemini A"));

        // A named thread and a provider-less label ("b") resolve the same way.
        let named = f
            .run(&rebind(Some("login fix"), None, "b"), &ctx())
            .expect("named rebind");
        assert_eq!(
            named.directive,
            Some(UiDirective::ConfirmThreadRebind {
                thread_id: thread.id.clone(),
                account_id: b.id.clone(),
            })
        );

        // Already on that account: say so and just open the thread.
        let same = f
            .run(&rebind(None, None, "Gemini A"), &focused(&thread.id))
            .expect("same account");
        assert_eq!(
            same.summary,
            "\u{201c}Login fix\u{201d} already uses Gemini A."
        );
        assert_eq!(
            same.directive,
            Some(UiDirective::OpenThread {
                thread_id: thread.id.clone()
            })
        );
    }

    #[test]
    fn voice_rebind_refuses_ambiguity_sign_out_and_the_wrong_provider() {
        let f = accounts_fixture();
        let a = f.account(ProviderId::GEMINI_CLI, "Gemini A", AuthState::Authenticated);
        f.account(ProviderId::GEMINI_CLI, "Gemini B", AuthState::Authenticated);
        f.account(
            ProviderId::GEMINI_CLI,
            "Gemini C",
            AuthState::NotAuthenticated,
        );
        f.account(ProviderId::CODEX, "Work", AuthState::Authenticated);
        let thread = f.thread(ProviderId::GEMINI_CLI, &a);
        let here = focused(&thread.id);

        let ambiguous = f
            .run(&rebind(None, None, "gemini"), &here)
            .map_err(|e| (e.code, e.message));
        assert_eq!(
            ambiguous,
            Err((
                "provider_account_ambiguous".into(),
                "Which account \u{2014} Gemini A, Gemini B or Gemini C?".into()
            ))
        );
        let signed_out = f
            .run(&rebind(None, None, "gemini c"), &here)
            .map_err(|e| (e.code, e.message));
        assert_eq!(
            signed_out,
            Err((
                "provider_account_signed_out".into(),
                "Gemini C isn't signed in. Sign in to it in Providers, then try again.".into()
            ))
        );
        assert_eq!(
            f.run(&rebind(None, None, "gemini z"), &here)
                .map_err(|e| e.code),
            Err("provider_account_not_found".into())
        );
        // A Codex account never lands on a Gemini thread.
        assert_eq!(
            f.run(&rebind(None, Some(ProviderId::CODEX), "codex work"), &here)
                .map_err(|e| e.code),
            Err("provider_account_mismatch".into())
        );
        // "This thread" with no thread on screen: ask which one.
        assert_eq!(
            f.run(&rebind(None, None, "gemini b"), &ctx())
                .map_err(|e| e.code),
            Err("thread_not_specified".into())
        );
        assert_eq!(
            f.runtime
                .get(&thread.id)
                .expect("thread")
                .provider_account_id,
            Some(a.id)
        );
    }

    #[test]
    fn voice_sets_the_workspace_default_account_and_says_so() {
        let f = accounts_fixture();
        f.account(ProviderId::GEMINI_CLI, "Gemini B", AuthState::Authenticated);
        let a = f.account(ProviderId::GEMINI_CLI, "Gemini A", AuthState::Unknown);
        f.account(
            ProviderId::GEMINI_CLI,
            "Gemini Off",
            AuthState::NotAuthenticated,
        );
        let intent = |account: &str| KalVoiceIntent::SetWorkspaceAccount {
            provider_id: ProviderId::new(ProviderId::GEMINI_CLI),
            account_query: account.into(),
            workspace_id: None,
        };

        let done = f.run(&intent("gemini a"), &ctx()).expect("bind");
        assert_eq!(done.directive, None);
        assert!(
            done.summary.starts_with("New Gemini threads in ")
                && done.summary.ends_with(" will use Gemini A."),
            "{}",
            done.summary
        );
        let bindings = f
            .store
            .list_bindings(
                Some(ProviderId::GEMINI_CLI),
                Some(ProviderAccountBindingKind::Workspace),
                Some(&f.workspace_id),
            )
            .expect("bindings");
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].account_id, a.id);

        // Signed out or unknown: nothing is written.
        assert_eq!(
            f.executor.check(&intent("gemini off")).map_err(|e| e.code),
            Err("provider_account_signed_out".into())
        );
        assert_eq!(
            f.executor.check(&intent("gemini q")).map_err(|e| e.code),
            Err("provider_account_not_found".into())
        );
        let after = f
            .store
            .list_bindings(Some(ProviderId::GEMINI_CLI), None, None)
            .expect("bindings");
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].account_id, a.id);
    }

    #[test]
    fn stable_creates_an_idle_headless_thread_on_the_named_account() {
        let f = accounts_fixture();
        f.account(ProviderId::CODEX, "Personal", AuthState::Authenticated);
        let work = f.account(ProviderId::CODEX, "Codex Work", AuthState::Authenticated);
        let intent = |account: Option<&str>, count: u8| KalVoiceIntent::CreateThreads {
            provider_id: ProviderId::new(ProviderId::CODEX),
            count,
            workspace_id: None,
            account_query: account.map(str::to_owned),
        };

        // "Open a new Codex thread with my work account."
        let done = f.run(&intent(Some("work"), 1), &ctx()).expect("create");
        let Some(UiDirective::OpenThread { thread_id }) = done.directive else {
            panic!("expected OpenThread, got {:?}", done.directive);
        };
        let thread = f.runtime.get(&thread_id).expect("thread");
        assert_eq!(thread.provider_account_id, Some(work.id.clone()));
        assert_eq!(thread.account_label.as_deref(), Some("Codex Work"));
        assert!(
            done.summary.starts_with("Opened a new Codex thread in "),
            "{}",
            done.summary
        );
        // Headless: no provider pane terminal.
        assert_eq!(thread.terminal_id, None);

        let two = f.run(&intent(Some("codex work"), 2), &ctx()).expect("two");
        assert_eq!(
            two.directive,
            Some(UiDirective::Navigate {
                surface: SurfaceId::Threads
            })
        );

        // Without an account, and for panes, Stable still refuses provider panes.
        assert_eq!(
            f.executor.check(&intent(None, 1)).map_err(|e| e.code),
            Err("provider_panes_unavailable".into())
        );
        // Signed-out accounts never get a thread.
        f.account(ProviderId::CODEX, "Old", AuthState::NotAuthenticated);
        assert_eq!(
            f.executor
                .check(&intent(Some("old"), 1))
                .map_err(|e| e.code),
            Err("provider_account_signed_out".into())
        );
        assert_eq!(f.runtime.list(None, false).expect("threads").len(), 3);
    }

    #[test]
    fn spoken_account_names_match_without_guessing() {
        let account = |label: &str| ProviderAccount {
            id: label.into(),
            provider_id: ProviderId::new(ProviderId::GEMINI_CLI),
            display_name: label.into(),
            provider_reported_identity: None,
            authentication_state: AuthState::Unknown,
            is_default: false,
            created_at: String::new(),
            last_used_at: None,
            last_checked_at: None,
            last_error_code: None,
            archived_at: None,
        };
        let accounts = [
            account("Gemini A"),
            account("Gemini B"),
            account("Work"),
            account("Work 2"),
        ];
        let gemini = ProviderId::new(ProviderId::GEMINI_CLI);
        let labels = |query: &str| -> Vec<String> {
            matching_accounts(&accounts, &gemini, query)
                .into_iter()
                .map(|a| a.display_name.clone())
                .collect()
        };
        assert_eq!(labels("gemini b"), ["Gemini B"]);
        assert_eq!(labels("Gemini-A"), ["Gemini A"]);
        assert_eq!(labels("b"), ["Gemini B"]);
        assert_eq!(labels("gemini cli b account"), ["Gemini B"]);
        assert_eq!(labels("work"), ["Work"]);
        assert_eq!(labels("gemini"), ["Gemini A", "Gemini B", "Work", "Work 2"]);
        assert!(labels("gemini z").is_empty());
        assert_eq!(or_list(&["Gemini A", "Gemini B"]), "Gemini A or Gemini B");
    }
}
