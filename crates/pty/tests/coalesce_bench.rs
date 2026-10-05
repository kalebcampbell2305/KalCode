//! Throughput harness for terminal output coalescing (the per-view channel the desktop streams
//! PTY output through). Every delivery counted here is one webview channel message, which costs
//! the desktop's main thread a script evaluation and, above 1 KiB, a fetch round trip.
//!
//! Ignored by default (it writes a 50 MB file and drives a real pseudo-terminal). Run with
//! `cargo test -p kalcode-pty --release --test coalesce_bench -- --ignored --nocapture --test-threads=1`.

// Benchmark helpers outside `#[test]` functions panic on setup failures by design.
#![allow(clippy::expect_used)]

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use kalcode_pty::{CoalesceConfig, OutputCoalescer, PtySession, SpawnSpec, TerminalSize};

/// Deterministic mixed log lines (1–200 visible bytes, some ANSI colour), `total` bytes long.
fn mixed_lines(total: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(total + 256);
    let mut seed = 0x2545_f491_u64;
    let mut line = 0u64;
    while out.len() < total {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        let width = 1 + (seed % 200) as usize;
        if line.is_multiple_of(7) {
            out.extend_from_slice(b"\x1b[32m");
        }
        out.extend_from_slice(format!("{line:>8} ").as_bytes());
        out.extend((0..width).map(|i| b'a' + ((seed as usize + i) % 26) as u8));
        if line.is_multiple_of(7) {
            out.extend_from_slice(b"\x1b[0m");
        }
        out.extend_from_slice(b"\r\n");
        line += 1;
    }
    out.truncate(total);
    out
}

/// This process's CPU time (user + kernel).
fn process_cpu() -> Duration {
    #[cfg(windows)]
    #[allow(unsafe_code)]
    {
        use windows::Win32::Foundation::FILETIME;
        use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
        let (mut created, mut exited, mut kernel, mut user) = (
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
        );
        // SAFETY: the pseudo-handle is always valid and every out-pointer is a live local.
        unsafe {
            GetProcessTimes(
                GetCurrentProcess(),
                &mut created,
                &mut exited,
                &mut kernel,
                &mut user,
            )
        }
        .expect("GetProcessTimes");
        let ticks = |t: FILETIME| u64::from(t.dwHighDateTime) << 32 | u64::from(t.dwLowDateTime);
        Duration::from_nanos((ticks(kernel) + ticks(user)) * 100)
    }
    #[cfg(not(windows))]
    {
        Duration::ZERO
    }
}

struct Run {
    deliveries: usize,
    bytes: usize,
    wall: Duration,
    cpu: Duration,
}

impl Run {
    fn print(&self, label: &str) {
        let secs = self.wall.as_secs_f64().max(1e-9);
        println!(
            "  {label:<34} {:>8} messages  {:>10.0} messages/s  {:>7.1} ms wall  {:>7.1} ms CPU  ({} bytes)",
            self.deliveries,
            self.deliveries as f64 / secs,
            secs * 1000.0,
            self.cpu.as_secs_f64() * 1000.0,
            self.bytes,
        );
    }
}

/// Pushes `chunks` as a reader thread would, through `coalesce` (or straight through when
/// `None`, as before coalescing). The sink copies each message like a channel send does.
fn pump(chunks: &[&[u8]], coalesce: Option<CoalesceConfig>, pace: Option<Duration>) -> Run {
    let deliveries = Arc::new(AtomicUsize::new(0));
    let received = Arc::new(Mutex::new(Vec::with_capacity(
        chunks.iter().map(|c| c.len()).sum(),
    )));
    let (count, sink) = (deliveries.clone(), received.clone());
    let deliver = move |bytes: Vec<u8>| {
        count.fetch_add(1, Ordering::Relaxed);
        sink.lock().expect("lock").extend_from_slice(&bytes);
        true
    };
    let cpu = process_cpu();
    let started = Instant::now();
    match coalesce {
        Some(config) => {
            let coalescer = OutputCoalescer::new(config, deliver);
            assert!(coalescer.push(b""));
            for chunk in chunks {
                assert!(coalescer.push(chunk));
                if let Some(pace) = pace {
                    spin(pace);
                }
            }
            drop(coalescer);
        }
        None => {
            assert!(deliver(Vec::new()));
            for chunk in chunks {
                assert!(deliver(chunk.to_vec()));
                if let Some(pace) = pace {
                    spin(pace);
                }
            }
        }
    }
    let wall = started.elapsed();
    let bytes = received.lock().expect("lock").len();
    let expected: Vec<u8> = chunks.concat();
    assert_eq!(*received.lock().expect("lock"), expected, "bytes and order");
    Run {
        deliveries: deliveries.load(Ordering::Relaxed),
        bytes,
        wall,
        cpu: process_cpu().saturating_sub(cpu),
    }
}

/// Busy-waits (a reader thread's arrival gap) without the scheduler's sleep granularity.
fn spin(gap: Duration) {
    let until = Instant::now() + gap;
    while Instant::now() < until {
        std::hint::spin_loop();
    }
}

#[test]
#[ignore = "throughput benchmark"]
fn synthetic_streams() {
    let data = mixed_lines(50 * 1024 * 1024);
    // ConPTY hands a reader anything from a few bytes to the 16 KiB read buffer.
    let mut chunks = Vec::new();
    let mut offset = 0;
    let mut seed = 7u64;
    while offset < data.len() {
        seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
        let size = 64 + (seed >> 33) as usize % (16 * 1024 - 64);
        let end = (offset + size).min(data.len());
        chunks.push(&data[offset..end]);
        offset = end;
    }
    println!("50 MB of mixed lines in {} reads:", chunks.len());
    pump(&chunks, None, None).print("before: one message per read");
    pump(&chunks, Some(CoalesceConfig::default()), None).print("after: coalesced");

    let small: Vec<&[u8]> = data[..100_000 * 48].chunks(48).collect();
    println!(
        "Burst of {} small (48-byte) reads, back to back:",
        small.len()
    );
    pump(&small, None, None).print("before: one message per read");
    pump(&small, Some(CoalesceConfig::default()), None).print("after: coalesced");

    // A provider redrawing its screen: small reads arriving every ~50 µs for about a second.
    let paced = &small[..20_000];
    println!("{} small reads arriving 50 µs apart:", paced.len());
    let gap = Some(Duration::from_micros(50));
    pump(paced, None, gap).print("before: one message per read");
    pump(paced, Some(CoalesceConfig::default()), gap).print("after: coalesced");
}

fn shell_spec(script: String) -> SpawnSpec {
    let (program, args) = if cfg!(windows) {
        let cmd =
            std::env::var("ComSpec").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".into());
        (PathBuf::from(cmd), vec!["/d".into(), "/c".into(), script])
    } else {
        (PathBuf::from("/bin/sh"), vec!["-c".into(), script])
    };
    SpawnSpec {
        program,
        args,
        cwd: std::env::temp_dir(),
        env: vec![("TERM".into(), "xterm-256color".into())],
        env_remove: vec![],
        size: TerminalSize::new(200, 50).expect("size"),
    }
}

/// `cat` of a 50 MB file in a real pseudo-terminal, with two views attached to the same session:
/// one forwarding every read (before) and one coalesced (after).
#[test]
#[ignore = "drives a real pseudo-terminal through 50 MB of output"]
fn cat_a_large_file_through_a_real_pty() {
    let dir = tempfile::tempdir().expect("temp dir");
    let file = dir.path().join("big.log");
    std::fs::write(&file, mixed_lines(50 * 1024 * 1024)).expect("write");
    // `cmd /c` mangles a quoted argument here; temp paths have no spaces.
    let script = if cfg!(windows) {
        format!("type {}", file.display())
    } else {
        format!("cat '{}'", file.display())
    };
    let exited = Arc::new(Mutex::new(None));
    let exit_sink = exited.clone();
    let session = PtySession::spawn(shell_spec(script), move |info| {
        *exit_sink.lock().expect("lock") = Some(Instant::now());
        let _ = info;
    })
    .expect("spawn");
    let started = Instant::now();

    let raw_messages = Arc::new(AtomicUsize::new(0));
    let raw_bytes = Arc::new(AtomicU64::new(0));
    let (messages, bytes) = (raw_messages.clone(), raw_bytes.clone());
    let responder = session.clone();
    let raw = session.attach(move |chunk| {
        messages.fetch_add(1, Ordering::Relaxed);
        bytes.fetch_add(chunk.len() as u64, Ordering::Relaxed);
        // Answer ConPTY's startup cursor query like a real view.
        for _ in 0..chunk.windows(4).filter(|w| *w == b"\x1b[6n").count() {
            let _ = responder.write(b"\x1b[1;1R");
        }
        true
    });

    let coalesced_messages = Arc::new(AtomicUsize::new(0));
    let coalesced_bytes = Arc::new(AtomicU64::new(0));
    let (messages, bytes) = (coalesced_messages.clone(), coalesced_bytes.clone());
    let coalescer = OutputCoalescer::new(CoalesceConfig::default(), move |chunk| {
        messages.fetch_add(1, Ordering::Relaxed);
        bytes.fetch_add(chunk.len() as u64, Ordering::Relaxed);
        true
    });
    let coalesced = session.attach(move |chunk| coalescer.push(chunk));

    let deadline = Instant::now() + Duration::from_secs(600);
    while exited.lock().expect("lock").is_none() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    // Let the reader drain what the shell wrote before it exited.
    let mut last = u64::MAX;
    while raw_bytes.load(Ordering::Relaxed) != last {
        last = raw_bytes.load(Ordering::Relaxed);
        std::thread::sleep(Duration::from_millis(300));
    }
    let wall = started.elapsed();
    session.detach(raw);
    session.detach(coalesced);
    let (raw_n, raw_b) = (
        raw_messages.load(Ordering::Relaxed),
        raw_bytes.load(Ordering::Relaxed),
    );
    let (co_n, co_b) = (
        coalesced_messages.load(Ordering::Relaxed),
        coalesced_bytes.load(Ordering::Relaxed),
    );
    let secs = wall.as_secs_f64();
    println!("cat of 50 MB through a real pseudo-terminal ({secs:.1} s, {raw_b} bytes rendered):");
    println!(
        "  before: one message per read   {raw_n:>8} messages  {:>8.0} messages/s",
        raw_n as f64 / secs
    );
    println!(
        "  after: coalesced               {co_n:>8} messages  {:>8.0} messages/s",
        co_n as f64 / secs
    );
    assert_eq!(raw_b, co_b, "both views received every byte");
}

/// What the commands that stay synchronous on the main thread cost on a live session.
#[test]
#[ignore = "drives a real pseudo-terminal"]
fn resize_and_full_scrollback_attach_cost() {
    let script = if cfg!(windows) {
        "for /L %i in (1,1,20000) do @echo line %i of scrollback filler text".to_owned()
    } else {
        "i=0; while [ $i -lt 20000 ]; do echo line $i of scrollback filler text; i=$((i+1)); done; sleep 30"
            .to_owned()
    };
    let session = PtySession::spawn(shell_spec(script), |_| {}).expect("spawn");
    let responder = session.clone();
    let id = session.attach(move |chunk| {
        for _ in 0..chunk.windows(4).filter(|w| *w == b"\x1b[6n").count() {
            let _ = responder.write(b"\x1b[1;1R");
        }
        true
    });
    std::thread::sleep(Duration::from_secs(8));

    let mut resizes = Vec::new();
    for i in 0..1000u16 {
        let size = TerminalSize::new(120 + i % 40, 40 + i % 10).expect("size");
        let started = Instant::now();
        if session.resize(size).is_err() {
            break; // the shell finished; enough samples were taken
        }
        resizes.push(started.elapsed());
    }
    resizes.sort();
    let at = |q: f64| resizes[((resizes.len() - 1) as f64 * q) as usize];
    println!(
        "resize: {} calls, p50 {:?}, p99 {:?}, max {:?}",
        resizes.len(),
        at(0.5),
        at(0.99),
        at(1.0)
    );

    let mut attaches = Vec::new();
    let mut replayed = 0;
    for _ in 0..50 {
        let size = Arc::new(AtomicUsize::new(0));
        let sink = size.clone();
        let started = Instant::now();
        let view = session.attach(move |chunk| {
            sink.fetch_max(chunk.len(), Ordering::Relaxed);
            // A channel send copies the replay once.
            std::hint::black_box(chunk.to_vec());
            true
        });
        attaches.push(started.elapsed());
        replayed = size.load(Ordering::Relaxed);
        session.detach(view);
    }
    attaches.sort();
    println!(
        "attach with a {replayed}-byte replay: p50 {:?}, max {:?}",
        attaches[attaches.len() / 2],
        attaches[attaches.len() - 1]
    );
    session.detach(id);
    let _ = session.kill();
}
