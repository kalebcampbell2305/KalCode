//! The structured handoff package an Agent Handoff Chain step receives at delivery time.
//!
//! Built from canonical facts only: the chain's goal and acceptance criteria, earlier steps'
//! structured reports, the shared working tree's changed paths and branch, and relevant Unified
//! Memory. Raw terminal history is never copied. The whole package passes the Context Firewall.

use std::path::{Path, PathBuf};

use kalcode_context::firewall::{Firewall, FirewallPolicy};
use kalcode_context::model::{ContextPurpose, ItemKind, ItemOrigin, RuleEffect};
use kalcode_context::never_share::NeverShareRules;
use kalcode_context::package::{ContextItem, ContextPackage, PackageOptions, SendCheck};
use kalcode_context::provider::TextOnlyDefaults;
use kalcode_context::store as context_store;
use kalcode_contracts::chains::{ChainStepPhase, ChainStepResult, ChainWorktree};
use kalcode_core::chains::{DeliveryContext, REPORT_DIR, REPORT_EXCLUDE_PATTERN, intent_action};
use kalcode_core::{Core, ErrorCategory, KalError, Result};
use kalcode_git::{GitCore, WorkspaceRoot};

const MAX_CHANGED_PATHS: usize = 40;
const PACKAGE_CAP_BYTES: u64 = 48 * 1024;

/// Where a chain step works: the chain's shared worktree (once created) or the project checkout.
pub(crate) struct StepRoot {
    pub(crate) root: WorkspaceRoot,
    /// True when the shared worktree does not exist yet (the first step creates it).
    pub(crate) pending_worktree: bool,
}

pub(crate) fn step_root(core: &Core, ctx: &DeliveryContext) -> Result<StepRoot> {
    if ctx.chain.worktree == ChainWorktree::Shared {
        // The chain's own tree, or the source agent's tree the chain continues in.
        let owner = ctx.worktree_owner.as_deref().unwrap_or(&ctx.chain.id);
        let found = core.read(|conn| kalcode_git::store::active_thread_worktree(conn, owner))?;
        if let Some((row, path)) = found {
            return Ok(StepRoot {
                root: WorkspaceRoot::new(&row.id, &path)?,
                pending_worktree: false,
            });
        }
        return Ok(StepRoot {
            root: crate::git_commands::workspace_root_in(core, &ctx.chain.workspace_id)?,
            pending_worktree: true,
        });
    }
    Ok(StepRoot {
        root: crate::git_commands::workspace_root_in(core, &ctx.chain.workspace_id)?,
        pending_worktree: false,
    })
}

/// The report file path the agent writes, relative to its working folder.
pub(crate) fn report_relative(operation_id: &str) -> String {
    format!("{REPORT_DIR}/{operation_id}.json")
}

/// The absolute report path inside a step's working folder.
pub(crate) fn report_absolute(folder: &Path, operation_id: &str) -> PathBuf {
    let mut path = folder.to_path_buf();
    for part in REPORT_DIR.split('/') {
        path.push(part);
    }
    path.push(format!("{operation_id}.json"));
    path
}

/// The working folder a step's agent runs in: the tree plus the workspace's repository prefix.
pub(crate) fn working_folder(git: &GitCore, root: &WorkspaceRoot) -> Result<PathBuf> {
    let Some(repo) = git.repo(root)? else {
        return Ok(root.path().to_path_buf());
    };
    Ok(repo
        .prefix()
        .split('/')
        .filter(|part| !part.is_empty())
        .fold(root.path().to_path_buf(), |path, part| path.join(part)))
}

/// Keeps step reports out of every change list: adds the report folder to the repository's
/// shared `info/exclude` once, and creates the folder the agent writes into.
pub(crate) fn prepare_report_folder(
    git: &GitCore,
    root: &WorkspaceRoot,
    folder: &Path,
) -> Result<()> {
    let io = |error: std::io::Error| {
        KalError::new(
            ErrorCategory::Filesystem,
            "chain_report_folder_unavailable",
            "KalCode couldn't prepare the folder for this step's report.",
        )
        .with_source(error)
    };
    if let Some(repo) = git.repo(root)? {
        let info = repo.common_dir().join("info");
        std::fs::create_dir_all(&info).map_err(io)?;
        let exclude = info.join("exclude");
        let existing = std::fs::read_to_string(&exclude).unwrap_or_default();
        if !existing
            .lines()
            .any(|line| line.trim() == REPORT_EXCLUDE_PATTERN)
        {
            let mut next = existing;
            if !next.is_empty() && !next.ends_with('\n') {
                next.push('\n');
            }
            next.push_str("# KalCode handoff chain step reports\n");
            next.push_str(REPORT_EXCLUDE_PATTERN);
            next.push('\n');
            std::fs::write(&exclude, next).map_err(io)?;
        }
    }
    let mut dir = folder.to_path_buf();
    for part in REPORT_DIR.split('/') {
        dir.push(part);
    }
    std::fs::create_dir_all(dir).map_err(io)
}

fn firewall(core: &Core, workspace_id: &str, root: &Path) -> Result<Firewall> {
    let patterns = core.read(|connection| {
        context_store::never_share_for_workspace(connection, workspace_id).map_err(KalError::from)
    })?;
    let policy = FirewallPolicy {
        never_share: NeverShareRules::new(&patterns).map_err(KalError::from)?,
        ..FirewallPolicy::default()
    };
    Ok(Firewall::new(
        kalcode_context::WorkspaceRoot::new(root),
        policy,
    ))
}

pub(crate) struct PackageInput<'a> {
    pub(crate) core: &'a Core,
    pub(crate) git: &'a GitCore,
    pub(crate) ctx: &'a DeliveryContext,
    pub(crate) root: &'a StepRoot,
    pub(crate) memory: Option<String>,
    pub(crate) provider_id: &'a str,
    pub(crate) operation_id: &'a str,
}

/// Renders the firewall-checked package text for one step.
pub(crate) fn compose(input: PackageInput<'_>) -> Result<String> {
    let PackageInput {
        core,
        git,
        ctx,
        root,
        memory,
        provider_id,
        operation_id,
    } = input;
    let chain = &ctx.chain;
    let step = &ctx.step;
    let firewall = firewall(core, &chain.workspace_id, root.root.path())?;
    let total = chain.steps.len();
    let number = chain
        .steps
        .iter()
        .position(|candidate| candidate.key == step.key)
        .map_or(1, |index| index + 1);

    let mut text = format!(
        "KalCode handoff chain · {} · step {number} of {total} · {}\n\nGoal\n{}\n",
        chain.name,
        step.intent.label().to_uppercase(),
        chain.goal
    );
    if !chain.acceptance.is_empty() {
        text.push_str("\nAcceptance criteria\n");
        for item in &chain.acceptance {
            text.push_str("- ");
            text.push_str(item);
            text.push('\n');
        }
    }

    text.push_str("\nWhere to work\n");
    match (chain.worktree, root.pending_worktree) {
        (ChainWorktree::Shared, true) => text.push_str(
            "A new KalCode worktree for this chain (your working folder). Later steps continue in the same tree.\n",
        ),
        (ChainWorktree::Shared, false) => {
            text.push_str("The chain's shared KalCode worktree (your working folder).\n");
        }
        (ChainWorktree::Project, _) => text.push_str("The project checkout (your working folder).\n"),
    }
    if let Some(branch) = &chain.branch {
        text.push_str(&format!("Branch: {branch}\n"));
    }

    let earlier = chain
        .steps
        .iter()
        .filter(|candidate| candidate.position < step.position && candidate.phase.settled())
        .collect::<Vec<_>>();
    if !earlier.is_empty() {
        text.push_str("\nEarlier steps\n");
        for done in earlier {
            let route = ctx
                .operations
                .get(&done.operation_id)
                .map(|op| {
                    format!(
                        "{}{}",
                        op.spec.provider_id.as_deref().unwrap_or("agent"),
                        op.spec
                            .model
                            .as_deref()
                            .filter(|model| !model.is_empty())
                            .map(|model| format!(" ({model})"))
                            .unwrap_or_default()
                    )
                })
                .unwrap_or_default();
            let outcome = match (done.phase, done.report.as_ref().map(|r| r.result)) {
                (ChainStepPhase::Skipped, _) => "skipped".to_owned(),
                (_, Some(ChainStepResult::ChangesRequested)) => "changes requested".to_owned(),
                (_, Some(ChainStepResult::Failed)) => "failed".to_owned(),
                (ChainStepPhase::Passed, _) => "passed".to_owned(),
                (phase, _) => phase.as_str().replace('_', " "),
            };
            text.push_str(&format!("- {} · {route} · {outcome}", done.name));
            if let Some(report) = &done.report {
                text.push_str(&format!("\n  Summary: {}", report.summary));
                for test in &report.tests {
                    text.push_str(&format!(
                        "\n  Test: {} — {}",
                        test.command,
                        if test.passed { "passed" } else { "failed" }
                    ));
                }
                for blocker in &report.blockers {
                    text.push_str(&format!("\n  Blocker: {blocker}"));
                }
            } else if let Some(reason) = &done.waiting_reason {
                text.push_str(&format!("\n  {reason}"));
            }
            text.push('\n');
        }
    }

    if !root.pending_worktree
        && let Ok(Some(status)) = git.status(&root.root)
    {
        let changed = status
            .files
            .iter()
            .filter(|file| !file.path.starts_with(".kalcode/"))
            .filter(|file| {
                let (_, reasons) = firewall.check_path(&file.path, false);
                !reasons.iter().any(|reason| {
                    matches!(
                        reason.effect,
                        RuleEffect::Block | RuleEffect::BlockOverridable
                    )
                })
            })
            .map(|file| kalcode_context::package::sanitize_label(&file.path))
            .collect::<Vec<_>>();
        if let Some(head) = status.summary.head.as_deref() {
            text.push_str(&format!("HEAD: {}\n", &head[..head.len().min(12)]));
        }
        if !changed.is_empty() {
            text.push_str(&format!(
                "\nChanged files in the working tree ({})\n",
                changed.len()
            ));
            for path in changed.iter().take(MAX_CHANGED_PATHS) {
                text.push_str("- ");
                text.push_str(path);
                text.push('\n');
            }
            if changed.len() > MAX_CHANGED_PATHS {
                text.push_str(&format!(
                    "- …and {} more\n",
                    changed.len() - MAX_CHANGED_PATHS
                ));
            }
        }
    }

    if let Some(memory) = memory.filter(|memory| !memory.trim().is_empty()) {
        text.push('\n');
        text.push_str(memory.trim());
        text.push('\n');
    }

    text.push_str(&format!("\nYour step: {}\n", step.name));
    if let Some(instructions) = &step.instructions {
        text.push_str(instructions);
        text.push('\n');
    }
    text.push_str(intent_action(step.intent));
    text.push('\n');

    text.push_str(&format!(
        "\nWhen you finish, write your step report as JSON to {} in your working folder:\n\
         {{\"version\":1,\"result\":\"passed\"|\"failed\"|\"changes_requested\",\"summary\":\"one or two sentences\",\"tests\":[{{\"command\":\"…\",\"passed\":true}}],\"blockers\":[\"…\"]}}\n\
         KalCode moves the chain on only from this report. If you need an answer first, ask; you can write the report after.\n",
        report_relative(operation_id)
    ));

    let mut options = PackageOptions::new(ContextPurpose::Handoff);
    options.workspace_id = Some(chain.workspace_id.clone());
    options.target_thread_id = Some(operation_id.to_owned());
    options.package_cap_bytes = PACKAGE_CAP_BYTES;
    let package = ContextPackage::build(
        &firewall,
        &TextOnlyDefaults::new(provider_id),
        options,
        vec![ContextItem::text(
            ItemKind::Text,
            "Handoff chain step package",
            ItemOrigin::User,
            text,
        )],
    );
    let rendered = match package.check_before_send(package.content_sha256(), &firewall)? {
        SendCheck::Ready(rendered) => rendered.text(),
        SendCheck::Stale(_) => {
            return Err(KalError::internal(
                "chain_package_unstable",
                "KalCode could not build a stable package for this chain step.",
            ));
        }
    };
    if rendered.trim().is_empty() {
        return Err(KalError::validation(
            "chain_package_blocked",
            "The Context Firewall blocked this chain step's package.",
        ));
    }
    Ok(rendered)
}
