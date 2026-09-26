//! Overhead harness for the Resource Governor (evidence for `docs/campaigns/RG.md`).
//!
//! Runs the real governor (real probe, real clock) in one phase and prints the sampler's own
//! statistics as one JSON line. CPU time and memory of this process are measured from outside
//! (see the PowerShell snippet in `docs/campaigns/RG.md`), so the measurement adds no overhead.
//!
//! ```text
//! cargo build --release -p kalcode-resources --example overhead
//! target/release/examples/overhead baseline 60   # no governor: the process's own floor
//! target/release/examples/overhead idle 180      # governor, no activity (15 s cadence)
//! target/release/examples/overhead idle15 180     # as idle, watch rate forced to 15 s
//! target/release/examples/overhead active 180    # governor, 1 agent task running (1 Hz)
//! target/release/examples/overhead proclist 570  # slow-tier cost with ~570 extra processes
//! ```

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::process::{Child, Command};
use std::time::{Duration, Instant};

use kalcode_resources::model::Tiers;
use kalcode_resources::probe::{ProbePlan, SysinfoProbe, SystemProbe, WorkspaceRoot};
use kalcode_resources::{Activity, Governor, GovernorConfig};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let phase = args.get(1).map_or("idle", String::as_str);
    let seconds: u64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(60);
    match phase {
        "sleep" => std::thread::sleep(Duration::from_secs(seconds)),
        "proclist" => proclist(seconds as usize),
        "baseline" => {
            std::thread::sleep(Duration::from_secs(seconds));
            println!("{{\"phase\":\"baseline\",\"seconds\":{seconds}}}");
        }
        "idle" | "idle15" | "active" => run_governor(phase, seconds),
        other => panic!("unknown phase {other}"),
    }
}

fn run_governor(phase: &str, seconds: u64) {
    let mut config = GovernorConfig::default();
    if phase == "idle15" {
        // The idle cadence even while pressure develops: measures the 15 s rate on a machine
        // too busy for the governor to consider it calm.
        config.cadence.watch = config.cadence.idle;
    }
    let handle = Governor::start(config).expect("default mode is valid");
    let cwd = std::env::current_dir().expect("cwd");
    handle.set_workspaces(vec![WorkspaceRoot {
        workspace_id: Some("bench".into()),
        path: cwd,
    }]);
    if phase == "active" {
        handle.set_activity(Activity {
            active_tasks: 1,
            resource_view_open: false,
        });
    }
    let started = Instant::now();
    let mut machine_cpu = Vec::new();
    let mut reasons: std::collections::BTreeMap<String, u32> = std::collections::BTreeMap::new();
    while started.elapsed() < Duration::from_secs(seconds) {
        std::thread::sleep(Duration::from_secs(5));
        if let Some(cpu) = handle
            .latest()
            .and_then(|s| s.cpu.value().map(|c| c.smoothed_percent))
        {
            machine_cpu.push(cpu);
        }
        if let Some(snapshot) = handle.latest() {
            *reasons
                .entry(format!("{:?}", snapshot.sampling.reason))
                .or_default() += 1;
        }
    }
    let stats = handle.stats();
    let latest = handle.latest().expect("sampled");
    let processes = latest.process_count.value().copied().unwrap_or(0);
    let mean_cpu = machine_cpu.iter().sum::<f32>() / machine_cpu.len().max(1) as f32;
    let avg_ms = stats.total_probe_time.as_secs_f64() * 1000.0 / stats.samples.max(1) as f64;
    println!(
        "{{\"phase\":\"{phase}\",\"seconds\":{seconds},\"samples\":{},\"slowTierSamples\":{},\"processTierSamples\":{},\
         \"failedSamples\":{},\"avgProbeMs\":{avg_ms:.3},\"maxProbeMs\":{:.3},\"maxProcessTierMs\":{:.3},\"cadence\":{reasons:?},\
         \"processes\":{processes},\"machineCpuMeanPercent\":{mean_cpu:.1},\"status\":\"{:?}\"}}",
        stats.samples,
        stats.slow_tier_samples,
        stats.process_tier_samples,
        stats.failed_samples,
        stats.max_probe_time.as_secs_f64() * 1000.0,
        stats.max_process_tier_time.as_secs_f64() * 1000.0,
        handle.status(),
    );
    handle.shutdown();
}

/// Times the slow tier (process snapshot + tree) with `extra` sleeper processes added.
fn proclist(extra: usize) {
    let exe = std::env::current_exe().expect("exe");
    let mut sleepers: Vec<Child> = (0..extra)
        .map(|_| {
            let mut command = Command::new(&exe);
            hide_benchmark_process(&mut command);
            command
                .args(["sleep", "40"])
                .spawn()
                .expect("spawn sleeper")
        })
        .collect();
    std::thread::sleep(Duration::from_secs(3));
    let mut probe = SysinfoProbe::new();
    let all = Tiers {
        fast: true,
        slow: true,
        processes: true,
        inventory: true,
    };
    let plan = ProbePlan {
        tiers: all,
        self_pid: std::process::id(),
        roots: &[],
        workspace_roots: &[],
    };
    let mut times = Vec::new();
    let mut count = 0;
    let mut tree = 0;
    for _ in 0..10 {
        let started = Instant::now();
        let sample = probe.sample(&plan);
        times.push(started.elapsed().as_secs_f64() * 1000.0);
        if let Some(p) = sample.processes.as_ref().and_then(|p| p.value()) {
            count = p.count;
            tree = p.tree.processes.len();
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    let first = times[0];
    let rest = &times[1..];
    let mean = rest.iter().sum::<f64>() / rest.len() as f64;
    let max = rest.iter().copied().fold(0.0, f64::max);
    println!(
        "{{\"phase\":\"proclist\",\"processes\":{count},\"firstSampleMs\":{first:.1},\
         \"meanMs\":{mean:.1},\"maxMs\":{max:.1},\"treeProcesses\":{tree}}}"
    );
    for sleeper in &mut sleepers {
        let _ = sleeper.wait();
    }
}

#[cfg(windows)]
fn hide_benchmark_process(command: &mut Command) {
    use std::os::windows::process::CommandExt as _;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_benchmark_process(_command: &mut Command) {}
