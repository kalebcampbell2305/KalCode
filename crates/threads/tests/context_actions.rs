#![allow(clippy::expect_used, clippy::unwrap_used)]

mod common;
use common::*;
use kalcode_contracts::agent::AgentEvent;
use kalcode_contracts::ids::new_id;
use kalcode_contracts::threads::ThreadStatus;
use kalcode_threads::ResolvedWorkspace;

#[test]
fn duplicate_keeps_conversation_without_sharing_execution() {
    let h = Harness::new();
    let source = h
        .runtime
        .create(h.request("Keep this conversation"))
        .unwrap();
    h.runtime.stop(&source.id).unwrap();
    let copied = h.runtime.duplicate(&source.id).unwrap();
    assert_ne!(source.id, copied.id);
    assert_eq!(copied.name, format!("{} (copy)", source.name));
    assert_eq!(copied.status, ThreadStatus::Idle);
    assert_eq!(h.provider.session_count(), 1);
    let row = h
        .core
        .read(|conn| kalcode_threads::store::get(conn, &copied.id))
        .unwrap();
    assert!(row.provider_session_id.is_none());
    assert!(!row.isolated);
    let original = h.runtime.messages(&source.id, 100, None).unwrap();
    let messages = h.runtime.messages(&copied.id, 100, None).unwrap();
    assert_eq!(original.len(), messages.len());
    for (a, b) in original.iter().zip(&messages) {
        assert_eq!(a.content, b.content);
        assert_ne!(a.id, b.id);
        assert_eq!(b.thread_id, copied.id);
    }
}

#[test]
fn move_rejects_busy_and_unknown_destinations_then_resumes_in_new_folder() {
    let h = Harness::new();
    let source = h.runtime.create(h.request("Work here")).unwrap();
    let destination = new_id();
    let root = h.dir.path().join("destination");
    std::fs::create_dir(&root).unwrap();
    h.workspaces
        .workspaces
        .lock()
        .unwrap()
        .push(ResolvedWorkspace {
            id: destination.clone(),
            name: "Destination".into(),
            root: root.clone(),
        });
    assert_eq!(
        h.runtime
            .move_to_workspace(&source.id, &destination)
            .unwrap_err()
            .code,
        "thread_move_busy"
    );
    h.provider
        .last_session()
        .emit(AgentEvent::TurnCompleted { ok: true });
    wait_until("idle", || {
        h.runtime.get(&source.id).unwrap().status == ThreadStatus::Idle
    });
    assert_eq!(
        h.runtime
            .move_to_workspace(&source.id, &new_id())
            .unwrap_err()
            .code,
        "workspace_not_found"
    );
    let moved = h
        .runtime
        .move_to_workspace(&source.id, &destination)
        .unwrap();
    assert_eq!(moved.workspace_id, destination);
    assert!(h.provider.last_session().is_released());
    let row = h
        .core
        .read(|conn| kalcode_threads::store::get(conn, &source.id))
        .unwrap();
    assert!(row.provider_session_id.is_none());
    assert_eq!(row.cwd, root.to_string_lossy());
    assert_eq!(h.runtime.messages(&source.id, 100, None).unwrap().len(), 1);
    h.runtime.resume(&source.id, Some("continue")).unwrap();
    assert_eq!(h.provider.last_session().config.working_directory, root);
}

#[test]
fn a_concurrent_move_invalidates_duplicate_and_resume_snapshots() {
    let h = std::sync::Arc::new(Harness::new());
    let source = h
        .runtime
        .create(h.request("Keep this conversation"))
        .unwrap();
    h.runtime.stop(&source.id).unwrap();
    let destination = new_id();
    h.workspaces
        .workspaces
        .lock()
        .unwrap()
        .push(ResolvedWorkspace {
            id: destination.clone(),
            name: "Destination".into(),
            root: h.dir.path().to_owned(),
        });
    let harness = h.clone();
    let id = source.id.clone();
    let target = destination.clone();
    h.workspaces.on_next_resolve(move || {
        harness.runtime.move_to_workspace(&id, &target).unwrap();
    });
    assert_eq!(
        h.runtime.duplicate(&source.id).unwrap_err().code,
        "thread_workspace_changed"
    );
    assert_eq!(h.runtime.list(None, true).unwrap().len(), 1);
    let harness = h.clone();
    let id = source.id.clone();
    let target = h.workspace_id.clone();
    h.workspaces.on_next_resolve(move || {
        harness.runtime.move_to_workspace(&id, &target).unwrap();
    });
    assert_eq!(
        h.runtime
            .resume(&source.id, Some("continue"))
            .unwrap_err()
            .code,
        "thread_workspace_changed"
    );
    assert_eq!(h.provider.session_count(), 1);
    assert_eq!(
        h.runtime.get(&source.id).unwrap().status,
        ThreadStatus::Idle
    );
}

#[test]
fn removed_worktree_ownership_disables_move_but_duplicate_is_independent() {
    let h = Harness::new();
    let source = h.runtime.create(h.request("Isolated work")).unwrap();
    h.runtime.stop(&source.id).unwrap();
    h.core.transact(|tx| {
        tx.execute("INSERT INTO git_worktrees (id, workspace_id, path, branch, base_commit, purpose, owner_ref, status, created_at, removed_at) VALUES (?1, ?2, 'removed-path', 'kal/test', ?3, 'thread', ?4, 'removed', 't', 't')", rusqlite::params![new_id(), h.workspace_id, "a".repeat(40), source.id])?;
        Ok(((), Vec::new()))
    }).unwrap();
    let summary = h.runtime.get(&source.id).unwrap();
    assert!(summary.worktree_id.is_none());
    assert_eq!(summary.can_move_workspace, Some(false));
    assert_eq!(
        h.runtime
            .move_to_workspace(&source.id, &h.workspace_id)
            .unwrap_err()
            .code,
        "thread_move_worktree"
    );
    let copy = h.runtime.duplicate(&source.id).unwrap();
    assert_eq!(copy.can_move_workspace, Some(true));
    assert!(copy.worktree_id.is_none());
}

#[test]
fn fresh_idle_copy_starts_an_independent_live_session_in_the_selected_directory() {
    let h = Harness::new();
    let source = h
        .runtime
        .create(h.request("Source conversation stays here"))
        .unwrap();
    let original = h.provider.last_session();
    let before = original.calls();
    let cwd = h.dir.path().join("selected worktree");
    std::fs::create_dir(&cwd).unwrap();
    let copied = h
        .runtime
        .create_idle_with_id_in_directory(
            &new_id(),
            kalcode_threads::CreateIdleThread {
                provider_id: source.provider_id.to_string(),
                provider_account_id: source.provider_account_id.clone(),
                account_label: source.account_label.clone(),
                workspace_id: source.workspace_id.clone(),
                model: source.model.clone(),
                effort: Some("high".into()),
                permission_mode: source.permission_mode,
                name: Some("Source (copy)".into()),
            },
            cwd.clone(),
        )
        .unwrap();
    assert_ne!(source.id, copied.id);
    assert_eq!(h.provider.session_count(), 2);
    assert_eq!(copied.status, ThreadStatus::Idle);
    assert_eq!(copied.effort.as_deref(), Some("high"));
    let session = h.provider.last_session();
    assert_eq!(
        std::path::PathBuf::from(&session.config.working_directory),
        cwd
    );
    assert!(session.config.resume_session_id.is_none());
    assert!(
        h.runtime
            .messages(&copied.id, 100, None)
            .unwrap()
            .is_empty()
    );
    assert_eq!(original.calls(), before);
    h.runtime.stop(&copied.id).unwrap();
    assert_eq!(original.calls(), before);
    h.runtime.resume(&copied.id, None).unwrap();
    assert_eq!(
        std::path::PathBuf::from(&h.provider.last_session().config.working_directory),
        cwd
    );
    h.runtime.stop(&copied.id).unwrap();
    std::fs::remove_dir(&cwd).unwrap();
    assert!(h.runtime.resume(&copied.id, None).is_err());
    assert_eq!(original.calls(), before);
}
