#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::sync::atomic::AtomicBool;

use kalcode_contracts::agent::{ProviderDetection, ProviderId};

use super::*;
use crate::env::EnvPolicy;

const SPEC: DetectionSpec = DetectionSpec {
    provider_id: "launch-probe-test",
    display_name: "Test tool",
    executable: "tool",
    install_dirs: &[],
    appdata_dirs: &[],
    local_appdata_dirs: &[],
    minimum_version: None,
    auth: None,
    env_policy: EnvPolicy::BASE,
};
const TTL: Duration = Duration::from_secs(60);
const DEADLINE: Duration = Duration::from_secs(20);

fn file_name() -> &'static str {
    if cfg!(windows) { "tool.exe" } else { "tool" }
}

fn env_for(dirs: &[&Path]) -> DetectEnv {
    DetectEnv {
        vars: vec![
            ("PATH".into(), std::env::join_paths(dirs).expect("join")),
            ("PATHEXT".into(), ".EXE".into()),
        ],
        windows: cfg!(windows),
        probe_timeout: None,
        system_root: None,
    }
}

/// A provider executable on `PATH`, a cache of its own, and a probe that counts how often it
/// would have spawned `<cli> --version` (and the sign-in check).
struct Rig {
    dir: tempfile::TempDir,
    env: DetectEnv,
    probes: AtomicUsize,
    cache: LaunchProbeCache,
}

impl Rig {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join(file_name()), b"version one").expect("fixture");
        let env = env_for(&[dir.path()]);
        Self {
            dir,
            env,
            probes: AtomicUsize::new(0),
            cache: LaunchProbeCache::default(),
        }
    }

    fn exe(&self) -> PathBuf {
        self.dir.path().join(file_name())
    }

    /// What a real probe reports: whatever executable resolves now, in `state` / `auth`.
    fn probe(&self, env: &DetectEnv, state: DetectionState, auth: AuthState) -> Detected {
        self.probes.fetch_add(1, Ordering::SeqCst);
        let executable = env.resolve_executable_only(&SPEC);
        let state = if executable.is_some() {
            state
        } else {
            DetectionState::NotInstalled
        };
        Detected {
            detection: ProviderDetection {
                provider_id: ProviderId::new(SPEC.provider_id),
                display_name: SPEC.display_name.into(),
                state,
                display_path: None,
                version: Some("1.0.0".into()),
                minimum_version: None,
                auth,
                message: None,
                checked_at: "t".into(),
            },
            error_code: None,
            executable,
            duration: Duration::ZERO,
        }
    }

    fn launch_with(
        &self,
        env: &DetectEnv,
        ttl: Duration,
        state: DetectionState,
        auth: AuthState,
    ) -> Detected {
        self.cache
            .detect(&SPEC, env, true, ttl, || self.probe(env, state, auth))
    }

    fn launch(&self) -> Detected {
        self.launch_with(
            &self.env,
            TTL,
            DetectionState::Installed,
            AuthState::Authenticated,
        )
    }

    fn probes(&self) -> usize {
        self.probes.load(Ordering::SeqCst)
    }
}

#[test]
fn launches_within_the_ttl_with_an_unchanged_binary_reuse_one_probe() {
    let rig = Rig::new();
    for _ in 0..10 {
        let detected = rig.launch();
        assert_eq!(detected.detection.state, DetectionState::Installed);
        assert_eq!(detected.executable.as_deref(), Some(rig.exe().as_path()));
    }
    assert_eq!(rig.probes(), 1, "10 launches, one version/sign-in probe");
}

#[test]
fn a_binary_of_another_size_is_probed_again() {
    let rig = Rig::new();
    rig.launch();
    std::fs::write(rig.exe(), b"version two, longer").expect("upgrade");
    rig.launch();
    assert_eq!(rig.probes(), 2);
    rig.launch();
    assert_eq!(rig.probes(), 2, "the new binary's result is reused in turn");
}

#[test]
fn a_binary_with_another_modification_time_is_probed_again() {
    let rig = Rig::new();
    rig.launch();
    let file = std::fs::File::options()
        .write(true)
        .open(rig.exe())
        .expect("open");
    file.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000))
        .expect("set mtime");
    drop(file);
    rig.launch();
    assert_eq!(rig.probes(), 2, "same size, new modification time");
}

#[test]
fn an_expired_result_is_probed_again() {
    let rig = Rig::new();
    let expired = |rig: &Rig| {
        rig.launch_with(
            &rig.env,
            Duration::ZERO,
            DetectionState::Installed,
            AuthState::Authenticated,
        )
    };
    expired(&rig);
    expired(&rig);
    assert_eq!(rig.probes(), 2);
}

#[test]
fn results_a_session_cannot_start_with_are_never_reused() {
    let rig = Rig::new();
    for (state, auth) in [
        (DetectionState::Installed, AuthState::NotAuthenticated),
        (DetectionState::Outdated, AuthState::Authenticated),
        (DetectionState::Error, AuthState::Unknown),
    ] {
        let before = rig.probes();
        rig.launch_with(&rig.env, TTL, state, auth);
        let again = rig.launch_with(&rig.env, TTL, state, auth);
        assert_eq!(again.detection.state, state);
        assert_eq!(rig.probes(), before + 2, "{state:?} / {auth:?}");
    }
    // Signing in is seen by the very next launch, and that result is reused.
    rig.launch();
    rig.launch();
    assert_eq!(rig.probes(), 7);
}

#[test]
fn unknown_sign_in_state_is_reusable_like_today() {
    let rig = Rig::new();
    for _ in 0..3 {
        rig.launch_with(&rig.env, TTL, DetectionState::Installed, AuthState::Unknown);
    }
    assert_eq!(rig.probes(), 1);
}

#[test]
fn another_environment_is_probed_on_its_own() {
    let rig = Rig::new();
    rig.launch();
    let mut account = rig.env.clone();
    account
        .vars
        .push(("CODEX_HOME".into(), rig.dir.path().join("account").into()));
    rig.launch_with(
        &account,
        TTL,
        DetectionState::Installed,
        AuthState::Authenticated,
    );
    assert_eq!(rig.probes(), 2, "another account's sign-in is its own");
    rig.launch();
    rig.launch_with(
        &account,
        TTL,
        DetectionState::Installed,
        AuthState::Authenticated,
    );
    assert_eq!(rig.probes(), 2, "both results are reused");
}

#[test]
fn a_new_executable_earlier_on_path_is_probed() {
    let rig = Rig::new();
    let earlier = tempfile::tempdir().expect("tempdir");
    let env = env_for(&[earlier.path(), rig.dir.path()]);
    let launch = || {
        rig.launch_with(
            &env,
            TTL,
            DetectionState::Installed,
            AuthState::Authenticated,
        )
    };
    launch();
    std::fs::write(earlier.path().join(file_name()), b"version one").expect("install");
    let detected = launch();
    assert_eq!(rig.probes(), 2);
    assert_eq!(
        detected.executable.as_deref(),
        Some(earlier.path().join(file_name()).as_path())
    );
}

#[test]
fn a_missing_binary_after_caching_reports_not_installed_and_is_not_reused() {
    let rig = Rig::new();
    rig.launch();
    std::fs::remove_file(rig.exe()).expect("uninstall");
    let detected = rig.launch();
    assert_eq!(detected.detection.state, DetectionState::NotInstalled);
    assert_eq!(detected.executable, None);
    assert_eq!(rig.probes(), 2, "probed again, not served from the cache");
    rig.launch();
    assert_eq!(rig.probes(), 3, "the stale result is gone");
    assert!(lock(&rig.cache.state).slots.is_empty());
}

#[test]
fn forgetting_a_provider_probes_it_again() {
    let rig = Rig::new();
    rig.launch();
    rig.cache.forget("another-provider");
    rig.launch();
    assert_eq!(rig.probes(), 1, "other providers keep their results");
    rig.cache.forget(SPEC.provider_id);
    rig.launch();
    assert_eq!(rig.probes(), 2);
}

#[test]
fn an_explicit_check_of_the_executable_probes_it_again() {
    let rig = Rig::new();
    rig.launch();
    rig.cache
        .forget_executable(&rig.dir.path().join("another-tool"));
    rig.launch();
    assert_eq!(rig.probes(), 1, "other executables keep their results");
    rig.cache.forget_executable(&rig.exe());
    rig.launch();
    assert_eq!(rig.probes(), 2);
}

#[test]
fn a_probe_that_was_running_when_forgotten_is_not_kept() {
    let rig = Rig::new();
    rig.cache.detect(&SPEC, &rig.env, true, TTL, || {
        let detected = rig.probe(
            &rig.env,
            DetectionState::Installed,
            AuthState::Authenticated,
        );
        rig.cache.forget(SPEC.provider_id);
        detected
    });
    rig.launch();
    assert_eq!(rig.probes(), 2);
}

#[test]
fn concurrent_launches_share_one_in_flight_probe() {
    let rig = Rig::new();
    let started = AtomicBool::new(false);
    let results = std::thread::scope(|scope| {
        let leader = scope.spawn(|| {
            rig.cache.detect(&SPEC, &rig.env, true, TTL, || {
                started.store(true, Ordering::SeqCst);
                let deadline = Instant::now() + DEADLINE;
                while rig.cache.waiters() < 3 && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(5));
                }
                rig.probe(
                    &rig.env,
                    DetectionState::Installed,
                    AuthState::Authenticated,
                )
            })
        });
        let deadline = Instant::now() + DEADLINE;
        while !started.load(Ordering::SeqCst) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(1));
        }
        let followers: Vec<_> = (0..3).map(|_| scope.spawn(|| rig.launch())).collect();
        let mut results = vec![leader.join().expect("leader")];
        results.extend(followers.into_iter().map(|f| f.join().expect("follower")));
        results
    });
    assert_eq!(rig.probes(), 1, "4 concurrent launches, one probe");
    assert!(
        results
            .iter()
            .all(|d| d.detection.state == DetectionState::Installed
                && d.executable.as_deref() == Some(rig.exe().as_path()))
    );
}

#[test]
fn an_abandoned_probe_lets_waiters_probe_themselves() {
    let rig = Rig::new();
    let started = AtomicBool::new(false);
    let release = AtomicBool::new(false);
    let follower = std::thread::scope(|scope| {
        let leader = scope.spawn(|| {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                rig.cache.detect(&SPEC, &rig.env, true, TTL, || {
                    started.store(true, Ordering::SeqCst);
                    let deadline = Instant::now() + DEADLINE;
                    while !release.load(Ordering::SeqCst) && Instant::now() < deadline {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    panic!("probe bug");
                })
            }))
        });
        let deadline = Instant::now() + DEADLINE;
        while !started.load(Ordering::SeqCst) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(1));
        }
        let follower = scope.spawn(|| rig.launch());
        while rig.cache.waiters() < 1 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(1));
        }
        release.store(true, Ordering::SeqCst);
        assert!(leader.join().expect("leader thread").is_err());
        follower.join().expect("follower")
    });
    assert_eq!(follower.detection.state, DetectionState::Installed);
    assert_eq!(rig.probes(), 1, "the waiter ran its own probe");
}

/// The shared entry point keys guarded and unguarded detections apart and goes through the
/// same cache for every provider spec.
#[test]
fn keys_cover_every_detection_input() {
    let spec = crate::catalog::codex_spec();
    let env = env_for(&[Path::new("/")]);
    let base = Key::new(&spec, &env, true);
    assert!(base != Key::new(&spec, &env, false));
    assert!(base != Key::new(&crate::catalog::claude_spec(), &env, true));
    let mut timeout = env.clone();
    timeout.probe_timeout = Some(Duration::from_secs(1));
    assert!(base != Key::new(&spec, &timeout, true));
    let mut no_auth = spec.clone();
    no_auth.auth = None;
    assert!(base != Key::new(&no_auth, &env, true));
}
