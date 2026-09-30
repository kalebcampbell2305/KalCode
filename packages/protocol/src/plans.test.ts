import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSION_MODES,
  formatInterval,
  formatKalVoiceAllowance,
  formatPrice,
  getPlan,
  limitsFor,
  OWNER_LIMITS,
  PLANS,
} from "./plans.ts";

describe("plans", () => {
  it("publicly lists exactly Free, Pro, MAX and MAX 2X in ascending price order (never OWNER)", () => {
    expect(PLANS.map((plan) => plan.id)).toEqual(["free", "pro", "max", "max2x"]);
    expect(PLANS.map((plan) => plan.name)).toEqual(["Free", "Pro", "MAX", "MAX 2X"]);
    expect(JSON.stringify(PLANS).toLowerCase()).not.toContain("owner");
  });

  it("uses the launch prices", () => {
    expect(getPlan("free").price).toEqual({ amountUsd: 0, interval: "month" });
    expect(getPlan("pro").price).toEqual({ amountUsd: 10, interval: "month" });
    expect(getPlan("max").price).toEqual({ amountUsd: 25, interval: "month" });
    expect(getPlan("max2x").price).toEqual({ amountUsd: 50, interval: "month" });
  });

  it("formats prices as whole dollars per month", () => {
    expect(formatPrice(getPlan("pro").price)).toBe("$10");
    expect(formatInterval(getPlan("max").price)).toBe("/month");
  });

  it("gives Free 75, Pro 1,500, MAX 5,000, MAX 2X 10,000 KalVoice Requests and OWNER unlimited", () => {
    expect(limitsFor("free").kalvoiceRequestsPerMonth).toBe(75);
    expect(limitsFor("pro").kalvoiceRequestsPerMonth).toBe(1500);
    expect(limitsFor("max").kalvoiceRequestsPerMonth).toBe(5000);
    expect(limitsFor("max2x").kalvoiceRequestsPerMonth).toBe(10000);
    expect(limitsFor("owner").kalvoiceRequestsPerMonth).toBeNull();
    expect(formatKalVoiceAllowance(limitsFor("pro"))).toBe("1,500");
    expect(formatKalVoiceAllowance(OWNER_LIMITS)).toBe("Unlimited");
  });

  it("never paywalls dictation, provider connections or any permission mode", () => {
    for (const tier of ["free", "pro", "max", "max2x", "owner"] as const) {
      const limits = limitsFor(tier);
      expect(limits.kalvoiceDictation).toBe("unlimited");
      expect(limits.providerConnections).toBe("unlimited");
      expect([...limits.permissionModes]).toEqual(["plan", "approve", "auto", "bypass", "custom"]);
    }
    expect(ALL_PERMISSION_MODES).toHaveLength(5);
  });

  it("increases concurrency through MAX; MAX 2X keeps MAX capacity and OWNER is unrestricted", () => {
    const [free, pro, max, max2x] = PLANS.map((plan) => plan.limits.concurrentThreads ?? Number.POSITIVE_INFINITY);
    expect(free).toBeLessThan(pro ?? 0);
    expect(pro).toBeLessThan(max ?? 0);
    expect(max2x).toBe(max);
    expect(OWNER_LIMITS.concurrentThreads).toBeNull();
    expect(OWNER_LIMITS.advancedMissions).toBe(true);
  });

  it("caps terminals per workspace on Free and Pro only; MAX, MAX 2X and OWNER are uncapped", () => {
    expect(PLANS.map((plan) => [plan.id, plan.limits.terminalsPerWorkspace])).toEqual([
      ["free", 12],
      ["pro", 12],
      ["max", null],
      ["max2x", null],
    ]);
    expect(OWNER_LIMITS.terminalsPerWorkspace).toBeNull();
  });

  it("never describes model tokens as KalVoice usage", () => {
    expect(JSON.stringify(PLANS).toLowerCase()).not.toMatch(/\btokens?\b/);
  });

  it("rejects unknown plan ids", () => {
    // @ts-expect-error — deliberately invalid id
    expect(() => getPlan("enterprise")).toThrow(/Unknown plan/);
  });
});
