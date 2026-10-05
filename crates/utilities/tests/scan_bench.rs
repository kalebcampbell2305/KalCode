//! Timing harness for the Process Monitor's background scan (`utility_processes`).
//!
//! Ignored by default: it samples this machine's real process and socket tables. Run with
//! `cargo test -p kalcode-utilities --release --test scan_bench -- --ignored --nocapture`.

// Benchmark helpers outside `#[test]` functions panic on setup failures by design.
#![allow(clippy::expect_used)]

use std::time::{Duration, Instant};

use kalcode_utilities::ports;
use kalcode_utilities::processes::{ProcessContext, ProcessSampler};
use kalcode_utilities::types::ProcessScope;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

const CALLS: usize = 20;

/// This process's accumulated CPU time (user + kernel), in milliseconds.
fn own_cpu_ms(system: &mut System) -> u64 {
    let pid = Pid::from_u32(std::process::id());
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        false,
        ProcessRefreshKind::nothing().with_cpu(),
    );
    system
        .process(pid)
        .map_or(0, sysinfo::Process::accumulated_cpu_time)
}

fn report(label: &str, mut run: impl FnMut()) {
    let mut probe = System::new();
    let mut samples = Vec::with_capacity(CALLS);
    let cpu_before = own_cpu_ms(&mut probe);
    let started = Instant::now();
    let mut idle = Duration::ZERO;
    for _ in 0..CALLS {
        // The app samples every few seconds; back-to-back samples would only measure
        // sysinfo's minimum CPU interval wait.
        let pause = Instant::now();
        std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
        idle += pause.elapsed();
        let call = Instant::now();
        run();
        samples.push(call.elapsed());
    }
    let total = started.elapsed().saturating_sub(idle);
    let cpu = own_cpu_ms(&mut probe).saturating_sub(cpu_before);
    samples.sort();
    let ms = |d: Duration| d.as_secs_f64() * 1000.0;
    println!(
        "{label}: {CALLS} calls, total {:.0} ms, p50 {:.1} ms, p95 {:.1} ms, max {:.1} ms, \
         in-process CPU {cpu} ms ({:.1} ms/call)",
        ms(total),
        ms(samples[CALLS / 2]),
        ms(samples[CALLS * 95 / 100]),
        ms(samples[CALLS - 1]),
        cpu as f64 / CALLS as f64,
    );
}

#[test]
#[ignore = "samples this machine's live process and socket tables"]
fn utility_processes_scan_timing() {
    report("ports::list_raw", || {
        let (raw, _) = ports::list_raw().expect("list ports");
        assert!(!raw.is_empty());
    });
    let ctx = ProcessContext {
        self_pid: std::process::id(),
        ..ProcessContext::default()
    };
    let mut sampler = ProcessSampler::new();
    // The app keeps one sampler alive, so the first (cold) sample is not representative.
    let _ = sampler.list(&ctx, ProcessScope::Related);
    report("sampler.list(related)", || {
        let _ = sampler.list(&ctx, ProcessScope::Related);
    });
    report("utility_processes body (ports + related list)", || {
        let raw = ports::list_raw().map(|(raw, _)| raw).ok();
        let ctx = ProcessContext {
            self_pid: std::process::id(),
            listening: raw
                .as_deref()
                .map(|raw| ports::owners(raw).into_iter().collect())
                .unwrap_or_default(),
            ..ProcessContext::default()
        };
        let _ = sampler.list(&ctx, ProcessScope::Related);
    });
}

/// CPU the spawned `netstat -ano` itself burns per run (the in-process figure above cannot see
/// a child's CPU). Windows only: read from the child's own process times before it is reaped.
#[cfg(windows)]
#[test]
#[ignore = "spawns the system netstat tool"]
#[allow(unsafe_code)]
fn netstat_child_cpu() {
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;

    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::{GetProcessTimes, INFINITE, WaitForSingleObject};

    let ticks =
        |time: FILETIME| u64::from(time.dwHighDateTime) << 32 | u64::from(time.dwLowDateTime);
    let mut cpu_ms = Vec::with_capacity(CALLS);
    let mut wall_ms = Vec::with_capacity(CALLS);
    for _ in 0..CALLS {
        let started = Instant::now();
        let mut child = std::process::Command::new(ports::system32().join("netstat.exe"))
            .arg("-ano")
            .stdout(std::process::Stdio::null())
            .creation_flags(0x0800_0000)
            .spawn()
            .expect("spawn netstat");
        let handle = child.as_raw_handle();
        let zero = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
        // SAFETY: `handle` is the live child's process handle, owned by `child` until `wait`.
        let ok = unsafe {
            WaitForSingleObject(handle, INFINITE);
            GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user)
        };
        assert_ne!(ok, 0, "GetProcessTimes");
        wall_ms.push(started.elapsed().as_secs_f64() * 1000.0);
        cpu_ms.push((ticks(kernel) + ticks(user)) as f64 / 10_000.0);
        let _ = child.wait();
    }
    let mean = |v: &[f64]| v.iter().sum::<f64>() / v.len() as f64;
    println!(
        "netstat -ano child: {CALLS} runs, mean wall {:.0} ms, mean CPU {:.0} ms/run",
        mean(&wall_ms),
        mean(&cpu_ms)
    );
}
