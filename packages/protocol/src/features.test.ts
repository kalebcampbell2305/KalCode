import { describe, expect, it } from "vitest";
import { FEATURE_PLACEMENT, featureIncluded, PRODUCT_FEATURES, SAFETY_FEATURES } from "./features.ts";
import type { FeatureId } from "./generated/index.ts";
import type { EntitlementTier } from "./plans.ts";

/** Every product feature, listed once. `Record` keeps this exhaustive when a feature is added. */
const EVERY_FEATURE: Record<FeatureId, true> = {
  provider_health: true,
  provider_profiles: true,
  context_drop: true,
  utility_dock: true,
  resource_governor: true,
  session_locator: true,
  process_continuity: true,
  git_core: true,
  trust_kernel_explain: true,
  agent_organization: true,
  missions: true,
  verification: true,
  time_machine: true,
  remote_workspaces: true,
  scheduler: true,
  diff_intelligence: true,
  automations: true,
  memory: true,
  environment_doctor: true,
  blueprints: true,
  command_center: true,
  provider_handoff: true,
  benchmark_lab: true,
  failure_autopsy: true,
  workspace_home: true,
  workspace_rail: true,
  pane_system: true,
  provider_panes: true,
  notification_center: true,
  account_sign_in: true,
  context_firewall: true,
  host_key_verification: true,
  safe_restore: true,
  automation_kill_switch: true,
};

const PAID_PLANS: readonly EntitlementTier[] = ["free", "pro", "max"];

const included = (tier: EntitlementTier) => PRODUCT_FEATURES.filter((feature) => featureIncluded(tier, feature));

describe("product features", () => {
  it("lists every feature exactly once", () => {
    expect([...PRODUCT_FEATURES].sort()).toEqual(Object.keys(EVERY_FEATURE).sort());
    expect(new Set(PRODUCT_FEATURES).size).toBe(PRODUCT_FEATURES.length);
    expect(Object.keys(FEATURE_PLACEMENT)).toEqual(PRODUCT_FEATURES);
  });

  it("gives OWNER every feature", () => {
    for (const feature of PRODUCT_FEATURES) expect(featureIncluded("owner", feature)).toBe(true);
  });

  it("puts every safety feature on every plan", () => {
    for (const tier of PAID_PLANS) {
      for (const feature of SAFETY_FEATURES) expect(featureIncluded(tier, feature)).toBe(true);
    }
  });

  it("nests plans: free is within pro, pro is within max, max is within owner", () => {
    const [free, pro, max, owner] = (["free", "pro", "max", "owner"] as const).map((tier) => new Set(included(tier)));
    const within = (small: Set<FeatureId> | undefined, large: Set<FeatureId> | undefined) => {
      for (const feature of small ?? []) expect(large?.has(feature)).toBe(true);
    };
    within(free, pro);
    within(pro, max);
    within(max, owner);
    expect(free?.size).toBeLessThan(pro?.size ?? 0);
    expect(pro?.size).toBeLessThan(max?.size ?? 0);
  });

  it("puts time_machine on Pro but not Free", () => {
    expect(featureIncluded("free", "time_machine")).toBe(false);
    expect(featureIncluded("pro", "time_machine")).toBe(true);
    expect(featureIncluded("max", "time_machine")).toBe(true);
  });

  it("keeps benchmark_lab to MAX and OWNER", () => {
    expect(featureIncluded("free", "benchmark_lab")).toBe(false);
    expect(featureIncluded("pro", "benchmark_lab")).toBe(false);
    expect(featureIncluded("max", "benchmark_lab")).toBe(true);
    expect(featureIncluded("owner", "benchmark_lab")).toBe(true);
  });

  it("names exactly the six safety features", () => {
    expect([...SAFETY_FEATURES].sort()).toEqual(
      [
        "trust_kernel_explain",
        "environment_doctor",
        "context_firewall",
        "host_key_verification",
        "safe_restore",
        "automation_kill_switch",
      ].sort(),
    );
  });
});
