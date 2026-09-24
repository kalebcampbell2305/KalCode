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
use kalcode_permissions::branch::migrations_with_placeholders;
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
    assert_eq!(view.request.status, ApprovalStatus::Pending);
    assert_eq!(view.request.permission_mode, M::Approve);
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
        .decide(&a.request.id, D::ApproveOnce, Actor::User)
        .expect("approve");
    assert_eq!(approved.request.status, ApprovalStatus::Approved);
    assert_eq!(approved.request.resolved_decision, Some(D::ApproveOnce));
    let b = open(&h, command("npm run build"));
    let denied = h
        .service
        .decide(&b.request.id, D::Deny, Actor::User)
        .expect("deny");
    assert_eq!(denied.request.status, ApprovalStatus::Denied);
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
        .decide(&a.request.id, D::ApproveOnce, Actor::User)
        .expect("first");
    let err = h
        .service
        .decide(&a.request.id, D::Deny, Actor::User)
        .expect_err("second");
    assert_eq!(err.code, "approval_already_decided");

    let b = open(&h, command("cargo build"));
    let service = h.service.clone();
    let handles: Vec<_> = (0..8)
        .map(|i| {
            let service = service.clone();
            let id = b.request.id.clone();
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
            row.request_id.as_deref() == Some(b.request.id.as_str())
                && row.kind != "approval.requested"
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
            .decide(&a.request.id, D::ApproveOnce, actor)
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
                .decide(&push.request.id, decision, Actor::User)
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
        .decide(&a.request.id, D::ApproveForThread, Actor::User)
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
        .decide(&a.request.id, D::ApproveForThread, Actor::User)
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
        .decide(&a.request.id, D::ApproveForWorkspace, Actor::User)
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
        .decide(&a.request.id, D::AllowViaRule, Actor::User)
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
        .decide(&a.request.id, D::ApproveOnce, Actor::User)
        .expect_err("expired");
    assert_eq!(err.code, "approval_expired");
    let all = h.service.list_approvals(None).expect("list");
    assert_eq!(all[0].request.status, ApprovalStatus::Expired);
    assert_eq!(all[0].expire_reason.as_deref(), Some("thread_stopped"));
    assert!(h.event_types().contains(&"approval.expired".to_owned()));
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
    let status = |id: &str| {
        all.iter()
            .find(|v| v.request.id == id)
            .map(|v| v.request.status)
    };
    assert_eq!(status(&first.request.id), Some(ApprovalStatus::Expired));
    assert_eq!(status(&second.request.id), Some(ApprovalStatus::Pending));
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
        };
        let decision = service.evaluate(&action, M::Approve);
        let view = service
            .open_request_view(action, M::Approve, &decision)
            .expect("open");
        core.shutdown();
        view.request.id
    };
    let core = Arc::new(open_core(&data));
    let service = PermissionService::new(
        core,
        Arc::new(kalcode_permissions::NoWorkspaces),
        Arc::new(kalcode_permissions::NoThreads),
    )
    .expect("service");
    let all = service.list_approvals(None).expect("list");
    let view = all
        .iter()
        .find(|v| v.request.id == request_id)
        .expect("request");
    assert_eq!(view.request.status, ApprovalStatus::Expired);
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
    let old = all
        .iter()
        .find(|v| v.request.id == pending.request.id)
        .expect("old");
    assert_eq!(old.request.status, ApprovalStatus::Expired);
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
    h.service
        .decide(&a.request.id, D::Deny, Actor::User)
        .expect("deny");
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
            "INSERT INTO approvals (id, thread_id, workspace_id, provider_id, action_id, request, decision,
               allowed_decisions, fingerprint, grant_coverage, permission_mode, status, created_at)
             VALUES (?1, 't', 'w', 'p', 'a', '{}', '{\"effect\":\"ask\",\"approvable\":false,\"scopes\":[],\"reason\":\"\"}',
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
            "INSERT INTO approvals (id, thread_id, workspace_id, provider_id, action_id, request, decision,
               allowed_decisions, fingerprint, grant_coverage, permission_mode, status, created_at)
             VALUES (?1, 't', 'w', 'p', 'b', '{}', '{\"effect\":\"ask\",\"approvable\":true,\"scopes\":[],\"reason\":\"\"}',
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

#[test]
fn migration_0005_applies_after_0001_and_preserves_data() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("kalcode.db");
    // A v1 database with representative data.
    {
        let mut conn = db::open(&path).expect("open");
        db::migrate(&mut conn, db::MIGRATIONS, None).expect("v1");
        conn.execute_batch(
            "INSERT INTO settings (key, value, updated_at) VALUES ('appearance.theme', '\"dark\"', 'now');
             INSERT INTO events (id, type, version, occurred_at, source, payload)
               VALUES ('e1', 'app.started', 1, 'now', 'core', '{}');",
        )
        .expect("seed");
    }
    let mut conn = db::open(&path).expect("reopen");
    let outcome = db::migrate(
        &mut conn,
        &migrations_with_placeholders(),
        Some(&dir.path().join("backups")),
    )
    .expect("upgrade");
    assert_eq!((outcome.from_version, outcome.to_version), (1, 5));
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
        !db::migrate(&mut conn, &migrations_with_placeholders(), None)
            .expect("again")
            .applied_any()
    );
}
