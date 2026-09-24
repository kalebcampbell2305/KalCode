//! KalVoice Request allowances on the desktop.
//!
//! The API's usage ledger is authoritative. Online, the desktop asks the API before each
//! top-level KalVoice request (`POST /v1/kalvoice/requests`) and gets back a signed usage receipt.
//! Offline, [`EffectiveEntitlement::kalvoice_decision`] decides from the last verified receipt
//! plus the requests served since then; those are reported later as offline replays, which the
//! ledger always records (idempotently, by client request id). See docs/BILLING.md §7.
//!
//! The unit is a KalVoice Request — one per top-level request, however many internal steps.
//! Dictation and provider model tokens are never counted.

use serde::{Deserialize, Serialize};

use crate::document::{Limit, Tier, is_valid_key_id, limits};
use crate::effective::{EffectiveEntitlement, EntitlementStatus};

pub const USAGE_RECEIPT_VERSION: u32 = 1;
/// Verifiers reject receipts claiming a longer validity than this.
pub const USAGE_RECEIPT_MAX_LIFETIME_SECONDS: i64 = 7 * 24 * 60 * 60;

const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// A verified usage receipt. Field names match the `KalVoiceUsage` contract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReceipt {
    pub version: u32,
    pub account_id: String,
    pub tier: Tier,
    /// Requests counted in the cycle when the receipt was issued.
    pub used: u64,
    /// Requests allowed per cycle; `None` = unlimited (always for OWNER).
    pub allowance: Option<u64>,
    /// ISO-8601 UTC with milliseconds.
    pub period_start: String,
    /// ISO-8601 UTC with milliseconds; the next cycle starts here.
    pub resets_at: String,
    pub issued_at: i64,
    pub expires_at: i64,
    pub key_id: String,
}

impl UsageReceipt {
    /// Identical to `parseUsageReceipt` in the protocol package.
    pub(crate) fn validate(&self) -> bool {
        let length = self.account_id.encode_utf16().count();
        let time_ok = |value: i64| u64::try_from(value).is_ok_and(|v| v <= MAX_SAFE_INTEGER);
        self.version == USAGE_RECEIPT_VERSION
            && length > 0
            && length <= 128
            && self.used <= MAX_SAFE_INTEGER
            && self.allowance.is_none_or(|a| a <= MAX_SAFE_INTEGER)
            && (self.tier != Tier::Owner || self.allowance.is_none())
            && is_iso_millis(&self.period_start)
            && is_iso_millis(&self.resets_at)
            && self.resets_at > self.period_start
            && time_ok(self.issued_at)
            && time_ok(self.expires_at)
            && self.expires_at > self.issued_at
            && self.expires_at - self.issued_at <= USAGE_RECEIPT_MAX_LIFETIME_SECONDS
            && is_valid_key_id(&self.key_id)
    }
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ` — the only timestamp form the API emits.
fn is_iso_millis(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 24
        && bytes.iter().enumerate().all(|(i, b)| match i {
            4 | 7 => *b == b'-',
            10 => *b == b'T',
            13 | 16 => *b == b':',
            19 => *b == b'.',
            23 => *b == b'Z',
            _ => b.is_ascii_digit(),
        })
}

/// Whether one more KalVoice Request may run on this device now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KalVoiceDecision {
    /// `remaining` after this request is allowed; `None` = unlimited.
    Allowed { remaining: Option<u64> },
    /// The cycle's allowance is used up. `resets_at` is known when a receipt was available.
    Denied { resets_at: Option<String> },
}

impl EffectiveEntitlement {
    /// Offline-capable allowance check.
    ///
    /// - Unrestricted (OWNER) and unlimited allowances are always allowed.
    /// - With a verified `receipt` for the signed-in account: allowed while
    ///   `receipt.used + unsynced` is below the smaller of the receipt's and the entitlement's
    ///   allowance, where `unsynced` counts requests served since the receipt was issued.
    /// - Without one (never synced, receipt expired, not signed in): `unsynced` is the device's
    ///   provisional count for the cycle, checked against the entitlement's allowance.
    ///
    /// Callers pass only receipts that [`crate::Verifier::verify_usage_receipt`] accepted.
    pub fn kalvoice_decision(
        &self,
        receipt: Option<&UsageReceipt>,
        unsynced: u64,
    ) -> KalVoiceDecision {
        let allowance = match self.limit(limits::KALVOICE_REQUESTS_PER_MONTH) {
            Limit::Unlimited => return KalVoiceDecision::Allowed { remaining: None },
            Limit::AtMost(n) => n,
        };
        let receipt = receipt.filter(|r| match &self.status {
            EntitlementStatus::Verified { account_id, .. } => *account_id == r.account_id,
            _ => false,
        });
        let used = receipt.map_or(unsynced, |r| r.used.saturating_add(unsynced));
        let allowance = receipt
            .and_then(|r| r.allowance)
            .map_or(allowance, |a| a.min(allowance));
        if used < allowance {
            KalVoiceDecision::Allowed {
                remaining: Some(allowance - used - 1),
            }
        } else {
            KalVoiceDecision::Denied {
                resets_at: receipt.map(|r| r.resets_at.clone()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_timestamps() {
        assert!(is_iso_millis("2026-09-24T12:00:00.000Z"));
        assert!(!is_iso_millis("2026-09-24T12:00:00Z"));
        assert!(!is_iso_millis("2026-09-24 12:00:00.000Z"));
        assert!(!is_iso_millis("2026-09-24T12:00:00.000+00"));
    }
}
