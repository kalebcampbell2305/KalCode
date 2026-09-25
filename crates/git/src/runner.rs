//! Running the user's installed `git`.
//!
//! Every invocation follows the same rules (docs/campaigns/Z6a.md §Security):
//!
//! * **argv only.** `git` is started from an argument vector, never a shell string. Revisions and
//!   branch names are validated before they reach argv and are placed after `--end-of-options`
//!   where Git accepts it; paths are passed as literal pathspecs.
//! * **The user's git, located safely.** The executable is resolved once from absolute `PATH`
//!   entries only (never the current or workspace directory, never a `.cmd`/`.bat` shim).
//! * **Sanitized environment** ([`crate::env`]): `env_clear()` and an allow-list; every inherited
//!   `GIT_*` variable is dropped.
//! * **No repository code runs.** Command-line configuration (which outranks every config file)
//!   disables hooks (`core.hooksPath` → an empty KalCode-owned folder), the file-system monitor
//!   hook, pagers, credential helpers, signing programs, automatic maintenance, and every network
//!   transport except local `file` paths. Filter drivers defined by the repository's own config are
//!   neutralized per repository ([`crate::repo::Repo`]); diff commands add `--no-ext-diff` and
//!   `--no-textconv`; embedded bare repositories are refused (`safe.bareRepository=explicit`).
//! * **Bounded.** Every command has a timeout (the process is killed when it overruns) and a
//!   stdout cap (output beyond it is dropped and reported as truncated). stderr is kept as a
//!   redacted tail for logs and never shown to the user.

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use kalcode_core::logging::redact;
use kalcode_core::{ErrorCategory, KalError, Result};

use crate::env::sanitized_env;
use crate::paths::plain;

/// Oldest Git KalCode drives. 2.31 is the first release with every option used here
/// (`rev-parse --path-format`, `config --show-scope`, `--pathspec-from-file`,
/// `fetch --no-write-fetch-head`, `--end-of-options`).
pub const MIN_VERSION: GitVersion = GitVersion {
    major: 2,
    minor: 31,
    patch: 0,
};

/// Default time limit for one git command.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);
/// Default stdout cap for one git command.
pub const DEFAULT_MAX_STDOUT: usize = 64 * 1024 * 1024;
/// How much of the end of stderr is kept (redacted) for diagnostics.
const STDERR_TAIL_BYTES: usize = 8 * 1024;

/// A parsed `git version`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct GitVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl GitVersion {
    /// Parses `git version 2.45.1` / `git version 2.54.0.windows.1` / `git version 2.39.3 (Apple Git-146)`.
    pub fn parse(text: &str) -> Option<Self> {
        let rest = text.trim().strip_prefix("git version ")?;
        let mut numbers = rest
            .split(|c: char| !c.is_ascii_digit())
            .filter(|part| !part.is_empty())
            .map(|part| part.parse::<u32>().ok());
        Some(Self {
            major: numbers.next()??,
            minor: numbers.next()??,
            patch: numbers.next().flatten().unwrap_or(0),
        })
    }
}

impl std::fmt::Display for GitVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// The user's git executable plus KalCode's invocation policy. Cheap to share (`Arc<Git>`).
#[derive(Debug, Clone)]
pub struct Git {
    exe: PathBuf,
    version: GitVersion,
    hooks_dir: PathBuf,
    env: BTreeMap<OsString, OsString>,
}

pub(crate) fn git_error(code: &'static str, message: impl Into<String>) -> KalError {
    KalError::new(ErrorCategory::Git, code, message)
}

impl Git {
    /// Finds `git` on the process `PATH` (absolute entries only) and checks its version.
    /// `hooks_dir` becomes an empty, KalCode-owned folder used as `core.hooksPath` so that no
    /// repository hook ever runs for KalCode's own operations (created or emptied here).
    pub fn locate(hooks_dir: &Path) -> Result<Self> {
        let path = std::env::var_os("PATH").unwrap_or_default();
        let exe = find_on_path(&path).ok_or_else(|| {
            git_error(
                "git_not_found",
                "Git isn't installed or isn't on your PATH. Install Git to use Git features in KalCode.",
            )
        })?;
        Self::with_executable(exe, hooks_dir)
    }

    /// Uses a specific git executable (tests, or a path the user chose natively).
    pub fn with_executable(exe: PathBuf, hooks_dir: &Path) -> Result<Self> {
        if !exe.is_absolute() {
            return Err(git_error(
                "git_path_invalid",
                "KalCode needs the full path of the Git program.",
            ));
        }
        let hooks_dir = prepare_hooks_dir(hooks_dir)?;
        let mut git = Self {
            exe,
            version: MIN_VERSION,
            hooks_dir,
            env: sanitized_env(std::env::vars_os()),
        };
        let out = git
            .cmd()
            .arg("version")
            .timeout(Duration::from_secs(15))
            .run()?;
        let text = String::from_utf8_lossy(&out.stdout);
        let version = GitVersion::parse(&text).ok_or_else(|| {
            git_error(
                "git_version_unknown",
                "KalCode couldn't read the Git version.",
            )
        })?;
        if version < MIN_VERSION {
            return Err(git_error(
                "git_too_old",
                format!(
                    "Git {version} is too old for KalCode. Update Git to {MIN_VERSION} or newer."
                ),
            ));
        }
        git.version = version;
        tracing::info!(event = "git.located", version = %version);
        Ok(git)
    }

    pub fn version(&self) -> GitVersion {
        self.version
    }

    pub fn executable(&self) -> &Path {
        &self.exe
    }

    /// A new command with KalCode's hardening applied.
    pub(crate) fn cmd(&self) -> Cmd<'_> {
        Cmd {
            git: self,
            location: Vec::new(),
            config: Vec::new(),
            args: Vec::new(),
            env: Vec::new(),
            stdin: None,
            timeout: DEFAULT_TIMEOUT,
            max_stdout: DEFAULT_MAX_STDOUT,
            read_only: false,
        }
    }

    /// The configuration every KalCode git command carries (highest precedence in Git).
    fn hardening(&self) -> Vec<OsString> {
        let mut hooks = OsString::from("core.hooksPath=");
        hooks.push(plain(&self.hooks_dir).as_os_str());
        let mut args: Vec<OsString> = vec!["--no-pager".into(), "-c".into(), hooks];
        for setting in HARDENING {
            args.push("-c".into());
            args.push((*setting).into());
        }
        args
    }
}

/// Command-line configuration applied to every KalCode git command. See the module docs.
pub(crate) const HARDENING: &[&str] = &[
    "core.fsmonitor=false",
    "core.pager=cat",
    "core.askPass=",
    "credential.helper=",
    "protocol.allow=never",
    "protocol.file.allow=always",
    "commit.gpgSign=false",
    "tag.gpgSign=false",
    "log.showSignature=false",
    "gc.auto=0",
    "maintenance.auto=false",
    "core.quotePath=false",
    "color.ui=false",
    "submodule.recurse=false",
    "safe.bareRepository=explicit",
    "advice.detachedHead=false",
    // Git for Windows only (ignored elsewhere): allow paths beyond 260 characters.
    "core.longpaths=true",
];

fn prepare_hooks_dir(dir: &Path) -> Result<PathBuf> {
    let fs_error = |e: std::io::Error| {
        KalError::new(
            ErrorCategory::Filesystem,
            "git_hooks_dir_unavailable",
            "KalCode couldn't prepare its Git working folder.",
        )
        .with_source(e)
    };
    if !dir.is_absolute() {
        return Err(git_error(
            "git_hooks_dir_invalid",
            "KalCode's Git working folder must be an absolute path.",
        ));
    }
    if dir.exists() {
        // Whatever is in there is not ours to run: start from an empty folder every time.
        std::fs::remove_dir_all(dir).map_err(fs_error)?;
    }
    std::fs::create_dir_all(dir).map_err(fs_error)?;
    std::fs::canonicalize(dir).map_err(fs_error)
}

/// Finds the git executable in `path` (a `PATH` value). Relative entries are skipped, so the
/// current directory — possibly a hostile repository — is never searched.
pub fn find_on_path(path: &OsStr) -> Option<PathBuf> {
    let name = if cfg!(windows) { "git.exe" } else { "git" };
    std::env::split_paths(path)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(name))
        .find(|candidate| is_executable(candidate))
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.is_file())
}

/// Writes a command's stdin on its own thread (large inputs are streamed, not buffered).
pub(crate) type StdinWriter = Box<dyn FnOnce(&mut dyn Write) -> std::io::Result<()> + Send>;

/// One git invocation being built.
pub(crate) struct Cmd<'g> {
    git: &'g Git,
    location: Vec<OsString>,
    config: Vec<String>,
    args: Vec<OsString>,
    env: Vec<(OsString, OsString)>,
    stdin: Option<StdinWriter>,
    timeout: Duration,
    max_stdout: usize,
    read_only: bool,
}

/// What a finished git command produced.
#[derive(Debug)]
pub(crate) struct Output {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    /// stdout exceeded the cap; `stdout` holds the first `max_stdout` bytes.
    pub truncated: bool,
    /// Redacted end of stderr (logs only).
    pub stderr: String,
}

impl Output {
    pub fn stdout_text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
}

impl<'g> Cmd<'g> {
    /// Runs in `dir` (`git -C <dir>`).
    pub fn current_dir(mut self, dir: &Path) -> Self {
        self.location.push("-C".into());
        self.location.push(plain(dir).into_os_string());
        self
    }

    /// Explicit repository and work tree (the checkpoint shadow repository).
    pub fn git_dir(mut self, git_dir: &Path, work_tree: Option<&Path>) -> Self {
        let mut arg = OsString::from("--git-dir=");
        arg.push(plain(git_dir).as_os_str());
        self.location.push(arg);
        if let Some(tree) = work_tree {
            let mut arg = OsString::from("--work-tree=");
            arg.push(plain(tree).as_os_str());
            self.location.push(arg);
        }
        self
    }

    /// Extra `-c key=value` settings (after the hardening, so they cannot relax it: callers
    /// only ever pass neutralizing values).
    pub fn configs<I: IntoIterator<Item = String>>(mut self, settings: I) -> Self {
        self.config.extend(settings);
        self
    }

    pub fn arg(mut self, arg: impl Into<OsString>) -> Self {
        self.args.push(arg.into());
        self
    }

    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }

    /// A `GIT_*` variable KalCode intends (never inherited ones).
    pub fn env(mut self, name: &str, value: impl Into<OsString>) -> Self {
        self.env.push((name.into(), value.into()));
        self
    }

    pub fn stdin(mut self, input: Vec<u8>) -> Self {
        self.stdin = Some(Box::new(move |pipe: &mut dyn Write| pipe.write_all(&input)));
        self
    }

    /// Streams stdin from `writer` on a separate thread.
    pub fn stdin_stream(mut self, writer: StdinWriter) -> Self {
        self.stdin = Some(writer);
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn max_stdout(mut self, bytes: usize) -> Self {
        self.max_stdout = bytes;
        self
    }

    /// Read-only commands take no optional locks (`GIT_OPTIONAL_LOCKS=0`), so KalCode never
    /// contends with the user's own git for `index.lock` while only looking.
    pub fn read_only(mut self) -> Self {
        self.read_only = true;
        self
    }

    /// The full argv after the executable (for tests and diagnostics).
    pub fn argv(&self) -> Vec<OsString> {
        let mut argv = self.git.hardening();
        for setting in &self.config {
            argv.push("-c".into());
            argv.push(setting.into());
        }
        argv.extend(self.location.iter().cloned());
        argv.extend(self.args.iter().cloned());
        argv
    }

    /// Runs and fails with a classified error on a non-zero exit.
    pub fn run_ok(self, operation: &'static str) -> Result<Output> {
        let out = self.run()?;
        // A truncated command was stopped by KalCode after the cap: its output so far is valid.
        if out.status.success() || out.truncated {
            Ok(out)
        } else {
            Err(classify_failure(operation, &out))
        }
    }

    /// Runs and returns whatever git produced (non-zero exits included).
    pub fn run(self) -> Result<Output> {
        let argv = self.argv();
        let mut command = Command::new(&self.git.exe);
        command.env_clear().envs(&self.git.env);
        if self.read_only {
            command.env("GIT_OPTIONAL_LOCKS", "0");
        }
        for (name, value) in &self.env {
            command.env(name, value);
        }
        command
            .args(&argv)
            .stdin(if self.stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        platform::configure(&mut command);

        let started = Instant::now();
        let mut child = command.spawn().map_err(|e| {
            git_error("git_start_failed", "KalCode couldn't start Git.").with_source(e)
        })?;

        if let (Some(writer), Some(pipe)) = (self.stdin, child.stdin.take()) {
            thread::spawn(move || {
                let mut pipe = std::io::BufWriter::with_capacity(256 * 1024, pipe);
                if writer(&mut pipe).and_then(|()| pipe.flush()).is_err() {
                    tracing::debug!(event = "git.stdin_closed_early");
                }
                // Dropping the pipe closes git's stdin.
            });
        }

        let (out_tx, out_rx) = mpsc::channel();
        if let Some(mut pipe) = child.stdout.take() {
            let cap = self.max_stdout;
            thread::spawn(move || {
                let mut buffer = Vec::new();
                let mut chunk = vec![0u8; 64 * 1024];
                let mut truncated = false;
                loop {
                    match pipe.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let room = cap.saturating_sub(buffer.len());
                            if n > room {
                                buffer.extend_from_slice(&chunk[..room]);
                                truncated = true;
                                break;
                            }
                            buffer.extend_from_slice(&chunk[..n]);
                        }
                    }
                }
                let _ = out_tx.send((buffer, truncated));
            });
        }
        let (err_tx, err_rx) = mpsc::channel();
        if let Some(mut pipe) = child.stderr.take() {
            thread::spawn(move || {
                let mut tail: Vec<u8> = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    match pipe.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            tail.extend_from_slice(&chunk[..n]);
                            let excess = tail.len().saturating_sub(STDERR_TAIL_BYTES);
                            tail.drain(..excess);
                        }
                    }
                }
                let _ = err_tx.send(tail);
            });
        }

        let deadline = started + self.timeout;
        let (stdout, truncated) = match out_rx.recv_timeout(self.timeout) {
            Ok(result) => result,
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                tracing::warn!(
                    event = "git.timed_out",
                    timeout_ms = self.timeout.as_millis() as u64
                );
                return Err(
                    git_error("git_timed_out", "Git took too long and was stopped.").retryable(),
                );
            }
        };
        if truncated {
            // The reader stopped; don't let git block on a full pipe.
            let _ = child.kill();
        }
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() >= deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(
                        git_error("git_timed_out", "Git took too long and was stopped.")
                            .retryable(),
                    );
                }
                Ok(None) => thread::sleep(Duration::from_millis(2)),
                Err(e) => {
                    let _ = child.kill();
                    return Err(
                        git_error("git_wait_failed", "KalCode lost track of Git.").with_source(e)
                    );
                }
            }
        };
        let stderr = err_rx
            .recv_timeout(Duration::from_secs(2))
            .map(|tail| redact(&String::from_utf8_lossy(&tail)).into_owned())
            .unwrap_or_default();
        Ok(Output {
            status,
            stdout,
            truncated,
            stderr,
        })
    }
}

/// Git's (redacted) stderr, kept as the internal error source: it reaches logs and
/// diagnostics, never the user-facing message or the WebView.
#[derive(Debug)]
struct GitStderr(String);

impl std::fmt::Display for GitStderr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "git: {}", self.0.trim())
    }
}

impl std::error::Error for GitStderr {}

/// Maps a failed git command to a user-safe error. The stderr text goes to the log only.
pub(crate) fn classify_failure(operation: &'static str, out: &Output) -> KalError {
    classify_text(operation, out).with_source(GitStderr(out.stderr.clone()))
}

fn classify_text(operation: &'static str, out: &Output) -> KalError {
    let text = out.stderr.to_ascii_lowercase();
    tracing::warn!(
        event = "git.command_failed",
        operation,
        exit_code = out.status.code(),
        stderr = %out.stderr
    );
    if text.contains("not a git repository") {
        git_error("not_a_repository", "This folder isn't a Git repository.")
    } else if text.contains("dubious ownership") || text.contains("safe.directory") {
        git_error(
            "unsafe_repository",
            "Git refused this repository because it is owned by another user.",
        )
    } else if text.contains("index.lock") || text.contains(".lock': file exists") {
        git_error(
            "repository_locked",
            "Another Git process is using this repository. Try again in a moment.",
        )
        .retryable()
    } else if text.contains("unknown revision")
        || text.contains("bad revision")
        || text.contains("invalid object name")
        || text.contains("not a valid object name")
    {
        git_error(
            "unknown_revision",
            "Git doesn't know that commit or branch.",
        )
    } else if text.contains("already exists") {
        git_error("already_exists", "That branch or folder already exists.")
    } else {
        git_error(
            operation_code(operation),
            "Git couldn't complete the operation.",
        )
    }
}

fn operation_code(operation: &'static str) -> &'static str {
    match operation {
        "status" => "status_failed",
        "diff" => "diff_failed",
        "log" => "log_failed",
        "branches" => "branches_failed",
        "worktree" => "worktree_failed",
        "checkpoint" => "checkpoint_failed",
        "restore" => "restore_failed",
        "discover" => "discover_failed",
        _ => "git_failed",
    }
}

#[cfg(windows)]
mod platform {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    /// No console window for git started from the GUI app.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    pub fn configure(command: &mut Command) {
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

#[cfg(not(windows))]
mod platform {
    use std::process::Command;

    pub fn configure(_command: &mut Command) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_versions_from_every_platform() {
        let v = |s| GitVersion::parse(s);
        assert_eq!(
            v("git version 2.54.0.windows.1"),
            Some(GitVersion {
                major: 2,
                minor: 54,
                patch: 0
            })
        );
        assert_eq!(
            v("git version 2.39.3 (Apple Git-146)\n"),
            Some(GitVersion {
                major: 2,
                minor: 39,
                patch: 3
            })
        );
        assert_eq!(
            v("git version 2.31"),
            Some(GitVersion {
                major: 2,
                minor: 31,
                patch: 0
            })
        );
        assert_eq!(v("hello"), None);
        assert!(v("git version 2.30.9").is_some_and(|v| v < MIN_VERSION));
    }

    #[test]
    fn path_search_skips_relative_entries() {
        let dir = tempfile::tempdir().expect("tempdir");
        let name = if cfg!(windows) { "git.exe" } else { "git" };
        let fake = dir.path().join(name);
        std::fs::write(&fake, b"").expect("write");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        }
        // A relative entry naming the same folder is ignored.
        let cwd_relative = std::env::join_paths(["."]).expect("join");
        assert_eq!(find_on_path(&cwd_relative), None);
        let absolute = std::env::join_paths([dir.path()]).expect("join");
        assert_eq!(find_on_path(&absolute), Some(fake));
    }

    #[test]
    fn hardening_disables_hooks_and_code_running_settings() {
        let dir = tempfile::tempdir().expect("tempdir");
        let git = Git {
            exe: PathBuf::from("/usr/bin/git"),
            version: MIN_VERSION,
            hooks_dir: dir.path().to_path_buf(),
            env: BTreeMap::new(),
        };
        let argv: Vec<String> = git
            .cmd()
            .configs(["filter.lfs.clean=".to_owned()])
            .current_dir(Path::new("/repo"))
            .arg("status")
            .argv()
            .into_iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(argv[0], "--no-pager");
        assert!(argv.iter().any(|a| a.starts_with("core.hooksPath=")));
        for needed in [
            "core.fsmonitor=false",
            "protocol.allow=never",
            "safe.bareRepository=explicit",
        ] {
            assert!(
                argv.iter().any(|a| a == needed),
                "{needed} missing: {argv:?}"
            );
        }
        // Neutralizing settings come after the hardening; the subcommand comes last.
        let filter = argv
            .iter()
            .position(|a| a == "filter.lfs.clean=")
            .expect("filter");
        let hooks = argv
            .iter()
            .position(|a| a.starts_with("core.hooksPath="))
            .expect("hooks");
        assert!(filter > hooks);
        assert_eq!(argv.last().map(String::as_str), Some("status"));
    }
}
