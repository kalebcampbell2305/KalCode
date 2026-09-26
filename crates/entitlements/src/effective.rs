//! The entitlement the desktop app should apply right now.
//!
//! Offline grace is bounded by the signed document itself: a cached document is honoured until
//! its `expiresAt` (the API issues 7-day documents; verifiers refuse any document claiming more
//! than `MAX_DOCUMENT_LIFETIME_SECONDS` = 14 days). After that — or with no document, a document
//! for another account, or any verification failure — the app falls back to Free until it can
//! fetch a fresh document. This applies to OWNER too: the OWNER *grant* never expires, but the
//! device must re-confirm it with the API at least once per document lifetime, so a revocation
//! takes effect within the grace window.

use time::OffsetDateTime;

use crate::document::{Grants, Tier};
use crate::keys::PRODUCTION_KEYS;
use crate::verify::{Verifier, VerifyError};

/// A signed document cached on the device, with the account the device is signed in as.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedEntitlement {
    pub token: String,
    /// The signed-in account. A document issued to any other account is ignored.
    pub account_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EntitlementStatus {
    /// A valid document signed by a trusted key, for the signed-in account.
    Verified {
        account_id: String,
        key_id: String,
        expires_at: i64,
    },
    /// No cached document (not signed in, or never fetched).
    NoDocument,
    /// A document exists but was rejected; Free applies.
    Rejected(VerifyError),
    /// A valid document for a different account; Free applies.
    WrongAccount,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectiveEntitlement {
    pub tier: Tier,
    pub grants: Grants,
    pub status: EntitlementStatus,
}

impl EffectiveEntitlement {
    fn free(status: EntitlementStatus) -> Self {
        Self {
            tier: Tier::Free,
            grants: Grants::free(),
            status,
        }
    }

    pub fn has_feature(&self, feature: &str) -> bool {
        self.grants.has_feature(feature)
    }

    pub fn limit(&self, limit: &str) -> crate::Limit {
        self.grants.limit(limit)
    }

    /// Plan placement of a product feature on the verified tier (Free without a valid document).
    /// Unrestricted grants include every feature, current and future.
    pub fn includes_feature(&self, feature: kalcode_contracts::app::FeatureId) -> bool {
        self.grants.unrestricted || self.tier.includes(feature)
    }
}

impl Verifier {
    /// The verifier for this build's embedded production public keys (see `keys`).
    pub fn embedded() -> Self {
        match Self::from_trusted(PRODUCTION_KEYS) {
            Ok(verifier) => verifier,
            // Embedded keys are validated by a unit test; a bad entry must never grant anything.
            Err(_) => Self::empty(),
        }
    }

    pub(crate) fn empty() -> Self {
        match Self::from_keys(std::iter::empty()) {
            Ok(verifier) => verifier,
            Err(_) => unreachable!("an empty key set is always valid"),
        }
    }

    /// Resolves what applies now from an optional cached document.
    pub fn effective_entitlement(
        &self,
        cached: Option<&CachedEntitlement>,
        now: OffsetDateTime,
    ) -> EffectiveEntitlement {
        let Some(cached) = cached else {
            return EffectiveEntitlement::free(EntitlementStatus::NoDocument);
        };
        match self.verify(&cached.token, now.unix_timestamp()) {
            Err(error) => EffectiveEntitlement::free(EntitlementStatus::Rejected(error)),
            Ok(entitlement) if entitlement.account_id != cached.account_id => {
                EffectiveEntitlement::free(EntitlementStatus::WrongAccount)
            }
            Ok(entitlement) => EffectiveEntitlement {
                tier: entitlement.tier,
                grants: entitlement.grants(),
                status: EntitlementStatus::Verified {
                    account_id: entitlement.account_id,
                    key_id: entitlement.key_id,
                    expires_at: entitlement.expires_at,
                },
            },
        }
    }
}

/// [`Verifier::effective_entitlement`] with this build's embedded production keys.
pub fn effective_entitlement(
    cached: Option<&CachedEntitlement>,
    now: OffsetDateTime,
) -> EffectiveEntitlement {
    Verifier::embedded().effective_entitlement(cached, now)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_production_keys_are_valid() {
        let verifier = Verifier::from_trusted(PRODUCTION_KEYS).expect("embedded keys must parse");
        assert_eq!(verifier.key_ids().count(), PRODUCTION_KEYS.len());
    }

    #[test]
    fn no_document_means_free() {
        let effective = effective_entitlement(None, OffsetDateTime::now_utc());
        assert_eq!(effective.tier, Tier::Free);
        assert_eq!(effective.status, EntitlementStatus::NoDocument);
        assert_eq!(effective.grants, Grants::free());
    }

    #[test]
    fn owner_is_unrestricted_and_safety_features_are_on_free() {
        use kalcode_contracts::app::{FeatureId, FeaturePlacement};
        for feature in FeatureId::ALL {
            assert!(Tier::Owner.includes(feature), "{feature:?}");
            if feature.placement() == FeaturePlacement::Safety {
                for tier in [Tier::Free, Tier::Pro, Tier::Max, Tier::Max2x] {
                    assert!(tier.includes(feature), "{tier:?} {feature:?}");
                }
            }
            // Plans nest: anything Free has, Pro has; anything Pro has, MAX has.
            if Tier::Free.includes(feature) {
                assert!(Tier::Pro.includes(feature));
            }
            if Tier::Pro.includes(feature) {
                assert!(Tier::Max.includes(feature));
            }
            assert_eq!(Tier::Max.includes(feature), Tier::Max2x.includes(feature));
        }
        assert!(!Tier::Free.includes(FeatureId::TimeMachine));
        assert!(Tier::Pro.includes(FeatureId::TimeMachine));
        assert!(!Tier::Pro.includes(FeatureId::BenchmarkLab));
        assert!(Tier::Max.includes(FeatureId::BenchmarkLab));
        // No document: Free, which still has every safety feature.
        let effective = effective_entitlement(None, OffsetDateTime::now_utc());
        assert!(effective.includes_feature(FeatureId::EnvironmentDoctor));
        assert!(effective.includes_feature(FeatureId::ContextFirewall));
        assert!(!effective.includes_feature(FeatureId::CommandCenter));
    }

    #[test]
    fn garbage_means_free() {
        let cached = CachedEntitlement {
            token: "not-a-token".into(),
            account_id: "a".into(),
        };
        let effective = effective_entitlement(Some(&cached), OffsetDateTime::now_utc());
        assert_eq!(effective.tier, Tier::Free);
        assert_eq!(
            effective.status,
            EntitlementStatus::Rejected(VerifyError::Malformed)
        );
    }
}
