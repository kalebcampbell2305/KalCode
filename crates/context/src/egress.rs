//! Owner-confirmed admission for user prompts that contain secret-shaped values.
//!
//! A review is deliberately process-local and opaque. The public warning contains only a
//! random identifier and detector counts; the exact prompt and target remain inside the gate.
//! Confirmations are short-lived, one-shot, and consumed even when an object-substitution
//! attempt fails.

use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::Firewall;
pub use kalcode_contracts::context::{PromptReview, PromptWarning};
use kalcode_core::{ErrorCategory, KalError};

const DEFAULT_MAX_PENDING: usize = 64;
const DEFAULT_REVIEW_TTL: Duration = Duration::from_secs(10 * 60);

/// The complete provider destination to which an owner confirmation is bound.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptTarget {
    pub workspace_id: String,
    pub thread_id: Option<String>,
    pub provider_id: String,
    pub provider_account_id: Option<String>,
}

/// Opaque proof that one exact prompt and provider destination passed admission.
///
/// It is deliberately neither cloneable nor printable and is consumed when the effect boundary
/// revalidates it. Callers cannot construct one.
pub struct PromptAdmission {
    gate_id: uuid::Uuid,
    target: PromptTarget,
    prompt: String,
}

/// A stable, content-free prompt admission failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptGateError {
    ConfirmationRequired,
    ConfirmationInvalid,
    ReviewCapacity,
    Unavailable,
}

impl PromptGateError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::ConfirmationRequired => "context_prompt_confirmation_required",
            Self::ConfirmationInvalid => "context_prompt_confirmation_invalid",
            Self::ReviewCapacity => "context_prompt_review_capacity",
            Self::Unavailable => "context_prompt_gate_unavailable",
        }
    }
}

impl fmt::Display for PromptGateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for PromptGateError {}

impl From<PromptGateError> for KalError {
    fn from(error: PromptGateError) -> Self {
        let (category, message) = match error {
            PromptGateError::ConfirmationRequired => (
                ErrorCategory::Permission,
                "This prompt may contain a secret. Review the warning and confirm this exact prompt before sending.",
            ),
            PromptGateError::ConfirmationInvalid => (
                ErrorCategory::Permission,
                "That prompt confirmation is expired, already used, or belongs to different content or a different destination.",
            ),
            PromptGateError::ReviewCapacity => (
                ErrorCategory::Validation,
                "Too many prompt reviews are waiting. Finish or let an earlier review expire, then try again.",
            ),
            PromptGateError::Unavailable => (
                ErrorCategory::Internal,
                "KalCode couldn't verify prompt confirmation state. Nothing was sent.",
            ),
        };
        KalError::new(category, error.code(), message).with_source(error)
    }
}

struct SealedReview {
    target: PromptTarget,
    prompt: String,
    created_at: Instant,
}

#[derive(Default)]
struct GateState {
    pending: HashMap<String, SealedReview>,
    order: VecDeque<String>,
}

/// Bounded, process-local authority for confirming secret-shaped user prompts.
///
/// This type intentionally has no `Debug` implementation: its private state temporarily holds
/// the exact user prompt so the confirmation can be bound without persisting a fingerprint.
pub struct PromptGate {
    gate_id: uuid::Uuid,
    max_pending: usize,
    ttl: Duration,
    state: Mutex<GateState>,
}

impl Default for PromptGate {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_PENDING, DEFAULT_REVIEW_TTL)
    }
}

impl PromptGate {
    pub fn new(max_pending: usize, ttl: Duration) -> Self {
        Self {
            gate_id: uuid::Uuid::now_v7(),
            max_pending,
            ttl,
            state: Mutex::new(GateState::default()),
        }
    }

    /// Inspects a prompt. Clean prompts create no state. A warning stores an exact, bounded,
    /// short-lived binding and returns only an opaque identifier plus detector counts.
    pub fn review(
        &self,
        firewall: &Firewall,
        target: PromptTarget,
        prompt: &str,
    ) -> Result<PromptReview, PromptGateError> {
        let check = firewall.check_user_prompt(prompt);
        if !check.warn {
            return Ok(PromptReview::Clean);
        }

        let mut state = self.lock()?;
        self.purge_expired(&mut state, Instant::now());
        if self.max_pending == 0 || state.pending.len() >= self.max_pending {
            return Err(PromptGateError::ReviewCapacity);
        }

        let review_id = loop {
            let candidate = uuid::Uuid::now_v7().to_string();
            if !state.pending.contains_key(&candidate) {
                break candidate;
            }
        };
        state.pending.insert(
            review_id.clone(),
            SealedReview {
                target,
                prompt: prompt.to_owned(),
                created_at: Instant::now(),
            },
        );
        state.order.push_back(review_id.clone());

        Ok(PromptReview::ConfirmationRequired(PromptWarning {
            review_id,
            detectors: check.detectors,
        }))
    }

    /// Cancels one pending review without revealing whether it belonged to this gate.
    ///
    /// The identifier is opaque and cancellation is deliberately idempotent: unknown, expired,
    /// already-consumed, and already-cancelled identifiers are harmless. Removing the review
    /// before returning ensures it can never be used to admit a prompt afterwards.
    pub fn cancel(&self, review_id: &str) -> Result<bool, PromptGateError> {
        let mut state = self.lock()?;
        self.purge_expired(&mut state, Instant::now());
        let removed = state.pending.remove(review_id).is_some();
        if removed {
            state.order.retain(|id| id != review_id);
        }
        Ok(removed)
    }

    /// Admits a clean prompt or consumes an exact owner confirmation.
    ///
    /// Any supplied identifier is removed before validation, so a failed target or prompt swap
    /// cannot probe and then replay the original confirmation.
    pub fn admit(
        &self,
        firewall: &Firewall,
        target: &PromptTarget,
        prompt: &str,
        review_id: Option<&str>,
    ) -> Result<PromptAdmission, PromptGateError> {
        let check = firewall.check_user_prompt(prompt);
        let Some(review_id) = review_id else {
            return if check.warn {
                Err(PromptGateError::ConfirmationRequired)
            } else {
                Ok(PromptAdmission {
                    gate_id: self.gate_id,
                    target: target.clone(),
                    prompt: prompt.to_owned(),
                })
            };
        };

        let now = Instant::now();
        let sealed = {
            let mut state = self.lock()?;
            self.purge_expired(&mut state, now);
            let sealed = state.pending.remove(review_id);
            state.order.retain(|id| id != review_id);
            sealed
        }
        .ok_or(PromptGateError::ConfirmationInvalid)?;

        if !check.warn
            || now.duration_since(sealed.created_at) >= self.ttl
            || sealed.target != *target
            || sealed.prompt != prompt
        {
            return Err(PromptGateError::ConfirmationInvalid);
        }
        Ok(PromptAdmission {
            gate_id: self.gate_id,
            target: target.clone(),
            prompt: prompt.to_owned(),
        })
    }

    /// Consumes a proof at the provider boundary. Proofs from another runtime instance are
    /// invalid even when all public target fields happen to match.
    pub fn verify(
        &self,
        admission: PromptAdmission,
        target: &PromptTarget,
        prompt: &str,
    ) -> Result<(), PromptGateError> {
        if admission.gate_id == self.gate_id
            && admission.target == *target
            && admission.prompt == prompt
        {
            Ok(())
        } else {
            Err(PromptGateError::ConfirmationInvalid)
        }
    }

    /// Number of unexpired pending reviews. Exposed for bounded-state diagnostics and tests.
    pub fn pending(&self) -> usize {
        let Ok(mut state) = self.state.lock() else {
            return 0;
        };
        self.purge_expired(&mut state, Instant::now());
        state.pending.len()
    }

    fn lock(&self) -> Result<MutexGuard<'_, GateState>, PromptGateError> {
        self.state.lock().map_err(|_| PromptGateError::Unavailable)
    }

    fn purge_expired(&self, state: &mut GateState, now: Instant) {
        while let Some(review_id) = state.order.front() {
            let expired = state
                .pending
                .get(review_id)
                .is_none_or(|review| now.duration_since(review.created_at) >= self.ttl);
            if !expired {
                break;
            }
            if let Some(review_id) = state.order.pop_front() {
                state.pending.remove(&review_id);
            }
        }
    }
}
