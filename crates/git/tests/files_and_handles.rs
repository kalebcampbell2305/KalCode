//! File index, opaque handles and path-escape attempts: `..`, symlinks, junctions, UNC and
//! verbatim prefixes, alternate data streams, device names, `.git`, cross-workspace handles,
//! and a link swapped in after a handle was issued (time-of-check/time-of-use).

// Test helpers outside `#[test]` functions panic on setup failures by design.
#![allow(clippy::expect_used)]

mod common;

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use common::Fixture;
use kalcode_contracts::ids::new_id;
use kalcode_git::handles::HandleRegistry;
use kalcode_git::index::FileIndex;
use kalcode_git::types::{FileHandle, PageRequest};
use kalcode_git::watch::IndexWatcher;
use kalcode_git::{RelPath, WorkspaceRoot};

fn page(limit: u32) -> PageRequest {
    PageRequest {
        limit,
        cursor: None,
    }
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

/// A file symlink (Windows needs Developer Mode or elevation; returns false when unavailable).
fn file_link(link: &Path, target: &Path) -> bool {
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_file(target, link).is_ok()
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).is_ok()
    }
}

#[test]
fn escape_attempts_through_paths_are_rejected_before_any_filesystem_access() {
    let windows_only = [
        r"..\secret.txt",
        r"\\?\C:\Windows\win.ini",
        r"\\.\PhysicalDrive0",
        r"\\server\share\file",
        "C:/Windows/win.ini",
        "C:secret",
        "notes.txt:hidden-stream",
        "CON",
        "sub/aux.txt",
        "trailing.",
    ];
    let everywhere = [
        "../secret.txt",
        "a/../../secret.txt",
        "/etc/passwd",
        ".git/config",
        "x/.git/hooks/pre-commit",
        "a//b",
        "",
    ];
    for raw in everywhere {
        assert!(RelPath::parse_for(raw, false).is_err(), "posix {raw:?}");
        assert!(RelPath::parse_for(raw, true).is_err(), "windows {raw:?}");
    }
    for raw in windows_only {
        assert!(RelPath::parse_for(raw, true).is_err(), "windows {raw:?}");
    }
}

#[test]
fn links_to_outside_the_workspace_never_resolve() {
    let fx = Fixture::plain_folder();
    let outside = fx.temp.path().join("outside");
    std::fs::create_dir_all(&outside).expect("mkdir");
    std::fs::write(outside.join("secret.txt"), "secret").expect("write");
    fx.write("inside.txt", "ok");
    assert!(dir_link(&fx.path("dirlink"), &outside), "directory link");
    let has_file_link = file_link(&fx.path("filelink.txt"), &outside.join("secret.txt"));

    let handles = HandleRegistry::default();
    let err = handles
        .issue(&fx.ws, &RelPath::parse("dirlink/secret.txt").expect("rel"))
        .expect_err("through a link");
    assert_eq!(err.code, "path_outside_workspace");
    if has_file_link {
        let err = handles
            .issue(&fx.ws, &RelPath::parse("filelink.txt").expect("rel"))
            .expect_err("file link");
        assert_eq!(err.code, "path_outside_workspace");
    }

    // The index never follows the link and never lists what is behind it.
    let index = FileIndex::build(fx.ws.clone()).expect("index");
    assert!(
        index
            .get(&RelPath::parse("dirlink/secret.txt").expect("rel"))
            .is_none()
    );
    assert!(index.find("secret", 10).is_empty());
    // The link itself may be listed, but its handle refuses to resolve.
    let listing = index.list_dir(None, &page(100), &handles).expect("list");
    let link = listing
        .items
        .iter()
        .find(|e| e.file.display_path == "dirlink")
        .expect("link listed");
    assert!(
        !link.is_dir,
        "links are never presented as folders to descend into"
    );
    let err = handles
        .resolve(&fx.ws, &link.file.handle)
        .expect_err("link handle");
    assert_eq!(err.code, "path_outside_workspace");
    let err = index
        .list_dir(
            Some(&RelPath::parse("dirlink").expect("rel")),
            &page(10),
            &handles,
        )
        .expect_err("listing through a link");
    assert_eq!(err.code, "path_outside_workspace");
}

#[test]
fn a_link_swapped_in_after_issue_is_caught_at_use() {
    let fx = Fixture::plain_folder();
    fx.write("sub/file.txt", "inside");
    let outside = fx.temp.path().join("outside");
    std::fs::create_dir_all(&outside).expect("mkdir");
    std::fs::write(outside.join("file.txt"), "outside").expect("write");

    let handles = HandleRegistry::default();
    let file = handles
        .issue(&fx.ws, &RelPath::parse("sub/file.txt").expect("rel"))
        .expect("issue");
    assert!(handles.resolve(&fx.ws, &file.handle).is_ok());

    std::fs::remove_dir_all(fx.path("sub")).expect("rm");
    assert!(dir_link(&fx.path("sub"), &outside), "swap in a link");
    let err = handles
        .resolve(&fx.ws, &file.handle)
        .expect_err("re-checked at use");
    assert_eq!(err.code, "path_outside_workspace");
}

#[test]
fn git_internals_are_unreachable_even_through_short_names() {
    let fx = Fixture::repo();
    let handles = HandleRegistry::default();
    assert!(RelPath::parse(".git/config").is_err());
    let index = FileIndex::build(fx.ws.clone()).expect("index");
    assert!(index.find("config", 10).is_empty(), ".git is never indexed");
    let listing = index.list_dir(None, &page(100), &handles).expect("list");
    assert!(
        listing
            .items
            .iter()
            .all(|e| !e.file.display_path.eq_ignore_ascii_case(".git"))
    );
    // Windows 8.3 short name for `.git` (only when the volume generates short names).
    if cfg!(windows) && fx.exists("GIT~1") {
        let err = handles
            .issue(&fx.ws, &RelPath::parse("GIT~1/config").expect("rel"))
            .expect_err("short name");
        assert_eq!(err.code, "path_outside_workspace");
    }
}

#[test]
fn handles_are_workspace_bound_and_unforgeable() {
    let a = Fixture::plain_folder();
    let b = Fixture::plain_folder();
    a.write("x.txt", "a");
    b.write("x.txt", "b");
    let handles = HandleRegistry::default();
    let from_a = handles
        .issue(&a.ws, &RelPath::parse("x.txt").expect("rel"))
        .expect("issue");
    assert_eq!(
        handles
            .resolve(&b.ws, &from_a.handle)
            .expect_err("cross")
            .code,
        "file_handle_unknown"
    );
    for forged in [new_id(), "x.txt".into(), "../x.txt".into(), String::new()] {
        assert!(handles.resolve(&a.ws, &FileHandle { id: forged }).is_err());
    }
    // A workspace root given as a verbatim or UNC-style path still canonicalizes to one root.
    let same = WorkspaceRoot::new(a.ws.id(), a.ws.path()).expect("same");
    assert!(handles.resolve(&same, &from_a.handle).is_ok());
}

#[test]
fn listing_flags_ignored_entries_and_pages() {
    let fx = Fixture::repo();
    fx.write(".gitignore", "node_modules/\n*.log\n");
    fx.write("node_modules/pkg/index.js", "x");
    fx.write("app.log", "log");
    fx.write("src/main.rs", "fn main() {}");
    for i in 0..30 {
        fx.write(&format!("many/f{i:02}.txt"), "x");
    }
    let handles = HandleRegistry::default();
    let index = FileIndex::build(fx.ws.clone()).expect("index");
    assert!(
        index
            .get(&RelPath::parse("node_modules/pkg/index.js").expect("rel"))
            .is_none()
    );
    assert!(
        index
            .get(&RelPath::parse("src/main.rs").expect("rel"))
            .is_some()
    );

    let root = index.list_dir(None, &page(100), &handles).expect("list");
    let names: Vec<(&str, bool, bool)> = root
        .items
        .iter()
        .map(|e| (e.file.display_path.as_str(), e.is_dir, e.ignored))
        .collect();
    assert_eq!(
        &names[..3],
        &[
            ("many", true, false),
            ("node_modules", true, true),
            ("src", true, false)
        ]
    );
    assert!(names.contains(&("app.log", false, true)));
    assert!(names.contains(&("README.md", false, false)));

    // Paging a folder through its handle.
    let many = root
        .items
        .iter()
        .find(|e| e.file.display_path == "many")
        .expect("many");
    let dir = handles.resolve(&fx.ws, &many.file.handle).expect("dir").rel;
    let first = index
        .list_dir(Some(&dir), &page(20), &handles)
        .expect("page");
    assert_eq!(first.items.len(), 20);
    let rest = index
        .list_dir(
            Some(&dir),
            &PageRequest {
                limit: 20,
                cursor: first.next_cursor.clone(),
            },
            &handles,
        )
        .expect("page");
    assert_eq!(rest.items.len(), 10);
    assert!(rest.next_cursor.is_none());
    assert!(index.list_dir(None, &page(501), &handles).is_err());
}

#[test]
fn incremental_updates_follow_files_folders_and_ignore_rules() {
    let fx = Fixture::repo();
    fx.write(".gitignore", "build/\n");
    fx.write("build/out.bin", "x");
    fx.write("src/a.rs", "a");
    let index = FileIndex::build(fx.ws.clone()).expect("index");
    let rel = |p: &str| RelPath::parse(p).expect("rel");

    fx.write("src/b.rs", "b");
    fx.write("docs/deep/guide.md", "g");
    let summary = index
        .apply_changes(&[rel("src/b.rs"), rel("docs")])
        .expect("apply");
    assert!(summary.added >= 3, "{summary:?}");
    assert!(index.get(&rel("docs/deep/guide.md")).is_some());

    std::fs::remove_dir_all(fx.path("docs")).expect("rm");
    index.apply_changes(&[rel("docs")]).expect("apply");
    assert!(index.get(&rel("docs/deep/guide.md")).is_none());
    assert!(index.get(&rel("docs")).is_none());

    // Un-ignoring `build/` brings its files in; ignoring `src/` drops them.
    fx.write(".gitignore", "src/\n");
    index.apply_changes(&[rel(".gitignore")]).expect("apply");
    assert!(index.get(&rel("build/out.bin")).is_some());
    assert!(index.get(&rel("src/a.rs")).is_none());
    assert_eq!(index.find("out.bin", 5), vec![rel("build/out.bin")]);
}

#[test]
fn watcher_keeps_the_index_current() {
    let fx = Fixture::repo();
    let index = Arc::new(FileIndex::build(fx.ws.clone()).expect("index"));
    let batches = Arc::new(AtomicUsize::new(0));
    let seen = Arc::clone(&batches);
    let watcher = IndexWatcher::start(Arc::clone(&index), Duration::from_millis(150), move |_| {
        seen.fetch_add(1, Ordering::SeqCst);
    })
    .expect("watch");
    fx.write("watched/new.txt", "hello");
    let target = RelPath::parse("watched/new.txt").expect("rel");
    let deadline = Instant::now() + Duration::from_secs(10);
    // The watcher applies a batch to the index, then reports it through the callback; wait for
    // both, since a check between the two steps would race.
    while (index.get(&target).is_none() || batches.load(Ordering::SeqCst) == 0)
        && Instant::now() < deadline
    {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(index.get(&target).is_some(), "watcher applied the change");
    assert!(
        batches.load(Ordering::SeqCst) >= 1,
        "watcher reported the batch"
    );
    drop(watcher);
}

/// A workspace that is its own repository inside another one (a home folder kept in Git with a
/// `*` `.gitignore`, a monorepo checkout folder): like Git, the outer repository's ignore rules
/// stop at the workspace's repository and never hide its files. Within one repository, a parent
/// folder's rules still apply to a workspace that is a subfolder of it.
#[test]
fn ignore_rules_stop_at_the_repository_boundary() {
    let fx = Fixture::plain_folder();
    // The outer repository ignores everything (a common dotfiles setup).
    let outer = fx.temp.path();
    common::init_repo(outer);
    std::fs::write(outer.join(".gitignore"), "*\n!.gitignore\n").expect("outer ignore");
    // The workspace is a repository of its own inside it.
    common::init_repo(&fx.root);
    fx.write(".gitignore", "target/\n");
    fx.write("src/main.rs", "fn main() {}");
    fx.write("target/out.bin", "x");
    // Git agrees the file is not ignored in the workspace's repository.
    assert!(!common::try_plain(
        &fx.root,
        &["check-ignore", "-q", "src/main.rs"]
    ));

    let index = FileIndex::build(fx.ws.clone()).expect("index");
    let rel = |p: &str| RelPath::parse(p).expect("rel");
    assert!(
        index.get(&rel("src/main.rs")).is_some(),
        "outer ignore leaked"
    );
    assert!(index.get(&rel("target/out.bin")).is_none());
    let handles = HandleRegistry::default();
    let root = index.list_dir(None, &page(50), &handles).expect("list");
    let src = root
        .items
        .iter()
        .find(|e| e.file.display_path == "src")
        .expect("src listed");
    assert!(!src.ignored, "src is not ignored");

    // A workspace that is a subfolder of a repository keeps that repository's parent rules.
    let sub = fx.root.join("pkg");
    std::fs::create_dir_all(sub.join("target")).expect("mkdir");
    std::fs::write(sub.join("target").join("x.bin"), "x").expect("write");
    std::fs::write(sub.join("lib.rs"), "x").expect("write");
    let sub_ws = WorkspaceRoot::new(&new_id(), &sub).expect("sub workspace");
    let sub_index = FileIndex::build(sub_ws).expect("index");
    assert!(sub_index.get(&rel("lib.rs")).is_some());
    assert!(sub_index.get(&rel("target/x.bin")).is_none());
}
