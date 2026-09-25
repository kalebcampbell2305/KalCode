//! What KalVoice commands do in the desktop app: they call the same runtimes the rest of
//! KalCode uses — workspaces and terminals (Z1, `kalcode_core`), threads (Z3,
//! [`ThreadRuntime`]) and pending approvals (Z4, [`PermissionService`], read-only). KalVoice
//! never answers approvals and never changes permission modes; commands that add work reach this
//! executor only after the person approved their KalVoice-origin approval request (the
//! orchestrator files it with `PermissionService::request_for_origin`).
//!
//! CA-1 intents: `focus` opens the thread (the UI shows it in its pane when it has one), and
//! `request_permission_mode` opens the thread so the person can change its mode themselves
//! (never Bypass: the contract can't represent it). `split`, `resize` and `close` are pane
//! layout commands (Z7-W1): they return a directive the pane canvas carries out; nothing starts,
//! stops or closes a process. `search` and `switch_provider` aren't in this build, so they're
//! refused before anything is counted.

use std::sync::Arc;

use kalcode_contracts::agent::ProviderId;
use kalcode_contracts::app::SurfaceId;
use kalcode_contracts::kalvoice::{KalVoiceIntent, PaneDirection};
use kalcode_contracts::permissions::{ApprovalStatus, PermissionMode};
use kalcode_contracts::workspace_ui::SplitAxis;
use kalcode_core::workspaces::{TerminalSize, Workspace};
use kalcode_core::{Core, KalError};
use kalcode_kalvoice::orchestrator::{
    ExecContext, ExecError, Executed, Executor, UiDirective, provider_display_name,
    requestable_mode_label,
};
use kalcode_permissions::PermissionService;
use kalcode_threads::{BulkOutcome, CreateIdleThread, ThreadRuntime};

/// Size a terminal opened by voice starts at; the Code view resizes it when it attaches.
const VOICE_TERMINAL_SIZE: (u16, u16) = (120, 30);

pub struct DesktopExecutor {
    /// Surfaces this build shows (navigation to others is refused).
    pub visible: Vec<SurfaceId>,
    pub core: Arc<Core>,
    /// `None` when the thread runtime didn't start (then thread commands explain why).
    pub threads: Option<Arc<ThreadRuntime>>,
    /// `None` when the permission engine didn't start.
    pub permissions: Option<Arc<PermissionService>>,
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

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
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

    fn workspace(&self, id: &str) -> Result<Workspace, ExecError> {
        self.core
            .workspaces()
            .map_err(|e| from_core(&e))?
            .into_iter()
            .find(|w| w.id == id)
            .ok_or_else(|| {
                ExecError::new("workspace_not_found", "That workspace no longer exists.")
            })
    }

    /// The named workspace, or the active one.
    fn target_workspace(&self, id: Option<&str>) -> Result<Workspace, ExecError> {
        match id {
            Some(id) => self.workspace(id),
            None => self
                .core
                .active_workspace()
                .map_err(|e| from_core(&e))?
                .ok_or_else(|| {
                    ExecError::new(
                        "no_workspace",
                        "Open a workspace first (Code, Open folder), or name one: “in the website workspace”.",
                    )
                }),
        }
    }

    fn create_threads(
        &self,
        provider_id: &ProviderId,
        count: u8,
        workspace_id: Option<&str>,
    ) -> Result<Executed, ExecError> {
        let runtime = self.threads()?;
        let workspace = self.target_workspace(workspace_id)?;
        let request = CreateIdleThread {
            provider_id: provider_id.as_str().to_owned(),
            workspace_id: workspace.id.clone(),
            model: None,
            // KalVoice never picks a mode: new threads start in the default, Approve.
            permission_mode: PermissionMode::Approve,
            name: None,
        };
        let results = runtime
            .create_idle_threads(&request, count)
            .map_err(|e| from_core(&e))?;
        let ok = results.iter().filter(|r| r.is_ok()).count();
        let first_error = results.iter().find_map(|r| r.as_ref().err());
        let provider = provider_display_name(provider_id);
        if ok == 0 {
            return Err(first_error.map_or_else(
                || ExecError::new("threads_failed", "KalVoice couldn't open those threads."),
                from_core,
            ));
        }
        let summary = if ok == results.len() {
            format!(
                "Opened {} in {}.",
                plural(
                    ok,
                    &format!("{provider} thread"),
                    &format!("{provider} threads")
                ),
                workspace.name
            )
        } else {
            format!(
                "Opened {ok} of {} {provider} threads in {}. {}",
                results.len(),
                workspace.name,
                first_error.map(|e| e.message.as_str()).unwrap_or_default()
            )
            .trim_end()
            .to_owned()
        };
        Ok(Executed {
            summary,
            directive: Some(UiDirective::Navigate {
                surface: SurfaceId::Threads,
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
    /// The first open thread matching a spoken name, or a user-safe "not found".
    fn named_thread(
        &self,
        query: &str,
    ) -> Result<kalcode_contracts::threads::ThreadSummary, ExecError> {
        self.threads()?
            .find(query)
            .map_err(|e| from_core(&e))?
            .into_iter()
            .next()
            .ok_or_else(|| {
                ExecError::new(
                    "thread_not_found",
                    format!("KalCode has no open thread named \u{201c}{query}\u{201d}."),
                )
            })
    }
}

impl Executor for DesktopExecutor {
    fn find_workspace(&self, name: &str) -> Result<Option<String>, ExecError> {
        let wanted = name.trim().to_lowercase();
        let workspaces = self.core.workspaces().map_err(|e| from_core(&e))?;
        let exact = workspaces.iter().find(|w| w.name.to_lowercase() == wanted);
        let loose = || {
            workspaces.iter().find(|w| {
                let n = w.name.to_lowercase();
                n.contains(&wanted) || n.replace(['-', '_', '.'], " ") == wanted
            })
        };
        Ok(exact.or_else(loose).map(|w| w.id.clone()))
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
            KalVoiceIntent::CreateThreads { .. }
            | KalVoiceIntent::OpenThread { .. }
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
            KalVoiceIntent::Search { .. } | KalVoiceIntent::SwitchProvider { .. } => {
                Err(ExecError::new(
                    "not_in_this_build",
                    "Search and provider switching aren't in this build yet, so KalVoice can't do that.",
                ))
            }
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
            } => self.create_threads(provider_id, *count, workspace_id.as_deref()),
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
            KalVoiceIntent::Search { .. } | KalVoiceIntent::SwitchProvider { .. } => {
                Err(ExecError::new(
                    "not_in_this_build",
                    "Search and provider switching aren't in this build yet, so KalVoice can't do that.",
                ))
            }
        }
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
            core: Arc::new(core),
            threads: None,
            permissions: None,
        }
    }

    fn ctx() -> ExecContext {
        ExecContext {
            request_id: String::new(),
            workspace_id: None,
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
                .check(&KalVoiceIntent::Search {
                    query: "oauth".into()
                })
                .map_err(|e| e.code),
            Err("not_in_this_build".into())
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
}
