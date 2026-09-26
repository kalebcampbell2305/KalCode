//! The Process Monitor (UD-03): KalCode's process tree, processes of open workspaces and
//! owners of listening ports — never every process on the machine unless asked — with an
//! ownership classification that decides whether a process may be stopped:
//!
//! | Owner | Stop |
//! | --- | --- |
//! | KalCode itself, its window (WebView runtime) | refused |
//! | started by KalCode (terminal shells, provider CLIs, their children) | confirm in KalCode |
//! | another program of the signed-in user | native confirmation (D8) |
//! | Windows/session-critical programs of the user (Explorer, …) | refused |
//! | system, other users, unreadable owner | refused |
//!
//! KalCode's tree and its roles come from the Resource Governor's pure
//! [`kalcode_resources::tree::build_tree`] (one sampler model, ADVANCED D7). Only executable
//! names, parent ids, CPU, memory, owner and working folder are read — never command lines or
//! environments. Stopping re-reads the process first and refuses when its start time no longer
//! matches what was listed (the pid was reused).

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

use kalcode_contracts::permissions::ProcessSignalKind;
use kalcode_contracts::resources::ProcessRole;
use kalcode_core::{ErrorCategory, KalError, Result};
use kalcode_resources::tree::{ProcEntry, TrackedRoot, build_tree};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

use crate::types::{
    Killability, ProcessInfo, ProcessList, ProcessOwner, ProcessScope, SignalOutcome,
};

/// Most rows returned (the `all` scope on a busy machine).
pub const MAX_ROWS: usize = 1_000;

/// A process object whose identity and mutation are bound to one operating-system handle.
/// Implementations must never reopen the process by PID between these operations.
#[cfg(any(windows, test))]
trait VerifiedProcessHandle {
    fn creation_identity(&self) -> Result<u64>;
    fn signal(&self, signal: ProcessSignalKind) -> Result<()>;
    fn wait(&self, timeout: Duration) -> Result<bool>;
}

#[cfg(any(windows, test))]
trait VerifiedProcessBackend {
    type Handle: VerifiedProcessHandle;

    fn open(&self, pid: u32) -> Result<Self::Handle>;
}

#[cfg(any(windows, test))]
fn signal_verified_process<B: VerifiedProcessBackend>(
    backend: &B,
    pid: u32,
    expected_identity: u64,
    signal: ProcessSignalKind,
    timeout: Duration,
) -> Result<SignalOutcome> {
    let handle = match prepare_verified_process(backend, pid, expected_identity) {
        Ok(handle) => handle,
        Err(error) if error.code == "process_gone" => return Ok(SignalOutcome::AlreadyExited),
        Err(error) => return Err(error),
    };
    signal_prepared_process(handle, signal, timeout)
}

#[cfg(any(windows, test))]
fn prepare_verified_process<B: VerifiedProcessBackend>(
    backend: &B,
    pid: u32,
    expected_identity: u64,
) -> Result<B::Handle> {
    let handle = match backend.open(pid) {
        Ok(handle) => handle,
        Err(error) if error.code == "process_gone" => return Err(gone()),
        Err(error) => return Err(error),
    };
    if handle.creation_identity()? != expected_identity {
        return Err(replaced());
    }
    Ok(handle)
}

#[cfg(any(windows, test))]
fn signal_prepared_process<H: VerifiedProcessHandle>(
    handle: H,
    signal: ProcessSignalKind,
    timeout: Duration,
) -> Result<SignalOutcome> {
    handle.signal(signal)?;
    if handle.wait(timeout)? {
        Ok(SignalOutcome::Stopped)
    } else {
        Ok(SignalOutcome::StillRunning)
    }
}

/// A process signal sealed before approval. On Windows the owned kernel handle is opened and its
/// creation identity verified during preparation, then retained without any PID reopen until the
/// one-time effect is consumed.
pub struct PreparedProcessSignal {
    pid: u32,
    signal: ProcessSignalKind,
    #[cfg(windows)]
    handle: windows_process::Handle,
}

impl PreparedProcessSignal {
    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn signal(&self) -> ProcessSignalKind {
        self.signal
    }

    pub fn execute(self) -> Result<SignalOutcome> {
        #[cfg(windows)]
        {
            signal_prepared_process(self.handle, self.signal, Duration::from_secs(3))
        }
        #[cfg(not(windows))]
        {
            let _ = self;
            Err(KalError::new(
                ErrorCategory::Permission,
                "process_retained_handle_unavailable",
                "This platform cannot retain a verified process handle for approval.",
            ))
        }
    }
}

/// A workspace whose processes are "related".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceRoot {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
}

/// A running KalCode terminal's shell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalRoot {
    pub pid: u32,
    pub generation: u64,
    pub terminal_id: String,
    pub workspace_id: String,
}

/// What the monitor knows about KalCode's own state.
#[derive(Debug, Clone, Default)]
pub struct ProcessContext {
    pub self_pid: u32,
    pub workspaces: Vec<WorkspaceRoot>,
    pub terminals: Vec<TerminalRoot>,
    /// Listening ports by owning pid (from the Port Inspector).
    pub listening: HashMap<u32, Vec<u16>>,
}

/// One process as the OS reported it.
#[derive(Debug, Clone, PartialEq)]
pub struct ProcRow {
    pub pid: u32,
    pub parent: Option<u32>,
    pub name: String,
    pub start_time: u64,
    pub cpu_percent: Option<f32>,
    pub rss_bytes: u64,
    /// The owner's id (`S-1-5-21-…` on Windows, the uid elsewhere); `None` when unreadable.
    pub user: Option<String>,
    pub cwd: Option<PathBuf>,
    pub exe: Option<PathBuf>,
}

/// Programs a Windows session depends on: never stopped from KalCode, even when they run as the
/// signed-in user.
const SESSION_CRITICAL: &[&str] = &[
    "explorer.exe",
    "winlogon.exe",
    "csrss.exe",
    "lsass.exe",
    "services.exe",
    "smss.exe",
    "wininit.exe",
    "dwm.exe",
    "sihost.exe",
    "fontdrvhost.exe",
    "svchost.exe",
    "taskhostw.exe",
    "runtimebroker.exe",
    "startmenuexperiencehost.exe",
    "shellexperiencehost.exe",
    "searchhost.exe",
    "ctfmon.exe",
    "textinputhost.exe",
    "securityhealthsystray.exe",
    "system",
    "registry",
    "idle",
    "launchd",
    "loginwindow",
    "windowserver",
    "systemd",
    "gnome-shell",
    "xorg",
];

/// The WebView runtime that draws KalCode's window.
const WEBVIEW_NAMES: &[&str] = &[
    "msedgewebview2.exe",
    "webkitwebprocess",
    "webkitnetworkprocess",
];
const SHELL_NAMES: &[&str] = &[
    "pwsh.exe",
    "powershell.exe",
    "cmd.exe",
    "bash.exe",
    "wsl.exe",
    "nu.exe",
    "bash",
    "zsh",
    "fish",
    "sh",
    "nu",
];
const PROVIDER_NAMES: &[&str] = &["claude", "codex", "gemini"];

fn stem(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    lower
        .strip_suffix(".exe")
        .map(str::to_owned)
        .unwrap_or(lower)
}

/// True for the well-known system account ids (Local System, Local/Network Service, Window
/// Manager and font-driver sessions) and uid 0.
pub fn is_system_account(user: &str) -> bool {
    matches!(user, "S-1-5-18" | "S-1-5-19" | "S-1-5-20" | "0")
        || user.starts_with("S-1-5-90-")
        || user.starts_with("S-1-5-96-")
}

/// Path components compared case-insensitively on Windows.
fn components(path: &Path) -> Vec<String> {
    path.components()
        .filter_map(|c| match c {
            Component::Prefix(p) => Some(p.as_os_str().to_string_lossy().to_ascii_lowercase()),
            Component::RootDir => Some("/".into()),
            Component::Normal(s) => Some(if cfg!(windows) {
                s.to_string_lossy().to_lowercase()
            } else {
                s.to_string_lossy().into_owned()
            }),
            _ => None,
        })
        .collect()
}

fn inside(path: &Path, root: &Path) -> bool {
    let (p, r) = (components(path), components(root));
    !r.is_empty() && p.len() >= r.len() && p[..r.len()] == r[..]
}

/// Builds the rows (pure; the sampler feeds it). `self_user` is KalCode's own owner id.
pub fn classify(
    rows: &[ProcRow],
    ctx: &ProcessContext,
    self_user: Option<&str>,
    scope: ProcessScope,
    cpu_ready: bool,
) -> ProcessList {
    let roots: Vec<TrackedRoot> = ctx
        .terminals
        .iter()
        .map(|t| TrackedRoot {
            pid: t.pid,
            role: ProcessRole::Terminal {
                terminal_id: t.terminal_id.clone(),
            },
        })
        .collect();
    let entries: Vec<ProcEntry> = rows
        .iter()
        .map(|r| ProcEntry {
            pid: r.pid,
            parent: r.parent,
            name: r.name.clone(),
            start_time: r.start_time,
            cpu_percent: r.cpu_percent,
            rss_bytes: r.rss_bytes,
        })
        .collect();
    let tree = build_tree(&entries, ctx.self_pid, &roots).tree;
    let roles: HashMap<u32, (ProcessRole, u32)> = tree
        .processes
        .iter()
        .map(|p| (p.pid, (p.role.clone(), p.root_pid)))
        .collect();
    let terminal_of: HashMap<&str, &TerminalRoot> = ctx
        .terminals
        .iter()
        .map(|t| (t.terminal_id.as_str(), t))
        .collect();
    let workspace_name: HashMap<&str, &str> = ctx
        .workspaces
        .iter()
        .map(|w| (w.id.as_str(), w.name.as_str()))
        .collect();

    let mut out = Vec::new();
    let mut hidden = 0u32;
    for row in rows {
        let role = roles.get(&row.pid).map(|(r, _)| r.clone());
        let in_tree = role.is_some();
        let lower = row.name.to_ascii_lowercase();
        let name_stem = stem(&row.name);
        let terminal_id = match &role {
            Some(ProcessRole::Terminal { terminal_id }) => Some(terminal_id.clone()),
            _ => None,
        };
        // Workspace: a terminal's own workspace, else the working folder or executable inside
        // an open workspace.
        let mut workspace_id = terminal_id
            .as_deref()
            .and_then(|t| terminal_of.get(t))
            .map(|t| t.workspace_id.clone());
        if workspace_id.is_none() {
            workspace_id = ctx
                .workspaces
                .iter()
                .find(|w| {
                    row.cwd.as_deref().is_some_and(|c| inside(c, &w.path))
                        || row.exe.as_deref().is_some_and(|e| inside(e, &w.path))
                })
                .map(|w| w.id.clone());
        }
        let ports = ctx.listening.get(&row.pid).cloned().unwrap_or_default();
        let related = in_tree || workspace_id.is_some() || !ports.is_empty();
        if scope == ProcessScope::Related && !related {
            hidden += 1;
            continue;
        }
        let webview = WEBVIEW_NAMES.contains(&lower.as_str());
        let owner = if row.pid == ctx.self_pid || (in_tree && webview) {
            ProcessOwner::KalCode
        } else if in_tree {
            ProcessOwner::KalCodeChild
        } else {
            match (&row.user, self_user) {
                (Some(user), _) if is_system_account(user) => ProcessOwner::System,
                (Some(user), Some(me)) if user == me => ProcessOwner::CurrentUser,
                (Some(_), Some(_)) => ProcessOwner::OtherUser,
                _ => ProcessOwner::Unknown,
            }
        };
        let critical = SESSION_CRITICAL.contains(&lower.as_str()) || row.pid <= 4;
        let killable = match owner {
            ProcessOwner::KalCode if row.pid == ctx.self_pid => Killability::Refused {
                reason: "This is KalCode itself.".into(),
            },
            ProcessOwner::KalCode => Killability::Refused {
                reason: "It draws KalCode's window; stopping it would close the app's view.".into(),
            },
            _ if critical => Killability::Refused {
                reason: "Your system needs this program to keep running.".into(),
            },
            ProcessOwner::KalCodeChild => Killability::Confirm,
            ProcessOwner::CurrentUser => Killability::NativeConfirm,
            ProcessOwner::OtherUser => Killability::Refused {
                reason: "It belongs to another user account.".into(),
            },
            ProcessOwner::System => Killability::Refused {
                reason: "It's a system process.".into(),
            },
            ProcessOwner::Unknown => Killability::Refused {
                reason: "KalCode couldn't verify who owns it.".into(),
            },
        };
        let is_terminal_root = matches!(
            (&role, &terminal_id),
            (Some(ProcessRole::Terminal { .. }), Some(t)) if terminal_of.get(t.as_str()).is_some_and(|root| root.pid == row.pid)
        );
        let terminal_generation = terminal_id
            .as_deref()
            .and_then(|terminal_id| terminal_of.get(terminal_id))
            .filter(|root| root.pid == row.pid)
            .map(|root| root.generation);
        let label = if row.pid == ctx.self_pid {
            "KalCode".to_owned()
        } else if owner == ProcessOwner::KalCode {
            "KalCode window".to_owned()
        } else if is_terminal_root {
            "KalCode terminal shell".to_owned()
        } else if matches!(role, Some(ProcessRole::Terminal { .. })) {
            "Started in a KalCode terminal".to_owned()
        } else if matches!(role, Some(ProcessRole::Provider { .. }))
            || (in_tree && PROVIDER_NAMES.contains(&name_stem.as_str()))
        {
            "Provider CLI started by KalCode".to_owned()
        } else if in_tree && SHELL_NAMES.contains(&lower.as_str()) {
            "Shell started by KalCode".to_owned()
        } else if in_tree {
            "Started by KalCode".to_owned()
        } else if let Some(id) = &workspace_id {
            format!(
                "Runs in {}",
                workspace_name
                    .get(id.as_str())
                    .copied()
                    .unwrap_or("a workspace")
            )
        } else if let Some(port) = ports.first() {
            format!("Listening on port {port}")
        } else {
            match owner {
                ProcessOwner::CurrentUser => "Your program".to_owned(),
                ProcessOwner::System => "System".to_owned(),
                ProcessOwner::OtherUser => "Another user".to_owned(),
                _ => "Owner unknown".to_owned(),
            }
        };
        out.push(ProcessInfo {
            pid: row.pid,
            parent_pid: row.parent,
            name: row.name.clone(),
            start_time: row.start_time.to_string(),
            cpu_percent: if cpu_ready { row.cpu_percent } else { None },
            memory_bytes: row.rss_bytes,
            owner,
            role,
            label,
            workspace_name: workspace_id
                .as_deref()
                .and_then(|id| workspace_name.get(id).map(|n| (*n).to_owned())),
            workspace_id,
            terminal_id,
            terminal_generation,
            ports,
            can_restart: is_terminal_root,
            killable,
        });
    }
    // KalCode's tree first, then workspace processes, then the rest; busiest first within each.
    out.sort_by(|a, b| {
        let rank = |p: &ProcessInfo| match p.owner {
            _ if p.pid == ctx.self_pid => -1,
            ProcessOwner::KalCode => 0,
            ProcessOwner::KalCodeChild => 1,
            _ if p.workspace_id.is_some() => 2,
            _ if !p.ports.is_empty() => 3,
            _ => 4,
        };
        rank(a)
            .cmp(&rank(b))
            .then_with(|| {
                b.cpu_percent
                    .unwrap_or(0.0)
                    .partial_cmp(&a.cpu_percent.unwrap_or(0.0))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| b.memory_bytes.cmp(&a.memory_bytes))
            .then_with(|| a.pid.cmp(&b.pid))
    });
    if out.len() > MAX_ROWS {
        hidden += u32::try_from(out.len() - MAX_ROWS).unwrap_or(u32::MAX);
        out.truncate(MAX_ROWS);
    }
    ProcessList {
        total: u32::try_from(rows.len()).unwrap_or(u32::MAX),
        hidden,
        processes: out,
        cpu_ready,
        sampled_at: kalcode_core::time::now_rfc3339(),
    }
}

/// Samples the OS process list with `sysinfo`. Keep one per app: CPU use needs two samples.
pub struct ProcessSampler {
    system: System,
    samples: u32,
    last: Option<Instant>,
}

impl Default for ProcessSampler {
    fn default() -> Self {
        Self::new()
    }
}

impl ProcessSampler {
    pub fn new() -> Self {
        Self {
            system: System::new(),
            samples: 0,
            last: None,
        }
    }

    fn refresh(&mut self, which: ProcessesToUpdate<'_>) {
        self.system.refresh_processes_specifics(
            which,
            true,
            ProcessRefreshKind::nothing()
                .with_cpu()
                .with_memory()
                .with_user(UpdateKind::OnlyIfNotSet)
                .with_cwd(UpdateKind::OnlyIfNotSet)
                .with_exe(UpdateKind::OnlyIfNotSet),
        );
    }

    /// The current rows. CPU use is measurable from the second call on.
    pub fn rows(&mut self) -> (Vec<ProcRow>, bool) {
        // Two refreshes closer than sysinfo's minimum interval give meaningless CPU values.
        if let Some(last) = self.last
            && last.elapsed() < sysinfo::MINIMUM_CPU_UPDATE_INTERVAL
        {
            std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL - last.elapsed());
        }
        self.refresh(ProcessesToUpdate::All);
        self.samples = self.samples.saturating_add(1);
        self.last = Some(Instant::now());
        let cores = self.system.cpus().len().max(
            std::thread::available_parallelism()
                .map(usize::from)
                .unwrap_or(1),
        ) as f32;
        let rows = self
            .system
            .processes()
            .iter()
            .map(|(pid, p)| ProcRow {
                pid: pid.as_u32(),
                parent: p.parent().map(Pid::as_u32),
                name: p.name().to_string_lossy().into_owned(),
                start_time: process_creation_identity(pid.as_u32(), p.start_time()),
                cpu_percent: Some((p.cpu_usage() / cores).clamp(0.0, 100.0)),
                rss_bytes: p.memory(),
                user: p.user_id().map(|u| u.to_string()),
                cwd: p.cwd().map(Path::to_path_buf),
                exe: p.exe().map(Path::to_path_buf),
            })
            .collect();
        (rows, self.samples > 1)
    }

    /// KalCode's own owner id.
    pub fn self_user(&mut self, self_pid: u32) -> Option<String> {
        let pid = Pid::from_u32(self_pid);
        self.refresh(ProcessesToUpdate::Some(&[pid]));
        self.system
            .process(pid)
            .and_then(|p| p.user_id().map(|u| u.to_string()))
    }

    /// Samples and classifies.
    pub fn list(&mut self, ctx: &ProcessContext, scope: ProcessScope) -> ProcessList {
        let me = self.self_user(ctx.self_pid);
        let (rows, cpu_ready) = self.rows();
        classify(&rows, ctx, me.as_deref(), scope, cpu_ready)
    }

    /// Re-reads one process and classifies it, if it is still the process that was listed
    /// (same pid **and** start time).
    pub fn identify(
        &mut self,
        ctx: &ProcessContext,
        pid: u32,
        start_time: u64,
    ) -> Result<ProcessInfo> {
        let me = self.self_user(ctx.self_pid);
        let (rows, cpu_ready) = self.rows();
        let Some(row) = rows.iter().find(|r| r.pid == pid) else {
            return Err(gone());
        };
        if row.start_time != start_time {
            return Err(replaced());
        }
        classify(&rows, ctx, me.as_deref(), ProcessScope::All, cpu_ready)
            .processes
            .into_iter()
            .find(|p| p.pid == pid)
            .ok_or_else(gone)
    }

    /// Re-identifies and opens the exact process before an approval request is created. The
    /// returned handle remains owned by the sealed operation until `execute` consumes it.
    pub fn prepare_stop(
        &mut self,
        ctx: &ProcessContext,
        pid: u32,
        start_time: u64,
        signal: ProcessSignalKind,
    ) -> Result<(ProcessInfo, PreparedProcessSignal)> {
        let info = self.identify(ctx, pid, start_time)?;
        #[cfg(windows)]
        {
            let handle = prepare_verified_process(&windows_process::Backend, pid, start_time)?;
            Ok((
                info,
                PreparedProcessSignal {
                    pid,
                    signal,
                    handle,
                },
            ))
        }
        #[cfg(not(windows))]
        {
            let _ = (info, pid, signal);
            Err(KalError::new(
                ErrorCategory::Permission,
                "process_retained_handle_unavailable",
                "This platform cannot retain a verified process handle for approval.",
            ))
        }
    }

    /// Sends the signal to `pid` if it is still the same process (checked again just before).
    /// The caller has already classified it, asked the permission engine and confirmed.
    pub fn stop(
        &mut self,
        pid: u32,
        start_time: u64,
        signal: ProcessSignalKind,
    ) -> Result<SignalOutcome> {
        #[cfg(windows)]
        {
            // The Windows backend validates and signals through one retained kernel handle. A
            // second PID lookup here would allow a just-exited process number to be reused.
            signal_verified_process(
                &windows_process::Backend,
                pid,
                start_time,
                signal,
                Duration::from_secs(3),
            )
        }
        #[cfg(not(windows))]
        {
            let spid = Pid::from_u32(pid);
            self.refresh(ProcessesToUpdate::Some(&[spid]));
            let Some(process) = self.system.process(spid) else {
                return Ok(SignalOutcome::AlreadyExited);
            };
            if process.start_time() != start_time {
                return Err(replaced());
            }
            match signal {
                ProcessSignalKind::Kill => {
                    if !process.kill() {
                        return Err(KalError::new(
                            ErrorCategory::Permission,
                            "stop_failed",
                            "The operating system didn't let KalCode stop that process.",
                        ));
                    }
                }
                ProcessSignalKind::Terminate => {
                    request_graceful_stop(pid, process)?;
                }
            }
            // Wait briefly for it to go.
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                self.refresh(ProcessesToUpdate::Some(&[spid]));
                match self.system.process(spid) {
                    None => return Ok(SignalOutcome::Stopped),
                    Some(p) if p.start_time() != start_time => return Ok(SignalOutcome::Stopped),
                    Some(_) if Instant::now() >= deadline => {
                        return Ok(SignalOutcome::StillRunning);
                    }
                    Some(_) => std::thread::sleep(Duration::from_millis(100)),
                }
            }
        }
    }
}

fn process_creation_identity(pid: u32, _fallback: u64) -> u64 {
    #[cfg(windows)]
    {
        // Zero cannot match a real Windows FILETIME. A process whose exact identity cannot be
        // sampled remains visible but every later mutation fails closed.
        windows_process::sample_creation_identity(pid).unwrap_or(0)
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        _fallback
    }
}

fn gone() -> KalError {
    KalError::validation("process_gone", "That process has already exited.")
}

fn replaced() -> KalError {
    KalError::validation(
        "process_replaced",
        "That process has exited and its number now belongs to another program. Refresh the list.",
    )
}

#[cfg(not(windows))]
fn request_graceful_stop(_pid: u32, process: &sysinfo::Process) -> Result<()> {
    match process.kill_with(sysinfo::Signal::Term) {
        Some(true) => Ok(()),
        _ => Err(KalError::new(
            ErrorCategory::Permission,
            "stop_failed",
            "The operating system didn't let KalCode stop that process.",
        )),
    }
}

#[cfg(windows)]
#[allow(unsafe_code)]
mod windows_process {
    use super::*;

    use windows_sys::Win32::Foundation::{
        CloseHandle, FILETIME, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
        TerminateProcess, WaitForSingleObject,
    };

    const ERROR_INVALID_PARAMETER: i32 = 87;
    const SYNCHRONIZE_ACCESS: u32 = 0x0010_0000;

    pub(super) struct Backend;

    pub(super) struct Handle(HANDLE);

    // SAFETY: a Windows process HANDLE is a reference-counted kernel object usable from any
    // thread. `Handle` has one owner and closes it exactly once in `Drop`.
    unsafe impl Send for Handle {}

    impl Drop for Handle {
        fn drop(&mut self) {
            // SAFETY: `self.0` is the owned non-null handle returned by `OpenProcess`, and this
            // is its only close path.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    impl VerifiedProcessBackend for Backend {
        type Handle = Handle;

        fn open(&self, pid: u32) -> Result<Self::Handle> {
            // SAFETY: access flags are valid, handle inheritance is disabled, and no pointers are
            // passed. The returned handle is checked and owned by `Handle`.
            let handle = unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE_ACCESS,
                    0,
                    pid,
                )
            };
            if handle.is_null() {
                let source = std::io::Error::last_os_error();
                if source.raw_os_error() == Some(ERROR_INVALID_PARAMETER) {
                    return Err(gone());
                }
                return Err(KalError::new(
                    ErrorCategory::Permission,
                    "process_open_denied",
                    "The operating system didn't let KalCode open that process.",
                )
                .with_source(source));
            }
            Ok(Handle(handle))
        }
    }

    impl VerifiedProcessHandle for Handle {
        fn creation_identity(&self) -> Result<u64> {
            let mut created = FILETIME::default();
            let mut exited = FILETIME::default();
            let mut kernel = FILETIME::default();
            let mut user = FILETIME::default();
            // SAFETY: all output pointers are valid for writes and `self.0` remains owned/live.
            let ok = unsafe {
                GetProcessTimes(self.0, &mut created, &mut exited, &mut kernel, &mut user)
            };
            if ok == 0 {
                return Err(KalError::internal(
                    "process_identity_unavailable",
                    "KalCode couldn't verify that process's creation identity.",
                )
                .with_source(std::io::Error::last_os_error()));
            }
            let ticks =
                (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
            Ok(ticks)
        }

        fn signal(&self, _signal: ProcessSignalKind) -> Result<()> {
            // Both UI stop modes use the retained handle on Windows. Reopening by PID for a
            // best-effort graceful stop would reintroduce the PID-reuse race this boundary closes.
            // SAFETY: the handle was opened with `PROCESS_TERMINATE` and remains owned/live.
            if unsafe { TerminateProcess(self.0, 1) } == 0 {
                return Err(KalError::new(
                    ErrorCategory::Permission,
                    "stop_failed",
                    "The operating system didn't let KalCode stop that process.",
                )
                .with_source(std::io::Error::last_os_error()));
            }
            Ok(())
        }

        fn wait(&self, timeout: Duration) -> Result<bool> {
            let timeout_ms = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX);
            // SAFETY: `self.0` remains owned/live for the duration of this wait.
            match unsafe { WaitForSingleObject(self.0, timeout_ms) } {
                WAIT_OBJECT_0 => Ok(true),
                WAIT_TIMEOUT => Ok(false),
                _ => Err(KalError::internal(
                    "process_wait_failed",
                    "KalCode couldn't verify whether the process stopped.",
                )
                .with_source(std::io::Error::last_os_error())),
            }
        }
    }

    pub(super) fn sample_creation_identity(pid: u32) -> Option<u64> {
        // SAFETY: query-only access, no inherited handle, and no pointers are passed. `Handle`
        // owns the non-null result and closes it exactly once.
        let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if raw.is_null() {
            return None;
        }
        Handle(raw).creation_identity().ok()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::sync::{Arc, Mutex};

    use super::*;

    const ME: &str = "S-1-5-21-1-2-3-1001";

    fn row(pid: u32, parent: Option<u32>, name: &str, user: Option<&str>) -> ProcRow {
        ProcRow {
            pid,
            parent,
            name: name.into(),
            start_time: 1_000 + u64::from(pid),
            cpu_percent: Some(1.5),
            rss_bytes: 1024 * u64::from(pid),
            user: user.map(str::to_owned),
            cwd: None,
            exe: None,
        }
    }

    fn fixture() -> (Vec<ProcRow>, ProcessContext) {
        let root = if cfg!(windows) {
            PathBuf::from(r"C:\Users\me\code\shop")
        } else {
            PathBuf::from("/home/me/code/shop")
        };
        let mut dev = row(900, Some(1), "node.exe", Some(ME));
        dev.cwd = Some(root.join("web"));
        let rows = vec![
            row(4, None, "System", Some("S-1-5-18")),
            row(1, None, "wininit.exe", Some("S-1-5-18")),
            row(100, Some(1), "kalcode.exe", Some(ME)),
            row(101, Some(100), "msedgewebview2.exe", Some(ME)),
            row(200, Some(100), "pwsh.exe", Some(ME)),
            row(201, Some(200), "node.exe", Some(ME)),
            row(300, Some(100), "claude.exe", Some(ME)),
            dev,
            row(901, Some(1), "explorer.exe", Some(ME)),
            row(902, Some(1), "notepad.exe", Some(ME)),
            row(903, Some(1), "postgres.exe", Some("S-1-5-20")),
            row(904, Some(1), "someone.exe", Some("S-1-5-21-9-9-9-1002")),
            row(905, Some(1), "mystery.exe", None),
        ];
        let ctx = ProcessContext {
            self_pid: 100,
            workspaces: vec![WorkspaceRoot {
                id: "ws1".into(),
                name: "shop".into(),
                path: root,
            }],
            terminals: vec![TerminalRoot {
                pid: 200,
                generation: 7,
                terminal_id: "t1".into(),
                workspace_id: "ws1".into(),
            }],
            listening: HashMap::from([(903, vec![5432]), (201, vec![3000])]),
        };
        (rows, ctx)
    }

    fn find(list: &ProcessList, pid: u32) -> &ProcessInfo {
        list.processes
            .iter()
            .find(|p| p.pid == pid)
            .unwrap_or_else(|| panic!("pid {pid} missing"))
    }

    #[test]
    fn related_scope_shows_kalcode_workspaces_and_port_owners_only() {
        let (rows, ctx) = fixture();
        let list = classify(&rows, &ctx, Some(ME), ProcessScope::Related, true);
        let pids: BTreeSet<u32> = list.processes.iter().map(|p| p.pid).collect();
        assert_eq!(
            pids,
            BTreeSet::from([100, 101, 200, 201, 300, 900, 903]),
            "{list:#?}"
        );
        assert_eq!(list.total, rows.len() as u32);
        assert_eq!(list.hidden, 6);
        // Unrelated programs of the user are never listed by default.
        assert!(!pids.contains(&902));
        let all = classify(&rows, &ctx, Some(ME), ProcessScope::All, true);
        assert_eq!(all.processes.len(), rows.len());
        assert_eq!(all.hidden, 0);
    }

    #[test]
    fn ownership_decides_how_a_process_may_be_stopped() {
        let (rows, ctx) = fixture();
        let list = classify(&rows, &ctx, Some(ME), ProcessScope::All, true);
        let refused = |p: &ProcessInfo| matches!(p.killable, Killability::Refused { .. });
        // KalCode itself and its window: refused.
        assert_eq!(find(&list, 100).owner, ProcessOwner::KalCode);
        assert!(refused(find(&list, 100)));
        assert_eq!(find(&list, 101).owner, ProcessOwner::KalCode);
        assert!(refused(find(&list, 101)));
        // Started by KalCode: confirm in KalCode.
        for pid in [200, 201, 300] {
            assert_eq!(find(&list, pid).owner, ProcessOwner::KalCodeChild, "{pid}");
            assert_eq!(find(&list, pid).killable, Killability::Confirm, "{pid}");
        }
        // The user's own programs: native confirmation, except session-critical ones.
        assert_eq!(find(&list, 900).killable, Killability::NativeConfirm);
        assert_eq!(find(&list, 902).killable, Killability::NativeConfirm);
        assert!(refused(find(&list, 901)), "explorer");
        // System, other users, unknown owners: refused.
        assert_eq!(find(&list, 903).owner, ProcessOwner::System);
        assert!(refused(find(&list, 903)));
        assert_eq!(find(&list, 904).owner, ProcessOwner::OtherUser);
        assert!(refused(find(&list, 904)));
        assert_eq!(find(&list, 905).owner, ProcessOwner::Unknown);
        assert!(refused(find(&list, 905)));
        assert!(refused(find(&list, 4)));
    }

    #[test]
    fn terminals_and_workspaces_are_labelled() {
        let (rows, ctx) = fixture();
        let list = classify(&rows, &ctx, Some(ME), ProcessScope::Related, true);
        let shell = find(&list, 200);
        assert_eq!(shell.label, "KalCode terminal shell");
        assert_eq!(shell.terminal_id.as_deref(), Some("t1"));
        assert_eq!(shell.workspace_id.as_deref(), Some("ws1"));
        assert!(shell.can_restart);
        let child = find(&list, 201);
        assert_eq!(child.label, "Started in a KalCode terminal");
        assert_eq!(child.ports, vec![3000]);
        assert!(!child.can_restart);
        assert_eq!(find(&list, 300).label, "Provider CLI started by KalCode");
        let dev = find(&list, 900);
        assert_eq!(dev.label, "Runs in shop");
        assert_eq!(dev.workspace_name.as_deref(), Some("shop"));
        assert_eq!(find(&list, 903).label, "Listening on port 5432");
        // KalCode first.
        assert_eq!(list.processes[0].pid, 100);
    }

    #[test]
    fn cpu_is_hidden_until_measurable() {
        let (rows, ctx) = fixture();
        let list = classify(&rows, &ctx, Some(ME), ProcessScope::Related, false);
        assert!(list.processes.iter().all(|p| p.cpu_percent.is_none()));
        assert!(!list.cpu_ready);
    }

    #[test]
    fn creation_identity_is_serialized_as_an_exact_decimal_string() {
        let (mut rows, ctx) = fixture();
        rows[0].start_time = u64::MAX;
        let list = classify(&rows, &ctx, Some(ME), ProcessScope::All, true);
        let process = find(&list, rows[0].pid);
        assert_eq!(process.start_time, u64::MAX.to_string());
        let json = serde_json::to_value(process).expect("serialize process");
        assert_eq!(json["startTime"], u64::MAX.to_string());
    }

    #[test]
    fn a_sibling_folder_is_not_inside_the_workspace() {
        let root = Path::new(if cfg!(windows) { r"C:\ws" } else { "/ws" });
        let sibling = Path::new(if cfg!(windows) { r"C:\ws2\x" } else { "/ws2/x" });
        let child = Path::new(if cfg!(windows) { r"c:\WS\x" } else { "/ws/x" });
        assert!(!inside(sibling, root));
        assert!(inside(child, root));
        assert!(inside(root, root));
    }

    #[test]
    fn the_real_sampler_sees_this_test_process() {
        let mut sampler = ProcessSampler::new();
        let me = std::process::id();
        let ctx = ProcessContext {
            self_pid: me,
            ..ProcessContext::default()
        };
        let list = sampler.list(&ctx, ProcessScope::Related);
        let this = list
            .processes
            .iter()
            .find(|p| p.pid == me)
            .expect("self listed");
        assert_eq!(this.owner, ProcessOwner::KalCode);
        let identity = this.start_time.parse::<u64>().expect("numeric identity");
        let again = sampler.identify(&ctx, me, identity).expect("same");
        assert_eq!(again.pid, me);
        let error = sampler
            .identify(&ctx, me, identity + 1)
            .expect_err("start time differs");
        assert_eq!(error.code, "process_replaced");
    }

    #[derive(Clone)]
    struct FakeVerifiedHandle {
        identity: u64,
        handle_name: &'static str,
        events: Arc<Mutex<Vec<String>>>,
    }

    impl VerifiedProcessHandle for FakeVerifiedHandle {
        fn creation_identity(&self) -> Result<u64> {
            self.events
                .lock()
                .expect("events")
                .push(format!("identity:{}", self.handle_name));
            Ok(self.identity)
        }

        fn signal(&self, signal: ProcessSignalKind) -> Result<()> {
            self.events
                .lock()
                .expect("events")
                .push(format!("signal:{}:{signal:?}", self.handle_name));
            Ok(())
        }

        fn wait(&self, _timeout: Duration) -> Result<bool> {
            self.events
                .lock()
                .expect("events")
                .push(format!("wait:{}", self.handle_name));
            Ok(true)
        }
    }

    struct FakeVerifiedBackend {
        events: Arc<Mutex<Vec<String>>>,
        identity: u64,
    }

    impl VerifiedProcessBackend for FakeVerifiedBackend {
        type Handle = FakeVerifiedHandle;

        fn open(&self, pid: u32) -> Result<Self::Handle> {
            self.events
                .lock()
                .expect("events")
                .push(format!("open:{pid}"));
            Ok(FakeVerifiedHandle {
                identity: self.identity,
                handle_name: "original",
                events: Arc::clone(&self.events),
            })
        }
    }

    #[test]
    fn mutation_checks_and_signals_the_same_verified_process_handle() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let backend = FakeVerifiedBackend {
            events: Arc::clone(&events),
            identity: 71,
        };

        let outcome = signal_verified_process(
            &backend,
            42,
            71,
            ProcessSignalKind::Kill,
            Duration::from_millis(1),
        )
        .expect("same handle");

        assert_eq!(outcome, SignalOutcome::Stopped);
        assert_eq!(
            *events.lock().expect("events"),
            [
                "open:42",
                "identity:original",
                "signal:original:Kill",
                "wait:original",
            ]
        );
    }

    #[test]
    fn verified_handle_is_retained_across_the_authority_boundary() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let backend = FakeVerifiedBackend {
            events: Arc::clone(&events),
            identity: 71,
        };

        let prepared = prepare_verified_process(&backend, 42, 71).expect("prepared");
        assert_eq!(
            *events.lock().expect("events"),
            ["open:42", "identity:original"]
        );

        let outcome = signal_prepared_process(
            prepared,
            ProcessSignalKind::Terminate,
            Duration::from_millis(1),
        )
        .expect("same retained handle");
        assert_eq!(outcome, SignalOutcome::Stopped);
        assert_eq!(
            *events.lock().expect("events"),
            [
                "open:42",
                "identity:original",
                "signal:original:Terminate",
                "wait:original",
            ]
        );
    }

    #[test]
    fn stale_creation_identity_never_reaches_the_mutation_method() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let backend = FakeVerifiedBackend {
            events: Arc::clone(&events),
            identity: 72,
        };

        let error = signal_verified_process(
            &backend,
            42,
            71,
            ProcessSignalKind::Kill,
            Duration::from_millis(1),
        )
        .expect_err("stale process");

        assert_eq!(error.code, "process_replaced");
        assert_eq!(
            *events.lock().expect("events"),
            ["open:42", "identity:original"]
        );
    }

    #[test]
    fn stopping_a_child_the_test_started_works_and_checks_identity() {
        let mut child = if cfg!(windows) {
            std::process::Command::new(crate::ports::system32().join("PING.EXE"))
                .args(["-n", "30", "127.0.0.1"])
                .stdout(std::process::Stdio::null())
                .spawn()
                .expect("spawn")
        } else {
            std::process::Command::new("sleep")
                .arg("30")
                .spawn()
                .expect("spawn")
        };
        let pid = child.id();
        let mut sampler = ProcessSampler::new();
        let ctx = ProcessContext {
            self_pid: std::process::id(),
            ..ProcessContext::default()
        };
        let start = {
            let (rows, _) = sampler.rows();
            rows.iter()
                .find(|r| r.pid == pid)
                .expect("listed")
                .start_time
        };
        let info = sampler.identify(&ctx, pid, start).expect("identified");
        // A child of this (test) process counts as started by KalCode.
        assert_eq!(info.owner, ProcessOwner::KalCodeChild);
        let identity = info.start_time.parse::<u64>().expect("numeric identity");
        let wrong = sampler.stop(pid, identity + 7, ProcessSignalKind::Kill);
        assert_eq!(wrong.map_err(|e| e.code), Err("process_replaced"));
        let outcome = sampler
            .stop(pid, identity, ProcessSignalKind::Kill)
            .expect("stopped");
        assert_eq!(outcome, SignalOutcome::Stopped);
        let _ = child.wait();
    }
}
