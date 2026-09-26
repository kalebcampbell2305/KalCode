//! Version-selection contract for the no-network provider test binary.

use std::path::{Path, PathBuf};
use std::process::Command;

const FAKE: &str = env!("CARGO_BIN_EXE_kalcode-fake-provider");

fn copy_as(dir: &Path, name: &str) -> std::io::Result<PathBuf> {
    let path = dir.join(if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    });
    std::fs::copy(FAKE, &path)?;
    Ok(path)
}

fn version(executable: &Path) -> Result<String, Box<dyn std::error::Error>> {
    let output = Command::new(executable).arg("--version").output()?;
    assert!(output.status.success(), "{output:?}");
    Ok(String::from_utf8(output.stdout)?.trim().to_owned())
}

#[test]
fn one_fixture_selects_each_provider_kind_version() -> Result<(), Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir().expect("temp dir");
    std::fs::write(
        dir.path().join("fake-provider.json"),
        r#"{"versions":{"claude":"2.1.282 (Claude Code)","codex":"codex-cli 0.155.1","gemini":"0.61.0"}}"#,
    )
    .expect("config");

    assert_eq!(
        version(&copy_as(dir.path(), "claude")?)?,
        "2.1.282 (Claude Code)"
    );
    assert_eq!(
        version(&copy_as(dir.path(), "codex")?)?,
        "codex-cli 0.155.1"
    );
    assert_eq!(version(&copy_as(dir.path(), "gemini")?)?, "0.61.0");
    Ok(())
}

#[test]
fn scalar_version_keeps_precedence_for_existing_fixtures() -> Result<(), Box<dyn std::error::Error>>
{
    let dir = tempfile::tempdir().expect("temp dir");
    std::fs::write(
        dir.path().join("fake-provider.json"),
        r#"{"version":"fixture-override","versions":{"claude":"map-claude","codex":"map-codex","gemini":"map-gemini"}}"#,
    )
    .expect("config");

    for kind in ["claude", "codex", "gemini"] {
        assert_eq!(version(&copy_as(dir.path(), kind)?)?, "fixture-override");
    }
    Ok(())
}
