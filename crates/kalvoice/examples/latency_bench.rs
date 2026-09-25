//! KalVoice latency benchmark: plays WAV fixtures through the real pipeline (capture seam →
//! streaming whisper.cpp → grammar/router → orchestrator → executor) and reports per-stage
//! p50/p95/p99 against `benches/budgets.json`.
//!
//! Fixtures: `tooling/kalvoice/make-fixtures.ps1` (local OS text-to-speech; no human audio).
//! The audio source is injected: each WAV is fed in real time, 20 ms at a time, as a
//! microphone would, and the key is released when the WAV ends.
//!
//! Usage:
//!   cargo run --release -p kalcode-kalvoice --features whisper --example latency_bench -- \
//!     --model <ggml-base.en.bin> --fixtures <dir> [--runs 3] [--cpu-load 8] \
//!     [--workspaces 2000] [--out results.json] [--check]
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::print_stdout)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use kalcode_contracts::kalvoice::{KalVoiceIntent, KalVoiceMode};
use kalcode_contracts::permissions::AskUnlessReadGate;
use kalcode_core::flags::BuildChannel;
use kalcode_core::{Core, CoreConfig, Paths};
use kalcode_kalvoice::audio::{ActiveCapture, AudioSource, CaptureError};
use kalcode_kalvoice::latency::percentile;
use kalcode_kalvoice::orchestrator::{
    ExecContext, ExecError, Executed, Executor, NoProviders, Orchestrator, TalkRequest, TalkTarget,
    UiDirective,
};
use kalcode_kalvoice::plan::{FixedEntitlement, Tier};
use kalcode_kalvoice::stt::{RecognizerCache, SpeechRecognizer, SttError};
use kalcode_kalvoice::voice::{RecognizerSource, VoiceController, VoiceResult};

// ---------------------------------------------------------------------------------------------
// Injected audio: a WAV played in real time.

struct WavSource {
    next: Mutex<Vec<f32>>,
}

struct Playing {
    buffer: Arc<Mutex<Vec<f32>>>,
    stop: Arc<AtomicBool>,
}

impl AudioSource for WavSource {
    fn start(&self, _max: Duration) -> Result<Box<dyn ActiveCapture>, CaptureError> {
        let samples = std::mem::take(&mut *self.next.lock().unwrap());
        let buffer = Arc::new(Mutex::new(Vec::with_capacity(samples.len())));
        let stop = Arc::new(AtomicBool::new(false));
        let (b, s) = (buffer.clone(), stop.clone());
        std::thread::spawn(move || {
            let start = Instant::now();
            for (i, chunk) in samples.chunks(320).enumerate() {
                if s.load(Ordering::SeqCst) {
                    break;
                }
                let due = start + Duration::from_millis(20 * i as u64);
                if let Some(wait) = due.checked_duration_since(Instant::now()) {
                    std::thread::sleep(wait);
                }
                b.lock().unwrap().extend_from_slice(chunk);
            }
        });
        Ok(Box::new(Playing { buffer, stop }))
    }
}

impl ActiveCapture for Playing {
    fn finish(self: Box<Self>) -> Result<Vec<f32>, CaptureError> {
        self.stop.store(true, Ordering::SeqCst);
        Ok(self.buffer.lock().unwrap().clone())
    }
    fn cancel(self: Box<Self>) {
        self.stop.store(true, Ordering::SeqCst);
    }
    fn snapshot(&self) -> Vec<f32> {
        self.buffer.lock().unwrap().clone()
    }
}

struct Warm(Arc<dyn SpeechRecognizer>);

impl RecognizerSource for Warm {
    fn ready(&self) -> Result<(), SttError> {
        Ok(())
    }
    fn recognizer(&self) -> Result<Arc<dyn SpeechRecognizer>, SttError> {
        Ok(self.0.clone())
    }
}

/// Fixture runtime state: many workspaces to resolve against (large-workspace scenario).
struct FixtureExecutor {
    workspaces: Vec<(String, String)>,
}

impl Executor for FixtureExecutor {
    fn find_workspace(&self, name: &str) -> Result<Option<String>, ExecError> {
        Ok(self
            .workspaces
            .iter()
            .find(|(_, n)| n == name)
            .map(|(id, _)| id.clone()))
    }
    fn find_thread(&self, _name: &str) -> Result<Option<String>, ExecError> {
        Ok(None)
    }
    fn check(&self, _intent: &KalVoiceIntent) -> Result<(), ExecError> {
        Ok(())
    }
    fn execute(&self, intent: &KalVoiceIntent, _ctx: &ExecContext) -> Result<Executed, ExecError> {
        Ok(Executed {
            summary: intent.kind_name().to_owned(),
            directive: match intent {
                KalVoiceIntent::Navigate { surface } => {
                    Some(UiDirective::Navigate { surface: *surface })
                }
                _ => None,
            },
        })
    }
}

fn read_wav(path: &Path) -> Vec<f32> {
    let bytes = std::fs::read(path).unwrap();
    let mut pos = 12;
    while pos + 8 <= bytes.len() {
        let len = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().unwrap()) as usize;
        if &bytes[pos..pos + 4] == b"data" {
            return bytes[pos + 8..pos + 8 + len]
                .chunks_exact(2)
                .map(|c| f32::from(i16::from_le_bytes([c[0], c[1]])) / 32768.0)
                .collect();
        }
        pos += 8 + len + (len % 2);
    }
    panic!("no data chunk in {}", path.display())
}

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let model = PathBuf::from(arg(&args, "--model").expect("--model"));
    let fixtures = PathBuf::from(arg(&args, "--fixtures").expect("--fixtures"));
    let runs: usize = arg(&args, "--runs")
        .and_then(|v| v.parse().ok())
        .unwrap_or(3);
    let cpu_load: usize = arg(&args, "--cpu-load")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let workspace_count: usize = arg(&args, "--workspaces")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let check = args.iter().any(|a| a == "--check");

    let stop_load = Arc::new(AtomicBool::new(false));
    for _ in 0..cpu_load {
        let stop = stop_load.clone();
        std::thread::spawn(move || {
            let mut x = 0u64;
            while !stop.load(Ordering::Relaxed) {
                x = x.wrapping_mul(6364136223846793005).wrapping_add(1);
                std::hint::black_box(x);
            }
        });
    }

    let dir = tempfile_dir();
    let core = Arc::new(
        Core::open_with_migrations(
            CoreConfig {
                paths: Paths::new(&dir),
                app_version: "bench".into(),
                channel: BuildChannel::Development,
            },
            &kalcode_kalvoice::schema::migrations_with_kalvoice(),
        )
        .expect("core"),
    );
    let load = Instant::now();
    let recognizer = RecognizerCache::default().get(&model, true).expect("model");
    let model_load_ms = load.elapsed().as_secs_f64() * 1000.0;
    let source = Arc::new(WavSource {
        next: Mutex::new(Vec::new()),
    });
    let voice = VoiceController::new(
        core.clone(),
        source.clone(),
        Arc::new(Warm(recognizer.clone())),
    );
    let mut workspaces: Vec<(String, String)> = (0..workspace_count)
        .map(|i| (kalcode_contracts::ids::new_id(), format!("project {i}")))
        .collect();
    workspaces.push((kalcode_contracts::ids::new_id(), "authentication".into()));
    let orchestrator = Orchestrator::new(
        core,
        Arc::new(FixedEntitlement(Tier::Owner)),
        Arc::new(FixtureExecutor { workspaces }),
        Arc::new(AskUnlessReadGate),
        Arc::new(NoProviders),
    );

    let mut files: Vec<PathBuf> = std::fs::read_dir(&fixtures)
        .expect("fixtures")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|e| e == "wav"))
        .collect();
    files.sort();

    // Warm-up pass (first decode allocates buffers).
    let _ = recognizer.transcribe(&read_wav(&files[0]));

    let mut stages: BTreeMap<&str, Vec<f64>> = BTreeMap::new();
    let mut rows = Vec::new();
    for run in 0..runs {
        for file in &files {
            let audio = read_wav(file);
            let secs = audio.len() as f64 / 16_000.0;
            *source.next.lock().unwrap() = audio;
            let pressed = Instant::now();
            let id = voice
                .begin_at(KalVoiceMode::Command, pressed)
                .expect("begin");
            std::thread::sleep(Duration::from_secs_f64(secs) + Duration::from_millis(30));
            let finished = voice.end_timed(&id).expect("end");
            let text = match &finished.result {
                VoiceResult::Transcript { text, .. } => text.clone(),
                VoiceResult::NothingHeard { .. } => String::new(),
            };
            let t = Instant::now();
            let talked = orchestrator
                .talk(
                    TalkRequest {
                        request_id: kalcode_contracts::ids::new_id(),
                        session_id: id,
                        text: text.clone(),
                        target: TalkTarget::None,
                        duration_ms: (secs * 1000.0) as u64,
                        workspace_id: None,
                    },
                    &|_| {},
                )
                .expect("talk");
            let handled_ms = t.elapsed().as_secs_f64() * 1000.0;
            let timings = finished.timings;
            for (name, value) in [
                ("keyDownToMic", timings.key_down_to_mic),
                ("speechToPartial", timings.speech_to_partial),
                ("keyUpToFinal", timings.key_up_to_final),
                ("finalToRecognized", Some(talked.recognized_ms)),
                (
                    "recognizedToExecuted",
                    Some((handled_ms - talked.recognized_ms).max(0.0)),
                ),
            ] {
                if let Some(v) = value {
                    stages.entry(name).or_default().push(v);
                }
            }
            let name = file.file_name().unwrap().to_string_lossy().into_owned();
            println!(
                "run {run} {name:32} {secs:5.2}s  final {:7.1} ms ({:14})  partial {:>7}  route {:?}  \"{text}\"",
                timings.key_up_to_final.unwrap_or(0.0),
                timings.final_source.clone().unwrap_or_default(),
                timings
                    .speech_to_partial
                    .map(|v| format!("{v:.0} ms"))
                    .unwrap_or_else(|| "-".into()),
                talked.route,
            );
            rows.push(serde_json::json!({
                "run": run, "fixture": name, "seconds": secs, "transcript": text,
                "route": format!("{:?}", talked.route), "timings": timings,
            }));
        }
    }
    stop_load.store(true, Ordering::Relaxed);

    let budgets: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/benches/budgets.json"))
            .expect("budgets"),
    )
    .expect("budgets json");
    let mut summary = serde_json::Map::new();
    let mut failures = Vec::new();
    println!(
        "\nmodel load {model_load_ms:.0} ms · cpu load threads {cpu_load} · workspaces {workspace_count}"
    );
    for (name, values) in &stages {
        let (p50, p95, p99) = (
            percentile(values, 50.0).unwrap_or(0.0),
            percentile(values, 95.0).unwrap_or(0.0),
            percentile(values, 99.0).unwrap_or(0.0),
        );
        let budget = budgets["regression"][name]["p95"].as_f64();
        let target = budgets["targets"][name]["p95"].as_f64();
        let status = match budget {
            Some(b) if p95 > b => {
                failures.push(format!("{name} p95 {p95:.1} ms > regression budget {b} ms"));
                "REGRESSION"
            }
            _ => "ok",
        };
        println!(
            "{name:22} n={:3}  p50 {p50:8.1}  p95 {p95:8.1}  p99 {p99:8.1} ms   target p95 {}   {status}",
            values.len(),
            target
                .map(|t| format!("{t} ms"))
                .unwrap_or_else(|| "-".into()),
        );
        summary.insert(
            (*name).to_owned(),
            serde_json::json!({ "n": values.len(), "p50": p50, "p95": p95, "p99": p99 }),
        );
    }
    if let Some(out) = arg(&args, "--out") {
        let report = serde_json::json!({
            "modelLoadMs": model_load_ms, "cpuLoadThreads": cpu_load, "workspaces": workspace_count,
            "runs": runs, "stages": summary, "rows": rows,
        });
        std::fs::write(out, serde_json::to_string_pretty(&report).unwrap()).expect("write report");
    }
    let _ = std::fs::remove_dir_all(&dir);
    if check && !failures.is_empty() {
        eprintln!("latency regression:\n  {}", failures.join("\n  "));
        std::process::exit(1);
    }
}

fn tempfile_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "kalvoice-bench-{}",
        kalcode_contracts::ids::new_id()
    ));
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}
