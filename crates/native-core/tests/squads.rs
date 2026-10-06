use std::sync::{Arc, Barrier};

use kalcode_contracts::operations::OperationStatus;
use kalcode_contracts::squads::{SquadDefinition, SquadMemberDefinition, SquadRecipe};
use kalcode_core::flags::BuildChannel;
use kalcode_core::operations::OperationsStore;
use kalcode_core::plans::{Limited, PlanLimit, PlanTier};
use kalcode_core::squads::SquadsStore;
use kalcode_core::{Core, CoreConfig, Paths};
use rusqlite::params;

#[allow(clippy::expect_used)]
fn open(data: &std::path::Path) -> Arc<Core> {
    Arc::new(
        Core::open(CoreConfig {
            paths: Paths::new(data),
            app_version: "0.1.8-test".into(),
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
fn account(core: &Core, provider_id: &str, label: &str) -> String {
    let id = uuid::Uuid::now_v7().to_string();
    core.transact(|tx| {
        tx.execute(
            "INSERT INTO provider_accounts (
               id, provider_id, display_name, authentication_state, is_default, created_at
             ) VALUES (?1, ?2, ?3, 'authenticated', 0, '2026-10-05T12:00:00.000Z')",
            params![id, provider_id, label],
        )?;
        Ok(((), Vec::new()))
    })
    .expect("insert provider account");
    id
}

fn member(key: &str, provider_id: &str, account_id: &str) -> SquadMemberDefinition {
    SquadMemberDefinition {
        key: key.into(),
        name: format!("{key} agent"),
        provider_id: provider_id.into(),
        provider_account_id: account_id.into(),
        model: "test-model".into(),
        effort: "high".into(),
        role: "implementation".into(),
        task: Some(format!("Implement {key}.")),
        worktree: true,
        depends_on: Vec::new(),
        manager_key: None,
        owned_paths: vec![format!("crates/{key}")],
    }
}

fn squad(members: Vec<SquadMemberDefinition>) -> SquadDefinition {
    SquadDefinition {
        id: uuid::Uuid::now_v7().to_string(),
        name: "Release crew".into(),
        goal: "Deliver the verified change.".into(),
        members,
    }
}

#[test]
fn launch_is_atomic_and_exactly_idempotent() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let core = open(data.path());
    let workspace_id = workspace(&core, project.path());
    let account_id = account(&core, "codex", "Codex A");
    let store = SquadsStore::new(core.clone());
    let saved = store
        .save_squad(squad(vec![
            member("one", "codex", &account_id),
            member("two", "codex", &account_id),
        ]))
        .expect("save squad");

    let limit = PlanLimit {
        tier: PlanTier::Free,
        kind: Limited::QueuedTasks,
        max: 1,
    };
    assert_eq!(
        store
            .launch(
                "atomic-request",
                &saved.id,
                &workspace_id,
                None,
                Some(limit)
            )
            .expect_err("whole launch exceeds queue cap")
            .code,
        "too_many_queued_tasks"
    );
    assert!(store.list_launches().expect("launches").is_empty());
    assert!(
        kalcode_core::operations::OperationsStore::new(core.clone())
            .snapshot()
            .expect("operations")
            .2
            .is_empty()
    );

    let barrier = Arc::new(Barrier::new(6));
    let launches = (0..6)
        .map(|_| {
            let store = store.clone();
            let barrier = barrier.clone();
            let squad_id = saved.id.clone();
            let workspace_id = workspace_id.clone();
            std::thread::spawn(move || {
                barrier.wait();
                store
                    .launch("stable-request", &squad_id, &workspace_id, None, None)
                    .expect("concurrent idempotent launch")
            })
        })
        .collect::<Vec<_>>()
        .into_iter()
        .map(|thread| thread.join().expect("launch thread"))
        .collect::<Vec<_>>();
    let first = launches[0].clone();
    assert!(launches.iter().all(|launch| launch == &first));
    let replay = store
        .launch("stable-request", &saved.id, &workspace_id, None, None)
        .expect("idempotent replay");
    assert_eq!(replay, first);
    assert_eq!(first.members.len(), 2);
    assert_eq!(store.snapshot().expect("snapshot").operations.len(), 2);
    assert_eq!(
        store
            .launch(
                "stable-request",
                &saved.id,
                &workspace_id,
                Some("Different goal"),
                None,
            )
            .expect_err("request id cannot change meaning")
            .code,
        "squad_launch_request_conflict"
    );
}

#[test]
fn launch_maps_mixed_provider_dag_and_serializes_shared_ownership() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let core = open(data.path());
    let workspace_id = workspace(&core, project.path());
    let codex = account(&core, "codex", "Codex");
    let claude = account(&core, "claude-code", "Claude");
    let store = SquadsStore::new(core.clone());

    let mut implementation = member("implementation", "codex", &codex);
    implementation.worktree = false;
    implementation.owned_paths = vec!["crates/native-core".into()];
    let mut tests = member("tests", "claude-code", &claude);
    tests.worktree = false;
    tests.owned_paths = vec!["crates/native-core/tests".into()];
    tests.task = None;
    tests.model.clear();
    tests.effort.clear();
    tests.role.clear();
    let mut definition = squad(vec![implementation, tests]);
    definition.goal.clear();
    let saved = store.save_squad(definition).expect("save mixed squad");
    let launch = store
        .launch(
            "mixed-request",
            &saved.id,
            &workspace_id,
            Some("Use the launch-specific goal."),
            None,
        )
        .expect("launch mixed squad");
    let snapshot = store.snapshot().expect("snapshot");
    let first_id = &launch.members[0].operation_id;
    let second = snapshot
        .operations
        .iter()
        .find(|operation| operation.id == launch.members[1].operation_id)
        .expect("second operation");
    assert_eq!(second.spec.provider_id.as_deref(), Some("claude-code"));
    assert_eq!(second.spec.prompt, None, "taskless member stays taskless");
    assert_eq!(second.spec.model, None);
    assert_eq!(second.spec.effort, None);
    assert_eq!(second.spec.dependencies, vec![first_id.clone()]);
    assert_eq!(snapshot.operations[0].status, OperationStatus::Queued);
    let first = snapshot
        .operations
        .iter()
        .find(|operation| operation.id == *first_id)
        .expect("first operation");
    assert_eq!(first.source, "operations");
    assert!(
        first
            .spec
            .prompt
            .as_deref()
            .is_some_and(|prompt| prompt.contains("Use the launch-specific goal."))
    );
}

#[test]
fn shared_checkout_unknown_ownership_serializes_but_disjoint_scopes_stay_parallel() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let core = open(data.path());
    let workspace_id = workspace(&core, project.path());
    let account_id = account(&core, "codex", "Codex");
    let store = SquadsStore::new(core);

    let mut unknown = member("unknown", "codex", &account_id);
    unknown.worktree = false;
    unknown.owned_paths.clear();
    let mut scoped = member("scoped", "codex", &account_id);
    scoped.worktree = false;
    scoped.owned_paths = vec!["crates/native-core".into()];
    let mut unknown_definition = squad(vec![unknown, scoped]);
    unknown_definition.name = "Unknown ownership crew".into();
    let unknown_definition = store
        .save_squad(unknown_definition)
        .expect("save unknown ownership squad");
    let unknown_launch = store
        .launch(
            "unknown-ownership-request",
            &unknown_definition.id,
            &workspace_id,
            None,
            None,
        )
        .expect("serialize unknown shared ownership");
    let unknown_operations = store.snapshot().expect("unknown snapshot").operations;
    let unknown_operation = unknown_operations
        .iter()
        .find(|operation| operation.id == unknown_launch.members[0].operation_id)
        .expect("unknown operation");
    let unknown_prompt = unknown_operation
        .spec
        .prompt
        .as_deref()
        .expect("unknown ownership prompt");
    assert!(unknown_prompt.contains("workspace-wide ownership undeclared"));
    assert!(!unknown_prompt.contains("within the declared ownership boundary"));
    let scoped_operation = unknown_operations
        .iter()
        .find(|operation| operation.id == unknown_launch.members[1].operation_id)
        .expect("scoped operation");
    assert_eq!(
        scoped_operation.spec.dependencies,
        vec![unknown_launch.members[0].operation_id.clone()],
        "an undeclared shared-checkout scope is conservatively workspace-wide"
    );

    let mut frontend = member("frontend", "codex", &account_id);
    frontend.worktree = false;
    frontend.owned_paths = vec!["apps/desktop".into()];
    let mut backend = member("backend", "codex", &account_id);
    backend.worktree = false;
    backend.owned_paths = vec!["crates/providers".into()];
    let mut disjoint_definition = squad(vec![frontend, backend]);
    disjoint_definition.name = "Disjoint ownership crew".into();
    let disjoint_definition = store
        .save_squad(disjoint_definition)
        .expect("save disjoint ownership squad");
    let disjoint_launch = store
        .launch(
            "disjoint-ownership-request",
            &disjoint_definition.id,
            &workspace_id,
            None,
            None,
        )
        .expect("launch disjoint shared ownership");
    let disjoint_operations = store.snapshot().expect("disjoint snapshot").operations;
    for launched_member in &disjoint_launch.members {
        let operation = disjoint_operations
            .iter()
            .find(|operation| operation.id == launched_member.operation_id)
            .expect("disjoint operation");
        assert!(
            operation.spec.dependencies.is_empty(),
            "explicitly disjoint shared-checkout scopes stay parallel"
        );
    }
}

#[test]
fn maximum_shared_checkout_squad_uses_a_bounded_launch_only_ownership_chain() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let core = open(data.path());
    let workspace_id = workspace(&core, project.path());
    let account_id = account(&core, "codex", "Codex");
    let store = SquadsStore::new(core.clone());
    let members = (0..100)
        .map(|index| {
            let mut member = member(&format!("worker-{index:03}"), "codex", &account_id);
            member.worktree = false;
            member.owned_paths = vec!["crates/shared".into()];
            member
        })
        .collect();
    let saved = store.save_squad(squad(members)).expect("save large squad");
    assert!(
        saved
            .members
            .iter()
            .all(|member| member.depends_on.is_empty()),
        "derived ownership ordering is launch-only"
    );
    let launch = store
        .launch("large-shared", &saved.id, &workspace_id, None, None)
        .expect("launch large shared squad");
    let operations = store.snapshot().expect("snapshot").operations;
    assert_eq!(launch.members.len(), 100);
    assert_eq!(operations.len(), 100);
    assert!(
        operations
            .iter()
            .all(|operation| operation.spec.dependencies.len() <= 1),
        "the nearest predecessor forms a transitive ownership chain"
    );
}

#[test]
fn launch_history_bounds_completed_rows_but_never_drops_older_active_work() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let core = open(data.path());
    let workspace_id = workspace(&core, project.path());
    let account_id = account(&core, "codex", "Codex");
    let store = SquadsStore::new(core.clone());
    let operations = OperationsStore::new(core);
    let saved = store
        .save_squad(squad(vec![member("worker", "codex", &account_id)]))
        .expect("save squad");
    let oldest_active = store
        .launch("history-active", &saved.id, &workspace_id, None, None)
        .expect("oldest active launch");
    for index in 0..105 {
        let launch = store
            .launch(
                &format!("history-finished-{index:03}"),
                &saved.id,
                &workspace_id,
                None,
                None,
            )
            .expect("finished launch");
        let operation_id = &launch.members[0].operation_id;
        operations
            .claim(Some(operation_id))
            .expect("claim")
            .expect("claimable");
        operations
            .finish(operation_id, OperationStatus::Succeeded, "Completed")
            .expect("finish");
    }
    let launches = store.list_launches().expect("bounded launch history");
    assert_eq!(launches.len(), 101);
    assert!(launches.iter().any(|launch| launch.id == oldest_active.id));
    let snapshot = store.snapshot().expect("snapshot");
    assert_eq!(snapshot.launches.len(), 101);
    assert_eq!(snapshot.operations.len(), 101);
}

#[test]
fn missing_account_blocks_only_affected_member() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let core = open(data.path());
    let workspace_id = workspace(&core, project.path());
    let valid = account(&core, "codex", "Connected");
    let missing_account_id = uuid::Uuid::now_v7().to_string();
    let store = SquadsStore::new(core.clone());
    let saved = store
        .save_squad(squad(vec![
            member("connected", "codex", &valid),
            member("missing", "codex", &missing_account_id),
        ]))
        .expect("templates retain unavailable selections");
    let launch = store
        .launch("partial-request", &saved.id, &workspace_id, None, None)
        .expect("partial availability does not abort launch");
    let snapshot = store.snapshot().expect("snapshot");
    let status = |key: &str| {
        let operation_id = launch
            .members
            .iter()
            .find(|member| member.key == key)
            .expect("member")
            .operation_id
            .as_str();
        snapshot
            .operations
            .iter()
            .find(|operation| operation.id == operation_id)
            .expect("operation")
            .status
    };
    assert_eq!(status("connected"), OperationStatus::Queued);
    assert_eq!(status("missing"), OperationStatus::Blocked);
    let missing_id = &launch
        .members
        .iter()
        .find(|member| member.key == "missing")
        .expect("missing member")
        .operation_id;
    let operations = kalcode_core::operations::OperationsStore::new(core.clone());
    let missing = operations.get(missing_id).expect("missing operation");
    assert!(missing.attention_reason.is_some());
    let connected_id = &launch
        .members
        .iter()
        .find(|member| member.key == "connected")
        .expect("connected member")
        .operation_id;
    operations
        .claim(Some(connected_id))
        .expect("claim connected")
        .expect("connected runnable");
    operations
        .finish(connected_id, OperationStatus::Succeeded, "done")
        .expect("finish unrelated member");
    let missing = operations
        .get(missing_id)
        .expect("missing remains actionable");
    assert_eq!(missing.status, OperationStatus::Blocked);
    assert!(missing.attention_reason.is_some());

    core.transact(|tx| {
        tx.execute(
            "INSERT INTO provider_accounts (
               id, provider_id, display_name, authentication_state, is_default, created_at
             ) VALUES (?1, 'codex', 'Reconnect me', 'not_authenticated', 0,
                       '2026-10-05T12:00:00.000Z')",
            params![missing_account_id],
        )?;
        Ok(((), Vec::new()))
    })
    .expect("restore signed-out account metadata");
    operations.set_paused(true).expect("pause general queue");
    assert_eq!(
        operations
            .claim_user_squad_agent(missing_id)
            .expect_err("signed-out retry remains blocked")
            .code,
        "operation_blocked"
    );
    assert!(
        operations
            .get(missing_id)
            .expect("attention preserved")
            .attention_reason
            .is_some()
    );
    core.transact(|tx| {
        tx.execute(
            "UPDATE provider_accounts SET authentication_state = 'authenticated' WHERE id = ?1",
            params![missing_account_id],
        )?;
        Ok(((), Vec::new()))
    })
    .expect("reconnect account");
    assert!(
        operations
            .clear_attention_hold(missing_id)
            .expect("clear revalidated hold")
    );
    assert!(
        operations
            .claim_user_squad_agent(missing_id)
            .expect("authenticated retry")
            .is_some()
    );
}

#[test]
fn squad_claim_is_scoped_through_global_pause_and_restart_never_replays() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let core = open(data.path());
    let workspace_id = workspace(&core, project.path());
    let account_id = account(&core, "codex", "Codex");
    let store = SquadsStore::new(core.clone());
    let mut root = member("root", "codex", &account_id);
    root.worktree = false;
    let mut dependent = member("dependent", "codex", &account_id);
    dependent.worktree = false;
    dependent.depends_on = vec!["root".into()];
    let saved = store
        .save_squad(squad(vec![root, dependent]))
        .expect("save squad");
    let launch = store
        .launch("restart-safe", &saved.id, &workspace_id, None, None)
        .expect("launch");
    let operations = kalcode_core::operations::OperationsStore::new(core.clone());
    for member in &launch.members {
        assert!(
            operations
                .mark_squad_authorized(&member.operation_id)
                .expect("first authorization")
        );
        assert!(
            !operations
                .mark_squad_authorized(&member.operation_id)
                .expect("replayed authorization")
        );
    }
    operations.set_paused(true).expect("pause general queue");
    let root_id = &launch.members[0].operation_id;
    assert!(
        operations
            .claim_user_squad_agent(root_id)
            .expect("scoped user claim")
            .is_some()
    );
    let unrelated = operations
        .enqueue(kalcode_contracts::operations::OperationSpec {
            name: "Unrelated agent".into(),
            workspace_id: workspace_id.clone(),
            kind: kalcode_contracts::operations::OperationKind::Agent,
            command: None,
            prompt: None,
            provider_id: Some("codex".into()),
            provider_account_id: Some(account_id),
            model: None,
            effort: None,
            dependencies: Vec::new(),
            priority: 0,
            lane: kalcode_contracts::operations::OperationLane::Next,
            environment: kalcode_contracts::operations::OperationEnvironmentKind::Local,
            urls: Vec::new(),
            env_keys: Vec::new(),
        })
        .expect("unrelated agent");
    assert_eq!(
        operations
            .claim_user_squad_agent(&unrelated.id)
            .expect_err("pause bypass is Squad-bound")
            .code,
        "operations_paused"
    );

    operations
        .finish(root_id, OperationStatus::Succeeded, "done")
        .expect("finish root");
    assert_eq!(
        operations
            .hold_unstarted_squad_members_after_restart()
            .expect("restart recovery"),
        1
    );
    let dependent_id = &launch.members[1].operation_id;
    let recovered = operations.get(dependent_id).expect("recovered dependent");
    assert_eq!(recovered.status, OperationStatus::Paused);
    assert!(recovered.attention_reason.is_some());
    assert_eq!(
        operations
            .hold_unstarted_squad_members_after_restart()
            .expect("idempotent recovery"),
        0
    );
    operations
        .hold(dependent_id, false)
        .expect("explicit resume clears attention");
    let recovered = operations.get(dependent_id).expect("resumed dependent");
    assert_eq!(recovered.attention_reason, None);
    assert!(
        operations
            .claim_user_squad_agent(dependent_id)
            .expect("dependent claim after explicit resume")
            .is_some()
    );
}

#[test]
fn secret_shaped_goal_overrides_fail_before_any_launch_write() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let core = open(data.path());
    let workspace_id = workspace(&core, project.path());
    let account_id = account(&core, "codex", "Codex");
    let store = SquadsStore::new(core.clone());
    let saved = store
        .save_squad(squad(vec![member("worker", "codex", &account_id)]))
        .expect("save squad");
    let recipe = store
        .save_recipe(
            SquadRecipe {
                id: uuid::Uuid::now_v7().to_string(),
                name: "Secure launch".into(),
                squad_id: saved.id.clone(),
                goal: None,
            },
            None,
        )
        .expect("save recipe");
    let synthetic = "api_key = sk_test_synthetic_abcdefghijklmnopqrstuvwxyz";
    assert_eq!(
        store
            .launch(
                "secret-direct",
                &saved.id,
                &workspace_id,
                Some(synthetic),
                None,
            )
            .expect_err("direct secret override")
            .code,
        "squad_secret_detected"
    );
    assert_eq!(
        store
            .launch_recipe(
                "secret-recipe",
                &recipe.id,
                &workspace_id,
                Some(synthetic),
                None,
            )
            .expect_err("recipe secret override")
            .code,
        "squad_secret_detected"
    );
    assert!(store.list_launches().expect("launches").is_empty());
    assert!(
        kalcode_core::operations::OperationsStore::new(core)
            .snapshot()
            .expect("operations")
            .2
            .is_empty()
    );
}

#[test]
fn rejects_invalid_dag_without_mutating_saved_definition() {
    let data = tempfile::tempdir().expect("data");
    let core = open(data.path());
    let account_id = account(&core, "codex", "Codex");
    let store = SquadsStore::new(core);
    let mut first = member("first", "codex", &account_id);
    first.depends_on = vec!["second".into()];
    let mut second = member("second", "codex", &account_id);
    second.depends_on = vec!["first".into()];
    assert_eq!(
        store
            .save_squad(squad(vec![first, second]))
            .expect_err("cycle")
            .code,
        "squad_dependency_cycle"
    );
    assert!(store.list_squads().expect("squads").is_empty());
}

#[test]
fn templates_recipes_launches_and_operation_links_survive_restart() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let (workspace_id, squad_id, recipe_id, launch_id, operation_id) = {
        let core = open(data.path());
        let workspace_id = workspace(&core, project.path());
        let account_id = account(&core, "codex", "Codex");
        let store = SquadsStore::new(core);
        let saved = store
            .save_squad(squad(vec![member("worker", "codex", &account_id)]))
            .expect("save squad");
        let recipe = store
            .save_recipe(
                SquadRecipe {
                    id: uuid::Uuid::now_v7().to_string(),
                    name: "Ship it".into(),
                    squad_id: saved.id.clone(),
                    goal: Some("Run the release recipe.".into()),
                },
                None,
            )
            .expect("save recipe");
        let launch = store
            .launch_recipe("restart-request", &recipe.id, &workspace_id, None, None)
            .expect("launch recipe");
        (
            workspace_id,
            saved.id,
            recipe.id,
            launch.id,
            launch.members[0].operation_id.clone(),
        )
    };

    let core = open(data.path());
    let store = SquadsStore::new(core);
    assert_eq!(store.list_squads().expect("squads")[0].id, squad_id);
    assert_eq!(store.list_recipes().expect("recipes").len(), 1);
    assert_eq!(
        store.get_launch(&launch_id).expect("launch").workspace_id,
        workspace_id
    );
    assert_eq!(
        store
            .get_member(&operation_id)
            .expect("member lookup")
            .expect("member")
            .member_key,
        "worker"
    );
    assert!(
        store
            .snapshot()
            .expect("snapshot")
            .operations
            .iter()
            .find(|operation| operation.id == operation_id)
            .and_then(|operation| operation.spec.prompt.as_deref())
            .is_some_and(|prompt| prompt.contains("Run the release recipe."))
    );
    let mut changed_recipe = store.resolve_recipe(&recipe_id).expect("recipe");
    changed_recipe.goal = Some("A newly edited recipe goal.".into());
    store
        .save_recipe(changed_recipe, None)
        .expect("update recipe after launch");
    assert_eq!(
        store
            .launch_recipe("restart-request", &recipe_id, &workspace_id, None, None,)
            .expect("idempotent replay after recipe edit")
            .id,
        launch_id
    );
}

#[test]
fn manager_reassignment_updates_only_the_worker_relation() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let core = open(data.path());
    let workspace_id = workspace(&core, project.path());
    let account_id = account(&core, "codex", "Codex");
    let store = SquadsStore::new(core);
    let lead = member("lead", "codex", &account_id);
    let manager = member("manager", "codex", &account_id);
    let mut worker = member("worker", "codex", &account_id);
    worker.manager_key = Some("lead".into());
    let saved = store
        .save_squad(squad(vec![lead, manager, worker]))
        .expect("save hierarchy");
    let launch = store
        .launch("manager-request", &saved.id, &workspace_id, None, None)
        .expect("launch hierarchy");
    let before: Vec<_> = launch
        .members
        .iter()
        .map(|member| (member.key.clone(), member.operation_id.clone()))
        .collect();
    let reassigned = store
        .reassign_manager(&launch.id, "worker", Some("manager"))
        .expect("reassign manager");
    assert_eq!(
        reassigned
            .members
            .iter()
            .find(|member| member.key == "worker")
            .expect("worker")
            .manager_key
            .as_deref(),
        Some("manager")
    );
    assert_eq!(
        before,
        reassigned
            .members
            .iter()
            .map(|member| (member.key.clone(), member.operation_id.clone()))
            .collect::<Vec<_>>()
    );
}
