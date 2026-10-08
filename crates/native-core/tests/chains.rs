use std::sync::Arc;

use kalcode_contracts::chains::{
    ChainPhase, ChainStartRequest, ChainStepDefinition, ChainStepIntent, ChainStepPhase,
    ChainStepResult, ChainStepRoute, ChainWorktree,
};
use kalcode_contracts::operations::OperationStatus;
use kalcode_core::chains::ChainsStore;
use kalcode_core::flags::BuildChannel;
use kalcode_core::operations::OperationsStore;
use kalcode_core::{Core, CoreConfig, Paths};
use rusqlite::params;

#[allow(clippy::expect_used)]
fn open(data: &std::path::Path) -> Arc<Core> {
    Arc::new(
        Core::open(CoreConfig {
            paths: Paths::new(data),
            app_version: "0.1.10-test".into(),
            channel: BuildChannel::Development,
        })
        .expect("open core"),
    )
}

#[allow(clippy::expect_used)]
fn workspace(core: &Core, root: &std::path::Path) -> String {
    std::fs::create_dir_all(root).expect("create workspace");
    core.open_workspace(root).expect("open workspace").id
}

#[allow(clippy::expect_used)]
fn account(core: &Core, provider_id: &str, label: &str, state: &str) -> String {
    let id = uuid::Uuid::now_v7().to_string();
    core.transact(|tx| {
        tx.execute(
            "INSERT INTO provider_accounts (
               id, provider_id, display_name, authentication_state, is_default, created_at
             ) VALUES (?1, ?2, ?3, ?4, 0, '2026-10-07T12:00:00.000Z')",
            params![id, provider_id, label, state],
        )?;
        Ok(((), Vec::new()))
    })
    .expect("insert provider account");
    id
}

fn step(
    key: &str,
    intent: ChainStepIntent,
    provider: &str,
    account: &str,
    depends_on: &[&str],
) -> ChainStepDefinition {
    ChainStepDefinition {
        key: key.into(),
        name: intent.label().to_owned(),
        intent,
        provider_id: provider.into(),
        provider_account_id: account.into(),
        model: "test-model".into(),
        effort: "high".into(),
        instructions: None,
        depends_on: depends_on.iter().map(|key| (*key).to_owned()).collect(),
    }
}

struct Harness {
    _data: tempfile::TempDir,
    core: Arc<Core>,
    chains: ChainsStore,
    operations: OperationsStore,
    workspace: String,
    claude: String,
    codex: String,
}

#[allow(clippy::expect_used)]
fn harness() -> Harness {
    let data = tempfile::tempdir().expect("data");
    let core = open(data.path());
    let workspace = workspace(&core, &data.path().join("project"));
    let claude = account(&core, "claude-code", "Claude A", "authenticated");
    let codex = account(&core, "codex", "Codex A", "authenticated");
    Harness {
        chains: ChainsStore::new(core.clone()),
        operations: OperationsStore::new(core.clone()),
        core,
        _data: data,
        workspace,
        claude,
        codex,
    }
}

impl Harness {
    fn standard(&self, request_id: &str) -> ChainStartRequest {
        use ChainStepIntent::*;
        ChainStartRequest {
            request_id: request_id.into(),
            workspace_id: self.workspace.clone(),
            name: "Login fix".into(),
            goal: "Fix the login redirect loop.".into(),
            acceptance: vec!["Signed-in users land on Code".into()],
            worktree: ChainWorktree::Shared,
            steps: vec![
                step("implement", Implement, "claude-code", &self.claude, &[]),
                step("review", Review, "codex", &self.codex, &["implement"]),
                step("fix", Fix, "claude-code", &self.claude, &["review"]),
                step("test", Test, "codex", &self.codex, &["fix"]),
            ],
            source_thread_id: None,
        }
    }

    #[allow(clippy::expect_used)]
    fn operation(&self, chain: &str, key: &str) -> String {
        self.chains
            .get(chain)
            .expect("chain")
            .steps
            .into_iter()
            .find(|step| step.key == key)
            .expect("step")
            .operation_id
    }

    #[allow(clippy::expect_used)]
    fn phase(&self, chain: &str, key: &str) -> ChainStepPhase {
        self.chains
            .get(chain)
            .expect("chain")
            .steps
            .into_iter()
            .find(|step| step.key == key)
            .expect("step")
            .phase
    }

    /// Starts a step the way the dispatcher does, then records its report and settles it.
    #[allow(clippy::expect_used)]
    fn complete(&self, chain: &str, key: &str, result: ChainStepResult) {
        let id = self.operation(chain, key);
        self.operations
            .claim_user_squad_agent(&id)
            .expect("claim")
            .expect("claimable");
        self.chains
            .record_step(chain, key, result, "Done.")
            .expect("record");
    }

    #[allow(clippy::expect_used)]
    fn status(&self, id: &str) -> OperationStatus {
        self.operations.get(id).expect("operation").status
    }
}

#[test]
#[allow(clippy::expect_used)]
fn start_creates_one_ordered_agent_operation_per_step_and_is_idempotent() {
    let h = harness();
    let chain = h.chains.start(h.standard("req-1"), None).expect("start");
    assert_eq!(chain.steps.len(), 4);
    assert_eq!(chain.phase, ChainPhase::Running);
    assert_eq!(
        chain
            .branch
            .as_deref()
            .map(|b| b.starts_with("kal/chain-login-fix-")),
        Some(true)
    );
    let ids = chain
        .steps
        .iter()
        .map(|step| step.operation_id.clone())
        .collect::<Vec<_>>();
    let review = h.operations.get(&ids[1]).expect("review op");
    assert_eq!(review.spec.dependencies, vec![ids[0].clone()]);
    assert_eq!(review.spec.provider_id.as_deref(), Some("codex"));
    assert!(
        review
            .spec
            .prompt
            .as_deref()
            .is_some_and(|p| p.contains("Fix the login redirect loop."))
    );
    assert_eq!(chain.steps[0].phase, ChainStepPhase::Starting);
    assert_eq!(chain.steps[1].phase, ChainStepPhase::Waiting);
    assert_eq!(
        chain.steps[1].waiting_reason.as_deref(),
        Some("Waiting for Implement.")
    );

    let again = h
        .chains
        .start(h.standard("req-1"), None)
        .expect("retry start");
    assert_eq!(again.id, chain.id);
    let mut changed = h.standard("req-1");
    changed.goal = "Something else".into();
    assert_eq!(
        h.chains.start(changed, None).expect_err("conflict").code,
        "chain_request_conflict"
    );

    // Chains never appear as reusable Squad launches.
    let squads = kalcode_core::squads::SquadsStore::new(h.core.clone())
        .snapshot()
        .expect("squads");
    assert!(squads.launches.is_empty());
    let snapshot = h.chains.snapshot(Some(&h.workspace)).expect("snapshot");
    assert_eq!(snapshot.chains.len(), 1);
    assert_eq!(snapshot.operations.len(), 4);
}

#[test]
fn start_rejects_parallel_writers_forward_references_and_empty_goals() {
    use ChainStepIntent::*;
    let h = harness();
    let mut parallel = h.standard("req-p");
    parallel.steps = vec![
        step("implement", Implement, "claude-code", &h.claude, &[]),
        step("fix", Fix, "claude-code", &h.claude, &["implement"]),
        step("more", Continue, "codex", &h.codex, &["implement"]),
    ];
    assert_eq!(
        h.chains.start(parallel.clone(), None).err().map(|e| e.code),
        Some("chain_parallel_writers")
    );
    parallel.worktree = ChainWorktree::Project;
    assert!(h.chains.start(parallel, None).is_ok());

    let mut forward = h.standard("req-f");
    forward.steps[0].depends_on = vec!["review".into()];
    assert_eq!(
        h.chains.start(forward, None).err().map(|e| e.code),
        Some("invalid_chain_dependency")
    );
    let mut stranger = h.standard("req-s");
    stranger.source_thread_id = Some(uuid::Uuid::now_v7().to_string());
    assert_eq!(
        h.chains.start(stranger, None).err().map(|e| e.code),
        Some("chain_source_unavailable")
    );
    let mut empty = h.standard("req-e");
    empty.goal = "  ".into();
    assert_eq!(
        h.chains.start(empty, None).err().map(|e| e.code),
        Some("invalid_chain_goal")
    );
}

#[test]
#[allow(clippy::expect_used)]
fn approved_review_skips_fix_and_the_chain_becomes_ready_to_merge() {
    let h = harness();
    let chain = h.chains.start(h.standard("req-2"), None).expect("start").id;
    h.complete(&chain, "implement", ChainStepResult::Passed);
    assert_eq!(h.phase(&chain, "review"), ChainStepPhase::Starting);
    h.complete(&chain, "review", ChainStepResult::Passed);
    h.chains.apply_rules().expect("rules");
    assert_eq!(h.phase(&chain, "fix"), ChainStepPhase::Skipped);
    let test = h.operation(&chain, "test");
    assert_eq!(
        h.operations.get(&test).expect("test").spec.dependencies,
        vec![h.operation(&chain, "review")]
    );
    assert_eq!(h.phase(&chain, "test"), ChainStepPhase::Starting);
    h.complete(&chain, "test", ChainStepResult::Passed);
    let done = h.chains.get(&chain).expect("chain");
    assert_eq!(done.phase, ChainPhase::ReadyToMerge);
    assert!(
        done.next_action
            .is_some_and(|text| text.starts_with("Ready to merge"))
    );
}

#[test]
#[allow(clippy::expect_used)]
fn changes_requested_runs_fix_and_a_failure_blocks_only_dependents() {
    use ChainStepIntent::*;
    let h = harness();
    let mut request = h.standard("req-3");
    // A parallel read-only branch that does not depend on the fix.
    request
        .steps
        .push(step("docs", Review, "codex", &h.codex, &["implement"]));
    let chain = h.chains.start(request, None).expect("start").id;
    h.complete(&chain, "implement", ChainStepResult::Passed);
    h.complete(&chain, "review", ChainStepResult::ChangesRequested);
    h.chains.apply_rules().expect("rules");
    assert_eq!(h.phase(&chain, "review"), ChainStepPhase::ChangesRequested);
    assert_eq!(h.phase(&chain, "fix"), ChainStepPhase::Starting);
    h.complete(&chain, "fix", ChainStepResult::Failed);
    assert_eq!(h.phase(&chain, "fix"), ChainStepPhase::Failed);
    assert_eq!(h.phase(&chain, "test"), ChainStepPhase::Blocked);
    assert_eq!(
        h.status(&h.operation(&chain, "test")),
        OperationStatus::Blocked
    );
    // The independent branch keeps going.
    assert_eq!(h.phase(&chain, "docs"), ChainStepPhase::Starting);
    let blocked = h.chains.get(&chain).expect("chain");
    assert_eq!(blocked.phase, ChainPhase::Running);

    // Retry on another route rewires the dependent and unblocks it.
    let old_fix = h.operation(&chain, "fix");
    let authorize = h
        .chains
        .retry_step(
            &chain,
            "fix",
            Some(ChainStepRoute {
                provider_id: "codex".into(),
                provider_account_id: h.codex.clone(),
                model: "gpt-test".into(),
                effort: "medium".into(),
            }),
        )
        .expect("retry");
    let new_fix = h.operation(&chain, "fix");
    assert_ne!(new_fix, old_fix);
    assert!(authorize.contains(&new_fix));
    let test = h.operation(&chain, "test");
    assert!(authorize.contains(&test));
    assert_eq!(
        h.operations.get(&test).expect("test").spec.dependencies,
        vec![new_fix.clone()]
    );
    assert_eq!(h.status(&test), OperationStatus::Queued);
    let retried = h.chains.get(&chain).expect("chain");
    let fix = retried.steps.iter().find(|s| s.key == "fix").expect("fix");
    assert_eq!((fix.attempt, fix.phase), (2, ChainStepPhase::Starting));
    assert_eq!(
        h.operations
            .get(&new_fix)
            .expect("fix")
            .spec
            .provider_id
            .as_deref(),
        Some("codex")
    );
}

#[test]
#[allow(clippy::expect_used)]
fn skip_lets_dependents_continue_and_pause_holds_only_unstarted_steps() {
    let h = harness();
    let chain = h.chains.start(h.standard("req-4"), None).expect("start").id;
    let implement = h.operation(&chain, "implement");
    h.operations
        .claim_user_squad_agent(&implement)
        .expect("claim")
        .expect("claimable");

    h.chains.pause(&chain).expect("pause");
    assert_eq!(h.status(&implement), OperationStatus::Starting);
    assert_eq!(h.phase(&chain, "review"), ChainStepPhase::Paused);
    let paused = h.chains.get(&chain).expect("chain");
    assert!(paused.paused);
    assert_eq!(
        paused.phase,
        ChainPhase::Running,
        "a running step keeps the chain running"
    );
    h.chains.resume(&chain).expect("resume");
    assert_eq!(h.phase(&chain, "review"), ChainStepPhase::Waiting);

    h.chains
        .record_step(&chain, "implement", ChainStepResult::Passed, "Implemented.")
        .expect("record");
    h.chains
        .skip_step(&chain, "review", "Skipped by you.")
        .expect("skip");
    assert_eq!(h.phase(&chain, "review"), ChainStepPhase::Skipped);
    assert_eq!(
        h.operations
            .get(&h.operation(&chain, "fix"))
            .expect("fix")
            .spec
            .dependencies,
        vec![implement]
    );
    assert_eq!(h.phase(&chain, "fix"), ChainStepPhase::Starting);
    assert_eq!(
        h.chains
            .skip_step(&chain, "implement", "x")
            .err()
            .map(|e| e.code),
        Some("chain_step_finished")
    );
}

#[test]
#[allow(clippy::expect_used)]
fn needs_report_cancel_and_supersede_are_truthful() {
    let h = harness();
    let chain = h.chains.start(h.standard("req-5"), None).expect("start").id;
    let implement = h.operation(&chain, "implement");
    h.operations
        .claim_user_squad_agent(&implement)
        .expect("claim")
        .expect("claimable");
    h.operations
        .bind(&implement, None, Some(&implement), None, None)
        .expect("bind");
    assert!(h.chains.mark_awaiting_report(&implement).expect("await"));
    assert_eq!(h.phase(&chain, "implement"), ChainStepPhase::NeedsReport);
    assert_eq!(
        h.chains.get(&chain).expect("chain").phase,
        ChainPhase::NeedsYou
    );

    // An agent-written report settles it; a malformed one is a truthful failure.
    let dir = tempfile::tempdir().expect("dir");
    let report = dir.path().join(format!("{implement}.json"));
    h.chains.set_report_path(&implement, &report).expect("path");
    std::fs::write(
        &report,
        br#"{"version":1,"result":"passed","summary":"Redirect fixed","tests":[{"command":"pnpm test","passed":true}]}"#,
    )
    .expect("write report");
    let collected = h
        .chains
        .collect_report(&implement)
        .expect("collect")
        .expect("report");
    assert_eq!(collected.result, ChainStepResult::Passed);
    assert!(!report.exists(), "a consumed report is removed");

    h.chains.cancel(&chain).expect("cancel");
    let cancelled = h.chains.get(&chain).expect("chain");
    assert_eq!(cancelled.phase, ChainPhase::Cancelled);
    assert_eq!(
        h.status(&h.operation(&chain, "review")),
        OperationStatus::Cancelled
    );

    let other = h.chains.start(h.standard("req-6"), None).expect("start").id;
    h.chains
        .supersede(
            &other,
            "The branch was already merged into main by newer work.",
        )
        .expect("supersede");
    let superseded = h.chains.get(&other).expect("chain");
    assert_eq!(superseded.phase, ChainPhase::Superseded);
    assert!(
        superseded
            .steps
            .iter()
            .all(|step| step.phase == ChainStepPhase::Superseded)
    );
}

#[test]
#[allow(clippy::expect_used)]
fn a_signed_out_account_holds_only_its_step_with_a_reason() {
    use ChainStepIntent::*;
    let h = harness();
    let signed_out = account(&h.core, "codex", "Codex B", "not_authenticated");
    let mut request = h.standard("req-7");
    request.steps[1] = step("review", Review, "codex", &signed_out, &["implement"]);
    let chain = h.chains.start(request, None).expect("start");
    let review = chain
        .steps
        .iter()
        .find(|s| s.key == "review")
        .expect("review");
    assert_eq!(review.phase, ChainStepPhase::Blocked);
    assert!(
        review
            .waiting_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("Reconnect"))
    );
    assert_eq!(chain.steps[0].phase, ChainStepPhase::Starting);
    assert_eq!(chain.phase, ChainPhase::NeedsYou);
}

#[test]
#[allow(clippy::expect_used)]
fn review_findings_never_reach_ready_to_merge_without_a_fix() {
    use ChainStepIntent::*;
    let h = harness();
    let mut request = h.standard("req-8");
    request.steps = vec![
        step("implement", Implement, "claude-code", &h.claude, &[]),
        step("review", Review, "codex", &h.codex, &["implement"]),
    ];
    let chain = h.chains.start(request, None).expect("start").id;
    h.complete(&chain, "implement", ChainStepResult::Passed);
    h.complete(&chain, "review", ChainStepResult::ChangesRequested);
    let waiting = h.chains.get(&chain).expect("chain");
    assert_eq!(waiting.phase, ChainPhase::NeedsYou);
    assert!(
        waiting
            .next_action
            .is_some_and(|text| text.contains("asked for changes"))
    );
    // The review can run again once the changes were made.
    let renew = h
        .chains
        .retry_step(&chain, "review", None)
        .expect("retry review");
    assert_eq!(renew.len(), 1);
}

#[test]
#[allow(clippy::expect_used)]
fn fix_runs_when_a_test_asked_for_changes_even_if_the_review_passed() {
    use ChainStepIntent::*;
    let h = harness();
    let mut request = h.standard("req-9");
    request.steps = vec![
        step("implement", Implement, "claude-code", &h.claude, &[]),
        step("review", Review, "codex", &h.codex, &["implement"]),
        step("test", Test, "codex", &h.codex, &["implement"]),
        step("fix", Fix, "claude-code", &h.claude, &["review", "test"]),
    ];
    let chain = h.chains.start(request, None).expect("start").id;
    h.complete(&chain, "implement", ChainStepResult::Passed);
    h.complete(&chain, "review", ChainStepResult::Passed);
    h.complete(&chain, "test", ChainStepResult::ChangesRequested);
    h.chains.apply_rules().expect("rules");
    assert_eq!(h.phase(&chain, "fix"), ChainStepPhase::Starting);
}

#[test]
#[allow(clippy::expect_used)]
fn a_cancelled_step_blocks_the_chain_with_a_next_action() {
    let h = harness();
    let chain = h
        .chains
        .start(h.standard("req-10"), None)
        .expect("start")
        .id;
    h.operations
        .cancel_pending(&h.operation(&chain, "implement"))
        .expect("cancel step from the queue");
    let blocked = h.chains.get(&chain).expect("chain");
    assert_eq!(blocked.phase, ChainPhase::Blocked);
    assert!(
        blocked
            .next_action
            .is_some_and(|text| text.contains("was cancelled"))
    );
    assert!(h.chains.retry_step(&chain, "implement", None).is_ok());
}

#[test]
#[allow(clippy::expect_used)]
fn retry_ends_an_unreported_attempt_and_respects_a_paused_chain() {
    let h = harness();
    let chain = h
        .chains
        .start(h.standard("req-11"), None)
        .expect("start")
        .id;
    let first = h.operation(&chain, "implement");
    h.operations
        .claim_user_squad_agent(&first)
        .expect("claim")
        .expect("claimable");
    h.operations
        .bind(&first, None, Some(&first), None, None)
        .expect("bind");
    assert!(h.chains.mark_awaiting_report(&first).expect("await"));
    h.chains.pause(&chain).expect("pause");
    let authorize = h
        .chains
        .retry_step(&chain, "implement", None)
        .expect("retry");
    assert!(authorize.is_empty(), "a paused chain authorizes nothing");
    assert_eq!(h.status(&first), OperationStatus::Interrupted);
    let second = h.operation(&chain, "implement");
    assert_ne!(second, first);
    assert_eq!(h.status(&second), OperationStatus::Paused);
    // A second retry of the now-pending attempt is refused instead of orphaning an agent.
    assert_eq!(
        h.chains
            .retry_step(&chain, "implement", None)
            .err()
            .map(|error| error.code),
        Some("chain_step_not_retryable")
    );
    let resumed = h.chains.resume(&chain).expect("resume");
    assert!(resumed.contains(&second));
}

#[test]
fn a_shared_worktree_chain_starts_with_one_step() {
    use ChainStepIntent::*;
    let h = harness();
    let mut request = h.standard("req-12");
    request.steps = vec![
        step("review", Review, "codex", &h.codex, &[]),
        step("test", Test, "codex", &h.codex, &[]),
    ];
    assert_eq!(
        h.chains.start(request.clone(), None).err().map(|e| e.code),
        Some("chain_shared_single_start")
    );
    request.worktree = ChainWorktree::Project;
    assert!(h.chains.start(request, None).is_ok());
}
