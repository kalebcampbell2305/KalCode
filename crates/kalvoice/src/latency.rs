//! KalVoice latency instrumentation: five stages, monotonic timings, rolling percentiles.
//!
//! 1. key down → microphone active      3. key up → final transcript
//! 2. speech → first partial            4. final transcript → command recognized
//! 5. command → visible action (measured by the UI and reported back)

use std::collections::VecDeque;
use std::sync::{Mutex, PoisonError};

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
}

impl LatencyStage {
    pub const ALL: [Self; 5] = [
        Self::KeyDownToMic,
        Self::SpeechToPartial,
        Self::KeyUpToFinal,
        Self::FinalToRecognized,
        Self::RecognizedToAction,
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
}

impl StageTimings {
    fn get(&self, stage: LatencyStage) -> Option<f64> {
        match stage {
            LatencyStage::KeyDownToMic => self.key_down_to_mic,
            LatencyStage::SpeechToPartial => self.speech_to_partial,
            LatencyStage::KeyUpToFinal => self.key_up_to_final,
            LatencyStage::FinalToRecognized => self.final_to_recognized,
            LatencyStage::RecognizedToAction => self.recognized_to_action,
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
}
