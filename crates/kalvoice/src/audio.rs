//! Microphone capture into memory (docs/KALVOICE.md, "Dictation pipeline").
//!
//! Audio is captured from the default input device, mixed to mono, held only in memory with a
//! hard cap ([`MAX_RECORDING`]), resampled to 16 kHz for the speech model, and never written to
//! disk or sent anywhere. Callers zero and drop the samples after transcription.

use std::time::Duration;

/// Sample rate the speech model expects.
pub const TARGET_RATE: u32 = 16_000;

/// The longest single recording. Capture stops accepting audio after this.
pub const MAX_RECORDING: Duration = Duration::from_secs(120);

#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
pub enum CaptureError {
    #[error("No microphone was found. Connect one, then try again.")]
    NoDevice,
    #[error(
        "Microphone access is blocked. In system privacy settings, allow KalCode to use the microphone, then try again."
    )]
    PermissionDenied,
    #[error(
        "KalCode opened the system prompt for microphone access. Respond to it, then try push to talk again."
    )]
    PermissionPending,
    #[error("The microphone is being used by another app.")]
    Busy,
    #[error(
        "The microphone changed or its audio session was interrupted. Release push to talk, then try again."
    )]
    Interrupted,
    #[error("Microphone capture isn't supported on this platform in this build.")]
    Unsupported,
    #[error("The microphone stopped working. Try again.")]
    Failed(String),
}

impl CaptureError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NoDevice => "microphone_unavailable",
            Self::PermissionDenied => "microphone_denied",
            Self::PermissionPending => "microphone_permission_pending",
            Self::Busy => "microphone_busy",
            Self::Interrupted => "microphone_interrupted",
            Self::Unsupported => "microphone_unsupported",
            Self::Failed(_) => "microphone_failed",
        }
    }
}

/// The operating system's current microphone authorization state.
///
/// `Unknown` means this platform's capture backend does not expose a side-effect-free permission
/// query. Capture errors remain authoritative in that case.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MicrophonePermission {
    Granted,
    Denied,
    NotDetermined,
    Unknown,
    Unsupported,
}

/// Returns the current microphone authorization state without opening the microphone or prompting.
pub fn microphone_permission() -> MicrophonePermission {
    #[cfg(target_os = "macos")]
    {
        microphone_permission::current()
    }
    #[cfg(windows)]
    {
        MicrophonePermission::Unknown
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        MicrophonePermission::Unsupported
    }
}

#[cfg(target_os = "macos")]
mod microphone_permission {
    // The objc2 binding exposes Apple's AVAudioApplication methods as unsafe FFI. These call
    // sites use the process-wide singleton, pass no pointers from untrusted input, and keep the
    // copied completion block alive according to the Objective-C API contract.
    #![allow(unsafe_code)]

    use std::sync::atomic::{AtomicBool, Ordering};

    use block2::RcBlock;
    use objc2_avf_audio::{AVAudioApplication, AVAudioApplicationRecordPermission};

    use super::{CaptureError, MicrophonePermission};

    static REQUEST_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

    pub(super) fn current() -> MicrophonePermission {
        // SAFETY: macOS 14+ (KalCode's deployment target) provides the process-wide singleton and
        // recordPermission is a read-only query with no caller-owned pointers.
        let app = unsafe { AVAudioApplication::sharedInstance() };
        // SAFETY: `app` is the retained framework singleton returned immediately above.
        match unsafe { app.recordPermission() } {
            AVAudioApplicationRecordPermission::Granted => MicrophonePermission::Granted,
            AVAudioApplicationRecordPermission::Denied => MicrophonePermission::Denied,
            AVAudioApplicationRecordPermission::Undetermined => MicrophonePermission::NotDetermined,
            _ => MicrophonePermission::Unknown,
        }
    }

    pub(super) fn authorize_for_capture() -> Result<(), CaptureError> {
        match current() {
            MicrophonePermission::Granted => Ok(()),
            MicrophonePermission::Denied => Err(CaptureError::PermissionDenied),
            MicrophonePermission::NotDetermined => {
                if !REQUEST_IN_FLIGHT.swap(true, Ordering::SeqCst) {
                    let response = RcBlock::new(|_granted| {
                        REQUEST_IN_FLIGHT.store(false, Ordering::SeqCst);
                    });
                    // SAFETY: the block has the exact signature required by AVFAudio. Apple's
                    // asynchronous API copies it before this call returns.
                    unsafe {
                        AVAudioApplication::requestRecordPermissionWithCompletionHandler(&response)
                    };
                }
                Err(CaptureError::PermissionPending)
            }
            // A future authorization state must not silently open a protected input device.
            MicrophonePermission::Unknown => Err(CaptureError::PermissionDenied),
            MicrophonePermission::Unsupported => Err(CaptureError::Unsupported),
        }
    }
}

/// Something that can record audio (the microphone, or a test double).
pub trait AudioSource: Send + Sync {
    /// Starts recording immediately.
    fn start(&self, max: Duration) -> Result<Box<dyn ActiveCapture>, CaptureError>;
}

/// A recording in progress.
pub trait ActiveCapture: Send {
    /// Stops recording and returns mono samples at [`TARGET_RATE`].
    fn finish(self: Box<Self>) -> Result<Vec<f32>, CaptureError>;
    /// Stops recording and discards the audio.
    fn cancel(self: Box<Self>);
    /// Loudness of the most recent audio, 0.0–1.0 (for the listening waveform). Only this
    /// number leaves the capture; the audio itself stays in memory.
    fn level(&self) -> f32 {
        0.0
    }
    /// The audio so far, mono at [`TARGET_RATE`], for streaming recognition while the key is
    /// held. A copy that stays in memory.
    fn snapshot(&self) -> Vec<f32> {
        Vec::new()
    }
}

/// Maps an RMS amplitude to a 0–1 display level (speech sits around 0.3–0.8).
pub fn display_level(rms: f32) -> f32 {
    if !rms.is_finite() || rms <= 0.0 {
        return 0.0;
    }
    (rms * 6.0).sqrt().min(1.0)
}

/// Resamples mono audio to 16 kHz. Downsampling low-passes first (windowed sinc) so speech
/// above 8 kHz does not alias into the band the model hears.
pub fn resample_to_16k(input: &[f32], rate: u32) -> Vec<f32> {
    if rate == TARGET_RATE || input.is_empty() || rate == 0 {
        return input.to_vec();
    }
    let step = f64::from(rate) / f64::from(TARGET_RATE);
    let out_len = ((input.len() as f64) / step).floor() as usize;
    let filter = (rate > TARGET_RATE).then(|| lowpass_taps(0.45 / step));
    let sample_at = |i: usize| -> f32 {
        match &filter {
            None => input[i],
            Some(taps) => {
                let half = taps.len() / 2;
                let mut acc = 0.0f32;
                for (k, tap) in taps.iter().enumerate() {
                    let j = i + k;
                    if j >= half && j - half < input.len() {
                        acc += tap * input[j - half];
                    }
                }
                acc
            }
        }
    };
    let mut out = Vec::with_capacity(out_len);
    for n in 0..out_len {
        let pos = n as f64 * step;
        let i = pos.floor() as usize;
        let frac = (pos - i as f64) as f32;
        let a = sample_at(i);
        let value = if frac > 1e-6 && i + 1 < input.len() {
            a + (sample_at(i + 1) - a) * frac
        } else {
            a
        };
        out.push(value);
    }
    out
}

/// Hann-windowed sinc low-pass; `cutoff` in cycles per input sample (0..0.5).
fn lowpass_taps(cutoff: f64) -> Vec<f32> {
    const TAPS: usize = 63;
    let m = (TAPS - 1) as f64;
    let mut taps: Vec<f64> = (0..TAPS)
        .map(|n| {
            let x = n as f64 - m / 2.0;
            let sinc = if x.abs() < 1e-9 {
                2.0 * cutoff
            } else {
                (2.0 * std::f64::consts::PI * cutoff * x).sin() / (std::f64::consts::PI * x)
            };
            let window = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * n as f64 / m).cos();
            sinc * window
        })
        .collect();
    let sum: f64 = taps.iter().sum();
    for t in &mut taps {
        *t /= sum;
    }
    taps.into_iter().map(|t| t as f32).collect()
}

/// The system default microphone (Windows and macOS).
#[derive(Debug, Default, Clone, Copy)]
pub struct MicrophoneSource;

#[cfg(any(windows, target_os = "macos"))]
mod mic {
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex, PoisonError};
    use std::thread::JoinHandle;
    use std::time::Duration;

    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    use super::{ActiveCapture, AudioSource, CaptureError, MicrophoneSource, resample_to_16k};

    #[derive(Default)]
    struct Shared {
        samples: Mutex<Vec<f32>>,
        /// RMS of the latest callback buffer, as `f32` bits.
        level: AtomicU32,
        rate: AtomicU32,
        full: AtomicBool,
        interrupted: AtomicBool,
        error: Mutex<Option<CaptureError>>,
    }

    impl Shared {
        fn fail(&self, error: CaptureError) {
            self.interrupted.store(true, Ordering::SeqCst);
            self.level.store(0.0f32.to_bits(), Ordering::Relaxed);
            let mut samples = self.samples.lock().unwrap_or_else(PoisonError::into_inner);
            samples.fill(0.0);
            samples.clear();
            let mut slot = self.error.lock().unwrap_or_else(PoisonError::into_inner);
            slot.get_or_insert(error);
        }
    }

    fn map_error(error: &cpal::Error) -> CaptureError {
        match error.kind() {
            cpal::ErrorKind::PermissionDenied => CaptureError::PermissionDenied,
            cpal::ErrorKind::DeviceBusy => CaptureError::Busy,
            cpal::ErrorKind::DeviceNotAvailable | cpal::ErrorKind::HostUnavailable => {
                CaptureError::NoDevice
            }
            cpal::ErrorKind::DeviceChanged | cpal::ErrorKind::StreamInvalidated => {
                CaptureError::Interrupted
            }
            _ => CaptureError::Failed(error.to_string()),
        }
    }

    /// CPAL reports xruns and refused real-time priority while a stream remains usable. Every
    /// other runtime error invalidates this utterance so audio from two devices or across a
    /// sleep/wake interruption is never combined into one command.
    pub(super) fn stream_error(error: &cpal::Error) -> Option<CaptureError> {
        match error.kind() {
            cpal::ErrorKind::Xrun | cpal::ErrorKind::RealtimeDenied => None,
            _ => Some(map_error(error)),
        }
    }

    fn push_frames<T: Copy>(
        shared: &Shared,
        data: &[T],
        channels: usize,
        max: usize,
        to_f32: fn(T) -> f32,
    ) {
        if shared.full.load(Ordering::Relaxed) || shared.interrupted.load(Ordering::SeqCst) {
            return;
        }
        let mut samples = shared
            .samples
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let mut energy = 0.0f32;
        let mut frames = 0usize;
        for frame in data.chunks(channels.max(1)) {
            if samples.len() >= max {
                shared.full.store(true, Ordering::Relaxed);
                break;
            }
            let sum: f32 = frame.iter().map(|s| to_f32(*s)).sum();
            let mono = sum / frame.len() as f32;
            energy += mono * mono;
            frames += 1;
            samples.push(mono);
        }
        if frames > 0 {
            let rms = (energy / frames as f32).sqrt();
            shared.level.store(rms.to_bits(), Ordering::Relaxed);
        }
    }

    fn open(shared: &Arc<Shared>, max: Duration) -> Result<cpal::Stream, CaptureError> {
        let host = cpal::default_host();
        let device = host.default_input_device().ok_or(CaptureError::NoDevice)?;
        let supported = device.default_input_config().map_err(|e| map_error(&e))?;
        let config = supported.config();
        let rate = config.sample_rate;
        let channels = usize::from(config.channels);
        shared.rate.store(rate, Ordering::SeqCst);
        let max_samples = usize::try_from(u64::from(rate) * max.as_secs()).unwrap_or(usize::MAX);
        {
            let mut samples = shared
                .samples
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            samples.reserve(usize::try_from(rate).unwrap_or(0) * 10);
        }
        let on_error = {
            let shared = shared.clone();
            move |e: cpal::Error| {
                if let Some(error) = stream_error(&e) {
                    shared.fail(error);
                }
            }
        };
        macro_rules! build {
            ($t:ty, $convert:expr) => {{
                let shared = shared.clone();
                device.build_input_stream::<$t, _, _>(
                    config,
                    move |data: &[$t], _| {
                        push_frames(&shared, data, channels, max_samples, $convert)
                    },
                    on_error,
                    Some(Duration::from_secs(5)),
                )
            }};
        }
        let stream = match supported.sample_format() {
            cpal::SampleFormat::F32 => build!(f32, |s: f32| s),
            cpal::SampleFormat::I16 => build!(i16, |s: i16| f32::from(s) / 32_768.0),
            cpal::SampleFormat::U16 => build!(u16, |s: u16| (f32::from(s) - 32_768.0) / 32_768.0),
            cpal::SampleFormat::I32 => {
                build!(i32, |s: i32| (f64::from(s) / 2_147_483_648.0) as f32)
            }
            other => {
                return Err(CaptureError::Failed(format!(
                    "unsupported sample format {other:?}"
                )));
            }
        }
        .map_err(|e| map_error(&e))?;
        stream.play().map_err(|e| map_error(&e))?;
        Ok(stream)
    }

    struct MicCapture {
        shared: Arc<Shared>,
        stop: Option<mpsc::Sender<()>>,
        thread: Option<JoinHandle<()>>,
    }

    impl MicCapture {
        fn stop_thread(&mut self) {
            drop(self.stop.take());
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    impl Drop for MicCapture {
        fn drop(&mut self) {
            self.stop_thread();
            // Never leave audio behind in memory.
            let mut samples = self
                .shared
                .samples
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            samples.fill(0.0);
            samples.clear();
        }
    }

    impl ActiveCapture for MicCapture {
        fn finish(mut self: Box<Self>) -> Result<Vec<f32>, CaptureError> {
            self.stop_thread();
            if let Some(error) = self
                .shared
                .error
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .take()
            {
                return Err(error);
            }
            let rate = self.shared.rate.load(Ordering::SeqCst);
            let mut raw = std::mem::take(
                &mut *self
                    .shared
                    .samples
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner),
            );
            let out = resample_to_16k(&raw, rate);
            raw.fill(0.0);
            Ok(out)
        }

        fn cancel(mut self: Box<Self>) {
            self.stop_thread();
        }

        fn level(&self) -> f32 {
            super::display_level(f32::from_bits(self.shared.level.load(Ordering::Relaxed)))
        }

        fn snapshot(&self) -> Vec<f32> {
            let rate = self.shared.rate.load(Ordering::SeqCst);
            let raw = self
                .shared
                .samples
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone();
            let mut raw = raw;
            let out = resample_to_16k(&raw, rate);
            raw.fill(0.0);
            out
        }
    }

    impl AudioSource for MicrophoneSource {
        fn start(&self, max: Duration) -> Result<Box<dyn ActiveCapture>, CaptureError> {
            #[cfg(target_os = "macos")]
            super::microphone_permission::authorize_for_capture()?;

            let shared = Arc::new(Shared::default());
            let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<(), CaptureError>>(1);
            let (stop_tx, stop_rx) = mpsc::channel::<()>();
            let thread_shared = shared.clone();
            // cpal streams are not `Send` on every platform, so the stream lives on its own
            // thread until it is told to stop.
            let thread = std::thread::Builder::new()
                .name("kalvoice-capture".into())
                .spawn(move || match open(&thread_shared, max) {
                    Ok(stream) => {
                        let _ = ready_tx.send(Ok(()));
                        let _ = stop_rx.recv();
                        drop(stream);
                    }
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                    }
                })
                .map_err(|e| CaptureError::Failed(e.to_string()))?;
            let mut capture = MicCapture {
                shared,
                stop: Some(stop_tx),
                thread: Some(thread),
            };
            match ready_rx.recv_timeout(Duration::from_secs(8)) {
                Ok(Ok(())) => Ok(Box::new(capture)),
                Ok(Err(e)) => {
                    capture.stop_thread();
                    Err(e)
                }
                Err(_) => Err(CaptureError::Failed("the microphone did not start".into())),
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn fatal_stream_error_wipes_audio_and_rejects_later_frames() {
            let shared = Shared::default();
            push_frames(&shared, &[0.25f32, -0.5], 1, 8, |sample| sample);
            assert_eq!(
                shared
                    .samples
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .len(),
                2
            );

            shared.fail(CaptureError::Interrupted);
            push_frames(&shared, &[0.75f32], 1, 8, |sample| sample);

            assert!(shared.interrupted.load(Ordering::SeqCst));
            assert_eq!(shared.level.load(Ordering::Relaxed), 0.0f32.to_bits());
            assert!(
                shared
                    .samples
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .is_empty()
            );
            assert_eq!(
                shared
                    .error
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .as_ref(),
                Some(&CaptureError::Interrupted)
            );
        }
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
impl AudioSource for MicrophoneSource {
    fn start(&self, _max: Duration) -> Result<Box<dyn ActiveCapture>, CaptureError> {
        Err(CaptureError::Unsupported)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f32, rate: u32, seconds: f32) -> Vec<f32> {
        let n = (rate as f32 * seconds) as usize;
        (0..n)
            .map(|i| (2.0 * std::f32::consts::PI * freq * i as f32 / rate as f32).sin() * 0.5)
            .collect()
    }

    fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|s| s * s).sum::<f32>() / x.len().max(1) as f32).sqrt()
    }

    fn zero_crossing_freq(x: &[f32], rate: u32) -> f32 {
        let crossings = x.windows(2).filter(|w| w[0] < 0.0 && w[1] >= 0.0).count();
        crossings as f32 * rate as f32 / x.len() as f32
    }

    #[test]
    fn identity_at_16k() {
        let x = sine(440.0, 16_000, 0.1);
        assert_eq!(resample_to_16k(&x, 16_000), x);
        assert!(resample_to_16k(&[], 48_000).is_empty());
    }

    #[test]
    fn common_rates_keep_duration_and_pitch() {
        for rate in [48_000, 44_100, 32_000, 22_050, 8_000] {
            let x = sine(1_000.0, rate, 1.0);
            let y = resample_to_16k(&x, rate);
            assert!((y.len() as i64 - 16_000).abs() <= 2, "{rate}: {}", y.len());
            let f = zero_crossing_freq(&y[200..y.len() - 200], TARGET_RATE);
            assert!((f - 1_000.0).abs() < 15.0, "{rate}: {f}");
            assert!(
                (rms(&y[200..y.len() - 200]) - rms(&x)).abs() < 0.03,
                "{rate}"
            );
        }
    }

    #[test]
    fn frequencies_above_the_new_nyquist_are_removed() {
        let x = sine(12_000.0, 48_000, 0.5);
        let y = resample_to_16k(&x, 48_000);
        assert!(rms(&y[100..y.len() - 100]) < 0.02, "aliasing: {}", rms(&y));
    }

    #[test]
    fn display_level_is_bounded() {
        assert_eq!(display_level(0.0), 0.0);
        assert_eq!(display_level(f32::NAN), 0.0);
        assert!(display_level(0.05) > 0.4 && display_level(0.05) < 0.7);
        assert_eq!(display_level(10.0), 1.0);
    }

    #[test]
    fn capture_errors_have_stable_codes() {
        assert_eq!(CaptureError::PermissionDenied.code(), "microphone_denied");
        assert_eq!(
            CaptureError::PermissionPending.code(),
            "microphone_permission_pending"
        );
        assert_eq!(CaptureError::Interrupted.code(), "microphone_interrupted");
        assert_eq!(CaptureError::NoDevice.code(), "microphone_unavailable");
        assert!(
            CaptureError::PermissionDenied
                .to_string()
                .contains("privacy settings")
        );
        assert!(
            CaptureError::PermissionPending
                .to_string()
                .contains("system prompt")
        );
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn runtime_route_changes_and_invalidations_abort_capture() {
        for kind in [
            cpal::ErrorKind::DeviceChanged,
            cpal::ErrorKind::StreamInvalidated,
        ] {
            assert_eq!(
                mic::stream_error(&cpal::Error::new(kind)),
                Some(CaptureError::Interrupted)
            );
        }
        assert_eq!(
            mic::stream_error(&cpal::Error::new(cpal::ErrorKind::DeviceNotAvailable)),
            Some(CaptureError::NoDevice)
        );
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn recoverable_audio_quality_warnings_keep_capture_alive() {
        assert_eq!(
            mic::stream_error(&cpal::Error::new(cpal::ErrorKind::Xrun)),
            None
        );
        assert_eq!(
            mic::stream_error(&cpal::Error::new(cpal::ErrorKind::RealtimeDenied)),
            None
        );
    }
}
