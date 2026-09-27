//! Version-selection contract for the no-network provider test binary.

use std::path::{Path, PathBuf};
use std::process::Command;

const FAKE: &str = env!("CARGO_BIN_EXE_kalcode-fake-provider");

fn fixture_dir() -> std::io::Result<tempfile::TempDir> {
    if cfg!(windows) {
        return tempfile::tempdir();
    }
    let parent = Path::new(FAKE).parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "fake provider executable has no parent",
        )
    })?;
    tempfile::Builder::new()
        .prefix("kalcode-fake-provider-versions-")
        .tempdir_in(parent)
}

fn publish_as(dir: &Path, name: &str) -> std::io::Result<PathBuf> {
    let path = dir.join(if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    });
    if cfg!(windows) {
        std::fs::copy(FAKE, &path).map_err(|error| {
            std::io::Error::new(
                error.kind(),
                format!("copy fake provider alias {name}: {error}"),
            )
        })?;
    } else {
        std::fs::hard_link(FAKE, &path).map_err(|error| {
            std::io::Error::new(
                error.kind(),
                format!("link fake provider alias {name}: {error}"),
            )
        })?;
    }
    Ok(path)
}

fn version(executable: &Path) -> Result<String, Box<dyn std::error::Error>> {
    let output = Command::new(executable)
        .arg("--version")
        .output()
        .map_err(|error| {
            std::io::Error::new(error.kind(), format!("launch fake provider alias: {error}"))
        })?;
    assert!(output.status.success(), "{output:?}");
    Ok(String::from_utf8(output.stdout)?.trim().to_owned())
}

#[test]
fn one_fixture_selects_each_provider_kind_version() -> Result<(), Box<dyn std::error::Error>> {
    let dir = fixture_dir().expect("temp dir");
    std::fs::write(
        dir.path().join("fake-provider.json"),
        r#"{"versions":{"claude":"2.1.282 (Claude Code)","codex":"codex-cli 0.155.1","gemini":"0.61.0"}}"#,
    )
    .expect("config");

    assert_eq!(
        version(&publish_as(dir.path(), "claude")?)?,
        "2.1.282 (Claude Code)"
    );
    assert_eq!(
        version(&publish_as(dir.path(), "codex")?)?,
        "codex-cli 0.155.1"
    );
    assert_eq!(version(&publish_as(dir.path(), "gemini")?)?, "0.61.0");
    Ok(())
}

#[test]
fn scalar_version_keeps_precedence_for_existing_fixtures() -> Result<(), Box<dyn std::error::Error>>
{
    let dir = fixture_dir().expect("temp dir");
    std::fs::write(
        dir.path().join("fake-provider.json"),
        r#"{"version":"fixture-override","versions":{"claude":"map-claude","codex":"map-codex","gemini":"map-gemini"}}"#,
    )
    .expect("config");

    for kind in ["claude", "codex", "gemini"] {
        assert_eq!(version(&publish_as(dir.path(), kind)?)?, "fixture-override");
    }
    Ok(())
}

#[cfg(target_os = "linux")]
#[test]
fn immutable_alias_avoids_write_open_exec_race() -> Result<(), Box<dyn std::error::Error>> {
    let dir = fixture_dir().expect("temp dir");
    std::fs::write(
        dir.path().join("fake-provider.json"),
        r#"{"version":"immutable-alias"}"#,
    )
    .expect("config");

    let write_open = dir.path().join("write-open");
    std::fs::copy(FAKE, &write_open).expect("copy write-open executable");
    let writer = std::fs::OpenOptions::new()
        .write(true)
        .open(&write_open)
        .expect("hold executable open for writing");
    let error = Command::new(&write_open)
        .arg("--version")
        .output()
        .expect_err("Linux must reject a write-open executable");
    assert_eq!(error.kind(), std::io::ErrorKind::ExecutableFileBusy);

    assert_eq!(
        version(&publish_as(dir.path(), "claude")?)?,
        "immutable-alias"
    );
    drop(writer);
    Ok(())
}
