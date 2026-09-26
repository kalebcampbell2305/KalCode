use std::sync::{Arc, Barrier};
use std::time::Duration;

use kalcode_context::{
    Firewall, FirewallPolicy, PromptGate, PromptReview, PromptTarget, WorkspaceRoot,
};

fn firewall() -> Firewall {
    Firewall::new(WorkspaceRoot::none(), FirewallPolicy::default())
}

fn target(account: &str) -> PromptTarget {
    PromptTarget {
        workspace_id: "workspace-1".into(),
        thread_id: Some("thread-1".into()),
        provider_id: "codex".into(),
        provider_account_id: Some(account.into()),
    }
}

fn secret_prompt() -> String {
    let body = ["deterministic", "Q7x", "private", "value"].join("-");
    ["password", "=", &body].concat()
}

#[test]
fn clean_prompts_need_no_review_and_leave_no_confirmation_state() {
    let gate = PromptGate::default();
    let target = target("account-1");
    let prompt = "Refactor the parser and run its focused tests.";

    assert_eq!(
        gate.review(&firewall(), target.clone(), prompt)
            .expect("review"),
        PromptReview::Clean
    );
    let admission = gate
        .admit(&firewall(), &target, prompt, None)
        .expect("clean prompt admitted");
    gate.verify(admission, &target, prompt)
        .expect("boundary verification");
    assert_eq!(gate.pending(), 0);
}

#[test]
fn warning_is_opaque_and_exact_confirmation_is_one_shot() {
    let gate = PromptGate::default();
    let target = target("account-1");
    let prompt = secret_prompt();
    let review = gate
        .review(&firewall(), target.clone(), &prompt)
        .expect("review");
    let PromptReview::ConfirmationRequired(warning) = review else {
        panic!("secret-shaped prompt must warn");
    };

    let public = serde_json::to_string(&warning).expect("serialize warning");
    assert!(!warning.detectors.is_empty());
    assert!(!public.contains(&prompt));
    assert!(!public.contains("sha256"));
    assert!(!public.contains("hash"));

    let admission = gate
        .admit(&firewall(), &target, &prompt, Some(&warning.review_id))
        .expect("explicit exact confirmation");
    gate.verify(admission, &target, &prompt)
        .expect("boundary verification");
    let replay = gate
        .admit(&firewall(), &target, &prompt, Some(&warning.review_id))
        .err()
        .expect("confirmation is one-shot");
    assert_eq!(replay.code(), "context_prompt_confirmation_invalid");
}

#[test]
fn admission_is_bound_to_the_runtime_gate_instance() {
    let first = PromptGate::default();
    let second = PromptGate::default();
    let target = target("account-1");
    let prompt = "A clean bounded prompt.";
    let admission = first
        .admit(&firewall(), &target, prompt, None)
        .expect("admission");

    let error = second
        .verify(admission, &target, prompt)
        .expect_err("another runtime generation cannot consume the proof");
    assert_eq!(error.code(), "context_prompt_confirmation_invalid");
}

#[test]
fn prompt_target_and_account_substitution_consume_the_review() {
    for (changed_target, changed_prompt) in [
        (target("account-2"), secret_prompt()),
        (
            PromptTarget {
                thread_id: Some("thread-2".into()),
                ..target("account-1")
            },
            secret_prompt(),
        ),
        (
            PromptTarget {
                workspace_id: "workspace-2".into(),
                ..target("account-1")
            },
            secret_prompt(),
        ),
        (
            PromptTarget {
                provider_id: "claude-code".into(),
                ..target("account-1")
            },
            secret_prompt(),
        ),
        (target("account-1"), format!("{} changed", secret_prompt())),
    ] {
        let gate = PromptGate::default();
        let original_target = target("account-1");
        let prompt = secret_prompt();
        let PromptReview::ConfirmationRequired(warning) = gate
            .review(&firewall(), original_target.clone(), &prompt)
            .expect("review")
        else {
            panic!("warning");
        };

        let swapped = gate
            .admit(
                &firewall(),
                &changed_target,
                &changed_prompt,
                Some(&warning.review_id),
            )
            .err()
            .expect("object swap denied");
        assert_eq!(swapped.code(), "context_prompt_confirmation_invalid");
        assert_eq!(
            gate.pending(),
            0,
            "a failed object swap invalidates the review"
        );
        assert!(
            gate.admit(
                &firewall(),
                &original_target,
                &prompt,
                Some(&warning.review_id),
            )
            .is_err()
        );
    }
}

#[test]
fn warning_without_explicit_confirmation_fails_closed() {
    let gate = PromptGate::default();
    let error = gate
        .admit(&firewall(), &target("account-1"), &secret_prompt(), None)
        .err()
        .expect("warning needs owner confirmation");
    assert_eq!(error.code(), "context_prompt_confirmation_required");
    assert_eq!(gate.pending(), 0, "admission does not mint approval");
}

#[test]
fn pending_reviews_are_bounded_and_expire() {
    let gate = PromptGate::new(1, Duration::from_secs(60));
    let prompt_target = target("account-1");
    let first = gate
        .review(&firewall(), prompt_target.clone(), &secret_prompt())
        .expect("first review");
    assert!(matches!(first, PromptReview::ConfirmationRequired(_)));
    let full = gate
        .review(
            &firewall(),
            prompt_target,
            &format!("{} again", secret_prompt()),
        )
        .expect_err("bounded pending reviews");
    assert_eq!(full.code(), "context_prompt_review_capacity");

    let expiring = PromptGate::new(1, Duration::ZERO);
    let PromptReview::ConfirmationRequired(warning) = expiring
        .review(&firewall(), target("account-1"), &secret_prompt())
        .expect("review")
    else {
        panic!("warning");
    };
    let expired = expiring
        .admit(
            &firewall(),
            &target("account-1"),
            &secret_prompt(),
            Some(&warning.review_id),
        )
        .err()
        .expect("expired review");
    assert_eq!(expired.code(), "context_prompt_confirmation_invalid");
}

#[test]
fn cancelling_the_full_review_capacity_allows_a_fresh_review() {
    let gate = PromptGate::default();
    let prompt_target = target("account-1");
    let mut review_ids = Vec::new();
    for index in 0..64 {
        let PromptReview::ConfirmationRequired(warning) = gate
            .review(
                &firewall(),
                prompt_target.clone(),
                &format!("{}-{index}", secret_prompt()),
            )
            .expect("review within capacity")
        else {
            panic!("secret-shaped prompt must warn");
        };
        review_ids.push(warning.review_id);
    }
    assert_eq!(gate.pending(), 64);
    assert_eq!(
        gate.review(
            &firewall(),
            prompt_target.clone(),
            &format!("{}-full", secret_prompt()),
        )
        .expect_err("capacity must be bounded")
        .code(),
        "context_prompt_review_capacity"
    );

    for review_id in &review_ids {
        assert!(gate.cancel(review_id).expect("cancel pending review"));
    }
    assert_eq!(gate.pending(), 0);
    assert!(matches!(
        gate.review(
            &firewall(),
            prompt_target,
            &format!("{}-fresh", secret_prompt()),
        )
        .expect("capacity released after cancellation"),
        PromptReview::ConfirmationRequired(_)
    ));
}

#[test]
fn cancellation_is_idempotent_and_never_removes_another_review() {
    let gate = PromptGate::default();
    let prompt_target = target("account-1");
    let first_prompt = format!("{}-first", secret_prompt());
    let second_prompt = format!("{}-second", secret_prompt());
    let PromptReview::ConfirmationRequired(first) = gate
        .review(&firewall(), prompt_target.clone(), &first_prompt)
        .expect("first review")
    else {
        panic!("first warning");
    };
    let PromptReview::ConfirmationRequired(second) = gate
        .review(&firewall(), prompt_target.clone(), &second_prompt)
        .expect("second review")
    else {
        panic!("second warning");
    };

    assert!(
        !gate
            .cancel("unknown-review-id")
            .expect("unknown is harmless")
    );
    assert_eq!(gate.pending(), 2, "unknown id cannot affect another review");
    assert!(gate.cancel(&first.review_id).expect("first cancellation"));
    assert!(!gate.cancel(&first.review_id).expect("double cancellation"));
    assert_eq!(gate.pending(), 1);
    assert_eq!(
        gate.admit(
            &firewall(),
            &prompt_target,
            &first_prompt,
            Some(&first.review_id),
        )
        .err()
        .expect("cancelled review cannot confirm")
        .code(),
        "context_prompt_confirmation_invalid"
    );
    gate.admit(
        &firewall(),
        &prompt_target,
        &second_prompt,
        Some(&second.review_id),
    )
    .expect("unrelated review remains usable");

    let expiring = PromptGate::new(1, Duration::ZERO);
    let PromptReview::ConfirmationRequired(stale) = expiring
        .review(&firewall(), target("account-1"), &secret_prompt())
        .expect("expiring review")
    else {
        panic!("stale warning");
    };
    assert!(
        !expiring
            .cancel(&stale.review_id)
            .expect("stale is harmless")
    );
    assert_eq!(expiring.pending(), 0);
}

#[test]
fn concurrent_cancel_and_confirmation_have_exactly_one_winner() {
    let gate = Arc::new(PromptGate::default());
    let prompt_target = target("account-1");
    let prompt = secret_prompt();
    let PromptReview::ConfirmationRequired(warning) = gate
        .review(&firewall(), prompt_target.clone(), &prompt)
        .expect("review")
    else {
        panic!("warning");
    };
    let barrier = Arc::new(Barrier::new(3));

    let cancel = {
        let gate = gate.clone();
        let barrier = barrier.clone();
        let review_id = warning.review_id.clone();
        std::thread::spawn(move || {
            barrier.wait();
            gate.cancel(&review_id)
        })
    };
    let confirm = {
        let gate = gate.clone();
        let barrier = barrier.clone();
        let review_id = warning.review_id;
        let prompt_target = prompt_target.clone();
        let prompt = prompt.clone();
        std::thread::spawn(move || {
            barrier.wait();
            gate.admit(&firewall(), &prompt_target, &prompt, Some(&review_id))
        })
    };
    barrier.wait();

    let cancelled = cancel.join().expect("cancel thread").expect("cancel");
    let confirmation = confirm.join().expect("confirmation thread");
    assert_eq!(cancelled, confirmation.is_err());
    if let Ok(admission) = confirmation {
        gate.verify(admission, &prompt_target, &prompt)
            .expect("winning confirmation remains valid");
    }
    assert_eq!(gate.pending(), 0);
}

#[test]
fn concurrent_confirmation_has_one_winner() {
    let gate = Arc::new(PromptGate::default());
    let target = target("account-1");
    let prompt = secret_prompt();
    let PromptReview::ConfirmationRequired(warning) = gate
        .review(&firewall(), target.clone(), &prompt)
        .expect("review")
    else {
        panic!("warning");
    };
    let barrier = Arc::new(Barrier::new(3));
    let results = (0..2)
        .map(|_| {
            let gate = gate.clone();
            let target = target.clone();
            let prompt = prompt.clone();
            let review_id = warning.review_id.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                gate.admit(&firewall(), &target, &prompt, Some(&review_id))
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    let outcomes = results
        .into_iter()
        .map(|thread| thread.join().expect("thread"))
        .collect::<Vec<_>>();
    assert_eq!(outcomes.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(outcomes.iter().filter(|result| result.is_err()).count(), 1);
}
