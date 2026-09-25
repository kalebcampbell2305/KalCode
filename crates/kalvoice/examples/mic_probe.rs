//! Measures how long the default microphone takes to start (key-down → capture active).
//! Opens the microphone briefly; the audio is discarded unread. Usage: mic_probe [runs]
#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::time::{Duration, Instant};

use kalcode_kalvoice::audio::{AudioSource, MicrophoneSource};

fn main() {
    let runs: usize = std::env::args()
        .nth(1)
        .and_then(|n| n.parse().ok())
        .unwrap_or(10);
    let mut times = Vec::new();
    for _ in 0..runs {
        let t = Instant::now();
        let capture = MicrophoneSource
            .start(Duration::from_secs(5))
            .expect("microphone");
        times.push(t.elapsed().as_secs_f64() * 1000.0);
        std::thread::sleep(Duration::from_millis(150));
        capture.cancel();
    }
    let mut sorted = times.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let pick = |p: f64| sorted[((p * (sorted.len() - 1) as f64).round()) as usize];
    println!(
        "runs={runs} first={:.1}ms p50={:.1}ms p95={:.1}ms max={:.1}ms",
        times[0],
        pick(0.5),
        pick(0.95),
        sorted[sorted.len() - 1]
    );
}
