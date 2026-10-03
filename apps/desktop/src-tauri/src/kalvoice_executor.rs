//! What KalVoice commands do in the desktop app: they call the same runtimes the rest of
//! KalCode uses — workspaces and terminals (Z1, `kalcode_core`), threads (Z3,
//! [`ThreadRuntime`]) and pending approvals (Z4, [`PermissionService`], read-only). KalVoice
//! never answers provider approvals. Ordinary app-control commands reach this executor directly;
//! the actual provider CLI retains its native execution permission experience.
//!
//! CA-1 intents: `focus` opens the thread (the UI shows it in its pane when it has one), and
//! `request_permission_mode` opens the thread so the person can change its mode themselves
//! (never Bypass: the contract can't represent it). `split` and `resize` are pane layout commands
//! (Z7-W1). `close` returns a UI directive that resolves one named tab without guessing, then uses
//! that content's existing close behavior. `switch_provider` isn't in this build, and `search`
//! needs the Session Locator feature (gated on Stable), so both are refused before anything is
//! counted.
//!
//! Z7-W3: `filter_dashboard` only changes what the Dashboard shows; its summary counts the
//! runtime's non-archived threads by Dashboard chip (`ThreadStatus::chip`).
//!
//! 0.1.5 switch accounts: `rebind_thread_account` only resolves the thread and account and asks
//! the person to confirm KalCode's Rebind dialog (`confirm_thread_rebind`); KalVoice never
//! rebinds a thread itself. `set_workspace_account` writes the workspace's default account
//! binding (metadata; starting a thread still needs that account signed in). `create_threads`
//! resolves every account/model/effort before starting genuine interactive provider sessions.
//! A signed-out account is refused with a sign-in message, and an ambiguous name returns a
//! short account chooser rather than guessing.
//!
//! 0.1.5 terminal-aware KalVoice: every spoken session name goes through the session resolver
//! (`session_resolver.rs`), never a first match and never the Session Locator. Several fits are a
//! "Which one?" refusal carrying a `choose_session` directive; destructive commands (pause, stop,
//! resume, account switch) never act on a partial name or a provider alone. "Tell <session> …"
//! puts the words in that thread's composer and presses its own Send (prompt review still runs);
//! it is refused while a permission request is open and never resumes a stopped thread.

use std::sync::Arc;

use kalcode_contracts::agent::{AuthState, ProviderId};
use kalcode_contracts::app::{FeatureId, SurfaceId};
use kalcode_contracts::context::PromptReview;
use kalcode_contracts::kalvoice::{
    BrowserControl, KalVoiceIntent, PaneDirection, ProviderPaneRequest,
};
use kalcode_contracts::permissions::{ApprovalStatus, PermissionMode};
use kalcode_contracts::provider_accounts::{ProviderAccount, ProviderAccountBindingKind};
use kalcode_contracts::sessions::{
    MAX_SESSION_CHOICES, SessionAttention, SessionFollowUp, SessionMatchTier, SessionResolution,
};
use kalcode_contracts::threads::WorkspaceOption;
use kalcode_contracts::threads::{ProviderOption, ThreadStatus, ThreadSummary};
use kalcode_contracts::workspace_ui::{DashboardChip, SplitAxis};
use kalcode_core::workspaces::TerminalSize;
use kalcode_core::{Core, KalError};
use kalcode_kalvoice::local_reasoning::{LocalActionGrounding, MAX_GROUNDED_ACTION_CANDIDATES};
use kalcode_kalvoice::orchestrator::{
    ExecContext, ExecError, Executed, Executor, LaunchAccountChoice, LaunchThreadInstance,
    UiDirective, provider_display_name, requestable_mode_label,
};
use kalcode_permissions::PermissionService;
use kalcode_providers::accounts::AccountStore;
use kalcode_threads::{
    BulkOutcome, CoreWorkspaces, CreateIdleThread, CreateThread, ResolvedWorkspace, ThreadRuntime,
    WorkspaceResolver, runtime::ThreadLaunchInstance as RuntimeLaunchInstance,
};

use crate::session_resolver::{self, ResolveContext};

/// Size a terminal opened by voice starts at; the Code view resizes it when it attaches.
const VOICE_TERMINAL_SIZE: (u16, u16) = (120, 30);

#[derive(Clone)]
enum PreparedProviderLaunch {
    Idle(CreateIdleThread),
    Assigned(CreateThread),
}

pub struct DesktopExecutor {
    /// Surfaces this build shows (navigation to others is refused).
    pub visible: Vec<SurfaceId>,
    /// Whether this build shows the Session Locator (`FeatureId::SessionLocator`). When it is
    /// off (Stable), voice Search is refused and the locator is never read.
    pub session_locator_enabled: bool,
    pub core: Arc<Core>,
    /// The signed-in account, whose verified plan caps open terminals. `None` (tests only)
    /// applies the Free cap.
    pub account: Option<Arc<crate::account::runtime::AccountRuntime>>,
    /// `None` when the thread runtime didn't start (then thread commands explain why).
    pub threads: Option<Arc<ThreadRuntime>>,
    /// Registers the installed providers' adapters with `threads` the first time a session
    /// operation needs them (`ThreadsState::ensure_providers`), exactly as the thread commands
    /// do. Without it, a voice launch before any other thread operation sees no providers.
    pub ensure_providers: Option<Arc<dyn Fn() + Send + Sync>>,
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

/// Whether `feature` is shown in this build (a gated feature is hidden on Stable and Beta).
pub(crate) fn feature_enabled(
    flags: &kalcode_core::flags::FeatureFlags,
    feature: FeatureId,
) -> bool {
    flags.feature(feature).is_some_and(|flag| flag.visible)
}

/// Voice Search when the Session Locator isn't in this build: refused before anything counts.
fn search_not_in_this_build() -> ExecError {
    ExecError::new(
        "not_in_this_build",
        "Search isn't available in this version, so KalVoice can't look that up.",
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

fn validate_launch_effort(
    provider: &ProviderId,
    effort: Option<&str>,
) -> Result<Option<String>, ExecError> {
    let Some(effort) = effort.map(str::trim).filter(|effort| !effort.is_empty()) else {
        return Ok(None);
    };
    let effort = effort.to_ascii_lowercase();
    if effort == "default" {
        return Ok(None);
    }
    let supported = match provider.as_str() {
        ProviderId::CLAUDE_CODE => kalcode_providers::claude::argv::valid_effort_name(&effort),
        ProviderId::CODEX => kalcode_providers::codex::argv::valid_effort_name(&effort),
        ProviderId::GEMINI_CLI => {
            return Err(ExecError::new(
                "effort_not_supported",
                "Gemini does not expose an effort setting. Remove the effort level and try again.",
            ));
        }
        _ => false,
    };
    if !supported {
        return Err(ExecError::new(
            "invalid_effort",
            format!(
                "{} does not support the requested effort level.",
                provider_display_name(provider)
            ),
        ));
    }
    Ok(Some(effort))
}

fn spoken_model_key(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn validate_launch_model(
    provider: &ProviderId,
    available: &ProviderOption,
    requested: Option<&str>,
) -> Result<Option<String>, ExecError> {
    let requested = kalcode_threads::validate::model(requested).map_err(|e| from_core(&e))?;
    let Some(requested) = requested else {
        return Ok(None);
    };
    if available.models.is_empty() {
        return Ok(Some(requested));
    }
    if let Some(exact) = available
        .models
        .iter()
        .find(|model| model.id.eq_ignore_ascii_case(&requested))
    {
        return Ok(Some(exact.id.clone()));
    }
    if provider.as_str() == ProviderId::CLAUDE_CODE
        && kalcode_providers::claude::argv::valid_model_name(&requested)
        && (requested.starts_with("claude-")
            || requested.split_once('[').is_some_and(|(alias, suffix)| {
                matches!(alias, "opus" | "sonnet" | "haiku" | "fable") && suffix.ends_with(']')
            }))
    {
        // Claude Code accepts full argv-safe identifiers in addition to its short catalog
        // aliases. Preserve the exact identifier; the installed provider remains authoritative.
        return Ok(Some(requested));
    }
    let key = spoken_model_key(&requested);
    let matches = available
        .models
        .iter()
        .filter(|model| {
            spoken_model_key(&model.id) == key || spoken_model_key(&model.display_name) == key
        })
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [one] => Ok(Some(one.id.clone())),
        _ => Err(ExecError::new(
            "invalid_model",
            "That model is not available for this provider.",
        )),
    }
}

fn explicit_account_id(query: &str) -> Option<String> {
    let trimmed = query.trim();
    if kalcode_contracts::ids::is_valid_id(trimmed) {
        return Some(trimmed.to_owned());
    }
    let encoded = trimmed.strip_prefix("account id ")?;
    let id = encoded.split_whitespace().collect::<Vec<_>>().join("-");
    kalcode_contracts::ids::is_valid_id(&id).then_some(id)
}

fn launch_retry_text(
    group: &ProviderPaneRequest,
    provider: &ProviderId,
    account_id: &str,
) -> Option<String> {
    let provider = match provider.as_str() {
        ProviderId::CLAUDE_CODE => "claude",
        ProviderId::CODEX => "codex",
        ProviderId::GEMINI_CLI => "gemini",
        _ => return None,
    };
    let encode = |value: Option<&str>| {
        value.map_or_else(
            || "none".to_owned(),
            |value| {
                value
                    .as_bytes()
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>()
            },
        )
    };
    let mut text = format!(
        "retry launch {} {provider} account {} model {} effort {} tasks",
        group.count,
        account_id.replace('-', ""),
        encode(group.model.as_deref()),
        encode(group.effort.as_deref())
    );
    if group.assignments.is_empty() {
        text.push_str(" none");
    } else {
        for assignment in &group.assignments {
            text.push(' ');
            text.push_str(&assignment.count.to_string());
            text.push(' ');
            text.push_str(&encode(Some(&assignment.task)));
        }
    }
    Some(text)
}

fn launch_retry_groups_text(
    groups: &[ProviderPaneRequest],
    group_index: usize,
    provider: &ProviderId,
    account_id: &str,
) -> Option<String> {
    if groups.len() < 2 || !kalcode_contracts::ids::is_valid_id(account_id) {
        return None;
    }
    let mut groups = groups.to_vec();
    let selected = groups.get_mut(group_index)?;
    selected.provider_id = Some(provider.clone());
    selected.account_query = Some(account_id.to_owned());
    let payload = serde_json::to_vec(&groups).ok()?;
    if payload.len() > 4_096 {
        return None;
    }
    let encoded = payload
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Some(format!("retry launch groups {encoded}"))
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
        DashboardChip::Done if count == 0 => "No agents have completed yet.".into(),
        DashboardChip::Done => format!(
            "Showing {count} completed {}.",
            if count == 1 { "agent" } else { "agents" }
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

fn same_running_targets(
    expected: &[kalcode_threads::runtime::RunningThreadTarget],
    current: &[kalcode_threads::runtime::RunningThreadTarget],
) -> bool {
    expected.len() == current.len()
        && expected.iter().all(|target| {
            current.iter().any(|candidate| {
                candidate.thread.id == target.thread.id && candidate.is_same_session(target)
            })
        })
}

fn stop_bound_targets(
    runtime: &ThreadRuntime,
    scope: &kalcode_contracts::kalvoice::ThreadScope,
    expected_count: Option<u8>,
) -> Result<Vec<BulkOutcome>, ExecError> {
    let targets = runtime
        .running_threads(scope)
        .map_err(|error| from_core(&error))?;
    if let Some(expected) = expected_count
        && targets.len() != usize::from(expected)
    {
        return Err(ExecError::new(
            "stop_count_mismatch",
            format!(
                "I found {} active agent {}, not {expected}. Nothing was stopped.",
                targets.len(),
                if targets.len() == 1 {
                    "session"
                } else {
                    "sessions"
                }
            ),
        ));
    }
    if targets.is_empty() {
        return Ok(
            if matches!(
                scope,
                kalcode_contracts::kalvoice::ThreadScope::Thread { .. }
            ) {
                runtime.stop_threads(scope)
            } else {
                Vec::new()
            },
        );
    }

    let current = runtime
        .running_threads(scope)
        .map_err(|error| from_core(&error))?;
    if !same_running_targets(&targets, &current) {
        return Err(ExecError::new(
            "stop_targets_changed",
            "The active agent sessions changed before KalCode could stop them. Nothing was stopped; try again.",
        ));
    }

    Ok(targets
        .iter()
        .map(|target| {
            let thread_id = target.thread.id.clone();
            match runtime.stop_running_thread(target) {
                Ok(_) => BulkOutcome {
                    thread_id,
                    ok: true,
                    message: None,
                },
                Err(error) => BulkOutcome {
                    thread_id,
                    ok: false,
                    message: Some(error.message),
                },
            }
        })
        .collect())
}

impl DesktopExecutor {
    fn threads(&self) -> Result<&Arc<ThreadRuntime>, ExecError> {
        self.threads.as_ref().ok_or_else(threads_unavailable)
    }

    /// The thread runtime with provider adapters registered, for operations that start or
    /// resume provider sessions.
    fn provider_threads(&self) -> Result<&Arc<ThreadRuntime>, ExecError> {
        let runtime = self.threads()?;
        if let Some(ensure) = &self.ensure_providers {
            ensure();
        }
        Ok(runtime)
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

    fn with_launch_account_choices(
        &self,
        error: ExecError,
        provider: &ProviderId,
        groups: &[ProviderPaneRequest],
        group_index: usize,
        workspace: &ResolvedWorkspace,
        query: Option<&str>,
    ) -> ExecError {
        let Some(group) = groups.get(group_index) else {
            return error;
        };
        let Ok(accounts) = AccountStore::new(self.core.clone()).list(Some(provider.as_str()))
        else {
            return error;
        };
        let candidates = if let Some(query) = query {
            matching_accounts(&accounts, provider, query)
        } else {
            accounts.iter().collect()
        };
        let mut choices = candidates
            .into_iter()
            .filter(|account| {
                account.archived_at.is_none()
                    && account.authentication_state != AuthState::NotAuthenticated
            })
            .filter_map(|account| {
                let retry_text = if groups.len() == 1 {
                    launch_retry_text(group, provider, &account.id)
                } else {
                    launch_retry_groups_text(groups, group_index, provider, &account.id)
                }?;
                Some(LaunchAccountChoice {
                    account_id: account.id.clone(),
                    label: if groups.len() == 1 {
                        account.display_name.clone()
                    } else {
                        format!(
                            "{} ({})",
                            account.display_name,
                            provider_display_name(provider)
                        )
                    },
                    retry_text,
                })
            })
            .collect::<Vec<_>>();
        if choices.len() < 2 {
            return error;
        }
        choices.sort_by(|left, right| {
            left.label
                .to_lowercase()
                .cmp(&right.label.to_lowercase())
                .then_with(|| left.account_id.cmp(&right.account_id))
        });
        ExecError::new("provider_account_ambiguous", "Which account?").with_directive(
            UiDirective::ChooseLaunchAccount {
                question: "Which account?".into(),
                choices,
                workspace_id: workspace.id.clone(),
            },
        )
    }

    fn with_launch_provider_choices(
        &self,
        error: ExecError,
        groups: &[ProviderPaneRequest],
        group_index: usize,
        workspace: &ResolvedWorkspace,
        available: &[ProviderOption],
    ) -> ExecError {
        let Some(group) = groups.get(group_index) else {
            return error;
        };
        let Ok(accounts) = AccountStore::new(self.core.clone()).list(None) else {
            return error;
        };
        let mut choices = accounts
            .iter()
            .filter(|account| {
                account.archived_at.is_none()
                    && account.authentication_state != AuthState::NotAuthenticated
            })
            .filter_map(|account| {
                let provider = available.iter().find(|option| {
                    option.id == account.provider_id
                        && [
                            ProviderId::CLAUDE_CODE,
                            ProviderId::CODEX,
                            ProviderId::GEMINI_CLI,
                        ]
                        .contains(&option.id.as_str())
                })?;
                let retry_text = if groups.len() == 1 {
                    launch_retry_text(group, &provider.id, &account.id)
                } else {
                    launch_retry_groups_text(groups, group_index, &provider.id, &account.id)
                }?;
                Some(LaunchAccountChoice {
                    account_id: account.id.clone(),
                    label: format!("{} ({})", account.display_name, provider.display_name),
                    retry_text,
                })
            })
            .collect::<Vec<_>>();
        if choices.len() < 2 {
            return error;
        }
        choices.sort_by(|left, right| {
            left.label
                .to_lowercase()
                .cmp(&right.label.to_lowercase())
                .then_with(|| left.account_id.cmp(&right.account_id))
        });
        ExecError::new("provider_account_ambiguous", "Which account?").with_directive(
            UiDirective::ChooseLaunchAccount {
                question: "Which account?".into(),
                choices,
                workspace_id: workspace.id.clone(),
            },
        )
    }

    fn contextual_provider(&self, ctx: &ExecContext) -> Option<ProviderId> {
        if let (Some(runtime), Some(thread_id)) = (self.threads.as_ref(), ctx.thread_id.as_deref())
            && let Ok(thread) = runtime.get(thread_id)
        {
            return Some(thread.provider_id);
        }
        (ctx.providers.len() == 1).then(|| ctx.providers[0].clone())
    }

    fn inferred_launch_provider(
        &self,
        group: &ProviderPaneRequest,
        workspace: &ResolvedWorkspace,
        provider_hint: Option<&ProviderId>,
        available: &[ProviderOption],
    ) -> Result<Option<ProviderId>, ExecError> {
        if let Some(provider) = group.provider_id.as_ref() {
            return Ok(Some(provider.clone()));
        }
        let supported = |provider: &ProviderId| {
            available.iter().any(|option| &option.id == provider)
                && [
                    ProviderId::CLAUDE_CODE,
                    ProviderId::CODEX,
                    ProviderId::GEMINI_CLI,
                ]
                .contains(&provider.as_str())
        };
        let store = AccountStore::new(self.core.clone());
        let accounts = store.list(None).map_err(|error| from_core(&error))?;
        let eligible = |account: &&ProviderAccount| {
            account.archived_at.is_none()
                && account.authentication_state != AuthState::NotAuthenticated
                && supported(&account.provider_id)
        };
        let unique_provider = |providers: Vec<ProviderId>| {
            let mut providers = providers;
            providers.sort_by(|left, right| left.as_str().cmp(right.as_str()));
            providers.dedup();
            (providers.len() == 1).then(|| providers.remove(0))
        };

        if let Some(query) = group.account_query.as_deref() {
            if let Some(account_id) = explicit_account_id(query) {
                let account = store.get(&account_id).map_err(|error| from_core(&error))?;
                return Ok(supported(&account.provider_id).then_some(account.provider_id));
            }
            let providers = available
                .iter()
                .flat_map(|option| matching_accounts(&accounts, &option.id, query))
                .map(|account| account.provider_id.clone())
                .collect();
            if let Some(provider) = unique_provider(providers) {
                return Ok(Some(provider));
            }
            let spoken = label_words(query);
            let named = available
                .iter()
                .filter(|option| without_provider(&spoken, &option.id).len() < spoken.len())
                .map(|option| option.id.clone())
                .collect();
            if let Some(provider) = unique_provider(named) {
                return Ok(Some(provider));
            }
            // A spoken account is explicit. If it did not identify exactly one provider, never
            // fall through to the focused/default provider and launch under another account.
            return Ok(None);
        }
        if let Some(provider) = provider_hint {
            return Ok(Some(provider.clone()));
        }

        let bindings = store
            .list_bindings(
                None,
                Some(ProviderAccountBindingKind::Workspace),
                Some(&workspace.id),
            )
            .map_err(|error| from_core(&error))?;
        let providers = bindings
            .iter()
            .filter_map(|binding| {
                accounts
                    .iter()
                    .find(|account| account.id == binding.account_id)
            })
            .filter(eligible)
            .map(|account| account.provider_id.clone())
            .collect();
        if let Some(provider) = unique_provider(providers) {
            return Ok(Some(provider));
        }

        let defaults = accounts
            .iter()
            .filter(eligible)
            .filter(|account| account.is_default)
            .map(|account| account.provider_id.clone())
            .collect();
        if let Some(provider) = unique_provider(defaults) {
            return Ok(Some(provider));
        }
        let connected = accounts
            .iter()
            .filter(eligible)
            .map(|account| account.provider_id.clone())
            .collect();
        if let Some(provider) = unique_provider(connected) {
            return Ok(Some(provider));
        }
        let providers = available
            .iter()
            .filter(|option| supported(&option.id))
            .map(|option| option.id.clone())
            .collect();
        Ok(unique_provider(providers))
    }

    fn prepare_provider_panes(
        &self,
        groups: &[ProviderPaneRequest],
        workspace_id: Option<&str>,
        provider_hint: Option<&ProviderId>,
    ) -> Result<(ResolvedWorkspace, Vec<PreparedProviderLaunch>), ExecError> {
        let total: usize = groups.iter().map(|g| usize::from(g.count)).sum();
        if total == 0 || total > 16 || groups.iter().any(|g| g.count == 0) {
            return Err(ExecError::new(
                "invalid_thread_count",
                "Open between 1 and 16 provider sessions at a time.",
            ));
        }
        let runtime = self.provider_threads()?;
        let workspace = self.target_workspace(workspace_id)?;
        let options = runtime.options().map_err(|e| from_core(&e))?;
        // Resolve every account before starting anything: an unknown label in a later group
        // must not silently start earlier groups under a different/default account.
        let mut requests = Vec::new();
        for (group_index, group) in groups.iter().enumerate() {
            let inferred_provider = self.inferred_launch_provider(
                group,
                &workspace,
                provider_hint,
                &options.providers,
            )?;
            let provider = inferred_provider.as_ref().ok_or_else(|| {
                self.with_launch_provider_choices(
                    ExecError::new(
                        "provider_required",
                        "Choose Claude Code, Codex, or Gemini for these sessions.",
                    ),
                    groups,
                    group_index,
                    &workspace,
                    &options.providers,
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
            let model = validate_launch_model(provider, available, group.model.as_deref())?;
            let effort = validate_launch_effort(provider, group.effort.as_deref())?;
            let explicit_id = if let Some(query) = group.account_query.as_deref() {
                if let Some(account_id) = explicit_account_id(query) {
                    Some(account_id)
                } else {
                    match self.spoken_account(provider, query) {
                        Ok(account) => Some(account.id),
                        Err(error) => {
                            return Err(self.with_launch_account_choices(
                                error,
                                provider,
                                groups,
                                group_index,
                                &workspace,
                                Some(query),
                            ));
                        }
                    }
                }
            } else {
                let valid = AccountStore::new(self.core.clone())
                    .list(Some(provider.as_str()))
                    .map_err(|error| from_core(&error))?
                    .into_iter()
                    .filter(|account| {
                        account.archived_at.is_none()
                            && account.authentication_state != AuthState::NotAuthenticated
                    })
                    .collect::<Vec<_>>();
                (valid.len() == 1).then(|| valid[0].id.clone())
            };
            let account = crate::thread_commands::resolve_creation_account(
                &self.core,
                provider.as_str(),
                &workspace.id,
                explicit_id.as_deref(),
                None,
            )
            .map_err(|error| {
                self.with_launch_account_choices(
                    from_core(&error),
                    provider,
                    groups,
                    group_index,
                    &workspace,
                    None,
                )
            })?;
            if account
                .as_ref()
                .is_some_and(|account| account.authentication_state == AuthState::NotAuthenticated)
            {
                return Err(ExecError::new(
                    "provider_account_signed_out",
                    "That provider account is signed out. Sign in under Providers, then try again.",
                ));
            }
            let idle = CreateIdleThread {
                provider_id: provider.to_string(),
                provider_account_id: account.as_ref().map(|a| a.id.clone()),
                account_label: account.as_ref().map(|a| a.display_name.clone()),
                workspace_id: workspace.id.clone(),
                model,
                effort,
                permission_mode: PermissionMode::Approve,
                name: None,
            };
            if group.assignments.is_empty() {
                requests
                    .extend((0..group.count).map(|_| PreparedProviderLaunch::Idle(idle.clone())));
            } else {
                let assigned: u32 = group
                    .assignments
                    .iter()
                    .map(|assignment| u32::from(assignment.count))
                    .sum();
                if assigned != u32::from(group.count)
                    || group.assignments.iter().any(|assignment| {
                        assignment.count == 0 || assignment.task.trim().is_empty()
                    })
                {
                    return Err(ExecError::new(
                        "launch_assignment_count_mismatch",
                        "The assignment counts must match the number of agents.",
                    ));
                }
                for assignment in &group.assignments {
                    let prompt = format!("Work on the {}.", assignment.task.trim());
                    requests.extend((0..assignment.count).map(|_| {
                        PreparedProviderLaunch::Assigned(CreateThread {
                            provider_id: idle.provider_id.clone(),
                            provider_account_id: idle.provider_account_id.clone(),
                            account_label: idle.account_label.clone(),
                            workspace_id: idle.workspace_id.clone(),
                            model: idle.model.clone(),
                            effort: idle.effort.clone(),
                            permission_mode: idle.permission_mode,
                            prompt: prompt.clone(),
                            name: None,
                        })
                    }));
                }
            }
        }
        // Review every first prompt before any provider starts. A warning in a later assignment
        // therefore cannot leave earlier agents running, and the voice path never owns a
        // replayable confirmation handle.
        for request in requests.iter().filter_map(|request| match request {
            PreparedProviderLaunch::Assigned(request) => Some(request),
            PreparedProviderLaunch::Idle(_) => None,
        }) {
            if let PromptReview::ConfirmationRequired(warning) = runtime
                .review_create_prompt(request)
                .map_err(|error| from_core(&error))?
            {
                let _ = runtime.cancel_prompt_review(&warning.review_id);
                return Err(ExecError::new(
                    "context_prompt_confirmation_required",
                    "That agent task contains information KalCode requires you to review before sending.",
                ));
            }
        }
        Ok((workspace, requests))
    }

    fn prepare_recent_launch(
        &self,
        provider_id: &ProviderId,
        model: &str,
        effort: &str,
        ctx: &ExecContext,
    ) -> Result<(Vec<RuntimeLaunchInstance>, String, String), ExecError> {
        if ctx.last_launch_instances.is_empty() {
            return Err(ExecError::new(
                "recent_launch_missing",
                "Launch the sessions first, then say which model and effort to use for all of them.",
            ));
        }
        let runtime = self.provider_threads()?;
        let requested_ids = ctx
            .last_launch_instances
            .iter()
            .map(|instance| instance.thread_id.clone())
            .collect::<Vec<_>>();
        let current = runtime
            .launch_instances(&requested_ids)
            .map_err(|error| from_core(&error))?;
        let targets = ctx
            .last_launch_instances
            .iter()
            .map(|expected| {
                let current = current
                    .iter()
                    .find(|candidate| candidate.thread_id == expected.thread_id)
                    .ok_or_else(|| {
                        ExecError::new(
                            "recent_launch_changed",
                            "One of those sessions changed after KalVoice launched it. Nothing was changed.",
                        )
                    })?;
                if current.generation != expected.generation {
                    return Err(ExecError::new(
                        "recent_launch_changed",
                        "One of those sessions changed after KalVoice launched it. Nothing was changed.",
                    ));
                }
                Ok(RuntimeLaunchInstance {
                    thread_id: expected.thread_id.clone(),
                    generation: expected.generation,
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        for target in &targets {
            let thread = runtime
                .get(&target.thread_id)
                .map_err(|error| from_core(&error))?;
            if thread.provider_id != *provider_id {
                return Err(ExecError::new(
                    "recent_launch_provider_mismatch",
                    "Those sessions are not all using the requested provider. Nothing was changed.",
                ));
            }
            if ctx
                .workspace_id
                .as_ref()
                .is_some_and(|workspace_id| &thread.workspace_id != workspace_id)
            {
                return Err(ExecError::new(
                    "recent_launch_workspace_changed",
                    "Those sessions are no longer in this workspace. Nothing was changed.",
                ));
            }
        }
        let options = runtime.options().map_err(|error| from_core(&error))?;
        let available = options
            .providers
            .iter()
            .find(|provider| provider.id == *provider_id)
            .ok_or_else(|| {
                ExecError::new(
                    "provider_unavailable",
                    "That provider is not ready. Check Providers and try again.",
                )
            })?;
        let model = validate_launch_model(provider_id, available, Some(model))?
            .ok_or_else(|| ExecError::new("invalid_model", "Choose a model for those sessions."))?;
        let effort = validate_launch_effort(provider_id, Some(effort))?.ok_or_else(|| {
            ExecError::new(
                "invalid_effort",
                "Choose an effort level for those sessions.",
            )
        })?;
        Ok((targets, model, effort))
    }

    fn create_provider_panes(
        &self,
        groups: &[ProviderPaneRequest],
        workspace_id: Option<&str>,
        provider_hint: Option<&ProviderId>,
    ) -> Result<Executed, ExecError> {
        let (workspace, requests) =
            self.prepare_provider_panes(groups, workspace_id, provider_hint)?;
        let runtime = self.threads()?;
        let sessions_dir = self.core.paths().data_dir.join("sessions");
        let total = requests.len();
        let mut started_ids = Vec::new();
        let mut created_ids = Vec::new();
        let mut queued = 0usize;
        let mut failed = 0usize;
        let mut first_error = None;
        for request in requests {
            match crate::provider_pane_commands::create_pane_thread(
                runtime,
                &sessions_dir,
                |thread_id| match request {
                    PreparedProviderLaunch::Idle(request) => {
                        runtime.create_idle_with_id(thread_id, request)
                    }
                    PreparedProviderLaunch::Assigned(request) => {
                        runtime.create_with_id(thread_id, request)
                    }
                },
            ) {
                Ok(thread) => {
                    created_ids.push(thread.id.clone());
                    if thread.status == ThreadStatus::Failed {
                        failed += 1;
                    } else if thread.status == ThreadStatus::WaitingForDependency {
                        queued += 1;
                    } else {
                        started_ids.push(thread.id);
                    }
                }
                Err(error) => {
                    failed += 1;
                    first_error.get_or_insert(error);
                }
            }
        }
        let instances = if created_ids.len() == total {
            runtime
                .launch_instances(&created_ids)
                .map(|instances| {
                    instances
                        .into_iter()
                        .map(|instance| LaunchThreadInstance {
                            thread_id: instance.thread_id,
                            generation: instance.generation,
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        } else {
            // A follow-up must name the complete requested group. If a request failed before a
            // thread identity existed, remember no subset and fail closed on "all of them".
            Vec::new()
        };
        if started_ids.is_empty() && queued == 0 {
            let message = if let Some(error) = first_error.as_ref() {
                format!(
                    "None of the {total} sessions started in {}. {}",
                    workspace.name, error.message
                )
            } else {
                format!(
                    "None of the {total} sessions started in {}. Open the failed sessions to review the provider error.",
                    workspace.name
                )
            };
            let mut error = ExecError::new("threads_failed", message);
            if !created_ids.is_empty() {
                error = error.with_directive(UiDirective::OpenProviderPanes {
                    workspace_id: workspace.id,
                    thread_ids: created_ids,
                    instances,
                });
            }
            return Err(error);
        }
        let summary = if queued == total {
            format!(
                "Queued {} in {}; they are waiting for resources.",
                plural(queued, "session", "sessions"),
                workspace.name
            )
        } else if started_ids.len() == total {
            format!(
                "Started {} in {}.",
                plural(started_ids.len(), "session", "sessions"),
                workspace.name
            )
        } else {
            format!(
                "Started {} of {total} sessions in {}. {queued} queued; {failed} failed to start.",
                started_ids.len(),
                workspace.name,
            )
        };
        Ok(Executed {
            summary,
            directive: Some(UiDirective::OpenProviderPanes {
                workspace_id: workspace.id,
                thread_ids: created_ids,
                instances,
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

/// How strictly a spoken session name must resolve before KalVoice acts on it (P3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TargetUse {
    /// Open or focus: any unique answer, including a unique partial name or provider.
    Open,
    /// Put the person's words in a thread's composer: only an exact name (alone or with its
    /// provider/account words), an id, the focused thread or the remembered one goes direct; a
    /// partial or misheard name or a provider alone is confirmed first, even when only one
    /// thread fits in any workspace.
    Compose,
    /// Pause, stop, resume or switch the account of a thread: never a partial name or a
    /// provider alone, and never a guess between several.
    Destructive,
}

fn target_use(intent: &KalVoiceIntent) -> TargetUse {
    match intent {
        KalVoiceIntent::PauseThreads { .. }
        | KalVoiceIntent::ResumeThreads { .. }
        | KalVoiceIntent::StopThreads { .. }
        | KalVoiceIntent::RebindThreadAccount { .. } => TargetUse::Destructive,
        KalVoiceIntent::DirectPrompt { .. } => TargetUse::Compose,
        _ => TargetUse::Open,
    }
}

/// "pause" / "stop" …: what a destructive command does, for "say its full name to … it".
fn destructive_verb(intent: &KalVoiceIntent) -> &'static str {
    match intent {
        KalVoiceIntent::PauseThreads { .. } => "pause",
        KalVoiceIntent::ResumeThreads { .. } => "resume",
        KalVoiceIntent::StopThreads { .. } => "stop",
        _ => "switch",
    }
}

/// A thread that is stopped or paused: its composer would resume it ("Resume and send").
fn is_stopped(status: ThreadStatus) -> bool {
    matches!(
        status,
        ThreadStatus::Paused
            | ThreadStatus::Completed
            | ThreadStatus::Failed
            | ThreadStatus::Interrupted
    )
}

fn permission_pending(thread: &ThreadSummary) -> bool {
    thread.status == ThreadStatus::WaitingForPermission || thread.pending_approvals > 0
}

fn permission_pending_error(thread: &ThreadSummary) -> ExecError {
    ExecError::new(
        "permission_pending",
        format!(
            "\u{201c}{}\u{201d} is waiting for your permission. Answer it first; KalVoice doesn't send to a thread while a permission request is open.",
            thread.name
        ),
    )
}

/// Whether a thread in `thread`'s state counts as `state`. "Waiting for you" includes a
/// pending permission request: both wait on the person.
fn attention_matches(state: SessionAttention, thread: &ThreadSummary) -> bool {
    match state {
        SessionAttention::WaitingForPermission => permission_pending(thread),
        SessionAttention::WaitingForYou => {
            state.matches(thread.status) || permission_pending(thread)
        }
        other => other.matches(thread.status),
    }
}

/// "Which one — Auth or Release Mac?" for several sessions found by state or name.
fn choose_session(
    question: String,
    threads: &[&ThreadSummary],
    follow_up: SessionFollowUp,
) -> UiDirective {
    UiDirective::ChooseSession {
        question,
        choices: threads
            .iter()
            .take(MAX_SESSION_CHOICES)
            .map(|t| session_resolver::candidate(t))
            .collect(),
        follow_up,
    }
}

/// Labels for a spoken list: names, or "Name · Provider · Account" when names repeat.
fn spoken_labels(threads: &[&ThreadSummary]) -> Vec<String> {
    let mut names: Vec<String> = threads.iter().map(|t| t.name.to_lowercase()).collect();
    names.sort();
    names.dedup();
    if names.len() == threads.len() {
        threads.iter().map(|t| t.name.clone()).collect()
    } else {
        threads
            .iter()
            .map(|t| session_resolver::session_label(t))
            .collect()
    }
}

/// One bounded, owner-visible scene label for the offline selector. It deliberately excludes
/// ids, terminal output, messages, paths and provider responses.
fn local_scene_label(thread: &ThreadSummary) -> String {
    let safe = |value: &str| {
        let value = value.trim();
        (!value.is_empty()
            && value.chars().all(|character| {
                !character.is_control()
                    && !matches!(
                        character,
                        '\u{202a}'
                            ..='\u{202e}' | '\u{2066}'
                            ..='\u{2069}' | '\u{200e}' | '\u{200f}'
                    )
            }))
        .then(|| value.chars().take(96).collect::<String>())
    };
    let mut parts = Vec::new();
    for value in [
        safe(&thread.name),
        safe(&thread.provider_name),
        thread.account_label.as_deref().and_then(safe),
        safe(&thread.workspace_name),
        thread.model.as_deref().and_then(safe),
        thread.effort.as_deref().and_then(safe),
        thread.current_activity.as_deref().and_then(safe),
    ]
    .into_iter()
    .flatten()
    {
        parts.push(value);
    }
    parts.push(format!("{:?}", thread.status));
    let label = format!("Open {}", parts.join(" · "));
    label.chars().take(480).collect()
}

impl DesktopExecutor {
    /// Open threads (the store listing, most recent first), current workspace first.
    fn open_threads(&self, workspace_id: Option<&str>) -> Result<Vec<ThreadSummary>, ExecError> {
        let mut threads = self
            .threads()?
            .list(None, false)
            .map_err(|e| from_core(&e))?;
        threads.sort_by_key(|t| workspace_id.is_none_or(|w| t.workspace_id != w));
        Ok(threads)
    }

    /// The one open thread a spoken name means (session resolver, P3). Never guesses: several
    /// fits, or a fit too loose for `use_`, is a "Which one?" refusal whose `ChooseSession`
    /// directive runs `follow_up` on the session the person picks.
    fn resolve_session(
        &self,
        query: &str,
        use_: TargetUse,
        ctx: &ExecContext,
        follow_up: SessionFollowUp,
        verb: &str,
    ) -> Result<ThreadSummary, ExecError> {
        let threads = self
            .threads()?
            .list(None, false)
            .map_err(|e| from_core(&e))?;
        // "There" points at the session in front, like "it".
        let query = if query.trim().eq_ignore_ascii_case("there") {
            "it"
        } else {
            query
        };
        let resolution = session_resolver::resolve(
            &threads,
            query,
            &ResolveContext {
                workspace_id: ctx.workspace_id.as_deref(),
                focused_thread_id: ctx.thread_id.as_deref(),
                last_target_id: ctx.last_target_id.as_deref(),
            },
        );
        match resolution {
            SessionResolution::Resolved { target, tier } => {
                let loose = match use_ {
                    TargetUse::Open => false,
                    // A prompt is sent without further review, so only a name the person
                    // said exactly (or the session in front of them / just used) goes direct:
                    // a partial or misheard name, or a provider alone, is confirmed first.
                    TargetUse::Compose => matches!(
                        tier,
                        SessionMatchTier::ProviderOnly | SessionMatchTier::Fuzzy
                    ),
                    TargetUse::Destructive => {
                        matches!(
                            tier,
                            SessionMatchTier::ProviderOnly | SessionMatchTier::Fuzzy
                        )
                    }
                };
                if loose {
                    let question = if use_ == TargetUse::Destructive {
                        format!(
                            "Did you mean \u{201c}{}\u{201d}? Say its full name to {verb} it.",
                            target.name
                        )
                    } else {
                        format!("Did you mean \u{201c}{}\u{201d}?", target.label)
                    };
                    return Err(ExecError::new("target_unconfirmed", question.clone())
                        .with_directive(UiDirective::ChooseSession {
                            question,
                            choices: vec![target],
                            follow_up,
                        }));
                }
                threads
                    .into_iter()
                    .find(|t| t.id == target.thread_id)
                    .ok_or_else(|| {
                        ExecError::new("thread_not_found", "That thread is no longer open.")
                    })
            }
            SessionResolution::Ambiguous {
                question, choices, ..
            } => Err(
                ExecError::new("target_ambiguous", question.clone()).with_directive(
                    UiDirective::ChooseSession {
                        question,
                        choices,
                        follow_up,
                    },
                ),
            ),
            SessionResolution::NotFound { message } => {
                Err(if session_resolver::is_pronoun(query) {
                    ExecError::new("target_unclear", message)
                } else {
                    ExecError::new(
                        "thread_not_found",
                        format!(
                            "KalCode has no open thread named \u{201c}{}\u{201d}.",
                            query.trim()
                        ),
                    )
                })
            }
        }
    }

    /// The thread in front of the person ("send that", "clear that").
    fn focused_thread(&self, ctx: &ExecContext) -> Result<ThreadSummary, ExecError> {
        let id = ctx.thread_id.as_deref().ok_or_else(|| {
            ExecError::new(
                "thread_not_focused",
                "Click a thread first, then say \u{201c}send that\u{201d} or \u{201c}clear that\u{201d}.",
            )
        })?;
        let thread = self.threads()?.get(id).map_err(|e| from_core(&e))?;
        if thread.archived_at.is_some() {
            return Err(ExecError::new(
                "thread_archived",
                "That thread is archived. Restore it first.",
            ));
        }
        Ok(thread)
    }

    /// "Send that": the focused thread's composer presses its own Send. Refused while a
    /// permission is pending and for a stopped thread (its Send would resume it).
    fn prepare_submit(&self, ctx: &ExecContext) -> Result<ThreadSummary, ExecError> {
        let thread = self.focused_thread(ctx)?;
        if permission_pending(&thread) {
            return Err(permission_pending_error(&thread));
        }
        if is_stopped(thread.status) {
            return Err(ExecError::new(
                "thread_stopped",
                format!(
                    "\u{201c}{}\u{201d} is stopped. KalVoice doesn't resume threads; press Resume and send yourself.",
                    thread.name
                ),
            ));
        }
        Ok(thread)
    }

    /// "Tell <target> <prompt>": the thread, and whether its composer may press Send (never for
    /// a stopped thread: KalVoice doesn't resume by voice).
    fn prepare_direct_prompt(
        &self,
        target: &str,
        prompt: &str,
        ctx: &ExecContext,
    ) -> Result<(ThreadSummary, bool), ExecError> {
        if prompt.trim().is_empty() {
            return Err(ExecError::new(
                "prompt_missing",
                "Say what to tell the thread, for example \u{201c}tell Auth to run the tests\u{201d}.",
            ));
        }
        let thread = self.resolve_session(
            target,
            TargetUse::Compose,
            ctx,
            SessionFollowUp::Compose {
                text: prompt.to_owned(),
                submit: true,
            },
            "send to",
        )?;
        if permission_pending(&thread) {
            return Err(permission_pending_error(&thread));
        }
        let submit = !is_stopped(thread.status);
        Ok((thread, submit))
    }

    /// Open threads in `state`, current workspace first.
    fn threads_in_state(
        &self,
        state: SessionAttention,
        ctx: &ExecContext,
    ) -> Result<Vec<ThreadSummary>, ExecError> {
        Ok(self
            .open_threads(ctx.workspace_id.as_deref())?
            .into_iter()
            .filter(|t| attention_matches(state, t))
            .collect())
    }

    /// "Focus the one waiting for permission": exactly one, or a "Which one?" choice.
    fn prepare_focus_by_state(
        &self,
        state: SessionAttention,
        ctx: &ExecContext,
    ) -> Result<ThreadSummary, ExecError> {
        let found = self.threads_in_state(state, ctx)?;
        match found.as_slice() {
            [] => Err(ExecError::new(
                "session_not_found",
                match state {
                    SessionAttention::WaitingForPermission => {
                        "No thread is waiting for permission."
                    }
                    SessionAttention::WaitingForYou => "No thread is waiting for you.",
                    SessionAttention::Failed => "No thread has failed.",
                    SessionAttention::Stuck => "No thread is stuck.",
                },
            )),
            [one] => Ok(one.clone()),
            many => {
                let shown: Vec<&ThreadSummary> = many.iter().take(MAX_SESSION_CHOICES).collect();
                let mut question = format!(
                    "Which one \u{2014} {}?",
                    or_list_owned(&spoken_labels(&shown))
                );
                if many.len() > shown.len() {
                    question.push_str(&format!(
                        " {} threads match; say the name of the one you want.",
                        many.len()
                    ));
                }
                Err(ExecError::new("target_ambiguous", question.clone())
                    .with_directive(choose_session(question, &shown, SessionFollowUp::Open)))
            }
        }
    }

    /// "Which agent failed?": up to three names, the rest counted.
    fn which_sessions(
        &self,
        state: SessionAttention,
        ctx: &ExecContext,
    ) -> Result<Executed, ExecError> {
        let found = self.threads_in_state(state, ctx)?;
        let refs: Vec<&ThreadSummary> = found.iter().collect();
        let shown = &refs[..refs.len().min(3)];
        let summary = if found.is_empty() {
            match state {
                SessionAttention::WaitingForPermission => {
                    "No threads are waiting for permission.".to_owned()
                }
                SessionAttention::WaitingForYou => "Nothing is waiting for you.".to_owned(),
                SessionAttention::Failed => "No threads have failed.".to_owned(),
                SessionAttention::Stuck => "No threads are stuck.".to_owned(),
            }
        } else {
            let verb = match (state, found.len()) {
                (SessionAttention::Failed, _) => "failed".to_owned(),
                (_, 1) => format!("is {}", state.phrase()),
                _ => format!("are {}", state.phrase()),
            };
            let mut names = spoken_labels(shown);
            let more = found.len() - shown.len();
            if more > 0 {
                names.push(format!("{more} more"));
            }
            format!(
                "{} {verb}: {}.",
                plural(found.len(), "thread", "threads"),
                and_list(&names)
            )
        };
        let directive = match state {
            SessionAttention::WaitingForPermission if self.permissions.is_some() => {
                Some(UiDirective::ShowApprovals)
            }
            SessionAttention::WaitingForPermission
            | SessionAttention::WaitingForYou
            | SessionAttention::Failed => Some(UiDirective::FilterDashboard {
                chip: DashboardChip::WaitingForYou,
            }),
            SessionAttention::Stuck => None,
        };
        Ok(Executed { summary, directive })
    }

    /// Resolves the sessions an intent names, before anything counts.
    fn check_sessions(&self, intent: &KalVoiceIntent, ctx: &ExecContext) -> Result<(), ExecError> {
        match intent {
            KalVoiceIntent::OpenThread { query } | KalVoiceIntent::Focus { query } => self
                .resolve_session(query, TargetUse::Open, ctx, SessionFollowUp::Open, "open")
                .map(|_| ()),
            KalVoiceIntent::RequestPermissionMode {
                thread_query: Some(query),
                ..
            } => self
                .resolve_session(query, TargetUse::Open, ctx, SessionFollowUp::Open, "open")
                .map(|_| ()),
            KalVoiceIntent::DirectPrompt { target, prompt } => {
                self.prepare_direct_prompt(target, prompt, ctx).map(|_| ())
            }
            KalVoiceIntent::SubmitFocused => self.prepare_submit(ctx).map(|_| ()),
            KalVoiceIntent::ClearFocused => self.focused_thread(ctx).map(|_| ()),
            KalVoiceIntent::FocusByState { state } => {
                self.prepare_focus_by_state(*state, ctx).map(|_| ())
            }
            KalVoiceIntent::RebindThreadAccount {
                thread_query,
                provider_id,
                account_query,
            } => {
                if thread_query
                    .as_deref()
                    .is_some_and(|q| !q.trim().is_empty())
                {
                    self.prepare_rebind(
                        thread_query.as_deref(),
                        provider_id.as_ref(),
                        account_query,
                        ctx,
                    )?;
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }

    /// Search by voice: names and statuses are read back, never content (LOC-04).
    fn search(&self, query: &str) -> Result<Executed, ExecError> {
        if !self.session_locator_enabled {
            return Err(search_not_in_this_build());
        }
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

fn or_list_owned(labels: &[String]) -> String {
    or_list(&labels.iter().map(String::as_str).collect::<Vec<_>>())
}

/// "A and B" / "A, B and C".
fn and_list(labels: &[String]) -> String {
    match labels {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
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

    /// The thread a rebind means: the named one (never a partial or ambiguous name), else the
    /// one the person is looking at.
    fn rebind_thread(
        &self,
        thread_query: Option<&str>,
        ctx: &ExecContext,
    ) -> Result<ThreadSummary, ExecError> {
        let runtime = self.threads()?;
        if let Some(query) = thread_query.map(str::trim).filter(|q| !q.is_empty()) {
            return self.resolve_session(
                query,
                TargetUse::Destructive,
                ctx,
                SessionFollowUp::Open,
                "switch",
            );
        }
        let id = ctx.thread_id.as_deref().ok_or_else(|| {
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
        ctx: &ExecContext,
    ) -> Result<(ThreadSummary, ProviderAccount), ExecError> {
        let thread = self.rebind_thread(thread_query, ctx)?;
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

    fn local_reasoning_actions(
        &self,
        request: &str,
        ctx: &ExecContext,
    ) -> Result<Vec<LocalActionGrounding>, ExecError> {
        if !session_resolver::is_locating_query(request) {
            return Ok(Vec::new());
        }
        let Some(runtime) = &self.threads else {
            return Ok(Vec::new());
        };
        let threads = runtime
            .list(None, false)
            .map_err(|error| from_core(&error))?;
        let resolution = session_resolver::resolve(
            &threads,
            request,
            &ResolveContext {
                workspace_id: ctx.workspace_id.as_deref(),
                focused_thread_id: ctx.thread_id.as_deref(),
                last_target_id: ctx.last_target_id.as_deref(),
            },
        );
        let actions = match resolution {
            SessionResolution::Resolved { target, .. } => {
                let Some(thread) = threads.iter().find(|thread| thread.id == target.thread_id)
                else {
                    return Ok(Vec::new());
                };
                vec![LocalActionGrounding {
                    label: local_scene_label(thread),
                    intent: KalVoiceIntent::OpenThread {
                        query: target.thread_id,
                    },
                }]
            }
            SessionResolution::Ambiguous { choices, .. } => {
                let labels = choices
                    .iter()
                    .filter_map(|choice| {
                        threads
                            .iter()
                            .find(|thread| thread.id == choice.thread_id)
                            .map(local_scene_label)
                    })
                    .collect::<Vec<_>>();
                if labels.is_empty() {
                    return Ok(Vec::new());
                }
                let label = format!("Open matching agent; ask which one: {}", labels.join("; "))
                    .chars()
                    .take(480)
                    .collect();
                vec![LocalActionGrounding {
                    label,
                    intent: KalVoiceIntent::OpenThread {
                        query: request.to_owned(),
                    },
                }]
            }
            // No lexical task-context fit: give the existing local selector a bounded live scene
            // so it can resolve semantic paraphrases (for example "site" versus "website").
            // Known host ambiguities were handled above and still go through ChooseSession.
            SessionResolution::NotFound { .. } => {
                let current = ctx.workspace_id.as_deref();
                threads
                    .iter()
                    .filter(|thread| current == Some(thread.workspace_id.as_str()))
                    .chain(
                        threads
                            .iter()
                            .filter(|thread| current != Some(thread.workspace_id.as_str())),
                    )
                    .take(MAX_GROUNDED_ACTION_CANDIDATES)
                    .map(|thread| LocalActionGrounding {
                        label: local_scene_label(thread),
                        intent: KalVoiceIntent::OpenThread {
                            query: thread.id.clone(),
                        },
                    })
                    .collect()
            }
        };
        Ok(actions)
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

    /// A thread by name through the session resolver, only when exactly one open thread fits
    /// by id, exact name or provider/account + name (never a first match).
    fn find_thread(&self, name: &str) -> Result<Option<String>, ExecError> {
        let threads = self
            .threads()?
            .list(None, false)
            .map_err(|e| from_core(&e))?;
        Ok(
            match session_resolver::resolve(&threads, name, &ResolveContext::default()) {
                SessionResolution::Resolved { target, tier }
                    if !matches!(
                        tier,
                        SessionMatchTier::ProviderOnly | SessionMatchTier::Fuzzy
                    ) =>
                {
                    Some(target.thread_id)
                }
                _ => None,
            },
        )
    }

    fn check_with_context(
        &self,
        intent: &KalVoiceIntent,
        ctx: &ExecContext,
    ) -> Result<(), ExecError> {
        let provider_hint = self.contextual_provider(ctx);
        match intent {
            KalVoiceIntent::CreateThreads {
                provider_id,
                count,
                workspace_id,
                account_query,
                model,
                effort,
                assignments,
            } => self
                .prepare_provider_panes(
                    &[ProviderPaneRequest {
                        provider_id: Some(provider_id.clone()),
                        count: *count,
                        account_query: account_query.clone(),
                        model: model.clone(),
                        effort: effort.clone(),
                        assignments: assignments.clone(),
                    }],
                    workspace_id.as_deref().or(ctx.workspace_id.as_deref()),
                    provider_hint.as_ref(),
                )
                .map(|_| ())?,
            KalVoiceIntent::CreateProviderPanes {
                groups,
                workspace_id,
            } => self
                .prepare_provider_panes(
                    groups,
                    workspace_id.as_deref().or(ctx.workspace_id.as_deref()),
                    provider_hint.as_ref(),
                )
                .map(|_| ())?,
            KalVoiceIntent::ConfigureRecentLaunch {
                provider_id,
                model,
                effort,
            } => self
                .prepare_recent_launch(provider_id, model, effort, ctx)
                .map(|_| ())?,
            _ => self.check(intent)?,
        }
        self.check_sessions(intent, ctx)
    }

    fn resolve_thread_target(
        &self,
        name: &str,
        intent: &KalVoiceIntent,
        ctx: &ExecContext,
    ) -> Result<Option<String>, ExecError> {
        self.resolve_session(
            name,
            target_use(intent),
            ctx,
            SessionFollowUp::Open,
            destructive_verb(intent),
        )
        .map(|thread| Some(thread.id))
    }

    fn names_one_session(&self, query: &str, ctx: &ExecContext) -> bool {
        self.resolve_session(
            query,
            TargetUse::Compose,
            ctx,
            SessionFollowUp::Open,
            "send to",
        )
        .is_ok()
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
                account_query,
                model,
                effort,
                assignments,
            } => self
                .prepare_provider_panes(
                    &[ProviderPaneRequest {
                        provider_id: Some(provider_id.clone()),
                        count: *count,
                        account_query: account_query.clone(),
                        model: model.clone(),
                        effort: effort.clone(),
                        assignments: assignments.clone(),
                    }],
                    workspace_id.as_deref(),
                    None,
                )
                .map(|_| ()),
            KalVoiceIntent::CreateProviderPanes {
                groups,
                workspace_id,
            } => self
                .prepare_provider_panes(groups, workspace_id.as_deref(), None)
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
            | KalVoiceIntent::StatusReport
            | KalVoiceIntent::SubmitFocused
            | KalVoiceIntent::ClearFocused
            | KalVoiceIntent::DirectPrompt { .. }
            | KalVoiceIntent::FocusByState { .. }
            | KalVoiceIntent::WhichSessions { .. } => self.threads().map(|_| ()),
            KalVoiceIntent::ConfigureRecentLaunch { .. } => self.threads().map(|_| ()),
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
            KalVoiceIntent::Search { .. } if !self.session_locator_enabled => {
                Err(search_not_in_this_build())
            }
            KalVoiceIntent::Search { .. } if self.locator.is_none() => Err(search_unavailable()),
            KalVoiceIntent::SwitchProvider { .. } => Err(ExecError::new(
                "not_in_this_build",
                "Provider switching isn't in this build yet, so KalVoice can't do that.",
            )),
            // A named thread is resolved with the request's context (`check_with_context`); a
            // provider-led account is checked here, so an unknown name is refused before
            // anything counts.
            KalVoiceIntent::RebindThreadAccount {
                thread_query,
                provider_id,
                account_query,
            } => {
                self.threads()?;
                if thread_query.as_deref().is_none_or(|q| q.trim().is_empty())
                    && let Some(provider) = provider_id
                {
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
        let provider_hint = self.contextual_provider(ctx);
        match intent {
            // ---- Terminal-aware KalVoice (0.1.5). Every send is the thread composer's own Send
            // (prompt review, warnings, busy refusals); KalVoice never sends natively, never
            // resumes a stopped thread and never names the prompt in a summary. ----
            KalVoiceIntent::SubmitFocused => {
                let thread = self.prepare_submit(ctx)?;
                Ok(Executed {
                    summary: format!("Sending in \u{201c}{}\u{201d}.", thread.name),
                    directive: Some(UiDirective::SubmitComposer {
                        thread_id: thread.id,
                    }),
                })
            }
            KalVoiceIntent::ClearFocused => {
                let thread = self.focused_thread(ctx)?;
                Ok(Executed {
                    summary: "Cleared what KalVoice typed.".into(),
                    directive: Some(UiDirective::ClearComposer {
                        thread_id: thread.id,
                    }),
                })
            }
            KalVoiceIntent::DirectPrompt { target, prompt } => {
                let (thread, submit) = self.prepare_direct_prompt(target, prompt, ctx)?;
                Ok(Executed {
                    summary: if submit {
                        format!("Sending to \u{201c}{}\u{201d}.", thread.name)
                    } else {
                        format!(
                            "\u{201c}{}\u{201d} is stopped, so KalVoice put your message in its composer without sending. KalVoice doesn't resume threads; press Resume and send when you're ready.",
                            thread.name
                        )
                    },
                    directive: Some(UiDirective::ComposeInThread {
                        thread_id: thread.id,
                        text: prompt.clone(),
                        submit,
                    }),
                })
            }
            KalVoiceIntent::FocusByState { state } => {
                let thread = self.prepare_focus_by_state(*state, ctx)?;
                Ok(Executed {
                    summary: format!(
                        "Opened \u{201c}{}\u{201d} ({}).",
                        thread.name,
                        state.phrase()
                    ),
                    directive: Some(UiDirective::OpenThread {
                        thread_id: thread.id,
                    }),
                })
            }
            KalVoiceIntent::WhichSessions { state } => self.which_sessions(*state, ctx),
            KalVoiceIntent::FocusPrevious => Ok(Executed {
                summary: "Going back to where you were.".into(),
                directive: Some(UiDirective::FocusPrevious),
            }),
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
                let limit = self.account.as_ref().map_or_else(
                    || crate::account::model::AccountSnapshot::signed_out().terminal_limit(),
                    |account| account.snapshot().terminal_limit(),
                );
                let terminal = self
                    .core
                    .create_terminal(&workspace.id, None, size, limit)
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
                account_query,
                model,
                effort,
                assignments,
            } => self.create_provider_panes(
                &[ProviderPaneRequest {
                    provider_id: Some(provider_id.clone()),
                    count: *count,
                    account_query: account_query.clone(),
                    model: model.clone(),
                    effort: effort.clone(),
                    assignments: assignments.clone(),
                }],
                workspace_id.as_deref().or(ctx.workspace_id.as_deref()),
                provider_hint.as_ref(),
            ),
            KalVoiceIntent::CreateProviderPanes {
                groups,
                workspace_id,
            } => self.create_provider_panes(
                groups,
                workspace_id.as_deref().or(ctx.workspace_id.as_deref()),
                provider_hint.as_ref(),
            ),
            KalVoiceIntent::ConfigureRecentLaunch {
                provider_id,
                model,
                effort,
            } => {
                let (targets, model, effort) =
                    self.prepare_recent_launch(provider_id, model, effort, ctx)?;
                let threads = self
                    .threads()?
                    .reconfigure_idle_launch(&targets, provider_id, &model, &effort)
                    .map_err(|error| from_core(&error))?;
                let thread_ids = threads
                    .iter()
                    .map(|thread| thread.id.clone())
                    .collect::<Vec<_>>();
                let instances = self
                    .threads()?
                    .launch_instances(&thread_ids)
                    .map_err(|error| from_core(&error))?
                    .into_iter()
                    .map(|instance| LaunchThreadInstance {
                        thread_id: instance.thread_id,
                        generation: instance.generation,
                    })
                    .collect::<Vec<_>>();
                let workspace_id = threads
                    .first()
                    .map(|thread| thread.workspace_id.clone())
                    .ok_or_else(|| {
                        ExecError::new(
                            "recent_launch_missing",
                            "The recent launch session set is empty.",
                        )
                    })?;
                let started = threads
                    .iter()
                    .filter(|thread| thread.status == ThreadStatus::Idle)
                    .count();
                let queued = threads
                    .iter()
                    .filter(|thread| thread.status == ThreadStatus::WaitingForDependency)
                    .count();
                let failed = threads.len().saturating_sub(started + queued);
                let summary = if started == threads.len() {
                    format!(
                        "Applied {model} at {effort} effort to {}.",
                        plural(started, "session", "sessions")
                    )
                } else {
                    format!(
                        "Applied the settings to {} sessions. {started} started; {queued} queued; {failed} failed to start.",
                        threads.len()
                    )
                };
                Ok(Executed {
                    summary,
                    directive: Some(UiDirective::OpenProviderPanes {
                        workspace_id,
                        thread_ids,
                        instances,
                    }),
                })
            }
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
                let thread = self.resolve_session(
                    query,
                    TargetUse::Open,
                    ctx,
                    SessionFollowUp::Open,
                    "open",
                )?;
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
                let thread = self.resolve_session(
                    thread_query.as_deref().unwrap_or_default(),
                    TargetUse::Open,
                    ctx,
                    SessionFollowUp::Open,
                    "open",
                )?;
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
                let outcomes = self.provider_threads()?.resume_threads(scope);
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
            KalVoiceIntent::StopThreads {
                scope,
                expected_count,
            } => {
                let runtime = self.threads()?;
                let outcomes = stop_bound_targets(runtime, scope, *expected_count)?;
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
                // Counting is best effort: the filter works even without the thread runtime. The
                // Fleet shows coding agents (provider panes), not chat threads, so only those count.
                let sessions = self.core.paths().data_dir.join("sessions");
                let counts = self
                    .threads
                    .as_ref()
                    .and_then(|runtime| runtime.list(None, false).ok())
                    .map(|threads| {
                        let agents: Vec<_> = threads
                            .iter()
                            .filter(|t| {
                                kalcode_providers::interactive::provider::marked_interactive(
                                    &sessions, &t.id,
                                )
                            })
                            .collect();
                        let count = agents
                            .iter()
                            .filter(|t| *chip == DashboardChip::All || t.status.chip() == *chip)
                            .count();
                        (count, agents.len())
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
                            format!("Closed the {name} pane.")
                        }
                        None => "Closed the pane.".into(),
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
                    ctx,
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
            session_locator_enabled: true,
            core: Arc::new(core),
            account: None,
            threads: None,
            ensure_providers: None,
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

    /// G1: the Session Locator is gated on Stable (the palette hides it), so voice Search is
    /// refused truthfully before anything counts and never reads locator results, even with a
    /// running locator that would match. Development builds show it and search as before.
    #[test]
    fn search_follows_the_session_locator_flag_of_the_channel() {
        use kalcode_core::flags::{BuildChannel, FeatureFlags};
        let stable = FeatureFlags::for_channel(BuildChannel::Stable);
        let development = FeatureFlags::for_channel(BuildChannel::Development);
        assert!(!feature_enabled(&stable, FeatureId::SessionLocator));
        assert!(feature_enabled(&development, FeatureId::SessionLocator));

        let dir = tempfile::tempdir().expect("data");
        let projects = tempfile::tempdir().expect("projects");
        let mut executor = executor(dir.path());
        let folder = projects.path().join("orbit-payments");
        std::fs::create_dir_all(&folder).expect("folder");
        executor.core.open_workspace(&folder).expect("open");
        let locator = kalcode_locator::Locator::start(executor.core.clone(), Arc::new(NoSources))
            .expect("locator");
        assert!(locator.wait_ready(std::time::Duration::from_secs(20)));
        executor.locator = Some(locator.clone());
        let search = KalVoiceIntent::Search {
            query: "orbit".into(),
        };

        // Stable: refused in `check` (the orchestrator counts nothing), and `execute` refuses
        // too, so no path reads back a locator result.
        executor.session_locator_enabled = feature_enabled(&stable, FeatureId::SessionLocator);
        let refused = executor.check(&search).expect_err("gated on Stable");
        assert_eq!(refused.code, "not_in_this_build");
        assert!(
            refused
                .message
                .starts_with("Search isn't available in this version"),
            "{}",
            refused.message
        );
        let refused = executor
            .execute(&search, &ctx())
            .expect_err("never reads the locator on Stable");
        assert_eq!(refused.code, "not_in_this_build");
        assert!(!refused.message.contains("orbit"), "{}", refused.message);

        // Development: the locator is shown, so Search reads back names as before.
        executor.session_locator_enabled = feature_enabled(&development, FeatureId::SessionLocator);
        assert!(executor.check(&search).is_ok());
        let done = executor.execute(&search, &ctx()).expect("search");
        assert!(
            done.summary.starts_with("Found 1: orbit-payments"),
            "{}",
            done.summary
        );
        locator.shutdown();
    }

    fn ctx() -> ExecContext {
        ExecContext {
            request_id: String::new(),
            workspace_id: None,
            thread_id: None,
            providers: Vec::new(),
            last_target_id: None,
            last_launch_instances: Vec::new(),
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
        assert_eq!(closed.summary, "Closed the pane.");
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
            "Showing 3 completed agents."
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

    /// An in-memory provider: tests exercise real runtime state without starting a CLI.
    struct IdleProvider(&'static str, bool);

    struct ProbeSession {
        _sink: Box<dyn kalcode_contracts::agent::AgentEventSink>,
    }

    impl kalcode_contracts::agent::AgentSession for ProbeSession {
        fn provider_session_id(&self) -> Option<String> {
            Some("voice-probe".into())
        }

        fn send(
            &self,
            _input: kalcode_contracts::agent::AgentInput,
        ) -> Result<(), kalcode_contracts::agent::ProviderError> {
            Ok(())
        }

        fn interrupt(&self) -> Result<(), kalcode_contracts::agent::ProviderError> {
            Ok(())
        }

        fn terminate(&self) -> Result<(), kalcode_contracts::agent::ProviderError> {
            Ok(())
        }

        fn respond_to_approval(
            &self,
            _request_id: &str,
            _decision: kalcode_contracts::permissions::ApprovalDecision,
        ) -> Result<(), kalcode_contracts::agent::ProviderError> {
            Err(kalcode_contracts::agent::ProviderError::Unsupported)
        }
    }

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
                ProviderId::CLAUDE_CODE => kalcode_providers::catalog::claude_capabilities(),
                ProviderId::GEMINI_CLI => kalcode_providers::catalog::gemini_capabilities(),
                _ => kalcode_providers::catalog::codex_capabilities(),
            }
        }

        fn start_session(
            &self,
            _config: kalcode_contracts::agent::SessionConfig,
            sink: Box<dyn kalcode_contracts::agent::AgentEventSink>,
        ) -> Result<
            Box<dyn kalcode_contracts::agent::AgentSession>,
            kalcode_contracts::agent::ProviderError,
        > {
            if self.1 {
                Err(kalcode_contracts::agent::ProviderError::Unsupported)
            } else {
                Ok(Box::new(ProbeSession { _sink: sink }))
            }
        }
    }

    #[test]
    fn idle_provider_fixture_retains_the_event_sink_for_the_session_lifetime() {
        let retained = Arc::new(());
        let weak = Arc::downgrade(&retained);
        let sink_retained = retained.clone();
        let sink: Box<dyn kalcode_contracts::agent::AgentEventSink> =
            Box::new(move |_| drop(sink_retained.clone()));
        drop(retained);

        let provider = IdleProvider(ProviderId::CODEX, false);
        let session = kalcode_contracts::agent::AgentProvider::start_session(
            &provider,
            kalcode_contracts::agent::SessionConfig {
                thread_id: "fixture-thread".into(),
                workspace_id: "fixture-workspace".into(),
                provider_account_id: None,
                working_directory: String::new(),
                model: None,
                effort: None,
                permission_mode: PermissionMode::Approve,
                resume_session_id: None,
                secret_ref: None,
            },
            sink,
        )
        .expect("probe session");

        assert!(weak.upgrade().is_some(), "session dropped its event sink");
        drop(session);
        assert!(
            weak.upgrade().is_none(),
            "session did not release its event sink"
        );
    }

    struct AccountsFixture {
        _data: tempfile::TempDir,
        _project: tempfile::TempDir,
        executor: DesktopExecutor,
        store: AccountStore,
        workspace_id: String,
        runtime: Arc<ThreadRuntime>,
    }

    impl Drop for AccountsFixture {
        fn drop(&mut self) {
            self.runtime.shutdown();
        }
    }

    /// Stable-like thread runtime with every provider available through the shipped pane canvas.
    fn accounts_fixture() -> AccountsFixture {
        accounts_fixture_with_start_failure(false)
    }

    fn accounts_fixture_with_start_failure(fail_start: bool) -> AccountsFixture {
        let data = tempfile::tempdir().expect("data");
        let project = tempfile::tempdir().expect("project");
        let mut executor = executor(data.path());
        let registry = Arc::new(kalcode_threads::ProviderRegistry::new());
        registry.register(Arc::new(IdleProvider(ProviderId::CLAUDE_CODE, fail_start)));
        registry.register(Arc::new(IdleProvider(ProviderId::CODEX, fail_start)));
        registry.register(Arc::new(IdleProvider(ProviderId::GEMINI_CLI, fail_start)));
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
                    effort: None,
                    permission_mode: PermissionMode::Approve,
                    name: Some("Login fix".into()),
                })
                .expect("thread")
        }

        fn run(&self, intent: &KalVoiceIntent, ctx: &ExecContext) -> Result<Executed, ExecError> {
            self.executor.check_with_context(intent, ctx)?;
            self.executor.execute(intent, ctx)
        }
    }

    #[test]
    fn counted_stop_requires_the_exact_live_session_count_and_changes_nothing_on_mismatch() {
        let f = accounts_fixture();
        let intent = KalVoiceIntent::StopThreads {
            scope: kalcode_contracts::kalvoice::ThreadScope::All,
            expected_count: Some(6),
        };

        let refused = f.run(&intent, &ctx()).expect_err("count mismatch");
        assert_eq!(refused.code, "stop_count_mismatch");
        assert_eq!(
            refused.message,
            "I found 0 active agent sessions, not 6. Nothing was stopped."
        );
        assert!(
            f.runtime
                .running_threads(&kalcode_contracts::kalvoice::ThreadScope::All)
                .expect("running sessions")
                .is_empty()
        );
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
    fn stable_voice_launches_real_sessions_with_the_resolved_account() {
        let f = accounts_fixture();
        f.account(ProviderId::CODEX, "Personal", AuthState::Authenticated);
        let work = f.account(ProviderId::CODEX, "Codex Work", AuthState::Authenticated);
        let intent = |account: Option<&str>, count: u8| KalVoiceIntent::CreateThreads {
            provider_id: ProviderId::new(ProviderId::CODEX),
            count,
            workspace_id: None,
            account_query: account.map(str::to_owned),
            model: None,
            effort: None,
            assignments: Vec::new(),
        };

        // A named authenticated account launches immediately on Stable and every created
        // provider terminal is handed to the now-shipped pane canvas.
        let done = f
            .run(&intent(Some("codex work"), 2), &ctx())
            .expect("sessions");
        assert!(done.summary.starts_with("Started 2 sessions in "));
        let launched = f.runtime.list(None, false).expect("threads");
        assert_eq!(launched.len(), 2);
        assert!(
            launched
                .iter()
                .all(|thread| thread.provider_account_id.as_deref() == Some(work.id.as_str()))
        );
        let Some(UiDirective::OpenProviderPanes {
            workspace_id,
            thread_ids,
            ..
        }) = done.directive
        else {
            panic!("expected provider panes");
        };
        assert_eq!(workspace_id, f.workspace_id);
        assert_eq!(thread_ids.len(), 2);
        assert!(
            thread_ids
                .iter()
                .all(|id| launched.iter().any(|thread| &thread.id == id))
        );

        // Exact provider model aliases are preserved; unavailable models fail before any group
        // starts, so a bad later option cannot partially launch the request.
        let gemini = f.account(ProviderId::GEMINI_CLI, "Gemini A", AuthState::Authenticated);
        let modeled = KalVoiceIntent::CreateThreads {
            provider_id: ProviderId::new(ProviderId::GEMINI_CLI),
            count: 1,
            workspace_id: None,
            account_query: Some("gemini a".into()),
            model: Some("pro".into()),
            effort: None,
            assignments: Vec::new(),
        };
        f.run(&modeled, &ctx()).expect("modeled session");
        let launched = f.runtime.list(None, false).expect("threads");
        assert!(launched.iter().any(|thread| {
            thread.provider_account_id.as_deref() == Some(gemini.id.as_str())
                && thread.model.as_deref() == Some("pro")
        }));
        let before = launched.len();
        let invalid = KalVoiceIntent::CreateThreads {
            provider_id: ProviderId::new(ProviderId::GEMINI_CLI),
            count: 1,
            workspace_id: None,
            account_query: Some("gemini a".into()),
            model: Some("ultra".into()),
            effort: None,
            assignments: Vec::new(),
        };
        assert_eq!(
            f.run(&invalid, &ctx()).map_err(|error| error.code),
            Err("invalid_model".into())
        );
        assert_eq!(f.runtime.list(None, false).expect("threads").len(), before);

        let claude = f.account(
            ProviderId::CLAUDE_CODE,
            "Claude Exact",
            AuthState::Authenticated,
        );
        let exact_claude_model = KalVoiceIntent::CreateThreads {
            provider_id: ProviderId::new(ProviderId::CLAUDE_CODE),
            count: 1,
            workspace_id: None,
            account_query: Some("claude exact".into()),
            model: Some("claude-sonnet-5".into()),
            effort: Some("high".into()),
            assignments: Vec::new(),
        };
        f.run(&exact_claude_model, &ctx())
            .expect("exact Claude model session");
        assert!(
            f.runtime
                .list(None, false)
                .expect("threads")
                .iter()
                .any(
                    |thread| thread.provider_account_id.as_deref() == Some(claude.id.as_str())
                        && thread.model.as_deref() == Some("claude-sonnet-5")
                        && thread.effort.as_deref() == Some("high")
                )
        );

        let efforted = KalVoiceIntent::CreateThreads {
            provider_id: ProviderId::new(ProviderId::CODEX),
            count: 1,
            workspace_id: None,
            account_query: Some("codex work".into()),
            model: None,
            effort: Some("high".into()),
            assignments: Vec::new(),
        };
        f.run(&efforted, &ctx()).expect("effort session");
        assert!(
            f.runtime
                .list(None, false)
                .expect("threads")
                .iter()
                .any(|thread| thread.effort.as_deref() == Some("high"))
        );
        let before_unsupported = f.runtime.list(None, false).expect("threads").len();
        let unsupported_effort = KalVoiceIntent::CreateThreads {
            provider_id: ProviderId::new(ProviderId::GEMINI_CLI),
            count: 1,
            workspace_id: None,
            account_query: Some("gemini a".into()),
            model: None,
            effort: Some("high".into()),
            assignments: Vec::new(),
        };
        assert_eq!(
            f.run(&unsupported_effort, &ctx())
                .map_err(|error| error.code),
            Err("effort_not_supported".into())
        );
        assert_eq!(
            f.runtime.list(None, false).expect("threads").len(),
            before_unsupported
        );

        // A single authenticated account is reused without asking the user to sign in again.
        let sole = accounts_fixture();
        let account = sole.account(ProviderId::CODEX, "Stable", AuthState::Authenticated);
        sole.run(&intent(None, 6), &ctx()).expect("six sessions");
        let launched = sole.runtime.list(None, false).expect("threads");
        assert_eq!(launched.len(), 6);
        assert!(
            launched
                .iter()
                .all(|thread| thread.provider_account_id.as_deref() == Some(account.id.as_str()))
        );

        // An ambiguous account gets a concise, retryable chooser. The retry carries an opaque
        // account id through grammar, then canonical account/auth/model checks run again.
        let ambiguous = f
            .executor
            .check(&intent(Some("codex"), 1))
            .expect_err("account choice");
        let Some(directive) = ambiguous.directive.as_deref() else {
            panic!("expected account chooser");
        };
        let UiDirective::ChooseLaunchAccount {
            choices,
            workspace_id,
            ..
        } = directive
        else {
            panic!("expected launch account choices");
        };
        assert_eq!(workspace_id, &f.workspace_id);
        assert_eq!(choices.len(), 2);
        let retry = choices
            .iter()
            .find(|choice| choice.account_id == work.id)
            .expect("work choice");
        let kalcode_kalvoice::grammar::Understood::Intent { intent: retry, .. } =
            kalcode_kalvoice::grammar::understand(&retry.retry_text)
        else {
            panic!("retry text must round-trip through grammar");
        };
        let before_retry = f.runtime.list(None, false).expect("threads").len();
        f.run(&retry, &ctx()).expect("chosen account retry");
        let launched = f.runtime.list(None, false).expect("threads");
        assert_eq!(launched.len(), before_retry + 1);
        assert_eq!(
            launched
                .last()
                .and_then(|thread| thread.provider_account_id.as_deref()),
            Some(work.id.as_str())
        );

        // Signed-out accounts never launch a provider process.
        f.account(ProviderId::CODEX, "Old", AuthState::NotAuthenticated);
        let before_signed_out = f.runtime.list(None, false).expect("threads").len();
        assert_eq!(
            f.executor
                .check(&intent(Some("old"), 1))
                .map_err(|e| e.code),
            Err("provider_account_signed_out".into())
        );
        assert_eq!(
            f.runtime.list(None, false).expect("threads").len(),
            before_signed_out
        );
    }

    /// "Start a Codex agent" as the first thread operation after launch: provider adapters are
    /// registered lazily (`ThreadsState::ensure_providers`), so the voice launch must register
    /// them itself instead of answering "That provider is not ready".
    #[test]
    fn voice_launch_registers_detected_providers_before_resolving_the_provider() {
        let data = tempfile::tempdir().expect("data");
        let project = tempfile::tempdir().expect("project");
        let mut executor = executor(data.path());
        let registry = Arc::new(kalcode_threads::ProviderRegistry::new());
        let runtime = Arc::new(
            ThreadRuntime::new(
                executor.core.clone(),
                registry.clone(),
                Arc::new(CoreWorkspaces::new(executor.core.clone())),
                Arc::new(kalcode_contracts::permissions::AskUnlessReadGate),
            )
            .expect("runtime"),
        );
        executor.threads = Some(runtime.clone());
        executor.visible.push(SurfaceId::Threads);
        executor
            .core
            .open_workspace(project.path())
            .expect("open workspace");
        let launch = KalVoiceIntent::CreateProviderPanes {
            groups: vec![ProviderPaneRequest {
                provider_id: Some(ProviderId::new(ProviderId::CODEX)),
                count: 1,
                account_query: None,
                model: None,
                effort: None,
                assignments: Vec::new(),
            }],
            workspace_id: None,
        };

        // Nothing registered the adapters yet: this is the reported failure.
        let refused = executor
            .check_with_context(&launch, &ctx())
            .expect_err("no adapters");
        assert_eq!(refused.code, "provider_unavailable");

        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        executor.ensure_providers = Some({
            let calls = calls.clone();
            let registry = registry.clone();
            Arc::new(move || {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if registry.get(&ProviderId::new(ProviderId::CODEX)).is_none() {
                    registry.register(Arc::new(IdleProvider(ProviderId::CODEX, false)));
                }
            })
        });
        executor
            .check_with_context(&launch, &ctx())
            .expect("launch check");
        let started = executor.execute(&launch, &ctx()).expect("launch");
        assert!(matches!(
            started.directive,
            Some(UiDirective::OpenProviderPanes { ref thread_ids, .. }) if thread_ids.len() == 1
        ));
        assert!(calls.load(std::sync::atomic::Ordering::SeqCst) >= 1);
        runtime.shutdown();
    }

    #[test]
    fn voice_launch_assignments_start_each_agent_and_preflight_atomically() {
        let f = accounts_fixture();
        f.account(ProviderId::CODEX, "Codex A", AuthState::Authenticated);
        let request = |assignments| KalVoiceIntent::CreateProviderPanes {
            groups: vec![ProviderPaneRequest {
                provider_id: Some(ProviderId::new(ProviderId::CODEX)),
                count: 4,
                account_query: Some("Codex A".into()),
                model: None,
                effort: None,
                assignments,
            }],
            workspace_id: None,
        };
        let launched = f
            .run(
                &request(vec![
                    kalcode_contracts::kalvoice::AgentLaunchAssignment {
                        count: 2,
                        task: "frontend".into(),
                    },
                    kalcode_contracts::kalvoice::AgentLaunchAssignment {
                        count: 1,
                        task: "tests".into(),
                    },
                    kalcode_contracts::kalvoice::AgentLaunchAssignment {
                        count: 1,
                        task: "review".into(),
                    },
                ]),
                &ctx(),
            )
            .expect("launch tasks");
        let Some(UiDirective::OpenProviderPanes { thread_ids, .. }) = launched.directive else {
            panic!("expected provider panes");
        };
        assert_eq!(thread_ids.len(), 4);
        let prompts = thread_ids
            .iter()
            .map(|id| {
                f.runtime
                    .messages(id, 10, None)
                    .expect("messages")
                    .first()
                    .expect("first prompt")
                    .content
                    .clone()
            })
            .collect::<Vec<_>>();
        assert_eq!(
            prompts,
            vec![
                "Work on the frontend.",
                "Work on the frontend.",
                "Work on the tests.",
                "Work on the review.",
            ]
        );

        let unqualified = KalVoiceIntent::CreateProviderPanes {
            groups: vec![ProviderPaneRequest {
                provider_id: None,
                count: 1,
                account_query: Some("Codex A".into()),
                model: None,
                effort: None,
                assignments: Vec::new(),
            }],
            workspace_id: None,
        };
        let focused_context = ExecContext {
            thread_id: Some(thread_ids[0].clone()),
            ..ctx()
        };
        let before_unqualified = f.runtime.list(None, false).expect("threads").len();
        f.run(&unqualified, &focused_context)
            .expect("focused provider launch");
        assert_eq!(
            f.runtime.list(None, false).expect("threads").len(),
            before_unqualified + 1
        );

        let before = f.runtime.list(None, false).expect("threads").len();
        let sensitive = ["deterministic", "Q7x", "private", "value"].join("-");
        let rejected = request(vec![
            kalcode_contracts::kalvoice::AgentLaunchAssignment {
                count: 3,
                task: "backend".into(),
            },
            kalcode_contracts::kalvoice::AgentLaunchAssignment {
                count: 1,
                task: format!("password={sensitive}"),
            },
        ]);
        assert_eq!(
            f.run(&rejected, &ctx()).map_err(|error| error.code),
            Err("context_prompt_confirmation_required".into())
        );
        assert_eq!(
            f.runtime.list(None, false).expect("threads").len(),
            before,
            "a warning in the last assignment must start no agents"
        );
    }

    #[test]
    fn voice_launch_never_reports_failed_provider_starts_as_opened() {
        let f = accounts_fixture_with_start_failure(true);
        f.account(ProviderId::CODEX, "Codex A", AuthState::Authenticated);
        let intent = KalVoiceIntent::CreateThreads {
            provider_id: ProviderId::new(ProviderId::CODEX),
            count: 2,
            workspace_id: None,
            account_query: Some("Codex A".into()),
            model: None,
            effort: None,
            assignments: Vec::new(),
        };
        let error = f.run(&intent, &ctx()).expect_err("provider starts fail");
        assert_eq!(error.code, "threads_failed");
        assert!(error.message.starts_with("None of the 2 sessions started"));
        let Some(UiDirective::OpenProviderPanes { thread_ids, .. }) = error.directive.as_deref()
        else {
            panic!("failed sessions should remain reviewable");
        };
        assert_eq!(thread_ids.len(), 2);
        assert!(
            f.runtime
                .list(None, false)
                .expect("threads")
                .iter()
                .all(|thread| thread.status == ThreadStatus::Failed)
        );
    }

    /// A launched agent stays a pane even when its first start never reaches the pane router
    /// (the Resource Governor holds it, or the account binding refuses it): the marker is written
    /// before the thread is created, so the later relaunch or Resume starts a pane, not a
    /// headless chat thread.
    #[test]
    fn voice_launch_marks_agents_as_panes_before_their_first_start() {
        let f = accounts_fixture_with_start_failure(true);
        f.account(ProviderId::CODEX, "Codex A", AuthState::Authenticated);
        let intent = KalVoiceIntent::CreateThreads {
            provider_id: ProviderId::new(ProviderId::CODEX),
            count: 2,
            workspace_id: None,
            account_query: Some("Codex A".into()),
            model: None,
            effort: None,
            assignments: Vec::new(),
        };
        f.run(&intent, &ctx()).expect_err("provider starts fail");
        let sessions = f.executor.core.paths().data_dir.join("sessions");
        let threads = f.runtime.list(None, false).expect("threads");
        assert_eq!(threads.len(), 2);
        for thread in threads {
            assert!(
                kalcode_providers::interactive::provider::marked_interactive(&sessions, &thread.id),
                "{} must stay a pane",
                thread.id
            );
        }

        // A launch refused before its thread exists leaves no marker behind.
        let refused =
            crate::provider_pane_commands::create_pane_thread(&f.runtime, &sessions, |thread_id| {
                f.runtime.create_idle_with_id(
                    thread_id,
                    CreateIdleThread {
                        provider_id: ProviderId::CODEX.into(),
                        provider_account_id: None,
                        account_label: None,
                        workspace_id: "missing-workspace".into(),
                        model: None,
                        effort: None,
                        permission_mode: PermissionMode::Approve,
                        name: None,
                    },
                )
            });
        assert!(refused.is_err());
        let left: Vec<_> = std::fs::read_dir(&sessions)
            .expect("sessions")
            .filter_map(|entry| entry.ok().map(|entry| entry.file_name()))
            .collect();
        assert_eq!(
            left.len(),
            2,
            "only the two created agents keep markers: {left:?}"
        );
    }

    #[test]
    fn voice_launch_infers_provider_from_account_workspace_and_only_valid_account() {
        let ambiguous = accounts_fixture();
        ambiguous.account(
            ProviderId::CLAUDE_CODE,
            "Claude A",
            AuthState::Authenticated,
        );
        ambiguous.account(ProviderId::CODEX, "Codex A", AuthState::Authenticated);
        let generic = KalVoiceIntent::CreateProviderPanes {
            groups: vec![ProviderPaneRequest {
                provider_id: None,
                count: 6,
                account_query: None,
                model: None,
                effort: None,
                assignments: Vec::new(),
            }],
            workspace_id: Some(ambiguous.workspace_id.clone()),
        };
        let error = ambiguous
            .run(&generic, &ctx())
            .expect_err("multiple providers need a chooser");
        assert_eq!(error.code, "provider_account_ambiguous");
        let Some(UiDirective::ChooseLaunchAccount { choices, .. }) = error.directive.as_deref()
        else {
            panic!("provider/account chooser");
        };
        assert_eq!(choices.len(), 2);
        for choice in choices {
            let kalcode_kalvoice::grammar::Understood::Intent { intent, .. } =
                kalcode_kalvoice::grammar::understand(&choice.retry_text)
            else {
                panic!("typed launch retry");
            };
            let KalVoiceIntent::CreateProviderPanes { groups, .. } = intent else {
                panic!("provider launch retry");
            };
            assert_eq!(groups[0].count, 6);
            assert!(groups[0].provider_id.is_some());
            assert_eq!(
                groups[0].account_query.as_deref(),
                Some(choice.account_id.as_str())
            );
        }

        let f = accounts_fixture();
        let codex = f.account(ProviderId::CODEX, "Codex A", AuthState::Authenticated);
        let gemini = f.account(ProviderId::GEMINI_CLI, "Gemini A", AuthState::Authenticated);
        f.store
            .bind(
                ProviderId::GEMINI_CLI,
                ProviderAccountBindingKind::Workspace,
                &f.workspace_id,
                &gemini.id,
            )
            .expect("workspace binding");
        let request = |account_query| KalVoiceIntent::CreateProviderPanes {
            groups: vec![ProviderPaneRequest {
                provider_id: None,
                count: 1,
                account_query,
                model: None,
                effort: None,
                assignments: Vec::new(),
            }],
            workspace_id: None,
        };
        let workspace_launch = f.run(&request(None), &ctx()).expect("workspace provider");
        let Some(UiDirective::OpenProviderPanes { thread_ids, .. }) = workspace_launch.directive
        else {
            panic!("workspace launch panes");
        };
        assert_eq!(
            f.runtime
                .get(&thread_ids[0])
                .expect("workspace launch")
                .provider_account_id
                .as_deref(),
            Some(gemini.id.as_str())
        );
        let named_launch = f
            .run(&request(Some("Codex A".into())), &ctx())
            .expect("named account provider");
        let Some(UiDirective::OpenProviderPanes { thread_ids, .. }) = named_launch.directive else {
            panic!("named launch panes");
        };
        assert_eq!(
            f.runtime
                .get(&thread_ids[0])
                .expect("named launch")
                .provider_account_id
                .as_deref(),
            Some(codex.id.as_str())
        );

        let sole = accounts_fixture();
        sole.account(ProviderId::CODEX, "Old", AuthState::NotAuthenticated);
        let claude = sole.account(
            ProviderId::CLAUDE_CODE,
            "Claude A",
            AuthState::Authenticated,
        );
        let sole_launch = sole
            .run(&request(None), &ctx())
            .expect("only valid account");
        let Some(UiDirective::OpenProviderPanes { thread_ids, .. }) = sole_launch.directive else {
            panic!("sole valid account panes");
        };
        assert_eq!(
            sole.runtime
                .get(&thread_ids[0])
                .expect("sole account launch")
                .provider_account_id
                .as_deref(),
            Some(claude.id.as_str())
        );

        let precedence = accounts_fixture();
        let signed_out = precedence.account(
            ProviderId::CLAUDE_CODE,
            "Claude A",
            AuthState::NotAuthenticated,
        );
        let focused_account =
            precedence.account(ProviderId::CODEX, "Codex A", AuthState::Authenticated);
        let focused_thread = precedence.thread(ProviderId::CODEX, &focused_account);
        let focused_context = ExecContext {
            thread_id: Some(focused_thread.id),
            ..ctx()
        };
        let error = precedence
            .run(&request(Some("Claude A".into())), &focused_context)
            .expect_err("signed-out explicit account");
        assert_eq!(error.code, "provider_account_signed_out");
        assert!(
            precedence
                .runtime
                .list(None, false)
                .expect("threads")
                .iter()
                .all(|thread| thread.provider_account_id.as_deref()
                    != Some(signed_out.id.as_str()))
        );
    }

    #[test]
    fn account_choice_retry_preserves_exact_launch_fields_beyond_spoken_limits() {
        let f = accounts_fixture();
        let account = f.account(ProviderId::GEMINI_CLI, "Gemini A", AuthState::Authenticated);
        let group = ProviderPaneRequest {
            provider_id: Some(ProviderId::new(ProviderId::GEMINI_CLI)),
            count: 1,
            account_query: None,
            model: Some("flash-lite".into()),
            effort: None,
            assignments: vec![kalcode_contracts::kalvoice::AgentLaunchAssignment {
                count: 1,
                task: "x".repeat(220),
            }],
        };
        let retry = launch_retry_text(
            &group,
            group.provider_id.as_ref().expect("provider"),
            &account.id,
        )
        .expect("retry");
        assert!(retry.len() > 300);
        let kalcode_kalvoice::grammar::Understood::Intent { intent, .. } =
            kalcode_kalvoice::grammar::understand(&retry)
        else {
            panic!("typed retry");
        };
        let KalVoiceIntent::CreateProviderPanes { groups, .. } = intent else {
            panic!("provider panes");
        };
        assert_eq!(
            groups[0].account_query.as_deref(),
            Some(account.id.as_str())
        );
        assert_eq!(groups[0].model.as_deref(), Some("flash-lite"));
        assert_eq!(groups[0].assignments, group.assignments);
    }

    #[test]
    fn mixed_provider_launch_ambiguity_preserves_and_revalidates_every_group() {
        let f = accounts_fixture();
        f.account(
            ProviderId::CODEX,
            "Codex Personal",
            AuthState::Authenticated,
        );
        let work = f.account(ProviderId::CODEX, "Codex Work", AuthState::Authenticated);
        let gemini = f.account(ProviderId::GEMINI_CLI, "Gemini A", AuthState::Authenticated);
        let request = KalVoiceIntent::CreateProviderPanes {
            groups: vec![
                ProviderPaneRequest {
                    provider_id: Some(ProviderId::new(ProviderId::CODEX)),
                    count: 2,
                    account_query: Some("codex".into()),
                    model: None,
                    effort: Some("high".into()),
                    assignments: Vec::new(),
                },
                ProviderPaneRequest {
                    provider_id: Some(ProviderId::new(ProviderId::GEMINI_CLI)),
                    count: 1,
                    account_query: Some("Gemini A".into()),
                    model: Some("flash-lite".into()),
                    effort: None,
                    assignments: Vec::new(),
                },
            ],
            workspace_id: Some(f.workspace_id.clone()),
        };

        let error = f.run(&request, &ctx()).expect_err("ambiguous first group");
        assert_eq!(error.code, "provider_account_ambiguous");
        assert!(f.runtime.list(None, false).expect("threads").is_empty());
        let Some(UiDirective::ChooseLaunchAccount { choices, .. }) = error.directive.as_deref()
        else {
            panic!("mixed launch account chooser");
        };
        assert_eq!(choices.len(), 2);
        assert!(choices.iter().all(|choice| choice.label.contains("Codex")));
        let retry = &choices
            .iter()
            .find(|choice| choice.account_id == work.id)
            .expect("work account")
            .retry_text;
        let kalcode_kalvoice::grammar::Understood::Intent { intent: retry, .. } =
            kalcode_kalvoice::grammar::understand(retry)
        else {
            panic!("typed mixed launch retry");
        };
        let KalVoiceIntent::CreateProviderPanes { groups, .. } = &retry else {
            panic!("mixed provider groups");
        };
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].count, 2);
        assert_eq!(groups[0].account_query.as_deref(), Some(work.id.as_str()));
        assert_eq!(groups[0].effort.as_deref(), Some("high"));
        assert_eq!(groups[1].account_query.as_deref(), Some("Gemini A"));
        assert_eq!(groups[1].model.as_deref(), Some("flash-lite"));

        f.run(&retry, &ctx()).expect("chosen mixed launch");
        let launched = f.runtime.list(None, false).expect("threads");
        assert_eq!(launched.len(), 3);
        assert_eq!(
            launched
                .iter()
                .filter(|thread| thread.provider_account_id.as_deref() == Some(work.id.as_str()))
                .count(),
            2
        );
        assert_eq!(
            launched
                .iter()
                .filter(|thread| thread.provider_account_id.as_deref() == Some(gemini.id.as_str()))
                .count(),
            1
        );
    }

    // ---- 0.1.5 terminal-aware KalVoice ----

    impl AccountsFixture {
        fn named(&self, provider: &str, account: &ProviderAccount, name: &str) -> ThreadSummary {
            let thread = self
                .runtime
                .create_idle(CreateIdleThread {
                    provider_id: provider.into(),
                    provider_account_id: Some(account.id.clone()),
                    account_label: Some(account.display_name.clone()),
                    workspace_id: self.workspace_id.clone(),
                    model: None,
                    effort: None,
                    permission_mode: PermissionMode::Approve,
                    name: Some(name.into()),
                })
                .expect("thread");
            // The fixture provider never starts; begin from a plain idle thread.
            self.set_status(&thread, ThreadStatus::Idle);
            self.runtime.get(&thread.id).expect("thread")
        }

        fn set_status(&self, thread: &ThreadSummary, status: ThreadStatus) {
            self.executor
                .core
                .transact(|tx| {
                    kalcode_threads::store::set_status(
                        tx,
                        &thread.id,
                        status,
                        None,
                        "2026-09-28T12:00:00.000Z",
                    )?;
                    Ok(((), Vec::new()))
                })
                .expect("status");
            assert_eq!(self.runtime.get(&thread.id).expect("thread").status, status);
        }

        fn ctx(&self) -> ExecContext {
            ExecContext {
                workspace_id: Some(self.workspace_id.clone()),
                ..ctx()
            }
        }
    }

    /// Authentication (Codex Work), Release Windows (Codex Personal), Release Mac (Gemini A),
    /// Research on Gemini A and on Gemini B.
    struct Sessions {
        f: AccountsFixture,
        auth: ThreadSummary,
        release_windows: ThreadSummary,
        release_mac: ThreadSummary,
        research_a: ThreadSummary,
        research_b: ThreadSummary,
    }

    fn sessions() -> Sessions {
        let f = accounts_fixture();
        let work = f.account(ProviderId::CODEX, "Codex Work", AuthState::Authenticated);
        let personal = f.account(ProviderId::CODEX, "Personal", AuthState::Authenticated);
        let a = f.account(ProviderId::GEMINI_CLI, "Gemini A", AuthState::Authenticated);
        let b = f.account(ProviderId::GEMINI_CLI, "Gemini B", AuthState::Authenticated);
        Sessions {
            auth: f.named(ProviderId::CODEX, &work, "Authentication"),
            release_windows: f.named(ProviderId::CODEX, &personal, "Release Windows"),
            release_mac: f.named(ProviderId::GEMINI_CLI, &a, "Release Mac"),
            research_a: f.named(ProviderId::GEMINI_CLI, &a, "Research"),
            research_b: f.named(ProviderId::GEMINI_CLI, &b, "Research"),
            f,
        }
    }

    fn open(query: &str) -> KalVoiceIntent {
        KalVoiceIntent::OpenThread {
            query: query.into(),
        }
    }

    fn opened(thread: &ThreadSummary) -> Option<UiDirective> {
        Some(UiDirective::OpenThread {
            thread_id: thread.id.clone(),
        })
    }

    fn choices(error: &ExecError) -> Vec<String> {
        match error.directive.as_deref() {
            Some(UiDirective::ChooseSession { choices, .. }) => {
                choices.iter().map(|c| c.thread_id.clone()).collect()
            }
            other => panic!("expected ChooseSession, got {other:?}"),
        }
    }

    #[test]
    fn local_reasoner_scene_actions_use_live_threads_and_preserve_ambiguity() {
        let s = sessions();
        let ctx = s.f.ctx();

        let actions =
            s.f.executor
                .local_reasoning_actions("find Codex working on authentication", &ctx)
                .expect("scene actions");
        assert_eq!(actions.len(), 1);
        assert_eq!(
            actions[0].intent,
            KalVoiceIntent::OpenThread {
                query: s.auth.id.clone(),
            }
        );
        assert!(actions[0].label.contains("Authentication"));
        assert!(actions[0].label.contains("Codex"));
        assert!(!actions[0].label.contains(&s.auth.id));

        let ambiguous_request = "show me the Gemini research agent";
        let actions =
            s.f.executor
                .local_reasoning_actions(ambiguous_request, &ctx)
                .expect("ambiguous scene actions");
        assert_eq!(actions.len(), 1);
        assert_eq!(
            actions[0].intent,
            KalVoiceIntent::OpenThread {
                query: ambiguous_request.into(),
            },
            "execution re-resolves and returns the canonical chooser"
        );
        assert!(actions[0].label.contains("Gemini A"));
        assert!(actions[0].label.contains("Gemini B"));

        let semantic =
            s.f.executor
                .local_reasoning_actions("locate the sign-in work", &ctx)
                .expect("semantic candidates");
        assert!(
            semantic.iter().any(|candidate| {
                candidate.intent
                    == KalVoiceIntent::OpenThread {
                        query: s.auth.id.clone(),
                    }
            }),
            "the offline selector receives live choices for paraphrases the lexical resolver cannot settle"
        );
        assert!(semantic.len() <= MAX_GROUNDED_ACTION_CANDIDATES);
        for candidate in &semantic {
            for thread_id in [
                &s.auth.id,
                &s.release_windows.id,
                &s.release_mac.id,
                &s.research_a.id,
                &s.research_b.id,
            ] {
                assert!(!candidate.label.contains(thread_id));
            }
        }

        assert!(
            s.f.executor
                .local_reasoning_actions("refactor authentication and run tests", &ctx)
                .expect("non-locating prose")
                .is_empty()
        );
    }

    #[test]
    fn voice_session_names_resolve_by_tier_and_clarify_instead_of_guessing() {
        let s = sessions();
        let ctx = s.f.ctx();
        // Exact name, a unique partial name (open only) and provider/account + name.
        for (query, thread) in [
            ("Authentication", &s.auth),
            ("the authentication thread", &s.auth),
            ("auth", &s.auth),
            ("Gemini B Research", &s.research_b),
            ("research on gemini a", &s.research_a),
        ] {
            assert_eq!(
                s.f.run(&open(query), &ctx).expect(query).directive,
                opened(thread),
                "{query}"
            );
        }
        // Ties are a clarification naming the choices, never the most recent.
        let release = s.f.run(&open("release"), &ctx).expect_err("ambiguous");
        assert_eq!(release.code, "target_ambiguous");
        assert_eq!(
            release.message,
            "Which one \u{2014} Release Mac or Release Windows?"
        );
        let mut picked = choices(&release);
        picked.sort();
        let mut expected = vec![s.release_mac.id.clone(), s.release_windows.id.clone()];
        expected.sort();
        assert_eq!(picked, expected);
        let research = s.f.run(&open("research"), &ctx).expect_err("ambiguous");
        assert_eq!(
            research.message,
            "Which one \u{2014} Research on Gemini B or Research on Gemini A?"
        );
        // "It": the focused thread, then the last target, else ask.
        let focused = ExecContext {
            thread_id: Some(s.release_mac.id.clone()),
            last_target_id: Some(s.auth.id.clone()),
            ..s.f.ctx()
        };
        assert_eq!(
            s.f.run(&open("it"), &focused).expect("it").directive,
            opened(&s.release_mac)
        );
        let remembered = ExecContext {
            last_target_id: Some(s.auth.id.clone()),
            ..s.f.ctx()
        };
        for query in ["it", "that one", "there"] {
            assert_eq!(
                s.f.run(&open(query), &remembered).expect(query).directive,
                opened(&s.auth),
                "{query}"
            );
        }
        assert_eq!(
            s.f.run(&open("it"), &ctx).map_err(|e| e.code),
            Err("target_unclear".into())
        );
        assert_eq!(
            s.f.run(&open("payments webhook"), &ctx)
                .map_err(|e| e.message),
            Err("KalCode has no open thread named \u{201c}payments webhook\u{201d}.".into())
        );
        // The trait-level lookup never picks among several.
        assert_eq!(s.f.executor.find_thread("release").expect("find"), None);
        assert_eq!(
            s.f.executor.find_thread("Authentication").expect("find"),
            Some(s.auth.id.clone())
        );
    }

    #[test]
    fn destructive_voice_commands_never_act_on_partial_or_ambiguous_names() {
        let s = sessions();
        let ctx = s.f.ctx();
        let pause = KalVoiceIntent::PauseThreads {
            scope: kalcode_contracts::kalvoice::ThreadScope::Thread {
                thread_id: String::new(),
            },
        };
        let target = |name: &str, ctx: &ExecContext| {
            s.f.executor
                .resolve_thread_target(name, &pause, ctx)
                .map_err(|e| (e.code.clone(), e))
        };
        assert_eq!(
            target("Authentication", &ctx).expect("exact"),
            Some(s.auth.id.clone())
        );
        assert_eq!(
            target("gemini b research", &ctx).expect("qualified"),
            Some(s.research_b.id.clone())
        );
        // A partial name: "Did you mean …?" with the one choice, nothing paused.
        let (code, partial) = target("auth", &ctx).expect_err("partial");
        assert_eq!(code, "target_unconfirmed");
        assert_eq!(
            partial.message,
            "Did you mean \u{201c}Authentication\u{201d}? Say its full name to pause it."
        );
        assert_eq!(choices(&partial), vec![s.auth.id.clone()]);
        // A provider alone, even when only one thread fits it.
        assert_eq!(
            target("codex work", &ctx).map_err(|(code, _)| code),
            Err("target_unconfirmed".into())
        );
        assert_eq!(
            target("release", &ctx).map_err(|(code, _)| code),
            Err("target_ambiguous".into())
        );
        assert_eq!(
            target("this", &ctx).map_err(|(code, _)| code),
            Err("target_unclear".into())
        );
        let here = ExecContext {
            thread_id: Some(s.release_mac.id.clone()),
            ..s.f.ctx()
        };
        assert_eq!(
            target("this", &here).expect("focused"),
            Some(s.release_mac.id.clone())
        );
        // An account switch by a partial name is refused the same way.
        assert_eq!(
            s.f.run(&rebind(Some("auth"), None, "personal"), &ctx)
                .map_err(|e| e.code),
            Err("target_unconfirmed".into())
        );
    }

    fn tell(target: &str, prompt: &str) -> KalVoiceIntent {
        KalVoiceIntent::DirectPrompt {
            target: target.into(),
            prompt: prompt.into(),
        }
    }

    /// Security review (0.1.5): a partial or misheard name never sends a prompt, even when it
    /// fits exactly one thread, in this workspace or another one on another account.
    #[test]
    fn a_fuzzy_compose_target_is_confirmed_and_never_sent() {
        let s = sessions();
        let ctx = s.f.ctx();
        // A thread in another workspace, on another account.
        let other_project = tempfile::tempdir().expect("project");
        let other =
            s.f.executor
                .core
                .open_workspace(other_project.path())
                .expect("open");
        let billing_account =
            s.f.account(ProviderId::CODEX, "Billing Team", AuthState::Authenticated);
        let billing =
            s.f.runtime
                .create_idle(CreateIdleThread {
                    provider_id: ProviderId::CODEX.into(),
                    provider_account_id: Some(billing_account.id.clone()),
                    account_label: Some(billing_account.display_name.clone()),
                    workspace_id: other.id.clone(),
                    model: None,
                    effort: None,
                    permission_mode: PermissionMode::Approve,
                    name: Some("Billing Webhook".into()),
                })
                .expect("thread");
        s.f.set_status(&billing, ThreadStatus::Idle);

        let unconfirmed = |query: &str| {
            let error =
                s.f.run(&tell(query, "delete the old tables"), &ctx)
                    .expect_err(query);
            assert_eq!(error.code, "target_unconfirmed", "{query}");
            assert!(
                error.message.starts_with("Did you mean \u{201c}"),
                "{query}: {}",
                error.message
            );
            match error.directive.as_deref() {
                Some(UiDirective::ChooseSession {
                    choices,
                    follow_up: SessionFollowUp::Compose { text, submit: true },
                    ..
                }) => {
                    assert_eq!(text, "delete the old tables");
                    choices
                        .iter()
                        .map(|c| c.thread_id.clone())
                        .collect::<Vec<_>>()
                }
                other => panic!("{query}: expected ChooseSession, got {other:?}"),
            }
        };
        // A word-start fragment in this workspace.
        assert_eq!(unconfirmed("auth"), vec![s.auth.id.clone()]);
        // A misheard name (one typo) and a fragment that fit one thread in another workspace.
        assert_eq!(unconfirmed("billing webhok"), vec![billing.id.clone()]);
        assert_eq!(unconfirmed("billing"), vec![billing.id.clone()]);
        // Never routed as a command from a focused text box either.
        assert!(!s.f.executor.names_one_session("billing webhok", &ctx));
        assert!(!s.f.executor.names_one_session("auth", &ctx));

        // Exact names (alone or with their provider/account words), the focused thread and the
        // remembered one still compose directly.
        let composed = |query: &str, ctx: &ExecContext| match s
            .f
            .run(&tell(query, "continue"), ctx)
            .expect(query)
            .directive
        {
            Some(UiDirective::ComposeInThread {
                thread_id,
                submit: true,
                ..
            }) => thread_id,
            other => panic!("{query}: expected ComposeInThread, got {other:?}"),
        };
        assert_eq!(composed("Authentication", &ctx), s.auth.id);
        assert_eq!(composed("Billing Webhook", &ctx), billing.id);
        assert_eq!(composed("codex work authentication", &ctx), s.auth.id);
        let focused = ExecContext {
            thread_id: Some(s.release_mac.id.clone()),
            ..s.f.ctx()
        };
        assert_eq!(composed("it", &focused), s.release_mac.id);
        let remembered = ExecContext {
            last_target_id: Some(s.research_b.id.clone()),
            ..s.f.ctx()
        };
        assert_eq!(composed("it", &remembered), s.research_b.id);
    }

    #[test]
    fn direct_prompts_compose_through_the_composer_and_never_resume_or_race_a_permission() {
        let s = sessions();
        let ctx = s.f.ctx();
        let prompt = "Review the latest login failure, and don't push anything.";
        let done =
            s.f.run(&tell("Authentication", prompt), &ctx)
                .expect("tell");
        assert_eq!(
            done.directive,
            Some(UiDirective::ComposeInThread {
                thread_id: s.auth.id.clone(),
                text: prompt.into(),
                submit: true,
            })
        );
        // The summary names the thread only, never the words.
        assert_eq!(done.summary, "Sending to \u{201c}Authentication\u{201d}.");
        assert!(s.f.executor.names_one_session("Authentication", &ctx));

        // Several fits: "Which one?", and the pick composes the same words.
        let ambiguous =
            s.f.run(&tell("release", "bump the version"), &ctx)
                .expect_err("ambiguous");
        assert_eq!(ambiguous.code, "target_ambiguous");
        assert!(matches!(
            ambiguous.directive.as_deref(),
            Some(UiDirective::ChooseSession {
                follow_up: SessionFollowUp::Compose { text, submit: true },
                ..
            }) if text == "bump the version"
        ));
        assert!(!s.f.executor.names_one_session("release", &ctx));
        // A provider or account alone is confirmed first, even when unique.
        let provider_only =
            s.f.run(&tell("Codex Work", "run the tests"), &ctx)
                .expect_err("provider only");
        assert_eq!(provider_only.code, "target_unconfirmed");
        assert_eq!(choices(&provider_only), vec![s.auth.id.clone()]);

        // A pending permission: refused before anything counts.
        s.f.set_status(&s.auth, ThreadStatus::WaitingForPermission);
        let refused =
            s.f.executor
                .check_with_context(&tell("Authentication", "continue"), &ctx)
                .expect_err("permission pending");
        assert_eq!(refused.code, "permission_pending");
        assert!(refused.message.contains("waiting for your permission"));

        // Stopped or paused: put in the composer, never sent (KalVoice doesn't resume).
        for status in [ThreadStatus::Paused, ThreadStatus::Interrupted] {
            s.f.set_status(&s.auth, status);
            let stopped =
                s.f.run(&tell("Authentication", "continue"), &ctx)
                    .expect("stopped");
            assert_eq!(
                stopped.directive,
                Some(UiDirective::ComposeInThread {
                    thread_id: s.auth.id.clone(),
                    text: "continue".into(),
                    submit: false,
                })
            );
            assert!(stopped.summary.contains("doesn't resume threads"));
        }
        assert_eq!(
            s.f.run(&tell("Authentication", "  "), &ctx)
                .map_err(|e| e.code),
            Err("prompt_missing".into())
        );
    }

    #[test]
    fn send_that_and_clear_that_act_on_the_focused_thread_only() {
        let s = sessions();
        let nothing = s.f.ctx();
        assert_eq!(
            s.f.run(&KalVoiceIntent::SubmitFocused, &nothing)
                .map_err(|e| e.code),
            Err("thread_not_focused".into())
        );
        assert_eq!(
            s.f.run(&KalVoiceIntent::ClearFocused, &nothing)
                .map_err(|e| e.code),
            Err("thread_not_focused".into())
        );
        let here = ExecContext {
            thread_id: Some(s.auth.id.clone()),
            ..s.f.ctx()
        };
        assert_eq!(
            s.f.run(&KalVoiceIntent::SubmitFocused, &here)
                .expect("send")
                .directive,
            Some(UiDirective::SubmitComposer {
                thread_id: s.auth.id.clone()
            })
        );
        assert_eq!(
            s.f.run(&KalVoiceIntent::ClearFocused, &here)
                .expect("clear")
                .directive,
            Some(UiDirective::ClearComposer {
                thread_id: s.auth.id.clone()
            })
        );
        s.f.set_status(&s.auth, ThreadStatus::Paused);
        assert_eq!(
            s.f.run(&KalVoiceIntent::SubmitFocused, &here)
                .map_err(|e| e.code),
            Err("thread_stopped".into())
        );
        s.f.set_status(&s.auth, ThreadStatus::WaitingForPermission);
        assert_eq!(
            s.f.run(&KalVoiceIntent::SubmitFocused, &here)
                .map_err(|e| e.code),
            Err("permission_pending".into())
        );
        // Clearing never sends, so it is allowed whatever the state.
        assert!(s.f.run(&KalVoiceIntent::ClearFocused, &here).is_ok());
    }

    #[test]
    fn sessions_by_state_focus_one_or_clarify_and_read_back_names() {
        let s = sessions();
        let ctx = s.f.ctx();
        let focus = |state| KalVoiceIntent::FocusByState { state };
        let which = |state| KalVoiceIntent::WhichSessions { state };
        assert_eq!(
            s.f.run(&focus(SessionAttention::Failed), &ctx)
                .map_err(|e| e.message),
            Err("No thread has failed.".into())
        );
        s.f.set_status(&s.auth, ThreadStatus::Failed);
        let one =
            s.f.run(&focus(SessionAttention::Failed), &ctx)
                .expect("one failed");
        assert_eq!(one.directive, opened(&s.auth));
        assert_eq!(
            one.summary,
            "Opened \u{201c}Authentication\u{201d} (failed)."
        );
        s.f.set_status(&s.release_mac, ThreadStatus::Failed);
        let two =
            s.f.run(&focus(SessionAttention::Failed), &ctx)
                .expect_err("two failed");
        assert_eq!(two.code, "target_ambiguous");
        assert_eq!(choices(&two).len(), 2);

        let read =
            s.f.run(&which(SessionAttention::Failed), &ctx)
                .expect("which failed");
        assert!(
            read.summary.starts_with("2 threads failed: ")
                && read.summary.contains("Authentication")
                && read.summary.contains("Release Mac"),
            "{}",
            read.summary
        );
        assert_eq!(
            read.directive,
            Some(UiDirective::FilterDashboard {
                chip: DashboardChip::WaitingForYou
            })
        );
        s.f.set_status(&s.research_a, ThreadStatus::WaitingForPermission);
        let permission =
            s.f.run(&which(SessionAttention::WaitingForPermission), &ctx)
                .expect("permission");
        assert_eq!(
            permission.summary,
            "1 thread is waiting for permission: Research."
        );
        // Waiting for you includes a pending permission request.
        assert_eq!(
            s.f.run(&focus(SessionAttention::WaitingForYou), &ctx)
                .expect("waiting for you")
                .directive,
            opened(&s.research_a)
        );
        let stuck =
            s.f.run(&which(SessionAttention::Stuck), &ctx)
                .expect("stuck");
        assert_eq!(stuck.summary, "No threads are stuck.");
        assert_eq!(stuck.directive, None);
        let _ = (&s.release_windows, &s.research_b);
    }

    #[test]
    fn go_back_is_a_ui_directive() {
        let dir = tempfile::tempdir().expect("data");
        let executor = executor(dir.path());
        let done = executor
            .execute(&KalVoiceIntent::FocusPrevious, &ctx())
            .expect("back");
        assert_eq!(done.directive, Some(UiDirective::FocusPrevious));
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
