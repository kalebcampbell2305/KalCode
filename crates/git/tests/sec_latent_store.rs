//! SEC-LATENT regression tests (docs/campaigns/SEC-LATENT.md): the checkpoint store must never
//! live inside the workspace it snapshots — enforced on **every** use, including the first one
//! (store folder not created yet), through links, `..`, other letter case, and in the reverse
//! direction (the workspace inside the store).
#![allow(clippy::expect_used, clippy::unwrap_used)]

mod common;

use std::path::Path;

use common::Fixture;
use kalcode_contracts::ids::new_id;
use kalcode_git::checkpoint::{CheckpointOptions, CheckpointStore, CreateOutcome};
use kalcode_git::diff::DiffOptions;
use kalcode_git::handles::HandleRegistry;

const INSIDE: &str = "checkpoint_store_inside_workspace";

fn code<T: std::fmt::Debug>(result: kalcode_core::Result<T>) -> Option<&'static str> {
    result.err().map(|e| e.code)
}

/// Creates a directory link: a junction on Windows (no privilege needed), a symlink elsewhere.
fn dir_link(link: &Path, target: &Path) -> bool {
    #[cfg(windows)]
    {
        let mut command = std::process::Command::new("cmd");
        common::hide_test_process(&mut command);
        command
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .is_ok_and(|o| o.status.success())
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).is_ok()
    }
}

/// Review PoC `zz_review_store_inside.rs`: the guard used to be skipped when the store folder
/// didn't exist yet (canonicalize failed), so the first checkpoint was taken — and the store
/// folder created — inside the workspace.
#[test]
fn store_inside_workspace_is_refused_on_first_use() {
    let fx = Fixture::repo();
    fx.write("src/a.txt", "alpha\n");
    let base = fx.root.join("appdata").join("checkpoints");
    let store = CheckpointStore::new(base.clone(), CheckpointOptions::default());

    let first = store.create(&fx.git, &fx.ws, &new_id(), None, None);
    assert_eq!(code(first), Some(INSIDE), "first use must be refused");
    assert!(
        !fx.root.join("appdata").exists(),
        "nothing may be created inside the workspace"
    );
    let second = store.create(&fx.git, &fx.ws, &new_id(), None, None);
    assert_eq!(code(second), Some(INSIDE));
}

#[test]
fn every_workspace_entry_point_is_guarded_on_first_use() {
    let fx = Fixture::repo();
    let store = CheckpointStore::new(
        fx.root.join("kc").join("store"),
        CheckpointOptions::default(),
    );
    let oid = "0".repeat(40);
    assert_eq!(
        code(store.plan_restore(&fx.git, &fx.ws, &oid, None, false)),
        Some(INSIDE)
    );
    assert_eq!(
        code(store.diff(
            &fx.git,
            &fx.ws,
            &oid,
            None,
            &DiffOptions::default(),
            &HandleRegistry::default()
        )),
        Some(INSIDE)
    );
    assert!(!fx.root.join("kc").exists());
}

#[test]
fn dot_dot_and_missing_components_do_not_hide_the_workspace() {
    let fx = Fixture::repo();
    // `<temp>/data/missing/../../ws/store`: lexically inside the workspace.
    let base = fx
        .data
        .join("missing")
        .join("..")
        .join("..")
        .join("ws")
        .join("store");
    let store = CheckpointStore::new(base, CheckpointOptions::default());
    assert_eq!(
        code(store.create(&fx.git, &fx.ws, &new_id(), None, None)),
        Some(INSIDE)
    );
    assert!(!fx.root.join("store").exists());
}

#[cfg(windows)]
#[test]
fn other_letter_case_is_the_same_folder_on_windows() {
    let fx = Fixture::repo();
    let upper = std::path::PathBuf::from(fx.root.to_string_lossy().to_uppercase());
    let store = CheckpointStore::new(upper.join("STORE"), CheckpointOptions::default());
    assert_eq!(
        code(store.create(&fx.git, &fx.ws, &new_id(), None, None)),
        Some(INSIDE)
    );
}

#[test]
fn a_link_into_the_workspace_is_followed_on_first_use() {
    let fx = Fixture::repo();
    let link = fx.temp.path().join("link-to-ws");
    if !dir_link(&link, &fx.root) {
        eprintln!("skipped: could not create a directory link");
        return;
    }
    // `link-to-ws/checkpoints` doesn't exist; its nearest existing ancestor resolves into the
    // workspace.
    let store = CheckpointStore::new(link.join("checkpoints"), CheckpointOptions::default());
    assert_eq!(
        code(store.create(&fx.git, &fx.ws, &new_id(), None, None)),
        Some(INSIDE)
    );
    assert!(!fx.root.join("checkpoints").exists());
}

#[test]
fn workspace_inside_the_store_is_refused() {
    let fx = Fixture::repo();
    // The store's base folder contains the workspace (`<temp>` holds `ws`).
    let store = CheckpointStore::new(fx.temp.path().to_path_buf(), CheckpointOptions::default());
    assert_eq!(
        code(store.create(&fx.git, &fx.ws, &new_id(), None, None)),
        Some(INSIDE)
    );
}

#[test]
fn store_outside_the_workspace_still_works_on_first_use() {
    let fx = Fixture::repo();
    fx.write("src/a.txt", "alpha\n");
    let store = CheckpointStore::new(fx.data.join("checkpoints"), CheckpointOptions::default());
    let created = store
        .create(&fx.git, &fx.ws, &new_id(), None, None)
        .expect("create");
    assert!(matches!(created, CreateOutcome::Created(_)));
}
