//! SEC-LATENT regression tests (docs/campaigns/SEC-LATENT.md): open-then-verify reads.
//!
//! Resolving a path and then opening it is a check-then-use race: a link swapped in between
//! redirects the open outside the workspace. [`WorkspaceRoot::open_verified`] opens first and
//! then proves the opened handle is the very file that the workspace path resolves to now
//! (same volume/device and file id), so a handle obtained through a swap is refused.
#![allow(clippy::expect_used, clippy::unwrap_used)]

mod common;

use std::io::Read;
use std::path::Path;

use common::Fixture;
use kalcode_git::RelPath;
use kalcode_git::handles::HandleRegistry;

fn rel(s: &str) -> RelPath {
    RelPath::parse(s).expect("rel")
}

fn dir_link(link: &Path, target: &Path) -> bool {
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
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

#[test]
fn opens_and_reads_a_workspace_file() {
    let fx = Fixture::plain_folder();
    fx.write("src/a.txt", "alpha\n");
    let mut opened = fx.ws.open_verified(&rel("src/a.txt")).expect("open");
    let mut text = String::new();
    opened.file.read_to_string(&mut text).expect("read");
    assert_eq!(text, "alpha\n");
    assert!(fx.ws.contains(&opened.path));
}

#[test]
fn a_handle_opened_on_another_file_is_refused() {
    // Simulates the race: the handle came from a swapped path (here: a file outside the
    // workspace), the workspace path resolves to a different file at verification time.
    let fx = Fixture::plain_folder();
    fx.write("src/a.txt", "inside\n");
    let outside = fx.temp.path().join("outside.txt");
    std::fs::write(&outside, "secret\n").unwrap();
    let foreign = std::fs::File::open(&outside).unwrap();
    let err = fx
        .ws
        .verify_opened(&rel("src/a.txt"), &foreign)
        .expect_err("foreign handle");
    assert_eq!(err.code, "path_outside_workspace");

    let own = std::fs::File::open(fx.root.join("src").join("a.txt")).unwrap();
    fx.ws
        .verify_opened(&rel("src/a.txt"), &own)
        .expect("own handle");
}

#[test]
fn a_directory_link_to_outside_is_refused() {
    let fx = Fixture::plain_folder();
    let outside = fx.temp.path().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("secret.txt"), "secret\n").unwrap();
    if !dir_link(&fx.root.join("linked"), &outside) {
        eprintln!("skipped: could not create a directory link");
        return;
    }
    let err = fx
        .ws
        .open_verified(&rel("linked/secret.txt"))
        .expect_err("outside");
    assert_eq!(err.code, "path_outside_workspace");
}

#[test]
fn a_handle_swapped_to_a_link_after_issue_is_refused_on_open() {
    let fx = Fixture::plain_folder();
    fx.write("dir/f.txt", "inside\n");
    let registry = HandleRegistry::default();
    let issued = registry.issue(&fx.ws, &rel("dir/f.txt")).expect("issue");
    let (_, mut file) = registry.open(&fx.ws, &issued.handle).expect("open");
    let mut text = String::new();
    file.read_to_string(&mut text).unwrap();
    assert_eq!(text, "inside\n");
    drop(file);

    // Swap the folder for a link to a folder outside that holds the same name.
    let outside = fx.temp.path().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("f.txt"), "secret\n").unwrap();
    std::fs::remove_dir_all(fx.root.join("dir")).unwrap();
    if !dir_link(&fx.root.join("dir"), &outside) {
        eprintln!("skipped: could not create a directory link");
        return;
    }
    let err = registry
        .open(&fx.ws, &issued.handle)
        .expect_err("swapped handle");
    assert_eq!(err.code, "path_outside_workspace");
}

#[test]
fn directories_and_git_internals_are_not_opened() {
    let fx = Fixture::repo();
    fx.write("dir/f.txt", "x\n");
    assert!(fx.ws.open_verified(&rel("dir")).is_err());
    // `.git` components never parse as a RelPath at all.
    assert!(RelPath::parse(".git/config").is_err());
}
