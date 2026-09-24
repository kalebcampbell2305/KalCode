//! The entitlement document payload and the plan evaluator.
//!
//! Mirrors `packages/protocol/src/entitlements.ts`. The shared vectors in
//! `testdata/vectors.json` pin that both sides accept, reject and evaluate identically.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Current document format.
pub const DOCUMENT_VERSION: u32 = 1;
/// Documents claiming a longer validity than this are rejected, whatever the signature.
pub const MAX_DOCUMENT_LIFETIME_SECONDS: i64 = 14 * 24 * 60 * 60;
/// Tolerated clock difference when a document's `issuedAt` is slightly in the future.
pub const CLOCK_SKEW_SECONDS: i64 = 5 * 60;

/// Largest integer both JSON implementations represent exactly (JavaScript's safe integer).
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
const MAX_ID_LENGTH: usize = 128;
const MAX_ITEMS: usize = 256;

/// Every tier an account can hold. `Owner` is never sold: it is granted by trusted operators
/// only, never expires server-side, and is unrestricted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Free,
    Pro,
    Max,
    Owner,
}

/// A numeric limit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Limit {
    Unlimited,
    AtMost(u64),
}

/// What an entitlement grants, independent of account and time.
///
/// `unrestricted == true` grants every feature and unlimited limits **by construction** —
/// nothing is enumerated, so features added in future versions are covered automatically.
/// Otherwise only listed features are granted and unlisted limits are `AtMost(0)` (fail closed).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Grants {
    pub unrestricted: bool,
    pub features: Vec<String>,
    pub limits: BTreeMap<String, Option<u64>>,
}

impl Grants {
    /// The Free plan: what the desktop uses without a valid signed document. Kept equal to the
    /// public catalog's Free plan by the shared vectors (`freeGrants`).
    pub fn free() -> Self {
        Self {
            unrestricted: false,
            features: Vec::new(),
            limits: BTreeMap::from([
                (limits::CONCURRENT_THREADS.to_owned(), Some(2)),
                (limits::KALVOICE_REQUESTS_PER_MONTH.to_owned(), Some(250)),
            ]),
        }
    }

    pub fn has_feature(&self, feature: &str) -> bool {
        evaluate_feature(self.unrestricted, &self.features, feature)
    }

    pub fn limit(&self, limit: &str) -> Limit {
        evaluate_limit(self.unrestricted, &self.limits, limit)
    }
}

/// Feature ids gated by plan today (`FEATURES` in the protocol package).
pub mod features {
    pub const PERSISTENT_AGENTS: &str = "persistentAgents";
    pub const MULTI_AGENT_WORKFLOWS: &str = "multiAgentWorkflows";
    pub const SCHEDULED_AUTOMATIONS: &str = "scheduledAutomations";
    pub const EVENT_AUTOMATIONS: &str = "eventAutomations";
    pub const ADVANCED_MISSIONS: &str = "advancedMissions";
}

/// Limit ids gated by plan today (`LIMITS` in the protocol package).
pub mod limits {
    pub const CONCURRENT_THREADS: &str = "concurrentThreads";
    /// Top-level KalVoice assistant requests per monthly cycle (never provider tokens).
    pub const KALVOICE_REQUESTS_PER_MONTH: &str = "kalvoiceRequestsPerMonth";
}

fn evaluate_feature(unrestricted: bool, features: &[String], feature: &str) -> bool {
    unrestricted || features.iter().any(|granted| granted == feature)
}

fn evaluate_limit(
    unrestricted: bool,
    limits: &BTreeMap<String, Option<u64>>,
    limit: &str,
) -> Limit {
    if unrestricted {
        return Limit::Unlimited;
    }
    match limits.get(limit) {
        None => Limit::AtMost(0),
        Some(None) => Limit::Unlimited,
        Some(Some(value)) => Limit::AtMost(*value),
    }
}

/// A verified entitlement document's payload. Times are Unix epoch seconds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entitlement {
    pub version: u32,
    pub account_id: String,
    pub tier: Tier,
    pub unrestricted: bool,
    pub features: Vec<String>,
    pub limits: BTreeMap<String, Option<u64>>,
    pub issued_at: i64,
    pub expires_at: i64,
    pub key_id: String,
}

impl Entitlement {
    pub fn has_feature(&self, feature: &str) -> bool {
        evaluate_feature(self.unrestricted, &self.features, feature)
    }

    pub fn limit(&self, limit: &str) -> Limit {
        evaluate_limit(self.unrestricted, &self.limits, limit)
    }

    pub fn grants(&self) -> Grants {
        Grants {
            unrestricted: self.unrestricted,
            features: self.features.clone(),
            limits: self.limits.clone(),
        }
    }

    /// Structural checks, identical to `parseEntitlement` in the protocol package. Unknown JSON
    /// fields are ignored during deserialization so newer servers stay compatible.
    pub(crate) fn validate(&self) -> bool {
        let id_ok = |value: &str| {
            let length = value.encode_utf16().count();
            length > 0 && length <= MAX_ID_LENGTH
        };
        let time_ok = |value: i64| u64::try_from(value).is_ok_and(|v| v <= MAX_SAFE_INTEGER);
        self.version == DOCUMENT_VERSION
            && id_ok(&self.account_id)
            && self.unrestricted == (self.tier == Tier::Owner)
            && self.features.len() <= MAX_ITEMS
            && self.features.iter().all(|feature| id_ok(feature))
            && self.limits.len() <= MAX_ITEMS
            && self
                .limits
                .iter()
                .all(|(name, value)| id_ok(name) && value.is_none_or(|v| v <= MAX_SAFE_INTEGER))
            && time_ok(self.issued_at)
            && time_ok(self.expires_at)
            && self.expires_at > self.issued_at
            && self.expires_at - self.issued_at <= MAX_DOCUMENT_LIFETIME_SECONDS
            && is_valid_key_id(&self.key_id)
    }
}

/// 1–64 of `[a-z0-9._-]`, starting with a letter or digit.
pub fn is_valid_key_id(key_id: &str) -> bool {
    let bytes = key_id.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(b))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document(tier: Tier) -> Entitlement {
        let owner = tier == Tier::Owner;
        Entitlement {
            version: 1,
            account_id: "acct".into(),
            tier,
            unrestricted: owner,
            features: if owner {
                vec![]
            } else {
                vec![features::PERSISTENT_AGENTS.into()]
            },
            limits: if owner {
                BTreeMap::new()
            } else {
                BTreeMap::from([(limits::CONCURRENT_THREADS.into(), Some(8))])
            },
            issued_at: 1_790_000_000,
            expires_at: 1_790_000_000 + 7 * 24 * 3600,
            key_id: "k1".into(),
        }
    }

    #[test]
    fn owner_is_unrestricted_by_construction() {
        let owner = document(Tier::Owner);
        assert!(owner.validate());
        for feature in [
            features::PERSISTENT_AGENTS,
            features::MULTI_AGENT_WORKFLOWS,
            features::SCHEDULED_AUTOMATIONS,
            features::EVENT_AUTOMATIONS,
            features::ADVANCED_MISSIONS,
            "featureAddedInTheFuture",
        ] {
            assert!(owner.has_feature(feature), "{feature}");
        }
        assert_eq!(owner.limit(limits::CONCURRENT_THREADS), Limit::Unlimited);
        assert_eq!(owner.limit("limitAddedInTheFuture"), Limit::Unlimited);
        // Lists cannot restrict an unrestricted grant.
        let hostile = Grants {
            unrestricted: true,
            features: vec![],
            limits: BTreeMap::from([(limits::CONCURRENT_THREADS.into(), Some(0))]),
        };
        assert_eq!(hostile.limit(limits::CONCURRENT_THREADS), Limit::Unlimited);
    }

    #[test]
    fn restricted_tiers_fail_closed() {
        let pro = document(Tier::Pro);
        assert!(pro.validate());
        assert!(pro.has_feature(features::PERSISTENT_AGENTS));
        assert!(!pro.has_feature(features::ADVANCED_MISSIONS));
        assert!(!pro.has_feature("featureAddedInTheFuture"));
        assert_eq!(pro.limit(limits::CONCURRENT_THREADS), Limit::AtMost(8));
        assert_eq!(pro.limit("limitAddedInTheFuture"), Limit::AtMost(0));
        let open = Grants {
            unrestricted: false,
            features: vec![],
            limits: BTreeMap::from([(limits::CONCURRENT_THREADS.into(), None)]),
        };
        assert_eq!(open.limit(limits::CONCURRENT_THREADS), Limit::Unlimited);
    }

    #[test]
    fn free_fallback_matches_the_catalog() {
        let free = Grants::free();
        assert!(!free.unrestricted);
        assert!(!free.has_feature(features::PERSISTENT_AGENTS));
        assert_eq!(free.limit(limits::CONCURRENT_THREADS), Limit::AtMost(2));
        assert_eq!(
            free.limit(limits::KALVOICE_REQUESTS_PER_MONTH),
            Limit::AtMost(250)
        );
    }

    #[test]
    fn validation_rejects_inconsistent_documents() {
        let mut liar = document(Tier::Pro);
        liar.unrestricted = true;
        assert!(!liar.validate());
        let mut restricted_owner = document(Tier::Owner);
        restricted_owner.unrestricted = false;
        assert!(!restricted_owner.validate());
        let mut long = document(Tier::Owner);
        long.expires_at = long.issued_at + MAX_DOCUMENT_LIFETIME_SECONDS + 1;
        assert!(!long.validate());
        let mut backwards = document(Tier::Owner);
        backwards.expires_at = backwards.issued_at;
        assert!(!backwards.validate());
        let mut version = document(Tier::Owner);
        version.version = 2;
        assert!(!version.validate());
        let mut kid = document(Tier::Owner);
        kid.key_id = "../etc".into();
        assert!(!kid.validate());
        let mut negative = document(Tier::Owner);
        negative.issued_at = -1;
        assert!(!negative.validate());
    }

    #[test]
    fn key_ids() {
        assert!(is_valid_key_id("k2026-10"));
        assert!(is_valid_key_id("test-vectors.1_a"));
        assert!(!is_valid_key_id(""));
        assert!(!is_valid_key_id("-k"));
        assert!(!is_valid_key_id("K1"));
        assert!(!is_valid_key_id(&"a".repeat(65)));
    }
}
