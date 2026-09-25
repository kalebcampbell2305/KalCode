//! Shared vocabulary for context packages and the firewall.
//!
//! Adopted into `crates/contracts::context` in CA-1 with identical wire names (`snake_case`
//! enums, internally tagged data-carrying enums, `camelCase` fields); re-exported here so the
//! crate's paths keep working. `RuleEffect` is exported to TypeScript as `FirewallRuleEffect`.

pub use kalcode_contracts::context::{
    ContextPurpose, FirewallReason, FirewallRule, FirewallVerdict, IgnoreSource, ItemKind,
    ItemOrigin, RuleEffect, Sensitivity,
};
