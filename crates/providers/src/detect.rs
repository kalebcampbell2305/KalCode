//! Read-only provider detection.
//!
//! Detection never modifies the machine and never sends a prompt. For each provider it:
//! 1. resolves the executable on `PATH`, then in the provider's documented install locations;
//! 2. runs only `<exe> --version` with a timeout and parses the version;
//! 3. compares it against the minimum KalCode's adapter needs (when an adapter exists);
//! 4. if the provider documents a side-effect-free sign-in status command, runs it with a
//!    timeout and reads only its documented signal (exit code, or a fixed status phrase).
//!    Otherwise the sign-in state is reported as unknown.

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use kalcode_core::runtime::display_path;
use kalcode_core::time::now_rfc3339;

use kalcode_contracts::agent::{AuthState, DetectionState, ProviderDetection, ProviderId};

use crate::env::{EnvPolicy, absolute_path_entries, lookup, sanitized_env};
use crate::guardian::ProviderProbeGuardian;
use crate::process::{ProcessError, ProcessSpec, run_probe, run_probe_guarded};
use crate::version::Version;

/// How long `--version` may take. Node-based CLIs can be slow on a cold start.
pub const VERSION_TIMEOUT: Duration = Duration::from_secs(15);
/// How long a sign-in status command may take.
pub const AUTH_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_PROBE_OUTPUT: usize = 16 * 1024;

/// How a provider's documented sign-in status command reports its result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthSignal {
    /// Documented exit codes: 0 when signed in, 1 when not. Output is discarded unread.
    ExitCode,
    /// Documented human-readable status. `signed_in` / `signed_out` are matched as prefixes of
    /// the first non-empty line (stdout, then stderr); anything else is `Unknown`.
    StatusLine {
        signed_in: &'static str,
        signed_out: &'static str,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuthProbe {
    pub args: &'static [&'static str],
    pub signal: AuthSignal,
}

/// Everything needed to detect one provider.
#[derive(Debug, Clone)]
pub struct DetectionSpec {
    pub provider_id: &'static str,
    pub display_name: &'static str,
    /// Executable base names, without extension (`claude`).
    pub executable: &'static str,
    /// Documented install folders, relative to the home folder (`.local/bin`), checked after
    /// `PATH`. Absolute paths are used as-is.
    pub install_dirs: &'static [&'static str],
    /// Install folders relative to `%APPDATA%` / `%LOCALAPPDATA%` (Windows only).
    pub appdata_dirs: &'static [&'static str],
    pub local_appdata_dirs: &'static [&'static str],
    pub minimum_version: Option<Version>,
    pub auth: Option<AuthProbe>,
    pub env_policy: EnvPolicy,
}

/// The parts of the environment detection depends on. Tests build one by hand.
#[derive(Debug, Clone, Default)]
pub struct DetectEnv {
    /// The (unsanitized) process environment the provider environment is derived from.
    pub vars: Vec<(OsString, OsString)>,
    pub windows: bool,
    /// Overrides [`VERSION_TIMEOUT`] and [`AUTH_TIMEOUT`] (tests).
    pub probe_timeout: Option<Duration>,
    /// Tests only: resolves the specs' root-anchored install folders (Homebrew's
    /// `/opt/homebrew/bin` and `/usr/local/bin`) under this folder instead of the machine's root,
    /// so a CLI installed on the host can't leak into a hermetic test. `None` (production)
    /// searches them as they are.
    pub system_root: Option<PathBuf>,
}

impl DetectEnv {
    pub fn from_process() -> Self {
        Self {
            vars: std::env::vars_os().collect(),
            windows: cfg!(windows),
            probe_timeout: None,
            system_root: None,
        }
    }

    pub(crate) fn var(&self, name: &str) -> Option<&OsStr> {
        self.vars
            .iter()
            .find(|(key, _)| {
                key.to_str().is_some_and(|k| {
                    if self.windows {
                        k.eq_ignore_ascii_case(name)
                    } else {
                        k == name
                    }
                })
            })
            .map(|(_, value)| value.as_os_str())
    }

    pub(crate) fn home(&self) -> Option<PathBuf> {
        let name = if self.windows { "USERPROFILE" } else { "HOME" };
        self.var(name)
            .or_else(|| self.var("HOME"))
            .map(PathBuf::from)
    }

    /// File extensions to try, in order. Windows uses `PATHEXT` (restricted to the kinds the OS
    /// can start directly); other platforms use the bare name only.
    fn extensions(&self) -> Vec<String> {
        if !self.windows {
            return vec![String::new()];
        }
        const STARTABLE: &[&str] = &[".exe", ".com", ".cmd", ".bat"];
        let pathext = self
            .var("PATHEXT")
            .and_then(OsStr::to_str)
            .unwrap_or(".COM;.EXE;.BAT;.CMD");
        let mut out: Vec<String> = pathext
            .split(';')
            .map(|e| e.trim().to_ascii_lowercase())
            .filter(|e| STARTABLE.contains(&e.as_str()))
            .collect();
        if out.is_empty() {
            out = STARTABLE.iter().map(|s| (*s).to_owned()).collect();
        }
        out
    }

    /// Absolute `PATH` entries followed by the provider's documented install folders. Empty and
    /// relative entries (`.`, `bin`) are skipped: they resolve against a working directory, and
    /// a provider must never be picked up from whatever folder KalCode or a workspace is in.
    fn search_dirs(&self, spec: &DetectionSpec) -> Vec<PathBuf> {
        let mut dirs: Vec<PathBuf> = self
            .var("PATH")
            .map(absolute_path_entries)
            .unwrap_or_default();
        let home = self.home();
        for dir in spec.install_dirs {
            let path = Path::new(dir);
            if let (Some(root), Some(below_root)) = (&self.system_root, dir.strip_prefix('/')) {
                dirs.push(root.join(below_root));
            } else if path.is_absolute() {
                dirs.push(path.to_path_buf());
            } else if let Some(home) = &home {
                dirs.push(home.join(path));
            }
        }
        if self.windows {
            for (var, rel) in [
                ("APPDATA", spec.appdata_dirs),
                ("LOCALAPPDATA", spec.local_appdata_dirs),
            ] {
                if let Some(base) = self.var(var) {
                    dirs.extend(rel.iter().map(|d| Path::new(base).join(d)));
                }
            }
        }
        // Unix: user-level Node.js install folders (npm's user prefix, Volta, nvm's default
        // version), which a Finder-launched app's `PATH` never has.
        #[cfg(unix)]
        if !self.windows
            && let Some(home) = &home
        {
            dirs.extend(crate::node_managers::user_bin_dirs(home));
        }
        dirs.retain(|d| !d.as_os_str().is_empty() && d.is_absolute());
        dirs
    }

    /// The sanitized environment a provider process gets.
    pub fn provider_env(&self, policy: &EnvPolicy) -> BTreeMap<OsString, OsString> {
        sanitized_env(self.vars.iter().cloned(), policy)
    }

    /// Resolves a provider executable without starting it or reading any provider-owned state.
    /// Account authentication uses this path-only lookup before selecting a managed profile;
    /// the ordinary detection probes must never run against a standalone provider profile.
    pub fn resolve_executable_only(&self, spec: &DetectionSpec) -> Option<PathBuf> {
        resolve_executable(spec.executable, &self.search_dirs(spec), &self.extensions())
    }
}

/// Script launchers (`.cmd`, `.bat`) run through `cmd.exe`. They are used only when no native
/// executable of the same name exists in any searched folder.
const SCRIPT_EXTENSIONS: &[&str] = &[".cmd", ".bat"];

/// Finds the executable named `name` + one of `extensions` in `dirs`. Native executables win
/// over script launchers wherever they are: a native `claude.exe` (the documented installer's
/// launcher) is preferred to an npm `claude.cmd` shim earlier on `PATH`. Within each kind, the
/// first folder (then the first extension) wins, as on the command line. Only absolute folders
/// are searched.
pub fn resolve_executable(name: &str, dirs: &[PathBuf], extensions: &[String]) -> Option<PathBuf> {
    let is_script = |ext: &String| SCRIPT_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str());
    let find = |script: bool| {
        dirs.iter().filter(|d| d.is_absolute()).find_map(|dir| {
            extensions
                .iter()
                .filter(|ext| is_script(ext) == script)
                .find_map(|ext| {
                    let candidate = dir.join(format!("{name}{ext}"));
                    candidate.is_file().then_some(candidate)
                })
        })
    };
    find(false).or_else(|| find(true))
}

impl DetectionSpec {
    /// The documented sign-in status command as the user would type it.
    pub fn auth_check_command(&self) -> Option<String> {
        self.auth.map(|auth| {
            std::iter::once(self.executable)
                .chain(auth.args.iter().copied())
                .collect::<Vec<_>>()
                .join(" ")
        })
    }
}

/// A detection plus what stays native: the resolved executable (never sent to the UI in full)
/// and diagnostics.
#[derive(Debug, Clone)]
pub struct Detected {
    pub detection: ProviderDetection,
    /// Stable machine code when `detection.state` is `error`.
    pub error_code: Option<&'static str>,
    pub executable: Option<PathBuf>,
    pub duration: Duration,
}

/// Detects one provider. Never panics; every failure becomes a typed detection result.
pub fn detect(spec: &DetectionSpec, env: &DetectEnv) -> Detected {
    detect_inner(spec, env, None)
}

/// Production provider detection. Every executable probe receives a PREPARED job from the
/// runtime-owned internal probe namespace before the provider process is created.
pub fn detect_guarded(
    spec: &DetectionSpec,
    env: &DetectEnv,
    guardian: &ProviderProbeGuardian,
) -> Detected {
    detect_inner(spec, env, Some(guardian))
}

fn detect_inner(
    spec: &DetectionSpec,
    env: &DetectEnv,
    guardian: Option<&ProviderProbeGuardian>,
) -> Detected {
    let started = Instant::now();
    let mut detection = ProviderDetection {
        provider_id: ProviderId::new(spec.provider_id),
        display_name: spec.display_name.to_owned(),
        state: DetectionState::NotInstalled,
        display_path: None,
        version: None,
        minimum_version: spec.minimum_version.as_ref().map(ToString::to_string),
        auth: AuthState::Unknown,
        message: None,
        checked_at: String::new(),
    };
    let mut error_code = None;

    let executable = env.resolve_executable_only(spec);
    if let Some(exe) = &executable {
        detection.display_path = Some(display_path(exe));
        let provider_env = env.provider_env(&spec.env_policy);
        // Unix: a `#!/usr/bin/env node` CLI with no `node` KalCode can start it with would only
        // fail with `env: node: No such file or directory`; say what is missing instead.
        #[cfg(unix)]
        let probed =
            match crate::launch::missing_node_message(spec.display_name, exe, &provider_env) {
                Some(message) => Err(("node_not_found", message)),
                None => probe_version(
                    spec.provider_id,
                    exe,
                    &provider_env,
                    env.probe_timeout.unwrap_or(VERSION_TIMEOUT),
                    guardian,
                ),
            };
        #[cfg(not(unix))]
        let probed = probe_version(
            spec.provider_id,
            exe,
            &provider_env,
            env.probe_timeout.unwrap_or(VERSION_TIMEOUT),
            guardian,
        );
        match probed {
            Ok(version) => {
                detection.version = Some(version.to_string());
                match &spec.minimum_version {
                    Some(min) if &version < min => {
                        detection.state = DetectionState::Outdated;
                        detection.message = Some(format!(
                            "KalCode needs version {min} or later to run {} threads.",
                            spec.display_name
                        ));
                    }
                    _ => detection.state = DetectionState::Installed,
                }
                if let Some(auth) = &spec.auth {
                    detection.auth = probe_auth(
                        spec.provider_id,
                        exe,
                        auth,
                        &provider_env,
                        env.probe_timeout.unwrap_or(AUTH_TIMEOUT),
                        guardian,
                    );
                }
            }
            Err((code, message)) => {
                detection.state = DetectionState::Error;
                detection.message = Some(message);
                error_code = Some(code);
            }
        }
    }

    detection.checked_at = now_rfc3339();
    let duration = started.elapsed();
    tracing::info!(
        event = "provider.detection_finished",
        provider_id = spec.provider_id,
        state = ?detection.state,
        version = detection.version.as_deref().unwrap_or(""),
        auth = ?detection.auth,
        duration_ms = u64::try_from(duration.as_millis()).unwrap_or(u64::MAX),
        error_code = error_code.unwrap_or("")
    );
    Detected {
        detection,
        error_code,
        executable,
        duration,
    }
}

fn spec_for(exe: &Path, args: &[&str], env: &BTreeMap<OsString, OsString>) -> ProcessSpec {
    ProcessSpec {
        program: exe.to_path_buf(),
        args: args.iter().map(OsString::from).collect(),
        // A neutral working directory: never a project folder, so no project config is read.
        cwd: lookup(env, "TEMP")
            .or_else(|| lookup(env, "TMPDIR"))
            .map(PathBuf::from)
            .filter(|p| p.is_dir()),
        env: env.clone(),
    }
}

fn probe_version(
    provider_id: &str,
    exe: &Path,
    env: &BTreeMap<OsString, OsString>,
    timeout: Duration,
    guardian: Option<&ProviderProbeGuardian>,
) -> Result<Version, (&'static str, String)> {
    let process = spec_for(exe, &["--version"], env);
    let output = match guardian {
        Some(guardian) => guardian
            .prepare_job(&format!("{provider_id}-version-probe"))
            .map_err(|_| {
                (
                    "probe_guardian_unavailable",
                    "The provider probe guardian is unavailable.".to_owned(),
                )
            })
            .and_then(|job| {
                run_probe_guarded(&process, job, timeout, true, MAX_PROBE_OUTPUT)
                    .map_err(map_version_probe_error)
            })?,
        None => {
            run_probe(&process, timeout, true, MAX_PROBE_OUTPUT).map_err(map_version_probe_error)?
        }
    };
    parse_version_output(provider_id, output)
}

fn map_version_probe_error(error: ProcessError) -> (&'static str, String) {
    match error {
        ProcessError::TimedOut(_) => (
            "version_timeout",
            "The version check didn't finish in time.".to_owned(),
        ),
        ProcessError::Spawn(error) => {
            tracing::warn!(event = "provider.version_spawn_failed", error = %error);
            (
                "version_spawn_failed",
                "The program couldn't be started.".to_owned(),
            )
        }
        other => {
            tracing::warn!(event = "provider.version_failed", error = %other);
            ("version_failed", "The version check failed.".to_owned())
        }
    }
}

fn parse_version_output(
    provider_id: &str,
    output: crate::process::ProbeOutput,
) -> Result<Version, (&'static str, String)> {
    if !output.status.success() {
        tracing::warn!(
            event = "provider.version_nonzero_exit",
            code = ?output.status.code(),
            stderr = %output.stderr
        );
        return Err((
            "version_exit_status",
            format!(
                "The version check exited with {}.",
                output
                    .status
                    .code()
                    .map_or_else(|| "a signal".to_owned(), |c| format!("code {c}"))
            ),
        ));
    }
    let version = if provider_id == ProviderId::CURSOR {
        crate::cursor::parse_cli_version(&output.stdout)
    } else {
        Version::find_in(&output.stdout)
    };
    version.ok_or((
        "version_unrecognized",
        "The version check printed something KalCode doesn't recognize.".to_owned(),
    ))
}

fn probe_auth(
    provider_id: &str,
    exe: &Path,
    probe: &AuthProbe,
    env: &BTreeMap<OsString, OsString>,
    timeout: Duration,
    guardian: Option<&ProviderProbeGuardian>,
) -> AuthState {
    let capture = matches!(probe.signal, AuthSignal::StatusLine { .. });
    let process = spec_for(exe, probe.args, env);
    let output = match guardian {
        Some(guardian) => match guardian.prepare_job(&format!("{provider_id}-auth-probe")) {
            Ok(job) => run_probe_guarded(&process, job, timeout, capture, MAX_PROBE_OUTPUT),
            Err(error) => {
                tracing::warn!(event = "provider.auth_guardian_unavailable", error = %error);
                return AuthState::Unknown;
            }
        },
        None => run_probe(&process, timeout, capture, MAX_PROBE_OUTPUT),
    };
    let output = match output {
        Ok(output) => output,
        Err(error) => {
            tracing::warn!(event = "provider.auth_check_failed", error = %error);
            return AuthState::Unknown;
        }
    };
    match probe.signal {
        AuthSignal::ExitCode => match output.status.code() {
            Some(0) => AuthState::Authenticated,
            Some(1) => AuthState::NotAuthenticated,
            _ => AuthState::Unknown,
        },
        AuthSignal::StatusLine {
            signed_in,
            signed_out,
        } => {
            let first_line = [&output.stdout, &output.stderr]
                .iter()
                .find_map(|text| text.lines().map(str::trim).find(|l| !l.is_empty()))
                .unwrap_or("");
            if first_line.starts_with(signed_in) && output.status.success() {
                AuthState::Authenticated
            } else if first_line.starts_with(signed_out) {
                AuthState::NotAuthenticated
            } else {
                AuthState::Unknown
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)], windows: bool) -> DetectEnv {
        DetectEnv {
            vars: pairs
                .iter()
                .map(|(k, v)| (OsString::from(k), OsString::from(v)))
                .collect(),
            windows,
            probe_timeout: None,
            system_root: None,
        }
    }

    const SPEC: DetectionSpec = DetectionSpec {
        provider_id: "test",
        display_name: "Test tool",
        executable: "tool",
        install_dirs: &[".local/bin"],
        appdata_dirs: &["npm"],
        local_appdata_dirs: &[],
        minimum_version: None,
        auth: None,
        env_policy: EnvPolicy::BASE,
    };

    #[test]
    fn windows_extensions_follow_pathext_but_only_startable_kinds() {
        let e = env(&[("PATHEXT", ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.PS1")], true);
        assert_eq!(e.extensions(), [".com", ".exe", ".bat", ".cmd"]);
        assert_eq!(env(&[], false).extensions(), [""]);
    }

    /// An absolute folder on this platform (`/a` is drive-relative on Windows).
    fn abs(name: &str) -> PathBuf {
        std::env::temp_dir().join(name)
    }

    #[test]
    fn search_dirs_put_path_first_then_documented_locations() {
        let path = std::env::join_paths([abs("a"), abs("b")]).expect("join");
        let home = abs("home");
        let roaming = abs("roaming");
        let e = env(
            &[
                ("PATH", path.to_str().expect("utf8")),
                ("USERPROFILE", home.to_str().expect("utf8")),
                ("APPDATA", roaming.to_str().expect("utf8")),
            ],
            true,
        );
        let dirs = e.search_dirs(&SPEC);
        assert_eq!(
            dirs,
            [
                abs("a"),
                abs("b"),
                home.join(".local/bin"),
                roaming.join("npm"),
            ]
        );
    }

    /// Production detection (no `system_root`) still searches Homebrew's folders for every
    /// provider: a Finder-launched macOS app has no Homebrew folder on its `PATH`.
    #[test]
    fn production_detection_still_searches_the_homebrew_dirs() {
        use crate::catalog::{HOMEBREW, claude_spec, codex_spec, gemini_spec};
        assert_eq!(DetectEnv::from_process().system_root, None);
        let home = abs("home");
        let e = env(&[("HOME", home.to_str().expect("utf8"))], false);
        for spec in [claude_spec(), codex_spec(), gemini_spec()] {
            let dirs = e.search_dirs(&spec);
            for dir in HOMEBREW {
                assert!(spec.install_dirs.contains(&dir), "{}", spec.provider_id);
                // Root-anchored on macOS and Linux; Windows has no Homebrew, and there the
                // folder is drive-relative (anchored at the home folder's drive), as before.
                let expected = if Path::new(dir).is_absolute() {
                    PathBuf::from(dir)
                } else {
                    home.join(dir)
                };
                assert!(
                    dirs.contains(&expected),
                    "{} misses {dir}: {dirs:?}",
                    spec.provider_id
                );
            }
        }
        #[cfg(unix)]
        {
            let dirs = DetectEnv::from_process().search_dirs(&codex_spec());
            for dir in HOMEBREW {
                assert!(dirs.contains(&PathBuf::from(dir)), "{dir}: {dirs:?}");
            }
        }
    }

    /// Tests inject `system_root`, so a CLI in the host's `/opt/homebrew/bin` or
    /// `/usr/local/bin` can't change their results; the Homebrew folders are still searched,
    /// under that root.
    #[test]
    fn a_system_root_keeps_host_homebrew_installs_out_of_detection() {
        use crate::catalog::{HOMEBREW, codex_spec};
        let root = tempfile::tempdir().expect("root");
        let mut e = env(&[], false);
        e.system_root = Some(root.path().to_path_buf());
        let dirs = e.search_dirs(&codex_spec());
        assert_eq!(
            dirs,
            HOMEBREW.map(|dir| root.path().join(dir.trim_start_matches('/')))
        );
        for dir in HOMEBREW {
            assert!(!dirs.contains(&PathBuf::from(dir)), "{dirs:?}");
        }
        assert_eq!(e.resolve_executable_only(&codex_spec()), None);
        let brew = root.path().join("usr/local/bin");
        std::fs::create_dir_all(&brew).expect("mkdir");
        std::fs::write(brew.join("codex"), b"fixture").expect("fixture");
        assert_eq!(
            e.resolve_executable_only(&codex_spec()),
            Some(brew.join("codex"))
        );
    }

    #[test]
    fn path_only_resolution_does_not_require_a_provider_probe() {
        let temp = tempfile::tempdir().expect("temp");
        let executable = temp
            .path()
            .join(if cfg!(windows) { "tool.exe" } else { "tool" });
        std::fs::write(&executable, b"not executable test data").expect("fixture");
        let env = DetectEnv {
            vars: vec![
                ("PATH".into(), temp.path().as_os_str().to_owned()),
                ("PATHEXT".into(), ".EXE".into()),
            ],
            windows: cfg!(windows),
            probe_timeout: None,
            system_root: None,
        };
        let spec = DetectionSpec {
            executable: "tool",
            ..SPEC
        };

        assert_eq!(env.resolve_executable_only(&spec), Some(executable));
    }

    #[test]
    fn relative_and_empty_path_entries_are_never_searched() {
        let sep = if cfg!(windows) { ";" } else { ":" };
        let a = abs("a");
        let path = format!(
            ".{sep}{sep}bin{sep}node_modules/.bin{sep}{}{sep}",
            a.display()
        );
        let e = env(&[("PATH", &path), ("USERPROFILE", "relative-home")], true);
        // A relative home folder can't anchor the documented install folders either.
        assert_eq!(e.search_dirs(&SPEC), [a]);
    }

    #[test]
    fn a_planted_launcher_in_a_relative_path_entry_is_not_found() {
        // `claude.cmd` in the current directory, reachable only through a relative PATH entry.
        let here = tempfile::tempdir_in(".").expect("tempdir in cwd");
        let rel = here
            .path()
            .file_name()
            .map(PathBuf::from)
            .expect("relative name");
        std::fs::write(here.path().join("tool.cmd"), b"@echo planted").expect("write");
        std::fs::write(here.path().join("tool.exe"), b"").expect("write");
        assert!(
            rel.join("tool.cmd").is_file(),
            "relative entry resolves from the cwd"
        );
        let e = env(&[("PATH", rel.to_str().expect("utf8"))], true);
        let dirs = e.search_dirs(&SPEC);
        assert!(dirs.is_empty(), "{dirs:?}");
        assert_eq!(
            resolve_executable("tool", &[rel], &e.extensions()),
            None,
            "relative folders are never searched, even when passed directly"
        );
    }

    #[test]
    fn native_executables_win_over_script_launchers_on_any_folder() {
        let first = tempfile::tempdir().expect("tempdir");
        let second = tempfile::tempdir().expect("tempdir");
        let dirs = [first.path().to_path_buf(), second.path().to_path_buf()];
        let exts = [".exe".to_owned(), ".cmd".to_owned()];
        std::fs::write(second.path().join("tool.exe"), b"").expect("write");
        std::fs::write(second.path().join("tool.cmd"), b"").expect("write");
        assert_eq!(
            resolve_executable("tool", &dirs, &exts),
            Some(second.path().join("tool.exe"))
        );
        // An npm shim earlier on PATH does not beat the native launcher later on PATH.
        std::fs::write(first.path().join("tool.cmd"), b"").expect("write");
        assert_eq!(
            resolve_executable("tool", &dirs, &exts),
            Some(second.path().join("tool.exe"))
        );
        // Without any native executable the first script launcher is used.
        std::fs::remove_file(second.path().join("tool.exe")).expect("rm");
        assert_eq!(
            resolve_executable("tool", &dirs, &exts),
            Some(first.path().join("tool.cmd"))
        );
        // Among native executables, PATH order wins.
        std::fs::write(first.path().join("tool.exe"), b"").expect("write");
        std::fs::write(second.path().join("tool.exe"), b"").expect("write");
        assert_eq!(
            resolve_executable("tool", &dirs, &exts),
            Some(first.path().join("tool.exe"))
        );
        assert_eq!(resolve_executable("other", &dirs, &exts), None);
    }

    #[test]
    fn directories_named_like_the_tool_are_not_executables() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir(dir.path().join("tool")).expect("mkdir");
        assert_eq!(
            resolve_executable("tool", &[dir.path().to_path_buf()], &[String::new()]),
            None
        );
    }

    #[test]
    fn missing_executable_is_not_installed() {
        let empty = tempfile::tempdir().expect("tempdir");
        let e = env(
            &[("PATH", empty.path().to_str().expect("utf8"))],
            cfg!(windows),
        );
        let result = detect(&SPEC, &e);
        assert_eq!(result.detection.state, DetectionState::NotInstalled);
        assert_eq!(result.detection.auth, AuthState::Unknown);
        assert!(result.executable.is_none());
        assert!(!result.detection.checked_at.is_empty());
    }

    #[cfg(unix)]
    fn write_executable(path: &Path, body: &str) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(path, body).expect("write");
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    }

    /// npm, Homebrew and the nodejs.org installer link a CLI's `#!/usr/bin/env node` script into
    /// the folder that holds `node`. A Finder-launched app's `PATH` (`/usr/bin:/bin:...`) has no
    /// `node`, so running the link directly fails with `env: node: No such file or directory`.
    #[cfg(unix)]
    #[test]
    fn env_node_scripts_run_with_the_node_beside_them_under_a_minimal_path() {
        let root = tempfile::tempdir().expect("tempdir");
        let bin = root.path().join("bin");
        let pkg = root.path().join("lib/node_modules/tool/bin");
        let finder_path = root.path().join("finder-path");
        for dir in [&bin, &pkg, &finder_path] {
            std::fs::create_dir_all(dir).expect("mkdir");
        }
        write_executable(
            &pkg.join("cli.js"),
            "#!/usr/bin/env node\nconsole.log('tool 1.2.3')\n",
        );
        std::os::unix::fs::symlink("../lib/node_modules/tool/bin/cli.js", bin.join("tool"))
            .expect("symlink");
        let install_dir: &'static str = Box::leak(bin.to_str().expect("utf8").into());
        let spec = DetectionSpec {
            install_dirs: Box::leak(vec![install_dir].into_boxed_slice()),
            ..SPEC
        };
        // The folder holding the CLI is found through the documented install folders only; the
        // child `PATH` can't provide `node`.
        let e = env(&[("PATH", finder_path.to_str().expect("utf8"))], false);

        // No `node` next to the CLI: an actionable error, not `exited with code 127`.
        let missing = detect(&spec, &e);
        assert_eq!(missing.detection.state, DetectionState::Error);
        assert_eq!(missing.error_code, Some("node_not_found"));
        let message = missing.detection.message.expect("message");
        assert!(
            message.starts_with("Node.js for Test tool was not found next to "),
            "{message}"
        );
        assert!(
            message.contains(&display_path(&bin.join("tool"))),
            "{message}"
        );

        // `node` next to the CLI (a stand-in that checks it was handed the script).
        write_executable(
            &bin.join("node"),
            "#!/bin/sh\ncase \"$1\" in */lib/node_modules/tool/bin/cli.js) ;; *) exit 9 ;; esac\n\
             [ \"$2\" = --version ] || exit 8\necho 'tool 1.2.3'\n",
        );
        let found = detect(&spec, &e);
        assert_eq!(
            found.detection.state,
            DetectionState::Installed,
            "{:?} {:?}",
            found.error_code,
            found.detection.message
        );
        assert_eq!(found.detection.version.as_deref(), Some("1.2.3"));
    }

    /// npm's layout under `bin`: `bin/tool` -> `../lib/node_modules/tool/bin/cli.js`, and a
    /// stand-in `bin/node` that reports `tool <version>` for `--version`.
    #[cfg(unix)]
    fn npm_install(bin: &Path, version: &str) {
        let pkg = bin.join("../lib/node_modules/tool/bin");
        std::fs::create_dir_all(&pkg).expect("mkdir");
        write_executable(&pkg.join("cli.js"), "#!/usr/bin/env node\n");
        std::os::unix::fs::symlink("../lib/node_modules/tool/bin/cli.js", bin.join("tool"))
            .expect("symlink");
        write_executable(
            &bin.join("node"),
            &format!("#!/bin/sh\n[ \"$2\" = --version ] || exit 8\necho 'tool {version}'\n"),
        );
    }

    /// Detection with a Finder-style `PATH` and `home` as the home folder.
    #[cfg(unix)]
    fn detect_in_home(home: &Path) -> Detected {
        let finder_path = home.join("finder-path");
        std::fs::create_dir_all(&finder_path).expect("mkdir");
        let e = env(
            &[
                ("PATH", finder_path.to_str().expect("utf8")),
                ("HOME", home.to_str().expect("utf8")),
            ],
            false,
        );
        detect(&SPEC, &e)
    }

    #[cfg(unix)]
    #[test]
    fn npm_global_and_volta_user_folders_are_searched() {
        for rel in [".npm-global/bin", ".volta/bin"] {
            let home = tempfile::tempdir().expect("tempdir");
            let bin = home.path().join(rel);
            std::fs::create_dir_all(&bin).expect("mkdir");
            npm_install(&bin, "4.5.6");
            let found = detect_in_home(home.path());
            assert_eq!(
                found.detection.state,
                DetectionState::Installed,
                "{rel}: {:?} {:?}",
                found.error_code,
                found.detection.message
            );
            assert_eq!(found.detection.version.as_deref(), Some("4.5.6"), "{rel}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn only_nvms_default_version_is_searched() {
        let home = tempfile::tempdir().expect("tempdir");
        let versions = home.path().join(".nvm/versions/node");
        for version in ["20.5.0", "22.1.0"] {
            let bin = versions.join(format!("v{version}/bin"));
            std::fs::create_dir_all(&bin).expect("mkdir");
            npm_install(&bin, version);
        }
        // No default alias: nothing is guessed.
        assert_eq!(
            detect_in_home(home.path()).detection.state,
            DetectionState::NotInstalled
        );
        // default -> lts/* -> lts/iron -> v20.5.0, although 22.1.0 is newer.
        let alias = home.path().join(".nvm/alias");
        std::fs::create_dir_all(alias.join("lts")).expect("mkdir");
        std::fs::write(alias.join("default"), "lts/*\n").expect("alias");
        std::fs::write(alias.join("lts/*"), "lts/iron\n").expect("alias");
        std::fs::write(alias.join("lts/iron"), "v20.5.0\n").expect("alias");
        let found = detect_in_home(home.path());
        assert_eq!(found.detection.state, DetectionState::Installed);
        assert_eq!(found.detection.version.as_deref(), Some("20.5.0"));
        // default -> node: the highest installed version.
        std::fs::write(alias.join("default"), "node").expect("alias");
        let found = detect_in_home(home.path());
        assert_eq!(found.detection.version.as_deref(), Some("22.1.0"));
    }
}
