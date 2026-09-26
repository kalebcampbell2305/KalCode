use std::str::FromStr;

use kalcode_updater::{
    ArtifactFormat, Candidate, FeedMetadata, UpdateChannel, UpdateError, UpdateMachine,
    UpdatePhase, UpdateTarget, validate_candidate, validate_candidate_for_target,
    validate_retained_candidate, verify_download,
};
use serde_json::json;
use sha2::{Digest, Sha256};

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[test]
fn retained_rollback_candidate_must_be_the_exact_stable_version() {
    let bytes = b"current signed installer";
    let url = "https://kalcoded.com/releases/updater/stable/0.1.5/current.zip";
    let retained =
        validate_retained_candidate("0.1.5", "0.1.5", url, &feed("stable", bytes)).unwrap();
    assert_eq!(retained.version, "0.1.5");
    assert_eq!(retained.metadata.sha256, digest(bytes));
    assert_eq!(
        validate_retained_candidate("0.1.5", "0.1.4", url, &feed("stable", bytes))
            .unwrap_err()
            .code(),
        "rollback_version_mismatch"
    );
    assert_eq!(
        validate_retained_candidate("0.1.5", "0.1.5-beta.1", url, &feed("stable", bytes),)
            .unwrap_err()
            .code(),
        "rollback_not_stable"
    );
}

fn feed(channel: &str, bytes: &[u8]) -> serde_json::Value {
    json!({
        "kalcode": {
            "schemaVersion": 1,
            "channel": channel,
            "size": bytes.len(),
            "sha256": digest(bytes),
            "commit": "0123456789abcdef0123456789abcdef01234567"
        }
    })
}

fn feed_v2(windows: &[u8], macos: &[u8]) -> serde_json::Value {
    json!({
        "kalcode": {
            "schemaVersion": 2,
            "channel": "stable",
            "commit": "0123456789abcdef0123456789abcdef01234567",
            "artifacts": {
                "windows-x86_64": {
                    "target": "windows-x86_64",
                    "format": "nsis",
                    "size": windows.len(),
                    "sha256": digest(windows)
                },
                "darwin-aarch64": {
                    "target": "darwin-aarch64",
                    "format": "dmg",
                    "size": macos.len(),
                    "sha256": digest(macos)
                }
            }
        }
    })
}

#[test]
fn schema_v2_selects_only_the_explicit_target_artifact() {
    let windows = b"windows installer";
    let macos = b"macos disk image";
    let manifest = feed_v2(windows, macos);

    let windows_candidate = validate_candidate_for_target(
        UpdateTarget::WindowsX86_64,
        UpdateChannel::Stable,
        "1.0.0",
        "1.0.1",
        "https://kalcoded.com/releases/updater/stable/1.0.1/windows.exe",
        &manifest,
    )
    .unwrap();
    assert_eq!(
        windows_candidate.metadata.target,
        UpdateTarget::WindowsX86_64
    );
    assert_eq!(windows_candidate.metadata.format, ArtifactFormat::Nsis);
    assert_eq!(windows_candidate.metadata.channel, UpdateChannel::Stable);
    assert_eq!(windows_candidate.metadata.sha256, digest(windows));

    let mac_candidate = validate_candidate_for_target(
        UpdateTarget::DarwinAarch64,
        UpdateChannel::Stable,
        "1.0.0",
        "1.0.1",
        "https://kalcoded.com/releases/updater/stable/1.0.1/macos.dmg",
        &manifest,
    )
    .unwrap();
    assert_eq!(mac_candidate.metadata.target, UpdateTarget::DarwinAarch64);
    assert_eq!(mac_candidate.metadata.format, ArtifactFormat::Dmg);
    assert_eq!(mac_candidate.metadata.channel, UpdateChannel::Stable);
    assert_eq!(mac_candidate.metadata.sha256, digest(macos));
}

#[test]
fn target_selection_never_falls_back_to_another_platform() {
    let windows = b"windows installer";
    let macos = b"macos disk image";
    let mut manifest = feed_v2(windows, macos);
    manifest["kalcode"]["artifacts"]
        .as_object_mut()
        .unwrap()
        .remove("darwin-aarch64");

    let error = validate_candidate_for_target(
        UpdateTarget::DarwinAarch64,
        UpdateChannel::Stable,
        "1.0.0",
        "1.0.1",
        "https://kalcoded.com/releases/updater/stable/1.0.1/windows.exe",
        &manifest,
    )
    .unwrap_err();
    assert_eq!(error.code(), "update_target_unavailable");

    let mut swapped = feed_v2(windows, macos);
    swapped["kalcode"]["artifacts"]["darwin-aarch64"]["target"] = json!("windows-x86_64");
    let error = validate_candidate_for_target(
        UpdateTarget::DarwinAarch64,
        UpdateChannel::Stable,
        "1.0.0",
        "1.0.1",
        "https://kalcoded.com/releases/updater/stable/1.0.1/macos.dmg",
        &swapped,
    )
    .unwrap_err();
    assert_eq!(error.code(), "update_target_mismatch");
}

#[test]
fn schema_v1_remains_windows_only() {
    let bytes = b"legacy windows updater";
    let legacy = feed("stable", bytes);

    validate_candidate_for_target(
        UpdateTarget::WindowsX86_64,
        UpdateChannel::Stable,
        "1.0.0",
        "1.0.1",
        "https://kalcoded.com/releases/updater/stable/1.0.1/windows.exe",
        &legacy,
    )
    .unwrap();
    let error = validate_candidate_for_target(
        UpdateTarget::DarwinAarch64,
        UpdateChannel::Stable,
        "1.0.0",
        "1.0.1",
        "https://kalcoded.com/releases/updater/stable/1.0.1/windows.exe",
        &legacy,
    )
    .unwrap_err();
    assert_eq!(error.code(), "update_target_mismatch");
}

#[test]
fn channels_are_closed_and_stable_is_the_default() {
    assert_eq!(UpdateChannel::default(), UpdateChannel::Stable);
    assert_eq!(
        UpdateChannel::from_str("stable").unwrap(),
        UpdateChannel::Stable
    );
    assert_eq!(
        UpdateChannel::from_str("beta").unwrap(),
        UpdateChannel::Beta
    );
    assert_eq!(UpdateChannel::from_str("dev").unwrap(), UpdateChannel::Dev);
    assert!(UpdateChannel::from_str("preview").is_err());
    assert_eq!(
        UpdateChannel::Stable.endpoint(),
        "https://kalcoded.com/releases/updater/stable.json"
    );
}

#[test]
fn candidate_requires_exact_channel_https_origin_version_and_metadata() {
    let bytes = b"signed updater bytes";
    let candidate = validate_candidate(
        UpdateChannel::Stable,
        "0.1.5",
        "0.1.6",
        "https://kalcoded.com/releases/updater/0.1.6/KalCode.nsis.zip",
        &feed("stable", bytes),
    )
    .unwrap();
    assert_eq!(candidate.metadata.size, bytes.len() as u64);
    assert_eq!(candidate.metadata.sha256, digest(bytes));

    for (channel, version, url, raw, code) in [
        (
            UpdateChannel::Stable,
            "0.1.6",
            "http://kalcoded.com/releases/updater/a.zip",
            feed("stable", bytes),
            "update_url_not_allowed",
        ),
        (
            UpdateChannel::Stable,
            "0.1.6",
            "https://evil.example/releases/updater/a.zip",
            feed("stable", bytes),
            "update_url_not_allowed",
        ),
        (
            UpdateChannel::Stable,
            "0.1.6-beta.1",
            "https://kalcoded.com/releases/updater/a.zip",
            feed("stable", bytes),
            "prerelease_on_stable",
        ),
        (
            UpdateChannel::Stable,
            "0.1.6",
            "https://kalcoded.com/releases/updater/a.zip",
            feed("beta", bytes),
            "update_channel_mismatch",
        ),
        (
            UpdateChannel::Stable,
            "0.1.5",
            "https://kalcoded.com/releases/updater/a.zip",
            feed("stable", bytes),
            "update_not_newer",
        ),
    ] {
        let error = validate_candidate(channel, "0.1.5", version, url, &raw).unwrap_err();
        assert_eq!(error.code(), code);
    }
}

#[test]
fn malformed_or_oversized_metadata_fails_closed() {
    let base = "https://kalcoded.com/releases/updater/a.zip";
    let malformed =
        json!({"kalcode":{"schemaVersion":1,"channel":"stable","size":4,"sha256":"abc"}});
    assert_eq!(
        validate_candidate(UpdateChannel::Stable, "1.0.0", "1.0.1", base, &malformed)
            .unwrap_err()
            .code(),
        "update_manifest_invalid"
    );
    let huge = json!({
        "kalcode": {
            "schemaVersion": 1,
            "channel": "stable",
            "size": 536_870_913_u64,
            "sha256": "a".repeat(64),
            "commit": "0".repeat(40)
        }
    });
    assert_eq!(
        validate_candidate(UpdateChannel::Stable, "1.0.0", "1.0.1", base, &huge)
            .unwrap_err()
            .code(),
        "update_too_large"
    );
}

#[test]
fn download_must_match_declared_size_and_digest_after_signature_verification() {
    let bytes = b"verified package";
    let metadata = FeedMetadata {
        schema_version: 1,
        channel: UpdateChannel::Stable,
        target: UpdateTarget::WindowsX86_64,
        format: ArtifactFormat::Nsis,
        size: bytes.len() as u64,
        sha256: digest(bytes),
        commit: "0".repeat(40),
    };
    verify_download(bytes, &metadata).unwrap();

    assert_eq!(
        verify_download(b"changed package", &metadata)
            .unwrap_err()
            .code(),
        "update_size_mismatch"
    );
    let wrong = FeedMetadata {
        schema_version: 1,
        channel: UpdateChannel::Stable,
        target: UpdateTarget::WindowsX86_64,
        format: ArtifactFormat::Nsis,
        size: bytes.len() as u64,
        sha256: "a".repeat(64),
        commit: "0".repeat(40),
    };
    assert_eq!(
        verify_download(bytes, &wrong).unwrap_err().code(),
        "update_checksum_mismatch"
    );
}

#[test]
fn state_machine_rejects_overlap_stale_completion_and_install_before_ready() {
    let mut machine = UpdateMachine::new(UpdateChannel::Stable, "0.1.5");
    let first = machine.begin_check().unwrap();
    assert_eq!(machine.status().phase, UpdatePhase::Checking);
    assert_eq!(machine.begin_check().unwrap_err().code(), "update_busy");
    assert_eq!(
        machine.begin_install().unwrap_err().code(),
        "update_not_ready"
    );

    machine.set_channel(UpdateChannel::Beta).unwrap();
    assert_eq!(machine.status().phase, UpdatePhase::Idle);
    assert_eq!(
        machine.fail(first, "late").unwrap_err().code(),
        "stale_update_operation"
    );

    let second = machine.begin_check().unwrap();
    let bytes = b"bytes";
    let candidate = Candidate {
        version: "0.2.0-beta.1".into(),
        notes: Some("Beta".into()),
        metadata: FeedMetadata {
            schema_version: 1,
            channel: UpdateChannel::Beta,
            target: UpdateTarget::WindowsX86_64,
            format: ArtifactFormat::Nsis,
            size: bytes.len() as u64,
            sha256: digest(bytes),
            commit: "1".repeat(40),
        },
    };
    machine.begin_download(second, candidate.clone()).unwrap();
    machine.download_progress(second, 2, Some(5)).unwrap();
    machine.ready(second, candidate.clone()).unwrap();
    assert_eq!(machine.status().phase, UpdatePhase::Ready);
    assert_eq!(machine.begin_install().unwrap(), candidate);
    assert_eq!(machine.status().phase, UpdatePhase::Installing);
    assert_eq!(
        machine.set_channel(UpdateChannel::Dev).unwrap_err().code(),
        "update_busy"
    );
    assert_eq!(machine.cancel().unwrap_err().code(), "update_busy");
}

#[test]
fn error_codes_are_stable_and_never_include_private_content() {
    let error = UpdateError::invalid_manifest("raw response must not be surfaced");
    assert_eq!(error.code(), "update_manifest_invalid");
    assert_eq!(error.to_string(), "The update feed is invalid.");
}
