//! `CoreWorkspaces`: the thread runtime's view of Z1's workspaces.

#![allow(clippy::expect_used, clippy::unwrap_used)]

mod common;

use std::sync::Arc;

use common::*;
use kalcode_core::Core;
use kalcode_core::workspaces::canonical_folder;
use kalcode_threads::{CoreWorkspaces, WorkspaceResolver};

#[test]
fn open_workspaces_resolve_to_their_canonical_root() {
    let data = tempfile::tempdir().expect("data");
    let core = Arc::new(Core::open(config(data.path())).expect("open"));
    let project = tempfile::tempdir().expect("project");
    let other = tempfile::tempdir().expect("other");
    let first = core.open_workspace(project.path()).expect("open project");
    let second = core.open_workspace(other.path()).expect("open other");

    let resolver = CoreWorkspaces::new(core.clone());
    let mut listed: Vec<String> = resolver
        .list()
        .expect("list")
        .into_iter()
        .map(|w| w.id)
        .collect();
    listed.sort();
    let mut expected = vec![first.id.clone(), second.id.clone()];
    expected.sort();
    assert_eq!(listed, expected);

    let resolved = resolver.resolve(&first.id).expect("resolve");
    assert_eq!(resolved.name, first.name);
    assert_eq!(
        resolved.root,
        canonical_folder(project.path()).expect("canonical")
    );
    assert!(!resolved.root.to_string_lossy().starts_with(r"\\?\"));
}

#[test]
fn missing_and_removed_workspaces_are_refused() {
    let data = tempfile::tempdir().expect("data");
    let core = Arc::new(Core::open(config(data.path())).expect("open"));
    let resolver = CoreWorkspaces::new(core.clone());

    assert_code(
        resolver.resolve("01999a4e-0001-7001-8a2e-000000001001"),
        "workspace_not_found",
    );

    // A folder deleted outside KalCode: no longer offered, and refused when resolved.
    let project = tempfile::tempdir().expect("project");
    let gone = core.open_workspace(project.path()).expect("open");
    drop(project);
    assert!(resolver.list().expect("list").is_empty());
    assert_code(resolver.resolve(&gone.id), "workspace_unavailable");

    // A workspace removed from KalCode is not found.
    let kept = tempfile::tempdir().expect("kept");
    let removed = core.open_workspace(kept.path()).expect("open");
    core.remove_workspace(&removed.id).expect("remove");
    assert_code(resolver.resolve(&removed.id), "workspace_not_found");
}
