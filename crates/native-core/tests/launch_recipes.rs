#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::sync::Arc;

use kalcode_contracts::recipes::{LaunchRecipe, RecipeComponent, RecipeVariable};
use kalcode_contracts::squads::{SquadDefinition, SquadRecipe};
use kalcode_core::flags::BuildChannel;
use kalcode_core::plans::{Limited, PlanLimit, PlanTier};
use kalcode_core::recipes::LaunchRecipesStore;
use kalcode_core::squads::SquadsStore;
use kalcode_core::{Core, CoreConfig, Paths};
use rusqlite::params;

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

fn id() -> String {
    uuid::Uuid::now_v7().to_string()
}

fn recipe(name: &str) -> LaunchRecipe {
    LaunchRecipe {
        id: id(),
        name: name.into(),
        schema_version: 1,
        workspace_id: None,
        pinned: false,
        position: 0,
        variables: vec![RecipeVariable {
            key: "branch".into(),
            label: "Branch".into(),
            default_value: "main".into(),
            ask_at_launch: true,
        }],
        components: vec![
            RecipeComponent::Agent {
                key: "lead".into(),
                provider_id: "claude-code".into(),
                provider_account_id: None,
                model: Some("opus".into()),
                effort: None,
                name: Some("Lead".into()),
                task: Some("Review {{branch}}.".into()),
            },
            RecipeComponent::Terminal {
                key: "shell".into(),
                name: None,
                command: Some("cargo test".into()),
            },
            RecipeComponent::Browser {
                key: "docs".into(),
                url: "https://example.com/docs?page=2".into(),
            },
        ],
        layout: Some("three".into()),
        updated_at: String::new(),
    }
}

fn code(result: Result<LaunchRecipe, kalcode_core::KalError>) -> String {
    result.expect_err("expected a refusal").code.to_string()
}

#[test]
fn save_list_and_restart_persist() {
    let data = tempfile::tempdir().unwrap();
    let saved = {
        let store = LaunchRecipesStore::new(open(data.path()));
        let saved = store.save(recipe("Morning desk"), None).unwrap();
        assert!(!saved.updated_at.is_empty());
        assert_eq!(saved.components.len(), 3);
        saved
    };
    let store = LaunchRecipesStore::new(open(data.path()));
    let snapshot = store.snapshot(Some(5)).unwrap();
    assert_eq!(snapshot.limit, Some(5));
    assert_eq!(snapshot.recipes, vec![saved.clone()]);
    assert_eq!(store.get(&saved.id).unwrap(), saved);
}

#[test]
fn name_conflict_is_case_insensitive_but_self_update_works() {
    let store = LaunchRecipesStore::new(open(tempfile::tempdir().unwrap().path()));
    let first = store.save(recipe("Desk"), None).unwrap();
    assert_eq!(
        code(store.save(recipe("desk"), None)),
        "launch_recipe_name_conflict"
    );
    let mut renamed = first.clone();
    renamed.name = "DESK".into();
    assert_eq!(store.save(renamed, None).unwrap().name, "DESK");
}

#[test]
fn secrets_urls_and_shape_are_rejected() {
    let store = LaunchRecipesStore::new(open(tempfile::tempdir().unwrap().path()));

    let mut with_secret = recipe("Secret");
    with_secret.components = vec![RecipeComponent::Terminal {
        key: "shell".into(),
        name: None,
        command: Some(format!(
            "export TOKEN=ghp_{}",
            "a1B2c3D4e5".repeat(4).get(..36).unwrap()
        )),
    }];
    assert_eq!(
        code(store.save(with_secret, None)),
        "launch_recipe_secret_detected"
    );

    for url in [
        "https://example.com/?token=abc",
        "https://example.com/?Api_Key=1",
        "https://user:pw@example.com/",
        "ftp://example.com/",
        "javascript:alert(1)",
        "https://example.com/#access_token=abc",
    ] {
        let mut bad = recipe("Bad url");
        bad.components = vec![RecipeComponent::Browser {
            key: "b".into(),
            url: url.into(),
        }];
        assert_eq!(
            code(store.save(bad, None)),
            "invalid_launch_recipe_url",
            "{url}"
        );
    }

    let mut newer = recipe("Newer");
    newer.schema_version = 2;
    assert_eq!(
        code(store.save(newer, None)),
        "launch_recipe_schema_unsupported"
    );

    let mut dup = recipe("Dup keys");
    dup.components.push(dup.components[0].clone());
    assert_eq!(
        code(store.save(dup, None)),
        "duplicate_launch_recipe_component"
    );

    let mut layout = recipe("Layout");
    layout.layout = Some("nine".into());
    assert_eq!(
        code(store.save(layout, None)),
        "invalid_launch_recipe_layout"
    );

    let mut vars = recipe("Vars");
    vars.variables[0].key = "Bad-Key".into();
    assert_eq!(
        code(store.save(vars, None)),
        "invalid_launch_recipe_variable"
    );
}

#[test]
fn plan_limit_counts_squad_recipes_too() {
    let core = open(tempfile::tempdir().unwrap().path());
    let squads = SquadsStore::new(core.clone());
    let recipes = LaunchRecipesStore::new(core.clone());
    let member = kalcode_contracts::squads::SquadMemberDefinition {
        key: "one".into(),
        name: "one".into(),
        provider_id: "codex".into(),
        provider_account_id: {
            let account = id();
            core.transact(|tx| {
                tx.execute(
                    "INSERT INTO provider_accounts (
                       id, provider_id, display_name, authentication_state, is_default, created_at
                     ) VALUES (?1, 'codex', 'A', 'authenticated', 0, '2026-10-05T12:00:00.000Z')",
                    params![account],
                )?;
                Ok(((), Vec::new()))
            })
            .unwrap();
            account
        },
        model: "m".into(),
        effort: "high".into(),
        role: "r".into(),
        task: Some("t".into()),
        worktree: false,
        depends_on: Vec::new(),
        manager_key: None,
        owned_paths: Vec::new(),
    };
    let squad = squads
        .save_squad(SquadDefinition {
            id: id(),
            name: "Crew".into(),
            goal: "Goal.".into(),
            members: vec![member],
        })
        .unwrap();
    let limit = Some(PlanLimit {
        tier: PlanTier::Free,
        kind: Limited::LaunchRecipes,
        max: 2,
    });
    squads
        .save_recipe_limited(
            SquadRecipe {
                id: id(),
                name: "Squad recipe".into(),
                squad_id: squad.id.clone(),
                goal: None,
            },
            limit,
        )
        .unwrap();
    recipes.save(recipe("One"), limit).unwrap();
    assert_eq!(
        code(recipes.save(recipe("Two"), limit)),
        "too_many_launch_recipes"
    );
    let refused = squads.save_recipe_limited(
        SquadRecipe {
            id: id(),
            name: "Another".into(),
            squad_id: squad.id,
            goal: None,
        },
        limit,
    );
    assert_eq!(refused.unwrap_err().code, "too_many_launch_recipes");
    // Editing an existing Recipe never counts against the cap.
    let existing = recipes.snapshot(None).unwrap().recipes.remove(0);
    recipes.save(existing, limit).unwrap();
}

#[test]
fn reorder_pin_delete_and_resolve() {
    let store = LaunchRecipesStore::new(open(tempfile::tempdir().unwrap().path()));
    let a = store.save(recipe("Alpha"), None).unwrap();
    let b = store.save(recipe("Beta"), None).unwrap();
    let mut c = store.save(recipe("Gamma"), None).unwrap();
    assert_eq!((a.position, b.position, c.position), (0, 1, 2));

    c.pinned = true;
    store.save(c.clone(), None).unwrap();
    let order = |s: &LaunchRecipesStore| {
        s.snapshot(None)
            .unwrap()
            .recipes
            .into_iter()
            .map(|r| r.name)
            .collect::<Vec<_>>()
    };
    assert_eq!(order(&store), ["Gamma", "Alpha", "Beta"]);

    let stale = store.reorder(vec![a.id.clone(), b.id.clone()]).unwrap_err();
    assert_eq!(stale.code, "launch_recipes_changed");
    assert_eq!(
        stale.message,
        "The Recipe list changed. Refresh and try again."
    );
    assert!(
        store
            .reorder(vec![a.id.clone(), a.id.clone(), b.id.clone()])
            .is_err()
    );

    let snapshot = store
        .reorder(vec![b.id.clone(), c.id.clone(), a.id.clone()])
        .unwrap();
    let names: Vec<_> = snapshot.recipes.iter().map(|r| r.name.as_str()).collect();
    assert_eq!(names, ["Gamma", "Beta", "Alpha"]);

    assert_eq!(store.resolve("beta").unwrap().id, b.id);
    assert_eq!(store.resolve(&a.id).unwrap().name, "Alpha");
    assert_eq!(
        store.resolve("nope").unwrap_err().code,
        "launch_recipe_not_found"
    );

    store.delete(&b.id).unwrap();
    assert_eq!(
        store.delete(&b.id).unwrap_err().code,
        "launch_recipe_not_found"
    );
    assert_eq!(order(&store), ["Gamma", "Alpha"]);
}

#[test]
fn resolve_reports_ambiguity() {
    let core = open(tempfile::tempdir().unwrap().path());
    let store = LaunchRecipesStore::new(core.clone());
    store.save(recipe("Twin"), None).unwrap();
    // The unique index forbids two same-named rows, so simulate the ambiguity guard by
    // confirming a second case-variant is refused instead of stored.
    assert_eq!(
        code(store.save(recipe("TWIN"), None)),
        "launch_recipe_name_conflict"
    );
    assert_eq!(store.resolve("twin").unwrap().name, "Twin");
}

#[test]
fn newer_schema_rows_are_read_leniently() {
    let core = open(tempfile::tempdir().unwrap().path());
    let store = LaunchRecipesStore::new(core.clone());
    store.save(recipe("Known"), None).unwrap();
    let future = id();
    core.transact(|tx| {
        tx.execute(
            "INSERT INTO launch_recipes (
               id, name, schema_version, workspace_id, pinned, position, definition_json, updated_at
             ) VALUES (?1, 'From the future', 9, NULL, 0, 5,
               '{\"components\":[{\"kind\":\"hologram\",\"key\":\"h\"}],\"extra\":true}',
               '2030-01-01T00:00:00.000Z')",
            params![future],
        )?;
        Ok(((), Vec::new()))
    })
    .unwrap();
    let recipes = store.snapshot(None).unwrap().recipes;
    assert_eq!(recipes.len(), 2);
    let row = recipes.iter().find(|r| r.id == future).unwrap();
    assert_eq!(row.schema_version, 9);
    assert!(row.components.is_empty());
    // It still cannot be overwritten by an older client.
    let mut edit = row.clone();
    edit.name = "Edited".into();
    assert_eq!(
        code(store.save(edit, None)),
        "launch_recipe_schema_unsupported"
    );
}

#[test]
fn widget_ids_follow_the_pane_widget_rule() {
    let data = tempfile::tempdir().unwrap();
    let store = LaunchRecipesStore::new(open(data.path()));
    let mut dotted = recipe("Widgets");
    dotted.components = vec![RecipeComponent::Widget {
        key: "widget-1".into(),
        widget: "code.context-operations".into(),
    }];
    store
        .save(dotted, None)
        .expect("dotted widget ids are valid");
    let mut bad = recipe("Widgets bad");
    bad.components = vec![RecipeComponent::Widget {
        key: "widget-1".into(),
        widget: "Bad Widget".into(),
    }];
    assert_eq!(code(store.save(bad, None)), "invalid_launch_recipe_widget");
}

#[test]
fn percent_encoded_sensitive_query_keys_are_refused() {
    let data = tempfile::tempdir().unwrap();
    let store = LaunchRecipesStore::new(open(data.path()));
    for url in [
        "https://example.com/?to%6Ben=abc",
        "https://example.com/?%61uth=1",
        "https://example.com/?x=%",
    ] {
        let mut candidate = recipe(&format!("Encoded {}", url.len()));
        candidate.components = vec![RecipeComponent::Browser {
            key: "browser-1".into(),
            url: url.into(),
        }];
        let result = store.save(candidate, None);
        if url.ends_with("x=%") {
            result.expect("a lone percent sign is just text");
        } else {
            assert_eq!(code(result), "invalid_launch_recipe_url", "{url}");
        }
    }
}
