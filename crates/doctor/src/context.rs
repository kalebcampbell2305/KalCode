//! What checks read: facts about the host, the core, the current project, and the systems the
//! Doctor consumes instead of re-probing (provider detection, the located `git`, the resource
//! sampler). Shared, expensive facts (one resource sample, one file index) are computed once
//! per run, lazily, by whichever check needs them first.

use std::cell::Cell;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use kalcode_contracts::health::ProviderHealth;
use kalcode_contracts::resources::VolumeReading;
use kalcode_core::Core;
use kalcode_core::db::Migration;
use kalcode_git::GitCore;
use kalcode_git::index::FileIndex;
use kalcode_resources::{SysinfoProbe, SystemProbe, WorkspaceRoot};

/// Facts the host (the desktop shell) knows and the Doctor can't read itself.
#[derive(Debug, Clone)]
pub struct HostFacts {
    /// The process environment KalCode started with (PATH, PATHEXT, …). Probes get a sanitized
    /// copy; PATH sanity reads PATH from it.
    pub vars: Vec<(OsString, OsString)>,
    pub windows: bool,
    /// The WebView runtime version, or why it's unknown.
    pub webview_version: Result<String, String>,
    /// The migrations the core was opened with (to compare with what the database recorded).
    pub migrations: &'static [Migration],
}

impl HostFacts {
    pub fn from_process(
        webview_version: Result<String, String>,
        migrations: &'static [Migration],
    ) -> Self {
        Self {
            vars: std::env::vars_os().collect(),
            windows: cfg!(windows),
            webview_version,
            migrations,
        }
    }

    /// A variable (case-insensitive on Windows).
    pub fn var(&self, name: &str) -> Option<&std::ffi::OsStr> {
        self.vars
            .iter()
            .find(|(k, _)| {
                k.to_str().is_some_and(|k| {
                    if self.windows {
                        k.eq_ignore_ascii_case(name)
                    } else {
                        k == name
                    }
                })
            })
            .map(|(_, v)| v.as_os_str())
    }
}

/// One provider as detection last saw it (Z2) — or, once it merges, as Provider Health reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderFacts {
    pub id: String,
    pub display_name: String,
    /// The canonical Provider Health snapshot. The Doctor never starts or detects a provider.
    pub health: ProviderHealth,
    pub sign_in_command: String,
    pub install_command: String,
    /// KalCode has a working adapter for it.
    pub adapter_implemented: bool,
}

/// Where provider state comes from. The Doctor never starts a provider process itself.
/// Implemented by [`HealthSource`], which combines the canonical Health Monitor snapshot with
/// the registry's static recovery commands.
pub trait ProviderSource: Send + Sync {
    fn providers(&self) -> Result<Vec<ProviderFacts>, String>;
}

/// A side-effect-free view of the operating system's current microphone authorization state.
/// Reading this state must never open an input device or request permission.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MicrophonePermissionState {
    Granted,
    Denied,
    NotDetermined,
    Unknown,
    Unsupported,
}

/// The desktop host owns the native permission API. Doctor asks it once for every execution of
/// the microphone check so a permission changed in System Settings is visible on the next run.
pub trait MicrophonePermissionSource: Send + Sync {
    fn current(&self) -> MicrophonePermissionState;
}

/// Provider Health is authoritative for observed state; registry entries supply only the static
/// install/sign-in recovery commands and adapter availability.
pub struct HealthSource {
    pub monitor: Arc<kalcode_providers::HealthMonitor>,
    pub registry: Arc<kalcode_providers::ProviderRegistry>,
}

impl ProviderSource for HealthSource {
    fn providers(&self) -> Result<Vec<ProviderFacts>, String> {
        let static_rows = self.registry.list();
        Ok(self
            .monitor
            .list()
            .into_iter()
            .map(|health| {
                let row = static_rows.iter().find(|row| row.id == health.provider_id);
                ProviderFacts {
                    id: health.provider_id.as_str().to_owned(),
                    display_name: health.display_name.clone(),
                    health,
                    sign_in_command: row.map(|r| r.sign_in_command.clone()).unwrap_or_default(),
                    install_command: row.map(|r| r.install_command.clone()).unwrap_or_default(),
                    adapter_implemented: row
                        .is_some_and(|r| r.adapter == kalcode_providers::AdapterState::Implemented),
                }
            })
            .collect())
    }
}

/// The project the "current project" checks look at (the active workspace).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectFacts {
    pub workspace_id: String,
    pub name: String,
    /// Canonical root, resolved natively from the workspace record.
    pub root: PathBuf,
}

/// Cooperative cancellation plus the run's deadline.
#[derive(Debug, Clone)]
pub struct Budget {
    cancelled: Arc<AtomicBool>,
    default_timeout: Duration,
}

thread_local! {
    static CHECK_DEADLINE: Cell<Option<Instant>> = const { Cell::new(None) };
}

/// Restores the prior per-thread deadline after a check returns or panics.
pub struct CheckDeadlineGuard(Option<Instant>);

impl Drop for CheckDeadlineGuard {
    fn drop(&mut self) {
        CHECK_DEADLINE.with(|slot| slot.set(self.0));
    }
}

impl Budget {
    pub fn new(timeout: Duration) -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
            default_timeout: timeout,
        }
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    /// Cancelled or out of time: a long check should stop now.
    pub fn should_stop(&self) -> bool {
        self.is_cancelled() || Instant::now() >= self.deadline()
    }

    pub fn deadline(&self) -> Instant {
        CHECK_DEADLINE
            .with(Cell::get)
            .unwrap_or_else(|| Instant::now() + self.default_timeout)
    }

    /// Time left (at least `min`).
    pub fn remaining(&self, min: Duration) -> Duration {
        self.deadline()
            .saturating_duration_since(Instant::now())
            .max(min)
    }

    /// Applies a deadline to the current check thread only.
    pub fn enter_check(&self, timeout: Duration) -> CheckDeadlineGuard {
        let deadline = Instant::now() + timeout;
        let prior = CHECK_DEADLINE.with(|slot| {
            let prior = slot.get();
            slot.set(Some(deadline));
            prior
        });
        CheckDeadlineGuard(prior)
    }
}

/// Memory and volume facts from the Resource Governor's sampler (one sample per run).
#[derive(Debug, Clone, Default)]
pub struct ResourceFacts {
    pub memory_total: Option<u64>,
    pub memory_available: Option<u64>,
    pub memory_reason: Option<String>,
    /// (label, volume) for KalCode's data folder, the system drive and the project.
    pub volumes: Vec<(VolumeRole, VolumeReading)>,
    pub volume_reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VolumeRole {
    Data,
    System,
    Project,
}

/// Everything one run's checks share.
pub struct RunContext {
    pub core: Arc<Core>,
    pub host: HostFacts,
    pub project: Option<ProjectFacts>,
    pub providers: Option<Arc<dyn ProviderSource>>,
    pub git: Option<Arc<GitCore>>,
    pub microphone_permission: Option<Arc<dyn MicrophonePermissionSource>>,
    pub budget: Budget,
    resources: OnceLock<ResourceFacts>,
    index: OnceLock<Result<Arc<FileIndex>, String>>,
}

/// Most entries the project index holds for the Doctor (large-file and `.env` checks).
pub const PROJECT_INDEX_LIMIT: usize = 300_000;

impl RunContext {
    pub fn new(
        core: Arc<Core>,
        host: HostFacts,
        project: Option<ProjectFacts>,
        providers: Option<Arc<dyn ProviderSource>>,
        git: Option<Arc<GitCore>>,
        microphone_permission: Option<Arc<dyn MicrophonePermissionSource>>,
        budget: Budget,
    ) -> Self {
        Self {
            core,
            host,
            project,
            providers,
            git,
            microphone_permission,
            budget,
            resources: OnceLock::new(),
            index: OnceLock::new(),
        }
    }

    /// One Resource Governor sample (memory; free space of the data, system and project
    /// volumes). Shared by the checks that need it.
    pub fn resources(&self) -> &ResourceFacts {
        self.resources.get_or_init(|| {
            let mut roots = vec![WorkspaceRoot {
                workspace_id: Some("data".into()),
                path: self.core.paths().data_dir.clone(),
            }];
            if let Some(system) = system_drive(&self.host) {
                roots.push(WorkspaceRoot {
                    workspace_id: Some("system".into()),
                    path: system,
                });
            }
            if let Some(project) = &self.project {
                roots.push(WorkspaceRoot {
                    workspace_id: Some("project".into()),
                    path: project.root.clone(),
                });
            }
            sample_resources(&roots)
        })
    }

    /// The project's ignore-aware file index (Z6a's walker: Git's ignore rules, `.git` never
    /// entered, links never followed), built fresh for this run so it sees the current
    /// `.gitignore`.
    pub fn project_index(&self) -> Result<Arc<FileIndex>, String> {
        self.index
            .get_or_init(|| {
                let project = self
                    .project
                    .as_ref()
                    .ok_or_else(|| "No project is open.".to_owned())?;
                let root = kalcode_git::WorkspaceRoot::new(&project.workspace_id, &project.root)
                    .map_err(|e| e.message.clone())?;
                FileIndex::build_with(root, PROJECT_INDEX_LIMIT)
                    .map(Arc::new)
                    .map_err(|e| e.message.clone())
            })
            .clone()
    }
}

fn system_drive(host: &HostFacts) -> Option<PathBuf> {
    if host.windows {
        let drive = host
            .var("SystemDrive")
            .and_then(|d| d.to_str())
            .unwrap_or("C:");
        Some(PathBuf::from(format!("{drive}\\")))
    } else {
        Some(PathBuf::from("/"))
    }
}

fn sample_resources(roots: &[WorkspaceRoot]) -> ResourceFacts {
    use kalcode_contracts::resources::{Reading, Tiers};
    let mut probe = SysinfoProbe::new();
    let plan = kalcode_resources::probe::ProbePlan {
        tiers: Tiers {
            fast: true,
            slow: true,
            processes: false,
            inventory: true,
        },
        self_pid: std::process::id(),
        roots: &[],
        workspace_roots: roots,
    };
    let sample = probe.sample(&plan);
    let mut facts = ResourceFacts::default();
    match &sample.memory {
        Reading::Value(m) => {
            facts.memory_total = Some(m.total_bytes);
            facts.memory_available = Some(m.available_bytes);
        }
        Reading::Unavailable(why) | Reading::Unknown(why) => {
            facts.memory_reason = Some(why.clone());
        }
    }
    match sample.volumes {
        Some(Reading::Value(volumes)) => {
            for volume in volumes {
                for id in &volume.workspace_ids {
                    let role = match id.as_deref() {
                        Some("data") => VolumeRole::Data,
                        Some("system") => VolumeRole::System,
                        Some("project") => VolumeRole::Project,
                        _ => continue,
                    };
                    facts.volumes.push((role, volume.clone()));
                }
            }
        }
        Some(Reading::Unavailable(why) | Reading::Unknown(why)) => {
            facts.volume_reason = Some(why);
        }
        None => facts.volume_reason = Some("Free space wasn't measured.".into()),
    }
    facts
}

/// The volume holding `role`, if measured.
pub fn volume(facts: &ResourceFacts, role: VolumeRole) -> Option<&VolumeReading> {
    facts
        .volumes
        .iter()
        .find(|(r, _)| *r == role)
        .map(|(_, v)| v)
}

/// A path for display: only the final local name. Absolute paths never cross Doctor IPC.
pub fn display(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(|name| format!("…/{name}"))
        .unwrap_or_else(|| "local folder".into())
}
