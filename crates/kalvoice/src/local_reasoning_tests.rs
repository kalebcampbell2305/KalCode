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
fn exact_fallthrough_workspace_name_is_preserved_but_unknown_or_ambiguous_is_refused() {
    let text = "put me in the project KalCode";
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
            "put me in the project ProductionSecrets",
            &[(WORKSPACE_ID, "KalCode")],
        ))
        .is_empty()
    );

    let duplicate_id = "0199a914-5ea1-7db0-b36b-aee1bdc846d7";
    assert!(
        grounded_action_candidates(&request(
            "put me in the project KalCode",
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
    let text = "bring me to settings";
    assert!(matches!(
        grammar::understand(text),
        Understood::Intent {
            intent: KalVoiceIntent::Reasoning { .. },
            ..
        }
    ));
    let candidates = grounded_action_candidates(&request(text, &[(WORKSPACE_ID, "KalCode")]));
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].label, "Open settings");
    assert_eq!(
        candidates[0].intent,
        KalVoiceIntent::Navigate {
            surface: kalcode_contracts::app::SurfaceId::Settings
        }
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
