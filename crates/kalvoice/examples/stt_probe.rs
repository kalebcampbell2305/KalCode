//! Measures whisper.cpp latency options on WAV fixtures (developer tool; see
//! tooling/kalvoice/make-fixtures.ps1). Usage: stt_probe <model.bin> <fixtures dir>
#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::time::Instant;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

fn read_wav(path: &std::path::Path) -> Vec<f32> {
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
    panic!("no data")
}

fn run(
    ctx: &WhisperContext,
    audio: &[f32],
    audio_ctx: Option<i32>,
    threads: i32,
    max_tokens: i32,
) -> (String, f64) {
    let t = Instant::now();
    let mut state = ctx.create_state().unwrap();
    let mut p = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    p.set_language(Some("en"));
    p.set_n_threads(threads);
    p.set_no_context(true);
    p.set_no_timestamps(true);
    p.set_single_segment(true);
    p.set_print_progress(false);
    p.set_print_realtime(false);
    p.set_print_special(false);
    p.set_print_timestamps(false);
    p.set_temperature_inc(0.0);
    p.set_initial_prompt("KalCode, KalVoice, Claude Code, Codex, Gemini CLI, threads, workspace.");
    if let Some(a) = audio_ctx {
        p.set_audio_ctx(a);
    }
    if max_tokens > 0 {
        p.set_max_tokens(max_tokens);
    }
    p.set_suppress_nst(true);
    state.full(p, audio).unwrap();
    let text: String = state
        .as_iter()
        .map(|s| s.to_str_lossy().unwrap().into_owned())
        .collect();
    (text.trim().to_owned(), t.elapsed().as_secs_f64() * 1000.0)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    whisper_rs::install_logging_hooks();
    let t = Instant::now();
    let ctx =
        WhisperContext::new_with_params(&args[1], WhisperContextParameters::default()).unwrap();
    println!("load_ms={:.0}", t.elapsed().as_secs_f64() * 1000.0);
    let mut files: Vec<_> = std::fs::read_dir(&args[2])
        .unwrap()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|e| e == "wav"))
        .collect();
    files.sort();
    // warm-up
    let _ = run(&ctx, &read_wav(&files[0]), Some(256), 8, 0);
    for f in &files {
        let audio = read_wav(f);
        let secs = audio.len() as f64 / 16000.0;
        let pad = |min: i32| {
            (((secs * 50.0).ceil() as i32 + 64 + 63) / 64 * 64)
                .max(min)
                .min(1500)
        };
        let toks = (secs * 4.0).ceil() as i32 + 8;
        for (label, a, th, mt) in [
            ("ctx384+tok", Some(pad(384)), 12, toks),
            ("ctx512+tok", Some(pad(512)), 12, toks),
            ("ctx768+tok", Some(pad(768)), 12, toks),
        ] {
            let (text, ms) = run(&ctx, &audio, a, th, mt);
            println!(
                "{}	{secs:.2}s	{label}	{ms:.0}ms	{text}",
                f.file_name().unwrap().to_string_lossy()
            );
        }
    }
}
