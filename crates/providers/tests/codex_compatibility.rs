//! Cross-platform Codex compatibility negotiation against the deterministic provider fixture.
//! No provider network, account, credential, or model call is made.

#![cfg(any(windows, target_os = "macos"))]
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Barrier};
use std::time::Instant;

use kalcode_contracts::agent::ProviderError;
use kalcode_providers::DetectEnv;
use kalcode_providers::codex::compatibility::{
    CodexCompatibility, CodexReleaseChannel, probe_guarded,
};
use kalcode_providers::env::EnvPolicy;
use kalcode_providers::guardian::GuardianRuntime;
use kalcode_providers::version::Version;
use serde_json::{Value, json};

const FAKE: &str = env!("CARGO_BIN_EXE_kalcode-fake-provider");
const GUARDIAN: &str = env!("CARGO_BIN_EXE_kalcode-provider-guardian");

struct FakeCodex {
    _dir: tempfile::TempDir,
    work: tempfile::TempDir,
    executable: PathBuf,
}

impl FakeCodex {
    fn new(config: Value) -> Self {
        let dir = tempfile::tempdir().expect("fake install");
        let name = if cfg!(windows) { "codex.exe" } else { "codex" };
        let executable = dir.path().join(name);
        std::fs::copy(FAKE, &executable).expect("copy fake Codex");
        std::fs::write(
            dir.path().join("fake-provider.json"),
            serde_json::to_vec(&config).expect("serialize fixture config"),
        )
        .expect("write fixture config");
        Self {
            _dir: dir,
            work: tempfile::tempdir().expect("probe workspace"),
            executable,
        }
    }

    fn runs(&self) -> Vec<Value> {
        std::fs::read_to_string(
            self.executable
                .parent()
                .expect("fake install parent")
                .join("runs.log"),
        )
        .expect("fake invocation log")
        .lines()
        .map(|line| serde_json::from_str(line).expect("invocation JSON"))
        .collect()
    }

    fn replace_version(&self, version: &str) {
        std::fs::write(
            self.executable
                .parent()
                .expect("fake install parent")
                .join("fake-provider.json"),
            serde_json::to_vec(&json!({"version": format!("codex-cli {version}")}))
                .expect("serialize replacement fixture config"),
        )
        .expect("write replacement fixture config");

        let mut executable = std::fs::OpenOptions::new()
            .append(true)
            .open(&self.executable)
            .expect("open fake Codex for same-path replacement");
        executable
            .write_all(b"\0KALCODE_CODEX_COMPAT_REPLACEMENT")
            .expect("change replacement binary fingerprint");
        executable.flush().expect("flush replacement binary");
    }
}

struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn probe_env() -> BTreeMap<OsString, OsString> {
    DetectEnv::from_process().provider_env(&EnvPolicy::BASE)
}

fn runtime() -> (tempfile::TempDir, GuardianRuntime) {
    let data = tempfile::tempdir().expect("guardian data");
    let runtime = GuardianRuntime::launch(Path::new(GUARDIAN), data.path())
        .expect("production guardian runtime");
    (data, runtime)
}

#[test]
fn stable_0161_and_unknown_newer_stable_use_the_normal_compatibility_path() {
    let (_guardian_data, runtime) = runtime();
    let guardian = runtime.probe_guardian().expect("probe guardian");

    for version in ["0.161.0", "0.999.0"] {
        let fake = FakeCodex::new(json!({"version": format!("codex-cli {version}")}));
        let env = probe_env();
        let capabilities = probe_guarded(&fake.executable, &env, fake.work.path(), &guardian)
            .unwrap_or_else(|error| panic!("stable Codex {version} was rejected: {error}"));

        assert_eq!(
            capabilities.version,
            Version::parse(version).expect("version")
        );
        assert_eq!(capabilities.channel, CodexReleaseChannel::Stable);
        assert_eq!(capabilities.compatibility(), CodexCompatibility::Compatible);
        assert!(capabilities.managed_profiles);
        let warm_started = Instant::now();
        let cached = probe_guarded(&fake.executable, &env, fake.work.path(), &guardian)
            .expect("warm cached compatibility result");
        let warm_elapsed = warm_started.elapsed();
        eprintln!("warm Codex compatibility lookup for {version}: {warm_elapsed:?}");
        assert!(Arc::ptr_eq(&capabilities, &cached));

        let runs = fake.runs();
        let args = |index: usize| &runs[index]["args"];
        assert_eq!(args(0), &json!(["--version"]));
        let help_args = runs[1..6]
            .iter()
            .map(|run| serde_json::to_string(&run["args"]).expect("help argv JSON"))
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            help_args,
            [
                json!(["--help"]),
                json!(["exec", "--help"]),
                json!(["exec", "resume", "--help"]),
                json!(["resume", "--help"]),
                json!(["app-server", "--help"]),
            ]
            .into_iter()
            .map(|args| serde_json::to_string(&args).expect("expected argv JSON"))
            .collect(),
            "all and only the consumed help grammars must be probed; completion order is free"
        );
        assert_eq!(
            runs.len(),
            7,
            "one bounded process per cold compatibility probe"
        );
        let protocol_args = args(6).as_array().expect("protocol args");
        assert_eq!(protocol_args.last(), Some(&json!("app-server")));
        assert_eq!(protocol_args.len() % 2, 1, "config pairs plus app-server");
        assert!(
            protocol_args[..protocol_args.len() - 1]
                .as_chunks::<2>()
                .0
                .iter()
                .all(|pair| {
                    pair[0] == json!("-c")
                        && pair[1].as_str().is_some_and(|value| value.contains('='))
                }),
            "app-server probe config must remain argv pairs, never shell text: {protocol_args:?}"
        );
    }

    runtime.seal_and_drain().expect("clean guardian drain");
}

#[test]
fn concurrent_first_use_single_flights_one_bounded_capability_probe() {
    let fake = FakeCodex::new(json!({"version": "codex-cli 0.161.0"}));
    let (_guardian_data, runtime) = runtime();
    let guardian = runtime.probe_guardian().expect("probe guardian");
    let env = probe_env();
    let executable = fake.executable.clone();
    let work = fake.work.path().to_path_buf();
    let barrier = Arc::new(Barrier::new(7));

    let workers = (0..6)
        .map(|_| {
            let guardian = guardian.clone();
            let env = env.clone();
            let executable = executable.clone();
            let work = work.clone();
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                probe_guarded(&executable, &env, &work, &guardian)
                    .expect("concurrent compatibility probe")
            })
        })
        .collect::<Vec<_>>();

    barrier.wait();
    let results = workers
        .into_iter()
        .map(|worker| worker.join().expect("compatibility worker"))
        .collect::<Vec<_>>();
    assert!(
        results
            .windows(2)
            .all(|pair| Arc::ptr_eq(&pair[0], &pair[1])),
        "concurrent callers did not share one cached descriptor"
    );
    assert_eq!(
        fake.runs().len(),
        7,
        "six concurrent callers must execute one seven-child cold probe"
    );

    runtime.seal_and_drain().expect("clean guardian drain");
}

#[test]
fn replacing_a_binary_at_the_same_path_invalidates_the_capability_cache() {
    let fake = FakeCodex::new(json!({"version": "codex-cli 0.161.0"}));
    let (_guardian_data, runtime) = runtime();
    let guardian = runtime.probe_guardian().expect("probe guardian");
    let env = probe_env();
    let first = probe_guarded(&fake.executable, &env, fake.work.path(), &guardian)
        .expect("initial compatibility probe");
    assert_eq!(
        first.version,
        Version::parse("0.161.0").expect("initial version")
    );
    assert_eq!(fake.runs().len(), 7, "initial cold probe child count");

    fake.replace_version("0.162.0");
    let replacement = probe_guarded(&fake.executable, &env, fake.work.path(), &guardian)
        .expect("replacement compatibility probe");
    assert_eq!(
        replacement.version,
        Version::parse("0.162.0").expect("replacement version")
    );
    assert!(
        !Arc::ptr_eq(&first, &replacement),
        "same-path binary replacement reused the stale descriptor"
    );
    assert_eq!(
        fake.runs().len(),
        14,
        "same-path binary replacement must execute a fresh cold probe"
    );

    runtime.seal_and_drain().expect("clean guardian drain");
}

#[test]
fn real_prerelease_labels_are_experimental_after_the_same_capability_smoke() {
    let (_guardian_data, runtime) = runtime();
    let guardian = runtime.probe_guardian().expect("probe guardian");

    for (version, channel) in [
        ("0.162.0-alpha.16", CodexReleaseChannel::Alpha),
        ("0.162.0-beta.1", CodexReleaseChannel::Beta),
        ("0.162.0-rc.1", CodexReleaseChannel::ReleaseCandidate),
    ] {
        let fake = FakeCodex::new(json!({"version": format!("codex-cli {version}")}));
        let capabilities =
            probe_guarded(&fake.executable, &probe_env(), fake.work.path(), &guardian)
                .unwrap_or_else(|error| {
                    panic!("compatible prerelease {version} was rejected: {error}")
                });
        assert_eq!(capabilities.channel, channel);
        assert_eq!(
            capabilities.compatibility(),
            CodexCompatibility::Experimental
        );
    }

    runtime.seal_and_drain().expect("clean guardian drain");
}

#[test]
fn malformed_missing_removed_capability_and_wrong_profile_home_fail_truthfully() {
    let (_guardian_data, runtime) = runtime();
    let guardian = runtime.probe_guardian().expect("probe guardian");
    let env = probe_env();
    let missing = tempfile::tempdir().expect("missing workspace");
    assert!(matches!(
        probe_guarded(
            &missing
                .path()
                .join(if cfg!(windows) { "codex.exe" } else { "codex" }),
            &env,
            missing.path(),
            &guardian,
        ),
        Err(ProviderError::NotInstalled)
    ));

    let malformed = FakeCodex::new(json!({"version": "not-a-semantic-version"}));
    assert!(matches!(
        probe_guarded(&malformed.executable, &env, malformed.work.path(), &guardian),
        Err(ProviderError::Start(message)) if message.contains("semantic version")
    ));

    let missing_required = FakeCodex::new(json!({
        "version": "codex-cli 0.162.0",
        "codexCapabilities": {"noDaemon": false}
    }));
    let no_daemon_result = probe_guarded(
        &missing_required.executable,
        &env,
        missing_required.work.path(),
        &guardian,
    );
    if cfg!(windows) {
        assert!(matches!(no_daemon_result,
            Err(ProviderError::Refused { code, message })
                if code == "provider_capability_incompatible" && message.contains("no-daemon")
        ));
    } else {
        assert!(
            no_daemon_result.is_ok(),
            "macOS does not consume the Windows no-daemon flag"
        );
    }

    for (capability, expected_missing) in [
        ("workingDirectory", "interactive working directory"),
        ("rootSandbox", "interactive sandbox selection"),
        ("approvalPolicy", "interactive approval policy"),
        ("modelSelection", "interactive model selection"),
        ("skipGitRepoCheck", "headless non-Git workspace support"),
    ] {
        let mut capabilities = serde_json::Map::new();
        capabilities.insert(capability.into(), Value::Bool(false));
        let missing_root_option = FakeCodex::new(json!({
            "version": "codex-cli 0.162.0",
            "codexCapabilities": Value::Object(capabilities),
        }));
        assert!(matches!(
            probe_guarded(
                &missing_root_option.executable,
                &env,
                missing_root_option.work.path(),
                &guardian,
            ),
            Err(ProviderError::Refused { code, message })
                if code == "provider_capability_incompatible"
                    && message.contains(expected_missing)
        ));
    }

    let wrong_home = FakeCodex::new(json!({
        "version": "codex-cli 0.162.0",
        "codexReportedHome": if cfg!(windows) { "C:\\wrong-codex-home" } else { "/wrong-codex-home" }
    }));
    assert!(matches!(
        probe_guarded(&wrong_home.executable, &env, wrong_home.work.path(), &guardian),
        Err(ProviderError::Refused { code, message })
            if code == "provider_capability_incompatible" && message.contains("protocol")
    ));

    runtime.seal_and_drain().expect("clean guardian drain");
}

#[test]
fn validating_a_new_binary_does_not_stop_an_active_old_binary_process() {
    let old = FakeCodex::new(json!({"version": "codex-cli 0.160.0"}));
    let old_version = Command::new(&old.executable)
        .arg("--version")
        .output()
        .expect("old version output");
    assert_eq!(
        String::from_utf8(old_version.stdout)
            .expect("UTF-8 version")
            .trim(),
        "codex-cli 0.160.0"
    );
    let mut active_old = ChildGuard(
        Command::new(&old.executable)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("active old Codex interactive process"),
    );
    assert!(active_old.0.try_wait().expect("old status").is_none());

    let new = FakeCodex::new(json!({"version": "codex-cli 0.161.0"}));
    let (_guardian_data, runtime) = runtime();
    let guardian = runtime.probe_guardian().expect("probe guardian");
    let capabilities = probe_guarded(&new.executable, &probe_env(), new.work.path(), &guardian)
        .expect("new binary validation");
    assert_eq!(
        capabilities.version,
        Version::parse("0.161.0").expect("version")
    );
    assert!(
        active_old
            .0
            .try_wait()
            .expect("old status after probe")
            .is_none(),
        "validating a newly selected Codex binary stopped the already-running old process"
    );

    runtime.seal_and_drain().expect("clean guardian drain");
    assert!(
        active_old
            .0
            .try_wait()
            .expect("old status after compatibility cleanup")
            .is_none(),
        "compatibility cleanup stopped the already-running old process"
    );
}
