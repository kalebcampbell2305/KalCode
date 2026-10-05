//! Plan limits KalCode enforces natively.
//!
//! `packages/protocol/src/plans.ts` is the single source of truth for plans and their limits.
//! Native code cannot import it, so this is its one Rust mirror; a test reads `plans.ts` and fails
//! on drift. Every native limit check (terminals, agents, workspaces, provider accounts, KalVoice
//! Requests, queued Operations tasks) reads this table, never the signed entitlement document:
//! documents issued before a limit existed do not carry it and would fail closed to zero.

use crate::error::KalError;

/// An entitlement tier. Without an active verified plan the desktop uses [`PlanTier::Free`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PlanTier {
    #[default]
    Free,
    Pro,
    Max,
    Max2x,
    /// Private, non-billable tier: no KalCode-side limits.
    Owner,
}

/// A plan's numeric limits. `None` means KalCode imposes no limit of its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlanLimits {
    pub kalvoice_requests_per_month: Option<u32>,
    /// Terminals open at the same time across all of KalCode (shells, agents and Operations).
    pub open_terminals: Option<u32>,
    /// Coding agents running at the same time.
    pub parallel_agents: Option<u32>,
    pub workspaces: Option<u32>,
    /// Connected provider accounts across every provider.
    pub provider_accounts: Option<u32>,
    /// Waiting Operations tasks (the `operations-queue` roadmap row: Free "Up to 3").
    pub queued_tasks: Option<u32>,
    pub brainstorms_per_month: Option<u32>,
    pub launch_recipes: Option<u32>,
    pub external_integrations: Option<u32>,
    pub operations_history_days: Option<u32>,
    pub run_history: Option<u32>,
}

const UNLIMITED: PlanLimits = PlanLimits {
    kalvoice_requests_per_month: None,
    open_terminals: None,
    parallel_agents: None,
    workspaces: None,
    provider_accounts: None,
    queued_tasks: None,
    brainstorms_per_month: None,
    launch_recipes: None,
    external_integrations: None,
    operations_history_days: None,
    run_history: None,
};

/// The public plans in upgrade order.
pub const PUBLIC_PLANS: [PlanTier; 4] = [
    PlanTier::Free,
    PlanTier::Pro,
    PlanTier::Max,
    PlanTier::Max2x,
];

impl PlanTier {
    /// The plan's display name, exactly as the catalog spells it.
    pub const fn name(self) -> &'static str {
        match self {
            Self::Free => "Free",
            Self::Pro => "Pro",
            Self::Max => "MAX",
            Self::Max2x => "MAX 2X",
            Self::Owner => "Owner",
        }
    }

    pub const fn limits(self) -> PlanLimits {
        match self {
            Self::Free => PlanLimits {
                kalvoice_requests_per_month: Some(25),
                open_terminals: None,
                parallel_agents: None,
                workspaces: Some(2),
                provider_accounts: Some(2),
                queued_tasks: Some(3),
                brainstorms_per_month: Some(3),
                launch_recipes: Some(1),
                external_integrations: Some(1),
                run_history: Some(10),
                ..UNLIMITED
            },
            Self::Pro => PlanLimits {
                kalvoice_requests_per_month: Some(150),
                open_terminals: None,
                parallel_agents: None,
                workspaces: Some(10),
                provider_accounts: Some(6),
                launch_recipes: Some(10),
                external_integrations: Some(5),
                operations_history_days: Some(30),
                ..UNLIMITED
            },
            Self::Max => PlanLimits {
                kalvoice_requests_per_month: Some(500),
                open_terminals: None,
                parallel_agents: None,
                workspaces: None,
                provider_accounts: Some(12),
                external_integrations: Some(25),
                operations_history_days: Some(365),
                ..UNLIMITED
            },
            Self::Max2x => PlanLimits {
                kalvoice_requests_per_month: Some(1_000),
                ..UNLIMITED
            },
            Self::Owner => UNLIMITED,
        }
    }

    /// The cap this plan puts on `kind`, or `None` when KalCode imposes none.
    pub fn limit(self, kind: Limited) -> Option<PlanLimit> {
        kind.of(self.limits()).map(|max| PlanLimit {
            tier: self,
            kind,
            max,
        })
    }

    /// The first higher public plan that raises `kind`, with its cap (`None` = unlimited).
    fn upgrade_for(self, kind: Limited) -> Option<(PlanTier, Option<u32>)> {
        let current = kind.of(self.limits());
        let index = PUBLIC_PLANS.iter().position(|tier| *tier == self)?;
        PUBLIC_PLANS[index + 1..]
            .iter()
            .map(|tier| (*tier, kind.of(tier.limits())))
            .find(|(_, cap)| *cap != current)
    }
}

/// A limit KalCode enforces when something new is created. Existing items are never closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Limited {
    OpenTerminals,
    ParallelAgents,
    Workspaces,
    ProviderAccounts,
    QueuedTasks,
    BrainstormsPerMonth,
    LaunchRecipes,
    ExternalIntegrations,
}

impl Limited {
    fn of(self, limits: PlanLimits) -> Option<u32> {
        match self {
            Self::OpenTerminals => limits.open_terminals,
            Self::ParallelAgents => limits.parallel_agents,
            Self::Workspaces => limits.workspaces,
            Self::ProviderAccounts => limits.provider_accounts,
            Self::QueuedTasks => limits.queued_tasks,
            Self::BrainstormsPerMonth => limits.brainstorms_per_month,
            Self::LaunchRecipes => limits.launch_recipes,
            Self::ExternalIntegrations => limits.external_integrations,
        }
    }

    /// The stable `validation/*` code of a refusal.
    pub const fn code(self) -> &'static str {
        match self {
            Self::OpenTerminals => "too_many_terminals",
            Self::ParallelAgents => "too_many_agents",
            Self::Workspaces => "too_many_workspaces",
            Self::ProviderAccounts => "too_many_provider_accounts",
            Self::QueuedTasks => "too_many_queued_tasks",
            Self::BrainstormsPerMonth => "too_many_brainstorms",
            Self::LaunchRecipes => "too_many_launch_recipes",
            Self::ExternalIntegrations => "too_many_external_integrations",
        }
    }

    /// (singular, plural, what frees a slot).
    const fn copy(self) -> (&'static str, &'static str, &'static str) {
        match self {
            Self::OpenTerminals => (
                "open terminal",
                "open terminals",
                "Close one to open another",
            ),
            Self::ParallelAgents => (
                "coding agent at a time",
                "coding agents at a time",
                "Stop an agent to start another",
            ),
            Self::Workspaces => ("workspace", "workspaces", "Remove one to add another"),
            Self::ProviderAccounts => (
                "connected provider account",
                "connected provider accounts",
                "Remove one to connect another",
            ),
            Self::BrainstormsPerMonth => (
                "Brainstorm this month",
                "Brainstorms this month",
                "Wait for the monthly reset",
            ),
            Self::LaunchRecipes => (
                "Launch Recipe",
                "Launch Recipes",
                "Remove one to save another",
            ),
            Self::ExternalIntegrations => (
                "external integration",
                "external integrations",
                "Disconnect one to connect another",
            ),
            Self::QueuedTasks => (
                "queued task",
                "queued tasks",
                "Run or remove one to queue another",
            ),
        }
    }
}

/// One plan's cap on one [`Limited`] kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlanLimit {
    pub tier: PlanTier,
    pub kind: Limited,
    pub max: u32,
}

impl PlanLimit {
    /// Refuses creating one more item when `current` items already exist.
    pub fn admit(&self, current: i64) -> Result<(), KalError> {
        // Legacy callers and cached documents cannot restore obsolete local session caps.
        if matches!(self.kind, Limited::OpenTerminals | Limited::ParallelAgents) {
            return Ok(());
        }
        if current >= i64::from(self.max) {
            Err(self.refusal())
        } else {
            Ok(())
        }
    }

    /// The user-facing refusal: what the plan allows, how to free a slot, and the next plan's
    /// capacity, for example the workspace or provider-account allowance.
    pub fn refusal(&self) -> KalError {
        let (one, many, free_one) = self.kind.copy();
        let noun = if self.max == 1 { one } else { many };
        let upgrade = match self.tier.upgrade_for(self.kind) {
            Some((next, Some(cap))) => format!(", or upgrade to {} for {cap}", next.name()),
            Some((next, None)) => format!(", or upgrade to {} for unlimited", next.name()),
            None => String::new(),
        };
        KalError::validation(
            self.kind.code(),
            format!(
                "The {} plan allows {} {noun}. {free_one}{upgrade}.",
                self.tier.name(),
                self.max
            ),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [PlanTier; 5] = [
        PlanTier::Free,
        PlanTier::Pro,
        PlanTier::Max,
        PlanTier::Max2x,
        PlanTier::Owner,
    ];

    fn plans_ts() -> String {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/protocol/src/plans.ts"
        );
        std::fs::read_to_string(path).expect("plans.ts")
    }

    /// `key:` values in declaration order (free, pro, max, max2x, then OWNER_LIMITS). The
    /// interface declaration (`number | null;`) is skipped.
    fn catalog_values(source: &str, key: &str) -> Vec<Option<u32>> {
        let prefix = format!("{key}:");
        source
            .lines()
            .filter_map(|line| {
                let value = line
                    .trim()
                    .strip_prefix(&prefix)?
                    .trim()
                    .trim_end_matches(',');
                if value == "null" {
                    Some(None)
                } else {
                    value.replace('_', "").parse::<u32>().ok().map(Some)
                }
            })
            .collect()
    }

    #[test]
    fn limits_match_the_plan_catalog() {
        let source = plans_ts();
        let mirror = |kind: fn(PlanLimits) -> Option<u32>| {
            ALL.iter()
                .map(|tier| kind(tier.limits()))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            catalog_values(&source, "kalvoiceRequestsPerMonth"),
            mirror(|l| l.kalvoice_requests_per_month)
        );
        assert_eq!(
            catalog_values(&source, "openTerminals"),
            mirror(|l| l.open_terminals)
        );
        assert_eq!(
            catalog_values(&source, "parallelAgents"),
            mirror(|l| l.parallel_agents)
        );
        assert_eq!(
            catalog_values(&source, "workspaces"),
            mirror(|l| l.workspaces)
        );
        assert_eq!(
            catalog_values(&source, "providerAccounts"),
            mirror(|l| l.provider_accounts)
        );
        for (key, field) in [
            (
                "queuedTasks",
                (|l: PlanLimits| l.queued_tasks) as fn(PlanLimits) -> Option<u32>,
            ),
            ("brainstormsPerMonth", |l: PlanLimits| {
                l.brainstorms_per_month
            }),
            ("launchRecipes", |l: PlanLimits| l.launch_recipes),
            ("externalIntegrations", |l: PlanLimits| {
                l.external_integrations
            }),
            ("operationsHistoryDays", |l: PlanLimits| {
                l.operations_history_days
            }),
            ("runHistory", |l: PlanLimits| l.run_history),
        ] {
            assert_eq!(catalog_values(&source, key), mirror(field), "{key}");
        }
    }

    #[test]
    fn all_tiers_ignore_even_legacy_local_session_caps() {
        for tier in ALL {
            for kind in [Limited::OpenTerminals, Limited::ParallelAgents] {
                assert_eq!(tier.limit(kind), None);
                assert!(PlanLimit { tier, kind, max: 0 }.admit(i64::MAX).is_ok());
            }
        }
    }

    #[test]
    fn names_and_queue_caps_match_the_plan_catalog() {
        let source = plans_ts();
        let names: Vec<&str> = source
            .lines()
            .filter_map(|line| line.trim().strip_prefix("name: \"")?.strip_suffix("\","))
            .take(PUBLIC_PLANS.len())
            .collect();
        assert_eq!(names, PUBLIC_PLANS.map(PlanTier::name));

        // The Queued tasks row is generated from each plan's limits (`quotaValues`), so compare those
        // limits, in catalog order, with the native ones.
        let row = &source[source
            .find("id: \"operations-queue\"")
            .expect("operations-queue row")..];
        assert!(
            row.lines()
                .find(|line| line.contains("values:"))
                .is_some_and(|line| line.contains("quotaValues(\"queuedTasks\")")),
            "the Queued tasks row must be generated from plan limits"
        );
        let catalog: Vec<Option<u32>> = source
            .lines()
            .filter_map(|line| {
                let value = line
                    .trim()
                    .strip_prefix("queuedTasks: ")?
                    .strip_suffix(',')?;
                Some(if value == "null" {
                    None
                } else {
                    Some(value.parse().expect("queuedTasks is a count or null"))
                })
            })
            .take(PUBLIC_PLANS.len())
            .collect();
        assert_eq!(catalog, PUBLIC_PLANS.map(|tier| tier.limits().queued_tasks));
        assert_eq!(PlanTier::Owner.limits().queued_tasks, None);
    }

    #[test]
    fn refusals_name_the_plan_and_the_next_capacity() {
        let message = |tier: PlanTier, kind| tier.limit(kind).expect("capped").refusal().message;
        assert_eq!(
            message(PlanTier::Free, Limited::Workspaces),
            "The Free plan allows 2 workspaces. Remove one to add another, or upgrade to Pro for 10."
        );
        assert_eq!(
            message(PlanTier::Free, Limited::ProviderAccounts),
            "The Free plan allows 2 connected provider accounts. Remove one to connect another, or upgrade to Pro for 6."
        );
        assert_eq!(
            message(PlanTier::Free, Limited::QueuedTasks),
            "The Free plan allows 3 queued tasks. Run or remove one to queue another, or upgrade to Pro for unlimited."
        );
        assert_eq!(
            message(PlanTier::Pro, Limited::Workspaces),
            "The Pro plan allows 10 workspaces. Remove one to add another, or upgrade to MAX for unlimited."
        );
        let refusal = PlanTier::Max
            .limit(Limited::ProviderAccounts)
            .expect("capped")
            .refusal();
        assert_eq!(refusal.code, "too_many_provider_accounts");
        assert_eq!(refusal.category, crate::ErrorCategory::Validation);
    }

    #[test]
    fn admit_refuses_only_at_the_cap() {
        let limit = PlanTier::Free.limit(Limited::Workspaces).expect("capped");
        assert!(limit.admit(1).is_ok());
        assert_eq!(limit.admit(2).unwrap_err().code, "too_many_workspaces");
        assert!(limit.admit(9).is_err());
        for kind in [
            Limited::OpenTerminals,
            Limited::ParallelAgents,
            Limited::Workspaces,
            Limited::ProviderAccounts,
            Limited::QueuedTasks,
        ] {
            assert_eq!(PlanTier::Max2x.limit(kind), None, "{kind:?}");
            assert_eq!(PlanTier::Owner.limit(kind), None, "{kind:?}");
        }
        assert_eq!(PlanTier::Max.limit(Limited::Workspaces), None);
        assert_eq!(PlanTier::default(), PlanTier::Free);
    }
}
