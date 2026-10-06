#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::io::Cursor;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use kalcode_updater::live::{
    ActiveUi, LiveDescriptor, LiveStore, ShellContract, StartupRecovery, StartupUi, UiArtifact,
    UpdateClass, classify, encode_bundle, expanded_len, unpack_bundle, verify_envelope,
    verify_unpacked,
};
use kalcode_updater::{UpdateChannel, UpdateTarget};
use minisign::{KeyPair, sign};
use sha2::{Digest, Sha256};

const NATIVE_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NATIVE_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";

fn sha(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn ui_files() -> Vec<(&'static str, &'static [u8])> {
    vec![
        (
            "index.html",
            b"<!doctype html><script type=\"module\" src=\"/assets/app.js\"></script>".as_slice(),
        ),
        ("assets/app.js", b"console.log('new ui')".as_slice()),
        ("assets/app.css", b"body{color:red}".as_slice()),
    ]
}

fn descriptor_for(version: &str, native: &str, bundle: &[u8], files: u32) -> LiveDescriptor {
    LiveDescriptor {
        schema_version: 1,
        version: version.to_owned(),
        channel: UpdateChannel::Stable,
        target: UpdateTarget::WindowsX86_64,
        commit: COMMIT.to_owned(),
        shell: ShellContract {
            native_fingerprint: native.to_owned(),
        },
        ui: UiArtifact {
            file: "KalCode_ui.kui".to_owned(),
            size: bundle.len() as u64,
            sha256: sha(bundle),
            expanded_size: expanded_len(bundle),
            files,
        },
    }
}

/// A signed envelope as the release tooling publishes it, and the matching public key.
fn envelope(descriptor: &LiveDescriptor, trusted_comment: &str) -> (Vec<u8>, String) {
    let KeyPair { pk, sk } = KeyPair::generate_unencrypted_keypair().unwrap();
    let bytes = serde_json::to_vec(descriptor).unwrap();
    let signature = sign(
        Some(&pk),
        &sk,
        Cursor::new(&bytes),
        Some(trusted_comment),
        None,
    )
    .unwrap()
    .into_string();
    let public_key = STANDARD.encode(pk.to_box().unwrap().into_string());
    let envelope = serde_json::json!({
        "schemaVersion": 1,
        "descriptor": STANDARD.encode(&bytes),
        "signature": STANDARD.encode(signature),
    });
    (serde_json::to_vec(&envelope).unwrap(), public_key)
}

fn comment(version: &str, file: &str) -> String {
    format!(
        "timestamp:1791244071\tfile:{file}\tversion:{version}\ttarget:windows-x86_64\tchannel:stable"
    )
}

#[test]
fn a_signed_descriptor_is_accepted_only_for_its_version_target_and_channel() {
    let bundle = encode_bundle(&ui_files());
    let descriptor = descriptor_for("0.1.9+1900", NATIVE_A, &bundle, 3);
    let (raw, key) = envelope(
        &descriptor,
        &comment("0.1.9+1900", "KalCode_0.1.9_build1900_x64-live.json"),
    );

    let verified = verify_envelope(
        &raw,
        &key,
        "0.1.9+1900",
        UpdateTarget::WindowsX86_64,
        UpdateChannel::Stable,
    )
    .expect("valid envelope");
    assert_eq!(verified, descriptor);

    // The canonical feed announced another build: a replayed older descriptor is refused.
    assert!(
        verify_envelope(
            &raw,
            &key,
            "0.1.9+1901",
            UpdateTarget::WindowsX86_64,
            UpdateChannel::Stable
        )
        .is_err()
    );
    assert!(
        verify_envelope(
            &raw,
            &key,
            "0.1.9+1900",
            UpdateTarget::DarwinAarch64,
            UpdateChannel::Stable
        )
        .is_err()
    );
    assert!(
        verify_envelope(
            &raw,
            &key,
            "0.1.9+1900",
            UpdateTarget::WindowsX86_64,
            UpdateChannel::Beta
        )
        .is_err()
    );
}

#[test]
fn an_installer_signature_cannot_authorize_a_live_update() {
    let bundle = encode_bundle(&ui_files());
    let descriptor = descriptor_for("0.1.9+1900", NATIVE_A, &bundle, 3);
    let (raw, key) = envelope(
        &descriptor,
        &comment("0.1.9+1900", "KalCode_0.1.9_build1900_x64-setup.exe"),
    );
    let error = verify_envelope(
        &raw,
        &key,
        "0.1.9+1900",
        UpdateTarget::WindowsX86_64,
        UpdateChannel::Stable,
    )
    .unwrap_err();
    assert_eq!(error.code(), "live_signature_purpose_mismatch");
}

#[test]
fn a_tampered_descriptor_or_another_key_is_rejected() {
    let bundle = encode_bundle(&ui_files());
    let descriptor = descriptor_for("0.1.9+1900", NATIVE_A, &bundle, 3);
    let (raw, key) = envelope(&descriptor, &comment("0.1.9+1900", "x-live.json"));

    let mut envelope: serde_json::Value = serde_json::from_slice(&raw).unwrap();
    let mut forged = descriptor.clone();
    forged.shell.native_fingerprint = NATIVE_B.to_owned();
    envelope["descriptor"] = STANDARD.encode(serde_json::to_vec(&forged).unwrap()).into();
    let forged = serde_json::to_vec(&envelope).unwrap();
    assert!(
        verify_envelope(
            &forged,
            &key,
            "0.1.9+1900",
            UpdateTarget::WindowsX86_64,
            UpdateChannel::Stable
        )
        .is_err()
    );

    let (_, other_key) = self::envelope(&descriptor, &comment("0.1.9+1900", "x-live.json"));
    assert!(
        verify_envelope(
            &raw,
            &other_key,
            "0.1.9+1900",
            UpdateTarget::WindowsX86_64,
            UpdateChannel::Stable
        )
        .is_err()
    );
}

#[test]
fn only_an_identical_native_shell_takes_a_live_ui_update() {
    let bundle = encode_bundle(&ui_files());
    let descriptor = descriptor_for("0.1.9+1900", NATIVE_A, &bundle, 3);
    assert_eq!(classify(Some(NATIVE_A), &descriptor), UpdateClass::Ui);
    assert_eq!(classify(Some(NATIVE_B), &descriptor), UpdateClass::Core);
    // Development builds carry no fingerprint and never live-apply.
    assert_eq!(classify(None, &descriptor), UpdateClass::Core);
    assert_eq!(classify(Some("dev"), &descriptor), UpdateClass::Core);
}

#[test]
fn a_bundle_unpacks_only_when_every_byte_matches_the_signed_descriptor() {
    let dir = tempfile::tempdir().unwrap();
    let bundle = encode_bundle(&ui_files());
    let descriptor = descriptor_for("0.1.9+1900", NATIVE_A, &bundle, 3);

    let mut tampered = bundle.clone();
    let last = tampered.len() - 9;
    tampered[last] ^= 0xff;
    let error = unpack_bundle(&tampered, &descriptor, &dir.path().join("t")).unwrap_err();
    assert_eq!(error.code(), "live_bundle_integrity");
    assert!(
        !dir.path().join("t").exists(),
        "nothing is written for a rejected bundle"
    );

    let truncated = &bundle[..bundle.len() / 2];
    assert!(unpack_bundle(truncated, &descriptor, &dir.path().join("u")).is_err());

    let manifest = unpack_bundle(&bundle, &descriptor, &dir.path().join("ok")).unwrap();
    assert_eq!(manifest.files.len(), 3);
    assert_eq!(
        std::fs::read(dir.path().join("ok").join("assets").join("app.js")).unwrap(),
        b"console.log('new ui')"
    );
    verify_unpacked(&dir.path().join("ok")).unwrap();

    // A file changed on disk after activation is caught before it is served again.
    std::fs::write(
        dir.path().join("ok").join("assets").join("app.js"),
        b"evil()",
    )
    .unwrap();
    assert!(verify_unpacked(&dir.path().join("ok")).is_err());
}

#[test]
fn bundle_paths_cannot_escape_their_directory() {
    let dir = tempfile::tempdir().unwrap();
    for bad in [
        "../evil.js",
        "/abs.js",
        "a/../../b.js",
        "a\\b.js",
        "kalcode-ui.json",
    ] {
        let files: Vec<(&str, &[u8])> =
            vec![("index.html", b"x".as_slice()), (bad, b"y".as_slice())];
        let bundle = encode_bundle(&files);
        let descriptor = descriptor_for("0.1.9+1900", NATIVE_A, &bundle, 2);
        assert!(
            unpack_bundle(&bundle, &descriptor, &dir.path().join("b")).is_err(),
            "{bad}"
        );
        assert!(!dir.path().join("b").exists());
    }
    // A bundle must carry its entry page.
    let files: Vec<(&str, &[u8])> = vec![("app.js", b"x".as_slice())];
    let bundle = encode_bundle(&files);
    let descriptor = descriptor_for("0.1.9+1900", NATIVE_A, &bundle, 1);
    assert!(unpack_bundle(&bundle, &descriptor, &dir.path().join("c")).is_err());
}

fn staged(store: &LiveStore, version: &str, native: &str, marker: &'static [u8]) -> ActiveUi {
    let files: Vec<(&str, &[u8])> = vec![("index.html", marker)];
    let bundle = encode_bundle(&files);
    let descriptor = descriptor_for(version, native, &bundle, 1);
    let dir = LiveStore::staging_dir_name(&descriptor);
    let manifest = unpack_bundle(&bundle, &descriptor, &store.bundle_dir(&dir)).unwrap();
    ActiveUi {
        version: version.to_owned(),
        dir,
        bundle_sha256: manifest.bundle_sha256,
        native_fingerprint: native.to_owned(),
        unhealthy_boots: 0,
        healthy: false,
    }
}

fn served(store: &LiveStore) -> Option<String> {
    match store.startup(Some(NATIVE_A), "0.1.9+1873").0 {
        StartupUi::Embedded => None,
        StartupUi::Live(ui, _) => Some(ui.version),
    }
}

#[test]
fn an_activated_ui_survives_restart_once_healthy_and_older_bundles_are_cleaned() {
    let root = tempfile::tempdir().unwrap();
    let store = LiveStore::new(root.path());
    assert_eq!(
        served(&store),
        None,
        "no live UI yet: the embedded UI is served"
    );

    let first = staged(&store, "0.1.9+1880", NATIVE_A, b"first");
    store.activate(first.clone()).unwrap();
    assert!(store.mark_healthy(&first.bundle_sha256).unwrap());
    assert_eq!(served(&store).as_deref(), Some("0.1.9+1880"));
    store.mark_healthy(&first.bundle_sha256).unwrap();

    let second = staged(&store, "0.1.9+1890", NATIVE_A, b"second");
    store.activate(second.clone()).unwrap();
    store.mark_healthy(&second.bundle_sha256).unwrap();
    let third = staged(&store, "0.1.9+1895", NATIVE_A, b"third");
    store.activate(third.clone()).unwrap();
    store.mark_healthy(&third.bundle_sha256).unwrap();

    // Only the current UI and one healthy rollback target stay on disk.
    let kept: Vec<String> = std::fs::read_dir(store.ui_root())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    assert_eq!(kept.len(), 2, "{kept:?}");
    assert!(kept.contains(&third.dir) && kept.contains(&second.dir));
}

#[test]
fn a_ui_that_never_reports_ready_rolls_back_without_a_crash_loop() {
    let root = tempfile::tempdir().unwrap();
    let store = LiveStore::new(root.path());
    let good = staged(&store, "0.1.9+1880", NATIVE_A, b"good");
    store.activate(good.clone()).unwrap();
    store.mark_healthy(&good.bundle_sha256).unwrap();

    let broken = staged(&store, "0.1.9+1890", NATIVE_A, b"broken");
    store.activate(broken.clone()).unwrap();
    // The live reload counted one boot; it never reported ready. One more start is allowed...
    assert_eq!(served(&store).as_deref(), Some("0.1.9+1890"));
    // ...then the next start rejects it and goes back to the last healthy UI.
    let (ui, recovery) = store.startup(Some(NATIVE_A), "0.1.9+1873");
    assert_eq!(recovery, StartupRecovery::RolledBack);
    assert!(matches!(ui, StartupUi::Live(ref ui, _) if ui.version == "0.1.9+1880"));
    assert!(
        store.is_rejected(&broken.bundle_sha256),
        "a rejected bundle is never activated again"
    );
}

#[test]
fn an_in_session_failure_rolls_back_to_the_previous_ui() {
    let root = tempfile::tempdir().unwrap();
    let store = LiveStore::new(root.path());
    let good = staged(&store, "0.1.9+1880", NATIVE_A, b"good");
    store.activate(good.clone()).unwrap();
    store.mark_healthy(&good.bundle_sha256).unwrap();
    let broken = staged(&store, "0.1.9+1890", NATIVE_A, b"broken");
    store.activate(broken.clone()).unwrap();

    let after = store.roll_back().unwrap();
    assert_eq!(after.map(|ui| ui.version).as_deref(), Some("0.1.9+1880"));
    assert!(store.is_rejected(&broken.bundle_sha256));

    // With nothing healthy behind it, rollback returns to the embedded UI.
    let empty = tempfile::tempdir().unwrap();
    let store = LiveStore::new(empty.path());
    let only = staged(&store, "0.1.9+1890", NATIVE_A, b"only");
    store.activate(only).unwrap();
    assert_eq!(store.roll_back().unwrap(), None);
    assert_eq!(served(&store), None);
}

#[test]
fn an_installed_shell_supersedes_live_uis_built_for_the_old_one() {
    let root = tempfile::tempdir().unwrap();
    let store = LiveStore::new(root.path());
    let ui = staged(&store, "0.1.9+1880", NATIVE_A, b"live");
    store.activate(ui.clone()).unwrap();
    store.mark_healthy(&ui.bundle_sha256).unwrap();

    // The installer applied a new native build: its fingerprint differs.
    let (chosen, recovery) = store.startup(Some(NATIVE_B), "0.1.9+1900");
    assert_eq!(chosen, StartupUi::Embedded);
    assert_eq!(recovery, StartupRecovery::Superseded);
    assert_eq!(store.current(), None);

    // Or the installer applied the very build the live UI came from.
    let ui = staged(&store, "0.1.9+1880", NATIVE_A, b"live2");
    store.activate(ui.clone()).unwrap();
    let (chosen, _) = store.startup(Some(NATIVE_A), "0.1.9+1880");
    assert_eq!(chosen, StartupUi::Embedded, "the shell's own UI is as new");
    assert!(
        std::fs::read_dir(store.ui_root()).unwrap().next().is_none(),
        "bundles are cleaned"
    );
}

#[test]
fn a_damaged_bundle_on_disk_falls_back_to_the_embedded_ui() {
    let root = tempfile::tempdir().unwrap();
    let store = LiveStore::new(root.path());
    let ui = staged(&store, "0.1.9+1880", NATIVE_A, b"live");
    store.activate(ui.clone()).unwrap();
    store.mark_healthy(&ui.bundle_sha256).unwrap();
    std::fs::write(store.bundle_dir(&ui.dir).join("index.html"), b"tampered").unwrap();
    let (chosen, recovery) = store.startup(Some(NATIVE_A), "0.1.9+1873");
    assert_eq!(chosen, StartupUi::Embedded);
    assert_eq!(recovery, StartupRecovery::Damaged);
}

#[test]
fn interrupted_staging_is_removed_at_startup() {
    let root = tempfile::tempdir().unwrap();
    let store = LiveStore::new(root.path());
    std::fs::create_dir_all(store.ui_root().join("0.1.9_b1890-half")).unwrap();
    std::fs::write(
        store.ui_root().join("0.1.9_b1890-half").join("index.html"),
        b"x",
    )
    .unwrap();
    let _ = store.startup(Some(NATIVE_A), "0.1.9+1873");
    assert!(!store.ui_root().join("0.1.9_b1890-half").exists());
}

#[test]
fn a_damaged_state_file_is_treated_as_no_live_ui() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("active.json"), b"{not json").unwrap();
    let store = LiveStore::new(root.path());
    assert_eq!(served(&store), None);
}

/// The release tooling (`tooling/release/live-update.mjs`) packs bundles in Node; this proves the
/// client reads exactly that format.
#[test]
fn a_bundle_packed_by_the_release_tooling_unpacks_in_the_client() {
    let bundle = include_bytes!("fixtures/node-ui.kui");
    let meta: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/node-ui.json")).unwrap();
    let descriptor = LiveDescriptor {
        ui: UiArtifact {
            file: "KalCode_ui.kui".to_owned(),
            size: meta["size"].as_u64().unwrap(),
            sha256: meta["sha256"].as_str().unwrap().to_owned(),
            expanded_size: meta["expandedSize"].as_u64().unwrap(),
            files: u32::try_from(meta["files"].as_u64().unwrap()).unwrap(),
        },
        ..descriptor_for("0.1.9+1900", NATIVE_A, bundle, 3)
    };
    let dir = tempfile::tempdir().unwrap();
    let manifest = unpack_bundle(bundle, &descriptor, &dir.path().join("ui")).unwrap();
    let paths: Vec<&str> = manifest
        .files
        .iter()
        .map(|file| file.path.as_str())
        .collect();
    assert_eq!(
        paths,
        ["assets/font@2x.woff2", "assets/index-AbC1.js", "index.html"]
    );
    assert_eq!(
        std::fs::read(dir.path().join("ui").join("assets").join("index-AbC1.js")).unwrap(),
        b"console.log(\"node bundle\")"
    );
}
