// Every command the frontend may call. Tauri generates an `allow-<command>` permission for
// each; `capabilities/main.json` grants them to the trusted main webview. Anything not listed here is
// unreachable from the WebView.
include!("src/command_registry.rs");

/// Test hooks. Declared (and so given an `allow-*` permission) only when the target build has
/// test hooks compiled in: debug builds and the `e2e` feature. Release builds don't register
/// these commands at all; their grant lives in `test-capabilities/test-hooks.json`, which the app
/// adds at runtime under the same condition. Never listed in `capabilities/`.
const TEST_HOOK_COMMANDS: &[&str] = &["test_permission_probe"];

/// Whether the crate being built has test hooks (`cfg!(any(debug_assertions, feature = "e2e"))`
/// in the crate). A build script's own `cfg!` describes the build script, so read Cargo's view
/// of the target instead.
fn target_has_test_hooks() -> bool {
    std::env::var_os("CARGO_CFG_DEBUG_ASSERTIONS").is_some()
        || std::env::var_os("CARGO_FEATURE_E2E").is_some()
}

/// Embeds Tauri's Windows app manifest (Common Controls v6, which the dialog plugin's
/// `TaskDialogIndirect` needs) through the linker, so the test binaries get it as well as the
/// app. Tauri's default resource-based manifest reaches only the app binaries, and a unit-test
/// binary without it cannot start (STATUS_ENTRYPOINT_NOT_FOUND). `/MANIFESTUAC:NO` keeps the
/// embedded manifest exactly the file's content, as before.
fn embed_windows_manifest() -> tauri_build::WindowsAttributes {
    let manifest =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFESTUAC:NO");
    tauri_build::WindowsAttributes::new_without_app_manifest()
}

fn main() {
    println!("cargo:rerun-if-changed=src/command_registry.rs");
    // Fail closed for direct Cargo/CLI invocations that omit the Dev overlay. This also
    // prevents a release binary (and its credential service) using a Dev bundle identity.
    println!("cargo:rerun-if-env-changed=TAURI_CONFIG");
    let debug = std::env::var_os("CARGO_CFG_DEBUG_ASSERTIONS").is_some();
    let base: serde_json::Value = serde_json::from_str(include_str!("tauri.conf.json"))
        .unwrap_or_else(|error| panic!("invalid base app config: {error}"));
    println!("cargo:rerun-if-changed=tauri.conf.json");
    let overlay: serde_json::Value =
        serde_json::from_str(&std::env::var("TAURI_CONFIG").unwrap_or_else(|_| "{}".into()))
            .unwrap_or_else(|error| panic!("invalid TAURI_CONFIG: {error}"));
    let expected: serde_json::Value = if debug {
        serde_json::from_str(include_str!("tauri.dev.conf.json"))
            .unwrap_or_else(|error| panic!("invalid Dev app config: {error}"))
    } else {
        base.clone()
    };
    for path in [
        "/identifier",
        "/productName",
        "/plugins/deep-link/desktop/schemes",
    ] {
        let actual = overlay.pointer(path).or_else(|| base.pointer(path));
        assert_eq!(
            actual,
            expected.pointer(path),
            "app identity/profile mismatch at {path}; use pnpm tauri dev/build, or set TAURI_CONFIG to the Dev overlay for direct debug Cargo commands"
        );
    }
    // The runtime version (`package_info().version`) comes from the same merged config. A
    // release build may only add a numeric internal build number: `X.Y.Z` -> `X.Y.Z+N`.
    let public_version = base
        .pointer("/version")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_else(|| panic!("the base app config has no version"));
    // KalCode's public version: tauri.conf.json is the authority. It is compiled into this crate
    // only; the workspace crates carry a fixed internal version, so a version change recompiles
    // just the app crate.
    println!("cargo:rustc-env=KALCODE_PUBLIC_VERSION={public_version}");
    let version = overlay.pointer("/version").map_or(public_version, |value| {
        value
            .as_str()
            .unwrap_or_else(|| panic!("TAURI_CONFIG version must be a string"))
    });
    if version != public_version {
        let build = version
            .strip_prefix(public_version)
            .and_then(|rest| rest.strip_prefix('+'));
        assert!(
            build.is_some_and(|build| !build.is_empty()
                && !build.starts_with('0')
                && build.bytes().all(|byte| byte.is_ascii_digit())),
            "TAURI_CONFIG version {version} must be {public_version} or {public_version}+<build number>"
        );
    }
    println!("cargo:rustc-env=KALCODE_APP_VERSION={version}");
    println!("cargo:rerun-if-changed=test-capabilities");
    println!("cargo:rerun-if-env-changed=KALCODE_AUTHENTICODE_IDENTITY_OIDS");
    let mut commands = COMMANDS.to_vec();
    if target_has_test_hooks() {
        commands.extend_from_slice(TEST_HOOK_COMMANDS);
    } else {
        // tauri-build loads every file in `permissions/autogenerated/`, and a debug build of
        // this checkout leaves the test hooks' files there (git-ignored). Remove them so a
        // release build doesn't even define their permissions.
        for command in TEST_HOOK_COMMANDS {
            let stale =
                std::path::Path::new("permissions/autogenerated").join(format!("{command}.toml"));
            if let Err(error) = std::fs::remove_file(&stale)
                && error.kind() != std::io::ErrorKind::NotFound
            {
                eprintln!("couldn't remove {}: {error}", stale.display());
                std::process::exit(1);
            }
        }
    }
    let commands: &'static [&'static str] = commands.leak();
    let mut attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(commands));
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        attributes = attributes.windows_attributes(embed_windows_manifest());
    }
    if let Err(error) = tauri_build::try_build(attributes) {
        eprintln!("tauri build script failed: {error:#}");
        std::process::exit(1);
    }
}
