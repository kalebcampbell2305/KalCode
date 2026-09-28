use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signer as _, SigningKey};
use tempfile::TempDir;
use zip::ZipWriter;
use zip::write::SimpleFileOptions;

use super::*;
use crate::component_manifest::TOKEN_TYPE;

const NOW: i64 = 1_790_000_000;
const KEY_ID: &str = "component-2026-1";

#[test]
fn app_data_initialization_preserves_existing_private_layout_and_contents() {
    let temp = TempDir::new().expect("fixture");
    let existing = test_directory(temp.path().join("app-data"));
    for name in ["components", "catalog-cache", "catalog-floor-locks"] {
        let child = existing.create_private_child(name).expect("existing child");
        fs::write(child.path().join("retained"), b"retained authority").expect("retained bytes");
    }
    let initialized = TrustedComponentDirectory::initialize_private_app_data(existing.path())
        .expect("initialize existing private root");
    assert_eq!(initialized.identity, existing.identity);
    assert_eq!(initialized.path(), existing.path());
    existing.verify().expect("existing handle remains valid");
    for name in ["components", "catalog-cache", "catalog-floor-locks"] {
        assert_eq!(
            fs::read(initialized.path().join(name).join("retained")).unwrap(),
            b"retained authority"
        );
    }
    assert!(!initialized.path().join(PRIVATE_COMPONENT_ROOT).exists());
}

#[cfg(unix)]
#[test]
fn app_data_initialization_rejects_unsafe_roots_without_changing_them() {
    use std::os::unix::fs::{PermissionsExt as _, symlink};
    let temp = TempDir::new().expect("fixture");
    let root = temp.path().join("unsafe");
    fs::create_dir(&root).unwrap();
    for mode in [0o775, 0o757, 0o777] {
        fs::set_permissions(&root, fs::Permissions::from_mode(mode)).unwrap();
        assert!(TrustedComponentDirectory::initialize_private_app_data(&root).is_err());
        assert_eq!(
            fs::metadata(&root).unwrap().permissions().mode() & 0o777,
            mode
        );
    }
    fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
    let linked = temp.path().join("linked");
    symlink(&root, &linked).unwrap();
    assert!(TrustedComponentDirectory::initialize_private_app_data(&linked).is_err());
    assert_eq!(
        fs::metadata(&root).unwrap().permissions().mode() & 0o777,
        0o755
    );
}

#[cfg(unix)]
#[test]
fn app_data_initialization_rejects_replaced_anchor_before_permission_change() {
    use std::os::unix::fs::PermissionsExt as _;
    let temp = TempDir::new().expect("fixture");
    let root = temp.path().join("app-data");
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
    let retained = AppDataDirectory::open_existing(&root).unwrap();
    let displaced = temp.path().join("displaced");
    fs::rename(&root, &displaced).unwrap();
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(retained.into_private().is_err());
    for path in [&root, &displaced] {
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }
}

#[test]
fn private_directory_creation_preserves_existing_authority() {
    let temp = TempDir::new().expect("app data fixture");
    let root = TrustedComponentDirectory::create_private_root_under_app_data(temp.path())
        .expect("private root");
    let child = root
        .create_private_child("retained")
        .expect("private child");
    root.verify().expect("retained root");
    child.verify().expect("retained child");
    let reopened = TrustedComponentDirectory::open_existing(child.path()).expect("reopen");
    assert_eq!(child.identity, reopened.identity);
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        let metadata = fs::symlink_metadata(child.path()).expect("child metadata");
        assert_eq!(metadata.mode() & 0o777, 0o700);
        assert_eq!(metadata.uid(), effective_user_id());
    }
}

#[test]
fn retained_directory_rejects_or_prevents_path_replacement() {
    let temp = TempDir::new().expect("fixture");
    let original = temp.path().join("original");
    let directory = test_directory(&original);
    let displaced = temp.path().join("displaced");
    match fs::rename(&original, &displaced) {
        Ok(()) => {
            let replacement = test_directory(&original);
            assert_ne!(directory.identity, replacement.identity);
            assert!(directory.verify().is_err());
            assert!(directory.create_private_child("must-not-exist").is_err());
            assert!(!original.join("must-not-exist").exists());
        }
        Err(error) => {
            // Windows directory anchors deliberately omit FILE_SHARE_DELETE.
            #[cfg(windows)]
            assert!(
                matches!(error.raw_os_error(), Some(5 | 32)),
                "expected access denied or sharing violation, got {error}"
            );
            #[cfg(not(windows))]
            panic!("directory rename fixture failed: {error}");
            #[cfg(windows)]
            directory.verify().expect("original remains retained");
        }
    }
}

#[cfg(unix)]
#[test]
fn private_directory_validation_rejects_permission_changes_without_repairing_them() {
    use std::os::unix::fs::PermissionsExt as _;
    let temp = TempDir::new().expect("fixture");
    let root =
        TrustedComponentDirectory::create_private_root_under_app_data(temp.path()).expect("root");
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o755)).expect("broaden mode");
    assert!(root.verify().is_err());
    assert!(TrustedComponentDirectory::create_private_root_under_app_data(temp.path()).is_err());
    assert_eq!(
        fs::metadata(root.path())
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777,
        0o755
    );
}

#[cfg(unix)]
#[test]
#[allow(unsafe_code)]
fn app_data_rejects_group_write_and_foreign_ownership() {
    use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
    let temp = TempDir::new().expect("fixture");
    fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o775)).expect("group write");
    assert!(TrustedComponentDirectory::create_private_root_under_app_data(temp.path()).is_err());
    assert!(!temp.path().join(PRIVATE_COMPONENT_ROOT).exists());
    let root = fs::symlink_metadata("/").expect("root metadata");
    if root.uid() != effective_user_id() {
        assert!(!safe_app_data_directory(&root));
        assert!(TrustedComponentDirectory::initialize_private_app_data("/").is_err());
    } else {
        use std::os::unix::ffi::OsStrExt as _;
        let foreign = temp.path().join("foreign");
        fs::create_dir(&foreign).expect("foreign fixture");
        fs::set_permissions(&foreign, fs::Permissions::from_mode(0o700)).expect("private mode");
        let path = std::ffi::CString::new(foreign.as_os_str().as_bytes()).expect("fixture path");
        // SAFETY: the C string is live and NUL-terminated. Only this temporary fixture changes
        // ownership, and this branch runs with the root uid that can perform the operation.
        assert_eq!(unsafe { libc::chown(path.as_ptr(), 1, !0) }, 0);
        let metadata = fs::symlink_metadata(&foreign).expect("foreign metadata");
        assert!(!safe_app_data_directory(&metadata));
        assert!(!safe_store_directory(&metadata));
        assert!(TrustedComponentDirectory::initialize_private_app_data(&foreign).is_err());
    }
}

#[cfg(windows)]
#[test]
fn private_directory_rejects_junctions_without_touching_target() {
    use std::os::windows::process::CommandExt as _;
    let temp = TempDir::new().expect("fixture");
    let outside = temp.path().join("outside");
    fs::create_dir(&outside).expect("outside");
    let linked = temp.path().join("junction");
    let output = std::process::Command::new("cmd.exe")
        .args(["/C", "mklink", "/J"])
        .arg(&linked)
        .arg(&outside)
        .creation_flags(0x0800_0000)
        .output()
        .expect("headless junction fixture");
    assert!(output.status.success(), "junction creation failed");
    assert!(TrustedComponentDirectory::open_existing(&linked).is_err());
    assert!(TrustedComponentDirectory::create_private_root_under_app_data(&linked).is_err());
    assert!(
        fs::read_dir(&outside)
            .expect("outside entries")
            .next()
            .is_none()
    );
    fs::remove_dir(&linked).expect("remove junction only");
}

#[test]
fn production_runtime_policy_uses_a_stable_monotonic_component_track() {
    assert_eq!(
        LLAMA_B11146_WINDOWS_CPU_POLICY.component_id,
        "kalvoice.runtime.llama-cpp"
    );
    assert!(
        !LLAMA_B11146_WINDOWS_CPU_POLICY
            .component_id
            .contains("b11146")
    );
}

#[test]
fn host_contract_never_mixes_runtime_and_model_targets() {
    #[cfg(any(
        all(windows, target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64")
    ))]
    {
        let contract = host_local_reasoning_contract().expect("supported host contract");
        assert_eq!(contract.runtime.kind, ComponentKind::Runtime);
        assert_eq!(contract.model.kind, ComponentKind::Model);
        assert_eq!(contract.runtime.component_id, LOCAL_REASONING_RUNTIME_ID);
        assert_eq!(contract.model.component_id, LOCAL_REASONING_MODEL_ID);
        assert_eq!(contract.runtime.platform, contract.model.platform);
        assert_eq!(contract.runtime.arch, contract.model.arch);
        assert_eq!(contract.runtime.runtime_abi, LOCAL_REASONING_RUNTIME_ABI);
        assert_eq!(contract.runtime.runtime_abi, contract.model.runtime_abi);
        assert_eq!(
            contract.runtime_policy.component_id,
            contract.runtime.component_id
        );
    }
    #[cfg(not(any(
        all(windows, target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64")
    )))]
    assert!(host_local_reasoning_contract().is_none());
}

fn signing_key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn verifier(key: &SigningKey) -> ComponentVerifier {
    let encoded = URL_SAFE_NO_PAD.encode(key.verifying_key().as_bytes());
    ComponentVerifier::from_keys([(KEY_ID, encoded.as_str())], ["models.kalcoded.com"])
        .expect("test verifier")
}

fn token(
    key: &SigningKey,
    component_id: &str,
    kind: ComponentKind,
    version: &str,
    sequence: u64,
    artifact: &[u8],
) -> String {
    token_for_target(
        key,
        component_id,
        kind,
        version,
        sequence,
        artifact,
        test_host_platform(),
        test_host_arch(),
    )
}

#[allow(clippy::too_many_arguments)]
fn token_for_target(
    key: &SigningKey,
    component_id: &str,
    kind: ComponentKind,
    version: &str,
    sequence: u64,
    artifact: &[u8],
    platform: ComponentPlatform,
    arch: ComponentArch,
) -> String {
    let digest = format!("{:x}", Sha256::digest(artifact));
    let kind_segment = kind_segment(kind);
    let file = match kind {
        ComponentKind::Model => "reasoner.gguf",
        ComponentKind::Runtime => "runtime.zip",
    };
    let payload = serde_json::json!({
        "schemaVersion": 1,
        "componentId": component_id,
        "kind": kind_segment,
        "version": version,
        "sequence": sequence,
        "platform": platform,
        "arch": arch,
        "runtimeAbi": "kalvoice-llama-cpp.v1",
        "sizeBytes": artifact.len(),
        "sha256": digest,
        "artifactUrl": format!(
            "https://models.kalcoded.com/components/v1/{kind_segment}/{component_id}/{version}/{digest}/{file}"
        ),
        "licenses": [{
            "spdxId": "Apache-2.0",
            "noticeSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        }],
        "provenance": {
            "sourceId": "ggml-org/test",
            "sourceRevision": "0123456789abcdef",
            "sourceIntegritySha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "buildRecipeSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
        },
        "issuedAt": NOW,
        "expiresAt": NOW + 86_400,
        "keyId": KEY_ID
    });
    let header = serde_json::json!({ "alg": "EdDSA", "kid": KEY_ID, "typ": TOKEN_TYPE });
    let input = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(header.to_string()),
        URL_SAFE_NO_PAD.encode(payload.to_string())
    );
    let signature = key.sign(input.as_bytes());
    format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature.to_bytes()))
}

#[cfg(target_os = "windows")]
fn test_host_platform() -> ComponentPlatform {
    ComponentPlatform::Windows
}

#[cfg(target_os = "macos")]
fn test_host_platform() -> ComponentPlatform {
    ComponentPlatform::Macos
}

#[cfg(target_os = "linux")]
fn test_host_platform() -> ComponentPlatform {
    ComponentPlatform::Linux
}

#[cfg(target_arch = "x86_64")]
fn test_host_arch() -> ComponentArch {
    ComponentArch::X86_64
}

#[cfg(target_arch = "aarch64")]
fn test_host_arch() -> ComponentArch {
    ComponentArch::Aarch64
}

fn test_directory(path: impl AsRef<Path>) -> TrustedComponentDirectory {
    let path = path.as_ref();
    if !path.exists() {
        fs::create_dir(path).expect("test component directory");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;

        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .expect("private test component directory mode");
    }
    TrustedComponentDirectory::open_existing(path).expect("trusted test directory")
}

fn write(path: &Path, bytes: &[u8]) {
    fs::write(path, bytes).expect("write fixture")
}

fn selector(component_id: &str, kind: ComponentKind) -> ComponentSelector {
    ComponentSelector {
        component_id: component_id.to_owned(),
        kind,
        platform: test_host_platform(),
        arch: test_host_arch(),
        runtime_abi: "kalvoice-llama-cpp.v1".into(),
    }
}

#[test]
fn store_rejects_a_valid_signed_component_for_another_operating_system() {
    let temp = TempDir::new().expect("temp");
    let key = signing_key(7);
    let store = ComponentStore::new(
        test_directory(temp.path().join("store")),
        verifier(&key),
        [],
    )
    .expect("component store");
    let bytes = b"bounded model fixture";
    let artifact = temp.path().join("model.gguf");
    write(&artifact, bytes);
    let other_platform = match test_host_platform() {
        ComponentPlatform::Windows => ComponentPlatform::Macos,
        ComponentPlatform::Macos | ComponentPlatform::Linux => ComponentPlatform::Windows,
    };
    let signed = token_for_target(
        &key,
        "kalvoice.reasoner.test",
        ComponentKind::Model,
        "1.0.0",
        1,
        bytes,
        other_platform,
        test_host_arch(),
    );

    assert!(matches!(
        store.install_from_file(&signed, &artifact, NOW),
        Err(ComponentStoreError::WrongTarget)
    ));
}

#[cfg(unix)]
#[test]
fn trusted_directory_rejects_a_symlink_root_without_creating_outside_state() {
    let temp = TempDir::new().expect("temp");
    let outside = temp.path().join("outside");
    fs::create_dir(&outside).expect("outside directory");
    let linked = temp.path().join("store");
    std::os::unix::fs::symlink(&outside, &linked).expect("store symlink");

    assert!(matches!(
        TrustedComponentDirectory::open_existing(&linked),
        Err(ComponentStoreError::UnsafeStorage)
    ));
    assert!(!outside.join("v1").exists());
}

#[test]
fn installs_signed_model_and_hashes_it_only_at_load_boundary() {
    let temp = TempDir::new().expect("temp");
    let key = signing_key(7);
    let store = ComponentStore::new(
        test_directory(temp.path().join("store")),
        verifier(&key),
        [],
    )
    .expect("component store");
    let bytes = b"bounded model fixture";
    let artifact = temp.path().join("model.gguf");
    write(&artifact, bytes);
    let token = token(
        &key,
        "kalvoice.reasoner.test",
        ComponentKind::Model,
        "1.0.0",
        1,
        bytes,
    );
    let selector = selector("kalvoice.reasoner.test", ComponentKind::Model);

    store
        .install_from_file(&token, &artifact, NOW)
        .expect("signed artifact installs");
    assert!(matches!(
        store.status(&selector, NOW + 86_400),
        ComponentReceiptStatus::Present {
            freshness: InstalledManifestFreshness::Expired,
            ..
        }
    ));

    let lease = store
        .acquire(&selector, NOW + 86_400)
        .expect("expired receipt remains valid offline");
    assert_eq!(
        lease.model_path().and_then(|path| fs::read(path).ok()),
        Some(bytes.to_vec())
    );
    assert_eq!(lease.freshness(), InstalledManifestFreshness::Expired);
    assert!(!lease.recovered_previous());
}

#[test]
fn same_size_current_corruption_recovers_only_the_exact_previous_revision() {
    let temp = TempDir::new().expect("temp");
    let key = signing_key(7);
    let store = ComponentStore::new(
        test_directory(temp.path().join("store")),
        verifier(&key),
        [],
    )
    .expect("component store");
    let id = "kalvoice.reasoner.test";
    let first = b"model revision one";
    let second = b"model revision two";
    assert_eq!(first.len(), second.len());
    let artifact = temp.path().join("model.gguf");
    write(&artifact, first);
    store
        .install_from_file(
            &token(&key, id, ComponentKind::Model, "1.0.0", 1, first),
            &artifact,
            NOW,
        )
        .expect("first install");
    write(&artifact, second);
    store
        .install_from_file(
            &token(&key, id, ComponentKind::Model, "2.0.0", 2, second),
            &artifact,
            NOW,
        )
        .expect("upgrade");

    let track = store.track_dir(&selector(id, ComponentKind::Model));
    let pointer = read_pointer(&track)
        .expect("pointer read")
        .expect("pointer");
    let current_model = track.join(pointer.current).join("model.gguf");
    write(&current_model, b"tampered revision");

    let recovered = store
        .acquire(&selector(id, ComponentKind::Model), NOW)
        .expect("exact previous revision recovers");
    assert!(recovered.recovered_previous());
    assert_eq!(recovered.manifest().sequence, 1);
    assert_eq!(
        recovered.model_path().and_then(|path| fs::read(path).ok()),
        Some(first.to_vec())
    );
}

#[test]
fn idempotent_current_reinstall_preserves_the_exact_previous_revision() {
    let temp = TempDir::new().expect("temp");
    let key = signing_key(7);
    let store = ComponentStore::new(
        test_directory(temp.path().join("store")),
        verifier(&key),
        [],
    )
    .expect("component store");
    let id = "kalvoice.reasoner.test";
    let first = b"model revision one";
    let second = b"model revision two";
    assert_eq!(first.len(), second.len());
    let artifact = temp.path().join("model.gguf");
    write(&artifact, first);
    store
        .install_from_file(
            &token(&key, id, ComponentKind::Model, "1.0.0", 1, first),
            &artifact,
            NOW,
        )
        .expect("first install");
    write(&artifact, second);
    let second_token = token(&key, id, ComponentKind::Model, "2.0.0", 2, second);
    store
        .install_from_file(&second_token, &artifact, NOW)
        .expect("upgrade");
    store
        .install_from_file(&second_token, &artifact, NOW)
        .expect("idempotent reinstall");

    let track = store.track_dir(&selector(id, ComponentKind::Model));
    let pointer = read_pointer(&track)
        .expect("pointer read")
        .expect("pointer");
    assert!(pointer.previous.is_some(), "rollback pointer must survive");
    write(
        &track.join(pointer.current).join("model.gguf"),
        b"tampered revision",
    );

    let recovered = store
        .acquire(&selector(id, ComponentKind::Model), NOW)
        .expect("exact previous revision recovers");
    assert!(recovered.recovered_previous());
    assert_eq!(recovered.manifest().sequence, 1);
}

#[test]
fn unsigned_pointer_cannot_select_a_retained_older_signed_revision() {
    let temp = TempDir::new().expect("temp");
    let key = signing_key(7);
    let store = ComponentStore::new(
        test_directory(temp.path().join("store")),
        verifier(&key),
        [],
    )
    .expect("component store");
    let id = "kalvoice.reasoner.test";
    let artifact = temp.path().join("model.gguf");
    for (version, sequence, bytes) in [
        ("1.0.0", 1, b"revision one".as_slice()),
        ("2.0.0", 2, b"revision two".as_slice()),
    ] {
        write(&artifact, bytes);
        store
            .install_from_file(
                &token(&key, id, ComponentKind::Model, version, sequence, bytes),
                &artifact,
                NOW,
            )
            .expect("install revision");
    }
    let selector = selector(id, ComponentKind::Model);
    let track = store.track_dir(&selector);
    let pointer = read_pointer(&track)
        .expect("pointer read")
        .expect("pointer");
    let retained_previous = pointer.previous.expect("retained previous");
    replace_pointer(
        &track,
        &Pointer {
            schema_version: POINTER_SCHEMA,
            current: retained_previous,
            previous: None,
        },
    )
    .expect("tamper pointer fixture");

    assert!(matches!(
        store.acquire(&selector, NOW),
        Err(ComponentStoreError::InvalidPointer)
    ));
    assert_eq!(
        store.status(&selector, NOW),
        ComponentReceiptStatus::Invalid
    );
}

#[test]
fn explicit_install_retry_recovers_a_verified_revision_after_activation_failure() {
    let temp = TempDir::new().expect("temp");
    let key = signing_key(7);
    let root = temp.path().join("store");
    let store =
        ComponentStore::new(test_directory(&root), verifier(&key), []).expect("component store");
    let id = "kalvoice.reasoner.test";
    let selection = selector(id, ComponentKind::Model);
    let artifact = temp.path().join("model.gguf");
    let first = b"revision one";
    let second = b"revision two";
    write(&artifact, first);
    store
        .install_from_file(
            &token(&key, id, ComponentKind::Model, "1.0.0", 1, first),
            &artifact,
            NOW,
        )
        .expect("first install");

    // Reproduce the exact publication/activation boundary without a production failpoint.
    // The current pointer remains intact after the actual activation helper fails.
    let track = store.track_dir(&selection);
    let original_pointer = read_pointer(&track)
        .expect("pointer read")
        .expect("pointer");
    write(&artifact, second);
    let second_token = token(&key, id, ComponentKind::Model, "2.0.0", 2, second);
    let candidate = verifier(&key)
        .verify(&second_token, NOW)
        .expect("signed candidate");
    let revision = revision_name(candidate.manifest());
    let staging = track.join(".staging-interrupted-install");
    fs::create_dir(&staging).expect("staging");
    store
        .populate_staging(
            &second_token,
            &artifact,
            candidate.manifest(),
            &staging,
            InstallConsent::User,
        )
        .expect("verified staged candidate");
    fs::rename(&staging, track.join(&revision)).expect("publish revision");
    let blocked_backup = track.join(POINTER_BACKUP);
    fs::create_dir(&blocked_backup).expect("block pointer replacement");
    assert!(matches!(
        store.activate(&track, &revision, Some(original_pointer.current.clone())),
        Err(ComponentStoreError::Storage(_))
    ));
    fs::remove_dir(&blocked_backup).expect("clear transient activation failure");
    assert!(matches!(
        store.acquire(&selection, NOW),
        Err(ComponentStoreError::InvalidPointer)
    ));
    drop(store);

    let reopened = ComponentStore::new(test_directory(&root), verifier(&key), [])
        .expect("reopen component store");
    // Recovery cannot adopt a different signed revision or different metadata for the same bytes.
    for (version, sequence, bytes) in [
        ("1.0.0", 1, first.as_slice()),
        ("3.0.0", 3, second.as_slice()),
        ("2.0.1", 2, second.as_slice()),
    ] {
        write(&artifact, bytes);
        assert!(
            reopened
                .install_from_file(
                    &token(&key, id, ComponentKind::Model, version, sequence, bytes),
                    &artifact,
                    NOW,
                )
                .is_err(),
            "only the exact interrupted candidate may recover"
        );
    }
    write(&artifact, second);
    assert!(matches!(
        reopened.install_from_file(&second_token, &artifact, NOW + 172_800),
        Err(ComponentStoreError::Manifest(VerifyError::Expired))
    ));
    let wrong_platform = if test_host_platform() == ComponentPlatform::Windows {
        ComponentPlatform::Macos
    } else {
        ComponentPlatform::Windows
    };
    let wrong_target = token_for_target(
        &key,
        id,
        ComponentKind::Model,
        "2.0.0",
        2,
        second,
        wrong_platform,
        test_host_arch(),
    );
    assert!(matches!(
        reopened.install_from_file(&wrong_target, &artifact, NOW),
        Err(ComponentStoreError::WrongTarget)
    ));
    let conflicting_bytes = b"conflicting revision two";
    let conflicting_token = token(
        &key,
        id,
        ComponentKind::Model,
        "2.0.0",
        2,
        conflicting_bytes,
    );
    let conflicting_manifest = verifier(&key)
        .verify(&conflicting_token, NOW)
        .expect("signed conflict");
    let conflicting_dir = track.join(revision_name(conflicting_manifest.manifest()));
    fs::create_dir(&conflicting_dir).expect("conflicting revision");
    write(&artifact, conflicting_bytes);
    reopened
        .populate_staging(
            &conflicting_token,
            &artifact,
            conflicting_manifest.manifest(),
            &conflicting_dir,
            InstallConsent::User,
        )
        .expect("valid conflicting revision bytes");
    write(&artifact, second);
    assert!(matches!(
        reopened.install_from_file(&second_token, &artifact, NOW),
        Err(ComponentStoreError::InvalidPointer)
    ));
    fs::remove_dir_all(&conflicting_dir).expect("remove conflicting fixture");
    // A valid source download cannot hide corruption of the retained candidate being activated.
    let retained_model = track.join(&revision).join("model.gguf");
    write(&retained_model, b"tampered two");
    assert!(
        reopened
            .install_from_file(&second_token, &artifact, NOW)
            .is_err()
    );
    write(&retained_model, second);
    let receipt_path = track.join(&revision).join("receipt.json");
    let receipt_bytes = fs::read(&receipt_path).expect("receipt bytes");
    write(&receipt_path, b"{}");
    assert!(
        reopened
            .install_from_file(&second_token, &artifact, NOW)
            .is_err()
    );
    write(&receipt_path, &receipt_bytes);
    assert_eq!(
        read_pointer(&track)
            .expect("pointer read")
            .expect("pointer")
            .current,
        original_pointer.current
    );
    assert_eq!(
        reopened.status(&selection, NOW),
        ComponentReceiptStatus::Invalid
    );
    reopened
        .install_from_file(&second_token, &artifact, NOW)
        .expect("explicit authenticated retry repairs interrupted activation");
    let lease = reopened
        .acquire(&selection, NOW)
        .expect("repaired component");
    assert_eq!(lease.manifest().sequence, 2);
    assert!(!lease.recovered_previous());
    assert_eq!(
        fs::read(lease.model_path().expect("model path")).expect("model"),
        second
    );
    let pointer = read_pointer(&track)
        .expect("pointer read")
        .expect("pointer");
    assert_eq!(pointer.previous, Some(original_pointer.current));
}

#[test]
fn active_lease_blocks_component_deletion() {
    let temp = TempDir::new().expect("temp");
    let key = signing_key(7);
    let store = ComponentStore::new(
        test_directory(temp.path().join("store")),
        verifier(&key),
        [],
    )
    .expect("component store");
    let id = "kalvoice.reasoner.test";
    let bytes = b"model";
    let artifact = temp.path().join("model.gguf");
    write(&artifact, bytes);
    store
        .install_from_file(
            &token(&key, id, ComponentKind::Model, "1.0.0", 1, bytes),
            &artifact,
            NOW,
        )
        .expect("install");
    let selector = selector(id, ComponentKind::Model);
    let lease = store.acquire(&selector, NOW).expect("lease");

    assert!(matches!(
        store.delete(&selector),
        Err(ComponentStoreError::InUse)
    ));
    drop(lease);
    store.delete(&selector).expect("delete after lease");
    assert_eq!(
        store.status(&selector, NOW),
        ComponentReceiptStatus::Missing
    );
}

#[test]
fn active_lease_blocks_deletion_from_an_independent_store_instance() {
    let temp = TempDir::new().expect("temp");
    let key = signing_key(7);
    let root = temp.path().join("store");
    let first =
        ComponentStore::new(test_directory(&root), verifier(&key), []).expect("first store");
    let second =
        ComponentStore::new(test_directory(&root), verifier(&key), []).expect("second store");
    let id = "kalvoice.reasoner.test";
    let bytes = b"model";
    let artifact = temp.path().join("model.gguf");
    write(&artifact, bytes);
    first
        .install_from_file(
            &token(&key, id, ComponentKind::Model, "1.0.0", 1, bytes),
            &artifact,
            NOW,
        )
        .expect("install");
    let selector = selector(id, ComponentKind::Model);
    let lease = first.acquire(&selector, NOW).expect("lease");

    let deletion = second.delete(&selector);
    assert!(
        matches!(deletion, Err(ComponentStoreError::InUse)),
        "unexpected deletion result: {deletion:?}"
    );
    drop(lease);
    second.delete(&selector).expect("delete after lease");
}

#[cfg(any(unix, windows))]
#[test]
fn store_lock_links_are_rejected_without_touching_their_targets() {
    let temp = TempDir::new().expect("temp");
    let key = signing_key(7);
    let store = ComponentStore::new(
        test_directory(temp.path().join("store")),
        verifier(&key),
        [],
    )
    .expect("component store");
    let id = "kalvoice.reasoner.test";
    let selector = selector(id, ComponentKind::Model);
    let lock_dir = store.track_lock_dir(&selector);
    fs::create_dir_all(&lock_dir).expect("lock directory");
    let outside = temp.path().join("outside-lock");
    write(&outside, b"");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, lock_dir.join("track.lock"))
        .expect("lock symlink fixture");
    #[cfg(windows)]
    fs::hard_link(&outside, lock_dir.join("track.lock")).expect("lock hardlink fixture");

    let bytes = b"model";
    let artifact = temp.path().join("model.gguf");
    write(&artifact, bytes);
    assert!(matches!(
        store.install_from_file(
            &token(&key, id, ComponentKind::Model, "1.0.0", 1, bytes),
            &artifact,
            NOW,
        ),
        Err(ComponentStoreError::UnsafeStorage)
    ));
    assert_eq!(fs::read(outside).expect("outside lock remains"), b"");
}

static TEST_RUNTIME_POLICY: RuntimeArchivePolicy = RuntimeArchivePolicy {
    component_id: "kalvoice.runtime.test",
    entrypoint: "llama-server.exe",
    executable_entries: &[],
    extract_entries: &["llama-server.exe", "llama.dll"],
    ignore_entries: &["unused.exe"],
};

fn runtime_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut cursor = std::io::Cursor::new(Vec::new());
    {
        let mut writer = ZipWriter::new(&mut cursor);
        for (name, bytes) in entries {
            writer
                .start_file(*name, SimpleFileOptions::default())
                .expect("zip entry");
            writer.write_all(bytes).expect("zip bytes");
        }
        writer.finish().expect("finish zip");
    }
    cursor.into_inner()
}

fn runtime_zip_with_modes(entries: &[(&str, &[u8], u32)]) -> Vec<u8> {
    let mut cursor = std::io::Cursor::new(Vec::new());
    {
        let mut writer = ZipWriter::new(&mut cursor);
        for (name, bytes, mode) in entries {
            writer
                .start_file(*name, SimpleFileOptions::default().unix_permissions(*mode))
                .expect("zip entry");
            writer.write_all(bytes).expect("zip bytes");
        }
        writer.finish().expect("finish zip");
    }
    cursor.into_inner()
}

fn rewrite_zip_declared_uncompressed_size(bytes: &mut [u8], size: u32) {
    let encoded = size.to_le_bytes();
    let offsets = bytes
        .windows(4)
        .enumerate()
        .filter_map(|(offset, signature)| match signature {
            [0x50, 0x4b, 0x03, 0x04] => Some(offset + 22),
            [0x50, 0x4b, 0x01, 0x02] => Some(offset + 24),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert!(!offsets.is_empty(), "fixture must contain ZIP headers");
    for offset in offsets {
        bytes[offset..offset + 4].copy_from_slice(&encoded);
    }
}

#[test]
fn runtime_extraction_bounds_actual_output_when_zip_size_fields_understate_it() {
    let temp = TempDir::new().expect("temp");
    let archive_path = temp.path().join("runtime.zip");
    let payload = vec![b'x'; 1024 * 1024];
    let mut archive = runtime_zip(&[("llama-server.exe", payload.as_slice())]);
    rewrite_zip_declared_uncompressed_size(&mut archive, 1);
    write(&archive_path, &archive);
    let destination = temp.path().join("payload");
    fs::create_dir(&destination).expect("payload directory");

    assert!(matches!(
        extract_runtime(&archive_path, &destination, &TEST_RUNTIME_POLICY),
        Err(ComponentStoreError::UnsafeArchive)
    ));
    let written = destination.join("llama-server.exe");
    assert!(
        !written.exists() || fs::metadata(written).expect("written metadata").len() <= 2,
        "extraction must stop after the signed declaration plus one detection byte"
    );
}

#[test]
fn macos_runtime_policy_is_a_curated_regular_file_dependency_closure() {
    assert_eq!(
        LLAMA_B11146_MACOS_ARM64_CPU_POLICY.component_id,
        LLAMA_B11146_WINDOWS_CPU_POLICY.component_id
    );
    assert_eq!(
        LLAMA_B11146_MACOS_ARM64_CPU_POLICY.executable_entries,
        &["llama-server"]
    );
    assert_eq!(
        LLAMA_B11146_MACOS_ARM64_CPU_POLICY.extract_entries,
        &[
            "LICENSE",
            "libggml-base.0.dylib",
            "libggml-blas.0.dylib",
            "libggml-cpu.0.dylib",
            "libggml-metal.0.dylib",
            "libggml-rpc.0.dylib",
            "libggml.0.dylib",
            "libllama-common.0.dylib",
            "libllama-server-impl.dylib",
            "libllama.0.dylib",
            "libmtmd.0.dylib",
            "llama-server",
        ]
    );
    assert!(
        LLAMA_B11146_MACOS_ARM64_CPU_POLICY
            .ignore_entries
            .is_empty()
    );
}

#[test]
fn macos_release_writer_fixture_passes_the_real_consumer_decoder() {
    // Generated by writeMacRuntimeZip; its Node test requires byte-for-byte equality.
    // These are harmless fixture bytes, not signed or executable production code.
    let archive = include_bytes!("../tests/fixtures/macos-runtime-modes.zip");
    let temp = TempDir::new().expect("temp");
    let zip = temp.path().join("runtime.zip");
    write(&zip, archive);
    let payload = temp.path().join("payload");
    fs::create_dir(&payload).expect("payload");
    let policy = &LLAMA_B11146_MACOS_ARM64_CPU_POLICY;
    let files = extract_runtime(&zip, &payload, policy).expect("producer ZIP accepted");
    verify_runtime(&zip, &payload, policy, &files).expect("producer ZIP reverified");
    assert_eq!(files.len(), policy.extract_entries.len());
}

#[test]
fn executable_runtime_policy_requires_exact_signed_zip_modes() {
    static POLICY: RuntimeArchivePolicy = RuntimeArchivePolicy {
        component_id: "kalvoice.runtime.mode-test",
        entrypoint: "llama-server",
        executable_entries: &["llama-server"],
        extract_entries: &["LICENSE", "libllama.dylib", "llama-server"],
        ignore_entries: &[],
    };
    let valid = runtime_zip_with_modes(&[
        ("LICENSE", b"license", 0o644),
        ("libllama.dylib", b"library", 0o644),
        ("llama-server", b"server", 0o755),
    ]);
    let invalid = runtime_zip_with_modes(&[
        ("LICENSE", b"license", 0o644),
        ("libllama.dylib", b"library", 0o644),
        ("llama-server", b"server", 0o644),
    ]);
    let temp = TempDir::new().expect("temp");
    let valid_zip = temp.path().join("valid.zip");
    let invalid_zip = temp.path().join("invalid.zip");
    write(&valid_zip, &valid);
    write(&invalid_zip, &invalid);

    let valid_payload = temp.path().join("valid");
    fs::create_dir(&valid_payload).expect("payload");
    let files = extract_runtime(&valid_zip, &valid_payload, &POLICY).expect("valid modes");
    verify_runtime(&valid_zip, &valid_payload, &POLICY, &files).expect("mode recheck");

    let invalid_payload = temp.path().join("invalid");
    fs::create_dir(&invalid_payload).expect("payload");
    assert!(matches!(
        extract_runtime(&invalid_zip, &invalid_payload, &POLICY),
        Err(ComponentStoreError::UnsafeArchive)
    ));
}

#[test]
fn runtime_extracts_only_exactly_classified_entries_and_rechecks_archive_on_load() {
    let temp = TempDir::new().expect("temp");
    let key = signing_key(7);
    let store = ComponentStore::new(
        test_directory(temp.path().join("store")),
        verifier(&key),
        [TEST_RUNTIME_POLICY],
    )
    .expect("component store");
    let bytes = runtime_zip(&[
        ("llama-server.exe", b"server"),
        ("llama.dll", b"library"),
        ("unused.exe", b"never extracted"),
    ]);
    let artifact = temp.path().join("runtime.zip");
    write(&artifact, &bytes);
    let id = TEST_RUNTIME_POLICY.component_id;
    store
        .install_from_file(
            &token(&key, id, ComponentKind::Runtime, "1.0.0", 1, &bytes),
            &artifact,
            NOW,
        )
        .expect("runtime install");

    let lease = store
        .acquire(&selector(id, ComponentKind::Runtime), NOW)
        .expect("verified runtime lease");
    let root = lease.runtime_root().expect("runtime root");
    assert!(root.join("llama-server.exe").is_file());
    assert!(root.join("llama.dll").is_file());
    assert!(!root.join("unused.exe").exists());
}

#[test]
fn runtime_rejects_unknown_traversal_and_case_colliding_entries() {
    let key = signing_key(7);
    for entries in [
        vec![
            ("llama-server.exe", b"server".as_slice()),
            ("llama.dll", b"library".as_slice()),
            ("extra.dll", b"unknown".as_slice()),
        ],
        vec![
            ("llama-server.exe", b"server".as_slice()),
            ("llama.dll", b"library".as_slice()),
            ("../escape.dll", b"escape".as_slice()),
        ],
        vec![
            ("llama-server.exe", b"server".as_slice()),
            ("LLAMA-SERVER.EXE", b"collision".as_slice()),
            ("llama.dll", b"library".as_slice()),
        ],
    ] {
        let temp = TempDir::new().expect("temp");
        let store = ComponentStore::new(
            test_directory(temp.path().join("store")),
            verifier(&key),
            [TEST_RUNTIME_POLICY],
        )
        .expect("component store");
        let bytes = runtime_zip(&entries);
        let artifact = temp.path().join("runtime.zip");
        write(&artifact, &bytes);
        let result = store.install_from_file(
            &token(
                &key,
                TEST_RUNTIME_POLICY.component_id,
                ComponentKind::Runtime,
                "1.0.0",
                1,
                &bytes,
            ),
            &artifact,
            NOW,
        );
        assert!(matches!(result, Err(ComponentStoreError::UnsafeArchive)));
        assert!(!temp.path().join("escape.dll").exists());
    }
}

#[test]
fn removed_trust_key_invalidates_an_installed_receipt_even_when_bytes_match() {
    let temp = TempDir::new().expect("temp");
    let trusted = signing_key(7);
    let replacement = signing_key(9);
    let root = temp.path().join("store");
    let bytes = b"model";
    let artifact = temp.path().join("model.gguf");
    write(&artifact, bytes);
    let id = "kalvoice.reasoner.test";
    ComponentStore::new(test_directory(&root), verifier(&trusted), [])
        .expect("store")
        .install_from_file(
            &token(&trusted, id, ComponentKind::Model, "1.0.0", 1, bytes),
            &artifact,
            NOW,
        )
        .expect("install");

    let replacement_encoded = URL_SAFE_NO_PAD.encode(replacement.verifying_key().as_bytes());
    let replacement_verifier = ComponentVerifier::from_keys(
        [("component-2026-2", replacement_encoded.as_str())],
        ["models.kalcoded.com"],
    )
    .expect("replacement verifier");
    let reopened =
        ComponentStore::new(test_directory(&root), replacement_verifier, []).expect("reopen");
    assert_eq!(
        reopened.status(&selector(id, ComponentKind::Model), NOW),
        ComponentReceiptStatus::Invalid
    );
    assert!(matches!(
        reopened.acquire(&selector(id, ComponentKind::Model), NOW),
        Err(ComponentStoreError::Manifest(VerifyError::UnknownKey))
    ));
}

#[test]
#[ignore = "requires the pinned local llama.cpp runtime archive"]
#[cfg(any(
    all(windows, target_arch = "x86_64"),
    all(target_os = "macos", target_arch = "aarch64")
))]
fn pinned_runtime_archive_round_trips_the_exact_extraction_policy() {
    #[cfg(all(windows, target_arch = "x86_64"))]
    let (expected_sha256, policy) = (
        "14cf1303ca9ac3abd94816850532f9f9a69ac66fbaca3776fc6f9061c2fac1d1",
        LLAMA_B11146_WINDOWS_CPU_POLICY,
    );
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    let (expected_sha256, policy) = (
        "0342a5523fab1ca5cbdaf1875e814fb5942011fc70a4aae191003fed3fbf2e6b",
        LLAMA_B11146_MACOS_ARM64_CPU_POLICY,
    );
    let source = std::env::var_os("KALCODE_LLAMA_RUNTIME_ZIP")
        .expect("KALCODE_LLAMA_RUNTIME_ZIP is required");
    assert_eq!(
        hash_file(Path::new(&source)).expect("hash pinned runtime"),
        expected_sha256,
        "the local fixture must be the exact attested host llama.cpp b11146 runtime archive"
    );
    let temp = TempDir::new().expect("temp");
    let payload = temp.path().join("payload");
    fs::create_dir(&payload).expect("payload");
    let files =
        extract_runtime(Path::new(&source), &payload, &policy).expect("exact policy extraction");
    verify_runtime(Path::new(&source), &payload, &policy, &files)
        .expect("extracted bytes equal the signed archive");
}

/// Every `receipt.json` under `root`.
fn receipts_under(root: &Path) -> Vec<std::path::PathBuf> {
    let mut found = Vec::new();
    let mut pending = vec![root.to_owned()];
    while let Some(dir) = pending.pop() {
        for entry in fs::read_dir(&dir).expect("read dir").flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            } else if path.file_name().is_some_and(|name| name == "receipt.json") {
                found.push(path);
            }
        }
    }
    found
}

#[test]
fn install_consent_round_trips_on_the_receipt_and_legacy_receipts_read_as_user() {
    let temp = TempDir::new().expect("temp");
    let key = signing_key(7);
    let root = temp.path().join("store");
    let store = ComponentStore::new(test_directory(&root), verifier(&key), []).expect("store");
    let bytes = b"automatic default model";
    let artifact = temp.path().join("model.gguf");
    write(&artifact, bytes);

    // Zero-setup provisioning records its system-granted consent on the receipt.
    let automatic = token(
        &key,
        "kalvoice.speech.auto",
        ComponentKind::Model,
        "1.0.0",
        1,
        bytes,
    );
    store
        .install_from_file_with_consent(
            &automatic,
            &artifact,
            NOW,
            InstallConsent::AutomaticDefault,
        )
        .expect("automatic install");
    let automatic_selector = selector("kalvoice.speech.auto", ComponentKind::Model);
    assert!(matches!(
        store.status(&automatic_selector, NOW),
        ComponentReceiptStatus::Present {
            consent: InstallConsent::AutomaticDefault,
            ..
        }
    ));

    // A dialog-consented install keeps the exact legacy receipt shape (no consent field).
    let user = token(
        &key,
        "kalvoice.speech.user",
        ComponentKind::Model,
        "1.0.0",
        1,
        bytes,
    );
    store
        .install_from_file(&user, &artifact, NOW)
        .expect("user install");
    let user_selector = selector("kalvoice.speech.user", ComponentKind::Model);
    assert!(matches!(
        store.status(&user_selector, NOW),
        ComponentReceiptStatus::Present {
            consent: InstallConsent::User,
            ..
        }
    ));

    let receipts = receipts_under(&root);
    assert_eq!(receipts.len(), 2);
    let mut consents = Vec::new();
    for path in &receipts {
        let value: serde_json::Value =
            serde_json::from_slice(&fs::read(path).expect("receipt")).expect("receipt json");
        let mut keys = value
            .as_object()
            .expect("receipt object")
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        keys.sort();
        consents.push(value.get("consent").cloned());
        let mut legacy = vec![
            "artifactFile",
            "entrypoint",
            "extractedFiles",
            "schemaVersion",
            "token",
        ];
        if value.get("consent").is_some() {
            legacy.push("consent");
            legacy.sort_unstable();
        }
        assert_eq!(keys, legacy);
    }
    consents.sort_by_key(|consent| consent.is_some());
    assert_eq!(
        consents,
        vec![None, Some(serde_json::Value::from("automatic_default"))]
    );

    // A pre-existing (legacy) receipt, reopened by a new store, is still installed and loads:
    // the owner's installed model is reused, never fetched again.
    drop(store);
    let reopened = ComponentStore::new(test_directory(&root), verifier(&key), []).expect("reopen");
    assert!(matches!(
        reopened.status(&user_selector, NOW),
        ComponentReceiptStatus::Present {
            consent: InstallConsent::User,
            ..
        }
    ));
    assert!(reopened.acquire(&user_selector, NOW).is_ok());
    assert!(reopened.acquire(&automatic_selector, NOW).is_ok());
}
