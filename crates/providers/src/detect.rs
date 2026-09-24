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

use crate::env::{EnvPolicy, lookup, sanitized_env};
use crate::process::{ProcessError, ProcessSpec, run_probe};
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
}

impl DetectEnv {
    pub fn from_process() -> Self {
        Self {
            vars: std::env::vars_os().collect(),
            windows: cfg!(windows),
            probe_timeout: None,
        }
    }

    fn var(&self, name: &str) -> Option<&OsStr> {
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

    fn home(&self) -> Option<PathBuf> {
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

    /// `PATH` entries followed by the provider's documented install folders.
    fn search_dirs(&self, spec: &DetectionSpec) -> Vec<PathBuf> {
        let mut dirs: Vec<PathBuf> = self
            .var("PATH")
            .map(|p| std::env::split_paths(p).collect())
            .unwrap_or_default();
        let home = self.home();
        for dir in spec.install_dirs {
            let path = Path::new(dir);
            if path.is_absolute() {
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
        dirs.retain(|d| !d.as_os_str().is_empty());
        dirs
    }

    /// The sanitized environment a provider process gets.
    pub fn provider_env(&self, policy: &EnvPolicy) -> BTreeMap<OsString, OsString> {
        sanitized_env(self.vars.iter().cloned(), policy)
    }
}

/// Finds the first existing file named `name` + one of `extensions` in `dirs` (in order).
pub fn resolve_executable(name: &str, dirs: &[PathBuf], extensions: &[String]) -> Option<PathBuf> {
    dirs.iter().find_map(|dir| {
        extensions.iter().find_map(|ext| {
            let candidate = dir.join(format!("{name}{ext}"));
            candidate.is_file().then_some(candidate)
        })
    })
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

    let dirs = env.search_dirs(spec);
    let executable = resolve_executable(spec.executable, &dirs, &env.extensions());
    if let Some(exe) = &executable {
        detection.display_path = Some(display_path(exe));
        let provider_env = env.provider_env(&spec.env_policy);
        match probe_version(
            exe,
            &provider_env,
            env.probe_timeout.unwrap_or(VERSION_TIMEOUT),
        ) {
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
                        exe,
                        auth,
                        &provider_env,
                        env.probe_timeout.unwrap_or(AUTH_TIMEOUT),
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
    exe: &Path,
    env: &BTreeMap<OsString, OsString>,
    timeout: Duration,
) -> Result<Version, (&'static str, String)> {
    let output = run_probe(
        &spec_for(exe, &["--version"], env),
        timeout,
        true,
        MAX_PROBE_OUTPUT,
    )
    .map_err(|error| match error {
        ProcessError::TimedOut(_) => (
            "version_timeout",
            "The version check didn't finish in time.".to_owned(),
        ),
        ProcessError::Spawn(e) => {
            tracing::warn!(event = "provider.version_spawn_failed", error = %e);
            (
                "version_spawn_failed",
                "The program couldn't be started.".to_owned(),
            )
        }
        other => {
            tracing::warn!(event = "provider.version_failed", error = %other);
            ("version_failed", "The version check failed.".to_owned())
        }
    })?;
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
    Version::find_in(&output.stdout).ok_or((
        "version_unrecognized",
        "The version check printed something KalCode doesn't recognize.".to_owned(),
    ))
}

fn probe_auth(
    exe: &Path,
    probe: &AuthProbe,
    env: &BTreeMap<OsString, OsString>,
    timeout: Duration,
) -> AuthState {
    let capture = matches!(probe.signal, AuthSignal::StatusLine { .. });
    let output = match run_probe(
        &spec_for(exe, probe.args, env),
        timeout,
        capture,
        MAX_PROBE_OUTPUT,
    ) {
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

    #[test]
    fn search_dirs_put_path_first_then_documented_locations() {
        let sep = if cfg!(windows) { ";" } else { ":" };
        let path = format!("/a{sep}/b");
        let e = env(
            &[
                ("PATH", &path),
                ("USERPROFILE", "/home/u"),
                ("APPDATA", "/roaming"),
            ],
            true,
        );
        let dirs = e.search_dirs(&SPEC);
        assert_eq!(
            dirs,
            [
                PathBuf::from("/a"),
                PathBuf::from("/b"),
                Path::new("/home/u").join(".local/bin"),
                Path::new("/roaming").join("npm"),
            ]
        );
    }

    #[test]
    fn resolves_in_directory_order_then_extension_order() {
        let first = tempfile::tempdir().expect("tempdir");
        let second = tempfile::tempdir().expect("tempdir");
        std::fs::write(second.path().join("tool.exe"), b"").expect("write");
        std::fs::write(second.path().join("tool.cmd"), b"").expect("write");
        let dirs = [first.path().to_path_buf(), second.path().to_path_buf()];
        let exts = [".exe".to_owned(), ".cmd".to_owned()];
        assert_eq!(
            resolve_executable("tool", &dirs, &exts),
            Some(second.path().join("tool.exe"))
        );
        std::fs::write(first.path().join("tool.cmd"), b"").expect("write");
        assert_eq!(
            resolve_executable("tool", &dirs, &exts),
            Some(first.path().join("tool.cmd"))
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
}
