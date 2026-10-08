//! Managed Codex recovery when a newer stable CLI loses launch capabilities KalCode consumes.
//! Every provider process is the deterministic local fixture; no credentials, network, prompt, or
//! model call is made.

#![cfg(any(windows, target_os = "macos"))]
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use kalcode_contracts::agent::{ProviderError, ProviderId};
use kalcode_providers::DetectEnv;
use kalcode_providers::codex::argv::EFFORT_LEVELS;
use kalcode_providers::codex::runtime::{ManagedRuntimeSource, prewarm_managed_runtime};
use kalcode_providers::env::EnvPolicy;
use kalcode_providers::guardian::GuardianRuntime;
use kalcode_providers::managed_runtime::{RuntimeLayout, RuntimeStore};
use serde_json::{Value, json};

const FAKE: &str = env!("CARGO_BIN_EXE_kalcode-fake-provider");
const GUARDIAN: &str = env!("CARGO_BIN_EXE_kalcode-provider-guardian");

fn executable_name() -> &'static str {
    if cfg!(windows) { "codex.exe" } else { "codex" }
}

fn fake_distribution(config: &Value) -> tempfile::TempDir {
    let source = tempfile::tempdir().expect("fake distribution");
    std::fs::copy(FAKE, source.path().join(executable_name())).expect("copy fake Codex");
    std::fs::write(
        source.path().join("fake-provider.json"),
        serde_json::to_vec(config).expect("serialize config"),
    )
    .expect("write fake config");
    source
}

fn promote_previous(store: &RuntimeStore, version: &str) {
    let source = fake_distribution(&json!({"version": format!("codex-cli {version}")}));
    let executable = PathBuf::from(executable_name());
    let layout = RuntimeLayout::new(
        source.path(),
        &executable,
        [executable.clone(), PathBuf::from("fake-provider.json")],
    )
    .expect("safe fixture layout");
    let staged = store
        .stage(ProviderId::CODEX, &layout)
        .expect("stage previous runtime");
    store
        .promote_validated(&staged, version)
        .expect("promote previous runtime");
}

fn probe_env() -> BTreeMap<OsString, OsString> {
    DetectEnv::from_process().provider_env(&EnvPolicy::BASE)
}

/// A future CLI that no longer exposes a structurally understood reasoning-effort contract has
/// lost a launch capability KalCode consumes, so managed launches recover through the previous
/// validated runtime and the incompatible bytes are never promoted.
#[test]
fn future_stable_missing_reasoning_contract_falls_back_without_promotion() {
    const PREVIOUS: &str = "0.161.0";
    const FUTURE: &str = "0.999.0";
    let cases = [(
        "missing config property",
        json!({
            "version": format!("codex-cli {FUTURE}"),
            "codexConfigSchemaMode": "missing-property",
        }),
    )];

    for (case, config) in cases {
        let root = tempfile::tempdir().expect("runtime fixture root");
        let store = RuntimeStore::new(root.path().join("managed-runtimes"));
        promote_previous(&store, PREVIOUS);

        let installed = fake_distribution(&config);
        let candidate = installed.path().join(executable_name());
        let guardian_data = tempfile::tempdir().expect("guardian data");
        let guardian_runtime = GuardianRuntime::launch(Path::new(GUARDIAN), guardian_data.path())
            .expect("guardian runtime");
        let guardian = guardian_runtime.probe_guardian().expect("probe guardian");
        let neutral = tempfile::tempdir().expect("neutral workspace");

        let selected = prewarm_managed_runtime(
            Some(&candidate),
            &probe_env(),
            neutral.path(),
            &store,
            |label| {
                guardian
                    .prepare_job(label)
                    .map_err(|error| ProviderError::Start(error.to_string()))
            },
            None,
        )
        .unwrap_or_else(|error| {
            panic!("{case} did not recover through the previous runtime: {error}")
        });

        assert_eq!(
            selected.source(),
            ManagedRuntimeSource::LastKnownGood,
            "{case}"
        );
        assert_eq!(selected.version().to_string(), PREVIOUS, "{case}");
        assert!(selected.runtime_lease().is_some(), "{case}");
        for effort in EFFORT_LEVELS {
            assert!(
                selected.capabilities().supports_reasoning_effort(effort),
                "fallback for {case} lost {effort}"
            );
        }
        let candidates = store
            .validated_candidates(ProviderId::CODEX)
            .expect("validated runtime inventory");
        assert!(
            candidates
                .iter()
                .all(|candidate| candidate.version() != FUTURE),
            "incompatible future stable runtime was promoted for {case}"
        );

        guardian_runtime
            .seal_and_drain()
            .expect("clean compatibility probe drain");
    }
}

/// Removing one historical effort token is a provider product change, not a lost launch
/// capability: the provider's schema stays authoritative (native parity). The updated CLI is
/// used and promoted, every token it still accepts stays available, and only the removed token
/// is refused at launch admission (`require_managed_reasoning_effort`).
#[test]
fn future_stable_without_a_historical_effort_token_is_used_natively() {
    const PREVIOUS: &str = "0.161.0";
    const FUTURE: &str = "0.999.0";
    let root = tempfile::tempdir().expect("runtime fixture root");
    let store = RuntimeStore::new(root.path().join("managed-runtimes"));
    promote_previous(&store, PREVIOUS);

    // Distribution-shaped install (`bin/codex` + `codex-resources/`), so the immutable snapshot
    // carries the fixture's configuration exactly as it carries a real Codex's resources.
    let installed = tempfile::tempdir().expect("fake distribution");
    let bin = installed.path().join("bin");
    let resources = installed.path().join("codex-resources");
    std::fs::create_dir(&bin).expect("distribution bin");
    std::fs::create_dir(&resources).expect("distribution resources");
    let candidate = bin.join(executable_name());
    std::fs::copy(FAKE, &candidate).expect("copy fake Codex");
    std::fs::write(
        resources.join("fake-provider.json"),
        serde_json::to_vec(&json!({
            "version": format!("codex-cli {FUTURE}"),
            "codexReasoningEfforts": ["minimal", "low", "medium", "high"],
            "recordAdjacentArtifacts": false,
        }))
        .expect("serialize config"),
    )
    .expect("write fake config");

    let guardian_data = tempfile::tempdir().expect("guardian data");
    let guardian_runtime = GuardianRuntime::launch(Path::new(GUARDIAN), guardian_data.path())
        .expect("guardian runtime");
    let guardian = guardian_runtime.probe_guardian().expect("probe guardian");
    let neutral = tempfile::tempdir().expect("neutral workspace");

    let selected = prewarm_managed_runtime(
        Some(&candidate),
        &probe_env(),
        neutral.path(),
        &store,
        |label| {
            guardian
                .prepare_job(label)
                .map_err(|error| ProviderError::Start(error.to_string()))
        },
        None,
    )
    .expect("the updated provider remains usable");

    assert_eq!(selected.source(), ManagedRuntimeSource::ValidatedSnapshot);
    assert_eq!(selected.version().to_string(), FUTURE);
    for effort in ["minimal", "low", "medium", "high"] {
        assert!(
            selected.capabilities().supports_reasoning_effort(effort),
            "the updated provider still accepts {effort}"
        );
    }
    assert!(
        !selected.capabilities().supports_reasoning_effort("xhigh"),
        "a removed token is never claimed"
    );
    assert!(
        store
            .validated_candidates(ProviderId::CODEX)
            .expect("validated runtime inventory")
            .iter()
            .any(|candidate| candidate.version() == FUTURE),
        "the compatible update is promoted"
    );

    drop(selected);
    guardian_runtime
        .seal_and_drain()
        .expect("clean compatibility probe drain");
}
