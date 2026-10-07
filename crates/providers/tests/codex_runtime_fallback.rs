//! Managed Codex runtime fallback with a real signed declarative compatibility policy.
//! The provider fixture is local and deterministic; no credentials, provider network, or model
//! call is used. This is a separate test binary because compatibility policy is process-global.

#![cfg(any(windows, target_os = "macos"))]
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signer as _, SigningKey};
use kalcode_contracts::agent::{ProviderError, ProviderId};
use kalcode_providers::DetectEnv;
use kalcode_providers::codex::runtime::{ManagedRuntimeSource, select_managed_runtime};
use kalcode_providers::compatibility::{
    CompatibilityStore, CompatibilityVerifier, TOKEN_ALGORITHM, TOKEN_TYPE, set_active_store,
};
use kalcode_providers::env::EnvPolicy;
use kalcode_providers::guardian::GuardianRuntime;
use kalcode_providers::managed_runtime::{RuntimeLayout, RuntimeStore};
use serde_json::json;

const FAKE: &str = env!("CARGO_BIN_EXE_kalcode-fake-provider");
const GUARDIAN: &str = env!("CARGO_BIN_EXE_kalcode-provider-guardian");

fn executable_name() -> &'static str {
    if cfg!(windows) { "codex.exe" } else { "codex" }
}

fn fake_distribution(version: &str) -> tempfile::TempDir {
    let source = tempfile::tempdir().expect("fake distribution");
    std::fs::copy(FAKE, source.path().join(executable_name())).expect("copy fake Codex");
    std::fs::write(
        source.path().join("fake-provider.json"),
        serde_json::to_vec(&json!({"version": format!("codex-cli {version}")}))
            .expect("serialize config"),
    )
    .expect("write fake config");
    source
}

fn promote(store: &RuntimeStore, version: &str) {
    let source = fake_distribution(version);
    let executable = PathBuf::from(executable_name());
    let layout = RuntimeLayout::new(
        source.path(),
        &executable,
        [executable.clone(), PathBuf::from("fake-provider.json")],
    )
    .expect("safe fixture layout");
    let pinned = store
        .stage(ProviderId::CODEX, &layout)
        .expect("stage fixture runtime");
    store
        .promote_validated(&pinned, version)
        .expect("promote fixture runtime");
}

fn signed_known_bad_policy(cache: &Path, bad_version: &str) -> CompatibilityStore {
    const KEY_ID: &str = "runtime-fixture";
    const NOW: i64 = 2_000_000_000;
    let signing = SigningKey::from_bytes(&[37; 32]);
    let encoded_key = URL_SAFE_NO_PAD.encode(signing.verifying_key().as_bytes());
    let verifier = CompatibilityVerifier::from_keys([(KEY_ID, encoded_key.as_str())])
        .expect("trusted fixture key");
    let header = json!({"alg": TOKEN_ALGORITHM, "typ": TOKEN_TYPE, "kid": KEY_ID});
    let payload = json!({
        "schemaVersion": 1,
        "revision": 1,
        "issuedAt": NOW - 60,
        "expiresAt": NOW + 86_400,
        "keyId": KEY_ID,
        "providers": [{
            "provider": ProviderId::CODEX,
            "stableFloor": "0.160.0",
            "testedVersions": ["0.160.0", bad_version],
            "knownBad": [{
                "versions": format!("={bad_version}"),
                "reason": "deterministic-selector-fallback-fixture"
            }],
            "protocolConstraints": [],
            "capabilityDisables": []
        }]
    });
    let header = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).expect("header JSON"));
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("payload JSON"));
    let signing_input = format!("{header}.{payload}");
    let signature = URL_SAFE_NO_PAD.encode(signing.sign(signing_input.as_bytes()).to_bytes());
    let token = format!("{signing_input}.{signature}");
    let store = CompatibilityStore::open(cache, verifier, NOW).expect("compatibility store");
    store.refresh(&token, NOW).expect("accept signed policy");
    store
}

fn probe_env() -> std::collections::BTreeMap<OsString, OsString> {
    DetectEnv::from_process().provider_env(&EnvPolicy::BASE)
}

#[test]
fn signed_known_bad_current_runtime_falls_back_to_valid_previous_runtime() {
    const PREVIOUS: &str = "0.160.0";
    const KNOWN_BAD: &str = "0.161.0";

    let root = tempfile::tempdir().expect("runtime fixture root");
    let runtime_store = RuntimeStore::new(root.path().join("managed-runtimes"));
    promote(&runtime_store, PREVIOUS);
    promote(&runtime_store, KNOWN_BAD);
    set_active_store(signed_known_bad_policy(
        &root.path().join("compatibility"),
        KNOWN_BAD,
    ));

    // A noncanonical executable name deliberately makes this the direct installed candidate;
    // the fake still identifies it as Codex by its `codex-` prefix. KalCode must reject it by the
    // signed policy, probe the immutable current+previous chain, skip the known-bad current
    // snapshot, and select the compatible previous one.
    let installed = tempfile::tempdir().expect("installed candidate");
    let installed_name = if cfg!(windows) {
        "codex-candidate.exe"
    } else {
        "codex-candidate"
    };
    let installed_executable = installed.path().join(installed_name);
    std::fs::copy(FAKE, &installed_executable).expect("copy installed candidate");
    std::fs::write(
        installed.path().join("fake-provider.json"),
        json!({"version": format!("codex-cli {KNOWN_BAD}")}).to_string(),
    )
    .expect("write installed config");

    let guardian_data = tempfile::tempdir().expect("guardian data");
    let guardian_runtime = GuardianRuntime::launch(Path::new(GUARDIAN), guardian_data.path())
        .expect("guardian runtime");
    let guardian = guardian_runtime.probe_guardian().expect("probe guardian");
    let neutral_cwd = tempfile::tempdir().expect("neutral workspace");
    let selected = select_managed_runtime(
        Some(&installed_executable),
        &probe_env(),
        neutral_cwd.path(),
        &runtime_store,
        |label| {
            guardian
                .prepare_job(label)
                .map_err(|error| ProviderError::Start(error.to_string()))
        },
        None,
    )
    .expect("known-bad candidate recovers through previous runtime");

    assert_eq!(selected.version().to_string(), PREVIOUS);
    assert_eq!(selected.source(), ManagedRuntimeSource::LastKnownGood);
    assert_ne!(selected.executable(), installed_executable);
    assert!(
        selected.runtime_lease().is_some(),
        "fallback must remain pinned while its new session is active"
    );
    guardian_runtime
        .seal_and_drain()
        .expect("clean compatibility probe drain");
}
