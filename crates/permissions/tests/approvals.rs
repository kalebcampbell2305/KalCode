//! Approval lifecycle, standing grants, Bypass authority and the audit trail, against a real
//! database with migration 0005 applied.

// Helpers outside `#[test]` functions may panic on setup failures too.
#![allow(clippy::expect_used)]

mod common;

use std::sync::Arc;

use common::{Harness, command, open_core};
use kalcode_contracts::ids::new_id;
use kalcode_contracts::permissions::{
    ActionKind, ApprovalDecision as D, ApprovalStatus, GitOperation, PermissionGate,
    PermissionMode as M, PermissionProfile, PermissionRule, PermissionScope as S, PolicyEffect,
    RuleEffect,
};
use kalcode_core::db;
use kalcode_permissions::{Actor, PermissionService, profiles, store};

fn open(h: &Harness, kind: ActionKind) -> kalcode_permissions::ApprovalView {
    let action = h.action(kind);
    let decision = h.service.evaluate(&action, M::Approve);
    assert_eq!(decision.effect, PolicyEffect::Ask, "{}", decision.reason);
    h.service
        .open_request_view(action, M::Approve, &decision)
        .expect("open")
}

#[test]
fn open_request_persists_and_emits_approval_requested() {
    let h = Harness::new();
    let view = open(&h, command("npm test"));
    assert_eq!(view.status, ApprovalStatus::Pending);
    assert_eq!(view.permission_mode, M::Approve);
    assert!(view.allowed_decisions.contains(&D::ApproveForThread));
    let context = view.context.expect("context");
    assert_eq!(context.thread_name.as_deref(), Some("Fix the login bug"));
    assert_eq!(context.provider_name.as_deref(), Some("Claude Code"));
    assert!(h.event_types().contains(&"approval.requested".to_owned()));
    let pending = h
        .service
        .list_approvals(Some(ApprovalStatus::Pending))
        .expect("list");
    assert_eq!(pending.len(), 1);
    let audit = h.service.audit_log().expect("audit");
    assert_eq!(
        audit.last().map(|a| a.kind.as_str()),
        Some("approval.requested")
    );
}

#[test]
fn open_request_never_trusts_the_offered_decision() {
    let h = Harness::new();
    let gate: &dyn PermissionGate = h.service.as_ref();
    // A read the policy allows: asking for it is refused (no request to approve something the
    // engine would have allowed or denied anyway).
    let read = h.action(ActionKind::FileRead {
        path: "src/main.rs".into(),
    });
    let mut forged = gate.evaluate(&read, M::Approve);
    forged.effect = PolicyEffect::Ask;
    assert!(gate.open_request(read, M::Approve, forged).is_err());
    // A Plan-mode denial dressed up as "ask" is refused too.
    let plan = h.add_thread(M::Plan);
    let write = h.action_for(
        &plan,
        &h.workspace_id,
        ActionKind::FileWrite {
            path: "src/x".into(),
        },
    );
    let mut forged = gate.evaluate(&write, M::Plan);
    assert_eq!(forged.effect, PolicyEffect::Deny);
    forged.effect = PolicyEffect::Ask;
    forged.approvable = true;
    assert!(gate.open_request(write, M::Plan, forged).is_err());
    assert!(h.service.list_approvals(None).expect("list").is_empty());
}

#[test]
fn approve_once_and_deny_emit_events_and_audit() {
    let h = Harness::new();
    let a = open(&h, command("npm test"));
    let approved = h
        .service
        .decide(&a.id, D::ApproveOnce, Actor::User)
        .expect("approve");
    assert_eq!(approved.status, ApprovalStatus::Approved);
    assert_eq!(approved.resolved_decision, Some(D::ApproveOnce));
    let b = open(&h, command("npm run build"));
    let denied = h.service.decide(&b.id, D::Deny, Actor::User).expect("deny");
    assert_eq!(denied.status, ApprovalStatus::Denied);
    let types = h.event_types();
    assert!(types.contains(&"approval.approved".to_owned()));
    assert!(types.contains(&"approval.denied".to_owned()));
    let kinds: Vec<String> = h
        .service
        .audit_log()
        .expect("audit")
        .into_iter()
        .map(|a| a.kind)
        .collect();
    assert!(
        kinds.contains(&"approval.approved".to_owned())
            && kinds.contains(&"approval.denied".to_owned())
    );
    // Approve once creates no standing grant.
    let again = h
        .service
        .evaluate(&h.action(command("npm test")), M::Approve);
    assert_eq!(again.effect, PolicyEffect::Ask);
}

#[test]
fn double_decide_and_races_resolve_exactly_once() {
    let h = Harness::new();
    let a = open(&h, command("npm test"));
    h.service
        .decide(&a.id, D::ApproveOnce, Actor::User)
        .expect("first");
    let err = h
        .service
        .decide(&a.id, D::Deny, Actor::User)
        .expect_err("second");
    assert_eq!(err.code, "approval_already_decided");

    let b = open(&h, command("cargo build"));
    let service = h.service.clone();
    let handles: Vec<_> = (0..8)
        .map(|i| {
            let service = service.clone();
            let id = b.id.clone();
            std::thread::spawn(move || {
                service.decide(
                    &id,
                    if i % 2 == 0 { D::ApproveOnce } else { D::Deny },
                    Actor::User,
                )
            })
        })
        .collect();
    let results: Vec<_> = handles
        .into_iter()
        .map(|h| h.join().expect("join"))
        .collect();
    assert_eq!(
        results.iter().filter(|r| r.is_ok()).count(),
        1,
        "exactly one decision wins"
    );
    let decided: Vec<String> = h
        .service
        .audit_log()
        .expect("audit")
        .into_iter()
        .filter(|row| {
            row.request_id.as_deref() == Some(b.id.as_str()) && row.kind != "approval.requested"
        })
        .map(|row| row.kind)
        .collect();
    assert_eq!(decided.len(), 1, "{decided:?}");
}

#[test]
fn forged_and_malformed_request_ids_are_rejected() {
    let h = Harness::new();
    assert_eq!(
        h.service
            .decide(&new_id(), D::ApproveOnce, Actor::User)
            .expect_err("unknown")
            .code,
        "approval_not_found"
    );
    for bad in [
        "",
        "../../etc/passwd",
        "1 OR 1=1",
        "0192f3c4000070008000000000000000",
    ] {
        assert_eq!(
            h.service
                .decide(bad, D::ApproveOnce, Actor::User)
                .expect_err(bad)
                .code,
            "invalid_id"
        );
    }
}

#[test]
fn only_the_user_can_answer_requests() {
    let h = Harness::new();
    let a = open(&h, command("npm test"));
    for actor in [
        Actor::Agent,
        Actor::KalVoice,
        Actor::Automation,
        Actor::System,
    ] {
        let err = h
            .service
            .decide(&a.id, D::ApproveOnce, actor)
            .expect_err("forbidden");
        assert_eq!(err.code, "forbidden");
    }
    let pending = h
        .service
        .list_approvals(Some(ApprovalStatus::Pending))
        .expect("list");
    assert_eq!(pending.len(), 1);
}

#[test]
fn decisions_outside_the_allowed_set_are_refused() {
    let h = Harness::new();
    let push = open(
        &h,
        ActionKind::Git {
            operation: GitOperation::Push,
            remote: Some("origin".into()),
        },
    );
    assert_eq!(push.allowed_decisions, vec![D::Deny, D::ApproveOnce]);
    for decision in [D::ApproveForThread, D::ApproveForWorkspace, D::AllowViaRule] {
        assert_eq!(
            h.service
                .decide(&push.id, decision, Actor::User)
                .expect_err("refused")
                .code,
            "decision_not_allowed"
        );
    }
    let opaque = open(&h, command("echo $(whoami)"));
    assert_eq!(opaque.allowed_decisions, vec![D::Deny, D::ApproveOnce]);
}

#[test]
fn never_rules_produce_unapprovable_denials() {
    let h = Harness::new();
    let t = h.add_thread(M::Custom);
    h.threads
        .profiles
        .lock()
        .expect("lock")
        .insert(t.clone(), profiles::CODE_REVIEWER.into());
    let push = h.action_for(&t, &h.workspace_id, command("git push origin main"));
    let d = h.service.evaluate(&push, M::Custom);
    assert_eq!(d.effect, PolicyEffect::Deny);
    assert!(!d.approvable);
    assert!(
        d.reason.contains("Code Reviewer") && d.reason.contains("Never"),
        "{}",
        d.reason
    );
    // Even an opaque push is caught by the Never rule (unknown subject counts as a match).
    let hidden = h.action_for(&t, &h.workspace_id, command("sh -c \"$(echo git) push\""));
    assert_eq!(
        h.service.evaluate(&hidden, M::Custom).effect,
        PolicyEffect::Deny
    );
    // A request can't be opened for it.
    assert!(h.service.open_request_view(push, M::Custom, &d).is_err());
    // The Code Reviewer profile still asks before running tests and allows reads.
    let test = h.action_for(&t, &h.workspace_id, command("npm test"));
    assert_eq!(
        h.service.evaluate(&test, M::Custom).effect,
        PolicyEffect::Ask
    );
    let read = h.action_for(
        &t,
        &h.workspace_id,
        ActionKind::FileRead {
            path: "src/main.rs".into(),
        },
    );
    assert_eq!(
        h.service.evaluate(&read, M::Custom).effect,
        PolicyEffect::Allow
    );
}

#[test]
fn custom_rules_with_matchers() {
    let h = Harness::new();
    let profile = PermissionProfile {
        id: new_id(),
        name: "Docs only".into(),
        mode: M::Custom,
        rules: vec![
            PermissionRule {
                scope: S::TerminalExecute,
                effect: RuleEffect::Allow,
                matcher: Some("npm test".into()),
            },
            PermissionRule {
                scope: S::GitPush,
                effect: RuleEffect::Allow,
                matcher: None,
            },
            PermissionRule {
                scope: S::FilesystemWrite,
                effect: RuleEffect::Allow,
                matcher: Some("docs/**".into()),
            },
            PermissionRule {
                scope: S::NetworkOther,
                effect: RuleEffect::Never,
                matcher: Some("evil.example".into()),
            },
        ],
        builtin: false,
    };
    h.core
        .transact(|tx| Ok((store::save_profile(tx, &profile)?, Vec::new())))
        .expect("save");
    let t = h.add_thread(M::Custom);
    h.threads
        .profiles
        .lock()
        .expect("lock")
        .insert(t.clone(), profile.id.clone());
    let eval = |kind| {
        h.service
            .evaluate(&h.action_for(&t, &h.workspace_id, kind), M::Custom)
            .effect
    };
    assert_eq!(eval(command("npm test")), PolicyEffect::Allow);
    assert_eq!(
        eval(command("npm test -- --watch=false")),
        PolicyEffect::Allow
    );
    assert_eq!(eval(command("npm testx")), PolicyEffect::Ask);
    assert_eq!(
        eval(command("npm test && rm -rf src")),
        PolicyEffect::Ask,
        "compound commands never match a prefix"
    );
    assert_eq!(
        eval(command("npm test; curl https://evil.example")),
        PolicyEffect::Deny
    );
    assert_eq!(
        eval(ActionKind::FileWrite {
            path: "docs/guide.md".into()
        }),
        PolicyEffect::Allow
    );
    assert_eq!(
        eval(ActionKind::FileWrite {
            path: "src/main.rs".into()
        }),
        PolicyEffect::Ask
    );
    // A blanket allow for a remote-consequential scope is not honoured (it needs a matcher).
    assert_eq!(eval(command("git push")), PolicyEffect::Ask);
    // A Custom thread whose profile is missing fails closed.
    let orphan = h.add_thread(M::Custom);
    h.threads
        .profiles
        .lock()
        .expect("lock")
        .insert(orphan.clone(), new_id());
    let d = h.service.evaluate(
        &h.action_for(&orphan, &h.workspace_id, command("ls")),
        M::Custom,
    );
    assert_eq!(d.effect, PolicyEffect::Deny);
}

#[test]
fn thread_grants_are_scoped_and_expire_with_the_thread() {
    let h = Harness::new();
    let write = || ActionKind::FileWrite {
        path: "src/lib.rs".into(),
    };
    let a = open(&h, write());
    assert!(
        a.grant_coverage.contains("any file in this workspace"),
        "{}",
        a.grant_coverage
    );
    h.service
        .decide(&a.id, D::ApproveForThread, Actor::User)
        .expect("thread");
    // Same thread, another file in the workspace: covered.
    let other_file = h.action(ActionKind::FileWrite {
        path: "src/other.rs".into(),
    });
    assert_eq!(
        h.service.evaluate(&other_file, M::Approve).effect,
        PolicyEffect::Allow
    );
    // Not covered: another thread, outside the workspace, secrets, .git internals, deletes.
    let other_thread = h.add_thread(M::Approve);
    assert_eq!(
        h.service
            .evaluate(
                &h.action_for(&other_thread, &h.workspace_id, write()),
                M::Approve
            )
            .effect,
        PolicyEffect::Ask
    );
    for kind in [
        ActionKind::FileWrite {
            path: "../outside/x".into(),
        },
        ActionKind::FileWrite {
            path: ".env".into(),
        },
        ActionKind::FileWrite {
            path: ".git/hooks/pre-commit".into(),
        },
        ActionKind::FileDelete {
            path: "src/lib.rs".into(),
        },
        command("npm test"),
    ] {
        assert_eq!(
            h.service
                .evaluate(&h.action(kind.clone()), M::Approve)
                .effect,
            PolicyEffect::Ask,
            "{kind:?}"
        );
    }
    // Plan mode still wins over a grant.
    assert_eq!(
        h.service.evaluate(&h.action(write()), M::Plan).effect,
        PolicyEffect::Deny
    );
    // The thread stops: its grants are revoked.
    h.service.expire_for_thread(&h.thread_id);
    assert_eq!(
        h.service.evaluate(&h.action(write()), M::Approve).effect,
        PolicyEffect::Ask
    );
    let kinds: Vec<String> = h
        .service
        .audit_log()
        .expect("audit")
        .into_iter()
        .map(|a| a.kind)
        .collect();
    assert!(
        kinds.contains(&"grant.created".to_owned()) && kinds.contains(&"grant.revoked".to_owned())
    );
}

#[test]
fn thread_grants_time_out() {
    let h = Harness::new();
    let a = open(&h, command("npm test"));
    h.service
        .decide(&a.id, D::ApproveForThread, Actor::User)
        .expect("thread");
    assert_eq!(
        h.service
            .evaluate(&h.action(command("npm test")), M::Approve)
            .effect,
        PolicyEffect::Allow
    );
    // Only the exact command is covered.
    assert_eq!(
        h.service
            .evaluate(&h.action(command("npm test -- -u")), M::Approve)
            .effect,
        PolicyEffect::Ask
    );
    h.advance(kalcode_permissions::grants::THREAD_GRANT_TTL_MS);
    assert_eq!(
        h.service
            .evaluate(&h.action(command("npm test")), M::Approve)
            .effect,
        PolicyEffect::Ask
    );
}

#[test]
fn workspace_grants_cover_other_threads_but_not_other_workspaces() {
    let h = Harness::new();
    let a = open(&h, command("npm test"));
    h.service
        .decide(&a.id, D::ApproveForWorkspace, Actor::User)
        .expect("workspace");
    let sibling = h.add_thread(M::Approve);
    assert_eq!(
        h.service
            .evaluate(
                &h.action_for(&sibling, &h.workspace_id, command("npm test")),
                M::Approve
            )
            .effect,
        PolicyEffect::Allow
    );
    let other_ws = h.add_workspace();
    let elsewhere = h.add_thread_in(&other_ws, M::Approve);
    assert_eq!(
        h.service
            .evaluate(
                &h.action_for(&elsewhere, &other_ws, command("npm test")),
                M::Approve
            )
            .effect,
        PolicyEffect::Ask
    );
    // Thread stop does not revoke workspace grants; time does.
    h.service.expire_for_thread(&h.thread_id);
    assert_eq!(
        h.service
            .evaluate(&h.action(command("npm test")), M::Approve)
            .effect,
        PolicyEffect::Allow
    );
    h.advance(kalcode_permissions::grants::WORKSPACE_GRANT_TTL_MS);
    assert_eq!(
        h.service
            .evaluate(&h.action(command("npm test")), M::Approve)
            .effect,
        PolicyEffect::Ask
    );
}

#[test]
fn allow_via_rule_creates_a_standing_rule() {
    let h = Harness::new();
    let a = open(&h, command("npm test"));
    assert!(a.allowed_decisions.contains(&D::AllowViaRule));
    h.service
        .decide(&a.id, D::AllowViaRule, Actor::User)
        .expect("rule");
    let other_ws = h.add_workspace();
    let t = h.add_thread_in(&other_ws, M::Approve);
    let eval = |kind| {
        h.service
            .evaluate(&h.action_for(&t, &other_ws, kind), M::Approve)
            .effect
    };
    assert_eq!(eval(command("npm test")), PolicyEffect::Allow);
    assert_eq!(eval(command("npm test -- --coverage")), PolicyEffect::Allow);
    assert_eq!(eval(command("npm run deploy")), PolicyEffect::Ask);
    assert_eq!(eval(command("npm test && git push")), PolicyEffect::Ask);
    assert_eq!(eval(command("npm test $(rm -rf /)")), PolicyEffect::Ask);
    // Rules never apply in Plan mode.
    let plan = h.add_thread_in(&other_ws, M::Plan);
    assert_eq!(
        h.service
            .evaluate(
                &h.action_for(&plan, &other_ws, command("npm test")),
                M::Plan
            )
            .effect,
        PolicyEffect::Deny
    );
}

#[test]
fn stale_requests_expire_and_cannot_be_approved() {
    let h = Harness::new();
    let a = open(&h, command("npm test"));
    h.service.expire_for_thread(&h.thread_id);
    let err = h
        .service
        .decide(&a.id, D::ApproveOnce, Actor::User)
        .expect_err("expired");
    assert_eq!(err.code, "approval_expired");
    let all = h.service.list_approvals(None).expect("list");
    assert_eq!(all[0].status, ApprovalStatus::Expired);
    assert_eq!(all[0].expire_reason.as_deref(), Some("thread_stopped"));
    assert!(h.event_types().contains(&"approval.expired".to_owned()));
}

#[test]
fn requests_answered_in_the_provider_expire_without_revoking_grants() {
    let h = Harness::new();
    let first = open(&h, command("npm test"));
    let other = open(&h, command("cargo build"));
    let expired = h
        .service
        .expire_answered_in_provider(&h.thread_id, &first.action.id)
        .expect("expire");
    assert_eq!(expired, 1);
    let all = h.service.list_approvals(None).expect("list");
    let find = |id: &str| all.iter().find(|v| v.id == id).expect("request");
    assert_eq!(find(&first.id).status, ApprovalStatus::Expired);
    assert_eq!(
        find(&first.id).expire_reason.as_deref(),
        Some("answered_in_provider")
    );
    // Only that action's request expires.
    assert_eq!(find(&other.id).status, ApprovalStatus::Pending);
    assert!(h.event_types().contains(&"approval.expired".to_owned()));
    let err = h
        .service
        .decide(&first.id, D::ApproveOnce, Actor::User)
        .expect_err("expired");
    assert_eq!(err.code, "approval_expired");
    // Idempotent, and ids are validated.
    assert_eq!(
        h.service
            .expire_answered_in_provider(&h.thread_id, &first.action.id)
            .expect("again"),
        0
    );
    assert!(
        h.service
            .expire_answered_in_provider("nope", &first.action.id)
            .is_err()
    );
    assert!(
        h.service
            .expire_answered_in_provider(&h.thread_id, "")
            .is_err()
    );
}

#[test]
fn superseded_requests_expire() {
    let h = Harness::new();
    let mut action = h.action(command("npm test"));
    let decision = h.service.evaluate(&action, M::Approve);
    let first = h
        .service
        .open_request_view(action.clone(), M::Approve, &decision)
        .expect("first");
    action.summary = "retry".into();
    let second = h
        .service
        .open_request_view(action, M::Approve, &decision)
        .expect("second");
    let all = h.service.list_approvals(None).expect("list");
    let status = |id: &str| all.iter().find(|v| v.id == id).map(|v| v.status);
    assert_eq!(status(&first.id), Some(ApprovalStatus::Expired));
    assert_eq!(status(&second.id), Some(ApprovalStatus::Pending));
}

#[test]
fn pending_requests_expire_when_the_process_restarts() {
    let dir = tempfile::tempdir().expect("tempdir");
    let data = dir.path().join("data");
    let thread_id = new_id();
    let request_id = {
        let h = Harness::new();
        drop(h);
        // Use a fresh core in `data` so we can reopen it.
        let core = Arc::new(open_core(&data));
        let threads = Arc::new(common::FakeThreads::default());
        let workspace_id = new_id();
        threads.threads.lock().expect("lock").insert(
            thread_id.clone(),
            common::thread_summary(&thread_id, &workspace_id, M::Approve),
        );
        let service = PermissionService::new(
            core.clone(),
            Arc::new(kalcode_permissions::NoWorkspaces),
            threads,
        )
        .expect("service");
        let action = kalcode_contracts::permissions::NormalizedAction {
            id: "toolu_1".into(),
            thread_id: thread_id.clone(),
            workspace_id,
            provider_id: kalcode_contracts::agent::ProviderId::new("codex"),
            action: command("npm test"),
            summary: "Run tests".into(),
            requested_at: String::new(),
            origin: None,
        };
        let decision = service.evaluate(&action, M::Approve);
        let view = service
            .open_request_view(action, M::Approve, &decision)
            .expect("open");
        core.shutdown();
        view.id
    };
    let core = Arc::new(open_core(&data));
    let service = PermissionService::new(
        core,
        Arc::new(kalcode_permissions::NoWorkspaces),
        Arc::new(kalcode_permissions::NoThreads),
    )
    .expect("service");
    let all = service.list_approvals(None).expect("list");
    let view = all.iter().find(|v| v.id == request_id).expect("request");
    assert_eq!(view.status, ApprovalStatus::Expired);
    assert_eq!(view.expire_reason.as_deref(), Some("process_restarted"));
    assert_eq!(
        service
            .decide(&request_id, D::ApproveOnce, Actor::User)
            .expect_err("expired")
            .code,
        "approval_expired"
    );
}

#[test]
fn bypass_requires_the_user_and_explicit_confirmation() {
    let h = Harness::new();
    for actor in [
        Actor::Agent,
        Actor::KalVoice,
        Actor::Automation,
        Actor::System,
    ] {
        let err = h
            .service
            .set_thread_mode(&h.thread_id, M::Bypass, true, None, actor)
            .expect_err("agent");
        assert_eq!(err.code, "forbidden");
    }
    let err = h
        .service
        .set_thread_mode(&h.thread_id, M::Bypass, false, None, Actor::User)
        .expect_err("unconfirmed");
    assert_eq!(err.code, "bypass_confirmation_required");
    let audit = h.service.audit_log().expect("audit");
    let refusals: Vec<_> = audit
        .iter()
        .filter(|a| a.kind == "permission.bypass_refused")
        .collect();
    assert_eq!(refusals.len(), 5);
    assert!(refusals.iter().any(|r| r.actor == "kalvoice"));
    assert_eq!(
        h.threads.threads.lock().expect("lock")[&h.thread_id].permission_mode,
        M::Approve
    );

    let pending = open(&h, command("npm test"));
    let updated = h
        .service
        .set_thread_mode(&h.thread_id, M::Bypass, true, None, Actor::User)
        .expect("bypass");
    assert_eq!(updated.permission_mode, M::Bypass);
    let audit = h.service.audit_log().expect("audit");
    assert!(
        audit
            .iter()
            .any(|a| a.kind == "permission.bypass_enabled" && a.actor == "user")
    );
    assert!(
        h.event_types()
            .contains(&"permission.mode_changed".to_owned())
    );
    // Requests asked under the old mode expire.
    let all = h.service.list_approvals(None).expect("list");
    let old = all.iter().find(|v| v.id == pending.id).expect("old");
    assert_eq!(old.status, ApprovalStatus::Expired);
    assert_eq!(old.expire_reason.as_deref(), Some("mode_changed"));
}

#[test]
fn agents_cannot_change_modes_at_all() {
    let h = Harness::new();
    for mode in [M::Plan, M::Auto, M::Approve] {
        assert_eq!(
            h.service
                .set_thread_mode(&h.thread_id, mode, false, None, Actor::KalVoice)
                .expect_err("kalvoice")
                .code,
            "forbidden"
        );
    }
    assert_eq!(
        h.service
            .set_thread_mode("not-an-id", M::Plan, false, None, Actor::User)
            .expect_err("bad")
            .code,
        "invalid_id"
    );
    assert_eq!(
        h.service
            .set_thread_mode(&new_id(), M::Plan, false, None, Actor::User)
            .expect_err("missing")
            .code,
        "thread_not_found"
    );
    assert_eq!(
        h.service
            .set_thread_mode(&h.thread_id, M::Custom, false, None, Actor::User)
            .expect_err("profile")
            .code,
        "profile_required"
    );
    assert_eq!(
        h.service
            .set_thread_mode(
                &h.thread_id,
                M::Custom,
                false,
                Some("builtin.root"),
                Actor::User
            )
            .expect_err("profile")
            .code,
        "invalid_id"
    );
    let custom = h
        .service
        .set_thread_mode(
            &h.thread_id,
            M::Custom,
            false,
            Some(profiles::LOCAL_BUILDER),
            Actor::User,
        )
        .expect("custom");
    assert_eq!(custom.permission_mode, M::Custom);
    assert_eq!(
        h.threads.profiles.lock().expect("lock")[&h.thread_id],
        profiles::LOCAL_BUILDER
    );
}

#[test]
fn default_mode_settings() {
    let h = Harness::new();
    assert_eq!(
        h.service.settings().expect("settings").default_mode,
        M::Approve
    );
    assert_eq!(
        h.service
            .update_settings(M::Bypass, None, false, Actor::User)
            .expect_err("confirm")
            .code,
        "bypass_confirmation_required"
    );
    assert_eq!(
        h.service
            .update_settings(M::Bypass, None, true, Actor::KalVoice)
            .expect_err("kalvoice")
            .code,
        "forbidden"
    );
    let s = h
        .service
        .update_settings(M::Bypass, None, true, Actor::User)
        .expect("bypass");
    assert_eq!(s.default_mode, M::Bypass);
    let s = h
        .service
        .update_settings(M::Custom, Some(profiles::CODE_REVIEWER), false, Actor::User)
        .expect("custom");
    assert_eq!(
        s.default_profile_id.as_deref(),
        Some(profiles::CODE_REVIEWER)
    );
    assert_eq!(h.service.settings().expect("reload"), s);
    let kinds: Vec<String> = h
        .service
        .audit_log()
        .expect("audit")
        .into_iter()
        .map(|a| a.kind)
        .collect();
    assert!(kinds.contains(&"permission.default_mode_changed".to_owned()));
    assert!(kinds.contains(&"permission.bypass_enabled".to_owned()));
}

#[test]
fn audit_and_resolved_approvals_are_immutable() {
    let h = Harness::new();
    let a = open(&h, command("npm test"));
    h.service.decide(&a.id, D::Deny, Actor::User).expect("deny");
    for sql in [
        "UPDATE permission_audit SET actor = 'user'",
        "DELETE FROM permission_audit",
        "DELETE FROM approvals",
        "UPDATE approvals SET status = 'approved', resolved_decision = 'approve_once'",
        "UPDATE approvals SET request = '{}'",
    ] {
        let result = h.core.transact(|tx| {
            tx.execute_batch(sql)?;
            Ok(((), Vec::new()))
        });
        assert!(result.is_err(), "{sql} should be refused");
    }
}

#[test]
fn schema_refuses_approving_unapprovable_requests() {
    let h = Harness::new();
    // Write a pending request straight into the table with a non-approvable decision, then try
    // to approve it with SQL: the CHECK constraint refuses even if application code were wrong.
    let id = new_id();
    let result = h.core.transact(|tx| {
        tx.execute(
            "INSERT INTO approvals (id, origin_kind, thread_id, workspace_id, provider_id, action_id, request,
               decision, allowed_decisions, fingerprint, grant_coverage, permission_mode, status, created_at)
             VALUES (?1, 'thread', 't', 'w', 'p', 'a', '{}', '{\"effect\":\"ask\",\"approvable\":false,\"scopes\":[],\"reason\":\"\"}',
               '[\"deny\",\"approve_once\"]', 'f', 'c', 'approve', 'pending', 'now')",
            [&id],
        )?;
        tx.execute(
            "UPDATE approvals SET status = 'approved', resolved_decision = 'approve_once', resolved_at = 'now', resolved_by = 'user' WHERE id = ?1",
            [&id],
        )?;
        Ok(((), Vec::new()))
    });
    assert!(result.is_err());
    // A decision outside the stored allowed set is refused by the schema as well.
    let id2 = new_id();
    let result = h.core.transact(|tx| {
        tx.execute(
            "INSERT INTO approvals (id, origin_kind, thread_id, workspace_id, provider_id, action_id, request,
               decision, allowed_decisions, fingerprint, grant_coverage, permission_mode, status, created_at)
             VALUES (?1, 'thread', 't', 'w', 'p', 'b', '{}', '{\"effect\":\"ask\",\"approvable\":true,\"scopes\":[],\"reason\":\"\"}',
               '[\"deny\",\"approve_once\"]', 'f', 'c', 'approve', 'pending', 'now')",
            [&id2],
        )?;
        tx.execute(
            "UPDATE approvals SET status = 'approved', resolved_decision = 'approve_for_workspace', resolved_at = 'now', resolved_by = 'user' WHERE id = ?1",
            [&id2],
        )?;
        Ok(((), Vec::new()))
    });
    assert!(result.is_err());
}

/// Inserts a pending request row directly (schema tests only), with workspace `w` and provider `p`.
fn insert_raw(
    h: &Harness,
    origin_kind: &str,
    thread_id: Option<&str>,
) -> kalcode_core::Result<String> {
    insert_row(h, origin_kind, thread_id, Some("w"), Some("p"))
}

fn insert_row(
    h: &Harness,
    origin_kind: &str,
    thread_id: Option<&str>,
    workspace_id: Option<&str>,
    provider_id: Option<&str>,
) -> kalcode_core::Result<String> {
    let id = new_id();
    h.core
        .transact(|tx| {
            tx.execute(
                "INSERT INTO approvals (id, origin_kind, origin_id, thread_id, workspace_id, provider_id,
                   action_id, request, decision, allowed_decisions, fingerprint, grant_coverage,
                   permission_mode, status, created_at)
                 VALUES (?1, ?2, 'origin-1', ?3, ?4, ?5, ?1, '{}',
                   '{\"effect\":\"ask\",\"approvable\":true,\"scopes\":[],\"reason\":\"\"}',
                   '[\"deny\",\"approve_once\"]', 'f', 'c', 'approve', 'pending', 'now')",
                rusqlite::params![id, origin_kind, thread_id, workspace_id, provider_id],
            )?;
            Ok(((), Vec::new()))
        })
        .map(|_| id)
}

fn sql(h: &Harness, statement: &str) -> bool {
    h.core
        .transact(|tx| {
            tx.execute_batch(statement)?;
            Ok(((), Vec::new()))
        })
        .is_ok()
}

#[test]
fn approvals_record_their_origin_and_only_thread_origins_need_a_thread() {
    let h = Harness::new();
    // Requests the gate opens today come from threads.
    let a = open(&h, command("npm test"));
    let (kind, origin): (String, Option<String>) = h
        .core
        .read(|conn| {
            Ok(conn.query_row(
                "SELECT origin_kind, origin_id FROM approvals WHERE id = ?1",
                [&a.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .expect("row");
    assert_eq!(kind, "thread");
    assert_eq!(origin.as_deref(), Some(a.action.thread_id.as_str()));

    // Non-thread origins (KalVoice, automations, Environment Doctor, …) may have no thread.
    for kind in ["kalvoice", "automation", "system", "doctor"] {
        insert_raw(&h, kind, None).unwrap_or_else(|e| panic!("{kind}: {}", e.diagnostic()));
    }
    assert!(
        insert_raw(&h, "thread", None).is_err(),
        "a thread origin needs its thread"
    );
    assert!(
        insert_row(&h, "thread", Some("t"), None, Some("p")).is_err(),
        "a thread origin needs its workspace"
    );
    assert!(
        insert_row(&h, "thread", Some("t"), Some("w"), None).is_err(),
        "a thread origin needs its provider"
    );
    // KalVoice (and other non-thread origins) may have no thread, workspace or provider.
    let voice = insert_row(&h, "kalvoice", None, None, None)
        .unwrap_or_else(|e| panic!("kalvoice without workspace/provider: {}", e.diagnostic()));
    // Such a request expires like any other (expiry reads no workspace or provider).
    h.core
        .transact(|tx| {
            store::expire_pending(tx, None, Some(&voice), "superseded")?;
            Ok(((), Vec::new()))
        })
        .expect("expire a non-thread request");
    assert!(
        insert_raw(&h, "someone", Some("t")).is_err(),
        "unknown origins are refused"
    );

    // Origin is part of the immutable request.
    assert!(!sql(&h, "UPDATE approvals SET origin_kind = 'system'"));
    assert!(!sql(&h, "UPDATE approvals SET origin_id = 'x'"));
}

#[test]
fn expire_reasons_and_audit_kinds_are_checked_by_the_schema() {
    let h = Harness::new();
    let answered = insert_raw(&h, "thread", Some("t1")).expect("row");
    assert!(sql(
        &h,
        &format!(
            "UPDATE approvals SET status = 'expired', resolved_at = 'now', resolved_by = 'system',
               expire_reason = 'answered_in_provider' WHERE id = '{answered}'"
        )
    ));
    let other = insert_raw(&h, "thread", Some("t2")).expect("row");
    assert!(!sql(
        &h,
        &format!(
            "UPDATE approvals SET status = 'expired', resolved_at = 'now', resolved_by = 'system',
               expire_reason = 'because' WHERE id = '{other}'"
        )
    ));

    let audit = |kind: &str| {
        sql(
            &h,
            &format!(
                "INSERT INTO permission_audit (id, occurred_at, kind, actor, detail)
                 VALUES ('{}', 'now', '{kind}', 'system', '{{}}')",
                new_id()
            ),
        )
    };
    for kind in [
        "approval.requested",
        "permission.bypass_refused",
        "trust.action_blocked",
        "trust.ceiling_applied",
        "trust.invariant_enforced",
        "grant.ceiling_clamped",
    ] {
        assert!(audit(kind), "{kind} is a known audit kind");
    }
    assert!(!audit("trust.something_else"), "unknown kinds are refused");
}

#[test]
fn migrations_keep_permissions_at_v4() {
    let numbering: Vec<(i64, &str)> = db::MIGRATIONS.iter().map(|m| (m.version, m.name)).collect();
    assert_eq!(
        numbering,
        vec![
            (1, "foundation"),
            (2, "workspaces"),
            (3, "threads"),
            (4, "permissions"),
            (5, "event_correlation"),
            (6, "kalvoice"),
            (7, "git"),
            (8, "context")
        ]
    );
}

#[test]
fn permissions_migration_upgrades_a_v1_database_and_preserves_data() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("kalcode.db");
    // A v1 database with representative data.
    {
        let mut conn = db::open(&path).expect("open");
        db::migrate(&mut conn, &db::MIGRATIONS[..1], None).expect("v1");
        conn.execute_batch(
            "INSERT INTO settings (key, value, updated_at) VALUES ('appearance.theme', '\"dark\"', 'now');
             INSERT INTO events (id, type, version, occurred_at, source, payload)
               VALUES ('e1', 'app.started', 1, 'now', 'core', '{}');",
        )
        .expect("seed");
    }
    let mut conn = db::open(&path).expect("reopen");
    let outcome =
        db::migrate(&mut conn, db::MIGRATIONS, Some(&dir.path().join("backups"))).expect("upgrade");
    assert_eq!(
        (outcome.from_version, outcome.to_version),
        (1, db::MIGRATIONS.len() as i64)
    );
    assert!(outcome.backup.is_some());
    let theme: String = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'appearance.theme'",
            [],
            |r| r.get(0),
        )
        .expect("theme");
    assert_eq!(theme, "\"dark\"");
    let events: i64 = conn
        .query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))
        .expect("events");
    assert_eq!(events, 1);
    for table in [
        "permission_profiles",
        "permission_settings",
        "approvals",
        "permission_grants",
        "permission_audit",
    ] {
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |r| r.get(0),
            )
            .expect("query");
        assert_eq!(exists, 1, "{table}");
    }
    // Re-running is a no-op.
    assert!(
        !db::migrate(&mut conn, db::MIGRATIONS, None)
            .expect("again")
            .applied_any()
    );
}

// ---- Non-thread origins (CA-1, KalVoice) ----

fn kalvoice_action(
    h: &Harness,
    kind: ActionKind,
) -> kalcode_contracts::permissions::NormalizedAction {
    kalcode_contracts::permissions::NormalizedAction {
        id: new_id(),
        thread_id: String::new(),
        workspace_id: h.workspace_id.clone(),
        provider_id: kalcode_contracts::agent::ProviderId::new("kalvoice"),
        action: kind,
        summary: "Open 3 Codex threads".into(),
        requested_at: "2026-09-24T00:00:00.000Z".into(),
        origin: Some(kalcode_contracts::permissions::ActionOrigin::KalVoice {
            request_id: new_id(),
        }),
    }
}

fn create_threads() -> ActionKind {
    ActionKind::CreateThreads {
        provider_id: kalcode_contracts::agent::ProviderId::new("codex"),
        count: 3,
        workspace_id: None,
    }
}

#[test]
fn kalvoice_actions_file_approvals_with_their_origin_and_no_thread() {
    let h = Harness::new();
    let action = kalvoice_action(&h, create_threads());
    let request_id = match &action.origin {
        Some(kalcode_contracts::permissions::ActionOrigin::KalVoice { request_id }) => {
            request_id.clone()
        }
        _ => unreachable!(),
    };
    let outcome = h.service.request_for_origin(action).expect("evaluate");
    assert_eq!(outcome.decision.effect, PolicyEffect::Ask);
    assert_eq!(outcome.decision.scopes, vec![S::ThreadStart]);
    let view = outcome.approval.expect("approval filed");
    // Only a one-time approval: no standing grant can cover a KalVoice request.
    assert_eq!(view.allowed_decisions, vec![D::Deny, D::ApproveOnce]);
    assert_eq!(view.permission_mode, M::Approve);
    assert_eq!(view.grant_coverage, "only this request");
    let row: (String, Option<String>, Option<String>, Option<String>) = h
        .core
        .read(|conn| {
            Ok(conn.query_row(
                "SELECT origin_kind, origin_id, thread_id, workspace_id FROM approvals WHERE id = ?1",
                [&view.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )?)
        })
        .expect("row");
    assert_eq!(row.0, "kalvoice");
    assert_eq!(row.1.as_deref(), Some(request_id.as_str()));
    assert_eq!(row.2, None, "no thread");
    assert_eq!(row.3.as_deref(), Some(h.workspace_id.as_str()));
    let requested = h
        .events
        .lock()
        .expect("lock")
        .iter()
        .find(|e| e.event.type_name() == "approval.requested")
        .cloned()
        .expect("approval.requested");
    assert_eq!(requested.correlation.thread_id, None);
    assert_eq!(
        requested.correlation.request_id.as_deref(),
        Some(view.id.as_str())
    );
    // The request is listed with the others and keeps its origin.
    let listed = h
        .service
        .list_approvals(Some(ApprovalStatus::Pending))
        .expect("list");
    let same = listed.iter().find(|v| v.id == view.id).expect("listed");
    assert_eq!(
        same.action.origin.as_ref().map(|o| o.kind()),
        Some("kalvoice")
    );
}

#[test]
fn only_the_user_answers_a_kalvoice_request() {
    let h = Harness::new();
    let view = h
        .service
        .request_for_origin(kalvoice_action(&h, create_threads()))
        .expect("evaluate")
        .approval
        .expect("approval");
    // KalVoice (and every other non-user actor) can never answer.
    for actor in [
        Actor::KalVoice,
        Actor::Agent,
        Actor::Automation,
        Actor::System,
    ] {
        let err = h
            .service
            .decide(&view.id, D::ApproveOnce, actor)
            .expect_err("only the user answers");
        assert_eq!(err.code, "forbidden", "{actor:?}");
    }
    // Standing approvals are refused even for the user.
    assert_eq!(
        h.service
            .decide(&view.id, D::ApproveForWorkspace, Actor::User)
            .expect_err("not offered")
            .code,
        "decision_not_allowed"
    );
    let approved = h
        .service
        .decide(&view.id, D::ApproveOnce, Actor::User)
        .expect("user approves");
    assert_eq!(approved.status, ApprovalStatus::Approved);
    // No grant was created, so the next identical request asks again.
    let again = h
        .service
        .request_for_origin(kalvoice_action(&h, create_threads()))
        .expect("evaluate");
    assert_eq!(again.decision.effect, PolicyEffect::Ask);
}

#[test]
fn request_for_origin_refuses_thread_and_unsupported_origins() {
    let h = Harness::new();
    let thread_action = h.action(create_threads());
    assert_eq!(
        h.service
            .request_for_origin(thread_action)
            .expect_err("thread")
            .code,
        "origin_is_a_thread"
    );
    let mut automation = kalvoice_action(&h, create_threads());
    automation.origin = Some(kalcode_contracts::permissions::ActionOrigin::Automation {
        automation_id: new_id(),
        run_id: new_id(),
    });
    assert_eq!(
        h.service
            .request_for_origin(automation)
            .expect_err("not yet")
            .code,
        "origin_not_supported"
    );
    let mut bad_request = kalvoice_action(&h, create_threads());
    bad_request.origin = Some(kalcode_contracts::permissions::ActionOrigin::KalVoice {
        request_id: "nope".into(),
    });
    assert_eq!(
        h.service
            .request_for_origin(bad_request)
            .expect_err("invalid id")
            .code,
        "invalid_id"
    );
    // A resume request is the same kind of approval.
    let resume = h
        .service
        .request_for_origin(kalvoice_action(
            &h,
            ActionKind::ResumeThreads {
                scope: kalcode_contracts::kalvoice::ThreadScope::All,
            },
        ))
        .expect("resume");
    assert_eq!(resume.decision.scopes, vec![S::ThreadStart]);
    assert!(resume.approval.is_some());
}
