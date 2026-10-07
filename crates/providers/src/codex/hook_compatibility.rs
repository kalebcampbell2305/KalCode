//! Optional Codex observing-hook compatibility, proved from the installed binary.
//!
//! Hook support is deliberately independent from the core Codex capability probe. A pane must
//! appear immediately, so a cache miss starts one bounded background probe and returns
//! [`CapabilitySupport::Unknown`]. Callers keep the existing `notify` fallback until the exact
//! binary installation has proved the session-flags hook contract. No version number grants hook
//! support.
//!
//! The probe is read-only and credential-free. It starts `app-server` in a fresh `CODEX_HOME`,
//! configures six inert session-flag commands, and asks `hooks/list` to report the resolved
//! command, matcher, timeout, trust key/hash, source, and enabled/async state. It never starts a
//! model turn, invokes a hook, contacts a provider, or reads the user's Codex home.

use std::collections::{BTreeMap, HashMap};
use std::ffi::{OsStr, OsString};
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime};

use kalcode_hook_bridge::HookEvent;
use kalcode_hook_bridge::codex::{hook_command, pane_plan, session_overrides, trust_hash};
use serde_json::{Value, json};
use uuid::Uuid;

use super::compatibility::CapabilitySupport;
use crate::guardian::ProviderProbeGuardian;
use crate::process::{OutputLine, ProcessSpec, SupervisedChild, recv_until};
use crate::version::Version;

const MAX_CACHE_ENTRIES: usize = 64;
const MAX_BACKGROUND_PROBES: usize = 2;
const MAX_PROTOCOL_LINE_BYTES: usize = 1024 * 1024;
const MAX_IGNORED_MESSAGES: usize = 64;
const PROTOCOL_TIMEOUT: Duration = Duration::from_secs(8);
const CLEANUP_GRACE: Duration = Duration::from_millis(250);
const RETRY_TRANSIENT_AFTER: Duration = Duration::from_secs(60);
const PROBE_ENDPOINT: &str = "kalcode-hook-compatibility-probe";
const PROBE_SESSION: &str = "kalcode-hook-compatibility-probe";

const RUNTIME_ENV_NAMES: &[&str] = &[
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "COMSPEC",
    "HOME",
    "USERPROFILE",
    "CODEX_MANAGED_PACKAGE_ROOT",
    "CODEX_MANAGED_BY_NPM",
    "CODEX_MANAGED_BY_PNPM",
    "CODEX_MANAGED_BY_BUN",
    "CODEX_MANAGED_BY_VITE_PLUS",
];

/// Returns the result cached for this exact installed binary and starts at most one background
/// probe on a cache miss. This function never waits for a provider process.
///
/// `neutral_root` is a KalCode-owned directory under which the probe may create its disposable
/// home. `None` uses the OS temporary directory. Managed callers should pass their compatibility
/// probe directory and guardian; unmanaged panes still receive process-tree supervision from
/// [`SupervisedChild`]. Signed compatibility policy is checked before both cache lookup and
/// warming, so binary capability can never override a declarative policy disable.
pub fn cached_or_warm(
    executable: &Path,
    env: &BTreeMap<OsString, OsString>,
    neutral_root: Option<&Path>,
    guardian: Option<ProviderProbeGuardian>,
    version: Option<&Version>,
) -> CapabilitySupport {
    if !policy_allows_hooks(version) {
        return CapabilitySupport::Unsupported;
    }
    let Some(stamp) = BinaryStamp::of(executable, env) else {
        return CapabilitySupport::Unknown;
    };

    let now = Instant::now();
    let permit = {
        let mut cache = lock(&CACHE.entries);
        match cache.get(&stamp) {
            Some(CacheEntry::Ready { support, retry_at })
                if retry_at.is_none_or(|retry_at| retry_at > now) =>
            {
                return *support;
            }
            Some(CacheEntry::Probing) => return CapabilitySupport::Unknown,
            _ => {}
        }

        let Some(permit) = BackgroundPermit::try_acquire() else {
            return CapabilitySupport::Unknown;
        };
        evict_one_ready_if_full(&mut cache);
        cache.insert(stamp.clone(), CacheEntry::Probing);
        permit
    };

    let executable = executable.to_path_buf();
    let env = env.clone();
    let neutral_root = neutral_root.map(Path::to_path_buf);
    let stamp_for_failure = stamp.clone();
    let worker = std::thread::Builder::new()
        .name("codex-hook-compat".to_owned())
        .spawn(move || {
            let _permit = permit;
            let outcome = probe(&executable, &env, neutral_root.as_deref(), guardian);
            finish_probe(stamp, &executable, &env, outcome);
        });
    if worker.is_err() {
        let mut cache = lock(&CACHE.entries);
        if matches!(cache.get(&stamp_for_failure), Some(CacheEntry::Probing)) {
            cache.remove(&stamp_for_failure);
        }
        // The closure owns the permit, so `Builder::spawn` releases it even on failure.
    }
    CapabilitySupport::Unknown
}

/// Runs the same bounded probe synchronously and records its result. This exists for explicit
/// startup prewarming and real-provider certification; ordinary pane admission uses
/// [`cached_or_warm`] and never waits.
pub fn probe_and_cache(
    executable: &Path,
    env: &BTreeMap<OsString, OsString>,
    neutral_root: Option<&Path>,
    guardian: Option<ProviderProbeGuardian>,
    version: Option<&Version>,
) -> CapabilitySupport {
    if !policy_allows_hooks(version) {
        return CapabilitySupport::Unsupported;
    }
    let Some(stamp) = BinaryStamp::of(executable, env) else {
        return CapabilitySupport::Unknown;
    };
    let now = Instant::now();
    let permit = {
        let mut cache = lock(&CACHE.entries);
        match cache.get(&stamp) {
            Some(CacheEntry::Ready { support, retry_at })
                if retry_at.is_none_or(|retry_at| retry_at > now) =>
            {
                return *support;
            }
            Some(CacheEntry::Probing) => return CapabilitySupport::Unknown,
            _ => {}
        }
        let Some(permit) = BackgroundPermit::try_acquire() else {
            return CapabilitySupport::Unknown;
        };
        evict_one_ready_if_full(&mut cache);
        cache.insert(stamp.clone(), CacheEntry::Probing);
        permit
    };
    let outcome = probe(executable, env, neutral_root, guardian);
    drop(permit);
    finish_probe(stamp, executable, env, outcome)
}

/// Applies signed disable-only provider policy to the locally provable optional hook capability.
/// A manifest can remove `observing_hooks`; it can never manufacture support.
pub fn policy_allows_hooks(version: Option<&Version>) -> bool {
    let Some(version) = version else {
        return false;
    };
    let facts = crate::compatibility::ProbeFacts {
        capabilities: ["observing_hooks".to_owned()].into_iter().collect(),
        protocols: BTreeMap::new(),
    };
    crate::compatibility::evaluate_active(
        kalcode_contracts::agent::ProviderId::CODEX,
        &version.to_string(),
        &facts,
    )
    .is_ok_and(|decision| {
        decision.status.is_usable() && decision.effective_capabilities.contains("observing_hooks")
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct BinaryStamp {
    files: Vec<BinaryFileStamp>,
    runtime_env: Vec<(OsString, OsString)>,
}

type BinaryFileStamp = (
    PathBuf,
    u64,
    Option<SystemTime>,
    Option<SystemTime>,
    FileIdentity,
);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum FileIdentity {
    #[cfg(windows)]
    Windows { volume: u32, index: u64 },
    #[cfg(unix)]
    Unix { device: u64, inode: u64 },
    #[cfg(not(any(unix, windows)))]
    Unsupported,
}

impl BinaryStamp {
    fn of(executable: &Path, env: &BTreeMap<OsString, OsString>) -> Option<Self> {
        let platform = crate::managed_runtime::RuntimePlatform::current().ok()?;
        let layout =
            crate::managed_runtime::resolve_codex_runtime_layout(executable, env, platform).ok()?;
        let launch = crate::launch::resolve(executable, env);
        let mut paths = vec![
            executable.to_path_buf(),
            launch.program,
            layout.source_root().join(layout.executable_relative()),
        ];
        paths.extend(
            launch
                .prefix_args
                .into_iter()
                .map(PathBuf::from)
                .filter(|path| path.is_absolute() && path.is_file()),
        );
        let mut paths = paths
            .into_iter()
            .map(|path| fs::canonicalize(path).ok())
            .collect::<Option<Vec<_>>>()?;
        paths.sort();
        paths.dedup();
        let files = paths
            .into_iter()
            .map(|path| binary_file_stamp(&path))
            .collect::<Option<Vec<_>>>()?;
        Some(Self {
            files,
            runtime_env: env
                .iter()
                .filter(|(name, _)| matches_name(name, RUNTIME_ENV_NAMES))
                .map(|(name, value)| (name.clone(), value.clone()))
                .collect(),
        })
    }
}

fn binary_file_stamp(path: &Path) -> Option<BinaryFileStamp> {
    let file = File::open(path).ok()?;
    let metadata = file.metadata().ok().filter(|metadata| metadata.is_file())?;
    let current = same_file::Handle::from_path(path).ok()?;
    let opened = same_file::Handle::from_file(file.try_clone().ok()?).ok()?;
    if current != opened {
        return None;
    }
    Some((
        path.to_path_buf(),
        metadata.len(),
        metadata.modified().ok(),
        metadata.created().ok(),
        file_identity(&file)?,
    ))
}

#[cfg(unix)]
fn file_identity(file: &File) -> Option<FileIdentity> {
    use std::os::unix::fs::MetadataExt as _;

    let metadata = file.metadata().ok()?;
    Some(FileIdentity::Unix {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn file_identity(file: &File) -> Option<FileIdentity> {
    use std::os::windows::io::AsRawHandle as _;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };

    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: `file` owns a live handle and `information` is writable storage of the exact
    // structure requested by GetFileInformationByHandle.
    unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &raw mut information) }
        .ok()?;
    Some(FileIdentity::Windows {
        volume: information.dwVolumeSerialNumber,
        index: (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow),
    })
}

#[cfg(not(any(unix, windows)))]
fn file_identity(_file: &File) -> Option<FileIdentity> {
    Some(FileIdentity::Unsupported)
}

#[derive(Debug, Clone, Copy)]
enum CacheEntry {
    Probing,
    Ready {
        support: CapabilitySupport,
        retry_at: Option<Instant>,
    },
}

#[derive(Default)]
struct HookCapabilityCache {
    entries: Mutex<HashMap<BinaryStamp, CacheEntry>>,
}

static CACHE: LazyLock<HookCapabilityCache> = LazyLock::new(HookCapabilityCache::default);
static ACTIVE_BACKGROUND_PROBES: AtomicUsize = AtomicUsize::new(0);

struct BackgroundPermit;

impl BackgroundPermit {
    fn try_acquire() -> Option<Self> {
        ACTIVE_BACKGROUND_PROBES
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
                (active < MAX_BACKGROUND_PROBES).then_some(active + 1)
            })
            .ok()
            .map(|_| Self)
    }
}

impl Drop for BackgroundPermit {
    fn drop(&mut self) {
        ACTIVE_BACKGROUND_PROBES.fetch_sub(1, Ordering::AcqRel);
    }
}

fn finish_probe(
    stamp: BinaryStamp,
    executable: &Path,
    env: &BTreeMap<OsString, OsString>,
    outcome: ProbeOutcome,
) -> CapabilitySupport {
    let mut cache = lock(&CACHE.entries);
    if BinaryStamp::of(executable, env).as_ref() != Some(&stamp) {
        cache.remove(&stamp);
        return CapabilitySupport::Unknown;
    }
    evict_one_ready_if_full(&mut cache);
    let support = outcome.support();
    cache.insert(
        stamp,
        CacheEntry::Ready {
            support,
            retry_at: matches!(outcome, ProbeOutcome::Transient)
                .then(|| Instant::now() + RETRY_TRANSIENT_AFTER),
        },
    );
    support
}

fn evict_one_ready_if_full(cache: &mut HashMap<BinaryStamp, CacheEntry>) {
    if cache.len() < MAX_CACHE_ENTRIES {
        return;
    }
    let victim = cache.iter().find_map(|(stamp, entry)| {
        matches!(entry, CacheEntry::Ready { .. }).then(|| stamp.clone())
    });
    if let Some(victim) = victim {
        cache.remove(&victim);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProbeOutcome {
    Supported,
    Incompatible,
    Transient,
}

impl ProbeOutcome {
    fn support(self) -> CapabilitySupport {
        match self {
            Self::Supported => CapabilitySupport::Supported,
            Self::Incompatible => CapabilitySupport::Unsupported,
            Self::Transient => CapabilitySupport::Unknown,
        }
    }
}

fn probe(
    executable: &Path,
    source_env: &BTreeMap<OsString, OsString>,
    neutral_root: Option<&Path>,
    guardian: Option<ProviderProbeGuardian>,
) -> ProbeOutcome {
    probe_with_timeout(
        executable,
        source_env,
        neutral_root,
        guardian,
        PROTOCOL_TIMEOUT,
    )
    .outcome
}

struct ProbeExecution {
    outcome: ProbeOutcome,
    #[cfg(test)]
    cleanup_complete: bool,
}

impl ProbeExecution {
    const fn without_child(outcome: ProbeOutcome) -> Self {
        Self {
            outcome,
            #[cfg(test)]
            cleanup_complete: true,
        }
    }
}

fn probe_with_timeout(
    executable: &Path,
    source_env: &BTreeMap<OsString, OsString>,
    neutral_root: Option<&Path>,
    guardian: Option<ProviderProbeGuardian>,
    protocol_timeout: Duration,
) -> ProbeExecution {
    let workspace = match ProbeWorkspace::create(neutral_root) {
        Ok(workspace) => workspace,
        Err(_) => return ProbeExecution::without_child(ProbeOutcome::Transient),
    };
    let probe_program = workspace.root.join(if cfg!(windows) {
        "kalcode-hook-probe.exe"
    } else {
        "kalcode-hook-probe"
    });
    let program = probe_program.to_string_lossy();
    let overrides = match session_overrides(&program, &[], PROBE_ENDPOINT, PROBE_SESSION) {
        Ok(overrides) => overrides,
        Err(_) => return ProbeExecution::without_child(ProbeOutcome::Incompatible),
    };
    let expected = match expected_hooks(&program) {
        Some(expected) => expected,
        None => return ProbeExecution::without_child(ProbeOutcome::Incompatible),
    };

    let mut args = Vec::new();
    for value in crate::codex::argv::PROBE_CONFIG {
        if *value == "features.hooks=false" {
            continue;
        }
        args.extend([OsString::from("-c"), OsString::from(value)]);
    }
    args.extend([OsString::from("-c"), OsString::from("features.hooks=true")]);
    for value in overrides {
        args.extend([OsString::from("-c"), OsString::from(value)]);
    }
    args.extend([OsString::from("app-server"), OsString::from("--stdio")]);

    let env = workspace.isolated_env(source_env);
    let spec = ProcessSpec {
        program: executable.to_path_buf(),
        args,
        cwd: Some(workspace.cwd.clone()),
        env,
    };
    let spawn = match guardian {
        Some(guardian) => {
            let admission = match guardian.prepare_job("codex-hook-compatibility") {
                Ok(admission) => admission,
                Err(_) => return ProbeExecution::without_child(ProbeOutcome::Transient),
            };
            SupervisedChild::spawn_guarded(&spec, admission)
        }
        None => SupervisedChild::spawn(&spec),
    };
    let (child, lines) = match spawn {
        Ok(spawned) => spawned,
        Err(_) => return ProbeExecution::without_child(ProbeOutcome::Transient),
    };

    let deadline = Instant::now() + protocol_timeout;
    let outcome = (|| {
        child
            .write_line(
                &json!({
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "clientInfo": {
                            "name": "kalcode-hook-compatibility",
                            "title": "KalCode Hook Compatibility",
                            "version": "1"
                        },
                        "capabilities": {"experimentalApi": false}
                    }
                })
                .to_string(),
            )
            .map_err(|_| ProbeOutcome::Transient)?;
        let initialized = response_result(&lines, 1, deadline)?;
        let reported_home = initialized
            .get("codexHome")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .ok_or(ProbeOutcome::Incompatible)?;
        if !same_existing_directory(&reported_home, &workspace.home) {
            return Err(ProbeOutcome::Incompatible);
        }
        child
            .write_line(&json!({"method": "initialized"}).to_string())
            .map_err(|_| ProbeOutcome::Transient)?;
        child
            .write_line(
                &json!({
                    "id": 2,
                    "method": "hooks/list",
                    "params": {"cwds": [workspace.cwd]}
                })
                .to_string(),
            )
            .map_err(|_| ProbeOutcome::Transient)?;
        let listed = response_result(&lines, 2, deadline)?;
        validate_hooks_list(&listed, &workspace.cwd, &expected)
    })();
    let cleanup = child.terminate(CLEANUP_GRACE);
    #[cfg(test)]
    let cleanup_complete = cleanup.is_ok();
    let outcome = match (outcome, cleanup) {
        (Ok(()), Ok(_)) => ProbeOutcome::Supported,
        (Err(outcome), _) => outcome,
        (Ok(()), Err(_)) => ProbeOutcome::Transient,
    };
    ProbeExecution {
        outcome,
        #[cfg(test)]
        cleanup_complete,
    }
}

fn response_result(
    lines: &std::sync::mpsc::Receiver<OutputLine>,
    id: i64,
    deadline: Instant,
) -> Result<Value, ProbeOutcome> {
    let mut ignored = 0usize;
    loop {
        match recv_until(lines, deadline) {
            Ok(OutputLine::Line(line)) if line.len() <= MAX_PROTOCOL_LINE_BYTES => {
                let message: Value =
                    serde_json::from_str(&line).map_err(|_| ProbeOutcome::Incompatible)?;
                if message.get("id").and_then(Value::as_i64) == Some(id) {
                    if message.get("error").is_some() {
                        return Err(ProbeOutcome::Incompatible);
                    }
                    return message
                        .get("result")
                        .cloned()
                        .ok_or(ProbeOutcome::Incompatible);
                }
                ignored += 1;
                if ignored > MAX_IGNORED_MESSAGES {
                    return Err(ProbeOutcome::Incompatible);
                }
            }
            Ok(OutputLine::Line(_)) | Ok(OutputLine::TooLong { .. }) => {
                return Err(ProbeOutcome::Incompatible);
            }
            Ok(OutputLine::Closed)
            | Err(std::sync::mpsc::RecvTimeoutError::Disconnected)
            | Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                return Err(ProbeOutcome::Transient);
            }
        }
    }
}

#[derive(Debug, Clone)]
struct ExpectedHook {
    event_name: &'static str,
    command: String,
    matcher: Option<&'static str>,
    timeout: u64,
    key: String,
    hash: String,
}

fn expected_hooks(program: &str) -> Option<Vec<ExpectedHook>> {
    HookEvent::CODEX
        .into_iter()
        .filter_map(|event| pane_plan(event).map(|run| (event, run)))
        .map(|(event, run)| {
            let command = hook_command(program, &[], event, PROBE_ENDPOINT, PROBE_SESSION).ok()?;
            let matcher = event.has_tool_matcher().then_some("*");
            let timeout = if event == HookEvent::Interrupt { 3 } else { 10 };
            Some(ExpectedHook {
                event_name: protocol_event_name(event)?,
                key: format!("{}:{}:0:0", session_flags_path(), trust_event_name(event)?),
                hash: trust_hash(event, matcher, &command, timeout, run),
                command,
                matcher,
                timeout,
            })
        })
        .collect()
}

fn validate_hooks_list(
    result: &Value,
    expected_cwd: &Path,
    expected: &[ExpectedHook],
) -> Result<(), ProbeOutcome> {
    let entries = result
        .get("data")
        .and_then(Value::as_array)
        .ok_or(ProbeOutcome::Incompatible)?;
    if entries.len() != 1 {
        return Err(ProbeOutcome::Incompatible);
    }
    let entry = &entries[0];
    let reported_cwd = entry
        .get("cwd")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or(ProbeOutcome::Incompatible)?;
    if !same_existing_directory(&reported_cwd, expected_cwd)
        || !empty_array(entry, "errors")
        || !empty_array(entry, "warnings")
    {
        return Err(ProbeOutcome::Incompatible);
    }
    let hooks = entry
        .get("hooks")
        .and_then(Value::as_array)
        .ok_or(ProbeOutcome::Incompatible)?;
    let mut matched = 0usize;
    for wanted in expected {
        let candidates: Vec<&Value> = hooks
            .iter()
            .filter(|hook| {
                hook.get("source").and_then(Value::as_str) == Some("sessionFlags")
                    && hook.get("eventName").and_then(Value::as_str) == Some(wanted.event_name)
            })
            .collect();
        if candidates.len() != 1 || !matches_expected_hook(candidates[0], wanted) {
            return Err(ProbeOutcome::Incompatible);
        }
        matched += 1;
    }
    let session_flag_count = hooks
        .iter()
        .filter(|hook| hook.get("source").and_then(Value::as_str) == Some("sessionFlags"))
        .count();
    (matched == expected.len() && session_flag_count == expected.len())
        .then_some(())
        .ok_or(ProbeOutcome::Incompatible)
}

fn matches_expected_hook(hook: &Value, wanted: &ExpectedHook) -> bool {
    hook.get("handlerType").and_then(Value::as_str) == Some("command")
        && hook.get("command").and_then(Value::as_str) == Some(wanted.command.as_str())
        && optional_string(hook.get("matcher")) == Some(wanted.matcher)
        && hook.get("timeoutSec").and_then(Value::as_u64) == Some(wanted.timeout)
        && hook.get("async").and_then(Value::as_bool) == Some(true)
        && hook.get("enabled").and_then(Value::as_bool) == Some(true)
        && hook.get("trustStatus").and_then(Value::as_str) == Some("trusted")
        && hook.get("currentHash").and_then(Value::as_str) == Some(wanted.hash.as_str())
        && hook.get("key").and_then(Value::as_str) == Some(wanted.key.as_str())
        && hook.get("sourcePath").and_then(Value::as_str) == Some(session_flags_path())
        && hook.get("isManaged").and_then(Value::as_bool) == Some(false)
        && hook.get("displayOrder").and_then(Value::as_i64).is_some()
}

fn optional_string(value: Option<&Value>) -> Option<Option<&str>> {
    match value {
        Some(Value::Null) => Some(None),
        Some(Value::String(value)) => Some(Some(value)),
        _ => None,
    }
}

fn empty_array(value: &Value, name: &str) -> bool {
    value
        .get(name)
        .and_then(Value::as_array)
        .is_some_and(Vec::is_empty)
}

fn protocol_event_name(event: HookEvent) -> Option<&'static str> {
    Some(match event {
        HookEvent::UserPromptSubmit => "userPromptSubmit",
        HookEvent::PreToolUse => "preToolUse",
        HookEvent::PermissionRequest => "permissionRequest",
        HookEvent::PostToolUse => "postToolUse",
        HookEvent::Stop => "stop",
        HookEvent::Interrupt => "interrupt",
        _ => return None,
    })
}

fn trust_event_name(event: HookEvent) -> Option<&'static str> {
    Some(match event {
        HookEvent::UserPromptSubmit => "user_prompt_submit",
        HookEvent::PreToolUse => "pre_tool_use",
        HookEvent::PermissionRequest => "permission_request",
        HookEvent::PostToolUse => "post_tool_use",
        HookEvent::Stop => "stop",
        HookEvent::Interrupt => "interrupt",
        _ => return None,
    })
}

fn session_flags_path() -> &'static str {
    if cfg!(windows) {
        r"C:\<session-flags>\config.toml"
    } else {
        "/<session-flags>/config.toml"
    }
}

fn matches_name(name: &OsStr, names: &[&str]) -> bool {
    name.to_str()
        .is_some_and(|name| names.iter().any(|wanted| name.eq_ignore_ascii_case(wanted)))
}

fn same_existing_directory(left: &Path, right: &Path) -> bool {
    left.is_dir() && right.is_dir() && same_file::is_same_file(left, right).unwrap_or(false)
}

struct ProbeWorkspace {
    root: PathBuf,
    home: PathBuf,
    cwd: PathBuf,
    config: PathBuf,
    cache: PathBuf,
    data: PathBuf,
    temp: PathBuf,
}

impl ProbeWorkspace {
    fn create(neutral_root: Option<&Path>) -> std::io::Result<Self> {
        let parent = neutral_root
            .map(Path::to_path_buf)
            .unwrap_or_else(std::env::temp_dir);
        fs::create_dir_all(&parent)?;
        let parent_metadata = fs::symlink_metadata(&parent)?;
        if !parent_metadata.is_dir() || parent_metadata.file_type().is_symlink() {
            return Err(std::io::Error::other(
                "Codex hook probe parent is not an ordinary directory",
            ));
        }
        for _ in 0..4 {
            let root = parent.join(format!(".kalcode-codex-hook-compat-{}", Uuid::new_v4()));
            match fs::create_dir(&root) {
                Ok(()) => {
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt as _;
                        if let Err(error) =
                            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
                        {
                            let _ = fs::remove_dir_all(&root);
                            return Err(error);
                        }
                    }
                    let home = root.join("home");
                    let cwd = root.join("cwd");
                    let config = root.join("config");
                    let cache = root.join("cache");
                    let data = root.join("data");
                    let temp = root.join("temp");
                    if let Err(error) = [&home, &cwd, &config, &cache, &data, &temp]
                        .into_iter()
                        .try_for_each(fs::create_dir)
                    {
                        let _ = fs::remove_dir_all(&root);
                        return Err(error);
                    }
                    return Ok(Self {
                        root,
                        home,
                        cwd,
                        config,
                        cache,
                        data,
                        temp,
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            }
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "could not create a unique Codex hook probe directory",
        ))
    }

    fn isolated_env(&self, source: &BTreeMap<OsString, OsString>) -> BTreeMap<OsString, OsString> {
        const PASSTHROUGH: &[&str] = &[
            "PATH",
            "PATHEXT",
            "SYSTEMROOT",
            "WINDIR",
            "COMSPEC",
            "LANG",
            "LC_ALL",
            "LC_CTYPE",
            "TERM",
            "COLORTERM",
            "NO_COLOR",
            "CODEX_MANAGED_PACKAGE_ROOT",
            "CODEX_MANAGED_BY_NPM",
            "CODEX_MANAGED_BY_PNPM",
            "CODEX_MANAGED_BY_BUN",
            "CODEX_MANAGED_BY_VITE_PLUS",
        ];
        let mut env = source
            .iter()
            .filter(|(name, _)| matches_name(name, PASSTHROUGH))
            .map(|(name, value)| (name.clone(), value.clone()))
            .collect::<BTreeMap<_, _>>();
        let home = self.home.clone().into_os_string();
        env.insert("CODEX_HOME".into(), home.clone());
        env.insert("HOME".into(), home.clone());
        env.insert("USERPROFILE".into(), home);
        env.insert(
            "XDG_CONFIG_HOME".into(),
            self.config.clone().into_os_string(),
        );
        env.insert("XDG_CACHE_HOME".into(), self.cache.clone().into_os_string());
        env.insert("XDG_DATA_HOME".into(), self.data.clone().into_os_string());
        for name in ["TEMP", "TMP", "TMPDIR"] {
            env.insert(name.into(), self.temp.clone().into_os_string());
        }
        env
    }
}

impl Drop for ProbeWorkspace {
    fn drop(&mut self) {
        let Some(parent) = self.root.parent() else {
            return;
        };
        let safe_name = self
            .root
            .file_name()
            .and_then(OsStr::to_str)
            .is_some_and(|name| name.starts_with(".kalcode-codex-hook-compat-"));
        if safe_name && self.root.starts_with(parent) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(all(windows, target_arch = "x86_64"))]
    const PLATFORM_PACKAGE: (&str, &str, &str) =
        ("codex-win32-x64", "x86_64-pc-windows-msvc", "codex.exe");
    #[cfg(all(windows, target_arch = "aarch64"))]
    const PLATFORM_PACKAGE: (&str, &str, &str) =
        ("codex-win32-arm64", "aarch64-pc-windows-msvc", "codex.exe");
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    const PLATFORM_PACKAGE: (&str, &str, &str) =
        ("codex-darwin-x64", "x86_64-apple-darwin", "codex");
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    const PLATFORM_PACKAGE: (&str, &str, &str) =
        ("codex-darwin-arm64", "aarch64-apple-darwin", "codex");
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    const PLATFORM_PACKAGE: (&str, &str, &str) =
        ("codex-linux-x64", "x86_64-unknown-linux-musl", "codex");
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    const PLATFORM_PACKAGE: (&str, &str, &str) =
        ("codex-linux-arm64", "aarch64-unknown-linux-musl", "codex");

    fn hanging_provider(root: &Path) -> PathBuf {
        #[cfg(windows)]
        let (path, contents) = (
            root.join("codex.cmd"),
            "@echo off\r\n\"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -NoLogo -NoProfile -NonInteractive -Command \"Start-Sleep -Seconds 30\"\r\n",
        );
        #[cfg(not(windows))]
        let (path, contents) = (root.join("codex"), "#!/bin/sh\nsleep 30\n");
        fs::write(&path, contents).expect("fake provider");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).expect("executable");
        }
        path
    }

    fn fixture(root: &Path) -> (PathBuf, Vec<ExpectedHook>, Value) {
        let cwd = root.join("cwd");
        fs::create_dir_all(&cwd).expect("cwd");
        let program = root.join(if cfg!(windows) {
            "kalcode-hook-probe.exe"
        } else {
            "kalcode-hook-probe"
        });
        let program = program.to_string_lossy();
        let expected = expected_hooks(&program).expect("expected hooks");
        let hooks: Vec<Value> = expected
            .iter()
            .enumerate()
            .map(|(display_order, hook)| {
                json!({
                    "additionalContextLimit": null,
                    "async": true,
                    "command": hook.command,
                    "currentHash": hook.hash,
                    "displayOrder": display_order as i64,
                    "enabled": true,
                    "eventName": hook.event_name,
                    "handlerType": "command",
                    "isManaged": false,
                    "key": hook.key,
                    "matcher": hook.matcher,
                    "pluginId": null,
                    "source": "sessionFlags",
                    "sourcePath": session_flags_path(),
                    "statusMessage": null,
                    "timeoutSec": hook.timeout,
                    "trustStatus": "trusted"
                })
            })
            .collect();
        let result = json!({
            "data": [{
                "cwd": cwd,
                "errors": [],
                "hooks": hooks,
                "warnings": []
            }]
        });
        (cwd, expected, result)
    }

    #[test]
    fn exact_session_flag_contract_is_supported_without_a_version_gate() {
        let root = tempfile::tempdir().expect("root");
        let (cwd, expected, result) = fixture(root.path());
        assert_eq!(validate_hooks_list(&result, &cwd, &expected), Ok(()));
        assert_eq!(expected.len(), 6);
        assert!(expected.iter().all(|hook| hook.hash.starts_with("sha256:")));
    }

    #[test]
    fn missing_or_weakened_hook_contract_is_incompatible() {
        let cases: &[(&str, &str, Value)] = &[
            ("untrusted", "trustStatus", json!("untrusted")),
            ("modified", "trustStatus", json!("modified")),
            ("disabled", "enabled", json!(false)),
            ("synchronous", "async", json!(false)),
            ("wrong source", "source", json!("user")),
            ("wrong handler", "handlerType", json!("prompt")),
            ("wrong timeout", "timeoutSec", json!(99)),
            ("wrong matcher", "matcher", json!("shell")),
            ("wrong command", "command", json!("other")),
            ("wrong hash", "currentHash", json!("sha256:00")),
            ("wrong key", "key", json!("other")),
            ("managed", "isManaged", json!(true)),
        ];
        for (name, field, replacement) in cases {
            let root = tempfile::tempdir().expect("root");
            let (cwd, expected, mut result) = fixture(root.path());
            result["data"][0]["hooks"][0][*field] = replacement.clone();
            assert_eq!(
                validate_hooks_list(&result, &cwd, &expected),
                Err(ProbeOutcome::Incompatible),
                "{name}"
            );
        }
    }

    #[test]
    fn omissions_duplicates_and_diagnostics_fail_closed_to_notify_only() {
        let root = tempfile::tempdir().expect("root");
        let (cwd, expected, mut missing) = fixture(root.path());
        missing["data"][0]["hooks"].as_array_mut().unwrap().pop();
        assert_eq!(
            validate_hooks_list(&missing, &cwd, &expected),
            Err(ProbeOutcome::Incompatible)
        );

        let (_, _, mut duplicate) = fixture(root.path());
        let copied = duplicate["data"][0]["hooks"][0].clone();
        duplicate["data"][0]["hooks"]
            .as_array_mut()
            .unwrap()
            .push(copied);
        assert_eq!(
            validate_hooks_list(&duplicate, &cwd, &expected),
            Err(ProbeOutcome::Incompatible)
        );

        let (_, _, mut diagnostic) = fixture(root.path());
        diagnostic["data"][0]["warnings"] = json!(["config warning"]);
        assert_eq!(
            validate_hooks_list(&diagnostic, &cwd, &expected),
            Err(ProbeOutcome::Incompatible)
        );
    }

    #[test]
    fn probe_environment_is_fresh_credential_free_and_keeps_runtime_wrapper_metadata() {
        let root = tempfile::tempdir().expect("root");
        let mut source = BTreeMap::from([
            (
                OsString::from("PATH"),
                std::env::var_os("PATH").unwrap_or_default(),
            ),
            (OsString::from("OPENAI_API_KEY"), OsString::from("secret")),
            (OsString::from("CODEX_API_KEY"), OsString::from("secret")),
            (OsString::from("GH_TOKEN"), OsString::from("secret")),
            (
                OsString::from("HTTP_PROXY"),
                OsString::from("http://proxy.invalid"),
            ),
            (OsString::from("CODEX_HOME"), OsString::from("user-home")),
            (OsString::from("HOME"), OsString::from("user-home")),
            (
                OsString::from("USERPROFILE"),
                OsString::from("user-profile"),
            ),
            (OsString::from("APPDATA"), OsString::from("user-appdata")),
            (
                OsString::from("LOCALAPPDATA"),
                OsString::from("user-local-appdata"),
            ),
            (
                OsString::from("XDG_CONFIG_HOME"),
                OsString::from("user-config"),
            ),
            (OsString::from("TEMP"), OsString::from("user-temp")),
            (
                OsString::from("CODEX_MANAGED_PACKAGE_ROOT"),
                OsString::from("managed-root"),
            ),
            (OsString::from("CODEX_MANAGED_BY_NPM"), OsString::from("1")),
        ]);
        crate::env::harden(&mut source);
        let workspace = ProbeWorkspace::create(Some(root.path())).expect("workspace");
        let env = workspace.isolated_env(&source);
        for secret in ["OPENAI_API_KEY", "CODEX_API_KEY", "GH_TOKEN", "HTTP_PROXY"] {
            assert!(!env.keys().any(|name| name.eq_ignore_ascii_case(secret)));
        }
        for name in ["CODEX_HOME", "HOME", "USERPROFILE"] {
            assert_eq!(
                env.get(OsStr::new(name)),
                Some(&workspace.home.as_os_str().to_os_string()),
                "{name}"
            );
        }
        assert!(!env.contains_key(OsStr::new("APPDATA")));
        assert!(!env.contains_key(OsStr::new("LOCALAPPDATA")));
        assert_eq!(
            env.get(OsStr::new("XDG_CONFIG_HOME")),
            Some(&workspace.config.as_os_str().to_os_string())
        );
        assert_eq!(
            env.get(OsStr::new("TEMP")),
            Some(&workspace.temp.as_os_str().to_os_string())
        );
        assert_eq!(
            env.get(OsStr::new("CODEX_MANAGED_PACKAGE_ROOT")),
            Some(&OsString::from("managed-root"))
        );
        assert_eq!(
            env.get(OsStr::new("CODEX_MANAGED_BY_NPM")),
            Some(&OsString::from("1"))
        );
    }

    #[test]
    fn missing_version_fails_closed_before_touching_a_binary() {
        let env = BTreeMap::new();
        let missing = Path::new("this-codex-binary-does-not-exist");
        assert_eq!(
            cached_or_warm(missing, &env, None, None, None),
            CapabilitySupport::Unsupported
        );
    }

    #[test]
    fn cache_stamp_tracks_nested_native_binary_without_walking_unrelated_resources() {
        let root = tempfile::tempdir().expect("root");
        let package_root = root.path().join("node_modules/@openai/codex");
        let script = package_root.join("bin/codex.js");
        fs::create_dir_all(script.parent().unwrap()).expect("bin");
        fs::write(&script, "// official launcher fixture").expect("script");
        let (platform_package, triple, native_name) = PLATFORM_PACKAGE;
        let native = package_root
            .join("node_modules/@openai")
            .join(platform_package)
            .join("vendor")
            .join(triple)
            .join("bin")
            .join(native_name);
        fs::create_dir_all(native.parent().unwrap()).expect("native bin");
        fs::write(&native, "native-v1").expect("native");
        let resources = native
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("codex-resources");
        fs::create_dir_all(&resources).expect("resources");
        fs::write(resources.join("unrelated"), "one").expect("resource");

        let env = BTreeMap::new();
        let before = BinaryStamp::of(&script, &env).expect("initial stamp");
        fs::write(
            resources.join("unrelated"),
            "resource changes do not define hook protocol",
        )
        .expect("resource update");
        let unrelated = BinaryStamp::of(&script, &env).expect("resource stamp");
        assert_eq!(before, unrelated);

        fs::write(&native, "native-v2-with-new-hook-protocol").expect("native update");
        let after = BinaryStamp::of(&script, &env).expect("updated stamp");
        assert_ne!(before, after, "nested native replacement invalidates hooks");
    }

    #[test]
    fn workspace_is_unique_and_removed_on_drop() {
        let root = tempfile::tempdir().expect("root");
        let path = {
            let workspace = ProbeWorkspace::create(Some(root.path())).expect("workspace");
            assert!(workspace.home.is_dir());
            assert!(workspace.cwd.is_dir());
            workspace.root.clone()
        };
        assert!(!path.exists());
    }

    #[test]
    fn timed_out_optional_probe_reaps_child_and_removes_scratch_home() {
        let root = tempfile::tempdir().expect("root");
        let executable = hanging_provider(root.path());
        let env = std::env::vars_os().collect::<BTreeMap<_, _>>();
        let execution = probe_with_timeout(
            &executable,
            &env,
            Some(root.path()),
            None,
            Duration::from_millis(100),
        );
        assert_eq!(execution.outcome, ProbeOutcome::Transient);
        assert!(
            execution.cleanup_complete,
            "timeout cleanup must kill and reap the provider process tree"
        );
        assert!(
            fs::read_dir(root.path())
                .expect("root")
                .filter_map(Result::ok)
                .all(|entry| !entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".kalcode-codex-hook-compat-")),
            "timeout cleanup must remove the isolated probe home"
        );
    }

    /// Credential-free and quota-free proof against an installed CLI. It is ignored because it
    /// depends on a machine installation, not because it invokes a model or paid API.
    #[test]
    #[ignore = "requires KALCODE_CODEX_EXE and KALCODE_CODEX_VERSION"]
    fn real_installed_cli_probe_terminates_child_and_hot_cache_is_fast() {
        let executable =
            PathBuf::from(std::env::var_os("KALCODE_CODEX_EXE").expect("KALCODE_CODEX_EXE"));
        let version =
            Version::parse(&std::env::var("KALCODE_CODEX_VERSION").expect("KALCODE_CODEX_VERSION"))
                .expect("semantic Codex version");
        let neutral = tempfile::tempdir().expect("neutral root");
        let env = std::env::vars_os().collect::<BTreeMap<_, _>>();
        assert_eq!(
            probe_and_cache(
                &executable,
                &env,
                Some(neutral.path()),
                None,
                Some(&version),
            ),
            CapabilitySupport::Supported
        );
        assert_eq!(
            fs::read_dir(neutral.path())
                .expect("read neutral root")
                .count(),
            0,
            "the app-server child has terminated and its scratch home was removed"
        );

        let mut samples = Vec::new();
        for _ in 0..20 {
            let started = Instant::now();
            assert_eq!(
                cached_or_warm(
                    &executable,
                    &env,
                    Some(neutral.path()),
                    None,
                    Some(&version)
                ),
                CapabilitySupport::Supported
            );
            samples.push(started.elapsed());
        }
        samples.sort_unstable();
        eprintln!(
            "Codex hook compatibility hot cache: p50={:?}, max={:?}",
            samples[samples.len() / 2],
            samples[samples.len() - 1]
        );
    }
}
