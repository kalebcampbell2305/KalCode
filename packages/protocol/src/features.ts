/**
 * Plan placement of KalCode features — the single source of truth (ADVANCED.md §14a decision 1).
 *
 * `FeatureId` and `FeaturePlacement` are generated from Rust (`crates/contracts/src/app.rs`),
 * whose `FeatureId::placement` mirrors this table; a Rust test keeps the two identical, entry for
 * entry and in order. Rules:
 *
 * - `safety` features (Trust Kernel, Context Firewall, host-key verification, Environment Doctor,
 *   safe restore, kill switches) are on every plan and can never move to a paid plan — like
 *   permission modes.
 * - OWNER is unrestricted: it has every feature, current and future, without being enumerated.
 * - Placement is evaluated on the verified, server-signed tier (`crates/entitlements` mirrors
 *   this); it is never a frontend-only check.
 */
import type { FeatureId, FeaturePlacement } from "./generated/index.ts";
import type { EntitlementTier } from "./plans.ts";

export const FEATURE_PLACEMENT = {
  provider_health: "free",
  provider_profiles: "pro",
  context_drop: "free",
  utility_dock: "free",
  resource_governor: "free",
  session_locator: "free",
  process_continuity: "free",
  git_core: "free",
  trust_kernel_explain: "safety",
  agent_organization: "free",
  missions: "max",
  verification: "pro",
  time_machine: "pro",
  remote_workspaces: "max",
  scheduler: "max2x",
  diff_intelligence: "max",
  automations: "max2x",
  memory: "free",
  environment_doctor: "safety",
  blueprints: "free",
  command_center: "max",
  provider_handoff: "max",
  benchmark_lab: "max",
  failure_autopsy: "max",
  workspace_home: "free",
  workspace_rail: "free",
  pane_system: "free",
  provider_panes: "free",
  notification_center: "free",
  account_sign_in: "free",
  context_firewall: "safety",
  host_key_verification: "safety",
  safe_restore: "safety",
  automation_kill_switch: "safety",
} as const satisfies Record<FeatureId, FeaturePlacement>;

export const PRODUCT_FEATURES = Object.keys(FEATURE_PLACEMENT) as FeatureId[];

/** Features that are on every plan and never paywalled. */
export const SAFETY_FEATURES: readonly FeatureId[] = PRODUCT_FEATURES.filter(
  (feature) => FEATURE_PLACEMENT[feature] === "safety",
);

const PLAN_RANK: Record<Exclude<EntitlementTier, "owner">, number> = { free: 0, pro: 1, max: 2, max2x: 3 };

/** Whether `tier` includes `feature`. OWNER is unrestricted; safety and free features are on every plan. */
export function featureIncluded(tier: EntitlementTier, feature: FeatureId): boolean {
  if (tier === "owner") {
    return true;
  }
  const placement: FeaturePlacement = FEATURE_PLACEMENT[feature];
  switch (placement) {
    case "safety":
    case "free":
      return true;
    case "pro":
      return PLAN_RANK[tier] >= 1;
    case "max2x":
      return PLAN_RANK[tier] >= 3;
    case "max":
      return PLAN_RANK[tier] >= 2;
  }
}
