use kalcode_contracts::kalvoice::KalVoiceIntent;
use kalcode_contracts::threads::WorkspaceOption;

use crate::grammar::Understood;

use super::*;

const WORKSPACE_ID: &str = "0199a914-5ea1-7db0-b36b-aee1bdc846d6";

fn request(text: &str, workspaces: &[(&str, &str)]) -> LocalInterpretationRequest {
    LocalInterpretationRequest {
        request: text.into(),
        workspace_id: workspaces.first().map(|(id, _)| (*id).to_owned()),
        workspaces: workspaces
            .iter()
            .map(|(id, name)| WorkspaceOption {
                id: (*id).into(),
                name: (*name).into(),
            })
            .collect(),
        grounded_actions: Vec::new(),
    }
}

#[test]
fn fallthrough_candidates_are_opaque_host_owned_safely_labeled_and_bounded() {
    let text = "pull up approval status";
    assert!(matches!(
        grammar::understand(text),
        Understood::Intent {
            intent: KalVoiceIntent::Reasoning { .. },
            ..
        }
    ));

    let candidates = grounded_action_candidates(&request(text, &[(WORKSPACE_ID, "KalCode")]));
    assert_eq!(
        candidates
            .iter()
            .map(|candidate| {
                (
                    candidate.id.as_str(),
                    candidate.label.as_str(),
                    candidate.intent.clone(),
                )
            })
            .collect::<Vec<_>>(),
        vec![
            (
                "c0",
                "Show pending approvals",
                KalVoiceIntent::ShowApprovals,
            ),
            ("c1", "Show thread status", KalVoiceIntent::StatusReport,),
        ]
    );
    assert!(candidates.iter().all(|candidate| {
        !candidate.label.contains('{')
            && !candidate.label.contains("0199")
            && !candidate.label.contains("show_approvals")
    }));
    assert!(candidates.len() <= MAX_GROUNDED_ACTION_CANDIDATES);
}

#[test]
fn live_scene_actions_join_the_same_opaque_bounded_candidate_set() {
    let mut input = request(
        "find Claude working on the website",
        &[(WORKSPACE_ID, "KalCode")],
    );
    input.grounded_actions = vec![LocalActionGrounding {
        label: "Open Website refresh · Claude Code · KalCode · Running frontend tests".into(),
        intent: KalVoiceIntent::OpenThread {
            query: "0199a914-5ea1-7db0-b36b-aee1bdc846d8".into(),
        },
    }];

    let candidates = grounded_action_candidates(&input);
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].id, "c0");
    assert_eq!(
        candidates[0].intent,
        KalVoiceIntent::OpenThread {
            query: "0199a914-5ea1-7db0-b36b-aee1bdc846d8".into(),
        }
    );
    assert!(!candidates[0].label.contains("0199"));
}

#[test]
fn malformed_duplicate_and_excess_live_scene_actions_are_removed_before_inference() {
    let mut input = request(
        "open the terminal working on Browser",
        &[(WORKSPACE_ID, "KalCode")],
    );
    input.grounded_actions = (0..MAX_GROUNDED_ACTION_CANDIDATES + 4)
        .map(|index| LocalActionGrounding {
            label: format!("Open Browser task {index}"),
            intent: KalVoiceIntent::OpenThread {
                query: format!("0199a914-5ea1-7db0-b36b-aee1bdc8{index:04x}"),
            },
        })
        .chain([
            LocalActionGrounding {
                label: "Open Browser task 0".into(),
                intent: KalVoiceIntent::OpenThread {
                    query: "0199a914-5ea1-7db0-b36b-aee1bdc80000".into(),
                },
            },
            LocalActionGrounding {
                label: "unsafe\u{202e}label".into(),
                intent: KalVoiceIntent::OpenThread {
                    query: "0199a914-5ea1-7db0-b36b-aee1bdc80999".into(),
                },
            },
        ])
        .collect();
    input.grounded_actions =
        bounded_action_snapshot(input.grounded_actions, input.workspaces.as_slice());

    let candidates = grounded_action_candidates(&input);
    assert_eq!(candidates.len(), MAX_GROUNDED_ACTION_CANDIDATES);
    assert_eq!(
        candidates
            .iter()
            .filter(|candidate| candidate.intent
                == KalVoiceIntent::OpenThread {
                    query: "0199a914-5ea1-7db0-b36b-aee1bdc80000".into(),
                })
            .count(),
        1
    );
    assert!(
        candidates
            .iter()
            .all(|candidate| !candidate.label.contains('\u{202e}'))
    );
}

#[test]
fn exact_fallthrough_workspace_name_is_preserved_but_unknown_or_ambiguous_is_refused() {
    // 0.1.5: the deterministic second chance now understands "put me in the project X" itself.
    assert_eq!(
        grammar::understand("put me in the project KalCode"),
        Understood::Intent {
            intent: KalVoiceIntent::OpenWorkspace {
                query: "kalcode".into()
            },
            target: None,
        }
    );
    let text = "take me into the project KalCode";
    assert!(matches!(
        grammar::understand(text),
        Understood::Intent {
            intent: KalVoiceIntent::Reasoning { .. },
            ..
        }
    ));
    let candidates = grounded_action_candidates(&request(text, &[(WORKSPACE_ID, "KalCode")]));
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].id, "c0");
    assert_eq!(candidates[0].label, "Open workspace: KalCode");
    assert_eq!(
        candidates[0].intent,
        KalVoiceIntent::OpenWorkspace {
            query: "KalCode".into()
        }
    );

    assert!(
        grounded_action_candidates(&request(
            "take me into the project ProductionSecrets",
            &[(WORKSPACE_ID, "KalCode")],
        ))
        .is_empty()
    );

    let duplicate_id = "0199a914-5ea1-7db0-b36b-aee1bdc846d7";
    assert!(
        grounded_action_candidates(&request(
            "take me into the project KalCode",
            &[(WORKSPACE_ID, "KalCode"), (duplicate_id, "kalcode")],
        ))
        .is_empty()
    );

    assert!(
        grounded_action_candidates(&request(
            "put me in ProductionSecrets and show status",
            &[(WORKSPACE_ID, "KalCode")],
        ))
        .is_empty(),
        "an unknown workspace qualifier must never collapse to another offered action"
    );
}

#[test]
fn navigation_fallthrough_uses_only_canonical_surface_registry_entries() {
    // 0.1.5: the deterministic second chance understands these phrasings itself, so the model
    // is never offered them.
    let text = "bring me to settings";
    assert_eq!(
        grammar::understand(text),
        Understood::Intent {
            intent: KalVoiceIntent::Navigate {
                surface: kalcode_contracts::app::SurfaceId::Settings
            },
            target: None,
        }
    );
    assert!(grounded_action_candidates(&request(text, &[(WORKSPACE_ID, "KalCode")])).is_empty());
    assert_eq!(
        grammar::local_reasoning_groundings("bring me to settings"),
        Vec::new()
    );

    assert!(
        grounded_action_candidates(&request(
            "bring me to billing",
            &[(WORKSPACE_ID, "KalCode")],
        ))
        .is_empty(),
        "an unregistered surface must not become an executable candidate"
    );
}

#[test]
fn greetings_negations_compounds_and_coding_requests_offer_nothing_executable() {
    for text in [
        "hello KalVoice",
        "do not open settings",
        "open settings and delete the project",
        "write a Rust database migration",
        "send this prompt to Codex",
        "show approvals",
    ] {
        assert!(
            grounded_action_candidates(&request(text, &[(WORKSPACE_ID, "KalCode")])).is_empty(),
            "unexpected candidate for {text}"
        );
    }
}

#[test]
fn model_controlled_text_bounds_apply_to_the_original_canonical_value() {
    let padded = format!("{}x", " ".repeat(MAX_ACTION_TEXT_CHARS + 1));
    let workspaces = vec![WorkspaceOption {
        id: WORKSPACE_ID.into(),
        name: "KalCode".into(),
    }];
    for intent in [
        KalVoiceIntent::OpenThread {
            query: padded.clone(),
        },
        KalVoiceIntent::Focus {
            query: padded.clone(),
        },
        KalVoiceIntent::Search {
            query: padded.clone(),
        },
    ] {
        assert!(validate_action(intent, &workspaces).is_err());
    }
    assert!(!valid_text(" padded "));
    assert!(!valid_workspace_name(&format!(
        "{}KalCode",
        " ".repeat(MAX_WORKSPACE_NAME_CHARS + 1)
    )));
}

#[test]
fn the_local_interpreter_can_never_send_or_clear_prompt_text() {
    use kalcode_contracts::sessions::SessionAttention;
    let workspaces = vec![WorkspaceOption {
        id: WORKSPACE_ID.into(),
        name: "KalCode".into(),
    }];
    for intent in [
        KalVoiceIntent::SubmitFocused,
        KalVoiceIntent::ClearFocused,
        KalVoiceIntent::DirectPrompt {
            target: "Authentication".into(),
            prompt: "review the login failure".into(),
        },
    ] {
        assert!(
            validate_action(intent.clone(), &workspaces).is_err(),
            "{intent:?}"
        );
    }
    for intent in [
        KalVoiceIntent::FocusPrevious,
        KalVoiceIntent::FocusByState {
            state: SessionAttention::WaitingForPermission,
        },
        KalVoiceIntent::WhichSessions {
            state: SessionAttention::Failed,
        },
    ] {
        assert!(
            validate_action(intent.clone(), &workspaces).is_ok(),
            "{intent:?}"
        );
    }
}

#[test]
fn the_local_interpreter_can_never_set_a_workspace_account() {
    let workspaces = vec![WorkspaceOption {
        id: WORKSPACE_ID.into(),
        name: "KalCode".into(),
    }];
    for workspace_id in [None, Some(WORKSPACE_ID.to_owned())] {
        let intent = KalVoiceIntent::SetWorkspaceAccount {
            provider_id: kalcode_contracts::agent::ProviderId::new(
                kalcode_contracts::agent::ProviderId::GEMINI_CLI,
            ),
            account_query: "Gemini A".into(),
            workspace_id,
        };
        assert!(
            validate_action(intent.clone(), &workspaces).is_err(),
            "{intent:?}"
        );
    }
    // A rebind still only asks the person to confirm, so an interpreted one stays valid.
    assert!(
        validate_action(
            KalVoiceIntent::RebindThreadAccount {
                thread_query: None,
                provider_id: None,
                account_query: "Gemini B".into(),
            },
            &workspaces
        )
        .is_ok()
    );
}
