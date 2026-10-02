//! KalVoice Request allowances per entitlement tier.
//!
//! `packages/protocol/src/plans.ts` is the single source of truth for plan limits. The allowance
//! comes from its one Rust mirror, `kalcode_core::plans`; a test here also reads `plans.ts` and
//! fails if the numbers drift.

use kalcode_core::plans::PlanTier;

/// Entitlement tier as far as KalVoice is concerned. Until accounts exist (campaign Z13), every
/// installation is provisionally Free; the server entitlement replaces this.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Tier {
    #[default]
    Free,
    Pro,
    Max,
    Max2x,
    /// Private, non-billable tier with unlimited KalVoice Requests.
    Owner,
}

impl Tier {
    /// Monthly KalVoice Requests; `None` means unlimited.
    pub fn kalvoice_allowance(self) -> Option<u32> {
        let tier = match self {
            Self::Free => PlanTier::Free,
            Self::Pro => PlanTier::Pro,
            Self::Max => PlanTier::Max,
            Self::Max2x => PlanTier::Max2x,
            Self::Owner => PlanTier::Owner,
        };
        tier.limits().kalvoice_requests_per_month
    }
}

/// Where the current allowance comes from. The desktop uses [`ProvisionalEntitlement`] until
/// the entitlement service lands; tests inject any tier.
pub trait EntitlementSource: Send + Sync {
    fn tier(&self) -> Tier;
    /// Day of month the usage cycle starts (1 for the provisional calendar month).
    fn cycle_anchor_day(&self) -> u8 {
        crate::ledger::DEFAULT_CYCLE_ANCHOR_DAY
    }
}

/// Free, calendar-month cycle: the honest default before accounts exist.
#[derive(Debug, Default, Clone, Copy)]
pub struct ProvisionalEntitlement;

impl EntitlementSource for ProvisionalEntitlement {
    fn tier(&self) -> Tier {
        Tier::Free
    }
}

/// A fixed tier (tests, and OWNER builds once the entitlement verifier provides it).
#[derive(Debug, Clone, Copy)]
pub struct FixedEntitlement(pub Tier);

impl EntitlementSource for FixedEntitlement {
    fn tier(&self) -> Tier {
        self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Extracts `kalvoiceRequestsPerMonth` values from plans.ts in declaration order
    /// (free, pro, max, max2x, then OWNER_LIMITS).
    fn plans_ts_allowances() -> Vec<Option<u32>> {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/protocol/src/plans.ts"
        );
        let source = std::fs::read_to_string(path).expect("plans.ts");
        source
            .lines()
            .filter_map(|line| {
                let rest = line.trim().strip_prefix("kalvoiceRequestsPerMonth:")?;
                // Skips the interface declaration (`number | null;`).
                let value = rest.trim().trim_end_matches(',');
                if value == "null" {
                    Some(None)
                } else {
                    value.replace('_', "").parse::<u32>().ok().map(Some)
                }
            })
            .collect()
    }

    #[test]
    fn allowances_are_the_owner_catalog() {
        assert_eq!(
            [Tier::Free, Tier::Pro, Tier::Max, Tier::Max2x, Tier::Owner]
                .map(Tier::kalvoice_allowance),
            [Some(25), Some(150), Some(500), Some(1_000), None]
        );
    }

    #[test]
    fn allowances_match_the_plan_catalog() {
        assert_eq!(
            plans_ts_allowances(),
            vec![
                Tier::Free.kalvoice_allowance(),
                Tier::Pro.kalvoice_allowance(),
                Tier::Max.kalvoice_allowance(),
                Tier::Max2x.kalvoice_allowance(),
                Tier::Owner.kalvoice_allowance(),
            ]
        );
    }

    #[test]
    fn provisional_is_free_on_calendar_months() {
        assert_eq!(ProvisionalEntitlement.tier(), Tier::Free);
        assert_eq!(ProvisionalEntitlement.cycle_anchor_day(), 1);
        assert_eq!(Tier::default().kalvoice_allowance(), Some(25));
    }
}
