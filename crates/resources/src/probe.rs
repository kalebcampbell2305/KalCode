//! The sampling seam. [`SystemProbe`] is the only place that touches the operating system;
//! everything above it is pure and deterministic. [`SysinfoProbe`] is the real implementation.

use std::collections::{BTreeMap, HashSet};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use sysinfo::{
    DiskRefreshKind, Disks, MemoryRefreshKind, Networks, ProcessRefreshKind, ProcessesToUpdate,
    System,
};

use crate::model::{
    CommitReading, CommitUsed, GpuReading, ProcessTreeReading, Reading, Tiers, VolumeReading,
};
use crate::tree::{ProcEntry, TrackedRoot, build_tree};

#[cfg(target_os = "macos")]
mod macos;

/// The kernel's "normal" memory pressure level (`kern.memorystatus_vm_pressure_level`, the
/// values of `DISPATCH_MEMORYPRESSURE_NORMAL` / `_WARN` / `_CRITICAL`: 1, 2, 4).
pub const MACOS_PRESSURE_NORMAL: u32 = 1;

/// Available memory as admission should see it on macOS.
///
/// `sysinfo`'s macOS figure is free + inactive + purgeable pages minus compressor-held pages. It
/// leaves out file-backed cache and compressible anonymous memory that macOS hands back without
/// any pressure, so a healthy Mac routinely reads a few GiB "available" while the kernel reports
/// three quarters of memory free (`memory_pressure`: "System-wide memory free percentage").
///
/// The kernel's own level (`kern.memorystatus_level`, percent of memory available) is used only
/// while the kernel also reports *normal* pressure; under warning or critical pressure, or when
/// either kernel value is unreadable, the conservative `sysinfo` figure stands. The result never
/// goes below `sysinfo`'s figure or above `total_bytes`.
pub fn reconcile_available_memory(
    total_bytes: u64,
    sysinfo_available_bytes: u64,
    kernel_free_percent: Option<u32>,
    kernel_pressure_level: Option<u32>,
) -> u64 {
    let conservative = sysinfo_available_bytes.min(total_bytes);
    match (kernel_free_percent, kernel_pressure_level) {
        (Some(percent), Some(MACOS_PRESSURE_NORMAL)) if percent <= 100 => {
            let kernel = u128::from(total_bytes) * u128::from(percent) / 100;
            conservative.max(u64::try_from(kernel).unwrap_or(total_bytes))
        }
        _ => conservative,
    }
}

/// A folder whose volume's free space is governed (a workspace root, or KalCode's data folder
/// with `workspace_id: None`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRoot {
    pub workspace_id: Option<String>,
    pub path: PathBuf,
}

/// What the governor asks a probe to measure.
#[derive(Debug, Clone, Copy)]
pub struct ProbePlan<'a> {
    pub tiers: Tiers,
    pub self_pid: u32,
    pub roots: &'a [TrackedRoot],
    pub workspace_roots: &'a [WorkspaceRoot],
}

/// Monotonic byte counters (cumulative since some origin). The governor turns two of them into a
/// rate with its own clock. `generation` changes whenever the set of counted devices changes, so
/// a new disk or interface never shows up as a burst of traffic.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Counters {
    pub generation: u64,
    pub a_bytes: u64,
    pub b_bytes: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RawCpu {
    pub total_percent: f32,
    pub logical_cores: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RawMemory {
    pub total_bytes: u64,
    pub available_bytes: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RawProcesses {
    pub count: u32,
    pub tree: ProcessTreeReading,
    pub vanished_roots: Vec<u32>,
}

/// One probe measurement. Fast-tier fields are always present; slow- and inventory-tier fields
/// are `None` when their tier did not run.
#[derive(Debug, Clone, PartialEq)]
pub struct RawSample {
    pub cpu: Reading<RawCpu>,
    pub memory: Reading<RawMemory>,
    /// Disk read (`a`) / write (`b`) byte counters over all fixed volumes.
    pub disk_io: Reading<Counters>,
    pub commit: Option<Reading<CommitReading>>,
    /// Network receive (`a`) / transmit (`b`) byte counters over physical interfaces.
    pub network: Option<Reading<Counters>>,
    pub volumes: Option<Reading<Vec<VolumeReading>>>,
    pub processes: Option<Reading<RawProcesses>>,
    pub gpu: Option<Reading<GpuReading>>,
}

impl RawSample {
    /// A sample in which nothing could be measured.
    pub fn unknown(reason: &str) -> Self {
        Self {
            cpu: Reading::unknown(reason),
            memory: Reading::unknown(reason),
            disk_io: Reading::unknown(reason),
            commit: None,
            network: None,
            volumes: None,
            processes: None,
            gpu: None,
        }
    }
}

/// Measures the system. Implementations must not block for long (the governor calls this on its
/// own thread, never on a caller's) and should report `Unknown`/`Unavailable` instead of
/// guessing. A panic is caught by the governor and counted as a failed sample.
pub trait SystemProbe: Send {
    fn sample(&mut self, plan: &ProbePlan<'_>) -> RawSample;
}

/// Why GPU metrics are not reported. There is no documented, low-cost, vendor-neutral OS API for
/// machine-wide GPU utilization and VRAM use that this crate can call without new unsafe code
/// (Windows exposes them through PDH "GPU Engine" / "GPU Adapter Memory" counters, which need an
/// audited FFI site). Reported honestly instead of guessed.
pub const GPU_UNAVAILABLE: &str = "GPU metrics are not available in this build";

const WARMING_UP: &str = "warming up: needs a second measurement";

/// The real probe, built on `sysinfo`. Collects executable names, parent ids, CPU and resident
/// memory of processes — never command lines or environments.
pub struct SysinfoProbe {
    system: System,
    disks: Disks,
    networks: Networks,
    /// Pids measured at the previous process refresh (their CPU use is meaningful now).
    seen: HashSet<u32>,
    cpu_primed: bool,
}

impl Default for SysinfoProbe {
    fn default() -> Self {
        Self::new()
    }
}

impl SysinfoProbe {
    /// Cheap: nothing is enumerated until the first sample.
    pub fn new() -> Self {
        Self {
            system: System::new(),
            disks: Disks::new(),
            networks: Networks::new(),
            seen: HashSet::new(),
            cpu_primed: false,
        }
    }

    fn cpu(&mut self) -> Reading<RawCpu> {
        self.system.refresh_cpu_usage();
        let cores = u32::try_from(self.system.cpus().len()).unwrap_or(u32::MAX);
        if cores == 0 {
            return Reading::unknown("no CPU information from the operating system");
        }
        if !self.cpu_primed {
            self.cpu_primed = true;
            return Reading::unknown(WARMING_UP);
        }
        let total = self.system.global_cpu_usage();
        if !total.is_finite() {
            return Reading::unknown("CPU counter returned an invalid value");
        }
        Reading::Value(RawCpu {
            total_percent: total.clamp(0.0, 100.0),
            logical_cores: cores,
        })
    }

    fn memory(&mut self) -> Reading<RawMemory> {
        self.system
            .refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram());
        let total = self.system.total_memory();
        if total == 0 {
            return Reading::unknown("no memory information from the operating system");
        }
        let available = self.system.available_memory().min(total);
        #[cfg(target_os = "macos")]
        let available = reconcile_available_memory(
            total,
            available,
            macos::memorystatus_level(),
            macos::memorystatus_pressure_level(),
        );
        Reading::Value(RawMemory {
            total_bytes: total,
            available_bytes: available,
        })
    }

    fn commit(&mut self) -> Reading<CommitReading> {
        if !cfg!(windows) {
            return Reading::unavailable("commit charge is reported on Windows only");
        }
        self.system
            .refresh_memory_specifics(MemoryRefreshKind::nothing().with_swap());
        // On Windows sysinfo reports swap as commit counters minus physical memory, clamped at
        // zero: swap_total = limit − physical, swap_used = max(charge − physical, 0).
        let physical = self.system.total_memory();
        if physical == 0 {
            return Reading::unknown("no memory information from the operating system");
        }
        let limit = self.system.total_swap().saturating_add(physical);
        let over = self.system.used_swap();
        let used = if over > 0 {
            CommitUsed::Exact(over.saturating_add(physical))
        } else {
            CommitUsed::AtMost(physical)
        };
        Reading::Value(CommitReading {
            limit_bytes: limit,
            used,
        })
    }

    fn inventory(&mut self) {
        self.disks.refresh_specifics(
            true,
            DiskRefreshKind::nothing().with_storage().with_io_usage(),
        );
        self.networks.refresh(true);
    }

    fn disk_generation(&self) -> u64 {
        let mut hasher = DefaultHasher::new();
        for disk in self.disks.list() {
            disk.mount_point().hash(&mut hasher);
        }
        hasher.finish()
    }

    fn disk_io(&mut self) -> Reading<Counters> {
        if self.disks.list().is_empty() {
            return Reading::unknown("no fixed volumes found");
        }
        let mut read = 0u64;
        let mut written = 0u64;
        for disk in self.disks.list_mut() {
            disk.refresh_specifics(DiskRefreshKind::nothing().with_io_usage());
            let usage = disk.usage();
            read = read.saturating_add(usage.total_read_bytes);
            written = written.saturating_add(usage.total_written_bytes);
        }
        Reading::Value(Counters {
            generation: self.disk_generation(),
            a_bytes: read,
            b_bytes: written,
        })
    }

    fn network(&mut self) -> Reading<Counters> {
        self.networks.refresh(false);
        // Filter drivers (packet capture, QoS, firewall layers) appear as extra interfaces that
        // mirror a physical interface's counters exactly: count identical pairs once.
        let mut unique: BTreeMap<(u64, u64), &str> = BTreeMap::new();
        for (name, data) in self.networks.iter() {
            if name.to_ascii_lowercase().contains("loopback") {
                continue;
            }
            let key = (data.total_received(), data.total_transmitted());
            if key != (0, 0) {
                unique.entry(key).or_insert(name.as_str());
            }
        }
        if self.networks.iter().next().is_none() {
            return Reading::unknown("no network interfaces found");
        }
        let mut hasher = DefaultHasher::new();
        let mut names: Vec<&str> = unique.values().copied().collect();
        names.sort_unstable();
        names.hash(&mut hasher);
        let (rx, tx) = unique.keys().fold((0u64, 0u64), |(rx, tx), (r, t)| {
            (rx.saturating_add(*r), tx.saturating_add(*t))
        });
        Reading::Value(Counters {
            generation: hasher.finish(),
            a_bytes: rx,
            b_bytes: tx,
        })
    }

    fn volumes(&mut self, roots: &[WorkspaceRoot]) -> Reading<Vec<VolumeReading>> {
        if roots.is_empty() {
            return Reading::Value(Vec::new());
        }
        if self.disks.list().is_empty() {
            return Reading::unknown("no fixed volumes found");
        }
        let mounts: Vec<PathBuf> = self
            .disks
            .list()
            .iter()
            .map(|d| d.mount_point().to_path_buf())
            .collect();
        let mut by_mount: BTreeMap<usize, Vec<Option<String>>> = BTreeMap::new();
        for root in roots {
            if let Some(index) = volume_for(&mounts, &root.path) {
                by_mount
                    .entry(index)
                    .or_default()
                    .push(root.workspace_id.clone());
            }
        }
        if by_mount.is_empty() {
            return Reading::unknown("workspace folders are not on a fixed local volume");
        }
        let list = self.disks.list_mut();
        let mut readings = Vec::with_capacity(by_mount.len());
        for (index, workspace_ids) in by_mount {
            let Some(disk) = list.get_mut(index) else {
                continue;
            };
            disk.refresh_specifics(DiskRefreshKind::nothing().with_storage());
            if disk.total_space() == 0 {
                continue;
            }
            readings.push(VolumeReading {
                mount: disk.mount_point().display().to_string(),
                workspace_ids,
                total_bytes: disk.total_space(),
                free_bytes: disk.available_space(),
            });
        }
        Reading::Value(readings)
    }

    fn processes(&mut self, plan: &ProbePlan<'_>, cores: u32) -> Reading<RawProcesses> {
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_cpu().with_memory(),
        );
        let processes = self.system.processes();
        if processes.is_empty() {
            return Reading::unknown("the process list is empty");
        }
        let cores = cores.max(1) as f32;
        let entries: Vec<ProcEntry> = processes
            .iter()
            .map(|(pid, process)| {
                let pid = pid.as_u32();
                ProcEntry {
                    pid,
                    parent: process.parent().map(|p| p.as_u32()),
                    name: process.name().to_string_lossy().into_owned(),
                    start_time: process.start_time(),
                    cpu_percent: self
                        .seen
                        .contains(&pid)
                        .then(|| (process.cpu_usage() / cores).clamp(0.0, 100.0)),
                    rss_bytes: process.memory(),
                }
            })
            .collect();
        self.seen = entries.iter().map(|e| e.pid).collect();
        let count = u32::try_from(entries.len()).unwrap_or(u32::MAX);
        let result = build_tree(&entries, plan.self_pid, plan.roots);
        Reading::Value(RawProcesses {
            count,
            tree: result.tree,
            vanished_roots: result.vanished_roots,
        })
    }
}

impl SystemProbe for SysinfoProbe {
    fn sample(&mut self, plan: &ProbePlan<'_>) -> RawSample {
        if plan.tiers.inventory {
            self.inventory();
        }
        let cpu = self.cpu();
        let memory = self.memory();
        let disk_io = self.disk_io();
        let cores = u32::try_from(self.system.cpus().len()).unwrap_or(1);
        let (commit, network, volumes) = if plan.tiers.slow {
            (
                Some(self.commit()),
                Some(self.network()),
                Some(self.volumes(plan.workspace_roots)),
            )
        } else {
            (None, None, None)
        };
        let processes = plan.tiers.processes.then(|| self.processes(plan, cores));
        let gpu = plan
            .tiers
            .inventory
            .then(|| Reading::unavailable(GPU_UNAVAILABLE));
        RawSample {
            cpu,
            memory,
            disk_io,
            commit,
            network,
            volumes,
            processes,
            gpu,
        }
    }
}

/// Index of the mount point containing `path` (longest match). Comparison is case-insensitive on
/// Windows.
pub fn volume_for(mounts: &[PathBuf], path: &Path) -> Option<usize> {
    let key = |p: &Path| -> Vec<String> {
        p.components()
            .filter(|c| !matches!(c, Component::CurDir))
            .map(|c| {
                let s = c.as_os_str().to_string_lossy();
                if cfg!(windows) {
                    s.to_lowercase()
                } else {
                    s.into_owned()
                }
            })
            .collect()
    };
    let target = key(path);
    mounts
        .iter()
        .enumerate()
        .filter_map(|(index, mount)| {
            let prefix = key(mount);
            (!prefix.is_empty() && target.starts_with(&prefix)).then_some((prefix.len(), index))
        })
        .max()
        .map(|(_, index)| index)
}

#[cfg(test)]
mod macos_memory_tests {
    use super::*;

    const GIB: u64 = 1024 * 1024 * 1024;
    const MIB: u64 = 1024 * 1024;

    /// The owner's M1 (16 GiB): sysinfo reads ~3,694 MiB available while the kernel reports 74%
    /// free at normal pressure.
    #[test]
    fn a_healthy_mac_counts_the_memory_the_kernel_reports_free() {
        let available = reconcile_available_memory(16 * GIB, 3_694 * MIB, Some(74), Some(1));
        assert_eq!(available, 16 * GIB * 74 / 100);
        assert!(available / MIB > 12_000);
    }

    #[test]
    fn pressure_or_missing_kernel_data_keeps_the_conservative_figure() {
        for (percent, level) in [
            (Some(74), Some(2)),
            (Some(74), Some(4)),
            (Some(74), None),
            (None, Some(1)),
            (Some(101), Some(1)),
        ] {
            assert_eq!(
                reconcile_available_memory(16 * GIB, 3_694 * MIB, percent, level),
                3_694 * MIB,
                "{percent:?} {level:?}"
            );
        }
    }

    #[test]
    fn the_result_is_bounded_by_sysinfo_below_and_total_above() {
        // The kernel reporting less than sysinfo never lowers the figure.
        assert_eq!(
            reconcile_available_memory(16 * GIB, 8 * GIB, Some(10), Some(1)),
            8 * GIB
        );
        assert_eq!(
            reconcile_available_memory(16 * GIB, 20 * GIB, Some(100), Some(1)),
            16 * GIB
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn volume_for_picks_the_longest_mount_prefix() {
        #[cfg(windows)]
        {
            let mounts = vec![
                PathBuf::from("C:\\"),
                PathBuf::from("C:\\mnt\\data\\"),
                PathBuf::from("D:\\"),
            ];
            assert_eq!(
                volume_for(&mounts, Path::new("c:\\Users\\me\\repo")),
                Some(0)
            );
            assert_eq!(volume_for(&mounts, Path::new("C:\\mnt\\data\\ws")), Some(1));
            assert_eq!(volume_for(&mounts, Path::new("D:\\x")), Some(2));
            assert_eq!(volume_for(&mounts, Path::new("E:\\x")), None);
            assert_eq!(volume_for(&mounts, Path::new("\\\\server\\share\\x")), None);
        }
        #[cfg(not(windows))]
        {
            let mounts = vec![
                PathBuf::from("/"),
                PathBuf::from("/home"),
                PathBuf::from("/mnt/data"),
            ];
            assert_eq!(volume_for(&mounts, Path::new("/home/me/repo")), Some(1));
            assert_eq!(volume_for(&mounts, Path::new("/mnt/data/ws")), Some(2));
            assert_eq!(volume_for(&mounts, Path::new("/opt/x")), Some(0));
            assert_eq!(volume_for(&mounts, Path::new("/homework")), Some(0));
        }
    }
}
