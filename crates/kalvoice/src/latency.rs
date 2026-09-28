//! KalVoice latency instrumentation: monotonic stage timings and rolling percentiles.
//!
//! 1. key down → microphone active      3. key up → final transcript
//! 2. speech → first partial            4. final transcript → command recognized
//! 5. command → visible action (measured by the UI and reported back)
//!
//! Finer stages split the two long ones: key up → audio finalized (inside 3), and route decided
//! → intent resolved → action started (inside 5). Every value is a duration; no stage ever
//! carries words.

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum LatencyStage {
    KeyDownToMic,
    SpeechToPartial,
    KeyUpToFinal,
    FinalToRecognized,
    RecognizedToAction,
    KeyUpToAudioFinal,
    RecognizedToIntent,
    IntentToAction,
}

impl LatencyStage {
    pub const ALL: [Self; 8] = [
        Self::KeyDownToMic,
        Self::SpeechToPartial,
        Self::KeyUpToFinal,
        Self::FinalToRecognized,
        Self::RecognizedToAction,
        Self::KeyUpToAudioFinal,
        Self::RecognizedToIntent,
        Self::IntentToAction,
    ];
}

/// One talk interaction's stage timings in milliseconds (absent stages didn't happen).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StageTimings {
    pub key_down_to_mic: Option<f64>,
    pub speech_to_partial: Option<f64>,
    pub key_up_to_final: Option<f64>,
    pub final_to_recognized: Option<f64>,
    pub recognized_to_action: Option<f64>,
    /// `reused_partial` when the final transcript needed no pass after release.
    pub final_source: Option<String>,
    /// Key up → recording stopped and finalized (the start of stage 3).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub key_up_to_audio_final: Option<f64>,
    /// Route decided → intent resolved: parsed and its target bound (inside stage 5).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub recognized_to_intent: Option<f64>,
    /// Intent resolved → the executor starts the action (inside stage 5).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub intent_to_action: Option<f64>,
}

impl StageTimings {
    fn get(&self, stage: LatencyStage) -> Option<f64> {
        match stage {
            LatencyStage::KeyDownToMic => self.key_down_to_mic,
            LatencyStage::SpeechToPartial => self.speech_to_partial,
            LatencyStage::KeyUpToFinal => self.key_up_to_final,
            LatencyStage::FinalToRecognized => self.final_to_recognized,
            LatencyStage::RecognizedToAction => self.recognized_to_action,
            LatencyStage::KeyUpToAudioFinal => self.key_up_to_audio_final,
            LatencyStage::RecognizedToIntent => self.recognized_to_intent,
            LatencyStage::IntentToAction => self.intent_to_action,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StagePercentiles {
    pub stage: LatencyStage,
    pub count: u32,
    pub p50: Option<f64>,
    pub p95: Option<f64>,
    pub p99: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LatencySnapshot {
    pub stages: Vec<StagePercentiles>,
    /// Most recent interactions, newest first (for the waterfall view).
    pub recent: Vec<StageTimings>,
}

/// Marks within one request for the stages the router and executor own. Each mark keeps the
/// first time it happened; reading it back gives durations only. Shareable across threads, so an
/// executor handed a reference can mark its own start.
#[derive(Debug)]
pub struct LatencyTrace {
    started: Instant,
    intent_resolved: OnceLock<Instant>,
    action_started: OnceLock<Instant>,
}

impl Default for LatencyTrace {
    fn default() -> Self {
        Self::new(Instant::now())
    }
}

impl LatencyTrace {
    pub fn new(started: Instant) -> Self {
        Self {
            started,
            intent_resolved: OnceLock::new(),
            action_started: OnceLock::new(),
        }
    }

    /// The intent is known and its target bound; nothing has run yet.
    pub fn intent_resolved(&self) {
        let _ = self.intent_resolved.set(Instant::now());
    }

    /// The executor is about to run the action.
    pub fn action_started(&self) {
        let _ = self.action_started.set(Instant::now());
    }

    /// Start of the trace → intent resolved, in milliseconds.
    pub fn intent_ms(&self) -> Option<f64> {
        self.intent_resolved
            .get()
            .map(|at| ms_between(self.started, *at))
    }

    /// Intent resolved → action started, in milliseconds.
    pub fn action_ms(&self) -> Option<f64> {
        match (self.intent_resolved.get(), self.action_started.get()) {
            (Some(intent), Some(action)) => Some(ms_between(*intent, *action)),
            _ => None,
        }
    }
}

fn ms_between(from: Instant, to: Instant) -> f64 {
    to.saturating_duration_since(from).as_secs_f64() * 1000.0
}

/// Nearest-rank percentile of `values` (unsorted).
pub fn percentile(values: &[f64], p: f64) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let rank = ((p / 100.0) * sorted.len() as f64).ceil() as usize;
    sorted.get(rank.clamp(1, sorted.len()) - 1).copied()
}

/// Keeps the last `capacity` interactions.
pub struct LatencyLog {
    capacity: usize,
    entries: Mutex<VecDeque<StageTimings>>,
}

impl LatencyLog {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            entries: Mutex::new(VecDeque::new()),
        }
    }

    pub fn record(&self, timings: StageTimings) {
        let mut entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        entries.push_front(timings);
        entries.truncate(self.capacity);
    }

    /// Adds the routing time (final transcript → recognized) to the newest interaction.
    pub fn record_recognized(&self, ms: f64) {
        let mut entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(latest) = entries.front_mut()
            && latest.final_to_recognized.is_none()
        {
            latest.final_to_recognized = Some(ms);
        }
    }

    /// Adds the backend's split of stage 5 (route → intent → action start) to the newest
    /// interaction. Absent values (dictation, a rejected or clarified request) stay absent.
    pub fn record_resolution(&self, intent_ms: Option<f64>, action_ms: Option<f64>) {
        let mut entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(latest) = entries.front_mut() {
            if latest.recognized_to_intent.is_none() {
                latest.recognized_to_intent = intent_ms;
            }
            if latest.intent_to_action.is_none() {
                latest.intent_to_action = action_ms;
            }
        }
    }

    /// Adds the UI-measured last stage to the newest interaction.
    pub fn record_action(&self, ms: f64) {
        let mut entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(latest) = entries.front_mut()
            && latest.recognized_to_action.is_none()
        {
            latest.recognized_to_action = Some(ms);
        }
    }

    pub fn snapshot(&self) -> LatencySnapshot {
        let entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        let stages = LatencyStage::ALL
            .iter()
            .map(|&stage| {
                let values: Vec<f64> = entries.iter().filter_map(|t| t.get(stage)).collect();
                StagePercentiles {
                    stage,
                    count: u32::try_from(values.len()).unwrap_or(u32::MAX),
                    p50: percentile(&values, 50.0),
                    p95: percentile(&values, 95.0),
                    p99: percentile(&values, 99.0),
                }
            })
            .collect();
        LatencySnapshot {
            stages,
            recent: entries.iter().take(20).cloned().collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nearest_rank_percentiles() {
        let v: Vec<f64> = (1..=100).map(f64::from).collect();
        assert_eq!(percentile(&v, 50.0), Some(50.0));
        assert_eq!(percentile(&v, 95.0), Some(95.0));
        assert_eq!(percentile(&v, 99.0), Some(99.0));
        assert_eq!(percentile(&[7.0], 99.0), Some(7.0));
        assert_eq!(percentile(&[], 50.0), None);
    }

    #[test]
    fn log_is_bounded_and_takes_the_ui_stage() {
        let log = LatencyLog::new(3);
        for ms in [10.0, 20.0, 30.0, 40.0] {
            log.record(StageTimings {
                key_down_to_mic: Some(ms),
                ..Default::default()
            });
        }
        log.record_action(55.0);
        log.record_action(99.0);
        let snap = log.snapshot();
        assert_eq!(snap.recent.len(), 3);
        assert_eq!(snap.recent[0].recognized_to_action, Some(55.0));
        let mic = &snap.stages[0];
        assert_eq!(mic.count, 3);
        assert_eq!(mic.p50, Some(30.0));
        assert_eq!(snap.stages[4].count, 1);
    }

    #[test]
    fn finer_stages_aggregate_and_stay_optional_on_the_wire() {
        let log = LatencyLog::new(10);
        for ms in [1.0, 2.0, 3.0] {
            log.record(StageTimings {
                key_up_to_audio_final: Some(ms),
                ..Default::default()
            });
            log.record_resolution(Some(ms * 10.0), None);
            log.record_resolution(Some(99.0), Some(ms));
        }
        let snap = log.snapshot();
        let stage = |s: LatencyStage| {
            snap.stages
                .iter()
                .find(|p| p.stage == s)
                .cloned()
                .expect("stage")
        };
        assert_eq!(stage(LatencyStage::KeyUpToAudioFinal).p50, Some(2.0));
        assert_eq!(stage(LatencyStage::RecognizedToIntent).p99, Some(30.0));
        assert_eq!(stage(LatencyStage::IntentToAction).count, 3);
        // Timings without the finer fields still decode, and absent fields aren't sent.
        let old: StageTimings = serde_json::from_str(
            r#"{"keyDownToMic":1,"speechToPartial":null,"keyUpToFinal":2,"finalToRecognized":null,"recognizedToAction":null,"finalSource":null}"#,
        )
        .expect("decode");
        assert_eq!(old.key_up_to_audio_final, None);
        let json = serde_json::to_string(&old).expect("encode");
        assert!(!json.contains("keyUpToAudioFinal"));
    }

    #[test]
    fn trace_marks_are_set_once_and_never_negative() {
        let trace = LatencyTrace::default();
        assert_eq!(trace.intent_ms(), None);
        assert_eq!(trace.action_ms(), None);
        trace.action_started();
        assert_eq!(trace.action_ms(), None, "no intent yet");
        trace.intent_resolved();
        let intent = trace.intent_ms().expect("intent");
        trace.intent_resolved();
        assert_eq!(trace.intent_ms(), Some(intent), "the first mark wins");
        // The action mark came first, so the split clamps to zero rather than going negative.
        assert_eq!(trace.action_ms(), Some(0.0));
    }
}
