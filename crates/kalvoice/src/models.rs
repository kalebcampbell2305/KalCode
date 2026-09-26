//! On-device speech models: catalog, consented download, verification, install and removal.
//!
//! Models come only from the official whisper.cpp distribution on Hugging Face
//! (`ggerganov/whisper.cpp`), pinned to one repository revision. Each file's size and SHA-256 are
//! pinned below from that revision's published LFS metadata; a download that does not match is
//! discarded. Nothing is downloaded without an explicit `consent` flag set by a user action.
//!
//! Downloads write to `<file>.partial` and resume from it (HTTP range requests); the hash covers
//! the whole file, and the file is renamed into place only after it verifies.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ts_rs::TS;

/// The fastest English model: the default, because push-to-talk latency matters most.
pub const DEFAULT_MODEL: &str = "tiny.en";

/// Pinned revision of <https://huggingface.co/ggerganov/whisper.cpp>.
pub const REPOSITORY_REVISION: &str = "5359861c739e955e79d9a303bcbc70fb988958b1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelSpec {
    pub id: &'static str,
    pub display_name: &'static str,
    pub file_name: &'static str,
    pub size_bytes: u64,
    pub sha256: &'static str,
    /// True for English-only models.
    pub english_only: bool,
    pub summary: &'static str,
}

/// Sizes and SHA-256 digests are the LFS metadata Hugging Face publishes for these files at
/// [`REPOSITORY_REVISION`].
pub const CATALOG: &[ModelSpec] = &[
    ModelSpec {
        id: "tiny.en",
        display_name: "English (fastest)",
        file_name: "ggml-tiny.en.bin",
        size_bytes: 77_704_715,
        sha256: "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f",
        english_only: true,
        summary: "Quickest response to commands. Recommended.",
    },
    ModelSpec {
        id: "base.en",
        display_name: "English (balanced)",
        file_name: "ggml-base.en.bin",
        size_bytes: 147_964_211,
        sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
        english_only: true,
        summary: "More accurate dictation; a little slower to respond.",
    },
    ModelSpec {
        id: "small.en",
        display_name: "English (more accurate)",
        file_name: "ggml-small.en.bin",
        size_bytes: 487_614_201,
        sha256: "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d",
        english_only: true,
        summary: "Better with accents and technical words; slower on older computers.",
    },
    ModelSpec {
        id: "base",
        display_name: "Multilingual (compact)",
        file_name: "ggml-base.bin",
        size_bytes: 147_951_465,
        sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
        english_only: false,
        summary: "Detects and transcribes about 100 languages.",
    },
    ModelSpec {
        id: "small",
        display_name: "Multilingual (more accurate)",
        file_name: "ggml-small.bin",
        size_bytes: 487_601_967,
        sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
        english_only: false,
        summary: "About 100 languages with higher accuracy; slower on older computers.",
    },
];

pub fn find(id: &str) -> Option<&'static ModelSpec> {
    CATALOG.iter().find(|m| m.id == id)
}

/// The official download URL for a catalog model.
pub fn official_url(spec: &ModelSpec) -> String {
    format!(
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/{REPOSITORY_REVISION}/{}",
        spec.file_name
    )
}

/// Where and what to download. Catalog models use [`official_url`]; tests point at a local
/// server.
#[derive(Debug, Clone)]
pub struct Source {
    pub url: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub sha256: String,
}

impl Source {
    pub fn official(spec: &ModelSpec) -> Self {
        Self {
            url: official_url(spec),
            file_name: spec.file_name.to_owned(),
            size_bytes: spec.size_bytes,
            sha256: spec.sha256.to_owned(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum SpeechModelState {
    NotInstalled,
    /// A download is running now.
    Downloading {
        received_bytes: u64,
    },
    /// A cancelled or interrupted download that can resume.
    Paused {
        received_bytes: u64,
    },
    Installed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SpeechModelInfo {
    pub id: String,
    pub display_name: String,
    pub summary: String,
    pub size_bytes: u64,
    pub english_only: bool,
    pub state: SpeechModelState,
    /// Where it comes from, for the consent dialog.
    pub source: String,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ModelError {
    #[error("Downloading a speech model needs your permission first.")]
    ConsentRequired,
    #[error("That speech model isn't in KalVoice's catalog.")]
    Unknown,
    #[error("A download for this model is already running.")]
    AlreadyDownloading,
    #[error("The download was cancelled. It can resume where it stopped.")]
    Cancelled,
    #[error("The download didn't match the published checksum, so it was discarded.")]
    ChecksumMismatch,
    #[error("The download server sent an unexpected response ({0}).")]
    Server(String),
    #[error("The download was interrupted. Try again to resume it.")]
    Network(String),
    #[error("KalVoice couldn't write the model file: {0}")]
    Storage(String),
}

impl ModelError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::ConsentRequired => "consent_required",
            Self::Unknown => "unknown_speech_model",
            Self::AlreadyDownloading => "download_in_progress",
            Self::Cancelled => "download_cancelled",
            Self::ChecksumMismatch => "checksum_mismatch",
            Self::Server(_) => "download_server_error",
            Self::Network(_) => "download_interrupted",
            Self::Storage(_) => "model_storage_failed",
        }
    }
}

fn storage(e: std::io::Error) -> ModelError {
    ModelError::Storage(e.kind().to_string())
}

/// Model files under `<data_dir>/models/whisper`.
#[derive(Debug)]
pub struct ModelStore {
    dir: PathBuf,
    running: std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<AtomicBool>>>,
    settled: std::sync::Condvar,
}

struct DownloadRegistration<'a> {
    store: &'a ModelStore,
    id: String,
}

impl Drop for DownloadRegistration<'_> {
    fn drop(&mut self) {
        self.store
            .running
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.id);
        self.store.settled.notify_all();
    }
}

impl ModelStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            dir: data_dir.join("models").join("whisper"),
            running: std::sync::Mutex::new(std::collections::HashMap::new()),
            settled: std::sync::Condvar::new(),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn final_path(&self, file_name: &str) -> PathBuf {
        self.dir.join(file_name)
    }

    fn partial_path(&self, file_name: &str) -> PathBuf {
        self.dir.join(format!("{file_name}.partial"))
    }

    /// The apparent installed file for a catalog model (present with the expected size).
    ///
    /// This is intentionally a metadata-only check for status polling. It is not an integrity
    /// boundary; callers that will load or otherwise trust the bytes must use
    /// [`Self::verified_path`].
    pub fn installed_path(&self, id: &str) -> Option<PathBuf> {
        let spec = find(id)?;
        let path = self.final_path(spec.file_name);
        fs::metadata(&path)
            .ok()
            .filter(|m| m.len() == spec.size_bytes)
            .map(|_| path)
    }

    /// Returns a catalog model only after its bytes match the pinned SHA-256 digest.
    ///
    /// A same-size file with the wrong digest is removed so subsequent status reads report the
    /// model honestly as not installed. This performs disk I/O and belongs at a load boundary,
    /// not in [`Self::list`] or another frequently-polled UI path.
    pub fn verified_path(&self, id: &str) -> Result<Option<PathBuf>, ModelError> {
        let spec = find(id).ok_or(ModelError::Unknown)?;
        self.verified_source_path(&Source::official(spec))
    }

    fn verified_source_path(&self, source: &Source) -> Result<Option<PathBuf>, ModelError> {
        let path = self.final_path(&source.file_name);
        let metadata = match fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(storage(error)),
        };
        if metadata.len() != source.size_bytes {
            return Ok(None);
        }

        let mut file = File::open(&path).map_err(storage)?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0_u8; 1 << 20];
        loop {
            let read = file.read(&mut buffer).map_err(storage)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        let digest: String = hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        if digest.eq_ignore_ascii_case(&source.sha256) {
            return Ok(Some(path));
        }

        fs::remove_file(&path).map_err(storage)?;
        Err(ModelError::ChecksumMismatch)
    }

    pub fn list(&self) -> Vec<SpeechModelInfo> {
        CATALOG
            .iter()
            .map(|spec| {
                let partial = fs::metadata(self.partial_path(spec.file_name))
                    .map(|m| m.len())
                    .ok();
                let state = if self.installed_path(spec.id).is_some() {
                    SpeechModelState::Installed
                } else if self.is_running(spec.id) {
                    SpeechModelState::Downloading {
                        received_bytes: partial.unwrap_or(0),
                    }
                } else if let Some(received_bytes) = partial.filter(|n| *n > 0) {
                    SpeechModelState::Paused { received_bytes }
                } else {
                    SpeechModelState::NotInstalled
                };
                SpeechModelInfo {
                    id: spec.id.to_owned(),
                    display_name: spec.display_name.to_owned(),
                    summary: spec.summary.to_owned(),
                    size_bytes: spec.size_bytes,
                    english_only: spec.english_only,
                    state,
                    source: "Hugging Face, ggerganov/whisper.cpp (official whisper.cpp models)"
                        .into(),
                }
            })
            .collect()
    }

    fn is_running(&self, id: &str) -> bool {
        self.running
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains_key(id)
    }

    /// Asks a running download to stop. Its partial file is kept for resuming.
    pub fn cancel(&self, id: &str) -> bool {
        match self
            .running
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(id)
        {
            Some(flag) => {
                flag.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }

    /// Cancels every active model transfer without holding the registry lock over I/O.
    /// Returns the number of transfers signalled.
    pub fn cancel_all(&self) -> usize {
        let running = self
            .running
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for flag in running.values() {
            flag.store(true, Ordering::SeqCst);
        }
        running.len()
    }

    /// Cancels all transfers and waits a bounded time for their download loops to settle.
    pub fn cancel_all_and_wait(&self, timeout: Duration) -> bool {
        self.cancel_all();
        let deadline = std::time::Instant::now() + timeout;
        let mut running = self
            .running
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        while !running.is_empty() {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return false;
            }
            let (next, result) = self
                .settled
                .wait_timeout(running, remaining)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            running = next;
            if result.timed_out() && !running.is_empty() {
                return false;
            }
        }
        true
    }

    /// Downloads a catalog model from its official source. `consent` must come from an explicit
    /// user action. Blocks until done; call from a background thread.
    pub fn download(
        &self,
        id: &str,
        consent: bool,
        progress: impl FnMut(u64, u64),
    ) -> Result<PathBuf, ModelError> {
        let spec = find(id).ok_or(ModelError::Unknown)?;
        self.download_from(id, &Source::official(spec), consent, progress)
    }

    /// As [`Self::download`] from an explicit source (tests).
    pub fn download_from(
        &self,
        id: &str,
        source: &Source,
        consent: bool,
        progress: impl FnMut(u64, u64),
    ) -> Result<PathBuf, ModelError> {
        if !consent {
            return Err(ModelError::ConsentRequired);
        }
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        {
            let mut running = self
                .running
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if running.contains_key(id) {
                return Err(ModelError::AlreadyDownloading);
            }
            running.insert(id.to_owned(), cancel.clone());
        }
        let _registration = DownloadRegistration {
            store: self,
            id: id.to_owned(),
        };
        self.fetch(source, &cancel, progress)
    }

    fn fetch(
        &self,
        source: &Source,
        cancel: &AtomicBool,
        mut progress: impl FnMut(u64, u64),
    ) -> Result<PathBuf, ModelError> {
        fs::create_dir_all(&self.dir).map_err(storage)?;
        let final_path = self.final_path(&source.file_name);
        match self.verified_source_path(source) {
            Ok(Some(path)) => return Ok(path),
            Ok(None) | Err(ModelError::ChecksumMismatch) => {}
            Err(error) => return Err(error),
        }
        let partial = self.partial_path(&source.file_name);

        // Resume: hash what is already on disk, then ask for the rest.
        let mut hasher = Sha256::new();
        let mut have = match fs::metadata(&partial) {
            Ok(m) if m.len() <= source.size_bytes => m.len(),
            Ok(_) => {
                fs::remove_file(&partial).map_err(storage)?;
                0
            }
            Err(_) => 0,
        };
        if have > 0 {
            let mut file = File::open(&partial).map_err(storage)?;
            let mut buf = vec![0u8; 1 << 16];
            loop {
                let n = file.read(&mut buf).map_err(storage)?;
                if n == 0 {
                    break;
                }
                hasher.update(&buf[..n]);
            }
        }

        if have < source.size_bytes {
            let agent: ureq::Agent = ureq::Agent::config_builder()
                .timeout_connect(Some(Duration::from_secs(20)))
                .timeout_recv_response(Some(Duration::from_secs(30)))
                .user_agent("KalCode")
                .build()
                .into();
            let mut request = agent.get(&source.url);
            if have > 0 {
                request = request.header("Range", &format!("bytes={have}-"));
            }
            let response = match request.call() {
                Ok(r) => r,
                Err(ureq::Error::StatusCode(416)) => {
                    // Our partial file is not a prefix the server recognizes: start over.
                    fs::remove_file(&partial).map_err(storage)?;
                    return Err(ModelError::Network(
                        "the partial download was discarded".into(),
                    ));
                }
                Err(ureq::Error::StatusCode(code)) => {
                    return Err(ModelError::Server(code.to_string()));
                }
                Err(e) => return Err(ModelError::Network(e.to_string())),
            };
            let status = response.status().as_u16();
            let mut file = match status {
                206 if have > 0 => OpenOptions::new()
                    .append(true)
                    .open(&partial)
                    .map_err(storage)?,
                200 => {
                    // The server ignored the range: restart from the beginning.
                    have = 0;
                    hasher = Sha256::new();
                    File::create(&partial).map_err(storage)?
                }
                other => return Err(ModelError::Server(other.to_string())),
            };
            let remaining = source.size_bytes - have;
            let mut reader = response
                .into_body()
                .into_with_config()
                .limit(remaining.saturating_add(1))
                .reader();
            let mut buf = vec![0u8; 1 << 16];
            loop {
                if cancel.load(Ordering::SeqCst) {
                    file.flush().map_err(storage)?;
                    return Err(ModelError::Cancelled);
                }
                let n = match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(e) => {
                        let _ = file.flush();
                        return Err(ModelError::Network(e.kind().to_string()));
                    }
                };
                if have + n as u64 > source.size_bytes {
                    drop(file);
                    let _ = fs::remove_file(&partial);
                    return Err(ModelError::Server(
                        "more data than the published size".into(),
                    ));
                }
                file.write_all(&buf[..n]).map_err(storage)?;
                hasher.update(&buf[..n]);
                have += n as u64;
                progress(have, source.size_bytes);
            }
            file.sync_all().map_err(storage)?;
        }

        if have != source.size_bytes {
            return Err(ModelError::Network("the download ended early".into()));
        }
        let digest: String = hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        if !digest.eq_ignore_ascii_case(&source.sha256) {
            let _ = fs::remove_file(&partial);
            return Err(ModelError::ChecksumMismatch);
        }
        if final_path.exists() {
            fs::remove_file(&final_path).map_err(storage)?;
        }
        fs::rename(&partial, &final_path).map_err(storage)?;
        tracing::info!(event = "kalvoice.model_installed", file = %source.file_name);
        Ok(final_path)
    }

    /// Removes an installed model and any partial download.
    pub fn delete(&self, id: &str) -> Result<(), ModelError> {
        let spec = find(id).ok_or(ModelError::Unknown)?;
        if self.is_running(id) {
            return Err(ModelError::AlreadyDownloading);
        }
        for path in [
            self.final_path(spec.file_name),
            self.partial_path(spec.file_name),
        ] {
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(storage(e)),
            }
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "models_tests.rs"]
mod tests;
