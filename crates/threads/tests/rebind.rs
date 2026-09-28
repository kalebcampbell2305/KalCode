//! Switch accounts, lane 1: explicit thread account rebinds. A rebind changes only future
//! provider requests: the resume id (which lives in the old account's profile home) is cleared
//! with the account in one transaction, an idle live session is ended so its profile lease is
//! released, and busy threads are refused.

#![allow(clippy::expect_used, clippy::unwrap_used)]

mod common;

use std::sync::Arc;

use common::*;
use kalcode_contracts::agent::{AgentEvent, ProviderId};
use kalcode_contracts::events::EventPayload;
use kalcode_contracts::ids::new_id;
use kalcode_contracts::permissions::PermissionMode;
use kalcode_contracts::threads::{MessageRole, ThreadStatus};
use kalcode_core::Core;
use kalcode_threads::{CreateThread, ThreadRuntime};

struct Accounts {
    provider: Arc<FakeProvider>,
    a: String,
    b: String,
    other_provider: String,
    archived: String,
}

fn insert_account(h: &Harness, id: &str, provider: &str, label: &str, archived: bool) {
    h.core
        .transact(|conn| {
            conn.execute(
                "INSERT INTO provider_accounts (
                    id, provider_id, display_name, authentication_state, is_default,
                    created_at, archived_at
                 ) VALUES (?1, ?2, ?3, 'authenticated', 0, '2026-09-28T00:00:00Z', ?4)",
                rusqlite::params![
                    id,
                    provider,
                    label,
                    archived.then_some("2026-09-28T01:00:00Z")
                ],
            )?;
            Ok(((), Vec::new()))
        })
        .expect("account");
}

fn gemini_accounts(h: &Harness) -> Accounts {
    let provider = FakeProvider::configured(ProviderId::GEMINI_CLI, "Gemini CLI", true, true);
    h.registry.register(provider.clone());
    let accounts = Accounts {
        provider,
        a: new_id(),
        b: new_id(),
        other_provider: new_id(),
        archived: new_id(),
    };
    insert_account(h, &accounts.a, ProviderId::GEMINI_CLI, "Gemini A", false);
    insert_account(h, &accounts.b, ProviderId::GEMINI_CLI, "Gemini B", false);
    insert_account(
        h,
        &accounts.other_provider,
        ProviderId::CODEX,
        "Work",
        false,
    );
    insert_account(h, &accounts.archived, ProviderId::GEMINI_CLI, "Old", true);
    accounts
}

/// A Gemini thread on account A whose first turn finished, with a stored provider resume id.
fn idle_thread_on_a(h: &Harness, accounts: &Accounts) -> String {
    let thread = h
        .runtime
        .create(CreateThread {
            provider_id: ProviderId::GEMINI_CLI.into(),
            provider_account_id: Some(accounts.a.clone()),
            account_label: Some("Gemini A".into()),
            workspace_id: h.workspace_id.clone(),
            model: None,
            permission_mode: PermissionMode::Approve,
            prompt: "summarize the repo".into(),
            name: None,
        })
        .expect("create");
    let session = accounts.provider.last_session();
    session.emit(AgentEvent::SessionStarted {
        provider_session_id: "gemini-chat-under-a".into(),
        model: None,
    });
    session.emit(AgentEvent::TurnCompleted { ok: true });
    wait_until("idle with a resume id", || {
        let row = h
            .core
            .read(|conn| kalcode_threads::store::get(conn, &thread.id))
            .unwrap();
        row.status == ThreadStatus::Idle && row.provider_session_id.is_some()
    });
    thread.id
}

fn account_changes(h: &Harness, thread_id: &str) -> Vec<EventPayload> {
    h.events_for(thread_id)
        .into_iter()
        .map(|envelope| envelope.event)
        .filter(|event| matches!(event, EventPayload::ThreadAccountChanged { .. }))
        .collect()
}

#[test]
fn rebind_ends_the_idle_session_and_the_next_turn_starts_fresh_under_the_new_account() {
    let h = Harness::new();
    let accounts = gemini_accounts(&h);
    let id = idle_thread_on_a(&h, &accounts);
    let old_session = accounts.provider.last_session();
    let completed_before = h
        .event_types()
        .iter()
        .filter(|t| *t == "thread.completed")
        .count();

    let rebound = h.runtime.rebind_account(&id, &accounts.b).expect("rebind");
    assert_eq!(
        rebound.provider_account_id.as_deref(),
        Some(accounts.b.as_str())
    );
    assert_eq!(rebound.account_label.as_deref(), Some("Gemini B"));
    assert_eq!(
        rebound.status,
        ThreadStatus::Completed,
        "resumable, not interrupted"
    );
    assert!(!rebound.resumable, "no resume id survives the rebind");

    // The idle session under A was ended and dropped, releasing A's shared profile lease.
    assert!(old_session.calls().contains(&Call::Terminate));
    assert!(old_session.is_released());
    assert_eq!(
        account_changes(&h, &id),
        [EventPayload::ThreadAccountChanged {
            thread_id: id.clone(),
            provider_account_id: accounts.b.clone(),
            account_label: Some("Gemini B".into()),
        }]
    );
    assert_eq!(
        h.event_types()
            .iter()
            .filter(|t| *t == "thread.completed")
            .count(),
        completed_before,
        "switching accounts is not a finished-thread notification"
    );

    // Next turn: a fresh provider session under B, never A's resume id or profile.
    h.runtime.resume(&id, Some("continue")).expect("resume");
    assert_eq!(accounts.provider.session_count(), 2);
    let session = accounts.provider.last_session();
    assert_eq!(
        session.config.provider_account_id.as_deref(),
        Some(accounts.b.as_str())
    );
    assert_eq!(session.config.resume_session_id, None);
    assert_eq!(session.calls(), [Call::Send("continue".into())]);
    let messages = h.runtime.messages(&id, 50, None).unwrap();
    assert!(
        messages
            .iter()
            .any(|m| m.role == MessageRole::System && m.content.contains("won't remember")),
        "the existing new-session notice explains the fresh session"
    );
    assert_eq!(
        messages[0].content, "summarize the repo",
        "history is untouched"
    );
}

#[test]
fn rebind_is_refused_mid_turn_and_while_an_approval_is_pending() {
    let h = Harness::new();
    let accounts = gemini_accounts(&h);
    let thread = h
        .runtime
        .create(CreateThread {
            provider_id: ProviderId::GEMINI_CLI.into(),
            provider_account_id: Some(accounts.a.clone()),
            account_label: Some("Gemini A".into()),
            ..h.request("install deps")
        })
        .expect("create");
    assert_eq!(thread.status, ThreadStatus::Active);
    assert_code(
        h.runtime.rebind_account(&thread.id, &accounts.b),
        "thread_rebind_busy",
    );

    let session = accounts.provider.last_session();
    session.emit(AgentEvent::ApprovalRequired {
        request_id: "p-1".into(),
        action: command_action("npm install"),
    });
    wait_until("waiting for permission", || {
        h.runtime.get(&thread.id).unwrap().status == ThreadStatus::WaitingForPermission
    });
    assert_code(
        h.runtime.rebind_account(&thread.id, &accounts.b),
        "thread_rebind_pending_approval",
    );

    let after = h.runtime.get(&thread.id).unwrap();
    assert_eq!(
        after.provider_account_id.as_deref(),
        Some(accounts.a.as_str())
    );
    assert!(
        !session.calls().contains(&Call::Terminate),
        "the live turn is untouched"
    );
    assert!(account_changes(&h, &thread.id).is_empty());
}

#[test]
fn rebind_validates_the_thread_and_target_account() {
    let h = Harness::new();
    let accounts = gemini_accounts(&h);
    let id = idle_thread_on_a(&h, &accounts);
    let session = accounts.provider.last_session();

    for (account, code) in [
        (
            accounts.other_provider.as_str(),
            "provider_account_mismatch",
        ),
        (accounts.archived.as_str(), "provider_account_archived"),
        (&new_id(), "provider_account_unknown"),
        ("not-an-id", "provider_account_id_invalid"),
    ] {
        assert_code(h.runtime.rebind_account(&id, account), code);
    }
    assert_code(
        h.runtime.rebind_account("nope", &accounts.b),
        "invalid_thread_id",
    );
    assert_code(
        h.runtime.rebind_account(&new_id(), &accounts.b),
        "thread_not_found",
    );

    // Same account: a successful no-op that keeps the live session and emits nothing.
    let same = h
        .runtime
        .rebind_account(&id, &accounts.a)
        .expect("same account");
    assert_eq!(same.status, ThreadStatus::Idle);
    assert!(same.resumable);
    assert!(!session.calls().contains(&Call::Terminate));
    assert!(account_changes(&h, &id).is_empty());

    h.runtime.stop(&id).expect("stop");
    h.runtime.archive(&id).expect("archive");
    assert_code(
        h.runtime.rebind_account(&id, &accounts.b),
        "thread_archived",
    );
}

#[test]
fn a_thread_on_an_archived_account_refuses_to_run_instead_of_falling_back() {
    let h = Harness::new();
    let accounts = gemini_accounts(&h);
    let id = idle_thread_on_a(&h, &accounts);
    h.runtime.stop(&id).expect("stop");
    h.core
        .transact(|conn| {
            conn.execute(
                "UPDATE provider_accounts SET archived_at = '2026-09-28T02:00:00Z' WHERE id = ?1",
                [&accounts.a],
            )?;
            Ok(((), Vec::new()))
        })
        .expect("archive account a");

    assert_code(
        h.runtime.resume(&id, Some("hello")),
        "provider_account_archived",
    );
    assert_eq!(accounts.provider.session_count(), 1, "nothing launched");
    let thread = h.runtime.get(&id).unwrap();
    assert_eq!(thread.status, ThreadStatus::Interrupted);
    assert_eq!(
        thread.provider_account_id.as_deref(),
        Some(accounts.a.as_str())
    );

    // Rebinding to an active account is the way forward.
    h.runtime.rebind_account(&id, &accounts.b).expect("rebind");
    h.runtime.resume(&id, None).expect("resume under b");
    assert_eq!(
        accounts
            .provider
            .last_session()
            .config
            .provider_account_id
            .as_deref(),
        Some(accounts.b.as_str())
    );
}

#[test]
fn a_rebind_persists_across_restart() {
    let h = Harness::new();
    let accounts = gemini_accounts(&h);
    let id = idle_thread_on_a(&h, &accounts);
    h.runtime.stop(&id).expect("stop");
    let rebound = h.runtime.rebind_account(&id, &accounts.b).expect("rebind");
    assert_eq!(
        rebound.status,
        ThreadStatus::Interrupted,
        "no live session to end"
    );

    let Harness {
        dir,
        core,
        registry,
        workspaces,
        gate,
        runtime,
        ..
    } = h;
    drop(runtime);
    drop(core);
    let core = Arc::new(Core::open(config(dir.path())).expect("reopen core"));
    let row = core
        .read(|conn| kalcode_threads::store::get(conn, &id))
        .expect("row");
    assert_eq!(
        row.provider_account_id.as_deref(),
        Some(accounts.b.as_str())
    );
    assert_eq!(row.account_label.as_deref(), Some("Gemini B"));
    assert_eq!(row.provider_session_id, None);

    let restarted =
        ThreadRuntime::new(core, registry, workspaces, gate).expect("restarted runtime");
    restarted.resume(&id, None).expect("resume");
    let session = accounts.provider.last_session();
    assert_eq!(
        session.config.provider_account_id.as_deref(),
        Some(accounts.b.as_str())
    );
    assert_eq!(session.config.resume_session_id, None);
}
