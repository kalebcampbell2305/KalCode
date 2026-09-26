//! Shared helpers: temporary repositories driven by the real `git` (setup commands run *without*
//! KalCode's hardening, like a user would), and a hardened `Git` for the code under test.
#![allow(dead_code, clippy::expect_used, clippy::unwrap_used)]

use std::path::{Path, PathBuf};
use std::process::Command;

use kalcode_contracts::ids::new_id;
use kalcode_git::runner::find_on_path;
use kalcode_git::{Git, WorkspaceRoot};
use tempfile::TempDir;

pub struct Fixture {
    /// Keeps everything alive; removed on drop.
    pub temp: TempDir,
    /// KalCode's data folder for this test.
    pub data: PathBuf,
    /// The workspace folder (a repository unless created with `plain_folder`).
    pub root: PathBuf,
    pub git: Git,
    pub ws: WorkspaceRoot,
}

pub fn git_exe() -> PathBuf {
    find_on_path(&std::env::var_os("PATH").unwrap_or_default()).expect("git on PATH for tests")
}

impl Fixture {
    /// A fresh repository with one commit (`README.md`).
    pub fn repo() -> Self {
        let fixture = Self::plain_folder();
        init_repo(&fixture.root);
        fixture.write("README.md", "hello\n");
        fixture.commit_all("initial");
        fixture
    }

    /// A folder that is not a repository.
    pub fn plain_folder() -> Self {
        let temp = tempfile::tempdir().expect("tempdir");
        let data = temp.path().join("data");
        let root = temp.path().join("ws");
        std::fs::create_dir_all(&root).expect("mkdir ws");
        std::fs::create_dir_all(&data).expect("mkdir data");
        let git = Git::with_executable(git_exe(), &data.join("git").join("no-hooks")).expect("git");
        let ws = WorkspaceRoot::new(&new_id(), &root).expect("workspace");
        Self {
            temp,
            data,
            root,
            git,
            ws,
        }
    }

    pub fn path(&self, rel: &str) -> PathBuf {
        self.root.join(rel)
    }

    pub fn write(&self, rel: &str, content: &str) {
        self.write_bytes(rel, content.as_bytes());
    }

    pub fn write_bytes(&self, rel: &str, content: &[u8]) {
        let path = self.path(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("mkdir");
        }
        std::fs::write(path, content).expect("write");
    }

    pub fn read(&self, rel: &str) -> Vec<u8> {
        std::fs::read(self.path(rel)).expect("read")
    }

    pub fn exists(&self, rel: &str) -> bool {
        std::fs::symlink_metadata(self.path(rel)).is_ok()
    }

    /// Plain git (no KalCode hardening) in the workspace.
    pub fn git_plain(&self, args: &[&str]) -> String {
        run_plain(&self.root, args)
    }

    pub fn commit_all(&self, message: &str) {
        self.git_plain(&["add", "-A"]);
        self.git_plain(&["commit", "-q", "--no-verify", "-m", message]);
    }

    /// Marker path in a form both Windows and Git's `sh` accept.
    pub fn marker(&self, name: &str) -> (PathBuf, String) {
        let path = self.temp.path().join(format!("marker-{name}"));
        let text = path.to_string_lossy().replace('\\', "/");
        (path, text)
    }
}

pub fn init_repo(path: &Path) {
    run_plain(path, &["init", "-q", "-b", "main"]);
    for (key, value) in [
        ("user.name", "Test User"),
        ("user.email", "test@example.invalid"),
        ("commit.gpgSign", "false"),
        ("core.autocrlf", "false"),
    ] {
        run_plain(path, &["config", key, value]);
    }
}

/// Runs git the way a user would (inherits the environment, no hardening). Panics on failure.
pub fn run_plain(dir: &Path, args: &[&str]) -> String {
    let mut command = Command::new(git_exe());
    hide_test_process(&mut command);
    let out = command
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .expect("spawn git");
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// Like [`run_plain`] but returns success instead of panicking.
pub fn try_plain(dir: &Path, args: &[&str]) -> bool {
    let mut command = Command::new(git_exe());
    hide_test_process(&mut command);
    command
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .is_ok_and(|o| o.status.success())
}

#[cfg(windows)]
pub fn hide_test_process(command: &mut Command) {
    use std::os::windows::process::CommandExt as _;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub fn hide_test_process(_command: &mut Command) {}

/// Writes an executable hook script that creates `marker` when it runs.
pub fn install_hook(hooks_dir: &Path, name: &str, marker: &str) {
    std::fs::create_dir_all(hooks_dir).expect("hooks dir");
    let path = hooks_dir.join(name);
    std::fs::write(
        &path,
        format!("#!/bin/sh\necho ran > \"{marker}\"\nexit 0\n"),
    )
    .expect("hook");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    }
}
