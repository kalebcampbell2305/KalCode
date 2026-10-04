//! Read-only smoke against an explicitly supplied official Cursor Agent installation.
#![allow(clippy::expect_used)]

use kalcode_contracts::agent::DetectionState;
use kalcode_providers::{DetectEnv, catalog, cursor, detect::detect};

#[test]
#[ignore = "requires KALCODE_TEST_CURSOR_BIN containing an official Cursor Agent installation"]
fn official_cursor_launcher_detection_and_native_status() {
    let bin = std::env::var_os("KALCODE_TEST_CURSOR_BIN").expect("explicit test installation");
    let profile = tempfile::tempdir().expect("isolated native profile");
    let mut env = DetectEnv::from_process();
    env.vars.retain(|(name, _)| {
        let name = name.to_string_lossy().to_ascii_uppercase();
        !name.starts_with("CURSOR_")
            && ![
                "PATH",
                "HOME",
                "USERPROFILE",
                "XDG_CONFIG_HOME",
                "XDG_DATA_HOME",
                "LOCALAPPDATA",
            ]
            .contains(&name.as_str())
    });
    env.vars.push(("PATH".into(), bin));
    for name in [
        "HOME",
        "USERPROFILE",
        "CURSOR_CONFIG_DIR",
        "CURSOR_DATA_DIR",
        "LOCALAPPDATA",
    ] {
        env.vars.push((name.into(), profile.path().into()));
    }
    let detected = detect(&catalog::cursor_spec(), &env);
    assert_eq!(
        detected.detection.state,
        DetectionState::Installed,
        "{:?}",
        detected.detection.message
    );
    assert!(detected.detection.version.is_some());
    // Do not print account identity or inspect any credentials. The supported command
    // must return its real schema through KalCode's own launcher/process supervisor.
    cursor::auth_status(&env).expect("supported native status schema");
}
