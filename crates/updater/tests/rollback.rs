use std::io::Cursor;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use kalcode_updater::{
    ArtifactFormat, FeedMetadata, MAX_UPDATE_STATE_BYTES, RollbackCache, UpdateChannel,
    UpdateTarget, validate_candidate_for_target, verify_signature_for_metadata,
};
use minisign::{KeyPair, sign};
use sha2::{Digest, Sha256};

#[allow(clippy::unwrap_used)]
fn signed_package(version: &str, bytes: &[u8]) -> (String, String) {
    signed_package_with_comment(version, None, bytes)
}

#[allow(clippy::unwrap_used)]
fn signed_package_with_comment(
    version: &str,
    target: Option<UpdateTarget>,
    bytes: &[u8],
) -> (String, String) {
    let trusted_comment = target.map_or_else(
        || format!("timestamp:1789992000\tversion:{version}"),
        |target| {
            let file = match target {
                UpdateTarget::WindowsX86_64 => "KalCode_0.1.6_x64-setup.exe",
                UpdateTarget::DarwinAarch64 => "KalCode-0.1.6-macOS-arm64.dmg",
            };
            format!(
                "timestamp:1789992000\tfile:{file}\tversion:{version}\ttarget:{target}\tchannel:stable"
            )
        },
    );
    signed_package_with_trusted_comment(&trusted_comment, bytes)
}

#[allow(clippy::unwrap_used)]
fn signed_package_with_trusted_comment(trusted_comment: &str, bytes: &[u8]) -> (String, String) {
    let KeyPair { pk, sk } = KeyPair::generate_unencrypted_keypair().unwrap();
    let signature = sign(
        Some(&pk),
        &sk,
        Cursor::new(bytes),
        Some(trusted_comment),
        None,
    )
    .unwrap()
    .into_string();
    let public_key = pk.to_box().unwrap().into_string();
    (STANDARD.encode(public_key), STANDARD.encode(signature))
}

#[test]
fn schema_v2_signature_is_bound_to_the_exact_target_and_channel() {
    let bytes = b"signed mac disk image";
    let mut metadata = metadata(bytes);
    metadata.schema_version = 2;
    metadata.target = UpdateTarget::DarwinAarch64;
    metadata.format = ArtifactFormat::Dmg;
    let (public_key, mac_signature) =
        signed_package_with_comment("0.1.6", Some(UpdateTarget::DarwinAarch64), bytes);
    verify_signature_for_metadata(bytes, &mac_signature, &public_key, "0.1.6", &metadata).unwrap();

    let (public_key, windows_signature) =
        signed_package_with_comment("0.1.6", Some(UpdateTarget::WindowsX86_64), bytes);
    assert_eq!(
        verify_signature_for_metadata(bytes, &windows_signature, &public_key, "0.1.6", &metadata,)
            .unwrap_err()
            .code(),
        "update_signature_target_mismatch"
    );

    let (public_key, legacy_signature) = signed_package("0.1.6", bytes);
    assert_eq!(
        verify_signature_for_metadata(bytes, &legacy_signature, &public_key, "0.1.6", &metadata,)
            .unwrap_err()
            .code(),
        "update_signature_target_mismatch"
    );

    for malformed in [
        "timestamp:1789992000\tfile:KalCode-0.1.6-macOS-arm64.dmg\ttarget:darwin-aarch64\tversion:0.1.6\tchannel:stable",
        "timestamp:not-a-time\tfile:KalCode-0.1.6-macOS-arm64.dmg\tversion:0.1.6\ttarget:darwin-aarch64\tchannel:stable",
        "timestamp:1789992000\tfile:../KalCode.dmg\tversion:0.1.6\ttarget:darwin-aarch64\tchannel:stable",
    ] {
        let (public_key, signature) = signed_package_with_trusted_comment(malformed, bytes);
        assert_eq!(
            verify_signature_for_metadata(bytes, &signature, &public_key, "0.1.6", &metadata)
                .unwrap_err()
                .code(),
            "update_signature_target_mismatch"
        );
    }

    let dev_comment = "timestamp:1789992000\tfile:KalCode-0.1.6-macOS-arm64.dmg\tversion:0.1.6\ttarget:darwin-aarch64\tchannel:dev";
    let (public_key, dev_signature) = signed_package_with_trusted_comment(dev_comment, bytes);
    assert_eq!(
        verify_signature_for_metadata(bytes, &dev_signature, &public_key, "0.1.6", &metadata)
            .unwrap_err()
            .code(),
        "update_signature_channel_mismatch"
    );
}

#[test]
fn schema_v1_signature_cannot_be_relabelled_to_another_signed_channel_or_target() {
    let bytes = b"signed dev windows installer";
    let feed = serde_json::json!({
        "kalcode": {
            "schemaVersion": 1,
            "channel": "stable",
            "size": bytes.len(),
            "sha256": hex::encode(Sha256::digest(bytes)),
            "commit": "0123456789abcdef0123456789abcdef01234567"
        }
    });
    let candidate = validate_candidate_for_target(
        UpdateTarget::WindowsX86_64,
        UpdateChannel::Stable,
        "0.1.8",
        "0.1.9+3000",
        "https://kalcoded.com/releases/updater/stable/0.1.9/windows.exe",
        &feed,
    )
    .unwrap();
    assert_eq!(candidate.metadata.schema_version, 1);
    assert_eq!(candidate.metadata.channel, UpdateChannel::Stable);

    // A dev build's signature served in a schema-1 feed that claims Stable.
    let dev = "timestamp:1789992000\tfile:KalCode_0.1.9_x64-setup.exe\tversion:0.1.9+3000\ttarget:windows-x86_64\tchannel:dev";
    let (public_key, signature) = signed_package_with_trusted_comment(dev, bytes);
    assert_eq!(
        verify_signature_for_metadata(
            bytes,
            &signature,
            &public_key,
            "0.1.9+3000",
            &candidate.metadata
        )
        .unwrap_err()
        .code(),
        "update_signature_channel_mismatch"
    );

    let metadata = metadata(bytes);
    for (comment, code) in [
        (
            "timestamp:1789992000\tversion:0.1.6\tchannel:beta",
            "update_signature_channel_mismatch",
        ),
        (
            "timestamp:1789992000\tversion:0.1.6\tchannel:stable\tchannel:dev",
            "update_signature_channel_mismatch",
        ),
        (
            "timestamp:1789992000\tfile:KalCode-0.1.6-macOS-arm64.dmg\tversion:0.1.6\ttarget:darwin-aarch64\tchannel:stable",
            "update_signature_target_mismatch",
        ),
        (
            "timestamp:1789992000\tversion:0.1.6\ttarget:windows-x86_64\ttarget:darwin-aarch64",
            "update_signature_target_mismatch",
        ),
    ] {
        let (public_key, signature) = signed_package_with_trusted_comment(comment, bytes);
        assert_eq!(
            verify_signature_for_metadata(bytes, &signature, &public_key, "0.1.6", &metadata)
                .unwrap_err()
                .code(),
            code,
            "{comment}"
        );
    }

    // Matching signed bindings and older signatures without them keep working.
    let (public_key, signature) =
        signed_package_with_comment("0.1.6", Some(UpdateTarget::WindowsX86_64), bytes);
    verify_signature_for_metadata(bytes, &signature, &public_key, "0.1.6", &metadata).unwrap();
    let (public_key, signature) = signed_package("0.1.6", bytes);
    verify_signature_for_metadata(bytes, &signature, &public_key, "0.1.6", &metadata).unwrap();
    let mut dev_metadata = metadata.clone();
    dev_metadata.channel = UpdateChannel::Dev;
    let (public_key, signature) = signed_package_with_trusted_comment(
        "timestamp:1789992000\tversion:0.1.6\ttarget:windows-x86_64\tchannel:dev",
        bytes,
    );
    verify_signature_for_metadata(bytes, &signature, &public_key, "0.1.6", &dev_metadata).unwrap();
}

#[test]
fn schema_v2_rollback_receipt_preserves_and_rechecks_channel_binding() {
    let temp = tempfile::tempdir().unwrap();
    let bytes = b"signed stable mac disk image";
    let mut metadata = metadata(bytes);
    metadata.schema_version = 2;
    metadata.target = UpdateTarget::DarwinAarch64;
    metadata.format = ArtifactFormat::Dmg;
    let (public_key, signature) =
        signed_package_with_comment("0.1.6", Some(UpdateTarget::DarwinAarch64), bytes);
    let cache = RollbackCache::new(temp.path());
    let receipt = cache
        .store_verified("0.1.6", bytes, &metadata, &signature, &public_key)
        .unwrap();
    assert_eq!(receipt.target(), UpdateTarget::DarwinAarch64);
    assert_eq!(receipt.channel(), UpdateChannel::Stable);
    assert_eq!(
        cache
            .load_verified(&public_key)
            .unwrap()
            .unwrap()
            .receipt()
            .channel(),
        UpdateChannel::Stable
    );

    let receipt_path = temp.path().join("rollback-receipt.json");
    let mut tampered: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&receipt_path).unwrap()).unwrap();
    tampered["channel"] = serde_json::json!("dev");
    std::fs::write(&receipt_path, serde_json::to_vec(&tampered).unwrap()).unwrap();
    assert_eq!(
        cache.load_verified(&public_key).unwrap_err().code(),
        "rollback_cache_invalid"
    );
}

fn metadata(bytes: &[u8]) -> FeedMetadata {
    FeedMetadata {
        schema_version: 1,
        channel: UpdateChannel::Stable,
        target: UpdateTarget::WindowsX86_64,
        format: ArtifactFormat::Nsis,
        size: bytes.len() as u64,
        sha256: hex::encode(Sha256::digest(bytes)),
        commit: "0123456789abcdef0123456789abcdef01234567".into(),
    }
}

#[test]
fn rollback_cache_reverifies_exact_version_signature_and_digest_after_restart() {
    let temp = tempfile::tempdir().unwrap();
    let bytes = b"signed stable installer";
    let (public_key, signature) = signed_package("0.1.5", bytes);
    let cache = RollbackCache::new(temp.path());

    let receipt = cache
        .store_verified("0.1.5", bytes, &metadata(bytes), &signature, &public_key)
        .unwrap();
    assert_eq!(receipt.version, "0.1.5");
    assert_eq!(receipt.size, bytes.len() as u64);

    let reopened = RollbackCache::new(temp.path());
    let artifact = reopened.load_verified(&public_key).unwrap().unwrap();
    assert_eq!(artifact.receipt().version, "0.1.5");
    assert_eq!(std::fs::read(artifact.path()).unwrap(), bytes);
}

#[test]
fn rollback_cache_rejects_bad_signature_version_prerelease_and_tampering() {
    let temp = tempfile::tempdir().unwrap();
    let bytes = b"signed stable installer";
    let meta = metadata(bytes);
    let (public_key, signature) = signed_package("0.1.5", bytes);
    let cache = RollbackCache::new(temp.path());

    assert_eq!(
        cache
            .store_verified("0.1.6", bytes, &meta, &signature, &public_key)
            .unwrap_err()
            .code(),
        "update_signature_version_mismatch"
    );
    assert_eq!(
        cache
            .store_verified("0.1.5-beta.1", bytes, &meta, &signature, &public_key)
            .unwrap_err()
            .code(),
        "rollback_not_stable"
    );
    cache
        .store_verified("0.1.5", bytes, &meta, &signature, &public_key)
        .unwrap();
    let retained = cache.load_verified(&public_key).unwrap().unwrap();
    std::fs::write(retained.path(), b"tampered").unwrap();
    assert_eq!(
        cache.load_verified(&public_key).unwrap_err().code(),
        "rollback_cache_invalid"
    );
}

#[test]
fn rollback_cache_is_empty_until_a_verified_stable_installer_is_retained() {
    let temp = tempfile::tempdir().unwrap();
    let cache = RollbackCache::new(temp.path());
    assert!(cache.load_verified("invalid-but-unused").unwrap().is_none());
}

#[test]
fn oversized_rollback_receipt_fails_closed_without_loading_it() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::File::create(temp.path().join("rollback-receipt.json"))
        .unwrap()
        .set_len(MAX_UPDATE_STATE_BYTES + 1)
        .unwrap();

    let error = RollbackCache::new(temp.path())
        .load_verified("unused")
        .unwrap_err();
    assert_eq!(error.code(), "rollback_cache_invalid");
}
