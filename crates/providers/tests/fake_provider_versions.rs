//! Version-selection contract for the no-network provider test binary.

use std::path::{Path, PathBuf};
use std::process::Command;

const FAKE: &str = env!("CARGO_BIN_EXE_kalcode-fake-provider");

fn copy_as(dir: &Path, name: &str) -> PathBuf {
    let path = dir.join(if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    });
    std::fs::copy(FAKE, &path).expect("copy fake provider");
    path
}

fn version(executable: &Path) -> String {
    let output = Command::new(executable)
        .arg("--version")
        .output()
        .expect("run fake provider");
    assert!(output.status.success(), "{output:?}");
    String::from_utf8(output.stdout)
        .expect("version is utf-8")
        .trim()
        .to_owned()
}

#[test]
fn one_fixture_selects_each_provider_kind_version() {
    let dir = tempfile::tempdir().expect("temp dir");
    std::fs::write(
        dir.path().join("fake-provider.json"),
        r#"{"versions":{"claude":"2.1.282 (Claude Code)","codex":"codex-cli 0.155.1","gemini":"0.61.0"}}"#,
    )
    .expect("config");

    assert_eq!(
        version(&copy_as(dir.path(), "claude")),
        "2.1.282 (Claude Code)"
    );
    assert_eq!(version(&copy_as(dir.path(), "codex")), "codex-cli 0.155.1");
    assert_eq!(version(&copy_as(dir.path(), "gemini")), "0.61.0");
}

#[test]
fn scalar_version_keeps_precedence_for_existing_fixtures() {
    let dir = tempfile::tempdir().expect("temp dir");
    std::fs::write(
        dir.path().join("fake-provider.json"),
        r#"{"version":"fixture-override","versions":{"claude":"map-claude","codex":"map-codex","gemini":"map-gemini"}}"#,
    )
    .expect("config");

    for kind in ["claude", "codex", "gemini"] {
        assert_eq!(version(&copy_as(dir.path(), kind)), "fixture-override");
    }
}
