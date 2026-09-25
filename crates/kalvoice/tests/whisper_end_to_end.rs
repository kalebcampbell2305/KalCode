//! End-to-end check of the real speech path on a developer machine: consented download of the
//! default model from its official source (size and SHA-256 verified), then on-device
//! transcription of a WAV recording, then the grammar.
//!
//! Ignored by default (it downloads ~148 MB). Run with the `whisper` feature and:
//!   KALVOICE_E2E_DIR=<empty folder for the model> KALVOICE_E2E_WAV=<16-bit PCM mono WAV>
//!   cargo test -p kalcode-kalvoice --features whisper --test whisper_end_to_end -- --ignored

#![cfg(feature = "whisper")]

use std::path::PathBuf;

use kalcode_contracts::agent::ProviderId;
use kalcode_contracts::kalvoice::KalVoiceIntent;
use kalcode_kalvoice::audio::resample_to_16k;
use kalcode_kalvoice::grammar::{Understood, understand};
use kalcode_kalvoice::models::{self, ModelStore};
use kalcode_kalvoice::stt::{RecognizerCache, heard_speech};

/// Minimal reader for 16-bit PCM mono WAV files.
fn read_wav(path: &PathBuf) -> (Vec<f32>, u32) {
    let bytes = std::fs::read(path).expect("wav");
    assert_eq!(&bytes[0..4], b"RIFF");
    let mut pos = 12;
    let mut rate = 0;
    let mut samples = Vec::new();
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let len = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().expect("len")) as usize;
        let body = &bytes[pos + 8..(pos + 8 + len).min(bytes.len())];
        if id == b"fmt " {
            assert_eq!(u16::from_le_bytes([body[0], body[1]]), 1, "PCM");
            assert_eq!(u16::from_le_bytes([body[2], body[3]]), 1, "mono");
            rate = u32::from_le_bytes(body[4..8].try_into().expect("rate"));
            assert_eq!(u16::from_le_bytes([body[14], body[15]]), 16, "16-bit");
        } else if id == b"data" {
            samples = body
                .chunks_exact(2)
                .map(|c| f32::from(i16::from_le_bytes([c[0], c[1]])) / 32_768.0)
                .collect();
        }
        pos += 8 + len + (len % 2);
    }
    (samples, rate)
}

#[test]
#[ignore = "downloads the 148 MB speech model; run explicitly on a developer machine"]
fn downloads_verifies_and_transcribes_on_device() {
    let dir = PathBuf::from(std::env::var("KALVOICE_E2E_DIR").expect("KALVOICE_E2E_DIR"));
    let wav = PathBuf::from(std::env::var("KALVOICE_E2E_WAV").expect("KALVOICE_E2E_WAV"));
    let store = ModelStore::new(&dir);
    let started = std::time::Instant::now();
    let path = store
        .download(models::DEFAULT_MODEL, true, |_, _| {})
        .expect("download and verify base.en");
    eprintln!("model ready in {:?}: {}", started.elapsed(), path.display());
    assert_eq!(store.installed_path("base.en"), Some(path.clone()));

    let (samples, rate) = read_wav(&wav);
    let audio = resample_to_16k(&samples, rate);
    assert!(heard_speech(&audio));
    let recognizer = RecognizerCache::default()
        .get(&path, true)
        .expect("load model");
    let started = std::time::Instant::now();
    let text = recognizer.transcribe(&audio).expect("transcribe");
    eprintln!("transcribed in {:?}: {text:?}", started.elapsed());
    assert!(text.to_lowercase().contains("thread"), "{text}");

    match understand(&text) {
        Understood::Intent {
            intent:
                KalVoiceIntent::CreateThreads {
                    provider_id, count, ..
                },
            target,
        } => {
            assert_eq!(provider_id, ProviderId::new(ProviderId::CODEX));
            assert_eq!(count, 4);
            eprintln!("grammar: create 4 codex threads, target {target:?}");
        }
        other => panic!("{text:?} understood as {other:?}"),
    }
}
