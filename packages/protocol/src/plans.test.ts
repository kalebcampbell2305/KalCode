import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSION_MODES,
  CORE_LIMITS,
  formatCoreLimit,
  formatInterval,
  formatKalVoiceAllowance,
  formatPrice,
  getPlan,
  getPlanFeature,
  limitsFor,
  OWNER_LIMITS,
  PLAN_FEATURE_GROUPS,
  PLAN_FEATURES,
  PLANS,
  planIncludes,
  priceFor,
  yearlySavingsUsd,
} from "./plans.ts";

describe("plans", () => {
  it("publicly lists exactly Free, Pro, MAX and MAX 2X in ascending price order (never OWNER)", () => {
    expect(PLANS.map((plan) => plan.id)).toEqual(["free", "pro", "max", "max2x"]);
    expect(PLANS.map((plan) => plan.name)).toEqual(["Free", "Pro", "MAX", "MAX 2X"]);
    expect(JSON.stringify(PLANS).toLowerCase()).not.toContain("owner");
  });

  it("uses the owner's canonical monthly and yearly prices", () => {
    expect(PLANS.map((plan) => [plan.id, plan.price.monthlyUsd, plan.price.yearlyUsd])).toEqual([
      ["free", 0, 0],
      ["pro", 10, 100],
      ["max", 25, 250],
      ["max2x", 50, 500],
    ]);
    expect(PLANS.map(yearlySavingsUsd)).toEqual([0, 20, 50, 100]);
    expect(priceFor(getPlan("max"), "year")).toBe(250);
  });

  it("formats whole-dollar prices per month or year", () => {
    expect(formatPrice(getPlan("pro"))).toBe("$10");
    expect(formatPrice(getPlan("max2x"), "year")).toBe("$500");
    expect(formatInterval()).toBe("/month");
    expect(formatInterval("year")).toBe("/year");
  });

  it("positions the plans TRY → BUILD → ORCHESTRATE → AUTOMATE with MAX as the one most popular plan", () => {
    expect(PLANS.map((plan) => [plan.stage, plan.tagline])).toEqual([
      ["TRY", "Try KalCode."],
      ["BUILD", "Your everyday AI engineering workspace."],
      ["ORCHESTRATE", "Run serious multi-agent engineering workflows."],
      ["AUTOMATE", "Maximum KalCode. Maximum autonomy."],
    ]);
    expect(PLANS.filter((plan) => plan.popular).map((plan) => plan.id)).toEqual(["max"]);
  });

  it("uses the owner's canonical core limits", () => {
    const table = PLANS.map((plan) => [
      plan.id,
      plan.limits.kalvoiceRequestsPerMonth,
      plan.limits.openTerminals,
      plan.limits.parallelAgents,
      plan.limits.workspaces,
      plan.limits.providerAccounts,
    ]);
    expect(table).toEqual([
      ["free", 25, null, null, 2, 2],
      ["pro", 150, null, null, 10, 6],
      ["max", 500, null, null, null, 12],
      ["max2x", 1000, null, null, null, null],
    ]);
    expect(formatKalVoiceAllowance(limitsFor("max2x"))).toBe("1,000");
  });

  it("shows Free the recent 10 Runs and every paid plan the full Run history", () => {
    expect(PLANS.map((plan) => [plan.id, plan.limits.runHistory])).toEqual([
      ["free", 10],
      ["pro", null],
      ["max", null],
      ["max2x", null],
    ]);
    expect(getPlanFeature("operations-history").values).toEqual({
      free: "Recent 10",
      pro: "30 days",
      max: "1 year",
      max2x: "Maximum",
    });
    expect(
      PLANS.map((plan) => [
        plan.limits.brainstormsPerMonth,
        plan.limits.launchRecipes,
        plan.limits.externalIntegrations,
        plan.limits.operationsHistoryDays,
        plan.limits.queuedTasks,
      ]),
    ).toEqual([
      [3, 1, 1, null, 3],
      [null, 10, 5, 30, null],
      [null, null, 25, 365, null],
      [null, null, null, null, null],
    ]);
  });

  it("keeps local agents, terminals, Fleet, basic memory and recipes accessible on Free", () => {
    for (const plan of PLANS) {
      expect(plan.limits.openTerminals).toBeNull();
      expect(plan.limits.parallelAgents).toBeNull();
    }
    for (const id of ["agent-fleet", "unified-memory", "launch-recipes", "terminal-smart"]) {
      expect(planIncludes("free", getPlanFeature(id))).toBe(true);
    }
    expect(PLANS.map((plan) => plan.limits.remote)).toEqual(["none", "none", "standard", "full"]);
    expect(PLANS.map((plan) => plan.limits.autonomy)).toEqual(["manual", "manual", "manual", "maximum"]);
  });

  it("gives OWNER no KalCode-side limit", () => {
    for (const limit of CORE_LIMITS) {
      expect(OWNER_LIMITS[limit.key]).toBeNull();
    }
    expect(OWNER_LIMITS.runHistory).toBeNull();
    expect(formatKalVoiceAllowance(OWNER_LIMITS)).toBe("Unlimited");
  });

  it("formats the plan-card limit lines", () => {
    expect(CORE_LIMITS.map((limit) => formatCoreLimit(getPlan("free").limits, limit))).toEqual([
      "Unlimited local agents",
      "Unlimited local terminals",
      "2 workspaces",
      "2 accounts",
      "25 KalVoice",
    ]);
    expect(CORE_LIMITS.map((limit) => formatCoreLimit(getPlan("max2x").limits, limit))).toEqual([
      "Unlimited local agents",
      "Unlimited local terminals",
      "Unlimited workspaces",
      "Unlimited accounts",
      "1,000 KalVoice",
    ]);
  });

  it("never paywalls dictation or any permission mode", () => {
    for (const tier of ["free", "pro", "max", "max2x", "owner"] as const) {
      const limits = limitsFor(tier);
      expect(limits.kalvoiceDictation).toBe("unlimited");
      expect([...limits.permissionModes]).toEqual(["plan", "approve", "auto", "bypass", "custom"]);
    }
    expect(ALL_PERMISSION_MODES).toHaveLength(5);
  });

  it("never describes model tokens as KalVoice usage", () => {
    expect(JSON.stringify(PLANS).toLowerCase()).not.toMatch(/\btokens?\b/);
    expect(JSON.stringify(PLAN_FEATURE_GROUPS).toLowerCase()).not.toMatch(/\btokens?\b/);
  });

  it("rejects unknown plan ids", () => {
    // @ts-expect-error — deliberately invalid id
    expect(() => getPlan("enterprise")).toThrow(/Unknown plan/);
  });
});

describe("plan roadmap", () => {
  it("has unique feature ids and every card feature exists", () => {
    const ids = PLAN_FEATURES.map((feature) => feature.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const plan of PLANS) {
      for (const id of plan.cardFeatures) {
        expect(() => getPlanFeature(id), `${plan.id} card: ${id}`).not.toThrow();
        expect(planIncludes(plan.id, getPlanFeature(id)), `${plan.id} card: ${id}`).toBe(true);
      }
    }
  });

  it("marks a feature available only with the production build it was verified in", () => {
    for (const feature of PLAN_FEATURES) {
      if (feature.status === "available") {
        expect(feature.verifiedIn, feature.id).toMatch(/^\d+\.\d+\.\d+\+\d+$/);
      } else {
        expect(feature.verifiedIn, feature.id).toBeUndefined();
      }
    }
  });

  it("gives per-plan wording only to plans that include the feature", () => {
    for (const feature of PLAN_FEATURES) {
      for (const plan of Object.keys(feature.values ?? {}) as (keyof NonNullable<typeof feature.values>)[]) {
        expect(planIncludes(plan, feature), `${feature.id} → ${plan}`).toBe(true);
      }
    }
  });

  it("keeps the owner's plan assignments for the signature features", () => {
    const from = (id: string) => getPlanFeature(id).from;
    expect(
      ["core-code", "core-threads", "core-browser", "kaltidy", "account-hub", "needs-you", "operations"].map(from),
    ).toEqual(Array(7).fill("free"));
    expect(["browser-studio", "operations-full", "adaptive-canvas", "mission-control"].map(from)).toEqual(
      Array(4).fill("pro"),
    );
    expect(
      ["squads", "handoff-chains", "agent-files", "stuck-agents", "unified-orchestration", "deploy", "remote"].map(
        from,
      ),
    ).toEqual(Array(7).fill("max"));
    expect(["keep-working", "auto-routing", "kalvoice-live", "cloud-capacity"].map(from)).toEqual(
      Array(4).fill("max2x"),
    );
    expect(planIncludes("pro", getPlanFeature("squads"))).toBe(false);
    expect(planIncludes("max2x", getPlanFeature("squads"))).toBe(true);
  });
});
